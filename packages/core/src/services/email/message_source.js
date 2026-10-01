// Getting message sources off the server without paying more than needed:
// one FETCH for many UIDs, a size check before any source is downloaded, and
// a bounded partial fetch for previews.

const { _uidSetString } = require("./internals");

// Hard caps to defend against hostile mail. Override via env if needed.
const MAX_MESSAGE_BYTES = Number(process.env.MAILBOX_MAX_MESSAGE_BYTES || 50 * 1024 * 1024); // 50 MiB
const MAX_ATTACHMENT_BYTES = Number(process.env.MAILBOX_MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024); // 25 MiB per file
const MAX_ATTACHMENTS_TOTAL = Number(process.env.MAILBOX_MAX_ATTACHMENTS_BYTES || 100 * 1024 * 1024); // 100 MiB total

// A preview only needs the first few hundred characters of the text part,
// which in practice sits within the first tens of KB (headers, then the text
// body; attachments come after). Fetch BODY[]<0.N> instead of the whole
// message, so a preview of a mail with a 20 MB attachment costs 64 KB.
const PREVIEW_SOURCE_BYTES = 64 * 1024;

// Upper bound on source bytes held in memory per FETCH round when loading
// many full messages at once; bigger sets are split into several fetches.
const SOURCE_BATCH_BYTES = 64 * 1024 * 1024;

function _tooLargeError(size) {
  return `Message exceeds MAILBOX_MAX_MESSAGE_BYTES (${MAX_MESSAGE_BYTES}): ${size} bytes`;
}

async function _safeParse(source) {
  if (source && Buffer.isBuffer(source) && source.length > MAX_MESSAGE_BYTES) {
    throw new Error(_tooLargeError(source.length));
  }
  const { simpleParser } = require("mailparser");
  return simpleParser(source, {
    maxHtmlLengthToParse: MAX_MESSAGE_BYTES,
  });
}

// Fetch full messages for `uids` from the selected mailbox.
//
// Round 1: one FETCH of metadata + RFC822.SIZE for every uid. Oversized
// messages are rejected here, before a byte of their source is downloaded.
// Round 2: FETCH BODY[] for the rest, split so one round never holds more
// than SOURCE_BATCH_BYTES. Total: 2 round trips for typical sets, instead of
// one FETCH per uid (and a 50 MB download before the old post-hoc size check).
//
// Yields { uid, msg } (msg carries envelope/flags/internalDate/bodyStructure/
// size/source) or { uid, error }, in the order of `uids`.
async function* _fetchFullMessages(client, uids) {
  const wanted = [];
  const seen = new Set();
  for (const raw of uids || []) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (!seen.has(n)) { seen.add(n); wanted.push(n); }
  }
  if (!wanted.length) return;

  const meta = new Map();
  for await (const msg of client.fetch(
    _uidSetString(wanted),
    { envelope: true, flags: true, internalDate: true, bodyStructure: true, size: true },
    { uid: true }
  )) {
    meta.set(Number(msg.uid), msg);
  }

  const errors = new Map();
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const uid of wanted) {
    const m = meta.get(uid);
    if (!m) { errors.set(uid, "not_found"); continue; }
    const size = Number(m.size || 0);
    if (size > MAX_MESSAGE_BYTES) { errors.set(uid, _tooLargeError(size)); continue; }
    if (cur.length && curBytes + size > SOURCE_BATCH_BYTES) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(uid);
    curBytes += size;
  }
  if (cur.length) batches.push(cur);

  // Results must come out in request order; batches preserve it, so emit
  // errors that precede each batch member as we go.
  let i = 0;
  const emitUpTo = function* (stopUid) {
    while (i < wanted.length && wanted[i] !== stopUid) {
      const u = wanted[i];
      if (errors.has(u)) yield { uid: u, error: errors.get(u) };
      i += 1;
    }
  };

  for (const batch of batches) {
    const sources = new Map();
    for await (const msg of client.fetch(_uidSetString(batch), { source: true }, { uid: true })) {
      sources.set(Number(msg.uid), msg.source);
    }
    for (const uid of batch) {
      yield* emitUpTo(uid);
      i += 1;
      const source = sources.get(uid);
      // Expunged between the two rounds.
      if (!source) yield { uid, error: "not_found" };
      else yield { uid, msg: { ...meta.get(uid), source } };
    }
  }
  yield* emitUpTo(undefined);
}

// Fetch + parse one message. Returns { success, msg, parsed } or
// { success:false, error }.
async function _loadParsedMessage(client, uid, notFoundLabel = uid) {
  for await (const r of _fetchFullMessages(client, [uid])) {
    if (r.error) {
      return { success: false, error: r.error === "not_found" ? `Email not found: ${notFoundLabel}` : r.error };
    }
    return { success: true, msg: r.msg, parsed: await _safeParse(r.msg.source) };
  }
  return { success: false, error: `Email not found: ${notFoundLabel}` };
}

async function _previewFromSource(source, previewChars) {
  try {
    const parsed = await _safeParse(source);
    const txt = String(parsed.text || "").replace(/\s+/g, " ").trim();
    const out = { preview: txt.slice(0, previewChars) };
    if (txt.length > previewChars) out.preview_truncated = true;
    return out;
  } catch {
    return { preview: "" };
  }
}

// Add preview / preview_truncated to a list or search row from the partial
// source fetched with PREVIEW_SOURCE_QUERY. No source, no change.
async function _applyPreview(item, msg, previewChars) {
  if (msg && msg.source) Object.assign(item, await _previewFromSource(msg.source, previewChars));
  return item;
}

const PREVIEW_SOURCE_QUERY = { start: 0, maxLength: PREVIEW_SOURCE_BYTES };

module.exports = {
  MAX_MESSAGE_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL,
  PREVIEW_SOURCE_BYTES,
  PREVIEW_SOURCE_QUERY,
  _safeParse,
  _fetchFullMessages,
  _loadParsedMessage,
  _previewFromSource,
  _applyPreview,
};
