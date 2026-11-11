#!/bin/bash
# timed.sh <label> <out.tsv> -- <command...>: run a command under /usr/bin/time (macOS -l, Linux -v),
# stream its output, and append one TSV row "label<TAB>exit<TAB>wall_s<TAB>max_rss_kb<TAB>epoch" to
# <out.tsv>. Exits with the command's status. Bash 3.2.
set -u -o pipefail
[ "$#" -ge 4 ] && [ "$3" = "--" ] || { echo "usage: timed.sh <label> <out.tsv> -- <command...>" >&2; exit 2; }
label="$1"; out="$2"; shift 3
case "$label" in *"	"*) echo "timed.sh: the label must not contain a tab" >&2; exit 2 ;; esac
tlog="$(mktemp "${TMPDIR:-/tmp}/homeactions-timed.XXXXXX")" || exit 2
start="$(date +%s)"
if [ ! -x /usr/bin/time ]; then
  "$@"; rc=$?
elif [ "$(uname -s)" = Darwin ]; then
  /usr/bin/time -l "$@" 2> >(tee "$tlog" >&2); rc=$?
else
  /usr/bin/time -v "$@" 2> >(tee "$tlog" >&2); rc=$?
fi
end="$(date +%s)"
sleep 0.2   # let the tee process substitution flush
# macOS: "<bytes>  maximum resident set size"; GNU: "Maximum resident set size (kbytes): <kb>"
rss="$(awk '/maximum resident set size/ { v = $1 } /Maximum resident set size \(kbytes\)/ { v = $NF * 1024 } END { if (v != "") printf "%d", v / 1024 }' "$tlog" 2>/dev/null)"
rm -f "$tlog"
printf '%s\t%s\t%s\t%s\t%s\n' "$label" "$rc" "$(( end - start ))" "${rss:-unknown}" "$end" >> "$out"
exit "$rc"
