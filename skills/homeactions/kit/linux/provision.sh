#!/bin/bash
# homeactions Linux provisioner (BETA) for tenant {{tenant.name}} (user {{tenant.user}}, uid {{tenant.uid}}).
#
#   bash provision.sh preflight            read-only checks; changes nothing, needs no sudo
#   bash provision.sh install   [--dry-run] system user + group, 700 home, ACL denies, root-owned hooks, services, runner
#   bash provision.sh firewall  [--dry-run] nftables table + oneshot unit (only when isolation.network)
#   bash provision.sh firewall-unload [--dry-run]
#   bash provision.sh register  [--dry-run] hidden token prompt, config.sh, root-owned .env/.path, hardened systemd unit
#   bash provision.sh verify               read-only checks the owner or an agent can run; no sudo
#
# Run it as the machine owner (a sudoer, not root), from the copied host/ directory, after
# `sha256sum -c SHA256SUMS`. --dry-run prints every privileged command and executes nothing. Every step
# is idempotent. The registration token is read at a hidden prompt and reaches config.sh only as
# ACTIONS_RUNNER_INPUT_TOKEN on a pipe into `env -i bash --noprofile --norc`; never in argv or a file.
# Bash 3.2 compatible.
set -euo pipefail

T_NAME='{{tenant.name}}'
T_USER='{{tenant.user}}'
T_GROUP='{{tenant.group}}'
T_UID='{{tenant.uid}}'
T_GID='{{tenant.gid}}'
T_HOME='{{tenant.home}}'
ROOT_DIR='{{tenant.rootDir}}'
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
NFT_TABLE='{{derived.nftTable}}'
NICE='{{caps.nice}}'
PORTS='{{derived.portsSpace}}'
PROBES='{{derived.probesSpace}}'
OTHER_ADMINS='{{join derived.otherAdmins " "}}'
NETWORK='{{#if isolation.network}}1{{else}}0{{/if}}'
DISK_FLOOR_GB='{{diskFloorGb}}'
DISK_ENCRYPTION='{{host.diskEncryption}}'
BANNER='{{derived.banner}}'
KIT_VERSION='{{derived.kitVersion}}'
{{#if derived.hasPostgres}}PG_INSTALL='{{derived.postgres.install}}'
PG_MAJOR='{{derived.postgres.major}}'
PG_PREFIX='{{derived.postgres.prefix}}'
{{else}}PG_INSTALL=''
PG_MAJOR=''
PG_PREFIX=''
{{/if}}{{#if derived.hasRedis}}REDIS_INSTALL='{{derived.redis.install}}'
REDIS_PREFIX='{{derived.redis.prefix}}'
{{else}}REDIS_INSTALL=''
REDIS_PREFIX=''
{{/if}}
RUNNER_UNIT="${DAEMON_LABEL}.service"
FIREWALL_UNIT="${FIREWALL_LABEL}.service"
RUNNER_UNIT_FILE="/etc/systemd/system/${RUNNER_UNIT}"
FIREWALL_UNIT_FILE="/etc/systemd/system/${FIREWALL_UNIT}"
NFT_RULES="${ROOT_DIR}/tenant.nft"
NFT_LOADER="${ROOT_DIR}/nft-load.sh"
REPO_URL="https://github.com/${REPO_SLUG}"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_TARBALL}"
TARBALL_PATH="${CACHE_DIR}/${RUNNER_TARBALL}"
TARBALL_MARKER="${RUNNER_DIR}/.homeactions-tarball-sha256"
# The ACL entry denying the tenant every other admin's home. uninstall.sh removes it with setfacl -x.
ACL_ENTRY="u:${T_USER}:---"
TENANT_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
KIT="$(cd "$(dirname "$0")" && pwd)"

DRY=0
FAILS=0

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
tenant_argv() {
  printf '%s\n' sudo -H -u "$T_USER" env -i "HOME=${T_HOME}" "USER=${T_USER}" "LOGNAME=${T_USER}" \
    SHELL=/bin/bash LANG=C.UTF-8 "PATH=${TENANT_PATH}" "TMPDIR=${TMP_DIR}"
}
as_tenant() {
  local argv=() l
  while IFS= read -r l; do argv+=("$l"); done < <(tenant_argv)
  run "${argv[@]}" "$@"
}
sudo_q() { sudo "$@"; }
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
    say "already in place, skipping: $(show "$@")"
  else
    "$@"
  fi
}
check() {
  local what="$1"
  shift
  if [ "$DRY" = 1 ]; then
    printf '? assert: %s\n' "$what"
    return 0
  fi
  if "$@"; then say "ok: $what"; else die "check failed: $what"; fi
}

# ── safety rules ───────────────────────────────────────────────────────────────────────────────
is_sensitive_dir() {
  case "$1" in
    / | /etc | /etc/systemd* | /etc/ssh* | /etc/sudoers.d | /etc/nftables* | /etc/pam.d | /etc/security | /opt | \
      /opt/homebrew* | /home | /root* | /usr* | /bin* | /sbin* | /var | /var/lib | /var/run | /run* | /home/linuxbrew*) return 0 ;;
  esac
  return 1
}
under() { case "$1/" in "$2"/*) return 0 ;; esac; return 1; }
admin_home() {
  local h=""
  if [ "$DRY" = 0 ]; then h="$(getent passwd "$1" 2>/dev/null | cut -d: -f6)" || h=""; fi
  printf '%s\n' "${h:-/home/$1}"
}
refuse_unsafe() {
  local groups a ah
  [ "$(id -u)" != 0 ] || die "do not run this as root (or with sudo): run it as the machine owner; it calls sudo itself"
  [ "$(id -un)" != "$T_USER" ] || die "do not run this as the tenant user ${T_USER}: run it as the machine owner"
  [ "$T_USER" != root ] && [ "$T_UID" != 0 ] || die "the tenant user must never be root"
  for a in $OTHER_ADMINS; do
    [ "$a" != "$T_USER" ] || die "tenant user ${T_USER} is listed in host.otherAdmins: refusing to turn an admin into a CI tenant"
  done
  if groups="$(id -Gn "$T_USER" 2>/dev/null)"; then
    case " $groups " in
      *" sudo "* | *" wheel "* | *" admin "* | *" adm "* | *" docker "* | *" lxd "*) die "user ${T_USER} already exists and is privileged (groups: ${groups}): refusing" ;;
    esac
  fi
  case "$T_HOME" in /home/?* | /var/lib/?*) ;; *) die "tenant.home ${T_HOME} must be under /home or /var/lib" ;; esac
  [ "$T_HOME" != "${HOME:-/nonexistent}" ] || die "tenant.home is your own home directory"
  ! under "${HOME:-/nonexistent}" "$T_HOME" || die "your home is inside tenant.home ${T_HOME}"
  ! under "$T_HOME" "${HOME:-/nonexistent}" || die "tenant.home ${T_HOME} is inside your home"
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    [ "$T_HOME" != "$ah" ] && ! under "$T_HOME" "$ah" || die "tenant.home ${T_HOME} is inside ${a}'s home ${ah}"
    ! under "$ROOT_DIR" "$ah" || die "tenant.rootDir ${ROOT_DIR} is inside ${a}'s home"
  done
  ! is_sensitive_dir "$ROOT_DIR" || die "tenant.rootDir ${ROOT_DIR} is a system or shared directory; choose a dedicated one such as /opt/<name>-ci"
  ! under "$ROOT_DIR" "$T_HOME" || die "tenant.rootDir must be outside the tenant home (it holds root-owned hooks)"
}
require_linux() {
  if [ "$(uname -s)" != Linux ]; then
    if [ "$DRY" = 1 ]; then warn "this is the Linux provisioner and this host is $(uname -s); printing the plan only"; else die "this is the Linux provisioner; this host is $(uname -s)"; fi
  fi
}
need_kit_file() {
  if [ ! -f "$KIT/$1" ]; then
    if [ "$DRY" = 1 ]; then warn "kit file $1 is missing (the real run stops here)"; else die "kit file $KIT/$1 is missing: re-render and copy the whole host/ directory"; fi
  fi
}

# ── state probes (real runs only) ──────────────────────────────────────────────────────────────
user_exists() { getent passwd "$T_USER" >/dev/null 2>&1; }
group_exists() { getent group "$T_GROUP" >/dev/null 2>&1; }
ids_free_or_ours() {
  local u g
  u="$(getent passwd "$T_UID" 2>/dev/null | cut -d: -f1)" || u=""
  g="$(getent group "$T_GID" 2>/dev/null | cut -d: -f1)" || g=""
  [ -z "$u" ] || [ "$u" = "$T_USER" ] || { warn "uid ${T_UID} belongs to ${u}"; return 1; }
  [ -z "$g" ] || [ "$g" = "$T_GROUP" ] || { warn "gid ${T_GID} belongs to group ${g}"; return 1; }
  if user_exists; then
    [ "$(getent passwd "$T_USER" | cut -d: -f3)" = "$T_UID" ] || { warn "user ${T_USER} exists with another uid"; return 1; }
    [ "$(getent passwd "$T_USER" | cut -d: -f6)" = "$T_HOME" ] || { warn "user ${T_USER} exists with another home"; return 1; }
  fi
  return 0
}
root_dir_ours_or_absent() {
  [ -e "$ROOT_DIR" ] || return 0
  [ "$(stat -c %u "$ROOT_DIR")" = 0 ] || { warn "${ROOT_DIR} exists and is not owned by root"; return 1; }
  [ -z "$(ls -A "$ROOT_DIR" 2>/dev/null)" ] || [ -f "$CONF_FILE" ] || { warn "${ROOT_DIR} is not empty and has no ${CONF_FILE}: not ours"; return 1; }
}
has_acl() { sudo_q getfacl -p "$1" 2>/dev/null | grep -F -x -c "user:${T_USER}:---" >/dev/null; }
have_setfacl() { command -v setfacl >/dev/null 2>&1; }
have_chattr() { command -v chattr >/dev/null 2>&1; }
home_locked() { [ "$(sudo_q stat -c '%u:%g %a' "$T_HOME")" = "${T_UID}:${T_GID} 700" ]; }
primary_gid_ok() { [ "$(getent passwd "$T_USER" | cut -d: -f4)" = "$T_GID" ]; }
unprivileged() {
  case " $(id -Gn "$T_USER") " in
    *" sudo "* | *" wheel "* | *" admin "* | *" adm "* | *" docker "* | *" lxd "* | *" systemd-journal "*) return 1 ;;
  esac
}
no_ssh_dir() { ! sudo_q test -e "$T_HOME/.ssh"; }
tenant_cannot_list() { ! tenant_q /bin/ls "$1" >/dev/null 2>&1; }
tenant_refused() { ! tenant_q timeout 3 /bin/bash -c 'exec 3<>"/dev/tcp/$1/$2"' probe "$1" "$2" >/dev/null 2>&1; }
dir_absent() { ! sudo_q test -e "$1"; }
tarball_ok() { sudo_q test -f "$TARBALL_PATH" && [ "$(sudo_q sha256sum "$TARBALL_PATH" | awk '{ print $1 }')" = "$RUNNER_SHA" ]; }
runner_extracted() { [ "$(sudo_q cat "$TARBALL_MARKER" 2>/dev/null || true)" = "$RUNNER_SHA" ] && sudo_q test -x "$RUNNER_DIR/config.sh"; }
unit_inactive() { ! systemctl is-active --quiet "$1" 2>/dev/null; }
tenant_procs() { pgrep -u "$T_UID" 2>/dev/null || true; }
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
install_root() { priv install -o root -g root -m "$1" "$2" "$3"; }
pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo apt; elif command -v dnf >/dev/null 2>&1; then echo dnf; else echo none; fi
}

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
  local free p a ah listen
  say "preflight (read-only) for tenant ${T_NAME}, kit v${KIT_VERSION} — Linux support is BETA"
  if [ "$(uname -s)" = Linux ]; then pf_result OK "Linux $(uname -r)"; else pf_result FAIL "not Linux ($(uname -s))"; fi
  if [ -d /run/systemd/system ]; then pf_result OK "systemd is PID 1"; else pf_result FAIL "systemd is not running (the runner unit needs it)"; fi
  pf_result OK "running as $(id -un) (not root, not ${T_USER})"
  if command -v sudo >/dev/null 2>&1; then pf_result OK "sudo found: install, firewall and register will ask for your password"; else pf_result FAIL "sudo not found"; fi
  if ids_free_or_ours; then
    if user_exists; then pf_result OK "user ${T_USER} (uid ${T_UID}) already exists and matches the profile (re-run path)"; else pf_result OK "uid ${T_UID}, gid ${T_GID} and ${T_USER}/${T_GROUP} are free"; fi
  else
    pf_result FAIL "uid/gid/name clash for ${T_USER} (${T_UID}:${T_GID})"
  fi
  if root_dir_ours_or_absent; then pf_result OK "${ROOT_DIR}: absent or ours"; else pf_result FAIL "${ROOT_DIR} is not ours"; fi
  if listen="$(ss -Hltn 2>/dev/null | awk '{ print $4 }')"; then
    for p in $PORTS; do
      if printf '%s\n' "$listen" | grep -E -c ":${p}\$" >/dev/null; then
        if user_exists; then pf_result WARN "port ${p} is in use (a ${T_NAME} job may be running)"; else pf_result FAIL "port ${p} is already in use"; fi
      else
        pf_result OK "port ${p} is free"
      fi
    done
  else
    pf_result WARN "ports: ss unreadable"
  fi
  free="$(df -Pk "$(dirname "$T_HOME")" 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }')" || free=""
  if [ -z "$free" ]; then pf_result WARN "free disk: unreadable"; elif [ "$free" -lt "$DISK_FLOOR_GB" ]; then pf_result FAIL "free disk ${free} GB is below the floor of ${DISK_FLOOR_GB} GB"; else pf_result OK "free disk ${free} GB (floor ${DISK_FLOOR_GB} GB)"; fi
  case "$DISK_ENCRYPTION" in
    luks) pf_result WARN "LUKS: after a reboot nothing (the runner included) starts until the disk is unlocked, unless it unlocks automatically (TPM / network unlock)" ;;
    none) pf_result WARN "disk encryption: none (profile)" ;;
    *) pf_result WARN "disk encryption: ${DISK_ENCRYPTION} (profile)" ;;
  esac
  if have_setfacl; then pf_result OK "setfacl available: other admins' homes get a deny entry for ${T_USER}"; else pf_result WARN "setfacl not found (package acl): other admins' homes are only as private as their mode; consider chmod o-rwx on them"; fi
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    if [ -d "$ah" ]; then pf_result OK "${a}'s home ${ah}"; else pf_result WARN "${a} has no home at ${ah}"; fi
  done
  case "$(pkg_manager)" in
    none) if [ "$PG_INSTALL" = package ] || [ "$REDIS_INSTALL" = package ]; then pf_result FAIL "a service uses install=package but neither apt-get nor dnf exists"; fi ;;
    *) pf_result OK "package manager: $(pkg_manager)" ;;
  esac
  if [ "$NETWORK" = 1 ]; then
    if command -v nft >/dev/null 2>&1 || [ -x /usr/sbin/nft ]; then pf_result OK "nft found: run 'provision.sh firewall' after install, before register"; else pf_result FAIL "isolation.network is on but nft (nftables) is not installed"; fi
  else
    pf_result WARN "network isolation is off in the profile: ${T_USER} can reach every LAN and loopback service"
  fi
  if [ "$FAILS" -gt 0 ]; then
    say "preflight: ${FAILS} check(s) failed"
    return 1
  fi
  say "preflight: ok"
}

# ── services from distro packages (install=package) ────────────────────────────────────────────
install_packages() {
  local pm
  pm="$(pkg_manager)"
  if [ "$PG_INSTALL" = package ] || [ "$REDIS_INSTALL" = package ]; then
    if [ "$DRY" = 1 ] || [ "$pm" = apt ]; then priv apt-get update -q; fi
  fi
  if [ "$PG_INSTALL" = package ]; then
    if [ "$DRY" = 0 ] && [ "$pm" = apt ] && ! apt-cache show "postgresql-${PG_MAJOR}" >/dev/null 2>&1; then
      die "postgresql-${PG_MAJOR} is not in your apt sources: add the PostgreSQL project's apt repository first, or switch the service to install: source"
    fi
    if [ "$DRY" = 1 ] || [ "$pm" = apt ]; then priv apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}"; fi
    if [ "$DRY" = 1 ]; then printf '    (on dnf hosts instead: %s)\n' "$(show sudo dnf install -y "postgresql${PG_MAJOR}-server")"; elif [ "$pm" = dnf ]; then priv dnf install -y "postgresql${PG_MAJOR}-server"; fi
    if [ "$DRY" = 0 ] && [ "$pm" = none ]; then die "postgres install=package needs apt-get or dnf"; fi
    say "note: the distro package may start its own cluster on port 5432. ${T_USER}'s jobs never use it (they start their own on their port); disable it if nothing else needs it."
    # derived.postgres.bin is <optDir>/postgresql-<major>/bin: point it at the package's prefix.
    if [ "$DRY" = 1 ] || [ "$pm" = apt ]; then as_tenant /bin/ln -sfn "/usr/lib/postgresql/${PG_MAJOR}" "$PG_PREFIX"; fi
    if [ "$DRY" = 1 ]; then printf '    (on dnf hosts instead: link to /usr/pgsql-%s)\n' "$PG_MAJOR"; elif [ "$pm" = dnf ]; then as_tenant /bin/ln -sfn "/usr/pgsql-${PG_MAJOR}" "$PG_PREFIX"; fi
    check "postgres ${PG_MAJOR} binaries reachable at ${PG_PREFIX}/bin" tenant_q test -x "$PG_PREFIX/bin/postgres"
  fi
  if [ "$REDIS_INSTALL" = package ]; then
    if [ "$DRY" = 1 ] || [ "$pm" = apt ]; then priv apt-get install -y --no-install-recommends redis-server; fi
    if [ "$DRY" = 1 ]; then printf '    (on dnf hosts instead: %s)\n' "$(show sudo dnf install -y redis)"; elif [ "$pm" = dnf ]; then priv dnf install -y redis; fi
    say "note: the distro package may start its own redis on port 6379; ${T_USER}'s jobs never use it."
    as_tenant /bin/mkdir -p "$REDIS_PREFIX/bin"
    as_tenant /bin/ln -sfn /usr/bin/redis-server "$REDIS_PREFIX/bin/redis-server"
    as_tenant /bin/ln -sfn /usr/bin/redis-cli "$REDIS_PREFIX/bin/redis-cli"
  fi
}

# ── install ────────────────────────────────────────────────────────────────────────────────────
cmd_install() {
  local a ah f kind mode
  require_linux
  for f in hooks/lib.sh hooks/job-started.sh hooks/job-completed.sh conf/tenant.conf runner/.env runner/.path systemd/runner.service; do need_kit_file "$f"; done
  say "install for tenant ${T_NAME} (kit v${KIT_VERSION}, Linux BETA)$([ "$DRY" = 1 ] && echo ' — DRY RUN, nothing is executed')"
  run /bin/bash -c 'cd "$1" && sha256sum -c --quiet SHA256SUMS' verify-kit "$KIT"
  if [ "$DRY" = 0 ]; then
    ids_free_or_ours || die "the profile's uid/gid/names clash with an existing account (run preflight)"
    root_dir_ours_or_absent || die "${ROOT_DIR} is not ours (run preflight)"
  fi
  run sudo -v

  say "1/7 system group and user (no password, no login shell)"
  if [ "$T_GROUP" = "$T_USER" ] && [ "$T_GID" = "$T_UID" ]; then
    skip_if user_exists -- priv useradd --system --create-home --home-dir "$T_HOME" --shell /usr/sbin/nologin \
      --uid "$T_UID" --user-group --comment "homeactions CI runner ${T_NAME}" "$T_USER"
  else
    skip_if group_exists -- priv groupadd --system --gid "$T_GID" "$T_GROUP"
    skip_if user_exists -- priv useradd --system --create-home --home-dir "$T_HOME" --shell /usr/sbin/nologin \
      --uid "$T_UID" --gid "$T_GID" --comment "homeactions CI runner ${T_NAME}" "$T_USER"
  fi
  check "user ${T_USER} has uid ${T_UID} and home ${T_HOME}" ids_free_or_ours
  priv chown "${T_USER}:${T_GROUP}" "$T_HOME"
  priv chmod 700 "$T_HOME"

  say "2/7 deny ${T_USER} every other admin's home"
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    if [ "$DRY" = 0 ] && [ ! -d "$ah" ]; then
      warn "${a} has no home at ${ah}; skipping"
      continue
    fi
    if [ "$DRY" = 1 ] || have_setfacl; then
      skip_if has_acl "$ah" -- priv setfacl -m "$ACL_ENTRY" "$ah"
    else
      warn "setfacl is not installed (package acl): ${ah} stays as private as its mode; run: sudo chmod o-rwx ${ah}"
    fi
  done

  say "3/7 identity assertions"
  check "${T_USER}'s home is ${T_UID}:${T_GID} mode 700" home_locked
  check "${T_USER}'s primary group is ${T_GROUP} (${T_GID})" primary_gid_ok
  check "${T_USER} is in no sudo/wheel/admin/adm/docker/lxd/systemd-journal group" unprivileged
  check "${T_USER} has no ~/.ssh" no_ssh_dir
  for a in $OTHER_ADMINS; do
    ah="$(admin_home "$a")"
    [ "$DRY" = 1 ] || [ -d "$ah" ] || continue
    check "${T_USER} cannot list ${ah}" tenant_cannot_list "$ah"
  done

  say "4/7 tenant directories"
  as_tenant /bin/mkdir -p "$RUNNER_DIR" "$TMP_DIR" "$CACHE_DIR" "$OPT_DIR" "$SRC_DIR" "$STATE_DIR" "$LOG_DIR"

  say "5/7 root-owned hooks and config in ${ROOT_DIR}"
  priv install -d -o root -g root -m 0755 "$ROOT_DIR" "$HOOKS_DIR" "$ROOT_DIR/services" "$ROOT_DIR/smoke"
  priv install -o root -g root -m 0755 "$KIT/hooks/lib.sh" "$KIT/hooks/job-started.sh" "$KIT/hooks/job-completed.sh" "$HOOKS_DIR/"
  install_root 0644 "$KIT/conf/tenant.conf" "$CONF_FILE"
  if [ -f "$KIT/maintenance.sh" ]; then install_root 0755 "$KIT/maintenance.sh" "$ROOT_DIR/maintenance.sh"; fi
  for f in "$KIT"/services/*.sh "$KIT"/smoke/*; do
    [ -f "$f" ] || continue
    install_root 0755 "$f" "$ROOT_DIR/$(basename "$(dirname "$f")")/$(basename "$f")"
  done

  say "6/7 services"
  install_packages
  for kind in postgres redis; do
    case "$kind" in postgres) mode="$PG_INSTALL" ;; redis) mode="$REDIS_INSTALL" ;; esac
    [ "$mode" = source ] || continue
    if [ -f "$KIT/services/build-${kind}.sh" ] || [ "$DRY" = 1 ]; then
      as_tenant /bin/bash --noprofile --norc "$ROOT_DIR/services/build-${kind}.sh"
    else
      die "the profile builds ${kind} from source but the kit has no services/build-${kind}.sh"
    fi
  done

  say "7/7 runner ${RUNNER_VERSION}, downloaded as ${T_USER} and checked against its pinned sha256"
  skip_if tarball_ok -- as_tenant curl -fsSL --retry 3 -o "$TARBALL_PATH" "$RUNNER_URL"
  as_tenant /bin/bash --noprofile --norc -c 'printf "%s  %s\n" "$1" "$2" | sha256sum -c -' sha256 "$RUNNER_SHA" "$TARBALL_PATH"
  skip_if runner_extracted -- as_tenant tar -xzf "$TARBALL_PATH" -C "$RUNNER_DIR"
  as_tenant /bin/bash --noprofile --norc -c 'printf "%s\n" "$1" > "$2"' marker "$RUNNER_SHA" "$TARBALL_MARKER"
  say "the runner's own dependency check: ${RUNNER_DIR}/bin/installdependencies.sh lists missing libraries (ICU, libssl); run it with sudo if config.sh complains"

  say "install done. No unit is started yet."
  if [ "$NETWORK" = 1 ]; then say "next: bash provision.sh firewall, then bash provision.sh register"; else say "next: bash provision.sh register"; fi
}

# ── firewall (nftables) ────────────────────────────────────────────────────────────────────────
nft_table_loaded() { sudo_q nft list table inet "$NFT_TABLE" >/dev/null 2>&1; }
internet_ok() { [ "$(tenant_q curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.github.com/zen 2>/dev/null)" = 200 ]; }
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
  require_linux
  [ "$NETWORK" = 1 ] || die "isolation.network is off in the profile: there is no firewall to load"
  for f in nftables/tenant.nft nftables/nft-load.sh systemd/firewall.service; do need_kit_file "$f"; done
  if [ "$DRY" = 0 ]; then user_exists || die "user ${T_USER} does not exist yet: run install first"; fi
  run sudo -v
  priv install -d -o root -g root -m 0755 "$ROOT_DIR"
  install_root 0644 "$KIT/nftables/tenant.nft" "$NFT_RULES"
  install_root 0755 "$KIT/nftables/nft-load.sh" "$NFT_LOADER"
  priv /bin/bash "$NFT_LOADER" check
  install_root 0644 "$KIT/systemd/firewall.service" "$FIREWALL_UNIT_FILE"
  priv systemd-analyze verify "$FIREWALL_UNIT_FILE"
  priv systemctl daemon-reload
  priv systemctl enable "$FIREWALL_UNIT"
  priv systemctl restart "$FIREWALL_UNIT"
  priv nft list table inet "$NFT_TABLE"
  check "table inet ${NFT_TABLE} is loaded" nft_table_loaded
  probe_all_refused
  check "${T_USER} still reaches the internet (api.github.com)" internet_ok
  say "firewall loaded: table inet ${NFT_TABLE}, re-applied at boot by ${FIREWALL_UNIT}"
}
cmd_firewall_unload() {
  require_linux
  run sudo -v
  skip_if unit_inactive "$FIREWALL_UNIT" -- priv systemctl disable --now "$FIREWALL_UNIT"
  skip_if dir_absent "$NFT_LOADER" -- priv /bin/bash "$NFT_LOADER" unload
  priv rm -f "$FIREWALL_UNIT_FILE" "$NFT_RULES" "$NFT_LOADER"
  priv systemctl daemon-reload
  say "firewall unloaded"
}

# ── register ───────────────────────────────────────────────────────────────────────────────────
firewall_active() {
  local t h p
  systemctl is-active --quiet "$FIREWALL_UNIT" || { warn "${FIREWALL_UNIT} is not active"; return 1; }
  nft_table_loaded || { warn "table inet ${NFT_TABLE} is not loaded"; return 1; }
  t="${PROBES%% *}"
  if [ -n "$t" ]; then
    h="${t%:*}"
    p="${t##*:}"
    h="${h#[}"
    h="${h%]}"
    tenant_refused "$h" "$p" || { warn "${T_USER} can still reach ${t}"; return 1; }
  fi
}
listener_ok() {
  local n=0 line
  while [ "$n" -lt 30 ]; do
    line="$(ps -eo uid=,ni=,args= | awk -v u="$T_UID" '$1 == u && /Runner\.Listener/ { print $1, $2; exit }')"
    if [ -n "$line" ]; then
      [ "$line" = "${T_UID} ${NICE}" ] && return 0
      warn "Runner.Listener runs as uid/nice ${line}, expected ${T_UID} ${NICE}"
      return 1
    fi
    sleep 1
    n=$((n + 1))
  done
  warn "no Runner.Listener of uid ${T_UID} after 30 s (journalctl -u ${RUNNER_UNIT})"
  return 1
}
immutable() {
  local f
  for f in "$@"; do
    if [ "$DRY" = 1 ] || have_chattr; then
      priv chattr +i "$f" || warn "chattr +i failed on ${f} (filesystem without immutable support?); it stays root-owned 0644"
    else
      warn "chattr not found: ${f} stays root-owned 0644 but not immutable"
    fi
  done
}
mutable() {
  local f
  for f in "$@"; do
    if [ "$DRY" = 1 ]; then
      show sudo chattr -i "$f"
      printf '    (when %s exists)\n' "$f"
    elif sudo_q test -e "$f" && have_chattr; then
      priv chattr -i "$f" || true
    fi
  done
}
cmd_register() {
  local token rc
  require_linux
  need_kit_file runner/.env
  need_kit_file runner/.path
  need_kit_file systemd/runner.service
  if [ "$DRY" = 0 ]; then user_exists || die "user ${T_USER} does not exist: run install first"; fi
  run sudo -v
  check "the runner is extracted in ${RUNNER_DIR}" sudo_q test -x "$RUNNER_DIR/config.sh"
  if [ "$NETWORK" = 1 ]; then
    check "the firewall is active (${FIREWALL_UNIT} active, table loaded, ${T_USER} refused by ${PROBES%% *})" firewall_active
  fi

  say "1/5 stop the runner unit and every ${T_USER} process (a same-uid process could read the token from /proc/<pid>/environ)"
  skip_if unit_inactive "$RUNNER_UNIT" -- priv systemctl stop "$RUNNER_UNIT"
  kill_tenant
  mutable "$RUNNER_DIR/.env" "$RUNNER_DIR/.path"
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
  immutable "$RUNNER_DIR/.env" "$RUNNER_DIR/.path"

  say "4/5 hardened systemd unit ${RUNNER_UNIT}"
  as_tenant /bin/cp "$RUNNER_DIR/bin/runsvc.sh" "$RUNNER_DIR/runsvc.sh"
  as_tenant /bin/chmod 755 "$RUNNER_DIR/runsvc.sh"
  as_tenant /bin/mkdir -p "$LOG_DIR"
  install_root 0644 "$KIT/systemd/runner.service" "$RUNNER_UNIT_FILE"
  priv systemd-analyze verify "$RUNNER_UNIT_FILE"
  priv systemctl daemon-reload
  priv systemctl enable "$RUNNER_UNIT"

  say "5/5 start it"
  priv systemctl restart "$RUNNER_UNIT"
  check "Runner.Listener runs as uid ${T_UID} at nice ${NICE}" listener_ok
  say "registered ${RUNNER_NAME} on ${REPO_SLUG} with labels self-hosted + ${RUNNER_LABELS}. Next: bash provision.sh verify"
}

# ── verify (read-only, no sudo) ────────────────────────────────────────────────────────────────
cmd_verify() {
  local st line f
  say "verify (read-only, no sudo) for tenant ${T_NAME}"
  if user_exists; then
    if [ "$(getent passwd "$T_USER" | cut -d: -f3)" = "$T_UID" ]; then pf_result OK "user ${T_USER} uid ${T_UID}"; else pf_result FAIL "user ${T_USER} has another uid"; fi
    if unprivileged; then pf_result OK "${T_USER} is in no privileged group"; else pf_result FAIL "${T_USER} is in a privileged group"; fi
    case "$(getent passwd "$T_USER" | cut -d: -f7)" in */nologin | */false) pf_result OK "${T_USER} has no login shell" ;; *) pf_result WARN "${T_USER} has a login shell" ;; esac
  else
    pf_result FAIL "user ${T_USER} does not exist"
  fi
  if st="$(stat -c '%u %a' "$T_HOME" 2>/dev/null)"; then
    if [ "$st" = "${T_UID} 700" ]; then pf_result OK "${T_HOME} is ${T_USER}'s, mode 700"; else pf_result FAIL "${T_HOME} owner/mode is ${st}"; fi
  else
    pf_result FAIL "${T_HOME}: absent or unreadable"
  fi
  for f in "$ROOT_DIR" "$HOOKS_DIR" "$HOOKS_DIR/lib.sh" "$HOOKS_DIR/job-started.sh" "$HOOKS_DIR/job-completed.sh" "$CONF_FILE" "$RUNNER_UNIT_FILE"; do
    if st="$(stat -c '%u %A' "$f" 2>/dev/null)"; then
      case "$st" in
        "0 "?????w* | "0 "????????w*) pf_result FAIL "${f} is group/other-writable (${st})" ;;
        "0 "*) pf_result OK "${f} is root-owned (${st#0 })" ;;
        *) pf_result FAIL "${f} is not root-owned (${st})" ;;
      esac
    else
      pf_result FAIL "${f}: absent or unreadable"
    fi
  done
  if [ -d "$T_HOME" ] && [ ! -x "$T_HOME" ]; then
    pf_result WARN "${RUNNER_DIR}/.env and .path: unreadable from this account (${T_HOME} is 700, which is correct); check with sudo lsattr ${RUNNER_DIR}/.env ${RUNNER_DIR}/.path"
  fi
  if systemctl is-active --quiet "$RUNNER_UNIT" 2>/dev/null; then pf_result OK "${RUNNER_UNIT} active"; else pf_result FAIL "${RUNNER_UNIT} not active"; fi
  line="$(ps -eo uid=,ni=,args= | awk -v u="$T_UID" '$1 == u && /Runner\.Listener/ { print $1, $2; exit }')"
  if [ -z "$line" ]; then pf_result FAIL "no Runner.Listener running as uid ${T_UID}"; elif [ "$line" = "${T_UID} ${NICE}" ]; then pf_result OK "Runner.Listener runs as uid ${T_UID} at nice ${NICE}"; else pf_result FAIL "Runner.Listener uid/nice is ${line}"; fi
  if [ "$NETWORK" = 1 ]; then
    if systemctl is-active --quiet "$FIREWALL_UNIT" 2>/dev/null; then pf_result OK "${FIREWALL_UNIT} active"; else pf_result FAIL "${FIREWALL_UNIT} not active"; fi
    pf_result WARN "nft rules need root to list: sudo nft list table inet ${NFT_TABLE}   (every rule carries meta skuid ${T_UID})"
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
