#!/usr/bin/env bash
#
# postbuild-copy.sh — deploy the public Papercusp docs into the operator.
#
# Astro builds the public docs into ./dist with `base: '/docs'`. The operator
# Hono host serves `apps/operator/public/docs/` at `/docs/*` (see
# `apps/operator/bin/host-docs-public.ts`), so deploying is just mirroring
# dist/ into apps/operator/public/docs/.
#
# Wired into `npm run build` (astro build && bash this). cwd = apps/papercusp-docs.
#
set -euo pipefail

SRC="dist"
DEST="../operator/public/docs"

if [[ ! -d "$SRC" ]]; then
  echo "postbuild-copy: '$SRC' not found — run 'astro build' first" >&2
  exit 1
fi

mkdir -p "$DEST"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$SRC"/ "$DEST"/
else
  rm -rf "${DEST:?}"/*
  cp -R "$SRC"/. "$DEST"/
fi

# Package the same canonical public content for fresh/standalone Papercup
# installs. Keep it separate from the engineering tree and the HTML route.
MANUAL_SOURCE_DEST="../operator/public/manual-source"
mkdir -p "$MANUAL_SOURCE_DEST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete src/content/docs/ "$MANUAL_SOURCE_DEST"/
else
  rm -rf "${MANUAL_SOURCE_DEST:?}"/*
  cp -R src/content/docs/. "$MANUAL_SOURCE_DEST"/
fi

echo "postbuild-copy: $(find "$DEST" -type f | wc -l | tr -d ' ') files → $DEST"
