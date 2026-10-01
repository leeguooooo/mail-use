const { Command } = require("commander");

const { contract } = require("@mail-use/shared");
const { getCliVersion: _resolveCliVersion } = require("./cli_version");
// Core/workflow proxies. Nothing here loads @mail-use/core until a command
// calls into it (imap/smtp are lazy getters), so `--version` stays light.
const proxies = require("./proxies");
const { createContext } = require("./cli/context");
const { _commandToJson, _findCommandPath } = require("./cli/help_json");

// Registration order is the order `--help` lists the commands in.
const COMMAND_GROUPS = [
  require("./commands/account"),
  require("./commands/email"),
  require("./commands/sync"),
  require("./commands/code"),
  require("./commands/upgrade"),
  require("./commands/workflows"), // cleanup, digest, monitor
  require("./commands/daemon"),
  require("./commands/mcp"),
  require("./commands/apple_mail"),
  require("./commands/inbox"),
];

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
  // Default to JSON when stdout is piped (so scripts get parseable output);
  // --text overrides this for users who want the human-readable form even
  // when piping to less/grep.
  if (parsed.forceText) asJson = false;
  else if (!asJson && !process.stdout.isTTY) asJson = true;
  const { pretty } = parsed;

  // --lean / --format reshape every printed result; ctx.output applies them.
  const ctx = createContext({
    proxies,
    asJson,
    explicitJson: parsed.asJson,
    pretty,
    lean: parsed.lean,
    format: parsed.format,
  });

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

  for (const group of COMMAND_GROUPS) group.register(program, ctx);

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
      ctx.output({ result, printText: () => {} });
      return 2;
    }
    const result = { success: true, help: _commandToJson(cmd) };
    ctx.output({ result, printText: () => {} });
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
    ctx.output({ result, printText: (r) => process.stderr.write(`${r.error}\n`) });
    return 1;
  }
}

module.exports = { main };
