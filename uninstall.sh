#!/usr/bin/env bash
set -euo pipefail

codex_home=${CODEX_HOME:-~/.codex}
runtime="$codex_home/codex-hub"
manager="$runtime/scripts/manage.mjs"
marker="$runtime/.codex-hub-managed"
backup="$codex_home/codex-hub-statusline.json"
transaction="$codex_home/.codex-hub-transaction.json"
pending=false
manifest=''
if [[ -e "$transaction" || -L "$transaction" ]]; then
  pending=true
elif [[ ! -L "$runtime" && -f "$marker" && ! -L "$marker" ]]; then
  manifest=$(<"$marker")
fi

has_local_runtime() {
  [[ "$manifest" == codex-hub-runtime-v1$'\n'* && "$manifest"$'\n' == *$'\nscripts/manage.mjs\n'* &&
     ! -L "$runtime/scripts" && -f "$manager" && ! -L "$manager" ]] || return 1
  # The manager loads configuration modules even without a backup.
  [[ -d "$runtime/bin" && ! -L "$runtime/bin" && -d "$runtime/lib" && ! -L "$runtime/lib" ]] || return 1
  local file
  for file in bin/codex-hub.mjs package.json lib/app-server.mjs lib/installation.mjs; do
    [[ -f "$runtime/$file" && ! -L "$runtime/$file" ]] || return 1
  done
}

if has_local_runtime; then
  if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(process.versions.node.split(".")[0] < 22 ? 1 : 0)'; then
    echo 'codex-hub: Node.js 22 or newer is required on PATH.' >&2
    exit 1
  fi
  exec node "$manager" uninstall
fi

if [[ "$pending" == true || -e "$backup" || "$manifest" == codex-hub-runtime-v1$'\n'* ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo 'codex-hub: curl is required on PATH.' >&2
    exit 1
  fi
  bootstrap=$(curl -fsSL --proto-redir '=https' 'https://raw.githubusercontent.com/yuwenlong/codex-hub/main/scripts/install.sh')
  if [[ ! "$bootstrap" =~ [^[:space:]] ]]; then
    echo 'codex-hub: The downloaded installer is empty.' >&2
    exit 1
  fi
  exec bash -c "$bootstrap" codex-hub uninstall
fi

echo 'codex-hub: No installation to remove.'
