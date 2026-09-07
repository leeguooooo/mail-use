import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const { _groupTargets, _groupsBreakdown } = require("../src/main.js");

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

describe("WP-E: grouped preview + multi-folder mutation", () => {
  it("_groupTargets keys by (account_id, folder) and samples subjects", () => {
    const emails = [
      { uid: "1", account_id: "a", folder: "INBOX", subject: "one" },
      { uid: "2", account_id: "a", folder: "INBOX", subject: "two" },
      { uid: "3", account_id: "a", folder: "Trash", subject: "three" },
      { uid: "4", account_id: "b", folder: "INBOX", subject: "four" },
    ];
    const groups = _groupTargets(emails, "a", "");
    const breakdown = _groupsBreakdown(groups).sort((x, y) =>
      `${x.account_id}${x.folder}`.localeCompare(`${y.account_id}${y.folder}`)
    );
    expect(breakdown).toEqual([
      { account_id: "a", folder: "INBOX", count: 2, sample: ["one", "two"] },
      { account_id: "a", folder: "Trash", count: 1, sample: ["three"] },
      { account_id: "b", folder: "INBOX", count: 1, sample: ["four"] },
    ]);
  });

  it("dry-run delete --from emits a groups breakdown before confirm", async () => {
    const root = tmpRoot("delete_groups");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    // Mock 102 is from news@example.com in INBOX.
    const r = await execa(
      "node",
      [cliBin(), "email", "delete", "--from", "news", "--account-id", "mock_acc", "--dry-run", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.dry_run).toBe(true);
    expect(payload.would_target_count).toBe(1);
    expect(Array.isArray(payload.groups)).toBe(true);
    expect(payload.groups[0]).toMatchObject({ account_id: "mock_acc", folder: "INBOX", count: 1 });
  });

  it("--all-folders is accepted and routes the filter across folders", async () => {
    const root = tmpRoot("delete_all_folders");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "delete", "--from", "news", "--all-folders", "--account-id", "mock_acc", "--dry-run", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.dry_run).toBe(true);
    expect(Array.isArray(payload.groups)).toBe(true);
    // every group carries an explicit folder
    for (const g of payload.groups) expect(typeof g.folder).toBe("string");
  });
});
