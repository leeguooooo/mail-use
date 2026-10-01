// email list / recent / search / show / mark / delete / send / reply / forward /
// folders / attachments / flag / move / watch

const { contract } = require("@mail-use/shared");
const { _out, _printEmailList, _printFolderList } = require("../cli/render");
const {
  _validatePaging, _validateDateOpt, _readBodyFile, _collectOption, _resolveLocalAttachments,
  _attachmentPreview, _mailAttachments, _explicitOptionValue,
} = require("../cli/options");
const targets = require("../cli/targets");

// --extract-code: scan subject+body for verification/OTP codes and stamp a
// `codes:[...]` field onto a show result (single or batch). Mutates in place
// and returns the result. Saves an agent the show → eyeball-regex round-trip.
function _attachExtractedCodes(result) {
  if (!result || typeof result !== "object") return result;
  const codesFor = (e) => contract.extractCodes(`${e.subject || ""}\n${e.body || ""}`);
  if (Array.isArray(result.emails)) {
    for (const e of result.emails) {
      if (e && typeof e === "object") e.codes = codesFor(e);
    }
  } else {
    result.codes = codesFor(result);
  }
  return result;
}

// Default-dry-run mutations: when the dry run came from a missing --confirm
// (not an explicit --dry-run), say how to apply it.
function _markConfirmationRequired(result, opts, dryRun, hint = targets.CONFIRM_HINT) {
  if (dryRun && !opts.dryRun && result && typeof result === "object") {
    result.confirmation_required = true;
    result.confirmation_hint = hint;
  }
}

// --body / --body-file / --attachment for send and reply. Exits on bad usage.
function _readComposeInput(ctx, opts) {
  const hasBody = typeof opts.body === "string" && opts.body.length;
  const hasBodyFile = Boolean(opts.bodyFile);
  if ((hasBody && hasBodyFile) || (!hasBody && !hasBodyFile)) {
    ctx.usage("Specify exactly one of --body/--body-file");
  }

  let body = opts.body || "";
  if (opts.bodyFile) {
    try {
      body = _readBodyFile(opts.bodyFile);
    } catch (e) {
      ctx.usage(e && e.message ? e.message : "Failed to read body file");
    }
  }
  let attachments;
  try {
    attachments = _resolveLocalAttachments(opts.attachment);
  } catch (e) {
    ctx.usage(e && e.message ? e.message : "Failed to read attachment");
  }
  return { body, attachments };
}

// --date-from / --date-to validation + relative-shortcut expansion.
function _expandDateRange(ctx, opts) {
  let dateFromExpanded = opts.dateFrom || "";
  let dateToExpanded = opts.dateTo || "";
  for (const [name, valGet, set] of [["--date-from", () => opts.dateFrom, (v) => (dateFromExpanded = v)], ["--date-to", () => opts.dateTo, (v) => (dateToExpanded = v)]]) {
    const v = _validateDateOpt(name, valGet());
    if (!v.ok) ctx.usage(v.error);
    if (v.expanded) set(v.expanded);
  }
  return { dateFromExpanded, dateToExpanded };
}

// Shared body of `email mark` and `email delete`: filter mode (--from/--subject)
// or explicit ids.
async function _mutate(ctx, { operation, label, ids, opts, markAs }) {
  const { email } = ctx.proxies;
  if (opts.from || opts.subject) {
    const searched = await targets.searchFilteredEmailTargets(email, opts);
    if (!searched.result || !searched.result.success) {
      return ctx.respond(searched.result, label);
    }
    if (searched.targets.length > 100 && !opts.confirm) {
      return ctx.usage(`Matched ${searched.targets.length} emails. Add --confirm to proceed.`);
    }
    const result = await targets.applyFilteredEmailMutation(email, {
      operation,
      opts,
      targets: searched.targets,
      groups: searched.groups,
      ...(operation === "mark" ? { markAs } : {}),
      skipped: searched.skipped_special_folders,
    });
    return ctx.respond(result, label);
  }

  const refs = targets.resolveEmailRefs(targets.emailIdArgs(ids), opts.accountId);
  if (refs.error) {
    return ctx.usage(refs.error);
  }
  const dryRun = Boolean(opts.dryRun) || !opts.confirm;
  const result = await targets.applyIdRefMutation(email, {
    operation,
    refs: refs.refs,
    accountId: refs.accountId,
    defaultFolder: opts.folder,
    ...(operation === "mark" ? { markAs } : {}),
    opts,
    dryRun,
  });
  _markConfirmationRequired(result, opts, dryRun);
  return ctx.respond(result, label);
}

function register(program, ctx) {
  const { email } = ctx.proxies;
  const emailCmd = program.command("email").description("Email operations");
  emailCmd
    .command("list")
    .description("List emails")
    .option("--limit <n>", "Limit", "100")
    .option("--offset <n>", "Offset", "0")
    .option("--unread-only", "Only unread")
    .option("--account-id <id>", "Account id/email (omit to span ALL accounts, merged by date)")
    .option("--from <addr>", "Filter by sender (substring, cache-side)")
    .option("--date-from <s>", "Filter from date (YYYY-MM-DD, ISO, or relative 7d/24h/today)")
    .option("--since <s>", "Alias of --date-from (e.g. --since 7d, --since today)")
    .option("--date-to <s>", "Filter to date (YYYY-MM-DD or ISO)")
    .option("--folder <name>", "Folder (currently only INBOX is supported here; use 'email search' for cross-folder)", "INBOX")
    .option("--with-preview <n>", "Also fetch a body preview of N chars per email (one extra IMAP fetch, capped at 50 emails)")
    .option("--account-unread", "Also compute account_unread_total (unread across all folders; one STATUS per folder on live)")
    .option("--live", "Force live IMAP (no cache)")
    .action(async (opts) => {
      if (opts.since && !opts.dateFrom) opts.dateFrom = opts.since; // --since is sugar for --date-from
      // 'email list' is INBOX-only by design; warn instead of silently collapsing
      // a cross-folder request so the user knows to reach for 'email search'.
      if (opts.folder && String(opts.folder).toLowerCase() !== "inbox") {
        process.stderr.write(
          `mail-use: 'email list' is INBOX-only; folder "${opts.folder}" was treated as INBOX. ` +
            `Use 'email search --folder ${opts.folder}' for cross-folder.\n`
        );
      }
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 100 });
      if (!paging.ok) ctx.usage(paging.error);
      const { dateFromExpanded, dateToExpanded } = _expandDateRange(ctx, opts);
      const previewChars = opts.withPreview != null ? Math.max(0, Math.min(2000, Number(opts.withPreview) || 0)) : 0;
      const result = await email.listEmails({
        limit: paging.limit,
        offset: paging.offset,
        unread_only: Boolean(opts.unreadOnly),
        folder: opts.folder,
        account_id: opts.accountId || "",
        from: opts.from || "",
        date_from: dateFromExpanded,
        date_to: dateToExpanded,
        use_cache: !opts.live,
        preview_chars: previewChars,
        include_account_unread: Boolean(opts.accountUnread),
      });
      // Add contract parity fields.
      result.limit = paging.limit;
      result.offset = paging.offset;
      result.unread_only = Boolean(opts.unreadOnly);
      result.folder = opts.folder;
      result.use_cache = !opts.live;
      if (opts.dateFrom) result.date_from = opts.dateFrom;
      if (opts.dateTo) result.date_to = opts.dateTo;
      if (opts.accountId) result.account_id = opts.accountId;
      if (opts.from) result.from = opts.from;

      ctx.respond(result, _printEmailList);
    });

  emailCmd
    .command("recent")
    .description("Recent INBOX emails across ALL accounts, merged newest-first (alias of 'email list' with no --account-id)")
    .option("--limit <n>", "Limit", "50")
    .option("--since <s>", "Only emails since (e.g. 7d, today, YYYY-MM-DD)")
    .option("--account-id <id>", "Restrict to one account (default: all accounts)")
    .option("--account-unread", "Also compute account_unread_total (unread across all folders)")
    .option("--live", "Force live IMAP (no cache)")
    .action(async (opts) => {
      const paging = _validatePaging(opts.limit, "0", { defaultLimit: 50 });
      if (!paging.ok) ctx.usage(paging.error);
      let sinceExpanded = "";
      if (opts.since) {
        const v = _validateDateOpt("--since", opts.since);
        if (!v.ok) ctx.usage(v.error);
        sinceExpanded = v.expanded || opts.since;
      }
      const result = await email.listEmails({
        limit: paging.limit,
        offset: 0,
        folder: "INBOX",
        account_id: opts.accountId || "",
        date_from: sinceExpanded,
        use_cache: !opts.live,
        include_account_unread: Boolean(opts.accountUnread),
      });
      result.command = "recent";
      result.limit = paging.limit;
      if (opts.since) result.since = opts.since;
      if (opts.accountId) result.account_id = opts.accountId;
      ctx.respond(result, _printEmailList);
    });

  emailCmd
    .command("search")
    .description("Search emails")
    .option("--query <q>", "Free-text query (IMAP TEXT, matches body+headers)")
    .option("--from <s>", "Filter by sender (IMAP FROM, substring match)")
    .option("--subject <s>", "Filter by subject (IMAP SUBJECT, substring match)")
    .option("--account-id <id>")
    .option("--date-from <s>", "Filter from date (YYYY-MM-DD, ISO, or relative 7d/24h/today)")
    .option("--since <s>", "Alias of --date-from (e.g. --since 7d)")
    .option("--date-to <s>")
    .option("--limit <n>", "Limit", "50")
    .option("--offset <n>", "Offset", "0")
    .option("--unread-only")
    .option("--folder <name>", "Folder", "all")
    .option("--with-preview <n>", "Also fetch a body preview of N chars per email (one extra IMAP fetch, capped at 50 emails)")
    .option("--timeout <s>", "Overall search deadline in seconds; returns partial results + timed_out=true past it (0 = no limit)", "60")
    .action(async (opts) => {
      if (opts.since && !opts.dateFrom) opts.dateFrom = opts.since; // --since is sugar for --date-from
      if (!opts.query && !opts.from && !opts.subject && !opts.dateFrom && !opts.dateTo && !opts.unreadOnly) {
        ctx.usage("Provide at least one of --query, --from, --subject, --date-from, --date-to, --unread-only");
      }
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 50 });
      if (!paging.ok) ctx.usage(paging.error);
      const { dateFromExpanded, dateToExpanded } = _expandDateRange(ctx, opts);
      const previewChars = opts.withPreview != null ? Math.max(0, Math.min(2000, Number(opts.withPreview) || 0)) : 0;
      const result = await email.searchEmails({
        query: opts.query || "",
        from: opts.from || "",
        subject: opts.subject || "",
        account_id: opts.accountId || "",
        date_from: dateFromExpanded,
        date_to: dateToExpanded,
        limit: paging.limit,
        offset: paging.offset,
        unread_only: Boolean(opts.unreadOnly),
        folder: opts.folder,
        preview_chars: previewChars,
        timeout_ms: Math.max(0, Number(opts.timeout || 0)) * 1000,
      });
      ctx.respond(result, _printEmailList);
    });

  emailCmd
    .command("show")
    .description("Show one or more emails (AI-friendly defaults: text only, body capped, URLs stripped — pass --full for raw)")
    .argument("<email_ids...>")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder (default: auto-resolve from the gid/cache, else INBOX)")
    .option("--full", "Return full HTML + uncapped body + URLs (overrides AI-friendly defaults)")
    .option("--preview", "Return a very short body preview (400 chars body, 2000 chars HTML)")
    .option("--body-max-len <n>", "Max body length (characters)")
    .option("--html-max-len <n>", "Max HTML length: 0 = strip HTML, -1 = unlimited, >0 = cap")
    .option("--no-html", "Exclude HTML body")
    .option("--text-only", "Text body only (alias for --no-html)")
    .option("--include-html", "Include HTML body (overrides AI default)")
    .option("--strip-urls", "Remove URLs from body text")
    .option("--keep-urls", "Keep URLs in body text (overrides AI default)")
    .option("--extract-code", "Also scan subject+body for verification/OTP codes and return them as codes:[...]")
    .action(async (emailIds, opts) => {
      const bodyMaxRaw = opts.bodyMaxLen != null ? Number(opts.bodyMaxLen) : null;
      const htmlMaxRaw = opts.htmlMaxLen != null ? Number(opts.htmlMaxLen) : null;
      // AI-friendly defaults: text only, body ~ 2000 chars, URLs stripped.
      // --full opts back to "give me everything" for human / debug use.
      // html_max_len: 0 = strip, -1 = unlimited, >0 = cap (do not clamp negatives).
      let bodyMax = Number.isFinite(bodyMaxRaw) ? Math.max(0, bodyMaxRaw) : (opts.full ? 0 : 2000);
      let htmlMax = Number.isFinite(htmlMaxRaw) ? htmlMaxRaw : (opts.full ? -1 : 0);
      let includeHtml = opts.full ? true : Boolean(opts.includeHtml);
      if (opts.html === false || opts.textOnly) includeHtml = false; // --no-html / --text-only win
      let stripUrls = opts.full ? false : !opts.keepUrls;
      if (opts.stripUrls) stripUrls = true;
      if (opts.preview) {
        bodyMax = 400;
        if (!htmlMax && includeHtml) htmlMax = 2000;
      }
      const refs = targets.resolveEmailRefs(emailIds, opts.accountId);
      if (refs.error) ctx.usage(refs.error);
      const ids = refs.ids;
      const explicitFolder = opts.folder; // undefined unless the user passed --folder
      const baseOpts = {
        account_id: refs.accountId,
        body_max_len: bodyMax,
        html_max_len: htmlMax,
        include_html: includeHtml,
        strip_urls: stripUrls,
      };
      if (ids.length === 1) {
        // Resolve folder: explicit --folder > gid folder > cache > INBOX.
        const folderHint = explicitFolder || (refs.refs[0] && refs.refs[0].folder) || "";
        const folder = await email.resolveEmailFolder({ account_id: refs.accountId, uid: ids[0], folder: folderHint });
        const result = await email.showEmail({ email_id: ids[0], folder, ...baseOpts });
        if (opts.extractCode) _attachExtractedCodes(result);
        ctx.respond(result, "email show");
      }
      // Batch: an explicit --folder applies to all; otherwise resolve each id's
      // folder from its gid/cache so results that span folders just work.
      const result = explicitFolder
        ? await email.showEmails({ email_ids: ids, folder: explicitFolder, ...baseOpts })
        : await email.showEmailsResolved({ refs: refs.refs, ...baseOpts });
      if (opts.extractCode) _attachExtractedCodes(result);
      ctx.respond(result, "email show");
    });

  emailCmd
    .command("mark")
    .description("Mark emails read/unread")
    .argument("[email_ids...]")
    .option("--read", "Mark as read")
    .option("--unread", "Mark as unread")
    .option("--mark-as <state>", "Mark as read/unread")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--all-folders", "With --from/--subject: target matches across ALL folders (grouped per folder)")
    .option("--include-special", "With --all-folders: also target Sent/Drafts/Junk/Trash (off by default for safety)")
    .option("--from <addr>", "Filter by sender substring (IMAP server-side search)")
    .option("--subject <s>", "Filter by subject substring (IMAP server-side search)")
    .option("--unread-only", "Only target unread emails (combine with --from/--subject)")
    .option("--confirm", "Apply changes; required when >100 filter matches")
    .option("--dry-run")
    .action(async (ids, opts) => {
      const read = Boolean(opts.read);
      const unread = Boolean(opts.unread);
      const markAsOption = opts.markAs ? String(opts.markAs).toLowerCase() : "";
      const requestedStates = [
        read ? "read" : "",
        unread ? "unread" : "",
        markAsOption,
      ].filter(Boolean);
      if (requestedStates.length !== 1 || (markAsOption && markAsOption !== "read" && markAsOption !== "unread")) {
        return ctx.usage("Specify exactly one of --read/--unread");
      }
      if (!targets.hasEmailTargets(ids, opts)) {
        return ctx.usage("Must provide email_ids, --from, or --subject");
      }
      return _mutate(ctx, { operation: "mark", label: "email mark", ids, opts, markAs: requestedStates[0] });
    });

  emailCmd
    .command("delete")
    .description("Delete emails")
    .argument("[email_ids...]")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--all-folders", "With --from/--subject: target matches across ALL folders (grouped per folder)")
    .option("--include-special", "With --all-folders: also target Sent/Drafts/Junk/Trash (off by default for safety)")
    .option("--from <addr>", "Filter by sender substring (IMAP server-side search)")
    .option("--subject <s>", "Filter by subject substring (IMAP server-side search)")
    .option("--unread-only", "Only target unread emails (combine with --from/--subject)")
    .option("--permanent")
    .option("--trash-folder <name>", "Trash folder", "Trash")
    .option("--confirm", "Apply changes; required when >100 filter matches")
    .option("--dry-run")
    .action(async (ids, opts) => {
      if (!targets.hasEmailTargets(ids, opts)) {
        return ctx.usage("Must provide email_ids, --from, or --subject");
      }
      return _mutate(ctx, { operation: "delete", label: "email delete", ids, opts });
    });

  emailCmd
    .command("send")
    .description("Send an email")
    .requiredOption("--to <to...>")
    .requiredOption("--subject <s>")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--cc <cc...>")
    .option("--bcc <bcc...>")
    .option("--attachment <path>", "Attach a local file; repeat for multiple files", _collectOption, [])
    .option("--account-id <id>")
    .option("--is-html")
    .option("--confirm", "Actually send (default: dry-run)")
    .option("--dry-run")
    .action(async (opts) => {
      const { body, attachments } = _readComposeInput(ctx, opts);
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      if (dryRun) {
        const result = {
          success: true,
          dry_run: true,
          would_send: {
            to: opts.to,
            cc: opts.cc || [],
            bcc: opts.bcc || [],
            subject: opts.subject,
            account_id: opts.accountId || "",
            is_html: Boolean(opts.isHtml),
            body_bytes: Buffer.byteLength(body, "utf8"),
            body_preview: body.slice(0, 200),
            attachment_count: attachments.length,
            attachments: _attachmentPreview(attachments),
          },
          confirmation_required: true,
          confirmation_hint: "Re-run with --confirm to actually send",
        };
        ctx.respond(result, "email send");
      }
      const result = await email.sendEmail({
        to: opts.to,
        subject: opts.subject,
        body,
        cc: opts.cc,
        bcc: opts.bcc,
        account_id: opts.accountId || "",
        is_html: Boolean(opts.isHtml),
        attachments: _mailAttachments(attachments),
      });
      ctx.respond(result, "email send");
    });

  emailCmd
    .command("reply")
    .description("Reply to an email")
    .argument("<email_id>")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--reply-all")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--attachment <path>", "Attach a local file; repeat for multiple files", _collectOption, [])
    .option("--account-id <id>")
    .option("--is-html")
    .option("--confirm", "Actually send (default: dry-run)")
    .option("--dry-run")
    .action(async (emailId, opts, cmd) => {
      const { body, attachments } = _readComposeInput(ctx, opts);
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const ref = targets.parseEmailRef(emailId);
      const explicitFolder = _explicitOptionValue(cmd, opts, "folder");
      const result = await email.replyEmail({
        email_id: ref.id,
        body,
        reply_all: Boolean(opts.replyAll),
        folder: explicitFolder || ref.folder || opts.folder,
        account_id: opts.accountId || ref.account_id || "",
        is_html: Boolean(opts.isHtml),
        attachments: _mailAttachments(attachments),
        dry_run: dryRun,
      });
      ctx.respond(result, "email reply");
    });

  emailCmd
    .command("forward")
    .description("Forward an email")
    .argument("<email_id>")
    .requiredOption("--to <to...>")
    .option("--body <text>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--no-attachments")
    .option("--account-id <id>")
    .option("--confirm", "Actually send (default: dry-run)")
    .option("--dry-run")
    .action(async (emailId, opts, cmd) => {
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const ref = targets.parseEmailRef(emailId);
      const explicitFolder = _explicitOptionValue(cmd, opts, "folder");
      const result = await email.forwardEmail({
        email_id: ref.id,
        to: opts.to,
        body: opts.body || "",
        folder: explicitFolder || ref.folder || opts.folder,
        no_attachments: Boolean(opts.noAttachments),
        account_id: opts.accountId || ref.account_id || "",
        dry_run: dryRun,
      });
      ctx.respond(result, "email forward");
    });

  emailCmd
    .command("folders")
    .description("List folders")
    .requiredOption("--account-id <id>")
    .action(async (opts) => {
      const result = await email.listFolders({ account_id: opts.accountId });
      ctx.respond(result, _printFolderList);
    });

  emailCmd
    .command("attachments")
    .description("Download attachments")
    .argument("<email_id>", "UID or gid (account_id:uid)")
    .option("--account-id <id>", "Required if email_id is a bare UID")
    .option("--folder <name>", "Folder", "INBOX")
    .action(async (emailId, opts) => {
      const refs = targets.resolveEmailRefs([emailId], opts.accountId);
      if (refs.error || !refs.accountId) {
        ctx.usage(refs.error || "Missing --account-id (or pass a gid like account_id:uid)");
      }
      const result = await email.downloadAttachments({ email_id: refs.ids[0], folder: opts.folder, account_id: refs.accountId });
      ctx.respond(result, "email attachments");
    });

  emailCmd
    .command("flag")
    .description("Flag/unflag an email")
    .argument("<email_id>", "UID or gid (account_id:uid)")
    .option("--account-id <id>", "Required if email_id is a bare UID")
    .option("--set")
    .option("--unset")
    .option("--flag-type <t>", "Flag type", "flagged")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--confirm", "Apply changes (default: dry-run)")
    .option("--dry-run")
    .action(async (emailId, opts) => {
      const set = Boolean(opts.set);
      const unset = Boolean(opts.unset);
      if ((set && unset) || (!set && !unset)) {
        ctx.usage("Specify exactly one of --set/--unset");
      }
      const refs = targets.resolveEmailRefs([emailId], opts.accountId);
      if (refs.error || !refs.accountId) {
        ctx.usage(refs.error || "Missing --account-id (or pass a gid like account_id:uid)");
      }

      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await email.flagEmail({
        email_id: refs.ids[0],
        set_flag: set,
        flag_type: opts.flagType,
        folder: opts.folder,
        account_id: refs.accountId,
        dry_run: dryRun,
      });
      _markConfirmationRequired(result, opts, dryRun);
      ctx.respond(result, "email flag");
    });

  emailCmd
    .command("move")
    .description("Move emails to folder")
    .argument("<email_ids...>", "UIDs or gids (account_id:uid)")
    .requiredOption("--target-folder <name>")
    .option("--source-folder <name>", "Source folder", "INBOX")
    .option("--account-id <id>", "Required if email_ids are bare UIDs")
    .option("--confirm", "Apply changes (default: dry-run)")
    .option("--dry-run")
    .action(async (ids, opts) => {
      const refs = targets.resolveEmailRefs(ids, opts.accountId);
      if (refs.error || !refs.accountId) {
        ctx.usage(refs.error || "Missing --account-id (or pass gids like account_id:uid)");
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await email.moveEmails({
        email_ids: refs.ids,
        target_folder: opts.targetFolder,
        source_folder: opts.sourceFolder,
        account_id: refs.accountId,
        dry_run: dryRun,
      });
      _markConfirmationRequired(result, opts, dryRun);
      ctx.respond(result, "email move");
    });

  emailCmd
    .command("watch")
    .description("Stream new emails as they arrive (IMAP IDLE). Prints one NDJSON line per match; runs until SIGINT.")
    .argument("[folder]", "Folder to watch", "INBOX")
    .requiredOption("--account-id <id>")
    .option("--filter-from <s>", "Only emit emails whose sender includes this substring")
    .option("--filter-subject <s>", "Only emit emails whose subject includes this substring")
    .action(async (folder, opts) => {
      const onEvent = (evt) => {
        _out(JSON.stringify(evt) + "\n");
      };
      const result = await email.watchFolder({
        account_id: opts.accountId,
        folder: folder || "INBOX",
        filter: { from: opts.filterFrom || "", subject: opts.filterSubject || "" },
        onEvent,
      });
      if (!result || !result.success) {
        ctx.respond(result, () => process.stderr.write((result && result.error) || "watch failed\n"));
      }
      process.stderr.write(`watching ${result.folder} on ${result.account_id} (Ctrl-C to stop)\n`);
      const stop = async () => {
        try { await result.stop(); } catch { /* ignore */ }
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await result.done;
      process.exit(0);
    });
}

module.exports = { register };
