import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function probe(memory: string) {
  const env = { ...process.env, NODE_OPTIONS: '--import=' + join(stage, 'cgroup-fixture.mjs'),
    NODE_PATH: '', STAGED_ROOT: stage, WORK: join(stage, 'work'), REPO_DIR: repo,
    VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: 'copy', FIXTURE_MEMORY: memory };
  return spawnSync('bash', ['-c', [
    'set -euo pipefail',
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
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('VERIFY_TAURI_COPY_MEMORY_MAX_MB=8192');
    expect(result.stdout).toContain('COPY_FIXTURE_ALLOCATED');
  });

  it.each(['max', 'unreadable'])('refuses %s limits before allocating a copy', memory => {
    const result = probe(memory);
    expect(result.status, result.stderr).toBe(2);
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
  return spawnSync('bash', ['-c', [
    'set -euo pipefail',
    'PREPARE_ONLY=0; ASSERTION_MODE=1; BOOT_ATTEMPTS=0',
    'VERIFIER_TASK_PREPARE_STARTED_SECONDS=$SECONDS',
    guard!,
    `preflight_verifier_task_deadline ${phase}`,
    'echo NATIVE_FIXTURE_ALLOCATED',
  ].join('\n')], { cwd: stage, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: '--import=' + join(stage, 'cgroup-fixture.mjs'),
      NODE_PATH: '', REPO_DIR: stage, FIXTURE_NOW: '1000',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: remainingMs === null ? '' : String(1000 + remainingMs),
      VERIFY_TAURI_TIMEOUT: '180', VERIFY_TAURI_BUILD_TIMEOUT: '300',
      VERIFY_TAURI_MAX_BOOT_ATTEMPTS: '2', VERIFY_TAURI_ASSERT_ESTIMATE_MS: '240000',
      VERIFY_TAURI_BUDGET_FROM: history ? historyPath : '', ...extra } });
}

describe('native verifier parent deadline admission', () => {
  const preparation = [{ phase: 'prepare', status: 'passed', elapsedMs: 1_745_443 }];

  it('refuses the retained 29-minute preparation forecast before any native allocation', () => {
    const result = deadlineProbe({ history: preparation });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('TASK_DEADLINE_REFUSAL');
    expect(result.stderr).toContain('knownEstimateMs=3501804');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it.each(['prepare', 'boot', 'assert'])('refuses an exhausted parent in %s', phase => {
    const result = deadlineProbe({ phase, remainingMs: 0 });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('TASK_DEADLINE_REFUSAL');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('refuses boot after preparation spent the parent clock', () => {
    const result = deadlineProbe({ phase: 'boot', remainingMs: 45_000 });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('knownEstimateMs=1320000');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('reserves every remaining boot attempt plus assertions and cleanup at the strict boundary', () => {
    expect(deadlineProbe({ phase: 'boot', remainingMs: 1_320_000 }).status).toBe(2);
    const admitted = deadlineProbe({ phase: 'boot', remainingMs: 1_320_001 });
    expect(admitted.status, admitted.stderr).toBe(0);
    expect(admitted.stdout).toContain('NATIVE_FIXTURE_ALLOCATED');
    expect(deadlineProbe({ phase: 'boot', remainingMs: 840_001,
      extra: { VERIFY_TAURI_MAX_BOOT_ATTEMPTS: '1' } }).status).toBe(0);
  });

  it('rechecks the assertion reserve without charging completed boot work again', () => {
    expect(deadlineProbe({ phase: 'assert', remainingMs: 360_000 }).status).toBe(2);
    expect(deadlineProbe({ phase: 'assert', remainingMs: 360_001 }).status).toBe(0);
  });

  it('admits a measured forecast that fits and leaves an absent parent explicitly unknown', () => {
    expect(deadlineProbe({ history: preparation, remainingMs: 3_501_805 }).status).toBe(0);
    const unconfined = deadlineProbe({ history: preparation, remainingMs: null });
    expect(unconfined.status, unconfined.stderr).toBe(0);
    expect(unconfined.stderr).toContain('deadlineEpochMs=unknown');
  });

  it.each([
    [{ phase: 'prepare', status: 'failed', elapsedMs: 123 }],
    [{ phase: 'prepare', status: 'passed', elapsedMs: -1 }],
    [{ phase: 'prepare', status: 'passed', elapsedMs: 1 }, { phase: 'prepare', status: 'passed', elapsedMs: 2 }],
  ])('rejects incomplete or ambiguous preparation observations', (...rows) => {
    const result = deadlineProbe({ history: rows });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('completed prepare phase');
    expect(result.stdout).not.toContain('NATIVE_FIXTURE_ALLOCATED');
  });

  it('keeps unknown work visible and rejects invalid configured estimates', () => {
    const unknown = deadlineProbe({ extra: { VERIFY_TAURI_ASSERT_ESTIMATE_MS: '' } });
    expect(unknown.status, unknown.stderr).toBe(0);
    expect(unknown.stderr).toContain('unknownTasks=2');
    expect(deadlineProbe({ extra: { VERIFY_TAURI_ASSERT_ESTIMATE_MS: '-1' } }).status).toBe(2);
  });

  it('guards actual preparation commands and native launches, including each retry', () => {
    const wrapper = source.match(/^verifier_run_step\(\) \{[\s\S]*?^\}/m)?.[0] ?? '';
    expect(wrapper).toContain('preflight_verifier_task_deadline prepare');
    expect(wrapper.indexOf('preflight_verifier_task_deadline')).toBeLessThan(wrapper.indexOf('vh_run_step'));
    expect(source).toContain('verifier_run_step operator-source-snapshot');
    expect(source).toContain('verifier_run_step verifier-spa-build');
    expect(source).toMatch(/while :; do\s+preflight_verifier_task_deadline boot \|\| exit \$\?/);
    expect(source).toContain('preflight_verifier_task_deadline assert || exit $?');
    expect(source.indexOf('preflight_verifier_task_deadline prepare || exit $?'))
      .toBeLessThan(source.indexOf('restricted-hold-tree-gate.mjs'));
  });
});
