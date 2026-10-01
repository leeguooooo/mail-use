// The envelope-level row list/sync/watch report for a fetched message.

const { _gid } = require("./internals");
const { formatDateTime, firstAddress, hasAttachmentsFromBodyStructure } = require("../format");

function _envelopeItem(account, folder, msg, source) {
  const env = msg.envelope || {};
  const flags = msg.flags || new Set([]);
  return {
    id: String(msg.uid),
    uid: String(msg.uid),
    gid: _gid(account.id, folder, msg.uid),
    message_id: env.messageId || "",
    subject: env.subject || "",
    from: firstAddress(env.from),
    date: formatDateTime(msg.internalDate || env.date),
    unread: !flags.has("\\Seen"),
    has_attachments: hasAttachmentsFromBodyStructure(msg.bodyStructure),
    account: account.email,
    account_id: account.id,
    folder,
    source,
  };
}

module.exports = { _envelopeItem };
