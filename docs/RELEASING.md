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

`scripts/release.sh` (`--dry-run` to preview) runs lint + tests, pushes `main`, waits for both workflows, then syncs the plugin marketplace.

## Manual release (fallback)

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

`release-binaries` first runs lint + tests once (job `test`, on the shipped Node), then
builds each target in parallel and attaches:

- `mail-use-darwin-arm64.tar.gz`
- `mail-use-darwin-x64.tar.gz`
- `mail-use-linux-x64-gnu.tar.gz`
- `mail-use-linux-arm64-gnu.tar.gz` (built on `ubuntu-24.04-arm`)

Each with a matching `.sha256`. Every tarball contains a single file, `mail-use`, and has
a signed build-provenance attestation (`actions/attest-build-provenance`):

```bash
gh attestation verify mail-use-darwin-arm64.tar.gz --repo leeguooooo/mail-use
```

The version is baked into the binary by stamping `packages/cli/src/_version.js` from the
tag name before the build — a plain JS module, so it has no lockfile impact and esbuild
bundles it statically.

## What the build actually does

`pnpm build:binary` (`scripts/build_binary.js`; CI passes `--skip-install --skip-tests`
because the workflow already did both):

1. `pnpm install --frozen-lockfile` + `pnpm test`.
2. esbuild bundles the CLI to a single self-contained CJS file. esbuild understands
   `exports` maps and converts ESM, which `@modelcontextprotocol/sdk` needs — see #22. A
   banner sets a `process.pkg` marker when running as a SEA, because the runtime code
   still detects "am I the release binary" through it (upgrade channel, daemon unit file,
   MCP config).
3. Node Single Executable Applications turn the bundle into `dist/mail-use`:
   `node --experimental-sea-config` writes the blob (with a V8 code cache), the running
   `node` binary is copied, and `postject` injects the blob. On macOS the signature is
   removed before injection and the result is ad-hoc signed (`codesign --sign -`).
   **The binary embeds whichever node runs the build** — CI pins it with
   `SHIPPED_NODE` in `release-binaries.yml` (currently 24 LTS), and `test.yml` covers that
   major. The build refuses to run on Node < 22.
4. The binary is actually launched and driven through an MCP `initialize` + `tools/list`
   round-trip. #22 shipped green CI with a binary that could not start; only a real
   end-to-end launch catches that.

## Consuming a release

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/mail-use/main/install.sh | sh
```

`install.sh` resolves the platform, downloads the asset, verifies the `.sha256` (a
missing sidecar or sha256 tool aborts unless `MAIL_USE_INSECURE=1`; a mismatch always
aborts), installs to `~/.local/bin/mail-use`, and drops a `mailbox` symlink beside it so
pre-rename scripts keep working. Pin with `MAIL_USE_VERSION=vX.Y.Z`; relocate with
`MAIL_USE_INSTALL_DIR=...`.
