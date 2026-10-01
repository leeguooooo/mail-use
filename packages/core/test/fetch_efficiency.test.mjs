import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const { getMailbox, resetMockState, getMockCalls, clearMockCalls } = require("../src/testing/mock_store.js");
const { _uidMatcher } = require("../src/testing/mock_imap_client.js");
const { MAX_MESSAGE_BYTES, PREVIEW_SOURCE_BYTES } = require("../src/services/email/message_source.js");

let root;
function setTestEnv(name) {
  root = path.join(import.meta.dirname, ".tmp", name);
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

const fetches = () => getMockCalls().filter((c) => c.op === "fetch" || c.op === "fetchOne");
// Fetches that downloaded the full source of `uid`.
const fullSourceFetchesOf = (uid) =>
  getMockCalls().filter((c) => (c.op === "fetch" || c.op === "fetchOne") && c.opts && c.opts.source === true && _uidMatcher(c.range)(uid));

describe("C11: fetch only what is needed, once", () => {
  beforeEach(() => setTestEnv("fetch_efficiency"));

  it("showEmails fetches many uids in two FETCHes, not one per uid", async () => {
    clearMockCalls();
    const r = await email.showEmails({ email_ids: ["101", "102", "103", "404"], account_id: "mock_acc" });
    expect(r.emails.map((e) => e.id)).toEqual(["101", "102", "103"]);
    expect(r.failed_ids).toEqual([{ id: "404", error: "not_found" }]);
    expect(fetches()).toHaveLength(2);
    expect(getMockCalls().filter((c) => c.op === "fetchOne")).toHaveLength(0);
    // the attachment in the fixture comes through the real parse path
    const m102 = r.emails.find((e) => e.id === "102");
    expect(m102.attachment_count).toBe(1);
    expect(m102.attachments[0]).toMatchObject({ filename: "a.txt", is_real_attachment: true });
  });

  it("rejects an oversized message from its size before downloading the source", async () => {
    getMailbox("mock_acc", "INBOX").messages.find((m) => m.uid === 102).size = MAX_MESSAGE_BYTES + 1;
    clearMockCalls();
    const r = await email.showEmails({ email_ids: ["101", "102"], account_id: "mock_acc" });
    expect(r.emails.map((e) => e.id)).toEqual(["101"]);
    expect(r.failed_ids[0].id).toBe("102");
    expect(r.failed_ids[0].error).toMatch(/MAILBOX_MAX_MESSAGE_BYTES/);
    expect(fullSourceFetchesOf(102)).toHaveLength(0);
    expect(fullSourceFetchesOf(101)).toHaveLength(1);
  });

  it("downloadAttachments fetches and parses the source once", async () => {
    clearMockCalls();
    const r = await email.downloadAttachments({ email_id: "102", account_id: "mock_acc", output_dir: path.join(root, "out") });
    expect(r.success).toBe(true);
    expect(r.attachments).toHaveLength(1);
    expect(fs.readFileSync(r.attachments[0].saved_path, "utf8")).toBe("attachment");
    expect(fullSourceFetchesOf(102)).toHaveLength(1);
  });

  it("downloadAttachments refuses an oversized message without fetching it", async () => {
    getMailbox("mock_acc", "INBOX").messages.find((m) => m.uid === 102).size = MAX_MESSAGE_BYTES + 1;
    clearMockCalls();
    const r = await email.downloadAttachments({ email_id: "102", account_id: "mock_acc", output_dir: path.join(root, "out") });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/MAILBOX_MAX_MESSAGE_BYTES/);
    expect(fullSourceFetchesOf(102)).toHaveLength(0);
  });

  it("forward dry-run reads the original once", async () => {
    clearMockCalls();
    const r = await email.forwardEmail({ email_id: "102", to: "x@example.com", account_id: "mock_acc", dry_run: true });
    expect(r.would_forward).toMatchObject({ subject: "Fwd: Unread Note", original_attachment_count: 1 });
    expect(fullSourceFetchesOf(102)).toHaveLength(1);
  });

  it("list previews use a bounded partial fetch, not the full source", async () => {
    clearMockCalls();
    const r = await email.listEmails({ account_id: "mock_acc", limit: 3, preview_chars: 5, use_cache: false });
    const hello = r.emails.find((e) => e.uid === "101");
    expect(hello.preview).toBe("hello");
    expect(hello.preview_truncated).toBe(true);
    const listFetch = getMockCalls().find((c) => c.op === "fetch");
    expect(listFetch.opts.source).toEqual({ start: 0, maxLength: PREVIEW_SOURCE_BYTES });
  });
});
