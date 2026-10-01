import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const daemon = require("../src/daemon.js");

// None of these touch the real launchctl/systemctl: every command goes through
// an injected exec that records it, and HOME / XDG_CONFIG_HOME point at a temp
// dir so unit files land there.
let home;
const saved = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-autostart-"));
  for (const k of ["HOME", "XDG_CONFIG_HOME"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function recorder(fail = () => false) {
  const calls = [];
  const exec = vi.fn((cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (fail(cmd, args)) throw Object.assign(new Error(`${cmd} failed`), { stderr: "boom" });
    return "";
  });
  return { exec, calls };
}

// ping() that reports `pids` in order, then repeats the last one.
function pinger(...pids) {
  let i = 0;
  return vi.fn(async () => {
    const pid = pids[Math.min(i, pids.length - 1)];
    i += 1;
    return pid ? { success: true, pid } : { success: false, error: "socket not found", error_code: "not_running" };
  });
}

function writeUnit(platform, interval = 900) {
  const info = daemon._autostartPaths(platform);
  fs.mkdirSync(path.dirname(info.unitPath), { recursive: true });
  const body = platform === "darwin"
    ? daemon._renderLaunchdPlist({ node: "", script: "/usr/local/bin/mail-use", syncIntervalSec: interval, logPath: "/tmp/x.log" })
    : daemon._renderSystemdUnit({ node: "", script: "/usr/local/bin/mail-use", syncIntervalSec: interval });
  fs.writeFileSync(info.unitPath, body);
  return info.unitPath;
}

describe("unit files", () => {
  it("launchd only relaunches after a crash, not after a clean exit", () => {
    const plist = daemon._renderLaunchdPlist({ node: "", script: "/x/mail-use", syncIntervalSec: 300, logPath: "/tmp/l" });
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
    expect(plist).not.toMatch(/<key>KeepAlive<\/key><true\/>/);
  });

  it("systemd restarts on failure only", () => {
    const unit = daemon._renderSystemdUnit({ node: "", script: "/x/mail-use", syncIntervalSec: 300 });
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).not.toMatch(/Restart=always/);
  });

  it("reads the installed sync interval back from either format", () => {
    expect(daemon._readInstalledSyncInterval(writeUnit("darwin", 900))).toBe(900);
    expect(daemon._readInstalledSyncInterval(writeUnit("linux", 45))).toBe(45);
    expect(daemon._readInstalledSyncInterval(path.join(home, "nope"))).toBeNull();
  });
});

describe("installAutostart", () => {
  it("keeps the installed --sync-interval when none is given", async () => {
    writeUnit("linux", 900);
    const { exec } = recorder();
    const r = await daemon.installAutostart({ platform: "linux", exec });
    expect(r.sync_interval_sec).toBe(900);
    expect(fs.readFileSync(r.unit_path, "utf8")).toContain('"--sync-interval" "900"');
  });

  it("an explicit interval still wins", async () => {
    writeUnit("darwin", 900);
    const { exec } = recorder();
    const r = await daemon.installAutostart({ platform: "darwin", exec, syncIntervalSec: 60 });
    expect(r.sync_interval_sec).toBe(60);
  });

  it("defaults to 300 on a fresh install", async () => {
    const { exec } = recorder();
    const r = await daemon.installAutostart({ platform: "linux", exec });
    expect(r.sync_interval_sec).toBe(300);
  });

  it("systemd: restarts the unit so a rewritten ExecStart takes effect (enable --now would not)", async () => {
    const { exec, calls } = recorder();
    await daemon.installAutostart({ platform: "linux", exec });
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable mailbox-daemon.service",
      "systemctl --user restart mailbox-daemon.service",
    ]);
  });
});

describe("restartDaemon", () => {
  const uid = process.getuid ? process.getuid() : 0;

  it("launchd: kickstart -k and confirms a new pid answers", async () => {
    writeUnit("darwin");
    const { exec, calls } = recorder();
    const r = await daemon.restartDaemon({ platform: "darwin", exec, ping: pinger(100, 100, 200), pollMs: 1 });
    expect(calls).toEqual([`launchctl kickstart -k gui/${uid}/com.leeguoo.mailbox.daemon`]);
    expect(r).toMatchObject({ success: true, restarted: true, was_running: true, old_pid: 100, new_pid: 200, method: "launchctl kickstart" });
  });

  it("launchd: bootstraps the plist when the job is not loaded", async () => {
    const plist = writeUnit("darwin");
    const { exec, calls } = recorder((cmd, args) => args[0] === "kickstart");
    const r = await daemon.restartDaemon({ platform: "darwin", exec, ping: pinger(null, 300), pollMs: 1 });
    expect(calls[1]).toBe(`launchctl bootstrap gui/${uid} ${plist}`);
    expect(r).toMatchObject({ success: true, restarted: true, new_pid: 300 });
  });

  it("systemd: systemctl --user restart", async () => {
    writeUnit("linux");
    const { exec, calls } = recorder();
    const r = await daemon.restartDaemon({ platform: "linux", exec, ping: pinger(7, 8), pollMs: 1 });
    expect(calls).toEqual(["systemctl --user restart mailbox-daemon.service"]);
    expect(r.restarted).toBe(true);
  });

  it("fails honestly when the same pid keeps answering", async () => {
    writeUnit("linux");
    const { exec } = recorder();
    const r = await daemon.restartDaemon({ platform: "linux", exec, ping: pinger(7), timeoutMs: 20, pollMs: 1 });
    expect(r.success).toBe(false);
    expect(r.restarted).toBe(false);
    expect(r.error).toMatch(/pid 7 is still the one answering/);
  });

  it("reports the supervisor command failing", async () => {
    writeUnit("linux");
    const { exec } = recorder(() => true);
    const r = await daemon.restartDaemon({ platform: "linux", exec, ping: pinger(7) });
    expect(r).toMatchObject({ success: false, error_code: "operation_failed" });
    expect(r.error).toMatch(/boom/);
  });

  it("hand-started daemon (no unit): shuts it down and says so — never installs a unit", async () => {
    const { exec, calls } = recorder();
    const shutdown = vi.fn(async () => ({ success: true }));
    const r = await daemon.restartDaemon({ platform: "darwin", exec, ping: pinger(55), shutdown });
    expect(calls).toEqual([]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ success: true, restarted: false, method: "shutdown", was_running: true });
    expect(r.hint).toMatch(/mail-use daemon start/);
    expect(fs.existsSync(daemon._autostartPaths("darwin").unitPath)).toBe(false);
  });

  it("nothing running and no unit: nothing to do", async () => {
    const { exec, calls } = recorder();
    const r = await daemon.restartDaemon({ platform: "linux", exec, ping: pinger(null) });
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ success: true, was_running: false, restarted: false, method: "none" });
  });
});

describe("stopDaemon", () => {
  const uid = process.getuid ? process.getuid() : 0;

  it("launchd: boots the job out so KeepAlive cannot relaunch it", async () => {
    writeUnit("darwin");
    const { exec, calls } = recorder();
    const shutdown = vi.fn();
    const r = await daemon.stopDaemon({ platform: "darwin", exec, ping: pinger(9, null), shutdown });
    expect(calls).toEqual([`launchctl bootout gui/${uid}/com.leeguoo.mailbox.daemon`]);
    expect(shutdown).not.toHaveBeenCalled();
    expect(r).toMatchObject({ success: true, stopped: true, was_running: true, pid: 9, method: "launchctl bootout" });
  });

  it("systemd: systemctl --user stop", async () => {
    writeUnit("linux");
    const { exec, calls } = recorder();
    const r = await daemon.stopDaemon({ platform: "linux", exec, ping: pinger(9, null), shutdown: vi.fn() });
    expect(calls).toEqual(["systemctl --user stop mailbox-daemon.service"]);
    expect(r.method).toBe("systemctl stop");
  });

  it("no unit: plain __shutdown", async () => {
    const { exec, calls } = recorder();
    const shutdown = vi.fn(async () => ({ success: true }));
    const r = await daemon.stopDaemon({ platform: "linux", exec, ping: pinger(9), shutdown });
    expect(calls).toEqual([]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ success: true, method: "shutdown" });
  });

  it("not running and no unit: not_running error", async () => {
    const r = await daemon.stopDaemon({ platform: "linux", exec: recorder().exec, ping: pinger(null), shutdown: vi.fn() });
    expect(r).toMatchObject({ success: false, error_code: "not_running" });
  });
});
