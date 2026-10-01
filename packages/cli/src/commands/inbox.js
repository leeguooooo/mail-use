// inbox — the inbox organizer workflow.

const { _out } = require("../cli/render");

function register(program, ctx) {
  const { inbox } = ctx.proxies;
  program
    .command("inbox")
    .description("Inbox organizer")
    .option("--limit <n>", "Analyze latest N emails", "15")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--unread-only")
    .option("--account-id <id>")
    .action(async (opts) => {
      const result = await inbox.run({
        limit: Number(opts.limit),
        folder: opts.folder,
        unread_only: Boolean(opts.unreadOnly),
        account_id: opts.accountId || "",
      });
      ctx.respond(result, (r) => {
        if (r && r.summary_text) _out(String(r.summary_text) + "\n");
        const stats = r && r.stats;
        if (stats) {
          _out(`spam: ${stats.delete_spam || 0}, marketing: ${stats.delete_marketing || 0}, mark_read: ${stats.mark_as_read || 0}, attention: ${stats.needs_attention || 0}\n`);
        }
      });
    });
}

module.exports = { register };
