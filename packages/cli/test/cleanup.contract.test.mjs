import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const { classify, loadRules, PROTECTED, CLEANUP, _resetRulesCache } = require("@mail-use/workflows").classify;

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

describe("WP-G: classifier", () => {
  it("buckets emails into the categories with protected taking priority", () => {
    expect(classify({ from: "service@paypal.com", subject: "Your receipt" })).toBe("protected_finance");
    // protected_travel wins over marketing even though info@ is a marketing sender
    expect(classify({ from: "info@ana.co.jp", subject: "Your booking confirmation" })).toBe("protected_travel");
    expect(classify({ from: "no-reply@accounts.google.com", subject: "Security alert: new sign-in" })).toBe("security");
    expect(classify({ from: "support@acme.com", subject: "[Case #123] update" })).toBe("support_case");
    expect(classify({ from: "news@shop.com", subject: "Weekly newsletter" })).toBe("marketing");
    expect(classify({ from: "noreply@app.com", subject: "System notification" })).toBe("routine_notification");
    expect(classify({ from: "bob@example.com", subject: "lunch?" })).toBe("unknown");
  });
});

describe("WP-G: cleanup workflow (CLI)", () => {
  it("plan classifies the mock inbox and lists cleanup candidates (read-only)", async () => {
    const root = tmpRoot("cleanup_plan");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa("node", [cliBin(), "cleanup", "--account-id", "mock_acc", "--json"], { reject: false, env });
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.success).toBe(true);
    expect(p.plan_only).toBe(true);
    // mock 102 is from news@example.com → marketing candidate; 101 → unknown.
    expect(p.candidates_by_category.marketing.map((e) => e.id)).toContain("102");
    expect(p.by_category).toHaveProperty("unknown");
    expect(p.confirmation_required).toBe(true);
  });

  it("apply deletes the candidate categories and reports deleted_count", async () => {
    const root = tmpRoot("cleanup_apply");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa(
      "node",
      [cliBin(), "cleanup", "--account-id", "mock_acc", "--categories", "marketing", "--confirm", "--json"],
      { reject: false, env }
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.applied).toBe(true);
    expect(out.categories).toEqual(["marketing"]);
    expect(out.deleted_count).toBe(1); // 102 moved to trash
  });
});

describe("cleanup: action-required / alert mail is protected", () => {
  // Real subjects that were classified routine_notification (= deletable)
  // because they come from a noreply@ notification address.
  const cloudflare = "noreply@notify.cloudflare.com";
  const protectedSubjects = [
    "[需要操作] 恢复 jryuukin.jp 的名称服务器",
    "[警报] jryuukin.jp 已删除",
    "[警报] D1 每日操作限制已达到 76%",
    "[Action Required] Verify your domain nameservers",
    "Action required: update your payment method",
    "[Alert] Worker CPU limit exceeded",
    "Your domain example.com expires in 7 days",
    "Your account has been suspended",
    "Scheduled deletion of inactive project",
    "Final notice: invoice overdue",
    "Payment failed for your subscription",
    "需要采取措施：域名即将到期",
    "【要対応】ドメイン設定の確認",
    "ご対応のお願い",
    "【重要】サービス停止のお知らせ",
    "紧急：服务器宕机",
    "お支払い期限のご案内",
    "督促状",
    "未納のお知らせ",
  ];

  for (const subject of protectedSubjects) {
    it(`never a cleanup candidate: ${subject}`, () => {
      const cat = classify({ from: cloudflare, subject });
      expect(PROTECTED.has(cat)).toBe(true);
      expect(CLEANUP.has(cat)).toBe(false);
    });
  }

  it("lands in action_required (not routine_notification) for noreply alerts", () => {
    expect(classify({ from: cloudflare, subject: "[需要操作] 恢复 jryuukin.jp 的名称服务器" })).toBe("action_required");
    expect(classify({ from: cloudflare, subject: "[警报] jryuukin.jp 已删除" })).toBe("action_required");
    expect(classify({ from: cloudflare, subject: "[警报] D1 每日操作限制已达到 76%" })).toBe("action_required");
    // Plain noreply notifications are still routine.
    expect(classify({ from: cloudflare, subject: "Weekly analytics summary notification" })).toBe("routine_notification");
  });

  it("action_required beats marketing signals (unsubscribe header, promo sender)", () => {
    expect(classify({ from: "news@shop.com", subject: "Action required: confirm your order", list_unsubscribe: "<mailto:x@y>" })).toBe("action_required");
  });

  it("cleanup_rules.json can override action_required (arrays replace defaults)", () => {
    const root = tmpRoot("cleanup_rules_override");
    fs.rmSync(root, { recursive: true, force: true });
    const configDir = path.join(root, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "cleanup_rules.json"),
      JSON.stringify({ action_required: { subjects: ["please respond"], senders: ["alerts@"] } }),
    );
    const saved = { c: process.env.MAILBOX_CONFIG_DIR, d: process.env.MAILBOX_DATA_DIR };
    process.env.MAILBOX_CONFIG_DIR = configDir;
    process.env.MAILBOX_DATA_DIR = path.join(root, "data");
    try {
      _resetRulesCache();
      const rules = loadRules();
      expect(classify({ from: "noreply@x.com", subject: "Please respond by Friday" }, rules)).toBe("action_required");
      expect(classify({ from: "alerts@monitor.io", subject: "daily digest" }, rules)).toBe("action_required");
      // Replaced, not concatenated: a default-only keyword no longer matches.
      expect(classify({ from: "noreply@x.com", subject: "Payment failed" }, rules)).toBe("routine_notification");
    } finally {
      _resetRulesCache();
      if (saved.c === undefined) delete process.env.MAILBOX_CONFIG_DIR;
      else process.env.MAILBOX_CONFIG_DIR = saved.c;
      if (saved.d === undefined) delete process.env.MAILBOX_DATA_DIR;
      else process.env.MAILBOX_DATA_DIR = saved.d;
    }
  });
});

describe("cleanup: scan limit is surfaced", () => {
  it("reports scan_limit and truncated=true when the folder holds more than --limit", async () => {
    const root = tmpRoot("cleanup_scan_limit");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    // The mock INBOX holds 3 emails.
    const r = await execa("node", [cliBin(), "cleanup", "--account-id", "mock_acc", "--limit", "2", "--json"], { reject: false, env });
    expect(r.exitCode).toBe(0);
    const p = JSON.parse(r.stdout);
    expect(p.scanned).toBe(2);
    expect(p.scan_limit).toBe(2);
    expect(p.total_in_folder).toBe(3);
    expect(p.truncated).toBe(true);
    expect(p.scan_note).toMatch(/--limit/);
  });

  it("truncated=false when everything fit", async () => {
    const root = tmpRoot("cleanup_scan_full");
    fs.rmSync(root, { recursive: true, force: true });
    const env = testEnv(root);
    writeAuthJson(env.MAILBOX_CONFIG_DIR, defaultAuth());

    const r = await execa("node", [cliBin(), "cleanup", "--account-id", "mock_acc", "--json"], { reject: false, env });
    const p = JSON.parse(r.stdout);
    expect(p.scan_limit).toBe(200);
    expect(p.truncated).toBe(false);
    expect(p).not.toHaveProperty("scan_note");
  });
});
