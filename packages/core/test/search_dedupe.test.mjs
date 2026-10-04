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

function msg(uid, { messageId, emailId, labels, subject = "Lemon Squeezy receipt", date = "2026-09-01 10:00:00", from = "hello@lemonsqueezy.com" } = {}) {
  return {
    uid,
    messageId: messageId || `<m${uid}@example.com>`,
    ...(emailId != null ? { emailId } : {}),
    ...(labels ? { labels } : {}),
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
// same message (same X-GM-MSGID / Message-ID) shows up under each label, and
// [Gmail]/所有邮件 (All Mail) holds every message except Spam/Trash once, with
// its X-GM-LABELS. Messages:
//   a: INBOX + Important        b: INBOX + Work
//   c: archived, Important + Starred
//   d: Sent                     e: archived, no label at all (only in All Mail)
//   f: archived, user label Work
//   s: Spam (not in All Mail)
const ALL_MAIL = "[Gmail]/所有邮件";
function gmailMailboxes() {
  const a = { messageId: "<a@x>", emailId: "1001" };
  const b = { messageId: "<b@x>", emailId: "1002", date: "2026-09-02 10:00:00" };
  const c = { messageId: "<c@x>", emailId: "1003", date: "2026-08-01 10:00:00" };
  const d = { messageId: "<d@x>", emailId: "1004", from: "me@gmail.com", date: "2026-08-02 10:00:00" };
  const e = { messageId: "<e@x>", emailId: "1005", date: "2026-07-01 10:00:00" };
  const f = { messageId: "<f@x>", emailId: "1006", date: "2026-06-01 10:00:00" };
  const s = { messageId: "<s@x>", emailId: "1007", date: "2026-05-01 10:00:00" };
  return {
    INBOX: { specialUse: "\\Inbox", messages: [msg(5709, a), msg(5710, b)] },
    "[Gmail]": { flags: ["\\Noselect", "\\HasChildren"], specialUse: "", messages: [] },
    "[Gmail]/重要": { flags: ["\\HasNoChildren", "\\Important"], specialUse: "", messages: [msg(1312, a), msg(1313, c)] },
    "[Gmail]/已加星标": { flags: ["\\Flagged"], specialUse: "\\Flagged", messages: [msg(77, c)] },
    "[Gmail]/已发邮件": { flags: ["\\Sent"], specialUse: "\\Sent", messages: [msg(30, d)] },
    "[Gmail]/垃圾邮件": { flags: ["\\Junk"], specialUse: "\\Junk", messages: [msg(4, s)] },
    "[Gmail]/已删除邮件": { flags: ["\\Trash"], specialUse: "\\Trash", messages: [] },
    [ALL_MAIL]: {
      flags: ["\\All"],
      specialUse: "\\All",
      messages: [
        msg(9001, { ...a, labels: ["\\Inbox", "\\Important"] }),
        msg(9002, { ...b, labels: ["\\Inbox", "Work"] }),
        msg(9003, { ...c, labels: ["\\Important", "\\Starred"] }),
        msg(9004, { ...d, labels: ["\\Sent"] }),
        msg(9005, { ...e, labels: [] }),
        msg(9006, { ...f, labels: ["Work"] }),
      ],
    },
    Work: { specialUse: "", messages: [msg(12, b), msg(13, f)] },
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
      "gm:INBOX:5709", // INBOX + Important + All Mail -> INBOX
      "gm:INBOX:5710", // INBOX + Work -> INBOX
      `gm:${ALL_MAIL}:9003`, // archived, only Important/Starred -> All Mail
      "gm:[Gmail]/已发邮件:30", // Sent keeps its Sent location
      `gm:${ALL_MAIL}:9005`, // archived, no label: only All Mail has it
      "gm:Work:13", // archived with a user label -> the label folder
      "gm:[Gmail]/垃圾邮件:4", // Spam is searched too
    ].sort());
    // All Mail, Spam and Trash are disjoint: nothing to collapse, exact total.
    expect(r.total_found).toBe(7);
    expect(r.displayed).toBe(7);
    expect(r.duplicates_removed).toBeUndefined();
    expect(r.total_found_is_upper_bound).toBeUndefined();
    // No folder_errors: the \Noselect "[Gmail]" container is skipped (LIST flags are a Set).
    expect(r.folder_errors).toBeUndefined();
  });

  it("does not open every label folder: All Mail, Spam, Trash, then only the relocation targets", async () => {
    const { getMockCalls } = require("../src/testing/mock_store.js");
    const before = getMockCalls().length;
    await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50 });
    const searched = new Set(getMockCalls().slice(before).filter((c) => c.op === "search").map((c) => c.mailbox));
    expect(searched.has("[Gmail]/重要")).toBe(false);
    expect(searched.has("[Gmail]/已加星标")).toBe(false);
    expect([...searched].sort()).toEqual([ALL_MAIL, "INBOX", "Work", "[Gmail]/已发邮件", "[Gmail]/垃圾邮件", "[Gmail]/已删除邮件"].sort());
  });

  it("finds archived mail that lives only in All Mail, exactly once, with a usable gid", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50 });
    const hits = r.emails.filter((e) => e.message_id === "<e@x>");
    expect(hits).toHaveLength(1);
    expect(hits[0].gid).toBe(`gm:${ALL_MAIL}:9005`);
    expect(hits[0].folder).toBe(ALL_MAIL);
    expect(hits[0].special_use).toBe("\\All");
    const shown = await email.showEmail({ email_id: hits[0].uid, folder: hits[0].folder, account_id: "gm" });
    expect(shown.success).toBe(true);
    expect(shown.message_id || shown.subject).toBeTruthy();
  });

  it("a message in INBOX + All Mail + Important is returned once, as INBOX", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50 });
    const hits = r.emails.filter((e) => e.message_id === "<a@x>");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ gid: "gm:INBOX:5709", uid: "5709", id: "5709", folder: "INBOX", special_use: "\\Inbox" });
  });

  it("keeps a row in All Mail when its label folder does not hold it (hidden label / race)", async () => {
    globalThis.__MAILBOX_MOCK_STATE.accounts.gm.mailboxes.Work.messages = [];
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50 });
    expect(r.emails.find((e) => e.message_id === "<f@x>").gid).toBe(`gm:${ALL_MAIL}:9006`);
    // b still has \Inbox, so it is unaffected.
    expect(r.emails.find((e) => e.message_id === "<b@x>").gid).toBe("gm:INBOX:5710");
  });

  it("falls back to the per-folder scan when All Mail is not exposed over IMAP", async () => {
    delete globalThis.__MAILBOX_MOCK_STATE.accounts.gm.mailboxes[ALL_MAIL];
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50 });
    const gids = r.emails.map((e) => e.gid).sort();
    expect(gids).toEqual([
      "gm:INBOX:5709",
      "gm:INBOX:5710",
      "gm:[Gmail]/已发邮件:30",
      "gm:[Gmail]/重要:1313", // Important and Starred tie; first listed wins
      "gm:Work:13",
      "gm:[Gmail]/垃圾邮件:4",
    ].sort());
    expect(r.duplicates_removed).toBe(3);
  });

  it("dedupes before paging so limit/offset count messages, not folder hits", async () => {
    const p1 = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 4, offset: 0 });
    const p2 = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 4, offset: 4 });
    const all = [...p1.emails, ...p2.emails].map((e) => e.message_id);
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
  });

  it("tags rows with the folder's special-use role", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50 });
    const sent = r.emails.find((e) => e.folder === "[Gmail]/已发邮件");
    expect(sent.special_use).toBe("\\Sent");
    expect(r.emails.find((e) => e.folder === "[Gmail]/垃圾邮件").special_use).toBe("\\Junk");
    expect(r.emails.find((e) => e.folder === "Work").special_use).toBeUndefined();
  });

  it("Gmail label aliases are collapsed even with dedupe=false (bulk mutations)", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50, dedupe: false });
    expect(r.emails).toHaveLength(7);
    expect(new Set(r.emails.map((e) => e.message_id)).size).toBe(7);
  });

  it("deleting the canonical All Mail copy of archived mail moves it to Trash once", async () => {
    const r = await email.searchEmails({ query: "lemon", account_id: "gm", folder: "all", limit: 50, dedupe: false });
    const e = r.emails.find((x) => x.message_id === "<e@x>");
    const del = await email.deleteEmails({ email_ids: [e.uid], folder: e.folder, account_id: "gm" });
    expect(del.success).toBe(true);
    const boxes = globalThis.__MAILBOX_MOCK_STATE.accounts.gm.mailboxes;
    expect(boxes["[Gmail]/已删除邮件"].messages.map((m) => m.messageId)).toEqual(["<e@x>"]);
    expect(boxes[ALL_MAIL].messages.some((m) => m.messageId === "<e@x>")).toBe(false);
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
