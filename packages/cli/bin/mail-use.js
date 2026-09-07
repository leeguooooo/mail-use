#!/usr/bin/env node

function ensureTracingChannelCompat() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    const diag = require("diagnostics_channel");
    if (diag && typeof diag.tracingChannel !== "function") {
      diag.tracingChannel = (name) => {
        const channel =
          typeof diag.channel === "function"
            ? diag.channel(name)
            : { name, publish() {}, subscribe() {}, unsubscribe() {}, hasSubscribers: false };
        const noop = () => {};
        return {
          name,
          channel,
          hasSubscribers: Boolean(channel.hasSubscribers),
          publish: typeof channel.publish === "function" ? channel.publish.bind(channel) : noop,
          subscribe: typeof channel.subscribe === "function" ? channel.subscribe.bind(channel) : noop,
          unsubscribe: typeof channel.unsubscribe === "function" ? channel.unsubscribe.bind(channel) : noop,
          start: noop,
          end: noop,
          asyncStart: noop,
          asyncEnd: noop,
          traceSync: (fn, context, thisArg) => (typeof fn === "function" ? fn.call(thisArg, context) : undefined),
          traceCallback: (fn, context, thisArg) => (typeof fn === "function" ? fn.call(thisArg, context) : undefined),
          tracePromise: (promise) => promise,
        };
      };
    }
  } catch {
    // Ignore if diagnostics_channel is unavailable.
  }
}

ensureTracingChannelCompat();

const { main } = require("../src/main");

Promise.resolve()
  .then(async () => {
    const argv = process.argv.slice(2);
    return await main(argv);
  })
  .then((code) => {
    process.exit(typeof code === "number" ? code : 0);
  })
  .catch((err) => {
    const msg = err && err.message ? err.message : String(err || "Error");
    process.stderr.write(msg + "\n");
    process.exit(1);
  });
