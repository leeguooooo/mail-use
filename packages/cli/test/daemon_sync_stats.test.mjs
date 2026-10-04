import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { _newSyncStats, _recordSyncResult } = require("../src/daemon.js");
const { _syncAccountLines } = require("../src/commands/daemon.js");

// `daemon status` once reported syncs_failed=159 next to last_sync_error=null:
// every successful pass wiped the error, so the cause was never visible.
describe("daemon background sync stats", () => {
  it("keeps the last error (and per-account error) across a later success", () => {
    const stats = _newSyncStats();

    const failed = {
      success: false,
      error: "gmail: Socket timeout",
      results: [
        { success: false, account_id: "gmail", error: "Socket timeout" },
        { success: true, account_id: "qq" },
      ],
    };
    expect(_recordSyncResult(stats, { result: failed })).toBe("gmail: Socket timeout");
    expect(stats.syncs_failed).toBe(1);
    expect(stats.last_sync_error).toBe("gmail: Socket timeout");
    expect(stats.last_sync_error_at).toEqual(expect.any(String));
    expect(stats.accounts.gmail).toMatchObject({ last_error: "Socket timeout", last_ok_at: null });
    expect(stats.accounts.qq.last_ok_at).toEqual(expect.any(String));
    expect(stats.accounts.qq.last_error).toBeNull();

    const ok = { success: true, results: [{ success: true, account_id: "gmail" }, { success: true, account_id: "qq" }] };
    expect(_recordSyncResult(stats, { result: ok })).toBeNull();
    expect(stats).toMatchObject({ syncs_attempted: 2, syncs_ok: 1, syncs_failed: 1 });
    expect(stats.last_sync_at).toEqual(expect.any(String));
    expect(stats.last_sync_error).toBe("gmail: Socket timeout");
    expect(stats.accounts.gmail.last_error).toBe("Socket timeout");
    expect(stats.accounts.gmail.last_ok_at).toEqual(expect.any(String));
  });

  it("records a thrown error and a single-account failure against that account", () => {
    const stats = _newSyncStats();
    expect(_recordSyncResult(stats, { error: new Error("read ECONNRESET"), accountId: "163" })).toBe("read ECONNRESET");
    expect(stats.accounts["163"].last_error).toBe("read ECONNRESET");

    expect(_recordSyncResult(stats, { result: { success: false, error: "Connection not available" }, accountId: "163" })).toBe("Connection not available");
    expect(stats.accounts["163"].last_error).toBe("Connection not available");
    expect(stats.syncs_failed).toBe(2);
  });

  it("a failure result without an error message still says something", () => {
    const stats = _newSyncStats();
    expect(_recordSyncResult(stats, { result: { success: false } })).toBe("sync failed");
    expect(stats.last_sync_error).toBe("sync failed");
  });
});

describe("daemon status: per-account sync lines", () => {
  it("lists accounts that have only succeeded, not just failed ones", () => {
    const lines = _syncAccountLines({
      qq: { last_error: null, last_error_at: null, last_ok_at: "2026-10-04T00:00:00.000Z" },
      gmail: { last_error: "Socket timeout", last_error_at: "2026-10-04T00:01:00.000Z", last_ok_at: null },
      idle: { last_error: null, last_error_at: null, last_ok_at: null },
    });
    expect(lines).toEqual([
      "  qq: last_ok_at=2026-10-04T00:00:00.000Z\n",
      "  gmail: last_error=Socket timeout (at 2026-10-04T00:01:00.000Z)\n",
    ]);
  });
});
