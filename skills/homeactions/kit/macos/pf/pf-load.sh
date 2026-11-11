#!/bin/bash
# Loads the homeactions pf anchor for tenant {{tenant.user}} and holds one pf enable reference.
# Installed root:wheel 0755 as {{tenant.rootDir}}/pf-load.sh; run as root by the LaunchDaemon
# {{derived.firewallLabel}} at boot and every 300 s. Re-loading replaces the anchor's rules; the enable
# reference is taken once per boot (/var/run is emptied at boot) and re-taken if pf was disabled.
# provision.sh firewall-unload / uninstall.sh release it with `pfctl -X`. Bash 3.2.
set -euo pipefail
ANCHOR='{{derived.pfAnchor}}'
RULES='{{derived.pfAnchorFile}}'
TOKEN_FILE='/var/run/{{tenant.labelPrefix}}.pf.token'
TENANT='{{tenant.user}}'

[ "$(id -u)" -eq 0 ] || {
  echo "pf-load.sh: must run as root" >&2
  exit 1
}
id -u "$TENANT" >/dev/null 2>&1 || {
  echo "pf-load.sh: no user ${TENANT}; not loading rules that name it" >&2
  exit 1
}
[ -f "$RULES" ] || {
  echo "pf-load.sh: ${RULES} is missing" >&2
  exit 1
}
/sbin/pfctl -q -n -a "$ANCHOR" -f "$RULES"
/sbin/pfctl -q -a "$ANCHOR" -f "$RULES"
# Someone ran `pfctl -d`: our old reference no longer keeps pf on, so take a new one.
if [ -s "$TOKEN_FILE" ] && ! /sbin/pfctl -s info 2>/dev/null | grep -c 'Status: Enabled' >/dev/null; then
  rm -f "$TOKEN_FILE"
fi
if [ ! -s "$TOKEN_FILE" ]; then
  token="$(/sbin/pfctl -E 2>&1 | awk '/Token/ { print $NF }')"
  [ -n "$token" ] || {
    echo "pf-load.sh: pfctl -E returned no reference token" >&2
    exit 1
  }
  (
    umask 077
    printf '%s\n' "$token" > "$TOKEN_FILE"
  )
fi
