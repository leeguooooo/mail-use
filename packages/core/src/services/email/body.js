// Turning a parsed MIME message into something an agent can read: HTML to text,
// URL stripping, length caps, and List-Unsubscribe extraction.

function _stripUrls(text) {
  return String(text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

// Dependency-free HTML -> plain text. Good enough to give an agent a readable
// body for HTML-only mail (transactional senders, Moomoo, etc.) without shelling
// out to a parser. Not a sanitizer; output is plain text only.
function _htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|table|ul|ol)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return " ";
      }
    });
  s = s.replace(/[ \t\f\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// Single source of truth for body/html projection across showEmail (live + test)
// and showEmails. html_max_len semantics: <0 = unlimited, 0 = strip, >0 = cap.
// When the text body is empty but html exists, derive a text body from the html.
function _composeBody({ text, html, body_max_len = 0, html_max_len = 0, include_html = true, strip_urls = false }) {
  const includeHtml = include_html !== false;
  const htmlText = typeof html === "string" ? html : "";
  const rawText = String(text || "");
  // HTML-only mail often carries a near-empty text/plain part (just whitespace),
  // so treat whitespace-only text as absent and fall back to the html.
  const hasText = rawText.trim().length > 0;

  let body = hasText ? rawText : "";
  let bodySource = hasText ? "text" : "empty";
  if (!hasText && htmlText) {
    const derived = _htmlToText(htmlText);
    if (derived) {
      body = derived;
      bodySource = "html_derived";
    }
  }

  const bodyBase = strip_urls ? _stripUrls(body) : body;
  const bodyMax = Math.max(0, Number(body_max_len || 0));
  let bodyOut = bodyBase;
  let bodyTruncated = false;
  if (bodyMax > 0 && bodyOut.length > bodyMax) {
    bodyOut = bodyOut.slice(0, bodyMax);
    bodyTruncated = true;
  }

  let htmlOut = "";
  let htmlTruncated = false;
  if (includeHtml) {
    const hm = Number(html_max_len);
    if (hm < 0) {
      htmlOut = htmlText; // unlimited
    } else if (hm === 0) {
      htmlOut = ""; // strip
    } else if (htmlText.length > hm) {
      htmlOut = htmlText.slice(0, hm);
      htmlTruncated = true;
    } else {
      htmlOut = htmlText;
    }
  }

  return {
    body: bodyOut,
    html_body: htmlOut,
    body_source: bodySource,
    body_included: Boolean(bodyOut),
    html_included: includeHtml,
    body_url_stripped: Boolean(strip_urls),
    body_length: bodyBase.length,
    html_length: htmlText.length,
    body_truncated: bodyTruncated,
    html_truncated: htmlTruncated,
  };
}

function _parseListUnsubscribeHeader(value) {
  if (!value) return null;
  const str = Array.isArray(value) ? value.join(", ") : String(value);
  const mailto = (str.match(/<(mailto:[^>]+)>/i) || str.match(/\b(mailto:[^\s,>]+)/i) || [])[1] || null;
  const http = (str.match(/<(https?:[^>]+)>/i) || str.match(/\b(https?:[^\s,>]+)/i) || [])[1] || null;
  if (!mailto && !http) return null;
  return { mailto, http };
}

function _formatListUnsubscribeFromListHeader(unsubscribe) {
  if (!unsubscribe) return null;
  const mail = unsubscribe.mail || "";
  const url = unsubscribe.url || "";
  return {
    mailto: mail ? (String(mail).toLowerCase().startsWith("mailto:") ? mail : `mailto:${mail}`) : null,
    http: url || null,
  };
}

// Extract List-Unsubscribe header values from a mailparser-parsed email.
// mailparser may fold List-Unsubscribe into parsed.headers.get('list').unsubscribe
// or preserve a direct parsed.headers.get('list-unsubscribe') value.
function _extractListUnsubscribe(parsed) {
  if (!parsed || !parsed.headers) return null;
  const list = parsed.headers.get("list");
  const fromList = _formatListUnsubscribeFromListHeader(list && list.unsubscribe);
  if (fromList) return fromList;

  const direct = _parseListUnsubscribeHeader(parsed.headers.get("list-unsubscribe"));
  if (direct) return direct;

  // Fallback: scan raw headerLines.
  if (Array.isArray(parsed.headerLines)) {
    const line = parsed.headerLines.find((h) => h.key === "list-unsubscribe");
    if (line) {
      const fromRaw = _parseListUnsubscribeHeader(line.line || "");
      if (fromRaw) return fromRaw;
    }
  }
  return null;
}

module.exports = {
  _stripUrls,
  _htmlToText,
  _composeBody,
  _parseListUnsubscribeHeader,
  _formatListUnsubscribeFromListHeader,
  _extractListUnsubscribe,
};
