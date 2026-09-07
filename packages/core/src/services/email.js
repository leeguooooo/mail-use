const fs = require("fs");
const path = require("path");

const { paths } = require("@mail-use/shared");

const accounts = require("./accounts");
const { withImapClient } = require("./imap");
const { sendMail } = require("./smtp");
const { formatDateTime, firstAddress, hasAttachmentsFromBodyStructure, attachmentFlags, formatSize } = require("./format");
const syncDb = require("../storage/sync_db");

function _isTestMode() {
  // Internal sentinel only — kept narrowly named to avoid colliding with any
  // env a user might set. Tests must opt in explicitly.
  return String(process.env.MAILBOX_INTERNAL_TEST_MODE || "").trim() === "1";
}

// Freshness window for cache-served list/recent. When a cached read comes back
// with fewer rows than requested AND its newest sync is older than this many
// seconds, listEmails self-heals by falling through to a live IMAP fetch — so a
// just-arrived email (e.g. an OTP) isn't silently missed between syncs. Set to
// 0 to disable the auto-fallback (cache results are then always trusted as-is).
// Read lazily (per call) so the env var can be overridden at runtime/in tests.
const CACHE_FRESH_SECONDS_DEFAULT = 120; // conservative default
function _cacheFreshSeconds() {
  const raw = process.env.MAILBOX_CACHE_FRESH_SECONDS;
  if (raw == null || String(raw).trim() === "") return CACHE_FRESH_SECONDS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : CACHE_FRESH_SECONDS_DEFAULT;
}

// Second, much larger threshold: the point where the cache stops being a
// slightly-behind snapshot and becomes evidence that nothing is syncing at all
// (daemon never installed, stopped, or broken). The freshness window above is
// deliberately short and only self-heals a *thin* result — a full page of rows
// is trusted, which is right when the snapshot is minutes old and wrong when it
// is months old. Without this, `email recent` answers "your latest mail" with
// whatever was in the box the day sync died, success:true, no warning.
// Beyond this age we always go live, however many rows the cache can produce.
// Set to 0 to disable.
const CACHE_ABANDONED_SECONDS_DEFAULT = 24 * 60 * 60; // 1 day
function _cacheAbandonedSeconds() {
  const raw = process.env.MAILBOX_CACHE_STALE_SECONDS;
  if (raw == null || String(raw).trim() === "") return CACHE_ABANDONED_SECONDS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : CACHE_ABANDONED_SECONDS_DEFAULT;
}

function _humanAge(sec) {
  if (sec == null) return "unknown";
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)}m`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

// Hard caps to defend against hostile mail. Override via env if needed.
const MAX_MESSAGE_BYTES = Number(process.env.MAILBOX_MAX_MESSAGE_BYTES || 50 * 1024 * 1024); // 50 MiB
const MAX_ATTACHMENT_BYTES = Number(process.env.MAILBOX_MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024); // 25 MiB per file
const MAX_ATTACHMENTS_TOTAL = Number(process.env.MAILBOX_MAX_ATTACHMENTS_BYTES || 100 * 1024 * 1024); // 100 MiB total

async function _safeParse(source) {
  if (source && Buffer.isBuffer(source) && source.length > MAX_MESSAGE_BYTES) {
    throw new Error(`Message exceeds MAILBOX_MAX_MESSAGE_BYTES (${MAX_MESSAGE_BYTES})`);
  }
  const { simpleParser } = require("mailparser");
  return simpleParser(source, {
    maxHtmlLengthToParse: MAX_MESSAGE_BYTES,
  });
}

function _normalizeFolder(folder) {
  const f = String(folder || "").trim();
  if (!f) return "INBOX";
  if (f.toLowerCase() === "all") return "INBOX";
  return f;
}

// Self-describing global id: account_id:folder:uid. The folder segment lets
// `show` open the right mailbox without the caller passing --folder. Parsing is
// backward-compatible with the legacy 2-part account_id:uid form.
function _gid(accountId, folder, uid) {
  return `${accountId}:${folder || "INBOX"}:${uid}`;
}

// imapflow's client.list() returns Promise<Array> in current versions but has
// historically been documented as async-iterable. Tolerate both shapes.
async function _listMailboxes(client) {
  if (typeof client.list !== "function") return [];
  const r = client.list();
  if (r && typeof r.then === "function") {
    const arr = await r;
    return Array.isArray(arr) ? arr : [];
  }
  if (r && typeof r[Symbol.asyncIterator] === "function") {
    const out = [];
    for await (const mb of r) out.push(mb);
    return out;
  }
  return Array.isArray(r) ? r : [];
}

// Pick selectable folder paths to scan when the caller asks for --folder all.
// Skip \Noselect containers (e.g. "[Gmail]") and Gmail's "All Mail" alias to
// avoid double-counting messages that already appear in INBOX/Spam/etc.
function _selectableFoldersFor(mailboxes) {
  const out = [];
  for (const mb of mailboxes || []) {
    const path = mb.path || mb.name || "";
    if (!path) continue;
    const flags = Array.isArray(mb.flags) ? mb.flags : [];
    const flagSet = new Set(flags.map((f) => String(f)));
    if (flagSet.has("\\Noselect") || flagSet.has("\\NonExistent")) continue;
    const special = String(mb.specialUse || "");
    if (special === "\\All") continue; // Gmail's "All Mail" duplicates everything else.
    out.push(path);
  }
  return out;
}

function _uidsSortedDesc(uids) {
  return [...uids].map((n) => Number(n)).filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
}

// Compare email date strings as instants, not lex strings. Falls back to lex
// only when both dates are unparseable, so we still get stable ordering.
function _compareDatesDesc(a, b) {
  const av = a ? Date.parse(String(a).replace(" ", "T")) : NaN;
  const bv = b ? Date.parse(String(b).replace(" ", "T")) : NaN;
  const aOk = Number.isFinite(av);
  const bOk = Number.isFinite(bv);
  if (aOk && bOk) return bv - av;
  if (aOk) return -1;
  if (bOk) return 1;
  return String(b || "").localeCompare(String(a || ""));
}

function _dateOnly(raw) {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw);
}

function _isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Expand relative date shortcuts (today, yesterday, last-week, and <N><unit>
// with unit ∈ m h d w mo y) into a concrete date string. Lives in core so BOTH
// the CLI and the MCP server get the behavior the MCP schema advertises — the
// MCP path used to pass "2d" straight through, where new Date("2d") => NaN and
// the filter was silently dropped.
function _expandRelativeDate(raw) {
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
    if (unit === "d" || unit === "w" || unit === "mo" || unit === "y") return _isoDate(d);
    return d.toISOString();
  }
  return String(raw || "").trim(); // pass through to the strict parser
}

function _parseDateInput(raw, { end = false } = {}) {
  const raw0 = String(raw || "").trim();
  const value = _expandRelativeDate(raw0);
  if (!value) return { date: null, sql: "" };

  const unparseable = () => ({ date: null, sql: "", warning: `Ignored unparseable date "${raw0}"` });

  if (_dateOnly(value)) {
    const start = new Date(`${value}T00:00:00`);
    if (Number.isNaN(start.getTime())) return unparseable();
    if (end) {
      const before = new Date(start.getTime());
      before.setDate(before.getDate() + 1);
      return { date: before, sql: `${value} 23:59:59` };
    }
    return { date: start, sql: `${value} 00:00:00` };
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return unparseable();
  const sql = formatDateTime(d) || value;
  if (end) return { date: new Date(d.getTime() + 1000), sql };
  return { date: d, sql };
}

async function _fetchEmailsForAccount({ account, folder, limit, offset, unreadOnly, since, before, previewChars = 0, includeServerUids = false, includeAccountUnread = false }) {
  const openFolder = _normalizeFolder(folder);
  return withImapClient(account, async (client) => {
    const st = await client.mailboxOpen(openFolder);
    // ImapFlow defaults to sequence numbers; force UID mode.
    const criteria = unreadOnly ? { seen: false } : { all: true };
    if (since) criteria.since = since;
    if (before) criteria.before = before;
    const uids = await client.search(criteria, { uid: true });

    // mailboxOpen.unseen is the SEQUENCE NUMBER of the first unseen
    // message (often undefined on Gmail when there's no first-unseen
    // marker), not the unread count. Issue STATUS UNSEEN to get the
    // real count — except when we just ran SEARCH UNSEEN ourselves,
    // because then the search result IS the unread count and a STATUS
    // round-trip would be redundant.
    let unseenCount = 0;
    let unseenStatusError = null;
    if (unreadOnly) {
      unseenCount = Array.isArray(uids) ? uids.length : 0;
    } else {
      try {
        const ss = await client.status(openFolder, { unseen: true });
        if (ss && ss.unseen != null) unseenCount = Number(ss.unseen);
      } catch (e) {
        // Some servers reject STATUS on the SELECTED mailbox. Surface the
        // failure as an explicit field so callers can tell "0 unread" from
        // "we couldn't ask". Also log when debug is on.
        unseenStatusError = (e && e.message) || String(e);
        if (process.env.MAILBOX_DAEMON_DEBUG) process.stderr.write(`mail-use: STATUS UNSEEN failed for ${account.email}/${openFolder}: ${unseenStatusError}\n`);
      }
    }
    const sorted = _uidsSortedDesc(uids);
    const slice = sorted.slice(offset, offset + limit);
    const allUidsAreComplete = !unreadOnly && !since && !before;

    const wantPreview = previewChars > 0 && slice.length > 0 && slice.length <= 50;
    const emails = [];
    for await (const msg of client.fetch(
      slice,
      {
        envelope: true,
        flags: true,
        internalDate: true,
        bodyStructure: true,
        source: wantPreview,
      },
      { uid: true }
    )) {
      const env = msg.envelope || {};
      const flags = msg.flags || new Set([]);
      const unread = !flags.has("\\Seen");
      const item = {
        id: String(msg.uid),
        uid: String(msg.uid),
        gid: _gid(account.id, openFolder, msg.uid),
        message_id: env.messageId || "",
        subject: env.subject || "",
        from: firstAddress(env.from),
        date: formatDateTime(msg.internalDate || env.date),
        unread,
        has_attachments: hasAttachmentsFromBodyStructure(msg.bodyStructure),
        account: account.email,
        account_id: account.id,
        folder: openFolder,
        source: "imap_fetch",
      };
      if (wantPreview && msg.source) {
        try {
          const parsed = await _safeParse(msg.source);
          const txt = String(parsed.text || "").replace(/\s+/g, " ").trim();
          item.preview = txt.slice(0, previewChars);
          if (txt.length > previewChars) item.preview_truncated = true;
        } catch {
          item.preview = "";
        }
      }
      emails.push(item);
    }

    // Optional: unread across all selectable folders for this account. One cheap
    // STATUS UNSEEN per folder; opt-in because it adds a round-trip per folder.
    let account_unread_total = null;
    if (includeAccountUnread) {
      try {
        const mailboxes = await _listMailboxes(client);
        const folders = _selectableFoldersFor(mailboxes);
        let sum = 0;
        for (const fpath of folders) {
          const ss = await client.status(fpath, { unseen: true });
          if (ss && ss.unseen != null) sum += Number(ss.unseen);
        }
        account_unread_total = sum;
      } catch {
        account_unread_total = null;
      }
    }

    const result = {
      success: true,
      emails,
      total_in_folder: Number(st.exists || 0),
      unread_count: unseenCount,
      folder_unread: unseenCount,
      account_unread_total,
      ...(unseenStatusError ? { unread_count_unavailable: true, unread_count_error: unseenStatusError } : {}),
      fetched: emails.length,
      folder: openFolder,
    };
    if (includeServerUids && allUidsAreComplete) {
      result.server_uids = sorted.map((uid) => String(uid));
      result.all_uids_are_complete = true;
    }
    return result;
  });
}

async function listEmails({
  limit = 100,
  offset = 0,
  unread_only = false,
  folder = "all",
  account_id = "",
  use_cache = true,
  date_from = "",
  date_to = "",
  preview_chars = 0,
  from = "",
  include_server_uids = false,
  include_account_unread = false,
} = {}) {
  const previewChars = Math.max(0, Number(preview_chars || 0));
  const fromFilter = String(from || "").trim();
  const includeServerUids = Boolean(include_server_uids);
  const includeAccountUnread = Boolean(include_account_unread);
  // The cache backend returns envelope-only rows; preview requires live IMAP.
  if (previewChars > 0) use_cache = false;
  const lim = Math.max(0, Number(limit || 0));
  const off = Math.max(0, Number(offset || 0));
  const unreadOnly = Boolean(unread_only);
  const mergedLimit = lim > 0 ? lim + off : 0;
  const fromParsed = _parseDateInput(date_from);
  const toParsed = _parseDateInput(date_to, { end: true });
  const since = fromParsed.date;
  const before = toParsed.date;
  const sqlFrom = fromParsed.sql;
  const sqlTo = toParsed.sql;
  const dateWarnings = [fromParsed.warning, toParsed.warning].filter(Boolean);

  // Cache read from email_sync.db (python-compatible schema). Falls back to IMAP.
  if (use_cache) {
    try {
      const pc = paths.getPathConfig();
      const resolved = account_id ? accounts.getAccountByIdOrEmail(account_id) : null;
      const resolvedId = resolved && resolved.success ? resolved.account.id : "";
      const cache = await require("../storage/sync_db").listEmailsFromCache({
        dbPath: pc.emailSyncDb,
        accountId: resolvedId || "",
        folder,
        unreadOnly,
        limit: lim,
        offset: off,
        dateFrom: sqlFrom,
        dateTo: sqlTo,
        from: fromFilter,
        includeAccountUnread,
      });
      if (cache && cache.success) {
        const returned = Array.isArray(cache.emails) ? cache.emails.length : 0;
        const thin = lim > 0 && returned < lim; // empty or fewer rows than asked for
        const ageSec = cache.cache_age_seconds; // null = unknown freshness
        const freshSeconds = _cacheFreshSeconds();
        const stale = freshSeconds > 0 && (ageSec == null || ageSec > freshSeconds);
        const abandonedSeconds = _cacheAbandonedSeconds();
        // MAILBOX_CACHE_FRESH_SECONDS=0 is the documented "trust the cache, never
        // auto-fallback" escape hatch, so it disables this rule too.
        // Unknown age can't prove abandonment; the thin+stale rule already
        // covers it, so don't force every call live on a null age.
        const abandoned =
          freshSeconds > 0 && abandonedSeconds > 0 && ageSec != null && ageSec > abandonedSeconds;

        // Self-heal in two cases:
        //  - thin AND stale: the silent-miss case (asking for the latest mail
        //    seconds after it arrived, before the next sync). A thin-but-fresh
        //    read is trusted — the folder genuinely has that few.
        //  - abandoned: the snapshot is so old that nothing is syncing. Row
        //    count says nothing here; a full page of months-old mail is exactly
        //    the answer we must not give.
        if ((thin && stale) || abandoned) {
          if (process.env.MAILBOX_DEBUG) {
            const why = abandoned
              ? `abandoned (age ${_humanAge(ageSec)} > ${abandonedSeconds}s)`
              : `thin (${returned}/${lim}) and stale (age ${_humanAge(ageSec)} > ${freshSeconds}s)`;
            process.stderr.write(`mail-use: cache ${why} — refetching live\n`);
          }
          // fall through to the live IMAP path below
        } else {
          // Add multi-account metadata similar to Python contract.
          const all = accounts.getAllAccountsResolved();
          const accounts_count = resolvedId ? 1 : (all.success ? (all.accounts || []).length : 0);
          // Annotate stale cache reads with a machine-readable flag plus a hint
          // naming the lever. Previously only *thin* results got the nudge, so a
          // full page served from a snapshot older than the freshness window
          // looked indistinguishable from a live read.
          // Two independent reasons to nudge: the page is short (something may
          // be missing) or the snapshot is behind (what's here may be old).
          const hint =
            thin || stale
              ? `served from cache (age ${_humanAge(ageSec)}${thin ? `, ${returned}/${lim} rows` : ""}); pass --live (or use_cache=false) to force a live IMAP fetch`
              : undefined;
          return {
            ...cache,
            total_emails: cache.total_in_folder,
            total_unread: cache.unread_count,
            accounts_count,
            accounts_info: [],
            cache_stale: Boolean(stale),
            ...(hint ? { hint } : {}),
            ...(dateWarnings.length ? { warnings: dateWarnings } : {}),
          };
        }
      }
    } catch (e) {
      // Cache failed → fall through to live IMAP. Surface the reason so users
      // can tell why use_cache=true didn't actually use the cache.
      process.stderr.write(`mail-use: cache read failed, falling back to live IMAP: ${e && e.message ? e.message : e}\n`);
    }
  }

  const results = [];

  if (account_id) {
    const acc = accounts.getAccountByIdOrEmail(account_id);
    if (!acc.success) return acc;
    const r = await _fetchEmailsForAccount({ account: acc.account, folder, limit: lim, offset: off, unreadOnly, since, before, previewChars, includeServerUids, includeAccountUnread });
    if (!r.success) return r;
    results.push({ account: acc.account, ...r });
  } else {
    const all = accounts.getAllAccountsResolved();
    if (!all.success) return all;
    const list = all.accounts || [];
    if (!list.length) {
      // Keep Python-like behavior: no accounts -> success with empty.
      return {
        success: true,
        emails: [],
        total_in_folder: 0,
        unread_count: 0,
        folder_unread: 0,
        unread_in_result: 0,
        account_unread_total: null,
        unread_as_of: null,
        cache_age_seconds: null,
        total_emails: 0,
        total_unread: 0,
        accounts_count: 0,
        accounts_info: [],
        offset: off,
        limit: lim,
        from_cache: false,
      };
    }

    for (const acc of list) {
      try {
        const r = await _fetchEmailsForAccount({
          account: acc,
          folder,
          limit: mergedLimit,
          offset: 0,
          unreadOnly,
          since,
          before,
          previewChars,
          includeServerUids,
          includeAccountUnread,
        });
        results.push({ account: acc, ...r });
      } catch (e) {
        results.push({ account: acc, success: false, error: e && e.message ? e.message : "fetch failed" });
      }
    }
  }

  const ok = results.filter((r) => r.success);
  const allEmails = ok.flatMap((r) => r.emails || []);
  allEmails.sort((a, b) => _compareDatesDesc(a.date, b.date));
  const emails = lim > 0 ? allEmails.slice(off, off + lim) : [];

  const returnedByAccount = new Map();
  for (const e of emails) {
    const key = e.account_id || e.account || "";
    if (!key) continue;
    returnedByAccount.set(key, (returnedByAccount.get(key) || 0) + 1);
  }

  const accounts_info = results.map((r) => {
    const total = r.total_in_folder != null ? r.total_in_folder : 0;
    const unread = r.unread_count != null ? r.unread_count : 0;
    const fetched_raw = (r.emails || []).length;
    const accountId = r.account && r.account.id ? r.account.id : "";
    const accountEmail = r.account && r.account.email ? r.account.email : "";
    const key = accountId || accountEmail;
    const returned = key ? returnedByAccount.get(key) || 0 : 0;
    return {
      account: accountEmail,
      account_id: accountId,
      total,
      unread,
      fetched: returned,
      fetched_raw,
    };
  });

  const total_in_folder = ok.reduce((sum, r) => sum + Number(r.total_in_folder || 0), 0);
  const unread_count = ok.reduce((sum, r) => sum + Number(r.unread_count || 0), 0);
  const unread_in_result = emails.filter((e) => e.unread).length;
  // account_unread_total is null unless opted in; sum the per-account totals.
  const accountTotals = ok.map((r) => r.account_unread_total).filter((v) => v != null);
  const account_unread_total = includeAccountUnread && accountTotals.length
    ? accountTotals.reduce((s, v) => s + Number(v || 0), 0)
    : null;

  const out = {
    success: ok.length === results.length,
    emails,
    total_in_folder,
    unread_count,
    folder_unread: unread_count,
    unread_in_result,
    account_unread_total,
    unread_as_of: null, // live counts are current
    cache_age_seconds: null, // live fetch — not from a cache snapshot
    total_emails: total_in_folder,
    total_unread: unread_count,
    accounts_count: results.length,
    accounts_info,
    offset: off,
    limit: lim,
    from_cache: false,
    ...(dateWarnings.length ? { warnings: dateWarnings } : {}),
  };
  if (includeServerUids) {
    const complete = ok.filter((r) => r.all_uids_are_complete);
    out.all_uids_are_complete = ok.length > 0 && complete.length === ok.length;
    if (ok.length === 1 && complete.length === 1) out.server_uids = complete[0].server_uids || [];
  }
  return out;
}

// Pure deadline predicate (extracted so the timeout logic is unit-testable
// without timing flakiness). timeoutMs <= 0 means "no deadline".
function _deadlineExceeded(started, timeoutMs, now) {
  const t = Number(timeoutMs || 0);
  if (!(t > 0)) return false;
  return (Number(now != null ? now : Date.now()) - Number(started)) >= t;
}

// HARD wall-clock bound: resolve with `promise`'s value, or `onTimeout()` if it
// doesn't settle within `ms`. The cooperative _deadlineExceeded checks only fire
// BETWEEN imap operations; a single slow op (e.g. a QQ/163 client-side scan of a
// whole INBOX, or a stuck connect) can block past the deadline. This guarantees
// searchEmails returns even then. The orphaned op is harmless for the one-shot
// CLI (process.exit cleans up); the daemon closes the connection on its own.
// `promise` rejections pass through so existing try/catch handling still runs.
function _raceTimeout(promise, ms, onTimeout) {
  if (!(ms > 0)) return promise;
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    guard,
  ]);
}

async function searchEmails({ query, from = "", subject = "", account_id = "", date_from = "", date_to = "", limit = 50, offset = 0, unread_only = false, folder = "all", preview_chars = 0, timeout_ms = 0 } = {}) {
  const previewChars = Math.max(0, Number(preview_chars || 0));
  const timeoutMs = Math.max(0, Number(timeout_ms || 0));
  const q = String(query || "").trim();
  const fromQ = String(from || "").trim();
  const subjQ = String(subject || "").trim();

  const lim = Math.max(0, Number(limit || 0));
  const off = Math.max(0, Number(offset || 0));
  const unreadOnly = Boolean(unread_only);

  const started = Date.now();
  const folderRaw = String(folder || "").trim();
  const scanAll = folderRaw.toLowerCase() === "all";
  const openFolder = _normalizeFolder(folder);

  const df = date_from ? new Date(String(date_from)) : null;
  const dt = date_to ? new Date(String(date_to)) : null;
  const since = df && !Number.isNaN(df.getTime()) ? df : null;
  const before = dt && !Number.isNaN(dt.getTime()) ? dt : null;

  if (!q && !fromQ && !subjQ && !since && !before && !unreadOnly) {
    return { success: false, error: "Provide at least one of query, from, subject, date_from, date_to, unread_only" };
  }

  const baseCriteria = {};
  if (unreadOnly) baseCriteria.seen = false;
  else baseCriteria.all = true;

  // Prefer server-side filtering.
  if (q) baseCriteria.text = q;
  if (fromQ) baseCriteria.from = fromQ;
  if (subjQ) baseCriteria.subject = subjQ;
  if (since) baseCriteria.since = since;
  if (before) baseCriteria.before = before;

  // Gmail's IMAP TEXT search is unreliable across providers — and many
  // Chinese providers (QQ/163) ignore TEXT entirely and return everything.
  // For Gmail we have X-GM-RAW (the same engine the web UI uses), which is
  // dramatically more accurate. We build a Gmail query string and pass it
  // through imapflow's `gmailRaw` criterion when the account is Gmail.
  function _gmailRawFor(acc) {
    const host = String((acc && acc.imap && acc.imap.host) || "").toLowerCase();
    const provider = String((acc && acc.provider) || "").toLowerCase();
    const isGmail = provider === "gmail" || host.includes("gmail") || host.includes("googlemail");
    if (!isGmail) return null;
    const parts = [];
    if (q) parts.push(q.includes(" ") ? `"${q.replace(/"/g, '\\"')}"` : q);
    if (fromQ) parts.push(`from:${fromQ}`);
    if (subjQ) parts.push(subjQ.includes(" ") ? `subject:"${subjQ.replace(/"/g, '\\"')}"` : `subject:${subjQ}`);
    if (since) parts.push(`after:${_gmailDate(since)}`);
    if (before) parts.push(`before:${_gmailDate(before)}`);
    if (unreadOnly) parts.push("is:unread");
    return parts.join(" ");
  }
  function _gmailDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  }

  const failed_accounts = [];
  const perAccount = [];

  const targets = [];
  if (account_id) {
    const acc = accounts.getAccountByIdOrEmail(account_id);
    if (!acc.success) return acc;
    targets.push(acc.account);
  } else {
    const all = accounts.getAllAccountsResolved();
    if (!all.success) return all;
    targets.push(...(all.accounts || []));
  }

  // Fetch more than needed per account so we can merge and slice globally.
  const perAccountFetchLimit = Math.max(lim + off, 200);

  async function _searchOneFolder(client, acc, folderPath) {
    const lock = await client.getMailboxLock(folderPath);
    try {
      const gmailRaw = _gmailRawFor(acc);
      const criteria = gmailRaw
        ? { gmailRaw, ...(unreadOnly ? { seen: false } : {}) }
        : baseCriteria;
      // Known-broken IMAP servers where SEARCH TEXT/FROM/SUBJECT either returns
      // every UID, or returns 0 for any non-ASCII / substring match. These
      // providers force client-side filtering whenever the caller supplied
      // any text filter, regardless of what SEARCH returned.
      const host = String((acc && acc.imap && acc.imap.host) || "").toLowerCase();
      const provider = String((acc && acc.provider) || "").toLowerCase();
      const isBrokenSearchProvider = !gmailRaw && (
        ["163", "qq", "126", "sina", "yeah", "aliyun", "outlook"].includes(provider) ||
        /(?:163|126|qq|sina|yeah|aliyun|mxhichina)\.com|\.qq\.com|outlook\.com/.test(host)
      );
      const hadTextFilter = !gmailRaw && (q || fromQ || subjQ);
      let usedClientFilter = false;
      let uids;
      let total = 0;
      const mailboxTotal = Number((client.mailbox && client.mailbox.exists) || 0);

      if (hadTextFilter && isBrokenSearchProvider) {
        usedClientFilter = true;
      } else {
        uids = await client.search(criteria, { uid: true });
        total = Array.isArray(uids) ? uids.length : 0;
        // Generic fallback: SEARCH returned almost the whole mailbox even
        // though we asked for a text filter — it ignored us.
        const looksIgnored = hadTextFilter && mailboxTotal > 0 && total >= Math.max(50, Math.floor(mailboxTotal * 0.9));
        if (looksIgnored) usedClientFilter = true;
      }

      if (usedClientFilter) {
        const dateOnly = {};
        if (unreadOnly) dateOnly.seen = false;
        else dateOnly.all = true;
        if (since) dateOnly.since = since;
        if (before) dateOnly.before = before;
        const dateUids = await client.search(dateOnly, { uid: true });
        uids = Array.isArray(dateUids) ? dateUids : [];
        total = uids.length;
      }

      const sorted = _uidsSortedDesc(uids);
      // When we'll filter client-side we may need to fetch many to find a few.
      // Cap at 5000 envelopes per folder to bound work. Lower the cap when
      // preview is requested, because each fetch also pulls the message
      // source — pulling 5000 full bodies would be huge and slow.
      const clientCap = previewChars > 0 ? 500 : 5000;
      const fetchCap = usedClientFilter ? Math.min(clientCap, sorted.length) : Math.min(perAccountFetchLimit, sorted.length);
      const slice = sorted.slice(0, fetchCap);

      // NOTE: in client-filter mode we only have envelope data (no
      // message body), so `query` matches against subject + from only.
      // Pure body-text matches will be missed on broken-search providers
      // (163/QQ/126/sina/aliyun/outlook). Use `from`/`subject` filters
      // for predictable results, or rely on Gmail's X-GM-RAW path which
      // does search bodies server-side.
      const qLower = q.toLowerCase();
      const fromLower = fromQ.toLowerCase();
      const subjLower = subjQ.toLowerCase();
      const matchesClient = (env) => {
        if (!usedClientFilter) return true;
        const subj = String(env.subject || "");
        const fromAddr = firstAddress(env.from) || "";
        if (fromLower && !fromAddr.toLowerCase().includes(fromLower)) return false;
        if (subjLower && !subj.toLowerCase().includes(subjLower)) return false;
        if (qLower) {
          const hay = (subj + " " + fromAddr).toLowerCase();
          if (!hay.includes(qLower)) return false;
        }
        return true;
      };

      const emails = [];
      let matched = 0;
      let folderTimedOut = false;
      const wantPreview = previewChars > 0;
      if (slice.length > 0) {
        for await (const msg of client.fetch(
          slice,
          { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: wantPreview },
          { uid: true }
        )) {
          // Cooperative bound: a broken-search provider (QQ/163) may stream
          // thousands of envelopes to filter client-side. Stop at the deadline
          // and return what we have rather than scanning the whole mailbox.
          if (_deadlineExceeded(started, timeoutMs)) {
            folderTimedOut = true;
            break;
          }
          const env = msg.envelope || {};
          if (!matchesClient(env)) continue;
          matched += 1;
          if (emails.length >= perAccountFetchLimit) continue;
          const flags = msg.flags || new Set([]);
          const unread = !flags.has("\\Seen");
          const item = {
            id: String(msg.uid),
            uid: String(msg.uid),
            gid: _gid(acc.id, folderPath, msg.uid),
            subject: env.subject || "",
            from: firstAddress(env.from),
            to: firstAddress(env.to),
            date: formatDateTime(msg.internalDate || env.date),
            unread,
            flagged: flags.has("\\Flagged"),
            is_flagged: flags.has("\\Flagged"),
            has_attachments: hasAttachmentsFromBodyStructure(msg.bodyStructure),
            message_id: env.messageId || "",
            account: acc.email,
            account_id: acc.id,
            folder: folderPath,
            preview: "",
          };
          if (wantPreview && msg.source) {
            try {
              const parsed = await _safeParse(msg.source);
              const txt = String(parsed.text || "").replace(/\s+/g, " ").trim();
              item.preview = txt.slice(0, previewChars);
              if (txt.length > previewChars) item.preview_truncated = true;
            } catch {
              // ignore preview parse failures
            }
          }
          emails.push(item);
        }
      }
      const totalReported = usedClientFilter ? matched : total;
      const out = { total_found: totalReported, emails };
      if (folderTimedOut) out.timed_out = true;
      if (usedClientFilter) out.client_filter = { fetched: slice.length, mailbox_total: mailboxTotal };
      return out;
    } finally {
      lock.release();
    }
  }

  let timed_out = false;
  const pending_accounts = [];
  for (const acc of targets) {
    // Bound the whole search: a cross-account / --folder all scan over slow
    // (client-side-filtered) providers could otherwise run unbounded. On
    // timeout we stop scanning and return whatever we have so far.
    if (_deadlineExceeded(started, timeoutMs)) {
      timed_out = true;
      pending_accounts.push(acc.id || acc.email || "");
      continue;
    }
    try {
      const accountWork = withImapClient(acc, async (client) => {
        const folderPaths = scanAll
          ? _selectableFoldersFor(await _listMailboxes(client))
          : [openFolder];
        if (folderPaths.length === 0) folderPaths.push("INBOX");

        let totalCombined = 0;
        const emailsCombined = [];
        const folderErrors = [];
        for (const fp of folderPaths) {
          if (_deadlineExceeded(started, timeoutMs)) {
            timed_out = true;
            folderErrors.push({ folder: fp, error: "skipped: search timed out" });
            break;
          }
          try {
            const part = await _searchOneFolder(client, acc, fp);
            totalCombined += part.total_found;
            emailsCombined.push(...part.emails);
            if (part.timed_out) timed_out = true;
          } catch (fe) {
            folderErrors.push({ folder: fp, error: fe && fe.message ? fe.message : "search failed" });
          }
        }

        const out = { success: true, total_found: totalCombined, emails: emailsCombined };
        if (folderErrors.length) out.folder_errors = folderErrors;
        return out;
      });
      // Hard-bound the account by whatever time remains in the overall deadline,
      // so a single un-cooperative imap op (QQ/163 scan / stuck connect) can't
      // blow past --timeout. On timeout we keep the partial emails gathered so far.
      const remaining = timeoutMs > 0 ? Math.max(0, started + timeoutMs - Date.now()) : 0;
      const r = await _raceTimeout(accountWork, remaining, () => {
        timed_out = true;
        pending_accounts.push(acc.id || acc.email || "");
        return { success: true, total_found: 0, emails: [], account_timed_out: true };
      });
      perAccount.push({ account: acc, ...r });
    } catch (e) {
      failed_accounts.push({ account: acc.email || "", account_id: acc.id || "", error: e && e.message ? e.message : "search failed" });
      perAccount.push({ account: acc, success: false, error: e && e.message ? e.message : "search failed", total_found: 0, emails: [] });
    }
  }

  const allEmails = perAccount.flatMap((r) => (r && r.success ? r.emails || [] : []));
  allEmails.sort((a, b) => _compareDatesDesc(a.date, b.date));

  const page = allEmails.slice(off, off + lim);
  const total_found = perAccount.reduce((sum, r) => sum + Number((r && r.total_found) || 0), 0);
  const accounts_count = targets.length;
  const search_time = (Date.now() - started) / 1000;

  return {
    success: failed_accounts.length === 0,
    emails: page,
    total_found,
    displayed: page.length,
    accounts_count,
    offset: off,
    limit: lim,
    total_emails: page.length,
    accounts_searched: accounts_count,
    accounts_info: [],
    search_time,
    timed_out,
    ...(timed_out ? { pending_accounts, timeout_ms: timeoutMs, timed_out_note: `Search exceeded ${timeoutMs}ms and returned partial results; narrow with --account-id / --folder INBOX or raise --timeout` } : {}),
    search_params: { query: q, date_from, date_to, unread_only: unreadOnly, folder },
    failed_accounts,
    failed_searches: [],
    partial_success: failed_accounts.length > 0,
  };
}

function _stripUrls(text) {
  return String(text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

// Dependency-free HTML -> plain text. Good enough to give an agent a readable
// body for HTML-only mail (transactional senders, Moomoo, etc.) without shelling
// out to a parser. Not a sanitizer; output is plain text only.
function _htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|table|ul|ol)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return " ";
      }
    });
  s = s.replace(/[ \t\f\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// Single source of truth for body/html projection across showEmail (live + test)
// and showEmails. html_max_len semantics: <0 = unlimited, 0 = strip, >0 = cap.
// When the text body is empty but html exists, derive a text body from the html.
function _composeBody({ text, html, body_max_len = 0, html_max_len = 0, include_html = true, strip_urls = false }) {
  const includeHtml = include_html !== false;
  const htmlText = typeof html === "string" ? html : "";
  const rawText = String(text || "");
  // HTML-only mail often carries a near-empty text/plain part (just whitespace),
  // so treat whitespace-only text as absent and fall back to the html.
  const hasText = rawText.trim().length > 0;

  let body = hasText ? rawText : "";
  let bodySource = hasText ? "text" : "empty";
  if (!hasText && htmlText) {
    const derived = _htmlToText(htmlText);
    if (derived) {
      body = derived;
      bodySource = "html_derived";
    }
  }

  const bodyBase = strip_urls ? _stripUrls(body) : body;
  const bodyMax = Math.max(0, Number(body_max_len || 0));
  let bodyOut = bodyBase;
  let bodyTruncated = false;
  if (bodyMax > 0 && bodyOut.length > bodyMax) {
    bodyOut = bodyOut.slice(0, bodyMax);
    bodyTruncated = true;
  }

  let htmlOut = "";
  let htmlTruncated = false;
  if (includeHtml) {
    const hm = Number(html_max_len);
    if (hm < 0) {
      htmlOut = htmlText; // unlimited
    } else if (hm === 0) {
      htmlOut = ""; // strip
    } else if (htmlText.length > hm) {
      htmlOut = htmlText.slice(0, hm);
      htmlTruncated = true;
    } else {
      htmlOut = htmlText;
    }
  }

  return {
    body: bodyOut,
    html_body: htmlOut,
    body_source: bodySource,
    body_included: Boolean(bodyOut),
    html_included: includeHtml,
    body_url_stripped: Boolean(strip_urls),
    body_length: bodyBase.length,
    html_length: htmlText.length,
    body_truncated: bodyTruncated,
    html_truncated: htmlTruncated,
  };
}

function _parseListUnsubscribeHeader(value) {
  if (!value) return null;
  const str = Array.isArray(value) ? value.join(", ") : String(value);
  const mailto = (str.match(/<(mailto:[^>]+)>/i) || str.match(/\b(mailto:[^\s,>]+)/i) || [])[1] || null;
  const http = (str.match(/<(https?:[^>]+)>/i) || str.match(/\b(https?:[^\s,>]+)/i) || [])[1] || null;
  if (!mailto && !http) return null;
  return { mailto, http };
}

function _formatListUnsubscribeFromListHeader(unsubscribe) {
  if (!unsubscribe) return null;
  const mail = unsubscribe.mail || "";
  const url = unsubscribe.url || "";
  return {
    mailto: mail ? (String(mail).toLowerCase().startsWith("mailto:") ? mail : `mailto:${mail}`) : null,
    http: url || null,
  };
}

// Extract List-Unsubscribe header values from a mailparser-parsed email.
// mailparser may fold List-Unsubscribe into parsed.headers.get('list').unsubscribe
// or preserve a direct parsed.headers.get('list-unsubscribe') value.
function _extractListUnsubscribe(parsed) {
  if (!parsed || !parsed.headers) return null;
  const list = parsed.headers.get("list");
  const fromList = _formatListUnsubscribeFromListHeader(list && list.unsubscribe);
  if (fromList) return fromList;

  const direct = _parseListUnsubscribeHeader(parsed.headers.get("list-unsubscribe"));
  if (direct) return direct;

  // Fallback: scan raw headerLines.
  if (Array.isArray(parsed.headerLines)) {
    const line = parsed.headerLines.find((h) => h.key === "list-unsubscribe");
    if (line) {
      const fromRaw = _parseListUnsubscribeHeader(line.line || "");
      if (fromRaw) return fromRaw;
    }
  }
  return null;
}

async function showEmail({
  email_id,
  folder = "INBOX",
  account_id = "",
  body_max_len = 0,
  html_max_len = 0,
  include_html = true,
  strip_urls = false,
} = {}) {
  const id = String(email_id || "").trim();
  if (!id) return { success: false, error: "Missing email_id" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const openFolder = _normalizeFolder(folder);
  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const msg = await client.fetchOne(
      Number(id),
      {
        envelope: true,
        flags: true,
        internalDate: true,
        bodyStructure: true,
        source: true,
      },
      { uid: true }
    );
    if (!msg) return { success: false, error: `Email not found: ${id}` };

    if (_isTestMode()) {
      const { getMailbox } = require("../testing/mock_store");
      const mb = getMailbox(acc.account.id, openFolder);
      const raw = mb && mb.messages ? mb.messages.find((m) => String(m.uid) === String(id)) : null;
      if (!raw) return { success: false, error: `Email not found: ${id}` };
      const attachments = (raw.attachments || []).map((a) => ({
        filename: a.filename,
        size: a.content ? a.content.length : 0,
        content_type: a.contentType || "application/octet-stream",
        ...attachmentFlags(a),
      }));
      const unread = !(raw.flags || new Set([])).has("\\Seen");
      const composed = _composeBody({
        text: raw.body,
        html: raw.html,
        body_max_len,
        html_max_len,
        include_html,
        strip_urls,
      });
      return {
        success: true,
        id: String(raw.uid),
        gid: _gid(acc.account.id, openFolder, raw.uid),
        requested_id: String(id),
        from: raw.from,
        to: raw.to,
        cc: raw.cc || "",
        subject: raw.subject,
        date: raw.date,
        ...composed,
        has_html: Boolean(raw.html),
        attachments,
        attachment_count: attachments.length,
        real_attachment_count: attachments.filter((x) => x.is_real_attachment).length,
        has_attachments: attachments.some((x) => x.is_real_attachment),
        unread,
        message_id: raw.messageId || "",
        in_reply_to: raw.inReplyTo || "",
        references: raw.references || "",
        folder: openFolder,
        account: acc.account.email,
        account_id: acc.account.id,
        from_cache: false,
      };
    }

    const parsed = await _safeParse(msg.source);
    const flags = msg.flags || new Set([]);
    const unread = !flags.has("\\Seen");

    const attachments = (parsed.attachments || []).map((a) => ({
      filename: a.filename || "",
      size: a.size || 0,
      content_type: a.contentType || "application/octet-stream",
      ...attachmentFlags(a),
    }));

    const composed = _composeBody({
      text: parsed.text,
      html: parsed.html,
      body_max_len,
      html_max_len,
      include_html,
      strip_urls,
    });

    return {
      success: true,
      id: String(msg.uid),
      gid: _gid(acc.account.id, openFolder, msg.uid),
      requested_id: String(id),
      from: parsed.from ? parsed.from.text || "" : firstAddress(msg.envelope && msg.envelope.from),
      to: parsed.to ? parsed.to.text || "" : firstAddress(msg.envelope && msg.envelope.to),
      cc: parsed.cc ? parsed.cc.text || "" : "",
      subject: parsed.subject || (msg.envelope ? msg.envelope.subject : ""),
      date: formatDateTime(parsed.date || msg.internalDate),
      ...composed,
      has_html: Boolean(parsed.html),
      attachments,
      attachment_count: attachments.length,
      real_attachment_count: attachments.filter((x) => x.is_real_attachment).length,
      has_attachments: attachments.some((x) => x.is_real_attachment),
      unread,
      message_id: parsed.messageId || (msg.envelope ? msg.envelope.messageId : ""),
      in_reply_to: parsed.inReplyTo || "",
      references: Array.isArray(parsed.references)
        ? parsed.references.join(" ")
        : (parsed.references || ""),
      folder: openFolder,
      account: acc.account.email,
      account_id: acc.account.id,
      from_cache: false,
      list_unsubscribe: _extractListUnsubscribe(parsed),
    };
  });
}

// Batch fetch multiple emails over a single IMAP connection. Same per-email
// shape as showEmail (minus a few duplicated fields), wrapped in a list.
async function showEmails({
  email_ids,
  folder = "INBOX",
  account_id = "",
  body_max_len = 0,
  html_max_len = 0,
  include_html = true,
  strip_urls = false,
} = {}) {
  const ids = (email_ids || []).map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return { success: false, error: "Missing email_ids" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const openFolder = _normalizeFolder(folder);
  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const emails = [];
    const failed_ids = [];
    for (const id of ids) {
      try {
        const msg = await client.fetchOne(
          Number(id),
          { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: true },
          { uid: true }
        );
        if (!msg) {
          failed_ids.push({ id, error: "not_found" });
          continue;
        }
        const parsed = await _safeParse(msg.source);
        const flags = msg.flags || new Set([]);
        const attachments = (parsed.attachments || []).map((a) => ({
          filename: a.filename || "",
          size: a.size || 0,
          content_type: a.contentType || "application/octet-stream",
          ...attachmentFlags(a),
        }));
        const composed = _composeBody({
          text: parsed.text,
          html: parsed.html,
          body_max_len,
          html_max_len,
          include_html,
          strip_urls,
        });
        emails.push({
          id: String(msg.uid),
          gid: _gid(acc.account.id, openFolder, msg.uid),
          folder: openFolder,
          from: parsed.from ? parsed.from.text || "" : firstAddress(msg.envelope && msg.envelope.from),
          to: parsed.to ? parsed.to.text || "" : firstAddress(msg.envelope && msg.envelope.to),
          cc: parsed.cc ? parsed.cc.text || "" : "",
          subject: parsed.subject || (msg.envelope ? msg.envelope.subject : ""),
          date: formatDateTime(parsed.date || msg.internalDate),
          ...composed,
          has_html: Boolean(parsed.html),
          attachments,
          attachment_count: attachments.length,
          real_attachment_count: attachments.filter((x) => x.is_real_attachment).length,
          has_attachments: attachments.some((x) => x.is_real_attachment),
          unread: !flags.has("\\Seen"),
          message_id: parsed.messageId || (msg.envelope ? msg.envelope.messageId : ""),
          in_reply_to: parsed.inReplyTo || "",
          references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references || ""),
          list_unsubscribe: _extractListUnsubscribe(parsed),
        });
      } catch (e) {
        failed_ids.push({ id, error: e && e.message ? e.message : "fetch failed" });
      }
    }
    return {
      success: failed_ids.length === 0,
      emails,
      failed_ids,
      requested: ids.length,
      returned: emails.length,
      folder: openFolder,
      account_id: acc.account.id,
    };
  });
}

// Resolve which folder an email lives in: an explicit folder wins, otherwise the
// local cache is consulted, otherwise INBOX. Lets `show` open the right mailbox
// without the caller remembering each email's folder.
async function resolveEmailFolder({ account_id = "", uid = "", folder = "" } = {}) {
  if (folder) return _normalizeFolder(folder);
  const acc = accounts.getAccountByIdOrEmail(account_id);
  const accId = acc && acc.success ? acc.account.id : account_id;
  let dbPath = "";
  try {
    dbPath = paths.getPathConfig().emailSyncDb;
  } catch {
    dbPath = "";
  }
  if (dbPath && uid) {
    try {
      const f = await require("../storage/sync_db").lookupFolderForUid({ dbPath, accountId: accId, uid: String(uid) });
      if (f) return f;
    } catch {
      /* ignore */
    }
  }
  return "INBOX";
}

// Folder-aware batch show. refs: [{ id, folder }]. A ref's folder may come from a
// 3-part gid; when absent it is resolved from the local cache, then falls back to
// INBOX. Ids are grouped by folder and each folder is fetched via showEmails, so
// `show` works on results that span folders (e.g. after `search --folder all`)
// without the caller passing --folder per email.
async function showEmailsResolved({ refs = [], account_id = "", ...opts } = {}) {
  const list = (Array.isArray(refs) ? refs : [])
    .map((r) => ({ id: String((r && r.id) || "").trim(), folder: (r && r.folder) || "" }))
    .filter((r) => r.id);
  if (!list.length) return { success: false, error: "Missing email refs" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  // Resolve a folder for every ref (gid folder -> cache -> INBOX), then group.
  const byFolder = new Map();
  for (const r of list) {
    const folder = await resolveEmailFolder({ account_id: acc.account.id, uid: r.id, folder: r.folder });
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(r.id);
  }

  const emails = [];
  const failed_ids = [];
  for (const [folder, ids] of byFolder) {
    let res;
    try {
      res = await showEmails({ email_ids: ids, folder, account_id, ...opts });
    } catch (e) {
      // A folder that can't be opened (stale/renamed/deleted) must not sink the
      // whole batch — degrade that group to failed_ids and keep other folders.
      const msg = e && e.message ? e.message : "fetch failed";
      for (const id of ids) failed_ids.push({ id, error: msg, folder });
      continue;
    }
    if (res && res.success === false && !Array.isArray(res.emails)) {
      // Soft per-group error (e.g. mailboxOpen returned an error object): record
      // it for this group's ids rather than aborting the whole resolve.
      const msg = res.error || "fetch failed";
      for (const id of ids) failed_ids.push({ id, error: msg, folder });
      continue;
    }
    if (res && Array.isArray(res.emails)) emails.push(...res.emails);
    if (res && Array.isArray(res.failed_ids)) failed_ids.push(...res.failed_ids);
  }

  return {
    success: failed_ids.length === 0,
    emails,
    failed_ids,
    requested: list.length,
    returned: emails.length,
    account_id: acc.account.id,
  };
}

async function markEmails({ email_ids, mark_as, folder = "INBOX", account_id = "", dry_run = false } = {}) {
  const ids = (email_ids || []).map((x) => String(x));
  if (!ids.length) return { success: false, error: "Missing email_ids" };
  const markAs = String(mark_as || "").toLowerCase();
  if (markAs !== "read" && markAs !== "unread") return { success: false, error: "Invalid mark_as" };

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_mark: ids.length,
      mark_as: markAs,
      email_ids: ids,
      message: `Dry run: would mark ${ids.length} emails as ${markAs}`,
    };
  }

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const openFolder = _normalizeFolder(folder);

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const uids = ids.map((x) => Number(x));
    const results = [];
    for (const uid of uids) {
      try {
        if (markAs === "read") await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
        results.push({ success: true, email_id: String(uid), folder: openFolder, account_id: acc.account.id });
      } catch (e) {
        results.push({ success: false, email_id: String(uid), folder: openFolder, account_id: acc.account.id, error: e && e.message ? e.message : "failed" });
      }
    }
    const marked = results.filter((r) => r.success).length;
    if (marked > 0) {
      const successfulUids = results.filter((r) => r.success).map((r) => r.email_id);
      const dbPath = paths.getPathConfig().emailSyncDb;
      await syncDb.updateEmailFlags({
        dbPath,
        accountId: acc.account.id,
        uids: successfulUids,
        unread: markAs === "unread",
      });
      await syncDb.invalidateFolderUnreadCount({
        dbPath,
        accountId: acc.account.id,
        folder: openFolder,
      });
    }
    return {
      success: marked === results.length,
      marked_count: marked,
      total: results.length,
      total_requested: results.length,
      mark_as: markAs,
      results,
    };
  });
}

function _trashFolderCandidates(account, preferredName) {
  const raw = account && account.raw ? account.raw : {};
  const candidates = [
    preferredName,
    raw.trash_folder,
    raw.trashFolder,
    raw.trash,
    raw.folders && raw.folders.trash,
    "Trash",
    "已删除",
    "Deleted Items",
    "[Gmail]/Trash",
  ];
  const out = [];
  for (const name of candidates) {
    const s = String(name || "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

async function _findTrashFolder(client, preferredName, account) {
  const candidates = _trashFolderCandidates(account, preferredName);
  const candidateSet = new Set(candidates);
  const mailboxes = await _listMailboxes(client);

  let exactMatch = "";
  let bySpecialUse = "";
  for (const mb of mailboxes) {
    const pathName = mb.path || mb.name || "";
    if (!pathName) continue;
    const special = String(mb.specialUse || "");
    if (special === "\\Trash") {
      bySpecialUse = pathName;
      // \Trash is authoritative; stop searching as soon as we find it.
      break;
    }
    if (!exactMatch && candidateSet.has(pathName)) exactMatch = pathName;
  }

  if (bySpecialUse) return bySpecialUse;
  if (exactMatch) return exactMatch;
  // No \Trash special-use and no known-name match: fail loudly so
  // we don't silently fall through to a non-existent trash folder, which
  // would error out per UID inside messageMove anyway.
  throw new Error(
    `Trash folder not found: server has no \\Trash special-use mailbox and none of these folders exist: ${candidates.join(", ")}. Pass --trash-folder <name> or use --permanent.`
  );
}

async function _uidExistsInFolder(client, folder, uid) {
  await client.mailboxOpen(folder);
  const msg = await client.fetchOne(Number(uid), { flags: true }, { uid: true });
  return Boolean(msg);
}

async function deleteEmails({ email_ids, folder = "INBOX", permanent = false, trash_folder = "Trash", account_id = "", dry_run = false } = {}) {
  const ids = (email_ids || []).map((x) => String(x));
  if (!ids.length) return { success: false, error: "Missing email_ids" };

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_delete: ids.length,
      permanent: Boolean(permanent),
      email_ids: ids,
      message: `Dry run: would ${permanent ? "delete" : "move to trash"} ${ids.length} emails`,
    };
  }

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const openFolder = _normalizeFolder(folder);

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const uids = ids.map((x) => Number(x));
    const results = [];

    let trashName = "";
    async function ensureTrashName() {
      if (!trashName) trashName = await _findTrashFolder(client, trash_folder, acc.account);
      return trashName;
    }

    if (!permanent) {
      try {
        trashName = await ensureTrashName();
      } catch (e) {
        return { success: false, error: e && e.message ? e.message : "Trash folder lookup failed" };
      }
    }

    for (const uid of uids) {
      try {
        const sourceExists = await _uidExistsInFolder(client, openFolder, uid);
        if (!sourceExists) {
          let foundInTrash = false;
          let existingTrashName = "";
          try {
            existingTrashName = await ensureTrashName();
            foundInTrash = existingTrashName !== openFolder && await _uidExistsInFolder(client, existingTrashName, uid);
          } catch {
            foundInTrash = false;
          }
          if (foundInTrash) {
            results.push({
              success: true,
              email_id: String(uid),
              folder: existingTrashName,
              account_id: acc.account.id,
              already_deleted: true,
            });
          } else {
            results.push({
              success: false,
              email_id: String(uid),
              folder: openFolder,
              account_id: acc.account.id,
              error: "Email not found in source folder or trash",
            });
          }
          continue;
        }
        await client.mailboxOpen(openFolder);
        if (permanent) await client.messageDelete(uid, { uid: true });
        else await client.messageMove(uid, trashName, { uid: true });
        results.push({ success: true, email_id: String(uid), folder: openFolder, account_id: acc.account.id });
      } catch (e) {
        results.push({ success: false, email_id: String(uid), folder: openFolder, account_id: acc.account.id, error: e && e.message ? e.message : "failed" });
      }
    }
    const deleted = results.filter((r) => r.success).length;
    if (deleted > 0) {
      await syncDb.removeEmailsFromCache({
        dbPath: paths.getPathConfig().emailSyncDb,
        accountId: acc.account.id,
        uids: results.filter((r) => r.success).map((r) => r.email_id),
      });
    }
    return {
      success: deleted === results.length,
      deleted_count: deleted,
      total: results.length,
      total_requested: results.length,
      results,
    };
  });
}

function _outgoingAttachments(attachments) {
  if (!attachments) return [];
  return Array.isArray(attachments) ? attachments.filter(Boolean) : [attachments];
}

function _outgoingAttachmentPreview(attachments) {
  return _outgoingAttachments(attachments).map((a) => ({
    filename: a.filename || (a.path ? path.basename(String(a.path)) : "attachment"),
    path: a.path || undefined,
    content_type: a.contentType || undefined,
  }));
}

async function sendEmail({ to, subject, body, cc, bcc, account_id = "", is_html = false, attachments = [] } = {}) {
  const tos = Array.isArray(to) ? to : [to];
  const recipients = tos.map((x) => String(x)).filter((x) => x.trim());
  if (!recipients.length) return { success: false, error: "Missing --to" };
  const subj = String(subject || "");
  if (!subj.trim()) return { success: false, error: "Missing --subject" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  try {
    const outgoingAttachments = _outgoingAttachments(attachments);
    const r = await sendMail({
      account: acc.account,
      to: recipients.join(", "),
      cc: Array.isArray(cc) ? cc.join(", ") : cc || "",
      bcc: Array.isArray(bcc) ? bcc.join(", ") : bcc || "",
      subject: subj,
      text: is_html ? "" : String(body || ""),
      html: is_html ? String(body || "") : "",
      attachments: outgoingAttachments,
    });

    if (!r.success) return r;
    return {
      success: true,
      message: `Email sent successfully to ${recipients.length} recipient(s)`,
      recipients,
      from: acc.account.email,
      attachment_count: outgoingAttachments.length,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "send failed", from: acc.account.email };
  }
}

// Common reply-prefix forms across locales. Matches "Re:", "RE：", "回复:",
// "答复:", "Sv:", "Antwort:", "AW:", "RES:", "Tr:" with optional whitespace.
const _REPLY_PREFIX_RE = /^\s*(re|aw|antwort|sv|res|回复|答复|回覆|tr)\s*[:：]/i;

function _splitAddressList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function _addressEmail(addr) {
  const m = String(addr).match(/<([^>]+)>/);
  return (m ? m[1] : String(addr)).trim().toLowerCase();
}

function _dedupeAddresses(list, exclude) {
  const excluded = new Set((exclude || []).map((x) => String(x).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const addr of list) {
    const key = _addressEmail(addr);
    if (!key || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

function _buildReferences(detail) {
  const refs = [];
  const existing = detail.references ? String(detail.references).trim() : "";
  if (existing) refs.push(existing);
  const parent = detail.message_id ? String(detail.message_id).trim() : "";
  if (parent && !refs.join(" ").includes(parent)) refs.push(parent);
  return refs.join(" ").trim();
}

async function replyEmail({ email_id, body, reply_all = false, folder = "INBOX", account_id = "", is_html = false, attachments = [], dry_run = false } = {}) {
  const detail = await showEmail({ email_id, folder, account_id });
  if (!detail.success) return detail;
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const outgoingAttachments = _outgoingAttachments(attachments);

  const fromAddr = detail.from || "";
  let toList = [fromAddr].filter(Boolean);
  let ccList = [];
  if (reply_all) {
    const origTo = _splitAddressList(detail.to);
    const origCc = _splitAddressList(detail.cc);
    toList = _dedupeAddresses([fromAddr, ...origTo], [acc.account.email]);
    ccList = _dedupeAddresses(origCc, [acc.account.email, ..._dedupeAddresses(toList).map(_addressEmail)]);
  }
  if (!toList.length) {
    return { success: false, error: "Reply has no recipient (original sender unknown)", from: acc.account.email };
  }

  const subjectRaw = detail.subject || "";
  const subject = _REPLY_PREFIX_RE.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
  const headers = {};
  if (detail.message_id) headers["In-Reply-To"] = detail.message_id;
  const refs = _buildReferences(detail);
  if (refs) headers.References = refs;

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_reply: {
        email_id: String(email_id || ""),
        folder,
        account_id: acc.account.id,
        to: toList,
        cc: ccList,
        subject,
        is_html: Boolean(is_html),
        body_bytes: Buffer.byteLength(String(body || ""), "utf8"),
        body_preview: String(body || "").slice(0, 200),
        attachment_count: outgoingAttachments.length,
        attachments: _outgoingAttachmentPreview(outgoingAttachments),
      },
      confirmation_required: true,
      confirmation_hint: "Re-run with --confirm to actually send",
    };
  }

  try {
    await sendMail({
      account: acc.account,
      to: toList.join(", "),
      cc: ccList.length ? ccList.join(", ") : undefined,
      subject,
      text: is_html ? "" : String(body || ""),
      html: is_html ? String(body || "") : "",
      attachments: outgoingAttachments,
      headers,
    });
    return {
      success: true,
      message: "Reply sent successfully",
      recipients: toList,
      cc: ccList,
      from: acc.account.email,
      attachment_count: outgoingAttachments.length,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "reply failed", from: acc.account.email };
  }
}

async function forwardEmail({ email_id, to, body = "", folder = "INBOX", no_attachments = false, account_id = "", dry_run = false } = {}) {
  const detail = await showEmail({ email_id, folder, account_id });
  if (!detail.success) return detail;
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const recipients = (Array.isArray(to) ? to : [to]).map((x) => String(x)).filter((x) => x.trim());
  if (!recipients.length) return { success: false, error: "Missing --to" };
  const subject = `Fwd: ${detail.subject || ""}`;

  if (dry_run) {
    const originalAttachmentCount = no_attachments ? 0 : (detail.real_attachment_count || detail.attachment_count || 0);
    return {
      success: true,
      dry_run: true,
      would_forward: {
        email_id: String(email_id || ""),
        folder,
        account_id: acc.account.id,
        to: recipients,
        subject,
        body_bytes: Buffer.byteLength(String(body || ""), "utf8"),
        body_preview: String(body || "").slice(0, 200),
        include_original_attachments: !no_attachments,
        original_attachment_count: originalAttachmentCount,
      },
      confirmation_required: true,
      confirmation_hint: "Re-run with --confirm to actually send",
    };
  }

  let attachments = [];
  if (!no_attachments && detail.attachment_count) {
    if (_isTestMode()) {
      const { getMailbox } = require("../testing/mock_store");
      const mb = getMailbox(acc.account.id, _normalizeFolder(folder));
      const raw = mb && mb.messages ? mb.messages.find((m) => String(m.uid) === String(email_id)) : null;
      attachments = (raw && raw.attachments ? raw.attachments : []).map((a) => ({
        filename: path.basename(String(a.filename || "attachment")),
        content: a.content,
        contentType: a.contentType,
      }));
    } else {
      // Re-fetch the source so we can attach the original parts. Without this
      // --no-attachments would be a no-op vs. always-drop, which is misleading.
      const fetched = await withImapClient(acc.account, async (client) => {
        await client.mailboxOpen(_normalizeFolder(folder));
        const uid = Number(email_id);
        if (!Number.isFinite(uid)) return null;
        return client.fetchOne(uid, { source: true }, { uid: true });
      });
      if (fetched && fetched.source) {
        const parsed = await _safeParse(fetched.source);
        let totalBytes = 0;
        for (const a of parsed.attachments || []) {
          if (!a.content || !a.content.length) continue;
          if (a.content.length > MAX_ATTACHMENT_BYTES) continue;
          totalBytes += a.content.length;
          if (totalBytes > MAX_ATTACHMENTS_TOTAL) break;
          attachments.push({
            filename: path.basename(String(a.filename || "attachment")),
            content: a.content,
            contentType: a.contentType || "application/octet-stream",
          });
        }
      }
    }
  }

  try {
    await sendMail({
      account: acc.account,
      to: recipients.join(", "),
      subject,
      text: String(body || ""),
      attachments,
    });
    return {
      success: true,
      message: `Email sent successfully to ${recipients.length} recipient(s)`,
      recipients,
      from: acc.account.email,
      attachment_count: attachments.length,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "forward failed", from: acc.account.email };
  }
}

async function listFolders({ account_id } = {}) {
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  return withImapClient(acc.account, async (client) => {
    const folders = [];
    for (const mb of await _listMailboxes(client)) {
      folders.push({
        name: mb.name || mb.path || "",
        attributes: Array.isArray(mb.flags) ? mb.flags.join(" ") : "",
        delimiter: mb.delimiter || "/",
        message_count: 0,
        path: mb.path || mb.name || "",
      });
    }
    return {
      success: true,
      folders,
      folder_tree: {},
      total_folders: folders.length,
      account: acc.account.email,
    };
  });
}

async function downloadAttachments({ email_id, folder = "INBOX", account_id, output_dir = "" } = {}) {
  const detail = await showEmail({ email_id, folder, account_id });
  if (!detail.success) return detail;

  const targetDir = output_dir ? String(output_dir) : paths.getPathConfig().attachmentsDir;
  fs.mkdirSync(targetDir, { recursive: true });

  // Pick a non-conflicting filename inside targetDir, basename-only to defeat
  // path traversal from attacker-supplied filenames.
  const _pickDest = (rawName) => {
    const filename = path.basename(String(rawName || "attachment"));
    if (!filename) return { filename: "", dest: "" };
    let dest = path.join(targetDir, filename);
    const ext = path.extname(filename);
    const base = ext ? filename.slice(0, -ext.length) : filename;
    let counter = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(targetDir, `${base}_${counter}${ext}`);
      counter += 1;
    }
    return { filename, dest };
  };

  if (_isTestMode()) {
    const acc = accounts.getAccountByIdOrEmail(account_id);
    if (!acc.success) return acc;
    const { getMailbox } = require("../testing/mock_store");
    const mb = getMailbox(acc.account.id, _normalizeFolder(folder));
    const raw = mb && mb.messages ? mb.messages.find((m) => String(m.uid) === String(email_id)) : null;
    const attachments = [];
    let totalBytes = 0;
    for (const a of raw && raw.attachments ? raw.attachments : []) {
      const content = a.content;
      if (!content || !content.length) continue;
      if (content.length > MAX_ATTACHMENT_BYTES) {
        return { success: false, error: `Attachment "${a.filename}" exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
      }
      totalBytes += content.length;
      if (totalBytes > MAX_ATTACHMENTS_TOTAL) {
        return { success: false, error: `Attachments exceed total cap of ${MAX_ATTACHMENTS_TOTAL} bytes` };
      }
      const { filename, dest } = _pickDest(a.filename);
      if (!filename) continue;
      fs.writeFileSync(dest, content);
      attachments.push({
        filename,
        size: content.length,
        size_formatted: formatSize(content.length),
        content_type: a.contentType,
        saved_path: dest,
        ...attachmentFlags(a),
      });
    }
    return {
      success: true,
      attachments,
      attachment_count: attachments.length,
      real_attachment_count: attachments.filter((x) => x.is_real_attachment).length,
      email_id: String(email_id),
      folder: _normalizeFolder(folder),
      account: acc.account.email,
    };
  }

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const openFolder = _normalizeFolder(folder);
  const uid = Number(email_id);
  if (!Number.isFinite(uid)) return { success: false, error: "Invalid email_id" };

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
    if (!msg || !msg.source) return { success: false, error: `Email not found: ${email_id}` };

    const parsed = await _safeParse(msg.source);

    const attachments = [];
    let totalBytes = 0;
    for (const a of parsed.attachments || []) {
      const content = a.content;
      if (!content || !content.length) continue;
      if (content.length > MAX_ATTACHMENT_BYTES) {
        return { success: false, error: `Attachment "${a.filename || "(unnamed)"}" exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
      }
      totalBytes += content.length;
      if (totalBytes > MAX_ATTACHMENTS_TOTAL) {
        return { success: false, error: `Attachments exceed total cap of ${MAX_ATTACHMENTS_TOTAL} bytes` };
      }
      const { filename, dest } = _pickDest(a.filename);
      if (!filename) continue;
      fs.writeFileSync(dest, content);

      attachments.push({
        filename,
        size: content.length,
        size_formatted: formatSize(content.length),
        content_type: a.contentType || "application/octet-stream",
        saved_path: dest,
        ...attachmentFlags(a),
      });
    }

    return {
      success: true,
      attachments,
      attachment_count: attachments.length,
      real_attachment_count: attachments.filter((x) => x.is_real_attachment).length,
      email_id: String(email_id),
      folder: openFolder,
      account: acc.account.email,
    };
  });
}

// Map user-facing flag_type to IMAP keyword. Unknown values fall through as
// custom keywords (which any IMAP server may accept or reject) so we don't
// silently coerce them into \Flagged.
const _FLAG_MAP = {
  flagged: "\\Flagged",
  starred: "\\Flagged",
  important: "$Important",
  read: "\\Seen",
  seen: "\\Seen",
  answered: "\\Answered",
  draft: "\\Draft",
  junk: "$Junk",
  spam: "$Junk",
  notjunk: "$NotJunk",
  forwarded: "$Forwarded",
};

async function flagEmail({ email_id, set_flag, flag_type = "flagged", folder = "INBOX", account_id, dry_run = false } = {}) {
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const openFolder = _normalizeFolder(folder);
  const uid = Number(email_id);
  if (!Number.isFinite(uid)) return { success: false, error: "Invalid email_id" };

  const flagType = String(flag_type || "flagged").toLowerCase();
  const flag = _FLAG_MAP[flagType] || flagType;
  const set = Boolean(set_flag);

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_flag: { email_id: String(uid), flag_type: flagType, set_flag: set, folder: openFolder, account: acc.account.email },
      message: `Dry run: would ${set ? "set" : "unset"} flag "${flagType}" on ${uid}`,
    };
  }

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    if (set) await client.messageFlagsAdd(uid, [flag], { uid: true });
    else await client.messageFlagsRemove(uid, [flag], { uid: true });
    return {
      success: true,
      message: `Flag "${flagType}" ${set ? "set" : "unset"}`,
      email_id: String(uid),
      flag_type: flagType,
      set_flag: set,
      folder: openFolder,
      account: acc.account.email,
    };
  });
}

async function moveEmails({ email_ids, target_folder, source_folder = "INBOX", account_id, dry_run = false } = {}) {
  const ids = (email_ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (!ids.length) return { success: false, error: "Missing email_ids" };
  const tgt = String(target_folder || "").trim();
  if (!tgt) return { success: false, error: "Missing --target-folder" };
  const src = _normalizeFolder(source_folder);

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_move: ids.length,
      email_ids: ids.map(String),
      source_folder: src,
      target_folder: tgt,
      account: acc.account.email,
      message: `Dry run: would move ${ids.length} emails from "${src}" to "${tgt}"`,
    };
  }

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(src);
    const failed_ids = [];
    let moved = 0;
    for (const uid of ids) {
      try {
        await client.messageMove(uid, tgt, { uid: true });
        moved += 1;
      } catch {
        failed_ids.push(String(uid));
      }
    }
    return {
      success: failed_ids.length === 0,
      message: `Moved ${moved}/${ids.length} emails to "${tgt}"`,
      moved_count: moved,
      source_folder: src,
      target_folder: tgt,
      account: acc.account.email,
      failed_ids,
    };
  });
}

// Watch a folder for new mail using IMAP IDLE. Long-running. Calls
// onEvent({type, email}) for every newly-arriving message that matches
// the optional filter. Resolves when stop() (returned from this fn)
// is invoked or the connection dies fatally.
//
// Note: this opens its own ImapFlow connection (not pooled) — IDLE
// holds the connection mostly-idle and re-issuing IDLE on every
// pooled-acquire would defeat the purpose.
async function watchFolder({ account_id, folder = "INBOX", filter = {}, onEvent } = {}) {
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return { success: false, error: acc.error || "account lookup failed", error_code: "account_not_found" };
  const openFolder = _normalizeFolder(folder);

  const fromQ = String(filter.from || "").toLowerCase();
  const subjQ = String(filter.subject || "").toLowerCase();
  const matches = (env) => {
    if (fromQ) {
      const f = (firstAddress(env.from) || "").toLowerCase();
      if (!f.includes(fromQ)) return false;
    }
    if (subjQ) {
      const s = String(env.subject || "").toLowerCase();
      if (!s.includes(subjQ)) return false;
    }
    return true;
  };

  const { ImapFlow } = require("imapflow");
  const port = Number(acc.account.imap.port);
  const secure = Boolean(acc.account.imap.secure);
  const client = new ImapFlow({
    host: acc.account.imap.host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: acc.account.email, pass: acc.account.password },
    tls: { rejectUnauthorized: !(String(process.env.MAILBOX_ALLOW_INSECURE_TLS || "").trim() === "1"), minVersion: "TLSv1.2" },
    logger: false,
  });

  let stopped = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  await client.connect();
  await client.mailboxOpen(openFolder);
  let lastUid = client.mailbox && client.mailbox.uidNext ? Number(client.mailbox.uidNext) : 0;

  // Serialize concurrent `exists` events: if a fetch is already running,
  // remember that we need another pass. Without this, two events that
  // arrive close together can fetch the same range twice and emit
  // duplicate `new_email` callbacks.
  let fetchInFlight = false;
  let fetchPending = false;
  const seenUids = new Set();

  const fetchSince = async () => {
    if (fetchInFlight) { fetchPending = true; return; }
    fetchInFlight = true;
    try {
      do {
        fetchPending = false;
        if (!lastUid) break;
        try {
          const since = `${lastUid}:*`;
          for await (const msg of client.fetch(
            since,
            { envelope: true, flags: true, internalDate: true, bodyStructure: true },
            { uid: true }
          )) {
            const uidNum = Number(msg.uid);
            if (!Number.isFinite(uidNum)) continue;
            if (uidNum < lastUid) continue;          // `:*` lower-bound is inclusive
            if (seenUids.has(uidNum)) continue;      // already emitted across passes
            const env = msg.envelope || {};
            // Always advance lastUid even when filter rejects the message,
            // so later fetches don't re-scan it.
            lastUid = Math.max(lastUid, uidNum + 1);
            seenUids.add(uidNum);
            // Cap the dedup set so a long-running watcher doesn't grow
            // memory unbounded.
            if (seenUids.size > 4096) {
              const oldest = [...seenUids].slice(0, seenUids.size - 2048);
              for (const u of oldest) seenUids.delete(u);
            }
            if (!matches(env)) continue;
            const flags = msg.flags || new Set([]);
            const item = {
              id: String(uidNum),
              uid: String(uidNum),
              gid: _gid(acc.account.id, folder, uidNum),
              message_id: env.messageId || "",
              subject: env.subject || "",
              from: firstAddress(env.from),
              date: formatDateTime(msg.internalDate || env.date),
              unread: !flags.has("\\Seen"),
              has_attachments: hasAttachmentsFromBodyStructure(msg.bodyStructure),
              account: acc.account.email,
              account_id: acc.account.id,
              folder: openFolder,
              source: "imap_idle",
            };
            if (typeof onEvent === "function") {
              try { onEvent({ type: "new_email", email: item }); } catch { /* ignore */ }
            }
          }
        } catch (e) {
          if (typeof onEvent === "function") {
            try { onEvent({ type: "fetch_error", error: e && e.message ? e.message : String(e) }); } catch { /* ignore */ }
          }
        }
      } while (fetchPending && !stopped);
    } finally {
      fetchInFlight = false;
    }
  };

  client.on("exists", () => { fetchSince(); });
  client.on("close", () => {
    if (!stopped && typeof onEvent === "function") {
      try { onEvent({ type: "disconnected" }); } catch { /* ignore */ }
    }
    stopped = true;
    resolveDone({ success: true, stopped: true });
  });

  // Kick off the IDLE loop. ImapFlow re-issues IDLE internally roughly
  // every 28 minutes; we don't have to wrap it.
  (async () => {
    while (!stopped) {
      try {
        await client.idle();
      } catch (e) {
        if (stopped) break;
        if (typeof onEvent === "function") {
          try { onEvent({ type: "idle_error", error: e && e.message ? e.message : String(e) }); } catch { /* ignore */ }
        }
        // Brief backoff before re-issuing IDLE.
        await new Promise((r) => { setTimeout(r, 2000); });
      }
    }
  })();

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { await client.logout(); } catch { /* ignore */ }
    resolveDone({ success: true, stopped: true });
  };

  return { success: true, watching: true, folder: openFolder, account_id: acc.account.id, stop, done };
}

module.exports = {
  listEmails,
  searchEmails,
  showEmail,
  showEmails,
  showEmailsResolved,
  resolveEmailFolder,
  _parseDateInput,
  _expandRelativeDate,
  _deadlineExceeded,
  _raceTimeout,
  watchFolder,
  markEmails,
  deleteEmails,
  sendEmail,
  replyEmail,
  forwardEmail,
  listFolders,
  downloadAttachments,
  flagEmail,
  moveEmails,
};
