function formatDateTime(dt) {
  if (!dt) return "";
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return "";

  const pad = (n) => String(n).padStart(2, "0");
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  ].join(" ");
}

function firstAddress(list) {
  if (!list) return "";
  const arr = Array.isArray(list) ? list : [list];
  for (const item of arr) {
    if (!item) continue;
    if (typeof item === "string") return item;
    if (item.address) return item.address;
  }
  return "";
}

// An S/MIME signature part (smime.p7s) is cryptographic metadata, not real
// content — it should never count as "this email has an attachment".
function isSignatureAttachment(contentType, filename) {
  const ct = String(contentType || "").toLowerCase();
  const fn = String(filename || "").toLowerCase();
  return ct === "application/pkcs7-signature" || ct === "application/x-pkcs7-signature" || fn === "smime.p7s";
}

// Derive presentation flags for a (mailparser-style) attachment object.
function attachmentFlags(a) {
  const a2 = a || {};
  const is_signature = isSignatureAttachment(a2.contentType || a2.content_type, a2.filename);
  const is_inline =
    Boolean(a2.related) || String(a2.contentDisposition || a2.disposition || "").toLowerCase() === "inline";
  return { is_signature, is_inline, is_real_attachment: !is_signature && !is_inline };
}

function _nodeContentType(node) {
  if (!node) return "";
  const type = String(node.type || "");
  if (node.subtype && !type.includes("/")) return `${type}/${node.subtype}`.toLowerCase();
  return type.toLowerCase();
}

function hasAttachmentsFromBodyStructure(node) {
  if (!node || typeof node !== "object") return false;

  const disp = (node.disposition || "").toLowerCase();
  const params = node.parameters || node.dispositionParameters || {};
  const filename = params.filename || params.name || "";
  const looksAttachment =
    disp === "attachment" || (disp === "inline" && params && params.filename) || (params && params.filename);
  if (looksAttachment && !isSignatureAttachment(_nodeContentType(node), filename)) return true;

  const children = node.childNodes || node.childnodes || node.children;
  if (Array.isArray(children)) {
    for (const c of children) {
      if (hasAttachmentsFromBodyStructure(c)) return true;
    }
  }
  return false;
}

function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"]; 
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const rounded = i === 0 ? String(Math.round(v)) : v.toFixed(1);
  return `${rounded} ${units[i]}`;
}

module.exports = {
  formatDateTime,
  firstAddress,
  hasAttachmentsFromBodyStructure,
  isSignatureAttachment,
  attachmentFlags,
  formatSize,
};
