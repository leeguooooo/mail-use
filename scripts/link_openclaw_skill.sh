#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
SRC="${REPO_ROOT}/skills/mail-use"
DEST_DIR="${HOME}/.openclaw/skills"
DEST="${DEST_DIR}/mail-use"

force=0
if [[ "${1:-}" == "--force" ]]; then
  force=1
fi

if [[ ! -d "${SRC}" ]]; then
  echo "mail-use skill not found at: ${SRC}" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"

if [[ -e "${DEST}" ]]; then
  if [[ -L "${DEST}" ]]; then
    current=$(readlink "${DEST}" || true)
    if [[ "${current}" == "${SRC}" ]]; then
      echo "Already linked: ${DEST} -> ${SRC}"
      exit 0
    fi
  fi
  if [[ "${force}" -eq 1 ]]; then
    rm -rf "${DEST}"
  else
    echo "Destination exists: ${DEST}" >&2
    echo "Use --force to replace it." >&2
    exit 2
  fi
fi

ln -s "${SRC}" "${DEST}"
echo "Linked ${DEST} -> ${SRC}"
echo "Verify with: openclaw skills list --eligible"
