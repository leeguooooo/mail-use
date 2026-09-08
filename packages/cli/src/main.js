const fs = require("fs");
const path = require("path");
const { Command } = require("commander");

const { contract } = require("@mail-use/shared");
const { makeProxies } = require("./core_client");
const { getCliVersion: _resolveCliVersion } = require("./cli_version");
// All calls into core/workflows go through these proxies. When a mailbox
// daemon is running, requests are forwarded over a Unix socket so we
// reuse pooled IMAP connections (1-3s saved per call). When no daemon
// is around, the proxy falls back transparently to in-process execution.
const { accounts, email, imap, smtp, sync, digest, monitor, inbox, cleanup } = makeProxies();

function _printTextNotImplemented(label) {
  // Goes to stderr so it never corrupts a JSON pipe consumer.
  process.stderr.write(`${label} (text mode) is not implemented yet. Use --json.\n`);
}

// --extract-code: scan subject+body for verification/OTP codes and stamp a
// `codes:[...]` field onto a show result (single or batch). Mutates in place
// and returns the result. Saves an agent the show → eyeball-regex round-trip.
function _attachExtractedCodes(result) {
  if (!result || typeof result !== "object") return result;
  const codesFor = (e) => contract.extractCodes(`${e.subject || ""}\n${e.body || ""}`);
  if (Array.isArray(result.emails)) {
    for (const e of result.emails) {
      if (e && typeof e === "object") e.codes = codesFor(e);
    }
  } else {
    result.codes = codesFor(result);
  }
  return result;
}

// Width-aware truncation that counts wide CJK glyphs as 2 columns so columns
// stay aligned in a monospace terminal.
function _displayWidth(str) {
  let w = 0;
  for (const ch of String(str || "")) {
    const code = ch.codePointAt(0);
    // Rough CJK / fullwidth range — good enough for table alignment.
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}
function _padRight(str, width) {
  const w = _displayWidth(str);
  return w >= width ? str : str + " ".repeat(width - w);
}
function _truncate(str, max) {
  let out = "";
  let w = 0;
  for (const ch of String(str || "")) {
    const cw = _displayWidth(ch);
    if (w + cw > max - 1) {
      out += "…";
      return out;
    }
    out += ch;
    w += cw;
  }
  return out;
}
function _printRows(rows, columns) {
  if (!rows || rows.length === 0) return;
  const widths = columns.map((c) => Math.max(_displayWidth(c.title), ...rows.map((r) => Math.min(c.max || 80, _displayWidth(String(r[c.key] != null ? r[c.key] : ""))))));
  const sep = "  ";
  const header = columns.map((c, i) => _padRight(c.title, widths[i])).join(sep);
  process.stdout.write(header + "\n");
  process.stdout.write(columns.map((_, i) => "-".repeat(widths[i])).join(sep) + "\n");
  for (const r of rows) {
    const line = columns.map((c, i) => {
      const v = r[c.key] != null ? String(r[c.key]) : "";
      return _padRight(_truncate(v, widths[i]), widths[i]);
    }).join(sep);
    process.stdout.write(line + "\n");
  }
}

function _printAccountList(result) {
  if (!result || !result.success) {
    process.stderr.write((result && result.error) ? result.error + "\n" : "failed\n");
    return;
  }
  const rows = result.accounts || [];
  if (!rows.length) {
    process.stdout.write("(no accounts configured)\n");
    return;
  }
  _printRows(rows, [
    { key: "id", title: "ID", max: 24 },
    { key: "email", title: "EMAIL", max: 40 },
    { key: "provider", title: "PROVIDER", max: 12 },
    { key: "imap_host", title: "IMAP HOST", max: 30 },
    { key: "description", title: "DESCRIPTION", max: 30 },
  ]);
  process.stdout.write(`\n${rows.length} account(s)\n`);
}

function _printEmailList(result) {
  if (!result || !result.success) {
    process.stderr.write((result && result.error) ? result.error + "\n" : "failed\n");
    return;
  }
  const rows = (result.emails || []).map((e) => ({
    flag: (e.unread ? "●" : " ") + (e.is_flagged || e.flagged ? "★" : " ") + (e.has_attachments ? "📎" : " "),
    date: String(e.date || "").slice(0, 16),
    folder: e.folder || "",
    from: e.from || "",
    subject: e.subject || "",
    id: e.id || e.uid || "",
  }));
  if (!rows.length) {
    process.stdout.write("(no emails)\n");
    if (result.failed_accounts && result.failed_accounts.length) {
      for (const fa of result.failed_accounts) {
        process.stderr.write(`account ${fa.account || fa.account_id || ""} failed: ${fa.error || ""}\n`);
      }
    }
    return;
  }
  _printRows(rows, [
    { key: "flag", title: "STATE", max: 5 },
    { key: "date", title: "DATE", max: 16 },
    { key: "folder", title: "FOLDER", max: 18 },
    { key: "from", title: "FROM", max: 32 },
    { key: "subject", title: "SUBJECT", max: 60 },
    { key: "id", title: "UID", max: 12 },
  ]);
  const totalFound = result.total_found != null ? result.total_found : result.total_in_folder;
  process.stdout.write(`\n${rows.length} shown` + (totalFound != null ? ` (of ${totalFound})` : "") + "\n");
}

function _printFolderList(result) {
  if (!result || !result.success) {
    process.stderr.write((result && result.error) ? result.error + "\n" : "failed\n");
    return;
  }
  const rows = result.folders || [];
  _printRows(rows, [
    { key: "path", title: "PATH", max: 40 },
    { key: "delimiter", title: "DELIM", max: 5 },
    { key: "attributes", title: "FLAGS", max: 30 },
  ]);
  process.stdout.write(`\n${rows.length} folder(s) in ${result.account || "account"}\n`);
}

const MAX_BODY_FILE_BYTES = Number(process.env.MAILBOX_MAX_BODY_FILE_BYTES || 10 * 1024 * 1024); // 10 MiB

// Hard upper bound on per-call result limits. Without this, a typo like
// --limit 99999999 would happily try to fetch the entire mailbox (and
// trigger IMAP rate limits / OOM). Override via env if you really need it.
const MAX_RESULT_LIMIT = Number(process.env.MAILBOX_MAX_LIMIT || 1000);

// Parse a global email ref. Accepts either "account_id:uid" or a bare uid.
// Returns { id, account_id } where account_id is "" if not present in the
// ref. Caller should fall back to --account-id when account_id is empty.
function _parseEmailRef(raw) {
  const s = String(raw || "").trim();
  if (!s) return { id: "", account_id: "", folder: "" };
  const parts = s.split(":");
  // 3-part self-describing gid: account_id:folder:uid (folder may itself contain
  // ':' — rejoin the middle segments). account_id is the first segment.
  if (parts.length >= 3 && parts[0] && /^\d+$/.test(parts[parts.length - 1])) {
    return { id: parts[parts.length - 1], account_id: parts[0], folder: parts.slice(1, -1).join(":") };
  }
  // Legacy 2-part gid: account_id:uid.
  const idx = s.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) {
    return { id: s.slice(idx + 1), account_id: s.slice(0, idx), folder: "" };
  }
  return { id: s, account_id: "", folder: "" };
}

// Resolve a list of input refs (gid or bare uid) plus an explicit
// --account-id to { ids: [...], accountId, error? }. Returns an error
// when the gids name multiple different accounts and no --account-id
// override is provided.
function _resolveEmailRefs(rawIds, explicitAccountId) {
  const arr = Array.isArray(rawIds) ? rawIds : [rawIds];
  const flat = arr.flatMap((id) => String(id).split(/[\s,]+/).filter(Boolean));
  const refs = flat.map(_parseEmailRef);
  let resolved = explicitAccountId || "";
  const fromGids = new Set(refs.map((r) => r.account_id).filter(Boolean));
  if (!resolved && fromGids.size === 1) resolved = [...fromGids][0];
  else if (!resolved && fromGids.size > 1) {
    return { ids: [], accountId: "", refs: [], error: `Mixed account_ids in gids (${[...fromGids].join(", ")}); pass --account-id explicitly` };
  }
  return {
    ids: refs.map((r) => r.id),
    accountId: resolved,
    refs: refs.map((r) => ({ id: r.id, folder: r.folder || "" })),
  };
}

function _emailIdArgs(rawIds) {
  return Array.isArray(rawIds) ? rawIds : [];
}

function _hasEmailTargets(rawIds, opts) {
  const ids = _emailIdArgs(rawIds).flatMap((id) => String(id).split(/[\s,]+/).filter(Boolean));
  return ids.length > 0 || Boolean(opts.from) || Boolean(opts.subject);
}

function _targetSample(emails) {
  return (emails || []).slice(0, 5).map((e) => ({
    uid: String(e.uid || e.id || ""),
    subject: e.subject || "",
    from: e.from || "",
  }));
}

// Group targets by (account_id, folder) so a cross-account / cross-folder filter
// mutates each mailbox with its own folder. Each group also keeps a small subject
// sample for the dry-run preview.
function _groupTargets(emails, fallbackAccountId, fallbackFolder) {
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

function _groupsBreakdown(groups) {
  return [...groups.values()].map((g) => ({
    account_id: g.accountId,
    folder: g.folder,
    count: g.uids.length,
    sample: g.sample.slice(0, 3),
  }));
}

function _filteredDryRunResult({ operation, targets, groups, markAs, permanent, skipped }) {
  const out = {
    success: true,
    dry_run: true,
    would_target_count: targets.length,
    would_target_sample: _targetSample(targets),
    groups: _groupsBreakdown(groups),
    confirmation_required: true,
    confirmation_hint: "Re-run with --confirm to apply changes",
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
const _SPECIAL_MUTATION_FOLDER_RE = /^(sent|sent items|drafts?|junk|spam|trash|deleted|deleted items|bin|outbox)$/i;
function _isSpecialMutationFolder(name) {
  const seg = String(name || "").split("/").pop().trim();
  return _SPECIAL_MUTATION_FOLDER_RE.test(seg);
}

async function _searchFilteredEmailTargets(opts) {
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
      if (_isSpecialMutationFolder(e.folder)) {
        skipped.add(e.folder);
        return false;
      }
      return true;
    });
  }

  return {
    result,
    targets,
    groups: _groupTargets(targets, opts.accountId, opts.allFolders ? "" : opts.folder),
    skipped_special_folders: [...skipped],
  };
}

async function _applyFilteredEmailMutation({ operation, opts, targets, groups, markAs, skipped }) {
  if (Boolean(opts.dryRun) || !opts.confirm) {
    return _filteredDryRunResult({
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
    const result = operation === "delete"
      ? await email.deleteEmails({
        email_ids: g.uids,
        folder: g.folder,
        permanent: Boolean(opts.permanent),
        trash_folder: opts.trashFolder,
        account_id: g.accountId,
        dry_run: false,
      })
      : await email.markEmails({
        email_ids: g.uids,
        mark_as: markAs,
        folder: g.folder,
        account_id: g.accountId,
        dry_run: false,
      });
    results.push({ account_id: g.accountId, folder: g.folder, ...result });
  }

  const skippedFields = skipped && skipped.length ? { skipped_special_folders: skipped } : {};
  if (results.length === 1) return { ...results[0], ...skippedFields };
  return {
    success: results.every((r) => r && r.success),
    matched_count: targets.length,
    accounts_count: new Set([...groups.values()].map((g) => g.accountId)).size,
    groups: _groupsBreakdown(groups),
    results,
    ...skippedFields,
  };
}

// Mutate explicit id refs honoring each ref's gid folder (3-part gids are
// self-describing). Bare uids (no gid folder) fall back to defaultFolder so
// existing `--folder` behavior is preserved. Groups by folder and applies the
// mutation per group so a mix of folders is handled correctly.
async function _applyIdRefMutation({ operation, refs, accountId, defaultFolder, markAs, opts, dryRun }) {
  const groups = new Map();
  for (const r of refs) {
    const folder = r.folder || defaultFolder || "INBOX";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(r.id);
  }
  const results = [];
  for (const [folder, emailIds] of groups) {
    const res = operation === "delete"
      ? await email.deleteEmails({
        email_ids: emailIds,
        folder,
        permanent: Boolean(opts.permanent),
        trash_folder: opts.trashFolder,
        account_id: accountId,
        dry_run: dryRun,
      })
      : await email.markEmails({
        email_ids: emailIds,
        mark_as: markAs,
        folder,
        account_id: accountId,
        dry_run: dryRun,
      });
    results.push({ folder, ...res });
  }
  if (results.length === 1) return results[0];
  return { success: results.every((r) => r && r.success), folders_count: results.length, results };
}

// Validate --limit/--offset. Returns { ok, limit, offset, error }.
function _validatePaging(limitRaw, offsetRaw, { defaultLimit }) {
  const limit = limitRaw == null || limitRaw === "" ? defaultLimit : Number(limitRaw);
  const offset = offsetRaw == null || offsetRaw === "" ? 0 : Number(offsetRaw);
  if (!Number.isFinite(limit) || limit < 0) {
    return { ok: false, error: `--limit must be a non-negative number (got ${limitRaw})` };
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return { ok: false, error: `--offset must be a non-negative number (got ${offsetRaw})` };
  }
  if (limit > MAX_RESULT_LIMIT) {
    return { ok: false, error: `--limit ${limit} exceeds MAILBOX_MAX_LIMIT=${MAX_RESULT_LIMIT}; raise the env var if intentional` };
  }
  return { ok: true, limit, offset };
}

// Resolve human-friendly date shortcuts to YYYY-MM-DD before they reach the
// core parser. Accepts: ISO 8601, YYYY-MM-DD, "today", "yesterday",
// relative spans like "2d", "3w", "4mo", "1y", "30m", "12h".
function _expandDateShortcut(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  const now = new Date();
  if (value === "today") return _isoDate(now);
  if (value === "yesterday") {
    const d = new Date(now); d.setDate(d.getDate() - 1); return _isoDate(d);
  }
  if (value === "last-week" || value === "lastweek") {
    const d = new Date(now); d.setDate(d.getDate() - 7); return _isoDate(d);
  }
  if (value === "last-month" || value === "lastmonth") {
    const d = new Date(now); d.setMonth(d.getMonth() - 1); return _isoDate(d);
  }
  // Relative: <N><unit>  unit ∈ m h d w mo y
  const m = value.match(/^(\d+)\s*(mo|m|h|d|w|y)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const d = new Date(now);
    if (unit === "m") d.setMinutes(d.getMinutes() - n);
    else if (unit === "h") d.setHours(d.getHours() - n);
    else if (unit === "d") d.setDate(d.getDate() - n);
    else if (unit === "w") d.setDate(d.getDate() - n * 7);
    else if (unit === "mo") d.setMonth(d.getMonth() - n);
    else if (unit === "y") d.setFullYear(d.getFullYear() - n);
    // For coarse units (d/w/mo/y) collapse to date-only so IMAP SINCE
    // semantics line up; for finer units keep the timestamp.
    if (unit === "d" || unit === "w" || unit === "mo" || unit === "y") return _isoDate(d);
    return d.toISOString();
  }
  return raw; // pass through to underlying parser
}
function _isoDate(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// Validate a date string. Accepts YYYY-MM-DD, ISO 8601, or one of the
// relative shortcuts handled by _expandDateShortcut.
function _validateDateOpt(name, raw) {
  const value = String(raw || "").trim();
  if (!value) return { ok: true };
  const expanded = _expandDateShortcut(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(expanded)) {
    const d = new Date(`${expanded}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return { ok: true, expanded };
  }
  const d = new Date(expanded);
  if (!Number.isNaN(d.getTime())) return { ok: true, expanded };
  return { ok: false, error: `${name} value "${value}" is not a valid date (expected YYYY-MM-DD, ISO 8601, or relative like 2d/3w/1mo/today/yesterday)` };
}

function _readBodyFile(bodyFilePath) {
  const st = fs.statSync(bodyFilePath);
  if (st.size > MAX_BODY_FILE_BYTES) {
    throw new Error(`--body-file exceeds ${MAX_BODY_FILE_BYTES} bytes (size=${st.size})`);
  }
  return fs.readFileSync(bodyFilePath, "utf8");
}

function _collectOption(value, previous) {
  return [...(previous || []), value];
}

function _resolveLocalAttachments(values) {
  const files = Array.isArray(values) ? values : [];
  return files.map((raw) => {
    const input = String(raw || "").trim();
    if (!input) throw new Error("--attachment path cannot be empty");
    const filePath = path.resolve(process.cwd(), input);
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      throw new Error(`--attachment not found: ${input}`);
    }
    if (!st.isFile()) throw new Error(`--attachment is not a file: ${input}`);
    return {
      filename: path.basename(filePath),
      path: filePath,
      size_bytes: st.size,
    };
  });
}

function _attachmentPreview(attachments) {
  return (attachments || []).map((a) => ({
    filename: a.filename,
    path: a.path,
    size_bytes: a.size_bytes,
  }));
}

function _mailAttachments(attachments) {
  return (attachments || []).map((a) => ({
    filename: a.filename,
    path: a.path,
  }));
}

function _explicitOptionValue(cmd, opts, key) {
  if (cmd && typeof cmd.getOptionValueSource === "function" && cmd.getOptionValueSource(key) === "cli") {
    return opts[key];
  }
  return undefined;
}

// Cooperative shutdown for foreground daemons. SIGINT/SIGTERM flips the flag
// and resolves any in-flight wait so the loop can finish its current pass
// (e.g. mid-flush sqlite write) before exiting.
function _createStopSignal() {
  const state = { stopped: false, wakers: new Set() };
  const trigger = () => {
    state.stopped = true;
    for (const w of state.wakers) {
      try { w(); } catch { /* ignore */ }
    }
    state.wakers.clear();
  };
  process.once("SIGINT", trigger);
  process.once("SIGTERM", trigger);
  return {
    stopped: () => state.stopped,
    sleep(ms) {
      if (state.stopped) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          state.wakers.delete(resolve);
          resolve();
        }, ms);
        const wake = () => { clearTimeout(t); resolve(); };
        state.wakers.add(wake);
      });
    },
  };
}

// Send an admin RPC (__ping/__reload/__shutdown) directly to the daemon
// socket without going through the makeProxies fallback path — these
// methods only make sense when a daemon is actually listening.
async function _daemonAdmin(fnName) {
  const net = require("net");
  const fsLocal = require("fs");
  const { getSocketPath } = require("./daemon");
  const sockPath = getSocketPath();
  if (!fsLocal.existsSync(sockPath)) {
    return { success: false, error: `daemon socket not found at ${sockPath}`, error_code: "not_running" };
  }
  return new Promise((resolve) => {
    const conn = net.createConnection(sockPath);
    let buf = "";
    let settled = false;
    const settle = (val) => { if (settled) return; settled = true; try { conn.end(); } catch {} resolve(val); };
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      try {
        const msg = JSON.parse(line);
        if (msg.ok) settle({ success: true, ...(msg.result || {}) });
        else settle({ success: false, error: msg.error || "daemon error", error_code: msg.error_code });
      } catch (e) {
        settle({ success: false, error: `invalid daemon response: ${e.message}`, error_code: "operation_failed" });
      }
    });
    conn.on("error", (e) => settle({ success: false, error: e.message, error_code: "network_error" }));
    conn.on("connect", () => {
      conn.write(JSON.stringify({ id: 1, fn: fnName }) + "\n");
    });
    setTimeout(() => settle({ success: false, error: "daemon did not respond within 2s", error_code: "network_error" }), 2000);
  });
}

// Recursively serialize a commander Command into a JSON descriptor that an
// AI agent can introspect. Returns null if cmd is missing.
function _commandToJson(cmd) {
  if (!cmd) return null;
  const out = {
    name: cmd.name(),
    description: cmd.description() || "",
    usage: cmd.usage() || "",
    arguments: (cmd._args || cmd.registeredArguments || []).map((a) => ({
      name: a.name(),
      description: a.description || "",
      required: Boolean(a.required),
      variadic: Boolean(a.variadic),
      default: a.defaultValue,
    })),
    options: (cmd.options || []).map((o) => ({
      flags: o.flags,
      long: o.long || "",
      short: o.short || "",
      description: o.description || "",
      required: Boolean(o.required),
      optional: Boolean(o.optional),
      default: o.defaultValue,
      negate: Boolean(o.negate),
    })),
    subcommands: (cmd.commands || []).filter((c) => !c._hidden && c.name() !== "help").map((c) => ({
      name: c.name(),
      description: c.description() || "",
    })),
  };
  return out;
}
function _findCommandPath(program, argv) {
  let cur = program;
  let unknown = null;
  for (const tok of argv) {
    if (tok.startsWith("-")) break;
    const next = (cur.commands || []).find((c) => c.name() === tok);
    if (next) {
      cur = next;
      continue;
    }
    // No subcommand matched. If the current command expects subcommands, this
    // token is an unknown COMMAND (e.g. `bogus --help`); otherwise it's a
    // positional argument (e.g. `email show 101 --help`) and we stop here.
    const expectsSub = (cur.commands || []).some((c) => c.name() !== "help");
    if (expectsSub) unknown = tok;
    break;
  }
  return { cmd: cur, unknown };
}

async function main(argv) {
  const parsed = contract.parseGlobalFlags(argv);
  let asJson = parsed.asJson;
  const pretty = parsed.pretty;
  const forceText = parsed.forceText;
  const lean = parsed.lean;
  const format = parsed.format;
  // Default to JSON when stdout is piped (so scripts get parseable output);
  // --text overrides this for users who want the human-readable form even
  // when piping to less/grep.
  if (forceText) asJson = false;
  else if (!asJson && !process.stdout.isTTY) asJson = true;
  // Monkeypatch: every action calls contract.handleJsonOrText with its own
  // {result, asJson, pretty, printText} bag. Wrap the function so we don't
  // have to thread `lean` / `format` through every callsite — when set, they
  // slim/reshape the result before printing.
  const originalHandle = contract.handleJsonOrText;
  if (lean || format) {
    contract.handleJsonOrText = (args) =>
      originalHandle({ ...args, ...(lean ? { lean: true } : {}), ...(format ? { format } : {}) });
  }

  const program = new Command();
  program.name("mail-use");
  program.version(_resolveCliVersion(), "-v, --version", "output the version");
  program.exitOverride();
  // Suppress commander's default "error: ..." stderr line — we surface the
  // same message via the JSON contract (or via invalidUsage on stderr) and
  // don't want the message to appear twice (once raw, once wrapped in JSON).
  program.configureOutput({
    writeErr: () => {},
  });

  const accountCmd = program.command("account").description("Account operations");
  accountCmd
    .command("list")
    .description("List configured accounts")
    .action(async () => {
      const result = await accounts.listAccounts();
      const rc = contract.handleJsonOrText({
        result,
        asJson,
        pretty,
        printText: _printAccountList,
      });
      process.exit(rc);
    });

  accountCmd
    .command("test-connection")
    .description("Test IMAP/SMTP connectivity")
    .option("--account-id <id>", "Specific account id/email")
    .action(async (opts) => {
      let result;

      try {
        const accId = String(opts.accountId || "").trim();
        let targets = [];

        if (accId) {
          const one = await accounts.getAccountByIdOrEmail(accId);
          if (!one.success) {
            result = { success: false, error: one.error || `Account not found: ${accId}`, accounts: [], total_accounts: 0 };
          } else {
            targets = [one.account];
          }
        } else {
          const all = await accounts.getAllAccountsResolved();
          if (!all.success) {
            result = all;
          } else {
            targets = all.accounts || [];
            if (!targets.length) {
              result = { success: false, error: "No accounts configured", accounts: [], total_accounts: 0 };
            }
          }
        }

        if (!result) {
          const out = [];
          for (const a of targets) {
            const item = {
              email: a.email,
              provider: a.provider,
              success: false,
              imap: { success: false },
              smtp: { success: false },
            };

            try {
              const im = await imap.testConnection(a, "INBOX");
              item.imap = { success: Boolean(im && im.success), total_emails: im.total_emails || 0, unread_emails: im.unread_emails || 0 };
              if (im && im.error) item.imap.error = im.error;
            } catch (e) {
              item.imap = { success: false, error: e && e.message ? e.message : "IMAP failed" };
            }

            try {
              const sm = await smtp.testConnection(a);
              item.smtp = { success: Boolean(sm && sm.success) };
              if (sm && sm.error) item.smtp.error = sm.error;
            } catch (e) {
              item.smtp = { success: false, error: e && e.message ? e.message : "SMTP failed" };
            }

            item.success = Boolean(item.imap && item.imap.success) && Boolean(item.smtp && item.smtp.success);
            out.push(item);
          }

          result = { success: out.length > 0 && out.every((x) => x.success), accounts: out, total_accounts: out.length };
        }
      } catch (e) {
        result = { success: false, error: e && e.message ? e.message : "test failed" };
      }

      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("account test-connection") });
      process.exit(rc);
    });

  // email
  const emailCmd = program.command("email").description("Email operations");
  emailCmd
    .command("list")
    .description("List emails")
    .option("--limit <n>", "Limit", "100")
    .option("--offset <n>", "Offset", "0")
    .option("--unread-only", "Only unread")
    .option("--account-id <id>", "Account id/email (omit to span ALL accounts, merged by date)")
    .option("--from <addr>", "Filter by sender (substring, cache-side)")
    .option("--date-from <s>", "Filter from date (YYYY-MM-DD, ISO, or relative 7d/24h/today)")
    .option("--since <s>", "Alias of --date-from (e.g. --since 7d, --since today)")
    .option("--date-to <s>", "Filter to date (YYYY-MM-DD or ISO)")
    .option("--folder <name>", "Folder (currently only INBOX is supported here; use 'email search' for cross-folder)", "INBOX")
    .option("--with-preview <n>", "Also fetch a body preview of N chars per email (one extra IMAP fetch, capped at 50 emails)")
    .option("--account-unread", "Also compute account_unread_total (unread across all folders; one STATUS per folder on live)")
    .option("--live", "Force live IMAP (no cache)")
    .action(async (opts) => {
      if (opts.since && !opts.dateFrom) opts.dateFrom = opts.since; // --since is sugar for --date-from
      // 'email list' is INBOX-only by design; warn instead of silently collapsing
      // a cross-folder request so the user knows to reach for 'email search'.
      if (opts.folder && String(opts.folder).toLowerCase() !== "inbox") {
        process.stderr.write(
          `mail-use: 'email list' is INBOX-only; folder "${opts.folder}" was treated as INBOX. ` +
            `Use 'email search --folder ${opts.folder}' for cross-folder.\n`
        );
      }
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 100 });
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        process.exit(rc);
      }
      let dateFromExpanded = opts.dateFrom || "";
      let dateToExpanded = opts.dateTo || "";
      for (const [name, valGet, set] of [["--date-from", () => opts.dateFrom, (v) => (dateFromExpanded = v)], ["--date-to", () => opts.dateTo, (v) => (dateToExpanded = v)]]) {
        const v = _validateDateOpt(name, valGet());
        if (!v.ok) {
          const rc = contract.invalidUsage({ message: v.error, asJson, pretty });
          process.exit(rc);
        }
        if (v.expanded) set(v.expanded);
      }
      const previewChars = opts.withPreview != null ? Math.max(0, Math.min(2000, Number(opts.withPreview) || 0)) : 0;
      const result = await email.listEmails({
        limit: paging.limit,
        offset: paging.offset,
        unread_only: Boolean(opts.unreadOnly),
        folder: opts.folder,
        account_id: opts.accountId || "",
        from: opts.from || "",
        date_from: dateFromExpanded,
        date_to: dateToExpanded,
        use_cache: !opts.live,
        preview_chars: previewChars,
        include_account_unread: Boolean(opts.accountUnread),
      });
      // Add contract parity fields.
      result.limit = paging.limit;
      result.offset = paging.offset;
      result.unread_only = Boolean(opts.unreadOnly);
      result.folder = opts.folder;
      result.use_cache = !opts.live;
      if (opts.dateFrom) result.date_from = opts.dateFrom;
      if (opts.dateTo) result.date_to = opts.dateTo;
      if (opts.accountId) result.account_id = opts.accountId;
      if (opts.from) result.from = opts.from;

      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: _printEmailList });
      process.exit(rc);
    });

  emailCmd
    .command("recent")
    .description("Recent INBOX emails across ALL accounts, merged newest-first (alias of 'email list' with no --account-id)")
    .option("--limit <n>", "Limit", "50")
    .option("--since <s>", "Only emails since (e.g. 7d, today, YYYY-MM-DD)")
    .option("--account-id <id>", "Restrict to one account (default: all accounts)")
    .option("--account-unread", "Also compute account_unread_total (unread across all folders)")
    .option("--live", "Force live IMAP (no cache)")
    .action(async (opts) => {
      const paging = _validatePaging(opts.limit, "0", { defaultLimit: 50 });
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        process.exit(rc);
      }
      let sinceExpanded = "";
      if (opts.since) {
        const v = _validateDateOpt("--since", opts.since);
        if (!v.ok) {
          const rc = contract.invalidUsage({ message: v.error, asJson, pretty });
          process.exit(rc);
        }
        sinceExpanded = v.expanded || opts.since;
      }
      const result = await email.listEmails({
        limit: paging.limit,
        offset: 0,
        folder: "INBOX",
        account_id: opts.accountId || "",
        date_from: sinceExpanded,
        use_cache: !opts.live,
        include_account_unread: Boolean(opts.accountUnread),
      });
      result.command = "recent";
      result.limit = paging.limit;
      if (opts.since) result.since = opts.since;
      if (opts.accountId) result.account_id = opts.accountId;
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: _printEmailList });
      process.exit(rc);
    });

  emailCmd
    .command("search")
    .description("Search emails")
    .option("--query <q>", "Free-text query (IMAP TEXT, matches body+headers)")
    .option("--from <s>", "Filter by sender (IMAP FROM, substring match)")
    .option("--subject <s>", "Filter by subject (IMAP SUBJECT, substring match)")
    .option("--account-id <id>")
    .option("--date-from <s>", "Filter from date (YYYY-MM-DD, ISO, or relative 7d/24h/today)")
    .option("--since <s>", "Alias of --date-from (e.g. --since 7d)")
    .option("--date-to <s>")
    .option("--limit <n>", "Limit", "50")
    .option("--offset <n>", "Offset", "0")
    .option("--unread-only")
    .option("--folder <name>", "Folder", "all")
    .option("--with-preview <n>", "Also fetch a body preview of N chars per email (one extra IMAP fetch, capped at 50 emails)")
    .option("--timeout <s>", "Overall search deadline in seconds; returns partial results + timed_out=true past it (0 = no limit)", "60")
    .action(async (opts) => {
      if (opts.since && !opts.dateFrom) opts.dateFrom = opts.since; // --since is sugar for --date-from
      if (!opts.query && !opts.from && !opts.subject && !opts.dateFrom && !opts.dateTo && !opts.unreadOnly) {
        const rc = contract.invalidUsage({
          message: "Provide at least one of --query, --from, --subject, --date-from, --date-to, --unread-only",
          asJson,
          pretty,
        });
        process.exit(rc);
      }
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 50 });
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        process.exit(rc);
      }
      let dateFromExpanded = opts.dateFrom || "";
      let dateToExpanded = opts.dateTo || "";
      for (const [name, valGet, set] of [["--date-from", () => opts.dateFrom, (v) => (dateFromExpanded = v)], ["--date-to", () => opts.dateTo, (v) => (dateToExpanded = v)]]) {
        const v = _validateDateOpt(name, valGet());
        if (!v.ok) {
          const rc = contract.invalidUsage({ message: v.error, asJson, pretty });
          process.exit(rc);
        }
        if (v.expanded) set(v.expanded);
      }
      const previewChars = opts.withPreview != null ? Math.max(0, Math.min(2000, Number(opts.withPreview) || 0)) : 0;
      const result = await email.searchEmails({
        query: opts.query || "",
        from: opts.from || "",
        subject: opts.subject || "",
        account_id: opts.accountId || "",
        date_from: dateFromExpanded,
        date_to: dateToExpanded,
        limit: paging.limit,
        offset: paging.offset,
        unread_only: Boolean(opts.unreadOnly),
        folder: opts.folder,
        preview_chars: previewChars,
        timeout_ms: Math.max(0, Number(opts.timeout || 0)) * 1000,
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: _printEmailList });
      process.exit(rc);
    });

  emailCmd
    .command("show")
    .description("Show one or more emails (AI-friendly defaults: text only, body capped, URLs stripped — pass --full for raw)")
    .argument("<email_ids...>")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder (default: auto-resolve from the gid/cache, else INBOX)")
    .option("--full", "Return full HTML + uncapped body + URLs (overrides AI-friendly defaults)")
    .option("--preview", "Return a very short body preview (400 chars body, 2000 chars HTML)")
    .option("--body-max-len <n>", "Max body length (characters)")
    .option("--html-max-len <n>", "Max HTML length: 0 = strip HTML, -1 = unlimited, >0 = cap")
    .option("--no-html", "Exclude HTML body")
    .option("--text-only", "Text body only (alias for --no-html)")
    .option("--include-html", "Include HTML body (overrides AI default)")
    .option("--strip-urls", "Remove URLs from body text")
    .option("--keep-urls", "Keep URLs in body text (overrides AI default)")
    .option("--extract-code", "Also scan subject+body for verification/OTP codes and return them as codes:[...]")
    .action(async (emailIds, opts) => {
      const bodyMaxRaw = opts.bodyMaxLen != null ? Number(opts.bodyMaxLen) : null;
      const htmlMaxRaw = opts.htmlMaxLen != null ? Number(opts.htmlMaxLen) : null;
      // AI-friendly defaults: text only, body ~ 2000 chars, URLs stripped.
      // --full opts back to "give me everything" for human / debug use.
      // html_max_len: 0 = strip, -1 = unlimited, >0 = cap (do not clamp negatives).
      let bodyMax = Number.isFinite(bodyMaxRaw) ? Math.max(0, bodyMaxRaw) : (opts.full ? 0 : 2000);
      let htmlMax = Number.isFinite(htmlMaxRaw) ? htmlMaxRaw : (opts.full ? -1 : 0);
      let includeHtml = opts.full ? true : Boolean(opts.includeHtml);
      if (opts.html === false || opts.textOnly) includeHtml = false; // --no-html / --text-only win
      let stripUrls = opts.full ? false : !opts.keepUrls;
      if (opts.stripUrls) stripUrls = true;
      if (opts.preview) {
        bodyMax = 400;
        if (!htmlMax && includeHtml) htmlMax = 2000;
      }
      const refs = _resolveEmailRefs(emailIds, opts.accountId);
      if (refs.error) {
        const rc = contract.invalidUsage({ message: refs.error, asJson, pretty });
        process.exit(rc);
      }
      const ids = refs.ids;
      const explicitFolder = opts.folder; // undefined unless the user passed --folder
      const baseOpts = {
        account_id: refs.accountId,
        body_max_len: bodyMax,
        html_max_len: htmlMax,
        include_html: includeHtml,
        strip_urls: stripUrls,
      };
      if (ids.length === 1) {
        // Resolve folder: explicit --folder > gid folder > cache > INBOX.
        const folderHint = explicitFolder || (refs.refs[0] && refs.refs[0].folder) || "";
        const folder = await email.resolveEmailFolder({ account_id: refs.accountId, uid: ids[0], folder: folderHint });
        const result = await email.showEmail({ email_id: ids[0], folder, ...baseOpts });
        if (opts.extractCode) _attachExtractedCodes(result);
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email show") });
        process.exit(rc);
      }
      // Batch: an explicit --folder applies to all; otherwise resolve each id's
      // folder from its gid/cache so results that span folders just work.
      const result = explicitFolder
        ? await email.showEmails({ email_ids: ids, folder: explicitFolder, ...baseOpts })
        : await email.showEmailsResolved({ refs: refs.refs, ...baseOpts });
      if (opts.extractCode) _attachExtractedCodes(result);
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email show") });
      process.exit(rc);
    });

  emailCmd
    .command("mark")
    .description("Mark emails read/unread")
    .argument("[email_ids...]")
    .option("--read", "Mark as read")
    .option("--unread", "Mark as unread")
    .option("--mark-as <state>", "Mark as read/unread")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--all-folders", "With --from/--subject: target matches across ALL folders (grouped per folder)")
    .option("--include-special", "With --all-folders: also target Sent/Drafts/Junk/Trash (off by default for safety)")
    .option("--from <addr>", "Filter by sender substring (IMAP server-side search)")
    .option("--subject <s>", "Filter by subject substring (IMAP server-side search)")
    .option("--unread-only", "Only target unread emails (combine with --from/--subject)")
    .option("--confirm", "Apply changes; required when >100 filter matches")
    .option("--dry-run")
    .action(async (ids, opts) => {
      const read = Boolean(opts.read);
      const unread = Boolean(opts.unread);
      const markAsOption = opts.markAs ? String(opts.markAs).toLowerCase() : "";
      const requestedStates = [
        read ? "read" : "",
        unread ? "unread" : "",
        markAsOption,
      ].filter(Boolean);
      if (requestedStates.length !== 1 || (markAsOption && markAsOption !== "read" && markAsOption !== "unread")) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --read/--unread", asJson, pretty });
        return process.exit(rc);
      }
      if (!_hasEmailTargets(ids, opts)) {
        const rc = contract.invalidUsage({ message: "Must provide email_ids, --from, or --subject", asJson, pretty });
        return process.exit(rc);
      }

      const mark_as = requestedStates[0];
      if (opts.from || opts.subject) {
        const searched = await _searchFilteredEmailTargets(opts);
        if (!searched.result || !searched.result.success) {
          const rc = contract.handleJsonOrText({ result: searched.result, asJson, pretty, printText: () => _printTextNotImplemented("email mark") });
          return process.exit(rc);
        }
        if (searched.targets.length > 100 && !opts.confirm) {
          const rc = contract.invalidUsage({ message: `Matched ${searched.targets.length} emails. Add --confirm to proceed.`, asJson, pretty });
          return process.exit(rc);
        }
        const result = await _applyFilteredEmailMutation({
          operation: "mark",
          opts,
          targets: searched.targets,
          groups: searched.groups,
          markAs: mark_as,
          skipped: searched.skipped_special_folders,
        });
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email mark") });
        return process.exit(rc);
      }

      const refs = _resolveEmailRefs(_emailIdArgs(ids), opts.accountId);
      if (refs.error) {
        const rc = contract.invalidUsage({ message: refs.error, asJson, pretty });
        return process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await _applyIdRefMutation({
        operation: "mark",
        refs: refs.refs,
        accountId: refs.accountId,
        defaultFolder: opts.folder,
        markAs: mark_as,
        opts,
        dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email mark") });
      return process.exit(rc);
    });

  emailCmd
    .command("delete")
    .description("Delete emails")
    .argument("[email_ids...]")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--all-folders", "With --from/--subject: target matches across ALL folders (grouped per folder)")
    .option("--include-special", "With --all-folders: also target Sent/Drafts/Junk/Trash (off by default for safety)")
    .option("--from <addr>", "Filter by sender substring (IMAP server-side search)")
    .option("--subject <s>", "Filter by subject substring (IMAP server-side search)")
    .option("--unread-only", "Only target unread emails (combine with --from/--subject)")
    .option("--permanent")
    .option("--trash-folder <name>", "Trash folder", "Trash")
    .option("--confirm", "Apply changes; required when >100 filter matches")
    .option("--dry-run")
    .action(async (ids, opts) => {
      if (!_hasEmailTargets(ids, opts)) {
        const rc = contract.invalidUsage({ message: "Must provide email_ids, --from, or --subject", asJson, pretty });
        return process.exit(rc);
      }

      if (opts.from || opts.subject) {
        const searched = await _searchFilteredEmailTargets(opts);
        if (!searched.result || !searched.result.success) {
          const rc = contract.handleJsonOrText({ result: searched.result, asJson, pretty, printText: () => _printTextNotImplemented("email delete") });
          return process.exit(rc);
        }
        if (searched.targets.length > 100 && !opts.confirm) {
          const rc = contract.invalidUsage({ message: `Matched ${searched.targets.length} emails. Add --confirm to proceed.`, asJson, pretty });
          return process.exit(rc);
        }
        const result = await _applyFilteredEmailMutation({
          operation: "delete",
          opts,
          targets: searched.targets,
          groups: searched.groups,
          skipped: searched.skipped_special_folders,
        });
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email delete") });
        return process.exit(rc);
      }

      const refs = _resolveEmailRefs(_emailIdArgs(ids), opts.accountId);
      if (refs.error) {
        const rc = contract.invalidUsage({ message: refs.error, asJson, pretty });
        return process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await _applyIdRefMutation({
        operation: "delete",
        refs: refs.refs,
        accountId: refs.accountId,
        defaultFolder: opts.folder,
        opts,
        dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email delete") });
      return process.exit(rc);
    });

  emailCmd
    .command("send")
    .description("Send an email")
    .requiredOption("--to <to...>")
    .requiredOption("--subject <s>")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--cc <cc...>")
    .option("--bcc <bcc...>")
    .option("--attachment <path>", "Attach a local file; repeat for multiple files", _collectOption, [])
    .option("--account-id <id>")
    .option("--is-html")
    .option("--confirm", "Actually send (default: dry-run)")
    .option("--dry-run")
    .action(async (opts) => {
      const hasBody = typeof opts.body === "string" && opts.body.length;
      const hasBodyFile = Boolean(opts.bodyFile);
      if ((hasBody && hasBodyFile) || (!hasBody && !hasBodyFile)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --body/--body-file", asJson, pretty });
        process.exit(rc);
      }

      let body = opts.body || "";
      if (opts.bodyFile) {
        try {
          body = _readBodyFile(opts.bodyFile);
        } catch (e) {
          const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read body file", asJson, pretty });
          process.exit(rc);
        }
      }
      let attachments;
      try {
        attachments = _resolveLocalAttachments(opts.attachment);
      } catch (e) {
        const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read attachment", asJson, pretty });
        process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      if (dryRun) {
        const result = {
          success: true,
          dry_run: true,
          would_send: {
            to: opts.to,
            cc: opts.cc || [],
            bcc: opts.bcc || [],
            subject: opts.subject,
            account_id: opts.accountId || "",
            is_html: Boolean(opts.isHtml),
            body_bytes: Buffer.byteLength(body, "utf8"),
            body_preview: body.slice(0, 200),
            attachment_count: attachments.length,
            attachments: _attachmentPreview(attachments),
          },
          confirmation_required: true,
          confirmation_hint: "Re-run with --confirm to actually send",
        };
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email send") });
        process.exit(rc);
      }
      const result = await email.sendEmail({
        to: opts.to,
        subject: opts.subject,
        body,
        cc: opts.cc,
        bcc: opts.bcc,
        account_id: opts.accountId || "",
        is_html: Boolean(opts.isHtml),
        attachments: _mailAttachments(attachments),
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email send") });
      process.exit(rc);
    });

  emailCmd
    .command("reply")
    .description("Reply to an email")
    .argument("<email_id>")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--reply-all")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--attachment <path>", "Attach a local file; repeat for multiple files", _collectOption, [])
    .option("--account-id <id>")
    .option("--is-html")
    .option("--confirm", "Actually send (default: dry-run)")
    .option("--dry-run")
    .action(async (emailId, opts, cmd) => {
      const hasBody = typeof opts.body === "string" && opts.body.length;
      const hasBodyFile = Boolean(opts.bodyFile);
      if ((hasBody && hasBodyFile) || (!hasBody && !hasBodyFile)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --body/--body-file", asJson, pretty });
        process.exit(rc);
      }

      let body = opts.body || "";
      if (opts.bodyFile) {
        try {
          body = _readBodyFile(opts.bodyFile);
        } catch (e) {
          const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read body file", asJson, pretty });
          process.exit(rc);
        }
      }
      let attachments;
      try {
        attachments = _resolveLocalAttachments(opts.attachment);
      } catch (e) {
        const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read attachment", asJson, pretty });
        process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const ref = _parseEmailRef(emailId);
      const explicitFolder = _explicitOptionValue(cmd, opts, "folder");
      const result = await email.replyEmail({
        email_id: ref.id,
        body,
        reply_all: Boolean(opts.replyAll),
        folder: explicitFolder || ref.folder || opts.folder,
        account_id: opts.accountId || ref.account_id || "",
        is_html: Boolean(opts.isHtml),
        attachments: _mailAttachments(attachments),
        dry_run: dryRun,
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email reply") });
      process.exit(rc);
    });

  emailCmd
    .command("forward")
    .description("Forward an email")
    .argument("<email_id>")
    .requiredOption("--to <to...>")
    .option("--body <text>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--no-attachments")
    .option("--account-id <id>")
    .option("--confirm", "Actually send (default: dry-run)")
    .option("--dry-run")
    .action(async (emailId, opts, cmd) => {
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const ref = _parseEmailRef(emailId);
      const explicitFolder = _explicitOptionValue(cmd, opts, "folder");
      const result = await email.forwardEmail({
        email_id: ref.id,
        to: opts.to,
        body: opts.body || "",
        folder: explicitFolder || ref.folder || opts.folder,
        no_attachments: Boolean(opts.noAttachments),
        account_id: opts.accountId || ref.account_id || "",
        dry_run: dryRun,
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email forward") });
      process.exit(rc);
    });

  emailCmd
    .command("folders")
    .description("List folders")
    .requiredOption("--account-id <id>")
    .action(async (opts) => {
      const result = await email.listFolders({ account_id: opts.accountId });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: _printFolderList });
      process.exit(rc);
    });

  emailCmd
    .command("attachments")
    .description("Download attachments")
    .argument("<email_id>", "UID or gid (account_id:uid)")
    .option("--account-id <id>", "Required if email_id is a bare UID")
    .option("--folder <name>", "Folder", "INBOX")
    .action(async (emailId, opts) => {
      const refs = _resolveEmailRefs([emailId], opts.accountId);
      if (refs.error || !refs.accountId) {
        const rc = contract.invalidUsage({ message: refs.error || "Missing --account-id (or pass a gid like account_id:uid)", asJson, pretty });
        process.exit(rc);
      }
      const result = await email.downloadAttachments({ email_id: refs.ids[0], folder: opts.folder, account_id: refs.accountId });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email attachments") });
      process.exit(rc);
    });

  emailCmd
    .command("flag")
    .description("Flag/unflag an email")
    .argument("<email_id>", "UID or gid (account_id:uid)")
    .option("--account-id <id>", "Required if email_id is a bare UID")
    .option("--set")
    .option("--unset")
    .option("--flag-type <t>", "Flag type", "flagged")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--confirm", "Apply changes (default: dry-run)")
    .option("--dry-run")
    .action(async (emailId, opts) => {
      const set = Boolean(opts.set);
      const unset = Boolean(opts.unset);
      if ((set && unset) || (!set && !unset)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --set/--unset", asJson, pretty });
        process.exit(rc);
      }
      const refs = _resolveEmailRefs([emailId], opts.accountId);
      if (refs.error || !refs.accountId) {
        const rc = contract.invalidUsage({ message: refs.error || "Missing --account-id (or pass a gid like account_id:uid)", asJson, pretty });
        process.exit(rc);
      }

      const setFlag = set;
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await email.flagEmail({
        email_id: refs.ids[0],
        set_flag: setFlag,
        flag_type: opts.flagType,
        folder: opts.folder,
        account_id: refs.accountId,
        dry_run: dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email flag") });
      process.exit(rc);
    });

  emailCmd
    .command("move")
    .description("Move emails to folder")
    .argument("<email_ids...>", "UIDs or gids (account_id:uid)")
    .requiredOption("--target-folder <name>")
    .option("--source-folder <name>", "Source folder", "INBOX")
    .option("--account-id <id>", "Required if email_ids are bare UIDs")
    .option("--confirm", "Apply changes (default: dry-run)")
    .option("--dry-run")
    .action(async (ids, opts) => {
      const refs = _resolveEmailRefs(ids, opts.accountId);
      if (refs.error || !refs.accountId) {
        const rc = contract.invalidUsage({ message: refs.error || "Missing --account-id (or pass gids like account_id:uid)", asJson, pretty });
        process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await email.moveEmails({
        email_ids: refs.ids,
        target_folder: opts.targetFolder,
        source_folder: opts.sourceFolder,
        account_id: refs.accountId,
        dry_run: dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email move") });
      process.exit(rc);
    });

  // sync
  const syncCmd = program.command("sync").description("Local sync/cache operations");
  syncCmd
    .command("status")
    .description("Show scheduler status")
    .action(async () => {
      const result = await sync.status();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync status") });
      process.exit(rc);
    });
  syncCmd
    .command("force")
    .description("Force sync now")
    .option("--account-id <id>")
    .option("--full")
    .action(async (opts) => {
      const result = await sync.force({ account_id: opts.accountId || "", full: Boolean(opts.full) });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync force") });
      process.exit(rc);
    });
  syncCmd
    .command("init")
    .description("Initialize database and run initial sync")
    .action(async () => {
      const result = await sync.init();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync init") });
      process.exit(rc);
    });
  syncCmd
    .command("health")
    .description("Show sync health summary")
    .action(async () => {
      const result = await sync.health();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync health") });
      process.exit(rc);
    });

  syncCmd
    .command("watch")
    .description("Continuously print sync status")
    .option("--interval <seconds>", "Refresh interval", "5")
    .action(async (opts) => {
      const { printJson } = require("@mail-use/shared").json;
      const intervalSec = Math.max(0.5, Number(opts.interval || 5));
      const stop = _createStopSignal();
      try {
        while (!stop.stopped()) {
          const status = await sync.status();
          status.success = true;
          printJson(status, Boolean(pretty) || !asJson);
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch (e) {
        if (e && e.name === "AbortError") return process.exit(0);
        return process.exit(0);
      }
    });

  syncCmd
    .command("daemon")
    .description("Run periodic sync in the foreground")
    .option("--interval <seconds>", "Sync interval", "300")
    .option("--account-id <id>")
    .option("--full")
    .action(async (opts) => {
      const intervalSec = Math.max(5, Number(opts.interval || 300));
      const stop = _createStopSignal();
      try {
        while (!stop.stopped()) {
          await sync.force({ account_id: opts.accountId || "", full: Boolean(opts.full) });
          if (stop.stopped()) break;
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch {
        return process.exit(0);
      }
    });

  // code — the single most common reason an agent opens a mailbox at all:
  // "what's the verification code that just arrived?". Doing that with the
  // general commands costs two IMAP round-trips (list, then show the one that
  // looks right) plus a guess about which email it is. This does it in one
  // pass: live list with a body preview, extract codes from subject+preview,
  // return the newest hit. Always live — a cached OTP is a wrong OTP.
  program
    .command("code")
    .description("Newest verification/OTP code across accounts, in one live pass (the 'what's my code' shortcut)")
    .option("--since <s>", "How far back to look", "30m")
    .option("--account-id <id>", "Restrict to one account (default: all accounts)")
    .option("--limit <n>", "How many recent emails to scan", "20")
    .option("--all", "Return every email that yielded a code, not just the newest")
    .option("--preview-chars <n>", "Body chars to scan per email", "1000")
    .action(async (opts) => {
      const paging = _validatePaging(opts.limit, "0", { defaultLimit: 20 });
      if (!paging.ok) process.exit(contract.invalidUsage({ message: paging.error, asJson, pretty }));
      const v = _validateDateOpt("--since", opts.since);
      if (!v.ok) process.exit(contract.invalidUsage({ message: v.error, asJson, pretty }));

      const previewChars = Math.max(200, Math.min(2000, Number(opts.previewChars) || 1000));
      const listed = await email.listEmails({
        limit: paging.limit,
        offset: 0,
        folder: "INBOX",
        account_id: opts.accountId || "",
        date_from: v.expanded || opts.since,
        use_cache: false, // never answer an OTP question from a snapshot
        preview_chars: previewChars,
      });
      if (!listed || listed.success === false) {
        const rc = contract.handleJsonOrText({ result: listed, asJson, pretty, printText: () => {} });
        process.exit(rc);
      }

      const hits = [];
      for (const e of listed.emails || []) {
        // pickVerificationCode (not extractCodes) — the question here is "is this
        // a verification email at all", and extractCodes answers a different one.
        const pick = contract.pickVerificationCode(`${e.subject || ""}\n${e.preview || ""}`);
        if (pick) {
          hits.push({
            code: pick.code,
            confidence: pick.confidence,
            other_candidates: pick.others,
            gid: e.gid,
            account_id: e.account_id,
            folder: e.folder,
            date: e.date,
            from: e.from,
            subject: e.subject,
            unread: e.unread,
          });
        }
      }
      // listEmails returns newest-first, so hits already are.
      const result = {
        success: true,
        command: "code",
        since: opts.since,
        scanned: (listed.emails || []).length,
        matched: hits.length,
        // `code` is the answer; `candidates` is the evidence behind it.
        code: hits.length ? hits[0].code : null,
        ...(hits.length ? { newest: hits[0] } : {}),
        candidates: opts.all ? hits : hits.slice(0, 3),
        ...(hits.length
          ? {}
          : { hint: `no code found in the last ${opts.since}; widen with --since 2h, or raise --limit` }),
      };
      const rc = contract.handleJsonOrText({
        result,
        asJson,
        pretty,
        printText: () => {
          if (!hits.length) { process.stdout.write(`no code in the last ${opts.since}\n`); return; }
          const h = hits[0];
          process.stdout.write(`${h.code}\n  from ${h.from} — ${h.subject}\n  ${h.date}  ${h.gid}\n`);
        },
      });
      process.exit(rc);
    });

  // upgrade
  program
    .command("upgrade")
    .description("Upgrade the installed binary from the latest GitHub Release")
    .option("--check", "Only report whether a newer version exists; change nothing")
    .option("--tag <vX.Y.Z>", "Install this exact release instead of the latest (also allows downgrade)")
    .action(async (opts) => {
      const upgrade = require("./upgrade");
      const current = _resolveCliVersion();
      try {
        if (opts.check) {
          const result = await upgrade.checkForUpdate(current);
          const rc = contract.handleJsonOrText({
            result,
            asJson,
            pretty,
            printText: () => {
              process.stdout.write(
                result.update_available
                  ? `${result.current} -> ${result.latest} available\n  run: mail-use upgrade\n`
                  : `${result.current} is the latest\n`
              );
            },
          });
          process.exit(rc);
        }
        const result = await upgrade.performUpgrade({
          currentVersion: current,
          targetTag: opts.tag || "",
          log: (m) => { if (!asJson) process.stderr.write(`mail-use upgrade: ${m}\n`); },
        });
        const rc = contract.handleJsonOrText({
          result,
          asJson,
          pretty,
          printText: () => {
            if (result.upgraded) {
              process.stdout.write(`upgraded ${result.from} -> ${result.to}\n`);
              const d = result.daemon || {};
              if (!d.was_running) process.stdout.write("  daemon: was not running\n");
              else if (d.restarted) process.stdout.write("  daemon: restarted on the new binary\n");
              else process.stdout.write(`  daemon: RESTART FAILED — still on the old binary${d.error ? ` (${d.error})` : ""}\n    fix with: mail-use daemon install\n`);
            }
            else process.stdout.write(`${result.message || "nothing to do"}\n`);
          },
        });
        process.exit(rc);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        const rc = contract.handleJsonOrText({
          result: { success: false, error: msg, error_code: contract.inferErrorCode(msg) },
          asJson,
          pretty,
          printText: () => process.stderr.write(`upgrade failed: ${msg}\n`),
        });
        process.exit(rc);
      }
    });

  // digest
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
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        return process.exit(rc);
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
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("cleanup") });
      return process.exit(rc);
    });

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
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("digest run") });
      process.exit(rc);
    });
  digestCmd
    .command("config")
    .description("Print current configuration")
    .action(async () => {
      const result = await digest.getConfig();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("digest config") });
      process.exit(rc);
    });

  digestCmd
    .command("daemon")
    .description("Run digest periodically in the foreground")
    .option("--interval <seconds>", "Interval", "3600")
    .option("--dry-run")
    .action(async (opts) => {
      const intervalSec = Math.max(5, Number(opts.interval || 3600));
      const stop = _createStopSignal();
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

  // monitor
  const monitorCmd = program.command("monitor").description("Email monitor workflows");
  monitorCmd
    .command("run")
    .description("Run one monitoring cycle")
    .action(async () => {
      const result = await monitor.run();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor run") });
      process.exit(rc);
    });
  monitorCmd
    .command("status")
    .description("Get monitoring status")
    .action(async () => {
      const result = await monitor.status();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor status") });
      process.exit(rc);
    });
  monitorCmd
    .command("config")
    .description("Print current configuration")
    .action(async () => {
      const result = await monitor.config();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor config") });
      process.exit(rc);
    });
  monitorCmd
    .command("test")
    .description("Test individual components")
    .argument("[component]", "fetch|notify|all", "all")
    .action(async (component) => {
      const result = await monitor.test({ component });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor test") });
      process.exit(rc);
    });

  // daemon
  const daemonCmd = program.command("daemon").description("Persistent IMAP daemon (reuses connections across CLI calls)");
  daemonCmd
    .command("start")
    .description("Start the daemon in the foreground (run with nohup/launchd/systemd to detach)")
    .option("--sync-interval <seconds>", "Run a background sync this often (0 disables)", "300")
    .option("--sync-account-id <id>", "Restrict background sync to one account")
    .action(async (opts) => {
      const { startDaemon } = require("./daemon");
      try {
        const syncIntervalSec = Math.max(0, Number(opts.syncInterval || 0));
        await startDaemon({
          foreground: true,
          syncIntervalMs: syncIntervalSec * 1000,
          syncAccountId: opts.syncAccountId || "",
        });
        // Block forever until SIGINT/SIGTERM
        await new Promise(() => {});
      } catch (e) {
        const result = { success: false, error: (e && e.message) || "daemon failed", error_code: e && e.code === "EADDRINUSE" ? "already_running" : "operation_failed" };
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => process.stderr.write(result.error + "\n") });
        process.exit(rc);
      }
    });
  daemonCmd
    .command("install")
    .description("Install a launchd LaunchAgent (macOS) or systemd user unit (Linux) to autostart the daemon at login")
    .option("--sync-interval <seconds>", "Background sync interval", "300")
    .action(async (opts) => {
      const { installAutostart } = require("./daemon");
      const result = await installAutostart({ syncIntervalSec: Number(opts.syncInterval || 300) });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => {
        if (r.success) process.stdout.write(`installed: ${r.unit_path}\n  next: ${r.activate_hint || "(start it now with: mail-use daemon start)"}\n`);
        else process.stderr.write((r.error || "install failed") + "\n");
      } });
      process.exit(rc);
    });
  daemonCmd
    .command("uninstall")
    .description("Remove the autostart unit and stop the daemon")
    .action(async () => {
      const { uninstallAutostart } = require("./daemon");
      const result = await uninstallAutostart();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => {
        if (r.success) process.stdout.write(`uninstalled: ${r.unit_path || "(no unit found)"}\n`);
        else process.stderr.write((r.error || "uninstall failed") + "\n");
      } });
      process.exit(rc);
    });
  daemonCmd
    .command("status")
    .description("Probe the daemon and report version + pool stats")
    .action(async () => {
      const result = await _daemonAdmin("__ping");
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => {
        if (!r.success) { process.stderr.write((r.error || "not running") + "\n"); return; }
        const upS = r.uptime_ms != null ? Math.round(r.uptime_ms / 1000) : "?";
        process.stdout.write(`daemon pid=${r.pid} uptime=${upS}s\n`);
        process.stdout.write("\npool:\n");
        if (!(r.pool || []).length) process.stdout.write("  (no accounts connected yet — prewarm or first call will populate)\n");
        for (const p of r.pool || []) {
          const inUse = p.in_use != null ? `, ${p.in_use}/${p.clients} in use` : "";
          process.stdout.write(`  ${p.account_id}: ${p.connected ? "connected" : "idle"}${inUse}\n`);
        }
        if (r.sync) {
          process.stdout.write("\nsync:\n");
          process.stdout.write(`  attempted=${r.sync.syncs_attempted} ok=${r.sync.syncs_ok} failed=${r.sync.syncs_failed}\n`);
          if (r.sync.last_sync_at) process.stdout.write(`  last_sync_at=${r.sync.last_sync_at}\n`);
          if (r.sync.last_sync_error) process.stdout.write(`  last_sync_error=${r.sync.last_sync_error}\n`);
          if (r.sync.prewarm) process.stdout.write(`  prewarm=${r.sync.prewarm.completed}/${r.sync.prewarm.started} (${r.sync.prewarm.failed} failed)\n`);
        }
        if (r.update && r.update.update_available) {
          process.stdout.write(`  update: ${r.update.current} -> ${r.update.latest} available (run: mail-use upgrade)\n`);
        }
      } });
      process.exit(rc);
    });
  daemonCmd
    .command("stop")
    .description("Ask the daemon to shut down cleanly")
    .action(async () => {
      const result = await _daemonAdmin("__shutdown");
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => process.stdout.write("daemon stopped\n") });
      process.exit(rc);
    });
  daemonCmd
    .command("reload")
    .description("Drop pooled IMAP connections (e.g. after editing auth.json)")
    .action(async () => {
      const result = await _daemonAdmin("__reload");
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => process.stdout.write("daemon reloaded\n") });
      process.exit(rc);
    });

  // watch
  emailCmd
    .command("watch")
    .description("Stream new emails as they arrive (IMAP IDLE). Prints one NDJSON line per match; runs until SIGINT.")
    .argument("[folder]", "Folder to watch", "INBOX")
    .requiredOption("--account-id <id>")
    .option("--filter-from <s>", "Only emit emails whose sender includes this substring")
    .option("--filter-subject <s>", "Only emit emails whose subject includes this substring")
    .action(async (folder, opts) => {
      const onEvent = (evt) => {
        process.stdout.write(JSON.stringify(evt) + "\n");
      };
      const result = await email.watchFolder({
        account_id: opts.accountId,
        folder: folder || "INBOX",
        filter: { from: opts.filterFrom || "", subject: opts.filterSubject || "" },
        onEvent,
      });
      if (!result || !result.success) {
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => process.stderr.write((result && result.error) || "watch failed\n") });
        process.exit(rc);
      }
      process.stderr.write(`watching ${result.folder} on ${result.account_id} (Ctrl-C to stop)\n`);
      const stop = async () => {
        try { await result.stop(); } catch { /* ignore */ }
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await result.done;
      process.exit(0);
    });

  // mcp
  const mcpCmd = program.command("mcp").description("Model Context Protocol server (for Claude Desktop / Code / Cursor / etc.)");
  mcpCmd
    .command("serve")
    .description("Run the MCP server over stdio. Configure your AI client to spawn this command.")
    .action(async () => {
      const { startStdioServer } = require("./mcp_server");
      try {
        await startStdioServer();
        // Stdio transport keeps reading from stdin; we have to block here so
        // the Node process doesn't exit and tear down the transport.
        await new Promise((resolve) => {
          process.stdin.on("end", resolve);
          process.stdin.on("close", resolve);
          process.on("SIGINT", resolve);
          process.on("SIGTERM", resolve);
        });
        process.exit(0);
      } catch (e) {
        process.stderr.write(`mcp server failed: ${e && e.message}\n`);
        process.exit(1);
      }
    });
  mcpCmd
    .command("config")
    .description("Print a sample MCP client config snippet for Claude Desktop / Code")
    .action(() => {
      // #22：装机版是 pkg 单文件二进制，process.argv[1] 是 snapshot 内的虚拟路径
      // （/snapshot/Mailbox/packages/cli/bin/mail-use.js），在用户机器上并不存在——照着这份
      // config 配的客户端一定起不来。二进制里 execPath 就是 `mail-use` 自己，直接带子命令即可。
      const packaged = process.pkg !== undefined;
      const cfg = {
        mcpServers: {
          "mail-use": {
            command: process.execPath,
            args: packaged ? ["mcp", "serve"] : [process.argv[1] || "mail-use", "mcp", "serve"],
          },
        },
      };
      const result = { success: true, config: cfg, hint: "Add the mcpServers entry to your client's config (e.g. ~/Library/Application Support/Claude/claude_desktop_config.json on macOS)" };
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => process.stdout.write(JSON.stringify(cfg, null, 2) + "\n") });
      process.exit(rc);
    });

  // inbox
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
      const rc = contract.handleJsonOrText({
        result,
        asJson,
        pretty,
        printText: (r) => {
          if (r && r.summary_text) process.stdout.write(String(r.summary_text) + "\n");
          const stats = r && r.stats;
          if (stats) {
            process.stdout.write(`spam: ${stats.delete_spam || 0}, marketing: ${stats.delete_marketing || 0}, mark_read: ${stats.mark_as_read || 0}, attention: ${stats.needs_attention || 0}\n`);
          }
        },
      });
      process.exit(rc);
    });

  // Default interactive mode if no command.
  if (!parsed.argv.length) {
    return contract.invalidUsage({ message: "No command provided", asJson, pretty });
  }

  // --help --json: emit a structured help descriptor for AI introspection
  // instead of letting commander print human text and exit.
  if (asJson && parsed.argv.some((a) => a === "--help" || a === "-h")) {
    const argvNoHelp = parsed.argv.filter((a) => a !== "--help" && a !== "-h");
    const { cmd, unknown } = _findCommandPath(program, argvNoHelp);
    if (unknown) {
      // Don't let `<unknown-cmd> --help --json` falsely report success — that
      // misleads an agent into thinking the command exists.
      const result = {
        success: false,
        error: `Unknown command: ${unknown}`,
        error_code: "invalid_argument",
        help: _commandToJson(cmd),
      };
      contract.handleJsonOrText({ result, asJson, pretty, printText: () => {} });
      return 2;
    }
    const result = { success: true, help: _commandToJson(cmd) };
    contract.handleJsonOrText({ result, asJson, pretty, printText: () => {} });
    return 0;
  }

  try {
    await program.parseAsync(["node", "mail-use", ...parsed.argv]);
    return 0;
  } catch (err) {
    if (
      err &&
      (err.code === "commander.help" ||
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.version") &&
      err.exitCode === 0
    ) {
      return 0;
    }
    // commander throws on invalid usage (exitOverride).
    let message = err && err.message ? err.message : "Invalid usage";
    // Strip commander's own "error: " prefix so the JSON payload doesn't
    // end up with `"error": "error: ..."`.
    message = String(message).replace(/^error:\s*/i, "");
    return contract.invalidUsage({ message, asJson, pretty });
  }
}

module.exports = { main, _groupTargets, _groupsBreakdown, _isSpecialMutationFolder };
