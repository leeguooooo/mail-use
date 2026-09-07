import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { ImapPool } = require("../src/services/imap_pool.js");

// A pool entry is just { client, inUse, lastUsed, keepalive }. Reaping is pure
// bookkeeping over that shape, so drive it directly rather than standing up
// real IMAP connections.
function fakeEntry({ ageMs = 0, inUse = false } = {}) {
  let loggedOut = false;
  return {
    client: {
      usable: true,
      logout: async () => {
        loggedOut = true;
      },
      get loggedOut() {
        return loggedOut;
      },
    },
    inUse,
    lastUsed: Date.now() - ageMs,
    keepalive: setInterval(() => {}, 1e9),
    wasLoggedOut: () => loggedOut,
  };
}

function poolWith(entries, opts = {}) {
  const pool = new ImapPool({ idleMs: 60_000, keepWarm: 1, ...opts });
  const account = { id: "acc", email: "a@b.com", password: "x", imap: { host: "h", port: 993, secure: true } };
  const ap = pool._poolFor(account);
  ap.entries = entries;
  return { pool, ap };
}

describe("ImapPool idle reaping — a concurrency burst must not pin sockets forever", () => {
  it("closes idle connections beyond the warm one", () => {
    const warm = fakeEntry({ ageMs: 0 });
    const old1 = fakeEntry({ ageMs: 10 * 60_000 });
    const old2 = fakeEntry({ ageMs: 20 * 60_000 });
    const { pool, ap } = poolWith([warm, old1, old2]);

    expect(pool.reapIdle()).toBe(2);
    expect(ap.entries).toEqual([warm]);
    expect(old1.wasLoggedOut() || old1.client === null).toBeTruthy();
  });

  it("always keeps one warm, even when every connection is idle", () => {
    const a = fakeEntry({ ageMs: 30 * 60_000 });
    const b = fakeEntry({ ageMs: 20 * 60_000 });
    const { pool, ap } = poolWith([a, b]);

    expect(pool.reapIdle()).toBe(1);
    expect(ap.entries.length).toBe(1);
    // The survivor is the most recently used one.
    expect(ap.entries[0]).toBe(b);
  });

  it("never reaps a connection that is in use", () => {
    const busy = fakeEntry({ ageMs: 60 * 60_000, inUse: true });
    const idle = fakeEntry({ ageMs: 60 * 60_000 });
    const { pool, ap } = poolWith([busy, idle]);

    pool.reapIdle();
    expect(ap.entries).toContain(busy);
  });

  it("leaves fresh connections alone", () => {
    const a = fakeEntry({ ageMs: 1000 });
    const b = fakeEntry({ ageMs: 2000 });
    const { pool, ap } = poolWith([a, b]);

    expect(pool.reapIdle()).toBe(0);
    expect(ap.entries.length).toBe(2);
  });

  it("MAILBOX_POOL_KEEP_WARM=0 lets the pool drain to nothing", () => {
    const a = fakeEntry({ ageMs: 30 * 60_000 });
    const { pool, ap } = poolWith([a], { keepWarm: 0 });

    expect(pool.reapIdle()).toBe(1);
    expect(ap.entries.length).toBe(0);
  });

  it("idleMs=0 disables reaping entirely", () => {
    const a = fakeEntry({ ageMs: 60 * 60_000 });
    const b = fakeEntry({ ageMs: 60 * 60_000 });
    const { pool, ap } = poolWith([a, b], { idleMs: 0 });

    expect(pool.reapIdle()).toBe(0);
    expect(ap.entries.length).toBe(2);
  });

  it("the sweep timer is unref'd so it can never hold the process open", () => {
    const pool = new ImapPool({ idleMs: 60_000 });
    expect(pool._sweep).toBeTruthy();
    // An unref'd timer reports hasRef() === false in Node.
    expect(typeof pool._sweep.hasRef === "function" ? pool._sweep.hasRef() : false).toBe(false);
    pool.closeAll();
    expect(pool._sweep).toBeNull();
  });
});
