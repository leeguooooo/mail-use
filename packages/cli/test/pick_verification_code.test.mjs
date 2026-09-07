import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const contract = require("@mail-use/shared/src/contract.js");

const { pickVerificationCode, extractCodes } = contract;

describe("pickVerificationCode — is this a verification email, and which token is the code", () => {
  it("pulls a 6-digit OTP sitting next to the keyword", () => {
    const r = pickVerificationCode("Your verification code is 483920. It expires in 10 minutes.");
    expect(r?.code).toBe("483920");
    expect(r?.confidence).toBe("high");
  });

  it("handles the prefixed Google form", () => {
    const r = pickVerificationCode("G-558214 is your Google verification code");
    expect(r?.code).toBe("G-558214");
  });

  it("reads a Japanese 認証コード", () => {
    const r = pickVerificationCode("【ゆうちょ銀行】認証コード：741852 を入力してください");
    expect(r?.code).toBe("741852");
  });

  it("reads a Chinese 验证码", () => {
    const r = pickVerificationCode("您的验证码是 902133，5 分钟内有效。请勿泄露。");
    expect(r?.code).toBe("902133");
  });

  // The regression that motivated this function. Seen live: scanning 20 real
  // inbox emails with extractCodes marked 11 of them as carrying a "code", and
  // picked the year out of a service-termination notice as the answer.
  it("does NOT treat a marketing / notice email as a code email", () => {
    const notice = "【重要：ゆうちょレコ】サービス終了のお知らせ\n2026年3月31日をもってサービスを終了します。";
    expect(pickVerificationCode(notice)).toBeNull();
    // extractCodes on its own is permissive by design — that is exactly why it
    // must not be used as the selector.
    expect(extractCodes(notice).length).toBeGreaterThan(0);
  });

  it("rejects a bare year even when the mail does mention a code elsewhere", () => {
    const r = pickVerificationCode(
      "Enter the code below to sign in.\n\n992413\n\n© 2026 Example Inc. All rights reserved."
    );
    expect(r?.code).toBe("992413");
    expect(r?.others || []).not.toContain("2026");
  });

  it("returns null when there is no code keyword at all", () => {
    expect(pickVerificationCode("Your order 4820193 has shipped and arrives 2026-09-10")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(pickVerificationCode("")).toBeNull();
    expect(pickVerificationCode(null)).toBeNull();
  });

  it("prefers the keyword-adjacent candidate over an unrelated number", () => {
    const r = pickVerificationCode(
      "Invoice 8812004 is attached.\nYour security code is 330199 for confirmation."
    );
    expect(r?.code).toBe("330199");
  });

  it("downgrades confidence when the code is far from the keyword", () => {
    const filler = "x".repeat(300);
    const r = pickVerificationCode(`Please use the code below.\n${filler}\n557711`);
    expect(r?.code).toBe("557711");
    expect(["medium", "low"]).toContain(r?.confidence);
  });
});

// End-to-end through the CLI: list live → preview → pick, in one command.
describe("mail-use code (CLI)", () => {
  it("finds the OTP in the mock inbox and reports it as the answer", async () => {
    const { execa } = await import("execa");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { defaultAuth, testEnv, writeAuthJson } = await import("./_helpers.mjs");

    const root = path.join(import.meta.dirname, ".tmp", "code_cmd");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());
    const bin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");

    const r = await execa(
      "node",
      [bin, "code", "--account-id", "mock_acc", "--since", "2020-01-01", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.success).toBe(true);
    expect(p.code).toBe("483920");
    expect(p.newest.confidence).toBe("high");
    expect(p.newest.from).toMatch(/auth\.example\.com/);
    // The two non-code fixture emails must not be counted as candidates.
    expect(p.matched).toBe(1);
    expect(p.scanned).toBeGreaterThanOrEqual(3);
  });

  it("reports a clean no-match (not an error) with a widening hint", async () => {
    const { execa } = await import("execa");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { defaultAuth, testEnv, writeAuthJson } = await import("./_helpers.mjs");

    const root = path.join(import.meta.dirname, ".tmp", "code_cmd_none");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());
    const bin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");

    const r = await execa("node", [bin, "code", "--account-id", "mock_acc", "--since", "30m", "--json"], {
      reject: false,
      env,
    });
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.success).toBe(true);
    expect(p.code).toBeNull();
    expect(p.matched).toBe(0);
    expect(p.hint).toMatch(/--since/);
  });
});
