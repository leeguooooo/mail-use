// IMAP IDLE watcher: a long-lived, unpooled connection that reports new mail.

const accounts = require("../accounts");
const { formatDateTime, firstAddress, hasAttachmentsFromBodyStructure } = require("../format");
const { _normalizeFolder, _gid } = require("./internals");

// Watch a folder for new mail using IMAP IDLE. Long-running. Calls
// onEvent({type, email}) for every newly-arriving message that matches
// the optional filter. Resolves when stop() (returned from this fn)
// is invoked or the connection dies fatally.
//
// Note: this opens its own ImapFlow connection (not pooled) — IDLE
// holds the connection mostly-idle and re-issuing IDLE on every
// pooled-acquire would defeat the purpose.
async function watchFolder({ account_id, folder = "INBOX", filter = {}, onEvent } = {}) {
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return { success: false, error: acc.error || "account lookup failed", error_code: "account_not_found" };
  const openFolder = _normalizeFolder(folder);

  const fromQ = String(filter.from || "").toLowerCase();
  const subjQ = String(filter.subject || "").toLowerCase();
  const matches = (env) => {
    if (fromQ) {
      const f = (firstAddress(env.from) || "").toLowerCase();
      if (!f.includes(fromQ)) return false;
    }
    if (subjQ) {
      const s = String(env.subject || "").toLowerCase();
      if (!s.includes(subjQ)) return false;
    }
    return true;
  };

  const { ImapFlow } = require("imapflow");
  const port = Number(acc.account.imap.port);
  const secure = Boolean(acc.account.imap.secure);
  const client = new ImapFlow({
    host: acc.account.imap.host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: acc.account.email, pass: acc.account.password },
    tls: { rejectUnauthorized: !(String(process.env.MAILBOX_ALLOW_INSECURE_TLS || "").trim() === "1"), minVersion: "TLSv1.2" },
    logger: false,
  });

  let stopped = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  // An unhandled 'error' event would crash the process. The 'close' handler
  // below is what reports the disconnect; this only keeps the error handled.
  client.on("error", (err) => {
    if (process.env.MAILBOX_DEBUG) process.stderr.write(`mail-use: watch connection error for ${acc.account.email}: ${(err && err.message) || err}\n`);
  });

  try {
    await client.connect();
    await client.mailboxOpen(openFolder);
  } catch (e) {
    // Don't leak a connected socket when the folder can't be opened.
    try { await client.logout(); } catch { /* ignore */ }
    try { if (typeof client.close === "function") client.close(); } catch { /* ignore */ }
    throw e;
  }
  let lastUid = client.mailbox && client.mailbox.uidNext ? Number(client.mailbox.uidNext) : 0;

  // Serialize concurrent `exists` events: if a fetch is already running,
  // remember that we need another pass. Without this, two events that
  // arrive close together can fetch the same range twice and emit
  // duplicate `new_email` callbacks.
  let fetchInFlight = false;
  let fetchPending = false;
  const seenUids = new Set();

  const fetchSince = async () => {
    if (fetchInFlight) { fetchPending = true; return; }
    fetchInFlight = true;
    try {
      do {
        fetchPending = false;
        if (!lastUid) break;
        try {
          const since = `${lastUid}:*`;
          for await (const msg of client.fetch(
            since,
            { envelope: true, flags: true, internalDate: true, bodyStructure: true },
            { uid: true }
          )) {
            const uidNum = Number(msg.uid);
            if (!Number.isFinite(uidNum)) continue;
            if (uidNum < lastUid) continue;          // `:*` lower-bound is inclusive
            if (seenUids.has(uidNum)) continue;      // already emitted across passes
            const env = msg.envelope || {};
            // Always advance lastUid even when filter rejects the message,
            // so later fetches don't re-scan it.
            lastUid = Math.max(lastUid, uidNum + 1);
            seenUids.add(uidNum);
            // Cap the dedup set so a long-running watcher doesn't grow
            // memory unbounded.
            if (seenUids.size > 4096) {
              const oldest = [...seenUids].slice(0, seenUids.size - 2048);
              for (const u of oldest) seenUids.delete(u);
            }
            if (!matches(env)) continue;
            const flags = msg.flags || new Set([]);
            const item = {
              id: String(uidNum),
              uid: String(uidNum),
              gid: _gid(acc.account.id, openFolder, uidNum),
              message_id: env.messageId || "",
              subject: env.subject || "",
              from: firstAddress(env.from),
              date: formatDateTime(msg.internalDate || env.date),
              unread: !flags.has("\\Seen"),
              has_attachments: hasAttachmentsFromBodyStructure(msg.bodyStructure),
              account: acc.account.email,
              account_id: acc.account.id,
              folder: openFolder,
              source: "imap_idle",
            };
            if (typeof onEvent === "function") {
              try { onEvent({ type: "new_email", email: item }); } catch { /* ignore */ }
            }
          }
        } catch (e) {
          if (typeof onEvent === "function") {
            try { onEvent({ type: "fetch_error", error: e && e.message ? e.message : String(e) }); } catch { /* ignore */ }
          }
        }
      } while (fetchPending && !stopped);
    } finally {
      fetchInFlight = false;
    }
  };

  client.on("exists", () => { fetchSince(); });
  client.on("close", () => {
    if (!stopped && typeof onEvent === "function") {
      try { onEvent({ type: "disconnected" }); } catch { /* ignore */ }
    }
    stopped = true;
    resolveDone({ success: true, stopped: true });
  });

  // Kick off the IDLE loop. ImapFlow re-issues IDLE internally roughly
  // every 28 minutes; we don't have to wrap it.
  (async () => {
    while (!stopped) {
      try {
        await client.idle();
      } catch (e) {
        if (stopped) break;
        if (typeof onEvent === "function") {
          try { onEvent({ type: "idle_error", error: e && e.message ? e.message : String(e) }); } catch { /* ignore */ }
        }
        // Brief backoff before re-issuing IDLE.
        await new Promise((r) => { setTimeout(r, 2000); });
      }
    }
  })();

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { await client.logout(); } catch { /* ignore */ }
    resolveDone({ success: true, stopped: true });
  };

  return { success: true, watching: true, folder: openFolder, account_id: acc.account.id, stop, done };
}

module.exports = { watchFolder };
