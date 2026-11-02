/**
 * scripts/run-operator-e2e-isolated.sh — the one-command isolated operator e2e runner
 * (WI-10006736; plan operator-e2e-standing-isolated-run-2026-10-06, P-001 / R-1).
 *
 * The real rig boots a whole desktop, so these tests swap in a stub rig that does exactly
 * what verify-tauri-headless.sh does at the assertion boundary: rebind
 * HARNESS_ADMIN_DATABASE_URL to a throwaway database, then run the command after `--`.
 * The stub playwright records the env and argv it was given and exits with a chosen code.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { TAURI_VERIFIER_INPUTS } from '../../../../scripts/source-preview.mjs';
import { parseJobLogEndMarker } from '../../../../packages/operator-core/lib/task-manager/job-log-terminal';

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUNNER = join(REPO_ROOT, 'scripts/run-operator-e2e-isolated.sh');
const SHARED = 'postgresql://shared-user:pw@shared-host:5432/papercusp';
const ISOLATED = 'postgresql://iso-user:pw@127.0.0.1:59999/throwaway';
const ISOLATED_WS = 'verify-tauri-isolated-99';
const READY_SEED_SPEC_FILES = [
  'adv-conversations-sessions.spec.ts',
  'chat-streaming.spec.ts',
  'cupboard-identity-statements-native.spec.mts',
  'inbox-ack-persistence.native.spec.mts',
  'owner-question-delivery.native.spec.mts',
  'quick-access.native.spec.mts',
  'reports-work-fullscreen.native.spec.mts',
  'support-workflow-native.spec.mts',
];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!;
    const timingPath = join(dir, 'harness-timing.txt');
    if (existsSync(timingPath)) {
      const timing = readFileSync(timingPath, 'utf8');
      const rows = timing.trim().split('\n');
      if (rows.at(-1)?.startsWith('start ')) {
        console.info(`OPEN_HARNESS_PHASE dir=${dir}\n${timing}`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(playwrightExit: number, viteLogStyle: 'bare' | 'arrow' | 'color' = 'bare') {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-isolated-runner-'));
  dirs.push(dir);
  const record = join(dir, 'record.json');
  const viteCwd = join(dir, 'vite-cwd.txt');
  const rig = join(dir, 'rig.sh');
  writeFileSync(
    rig,
    [
      '#!/usr/bin/env bash',
      `[ "$VERIFY_TAURI_ISOLATED_DB" = "1" ] || { echo "rig: not isolated" >&2; exit 41; }`,
      '[ "$PAPERCUSP_FAKE_LLM" = "1" ] || { echo "rig: native host missing fake LLM" >&2; exit 43; }',
      '[ "$1" = "--" ] || { echo "rig: expected --" >&2; exit 42; }',
      'shift',
      // Keep the actual admission contract: a stub must not accept an assertion
      // command that the native rig would reject before boot.
      `node '${join(REPO_ROOT, 'scripts/lib/verify-tauri-assertion-env.mjs')}' --command "$@" || exit $?`,
      `export HARNESS_ADMIN_DATABASE_URL='${ISOLATED}'`,
      // The real rig also rebinds the workspace identity for the app under test.
      `export PAPERCUSP_WORKSPACE_ID='${ISOLATED_WS}' PAPERCUSP_WORKSPACE='${ISOLATED_WS}'`,
      'export VERIFY_TAURI_DEV_URL=http://127.0.0.1:1420',
      `export OPERATOR_SOURCE_ROOT="\${E2E_FIXTURE_SOURCE_ROOT:-${REPO_ROOT}}"`,
      'if [ -n "${E2E_FIXTURE_ASSERT_DIR:-}" ]; then export VH_PHASE_DIR="$E2E_FIXTURE_ASSERT_DIR"; fi',
      '"$@"',
      'rc=$?',
      'if [ "${E2E_FIXTURE_REMOVE_SOURCE:-0}" = "1" ]; then rm -rf -- "$OPERATOR_SOURCE_ROOT"; fi',
      'exit "$rc"',
    ].join('\n'),
  );
  const pw = join(dir, 'playwright.sh');
  const npm = join(dir, 'npm');
  // A formatted log that the runner never recognizes must fail promptly rather than
  // leave a server behind when spawnSync reaches its outer deadline.
  const viteServer = `node -e 'const http=require("node:http");const port=Number(process.env.OPERATOR_E2E_PORT);const style="${viteLogStyle}";const deadline=style==="bare"?null:setTimeout(()=>process.exit(81),5000);const s=http.createServer((_req,res)=>{clearTimeout(deadline);res.writeHead(200,{"content-type":"text/plain"});res.end("ready")});s.listen(port,"127.0.0.1",()=>{const url="http://127.0.0.1:"+s.address().port+"/";const esc=String.fromCharCode(27);console.log(style==="color"?"  "+esc+"[32m➜"+esc+"[39m  "+esc+"[1mLocal:"+esc+"[22m   "+esc+"[36m"+url+esc+"[39m":style==="arrow"?"  ➜  Local:   "+url:"  Local: "+url)})'`;
  writeFileSync(
    npm,
    [
      '#!/usr/bin/env bash',
      'set -eu',
      'pwd > "$E2E_FIXTURE_VITE_CWD"',
      'printf "%s" "${NODE_ENV:-}" > "$E2E_FIXTURE_VITE_CWD.node-env"',
      'if [ "${E2E_FIXTURE_VITE_FAIL:-0}" = "1" ]; then echo "fixture Vite bootstrap failure"; exit 74; fi',
      '[ "$1" = "run" ] && [ "$2" = "dev" ] || exit 73',
      'vite_port=',
      'expect_port=0',
      'for arg in "$@"; do',
      '  if [ "$expect_port" = "1" ]; then vite_port="$arg"; expect_port=0; continue; fi',
      '  case "$arg" in --port) expect_port=1 ;; --port=*) vite_port="${arg#--port=}" ;; esac',
      'done',
      '[ "$expect_port" = "0" ] && [ -n "$vite_port" ] || { echo "vite stub expected a port value" >&2; exit 78; }',
      'case "$vite_port" in *[!0-9]*|0) echo "vite stub expected a positive numeric port: $vite_port" >&2; exit 79;; esac',
      'if printenv PORT >/dev/null 2>&1; then echo "vite stub received a stale PORT" >&2; exit 77; fi',
      '[ "$OPERATOR_E2E_PORT" = "$vite_port" ] || { echo "vite stub CLI/env port mismatch: $vite_port / $OPERATOR_E2E_PORT" >&2; exit 80; }',
      'case " $* " in *" --host 127.0.0.1 "*) ;; *) echo "vite stub expected loopback host: $*" >&2; exit 74;; esac',
      'case " $* " in *" --strictPort "*) ;; *) echo "vite stub expected strictPort: $*" >&2; exit 76;; esac',
      // The real `npm run dev` is two npm hops deep and does not carry SIGTERM through
      // its `sh -c` child, so the server outlives a signal sent only to the launched
      // npm (WI-6554700010017702). Opt in to that shape: fork the server, record its
      // pid, and wait, so a TERM to this stub kills the stub alone.
      'if [ -n "${E2E_FIXTURE_VITE_LEAF_PID:-}" ]; then',
      `  ${viteServer} &`,
      '  echo "$!" > "$E2E_FIXTURE_VITE_LEAF_PID"',
      '  wait "$!"',
      '  exit $?',
      'fi',
      `exec ${viteServer}`,
    ].join('\n'),
  );
  writeFileSync(
    pw,
    [
      '#!/usr/bin/env bash',
      'set -e',
      'for arg in "$@"; do',
      '  if [ "$arg" = "--list" ]; then',
      '    case "${E2E_FIXTURE_SELECTION:-pass}" in',
      '      error) echo "fixture collection failed" >&2; exit 63 ;;',
      '      zero) printf \'%s\' \'{"suites":[]}\' > "$PLAYWRIGHT_JSON_OUTPUT_NAME"; exit 0 ;;',
      '      malformed) printf \'%s\' \'invalid collection JSON\' > "$PLAYWRIGHT_JSON_OUTPUT_NAME"; exit 0 ;;',
      '      stdout-prefix) echo "CHROMIUM_NETLOG /tmp/fixture-netlog.json" ;;',
      '    esac',
      '    node -e \'const fs=require("node:fs");fs.writeFileSync(process.env.E2E_FIXTURE_VITE_CWD+".selection.json",JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd()}));const file=process.env.E2E_FIXTURE_SPEC_FILE??"fixture.spec.ts";const report=JSON.stringify({suites:[{title:file,file,specs:[{title:"fixture selected",file,tests:[{projectName:"chromium"}]}]}]});if(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME)fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME,report);else process.stdout.write(report)\' -- "$@"',
      '    exit 0',
      '  fi',
      'done',
      'printf "%s" "${NODE_ENV:-}" > "$E2E_FIXTURE_VITE_CWD.playwright-node-env"',
      'artifact_dir=test-results',
      'for arg in "$@"; do case "$arg" in --output=*) artifact_dir="${arg#--output=}" ;; esac; done',
      'if [ "${E2E_FIXTURE_WRITE_ARTIFACTS:-0}" = "1" ]; then',
      '  mkdir -p "$artifact_dir/failed-spec"',
      '  for name in test-failed-1.png video.webm error-context.md trace.zip; do printf "fixture diagnostic %s\\n" "$name" > "$artifact_dir/failed-spec/$name"; done',
      'fi',
      'echo "fixture Playwright stdout"',
      'echo "fixture Playwright stderr" >&2',
      `node -e '(async()=>{const port=process.env.OPERATOR_E2E_PORT;const result={argv:process.argv.slice(2),cwd:process.cwd(),env:{ledger:process.env.PAPERCUSP_TEST_RUNS_DB_URL,admin:process.env.HARNESS_ADMIN_DATABASE_URL,group:process.env.PAPERCUSP_TEST_RUN_GROUP,port,api:process.env.PAPERCUSP_API_TARGET,disabled:process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER??null,ledgerReceipt:process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE??null,acceptanceReceipt:process.env.PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE??null,isolatedSeed:process.env.VERIFY_TAURI_ISOLATED_SEED??null,ledgerWorkspace:process.env.PAPERCUSP_TEST_RUN_WORKSPACE??null,ledgerHarness:process.env.PAPERCUSP_TEST_RUN_HARNESS??null,appWorkspace:process.env.PAPERCUSP_WORKSPACE_ID??null,reuse:process.env.OPERATOR_E2E_REUSE_SERVER??null,baseUrl:process.env.OPERATOR_E2E_BASE_URL??null},viteStatus:null};if(port)result.viteStatus=(await fetch("http://127.0.0.1:"+port+"/")).status;require("node:fs").writeFileSync(process.argv[1],JSON.stringify(result))})().catch(error=>{console.error(error);process.exitCode=1})' '${record}' "$@"`,
      `exit ${playwrightExit}`,
    ].join('\n'),
  );
  // Stands in for scripts/lib/run-in-isolated-netns.sh (covered by its own suite): records
  // the command it was asked to isolate, then runs it.
  const netns = join(dir, 'netns.sh');
  const netnsRecord = join(dir, 'netns-argv.txt');
  writeFileSync(
    netns,
    [
      '#!/usr/bin/env bash',
      '[ "$1" = "--" ] || { echo "netns stub: expected --" >&2; exit 44; }',
      'shift',
      `printf '%s\\n' "$@" > '${netnsRecord}'`,
      'exec "$@"',
    ].join('\n'),
  );
  chmodSync(rig, 0o755);
  chmodSync(npm, 0o755);
  chmodSync(pw, 0o755);
  chmodSync(netns, 0o755);
  // Delegate to the real harness CLI while retaining command boundaries even
  // when the runner is interrupted before it can emit HARNESS_RESULT.
  const harnessTiming = join(dir, 'harness-timing.txt');
  const harnessTsx = join(dir, 'harness-tsx.sh');
  writeFileSync(harnessTsx, [
    '#!/usr/bin/env bash',
    `printf 'start %s %s\\n' "$EPOCHREALTIME" "$2" >> '${harnessTiming}'`,
    `'${join(REPO_ROOT, 'node_modules/.bin/tsx')}' "$@"`,
    'rc=$?',
    `printf 'end %s %s %s\\n' "$EPOCHREALTIME" "$2" "$rc" >> '${harnessTiming}'`,
    'exit "$rc"',
  ].join('\n'));
  chmodSync(harnessTsx, 0o755);
  return { dir, rig, pw, npm, record, viteCwd, netns, netnsRecord, harnessTiming, harnessTsx };
}

function run(
  f: ReturnType<typeof fixture>,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 30_000,
) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    'PAPERCUSP_TEST_RUNS_DB_URL',
    'PAPERCUSP_TEST_RUN_GROUP',
    'PAPERCUSP_TEST_RUN_WORKSPACE',
    'PAPERCUSP_TEST_RUN_HARNESS',
    'PAPERCUSP_WORKSPACE_ID',
    'PAPERCUSP_WORKSPACE',
    'HARNESS_SLUG',
    'PAPERCUSP_HARNESS_SLUG',
    'OPERATOR_SOURCE_ROOT',
    'VH_PHASE_DIR',
    'PAPERCUSP_FAKE_LLM',
    'PAPERCUSP_DEV_BACKGROUND_WORKERS',
    'VERIFY_TAURI_ISOLATED_SEED',
    'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
    'PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE',
    'VERIFY_TAURI_SOURCE_REF',
    'VERIFY_TAURI_SOURCE_INPUTS',
    'VERIFY_TAURI_SOURCE_INPUTS_FILE',
  ]) delete base[k];
  if (env.VERIFY_TAURI_SOURCE_REF === undefined) {
    base.VERIFY_TAURI_SOURCE_REF = '';
  }
  const res = spawnSync('bash', [RUNNER, ...args], {
    env: {
      ...base,
      HARNESS_ADMIN_DATABASE_URL: SHARED,
      OPERATOR_E2E_RIG: f.rig,
      OPERATOR_E2E_PLAYWRIGHT: f.pw,
      OPERATOR_E2E_NETNS_WRAPPER: f.netns,
      E2E_FIXTURE_VITE_CWD: f.viteCwd,
      OPERATOR_E2E_HARNESS_EVIDENCE_ROOT: join(f.dir, 'evidence'),
      VH_TSX: f.harnessTsx,
      PATH: `${f.dir}:${base.PATH ?? ''}`,
      ...(!args.some(arg => /\.(?:spec|test|live)\./.test(arg)) ? {
        VERIFY_TAURI_ISOLATED_SEED: 'ready',
        PAPERCUSP_DEV_BACKGROUND_WORKERS: '1',
        PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE: join(f.dir, 'full-suite-acceptance.json'),
        PAPERCUSP_TEST_RUN_RECEIPT_FILE: join(f.dir, 'full-suite-reporter.jsonl'),
      } : {}),
      ...env,
    },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const recorded = existsSync(f.record) ? JSON.parse(readFileSync(f.record, 'utf8')) : null;
  const viteCwd = existsSync(f.viteCwd) ? readFileSync(f.viteCwd, 'utf8').trim() : null;
  const errorCode = res.error && 'code' in res.error ? res.error.code : null;
  const harnessTiming = existsSync(f.harnessTiming)
    ? readFileSync(f.harnessTiming, 'utf8') : 'harness CLI never started';
  const processResult = `RUNNER_PROCESS_RESULT ${JSON.stringify({ status: res.status, signal: res.signal, errorCode })}`;
  return {
    status: res.status, signal: res.signal, errorCode,
    out: `${res.stdout}\n${res.stderr}\n${processResult}\n${harnessTiming}`,
    recorded, viteCwd, harnessTiming,
  };
}

describe('run-operator-e2e-isolated.sh', () => {
  it.each(['zero', 'error', 'malformed'])('refuses %s test selection before starting the native rig', selection => {
    const f = fixture(0);
    const started = join(f.dir, 'rig-started');
    writeFileSync(f.rig, `#!/usr/bin/env bash\nprintf started > '${started}'\nexit 72\n`);
    const result = run(f, ['e2e/chat-streaming.spec.ts', '--grep', '^P010 title$'], { E2E_FIXTURE_SELECTION: selection });
    expect(result.status, result.out).toBe(2);
    expect(result.out).toContain('refusing native rig');
    expect(existsSync(started), result.out).toBe(false);
    expect(existsSync(f.viteCwd), result.out).toBe(false);
    expect(result.recorded).toBeNull();
  });

  it('collects the same files and grep before boot and preserves execution reporters', () => {
    const f = fixture(0);
    const args = ['e2e/chat-streaming.spec.ts', '--grep', 'P010 current-build conformance journey', '--workers=1'];
    const result = run(f, args);
    expect(result.status, result.out).toBe(0);
    const selected = JSON.parse(readFileSync(`${f.viteCwd}.selection.json`, 'utf8'));
    expect(selected.cwd).toBe(join(REPO_ROOT, 'apps/operator'));
    expect(selected.argv).toEqual([...args, '--list', '--reporter=json']);
    expect(result.out).toContain('OPERATOR_E2E_SELECTION count=1');
    expect(result.recorded.argv).toEqual(args);
  });

  it('keeps Playwright selection valid when instrumentation writes to stdout', () => {
    const f = fixture(0);
    const result = run(f, ['e2e/chat-streaming.spec.ts'], { E2E_FIXTURE_SELECTION: 'stdout-prefix' });
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain('OPERATOR_E2E_SELECTION count=1');
    expect(result.recorded).not.toBeNull();
  });

  it('treats an explicit .live.ts profile as a filtered run before native preflight', () => {
    const f = fixture(0);
    const args = ['--config', 'playwright.engineering-evidence.config.ts', 'e2e/engineering-evidence-controls.live.ts'];
    const result = run(f, args, { PAPERCUSP_ENGINEERING_CONTROLS_LIVE: '1' });
    expect(result.status, result.out).toBe(0);
    expect(result.recorded.argv).toEqual(args);
  });
  it('admits its maintained assertion through the real native preflight', () => {
    const f = fixture(0);
    const result = run(f, ['e2e/content-reading.spec.ts', '--workers=1']);
    expect(result.status, result.out).toBe(0);
    expect(result.recorded?.cwd).toBe(join(REPO_ROOT, 'apps/operator'));
    expect(result.recorded?.argv).toContain('e2e/content-reading.spec.ts');
  });

  it('refuses its file-backed assertion without the verifier-owned source', () => {
    const f = fixture(0);
    const result = spawnSync('bash', [join(REPO_ROOT, 'scripts/lib/operator-e2e-assertion.sh')], {
      env: { ...process.env, OPERATOR_SOURCE_ROOT: '', PATH: `${f.dir}:${process.env.PATH ?? ''}`,
        E2E_FIXTURE_VITE_CWD: f.viteCwd },
      encoding: 'utf8', timeout: 5_000,
    });
    expect(result.status, result.stderr).toBe(97);
    expect(result.stderr).toContain('owned OPERATOR_SOURCE_ROOT is required');
    expect(existsSync(f.viteCwd)).toBe(false);
    expect(existsSync(f.record)).toBe(false);
  });

  it.each(['retain', 'plan'])('stops before the native rig when harness %s fails', stage => {
    const f = fixture(0);
    const rigStarted = join(f.dir, 'rig-started');
    // Exercise the real shell contract without taking the shared retention mutex
    // or booting a desktop. Both failures must stop the runner at initialization.
    writeFileSync(f.harnessTsx, [
      '#!/usr/bin/env bash',
      `if [ "$2" = "${stage}" ]; then echo "fixture ${stage} failed" >&2; exit 57; fi`,
      'exit 0',
    ].join('\n'));
    writeFileSync(f.rig, [
      '#!/usr/bin/env bash',
      `printf started > '${rigStarted}'`,
      'exit 23',
    ].join('\n'));

    const result = run(f, [], { VH_FAIL_OPEN: '0' });
    expect(result.errorCode, result.out).toBeNull();
    expect(result.status, result.out).toBe(2);
    expect(result.out).toContain(`fixture ${stage} failed`);
    expect(result.out).not.toContain('OPERATOR_E2E_ISOLATED');
    expect(existsSync(rigStarted), result.out).toBe(false);
    expect(result.recorded).toBeNull();
  });

  it('retains the outer timeout diagnostic when harness startup stalls', () => {
    const f = fixture(0);
    writeFileSync(f.harnessTsx, '#!/usr/bin/env bash\nexec sleep 1\n');
    const result = run(f, [], {}, 100);
    expect(result.errorCode, result.out).toBe('ETIMEDOUT');
    expect(result.out).toContain('RUNNER_PROCESS_RESULT');
    expect(result.out).toContain('"errorCode":"ETIMEDOUT"');
    expect(result.recorded).toBeNull();
  });

  it('selects committed source and derives acceptance inputs before verifier admission', () => {
    const f = fixture(0);
    const runner = readFileSync(RUNNER, 'utf8');
    const blockStart = runner.indexOf('# The standing isolated runner verifies an immutable commit by default.');
    const blockEnd = runner.indexOf('# Refuse stale acceptance inputs before the rig allocates native build slots', blockStart);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const sourceSelection = runner.slice(blockStart, blockEnd);

    const exercise = (dir: string, sourceRef?: string, args = ['e2e/ongoing-work-ui.spec.ts']) => {
      mkdirSync(dir, { recursive: true });
      const refFile = join(dir, 'source-ref.txt');
      const inputsPathFile = join(dir, 'inputs-path.txt');
      const inlineInputsFile = join(dir, 'inline-inputs.txt');
      const script = [
        'set -uo pipefail',
        'ROOT=' + JSON.stringify(REPO_ROOT),
        'VH_RUN_DIR=' + JSON.stringify(dir),
        sourceSelection,
        'printf "%s" "$VERIFY_TAURI_SOURCE_REF" > ' + JSON.stringify(refFile),
        'printf "%s" "${VERIFY_TAURI_SOURCE_INPUTS_FILE-}" > ' + JSON.stringify(inputsPathFile),
        'printf "%s" "${VERIFY_TAURI_SOURCE_INPUTS-}" > ' + JSON.stringify(inlineInputsFile),
      ].join('\n');
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.VERIFY_TAURI_SOURCE_REF;
      delete env.VERIFY_TAURI_SOURCE_INPUTS;
      delete env.VERIFY_TAURI_SOURCE_INPUTS_FILE;
      if (sourceRef !== undefined) env.VERIFY_TAURI_SOURCE_REF = sourceRef;
      const result = spawnSync('bash', ['-c', script, 'source-selection', ...args], {
        cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 15_000,
      });
      return { result, refFile, inputsPathFile, inlineInputsFile };
    };

    const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
    expect(head.status, head.stderr).toBe(0);
    const committed = exercise(join(f.dir, 'committed'));
    expect(committed.result.status, committed.result.stderr).toBe(0);
    const sourceRef = readFileSync(committed.refFile, 'utf8');
    const inputsPath = readFileSync(committed.inputsPathFile, 'utf8');
    expect(sourceRef).toBe(head.stdout.trim());
    expect(JSON.parse(readFileSync(inputsPath, 'utf8'))).toEqual([
      'apps/operator/e2e/ongoing-work-ui.spec.ts',
      'apps/operator/playwright.config.mts',
      'apps/operator/playwright.config.ts',
    ]);

    const explicitHead = exercise(join(f.dir, 'explicit-head'), 'HEAD');
    expect(explicitHead.result.status, explicitHead.result.stderr).toBe(0);
    expect(readFileSync(explicitHead.refFile, 'utf8')).toBe(head.stdout.trim());

    const explicitLive = exercise(join(f.dir, 'explicit-live'), 'HEAD', [
      '--config', 'playwright.engineering-evidence.config.ts', 'e2e/engineering-evidence-controls.live.ts',
    ]);
    expect(explicitLive.result.status, explicitLive.result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(readFileSync(explicitLive.inputsPathFile, 'utf8'), 'utf8'))).toEqual([
      'apps/operator/e2e/engineering-evidence-controls.live.ts',
      'apps/operator/playwright.config.mts',
      'apps/operator/playwright.config.ts',
      'apps/operator/playwright.engineering-evidence.config.ts',
    ]);

    for (const [index, args] of [[], ['--workers=1'], ['--workers', '1']].entries()) {
    const fullSuite = exercise(join(f.dir, 'full-suite-' + index), undefined, args);
    expect(fullSuite.result.status, fullSuite.result.stderr).toBe(0);
    const fullSuiteInputs = JSON.parse(readFileSync(readFileSync(fullSuite.inputsPathFile, 'utf8'), 'utf8'));
    expect(readFileSync(fullSuite.inlineInputsFile, 'utf8').split(',')).toEqual(fullSuiteInputs);
    expect(fullSuiteInputs).toEqual(expect.arrayContaining([
      'apps/operator/e2e/ongoing-work-native-collection.spec.mts',
      'apps/operator/e2e/_ongoing-work-native-fixture.ts',
      'apps/operator/e2e/ticket-integrations.native.spec.mts',
      'scripts/tauri-surface-verify-ticket-integrations.sh',
      'apps/operator/app/_components/inbox/use-inbox-pending.ts',
      'apps/operator/app/admin/plans/plans-api.ts',
    ]));
    }

    const workingTree = exercise(join(f.dir, 'working-tree'), '');
    expect(workingTree.result.status, workingTree.result.stderr).toBe(0);
    expect(readFileSync(workingTree.refFile, 'utf8')).toBe('');
    expect(readFileSync(workingTree.inputsPathFile, 'utf8')).toBe('');
    expect(existsSync(join(f.dir, 'working-tree/operator-e2e-source-inputs.json'))).toBe(false);
  });

  it.each([null, 'apps/operator/bin/release/dependency-generation.sh',
    'scripts/run-operator-e2e-isolated.sh', 'scripts/lib/operator-e2e-assertion.sh',
    'scripts/lib/verify-tauri-assertion-env.mjs'])('checks mandatory native helper drift before spawning the rig (dirty: %s)', dirtyPath => {
    const f = fixture(0);
    const repo = join(f.dir, 'source');
    const acceptance = 'apps/operator/acceptance.ts';
    for (const path of [...TAURI_VERIFIER_INPUTS, acceptance]) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), `// ${path}\n`);
    }
    for (const args of [
      ['init', '-q'],
      ['add', '.'],
      ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'source inputs'],
    ]) {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
      expect(result.status, result.stderr).toBe(0);
    }
    if (dirtyPath) writeFileSync(join(repo, dirtyPath), 'peer edit');
    const inputs = join(f.dir, 'inputs.json');
    writeFileSync(inputs, JSON.stringify([acceptance]));
    // Redirect only the guard's repository to the synthetic source. The real
    // launcher, CLI and mandatory profile run unchanged; no shared bytes move.
    const node = join(f.dir, 'node');
    writeFileSync(node, [
      '#!/usr/bin/env bash',
      'args=("$@")',
      'for ((i=0; i<${#args[@]}; i++)); do',
      '  if [ "${args[i]}" = "--repo" ]; then args[i+1]="$E2E_FIXTURE_GUARD_REPO"; fi',
      // Keep the selected ref paired with the synthetic repo after redirecting --repo.
      '  if [ "${args[i]}" = "--ref" ]; then args[i+1]="HEAD"; fi',
      'done',
      'exec "$E2E_FIXTURE_NODE" "${args[@]}"',
    ].join('\n'));
    chmodSync(node, 0o755);
    const marker = join(f.dir, 'rig-started');
    writeFileSync(f.rig, `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`);
    const result = run(f, [], {
      VERIFY_TAURI_SOURCE_REF: 'HEAD', VERIFY_TAURI_SOURCE_INPUTS_FILE: inputs,
      VERIFY_TAURI_SOURCE_INPUTS: '', E2E_FIXTURE_GUARD_REPO: repo, E2E_FIXTURE_NODE: process.execPath,
      OPERATOR_E2E_HARNESS_EVIDENCE_ROOT: join(f.dir, 'evidence'),
    });
    expect(result.status, result.out).toBe(dirtyPath ? 2 : 0);
    expect(existsSync(marker)).toBe(!dirtyPath);
    if (dirtyPath) expect(result.out).toContain(`dirty tested-input mismatch: ${dirtyPath}`);
  });

  it('rejects invalid committed acceptance inputs before spawning the native rig', () => {
    const f = fixture(0);
    const marker = join(f.dir, 'rig-started');
    writeFileSync(f.rig, `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`);
    const inputs = join(f.dir, 'inputs.json');
    writeFileSync(inputs, JSON.stringify(['../outside-source']));
    const result = run(f, [], {
      VERIFY_TAURI_SOURCE_REF: 'HEAD',
      VERIFY_TAURI_SOURCE_INPUTS_FILE: inputs,
      VERIFY_TAURI_SOURCE_INPUTS: '',
      OPERATOR_E2E_HARNESS_EVIDENCE_ROOT: join(f.dir, 'evidence'),
    });
    expect(result.status).toBe(2);
    expect(result.out).toContain('invalid tested input: ../outside-source');
    expect(existsSync(marker)).toBe(false);
    expect(result.recorded).toBeNull();
  });

  it('keeps every declared ready-seed E2E spec in the selected-spec preflight registry', () => {
    const e2eDir = join(REPO_ROOT, 'apps/operator/e2e');
    const readySeedDeclaration = /VERIFY_TAURI_ISOLATED_SEED=ready|VERIFY_TAURI_(?:ISOLATED_)?SEED[^\r\n]{0,120}\.toBe\(['"]ready['"]\)/;
    const declared = readdirSync(e2eDir)
      .filter(file => /\.spec\.[cm]?[jt]sx?$/.test(file))
      .filter(file => readySeedDeclaration.test(readFileSync(join(e2eDir, file), 'utf8')))
      .sort();
    expect(declared).toEqual([...READY_SEED_SPEC_FILES].sort());
    const runner = readFileSync(RUNNER, 'utf8');
    for (const file of READY_SEED_SPEC_FILES) expect(runner).toContain(`'${file}'`);
  });

  it.each(READY_SEED_SPEC_FILES)('refuses selected ready-seed spec %s before starting the native rig', specFile => {
    const f = fixture(0);
    const marker = join(f.dir, 'rig-started');
    writeFileSync(f.rig, `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`);
    const result = run(f, [`e2e/${specFile}`], { E2E_FIXTURE_SPEC_FILE: specFile });
    expect(result.status, result.out).toBe(2);
    expect(result.out).toContain('VERIFY_TAURI_ISOLATED_SEED=ready');
    expect(existsSync(marker)).toBe(false);
  });

  it('admits a selected ready-seed spec when the isolated ready seed is configured', () => {
    const f = fixture(0);
    const result = run(f, ['e2e/chat-streaming.spec.ts'], {
      VERIFY_TAURI_ISOLATED_SEED: 'ready',
      E2E_FIXTURE_SPEC_FILE: 'chat-streaming.spec.ts',
    });
    expect(result.status, result.out).toBe(0);
    expect(result.recorded?.env.isolatedSeed).toBe('ready');
  });

  it('preflights default full-suite native prerequisites before starting the desktop', () => {
    const environments: Record<string, string>[] = [
      { VERIFY_TAURI_ISOLATED_SEED: 'fresh' },
      { PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE: '' },
      { PAPERCUSP_TEST_RUN_RECEIPT_FILE: '' },
    ];
    for (const args of [[], ['--workers=1'], ['--workers', '1']]) {
    for (const env of environments) {
      const f = fixture(0);
      const marker = join(f.dir, 'rig-started');
      writeFileSync(f.rig, `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`);
      const result = run(f, args, env);
      expect(result.status, result.out).toBe(2);
      expect(existsSync(marker)).toBe(false);
    }
    }
  });

  it('preflights native Inbox seed and receipt inputs before starting the desktop', () => {
    const cases: Array<{ label: string; seed?: string; receipt?: boolean; shared?: boolean; relative?: boolean; stale?: boolean; expected: string }> = [
      { label: 'missing ready seed', seed: 'fresh', receipt: true, expected: 'requires VERIFY_TAURI_ISOLATED_SEED=ready' },
      { label: 'missing acceptance receipt', seed: 'ready', expected: 'PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE' },
      { label: 'relative acceptance receipt', seed: 'ready', receipt: true, relative: true, expected: 'must be absolute' },
      { label: 'shared receipt path', seed: 'ready', receipt: true, shared: true, expected: 'receipts must use separate paths' },
      { label: 'stale acceptance receipt', seed: 'ready', receipt: true, stale: true, expected: 'refusing to overwrite existing acceptance receipt' },
    ];
    for (const row of cases) {
      const f = fixture(0);
      const marker = join(f.dir, 'rig-started');
      const acceptanceReceipt = join(f.dir, 'acceptance.json');
      const reporterReceipt = row.shared ? acceptanceReceipt : join(f.dir, 'reporter.jsonl');
      writeFileSync(f.rig, `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`);
      chmodSync(f.rig, 0o755);
      if (row.stale) writeFileSync(acceptanceReceipt, 'previous evidence');
      const env: Record<string, string> = { PAPERCUSP_TEST_RUN_RECEIPT_FILE: reporterReceipt };
      if (row.seed) env.VERIFY_TAURI_ISOLATED_SEED = row.seed;
      if (row.receipt) env.PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE = row.relative ? 'acceptance.json' : acceptanceReceipt;
      const result = run(f, ['e2e/inbox-ack-persistence.native.spec.mts'], env);
      expect(result.status, `${row.label}: ${result.out}`).toBe(2);
      expect(result.out).toContain(row.expected);
      expect(existsSync(marker), `${row.label} must fail before the rig starts`).toBe(false);
    }

    const f = fixture(0);
    const acceptanceReceipt = join(f.dir, 'acceptance.json');
    const reporterReceipt = join(f.dir, 'reporter.jsonl');
    const result = run(f, ['e2e/inbox-ack-persistence.native.spec.mts'], {
      VERIFY_TAURI_ISOLATED_SEED: 'ready',
      PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE: acceptanceReceipt,
      PAPERCUSP_TEST_RUN_RECEIPT_FILE: reporterReceipt,
    });
    expect(result.status, result.out).toBe(0);
    expect(result.recorded.env.isolatedSeed).toBe('ready');
    expect(result.recorded.env.acceptanceReceipt).toBe(acceptanceReceipt);
    expect(result.recorded.env.ledgerReceipt).toBe(reporterReceipt);
  });

  it('refuses native support acceptance without an isolated worker runtime before boot', () => {
    for (const args of [['e2e/support-workflow-native.spec.mts'], []]) {
      for (const env of [
        { VERIFY_TAURI_ISOLATED_SEED: 'fresh', PAPERCUSP_DEV_BACKGROUND_WORKERS: '1' },
        { VERIFY_TAURI_ISOLATED_SEED: 'ready', PAPERCUSP_DEV_BACKGROUND_WORKERS: '0' },
        { VERIFY_TAURI_ISOLATED_SEED: 'ready', PAPERCUSP_DEV_BACKGROUND_WORKERS: '' },
      ]) {
        const f = fixture(0);
        const marker = join(f.dir, 'rig-started');
        writeFileSync(f.rig, `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`);
        const result = run(f, args, env);
        expect(result.status, result.out).toBe(2);
        expect(existsSync(marker)).toBe(false);
        if (args.length) expect(result.out).toContain('isolated worker placement');
      }
    }
    const f = fixture(0);
    const result = run(f, ['e2e/support-workflow-native.spec.mts'], {
      VERIFY_TAURI_ISOLATED_SEED: 'ready', PAPERCUSP_DEV_BACKGROUND_WORKERS: '1',
    });
    expect(result.status, result.out).toBe(0);
    expect(result.recorded).not.toBeNull();
  });

  it.each([['SIGINT', 130, false], ['SIGTERM', 143, false], ['SIGHUP', 129, false], ['SIGTERM', 143, true]] as const)(
    'records failure and reaps the rig when interrupted by %s (exit: %s, whole group: %s)', async (signal, code, wholeGroup) => {
      const f = fixture(0);
      const stopped = join(f.dir, 'rig-stopped');
      writeFileSync(f.rig, [
        '#!/usr/bin/env bash',
        `trap 'touch "${stopped}"; exit 0' TERM`,
        'echo RIG_WAITING',
        // A finite stub also cleans up after the pre-fix counterexample.
        'for ((i=0; i<60; i++)); do sleep 0.05; done',
      ].join('\n'));
      const child = spawn('bash', [RUNNER], { detached: wholeGroup, env: {
        ...process.env,
        VERIFY_TAURI_ISOLATED_SEED: 'ready',
        PAPERCUSP_DEV_BACKGROUND_WORKERS: '1',
        PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE: join(f.dir, 'acceptance.json'),
        PAPERCUSP_TEST_RUN_RECEIPT_FILE: join(f.dir, 'reporter.jsonl'),
        VERIFY_TAURI_SOURCE_REF: '',
        VERIFY_TAURI_SOURCE_INPUTS: '',
        VERIFY_TAURI_SOURCE_INPUTS_FILE: '',
        HARNESS_ADMIN_DATABASE_URL: SHARED,
        OPERATOR_E2E_RIG: f.rig,
        OPERATOR_E2E_PLAYWRIGHT: f.pw,
        E2E_FIXTURE_VITE_CWD: f.viteCwd,
        OPERATOR_E2E_HARNESS_EVIDENCE_ROOT: join(f.dir, 'evidence'),
        VH_TSX: f.harnessTsx,
      } });
      let output = '';
      child.stderr.on('data', chunk => { output += chunk; });
      const closed = new Promise<number | null>((resolveClose, reject) => {
        child.once('error', reject);
        child.once('close', resolveClose);
      });
      try {
        await new Promise<void>((ready, reject) => {
          // Signal only after the stub's readiness event. The enclosing test
          // deadline bounds startup; a second five-second clock incorrectly
          // counted real evidence initialization as an interruption failure.
          const exited = () => reject(new Error(`Rig exited before readiness: ${output}`));
          child.once('close', exited);
          child.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('RIG_WAITING')) { child.off('close', exited); ready(); }
          });
        });
        if (wholeGroup) process.kill(-child.pid!, signal);
        else child.kill(signal);
        expect(await closed, `${output}\n${readFileSync(f.harnessTiming, 'utf8')}`).toBe(code);
        expect(output).toContain('verdict=fail');
        expect(output).not.toContain('verdict=pass');
        expect(existsSync(stopped), 'The runner must terminate and wait for its owned rig').toBe(true);
        const evidence = join(f.dir, 'evidence');
        const runDirs = readdirSync(evidence).filter(name => /^\d{8}T\d{6}Z-/.test(name));
        expect(runDirs).toHaveLength(1);
        const phases = readFileSync(join(evidence, runDirs[0], 'phases.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(phases.find(phase => phase.phase === 'isolated-suite')?.status).toBe('failed');
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (existsSync(f.harnessTiming)) console.info(`SIGNAL_HARNESS_TIMING signal=${signal} wholeGroup=${wholeGroup}\n${readFileSync(f.harnessTiming, 'utf8')}`);
      }
    }, 15_000,
  );

  it('never passes an unfinished suite when an unhandled signal enters the EXIT trap with zero status', () => {
    const f = fixture(0);
    writeFileSync(f.rig, '#!/usr/bin/env bash\nkill -USR1 "$PPID"\nsleep 0.1\n');
    const res = spawnSync('bash', [RUNNER], { env: {
      ...process.env,
      VERIFY_TAURI_ISOLATED_SEED: 'ready',
      PAPERCUSP_DEV_BACKGROUND_WORKERS: '1',
      PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE: join(f.dir, 'acceptance.json'),
      PAPERCUSP_TEST_RUN_RECEIPT_FILE: join(f.dir, 'reporter.jsonl'),
      VERIFY_TAURI_SOURCE_REF: '',
      VERIFY_TAURI_SOURCE_INPUTS: '',
      VERIFY_TAURI_SOURCE_INPUTS_FILE: '',
      OPERATOR_E2E_RIG: f.rig,
      OPERATOR_E2E_PLAYWRIGHT: f.pw,
      E2E_FIXTURE_VITE_CWD: f.viteCwd,
      OPERATOR_E2E_HARNESS_EVIDENCE_ROOT: join(f.dir, 'evidence'),
      VH_TSX: f.harnessTsx,
    }, encoding: 'utf8', timeout: 15_000 });
    const timing = existsSync(f.harnessTiming) ? readFileSync(f.harnessTiming, 'utf8') : 'harness CLI never started';
    console.info(`SIGNAL_HARNESS_TIMING signal=SIGUSR1\n${timing}`);
    expect(res.signal, `${res.stdout}\n${res.stderr}\n${timing}`).toBe('SIGUSR1');
    const evidence = join(f.dir, 'evidence');
    const runDirs = readdirSync(evidence).filter(name => /^\d{8}T\d{6}Z-/.test(name));
    expect(runDirs).toHaveLength(1);
    const phases = readFileSync(join(evidence, runDirs[0], 'phases.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(phases.find(phase => phase.phase === 'isolated-suite')?.status).toBe('failed');
  });

  it('emits a task-manager-compatible failed terminal marker when a spec fails', () => {
    const r = run(fixture(1), []);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('OPERATOR_E2E_ISOLATED exit=1');
    expect(parseJobLogEndMarker(r.out)).toEqual({ status: 'failed', exitCode: 1 });
    expect(r.out).toContain('HARNESS_RESULT');
    expect(r.out).toContain('verdict=fail');
  });

  it('exits 0 when the suite passes', () => {
    const r = run(fixture(0), []);
    expect(r.status, r.out).toBe(0);
    expect(parseJobLogEndMarker(r.out)).toEqual({ status: 'completed', exitCode: 0 });
    expect(r.out).toContain('HARNESS_RESULT');
    expect(r.out).toContain('verdict=pass');
  });

  it('stops the whole dev-server tree, not only the npm process it launched', async () => {
    // WI-6554700010017702: six Vite servers outlived their assertion for 7-10 days,
    // rooted in frozen sources the rig had already deleted.
    const f = fixture(0);
    const leafPidFile = join(f.dir, 'vite-leaf.pid');
    let leaf = 0;
    const alive = (pid: number) => {
      try {
        // A zombie is dead for this purpose: it holds no port and no files.
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
      } catch {
        return false;
      }
    };
    try {
      const r = run(f, [], { E2E_FIXTURE_VITE_LEAF_PID: leafPidFile });
      expect(r.status, r.out).toBe(0);
      expect(r.recorded?.viteStatus, r.out).toBe(200);
      leaf = Number(readFileSync(leafPidFile, 'utf8').trim());
      expect(leaf).toBeGreaterThan(0);
      const deadline = Date.now() + 3_000;
      while (alive(leaf) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
      expect(alive(leaf), `Vite server ${leaf} outlived its assertion`).toBe(false);
    } finally {
      if (leaf > 0 && alive(leaf)) process.kill(leaf, 'SIGKILL');
    }
  });

  it('runs Playwright (and only Playwright) inside the network-namespace wrapper', () => {
    // WI-6554700010008480: host interface churn must not reach the browser.
    const f = fixture(3);
    const r = run(f, ['some.spec.ts']);
    expect(r.status, r.out).toBe(3);
    const isolated = readFileSync(f.netnsRecord, 'utf8').trim().split('\n');
    expect(isolated[0]).toBe(f.pw);
    expect(isolated).toContain('some.spec.ts');
    // Vite is started outside the wrapper: it must stay in the host namespace.
    expect(isolated.join(' ')).not.toContain('run dev');
  });

  it('defaults the wrapper to scripts/lib/run-in-isolated-netns.sh', () => {
    const runner = readFileSync(RUNNER, 'utf8');
    expect(runner).toContain('OPERATOR_E2E_NETNS_WRAPPER="${OPERATOR_E2E_NETNS_WRAPPER:-$ROOT/scripts/lib/run-in-isolated-netns.sh}"');
    expect(existsSync(join(REPO_ROOT, 'scripts/lib/run-in-isolated-netns.sh'))).toBe(true);
  });

  it('points the ledger at the shared database while the app keeps the isolated one', () => {
    const r = run(fixture(0), []);
    expect(r.recorded, r.out).not.toBeNull();
    // Ledger rows go to the caller's shared database ...
    expect(r.recorded.env.ledger).toBe(SHARED);
    // ... while the system under test still sees the rig's throwaway database.
    expect(r.recorded.env.admin).toBe(ISOLATED);
    expect(r.recorded.cwd).toBe(join(REPO_ROOT, 'apps/operator'));
    expect(r.recorded.env.port).toMatch(/^\d+$/);
    expect(r.recorded.env.port).not.toBe('0');
    expect(r.recorded.env.reuse).toBe('1');
    expect(r.recorded.env.baseUrl).toBe(`http://127.0.0.1:${r.recorded.env.port}`);
    expect(r.recorded.viteStatus).toBe(200);
    expect(r.recorded.env.api).toBe('http://127.0.0.1:1420');
  });

  it('allocates a positive Vite port and passes it to Playwright reuse mode', () => {
    const r = run(fixture(0), [], { PORT: '39428', OPERATOR_E2E_PORT: '39428' });
    expect(r.status, r.out).toBe(0);
    expect(Number(r.recorded.env.port)).toBeGreaterThan(0);
    expect(r.recorded.env.port).not.toBe('39428');
    expect(r.out).toContain(`vite-port=${r.recorded.env.port}`);
    expect(r.recorded.env.reuse).toBe('1');
    expect(r.recorded.viteStatus).toBe(200);
  });

  it('starts the Vite dev server in development mode when the caller is production', () => {
    const f = fixture(0);
    const r = run(f, [], { NODE_ENV: 'production' });
    expect(r.status, r.out).toBe(0);
    expect(r.recorded.viteStatus).toBe(200);
    expect(readFileSync(`${f.viteCwd}.node-env`, 'utf8')).toBe('development');
    expect(readFileSync(`${f.viteCwd}.playwright-node-env`, 'utf8')).toBe('production');
  });

  it.each(['arrow', 'color'] as const)('recognizes the %s Vite readiness line and reaches Playwright', (style) => {
    const r = run(fixture(0, style), []);
    expect(r.status, r.out).toBe(0);
    expect(r.recorded, r.out).not.toBeNull();
    expect(r.recorded.viteStatus).toBe(200);
    expect(r.recorded.env.port).toMatch(/^[1-9]\d*$/);
    expect(r.out).toContain(`vite-port=${r.recorded.env.port}`);
  });

  it('runs Vite and Playwright from the verifier snapshot rather than the shared checkout', () => {
    const f = fixture(0);
    const sourceRoot = join(f.dir, 'committed snapshot');
    const operator = join(sourceRoot, 'apps/operator');
    mkdirSync(operator, { recursive: true });
    const r = run(f, ['cloud-tutorial', '--workers', '1'], { E2E_FIXTURE_SOURCE_ROOT: sourceRoot });
    expect(r.status, r.out).toBe(0);
    expect(r.viteCwd).toBe(operator);
    expect(r.recorded.cwd).toBe(operator);
    expect(r.recorded.argv).toEqual(['cloud-tutorial', '--workers', '1']);
    expect(r.recorded.viteStatus).toBe(200);
  });

  it('exports the frozen source root through the real verifier assertion boundary', () => {
    const verifier = readFileSync(join(REPO_ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const boundary = verifier.slice(verifier.lastIndexOf('\nverify_assertion_input_integrity || exit $?'));
    expect(boundary).toContain('log "running assertion command: $*"');
    const sourceRoot = join(fixture(0).dir, 'frozen source');
    const res = spawnSync('bash', ['-c', [
      'set -eu',
      'verify_assertion_input_integrity() { return 0; }',
      'preflight_verifier_task_deadline() { return 0; }',
      'verifier_begin_phase() { :; }',
      'log() { :; }',
      'ISOLATED_DB=0',
      'OPERATOR_SOURCE_ROOT="$1"',
      'shift',
      boundary,
    ].join('\n'), 'assertion-boundary', sourceRoot, process.execPath, '-e',
      'process.stdout.write(process.env.OPERATOR_SOURCE_ROOT ?? "missing")'], {
      env: { ...process.env, OPERATOR_SOURCE_ROOT: undefined },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(sourceRoot);
  });

  it('declares compact browser PNG retention at the real verifier initialization boundary', () => {
    const verifier = readFileSync(join(REPO_ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const start = verifier.indexOf('  verifier_retained_args=');
    const end = verifier.indexOf('  verifier_begin_phase prepare', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const result = spawnSync('bash', ['-c', [
      'set -eu',
      'VERIFY_TAURI_SOURCE_REF=pinned',
      'VERIFY_TAURI_EVIDENCE_ROOT=/unused/evidence',
      'vh_init() { printf "%s\\n" "$@"; }',
      verifier.slice(start, end),
    ].join('\n')], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'verify-tauri-headless', '/unused/evidence',
      '--retain-artifact', 'phases/assert/playwright/**/*.png',
      '--retain-artifact', 'phases/prepare/verifier-source-receipt.json',
    ]);
  });

  it('exports the retained assertion phase through the real verifier boundary', () => {
    const verifier = readFileSync(join(REPO_ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const boundary = verifier.slice(verifier.lastIndexOf('\nverify_assertion_input_integrity || exit $?'));
    const phaseDir = join(fixture(0).dir, 'retained assertion');
    const res = spawnSync('bash', ['-c', [
      'set -eu',
      'verify_assertion_input_integrity() { return 0; }',
      'preflight_verifier_task_deadline() { return 0; }',
      'verifier_begin_phase() { VH_PHASE_DIR="$E2E_FIXTURE_ASSERT_DIR"; }',
      'log() { :; }',
      'ISOLATED_DB=0',
      'OPERATOR_SOURCE_ROOT=/unused/frozen/source',
      boundary,
    ].join('\n'), 'assertion-boundary', process.execPath, '-e',
      'process.stdout.write(process.env.VH_PHASE_DIR ?? "missing")'], {
      env: { ...process.env, VH_PHASE_DIR: undefined, E2E_FIXTURE_ASSERT_DIR: phaseDir },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(phaseDir);
  });

  it('retains failed Playwright artifacts and both logs after frozen source teardown', () => {
    const f = fixture(1);
    const sourceRoot = join(f.dir, 'disposable source');
    const phaseDir = join(f.dir, 'retained assertion');
    mkdirSync(join(sourceRoot, 'apps/operator'), { recursive: true });
    const r = run(f, ['ongoing-work-ui', '--workers', '1'], {
      E2E_FIXTURE_SOURCE_ROOT: sourceRoot,
      E2E_FIXTURE_ASSERT_DIR: phaseDir,
      E2E_FIXTURE_REMOVE_SOURCE: '1',
      E2E_FIXTURE_WRITE_ARTIFACTS: '1',
    });
    expect(r.status, r.out).toBe(1);
    expect(existsSync(sourceRoot)).toBe(false);
    for (const name of ['test-failed-1.png', 'video.webm', 'error-context.md', 'trace.zip']) {
      expect(readFileSync(join(phaseDir, 'playwright/failed-spec', name), 'utf8')).toContain(name);
    }
    expect(readFileSync(join(phaseDir, 'vite.log'), 'utf8')).toContain('Local:');
    const output = readFileSync(join(phaseDir, 'playwright.log'), 'utf8');
    expect(output).toContain('fixture Playwright stdout');
    expect(output).toContain('fixture Playwright stderr');
    expect(r.recorded.argv).toContain('--trace=retain-on-failure');
    expect(r.recorded.argv.slice(0, 3)).toEqual(['ongoing-work-ui', '--workers', '1']);
  });

  it('retains the Vite bootstrap failure log without claiming Playwright ran', () => {
    const f = fixture(0);
    const phaseDir = join(f.dir, 'retained assertion');
    const r = run(f, [], { E2E_FIXTURE_ASSERT_DIR: phaseDir, E2E_FIXTURE_VITE_FAIL: '1' });
    expect(r.status, r.out).toBe(98);
    expect(r.recorded).toBeNull();
    expect(readFileSync(join(phaseDir, 'vite.log'), 'utf8')).toContain('fixture Vite bootstrap failure');
  });

  it('refuses a missing snapshot operator instead of falling back to shared source', () => {
    const f = fixture(0);
    const r = run(f, [], { E2E_FIXTURE_SOURCE_ROOT: join(f.dir, 'missing snapshot') });
    expect(r.status, r.out).toBe(97);
    expect(r.viteCwd).toBeNull();
    expect(r.recorded).toBeNull();
  });

  it('stamps one run group on the whole invocation and honours a caller-supplied one', () => {
    const auto = run(fixture(0), []);
    expect(auto.recorded.env.group).toMatch(/^operator-e2e-isolated-\d{8}T\d{6}Z-\d+$/);
    expect(auto.out).toContain(`group=${auto.recorded.env.group}`);
    const pinned = run(fixture(0), [], { PAPERCUSP_TEST_RUN_GROUP: 'nightly-42' });
    expect(pinned.recorded.env.group).toBe('nightly-42');
  });

  it('prefers an explicit PAPERCUSP_TEST_RUNS_DB_URL over the caller admin URL', () => {
    const r = run(fixture(0), [], { PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://ledger-only/db' });
    expect(r.recorded.env.ledger).toBe('postgresql://ledger-only/db');
  });

  it('pins the ledger workspace + harness to the caller while the app keeps the rig workspace', () => {
    // Measured 2026-10-06: without this, rows 20845991/20845992 were stamped
    // workspace_id=verify-tauri-isolated-90 and refused by workspace-scoped readers.
    const r = run(fixture(0), [], { PAPERCUSP_WORKSPACE_ID: 'caller-ws' });
    expect(r.recorded, r.out).not.toBeNull();
    expect(r.recorded.env.ledgerWorkspace).toBe('caller-ws');
    expect(r.recorded.env.appWorkspace).toBe(ISOLATED_WS);
    expect(r.recorded.env.ledgerHarness).toBe('papercusp');
  });

  it('keeps an explicit ledger workspace/harness override and falls back to PAPERCUSP_WORKSPACE', () => {
    const explicit = run(fixture(0), [], {
      PAPERCUSP_TEST_RUN_WORKSPACE: 'explicit-ws',
      PAPERCUSP_WORKSPACE_ID: 'caller-ws',
      PAPERCUSP_TEST_RUN_HARNESS: 'other-harness',
    });
    expect(explicit.recorded.env.ledgerWorkspace).toBe('explicit-ws');
    expect(explicit.recorded.env.ledgerHarness).toBe('other-harness');
    const legacy = run(fixture(0), [], { PAPERCUSP_WORKSPACE: 'legacy-ws' });
    expect(legacy.recorded.env.ledgerWorkspace).toBe('legacy-ws');
  });

  it('warns, and leaves the override unset, when the caller has no workspace', () => {
    const r = run(fixture(0), []);
    expect(r.status, r.out).toBe(0);
    expect(r.recorded.env.ledgerWorkspace).toBeNull();
    expect(r.out).toContain('WARNING no caller workspace');
  });

  it('forwards spec filters to playwright', () => {
    const r = run(fixture(0), ['card-response', '--workers', '2']);
    expect(r.recorded.argv).toEqual(['card-response', '--workers', '2']);
  });

  it('refuses --reporter (it would disable the ledger reporter) without starting the rig', () => {
    for (const arg of ['--reporter=list', '--reporter']) {
      const f = fixture(0);
      const r = run(f, [arg, 'list']);
      expect(r.status, r.out).toBe(2);
      expect(r.out).toContain('EI-25232220211651248');
      expect(r.recorded).toBeNull();
    }
  });

  it('clears a caller-level reporter opt-out so the run always records', () => {
    const r = run(fixture(0), [], { PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1' });
    expect(r.recorded.env.disabled).toBeNull();
  });
});
