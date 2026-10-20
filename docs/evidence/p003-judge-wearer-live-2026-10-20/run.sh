#!/usr/bin/env bash
# P-003 / R-1 live judge-wearer probe (identity-system-everything-migration-2026-10-18,
# WI-6554700010017314). Launches two judges through the live :3170 role door — one wearing a
# grant-bearing (governed) stack, one wearing a grant-free (ungoverned) stack — and exercises
# each signed judge grant at dispatch. Exits non-zero when any assertion of either run fails.
#
# Run from the repository root in a HOST-context shell (capability:bash): stage 2 reads
# Postgres with `sudo -n -u postgres psql`, which the Claude native sandbox cannot do.
# Stage-1 launch bodies carry per-session env and stay in gitignored scratch; the two stage-2
# reports written beside this script are the committed evidence.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2
HERE=docs/evidence/p003-judge-wearer-live-2026-10-20
SCRATCH=.papercusp/scratch/p-identity/p003-live-run
mkdir -p "$SCRATCH" || exit 2
rc=0

run_one() { # name stack governed layer-mark
  local name=$1 stack=$2 governed=$3 mark=$4
  PROBE_STACK="$stack" node "$HERE/stage1-launch.mjs" "$SCRATCH/$name-stage1.json" > "$SCRATCH/$name-stage1.stdout"
  echo "STAGE1 $name exit=$?"
  PROBE_GOVERNED="$governed" PROBE_LAYER_MARK="$mark" \
    node "$HERE/stage2-exercise.mjs" "$SCRATCH/$name-stage1.json" "$HERE/$name-report.json"
  local e=$?
  echo "STAGE2 $name exit=$e"
  [ "$e" -eq 0 ] || rc=1
}

run_one governed 'domain:blueprint-operation-worker' 1 '# Blueprint operation worker'
run_one ungoverned 'ideation:su.mode-ideate' 0 "## IDEATE mode — the owner's switch"
echo "RUN_EXIT=$rc"
exit "$rc"
