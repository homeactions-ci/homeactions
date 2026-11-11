#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_STARTED for runner {{tenant.runnerName}} (tenant {{tenant.name}}). Root-owned
# and outside the runner directory, so no job can edit or skip it. A non-zero exit fails the job
# before any step runs. The step order is pinned by tests: identity, wiring, isolation, co-tenant
# readability, leftovers, ports, disk, yield, banner.
set +e; set -u -o pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
. "{{derived.confFile}}" || { printf '::error::%s cannot read %s\n' "{{derived.banner}}" "{{derived.confFile}}"; exit 1; }
. "{{derived.hooksDir}}/lib.sh" || { printf '::error::%s cannot read %s\n' "{{derived.banner}}" "{{derived.hooksDir}}/lib.sh"; exit 1; }

# 1. identity: the tenant user, its own primary group, no admin-equivalent group
check_identity

# 2. wiring: root-owned, immutable runner .env/.path; hooks, config and root dir not writable
check_root_immutable "$HA_RUNNER_DIR/.env" "$HA_RUNNER_DIR/.path"
for d in "$HA_HOOKS_DIR" "$HA_ROOT_DIR" "$HA_CONF_FILE"; do
  if [ -w "$d" ]; then hook_fail "$d is writable by $(id -un)"; fi
done

# 3. isolation: forbidden paths, the co-tenant's marker directory, the network
for p in $HA_FORBIDDEN_READ; do
  if ls "$p" >/dev/null 2>&1; then hook_fail "$p is readable by $(id -un)"; fi
done
if [ "$HA_COTENANT_MODE" = marker-dir ] && [ -n "$HA_COTENANT_MARKER_DIR" ] && [ -w "$HA_COTENANT_MARKER_DIR" ]; then
  hook_fail "$HA_COTENANT_MARKER_DIR is writable by $(id -un) (the co-tenant's markers must be read-only to this tenant)"
fi
if [ "$HA_NETWORK_ISOLATION" = 1 ]; then network_probe; fi

# 4. co-tenant signal: unreadable is never "clear"
hold="$(cotenant_hold "$(date +%s)")"; hold_rc=$?
if [ "$hold_rc" -eq 2 ]; then
  hook_fail "co-tenant markers UNREADABLE: ${hold#unreadable: } (owner: grant $(id -un) read access; an unreadable signal is never treated as clear)"
fi

# 5. leftovers of earlier jobs (this user's only)
reap_strays job-started
ipc_cleanup
tmp_cleanup 1

# 6. tenant ports free (any user; this tenant's own were just reaped)
held="$(tcp_listen_table | listeners_on_ports "$HA_PORTS")"
if [ -n "$held" ]; then hook_fail "a tenant port is held by another process: $(echo $held)"; fi

# 7. disk floor
free_kb="$(disk_free_kb "$HA_HOME")"; case "$free_kb" in ''|*[!0-9]*) free_kb=0 ;; esac
if [ "$free_kb" -lt $(( HA_DISK_FLOOR_GB * 1048576 )) ]; then
  hook_fail "free disk $(( free_kb / 1048576 )) GB is under the ${HA_DISK_FLOOR_GB} GB floor"
fi

# 8. read-only, bounded, fail-open yield (co-tenant hold, memory pressure, swap)
run_yield

# 9. banner
swap="$(swap_used_mb)"; [ -n "$swap" ] || swap=unknown
banner="job-started v$HOOK_VERSION OK: reaped ${REAPED:-0}, yielded ${YIELD_WAITED}s${YIELD_FIRST_REASON:+ to $YIELD_FIRST_REASON}, free $(( free_kb / 1048576 )) GB, swap $swap MB, pressure $(memory_pressure_level), load $(load1)"
if [ -n "$HA_WORKER_PROBE_USER" ]; then banner="$banner, cotenant-workers $(worker_probe_count)"; fi
hook_log "$banner"
exit 0
