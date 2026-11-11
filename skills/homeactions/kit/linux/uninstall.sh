#!/bin/bash
# homeactions Linux uninstaller (BETA) for tenant {{tenant.name}} (user {{tenant.user}}, uid {{tenant.uid}}).
#
#   bash uninstall.sh [--dry-run]
#
# The exact reversal of provision.sh: stops and disables the runner and firewall units, deregisters
# the runner (hidden remove-token prompt, or instructions for the GitHub UI), deletes the nftables
# table, removes every ACL entry with the identical spec it was added with, clears the immutable
# attributes, deletes the user, home and group, removes every root-owned file, then asserts nothing of
# the tenant remains. Distro packages installed for services are left installed (others may use
# them); the command to remove them is printed. Flip your workflows back to hosted runners first.
# --dry-run prints every privileged command and executes nothing. Safe to re-run. Bash 3.2 compatible.
set -euo pipefail

T_NAME='{{tenant.name}}'
T_USER='{{tenant.user}}'
T_GROUP='{{tenant.group}}'
T_UID='{{tenant.uid}}'
T_HOME='{{tenant.home}}'
ROOT_DIR='{{tenant.rootDir}}'
RUNNER_NAME='{{tenant.runnerName}}'
REPO_SLUG='{{repo.slug}}'
RUNNER_DIR='{{derived.runnerDir}}'
CONF_FILE='{{derived.confFile}}'
DAEMON_LABEL='{{derived.daemonLabel}}'
FIREWALL_LABEL='{{derived.firewallLabel}}'
NFT_TABLE='{{derived.nftTable}}'
OTHER_ADMINS='{{join derived.otherAdmins " "}}'
BANNER='{{derived.banner}}'

RUNNER_UNIT="${DAEMON_LABEL}.service"
FIREWALL_UNIT="${FIREWALL_LABEL}.service"
RUNNER_UNIT_FILE="/etc/systemd/system/${RUNNER_UNIT}"
FIREWALL_UNIT_FILE="/etc/systemd/system/${FIREWALL_UNIT}"
NFT_RULES="${ROOT_DIR}/tenant.nft"
NFT_LOADER="${ROOT_DIR}/nft-load.sh"
REPO_URL="https://github.com/${REPO_SLUG}"
# Identical to the entry provision.sh added with setfacl -m.
ACL_ENTRY="u:${T_USER}:---"
ACL_REMOVE="u:${T_USER}"
TENANT_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

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
    SHELL=/bin/bash LANG=C.UTF-8 "PATH=${TENANT_PATH}"
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
  if [ "$DRY" = 0 ]; then h="$(getent passwd "$1" 2>/dev/null | cut -d: -f6)" || h=""; fi
  printf '%s\n' "${h:-/home/$1}"
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
      *" sudo "* | *" wheel "* | *" admin "* | *" adm "*) die "user ${T_USER} is privileged (groups: ${groups}): not a homeactions tenant; refusing to delete it" ;;
    esac
  fi
  case "$T_HOME" in /home/?* | /var/lib/?*) ;; *) die "tenant.home ${T_HOME} is not under /home or /var/lib" ;; esac
  [ "$T_HOME" != "${HOME:-/nonexistent}" ] && ! under "${HOME:-/nonexistent}" "$T_HOME" || die "tenant.home contains your own home"
  for a in $OTHER_ADMINS; do
    [ "$T_HOME" != "$(admin_home "$a")" ] || die "tenant.home is ${a}'s home"
  done
  case "$ROOT_DIR" in /opt/?* | /etc/?*) ;; *) die "tenant.rootDir ${ROOT_DIR} is not a dedicated directory" ;; esac
  case "$ROOT_DIR" in /etc/systemd | /etc/ssh | /etc/sudoers.d | /etc/nftables.d | /etc/pam.d | /etc/security | /etc/default) die "tenant.rootDir ${ROOT_DIR} is a system directory" ;; esac
}

user_exists() { getent passwd "$T_USER" >/dev/null 2>&1; }
no_user() { ! user_exists; }
no_group() { ! getent group "$T_GROUP" >/dev/null 2>&1; }
absent() { ! sudo_q test -e "$1"; }
unit_inactive() { ! systemctl is-active --quiet "$1" 2>/dev/null && ! systemctl is-enabled --quiet "$1" 2>/dev/null; }
no_table() { ! sudo_q nft list table inet "$NFT_TABLE" >/dev/null 2>&1; }
no_acl() { ! sudo_q getfacl -p "$1" 2>/dev/null | grep -F -c "user:${T_USER}:" >/dev/null; }
no_procs() { [ -z "$(pgrep -u "$T_UID" 2>/dev/null || true)" ]; }
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
    no_procs && break
    [ "$waited" -lt 30 ] || die "processes of ${T_USER} survived SIGKILL for 30 s"
    sleep 1
    waited=$((waited + 1))
  done
}

unfreeze() { priv chattr -i "$1" || warn "chattr -i failed on $1 (no immutable attribute support?); continuing"; }

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
  local a ah reply f
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      -h | --help)
        sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
        exit 2
        ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  refuse_unsafe
  if [ "$(uname -s)" != Linux ]; then
    if [ "$DRY" = 1 ]; then warn "this is the Linux uninstaller and this host is $(uname -s); printing the plan only"; else die "this is the Linux uninstaller"; fi
  fi
  say "uninstall tenant ${T_NAME} (Linux BETA)$([ "$DRY" = 1 ] && echo ' — DRY RUN, nothing is executed')"
  if [ "$DRY" = 0 ]; then
    root_dir_ours || die "${ROOT_DIR} has files but no ${CONF_FILE}: not ours, refusing to remove it"
    printf 'This deletes user %s, its home %s and everything homeactions installed for it. Type %s to continue: ' "$T_USER" "$T_HOME" "$T_USER" >&2
    IFS= read -r reply
    [ "$reply" = "$T_USER" ] || die "not confirmed"
  fi
  run sudo -v

  say "1/7 stop and disable the runner and firewall units"
  skip_if unit_inactive "$RUNNER_UNIT" -- priv systemctl disable --now "$RUNNER_UNIT"
  skip_if unit_inactive "$FIREWALL_UNIT" -- priv systemctl disable --now "$FIREWALL_UNIT"

  deregister

  say "3/7 nftables: delete table inet ${NFT_TABLE}"
  skip_if no_table -- priv nft delete table inet "$NFT_TABLE"

  say "4/7 remove the ACL entries (before the user is deleted, while its name still resolves)"
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    if [ "$DRY" = 0 ] && [ ! -d "$ah" ]; then continue; fi
    skip_if no_acl "$ah" -- priv setfacl -x "$ACL_REMOVE" "$ah"
    gone "ACL entry ${ACL_ENTRY} on ${ah}" no_acl "$ah"
  done

  say "5/7 delete the user, its home and its group"
  kill_tenant
  for f in "$RUNNER_DIR/.env" "$RUNNER_DIR/.path"; do
    skip_if absent "$f" -- unfreeze "$f"
  done
  skip_if no_user -- priv userdel --remove "$T_USER"
  skip_if absent "$T_HOME" -- priv rm -rf "$T_HOME"
  skip_if no_group -- priv groupdel "$T_GROUP"

  say "6/7 remove the root-owned files"
  priv rm -f "$RUNNER_UNIT_FILE" "$FIREWALL_UNIT_FILE" "$NFT_RULES" "$NFT_LOADER"
  priv rm -rf "$ROOT_DIR"
  priv systemctl daemon-reload
  say "packages installed for services (postgresql-*, redis-server) are left installed; remove them with apt-get remove / dnf remove if nothing else needs them"

  say "7/7 assert nothing of ${T_USER} remains"
  gone "user ${T_USER}" no_user
  gone "group ${T_GROUP}" no_group
  gone "home ${T_HOME}" absent "$T_HOME"
  gone "${ROOT_DIR}" absent "$ROOT_DIR"
  gone "${RUNNER_UNIT_FILE}" absent "$RUNNER_UNIT_FILE"
  gone "${FIREWALL_UNIT_FILE}" absent "$FIREWALL_UNIT_FILE"
  gone "unit ${RUNNER_UNIT}" unit_inactive "$RUNNER_UNIT"
  gone "unit ${FIREWALL_UNIT}" unit_inactive "$FIREWALL_UNIT"
  gone "table inet ${NFT_TABLE}" no_table
  gone "processes of uid ${T_UID}" no_procs
  if [ "$LEFT" -gt 0 ]; then die "${LEFT} item(s) of ${T_USER} remain (listed above)"; fi
  say "uninstalled: nothing of ${T_USER} remains"
}

main "$@"
