---
name: mail-use
description: Read, search, send and organize email across Gmail, Outlook, QQ, 163 and any IMAP/SMTP account through the mail-use command-line tool on the user's computer. Use when the user asks to check unread mail, find an email (an order confirmation, a customer reply, an invoice), read a thread, reply to or send an email, or move, mark, archive or clean up messages across one or more of their mailboxes. 查邮件、查未读、回复邮件、整理邮箱.
---

# mail-use

Drives the `mail-use` CLI, which talks directly to the user's own mail servers over IMAP/SMTP. Accounts and credentials live in a config file on the user's computer; nothing passes through a third-party service. Every command returns JSON with `success: boolean`, and on failure `error` plus a machine-readable `error_code`.

## Before the first call

1. Run `mail-use --version`. If the command is not found, stop and tell the user mail-use needs to be installed on their computer first. Point them to https://github.com/leeguooooo/mail-use#install and let them install it; do not download or run an installer yourself.
2. Run `mail-use account list --json`. If it returns no accounts, ask the user to add one: they copy `examples/accounts.example.json` from the repo to `~/.config/mailbox/auth.json` and fill in their own server and app password. Never ask the user to paste a password into the conversation, and never print the contents of `auth.json`.
3. Commands below need mail-use 2.11 or newer. On an older version, ask the user to update it (`mail-use upgrade`).

## Read and search

Always pass `--json` and check `success`.

```bash
# Recent mail across all accounts, newest first
mail-use email recent --limit 30 --json
mail-use email recent --since 3d --json

# One account's INBOX ('list' is INBOX-only; use 'search' for other folders)
mail-use email list --account-id <id> --limit 20 --json
mail-use email list --account-id <id> --limit 20 --with-preview 200 --json   # + body snippet
mail-use email list --account-unread --json        # also report unread across all folders

# Search (server-side for Gmail; client-side fallback for QQ/163/Outlook)
mail-use email search --from amazon --subject review --folder all --json
mail-use email search --query "interview" --since 2w --json
mail-use email search --query inv --account-id <id> --folder INBOX --limit 20 --timeout 30 --json

# Read one or several emails (text only, capped at 2000 chars, URLs stripped by default)
mail-use email show <gid> --json
mail-use email show <gid1> <gid2> <gid3> --json    # one connection, spans folders
mail-use email show <gid> --full --json            # raw HTML, uncapped (rarely needed)

mail-use email folders --account-id <id> --json
```

- A `gid` is `account_id:folder:uid`. Every list, search and show result carries one; pass it instead of a bare uid, and commands target the right folder automatically.
- On QQ, 163, 126, Sina, Aliyun and Outlook, IMAP text search is broken, so `--query` matches only subject and sender there. Use `--from` / `--subject` for predictable results. Search on those providers scans the folder client-side and can be slow; `--timeout` (default 60s) is a hard limit and returns partial results with `timed_out: true`.
- Relative dates work on `--since`: `12h`, `7d`, `3w`, `1mo`, `today`, `yesterday`, `last-week`.
- An empty `list` or `recent` may be a stale cache. Check `from_cache` and `cache_age_seconds`, and pass `--live` to read the server directly.
- Unread counts: `unread_in_result` (among returned rows), `folder_unread` (server count for that folder), `account_unread_total` (all folders, only with `--account-unread`).

## Change mail (dry-run by default)

Every command that changes a mailbox returns a preview and changes nothing unless `--confirm` is passed. Show the user the preview and get their approval before adding `--confirm`. Before sending, show the recipients, subject and body.

```bash
mail-use email send --to a@b.com --subject "Re: invoice" --body "..." --json            # preview
mail-use email send --to a@b.com --subject "Re: invoice" --body "..." --confirm --json  # after approval

mail-use email mark <gid> --read --confirm --json
mail-use email flag <gid> --set --confirm --json
mail-use email move <gid1> <gid2> --target-folder Archive --confirm --json
mail-use email delete <gid> --confirm --json        # moves to Trash; --permanent expunges

# Filter-based changes, grouped per account and folder in the preview
mail-use email mark --subject "[ci]" --read --confirm --json
mail-use email delete --from newsletter@shop.com --confirm --json
```

`--all-folders` skips Sent, Drafts, Junk and Trash unless `--include-special` is passed. A filter that matches more than 100 emails always requires `--confirm`.

## Clean up an inbox

```bash
mail-use cleanup --account-id <id> --json                              # read-only plan
mail-use cleanup --account-id <id> --categories marketing --confirm --json
```

`cleanup` sorts INBOX mail into protected categories (finance, travel, security, support cases — never deleted), cleanup candidates (marketing, routine notifications) and unknown. Present the plan, with counts and sample subjects, and act only on the categories the user approves.

## Output tips

- `--format compact` returns just `{gid, account_id, folder, date, from, subject, unread, has_attachments, body_text_preview}` per email — the cheapest shape for scanning.
- `--with-preview <N>` on list/search saves a separate `show` per email.
- `mail-use <cmd> --help --json` describes any command's options.
- Exit codes: 0 success, 1 operation failed, 2 invalid usage. Common `error_code`s: `account_not_found`, `email_not_found`, `folder_not_found`, `auth_failed`, `network_error`, `invalid_argument`.

## Limits

- Runs on the user's computer, where mail-use and the account config live. In a cloud environment without them, say so instead of guessing.
- Reads only the mailboxes the user configured. It does not create accounts or bypass a provider's sign-in; providers that require an app password need the user to create one.
- Do not repeat full email bodies, addresses or attachments to anyone other than the user unless they ask.
