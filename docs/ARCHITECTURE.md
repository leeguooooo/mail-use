# Architecture

mail-use is a CLI-first Node.js project.

Core goals:

- Keep a stable JSON output contract for automation/skills.
- Store config and data using XDG defaults with env overrides.
- Support both interactive use and scripted `--json` usage.

Modules:

- `packages/shared`: flag parsing, JSON printing, XDG paths.
- `packages/core`: IMAP/SMTP operations, sqlite cache, account loading/migration.
- `packages/workflows`: digest/monitor/inbox orchestration.
- `packages/cli`: CLI command surface.

Distribution:

- The user-facing install is `mail-use` (npm launcher + platform packages).
- The platform packages ship a prebuilt `mail-use` binary (built from Node via
  `pkg`).
