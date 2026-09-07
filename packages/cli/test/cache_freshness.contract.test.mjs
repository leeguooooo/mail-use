import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const syncDb = require("@mail-use/core/src/storage/sync_db.js");

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

// Seed a fresh-but-empty INBOX cache snapshot so a cached read returns 0 rows
// without triggering the stale self-heal (we want to observe the cached shape).
async function seedFreshEmptyCache(dataDir) {
  const dbPath = path.join(dataDir, "email_sync.db");
  fs.mkdirSync(dataDir, { recursive: true });
  await syncDb.upsertAccount({ dbPath, id: "mock_acc", email: "mock@example.com", provider: "mock" });
  await syncDb.upsertFolder({
    dbPath,
    accountId: "mock_acc",
    name: "INBOX",
    displayName: "INBOX",
    messageCount: 0,
    unreadCount: 0,
    lastSyncIso: new Date().toISOString(), // fresh → no auto-fallback
  });
  return dbPath;
}

describe("cache freshness survives --format compact (P1/P2)", () => {
  it("empty cached recent --format compact still carries from_cache + cache_age_seconds + hint", async () => {
    const root = tmpRoot("compact_freshness");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());
    await seedFreshEmptyCache(env.MAILBOX_DATA_DIR);

    const r = await execa(
      "node",
      [cliBin(), "email", "recent", "--account-id", "mock_acc", "--limit", "8", "--format", "compact", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    // The reproduction: an empty cached list. It must NOT be a silent failure —
    // the freshness signals have to survive the compact projection.
    expect(payload.emails).toEqual([]);
    expect(payload.from_cache).toBe(true);
    expect(typeof payload.cache_age_seconds).toBe("number");
    expect(typeof payload.hint).toBe("string");
    expect(payload.hint).toMatch(/--live/);
  });

  it("--live recent --format compact reports from_cache:false (live shape)", async () => {
    const root = tmpRoot("compact_freshness_live");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "recent", "--account-id", "mock_acc", "--limit", "8", "--live", "--format", "compact", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.from_cache).toBe(false);
    expect(payload.emails.length).toBeGreaterThan(0);
  });
});
