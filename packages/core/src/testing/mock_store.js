function _ensureState() {
  if (!globalThis.__MAILBOX_MOCK_STATE) {
    globalThis.__MAILBOX_MOCK_STATE = {
      accounts: {
        mock_acc: {
          id: "mock_acc",
          email: "mock@example.com",
          provider: "mock",
          password: "mock",
          mailboxes: {
            INBOX: {
              messages: [
                {
                  uid: 101,
                  messageId: "<m101@example.com>",
                  subject: "Hello",
                  from: "sender@example.com",
                  to: "mock@example.com",
                  cc: "",
                  date: "2026-02-01 00:00:00",
                  flags: new Set(["\\Seen"]),
                  body: "hello world",
                  html: "<p>hello world</p>",
                  listUnsubscribe: "<mailto:unsubscribe@example.com>, <https://example.com/unsubscribe>",
                  attachments: [],
                },
                {
                  uid: 102,
                  messageId: "<m102@example.com>",
                  subject: "Unread Note",
                  from: "news@example.com",
                  to: "mock@example.com",
                  cc: "",
                  date: "2026-02-01 01:00:00",
                  flags: new Set([]),
                  body: "unread body",
                  html: "",
                  attachments: [
                    {
                      filename: "a.txt",
                      contentType: "text/plain",
                      content: Buffer.from("attachment"),
                    },
                  ],
                },
                {
                  uid: 103,
                  messageId: "<m103@example.com>",
                  subject: "Your verification code",
                  from: "no-reply@auth.example.com",
                  to: "mock@example.com",
                  cc: "",
                  date: "2026-02-01 02:00:00",
                  // Seen on purpose: unread_stats tests assert exact unread
                  // counts for this fixture, and this row exists for the code
                  // selector, which doesn't care about read state.
                  flags: new Set(["\\Seen"]),
                  body: "Your verification code is 483920. It expires in 10 minutes.",
                  html: "",
                  attachments: [],
                },
              ],
            },
            Trash: { messages: [] },
          },
        },
      },
    };
  }
  return globalThis.__MAILBOX_MOCK_STATE;
}

function resetMockState() {
  delete globalThis.__MAILBOX_MOCK_STATE;
  _ensureState();
}

function getMockAccount(id) {
  const st = _ensureState();
  return st.accounts[id] || null;
}

function listMockAccounts() {
  const st = _ensureState();
  return Object.values(st.accounts);
}

function getMailbox(accountId, mailbox) {
  const acc = getMockAccount(accountId);
  if (!acc) return null;
  return acc.mailboxes[mailbox] || null;
}

function listMailboxNames(accountId) {
  const acc = getMockAccount(accountId);
  if (!acc) return [];
  return Object.keys(acc.mailboxes);
}

module.exports = {
  resetMockState,
  getMockAccount,
  listMockAccounts,
  getMailbox,
  listMailboxNames,
};
