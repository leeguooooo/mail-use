import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const syncDb = require("../src/storage/sync_db.js");
const accounts = require("../src/services/accounts.js");
const sync = require("../src/services/sync.js");
const { paths } = require("@mail-use/shared");
const { resetMockState } = require("../src/testing/mock_store.js");

const isPosix = process.platform !== "win32";
const mode = (p) => fs.statSync(p).mode & 0o777;

let root;
function setTestEnv(name) {
  root = path.join(import.meta.dirname, ".tmp", name);
  fs.rmSync(root, { recursive: true, force: true });
  process.env.MAILBOX_INTERNAL_TEST_MODE = "1";
  process.env.MAILBOX_CONFIG_DIR = path.join(root, "config");
  process.env.MAILBOX_DATA_DIR = path.join(root, "data");
  resetMockState();
}

// A pid that certainly belonged to a process and certainly doesn't now.
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(String(r.stdout));
}

describe("sync_db write lock", () => {
  beforeEach(() => setTestEnv("db_lock"));

  it("takes over a lock whose owner pid is dead, without waiting for it to age", async () => {
    const dbPath = path.join(root, "x.db");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(`${dbPath}.lock`, String(deadPid()));
    const started = Date.now();
    const lockPath = await syncDb._acquireLock(dbPath, { retries: 5, delayMs: 10 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(String(process.pid));
    syncDb._releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not steal a fresh lock held by a live process", async () => {
    const dbPath = path.join(root, "y.db");
    fs.mkdirSync(root, { recursive: true });
    // ppid: alive for the duration of the test, and not us.
    fs.writeFileSync(`${dbPath}.lock`, String(process.ppid));
    await expect(syncDb._acquireLock(dbPath, { retries: 3, delayMs: 5 })).rejects.toThrow(/could not acquire lock/);
    expect(fs.readFileSync(`${dbPath}.lock`, "utf8")).toBe(String(process.ppid));
  });

  it("treats an ownerless lock as stale only once it is old", () => {
    const now = Date.now();
    expect(syncDb._lockIsStale("", { mtimeMs: now - 1000 }, now)).toBe(false);
    expect(syncDb._lockIsStale("", { mtimeMs: now - 120_000 }, now)).toBe(true);
    expect(syncDb._lockIsStale(String(process.ppid), { mtimeMs: now - 120_000 }, now)).toBe(false);
    expect(syncDb._lockIsStale(String(process.ppid), { mtimeMs: now - 3_600_000 }, now)).toBe(true);
  });

  it("release leaves alone a lock that now belongs to someone else", () => {
    const lockPath = path.join(root, "z.db.lock");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lockPath, String(process.ppid));
    syncDb._releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe.runIf(isPosix)("file permissions", () => {
  beforeEach(() => setTestEnv("perms"));

  it("creates config and data dirs owner-only", () => {
    const pc = paths.getPathConfig();
    expect(mode(pc.configDir)).toBe(0o700);
    expect(mode(pc.dataDir)).toBe(0o700);
    expect(mode(pc.attachmentsDir)).toBe(0o700);
  });

  it("tightens an existing world-readable auth.json to 0600", () => {
    fs.mkdirSync(process.env.MAILBOX_CONFIG_DIR, { recursive: true });
    const p = path.join(process.env.MAILBOX_CONFIG_DIR, "auth.json");
    fs.writeFileSync(p, JSON.stringify({ version: 1, accounts: {} }));
    fs.chmodSync(p, 0o644);
    expect(accounts.loadAuth().success).toBe(true);
    expect(mode(p)).toBe(0o600);
  });

  it("writes the sync DB, its lock and the sync state file 0600", async () => {
    fs.mkdirSync(process.env.MAILBOX_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.MAILBOX_CONFIG_DIR, "auth.json"),
      JSON.stringify({ version: 1, accounts: { mock_acc: { email: "mock@example.com", password: "mock", provider: "mock" } } })
    );
    const pc = paths.getPathConfig();
    const r = await sync.force({});
    expect(r.success).toBe(true);
    expect(mode(pc.emailSyncDb)).toBe(0o600);
    expect(mode(pc.syncHealthHistoryJson)).toBe(0o600);

    const lockPath = await syncDb._acquireLock(pc.emailSyncDb);
    try {
      expect(mode(lockPath)).toBe(0o600);
    } finally {
      syncDb._releaseLock(lockPath);
    }
  });

  it("tightens an existing 0644 sync DB on the next write", async () => {
    const dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
    await syncDb.upsertAccount({ dbPath, id: "a", email: "a@example.com", provider: "mock" });
    fs.chmodSync(dbPath, 0o644);
    await syncDb.upsertAccount({ dbPath, id: "a", email: "a@example.com", provider: "mock" });
    expect(mode(dbPath)).toBe(0o600);
  });
});

describe("legacy account migration", () => {
  beforeEach(() => setTestEnv("legacy_cwd"));

  it("never imports ./data/accounts.json from the current directory", () => {
    const src = fs.readFileSync(require.resolve("../src/services/accounts.js"), "utf8");
    expect(src).not.toMatch(/process\.cwd\(\)/);
  });
});
