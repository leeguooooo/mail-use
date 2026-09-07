const fs = require("fs");
const os = require("os");
const path = require("path");

function _envPath(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return "";
  if (raw.startsWith("~")) return path.join(os.homedir(), raw.slice(1));
  return raw;
}

function _xdgDir(envVar, defaultRelative) {
  const raw = _envPath(envVar);
  if (raw) return raw;
  return path.join(os.homedir(), defaultRelative);
}

function getConfigDir() {
  const override = _envPath("MAILBOX_CONFIG_DIR");
  if (override && override !== ".") return override;
  const configHome = _xdgDir("XDG_CONFIG_HOME", ".config");
  return path.join(configHome, "mailbox");
}

function getDataDir() {
  const override = _envPath("MAILBOX_DATA_DIR");
  if (override && override !== ".") return override;
  const dataHome = _xdgDir("XDG_DATA_HOME", ".local/share");
  return path.join(dataHome, "mailbox");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readConfigToml(configTomlPath) {
  try {
    if (!fs.existsSync(configTomlPath)) return {};
    // Use dynamic require so the shared package stays lightweight.
    const toml = require("toml");
    return toml.parse(fs.readFileSync(configTomlPath, "utf8"));
  } catch {
    return {};
  }
}

function getPathConfig() {
  const configDir = getConfigDir();
  const dataDir = getDataDir();

  ensureDir(configDir);
  ensureDir(dataDir);

  const authJson = path.join(configDir, "auth.json");
  const configToml = path.join(configDir, "config.toml");
  const cfg = readConfigToml(configToml);

  function cfgStr(...keys) {
    let cur = cfg;
    for (const k of keys) {
      if (!cur || typeof cur !== "object" || !(k in cur)) return "";
      cur = cur[k];
    }
    return cur == null ? "" : String(cur);
  }

  function resolvePath(value, defaultAbs) {
    if (!value) return defaultAbs;
    let p = value;
    if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
    if (path.isAbsolute(p)) return p;
    return path.join(dataDir, p);
  }

  const emailSyncDb = resolvePath(cfgStr("storage", "db_path"), path.join(dataDir, "email_sync.db"));
  const notificationHistoryDb = resolvePath(
    cfgStr("storage", "notification_history_db"),
    path.join(dataDir, "notification_history.db")
  );

  const syncConfigJson = resolvePath(cfgStr("paths", "sync_config_json"), path.join(dataDir, "sync_config.json"));
  const syncHealthHistoryJson = resolvePath(
    cfgStr("paths", "sync_health_history_json"),
    path.join(dataDir, "sync_health_history.json")
  );
  const dailyDigestConfigJson = resolvePath(
    cfgStr("paths", "daily_digest_config_json"),
    path.join(dataDir, "daily_digest_config.json")
  );
  const notificationConfigJson = resolvePath(
    cfgStr("paths", "notification_config_json"),
    path.join(dataDir, "notification_config.json")
  );
  const emailMonitorConfigJson = resolvePath(
    cfgStr("paths", "email_monitor_config_json"),
    path.join(dataDir, "email_monitor_config.json")
  );

  const logDir = resolvePath(cfgStr("storage", "log_dir"), path.join(dataDir, "logs"));
  const tempDir = resolvePath(cfgStr("storage", "temp_dir"), path.join(dataDir, "tmp"));
  const attachmentsDir = resolvePath(cfgStr("storage", "attachments_dir"), path.join(dataDir, "attachments"));

  ensureDir(logDir);
  ensureDir(tempDir);
  ensureDir(attachmentsDir);

  return {
    configDir,
    dataDir,
    authJson,
    configToml,
    emailSyncDb,
    notificationHistoryDb,
    syncConfigJson,
    syncHealthHistoryJson,
    dailyDigestConfigJson,
    notificationConfigJson,
    emailMonitorConfigJson,
    logDir,
    tempDir,
    attachmentsDir,
  };
}

module.exports = {
  getConfigDir,
  getDataDir,
  getPathConfig,
};
