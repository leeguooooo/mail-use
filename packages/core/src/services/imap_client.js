// The one place an ImapFlow connection is constructed. One-shot calls
// (imap.js), the daemon pool (imap_pool.js) and the IDLE watcher all build
// their clients here so TLS policy and auth stay identical everywhere.

const { _allowInsecureTls } = require("./env");

// Not connected yet: the caller decides when to connect() and how to bound it.
//
// onError is attached before anything else can happen. ImapFlow is an
// EventEmitter and re-emits socket failures (ECONNRESET, TLS errors,
// server-side timeouts) as 'error'; with no listener Node turns that into an
// uncaught exception and the process dies. Each caller passes its own listener
// (what it logs, and when), but there is always one.
function createImapClient(account, { onError } = {}) {
  const { ImapFlow } = require("imapflow");
  const port = Number(account.imap.port);
  const secure = Boolean(account.imap.secure);
  // Implicit TLS (993): connect over TLS. Otherwise require STARTTLS to refuse plaintext.
  // ImapFlow's switch is doSTARTTLS (requireTLS is nodemailer's name and ImapFlow
  // ignores it): true fails the connect when the server offers no STARTTLS,
  // where undefined would quietly carry on in cleartext, password included.
  // secure=true together with doSTARTTLS=true is rejected by ImapFlow.
  const client = new ImapFlow({
    host: account.imap.host,
    port,
    secure,
    doSTARTTLS: secure ? undefined : true,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: !_allowInsecureTls(), minVersion: "TLSv1.2" },
    logger: false,
  });
  client.on("error", typeof onError === "function" ? onError : () => {});
  return client;
}

module.exports = { createImapClient };
