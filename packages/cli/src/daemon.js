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
const { getSocketPath, getPidFilePath } = require("./daemon_paths");
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
  // The socket gates access to every mailbox the daemon can reach, so its
  // directory is owner-only. The default ~/.cache/mailbox may predate this
  // (created 0755), so tighten it too; XDG_RUNTIME_DIR and an explicit
  // MAILBOX_DAEMON_SOCKET are directories the user manages.
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  if (!process.env.MAILBOX_DAEMON_SOCKET && !process.env.XDG_RUNTIME_DIR) {
    try { fs.chmodSync(path.dirname(sockPath), 0o700); } catch { /* best effort */ }
  }

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

  let shuttingDown = false;
  const cleanup = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[mail-use daemon] shutting down (pid=${process.pid})`);
    syncStopped = true;
    if (updateTimers) {
      clearTimeout(updateTimers.first);
      clearInterval(updateTimers.timer);
    }
    // Stop accepting and free the socket path first, so a replacement daemon
    // can bind even while the IMAP logouts below are still in flight.
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(getPidFilePath()); } catch { /* ignore */ }
    // A wedged IMAP LOGOUT must not keep a stopped daemon alive: launchd and
    // systemd would wait on it, and `daemon stop` would look like it hung.
    await Promise.race([
      Promise.resolve().then(() => pool.closeAll()).catch(() => {}),
      new Promise((r) => { const t = setTimeout(r, SHUTDOWN_GRACE_MS); if (typeof t.unref === "function") t.unref(); }),
    ]);
    process.exit(exitCode);
  };
  process.once("SIGINT", () => cleanup(0));
  process.once("SIGTERM", () => cleanup(0));
  // A stray rejection in one RPC or sync pass is logged, not fatal: the daemon
  // serves every other caller too. A synchronous throw that reached the top
  // leaves state unknown, so log it and exit non-zero — the supervisor
  // (Restart=on-failure / KeepAlive SuccessfulExit=false) starts a clean one.
  process.on("unhandledRejection", (reason) => {
    log(`[mail-use daemon] unhandled rejection: ${(reason && reason.stack) || reason}`);
  });
  process.on("uncaughtException", (err) => {
    log(`[mail-use daemon] uncaught exception: ${(err && err.stack) || err}`);
    cleanup(1);
  });

  log(`[mail-use daemon] listening on ${sockPath} (pid=${process.pid})`);
  return { server, pool, sockPath, stats };
}

// How long shutdown waits for pooled IMAP connections to log out.
const SHUTDOWN_GRACE_MS = Number(process.env.MAILBOX_DAEMON_SHUTDOWN_GRACE_MS || 3000);

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
    // reset() drops idle connections but keeps the pool and its idle reaper
    // alive; closeAll() is for final shutdown and stops the reaper for good.
    // The fallback only covers a core that predates reset().
    if (typeof ctx.pool.reset === "function") await ctx.pool.reset();
    else await ctx.pool.closeAll();
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
  // - In the release binary (Node SEA; pkg before that), `process.execPath`
  //   IS the standalone binary and argv[1] is not a real script on disk
  //   (pkg used a virtual `/snapshot/...` path). The unit must invoke the
  //   binary directly with no script argument. We signal that by returning
  //   node = "".
  const argv1 = process.argv[1] || "";
  const exe = process.execPath || "node";
  const { isPackagedBinary } = require("./packaged");
  if (isPackagedBinary() || argv1.startsWith("/snapshot/")) return { node: "", script: exe };
  if (argv1 && fs.existsSync(argv1)) return { node: exe, script: argv1 };
  return { node: exe, script: "mail-use" };
}

function _autostartPaths(platform = process.platform) {
  if (platform === "darwin") {
    return {
      kind: "launchd",
      unitPath: path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      logPath: path.join(os.homedir(), "Library", "Logs", "mailbox-daemon.log"),
    };
  }
  if (platform === "linux") {
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
  // node === "" means the script IS the self-contained release binary.
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
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
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
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}


function _defaultExec(cmd, args) {
  const { execFileSync } = require("child_process");
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000 });
}

function _execError(e) {
  const stderr = e && e.stderr ? String(e.stderr).trim() : "";
  return stderr || (e && e.message) || String(e);
}

function _launchdDomain() {
  return `gui/${process.getuid ? process.getuid() : 0}`;
}

// The --sync-interval baked into an installed unit, or null. Rewriting the unit
// (re-install, upgrade) must keep what the user chose rather than snapping back
// to the default.
function _readInstalledSyncInterval(unitPath) {
  let body;
  try { body = fs.readFileSync(unitPath, "utf8"); } catch { return null; }
  // launchd: <string>--sync-interval</string> <string>600</string>
  // systemd: "--sync-interval" "600"
  const m = body.match(/--sync-interval(?:<\/string>\s*<string>|"?\s+"?)(\d+)/);
  return m ? Number(m[1]) : null;
}

function _isUnitInstalled(info) {
  return info.kind !== "unsupported" && Boolean(info.unitPath) && fs.existsSync(info.unitPath);
}

async function installAutostart({ syncIntervalSec, platform = process.platform, exec = _defaultExec } = {}) {
  const info = _autostartPaths(platform);
  if (info.kind === "unsupported") {
    return { success: false, error: `autostart not supported on platform ${platform}`, error_code: "unsupported" };
  }
  if (syncIntervalSec == null || !Number.isFinite(Number(syncIntervalSec))) {
    const existing = _readInstalledSyncInterval(info.unitPath);
    syncIntervalSec = existing != null ? existing : 300;
  }
  syncIntervalSec = Math.max(0, Number(syncIntervalSec));
  const { node, script } = _resolveCliExecutable();
  fs.mkdirSync(path.dirname(info.unitPath), { recursive: true });

  if (info.kind === "launchd") {
    fs.mkdirSync(path.dirname(info.logPath), { recursive: true });
    const body = _renderLaunchdPlist({ node, script, syncIntervalSec, logPath: info.logPath });
    fs.writeFileSync(info.unitPath, body, { mode: 0o644 });
    // Best-effort load. User may need to do it manually if SIP-locked.
    let activate = "";
    try {
      exec("launchctl", ["unload", info.unitPath]);
    } catch { /* not previously loaded — fine */ }
    try {
      exec("launchctl", ["load", "-w", info.unitPath]);
      activate = `launchctl loaded — daemon will start now and at every login. Logs: ${info.logPath}`;
    } catch {
      activate = `wrote plist; load it manually: launchctl load -w ${info.unitPath}`;
    }
    return { success: true, unit_path: info.unitPath, log_path: info.logPath, exe: (node ? `${node} ${script}` : script), sync_interval_sec: syncIntervalSec, activate_hint: activate };
  }

  if (info.kind === "systemd") {
    const body = _renderSystemdUnit({ node, script, syncIntervalSec });
    fs.writeFileSync(info.unitPath, body, { mode: 0o644 });
    let activate = `systemctl --user daemon-reload && systemctl --user enable ${SYSTEMD_UNIT} && systemctl --user restart ${SYSTEMD_UNIT}`;
    try {
      exec("systemctl", ["--user", "daemon-reload"]);
      exec("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
      // restart, not `enable --now`: --now is a no-op for a unit that is already
      // running, which would leave the old ExecStart (old interval, old binary)
      // serving until the next login.
      exec("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
      activate = `systemd unit enabled and started`;
    } catch { /* leave activate as the manual instruction */ }
    return { success: true, unit_path: info.unitPath, exe: (node ? `${node} ${script}` : script), sync_interval_sec: syncIntervalSec, activate_hint: activate };
  }

  return { success: false, error: "unknown autostart kind", error_code: "operation_failed" };
}

async function uninstallAutostart({ platform = process.platform, exec = _defaultExec } = {}) {
  const info = _autostartPaths(platform);
  if (info.kind === "unsupported") {
    return { success: false, error: `autostart not supported on platform ${platform}`, error_code: "unsupported" };
  }
  if (!fs.existsSync(info.unitPath)) {
    return { success: true, unit_path: "" };
  }
  if (info.kind === "launchd") {
    try { exec("launchctl", ["unload", info.unitPath]); } catch { /* ignore */ }
  } else if (info.kind === "systemd") {
    try { exec("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(info.unitPath); } catch { /* ignore */ }
  return { success: true, unit_path: info.unitPath };
}

function _defaultPing() {
  const { daemonAdmin } = require("./daemon_admin");
  return daemonAdmin("__ping", { timeoutMs: 1500 });
}

function _defaultShutdown() {
  const { daemonAdmin } = require("./daemon_admin");
  return daemonAdmin("__shutdown");
}

const _sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Restart the running daemon so it picks up a replaced binary.
//
// When launchd/systemd owns the daemon, ask *them* to restart it: a plain
// __shutdown would either be undone by the supervisor at an unpredictable
// moment or (with on-failure policies) not be undone at all. When the daemon
// was started by hand there is no supervisor to bring it back, so we stop it
// and say so — silently installing a LaunchAgent the user never asked for is
// not a restart.
//
// Success is judged by the pid changing, not by the command's exit status: a
// restart that leaves the old process answering has not happened.
async function restartDaemon({
  platform = process.platform,
  exec = _defaultExec,
  ping = _defaultPing,
  shutdown = _defaultShutdown,
  timeoutMs = 15_000,
  pollMs = 300,
} = {}) {
  const info = _autostartPaths(platform);
  const before = await ping();
  const oldPid = before && before.success ? before.pid : null;
  const out = { success: false, was_running: Boolean(oldPid), restarted: false, method: "", old_pid: oldPid, new_pid: null };

  if (!_isUnitInstalled(info)) {
    if (!oldPid) return { ...out, success: true, method: "none" };
    const r = await shutdown();
    return {
      ...out,
      success: Boolean(r && r.success),
      method: "shutdown",
      error: r && r.success ? undefined : (r && r.error) || "shutdown failed",
      hint: "the daemon was started by hand, not by launchd/systemd, so nothing restarts it — run: mail-use daemon start",
    };
  }

  try {
    if (info.kind === "launchd") {
      out.method = "launchctl kickstart";
      try {
        exec("launchctl", ["kickstart", "-k", `${_launchdDomain()}/${LAUNCHD_LABEL}`]);
      } catch {
        // Installed but not loaded (e.g. after `daemon stop`): load it.
        out.method = "launchctl bootstrap";
        exec("launchctl", ["bootstrap", _launchdDomain(), info.unitPath]);
      }
    } else {
      out.method = "systemctl restart";
      exec("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    }
  } catch (e) {
    return { ...out, error: `${out.method} failed: ${_execError(e)}`, error_code: "operation_failed" };
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await ping();
    if (r && r.success && r.pid && r.pid !== oldPid) {
      return { ...out, success: true, restarted: true, new_pid: r.pid };
    }
    if (Date.now() >= deadline) {
      const still = r && r.success ? r.pid : null;
      return {
        ...out,
        new_pid: still,
        error: still && still === oldPid
          ? `daemon pid ${oldPid} is still the one answering after ${out.method}`
          : `daemon did not come back within ${Math.round(timeoutMs / 1000)}s after ${out.method}`,
        error_code: "operation_failed",
      };
    }
    await _sleep(pollMs);
  }
}

// Stop the daemon and keep it stopped.
//
// Under launchd/systemd a bare __shutdown is not a stop: the supervisor
// relaunches it (KeepAlive / Restart=). So when a unit is installed, stop it
// through the supervisor; any daemon still answering after that was started
// by hand and gets __shutdown.
async function stopDaemon({
  platform = process.platform,
  exec = _defaultExec,
  ping = _defaultPing,
  shutdown = _defaultShutdown,
} = {}) {
  const info = _autostartPaths(platform);
  const before = await ping();
  const wasRunning = Boolean(before && before.success);
  let method = "";
  let hint;

  if (_isUnitInstalled(info)) {
    try {
      if (info.kind === "launchd") {
        exec("launchctl", ["bootout", `${_launchdDomain()}/${LAUNCHD_LABEL}`]);
        method = "launchctl bootout";
        hint = "unloaded until next login; start it again with: mail-use daemon install";
      } else {
        exec("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
        method = "systemctl stop";
        hint = `stopped until next login; start it again with: systemctl --user start ${SYSTEMD_UNIT}`;
      }
    } catch {
      // Not loaded / not active — fine, fall through to a direct shutdown.
    }
  }

  const after = method ? await ping() : before;
  if (after && after.success) {
    const r = await shutdown();
    if (!r || !r.success) return r || { success: false, error: "shutdown failed", error_code: "operation_failed" };
    method = method ? `${method} + shutdown` : "shutdown";
  } else if (!method) {
    // Nothing supervised it and nothing answered.
    return before && !before.success ? before : { success: false, error: "daemon is not running", error_code: "not_running" };
  }

  return { success: true, stopped: true, was_running: wasRunning, pid: wasRunning ? before.pid : null, method, ...(hint ? { hint } : {}) };
}

module.exports = {
  startDaemon, getSocketPath, getPidFilePath,
  installAutostart, uninstallAutostart, restartDaemon, stopDaemon,
  // Exported for tests: the update check must stay disableable and unref'd.
  _updateCheckIntervalMs, _startUpdateChecks,
  _renderLaunchdPlist, _renderSystemdUnit, _readInstalledSyncInterval, _autostartPaths,
};
