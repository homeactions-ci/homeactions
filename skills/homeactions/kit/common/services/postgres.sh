#!/usr/bin/env bash
# postgres.sh start|stop: this job's own throwaway PostgreSQL {{derived.postgres.major}} (tenant {{tenant.name}}).
# A cluster under $RUNNER_TEMP, on 127.0.0.1 only, no unix socket, scram-sha-256 password, fsync off.
#   HOMEACTIONS_PG_PORT  default {{derived.postgres.port}}; must be one of the tenant's ports ({{derived.portsSpace}})
#   HOMEACTIONS_PG_DB    database to create (required for start; [a-z_][a-z0-9_]*)
#   HOMEACTIONS_PG_USER / HOMEACTIONS_PG_PASSWORD  default homeactions / homeactions (loopback-only, per job)
# Binaries: $HOMEACTIONS_PG_BIN (the runner .env on the self-hosted box). On a GitHub-hosted ubuntu runner:
# /usr/lib/postgresql/{{derived.postgres.major}}/bin, installed with apt if missing (the ONLY place sudo is used).
# The root-owned job-completed hook reaps a cluster this script failed to stop. Bash 3.2.
set -euo pipefail
die() { echo "{{derived.banner}} postgres: $1" >&2; exit 2; }
MAJOR="{{derived.postgres.major}}"
ALLOWED_PORTS=" {{derived.portsSpace}} "
PORT="${HOMEACTIONS_PG_PORT:-{{derived.postgres.port}}}"
DB="${HOMEACTIONS_PG_DB:-}"
PGUSER_NAME="${HOMEACTIONS_PG_USER:-homeactions}"
PGPASS="${HOMEACTIONS_PG_PASSWORD:-homeactions}"
case "${1:-}" in start|stop) ;; *) die "usage: postgres.sh start|stop" ;; esac
case "$PORT" in ''|*[!0-9]*) die "HOMEACTIONS_PG_PORT must be one of the tenant's ports:$ALLOWED_PORTS(got '$PORT')" ;; esac
case "$ALLOWED_PORTS" in *" $PORT "*) ;; *) die "HOMEACTIONS_PG_PORT must be one of the tenant's ports:$ALLOWED_PORTS(got '$PORT')" ;; esac
[ -n "${RUNNER_TEMP:-}" ] && [ -d "$RUNNER_TEMP" ] || die "RUNNER_TEMP is not a directory"
grep -Eq '^[a-z_][a-z0-9_]{0,40}$' <<<"$PGUSER_NAME" || die "HOMEACTIONS_PG_USER must look like [a-z_][a-z0-9_]* (got '$PGUSER_NAME')"
DATA="$RUNNER_TEMP/homeactions-pg-$PORT"

if [ -n "${HOMEACTIONS_PG_BIN:-}" ]; then
  BIN="$HOMEACTIONS_PG_BIN"
elif [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then
  BIN="/usr/lib/postgresql/$MAJOR/bin"
  # >>> github-hosted only: sudo is allowed inside this branch and nowhere else
  if [ ! -x "$BIN/postgres" ]; then
    sudo apt-get update -qq && sudo apt-get install -y -qq "postgresql-$MAJOR" >/dev/null
  fi
  # <<< github-hosted only
else
  die "HOMEACTIONS_PG_BIN is not set (it comes from the runner .env on the self-hosted runner)"
fi
[ -x "$BIN/postgres" ] || die "no postgres binary in $BIN"
"$BIN/postgres" --version | grep -E " $MAJOR\.[0-9]+" >/dev/null || die "$BIN/postgres is not PostgreSQL $MAJOR"
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

case "$1" in
  start)
    grep -Eq '^[a-z_][a-z0-9_]{0,62}$' <<<"$DB" || die "HOMEACTIONS_PG_DB must look like [a-z_][a-z0-9_]* (got '$DB')"
    if port_open; then die "127.0.0.1:$PORT is already in use"; fi
    rm -rf "$DATA"; mkdir -p "$DATA"
    PW="$RUNNER_TEMP/homeactions-pg-$PORT.pw"; (umask 077; printf '%s\n' "$PGPASS" > "$PW")
    "$BIN/initdb" -D "$DATA" -U "$PGUSER_NAME" --pwfile="$PW" -A scram-sha-256 -E UTF8 --locale=C --no-instructions >/dev/null
    rm -f "$PW"
    "$BIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w -t 60 start \
      -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off -c full_page_writes=off"
    PGPASSWORD="$PGPASS" "$BIN/createdb" -h 127.0.0.1 -p "$PORT" -U "$PGUSER_NAME" "$DB"
    if [ -n "${GITHUB_PATH:-}" ]; then printf '%s\n' "$BIN" >> "$GITHUB_PATH"; fi
    echo "{{derived.banner}} postgres: $("$BIN/postgres" --version) on 127.0.0.1:$PORT, database $DB, user $PGUSER_NAME" ;;
  stop)
    if [ -f "$DATA/postmaster.pid" ]; then
      "$BIN/pg_ctl" -D "$DATA" -m fast -w -t 30 stop || "$BIN/pg_ctl" -D "$DATA" -m immediate -w -t 30 stop
    fi
    if port_open; then die "127.0.0.1:$PORT still open after stop"; fi
    echo "{{derived.banner}} postgres: stopped 127.0.0.1:$PORT" ;;
esac
