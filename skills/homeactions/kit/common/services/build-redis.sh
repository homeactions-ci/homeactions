#!/bin/bash
# build-redis.sh: Redis {{derived.redis.version}} for tenant {{tenant.name}}, built from the pinned,
# checksum-verified source into {{derived.redis.prefix}}. Run AS THE TENANT USER by the provisioner
# (never as root, never with sudo). Idempotent: an existing build of the same version is kept.
# Waits read-only (at most 30 min) while the co-tenant is busy, builds at nice 10 on half the cores,
# asserts the version, deletes the sources. With install "package" (Linux) the provisioner installs the
# distro package instead; this script then only links {{derived.redis.bin}} to it. Bash 3.2.
set -eu -o pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
B="{{derived.banner}}"
log() { printf '%s build-redis: %s\n' "$B" "$*"; }
die() { printf '::error::%s build-redis: %s\n' "$B" "$*" >&2; exit 1; }
[ "$(id -un)" = "{{tenant.user}}" ] || die "run this as {{tenant.user}} (running as $(id -un))"
V="{{derived.redis.version}}"
PREFIX="{{derived.redis.prefix}}"
SRC="{{derived.srcDir}}"
INSTALL="{{derived.redis.install}}"
CORES={{host.cores}}

if [ "$INSTALL" = package ]; then
  log "install is \"package\": the provisioner installs the distro's redis-server package; nothing to build."
  if [ -x /usr/bin/redis-server ]; then
    mkdir -p "$PREFIX/bin"
    for b in redis-server redis-cli; do if [ -x "/usr/bin/$b" ]; then ln -sfn "/usr/bin/$b" "$PREFIX/bin/$b"; fi; done
    log "linked $PREFIX/bin to the distro binaries"
  else
    log "/usr/bin/redis-server is not installed yet; re-run after the package is installed"
  fi
  exit 0
fi

SHA="{{derived.redis.sourceSha256}}"
[ "${#SHA}" -eq 64 ] || die "no sourceSha256 for redis $V in the profile"

if [ -x "$PREFIX/bin/redis-server" ] && "$PREFIX/bin/redis-server" --version 2>/dev/null | grep -F "v=$V " >/dev/null; then
  log "Redis $V is already built in $PREFIX"; exit 0
fi

# the co-tenant comes first: wait read-only while it is busy (bounded, then proceed)
HERE="$(cd "$(dirname "$0")" && pwd -P)"
for f in "$HERE/../conf/tenant.conf" "{{derived.confFile}}"; do if [ -r "$f" ]; then . "$f"; break; fi; done
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
TARBALL="redis-$V.tar.gz"
rm -rf "redis-$V" "$TARBALL"
log "downloading $TARBALL"
curl -fsSLO "https://download.redis.io/releases/$TARBALL"
echo "$SHA  $TARBALL" | $SHACMD -c - >/dev/null || die "$TARBALL does not match sourceSha256"
tar xzf "$TARBALL"
cd "redis-$V"
log "building with nice -n 10 make -j$JOBS (no TLS)"
nice -n 10 make -j"$JOBS" BUILD_TLS=no >make.log 2>&1 || die "make failed (see $SRC/redis-$V/make.log)"
nice -n 10 make PREFIX="$PREFIX" install >install.log 2>&1 || die "make install failed (see $SRC/redis-$V/install.log)"
"$PREFIX/bin/redis-server" --version | grep -F "v=$V " >/dev/null || die "$PREFIX/bin/redis-server is not $V"
cd "$SRC"
rm -rf "redis-$V" "$TARBALL"
log "Redis $V built in $PREFIX"
