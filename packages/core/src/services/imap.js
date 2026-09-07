function _isTestMode() {
  return String(process.env.MAILBOX_INTERNAL_TEST_MODE || "").trim() === "1";
}

function _allowInsecureTls() {
  return String(process.env.MAILBOX_ALLOW_INSECURE_TLS || "").trim() === "1";
}

// Optional persistent connection pool. The mailbox daemon installs one
// here at startup; everything else (one-shot CLI, tests) leaves it null
// and gets the original "open + use + logout" behavior.
let _GLOBAL_POOL = null;
function setGlobalPool(pool) { _GLOBAL_POOL = pool; }
function getGlobalPool() { return _GLOBAL_POOL; }

async function withImapClient(account, fn) {
  if (_isTestMode()) {
    const { createMockImapClient } = require("../testing/mock_imap_client");
    const client = createMockImapClient(account);
    return fn(client);
  }
  if (_GLOBAL_POOL) {
    return _GLOBAL_POOL.withClient(account, fn);
  }

  const { ImapFlow } = require("imapflow");
  const port = Number(account.imap.port);
  const secure = Boolean(account.imap.secure);
  const tls = {
    rejectUnauthorized: !_allowInsecureTls(),
    minVersion: "TLSv1.2",
  };
  // Implicit TLS (993): connect over TLS. Otherwise require STARTTLS to refuse plaintext.
  const client = new ImapFlow({
    host: account.imap.host,
    port,
    secure,
    requireTLS: !secure,
    auth: {
      user: account.email,
      pass: account.password,
    },
    tls,
    logger: false,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
}

async function testConnection(account, folder) {
  const openFolder = String(folder || "INBOX") || "INBOX";
  return withImapClient(account, async (client) => {
    const lock = typeof client.getMailboxLock === "function" ? await client.getMailboxLock(openFolder) : null;
    try {
      if (typeof client.mailboxOpen === "function") {
        // Ensure mailbox is selected and mailbox stats are updated.
        // eslint-disable-next-line no-await-in-loop
        await client.mailboxOpen(openFolder);
      }

      const mb = client.mailbox || {};
      const total = Number(mb.exists || 0);
      // `mb.unseen` is the SEQUENCE of the first unseen message (often
      // undefined on Gmail), not the unread count. STATUS UNSEEN gives
      // the real number. Surface the failure explicitly so callers can
      // tell "0 unread" from "we couldn't ask".
      let unseen = 0;
      let unreadError = null;
      try {
        const ss = await client.status(openFolder, { unseen: true });
        if (ss && ss.unseen != null) unseen = Number(ss.unseen);
      } catch (e) {
        unreadError = (e && e.message) || String(e);
        if (process.env.MAILBOX_DAEMON_DEBUG) process.stderr.write(`mail-use: STATUS UNSEEN failed for ${account.email}/${openFolder}: ${unreadError}\n`);
      }
      const out = { success: true, total_emails: total, unread_emails: unseen };
      if (unreadError) { out.unread_emails_unavailable = true; out.unread_emails_error = unreadError; }
      return out;
    } finally {
      if (lock && typeof lock.release === "function") lock.release();
    }
  });
}

module.exports = {
  withImapClient,
  testConnection,
  setGlobalPool,
  getGlobalPool,
};
