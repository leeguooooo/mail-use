const fs = require("fs");

const { paths } = require("@mail-use/shared");
const { email } = require("@mail-use/core");

function _readJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function getConfig() {
  const pc = paths.getPathConfig();
  const cfg = _readJson(pc.dailyDigestConfigJson) || {};
  return { success: true, config: cfg };
}

async function run({ dry_run = false, debug_path = "" } = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const list = await email.listEmails({ limit: 200, offset: 0, unread_only: false, folder: "INBOX", use_cache: false });
  const emails = list.emails || [];

  const categories = {};
  for (const e of emails) {
    const key = e.account_id || "unknown";
    categories[key] = (categories[key] || 0) + 1;
  }

  const important_emails = emails.filter((e) => e.unread).length;
  const summary = `Digest: ${emails.length} emails across ${Object.keys(categories).length} account(s).`;

  let debug_log = "";
  if (debug_path) {
    try {
      fs.writeFileSync(debug_path, JSON.stringify({ emails }, null, 2) + "\n", "utf8");
      debug_log = debug_path;
    } catch {
      debug_log = "";
    }
  }

  return {
    success: true,
    date,
    total_emails: emails.length,
    displayed: emails.length,
    total_found: emails.length,
    important_emails,
    categories,
    truncated: false,
    summary,
    missing_details: 0,
    dry_run: Boolean(dry_run),
    debug_log,
    lark_payload: {},
    telegram_message: "",
    telegram_parse_mode: "HTML",
    telegram_session_id: "",
    notification: {},
    notifications: { lark: {}, telegram: {} },
  };
}

module.exports = {
  getConfig,
  run,
};
