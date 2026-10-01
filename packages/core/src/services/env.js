// Environment switches the IMAP/SMTP services share. Read per call (not at
// module load) so tests and the daemon can flip them at runtime.

// Internal sentinel only — kept narrowly named to avoid colliding with any env
// a user might set. Tests must opt in explicitly.
function _isTestMode() {
  return String(process.env.MAILBOX_INTERNAL_TEST_MODE || "").trim() === "1";
}

function _allowInsecureTls() {
  return String(process.env.MAILBOX_ALLOW_INSECURE_TLS || "").trim() === "1";
}

module.exports = { _isTestMode, _allowInsecureTls };
