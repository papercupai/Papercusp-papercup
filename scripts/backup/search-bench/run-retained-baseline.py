"""Run a NEW retained-corpus edition inside source-preview verifier + with-test-pg.

The v2 plan pins consumption/schema/query/configuration receipts, a real benchmark
journal fixture and expected table counts. Journal parsing and an ordinary SDK
runtime request must qualify before corpus restoration. Runtime instrumentation
and timing use distinct outputs. This driver never extends an earlier edition.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit, urlunsplit


RUNTIME_POLICY = {'PAPERCUSP_MEMORY_EMBEDDER': 'gemma', 'PAPERCUSP_EMBED_DEVICE': 'cpu',
                  'PAPERCUSP_TRANSFORMERS_LOCAL_ONLY': '1', 'PAPERCUSP_SKIP_PG_DISCOVERY': '1'}


def run_in_test_pg(plan_path, preflight_only=False):
    """Apply nonsecret measurement policies after the private runtime sanitizer."""
    plan = json.loads(Path(plan_path).read_bytes())
    validate_plan(plan)
    preflight_inputs(plan, Path.cwd())
    if not (Path.cwd() / '.verifier-source.json').is_file():
        raise ValueError('requires maintained immutable source verifier')
    command = ['node', 'scripts/with-test-pg.mjs', '--isolated-runtime', '--', 'env',
               *[key + '=' + value for key, value in RUNTIME_POLICY.items()],
               sys.executable, '-B', str(Path(__file__).resolve()), '--plan', str(Path(plan_path).resolve())]
    if preflight_only:
        command.append('--preflight-only')
    return subprocess.call(command)


def fingerprint(file):
    file = Path(file)
    before = file.stat()
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(block)
    after = file.stat()
    stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    if stamp(before) != stamp(after):
        raise ValueError('input changed during hashing: ' + str(file))
    return {'path': str(file), 'sha256': digest.hexdigest(), 'bytes': after.st_size}


def pinned(pin):
    actual = fingerprint(pin['path'])
    if actual['sha256'] != pin['sha256']:
        raise ValueError('input pin differs: ' + pin['path'])
    return json.loads(Path(pin['path']).read_bytes())


def validate_plan(plan):
    if plan.get('schemaVersion') != 2 or not plan.get('workItemId') or not plan.get('expectedCounts'):
        raise ValueError('missing edition identity or expected corpus population')
    for key in ['consumption', 'schema', 'queries', 'configuration']:
        if not plan.get(key, {}).get('path') or len(plan.get(key, {}).get('sha256', '')) != 64:
            raise ValueError('missing input pin: ' + key)
    if any(not table.replace('_', '').isalnum() or not isinstance(count, int) or count < 0
           for table, count in plan['expectedCounts'].items()):
        raise ValueError('invalid expected table population')
    empty = plan.get('expectedEmptyTables', [])
    if not isinstance(empty, list) or any(not isinstance(table, str) or not table
            or not table.replace('_', '').isalnum() for table in empty) \
            or len(set(empty)) != len(empty) or set(empty).intersection(plan['expectedCounts']):
        raise ValueError('invalid or overlapping empty auxiliary table population')
    destination = Path(plan['outputDirectory'])
    if not destination.is_absolute() or destination.exists():
        raise ValueError('edition requires a new absolute output directory')
    fixture = plan.get('protocolFixture', {})
    if type(fixture.get('exitCode')) is not int or fixture['exitCode'] not in (0, 1) \
            or type(fixture.get('executed')) is not int or fixture['executed'] <= 0:
        raise ValueError('missing actual journal fixture population or terminal status')
    suffixes = {'artifact': '', 'declaration': '.declaration.json',
                'attempts': '.attempts.jsonl', 'ledger': '.ledger.json'}
    artifact = fixture.get('artifact', {}).get('path', '')
    if not Path(artifact).is_absolute():
        raise ValueError('journal fixture requires an absolute artifact path')
    for key, suffix in suffixes.items():
        pin = fixture.get(key, {})
        if pin.get('path') != artifact + suffix or len(pin.get('sha256', '')) != 64:
            raise ValueError('missing or mismatched journal fixture pin: ' + key)
    if 'adapterCapture' in plan:
        for key in ['program', 'requests']:
            pin = plan['adapterCapture'].get(key, {})
            file = Path(pin.get('path', ''))
            if not pin.get('path') or '..' in file.parts or (key == 'requests' and not file.is_absolute()) \
                    or len(pin.get('sha256', '')) != 64:
                raise ValueError('missing actual adapter capture pin: ' + key)


def adapter_inputs(plan, repo):
    """Validate capture inputs before expensive restoration and again at dispatch."""
    capture = plan['adapterCapture']
    program = (repo / capture['program']['path']).resolve(strict=True)
    if not program.is_relative_to(repo.resolve()) or program.suffix not in ('.ts', '.mjs', '.js'):
        raise ValueError('adapter program must be inside immutable source tree')
    pins = []
    for key in ['program', 'requests']:
        actual = fingerprint(program if key == 'program' else capture[key]['path'])
        if actual['sha256'] != capture[key]['sha256']:
            raise ValueError('adapter capture pin differs: ' + key)
        pins.append(actual)
    requests = json.loads(Path(capture['requests']['path']).read_bytes())
    if not isinstance(requests, list) or not requests:
        raise ValueError('missing actual adapter request population')
    ids = set()
    for row in requests:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'] \
                or row['id'] in ids or not isinstance(row.get('adapter'), str) \
                or not row['adapter'] or not isinstance(row.get('args'), dict):
            raise ValueError('invalid or duplicate adapter request')
        ids.add(row['id'])
    return program, pins, requests


def preflight_inputs(plan, repo):
    """Cheap manifest refusals precede private PG startup and migration work."""
    inputs = {key: pinned(plan[key]) for key in ['consumption', 'schema', 'queries', 'configuration']}
    if 'adapterCapture' in plan:
        adapter_inputs(plan, repo)
    if inputs['queries']['configuration']['queryEmbeddingProfile'] != {
            'mode': 'gemma', 'profileId': 'gemma-embeddinggemma-300m-768@v1'}:
        raise ValueError('exact Gemma query profile required')
    if set(plan['expectedCounts']) != {t for a in inputs['schema']['archives'] for t in a['tables']}:
        raise ValueError('expected table population differs from selected archive ownership')
    return inputs


def capture_adapters(plan, repo, destination, command, env):
    """Invocation custody only; the pinned program owns actual adapter dispatch.

    These checks cannot authenticate its behavior or establish study acceptance.
    """
    program, pins, requests = adapter_inputs(plan, repo)
    capture = plan['adapterCapture']
    output = destination / 'adapter-captures.json'
    command('actual-adapters', ['node', '--import', 'tsx', str(program), '--requests',
            capture['requests']['path'], '--out', str(output)], env)
    rows = json.loads(output.read_bytes())
    if not isinstance(rows, list) or len(rows) != len(requests):
        raise ValueError('adapter capture population differs')
    for expected, row in zip(requests, rows):
        if not isinstance(row, dict) or row.get('schemaVersion') != 1 \
                or row.get('attemptId') != expected['id'] or row.get('adapter') != expected['adapter'] \
                or row.get('request') != expected['args'] \
                or type(row.get('exitCode')) is not int or row['exitCode'] != 0 \
                or not isinstance(row.get('stdout'), str) or not row['stdout'].strip() \
                or type(row.get('deliveryWallMs')) not in (int, float) \
                or not 0 <= row['deliveryWallMs'] < float('inf'):
            raise ValueError('adapter capture request or terminal evidence differs')
        json.loads(row['stdout'])
    for pin in pins:
        if fingerprint(pin['path']) != pin:
            raise ValueError('adapter input moved during capture')
    return {'inputs': pins, 'output': fingerprint(output), 'attempted': len(requests),
            'adapterBehaviorAuthenticated': False, 'baselineAccepted': False}


def runtime_preflight(plan, destination, assets_path, command, env):
    """Fail before restoration using the real protocol reader and ordinary SDK."""
    fixture = plan['protocolFixture']
    inputs = []
    for key in ['artifact', 'declaration', 'attempts', 'ledger']:
        actual = fingerprint(fixture[key]['path'])
        if actual['sha256'] != fixture[key]['sha256']:
            raise ValueError('journal fixture pin differs: ' + key)
        inputs.append(actual)
    protocol_path = destination / 'protocol-preflight.json'
    script = (
        "import fs from 'node:fs';"
        "import {readBenchmarkRuntimeEvidence} from './packages/operator-core/lib/memory/bench/runtime-benchmark-evidence.ts';"
        "const [artifact,exitCode,output]=process.argv.slice(1);"
        "const result=readBenchmarkRuntimeEvidence(['--out',artifact],Number(exitCode));"
        "fs.writeFileSync(output,JSON.stringify(result)+'\\n',{flag:'wx',mode:0o600});"
    )
    command('protocol-preflight', ['node', '--import', 'tsx', '--input-type=module', '-e', script,
                                 fixture['artifact']['path'], str(fixture['exitCode']), str(protocol_path)], env)
    protocol = json.loads(protocol_path.read_bytes())
    if protocol.get('executed') != fixture['executed'] or protocol.get('exitCode') != fixture['exitCode'] \
            or protocol.get('searchAdapterExercised') is not True \
            or protocol.get('baselineAccepted') is not False or protocol.get('latencyAcceptance') is not False:
        raise ValueError('actual journal protocol preflight did not qualify')
    for pin in inputs:
        if fingerprint(pin['path']) != pin:
            raise ValueError('journal fixture moved during preflight')
    prefix = destination / 'ordinary-runtime'
    command('ordinary-runtime', ['node', '--import', 'tsx',
            'packages/operator-core/lib/memory/bench/runtime-qualification-cli.ts', '--output', str(prefix),
            '--assets', str(assets_path), '--configuration', plan['configuration']['path']], env)
    report_path = Path(str(prefix) + '.report.json')
    ordinary = json.loads(report_path.read_bytes())
    if ordinary.get('kind') != 'shared-search-runtime-only-qualification' \
            or ordinary.get('qualifiedComponentsOnly') is not True \
            or ordinary.get('result') != {'code': 0, 'signal': None} \
            or ordinary.get('searchAdapterExercised') is not False \
            or ordinary.get('latencyAcceptance') is not False:
        raise ValueError('ordinary SDK runtime preflight did not qualify')
    return {'journalInputs': inputs, 'protocol': fingerprint(protocol_path),
            'ordinaryRuntime': fingerprint(report_path)}


def run(plan_path, preflight_only=False):
    plan = json.loads(Path(plan_path).read_bytes())
    validate_plan(plan)
    repo = Path.cwd().resolve()
    if not (repo / '.verifier-source.json').is_file():
        raise ValueError('requires maintained immutable source verifier')
    admin = os.environ['PAPERCUSP_TEST_PG_ADMIN_URL']
    endpoint = urlsplit(admin)
    if endpoint.hostname not in ('127.0.0.1', 'localhost', '::1') or not endpoint.port or endpoint.port == 5432:
        raise ValueError('requires disposable loopback PostgreSQL')
    for key, value in RUNTIME_POLICY.items():
        if os.environ.get(key) != value:
            raise ValueError('missing explicit policy: ' + key)
    destination = Path(plan['outputDirectory'])
    destination.mkdir(mode=0o700)
    started = time.monotonic()
    receipt = {'schemaVersion': 1, 'kind': 'retained-search-runtime-prerequisites' if preflight_only
               else 'new-retained-search-baseline-edition',
               'workItemId': plan['workItemId'], 'plan': fingerprint(plan_path), 'phases': [], 'commands': [],
               'baselineAccepted': False, 'completeRuntimeClosureVerified': False}

    def phase(name, **fields):
        row = {'phase': name, 'elapsedSec': round(time.monotonic() - started, 3), **fields}
        receipt['phases'].append(row)
        with (destination / 'phases.jsonl').open('a') as stream:
            stream.write(json.dumps(row) + '\n')
        print(json.dumps(row), flush=True)

    def sql(statement, database=admin):
        result = subprocess.run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', database],
                                input=statement, text=True, capture_output=True, timeout=14400)
        if result.returncode:
            raise RuntimeError('private SQL: ' + result.stderr.replace(database, '<private-db>')[-2000:])
        return result.stdout.strip()

    def command(label, arguments, env=None, accepted=(0,)):
        phase(label + '-start')
        log = destination / (label + '.log')
        with log.open('xb') as stream:
            result = subprocess.run(arguments, stdout=stream, stderr=subprocess.STDOUT, env=env, timeout=14400)
        receipt['commands'].append({'phase': label, 'exitCode': result.returncode, 'log': fingerprint(log)})
        phase(label + '-end', exitCode=result.returncode)
        if result.returncode not in accepted:
            raise RuntimeError(label + ' failed; see retained private log')
        return result.returncode

    try:
        phase('input-preflight')
        inputs = preflight_inputs(plan, repo)
        consumption, schema, queries = (inputs[key] for key in ['consumption', 'schema', 'queries'])
        receipt['retainedInputs'] = []
        for row in consumption['files']:
            actual = fingerprint(row['path'])
            if actual['sha256'] != row['sha256'] or actual['bytes'] != row['bytes']:
                raise ValueError('retained input differs: ' + row['path'])
            receipt['retainedInputs'].append(actual)
        # Install preserved model files before expensive restoration. Never use a
        # network download or substitute embedding function to repair a missing model.
        package = (repo / 'node_modules/@huggingface/transformers').resolve(strict=True)
        if not package.is_relative_to(repo):
            raise ValueError('model cache must be inside isolated dependency tree')
        cache = package / '.cache/onnx-community/embeddinggemma-300m-ONNX'
        assets = []
        for row in consumption['files']:
            if row['kind'] != 'model':
                continue
            target = cache / row['relativePath']
            if not target.resolve().is_relative_to(cache) or target.exists():
                raise ValueError('model destination is unsafe or already exists')
            target.parent.mkdir(parents=True, exist_ok=True)
            with open(row['path'], 'rb') as source, target.open('xb') as sink:
                shutil.copyfileobj(source, sink, 8 * 1024 * 1024)
            actual = fingerprint(target)
            if actual['sha256'] != row['sha256'] or actual['bytes'] != row['bytes']:
                raise ValueError('installed model differs')
            assets.append(actual)
        assets_path = destination / 'installed-model-assets.json'
        assets_path.write_text(json.dumps({'assets': assets}, indent=2) + '\n')
        receipt['installedModel'] = fingerprint(assets_path)
        receipt['runtimePreflight'] = runtime_preflight(plan, destination, assets_path, command, dict(os.environ))
        phase('qualified-runtime-prerequisites')
        if preflight_only:
            return 0
        data_directory = Path(sql("SELECT current_setting('data_directory')")).resolve()
        if not data_directory.name.startswith('papercusp-test-pg-'):
            raise ValueError('PostgreSQL is not maintained disposable cluster')
        target_db = 'search_baseline_' + hashlib.sha256(str(destination).encode()).hexdigest()[:16]
        sql('CREATE DATABASE ' + target_db + ' TEMPLATE template0;')
        database = urlunsplit((endpoint.scheme, endpoint.netloc, '/' + target_db, '', ''))
        env = dict(os.environ, PAPERCUSP_TEST_PG_ADMIN_URL=database,
                   HARNESS_ADMIN_DATABASE_URL=database, HARNESS_DATABASE_URL=database,
                   PAPERCUSP_WORKSPACE_ID=queries['workspaceId'])
        command('schema-preflight', ['python3', str(Path(__file__).with_name('prepare-selected-corpus.py')),
                                    '--manifest', plan['schema']['path'], '--receipt', str(destination / 'schema.json')], env)
        for number, archive in enumerate(schema['archives']):
            command('restore-data-' + str(number), ['pg_restore', '--dbname=' + database, '--data-only', '--no-owner',
                    '--no-acl', '--exit-on-error', '--schema=' + schema['schema'],
                    *['--table=' + t for t in archive['tables']], archive['path']])
        receipt['counts'] = {}
        for table, expected in plan['expectedCounts'].items():
            actual = int(sql('SELECT count(*) FROM ' + schema['schema'] + '.' + table, database))
            receipt['counts'][table] = actual
            if actual != expected:
                raise ValueError('restored table count differs: ' + table)
        receipt['emptyAuxiliaryTables'] = {}
        for table in plan.get('expectedEmptyTables', []):
            actual = int(sql('SELECT count(*) FROM ' + schema['schema'] + '.' + table, database))
            receipt['emptyAuxiliaryTables'][table] = actual
            if actual != 0:
                raise ValueError('auxiliary table unexpectedly contains data: ' + table)
        for number, index in enumerate(schema['indexes']):
            phase('index-start', number=number, index=index['indexname'])
            sql(index['indexdef'].rstrip(';') + ';', database)
            phase('index-end', number=number, index=index['indexname'])
        actual = json.loads(sql("SELECT coalesce(json_agg(row_to_json(i) ORDER BY tablename,indexname),'[]') FROM "
            "(SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='" + schema['schema'] + "') i", database))
        if actual != sorted(schema['indexes'], key=lambda i: (i['tablename'], i['indexname'])):
            raise ValueError('restored index definition population differs')
        if sql("SELECT count(*) FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='" + schema['schema'] + "' AND (NOT x.indisvalid OR NOT x.indisready)", database) != '0':
            raise ValueError('restored index readiness differs')
        receipt['indexes'] = actual
        sql('ANALYZE;', database)
        if 'adapterCapture' in plan:
            receipt['adapterCapture'] = capture_adapters(plan, repo, destination, command, env)
            for pin in receipt['retainedInputs'] + assets:
                if fingerprint(pin['path']) != pin:
                    raise ValueError('input moved during run: ' + pin['path'])
            phase('captured-contributing-adapters')
            receipt['artifacts'] = [fingerprint(p) for p in sorted(destination.iterdir()) if p.is_file()]
            return 0
        common = ['--inputs-from', plan['queries']['path'], '--pairs', str(queries['pairsPerSource']),
                  '--sources', ','.join(queries['sources']), '--seed', queries['seed']]
        command('runtime', ['node', '--import', 'tsx', 'packages/operator-core/lib/memory/bench/runtime-qualification-cli.ts',
                '--output', str(destination / 'runtime'), '--assets', str(assets_path),
                '--configuration', plan['configuration']['path'], '--benchmark', '--',
                *common, '--out', str(destination / 'runtime-benchmark.json')], env)
        runtime = json.loads((destination / 'runtime.report.json').read_bytes())
        if not runtime.get('qualifiedComponentsOnly') or not runtime.get('searchAdapterExercised'):
            raise ValueError('actual benchmark runtime did not qualify')
        code = command('timing', ['node', '--import', 'tsx', 'packages/operator-core/lib/search/bench/bm25-hybrid-recall-cli.ts',
                       *common, '--out', str(destination / 'timing-benchmark.json')], env, accepted=(0, 1))
        timing = json.loads((destination / 'timing-benchmark.json').read_bytes())
        if timing.get('sourceQualification', {}).get('verdict') != 'pass':
            raise ValueError('timing source did not qualify')
        receipt['measurement'] = {'exitCode': code, 'verdict': timing['verdict'], 'latencyVerdict': timing['latencyVerdict']}
        for pin in receipt['retainedInputs'] + assets:
            if fingerprint(pin['path']) != pin:
                raise ValueError('input moved during run: ' + pin['path'])
        phase('measured-contributing-baseline')
        receipt['artifacts'] = [fingerprint(p) for p in sorted(destination.iterdir()) if p.is_file()]
    except Exception as error:
        receipt['failure'] = {'type': type(error).__name__, 'message': str(error).replace(admin, '<private-db>')}
        phase('failed', errorType=type(error).__name__)
    finally:
        receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with (destination / 'receipt.json').open('x') as stream:
            json.dump(receipt, stream, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    return 1 if 'failure' in receipt else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--preflight-only', action='store_true', help='qualify runtime prerequisites without restoring corpus data')
    parser.add_argument('--with-test-pg', action='store_true', help='launch private PostgreSQL with measurement policies inside the isolation boundary')
    options = parser.parse_args()
    sys.exit(run_in_test_pg(options.plan, options.preflight_only) if options.with_test_pg
             else run(options.plan, options.preflight_only))
