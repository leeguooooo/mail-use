import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const upgrade = require("../src/upgrade.js");

// Drives performUpgrade end to end, offline: a real tarball holding a shell
// script that stands in for the release binary, served by a fake getter.
let root;
let binDir;
let installed;

function makeRelease(script) {
  const src = fs.mkdtempSync(path.join(root, "rel-"));
  fs.writeFileSync(path.join(src, "mail-use"), script, { mode: 0o755 });
  const tarPath = path.join(root, `rel-${Date.now()}-${Math.random()}.tar.gz`);
  execFileSync("tar", ["-czf", tarPath, "-C", src, "mail-use"]);
  return fs.readFileSync(tarPath);
}

function fakeGet(tarball, { checksum } = {}) {
  return vi.fn(async (url) => {
    if (url.endsWith(".sha256")) {
      if (checksum === null) throw new Error("HTTP 404");
      const sum = checksum !== undefined ? checksum : crypto.createHash("sha256").update(tarball).digest("hex");
      return `${sum}  mail-use-darwin-arm64.tar.gz\n`;
    }
    return tarball;
  });
}

function deps(get, extra = {}) {
  return {
    get,
    target: "darwin-arm64",
    binary: { packaged: true, path: installed },
    restartDaemon: vi.fn(async () => ({ success: true, was_running: false, restarted: false, method: "none" })),
    ...extra,
  };
}

const OLD = "#!/bin/sh\necho 1.0.0\n";
const leftovers = () => fs.readdirSync(binDir).filter((f) => f.startsWith(".mail-use.upgrade."));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-upgrade-test-"));
  binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  installed = path.join(binDir, "mail-use");
  fs.writeFileSync(installed, OLD, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("performUpgrade verification", () => {
  it("installs a release whose checksum matches and whose binary reports the tag", async () => {
    const tar = makeRelease("#!/bin/sh\necho 2.0.0\n");
    const d = deps(fakeGet(tar));
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", deps: d });
    expect(r).toMatchObject({ success: true, upgraded: true, to: "v2.0.0", checksum: "verified" });
    expect(fs.readFileSync(installed, "utf8")).toContain("2.0.0");
    expect(d.restartDaemon).toHaveBeenCalledTimes(1);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a release with no published checksum", async () => {
    const tar = makeRelease("#!/bin/sh\necho 2.0.0\n");
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", deps: deps(fakeGet(tar, { checksum: null })) });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no checksum/);
    expect(fs.readFileSync(installed, "utf8")).toBe(OLD);
  });

  it("--insecure accepts a release with no checksum and says so", async () => {
    const tar = makeRelease("#!/bin/sh\necho 2.0.0\n");
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", insecure: true, deps: deps(fakeGet(tar, { checksum: null })) });
    expect(r).toMatchObject({ success: true, upgraded: true, checksum: "missing" });
  });

  it("refuses a checksum mismatch even with --insecure", async () => {
    const tar = makeRelease("#!/bin/sh\necho 2.0.0\n");
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", insecure: true, deps: deps(fakeGet(tar, { checksum: "0".repeat(64) })) });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/checksum mismatch/);
    expect(fs.readFileSync(installed, "utf8")).toBe(OLD);
  });

  it("smoke-tests the staged binary and leaves the installed one alone when it fails", async () => {
    const tar = makeRelease("#!/bin/sh\nexit 3\n");
    const d = deps(fakeGet(tar));
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", deps: d });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/does not run/);
    expect(fs.readFileSync(installed, "utf8")).toBe(OLD);
    expect(leftovers()).toEqual([]);
    expect(d.restartDaemon).not.toHaveBeenCalled();
  });

  it("refuses a binary that reports a different version than the tag", async () => {
    const tar = makeRelease("#!/bin/sh\necho 1.9.9\n");
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", deps: deps(fakeGet(tar)) });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/reports 1\.9\.9, expected 2\.0\.0/);
    expect(fs.readFileSync(installed, "utf8")).toBe(OLD);
    expect(leftovers()).toEqual([]);
  });

  it("rejects a malformed --tag before making any request", async () => {
    const get = vi.fn();
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0/../../evil", deps: deps(get) });
    expect(r).toMatchObject({ success: false, error_code: "invalid_argument" });
    expect(get).not.toHaveBeenCalled();
  });

  it("passes the daemon restart outcome through, including pids", async () => {
    const tar = makeRelease("#!/bin/sh\necho 2.0.0\n");
    const d = deps(fakeGet(tar), {
      restartDaemon: vi.fn(async () => ({ success: true, was_running: true, restarted: true, method: "launchctl kickstart", old_pid: 10, new_pid: 20 })),
    });
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "2.0.0", deps: d });
    expect(r.to).toBe("v2.0.0");
    expect(r.daemon).toMatchObject({ was_running: true, restarted: true, old_pid: 10, new_pid: 20, error: null });
  });
});

describe("tag validation and child env", () => {
  it("accepts vX.Y.Z (with or without v, optional prerelease) and nothing else", () => {
    for (const t of ["v3.5.0", "3.5.0", "v3.5.0-rc.1"]) expect(upgrade.isValidTag(t)).toBe(true);
    for (const t of ["", "latest", "v3.5", "v3.5.0/../x", "v3.5.0?x=1", " v3.5.0"]) expect(upgrade.isValidTag(t)).toBe(false);
  });

  it("strips PKG_* and version overrides from the smoke-test environment", () => {
    const env = upgrade.childEnv({ PATH: "/bin", PKG_EXECPATH: "/x", PKG_DUMMY: "1", MAILBOX_CLI_VERSION: "9.9.9" });
    expect(env.PATH).toBe("/bin");
    expect(env.PKG_EXECPATH).toBeUndefined();
    expect(env.PKG_DUMMY).toBeUndefined();
    expect(env.MAILBOX_CLI_VERSION).toBeUndefined();
  });
});
