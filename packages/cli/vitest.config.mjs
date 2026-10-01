import { defineConfig } from "vitest/config";

// A normal `vitest run` here is cheap: 69 tests, ~3.5s, ~120 MB peak RSS.
// The 4 × ~2.7 GiB orphans in #27 were therefore not a normal run — they were
// workers whose parent (an editor task or agent session) died mid-flight, so
// nothing was left to reap them.
//
// We cannot stop a parent from being killed, but we can bound the blast radius:
// without a config vitest sizes the pool from the CPU count, so a machine with
// more cores leaves proportionally more (and larger) orphans behind. Capping
// the pool caps the worst case, and at this suite's size it costs nothing —
// most of the wall clock is spawning the CLI under test, not the workers.
export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 4,
    // These tests spawn the real CLI as a child process. If one wedges, fail
    // the run instead of letting the worker sit on an open handle forever —
    // a hung worker is exactly what becomes an orphan when the parent goes.
    teardownTimeout: 10_000,
  },
});
