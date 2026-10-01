const fs = require("fs");
const path = require("path");

const { paths } = require("@mail-use/shared");
const { resolveAccountConnectionConfig } = require("./provider_defaults");

function _readJsonFile(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// auth.json holds plaintext IMAP/SMTP passwords. It must never be readable by
// other users: 0600 on create, and chmod afterwards because writeFileSync's
// mode is ignored when the file already exists.
const AUTH_FILE_MODE = 0o600;

function _writeJsonFile(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: AUTH_FILE_MODE });
  try { fs.chmodSync(p, AUTH_FILE_MODE); } catch { /* ignore */ }
}

// Tighten an auth.json written by an older version (or by hand) with the
// default 0644. Best-effort: a read-only or mode-less filesystem is not an
// error worth failing a command over.
function _tightenAuthFile(p) {
  try {
    const st = fs.statSync(p);
    if ((st.mode & 0o077) !== 0) fs.chmodSync(p, AUTH_FILE_MODE);
  } catch { /* ignore */ }
}

function _normalizeAuth(auth) {
  if (!auth || typeof auth !== "object") return { version: 1, accounts: {} };
  if (!auth.accounts || typeof auth.accounts !== "object") auth.accounts = {};
  if (!auth.version) auth.version = 1;
  return auth;
}

function _hasConfigDirOverride() {
  const raw = String(process.env.MAILBOX_CONFIG_DIR || "").trim();
  return Boolean(raw && raw !== ".");
}

// Only fixed per-user locations. There used to be a `./data/accounts.json`
// candidate resolved against the cwd, which meant running mail-use inside any
// directory that happened to contain such a file would import its credentials
// as this user's accounts.
function _legacyAccountsCandidates() {
  const home = require("os").homedir();
  return [
    path.join(home, ".mcp-email", "accounts.json"),
    path.join(home, ".config", "mcp-email-service", "accounts.json"),
    path.join(home, ".config", "mailbox", "accounts.json"),
    path.join(home, ".local", "share", "mailbox", "accounts.json"),
    path.join(home, ".config", "mailbox", "auth.json"),
  ];
}

function loadAuth() {
  const p = paths.getPathConfig();
  const auth = _readJsonFile(p.authJson);
  if (auth) {
    _tightenAuthFile(p.authJson);
    return { success: true, auth: _normalizeAuth(auth), migrated: false };
  }

  if (_hasConfigDirOverride()) {
    return { success: true, auth: _normalizeAuth(null), migrated: false };
  }

  // Legacy migration: read accounts.json-like content and write auth.json.
  for (const candidate of _legacyAccountsCandidates()) {
    const legacy = _readJsonFile(candidate);
    if (!legacy) continue;
    const migrated = migrateLegacyToAuth(legacy);
    if (!migrated.success) continue;
    _writeJsonFile(p.authJson, migrated.auth);
    return { success: true, auth: migrated.auth, migrated: true, source: candidate };
  }

  return { success: true, auth: _normalizeAuth(null), migrated: false };
}

function migrateLegacyToAuth(legacy) {
  // Legacy formats observed:
  // - {"accounts": {"id": {...}} , "default_account": "id"}
  // - direct accounts map
  let accountsObj = legacy;
  let defaultId = "";

  if (legacy && typeof legacy === "object" && legacy.accounts && typeof legacy.accounts === "object") {
    accountsObj = legacy.accounts;
    defaultId = legacy.default_account || legacy.defaultAccount || "";
  }

  if (!accountsObj || typeof accountsObj !== "object") return { success: false, error: "Invalid legacy accounts format" };

  const out = { version: 1, accounts: {}, default_account: defaultId || "" };
  for (const [id, acc] of Object.entries(accountsObj)) {
    if (!acc || typeof acc !== "object") continue;
    out.accounts[id] = acc;
  }
  return { success: true, auth: out };
}

function listAccounts() {
  const loaded = loadAuth();
  if (!loaded.success) return loaded;
  const auth = loaded.auth;
  const accounts = [];
  for (const [id, acc] of Object.entries(auth.accounts || {})) {
    if (!acc || typeof acc !== "object") continue;
    const conn = resolveAccountConnectionConfig(acc);
    accounts.push({
      id,
      email: acc.email,
      provider: acc.provider,
      description: acc.description || "",
      imap_host: conn.imap.host,
      smtp_host: conn.smtp.host,
    });
  }
  return { success: true, accounts, count: accounts.length };
}

function _matchAccountIdOrEmail({ id, acc }, value) {
  const needle = String(value || "").trim().toLowerCase();
  if (!needle) return false;
  if (String(id).toLowerCase() === needle) return true;
  const email = acc && acc.email ? String(acc.email).toLowerCase() : "";
  if (email && email === needle) return true;
  return false;
}

function getAccountByIdOrEmail(accountIdOrEmail) {
  const loaded = loadAuth();
  if (!loaded.success) return loaded;
  const auth = loaded.auth;

  const entries = Object.entries(auth.accounts || {}).map(([id, acc]) => ({ id, acc }));
  let match = null;
  for (const e of entries) {
    if (_matchAccountIdOrEmail(e, accountIdOrEmail)) {
      match = e;
      break;
    }
  }

  // If not provided, fall back to default_account.
  if (!match && !String(accountIdOrEmail || "").trim()) {
    const def = auth.default_account || auth.defaultAccount || "";
    if (def && auth.accounts && auth.accounts[def]) match = { id: def, acc: auth.accounts[def] };
  }

  if (!match) {
    return { success: false, error: `Account not found: ${accountIdOrEmail || ""}` };
  }

  const conn = resolveAccountConnectionConfig(match.acc);
  return {
    success: true,
    account: {
      id: match.id,
      email: match.acc.email,
      provider: match.acc.provider,
      password: match.acc.password,
      description: match.acc.description || "",
      imap: conn.imap,
      smtp: conn.smtp,
      raw: match.acc,
    },
  };
}

function getAllAccountsResolved() {
  const loaded = loadAuth();
  if (!loaded.success) return loaded;
  const auth = loaded.auth;
  const out = [];
  for (const [id, acc] of Object.entries(auth.accounts || {})) {
    if (!acc || typeof acc !== "object") continue;
    const conn = resolveAccountConnectionConfig(acc);
    out.push({
      id,
      email: acc.email,
      provider: acc.provider,
      password: acc.password,
      description: acc.description || "",
      imap: conn.imap,
      smtp: conn.smtp,
      raw: acc,
    });
  }
  return { success: true, accounts: out, count: out.length, auth };
}

module.exports = {
  loadAuth,
  listAccounts,
  getAccountByIdOrEmail,
  getAllAccountsResolved,
};
