import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const contract = require("@mail-use/shared/src/contract.js");

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

describe("extractCodes (verification/OTP heuristic)", () => {
  it("pulls prefixed LL-DDDDDD codes", () => {
    expect(contract.extractCodes("Your code is QB-046193 thanks")).toEqual(["QB-046193"]);
    expect(contract.extractCodes("G-1234 is your Google code")).toEqual(["G-1234"]);
  });
  it("pulls bare 4-8 digit OTPs", () => {
    expect(contract.extractCodes("Verification code: 482913")).toEqual(["482913"]);
  });
  it("does not double-report the digits of a prefixed code", () => {
    expect(contract.extractCodes("Use QB-046193 now")).toEqual(["QB-046193"]);
  });
  it("ignores prose like 'Code 123456' as a prefix (hyphen-only)", () => {
    // The word 'Code' (space, not hyphen) must NOT become a prefixed code.
    expect(contract.extractCodes("Code 123456")).toEqual(["123456"]);
  });
  it("ignores digit runs longer than 8 (phone numbers, ids)", () => {
    expect(contract.extractCodes("call +1 5551234567 now")).toEqual([]);
  });
  it("returns [] for empty / code-less text", () => {
    expect(contract.extractCodes("")).toEqual([]);
    expect(contract.extractCodes("no codes here at all")).toEqual([]);
  });

  // #26: a Japanese bank sent "・認証コード：vM8xw" and --extract-code returned
  // null. Mixed-case alphanumeric codes are the norm at JP banks, Stripe and
  // GitHub, so digit-only extraction quietly loses the code the agent came for.
  it("pulls keyword-anchored alphanumeric codes (#26)", () => {
    expect(contract.extractCodes("・認証コード：vM8xw")).toEqual(["vM8xw"]);
    expect(contract.extractCodes("Your verification code is a1B2c3")).toEqual(["a1B2c3"]);
    expect(contract.extractCodes("Your security code is 9f3K2a, valid 10 min")).toEqual(["9f3K2a"]);
    expect(contract.extractCodes("ワンタイムパスワード：Ab12Cd")).toEqual(["Ab12Cd"]);
    expect(contract.extractCodes("验证码：8k2Mx9")).toEqual(["8k2Mx9"]);
    expect(contract.extractCodes("인증번호 x7Y2z1")).toEqual(["x7Y2z1"]);
  });

  it("does not turn prose after a code keyword into a code (#26)", () => {
    // The keyword anchor alone is not enough — requiring a digit is what keeps
    // ordinary words out. Both of these used to be the obvious failure mode.
    expect(contract.extractCodes("code: please check your account")).toEqual([]);
    expect(contract.extractCodes("Please read the code of conduct")).toEqual([]);
  });
});

describe("email show --extract-code wires codes onto the result", () => {
  it("single show adds a codes:[] array (and it survives --format compact)", async () => {
    const root = tmpRoot("extract_code_show");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "email", "show", "101", "--account-id", "mock_acc", "--extract-code", "--format", "compact"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(Array.isArray(payload.codes)).toBe(true); // present even when empty
  });
});
