// Outgoing mail: send, reply (threaded via In-Reply-To/References) and
// forward (with the original's attachments).

const path = require("path");

const accounts = require("../accounts");
const { withImapClient } = require("../imap");
const { sendMail } = require("../smtp");
const { attachmentFlags } = require("../format");
const { _normalizeFolder } = require("./internals");
const { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL, _loadParsedMessage } = require("./message_source");
const {
  _outgoingAttachments, _outgoingAttachmentPreview,
  _splitAddressList, _addressEmail, _dedupeAddresses, _buildReferences,
} = require("./addresses");
const { showEmail } = require("./show");

async function sendEmail({ to, subject, body, cc, bcc, account_id = "", is_html = false, attachments = [] } = {}) {
  const tos = Array.isArray(to) ? to : [to];
  const recipients = tos.map((x) => String(x)).filter((x) => x.trim());
  if (!recipients.length) return { success: false, error: "Missing --to" };
  const subj = String(subject || "");
  if (!subj.trim()) return { success: false, error: "Missing --subject" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  try {
    const outgoingAttachments = _outgoingAttachments(attachments);
    const r = await sendMail({
      account: acc.account,
      to: recipients.join(", "),
      cc: Array.isArray(cc) ? cc.join(", ") : cc || "",
      bcc: Array.isArray(bcc) ? bcc.join(", ") : bcc || "",
      subject: subj,
      text: is_html ? "" : String(body || ""),
      html: is_html ? String(body || "") : "",
      attachments: outgoingAttachments,
    });

    if (!r.success) return r;
    return {
      success: true,
      message: `Email sent successfully to ${recipients.length} recipient(s)`,
      recipients,
      from: acc.account.email,
      attachment_count: outgoingAttachments.length,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "send failed", from: acc.account.email };
  }
}

// Common reply-prefix forms across locales. Matches "Re:", "RE：", "回复:",
// "答复:", "Sv:", "Antwort:", "AW:", "RES:", "Tr:" with optional whitespace.
const _REPLY_PREFIX_RE = /^\s*(re|aw|antwort|sv|res|回复|答复|回覆|tr)\s*[:：]/i;

async function replyEmail({ email_id, body, reply_all = false, folder = "INBOX", account_id = "", is_html = false, attachments = [], dry_run = false } = {}) {
  const detail = await showEmail({ email_id, folder, account_id });
  if (!detail.success) return detail;
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const outgoingAttachments = _outgoingAttachments(attachments);

  const fromAddr = detail.from || "";
  let toList = [fromAddr].filter(Boolean);
  let ccList = [];
  if (reply_all) {
    const origTo = _splitAddressList(detail.to);
    const origCc = _splitAddressList(detail.cc);
    toList = _dedupeAddresses([fromAddr, ...origTo], [acc.account.email]);
    ccList = _dedupeAddresses(origCc, [acc.account.email, ..._dedupeAddresses(toList).map(_addressEmail)]);
  }
  if (!toList.length) {
    return { success: false, error: "Reply has no recipient (original sender unknown)", from: acc.account.email };
  }

  const subjectRaw = detail.subject || "";
  const subject = _REPLY_PREFIX_RE.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
  const headers = {};
  if (detail.message_id) headers["In-Reply-To"] = detail.message_id;
  const refs = _buildReferences(detail);
  if (refs) headers.References = refs;

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_reply: {
        email_id: String(email_id || ""),
        folder,
        account_id: acc.account.id,
        to: toList,
        cc: ccList,
        subject,
        is_html: Boolean(is_html),
        body_bytes: Buffer.byteLength(String(body || ""), "utf8"),
        body_preview: String(body || "").slice(0, 200),
        attachment_count: outgoingAttachments.length,
        attachments: _outgoingAttachmentPreview(outgoingAttachments),
      },
      confirmation_required: true,
      confirmation_hint: "Re-run with --confirm to actually send",
    };
  }

  try {
    await sendMail({
      account: acc.account,
      to: toList.join(", "),
      cc: ccList.length ? ccList.join(", ") : undefined,
      subject,
      text: is_html ? "" : String(body || ""),
      html: is_html ? String(body || "") : "",
      attachments: outgoingAttachments,
      headers,
    });
    return {
      success: true,
      message: "Reply sent successfully",
      recipients: toList,
      cc: ccList,
      from: acc.account.email,
      attachment_count: outgoingAttachments.length,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "reply failed", from: acc.account.email };
  }
}

async function forwardEmail({ email_id, to, body = "", folder = "INBOX", no_attachments = false, account_id = "", dry_run = false } = {}) {
  const id = String(email_id || "").trim();
  if (!id) return { success: false, error: "Missing email_id" };
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const openFolder = _normalizeFolder(folder);

  // One fetch + parse serves both the subject/attachment count and the
  // attachment bytes. This used to run show (fetch + parse) and then fetch
  // and parse the same source a second time for the attachments.
  const loaded = await withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    return _loadParsedMessage(client, id, id);
  }, { idempotent: true });
  if (!loaded.success) return loaded;
  const { msg, parsed } = loaded;

  const recipients = (Array.isArray(to) ? to : [to]).map((x) => String(x)).filter((x) => x.trim());
  if (!recipients.length) return { success: false, error: "Missing --to" };
  const subject = `Fwd: ${parsed.subject || (msg.envelope ? msg.envelope.subject : "") || ""}`;
  const parsedAttachments = parsed.attachments || [];

  if (dry_run) {
    const realCount = parsedAttachments.filter((a) => attachmentFlags(a).is_real_attachment).length;
    const originalAttachmentCount = no_attachments ? 0 : (realCount || parsedAttachments.length);
    return {
      success: true,
      dry_run: true,
      would_forward: {
        email_id: String(email_id || ""),
        folder,
        account_id: acc.account.id,
        to: recipients,
        subject,
        body_bytes: Buffer.byteLength(String(body || ""), "utf8"),
        body_preview: String(body || "").slice(0, 200),
        include_original_attachments: !no_attachments,
        original_attachment_count: originalAttachmentCount,
      },
      confirmation_required: true,
      confirmation_hint: "Re-run with --confirm to actually send",
    };
  }

  const attachments = [];
  if (!no_attachments) {
    let totalBytes = 0;
    for (const a of parsedAttachments) {
      if (!a.content || !a.content.length) continue;
      if (a.content.length > MAX_ATTACHMENT_BYTES) continue;
      totalBytes += a.content.length;
      if (totalBytes > MAX_ATTACHMENTS_TOTAL) break;
      attachments.push({
        filename: path.basename(String(a.filename || "attachment")),
        content: a.content,
        contentType: a.contentType || "application/octet-stream",
      });
    }
  }

  try {
    await sendMail({
      account: acc.account,
      to: recipients.join(", "),
      subject,
      text: String(body || ""),
      attachments,
    });
    return {
      success: true,
      message: `Email sent successfully to ${recipients.length} recipient(s)`,
      recipients,
      from: acc.account.email,
      attachment_count: attachments.length,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "forward failed", from: acc.account.email };
  }
}

module.exports = { sendEmail, replyEmail, forwardEmail };
