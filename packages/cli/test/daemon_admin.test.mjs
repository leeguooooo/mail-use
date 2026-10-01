import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { socketAccepts } = require("../src/daemon_admin.js");

// Unix socket paths are capped near 104 bytes on macOS: keep it short.
const sockPath = path.join(os.tmpdir(), `mu-probe-${process.pid}.sock`);

afterEach(() => {
  try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
});

describe("socketAccepts (the one connect-only daemon probe)", () => {
  it("is false when the socket file does not exist", async () => {
    expect(await socketAccepts({ sockPath })).toBe(false);
  });

  it("is false for a stale socket file nobody listens on", async () => {
    fs.writeFileSync(sockPath, "");
    expect(await socketAccepts({ sockPath, timeoutMs: 500 })).toBe(false);
  });

  it("is true while a server listens", async () => {
    const server = net.createServer((c) => c.end());
    await new Promise((r) => { server.listen(sockPath, r); });
    try {
      expect(await socketAccepts({ sockPath, timeoutMs: 1000 })).toBe(true);
    } finally {
      await new Promise((r) => { server.close(r); });
    }
  });
});
