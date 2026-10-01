// sync status / force / init / health / watch / daemon

const { createStopSignal } = require("../cli/stop_signal");

function register(program, ctx) {
  const { sync } = ctx.proxies;
  const syncCmd = program.command("sync").description("Local sync/cache operations");
  syncCmd
    .command("status")
    .description("Show scheduler status")
    .action(async () => {
      const result = await sync.status();
      ctx.respond(result, "sync status");
    });
  syncCmd
    .command("force")
    .description("Force sync now")
    .option("--account-id <id>")
    .option("--full")
    .action(async (opts) => {
      const result = await sync.force({ account_id: opts.accountId || "", full: Boolean(opts.full) });
      ctx.respond(result, "sync force");
    });
  syncCmd
    .command("init")
    .description("Initialize database and run initial sync")
    .action(async () => {
      const result = await sync.init();
      ctx.respond(result, "sync init");
    });
  syncCmd
    .command("health")
    .description("Show sync health summary")
    .action(async () => {
      const result = await sync.health();
      ctx.respond(result, "sync health");
    });

  syncCmd
    .command("watch")
    .description("Continuously print sync status")
    .option("--interval <seconds>", "Refresh interval", "5")
    .action(async (opts) => {
      const { printJson } = require("@mail-use/shared").json;
      const intervalSec = Math.max(0.5, Number(opts.interval || 5));
      const stop = createStopSignal();
      try {
        while (!stop.stopped()) {
          const status = await sync.status();
          status.success = true;
          printJson(status, Boolean(ctx.pretty) || !ctx.asJson);
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch (e) {
        if (e && e.name === "AbortError") return process.exit(0);
        return process.exit(0);
      }
    });

  syncCmd
    .command("daemon")
    .description("Run periodic sync in the foreground")
    .option("--interval <seconds>", "Sync interval", "300")
    .option("--account-id <id>")
    .option("--full")
    .action(async (opts) => {
      const intervalSec = Math.max(5, Number(opts.interval || 300));
      const stop = createStopSignal();
      try {
        while (!stop.stopped()) {
          await sync.force({ account_id: opts.accountId || "", full: Boolean(opts.full) });
          if (stop.stopped()) break;
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch {
        return process.exit(0);
      }
    });
}

module.exports = { register };
