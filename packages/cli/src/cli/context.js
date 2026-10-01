// The per-invocation context handed to every commands/<group>.js register().
//
// It carries the output mode resolved from the global flags and the one way an
// action reports a result, so `--lean` / `--format` reach every command without
// each call site threading them through.

const { contract } = require("@mail-use/shared");
const { _printTextNotImplemented } = require("./render");

function createContext({ proxies, asJson, explicitJson, pretty, lean, format }) {
  const shaping = { ...(lean ? { lean: true } : {}), ...(format ? { format } : {}) };

  // Print a result (JSON, or text via printText) and return its exit code.
  function output({ result, printText }) {
    return contract.handleJsonOrText({ result, asJson, pretty, printText, ...shaping });
  }

  return {
    proxies,
    asJson,
    // --json typed by the caller, as opposed to JSON implied by a piped stdout.
    explicitJson,
    pretty,
    output,
    // Print a result and exit with its code. printText is a text renderer, or a
    // command label for commands that have no text mode yet.
    respond(result, printText) {
      const printer = typeof printText === "string" ? () => _printTextNotImplemented(printText) : printText;
      return process.exit(output({ result, printText: printer }));
    },
    // Report a usage error (exit 2).
    usage(message) {
      return process.exit(contract.invalidUsage({ message, asJson, pretty }));
    },
  };
}

module.exports = { createContext };
