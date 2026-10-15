#!/usr/bin/env bash
# install-rtk.sh — install the pinned RTK binary at ~/.local/bin/rtk
# (WI-6554700010009291, owner directives #1759 / #1764).
#
# RTK (https://github.com/rtk-ai/rtk) compresses shell output for agents. Two
# Papercusp seams call it: the native-Bash PreToolUse egress guard
# (hooks/cc/pretooluse-restricted-egress-guard.mjs) and capability:bash
# (packages/operator-core/lib/agent-tools/capability/rtk-rewrite.ts). Both fail
# open when the binary is missing, so a missing binary silently disables RTK.
# That is exactly how it disappeared before: it lived in the Homebrew prefix, the
# prefix was rebuilt on 2026-08-15, and nothing reinstalled it.
#
# So the binary is now OURS to provision: a pinned release, sha256-verified,
# installed outside any package manager's prefix, and re-checked on every run of
# install-standalone-mcp.sh. Idempotent: a binary already at the pinned version
# is left alone and nothing is downloaded.
#
# Upgrading: bump RTK_VERSION and replace every hash below with the values from
# that release's checksums.txt (the .tar.gz lines), then re-run the tests in
# apps/operator/scripts/__tests__/install-rtk.test.ts.
#
# Environment (all optional):
#   RTK_INSTALL_DIR              install directory (default ~/.local/bin)
#   RTK_INSTALL_URL_BASE         release download base (default the GitHub release)
#   RTK_INSTALL_EXPECTED_SHA256  replace the pinned hash; for tests with a fake
#                                release only
#   RTK_INSTALL_PLATFORM         override `uname -sm` detection, e.g. "Linux x86_64"
#
# Exit codes: 0 installed or already current · 1 download/verify/install failed
#             · 2 unsupported platform.
set -euo pipefail

RTK_VERSION="0.51.0"
INSTALL_DIR="${RTK_INSTALL_DIR:-${HOME}/.local/bin}"
URL_BASE="${RTK_INSTALL_URL_BASE:-https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}}"
DEST="${INSTALL_DIR}/rtk"

platform="${RTK_INSTALL_PLATFORM:-$(uname -s) $(uname -m)}"
case "$platform" in
  "Linux x86_64")
    asset="rtk-x86_64-unknown-linux-musl.tar.gz"
    pinned="5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5" ;;
  "Linux aarch64" | "Linux arm64")
    asset="rtk-aarch64-unknown-linux-gnu.tar.gz"
    pinned="8d6d1aad9e69b42481eda7039507d1f7ee93698f87713cecd873d287c1931632" ;;
  "Darwin x86_64")
    asset="rtk-x86_64-apple-darwin.tar.gz"
    pinned="bd39c8153f4147358360c7dc51665a8131cc9ee16f81f69a9402ffa500be3cc2" ;;
  "Darwin arm64" | "Darwin aarch64")
    asset="rtk-aarch64-apple-darwin.tar.gz"
    pinned="8817d8b71afc02ac8bf06eb24bcc41c306592ab735b68e8fee9db1ba0de7cb59" ;;
  *)
    echo "! rtk: no pinned release for platform '${platform}'; RTK stays disabled (both seams fail open)" >&2
    exit 2 ;;
esac
expected="${RTK_INSTALL_EXPECTED_SHA256:-$pinned}"

installed_version() {
  [ -x "$DEST" ] || return 1
  "$DEST" --version 2>/dev/null | awk '{ print $2; exit }'
}

if [ "$(installed_version || true)" = "$RTK_VERSION" ]; then
  echo "✓ rtk ${RTK_VERSION} already installed at ${DEST}"
  exit 0
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

work="$(mktemp -d "${TMPDIR:-/tmp}/install-rtk.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT

if ! curl -fsSL --retry 2 -o "${work}/${asset}" "${URL_BASE}/${asset}"; then
  echo "✗ rtk: download failed: ${URL_BASE}/${asset}" >&2
  exit 1
fi

actual="$(sha256_of "${work}/${asset}")"
if [ "$actual" != "$expected" ]; then
  echo "✗ rtk: sha256 mismatch for ${asset}: expected ${expected}, got ${actual}; refusing to install" >&2
  exit 1
fi

mkdir -p "${work}/x"
tar -xzf "${work}/${asset}" -C "${work}/x"
if [ ! -f "${work}/x/rtk" ]; then
  echo "✗ rtk: ${asset} has no top-level rtk binary" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
tmp_dest="$(mktemp "${DEST}.tmp.XXXXXX")"
if ! { cp -- "${work}/x/rtk" "$tmp_dest" && chmod 755 "$tmp_dest" && mv -f -- "$tmp_dest" "$DEST"; }; then
  rm -f -- "$tmp_dest" || true
  echo "✗ rtk: could not install to ${DEST}" >&2
  exit 1
fi

got="$(installed_version || true)"
if [ "$got" != "$RTK_VERSION" ]; then
  echo "✗ rtk: installed ${DEST} reports version '${got}', expected ${RTK_VERSION}" >&2
  exit 1
fi
echo "✓ Installed rtk ${RTK_VERSION} at ${DEST} (sha256 ${actual})"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) : ;;
  *) echo "! ${INSTALL_DIR} is not on PATH; the RTK seams still find ${DEST} directly" ;;
esac
