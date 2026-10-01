// What this branch adds on top of upgrade_safety.test.mjs (which covers the
// mandatory checksum, verify-before-swap and the atomic rename): --insecure,
// --tag validation, and the daemon restart going through restartDaemon.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const upgrade = require("../src/upgrade.js");

const OLD = "#!/bin/sh\necho 1.0.0\n";
let root;
let installed;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-upgrade-test-")));
  installed = path.join(root, "bin", "mail-use");
  fs.mkdirSync(path.dirname(installed));
  fs.writeFileSync(installed, OLD, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeRelease(version) {
  const src = fs.mkdtempSync(path.join(root, "rel-"));
  fs.writeFileSync(path.join(src, "mail-use"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  const tarPath = path.join(src, "out.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", src, "mail-use"]);
  return fs.readFileSync(tarPath);
}

function fakeGet(tarball, { checksum } = {}) {
  return vi.fn(async (url) => {
    if (url.endsWith(".sha256")) {
      if (checksum === null) throw new Error("HTTP 404");
      return `${checksum || crypto.createHash("sha256").update(tarball).digest("hex")}  x.tar.gz\n`;
    }
    return tarball;
  });
}

function deps(get, extra = {}) {
  return {
    get,
    target: "darwin-arm64",
    channel: { channel: "release", path: installed, upgradable: true, hint: "" },
    daemonResponds: async () => false,
    restartDaemon: vi.fn(),
    ...extra,
  };
}

describe("--insecure", () => {
  it("accepts a release with no published checksum, and reports it unverified", async () => {
    const tar = makeRelease("2.0.0");
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", insecure: true, deps: deps(fakeGet(tar, { checksum: null })) });
    expect(r).toMatchObject({ success: true, upgraded: true, checksum: "missing" });
    expect(fs.readFileSync(installed, "utf8")).toContain("2.0.0");
  });

  it("never waives a checksum mismatch", async () => {
    const tar = makeRelease("2.0.0");
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", insecure: true, deps: deps(fakeGet(tar, { checksum: "0".repeat(64) })) });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/checksum mismatch/);
    expect(fs.readFileSync(installed, "utf8")).toBe(OLD);
  });

  it("without it, a missing checksum points at the override", async () => {
    const tar = makeRelease("2.0.0");
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", deps: deps(fakeGet(tar, { checksum: null })) });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/--insecure/);
  });
});

describe("--tag", () => {
  it("rejects a malformed tag before making any request", async () => {
    const get = vi.fn();
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0/../../evil", deps: deps(get) });
    expect(r).toMatchObject({ success: false, error_code: "invalid_argument" });
    expect(get).not.toHaveBeenCalled();
  });

  it("accepts a bare X.Y.Z and installs the v-prefixed release", async () => {
    const tar = makeRelease("2.0.0");
    const get = fakeGet(tar);
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "2.0.0", deps: deps(get) });
    expect(r).toMatchObject({ success: true, to: "v2.0.0" });
    expect(get.mock.calls[0][0]).toContain("/download/v2.0.0/");
  });

  it("accepts vX.Y.Z (optional prerelease) and nothing else", () => {
    for (const t of ["v3.5.0", "3.5.0", "v3.5.0-rc.1"]) expect(upgrade.isValidTag(t)).toBe(true);
    for (const t of ["", "latest", "v3.5", "v3.5.0/../x", "v3.5.0?x=1", " v3.5.0"]) expect(upgrade.isValidTag(t)).toBe(false);
  });
});

describe("daemon restart after the swap", () => {
  it("goes through restartDaemon and reports pids", async () => {
    const tar = makeRelease("2.0.0");
    const restartDaemon = vi.fn(async () => ({ success: true, was_running: true, restarted: true, method: "launchctl kickstart", old_pid: 10, new_pid: 20 }));
    const r = await upgrade.performUpgrade({
      currentVersion: "1.0.0",
      targetTag: "v2.0.0",
      deps: deps(fakeGet(tar), { daemonResponds: async () => true, restartDaemon }),
    });
    expect(restartDaemon).toHaveBeenCalledTimes(1);
    expect(r.daemon).toMatchObject({ was_running: true, restarted: true, method: "launchctl kickstart", old_pid: 10, new_pid: 20, error: null });
  });

  it("a failed restart is reported, the upgrade itself still stands", async () => {
    const tar = makeRelease("2.0.0");
    const restartDaemon = vi.fn(async () => ({ success: false, was_running: true, restarted: false, method: "systemctl restart", old_pid: 10, error: "daemon pid 10 is still the one answering" }));
    const r = await upgrade.performUpgrade({
      currentVersion: "1.0.0",
      targetTag: "v2.0.0",
      deps: deps(fakeGet(tar), { daemonResponds: async () => true, restartDaemon }),
    });
    expect(r.success).toBe(true);
    expect(r.daemon).toMatchObject({ restarted: false, error: "daemon pid 10 is still the one answering" });
  });

  it("no daemon answering: restart is not attempted", async () => {
    const tar = makeRelease("2.0.0");
    const d = deps(fakeGet(tar));
    const r = await upgrade.performUpgrade({ currentVersion: "1.0.0", targetTag: "v2.0.0", deps: d });
    expect(d.restartDaemon).not.toHaveBeenCalled();
    expect(r.daemon).toMatchObject({ was_running: false, restarted: false });
  });
});
