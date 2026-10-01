# mail-use privacy policy

Last updated: 2026-10-01

mail-use is an open-source command-line tool and skill published by Guo Li (leeguooooo). It connects directly from your computer to the email accounts you configure.

## What data it handles

- Email account settings and credentials (usually app passwords) that you write into a local config file (`~/.config/mailbox/auth.json`).
- Email messages, folders and metadata that it reads from your mail servers when you ask it to, plus a local cache of message headers (sender, subject, date, read state) on your computer that makes repeated reads faster.
- Emails you choose to send, move, mark or delete.

## Where data goes

- mail-use has no server. The publisher does not receive, collect, store or sell your credentials, emails or any other data.
- mail-use connects only to the IMAP and SMTP servers of the accounts you configure, using the provider's standard protocols. That provider's own privacy policy applies.
- The tool may check the public GitHub API for a newer release. That request contains no personal data.
- When you use mail-use through an AI assistant, the email content the assistant reads becomes part of that conversation and is handled under the assistant provider's privacy policy. The skill instructs the assistant never to display stored credentials and to show changes (sending, deleting, moving) to you for approval before they happen.

## Retention and control

Credentials and the cache stay on your computer until you delete them. Remove an account from the config file, or delete the config file and cache, to erase everything mail-use stores. Messages on your mail servers are governed by your provider.

## Contact

Questions: open an issue at https://github.com/leeguooooo/mail-use/issues or email leeguooooo@gmail.com.
