// Finding the right Trash folder. Providers disagree on what it is called and
// on whether they advertise \\Trash at all, so deletion has to shop around
// before falling back to a permanent expunge.

const { _listMailboxes, _selectableFoldersFor } = require("./internals");

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

module.exports = {
  _trashFolderCandidates,
  _findTrashFolder,
  _uidExistsInFolder,
};
