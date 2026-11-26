#!/usr/bin/env bash

if [ -n "${BASH_VERSION-}${ZSH_VERSION-}" ] && [ "${AGY_HUD_SHELL-}" != none ]; then
  case $- in
    *i*)
      agy_hud_shell_js="${AGY_HUD_DATA_DIR:-${HOME-}/.gemini/antigravity-cli}/agy-hud-runtime/runtime/shell.mjs"
      if [ -z "${AGY_HUD_DATA_DIR-}" ] && [ ! -f "$agy_hud_shell_js" ] && [ -n "${XDG_DATA_HOME-}" ]; then
        agy_hud_shell_js="${XDG_DATA_HOME}/antigravity-cli/agy-hud-runtime/runtime/shell.mjs"
      fi
      if [ -f "$agy_hud_shell_js" ] && command -v node >/dev/null 2>&1; then
        # A separate shell isolates inherited variable attributes and discards failed output.
        eval "$(
          command env "AGY_HUD_SHELL=${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}" "ZDOTDIR=${ZDOTDIR-}" \
            /bin/sh -c '
              if agy_hud_activation=$(command node "$1" activate); then
                printf "%s\n" "$agy_hud_activation"
              else
                printf "false\n"
              fi
            ' agy-hud "$agy_hud_shell_js" || printf 'false\n'
        )"
      fi
      unset agy_hud_shell_js
      ;;
  esac
fi
