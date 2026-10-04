// The *-use family upgrade convention (leeguooooo/plugins docs/upgrade.md):
// `upgrade --check [--json]`, the daily stderr notice, and skill refresh.
// Nothing here reaches the network, the real clock, or the real ~.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const upgrade = require("../src/upgrade.js");
const notice = require("../src/update_notice.js");
const skills = require("../src/skill_refresh.js");

const DAY = 24 * 60 * 60;
const NOW = Date.UTC(2026, 0, 15); // fixed clock
const NOW_SEC = Math.floor(NOW / 1000);

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mail-use-upgrade-test-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// Only the variables under test; never process.env, so a CI=true runner does
// not silently turn every notice test into a skip.
function env(extra = {}) {
  return { XDG_CACHE_HOME: path.join(home, "cache"), ...extra };
}

function fakeFetch(tag) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    if (tag instanceof Error) throw tag;
    return { tag, url: `https://example.invalid/${tag}`, published_at: "" };
  };
  fn.calls = calls;
  return fn;
}

function seedCache(data) {
  const p = notice.cachePath({ env: env(), home });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

async function run(opts = {}) {
  const err = [];
  const r = await notice.maybeNotify({
    argv: ["email", "list"],
    currentVersion: "3.3.0",
    env: env(),
    home,
    now: NOW,
    writeErr: (s) => err.push(s),
    ...opts,
  });
  return { r, err };
}

describe("version comparison", () => {
  it("strips the tag's v so current and latest are both bare", () => {
    expect(upgrade.bareVersion("v3.3.2")).toBe("3.3.2");
    expect(upgrade.bareVersion(" 3.3.2 ")).toBe("3.3.2");
  });

  it("a newer patch, minor or major is newer; equal and older are not", () => {
    expect(upgrade.compareVersions("v3.3.3", "3.3.2")).toBe(1);
    expect(upgrade.compareVersions("3.4.0", "3.3.9")).toBe(1);
    expect(upgrade.compareVersions("4.0.0", "3.99.99")).toBe(1);
    expect(upgrade.compareVersions("3.3.2", "v3.3.2")).toBe(0);
    expect(upgrade.compareVersions("3.3.1", "3.3.2")).toBe(-1);
  });
});

describe("upgrade --check --json shape", () => {
  it("has name, current, latest, update_available and skills", async () => {
    const result = await upgrade.checkForUpdate("3.3.1", { fetchLatest: fakeFetch("v3.3.2") });
    result.skills = skills.detectSkills({ home });
    expect(result).toMatchObject({
      name: "mail-use",
      current: "3.3.1",
      latest: "3.3.2",
      update_available: true,
      skills: [],
    });
    expect(typeof result.update_available).toBe("boolean");
  });

  it("update_available is false when already current", async () => {
    const result = await upgrade.checkForUpdate("v3.3.2", { fetchLatest: fakeFetch("v3.3.2") });
    expect(result.update_available).toBe(false);
    expect(result.current).toBe("3.3.2");
  });

  it("lists each skill with channel, path and the command that refreshes it", () => {
    fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "mail-use@leeguooooo-plugins": [{ installPath: "/p/mail-use" }], "other@x": [] } })
    );
    const found = skills.detectSkills({ home, run: () => ({ ok: false }) });
    expect(found).toEqual([
      { channel: "claude-plugin", path: "/p/mail-use", update: "claude plugin update mail-use@leeguooooo-plugins" },
    ]);
  });
});

describe("GITHUB_TOKEN", () => {
  it("is sent to api.github.com only, never to download hosts", () => {
    const e = { GITHUB_TOKEN: "t0k" };
    expect(upgrade._headers("https://api.github.com/repos/a/b/releases/latest", true, e).Authorization).toBe("Bearer t0k");
    expect(upgrade._headers("https://objects.githubusercontent.com/x", false, e).Authorization).toBeUndefined();
    expect(upgrade._headers("https://api.github.com/x", true, {}).Authorization).toBeUndefined();
  });
});

describe("daily notice: 24 h throttle", () => {
  it("no cache: checks once, writes {checked_at, latest}", async () => {
    const fetchLatest = fakeFetch("v3.4.0");
    const { r } = await run({ fetchLatest });
    expect(fetchLatest.calls).toHaveLength(1);
    expect(fetchLatest.calls[0].timeoutMs).toBe(2000);
    expect(r.checked).toBe(true);
    const cached = JSON.parse(fs.readFileSync(r.cache_path, "utf8"));
    expect(cached).toEqual({ checked_at: NOW_SEC, latest: "3.4.0" });
    expect(r.cache_path).toBe(path.join(home, "cache", "mail-use", "update-check.json"));
  });

  it("a cache younger than 24 h is used without touching the network", async () => {
    seedCache({ checked_at: NOW_SEC - DAY + 60, latest: "3.4.0" });
    const fetchLatest = fakeFetch("v9.9.9");
    const { r, err } = await run({ fetchLatest });
    expect(fetchLatest.calls).toHaveLength(0);
    expect(r.checked).toBe(false);
    expect(err.join("")).toContain("3.4.0");
  });

  it("a cache 24 h old or more is refreshed", async () => {
    seedCache({ checked_at: NOW_SEC - DAY, latest: "3.3.1" });
    const fetchLatest = fakeFetch("v3.5.0");
    const { r } = await run({ fetchLatest });
    expect(fetchLatest.calls).toHaveLength(1);
    expect(r.latest).toBe("3.5.0");
  });

  it("a cache stamped in the future counts as stale", async () => {
    seedCache({ checked_at: NOW_SEC + 3600, latest: "3.3.0" });
    const fetchLatest = fakeFetch("v3.5.0");
    await run({ fetchLatest });
    expect(fetchLatest.calls).toHaveLength(1);
  });

  it("a failed check is silent but still stamps checked_at, keeping the last known latest", async () => {
    seedCache({ checked_at: NOW_SEC - 2 * DAY, latest: "3.4.0" });
    const { r, err } = await run({ fetchLatest: fakeFetch(new Error("getaddrinfo ENOTFOUND")) });
    const cached = JSON.parse(fs.readFileSync(r.cache_path, "utf8"));
    expect(cached).toEqual({ checked_at: NOW_SEC, latest: "3.4.0" });
    // No error text leaks; only the (still valid) notice.
    expect(err.join("")).not.toMatch(/ENOTFOUND/);
    // And the next call inside the day does not retry.
    const again = fakeFetch("v3.5.0");
    await run({ fetchLatest: again, now: NOW + 60_000 });
    expect(again.calls).toHaveLength(0);
  });

  it("a fetch that never answers is cut off at the deadline", async () => {
    const hang = () => new Promise(() => {});
    const t0 = Date.now();
    const { r, err } = await run({ fetchLatest: hang, timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.checked).toBe(true);
    expect(err).toEqual([]);
  });

  it("a corrupt cache file is treated as missing", async () => {
    const p = notice.cachePath({ env: env(), home });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{not json");
    const fetchLatest = fakeFetch("v3.3.0");
    await run({ fetchLatest });
    expect(fetchLatest.calls).toHaveLength(1);
  });

  it("falls back to ~/.cache without XDG_CACHE_HOME", () => {
    expect(notice.cachePath({ env: {}, home: "/h" })).toBe(path.join("/h", ".cache", "mail-use", "update-check.json"));
  });
});

describe("daily notice: what it prints", () => {
  it("prints exactly the family line when a newer version is cached", async () => {
    seedCache({ checked_at: NOW_SEC, latest: "3.4.0" });
    const { err } = await run({ fetchLatest: fakeFetch("v0.0.0") });
    expect(err).toEqual(["mail-use 3.4.0 is available (you have 3.3.0). Upgrade: mail-use upgrade\n"]);
  });

  it("prints nothing when current or ahead", async () => {
    seedCache({ checked_at: NOW_SEC, latest: "3.3.0" });
    expect((await run()).err).toEqual([]);
    expect((await run({ currentVersion: "3.9.0" })).err).toEqual([]);
  });
});

describe("daily notice: opt-outs", () => {
  for (const k of ["CI", "MAIL_USE_NO_UPDATE_CHECK", "USE_NO_UPDATE_CHECK"]) {
    it(`${k} set: no check, no cache, no notice`, async () => {
      const fetchLatest = fakeFetch("v9.0.0");
      const { r, err } = await run({ fetchLatest, env: env({ [k]: "1" }) });
      expect(r.skipped).toBe(k);
      expect(fetchLatest.calls).toHaveLength(0);
      expect(err).toEqual([]);
      expect(fs.existsSync(notice.cachePath({ env: env(), home }))).toBe(false);
    });
  }

  it("an empty variable is not an opt-out", () => {
    expect(notice.disabledReason({ CI: "" })).toBe("");
  });

  it("MAILBOX_UPDATE_CHECK_HOURS=0 (the daemon's knob) also turns it off", () => {
    expect(notice.disabledReason({ MAILBOX_UPDATE_CHECK_HOURS: "0" })).toBe("MAILBOX_UPDATE_CHECK_HOURS");
    expect(notice.disabledReason({ MAILBOX_UPDATE_CHECK_HOURS: "24" })).toBe("");
  });

  it("is skipped for upgrade, --version, --help and long-running servers", () => {
    for (const argv of [["upgrade"], ["upgrade", "--check"], ["--version"], ["-v"], ["email", "list", "--help"], ["-h"], ["help"], ["daemon", "run"], ["daemon", "start", "--sync-interval", "300"], ["mcp", "serve"], []]) {
      expect(notice.skippedForArgv(argv), argv.join(" ")).not.toBe("");
    }
    for (const argv of [["email", "list"], ["daemon", "status"], ["mcp", "config"]]) {
      expect(notice.skippedForArgv(argv), argv.join(" ")).toBe("");
    }
  });
});

describe("daily notice through the real CLI: stderr only", () => {
  const cli = path.join(import.meta.dirname, "..", "bin", "mail-use.js");

  // A copy of the runner's env minus every notice opt-out (GitHub Actions sets
  // CI=true). Passed with extendEnv:false — execa otherwise merges process.env
  // back in and CI returns.
  function cliEnv(extra = {}) {
    const e = { ...process.env };
    for (const k of ["CI", "MAIL_USE_NO_UPDATE_CHECK", "USE_NO_UPDATE_CHECK", "MAILBOX_INTERNAL_TEST_MODE", "MAILBOX_UPDATE_CHECK_HOURS"]) delete e[k];
    return {
      ...e,
      HOME: home,
      XDG_CACHE_HOME: path.join(home, "cache"),
      MAILBOX_CONFIG_DIR: path.join(home, "config"),
      MAILBOX_DATA_DIR: path.join(home, "data"),
      MAILBOX_NO_DAEMON: "1",
      MAILBOX_CLI_VERSION: "3.3.0",
      ...extra,
    };
  }

  // A fresh cache means the CLI never goes to the network in these tests.
  beforeEach(() => {
    seedCache({ checked_at: Math.floor(Date.now() / 1000), latest: "3.4.0" });
  });

  it("stdout stays parseable JSON; the notice is the only stderr line", async () => {
    const r = await execa("node", [cli, "mcp", "config", "--json"], { env: cliEnv(), extendEnv: false, reject: false });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).success).toBe(true);
    expect(r.stdout).not.toMatch(/is available/);
    expect(r.stderr).toBe("mail-use 3.4.0 is available (you have 3.3.0). Upgrade: mail-use upgrade");
  });

  it("MAIL_USE_NO_UPDATE_CHECK silences it", async () => {
    const r = await execa("node", [cli, "mcp", "config", "--json"], { env: cliEnv({ MAIL_USE_NO_UPDATE_CHECK: "1" }), extendEnv: false, reject: false });
    expect(r.stderr).toBe("");
  });

  it("CI=1 silences it", async () => {
    const r = await execa("node", [cli, "mcp", "config", "--json"], { env: cliEnv({ CI: "1" }), extendEnv: false, reject: false });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("--version prints just the version", async () => {
    const r = await execa("node", [cli, "--version"], { env: cliEnv(), extendEnv: false, reject: false });
    expect(r.stdout.trim()).toBe("3.3.0");
    expect(r.stderr).toBe("");
  });
});

describe("skill refresh", () => {
  function mkSkill(dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "# mail-use\n");
  }

  it("a git checkout is found through its skills link and pulled with --ff-only", () => {
    const repo = path.join(home, "src", "mail-use");
    mkSkill(path.join(repo, "skills", "mail-use"));
    execFileSync("git", ["init", "-q", repo]);
    fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
    fs.symlinkSync(path.join(repo, "skills", "mail-use"), path.join(home, ".agents", "skills", "mail-use"));
    // A second door into the same checkout is one install, not two.
    fs.mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
    fs.symlinkSync(path.join(repo, "skills", "mail-use"), path.join(home, ".codex", "skills", "mail-use"));

    const found = skills.detectSkills({ home });
    expect(found).toHaveLength(1);
    expect(found[0].channel).toBe("git");
    const root = fs.realpathSync(repo);
    expect(found[0].root).toBe(root);
    expect(found[0].update).toBe(`git -C ${root} pull --ff-only`);

    const calls = [];
    const [done] = skills.refreshSkills(found, { run: (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, stdout: "Already up to date.\n" }; } });
    expect(calls).toEqual([["git", "-C", root, "pull", "--ff-only"]]);
    expect(done.status).toBe("updated");
  });

  it("a skills dir inside someone else's repo (dotfiles tracking ~/.claude) is never pulled", () => {
    // ~/.claude is a dotfiles checkout; the skill is a plain folder inside it.
    execFileSync("git", ["init", "-q", path.join(home, ".claude")]);
    mkSkill(path.join(home, ".claude", "skills", "mail-use"));
    const found = skills.detectSkills({ home });
    expect(found).toEqual([{ channel: "copied", path: path.join(home, ".claude", "skills", "mail-use"), update: "npx skills update mail-use" }]);
    const calls = [];
    skills.refreshSkills(found, { run: (...a) => { calls.push(a); return { ok: true }; } });
    expect(calls).toEqual([]);
  });

  it("a skill folder that is its own git clone is still the git channel", () => {
    const dir = path.join(home, ".claude", "skills", "mail-use");
    mkSkill(dir);
    execFileSync("git", ["init", "-q", dir]);
    const found = skills.detectSkills({ home });
    expect(found).toHaveLength(1);
    expect(found[0].channel).toBe("git");
    expect(found[0].root).toBe(fs.realpathSync(dir));
  });

  it("a pull that cannot fast-forward is reported, not forced", () => {
    const s = { channel: "git", path: "/p", root: "/r", update: "git -C /r pull --ff-only" };
    const [r] = skills.refreshSkills([s], { run: () => ({ ok: false, status: 128, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" }) });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/fast-forward/);
    expect(skills.formatSkillLine(r)).toContain("git -C /r pull --ff-only");
  });

  it("a copied folder (npx skills add, symlinked into .claude) is reported once and never run", () => {
    mkSkill(path.join(home, ".agents", "skills", "mail-use"));
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(path.join(home, ".agents", "skills", "mail-use"), path.join(home, ".claude", "skills", "mail-use"));
    const found = skills.detectSkills({ home, run: () => ({ ok: false }) });
    expect(found).toEqual([{ channel: "copied", path: path.join(home, ".agents", "skills", "mail-use"), update: "npx skills update mail-use" }]);
    const calls = [];
    const [r] = skills.refreshSkills(found, { run: (...a) => { calls.push(a); return { ok: true }; } });
    expect(calls).toEqual([]);
    expect(r.status).toBe("manual");
  });

  it("claude plugin: runs `claude plugin update` when claude is on PATH, prints it otherwise", () => {
    const s = { channel: "claude-plugin", path: "/p", update: "claude plugin update mail-use@leeguooooo-plugins" };
    const calls = [];
    const [ran] = skills.refreshSkills([s], { which: () => "/bin/claude", run: (cmd, args) => { calls.push([cmd, ...args]); return { ok: true }; } });
    expect(calls).toEqual([["claude", "plugin", "update", "mail-use@leeguooooo-plugins"]]);
    expect(ran.status).toBe("updated");

    const [printed] = skills.refreshSkills([s], { which: () => "", run: () => { throw new Error("must not run"); } });
    expect(printed.status).toBe("manual");
    expect(skills.formatSkillLine(printed)).toContain("claude plugin update mail-use@leeguooooo-plugins");
  });

  it("finds nothing in an empty home", () => {
    expect(skills.detectSkills({ home })).toEqual([]);
  });
});
