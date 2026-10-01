// Transparent core proxy: each call routes through the mail-use daemon's
// Unix socket if one is reachable, otherwise falls back to the original
// in-process implementation. Lets every existing action in main.js keep
// calling `email.searchEmails(args)` etc. without knowing whether a
// daemon is around.

const net = require("net");
const fs = require("fs");
const { getSocketPath } = require("./daemon_paths");

// Core and workflows load on first use, not at require time: they pull in
// sql.js, imapflow, mailparser and friends, which every CLI invocation paid for
// even when it never touched mail (`--version`, `--help`, `daemon status`).
let _realCore = null;
let _realWorkflows = null;
function _core() {
  if (!_realCore) _realCore = require("@mail-use/core");
  return _realCore;
}
function _workflows() {
  if (!_realWorkflows) {
    try { _realWorkflows = require("@mail-use/workflows"); } catch { _realWorkflows = {}; }
  }
  return _realWorkflows;
}

const CONNECT_TIMEOUT_MS = Number(process.env.MAILBOX_DAEMON_CONNECT_TIMEOUT_MS || 200);
const CALL_TIMEOUT_MS = Number(process.env.MAILBOX_DAEMON_CALL_TIMEOUT_MS || 60000);
// How long after a probe miss before we'll re-probe the daemon socket.
// Long-running MCP servers benefit from re-probing because the daemon
// may have been started after MCP came up. Short-lived CLI calls don't
// see this — they exit before the cooldown matters.
const REPROBE_AFTER_MS = Number(process.env.MAILBOX_DAEMON_REPROBE_MS || 5000);

let _client = null;
let _connecting = null;
let _lastMissAt = 0;

class DaemonClient {
  constructor(conn) {
    this.conn = conn;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => this._onData(chunk));
    conn.on("close", () => this._failAll(new Error("daemon connection closed")));
    conn.on("error", () => this._failAll(new Error("daemon connection error")));
  }
  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error || "daemon error"), { code: msg.error_code }));
    }
  }
  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
  call(fn, args, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // Per-call timeout so a malformed/missing daemon response doesn't
      // hang the CLI or MCP server forever. 0 = no client-side limit (the
      // call bounds itself, e.g. a sync pass).
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject(Object.assign(new Error(`daemon call ${fn} timed out after ${timeoutMs}ms`), { code: "daemon_timeout" }));
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      const wrap = {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      };
      this.pending.set(id, wrap);
      try {
        this.conn.write(JSON.stringify({ id, fn, args: args || {} }) + "\n");
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  close() {
    try { this.conn.end(); } catch { /* ignore */ }
  }
}

async function _maybeConnect() {
  // Daemon disabled by env knob (useful when an agent has no daemon and
  // wants to skip the probe latency). Internal test mode also bypasses the
  // daemon so MAILBOX_CONFIG_DIR fixtures aren't shadowed by a daemon
  // started against the user's real auth.json.
  if (String(process.env.MAILBOX_NO_DAEMON || "").trim() === "1") return null;
  if (String(process.env.MAILBOX_INTERNAL_TEST_MODE || "").trim() === "1") return null;

  // Reuse a live client.
  if (_client && _client.conn && !_client.conn.destroyed) return _client;
  _client = null;

  // Concurrent callers (an MCP server fanning out tool calls) share the one
  // connect in flight. Previously the probe timestamp was stamped before the
  // connect resolved, so every caller after the first saw the cooldown and
  // silently ran in-process while the daemon was coming up fine.
  if (_connecting) return _connecting;

  // Cooldown: don't re-probe more than once every REPROBE_AFTER_MS after a
  // miss. Lets short-lived CLI calls fall through fast, lets long-running
  // MCP servers eventually pick up a daemon that started later.
  if (Date.now() - _lastMissAt < REPROBE_AFTER_MS) return null;

  _connecting = _connectOnce().then((c) => {
    if (!c) _lastMissAt = Date.now();
    return c;
  }).finally(() => { _connecting = null; });
  return _connecting;
}

function _connectOnce() {
  const sockPath = getSocketPath();
  if (!fs.existsSync(sockPath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const conn = net.createConnection(sockPath);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch { /* ignore */ }
      resolve(null);
    }, CONNECT_TIMEOUT_MS);
    const settle = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    conn.once("connect", () => {
      if (done) return;
      const c = new DaemonClient(conn);
      // Drop the cached client when its socket dies so the next call
      // re-probes instead of trying to write to a dead pipe.
      conn.on("close", () => { if (_client === c) _client = null; });
      conn.on("error", () => { if (_client === c) _client = null; });
      _client = c;
      // Note: do NOT unref the socket here. Every CLI action handler
      // ends with process.exit(rc); unref'ing would let Node exit
      // before the daemon response arrives, killing the in-flight call.
      // For long-running consumers (MCP serve), the conn is already
      // ref'd because of pending writes/reads.
      settle(c);
    });
    conn.once("error", () => settle(null));
  });
}

// Calls that run as long as they need to (a full sync of every account, a
// digest over a mailbox): a fixed client-side timeout only abandons the reply
// while the daemon keeps working, and then reports failure for work that is
// actually happening.
const UNBOUNDED_FNS = new Set([
  "sync.force",
  "sync.init",
  "digest.run",
  "monitor.run",
  "inbox.run",
  "cleanup.plan",
  "cleanup.apply",
]);
// Slack between a caller's own deadline and ours, so the daemon's partial
// result (timed_out:true) arrives before we give up on it.
const TIMEOUT_MARGIN_MS = 15_000;

function _callTimeoutMs(fullName, args) {
  if (UNBOUNDED_FNS.has(fullName)) return 0;
  const own = args && args.timeout_ms != null ? Number(args.timeout_ms) : NaN;
  if (Number.isFinite(own)) {
    if (own <= 0) return 0; // the caller asked for no limit
    return Math.max(CALL_TIMEOUT_MS, own + TIMEOUT_MARGIN_MS);
  }
  return CALL_TIMEOUT_MS;
}

// Functions that mutate remote state. If a daemon RPC fails AFTER we've
// already written the request to the socket, we cannot tell whether the
// daemon performed the action — falling back to in-process would risk
// double-execution (sent emails, double-deletes, etc). For this allow-list
// we surface the RPC failure to the caller instead and let them retry.
const MUTATING_FNS = new Set([
  "email.sendEmail",
  "email.deleteEmails",
  "email.markEmails",
  "email.flagEmail",
  "email.moveEmails",
  "email.replyEmail",
  "email.forwardEmail",
  "email.downloadAttachments",
  "sync.force",
  "sync.init",
  "digest.run",
  "monitor.run",
  "inbox.run",
  "cleanup.apply",
]);

function _hasOutgoingAttachments(args) {
  const attachments = args && args.attachments;
  if (!attachments) return false;
  return Array.isArray(attachments) ? attachments.length > 0 : true;
}

function _shouldBypassDaemonForCall(fullName, args) {
  if (fullName === "email.sendEmail") return _hasOutgoingAttachments(args);
  if (fullName === "email.replyEmail") return Boolean(args && args.dry_run === true) || _hasOutgoingAttachments(args);
  if (fullName === "email.forwardEmail") return Boolean(args && args.dry_run === true);
  return false;
}

// `load` returns the real namespace object; it runs on first property access so
// building the proxies costs nothing.
function _wrapNamespace(nsName, load) {
  const handler = {
    get(_, fname) {
      if (typeof fname !== "string") return undefined;
      if (fname === "then") return undefined; // not a thenable
      const realObj = load();
      const direct = realObj && realObj[fname];
      // For non-function exports (constants etc.), pass straight through.
      if (typeof direct !== "function") return direct;
      const fullName = `${nsName}.${fname}`;
      return async function (...callArgs) {
        const args = callArgs[0]; // every core fn takes a single options object
        const isMutator = MUTATING_FNS.has(fullName);
        const isDryRun = isMutator && args && (args.dry_run === true);
        const client = _shouldBypassDaemonForCall(fullName, args) ? null : await _maybeConnect();
        if (client) {
          try {
            return await client.call(fullName, args, _callTimeoutMs(fullName, args));
          } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            // For mutating calls that aren't dry-run, refuse to retry
            // in-process: the daemon may have already performed the work
            // and we'd execute it twice. Surface the failure instead.
            if (isMutator && !isDryRun) {
              if (process.env.MAILBOX_DAEMON_DEBUG) process.stderr.write(`mail-use: daemon call ${fullName} failed: ${msg}; refusing fallback for mutating call\n`);
              return {
                success: false,
                error: `daemon RPC failed for ${fullName}: ${msg}. Refusing to fall back to direct execution because it may have already mutated state. Re-check before retrying.`,
                error_code: "daemon_rpc_failed",
                daemon_rpc_failed: true,
              };
            }
            // A timeout means the daemon is still working on it. Re-running the
            // same search in-process doubles the wait and the IMAP load, so
            // report it; only an unreachable/broken daemon falls back.
            if (e && e.code === "daemon_timeout") {
              return { success: false, error: msg, error_code: "daemon_timeout" };
            }
            if (process.env.MAILBOX_DAEMON_DEBUG) process.stderr.write(`mail-use: daemon call ${fullName} failed: ${msg}; falling back to direct\n`);
          }
        }
        return direct.apply(realObj, callArgs);
      };
    },
  };
  return new Proxy({}, handler);
}

function makeProxies() {
  return {
    accounts: _wrapNamespace("accounts", () => _core().accounts),
    email: _wrapNamespace("email", () => _core().email),
    sync: _wrapNamespace("sync", () => _core().sync),
    // imap/smtp are not RPC'd — internal helpers only, loaded on first use.
    get imap() { return _core().imap; },
    get smtp() { return _core().smtp; },
    digest: _wrapNamespace("digest", () => _workflows().digest || {}),
    monitor: _wrapNamespace("monitor", () => _workflows().monitor || {}),
    inbox: _wrapNamespace("inbox", () => _workflows().inbox || {}),
    cleanup: _wrapNamespace("cleanup", () => _workflows().cleanup || {}),
  };
}

module.exports = { makeProxies, _shouldBypassDaemonForCall, _callTimeoutMs, _maybeConnect };

