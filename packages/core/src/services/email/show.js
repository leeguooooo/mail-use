// show: full message bodies, single or batched, with folder resolution from
// gids and the local cache.

const accounts = require("../accounts");
const { withImapClient } = require("../imap");
const { _isTestMode } = require("../env");
const { formatDateTime, firstAddress, attachmentFlags } = require("../format");
const syncDb = require("../../storage/sync_db");
const { _normalizeFolder, _gid } = require("./internals");
const { _parseUidList } = require("./batch");
const { _safeParse, _fetchFullMessages, _loadParsedMessage } = require("./message_source");
const { _composeBody, _extractListUnsubscribe } = require("./body");
const { _syncDbPath } = require("./cache");

// The per-message fields show/showEmails report, from a fetched message and
// its parsed source.
function _messageFields(account, openFolder, msg, parsed, { body_max_len, html_max_len, include_html, strip_urls }) {
  const flags = msg.flags || new Set([]);
  const attachments = (parsed.attachments || []).map((a) => ({
    filename: a.filename || "",
    size: a.size || 0,
    content_type: a.contentType || "application/octet-stream",
    ...attachmentFlags(a),
  }));
  const composed = _composeBody({
    text: parsed.text,
    html: parsed.html,
    body_max_len,
    html_max_len,
    include_html,
    strip_urls,
  });
  return {
    id: String(msg.uid),
    gid: _gid(account.id, openFolder, msg.uid),
    from: parsed.from ? parsed.from.text || "" : firstAddress(msg.envelope && msg.envelope.from),
    to: parsed.to ? parsed.to.text || "" : firstAddress(msg.envelope && msg.envelope.to),
    cc: parsed.cc ? parsed.cc.text || "" : "",
    subject: parsed.subject || (msg.envelope ? msg.envelope.subject : ""),
    date: formatDateTime(parsed.date || msg.internalDate),
    ...composed,
    has_html: Boolean(parsed.html),
    attachments,
    attachment_count: attachments.length,
    real_attachment_count: attachments.filter((x) => x.is_real_attachment).length,
    has_attachments: attachments.some((x) => x.is_real_attachment),
    unread: !flags.has("\\Seen"),
    message_id: parsed.messageId || (msg.envelope ? msg.envelope.messageId : ""),
    in_reply_to: parsed.inReplyTo || "",
    references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references || ""),
    folder: openFolder,
    list_unsubscribe: _extractListUnsubscribe(parsed),
  };
}

async function showEmail({
  email_id,
  folder = "INBOX",
  account_id = "",
  body_max_len = 0,
  html_max_len = 0,
  include_html = true,
  strip_urls = false,
} = {}) {
  const id = String(email_id || "").trim();
  if (!id) return { success: false, error: "Missing email_id" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const openFolder = _normalizeFolder(folder);
  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    if (_isTestMode()) {
      const { getMailbox } = require("../../testing/mock_store");
      const mb = getMailbox(acc.account.id, openFolder);
      const raw = mb && mb.messages ? mb.messages.find((m) => String(m.uid) === String(id)) : null;
      if (!raw) return { success: false, error: `Email not found: ${id}` };
      const attachments = (raw.attachments || []).map((a) => ({
        filename: a.filename,
        size: a.content ? a.content.length : 0,
        content_type: a.contentType || "application/octet-stream",
        ...attachmentFlags(a),
      }));
      const unread = !(raw.flags || new Set([])).has("\\Seen");
      const composed = _composeBody({
        text: raw.body,
        html: raw.html,
        body_max_len,
        html_max_len,
        include_html,
        strip_urls,
      });
      return {
        success: true,
        id: String(raw.uid),
        gid: _gid(acc.account.id, openFolder, raw.uid),
        requested_id: String(id),
        from: raw.from,
        to: raw.to,
        cc: raw.cc || "",
        subject: raw.subject,
        date: raw.date,
        ...composed,
        has_html: Boolean(raw.html),
        attachments,
        attachment_count: attachments.length,
        real_attachment_count: attachments.filter((x) => x.is_real_attachment).length,
        has_attachments: attachments.some((x) => x.is_real_attachment),
        unread,
        message_id: raw.messageId || "",
        in_reply_to: raw.inReplyTo || "",
        references: raw.references || "",
        folder: openFolder,
        account: acc.account.email,
        account_id: acc.account.id,
        from_cache: false,
      };
    }

    // Size is checked before the source is downloaded (see _fetchFullMessages).
    const loaded = await _loadParsedMessage(client, id, id);
    if (!loaded.success) return loaded;
    const fields = _messageFields(acc.account, openFolder, loaded.msg, loaded.parsed, { body_max_len, html_max_len, include_html, strip_urls });
    return {
      success: true,
      requested_id: String(id),
      ...fields,
      account: acc.account.email,
      account_id: acc.account.id,
      from_cache: false,
    };
  }, { idempotent: true });
}

// Batch fetch multiple emails over a single IMAP connection. Same per-email
// shape as showEmail (minus a few duplicated fields), wrapped in a list.
async function showEmails({
  email_ids,
  folder = "INBOX",
  account_id = "",
  body_max_len = 0,
  html_max_len = 0,
  include_html = true,
  strip_urls = false,
} = {}) {
  const ids = (email_ids || []).map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return { success: false, error: "Missing email_ids" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const opts = { body_max_len, html_max_len, include_html, strip_urls };
  const openFolder = _normalizeFolder(folder);
  return withImapClient(acc.account, async (client) => {
    const { emails, failed_ids } = await _showFromFolder(client, acc.account, openFolder, ids, opts);
    return {
      success: failed_ids.length === 0,
      emails,
      failed_ids,
      requested: ids.length,
      returned: emails.length,
      folder: openFolder,
      account_id: acc.account.id,
    };
  }, { idempotent: true });
}

// Fetch `ids` from one folder on an already-connected client.
async function _showFromFolder(client, account, openFolder, ids, opts) {
  await client.mailboxOpen(openFolder);
  const emails = [];
  const failed_ids = [];
  const { valid, invalid } = _parseUidList(ids);
  for (const id of invalid) failed_ids.push({ id, error: "not_found" });
  // Two FETCHes for the whole set (metadata+size, then sources), not one
  // FETCH per uid.
  for await (const r of _fetchFullMessages(client, valid)) {
    if (r.error) {
      failed_ids.push({ id: String(r.uid), error: r.error });
      continue;
    }
    try {
      const parsed = await _safeParse(r.msg.source);
      emails.push(_messageFields(account, openFolder, r.msg, parsed, opts));
    } catch (e) {
      failed_ids.push({ id: String(r.uid), error: e && e.message ? e.message : "fetch failed" });
    }
  }
  return { emails, failed_ids };
}

// Resolve which folder an email lives in: an explicit folder wins, otherwise the
// local cache is consulted, otherwise INBOX. Lets `show` open the right mailbox
// without the caller remembering each email's folder.
async function resolveEmailFolder({ account_id = "", uid = "", folder = "" } = {}) {
  if (folder) return _normalizeFolder(folder);
  const acc = accounts.getAccountByIdOrEmail(account_id);
  const accId = acc && acc.success ? acc.account.id : account_id;
  const dbPath = _syncDbPath();
  if (dbPath && uid) {
    try {
      const f = await syncDb.lookupFolderForUid({ dbPath, accountId: accId, uid: String(uid) });
      if (f) return f;
    } catch {
      /* ignore */
    }
  }
  return "INBOX";
}

// Folder-aware batch show. refs: [{ id, folder }]. A ref's folder may come from a
// 3-part gid; when absent it is resolved from the local cache, then falls back to
// INBOX. Ids are grouped by folder and fetched folder by folder over one IMAP
// connection, so `show` works on results that span folders (e.g. after
// `search --folder all`) without the caller passing --folder per email.
async function showEmailsResolved({ refs = [], account_id = "", ...opts } = {}) {
  const list = (Array.isArray(refs) ? refs : [])
    .map((r) => ({ id: String((r && r.id) || "").trim(), folder: (r && r.folder) || "" }))
    .filter((r) => r.id);
  if (!list.length) return { success: false, error: "Missing email refs" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  // Resolve a folder for every ref (gid folder -> cache -> INBOX), then group.
  // Refs without a folder are looked up in one DB open, not one per ref (each
  // of which also re-read auth.json and the config).
  const unresolved = list.filter((r) => !r.folder).map((r) => r.id);
  let cached = new Map();
  const dbPath = _syncDbPath();
  if (unresolved.length && dbPath) {
    try {
      cached = await syncDb.lookupFoldersForUids({ dbPath, accountId: acc.account.id, uids: unresolved });
    } catch {
      cached = new Map();
    }
  }
  const byFolder = new Map();
  for (const r of list) {
    const folder = r.folder ? _normalizeFolder(r.folder) : (cached.get(r.id) || "INBOX");
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(r.id);
  }

  const showOpts = {
    body_max_len: opts.body_max_len || 0,
    html_max_len: opts.html_max_len || 0,
    include_html: opts.include_html === undefined ? true : opts.include_html,
    strip_urls: Boolean(opts.strip_urls),
  };
  const emails = [];
  const failed_ids = [];
  const fail = (ids, e, folder) => {
    const msg = (e && e.message) || "fetch failed";
    for (const id of ids) failed_ids.push({ id, error: msg, folder });
  };
  try {
    await withImapClient(acc.account, async (client) => {
      for (const [folder, ids] of byFolder) {
        try {
          const res = await _showFromFolder(client, acc.account, folder, ids, showOpts);
          emails.push(...res.emails);
          failed_ids.push(...res.failed_ids);
        } catch (e) {
          // A folder that can't be opened (stale/renamed/deleted) must not
          // sink the whole batch — degrade that group to failed_ids and keep
          // the other folders.
          fail(ids, e, folder);
        }
      }
    }, { idempotent: true });
  } catch (e) {
    // Connection-level failure: every group not yet reported fails with it.
    const reported = new Set([...emails.map((x) => x.id), ...failed_ids.map((x) => String(x.id))]);
    for (const [folder, ids] of byFolder) fail(ids.filter((id) => !reported.has(String(id))), e, folder);
  }

  return {
    success: failed_ids.length === 0,
    emails,
    failed_ids,
    requested: list.length,
    returned: emails.length,
    account_id: acc.account.id,
  };
}

module.exports = { showEmail, showEmails, showEmailsResolved, resolveEmailFolder, _messageFields, _showFromFolder };
