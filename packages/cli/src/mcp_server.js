// MCP server: exposes mail-use CLI capabilities as Model Context Protocol
// tools so that AI clients (Claude Desktop, Claude Code, Cursor, etc.)
// can call them directly without shelling out to the CLI.
//
// Calls into the same `core` proxy used by the CLI, so RPC routing
// through the persistent daemon (when running) applies here too — every
// MCP tool call benefits from the pooled IMAP connections.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { contract } = require("@mail-use/shared");
const { makeProxies } = require("./core_client");
const { getCliVersion } = require("./cli_version");
const { resolveEmailRefsChecked, resolveFolderGroups, mutateByFolder, groupRefsByAccount, mutateByAccount, showRefs } = require("./cli/targets");

const { accounts, email, sync, digest, inbox, cleanup } = makeProxies();

// Common Zod fragments
const accountIdOpt = z.string().min(1).optional().describe("Account id (e.g. 'leeguooooo_gmail') or email address. Pass either this OR a gid (account_id:uid) inline with email_id.");
const folderOpt = z.string().optional().describe("IMAP folder name. Default INBOX. Use 'all' on email_search to scan every selectable folder.");
const limitOpt = z.number().int().min(1).max(1000).optional().describe("Max emails to return. Hard cap MAILBOX_MAX_LIMIT (default 1000).");
const offsetOpt = z.number().int().min(0).optional();
const dateRel = z.string().optional().describe("YYYY-MM-DD, ISO 8601, or relative shortcut: 2d, 3w, 1mo, 1y, 12h, 30m, today, yesterday, last-week, last-month.");

// Wrap a core function so its result is always returned as MCP CallToolResult.
function _toolResult(result, leanByDefault = true) {
  let payload = result;
  if (leanByDefault && payload && typeof payload === "object") {
    payload = contract.leanResult(contract.ensureSuccessField(payload));
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: payload && payload.success === false,
    structuredContent: payload,
  };
}

function buildServer() {
  const server = new McpServer({
    name: "mail-use",
    version: getCliVersion(),
  });

  // --- account ----------------------------------------------------------

  server.registerTool("account_list", {
    title: "List configured email accounts",
    description: "Returns every account known to mail-use: id, email, provider (gmail/qq/163/outlook/...), IMAP/SMTP host. Use the returned `id` as account_id in other tools.",
    inputSchema: {},
  }, async () => _toolResult(await accounts.listAccounts()));

  server.registerTool("account_test_connection", {
    title: "Test IMAP/SMTP connectivity",
    description: "Open IMAP and SMTP, return per-account success and message counts. Use to validate credentials.",
    inputSchema: {
      account_id: accountIdOpt,
    },
  }, async ({ account_id }) => _toolResult(await accounts.testConnection({ account_id: account_id || "" })));

  // --- email read -------------------------------------------------------

  server.registerTool("email_list", {
    title: "List recent emails",
    description: "List emails from one or all accounts. Reads the local SQLite cache when warm (~165ms); pass live=true to hit IMAP. Pass with_preview to also fetch a body snippet of N chars per email in the same round-trip — saves an email_show call per result. Unread is reported as three distinct fields: unread_in_result (unread among returned rows — always trustworthy), folder_unread (server count for this folder), and account_unread_total (null unless include_account_unread=true). unread_as_of marks snapshot freshness. The cache holds only the newest messages per folder: a cached page that reaches past it (thin with an earlier date_from/offset, or full with rows older than the covered date) falls back to live IMAP automatically, and cached results carry cache_complete / cache_covers_from.",
    inputSchema: {
      account_id: accountIdOpt,
      folder: folderOpt,
      limit: limitOpt,
      offset: offsetOpt,
      unread_only: z.boolean().optional(),
      date_from: dateRel,
      date_to: dateRel,
      live: z.boolean().optional().describe("Force live IMAP (skip cache)."),
      with_preview: z.number().int().min(1).max(2000).optional().describe("If set, fetch a plain-text body preview of N chars per email."),
      include_account_unread: z.boolean().optional().describe("Also compute account_unread_total (unread across all folders)."),
    },
  }, async (args) => _toolResult(await email.listEmails({
    account_id: args.account_id || "",
    folder: args.folder || "INBOX",
    limit: args.limit || 100,
    offset: args.offset || 0,
    unread_only: Boolean(args.unread_only),
    date_from: args.date_from || "",
    date_to: args.date_to || "",
    use_cache: !args.live,
    preview_chars: args.with_preview || 0,
    include_account_unread: Boolean(args.include_account_unread),
  })));

  server.registerTool("email_search", {
    title: "Search emails by from/subject/text/date",
    description: "Cross-account, cross-folder search. Pass at least one of query/from/subject/date_from/date_to/unread_only. For Gmail accounts the search uses X-GM-RAW (same engine as the web UI), and folder=all searches All Mail so archived mail is found (each hit is reported at INBOX / its label / Sent, or at All Mail when archived). For QQ/163/126/sina/outlook (broken IMAP SEARCH), automatically falls back to client-side envelope filtering. Bounded by timeout_ms (default 60s) — past it returns partial results with timed_out=true; narrow with account_id/folder for speed.",
    inputSchema: {
      query: z.string().optional().describe("Free text. Matches body+headers (Gmail X-GM-RAW; client-side fallback for broken-search providers)."),
      from: z.string().optional().describe("Substring match against sender."),
      subject: z.string().optional(),
      account_id: accountIdOpt,
      folder: folderOpt,
      date_from: dateRel,
      date_to: dateRel,
      limit: limitOpt,
      offset: offsetOpt,
      unread_only: z.boolean().optional(),
      with_preview: z.number().int().min(1).max(2000).optional(),
      timeout_ms: z.number().int().min(0).max(600000).optional().describe("Overall search deadline in ms (default 60000; 0 = no limit). Past it returns partial results + timed_out=true."),
    },
  }, async (args) => _toolResult(await email.searchEmails({
    query: args.query || "",
    from: args.from || "",
    subject: args.subject || "",
    account_id: args.account_id || "",
    folder: args.folder || "all",
    date_from: args.date_from || "",
    date_to: args.date_to || "",
    limit: args.limit || 50,
    offset: args.offset || 0,
    unread_only: Boolean(args.unread_only),
    preview_chars: args.with_preview || 0,
    timeout_ms: args.timeout_ms != null ? args.timeout_ms : 60000,
  })));

  server.registerTool("email_show", {
    title: "Read one or more emails",
    description: "Fetch the body of one or more emails over a single IMAP connection. Each id can be a bare UID + account_id, or a global gid 'account_id:folder:uid' (legacy 'account_id:uid' still works). With a 3-part gid (as returned by email_list/email_search) the folder is auto-resolved, so you don't need to pass folder. Gids from different accounts may be mixed in one call: they are fetched per account and merged in the requested order (the response then has account_ids[] instead of account_id, and each email carries account_id); don't pass account_id with gids — a conflicting one fails with account_mismatch. AI-friendly defaults: HTML excluded, body capped at 2000 chars, URLs stripped, and HTML-only mail is auto-converted to a text body (body_source='html_derived'). Pass full=true to opt back to raw HTML + uncapped body + URLs.",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("UIDs or gids."),
      account_id: accountIdOpt,
      folder: folderOpt,
      full: z.boolean().optional().describe("Return raw HTML + uncapped body + URLs (overrides AI defaults)."),
      include_html: z.boolean().optional(),
      strip_urls: z.boolean().optional(),
      body_max_len: z.number().int().min(0).max(200000).optional(),
      html_max_len: z.number().int().min(-1).max(500000).optional().describe("0 = strip HTML, -1 = unlimited, >0 = cap at N chars."),
    },
  }, async (args) => {
    // Resolve gids: 3-part account_id:folder:uid (preferred) or legacy account_id:uid.
    const r = await _resolveRefs(args.ids, args.account_id);
    if (r.error) return _refsError(r);
    const { refs, ids, accountId: resolvedAccount } = r;
    const explicitFolder = args.folder || "";
    const baseOpts = {
      account_id: resolvedAccount,
      body_max_len: args.body_max_len != null ? args.body_max_len : (args.full ? 0 : 2000),
      html_max_len: args.html_max_len != null ? args.html_max_len : (args.full ? -1 : 0),
      include_html: args.include_html != null ? args.include_html : Boolean(args.full),
      strip_urls: args.strip_urls != null ? args.strip_urls : !args.full,
    };
    if (ids.length === 1) {
      const folder = await email.resolveEmailFolder({ account_id: resolvedAccount, uid: ids[0], folder: explicitFolder || refs[0].folder });
      return _toolResult(await email.showEmail({ email_id: ids[0], folder, ...baseOpts }), false);
    }
    // Batch: gids from several accounts are fetched per account and merged in
    // the requested order (account_ids[] instead of a top-level account_id).
    return _toolResult(await showRefs(email, { refs, accountId: resolvedAccount, explicitFolder, baseOpts }), false);
  });

  server.registerTool("email_folders", {
    title: "List folders for an account",
    description: "Returns IMAP folder paths, delimiters, flags. Use the `path` value as `folder` in email_list / email_search.",
    inputSchema: { account_id: z.string().min(1) },
  }, async ({ account_id }) => _toolResult(await email.listFolders({ account_id }), false));

  // --- email mutate (dry-run by default) --------------------------------

  server.registerTool("email_mark", {
    title: "Mark emails as read or unread",
    description: "DESTRUCTIVE. Defaults to dry-run; pass confirm=true to actually flip flags.",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("UIDs or gids."),
      account_id: accountIdOpt,
      mark_as: z.enum(["read", "unread"]),
      folder: folderOpt,
      confirm: z.boolean().optional().describe("Apply changes (default false = dry-run preview)."),
    },
  }, async (args) => {
    const r = await _resolveRefs(args.ids, args.account_id);
    if (r.error) return _refsError(r);
    return _toolResult(await _mutateRefs(r, args.folder, (ids, folder, accountId) => email.markEmails({
      email_ids: ids,
      mark_as: args.mark_as,
      folder,
      account_id: accountId,
      dry_run: !args.confirm,
    })));
  });

  server.registerTool("email_delete", {
    title: "Delete emails",
    description: "DESTRUCTIVE. Defaults to dry-run; pass confirm=true to delete. By default moves to Trash; permanent=true expunges.",
    inputSchema: {
      ids: z.array(z.string()).min(1),
      account_id: accountIdOpt,
      folder: folderOpt,
      permanent: z.boolean().optional(),
      trash_folder: z.string().optional(),
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    const r = await _resolveRefs(args.ids, args.account_id);
    if (r.error) return _refsError(r);
    return _toolResult(await _mutateRefs(r, args.folder, (ids, folder, accountId) => email.deleteEmails({
      email_ids: ids,
      folder,
      permanent: Boolean(args.permanent),
      trash_folder: args.trash_folder || "Trash",
      account_id: accountId,
      dry_run: !args.confirm,
    })));
  });

  server.registerTool("email_flag", {
    title: "Flag or unflag an email",
    description: "DESTRUCTIVE. Defaults to dry-run; pass confirm=true to apply.",
    inputSchema: {
      id: z.string().describe("UID or gid (account_id:uid)."),
      account_id: accountIdOpt,
      set: z.boolean().describe("true to flag, false to unflag."),
      flag_type: z.string().optional(),
      folder: folderOpt,
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    const r = await _resolveRefs([args.id], args.account_id);
    if (r.error) return _refsError(r);
    const { accountId, refs } = r;
    if (!accountId) return _toolResult({ success: false, error: "Missing account_id (or pass gid)", error_code: "invalid_argument" });
    const folder = args.folder || (await email.resolveEmailFolder({ account_id: accountId, uid: refs[0].id, folder: refs[0].folder }));
    return _toolResult(await email.flagEmail({
      email_id: refs[0].id,
      set_flag: Boolean(args.set),
      flag_type: args.flag_type || "flagged",
      folder,
      account_id: accountId,
      dry_run: !args.confirm,
    }));
  });

  server.registerTool("email_move", {
    title: "Move emails to another folder",
    description: "DESTRUCTIVE. Defaults to dry-run; pass confirm=true to apply.",
    inputSchema: {
      ids: z.array(z.string()).min(1),
      target_folder: z.string().min(1),
      source_folder: z.string().optional(),
      account_id: accountIdOpt,
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    const r = await _resolveRefs(args.ids, args.account_id);
    if (r.error) return _refsError(r);
    // The gid's folder is the SOURCE; an explicit source_folder overrides it.
    return _toolResult(await _mutateRefs(r, args.source_folder, (ids, source, accountId) => email.moveEmails({
      email_ids: ids,
      target_folder: args.target_folder,
      source_folder: source,
      account_id: accountId,
      dry_run: !args.confirm,
    })));
  });

  server.registerTool("email_send", {
    title: "Send an email",
    description: "DESTRUCTIVE / IRREVERSIBLE. Defaults to dry-run preview; pass confirm=true to actually send.",
    inputSchema: {
      to: z.array(z.string().email()).min(1),
      subject: z.string(),
      body: z.string().describe("Plain-text body (HTML with is_html). Use real line breaks (JSON \"\\n\"); it is sent byte-for-byte, so a double-escaped \"\\\\n\" reaches the recipient as a literal backslash-n."),
      cc: z.array(z.string().email()).optional(),
      bcc: z.array(z.string().email()).optional(),
      account_id: accountIdOpt,
      is_html: z.boolean().optional(),
      confirm: z.boolean().optional(),
    },
  }, async (args) => {
    if (!args.confirm) {
      return _toolResult({
        success: true,
        dry_run: true,
        would_send: {
          to: args.to, cc: args.cc || [], bcc: args.bcc || [],
          subject: args.subject,
          account_id: args.account_id || "",
          is_html: Boolean(args.is_html),
          body_bytes: Buffer.byteLength(args.body || "", "utf8"),
          body_preview: (args.body || "").slice(0, 200),
        },
        confirmation_required: true,
        confirmation_hint: "Re-call with confirm=true to actually send",
      });
    }
    return _toolResult(await email.sendEmail({
      to: args.to,
      subject: args.subject,
      body: args.body,
      cc: args.cc,
      bcc: args.bcc,
      account_id: args.account_id || "",
      is_html: Boolean(args.is_html),
    }));
  });

  // --- sync / daemon visibility ----------------------------------------

  server.registerTool("sync_status", {
    title: "Local cache sync status",
    description: "Returns per-account sync state, last sync time, total cached emails.",
    inputSchema: {},
  }, async () => _toolResult(await sync.status()));

  server.registerTool("sync_force", {
    title: "Force a sync now",
    description: "Refresh the local SQLite cache from IMAP. Synchronous; can take 5-30s for first sync. Subsequent runs are incremental.",
    inputSchema: {
      account_id: accountIdOpt,
      full: z.boolean().optional().describe("Re-sync everything from scratch (slow)."),
    },
  }, async (args) => _toolResult(await sync.force({
    account_id: args.account_id || "",
    full: Boolean(args.full),
  })));

  // --- workflows --------------------------------------------------------

  if (typeof inbox.run === "function") {
    server.registerTool("inbox_organize", {
      title: "Auto-categorize inbox (delete spam/marketing, mark read, flag attention)",
      description: "Returns categorization buckets without acting. Reports per-bucket counts.",
      inputSchema: {
        account_id: accountIdOpt,
        folder: folderOpt,
        limit: limitOpt,
        unread_only: z.boolean().optional(),
      },
    }, async (args) => _toolResult(await inbox.run({
      account_id: args.account_id || "",
      folder: args.folder || "INBOX",
      limit: args.limit || 15,
      unread_only: Boolean(args.unread_only),
    })));
  }

  if (typeof cleanup.plan === "function") {
    server.registerTool("cleanup", {
      title: "Classify emails and plan/apply a cleanup",
      description: "Rule-based classifier into protected_finance/protected_travel/security/support_case/action_required (never deleted; action_required = subjects signalling required action, alerts, deadlines, expiry, suspension, deletion or failed payment) vs marketing/routine_notification (cleanup candidates) vs unknown. Scans only the newest `limit` emails (default 200); the plan reports scan_limit and truncated=true when the folder holds more. Returns a plan by default (read-only). DESTRUCTIVE when confirm=true: deletes the marketing/routine_notification candidates (moved to trash unless permanent=true).",
      inputSchema: {
        account_id: accountIdOpt,
        folder: folderOpt,
        limit: limitOpt,
        unread_only: z.boolean().optional(),
        confirm: z.boolean().optional().describe("Apply the plan (delete candidates). Default false = plan only."),
        permanent: z.boolean().optional().describe("Permanently delete instead of moving to trash."),
        categories: z.array(z.enum(["marketing", "routine_notification"])).optional().describe("Which candidate categories to delete on confirm. Default both."),
      },
    }, async (args) => {
      const base = {
        account_id: args.account_id || "",
        folder: args.folder || "INBOX",
        limit: args.limit || 200,
        unread_only: Boolean(args.unread_only),
      };
      if (!args.confirm) return _toolResult(await cleanup.plan(base), false);
      return _toolResult(await cleanup.apply({
        ...base,
        categories: args.categories,
        permanent: Boolean(args.permanent),
      }), false);
    });
  }

  if (typeof digest.run === "function") {
    server.registerTool("digest_run", {
      title: "Generate a daily digest",
      description: "DESTRUCTIVE if confirm=true (sends notifications to Lark/Telegram). Defaults to dry-run preview.",
      inputSchema: {
        confirm: z.boolean().optional(),
      },
    }, async (args) => _toolResult(await digest.run({ dry_run: !args.confirm, debug_path: "" })));
  }

  return server;
}

// Gid parsing / account resolution is shared with the CLI (cli/targets.js):
// gids from several accounts are grouped per account, a bare uid next to them
// fails with "ambiguous_account", and an account_id that conflicts with a
// gid's account fails with "account_mismatch" — same as the CLI.
function _resolveRefs(ids, explicitAccountId) {
  return resolveEmailRefsChecked(accounts, ids, explicitAccountId, { split: false, accountParam: "account_id" });
}

// Mutate resolved refs per account, then per folder (gid folder -> cache ->
// INBOX; an explicit folder wins). call(ids, folder, accountId).
async function _mutateRefs(r, explicitFolder, call) {
  if (!r.accountId && !r.mixed) {
    return { success: false, error: "Missing account_id (or pass gid)", error_code: "invalid_argument" };
  }
  return mutateByAccount(groupRefsByAccount(r.refs, r.accountId), async (accountId, accRefs) => mutateByFolder(
    await resolveFolderGroups(email, accRefs, accountId, explicitFolder),
    (ids, folder) => call(ids, folder, accountId),
  ));
}

function _refsError(r) {
  return _toolResult({ success: false, error: r.error, error_code: r.error_code });
}

async function startStdioServer() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // McpServer holds the loop alive via the transport.
}

module.exports = { buildServer, startStdioServer, _resolveRefs };
