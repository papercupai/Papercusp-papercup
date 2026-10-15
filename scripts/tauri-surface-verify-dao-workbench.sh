#!/usr/bin/env bash
# Maintained isolated desktop leg; synthetic transports never enter product code.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/libs/generic/verification-harness/bin/vh.sh"
vh_phase preflight ""
vh_phase desktop preflight
vh_phase mobile desktop
echo "DAO_NATIVE_PREFLIGHT stage=harness-init elapsedSec=$SECONDS"
vh_init dao-workbench "${DAO_WORKBENCH_HARNESS_EVIDENCE_ROOT:-/tmp/pcv/dao-workbench}"
vh_begin preflight
# A lint-as-committed source clone links its dependency contents to the donor.
# Validate the existing donor override before imports or native rig allocation;
# verify-tauri-headless keeps that donor separate from the frozen source ref.
DEPENDENCY_DONOR="${PAPERCUSP_REPO_DIR:-$ROOT}"
echo "DAO_NATIVE_PREFLIGHT stage=dependency-donor elapsedSec=$SECONDS"
if ! bash "$ROOT/papercusp-desktop/bin/lib/pinned-deps.sh" preflight "$DEPENDENCY_DONOR"; then
  echo "DAO native dependency donor failed preflight: $DEPENDENCY_DONOR" >&2
  echo 'For a lint-as-committed source clone, set PAPERCUSP_REPO_DIR to the canonical dependency donor; VERIFY_TAURI_SOURCE_REF still pins the tested source.' >&2
  exit 2
fi
# Pin the shared result ledger and caller identity before the rig rebinds the
# app to its disposable database/workspace. Reuse the existing ledger resolver.
echo "DAO_NATIVE_PREFLIGHT stage=ledger elapsedSec=$SECONDS"
export PAPERCUSP_TEST_RUNS_DB_URL="$(node --input-type=module -e 'import { resolveExecutedMapPgUrl } from "./scripts/lib/executed-source-map.mjs"; process.stdout.write(resolveExecutedMapPgUrl().url)')"
export PAPERCUSP_TEST_RUN_HARNESS="${PAPERCUSP_TEST_RUN_HARNESS:-${PAPERCUSP_HARNESS_SLUG:-papercusp}}"
export PAPERCUSP_TEST_RUN_WORKSPACE="${PAPERCUSP_TEST_RUN_WORKSPACE:-${PAPERCUSP_WORKSPACE_ID:-${PAPERCUSP_WORKSPACE:-}}}"
if [ -z "$PAPERCUSP_TEST_RUN_WORKSPACE" ]; then
  echo 'DAO native acceptance requires an explicit caller workspace for its shared test ledger' >&2
  exit 2
fi
# Validate the scope oracle through the real reader on the maintained baseline
# fixture before spending a native build on an invalid negative-control premise.
echo "DAO_NATIVE_PREFLIGHT stage=scope elapsedSec=$SECONDS"
npm run test:file -- packages/operator-core/lib/dao-workbench-scope.integration.test.ts
FIXTURE_DIR="$(mktemp -d /tmp/dao-workbench-identity.XXXXXX)"
trap 'rm -rf -- "$FIXTURE_DIR"' EXIT
vh_bracket_trap
echo "DAO_NATIVE_PREFLIGHT stage=fixture elapsedSec=$SECONDS"
node "$ROOT/scripts/fixtures/dao-workbench-identity.mjs" --prepare "$FIXTURE_DIR" >/dev/null
echo "DAO_NATIVE_PREFLIGHT stage=imports elapsedSec=$SECONDS"
node --import tsx "$ROOT/scripts/tauri-surface-verify-dao-workbench.mts" --check-imports
# The maintained verifier applies geometry before mapping the native window.
# Each viewport owns a fresh isolated boot; no runtime window permissions needed.
for viewport in 1440x1000 390x844; do
  echo "DAO_NATIVE_PREFLIGHT stage=viewport viewport=$viewport elapsedSec=$SECONDS"
  if [ "$viewport" = 1440x1000 ]; then vh_begin desktop; else vh_begin mobile; fi
  assertion_args=(--e2e)
  if [ "$viewport" = 390x844 ]; then assertion_args+=(--viewport-only); fi
  VERIFY_TAURI_WINDOW="$viewport" DAO_WORKBENCH_VIEWPORT="$viewport" \
  VERIFY_TAURI_ISOLATED_DB=1 VERIFY_TAURI_ISOLATED_SEED=ready \
  VERIFY_TAURI_REQUIRE_BUILT='apps/operator-vite/src/components/dao/DaoWorkspace.tsx apps/operator-vite/src/components/dao/DaoGovernance.tsx apps/operator-vite/src/components/dao/DaoExecution.tsx apps/operator-vite/src/components/dao/dao-workspace.css apps/operator/app/_components/ChromeShell.tsx packages/operator-core/lib/chromeless-routes.ts packages/operator-core/lib/agent-tools/plans/governance-event.ts' \
  DAO_WORKBENCH_IDENTITY_FIXTURE="$FIXTURE_DIR/identity.json" \
  PAPERCUSP_VERIFY_TAURI_ISOLATED=1 \
  NODE_OPTIONS="${NODE_OPTIONS:-} --import=$ROOT/scripts/fixtures/dao-workbench-identity.mjs" \
  "${TAURI_SURFACE_VERIFY_SUITE_VERIFIER:-$ROOT/scripts/verify-tauri-headless.sh}" -- \
  node --import tsx "$ROOT/scripts/tauri-surface-verify-dao-workbench.mts" "${assertion_args[@]}"
done
