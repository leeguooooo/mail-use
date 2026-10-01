import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const { parseEmailRef: _parseRef, resolveFolderGroups } = require("../src/cli/targets.js");
const { isSpecialMutationFolder: _isSpecialMutationFolder } = require("../src/cli/targets.js");

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

describe("review-fix: 3-part gid parsing + folder-honoring mutations", () => {
  it("_parseRef handles 3-part, legacy 2-part, and bare uid", () => {
    expect(_parseRef("mock_acc:Trash:401")).toEqual({ id: "401", account_id: "mock_acc", folder: "Trash" });
    expect(_parseRef("mock_acc:99")).toEqual({ id: "99", account_id: "mock_acc", folder: "" });
    expect(_parseRef("42")).toEqual({ id: "42", account_id: "", folder: "" });
    // folder names containing a colon survive (rejoined)
    expect(_parseRef("acc:a:b:5")).toEqual({ id: "5", account_id: "acc", folder: "a:b" });
  });

  it("MCP _resolveRefs no longer mangles a 3-part gid into the account_id", () => {
    const { _resolveRefs } = require("../src/mcp_server.js");
    const r = _resolveRefs(["mock_acc:Trash:401"], "");
    expect(r.accountId).toBe("mock_acc"); // was "mock_acc:Trash" before the fix
    expect(r.ids).toEqual(["401"]);
  });

  it("resolveFolderGroups keys ids by their gid folder (explicit folder overrides)", async () => {
    const refs = [
      { id: "1", account_id: "mock_acc", folder: "Trash" },
      { id: "2", account_id: "mock_acc", folder: "Sent" },
      { id: "3", account_id: "mock_acc", folder: "Trash" },
    ];
    // Mirrors core: a ref that names its folder keeps it.
    const email = { resolveEmailFolder: async ({ folder }) => folder || "INBOX" };
    const grouped = await resolveFolderGroups(email, refs, "mock_acc", "");
    expect(grouped.get("Trash")).toEqual(["1", "3"]);
    expect(grouped.get("Sent")).toEqual(["2"]);
    const forced = await resolveFolderGroups(email, refs, "mock_acc", "Archive");
    expect([...forced.keys()]).toEqual(["Archive"]);
  });

  it("CLI delete honors the gid folder (dry-run targets Trash, not INBOX)", async () => {
    const root = tmpRoot("gid_delete_folder");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "delete", "mock_acc:Trash:999", "--dry-run", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.folder).toBe("Trash");
  });

  it("CLI mark honors the gid folder", async () => {
    const root = tmpRoot("gid_mark_folder");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "mark", "mock_acc:Archive:5", "--read", "--dry-run", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).folder).toBe("Archive");
  });

  async function runCli(name, args) {
    const root = tmpRoot(name);
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());
    const r = await execa("node", [cliBin(), ...args, "--json"], { reject: false, env });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout);
  }

  it("CLI move takes the source folder from the gid, not INBOX", async () => {
    const p = await runCli("gid_move_folder", ["email", "move", "mock_acc:Archive:5", "--target-folder", "Trash"]);
    expect(p.source_folder).toBe("Archive");
  });

  it("CLI move groups gids that span folders", async () => {
    const p = await runCli("gid_move_groups", ["email", "move", "mock_acc:Archive:5", "mock_acc:INBOX:101", "--target-folder", "Trash"]);
    expect(p.folders_count).toBe(2);
    expect(p.results.map((r) => [r.source_folder, r.email_ids])).toEqual([["Archive", ["5"]], ["INBOX", ["101"]]]);
  });

  it("CLI move: an explicit --source-folder overrides the gid folder", async () => {
    const p = await runCli("gid_move_explicit", ["email", "move", "mock_acc:Archive:5", "--source-folder", "Sent", "--target-folder", "Trash"]);
    expect(p.source_folder).toBe("Sent");
  });

  it("CLI flag honors the gid folder", async () => {
    const p = await runCli("gid_flag_folder", ["email", "flag", "mock_acc:Archive:5", "--set"]);
    expect(p.would_flag.folder).toBe("Archive");
  });

  it("_isSpecialMutationFolder flags Sent/Drafts/Junk/Trash but not INBOX/custom", () => {
    for (const f of ["Sent", "Drafts", "Junk", "Spam", "Trash", "Deleted Items", "[Gmail]/Trash", "Work/Sent"]) {
      expect(_isSpecialMutationFolder(f), f).toBe(true);
    }
    for (const f of ["INBOX", "Archive", "Work", "Receipts"]) {
      expect(_isSpecialMutationFolder(f), f).toBe(false);
    }
  });
});
