import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(process.env.VERIFY_TAURI_SOURCE_PATH || join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
const copyFunction = source.match(/^snapshot_verifier_pinned_deps\(\) \{[\s\S]*?^\}/m)?.[0];
if (!copyFunction) throw new Error('Native dependency-copy admission not found');
let stage: string;

beforeAll(() => {
  stage = mkdtempSync(join(tmpdir(), 'tauri-copy-bootstrap-'));
  mkdirSync(join(stage, 'scripts'), { recursive: true });
  // Preserve the production source graph, but install no packages. This
  // catches an accidental scheduler/toolchain import before dependency copy.
  cpSync(join(repo, 'scripts/lib'), join(stage, 'scripts/lib'), { recursive: true });
  cpSync(join(repo, 'scripts/check-vitest-config-enrollment.mjs'), join(stage, 'scripts/check-vitest-config-enrollment.mjs'));
  writeFileSync(join(stage, 'cgroup-fixture.mjs'), [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const original = fs.readFileSync;',
    'fs.readFileSync = (path, ...args) => {',
    "  if (String(path) === '/proc/self/cgroup') return '0::/fixture.scope\\n';",
    "  if (String(path) === '/sys/fs/cgroup/fixture.scope/memory.max') {",
    "    if (process.env.FIXTURE_MEMORY === 'unreadable') throw new Error('unreadable fixture');",
    '    return process.env.FIXTURE_MEMORY;',
    '  }',
    '  return original(path, ...args);',
    '};',
    'syncBuiltinESMExports();',
    'if (process.env.FIXTURE_NOW) Date.now = () => Number(process.env.FIXTURE_NOW);',
  ].join('\n'));
});
afterAll(() => { if (stage) rmSync(stage, { recursive: true, force: true }); });

function runProbe(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, options);
  const error = result.error as NodeJS.ErrnoException | undefined;
  const diagnostics = JSON.stringify({
    command, args, status: result.status, signal: result.signal,
    elapsedMs: performance.now() - startedAt, timeoutMs: options.timeout ?? null,
    error: error ? { name: error.name, message: error.message, code: error.code,
      errno: error.errno, syscall: error.syscall } : null,
    stdout: result.stdout, stderr: result.stderr,
  });
  if (error || result.status === null) {
    throw new Error(`Subprocess probe terminated abnormally: ${diagnostics}`, { cause: error });
  }
  return { ...result, diagnostics };
}

function expectProbeStatus(result: ReturnType<typeof runProbe>, expected: number) {
  expect(result.status, result.diagnostics).toBe(expected);
}

describe('native probe subprocess diagnostics', () => {
  it.each([
    { kind: 'spawn error', command: () => join(stage, 'missing-probe'), args: [],
      code: 'ENOENT', signal: null, timeout: 10_000 },
    { kind: 'signal', command: () => 'bash',
      args: ['-c', 'printf probe-output; printf probe-error >&2; kill -TERM $$'],
      code: undefined, signal: 'SIGTERM', timeout: 10_000 },
    { kind: 'timeout', command: () => 'bash', args: ['-c', 'exec sleep 30'],
      code: 'ETIMEDOUT', signal: 'SIGTERM', timeout: 100 },
  ])('retains process evidence after a controlled $kind', ({ command, args, code, signal, timeout }) => {
    let failure: unknown;
    try {
      runProbe(command(), args, { encoding: 'utf8', timeout });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/^Subprocess probe terminated abnormally: /);
    const evidence = JSON.parse(message.slice(message.indexOf(': ') + 2));
    expect(evidence).toMatchObject({ command: command(), args, status: null, signal, timeoutMs: timeout });
    expect(evidence.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(evidence.elapsedMs)).toBe(true);
    if (code) {
      expect(evidence.error).toMatchObject({ code, message: expect.stringContaining(code) });
      expect((failure as Error).cause).toMatchObject({ code });
    } else {
      expect(evidence.error).toBeNull();
      expect(evidence.stdout).toBe('probe-output');
      expect(evidence.stderr).toBe('probe-error');
    }
  });
});

function probe(memory: string) {
  const env = { ...process.env, FIXTURE_PRELOAD: join(stage, 'cgroup-fixture.mjs'),
    NODE_PATH: '', STAGED_ROOT: stage, WORK: join(stage, 'work'), REPO_DIR: repo,
    VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: 'copy', FIXTURE_MEMORY: memory };
  return runProbe('bash', ['-c', [
    'set -euo pipefail',
    // Governed nested runners may normalize NODE_OPTIONS. Use Node's explicit
    // preload argument so these measured OS/clock fixtures cannot be dropped.
    'node() { command node --import "$FIXTURE_PRELOAD" "$@"; }',
    // Only the actual payload copy is replaced. The production Node import,
    // memory measurement, rejection and shell return path all execute.
    'bash() { echo COPY_FIXTURE_ALLOCATED; }',
    copyFunction!,
    'snapshot_verifier_pinned_deps "$STAGED_ROOT" "$STAGED_ROOT/papercusp-desktop/bin/lib/pinned-deps.sh"',
  ].join('\n')], { cwd: stage, env, encoding: 'utf8', timeout: 10_000 });
}

describe('native dependency-copy bootstrap before node_modules', () => {
  it('measures a finite task limit before admitting the copy without installed packages', () => {
    const result = probe(String(8 * 1024 * 1024 * 1024));
    expectProbeStatus(result, 0);
    expect(result.stderr).toContain('VERIFY_TAURI_COPY_MEMORY_MAX_MB=8192');
    expect(result.stdout).toContain('COPY_FIXTURE_ALLOCATED');
  });

  it.each(['max', 'unreadable'])('refuses %s limits before allocating a copy', memory => {
    const result = probe(memory);
    expectProbeStatus(result, 2);
    expect(result.stderr).toContain('VERIFY_TAURI_COPY_MEMORY_UNBOUNDED');
    expect(result.stdout).not.toContain('COPY_FIXTURE_ALLOCATED');
  });
});

function deadlineProbe({ phase = 'prepare', remainingMs = 1_800_000, history,
  extra = {} }: { phase?: string; remainingMs?: number | null; history?: unknown[];
    extra?: Record<string, string> } = {}) {
  const guard = source.match(/^preflight_verifier_task_deadline\(\) \{[\s\S]*?^\}/m)?.[0];
  expect(guard, 'native task admission must run before dependencies exist').toBeTruthy();
  const historyPath = join(stage, 'budget-history.jsonl');
  if (history) writeFileSync(historyPath, history.map(row => JSON.stringify(row)).join('\n') + '\n');
  return runProbe('bash', ['-c', [
    'set -euo pipefail',
    'node() { command node --import "$FIXTURE_PRELOAD" "$@"; }',
    'PREPARE_ONLY=0; ASSERTION_MODE=1; BOOT_ATTEMPTS=0',
    'VERIFIER_TASK_PREPARE_STARTED_SECONDS=$SECONDS',
    guard!,
    `preflight_verifier_task_deadline ${phase}`,
    'echo NATIVE_FIXTURE_ALLOCATED',
  ].join('\n')], { cwd: stage, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, FIXTURE_PRELOAD: join(stage, 'cgroup-fixture.mjs'),
      NODE_PATH: '', REPO_DIR: stage, FIXTURE_NOW: '1000',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: remainingMs === null ? '' : String(1000 + remainingMs),
      VERIFY_TAURI_TIMEOUT: '180', VERIFY_TAURI_BUILD_TIMEOUT: '300',
      VERIFY_TAURI_MAX_BOOT_ATTEMPTS: '2', VERIFY_TAURI_ASSERT_ESTIMATE_MS: '240000',
      PAPERCUSP_APP_OPERATION_LIVE_PROFILE: '',
      VERIFY_TAURI_BUDGET_FROM: history ? historyPath : '', ...extra } });
}

describe('native verifier parent deadline admission', () => {
  const preparation = [{ phase: 'prepare', status: 'passed', elapsedMs: 1_745_443 }];

  function profileBudget(estimateMs: unknown) {
    const path = join(stage, 'assertion-budget-profile.json');
    writeFileSync(path, JSON.stringify({ assertionEstimateMs: estimateMs }));
    return { PAPERCUSP_APP_OPERATION_LIVE_PROFILE: path };
  }

  it.each(['', '240000'])('refuses a 45-minute launch below its live-profile assertion budget (%j)', estimate => {
    const result = deadlineProbe({ remainingMs: 2_700_000,
      extra: { ...profileBudget(3_600_000), VERIFY_TAURI_ASSERT_ESTIMATE_MS: estimate } });
    expectProbeStatus(result, 2);
    expect(result.stderr).toContain('TASK_DEADLINE_REFUSAL');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('admits the profile plus measured preparation, retries and cleanup when the parent fits', () => {
    const result = deadlineProbe({ history: preparation, remainingMs: 7_000_000,
      extra: profileBudget(3_600_000) });
    expectProbeStatus(result, 0);
    expect(result.stderr).toContain('knownEstimateMs=6861804');
    expect(result.stdout).toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('keeps a larger caller assertion estimate instead of lowering it to the profile', () => {
    const result = deadlineProbe({ phase: 'assert', remainingMs: 4_000_000,
      extra: { ...profileBudget(3_600_000), VERIFY_TAURI_ASSERT_ESTIMATE_MS: '4000000' } });
    expectProbeStatus(result, 2);
    expect(result.stderr).toContain('knownEstimateMs=4120000');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it.each([0, -1, '3600000', 1.5])('refuses an invalid live-profile assertion estimate %j', estimate => {
    const result = deadlineProbe({ remainingMs: 7_000_000, extra: profileBudget(estimate) });
    expectProbeStatus(result, 2);
    expect(result.stderr).toContain('Invalid live-profile assertionEstimateMs');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('declares the full historical pager budget in the maintained audit profile', () => {
    const profile = JSON.parse(readFileSync(join(repo,
      'packages/operator-core/test/parked-agent-audit.live-profile.json'), 'utf8'));
    expect(profile.assertionEstimateMs).toBeGreaterThanOrEqual(3_600_000);
  });

  it('refuses the retained 29-minute preparation forecast before any native allocation', () => {
    const result = deadlineProbe({ history: preparation });
    expectProbeStatus(result, 2);
    expect(result.stderr).toContain('TASK_DEADLINE_REFUSAL');
    expect(result.stderr).toContain('knownEstimateMs=3501804');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it.each(['prepare', 'boot', 'assert'])('refuses an exhausted parent in %s', phase => {
    const result = deadlineProbe({ phase, remainingMs: 0 });
    expectProbeStatus(result, 2);
    expect(result.stderr).toContain('TASK_DEADLINE_REFUSAL');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('refuses boot after preparation spent the parent clock', () => {
    const result = deadlineProbe({ phase: 'boot', remainingMs: 45_000 });
    expectProbeStatus(result, 2);
    expect(result.stderr).toContain('knownEstimateMs=1320000');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('reserves every remaining boot attempt plus assertions and cleanup at the strict boundary', () => {
    expectProbeStatus(deadlineProbe({ phase: 'boot', remainingMs: 1_320_000 }), 2);
    const admitted = deadlineProbe({ phase: 'boot', remainingMs: 1_320_001 });
    expectProbeStatus(admitted, 0);
    expect(admitted.stdout).toContain('NATIVE_FIXTURE_ALLOCATED');
    expectProbeStatus(deadlineProbe({ phase: 'boot', remainingMs: 840_001,
      extra: { VERIFY_TAURI_MAX_BOOT_ATTEMPTS: '1' } }), 0);
  });

  it('rechecks the assertion reserve without charging completed boot work again', () => {
    expectProbeStatus(deadlineProbe({ phase: 'assert', remainingMs: 360_000 }), 2);
    expectProbeStatus(deadlineProbe({ phase: 'assert', remainingMs: 360_001 }), 0);
  });

  it('admits a measured forecast that fits and leaves an absent parent explicitly unknown', () => {
    expectProbeStatus(deadlineProbe({ history: preparation, remainingMs: 3_501_805 }), 0);
    const unconfined = deadlineProbe({ history: preparation, remainingMs: null });
    expectProbeStatus(unconfined, 0);
    expect(unconfined.stderr).toContain('deadlineEpochMs=unknown');
  });

  it.each([
    [{ phase: 'prepare', status: 'failed', elapsedMs: 123 }],
    [{ phase: 'prepare', status: 'passed', elapsedMs: -1 }],
    [{ phase: 'prepare', status: 'passed', elapsedMs: 1 }, { phase: 'prepare', status: 'passed', elapsedMs: 2 }],
  ])('rejects incomplete or ambiguous preparation observations', (...rows) => {
    const result = deadlineProbe({ history: rows });
    expectProbeStatus(result, 2);
    expect(result.stderr).toContain('completed prepare phase');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('keeps unknown work visible and rejects invalid configured estimates', () => {
    const unknown = deadlineProbe({ extra: { VERIFY_TAURI_ASSERT_ESTIMATE_MS: '' } });
    expectProbeStatus(unknown, 0);
    expect(unknown.stderr).toContain('unknownTasks=2');
    expectProbeStatus(deadlineProbe({ extra: { VERIFY_TAURI_ASSERT_ESTIMATE_MS: '-1' } }), 2);
  });

  it('guards actual preparation commands and native launches, including each retry', () => {
    const wrapper = source.match(/^verifier_run_step\(\) \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(wrapper).toContain('preflight_verifier_task_deadline prepare');
    expect(wrapper).toContain('vh_run_step "${1}-budget-admission" preflight_verifier_task_deadline prepare');
    expect(wrapper.indexOf('${1}-budget-admission')).toBeLessThan(wrapper.indexOf('vh_run_step "$@"'));
    expect(source).toContain('verifier_run_step operator-source-snapshot');
    expect(source).toContain('verifier_run_step verifier-spa-build');
    expect(source).toMatch(/while :; do\s+preflight_verifier_task_deadline boot \|\| exit \$\?/);
    expect(source).toContain('preflight_verifier_task_deadline assert || exit $?');
    expect(source.indexOf('preflight_verifier_task_deadline prepare || exit $?'))
      .toBeLessThan(source.indexOf('restricted-hold-tree-gate.mjs'));
  });
});

describe('native preparation deadline evidence', () => {
  it.each([true, false])('records admission separately from the previous successful command (refuse=%s)', refuse => {
    const evidence = mkdtempSync(join(stage, 'admission-evidence-'));
    const runPath = join(evidence, 'run-path');
    const wrapper = source.match(/^verifier_run_step\(\) \{[\s\S]*?^\}/m)?.[0];
    const hostCall = source.split('\n').find(line => line.startsWith('verifier_run_step verifier-host-bundle '));
    expect(wrapper).toBeTruthy();
    expect(hostCall).toBeTruthy();
    const result = runProbe('bash', ['-c', [
      'set -euo pipefail',
      'source "$REPO_DIR/libs/generic/verification-harness/bin/vh.sh"',
      'vh_phase prepare ""',
      'vh_init deadline-evidence "$FIXTURE_EVIDENCE"',
      'printf "%s" "$VH_RUN_DIR" > "$FIXTURE_RUN_PATH"',
      'vh_bracket_trap',
      'vh_begin prepare',
      'vh_run_step verifier-spa-build echo SPA_FINISHED',
      'preflight_verifier_task_deadline() { return "$FIXTURE_ADMISSION_EXIT"; }',
      'build_verifier_operator_host() { echo HOST_PAYLOAD_STARTED; }',
      'cleanup_operator_source_snapshot() { :; }',
      wrapper!,
      hostCall!,
    ].join('\n')], { cwd: repo, encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, REPO_DIR: repo, FIXTURE_EVIDENCE: evidence,
        FIXTURE_RUN_PATH: runPath, FIXTURE_ADMISSION_EXIT: refuse ? '2' : '0',
        VH_DISABLE: '0', VH_FAIL_OPEN: '0' } });
    expectProbeStatus(result, refuse ? 2 : 0);
    const run = readFileSync(runPath, 'utf8');
    const retained = JSON.parse(readFileSync(join(run, 'result.json'), 'utf8'));
    const commands = join(run, 'phases/prepare/commands');
    expect(JSON.parse(readFileSync(join(commands, 'verifier-spa-build.result.json'), 'utf8')))
      .toEqual({ step: 'verifier-spa-build', exitCode: 0 });
    expect(JSON.parse(readFileSync(join(commands, 'verifier-host-bundle-budget-admission.result.json'), 'utf8')))
      .toEqual({ step: 'verifier-host-bundle-budget-admission', exitCode: refuse ? 2 : 0 });
    if (refuse) {
      expect(retained.firstFailure).toEqual({ phase: 'prepare',
        step: 'verifier-host-bundle-budget-admission', reasonCode: 'exit-2' });
      expect(result.stdout).not.toContain('HOST_PAYLOAD_STARTED');
    } else {
      expect(retained.verdict).toBe('pass');
      expect(result.stdout).toContain('HOST_PAYLOAD_STARTED');
    }
  }, 30_000);
});

describe('native frozen SPA cleanup', () => {
  it.each(['early', 'teardown'] as const)('removes bulk snapshots and retains diagnostics on %s exit', phase => {
    const result = cleanupProbe(phase, false);
    expectProbeStatus(result, phase === 'early' ? 2 : 0);
    for (const directory of ['spa', 'verifier-spa']) {
      expect(existsSync(join(result.work, directory)), directory).toBe(false);
      expect(result.stdout).toContain(`GUARD ${join(result.work, directory)} run-owned`);
    }
    expect(readFileSync(join(result.work, 'tauri.log'), 'utf8')).toBe('diagnostic');
    expect(readFileSync(join(result.work, 'verifier-source-receipt.json'), 'utf8')).toBe('provenance');
  });

  it.each(['early', 'teardown'] as const)('preserves snapshots when the survivor guard refuses on %s exit', phase => {
    const result = cleanupProbe(phase, true);
    expectProbeStatus(result, phase === 'early' ? 2 : 1);
    expect(existsSync(join(result.work, 'verifier-spa/dist/index.html'))).toBe(true);
    expect(result.stderr).toContain('preserving');
  });
});

function cleanupProbe(phase: 'early' | 'teardown', blocked: boolean) {
  const work = mkdtempSync(join(stage, 'spa-cleanup-'));
  for (const directory of ['spa', 'verifier-spa/dist']) {
    mkdirSync(join(work, directory), { recursive: true });
    writeFileSync(join(work, directory, 'index.html'), 'bulk');
  }
  writeFileSync(join(work, 'tauri.log'), 'diagnostic');
  writeFileSync(join(work, 'verifier-source-receipt.json'), 'provenance');
  const helper = source.match(/^cleanup_verifier_spa_snapshot\(\) \{[\s\S]*?^\}/m)?.[0] || '';
  const earlyTrap = source.split('\n').find(line => line.trimStart().startsWith('trap ') && line.includes('vh_capture_phase_stop;'));
  const teardown = source.match(/^teardown\(\) \{[\s\S]*?^\}/m)?.[0];
  expect(earlyTrap).toBeTruthy();
  expect(teardown).toBeTruthy();
  const result = runProbe('bash', ['-c', [
    'set -uo pipefail',
    'SIGNAL_EXIT_CODE=0; BRIDGE_PID=""; ISOLATED_PG_PID=""; VERIFY_TAURI_SOURCE_REF=""',
    'TAURI_LAUNCH_PROVENANCE=run-owned',
    'for fn in vh_capture_phase_stop cleanup_verifier_source_snapshot retain_boot_attempt_evidence retain_assertion_artifacts capture_isolated_pg_diagnostics wait_owned_ports_free fed_release_port_locks display_lock_release cleanup_operator_source_snapshot release_verifier_disk_reservations cleanup_assertion_script_snapshot vh_step vh_exit; do eval "$fn() { :; }"; done',
    'log() { echo "$*" >&2; }',
    'write_stop_script() { printf "#!/bin/sh\\nexit 0\\n" > "$WORK/stop.sh"; chmod +x "$WORK/stop.sh"; }',
    'reap_frozen_source_survivors() { echo "GUARD $1 $2"; return "$FIXTURE_GUARD_EXIT"; }',
    helper,
    phase === 'early' ? earlyTrap! : `${teardown}\ntrap teardown EXIT`,
    phase === 'early' ? 'exit 2' : 'exit 0',
  ].join('\n')], { cwd: repo, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, WORK: work, FIXTURE_GUARD_EXIT: blocked ? '1' : '0' } });
  return { ...result, work };
}
