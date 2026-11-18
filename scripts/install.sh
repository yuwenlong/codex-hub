#!/usr/bin/env bash
set -euo pipefail

action=${1:-install}
case "$action" in
  install|uninstall) ;;
  *) echo 'Usage: install.sh [install|uninstall]' >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(process.versions.node.split(".")[0] < 22 ? 1 : 0)'; then
  echo 'codex-hub: Node.js 22 or newer is required on PATH.' >&2
  exit 1
fi
for tool in curl unzip mktemp rm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "codex-hub: $tool is required on PATH." >&2
    exit 1
  fi
done
if [[ "$action" == install ]] && ! command -v codex >/dev/null 2>&1; then
  echo 'codex-hub: Codex CLI is required on PATH.' >&2
  exit 1
fi

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-hub.XXXXXXXX")
trap 'rm -rf -- "$temp_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
archive="$temp_dir/codex-hub.zip"
curl -fsSL --proto-redir '=https' 'https://github.com/yuwenlong/codex-hub/releases/latest/download/codex-hub.zip' -o "$archive"
unzip -q "$archive" -d "$temp_dir/package"
manager="$temp_dir/package/codex-hub/scripts/manage.mjs"
if [[ ! -f "$manager" ]]; then
  echo 'codex-hub: The release ZIP does not contain the installer.' >&2
  exit 1
fi
node "$manager" "$action"
