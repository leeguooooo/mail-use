// apple-mail: hand mail-use's accounts to Apple Mail via a configuration
// profile, so a person gets the same mailboxes in Mail.app (or on an iPhone)
// without typing server names, ports or authorization codes.
//
// macOS will not install a profile from the command line (since macOS 11 only
// System Settings can), so the one step left to the person is clicking
// Install there. Everything up to that point is done here.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const { _out } = require("../cli/render");

// How long the temp profile stays on disk after `open` hands it to System
// Settings. macOS copies it when it registers the download; it only has to
// outlive that hand-off, and it holds passwords in plaintext. A detached
// cleanup removes it so the command itself returns at once.
const TEMP_PROFILE_TTL_SECONDS = Number(process.env.MAILBOX_APPLE_MAIL_TTL_SECONDS || 60);

const INSTALL_STEPS = [
  "打开「系统设置」→「通用」→「设备管理」（旧版 macOS：「隐私与安全性」→「描述文件」）",
  "双击「mail-use 邮箱账号」→ 点「安装」→ 输入开机密码",
  "打开「邮件」，账号已经在里面了",
];

function _selectAccounts(accounts, wanted) {
  if (!wanted) return accounts;
  const w = String(wanted).trim().toLowerCase();
  return accounts.filter((a) => String(a.id).toLowerCase() === w || String(a.email || "").toLowerCase() === w);
}

function _writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// MAILBOX_APPLE_MAIL_OPENER swaps `open` for another command (tests use
// `true`), so the default flow runs without popping up System Settings.
function _open(file) {
  const opener = process.env.MAILBOX_APPLE_MAIL_OPENER || "open";
  return new Promise((resolve) => {
    execFile(opener, [file], (err) => resolve(err ? err.message : ""));
  });
}

// Remove dir after ttl seconds from a process that outlives this one. The
// path goes in as an argument, never into the shell string.
function _scheduleRemoval(dir, ttlSeconds) {
  const child = spawn("/bin/sh", ["-c", 'sleep "$1"; rm -rf -- "$2"', "mail-use-cleanup", String(ttlSeconds), dir], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function _printText(result) {
  if (!result.success) {
    process.stderr.write(`${result.error}\n`);
    return;
  }
  const lines = [];
  lines.push(`已生成描述文件，包含 ${result.accounts.length} 个账号：`);
  for (const a of result.accounts) lines.push(`  - ${a.email}`);
  for (const s of result.skipped) lines.push(`  跳过 ${s.email || s.id}：${s.reason}`);
  if (result.removed_after_seconds) lines.push(`临时文件含明文密码，${result.removed_after_seconds} 秒后自动删除。`);
  else if (result.profile_path) lines.push(`文件：${result.profile_path}（含明文密码，装完请删除）`);
  if (result.opened) {
    lines.push("", "还差一步：");
    result.next_steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  } else if (result.hint) {
    lines.push("", result.hint);
  }
  _out(lines.join("\n") + "\n");
}

function register(program, ctx) {
  program
    .command("apple-mail")
    .description("Add your accounts to Apple Mail (macOS / iPhone) via a configuration profile — no manual server setup")
    .option("--account-id <id>", "Only this account (id or email); default: all accounts")
    .option("--output <path>", "Write the profile here and keep it (e.g. to AirDrop to an iPhone)")
    .option("--no-open", "Do not open the profile in System Settings")
    .action(async (opts) => {
      // Read auth.json in this process: passwords never travel over the
      // daemon socket for this.
      const { accounts: accountsSvc, appleMail } = require("@mail-use/core");
      const loaded = accountsSvc.getAllAccountsResolved();
      if (!loaded.success) return ctx.respond(loaded, _printText);

      const selected = _selectAccounts(loaded.accounts, opts.accountId);
      if (!selected.length) {
        const error = opts.accountId ? `Account not found: ${opts.accountId}` : "No accounts configured";
        return ctx.respond({ success: false, error, error_code: "invalid_argument" }, _printText);
      }

      const usable = [];
      const skipped = [];
      for (const a of selected) {
        const reason = appleMail.unsupportedReason(a);
        if (reason) skipped.push({ id: a.id, email: a.email || "", reason });
        else usable.push(a);
      }
      if (!usable.length) {
        return ctx.respond({ success: false, error: "No account can be added to Apple Mail", error_code: "invalid_argument", skipped }, _printText);
      }

      const isMac = process.platform === "darwin";
      const shouldOpen = opts.open !== false && isMac;
      if (!opts.output && !shouldOpen) {
        return ctx.usage(isMac
          ? "--no-open needs --output <path> (otherwise there is nothing to keep)"
          : "Apple Mail profiles are installed on macOS/iOS; pass --output <path> to save one (e.g. to AirDrop to an iPhone)");
      }

      const xml = appleMail.buildMobileconfig(usable);
      const keep = Boolean(opts.output);
      const file = keep
        ? path.resolve(opts.output)
        : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-")), "mail-use-accounts.mobileconfig");
      _writePrivate(file, xml);

      let openError = "";
      if (shouldOpen) openError = await _open(file);
      if (!keep) {
        if (openError) fs.rmSync(path.dirname(file), { recursive: true, force: true });
        else _scheduleRemoval(path.dirname(file), TEMP_PROFILE_TTL_SECONDS);
      }

      if (openError) {
        return ctx.respond({ success: false, error: `Could not open the profile: ${openError}`, error_code: "operation_failed" }, _printText);
      }
      const result = {
        success: true,
        accounts: usable.map((a) => ({ id: a.id, email: a.email, provider: a.provider || "" })),
        skipped,
        opened: shouldOpen,
        profile_path: file,
        ...(keep ? {} : { removed_after_seconds: TEMP_PROFILE_TTL_SECONDS }),
        ...(shouldOpen ? { next_steps: INSTALL_STEPS } : {}),
        ...(!shouldOpen ? { hint: "iPhone/iPad：用隔空投送把文件发过去，在「设置」→「已下载描述文件」里安装。Mac：双击文件后到「系统设置」→「通用」→「设备管理」安装。" } : {}),
      };
      return ctx.respond(result, () => _printText(result));
    });
}

module.exports = { register, _selectAccounts };
