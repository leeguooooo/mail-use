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

module.exports = { PROFILE_IDENTIFIER, buildMobileconfig, unsupportedReason, _uuidFor };
