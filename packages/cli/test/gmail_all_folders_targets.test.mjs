import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("@mail-use/core/src/services/email.js");
const { resetMockState } = require("@mail-use/core/src/testing/mock_store.js");
const { searchFilteredEmailTargets } = require("../src/cli/targets.js");

const ALL_MAIL = "[Gmail]/All Mail";

function msg(uid, messageId, emailId, labels) {
  return {
    uid,
    messageId,
    emailId,
    ...(labels ? { labels } : {}),
    subject: "Weekly digest",
    from: "news@example.com",
    to: "me@gmail.com",
    cc: "",
    date: "2026-09-01 10:00:00",
    flags: new Set([]),
    body: "digest",
    html: "",
    attachments: [],
  };
}

// inbox: INBOX + Important; archived: only All Mail; sent: Sent (from me would
// not match, but a Sent copy of a matching thread does); spam: Spam.
function mailboxes() {
  return {
    INBOX: { specialUse: "\\Inbox", messages: [msg(10, "<inbox@x>", "1")] },
    "[Gmail]": { flags: ["\\Noselect"], specialUse: "", messages: [] },
    "[Gmail]/Important": { flags: ["\\Important"], specialUse: "", messages: [msg(50, "<inbox@x>", "1")] },
    "[Gmail]/Sent Mail": { specialUse: "\\Sent", messages: [msg(7, "<sent@x>", "3")] },
    "[Gmail]/Spam": { specialUse: "\\Junk", messages: [msg(3, "<spam@x>", "4")] },
    "[Gmail]/Trash": { specialUse: "\\Trash", messages: [] },
    [ALL_MAIL]: {
      specialUse: "\\All",
      messages: [
        msg(900, "<inbox@x>", "1", ["\\Inbox", "\\Important"]),
        msg(901, "<archived@x>", "2", []),
        msg(902, "<sent@x>", "3", ["\\Sent"]),
      ],
    },
  };
}

describe("bulk --all-folders targets on Gmail", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "gmail_all_folders_targets");
    fs.rmSync(root, { recursive: true, force: true });
    process.env.MAILBOX_INTERNAL_TEST_MODE = "1";
    process.env.MAILBOX_CONFIG_DIR = path.join(root, "config");
    process.env.MAILBOX_DATA_DIR = path.join(root, "data");
    fs.mkdirSync(process.env.MAILBOX_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.MAILBOX_CONFIG_DIR, "auth.json"),
      JSON.stringify({ version: 1, accounts: { gm: { email: "me@gmail.com", password: "x", provider: "gmail" } }, default_account: "gm" }) + "\n",
      "utf8"
    );
    resetMockState();
    globalThis.__MAILBOX_MOCK_STATE.accounts.gm = { id: "gm", email: "me@gmail.com", mailboxes: mailboxes() };
  });

  it("targets each message once at its canonical folder, including archived mail, and still skips Sent/Spam", async () => {
    const r = await searchFilteredEmailTargets(email, { from: "news", accountId: "gm", allFolders: true });
    expect(r.targets.map((t) => t.gid).sort()).toEqual(["gm:INBOX:10", `gm:${ALL_MAIL}:901`].sort());
    expect(r.skipped_special_folders.sort()).toEqual(["[Gmail]/Sent Mail", "[Gmail]/Spam"].sort());
    const groups = [...r.groups.values()].map((g) => ({ folder: g.folder, uids: g.uids }));
    expect(groups).toEqual(expect.arrayContaining([{ folder: "INBOX", uids: ["10"] }, { folder: ALL_MAIL, uids: ["901"] }]));
    expect(groups).toHaveLength(2);
  });
});
