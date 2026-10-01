// Saving a message's attachments to disk, size-capped and path-safe.

const fs = require("fs");
const path = require("path");

const { paths } = require("@mail-use/shared");

const accounts = require("../accounts");
const { withImapClient } = require("../imap");
const { attachmentFlags, formatSize } = require("../format");
const { _normalizeFolder } = require("./internals");
const { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL, _loadParsedMessage } = require("./message_source");

async function downloadAttachments({ email_id, folder = "INBOX", account_id, output_dir = "" } = {}) {
  const id = String(email_id || "").trim();
  if (!id) return { success: false, error: "Missing email_id" };
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const openFolder = _normalizeFolder(folder);
  const uid = Number(id);
  if (!Number.isFinite(uid)) return { success: false, error: "Invalid email_id" };

  // Pick a non-conflicting filename inside targetDir, basename-only to defeat
  // path traversal from attacker-supplied filenames.
  const _pickDest = (targetDir, rawName) => {
    const filename = path.basename(String(rawName || "attachment"));
    if (!filename) return { filename: "", dest: "" };
    let dest = path.join(targetDir, filename);
    const ext = path.extname(filename);
    const base = ext ? filename.slice(0, -ext.length) : filename;
    let counter = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(targetDir, `${base}_${counter}${ext}`);
      counter += 1;
    }
    return { filename, dest };
  };

  // One fetch + parse (it used to run show first, then fetch and parse the
  // same source again).
  const loaded = await withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    return _loadParsedMessage(client, uid, email_id);
  }, { idempotent: true });
  if (!loaded.success) return loaded;
  const parsed = loaded.parsed;

  // Check the caps before writing anything, so a rejected download leaves no
  // partial set of files behind.
  const toWrite = [];
  let totalBytes = 0;
  for (const a of parsed.attachments || []) {
    const content = a.content;
    if (!content || !content.length) continue;
    if (content.length > MAX_ATTACHMENT_BYTES) {
      return { success: false, error: `Attachment "${a.filename || "(unnamed)"}" exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
    }
    totalBytes += content.length;
    if (totalBytes > MAX_ATTACHMENTS_TOTAL) {
      return { success: false, error: `Attachments exceed total cap of ${MAX_ATTACHMENTS_TOTAL} bytes` };
    }
    toWrite.push(a);
  }

  const targetDir = output_dir ? String(output_dir) : paths.getPathConfig().attachmentsDir;
  fs.mkdirSync(targetDir, { recursive: true });

  const attachments = [];
  for (const a of toWrite) {
    const { filename, dest } = _pickDest(targetDir, a.filename);
    if (!filename) continue;
    fs.writeFileSync(dest, a.content);
    attachments.push({
      filename,
      size: a.content.length,
      size_formatted: formatSize(a.content.length),
      content_type: a.contentType || "application/octet-stream",
      saved_path: dest,
      ...attachmentFlags(a),
    });
  }

  return {
    success: true,
    attachments,
    attachment_count: attachments.length,
    real_attachment_count: attachments.filter((x) => x.is_real_attachment).length,
    email_id: String(email_id),
    folder: openFolder,
    account: acc.account.email,
  };
}

module.exports = { downloadAttachments };
