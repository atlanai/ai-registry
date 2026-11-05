// Ink imports this unshipped optional dependency and an unresolved name breaks every bundle,
// so a pnpm override points here. Ink calls both methods when DEV is set.
module.exports = { initialize() {}, connectToDevTools() {} };
module.exports.default = module.exports;
