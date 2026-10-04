// search: server-side SEARCH (X-GM-RAW on Gmail), client-side filtering for
// providers whose SEARCH is broken, bounded by an optional wall-clock deadline.

const accounts = require("../accounts");
const { withImapClient, abandonClient } = require("../imap");
const { formatDateTime, firstAddress, hasAttachmentsFromBodyStructure } = require("../format");
const { _deadlineExceeded, _raceTimeout } = require("./deadline");
const {
  _normalizeFolder, _gid, _listMailboxes, _selectableFoldersFor,
  _gmailAllMailPlan, _gmailCanonicalFolder,
  _mailboxRole, _folderCanonicalRank, _messageIdentityKey, _dedupeAcrossFolders,
  _uidsSortedDesc, _compareDatesDesc, _uidSetString, _mapLimit, ACCOUNT_CONCURRENCY,
} = require("./internals");
const { PREVIEW_SOURCE_QUERY, _applyPreview } = require("./message_source");
const { _parseDateInput } = require("./dates");

function _isGmailAccount(acc) {
  const host = String((acc && acc.imap && acc.imap.host) || "").toLowerCase();
  const provider = String((acc && acc.provider) || "").toLowerCase();
  return provider === "gmail" || host.includes("gmail") || host.includes("googlemail");
}

// Hidden per-item identity (X-GM-MSGID / EMAILID): used for cross-folder
// dedupe, never serialized into the result.
const _EMAIL_ID = Symbol("emailId");
// Hidden Gmail X-GM-LABELS and INTERNALDATE of an All Mail row, used to move it
// to its canonical folder (see _relocateGmailRows).
const _LABELS = Symbol("labels");
const _INTERNAL_DATE = Symbol("internalDate");
// Ceiling on uids whose X-GM-MSGID is fetched per folder while relocating.
const RELOCATE_UID_CAP = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

// dedupe: a multi-folder scan (folder=all) returns one row per message, at its
// most canonical folder. Gmail label views (INBOX + Important + Starred + user
// labels) are always collapsed — they are one message. dedupe=false keeps
// genuine copies on non-label servers (a COPY into two folders is two
// messages), which bulk mutations need so every copy is acted on.
//
// Gmail with folder=all searches [Gmail]/All Mail (+ Spam/Trash) instead of
// every label folder: All Mail is the only folder that holds archived mail,
// and it holds each message once. Each hit is then relocated to the folder it
// lives in by its X-GM-LABELS (INBOX, else a user label, else Sent/Drafts),
// staying in All Mail when it has none of those (archived mail). The gid is
// openable and mutable either way.
async function searchEmails({ query, from = "", subject = "", account_id = "", date_from = "", date_to = "", limit = 50, offset = 0, unread_only = false, folder = "all", preview_chars = 0, timeout_ms = 0, dedupe = true } = {}) {
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

  // Same parsing as listEmails: relative dates (7d, today) and an inclusive
  // date-only date_to. MCP passes these through unexpanded.
  const fromParsed = _parseDateInput(date_from);
  const toParsed = _parseDateInput(date_to, { end: true });
  const since = fromParsed.date;
  const before = toParsed.date;
  const dateWarnings = [fromParsed.warning, toParsed.warning].filter(Boolean);

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
    if (!_isGmailAccount(acc)) return null;
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
  // Ceiling for the dedupe re-fetch below: when label aliases leave a deduped
  // account short of offset+limit, the per-folder cap is raised up to this.
  const DEDUPE_FETCH_CEILING = 5000;

  function _criteriaFor(acc) {
    const gmailRaw = _gmailRawFor(acc);
    const criteria = gmailRaw
      ? { gmailRaw, ...(unreadOnly ? { seen: false } : {}) }
      : baseCriteria;
    return { gmailRaw, criteria };
  }

  // withLabels: also fetch X-GM-LABELS (Gmail All Mail scan).
  async function _searchOneFolder(client, acc, folderPath, fetchLimit, { withLabels = false } = {}) {
    const lock = await client.getMailboxLock(folderPath);
    try {
      const { gmailRaw, criteria } = _criteriaFor(acc);
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
      const fetchCap = usedClientFilter ? Math.min(clientCap, sorted.length) : Math.min(fetchLimit, sorted.length);
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
          { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: wantPreview ? PREVIEW_SOURCE_QUERY : false, ...(withLabels ? { labels: true } : {}) },
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
          if (emails.length >= fetchLimit) continue;
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
          if (msg.emailId) Object.defineProperty(item, _EMAIL_ID, { value: String(msg.emailId) });
          if (withLabels) {
            Object.defineProperty(item, _LABELS, { value: msg.labels || new Set() });
            Object.defineProperty(item, _INTERNAL_DATE, { value: msg.internalDate || env.date || null });
          }
          if (wantPreview) await _applyPreview(item, msg, previewChars);
          emails.push(item);
        }
      }
      const totalReported = usedClientFilter ? matched : total;
      const out = { total_found: totalReported, emails };
      // More matches than rows fetched because of our per-folder cap: a larger
      // fetchLimit would return more rows.
      if (!folderTimedOut && emails.length >= fetchLimit && totalReported > emails.length) out.capped = true;
      if (folderTimedOut) out.timed_out = true;
      if (usedClientFilter) out.client_filter = { fetched: slice.length, mailbox_total: mailboxTotal };
      return out;
    } finally {
      lock.release();
    }
  }

  // Move Gmail All Mail rows to the folder each message lives in (by its
  // X-GM-LABELS), so an inbox message keeps its INBOX gid. Per target folder:
  // one SEARCH (same X-GM-RAW, narrowed to the rows' date window) and one
  // FETCH of X-GM-MSGID to map message id -> that folder's uid. A row whose
  // uid cannot be resolved (label folder hidden from IMAP, race, timeout)
  // keeps its All Mail location, which is just as valid a gid.
  async function _relocateGmailRows(client, acc, rows, mailboxes) {
    const groups = new Map();
    for (const r of rows) {
      if (!r[_EMAIL_ID] || !r[_LABELS]) continue;
      const target = _gmailCanonicalFolder(r[_LABELS], mailboxes);
      if (!target || target === r.folder) continue;
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target).push(r);
    }
    for (const [folderPath, group] of groups) {
      if (_deadlineExceeded(started, timeoutMs)) break;
      try {
        const lock = await client.getMailboxLock(folderPath);
        try {
          const criteria = { ..._criteriaFor(acc).criteria };
          // INTERNALDATE SEARCH is day-granular in the server's zone: pad the
          // window so it can only widen, never drop a row.
          const times = group.map((r) => new Date(r[_INTERNAL_DATE]).getTime()).filter(Number.isFinite);
          if (times.length === group.length && times.length) {
            criteria.since = new Date(Math.min(...times) - 2 * DAY_MS);
            criteria.before = new Date(Math.max(...times) + 2 * DAY_MS);
          }
          const uids = _uidsSortedDesc(await client.search(criteria, { uid: true }) || []).slice(0, RELOCATE_UID_CAP);
          if (!uids.length) continue;
          const uidOf = new Map();
          for await (const msg of client.fetch(_uidSetString(uids), { uid: true }, { uid: true })) {
            if (msg.emailId) uidOf.set(String(msg.emailId), msg.uid);
          }
          for (const r of group) {
            const uid = uidOf.get(r[_EMAIL_ID]);
            if (uid == null) continue;
            r.id = String(uid);
            r.uid = String(uid);
            r.gid = _gid(acc.id, folderPath, uid);
            r.folder = folderPath;
          }
        } finally {
          lock.release();
        }
      } catch {
        // keep these rows in All Mail
      }
    }
  }

  let timed_out = false;
  const pending_accounts = [];
  // Accounts are searched concurrently (bounded); each runs on its own
  // connection. Outcomes are collected per account and flattened in config
  // order afterwards, so the output doesn't depend on which finished first.
  const outcomes = await _mapLimit(targets, ACCOUNT_CONCURRENCY, async (acc) => {
    // Bound the whole search: a cross-account / --folder all scan over slow
    // (client-side-filtered) providers could otherwise run unbounded. On
    // timeout we stop scanning and return whatever we have so far.
    if (_deadlineExceeded(started, timeoutMs)) {
      timed_out = true;
      return { pending: true };
    }
    try {
      // The client this account's scan is running on, so a timeout can close
      // it instead of leaving it scanning (and pinned in the pool) unobserved.
      let workClient = null;
      let abandoned = false;
      const accountWork = withImapClient(acc, async (client) => {
        workClient = client;
        if (abandoned) abandonClient(client);
        const mailboxes = scanAll ? await _listMailboxes(client) : [];
        const roleOf = new Map(mailboxes.map((mb) => [mb.path || mb.name || "", _mailboxRole(mb)]));
        const need = off + lim;

        // One pass over folderPaths. labelsFolder: the folder (Gmail All Mail)
        // whose rows also carry X-GM-LABELS for relocation.
        async function scanFolders(folderPaths, labelsFolder = "") {
          const wantDedupe = folderPaths.length > 1 && (dedupe || _isGmailAccount(acc));
          let fetchLimit = perAccountFetchLimit;
          let totalCombined;
          let emailsCombined;
          let folderErrors;
          let anyCapped;
          let emailsOut;
          let duplicatesRemoved;
          // Dedupe runs after the per-folder cap, so aliases can leave fewer
          // unique rows than offset+limit while capped folders still hold more
          // matches. Re-scan with a larger cap until the page can be filled, no
          // folder is capped, or the ceiling/deadline is reached.
          for (;;) {
            totalCombined = 0;
            emailsCombined = [];
            folderErrors = [];
            anyCapped = false;
            for (const fp of folderPaths) {
              if (_deadlineExceeded(started, timeoutMs)) {
                timed_out = true;
                folderErrors.push({ folder: fp, error: "skipped: search timed out" });
                break;
              }
              try {
                const part = await _searchOneFolder(client, acc, fp, fetchLimit, { withLabels: fp === labelsFolder });
                totalCombined += part.total_found;
                emailsCombined.push(...part.emails);
                if (part.capped) anyCapped = true;
                if (part.timed_out) timed_out = true;
              } catch (fe) {
                folderErrors.push({ folder: fp, error: fe && fe.message ? fe.message : "search failed" });
              }
            }

            emailsOut = emailsCombined;
            duplicatesRemoved = 0;
            if (wantDedupe) {
              const d = _dedupeAcrossFolders(
                emailsCombined,
                (e) => _messageIdentityKey(e, e[_EMAIL_ID]),
                (f) => _folderCanonicalRank(f, roleOf.get(f) || ""),
              );
              emailsOut = d.emails;
              duplicatesRemoved = d.removed;
            }
            const short = emailsOut.length < need;
            if (!wantDedupe || !short || !anyCapped || timed_out || fetchLimit >= DEDUPE_FETCH_CEILING) break;
            fetchLimit = Math.min(DEDUPE_FETCH_CEILING, Math.max(fetchLimit * 2, need + duplicatesRemoved));
          }
          return { wantDedupe, totalCombined, emailsOut, folderErrors, anyCapped, duplicatesRemoved };
        }

        let scan = null;
        let viaAllMail = false;
        const plan = scanAll && _isGmailAccount(acc) ? _gmailAllMailPlan(mailboxes) : null;
        if (plan) {
          scan = await scanFolders(plan.folders, plan.allMail);
          if (scan.folderErrors.some((fe) => fe.folder === plan.allMail) && !timed_out) {
            scan = null; // All Mail unusable: fall back to the per-folder scan
          } else {
            viaAllMail = true;
            await _relocateGmailRows(client, acc, scan.emailsOut.filter((e) => e.folder === plan.allMail), mailboxes);
          }
        }
        if (!scan) {
          const folderPaths = scanAll ? _selectableFoldersFor(mailboxes) : [openFolder];
          if (folderPaths.length === 0) folderPaths.push("INBOX");
          scan = await scanFolders(folderPaths);
        }
        const { wantDedupe, totalCombined, emailsOut, folderErrors, anyCapped, duplicatesRemoved } = scan;
        // Folder names are localized ("[Gmail]/已发邮件"), so tag each row with
        // its folder's special-use role for callers that must recognise
        // Sent/Trash/Junk without guessing from the name.
        for (const e of emailsOut) {
          const role = roleOf.get(e.folder);
          if (role) e.special_use = role;
        }
        // Per-folder SEARCH counts include every alias; subtract the ones we
        // collapsed so total_found counts messages, not folder hits. Aliases
        // beyond a folder's fetch cap were never seen, so when any folder was
        // capped the deduped total is only an upper bound. Gmail's All Mail
        // path has no aliases (All Mail, Spam and Trash are disjoint), so its
        // total is exact.
        const out = { success: true, total_found: Math.max(0, totalCombined - duplicatesRemoved), emails: emailsOut };
        if (duplicatesRemoved) out.duplicates_removed = duplicatesRemoved;
        if (wantDedupe && anyCapped && !viaAllMail) out.total_found_is_upper_bound = true;
        if (folderErrors.length) out.folder_errors = folderErrors;
        return out;
      }, { idempotent: true });
      // Hard-bound the account by whatever time remains in the overall deadline,
      // so a single un-cooperative imap op (QQ/163 scan / stuck connect) can't
      // blow past --timeout. On timeout we keep the partial emails gathered so far.
      const remaining = timeoutMs > 0 ? Math.max(0, started + timeoutMs - Date.now()) : 0;
      const r = await _raceTimeout(accountWork, remaining, () => {
        // Nobody will read this account's result any more. Close its socket so
        // the orphaned scan stops now rather than running on in the daemon.
        abandoned = true;
        if (workClient) abandonClient(workClient);
        timed_out = true;
        return { success: true, total_found: 0, emails: [], account_timed_out: true };
      });
      return { row: { account: acc, ...r }, pending: Boolean(r && r.account_timed_out) };
    } catch (e) {
      const error = e && e.message ? e.message : "search failed";
      return {
        failed: { account: acc.email || "", account_id: acc.id || "", error },
        row: { account: acc, success: false, error, total_found: 0, emails: [] },
      };
    }
  });
  outcomes.forEach((o, i) => {
    const acc = targets[i];
    if (o.pending) pending_accounts.push(acc.id || acc.email || "");
    if (o.failed) failed_accounts.push(o.failed);
    if (o.row) perAccount.push(o.row);
  });

  const allEmails = perAccount.flatMap((r) => (r && r.success ? r.emails || [] : []));
  allEmails.sort((a, b) => _compareDatesDesc(a.date, b.date));

  const page = allEmails.slice(off, off + lim);
  const total_found = perAccount.reduce((sum, r) => sum + Number((r && r.total_found) || 0), 0);
  const duplicates_removed = perAccount.reduce((sum, r) => sum + Number((r && r.duplicates_removed) || 0), 0);
  const total_found_is_upper_bound = perAccount.some((r) => r && r.total_found_is_upper_bound);
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
    ...(duplicates_removed ? { duplicates_removed } : {}),
    ...(total_found_is_upper_bound ? { total_found_is_upper_bound } : {}),
    timed_out,
    ...(timed_out ? { pending_accounts, timeout_ms: timeoutMs, timed_out_note: `Search exceeded ${timeoutMs}ms and returned partial results; narrow with --account-id / --folder INBOX or raise --timeout` } : {}),
    search_params: { query: q, date_from, date_to, unread_only: unreadOnly, folder },
    ...(dateWarnings.length ? { warnings: dateWarnings } : {}),
    failed_accounts,
    failed_searches: [],
    partial_success: failed_accounts.length > 0,
  };
}

module.exports = { searchEmails };
