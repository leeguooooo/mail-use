import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { buildServer } = require("../src/mcp_server.js");

describe("AI review through MCP", () => {
  let client;
  beforeAll(async () => {
    const env = testEnv(path.join(import.meta.dirname, ".tmp", "ai_review_mcp"));
    for (const key of ["MAILBOX_INTERNAL_TEST_MODE", "MAILBOX_CONFIG_DIR", "MAILBOX_DATA_DIR"]) vi.stubEnv(key, env[key]);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverT);
    client = new Client({ name: "review-test", version: "1.0.0" });
    await client.connect(clientT);
  });
  afterAll(async () => {
    if (client) await client.close();
    vi.unstubAllEnvs();
  });

  it.each(["cleanup", "inbox_organize"])("%s supplies emails for agent decisions", async (name) => {
    const result = await client.callTool({ name, arguments: { account_id: "mock_acc", limit: 2 } });
    expect(result.isError).toBe(false);
    const p = JSON.parse(result.content[0].text);
    expect(p.decision_by).toBe("agent");
    expect(p.decision_required).toBe(true);
    expect(p.emails).toHaveLength(2);
    expect(p.emails.every((e) => e.gid)).toBe(true);
    expect(p.candidates_by_category).toEqual({});
  });

  it.each([{ confirm: true }, { categories: ["marketing"] }, { permanent: true }])("rejects legacy category deletion %j before account lookup", async (arguments_) => {
    const result = await client.callTool({ name: "cleanup", arguments: arguments_ });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ success: false, error_code: "explicit_selection_required" });
  });

  it("passes pagination and preview length to the same reader", async () => {
    const result = await client.callTool({ name: "cleanup", arguments: { account_id: "mock_acc", limit: 2, offset: 2, preview_chars: 5 } });
    const p = JSON.parse(result.content[0].text);
    expect(p.emails).toHaveLength(1);
    expect(p.preview_count).toBe(1);
    expect(p.emails[0].preview.length).toBeLessThanOrEqual(5);
    expect(p.truncated).toBe(false);
  });
});
