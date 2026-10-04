import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";

import { testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const { orderShownEmails, showRefs, mutateByAccount } = require("../src/cli/targets.js");

const cliBin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");
const root = path.join(import.meta.dirname, ".tmp", "multi_account_refs");

// Two mock accounts with the same fixture (uids 101-103 in INBOX each).
function twoAccountAuth() {
  return {
    version: 1,
    accounts: {
      mock_acc: { email: "mock@example.com", password: "mock", provider: "mock" },
      acc_b: { email: "b@example.com", password: "mock", provider: "mock" },
    },
    default_account: "mock_acc",
  };
}

function env() {
  return { ...testEnv(root), MAILBOX_MOCK_EXTRA_ACCOUNTS: "acc_b" };
}

async function cli(args) {
  const r = await execa("node", [cliBin, ...args, "--json"], { reject: false, env: env() });
  return { code: r.exitCode, payload: JSON.parse(r.stdout) };
}

describe("batch show across accounts", () => {
  beforeAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    writeAuthJson(env().MAILBOX_CONFIG_DIR, twoAccountAuth());
  });

  it("CLI: gids from several accounts merge into one response in requested order", async () => {
    const { code, payload } = await cli([
      "email", "show", "mock_acc:INBOX:103", "acc_b:INBOX:101", "mock_acc:INBOX:101", "acc_b:INBOX:102",
    ]);
    expect(code).toBe(0);
    expect(payload.success).toBe(true);
    expect(payload.requested).toBe(4);
    expect(payload.returned).toBe(4);
    expect(payload.emails.map((e) => e.gid)).toEqual([
      "mock_acc:INBOX:103", "acc_b:INBOX:101", "mock_acc:INBOX:101", "acc_b:INBOX:102",
    ]);
    expect(payload.emails.map((e) => e.account_id)).toEqual(["mock_acc", "acc_b", "mock_acc", "acc_b"]);
    // Mixed: no top-level account_id, account_ids[] instead.
    expect(payload).not.toHaveProperty("account_id");
    expect(payload.account_ids).toEqual(["mock_acc", "acc_b"]);
    expect(payload.failed_ids).toEqual([]);
  });

  it("CLI: a missing uid in one account is reported with its account_id", async () => {
    const { code, payload } = await cli(["email", "show", "mock_acc:INBOX:101", "acc_b:INBOX:999"]);
    expect(code).toBe(1);
    expect(payload.success).toBe(false);
    expect(payload.returned).toBe(1);
    expect(payload.failed_ids).toEqual([expect.objectContaining({ id: "999", account_id: "acc_b" })]);
  });

  it("CLI: single-account batch keeps account_id and follows the requested order", async () => {
    const { code, payload } = await cli(["email", "show", "mock_acc:INBOX:103", "mock_acc:INBOX:101"]);
    expect(code).toBe(0);
    expect(payload.account_id).toBe("mock_acc");
    expect(payload.emails.map((e) => e.id)).toEqual(["103", "101"]);
  });

  it("CLI: --account-id conflicting with a gid's account is an error", async () => {
    const { code, payload } = await cli(["email", "show", "mock_acc:INBOX:101", "acc_b:INBOX:101", "--account-id", "mock_acc"]);
    expect(code).toBe(2);
    expect(payload).toMatchObject({ success: false, error_code: "account_mismatch" });
  });

  it("CLI: --account-id given as the account's email matches its gids", async () => {
    const { code, payload } = await cli(["email", "show", "acc_b:INBOX:101", "acc_b:INBOX:102", "--account-id", "b@example.com"]);
    expect(code).toBe(0);
    expect(payload.returned).toBe(2);
  });
});

describe("mutations across accounts", () => {
  beforeAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    writeAuthJson(env().MAILBOX_CONFIG_DIR, twoAccountAuth());
  });

  it("CLI mark (dry-run) groups per account and folder", async () => {
    const { code, payload } = await cli(["email", "mark", "mock_acc:INBOX:101", "acc_b:INBOX:102", "acc_b:Trash:5", "--read"]);
    expect(code).toBe(0);
    expect(payload.dry_run).toBeUndefined();
    expect(payload.accounts_count).toBe(2);
    expect(payload.results.map((r) => [r.account_id, r.folder, r.email_ids])).toEqual([
      ["mock_acc", "INBOX", ["101"]],
      ["acc_b", "INBOX", ["102"]],
      ["acc_b", "Trash", ["5"]],
    ]);
    expect(payload.results.every((r) => r.dry_run === true)).toBe(true);
    expect(payload.confirmation_required).toBe(true);
  });

  it("CLI delete --confirm deletes in each account", async () => {
    const { code, payload } = await cli(["email", "delete", "mock_acc:INBOX:102", "acc_b:INBOX:102", "--confirm"]);
    expect(code).toBe(0);
    expect(payload.success).toBe(true);
    expect(payload.results.map((r) => r.account_id)).toEqual(["mock_acc", "acc_b"]);
  });

  it("CLI move (dry-run) groups per account", async () => {
    const { code, payload } = await cli(["email", "move", "mock_acc:INBOX:101", "acc_b:INBOX:101", "--target-folder", "Trash"]);
    expect(code).toBe(0);
    expect(payload.accounts_count).toBe(2);
    expect(payload.results.map((r) => [r.account_id, r.source_folder])).toEqual([["mock_acc", "INBOX"], ["acc_b", "INBOX"]]);
  });
});

describe("MCP email_show / email_mark across accounts", () => {
  let client;
  const saved = {};

  beforeAll(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    const e = env();
    writeAuthJson(e.MAILBOX_CONFIG_DIR, twoAccountAuth());
    for (const k of ["MAILBOX_INTERNAL_TEST_MODE", "MAILBOX_CONFIG_DIR", "MAILBOX_DATA_DIR", "MAILBOX_MOCK_EXTRA_ACCOUNTS"]) {
      saved[k] = process.env[k];
      process.env[k] = e[k];
    }
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
    const { buildServer } = require("../src/mcp_server.js");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverT);
    client = new Client({ name: "multi-account-test", version: "0.0.0" });
    await client.connect(clientT);
  });

  afterAll(async () => {
    if (client) await client.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function tool(name, args) {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError, payload: JSON.parse(r.content[0].text) };
  }

  it("email_show merges gids from several accounts", async () => {
    const { isError, payload } = await tool("email_show", { ids: ["acc_b:INBOX:103", "mock_acc:INBOX:101"] });
    expect(isError).toBe(false);
    expect(payload.emails.map((e) => e.gid)).toEqual(["acc_b:INBOX:103", "mock_acc:INBOX:101"]);
    expect(payload.account_ids).toEqual(["acc_b", "mock_acc"]);
  });

  it("email_mark groups per account (dry-run)", async () => {
    const { isError, payload } = await tool("email_mark", { ids: ["mock_acc:INBOX:101", "acc_b:INBOX:101"], mark_as: "unread" });
    expect(isError).toBe(false);
    expect(payload.results.map((r) => r.account_id)).toEqual(["mock_acc", "acc_b"]);
  });
});

describe("showRefs / orderShownEmails / mutateByAccount (unit)", () => {
  it("orderShownEmails follows ref order, matching account + uid + folder", () => {
    const emails = [
      { id: "5", account_id: "a", folder: "Trash" },
      { id: "5", account_id: "a", folder: "INBOX" },
      { id: "5", account_id: "b", folder: "INBOX" },
    ];
    const refs = [
      { id: "5", account_id: "b", folder: "INBOX" },
      { id: "5", account_id: "a", folder: "INBOX" },
      { id: "5", account_id: "a", folder: "Trash" },
    ];
    expect(orderShownEmails(refs, emails).map((e) => `${e.account_id}/${e.folder}`)).toEqual(["b/INBOX", "a/INBOX", "a/Trash"]);
  });

  it("showRefs degrades an account whose call fails to failed_ids", async () => {
    const email = {
      showEmailsResolved: async ({ account_id, refs }) => (account_id === "bad"
        ? { success: false, error: "Account not found: bad" }
        : { success: true, account_id, emails: refs.map((r) => ({ id: r.id, folder: "INBOX" })), failed_ids: [] }),
    };
    const out = await showRefs(email, {
      refs: [{ id: "1", account_id: "good", folder: "" }, { id: "2", account_id: "bad", folder: "INBOX" }],
    });
    expect(out.success).toBe(false);
    expect(out.emails).toEqual([{ id: "1", folder: "INBOX", account_id: "good" }]);
    expect(out.failed_ids).toEqual([{ id: "2", account_id: "bad", folder: "INBOX", error: "Account not found: bad" }]);
    expect(out.account_ids).toEqual(["good", "bad"]);
  });

  it("mutateByAccount passes a single account's result through unchanged", async () => {
    const r = await mutateByAccount(new Map([["a", [{ id: "1" }]]]), async () => ({ success: true, folder: "INBOX" }));
    expect(r).toEqual({ success: true, folder: "INBOX" });
  });
});
