import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const internals = require("../src/services/email/internals.js");
const { resetMockState } = require("../src/testing/mock_store.js");

function setTestEnv(name, accounts) {
  const root = path.join(import.meta.dirname, ".tmp", name);
  fs.rmSync(root, { recursive: true, force: true });
  process.env.MAILBOX_INTERNAL_TEST_MODE = "1";
  process.env.MAILBOX_CONFIG_DIR = path.join(root, "config");
  process.env.MAILBOX_DATA_DIR = path.join(root, "data");
  fs.mkdirSync(process.env.MAILBOX_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.MAILBOX_CONFIG_DIR, "auth.json"),
    JSON.stringify({ version: 1, accounts, default_account: Object.keys(accounts)[0] }) + "\n",
    "utf8"
  );
  resetMockState();
}

function msg(uid, { messageId, emailId, subject = "Lemon Squeezy receipt", date = "2026-09-01 10:00:00", from = "hello@lemonsqueezy.com" } = {}) {
  return {
    uid,
    messageId: messageId || `<m${uid}@example.com>`,
    ...(emailId != null ? { emailId } : {}),
    subject,
    from,
    to: "me@gmail.com",
    cc: "",
    date,
    flags: new Set(["\\Seen"]),
    body: "lemon squeezy",
    html: "",
    attachments: [],
  };
}

// A Gmail account as the server really exposes it: labels are folders, the
// same message (same X-GM-MSGID / Message-ID) shows up under each label.
function gmailMailboxes() {
  return {
    INBOX: { specialUse: "\\Inbox", messages: [msg(5709, { messageId: "<a@x>", emailId: "1001" }), msg(5710, { messageId: "<b@x>", emailId: "1002", date: "2026-09-02 10:00:00" })] },
    "[Gmail]": { flags: ["\\Noselect", "\\HasChildren"], specialUse: "", messages: [] },
    "[Gmail]/重要": { flags: ["\\HasNoChildren", "\\Important"], specialUse: "", messages: [msg(1312, { messageId: "<a@x>", emailId: "1001" }), msg(1313, { messageId: "<c@x>", emailId: "1003", date: "2026-08-01 10:00:00" })] },
    "[Gmail]/已加星标": { flags: ["\\Flagged"], specialUse: "\\Flagged", messages: [msg(77, { messageId: "<c@x>", emailId: "1003", date: "2026-08-01 10:00:00" })] },
    "[Gmail]/已发邮件": { flags: ["\\Sent"], specialUse: "\\Sent", messages: [msg(30, { messageId: "<d@x>", emailId: "1004", from: "me@gmail.com", date: "2026-08-02 10:00:00" })] },
    "[Gmail]/所有邮件": { flags: ["\\All"], specialUse: "\\All", messages: [msg(9001, { messageId: "<a@x>", emailId: "1001" })] },
    Work: { specialUse: "", messages: [msg(12, { messageId: "<b@x>", emailId: "1002", date: "2026-09-02 10:00:00" })] },
  };
}

describe("search --folder all: dedupe the same message across folders", () => {
  beforeEach(() => {
    setTestEnv("search_dedupe_gmail", { gm: { email: "me@gmail.com", password: "x", provider: "gmail" } });
    globalThis.__MAILBOX_MOCK_STATE.accounts.gm = { id: "gm", email: "me@gmail.com", mailboxes: gmailMailboxes() };
  });

  it("returns each Gmail message once, at its most canonical folder", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50 });
    expect(r.success).toBe(true);
    const gids = r.emails.map((e) => e.gid).sort();
    expect(gids).toEqual([
      "gm:INBOX:5709", // INBOX beats [Gmail]/重要
      "gm:INBOX:5710", // INBOX beats the Work label
      "gm:[Gmail]/已发邮件:30",
      "gm:[Gmail]/重要:1313", // Important and Starred tie; first listed wins
    ].sort());
    expect(r.total_found).toBe(4);
    expect(r.displayed).toBe(4);
    expect(r.duplicates_removed).toBe(3);
    // No folder_errors: the \Noselect "[Gmail]" container is skipped (LIST flags are a Set).
    expect(r.folder_errors).toBeUndefined();
  });

  it("dedupes before paging so limit/offset count messages, not folder hits", async () => {
    const p1 = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 2, offset: 0 });
    const p2 = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 2, offset: 2 });
    const all = [...p1.emails, ...p2.emails].map((e) => e.message_id);
    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(4);
  });

  it("tags rows with the folder's special-use role", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50 });
    const sent = r.emails.find((e) => e.folder === "[Gmail]/已发邮件");
    expect(sent.special_use).toBe("\\Sent");
    expect(r.emails.find((e) => e.folder === "[Gmail]/重要").special_use).toBe("\\Important");
  });

  it("Gmail label aliases are collapsed even with dedupe=false (bulk mutations)", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50, dedupe: false });
    expect(r.emails).toHaveLength(4);
  });

  it("a single-folder search is untouched", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "[Gmail]/重要", limit: 50 });
    expect(r.emails.map((e) => e.uid).sort()).toEqual(["1312", "1313"]);
    expect(r.duplicates_removed).toBeUndefined();
  });
});

describe("search --folder all on a non-label server", () => {
  beforeEach(() => {
    setTestEnv("search_dedupe_imap", { mock_acc: { email: "mock@example.com", password: "mock", provider: "mock" } });
    const acc = globalThis.__MAILBOX_MOCK_STATE.accounts.mock_acc;
    acc.mailboxes.INBOX.messages.push(msg(201, { messageId: "<copy@x>" }));
    acc.mailboxes.Archive = { specialUse: "\\Archive", messages: [msg(5, { messageId: "<copy@x>" })] };
  });

  it("collapses copies by Message-ID by default", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "mock_acc", folder: "all" });
    expect(r.emails.map((e) => e.gid)).toEqual(["mock_acc:INBOX:201"]);
    expect(r.total_found).toBe(1);
  });

  it("keeps genuine copies with dedupe=false so a bulk mutation hits each one", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "mock_acc", folder: "all", dedupe: false });
    expect(r.emails.map((e) => e.gid).sort()).toEqual(["mock_acc:Archive:5", "mock_acc:INBOX:201"]);
  });
});

describe("_dedupeAcrossFolders", () => {
  const key = (e) => internals._messageIdentityKey(e, e.eid);
  const rank = (f) => internals._folderCanonicalRank(f, { "[Gmail]/All": "\\All", Sent: "\\Sent" }[f] || "");

  it("keeps same-folder duplicates (two physical messages), drops other-folder aliases", () => {
    const rows = [
      { folder: "Sent", message_id: "<x>" },
      { folder: "INBOX", message_id: "<x>" },
      { folder: "INBOX", message_id: "<X>" },
      { folder: "[Gmail]/All", message_id: "<x>" },
    ];
    const d = internals._dedupeAcrossFolders(rows, key, rank);
    expect(d.emails.map((e) => e.folder)).toEqual(["INBOX", "INBOX"]);
    expect(d.removed).toBe(2);
  });

  it("prefers the server email id, then Message-ID; no strong id -> no key", () => {
    expect(key({ eid: "42", message_id: "<x>" })).toBe("eid:42");
    expect(key({ message_id: " <X@Y> " })).toBe("mid:<x@y>");
    expect(key({ from: "A@b", date: "2026-01-01 00:00:00", subject: "s" })).toBeNull();
  });

  it("never merges rows that only share from+date+subject", () => {
    const rows = [
      { folder: "INBOX", from: "a@b", date: "2026-01-01 00:00:00", subject: "s" },
      { folder: "Work", from: "a@b", date: "2026-01-01 00:00:00", subject: "s" },
    ];
    const d = internals._dedupeAcrossFolders(rows, key, rank);
    expect(d.emails).toHaveLength(2);
    expect(d.removed).toBe(0);
  });

  it("ranks INBOX, then user folders, then Sent, then label views and All Mail", () => {
    const r = internals._folderCanonicalRank;
    expect(r("INBOX", "")).toBeLessThan(r("Work", ""));
    expect(r("Work", "")).toBeLessThan(r("[Gmail]/Sent Mail", "\\Sent"));
    expect(r("[Gmail]/Sent Mail", "\\Sent")).toBeLessThan(r("[Gmail]/Important", "\\Important"));
    expect(r("[Gmail]/Starred", "\\Flagged")).toBeLessThan(r("[Gmail]/All Mail", "\\All"));
  });
});

describe("search --folder all: dedupe vs the per-folder fetch cap", () => {
  beforeEach(() => {
    setTestEnv("search_dedupe_cap", { gm: { email: "me@gmail.com", password: "x", provider: "gmail" } });
  });

  it("re-fetches with a larger cap when aliases leave the page short", async () => {
    // Work: 300 rows, each Message-ID twice (150 messages). INBOX holds the 100
    // newest of them, so the first 200-row Work fetch is all INBOX aliases.
    const work = [];
    for (let i = 1; i <= 300; i += 1) work.push(msg(i, { messageId: `<w${Math.ceil(i / 2)}@x>` }));
    const inbox = [];
    for (let k = 51; k <= 150; k += 1) inbox.push(msg(1000 + k, { messageId: `<w${k}@x>` }));
    globalThis.__MAILBOX_MOCK_STATE.accounts.gm = {
      id: "gm", email: "me@gmail.com",
      mailboxes: { INBOX: { specialUse: "\\Inbox", messages: inbox }, Work: { specialUse: "", messages: work } },
    };
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 200, offset: 0 });
    expect(r.emails).toHaveLength(200);
    expect(r.total_found).toBe(200);
    expect(r.duplicates_removed).toBe(200);
    expect(r.total_found_is_upper_bound).toBeUndefined();
  });

  it("flags total_found as an upper bound when a capped folder may hide aliases", async () => {
    const work = [];
    for (let i = 1; i <= 250; i += 1) work.push(msg(i, { messageId: `<w${i}@x>` }));
    const inbox = [];
    for (let i = 1; i <= 50; i += 1) inbox.push(msg(1000 + i, { messageId: `<w${i}@x>` }));
    globalThis.__MAILBOX_MOCK_STATE.accounts.gm = {
      id: "gm", email: "me@gmail.com",
      mailboxes: { INBOX: { specialUse: "\\Inbox", messages: inbox }, Work: { specialUse: "", messages: work } },
    };
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 10 });
    expect(r.emails).toHaveLength(10);
    expect(r.total_found).toBe(300); // 250 real messages; the 50 uncapped aliases were never seen
    expect(r.total_found_is_upper_bound).toBe(true);
  });
});
