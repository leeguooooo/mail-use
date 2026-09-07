# AI Skill: mail-use CLI (OpenClaw-first)

This document is written for an AI agent that is allowed to run shell commands.
Goal: reliably read/manage emails by calling the `mail-use` CLI.

OpenClaw-first: channel delivery (Telegram/Slack/Discord/etc) and scheduling
are handled by OpenClaw. The mail-use CLI focuses on email operations and
returns structured JSON.

## Skill Keywords (OpenClaw)

Use these tags/keywords for discovery:

- OpenClaw keywords (keep this list short):
  - `mail-use`, `email`, `imap`, `smtp`, `cli`, `automation`, `openclaw`, `agent`, `sync`, `inbox`

- Extended tags (npm/GitHub topics):
  - `search`, `attachments`, `digest`, `monitor`, `ai`

## Install (npm)

Install the published CLI:

```bash
npm install -g @leeguoo/mail-use
mail-use --help
mail-use --version
```

This npm package ships prebuilt binaries per platform (no Python required).

## Configuration files

- Credentials: `~/.config/mailbox/auth.json`
- Other settings: `~/.config/mailbox/config.toml`

Backward compatibility:

- If `auth.json` is missing but a legacy `accounts.json` exists (e.g. repo `data/accounts.json`
or old legacy layout), the CLI will read it and best-effort migrate to `auth.json`.

## Output contract

- When `--json` is passed, commands print a single JSON object to stdout.
- When stdout is non-TTY, JSON output is used by default.
- JSON payloads include:
  - `success: boolean`
  - `error: { code, message, detail? }` (only when `success=false`)
  - `error_message: string` (backward-compat summary)
- Exit codes:
  - `0`: success
  - `1`: operation failed (network/auth/remote/server error)
  - `2`: invalid CLI usage (argparse validation / missing args)

For automation: always use `--json` and check both exit code and `success`.

## OpenClaw usage
- Treat mail-use as a tool: OpenClaw calls the CLI and consumes JSON output.
- For channel delivery, OpenClaw formats/sends messages using its built-in
  integrations. mail-use should not send directly to chat channels.

## Required safety rules for AI

- Always identify the account when doing destructive operations.
  - Use `--account-id <id>` for: `email show`, `email mark`, `email delete`, `email move`, `email flag`.
- Prefer `--dry-run` for mark/delete when available.
- Destructive operations default to dry-run unless `--confirm` is provided.
- When you only need a list, prefer cache (default) for performance.
  - Add `--live` only when cache is stale or missing.

## Common workflows

### 1) Discover accounts

```bash
mail-use account list --json
```

Select an `account_id` from the output.

### 2) List unread emails (fast, cache-first)

```bash
mail-use email list --unread-only --limit 20 --json
```

`--limit` applies to the merged list across accounts when no `--account-id` is provided.
`accounts_info[].fetched` reflects the returned count per account (after merge).

Filter a specific date range:

```bash
mail-use email list --date-from 2026-02-02 --date-to 2026-02-03 --limit 50 --json
```

If you must confirm live state:

```bash
mail-use email list --unread-only --limit 20 --live --json
```

### 3) Read one email

```bash
mail-use email show <email_uid> --account-id <account_id> --json
```

To keep output small for OpenClaw, use preview and no HTML:

```bash
mail-use email show <email_uid> --account-id <account_id> --preview --no-html --json
```

If the preview is dominated by tracking URLs, add `--strip-urls`:

```bash
mail-use email show <email_uid> --account-id <account_id> --preview --no-html --strip-urls --json
```

### 4) Mark as read (validate first)

```bash
mail-use email mark <email_uid> --read --account-id <account_id> --folder INBOX --dry-run --json
mail-use email mark <email_uid> --read --account-id <account_id> --folder INBOX --confirm --json
```

### 5) Delete an email

```bash
mail-use email delete <email_uid> --account-id <account_id> --folder INBOX --confirm --json
```

## Sync/cache operations

```bash
mail-use sync status --json
mail-use sync force --json
mail-use sync init

# Foreground scheduler loop (Ctrl+C to stop)
mail-use sync daemon
```

## Script wrappers

The CLI implements workflows directly. Prefer calling the CLI subcommands
(`digest`, `monitor`, `inbox`, `sync`) rather than invoking repo-local scripts.

Examples:

```bash
mail-use digest run --json
mail-use monitor status --json
mail-use inbox --limit 15 --text
```
