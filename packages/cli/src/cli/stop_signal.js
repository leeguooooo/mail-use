// Cooperative shutdown for foreground loops (sync daemon, digest daemon, sync
// watch). SIGINT/SIGTERM flips the flag and resolves any in-flight wait so the
// loop can finish its current pass (e.g. mid-flush sqlite write) before exiting.
function createStopSignal() {
  const state = { stopped: false, wakers: new Set() };
  const trigger = () => {
    state.stopped = true;
    for (const w of state.wakers) {
      try { w(); } catch { /* ignore */ }
    }
    state.wakers.clear();
  };
  process.once("SIGINT", trigger);
  process.once("SIGTERM", trigger);
  return {
    stopped: () => state.stopped,
    // For tests: sleeps still waiting to be woken.
    pendingWakers: () => state.wakers.size,
    sleep(ms) {
      if (state.stopped) return Promise.resolve();
      return new Promise((resolve) => {
        const wake = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => {
          state.wakers.delete(wake);
          resolve();
        }, ms);
        state.wakers.add(wake);
      });
    },
  };
}

module.exports = { createStopSignal };
