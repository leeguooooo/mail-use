// Regression tests for the 4 issues codex review surfaced and we just fixed.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

describe("Codex review fixes (regression)", () => {
  it("outgoing attachment and new dry-run semantics bypass stale daemons", async () => {
    const { _shouldBypassDaemonForCall } = require("../src/core_client.js");

    expect(_shouldBypassDaemonForCall("email.sendEmail", {
      attachments: [{ path: "/tmp/a.txt" }],
    })).toBe(true);
    expect(_shouldBypassDaemonForCall("email.sendEmail", {
      attachments: [],
    })).toBe(false);
    expect(_shouldBypassDaemonForCall("email.replyEmail", {
      dry_run: true,
    })).toBe(true);
    expect(_shouldBypassDaemonForCall("email.replyEmail", {
      attachments: [{ path: "/tmp/a.txt" }],
    })).toBe(true);
    expect(_shouldBypassDaemonForCall("email.forwardEmail", {
      dry_run: true,
    })).toBe(true);
    expect(_shouldBypassDaemonForCall("email.forwardEmail", {
      dry_run: false,
    })).toBe(false);
  });

  it("email reply lets explicit --folder override the gid folder", async () => {
    const root = tmpRoot("reply_folder_override");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "reply", "mock_acc:Trash:101", "--folder", "INBOX", "--body", "Reply body", "--json"],
      { reject: false, env }
    );

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty("success", true);
    expect(payload).toHaveProperty("dry_run", true);
    expect(payload.would_reply).toMatchObject({
      email_id: "101",
      folder: "INBOX",
      subject: "Re: Hello",
    });
  });

  it("email forward lets explicit --folder override the gid folder", async () => {
    const root = tmpRoot("forward_folder_override");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [
        cliBin(),
        "email",
        "forward",
        "mock_acc:Trash:102",
        "--folder",
        "INBOX",
        "--to",
        "person@example.com",
        "--body",
        "FYI",
        "--json",
      ],
      { reject: false, env }
    );

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty("success", true);
    expect(payload).toHaveProperty("dry_run", true);
    expect(payload.would_forward).toMatchObject({
      email_id: "102",
      folder: "INBOX",
      subject: "Fwd: Unread Note",
    });
  });

  it("BUG-1a: email flag without --confirm is dry-run, doesn't mutate", async () => {
    const root = tmpRoot("flag_dry_run");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    // No --confirm — must come back as dry-run.
    const r = await execa("node", [cliBin(), "email", "flag", "1", "--account-id", "mock_acc", "--set", "--json"], { reject: false, env });
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.dry_run).toBe(true);
    expect(payload.confirmation_required).toBe(true);
  });

  it("BUG-1b: email move without --confirm is dry-run, doesn't mutate", async () => {
    const root = tmpRoot("move_dry_run");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa("node", [cliBin(), "email", "move", "1", "--account-id", "mock_acc", "--target-folder", "Archive", "--json"], { reject: false, env });
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.dry_run).toBe(true);
    // moveEmails dry_run preview shape:
    expect(payload).toHaveProperty("would_move");
    expect(payload.would_move).toBe(1);
  });

  it("BUG-2: --lean preserves preview when --with-preview is requested", async () => {
    // With test mode the IMAP fetch returns no source so preview will be
    // empty — that path is covered by the empty-string drop in leanResult.
    // We instead assert that preview is NOT in LEAN_DROP_PER_EMAIL by
    // poking the contract directly.
    const { leanResult } = await import("@mail-use/shared/src/contract.js");
    const slim = leanResult({
      success: true,
      emails: [
        { id: "1", subject: "x", preview: "first 200 chars of body...", uid: "1" },
        { id: "2", subject: "y", preview: "" },
      ],
    });
    expect(slim.emails[0].preview).toBe("first 200 chars of body...");
    // empty preview still gets dropped:
    expect(slim.emails[1]).not.toHaveProperty("preview");
    // uid is still dropped:
    expect(slim.emails[0]).not.toHaveProperty("uid");
  });

  it("RISK-9: invalid_date wins over generic invalid_argument", async () => {
    const { inferErrorCode } = await import("@mail-use/shared/src/contract.js");
    expect(inferErrorCode("--date-from value \"foo\" is not a valid date (expected ...)")).toBe("invalid_date");
    expect(inferErrorCode("--limit must be a non-negative number (got -5)")).toBe("invalid_limit");
    expect(inferErrorCode("Account not found: x")).toBe("account_not_found");
    // Plain "Invalid X" still maps to the generic argument code:
    expect(inferErrorCode("Invalid email_id")).toBe("invalid_argument");
  });

  it("email mark splits a single whitespace/comma-separated ids argument", async () => {
    const root = tmpRoot("mark_split_ids");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "mark", "101 102,103", "--read", "--account-id", "mock_acc", "--dry-run", "--json"],
      { reject: false, env }
    );

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty("success", true);
    expect(payload.would_mark).toBe(3);
    expect(payload.email_ids).toEqual(["101", "102", "103"]);
  });

  it("email delete splits a single whitespace/comma-separated ids argument", async () => {
    const root = tmpRoot("delete_split_ids");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "delete", "101 102,103", "--account-id", "mock_acc", "--dry-run", "--json"],
      { reject: false, env }
    );

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty("success", true);
    expect(payload.would_delete).toBe(3);
    expect(payload.email_ids).toEqual(["101", "102", "103"]);
  });

  it("batch email show includes list_unsubscribe", async () => {
    const root = tmpRoot("batch_show_list_unsubscribe");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "show", "101", "102", "--account-id", "mock_acc", "--folder", "INBOX", "--json"],
      { reject: false, env }
    );

    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload).toHaveProperty("success", true);
    expect(payload.emails[0]).toHaveProperty("list_unsubscribe");
    expect(payload.emails[0].list_unsubscribe).toEqual({
      mailto: "mailto:unsubscribe@example.com",
      http: "https://example.com/unsubscribe",
    });
  });
});
