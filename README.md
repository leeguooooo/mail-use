# mail-use CLI

CLI-first email management for multi-account IMAP/SMTP with a local sync cache.

Primary interface: the `mail-use` CLI (Node.js implementation). Ships prebuilt
platform binaries — no Python, no Node required for end users.

> Renamed from **Mailbox** to **mail-use**. The command is now `mail-use`; `mailbox` still
> works as an alias, and your config in `~/.config/mailbox` is untouched.

## Supported Providers

- 163 Mail (mail.163.com / mail.126.com)
- QQ Mail (mail.qq.com)
- Gmail (mail.google.com)
- Outlook/Hotmail
- Custom IMAP servers

## Install

### One line, no npm, no Node

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/mail-use/main/install.sh | sh
mail-use --help
```

Downloads the prebuilt binary for your platform (macOS arm64/x64, Linux x64) from the
[latest GitHub Release](https://github.com/leeguooooo/mail-use/releases/latest), verifies its
checksum, and installs to `~/.local/bin`. Pin a version with `MAIL_USE_VERSION=v2.11.2`, or
change the dir with `MAIL_USE_INSTALL_DIR=...`.

The installer also drops a `mailbox` symlink next to it, so scripts written against the old
name keep working.

There is no npm package. Distribution is GitHub Release binaries only — that keeps
releases free of `NPM_TOKEN` and 2FA prompts, and keeps install free of a Node toolchain.
The pre-rename `@leeguoo/mailbox-cli` packages on npm are frozen and no longer updated.

### As an AI Skill (Claude Code / Cursor / etc.)

```bash
# Project scope — installs into ./.claude/skills/mail-use (or ./.cursor/skills/...):
npx skills add leeguooooo/mail-use --skill mail-use

# User scope — installs into ~/.claude/skills/mail-use:
npx skills add leeguooooo/mail-use --skill mail-use -g
```

The skill assumes the CLI is on `PATH` (install via the `curl … install.sh | sh` above).
For the biggest speedup also run `mail-use daemon install` once.

### MCP server (Claude Desktop / Code / Cursor)

```bash
mail-use mcp config --json   # prints a paste-ready mcpServers entry
```

### From source (development)

```bash
pnpm install
pnpm test

# build a local platform binary into dist/mail-use
pnpm build:binary
```

If a test run is interrupted (editor task killed, agent session closed), its
Vitest workers can be left behind and hold memory. Check with
`pgrep -fl vitest` and kill what remains.

## Configure accounts

```bash
mkdir -p ~/.config/mailbox
cp examples/accounts.example.json ~/.config/mailbox/auth.json
```

Config locations:

- Credentials: `~/.config/mailbox/auth.json`
- Other settings: `~/.config/mailbox/config.toml`

## Common commands

```bash
# CLI help
mail-use --help

# newest verification code across all accounts, one live pass
mail-use code --json

# list accounts
mail-use account list --json

# list unread emails (cache by default; --from filters cache-side)
mail-use email list --unread-only --limit 20 --json
mail-use email list --account-id my_account_id --from "newsletter" --json

# show one email (response includes list_unsubscribe when the header is set)
mail-use email show 123456 --account-id my_account_id --json

# mark read (use --dry-run to validate first)
mail-use email mark 123456 --read --account-id my_account_id --folder INBOX --dry-run --json
mail-use email mark 123456 --read --account-id my_account_id --folder INBOX --confirm --json

# delete
mail-use email delete 123456 --account-id my_account_id --folder INBOX --confirm --json

# bulk mutate by sender or subject (no UID list needed)
mail-use email mark --from "support@npmjs.com" --read --confirm --account-id my_account_id --json
mail-use email delete --from "newsletter" --account-id my_account_id --json    # dry-run preview
mail-use email delete --subject "[ad]" --account-id my_account_id --confirm --json
```

### Cache + sync

- Cache DB default: `~/.local/share/mailbox/email_sync.db`
- Listing uses cache by default where possible. Add `--live` to force IMAP.

```bash
mail-use sync status --json
mail-use sync force --json
mail-use sync init
mail-use sync daemon
```

## AI usage guide

If you're integrating this CLI into an AI agent, start here:

- `docs/AI_SKILL_MAIL_USE.md`

## OpenClaw integration

This repo includes an OpenClaw skill at `skills/mail-use/SKILL.md`.

OpenClaw loads skills from:
- `<workspace>/skills`
- `~/.openclaw/skills`

Quick link helper (symlink into `~/.openclaw/skills`):

```bash
./scripts/link_openclaw_skill.sh
```

Force replace an existing link:

```bash
./scripts/link_openclaw_skill.sh --force
```

To use this repo without copying files, add the repo skills directory to
`skills.load.extraDirs` in `~/.openclaw/openclaw.json`:

```json
{
  "skills": {
    "load": {
      "extraDirs": [
        "/path/to/mcp-email-service/skills"
      ]
    }
  }
}
```

OpenClaw handles channel delivery and scheduling; mail-use returns structured
JSON outputs and optional text summaries.

Verify OpenClaw picked up the skill:

```bash
openclaw skills list --eligible
openclaw skills check
```

## The `*-use` family

Small, composable CLIs that give an AI agent hands on one real thing. Same shape
everywhere: `curl … install.sh | sh` to install, `npx skills add leeguooooo/<name>`
to teach your agent, JSON on stdout.

| Repo | Gives your agent |
|---|---|
| [chrome-use](https://github.com/leeguooooo/chrome-use) | A real browser — logged-in sessions, forms, scraping, screenshots |
| [mail-use](https://github.com/leeguooooo/mail-use) | Email — read, search, send, triage across Gmail / QQ / 163 / any IMAP |
| [iphone-use](https://github.com/leeguooooo/iphone-use) | A real iPhone — tap, type, screenshot, pull on-device data |
| [wechat-use](https://github.com/leeguooooo/wechat-use) | WeChat on macOS — send messages, query contacts and history |
| [discord-use](https://github.com/leeguooooo/discord-use) | Discord — messages, channels, forums, webhooks (REST-only, Rust) |
| [cookie-use](https://github.com/leeguooooo/cookie-use) | Many logged-in accounts per site — capture, switch, apply sessions |
| [profile-use](https://github.com/leeguooooo/profile-use) | Your personal profile, safely — fill signup / KYC / checkout forms |
| [bitwarden-use](https://github.com/leeguooooo/bitwarden-use) | Bitwarden / Vaultwarden — headless passkey (FIDO2) login |
| [chatgpt-use](https://github.com/leeguooooo/chatgpt-use) | Your ChatGPT subscription as a coding-agent backend — no API key |
| [computer-use](https://github.com/leeguooooo/computer-use) | The macOS desktop itself |
| [pixcake-use](https://github.com/leeguooooo/pixcake-use) | Read-only PixCake probing — snapshot / diff / SQLite inspection |

## Contract

- `docs/CLI_JSON_CONTRACT.md`
---

> Built by **leeguooooo** — field notes on AI agents, reverse engineering & Cloudflare Workers at **[blog.misonote.com](https://blog.misonote.com)** · follow on **[X @leeguooooo](https://x.com/leeguooooo)**
