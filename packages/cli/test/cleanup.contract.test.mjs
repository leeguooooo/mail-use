import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import path from "node:path";
import fs from "node:fs";

import { defaultAuth, testEnv, writeAuthJson } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const { classify } = require("@mail-use/workflows").classify;

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}
function cliBin() {
  return path.join(import.meta.dirname, "..", "bin", "mail-use.js");
}

describe("WP-G: classifier", () => {
  it("buckets emails into the 7 categories with protected taking priority", () => {
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
