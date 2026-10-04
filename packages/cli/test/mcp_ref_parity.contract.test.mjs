import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { buildServer, _resolveRefs } = require("../src/mcp_server.js");
const { resolveEmailRefs, resolveEmailRefsChecked } = require("../src/cli/targets.js");

const cliBin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");
const root = path.join(import.meta.dirname, ".tmp", "mcp_ref_parity");

async function cli(args) {
  const env = testEnv(root);
  const r = await execa("node", [cliBin, ...args, "--json"], { reject: false, env });
  return { code: r.exitCode, payload: JSON.parse(r.stdout) };
}

// Same error, spelled for each surface: the CLI names its --account-id flag,
// MCP its account_id parameter. Everything else must match.
const forMcp = (msg) => msg.replaceAll("--account-id", "account_id");

describe("MCP gid resolution matches the CLI", () => {
  let client;

  beforeAll(async () => {
    fs.rmSync(root, { recursive: true, force: true });
    writeAuthJson(testEnv(root).MAILBOX_CONFIG_DIR, defaultAuth());
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverT);
    client = new Client({ name: "parity-test", version: "0.0.0" });
    await client.connect(clientT);
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  async function tool(name, args) {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError, payload: JSON.parse(r.content[0].text) };
  }

  // Multi-account gids are fine now (grouped per account). What still fails:
  // a bare uid next to them (ambiguous_account), and an explicit account that
  // conflicts with a gid's account (account_mismatch).
  const ambiguous = [
    ["email_show", { ids: ["acc_a:INBOX:1", "acc_b:INBOX:2", "7"] }, ["email", "show", "acc_a:INBOX:1", "acc_b:INBOX:2", "7"]],
    ["email_mark", { ids: ["acc_a:INBOX:1", "acc_b:INBOX:2", "7"], mark_as: "read" }, ["email", "mark", "acc_a:INBOX:1", "acc_b:INBOX:2", "7", "--read"]],
    ["email_delete", { ids: ["acc_a:1", "acc_b:2", "7"] }, ["email", "delete", "acc_a:1", "acc_b:2", "7"]],
    ["email_move", { ids: ["acc_a:INBOX:1", "acc_b:INBOX:2", "7"], target_folder: "Archive" }, ["email", "move", "acc_a:INBOX:1", "acc_b:INBOX:2", "7", "--target-folder", "Archive"]],
  ];
  const mismatch = [
    ["email_show", { ids: ["acc_a:INBOX:1", "acc_b:INBOX:2"], account_id: "acc_a" }, ["email", "show", "acc_a:INBOX:1", "acc_b:INBOX:2", "--account-id", "acc_a"]],
    ["email_mark", { ids: ["acc_b:INBOX:2"], account_id: "acc_a", mark_as: "read" }, ["email", "mark", "acc_b:INBOX:2", "--account-id", "acc_a", "--read"]],
    ["email_delete", { ids: ["acc_b:2"], account_id: "acc_a" }, ["email", "delete", "acc_b:2", "--account-id", "acc_a"]],
    ["email_move", { ids: ["acc_b:INBOX:2"], account_id: "acc_a", target_folder: "Archive" }, ["email", "move", "acc_b:INBOX:2", "--account-id", "acc_a", "--target-folder", "Archive"]],
    ["email_flag", { id: "acc_b:INBOX:2", account_id: "acc_a", set: true }, ["email", "flag", "acc_b:INBOX:2", "--account-id", "acc_a", "--set"]],
  ];

  for (const [code, cases] of [["ambiguous_account", ambiguous], ["account_mismatch", mismatch]]) {
    for (const [name, mcpArgs, cliArgs] of cases) {
      it(`${name}: fails like the CLI (${code})`, async () => {
        const viaCli = await cli(cliArgs);
        expect(viaCli.code).toBe(2);
        expect(viaCli.payload).toMatchObject({ success: false, error_code: code });

        const viaMcp = await tool(name, mcpArgs);
        expect(viaMcp.isError).toBe(true);
        expect(viaMcp.payload).toEqual({
          success: false,
          error: forMcp(viaCli.payload.error),
          error_code: viaCli.payload.error_code,
        });
      });
    }
  }

  it("mixed-account gids resolve per ref (no error)", async () => {
    const r = await _resolveRefs(["acc_a:INBOX:1", "acc_b:Trash:2"], "");
    expect(r.error).toBeUndefined();
    expect(r.mixed).toBe(true);
    expect(r.accountId).toBe("");
    expect(r.accountIds).toEqual(["acc_a", "acc_b"]);
    expect(r.refs).toEqual([
      { id: "1", folder: "INBOX", account_id: "acc_a" },
      { id: "2", folder: "Trash", account_id: "acc_b" },
    ]);
  });

  it("an explicit account_id matching every gid is accepted (case-insensitive)", async () => {
    const r = await _resolveRefs(["acc_a:INBOX:1", "ACC_A:Trash:2", "3"], "acc_a");
    expect(r.error).toBeUndefined();
    expect(r.accountId).toBe("acc_a");
    expect(r.refs.map((x) => x.account_id)).toEqual(["acc_a", "acc_a", "acc_a"]);
  });

  it("an explicit email address is checked against the account it names", async () => {
    const accountsApi = {
      getAccountByIdOrEmail: async (v) => (v === "a@example.com"
        ? { success: true, account: { id: "acc_a" } }
        : { success: false, error: "Account not found" }),
    };
    const ok = await resolveEmailRefsChecked(accountsApi, ["acc_a:INBOX:1"], "a@example.com");
    expect(ok.error).toBeUndefined();
    expect(ok.conflicts).toBeUndefined();
    expect(ok.accountId).toBe("a@example.com");

    const bad = await resolveEmailRefsChecked(accountsApi, ["acc_b:INBOX:1"], "a@example.com");
    expect(bad.error_code).toBe("account_mismatch");
    expect(bad.error).toMatch(/acc_b/);
  });

  it("MCP and CLI resolvers agree apart from token splitting", async () => {
    const ids = ["acc_a:INBOX:7", "acc_a:99", "42"];
    const mcp = await _resolveRefs(ids, "");
    const cliR = resolveEmailRefs(ids, "");
    expect(mcp).toEqual(cliR);
    // CLI tokens may carry several ids; MCP ids are already an array.
    expect(resolveEmailRefs(["1,2 3"], "x").ids).toEqual(["1", "2", "3"]);
    expect((await _resolveRefs(["1,2 3"], "x")).ids).toEqual(["1,2 3"]);
  });
});
