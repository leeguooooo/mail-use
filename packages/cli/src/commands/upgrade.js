// upgrade — the *-use family convention (plugins docs/upgrade.md):
//   upgrade           install the latest release (release-binary installs only)
//   upgrade --skills  also refresh mail-use's own skill copies (opt-in)
//   upgrade --check   change nothing; `mail-use X -> Y` / `mail-use X is up to date`
//   upgrade --json    same as --check, as JSON (name/current/latest/update_available/skills/install_channel)
//   upgrade --tag v…  install (or --check) this exact release
// Exit 0 on success (including "update available"), 2 when the check, the
// download or the verification failed, 1 when refused because another
// package manager owns this install.

const { contract } = require("@mail-use/shared");
const { getCliVersion } = require("../cli_version");
const { _out } = require("../cli/render");

function register(program, ctx) {
  program
    .command("upgrade")
    .description("Upgrade the CLI from GitHub Releases (sha256-verified, atomic); --skills also refreshes the mail-use skill; --check / --json only report")
    .option("--check", "Only report whether a newer version exists; change nothing")
    .option("--skills", "Also refresh mail-use's own skill copies (Claude Code plugin, git checkout); without it they are only listed")
    .option("--tag <vX.Y.Z>", "Install this exact release instead of the latest (also allows downgrade)")
    .option("--insecure", "Install even if the release publishes no checksum (not recommended)")
    .action(async (opts) => {
      const upgrade = require("../upgrade");
      const skillRefresh = require("../skill_refresh");
      const current = getCliVersion();
      const failed = (msg, code = 2, extra = {}) => {
        ctx.output({
          result: { success: false, name: upgrade.NAME, error: msg, error_code: contract.inferErrorCode(msg), ...extra },
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
        if (opts.check || (ctx.explicitJson && !opts.skills && !opts.tag)) {
          const fetchLatest = opts.tag
            ? async () => ({ tag: opts.tag, url: `https://github.com/leeguooooo/mail-use/releases/tag/${opts.tag}`, published_at: "" })
            : undefined;
          const result = await upgrade.checkForUpdate(current, fetchLatest ? { fetchLatest } : {});
          result.skills = skillRefresh.detectSkills();
          result.install_channel = channel;
          ctx.output({
            result,
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
          log: (m) => { if (!ctx.asJson) process.stderr.write(`mail-use upgrade: ${m}\n`); },
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
        ctx.output({
          result,
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
}

module.exports = { register };
