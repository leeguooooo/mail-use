// `<cmd> --help --json`: turn a commander Command into a structured descriptor
// so an agent can introspect the surface instead of parsing help text.

// Recursively serialize a commander Command into a JSON descriptor that an
// AI agent can introspect. Returns null if cmd is missing.
function _commandToJson(cmd) {
  if (!cmd) return null;
  const out = {
    name: cmd.name(),
    description: cmd.description() || "",
    usage: cmd.usage() || "",
    arguments: (cmd._args || cmd.registeredArguments || []).map((a) => ({
      name: a.name(),
      description: a.description || "",
      required: Boolean(a.required),
      variadic: Boolean(a.variadic),
      default: a.defaultValue,
    })),
    options: (cmd.options || []).map((o) => ({
      flags: o.flags,
      long: o.long || "",
      short: o.short || "",
      description: o.description || "",
      required: Boolean(o.required),
      optional: Boolean(o.optional),
      default: o.defaultValue,
      negate: Boolean(o.negate),
    })),
    subcommands: (cmd.commands || []).filter((c) => !c._hidden && c.name() !== "help").map((c) => ({
      name: c.name(),
      description: c.description() || "",
    })),
  };
  return out;
}

function _findCommandPath(program, argv) {
  let cur = program;
  let unknown = null;
  for (const tok of argv) {
    if (tok.startsWith("-")) break;
    const next = (cur.commands || []).find((c) => c.name() === tok);
    if (next) {
      cur = next;
      continue;
    }
    // No subcommand matched. If the current command expects subcommands, this
    // token is an unknown COMMAND (e.g. `bogus --help`); otherwise it's a
    // positional argument (e.g. `email show 101 --help`) and we stop here.
    const expectsSub = (cur.commands || []).some((c) => c.name() !== "help");
    if (expectsSub) unknown = tok;
    break;
  }
  return { cmd: cur, unknown };
}

module.exports = {
  _commandToJson,
  _findCommandPath,
};
