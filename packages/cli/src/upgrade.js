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

const REPO = process.env.MAILBOX_UPGRADE_REPO || "leeguooooo/mail-use";

// Which release asset this machine needs. Mirrors install.sh; kept in sync by
// the test that asserts both name the same set of targets.
function assetTarget(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && (arch === "arm64" || arch === "aarch64")) return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64-gnu";
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

// Where the running executable lives. In a pkg binary process.execPath IS the
// binary; in a dev checkout it's node, and self-replacing would clobber node.
function resolveInstalledBinary() {
  const packaged = typeof process.pkg !== "undefined";
  if (!packaged) return { path: "", packaged: false };
  return { path: process.execPath, packaged: true };
}

// Does a daemon answer right now?
//
// This connects to the daemon's Unix socket directly instead of shelling out to
// `<binary> daemon status`. Spawning ourselves does not work from a pkg binary:
// pkg puts PKG_EXECPATH into the environment, the child inherits it and stops
// behaving like the CLI, so the probe always failed and every upgrade reported
// the daemon as not running. Seen live on 3.3.1 — the daemon was demonstrably up
// (pid 79961) and `was_running` still came back false.
function daemonResponds() {
  const { getSocketPath } = require("./daemon");
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

// launchd/systemd reload is asynchronous, so a probe fired immediately after the
// reload can land in the gap between unload and load.
async function waitForDaemon(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await daemonResponds()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => { setTimeout(r, 500); });
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function performUpgrade({ currentVersion, targetTag = "", log = () => {} } = {}) {
  const target = assetTarget();
  if (!target) {
    return { success: false, error: `unsupported platform: ${process.platform} ${process.arch}`, error_code: "invalid_argument" };
  }
  const bin = resolveInstalledBinary();
  if (!bin.packaged) {
    return {
      success: false,
      error: "not running from an installed binary (dev checkout) — nothing to upgrade",
      error_code: "operation_failed",
    };
  }

  const info = targetTag
    ? { tag: targetTag, url: `https://github.com/${REPO}/releases/tag/${targetTag}`, published_at: "" }
    : await latestRelease();
  if (!targetTag && compareVersions(info.tag, currentVersion) <= 0) {
    return { success: true, upgraded: false, current: currentVersion, latest: info.tag, message: "already up to date" };
  }

  const base = `https://github.com/${REPO}/releases/download/${info.tag}`;
  const assetName = `mail-use-${target}.tar.gz`;
  log(`downloading ${info.tag} (${assetName})`);
  const tarball = await _get(`${base}/${assetName}`, { binary: true });

  // Verify against the published checksum. A mismatch means the bytes are not
  // what was released — refuse rather than install them.
  let checksumState = "missing";
  try {
    const sums = await _get(`${base}/${assetName}.sha256`);
    const expected = String(sums).trim().split(/\s+/)[0];
    const actual = sha256(tarball);
    if (expected && expected !== actual) {
      return {
        success: false,
        error: `checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`,
        error_code: "operation_failed",
      };
    }
    checksumState = expected ? "verified" : "missing";
  } catch {
    checksumState = "missing";
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-upgrade-"));
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
    fs.chmodSync(extracted, 0o755);

    // Replace via rename within the same directory: rename is atomic, and on
    // POSIX it is legal to replace a running executable's path — the old inode
    // stays alive for already-running processes (notably the daemon, which we
    // restart below).
    const dest = bin.path;
    const staged = path.join(path.dirname(dest), `.mail-use.upgrade.${process.pid}`);
    fs.copyFileSync(extracted, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, dest);
    log(`installed ${info.tag} to ${dest}`);

    // The daemon is still running the previous binary from its open inode, so
    // an upgrade that skips this leaves the old code serving every call.
    //
    // Probe and restart are reported separately on purpose. Folding them into one
    // try meant any failure — including a probe that raced the restart — came back
    // as "not_running", which told the user the daemon was down when it was up and
    // that nothing was restarted when it had been.
    const daemon = { was_running: false, restarted: false, error: null };
    daemon.was_running = await daemonResponds();
    if (daemon.was_running) {
      try {
        // In-process, for the same reason the probe is: this must not spawn the
        // binary we just replaced. installAutostart only shells out to
        // launchctl/systemctl, which is fine.
        const { installAutostart } = require("./daemon");
        const r = await installAutostart({});
        if (r && r.success === false) daemon.error = r.error || "reload failed";
        // Confirm it actually came back rather than trusting the return value: a
        // reload that unloads but fails to load would otherwise read as success.
        daemon.restarted = await waitForDaemon(10_000);
        if (!daemon.restarted && !daemon.error) daemon.error = "daemon did not come back after reload";
      } catch (e) {
        daemon.error = (e && e.message) || String(e);
        // It may still have restarted despite the throw; report what is true.
        daemon.restarted = await waitForDaemon(5_000);
      }
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
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { assetTarget, compareVersions, checkForUpdate, latestRelease, performUpgrade, resolveInstalledBinary };
