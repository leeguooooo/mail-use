// Server-side changes to existing mail: mark read/unread, delete (to trash
// or permanently), flag, move. Each keeps the local cache in step afterwards.

const accounts = require("../accounts");
const { withImapClient } = require("../imap");
const { _normalizeFolder } = require("./internals");
const { _findTrashFolder, _existingUids } = require("./trash");
const { _runBatched, _parseUidList } = require("./batch");
const { _cacheWrite } = require("./cache");

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
    // One UID STORE for the whole set (per chunk), not one per uid.
    const { valid } = _parseUidList(ids);
    const outcome = await _runBatched(valid, (range) => (markAs === "read"
      ? client.messageFlagsAdd(range, ["\\Seen"], { uid: true })
      : client.messageFlagsRemove(range, ["\\Seen"], { uid: true })));
    const results = ids.map((raw) => {
      const n = Number(raw);
      const base = { email_id: outcome.has(n) ? String(n) : String(raw), folder: openFolder, account_id: acc.account.id };
      if (!outcome.has(n)) return { success: false, ...base, error: "Invalid email_id" };
      const err = outcome.get(n);
      return err ? { success: false, ...base, error: err } : { success: true, ...base };
    });
    const marked = results.filter((r) => r.success).length;
    if (marked > 0) {
      const successfulUids = results.filter((r) => r.success).map((r) => r.email_id);
      await _cacheWrite((s) => {
        s.updateFlags({ accountId: acc.account.id, folder: openFolder, uids: successfulUids, unread: markAs === "unread" });
        s.invalidateUnread({ accountId: acc.account.id, folder: openFolder });
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

    // Round trips for N uids: one UID SEARCH for existence and one MOVE /
    // EXPUNGE for the whole set (per 500-uid chunk), plus a SELECT + SEARCH of
    // the trash only when some uids were already gone. It used to be four
    // per uid (SELECT, FETCH, SELECT, MOVE).
    const { valid } = _parseUidList(ids);
    const existing = await _existingUids(client, valid);
    const present = valid.filter((u) => existing.has(u));
    const outcome = await _runBatched(present, (range) => (permanent
      ? client.messageDelete(range, { uid: true })
      : client.messageMove(range, trashName, { uid: true })));

    // Already-gone uids: a retried delete whose first attempt went through
    // shows up in the trash, which counts as success.
    const missing = [...new Set(valid.filter((u) => !existing.has(u)))];
    let inTrash = new Set();
    let existingTrashName = "";
    if (missing.length) {
      try {
        existingTrashName = await ensureTrashName();
        if (existingTrashName !== openFolder) {
          await client.mailboxOpen(existingTrashName);
          inTrash = await _existingUids(client, missing);
        }
      } catch {
        inTrash = new Set();
      }
    }

    const results = ids.map((raw) => {
      const n = Number(raw);
      if (outcome.has(n)) {
        const err = outcome.get(n);
        return err
          ? { success: false, email_id: String(n), folder: openFolder, account_id: acc.account.id, error: err }
          : { success: true, email_id: String(n), folder: openFolder, account_id: acc.account.id };
      }
      if (inTrash.has(n)) {
        return { success: true, email_id: String(n), folder: existingTrashName, account_id: acc.account.id, already_deleted: true };
      }
      return {
        success: false,
        email_id: Number.isInteger(n) && n > 0 ? String(n) : String(raw),
        folder: openFolder,
        account_id: acc.account.id,
        error: Number.isInteger(n) && n > 0 ? "Email not found in source folder or trash" : "Invalid email_id",
      };
    });
    const deleted = results.filter((r) => r.success).length;
    if (deleted > 0) {
      // UIDs are per-folder: scope the removal to the folder we deleted from,
      // or the same uid in another folder vanishes from the cache too.
      const removed = results.filter((r) => r.success).map((r) => r.email_id);
      await _cacheWrite((s) => s.removeEmails({ accountId: acc.account.id, folder: openFolder, uids: removed }));
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
    // Keep the cache in step with the server for the flags it mirrors, so a
    // cached list right after `flag --type read` doesn't contradict it.
    if (flag === "\\Seen" || flag === "\\Flagged") {
      await _cacheWrite((s) => {
        s.updateFlags({
          accountId: acc.account.id,
          folder: openFolder,
          uids: [String(uid)],
          ...(flag === "\\Seen" ? { unread: !set } : { flagged: set }),
        });
        if (flag === "\\Seen") s.invalidateUnread({ accountId: acc.account.id, folder: openFolder });
      });
    }
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
    // One UID SEARCH + one UID MOVE for the set, instead of a MOVE per uid.
    // The search also catches uids that aren't in the source folder: a MOVE
    // of a missing uid is a silent no-op on the server, which used to be
    // reported as moved.
    const existing = await _existingUids(client, ids);
    const present = ids.filter((u) => existing.has(u));
    const outcome = await _runBatched(present, (range) => client.messageMove(range, tgt, { uid: true }));
    const failed_ids = [];
    const moved_ids = [];
    for (const uid of ids) {
      if (outcome.has(uid) && outcome.get(uid) === null) moved_ids.push(String(uid));
      else failed_ids.push(String(uid));
    }
    const moved = moved_ids.length;
    if (moved_ids.length) {
      // The moved messages no longer exist under these UIDs in the source
      // folder (the target assigns new ones). Drop them from the cache so a
      // cached list doesn't keep showing them where they were, and invalidate
      // both folders' unread snapshots — unread mail changed sides.
      await _cacheWrite((s) => {
        s.removeEmails({ accountId: acc.account.id, folder: src, uids: moved_ids });
        s.invalidateUnread({ accountId: acc.account.id, folder: src });
        s.invalidateUnread({ accountId: acc.account.id, folder: tgt });
      });
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

module.exports = { markEmails, deleteEmails, flagEmail, moveEmails };
