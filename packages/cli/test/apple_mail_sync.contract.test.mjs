import { describe, expect, it } from "vitest";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";

import { testEnv, writeAuthJson } from "./_helpers.mjs";

const cliBin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");

// Apple Mail as read on a real Mac: iCloud (user name is the Apple ID),
// Gmail added via Google sign-in, 163 on Apple's private endpoints, and a
// custom-domain mailbox.
const MAIL_ACCOUNTS = [
  { name: "iCloud", type: "iCloud", user_name: "12491851@qq.com", emails: ["leeguoo@icloud.com"], imap: { host: "imap.mail.me.com", port: 993, ssl: true }, smtp: { host: "smtp.mail.me.com", port: 587, ssl: true } },
  { name: "谷歌", type: "imap", user_name: "me@gmail.com", emails: ["me@gmail.com"], imap: { host: "imap.gmail.com", port: 993, ssl: true }, smtp: { host: "smtp.gmail.com", port: 587, ssl: true } },
  { name: "163", type: "imap", user_name: "x@163.com", emails: ["x@163.com"], imap: { host: "appleimap.163.com", port: 993, ssl: true }, smtp: { host: "applesmtp.163.com", port: 465, ssl: true } },
  { name: "公司", type: "imap", user_name: "bob@corp.example", emails: ["bob@corp.example"], imap: { host: "mail.corp.example", port: 993, ssl: true }, smtp: { host: "smtp.corp.example", port: 587, ssl: true } },
];

function setup(name, { auth, mail = MAIL_ACCOUNTS } = {}) {
  const root = path.join(import.meta.dirname, ".tmp", name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const mailJson = path.join(root, "apple_mail_accounts.json");
  fs.writeFileSync(mailJson, JSON.stringify(mail));
  const env = {
    ...testEnv(root),
    MAILBOX_NO_DAEMON: "1",
    MAILBOX_APPLE_MAIL_ACCOUNTS_JSON: mailJson,
    MAILBOX_APPLE_MAIL_OPENER: "true",
    MAILBOX_APPLE_MAIL_SETTINGS_OPENER: "true",
    MAILBOX_APPLE_MAIL_SETTINGS_DELAY_MS: "0",
    MAIL_USE_PASSWORD: "",
  };
  writeAuthJson(env.MAILBOX_CONFIG_DIR, auth || {
    version: 1,
    accounts: {
      qq_main: { email: "me@qq.com", password: "secret", provider: "qq" },
      gmail_main: { email: "Me@Gmail.com", password: "app-pass", provider: "gmail" },
    },
    default_account: "qq_main",
  });
  return { root, env, authFile: path.join(env.MAILBOX_CONFIG_DIR, "auth.json") };
}

const cli = (env, args, input) => execa("node", [cliBin, ...args, "--json"], { reject: false, env, ...(input != null ? { input } : { stdin: "ignore" }) });
const readAuth = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

describe("mail-use account add", () => {
  it("--password-stdin saves the account and never prints the password", async () => {
    const { env, authFile } = setup("acct_add_ok");
    const r = await cli(env, ["account", "add", "new@163.com", "--password-stdin"], "Sup3rS3cret\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("Sup3rS3cret");
    const p = JSON.parse(r.stdout);
    expect(p).toMatchObject({ success: true, account: { id: "new_163", email: "new@163.com", provider: "163", imap_host: "imap.163.com" }, checked: { imap: { success: true }, smtp: { success: true } } });
    const auth = readAuth(authFile);
    expect(auth.accounts.new_163).toEqual({ email: "new@163.com", password: "Sup3rS3cret", provider: "163" });
    expect(auth.accounts.qq_main.password).toBe("secret");
    expect(auth.default_account).toBe("qq_main");
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
  });

  it("MAIL_USE_PASSWORD works too; unknown providers need servers", async () => {
    const { env, authFile } = setup("acct_add_env");
    const noHost = await cli({ ...env, MAIL_USE_PASSWORD: "pw" }, ["account", "add", "bob@corp.example"]);
    expect(noHost.exitCode).toBe(1);
    expect(JSON.parse(noHost.stdout)).toMatchObject({ success: false, error_code: "invalid_argument" });
    const r = await cli({ ...env, MAIL_USE_PASSWORD: "pw" }, ["account", "add", "bob@corp.example", "--imap-host", "imap.corp.example", "--smtp-host", "smtp.corp.example", "--smtp-port", "587"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("\"pw\"");
    expect(readAuth(authFile).accounts.bob_custom).toMatchObject({ imap_host: "imap.corp.example", imap_port: 993, imap_secure: true, smtp_port: 587, smtp_secure: false });
  });

  it("refuses to overwrite an existing account unless --force", async () => {
    const { env, authFile } = setup("acct_add_dup");
    const r = await cli(env, ["account", "add", "ME@qq.com", "--password-stdin"], "new");
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, error_code: "already_exists", account: { id: "qq_main" } });
    expect(readAuth(authFile).accounts.qq_main.password).toBe("secret");
    const f = await cli(env, ["account", "add", "me@qq.com", "--password-stdin", "--force"], "new");
    expect(JSON.parse(f.stdout)).toMatchObject({ success: true, replaced: true, account: { id: "qq_main" } });
    expect(readAuth(authFile).accounts.qq_main.password).toBe("new");
  });

  it("without a terminal or a secret it explains where to get the code instead of blocking", async () => {
    const { env } = setup("acct_add_nosecret");
    const r = await cli(env, ["account", "add", "a@gmail.com"]);
    expect(r.exitCode).toBe(1);
    const p = JSON.parse(r.stdout);
    expect(p).toMatchObject({ success: false, error_code: "missing_password", guide: { provider: "gmail", url: "https://myaccount.google.com/apppasswords" } });
  });

  it("an IMAP login failure saves nothing; an SMTP failure saves with a warning", async () => {
    const { env, authFile } = setup("acct_add_fail");
    const bad = await cli({ ...env, MAILBOX_TEST_ACCOUNT_CHECK_FAIL: "imap" }, ["account", "add", "y@qq.com", "--password-stdin"], "wrong");
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ success: false, error_code: "auth_failed" });
    expect(readAuth(authFile).accounts.y_qq).toBeUndefined();
    const smtp = await cli({ ...env, MAILBOX_TEST_ACCOUNT_CHECK_FAIL: "smtp" }, ["account", "add", "y@qq.com", "--password-stdin"], "ok");
    const p = JSON.parse(smtp.stdout);
    expect(p.success).toBe(true);
    expect(p.warnings.join(" ")).toMatch(/发信/);
    expect(readAuth(authFile).accounts.y_qq).toBeDefined();
  });

  it("--help --json describes the command", async () => {
    const { env } = setup("acct_add_help");
    const r = await cli(env, ["account", "add", "--help"]);
    const p = JSON.parse(r.stdout);
    expect(p.help.name).toBe("add");
    expect(p.help.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--password-stdin", "--provider", "--force", "--no-test"]));
  });
});

describe("mail-use apple-mail import", () => {
  it("without a terminal lists what is pending, with where to get each code", async () => {
    const { env, authFile } = setup("am_import_pending");
    const before = fs.readFileSync(authFile, "utf8");
    const r = await cli(env, ["apple-mail", "import"]);
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.success).toBe(true);
    expect(p.imported).toEqual([]);
    expect(p.already_in_mail_use).toEqual(["me@gmail.com"]);
    expect(p.pending.map((x) => x.email)).toEqual(["leeguoo@icloud.com", "x@163.com", "bob@corp.example"]);
    expect(p.pending[0]).toMatchObject({ provider: "icloud", url: "https://account.apple.com", needs: "应用专用密码" });
    expect(p.pending[1]).toMatchObject({ provider: "163", url: "https://mail.163.com" });
    expect(p.pending[0].command).toBe("mail-use apple-mail import --email leeguoo@icloud.com --password-stdin");
    expect(fs.readFileSync(authFile, "utf8")).toBe(before);
  });

  it("--email --password-stdin imports one account, with mail-use's servers for known providers", async () => {
    const { env, authFile } = setup("am_import_one");
    const r = await cli(env, ["apple-mail", "import", "--email", "x@163.com", "--password-stdin"], "code163\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("code163");
    const p = JSON.parse(r.stdout);
    expect(p.imported).toMatchObject([{ id: "x_163", email: "x@163.com", provider: "163", imap_host: "imap.163.com" }]);
    // Not Apple's private appleimap.163.com endpoint.
    expect(readAuth(authFile).accounts.x_163).toMatchObject({ email: "x@163.com", password: "code163", provider: "163" });
    expect(readAuth(authFile).accounts.x_163.imap_host).toBeUndefined();
  });

  it("uses Apple Mail's servers for an unknown provider, and iCloud is importable", async () => {
    const { env, authFile } = setup("am_import_custom");
    await cli(env, ["apple-mail", "import", "--email", "bob@corp.example", "--password-stdin"], "pw");
    expect(readAuth(authFile).accounts.bob_custom).toMatchObject({ imap_host: "mail.corp.example", imap_port: 993, smtp_host: "smtp.corp.example", smtp_port: 587, smtp_secure: false });
    const r = await cli(env, ["apple-mail", "import", "--email", "leeguoo@icloud.com", "--password-stdin"], "abcd-efgh-ijkl-mnop");
    expect(JSON.parse(r.stdout).imported[0]).toMatchObject({ provider: "icloud", imap_host: "imap.mail.me.com" });
  });

  it("--password-stdin needs --email; an address not in Mail is an error; one already imported is a no-op", async () => {
    const { env } = setup("am_import_errors");
    expect((await cli(env, ["apple-mail", "import", "--password-stdin"], "x")).exitCode).toBe(2);
    const missing = await cli(env, ["apple-mail", "import", "--email", "nobody@qq.com", "--password-stdin"], "x");
    expect(JSON.parse(missing.stdout)).toMatchObject({ success: false, error_code: "account_not_found" });
    const done = await cli(env, ["apple-mail", "import", "--email", "ME@gmail.com", "--password-stdin"], "x");
    expect(JSON.parse(done.stdout)).toMatchObject({ success: true, nothing_to_do: true });
  });

  it("reports a permission problem with the fix", async () => {
    const { root, env } = setup("am_import_denied");
    const f = path.join(root, "denied.json");
    fs.writeFileSync(f, JSON.stringify({ error: "没有权限读取「邮件」的账号。", error_code: "permission_denied", hint: "系统设置 → 隐私与安全性 → 自动化" }));
    const r = await cli({ ...env, MAILBOX_APPLE_MAIL_ACCOUNTS_JSON: f }, ["apple-mail", "import"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, error_code: "permission_denied", hint: expect.stringContaining("自动化") });
  });
});

describe("mail-use apple-mail status", () => {
  it("lists every address with where it is and what to run", async () => {
    const { env } = setup("am_status");
    const r = await cli(env, ["apple-mail", "status"]);
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout);
    const by = Object.fromEntries(p.accounts.map((a) => [a.email.toLowerCase(), a]));
    expect(by["me@qq.com"]).toMatchObject({ in_mail_use: true, in_apple_mail: false });
    expect(by["me@gmail.com"]).toMatchObject({ in_mail_use: true, in_apple_mail: true, apple_mail_account_name: "谷歌" });
    expect(by["leeguoo@icloud.com"]).toMatchObject({ in_mail_use: false, in_apple_mail: true });
    // The iCloud Apple ID (12491851@qq.com) is not listed as a mailbox.
    expect(by["12491851@qq.com"]).toBeUndefined();
    expect(p.suggestions.map((s) => s.action)).toEqual(["export", "import", "import", "import"]);
  });
});

describe("mail-use apple-mail export", () => {
  it("skips addresses Apple Mail already has; --include-existing keeps them", async () => {
    const { root, env } = setup("am_export_dups");
    const out = path.join(root, "p.mobileconfig");
    const r = await cli(env, ["apple-mail", "export", "--output", out, "--no-open"]);
    const p = JSON.parse(r.stdout);
    expect(p).toMatchObject({ success: true, skipped_existing: ["Me@Gmail.com"], already_in_apple_mail: [{ id: "gmail_main", apple_mail_account_name: "谷歌" }] });
    expect(p.accounts.map((a) => a.id)).toEqual(["qq_main"]);
    expect(fs.readFileSync(out, "utf8")).not.toContain("imap.gmail.com");
    const all = JSON.parse((await cli(env, ["apple-mail", "export", "--output", out, "--no-open", "--include-existing"])).stdout);
    expect(all.accounts.map((a) => a.id)).toEqual(["qq_main", "gmail_main"]);
    expect(all.skipped_existing).toEqual([]);
  });

  it("when Mail has every account: success, nothing written or opened", async () => {
    const { root, env } = setup("am_export_none", { auth: { version: 1, accounts: { g: { email: "me@gmail.com", password: "p", provider: "gmail" } } } });
    const out = path.join(root, "p.mobileconfig");
    const r = await cli({ ...env, MAILBOX_APPLE_MAIL_OPENER: "false" }, ["apple-mail", "--output", out]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: true, nothing_to_do: true, opened: false });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("if Mail can't be read it exports everything with a warning", async () => {
    const { root, env } = setup("am_export_unreadable");
    const f = path.join(root, "denied.json");
    fs.writeFileSync(f, JSON.stringify({ error: "denied", error_code: "permission_denied" }));
    const out = path.join(root, "p.mobileconfig");
    const p = JSON.parse((await cli({ ...env, MAILBOX_APPLE_MAIL_ACCOUNTS_JSON: f }, ["apple-mail", "--output", out, "--no-open"])).stdout);
    expect(p.accounts).toHaveLength(2);
    expect(p.apple_mail_read).toMatchObject({ success: false, error_code: "permission_denied" });
    expect(p.warnings.length).toBe(1);
  });

  it("bare `apple-mail --output f --no-open` still exports (back-compat)", async () => {
    const { root, env } = setup("am_export_bare");
    const out = path.join(root, "p.mobileconfig");
    const r = await cli(env, ["apple-mail", "--output", out, "--no-open"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: true, profile_path: out });
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });

  it("default flow (macOS) also opens System Settings on the profiles page", async () => {
    if (process.platform !== "darwin") return;
    const { root, env } = setup("am_export_settings");
    const log = path.join(root, "opened.log");
    const opener = path.join(root, "opener.sh");
    fs.writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${log}"\n`, { mode: 0o755 });
    const r = await cli({ ...env, MAILBOX_APPLE_MAIL_OPENER: opener, MAILBOX_APPLE_MAIL_SETTINGS_OPENER: "", MAILBOX_APPLE_MAIL_TTL_SECONDS: "1" }, ["apple-mail"]);
    const p = JSON.parse(r.stdout);
    expect(p).toMatchObject({ success: true, opened: true, settings_opened: true });
    expect(p.next_steps[0]).toMatch(/5 分钟/);
    const opened = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(opened[0]).toMatch(/\.mobileconfig$/);
    expect(opened[1]).toBe("x-apple.systempreferences:com.apple.Profiles-Settings.extension");
  });

  it("--help --json lists the subcommands", async () => {
    const { env } = setup("am_help");
    const p = JSON.parse((await cli(env, ["apple-mail", "--help"])).stdout);
    expect(p.help.subcommands.map((s) => s.name)).toEqual(["export", "import", "status"]);
    const e = JSON.parse((await cli(env, ["apple-mail", "export", "--help"])).stdout);
    expect(e.help.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--account-id", "--output", "--no-open", "--include-existing"]));
  });
});
