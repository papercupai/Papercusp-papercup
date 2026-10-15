#!/usr/bin/env python3
"""One owned execution of the maintained source, packaging and WDIO tools."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

repo = Path('/home/marsh-office/papercupai-workspace/papercusp')
art = Path(__file__).resolve().parent
ref = 'a9a08d8758ba00cde995b65219e711925349e7ef'
status = art / 'run.json'
source = None

def record(phase, **extra):
    if source is not None:
        extra.setdefault('sourceRoot', str(source))
    status.write_text(json.dumps(dict(phase=phase, pid=os.getpid(), at=time.time(), sourceRef=ref, **extra), indent=2))
    print(json.dumps(dict(phase=phase, **extra)), flush=True)

def run(args, logfile, env=None, cwd=repo):
    with (art / logfile).open('x') as output:
        result = subprocess.run(args, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f'{logfile}: exit {result.returncode}')

try:
    inputs = json.loads((art/'source-inputs.json').read_text())
    if not inputs or not all(isinstance(p, str) and not Path(p).is_absolute() and '..' not in Path(p).parts for p in inputs):
        raise RuntimeError('Missing or invalid persisted native source inputs')
    resume = sys.argv[1:] == ['--resume-native']
    if resume:
        previous = json.loads(status.read_text())
        phase = previous.get('phase')
        if phase not in {'failed', 'native'}:
            raise RuntimeError('Native resume requires an existing native/failed parent')
        previous_pid = previous.get('pid')
        if isinstance(previous_pid, int) and previous_pid != os.getpid():
            try:
                os.kill(previous_pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError('Previous parent still exists; reconcile it before resume')
        source = Path((art/'source-root.txt').read_text().strip()).resolve(strict=True)
    else:
        record('materialize')
        run(['node', 'scripts/lint-as-committed.mjs', '--materialize-only', '--any', '--ref='+ref, '--retain-for='+str(status)], 'materialize.log')
        materialized = (art / 'materialize.log').read_text()
        match = re.search(r'Committed source prepared at (.+); no lint or test was run\.', materialized)
        if not match:
            raise RuntimeError('No successful maintained source materialization receipt')
        source = Path(match.group(1)).resolve(strict=True)
        (art / 'source-root.txt').write_text(str(source)+'\n')
    actual = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != ref:
        raise RuntimeError('Materialized source identity changed')
    if not all((source/p).is_file() for p in inputs):
        raise RuntimeError('A persisted native source input is absent')
    if not resume:
        record('sidecar')
        build_env = dict(os.environ, REPO_ROOT=str(source), PAPERCUSP_DESKTOP_TARGET_ROOT=str(source/'papercusp-desktop'), PAPERCUSP_BUILD_SHA=ref, PAPERCUSP_DISTRIBUTION_PROFILE='dogfood', PAPERCUSP_RELEASE_AUDIT='1')
        run(['bash', 'papercusp-desktop/bin/build-desktop-sidecar.sh'], 'sidecar.log', build_env)
    sidecar = source/'papercusp-desktop/src-tauri/sidecar'
    provenance = json.loads((sidecar/'build-provenance.json').read_text())
    if provenance.get('buildSha') != ref or provenance.get('gitDirty') is not False:
        raise RuntimeError('Prepared sidecar provenance is not the exact clean source')
    if not (sidecar/'.sidecar-build-stamp').is_file() or (sidecar/'spa/internal/docs').exists():
        raise RuntimeError('Canonical sidecar audit/pruning prerequisite missing')
    subprocess.run(['node', str(repo/'scripts/source-preview.mjs'), 'verifier-inputs-check',
                    '--repo', str(source), '--ref', ref, '--tauri-inputs',
                    '--inputs-file', str(art/'source-inputs.json')], check=True, cwd=repo)
    native_log = 'native.log'
    ordinal = 1
    while (art/native_log).exists():
        ordinal += 1
        native_log = f'native-{ordinal}.log'
    record('native', sourceRoot=str(source), sidecar=str(sidecar), nativeLog=native_log)
    native_env = dict(os.environ, PAPERCUSP_REPO_DIR=str(repo), VERIFY_TAURI_ISOLATED_DB='1', VERIFY_TAURI_ISOLATED_SEED='ready', VERIFY_TAURI_SOURCE_REF=ref, VERIFY_TAURI_SOURCE_INPUTS_FILE=str(art/'source-inputs.json'), PAPERCUSP_SHARED_SPA_DIST=str(sidecar/'spa'), PAPERCUSP_PREBUILT_SIDECAR=str(sidecar), R5_EVIDENCE_DIR=str(art))
    run(['bash', str(source/'scripts/verify-tauri-headless.sh'), '--', 'bash', str(art/'assert.sh')], native_log, native_env, cwd=source)
    record('passed', sourceRoot=str(source))
except Exception as error:
    record('failed', error=str(error))
    sys.exit(1)
