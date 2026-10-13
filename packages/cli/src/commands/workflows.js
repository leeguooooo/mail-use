// cleanup / digest / monitor — the workflow commands built on top of core.

const { _validatePaging } = require("../cli/options");
const { createStopSignal } = require("../cli/stop_signal");

function registerCleanup(program, ctx) {
  const { cleanup } = ctx.proxies;
  program
    .command("cleanup")
    .description("Collect inbox emails for AI review; execute selected gids with email move/mark/flag/delete")
    .option("--account-id <id>", "Account id/email (omit to span all accounts)")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--limit <n>", "Emails per review page", "50")
    .option("--offset <n>", "Review page offset", "0")
    .option("--with-preview <n>", "Body preview characters (0 disables, max 2000; at most 50 emails per account)", "400")
    .option("--unread-only", "Only return unread emails")
    .option("--categories <list>", "Deprecated: category-based deletion is no longer supported")
    .option("--permanent", "Deprecated: use email delete with explicitly selected gids")
    .option("--trash-folder <name>", "Deprecated: use email delete with explicitly selected gids")
    .option("--confirm", "Deprecated: cleanup never executes actions")
    .option("--dry-run", "Return mail for review (cleanup is always read-only)")
    .action(async (opts) => {
      // Reject legacy deletion requests before fetching a mailbox.
      if ((opts.confirm && !opts.dryRun) || opts.categories != null || opts.permanent || opts.trashFolder != null) {
        return ctx.respond(await cleanup.apply(), "cleanup");
      }
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 50 });
      if (!paging.ok) return ctx.usage(paging.error);
      const preview = Number(opts.withPreview);
      if (!Number.isInteger(preview) || preview < 0 || preview > 2000) {
        return ctx.usage("--with-preview must be an integer between 0 and 2000");
      }
      return ctx.respond(await cleanup.plan({
        account_id: opts.accountId || "",
        folder: opts.folder,
        limit: paging.limit,
        offset: paging.offset,
        unread_only: Boolean(opts.unreadOnly),
        preview_chars: preview,
      }), "cleanup");
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
      // Same as `sync daemon`: a failed pass is logged, the loop keeps going.
      while (!stop.stopped()) {
        try {
          await digest.run({ dry_run: Boolean(opts.dryRun), debug_path: "" });
        } catch (e) {
          process.stderr.write(`mail-use: digest pass failed: ${(e && e.message) || e}\n`);
        }
        if (stop.stopped()) break;
        await stop.sleep(intervalSec * 1000);
      }
      return process.exit(0);
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
