import { createRequire } from "node:module";
import Module from "node:module";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const mainPath = require.resolve("../src/main.js");

// Runs main() in-process with a fake core behind the ./proxies seam and
// captures what it prints and the exit code it chooses.
async function runCli(argv, email) {
  const originalLoad = Module._load;
  const originalWriteSync = fs.writeSync;
  const originalStderr = process.stderr.write;
  const originalExit = process.exit;
  const out = [];
  const exits = [];
  Module._load = function patched(request, ...rest) {
    if (request === "./proxies") {
      return { accounts: {}, email, imap: {}, smtp: {}, sync: {}, digest: {}, monitor: {}, inbox: {}, cleanup: {} };
    }
    return originalLoad.apply(this, [request, ...rest]);
  };
  fs.writeSync = (fd, buf, offset = 0, length = buf.length - offset) => {
    if (fd === 1 || fd === 2) {
      out.push(Buffer.isBuffer(buf) ? buf.toString("utf8", offset, offset + length) : String(buf));
      return length;
    }
    return originalWriteSync(fd, buf, offset, length);
  };
  process.stderr.write = () => true;
  process.exit = (code) => { exits.push(code); };
  delete require.cache[mainPath];
  try {
    const { main } = require(mainPath);
    const rc = await main([...argv, "--json"]);
    const text = out.join("").trim();
    return { code: exits.length ? exits[exits.length - 1] : rc, payload: text ? JSON.parse(text) : null };
  } finally {
    delete require.cache[mainPath];
    Module._load = originalLoad;
    fs.writeSync = originalWriteSync;
    process.stderr.write = originalStderr;
    process.exit = originalExit;
  }
}

describe("runtime errors vs usage errors", () => {
  it("an action that throws is a runtime failure: success:false, exit 1, not invalid_argument", async () => {
    const email = {
      listEmails: async () => { throw new Error("socket hang up"); },
    };
    const r = await runCli(["email", "list"], email);
    expect(r.code).toBe(1);
    expect(r.payload).toMatchObject({ success: false, error: "socket hang up", error_code: "operation_failed" });
  });

  it("the error_code is inferred from the message when it is recognisable", async () => {
    const email = {
      listEmails: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:993"); },
    };
    const r = await runCli(["email", "list"], email);
    expect(r.code).toBe(1);
    expect(r.payload.error_code).toBe("network_error");
  });

  it("commander usage errors stay invalid_argument / exit 2", async () => {
    const r = await runCli(["email", "list", "--no-such-flag"], {});
    expect(r.code).toBe(2);
    expect(r.payload).toMatchObject({ success: false, error_code: "invalid_argument" });
  });
});

describe("text output survives process.exit on a pipe", () => {
  it("writes a >64 KiB text payload completely", () => {
    const render = path.join(import.meta.dirname, "..", "src", "cli", "render.js");
    const size = 512 * 1024;
    // Child writes a big text block through _out and exits immediately — the
    // pattern every action uses. process.stdout.write would lose the tail.
    const code = `require(${JSON.stringify(render)})._out("x".repeat(${size}) + "\\n"); process.exit(0);`;
    const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", maxBuffer: 4 * size });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(size + 1);
  });
});

describe("mcp server identity", () => {
  it("reports the CLI version, not a hardcoded one", () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "mcp_server.js"), "utf8");
    expect(src).not.toMatch(/version:\s*"0\.1\.0"/);
    expect(src).toMatch(/version:\s*getCliVersion\(\)/);
  });
});
