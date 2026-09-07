import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

describe("WP-I: recent command + discoverability", () => {
  it("email recent merges across accounts (no --account-id needed)", async () => {
    const root = tmpRoot("recent");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa("node", [cliBin(), "email", "recent", "--live", "--json"], { reject: false, env });
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.emails.length).toBeGreaterThan(0);
    expect(payload.command).toBe("recent");
  });

  it("email recent --since filters", async () => {
    const root = tmpRoot("recent_since");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa("node", [cliBin(), "email", "recent", "--live", "--since", "2030-01-01", "--json"], { reject: false, env });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).emails.length).toBe(0);
  });

  it("email list --folder all warns it is INBOX-only", async () => {
    const root = tmpRoot("list_all_warn");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "list", "--folder", "all", "--account-id", "mock_acc", "--live", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/INBOX-only/i);
    expect(r.stderr).toMatch(/email search --folder all/);
  });
});
