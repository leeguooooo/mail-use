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

describe("review-fix: <unknown> --help --json must not falsely report success", () => {
  it("an unknown command's --help returns success:false (was: misleadingly true)", async () => {
    const root = tmpRoot("help_unknown");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa("node", [cliBin(), "definitely-not-a-command", "--help", "--json"], { reject: false, env });
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error_code).toBe("invalid_argument");
    expect(r.exitCode).toBe(2);
  });

  it("a REAL command's --help still returns success", async () => {
    const root = tmpRoot("help_real");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa("node", [cliBin(), "cleanup", "--help", "--json"], { reject: false, env });
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.help.name).toBe("cleanup");
  });

  it("a real command + positional arg (not a subcommand) still resolves to that command's help", async () => {
    const root = tmpRoot("help_posarg");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    // `email show 101` — 101 is an argument to show, not an unknown command.
    const r = await execa("node", [cliBin(), "email", "show", "101", "--help", "--json"], { reject: false, env });
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.help.name).toBe("show");
  });
});
