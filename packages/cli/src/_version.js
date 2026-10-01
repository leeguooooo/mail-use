// Baked CLI version. This default is overwritten at release-build time (see
// .github/workflows/release-binaries.yml) BEFORE the binary build, so the compiled
// binary reports the real version. It's a plain JS module (statically required by
// main.js) so the bundler embeds it in the binary — unlike package.json, which the binary
// can't read at runtime, and which can't be version-stamped without breaking the
// frozen pnpm lockfile. Left as "0.0.0" in git; never commit a real version here.
module.exports = "0.0.0";
