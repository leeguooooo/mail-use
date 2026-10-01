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

function register(program, ctx) {
  const { accounts } = ctx.proxies;
  const accountCmd = program.command("account").description("Account operations");
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

module.exports = { register };
