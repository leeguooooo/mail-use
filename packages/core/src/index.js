// Each service loads on first access. email/sync pull in the SQLite cache
// (sql.js, ~20ms of wasm/asm init) and imapflow; a caller that only needs
// `accounts` should not pay for them. Literal require() calls keep pkg's
// static bundler able to see every module.
module.exports = {
  get accounts() { return require("./services/accounts"); },
  get imap() { return require("./services/imap"); },
  get smtp() { return require("./services/smtp"); },
  get email() { return require("./services/email"); },
  get sync() { return require("./services/sync"); },
};
