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

// An auth.json key for a new account: "<local-part>_<provider>", lowercased
// and limited to [a-z0-9_] so it is safe to type as --account-id, with a
// numeric suffix when taken.
function _deriveAccountId(email, provider, taken) {
  const local = String(email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "account";
  const prov = String(provider || "custom").toLowerCase().replace(/[^a-z0-9]+/g, "_") || "custom";
  const base = `${local}_${prov}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  }
}

function _portOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : NaN;
}

// Add one account to auth.json, keeping every other account as it is.
//
// input: { email, password, provider?, id?, imap_host?, imap_port?,
// smtp_host?, smtp_port?, imap_secure?, smtp_secure?, description? }.
// Server fields are stored only when given: for a known provider leaving them
// out lets provider_defaults.js stay the source of truth.
//
// An existing account with the same email (or the same explicit id) is an
// error unless opts.force, which replaces it in place under its old id.
// The result never contains the password.
function saveAccount(input, opts = {}) {
  const email = String((input && input.email) || "").trim();
  const password = input && input.password != null ? String(input.password) : "";
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return { success: false, error: `Invalid email address: ${email}`, error_code: "invalid_argument" };
  if (!password) return { success: false, error: "Missing password", error_code: "invalid_argument" };
  const provider = String((input && input.provider) || "custom").trim().toLowerCase() || "custom";

  const imapPort = _portOrNull(input.imap_port);
  const smtpPort = _portOrNull(input.smtp_port);
  if (Number.isNaN(imapPort) || Number.isNaN(smtpPort)) return { success: false, error: "Invalid port", error_code: "invalid_argument" };

  const loaded = loadAuth();
  if (!loaded.success) return loaded;
  const auth = loaded.auth;

  const lower = email.toLowerCase();
  const wantedId = String((input && input.id) || "").trim();
  let existingId = "";
  for (const [id, acc] of Object.entries(auth.accounts)) {
    const sameEmail = acc && typeof acc === "object" && String(acc.email || "").toLowerCase() === lower;
    if (sameEmail || (wantedId && id === wantedId)) { existingId = id; break; }
  }
  if (existingId && !opts.force) {
    return { success: false, error: `Account already exists: ${existingId} (${email})`, error_code: "already_exists", id: existingId };
  }

  const taken = new Set(Object.keys(auth.accounts));
  const id = existingId || wantedId || _deriveAccountId(email, provider, taken);

  const entry = { email, password, provider };
  if (input.imap_host) {
    entry.imap_host = String(input.imap_host).trim();
    entry.imap_port = imapPort || 993;
    // Port 993 is implicit TLS; anything else is STARTTLS, which the IMAP
    // client requires (never plaintext), so false here is still encrypted.
    entry.imap_secure = input.imap_secure != null ? Boolean(input.imap_secure) : entry.imap_port === 993;
  } else if (imapPort) {
    entry.imap_port = imapPort;
  }
  if (input.smtp_host) {
    entry.smtp_host = String(input.smtp_host).trim();
    entry.smtp_port = smtpPort || 465;
    entry.smtp_secure = input.smtp_secure != null ? Boolean(input.smtp_secure) : entry.smtp_port === 465;
  } else if (smtpPort) {
    entry.smtp_port = smtpPort;
    entry.smtp_secure = smtpPort === 465;
  }
  if (input.description) entry.description = String(input.description);

  if (existingId && existingId !== id) delete auth.accounts[existingId];
  auth.accounts[id] = entry;
  const def = auth.default_account || auth.defaultAccount || "";
  if (!def || !auth.accounts[def]) auth.default_account = id;

  _writeJsonFile(paths.getPathConfig().authJson, auth);

  const conn = resolveAccountConnectionConfig(entry);
  return {
    success: true,
    replaced: Boolean(existingId),
    is_default: auth.default_account === id,
    account: { id, email, provider, imap_host: conn.imap.host, smtp_host: conn.smtp.host },
  };
}

module.exports = {
  saveAccount,
  loadAuth,
  listAccounts,
  getAccountByIdOrEmail,
  getAllAccountsResolved,
};
