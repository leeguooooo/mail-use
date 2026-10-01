// code — the single most common reason an agent opens a mailbox at all:
// "what's the verification code that just arrived?". Doing that with the
// general commands costs two IMAP round-trips (list, then show the one that
// looks right) plus a guess about which email it is. This does it in one
// pass: live list with a body preview, extract codes from subject+preview,
// return the newest hit. Always live — a cached OTP is a wrong OTP.

const { contract } = require("@mail-use/shared");
const { _out } = require("../cli/render");
const { _validatePaging, _validateDateOpt } = require("../cli/options");

function register(program, ctx) {
  const { email } = ctx.proxies;
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
      if (!paging.ok) ctx.usage(paging.error);
      const v = _validateDateOpt("--since", opts.since);
      if (!v.ok) ctx.usage(v.error);

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
        ctx.respond(listed, () => {});
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
      ctx.respond(result, () => {
        if (!hits.length) { _out(`no code in the last ${opts.since}\n`); return; }
        const h = hits[0];
        _out(`${h.code}\n  from ${h.from} — ${h.subject}\n  ${h.date}  ${h.gid}\n`);
      });
    });
}

module.exports = { register };
