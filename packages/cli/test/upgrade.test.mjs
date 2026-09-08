import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const upgrade = require("../src/upgrade.js");

describe("compareVersions", () => {
  it("orders normal releases", () => {
    expect(upgrade.compareVersions("3.1.2", "3.1.1")).toBe(1);
    expect(upgrade.compareVersions("3.1.1", "3.1.2")).toBe(-1);
    expect(upgrade.compareVersions("3.1.2", "3.1.2")).toBe(0);
  });

  it("ignores a leading v, so a tag compares against a bare version", () => {
    expect(upgrade.compareVersions("v3.1.2", "3.1.2")).toBe(0);
    expect(upgrade.compareVersions("v3.2.0", "3.1.9")).toBe(1);
  });

  it("compares numerically, not lexically", () => {
    // The bug this guards: "3.10.0" < "3.9.0" under string comparison, which
    // would make every user stop being offered upgrades at 3.9.
    expect(upgrade.compareVersions("3.10.0", "3.9.0")).toBe(1);
    expect(upgrade.compareVersions("v3.2.0", "v3.10.0")).toBe(-1);
  });

  it("handles uneven segment counts", () => {
    expect(upgrade.compareVersions("3.2", "3.2.0")).toBe(0);
    expect(upgrade.compareVersions("3.2.1", "3.2")).toBe(1);
  });

  it("ignores prerelease suffixes rather than crashing on them", () => {
    expect(upgrade.compareVersions("3.1.2-beta.1", "3.1.2")).toBe(0);
    expect(upgrade.compareVersions("3.1.3-rc1", "3.1.2")).toBe(1);
  });

  it("treats junk as 0 instead of throwing", () => {
    expect(upgrade.compareVersions("", "1.0.0")).toBe(-1);
    expect(upgrade.compareVersions(null, undefined)).toBe(0);
  });
});

describe("assetTarget", () => {
  it("maps the three released platforms", () => {
    expect(upgrade.assetTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(upgrade.assetTarget("darwin", "x64")).toBe("darwin-x64");
    expect(upgrade.assetTarget("linux", "x64")).toBe("linux-x64-gnu");
  });

  it("returns null on platforms with no release asset", () => {
    expect(upgrade.assetTarget("win32", "x64")).toBeNull();
    expect(upgrade.assetTarget("linux", "arm64")).toBeNull();
  });

  // install.sh and the upgrade path must agree on asset names, or `upgrade`
  // will 404 on exactly the platforms the installer supports.
  it("names the same targets install.sh does", () => {
    const sh = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "install.sh"), "utf8");
    for (const t of ["darwin-arm64", "darwin-x64", "linux-x64-gnu"]) {
      expect(sh).toContain(t);
    }
    // ${target} below is shell interpolation inside install.sh, not JS.
    // eslint-disable-next-line no-template-curly-in-string
    expect(sh).toContain('asset="mail-use-${target}.tar.gz"');
  });
});

describe("resolveInstalledBinary", () => {
  it("refuses to self-replace when not running as a packaged binary", () => {
    // Under vitest process.pkg is undefined — the dev-checkout case, where
    // process.execPath is node itself and overwriting it would be catastrophic.
    const r = upgrade.resolveInstalledBinary();
    expect(r.packaged).toBe(false);
    expect(r.path).toBe("");
  });

  it("performUpgrade bails out in a dev checkout instead of clobbering node", async () => {
    const r = await upgrade.performUpgrade({ currentVersion: "0.0.1" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/dev checkout/);
    expect(r.error_code).toBe("operation_failed");
  });
});

// The daemon report has to be honest. The first version folded the status probe
// and the reload into one try/catch, so a probe that raced the restart reported
// `daemon: "not_running"` — telling the user the daemon was down when it was up,
// and that nothing was restarted when it had been. Seen live upgrading 3.2.0 to
// 3.3.0: pid changed (so it *had* restarted) while the result said not_running.
describe("upgrade daemon reporting", () => {
  it("reports was_running and restarted as separate facts", async () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "upgrade.js"), "utf8");
    expect(src).toMatch(/was_running/);
    expect(src).toMatch(/restarted/);
    // The two must not be collapsed into one catch-all string again.
    expect(src).not.toMatch(/daemon = "not_running"/);
  });

  it("confirms the daemon came back instead of trusting the reload's return value", async () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "upgrade.js"), "utf8");
    expect(src).toMatch(/waitForDaemon/);
    // A reload that unloads but never loads must not read as success.
    expect(src).toMatch(/did not come back after reload/);
  });

  // A pkg binary cannot usefully spawn itself: pkg puts PKG_EXECPATH in the
  // environment, the child inherits it and stops behaving like the CLI. That is
  // why `was_running` was false on a machine where the daemon was plainly up.
  it("never spawns its own binary — probes the socket and reloads in-process", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "upgrade.js"), "utf8");
    expect(src).not.toMatch(/execFileSync\(\s*dest/);
    expect(src).not.toMatch(/execFileSync\(\s*binPath/);
    // tar is the only subprocess left.
    const spawns = [...src.matchAll(/execFileSync\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(spawns).toEqual(["tar"]);
  });
});
