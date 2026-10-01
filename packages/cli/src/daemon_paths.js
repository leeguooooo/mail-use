// Where the daemon's socket and pid file live.
//
// Kept apart from daemon.js on purpose: every CLI call needs the socket path to
// decide whether to talk to a daemon, and daemon.js pulls in @mail-use/core and
// the IMAP pool (imapflow) at load time. Requiring it just for a path cost tens
// of milliseconds on every invocation, including `--version`.

const os = require("os");
const path = require("path");

function getSocketPath() {
  if (process.env.MAILBOX_DAEMON_SOCKET) return process.env.MAILBOX_DAEMON_SOCKET;
  const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache", "mailbox");
  return path.join(base, `daemon-${process.getuid ? process.getuid() : "x"}.sock`);
}

function getPidFilePath() {
  return getSocketPath().replace(/\.sock$/, ".pid");
}

// What the pid file says, and whether that process still exists. Lets
// `daemon status` tell "not running" apart from "running but not answering".
function readDaemonPid(pidFile = getPidFilePath()) {
  let raw;
  try { raw = require("fs").readFileSync(pidFile, "utf8"); } catch { return null; }
  const pid = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { pid: null, alive: false, path: pidFile };
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    // EPERM: it exists, it just isn't ours to signal.
    alive = Boolean(e && e.code === "EPERM");
  }
  return { pid, alive, path: pidFile };
}

module.exports = { getSocketPath, getPidFilePath, readDaemonPid };
