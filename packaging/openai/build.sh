#!/bin/sh
# Build the OpenAI plugin directory ZIP (Codex format, skills only) for upload at platform.openai.com/plugins.
#   sh packaging/openai/build.sh [out-dir]   → <out-dir>/mail-use-<version>.zip
# The directory version differs from skills/mail-use: no self-install step (the user installs the CLI),
# no OTP-extraction section (directory policy on MFA/OTP codes), no local MCP/daemon setup.
# Its SKILL.md lives next to this script.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=${1:-$ROOT/dist}
VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$HERE/.codex-plugin/plugin.json")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/.codex-plugin" "$STAGE/assets" "$STAGE/skills/mail-use" "$OUT"
cp "$HERE/.codex-plugin/plugin.json" "$STAGE/.codex-plugin/"
cp "$HERE/assets/logo.png" "$STAGE/assets/"
cp "$HERE/SKILL.md" "$STAGE/skills/mail-use/SKILL.md"
cp "$ROOT/LICENSE" "$STAGE/"

ZIP="$OUT/mail-use-$VERSION.zip"
rm -f "$ZIP"
(cd "$STAGE" && find . -type f | sort | zip -q -X "$ZIP" -@)
echo "$ZIP"
