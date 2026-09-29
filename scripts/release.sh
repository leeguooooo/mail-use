#!/bin/sh
# Release mail-use: lint + test, push main, wait for semantic-release (it picks the version from the
# Conventional Commits and tags vX.Y.Z) and for release-binaries to attach the binaries, then sync the
# plugin marketplace so Claude Code plugin installs pick the new version up right away (uses your `gh` login).
#   scripts/release.sh [--dry-run]
set -eu
run_ok() {  # run_ok <run-id> [-R owner/repo]: wait until the run completes (gh run watch can drop on a network error), then require success
  _r=$1; shift
  until [ "$(gh run view "$_r" "$@" --json status -q .status 2>/dev/null)" = completed ]; do gh run watch "$_r" "$@" >/dev/null 2>&1 || sleep 15; done
  [ "$(gh run view "$_r" "$@" --json conclusion -q .conclusion)" = success ]
}
DRY=
[ "${1:-}" = --dry-run ] && DRY=1
REPO=leeguooooo/mail-use
MARKETPLACE=leeguooooo/plugins
cd "$(dirname "$0")/.."

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "error: not on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "error: working tree not clean" >&2; exit 1; }
git pull -q --ff-only --tags

pnpm install -s --frozen-lockfile
pnpm -s lint
MAILBOX_NO_DAEMON=1 pnpm -s test >/dev/null
# No version file to bump: semantic-release computes it. Show what it would release.
pnpm exec semantic-release --dry-run --no-ci 2>&1 | grep -E 'commits since|next release version|no new version' || true
if [ -n "$DRY" ]; then echo "dry run: nothing pushed"; exit 0; fi

git push -q origin main
SHA=$(git rev-parse HEAD)

# wait_run <workflow> <gh run list filter...>: wait for the run to appear, then for it to succeed.
wait_run() {
  wf=$1; shift; i=0
  until RUN=$(gh run list -R "$REPO" -w "$wf" "$@" -L 1 --json databaseId -q '.[0].databaseId') && [ -n "$RUN" ]; do
    i=$((i + 1)); [ "$i" -lt 60 ] || { echo "error: no $wf run appeared" >&2; exit 1; }; sleep 5
  done
  run_ok "$RUN" -R "$REPO" || { echo "error: $wf run $RUN failed" >&2; exit 1; }
}
wait_run semantic-release.yml -c "$SHA"
git fetch -q --tags
TAG=$(git tag --points-at "$SHA" 'v*' | head -1)
[ -n "$TAG" ] || { echo "no feat:/fix: commits since the last tag, so semantic-release made no release"; exit 0; }
# Don't let the plugin update before its binaries exist.
wait_run release-binaries.yml -b "$TAG"
echo "released $TAG with $(gh release view "$TAG" -R "$REPO" --json assets -q '.assets | length') assets"

# The marketplace reads the version from the latest release tag; run its sync now instead of waiting for the hourly cron.
gh workflow run auto-sync-versions.yml -R "$MARKETPLACE"
sleep 5
RUN=$(gh run list -R "$MARKETPLACE" -w auto-sync-versions.yml -e workflow_dispatch -L 1 --json databaseId -q '.[0].databaseId')
run_ok "$RUN" -R "$MARKETPLACE" && echo "marketplace synced" || echo "warn: marketplace sync run $RUN failed; the hourly run will retry"
gh api "repos/$MARKETPLACE/contents/.claude-plugin/marketplace.json" -q .content | base64 -d \
  | python3 -c "import json,sys; print('marketplace mail-use:', next(p['version'] for p in json.load(sys.stdin)['plugins'] if p['name']=='mail-use'))"
