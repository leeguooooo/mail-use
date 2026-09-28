// Once-a-day "a newer mail-use exists" notice, per the *-use family upgrade
// convention (leeguooooo/plugins docs/upgrade.md).
//
// Agents read stderr, so one line there is enough for them to tell the user —
// nobody has to remember that `mail-use upgrade` exists. Rules:
//   - at most one GitHub lookup per 24 h, cached in
//     ${XDG_CACHE_HOME:-~/.cache}/mail-use/update-check.json;
//   - 2 s budget; any failure is silent and still stamps checked_at so an
//     offline machine is not retried on every call;
//   - stderr only — stdout is often JSON another program parses;
//   - off under CI, MAIL_USE_NO_UPDATE_CHECK, USE_NO_UPDATE_CHECK, and for
//     `upgrade`, --version and --help.
// It only ever prints. Installing stays `mail-use upgrade`, run by a person.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { NAME, compareVersions, bareVersion, latestRelease } = require("./upgrade");

const TTL_SECONDS = 24 * 60 * 60;
const TIMEOUT_MS = 2000;
const OPT_OUT_VARS = ["CI", "MAIL_USE_NO_UPDATE_CHECK", "USE_NO_UPDATE_CHECK"];

function _isSet(v) {
  return v != null && String(v).trim() !== "";
}

// Why the check is off, or "" when it may run.
function disabledReason(env = process.env) {
  for (const k of OPT_OUT_VARS) if (_isSet(env[k])) return k;
  // The test suite spawns the CLI hundreds of times; none of that should reach
  // the network or print notices into asserted stderr.
  if (_isSet(env.MAILBOX_INTERNAL_TEST_MODE)) return "MAILBOX_INTERNAL_TEST_MODE";
  // The daemon's existing knob: someone who set it to 0 asked for no update
  // checks, and would not expect a new kind to appear.
  const hours = env.MAILBOX_UPDATE_CHECK_HOURS;
  if (_isSet(hours) && !(Number(hours) > 0)) return "MAILBOX_UPDATE_CHECK_HOURS";
  return "";
}

// argv is the post-global-flag argv (no --json/--pretty). Returns the reason to
// skip, or "".
function skippedForArgv(argv = []) {
  if (argv.some((a) => a === "--version" || a === "-v" || a === "--help" || a === "-h")) return "version/help";
  const positional = argv.filter((a) => !String(a).startsWith("-"));
  const [first, second] = positional;
  if (!first) return "no command";
  if (first === "upgrade") return "upgrade";
  if (first === "help") return "version/help";
  // Long-running processes nobody reads stderr from interactively. The daemon
  // already runs its own passive check (MAILBOX_UPDATE_CHECK_HOURS).
  if (first === "daemon" && second === "run") return "daemon run";
  if (first === "mcp" && second === "serve") return "mcp serve";
  return "";
}

function cachePath({ env = process.env, home = os.homedir() } = {}) {
  const base = _isSet(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(home, ".cache");
  return path.join(base, NAME, "update-check.json");
}

function readCache(p) {
  try {
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!c || typeof c !== "object" || !Number.isFinite(Number(c.checked_at))) return null;
    return { checked_at: Number(c.checked_at), latest: bareVersion(c.latest) };
  } catch {
    return null;
  }
}

function writeCache(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data) + "\n", "utf8");
    fs.renameSync(tmp, p);
  } catch {
    // A read-only cache dir must not break the command it rode along with.
  }
}

// A cache stamped in the future (clock moved back) counts as stale, or it could
// suppress checks for arbitrarily long.
function isFresh(cache, nowSec) {
  return Boolean(cache) && cache.checked_at <= nowSec && nowSec - cache.checked_at < TTL_SECONDS;
}

function noticeLine(latest, current) {
  return `${NAME} ${latest} is available (you have ${current}). Upgrade: ${NAME} upgrade\n`;
}

// Everything injectable so tests never touch the network, the clock or ~.
async function maybeNotify({
  argv = [],
  currentVersion,
  env = process.env,
  home = os.homedir(),
  now = Date.now(),
  fetchLatest = latestRelease,
  writeErr = (s) => process.stderr.write(s),
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const off = disabledReason(env) || skippedForArgv(argv);
  if (off) return { skipped: off };

  const current = bareVersion(currentVersion);
  const p = cachePath({ env, home });
  const nowSec = Math.floor(now / 1000);
  let cache = readCache(p);
  let checked = false;

  if (!isFresh(cache, nowSec)) {
    let latest = cache ? cache.latest : "";
    try {
      const rel = await _withDeadline(fetchLatest({ timeoutMs }), timeoutMs);
      latest = bareVersion(rel && rel.tag);
    } catch {
      // Offline, rate-limited, timed out: keep what we knew, stamp the time.
    }
    cache = { checked_at: nowSec, latest };
    writeCache(p, cache);
    checked = true;
  }

  const latest = cache.latest;
  const newer = Boolean(latest) && Boolean(current) && compareVersions(latest, current) > 0;
  if (newer) writeErr(noticeLine(latest, current));
  return { skipped: "", checked, latest, current, notified: newer, cache_path: p };
}

// Belt and braces on top of the request's own deadline: an injected or
// misbehaving fetch still cannot hold the command past the budget.
function _withDeadline(promise, ms) {
  let t;
  const deadline = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error("update check timed out")), ms);
    if (typeof t.unref === "function") t.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(t));
}

module.exports = {
  TTL_SECONDS,
  TIMEOUT_MS,
  cachePath,
  disabledReason,
  isFresh,
  maybeNotify,
  noticeLine,
  readCache,
  skippedForArgv,
};
