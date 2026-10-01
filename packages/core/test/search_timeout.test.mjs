import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const { resetMockState } = require("../src/testing/mock_store.js");

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

describe("WP review-fix: search deadline", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "search_timeout");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
  });

  it("_deadlineExceeded is a correct pure predicate (0 = no limit)", () => {
    expect(email._deadlineExceeded(1000, 0, 999999)).toBe(false); // 0 => unbounded
    expect(email._deadlineExceeded(1000, 50, 1040)).toBe(false); // 40ms < 50ms
    expect(email._deadlineExceeded(1000, 50, 1050)).toBe(true); // 50ms >= 50ms
    expect(email._deadlineExceeded(1000, 50, 5000)).toBe(true);
  });

  it("_raceTimeout hard-bounds a never-settling op and passes through a fast one", async () => {
    // A stuck op (never resolves) → onTimeout wins within ~ms.
    const stuck = new Promise(() => {});
    expect(await email._raceTimeout(stuck, 15, () => "TIMED_OUT")).toBe("TIMED_OUT");
    // A fast op resolves before the (long) timer.
    expect(await email._raceTimeout(Promise.resolve("OK"), 1000, () => "TIMED_OUT")).toBe("OK");
    // 0 = no bound → returns the promise's value.
    expect(await email._raceTimeout(Promise.resolve("OK"), 0, () => "TIMED_OUT")).toBe("OK");
  });

  it("normal search with a generous timeout is unaffected (timed_out false)", async () => {
    const r = await email.searchEmails({ query: "hello", account_id: "mock_acc", folder: "all", limit: 10, timeout_ms: 60000 });
    expect(r.success).toBe(true);
    expect(r.timed_out).toBe(false);
    expect(r.emails.length).toBeGreaterThan(0);
  });
});

describe("search date parsing (same rules as list)", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "search_dates");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
  });

  it("accepts a relative date_from on its own (MCP passes it unexpanded)", async () => {
    const r = await email.searchEmails({ date_from: "7d", account_id: "mock_acc", folder: "INBOX" });
    expect(r.success).toBe(true);
    expect(r.warnings).toBeUndefined();
  });

  it("reports an unparseable date instead of silently dropping it", async () => {
    const r = await email.searchEmails({ query: "hello", date_from: "not-a-date", account_id: "mock_acc", folder: "INBOX" });
    expect(r.warnings).toEqual([expect.stringMatching(/not-a-date/)]);
  });
});
