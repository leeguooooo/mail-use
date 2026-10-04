// list (cache-first with a live IMAP fallback) and the folder listing.

const { paths } = require("@mail-use/shared");

const accounts = require("../accounts");
const { withImapClient } = require("../imap");
const syncDb = require("../../storage/sync_db");
const { _parseDateInput } = require("./dates");
const {
  _normalizeFolder, _listMailboxes, _selectableFoldersFor,
  _uidsSortedDesc, _compareDatesDesc, _mapLimit, ACCOUNT_CONCURRENCY,
} = require("./internals");
const { _envelopeItem } = require("./items");
const { PREVIEW_SOURCE_QUERY, _applyPreview } = require("./message_source");

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
        source: wantPreview ? PREVIEW_SOURCE_QUERY : false,
      },
      { uid: true }
    )) {
      const item = _envelopeItem(account, openFolder, msg, "imap_fetch");
      if (wantPreview) await _applyPreview(item, msg, previewChars);
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
  }, { idempotent: true });
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
      // An unknown account must be an error, not "no account filter": falling
      // through with an empty id served every account's cached mail as if it
      // were this one's, success:true.
      if (resolved && !resolved.success) return resolved;
      const resolvedId = resolved && resolved.success ? resolved.account.id : "";
      const cache = await syncDb.listEmailsFromCache({
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
        // Coverage gap: the cache is only the newest N messages per folder, so a
        // thin page can mean "the window reaches past what we cached", not "the
        // folder has no more". That is unknowable from the cache however fresh
        // it is, so freshness doesn't excuse it. A full page is still correct
        // (rows are newest-first and the cache holds everything newer than its
        // oldest row); a thin page is trusted only when the requested window
        // starts inside the covered range, or (unread-only) every unread
        // message is cached. MAILBOX_CACHE_FRESH_SECONDS=0 ("trust the cache,
        // never auto-fallback") disables this too.
        const coverageGap =
          freshSeconds > 0 &&
          thin &&
          cache.cache_complete === false &&
          !(unreadOnly && cache.cache_unread_complete === true) &&
          (!sqlFrom || cache.cache_covers_from == null || sqlFrom < cache.cache_covers_from);

        // Self-heal in three cases:
        //  - thin AND stale: the silent-miss case (asking for the latest mail
        //    seconds after it arrived, before the next sync). A thin-but-fresh
        //    read is trusted — the folder genuinely has that few.
        //  - abandoned: the snapshot is so old that nothing is syncing. Row
        //    count says nothing here; a full page of months-old mail is exactly
        //    the answer we must not give.
        //  - coverage gap: thin, and the requested window reaches earlier than
        //    the partial cache is known to be complete. Fires however fresh the
        //    snapshot is (a fresh cache is just as partial); only the
        //    MAILBOX_CACHE_FRESH_SECONDS=0 "never auto-fallback" hatch disables it.
        if ((thin && stale) || abandoned || coverageGap) {
          if (process.env.MAILBOX_DEBUG) {
            const why = abandoned
              ? `abandoned (age ${_humanAge(ageSec)} > ${abandonedSeconds}s)`
              : coverageGap
                ? `thin (${returned}/${lim}) and only covers from ${cache.cache_covers_from || "nothing"}${sqlFrom ? ` (asked from ${sqlFrom})` : ""}`
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
          const { cache_unread_complete: _unreadComplete, ...cacheOut } = cache;
          return {
            ...cacheOut,
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

    // Accounts are independent connections: fetch them concurrently (bounded)
    // instead of one after another. Result order still follows the config.
    const rows = await _mapLimit(list, ACCOUNT_CONCURRENCY, async (acc) => {
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
        return { account: acc, ...r };
      } catch (e) {
        return { account: acc, success: false, error: e && e.message ? e.message : "fetch failed" };
      }
    });
    results.push(...rows);
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
  }, { idempotent: true });
}

module.exports = { listEmails, listFolders };
