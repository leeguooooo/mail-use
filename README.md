# mail-use

**Email, as something an AI agent can actually operate.** One CLI over Gmail, QQ,
163, Outlook and any IMAP/SMTP box — every command speaks JSON, every destructive
one is dry-run until you pass `--confirm`.

```bash
mail-use code --json          # the newest verification code, one live pass
mail-use email recent --format compact --json
mail-use email delete --from newsletter@shop.com --confirm --json
```

Part of the [`*-use` family](#the--use-family) — small tools that each give an agent
hands on one real thing.

### Why this and not an IMAP snippet

- **A stable JSON contract, not scraped text.** Every response carries
  `success: boolean`, and failures carry `error_code` from a fixed set
  (`auth_failed`, `folder_not_found`, `imap_error`, …). Documented in
  [`docs/CLI_JSON_CONTRACT.md`](docs/CLI_JSON_CONTRACT.md).
- **It tells you when it might be wrong.** Cached reads report `from_cache`,
  `cache_age_seconds` and `cache_stale`, and a snapshot old enough to mean "nothing
  is syncing" is refused in favour of a live fetch. An empty inbox is never a silent
  "nothing arrived".
- **Destructive by consent only.** `delete` / `mark` / `move` / `send` return a
  dry-run preview — grouped per account and folder, with sample subjects — and change
  nothing until `--confirm`. `--all-folders` skips Sent/Drafts/Junk/Trash unless asked.
- **Built for token budgets.** `--format compact` projects each email to the ten
  fields worth scanning (~30% smaller than the full shape), `--with-preview` folds a
  body snippet into the list call, and batch `show` reuses one IMAP connection.
- **Fast enough to call in a loop.** A persistent daemon pools IMAP connections and
  syncs to local SQLite in the background: five sequential `email list` calls go from
  25s to 0.83s. See [the table below](#persistent-daemon-5-30-faster-cli-calls).
- **MCP too.** `mail-use mcp config --json` prints a paste-ready entry; the server
  exposes 16 tools with the same dry-run defaults.

> Renamed from **Mailbox** to **mail-use**. The command is now `mail-use`; `mailbox` still
> works as an alias, and your config in `~/.config/mailbox` is untouched.

## Supported providers

163 / 126 · QQ · Gmail · Outlook / Hotmail · any custom IMAP+SMTP server.

Search behaves differently per provider and the CLI says so: Gmail searches bodies
server-side via `X-GM-RAW`, while QQ/163/Outlook have broken IMAP TEXT search, so
`--query` falls back to matching subject + sender only. Use `--from` / `--subject`
there for predictable results.

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

### Upgrading

```bash
mail-use upgrade --check     # is there a newer release?
mail-use upgrade             # download, verify sha256, replace in place, restart the daemon
mail-use upgrade --tag v3.1.0   # pin an exact release (also the way to roll back)
```

`upgrade` is never automatic and never runs on its own: a tool that silently replaces
its own executable is a supply-chain surprise, not a convenience. It refuses to install
a tarball whose published `.sha256` doesn't match, and refuses to run at all from a dev
checkout (where `process.execPath` is your `node`). Re-running the `curl … install.sh | sh`
line does the same job.

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

## Persistent daemon (5-30× faster CLI calls)

Each one-shot invocation otherwise spends 1-3s on TCP+TLS+IMAP LOGIN. With the daemon
running, calls reuse pooled connections and a background SQLite sync means `email list`
usually doesn't touch IMAP at all.

The `curl … install.sh | sh` installer sets this up for you when accounts are already
configured (`MAIL_USE_NO_DAEMON=1` opts out). Otherwise:

```bash
mail-use daemon install      # autostart at login (macOS launchd / Linux systemd-user)
mail-use daemon status --json
mail-use daemon reload       # drop pooled connections after editing auth.json
```

Measured on Gmail INBOX, M2 MacBook over residential WAN:

| Operation | No daemon | Daemon (`--live`) | Daemon (cached) |
|---|---|---|---|
| Single `email list` | 5.0s | 1.0s | 0.17s |
| `email folders` | 5.0s | 0.85s | n/a |
| 5 sequential `email list` | 25s | 5.3s | **0.83s** |
| 3 parallel `email show` | ~15s | 2.7s | **0.88s** |

### Resource footprint (many agent sessions on one machine)

The daemon is **one process per user**, shared by every agent session through a Unix
socket — so more sessions do not mean more IMAP connections. Measured idle on macOS
with 3 accounts connected:

| | |
|---|---|
| Idle CPU | ~0.15% |
| Idle RSS | 3-15 MB |
| Connections | max 3 per account (`MAILBOX_POOL_MAX`), reaped back to 1 after 10 min idle |
| 12 concurrent calls | 1.6s wall clock, pool stayed at 1 connection per account |

Knobs, if the defaults do not suit you:

| Env | Default | Effect |
|---|---|---|
| `MAILBOX_POOL_MAX` | `3` | Max concurrent IMAP connections per account |
| `MAILBOX_POOL_IDLE_MS` | `600000` | Close connections idle this long (`0` disables reaping) |
| `MAILBOX_POOL_KEEP_WARM` | `1` | Connections per account kept warm through reaping |
| `MAILBOX_NO_DAEMON` | unset | `1` makes the CLI skip the daemon entirely |

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
