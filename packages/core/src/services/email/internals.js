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

module.exports = {
  _normalizeFolder,
  _gid,
  _listMailboxes,
  _selectableFoldersFor,
  _uidsSortedDesc,
  _compareDatesDesc,
};
