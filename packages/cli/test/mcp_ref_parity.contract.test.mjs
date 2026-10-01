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
const { resolveEmailRefs } = require("../src/cli/targets.js");

const cliBin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");
const root = path.join(import.meta.dirname, ".tmp", "mcp_ref_parity");

async function cli(args) {
  const env = testEnv(root);
  const r = await execa("node", [cliBin, ...args, "--json"], { reject: false, env });
  return { code: r.exitCode, payload: JSON.parse(r.stdout) };
}

// Same error, spelled for each surface: the CLI names its --account-id flag,
// MCP its account_id parameter. Everything else must match.
const forMcp = (msg) => msg.replace("--account-id", "account_id");

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

  const cases = [
    ["email_show", { ids: ["acc_a:INBOX:1", "acc_b:INBOX:2"] }, ["email", "show", "acc_a:INBOX:1", "acc_b:INBOX:2"]],
    ["email_mark", { ids: ["acc_a:INBOX:1", "acc_b:INBOX:2"], mark_as: "read" }, ["email", "mark", "acc_a:INBOX:1", "acc_b:INBOX:2", "--read"]],
    ["email_delete", { ids: ["acc_a:1", "acc_b:2"] }, ["email", "delete", "acc_a:1", "acc_b:2"]],
    ["email_move", { ids: ["acc_a:INBOX:1", "acc_b:INBOX:2"], target_folder: "Archive" }, ["email", "move", "acc_a:INBOX:1", "acc_b:INBOX:2", "--target-folder", "Archive"]],
  ];

  for (const [name, mcpArgs, cliArgs] of cases) {
    it(`${name}: mixed-account gids fail like the CLI (ambiguous_account)`, async () => {
      const viaCli = await cli(cliArgs);
      expect(viaCli.code).toBe(2);
      expect(viaCli.payload).toMatchObject({ success: false, error_code: "ambiguous_account" });

      const viaMcp = await tool(name, mcpArgs);
      expect(viaMcp.isError).toBe(true);
      expect(viaMcp.payload).toEqual({
        success: false,
        error: forMcp(viaCli.payload.error),
        error_code: viaCli.payload.error_code,
      });
    });
  }

  it("an explicit account_id still overrides mixed gids (no error)", () => {
    const r = _resolveRefs(["acc_a:INBOX:1", "acc_b:Trash:2"], "acc_a");
    expect(r.error).toBeUndefined();
    expect(r.accountId).toBe("acc_a");
    expect(r.refs).toEqual([{ id: "1", folder: "INBOX" }, { id: "2", folder: "Trash" }]);
  });

  it("MCP and CLI resolvers agree apart from token splitting", () => {
    const ids = ["acc_a:INBOX:7", "acc_a:99", "42"];
    const mcp = _resolveRefs(ids, "");
    const cliR = resolveEmailRefs(ids, "");
    expect(mcp).toEqual(cliR);
    // CLI tokens may carry several ids; MCP ids are already an array.
    expect(resolveEmailRefs(["1,2 3"], "x").ids).toEqual(["1", "2", "3"]);
    expect(_resolveRefs(["1,2 3"], "x").ids).toEqual(["1,2 3"]);
  });
});
