// cleanup / digest / monitor — the workflow commands built on top of core.

const { _validatePaging } = require("../cli/options");
const { createStopSignal } = require("../cli/stop_signal");

function registerCleanup(program, ctx) {
  const { cleanup } = ctx.proxies;
  program
    .command("cleanup")
    .description("Classify emails and propose a deletion plan (default: plan only; --confirm to delete marketing/routine candidates)")
    .option("--account-id <id>", "Account id/email (omit to span all accounts)")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--limit <n>", "Scan limit", "200")
    .option("--unread-only", "Only classify unread emails")
    .option("--categories <list>", "Comma-separated categories to delete on --confirm", "marketing,routine_notification")
    .option("--permanent", "Permanently delete instead of moving to trash")
    .option("--trash-folder <name>", "Trash folder", "Trash")
    .option("--confirm", "Actually delete the candidate categories (default: plan only)")
    .option("--dry-run")
    .action(async (opts) => {
      const paging = _validatePaging(opts.limit, "0", { defaultLimit: 200 });
      if (!paging.ok) {
        return ctx.usage(paging.error);
      }
      const confirm = Boolean(opts.confirm) && !opts.dryRun;
      const base = {
        account_id: opts.accountId || "",
        folder: opts.folder,
        limit: paging.limit,
        unread_only: Boolean(opts.unreadOnly),
      };
      let result;
      if (!confirm) {
        result = await cleanup.plan(base);
        if (result && typeof result === "object" && result.success) {
          result.confirmation_required = true;
          result.confirmation_hint = "Re-run with --confirm to delete the candidate categories";
        }
      } else {
        const categories = String(opts.categories || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        result = await cleanup.apply({
          ...base,
          categories,
          permanent: Boolean(opts.permanent),
          trash_folder: opts.trashFolder,
        });
      }
      return ctx.respond(result, "cleanup");
    });
}

function registerDigest(program, ctx) {
  const { digest } = ctx.proxies;
  const digestCmd = program.command("digest").description("Daily digest workflows");
  digestCmd
    .command("run")
    .description("Run once (dry-run by default; --confirm to actually send notifications)")
    .option("--confirm", "Actually deliver notifications (default: dry-run)")
    .option("--dry-run")
    .option("--debug-path <path>")
    .action(async (opts) => {
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await digest.run({ dry_run: dryRun, debug_path: opts.debugPath || "" });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to actually deliver notifications";
      }
      ctx.respond(result, "digest run");
    });
  digestCmd
    .command("config")
    .description("Print current configuration")
    .action(async () => {
      const result = await digest.getConfig();
      ctx.respond(result, "digest config");
    });

  digestCmd
    .command("daemon")
    .description("Run digest periodically in the foreground")
    .option("--interval <seconds>", "Interval", "3600")
    .option("--dry-run")
    .action(async (opts) => {
      const intervalSec = Math.max(5, Number(opts.interval || 3600));
      const stop = createStopSignal();
      try {
        while (!stop.stopped()) {
          await digest.run({ dry_run: Boolean(opts.dryRun), debug_path: "" });
          if (stop.stopped()) break;
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch {
        return process.exit(0);
      }
    });
}

function registerMonitor(program, ctx) {
  const { monitor } = ctx.proxies;
  const monitorCmd = program.command("monitor").description("Email monitor workflows");
  monitorCmd
    .command("run")
    .description("Run one monitoring cycle")
    .action(async () => {
      const result = await monitor.run();
      ctx.respond(result, "monitor run");
    });
  monitorCmd
    .command("status")
    .description("Get monitoring status")
    .action(async () => {
      const result = await monitor.status();
      ctx.respond(result, "monitor status");
    });
  monitorCmd
    .command("config")
    .description("Print current configuration")
    .action(async () => {
      const result = await monitor.config();
      ctx.respond(result, "monitor config");
    });
  monitorCmd
    .command("test")
    .description("Test individual components")
    .argument("[component]", "fetch|notify|all", "all")
    .action(async (component) => {
      const result = await monitor.test({ component });
      ctx.respond(result, "monitor test");
    });
}

function register(program, ctx) {
  registerCleanup(program, ctx);
  registerDigest(program, ctx);
  registerMonitor(program, ctx);
}

module.exports = { register };
