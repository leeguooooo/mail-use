# mail-use (npm)

This repository publishes the `@leeguoo/mail-use` npm package.

Goal: `npm i -g @leeguoo/mail-use` gives users a `mail-use` command **without** needing
Python or the source repo.

Distribution model:

- `@leeguoo/mail-use` (main package): provides the `mail-use` command (JS launcher)
- Platform packages (optional deps) ship the actual `mail-use` binary:
  - `@leeguoo/mail-use-darwin-arm64`
  - `@leeguoo/mail-use-darwin-x64`
  - `@leeguoo/mail-use-linux-x64-gnu`

The main package selects the correct platform package at runtime and executes
its bundled binary.

## Build inputs

The `mail-use` binary is built upstream from the Python codebase and attached to
a GitHub Release. This repo's release pipeline downloads those artifacts and
publishes them to npm.
