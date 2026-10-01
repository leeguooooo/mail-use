// `mail-use upgrade` safety: install-channel detection, the mandatory sha256,
// verify-before-swap, and skills being opt-in. Everything runs offline against
// a temp directory; the real installed binary and ~ are never touched.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const upgrade = require("../src/upgrade.js");

const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");
const OLD = "#!/bin/sh\necho 3.3.0\n";

let tmp;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-safety-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A release tarball whose `mail-use` is a shell script printing `version`.
function makeTarball(version) {
  const src = path.join(tmp, `src-${version}`);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "mail-use"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  const out = path.join(tmp, `mail-use-${version}.tar.gz`);
  execFileSync("tar", ["-czf", out, "-C", src, "mail-use"]);
  return fs.readFileSync(out);
}

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Installed binary at <tmp>/bin/mail-use, and an offline "GitHub".
function setup({ tarball, sums }) {
  const bin = path.join(tmp, "bin", "mail-use");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, OLD, { mode: 0o755 });
  const fetched = [];
  const get = async (url) => {
    fetched.push(url);
    if (url.endsWith(".sha256")) {
      if (sums instanceof Error) throw sums;
      return sums;
    }
    return tarball;
  };
  const deps = {
    get,
    target: "darwin-arm64",
    channel: { channel: "release", path: bin, upgradable: true, hint: "" },
    latestRelease: async () => ({ tag: "v3.4.0", url: "", published_at: "" }),
    daemonResponds: async () => false,
  };
  return { bin, deps, fetched };
}

function dirEntries(bin) {
  return fs.readdirSync(path.dirname(bin)).sort();
}

describe("version comparison decides whether to download at all", () => {
  it("already current: no download, nothing touched", async () => {
    const { bin, deps, fetched } = setup({ tarball: Buffer.alloc(0), sums: "" });
    deps.latestRelease = async () => ({ tag: "v3.3.0", url: "", published_at: "" });
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r).toMatchObject({ success: true, upgraded: false });
    expect(fetched).toEqual([]);
    expect(fs.readFileSync(bin, "utf8")).toBe(OLD);
  });

  it("an older latest is not a downgrade", async () => {
    const { deps, fetched } = setup({ tarball: Buffer.alloc(0), sums: "" });
    deps.latestRelease = async () => ({ tag: "v3.2.9", url: "", published_at: "" });
    const r = await upgrade.performUpgrade({ currentVersion: "3.10.0", deps });
    expect(r.upgraded).toBe(false);
    expect(fetched).toEqual([]);
  });
});

describe("sha256 is mandatory", () => {
  it("a checksum mismatch is refused and the old binary is untouched", async () => {
    const tarball = makeTarball("3.4.0");
    const { bin, deps } = setup({ tarball, sums: `${"0".repeat(64)}  mail-use-darwin-arm64.tar.gz\n` });
    const before = dirEntries(bin);
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/checksum mismatch/);
    expect(fs.readFileSync(bin, "utf8")).toBe(OLD);
    expect(dirEntries(bin)).toEqual(before); // no staged leftovers
  });

  it("a missing checksum sidecar is refused, not skipped", async () => {
    const { bin, deps } = setup({ tarball: makeTarball("3.4.0"), sums: new Error("HTTP 404") });
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no checksum/);
    expect(fs.readFileSync(bin, "utf8")).toBe(OLD);
  });

  it("an empty or malformed checksum file is refused", async () => {
    const { bin, deps } = setup({ tarball: makeTarball("3.4.0"), sums: "<html>not found</html>" });
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r.error).toMatch(/invalid checksum/);
    expect(fs.readFileSync(bin, "utf8")).toBe(OLD);
  });
});

describe("verify before swap, then an atomic rename", () => {
  it("a verified download replaces the binary and leaves no staging file", async () => {
    const tarball = makeTarball("3.4.0");
    const { bin, deps } = setup({ tarball, sums: `${sha(tarball)}  mail-use-darwin-arm64.tar.gz\n` });
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r).toMatchObject({ success: true, upgraded: true, checksum: "verified", to: "v3.4.0" });
    expect(execFileSync(bin, { encoding: "utf8" }).trim()).toBe("3.4.0");
    expect(dirEntries(bin)).toEqual(["mail-use"]);
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
  });

  it("a binary that reports the wrong version is refused", async () => {
    const tarball = makeTarball("3.3.9");
    const { bin, deps } = setup({ tarball, sums: sha(tarball) });
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/reports 3\.3\.9, expected 3\.4\.0/);
    expect(fs.readFileSync(bin, "utf8")).toBe(OLD);
  });

  it("a prerelease binary does not pass for the release (exact version match)", async () => {
    const tarball = makeTarball("3.4.0-rc1");
    const { bin, deps } = setup({ tarball, sums: sha(tarball) });
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r.error).toMatch(/reports 3\.4\.0-rc1, expected 3\.4\.0/);
    expect(fs.readFileSync(bin, "utf8")).toBe(OLD);
  });

  it("a binary that does not run is refused", async () => {
    const src = path.join(tmp, "broken");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "mail-use"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    execFileSync("tar", ["-czf", path.join(tmp, "b.tar.gz"), "-C", src, "mail-use"]);
    const tarball = fs.readFileSync(path.join(tmp, "b.tar.gz"));
    const { bin, deps } = setup({ tarball, sums: sha(tarball) });
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r.error).toMatch(/does not run/);
    expect(fs.readFileSync(bin, "utf8")).toBe(OLD);
  });

  it("--tag pins the exact release, even when it is not the latest", async () => {
    const tarball = makeTarball("3.3.5");
    const { bin, deps, fetched } = setup({ tarball, sums: sha(tarball) });
    deps.latestRelease = async () => { throw new Error("must not look up latest when pinned"); };
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", targetTag: "v3.3.5", deps });
    expect(r.success).toBe(true);
    expect(fetched[0]).toBe("https://github.com/leeguooooo/mail-use/releases/download/v3.3.5/mail-use-darwin-arm64.tar.gz");
    expect(execFileSync(bin, { encoding: "utf8" }).trim()).toBe("3.3.5");
  });

  it("the version check runs the download without pkg's PKG_* markers or a version override", () => {
    const env = upgrade.childEnv({ PATH: "/bin", PKG_EXECPATH: "/x", PKG_DUMMY: "1", MAILBOX_CLI_VERSION: "9.9.9" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("install channel detection", () => {
  it("a pkg binary outside any package manager is the release channel", () => {
    const c = upgrade.detectInstallChannel({ packaged: true, execPath: "/Users/me/.local/bin/mail-use" });
    expect(c).toMatchObject({ channel: "release", upgradable: true });
  });

  it("Homebrew-owned binaries defer to brew", () => {
    for (const p of [
      "/opt/homebrew/bin/mail-use",
      "/usr/local/Cellar/mail-use/3.3.0/bin/mail-use",
      "/home/linuxbrew/.linuxbrew/bin/mail-use",
    ]) {
      const c = upgrade.detectInstallChannel({ packaged: true, execPath: p });
      expect(c.channel).toBe("brew");
      expect(c.upgradable).toBe(false);
      expect(c.hint).toContain("brew upgrade mail-use");
    }
  });

  it("node running an entry from node_modules is npm", () => {
    const c = upgrade.detectInstallChannel({ packaged: false, entry: "/usr/local/lib/node_modules/mail-use/packages/cli/bin/mail-use.js" });
    expect(c).toMatchObject({ channel: "npm", upgradable: false });
    expect(c.hint).toContain("npm");
  });

  it("node running an entry from a git checkout is source", () => {
    const c = upgrade.detectInstallChannel({ packaged: false, entry: path.join(REPO_ROOT, "packages", "cli", "bin", "mail-use.js") });
    expect(c).toMatchObject({ channel: "source", upgradable: false, path: fs.realpathSync(REPO_ROOT) });
    expect(c.hint).toContain("pull --ff-only");
  });

  it("node running an entry anywhere else is unknown and points at install.sh", () => {
    const entry = path.join(tmp, "mail-use.js");
    fs.writeFileSync(entry, "");
    const c = upgrade.detectInstallChannel({ packaged: false, entry });
    expect(c).toMatchObject({ channel: "unknown", upgradable: false });
    expect(c.hint).toContain("install.sh");
  });

  it("a refused channel downloads nothing", async () => {
    const { deps, fetched } = setup({ tarball: Buffer.alloc(0), sums: "" });
    deps.channel = { channel: "brew", path: "/opt/homebrew/bin/mail-use", upgradable: false, hint: "brew upgrade mail-use" };
    const r = await upgrade.performUpgrade({ currentVersion: "3.3.0", deps });
    expect(r).toMatchObject({ success: false, refused: true });
    expect(fetched).toEqual([]);
  });
});

describe("the CLI: refusal exit code, --json channel, skills opt-in", () => {
  const cli = path.join(import.meta.dirname, "..", "bin", "mail-use.js");
  function cliEnv(home) {
    return {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CACHE_HOME: path.join(home, "cache"),
      MAILBOX_CONFIG_DIR: path.join(home, "config"),
      MAILBOX_DATA_DIR: path.join(home, "data"),
      MAILBOX_NO_DAEMON: "1",
      MAIL_USE_NO_UPDATE_CHECK: "1",
      MAILBOX_CLI_VERSION: "3.3.0",
    };
  }

  it("`upgrade` from a source checkout is refused with exit 1 and touches no skill", async () => {
    // A git-checkout skill the upgrade must not pull without --skills.
    const home = path.join(tmp, "home");
    const skill = path.join(home, ".claude", "skills", "mail-use");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# mail-use\n");
    execFileSync("git", ["init", "-q", skill]);
    const r = await execa("node", [cli, "upgrade", "--tag", "v3.4.0", "--text"], { env: cliEnv(home), extendEnv: false, reject: false });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/upgrade refused: running from a source checkout/);
    expect(r.stdout).not.toMatch(/updated/);
  });

  it("`upgrade --check --tag` reports the channel without touching the network", async () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const r = await execa("node", [cli, "upgrade", "--check", "--tag", "v3.4.0", "--json"], { env: cliEnv(home), extendEnv: false, reject: false });
    expect(r.exitCode).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ name: "mail-use", current: "3.3.0", latest: "3.4.0", update_available: true, skills: [] });
    expect(j.install_channel).toMatchObject({ channel: "source", upgradable: false });
  });

  it("`upgrade --help` documents --skills, --check and --tag", async () => {
    const r = await execa("node", [cli, "upgrade", "--help", "--text"], { env: cliEnv(tmp), extendEnv: false, reject: false });
    expect(r.stdout).toMatch(/--skills/);
    expect(r.stdout).toMatch(/--check/);
    expect(r.stdout).toMatch(/--tag/);
  });

  it("root --help lists upgrade", async () => {
    const r = await execa("node", [cli, "--help", "--text"], { env: cliEnv(tmp), extendEnv: false, reject: false });
    expect(r.stdout).toMatch(/^\s+upgrade\b/m);
  });
});

describe("skills are only refreshed with --skills", () => {
  const skills = require("../src/skill_refresh.js");
  it("a skipped skill prints how to refresh it", () => {
    const line = skills.formatSkillLine({ channel: "git", path: "/p", update: "git -C /r pull --ff-only", status: "skipped" });
    expect(line).toBe("skill (git) /p: not refreshed; pass --skills or run: git -C /r pull --ff-only");
  });

  it("the upgrade command refreshes only behind opts.skills", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "commands", "upgrade.js"), "utf8");
    expect(src).toMatch(/opts\.skills \? skillRefresh\.refreshSkills\(found\)/);
  });
});

// install.sh with a fake curl that serves a local "release".
describe("install.sh", () => {
  function runInstaller({ sums }) {
    const rel = path.join(tmp, "rel");
    fs.mkdirSync(rel, { recursive: true });
    const tarball = makeTarball("3.4.0");
    const asset = upgrade.assetTarget() ? `mail-use-${upgrade.assetTarget()}.tar.gz` : "mail-use-linux-x64-gnu.tar.gz";
    fs.writeFileSync(path.join(rel, asset), tarball);
    if (sums !== null) fs.writeFileSync(path.join(rel, `${asset}.sha256`), sums === "good" ? `${sha(tarball)}  ${asset}\n` : sums);
    const fake = path.join(tmp, "fakebin");
    fs.mkdirSync(fake, { recursive: true });
    // curl ... -o <out> <url>: copy <rel>/<basename url> to <out>, 22 when absent.
    fs.writeFileSync(path.join(fake, "curl"), `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; --retry) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
f="${rel}/$(basename "$url")"
[ -f "$f" ] || exit 22
cp "$f" "$out"
`, { mode: 0o755 });
    const dir = path.join(tmp, "install");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mail-use"), OLD, { mode: 0o755 });
    let code = 0;
    let out = "";
    try {
      out = execFileSync("sh", [path.join(REPO_ROOT, "install.sh")], {
        env: { PATH: `${fake}:${process.env.PATH}`, HOME: tmp, MAIL_USE_INSTALL_DIR: dir, MAIL_USE_NO_DAEMON: "1" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      code = e.status;
      out = String(e.stderr || "");
    }
    return { code, out, bin: path.join(dir, "mail-use") };
  }

  const supported = process.platform === "darwin" || (process.platform === "linux" && process.arch === "x64");

  it.skipIf(!supported)("installs when the checksum matches", () => {
    const r = runInstaller({ sums: "good" });
    expect(r.code).toBe(0);
    expect(execFileSync(r.bin, { encoding: "utf8" }).trim()).toBe("3.4.0");
  });

  it.skipIf(!supported)("a checksum mismatch fails and keeps the old binary", () => {
    const r = runInstaller({ sums: `${"a".repeat(64)}  x\n` });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/checksum mismatch/);
    expect(fs.readFileSync(r.bin, "utf8")).toBe(OLD);
  });

  it.skipIf(!supported)("a missing checksum fails and keeps the old binary", () => {
    const r = runInstaller({ sums: null });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/checksum download failed/);
    expect(fs.readFileSync(r.bin, "utf8")).toBe(OLD);
  });
});
