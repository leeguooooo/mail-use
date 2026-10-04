// Cleanup workflow: classify recent emails and propose / apply a deletion plan.
//
//   plan(args)  -> read-only. Buckets emails into categories and lists the
//                  marketing / routine_notification candidates. Never deletes.
//   apply(args) -> plan + delete the candidate categories via core deleteEmails,
//                  grouped per (account, folder). DESTRUCTIVE; --confirm only.
//
// Protected categories (finance / travel / security / support /
// action_required) are never proposed for deletion. Only the newest `limit`
// emails (default 200) are scanned; the plan reports scan_limit / truncated.

const { email } = require("@mail-use/core");
const { classify, PROTECTED, CLEANUP } = require("./classify");

function _iso() {
  return new Date().toISOString();
}

function _record(e) {
  return {
    id: String(e.id || e.uid || ""),
    gid: e.gid || "",
    account_id: e.account_id || "",
    folder: e.folder || "INBOX",
    from: e.from || "",
    subject: e.subject || "",
    date: e.date || "",
    unread: Boolean(e.unread),
  };
}

// NOTE: list rows do not carry the List-Unsubscribe header (only show does), so
// marketing detection here relies on sender/subject heuristics. classify() still
// honors list_unsubscribe when present (e.g. when classifying show output).
async function plan({ account_id = "", folder = "INBOX", limit = 200, unread_only = false } = {}) {
  const list = await email.listEmails({
    limit: Number(limit || 200),
    offset: 0,
    folder,
    account_id,
    unread_only: Boolean(unread_only),
    use_cache: false,
  });
  if (!list.success) return list;

  const emails = list.emails || [];
  const by_category = {};
  const candidates_by_category = {};
  const protectedItems = {};

  for (const e of emails) {
    const cat = classify(e);
    by_category[cat] = (by_category[cat] || 0) + 1;
    if (CLEANUP.has(cat)) {
      (candidates_by_category[cat] = candidates_by_category[cat] || []).push(_record(e));
    } else if (PROTECTED.has(cat)) {
      (protectedItems[cat] = protectedItems[cat] || []).push(_record(e));
    }
  }

  const protectedCounts = {};
  for (const [k, v] of Object.entries(protectedItems)) protectedCounts[k] = v.length;
  const candidate_count = Object.values(candidates_by_category).reduce((s, a) => s + a.length, 0);

  // Only the newest `limit` emails are classified. Say so when the folder
  // holds more, instead of letting `scanned` read like "the whole folder".
  const scanLimit = Number(limit || 200);
  const total = Number.isFinite(Number(list.total_in_folder)) ? Number(list.total_in_folder) : null;
  // An unread-only scan is bounded by the unread count, not the folder size:
  // read mail would otherwise flag a scan that classified every unread email.
  const unreadTotal = !list.unread_count_unavailable && list.unread_count != null && Number.isFinite(Number(list.unread_count))
    ? Number(list.unread_count)
    : null;
  const scopeTotal = unread_only ? unreadTotal : total;
  const truncated = emails.length >= scanLimit && (scopeTotal == null || scopeTotal > emails.length);

  return {
    success: true,
    plan_only: true,
    scanned: emails.length,
    scan_limit: scanLimit,
    ...(total != null ? { total_in_folder: total } : {}),
    truncated,
    ...(truncated
      ? { scan_note: `Classified only the newest ${emails.length}${scopeTotal != null ? ` of ${scopeTotal}${unread_only ? " unread" : ""}` : ""} emails (scan limit ${scanLimit}); pass --limit (MCP: limit) to scan more.` }
      : {}),
    folder,
    account_id,
    by_category,
    candidates_by_category,
    candidate_count,
    protected_counts: protectedCounts,
    protected_total: Object.values(protectedCounts).reduce((s, n) => s + n, 0),
    generated_at: _iso(),
  };
}

async function apply({
  account_id = "",
  folder = "INBOX",
  limit = 200,
  unread_only = false,
  permanent = false,
  trash_folder = "Trash",
  categories,
} = {}) {
  const p = await plan({ account_id, folder, limit, unread_only });
  if (!p.success) return p;

  const targetCats = (Array.isArray(categories) && categories.length ? categories : [...CLEANUP]).filter((c) =>
    CLEANUP.has(c)
  );

  // Group candidate ids by (account, folder) so each mailbox is mutated with
  // its own folder, reusing the core deleteEmails path (cache-consistent).
  const groups = new Map();
  for (const cat of targetCats) {
    for (const rec of p.candidates_by_category[cat] || []) {
      const key = `${rec.account_id} ${rec.folder}`;
      if (!groups.has(key)) groups.set(key, { accountId: rec.account_id, folder: rec.folder, uids: [] });
      groups.get(key).uids.push(String(rec.id));
    }
  }

  const results = [];
  for (const g of groups.values()) {
    const r = await email.deleteEmails({
      email_ids: g.uids,
      folder: g.folder,
      permanent: Boolean(permanent),
      trash_folder,
      account_id: g.accountId,
      dry_run: false,
    });
    results.push({ account_id: g.accountId, folder: g.folder, ...r });
  }

  const deleted_count = results.reduce((s, r) => s + Number(r.deleted_count || 0), 0);
  return {
    success: results.every((r) => r && r.success),
    applied: true,
    categories: targetCats,
    deleted_count,
    plan: {
      scanned: p.scanned,
      scan_limit: p.scan_limit,
      ...(p.total_in_folder != null ? { total_in_folder: p.total_in_folder } : {}),
      truncated: p.truncated,
      ...(p.scan_note ? { scan_note: p.scan_note } : {}),
      by_category: p.by_category,
      candidate_count: p.candidate_count,
      protected_counts: p.protected_counts,
    },
    results,
    generated_at: _iso(),
  };
}

module.exports = { plan, apply };
