// Email target handling shared by the CLI (main.js / commands) and the MCP
// server: gid parsing, ref resolution, folder grouping, dry-run previews and
// the per-folder / per-account mutation loops.
//
// Core calls go through an `email` proxy passed in by the caller, so this
// module stays free of @mail-use/core (and the CLI's `./proxies` seam that the
// tests patch keeps working).

const CONFIRM_HINT = "Re-run with --confirm to apply changes";

// Parse a global email ref. Accepts a 3-part gid "account_id:folder:uid"
// (folder may itself contain ':'), a legacy "account_id:uid", or a bare uid.
// account_id / folder are "" when the ref does not encode them; callers fall
// back to an explicit account id / folder.
function parseEmailRef(raw) {
  const s = String(raw || "").trim();
  if (!s) return { id: "", account_id: "", folder: "" };
  const parts = s.split(":");
  if (parts.length >= 3 && parts[0] && /^\d+$/.test(parts[parts.length - 1])) {
    return { id: parts[parts.length - 1], account_id: parts[0], folder: parts.slice(1, -1).join(":") };
  }
  const idx = s.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) {
    return { id: s.slice(idx + 1), account_id: s.slice(0, idx), folder: "" };
  }
  return { id: s, account_id: "", folder: "" };
}

// CLI id arguments may be space/comma separated inside one argv token.
function splitIdArgs(rawIds) {
  const arr = Array.isArray(rawIds) ? rawIds : [rawIds];
  return arr.flatMap((id) => String(id).split(/[\s,]+/).filter(Boolean));
}

// A bare uid next to gids from several accounts has no account to belong to.
function mixedAccountError(accountIds, accountParam = "--account-id", bareIds = []) {
  return `Mixed account_ids in gids (${accountIds.join(", ")}) but bare uid(s) ${bareIds.join(", ")} carry no account; ` +
    `use full gids (account_id:folder:uid) or pass ${accountParam} with ids of that one account`;
}

function accountMismatchError(explicit, gidAccounts, accountParam = "--account-id") {
  return `Account mismatch: ${accountParam} ${explicit} conflicts with gid account(s) ${gidAccounts.join(", ")}; ` +
    `drop ${accountParam} (gids are self-describing) or fix the ids`;
}

const _sameId = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// Resolve input refs (gids or bare uids) plus an explicit account id to
// { ids, accountId, accountIds, mixed, refs: [{id, folder, account_id}] }.
//
// Gids are self-describing, so gids naming several accounts are fine: the
// result has `mixed: true`, `accountId: ""`, and every ref carries its own
// account_id — callers group by account (groupRefsByAccount). Only a bare uid
// next to multi-account gids is ambiguous (error_code "ambiguous_account").
//
// An explicit account id applies to bare uids; a gid naming a different
// account is an error (error_code "account_mismatch"). That check is textual
// (case-insensitive). When the explicit value is an email address it may name
// the gid's account, so the result carries `conflicts` instead and
// confirmAccountConflicts() settles it — resolveEmailRefsChecked() does both.
//
// opts.split: split CLI-style "1,2 3" tokens (MCP passes a real array).
// opts.accountParam: how the override is spelled in the error message.
function resolveEmailRefs(rawIds, explicitAccountId, { split = true, accountParam = "--account-id" } = {}) {
  const flat = split ? splitIdArgs(rawIds) : (Array.isArray(rawIds) ? rawIds : [rawIds]);
  const parsed = flat.map(parseEmailRef);
  const explicit = String(explicitAccountId || "").trim();
  const accountIds = [...new Set(parsed.map((r) => r.account_id).filter(Boolean))];

  if (explicit) {
    const out = {
      ids: parsed.map((r) => r.id),
      accountId: explicit,
      accountIds: [explicit],
      mixed: false,
      refs: parsed.map((r) => ({ id: r.id, folder: r.folder || "", account_id: explicit })),
    };
    const conflicts = accountIds.filter((a) => !_sameId(a, explicit));
    if (!conflicts.length) return out;
    if (explicit.includes("@")) return { ...out, conflicts, accountParam };
    return { ids: [], accountId: "", refs: [], error: accountMismatchError(explicit, conflicts, accountParam), error_code: "account_mismatch" };
  }

  if (accountIds.length > 1) {
    const bare = parsed.filter((r) => !r.account_id).map((r) => r.id);
    if (bare.length) {
      return { ids: [], accountId: "", refs: [], error: mixedAccountError(accountIds, accountParam, bare), error_code: "ambiguous_account" };
    }
  }
  const single = accountIds.length === 1 ? accountIds[0] : "";
  return {
    ids: parsed.map((r) => r.id),
    accountId: single,
    accountIds,
    mixed: accountIds.length > 1,
    refs: parsed.map((r) => ({ id: r.id, folder: r.folder || "", account_id: r.account_id || single })),
  };
}

// Settle the `conflicts` resolveEmailRefs leaves when the explicit account is
// an email address: a gid account that is the same account is fine, anything
// else is account_mismatch. accountsApi is core's accounts namespace (or its
// proxy).
async function confirmAccountConflicts(accountsApi, r) {
  if (!r || r.error || !r.conflicts) return r;
  const { conflicts, accountParam, ...rest } = r;
  let canonical = "";
  try {
    const acc = accountsApi ? await accountsApi.getAccountByIdOrEmail(r.accountId) : null;
    canonical = acc && acc.success && acc.account ? acc.account.id : "";
  } catch {
    canonical = "";
  }
  const real = conflicts.filter((a) => !_sameId(a, canonical));
  if (real.length) {
    return { ids: [], accountId: "", refs: [], error: accountMismatchError(r.accountId, real, accountParam), error_code: "account_mismatch" };
  }
  return rest;
}

async function resolveEmailRefsChecked(accountsApi, rawIds, explicitAccountId, opts) {
  return confirmAccountConflicts(accountsApi, resolveEmailRefs(rawIds, explicitAccountId, opts));
}

// Group refs by their account_id (insertion order); refs without one fall back
// to fallbackAccountId. Map<accountId, refs[]>.
function groupRefsByAccount(refs, fallbackAccountId = "") {
  const groups = new Map();
  for (const r of refs || []) {
    const acc = r.account_id || fallbackAccountId || "";
    if (!groups.has(acc)) groups.set(acc, []);
    groups.get(acc).push(r);
  }
  return groups;
}

// Run fn(accountId, refs) once per account and merge the per-account results.
// One account returns its result untouched (the pre-multi-account shape).
// Several are flattened into results[] entries stamped with account_id (a
// per-folder results[] inside an account result is flattened too). Sequential:
// these are mutations, and per-account order keeps logs readable.
async function mutateByAccount(byAccount, fn) {
  if (byAccount.size <= 1) {
    const [[accountId, refs] = ["", []]] = [...byAccount];
    return fn(accountId, refs);
  }
  const results = [];
  for (const [accountId, refs] of byAccount) {
    let r;
    try {
      r = await fn(accountId, refs);
    } catch (e) {
      r = { success: false, error: (e && e.message) || "operation failed" };
    }
    if (r && Array.isArray(r.results) && r.folders_count) {
      for (const sub of r.results) results.push({ account_id: accountId, ...sub });
    } else {
      results.push({ account_id: accountId, ...r });
    }
  }
  return {
    success: results.every((r) => r && r.success),
    accounts_count: byAccount.size,
    folders_count: results.length,
    results,
  };
}

// ---------- batch show across accounts ----------

// Put batch-show emails back in the order the refs were requested. Each ref
// claims the first unclaimed email with the same account, uid and (when the
// ref names one) folder; anything unmatched keeps its relative order at the end.
function orderShownEmails(refs, emails) {
  const pool = (emails || []).map((e, i) => ({ e, i, used: false }));
  const out = [];
  for (const r of refs || []) {
    const hit = pool.find((p) => !p.used
      && String(p.e.id) === String(r.id)
      && (!r.account_id || !p.e.account_id || _sameId(p.e.account_id, r.account_id))
      && (!r.folder || !p.e.folder || _sameId(p.e.folder, r.folder)));
    if (hit) {
      hit.used = true;
      out.push(hit.e);
    }
  }
  for (const p of pool) if (!p.used) out.push(p.e);
  return out;
}

// Batch show for refs that may span accounts and folders. One account: the
// core call's response, reordered to the requested order (top-level account_id
// kept). Several accounts: one call per account, in parallel, merged into
// { success, emails, failed_ids, requested, returned, account_ids } — no
// top-level account_id; each email and failed id carries its own account_id.
// An account whose call fails outright degrades to failed_ids for its refs.
async function showRefs(email, { refs: rawRefs, accountId = "", explicitFolder = "", baseOpts = {} }) {
  // An explicit folder overrides every ref's own (gid) folder.
  const refs = explicitFolder ? rawRefs.map((r) => ({ ...r, folder: explicitFolder })) : rawRefs;
  const byAccount = groupRefsByAccount(refs, accountId);
  const showOne = (acc, accRefs) => (explicitFolder && byAccount.size === 1
    ? email.showEmails({ ...baseOpts, account_id: acc, email_ids: accRefs.map((r) => r.id), folder: explicitFolder })
    : email.showEmailsResolved({
      ...baseOpts,
      account_id: acc,
      refs: accRefs.map((r) => ({ id: r.id, folder: r.folder || "" })),
    }));

  if (byAccount.size <= 1) {
    const [[acc, accRefs]] = [...byAccount];
    const result = await showOne(acc, accRefs);
    if (result && Array.isArray(result.emails)) result.emails = orderShownEmails(accRefs, result.emails);
    return result;
  }

  const settled = await Promise.all([...byAccount].map(async ([acc, accRefs]) => {
    try {
      return { acc, accRefs, result: await showOne(acc, accRefs) };
    } catch (e) {
      return { acc, accRefs, result: { success: false, error: (e && e.message) || "fetch failed" } };
    }
  }));

  const emails = [];
  const failed_ids = [];
  for (const { acc, accRefs, result } of settled) {
    if (!result || !Array.isArray(result.emails)) {
      // Whole-account failure (unknown account, connection refused, ...).
      const error = (result && result.error) || "fetch failed";
      for (const r of accRefs) failed_ids.push({ id: r.id, account_id: acc, ...(r.folder ? { folder: r.folder } : {}), error });
      continue;
    }
    const realId = result.account_id || acc;
    for (const e of result.emails) emails.push({ ...e, account_id: e.account_id || realId });
    for (const f of result.failed_ids || []) failed_ids.push({ ...f, account_id: f.account_id || realId });
  }
  const ordered = orderShownEmails(refs, emails);
  return {
    success: failed_ids.length === 0,
    emails: ordered,
    failed_ids,
    requested: refs.length,
    returned: ordered.length,
    account_ids: [...byAccount.keys()],
  };
}

function emailIdArgs(rawIds) {
  return Array.isArray(rawIds) ? rawIds : [];
}

function hasEmailTargets(rawIds, opts) {
  const ids = emailIdArgs(rawIds).flatMap((id) => String(id).split(/[\s,]+/).filter(Boolean));
  return ids.length > 0 || Boolean(opts.from) || Boolean(opts.subject);
}

// ---------- folder grouping for explicit refs ----------

// Group ref ids by folder: each ref's own (gid) folder, else defaultFolder,
// else INBOX. Insertion order is preserved.
function groupRefsByFolder(refs, defaultFolder) {
  const groups = new Map();
  for (const r of refs) {
    const folder = r.folder || defaultFolder || "INBOX";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(r.id);
  }
  return groups;
}

// Like groupRefsByFolder, but an explicit folder overrides every ref and a ref
// without one is looked up in the cache (email.resolveEmailFolder → INBOX).
// UIDs are per-folder in IMAP, so mutating in the wrong folder hits the wrong
// message — this keeps 3-part gids self-describing for mutations too.
async function resolveFolderGroups(email, refs, accountId, explicitFolder) {
  const groups = new Map();
  for (const r of refs) {
    const folder = explicitFolder
      ? explicitFolder
      : await email.resolveEmailFolder({ account_id: accountId, uid: r.id, folder: r.folder });
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(r.id);
  }
  return groups;
}

// Apply mk(ids, folder) per folder group, sequentially, and merge. A single
// group returns its result directly (stamped with its folder); several are
// wrapped in a per-folder results[] list.
async function mutateByFolder(groups, mk) {
  const results = [];
  for (const [folder, ids] of groups) {
    results.push({ folder, ...(await mk(ids, folder)) });
  }
  if (results.length === 1) return results[0];
  return { success: results.every((r) => r && r.success), folders_count: results.length, results };
}

function _mutateCall(email, { operation, emailIds, folder, accountId, markAs, permanent, trashFolder, dryRun }) {
  return operation === "delete"
    ? email.deleteEmails({
      email_ids: emailIds,
      folder,
      permanent: Boolean(permanent),
      trash_folder: trashFolder,
      account_id: accountId,
      dry_run: dryRun,
    })
    : email.markEmails({
      email_ids: emailIds,
      mark_as: markAs,
      folder,
      account_id: accountId,
      dry_run: dryRun,
    });
}

// Mutate explicit id refs honoring each ref's gid folder. Bare uids fall back to
// defaultFolder so `--folder` keeps working.
// Gids from several accounts are grouped per account first (mutateByAccount).
function applyIdRefMutation(email, { operation, refs, accountId, defaultFolder, markAs, opts, dryRun }) {
  return mutateByAccount(groupRefsByAccount(refs, accountId), (acc, accRefs) => mutateByFolder(
    groupRefsByFolder(accRefs, defaultFolder),
    (emailIds, folder) => _mutateCall(email, {
      operation,
      emailIds,
      folder,
      accountId: acc,
      markAs,
      permanent: opts.permanent,
      trashFolder: opts.trashFolder,
      dryRun,
    }),
  ));
}

// ---------- filter (--from/--subject) targets ----------

function targetSample(emails) {
  return (emails || []).slice(0, 5).map((e) => ({
    uid: String(e.uid || e.id || ""),
    subject: e.subject || "",
    from: e.from || "",
  }));
}

// Group targets by (account_id, folder) so a cross-account / cross-folder filter
// mutates each mailbox with its own folder. Each group also keeps a small subject
// sample for the dry-run preview.
function groupTargets(emails, fallbackAccountId, fallbackFolder) {
  const groups = new Map();
  for (const e of emails || []) {
    const uid = String(e.uid || e.id || "").trim();
    if (!uid) continue;
    const accountId = String(e.account_id || fallbackAccountId || "");
    const folder = String(e.folder || fallbackFolder || "INBOX");
    const key = `${accountId} ${folder}`;
    if (!groups.has(key)) groups.set(key, { accountId, folder, uids: [], sample: [] });
    const g = groups.get(key);
    g.uids.push(uid);
    if (g.sample.length < 3) g.sample.push(e.subject || "");
  }
  return groups;
}

function groupsBreakdown(groups) {
  return [...groups.values()].map((g) => ({
    account_id: g.accountId,
    folder: g.folder,
    count: g.uids.length,
    sample: g.sample.slice(0, 3),
  }));
}

function filteredDryRunResult({ operation, targets, groups, markAs, permanent, skipped }) {
  const out = {
    success: true,
    dry_run: true,
    would_target_count: targets.length,
    would_target_sample: targetSample(targets),
    groups: groupsBreakdown(groups),
    confirmation_required: true,
    confirmation_hint: CONFIRM_HINT,
  };
  if (skipped && skipped.length) {
    out.skipped_special_folders = skipped;
    out.skipped_note = `Skipped special folders ${skipped.join(", ")} (pass --include-special to include them)`;
  }
  if (operation === "delete") {
    out.would_delete = targets.length;
    out.permanent = Boolean(permanent);
    out.message = `Dry run: would ${permanent ? "delete" : "move to trash"} ${targets.length} emails`;
  } else {
    out.would_mark = targets.length;
    out.mark_as = markAs;
    out.message = `Dry run: would mark ${targets.length} emails as ${markAs}`;
  }
  return out;
}

// Special-use folders that a bulk --from/--subject filter should not delete from
// by default (your own Sent/Drafts, already-Trashed, Spam). Matched on the last
// path segment, case-insensitive.
const SPECIAL_MUTATION_FOLDER_RE = /^(sent|sent items|drafts?|junk|spam|trash|deleted|deleted items|bin|outbox)$/i;
function isSpecialMutationFolder(name) {
  const seg = String(name || "").split("/").pop().trim();
  return SPECIAL_MUTATION_FOLDER_RE.test(seg);
}

async function searchFilteredEmailTargets(email, opts) {
  // --all-folders searches every selectable folder; otherwise the named folder.
  const searchFolder = opts.allFolders ? "all" : opts.folder;
  const result = await email.searchEmails({
    from: opts.from,
    subject: opts.subject,
    account_id: opts.accountId,
    unread_only: opts.unreadOnly,
    folder: searchFolder,
    limit: 1000,
    timeout_ms: 60000, // bound cross-folder filter scans so a mutation can't hang forever
  });
  if (!result || !result.success) return { result, targets: [], groups: new Map(), skipped_special_folders: [] };
  let targets = (result.emails || []).filter((e) => String(e.uid || e.id || "").trim());

  // Safety: when scanning all folders for a bulk mutation, skip special-use
  // folders (Sent/Drafts/Junk/Trash) unless the user opts in with --include-special.
  const skipped = new Set();
  if (opts.allFolders && !opts.includeSpecial) {
    targets = targets.filter((e) => {
      if (isSpecialMutationFolder(e.folder)) {
        skipped.add(e.folder);
        return false;
      }
      return true;
    });
  }

  return {
    result,
    targets,
    groups: groupTargets(targets, opts.accountId, opts.allFolders ? "" : opts.folder),
    skipped_special_folders: [...skipped],
  };
}

async function applyFilteredEmailMutation(email, { operation, opts, targets, groups, markAs, skipped }) {
  if (Boolean(opts.dryRun) || !opts.confirm) {
    return filteredDryRunResult({
      operation,
      targets,
      groups,
      markAs,
      permanent: Boolean(opts.permanent),
      skipped,
    });
  }

  const results = [];
  for (const g of groups.values()) {
    const result = await _mutateCall(email, {
      operation,
      emailIds: g.uids,
      folder: g.folder,
      accountId: g.accountId,
      markAs,
      permanent: opts.permanent,
      trashFolder: opts.trashFolder,
      dryRun: false,
    });
    results.push({ account_id: g.accountId, folder: g.folder, ...result });
  }

  const skippedFields = skipped && skipped.length ? { skipped_special_folders: skipped } : {};
  if (results.length === 1) return { ...results[0], ...skippedFields };
  return {
    success: results.every((r) => r && r.success),
    matched_count: targets.length,
    accounts_count: new Set([...groups.values()].map((g) => g.accountId)).size,
    groups: groupsBreakdown(groups),
    results,
    ...skippedFields,
  };
}

module.exports = {
  CONFIRM_HINT,
  parseEmailRef,
  splitIdArgs,
  mixedAccountError,
  accountMismatchError,
  resolveEmailRefs,
  confirmAccountConflicts,
  resolveEmailRefsChecked,
  groupRefsByAccount,
  mutateByAccount,
  orderShownEmails,
  showRefs,
  emailIdArgs,
  hasEmailTargets,
  groupRefsByFolder,
  resolveFolderGroups,
  mutateByFolder,
  applyIdRefMutation,
  targetSample,
  groupTargets,
  groupsBreakdown,
  filteredDryRunResult,
  isSpecialMutationFolder,
  searchFilteredEmailTargets,
  applyFilteredEmailMutation,
};
