#!/usr/bin/env bash
# papercup-vite-rebuild — rebuild the operator-vite SPA (the static bundle the
# nohmr desktop at :3270 serves) ONLY when frontend source changed since the last
# build. Fired by papercup-vite-rebuild.timer every ~2 min.
#
# NO auto-refresh: this only writes the static dist to disk. The Tauri webview
# shows the new bundle on the next MANUAL reload (Ctrl-R) — it is NOT like HMR,
# nothing pushes a reload. Idle ticks (no frontend change) are a fast no-op.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VITE="$REPO/apps/operator-vite"
# The "last build" marker is dated to when the last successful build STARTED reading
# source, not when it finished. A build takes minutes under load, and index.html is
# rewritten at its end: using that as the marker made any edit that landed DURING a
# build look already built, so it was never rebuilt (measured 2026-09-30: a build ran
# 09:10:51-09:25:14Z, a viewer edit landed ~09:17Z, and the served SPA never got it).
STAMP="$VITE/dist/.vite-rebuild-source-stamp"
[[ -f "$STAMP" || ! -f "$VITE/dist/index.html" ]] || touch -r "$VITE/dist/index.html" "$STAMP"

# Keep the timer trigger and verification warning on the same maintained roots.
# Missing optional roots are ignored; no source roots is a refusal, not a clean tick.
# node_modules/dist + test/spec files are pruned since they do not change the bundle.
. "$REPO/scripts/lib/spa-require-built.sh"
ROOTS=()
for rel in "${SRB_REBUILD_ROOTS[@]}"; do
  if [[ -d "$REPO/$rel" ]]; then ROOTS+=("$REPO/$rel"); fi
done
if [[ "${#ROOTS[@]}" -eq 0 ]]; then
  echo "[vite-rebuild] SPA source roots are missing — refusing to skip/build" >&2
  exit 1
fi

cd "$REPO"

if [[ -f "$STAMP" ]]; then
  changed="$(find "${ROOTS[@]}" \
      \( -path '*/node_modules/*' -o -path '*/dist/*' -o -name '*.test.*' -o -name '*.spec.*' \) -prune -o \
      -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -newer "$STAMP" -print -quit 2>/dev/null)"
  if [[ -z "$changed" ]]; then
    echo "[vite-rebuild] no frontend source changes since last build — skip"
    exit 0
  fi
  echo "[vite-rebuild] change detected (${changed#$REPO/}) — rebuilding"
else
  echo "[vite-rebuild] no prior build — building"
fi

cd "$VITE"
# Retain old hashed chunks across this rebuild instead of emptying dist/ (which
# would 404 the lazy chunks a long-open Tauri webview is pinned to → "Importing
# a module script failed" dead screen — WI-1484). vite.config reads this env to
# switch to emptyOutDir:false + the age-based prune (60-min TTL) so an open
# webview keeps resolving the build it loaded and growth stays bounded.
export PAPERCUSP_RETAIN_DIST_CHUNKS=1
START_MARK="$(mktemp)"
trap 'rm -f "$START_MARK"' EXIT
npm run build
# vite-build-singleflight dates the bundle to when it actually began reading
# source (after its lock wait and npm's prebuild); prefer that when it is newer
# so edits made while this build queued do not trigger a redundant rebuild
# (WI-10006797). Fall back to START_MARK for an older singleflight.
SF_STAMP="$VITE/dist/.vite-build-source-read-at"
if [[ -f "$SF_STAMP" && "$SF_STAMP" -nt "$START_MARK" ]]; then
  touch -r "$SF_STAMP" "$STAMP"
else
  touch -r "$START_MARK" "$STAMP"
fi
echo "[vite-rebuild] build done (chunk-retain on)"
