// One shared set of core/workflow proxies for the whole CLI.
//
// makeProxies() is a stateless factory, so calling it per module would work but
// would scatter several equivalent instances around. Everything that needs to
// reach core imports from here instead.
//
// When a daemon is running these forward over its Unix socket so calls reuse
// pooled IMAP connections (1-3s saved each); with no daemon they fall back
// transparently to in-process execution.
const { makeProxies } = require("./core_client");

module.exports = makeProxies();
