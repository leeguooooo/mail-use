// Self-upgrade from GitHub Releases.
//
// Distribution is a single prebuilt binary attached to a GitHub Release (there
// is no npm package and no package manager to lean on), so without this the only
// way to move versions is to remember the installer URL and re-run it — and
// nothing ever tells you a new version exists.
//
// Deliberately NOT automatic: a tool that silently replaces its own executable
// is a supply-chain surprise, not a convenience. `upgrade --check` reports, and
// `upgrade` acts only when asked.

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const net = require("net");
const path = require("path");
const { execFileSync } = require("child_process");
const { isPackagedBinary } = require("./packaged");

const REPO = process.env.MAILBOX_UPGRADE_REPO || "leeguooooo/mail-use";

// Which release asset this machine needs. Mirrors install.sh; kept in sync by
// the test that asserts both name the same set of targets.
function assetTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && (arch === "arm64" || arch === "aarch64")) return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64-gnu";
  if (platform === "linux" && arch === "arm64") return "linux-arm64-gnu";
  return null;
}

// Compare dotted numeric versions, ignoring a leading "v" and any prerelease
// suffix. Returns >0 when a is newer, <0 when older, 0 when equal.
function compareVersions(a, b) {
  const norm = (v) =>
    String(v || "")
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => Number(n) || 0);
  const x = norm(a);
  const y = norm(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Request headers. GITHUB_TOKEN, when set, only goes to api.github.com: it lifts
// the 60-requests-an-hour unauthenticated limit for the release lookup, and must
// not follow a download redirect to a CDN host.
function _headers(url, json, env = process.env) {
  const headers = { "User-Agent": "mail-use-upgrade", Accept: json ? "application/vnd.github+json" : "*/*" };
  const token = String(env.GITHUB_TOKEN || "").trim();
  let host = "";
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  if (token && host === "api.github.com") headers.Authorization = `Bearer ${token}`;
  return headers;
}

function _get(url, { json = false, binary = false, redirects = 5, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const req = https.get(
      url,
      { headers: _headers(url, json) },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects <= 0) {
            reject(new Error("too many redirects"));
            return;
          }
          res.resume();
          clearTimeout(timer);
          resolve(_get(res.headers.location, { json, binary, redirects: redirects - 1, timeoutMs }));
          return;
        }
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const buf = Buffer.concat(chunks);
          if (binary) {
            resolve(buf);
            return;
          }
          const text = buf.toString("utf8");
          if (!json) {
            resolve(text);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`bad JSON from ${url}: ${e.message}`));
          }
        });
      }
    );
    // A hard deadline for the whole response, not an idle timeout: the daily
    // notice promises to cost at most `timeoutMs`, and a slow trickle must not
    // stretch that.
    timer = setTimeout(() => req.destroy(new Error(`timeout fetching ${url}`)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

const NAME = "mail-use";

// "v3.3.2" -> "3.3.2". Tags carry the v; the family convention reports bare
// versions so `current` and `latest` compare by eye.
function bareVersion(v) {
  return String(v || "").trim().replace(/^v/i, "");
}

// /releases/latest already skips drafts and prereleases.
async function latestRelease({ timeoutMs } = {}) {
  const rel = await _get(`https://api.github.com/repos/${REPO}/releases/latest`, { json: true, timeoutMs });
  return { tag: String(rel.tag_name || ""), url: String(rel.html_url || ""), published_at: rel.published_at || "" };
}

async function checkForUpdate(currentVersion, { fetchLatest = latestRelease, timeoutMs } = {}) {
  const latest = await fetchLatest({ timeoutMs });
  const cmp = compareVersions(latest.tag, currentVersion);
  return {
    name: NAME,
    current: bareVersion(currentVersion),
    latest: bareVersion(latest.tag),
    tag: latest.tag,
    update_available: cmp > 0,
    release_url: latest.url,
    published_at: latest.published_at,
  };
}

// Where the running executable lives. In the release binary process.execPath IS
// the binary; in a dev checkout it's node, and self-replacing would clobber node.
function resolveInstalledBinary() {
  if (!isPackagedBinary()) return { path: "", packaged: false };
  return { path: process.execPath, packaged: true };
}

const INSTALL_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;

function _realOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Nearest directory at or above `dir` that holds a .git entry. Read-only file
// checks, no git subprocess: this runs on every `upgrade`, including --check.
function _gitRootAbove(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return "";
    cur = up;
  }
}

// How this copy of mail-use was installed, and so who may replace it.
//
//   release  the release binary from a GitHub Release (install.sh / `upgrade`) —
//            the only channel `upgrade` rewrites
//   brew     a binary under a Homebrew Cellar/prefix: brew owns that file
//   npm      the JS entry run by node from a node_modules tree (npm -g, npx)
//   source   the JS entry run by node from a git checkout
//   unknown  node running the entry from anywhere else
//
// Everything but `release` is refused with the manager's own command: an
// upgrade that overwrote a brew- or npm-owned file would be undone (or worse,
// half-undone) by that manager's next run.
function detectInstallChannel({
  packaged = isPackagedBinary(),
  execPath = process.execPath,
  entry = process.argv[1] || "",
} = {}) {
  if (packaged) {
    const bin = _realOr(execPath);
    if (/\/Cellar\//.test(bin) || /^\/(opt\/homebrew|home\/linuxbrew\/\.linuxbrew)\//.test(bin)) {
      return { channel: "brew", path: bin, upgradable: false, hint: "installed with Homebrew; run: brew upgrade mail-use" };
    }
    return { channel: "release", path: bin, upgradable: true, hint: "" };
  }
  const script = entry ? _realOr(entry) : "";
  if (script && script.split(path.sep).includes("node_modules")) {
    return {
      channel: "npm",
      path: script,
      upgradable: false,
      hint: `running from an npm install; update it with npm, or switch to the release binary: curl -fsSL ${INSTALL_URL} | sh`,
    };
  }
  const root = script ? _gitRootAbove(path.dirname(script)) : "";
  if (root) {
    return {
      channel: "source",
      path: root,
      upgradable: false,
      hint: `running from a source checkout; run: git -C ${root} pull --ff-only && pnpm -C ${root} install`,
    };
  }
  return {
    channel: "unknown",
    path: script || execPath,
    upgradable: false,
    hint: `not a release binary; install one with: curl -fsSL ${INSTALL_URL} | sh`,
  };
}

// Environment for running a downloaded binary from inside this one.
// Historical: pkg-built binaries (before the Node SEA switch) mark their process
// with PKG_* variables, and a child that inherits them stops acting as the CLI
// (it treats argv as a script to run). The running binary may still be one of
// those, so they keep being stripped.
function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("PKG_")) out[k] = v;
  }
  // The version override would make any binary "pass" the check below.
  delete out.MAILBOX_CLI_VERSION;
  delete out.MAILBOX_VERSION;
  return out;
}

// The extracted binary must run and report the version we meant to install
// before it is allowed anywhere near the installed path.
function verifyBinary(file, wantTag) {
  let out = "";
  try {
    out = execFileSync(file, ["--version"], {
      env: { ...childEnv(), MAIL_USE_NO_UPDATE_CHECK: "1", MAILBOX_NO_DAEMON: "1" },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { ok: false, error: `downloaded binary does not run (${(e && e.message ? e.message : String(e)).split("\n")[0]})` };
  }
  const got = bareVersion(out.trim().split(/\s+/).pop());
  // Exact match: compareVersions drops "-rc1"-style suffixes, which must not
  // let a prerelease binary pass for the release it was asked to install.
  if (got !== bareVersion(wantTag)) {
    return { ok: false, error: `downloaded binary reports ${got || "no version"}, expected ${bareVersion(wantTag)}` };
  }
  return { ok: true, version: got };
}

// Does a daemon answer right now?
//
// This connects to the daemon's Unix socket directly instead of shelling out to
// `<binary> daemon status`. Historical: spawning ourselves did not work from
// the old pkg binary — pkg put PKG_EXECPATH into the environment, the child
// inherited it and stopped behaving like the CLI, so the probe always failed.
// Seen live on 3.3.1 — the daemon was demonstrably up (pid 79961) and
// `was_running` still came back false. A socket connect is cheaper anyway.
function daemonResponds() {
  const { getSocketPath } = require("./daemon_paths");
  const sockPath = getSocketPath();
  if (!fs.existsSync(sockPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const c = net.createConnection(sockPath);
    // A successful connect is enough: only a live daemon binds this path, and a
    // stale socket file refuses the connection.
    c.once("connect", () => { try { c.end(); } catch { /* ignore */ } done(true); });
    c.once("error", () => done(false));
    setTimeout(() => { try { c.destroy(); } catch { /* ignore */ } done(false); }, 1000);
  });
}

// Release tags are vX.Y.Z (optionally -prerelease). Anything else would be
// spliced into a download URL, so it is rejected before any request is made.
const TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isValidTag(tag) {
  return TAG_RE.test(String(tag || ""));
}

function normalizeTag(tag) {
  const t = String(tag || "").trim();
  return t.startsWith("v") ? t : `v${t}`;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Installs a release over the running binary. Every failure before the final
// rename leaves the installed binary exactly as it was.
//
// `deps` exists for tests: the http getter, the install channel, the binary
// check, the daemon probe and the daemon restart can be swapped so the whole
// path runs offline against a temp directory.
//
// `insecure` lets a release with no published checksum through (with a
// warning). It never lets a checksum *mismatch* through.
async function performUpgrade({ currentVersion, targetTag = "", insecure = false, log = () => {}, deps = {} } = {}) {
  const get = deps.get || _get;
  const channel = deps.channel || detectInstallChannel();
  const verify = deps.verifyBinary || verifyBinary;
  const probeDaemon = deps.daemonResponds || daemonResponds;
  const restart = deps.restartDaemon || ((opts) => require("./daemon").restartDaemon(opts));
  const target = deps.target !== undefined ? deps.target : assetTarget();
  if (!target) {
    return { success: false, error: `unsupported platform: ${process.platform} ${process.arch}`, error_code: "invalid_argument" };
  }
  if (targetTag && !isValidTag(targetTag)) {
    return { success: false, error: `Invalid tag "${targetTag}" (expected vX.Y.Z)`, error_code: "invalid_argument" };
  }
  if (targetTag) targetTag = normalizeTag(targetTag);
  if (!channel.upgradable) {
    // Refused, not failed: nothing was downloaded or touched, and the manager
    // that owns this install has its own command.
    return {
      success: false,
      refused: true,
      error: channel.hint,
      error_code: "operation_failed",
      install_channel: channel,
    };
  }

  const info = targetTag
    ? { tag: targetTag, url: `https://github.com/${REPO}/releases/tag/${targetTag}`, published_at: "" }
    : await (deps.latestRelease || latestRelease)();
  if (!targetTag && compareVersions(info.tag, currentVersion) <= 0) {
    return { success: true, upgraded: false, current: currentVersion, latest: info.tag, message: "already up to date", install_channel: channel };
  }
  if (!isValidTag(info.tag)) {
    return { success: false, error: `latest release has an unexpected tag "${info.tag}"`, error_code: "operation_failed" };
  }

  const base = `https://github.com/${REPO}/releases/download/${info.tag}`;
  const assetName = `mail-use-${target}.tar.gz`;
  log(`downloading ${info.tag} (${assetName})`);
  const tarball = await get(`${base}/${assetName}`, { binary: true });

  // The published checksum is required. A release without one, or bytes that
  // do not match it, are refused rather than installed. --insecure only waives
  // the "no checksum published" case.
  let sums;
  let checksumState = "verified";
  try {
    sums = await get(`${base}/${assetName}.sha256`);
  } catch (e) {
    if (!insecure) {
      return {
        success: false,
        error: `no checksum for ${assetName} (${(e && e.message) || e}); refusing to install unverified bytes (override with --insecure)`,
        error_code: "operation_failed",
      };
    }
    checksumState = "missing";
    log("WARNING: no checksum published; installing unverified bytes (--insecure)");
  }
  if (checksumState === "verified") {
    const expected = String(sums || "").trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      return { success: false, error: `invalid checksum file for ${assetName}`, error_code: "operation_failed" };
    }
    const actual = sha256(tarball);
    if (expected !== actual) {
      return {
        success: false,
        error: `checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`,
        error_code: "operation_failed",
      };
    }
    log("checksum ok");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-upgrade-"));
  const dest = channel.path;
  const staged = path.join(path.dirname(dest), `.mail-use.upgrade.${process.pid}`);
  try {
    const tarPath = path.join(tmp, assetName);
    fs.writeFileSync(tarPath, tarball);
    execFileSync("tar", ["-xzf", tarPath, "-C", tmp], { stdio: "ignore" });
    let extracted = path.join(tmp, "mail-use");
    if (!fs.existsSync(extracted)) {
      const legacy = path.join(tmp, "mailbox"); // pre-rename archives
      if (fs.existsSync(legacy)) extracted = legacy;
      else return { success: false, error: "archive did not contain a mail-use binary", error_code: "operation_failed" };
    }
    if (fs.lstatSync(extracted).isSymbolicLink() || !fs.statSync(extracted).isFile()) {
      return { success: false, error: "archive's mail-use is not a regular file", error_code: "operation_failed" };
    }
    fs.chmodSync(extracted, 0o755);

    const v = verify(extracted, info.tag);
    if (!v.ok) return { success: false, error: v.error, error_code: "operation_failed" };
    log(`verified ${bareVersion(info.tag)}`);

    // Stage in the destination directory, then rename over it: rename is
    // atomic, so the path holds either the old binary or the whole new one.
    // On POSIX replacing a running executable's path is legal — the old inode
    // lives on for already-running processes (notably the daemon, restarted
    // below).
    try {
      fs.copyFileSync(extracted, staged);
      fs.chmodSync(staged, 0o755);
      fs.renameSync(staged, dest);
    } catch (e) {
      try { fs.rmSync(staged, { force: true }); } catch { /* ignore */ }
      return {
        success: false,
        error: `could not replace ${dest} (${(e && e.message) || e}); the installed binary is unchanged`,
        error_code: "operation_failed",
      };
    }
    log(`installed ${info.tag} to ${dest}`);

    // The daemon is still running the previous binary from its open inode, so
    // an upgrade that skips this leaves the old code serving every call.
    //
    // Probe and restart are reported separately on purpose. Folding them into one
    // try meant any failure — including a probe that raced the restart — came back
    // as "not_running", which told the user the daemon was down when it was up and
    // that nothing was restarted when it had been.
    //
    // restartDaemon goes through launchd/systemd when they own the daemon
    // (kickstart -k / systemctl restart) and judges success by the pid
    // changing — a restart that leaves the old process answering has not
    // happened. A hand-started daemon is stopped and reported as such rather
    // than having a LaunchAgent installed behind the user's back (which is
    // what re-running the unit install used to do, along with resetting a custom
    // --sync-interval to 300). In-process: it only shells out to
    // launchctl/systemctl, never to the binary we just replaced.
    const daemon = { was_running: false, restarted: false, method: "", old_pid: null, new_pid: null, error: null };
    daemon.was_running = await probeDaemon();
    if (daemon.was_running) {
      try {
        const r = (await restart({})) || {};
        daemon.restarted = Boolean(r.restarted);
        daemon.method = r.method || "";
        daemon.old_pid = r.old_pid != null ? r.old_pid : null;
        daemon.new_pid = r.new_pid != null ? r.new_pid : null;
        if (!r.success) daemon.error = r.error || "restart failed";
        if (r.hint) daemon.hint = r.hint;
      } catch (e) {
        daemon.error = (e && e.message) || String(e);
      }
    }

    return {
      success: true,
      upgraded: true,
      from: String(currentVersion || ""),
      to: info.tag,
      binary: dest,
      checksum: checksumState,
      install_channel: channel,
      daemon,
      release_url: info.url,
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  NAME,
  INSTALL_URL,
  assetTarget,
  bareVersion,
  childEnv,
  compareVersions,
  checkForUpdate,
  detectInstallChannel,
  isValidTag,
  normalizeTag,
  latestRelease,
  performUpgrade,
  resolveInstalledBinary,
  sha256,
  verifyBinary,
  _headers,
};
