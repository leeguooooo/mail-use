// Per-account persistent ImapFlow connection pool. Lives in a long-running
// process (the mail-use daemon). Each account gets up to MAX_CLIENTS_PER_ACCOUNT
// long-lived connections (default 3); concurrent requests on the same
// account run on different clients in parallel instead of serializing
// behind a mutex. Each client sends NOOP every 25 minutes so the server's
// ~30 minute idle disconnect doesn't kick us off, and reconnects
// transparently when the underlying socket dies.

const { createImapClient } = require("./imap_client");

const KEEPALIVE_MS = 25 * 60 * 1000; // 25 minutes
const CONNECT_TIMEOUT_MS = 30 * 1000;
const MAX_CLIENTS_PER_ACCOUNT = Math.max(1, Number(process.env.MAILBOX_POOL_MAX || 3));

// The pool used to only ever grow: one burst of concurrent agent calls would
// take every account to MAX_CLIENTS_PER_ACCOUNT and hold those sockets (plus a
// 25-minute NOOP timer each) for the life of the daemon, long after the burst.
// With several accounts and several agent sessions that is a lot of idle TLS
// state on a laptop for no benefit. Reap connections that have gone quiet, but
// always keep one per account warm — skipping the 1-3s TCP+TLS+LOGIN on the
// next call is the entire reason the daemon exists.
const POOL_IDLE_MS = Math.max(0, Number(process.env.MAILBOX_POOL_IDLE_MS || 10 * 60 * 1000));
const POOL_KEEP_WARM = Math.max(0, Number(process.env.MAILBOX_POOL_KEEP_WARM || 1));
const REAP_SWEEP_MS = 60 * 1000;
// Upper bound on a polite LOGOUT during shutdown/reload. A dead or wedged
// server must not be able to hold the daemon open: past this we drop the
// socket instead of waiting for the server to say goodbye.
const LOGOUT_TIMEOUT_MS = 3 * 1000;

// ImapFlow re-emits socket failures as 'error'; unhandled, one account's
// socket hiccup would take the whole daemon down. The listener goes on before
// connect() so a failure during the handshake is covered too. The entry-level
// listener in _build() does the bookkeeping; this one only guarantees the
// event is never unhandled.
function _buildClient(account) {
  return createImapClient(account, {
    onError: (err) => {
      process.stderr.write(`mail-use: imap connection error for ${account.email}: ${(err && err.message) || err}\n`);
    },
  });
}

// Close a client politely but bounded: LOGOUT if the server answers within
// `ms`, otherwise tear the socket down. Never rejects.
async function _logoutWithTimeout(client, ms = LOGOUT_TIMEOUT_MS) {
  if (!client) return;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  try {
    const r = await Promise.race([
      Promise.resolve().then(() => client.logout()).then(() => "ok", () => "error"),
      timeout,
    ]);
    if (r !== "ok") {
      try { if (typeof client.close === "function") client.close(); } catch { /* ignore */ }
    }
  } finally {
    clearTimeout(timer);
  }
}

// Connection-level failures: the socket is gone, the command never got a
// reply. Only these are worth a retry on a fresh connection.
//
// The message list is what ImapFlow actually raises once a connection has died
// under a command (seen in real daemon logs): "Socket timeout" (ETIMEOUT),
// "Connection not available" (NoConnection), "Already logged out",
// "Unexpected close". Independent of wording, a client that stopped being
// usable while running the command is dead too — that also covers internal
// TypeErrors from a torn-down socket ("Cannot read properties of null").
const CONNECTION_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEOUT", "ETIMEDOUT", "NoConnection", "ClosedAfterConnectTLS", "ClosedAfterConnectText"]);
function _isConnectionError(err, client) {
  if (client && client.usable === false) return true;
  if (err && CONNECTION_ERROR_CODES.has(err.code)) return true;
  const msg = (err && err.message) || "";
  return /usable|EPIPE|ECONNRESET|connection.*closed|not connected|socket.*closed|socket timeout|connection not available|already logged out|unexpected close/i.test(msg);
}

class AccountPool {
  constructor(account, maxSize) {
    this.account = account;
    this.maxSize = maxSize;
    // Each entry: { client, inUse, keepalive, lastUsed }
    this.entries = [];
    // Pending callers: { resolve, reject } — fail-loud if pool is closed
    // or a rebuild fails so the CLI doesn't hang forever.
    this.waiters = [];
    this.closed = false;
    // Connections being built right now. They count against maxSize: the
    // capacity check and the push happen on opposite sides of an `await`, so
    // without this a burst of N concurrent acquires all saw "room" and opened
    // N sockets regardless of maxSize.
    this.pending = 0;
    // Set by ImapPool.reset(): this pool has been detached (config reload).
    // In-flight work finishes on its connection; nothing goes back to idle.
    this.draining = false;
  }

  async acquire() {
    if (this.closed) throw new Error(`pool for ${this.account.email} is closed`);
    // 1. Reuse a free, usable client.
    for (const e of this.entries) {
      if (!e.inUse && e.client && e.client.usable) {
        e.inUse = true;
        e.lastUsed = Date.now();
        return e;
      }
    }
    // 2. Drop dead entries so we don't hit maxSize falsely.
    this.entries = this.entries.filter((e) => e.client && e.client.usable);
    // 3. Build a new client if there's room. Reserve the slot synchronously.
    if (this.entries.length + this.pending < this.maxSize) {
      this.pending += 1;
      let e;
      try {
        e = await this._build();
      } catch (err) {
        this.pending -= 1;
        // The slot we reserved is free again; a waiter queued behind it would
        // otherwise sit there until some unrelated release.
        this._serveWaiter();
        throw err;
      }
      this.pending -= 1;
      if (this.closed) {
        clearInterval(e.keepalive);
        _logoutWithTimeout(e.client);
        throw new Error(`pool for ${this.account.email} is closed`);
      }
      e.inUse = true;
      e.lastUsed = Date.now();
      this.entries.push(e);
      return e;
    }
    // 4. Wait for someone to release.
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  // Hand the first waiter a fresh acquire if there's capacity for it.
  _serveWaiter() {
    if (!this.waiters.length || this.closed) return;
    const live = this.entries.filter((e) => e.client && e.client.usable).length;
    if (live + this.pending >= this.maxSize) return;
    const next = this.waiters.shift();
    this.acquire().then(next.resolve, next.reject);
  }

  // Forget an entry and close its socket (bounded). Safe to call twice.
  _discard(entry) {
    clearInterval(entry.keepalive);
    const c = entry.client;
    entry.client = null;
    const idx = this.entries.indexOf(entry);
    if (idx >= 0) this.entries.splice(idx, 1);
    if (c) _logoutWithTimeout(c);
  }

  release(entry) {
    entry.inUse = false;
    // A connection abandoned by a timed-out caller may still be mid-command;
    // handing it to the next caller would interleave two conversations on
    // one socket. Drop it.
    if (entry.client && entry.client._mailUseAbandoned) this._discard(entry);
    // Detached by reset(): serve whoever already queued here, then close.
    if (this.draining && !this.waiters.length) {
      this._discard(entry);
      return;
    }
    const next = this.waiters.shift();
    if (!next) return;
    // If the just-released client is still alive, hand it off directly.
    if (entry.client && entry.client.usable) {
      entry.inUse = true;
      entry.lastUsed = Date.now();
      next.resolve(entry);
      return;
    }
    // Otherwise the waiter needs a fresh client. Forward the rebuild's
    // outcome — including failures — so they don't hang silently.
    this.acquire().then(next.resolve, next.reject);
  }

  async _build() {
    const client = _buildClient(this.account);
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`IMAP connect timeout (${CONNECT_TIMEOUT_MS}ms) for ${this.account.email}`)), CONNECT_TIMEOUT_MS);
    });
    try {
      await Promise.race([client.connect(), timeout]);
    } catch (err) {
      // The race may have rejected because of the timeout while the
      // underlying TCP socket is still trying to connect — close it so
      // we don't leak a half-open ImapFlow client + its keepalive timers.
      try {
        if (typeof client.close === "function") client.close();
        else if (typeof client.logout === "function") await client.logout();
      } catch { /* ignore */ }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
    return this._wire(client);
  }

  // Wrap a connected client in a pool entry: keepalive NOOPs plus eviction on
  // 'close' / 'error'. Split from _build() so tests can drive it with a fake.
  _wire(client) {
    const entry = { client, inUse: false, lastUsed: Date.now() };
    entry.keepalive = setInterval(() => {
      if (!entry.client || !entry.client.usable) return;
      entry.client.noop().catch(() => {});
    }, KEEPALIVE_MS);
    if (typeof entry.keepalive.unref === "function") entry.keepalive.unref();
    const forget = () => {
      clearInterval(entry.keepalive);
      if (entry.client === client) entry.client = null;
      const idx = this.entries.indexOf(entry);
      if (idx >= 0) this.entries.splice(idx, 1);
    };
    client.on("close", forget);
    // A socket error means this connection is done even if 'close' is slow to
    // follow. Stop handing it out now; the in-flight caller (if any) gets the
    // error from its pending command and withClient decides about a retry.
    client.on("error", () => {
      if (entry.client !== client) return;
      forget();
      try { if (typeof client.close === "function") client.close(); } catch { /* ignore */ }
    });
    return entry;
  }

  // Detach for a config reload: close idle connections now, let in-use ones
  // finish their call and close on release. Waiters already queued here are
  // still served from this pool so nobody hangs across the reload.
  drain() {
    this.draining = true;
    for (const e of [...this.entries]) {
      if (!e.inUse) this._discard(e);
    }
  }

  async closeAll() {
    this.closed = true;
    const entries = this.entries;
    this.entries = [];
    // Parallel and bounded: one wedged server must not stall shutdown for
    // every other account, nor for longer than LOGOUT_TIMEOUT_MS.
    await Promise.all(entries.map((e) => {
      clearInterval(e.keepalive);
      const c = e.client;
      e.client = null;
      return _logoutWithTimeout(c);
    }));
    // Reject any pending waiters with a clear error so they don't hang.
    while (this.waiters.length) {
      const w = this.waiters.shift();
      try { w.reject(new Error(`pool for ${this.account.email} is closed`)); } catch { /* ignore */ }
    }
  }

  // Close connections idle longer than idleMs, never dropping below keepWarm
  // live entries. In-use entries are untouchable. Returns how many were closed.
  reapIdle(idleMs, keepWarm) {
    if (!(idleMs > 0)) return 0;
    const now = Date.now();
    const live = this.entries.filter((e) => e.client && e.client.usable);
    // Oldest-idle first, so the warm one we keep is the most recently used.
    const idle = live
      .filter((e) => !e.inUse && now - (e.lastUsed || 0) >= idleMs)
      .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    const droppable = Math.max(0, live.length - keepWarm);
    const victims = idle.slice(0, droppable);
    // Fire-and-forget: a failed logout on an already-dead socket is fine.
    for (const e of victims) this._discard(e);
    return victims.length;
  }

  stats() {
    return {
      account_id: this.account.id,
      clients: this.entries.length,
      pending: this.pending,
      max_clients: this.maxSize,
      in_use: this.entries.filter((e) => e.inUse).length,
      waiters: this.waiters.length,
      connected: this.entries.some((e) => e.client && e.client.usable),
      last_used_ms_ago: this.entries.length
        ? Date.now() - Math.max(...this.entries.map((e) => e.lastUsed || 0))
        : null,
    };
  }
}

class ImapPool {
  constructor({ idleMs = POOL_IDLE_MS, keepWarm = POOL_KEEP_WARM } = {}) {
    this._pools = new Map(); // accountId → AccountPool
    this.maxPerAccount = MAX_CLIENTS_PER_ACCOUNT;
    this.idleMs = idleMs;
    this.keepWarm = keepWarm;
    this._sweep = null;
    if (this.idleMs > 0) {
      this._sweep = setInterval(() => this.reapIdle(), REAP_SWEEP_MS);
      // unref: the reaper must never be the reason the process stays alive.
      if (typeof this._sweep.unref === "function") this._sweep.unref();
    }
  }

  reapIdle() {
    let closed = 0;
    for (const p of this._pools.values()) closed += p.reapIdle(this.idleMs, this.keepWarm);
    return closed;
  }

  _poolFor(account) {
    let p = this._pools.get(account.id);
    if (!p) {
      p = new AccountPool(account, this.maxPerAccount);
      this._pools.set(account.id, p);
    }
    return p;
  }

  // Run fn(client) with a guaranteed-live client. Multiple concurrent
  // calls on the same account run in parallel on separate clients (up to
  // maxPerAccount).
  //
  // On a connection-level error the broken client is always dropped, but fn
  // is re-run on a fresh one only when the caller declares it idempotent
  // ({ idempotent: true }). A MOVE or EXPUNGE whose reply was lost may well
  // have happened server-side; running it again is not a "retry", it is a
  // second, different operation. Reads opt in; mutations surface the error.
  async withClient(account, fn, { idempotent = false } = {}) {
    const pool = this._poolFor(account);
    let entry = await pool.acquire();
    try {
      // Held separately: an 'error' event during fn evicts the entry and
      // nulls entry.client, but we still need to ask this client if it died.
      const client = entry.client;
      try {
        return await fn(client);
      } catch (err) {
        if (!_isConnectionError(err, client)) throw err;
        // An abandoned client was closed on purpose by a timed-out caller;
        // nobody is waiting for a second attempt.
        const abandoned = Boolean(client && client._mailUseAbandoned);
        // Drop the broken client before anyone else can be handed it.
        pool._discard(entry);
        if (!idempotent || abandoned) throw err;
        pool.release(entry); // remove dead entry from inUse accounting
        entry = await pool.acquire();
        return await fn(entry.client);
      }
    } finally {
      pool.release(entry);
    }
  }

  // Config reload: forget every account pool so the next call builds
  // connections from the freshly loaded account settings. Idle connections
  // are closed now; in-use ones finish their current call and are closed on
  // release instead of going back to idle. The reaper keeps running — unlike
  // closeAll(), the pool stays usable afterwards.
  reset() {
    for (const p of this._pools.values()) p.drain();
    this._pools.clear();
  }

  // Final shutdown. Stops the reaper and logs every connection out in
  // parallel, each bounded by LOGOUT_TIMEOUT_MS.
  async closeAll() {
    if (this._sweep) {
      clearInterval(this._sweep);
      this._sweep = null;
    }
    const pools = [...this._pools.values()];
    this._pools.clear();
    await Promise.all(pools.map((p) => p.closeAll()));
  }

  stats() {
    return [...this._pools.values()].map((p) => p.stats());
  }
}

// Give up on a client whose caller has stopped waiting (e.g. a search that hit
// its wall-clock deadline). Closing the socket makes the orphaned command fail
// fast instead of scanning on in the background, and the mark tells the pool
// not to hand this connection to anyone else or re-run the work.
function abandonClient(client) {
  if (!client) return;
  try { client._mailUseAbandoned = true; } catch { /* ignore */ }
  try { if (typeof client.close === "function") client.close(); } catch { /* ignore */ }
}

module.exports = { ImapPool, abandonClient, _buildClient, _logoutWithTimeout, _isConnectionError };
