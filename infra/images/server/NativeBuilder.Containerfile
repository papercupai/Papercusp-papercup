# syntax=docker/dockerfile:1
# P-058: extend the maintained, verified WSL/Server rootfs for a native build.
# Dockerfile.operator builds the legacy Node 20 web app and hardcodes x64 pty;
# the bootc image provisions a whole host. Neither is the sidecar build closure.
# Context: the directory containing verified papercup-runtime.tar.gz.
# Verify its receipt before building, then pin this builder's image ID before
# running the existing build-desktop-sidecar.sh producer on frozen source.
FROM scratch
ADD papercup-runtime.tar.gz /
ARG TARGETARCH
ARG BUILD_NODE_VERSION=25.9.0
ARG RUST_VERSION=1.97.1
ARG RUSTUP_VERSION=1.28.2
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
# --mount makes legacy Docker refuse before any heredoc can silently become an
# empty command. These build steps require BuildKit's heredoc parser.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked <<'NATIVE_BUILD'
# NATIVE_PREFLIGHT_BEGIN
case "$TARGETARCH" in
  amd64) node_arch=x64; rust_host=x86_64-unknown-linux-gnu ;;
  arm64) node_arch=arm64; rust_host=aarch64-unknown-linux-gnu ;;
  *) echo "ERROR: native builder requires amd64 or arm64" >&2; exit 2 ;;
esac
for version in "$BUILD_NODE_VERSION" "$RUST_VERSION" "$RUSTUP_VERSION"; do
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "ERROR: native builder toolchains require exact versions" >&2; exit 2;
  }
done
[[ "$(dpkg --print-architecture)" == "$TARGETARCH" \
   && "$(/usr/local/bin/node -p process.arch)" == "$node_arch" ]] || {
  echo "ERROR: native builder rootfs/process architecture differs from target" >&2; exit 2;
}
# NATIVE_PREFLIGHT_END
export DEBIAN_FRONTEND=noninteractive
# The maintained Ubuntu rootfs has no PGDG repository. The sidecar consumes
# PostgreSQL 18's target-native pgvector and pg_textsearch extensions.
# Configure the official signed repository before installing that build input.
. /etc/os-release
[[ "$ID" == "ubuntu" && "$VERSION_CODENAME" =~ ^[a-z]+$ ]]
install -d /usr/share/postgresql-common/pgdg
curl -fSsL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nArchitectures: %s\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' \
  "$VERSION_CODENAME" "$TARGETARCH" > /etc/apt/sources.list.d/pgdg.sources
apt-get update
apt-get install -y --no-install-recommends pkg-config libasound2-dev libssl-dev file binutils rsync gh patchelf postgresql-18-pgvector postgresql-18-pg-textsearch
# NATIVE_PGVECTOR_PREFLIGHT_BEGIN
pgvector_sql=(/usr/share/postgresql/18/extension/vector--*.sql)
[[ -s /usr/lib/postgresql/18/lib/vector.so \
   && -s /usr/share/postgresql/18/extension/vector.control \
   && -s "${pgvector_sql[0]}" ]] || {
  echo "ERROR: native builder requires PostgreSQL 18 pgvector library, control and SQL files" >&2; exit 2;
}
case "$TARGETARCH" in
  arm64) pgvector_machine='ARM aarch64' ;;
  amd64) pgvector_machine='x86-64' ;;
esac
[[ "$(file -b /usr/lib/postgresql/18/lib/vector.so)" == *"$pgvector_machine"* ]] || {
  echo "ERROR: native builder pgvector architecture differs from target" >&2; exit 2;
}
unset pgvector_sql pgvector_machine
# NATIVE_PGVECTOR_PREFLIGHT_END
# NATIVE_PGTEXTSEARCH_PREFLIGHT_BEGIN
pgtextsearch_sql=(/usr/share/postgresql/18/extension/pg_textsearch--*.sql)
[[ -s /usr/lib/postgresql/18/lib/pg_textsearch.so \
   && -s /usr/share/postgresql/18/extension/pg_textsearch.control \
   && -s "${pgtextsearch_sql[0]}" ]] || {
  echo "ERROR: native builder requires PostgreSQL 18 pg_textsearch library, control and SQL files" >&2; exit 2;
}
case "$TARGETARCH" in
  arm64) pgtextsearch_machine='ARM aarch64' ;;
  amd64) pgtextsearch_machine='x86-64' ;;
esac
[[ "$(file -b /usr/lib/postgresql/18/lib/pg_textsearch.so)" == *"$pgtextsearch_machine"* ]] || {
  echo "ERROR: native builder pg_textsearch architecture differs from target" >&2; exit 2;
}
unset pgtextsearch_sql pgtextsearch_machine
# NATIVE_PGTEXTSEARCH_PREFLIGHT_END
rm -rf /var/lib/apt/lists/*
mkdir -p /opt/build-node /opt/cargo /opt/rustup /tmp/native-toolchains
cd /tmp/native-toolchains
archive="node-v${BUILD_NODE_VERSION}-linux-${node_arch}.tar.xz"
curl -fSsL "https://nodejs.org/dist/v${BUILD_NODE_VERSION}/${archive}" -o "$archive"
curl -fSsL "https://nodejs.org/dist/v${BUILD_NODE_VERSION}/SHASUMS256.txt" -o node-checksums
awk -v name="$archive" '$2 == name { print }' node-checksums > node-checksum
test "$(wc -l < node-checksum)" -eq 1
sha256sum -c node-checksum
tar -xJf "$archive" --strip-components=1 -C /opt/build-node
url="https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rust_host}/rustup-init"
curl -fSsL "$url" -o rustup-init
curl -fSsL "$url.sha256" -o rustup-checksum
sha256sum -c rustup-checksum
chmod +x rustup-init
CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup ./rustup-init -y --no-modify-path \
  --profile minimal --default-host "$rust_host" --default-toolchain "$RUST_VERSION"
CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup /opt/cargo/bin/rustup target add wasm32-wasip1
test "$(/opt/build-node/bin/node -p process.arch)" = "$node_arch"
test "$(/opt/build-node/bin/node --version)" = "v$BUILD_NODE_VERSION"
RUSTUP_HOME=/opt/rustup /opt/cargo/bin/rustc --version
cd /
rm -rf /tmp/native-toolchains
NATIVE_BUILD
# Git 2.43 mistakes stale errno=ENOMEM at normal getdelim EOF for failure.
# Measured under ARM emulation: result=-1, feof=1, ferror=0, allocated buffer.
# Correct that EOF interpretation only; retain actual allocation/read errors.
# This private factory adapter is never copied into the Server payload.
RUN <<'GIT_EOF_COMPAT'
mkdir -p /opt/build-git/bin /opt/build-git/lib
gcc -Wall -Wextra -Werror -shared -fPIC -x c - -o /opt/build-git/lib/libgit-eof.so -ldl <<'GIT_EOF_SOURCE'
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <dlfcn.h>
#include <errno.h>
ssize_t getdelim(char **lineptr, size_t *n, int delimiter, FILE *stream) {
  ssize_t (*next)(char **, size_t *, int, FILE *) = dlsym(RTLD_NEXT, "getdelim");
  if (!next) {
    fputs("FATAL: native Git EOF adapter cannot resolve getdelim\n", stderr);
    abort();
  }
  ssize_t result = next(lineptr, n, delimiter, stream);
  if (result < 0 && errno == ENOMEM && lineptr && *lineptr
      && feof(stream) && !ferror(stream)) errno = 0;
  return result;
}
GIT_EOF_SOURCE
cat > /opt/build-git/bin/git <<'GIT_EOF_WRAPPER'
#!/bin/sh
export LD_PRELOAD="/opt/build-git/lib/libgit-eof.so${LD_PRELOAD:+:$LD_PRELOAD}"
exec /usr/bin/git "$@"
GIT_EOF_WRAPPER
chmod 755 /opt/build-git/bin/git
GIT_EOF_COMPAT
# Keep this closure after the toolchain layers so extending GUI prerequisites
# reuses the native compiler and verified rootfs already built for Server.
RUN <<'NATIVE_GUI_BUILD'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
# NATIVE_GUI_PREFLIGHT_BEGIN
for module in gtk+-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 ayatana-appindicator3-0.1 librsvg-2.0; do
  if ! pkg-config --exists "$module"; then
    echo "ERROR: native builder requires GUI development module $module" >&2
    exit 2
  fi
done
unset module
# NATIVE_GUI_PREFLIGHT_END
rm -rf /var/lib/apt/lists/*
NATIVE_GUI_BUILD
# This builds audited Server releases from independent /product inputs. The
# audited pinned dogfood route supports both native architectures and already
# skips the unused development dependency generation after install. vm-release
# has a separate Linux-x64-only trust toolchain; do not select it for ARM64.
ENV PAPERCUSP_DISTRIBUTION_PROFILE=dogfood \
    PAPERCUSP_RELEASE_AUDIT=1 \
    PAPERCUSP_PINNED_DEPS_SNAPSHOT_ROOT=/product \
    PATH=/opt/build-git/bin:/opt/build-node/bin:/opt/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    RUSTUP_HOME=/opt/rustup
# Run as the source/output owner's UID with a separate writable HOME/CARGO_HOME.
# Do not mount host toolchains, dependencies, credentials or Docker's socket.
CMD ["bash"]
