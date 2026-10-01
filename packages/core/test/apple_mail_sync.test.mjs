import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const appleMail = require("../src/services/apple_mail.js");
const { detectProvider, guideFor } = require("../src/services/auth_code_guide.js");
const accounts = require("../src/services/accounts.js");
const { resolveAccountConnectionConfig } = require("../src/services/provider_defaults.js");

const US = "\u001f";
const RS = "\u001e";
const GS = "\u001d";
const rec = (...f) => f.join(US) + RS;

// What the read script prints for the three accounts seen on a real Mac.
const REAL_OUTPUT =
  rec("iCloud", "iCloud", "12491851@qq.com", "leeguoo@icloud.com", "imap.mail.me.com", "993", "true", "smtp.mail.me.com", "587", "true") +
  rec("谷歌", "imap", "leeguooooo@gmail.com", "leeguooooo@gmail.com", "imap.gmail.com", "993", "true", "smtp.gmail.com", "587", "true") +
  rec("163, 工作 \"主\"", "imap", "leeguoo@163.com", `leeguoo@163.com${GS}Alias <alias@163.com>`, "appleimap.163.com", "993", "true", "applesmtp.163.com", "465", "true") +
  rec("老 POP", "pop", "old@example.com", "", "pop.example.com", "995", "true", "", "", "") +
  "\n";

describe("readMailAccounts", () => {
  it("parses names with commas, quotes and Chinese, aliases, and a missing SMTP server", async () => {
    let script = "";
    const r = await appleMail.readMailAccounts({ platform: "darwin", runOsascript: async (s) => { script = s; return REAL_OUTPUT; } });
    expect(script).toContain('tell application "Mail"');
    expect(script).toMatch(/if not wasRunning then/);
    expect(r.success).toBe(true);
    expect(r.accounts).toHaveLength(4);
    expect(r.accounts[0]).toEqual({
      name: "iCloud",
      type: "iCloud",
      user_name: "12491851@qq.com",
      emails: ["leeguoo@icloud.com"],
      imap: { host: "imap.mail.me.com", port: 993, ssl: true },
      smtp: { host: "smtp.mail.me.com", port: 587, ssl: true },
    });
    expect(r.accounts[2].name).toBe("163, 工作 \"主\"");
    expect(r.accounts[2].emails).toEqual(["leeguoo@163.com", "alias@163.com"]);
    expect(r.accounts[3]).toMatchObject({ type: "pop", emails: [], smtp: null });
  });

  it("an empty account list is a success with no accounts", async () => {
    const r = await appleMail.readMailAccounts({ platform: "darwin", runOsascript: async () => "\n" });
    expect(r).toEqual({ success: true, accounts: [] });
  });

  it("maps -1743 to permission_denied with a Chinese hint", async () => {
    const err = Object.assign(new Error("fail"), { stderr: "execution error: Not authorized to send Apple events to Mail. (-1743)" });
    const r = await appleMail.readMailAccounts({ platform: "darwin", runOsascript: async () => { throw err; } });
    expect(r).toMatchObject({ success: false, error_code: "permission_denied" });
    expect(r.hint).toMatch(/隐私与安全性/);
    expect(r.hint).toMatch(/自动化/);
  });

  it("a timeout or other osascript error is error_code failed", async () => {
    const t = await appleMail.readMailAccounts({ platform: "darwin", runOsascript: async () => { throw Object.assign(new Error("osascript timed out"), { timedOut: true }); } });
    expect(t).toMatchObject({ success: false, error_code: "failed" });
    expect(t.error).toMatch(/超时/);
    const o = await appleMail.readMailAccounts({ platform: "darwin", runOsascript: async () => { throw new Error("boom (-600)"); } });
    expect(o).toMatchObject({ success: false, error_code: "failed" });
  });

  it("is not_macos elsewhere", async () => {
    const r = await appleMail.readMailAccounts({ platform: "linux" });
    expect(r).toMatchObject({ success: false, error_code: "not_macos" });
  });

  it("MAILBOX_APPLE_MAIL_ACCOUNTS_JSON replaces osascript (array or simulated error)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "am-fixture-"));
    const f = path.join(dir, "a.json");
    const prev = process.env.MAILBOX_APPLE_MAIL_ACCOUNTS_JSON;
    try {
      fs.writeFileSync(f, JSON.stringify([{ name: "x", emails: ["A@B.com"], imap: { host: "h", port: 993, ssl: true } }]));
      process.env.MAILBOX_APPLE_MAIL_ACCOUNTS_JSON = f;
      const ok = await appleMail.readMailAccounts({ platform: "linux" });
      expect(ok).toMatchObject({ success: true, accounts: [{ name: "x", type: "imap", emails: ["A@B.com"], smtp: null }] });
      fs.writeFileSync(f, JSON.stringify({ error: "denied", error_code: "permission_denied" }));
      expect(await appleMail.readMailAccounts()).toMatchObject({ success: false, error_code: "permission_denied" });
    } finally {
      if (prev == null) delete process.env.MAILBOX_APPLE_MAIL_ACCOUNTS_JSON;
      else process.env.MAILBOX_APPLE_MAIL_ACCOUNTS_JSON = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("matching mail-use against Apple Mail", () => {
  const mail = appleMail.parseMailAccountsOutput(REAL_OUTPUT);
  const mu = [
    { id: "g", email: "LeeGuooooo@Gmail.com" }, // case differs
    { id: "a", email: "alias@163.com" }, // an alias of the 163 account
    { id: "q", email: "12491851@qq.com" }, // the iCloud Apple ID, not an iCloud mailbox
  ];

  it("matches case-insensitively and on aliases, but not on an iCloud Apple ID", () => {
    const idx = appleMail.mailAddressIndex(mail);
    expect(idx.has("leeguooooo@gmail.com")).toBe(true);
    expect(idx.has("alias@163.com")).toBe(true);
    expect(idx.has("12491851@qq.com")).toBe(false);
    expect(idx.has("old@example.com")).toBe(true); // user name counts on non-iCloud accounts
  });

  it("export leaves out addresses Mail already has unless includeExisting", () => {
    const { toExport, existing } = appleMail.partitionForExport(mu, mail);
    expect(toExport.map((a) => a.id)).toEqual(["q"]);
    expect(existing).toEqual([
      { id: "g", email: "LeeGuooooo@Gmail.com", apple_mail_account_name: "谷歌" },
      { id: "a", email: "alias@163.com", apple_mail_account_name: "163, 工作 \"主\"" },
    ]);
    expect(appleMail.partitionForExport(mu, mail, { includeExisting: true }).toExport).toHaveLength(3);
  });

  it("import candidates are Mail accounts with no address in mail-use", () => {
    const { candidates, already } = appleMail.importCandidates(mu, mail);
    expect(candidates.map((c) => c.email)).toEqual(["leeguoo@icloud.com", "old@example.com"]);
    expect(already.map((a) => a.email)).toEqual(["leeguooooo@gmail.com", "leeguoo@163.com"]);
  });

  it("status has one row per address and a command for each gap", () => {
    const s = appleMail.buildStatus(mu, mail);
    const by = Object.fromEntries(s.accounts.map((r) => [r.email, r]));
    expect(by["LeeGuooooo@Gmail.com"]).toMatchObject({ in_mail_use: true, in_apple_mail: true, apple_mail_account_name: "谷歌", suggested_command: "" });
    expect(by["12491851@qq.com"]).toMatchObject({ in_mail_use: true, in_apple_mail: false });
    expect(by["leeguoo@icloud.com"]).toMatchObject({ in_mail_use: false, in_apple_mail: true, apple_mail_account_name: "iCloud" });
    expect(by["leeguoo@163.com"]).toBeUndefined(); // matched through its alias
    expect(s.accounts).toHaveLength(5);
    expect(s.suggestions).toEqual([
      { email: "12491851@qq.com", action: "export", command: "mail-use apple-mail export --account-id 12491851@qq.com" },
      { email: "leeguoo@icloud.com", action: "import", command: "mail-use apple-mail import --email leeguoo@icloud.com" },
      { email: "old@example.com", action: "import", command: "mail-use apple-mail import --email old@example.com" },
    ]);
  });
});

describe("authorization code guide", () => {
  it("detects the provider from the domain, then from the server", () => {
    expect(detectProvider("a@qq.com")).toBe("qq");
    expect(detectProvider("a@Foxmail.com")).toBe("qq");
    expect(detectProvider("a@163.com")).toBe("163");
    expect(detectProvider("a@126.com")).toBe("126");
    expect(detectProvider("a@googlemail.com")).toBe("gmail");
    expect(detectProvider("a@hotmail.com")).toBe("outlook");
    expect(detectProvider("a@me.com")).toBe("icloud");
    expect(detectProvider("a@corp.example", "appleimap.163.com")).toBe("163");
    expect(detectProvider("a@corp.example", "imap.gmail.com")).toBe("gmail");
    expect(detectProvider("a@corp.example", "mail.corp.example")).toBe("custom");
  });

  it("gives the page and steps for each provider", () => {
    expect(guideFor("a@qq.com")).toMatchObject({ provider: "qq", needs: "授权码", url: "https://wx.mail.qq.com", supported: true, has_defaults: true });
    expect(guideFor("a@163.com").url).toBe("https://mail.163.com");
    expect(guideFor("a@126.com").url).toBe("https://mail.126.com");
    expect(guideFor("a@gmail.com")).toMatchObject({ needs: "应用专用密码", url: "https://myaccount.google.com/apppasswords" });
    expect(guideFor("a@icloud.com")).toMatchObject({ needs: "应用专用密码", url: "https://account.apple.com", has_defaults: true });
    expect(guideFor("a@outlook.com").supported).toBe(false);
    expect(guideFor("a@corp.example")).toMatchObject({ provider: "custom", has_defaults: false });
    for (const p of ["qq", "163", "126", "gmail", "icloud", "custom"]) {
      const g = guideFor(p);
      expect(g.steps.length).toBeGreaterThan(0);
      expect(g.steps.length).toBeLessThanOrEqual(3);
    }
  });

  it("iCloud defaults: implicit TLS IMAP, STARTTLS SMTP on 587", () => {
    const c = resolveAccountConnectionConfig({ provider: "icloud", email: "a@icloud.com" });
    expect(c.imap).toEqual({ host: "imap.mail.me.com", port: 993, secure: true });
    expect(c.smtp).toEqual({ host: "smtp.mail.me.com", port: 587, secure: false });
  });
});

describe("saveAccount", () => {
  let dir;
  let prev;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "save-acc-"));
    prev = { c: process.env.MAILBOX_CONFIG_DIR, d: process.env.MAILBOX_DATA_DIR };
    process.env.MAILBOX_CONFIG_DIR = path.join(dir, "config");
    process.env.MAILBOX_DATA_DIR = path.join(dir, "data");
  });
  afterEach(() => {
    for (const [k, v] of [["MAILBOX_CONFIG_DIR", prev.c], ["MAILBOX_DATA_DIR", prev.d]]) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const authFile = () => path.join(dir, "config", "auth.json");
  const readAuth = () => JSON.parse(fs.readFileSync(authFile(), "utf8"));

  it("writes an owner-only auth.json, sets the default, never returns the password", () => {
    const r = accounts.saveAccount({ email: "me@qq.com", password: "s3cret", provider: "qq" });
    expect(r).toMatchObject({ success: true, replaced: false, is_default: true, account: { id: "me_qq", email: "me@qq.com", imap_host: "imap.qq.com" } });
    expect(JSON.stringify(r)).not.toContain("s3cret");
    expect(fs.statSync(authFile()).mode & 0o777).toBe(0o600);
    const auth = readAuth();
    expect(auth.default_account).toBe("me_qq");
    // Known provider: no hosts stored, provider_defaults stays authoritative.
    expect(auth.accounts.me_qq).toEqual({ email: "me@qq.com", password: "s3cret", provider: "qq" });
  });

  it("merges with other accounts and keeps the existing default", () => {
    fs.mkdirSync(path.dirname(authFile()), { recursive: true });
    fs.writeFileSync(authFile(), JSON.stringify({ version: 1, accounts: { keep: { email: "k@163.com", password: "k", provider: "163" } }, default_account: "keep", extra: 1 }));
    const r = accounts.saveAccount({ email: "bob@corp.example", password: "p", provider: "custom", imap_host: "imap.corp.example", imap_port: 143, smtp_host: "smtp.corp.example", smtp_port: 587 });
    expect(r).toMatchObject({ success: true, is_default: false, account: { id: "bob_custom" } });
    const auth = readAuth();
    expect(auth.extra).toBe(1);
    expect(auth.default_account).toBe("keep");
    expect(auth.accounts.keep.password).toBe("k");
    expect(auth.accounts.bob_custom).toMatchObject({ imap_host: "imap.corp.example", imap_port: 143, imap_secure: false, smtp_port: 587, smtp_secure: false });
  });

  it("derives a unique id and refuses a duplicate email unless forced", () => {
    accounts.saveAccount({ email: "me@qq.com", password: "a", provider: "qq" });
    // Same local part + provider, different address: id gets a suffix.
    expect(accounts.saveAccount({ email: "me@foxmail.com", password: "b", provider: "qq" }).account.id).toBe("me_qq_2");
    const dup = accounts.saveAccount({ email: "ME@qq.com", password: "c", provider: "qq" });
    expect(dup).toMatchObject({ success: false, error_code: "already_exists", id: "me_qq" });
    const forced = accounts.saveAccount({ email: "me@qq.com", password: "c", provider: "qq" }, { force: true });
    expect(forced).toMatchObject({ success: true, replaced: true, account: { id: "me_qq" } });
    expect(readAuth().accounts.me_qq.password).toBe("c");
    expect(Object.keys(readAuth().accounts)).toEqual(["me_qq", "me_qq_2"]);
  });

  it("rejects bad input", () => {
    expect(accounts.saveAccount({ email: "nope", password: "x" })).toMatchObject({ success: false, error_code: "invalid_argument" });
    expect(accounts.saveAccount({ email: "a@b.com", password: "" })).toMatchObject({ success: false, error_code: "invalid_argument" });
    expect(accounts.saveAccount({ email: "a@b.com", password: "x", imap_host: "h", imap_port: "99999" })).toMatchObject({ success: false });
    expect(fs.existsSync(authFile())).toBe(false);
  });
});
