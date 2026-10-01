// Terminal prompts for the interactive setup commands (account add,
// apple-mail import).
//
// Everything is written to stderr so stdout stays a clean result channel even
// when a person runs the command with --json. Secrets are read with echo off:
// the authorization code must not land in scrollback or a screen recording.

const readline = require("readline");

function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function say(text) {
  process.stderr.write(`${text}\n`);
}

// One visible line of input.
function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

// One line of input with echo off. Raw mode instead of readline so nothing
// (not even "*") is drawn; Ctrl-C still aborts the whole command.
function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    const wasRaw = Boolean(stdin.isRaw);
    let buf = "";
    function finish() {
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
      stdin.pause();
      process.stderr.write("\n");
    }
    function onData(chunk) {
      // Arrow keys and other escape sequences arrive as one chunk; drop them
      // whole instead of letting "[A" leak into the secret.
      if (chunk.startsWith("\u001b")) return;
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          finish();
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = Array.from(buf).slice(0, -1).join("");
          continue;
        }
        if (ch < " ") continue;
        buf += ch;
      }
    }
    stdin.setEncoding("utf8");
    try { stdin.setRawMode(true); } catch { /* not a TTY: input will echo */ }
    stdin.resume();
    stdin.on("data", onData);
  });
}

// All of stdin (for --password-stdin), with the trailing newline that
// `echo` / a here-string adds removed.
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

module.exports = { isInteractive, say, promptLine, promptHidden, readStdin };
