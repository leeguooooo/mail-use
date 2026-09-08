// Resolving "which version am I" needs to work from both main.js (for --version
// and `upgrade`) and daemon.js (for the passive update check). Having daemon.js
// require main.js for it would be a circular require, so it lives on its own.

const fs = require("fs");
const path = require("path");

function getCliVersion() {
  const env = process.env.MAILBOX_CLI_VERSION || process.env.MAILBOX_VERSION || "";
  if (env && typeof env === "string" && env.trim()) return env.trim();

  // Version baked into the binary at release-build time (see _version.js). pkg
  // bundles this statically-required module, so the compiled binary reports the
  // real version even though it can't read package.json at runtime. Skipped when
  // still the "0.0.0" default (dev / unstamped) so we fall through to package.json.
  try {
    const baked = require("./_version.js");
    if (baked && typeof baked === "string" && baked.trim() && baked.trim() !== "0.0.0") {
      return baked.trim();
    }
  } catch {
    // ignore — fall through to package.json
  }

  const candidates = [
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
    path.join(process.cwd(), "package.json"),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      const version = parsed && parsed.version ? String(parsed.version).trim() : "";
      if (version) return version;
    } catch {
      // ignore
    }
  }

  return "0.0.0";
}

module.exports = { getCliVersion };
