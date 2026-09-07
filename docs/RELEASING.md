# Releasing

This project ships exactly one artifact: a standalone `mail-use` binary attached to a
GitHub Release. There is no npm package — publishing to npmjs.com needs an `NPM_TOKEN`
plus account 2FA, and that friction repeatedly blocked releases here. GitHub's own
`GITHUB_TOKEN` is enough to attach a Release asset, and `install.sh` needs no auth from
the person installing either.

The pre-rename `@leeguoo/mailbox-cli` packages still exist on npm, frozen at their last
published version. Nothing publishes to them any more.

## Automated release (the normal path)

Releases are cut from `main` by semantic-release.

Requirements:
- Conventional Commit messages (`feat:`, `fix:`, etc.)
- Repository secret `RELEASE_TOKEN` (a PAT with `repo` + `workflow` scopes) so the tag
  push triggers `release-binaries`. Without it, `semantic-release.yml` falls back to
  dispatching `release-binaries` explicitly.

Flow:
1. Merge to `main` with a `feat:` or `fix:` commit.
2. The `semantic-release` workflow computes the next version and pushes a tag like `v2.13.0`.
3. The tag triggers `release-binaries`, which builds each target and attaches the assets.

If no release-worthy commits are found, semantic-release exits without tagging.

## Manual release (fallback)

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

`release-binaries` builds and attaches:

- `mail-use-darwin-arm64.tar.gz`
- `mail-use-darwin-x64.tar.gz`
- `mail-use-linux-x64-gnu.tar.gz`

Each with a matching `.sha256`. Every tarball contains a single file, `mail-use`.

The version is baked into the binary by stamping `packages/cli/src/_version.js` from the
tag name before the build — a plain JS module, so it has no lockfile impact and `pkg`
bundles it statically.

## What the build actually does

`pnpm build:binary` (`scripts/build_binary.js`):

1. `pnpm install` + `pnpm test`.
2. esbuild bundles the CLI to a single CJS file. This exists because `pkg` 5 does not
   implement `exports` maps, and `@modelcontextprotocol/sdk` uses one — see #22.
3. `pkg` turns the bundle into `dist/mail-use`. Any `Warning Cannot find module` from
   `pkg` is treated as a hard failure.
4. The binary is actually launched and driven through an MCP `initialize` + `tools/list`
   round-trip. #22 shipped green CI with a binary that could not start; only a real
   end-to-end launch catches that.

## Consuming a release

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/mail-use/main/install.sh | sh
```

`install.sh` resolves the platform, downloads the asset, verifies the `.sha256` when
present, installs to `~/.local/bin/mail-use`, and drops a `mailbox` symlink beside it so
pre-rename scripts keep working. Pin with `MAIL_USE_VERSION=vX.Y.Z`; relocate with
`MAIL_USE_INSTALL_DIR=...`.
