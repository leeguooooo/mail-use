// account list / test-connection

const { _printAccountList } = require("../cli/render");

async function _testConnection(proxies, accountId) {
  const { accounts } = proxies;
  let result;

  try {
    const accId = String(accountId || "").trim();
    let targets = [];

    if (accId) {
      const one = await accounts.getAccountByIdOrEmail(accId);
      if (!one.success) {
        result = { success: false, error: one.error || `Account not found: ${accId}`, accounts: [], total_accounts: 0 };
      } else {
        targets = [one.account];
      }
    } else {
      const all = await accounts.getAllAccountsResolved();
      if (!all.success) {
        result = all;
      } else {
        targets = all.accounts || [];
        if (!targets.length) {
          result = { success: false, error: "No accounts configured", accounts: [], total_accounts: 0 };
        }
      }
    }

    if (!result) {
      const out = [];
      for (const a of targets) {
        const item = {
          email: a.email,
          provider: a.provider,
          success: false,
          imap: { success: false },
          smtp: { success: false },
        };

        try {
          // imap/smtp are lazy getters on the proxies object: touching them
          // loads core, so only do it here.
          const im = await proxies.imap.testConnection(a, "INBOX");
          item.imap = { success: Boolean(im && im.success), total_emails: im.total_emails || 0, unread_emails: im.unread_emails || 0 };
          if (im && im.error) item.imap.error = im.error;
        } catch (e) {
          item.imap = { success: false, error: e && e.message ? e.message : "IMAP failed" };
        }

        try {
          const sm = await proxies.smtp.testConnection(a);
          item.smtp = { success: Boolean(sm && sm.success) };
          if (sm && sm.error) item.smtp.error = sm.error;
        } catch (e) {
          item.smtp = { success: false, error: e && e.message ? e.message : "SMTP failed" };
        }

        item.success = Boolean(item.imap && item.imap.success) && Boolean(item.smtp && item.smtp.success);
        out.push(item);
      }

      result = { success: out.length > 0 && out.every((x) => x.success), accounts: out, total_accounts: out.length };
    }
  } catch (e) {
    result = { success: false, error: e && e.message ? e.message : "test failed" };
  }
  return result;
}

function _parsePort(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
    const { InvalidArgumentError } = require("commander");
    throw new InvalidArgumentError("must be a port number");
  }
  return n;
}

function _printAddResult(result) {
  if (!result.success) {
    process.stderr.write(`${result.error}\n`);
    if (result.guide && result.error_code === "missing_password") {
      const g = result.guide;
      process.stderr.write(`\n${g.label}需要「${g.needs}」${g.url ? `：${g.url}` : ""}\n`);
      g.steps.forEach((s, i) => process.stderr.write(`  ${i + 1}. ${s}\n`));
    }
    return;
  }
  const { _out } = require("../cli/render");
  const a = result.account;
  const lines = [`${result.replaced ? "已更新" : "已添加"} ${a.email}（账号 ID：${a.id}${result.is_default ? "，默认账号" : ""}）`];
  if (result.checked) lines.push("收信" + (result.checked.imap.success ? "正常" : "失败") + "，发信" + (result.checked.smtp.success ? "正常" : "失败"));
  for (const w of result.warnings || []) lines.push(`注意：${w}`);
  lines.push("", "接下来可以试试：");
  result.next_steps.forEach((s) => lines.push(`  ${s}`));
  _out(lines.join("\n") + "\n");
}

// account add: the novice path. Detects the provider, says where to get the
// authorization code, reads it without echo, checks it, saves it.
async function _accountAdd(ctx, emailArg, opts) {
  const setup = require("../cli/account_setup");
  const prompt = require("../cli/prompt");
  const interactive = prompt.isInteractive() && !opts.passwordStdin;

  let email = String(emailArg || "").trim();
  if (!email && interactive) email = await prompt.promptLine("邮箱地址：");
  if (!email) return ctx.usage("Missing email address: mail-use account add <email>");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return ctx.usage(`Invalid email address: ${email}`);

  const { accounts } = require("@mail-use/core");
  const existing = accounts.getAccountByIdOrEmail(email);
  if (existing.success && !opts.force) {
    return ctx.respond({
      success: false,
      error: `${email} 已经在 mail-use 里了（账号 ID：${existing.account.id}）。要替换它请加 --force`,
      error_code: "already_exists",
      account: { id: existing.account.id, email: existing.account.email, provider: existing.account.provider || "" },
    }, _printAddResult);
  }

  const plan = setup.planAccount(email, {
    overrides: { provider: opts.provider, imapHost: opts.imapHost, imapPort: opts.imapPort, smtpHost: opts.smtpHost, smtpPort: opts.smtpPort },
  });
  if (!plan.success) return ctx.respond(plan, _printAddResult);
  if (opts.id) plan.input.id = opts.id;

  if (interactive) setup.printGuide(email, plan.guide);
  const pending = { email, provider: plan.provider, label: plan.guide.label, needs: plan.guide.needs, url: plan.guide.url, steps: plan.guide.steps };

  // Up to three tries on a terminal: a mistyped or stale code is the common
  // failure and re-running the whole command is a lot to ask of a novice.
  const attempts = interactive ? 3 : 1;
  let result = null;
  for (let i = 0; i < attempts; i += 1) {
    const secret = await setup.obtainSecret({ passwordStdin: opts.passwordStdin, interactive });
    if (secret == null) {
      return ctx.respond({
        success: false,
        error: "需要授权码：用 --password-stdin 从标准输入传入，或设置环境变量 MAIL_USE_PASSWORD",
        error_code: "missing_password",
        guide: plan.guide,
        pending: [pending],
      }, _printAddResult);
    }
    if (!secret.trim() && interactive) {
      return ctx.respond({ success: false, error: "没有输入授权码，已取消", error_code: "cancelled" }, _printAddResult);
    }
    if (interactive) prompt.say("正在验证…");
    result = await setup.checkAndSave(plan.input, secret, { test: opts.test !== false, force: Boolean(opts.force), description: opts.description || "" });
    if (result.success || result.error_code !== "auth_failed" || i === attempts - 1) break;
    prompt.say(`${result.error}\n请再试一次（还可以试 ${attempts - 1 - i} 次）。`);
  }

  if (result.success) {
    result.next_steps = [
      `mail-use email list --account-id ${result.account.id}    # 看看最近的邮件`,
      "mail-use account list                       # 查看所有账号",
      ...(process.platform === "darwin" ? [`mail-use apple-mail export --account-id ${result.account.email}    # 也加到苹果「邮件」里`] : []),
    ];
  } else if (result.error_code === "auth_failed") {
    result.guide = plan.guide;
  }
  return ctx.respond(result, _printAddResult);
}

function register(program, ctx) {
  const { accounts } = ctx.proxies;
  const accountCmd = program.command("account").description("Account operations");
  accountCmd
    .command("add [email]")
    .description("Add a mailbox: detects the provider, explains where to get the authorization code, checks it, saves it")
    .option("--provider <name>", "qq | 163 | 126 | gmail | icloud | custom (default: detected from the address)")
    .option("--imap-host <host>", "IMAP server (needed for unknown providers)")
    .option("--imap-port <port>", "IMAP port (default 993)", _parsePort)
    .option("--smtp-host <host>", "SMTP server (needed for unknown providers)")
    .option("--smtp-port <port>", "SMTP port (default 465)", _parsePort)
    .option("--id <id>", "Account id to save under (default: derived from the address)")
    .option("--description <text>", "A note stored with the account")
    .option("--password-stdin", "Read the authorization code / app password from stdin (or set MAIL_USE_PASSWORD)")
    .option("--no-test", "Save without checking the IMAP/SMTP login")
    .option("--force", "Replace an account with the same address")
    .action((email, opts) => _accountAdd(ctx, email, opts));

  accountCmd
    .command("list")
    .description("List configured accounts")
    .action(async () => {
      const result = await accounts.listAccounts();
      ctx.respond(result, _printAccountList);
    });

  accountCmd
    .command("test-connection")
    .description("Test IMAP/SMTP connectivity")
    .option("--account-id <id>", "Specific account id/email")
    .action(async (opts) => {
      const result = await _testConnection(ctx.proxies, opts.accountId);
      ctx.respond(result, "account test-connection");
    });
}

module.exports = { register, _parsePort };
