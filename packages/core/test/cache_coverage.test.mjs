import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const syncDb = require("../src/storage/sync_db.js");
const { resetMockState } = require("../src/testing/mock_store.js");

// The daemon caches only the newest N messages per folder. These tests guard
// the regression where a fresh-but-partial cache answered `list --since 3mo`
// with the 343 cached rows (from_cache:true) while the mailbox held 870 in that
// window: thin-but-fresh was trusted, though the window reached past the cache.

function setTestEnv(root) {
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
}

// Seed mock_acc/INBOX with `rows`, claiming the server folder holds
// `messageCount` messages (> rows.length means the cache is partial).
async function seedCache({ rows, messageCount, unreadCount, lastSyncIso = new Date().toISOString() }) {
  const dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
  await syncDb.upsertAccount({ dbPath, id: "mock_acc", email: "mock@example.com", provider: "mock" });
  const { folderId } = await syncDb.upsertFolder({
    dbPath,
    accountId: "mock_acc",
    name: "INBOX",
    displayName: "INBOX",
    messageCount: messageCount == null ? rows.length : messageCount,
    unreadCount: unreadCount == null ? rows.filter((r) => r.unread).length : unreadCount,
    lastSyncIso,
  });
  if (rows.length) await syncDb.upsertEmails({ dbPath, accountId: "mock_acc", folderId, emails: rows });
  return dbPath;
}

// 8 cached rows, 2026-08-14 .. 2026-08-21 (oldest first by index).
function cachedRows({ unread = false } = {}) {
  return Array.from({ length: 8 }, (_v, i) => ({
    uid: String(5000 + i),
    subject: `CACHED ${i}`,
    from: "a@b.com",
    date: `2026-08-${String(14 + i).padStart(2, "0")} 10:00:00`,
    unread,
  }));
}

const fromCacheOnly = (r) => r.emails.some((e) => String(e.subject).startsWith("CACHED"));

describe("cache coverage: partial cache vs requested date window", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "cache_coverage");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
    delete process.env.MAILBOX_CACHE_FRESH_SECONDS;
    delete process.env.MAILBOX_CACHE_STALE_SECONDS;
  });
  afterEach(() => {
    delete process.env.MAILBOX_CACHE_FRESH_SECONDS;
    delete process.env.MAILBOX_CACHE_STALE_SECONDS;
  });

  it("listEmailsFromCache reports cache_complete / cache_covers_from", async () => {
    const dbPath = await seedCache({ rows: cachedRows(), messageCount: 870 });
    const r = await syncDb.listEmailsFromCache({ dbPath, accountId: "mock_acc", folder: "INBOX", limit: 5, offset: 0 });
    expect(r.cache_complete).toBe(false);
    expect(r.cache_covers_from).toBe("2026-08-14 10:00:00");

    // Cross-account scope sees the same folder.
    const all = await syncDb.listEmailsFromCache({ dbPath, accountId: "", folder: "INBOX", limit: 5, offset: 0 });
    expect(all.cache_complete).toBe(false);
    expect(all.cache_covers_from).toBe("2026-08-14 10:00:00");
  });

  it("a fully cached folder reports cache_complete:true, cache_covers_from:null", async () => {
    const dbPath = await seedCache({ rows: cachedRows() });
    const r = await syncDb.listEmailsFromCache({ dbPath, accountId: "mock_acc", folder: "INBOX", limit: 5, offset: 0 });
    expect(r.cache_complete).toBe(true);
    expect(r.cache_covers_from).toBeNull();
  });

  it("fresh partial cache + date_from earlier than coverage + thin page -> live IMAP", async () => {
    await seedCache({ rows: cachedRows(), messageCount: 870 });
    const r = await email.listEmails({
      account_id: "mock_acc", folder: "INBOX", limit: 500, date_from: "2026-07-03", use_cache: true,
    });
    expect(r.from_cache).toBe(false);
    expect(fromCacheOnly(r)).toBe(false);
  });

  it("fresh partial cache + date_from inside coverage -> thin page is trusted (fast path)", async () => {
    await seedCache({ rows: cachedRows(), messageCount: 870 });
    const r = await email.listEmails({
      account_id: "mock_acc", folder: "INBOX", limit: 500, date_from: "2026-08-18", use_cache: true,
    });
    expect(r.from_cache).toBe(true);
    expect(r.emails.length).toBe(4); // 08-18 .. 08-21
    expect(r.cache_complete).toBe(false);
    expect(r.cache_covers_from).toBe("2026-08-14 10:00:00");
    expect(r).not.toHaveProperty("cache_unread_complete"); // internal only
  });

  it("partial cache + full page is still served from cache even if date_from predates coverage", async () => {
    await seedCache({ rows: cachedRows(), messageCount: 870 });
    const r = await email.listEmails({
      account_id: "mock_acc", folder: "INBOX", limit: 5, date_from: "2026-07-03", use_cache: true,
    });
    // Newest-first page lies entirely inside the covered range -> correct.
    expect(r.from_cache).toBe(true);
    expect(r.emails.length).toBe(5);
  });

  it("partial cache + no date filter + page past the cached rows (offset) -> live", async () => {
    await seedCache({ rows: cachedRows(), messageCount: 870 });
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 5, offset: 6, use_cache: true });
    expect(r.from_cache).toBe(false);
  });

  it("complete cache + thin page stays on the cache (the folder genuinely has that few)", async () => {
    await seedCache({ rows: cachedRows() });
    const r = await email.listEmails({
      account_id: "mock_acc", folder: "INBOX", limit: 500, date_from: "2020-01-01", use_cache: true,
    });
    expect(r.from_cache).toBe(true);
    expect(r.emails.length).toBe(8);
    expect(r.cache_complete).toBe(true);
    expect(r.cache_covers_from).toBeNull();
  });

  it("unread-only on a partial cache is trusted when every unread message is cached", async () => {
    const rows = cachedRows();
    rows[7].unread = true;
    await seedCache({ rows, messageCount: 870, unreadCount: 1 });
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 50, unread_only: true, use_cache: true });
    expect(r.from_cache).toBe(true);
    expect(r.emails.length).toBe(1);
  });

  it("unread-only on a partial cache goes live when unread mail lies outside it", async () => {
    const rows = cachedRows();
    rows[7].unread = true;
    await seedCache({ rows, messageCount: 870, unreadCount: 40 });
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 50, unread_only: true, use_cache: true });
    expect(r.from_cache).toBe(false);
  });

  it("MAILBOX_CACHE_FRESH_SECONDS=0 (never auto-fallback) also disables the coverage fallback", async () => {
    process.env.MAILBOX_CACHE_FRESH_SECONDS = "0";
    await seedCache({ rows: cachedRows(), messageCount: 870 });
    const r = await email.listEmails({
      account_id: "mock_acc", folder: "INBOX", limit: 500, date_from: "2026-07-03", use_cache: true,
    });
    expect(r.from_cache).toBe(true);
    expect(r.cache_complete).toBe(false); // caller can still tell it is partial
    expect(r.cache_covers_from).toBe("2026-08-14 10:00:00");
  });
});
