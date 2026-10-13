import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";
import Ajv from "ajv";
import { defaultAuth, readSchema, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const { email } = require("@mail-use/core");
const { cleanup, inbox } = require("@mail-use/workflows");
const cliBin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");

async function cli(args) {
  const root = path.join(import.meta.dirname, ".tmp", "cleanup_agent_review");
  const env = testEnv(root);
  writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());
  const r = await execa("node", [cliBin, ...args, "--json"], { reject: false, env });
  return { code: r.exitCode, payload: JSON.parse(r.stdout) };
}

afterEach(() => vi.restoreAllMocks());

describe("AI-driven mail review", () => {
  it("returns content and gids without choosing actions from misleading subjects", async () => {
    const emails = [
      { id: "1", gid: "a:INBOX:1", subject: "marketing spam unsubscribe", unread: true, preview: "Please review this failed payment." },
      { id: "2", gid: "b:Archive:1", subject: "Your receipt", unread: false, preview: "A promotion, not a transaction." },
    ];
    const read = vi.spyOn(email, "listEmails").mockResolvedValue({ success: true, emails, total_in_folder: 2 });
    const remove = vi.spyOn(email, "deleteEmails");
    const p = await cleanup.plan();
    expect(p).toMatchObject({ success: true, plan_only: true, decision_required: true, decision_by: "agent", emails, preview_count: 2 });
    expect(p.candidates_by_category).toEqual({});
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ preview_chars: 400, use_cache: false }));
    const organized = await inbox.run();
    expect(organized.emails).toEqual(emails);
    expect(Object.values(organized.actions).flat()).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("legacy apply fails before reading or deleting mail", async () => {
    const read = vi.spyOn(email, "listEmails");
    const remove = vi.spyOn(email, "deleteEmails");
    expect(await cleanup.apply({ categories: ["marketing"], permanent: true })).toMatchObject({ success: false, error_code: "explicit_selection_required" });
    expect(read).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not turn unknown folder counts into zero or pretend a preview exists", async () => {
    vi.spyOn(email, "listEmails").mockResolvedValue({ success: true, emails: [{ gid: "a:INBOX:1" }], total_in_folder: null });
    const p = await cleanup.plan({ limit: 1 });
    expect(p.truncated).toBe(true);
    expect(p.preview_count).toBe(0);
  });

  it("reports pagination against unread scope and propagates fetch errors", async () => {
    const read = vi.spyOn(email, "listEmails").mockResolvedValue({ success: true, emails: [{ gid: "a:INBOX:2" }], total_in_folder: 20, unread_count: 2 });
    const p = await cleanup.plan({ limit: 1, offset: 1, unread_only: true });
    expect(p.truncated).toBe(false);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ offset: 1, unread_only: true }));
    const failure = { success: false, error: "Fixture failure", error_code: "network_error" };
    read.mockResolvedValue(failure);
    expect(await cleanup.plan()).toEqual(failure);
  });

  it("normalizes paging metadata and avoids a non-advancing zero-limit page hint", async () => {
    const read = vi.spyOn(email, "listEmails").mockResolvedValue({ success: true, emails: [{ gid: "a:INBOX:2" }], total_in_folder: 3, limit: 1, offset: 1 });
    expect(await cleanup.plan({ limit: "1", offset: "1" })).toMatchObject({ scan_limit: 1, offset: 1, truncated: true, scan_note: expect.stringContaining("use offset 2") });
    read.mockResolvedValue({ success: true, emails: [], total_in_folder: 3, limit: 0, offset: 0 });
    expect(await cleanup.plan({ limit: 0 })).toMatchObject({ scanned: 0, truncated: true, scan_note: expect.stringContaining("positive limit") });
  });

  it.each(["cleanup", "inbox"])("%s preserves review decisions and coverage in compact and lean output", async (command) => {
    for (const format of [["--format", "compact"], ["--lean"]]) {
      const { code, payload } = await cli([command, "--account-id", "mock_acc", "--limit", "1", "--offset", "1", ...format]);
      expect(code).toBe(0);
      expect(payload).toMatchObject({ plan_only: true, decision_by: "agent", decision_required: true, scanned: 1, scan_limit: 1, offset: 1, truncated: true, preview_count: 1 });
      expect(payload.emails[0].gid).toBeTruthy();
      expect(payload.scan_note).toContain("use offset 2");
    }
  });

  it("CLI returns review data and scan limits", async () => {
    const { code, payload } = await cli(["cleanup", "--account-id", "mock_acc", "--limit", "2"]);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ success: true, decision_required: true, scanned: 2, scan_limit: 2, total_in_folder: 3, truncated: true });
    const validate = new Ajv().compile(readSchema("cleanup.schema.json"));
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    expect(payload.emails).toHaveLength(2);
    expect(payload.emails.every((e) => e.gid)).toBe(true);
    expect(payload.candidate_count).toBe(0);
    expect(payload).not.toHaveProperty("confirmation_hint");
    const next = await cli(["cleanup", "--account-id", "mock_acc", "--limit", "2", "--offset", "2"]);
    expect(next.payload.scanned).toBe(1);
    expect(next.payload.truncated).toBe(false);
  });

  it.each([
    ["--confirm"],
    ["--categories", "marketing", "--confirm"],
    ["--categories", "marketing"],
    ["--permanent"],
    ["--trash-folder", "Trash"],
  ])("CLI rejects legacy mutation options %j even without configured accounts", async (...options) => {
    const root = path.join(import.meta.dirname, ".tmp", "cleanup_no_accounts");
    fs.rmSync(root, { recursive: true, force: true });
    const r = await execa("node", [cliBin, "cleanup", ...options, "--json"], { reject: false, env: testEnv(root) });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, error_code: "explicit_selection_required" });
  });

  it("dry-run overrides confirm and never returns an executable category plan", async () => {
    const { code, payload } = await cli(["cleanup", "--confirm", "--dry-run", "--account-id", "mock_acc"]);
    expect(code).toBe(0);
    expect(payload.plan_only).toBe(true);
    expect(payload.candidates_by_category).toEqual({});
  });

  it("review commands validate previews and offsets", async () => {
    for (const command of ["cleanup", "inbox"]) {
      for (const options of [["--with-preview", "bad"], ["--with-preview", "2001"], ["--offset", "-1"]]) {
        const r = await cli([command, ...options]);
        expect(r.code).toBe(2);
        expect(r.payload.success).toBe(false);
      }
    }
  });
});
