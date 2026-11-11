#!/bin/bash
# smoke-probes.sh: run INSIDE a job on runner {{tenant.runnerName}} (the smoke workflow). Prints one line
# per check, "PASS|FAIL|INFO <check>: <detail>", and exits 1 if any check failed. Read-only. Bash 3.2.
set -u -o pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
for f in "$HERE/../conf/tenant.conf" "{{derived.confFile}}"; do if [ -r "$f" ]; then . "$f"; break; fi; done
for f in "$HERE/../hooks/lib.sh" "{{derived.hooksDir}}/lib.sh"; do if [ -r "$f" ]; then . "$f"; break; fi; done
command -v hook_log >/dev/null 2>&1 || { echo "FAIL setup: cannot find tenant.conf and hooks/lib.sh"; exit 1; }
FAILS=0
pass() { printf 'PASS %s: %s\n' "$1" "$2"; }
fail() { printf 'FAIL %s: %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }
info() { printf 'INFO %s: %s\n' "$1" "$2"; }
under() { case "${2:-}" in "$1"|"$1"/*) return 0 ;; *) return 1 ;; esac; }

# identity
u="$(id -un)"; g="$(id -gn)"
if [ "$u" = "$HA_USER" ] && [ "$g" = "$HA_GROUP" ]; then pass identity "$u:$g"; else fail identity "$u:$g, want $HA_USER:$HA_GROUP"; fi
bad=""; gs=" $(id -Gn) "
for grp in $HA_FORBIDDEN_GROUPS; do case "$gs" in *" $grp "*) bad="$bad $grp" ;; esac; done
if [ -z "$bad" ]; then pass groups "no admin-equivalent group ($(id -Gn))"; else fail groups "member of:$bad"; fi

# forbidden paths
for p in $HA_FORBIDDEN_READ; do
  if ls "$p" >/dev/null 2>&1; then fail forbidden-read "$p is readable"; else pass forbidden-read "$p is not readable"; fi
done

# PATH: nothing from a shared package manager
case ":$PATH:" in *:/opt/homebrew*|*:/usr/local/*|*:/usr/local:*) fail path "PATH has /opt/homebrew or /usr/local: $PATH" ;; *) pass path "$PATH" ;; esac
if command -v brew >/dev/null 2>&1; then fail brew "brew is on PATH ($(command -v brew))"; else pass brew "brew is not on PATH"; fi

# network
if [ "$HA_NETWORK_ISOLATION" = 1 ]; then
  for t in $HA_PROBES; do
    if probe_connects "${t%:*}" "${t##*:}"; then fail network-probe "$t is reachable"; else pass network-probe "$t is refused"; fi
  done
else
  info network-probe "network isolation is off in the profile"
fi
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://api.github.com/zen 2>/dev/null)"
if [ "$code" = 200 ]; then pass internet "api.github.com HTTP 200"; else fail internet "api.github.com HTTP ${code:-none}"; fi

# wiring
for f in "$HA_RUNNER_DIR/.env" "$HA_RUNNER_DIR/.path"; do
  p="$(root_immutable_problem "$f")"
  if [ -z "$p" ]; then pass wiring "$f is root-owned and immutable"; else fail wiring "$p"; fi
done
if [ -w "$HA_HOOKS_DIR" ]; then fail wiring "$HA_HOOKS_DIR is writable"; else pass wiring "$HA_HOOKS_DIR is not writable"; fi

# limits
nofile="$(ulimit -n)"
if [ "$nofile" = unlimited ] || { [ "$nofile" -ge "$HA_OPEN_FILES" ] 2>/dev/null; }; then pass open-files "ulimit -n $nofile"; else fail open-files "ulimit -n $nofile < $HA_OPEN_FILES"; fi
nice_now="$(ps -o nice= -p $$ 2>/dev/null | tr -d ' ')"
if [ "${nice_now:-0}" -ge "$HA_NICE" ] 2>/dev/null; then pass nice "$nice_now"; else fail nice "${nice_now:-unknown} < $HA_NICE"; fi
if [ "${TZ:-}" = UTC ]; then pass tz UTC; else fail tz "TZ=${TZ:-unset}"; fi

# temp and caches inside the tenant's own directories
tmpd="${TMPDIR:-}"
if under "$HA_TMP_DIR" "${tmpd%/}"; then pass tmpdir "$tmpd"; else fail tmpdir "TMPDIR=${TMPDIR:-unset}, want under $HA_TMP_DIR"; fi
for v in PLAYWRIGHT_BROWSERS_PATH XDG_CACHE_HOME pnpm_config_store_dir npm_config_cache; do
  eval "val=\${$v:-}"
  # shellcheck disable=SC2154
  if under "$HA_CACHE_DIR" "$val"; then pass cache "$v=$val"; else fail cache "$v=${val:-unset}, want under $HA_CACHE_DIR"; fi
done
if command -v pnpm >/dev/null 2>&1; then
  sp="$(pnpm store path 2>/dev/null)"
  if under "$HA_CACHE_DIR" "$sp"; then pass pnpm-store "$sp"; else fail pnpm-store "${sp:-unknown}, want under $HA_CACHE_DIR"; fi
fi

# Spotlight (macOS): nothing of the tenant's should be indexed
if [ "$(ha_os)" = macos ]; then
  if n="$(mdfind -onlyin "$HOME" -count 'kMDItemFSName == "package.json"' 2>/dev/null)" && [ -n "$n" ]; then
    if [ "$n" = 0 ]; then pass spotlight "0 indexed package.json under $HOME"; else fail spotlight "$n package.json indexed under $HOME"; fi
  else
    info spotlight "unavailable"
  fi
fi

# services: versions, and loopback-only when running
svc_loopback() {   # <name> <port>
  local addrs a ok=1
  addrs="$(tcp_listen_table | listeners_on_ports "$2")"
  if [ -z "$addrs" ]; then info "$1-listen" "nothing listening on $2 now"; return 0; fi
  for a in $addrs; do is_loopback_addr "$a" || ok=0; done
  if [ "$ok" = 1 ]; then pass "$1-listen" "loopback only: $(echo $addrs)"; else fail "$1-listen" "listening off loopback: $(echo $addrs)"; fi
}
if [ -n "$HA_PG_BIN" ]; then
  pgv="$("${HOMEACTIONS_PG_BIN:-$HA_PG_BIN}/postgres" --version 2>/dev/null)"
  case "$pgv" in *"(PostgreSQL) ${HA_PG_VERSION%%.*}."*) pass postgres "$pgv" ;; *) fail postgres "${pgv:-no postgres in ${HOMEACTIONS_PG_BIN:-$HA_PG_BIN}}" ;; esac
  svc_loopback postgres "$HA_PG_PORT"
fi
if [ -n "$HA_REDIS_BIN" ]; then
  rv="$("${HOMEACTIONS_REDIS_BIN:-$HA_REDIS_BIN}/redis-server" --version 2>/dev/null)"
  case "$rv" in *"v=${HA_REDIS_VERSION%%.*}."*) pass redis "$rv" ;; *) fail redis "${rv:-no redis-server in ${HOMEACTIONS_REDIS_BIN:-$HA_REDIS_BIN}}" ;; esac
  svc_loopback redis "$HA_REDIS_PORT"
fi

if [ "$FAILS" -gt 0 ]; then printf '::error::%s smoke: %s check(s) failed\n' "$HA_BANNER" "$FAILS"; exit 1; fi
hook_log "smoke: all checks passed"
exit 0
