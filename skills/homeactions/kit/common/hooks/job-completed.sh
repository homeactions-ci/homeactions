#!/bin/bash
# ACTIONS_RUNNER_HOOK_JOB_COMPLETED for runner {{tenant.runnerName}} (tenant {{tenant.name}}): record any
# listener the job bound off loopback, reap everything the job left (Postgres first, by immediate
# shutdown), free its SysV IPC, wipe the job's workspace and this user's /tmp entries, then fail if a
# listener was exposed off loopback (the firewall already drops inbound traffic to it).
set +e; set -u -o pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
. "{{derived.confFile}}" || { printf '::error::%s cannot read %s\n' "{{derived.banner}}" "{{derived.confFile}}"; exit 1; }
. "{{derived.hooksDir}}/lib.sh" || { printf '::error::%s cannot read %s\n' "{{derived.banner}}" "{{derived.hooksDir}}/lib.sh"; exit 1; }

# 1. identity
[ "$(id -un)" = "$HA_USER" ] || hook_fail "running as $(id -un), not $HA_USER"

# 2. record listeners bound off loopback before reaping them
listeners="$(own_tcp_listeners)"; listeners_rc=$?
exposed="$(printf '%s\n' "$listeners" | nonloopback_listeners)"
if [ "$listeners_rc" -ne 0 ]; then hook_warn "listener check UNREADABLE (no lsof or ss): exposure not verified"; fi

# 3. reap and free IPC
reap_strays job-completed
ipc_cleanup

# 4. workspace wipe (the pnpm store, browser cache and _tool live outside it, so installs stay fast)
ws="${GITHUB_WORKSPACE:-}"
if [ -z "$ws" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then ws="$HA_WORK_DIR/${GITHUB_REPOSITORY##*/}/${GITHUB_REPOSITORY##*/}"; fi
wiped="$(workspace_wipe "$HA_WORK_DIR" "$ws")"
[ -n "$wiped" ] || wiped=nothing

# 5. this user's /tmp entries
tmp_cleanup

# 6. banner, then the exposure verdict
swap="$(swap_used_mb)"; [ -n "$swap" ] || swap=unknown
hook_log "job-completed v$HOOK_VERSION: reaped ${REAPED:-0}, wiped $wiped, pressure $(memory_pressure_level), swap $swap MB"
if [ -n "$exposed" ]; then hook_fail "a listener of this job was bound off loopback: $(echo $exposed)"; fi
exit 0
