#!/bin/bash
# maintenance.sh: weekly upkeep of tenant {{tenant.name}} (schedule "{{maintenance.cron}}"), run AS THE
# TENANT USER by its timer or by hand. Idempotent, and skipped while a job is running.
#   - prunes the package store (pnpm/npm, when the job toolchain in _tool provides them)
#   - wipes {{derived.tmpDir}}, the runner's _tool, the Playwright browser cache and the XDG cache
#   - deletes runner _diag files and daemon logs older than {{maintenance.diagRetentionDays}} days
#   - reports du/df; fails if the home exceeds {{maintenance.homeMaxGb}} GB or free disk is under {{diskFloorGb}} GB
set -u -o pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
HERE="$(cd "$(dirname "$0")" && pwd -P)"
for f in "$HERE/conf/tenant.conf" "{{derived.confFile}}"; do if [ -r "$f" ]; then . "$f"; break; fi; done
for f in "$HERE/hooks/lib.sh" "{{derived.hooksDir}}/lib.sh"; do if [ -r "$f" ]; then . "$f"; break; fi; done
command -v hook_log >/dev/null 2>&1 || { printf '::error::%s maintenance: cannot find tenant.conf and hooks/lib.sh\n' "{{derived.banner}}"; exit 2; }
[ "$(id -un)" = "$HA_USER" ] || { printf '::error::%s maintenance: run as %s (running as %s)\n' "$HA_BANNER" "$HA_USER" "$(id -un)"; exit 2; }

workers="$(own_processes | awk '$3 ~ /(^|\/)Runner\.Worker$/ { n++ } END { print n + 0 }')"
if [ "$workers" -gt 0 ]; then hook_log "maintenance: a job is running; skipped (re-run when idle)"; exit 0; fi

# wipe_contents <dir>: delete what is inside <dir>, only when <dir> is under the tenant home.
wipe_contents() {
  case "$1" in "$HA_HOME"/*) ;; *) hook_warn "maintenance: $1 is outside $HA_HOME; not wiped"; return 1 ;; esac
  [ -d "$1" ] && [ ! -L "$1" ] || return 0
  find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null
  hook_log "maintenance: wiped $1"
}

# 1. package store, using the job toolchain while it still exists
nodebin="$(ls -d "$HA_WORK_DIR"/_tool/node/*/*/bin 2>/dev/null | tail -n 1)"
if [ -n "$nodebin" ]; then PATH="$nodebin:$PATH"; fi
export pnpm_config_store_dir="$HA_CACHE_DIR/pnpm-store" npm_config_cache="$HA_CACHE_DIR/npm"
if command -v pnpm >/dev/null 2>&1 && [ -d "$HA_CACHE_DIR/pnpm-store" ]; then
  pnpm store prune >/dev/null 2>&1 && hook_log "maintenance: pnpm store pruned" || hook_warn "maintenance: pnpm store prune failed"
fi
if command -v npm >/dev/null 2>&1 && [ -d "$HA_CACHE_DIR/npm" ]; then
  npm cache verify >/dev/null 2>&1 && hook_log "maintenance: npm cache verified" || hook_warn "maintenance: npm cache verify failed"
fi

# 2. caches and temp
wipe_contents "$HA_TMP_DIR"
wipe_contents "$HA_WORK_DIR/_tool"
wipe_contents "$HA_CACHE_DIR/ms-playwright"
wipe_contents "$HA_CACHE_DIR/xdg"

# 3. old diagnostics and logs
if [ -d "$HA_RUNNER_DIR/_diag" ]; then
  n="$(find "$HA_RUNNER_DIR/_diag" -type f -mtime +"$HA_DIAG_RETENTION_DAYS" -print -delete 2>/dev/null | wc -l | tr -d ' ')"
  hook_log "maintenance: deleted $n _diag file(s) older than $HA_DIAG_RETENTION_DAYS days"
fi
if [ -d "$HA_LOG_DIR" ]; then
  n="$(find "$HA_LOG_DIR" -type f -mtime +"$HA_DIAG_RETENTION_DAYS" -print -delete 2>/dev/null | wc -l | tr -d ' ')"
  hook_log "maintenance: deleted $n log file(s) older than $HA_DIAG_RETENTION_DAYS days"
fi

# 4. report and verdict
home_kb="$(du -sk "$HA_HOME" 2>/dev/null | awk '{ print $1 }')"; case "$home_kb" in ''|*[!0-9]*) home_kb="" ;; esac
free_kb="$(disk_free_kb "$HA_HOME")"; case "$free_kb" in ''|*[!0-9]*) free_kb="" ;; esac
hook_log "maintenance: home ${home_kb:+$(( home_kb / 1048576 ))} GB (limit $HA_HOME_MAX_GB), free ${free_kb:+$(( free_kb / 1048576 ))} GB (floor $HA_DISK_FLOOR_GB)"
rc=0
if [ -z "$home_kb" ]; then hook_warn "maintenance: home size UNREADABLE"; rc=1
elif [ "$home_kb" -gt $(( HA_HOME_MAX_GB * 1048576 )) ]; then printf '::error::%s maintenance: home is over %s GB\n' "$HA_BANNER" "$HA_HOME_MAX_GB"; rc=1; fi
if [ -z "$free_kb" ]; then hook_warn "maintenance: free disk UNREADABLE"; rc=1
elif [ "$free_kb" -lt $(( HA_DISK_FLOOR_GB * 1048576 )) ]; then printf '::error::%s maintenance: free disk is under the %s GB floor\n' "$HA_BANNER" "$HA_DISK_FLOOR_GB"; rc=1; fi
exit "$rc"
