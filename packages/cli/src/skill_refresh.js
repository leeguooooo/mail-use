// Find every copy of the mail-use skill and refresh it the way it was installed.
//
// Replacing the binary does not move a SKILL.md that lives somewhere else, so an
// upgrade that stops at the binary leaves agents reading instructions for the
// old CLI. Channels, per the *-use family convention (plugins docs/upgrade.md):
//
//   claude-plugin  ~/.claude/plugins/installed_plugins.json has "mail-use@…"
//                  -> `claude plugin update <key>` if claude is on PATH, else print it
//   git            ~/.agents|.claude|.codex/skills/mail-use resolves into a git work tree
//                  -> `git -C <root> pull --ff-only`; on failure say why, never force
//   copied         a plain folder with SKILL.md (e.g. `npx skills add`)
//                  -> print `npx skills update mail-use`; don't run it
//
// mail-use's install.sh installs only the binary, so there is no
// installer-managed channel here.
//
// Kept apart from upgrade.js on purpose: that module's only subprocess is tar,
// and a test holds it to that.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const NAME = "mail-use";
const SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"];

function _run(cmd, args, { timeoutMs = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  return {
    ok: r.status === 0 && !r.error,
    status: r.status,
    stdout: String(r.stdout || ""),
    stderr: String(r.stderr || (r.error && r.error.message) || ""),
  };
}

function _which(cmd, env = process.env) {
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return "";
}

// installed_plugins.json has been both {"plugins": {key: …}} and a flat map;
// entries are an object (v1) or a list of per-scope objects (v2).
function _pluginEntries(home) {
  const p = path.join(home, ".claude", "plugins", "installed_plugins.json");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
  const map = data && typeof data.plugins === "object" && data.plugins ? data.plugins : data || {};
  const out = [];
  for (const [key, val] of Object.entries(map)) {
    if (!key.startsWith(`${NAME}@`)) continue;
    const first = Array.isArray(val) ? val[0] : val;
    const installPath = first && typeof first === "object" && first.installPath ? String(first.installPath) : "";
    out.push({ key, path: installPath || p });
  }
  return out;
}

function _gitRoot(dir, run) {
  const r = run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() : "";
}

function _realOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function _isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Only a git work tree that belongs to the skill counts as the git channel:
// either the skill folder is the checkout itself, or the skills link points into
// a separate checkout (e.g. ~/src/mail-use/skills/mail-use). When the skills
// directory itself sits inside the repo — a dotfiles repo tracking ~ or
// ~/.claude, a personal skills repo — `git pull` would move someone else's
// repository, so treat it as a plain folder instead.
function _ownedGitRoot(real, skillsDir, run) {
  const root = _gitRoot(real, run);
  if (!root) return "";
  const rootReal = _realOr(root);
  if (rootReal === _realOr(real)) return root;
  if (_isWithin(_realOr(skillsDir), rootReal)) return "";
  return root;
}

// Returns [{channel, path, update}] — what exists, touching nothing.
function detectSkills({ home = os.homedir(), run = _run } = {}) {
  const skills = [];
  for (const e of _pluginEntries(home)) {
    skills.push({ channel: "claude-plugin", path: e.path, update: `claude plugin update ${e.key}` });
  }

  const seen = new Set();
  for (const rel of SKILL_DIRS) {
    const link = path.join(home, rel, NAME);
    let real;
    try {
      real = fs.realpathSync(link);
      if (!fs.statSync(real).isDirectory()) continue;
    } catch {
      continue; // absent or a dangling link
    }
    // `npx skills add` links ~/.claude/skills/<n> to ~/.agents/skills/<n>;
    // one install found through two doors is still one install.
    const root = _ownedGitRoot(real, path.join(home, rel), run);
    const key = root || real;
    if (seen.has(key)) continue;
    seen.add(key);
    if (root) {
      skills.push({ channel: "git", path: link, root, update: `git -C ${root} pull --ff-only` });
    } else if (fs.existsSync(path.join(real, "SKILL.md"))) {
      skills.push({ channel: "copied", path: link, update: `npx skills update ${NAME}` });
    }
  }
  return skills;
}

function _firstLine(s) {
  return String(s || "").trim().split("\n").filter(Boolean).pop() || "";
}

// Acts on detectSkills() output. Each entry gains `status`:
//   updated | failed (with `error`) | manual (run `update` yourself)
function refreshSkills(skills, { run = _run, which = _which } = {}) {
  return skills.map((s) => {
    if (s.channel === "claude-plugin") {
      if (!which("claude")) return { ...s, status: "manual", reason: "claude is not on PATH" };
      const args = s.update.split(" ").slice(1);
      const r = run("claude", args);
      return r.ok ? { ...s, status: "updated" } : { ...s, status: "failed", error: _firstLine(r.stderr) || `exit ${r.status}` };
    }
    if (s.channel === "git") {
      const r = run("git", ["-C", s.root, "pull", "--ff-only"]);
      if (r.ok) return { ...s, status: "updated", detail: _firstLine(r.stdout) };
      // Diverged or dirty checkouts belong to whoever edited them; report, don't force.
      return { ...s, status: "failed", error: _firstLine(r.stderr) || `exit ${r.status}` };
    }
    return { ...s, status: "manual" };
  });
}

function formatSkillLine(s) {
  const head = `  skill (${s.channel}) ${s.path}`;
  if (!s.status) return `${head}\n    update: ${s.update}`;
  if (s.status === "updated") return `${head}: updated`;
  if (s.status === "failed") return `${head}: refresh failed (${s.error})\n    run: ${s.update}`;
  return `${head}: run ${s.update}${s.reason ? ` (${s.reason})` : ""}`;
}

module.exports = { detectSkills, refreshSkills, formatSkillLine, _which };
