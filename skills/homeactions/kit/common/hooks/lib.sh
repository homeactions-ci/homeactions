#!/bin/bash
# Shared code of the homeactions job hooks for tenant {{tenant.name}}, also used by maintenance.sh and
# the smoke scripts. Installed root-owned at {{derived.hooksDir}}/lib.sh. Bash 3.2.
# Sourcing it only defines functions and constants. The tests source it and override the I/O helpers
# (pid_alive, sleep, date, id, memory_pressure_level, swap_used_mb, tcp_listen_table, own_processes, ...).
# Rule for every check here: "unreadable" is a different answer from "absent" and is never "clear".
# shellcheck disable=SC2034
HOOK_VERSION=1
HA_BANNER="{{derived.banner}}"
hook_log()  { printf '%s %s\n' "$HA_BANNER" "$*"; }
hook_warn() { printf '::warning::%s %s\n' "$HA_BANNER" "$*"; }
hook_fail() { printf '::error::%s %s\n' "$HA_BANNER" "$*"; exit 1; }

ha_os() { case "$(uname -s 2>/dev/null)" in Darwin) echo macos ;; *) echo linux ;; esac; }

# ── small JSON readers (marker files are one JSON object; no jq on a stock host) ────────────────
# json_int_field <file> <key> <int|epoch>: the field as an integer (an epoch's fraction is dropped;
# a quoted numeric string counts, as Number() would). Exit 1 when the file or the field is unusable.
json_int_field() {
  local body num
  body="$(LC_ALL=C tr -d ' \t\r\n' < "$1" 2>/dev/null)" || return 1
  case "$body" in '{'*'}') ;; *) return 1 ;; esac
  if [ "$3" = epoch ]; then num='(-?[0-9]+)(\.[0-9]+)?'; else num='([0-9]+)'; fi
  body="$(printf '%s' "$body" | LC_ALL=C sed -nE 's/.*"'"$2"'":"?'"$num"'"?[,}].*/\1/p')"
  [ -n "$body" ] && printf '%s\n' "$body"
}
pid_alive() { ps -p "$1" -o pid= >/dev/null 2>&1; }   # ps sees every user's pids (EPERM from kill -0 == alive)
any_alive() { local p; for p in "$@"; do pid_alive "$p" && return 0; done; return 1; }

# run_bounded <seconds> <cmd...>: run cmd, TERM it after <seconds> (exit 143). No coreutils timeout on macOS.
run_bounded() {
  local secs="$1" pid w rc
  shift
  "$@" &
  pid=$!
  ( s=0; while [ "$s" -lt "$secs" ]; do /bin/sleep 1; kill -0 "$pid" 2>/dev/null || exit 0; s=$((s + 1)); done
    kill -TERM "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  w=$!
  wait "$pid"; rc=$?
  kill "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return "$rc"
}

# ── the co-tenant's busy signal: READ-ONLY, never written ───────────────────────────────────────
# cotenant_hold <now>: prints one line and returns
#   0, nothing                   clear
#   0, "<reason>"                a live hold
#   2, "unreadable: <detail>"    the signal exists but cannot be read (the hooks fail the job)
# Modes (HA_COTENANT_MODE from tenant.conf):
#   marker-dir  files matching HA_COTENANT_PID_GLOB in HA_COTENANT_MARKER_DIR are live iff their JSON
#               "pid" is a live process (any user; never judged by age); HA_COTENANT_EPOCH_FILE is live
#               iff 0 <= now - epoch <= HA_COTENANT_EPOCH_BOUND. ".tmp-*" files are ignored; a missing
#               directory or a malformed marker is not a hold; an unreadable one is "unreadable".
#   command     HA_COTENANT_COMMAND exits 0 = clear, non-zero = busy; missing/not executable = unreadable.
#   none        always clear.
cotenant_hold() {
  case "${HA_COTENANT_MODE:-none}" in
    marker-dir) cotenant_hold_markers "${HA_COTENANT_MARKER_DIR:-}" "${HA_COTENANT_PID_GLOB:-}" "${HA_COTENANT_EPOCH_FILE:-}" "${HA_COTENANT_EPOCH_BOUND:-0}" "$1" ;;
    command) cotenant_hold_command "${HA_COTENANT_COMMAND:-}" ;;
    *) return 0 ;;
  esac
}

# cotenant_hold_markers <dir> <pid_glob> <epoch_file> <epoch_bound> <now>
cotenant_hold_markers() {
  local dir="$1" glob="$2" efile="$3" bound="$4" now="$5" f name pid epoch age parent
  if [ ! -e "$dir" ]; then
    parent="${dir%/*}"; [ -n "$parent" ] || parent=/
    if [ -d "$parent" ] && { [ ! -r "$parent" ] || [ ! -x "$parent" ]; }; then
      printf 'unreadable: %s (cannot search %s)\n' "$dir" "$parent"; return 2
    fi
    return 0
  fi
  if [ ! -d "$dir" ] || [ ! -r "$dir" ] || [ ! -x "$dir" ]; then printf 'unreadable: %s\n' "$dir"; return 2; fi
  if [ -n "$glob" ]; then
    # shellcheck disable=SC2086
    for f in "$dir"/$glob; do
      [ -e "$f" ] || continue
      name="${f##*/}"
      case "$name" in .tmp-*|*.tmp-*) continue ;; esac
      [ -f "$f" ] || continue
      if [ ! -r "$f" ]; then printf 'unreadable: %s\n' "$f"; return 2; fi
      pid="$(json_int_field "$f" pid int)" || continue
      [ "$pid" -gt 0 ] 2>/dev/null || continue
      pid_alive "$pid" || continue
      printf 'cotenant marker %s (pid %s)\n' "$name" "$pid"; return 0
    done
  fi
  [ -n "$efile" ] || return 0
  case "$efile" in /*) f="$efile" ;; *) f="$dir/$efile" ;; esac
  [ -e "$f" ] || return 0
  if [ ! -r "$f" ]; then printf 'unreadable: %s\n' "$f"; return 2; fi
  epoch="$(json_int_field "$f" epoch epoch)" || return 0
  case "$epoch" in -*|'') return 0 ;; esac
  age=$(( now - 10#$epoch ))
  if [ "$age" -ge 0 ] && [ "$age" -le "$bound" ]; then printf 'cotenant intent %s (%ss old)\n' "${f##*/}" "$age"; fi
  return 0
}

# cotenant_hold_command <command line>: run read-only, bounded by HA_COTENANT_COMMAND_TIMEOUT (30 s).
cotenant_hold_command() {
  local cmd="$1" exe rc
  if [ -z "$cmd" ]; then printf 'unreadable: no co-tenant command configured\n'; return 2; fi
  exe="${cmd%% *}"
  case "$exe" in
    /*) if [ ! -f "$exe" ] || [ ! -x "$exe" ]; then printf 'unreadable: %s is missing or not executable\n' "$exe"; return 2; fi ;;
    *) if ! command -v "$exe" >/dev/null 2>&1; then printf 'unreadable: %s is not on PATH\n' "$exe"; return 2; fi ;;
  esac
  run_bounded "${HA_COTENANT_COMMAND_TIMEOUT:-30}" /bin/sh -c "$cmd" </dev/null >/dev/null 2>&1
  rc=$?
  case "$rc" in
    0) return 0 ;;
    126|127) printf 'unreadable: %s could not run (exit %s)\n' "$exe" "$rc"; return 2 ;;
    143) printf 'unreadable: %s timed out\n' "$exe"; return 2 ;;
    *) printf 'cotenant busy (%s exit %s)\n' "${exe##*/}" "$rc"; return 0 ;;
  esac
}

# ── host pressure ───────────────────────────────────────────────────────────────────────────────
# memory_pressure_level: 1 normal, 2 warn, 4 critical. macOS: kern.memorystatus_vm_pressure_level.
# Linux: /proc/pressure/memory "some avg10" (>= 10 % warn, >= 40 % critical); 1 when PSI is absent.
memory_pressure_level() {
  local v=""
  if [ "$(ha_os)" = macos ]; then v="$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
  elif [ -r /proc/pressure/memory ]; then v="$(psi_level < /proc/pressure/memory)"; fi
  case "$v" in ''|*[!0-9]*) v=1 ;; esac
  printf '%s\n' "$v"
}
psi_level() { awk '$1 == "some" { for (i = 2; i <= NF; i++) if ($i ~ /^avg10=/) { v = substr($i, 7) + 0; print (v >= 40 ? 4 : (v >= 10 ? 2 : 1)); exit } }'; }
# parse_swapusage_mb (stdin: macOS `sysctl -n vm.swapusage`, "total = 2048.00M  used = 1024.50M  free = ...")
parse_swapusage_mb() {
  awk '{ for (i = 1; i < NF; i++) if ($i == "used" && $(i + 1) == "=") { v = $(i + 2); u = substr(v, length(v)); n = v + 0
         if (u == "G") n = n * 1024; else if (u == "K") n = n / 1024; printf "%d\n", n; exit } }'
}
# parse_meminfo_swap_mb (stdin: /proc/meminfo): SwapTotal - SwapFree, in MB.
parse_meminfo_swap_mb() { awk '$1 == "SwapTotal:" { t = $2 } $1 == "SwapFree:" { f = $2 } END { if (t != "") printf "%d\n", (t - f) / 1024 }'; }
# swap_used_mb: prints nothing when swap cannot be read (callers show "unknown"; the yield fails open).
swap_used_mb() {
  if [ "$(ha_os)" = macos ]; then sysctl -n vm.swapusage 2>/dev/null | parse_swapusage_mb
  elif [ -r /proc/meminfo ]; then parse_meminfo_swap_mb < /proc/meminfo; fi
}
load1() {
  if [ "$(ha_os)" = macos ]; then sysctl -n vm.loadavg 2>/dev/null | awk '{ print $2 }'
  else awk '{ print $1 }' /proc/loadavg 2>/dev/null; fi
}

# yield_reason <now>: why this job should wait, or nothing. Order: co-tenant hold, memory pressure
# critical, swap used over HA_SWAP_YIELD_MB (when > 0). Returns 2 (with "unreadable: ...") when the
# co-tenant signal cannot be read.
yield_reason() {
  local hold rc sw
  hold="$(cotenant_hold "$1")"; rc=$?
  if [ "$rc" -eq 2 ]; then printf '%s\n' "$hold"; return 2; fi
  if [ -n "$hold" ]; then printf '%s\n' "$hold"; return 0; fi
  if [ "$(memory_pressure_level)" -ge 4 ]; then printf 'memory pressure critical\n'; return 0; fi
  if [ "${HA_SWAP_YIELD_MB:-0}" -gt 0 ]; then
    sw="$(swap_used_mb)"
    case "$sw" in ''|*[!0-9]*) ;; *) if [ "$sw" -gt "$HA_SWAP_YIELD_MB" ]; then printf 'swap used %s MB over %s MB\n' "$sw" "$HA_SWAP_YIELD_MB"; fi ;; esac
  fi
  return 0
}

# run_yield: wait (read-only) while yield_reason says so, out of ONE budget per workflow run attempt
# (GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT) shared by all of the run's jobs, then proceed (fail-open).
# Sets YIELD_WAITED (seconds) and YIELD_FIRST_REASON.
run_yield() {
  local state used remaining reason rc budget poll
  YIELD_WAITED=0; YIELD_FIRST_REASON=""
  budget="${HA_YIELD_BUDGET_SECONDS:-0}"; poll="${HA_YIELD_POLL_SECONDS:-15}"
  mkdir -p "$HA_YIELD_STATE_DIR" 2>/dev/null
  find "$HA_YIELD_STATE_DIR" -type f -mtime +2 -exec rm -f {} + 2>/dev/null
  state="$HA_YIELD_STATE_DIR/${GITHUB_RUN_ID:-norun}-${GITHUB_RUN_ATTEMPT:-1}"
  used="$(cat "$state" 2>/dev/null)"; case "$used" in ''|*[!0-9]*) used=0 ;; esac
  remaining=$(( budget - used ))
  while :; do
    reason="$(yield_reason "$(date +%s)")"; rc=$?
    [ -n "$reason" ] || break
    if [ "$rc" -eq 2 ]; then hook_warn "co-tenant signal became $reason; starting without waiting (fail-open)"; break; fi
    if [ "$remaining" -le 0 ]; then hook_log "run budget of ${budget}s spent; starting anyway under: $reason (fail-open)"; break; fi
    if [ -z "$YIELD_FIRST_REASON" ]; then YIELD_FIRST_REASON="$reason"; hook_log "yielding to $reason (up to ${remaining}s left of this run's budget)"; fi
    sleep "$poll"
    YIELD_WAITED=$(( YIELD_WAITED + poll )); remaining=$(( remaining - poll ))
    printf '%s\n' "$(( used + YIELD_WAITED ))" > "$state" 2>/dev/null
  done
  return 0
}

# ── leftovers of this dedicated, single-runner user ─────────────────────────────────────────────
own_processes() { ps -U "$(id -u)" -o pid=,ppid=,args= 2>/dev/null; }
# reap_candidates <self_pid> (stdin: own_processes): everything EXCEPT the caller, its ancestors and
# descendants, the runner's own processes, and the OS per-user agents (macOS: /System, /usr/libexec,
# /usr/sbin, /Library/Apple; Linux: systemd --user, (sd-pam), dbus-daemon).
reap_candidates() {
  awk -v self="$1" '
    { pid = $1; par[pid] = $2; a = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*/, "", a); args[pid] = a; order[++n] = pid }
    END {
      keep[self] = 1; p = self
      for (k = 0; k < 64 && (p in par); k++) { p = par[p]; keep[p] = 1 }
      for (i = 1; i <= n; i++) {
        pid = order[i]; if (pid in keep) continue
        q = pid; mine = 0
        for (k = 0; k < 64 && (q in par); k++) { q = par[q]; if (q == self) { mine = 1; break } }
        if (mine) continue
        a = args[pid]; exe = a; sub(/[ \t].*$/, "", exe)
        if (a ~ /Runner\.(Listener|Worker|PluginHost)/ || a ~ /RunnerService\.js/ || a ~ /runsvc\.sh/) continue
        if (exe ~ /^\/(System|usr\/libexec|usr\/sbin|Library\/Apple)\//) continue
        if (a ~ /(^|\/)systemd[ \t]+--user/ || a ~ /^\(sd-pam\)/ || exe ~ /(^|\/)dbus-daemon$/) continue
        print pid
      }
    }'
}
postmaster_pids() { awk '{ a = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*/, "", a) } a ~ /(^|\/)postgres[ \t]/ && a ~ /[ \t]-D[ \t]/ { print $1 }'; }
redis_pids() { awk '{ a = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]*/, "", a) } a ~ /(^|\/)redis-server([ \t]|$)/ { print $1 }'; }
# reap_strays <label>: SIGQUIT leftover postmasters (immediate shutdown releases their SysV IPC) and
# TERM leftover redis-servers, then TERM every candidate, then KILL whatever is left after 5 s.
# Sets REAPED.
reap_strays() {
  local pm rs cands left i
  REAPED=0
  pm="$(own_processes | postmaster_pids)"
  if [ -n "$pm" ]; then
    hook_log "$1: immediate shutdown of leftover Postgres: $(echo $pm)"
    # shellcheck disable=SC2086
    kill -QUIT $pm 2>/dev/null
    # shellcheck disable=SC2086
    for i in 1 2 3 4 5 6 7 8 9 10; do any_alive $pm || break; sleep 1; done
  fi
  rs="$(own_processes | redis_pids)"
  if [ -n "$rs" ]; then
    hook_log "$1: stopping leftover redis-server: $(echo $rs)"
    # shellcheck disable=SC2086
    kill -TERM $rs 2>/dev/null
  fi
  cands="$(own_processes | reap_candidates "$$")"
  [ -n "$cands" ] || return 0
  REAPED="$(echo $cands | wc -w | tr -d ' ')"
  hook_log "$1: terminating $REAPED leftover process(es): $(own_processes | awk -v l=" $(echo $cands) " 'index(l, " " $1 " ") { $2 = ""; print substr($0, 1, 120) }' | tr '\n' ';')"
  # shellcheck disable=SC2086
  kill -TERM $cands 2>/dev/null
  for i in 1 2 3 4 5; do left="$(own_processes | reap_candidates "$$")"; [ -n "$left" ] || return 0; sleep 1; done
  # shellcheck disable=SC2086
  kill -KILL $left 2>/dev/null
  return 0
}
# ipc_ids <m|s> <user> (stdin: `ipcs -m` or `ipcs -s`, macOS or Linux format): the ids owned by user.
#   macOS: "m  65536 0x0052e2c1 --rw-------  user  group"     Linux: "0x0052e2c1 65536 user 600 ..."
ipc_ids() {
  awk -v t="$1" -v u="$2" '
    $1 == t && $5 == u { print $2; next }
    $1 ~ /^0x[0-9a-fA-F]+$/ && $3 == u { print $2 }'
}
# ipc_cleanup: drop this user's SysV shm/semaphores once no postmaster is left (macOS kern.sysv.shmmni is 32).
ipc_cleanup() {
  local me id
  [ -z "$(own_processes | postmaster_pids)" ] || return 0
  me="$(id -un)"
  for id in $(ipcs -m 2>/dev/null | ipc_ids m "$me"); do ipcrm -m "$id" 2>/dev/null; done
  for id in $(ipcs -s 2>/dev/null | ipc_ids s "$me"); do ipcrm -s "$id" 2>/dev/null; done
  return 0
}
# tmp_cleanup [min_age_minutes]: this user's own top-level entries in /tmp (macOS: /private/tmp).
tmp_cleanup() {
  local me
  me="$(id -un)"
  [ "$me" = "${HA_USER:-}" ] && [ "$me" != root ] || return 1
  if [ -n "${1:-}" ]; then find /tmp/ -mindepth 1 -maxdepth 1 -user "$me" -mmin +"$1" -exec rm -rf {} + 2>/dev/null
  else find /tmp/ -mindepth 1 -maxdepth 1 -user "$me" -exec rm -rf {} + 2>/dev/null; fi
  return 0
}
# workspace_wipe <work_root> <workspace>: delete the contents of <work_root>/<repo>, the directory that
# holds this job's checkout (GITHUB_WORKSPACE = <work_root>/<repo>/<repo>). Refuses anything that is
# not exactly one level below <work_root> (the runner's _work), and the runner's own _tool, _temp,
# _actions and _* directories. Prints what it wiped, or nothing. Returns 1 on a refusal.
workspace_wipe() {
  local root="$1" ws="$2" rel top dir real realroot
  [ -n "$root" ] && [ -n "$ws" ] || return 0
  case "$ws" in "$root"/*) ;; *) hook_warn "workspace $ws is outside $root; not wiped"; return 1 ;; esac
  case "/$ws/" in */../*|*/./*) hook_warn "workspace $ws is not a plain path; not wiped"; return 1 ;; esac
  rel="${ws#"$root"/}"; top="${rel%%/*}"
  case "$top" in ''|_*) hook_warn "workspace $ws resolves to a runner directory ($top); not wiped"; return 1 ;; esac
  dir="$root/$top"
  [ -d "$dir" ] || return 0
  if [ -L "$dir" ]; then hook_warn "$dir is a symlink; not wiped"; return 1; fi
  real="$(cd -P "$dir" 2>/dev/null && pwd -P)"; realroot="$(cd -P "$root" 2>/dev/null && pwd -P)"
  if [ -z "$real" ] || [ -z "$realroot" ] || [ "${real%/*}" != "$realroot" ]; then hook_warn "$dir does not resolve inside $root; not wiped"; return 1; fi
  find "$real" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  printf '%s\n' "$dir"
  return 0
}

# ── listeners ───────────────────────────────────────────────────────────────────────────────────
# tcp_listen_table: every user's listening TCP sockets. macOS `netstat -an -p tcp`; Linux `ss -ltnH`
# (or `netstat -ltn`).
tcp_listen_table() {
  if [ "$(ha_os)" = macos ]; then netstat -an -p tcp 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null
  else netstat -ltn 2>/dev/null; fi
}
# listeners_on_ports "<ports>" (stdin: tcp_listen_table): listening addresses on those ports.
#   macOS netstat: "tcp4  0  0  127.0.0.1.5442  *.*  LISTEN"   Linux ss: "LISTEN 0 4096 127.0.0.1:5442 0.0.0.0:*"
listeners_on_ports() {
  awk -v ports=" $1 " '
    { a = "" }
    $1 == "LISTEN" { a = $4 }
    $1 ~ /^tcp/ && $NF == "LISTEN" { a = $4 }
    a != "" { p = a; sub(/^.*[.:]/, "", p); if (index(ports, " " p " ")) print a }'
}
# own_tcp_listeners: this user's listening sockets as lsof -Fn "n<addr>:<port>" lines. Returns 2 when
# neither lsof nor ss can be used (unreadable).
own_tcp_listeners() {
  local uid
  uid="$(id -u)"
  if command -v lsof >/dev/null 2>&1; then lsof -nP -a -u "$uid" -iTCP -sTCP:LISTEN -Fn 2>/dev/null; return 0; fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnHe 2>/dev/null | awk -v u="uid:$uid" '{ for (i = 5; i <= NF; i++) if ($i == u) { print "n" $4; next } }'
    return 0
  fi
  return 2
}
# nonloopback_listeners (stdin: lsof -Fn): names not bound to loopback.
nonloopback_listeners() { awk '/^n/ { n = substr($0, 2); if (n !~ /^(127\.[0-9.]+|\[::1\]|\[::ffff:127\.[0-9.]+\]|localhost):[0-9]+$/) print n }'; }
# is_loopback_addr <addr> (netstat or ss spelling)
is_loopback_addr() { case "$1" in 127.*|::1.*|::1:*|'[::1]:'*|'[::ffff:127.'*|localhost:*) return 0 ;; *) return 1 ;; esac; }

# ── disk, files, network ────────────────────────────────────────────────────────────────────────
disk_free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'; }
file_owner() { if [ "$(ha_os)" = macos ]; then stat -f '%Su' "$1" 2>/dev/null; else stat -c '%U' "$1" 2>/dev/null; fi; }
file_mode() { if [ "$(ha_os)" = macos ]; then stat -f '%Lp' "$1" 2>/dev/null; else stat -c '%a' "$1" 2>/dev/null; fi; }
# file_immutable <file>: 0 immutable, 1 not, 3 cannot tell (Linux without lsattr).
file_immutable() {
  if [ "$(ha_os)" = macos ]; then
    case ",$(stat -f '%Sf' "$1" 2>/dev/null)," in *,uchg,*|*,schg,*) return 0 ;; *) return 1 ;; esac
  fi
  command -v lsattr >/dev/null 2>&1 || return 3
  case "$(lsattr -d "$1" 2>/dev/null | awk '{ print $1 }')" in *i*) return 0 ;; *) return 1 ;; esac
}
# root_immutable_problem <file>: prints what is wrong, or nothing.
#   macOS: owner root + uchg. Linux: owner root + lsattr "i"; without lsattr, owner root and a mode
#   that is not group/other-writable.
root_immutable_problem() {
  local f="$1" rc mode
  if [ ! -e "$f" ]; then printf '%s is missing\n' "$f"; return 0; fi
  if [ "$(file_owner "$f")" != root ]; then printf '%s is not owned by root\n' "$f"; return 0; fi
  file_immutable "$f"; rc=$?
  case "$rc" in
    0) return 0 ;;
    3) mode="$(file_mode "$f")"
       case "$mode" in
         *[2367]?|*[2367]) printf '%s is group/other-writable (mode %s)\n' "$f" "$mode" ;;
       esac ;;
    *) if [ "$(ha_os)" = macos ]; then printf '%s is not immutable (sudo chflags uchg)\n' "$f"; else printf '%s is not immutable (sudo chattr +i)\n' "$f"; fi ;;
  esac
  return 0
}
check_root_immutable() {
  local f p
  for f in "$@"; do p="$(root_immutable_problem "$f")"; [ -z "$p" ] || hook_fail "$p"; done
}
# probe_connects <host> <port>: 0 if a TCP connection succeeds (2 s timeout).
probe_connects() {
  local h="$1" p="$2"
  h="${h#[}"; h="${h%]}"
  if command -v nc >/dev/null 2>&1; then
    if [ "$(ha_os)" = macos ]; then nc -z -G 2 -w 2 "$h" "$p" >/dev/null 2>&1; else nc -z -w 2 "$h" "$p" >/dev/null 2>&1; fi
    return $?
  fi
  run_bounded 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$h" "$p" >/dev/null 2>&1
}
# network_probe: fail the job if any HA_PROBES target (host:port the tenant must NOT reach) connects.
network_probe() {
  local t
  for t in ${HA_PROBES:-}; do
    if probe_connects "${t%:*}" "${t##*:}"; then
      hook_fail "network isolation is not active: $(id -un) reached $t (owner: re-apply the ${HA_FIREWALL_LABEL:-firewall} rules)"
    fi
  done
}
# worker_probe_count: the co-tenant's CI workers (pgrep -u HA_WORKER_PROBE_USER -f HA_WORKER_PROBE_PATTERN);
# counted for the banner, never acted on. 0 when not configured.
worker_probe_count() {
  local n
  if [ -z "${HA_WORKER_PROBE_USER:-}" ] || [ -z "${HA_WORKER_PROBE_PATTERN:-}" ]; then echo 0; return 0; fi
  n="$(pgrep -u "$HA_WORKER_PROBE_USER" -f "$HA_WORKER_PROBE_PATTERN" 2>/dev/null | wc -l | tr -d ' ')"
  echo "${n:-0}"
}

# check_identity: the hook runs as the tenant, in its own primary group, in no admin-equivalent group.
check_identity() {
  local u g gs grp
  u="$(id -un)"
  [ "$u" = "$HA_USER" ] || hook_fail "running as $u, not $HA_USER"
  [ "$(id -u)" = "$HA_UID" ] || hook_fail "uid is $(id -u), not $HA_UID"
  g="$(id -gn)"
  [ "$g" = "$HA_GROUP" ] || hook_fail "primary group is $g, not $HA_GROUP"
  gs=" $(id -Gn) "
  for grp in ${HA_FORBIDDEN_GROUPS:-}; do
    case "$gs" in *" $grp "*) hook_fail "$u is a member of group $grp (admin-equivalent): remove it" ;; esac
  done
  return 0
}
