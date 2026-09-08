// Address-list and attachment plumbing for the outgoing paths (send / reply /
// forward): splitting header lists, de-duplicating recipients, and building the
// References chain that keeps a reply in its thread.

const path = require("path");

function _outgoingAttachments(attachments) {
  if (!attachments) return [];
  return Array.isArray(attachments) ? attachments.filter(Boolean) : [attachments];
}

function _outgoingAttachmentPreview(attachments) {
  return _outgoingAttachments(attachments).map((a) => ({
    filename: a.filename || (a.path ? path.basename(String(a.path)) : "attachment"),
    path: a.path || undefined,
    content_type: a.contentType || undefined,
  }));
}

function _splitAddressList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function _addressEmail(addr) {
  const m = String(addr).match(/<([^>]+)>/);
  return (m ? m[1] : String(addr)).trim().toLowerCase();
}

function _dedupeAddresses(list, exclude) {
  const excluded = new Set((exclude || []).map((x) => String(x).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const addr of list) {
    const key = _addressEmail(addr);
    if (!key || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

function _buildReferences(detail) {
  const refs = [];
  const existing = detail.references ? String(detail.references).trim() : "";
  if (existing) refs.push(existing);
  const parent = detail.message_id ? String(detail.message_id).trim() : "";
  if (parent && !refs.join(" ").includes(parent)) refs.push(parent);
  return refs.join(" ").trim();
}

module.exports = {
  _outgoingAttachments,
  _outgoingAttachmentPreview,
  _splitAddressList,
  _addressEmail,
  _dedupeAddresses,
  _buildReferences,
};
