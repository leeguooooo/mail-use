// inbox — read-only collection for the calling agent.

const { _out } = require("../cli/render");
const { _validatePaging } = require("../cli/options");

function register(program, ctx) {
  const { inbox } = ctx.proxies;
  program
    .command("inbox")
    .description("Collect inbox emails for AI review (read-only)")
    .option("--limit <n>", "Emails per review page", "15")
    .option("--offset <n>", "Review page offset", "0")
    .option("--with-preview <n>", "Body preview characters (0-2000)", "400")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--unread-only")
    .option("--account-id <id>")
    .action(async (opts) => {
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 15 });
      if (!paging.ok) return ctx.usage(paging.error);
      const preview = Number(opts.withPreview);
      if (!Number.isInteger(preview) || preview < 0 || preview > 2000) return ctx.usage("--with-preview must be an integer between 0 and 2000");
      const result = await inbox.run({
        limit: paging.limit,
        offset: paging.offset,
        preview_chars: preview,
        folder: opts.folder,
        unread_only: Boolean(opts.unreadOnly),
        account_id: opts.accountId || "",
      });
      ctx.respond(result, (r) => {
        if (r && r.summary_text) _out(String(r.summary_text) + "\n");
      });
    });
}

module.exports = { register };
