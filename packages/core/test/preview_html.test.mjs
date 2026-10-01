import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { _previewFromSource } = require("../src/services/email/message_source.js");

function mail(contentType, body) {
  return Buffer.from(
    `From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}; charset=utf-8\r\n\r\n${body}\r\n`
  );
}

describe("list/search preview", () => {
  it("uses the text part when there is one", async () => {
    const r = await _previewFromSource(mail("text/plain", "plain   body\n\nhere"), 40);
    expect(r.preview).toBe("plain body here");
  });

  it("falls back to the html part for HTML-only mail", async () => {
    const r = await _previewFromSource(mail("text/html", "<html><body><p>Hello <b>world</b></p><p>again</p></body></html>"), 40);
    expect(r.preview).toBe("Hello world again");
  });

  it("marks a preview cut at previewChars as truncated", async () => {
    const r = await _previewFromSource(mail("text/html", `<p>${"x".repeat(50)}</p>`), 10);
    expect(r.preview).toHaveLength(10);
    expect(r.preview_truncated).toBe(true);
  });
});
