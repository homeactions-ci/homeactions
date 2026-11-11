#!/bin/bash
# Loads (or unloads) the nftables table inet {{derived.nftTable}} of homeactions tenant {{tenant.user}}.
# Installed root:root 0755 as {{tenant.rootDir}}/nft-load.sh; run as root by
# {{derived.firewallLabel}}.service at boot, and by provision.sh firewall / uninstall.sh.
#   nft-load.sh load     replace the table atomically (one nft transaction) and fill the private sets
#   nft-load.sh check    parse the same transaction without applying it (nft -c)
#   nft-load.sh unload   delete the table (no other table is touched)
# The private ranges are split into IPv4 / IPv6 here because an nftables set holds one family.
set -euo pipefail
TABLE='{{derived.nftTable}}'
RULES='{{tenant.rootDir}}/tenant.nft'
RANGES='{{join isolation.privateRanges " "}}'
NFT="$(command -v nft 2>/dev/null || echo /usr/sbin/nft)"

[ "$(id -u)" -eq 0 ] || {
  echo "nft-load.sh: must run as root" >&2
  exit 1
}

ruleset() {
  local r v4="" v6=""
  for r in $RANGES; do
    case "$r" in
      *:*) v6="${v6:+${v6}, }${r}" ;;
      *) v4="${v4:+${v4}, }${r}" ;;
    esac
  done
  # Create-then-delete makes the replace idempotent whether or not the table exists yet.
  printf 'add table inet %s\ndelete table inet %s\n' "$TABLE" "$TABLE"
  cat "$RULES"
  if [ -n "$v4" ]; then printf 'add element inet %s private4 { %s }\n' "$TABLE" "$v4"; fi
  if [ -n "$v6" ]; then printf 'add element inet %s private6 { %s }\n' "$TABLE" "$v6"; fi
}

case "${1:-load}" in
  load)
    ruleset | "$NFT" -c -f -
    ruleset | "$NFT" -f -
    ;;
  check) ruleset | "$NFT" -c -f - ;;
  unload) "$NFT" delete table inet "$TABLE" 2>/dev/null || true ;;
  *)
    echo "usage: nft-load.sh load|check|unload" >&2
    exit 2
    ;;
esac
