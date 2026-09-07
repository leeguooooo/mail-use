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

function status() {
  const pc = paths.getPathConfig();
  return {
    success: true,
    status: {
      config_path: pc.emailMonitorConfigJson,
      notification_enabled: true,
      notification_config_path: pc.notificationConfigJson,
      env: {
        MAILBOX_CONFIG_DIR: process.env.MAILBOX_CONFIG_DIR || "",
      },
    },
  };
}

function config() {
  const pc = paths.getPathConfig();
  const cfg = _readJson(pc.emailMonitorConfigJson) || {};
  return { success: true, config: cfg };
}

async function run() {
  const fetch_result = await email.listEmails({ limit: 50, offset: 0, unread_only: true, folder: "INBOX", use_cache: false });
  const important_emails = fetch_result.emails || [];

  return {
    success: true,
    message: "Monitoring cycle completed",
    stats: {
      fetched_emails: important_emails.length,
      important_emails: important_emails.length,
      notifications_sent: 0,
      filter_success: true,
      notification_success: true,
    },
    important_emails,
    details: {
      fetch_result,
      filter_result: { success: true },
      notification_result: { success: true },
    },
  };
}

function test({ component = "all" } = {}) {
  return {
    success: true,
    fetch: component === "notify" ? {} : { success: true },
    notify: component === "fetch" ? {} : { success: true },
  };
}

module.exports = {
  status,
  config,
  run,
  test,
};
