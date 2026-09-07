// Rule-based email classifier. Buckets an email into one of 7 categories used by
// the cleanup workflow. Protected categories short-circuit before any cleanup
// bucket, so finance/travel/security/support mail is never proposed for deletion.
//
// Categories: protected_finance | protected_travel | security | support_case |
//             marketing | routine_notification | unknown

const fs = require("fs");
const path = require("path");

const PROTECTED = new Set(["protected_finance", "protected_travel", "security", "support_case"]);
const CLEANUP = new Set(["marketing", "routine_notification"]);

// Shipped defaults. Override per-user via <configDir>/cleanup_rules.json (deep
// merged — arrays are replaced, not concatenated).
const DEFAULT_RULES = {
  finance: {
    domains: [
      "paypal.com", "paypay.ne.jp", "paypay-bank.co.jp", "paypay-corp.co.jp", "stripe.com",
      "wise.com", "mufg.jp", "mizuhobank", "smbc", "rakuten-bank", "japanpost.jp", "jp-bank",
      "chase.com", "bankofamerica.com", "americanexpress.com", "amex", "visa.com", "mastercard",
    ],
    subjects: [
      "invoice", "receipt", "statement", "billing", "payment received", "your bill",
      "請求", "領収", "明細", "振込", "入金", "お支払", "決済", "账单", "对账单", "发票", "回单",
    ],
  },
  travel: {
    domains: [
      "ana.co.jp", "jal.com", "united.com", "delta.com", "aa.com", "booking.com", "expedia",
      "airbnb", "agoda", "trip.com", "skyscanner", "eki-net.com", "jreast", "klook",
    ],
    subjects: [
      "boarding", "itinerary", "reservation", "your booking", "flight", "pnr", "check-in",
      "予約", "搭乗", "行程", "フライト", "订票", "行程单", "登机", "预订",
    ],
  },
  security: {
    domains: ["accounts.google.com", "google.com", "microsoft.com", "apple.com", "github.com", "okta.com"],
    senders: ["security@", "verify@", "otp@", "no-reply@accounts"],
    subjects: [
      "verification code", "one-time", "otp", "2fa", "two-factor", "security alert",
      "sign-in", "signin", "new login", "password reset", "verify your", "confirm your email",
      "認証コード", "ワンタイム", "セキュリティ", "验证码", "安全提醒", "登录",
    ],
  },
  support: {
    senders: ["support@", "help@", "customercare@", "customer-service@"],
    subjects: ["ticket #", "case #", "ticket#", "case#", "support request", "[case", "お問い合わせ", "サポート", "工单", "客服"],
  },
  marketing: {
    senders: ["newsletter@", "marketing@", "promo@", "news@", "campaign@", "deals@", "offers@", "info@"],
    subjects: [
      "unsubscribe", "newsletter", "% off", "sale", "deal", "promo", "coupon", "limited time",
      "セール", "お得", "クーポン", "限定", "促销", "优惠", "新品", "上新",
    ],
  },
  routine: {
    senders: ["no-reply@", "noreply@", "donotreply@", "do-not-reply@", "notification@", "notifications@", "automated@", "mailer@"],
    subjects: ["do not reply", "automated", "notification", "お知らせ", "通知", "自動", "自动", "システム"],
  },
};

let _cachedRules = null;

function loadRules() {
  if (_cachedRules) return _cachedRules;
  let rules = DEFAULT_RULES;
  try {
    const { paths } = require("@mail-use/shared");
    const cfg = paths.getPathConfig();
    const file = path.join(cfg.configDir, "cleanup_rules.json");
    if (fs.existsSync(file)) {
      const override = JSON.parse(fs.readFileSync(file, "utf8"));
      rules = _mergeRules(DEFAULT_RULES, override);
    }
  } catch {
    rules = DEFAULT_RULES;
  }
  _cachedRules = rules;
  return rules;
}

function _mergeRules(base, override) {
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(override || {})])) {
    const b = base[k] || {};
    const o = (override && override[k]) || {};
    out[k] = { ...b, ...o }; // arrays replaced wholesale
  }
  return out;
}

function _domainOf(from) {
  const m = String(from || "").toLowerCase().match(/@([a-z0-9.-]+)/);
  return m ? m[1] : "";
}

function classify(meta, rules) {
  const r = rules || loadRules();
  const from = String((meta && meta.from) || "").toLowerCase();
  const subject = String((meta && meta.subject) || "").toLowerCase();
  const domain = _domainOf(from);
  const hasUnsub = Boolean(meta && meta.list_unsubscribe);

  const anyDomain = (list) => (list || []).some((d) => domain.includes(String(d).toLowerCase()));
  const anySender = (list) => (list || []).some((s) => from.includes(String(s).toLowerCase()));
  const anySubject = (list) => (list || []).some((s) => subject.includes(String(s).toLowerCase()));

  // Protected categories first — these are never cleanup candidates.
  if (anyDomain(r.finance.domains) || anySubject(r.finance.subjects)) return "protected_finance";
  if (anyDomain(r.travel.domains) || anySubject(r.travel.subjects)) return "protected_travel";
  if (anyDomain(r.security.domains) || anySender(r.security.senders) || anySubject(r.security.subjects)) return "security";
  if (anySender(r.support.senders) || anySubject(r.support.subjects)) return "support_case";

  // Cleanup-eligible categories.
  if (hasUnsub || anySender(r.marketing.senders) || anySubject(r.marketing.subjects)) return "marketing";
  if (anySender(r.routine.senders) || anySubject(r.routine.subjects)) return "routine_notification";

  return "unknown";
}

// Test hook so a fresh config override is picked up.
function _resetRulesCache() {
  _cachedRules = null;
}

module.exports = {
  classify,
  loadRules,
  PROTECTED,
  CLEANUP,
  DEFAULT_RULES,
  _resetRulesCache,
};
