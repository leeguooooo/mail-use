import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

// The daemon's passive update check must be trivially disableable and must never
// be a reason the process stays alive. Both are properties of the interval
// helper and the timers it creates, so drive those directly rather than standing
// up a daemon and waiting a day.
const daemonPath = require.resolve("../src/daemon.js");

function freshDaemon() {
  delete require.cache[daemonPath];
  return require(daemonPath);
}

describe("daemon passive update check", () => {
  afterEach(() => {
    delete process.env.MAILBOX_UPDATE_CHECK_HOURS;
    delete require.cache[daemonPath];
  });

  it("exports a version resolver that daemon and CLI share (no circular require)", () => {
    const { getCliVersion } = require("../src/cli_version.js");
    expect(typeof getCliVersion).toBe("function");
    expect(typeof getCliVersion()).toBe("string");
    // daemon.js must not pull in main.js just to learn the version.
    const src = require("node:fs").readFileSync(daemonPath, "utf8");
    expect(src).not.toMatch(/require\(["']\.\/main["']\)/);
  });

  it("MAILBOX_UPDATE_CHECK_HOURS=0 disables the check entirely", () => {
    process.env.MAILBOX_UPDATE_CHECK_HOURS = "0";
    const d = freshDaemon();
    expect(d._updateCheckIntervalMs()).toBe(0);
    expect(d._startUpdateChecks({ log: () => {} })).toBeNull();
  });

  it("rejects junk intervals by disabling rather than scheduling a busy loop", () => {
    for (const bad of ["-1", "abc", "0"]) {
      process.env.MAILBOX_UPDATE_CHECK_HOURS = bad;
      const d = freshDaemon();
      expect(d._updateCheckIntervalMs()).toBe(0);
      delete require.cache[daemonPath];
    }
  });

  it("defaults to once a day", () => {
    const d = freshDaemon();
    expect(d._updateCheckIntervalMs()).toBe(24 * 60 * 60 * 1000);
  });

  it("honours a custom interval", () => {
    process.env.MAILBOX_UPDATE_CHECK_HOURS = "6";
    const d = freshDaemon();
    expect(d._updateCheckIntervalMs()).toBe(6 * 60 * 60 * 1000);
  });

  it("its timers are unref'd, so they can never hold the daemon open", () => {
    const d = freshDaemon();
    const timers = d._startUpdateChecks({ log: () => {} });
    expect(timers).toBeTruthy();
    expect(timers.first.hasRef()).toBe(false);
    expect(timers.timer.hasRef()).toBe(false);
    clearTimeout(timers.first);
    clearInterval(timers.timer);
  });
});
