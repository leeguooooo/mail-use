#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");

function _die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function _platformPackageName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "@leeguoo/mail-use-darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "@leeguoo/mail-use-darwin-x64";
  if (platform === "linux" && arch === "x64") return "@leeguoo/mail-use-linux-x64-gnu";

  return "";
}

function _requirePlatformPackage(name) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(name);
  } catch {
    // In a source checkout, allow running without publishing by using a
    // relative require from mail-use-npm/packages/.
    const unscoped = name.includes("/") ? name.split("/")[1] : name;
    const rel = path.join(__dirname, "..", "..", unscoped);
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(rel);
  }
}

function main() {
  const pkg = _platformPackageName();
  if (!pkg) {
    _die(`Unsupported platform: ${process.platform} ${process.arch}`);
  }

  let launcherVersion = "";
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const launcherPkg = require(path.join(__dirname, "..", "package.json"));
    launcherVersion = launcherPkg && launcherPkg.version ? String(launcherPkg.version) : "";
  } catch {
    launcherVersion = "";
  }

  const mod = _requirePlatformPackage(pkg);
  const binaryPath = mod && mod.binaryPath;
  if (!binaryPath) {
    _die(`Failed to resolve mail-use binary from ${pkg}`);
  }

  const args = process.argv.slice(2);
  const env = { ...process.env };
  if (launcherVersion) env.MAILBOX_CLI_VERSION = launcherVersion;
  const r = spawnSync(binaryPath, args, { stdio: "inherit", env });
  if (typeof r.status === "number") process.exit(r.status);
  process.exit(1);
}

main();
