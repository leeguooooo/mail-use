const { Command } = require("commander");

const { contract } = require("@mail-use/shared");
const { getCliVersion: _resolveCliVersion } = require("./cli_version");
const proxies = require("./proxies");
// imap/smtp stay on the object: they are lazy getters, and destructuring them
// here would load all of core on every invocation.
const { accounts, email, sync, digest, monitor, inbox, cleanup } = proxies;
const {
  _out, _printTextNotImplemented, _displayWidth, _padRight, _truncate, _printRows,
  _printAccountList, _printEmailList, _printFolderList,
} = require("./cli/render");
const {
  _validatePaging, _expandDateShortcut, _isoDate, _validateDateOpt, _readBodyFile,
  _collectOption, _resolveLocalAttachments, _attachmentPreview, _mailAttachments,
  _explicitOptionValue,
} = require("./cli/options");
const { _commandToJson, _findCommandPath } = require("./cli/help_json");

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

const targets = require("./cli/targets");

const _parseEmailRef = targets.parseEmailRef;
const _resolveEmailRefs = (rawIds, explicitAccountId) => targets.resolveEmailRefs(rawIds, explicitAccountId);
const _emailIdArgs = targets.emailIdArgs;
const _hasEmailTargets = targets.hasEmailTargets;
const _searchFilteredEmailTargets = (opts) => targets.searchFilteredEmailTargets(email, opts);
const _applyFilteredEmailMutation = (args) => targets.applyFilteredEmailMutation(email, args);
const _applyIdRefMutation = (args) => targets.applyIdRefMutation(email, args);

// Cooperative shutdown for foreground daemons. SIGINT/SIGTERM flips the flag
// and resolves any in-flight wait so the loop can finish its current pass
// (e.g. mid-flush sqlite write) before exiting.
function _createStopSignal() {
  const state = { stopped: false, wakers: new Set() };
  const trigger = () => {
    state.stopped = true;
    for (const w of state.wakers) {
      try { w(); } catch { /* ignore */ }
    }
    state.wakers.clear();
  };
  process.once("SIGINT", trigger);
  process.once("SIGTERM", trigger);
  return {
    stopped: () => state.stopped,
    sleep(ms) {
      if (state.stopped) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          state.wakers.delete(resolve);
          resolve();
        }, ms);
        const wake = () => { clearTimeout(t); resolve(); };
        state.wakers.add(wake);
      });
    },
  };
}

// Send an admin RPC (__ping/__reload/__shutdown) directly to the daemon
// socket without going through the makeProxies fallback path — these
// methods only make sense when a daemon is actually listening.
function _daemonAdmin(fnName) {
  return require("./daemon_admin").daemonAdmin(fnName);
}

// At most once a day, one stderr line when a newer release exists (see
// update_notice.js). Never lets a failure reach the command it rides along with.
async function _dailyUpdateNotice(argv) {
  // A dev checkout reports package.json's placeholder version, which every
  // release is "newer" than. Only a stamped binary (or an explicit version
  // override) has something real to compare.
  const stamped = require("./packaged").isPackagedBinary() || Boolean(process.env.MAILBOX_CLI_VERSION || process.env.MAILBOX_VERSION);
  if (!stamped) return;
  try {
    await require("./update_notice").maybeNotify({ argv, currentVersion: _resolveCliVersion() });
  } catch {
    // ignore
  }
}

async function main(argv) {
  const parsed = contract.parseGlobalFlags(argv);
  let asJson = parsed.asJson;
  // --json typed by the caller, as opposed to JSON implied by a piped stdout.
  const explicitJson = parsed.asJson;
  const pretty = parsed.pretty;
  const forceText = parsed.forceText;
  const lean = parsed.lean;
  const format = parsed.format;
  // Default to JSON when stdout is piped (so scripts get parseable output);
  // --text overrides this for users who want the human-readable form even
  // when piping to less/grep.
  if (forceText) asJson = false;
  else if (!asJson && !process.stdout.isTTY) asJson = true;
  // Monkeypatch: every action calls contract.handleJsonOrText with its own
  // {result, asJson, pretty, printText} bag. Wrap the function so we don't
  // have to thread `lean` / `format` through every callsite — when set, they
  // slim/reshape the result before printing.
  const originalHandle = contract.handleJsonOrText;
  if (lean || format) {
    contract.handleJsonOrText = (args) =>
      originalHandle({ ...args, ...(lean ? { lean: true } : {}), ...(format ? { format } : {}) });
  }

  const program = new Command();
  program.name("mail-use");
  program.version(_resolveCliVersion(), "-v, --version", "output the version");
  program.exitOverride();
  // Suppress commander's default "error: ..." stderr line — we surface the
  // same message via the JSON contract (or via invalidUsage on stderr) and
  // don't want the message to appear twice (once raw, once wrapped in JSON).
  program.configureOutput({
    writeErr: () => {},
  });

  const accountCmd = program.command("account").description("Account operations");
  accountCmd
    .command("list")
    .description("List configured accounts")
    .action(async () => {
      const result = await accounts.listAccounts();
      const rc = contract.handleJsonOrText({
        result,
        asJson,
        pretty,
        printText: _printAccountList,
      });
      process.exit(rc);
    });

  accountCmd
    .command("test-connection")
    .description("Test IMAP/SMTP connectivity")
    .option("--account-id <id>", "Specific account id/email")
    .action(async (opts) => {
      let result;

      try {
        const accId = String(opts.accountId || "").trim();
        let targets = [];

        if (accId) {
          const one = await accounts.getAccountByIdOrEmail(accId);
          if (!one.success) {
            result = { success: false, error: one.error || `Account not found: ${accId}`, accounts: [], total_accounts: 0 };
          } else {
            targets = [one.account];
          }
        } else {
          const all = await accounts.getAllAccountsResolved();
          if (!all.success) {
            result = all;
          } else {
            targets = all.accounts || [];
            if (!targets.length) {
              result = { success: false, error: "No accounts configured", accounts: [], total_accounts: 0 };
            }
          }
        }

        if (!result) {
          const out = [];
          for (const a of targets) {
            const item = {
              email: a.email,
              provider: a.provider,
              success: false,
              imap: { success: false },
              smtp: { success: false },
            };

            try {
              const im = await proxies.imap.testConnection(a, "INBOX");
              item.imap = { success: Boolean(im && im.success), total_emails: im.total_emails || 0, unread_emails: im.unread_emails || 0 };
              if (im && im.error) item.imap.error = im.error;
            } catch (e) {
              item.imap = { success: false, error: e && e.message ? e.message : "IMAP failed" };
            }

            try {
              const sm = await proxies.smtp.testConnection(a);
              item.smtp = { success: Boolean(sm && sm.success) };
              if (sm && sm.error) item.smtp.error = sm.error;
            } catch (e) {
              item.smtp = { success: false, error: e && e.message ? e.message : "SMTP failed" };
            }

            item.success = Boolean(item.imap && item.imap.success) && Boolean(item.smtp && item.smtp.success);
            out.push(item);
          }

          result = { success: out.length > 0 && out.every((x) => x.success), accounts: out, total_accounts: out.length };
        }
      } catch (e) {
        result = { success: false, error: e && e.message ? e.message : "test failed" };
      }

      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("account test-connection") });
      process.exit(rc);
    });

  // email
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
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        process.exit(rc);
      }
      let dateFromExpanded = opts.dateFrom || "";
      let dateToExpanded = opts.dateTo || "";
      for (const [name, valGet, set] of [["--date-from", () => opts.dateFrom, (v) => (dateFromExpanded = v)], ["--date-to", () => opts.dateTo, (v) => (dateToExpanded = v)]]) {
        const v = _validateDateOpt(name, valGet());
        if (!v.ok) {
          const rc = contract.invalidUsage({ message: v.error, asJson, pretty });
          process.exit(rc);
        }
        if (v.expanded) set(v.expanded);
      }
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

      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: _printEmailList });
      process.exit(rc);
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
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        process.exit(rc);
      }
      let sinceExpanded = "";
      if (opts.since) {
        const v = _validateDateOpt("--since", opts.since);
        if (!v.ok) {
          const rc = contract.invalidUsage({ message: v.error, asJson, pretty });
          process.exit(rc);
        }
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
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: _printEmailList });
      process.exit(rc);
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
        const rc = contract.invalidUsage({
          message: "Provide at least one of --query, --from, --subject, --date-from, --date-to, --unread-only",
          asJson,
          pretty,
        });
        process.exit(rc);
      }
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 50 });
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        process.exit(rc);
      }
      let dateFromExpanded = opts.dateFrom || "";
      let dateToExpanded = opts.dateTo || "";
      for (const [name, valGet, set] of [["--date-from", () => opts.dateFrom, (v) => (dateFromExpanded = v)], ["--date-to", () => opts.dateTo, (v) => (dateToExpanded = v)]]) {
        const v = _validateDateOpt(name, valGet());
        if (!v.ok) {
          const rc = contract.invalidUsage({ message: v.error, asJson, pretty });
          process.exit(rc);
        }
        if (v.expanded) set(v.expanded);
      }
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
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: _printEmailList });
      process.exit(rc);
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
      const refs = _resolveEmailRefs(emailIds, opts.accountId);
      if (refs.error) {
        const rc = contract.invalidUsage({ message: refs.error, asJson, pretty });
        process.exit(rc);
      }
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
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email show") });
        process.exit(rc);
      }
      // Batch: an explicit --folder applies to all; otherwise resolve each id's
      // folder from its gid/cache so results that span folders just work.
      const result = explicitFolder
        ? await email.showEmails({ email_ids: ids, folder: explicitFolder, ...baseOpts })
        : await email.showEmailsResolved({ refs: refs.refs, ...baseOpts });
      if (opts.extractCode) _attachExtractedCodes(result);
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email show") });
      process.exit(rc);
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
        const rc = contract.invalidUsage({ message: "Specify exactly one of --read/--unread", asJson, pretty });
        return process.exit(rc);
      }
      if (!_hasEmailTargets(ids, opts)) {
        const rc = contract.invalidUsage({ message: "Must provide email_ids, --from, or --subject", asJson, pretty });
        return process.exit(rc);
      }

      const mark_as = requestedStates[0];
      if (opts.from || opts.subject) {
        const searched = await _searchFilteredEmailTargets(opts);
        if (!searched.result || !searched.result.success) {
          const rc = contract.handleJsonOrText({ result: searched.result, asJson, pretty, printText: () => _printTextNotImplemented("email mark") });
          return process.exit(rc);
        }
        if (searched.targets.length > 100 && !opts.confirm) {
          const rc = contract.invalidUsage({ message: `Matched ${searched.targets.length} emails. Add --confirm to proceed.`, asJson, pretty });
          return process.exit(rc);
        }
        const result = await _applyFilteredEmailMutation({
          operation: "mark",
          opts,
          targets: searched.targets,
          groups: searched.groups,
          markAs: mark_as,
          skipped: searched.skipped_special_folders,
        });
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email mark") });
        return process.exit(rc);
      }

      const refs = _resolveEmailRefs(_emailIdArgs(ids), opts.accountId);
      if (refs.error) {
        const rc = contract.invalidUsage({ message: refs.error, asJson, pretty });
        return process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await _applyIdRefMutation({
        operation: "mark",
        refs: refs.refs,
        accountId: refs.accountId,
        defaultFolder: opts.folder,
        markAs: mark_as,
        opts,
        dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email mark") });
      return process.exit(rc);
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
      if (!_hasEmailTargets(ids, opts)) {
        const rc = contract.invalidUsage({ message: "Must provide email_ids, --from, or --subject", asJson, pretty });
        return process.exit(rc);
      }

      if (opts.from || opts.subject) {
        const searched = await _searchFilteredEmailTargets(opts);
        if (!searched.result || !searched.result.success) {
          const rc = contract.handleJsonOrText({ result: searched.result, asJson, pretty, printText: () => _printTextNotImplemented("email delete") });
          return process.exit(rc);
        }
        if (searched.targets.length > 100 && !opts.confirm) {
          const rc = contract.invalidUsage({ message: `Matched ${searched.targets.length} emails. Add --confirm to proceed.`, asJson, pretty });
          return process.exit(rc);
        }
        const result = await _applyFilteredEmailMutation({
          operation: "delete",
          opts,
          targets: searched.targets,
          groups: searched.groups,
          skipped: searched.skipped_special_folders,
        });
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email delete") });
        return process.exit(rc);
      }

      const refs = _resolveEmailRefs(_emailIdArgs(ids), opts.accountId);
      if (refs.error) {
        const rc = contract.invalidUsage({ message: refs.error, asJson, pretty });
        return process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await _applyIdRefMutation({
        operation: "delete",
        refs: refs.refs,
        accountId: refs.accountId,
        defaultFolder: opts.folder,
        opts,
        dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email delete") });
      return process.exit(rc);
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
      const hasBody = typeof opts.body === "string" && opts.body.length;
      const hasBodyFile = Boolean(opts.bodyFile);
      if ((hasBody && hasBodyFile) || (!hasBody && !hasBodyFile)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --body/--body-file", asJson, pretty });
        process.exit(rc);
      }

      let body = opts.body || "";
      if (opts.bodyFile) {
        try {
          body = _readBodyFile(opts.bodyFile);
        } catch (e) {
          const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read body file", asJson, pretty });
          process.exit(rc);
        }
      }
      let attachments;
      try {
        attachments = _resolveLocalAttachments(opts.attachment);
      } catch (e) {
        const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read attachment", asJson, pretty });
        process.exit(rc);
      }
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
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email send") });
        process.exit(rc);
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
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email send") });
      process.exit(rc);
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
      const hasBody = typeof opts.body === "string" && opts.body.length;
      const hasBodyFile = Boolean(opts.bodyFile);
      if ((hasBody && hasBodyFile) || (!hasBody && !hasBodyFile)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --body/--body-file", asJson, pretty });
        process.exit(rc);
      }

      let body = opts.body || "";
      if (opts.bodyFile) {
        try {
          body = _readBodyFile(opts.bodyFile);
        } catch (e) {
          const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read body file", asJson, pretty });
          process.exit(rc);
        }
      }
      let attachments;
      try {
        attachments = _resolveLocalAttachments(opts.attachment);
      } catch (e) {
        const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read attachment", asJson, pretty });
        process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const ref = _parseEmailRef(emailId);
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
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email reply") });
      process.exit(rc);
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
      const ref = _parseEmailRef(emailId);
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
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email forward") });
      process.exit(rc);
    });

  emailCmd
    .command("folders")
    .description("List folders")
    .requiredOption("--account-id <id>")
    .action(async (opts) => {
      const result = await email.listFolders({ account_id: opts.accountId });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: _printFolderList });
      process.exit(rc);
    });

  emailCmd
    .command("attachments")
    .description("Download attachments")
    .argument("<email_id>", "UID or gid (account_id:uid)")
    .option("--account-id <id>", "Required if email_id is a bare UID")
    .option("--folder <name>", "Folder", "INBOX")
    .action(async (emailId, opts) => {
      const refs = _resolveEmailRefs([emailId], opts.accountId);
      if (refs.error || !refs.accountId) {
        const rc = contract.invalidUsage({ message: refs.error || "Missing --account-id (or pass a gid like account_id:uid)", asJson, pretty });
        process.exit(rc);
      }
      const result = await email.downloadAttachments({ email_id: refs.ids[0], folder: opts.folder, account_id: refs.accountId });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email attachments") });
      process.exit(rc);
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
        const rc = contract.invalidUsage({ message: "Specify exactly one of --set/--unset", asJson, pretty });
        process.exit(rc);
      }
      const refs = _resolveEmailRefs([emailId], opts.accountId);
      if (refs.error || !refs.accountId) {
        const rc = contract.invalidUsage({ message: refs.error || "Missing --account-id (or pass a gid like account_id:uid)", asJson, pretty });
        process.exit(rc);
      }

      const setFlag = set;
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await email.flagEmail({
        email_id: refs.ids[0],
        set_flag: setFlag,
        flag_type: opts.flagType,
        folder: opts.folder,
        account_id: refs.accountId,
        dry_run: dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email flag") });
      process.exit(rc);
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
      const refs = _resolveEmailRefs(ids, opts.accountId);
      if (refs.error || !refs.accountId) {
        const rc = contract.invalidUsage({ message: refs.error || "Missing --account-id (or pass gids like account_id:uid)", asJson, pretty });
        process.exit(rc);
      }
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await email.moveEmails({
        email_ids: refs.ids,
        target_folder: opts.targetFolder,
        source_folder: opts.sourceFolder,
        account_id: refs.accountId,
        dry_run: dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email move") });
      process.exit(rc);
    });

  // sync
  const syncCmd = program.command("sync").description("Local sync/cache operations");
  syncCmd
    .command("status")
    .description("Show scheduler status")
    .action(async () => {
      const result = await sync.status();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync status") });
      process.exit(rc);
    });
  syncCmd
    .command("force")
    .description("Force sync now")
    .option("--account-id <id>")
    .option("--full")
    .action(async (opts) => {
      const result = await sync.force({ account_id: opts.accountId || "", full: Boolean(opts.full) });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync force") });
      process.exit(rc);
    });
  syncCmd
    .command("init")
    .description("Initialize database and run initial sync")
    .action(async () => {
      const result = await sync.init();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync init") });
      process.exit(rc);
    });
  syncCmd
    .command("health")
    .description("Show sync health summary")
    .action(async () => {
      const result = await sync.health();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync health") });
      process.exit(rc);
    });

  syncCmd
    .command("watch")
    .description("Continuously print sync status")
    .option("--interval <seconds>", "Refresh interval", "5")
    .action(async (opts) => {
      const { printJson } = require("@mail-use/shared").json;
      const intervalSec = Math.max(0.5, Number(opts.interval || 5));
      const stop = _createStopSignal();
      try {
        while (!stop.stopped()) {
          const status = await sync.status();
          status.success = true;
          printJson(status, Boolean(pretty) || !asJson);
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch (e) {
        if (e && e.name === "AbortError") return process.exit(0);
        return process.exit(0);
      }
    });

  syncCmd
    .command("daemon")
    .description("Run periodic sync in the foreground")
    .option("--interval <seconds>", "Sync interval", "300")
    .option("--account-id <id>")
    .option("--full")
    .action(async (opts) => {
      const intervalSec = Math.max(5, Number(opts.interval || 300));
      const stop = _createStopSignal();
      try {
        while (!stop.stopped()) {
          await sync.force({ account_id: opts.accountId || "", full: Boolean(opts.full) });
          if (stop.stopped()) break;
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch {
        return process.exit(0);
      }
    });

  // code — the single most common reason an agent opens a mailbox at all:
  // "what's the verification code that just arrived?". Doing that with the
  // general commands costs two IMAP round-trips (list, then show the one that
  // looks right) plus a guess about which email it is. This does it in one
  // pass: live list with a body preview, extract codes from subject+preview,
  // return the newest hit. Always live — a cached OTP is a wrong OTP.
  program
    .command("code")
    .description("Newest verification/OTP code across accounts, in one live pass (the 'what's my code' shortcut)")
    .option("--since <s>", "How far back to look", "30m")
    .option("--account-id <id>", "Restrict to one account (default: all accounts)")
    .option("--limit <n>", "How many recent emails to scan", "20")
    .option("--all", "Return every email that yielded a code, not just the newest")
    .option("--preview-chars <n>", "Body chars to scan per email", "1000")
    .action(async (opts) => {
      const paging = _validatePaging(opts.limit, "0", { defaultLimit: 20 });
      if (!paging.ok) process.exit(contract.invalidUsage({ message: paging.error, asJson, pretty }));
      const v = _validateDateOpt("--since", opts.since);
      if (!v.ok) process.exit(contract.invalidUsage({ message: v.error, asJson, pretty }));

      const previewChars = Math.max(200, Math.min(2000, Number(opts.previewChars) || 1000));
      const listed = await email.listEmails({
        limit: paging.limit,
        offset: 0,
        folder: "INBOX",
        account_id: opts.accountId || "",
        date_from: v.expanded || opts.since,
        use_cache: false, // never answer an OTP question from a snapshot
        preview_chars: previewChars,
      });
      if (!listed || listed.success === false) {
        const rc = contract.handleJsonOrText({ result: listed, asJson, pretty, printText: () => {} });
        process.exit(rc);
      }

      const hits = [];
      for (const e of listed.emails || []) {
        // pickVerificationCode (not extractCodes) — the question here is "is this
        // a verification email at all", and extractCodes answers a different one.
        const pick = contract.pickVerificationCode(`${e.subject || ""}\n${e.preview || ""}`);
        if (pick) {
          hits.push({
            code: pick.code,
            confidence: pick.confidence,
            other_candidates: pick.others,
            gid: e.gid,
            account_id: e.account_id,
            folder: e.folder,
            date: e.date,
            from: e.from,
            subject: e.subject,
            unread: e.unread,
          });
        }
      }
      // listEmails returns newest-first, so hits already are.
      const result = {
        success: true,
        command: "code",
        since: opts.since,
        scanned: (listed.emails || []).length,
        matched: hits.length,
        // `code` is the answer; `candidates` is the evidence behind it.
        code: hits.length ? hits[0].code : null,
        ...(hits.length ? { newest: hits[0] } : {}),
        candidates: opts.all ? hits : hits.slice(0, 3),
        ...(hits.length
          ? {}
          : { hint: `no code found in the last ${opts.since}; widen with --since 2h, or raise --limit` }),
      };
      const rc = contract.handleJsonOrText({
        result,
        asJson,
        pretty,
        printText: () => {
          if (!hits.length) { _out(`no code in the last ${opts.since}\n`); return; }
          const h = hits[0];
          _out(`${h.code}\n  from ${h.from} — ${h.subject}\n  ${h.date}  ${h.gid}\n`);
        },
      });
      process.exit(rc);
    });

  // upgrade — the *-use family convention (plugins docs/upgrade.md):
  //   upgrade           install the latest release (release-binary installs only)
  //   upgrade --skills  also refresh mail-use's own skill copies (opt-in)
  //   upgrade --check   change nothing; `mail-use X -> Y` / `mail-use X is up to date`
  //   upgrade --json    same as --check, as JSON (name/current/latest/update_available/skills/install_channel)
  //   upgrade --tag v…  install (or --check) this exact release
  // Exit 0 on success (including "update available"), 2 when the check, the
  // download or the verification failed, 1 when refused because another
  // package manager owns this install.
  program
    .command("upgrade")
    .description("Upgrade the CLI from GitHub Releases (sha256-verified, atomic); --skills also refreshes the mail-use skill; --check / --json only report")
    .option("--check", "Only report whether a newer version exists; change nothing")
    .option("--skills", "Also refresh mail-use's own skill copies (Claude Code plugin, git checkout); without it they are only listed")
    .option("--tag <vX.Y.Z>", "Install this exact release instead of the latest (also allows downgrade)")
    .option("--insecure", "Install even if the release publishes no checksum (not recommended)")
    .action(async (opts) => {
      const upgrade = require("./upgrade");
      const skillRefresh = require("./skill_refresh");
      const current = _resolveCliVersion();
      const failed = (msg, code = 2, extra = {}) => {
        contract.handleJsonOrText({
          result: { success: false, name: upgrade.NAME, error: msg, error_code: contract.inferErrorCode(msg), ...extra },
          asJson,
          pretty,
          printText: () => process.stderr.write(`upgrade ${code === 1 ? "refused" : "failed"}: ${msg}\n`),
        });
        process.exit(code);
      };
      const skillLines = (list) => list.map((s) => skillRefresh.formatSkillLine(s) + "\n").join("");
      // The tag is spliced into download URLs; reject anything but vX.Y.Z
      // before it reaches a request (also for --check).
      if (opts.tag) {
        if (!upgrade.isValidTag(opts.tag)) return failed(`Invalid --tag "${opts.tag}" (expected vX.Y.Z)`);
        opts.tag = upgrade.normalizeTag(opts.tag);
      }
      try {
        const channel = upgrade.detectInstallChannel();
        // An explicit --json means "check, as JSON" (the family contract). JSON
        // that only comes from stdout being a pipe does not, so a scripted
        // `mail-use upgrade | cat` still upgrades.
        if (opts.check || (explicitJson && !opts.skills && !opts.tag)) {
          const fetchLatest = opts.tag
            ? async () => ({ tag: opts.tag, url: `https://github.com/leeguooooo/mail-use/releases/tag/${opts.tag}`, published_at: "" })
            : undefined;
          const result = await upgrade.checkForUpdate(current, fetchLatest ? { fetchLatest } : {});
          result.skills = skillRefresh.detectSkills();
          result.install_channel = channel;
          contract.handleJsonOrText({
            result,
            asJson,
            pretty,
            printText: () => {
              _out(
                result.update_available
                  ? `mail-use ${result.current} -> ${result.latest}\n  run: ${channel.upgradable ? "mail-use upgrade" : channel.hint}\n`
                  : `mail-use ${result.current} is up to date\n`
              );
              _out(skillLines(result.skills));
            },
          });
          process.exit(0);
        }
        const result = await upgrade.performUpgrade({
          currentVersion: current,
          targetTag: opts.tag || "",
          insecure: Boolean(opts.insecure),
          log: (m) => { if (!asJson) process.stderr.write(`mail-use upgrade: ${m}\n`); },
        });
        if (!result.success) {
          return failed(result.error || "upgrade failed", result.refused ? 1 : 2, result.install_channel ? { install_channel: result.install_channel } : {});
        }
        result.name = upgrade.NAME;
        // Skills are only touched on request: a CLI upgrade must not rewrite
        // skill folders the user may have customised. Without --skills they
        // are listed with the command that would refresh them.
        const found = skillRefresh.detectSkills();
        result.skills = opts.skills ? skillRefresh.refreshSkills(found) : found.map((s) => ({ ...s, status: "skipped" }));
        const skillFailed = result.skills.some((s) => s.status === "failed");
        contract.handleJsonOrText({
          result,
          asJson,
          pretty,
          printText: () => {
            if (result.upgraded) {
              _out(`cli: upgraded mail-use ${result.from} -> ${upgrade.bareVersion(result.to)} (${result.checksum === "verified" ? "sha256 verified" : "UNVERIFIED: no checksum published"})\n`);
              const d = result.daemon || {};
              if (!d.was_running) _out("  daemon: was not running\n");
              else if (d.restarted) _out(`  daemon: restarted on the new binary (pid ${d.old_pid} -> ${d.new_pid})\n`);
              else if (d.method === "shutdown" && !d.error) _out(`  daemon: stopped — ${d.hint}\n`);
              else _out(`  daemon: RESTART FAILED — still on the old binary${d.error ? ` (${d.error})` : ""}\n    fix with: mail-use daemon install\n`);
            }
            else _out(`cli: mail-use ${upgrade.bareVersion(result.current)} is up to date\n`);
            _out(skillLines(result.skills));
          },
        });
        process.exit(skillFailed ? 1 : 0);
      } catch (e) {
        return failed((e && e.message) || String(e));
      }
    });

  // digest
  program
    .command("cleanup")
    .description("Classify emails and propose a deletion plan (default: plan only; --confirm to delete marketing/routine candidates)")
    .option("--account-id <id>", "Account id/email (omit to span all accounts)")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--limit <n>", "Scan limit", "200")
    .option("--unread-only", "Only classify unread emails")
    .option("--categories <list>", "Comma-separated categories to delete on --confirm", "marketing,routine_notification")
    .option("--permanent", "Permanently delete instead of moving to trash")
    .option("--trash-folder <name>", "Trash folder", "Trash")
    .option("--confirm", "Actually delete the candidate categories (default: plan only)")
    .option("--dry-run")
    .action(async (opts) => {
      const paging = _validatePaging(opts.limit, "0", { defaultLimit: 200 });
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        return process.exit(rc);
      }
      const confirm = Boolean(opts.confirm) && !opts.dryRun;
      const base = {
        account_id: opts.accountId || "",
        folder: opts.folder,
        limit: paging.limit,
        unread_only: Boolean(opts.unreadOnly),
      };
      let result;
      if (!confirm) {
        result = await cleanup.plan(base);
        if (result && typeof result === "object" && result.success) {
          result.confirmation_required = true;
          result.confirmation_hint = "Re-run with --confirm to delete the candidate categories";
        }
      } else {
        const categories = String(opts.categories || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        result = await cleanup.apply({
          ...base,
          categories,
          permanent: Boolean(opts.permanent),
          trash_folder: opts.trashFolder,
        });
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("cleanup") });
      return process.exit(rc);
    });

  const digestCmd = program.command("digest").description("Daily digest workflows");
  digestCmd
    .command("run")
    .description("Run once (dry-run by default; --confirm to actually send notifications)")
    .option("--confirm", "Actually deliver notifications (default: dry-run)")
    .option("--dry-run")
    .option("--debug-path <path>")
    .action(async (opts) => {
      const dryRun = Boolean(opts.dryRun) || !opts.confirm;
      const result = await digest.run({ dry_run: dryRun, debug_path: opts.debugPath || "" });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to actually deliver notifications";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("digest run") });
      process.exit(rc);
    });
  digestCmd
    .command("config")
    .description("Print current configuration")
    .action(async () => {
      const result = await digest.getConfig();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("digest config") });
      process.exit(rc);
    });

  digestCmd
    .command("daemon")
    .description("Run digest periodically in the foreground")
    .option("--interval <seconds>", "Interval", "3600")
    .option("--dry-run")
    .action(async (opts) => {
      const intervalSec = Math.max(5, Number(opts.interval || 3600));
      const stop = _createStopSignal();
      try {
        while (!stop.stopped()) {
          await digest.run({ dry_run: Boolean(opts.dryRun), debug_path: "" });
          if (stop.stopped()) break;
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch {
        return process.exit(0);
      }
    });

  // monitor
  const monitorCmd = program.command("monitor").description("Email monitor workflows");
  monitorCmd
    .command("run")
    .description("Run one monitoring cycle")
    .action(async () => {
      const result = await monitor.run();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor run") });
      process.exit(rc);
    });
  monitorCmd
    .command("status")
    .description("Get monitoring status")
    .action(async () => {
      const result = await monitor.status();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor status") });
      process.exit(rc);
    });
  monitorCmd
    .command("config")
    .description("Print current configuration")
    .action(async () => {
      const result = await monitor.config();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor config") });
      process.exit(rc);
    });
  monitorCmd
    .command("test")
    .description("Test individual components")
    .argument("[component]", "fetch|notify|all", "all")
    .action(async (component) => {
      const result = await monitor.test({ component });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor test") });
      process.exit(rc);
    });

  // daemon
  const daemonCmd = program.command("daemon").description("Persistent IMAP daemon (reuses connections across CLI calls)");
  daemonCmd
    .command("start")
    .description("Start the daemon in the foreground (run with nohup/launchd/systemd to detach)")
    .option("--sync-interval <seconds>", "Run a background sync this often (0 disables)", "300")
    .option("--sync-account-id <id>", "Restrict background sync to one account")
    .action(async (opts) => {
      const { startDaemon } = require("./daemon");
      try {
        const syncIntervalSec = Math.max(0, Number(opts.syncInterval || 0));
        await startDaemon({
          foreground: true,
          syncIntervalMs: syncIntervalSec * 1000,
          syncAccountId: opts.syncAccountId || "",
        });
        // Block forever until SIGINT/SIGTERM
        await new Promise(() => {});
      } catch (e) {
        // Another daemon already serves the socket: the goal ("a daemon is
        // running") is met, so exit 0. A non-zero exit here is what made
        // launchd/systemd respawn this process in a tight loop.
        if (e && e.code === "EADDRINUSE") {
          const result = { success: true, already_running: true, message: (e && e.message) || "daemon already running" };
          const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => process.stderr.write(result.message + "\n") });
          process.exit(rc);
        }
        const result = { success: false, error: (e && e.message) || "daemon failed", error_code: "operation_failed" };
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => process.stderr.write(result.error + "\n") });
        process.exit(rc);
      }
    });
  daemonCmd
    .command("install")
    .description("Install a launchd LaunchAgent (macOS) or systemd user unit (Linux) to autostart the daemon at login")
    .option("--sync-interval <seconds>", "Background sync interval (default: keep the installed unit's, else 300)")
    .action(async (opts) => {
      const { installAutostart } = require("./daemon");
      const result = await installAutostart({ syncIntervalSec: opts.syncInterval != null ? Number(opts.syncInterval) : undefined });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => {
        if (r.success) _out(`installed: ${r.unit_path}\n  next: ${r.activate_hint || "(start it now with: mail-use daemon start)"}\n`);
        else process.stderr.write((r.error || "install failed") + "\n");
      } });
      process.exit(rc);
    });
  daemonCmd
    .command("uninstall")
    .description("Remove the autostart unit and stop the daemon")
    .action(async () => {
      const { uninstallAutostart } = require("./daemon");
      const result = await uninstallAutostart();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => {
        if (r.success) _out(`uninstalled: ${r.unit_path || "(no unit found)"}\n`);
        else process.stderr.write((r.error || "uninstall failed") + "\n");
      } });
      process.exit(rc);
    });
  daemonCmd
    .command("status")
    .description("Probe the daemon and report version + pool stats")
    .action(async () => {
      let result = await _daemonAdmin("__ping");
      if (!result.success) {
        // The socket did not answer; the pid file tells "not running" apart
        // from "running but wedged", and a stale one is cleaned up.
        const { readDaemonPid } = require("./daemon_paths");
        const pf = readDaemonPid();
        if (pf && pf.alive) {
          result = { ...result, pid: pf.pid, error: `daemon process ${pf.pid} is alive but not answering (${result.error})`, error_code: "not_responding" };
        } else if (pf) {
          try { require("fs").unlinkSync(pf.path); } catch { /* ignore */ }
        }
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => {
        if (!r.success) { process.stderr.write((r.error || "not running") + "\n"); return; }
        const upS = r.uptime_ms != null ? Math.round(r.uptime_ms / 1000) : "?";
        _out(`daemon pid=${r.pid} uptime=${upS}s\n`);
        _out("\npool:\n");
        if (!(r.pool || []).length) _out("  (no accounts connected yet — prewarm or first call will populate)\n");
        for (const p of r.pool || []) {
          const inUse = p.in_use != null ? `, ${p.in_use}/${p.clients} in use` : "";
          _out(`  ${p.account_id}: ${p.connected ? "connected" : "idle"}${inUse}\n`);
        }
        if (r.sync) {
          _out("\nsync:\n");
          _out(`  attempted=${r.sync.syncs_attempted} ok=${r.sync.syncs_ok} failed=${r.sync.syncs_failed}\n`);
          if (r.sync.last_sync_at) _out(`  last_sync_at=${r.sync.last_sync_at}\n`);
          if (r.sync.last_sync_error) _out(`  last_sync_error=${r.sync.last_sync_error}\n`);
          if (r.sync.prewarm) _out(`  prewarm=${r.sync.prewarm.completed}/${r.sync.prewarm.started} (${r.sync.prewarm.failed} failed)\n`);
        }
        if (r.update && r.update.update_available) {
          _out(`  update: ${r.update.current} -> ${r.update.latest} available (run: mail-use upgrade)\n`);
        }
      } });
      process.exit(rc);
    });
  daemonCmd
    .command("stop")
    .description("Stop the daemon (through launchd/systemd when it is installed as a service, so it stays stopped)")
    .action(async () => {
      const { stopDaemon } = require("./daemon");
      const result = await stopDaemon();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => {
        if (!r.success) { process.stderr.write((r.error || "stop failed") + "\n"); return; }
        _out(`daemon stopped (${r.method})\n`);
        if (r.hint) _out(`  ${r.hint}\n`);
      } });
      process.exit(rc);
    });
  daemonCmd
    .command("reload")
    .description("Drop pooled IMAP connections (e.g. after editing auth.json)")
    .action(async () => {
      const result = await _daemonAdmin("__reload");
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => {
        if (r.success) _out("daemon reloaded\n");
        else process.stderr.write((r.error || "reload failed") + "\n");
      } });
      process.exit(rc);
    });

  // watch
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
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => process.stderr.write((result && result.error) || "watch failed\n") });
        process.exit(rc);
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

  // mcp
  const mcpCmd = program.command("mcp").description("Model Context Protocol server (for Claude Desktop / Code / Cursor / etc.)");
  mcpCmd
    .command("serve")
    .description("Run the MCP server over stdio. Configure your AI client to spawn this command.")
    .action(async () => {
      const { startStdioServer } = require("./mcp_server");
      try {
        await startStdioServer();
        // Stdio transport keeps reading from stdin; we have to block here so
        // the Node process doesn't exit and tear down the transport.
        await new Promise((resolve) => {
          process.stdin.on("end", resolve);
          process.stdin.on("close", resolve);
          process.on("SIGINT", resolve);
          process.on("SIGTERM", resolve);
        });
        process.exit(0);
      } catch (e) {
        process.stderr.write(`mcp server failed: ${e && e.message}\n`);
        process.exit(1);
      }
    });
  mcpCmd
    .command("config")
    .description("Print a sample MCP client config snippet for Claude Desktop / Code")
    .action(() => {
      // #22：装机版是单文件二进制（现为 Node SEA，早期是 pkg），process.argv[1] 不是磁盘上
      // 真实存在的脚本（pkg 时代是 /snapshot/... 虚拟路径）——照着它配的客户端一定起不来。
      // 二进制里 execPath 就是 `mail-use` 自己，直接带子命令即可。
      const packaged = require("./packaged").isPackagedBinary();
      const cfg = {
        mcpServers: {
          "mail-use": {
            command: process.execPath,
            args: packaged ? ["mcp", "serve"] : [process.argv[1] || "mail-use", "mcp", "serve"],
          },
        },
      };
      const result = { success: true, config: cfg, hint: "Add the mcpServers entry to your client's config (e.g. ~/Library/Application Support/Claude/claude_desktop_config.json on macOS)" };
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _out(JSON.stringify(cfg, null, 2) + "\n") });
      process.exit(rc);
    });

  // inbox
  program
    .command("inbox")
    .description("Inbox organizer")
    .option("--limit <n>", "Analyze latest N emails", "15")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--unread-only")
    .option("--account-id <id>")
    .action(async (opts) => {
      const result = await inbox.run({
        limit: Number(opts.limit),
        folder: opts.folder,
        unread_only: Boolean(opts.unreadOnly),
        account_id: opts.accountId || "",
      });
      const rc = contract.handleJsonOrText({
        result,
        asJson,
        pretty,
        printText: (r) => {
          if (r && r.summary_text) _out(String(r.summary_text) + "\n");
          const stats = r && r.stats;
          if (stats) {
            _out(`spam: ${stats.delete_spam || 0}, marketing: ${stats.delete_marketing || 0}, mark_read: ${stats.mark_as_read || 0}, attention: ${stats.needs_attention || 0}\n`);
          }
        },
      });
      process.exit(rc);
    });

  // Default interactive mode if no command.
  if (!parsed.argv.length) {
    return contract.invalidUsage({ message: "No command provided", asJson, pretty });
  }

  // --help --json: emit a structured help descriptor for AI introspection
  // instead of letting commander print human text and exit.
  if (asJson && parsed.argv.some((a) => a === "--help" || a === "-h")) {
    const argvNoHelp = parsed.argv.filter((a) => a !== "--help" && a !== "-h");
    const { cmd, unknown } = _findCommandPath(program, argvNoHelp);
    if (unknown) {
      // Don't let `<unknown-cmd> --help --json` falsely report success — that
      // misleads an agent into thinking the command exists.
      const result = {
        success: false,
        error: `Unknown command: ${unknown}`,
        error_code: "invalid_argument",
        help: _commandToJson(cmd),
      };
      contract.handleJsonOrText({ result, asJson, pretty, printText: () => {} });
      return 2;
    }
    const result = { success: true, help: _commandToJson(cmd) };
    contract.handleJsonOrText({ result, asJson, pretty, printText: () => {} });
    return 0;
  }

  await _dailyUpdateNotice(parsed.argv);

  try {
    await program.parseAsync(["node", "mail-use", ...parsed.argv]);
    return 0;
  } catch (err) {
    if (
      err &&
      (err.code === "commander.help" ||
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.version") &&
      err.exitCode === 0
    ) {
      return 0;
    }
    if (err && typeof err.code === "string" && err.code.startsWith("commander.")) {
      // commander throws on invalid usage (exitOverride).
      let message = err.message || "Invalid usage";
      // Strip commander's own "error: " prefix so the JSON payload doesn't
      // end up with `"error": "error: ..."`.
      message = String(message).replace(/^error:\s*/i, "");
      return contract.invalidUsage({ message, asJson, pretty });
    }
    // Anything else is an action that threw at runtime (IMAP dropped, disk
    // full, a bug). That is not the caller's usage mistake: reporting it as
    // invalid_argument/exit 2 told agents to fix arguments that were fine.
    const message = (err && err.message) || String(err || "operation failed");
    const result = { success: false, error: message, error_code: contract.inferErrorCode(message) || "operation_failed" };
    if (result.error_code === "unknown_error") result.error_code = "operation_failed";
    contract.handleJsonOrText({ result, asJson, pretty, printText: (r) => process.stderr.write(`${r.error}\n`) });
    return 1;
  }
}

module.exports = { main };
