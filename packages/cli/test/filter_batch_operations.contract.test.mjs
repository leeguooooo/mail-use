import { afterEach, describe, expect, it, vi } from "vitest";
import Module from "node:module";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const mainPath = require.resolve("../src/main.js");

function emailsFor(sender, startUid, count) {
  return Array.from({ length: count }, (_, i) => ({
    uid: String(startUid + i),
    id: String(startUid + i),
    subject: `${sender} message ${i + 1}`,
    from: `${sender}@example.com`,
    account_id: "mock_acc",
  }));
}

function makeEmailMock({ searchResult } = {}) {
  const alice = emailsFor("alice", 201, 3);
  const bob = emailsFor("bob", 301, 3);
  return {
    alice,
    bob,
    email: {
      searchEmails: vi.fn(async (opts) => {
        if (searchResult) return searchResult(opts);
        const from = String(opts.from || "").toLowerCase();
        const emails = from === "alice" ? alice : from === "bob" ? bob : [];
        return { success: true, emails, total_found: emails.length };
      }),
      deleteEmails: vi.fn(async (opts) => ({
        success: true,
        deleted_count: (opts.email_ids || []).length,
        total: (opts.email_ids || []).length,
      })),
      markEmails: vi.fn(async (opts) => ({
        success: true,
        marked_count: (opts.email_ids || []).length,
        total: (opts.email_ids || []).length,
        mark_as: opts.mark_as,
      })),
    },
  };
}

async function runCli(argv, email) {
  const originalLoad = Module._load;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalFsWriteSync = fs.writeSync;
  const originalExit = process.exit;
  const stdout = [];
  const stderr = [];
  const exitCalls = [];

  // Inject the fake core at the CLI's single proxy seam. This used to hook
  // `./core_client` and additionally require the parent to be main.js, which
  // silently stopped matching the moment the proxies moved into their own
  // module — the mock was skipped, the CLI went to real IMAP, and the tests hung
  // rather than failing. Matching on the module being required (not on who
  // requires it) has no such blind spot.
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "./proxies") {
      return {
        accounts: {},
        email,
        imap: {},
        smtp: {},
        sync: {},
        digest: {},
        monitor: {},
        inbox: {},
      };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  fs.writeSync = (fd, buffer, offset = 0, length = buffer.length - offset) => {
    const chunk = Buffer.isBuffer(buffer)
      ? buffer.toString("utf8", offset, offset + length)
      : String(buffer).slice(offset, offset + length);
    if (fd === 1) {
      stdout.push(chunk);
      return length;
    }
    if (fd === 2) {
      stderr.push(chunk);
      return length;
    }
    return originalFsWriteSync(fd, buffer, offset, length);
  };
  process.exit = (code) => {
    exitCalls.push(code);
  };

  delete require.cache[mainPath];
  try {
    const { main } = require(mainPath);
    const returnCode = await main([...argv, "--json"]);
    const printed = stdout.join("");
    return {
      code: exitCalls.length ? exitCalls[exitCalls.length - 1] : returnCode,
      stdout: printed,
      stderr: stderr.join(""),
      payload: printed.trim() ? JSON.parse(printed) : null,
    };
  } finally {
    delete require.cache[mainPath];
    Module._load = originalLoad;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    fs.writeSync = originalFsWriteSync;
    process.exit = originalExit;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filter batch operations contract", () => {
  it("email delete --from alice --confirm deletes only alice UIDs", async () => {
    const { email, alice } = makeEmailMock();

    const r = await runCli(["email", "delete", "--from", "alice", "--confirm"], email);

    expect(r.code).toBe(0);
    expect(email.searchEmails).toHaveBeenCalledWith({
      from: "alice",
      subject: undefined,
      account_id: undefined,
      unread_only: undefined,
      folder: "INBOX",
      limit: 1000,
      timeout_ms: 60000,
      dedupe: false,
    });
    expect(email.deleteEmails).toHaveBeenCalledTimes(1);
    expect(email.deleteEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        email_ids: alice.map((m) => m.uid),
        account_id: "mock_acc",
        dry_run: false,
      })
    );
  });

  it("email delete --from alice dry-run reports target count and sample without deleting", async () => {
    const { email, alice } = makeEmailMock();

    const r = await runCli(["email", "delete", "--from", "alice"], email);

    expect(r.code).toBe(0);
    expect(email.deleteEmails).not.toHaveBeenCalled();
    expect(r.payload).toMatchObject({
      success: true,
      dry_run: true,
      would_target_count: alice.length,
      would_target_sample: alice.map(({ uid, subject, from }) => ({ uid, subject, from })),
    });
  });

  it("email delete with no ids and no filters throws invalidUsage", async () => {
    const { email } = makeEmailMock();

    const r = await runCli(["email", "delete"], email);

    expect(r.code).toBe(2);
    expect(r.payload).toMatchObject({
      success: false,
      error: "Must provide email_ids, --from, or --subject",
      error_code: "invalid_argument",
    });
    expect(email.searchEmails).not.toHaveBeenCalled();
    expect(email.deleteEmails).not.toHaveBeenCalled();
  });

  it("email mark --from alice --mark-as read marks only alice UIDs", async () => {
    const { email, alice } = makeEmailMock();

    const r = await runCli(["email", "mark", "--from", "alice", "--mark-as", "read", "--confirm"], email);

    expect(r.code).toBe(0);
    expect(email.markEmails).toHaveBeenCalledTimes(1);
    expect(email.markEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        email_ids: alice.map((m) => m.uid),
        account_id: "mock_acc",
        mark_as: "read",
        dry_run: false,
      })
    );
  });

  it("--all-folders skips Sent/Trash by special-use role even when the folder name is localized", async () => {
    const rows = [
      { uid: "5709", id: "5709", subject: "a", from: "me@gmail.com", account_id: "gm", folder: "INBOX", special_use: "\\Inbox" },
      { uid: "30", id: "30", subject: "b", from: "me@gmail.com", account_id: "gm", folder: "[Gmail]/已发邮件", special_use: "\\Sent" },
      { uid: "8", id: "8", subject: "c", from: "me@gmail.com", account_id: "gm", folder: "[Gmail]/已删除邮件", special_use: "\\Trash" },
    ];
    const { email } = makeEmailMock({
      searchResult: async () => ({ success: true, emails: rows, total_found: rows.length }),
    });

    const r = await runCli(["email", "delete", "--from", "me", "--all-folders", "--account-id", "gm"], email);

    expect(r.code).toBe(0);
    expect(email.searchEmails).toHaveBeenCalledWith(expect.objectContaining({ folder: "all", dedupe: false }));
    expect(r.payload).toMatchObject({ dry_run: true, would_target_count: 1 });
    expect(r.payload.skipped_special_folders.sort()).toEqual(["[Gmail]/已删除邮件", "[Gmail]/已发邮件"]);
  });

  it("requires --confirm when filters match more than 100 emails", async () => {
    const many = emailsFor("alice", 1000, 101);
    const { email } = makeEmailMock({
      searchResult: async () => ({ success: true, emails: many, total_found: many.length }),
    });

    const r = await runCli(["email", "delete", "--from", "alice"], email);

    expect(r.code).toBe(2);
    expect(r.payload).toMatchObject({
      success: false,
      error: "Matched 101 emails. Add --confirm to proceed.",
      error_code: "invalid_argument",
    });
    expect(email.deleteEmails).not.toHaveBeenCalled();
  });
});
