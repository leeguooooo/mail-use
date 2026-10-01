const { _isTestMode, _allowInsecureTls } = require("./env");

function _buildTransportOptions(account) {
  const port = Number(account.smtp.port);
  const secure = Boolean(account.smtp.secure);
  const opts = {
    host: account.smtp.host,
    port,
    secure,
    auth: {
      user: account.email,
      pass: account.password,
    },
    tls: {
      rejectUnauthorized: !_allowInsecureTls(),
      minVersion: "TLSv1.2",
    },
    ...(account.timeouts ? {
      connectionTimeout: account.timeouts.connectMs,
      greetingTimeout: account.timeouts.connectMs,
      socketTimeout: account.timeouts.socketMs,
    } : {}),
  };
  // Implicit TLS (465): no STARTTLS upgrade. For everything else (587, 25, custom),
  // require STARTTLS so a hostile MITM can't strip TLS and force plaintext auth.
  if (!secure) {
    opts.requireTLS = true;
  }
  return opts;
}

// Test mode swaps in a transport that accepts everything (see
// testing/mock_smtp_transport.js) instead of reaching a real server.
function _createTransport(account) {
  if (_isTestMode()) {
    const { createMockSmtpTransport } = require("../testing/mock_smtp_transport");
    return createMockSmtpTransport();
  }
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport(_buildTransportOptions(account));
}

async function testConnection(account) {
  // Stays ahead of the host check: test accounts (provider "mock") carry no
  // SMTP settings, and checking them must still report success.
  if (_isTestMode()) {
    return { success: true };
  }

  if (!account || !account.smtp || !account.smtp.host) {
    return { success: false, error: "Missing SMTP host" };
  }

  const transporter = _createTransport(account);

  try {
    await transporter.verify();
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "SMTP verify failed" };
  }
}

async function sendMail({ account, to, cc, bcc, subject, text, html, attachments, headers }) {
  const transporter = _createTransport(account);

  const info = await transporter.sendMail({
    from: account.email,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    attachments,
    headers,
  });

  return {
    success: true,
    messageId: info.messageId || "",
  };
}

module.exports = {
  sendMail,
  testConnection,
  _buildTransportOptions,
};
