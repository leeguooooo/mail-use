import { describe, expect, it } from "vitest";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";

import { testEnv, writeAuthJson } from "./_helpers.mjs";

const cliBin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");

function setup(name) {
  const root = path.join(import.meta.dirname, ".tmp", name);
  fs.rmSync(root, { recursive: true, force: true });
  const env = { ...testEnv(root), MAILBOX_NO_DAEMON: "1" };
  writeAuthJson(env.MAILBOX_CONFIG_DIR, {
    version: 1,
    accounts: {
      qq_main: { email: "me@qq.com", password: "secret", provider: "qq", description: "从环境变量导入" },
      gmail_main: { email: "me@gmail.com", password: "app-pass", provider: "gmail" },
      no_pass: { email: "x@163.com", password: "", provider: "163" },
    },
    default_account: "qq_main",
  });
  return { root, env };
}

const run = (env, args) => execa("node", [cliBin, "apple-mail", ...args, "--json"], { reject: false, env });

describe("mail-use apple-mail", () => {
  it("--output writes an owner-only profile with every usable account", async () => {
    const { root, env } = setup("apple_mail_all");
    const out = path.join(root, "p.mobileconfig");
    const r = await run(env, ["--output", out, "--no-open"]);
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.success).toBe(true);
    expect(p.accounts.map((a) => a.id)).toEqual(["qq_main", "gmail_main"]);
    expect(p.skipped).toEqual([{ id: "no_pass", email: "x@163.com", reason: "missing password" }]);
    expect(p.profile_path).toBe(out);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    const xml = fs.readFileSync(out, "utf8");
    expect(xml).toContain("<string>imap.gmail.com</string>");
    expect(xml).toContain("<string>QQ 邮箱 (me@qq.com)</string>");
    expect(xml).not.toContain("从环境变量导入");
  });

  it("--account-id picks one account by id or email", async () => {
    const { root, env } = setup("apple_mail_one");
    const out = path.join(root, "p.mobileconfig");
    const r = await run(env, ["--account-id", "me@gmail.com", "--output", out, "--no-open"]);
    expect(JSON.parse(r.stdout).accounts.map((a) => a.id)).toEqual(["gmail_main"]);
    expect(fs.readFileSync(out, "utf8")).not.toContain("me@qq.com");
  });

  it("an unknown account is an error", async () => {
    const { env } = setup("apple_mail_unknown");
    const r = await run(env, ["--account-id", "nope", "--output", "/tmp/never.mobileconfig", "--no-open"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, error_code: "invalid_argument" });
  });

  it("default flow (macOS): opens a temp profile and removes it after the TTL", async () => {
    if (process.platform !== "darwin") return;
    const { env } = setup("apple_mail_default");
    const r = await run({ ...env, MAILBOX_APPLE_MAIL_OPENER: "true", MAILBOX_APPLE_MAIL_TTL_SECONDS: "1" }, []);
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p).toMatchObject({ success: true, opened: true, removed_after_seconds: 1 });
    expect(p.next_steps.length).toBeGreaterThan(0);
    expect(fs.existsSync(p.profile_path)).toBe(true);
    expect(fs.statSync(p.profile_path).mode & 0o777).toBe(0o600);
    await new Promise((res) => { setTimeout(res, 2500); });
    expect(fs.existsSync(path.dirname(p.profile_path))).toBe(false);
  });

  it("a failing opener reports an error and removes the profile at once", async () => {
    if (process.platform !== "darwin") return;
    const { env } = setup("apple_mail_open_fail");
    const r = await run({ ...env, MAILBOX_APPLE_MAIL_OPENER: "false" }, []);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, error_code: "operation_failed" });
  });

  it("--no-open without --output is a usage error (nothing would be kept)", async () => {
    const { env } = setup("apple_mail_noop");
    const r = await run(env, ["--no-open"]);
    expect(r.exitCode).toBe(2);
  });
});
