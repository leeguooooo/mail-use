import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const sync = require("../src/services/sync.js");
const { paths } = require("@mail-use/shared");
const { resetMockState, setMockFailure } = require("../src/testing/mock_store.js");
const initSqlJs = require("sql.js/dist/sql-asm.js");

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
  resetMockState();
}

describe("sync.health counters", () => {
  beforeEach(() => setTestEnv("sync_health"));

  it("reports the old constants when no sync has been recorded", () => {
    const h = sync.health();
    expect(h.total_syncs).toBe(0);
    expect(h.total_failures).toBe(0);
    expect(h.success_rate).toBe(100);
  });

  it("counts real sync attempts and failures from the state file", async () => {
    await sync.force({});
    await sync.force({});
    let h = sync.health();
    expect(h.total_syncs).toBe(2);
    expect(h.total_failures).toBe(0);
    expect(h.success_rate).toBe(100);

    const p = paths.getPathConfig().syncHealthHistoryJson;
    const state = JSON.parse(fs.readFileSync(p, "utf8"));
    state.sync_counts = { total: 4, failures: 1 };
    fs.writeFileSync(p, JSON.stringify(state));
    h = sync.health();
    expect(h.total_syncs).toBe(4);
    expect(h.total_failures).toBe(1);
    expect(h.success_rate).toBe(75);
  });

  it("a failed account sync records why, and a later success keeps the last error", async () => {
    setMockFailure("mailboxOpen", () => true);
    const r = await sync.force({});
    expect(r.success).toBe(false);
    expect(r.error).toBe("mock_acc: mock mailboxOpen failure");

    let acct = sync.status().accounts.find((a) => a.id === "mock_acc");
    expect(acct.sync_status).toBe("error");
    expect(acct.last_error).toBe("mock mailboxOpen failure");
    expect(acct.last_error_at).toEqual(expect.any(String));
    expect(sync.health().healthy_accounts).toBe(0);

    setMockFailure("mailboxOpen", null);
    expect((await sync.force({})).success).toBe(true);
    acct = sync.status().accounts.find((a) => a.id === "mock_acc");
    expect(acct.sync_status).toBe("ok");
    expect(acct.last_error).toBe("mock mailboxOpen failure");
  });

  it("a new cache file no longer gets the unused legacy tables", async () => {
    await sync.force({});
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(paths.getPathConfig().emailSyncDb));
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0].values.map((r) => r[0]);
    db.close();
    expect(tables).toEqual(expect.arrayContaining(["accounts", "folders", "emails"]));
    for (const legacy of ["email_content", "attachments", "sync_history"]) expect(tables).not.toContain(legacy);
  });
});
