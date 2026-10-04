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

function mixedAccountError(accountIds, accountParam = "--account-id") {
  return `Mixed account_ids in gids (${accountIds.join(", ")}); pass ${accountParam} explicitly`;
}

// Resolve input refs (gids or bare uids) plus an explicit account id to
// { ids, accountId, refs: [{id, folder}] }. When the gids name more than one
// account and no explicit account id is given, returns { error, error_code }
// instead ("ambiguous_account"), for the CLI and MCP alike.
//
// opts.split: split CLI-style "1,2 3" tokens (MCP passes a real array).
// opts.accountParam: how the override is spelled in the error message.
function resolveEmailRefs(rawIds, explicitAccountId, { split = true, accountParam = "--account-id" } = {}) {
  const flat = split ? splitIdArgs(rawIds) : (Array.isArray(rawIds) ? rawIds : [rawIds]);
  const refs = flat.map(parseEmailRef);
  let resolved = explicitAccountId || "";
  const fromGids = new Set(refs.map((r) => r.account_id).filter(Boolean));
  if (!resolved && fromGids.size === 1) resolved = [...fromGids][0];
  else if (!resolved && fromGids.size > 1) {
    return { ids: [], accountId: "", refs: [], error: mixedAccountError([...fromGids], accountParam), error_code: "ambiguous_account" };
  }
  return {
    ids: refs.map((r) => r.id),
    accountId: resolved,
    refs: refs.map((r) => ({ id: r.id, folder: r.folder || "" })),
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
function applyIdRefMutation(email, { operation, refs, accountId, defaultFolder, markAs, opts, dryRun }) {
  return mutateByFolder(groupRefsByFolder(refs, defaultFolder), (emailIds, folder) => _mutateCall(email, {
    operation,
    emailIds,
    folder,
    accountId,
    markAs,
    permanent: opts.permanent,
    trashFolder: opts.trashFolder,
    dryRun,
  }));
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
// Special-use roles (RFC 6154) that count as special regardless of the folder's
// (possibly localized) name, e.g. Gmail's "[Gmail]/已发邮件" is \Sent.
const SPECIAL_MUTATION_ROLES = new Set(["\\Sent", "\\Drafts", "\\Junk", "\\Trash"]);
function isSpecialMutationFolder(name, specialUse = "") {
  if (SPECIAL_MUTATION_ROLES.has(String(specialUse || ""))) return true;
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
    // Gmail label aliases (INBOX + Important + Starred) are still collapsed to
    // one target by search, so a message is not marked/trashed twice; genuine
    // copies on other servers stay separate so every copy is acted on.
    dedupe: false,
  });
  if (!result || !result.success) return { result, targets: [], groups: new Map(), skipped_special_folders: [] };
  let targets = (result.emails || []).filter((e) => String(e.uid || e.id || "").trim());

  // Safety: when scanning all folders for a bulk mutation, skip special-use
  // folders (Sent/Drafts/Junk/Trash) unless the user opts in with --include-special.
  const skipped = new Set();
  if (opts.allFolders && !opts.includeSpecial) {
    targets = targets.filter((e) => {
      if (isSpecialMutationFolder(e.folder, e.special_use)) {
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
  resolveEmailRefs,
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
