// Run one IMAP command for a whole set of UIDs (STORE / MOVE / EXPUNGE all
// accept a sequence set) while still reporting a per-UID outcome.
//
// A server rejects a UID STORE/MOVE as a whole, so when a batch fails we do
// not know which UID it objected to. Retrying that chunk one UID at a time
// attributes the error to the UIDs that actually fail; the common case (the
// batch succeeds) costs one round trip per chunk instead of one per UID.

const { _uidSetString, _chunk } = require("./internals");
const { UID_CHUNK } = require("./trash");

function _errMsg(e) {
  return (e && e.message) || "failed";
}

// imapflow's messageFlagsAdd/Remove, messageMove and messageDelete resolve to
// false when the server answers NO instead of throwing, so a rejected command
// has to be turned into an error here or it would be reported as done.
async function _attempt(runCommand, range) {
  const res = await runCommand(range);
  if (res === false) throw new Error("server rejected the command");
  return res;
}

// runCommand(range: string) issues the IMAP command for a UID set string.
// Returns Map<number uid, string|null error>.
async function _runBatched(uids, runCommand, { chunkSize = UID_CHUNK } = {}) {
  const outcome = new Map();
  const unique = [...new Set((uids || []).map(Number))];
  for (const chunk of _chunk(unique, chunkSize)) {
    try {
      await _attempt(runCommand, _uidSetString(chunk));
      for (const u of chunk) outcome.set(u, null);
    } catch (batchErr) {
      if (chunk.length === 1) {
        outcome.set(chunk[0], _errMsg(batchErr));
        continue;
      }
      for (const u of chunk) {
        try {
          await _attempt(runCommand, String(u));
          outcome.set(u, null);
        } catch (e) {
          outcome.set(u, _errMsg(e));
        }
      }
    }
  }
  return outcome;
}

// Split raw ids into valid positive-integer UIDs and the ones that are not.
function _parseUidList(ids) {
  const valid = [];
  const invalid = [];
  for (const raw of ids) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) valid.push(n);
    else invalid.push(String(raw));
  }
  return { valid, invalid };
}

module.exports = { _runBatched, _parseUidList };
