const { email } = require("@mail-use/core");

function _iso() {
  return new Date().toISOString();
}

async function run({ limit = 15, folder = "INBOX", unread_only = false, account_id = "" } = {}) {
  const list = await email.listEmails({
    limit: Number(limit || 15),
    offset: 0,
    unread_only: Boolean(unread_only),
    folder,
    account_id,
    use_cache: false,
  });
  if (!list.success) return list;

  const emails = list.emails || [];
  const actions = {
    delete_spam: [],
    delete_marketing: [],
    mark_as_read: [],
    needs_attention: [],
  };

  for (const e of emails) {
    const subj = String(e.subject || "").toLowerCase();
    if (subj.includes("unsubscribe") || subj.includes("marketing")) actions.delete_marketing.push(e.id);
    else if (subj.includes("spam")) actions.delete_spam.push(e.id);
    else if (e.unread) actions.needs_attention.push(e.id);
    else actions.mark_as_read.push(e.id);
  }

  const stats = {
    total_emails: emails.length,
    delete_spam: actions.delete_spam.length,
    delete_marketing: actions.delete_marketing.length,
    mark_as_read: actions.mark_as_read.length,
    needs_attention: actions.needs_attention.length,
  };

  return {
    success: true,
    processed: emails.length,
    actions,
    important_summaries: [],
    summary_text: `Processed ${emails.length} emails.`,
    stats,
    generated_at: _iso(),
  };
}

module.exports = {
  run,
};
