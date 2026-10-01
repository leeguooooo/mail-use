import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { ImapPool, abandonClient, _buildClient } = require("../src/services/imap_pool.js");

const ACCOUNT = { id: "acc", email: "a@b.com", password: "x", imap: { host: "127.0.0.1", port: 993, secure: true } };

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// A stand-in for an ImapFlow client: just the surface the pool touches.
function fakeClient({ logout } = {}) {
  const c = {
    usable: true,
    loggedOut: false,
    closed: false,
    logout: logout || (async () => { c.loggedOut = true; c.usable = false; }),
    close: () => { c.closed = true; c.usable = false; },
  };
  return c;
}

function fakeEntry(client = fakeClient()) {
  return { client, inUse: false, lastUsed: Date.now(), keepalive: setInterval(() => {}, 1e9) };
}

// Pool whose connections are fakes built after `buildMs`, so "is a socket
// being opened right now" is observable without a server.
function stubbedPool({ maxSize = 2, buildMs = 20, opts = {} } = {}) {
  const pool = new ImapPool({ idleMs: 60_000, keepWarm: 1, ...opts });
  pool.maxPerAccount = maxSize;
  const stats = { built: 0 };
  const ap = pool._poolFor(ACCOUNT);
  ap._build = async () => {
    stats.built += 1;
    await sleep(buildMs);
    return fakeEntry();
  };
  return { pool, ap, stats };
}

const pools = [];
afterEach(async () => {
  vi.useRealTimers();
  while (pools.length) await pools.pop().closeAll();
});

describe("ImapPool max size under concurrency", () => {
  it("a burst of concurrent calls never opens more than maxSize connections", async () => {
    const { pool, ap, stats } = stubbedPool({ maxSize: 2 });
    pools.push(pool);
    let peak = 0;
    let active = 0;
    const calls = Array.from({ length: 10 }, () =>
      pool.withClient(ACCOUNT, async () => {
        active += 1;
        peak = Math.max(peak, active, ap.entries.length + ap.pending);
        await sleep(10);
        active -= 1;
        return "ok";
      })
    );
    const results = await Promise.all(calls);
    expect(results).toEqual(Array(10).fill("ok"));
    expect(stats.built).toBe(2);
    expect(ap.entries.length).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("a failed connect frees its slot for a queued caller", async () => {
    const { pool, ap } = stubbedPool({ maxSize: 1 });
    pools.push(pool);
    let attempt = 0;
    ap._build = async () => {
      attempt += 1;
      await sleep(10);
      if (attempt === 1) throw new Error("connect refused");
      return fakeEntry();
    };
    const first = pool.withClient(ACCOUNT, async () => "first");
    const second = pool.withClient(ACCOUNT, async () => "second");
    await expect(first).rejects.toThrow("connect refused");
    // Without the hand-off, the second caller waited forever on a slot that
    // was never going to be released.
    await expect(second).resolves.toBe("second");
  });
});

describe("ImapPool retry policy", () => {
  it("does not re-run a non-idempotent call after a connection error", async () => {
    const { pool } = stubbedPool();
    pools.push(pool);
    let runs = 0;
    await expect(pool.withClient(ACCOUNT, async () => {
      runs += 1;
      throw new Error("Connection closed");
    })).rejects.toThrow("Connection closed");
    expect(runs).toBe(1);
  });

  it("re-runs an idempotent call once on a fresh connection", async () => {
    const { pool, stats } = stubbedPool();
    pools.push(pool);
    let runs = 0;
    const r = await pool.withClient(ACCOUNT, async () => {
      runs += 1;
      if (runs === 1) throw new Error("Connection closed");
      return "ok";
    }, { idempotent: true });
    expect(r).toBe("ok");
    expect(runs).toBe(2);
    expect(stats.built).toBe(2);
  });

  it("an abandoned client is neither retried nor reused", async () => {
    const { pool, ap } = stubbedPool();
    pools.push(pool);
    let runs = 0;
    let first;
    await expect(pool.withClient(ACCOUNT, async (client) => {
      runs += 1;
      first = client;
      abandonClient(client);
      throw new Error("Connection not available");
    }, { idempotent: true })).rejects.toThrow();
    expect(runs).toBe(1);
    expect(first.closed).toBe(true);
    expect(ap.entries.some((e) => e.client === first)).toBe(false);
  });
});

describe("ImapPool.reset (daemon reload)", () => {
  it("drops idle connections but keeps the idle reaper running", async () => {
    const { pool, ap } = stubbedPool();
    pools.push(pool);
    await pool.withClient(ACCOUNT, async () => {});
    const idle = ap.entries[0].client;
    const sweep = pool._sweep;
    expect(sweep).toBeTruthy();

    pool.reset();

    expect(pool._sweep).toBe(sweep);
    await sleep(0);
    expect(idle.loggedOut).toBe(true);
    expect(pool.stats()).toEqual([]);
  });

  it("lets an in-use connection finish, then closes it instead of reusing it", async () => {
    const { pool, ap } = stubbedPool();
    pools.push(pool);
    let release;
    let busy;
    const inflight = pool.withClient(ACCOUNT, async (client) => {
      busy = client;
      await new Promise((r) => { release = r; });
      return "done";
    });
    await sleep(40);
    pool.reset();
    expect(busy.loggedOut).toBe(false); // still working
    release();
    await expect(inflight).resolves.toBe("done");
    await sleep(0);
    expect(busy.loggedOut).toBe(true);
    expect(ap.entries.length).toBe(0);
  });

  it("the next call after reset builds a fresh account pool", async () => {
    const { pool, ap } = stubbedPool();
    pools.push(pool);
    await pool.withClient(ACCOUNT, async () => {});
    pool.reset();
    const fresh = pool._poolFor(ACCOUNT);
    expect(fresh).not.toBe(ap);
  });
});

describe("ImapPool.closeAll (shutdown)", () => {
  it("logs out in parallel and gives up on a wedged server after ~3s", async () => {
    vi.useFakeTimers();
    const pool = new ImapPool({ idleMs: 60_000 });
    const ap = pool._poolFor(ACCOUNT);
    const hung1 = fakeClient({ logout: () => new Promise(() => {}) });
    const hung2 = fakeClient({ logout: () => new Promise(() => {}) });
    ap.entries = [fakeEntry(hung1), fakeEntry(hung2)];

    let done = false;
    const p = pool.closeAll().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(2900);
    expect(done).toBe(false);
    // One timeout window for both, not one per connection.
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(done).toBe(true);
    expect(hung1.closed).toBe(true);
    expect(hung2.closed).toBe(true);
    expect(pool._sweep).toBeNull();
  });
});

describe("ImapFlow 'error' events", () => {
  it("every pooled client has an error listener, so a socket error can't crash the daemon", () => {
    const client = _buildClient(ACCOUNT);
    expect(client.listenerCount("error")).toBeGreaterThan(0);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => client.emit("error", new Error("ECONNRESET"))).not.toThrow();
    } finally {
      write.mockRestore();
    }
  });
});
