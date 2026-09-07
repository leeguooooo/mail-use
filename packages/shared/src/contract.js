const { printJson, printJsonl } = require("./json");

function parseGlobalFlags(argv) {
  const rest = [];
  let asJson = false;
  let pretty = false;
  let forceText = false;
  let lean = false;
  let format = "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      asJson = true;
      continue;
    }
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--text") {
      forceText = true;
      continue;
    }
    if (arg === "--lean") {
      lean = true;
      continue;
    }
    // --format <mode> or --format=<mode>. Modes are comma-separable, e.g.
    // "compact,jsonl". Accepted: json, jsonl/ndjson, compact/agent.
    if (arg === "--format") {
      format = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--format=")) {
      format = arg.slice("--format=".length);
      continue;
    }
    rest.push(arg);
  }

  return { asJson, pretty, forceText, lean, format, argv: rest };
}

function parseFormatModes(format) {
  const modes = new Set(
    String(format || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  return {
    compact: modes.has("compact") || modes.has("agent"),
    jsonl: modes.has("jsonl") || modes.has("ndjson"),
    any: modes.size > 0,
  };
}

// The exact agent-friendly per-email projection. body_text_preview is derived
// from an existing preview (list/search --with-preview) or a truncated body
// (show), so an agent gets a one-glance summary without a heavy payload.
function compactEmail(e) {
  if (!e || typeof e !== "object") return e;
  let preview = "";
  if (typeof e.body_text_preview === "string") preview = e.body_text_preview;
  else if (typeof e.preview === "string") preview = e.preview;
  else if (typeof e.body === "string") preview = e.body.replace(/\s+/g, " ").trim().slice(0, 200);
  let hasAttachments = false;
  if (typeof e.has_attachments === "boolean") hasAttachments = e.has_attachments;
  else if (e.real_attachment_count != null) hasAttachments = Number(e.real_attachment_count) > 0;
  else if (e.attachment_count != null) hasAttachments = Number(e.attachment_count) > 0;
  const id = e.id != null ? String(e.id) : "";
  // gid lets an agent chain straight into `email show` from compact output.
  // Prefer the carried 3-part gid; otherwise synthesize account_id:folder:uid.
  const gid = e.gid || (e.account_id && id ? `${e.account_id}:${e.folder || "INBOX"}:${id}` : id);
  const out = {
    id,
    gid,
    account_id: e.account_id || "",
    folder: e.folder || "",
    date: e.date || "",
    from: e.from || "",
    subject: e.subject || "",
    unread: Boolean(e.unread),
    has_attachments: hasAttachments,
    body_text_preview: preview,
  };
  // Carry extracted OTP/verification codes through the compact projection — the
  // whole point of --extract-code is to skip the body, so the codes must survive.
  if (Array.isArray(e.codes)) out.codes = e.codes;
  return out;
}

// Pull the email-like records out of a result, tolerating both the list/search
// shape ({ emails: [...] }) and the single-show shape (the email IS the result).
function collectEmails(result) {
  if (result && Array.isArray(result.emails)) return result.emails;
  if (result && (result.id != null || result.subject != null) && result.success !== false) return [result];
  return [];
}

const COMPACT_TOP_LEVEL_KEEP = new Set([
  "success",
  "error",
  "error_code",
  "failed_ids",
  "limit",
  "offset",
  "returned",
  "requested",
  "unread_in_result",
  // Cache-freshness signals: must survive --format compact so an agent that
  // gets an empty/thin list can still tell it came from a (possibly stale)
  // cache snapshot and knows to pass --live. Without these the compact shape
  // was a silent failure on freshly-arrived mail.
  "from_cache",
  "unread_as_of",
  "cache_age_seconds",
  "cache_stale",
  "hint",
]);

function compactResult(result) {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result.emails)) {
    const out = {};
    for (const k of COMPACT_TOP_LEVEL_KEEP) if (k in result) out[k] = result[k];
    out.emails = result.emails.map(compactEmail);
    return out;
  }
  // Single-show shape: project the one email but keep success.
  if (result.id != null || result.subject != null) {
    return { success: result.success !== false, ...compactEmail(result) };
  }
  return result;
}

// Fields that are noise for an AI consumer of the JSON contract — they
// either restate the request, are empty most of the time, or duplicate
// info that's already present elsewhere. --lean strips them.
const LEAN_DROP_TOP_LEVEL = new Set([
  "accounts_info",
  "accounts_count",
  "accounts_searched",
  "search_time",
  "search_params",
  "failed_searches",
  "partial_success",
  // NOTE: from_cache is intentionally NOT dropped under --lean — it's a
  // freshness signal an agent needs even in the slim shape (e.g. to decide
  // whether to re-run with --live). cache_age_seconds / unread_as_of / hint
  // likewise survive lean (they're not listed here).
  "use_cache",
  "unread_only",
  "folder",
  "account_id",
  "date_from",
  "date_to",
  "limit",
  "offset",
  "total_emails",
  "total_unread",
  "fetched_raw",
  "displayed",
]);
const LEAN_DROP_PER_EMAIL = new Set([
  "uid",
  "to",
  "flagged",
  "account",
  "source",
  "is_flagged",
  // NOTE: do NOT drop `preview` here. It's only present when the caller
  // asked for it via --with-preview, and the empty-string check in
  // leanResult below already handles the unset case.
]);

function leanResult(result) {
  if (!result || typeof result !== "object") return result;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (LEAN_DROP_TOP_LEVEL.has(k)) continue;
    // Drop empty arrays / objects to save tokens.
    if (Array.isArray(v) && v.length === 0 && k !== "emails" && k !== "accounts") continue;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  if (Array.isArray(out.emails)) {
    out.emails = out.emails.map((e) => {
      if (!e || typeof e !== "object") return e;
      const slim = {};
      for (const [k, v] of Object.entries(e)) {
        if (LEAN_DROP_PER_EMAIL.has(k)) continue;
        if (k === "preview" && !v) continue;
        slim[k] = v;
      }
      return slim;
    });
  }
  return out;
}

// Infer a stable, machine-readable error_code from a free-text error
// message. Lets the JSON contract include both a human string (`error`)
// and an enum (`error_code`) without rewriting every internal call site.
// Order matters: specific patterns MUST come before generic catch-alls
// like /^Invalid / which would otherwise shadow them.
const ERROR_CODE_RULES = [
  [/^Account not found/i, "account_not_found"],
  [/^Email not found/i, "email_not_found"],
  [/^Mailbox not found|^Folder not found|does not exist/i, "folder_not_found"],
  // Specific argument-level codes BEFORE the generic /^Invalid / fallback.
  [/is not a valid date/i, "invalid_date"],
  [/must be a non-negative number|exceeds MAILBOX_MAX_LIMIT/i, "invalid_limit"],
  [/^Mixed account_ids/i, "ambiguous_account"],
  [/exceeds MAILBOX_MAX_BODY_FILE_BYTES|exceeds MAILBOX_MAX_MESSAGE_BYTES/i, "size_limit"],
  [/AUTHENTICATIONFAILED|Invalid credentials|535[\s-]/i, "auth_failed"],
  // Now the generic argument-validation catch-all.
  [/^Provide at least one of|^Missing |^Specify exactly one|^Invalid /i, "invalid_argument"],
  [/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/i, "network_error"],
  [/SMTP|Greylisted|Mail rejected/i, "smtp_error"],
  [/IMAP|search failed|fetch failed|client\.list/i, "imap_error"],
];
function inferErrorCode(message) {
  const m = String(message || "");
  if (!m) return "unknown_error";
  for (const [re, code] of ERROR_CODE_RULES) if (re.test(m)) return code;
  return "operation_failed";
}

function ensureSuccessField(result) {
  if (!result || typeof result !== "object") return { success: false, error: "Invalid result", error_code: "invalid_result" };
  if (typeof result.success !== "boolean") result.success = !result.error;
  if (!result.success && result.error && !result.error_code) {
    result.error_code = inferErrorCode(result.error);
  }
  return result;
}

function exitCodeForResult(result) {
  const r = ensureSuccessField(result);
  return r.success ? 0 : 1;
}

function handleJsonOrText({ result, asJson, pretty, lean, format, printText }) {
  let normalized = ensureSuccessField(result);
  if (lean) normalized = leanResult(normalized);

  const fmt = parseFormatModes(format);
  if (fmt.compact) normalized = compactResult(normalized);

  // Any --format mode implies structured output (no human text printer).
  if (fmt.jsonl) {
    // A list result (has an emails[] array) prints one email per line —
    // including zero lines for an empty list and per-email lines for a partial
    // (success:false) multi-account result. Only a genuinely non-list result
    // (single show / a bare error with no emails[]) falls back to one line.
    if (normalized && Array.isArray(normalized.emails)) {
      printJsonl(normalized.emails);
    } else {
      const records = collectEmails(normalized);
      printJsonl(records.length ? records : [normalized]);
    }
  } else if (asJson || fmt.compact) {
    printJson(normalized, pretty);
  } else if (typeof printText === "function") {
    printText(normalized);
  } else {
    // Default: print JSON even when not requested (debug-friendly).
    printJson(normalized, true);
  }

  return exitCodeForResult(normalized);
}

function invalidUsage({ message, asJson, pretty }) {
  const msg = message || "Invalid usage";
  const payload = { success: false, error: msg, error_code: inferErrorCode(msg) || "invalid_argument" };
  // inferErrorCode falls back to "operation_failed" when nothing matches —
  // for the invalid-usage entry point we still want "invalid_argument".
  if (payload.error_code === "operation_failed" || payload.error_code === "unknown_error") {
    payload.error_code = "invalid_argument";
  }
  if (asJson) {
    printJson(payload, pretty);
  } else {
    process.stderr.write((payload.error || "Invalid usage") + "\n");
  }
  return 2;
}

// Pull likely verification / one-time codes out of free text. Covers the two
// shapes agents actually chase: bare 4–8 digit OTPs, and the prefixed
// "LL-DDDDDD" form (e.g. "QB-046193", "G-1234"). De-duplicated, order-preserved.
// Heuristic by design — a caller should still eyeball context for ambiguous mail.
// Keywords that actually precede a one-time code, across the languages this
// mailbox sees. Followed by an optional separator (":", "：", "=", "-", "は")
// and whitespace, then the code itself.
const _ALNUM_CODE_RE = new RegExp(
  '(?:' +
    'verification\\s+code|confirmation\\s+code|security\\s+code|one[- ]time\\s+(?:code|password)|' +
    'passcode|pin\\s*code|access\\s+code|otp|code|pin|' +
    '\\u8a8d\\u8a3c\\u30b3\\u30fc\\u30c9|\\u78ba\\u8a8d\\u30b3\\u30fc\\u30c9|\\u30ef\\u30f3\\u30bf\\u30a4\\u30e0\\u30d1\\u30b9\\u30ef\\u30fc\\u30c9|\\u30b3\\u30fc\\u30c9|\\u8a8d\\u8a3c\\u756a\\u53f7|' +
    '\\u9a8c\\u8bc1\\u7801|\\u52a8\\u6001\\u7801|' +
    '\\uc778\\uc99d\\ubc88\\ud638' +
  ')' +
  '(?:\\s+(?:is|are|was))?' +
  '\\s*[:\\uff1a=\\-\\u306f]?\\s*' +
  '([A-Za-z0-9]{4,8})(?![A-Za-z0-9])',
  'gi',
);

function extractCodes(text) {
  const s = String(text || "");
  if (!s) return [];
  const out = [];
  const seen = new Set();
  const coveredDigits = new Set(); // digit-runs already emitted via a prefixed match
  const push = (c) => {
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  // Prefixed forms first: 1–4 letters + a literal hyphen + 4–8 digits
  // ("QB-046193", "G-1234"). Hyphen-only (not whitespace) so prose like
  // "Code 123456" or "year 2026" isn't misread as a prefixed code.
  const prefixed = s.match(/\b[A-Z]{1,4}-\d{4,8}\b/gi) || [];
  for (const m of prefixed) {
    push(m.toUpperCase());
    const digits = m.match(/\d{4,8}$/);
    if (digits) coveredDigits.add(digits[0]);
  }
  // Bare 4–8 digit runs not glued to other digits (avoids slicing order #s,
  // years inside longer numbers, phone numbers, etc.). Skip runs already
  // surfaced as the tail of a prefixed code so we don't double-report them.
  const bare = s.match(/(?<!\d)\d{4,8}(?!\d)/g) || [];
  for (const m of bare) if (!coveredDigits.has(m)) push(m);
  // Mixed alphanumeric codes ("vM8xw", "a1B2c3"), which Japanese banks, Stripe
  // and GitHub all use. These are far too word-shaped to scan for blindly, so
  // they only count right after a code keyword — and must carry at least one
  // digit, which is what separates a real code from the ordinary prose that
  // follows "code:" ("code: please check ..."). Pure-letter codes are rare
  // enough that accepting them would cost more in false positives than it wins.
  const keyed = s.matchAll(_ALNUM_CODE_RE);
  for (const m of keyed) {
    const token = m[1];
    if (!/\d/.test(token) || !/[A-Za-z]/.test(token)) continue; // digit-only handled above
    push(token);
  }
  return out;
}

// The keyword vocabulary above, on its own — used to decide whether an email is
// a verification email at all, rather than to pull a code out of one.
const _CODE_KEYWORD_RE = new RegExp(
  'verification\\s+code|confirmation\\s+code|security\\s+code|one[- ]time\\s+(?:code|password)|' +
    'verify|passcode|pin\\s*code|access\\s+code|\\botp\\b|\\bcode\\b|' +
    '\\u8a8d\\u8a3c\\u30b3\\u30fc\\u30c9|\\u78ba\\u8a8d\\u30b3\\u30fc\\u30c9|\\u30ef\\u30f3\\u30bf\\u30a4\\u30e0\\u30d1\\u30b9\\u30ef\\u30fc\\u30c9|\\u30b3\\u30fc\\u30c9|\\u8a8d\\u8a3c\\u756a\\u53f7|' +
    '\\u9a8c\\u8bc1\\u7801|\\u52a8\\u6001\\u7801|\\u6821\\u9a8c\\u7801|' +
    '\\uc778\\uc99d\\ubc88\\ud638',
  'gi',
);

// extractCodes is deliberately permissive: it assumes you already know the mail
// is a verification mail and just want every candidate out of it. Pointing it at
// an arbitrary inbox to answer "which mail carries my code?" misfires badly — a
// service-termination notice scores its own "2026" as a code.
//
// This is the selector: it answers "does this email carry a one-time code, and
// which token is it?" and returns null when the answer is no. The gate is a code
// keyword somewhere in the text; the ranking is proximity to that keyword, with
// shape as the tie-break.
function pickVerificationCode(text) {
  const s = String(text || "");
  if (!s) return null;

  _CODE_KEYWORD_RE.lastIndex = 0;
  const keywordAt = [];
  for (const m of s.matchAll(_CODE_KEYWORD_RE)) keywordAt.push(m.index);
  if (!keywordAt.length) return null; // not a verification email

  const candidates = extractCodes(s);
  if (!candidates.length) return null;

  const yearLike = (c) => /^(19|20)\d{2}$/.test(c);
  const scored = [];
  for (const code of candidates) {
    const at = s.indexOf(code);
    if (at < 0) continue;
    const distance = Math.min(...keywordAt.map((k) => Math.abs(k - at)));
    // A bare year is only a code when it sits right on top of the keyword;
    // anywhere else it is a date, a copyright line, or a price.
    if (yearLike(code) && distance > 30) continue;
    let score = 0;
    if (distance <= 40) score += 100;
    else if (distance <= 120) score += 60;
    else if (distance <= 400) score += 20;
    if (/^[A-Z]{1,4}-\d{4,8}$/i.test(code)) score += 40; // "G-123456" is unambiguous
    if (/^\d{6}$/.test(code)) score += 25; // the overwhelmingly common OTP shape
    else if (/^\d{4,8}$/.test(code)) score += 10;
    if (/[A-Za-z]/.test(code) && /\d/.test(code)) score += 15; // mixed alnum
    scored.push({ code, score, distance });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const best = scored[0];
  return {
    code: best.code,
    confidence: best.score >= 100 ? "high" : best.score >= 60 ? "medium" : "low",
    others: scored.slice(1, 4).map((c) => c.code),
  };
}

module.exports = {
  parseGlobalFlags,
  parseFormatModes,
  compactEmail,
  compactResult,
  collectEmails,
  ensureSuccessField,
  exitCodeForResult,
  extractCodes,
  pickVerificationCode,
  handleJsonOrText,
  invalidUsage,
  inferErrorCode,
  leanResult,
};
