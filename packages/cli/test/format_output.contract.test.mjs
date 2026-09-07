import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

const COMPACT_KEYS = [
  "id",
  "gid",
  "account_id",
  "folder",
  "date",
  "from",
  "subject",
  "unread",
  "has_attachments",
  "body_text_preview",
];

describe("WP-C: --format compact / jsonl", () => {
  it("email list --format compact projects each email to exactly the agent fields", async () => {
    const root = tmpRoot("fmt_compact");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "list", "--folder", "INBOX", "--account-id", "mock_acc", "--live", "--format", "compact"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(Array.isArray(payload.emails)).toBe(true);
    expect(payload.emails.length).toBeGreaterThan(0);
    for (const e of payload.emails) {
      expect(Object.keys(e).sort()).toEqual([...COMPACT_KEYS].sort());
      // gid is the 3-part account:folder:uid so the agent can chain to `email show`.
      expect(e.gid).toBe(`${e.account_id}:${e.folder}:${e.id}`);
    }
    // Heavy top-level metadata is dropped.
    expect(payload).not.toHaveProperty("accounts_info");
  });

  it("email list --format jsonl emits one JSON object per line", async () => {
    const root = tmpRoot("fmt_jsonl");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "list", "--folder", "INBOX", "--account-id", "mock_acc", "--live", "--format", "jsonl"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const obj = JSON.parse(line); // each line is valid JSON
      expect(obj).toHaveProperty("id");
      expect(obj).toHaveProperty("subject");
    }
  });

  it("compact + jsonl compose: projected fields, one per line", async () => {
    const root = tmpRoot("fmt_compact_jsonl");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "list", "--folder", "INBOX", "--account-id", "mock_acc", "--live", "--format", "compact,jsonl"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const obj = JSON.parse(lines[0]);
    expect(Object.keys(obj).sort()).toEqual([...COMPACT_KEYS].sort());
  });

  it("--format jsonl on an empty list emits zero lines (not a metadata object)", async () => {
    const root = tmpRoot("fmt_jsonl_empty");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    // --since far in the future → 0 emails.
    const r = await execa(
      "node",
      [cliBin(), "email", "list", "--folder", "INBOX", "--account-id", "mock_acc", "--live", "--since", "2099-01-01", "--format", "jsonl"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(""); // no lines, not a wrapped metadata object
  });

  it("single email show --format compact projects to agent fields + success", async () => {
    const root = tmpRoot("fmt_show_compact");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "show", "102", "--folder", "INBOX", "--account-id", "mock_acc", "--format", "compact"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    for (const k of COMPACT_KEYS) expect(payload).toHaveProperty(k);
    // The heavy body/html fields are gone in compact form.
    expect(payload).not.toHaveProperty("html_body");
  });
});

// Regression: cache_stale was added to the cached list/recent result but not to
// COMPACT_TOP_LEVEL_KEEP, so `--format compact` — the shape agents actually use —
// silently dropped it. Every freshness signal has to survive the projection or it
// is not a signal at all.
describe("cache freshness signals survive --format compact", () => {
  it("keeps from_cache / cache_age_seconds / cache_stale / hint", async () => {
    const contract = (await import("node:module")).createRequire(import.meta.url)(
      "@mail-use/shared/src/contract.js"
    );
    const projected = contract.compactResult({
      success: true,
      from_cache: true,
      cache_age_seconds: 42,
      cache_stale: true,
      unread_as_of: "2026-09-08T00:00:00.000Z",
      hint: "served from cache (age 42s); pass --live ...",
      accounts_info: [{ noise: true }],
      emails: [{ id: 1, account_id: "a", folder: "INBOX", subject: "s", from: "f", date: "d" }],
    });
    expect(projected.from_cache).toBe(true);
    expect(projected.cache_age_seconds).toBe(42);
    expect(projected.cache_stale).toBe(true);
    expect(projected.unread_as_of).toBeTruthy();
    expect(projected.hint).toMatch(/cache/);
    // ...while the noise is still dropped.
    expect(projected.accounts_info).toBeUndefined();
  });
});
