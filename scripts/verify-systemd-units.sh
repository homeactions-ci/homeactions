#!/usr/bin/env bash
# CI helper (Linux only): verify the rendered systemd units the way they would sit on a real host.
# A bare `systemd-analyze verify runner.service` fails on a CI box for reasons that say nothing about the
# unit: its Requires= unit is not installed and its ExecStart= binary does not exist (nothing is
# provisioned in CI). So build a throwaway root with every rendered unit under the name the provisioner
# installs it as, plus an executable placeholder at every absolute Exec*= path, and verify there.
# Usage: scripts/verify-systemd-units.sh <profile.json> <rendered-out-dir>
set -euo pipefail
profile="$1"; out="$2"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

# Installed unit names come from the renderer's own derive(), never re-typed here.
# (Paths go in through the environment: passing render.mjs as an argument would make it argv[1] and run its CLI.)
names="$(HA_RENDER="$here/../skills/homeactions/kit/render.mjs" HA_PROFILE="$profile" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const { derive } = await import(process.env.HA_RENDER);
  const d = derive(JSON.parse(readFileSync(process.env.HA_PROFILE, "utf8")));
  console.log(`runner.service=${d.daemonLabel}.service`);
  console.log(`firewall.service=${d.firewallLabel}.service`);
')"

mkdir -p "$root/etc/systemd/system"
units=()
for src in "$out"/host/systemd/*.service; do
  base="$(basename "$src")"
  dest="$base"
  while IFS='=' read -r from to; do [ "$from" = "$base" ] && dest="$to"; done <<<"$names"
  cp "$src" "$root/etc/systemd/system/$dest"
  units+=("$root/etc/systemd/system/$dest")
  # An executable placeholder for every absolute path an Exec*= line runs or passes as its script.
  for p in $(sed -nE 's/^Exec[A-Za-z]*=[-@+!:]*//p' "$src" | tr ' ' '\n' | grep -E '^/' || true); do
    mkdir -p "$root$(dirname "$p")"
    [ -e "$root$p" ] || { printf '#!/bin/sh\nexit 0\n' > "$root$p"; chmod 0755 "$root$p"; }
  done
done
[ "${#units[@]}" -gt 0 ] || { echo "verify-systemd-units: no units rendered under $out/host/systemd" >&2; exit 1; }
echo "verify-systemd-units: verifying ${#units[@]} unit(s) under a throwaway root"
systemd-analyze verify --root="$root" "${units[@]}"
echo "verify-systemd-units: ok"
