#!/usr/bin/env bash
set -euo pipefail
test "$VERIFY_TAURI_ISOLATED_DB" = 1
r5_desktop="$OPERATOR_SOURCE_ROOT/papercusp-desktop"
export PAPERCUSP_DESKTOP_TARGET_ROOT="$r5_desktop"
export PAPERCUSP_BUILD_SHA="$VERIFY_TAURI_SOURCE_REF"
export TAURI_SIGNING_PRIVATE_KEY_PATH=/home/marsh-office/.papercusp/signing/papercusp.key

# Preserve the verifier's generated placeholders before replacing its private
# tree. No shared/archive path is removed, and an unexpected staged tree fails.
python3 - <<'PY'
import os
from pathlib import Path
import shutil
source = Path(os.environ['PAPERCUSP_PREBUILT_SIDECAR']).resolve(strict=True)
root = Path(os.environ['OPERATOR_SOURCE_ROOT']).resolve(strict=True)
desktop = root/'papercusp-desktop/src-tauri'
target = desktop/'sidecar'
stage = desktop/'sidecar-r5-complete'
if stage.exists() or stage.is_symlink() or target.is_symlink():
    raise RuntimeError('Unexpected existing R5 staging destination')
if target.exists():
    files = list(target.rglob('*'))
    if any(p.is_symlink() or (p.is_file() and p.name != 'PLACEHOLDER-README.txt') for p in files):
        raise RuntimeError('Verifier sidecar contains more than its known placeholders')
    backup = desktop/'sidecar-before-r5'
    if backup.exists(): raise RuntimeError('Placeholder backup already exists')
    target.rename(backup)
shutil.copytree(source, stage, symlinks=True)
shutil.copytree(os.environ['VERIFY_TAURI_SPA_DIST'], stage/'spa', dirs_exist_ok=True, symlinks=True)
stage.rename(target)
if (target/'spa/internal/docs').exists(): raise RuntimeError('Unpruned SPA')
PY

cd "$r5_desktop"
npm run build
mapfile -d '' r5_apps < <(find "$CARGO_TARGET_DIR/release/bundle/deb" -path '*/data/usr/bin/papercusp-desktop' -type f -print0)
test "${#r5_apps[@]}" -eq 1
export TAURI_APP_PATH="${r5_apps[0]}"
export PAPERCUSP_PERF_RUN_ID="r5-matching-a9a08d8758-20261015-retained"
export PAPERCUSP_PERF_WORKSPACE_ID="$PAPERCUSP_WORKSPACE"

# Reuse the project's disposable harness fixture, then create/read one real
# plan through the same admin API as its maintained plan-launch E2E test.
cd "$OPERATOR_SOURCE_ROOT"
DATABASE_URL="$HARNESS_ADMIN_DATABASE_URL" node apps/operator/dist-verify/fake-llm-fixture-child.mjs harness e2e-fake-plan
node --input-type=module - <<'JS'
import fs from 'node:fs';
const origin = process.env.VERIFY_TAURI_DEV_URL;
const token = fs.readFileSync(process.env.PAPERCUSP_HOME+'/superuser-token','utf8').trim();
const headers = {'content-type':'application/json', authorization:'Bearer '+token};
const content = '# Native performance fixture\n\n## Now\n\nMeasure opening this plan in the packaged desktop.\n\n## Requirements\n\n- R-1: Open this plan from the real sidebar.\n\n## Plan\n\n- P-001 `open` Verify the packaged interaction.\n';
const request = {harness:'e2e-fake-plan',slug:'r5-native-performance-fixture-2026-10-15',title:'Native performance fixture',status:'draft',content};
const response=await fetch(origin+'/api/admin/plans/new',{method:'POST',headers,body:JSON.stringify(request),signal:AbortSignal.timeout(30000)});
const body=await response.json();
if(!response.ok||body.ok!==true||!body.slug)throw new Error('Private fixture plan creation failed: '+JSON.stringify(body));
const read=await fetch(origin+'/api/admin/plans/get?'+new URLSearchParams({harness:'e2e-fake-plan',slug:body.slug,mode:'full'}),{headers,signal:AbortSignal.timeout(30000)});
const verified=await read.json();
if(!read.ok||verified.ok!==true||typeof verified.raw!=='string'||!verified.raw.includes('Native performance fixture'))throw new Error('Private fixture plan readback failed');
fs.writeFileSync(process.env.R5_EVIDENCE_DIR+'/fixture.json',JSON.stringify({slug:body.slug,harness:'e2e-fake-plan',contentHash:verified.contentHash}));
JS
export PAPERCUSP_PERF_PLAN_SLUG="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.R5_EVIDENCE_DIR+"/fixture.json")).slug)')"
cd "$OPERATOR_SOURCE_ROOT/tools/perf-test/wdio"
set +e
npm run test:wdio
r5_result=$?
set -e
mkdir -p "$VH_PHASE_DIR/artifacts/wdio" "$R5_EVIDENCE_DIR/wdio"
cp -a results/. "$VH_PHASE_DIR/artifacts/wdio/"
cp -a results/. "$R5_EVIDENCE_DIR/wdio/"
exit "$r5_result"
