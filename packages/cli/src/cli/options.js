// Option parsing and validation shared across commands: paging bounds, relative
// date shortcuts, body files, attachment collection. These return
// { ok: false, error } instead of throwing, so a caller can hand the message
// straight to the JSON contract.

const fs = require("fs");
const path = require("path");

// Hard upper bound on per-call result limits. Without this, a typo like
// --limit 99999999 would happily try to fetch the entire mailbox (and
// trigger IMAP rate limits / OOM). Override via env if you really need it.
const MAX_BODY_FILE_BYTES = Number(process.env.MAILBOX_MAX_BODY_FILE_BYTES || 10 * 1024 * 1024); // 10 MiB
const MAX_RESULT_LIMIT = Number(process.env.MAILBOX_MAX_LIMIT || 1000);

// Validate --limit/--offset. Returns { ok, limit, offset, error }.
function _validatePaging(limitRaw, offsetRaw, { defaultLimit }) {
  const limit = limitRaw == null || limitRaw === "" ? defaultLimit : Number(limitRaw);
  const offset = offsetRaw == null || offsetRaw === "" ? 0 : Number(offsetRaw);
  if (!Number.isFinite(limit) || limit < 0) {
    return { ok: false, error: `--limit must be a non-negative number (got ${limitRaw})` };
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return { ok: false, error: `--offset must be a non-negative number (got ${offsetRaw})` };
  }
  if (limit > MAX_RESULT_LIMIT) {
    return { ok: false, error: `--limit ${limit} exceeds MAILBOX_MAX_LIMIT=${MAX_RESULT_LIMIT}; raise the env var if intentional` };
  }
  return { ok: true, limit, offset };
}

// Resolve human-friendly date shortcuts to YYYY-MM-DD before they reach the
// core parser. Accepts: ISO 8601, YYYY-MM-DD, "today", "yesterday",
// relative spans like "2d", "3w", "4mo", "1y", "30m", "12h".
function _expandDateShortcut(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  const now = new Date();
  if (value === "today") return _isoDate(now);
  if (value === "yesterday") {
    const d = new Date(now); d.setDate(d.getDate() - 1); return _isoDate(d);
  }
  if (value === "last-week" || value === "lastweek") {
    const d = new Date(now); d.setDate(d.getDate() - 7); return _isoDate(d);
  }
  if (value === "last-month" || value === "lastmonth") {
    const d = new Date(now); d.setMonth(d.getMonth() - 1); return _isoDate(d);
  }
  // Relative: <N><unit>  unit ∈ m h d w mo y
  const m = value.match(/^(\d+)\s*(mo|m|h|d|w|y)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const d = new Date(now);
    if (unit === "m") d.setMinutes(d.getMinutes() - n);
    else if (unit === "h") d.setHours(d.getHours() - n);
    else if (unit === "d") d.setDate(d.getDate() - n);
    else if (unit === "w") d.setDate(d.getDate() - n * 7);
    else if (unit === "mo") d.setMonth(d.getMonth() - n);
    else if (unit === "y") d.setFullYear(d.getFullYear() - n);
    // For coarse units (d/w/mo/y) collapse to date-only so IMAP SINCE
    // semantics line up; for finer units keep the timestamp.
    if (unit === "d" || unit === "w" || unit === "mo" || unit === "y") return _isoDate(d);
    return d.toISOString();
  }
  return raw; // pass through to underlying parser
}

function _isoDate(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// Validate a date string. Accepts YYYY-MM-DD, ISO 8601, or one of the
// relative shortcuts handled by _expandDateShortcut.
function _validateDateOpt(name, raw) {
  const value = String(raw || "").trim();
  if (!value) return { ok: true };
  const expanded = _expandDateShortcut(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(expanded)) {
    const d = new Date(`${expanded}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return { ok: true, expanded };
  }
  const d = new Date(expanded);
  if (!Number.isNaN(d.getTime())) return { ok: true, expanded };
  return { ok: false, error: `${name} value "${value}" is not a valid date (expected YYYY-MM-DD, ISO 8601, or relative like 2d/3w/1mo/today/yesterday)` };
}

// --body-file <path>; "-" reads the body from stdin (heredoc / pipe), the
// robust way to pass multi-line text without shell quoting.
function _readBodyFile(bodyFilePath) {
  if (bodyFilePath === "-") {
    const buf = fs.readFileSync(0);
    if (buf.length > MAX_BODY_FILE_BYTES) {
      throw new Error(`--body-file exceeds ${MAX_BODY_FILE_BYTES} bytes (size=${buf.length})`);
    }
    return buf.toString("utf8");
  }
  const st = fs.statSync(bodyFilePath);
  if (st.size > MAX_BODY_FILE_BYTES) {
    throw new Error(`--body-file exceeds ${MAX_BODY_FILE_BYTES} bytes (size=${st.size})`);
  }
  return fs.readFileSync(bodyFilePath, "utf8");
}

// Shells do not turn "\n" inside quotes into a newline, so
// `--body "Hi,\n\nThanks"` reaches us as the two characters backslash + n,
// and that is what got sent — the recipient saw literal "\n". An inline body
// with NO real line break but with literal \n sequences is that mistake, so
// turn \r\n / \n into line breaks. A body that already has real newlines,
// a --body-file body, or --literal-body is sent byte-for-byte (code samples
// keep their escapes). An escaped "\\n" (backslash backslash n) is left alone.
const LITERAL_NEWLINE_SRC = String.raw`(?<!\\)\\(?:r\\n|n)`;
function _decodeInlineBody(text) {
  const s = String(text || "");
  if (/[\r\n]/.test(s) || !new RegExp(LITERAL_NEWLINE_SRC).test(s)) return { body: s, unescaped: false };
  return { body: s.replace(new RegExp(LITERAL_NEWLINE_SRC, "g"), "\n"), unescaped: true };
}
const BODY_UNESCAPED_WARNING =
  "--body had literal \\n sequences and no real line breaks; converted them to line breaks. " +
  "Pass --literal-body to send the text as-is, or use --body-file <path|-> for multi-line bodies.";

function _collectOption(value, previous) {
  return [...(previous || []), value];
}

function _resolveLocalAttachments(values) {
  const files = Array.isArray(values) ? values : [];
  return files.map((raw) => {
    const input = String(raw || "").trim();
    if (!input) throw new Error("--attachment path cannot be empty");
    const filePath = path.resolve(process.cwd(), input);
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      throw new Error(`--attachment not found: ${input}`);
    }
    if (!st.isFile()) throw new Error(`--attachment is not a file: ${input}`);
    return {
      filename: path.basename(filePath),
      path: filePath,
      size_bytes: st.size,
    };
  });
}

function _attachmentPreview(attachments) {
  return (attachments || []).map((a) => ({
    filename: a.filename,
    path: a.path,
    size_bytes: a.size_bytes,
  }));
}

function _mailAttachments(attachments) {
  return (attachments || []).map((a) => ({
    filename: a.filename,
    path: a.path,
  }));
}

function _explicitOptionValue(cmd, opts, key) {
  if (cmd && typeof cmd.getOptionValueSource === "function" && cmd.getOptionValueSource(key) === "cli") {
    return opts[key];
  }
  return undefined;
}

module.exports = {
  _validatePaging,
  _expandDateShortcut,
  _isoDate,
  _validateDateOpt,
  _readBodyFile,
  _decodeInlineBody,
  BODY_UNESCAPED_WARNING,
  _collectOption,
  _resolveLocalAttachments,
  _attachmentPreview,
  _mailAttachments,
  _explicitOptionValue,
};
