// Where a person gets the secret mail-use needs for each mail provider.
//
// None of the big Chinese providers (nor Gmail or iCloud) accept the normal
// login password over IMAP/SMTP: each wants a separate "authorization code" or
// "app-specific password" generated on its website. People who are not
// technical do not know that, so every place that asks for the secret shows
// the page to open and the two or three clicks to make there.
//
// Pure data + lookups; no I/O, so the CLI and tests can use it freely.

const { resolveProviderDefaults } = require("./provider_defaults");

// Email domain -> provider id (ids match provider_defaults.js).
const DOMAIN_PROVIDERS = {
  "qq.com": "qq",
  "vip.qq.com": "qq",
  "foxmail.com": "qq",
  "163.com": "163",
  "vip.163.com": "163",
  "126.com": "126",
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "outlook.com": "outlook",
  "hotmail.com": "outlook",
  "live.com": "outlook",
  "msn.com": "outlook",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
};

// Server host suffix -> provider, for addresses on a custom domain whose mail
// is still hosted by a known provider (e.g. a company domain on Google
// Workspace shows imap.gmail.com in Apple Mail). Apple Mail also uses private
// endpoints such as appleimap.163.com, which the suffix match covers too.
const HOST_PROVIDERS = [
  [/(^|\.)qq\.com$/i, "qq"],
  [/(^|\.)163\.com$/i, "163"],
  [/(^|\.)126\.com$/i, "126"],
  [/(^|\.)gmail\.com$/i, "gmail"],
  [/(^|\.)mail\.me\.com$/i, "icloud"],
  [/(^|\.)(office365|outlook)\.com$/i, "outlook"],
];

const GUIDES = {
  qq: {
    label: "QQ 邮箱",
    needs: "授权码",
    url: "https://wx.mail.qq.com",
    steps: [
      "用电脑浏览器登录网页版 QQ 邮箱 → 右上角「设置」→「账号与安全」→「安全设置」",
      "开启「IMAP/SMTP 服务」，按提示用手机验证后点「生成授权码」",
      "把那串 16 位授权码复制过来（不是 QQ 密码）",
    ],
  },
  "163": {
    label: "163 邮箱",
    needs: "授权码",
    url: "https://mail.163.com",
    steps: [
      "登录网页版 163 邮箱 → 顶部「设置」→「POP3/SMTP/IMAP」",
      "开启「IMAP/SMTP 服务」，再点「新增授权密码」，按提示用手机验证",
      "把生成的授权码复制过来（不是邮箱登录密码）",
    ],
  },
  "126": {
    label: "126 邮箱",
    needs: "授权码",
    url: "https://mail.126.com",
    steps: [
      "登录网页版 126 邮箱 → 顶部「设置」→「POP3/SMTP/IMAP」",
      "开启「IMAP/SMTP 服务」，再点「新增授权密码」，按提示用手机验证",
      "把生成的授权码复制过来（不是邮箱登录密码）",
    ],
  },
  gmail: {
    label: "Gmail",
    needs: "应用专用密码",
    url: "https://myaccount.google.com/apppasswords",
    steps: [
      "先在 Google 账号里开启「两步验证」（没开的话这个页面会提示你）",
      "打开上面的链接，随便起个名字（比如 mail-use），点「创建」",
      "把显示的 16 位密码复制过来（空格可以不管）",
    ],
  },
  icloud: {
    label: "iCloud 邮箱",
    needs: "应用专用密码",
    url: "https://account.apple.com",
    steps: [
      "Apple 账号要已开启双重认证；用它登录上面的网站 →「登录与安全」→「App 专用密码」",
      "点「生成 App 专用密码」，随便起个名字（比如 mail-use）",
      "把生成的密码（形如 abcd-efgh-ijkl-mnop）复制过来",
    ],
  },
  outlook: {
    label: "Outlook / Hotmail",
    needs: "应用专用密码",
    url: "https://account.microsoft.com/security",
    steps: ["微软已经不再允许个人 Outlook/Hotmail 账号用密码登录 IMAP，mail-use 暂时还不支持这类邮箱。"],
    unsupported: true,
  },
  custom: {
    label: "其他邮箱",
    needs: "授权码",
    url: "",
    steps: [
      "登录邮箱网页版，在「设置」里找到 IMAP/SMTP，把它开启",
      "如果页面里有「授权码 / 客户端密码」，生成一个用它；没有就用邮箱登录密码",
    ],
  },
};

function _domainOf(email) {
  const s = String(email || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  return at >= 0 ? s.slice(at + 1) : "";
}

// Provider id for an address ("qq", "163", ..., or "custom"). serverHost is
// optional: the IMAP host Apple Mail (or the user) has for the account.
function detectProvider(email, serverHost) {
  const byDomain = DOMAIN_PROVIDERS[_domainOf(email)];
  if (byDomain) return byDomain;
  const host = String(serverHost || "").trim().toLowerCase();
  if (host) {
    for (const [re, provider] of HOST_PROVIDERS) if (re.test(host)) return provider;
  }
  return "custom";
}

// { provider, label, needs, url, steps, supported, has_defaults }
function guideFor(emailOrProvider, serverHost) {
  const raw = String(emailOrProvider || "").trim().toLowerCase();
  const provider = raw.includes("@") ? detectProvider(raw, serverHost) : (GUIDES[raw] ? raw : "custom");
  const g = GUIDES[provider] || GUIDES.custom;
  return {
    provider,
    label: g.label,
    needs: g.needs,
    url: g.url,
    steps: g.steps.slice(),
    supported: !g.unsupported,
    // false: mail-use has no built-in servers, so the IMAP/SMTP hosts must
    // come from flags or from Apple Mail's settings.
    has_defaults: Boolean(resolveProviderDefaults(provider)),
  };
}

module.exports = { detectProvider, guideFor, DOMAIN_PROVIDERS };
