// Mail collection for the calling AI. Decisions and explicit gid selection
// belong to the agent; this workflow never classifies or mutates mail.
const { email } = require("@mail-use/core");

function selectionRequired() {
  return {
    success: false,
    error_code: "explicit_selection_required",
    error: "Cleanup no longer selects or deletes emails by category. Review cleanup.emails, read full messages with email show, then pass the selected gids to email move, mark, flag or delete.",
  };
}

async function plan({ account_id = "", folder = "INBOX", limit = 50, offset = 0, unread_only = false, preview_chars = 400 } = {}) {
  const list = await email.listEmails({
    limit,
    offset,
    folder,
    account_id,
    unread_only: Boolean(unread_only),
    preview_chars,
    use_cache: false,
  });
  if (!list.success) return list;

  const emails = list.emails || [];
  const scanLimit = Number(list.limit ?? limit);
  const pageOffset = Number(list.offset ?? offset);
  const total = list.total_in_folder != null && Number.isFinite(Number(list.total_in_folder))
    ? Number(list.total_in_folder) : null;
  const unreadTotal = !list.unread_count_unavailable && list.unread_count != null && Number.isFinite(Number(list.unread_count))
    ? Number(list.unread_count) : null;
  const scopeTotal = unread_only ? unreadTotal : total;
  const truncated = emails.length >= scanLimit && (scopeTotal == null || scopeTotal > pageOffset + emails.length);

  return {
    ...list,
    success: true,
    plan_only: true,
    decision_required: true,
    decision_by: "agent",
    emails,
    scanned: emails.length,
    scan_limit: scanLimit,
    offset: pageOffset,
    truncated,
    ...(truncated ? { scan_note: scanLimit === 0
      ? "No emails requested; use a positive limit to review the mailbox."
      : `Returned ${emails.length} emails at offset ${pageOffset}; use offset ${pageOffset + emails.length} to review the next page.` } : {}),
    folder,
    account_id,
    preview_count: emails.filter((e) => typeof e.preview === "string").length,
    next_step: "Judge relevance and actions from the email content and user intent. Read full messages with email show <gid...> when needed, then execute only explicitly selected gids with email move, mark, flag or delete.",
    // Retain old JSON fields as empty placeholders for existing consumers.
    // They are not classification results or an executable deletion plan.
    by_category: {},
    candidates_by_category: {},
    candidate_count: 0,
    protected_counts: {},
    protected_total: 0,
    generated_at: new Date().toISOString(),
  };
}

// Old daemon/API callers must fail before reading or mutating any mail.
async function apply() {
  return selectionRequired();
}

module.exports = { plan, apply, selectionRequired };
