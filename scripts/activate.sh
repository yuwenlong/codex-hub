#!/usr/bin/env bash

if [ -n "${BASH_VERSION-}${ZSH_VERSION-}" ] && [ "${CODEX_HUD_SHELL-}" != none ]; then
  case $- in
    *i*)
      # A separate shell isolates inherited variable attributes and discards failed output.
      eval "$(
        command env "CODEX_HUD_SHELL=${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}" "ZDOTDIR=${ZDOTDIR-}" \
          /bin/sh -c '
            if codex_hud_activation=$(command node "$1" activate); then
              printf "%s\n" "$codex_hud_activation"
            else
              printf "false\n"
            fi
          ' codex-hud "${CODEX_HOME:-$HOME/.codex}/codex-hud/lib/shell.mjs" || printf 'false\n'
      )"
      ;;
  esac
fi
