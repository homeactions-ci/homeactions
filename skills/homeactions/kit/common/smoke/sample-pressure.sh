#!/bin/bash
# sample-pressure.sh <out.tsv> [interval_s=5] [count=0 (until killed)]: append one TSV row per sample,
# "epoch<TAB>pressure<TAB>load1<TAB>swap_mb", using the hook library's readers (macOS sysctl, Linux
# /proc). Read-only; safe to run from any user. Bash 3.2.
set -u -o pipefail
[ "$#" -ge 1 ] || { echo "usage: sample-pressure.sh <out.tsv> [interval_s] [count]" >&2; exit 2; }
out="$1"; interval="${2:-5}"; count="${3:-0}"
case "$interval$count" in *[!0-9]*) echo "sample-pressure.sh: interval and count are whole numbers" >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "$0")" && pwd -P)"
for f in "$HERE/../hooks/lib.sh" "{{derived.hooksDir}}/lib.sh"; do if [ -r "$f" ]; then . "$f"; break; fi; done
command -v memory_pressure_level >/dev/null 2>&1 || { echo "sample-pressure.sh: cannot find hooks/lib.sh" >&2; exit 2; }
n=0
while [ "$count" -eq 0 ] || [ "$n" -lt "$count" ]; do
  sw="$(swap_used_mb)"
  printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$(memory_pressure_level)" "$(load1)" "${sw:-unknown}" >> "$out"
  n=$((n + 1))
  if [ "$count" -eq 0 ] || [ "$n" -lt "$count" ]; then sleep "$interval"; fi
done
