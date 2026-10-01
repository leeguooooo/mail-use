#!/usr/bin/env node

const { main } = require("../src/main");

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then((code) => {
    process.exit(typeof code === "number" ? code : 0);
  })
  .catch((err) => {
    const msg = err && err.message ? err.message : String(err || "Error");
    process.stderr.write(msg + "\n");
    process.exit(1);
  });
