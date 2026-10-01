// Build an Apple configuration profile (.mobileconfig) that adds mail-use's
// accounts to Apple Mail (macOS, iOS, iPadOS) with the same IMAP/SMTP settings
// mail-use itself uses — no server names, ports or passwords to type in.
//
// One profile holds every selected account under a fixed identifier, so
// installing it again replaces the earlier one instead of duplicating
// accounts in Mail.

const crypto = require("crypto");

const PROFILE_IDENTIFIER = "com.leeguoo.mail-use.accounts";

const PROVIDER_LABELS = {
  gmail: "Gmail",
  qq: "QQ 邮箱",
  "163": "163 邮箱",
  "126": "126 邮箱",
  outlook: "Outlook",
  icloud: "iCloud 邮箱",
};

function _xml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Stable UUID from a name: the same account always gets the same payload UUID.
function _uuidFor(name) {
  const h = crypto.createHash("sha256").update(name).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), `4${h.slice(13, 16)}`, `8${h.slice(17, 20)}`, h.slice(20, 32)].join("-").toUpperCase();
}

function _str(key, value) {
  return `      <key>${key}</key><string>${_xml(value)}</string>`;
}
function _int(key, value) {
  return `      <key>${key}</key><integer>${Number(value)}</integer>`;
}
function _bool(key, value) {
  return `      <key>${key}</key><${value ? "true" : "false"}/>`;
}

// Why an account can't go into the profile, or "" when it can.
function unsupportedReason(account) {
  if (!account || !account.email) return "missing email address";
  if (!account.password) return "missing password";
  if (!account.imap || !account.imap.host) return "missing IMAP server";
  if (!account.smtp || !account.smtp.host) return "missing SMTP server";
  return "";
}

function _accountPayload(a) {
  const identifier = `${PROFILE_IDENTIFIER}.${a.id}`;
  // The name shown in Mail's sidebar. auth.json descriptions are notes for
  // mail-use ("从环境变量导入"), not mailbox names, so they are not used here.
  const label = `${PROVIDER_LABELS[String(a.provider || "").toLowerCase()] || "邮箱"} (${a.email})`;
  return [
    "    <dict>",
    _str("PayloadType", "com.apple.mail.managed"),
    _int("PayloadVersion", 1),
    _str("PayloadIdentifier", identifier),
    _str("PayloadUUID", _uuidFor(identifier)),
    _str("PayloadDisplayName", a.email),
    _str("EmailAccountType", "EmailTypeIMAP"),
    _str("EmailAccountDescription", label),
    _str("EmailAddress", a.email),
    _str("IncomingMailServerHostName", a.imap.host),
    _int("IncomingMailServerPortNumber", a.imap.port || 993),
    // Always TLS: implicit on 993/465, STARTTLS otherwise. Mail picks the
    // mode from the port; it never falls back to plaintext with this set.
    _bool("IncomingMailServerUseSSL", true),
    _str("IncomingMailServerUsername", a.email),
    _str("IncomingMailServerAuthentication", "EmailAuthPassword"),
    _str("IncomingPassword", a.password),
    _str("OutgoingMailServerHostName", a.smtp.host),
    _int("OutgoingMailServerPortNumber", a.smtp.port || 465),
    _bool("OutgoingMailServerUseSSL", true),
    _str("OutgoingMailServerUsername", a.email),
    _str("OutgoingMailServerAuthentication", "EmailAuthPassword"),
    _str("OutgoingPassword", a.password),
    _bool("OutgoingPasswordSameAsIncomingPassword", true),
    "    </dict>",
  ].join("\n");
}

// accounts: resolved accounts as returned by accounts.getAllAccountsResolved().
// Returns the profile XML. Callers filter with unsupportedReason() first.
function buildMobileconfig(accounts) {
  const list = (accounts || []).filter((a) => !unsupportedReason(a));
  if (!list.length) throw new Error("no account can be added to Apple Mail");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    _str("PayloadType", "Configuration"),
    _int("PayloadVersion", 1),
    _str("PayloadIdentifier", PROFILE_IDENTIFIER),
    _str("PayloadUUID", _uuidFor(PROFILE_IDENTIFIER)),
    _str("PayloadDisplayName", "mail-use 邮箱账号"),
    _str("PayloadOrganization", "mail-use"),
    _str("PayloadDescription", `把 mail-use 里的 ${list.length} 个邮箱账号添加到"邮件"。`),
    _bool("PayloadRemovalDisallowed", false),
    "  <key>PayloadContent</key>",
    "  <array>",
    ...list.map(_accountPayload),
    "  </array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reading Apple Mail's accounts
//
// Apple Mail's scripting dictionary exposes each account's addresses and
// server settings (never its password: that lives with accountsd and "can be
// set, but not read via scripting"). Reading it needs only the one-time
// Automation prompt — no Full Disk Access, unlike ~/Library/Accounts.
//
// The script prints one record per account, fields separated by ASCII unit
// separators, so names with spaces, commas, quotes or Chinese characters
// cannot break the parse. It quits Mail afterwards when it had to launch it,
// so reading leaves the person's desktop as it was.

const US = "\u001f"; // field separator
const RS = "\u001e"; // record separator
const GS = "\u001d"; // separator inside the email-addresses field

const READ_SCRIPT = `
set US to character id 31
set RS to character id 30
set GS to character id 29
set wasRunning to application "Mail" is running
set out to ""
try
  tell application "Mail"
    repeat with vAcct in every account
      set vName to ""
      set vType to ""
      set vUser to ""
      set vEmails to ""
      set vImapHost to ""
      set vImapPort to ""
      set vImapSSL to ""
      set vSmtpHost to ""
      set vSmtpPort to ""
      set vSmtpSSL to ""
      try
        set vName to name of vAcct
      end try
      try
        set vType to (account type of vAcct) as text
      end try
      try
        set vUser to user name of vAcct
      end try
      try
        set AppleScript's text item delimiters to GS
        set vEmails to (email addresses of vAcct) as text
        set AppleScript's text item delimiters to ""
      end try
      try
        set vImapHost to server name of vAcct
      end try
      try
        set vImapPort to (port of vAcct) as text
      end try
      try
        set vImapSSL to (uses ssl of vAcct) as text
      end try
      try
        set vDelivery to delivery account of vAcct
        if vDelivery is not missing value then
          set vSmtpHost to server name of vDelivery
          set vSmtpPort to (port of vDelivery) as text
          set vSmtpSSL to (uses ssl of vDelivery) as text
        end if
      end try
      set out to out & vName & US & vType & US & vUser & US & vEmails & US & vImapHost & US & vImapPort & US & vImapSSL & US & vSmtpHost & US & vSmtpPort & US & vSmtpSSL & RS
    end repeat
  end tell
on error errMsg number errNum
  if not wasRunning then
    try
      tell application "Mail" to quit
    end try
  end if
  error errMsg number errNum
end try
if not wasRunning then
  try
    tell application "Mail" to quit
  end try
end if
return out
`;

const READ_TIMEOUT_MS = 20000;

const PERMISSION_HINT =
  "需要允许终端控制「邮件」：打开「系统设置」→「隐私与安全性」→「自动化」，找到你用的终端（终端 / iTerm / Warp 等），勾选它下面的「邮件」，然后重新运行。";

// Default runner: osascript reading the script from stdin (nothing to escape
// into argv), bounded so a hung Mail cannot hang the CLI.
function _runOsascript(script, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error("osascript timed out"), { timedOut: true, stderr }));
      if (code !== 0) return reject(Object.assign(new Error(stderr.trim() || `osascript exited with ${code}`), { stderr }));
      return resolve(stdout);
    });
    child.stdin.end(script);
  });
}

function _truthy(v) {
  return /^(true|yes|1)$/i.test(String(v || "").trim());
}

function _port(v) {
  const n = Number(String(v || "").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Plain address from "Name <addr>" or "addr".
function _addr(s) {
  const t = String(s || "").trim();
  const m = t.match(/<([^>]+)>/);
  return (m ? m[1] : t).trim();
}

// Account type as the dictionary reports it: "iCloud", "imap", "pop"; older
// systems may print a raw constant, which is normalised as best we can.
function _type(t) {
  const s = String(t || "").trim();
  if (/icloud/i.test(s)) return "iCloud";
  if (/imap/i.test(s)) return "imap";
  if (/pop/i.test(s)) return "pop";
  return s;
}

function parseMailAccountsOutput(stdout) {
  const out = [];
  for (const rec of String(stdout || "").split(RS)) {
    // osascript ends its output with a newline; a record never starts with one.
    const clean = rec.replace(/^\r?\n/, "");
    if (!clean.trim()) continue;
    const [name, type, userName, ems, ih, ip, isl, sh, sp, ssl] = clean.split(US);
    const emails = String(ems || "").split(GS).map(_addr).filter(Boolean);
    out.push({
      name: String(name || "").trim(),
      type: _type(type),
      user_name: String(userName || "").trim(),
      emails,
      imap: { host: String(ih || "").trim(), port: _port(ip), ssl: _truthy(isl) },
      smtp: String(sh || "").trim() ? { host: String(sh).trim(), port: _port(sp), ssl: _truthy(ssl) } : null,
    });
  }
  return out;
}

function _classifyError(e) {
  const msg = String((e && (e.stderr || e.message)) || e || "").trim();
  if (e && e.timedOut) {
    return { success: false, accounts: [], error: "读取「邮件」账号超时（20 秒）。可以先手动打开一次「邮件」再重试。", error_code: "failed" };
  }
  if (/-1743|not authori[sz]ed/i.test(msg)) {
    return { success: false, accounts: [], error: "没有权限读取「邮件」的账号。", error_code: "permission_denied", hint: PERMISSION_HINT };
  }
  return { success: false, accounts: [], error: `读取「邮件」账号失败：${msg || "unknown error"}`, error_code: "failed" };
}

// Test hook: MAILBOX_APPLE_MAIL_ACCOUNTS_JSON names a JSON file holding the
// accounts array (same shape as the result), or an object with
// { error, error_code } to simulate a failure. Keeps tests and CI off the
// real Mail app.
function _readFixture(file) {
  try {
    const data = JSON.parse(require("fs").readFileSync(file, "utf8"));
    if (Array.isArray(data)) {
      return {
        success: true,
        accounts: data.map((a) => ({
          name: a.name || "",
          type: a.type || "imap",
          user_name: a.user_name || "",
          emails: (a.emails || []).map(_addr).filter(Boolean),
          imap: a.imap || { host: "", port: null, ssl: true },
          smtp: a.smtp || null,
        })),
      };
    }
    return { success: false, accounts: [], error: data.error || "fixture error", error_code: data.error_code || "failed", ...(data.hint ? { hint: data.hint } : {}) };
  } catch (e) {
    return { success: false, accounts: [], error: `bad MAILBOX_APPLE_MAIL_ACCOUNTS_JSON: ${e.message}`, error_code: "failed" };
  }
}

// -> { success, accounts: [{ name, type, user_name, emails, imap: {host, port,
// ssl}, smtp: {host, port, ssl} | null }], error?, error_code?, hint? }
async function readMailAccounts({ runOsascript, platform = process.platform } = {}) {
  const fixture = String(process.env.MAILBOX_APPLE_MAIL_ACCOUNTS_JSON || "").trim();
  if (fixture && !runOsascript) return _readFixture(fixture);
  if (platform !== "darwin") {
    return { success: false, accounts: [], error: "Apple Mail is only available on macOS", error_code: "not_macos" };
  }
  const run = runOsascript || _runOsascript;
  try {
    return { success: true, accounts: parseMailAccountsOutput(await run(READ_SCRIPT)) };
  } catch (e) {
    return _classifyError(e);
  }
}

// ---------------------------------------------------------------------------
// Matching mail-use accounts against Apple Mail's

function _isEmailish(s) {
  return /^[^@\s]+@[^@\s]+$/.test(String(s || ""));
}

// Every address a Mail account answers to, lowercased. The user name counts
// too (Gmail/163 accounts often have only that), except on iCloud accounts,
// where it is the Apple ID: an Apple ID like 123@qq.com is not a mailbox in
// that account, and treating it as one would hide the real QQ account.
function addressesOf(mailAccount) {
  const set = new Set();
  for (const e of (mailAccount && mailAccount.emails) || []) if (_isEmailish(e)) set.add(e.toLowerCase());
  if (mailAccount && mailAccount.type !== "iCloud" && _isEmailish(mailAccount.user_name)) set.add(mailAccount.user_name.toLowerCase());
  return set;
}

// The address to show / import for a Mail account.
function primaryAddress(mailAccount) {
  const first = ((mailAccount && mailAccount.emails) || []).find(_isEmailish);
  if (first) return first;
  if (mailAccount && mailAccount.type !== "iCloud" && _isEmailish(mailAccount.user_name)) return mailAccount.user_name;
  return "";
}

// lowercased address -> Mail account
function mailAddressIndex(mailAccounts) {
  const idx = new Map();
  for (const m of mailAccounts || []) for (const a of addressesOf(m)) if (!idx.has(a)) idx.set(a, m);
  return idx;
}

// Split mail-use accounts into those to put in the profile and those Apple
// Mail already has. Installing a profile for an address Mail already holds
// (e.g. Gmail added through Google sign-in) creates a second, duplicate
// account in Mail, so those are left out unless includeExisting.
function partitionForExport(accounts, mailAccounts, { includeExisting = false } = {}) {
  const idx = mailAddressIndex(mailAccounts);
  const toExport = [];
  const existing = [];
  for (const a of accounts || []) {
    const m = idx.get(String(a.email || "").toLowerCase());
    if (m && !includeExisting) existing.push({ id: a.id, email: a.email, apple_mail_account_name: m.name });
    else toExport.push(a);
  }
  return { toExport, existing };
}

// Mail accounts none of whose addresses is configured in mail-use.
function importCandidates(accounts, mailAccounts) {
  const have = new Set((accounts || []).map((a) => String(a.email || "").toLowerCase()).filter(Boolean));
  const candidates = [];
  const already = [];
  for (const m of mailAccounts || []) {
    const email = primaryAddress(m);
    if (!email) continue;
    if ([...addressesOf(m)].some((a) => have.has(a))) already.push({ email, apple_mail_account_name: m.name });
    else candidates.push({ email, mail: m });
  }
  return { candidates, already };
}

// One row per address: every mail-use account, plus each Mail account that
// no mail-use account matches (by any of its addresses).
function buildStatus(accounts, mailAccounts) {
  const idx = mailAddressIndex(mailAccounts);
  const rows = [];
  const matched = new Set();
  for (const a of accounts || []) {
    const m = idx.get(String(a.email || "").toLowerCase());
    if (m) matched.add(m);
    rows.push({ email: a.email, in_mail_use: true, in_apple_mail: Boolean(m), apple_mail_account_name: m ? m.name : "", account_id: a.id });
  }
  for (const m of mailAccounts || []) {
    if (matched.has(m)) continue;
    const email = primaryAddress(m);
    if (!email) continue;
    rows.push({ email, in_mail_use: false, in_apple_mail: true, apple_mail_account_name: m.name });
  }
  const suggestions = [];
  for (const r of rows) {
    r.suggested_command = "";
    if (r.in_mail_use && !r.in_apple_mail) {
      r.suggested_command = `mail-use apple-mail export --account-id ${r.email}`;
      suggestions.push({ email: r.email, action: "export", command: r.suggested_command });
    } else if (!r.in_mail_use && r.in_apple_mail) {
      r.suggested_command = `mail-use apple-mail import --email ${r.email}`;
      suggestions.push({ email: r.email, action: "import", command: r.suggested_command });
    }
  }
  return { accounts: rows, suggestions };
}

module.exports = {
  PROFILE_IDENTIFIER,
  PERMISSION_HINT,
  buildMobileconfig,
  unsupportedReason,
  readMailAccounts,
  parseMailAccountsOutput,
  addressesOf,
  primaryAddress,
  mailAddressIndex,
  partitionForExport,
  importCandidates,
  buildStatus,
  _uuidFor,
  _READ_SCRIPT: READ_SCRIPT,
};
