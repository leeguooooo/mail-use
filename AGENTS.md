# Repository Guidelines

## Project Structure & Module Organization
- `packages/` hosts the Node implementation:
  - `packages/cli/` CLI entry + command definitions
  - `packages/core/` IMAP/SMTP + storage + account migration
  - `packages/shared/` path resolution + JSON contract helpers
  - `packages/workflows/` digest/monitor/inbox workflows
- `scripts/` contains build helpers (notably `scripts/build_binary.js`).
- `docs/` holds CLI contract + release docs; legacy Python/MCP docs remain under `docs/archive/`.

## Build, Test, and Development Commands
- Install dependencies: `pnpm install`
- Run tests: `pnpm test`
- Lint: `pnpm lint` (`pnpm lint:fix` to autofix). CI runs it before the tests.
- Build local pkg binary into `dist/mail-use`: `pnpm build:binary`
- Run dev CLI: `pnpm -C packages/cli test` or `node packages/cli/bin/mail-use.js --help`

## Coding Style & Naming Conventions
- Node.js (JavaScript). Keep modules small and side-effect-light.
- Prefer explicit error objects in JSON output (`success`, `error`).
- Avoid breaking JSON contract; add fields in a forward-compatible way.

## Testing Guidelines
- Contract tests live under `packages/cli/test/` (vitest). Use `MAILBOX_TEST_MODE=1` to avoid live IMAP/SMTP.
- Prefer schema validation (`docs/cli_json_schemas/*`) to lock minimum stable JSON shapes.

## Commit & Pull Request Guidelines
- Follow the Conventional Commit style seen in history (`feat:`, `fix:`, `refactor:`); keep subjects ≤72 chars.
- Include a brief body noting user-facing changes, risks, and docs updated.
- PRs should describe context and testing performed (`pnpm test`, `pnpm build:binary`).
- Link issues or TODOs and request reviewers for affected areas (operations, services, scripts).

## Security & Configuration Tips
- Never commit secrets; keep `data/` contents (accounts, DBs, logs, attachments) local and gitignored.
- Use environment variables or `.env` for provider credentials; prefer config templates in `config_templates/` and examples in `examples/`.
- When debugging, scrub email addresses and tokens from shared logs.
