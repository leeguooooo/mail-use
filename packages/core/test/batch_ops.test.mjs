import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const { getMailbox, resetMockState, getMockCalls, clearMockCalls, setMockFailure } = require("../src/testing/mock_store.js");
const { _uidMatcher } = require("../src/testing/mock_imap_client.js");
const { _uidSetString } = require("../src/services/email/internals.js");

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

const ops = (name) => getMockCalls().filter((c) => c.op === name);

describe("C10: batch IMAP mutations issue one command per set", () => {
  beforeEach(() => setTestEnv("batch_ops"));

  it("_uidSetString compacts contiguous runs", () => {
    expect(_uidSetString([9, 1, 2, 3, 7, 10, 3])).toBe("1:3,7,9:10");
    expect(_uidSetString([])).toBe("");
  });

  it("mark issues a single UID STORE for many uids and reports each", async () => {
    clearMockCalls();
    const r = await email.markEmails({ email_ids: ["101", "102", "103"], mark_as: "unread", account_id: "mock_acc" });
    expect(r.success).toBe(true);
    expect(r.results.map((x) => [x.email_id, x.success])).toEqual([["101", true], ["102", true], ["103", true]]);
    expect(ops("messageFlagsRemove")).toHaveLength(1);
    expect(ops("messageFlagsRemove")[0].range).toBe("101:103");
    expect(ops("mailboxOpen")).toHaveLength(1);
    const inbox = getMailbox("mock_acc", "INBOX").messages;
    expect(inbox.every((m) => !m.flags.has("\\Seen"))).toBe(true);
  });

  it("a failing batch falls back to per-uid so the error lands on the right uid", async () => {
    setMockFailure("messageFlagsAdd", (range) => _uidMatcher(range)(102));
    const r = await email.markEmails({ email_ids: ["101", "102", "103"], mark_as: "read", account_id: "mock_acc" });
    expect(r.success).toBe(false);
    expect(r.marked_count).toBe(2);
    const byId = Object.fromEntries(r.results.map((x) => [x.email_id, x]));
    expect(byId["101"].success).toBe(true);
    expect(byId["102"].success).toBe(false);
    expect(byId["102"].error).toMatch(/mock messageFlagsAdd failure/);
    expect(byId["103"].success).toBe(true);
  });

  it("delete moves the whole set with one MOVE and one existence SEARCH", async () => {
    // 999 exists nowhere; 501 is already in the trash (a retried delete).
    getMailbox("mock_acc", "Trash").messages.push({
      uid: 501, messageId: "<m501@example.com>", subject: "gone", from: "a@example.com", to: "mock@example.com",
      cc: "", date: "2026-01-01 00:00:00", flags: new Set(), body: "", html: "", attachments: [],
    });
    clearMockCalls();
    const r = await email.deleteEmails({ email_ids: ["101", "102", "501", "999"], account_id: "mock_acc" });
    const byId = Object.fromEntries(r.results.map((x) => [x.email_id, x]));
    expect(byId["101"]).toMatchObject({ success: true, folder: "INBOX" });
    expect(byId["102"]).toMatchObject({ success: true, folder: "INBOX" });
    expect(byId["501"]).toMatchObject({ success: true, already_deleted: true, folder: "Trash" });
    expect(byId["999"]).toMatchObject({ success: false, error: "Email not found in source folder or trash" });
    expect(r.deleted_count).toBe(3);

    expect(ops("messageMove")).toHaveLength(1);
    expect(ops("messageMove")[0].range).toBe("101:102");
    expect(ops("fetchOne")).toHaveLength(0);
    // one existence search in INBOX, one in Trash for the missing uids
    expect(ops("search")).toHaveLength(2);
    expect(getMailbox("mock_acc", "INBOX").messages.map((m) => m.uid)).toEqual([103]);
  });

  it("permanent delete expunges the set in one command", async () => {
    clearMockCalls();
    const r = await email.deleteEmails({ email_ids: ["101", "103"], permanent: true, account_id: "mock_acc" });
    expect(r.success).toBe(true);
    expect(ops("messageDelete")).toHaveLength(1);
    expect(ops("messageDelete")[0].range).toBe("101,103");
    expect(getMailbox("mock_acc", "INBOX").messages.map((m) => m.uid)).toEqual([102]);
  });

  it("move uses one MOVE and reports uids missing from the source as failed", async () => {
    clearMockCalls();
    const r = await email.moveEmails({ email_ids: ["101", "102", "777"], target_folder: "Trash", account_id: "mock_acc" });
    expect(r.moved_count).toBe(2);
    expect(r.failed_ids).toEqual(["777"]);
    expect(r.success).toBe(false);
    expect(ops("messageMove")).toHaveLength(1);
  });

  it("a command the server rejects (imapflow resolves false) is not reported as done", async () => {
    setMockFailure("messageFlagsAdd", (range) => (_uidMatcher(range)(102) ? "false" : false));
    const r = await email.markEmails({ email_ids: ["101", "102", "103"], mark_as: "read", account_id: "mock_acc" });
    expect(r.success).toBe(false);
    expect(r.marked_count).toBe(2);
    const byId = Object.fromEntries(r.results.map((x) => [x.email_id, x]));
    expect(byId["102"].success).toBe(false);
    expect(byId["102"].error).toMatch(/rejected/);
  });

  it("a rejected move is reported as failed", async () => {
    setMockFailure("messageMove", () => "false");
    const r = await email.moveEmails({ email_ids: ["101", "102"], target_folder: "Trash", account_id: "mock_acc" });
    expect(r.moved_count).toBe(0);
    expect(r.failed_ids.sort()).toEqual(["101", "102"]);
  });

  it("a rejected flag is reported as failed", async () => {
    setMockFailure("messageFlagsAdd", () => "false");
    const r = await email.flagEmail({ email_id: "102", set_flag: true, flag_type: "flagged", folder: "INBOX", account_id: "mock_acc" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/rejected/);
  });

  it("a failing move batch is retried per uid", async () => {
    setMockFailure("messageMove", (range) => _uidMatcher(range)(102));
    const r = await email.moveEmails({ email_ids: ["101", "102", "103"], target_folder: "Trash", account_id: "mock_acc" });
    expect(r.moved_count).toBe(2);
    expect(r.failed_ids).toEqual(["102"]);
    expect(getMailbox("mock_acc", "INBOX").messages.map((m) => m.uid)).toEqual([102]);
  });
});
