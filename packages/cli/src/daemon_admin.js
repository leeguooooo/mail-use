// Admin RPCs (__ping / __reload / __shutdown) sent straight to the daemon
// socket, bypassing the core proxies' in-process fallback — these only make
// sense when a daemon is actually listening.
//
// Deliberately light (net + fs + daemon_paths only) so `daemon status`/`stop`
// and the upgrade path can use it without loading @mail-use/core.

const fs = require("fs");
const net = require("net");
const { getSocketPath } = require("./daemon_paths");

function daemonAdmin(fnName, { timeoutMs = 2000, sockPath = getSocketPath() } = {}) {
  if (!fs.existsSync(sockPath)) {
    return Promise.resolve({ success: false, error: `daemon socket not found at ${sockPath}`, error_code: "not_running" });
  }
  return new Promise((resolve) => {
    const conn = net.createConnection(sockPath);
    let buf = "";
    let settled = false;
    let timer = null;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { conn.end(); } catch { /* ignore */ }
      resolve(val);
    };
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      try {
        const msg = JSON.parse(line);
        if (msg.ok) settle({ success: true, ...(msg.result || {}) });
        else settle({ success: false, error: msg.error || "daemon error", error_code: msg.error_code });
      } catch (e) {
        settle({ success: false, error: `invalid daemon response: ${e.message}`, error_code: "operation_failed" });
      }
    });
    conn.on("error", (e) => {
      // A socket file nobody listens on is a daemon that died without cleanup.
      const notRunning = e && (e.code === "ECONNREFUSED" || e.code === "ENOENT");
      settle({ success: false, error: e.message, error_code: notRunning ? "not_running" : "network_error" });
    });
    conn.on("connect", () => {
      conn.write(JSON.stringify({ id: 1, fn: fnName }) + "\n");
    });
    timer = setTimeout(
      () => settle({ success: false, error: `daemon did not respond within ${Math.round(timeoutMs / 1000)}s`, error_code: "network_error" }),
      timeoutMs
    );
  });
}

// Does anything accept a connection on the daemon socket right now? A
// successful connect is enough: only a live daemon binds this path, and a stale
// socket file refuses the connection. Sends nothing.
function socketAccepts({ sockPath = getSocketPath(), timeoutMs = 1000 } = {}) {
  if (!fs.existsSync(sockPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const c = net.createConnection(sockPath);
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    c.once("connect", () => { try { c.end(); } catch { /* ignore */ } done(true); });
    c.once("error", () => done(false));
    timer = setTimeout(() => { try { c.destroy(); } catch { /* ignore */ } done(false); }, timeoutMs);
  });
}

module.exports = { daemonAdmin, socketAccepts };
