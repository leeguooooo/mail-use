// Best-effort writes to the local cache (email_sync.db) after an IMAP
// operation, and the path lookup they share with folder resolution.

const { paths } = require("@mail-use/shared");

const syncDb = require("../../storage/sync_db");

function _syncDbPath() {
  try {
    return paths.getPathConfig().emailSyncDb;
  } catch {
    return "";
  }
}

// Best-effort cache update: all of one operation's changes go through a
// single write session (one lock, one read and one rewrite of the DB file).
// A cache failure never fails the IMAP operation that already happened.
async function _cacheWrite(fn) {
  const dbPath = _syncDbPath();
  if (!dbPath) return;
  try {
    await syncDb.withWriteSession(dbPath, fn);
  } catch (e) {
    if (process.env.MAILBOX_DEBUG) process.stderr.write(`mail-use: cache update failed: ${(e && e.message) || e}\n`);
  }
}

module.exports = { _syncDbPath, _cacheWrite };
