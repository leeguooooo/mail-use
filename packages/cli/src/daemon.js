// Persistent IMAP daemon. Listens on a Unix socket and serves JSON-RPC
// calls into @mail-use/core, reusing pooled IMAP connections so each
// downstream CLI invocation skips the 1-3s TCP+TLS+LOGIN handshake.
//
// Wire format: line-delimited JSON.
//   request:  {"id":1,"fn":"email.searchEmails","args":{...}}
//   response: {"id":1,"ok":true,"result":...}
//          or {"id":1,"ok":false,"error":"...","error_code":"..."}
//
// Special methods:
//   __ping           → {ok:true,result:{pong:true,version,started_at,stats}}
//   __reload         → re-resolve account credentials (auth.json edited)
//   __shutdown       → close connections and exit

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const core = require("@mail-use/core");
const { ImapPool } = require("@mail-use/core/src/services/imap_pool");
const { digest, monitor, inbox, cleanup } = (() => {
  try { return require("@mail-use/workflows"); } catch { return {}; }
})();

// Passive update check. The daemon is the only long-lived thing here, so it is
// the natural place to notice a new release without making every CLI call pay a
// network round-trip. Strictly a *notice*: it never downloads or installs
// anything — `mail-use upgrade` stays explicit.
//
// One unauthenticated GET to api.github.com per interval, carrying nothing but a
// User-Agent. Set MAILBOX_UPDATE_CHECK_HOURS=0 to turn it off entirely.
const UPDATE_CHECK_DEFAULT_HOURS = 24;
const UPDATE_CHECK_START_DELAY_MS = 60 * 1000; // let prewarm finish first

function _updateCheckIntervalMs() {
  const raw = process.env.MAILBOX_UPDATE_CHECK_HOURS;
  const hours = raw == null || String(raw).trim() === "" ? UPDATE_CHECK_DEFAULT_HOURS : Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return hours * 60 * 60 * 1000;
}

function _startUpdateChecks(ctx) {
  const intervalMs = _updateCheckIntervalMs();
  if (intervalMs <= 0) return null;

  const run = async () => {
    try {
      const { checkForUpdate } = require("./upgrade");
      const { getCliVersion } = require("./cli_version");
      const r = await checkForUpdate(getCliVersion());
      ctx.update = { ...r, checked_at: new Date().toISOString(), error: null };
      if (r.update_available) {
        ctx.log(`[mail-use daemon] update available: ${r.current} -> ${r.latest} (run: mail-use upgrade)`);
      }
    } catch (e) {
      // Offline, rate-limited, DNS-blocked: all normal. Record it and stay quiet
      // rather than logging on a loop.
      ctx.update = { ...(ctx.update || {}), checked_at: new Date().toISOString(), error: (e && e.message) || String(e) };
    }
  };

  const first = setTimeout(run, UPDATE_CHECK_START_DELAY_MS);
  if (typeof first.unref === "function") first.unref();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { first, timer };
}

function getSocketPath() {
  if (process.env.MAILBOX_DAEMON_SOCKET) return process.env.MAILBOX_DAEMON_SOCKET;
  const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache", "mailbox");
  return path.join(base, `daemon-${process.getuid ? process.getuid() : "x"}.sock`);
}

function getPidFilePath() {
  return getSocketPath().replace(/\.sock$/, ".pid");
}

function _resolveFn(fnName) {
  const parts = String(fnName || "").split(".");
  if (parts.length !== 2) return null;
  const [ns, name] = parts;
  const namespaces = {
    accounts: core.accounts,
    email: core.email,
    sync: core.sync,
    digest, monitor, inbox, cleanup,
  };
  const obj = namespaces[ns];
  if (!obj) return null;
  const fn = obj[name];
  if (typeof fn !== "function") return null;
  return fn.bind(obj);
}

// `foreground` is accepted and ignored: startDaemon always runs in the
// caller's process, and detaching is launchd/systemd/nohup's job. Kept in the
// signature so the existing call site reads intentionally.
async function startDaemon({ foreground: _foreground = true, log = console.error, syncIntervalMs = 0, syncAccountId = "" } = {}) {
  const sockPath = getSocketPath();
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });

  // If another daemon owns the socket, refuse to clobber it.
  if (fs.existsSync(sockPath)) {
    const reachable = await _probe(sockPath).catch(() => false);
    if (reachable) {
      throw Object.assign(new Error(`mail-use daemon already running on ${sockPath}`), { code: "EADDRINUSE" });
    }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
  }

  const pool = new ImapPool();
  core.imap.setGlobalPool(pool);
  const startedAt = Date.now();
  const stats = { syncs_attempted: 0, syncs_ok: 0, syncs_failed: 0, last_sync_at: null, last_sync_error: null };

  const ctx = { pool, startedAt, log, stats, update: null };
  const updateTimers = _startUpdateChecks(ctx);
  const server = net.createServer((conn) => _handleConn(conn, ctx));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
      resolve();
    });
  });

  fs.writeFileSync(getPidFilePath(), String(process.pid), { mode: 0o600 });

  // Prewarm: open one IMAP connection per configured account in
  // parallel so the first CLI/MCP call doesn't pay the 1-3s TCP+TLS+
  // LOGIN cost. We don't await the whole prewarm — it kicks off in
  // the background so the daemon is reachable immediately.
  (async () => {
    try {
      const all = await core.accounts.getAllAccountsResolved();
      if (!all || !all.success) return;
      const targets = (all.accounts || []).filter((a) => !syncAccountId || a.id === syncAccountId);
      stats.prewarm = { started: targets.length, completed: 0, failed: 0 };
      await Promise.all(targets.map(async (acc) => {
        try {
          await pool.withClient(acc, async (client) => { await client.noop(); });
          stats.prewarm.completed += 1;
        } catch (e) {
          stats.prewarm.failed += 1;
          log(`[mail-use daemon] prewarm ${acc.email} failed: ${(e && e.message) || e}`);
        }
      }));
      log(`[mail-use daemon] prewarmed ${stats.prewarm.completed}/${stats.prewarm.started} account(s)`);
    } catch (e) {
      log(`[mail-use daemon] prewarm aborted: ${(e && e.message) || e}`);
    }
  })();

  // Background sync loop. Runs in-process so it shares the same pooled
  // IMAP connections as RPC traffic — no extra TCP handshakes for the
  // periodic refresh. AI clients hitting `email list` (without --live)
  // then read from the local SQLite cache instead of doing IMAP at all.
  // Background sync loop. Uses an awaiting setTimeout chain rather than
  // setInterval so a slow IMAP+SQLite pass can't trigger overlapping
  // sync.force() calls (which would race on the cache db and on the
  // pooled IMAP connection).
  let syncRunning = false;
  let syncStopped = false;
  if (syncIntervalMs > 0) {
    const runSync = async () => {
      if (syncStopped) return;
      if (syncRunning) return; // belt-and-suspenders; loop already serializes
      syncRunning = true;
      stats.syncs_attempted += 1;
      try {
        const r = await core.sync.force({ account_id: syncAccountId || "", full: false });
        if (r && r.success === false) throw new Error(r.error || "sync failed");
        stats.syncs_ok += 1;
        stats.last_sync_at = new Date().toISOString();
        stats.last_sync_error = null;
      } catch (e) {
        stats.syncs_failed += 1;
        stats.last_sync_error = (e && e.message) || String(e);
      } finally {
        syncRunning = false;
      }
    };
    const scheduleNext = (delay) => {
      if (syncStopped) return;
      const t = setTimeout(async () => {
        await runSync();
        scheduleNext(syncIntervalMs);
      }, delay);
      if (typeof t.unref === "function") t.unref();
    };
    scheduleNext(5_000); // first run after warm-up
    log(`[mail-use daemon] background sync every ${Math.round(syncIntervalMs / 1000)}s${syncAccountId ? ` (account ${syncAccountId})` : ""}`);
  }

  const cleanup = async () => {
    log(`[mail-use daemon] shutting down (pid=${process.pid})`);
    syncStopped = true;
    if (updateTimers) {
      clearTimeout(updateTimers.first);
      clearInterval(updateTimers.timer);
    }
    try { await pool.closeAll(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(getPidFilePath()); } catch { /* ignore */ }
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  log(`[mail-use daemon] listening on ${sockPath} (pid=${process.pid})`);
  return { server, pool, sockPath, stats };
}

// Hard cap on a single JSON-RPC line, measured in bytes. 1 MiB is plenty
// for any legitimate request (even RPC'd email bodies) and stops a
// misbehaving local client from growing our recv buffer until OOM.
const MAX_LINE_BYTES = Number(process.env.MAILBOX_DAEMON_MAX_LINE_BYTES || 1 * 1024 * 1024);

function _handleConn(conn, ctx) {
  // We accumulate raw Buffers (not decoded strings) so the size cap is
  // measured in real bytes — `setEncoding("utf8")` would make chunk.length
  // a UTF-16 unit count and let multi-byte payloads overflow the
  // advertised limit. We also reject BEFORE concatenating, so a single
  // oversized chunk can't slip past the check.
  let buffer = Buffer.alloc(0);
  conn.on("data", (chunk) => {
    if (chunk.length + buffer.length > MAX_LINE_BYTES) {
      try {
        conn.write(JSON.stringify({ id: null, ok: false, error: `request exceeds MAILBOX_DAEMON_MAX_LINE_BYTES=${MAX_LINE_BYTES}`, error_code: "size_limit" }) + "\n");
      } catch { /* ignore */ }
      try { conn.destroy(); } catch { /* ignore */ }
      buffer = Buffer.alloc(0);
      return;
    }
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (true) {
      const idx = buffer.indexOf(0x0a); // '\n'
      if (idx < 0) break;
      const line = buffer.slice(0, idx).toString("utf8");
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      _dispatch(line, conn, ctx).catch((e) => ctx.log(`[mail-use daemon] dispatch error: ${e}`));
    }
  });
  conn.on("error", () => { /* ignore client disconnects */ });
}

async function _dispatch(line, conn, ctx) {
  let req;
  try { req = JSON.parse(line); } catch (e) {
    return _respond(conn, { id: null, ok: false, error: `invalid JSON: ${e.message}`, error_code: "invalid_argument" });
  }
  const id = req.id;
  const fnName = String(req.fn || "");

  if (fnName === "__ping") {
    return _respond(conn, { id, ok: true, result: {
      pong: true,
      pid: process.pid,
      uptime_ms: Date.now() - ctx.startedAt,
      pool: ctx.pool.stats(),
      sync: ctx.stats || null,
      update: ctx.update || null,
    } });
  }
  if (fnName === "__reload") {
    // Account credentials are read fresh from auth.json on each call, so a
    // reload mostly means: drop existing connections so the next acquire
    // picks up new creds.
    await ctx.pool.closeAll();
    return _respond(conn, { id, ok: true, result: { reloaded: true } });
  }
  if (fnName === "__shutdown") {
    _respond(conn, { id, ok: true, result: { shutting_down: true } });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
    return;
  }

  const fn = _resolveFn(fnName);
  if (!fn) {
    return _respond(conn, { id, ok: false, error: `unknown fn: ${fnName}`, error_code: "unknown_fn" });
  }
  const t0 = Date.now();
  try {
    const result = await fn(req.args || {});
    const dt = Date.now() - t0;
    if (process.env.MAILBOX_DAEMON_TRACE) ctx.log(`[mail-use daemon] ${fnName} ok in ${dt}ms`);
    _respond(conn, { id, ok: true, result });
  } catch (e) {
    const dt = Date.now() - t0;
    if (process.env.MAILBOX_DAEMON_TRACE) ctx.log(`[mail-use daemon] ${fnName} FAIL in ${dt}ms: ${(e && e.message) || e}`);
    _respond(conn, { id, ok: false, error: (e && e.message) || "failed", error_code: "operation_failed" });
  }
}

function _respond(conn, payload) {
  try { conn.write(JSON.stringify(payload) + "\n"); } catch { /* ignore */ }
}

async function _probe(sockPath) {
  return new Promise((resolve) => {
    const c = net.createConnection(sockPath);
    c.once("connect", () => { c.end(); resolve(true); });
    c.once("error", () => resolve(false));
    setTimeout(() => { try { c.destroy(); } catch {} resolve(false); }, 500);
  });
}

// ---------- autostart (launchd / systemd-user) ----------

// 改名 mailbox -> mail-use 时，launchd label / systemd unit / socket 路径刻意不动：
// 它们标识的是用户机器上**已经装好**的那份常驻服务。换个名字，install 会写出第二份，
// 老的那份还在跑，两个 daemon 抢同一个 socket——用户什么都没做就坏了。
const LAUNCHD_LABEL = "com.leeguoo.mailbox.daemon";
const SYSTEMD_UNIT = "mailbox-daemon.service";

function _resolveCliExecutable() {
  // Returns { node, script } describing how to re-invoke the CLI from a
  // launchd / systemd unit file.
  //
  // - In a normal `node /path/to/mailbox.js …` invocation we return
  //   { node: process.execPath, script: argv[1] } so the unit reads
  //   `node /abs/path/mailbox.js daemon start …`.
  //
  // - In a pkg-bundled binary (the npm distribution), `process.execPath`
  //   IS the standalone binary and `process.argv[1]` is `/snapshot/...`
  //   — a virtual path that only exists inside the binary's embedded
  //   filesystem. In that case the unit must invoke the binary directly
  //   with no script argument. We signal that by returning node = "".
  const argv1 = process.argv[1] || "";
  const exe = process.execPath || "node";
  const isPkgBundle = argv1.startsWith("/snapshot/") || (typeof process.pkg !== "undefined");
  if (isPkgBundle) return { node: "", script: exe };
  if (argv1 && fs.existsSync(argv1)) return { node: exe, script: argv1 };
  return { node: exe, script: "mail-use" };
}

function _autostartPaths() {
  if (process.platform === "darwin") {
    return {
      kind: "launchd",
      unitPath: path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      logPath: path.join(os.homedir(), "Library", "Logs", "mailbox-daemon.log"),
    };
  }
  if (process.platform === "linux") {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return {
      kind: "systemd",
      unitPath: path.join(xdg, "systemd", "user", SYSTEMD_UNIT),
      logPath: "",
    };
  }
  return { kind: "unsupported", unitPath: "", logPath: "" };
}

function _xml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function _renderLaunchdPlist({ node, script, syncIntervalSec, logPath }) {
  // node === "" means the script IS a self-contained binary (pkg).
  const programArgs = (node ? [node, script] : [script])
    .concat(["daemon", "start", "--sync-interval", String(syncIntervalSec)]);
  const argsXml = programArgs.map((a) => `    <string>${_xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${_xml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${_xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${_xml(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function _shellQuote(s) {
  // Quote for systemd ExecStart (shell-like splitting). Wrap in
  // double quotes and escape embedded ones; safe for paths with spaces.
  return `"${String(s).replace(/(["\\$])/g, "\\$1")}"`;
}

function _renderSystemdUnit({ node, script, syncIntervalSec }) {
  const cmdParts = (node ? [node, script] : [script])
    .concat(["daemon", "start", "--sync-interval", String(syncIntervalSec)]);
  const cmdLine = cmdParts.map(_shellQuote).join(" ");
  return `[Unit]
Description=Mailbox CLI persistent IMAP daemon
After=network-online.target

[Service]
ExecStart=${cmdLine}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function installAutostart({ syncIntervalSec = 300 } = {}) {
  const info = _autostartPaths();
  if (info.kind === "unsupported") {
    return { success: false, error: `autostart not supported on platform ${process.platform}`, error_code: "unsupported" };
  }
  const { node, script } = _resolveCliExecutable();
  fs.mkdirSync(path.dirname(info.unitPath), { recursive: true });

  if (info.kind === "launchd") {
    fs.mkdirSync(path.dirname(info.logPath), { recursive: true });
    const body = _renderLaunchdPlist({ node, script, syncIntervalSec, logPath: info.logPath });
    fs.writeFileSync(info.unitPath, body, { mode: 0o644 });
    // Best-effort load. User may need to do it manually if SIP-locked.
    let activate = "";
    try {
      const { execFileSync } = require("child_process");
      execFileSync("launchctl", ["unload", info.unitPath], { stdio: "ignore" });
    } catch { /* not previously loaded — fine */ }
    try {
      const { execFileSync } = require("child_process");
      execFileSync("launchctl", ["load", "-w", info.unitPath], { stdio: "ignore" });
      activate = `launchctl loaded — daemon will start now and at every login. Logs: ${info.logPath}`;
    } catch (e) {
      activate = `wrote plist; load it manually: launchctl load -w ${info.unitPath}`;
    }
    return { success: true, unit_path: info.unitPath, log_path: info.logPath, exe: (node ? `${node} ${script}` : script), sync_interval_sec: syncIntervalSec, activate_hint: activate };
  }

  if (info.kind === "systemd") {
    const body = _renderSystemdUnit({ node, script, syncIntervalSec });
    fs.writeFileSync(info.unitPath, body, { mode: 0o644 });
    let activate = `systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}`;
    try {
      const { execFileSync } = require("child_process");
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
      activate = `systemd unit enabled and started`;
    } catch { /* leave activate as the manual instruction */ }
    return { success: true, unit_path: info.unitPath, exe: (node ? `${node} ${script}` : script), sync_interval_sec: syncIntervalSec, activate_hint: activate };
  }

  return { success: false, error: "unknown autostart kind", error_code: "operation_failed" };
}

async function uninstallAutostart() {
  const info = _autostartPaths();
  if (info.kind === "unsupported") {
    return { success: false, error: `autostart not supported on platform ${process.platform}`, error_code: "unsupported" };
  }
  if (!fs.existsSync(info.unitPath)) {
    return { success: true, unit_path: "" };
  }
  if (info.kind === "launchd") {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("launchctl", ["unload", info.unitPath], { stdio: "ignore" });
    } catch { /* ignore */ }
  } else if (info.kind === "systemd") {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
    } catch { /* ignore */ }
  }
  try { fs.unlinkSync(info.unitPath); } catch { /* ignore */ }
  return { success: true, unit_path: info.unitPath };
}

module.exports = {
  startDaemon, getSocketPath, getPidFilePath,
  installAutostart, uninstallAutostart,
  // Exported for tests: the update check must stay disableable and unref'd.
  _updateCheckIntervalMs, _startUpdateChecks,
};
