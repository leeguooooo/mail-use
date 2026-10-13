// Compatibility entry point for AI-driven inbox review. No keyword decisions.
const { plan } = require("./cleanup");

async function run(args = {}) {
  const result = await plan({ ...args, limit: args.limit ?? 15 });
  if (!result.success) return result;
  return {
    ...result,
    processed: result.scanned,
    actions: { delete_spam: [], delete_marketing: [], mark_as_read: [], needs_attention: [] },
    important_summaries: [],
    summary_text: `Returned ${result.scanned} emails for agent review. No actions selected.`,
    stats: { total_emails: result.scanned, delete_spam: 0, delete_marketing: 0, mark_as_read: 0, needs_attention: 0 },
  };
}

module.exports = { run };
