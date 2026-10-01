# Scripts

This directory contains build helpers for the Node CLI rewrite.

Key scripts:

- `scripts/build_binary.js`: builds the `mail-use` single executable (esbuild bundle
  injected into the running node via Node SEA) at `dist/mail-use`, which CI attaches to the
  GitHub Release. `--skip-install` / `--skip-tests` skip the `pnpm install` / `pnpm test` preamble.
- `scripts/unsubscribe.mjs`: bulk unsubscribe helper. Reads `account_id<TAB>from_substring`
  lines from stdin or a file, extracts each sender's `List-Unsubscribe` header,
  sends mailto unsubscribes via SMTP and opens https one-click links in your
  browser. Pass `--dry-run` to preview without acting.

Legacy:

- Older Python workflow scripts and HTTP API helpers have been removed. If you
  need historical context, see `docs/archive/`.
