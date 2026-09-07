#!/bin/sh
# mail-use CLI installer — downloads a prebuilt binary from GitHub Releases.
# No npm, no Node, no tokens required.
#
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/mail-use/main/install.sh | sh
#
# Env overrides:
#   MAIL_USE_VERSION=v2.11.2   install a specific tag (default: latest release)
#   MAIL_USE_INSTALL_DIR=...   install dir (default: ~/.local/bin)
#   MAIL_USE_NO_DAEMON=1       skip setting up the background daemon
#   (the older MAILBOX_* names still work)
set -eu

REPO="leeguooooo/mail-use"
INSTALL_DIR="${MAIL_USE_INSTALL_DIR:-${MAILBOX_INSTALL_DIR:-$HOME/.local/bin}}"
VERSION="${MAIL_USE_VERSION:-${MAILBOX_VERSION:-}}"

err() { printf 'mail-use-install: %s\n' "$1" >&2; exit 1; }

# --- detect platform ---------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64|aarch64) target="darwin-arm64" ;;
      x86_64)        target="darwin-x64" ;;
      *) err "unsupported macOS arch: $arch" ;;
    esac ;;
  Linux)
    case "$arch" in
      x86_64) target="linux-x64-gnu" ;;
      *) err "unsupported Linux arch: $arch (only x86_64 prebuilt)" ;;
    esac ;;
  *) err "unsupported OS: $os (macOS/Linux only; on Windows use WSL or npm)" ;;
esac

# --- resolve download URL ----------------------------------------------------
asset="mail-use-${target}.tar.gz"
if [ -n "$VERSION" ]; then
  base="https://github.com/${REPO}/releases/download/${VERSION}"
else
  base="https://github.com/${REPO}/releases/latest/download"
fi
url="${base}/${asset}"

# --- download + verify + install --------------------------------------------
command -v curl >/dev/null 2>&1 || err "curl is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'mail-use-install: downloading %s\n' "$url"
if ! curl -fSL --retry 3 -o "$tmp/$asset" "$url"; then
  # Releases published before the mailbox -> mail-use rename ship mailbox-<target>.tar.gz.
  legacy_asset="mailbox-${target}.tar.gz"
  printf 'mail-use-install: retrying with legacy asset %s\n' "$legacy_asset"
  curl -fSL --retry 3 -o "$tmp/$asset" "${base}/${legacy_asset}" \
    || err "download failed (does the release have ${asset}?)"
  url="${base}/${legacy_asset}"
fi

# Optional checksum verification when the .sha256 sidecar is present.
if curl -fsSL --retry 2 -o "$tmp/$asset.sha256" "${url}.sha256" 2>/dev/null; then
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
  else
    actual=""
  fi
  if [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
    err "checksum mismatch (expected $expected, got $actual)"
  fi
  [ -n "$actual" ] && printf 'mail-use-install: checksum ok\n'
fi

tar -xzf "$tmp/$asset" -C "$tmp"
# Legacy archives contain a binary named "mailbox".
[ -f "$tmp/mail-use" ] || [ ! -f "$tmp/mailbox" ] || mv "$tmp/mailbox" "$tmp/mail-use"
[ -f "$tmp/mail-use" ] || err "archive did not contain a 'mail-use' binary"

mkdir -p "$INSTALL_DIR"
mv "$tmp/mail-use" "$INSTALL_DIR/mail-use"
chmod +x "$INSTALL_DIR/mail-use"

# Keep the old command name working for anyone with `mailbox ...` in scripts/skills.
ln -sf "$INSTALL_DIR/mail-use" "$INSTALL_DIR/mailbox" 2>/dev/null || true

printf 'mail-use-install: installed to %s/mail-use (legacy alias: %s/mailbox)\n' "$INSTALL_DIR" "$INSTALL_DIR"
"$INSTALL_DIR/mail-use" --version >/dev/null 2>&1 && \
  printf 'mail-use-install: version %s\n' "$("$INSTALL_DIR/mail-use" --version 2>/dev/null)" || true

# --- daemon ------------------------------------------------------------------
# Without the daemon every call pays 1-3s of TCP+TLS+IMAP LOGIN, which is the
# difference between 25s and 0.83s over five calls — and with several agent
# sessions on one machine that cost is paid over and over. The daemon is one
# shared process per user (~0.15% CPU and a few MB when idle), so it lowers the
# total footprint rather than adding to it.
#
# Only set it up when accounts are already configured: a daemon with no auth.json
# has nothing to connect to, and installing a login item for a tool the user has
# not finished setting up is presumptuous.
setup_daemon() {
  [ -z "${MAIL_USE_NO_DAEMON:-}" ] || return 0

  cfg_dir="${MAILBOX_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/mailbox}"
  if [ ! -f "$cfg_dir/auth.json" ]; then
    printf 'mail-use-install: no accounts configured yet — skipping daemon setup.\n'
    printf '  after adding %s/auth.json, run:  mail-use daemon install\n' "$cfg_dir"
    return 0
  fi

  printf 'mail-use-install: setting up the background daemon (5-30x faster calls)...\n'
  if "$INSTALL_DIR/mail-use" daemon install >/dev/null 2>&1; then
    printf 'mail-use-install: daemon installed (mail-use daemon status --json to check)\n'
  else
    printf 'mail-use-install: daemon setup failed — the CLI still works, just slower.\n'
    printf '  retry with:  mail-use daemon install\n'
  fi
}
setup_daemon

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *) printf 'mail-use-install: NOTE — add %s to your PATH:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" ;;
esac
