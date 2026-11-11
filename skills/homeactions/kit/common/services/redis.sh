#!/usr/bin/env bash
# redis.sh start|stop: this job's own throwaway redis-server (tenant {{tenant.name}}). 127.0.0.1 only,
# protected mode on, no unix socket, no persistence (no RDB, no AOF), pidfile and dir under $RUNNER_TEMP.
#   HOMEACTIONS_REDIS_PORT  default {{derived.redis.port}}; must be one of the tenant's ports ({{derived.portsSpace}})
# Binaries: $HOMEACTIONS_REDIS_BIN (the runner .env on the self-hosted box). On a GitHub-hosted ubuntu
# runner: redis-server from PATH, installed with apt if missing (the ONLY place sudo is used).
# The root-owned job-completed hook reaps a server this script failed to stop. Bash 3.2.
set -euo pipefail
die() { echo "{{derived.banner}} redis: $1" >&2; exit 2; }
MAJOR="{{derived.redis.version}}"; MAJOR="${MAJOR%%.*}"
ALLOWED_PORTS=" {{derived.portsSpace}} "
PORT="${HOMEACTIONS_REDIS_PORT:-{{derived.redis.port}}}"
case "${1:-}" in start|stop) ;; *) die "usage: redis.sh start|stop" ;; esac
case "$PORT" in ''|*[!0-9]*) die "HOMEACTIONS_REDIS_PORT must be one of the tenant's ports:$ALLOWED_PORTS(got '$PORT')" ;; esac
case "$ALLOWED_PORTS" in *" $PORT "*) ;; *) die "HOMEACTIONS_REDIS_PORT must be one of the tenant's ports:$ALLOWED_PORTS(got '$PORT')" ;; esac
[ -n "${RUNNER_TEMP:-}" ] && [ -d "$RUNNER_TEMP" ] || die "RUNNER_TEMP is not a directory"
DIR="$RUNNER_TEMP/homeactions-redis-$PORT"
PIDFILE="$RUNNER_TEMP/homeactions-redis-$PORT.pid"

if [ -n "${HOMEACTIONS_REDIS_BIN:-}" ]; then
  BIN="$HOMEACTIONS_REDIS_BIN"
elif [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then
  # >>> github-hosted only: sudo is allowed inside this branch and nowhere else
  if ! command -v redis-server >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq redis-server >/dev/null
    sudo systemctl stop redis-server >/dev/null 2>&1 || true
  fi
  # <<< github-hosted only
  BIN="$(dirname "$(command -v redis-server || echo /usr/bin/redis-server)")"
else
  die "HOMEACTIONS_REDIS_BIN is not set (it comes from the runner .env on the self-hosted runner)"
fi
[ -x "$BIN/redis-server" ] || die "no redis-server binary in $BIN"
"$BIN/redis-server" --version | grep -E "v=$MAJOR\.[0-9]+" >/dev/null || die "$BIN/redis-server is not Redis $MAJOR"
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

case "$1" in
  start)
    if port_open; then die "127.0.0.1:$PORT is already in use"; fi
    rm -rf "$DIR"; mkdir -p "$DIR"; rm -f "$PIDFILE"
    "$BIN/redis-server" --port "$PORT" --bind 127.0.0.1 --protected-mode yes --unixsocket '' \
      --save '' --appendonly no --dir "$DIR" --daemonize yes --pidfile "$PIDFILE" --logfile "$DIR/redis.log"
    i=0
    until port_open; do
      i=$((i + 1)); [ "$i" -le 100 ] || die "redis-server did not open 127.0.0.1:$PORT within 10 s (see $DIR/redis.log)"
      sleep 0.1
    done
    if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$BIN" >> "$GITHUB_PATH"; fi
    echo "{{derived.banner}} redis: $("$BIN/redis-server" --version | awk '{ print $3 }') on 127.0.0.1:$PORT" ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      pid="$(cat "$PIDFILE" 2>/dev/null || true)"
      case "$pid" in ''|*[!0-9]*) ;; *)
        kill -TERM "$pid" 2>/dev/null || true
        i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
        kill -KILL "$pid" 2>/dev/null || true ;;
      esac
      rm -f "$PIDFILE"
    fi
    if port_open; then die "127.0.0.1:$PORT still open after stop"; fi
    echo "{{derived.banner}} redis: stopped 127.0.0.1:$PORT" ;;
esac
