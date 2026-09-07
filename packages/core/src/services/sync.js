const fs = require("fs");

const { paths } = require("@mail-use/shared");
const accounts = require("./accounts");
const syncDb = require("../storage/sync_db");

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

function _writeJson(p, value) {
  fs.mkdirSync(require("path").dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function _loadSyncState() {
  const pc = paths.getPathConfig();
  const statePath = pc.syncHealthHistoryJson;
  const st = _readJson(statePath);
  if (st && typeof st === "object") return { statePath, state: st };
  return { statePath, state: { last_sync_times: { incremental: null, full: null }, accounts: {} } };
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

async function force({ account_id = "", full = false } = {}) {
  const pc = paths.getPathConfig();
  // Ensure parent dir exists. Don't pre-create a 0-byte file: sql.js treats
  // an empty Uint8Array as a corrupt DB. The first write session creates it.
  try {
    fs.mkdirSync(require("path").dirname(pc.emailSyncDb), { recursive: true });
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

  const results = [];
  for (const a of target) {
    const email = require("./email");
    try {
      const listRes = await email.listEmails({ limit: 200, offset: 0, unread_only: false, folder: "INBOX", account_id: a.id, use_cache: false, include_server_uids: true });

      // Single write session per account: one DB open, one flush, one file
      // lock. Prevents lost updates across concurrent CLI invocations and
      // the within-account upsertAccount → upsertFolder → upsertEmails race.
      await syncDb.withWriteSession(pc.emailSyncDb, (s) => {
        s.upsertAccount({ id: a.id, email: a.email, provider: a.provider || "custom" });
        const folderId = s.upsertFolder({
          accountId: a.id,
          name: "INBOX",
          displayName: "INBOX",
          messageCount: listRes.total_in_folder || 0,
          unreadCount: listRes.unread_count || 0,
          lastSyncIso: _nowIso(),
        });
        if (folderId) {
          s.upsertEmails({ accountId: a.id, folderId, emails: listRes.emails || [] });
        }
      });

      let emailsDeleted = 0;
      if (listRes.all_uids_are_complete && Array.isArray(listRes.server_uids)) {
        const serverUids = new Set(listRes.server_uids.map((uid) => String(uid)));
        const cachedUids = await syncDb.getEmailUIDsFromCache({
          dbPath: pc.emailSyncDb,
          accountId: a.id,
          folder: "INBOX",
        });
        const orphanedUids = cachedUids.filter((uid) => !serverUids.has(String(uid)));
        if (orphanedUids.length) {
          const removed = await syncDb.removeEmailsFromCache({
            dbPath: pc.emailSyncDb,
            accountId: a.id,
            uids: orphanedUids,
          });
          if (removed && removed.success) emailsDeleted = orphanedUids.length;
        }
      }

      const per = {
        last_sync: _nowIso(),
        total_emails: listRes.total_in_folder || 0,
        sync_status: listRes.success ? "ok" : "error",
      };
      if (!state.accounts) state.accounts = {};
      state.accounts[a.id] = per;
      results.push({ success: true, account_id: a.id, folders_synced: 1, emails_added: 0, emails_updated: 0, emails_deleted: emailsDeleted });
    } catch (e) {
      results.push({ success: false, account_id: a.id, error: e && e.message ? e.message : "sync failed" });
    }
  }

  state.last_sync_times = state.last_sync_times || { incremental: null, full: null };
  state.last_sync_times[full ? "full" : "incremental"] = _nowIso();
  _writeJson(statePath, state);

  const sync_time = (Date.now() - started) / 1000;
  if (account_id) {
    const one = results[0] || { success: false, error: "No account matched" };
    if (!one.success) return { success: false, error: one.error || "sync failed" };
    return { success: true, account_id: one.account_id, folders_synced: one.folders_synced || 0, emails_added: 0, emails_updated: 0, emails_deleted: one.emails_deleted || 0 };
  }

  const okCount = results.filter((r) => r.success).length;
  return {
    success: okCount === results.length,
    accounts_synced: okCount,
    total_accounts: results.length,
    emails_added: 0,
    emails_updated: 0,
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
  return {
    success: true,
    status: healthy_accounts === total_accounts ? "healthy" : "warning",
    total_accounts,
    healthy_accounts,
    warning_accounts: total_accounts - healthy_accounts,
    critical_accounts: 0,
    average_health_score: total_accounts ? (healthy_accounts / total_accounts) * 100 : 100.0,
    total_syncs: 0,
    total_failures: 0,
    success_rate: 100.0,
    timestamp: _nowIso(),
  };
}

module.exports = {
  status,
  force,
  init,
  health,
};
