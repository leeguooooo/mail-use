// daemon start / install / uninstall / status / stop / reload
//
// ../daemon (which loads @mail-use/core) is required inside the actions that
// need it; status and reload only talk to the socket through ../daemon_admin.

const { _out } = require("../cli/render");

// One status line per account that has synced at all: its last error (with the
// last success, if any), or just its last success.
function _syncAccountLines(accounts) {
  const lines = [];
  for (const [id, a] of Object.entries(accounts || {})) {
    if (a && a.last_error) lines.push(`  ${id}: last_error=${a.last_error} (at ${a.last_error_at})${a.last_ok_at ? ` last_ok_at=${a.last_ok_at}` : ""}\n`);
    else if (a && a.last_ok_at) lines.push(`  ${id}: last_ok_at=${a.last_ok_at}\n`);
  }
  return lines;
}

function register(program, ctx) {
  const daemonCmd = program.command("daemon").description("Persistent IMAP daemon (reuses connections across CLI calls)");
  daemonCmd
    .command("start")
    .description("Start the daemon in the foreground (run with nohup/launchd/systemd to detach)")
    .option("--sync-interval <seconds>", "Run a background sync this often (0 disables)", "300")
    .option("--sync-account-id <id>", "Restrict background sync to one account")
    .action(async (opts) => {
      const { startDaemon } = require("../daemon");
      try {
        const syncIntervalSec = Math.max(0, Number(opts.syncInterval || 0));
        await startDaemon({
          foreground: true,
          syncIntervalMs: syncIntervalSec * 1000,
          syncAccountId: opts.syncAccountId || "",
        });
        // Block forever until SIGINT/SIGTERM
        await new Promise(() => {});
      } catch (e) {
        // Another daemon already serves the socket: the goal ("a daemon is
        // running") is met, so exit 0. A non-zero exit here is what made
        // launchd/systemd respawn this process in a tight loop.
        if (e && e.code === "EADDRINUSE") {
          const result = { success: true, already_running: true, message: (e && e.message) || "daemon already running" };
          return ctx.respond(result, () => process.stderr.write(result.message + "\n"));
        }
        const result = { success: false, error: (e && e.message) || "daemon failed", error_code: "operation_failed" };
        ctx.respond(result, () => process.stderr.write(result.error + "\n"));
      }
    });
  daemonCmd
    .command("install")
    .description("Install a launchd LaunchAgent (macOS) or systemd user unit (Linux) to autostart the daemon at login")
    .option("--sync-interval <seconds>", "Background sync interval (default: keep the installed unit's, else 300)")
    .action(async (opts) => {
      const { installAutostart } = require("../daemon");
      const result = await installAutostart({ syncIntervalSec: opts.syncInterval != null ? Number(opts.syncInterval) : undefined });
      ctx.respond(result, (r) => {
        if (r.success) _out(`installed: ${r.unit_path}\n  next: ${r.activate_hint || "(start it now with: mail-use daemon start)"}\n`);
        else process.stderr.write((r.error || "install failed") + "\n");
      });
    });
  daemonCmd
    .command("uninstall")
    .description("Remove the autostart unit and stop the daemon")
    .action(async () => {
      const { uninstallAutostart } = require("../daemon");
      const result = await uninstallAutostart();
      ctx.respond(result, (r) => {
        if (r.success) _out(`uninstalled: ${r.unit_path || "(no unit found)"}\n`);
        else process.stderr.write((r.error || "uninstall failed") + "\n");
      });
    });
  daemonCmd
    .command("status")
    .description("Probe the daemon and report version + pool stats")
    .action(async () => {
      let result = await require("../daemon_admin").daemonAdmin("__ping");
      if (!result.success) {
        // The socket did not answer; the pid file tells "not running" apart
        // from "running but wedged", and a stale one is cleaned up.
        const { readDaemonPid } = require("../daemon_paths");
        const pf = readDaemonPid();
        if (pf && pf.alive) {
          result = { ...result, pid: pf.pid, error: `daemon process ${pf.pid} is alive but not answering (${result.error})`, error_code: "not_responding" };
        } else if (pf) {
          try { require("fs").unlinkSync(pf.path); } catch { /* ignore */ }
        }
      }
      ctx.respond(result, (r) => {
        if (!r.success) { process.stderr.write((r.error || "not running") + "\n"); return; }
        const upS = r.uptime_ms != null ? Math.round(r.uptime_ms / 1000) : "?";
        _out(`daemon pid=${r.pid} uptime=${upS}s\n`);
        _out("\npool:\n");
        if (!(r.pool || []).length) _out("  (no accounts connected yet — prewarm or first call will populate)\n");
        for (const p of r.pool || []) {
          const inUse = p.in_use != null ? `, ${p.in_use}/${p.clients} in use` : "";
          _out(`  ${p.account_id}: ${p.connected ? "connected" : "idle"}${inUse}\n`);
        }
        if (r.sync) {
          _out("\nsync:\n");
          _out(`  attempted=${r.sync.syncs_attempted} ok=${r.sync.syncs_ok} failed=${r.sync.syncs_failed}\n`);
          if (r.sync.last_sync_at) _out(`  last_sync_at=${r.sync.last_sync_at}\n`);
          if (r.sync.last_sync_error) _out(`  last_sync_error=${r.sync.last_sync_error}${r.sync.last_sync_error_at ? ` (at ${r.sync.last_sync_error_at})` : ""}\n`);
          for (const line of _syncAccountLines(r.sync.accounts)) _out(line);
          if (r.sync.prewarm) _out(`  prewarm=${r.sync.prewarm.completed}/${r.sync.prewarm.started} (${r.sync.prewarm.failed} failed)\n`);
        }
        if (r.update && r.update.update_available) {
          _out(`  update: ${r.update.current} -> ${r.update.latest} available (run: mail-use upgrade)\n`);
        }
      });
    });
  daemonCmd
    .command("stop")
    .description("Stop the daemon (through launchd/systemd when it is installed as a service, so it stays stopped)")
    .action(async () => {
      const { stopDaemon } = require("../daemon");
      const result = await stopDaemon();
      ctx.respond(result, (r) => {
        if (!r.success) { process.stderr.write((r.error || "stop failed") + "\n"); return; }
        _out(`daemon stopped (${r.method})\n`);
        if (r.hint) _out(`  ${r.hint}\n`);
      });
    });
  daemonCmd
    .command("reload")
    .description("Drop pooled IMAP connections (e.g. after editing auth.json)")
    .action(async () => {
      const result = await require("../daemon_admin").daemonAdmin("__reload");
      ctx.respond(result, (r) => {
        if (r.success) _out("daemon reloaded\n");
        else process.stderr.write((r.error || "reload failed") + "\n");
      });
    });
}

module.exports = { register, _syncAccountLines };
