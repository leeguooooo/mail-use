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
const path = require("path");
const { execFileSync } = require("child_process");

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

function _get(url, { json = false, binary = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "mail-use-upgrade", Accept: json ? "application/vnd.github+json" : "*/*" } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects <= 0) {
            reject(new Error("too many redirects"));
            return;
          }
          res.resume();
          resolve(_get(res.headers.location, { json, binary, redirects: redirects - 1 }));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
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
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on("error", reject);
  });
}

async function latestRelease() {
  const rel = await _get(`https://api.github.com/repos/${REPO}/releases/latest`, { json: true });
  return { tag: String(rel.tag_name || ""), url: String(rel.html_url || ""), published_at: rel.published_at || "" };
}

async function checkForUpdate(currentVersion) {
  const latest = await latestRelease();
  const cmp = compareVersions(latest.tag, currentVersion);
  return {
    current: String(currentVersion || ""),
    latest: latest.tag,
    update_available: cmp > 0,
    release_url: latest.url,
    published_at: latest.published_at,
  };
}

// Where the running executable lives. In the release binary process.execPath IS
// the binary; in a dev checkout it's node, and self-replacing would clobber node.
function resolveInstalledBinary() {
  const { isPackagedBinary } = require("./packaged");
  if (!isPackagedBinary()) return { path: "", packaged: false };
  return { path: process.execPath, packaged: true };
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

// Environment for running the downloaded binary. Historical: pkg-built
// binaries (before the Node SEA switch) export PKG_EXECPATH, and a child that
// inherits it boots as a plain node runtime instead of the CLI, so
// `staged --version` would fail for reasons unrelated to the download. Still
// stripped, since the running binary may be one of those. The version
// overrides would make any binary report what we expect.
function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("PKG_")) out[k] = v;
  }
  delete out.MAILBOX_CLI_VERSION;
  delete out.MAILBOX_VERSION;
  out.MAILBOX_NO_DAEMON = "1";
  return out;
}

// The new binary must actually run on this machine and report the version we
// meant to install before it replaces the working one.
function verifyBinary(file, wantTag, { exec = execFileSync } = {}) {
  let out = "";
  try {
    out = String(exec(file, ["--version"], {
      env: childEnv(),
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }) || "");
  } catch (e) {
    return { ok: false, error: `downloaded binary does not run (${String((e && e.message) || e).split("\n")[0]})` };
  }
  const got = out.trim().split(/\s+/).pop() || "";
  const want = String(wantTag || "").replace(/^v/, "");
  if (got.replace(/^v/, "") !== want) {
    return { ok: false, error: `downloaded binary reports ${got || "no version"}, expected ${want}` };
  }
  return { ok: true, version: got };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// `deps` lets tests run the whole path offline: the http getter, the installed
// binary location, the binary check and the daemon restart can be swapped.
async function performUpgrade({ currentVersion, targetTag = "", insecure = false, log = () => {}, deps = {} } = {}) {
  const get = deps.get || _get;
  const verify = deps.verifyBinary || verifyBinary;
  const restart = deps.restartDaemon || ((opts) => require("./daemon").restartDaemon(opts));
  const target = deps.target !== undefined ? deps.target : assetTarget();
  if (!target) {
    return { success: false, error: `unsupported platform: ${process.platform} ${process.arch}`, error_code: "invalid_argument" };
  }
  if (targetTag && !isValidTag(targetTag)) {
    return { success: false, error: `Invalid tag "${targetTag}" (expected vX.Y.Z)`, error_code: "invalid_argument" };
  }
  const bin = deps.binary || resolveInstalledBinary();
  if (!bin.packaged) {
    return {
      success: false,
      error: "not running from an installed binary (dev checkout) — nothing to upgrade",
      error_code: "operation_failed",
    };
  }

  const tag = targetTag ? normalizeTag(targetTag) : "";
  const info = tag
    ? { tag, url: `https://github.com/${REPO}/releases/tag/${tag}`, published_at: "" }
    : await (deps.latestRelease || latestRelease)();
  if (!tag && compareVersions(info.tag, currentVersion) <= 0) {
    return { success: true, upgraded: false, current: currentVersion, latest: info.tag, message: "already up to date" };
  }
  if (!isValidTag(info.tag)) {
    return { success: false, error: `latest release has an unexpected tag "${info.tag}"`, error_code: "operation_failed" };
  }

  const base = `https://github.com/${REPO}/releases/download/${info.tag}`;
  const assetName = `mail-use-${target}.tar.gz`;
  log(`downloading ${info.tag} (${assetName})`);
  const tarball = await get(`${base}/${assetName}`, { binary: true });

  // The published checksum is required: a release without one is
  // indistinguishable from bytes that were swapped, so we refuse unless the
  // user explicitly accepts that with --insecure. A mismatch is always fatal.
  let checksumState = "missing";
  let expected = "";
  try {
    const sums = await get(`${base}/${assetName}.sha256`);
    expected = String(sums).trim().split(/\s+/)[0] || "";
  } catch (e) {
    if (!insecure) {
      return {
        success: false,
        error: `no checksum published for ${assetName} (${(e && e.message) || e}); refusing to install unverified bytes (override with --insecure)`,
        error_code: "operation_failed",
      };
    }
  }
  if (expected) {
    if (!/^[0-9a-f]{64}$/i.test(expected)) {
      return { success: false, error: `invalid checksum file for ${assetName}`, error_code: "operation_failed" };
    }
    const actual = sha256(tarball);
    if (expected.toLowerCase() !== actual) {
      return {
        success: false,
        error: `checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`,
        error_code: "operation_failed",
      };
    }
    checksumState = "verified";
  } else if (!insecure) {
    return {
      success: false,
      error: `empty checksum for ${assetName}; refusing to install unverified bytes (override with --insecure)`,
      error_code: "operation_failed",
    };
  } else {
    log("WARNING: no checksum published; installing unverified (--insecure)");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-upgrade-"));
  const dest = bin.path;
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

    // Stage next to the destination (same filesystem, so the final rename is
    // atomic), then make the staged copy prove it runs before it replaces
    // anything. Every failure up to the rename leaves the installed binary as
    // it was; the finally below removes the staged file on every path.
    fs.copyFileSync(extracted, staged);
    fs.chmodSync(staged, 0o755);
    const v = verify(staged, info.tag);
    if (!v.ok) return { success: false, error: v.error, error_code: "operation_failed" };
    log(`verified ${info.tag}`);

    // On POSIX it is legal to replace a running executable's path — the old
    // inode stays alive for already-running processes (notably the daemon,
    // which we restart below).
    try {
      fs.renameSync(staged, dest);
    } catch (e) {
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
    // restartDaemon goes through launchd/systemd when they own the daemon and
    // judges success by the pid changing; a hand-started daemon is stopped and
    // reported as such rather than having a LaunchAgent installed behind the
    // user's back. It runs in-process rather than spawning the binary we just
    // replaced (historically a pkg child inherited PKG_EXECPATH and was not
    // the CLI); it only shells out to launchctl/systemctl.
    let daemon;
    try {
      const r = await restart({});
      daemon = {
        was_running: Boolean(r.was_running),
        restarted: Boolean(r.restarted),
        method: r.method || "",
        old_pid: r.old_pid != null ? r.old_pid : null,
        new_pid: r.new_pid != null ? r.new_pid : null,
        error: r.success ? null : (r.error || "restart failed"),
        ...(r.hint ? { hint: r.hint } : {}),
      };
    } catch (e) {
      daemon = { was_running: false, restarted: false, method: "", error: (e && e.message) || String(e) };
    }

    return {
      success: true,
      upgraded: true,
      from: String(currentVersion || ""),
      to: info.tag,
      binary: dest,
      checksum: checksumState,
      daemon,
      release_url: info.url,
    };
  } finally {
    try { fs.rmSync(staged, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  assetTarget, compareVersions, checkForUpdate, latestRelease, performUpgrade, resolveInstalledBinary,
  isValidTag, normalizeTag, childEnv, verifyBinary, sha256,
};
