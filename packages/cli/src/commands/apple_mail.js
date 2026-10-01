// apple-mail: keep mail-use and Apple Mail holding the same mailboxes, in both
// directions, without the person typing server names or ports.
//
//   export  mail-use -> Mail, via a configuration profile (the default, so the
//           original bare `mail-use apple-mail` keeps working)
//   import  Mail -> mail-use: reads Mail's account list, asks once per account
//           for an authorization code (Mail's own passwords are held by
//           accountsd and cannot be read by anyone), checks it, saves it
//   status  which address is where, and the command that would fix each gap
//
// macOS will not install a profile from the command line (since macOS 11 only
// System Settings can), so the one step left to the person on export is
// clicking Install there. Everything up to that point is done here.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const { _out, _printRows } = require("../cli/render");

// How long the temp profile stays on disk after `open` hands it to System
// Settings. macOS copies it when it registers the download; it only has to
// outlive that hand-off, and it holds passwords in plaintext. A detached
// cleanup removes it so the command itself returns at once.
const TEMP_PROFILE_TTL_SECONDS = Number(process.env.MAILBOX_APPLE_MAIL_TTL_SECONDS || 60);

// System Settings > General > Device Management (titled 设备管理), where a
// downloaded profile waits to be installed.
const PROFILES_PANE_URL = "x-apple.systempreferences:com.apple.Profiles-Settings.extension";

// `open` registers the profile asynchronously; opening the pane before that
// finishes can show a list without it.
const SETTINGS_OPEN_DELAY_MS = Number(process.env.MAILBOX_APPLE_MAIL_SETTINGS_DELAY_MS || 1500);

// macOS throws away a downloaded profile that is not installed within about
// eight minutes, so the instructions ask for five.
const INSTALL_STEPS = [
  "系统设置已经打开到「设备管理」：双击「mail-use 邮箱账号」→ 点「安装」→ 输入开机密码。请在 5 分钟内完成（过期了重新运行这条命令即可）。",
  "如果没看到：打开「系统设置」→「通用」→「设备管理」（旧版 macOS：「隐私与安全性」→「描述文件」）",
  "装好后打开「邮件」，账号已经在里面了",
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
// MAILBOX_APPLE_MAIL_SETTINGS_OPENER does the same for the deep link into
// System Settings, falling back to the first one.
function _open(target, { settings = false } = {}) {
  const opener = (settings && process.env.MAILBOX_APPLE_MAIL_SETTINGS_OPENER) || process.env.MAILBOX_APPLE_MAIL_OPENER || "open";
  return new Promise((resolve) => {
    execFile(opener, [target], (err) => resolve(err ? err.message : ""));
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

function _printError(result) {
  process.stderr.write(`${result.error}\n`);
  if (result.hint) process.stderr.write(`${result.hint}\n`);
}

function _printWarnings(lines, result) {
  for (const w of result.warnings || []) lines.push(`注意：${w}`);
}

// ---------------------------------------------------------------------------
// export

function _printExport(result) {
  if (!result.success) return _printError(result);
  const lines = [];
  if (result.nothing_to_do) {
    lines.push(result.message);
    _printWarnings(lines, result);
    _out(lines.join("\n") + "\n");
    return;
  }
  lines.push(`已生成描述文件，包含 ${result.accounts.length} 个账号：`);
  for (const a of result.accounts) lines.push(`  - ${a.email}`);
  for (const s of result.already_in_apple_mail || []) lines.push(`  跳过 ${s.email}：「邮件」里已经有了（${s.apple_mail_account_name}），再装会重复`);
  for (const s of result.skipped) lines.push(`  跳过 ${s.email || s.id}：${s.reason}`);
  _printWarnings(lines, result);
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

async function _export(ctx, opts) {
  // Read auth.json in this process: passwords never travel over the
  // daemon socket for this.
  const { accounts: accountsSvc, appleMail } = require("@mail-use/core");
  const loaded = accountsSvc.getAllAccountsResolved();
  if (!loaded.success) return ctx.respond(loaded, _printExport);

  const selected = _selectAccounts(loaded.accounts, opts.accountId);
  if (!selected.length) {
    const error = opts.accountId ? `Account not found: ${opts.accountId}` : "No accounts configured";
    return ctx.respond({ success: false, error, error_code: "invalid_argument" }, _printExport);
  }

  const usable = [];
  const skipped = [];
  for (const a of selected) {
    const reason = appleMail.unsupportedReason(a);
    if (reason) skipped.push({ id: a.id, email: a.email || "", reason });
    else usable.push(a);
  }
  if (!usable.length) {
    return ctx.respond({ success: false, error: "No account can be added to Apple Mail", error_code: "invalid_argument", skipped }, _printExport);
  }

  const isMac = process.platform === "darwin";
  const shouldOpen = opts.open !== false && isMac;
  if (!opts.output && !shouldOpen) {
    return ctx.usage(isMac
      ? "--no-open needs --output <path> (otherwise there is nothing to keep)"
      : "Apple Mail profiles are installed on macOS/iOS; pass --output <path> to save one (e.g. to AirDrop to an iPhone)");
  }

  // Leave out addresses Mail already has: installing them again would give
  // the person a duplicate account. If Mail can't be read, carry on with
  // everything — a duplicate is easy to delete, a blocked export is not.
  const warnings = [];
  let toExport = usable;
  let existing = [];
  const mail = await appleMail.readMailAccounts();
  if (mail.success) {
    ({ toExport, existing } = appleMail.partitionForExport(usable, mail.accounts, { includeExisting: Boolean(opts.includeExisting) }));
  } else {
    warnings.push(`没能读取「邮件」里已有的账号，所以没有检查重复：${mail.error}${mail.hint ? ` ${mail.hint}` : ""}`);
  }
  const common = {
    skipped,
    skipped_existing: existing.map((e) => e.email),
    already_in_apple_mail: existing,
    apple_mail_read: mail.success ? { success: true } : { success: false, error_code: mail.error_code, error: mail.error },
    warnings,
  };

  if (!toExport.length) {
    const result = {
      success: true,
      nothing_to_do: true,
      accounts: [],
      opened: false,
      ...common,
      message: `这些账号「邮件」里都已经有了，不用再添加：${existing.map((e) => e.email).join("、")}。如果确实想再装一份，加 --include-existing。`,
    };
    return ctx.respond(result, () => _printExport(result));
  }

  const xml = appleMail.buildMobileconfig(toExport);
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
    return ctx.respond({ success: false, error: `Could not open the profile: ${openError}`, error_code: "operation_failed" }, _printExport);
  }

  // Land System Settings on the page where the profile waits. Not fatal: the
  // person can still get there by hand, and next_steps says how.
  let settingsOpened = false;
  if (shouldOpen) {
    if (SETTINGS_OPEN_DELAY_MS > 0) await new Promise((r) => { setTimeout(r, SETTINGS_OPEN_DELAY_MS); });
    const err = await _open(PROFILES_PANE_URL, { settings: true });
    settingsOpened = !err;
    if (err) warnings.push(`没能自动打开「设备管理」：${err}`);
  }

  const result = {
    success: true,
    accounts: toExport.map((a) => ({ id: a.id, email: a.email, provider: a.provider || "" })),
    ...common,
    opened: shouldOpen,
    settings_opened: settingsOpened,
    profile_path: file,
    ...(keep ? {} : { removed_after_seconds: TEMP_PROFILE_TTL_SECONDS }),
    ...(shouldOpen ? { next_steps: INSTALL_STEPS } : {}),
    ...(!shouldOpen ? { hint: "iPhone/iPad：用隔空投送把文件发过去，在「设置」→「已下载描述文件」里安装。Mac：双击文件后到「系统设置」→「通用」→「设备管理」安装。" } : {}),
  };
  return ctx.respond(result, () => _printExport(result));
}

// ---------------------------------------------------------------------------
// import

function _pendingItem(email, guide) {
  return {
    email,
    provider: guide.provider,
    label: guide.label,
    needs: guide.needs,
    url: guide.url,
    steps: guide.steps,
    command: `mail-use apple-mail import --email ${email} --password-stdin`,
  };
}

function _printImport(result) {
  if (!result.success && !(result.imported || []).length && !(result.failed || []).length) return _printError(result);
  const lines = [];
  for (const a of result.imported || []) lines.push(`已导入 ${a.email}（账号 ID：${a.id}）`);
  for (const f of result.failed || []) lines.push(`没导入 ${f.email}：${f.error}`);
  for (const s of result.skipped || []) lines.push(`跳过 ${s.email}：${s.reason}`);
  if ((result.pending || []).length) {
    lines.push("这些账号还需要授权码才能导入（「邮件」里的密码系统不让读取）：");
    for (const p of result.pending) {
      lines.push(`  ${p.email}（${p.label}，需要「${p.needs}」）${p.url ? ` ${p.url}` : ""}`);
      p.steps.forEach((s, i) => lines.push(`    ${i + 1}. ${s}`));
    }
    lines.push("在终端里直接运行 mail-use apple-mail import 会一步步问你。");
  }
  if (result.message) lines.push(result.message);
  _printWarnings(lines, result);
  if ((result.imported || []).length) lines.push("", "接下来可以试试：mail-use email list");
  _out(lines.join("\n") + "\n");
}

async function _import(ctx, opts) {
  if (opts.passwordStdin && !opts.email) return ctx.usage("--password-stdin needs --email <address> (one code is for one account)");

  const { accounts: accountsSvc, appleMail } = require("@mail-use/core");
  const setup = require("../cli/account_setup");
  const prompt = require("../cli/prompt");
  const interactive = prompt.isInteractive() && !opts.passwordStdin;

  const mail = await appleMail.readMailAccounts();
  if (!mail.success) return ctx.respond(mail, _printImport);

  const loaded = accountsSvc.getAllAccountsResolved();
  if (!loaded.success) return ctx.respond(loaded, _printImport);

  let { candidates, already } = appleMail.importCandidates(loaded.accounts, mail.accounts);
  const alreadyEmails = already.map((a) => a.email);

  if (opts.email) {
    const want = String(opts.email).trim().toLowerCase();
    const inMail = mail.accounts.some((m) => appleMail.addressesOf(m).has(want));
    if (!inMail) {
      return ctx.respond({ success: false, error: `「邮件」里没有 ${opts.email} 这个账号`, error_code: "account_not_found", apple_mail_accounts: mail.accounts.map(appleMail.primaryAddress).filter(Boolean) }, _printImport);
    }
    candidates = candidates.filter((c) => appleMail.addressesOf(c.mail).has(want));
    if (!candidates.length) {
      const r = { success: true, nothing_to_do: true, imported: [], pending: [], skipped: [], failed: [], already_in_mail_use: alreadyEmails, message: `${opts.email} 已经在 mail-use 里了，不用导入。` };
      return ctx.respond(r, () => _printImport(r));
    }
  }

  if (!candidates.length) {
    const r = { success: true, nothing_to_do: true, imported: [], pending: [], skipped: [], failed: [], already_in_mail_use: alreadyEmails, message: "「邮件」里的账号 mail-use 都已经有了，不用导入。" };
    return ctx.respond(r, () => _printImport(r));
  }

  const imported = [];
  const pending = [];
  const skipped = [];
  const failed = [];
  const warnings = [];
  if (interactive) prompt.say(`「邮件」里有 ${candidates.length} 个账号还没加到 mail-use：${candidates.map((c) => c.email).join("、")}`);

  for (const c of candidates) {
    const plan = setup.planAccount(c.email, { mail: c.mail });
    if (!plan.success) {
      skipped.push({ email: c.email, reason: plan.error, error_code: plan.error_code });
      continue;
    }
    if (c.mail.type === "pop") warnings.push(`${c.email} 在「邮件」里是 POP 账号；mail-use 会用 IMAP 连接它。`);

    // MAIL_USE_PASSWORD only for a single named account: one secret cannot
    // be right for several mailboxes.
    const allowEnv = Boolean(opts.email);
    if (!opts.passwordStdin && !(allowEnv && process.env.MAIL_USE_PASSWORD) && !interactive) {
      pending.push(_pendingItem(c.email, plan.guide));
      continue;
    }
    if (interactive) setup.printGuide(c.email, plan.guide);

    const attempts = interactive ? 3 : 1;
    let result = null;
    for (let i = 0; i < attempts; i += 1) {
      const secret = await setup.obtainSecret({ passwordStdin: opts.passwordStdin, allowEnv, interactive });
      if (secret == null || !String(secret).trim()) {
        result = null;
        break;
      }
      if (interactive) prompt.say("正在验证…");
      result = await setup.checkAndSave(plan.input, secret, { test: opts.test !== false, description: "从苹果「邮件」导入" });
      if (result.success || result.error_code !== "auth_failed" || i === attempts - 1) break;
      prompt.say(`${result.error}\n请再试一次（还可以试 ${attempts - 1 - i} 次）。`);
    }
    if (!result) {
      if (interactive) skipped.push({ email: c.email, reason: "没有输入授权码，跳过了" });
      else failed.push({ email: c.email, error: "授权码是空的", error_code: "invalid_argument" });
      continue;
    }
    if (result.success) {
      imported.push({ ...result.account, checked: result.checked });
      warnings.push(...result.warnings);
      if (interactive) prompt.say(`已导入 ${c.email}`);
    } else {
      failed.push({ email: c.email, error: result.error, error_code: result.error_code });
    }
  }

  const result = {
    success: failed.length === 0,
    imported,
    pending,
    skipped,
    failed,
    already_in_mail_use: alreadyEmails,
    warnings,
    ...(failed.length ? { error: failed.map((f) => `${f.email}: ${f.error}`).join("; "), error_code: failed[0].error_code || "operation_failed" } : {}),
  };
  return ctx.respond(result, () => _printImport(result));
}

// ---------------------------------------------------------------------------
// status

function _printStatus(result) {
  if (!result.success && !(result.accounts || []).length) return _printError(result);
  if (!result.success) _printError(result);
  const rows = (result.accounts || []).map((r) => ({
    email: r.email,
    mu: r.in_mail_use ? "✓" : "–",
    am: r.in_apple_mail == null ? "?" : r.in_apple_mail ? "✓" : "–",
    cmd: r.suggested_command || "",
  }));
  if (!rows.length) {
    _out("mail-use 和「邮件」里都还没有账号。先运行：mail-use account add\n");
    return;
  }
  _printRows(rows, [
    { key: "email", title: "邮箱", max: 40 },
    { key: "mu", title: "mail-use", max: 8 },
    { key: "am", title: "苹果邮件", max: 8 },
    { key: "cmd", title: "建议", max: 80 },
  ]);
  if (result.success && !(result.suggestions || []).length) _out("\n两边已经一致，不用做什么。\n");
}

async function _status(ctx) {
  const { accounts: accountsSvc, appleMail } = require("@mail-use/core");
  const loaded = accountsSvc.getAllAccountsResolved();
  if (!loaded.success) return ctx.respond(loaded, _printStatus);
  const mail = await appleMail.readMailAccounts();
  if (!mail.success) {
    // Still show what mail-use has, with Apple Mail unknown.
    const accounts = loaded.accounts.map((a) => ({ email: a.email, in_mail_use: true, in_apple_mail: null, apple_mail_account_name: "", account_id: a.id, suggested_command: "" }));
    return ctx.respond({ success: false, error: mail.error, error_code: mail.error_code, ...(mail.hint ? { hint: mail.hint } : {}), accounts, suggestions: [] }, _printStatus);
  }
  const result = { success: true, ...appleMail.buildStatus(loaded.accounts, mail.accounts) };
  return ctx.respond(result, () => _printStatus(result));
}

// ---------------------------------------------------------------------------

function _addExportOptions(cmd) {
  return cmd
    .option("--account-id <id>", "Only this account (id or email); default: all accounts")
    .option("--output <path>", "Write the profile here and keep it (e.g. to AirDrop to an iPhone)")
    .option("--no-open", "Do not open the profile in System Settings")
    .option("--include-existing", "Also include addresses Apple Mail already has (creates duplicates there)");
}

function register(program, ctx) {
  const group = program
    .command("apple-mail")
    .description("Sync accounts with Apple Mail: export (default) puts mail-use accounts into Mail, import brings Mail's accounts into mail-use, status compares them");

  // isDefault keeps the original `mail-use apple-mail [--output ...]` working.
  _addExportOptions(group.command("export", { isDefault: true })
    .description("Add your mail-use accounts to Apple Mail (macOS / iPhone) via a configuration profile; skips addresses Mail already has"))
    .action((opts) => _export(ctx, opts));

  group
    .command("import")
    .description("Add Apple Mail's accounts to mail-use; asks once per account for its authorization code / app password")
    .option("--email <address>", "Only this Apple Mail account")
    .option("--password-stdin", "Read the authorization code from stdin (needs --email; or set MAIL_USE_PASSWORD)")
    .option("--no-test", "Save without checking the IMAP/SMTP login")
    .action((opts) => _import(ctx, opts));

  group
    .command("status")
    .description("Show which addresses are in mail-use and which are in Apple Mail, with the command to sync each")
    .action(() => _status(ctx));
}

module.exports = { register, _selectAccounts, PROFILES_PANE_URL };
