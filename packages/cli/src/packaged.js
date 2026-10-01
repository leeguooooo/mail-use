// Are we the released single-file binary (as opposed to `node bin/mail-use.js`
// in a checkout)? Release binaries are Node SEA builds; `process.pkg` covers
// binaries built with pkg before the switch, which may still be installed.
// In a release binary process.execPath IS the mail-use executable; in a
// checkout it is node, which must never be self-replaced or written into a
// launchd/systemd unit as if it were the CLI.

function isPackagedBinary() {
  if (process.pkg !== undefined) return true;
  try {
    return require("node:sea").isSea();
  } catch {
    // node:sea is missing before Node 20; nothing older is a SEA build.
    return false;
  }
}

module.exports = { isPackagedBinary };
