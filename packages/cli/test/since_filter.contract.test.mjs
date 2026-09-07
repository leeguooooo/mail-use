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

async function listSince(env, since) {
  const r = await execa(
    "node",
    [cliBin(), "email", "list", "--folder", "INBOX", "--account-id", "mock_acc", "--live", "--since", since, "--json"],
    { reject: false, env }
  );
  return JSON.parse(r.stdout);
}

describe("WP-H: --since alias", () => {
  it("--since is sugar for --date-from and actually filters", async () => {
    const root = tmpRoot("since_filter");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    // Mock INBOX messages are dated 2026-02-01.
    const included = await listSince(env, "2026-01-01");
    expect(included.emails.length).toBeGreaterThan(0);

    const excluded = await listSince(env, "2030-01-01");
    expect(excluded.emails.length).toBe(0);
  });
});
