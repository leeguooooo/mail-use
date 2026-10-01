// Stand-in for a nodemailer transport in MAILBOX_INTERNAL_TEST_MODE: accepts
// every message and reports a fixed message id, without touching the network.
function createMockSmtpTransport() {
  return {
    async verify() {
      return true;
    },
    async sendMail() {
      return { messageId: "<mock-sent@example.com>" };
    },
  };
}

module.exports = { createMockSmtpTransport };
