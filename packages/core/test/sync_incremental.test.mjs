import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const sync = require("../src/services/sync.js");
const email = require("../src/services/email.js");
const syncDb = require("../src/storage/sync_db.js");
const { getMailbox, resetMockState, getMockCalls, clearMockCalls } = require("../src/testing/mock_store.js");
const { _mapLimit } = require("../src/services/email/internals.js");
const initSqlJs = require("sql.js/dist/sql-asm.js");

let dbPath;
function setTestEnv(name, accountsMap) {
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
      accounts: accountsMap || { mock_acc: { email: "mock@example.com", password: "mock", provider: "mock" } },
      default_account: "mock_acc",
    }) + "\n",
    "utf8"
  );
  dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
  resetMockState();
}

function msg(uid, extra = {}) {
  return {
    uid, messageId: `<m${uid}@example.com>`, subject: `subject ${uid}`, from: "a@example.com", to: "mock@example.com",
    cc: "", date: "2026-02-02 00:00:00", flags: new Set(), body: "b", html: "", attachments: [], ...extra,
  };
}

async function cachedRows() {
  const r = await syncDb.listEmailsFromCache({ dbPath, accountId: "mock_acc", folder: "INBOX", limit: 500, offset: 0 });
  return r ? r.emails : [];
}

const fetchCalls = () => getMockCalls().filter((c) => c.op === "fetch");
const envelopeFetches = () => fetchCalls().filter((c) => c.opts.envelope);
const flagOnlyFetches = () => fetchCalls().filter((c) => c.opts.flags && !c.opts.envelope);

describe("C13: incremental sync", () => {
  beforeEach(() => setTestEnv("sync_incremental"));

  it("first sync is full and records UIDVALIDITY / UIDNEXT", async () => {
    const r = await sync.force({ account_id: "mock_acc" });
    expect(r).toMatchObject({ success: true, mode: "full", emails_added: 3 });
    const st = await syncDb.getFolderSyncState({ dbPath, accountId: "mock_acc", folder: "INBOX" });
    expect(st.uidValidity).toBe("1");
    expect(st.uidNext).toBe(104);
    expect(st.cachedUids.sort()).toEqual(["101", "102", "103"]);
  });

  it("second sync fetches envelopes only for new UIDs and refreshes flags cheaply", async () => {
    await sync.force({ account_id: "mock_acc" });
    const inbox = getMailbox("mock_acc", "INBOX").messages;
    inbox.push(msg(104));
    inbox.find((m) => m.uid === 101).flags.delete("\\Seen"); // read -> unread on the server
    clearMockCalls();

    const r = await sync.force({ account_id: "mock_acc" });
    expect(r).toMatchObject({ success: true, mode: "incremental", emails_added: 1 });
    expect(envelopeFetches()).toHaveLength(1);
    expect(envelopeFetches()[0].range).toBe("104");
    expect(flagOnlyFetches()).toHaveLength(1);
    expect(flagOnlyFetches()[0].range).toBe("101:103");

    const rows = await cachedRows();
    expect(rows.map((e) => e.uid).sort()).toEqual(["101", "102", "103", "104"]);
    expect(rows.find((e) => e.uid === "101").unread).toBe(true);
  });

  it("an unchanged mailbox costs no envelope fetch at all", async () => {
    await sync.force({ account_id: "mock_acc" });
    clearMockCalls();
    const r = await sync.force({ account_id: "mock_acc" });
    expect(r.mode).toBe("incremental");
    expect(r.emails_added).toBe(0);
    expect(envelopeFetches()).toHaveLength(0);
  });

  it("drops UIDs expunged on the server", async () => {
    await sync.force({ account_id: "mock_acc" });
    const mb = getMailbox("mock_acc", "INBOX");
    mb.messages = mb.messages.filter((m) => m.uid !== 102);
    const r = await sync.force({ account_id: "mock_acc" });
    expect(r.emails_deleted).toBe(1);
    expect((await cachedRows()).map((e) => e.uid).sort()).toEqual(["101", "103"]);
  });

  it("a UIDVALIDITY change wipes the folder's cache and resyncs in full", async () => {
    await sync.force({ account_id: "mock_acc" });
    const mb = getMailbox("mock_acc", "INBOX");
    // Server rebuilt the mailbox: new UIDVALIDITY, messages renumbered.
    mb.uidValidity = 7;
    mb.messages = [msg(1, { subject: "renumbered one" }), msg(2, { subject: "renumbered two" })];
    clearMockCalls();

    const r = await sync.force({ account_id: "mock_acc" });
    expect(r.mode).toBe("full");
    expect(envelopeFetches()[0].range).toBe("1:2");
    const rows = await cachedRows();
    expect(rows.map((e) => e.uid).sort()).toEqual(["1", "2"]);
    const st = await syncDb.getFolderSyncState({ dbPath, accountId: "mock_acc", folder: "INBOX" });
    expect(st.uidValidity).toBe("7");
    expect(st.uidNext).toBe(3);
  });

  it("--full forces a full pass even when incremental is possible", async () => {
    await sync.force({ account_id: "mock_acc" });
    clearMockCalls();
    const r = await sync.force({ account_id: "mock_acc", full: true });
    expect(r.mode).toBe("full");
    expect(envelopeFetches()[0].range).toBe("101:103");
  });

  it("with CONDSTORE, flags are refreshed via CHANGEDSINCE and skipped when nothing changed", async () => {
    getMailbox("mock_acc", "INBOX").highestModseq = 10;
    await sync.force({ account_id: "mock_acc" });

    clearMockCalls();
    await sync.force({ account_id: "mock_acc" });
    expect(flagOnlyFetches()).toHaveLength(0); // HIGHESTMODSEQ unchanged

    await email.markEmails({ email_ids: ["103"], mark_as: "unread", account_id: "mock_acc" });
    clearMockCalls();
    const r = await sync.force({ account_id: "mock_acc" });
    expect(flagOnlyFetches()).toHaveLength(1);
    expect(flagOnlyFetches()[0].fetchOpts.changedSince).toBe(10n);
    expect(r.emails_updated).toBe(1);
    expect((await cachedRows()).find((e) => e.uid === "103").unread).toBe(true);
  });
});

describe("C13: accounts run concurrently", () => {
  it("_mapLimit keeps order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await _mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => { setTimeout(r, n); });
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it("sync.force syncs every account", async () => {
    setTestEnv("sync_multi", {
      mock_acc: { email: "mock@example.com", password: "mock", provider: "mock" },
      second: { email: "second@example.com", password: "x", provider: "mock" },
    });
    globalThis.__MAILBOX_MOCK_STATE.accounts.second = {
      id: "second",
      email: "second@example.com",
      mailboxes: { INBOX: { messages: [msg(7)] }, Trash: { messages: [] } },
    };
    const r = await sync.force({});
    expect(r.success).toBe(true);
    expect(r.results.map((x) => x.account_id)).toEqual(["mock_acc", "second"]);
    expect(r.emails_added).toBe(4);
  });
});

describe("C13: schema v2 indexes", () => {
  beforeEach(() => setTestEnv("sync_indexes"));

  it("drops redundant indexes, adds the list index, upserts still dedupe", async () => {
    await sync.force({ account_id: "mock_acc" });
    await sync.force({ account_id: "mock_acc", full: true });
    const SQL = await initSqlJs();
    const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
    try {
      const names = db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'emails'")[0].values.map((r) => r[0]);
      expect(names).toContain("idx_emails_account_folder_date");
      expect(names).not.toContain("uniq_emails_account_folder_uid");
      expect(names).not.toContain("idx_emails_is_read");
      expect(names).not.toContain("idx_emails_subject");
      expect(names).not.toContain("idx_emails_account_folder");
      const count = db.exec("SELECT COUNT(*) FROM emails")[0].values[0][0];
      expect(count).toBe(3);
    } finally {
      db.close();
    }
  });
});
