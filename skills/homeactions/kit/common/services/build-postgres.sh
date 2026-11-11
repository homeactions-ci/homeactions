#!/bin/bash
# build-postgres.sh: PostgreSQL {{derived.postgres.version}} for tenant {{tenant.name}}, built from the
# pinned, checksum-verified source into {{derived.postgres.prefix}}. Run AS THE TENANT USER by the
# provisioner (never as root, never with sudo). Idempotent: an existing build of the same version is kept.
# Waits read-only (at most 30 min) while the co-tenant is busy, builds at nice 10 on half the cores,
# asserts the version, deletes the sources. With install "package" (Linux) the provisioner installs the
# distro package instead; this script then only links {{derived.postgres.prefix}} to it. Bash 3.2.
set -eu -o pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
B="{{derived.banner}}"
log() { printf '%s build-postgres: %s\n' "$B" "$*"; }
die() { printf '::error::%s build-postgres: %s\n' "$B" "$*" >&2; exit 1; }
[ "$(id -un)" = "{{tenant.user}}" ] || die "run this as {{tenant.user}} (running as $(id -un))"
V="{{derived.postgres.version}}"
MAJOR="{{derived.postgres.major}}"
PREFIX="{{derived.postgres.prefix}}"
SRC="{{derived.srcDir}}"
INSTALL="{{derived.postgres.install}}"
CORES={{host.cores}}

if [ "$INSTALL" = package ]; then
  log "install is \"package\": the provisioner installs the distro's postgresql-$MAJOR package; nothing to build."
  DISTRO="/usr/lib/postgresql/$MAJOR"
  if [ -d "$PREFIX" ] && [ ! -L "$PREFIX" ]; then log "$PREFIX is a real directory; left as is"; exit 0; fi
  if [ -x "$DISTRO/bin/postgres" ]; then
    mkdir -p "${PREFIX%/*}"; ln -sfn "$DISTRO" "$PREFIX"; log "linked $PREFIX -> $DISTRO"
  else
    log "$DISTRO/bin/postgres is not installed yet; re-run after the package is installed"
  fi
  exit 0
fi

SHA="{{derived.postgres.sourceSha256}}"
[ "${#SHA}" -eq 64 ] || die "no sourceSha256 for postgres $V in the profile"

if [ -x "$PREFIX/bin/postgres" ] && "$PREFIX/bin/postgres" --version 2>/dev/null | grep -F "(PostgreSQL) $V" >/dev/null; then
  log "PostgreSQL $V is already built in $PREFIX"; exit 0
fi

# the co-tenant comes first: wait read-only while it is busy (bounded, then proceed)
HERE="$(cd "$(dirname "$0")" && pwd -P)"
# shellcheck source=/dev/null  # the tenant conf / hooks lib, located at run time
for f in "$HERE/../conf/tenant.conf" "{{derived.confFile}}"; do if [ -r "$f" ]; then . "$f"; break; fi; done
# shellcheck source=/dev/null  # the tenant conf / hooks lib, located at run time
for f in "$HERE/../hooks/lib.sh" "{{derived.hooksDir}}/lib.sh"; do if [ -r "$f" ]; then . "$f"; break; fi; done
if command -v cotenant_hold >/dev/null 2>&1; then
  waited=0
  while :; do
    rc=0; hold="$(cotenant_hold "$(date +%s)")" || rc=$?
    [ "$rc" -ne 2 ] || die "co-tenant signal ${hold}: fix read access before building"
    [ -n "$hold" ] || break
    if [ "$waited" -ge 1800 ]; then log "still $hold after 30 min; building anyway"; break; fi
    log "waiting for $hold"; sleep 30; waited=$((waited + 30))
  done
else
  die "cannot find tenant.conf and hooks/lib.sh next to this script or in {{tenant.rootDir}}"
fi

if command -v shasum >/dev/null 2>&1; then SHACMD="shasum -a 256"; else SHACMD="sha256sum"; fi
JOBS=$(( CORES / 2 )); [ "$JOBS" -ge 1 ] || JOBS=1
mkdir -p "$SRC"
cd "$SRC"
TARBALL="postgresql-$V.tar.bz2"
rm -rf "postgresql-$V" "$TARBALL"
log "downloading $TARBALL"
curl -fsSLO "https://ftp.postgresql.org/pub/source/v$V/$TARBALL"
echo "$SHA  $TARBALL" | $SHACMD -c - >/dev/null || die "$TARBALL does not match sourceSha256"
tar xjf "$TARBALL"
cd "postgresql-$V"
log "configuring into $PREFIX"
./configure --prefix="$PREFIX" --without-icu --without-readline >configure.log 2>&1 || die "configure failed (see $SRC/postgresql-$V/configure.log)"
log "building with nice -n 10 make -j$JOBS"
nice -n 10 make -j"$JOBS" >make.log 2>&1 || die "make failed (see $SRC/postgresql-$V/make.log)"
nice -n 10 make install >install.log 2>&1 || die "make install failed (see $SRC/postgresql-$V/install.log)"
"$PREFIX/bin/postgres" --version | grep -F "(PostgreSQL) $V" >/dev/null || die "$PREFIX/bin/postgres is not $V"
cd "$SRC"
rm -rf "postgresql-$V" "$TARBALL"
log "PostgreSQL $V built in $PREFIX ($("$PREFIX/bin/postgres" --version))"
