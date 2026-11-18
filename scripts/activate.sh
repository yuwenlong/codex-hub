#!/usr/bin/env bash

if [ -n "${BASH_VERSION-}${ZSH_VERSION-}" ] && [ "${CODEX_HUB_SHELL-}" != none ]; then
  case $- in
    *i*)
      # A separate shell isolates inherited variable attributes and discards failed output.
      eval "$(
        command env "CODEX_HUB_SHELL=${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}" "ZDOTDIR=${ZDOTDIR-}" \
          /bin/sh -c '
            if codex_hub_activation=$(command node "$1" activate); then
              printf "%s\n" "$codex_hub_activation"
            else
              printf "false\n"
            fi
          ' codex-hub "${CODEX_HOME:-$HOME/.codex}/codex-hub/lib/shell.mjs" || printf 'false\n'
      )"
      ;;
  esac
fi
