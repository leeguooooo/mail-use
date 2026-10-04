import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const { _decodeInlineBody } = require("../src/cli/options.js");

function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

function setup(name) {
  const root = path.join(import.meta.dirname, ".tmp", name);
  fs.rmSync(root, { recursive: true, force: true });
  const env = testEnv(root);
  writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());
  return env;
}

async function run(env, args, input) {
  const r = await execa("node", [cliBin(), ...args, "--json"], { reject: false, env, ...(input != null ? { input } : {}) });
  return { ...r, payload: JSON.parse(r.stdout) };
}

// What a shell hands us for `--body "Hello,\n\nThanks"`: backslash + n, not a newline.
const SHELL_BODY = String.raw`Hello Lemon Squeezy Support,\n\nI am activating the store.\n\nThank you,\nGuo Li`;
const DECODED = "Hello Lemon Squeezy Support,\n\nI am activating the store.\n\nThank you,\nGuo Li";

describe("_decodeInlineBody", () => {
  it("turns literal \\n / \\r\\n into line breaks when the body has no real newline", () => {
    expect(_decodeInlineBody(SHELL_BODY)).toEqual({ body: DECODED, unescaped: true });
    expect(_decodeInlineBody(String.raw`a\r\nb`)).toEqual({ body: "a\nb", unescaped: true });
  });

  it("leaves bodies that already have real line breaks byte-for-byte (code samples)", () => {
    const code = 'Try this:\nprintf("a\\nb");\n';
    expect(_decodeInlineBody(code)).toEqual({ body: code, unescaped: false });
  });

  it("leaves an escaped backslash-n and bodies without escapes alone", () => {
    expect(_decodeInlineBody(String.raw`use \\n here`).unescaped).toBe(false);
    expect(_decodeInlineBody("just one line")).toEqual({ body: "just one line", unescaped: false });
  });
});

describe("email send/reply/forward: literal \\n from shell args", () => {
  it("send --body with literal \\n previews real line breaks and warns", async () => {
    const env = setup("send_body_unescape");
    const r = await run(env, ["email", "send", "--to", "p@example.com", "--subject", "Hi", "--body", SHELL_BODY]);
    expect(r.exitCode).toBe(0);
    expect(r.payload.would_send.body_preview).toBe(DECODED);
    expect(r.payload.would_send.body_bytes).toBe(Buffer.byteLength(DECODED));
    expect(r.payload.warnings).toEqual([expect.stringMatching(/--literal-body/)]);
  });

  it("send --literal-body keeps the backslash-n as typed", async () => {
    const env = setup("send_body_literal");
    const r = await run(env, ["email", "send", "--to", "p@example.com", "--subject", "Hi", "--body", SHELL_BODY, "--literal-body"]);
    expect(r.payload.would_send.body_preview).toBe(SHELL_BODY.slice(0, 200));
    expect(r.payload.warnings).toBeUndefined();
  });

  it("send --body-file - reads the body from stdin untouched", async () => {
    const env = setup("send_body_stdin");
    const body = 'Line one\nprintf("x\\n")\n';
    const r = await run(env, ["email", "send", "--to", "p@example.com", "--subject", "Hi", "--body-file", "-"], body);
    expect(r.exitCode).toBe(0);
    expect(r.payload.would_send.body_preview).toBe(body);
    expect(r.payload.warnings).toBeUndefined();
  });

  it("send --body-file keeps a file's literal \\n (only inline --body is decoded)", async () => {
    const env = setup("send_body_file");
    const file = path.join(env.MAILBOX_CONFIG_DIR, "body.txt");
    fs.writeFileSync(file, SHELL_BODY, "utf8");
    const r = await run(env, ["email", "send", "--to", "p@example.com", "--subject", "Hi", "--body-file", file]);
    expect(r.payload.would_send.body_preview).toBe(SHELL_BODY.slice(0, 200));
    expect(r.payload.warnings).toBeUndefined();
  });

  it("send --confirm sends the decoded body", async () => {
    const env = setup("send_body_confirm");
    const r = await run(env, ["email", "send", "--to", "p@example.com", "--subject", "Hi", "--body", SHELL_BODY, "--account-id", "mock_acc", "--confirm"]);
    expect(r.exitCode).toBe(0);
    expect(r.payload).toMatchObject({ success: true, warnings: [expect.stringMatching(/line breaks/)] });
  });

  it("reply and forward decode the same way", async () => {
    const env = setup("reply_forward_unescape");
    const reply = await run(env, ["email", "reply", "mock_acc:INBOX:101", "--body", SHELL_BODY]);
    expect(reply.exitCode).toBe(0);
    expect(reply.payload.would_reply.body_preview).toBe(DECODED);
    expect(reply.payload.warnings).toHaveLength(1);

    const fwd = await run(env, ["email", "forward", "mock_acc:INBOX:101", "--to", "p@example.com", "--body", SHELL_BODY]);
    expect(fwd.exitCode).toBe(0);
    expect(fwd.payload.would_forward.body_preview).toBe(DECODED);
    expect(fwd.payload.warnings).toHaveLength(1);
  });
});
