import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const syncDb = require("../src/storage/sync_db.js");
const { getMailbox, resetMockState } = require("../src/testing/mock_store.js");
const initSqlJs = require("sql.js/dist/sql-asm.js");

let dbPath;
function setTestEnv(name) {
  const root = path.join(import.meta.dirname, ".tmp", name);
  fs.rmSync(root, { recursive: true, force: true });
  process.env.MAILBOX_INTERNAL_TEST_MODE = "1";
  process.env.MAILBOX_CONFIG_DIR = path.join(root, "config");
  process.env.MAILBOX_DATA_DIR = path.join(root, "data");
  fs.mkdirSync(process.env.MAILBOX_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.MAILBOX_CONFIG_DIR, "auth.json"),
    JSON.stringify({
      version: 1,
      accounts: { mock_acc: { email: "mock@example.com", password: "mock", provider: "mock" } },
      default_account: "mock_acc",
    }) + "\n",
    "utf8"
  );
  dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
  resetMockState();
}

async function seed() {
  await syncDb.withWriteSession(dbPath, (s) => {
    s.upsertAccount({ id: "mock_acc", email: "mock@example.com", provider: "mock" });
    const now = new Date().toISOString();
    const inbox = s.upsertFolder({ accountId: "mock_acc", name: "INBOX", messageCount: 3, unreadCount: 1, lastSyncIso: now });
    s.upsertEmails({
      accountId: "mock_acc",
      folderId: inbox,
      emails: ["101", "102", "103"].map((uid) => ({ uid, subject: uid, from: "x@example.com", date: "2026-02-01 00:00:00", unread: false })),
    });
    const trash = s.upsertFolder({ accountId: "mock_acc", name: "Trash", messageCount: 1, unreadCount: 0, lastSyncIso: now });
    s.upsertEmails({ accountId: "mock_acc", folderId: trash, emails: [{ uid: "401", subject: "t", from: "x@example.com", date: "2026-01-01 00:00:00" }] });
  });
}

async function userVersion() {
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  try {
    return db.exec("PRAGMA user_version")[0].values[0][0];
  } finally {
    db.close();
  }
}

describe("C12: fewer DB opens and rewrites per operation", () => {
  beforeEach(() => setTestEnv("db_sessions"));
  afterEach(() => vi.restoreAllMocks());

  it("stamps the schema version so later opens skip schema setup", async () => {
    await seed();
    expect(await userVersion()).toBe(syncDb.SCHEMA_VERSION);
  });

  it("upgrades a legacy (user_version 0) file in place", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, provider TEXT NOT NULL, last_sync TIMESTAMP, total_emails INTEGER DEFAULT 0, sync_status TEXT DEFAULT 'never', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
    db.run("INSERT INTO accounts (id, email, provider) VALUES ('mock_acc', 'mock@example.com', 'mock')");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
    expect(await userVersion()).toBe(0);
    await seed();
    expect(await userVersion()).toBe(syncDb.SCHEMA_VERSION);
    const rows = await syncDb.listEmailsFromCache({ dbPath, accountId: "mock_acc", folder: "INBOX", limit: 10, offset: 0 });
    expect(rows.emails).toHaveLength(3);
  });

  it("mark makes all its cache changes in one write session", async () => {
    await seed();
    const spy = vi.spyOn(syncDb, "withWriteSession");
    const r = await email.markEmails({ email_ids: ["101", "102"], mark_as: "unread", account_id: "mock_acc" });
    expect(r.success).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const cached = await syncDb.listEmailsFromCache({ dbPath, accountId: "mock_acc", folder: "INBOX", limit: 10, offset: 0 });
    expect(cached.emails.filter((e) => e.unread).map((e) => e.uid).sort()).toEqual(["101", "102"]);
  });

  it("move makes all its cache changes in one write session", async () => {
    await seed();
    const spy = vi.spyOn(syncDb, "withWriteSession");
    const r = await email.moveEmails({ email_ids: ["101"], target_folder: "Trash", account_id: "mock_acc" });
    expect(r.moved_count).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("lookupFoldersForUids resolves many uids in one open, preferring INBOX", async () => {
    await seed();
    await syncDb.withWriteSession(dbPath, (s) => {
      const trash = s.upsertFolder({ accountId: "mock_acc", name: "Trash", messageCount: 2, unreadCount: 0, lastSyncIso: new Date().toISOString() });
      s.upsertEmails({ accountId: "mock_acc", folderId: trash, emails: [{ uid: "101", subject: "dup", from: "x", date: "2026-01-01 00:00:00" }] });
    });
    const m = await syncDb.lookupFoldersForUids({ dbPath, accountId: "mock_acc", uids: ["101", "401", "999"] });
    expect(m.get("101")).toBe("INBOX");
    expect(m.get("401")).toBe("Trash");
    expect(m.has("999")).toBe(false);
    expect(await syncDb.lookupFolderForUid({ dbPath, accountId: "mock_acc", uid: "401" })).toBe("Trash");
  });

  it("show across folders resolves all refs in a single cache lookup", async () => {
    await seed();
    getMailbox("mock_acc", "Trash").messages.push({
      uid: 401, messageId: "<m401@example.com>", subject: "in trash", from: "x@example.com", to: "mock@example.com",
      cc: "", date: "2026-01-01 00:00:00", flags: new Set(), body: "t", html: "", attachments: [],
    });
    const many = vi.spyOn(syncDb, "lookupFoldersForUids");
    const one = vi.spyOn(syncDb, "lookupFolderForUid");
    const r = await email.showEmailsResolved({ refs: [{ id: "101" }, { id: "401" }, { id: "102" }], account_id: "mock_acc" });
    expect(r.success).toBe(true);
    expect(r.emails.map((e) => `${e.folder}:${e.id}`).sort()).toEqual(["INBOX:101", "INBOX:102", "Trash:401"]);
    expect(many).toHaveBeenCalledTimes(1);
    expect(one).not.toHaveBeenCalled();
  });
});
