// Shared steps for adding one account: work out the servers, get the
// authorization code, check it against the real servers, save it.
//
// Used by `account add` and `apple-mail import`. Runs in-process (never over
// the daemon socket) because the secret is involved, and loads @mail-use/core
// only when called so `--version` / `--help` stay light.

const prompt = require("./prompt");

const CHECK_TIMEOUT_MS = Number(process.env.MAILBOX_ACCOUNT_CHECK_TIMEOUT_MS || 30000);

function _core() {
  return require("@mail-use/core");
}

// Providers whose codes never contain spaces. Gmail shows its app password in
// groups of four ("abcd efgh ijkl mnop"); people paste it with the spaces.
const STRIP_SPACES = new Set(["qq", "163", "126", "gmail", "icloud"]);

function normalizeSecret(secret, provider) {
  const s = String(secret == null ? "" : secret);
  return STRIP_SPACES.has(provider) ? s.replace(/\s+/g, "") : s.trim();
}

// Decide provider and servers for an address.
//
// overrides: { provider, imapHost, imapPort, smtpHost, smtpPort } from flags.
// mail: the Apple Mail account (from readMailAccounts) when importing; its
// servers are used only when mail-use has no defaults for the provider,
// because Mail's hosts can be Apple-only endpoints (appleimap.163.com).
//
// -> { success, provider, guide, input } where input is the saveAccount()
// argument minus the password; or { success: false, error, error_code, guide }.
function planAccount(email, { overrides = {}, mail = null } = {}) {
  const { authCodeGuide, providerDefaults } = _core();
  const mailHost = mail && mail.imap ? mail.imap.host : "";
  const detected = authCodeGuide.guideFor(email, mailHost);
  const provider = String(overrides.provider || detected.provider).toLowerCase();
  const guide = provider === detected.provider ? detected : authCodeGuide.guideFor(provider);

  if (!guide.supported && !overrides.imapHost) {
    return { success: false, error: `${guide.label} 暂不支持：${guide.steps[0]}`, error_code: "unsupported_provider", provider, guide };
  }

  const input = { email, provider };
  if (overrides.imapHost) {
    input.imap_host = overrides.imapHost;
    if (overrides.imapPort) input.imap_port = overrides.imapPort;
    if (overrides.smtpHost) input.smtp_host = overrides.smtpHost;
    if (overrides.smtpPort) input.smtp_port = overrides.smtpPort;
  } else if (!providerDefaults.resolveProviderDefaults(provider)) {
    if (mail && mail.imap && mail.imap.host) {
      input.imap_host = mail.imap.host;
      input.imap_port = mail.imap.port || 993;
      if (mail.smtp && mail.smtp.host) {
        input.smtp_host = mail.smtp.host;
        input.smtp_port = mail.smtp.port || 465;
      }
    } else {
      return {
        success: false,
        error: `不认识 ${email} 的邮箱服务商，请用 --imap-host 和 --smtp-host 指定服务器（可以在邮箱网页版的 IMAP/SMTP 设置页找到）`,
        error_code: "invalid_argument",
        provider,
        guide,
      };
    }
  } else {
    if (overrides.imapPort) input.imap_port = overrides.imapPort;
    if (overrides.smtpPort) input.smtp_port = overrides.smtpPort;
    if (overrides.smtpHost) input.smtp_host = overrides.smtpHost;
  }
  if (!input.smtp_host && !providerDefaults.resolveProviderDefaults(provider)) {
    return { success: false, error: `缺少 ${email} 的发信服务器，请加 --smtp-host`, error_code: "invalid_argument", provider, guide };
  }
  return { success: true, provider, guide, input };
}

function printGuide(email, guide) {
  prompt.say("");
  prompt.say(`${email} 是${guide.label}，需要一个「${guide.needs}」（不是平时登录用的密码）：`);
  if (guide.url) prompt.say(`  打开：${guide.url}`);
  guide.steps.forEach((s, i) => prompt.say(`  ${i + 1}. ${s}`));
  prompt.say("");
}

function _withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// A person-readable reason an IMAP/SMTP check failed, plus an error_code.
function explainFailure(e, kind) {
  const raw = String((e && (e.responseText || e.response || e.message)) || e || "").trim();
  const code = e && e.code;
  if ((e && e.authenticationFailed) || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authenticat|password|535[\s-]|auth/i.test(raw)) {
    return { error: `${kind} 登录失败：授权码不对，或者邮箱还没开启 IMAP/SMTP 服务（${raw}）`, error_code: "auth_failed" };
  }
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(raw)) {
    return { error: `${kind} 找不到服务器，请检查服务器地址（${raw}）`, error_code: "network_error" };
  }
  if (code === "ETIMEDOUT" || /ETIMEDOUT|timed out|ECONNREFUSED|ECONNRESET/i.test(raw)) {
    return { error: `${kind} 连接不上服务器（网络或端口不通）：${raw}`, error_code: "network_error" };
  }
  return { error: `${kind} 连接失败：${raw || "unknown error"}`, error_code: "operation_failed" };
}

// Check the credentials against both servers. In MAILBOX_INTERNAL_TEST_MODE
// nothing is contacted and both succeed, unless MAILBOX_TEST_ACCOUNT_CHECK_FAIL
// names "imap" or "smtp" (lets contract tests cover the failure paths).
async function checkAccount(entry) {
  const core = _core();
  const conn = core.providerDefaults.resolveAccountConnectionConfig(entry);
  const account = { id: entry.id || "", email: entry.email, password: entry.password, provider: conn.provider, imap: conn.imap, smtp: conn.smtp };
  const out = { imap: { success: false }, smtp: { success: false } };

  if (String(process.env.MAILBOX_INTERNAL_TEST_MODE || "").trim() === "1") {
    const fail = String(process.env.MAILBOX_TEST_ACCOUNT_CHECK_FAIL || "").trim();
    out.imap = fail === "imap" ? { success: false, ...explainFailure({ authenticationFailed: true, message: "AUTHENTICATIONFAILED" }, "IMAP") } : { success: true };
    out.smtp = fail === "smtp" ? { success: false, ...explainFailure({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" }, "SMTP") } : { success: true };
    return out;
  }

  try {
    const r = await _withTimeout(core.imap.testConnection(account, "INBOX"), CHECK_TIMEOUT_MS, "IMAP");
    out.imap = r && r.success ? { success: true } : { success: false, ...explainFailure(r && r.error, "IMAP") };
  } catch (e) {
    out.imap = { success: false, ...explainFailure(e, "IMAP") };
  }
  if (!out.imap.success) return out;
  try {
    const r = await _withTimeout(core.smtp.testConnection(account), CHECK_TIMEOUT_MS, "SMTP");
    out.smtp = r && r.success ? { success: true } : { success: false, ...explainFailure(r && r.error, "SMTP") };
  } catch (e) {
    out.smtp = { success: false, ...explainFailure(e, "SMTP") };
  }
  return out;
}

// Where the secret comes from, in order: --password-stdin, MAIL_USE_PASSWORD,
// a hidden prompt on a terminal. null means none is available (the caller
// reports what the person still has to do instead of blocking).
async function obtainSecret({ passwordStdin, allowEnv = true, interactive }) {
  if (passwordStdin) return prompt.readStdin();
  if (allowEnv && process.env.MAIL_USE_PASSWORD) return process.env.MAIL_USE_PASSWORD;
  if (interactive) return prompt.promptHidden("粘贴授权码（输入时不会显示，粘贴后按回车；直接回车跳过）：");
  return null;
}

// Check (unless test is false) and save. IMAP must work; an SMTP failure still
// saves, with a warning, because reading mail is useful on its own and SMTP
// is often blocked by the local network rather than wrong.
//
// -> { success, account?, checked?, warnings, error?, error_code? }; never
// contains the secret.
async function checkAndSave(input, secret, { test = true, force = false, description = "" } = {}) {
  const { accounts } = _core();
  const password = normalizeSecret(secret, input.provider);
  if (!password) return { success: false, error: "授权码是空的", error_code: "invalid_argument", warnings: [] };
  const entry = { ...input, password, ...(description ? { description } : {}) };
  const warnings = [];
  let checked = null;
  if (test) {
    checked = await checkAccount(entry);
    if (!checked.imap.success) {
      return { success: false, error: checked.imap.error, error_code: checked.imap.error_code || "auth_failed", checked: _publicCheck(checked), warnings };
    }
    if (!checked.smtp.success) warnings.push(`收信正常，但发信测试失败，先保存了；之后可以用 mail-use account test-connection 再试。${checked.smtp.error || ""}`);
  }
  const saved = accounts.saveAccount(entry, { force });
  if (!saved.success) return { ...saved, warnings };
  return { success: true, account: saved.account, replaced: saved.replaced, is_default: saved.is_default, checked: checked ? _publicCheck(checked) : null, warnings };
}

function _publicCheck(c) {
  const pick = (x) => ({ success: Boolean(x.success), ...(x.error ? { error: x.error } : {}) });
  return { imap: pick(c.imap), smtp: pick(c.smtp) };
}

module.exports = { planAccount, printGuide, checkAccount, checkAndSave, obtainSecret, normalizeSecret, explainFailure };
