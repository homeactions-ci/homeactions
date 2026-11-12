#!/bin/bash
# homeactions macOS provisioner for tenant {{tenant.name}} (user {{tenant.user}}, uid {{tenant.uid}}).
#
#   bash provision.sh preflight            read-only checks; changes nothing, needs no sudo
#   bash provision.sh install   [--dry-run] user, group, home, deny-ACEs, root-owned hooks, services, runner tarball
#   bash provision.sh firewall  [--dry-run] pf anchor + loader LaunchDaemon (only when isolation.network)
#   bash provision.sh firewall-unload [--dry-run]
#   bash provision.sh register  [--dry-run] hidden token prompt, config.sh, root-owned .env/.path, LaunchDaemon
#   bash provision.sh verify               read-only checks the owner or an agent can run; no sudo
#
# Run it as the machine owner, in your own terminal, from the copied host/ directory, after
# `shasum -a 256 -c SHA256SUMS`. --dry-run prints every privileged command and executes nothing.
# Every step is idempotent: re-running after a failure or an upgrade redoes only what is missing.
# The registration token is read at a hidden prompt and reaches config.sh only as
# ACTIONS_RUNNER_INPUT_TOKEN on a pipe into `env -i bash --noprofile --norc`; never in argv or a file.
# Bash 3.2.
set -euo pipefail

# ── profile values (rendered; edit the profile and re-render, never this file) ──────────────────
T_NAME='{{tenant.name}}'
T_USER='{{tenant.user}}'
T_GROUP='{{tenant.group}}'
T_UID='{{tenant.uid}}'
T_GID='{{tenant.gid}}'
T_HOME='{{tenant.home}}'
ROOT_DIR='{{tenant.rootDir}}'
LABEL_PREFIX='{{tenant.labelPrefix}}'
RUNNER_NAME='{{tenant.runnerName}}'
RUNNER_LABELS='{{derived.runnerLabelsCsv}}'
REPO_SLUG='{{repo.slug}}'
RUNNER_VERSION='{{runner.version}}'
RUNNER_TARBALL='{{derived.runnerTarball}}'
RUNNER_SHA='{{derived.runnerSha}}'
RUNNER_DIR='{{derived.runnerDir}}'
TMP_DIR='{{derived.tmpDir}}'
CACHE_DIR='{{derived.cacheDir}}'
OPT_DIR='{{derived.optDir}}'
SRC_DIR='{{derived.srcDir}}'
STATE_DIR='{{derived.stateDir}}'
LOG_DIR='{{derived.logDir}}'
HOOKS_DIR='{{derived.hooksDir}}'
CONF_FILE='{{derived.confFile}}'
DAEMON_LABEL='{{derived.daemonLabel}}'
FIREWALL_LABEL='{{derived.firewallLabel}}'
PF_ANCHOR='{{derived.pfAnchor}}'
PF_ANCHOR_FILE='{{derived.pfAnchorFile}}'
NICE='{{caps.nice}}'
OPEN_FILES='{{caps.openFiles}}'
PORTS='{{derived.portsSpace}}'
PROBES='{{derived.probesSpace}}'
OTHER_ADMINS='{{join derived.otherAdmins " "}}'
NETWORK='{{#if isolation.network}}1{{else}}0{{/if}}'
HAS_POSTGRES='{{#if derived.hasPostgres}}1{{else}}0{{/if}}'
HAS_REDIS='{{#if derived.hasRedis}}1{{else}}0{{/if}}'
DISK_FLOOR_GB='{{diskFloorGb}}'
DISK_ENCRYPTION='{{host.diskEncryption}}'
BANNER='{{derived.banner}}'
KIT_VERSION='{{derived.kitVersion}}'

# ── names computed from the values above ───────────────────────────────────────────────────────
DAEMON_PLIST="/Library/LaunchDaemons/${DAEMON_LABEL}.plist"
FIREWALL_PLIST="/Library/LaunchDaemons/${FIREWALL_LABEL}.plist"
PF_LOADER="${ROOT_DIR}/pf-load.sh"
PF_LOG="${ROOT_DIR}/pf-load.log"
PF_TOKEN_FILE="/var/run/${LABEL_PREFIX}.pf.token"
REPO_URL="https://github.com/${REPO_SLUG}"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_TARBALL}"
TARBALL_PATH="${CACHE_DIR}/${RUNNER_TARBALL}"
TARBALL_MARKER="${RUNNER_DIR}/.homeactions-tarball-sha256"
# The deny-ACE put on every other admin's home. uninstall.sh removes this exact string with chmod -a.
ACE="user:${T_USER} deny list,search,readattr,readextattr,readsecurity"
# The vendor plist template names its placeholders with double braces; spelled in two halves here so
# the kit renderer never mistakes them for its own tags.
OB='{''{'
TENANT_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
PLISTBUDDY=/usr/libexec/PlistBuddy
KIT="$(cd "$(dirname "$0")" && pwd)"

DRY=0
FAILS=0

say() { printf '%s %s\n' "$BANNER" "$*"; }
warn() { printf '%s WARN: %s\n' "$BANNER" "$*" >&2; }
die() {
  printf '%s ERROR: %s\n' "$BANNER" "$*" >&2
  exit 1
}

# q <word>: the word as it would be typed in a shell (single-quoted when it needs to be).
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
# run <cmd…>: print it, then (unless --dry-run) execute it.
run() {
  show "$@"
  [ "$DRY" = 1 ] || "$@"
}
priv() { run sudo "$@"; }
# The tenant's command line: sudo as the tenant with a scrubbed environment (no owner variables cross).
tenant_argv() {
  printf '%s\n' sudo -H -u "$T_USER" env -i "HOME=${T_HOME}" "USER=${T_USER}" "LOGNAME=${T_USER}" \
    SHELL=/bin/bash LANG=en_US.UTF-8 "PATH=${TENANT_PATH}" "TMPDIR=${TMP_DIR}/"
}
as_tenant() {
  local argv=() l
  while IFS= read -r l; do argv+=("$l"); done < <(tenant_argv)
  show "${argv[@]}" "$@"
  # From /: the owner's kit folder is closed to the tenant (deny-ACE), and a shell that cannot read its
  # working directory prints getcwd errors on every step.
  [ "$DRY" = 1 ] || (cd / && "${argv[@]}" "$@")
}
# Quiet variants for checks: never printed, never run in --dry-run (check() returns before them).
sudo_q() { sudo "$@"; }
tenant_q() {
  local argv=() l
  while IFS= read -r l; do argv+=("$l"); done < <(tenant_argv)
  (cd / && "${argv[@]}" "$@")
}

# skip_if <test…> -- <cmd…>: idempotent step. Real run: skip when the test passes. Dry run: print.
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
    say "already in place, skipping: $(show "$@")"
  else
    "$@"
  fi
}
# check "<what>" <cmd…>: an assertion. Real run: die unless cmd succeeds. Dry run: print what is checked.
check() {
  local what="$1"
  shift
  if [ "$DRY" = 1 ]; then
    printf '? assert: %s\n' "$what"
    return 0
  fi
  if "$@"; then say "ok: $what"; else die "check failed: $what"; fi
}

# ── safety rules shared by every subcommand ───────────────────────────────────────────────────
is_sensitive_dir() {
  case "$1" in
    / | /Library | /Library/LaunchDaemons | /Library/LaunchAgents | /Library/Preferences | /Library/Apple | \
      /Library/Developer | /Library/Security | /Library/Keychains | /System* | /usr* | /bin* | /sbin* | \
      /etc | /etc/pf.anchors | /etc/ssh | /etc/sudoers.d | /private* | /opt | /opt/homebrew* | \
      /Users | /Users/Shared | /Applications*) return 0 ;;
  esac
  return 1
}
under() { case "$1/" in "$2"/*) return 0 ;; esac; return 1; }

admin_home() {
  local h=""
  if [ "$DRY" = 0 ]; then
    h="$(dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | awk '{ print $2 }')" || h=""
  fi
  printf '%s\n' "${h:-/Users/$1}"
}

refuse_unsafe() {
  local me groups a
  me="$(id -u)"
  [ "$me" != 0 ] || die "do not run this as root (or with sudo): run it as the machine owner; it calls sudo itself"
  [ "$(id -un)" != "$T_USER" ] || die "do not run this as the tenant user ${T_USER}: run it as the machine owner"
  [ "$T_USER" != root ] && [ "$T_UID" != 0 ] || die "the tenant user must never be root"
  for a in $OTHER_ADMINS; do
    [ "$a" != "$T_USER" ] || die "tenant user ${T_USER} is listed in host.otherAdmins: refusing to turn an admin into a CI tenant"
  done
  if groups="$(id -Gn "$T_USER" 2>/dev/null)"; then
    case " $groups " in
      *" admin "* | *" wheel "*) die "user ${T_USER} already exists and is an administrator: refusing (pick a new, dedicated user name)" ;;
    esac
  fi
  case "$T_HOME" in /Users/*) ;; *) die "tenant.home ${T_HOME} must be under /Users on macOS" ;; esac
  [ "$T_HOME" != "${HOME:-/nonexistent}" ] || die "tenant.home is your own home directory"
  under "${HOME:-/nonexistent}" "$T_HOME" && die "your home is inside tenant.home ${T_HOME}"
  under "$T_HOME" "${HOME:-/nonexistent}" && die "tenant.home ${T_HOME} is inside your home"
  for a in $OTHER_ADMINS; do
    local ah
    ah="$(admin_home "$a")"
    [ "$T_HOME" != "$ah" ] && ! under "$T_HOME" "$ah" || die "tenant.home ${T_HOME} is inside ${a}'s home ${ah}"
    ! under "$ROOT_DIR" "$ah" || die "tenant.rootDir ${ROOT_DIR} is inside ${a}'s home"
  done
  ! is_sensitive_dir "$ROOT_DIR" || die "tenant.rootDir ${ROOT_DIR} is a system or shared directory; choose a dedicated one such as /Library/<Name>CI"
  ! under "$ROOT_DIR" /opt/homebrew || die "tenant.rootDir must not be under /opt/homebrew"
  ! under "$ROOT_DIR" "$T_HOME" || die "tenant.rootDir must be outside the tenant home (it holds root-owned hooks)"
}

require_macos() {
  if [ "$(uname -s)" != Darwin ]; then
    if [ "$DRY" = 1 ]; then warn "this is the macOS provisioner and this host is $(uname -s); printing the plan only"; else die "this is the macOS provisioner; this host is $(uname -s)"; fi
  fi
}

need_kit_file() {
  if [ ! -f "$KIT/$1" ]; then
    if [ "$DRY" = 1 ]; then warn "kit file $1 is missing (the real run stops here)"; else die "kit file $KIT/$1 is missing: re-render and copy the whole host/ directory"; fi
  fi
}

# ── state probes (real runs only) ──────────────────────────────────────────────────────────────
user_exists() { dscl . -read "/Users/$T_USER" UniqueID >/dev/null 2>&1; }
group_exists() { dscl . -read "/Groups/$T_GROUP" PrimaryGroupID >/dev/null 2>&1; }
home_exists() { [ -d "$T_HOME" ]; }
has_ace() { sudo_q /bin/ls -led "$1" 2>/dev/null | grep -F -c "$ACE" >/dev/null; }
loaded() { sudo_q launchctl print "system/$1" >/dev/null 2>&1; }
not_loaded() { ! loaded "$1"; }
tarball_ok() { sudo_q test -f "$TARBALL_PATH" && [ "$(sudo_q shasum -a 256 "$TARBALL_PATH" | awk '{ print $1 }')" = "$RUNNER_SHA" ]; }
runner_extracted() { [ "$(sudo_q cat "$TARBALL_MARKER" 2>/dev/null || true)" = "$RUNNER_SHA" ] && sudo_q test -x "$RUNNER_DIR/config.sh"; }
dir_present() { sudo_q test -e "$1"; }
not_present() { ! sudo_q test -e "$1"; }
# dscl prints native attributes (IsHidden) as "dsAttrTypeNative:<key>: <value>" and standard ones as "<key>: <value>".
dscl_value() { dscl . -read "$1" "$2" 2>/dev/null | awk -v k="$2:" '{ f = $1; sub(/^dsAttrTypeNative:/, "", f) } f == k { print $2 }'; }

ids_free_or_ours() {
  local u g
  u="$(dscl . -search /Users UniqueID "$T_UID" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  g="$(dscl . -search /Groups PrimaryGroupID "$T_GID" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  [ -z "$u" ] || [ "$u" = "$T_USER" ] || { warn "uid ${T_UID} belongs to ${u}"; return 1; }
  [ -z "$g" ] || [ "$g" = "$T_GROUP" ] || { warn "gid ${T_GID} belongs to group ${g}"; return 1; }
  if user_exists; then
    [ "$(dscl_value "/Users/$T_USER" UniqueID)" = "$T_UID" ] || { warn "user ${T_USER} exists with another uid"; return 1; }
    [ "$(dscl_value "/Users/$T_USER" NFSHomeDirectory)" = "$T_HOME" ] || { warn "user ${T_USER} exists with another home"; return 1; }
  fi
  return 0
}
root_dir_ours_or_absent() {
  [ -e "$ROOT_DIR" ] || return 0
  [ "$(stat -f %u "$ROOT_DIR")" = 0 ] || { warn "${ROOT_DIR} exists and is not owned by root"; return 1; }
  [ -z "$(ls -A "$ROOT_DIR" 2>/dev/null)" ] || [ -f "$CONF_FILE" ] || { warn "${ROOT_DIR} exists, is not empty and has no ${CONF_FILE}: not ours"; return 1; }
}
primary_gid_ok() { [ "$(dscl_value "/Users/$T_USER" PrimaryGroupID)" = "$T_GID" ]; }
not_member() {
  local out
  out="$(sudo_q dseditgroup -o checkmember -m "$T_USER" "$1" 2>&1 || true)"
  case "$out" in yes*) return 1 ;; esac
  return 0
}
not_in_staff_list() { ! dscl . -read /Groups/staff GroupMembership 2>/dev/null | tr ' ' '\n' | grep -x -c "$T_USER" >/dev/null; }
no_secure_token() {
  local out
  out="$(sudo_q sysadminctl -secureTokenStatus "$T_USER" 2>&1 || true)"
  case "$out" in *DISABLED*) return 0 ;; esac
  warn "sysadminctl says: ${out}"
  return 1
}
no_ssh_dir() { ! sudo_q test -e "$T_HOME/.ssh"; }
home_locked() { [ "$(sudo_q stat -f '%u:%g %Lp' "$T_HOME")" = "${T_UID}:${T_GID} 700" ]; }
tenant_cannot_list() { ! tenant_q /bin/ls "$1" >/dev/null 2>&1; }
tenant_refused() { ! tenant_q /usr/bin/nc -z -G 2 "$1" "$2" >/dev/null 2>&1; }

# tenant_procs: pids of the tenant's processes other than macOS per-user agents.
tenant_procs() {
  ps -axo uid=,pid=,comm= | awk -v u="$T_UID" '$1 == u && $3 !~ "^/(System|usr/libexec|usr/sbin|Library/Apple)/" { print $2 }'
}
# kill_tenant: SIGKILL every process of the tenant uid until none is left (30 s), because a
# same-uid process can read config.sh's environment, which carries the token.
kill_tenant() {
  local waited=0
  if [ "$DRY" = 1 ]; then
    show sudo pkill -KILL -u "$T_UID"
    printf '    (repeated until no %s process is left, at most 30 s)\n' "$T_USER"
    return 0
  fi
  while :; do
    sudo_q pkill -KILL -u "$T_UID" >/dev/null 2>&1 || true
    [ -n "$(tenant_procs)" ] || break
    [ "$waited" -lt 30 ] || die "processes of ${T_USER} survived SIGKILL for 30 s: $(tenant_procs | tr '\n' ' ')"
    sleep 1
    waited=$((waited + 1))
  done
  say "no ${T_USER} process is running"
}

# install_root <mode> <src> <dest>: a root-owned copy.
install_root() { priv install -o root -g wheel -m "$1" "$2" "$3"; }

# ── preflight ──────────────────────────────────────────────────────────────────────────────────
pf_result() {
  case "$1" in
    OK) printf 'OK    %s\n' "$2" ;;
    WARN) printf 'WARN  %s\n' "$2" ;;
    *)
      printf 'FAIL  %s\n' "$2"
      FAILS=$((FAILS + 1))
      ;;
  esac
}
cmd_preflight() {
  local v free p a ah listen
  say "preflight (read-only) for tenant ${T_NAME}, kit v${KIT_VERSION}"
  if [ "$(uname -s)" = Darwin ]; then pf_result OK "macOS $(sw_vers -productVersion 2>/dev/null || echo '?')"; else pf_result FAIL "not macOS ($(uname -s))"; fi
  pf_result OK "running as $(id -un) (not root, not ${T_USER})"
  if command -v sudo >/dev/null 2>&1; then
    case " $(id -Gn) " in
      *" admin "*) pf_result OK "install/firewall/register will ask sudo for your password (you are an admin)" ;;
      *) pf_result FAIL "you are not in the admin group: sudo is needed for install, firewall and register" ;;
    esac
  else
    pf_result FAIL "sudo not found"
  fi
  if ids_free_or_ours; then
    if user_exists; then pf_result OK "user ${T_USER} (uid ${T_UID}) already exists and matches the profile (re-run path)"; else pf_result OK "uid ${T_UID}, gid ${T_GID} and the names ${T_USER}/${T_GROUP} are free"; fi
  else
    pf_result FAIL "uid/gid/name clash for ${T_USER} (${T_UID}:${T_GID})"
  fi
  if root_dir_ours_or_absent; then pf_result OK "${ROOT_DIR}: absent or ours"; else pf_result FAIL "${ROOT_DIR} is not ours"; fi
  if listen="$(netstat -an -p tcp 2>/dev/null | awk '$NF == "LISTEN" { print $4 }')"; then
    for p in $PORTS; do
      if printf '%s\n' "$listen" | grep -E -c "[.:]${p}\$" >/dev/null; then
        if user_exists; then pf_result WARN "port ${p} is in use (a ${T_NAME} job may be running)"; else pf_result FAIL "port ${p} is already in use"; fi
      else
        pf_result OK "port ${p} is free"
      fi
    done
  else
    pf_result WARN "ports: netstat unreadable"
  fi
  free="$(df -Pk /Users 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')" || free=""
  if [ -z "$free" ]; then
    pf_result WARN "free disk: unreadable"
  elif [ "$free" -lt "$DISK_FLOOR_GB" ]; then
    pf_result FAIL "free disk ${free} GB is below the floor of ${DISK_FLOOR_GB} GB"
  else
    pf_result OK "free disk ${free} GB (floor ${DISK_FLOOR_GB} GB)"
  fi
  v="$(fdesetup status 2>/dev/null || echo unreadable)"
  case "$v" in
    *"is On"*) pf_result WARN "FileVault is on: after a power cut nothing (the runner included) starts until someone unlocks the disk at the login window" ;;
    *"is Off"*) pf_result OK "FileVault is off (profile says ${DISK_ENCRYPTION})" ;;
    *) pf_result WARN "FileVault status unreadable" ;;
  esac
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    if [ -d "$ah" ]; then pf_result OK "${a}'s home ${ah} will get a deny-ACE for ${T_USER}"; else pf_result WARN "${a} has no home at ${ah}"; fi
  done
  case " $OTHER_ADMINS " in
    *" $(id -un) "*) ;;
    *) pf_result WARN "your own home (${HOME:-?}) is not in host.otherAdmins: ${T_USER} will be able to list it" ;;
  esac
  if [ "$NETWORK" = 1 ]; then
    pf_result OK "network isolation on: run 'provision.sh firewall' after install, before register"
  else
    pf_result WARN "network isolation is off in the profile: ${T_USER} can reach every LAN and loopback service"
  fi
  if [ "$FAILS" -gt 0 ]; then
    say "preflight: ${FAILS} check(s) failed"
    return 1
  fi
  say "preflight: ok"
}

# ── install ────────────────────────────────────────────────────────────────────────────────────
cmd_install() {
  local a ah f kind
  require_macos
  for f in hooks/lib.sh hooks/job-started.sh hooks/job-completed.sh conf/tenant.conf runner/.env runner/.path; do need_kit_file "$f"; done
  say "install for tenant ${T_NAME} (kit v${KIT_VERSION})$([ "$DRY" = 1 ] && echo ' — DRY RUN, nothing is executed')"
  run /bin/bash -c 'cd "$1" && /usr/bin/shasum -a 256 -c SHA256SUMS >/dev/null' verify-kit "$KIT"
  if [ "$DRY" = 0 ]; then
    ids_free_or_ours || die "the profile's uid/gid/names clash with an existing account (run preflight)"
    root_dir_ours_or_absent || die "${ROOT_DIR} is not ours (run preflight)"
  fi
  run sudo -v

  say "1/7 group and user (the account password prompt is hidden; type a long random string, nothing needs it again)"
  skip_if group_exists -- priv dseditgroup -o create -i "$T_GID" -r "homeactions CI runner ${T_NAME}" "$T_GROUP"
  skip_if user_exists -- priv sysadminctl -addUser "$T_USER" -fullName "homeactions CI runner ${T_NAME}" \
    -UID "$T_UID" -GID "$T_GID" -shell /usr/bin/false -home "$T_HOME" -password -
  check "user ${T_USER} has uid ${T_UID}" ids_free_or_ours
  priv dscl . -create "/Users/$T_USER" IsHidden 1
  skip_if home_exists -- priv createhomedir -c -u "$T_USER"
  priv chown "${T_USER}:${T_GROUP}" "$T_HOME"
  priv chmod 700 "$T_HOME"

  say "2/7 deny-ACE on every other admin's home"
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    if [ "$DRY" = 0 ] && [ ! -d "$ah" ]; then
      warn "${a} has no home at ${ah}; skipping its ACE"
      continue
    fi
    skip_if has_ace "$ah" -- priv chmod +a "$ACE" "$ah"
  done

  say "3/7 identity assertions"
  check "${T_USER}'s home is ${T_UID}:${T_GID} mode 700" home_locked
  check "${T_USER}'s primary group is ${T_GROUP} (${T_GID})" primary_gid_ok
  check "${T_USER} is not in admin" not_member admin
  check "${T_USER} is not listed in staff" not_in_staff_list
  check "${T_USER} is not in com.apple.access_ssh" not_member com.apple.access_ssh
  check "${T_USER} has no secure token" no_secure_token
  check "${T_USER} has no ~/.ssh" no_ssh_dir
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    [ "$DRY" = 1 ] || [ -d "$ah" ] || continue
    check "${T_USER} cannot list ${ah}" tenant_cannot_list "$ah"
  done

  say "4/7 tenant directories (.noindex keeps them out of Spotlight)"
  as_tenant /bin/mkdir -p "$RUNNER_DIR" "$TMP_DIR" "$CACHE_DIR" "$OPT_DIR" "$SRC_DIR" "$STATE_DIR" "$LOG_DIR"

  say "5/7 root-owned hooks and config in ${ROOT_DIR}"
  priv install -d -o root -g wheel -m 0755 "$ROOT_DIR" "$HOOKS_DIR" "$ROOT_DIR/services" "$ROOT_DIR/smoke"
  priv install -o root -g wheel -m 0755 "$KIT/hooks/lib.sh" "$KIT/hooks/job-started.sh" "$KIT/hooks/job-completed.sh" "$HOOKS_DIR/"
  install_root 0644 "$KIT/conf/tenant.conf" "$CONF_FILE"
  if [ -f "$KIT/maintenance.sh" ]; then install_root 0755 "$KIT/maintenance.sh" "$ROOT_DIR/maintenance.sh"; fi
  for f in "$KIT"/services/*.sh "$KIT"/smoke/*; do
    [ -f "$f" ] || continue
    install_root 0755 "$f" "$ROOT_DIR/$(basename "$(dirname "$f")")/$(basename "$f")"
  done

  say "6/7 services, built as ${T_USER} into ${OPT_DIR} (no shared package manager)"
  for kind in postgres redis; do
    case "$kind" in postgres) [ "$HAS_POSTGRES" = 1 ] || continue ;; redis) [ "$HAS_REDIS" = 1 ] || continue ;; esac
    if [ -f "$KIT/services/build-${kind}.sh" ] || [ "$DRY" = 1 ]; then
      as_tenant /bin/bash --noprofile --norc "$ROOT_DIR/services/build-${kind}.sh"
    else
      die "the profile has ${kind} but the kit has no services/build-${kind}.sh"
    fi
  done

  say "7/7 runner ${RUNNER_VERSION}, downloaded as ${T_USER} and checked against its pinned sha256"
  skip_if tarball_ok -- as_tenant /usr/bin/curl -fsSL --retry 3 -o "$TARBALL_PATH" "$RUNNER_URL"
  as_tenant /bin/bash --noprofile --norc -c 'printf "%s  %s\n" "$1" "$2" | /usr/bin/shasum -a 256 -c -' sha256 "$RUNNER_SHA" "$TARBALL_PATH"
  skip_if runner_extracted -- as_tenant /usr/bin/tar -xzf "$TARBALL_PATH" -C "$RUNNER_DIR"
  as_tenant /bin/bash --noprofile --norc -c 'printf "%s\n" "$1" > "$2"' marker "$RUNNER_SHA" "$TARBALL_MARKER"

  say "install done. No daemon is loaded yet."
  if [ "$NETWORK" = 1 ]; then say "next: bash provision.sh firewall, then bash provision.sh register"; else say "next: bash provision.sh register"; fi
}

# ── firewall (pf) ──────────────────────────────────────────────────────────────────────────────
anchor_empty() { [ -z "$(sudo_q pfctl -a "$PF_ANCHOR" -s rules 2>/dev/null)" ]; }
pf_enabled() { sudo_q pfctl -s info 2>/dev/null | grep -c 'Status: Enabled' >/dev/null; }
pf_rules_loaded() { [ "$(sudo_q pfctl -a "$PF_ANCHOR" -s rules 2>/dev/null | grep -c "user")" -gt 0 ]; }
internet_ok() { [ "$(tenant_q /usr/bin/curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.github.com/zen 2>/dev/null)" = 200 ]; }

probe_all_refused() {
  local t h p
  for t in $PROBES; do
    h="${t%:*}"
    p="${t##*:}"
    h="${h#[}"
    h="${h%]}"
    check "${T_USER} is refused by ${t}" tenant_refused "$h" "$p"
  done
}

cmd_firewall() {
  require_macos
  [ "$NETWORK" = 1 ] || die "isolation.network is off in the profile: there is no firewall to load"
  for f in pf/anchor.pf pf/pf-load.sh launchd/firewall.plist; do need_kit_file "$f"; done
  if [ "$DRY" = 0 ]; then user_exists || die "user ${T_USER} does not exist yet: run install first"; fi
  run sudo -v
  run /usr/bin/plutil -lint "$KIT/launchd/firewall.plist"
  install_root 0644 "$KIT/pf/anchor.pf" "$PF_ANCHOR_FILE"
  install_root 0755 "$KIT/pf/pf-load.sh" "$PF_LOADER"
  install_root 0644 "$KIT/launchd/firewall.plist" "$FIREWALL_PLIST"
  priv pfctl -n -a "$PF_ANCHOR" -f "$PF_ANCHOR_FILE"
  skip_if not_loaded "$FIREWALL_LABEL" -- priv launchctl bootout "system/${FIREWALL_LABEL}"
  priv launchctl bootstrap system "$FIREWALL_PLIST"
  [ "$DRY" = 1 ] || sleep 2
  priv pfctl -a "$PF_ANCHOR" -s rules
  check "pf is enabled" pf_enabled
  check "anchor ${PF_ANCHOR} holds the ${T_USER} rules" pf_rules_loaded
  probe_all_refused
  check "${T_USER} still reaches the internet (api.github.com)" internet_ok
  say "firewall loaded: anchor ${PF_ANCHOR}, reloaded by ${FIREWALL_LABEL} at boot and every 300 s"
}

cmd_firewall_unload() {
  local tok
  require_macos
  run sudo -v
  skip_if not_loaded "$FIREWALL_LABEL" -- priv launchctl bootout "system/${FIREWALL_LABEL}"
  skip_if anchor_empty -- priv pfctl -a "$PF_ANCHOR" -F all
  if [ "$DRY" = 1 ]; then
    show sudo pfctl -X "<the reference token read from ${PF_TOKEN_FILE}>"
    printf '    (only when %s exists)\n' "$PF_TOKEN_FILE"
  elif sudo_q test -s "$PF_TOKEN_FILE"; then
    tok="$(sudo_q cat "$PF_TOKEN_FILE")"
    priv pfctl -X "$tok" || warn "pfctl -X refused the saved reference (stale after a reboot?); continuing"
  fi
  priv rm -f "$PF_TOKEN_FILE" "$FIREWALL_PLIST" "$PF_ANCHOR_FILE" "$PF_LOADER" "$PF_LOG"
  if [ "$DRY" = 0 ]; then sudo_q pfctl -s info 2>/dev/null | head -1 || true; fi
  say "firewall unloaded (pf stays enabled only if another component holds its own reference)"
}

# ── register ───────────────────────────────────────────────────────────────────────────────────
firewall_active() {
  local t
  pf_enabled || { warn "pf is not enabled"; return 1; }
  pf_rules_loaded || { warn "anchor ${PF_ANCHOR} has no rules"; return 1; }
  t="${PROBES%% *}"
  if [ -n "$t" ]; then
    local h="${t%:*}" p="${t##*:}"
    h="${h#[}"
    h="${h%]}"
    tenant_refused "$h" "$p" || { warn "${T_USER} can still reach ${t}"; return 1; }
  fi
}
plist_is() { [ "$("$PLISTBUDDY" -c "Print :$2" "$1" 2>/dev/null)" = "$3" ]; }
listener_ok() {
  local n=0 line
  while [ "$n" -lt 30 ]; do
    line="$(ps -axo uid=,ni=,command= | awk -v u="$T_UID" '$1 == u && /Runner\.Listener/ { print $1, $2; exit }')"
    if [ -n "$line" ]; then
      [ "$line" = "${T_UID} ${NICE}" ] && return 0
      warn "Runner.Listener runs as uid/nice ${line}, expected ${T_UID} ${NICE}"
      return 1
    fi
    sleep 1
    n=$((n + 1))
  done
  warn "no Runner.Listener of uid ${T_UID} after 30 s (see ${LOG_DIR})"
  return 1
}

pb() { run "$PLISTBUDDY" -c "$1" "$2"; }
# pb_put <plist> <key> <type> <value>: replace the key (idempotent).
pb_put() {
  if [ "$DRY" = 0 ]; then "$PLISTBUDDY" -c "Delete :$2" "$1" >/dev/null 2>&1 || true; fi
  pb "Add :$2 $3 $4" "$1"
}
pb_limits() {
  local which
  for which in SoftResourceLimits HardResourceLimits; do
    if [ "$DRY" = 0 ]; then "$PLISTBUDDY" -c "Delete :$which" "$1" >/dev/null 2>&1 || true; fi
    pb "Add :$which dict" "$1"
    pb "Add :$which:NumberOfFiles integer $OPEN_FILES" "$1"
  done
}

cmd_register() {
  local work plist tmpl token rc
  require_macos
  need_kit_file runner/.env
  need_kit_file runner/.path
  if [ "$DRY" = 0 ]; then
    user_exists || die "user ${T_USER} does not exist: run install first"
  fi
  run sudo -v
  check "the runner is extracted in ${RUNNER_DIR}" sudo_q test -x "$RUNNER_DIR/config.sh"
  if [ "$NETWORK" = 1 ]; then
    check "the firewall is active (pf enabled, anchor loaded, ${T_USER} refused by ${PROBES%% *})" firewall_active
  fi

  say "1/5 stop the runner daemon and every ${T_USER} process (a same-uid process could read the token from config.sh's environment)"
  skip_if not_loaded "$DAEMON_LABEL" -- priv launchctl bootout "system/${DAEMON_LABEL}"
  kill_tenant
  skip_if not_present "$RUNNER_DIR/.env" -- priv chflags nouchg "$RUNNER_DIR/.env"
  skip_if not_present "$RUNNER_DIR/.path" -- priv chflags nouchg "$RUNNER_DIR/.path"
  priv rm -f "$RUNNER_DIR/.env" "$RUNNER_DIR/.path"

  say "2/5 registration (open ${REPO_URL}/settings/actions/runners/new and copy only the token value)"
  if [ "$DRY" = 1 ]; then
    printf '%s\n' "+ IFS= read -rs token   # hidden prompt in your terminal"
    printf '%s\n' "+ printf '%s\\n' \"\$token\" | $(tenant_argv | while IFS= read -r l; do printf '%s ' "$(q "$l")"; done)/bin/bash --noprofile --norc -c 'IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN; cd \"\$1\"; exec ./config.sh --unattended --replace --url \"\$2\" --name \"\$3\" --labels \"\$4\" --work _work' homeactions-register $(q "$RUNNER_DIR") $(q "$REPO_URL") $(q "$RUNNER_NAME") $(q "$RUNNER_LABELS")"
  else
    kill_tenant
    printf 'Paste the registration token (hidden), then Enter: ' >&2
    IFS= read -rs token
    printf '\n' >&2
    [ -n "$token" ] || die "empty token"
    case "$token" in *[!A-Za-z0-9_-]*) die "the token has unexpected characters; copy only the value" ;; esac
    rc=0
    printf '%s\n' "$token" | tenant_q /bin/bash --noprofile --norc -c '
      set -eu
      IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN
      export ACTIONS_RUNNER_INPUT_TOKEN
      cd "$1"
      exec ./config.sh --unattended --replace --url "$2" --name "$3" --labels "$4" --work _work
    ' homeactions-register "$RUNNER_DIR" "$REPO_URL" "$RUNNER_NAME" "$RUNNER_LABELS" || rc=$?
    token=""
    unset token
    [ "$rc" = 0 ] || die "config.sh failed (exit ${rc}). If it rejected the token from its environment, STOP: this kit never passes the token as an argument. Report it."
  fi
  check "config.sh wrote ${RUNNER_DIR}/.runner" sudo_q test -f "$RUNNER_DIR/.runner"

  say "3/5 root-owned, immutable .env and .path"
  install_root 0644 "$KIT/runner/.env" "$RUNNER_DIR/.env"
  install_root 0644 "$KIT/runner/.path" "$RUNNER_DIR/.path"
  priv chflags uchg "$RUNNER_DIR/.env" "$RUNNER_DIR/.path"

  say "4/5 LaunchDaemon ${DAEMON_LABEL}, generated from the runner's own template"
  as_tenant /bin/cp "$RUNNER_DIR/bin/runsvc.sh" "$RUNNER_DIR/runsvc.sh"
  as_tenant /bin/chmod 755 "$RUNNER_DIR/runsvc.sh"
  as_tenant /bin/mkdir -p "$LOG_DIR"
  if [ "$DRY" = 1 ]; then work='$WORK'; else work="$(mktemp -d "${TMPDIR:-/tmp}/homeactions.XXXXXX")"; fi
  tmpl="$work/runner.plist.template"
  plist="$work/${DAEMON_LABEL}.plist"
  show sudo -H -u "$T_USER" /bin/cat "$RUNNER_DIR/bin/actions.runner.plist.template"
  printf '    > %s\n' "$tmpl"
  [ "$DRY" = 1 ] || sudo_q -H -u "$T_USER" /bin/cat "$RUNNER_DIR/bin/actions.runner.plist.template" > "$tmpl"
  show sed -e "s|${OB}SvcName}}|${DAEMON_LABEL}|g" -e "s|${OB}RunnerRoot}}|${RUNNER_DIR}|g" -e "s|${OB}UserHome}}|${T_HOME}|g" "$tmpl"
  printf '    > %s   (also SvcNameVar, User, Env_PATH)\n' "$plist"
  if [ "$DRY" = 0 ]; then
    sed -e "s|${OB}SvcNameVar}}|${DAEMON_LABEL}|g" \
      -e "s|${OB}SvcName}}|${DAEMON_LABEL}|g" \
      -e "s|${OB}RunnerRoot}}|${RUNNER_DIR}|g" \
      -e "s|${OB}UserHome}}|${T_HOME}|g" \
      -e "s|${OB}User}}|${T_USER}|g" \
      -e "s|${OB}Env_PATH}}|${TENANT_PATH}|g" \
      "$tmpl" > "$plist"
    if [ "$(grep -c "$OB" "$plist" || true)" != 0 ]; then
      die "the generated plist still has an unknown double-brace placeholder from the runner's template: $(grep "$OB" "$plist" | head -3)"
    fi
  else
    printf '? assert: no double-brace placeholder is left in %s\n' "$plist"
  fi
  pb_put "$plist" Label string "$DAEMON_LABEL"
  pb_put "$plist" UserName string "$T_USER"
  pb_put "$plist" GroupName string "$T_GROUP"
  pb_put "$plist" WorkingDirectory string "$RUNNER_DIR"
  pb_put "$plist" KeepAlive bool true
  pb_put "$plist" RunAtLoad bool true
  pb_put "$plist" SessionCreate bool true
  pb_put "$plist" ProcessType string Standard
  pb_put "$plist" Nice integer "$NICE"
  pb_put "$plist" LowPriorityIO bool true
  pb_limits "$plist"
  pb_put "$plist" StandardOutPath string "$LOG_DIR/stdout.log"
  pb_put "$plist" StandardErrorPath string "$LOG_DIR/stderr.log"
  check "plist UserName is ${T_USER}" plist_is "$plist" UserName "$T_USER"
  check "plist GroupName is ${T_GROUP}" plist_is "$plist" GroupName "$T_GROUP"
  check "plist WorkingDirectory is ${RUNNER_DIR}" plist_is "$plist" WorkingDirectory "$RUNNER_DIR"
  check "plist Nice is ${NICE}" plist_is "$plist" Nice "$NICE"
  check "plist ProgramArguments runs ${RUNNER_DIR}/runsvc.sh" plist_is "$plist" "ProgramArguments:0" "$RUNNER_DIR/runsvc.sh"
  check "plist NumberOfFiles is ${OPEN_FILES}" plist_is "$plist" "HardResourceLimits:NumberOfFiles" "$OPEN_FILES"
  run /usr/bin/plutil -lint "$plist"
  install_root 0644 "$plist" "$DAEMON_PLIST"
  [ "$DRY" = 1 ] || rm -rf "$work"

  say "5/5 load it"
  priv launchctl bootstrap system "$DAEMON_PLIST"
  check "Runner.Listener runs as uid ${T_UID} at nice ${NICE}" listener_ok
  say "registered ${RUNNER_NAME} on ${REPO_SLUG} with labels self-hosted + ${RUNNER_LABELS}. Next: bash provision.sh verify"
}

# ── verify (read-only, no sudo) ────────────────────────────────────────────────────────────────
v_result() { pf_result "$@"; }
flags_of() { stat -f %Sf "$1" 2>/dev/null; }
cmd_verify() {
  local st a ah acl line
  say "verify (read-only, no sudo) for tenant ${T_NAME}"
  if user_exists; then
    if [ "$(dscl_value "/Users/$T_USER" UniqueID)" = "$T_UID" ]; then v_result OK "user ${T_USER} uid ${T_UID}"; else v_result FAIL "user ${T_USER} has another uid"; fi
    case " $(id -Gn "$T_USER" 2>/dev/null) " in *" admin "*) v_result FAIL "${T_USER} is an admin" ;; *) v_result OK "${T_USER} is not an admin" ;; esac
    if [ "$(dscl_value "/Users/$T_USER" IsHidden)" = 1 ]; then v_result OK "${T_USER} is hidden"; else v_result WARN "${T_USER} is not hidden"; fi
  else
    v_result FAIL "user ${T_USER} does not exist"
  fi
  if st="$(stat -f '%u %Lp' "$T_HOME" 2>/dev/null)"; then
    if [ "$st" = "${T_UID} 700" ]; then v_result OK "${T_HOME} is ${T_USER}'s, mode 700"; else v_result FAIL "${T_HOME} owner/mode is ${st}"; fi
  else
    v_result FAIL "${T_HOME}: absent or unreadable"
  fi
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    if acl="$(/bin/ls -led "$ah" 2>/dev/null)"; then
      if printf '%s\n' "$acl" | grep -F -c "user:${T_USER} deny list,search" >/dev/null; then v_result OK "deny-ACE for ${T_USER} on ${ah}"; else v_result FAIL "no deny-ACE for ${T_USER} on ${ah}"; fi
    else
      v_result WARN "${ah}: ACL unreadable from this account (not the same as absent)"
    fi
  done
  for f in "$ROOT_DIR" "$HOOKS_DIR" "$HOOKS_DIR/lib.sh" "$HOOKS_DIR/job-started.sh" "$HOOKS_DIR/job-completed.sh" "$CONF_FILE"; do
    if st="$(stat -f '%u %Sp' "$f" 2>/dev/null)"; then
      case "$st" in
        "0 "?????w* | "0 "????????w*) v_result FAIL "${f} is group/other-writable (${st})" ;;
        "0 "*) v_result OK "${f} is root-owned (${st#0 })" ;;
        *) v_result FAIL "${f} is not root-owned (${st})" ;;
      esac
    else
      v_result FAIL "${f}: absent or unreadable"
    fi
  done
  for f in "$RUNNER_DIR/.env" "$RUNNER_DIR/.path"; do
    if [ ! -x "$T_HOME" ] && [ -d "$T_HOME" ]; then
      v_result WARN "${f}: unreadable from this account (${T_HOME} is 700, which is correct); check it with sudo -u ${T_USER} stat -f '%u %Sf' ${f}"
    elif st="$(stat -f '%u' "$f" 2>/dev/null)"; then
      if [ "$st" = 0 ]; then v_result OK "${f} root-owned"; else v_result FAIL "${f} is owned by uid ${st}"; fi
      case ",$(flags_of "$f")," in *,uchg,*) v_result OK "${f} is uchg" ;; *) v_result FAIL "${f} is not uchg" ;; esac
    else
      v_result FAIL "${f}: absent"
    fi
  done
  if [ -f "$DAEMON_PLIST" ]; then v_result OK "${DAEMON_PLIST} present"; else v_result FAIL "${DAEMON_PLIST} absent"; fi
  if launchctl print "system/${DAEMON_LABEL}" >/dev/null 2>&1; then v_result OK "${DAEMON_LABEL} loaded"; else v_result FAIL "${DAEMON_LABEL} not loaded (or not readable without sudo)"; fi
  line="$(ps -axo uid=,ni=,command= | awk -v u="$T_UID" '$1 == u && /Runner\.Listener/ { print $1, $2; exit }')"
  if [ -z "$line" ]; then v_result FAIL "no Runner.Listener running as uid ${T_UID}"; elif [ "$line" = "${T_UID} ${NICE}" ]; then v_result OK "Runner.Listener runs as uid ${T_UID} at nice ${NICE}"; else v_result FAIL "Runner.Listener uid/nice is ${line}"; fi
  if [ "$NETWORK" = 1 ]; then
    if [ -f "$FIREWALL_PLIST" ]; then v_result OK "${FIREWALL_PLIST} present"; else v_result FAIL "${FIREWALL_PLIST} absent"; fi
    if [ -f "$PF_ANCHOR_FILE" ]; then v_result OK "${PF_ANCHOR_FILE} present"; else v_result FAIL "${PF_ANCHOR_FILE} absent"; fi
    if [ -e "$PF_TOKEN_FILE" ]; then v_result OK "pf reference token held (${PF_TOKEN_FILE})"; else v_result FAIL "no pf reference token at ${PF_TOKEN_FILE}"; fi
    v_result WARN "pf rules need root to list: sudo pfctl -a '${PF_ANCHOR}' -s rules   (expect 7 rules, each with 'user ${T_USER}')"
  fi
  if [ "$FAILS" -gt 0 ]; then
    say "verify: ${FAILS} check(s) failed"
    return 1
  fi
  say "verify: ok"
}

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

main() {
  local sub="${1:-}"
  [ -n "$sub" ] || usage
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      -h | --help) usage ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  case "$sub" in
    preflight | install | firewall | firewall-unload | register | verify) ;;
    -h | --help | help) usage ;;
    *) die "unknown subcommand ${sub} (preflight | install | firewall | firewall-unload | register | verify)" ;;
  esac
  refuse_unsafe
  case "$sub" in
    preflight) cmd_preflight ;;
    install) cmd_install ;;
    firewall) cmd_firewall ;;
    firewall-unload) cmd_firewall_unload ;;
    register) cmd_register ;;
    verify) cmd_verify ;;
  esac
}

main "$@"
