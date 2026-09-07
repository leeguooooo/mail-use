const fs = require("fs");
const path = require("path");

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function setPackageVersion(pkgPath, version) {
  const pkg = readJson(pkgPath);
  pkg.version = version;
  writeJson(pkgPath, pkg);
}

function setLauncherOptionalDepVersions(pkgPath, version, platforms) {
  const pkg = readJson(pkgPath);
  pkg.optionalDependencies = pkg.optionalDependencies || {};
  for (const name of platforms) {
    pkg.optionalDependencies[name] = version;
  }
  writeJson(pkgPath, pkg);
}

function updateSkillMd(skillPath, version) {
  if (!fs.existsSync(skillPath)) return;
  const raw = fs.readFileSync(skillPath, "utf8");
  if (!raw.startsWith("---\n")) return;
  const parts = raw.split("---\n");
  if (parts.length < 3) return;
  const frontmatter = parts[1];
  const rest = "---\n" + parts.slice(2).join("---\n");

  const lines = frontmatter.split("\n");
  let found = false;
  const out = lines.map((line) => {
    if (line.startsWith("version:")) {
      found = true;
      return `version: ${version}`;
    }
    return line;
  });
  if (!found) out.push(`version: ${version}`);

  const merged = "---\n" + out.join("\n") + "---\n" + rest;
  fs.writeFileSync(skillPath, merged, "utf8");
}

function main() {
  const arg = process.argv[2] || "";
  const version = arg.startsWith("v") ? arg.slice(1) : arg;
  if (!version) die("Usage: node scripts/set_release_version.js vX.Y.Z");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    die(`Invalid version: ${version}`);
  }

  const repoRoot = path.resolve(__dirname, "..");

  const launcherPkg = path.join(repoRoot, "mail-use-npm", "packages", "mail-use", "package.json");
  if (!fs.existsSync(launcherPkg)) die(`Missing launcher package.json: ${launcherPkg}`);

  const launcher = readJson(launcherPkg);
  const launcherName = String(launcher.name || "mail-use");
  const scope = launcherName.includes("/") ? launcherName.split("/")[0] : "";

  const baseNames = ["mail-use-darwin-arm64", "mail-use-darwin-x64", "mail-use-linux-x64-gnu"];
  const platforms = baseNames.map((n) => (scope ? `${scope}/${n}` : n));

  // Platform package versions.
  for (const name of platforms) {
    const dirName = name.includes("/") ? name.split("/")[1] : name;
    const pkgPath = path.join(repoRoot, "mail-use-npm", "packages", dirName, "package.json");
    if (!fs.existsSync(pkgPath)) die(`Missing platform package.json: ${pkgPath}`);
    setPackageVersion(pkgPath, version);
  }

  // Launcher version + optionalDependencies.
  setPackageVersion(launcherPkg, version);
  setLauncherOptionalDepVersions(launcherPkg, version, platforms);

  // Optional: keep SKILL.md version aligned.
  updateSkillMd(path.join(repoRoot, "SKILL.md"), version);
}

main();
