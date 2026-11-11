#!/usr/bin/env bash
# homeactions PreToolUse guard (Claude Code plugin hook; matcher "Bash").
#
# Reads the hook JSON on stdin, takes tool_input.command, and DENIES any command that would run a privileged
# step: sudo/su/doas/pkexec, system launchd or systemd changes, the firewall, user/group changes, file
# flags and ACLs, writes under /etc or /Library, or running an owner script for real. The same strings are
# caught when wrapped in ssh host '...', sh -c, bash -c, env, command, /usr/bin/..., xargs, find -exec,
# eval, $(...), heredocs or pipes into a shell, and after ; && || |.
# Look-alikes are allowed: grep sudo FILE, man sudo, echo "run sudo ..." >> owner-steps.md, a heredoc
# written to a file, cat of a script, and owner scripts with --dry-run / verify.
#
# A deny is printed as PreToolUse JSON (permissionDecision "deny") with a reason that tells the agent to
# hand the step to the machine owner. Anything else exits 0 silently (normal permission flow continues).
# The analyser is guard-privileged.awk (POSIX awk). jq is used when present; otherwise a built-in JSON
# string decoder (HOMEACTIONS_GUARD_NO_JQ=1 forces it, for tests). Bash 3.2 compatible.
#
# Limits (README, references/threat-model.md): disableAllHooks turns this off; a script file run with
# `bash file.sh` is not opened. The real boundary is that privileged work exists only in owner scripts.

set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
awkfile="$here/guard-privileged.awk"
input="$(cat)"

tool=""
cmd=""
parsed=0
if [ -z "${HOMEACTIONS_GUARD_NO_JQ:-}" ] && command -v jq >/dev/null 2>&1; then
  if tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)" &&
     cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"; then
    parsed=1
  fi
fi
if [ "$parsed" -eq 0 ] && [ -r "$awkfile" ]; then
  decoded="$(HA_MODE=json HA_JSON="$input" awk -f "$awkfile" </dev/null 2>/dev/null)"
  tool="${decoded%%$'\n'*}"
  case "$decoded" in
    *$'\n'*) cmd="${decoded#*$'\n'}" ;;
    *) cmd="" ;;
  esac
fi

if [ -n "$tool" ] && [ "$tool" != "Bash" ]; then exit 0; fi
if [ -z "$cmd" ]; then exit 0; fi

verdict=""
if [ -r "$awkfile" ]; then
  verdict="$(HA_MODE=analyse HA_CMD="$cmd" HA_UID="$(id -u)" awk -f "$awkfile" </dev/null 2>/dev/null)" || verdict=""
fi
if [ -z "$verdict" ]; then
  # The analyser is missing or failed: fall back to a deny-biased whole-word scan.
  if grep -Eq '(^|[^A-Za-z0-9_.-])(sudo|doas|pkexec|run0|su|pfctl|nft|iptables|dscl|sysadminctl|dseditgroup|useradd|usermod|chflags|chattr)([^A-Za-z0-9_-]|$)' <<<"$cmd"; then
    verdict="DENY	a privileged command word (the guard's analyser was unavailable)"
  else
    verdict="ALLOW"
  fi
fi

case "$verdict" in
  DENY*) ;;
  *) exit 0 ;;
esac

why="${verdict#DENY	}"
why="$(printf '%s' "$why" | tr -d '\000-\037' | sed -e 's/\\/\//g' -e "s/\"/'/g")"
reason="homeactions guard: blocked a privileged command (${why}). The agent never runs privileged steps, directly or wrapped in ssh, sh -c, env or xargs. Hand this step to the machine owner: write the exact command into the owner checklist (skills/homeactions/references/owner-checklist.md), ask them to run it in their own terminal, and continue with read-only checks once they confirm it ran."
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
exit 0
