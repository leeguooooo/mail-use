import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const clientPath = require.resolve("../src/core_client.js");

function freshClient() {
  delete require.cache[clientPath];
  return require(clientPath);
}

describe("daemon call timeout", () => {
  const { _callTimeoutMs } = freshClient();

  it("long-running calls get no client-side timeout", () => {
    for (const fn of ["sync.force", "sync.init", "digest.run", "inbox.run", "cleanup.apply"]) {
      expect(_callTimeoutMs(fn, {})).toBe(0);
    }
  });

  it("a caller's own timeout_ms extends ours (with margin) instead of being cut at 60s", () => {
    expect(_callTimeoutMs("email.searchEmails", { timeout_ms: 600000 })).toBe(615000);
    expect(_callTimeoutMs("email.searchEmails", { timeout_ms: 0 })).toBe(0);
    // Never shorter than the default.
    expect(_callTimeoutMs("email.searchEmails", { timeout_ms: 1000 })).toBe(60000);
    expect(_callTimeoutMs("email.listEmails", {})).toBe(60000);
  });
});

describe("daemon connect", () => {
  let dir;
  let server;
  const saved = {};

  beforeEach(async () => {
    for (const k of ["MAILBOX_NO_DAEMON", "MAILBOX_INTERNAL_TEST_MODE", "MAILBOX_DAEMON_SOCKET"]) saved[k] = process.env[k];
    delete process.env.MAILBOX_NO_DAEMON;
    delete process.env.MAILBOX_INTERNAL_TEST_MODE;
    // Short path: unix socket paths are capped at ~104 bytes on macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mu-"));
    process.env.MAILBOX_DAEMON_SOCKET = path.join(dir, "d.sock");
    server = net.createServer((c) => { c.on("error", () => {}); });
    await new Promise((r) => { server.listen(process.env.MAILBOX_DAEMON_SOCKET, r); });
  });

  afterEach(async () => {
    await new Promise((r) => { server.close(r); });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    delete require.cache[clientPath];
  });

  it("concurrent first calls all get the daemon, not just the first one", async () => {
    const { _maybeConnect } = freshClient();
    const clients = await Promise.all(Array.from({ length: 5 }, () => _maybeConnect()));
    expect(clients.every((c) => c !== null)).toBe(true);
    expect(new Set(clients).size).toBe(1);
    clients[0].close();
  });
});

describe("startup cost", () => {
  it("--version loads neither @mail-use/core nor the daemon module", () => {
    const bin = path.join(import.meta.dirname, "..", "bin", "mail-use.js");
    const probe = `
      const Module = require("module");
      const seen = [];
      const orig = Module._load;
      Module._load = function (req) { seen.push(req); return orig.apply(this, arguments); };
      process.argv = [process.argv[0], ${JSON.stringify(bin)}, "--version"];
      process.exit = () => { process.stderr.write(JSON.stringify(seen)); process.reallyExit(0); };
      require(${JSON.stringify(bin)});
    `;
    const r = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", env: { ...process.env, MAILBOX_NO_DAEMON: "1" } });
    const seen = JSON.parse(r.stderr.trim());
    expect(seen).not.toContain("@mail-use/core");
    expect(seen).not.toContain("@mail-use/workflows");
    expect(seen).not.toContain("./daemon");
    expect(seen).not.toContain("imapflow");
  });
});
