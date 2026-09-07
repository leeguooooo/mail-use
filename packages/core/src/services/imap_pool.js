// Per-account persistent ImapFlow connection pool. Lives in a long-running
// process (the mail-use daemon). Each account gets up to MAX_CLIENTS_PER_ACCOUNT
// long-lived connections (default 3); concurrent requests on the same
// account run on different clients in parallel instead of serializing
// behind a mutex. Each client sends NOOP every 25 minutes so the server's
// ~30 minute idle disconnect doesn't kick us off, and reconnects
// transparently when the underlying socket dies.

const { ImapFlow } = require("imapflow");

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

function _allowInsecureTls() {
  return String(process.env.MAILBOX_ALLOW_INSECURE_TLS || "").trim() === "1";
}

function _buildClient(account) {
  const port = Number(account.imap.port);
  const secure = Boolean(account.imap.secure);
  return new ImapFlow({
    host: account.imap.host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: !_allowInsecureTls(), minVersion: "TLSv1.2" },
    logger: false,
  });
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
    // 3. Build a new client if there's room.
    if (this.entries.length < this.maxSize) {
      const e = await this._build();
      e.inUse = true;
      e.lastUsed = Date.now();
      this.entries.push(e);
      return e;
    }
    // 4. Wait for someone to release.
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  release(entry) {
    entry.inUse = false;
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
    const entry = { client, inUse: false, lastUsed: Date.now() };
    entry.keepalive = setInterval(() => {
      if (!entry.client || !entry.client.usable) return;
      entry.client.noop().catch(() => {});
    }, KEEPALIVE_MS);
    if (typeof entry.keepalive.unref === "function") entry.keepalive.unref();
    client.on("close", () => {
      clearInterval(entry.keepalive);
      entry.client = null;
      const idx = this.entries.indexOf(entry);
      if (idx >= 0) this.entries.splice(idx, 1);
    });
    return entry;
  }

  async closeAll() {
    this.closed = true;
    for (const e of this.entries) {
      clearInterval(e.keepalive);
      if (e.client) {
        try { await e.client.logout(); } catch { /* ignore */ }
      }
    }
    this.entries = [];
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
    for (const e of victims) {
      clearInterval(e.keepalive);
      const c = e.client;
      e.client = null;
      const idx = this.entries.indexOf(e);
      if (idx >= 0) this.entries.splice(idx, 1);
      // Fire-and-forget: a failed logout on an already-dead socket is fine.
      try { if (c) Promise.resolve(c.logout()).catch(() => {}); } catch { /* ignore */ }
    }
    return victims.length;
  }

  stats() {
    return {
      account_id: this.account.id,
      clients: this.entries.length,
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
  // maxPerAccount). One automatic retry on connection-level errors.
  async withClient(account, fn) {
    const pool = this._poolFor(account);
    let entry = await pool.acquire();
    try {
      try {
        return await fn(entry.client);
      } catch (err) {
        const msg = (err && err.message) || "";
        if (/usable|EPIPE|ECONNRESET|connection.*closed|not connected|socket.*closed/i.test(msg)) {
          // Drop the broken client and retry once with a fresh one.
          try { if (entry.client) await entry.client.logout(); } catch { /* ignore */ }
          entry.client = null;
          pool.release(entry); // remove dead entry from inUse accounting
          entry = await pool.acquire();
          return await fn(entry.client);
        }
        throw err;
      }
    } finally {
      pool.release(entry);
    }
  }

  async closeAll() {
    if (this._sweep) {
      clearInterval(this._sweep);
      this._sweep = null;
    }
    for (const p of this._pools.values()) {
      await p.closeAll();
    }
    this._pools.clear();
  }

  stats() {
    return [...this._pools.values()].map((p) => p.stats());
  }
}

module.exports = { ImapPool };
