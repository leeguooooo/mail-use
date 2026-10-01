import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createStopSignal } = require("../src/cli/stop_signal.js");

describe("stop signal", () => {
  it("a sleep that times out unregisters its waker", async () => {
    const stop = createStopSignal();
    for (let i = 0; i < 5; i++) await stop.sleep(1);
    expect(stop.pendingWakers()).toBe(0);
  });

  it("a stop wakes a pending sleep at once", async () => {
    const stop = createStopSignal();
    const started = Date.now();
    const p = stop.sleep(10_000);
    expect(stop.pendingWakers()).toBe(1);
    process.emit("SIGTERM");
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stop.stopped()).toBe(true);
    expect(stop.pendingWakers()).toBe(0);
  });
});
