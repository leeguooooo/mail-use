const fs = require("fs");
const path = require("path");

// Use asm.js build to avoid shipping wasm assets.
const initSqlJs = require("sql.js/dist/sql-asm.js");

let _sqlPromise = null;

async function _getSQL() {
  if (!_sqlPromise) _sqlPromise = initSqlJs();
  return _sqlPromise;
}

function _readDbFile(dbPath) {
  try {
    if (!fs.existsSync(dbPath)) return null;
    const buf = fs.readFileSync(dbPath);
    if (!buf || buf.length === 0) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function _writeDbFileAtomic(dbPath, bytes) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, Buffer.from(bytes));
  fs.renameSync(tmp, dbPath);
}

async function _acquireLock(dbPath, { retries = 100, delayMs = 50 } = {}) {
  const lockPath = `${dbPath}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let i = 0; i < retries; i += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return lockPath;
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
      // Stale lock: if older than 60s, remove it.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 60_000) {
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
          continue;
        }
      } catch { /* lock disappeared, retry */ }
      await new Promise((r) => { setTimeout(r, delayMs); });
    }
  }
  throw new Error(`sync_db: could not acquire lock at ${lockPath}`);
}

function _releaseLock(lockPath) {
  if (!lockPath) return;
  try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
}

function _ensureSchema(db) {
  // Matches Python schema in src/database/email_sync_db.py
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      last_sync TIMESTAMP,
      total_emails INTEGER DEFAULT 0,
      sync_status TEXT DEFAULT 'never',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT,
      message_count INTEGER DEFAULT 0,
      unread_count INTEGER DEFAULT 0,
      last_sync TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts (id),
      UNIQUE(account_id, name)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      folder_id INTEGER NOT NULL,
      uid TEXT NOT NULL,
      message_id TEXT,
      subject TEXT,
      sender TEXT,
      sender_email TEXT,
      recipients TEXT,
      date_sent TIMESTAMP,
      date_received TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_read BOOLEAN DEFAULT FALSE,
      is_flagged BOOLEAN DEFAULT FALSE,
      is_deleted BOOLEAN DEFAULT FALSE,
      has_attachments BOOLEAN DEFAULT FALSE,
      size_bytes INTEGER DEFAULT 0,
      content_hash TEXT,
      sync_status TEXT DEFAULT 'synced',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts (id),
      FOREIGN KEY (folder_id) REFERENCES folders (id),
      UNIQUE(account_id, folder_id, uid)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS email_content (
      email_id INTEGER PRIMARY KEY,
      plain_text TEXT,
      html_text TEXT,
      headers TEXT,
      raw_size INTEGER,
      content_loaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (email_id) REFERENCES emails (id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id INTEGER NOT NULL,
      filename TEXT,
      content_type TEXT,
      size_bytes INTEGER DEFAULT 0,
      content_id TEXT,
      is_inline BOOLEAN DEFAULT FALSE,
      data BLOB,
      file_path TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (email_id) REFERENCES emails (id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      folder_name TEXT,
      sync_type TEXT,
      start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      end_time TIMESTAMP,
      emails_added INTEGER DEFAULT 0,
      emails_updated INTEGER DEFAULT 0,
      emails_deleted INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      error_message TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts (id)
    );
  `);

  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_emails_account_folder ON emails (account_id, folder_id)",
    "CREATE INDEX IF NOT EXISTS idx_emails_uid ON emails (uid)",
    "CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails (message_id)",
    "CREATE INDEX IF NOT EXISTS idx_emails_date_sent ON emails (date_sent)",
    "CREATE INDEX IF NOT EXISTS idx_emails_is_read ON emails (is_read)",
    "CREATE INDEX IF NOT EXISTS idx_emails_is_flagged ON emails (is_flagged)",
    "CREATE INDEX IF NOT EXISTS idx_emails_subject ON emails (subject)",
    "CREATE INDEX IF NOT EXISTS idx_emails_sender_email ON emails (sender_email)",
    "CREATE INDEX IF NOT EXISTS idx_folders_account ON folders (account_id)",
    "CREATE INDEX IF NOT EXISTS idx_sync_history_account ON sync_history (account_id)",
    "CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments (email_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uniq_emails_account_folder_uid ON emails (account_id, folder_id, uid)",
  ];
  for (const sql of indexes) db.run(sql);
}

function _execScalar(db, sql, params) {
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params);
    if (!stmt.step()) return null;
    const row = stmt.get();
    return row && row.length ? row[0] : null;
  } finally {
    stmt.free();
  }
}

function _execRows(db, sql, params) {
  const stmt = db.prepare(sql);
  try {
    if (params) stmt.bind(params);
    const cols = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      const values = stmt.get();
      const obj = {};
      for (let i = 0; i < cols.length; i += 1) obj[cols[i]] = values[i];
      rows.push(obj);
    }
    return rows;
  } finally {
    stmt.free();
  }
}

// Open the DB without an exclusive lock — readers only. Call close() when done.
async function openSyncDb(dbPath) {
  const SQL = await _getSQL();
  const data = _readDbFile(dbPath);
  const db = data ? new SQL.Database(data) : new SQL.Database();
  _ensureSchema(db);
  return {
    db,
    flush() {
      const bytes = db.export();
      _writeDbFileAtomic(dbPath, bytes);
    },
    close() {
      db.close();
    },
  };
}

// Run a write session under an exclusive file lock. Opens the DB once,
// allows the caller to issue many writes through `session`, then flushes
// once on success. Releases the lock on all exit paths.
async function withWriteSession(dbPath, fn) {
  const lockPath = await _acquireLock(dbPath);
  let h;
  try {
    h = await openSyncDb(dbPath);
    const session = {
      db: h.db,
      upsertAccount({ id, email, provider }) {
        h.db.run(
          "INSERT OR REPLACE INTO accounts (id, email, provider, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
          [String(id), String(email), String(provider)]
        );
      },
      upsertFolder({ accountId, name, displayName, messageCount, unreadCount, lastSyncIso }) {
        h.db.run(
          `
            INSERT INTO folders (account_id, name, display_name, message_count, unread_count, last_sync)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, name) DO UPDATE SET
              display_name = excluded.display_name,
              message_count = excluded.message_count,
              unread_count = excluded.unread_count,
              last_sync = excluded.last_sync
          `,
          [
            String(accountId),
            String(name),
            String(displayName || name),
            Number(messageCount || 0),
            Number(unreadCount || 0),
            String(lastSyncIso || new Date().toISOString()),
          ]
        );
        return Number(_execScalar(
          h.db,
          "SELECT id FROM folders WHERE account_id = ? AND name = ?",
          [String(accountId), String(name)]
        ));
      },
      upsertEmails({ accountId, folderId, emails }) {
        const stmt = h.db.prepare(
          `
            INSERT OR REPLACE INTO emails (
              account_id, folder_id, uid, message_id, subject, sender, sender_email, recipients,
              date_sent, is_read, is_flagged, is_deleted, has_attachments, size_bytes, sync_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', CURRENT_TIMESTAMP)
          `
        );
        try {
          for (const e of emails || []) {
            const uid = String(e.uid || e.id || "").trim();
            if (!uid) continue;
            const isRead = e.unread ? 0 : 1;
            stmt.run([
              String(accountId),
              Number(folderId),
              uid,
              String(e.message_id || ""),
              String(e.subject || ""),
              String(e.from || ""),
              String(e.from || ""),
              JSON.stringify({ to: e.to || "", cc: e.cc || "" }),
              String(e.date || ""),
              isRead,
              0,
              0,
              e.has_attachments ? 1 : 0,
              Number(e.size_bytes || e.size || 0),
            ]);
          }
        } finally {
          stmt.free();
        }
      },
    };
    const result = await fn(session);
    h.flush();
    return result;
  } finally {
    if (h) {
      try { h.close(); } catch { /* ignore */ }
    }
    _releaseLock(lockPath);
  }
}

function _placeholders(values) {
  return values.map(() => "?").join(", ");
}

// Age in whole seconds of an ISO-8601 timestamp (e.g. folders.last_sync)
// relative to now. Returns null for a missing/unparseable input so callers
// can tell "unknown freshness" apart from "0s old", and clamps negatives to
// 0 (a clock skew shouldn't surface as a negative age).
function _ageSecondsFrom(iso) {
  if (iso == null) return null;
  const t = Date.parse(String(iso));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

async function listEmailsFromCache({ dbPath, accountId, folder, unreadOnly, limit, offset, dateFrom, dateTo, from, includeAccountUnread = false }) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;

  const h = await openSyncDb(dbPath);
  try {
    const f = String(folder || "all");
    const resolvedFolder = f && f !== "all" ? f : "all";

    let query = `
      SELECT DISTINCT
        e.uid as id,
        e.uid as uid,
        e.message_id as message_id,
        e.subject,
        e.sender_email as "from",
        e.date_sent as date,
        e.is_read as is_read,
        e.has_attachments as has_attachments,
        e.account_id as account_id,
        COALESCE(a.email, e.account_id) as account,
        CASE WHEN e.folder_id IS NULL THEN 'INBOX' ELSE f.name END as folder
      FROM emails e
      LEFT JOIN accounts a ON e.account_id = a.id
      LEFT JOIN folders f ON e.folder_id = f.id
      WHERE e.is_deleted = 0
    `;

    const filterParams = [];
    if (accountId) {
      query += " AND e.account_id = ?";
      filterParams.push(String(accountId));
    }
    if (resolvedFolder !== "all") {
      query += " AND (f.name = ? COLLATE NOCASE OR (e.folder_id IS NULL AND ? = 'INBOX'))";
      filterParams.push(resolvedFolder);
      filterParams.push(resolvedFolder);
    }
    if (from) {
      query += " AND LOWER(e.sender_email) LIKE LOWER(?)";
      filterParams.push(`%${String(from)}%`);
    }
    // Snapshot the query BEFORE the unread filter so cached_emails is a
    // diagnostic of "how much is in cache for this scope" — independent
    // of whether this particular call asked for unread-only.
    const queryBeforeUnread = query;
    const filterParamsBeforeUnread = [...filterParams];

    if (unreadOnly) {
      query += " AND e.is_read = 0";
    }
    if (dateFrom) {
      query += " AND e.date_sent >= ?";
      filterParams.push(String(dateFrom));
    }
    if (dateTo) {
      query += " AND e.date_sent <= ?";
      filterParams.push(String(dateTo));
    }

    // cached_emails: total cache rows for the scope (account+folder+date),
    //                ignoring the unread filter so the value is comparable
    //                across calls.
    // cached_unread: explicit unread count over the same scope.
    const totalSql = `SELECT COUNT(*) FROM (${queryBeforeUnread}${dateFrom ? " AND e.date_sent >= ?" : ""}${dateTo ? " AND e.date_sent <= ?" : ""})`;
    const totalParams = [...filterParamsBeforeUnread];
    if (dateFrom) totalParams.push(String(dateFrom));
    if (dateTo) totalParams.push(String(dateTo));
    const unreadSql = `SELECT COUNT(*) FROM (${queryBeforeUnread}${dateFrom ? " AND e.date_sent >= ?" : ""}${dateTo ? " AND e.date_sent <= ?" : ""} AND e.is_read = 0)`;

    const pagedQuery = query + " ORDER BY e.date_sent DESC LIMIT ? OFFSET ?";
    const pagedParams = [...filterParams, Number(limit), Number(offset)];

    const rows = _execRows(h.db, pagedQuery, pagedParams);
    const emails = rows.map((row) => ({
      id: String(row.id),
      uid: String(row.uid),
      gid: `${row.account_id || ""}:${row.folder || "INBOX"}:${row.uid}`,
      message_id: row.message_id || "",
      subject: row.subject || "No Subject",
      from: row.from || "",
      date: row.date || "",
      unread: !row.is_read,
      has_attachments: Boolean(row.has_attachments),
      account: row.account || "",
      account_id: row.account_id || "",
      folder: row.folder || "INBOX",
      source: "cache_sync_db",
    }));

    // Counts within the cached subset. Note: the daemon syncs only the
    // newest N emails per account (default 200), so these can be a lot
    // smaller than the real IMAP folder size.
    const cached_emails = Number(_execScalar(h.db, totalSql, totalParams) || 0);
    const cached_unread = Number(_execScalar(h.db, unreadSql, totalParams) || 0);

    // Real folder size + unread count, snapshotted from IMAP STATUS at the
    // last sync. Surfaces folders.message_count / folders.unread_count when
    // we have a single account scope; falls back to the cached-subset
    // counts when listing across multiple accounts (folders aggregation
    // would need a join we'd rather not pay for in the hot path).
    let total_in_folder = cached_emails;
    let unread_count = cached_unread;
    let unread_as_of = null;
    const folderName = (resolvedFolder === "all") ? "INBOX" : resolvedFolder;
    if (accountId) {
      const row = _execRows(h.db, "SELECT message_count, unread_count, last_sync FROM folders WHERE account_id = ? AND name = ?", [String(accountId), folderName])[0];
      if (row) {
        // Important: 0 is a real value here (server reports zero unread).
        // Use explicit null-checks instead of `||` so we don't fall back
        // to the cached subset count.
        if (row.message_count != null) total_in_folder = Number(row.message_count);
        if (row.unread_count != null) unread_count = Number(row.unread_count);
        if (row.last_sync != null) unread_as_of = String(row.last_sync);
      }
    } else {
      // Cross-account: aggregate folders.unread_count + folders.message_count
      // for the requested folder name across every account that has synced.
      // COALESCE the unread sum so an invalidated (NULL) snapshot on one
      // account doesn't drop the count for its siblings.
      const aggRow = _execRows(h.db, "SELECT SUM(message_count) AS total, SUM(COALESCE(unread_count, 0)) AS unread, MAX(last_sync) AS as_of FROM folders WHERE name = ?", [folderName])[0];
      if (aggRow && aggRow.total != null) {
        total_in_folder = Number(aggRow.total);
        unread_count = aggRow.unread != null ? Number(aggRow.unread) : 0;
        if (aggRow.as_of != null) unread_as_of = String(aggRow.as_of);
      }
    }

    // Unread among the rows actually returned — always trustworthy, unlike the
    // server snapshot which can be stale relative to the cached rows.
    const unread_in_result = emails.filter((e) => e.unread).length;

    // cache_age_seconds: how old the freshest sync for this scope is, derived
    // from `last_sync` (== unread_as_of). Lets a caller tell "served from cache,
    // N seconds stale" apart from "freshly fetched". null when no sync snapshot
    // is available (so callers can distinguish "unknown" from "0s old").
    const cache_age_seconds = _ageSecondsFrom(unread_as_of);

    // Optional: unread across ALL synced folders for the scope (cheap in cache).
    let account_unread_total = null;
    if (includeAccountUnread) {
      if (accountId) {
        const r = _execScalar(h.db, "SELECT SUM(COALESCE(unread_count, 0)) FROM folders WHERE account_id = ?", [String(accountId)]);
        account_unread_total = Number(r || 0);
      } else {
        const r = _execScalar(h.db, "SELECT SUM(COALESCE(unread_count, 0)) FROM folders");
        account_unread_total = Number(r || 0);
      }
    }

    return {
      success: true,
      emails,
      total_in_folder,
      unread_count,
      folder_unread: unread_count,
      unread_in_result,
      account_unread_total,
      unread_as_of,
      cache_age_seconds,
      cached_emails,
      cached_unread,
      offset: Number(offset),
      limit: Number(limit),
      from_cache: true,
    };
  } catch (e) {
    if (process.env.MAILBOX_DEBUG) {
      process.stderr.write(`sync_db cache read failed: ${e && e.message ? e.message : e}\n`);
    }
    return null;
  } finally {
    try { h.close(); } catch { /* ignore */ }
  }
}

// Standalone helpers — kept for backward compat. Each wraps a write session
// so concurrent callers serialise on the file lock instead of clobbering.
async function upsertAccount({ dbPath, id, email, provider }) {
  try {
    await withWriteSession(dbPath, (s) => s.upsertAccount({ id, email, provider }));
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "db error" };
  }
}

async function upsertFolder({ dbPath, accountId, name, displayName, messageCount, unreadCount, lastSyncIso }) {
  try {
    let folderId = 0;
    await withWriteSession(dbPath, (s) => {
      folderId = s.upsertFolder({ accountId, name, displayName, messageCount, unreadCount, lastSyncIso });
    });
    return { success: true, folderId };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "db error" };
  }
}

async function upsertEmails({ dbPath, accountId, folderId, emails }) {
  try {
    await withWriteSession(dbPath, (s) => s.upsertEmails({ accountId, folderId, emails }));
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "db error" };
  }
}

async function invalidateFolderUnreadCount({ dbPath, accountId, folder }) {
  try {
    await withWriteSession(dbPath, (s) => {
      s.db.run(
        "UPDATE folders SET unread_count = NULL WHERE account_id = ? AND name = ?",
        [String(accountId), String(folder)]
      );
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "db error" };
  }
}

async function removeEmailsFromCache({ dbPath, accountId, uids }) {
  const ids = [...new Set((uids || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!ids.length) return { success: true, removed: 0 };
  try {
    await withWriteSession(dbPath, (s) => {
      s.db.run(
        `DELETE FROM emails WHERE account_id = ? AND uid IN (${_placeholders(ids)})`,
        [String(accountId), ...ids]
      );
    });
    return { success: true, removed: ids.length };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "db error" };
  }
}

async function updateEmailFlags({ dbPath, accountId, uids, unread }) {
  const ids = [...new Set((uids || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!ids.length) return { success: true, updated: 0 };
  try {
    await withWriteSession(dbPath, (s) => {
      s.db.run(
        `UPDATE emails SET is_read = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND uid IN (${_placeholders(ids)})`,
        [unread ? 0 : 1, String(accountId), ...ids]
      );
    });
    return { success: true, updated: ids.length };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "db error" };
  }
}

async function getEmailUIDsFromCache({ dbPath, accountId, folder }) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const h = await openSyncDb(dbPath);
  try {
    const rows = _execRows(
      h.db,
      `
        SELECT e.uid
        FROM emails e
        LEFT JOIN folders f ON e.folder_id = f.id
        WHERE e.account_id = ?
          AND (f.name = ? COLLATE NOCASE OR (e.folder_id IS NULL AND ? = 'INBOX'))
      `,
      [String(accountId), String(folder || "INBOX"), String(folder || "INBOX")]
    );
    return rows.map((r) => String(r.uid));
  } finally {
    try { h.close(); } catch { /* ignore */ }
  }
}

// Reverse lookup: which folder does this (account, uid) live in, per the cache.
// Returns the folder name or "" when unknown. Used to make `show` folder-aware
// without the caller having to remember each email's folder.
async function lookupFolderForUid({ dbPath, accountId, uid }) {
  if (!dbPath || !fs.existsSync(dbPath)) return "";
  const u = String(uid || "").trim();
  if (!u) return "";
  const h = await openSyncDb(dbPath);
  try {
    const row = _execRows(
      h.db,
      // IMAP UIDs are per-folder, so the same uid can exist in several folders.
      // Prefer INBOX on a collision, then the most recently synced row, so a
      // bare-uid `show` opens the most likely-intended message deterministically.
      `
        SELECT CASE WHEN e.folder_id IS NULL THEN 'INBOX' ELSE f.name END as folder
        FROM emails e
        LEFT JOIN folders f ON e.folder_id = f.id
        WHERE e.account_id = ? AND e.uid = ?
        ORDER BY CASE WHEN (e.folder_id IS NULL OR f.name = 'INBOX') THEN 0 ELSE 1 END, e.updated_at DESC
        LIMIT 1
      `,
      [String(accountId || ""), u]
    )[0];
    return row && row.folder ? String(row.folder) : "";
  } catch {
    return "";
  } finally {
    try { h.close(); } catch { /* ignore */ }
  }
}

module.exports = {
  listEmailsFromCache,
  lookupFolderForUid,
  upsertAccount,
  upsertFolder,
  upsertEmails,
  invalidateFolderUnreadCount,
  removeEmailsFromCache,
  updateEmailFlags,
  getEmailUIDsFromCache,
  withWriteSession,
};
