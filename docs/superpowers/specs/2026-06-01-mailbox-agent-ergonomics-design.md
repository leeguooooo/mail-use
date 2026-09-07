# mail-use CLI — agent-ergonomics pass

**Date:** 2026-06-01
**Branch:** `feat/agent-ergonomics`
**Status:** approved (maintainer: "全做" + "0 = strip HTML"; remaining sub-decisions delegated)

## Motivation

Maintainer feedback after a real agent session. An investigation workflow (5 parallel
code-readers + adversarial verification) validated each of 10 reported issues against the
actual source. Outcome: ~1/3 already ship (`--no-html`, batch `show`, filtered
`delete`/`mark`, cross-account `list`, relative dates via `--date-from`); the rest are
*surprising semantics*, *wrong MCP defaults*, *discoverability*, and a few genuine bugs.

Every fix below is grounded in a verified `file:line` finding.

## Conventions

- Tests: `packages/<pkg>/node_modules/.bin/vitest run --root packages/<pkg>` (the `pnpm test`
  wrapper trips on an esbuild build-approval prompt; the per-package binary works).
- JSON-schema contracts in `docs/cli_json_schemas/*` are `additionalProperties: true`, so new
  output fields do **not** break contract tests. New required-field guarantees should still be
  added to the schemas for documentation.
- TDD per work package: failing test → implement → green → commit. Mock harness:
  `core/src/testing/mock_store.js` + `mock_imap_client.js`, enabled by
  `MAILBOX_INTERNAL_TEST_MODE=1`.

## Work packages

### WP-A — HTML/body semantics + html→text fallback
Files: `core/src/services/email.js`, `cli/src/main.js`, `cli/src/mcp_server.js`

1. **`html_max_len` semantics** (was: `0` = unlimited, the source of the complaint):
   - `< 0` (sentinel `-1`) → unlimited (no truncation)
   - `=== 0` → strip (`html_body: ""`, `html_truncated: false`)
   - `> 0` → cap at N chars
   Applies in `showEmail`, `showEmails`, and the test-mode branch. `include_html === false`
   still empties HTML regardless (unchanged).
   - CLI `show`: `--full` now yields `html_max_len = -1` (keeps full HTML); bare
     `--html-max-len 0` strips; default stays "no html" via `include_html=false`.
   - MCP `email_show`: when `full:true`, pass `html_max_len:-1`.
2. **`--text-only`** alias on `show` = sugar for `--no-html`. Update `--html-max-len` help:
   "0 = strip HTML, -1 = unlimited; or use --no-html".
3. **html→text fallback**: `_htmlToText(html)` — strips `<script>/<style>`, converts block
   tags to newlines, decodes common entities, collapses whitespace (no new dependency). In
   `showEmail`/`showEmails`, when `body` is empty but HTML exists, derive `body` from HTML.
   New field `body_source: "text" | "html_derived" | "empty"`. Default ON (so HTML-only mail
   like Moomoo always returns a usable body even with HTML suppressed).

Acceptance: `show --html-max-len 0` → `html_body===""`; `show --full` → full HTML;
HTML-only message → non-empty `body` + `body_source==="html_derived"`.

### WP-F — Attachment signature/inline flags
Files: `core/src/services/email.js` (4 mapping sites), `core/src/storage/sync_db.js`

`_attachmentFlags(a)` → `{ is_signature, is_inline, is_real_attachment }`.
- `is_signature`: `content_type` ∈ {`application/pkcs7-signature`, `application/x-pkcs7-signature`}
  (case-insensitive) or `filename === "smime.p7s"`.
- `is_inline`: `Boolean(a.related)` or `contentDisposition === "inline"`.
- `is_real_attachment`: `!is_signature && !is_inline`.
Spread into showEmail (live+test), listEmails-with-details, downloadAttachments (live+test).
`has_attachments` / `attachment_count` summaries count `is_real_attachment` only (keep raw
`attachments[]` complete). Optionally persist `is_inline` into the existing unused DB column.

Acceptance: an `smime.p7s` part → `is_signature:true`, `is_real_attachment:false`, and does
not flip `has_attachments`.

### WP-D — Folder-aware show + 3-part gid
Files: `core/src/services/email.js`, `core/src/storage/sync_db.js`, `cli/src/main.js`,
`cli/src/mcp_server.js`

- `lookupFolderForUid({ accountId, uid })` reads `emails JOIN folders` from the cache.
- `show`/`showEmails`: when no explicit `--folder`, resolve each uid's real folder from the
  cache; group ids by resolved folder; open each folder once on the shared connection. Fall
  back to INBOX when uncached. `--folder` remains an explicit override.
- gid extended to self-describing `account_id:folder:uid`; `_parseEmailRef` accepts both
  2-part (`account:uid`) and 3-part. `list`/`search` emit 3-part gids.

Acceptance: ids returned by `search --folder all` can be passed to `show` with no `--folder`
and resolve to the correct mail-use.

### WP-B — Unread stats fields
Files: `core/src/services/email.js`, `core/src/storage/sync_db.js`, `core/src/services/sync.js`,
`cli/src/main.js`, `cli/src/mcp_server.js`

Replace the single overloaded `unread_count` with clearly-named fields on list/search output:
- `unread_in_result` — unread among returned `emails[]` (free: `emails.filter(unread).length`).
- `folder_unread` — server STATUS UNSEEN for the queried folder (live path already computes
  `unseenCount`; cache path uses snapshot stamped with `unread_as_of`).
- `account_unread_total` — unread across all selectable folders; **opt-in** via
  `--account-unread` / `include_account_unread` (enumerate folders, one cheap STATUS each).
  Default `null`.
- `unread_as_of` (folders.last_sync) + `from_cache`.
- Keep `unread_count` as a back-compat alias of `folder_unread`.

Latent bugs fixed regardless: (1) cache cross-account `SUM(unread_count)` drops NULL rows →
`COALESCE`; (2) cache aggregation force-coerces the requested folder to INBOX → honor the
requested folder.

Acceptance: a fetch containing unread rows never reports `unread_in_result: 0`; the three
fields are independently sourced and labeled.

### WP-C — `--format compact` / `--format jsonl`
Files: `shared/src/json.js`, `shared/src/contract.js`, `cli/src/main.js`

- `--format json|jsonl|compact` (`agent` = alias of `compact`), threaded through
  `parseGlobalFlags`/`handleJsonOrText`. Presentation-only; core outputs unchanged.
- `printJsonl(records)` in `shared/json.js`: one `JSON.stringify(record)+"\n"` per email
  (iterates `result.emails`; for `show`, one line per email).
- `compactProjection(email)` → exactly
  `{ id, account_id, folder, date, from, subject, unread, has_attachments, body_text_preview }`.
  `body_text_preview` from `preview` (list/search) or truncated `body` (show);
  `has_attachments` from `is_real_attachment` (WP-F). Composable with `jsonl`.

Acceptance: `list --format compact` emits only the 9 fields per email; `--format jsonl`
emits one parseable JSON object per line.

### WP-H — `--since` alias + MCP date shortcut fix
Files: `cli/src/main.js`, `cli/src/mcp_server.js`, `core/src/services/email.js`

- `--since` alias of `--date-from` on `list`/`search` (relative `7d`/`24h` already parsed via
  `_expandDateShortcut`).
- Centralize `_expandDateShortcut` into core `_parseDateInput` so the MCP `dateRel` shortcut
  bug (advertised in schema, never expanded → `2d` parses to NaN and is silently dropped) is
  fixed on both CLI and MCP paths.
- Unparseable date → explicit `warnings[]` entry instead of silent drop.

Acceptance: `list --since 7d` and MCP `email_list({dateRel:"2d"})` both filter correctly.

### WP-I — `recent` command + discoverability
Files: `cli/src/main.js`, `cli/src/mcp_server.js`

- `email recent [--limit N] [--since ...]` — thin alias calling `listEmails(account_id="")`
  (all accounts, merged newest-first).
- `--account-id` help → "omit to span ALL accounts, merged by date".
- `list --folder all` (or any non-INBOX) → stderr note: "list is INBOX-only; use
  `email search --folder all` for cross-folder" (instead of silent INBOX collapse).

### WP-E — Delete/mark grouped preview + multi-folder
Files: `cli/src/main.js`, `core/src/services/email.js`

- `_filteredDryRunResult` adds a `groups` breakdown:
  `[{ account_id, folder, count, sample: [top-3 subjects] }]`, shown before confirm; per-group
  counts also in the applied summary.
- `--all-folders` on `delete`/`mark` (the variadic `--folder <name...>` form was dropped as
  YAGNI); targets keyed by `account_id + folder`; mutate per `(account, folder)`. Keep the
  >100-match `--confirm` guard. **Safety (added post-review):** `--all-folders` skips
  special-use folders (Sent/Drafts/Junk/Trash) unless `--include-special`; skipped folders are
  surfaced in the dry-run/applied output.

### WP-G — Categorizer + cleanup plan
Files: `workflows/src/workflows/classify.js` (new), `workflows/src/workflows/inbox.js`,
`cli/src/main.js`, `cli/src/mcp_server.js`

- `classify(meta)` → one of `protected_finance | protected_travel | security |
  support_case | marketing | routine_notification | unknown`. Rule-based, priority order:
  1. protected buckets (sender-domain allowlist + subject keywords: invoice/receipt/statement;
     boarding/itinerary/PNR; verification code/OTP; ticket#/case#) — short-circuit so they are
     never cleanup candidates.
  2. `marketing` — has `list_unsubscribe` (reuse `_extractListUnsubscribe`) or bulk precedence.
  3. `routine_notification` — `no-reply@` sender + notification keywords.
  4. else `unknown`.
  Sender allowlists in a config file (`config_templates/`) with shipped defaults.
- `mail-use cleanup --dry-run` → `{ candidates_by_category, protected: {counts}, plan_only:true }`,
  never deletes. `--confirm` pipes `marketing`/`routine_notification` into `deleteEmails`,
  reusing the WP-E group→confirm machinery. MCP `cleanup` tool (dry-run default).

## Build order & rationale

A → F → D → B → C → H → I → E → G. A/F/D/B establish the per-email/output fields that C
(presentation) and G (cleanup uses classify + WP-E machinery) build on. WPs share `main.js`
and `email.js` heavily, so they are sequenced (not parallel-edited) to avoid conflicts. Each
WP is committed independently with its tests.

## Post-review hardening

An adversarial multi-agent review of the branch caught real bugs from extending the gid to
3 parts: the MCP `_resolveRefs` and all mutate handlers (mark/delete/flag/move), plus the CLI
mark/delete id-paths, are now folder-aware (group by the gid's folder; explicit `--folder`
still overrides). `showEmailsResolved` degrades a single unopenable folder to `failed_ids`
instead of aborting the batch; `lookupFolderForUid` prefers INBOX on a cross-folder uid
collision; `--format jsonl` emits 0 lines for an empty list. See commit `fix(review): ...`.

## Out of scope (this pass)

- Persisting per-folder unread during sync for a zero-round-trip `account_unread_total`
  (v1 uses opt-in live STATUS).
- LLM-based classification (v1 is rule-based).
- Text-renderer (`printText`) output for `show` (still `not implemented`; JSON/JSONL/compact only).
