#!/usr/bin/env bash
set -euo pipefail

main() {
  action=${1:-install}
  case "$action" in
    install|uninstall) ;;
    *) echo 'Usage: install.sh [install|uninstall]' >&2; exit 1 ;;
  esac

  if [[ -z "${CODEX_HUD_SHELL:-}" ]]; then
    parent_comm=''
    if [[ -n "${PPID:-}" && -r "/proc/$PPID/comm" ]]; then
      parent_comm=$(<"/proc/$PPID/comm") || parent_comm=''
    elif [[ -n "${PPID:-}" ]] && command -v ps >/dev/null 2>&1; then
      parent_comm=$(ps -p "$PPID" -o comm= 2>/dev/null) || parent_comm=''
    fi
    parent_comm="${parent_comm#"${parent_comm%%[![:space:]]*}"}"
    parent_comm="${parent_comm%"${parent_comm##*[![:space:]]}"}"
    parent_comm="${parent_comm#-}"
    parent_comm="${parent_comm##*/}"
    parent_comm="${parent_comm#-}"
    case "$parent_comm" in
      bash|bash[-0-9.]*|rbash) export CODEX_HUD_SHELL=bash ;;
      zsh|zsh[-0-9.]*) export CODEX_HUD_SHELL=zsh ;;
    esac
  fi

  if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(process.versions.node.split(".")[0] < 22 ? 1 : 0)'; then
    echo 'codex-hud: Node.js 22 or newer is required on PATH.' >&2
    exit 1
  fi
  for tool in curl unzip mktemp rm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "codex-hud: $tool is required on PATH." >&2
      exit 1
    fi
  done
  if [[ "$action" == install ]] && ! command -v codex >/dev/null 2>&1; then
    echo 'codex-hud: Codex CLI is required on PATH.' >&2
    exit 1
  fi

  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-hud.XXXXXXXX")
  trap 'rm -rf -- "$temp_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  archive="$temp_dir/codex-hud.zip"
  curl -fsSL --proto-redir '=https' --retry 3 --retry-connrefused --retry-max-time 30 \
    --connect-timeout 10 --max-time 60 'https://github.com/yuwenlong/codex-hud/releases/latest/download/codex-hud.zip' -o "$archive"
  unzip -q "$archive" -d "$temp_dir/package"
  manager="$temp_dir/package/codex-hud/scripts/manage.mjs"
  if [[ ! -f "$manager" ]]; then
    echo 'codex-hud: The release ZIP does not contain the installer.' >&2
    exit 1
  fi
  node "$manager" "$action"
}

main "$@"
