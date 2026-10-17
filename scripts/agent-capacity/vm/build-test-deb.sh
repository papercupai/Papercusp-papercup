#!/usr/bin/env bash
# Build a TEST-ARTIFACT Papercusp Server .deb from prepared, pinned source and prove it carries the
# fixes under test before any VM time is spent on it (plan agent-capacity-and-cost-gcp-2026-09-30,
# WI-10006497; replaces the per-run ~/.cache/agent-capacity/p532*/build.sh copies).
#
# The fixes are named in MARKERS_FILE, one per line:   <name> <file> <extended regex>
#   <file>  repo-relative or absolute path, or the literal @sidecar for the freshly built sidecar
#           bundle (SIDECAR_BUNDLE, default papercusp-desktop/src-tauri/sidecar/serve.mjs).
#   regex   the rest of the line (may contain spaces); a marker passes when it matches >= 1 line.
#   Blank lines and lines starting with # are ignored.
# Source-file markers are checked BEFORE the build, so a fix missing from the tree fails in seconds
# instead of after a 2 h build. @sidecar markers are checked after the sidecar step, because esbuild
# rewrites quoting and spacing (e.g. ('local', 'document') becomes ("local","document")). The bundle
# is whitespace-minified AND comment-stripped, so a source COMMENT is never a usable @sidecar marker
# (c1006, 2026-10-06: a comment marker read 0 while the fix's code was in the bundle). Match code,
# keyed by a neighbour unique to the fixed call site, and run CHECK_ONLY=1 against the new bundle to
# confirm each @sidecar marker reads >= 1 before trusting a miss.
# Every marker logs "MARKER <name>=<count>"; a miss also logs "MARKER_MISSING <name>".
#
# Env: MARKERS_FILE (required) · CHECK_ONLY=1 checks every marker against the files as they are now
# and builds nothing · SKIP_SIDECAR=1 reuses the sidecar bundle already on disk (deb-only resume) ·
# REPO_ROOT selects immutable inputs prepared with the maintained
# apps/operator/bin/release/setup-release-checkout.sh --source-only --source-root-mode clone
# --source-integrity object-sourced, followed by its --prepare-existing dependency step.
# Both build phases run from that input tree; CHECK_ONLY may inspect the live tree.
# PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC (default 7200) is how long an unattended build waits for a
# peer's build lock instead of failing at the 60 s interactive default (EI-24961470606265468).
# Exit: 0 built (build-and-archive-deb.sh prints TEST_ARTIFACT_DEB=<path>) · 7 marker missing ·
# 8 usage · otherwise the failing step's own exit code (SIDECAR_RC / DEB_RC lines say which).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd) || exit 8
SOURCE_ROOT=$(cd "${REPO_ROOT:-$ROOT}" && pwd) || exit 8
DESKTOP_ROOT=$(cd "${PAPERCUSP_DESKTOP_TARGET_ROOT:-$SOURCE_ROOT/papercusp-desktop}" && pwd) || exit 8
MARKERS_FILE=${MARKERS_FILE:-}
SIDECAR_BUNDLE=${SIDECAR_BUNDLE:-$DESKTOP_ROOT/src-tauri/sidecar/serve.mjs}
export REPO_ROOT="$SOURCE_ROOT" PAPERCUSP_REPO_DIR="$SOURCE_ROOT"
export PAPERCUSP_DESKTOP_TARGET_ROOT="$DESKTOP_ROOT"
export PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC=${PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC:-7200}
export PAPERCUSP_TRANSFORMERS_MODEL_CACHE=${PAPERCUSP_TRANSFORMERS_MODEL_CACHE:-$HOME/.cache/papercusp-models}
ts() { date -u +%FT%TZ; }

if [ -z "$MARKERS_FILE" ] || [ ! -f "$MARKERS_FILE" ]; then
  echo "USAGE: MARKERS_FILE=<file> [CHECK_ONLY=1] [SKIP_SIDECAR=1] $0  (MARKERS_FILE='$MARKERS_FILE' not found)" >&2
  exit 8
fi

# check_markers source|sidecar — returns 1 when any marker of that phase matched nothing.
check_markers() {
  local phase=$1 name file re path n missing=0 seen=0
  while read -r name file re || [ -n "$name" ]; do
    case "$name" in '' | '#'*) continue ;; esac
    if [ -z "$file" ] || [ -z "$re" ]; then echo "MARKER_MALFORMED $name"; missing=$((missing + 1)); continue; fi
    if [ "$file" = @sidecar ]; then
      [ "$phase" = sidecar ] || continue
      path=$SIDECAR_BUNDLE
    else
      [ "$phase" = source ] || continue
      case "$file" in /*) path=$file ;; *) path=$SOURCE_ROOT/$file ;; esac
    fi
    seen=$((seen + 1))
    n=$(grep -cE -- "$re" "$path" 2>/dev/null); n=${n:-0}
    echo "MARKER $name=$n"
    if [ "$n" -lt 1 ]; then echo "MARKER_MISSING $name ($path)"; missing=$((missing + 1)); fi
  done < "$MARKERS_FILE"
  echo "MARKERS_CHECKED phase=$phase count=$seen missing=$missing $(ts)"
  [ "$missing" -eq 0 ]
}

echo "BUILD_START $(ts) tree=$(git -C "$SOURCE_ROOT" rev-parse --short HEAD 2>/dev/null)"
check_markers source || exit 7
if [ "${CHECK_ONLY:-0}" = 1 ]; then
  check_markers sidecar || exit 7
  echo "CHECK_ONLY_OK $(ts)"
  exit 0
fi

# Git-sync can move a branch while the long producer preflight runs. Refuse
# that input before starting either expensive phase; do not relax the producer's
# source identity guard. The materializer's detached clones remain stable.
for source in "$SOURCE_ROOT" "$DESKTOP_ROOT"; do
  if ! git -C "$source" rev-parse --verify HEAD >/dev/null 2>&1 \
      || git -C "$source" symbolic-ref -q HEAD >/dev/null 2>&1; then
    echo "ERROR: test-artifact build requires detached prepared source: $source" >&2
    echo "Prepare inputs with setup-release-checkout.sh --source-only --source-root-mode clone --source-integrity object-sourced; set REPO_ROOT to that tree." >&2
    exit 8
  fi
done
# The archive producer packages this directory. Checking markers elsewhere
# could certify bytes that never enter the deb, even when the build succeeds.
if [ "$SIDECAR_BUNDLE" != "$DESKTOP_ROOT/src-tauri/sidecar/serve.mjs" ] \
    || [ "${PAPERCUSP_SIDECAR_OUT:-$DESKTOP_ROOT/src-tauri/sidecar}" != "$DESKTOP_ROOT/src-tauri/sidecar" ]; then
  echo "ERROR: sidecar output and marker bundle must match the prepared desktop packaging input" >&2
  exit 8
fi

cd "$DESKTOP_ROOT" || exit 1
if [ "${SKIP_SIDECAR:-0}" = 1 ]; then
  echo "SIDECAR_SKIPPED reusing $SIDECAR_BUNDLE $(ts)"; rc=0
else
  bash bin/build-desktop-sidecar.sh; rc=$?
fi
echo "SIDECAR_RC=$rc $(ts)"
[ "$rc" -eq 0 ] || exit "$rc"
check_markers sidecar || exit 7

bash bin/build-and-archive-deb.sh --test-artifact; rc=$?
echo "DEB_RC=$rc $(ts)"
exit "$rc"
