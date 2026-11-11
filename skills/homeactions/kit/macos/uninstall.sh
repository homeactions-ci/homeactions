#!/bin/bash
# homeactions macOS uninstaller for tenant {{tenant.name}} (user {{tenant.user}}, uid {{tenant.uid}}).
#
#   bash uninstall.sh [--dry-run]
#
# The exact reversal of provision.sh: boots out the runner and firewall daemons, deregisters the
# runner (hidden remove-token prompt, or instructions for the GitHub UI), unloads the pf anchor and
# releases pf's enable reference, removes every deny-ACE with the identical string it was added with,
# clears the immutable flags, deletes the user and group, removes every root-owned file, then asserts
# nothing of the tenant remains. Flip your workflows back to hosted runners first.
# --dry-run prints every privileged command and executes nothing. Safe to re-run. Bash 3.2.
set -euo pipefail

T_NAME='{{tenant.name}}'
T_USER='{{tenant.user}}'
T_GROUP='{{tenant.group}}'
T_UID='{{tenant.uid}}'
T_HOME='{{tenant.home}}'
ROOT_DIR='{{tenant.rootDir}}'
LABEL_PREFIX='{{tenant.labelPrefix}}'
RUNNER_NAME='{{tenant.runnerName}}'
REPO_SLUG='{{repo.slug}}'
RUNNER_DIR='{{derived.runnerDir}}'
CONF_FILE='{{derived.confFile}}'
DAEMON_LABEL='{{derived.daemonLabel}}'
FIREWALL_LABEL='{{derived.firewallLabel}}'
PF_ANCHOR='{{derived.pfAnchor}}'
PF_ANCHOR_FILE='{{derived.pfAnchorFile}}'
OTHER_ADMINS='{{join derived.otherAdmins " "}}'
BANNER='{{derived.banner}}'

DAEMON_PLIST="/Library/LaunchDaemons/${DAEMON_LABEL}.plist"
FIREWALL_PLIST="/Library/LaunchDaemons/${FIREWALL_LABEL}.plist"
PF_LOADER="${ROOT_DIR}/pf-load.sh"
PF_LOG="${ROOT_DIR}/pf-load.log"
PF_TOKEN_FILE="/var/run/${LABEL_PREFIX}.pf.token"
REPO_URL="https://github.com/${REPO_SLUG}"
# Identical to the string provision.sh added with chmod +a.
ACE="user:${T_USER} deny list,search,readattr,readextattr,readsecurity"
TENANT_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

DRY=0
LEFT=0

say() { printf '%s %s\n' "$BANNER" "$*"; }
warn() { printf '%s WARN: %s\n' "$BANNER" "$*" >&2; }
die() {
  printf '%s ERROR: %s\n' "$BANNER" "$*" >&2
  exit 1
}
q() {
  local s="$1" out=""
  case "$s" in
    '')
      printf "''"
      return
      ;;
    *[!A-Za-z0-9_./:=@%+,-]*) ;;
    *)
      printf '%s' "$s"
      return
      ;;
  esac
  while :; do
    case "$s" in
      *\'*)
        out="${out}${s%%\'*}'\\''"
        s="${s#*\'}"
        ;;
      *) break ;;
    esac
  done
  printf "'%s'" "${out}${s}"
}
show() {
  local out="" a
  for a in "$@"; do out="${out} $(q "$a")"; done
  printf '+%s\n' "$out"
}
run() {
  show "$@"
  [ "$DRY" = 1 ] || "$@"
}
priv() { run sudo "$@"; }
sudo_q() { sudo "$@"; }
tenant_argv() {
  printf '%s\n' sudo -H -u "$T_USER" env -i "HOME=${T_HOME}" "USER=${T_USER}" "LOGNAME=${T_USER}" \
    SHELL=/bin/bash LANG=en_US.UTF-8 "PATH=${TENANT_PATH}"
}
tenant_q() {
  local argv=() l
  while IFS= read -r l; do argv+=("$l"); done < <(tenant_argv)
  "${argv[@]}" "$@"
}
skip_if() {
  local t=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    t+=("$1")
    shift
  done
  shift
  if [ "$DRY" = 1 ]; then
    "$@"
    printf '    (skipped when: %s)\n' "${t[*]}"
  elif "${t[@]}"; then
    say "nothing to do, skipping: $(show "$@")"
  else
    "$@"
  fi
}
# gone "<what>" <test…>: final assertion that something of the tenant no longer exists.
gone() {
  local what="$1"
  shift
  if [ "$DRY" = 1 ]; then
    printf '? assert gone: %s\n' "$what"
  elif "$@"; then
    say "gone: ${what}"
  else
    warn "STILL PRESENT: ${what}"
    LEFT=$((LEFT + 1))
  fi
}

admin_home() {
  local h=""
  if [ "$DRY" = 0 ]; then h="$(dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | awk '{ print $2 }')" || h=""; fi
  printf '%s\n' "${h:-/Users/$1}"
}
under() { case "$1/" in "$2"/*) return 0 ;; esac; return 1; }

refuse_unsafe() {
  local groups a
  [ "$(id -u)" != 0 ] || die "do not run this as root (or with sudo): run it as the machine owner; it calls sudo itself"
  [ "$(id -un)" != "$T_USER" ] || die "do not run this as the tenant user ${T_USER}"
  [ "$T_USER" != root ] && [ "$T_UID" != 0 ] || die "the tenant user must never be root"
  for a in $OTHER_ADMINS; do
    [ "$a" != "$T_USER" ] || die "tenant user ${T_USER} is listed in host.otherAdmins: refusing to delete an admin"
  done
  if groups="$(id -Gn "$T_USER" 2>/dev/null)"; then
    case " $groups " in
      *" admin "* | *" wheel "*) die "user ${T_USER} is an administrator: this is not a homeactions tenant; refusing to delete it" ;;
    esac
  fi
  case "$T_HOME" in /Users/?*) ;; *) die "tenant.home ${T_HOME} is not under /Users" ;; esac
  [ "$T_HOME" != "${HOME:-/nonexistent}" ] && ! under "${HOME:-/nonexistent}" "$T_HOME" || die "tenant.home contains your own home"
  for a in $OTHER_ADMINS; do
    [ "$T_HOME" != "$(admin_home "$a")" ] || die "tenant.home is ${a}'s home"
  done
  case "$ROOT_DIR" in /Library/?* | /opt/?* | /etc/?*) ;; *) die "tenant.rootDir ${ROOT_DIR} is not a dedicated directory" ;; esac
  case "$ROOT_DIR" in /Library/LaunchDaemons | /Library/LaunchAgents | /Library/Preferences | /etc/pf.anchors | /opt/homebrew | /etc/ssh | /etc/sudoers.d) die "tenant.rootDir ${ROOT_DIR} is a system directory" ;; esac
}

user_exists() { dscl . -read "/Users/$T_USER" UniqueID >/dev/null 2>&1; }
no_user() { ! user_exists; }
no_group() { ! dscl . -read "/Groups/$T_GROUP" PrimaryGroupID >/dev/null 2>&1; }
loaded() { sudo_q launchctl print "system/$1" >/dev/null 2>&1; }
not_loaded() { ! loaded "$1"; }
absent() { ! sudo_q test -e "$1"; }
no_ace() { ! sudo_q /bin/ls -led "$1" 2>/dev/null | grep -F -c "$ACE" >/dev/null; }
no_ace_left() { ! sudo_q /bin/ls -led "$1" 2>/dev/null | grep -F -c "user:${T_USER} " >/dev/null; }
anchor_empty() { [ -z "$(sudo_q pfctl -a "$PF_ANCHOR" -s rules 2>/dev/null)" ]; }
tenant_procs() {
  ps -axo uid=,pid=,comm= | awk -v u="$T_UID" '$1 == u && $3 !~ "^/(System|usr/libexec|usr/sbin|Library/Apple)/" { print $2 }'
}
no_procs() { [ -z "$(ps -axo uid= | awk -v u="$T_UID" '$1 == u')" ]; }
root_dir_ours() { [ ! -e "$ROOT_DIR" ] || [ -f "$CONF_FILE" ] || [ -z "$(ls -A "$ROOT_DIR" 2>/dev/null)" ]; }

kill_tenant() {
  local waited=0
  if [ "$DRY" = 1 ]; then
    show sudo pkill -KILL -u "$T_UID"
    printf '    (repeated until no %s process is left, at most 30 s)\n' "$T_USER"
    return 0
  fi
  user_exists || return 0
  while :; do
    sudo_q pkill -KILL -u "$T_UID" >/dev/null 2>&1 || true
    [ -n "$(tenant_procs)" ] || break
    [ "$waited" -lt 30 ] || die "processes of ${T_USER} survived SIGKILL for 30 s: $(tenant_procs | tr '\n' ' ')"
    sleep 1
    waited=$((waited + 1))
  done
}

deregister() {
  local token rc
  say "2/7 deregister ${RUNNER_NAME} from ${REPO_SLUG}"
  if [ "$DRY" = 1 ]; then
    printf '%s\n' "+ IFS= read -rs token   # hidden prompt: a remove token from ${REPO_URL}/settings/actions/runners (empty = remove it in the UI)"
    printf '%s\n' "+ printf '%s\\n' \"\$token\" | $(tenant_argv | while IFS= read -r l; do printf '%s ' "$(q "$l")"; done)/bin/bash --noprofile --norc -c 'IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN; cd \"\$1\"; exec ./config.sh remove' homeactions-remove $(q "$RUNNER_DIR")"
    return 0
  fi
  if ! user_exists || ! sudo_q test -f "$RUNNER_DIR/.runner"; then
    say "no registered runner on this machine; if ${RUNNER_NAME} still shows at ${REPO_URL}/settings/actions/runners, remove it there"
    return 0
  fi
  kill_tenant
  printf 'Paste a runner REMOVE token from %s/settings/actions/runners (hidden; Enter alone = remove it in the UI yourself): ' "$REPO_URL" >&2
  IFS= read -rs token
  printf '\n' >&2
  if [ -z "$token" ]; then
    say "skipped: remove ${RUNNER_NAME} at ${REPO_URL}/settings/actions/runners (… → Remove runner)"
    return 0
  fi
  case "$token" in *[!A-Za-z0-9_-]*) die "the token has unexpected characters; copy only the value" ;; esac
  rc=0
  printf '%s\n' "$token" | tenant_q /bin/bash --noprofile --norc -c '
    set -eu
    IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
    export ACTIONS_RUNNER_INPUT_TOKEN
    cd "$1"
    exec ./config.sh remove
  ' homeactions-remove "$RUNNER_DIR" || rc=$?
  token=""
  unset token
  if [ "$rc" != 0 ]; then warn "config.sh remove failed (exit ${rc}); remove ${RUNNER_NAME} at ${REPO_URL}/settings/actions/runners"; fi
}

main() {
  local a ah tok reply
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      -h | --help)
        sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  refuse_unsafe
  if [ "$(uname -s)" != Darwin ]; then
    if [ "$DRY" = 1 ]; then warn "this is the macOS uninstaller and this host is $(uname -s); printing the plan only"; else die "this is the macOS uninstaller"; fi
  fi
  say "uninstall tenant ${T_NAME}$([ "$DRY" = 1 ] && echo ' — DRY RUN, nothing is executed')"
  if [ "$DRY" = 0 ]; then
    root_dir_ours || die "${ROOT_DIR} has files but no ${CONF_FILE}: not ours, refusing to remove it"
    printf 'This deletes user %s, its home %s and everything homeactions installed for it. Type %s to continue: ' "$T_USER" "$T_HOME" "$T_USER" >&2
    IFS= read -r reply
    [ "$reply" = "$T_USER" ] || die "not confirmed"
  fi
  run sudo -v

  say "1/7 stop the runner and firewall daemons"
  skip_if not_loaded "$DAEMON_LABEL" -- priv launchctl bootout "system/${DAEMON_LABEL}"
  skip_if not_loaded "$FIREWALL_LABEL" -- priv launchctl bootout "system/${FIREWALL_LABEL}"

  deregister

  say "3/7 pf: flush the anchor and release the enable reference"
  skip_if anchor_empty -- priv pfctl -a "$PF_ANCHOR" -F all
  if [ "$DRY" = 1 ]; then
    show sudo pfctl -X "<the reference token read from ${PF_TOKEN_FILE}>"
    printf '    (only when %s exists)\n' "$PF_TOKEN_FILE"
  elif sudo_q test -s "$PF_TOKEN_FILE"; then
    tok="$(sudo_q cat "$PF_TOKEN_FILE")"
    priv pfctl -X "$tok" || warn "pfctl -X refused the saved reference (stale after a reboot?); continuing"
  fi
  priv rm -f "$PF_TOKEN_FILE"

  say "4/7 remove the deny-ACEs (before the user is deleted, while its name still resolves)"
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    if [ "$DRY" = 0 ] && [ ! -d "$ah" ]; then continue; fi
    skip_if no_ace "$ah" -- priv chmod -a "$ACE" "$ah"
    gone "ACE for ${T_USER} on ${ah}" no_ace_left "$ah"
  done

  say "5/7 delete the user, its home and its group"
  kill_tenant
  skip_if absent "$RUNNER_DIR" -- priv chflags -R nouchg "$RUNNER_DIR"
  skip_if no_user -- priv sysadminctl -deleteUser "$T_USER"
  skip_if absent "$T_HOME" -- priv rm -rf "$T_HOME"
  skip_if no_group -- priv dseditgroup -o delete "$T_GROUP"

  say "6/7 remove the root-owned files"
  priv rm -f "$DAEMON_PLIST" "$FIREWALL_PLIST" "$PF_ANCHOR_FILE" "$PF_LOADER" "$PF_LOG"
  priv rm -rf "$ROOT_DIR"

  say "7/7 assert nothing of ${T_USER} remains"
  gone "user ${T_USER}" no_user
  gone "group ${T_GROUP}" no_group
  gone "home ${T_HOME}" absent "$T_HOME"
  gone "${ROOT_DIR}" absent "$ROOT_DIR"
  gone "${DAEMON_PLIST}" absent "$DAEMON_PLIST"
  gone "${FIREWALL_PLIST}" absent "$FIREWALL_PLIST"
  gone "${PF_ANCHOR_FILE}" absent "$PF_ANCHOR_FILE"
  gone "${PF_TOKEN_FILE}" absent "$PF_TOKEN_FILE"
  gone "daemon ${DAEMON_LABEL}" not_loaded "$DAEMON_LABEL"
  gone "daemon ${FIREWALL_LABEL}" not_loaded "$FIREWALL_LABEL"
  gone "pf rules in ${PF_ANCHOR}" anchor_empty
  gone "processes of uid ${T_UID}" no_procs
  if [ "$LEFT" -gt 0 ]; then die "${LEFT} item(s) of ${T_USER} remain (listed above)"; fi
  say "uninstalled: nothing of ${T_USER} remains. pf stays enabled only if another component holds its own reference."
}

main "$@"
