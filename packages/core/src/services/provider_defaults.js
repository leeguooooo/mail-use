const DEFAULTS = {
  "163": {
    imap_host: "imap.163.com",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "smtp.163.com",
    smtp_port: 465,
    smtp_secure: true,
  },
  "126": {
    imap_host: "imap.126.com",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "smtp.126.com",
    smtp_port: 465,
    smtp_secure: true,
  },
  qq: {
    imap_host: "imap.qq.com",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "smtp.qq.com",
    smtp_port: 465,
    smtp_secure: true,
  },
  gmail: {
    imap_host: "imap.gmail.com",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "smtp.gmail.com",
    // Implicit TLS (RFC 8314). Some networks blackhole 587 to Google — the TCP
    // connect succeeds but the greeting never arrives — while 465 works.
    smtp_port: 465,
    smtp_secure: true,
  },
  outlook: {
    imap_host: "outlook.office365.com",
    imap_port: 993,
    imap_secure: true,
    smtp_host: "smtp.office365.com",
    smtp_port: 587,
    smtp_secure: false,
  },
};

function normalizeProvider(provider) {
  const p = String(provider || "custom").toLowerCase().trim();
  if (!p) return "custom";
  return p;
}

function resolveProviderDefaults(provider) {
  const p = normalizeProvider(provider);
  return DEFAULTS[p] || null;
}

function resolveAccountConnectionConfig(account) {
  const provider = normalizeProvider(account.provider);
  const defaults = resolveProviderDefaults(provider);

  const imap_host = account.imap_host || account.imap_server || (defaults ? defaults.imap_host : "");
  const imap_port = Number(account.imap_port || (defaults ? defaults.imap_port : 993));
  const imap_secure = account.imap_secure != null ? Boolean(account.imap_secure) : defaults ? defaults.imap_secure : true;

  const smtp_host = account.smtp_host || account.smtp_server || (defaults ? defaults.smtp_host : "");
  const smtp_port = Number(account.smtp_port || (defaults ? defaults.smtp_port : 465));
  const smtp_secure = account.smtp_secure != null ? Boolean(account.smtp_secure) : defaults ? defaults.smtp_secure : smtp_port === 465;

  return {
    provider,
    imap: { host: imap_host, port: imap_port, secure: imap_secure },
    smtp: { host: smtp_host, port: smtp_port, secure: smtp_secure },
  };
}

module.exports = {
  normalizeProvider,
  resolveProviderDefaults,
  resolveAccountConnectionConfig,
};
