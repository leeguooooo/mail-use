import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const syncDb = require("../src/storage/sync_db.js");
const { resetMockState } = require("../src/testing/mock_store.js");

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

// Same uid in two folders — legal in IMAP, UIDs are per-mailbox.
async function seedTwoFolders(uid = "102", { unread = false } = {}) {
  await syncDb.withWriteSession(dbPath, (s) => {
    s.upsertAccount({ id: "mock_acc", email: "mock@example.com", provider: "mock" });
    const now = new Date().toISOString();
    for (const name of ["INBOX", "Trash"]) {
      const folderId = s.upsertFolder({ accountId: "mock_acc", name, messageCount: 1, unreadCount: 0, lastSyncIso: now });
      s.upsertEmails({
        accountId: "mock_acc",
        folderId,
        emails: [{ uid, subject: `${name} copy`, from: "x@example.com", date: "2026-02-01 01:00:00", unread }],
      });
    }
  });
}

async function cached(folder) {
  const r = await syncDb.listEmailsFromCache({ dbPath, accountId: "mock_acc", folder, limit: 50, offset: 0 });
  return r.emails;
}

function rawRows(sql, params = []) {
  return syncDb.withWriteSession(dbPath, (s) => {
    const stmt = s.db.prepare(sql);
    const out = [];
    try {
      stmt.bind(params);
      while (stmt.step()) out.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return out;
  });
}

describe("cache mutations are scoped to the folder (UIDs are per-folder)", () => {
  beforeEach(() => setTestEnv("cache_scope"));

  it("removeEmailsFromCache only removes the uid from the given folder", async () => {
    await seedTwoFolders();
    await syncDb.removeEmailsFromCache({ dbPath, accountId: "mock_acc", folder: "INBOX", uids: ["102"] });
    expect(await cached("INBOX")).toEqual([]);
    expect((await cached("Trash")).map((e) => e.uid)).toEqual(["102"]);
  });

  it("updateEmailFlags only touches the uid in the given folder", async () => {
    await seedTwoFolders("102", { unread: false });
    await syncDb.updateEmailFlags({ dbPath, accountId: "mock_acc", folder: "Trash", uids: ["102"], unread: true });
    expect((await cached("Trash"))[0].unread).toBe(true);
    expect((await cached("INBOX"))[0].unread).toBe(false);
  });

  it("deleteEmails leaves the same uid in another folder cached", async () => {
    await seedTwoFolders("102");
    const r = await email.deleteEmails({ email_ids: ["102"], folder: "INBOX", permanent: true, account_id: "mock_acc" });
    expect(r.success).toBe(true);
    expect(await cached("INBOX")).toEqual([]);
    expect((await cached("Trash")).map((e) => e.uid)).toEqual(["102"]);
  });
});

describe("move/flag keep the cache in step", () => {
  beforeEach(() => setTestEnv("cache_mutations"));

  it("moveEmails drops moved uids from the source folder's cache", async () => {
    await seedTwoFolders("102");
    const r = await email.moveEmails({ email_ids: ["102"], source_folder: "INBOX", target_folder: "Trash", account_id: "mock_acc" });
    expect(r.success).toBe(true);
    expect(await cached("INBOX")).toEqual([]);
    // The uid in the target folder is a different message; left alone.
    expect((await cached("Trash")).map((e) => e.uid)).toEqual(["102"]);
  });

  it("flagEmail --type read updates is_read in the cache", async () => {
    await seedTwoFolders("102", { unread: true });
    const r = await email.flagEmail({ email_id: "102", set_flag: true, flag_type: "read", folder: "INBOX", account_id: "mock_acc" });
    expect(r.success).toBe(true);
    expect((await cached("INBOX"))[0].unread).toBe(false);
    expect((await cached("Trash"))[0].unread).toBe(true);
  });

  it("flagEmail --type flagged sets is_flagged, and a later sync upsert keeps it", async () => {
    await seedTwoFolders("102");
    await email.flagEmail({ email_id: "102", set_flag: true, flag_type: "flagged", folder: "INBOX", account_id: "mock_acc" });
    const flaggedBefore = await rawRows("SELECT e.is_flagged AS f FROM emails e JOIN folders fo ON fo.id = e.folder_id WHERE fo.name = 'INBOX'");
    expect(flaggedBefore[0].f).toBe(1);
    await seedTwoFolders("102"); // re-sync the same rows
    const flaggedAfter = await rawRows("SELECT e.is_flagged AS f FROM emails e JOIN folders fo ON fo.id = e.folder_id WHERE fo.name = 'INBOX'");
    expect(flaggedAfter[0].f).toBe(1);
  });
});

describe("upserts update in place instead of delete+insert", () => {
  beforeEach(() => setTestEnv("upsert_in_place"));

  it("re-syncing keeps email row ids and account created_at", async () => {
    await seedTwoFolders("102");
    const before = await rawRows("SELECT id FROM emails ORDER BY id");
    await rawRows("UPDATE accounts SET created_at = '2020-01-01 00:00:00'");
    await seedTwoFolders("102");
    const after = await rawRows("SELECT id FROM emails ORDER BY id");
    expect(after).toEqual(before);
    const acc = await rawRows("SELECT created_at FROM accounts WHERE id = 'mock_acc'");
    expect(acc[0].created_at).toBe("2020-01-01 00:00:00");
  });

  it("an account re-added under a new id still replaces the old row (email is unique)", async () => {
    await syncDb.upsertAccount({ dbPath, id: "old_id", email: "same@example.com", provider: "mock" });
    const r = await syncDb.upsertAccount({ dbPath, id: "new_id", email: "same@example.com", provider: "mock" });
    expect(r.success).toBe(true);
    const rows = await rawRows("SELECT id FROM accounts WHERE email = 'same@example.com'");
    expect(rows).toEqual([{ id: "new_id" }]);
  });
});

describe("listEmails with an unknown account", () => {
  beforeEach(() => setTestEnv("list_unknown_account"));

  it("fails instead of returning every account's cached mail", async () => {
    await seedTwoFolders("102");
    const r = await email.listEmails({ account_id: "nope@example.com", folder: "INBOX", limit: 10 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Account not found/);
    expect(r.emails).toBeUndefined();
  });
});
