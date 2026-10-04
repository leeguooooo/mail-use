// Folder-name normalisation, the self-describing global id, and the small
// ordering helpers the read/mutate paths share. Kept apart from the services
// themselves so the mutate and send paths can use them without importing the
// whole of email.js (which imports them back).

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
    const flagSet = _mailboxFlagSet(mb);
    if (flagSet.has("\\Noselect") || flagSet.has("\\NonExistent")) continue;
    const special = String(mb.specialUse || "");
    if (special === "\\All") continue; // Gmail's "All Mail" duplicates everything else.
    out.push(path);
  }
  return out;
}

// imapflow reports LIST flags as a Set; older shapes / fixtures use an array.
function _mailboxFlagSet(mb) {
  const raw = mb && mb.flags;
  if (raw instanceof Set) return new Set([...raw].map((f) => String(f)));
  return new Set((Array.isArray(raw) ? raw : []).map((f) => String(f)));
}

// The role a mailbox plays: its special-use attribute (\Sent, \Trash, ...),
// or \Important, which Gmail advertises as a LIST flag that imapflow does not
// map to specialUse. "" for an ordinary (user) folder.
function _mailboxRole(mb) {
  const special = String((mb && mb.specialUse) || "");
  if (special) return special;
  return _mailboxFlagSet(mb).has("\\Important") ? "\\Important" : "";
}

// How canonical a folder is as "the" location of a message that shows up in
// several folders (Gmail exposes every label as a folder). Lower wins: INBOX,
// then user folders/labels, then Archive/Sent/Drafts/Junk/Trash, then the
// label-like views (Important/Starred) and All Mail.
const _ROLE_RANK = {
  "\\Archive": 2, "\\Sent": 3, "\\Drafts": 4, "\\Junk": 5, "\\Trash": 6,
  "\\Important": 7, "\\Flagged": 7, "\\All": 8,
};
function _folderCanonicalRank(path, role) {
  if (String(path || "").toUpperCase() === "INBOX" || role === "\\Inbox") return 0;
  return _ROLE_RANK[role] || 1;
}

// Identity of a message across folders of ONE account: the server's stable
// email id (Gmail X-GM-MSGID / RFC 8474 EMAILID, which imapflow fetches as
// emailId) when present, else the Message-ID header. null when neither exists:
// from+date+subject is too weak to prove two rows are one message (two distinct
// notifications can share sender, second and subject), so such rows are never
// merged.
function _messageIdentityKey(item, emailId) {
  if (emailId) return `eid:${emailId}`;
  const mid = String((item && item.message_id) || "").trim().toLowerCase();
  if (mid) return `mid:${mid}`;
  return null;
}

// Collapse the same message seen in several folders down to its most canonical
// location. `keyOf(item)` gives the identity key, `rankOf(folder)` the folder
// rank. Copies in the SAME folder as the winner are kept (two physical messages
// with one Message-ID in one mailbox are not label aliases). Rows whose key is
// null (no strong identity) are always kept. Input order is preserved.
// Returns { emails, removed }.
function _dedupeAcrossFolders(emails, keyOf, rankOf) {
  const best = new Map();
  for (const e of emails || []) {
    const k = keyOf(e);
    if (k == null) continue;
    const cur = best.get(k);
    if (!cur || rankOf(e.folder) < rankOf(cur.folder)) best.set(k, e);
  }
  const out = [];
  for (const e of emails || []) {
    const k = keyOf(e);
    if (k == null || e.folder === best.get(k).folder) out.push(e);
  }
  return { emails: out, removed: (emails || []).length - out.length };
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

// Compact IMAP sequence-set for a list of UIDs: [1,2,3,7,9,10] -> "1:3,7,9:10".
// One command per batch instead of one per UID, and the range form keeps the
// command line short even for thousands of contiguous UIDs.
function _uidSetString(uids) {
  const sorted = [...new Set((uids || []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const parts = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Promise.all with at most `limit` tasks in flight. Results keep input order.
// Per-account work runs on separate IMAP connections, so accounts can proceed
// in parallel; the bound keeps a 20-account setup from opening 20 sockets at
// once (and from tripping provider rate limits).
async function _mapLimit(items, limit, fn) {
  const list = Array.from(items || []);
  const out = new Array(list.length);
  let next = 0;
  const n = Math.max(1, Math.min(Number(limit) || 1, list.length));
  const workers = [];
  for (let w = 0; w < n; w += 1) {
    workers.push((async () => {
      while (next < list.length) {
        const i = next;
        next += 1;
        out[i] = await fn(list[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// Accounts processed concurrently by list/search/sync.
const ACCOUNT_CONCURRENCY = 4;

module.exports = {
  ACCOUNT_CONCURRENCY,
  _uidSetString,
  _chunk,
  _mapLimit,
  _normalizeFolder,
  _gid,
  _listMailboxes,
  _selectableFoldersFor,
  _mailboxRole,
  _folderCanonicalRank,
  _messageIdentityKey,
  _dedupeAcrossFolders,
  _uidsSortedDesc,
  _compareDatesDesc,
};
