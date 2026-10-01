const fs = require("fs");

const { paths } = require("@mail-use/shared");
const accounts = require("./accounts");
const syncDb = require("../storage/sync_db");
const { withImapClient } = require("./imap");
const { _envelopeItem } = require("./email/items");
const { _uidSetString, _uidsSortedDesc, _mapLimit, ACCOUNT_CONCURRENCY } = require("./email/internals");

function _nowIso() {
  return new Date().toISOString();
}

function _safeStatSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function _readJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Sync state names every account id and email address: owner only, like
// auth.json and the cache DB. chmod after the write because writeFileSync's
// mode only applies when it creates the file.
function _writeJson(p, value) {
  fs.mkdirSync(require("path").dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* ignore */ }
}

function _loadSyncState() {
  const pc = paths.getPathConfig();
  const statePath = pc.syncHealthHistoryJson;
  const st = _readJson(statePath);
  if (st && typeof st === "object") return { statePath, state: st };
  return { statePath, state: { last_sync_times: { incremental: null, full: null }, accounts: {} } };
}

function _syncCounts(state) {
  const c = (state && state.sync_counts) || {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  return { total: n(c.total), failures: n(c.failures) };
}

function status() {
  const pc = paths.getPathConfig();
  const all = accounts.getAllAccountsResolved();
  if (!all.success) return all;
  const { state } = _loadSyncState();

  const outAccounts = (all.accounts || []).map((a) => {
    const per = state.accounts && state.accounts[a.id] ? state.accounts[a.id] : {};
    return {
      id: a.id,
      email: a.email,
      provider: a.provider,
      last_sync: per.last_sync || null,
      total_emails: per.total_emails || 0,
      sync_status: per.sync_status || "pending",
    };
  });

  return {
    success: true,
    scheduler_running: false,
    config: {},
    last_sync_times: state.last_sync_times || { incremental: null, full: null },
    next_jobs: [],
    accounts: outAccounts,
    total_emails: outAccounts.reduce((s, a) => s + Number(a.total_emails || 0), 0),
    database_size: _safeStatSize(pc.emailSyncDb),
  };
}

// Newest N messages per folder kept in the cache window.
const SYNC_WINDOW = 200;
const SYNC_FOLDER = "INBOX";

function _bigToString(v) {
  return v === undefined || v === null ? "" : String(v);
}

// Talk to IMAP for one folder. Pure read; the caller writes the outcome.
//
// Incremental when the last pass recorded UIDVALIDITY + UIDNEXT, the server's
// UIDVALIDITY still matches, and the cache holds rows for the folder:
//   - envelopes are fetched only for UIDs in the newest window that the
//     cache lacks (new mail, or older mail that slid in after an expunge);
//   - flags of already-cached UIDs are refreshed with CHANGEDSINCE when the
//     server does CONDSTORE (and skipped entirely when HIGHESTMODSEQ hasn't
//     moved), else with a flags-only FETCH — a few bytes per message instead
//     of a full envelope + bodystructure;
//   - one UID SEARCH ALL lists what still exists, for expunge detection.
// Otherwise (first sync, --full, or UIDVALIDITY changed) the newest
// SYNC_WINDOW envelopes are fetched as before.
async function _scanFolder(account, folder, prev, { full }) {
  return withImapClient(account, async (client) => {
    const st = await client.mailboxOpen(folder);
    const uidValidity = _bigToString(st && st.uidValidity);
    let uidNext = Number((st && st.uidNext) || 0);
    const highestModseq = _bigToString(st && st.highestModseq);

    let unreadCount = 0;
    try {
      const ss = await client.status(folder, { unseen: true });
      if (ss && ss.unseen != null) unreadCount = Number(ss.unseen);
    } catch (e) {
      if (process.env.MAILBOX_DAEMON_DEBUG) process.stderr.write(`mail-use: STATUS UNSEEN failed for ${account.email}/${folder}: ${(e && e.message) || e}\n`);
    }

    const found = await client.search({ all: true }, { uid: true });
    const serverUids = _uidsSortedDesc(Array.isArray(found) ? found : []);
    // Some servers (163) leave UIDNEXT out of SELECT, which would keep every
    // pass on the full path. UIDs only ever grow, so one past the highest UID
    // that exists is a safe lower bound for where new mail starts.
    if (!uidNext && serverUids.length) uidNext = Number(serverUids[0]) + 1;

    const validityChanged = Boolean(prev.uidValidity && uidValidity && prev.uidValidity !== uidValidity);
    const incremental = !full && !validityChanged && Boolean(prev.uidValidity) && uidValidity === prev.uidValidity
      && prev.uidNext > 0 && prev.cachedUids.length > 0;

    // Incremental: whatever in the newest-SYNC_WINDOW window isn't cached yet.
    // That is new mail, plus older mail that slid into the window after
    // something newer was expunged.
    const cachedSet = new Set(prev.cachedUids.map(Number));
    const toFetch = incremental
      ? serverUids.slice(0, SYNC_WINDOW).filter((u) => !cachedSet.has(u))
      : serverUids.slice(0, SYNC_WINDOW);

    const newEmails = [];
    if (toFetch.length) {
      for await (const msg of client.fetch(
        _uidSetString(toFetch),
        { envelope: true, flags: true, internalDate: true, bodyStructure: true },
        { uid: true }
      )) {
        const item = _envelopeItem(account, folder, msg, "imap_fetch");
        item.flagged = Boolean(msg.flags && msg.flags.has("\\Flagged"));
        newEmails.push(item);
      }
    }

    // Flag refresh for messages already in the cache.
    const flagUpdates = [];
    let flagMode = "none";
    if (incremental) {
      const live = new Set(serverUids);
      const cachedLive = prev.cachedUids.map(Number).filter((u) => live.has(u) && u < prev.uidNext);
      if (cachedLive.length) {
        let fetchOpts = null;
        if (highestModseq && prev.highestModseq) {
          if (highestModseq !== prev.highestModseq) {
            fetchOpts = { uid: true, changedSince: BigInt(prev.highestModseq) };
            flagMode = "condstore";
          } else {
            flagMode = "unchanged";
          }
        } else {
          fetchOpts = { uid: true };
          flagMode = "flags";
        }
        if (fetchOpts) {
          for await (const msg of client.fetch(_uidSetString(cachedLive), { flags: true }, fetchOpts)) {
            const flags = msg.flags || new Set([]);
            flagUpdates.push({ uid: String(msg.uid), unread: !flags.has("\\Seen"), flagged: flags.has("\\Flagged") });
          }
        }
      }
    }

    return {
      mode: incremental ? "incremental" : "full",
      flagMode,
      validityChanged,
      uidValidity,
      uidNext,
      highestModseq,
      totalInFolder: Number((st && st.exists) || 0),
      unreadCount,
      serverUids,
      newEmails,
      flagUpdates,
    };
  }, { idempotent: true });
}

// Sync one account: 1 DB read, the IMAP pass, 1 write session (it used to be
// a write, a read and another write, around a full re-fetch of 200 envelopes).
async function _syncAccount(a, { dbPath, full }) {
  const prev = await syncDb.getFolderSyncState({ dbPath, accountId: a.id, folder: SYNC_FOLDER });
  const scan = await _scanFolder(a, SYNC_FOLDER, prev, { full });

  const cachedBefore = new Set(prev.cachedUids.map(String));
  const cachedFlags = prev.cachedFlags || new Map();
  // Only rows whose flags really changed on the server count as updated.
  const emailsUpdated = scan.flagUpdates.filter((u) => {
    const c = cachedFlags.get(String(u.uid));
    return !c || c.unread !== u.unread || c.flagged !== u.flagged;
  }).length;
  let emailsDeleted = 0;
  let emailsAdded = 0;
  // Single write session per account: one DB open, one flush, one file
  // lock. Prevents lost updates across concurrent CLI invocations. Orphans
  // are computed under the lock from what is cached *now*, not from the
  // pre-IMAP snapshot, so rows another process added meanwhile are judged on
  // current data.
  await syncDb.withWriteSession(dbPath, (s) => {
    s.upsertAccount({ id: a.id, email: a.email, provider: a.provider || "custom" });
    if (scan.validityChanged) {
      // UIDVALIDITY changed: every cached UID now names a different (or no)
      // message. Start the folder over.
      emailsDeleted += s.clearFolder({ accountId: a.id, folder: SYNC_FOLDER });
      cachedBefore.clear();
    }
    const folderId = s.upsertFolder({
      accountId: a.id,
      name: SYNC_FOLDER,
      displayName: SYNC_FOLDER,
      messageCount: scan.totalInFolder,
      unreadCount: scan.unreadCount,
      lastSyncIso: _nowIso(),
      uidValidity: scan.uidValidity,
      uidNext: scan.uidNext,
      highestModseq: scan.highestModseq,
    });
    if (folderId) s.upsertEmails({ accountId: a.id, folderId, emails: scan.newEmails });
    emailsAdded = scan.newEmails.filter((e) => !cachedBefore.has(String(e.uid))).length;

    // Apply refreshed flags, grouped so each distinct state is one UPDATE.
    // Fetched envelopes count too: upsertEmails leaves is_flagged alone (so a
    // local `flag` survives), so the server's \Flagged is applied here.
    const flagState = [
      ...scan.flagUpdates,
      ...scan.newEmails.map((e) => ({ uid: String(e.uid), unread: e.unread, flagged: e.flagged })),
    ];
    const groups = new Map();
    for (const u of flagState) {
      const key = `${u.unread ? 1 : 0}${u.flagged ? 1 : 0}`;
      if (!groups.has(key)) groups.set(key, { unread: u.unread, flagged: u.flagged, uids: [] });
      groups.get(key).uids.push(u.uid);
    }
    for (const g of groups.values()) {
      s.updateFlags({ accountId: a.id, folder: SYNC_FOLDER, uids: g.uids, unread: g.unread, flagged: g.flagged });
    }

    // Expunged on the server since the last pass.
    const live = new Set(scan.serverUids.map(String));
    const orphans = s.getUids({ accountId: a.id, folder: SYNC_FOLDER }).filter((uid) => !live.has(String(uid)));
    if (orphans.length) emailsDeleted += s.removeEmails({ accountId: a.id, folder: SYNC_FOLDER, uids: orphans });
  });

  return {
    success: true,
    account_id: a.id,
    folders_synced: 1,
    mode: scan.mode,
    emails_added: emailsAdded,
    emails_updated: emailsUpdated,
    emails_deleted: emailsDeleted,
    total_in_folder: scan.totalInFolder,
  };
}

async function force({ account_id = "", full = false } = {}) {
  const pc = paths.getPathConfig();
  // Ensure parent dir exists. Don't pre-create a 0-byte file: sql.js treats
  // an empty Uint8Array as a corrupt DB. The first write session creates it.
  try {
    fs.mkdirSync(require("path").dirname(pc.emailSyncDb), { recursive: true, mode: 0o700 });
  } catch {
    // ignore
  }

  const all = accounts.getAllAccountsResolved();
  if (!all.success) return all;
  const list = all.accounts || [];

  const target = account_id
    ? list.filter((a) => String(a.id).toLowerCase() === String(account_id).toLowerCase() || String(a.email).toLowerCase() === String(account_id).toLowerCase())
    : list;

  const started = Date.now();
  const { statePath, state } = _loadSyncState();
  if (!state.accounts) state.accounts = {};

  // Accounts sync concurrently (bounded). Their IMAP work overlaps; the
  // cache writes still serialise on the DB file lock.
  const results = await _mapLimit(target, ACCOUNT_CONCURRENCY, async (a) => {
    try {
      const r = await _syncAccount(a, { dbPath: pc.emailSyncDb, full: Boolean(full) });
      state.accounts[a.id] = { last_sync: _nowIso(), total_emails: r.total_in_folder || 0, sync_status: "ok" };
      delete r.total_in_folder;
      return r;
    } catch (e) {
      return { success: false, account_id: a.id, error: e && e.message ? e.message : "sync failed" };
    }
  });

  // Running totals of per-account sync attempts, so health() reports real
  // numbers instead of constants. Older state files lack the key; it starts
  // counting from the first sync after upgrade.
  const counts = _syncCounts(state);
  counts.total += results.length;
  counts.failures += results.filter((r) => !r.success).length;
  state.sync_counts = counts;

  state.last_sync_times = state.last_sync_times || { incremental: null, full: null };
  state.last_sync_times[full ? "full" : "incremental"] = _nowIso();
  _writeJson(statePath, state);

  const sync_time = (Date.now() - started) / 1000;
  if (account_id) {
    const one = results[0] || { success: false, error: "No account matched" };
    if (!one.success) return { success: false, error: one.error || "sync failed" };
    return {
      success: true,
      account_id: one.account_id,
      folders_synced: one.folders_synced || 0,
      mode: one.mode,
      emails_added: one.emails_added || 0,
      emails_updated: one.emails_updated || 0,
      emails_deleted: one.emails_deleted || 0,
    };
  }

  const okCount = results.filter((r) => r.success).length;
  return {
    success: okCount === results.length,
    accounts_synced: okCount,
    total_accounts: results.length,
    emails_added: results.reduce((sum, r) => sum + Number(r.emails_added || 0), 0),
    emails_updated: results.reduce((sum, r) => sum + Number(r.emails_updated || 0), 0),
    emails_deleted: results.reduce((sum, r) => sum + Number(r.emails_deleted || 0), 0),
    sync_time,
    results,
  };
}

async function init() {
  return force({});
}

function health() {
  const { state } = _loadSyncState();
  const accountsState = state.accounts || {};
  const total_accounts = Object.keys(accountsState).length;
  const healthy_accounts = Object.values(accountsState).filter((a) => a && a.sync_status === "ok").length;
  const { total: total_syncs, failures: total_failures } = _syncCounts(state);
  return {
    success: true,
    status: healthy_accounts === total_accounts ? "healthy" : "warning",
    total_accounts,
    healthy_accounts,
    warning_accounts: total_accounts - healthy_accounts,
    critical_accounts: 0,
    average_health_score: total_accounts ? (healthy_accounts / total_accounts) * 100 : 100.0,
    // From the counters force() keeps in the state file. A file written
    // before they existed reads as 0 syncs / 100% — what this always reported.
    total_syncs,
    total_failures,
    success_rate: total_syncs ? ((total_syncs - total_failures) / total_syncs) * 100 : 100.0,
    timestamp: _nowIso(),
  };
}

module.exports = {
  status,
  force,
  init,
  health,
};
