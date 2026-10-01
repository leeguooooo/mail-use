import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildMobileconfig, unsupportedReason, _uuidFor, PROFILE_IDENTIFIER } = require("../src/services/apple_mail.js");

function acc(over = {}) {
  return {
    id: "qq_main",
    email: "me@qq.com",
    provider: "qq",
    password: "auth&code<1>\"'",
    imap: { host: "imap.qq.com", port: 993, secure: true },
    smtp: { host: "smtp.qq.com", port: 465, secure: true },
    ...over,
  };
}

describe("apple mail profile", () => {
  it("escapes XML so a password with &<>\"' survives intact", () => {
    const xml = buildMobileconfig([acc()]);
    expect(xml).toContain("<string>auth&amp;code&lt;1&gt;&quot;&apos;</string>");
    expect(xml).not.toContain("auth&code<1>");
  });

  it("is a valid plist with one mail payload per account (plutil, macOS only)", () => {
    if (process.platform !== "darwin") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-mail-"));
    const f = path.join(dir, "p.mobileconfig");
    fs.writeFileSync(f, buildMobileconfig([acc(), acc({ id: "g", email: "me@gmail.com", provider: "gmail" })]));
    const json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", f], { encoding: "utf8" }));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(json.PayloadIdentifier).toBe(PROFILE_IDENTIFIER);
    expect(json.PayloadContent).toHaveLength(2);
    const [qq] = json.PayloadContent;
    expect(qq).toMatchObject({
      PayloadType: "com.apple.mail.managed",
      EmailAddress: "me@qq.com",
      IncomingMailServerHostName: "imap.qq.com",
      IncomingMailServerPortNumber: 993,
      IncomingMailServerUseSSL: true,
      OutgoingMailServerHostName: "smtp.qq.com",
      OutgoingMailServerPortNumber: 465,
      IncomingPassword: "auth&code<1>\"'",
      EmailAccountDescription: "QQ 邮箱 (me@qq.com)",
    });
  });

  it("uses stable UUIDs so reinstalling replaces instead of duplicating", () => {
    expect(buildMobileconfig([acc()])).toBe(buildMobileconfig([acc()]));
    expect(_uuidFor("a")).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(_uuidFor("a")).not.toBe(_uuidFor("b"));
  });

  it("leaves out accounts it cannot configure", () => {
    expect(unsupportedReason(acc({ password: "" }))).toMatch(/password/);
    expect(unsupportedReason(acc({ imap: { host: "" } }))).toMatch(/IMAP/);
    expect(unsupportedReason(acc())).toBe("");
    expect(() => buildMobileconfig([acc({ password: "" })])).toThrow(/no account/);
  });

  it("STARTTLS ports still require TLS in Mail", () => {
    const xml = buildMobileconfig([acc({ smtp: { host: "smtp.office365.com", port: 587, secure: false } })]);
    expect(xml).toMatch(/OutgoingMailServerPortNumber<\/key><integer>587<\/integer>/);
    expect(xml).toMatch(/OutgoingMailServerUseSSL<\/key><true\/>/);
  });
});
