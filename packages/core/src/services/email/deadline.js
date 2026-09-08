// Wall-clock bounds for searches. QQ/163 have broken IMAP SEARCH, so the CLI
// falls back to scanning a folder client-side, and a single stuck account must
// not be able to hang the whole call.

function _deadlineExceeded(started, timeoutMs, now) {
  const t = Number(timeoutMs || 0);
  if (!(t > 0)) return false;
  return (Number(now != null ? now : Date.now()) - Number(started)) >= t;
}

// HARD wall-clock bound: resolve with `promise`'s value, or `onTimeout()` if it
// doesn't settle within `ms`. The cooperative _deadlineExceeded checks only fire
// BETWEEN imap operations; a single slow op (e.g. a QQ/163 client-side scan of a
// whole INBOX, or a stuck connect) can block past the deadline. This guarantees
// searchEmails returns even then. The orphaned op is harmless for the one-shot
// CLI (process.exit cleans up); the daemon closes the connection on its own.
// `promise` rejections pass through so existing try/catch handling still runs.
function _raceTimeout(promise, ms, onTimeout) {
  if (!(ms > 0)) return promise;
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    guard,
  ]);
}

module.exports = {
  _deadlineExceeded,
  _raceTimeout,
};
