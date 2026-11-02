import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const taskManager = vi.hoisted(() => ({ managedSpawn: vi.fn() }));
vi.mock('../../task-manager/managed-spawn', () => ({ managedSpawn: taskManager.managedSpawn }));
vi.mock('../operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));

import {
  OPERATOR_E2E_ISOLATED_SID,
  OPERATOR_E2E_LOGS_KEPT,
  OPERATOR_E2E_RUNTIME_MAX_SEC,
  buildOperatorE2eInvocation,
  operatorE2eRunGroup,
  pruneOperatorE2eLogs,
  runOperatorE2eIsolated,
} from './operator-e2e-isolated-action';
import { getSystemActionEntry } from './system-actions';

const ROOT = '/repo';
const RUNNER = '/repo/scripts/run-operator-e2e-isolated.sh';
const PC_HEAVY = '/repo/scripts/pc-heavy.sh';
const ctx = { installSlug: 'papercusp', workspaceId: 'papercusp-workspace' };

describe('buildOperatorE2eInvocation', () => {
  it('pins committed source and stamps the routine run group plus the caller ledger identity', () => {
    const inv = buildOperatorE2eInvocation(
      ROOT,
      { fireId: 'wf-123', workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      {
        PATH: '/bin',
        PAPERCUSP_DISABLE_TEST_RUNS_REPORTER: '1',
        PAPERCUSP_TEST_RUN_GROUP: 'stale',
        VERIFY_TAURI_SOURCE_REF: '',
      },
      () => true,
    );
    expect(inv.command).toBe('bash');
    expect(inv.args).toEqual([PC_HEAVY, '--', 'bash', RUNNER]);
    expect(inv.cwd).toBe(ROOT);
    expect(inv.runGroup).toBe('operator-e2e-nightly:wf-123');
    expect(inv.env).toMatchObject({
      PATH: '/bin',
      PAPERCUSP_TEST_RUN_GROUP: 'operator-e2e-nightly:wf-123',
      PAPERCUSP_TEST_RUN_WORKSPACE: 'ws-1',
      PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
      VERIFY_TAURI_SOURCE_REF: 'HEAD',
    });
    // A disabled reporter would make the whole run evidence-free.
    expect(inv.env).not.toHaveProperty('PAPERCUSP_DISABLE_TEST_RUNS_REPORTER');
  });

  it('falls back to running the runner directly when pc-heavy is absent', () => {
    const inv = buildOperatorE2eInvocation(
      ROOT,
      { fireId: 'x', workspaceId: 'ws', harnessSlug: 'papercusp' },
      {},
      (p) => p !== PC_HEAVY,
    );
    expect(inv.args).toEqual([RUNNER]);
  });

  it('prepares the native default-suite contract without reusing inherited receipts', () => {
    const inv = buildOperatorE2eInvocation(
      ROOT,
      { fireId: 'wf-native', workspaceId: 'ws', harnessSlug: 'papercusp', receiptBasePath: '/evidence/attempt-1.log' },
      {
        VERIFY_TAURI_ISOLATED_SEED: 'fresh', PAPERCUSP_DEV_BACKGROUND_WORKERS: '0',
        PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE: '/stale/shared.json',
        PAPERCUSP_TEST_RUN_RECEIPT_FILE: '/stale/shared.json',
      },
      () => true,
    );
    expect(inv.env).toMatchObject({
      VERIFY_TAURI_ISOLATED_SEED: 'ready', PAPERCUSP_DEV_BACKGROUND_WORKERS: '1',
      PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE: '/evidence/attempt-1.log.inbox-ack.json',
      PAPERCUSP_TEST_RUN_RECEIPT_FILE: '/evidence/attempt-1.log.test-runs.jsonl',
    });
  });

  it('never lets a CLI reporter argument reach the runner', () => {
    // The runner refuses --reporter (it would disable the ledger reporter); the action passes none.
    const inv = buildOperatorE2eInvocation(ROOT, { fireId: 'x', workspaceId: 'ws', harnessSlug: 'h' }, {}, () => true);
    expect(inv.args.some((a) => a.startsWith('--reporter'))).toBe(false);
  });

  it('formats the run group with the D-001 prefix', () => {
    expect(operatorE2eRunGroup('abc')).toBe('operator-e2e-nightly:abc');
  });

  it('attributes a routine fire with no inherited session id to the action, so the rig will launch', () => {
    // bg-host has no PAPERCUSP_SID; the first real routine fire died at launch with
    // "PAPERCUSP_SID is unset" while every probe run inherited the calling agent's id.
    const ids = { fireId: 'wf-1', workspaceId: 'ws', harnessSlug: 'papercusp' };
    for (const baseEnv of [{}, { PAPERCUSP_SID: '' }, { PAPERCUSP_SID: '   ' }]) {
      expect(buildOperatorE2eInvocation(ROOT, ids, baseEnv, () => true).env.PAPERCUSP_SID).toBe(
        OPERATOR_E2E_ISOLATED_SID,
      );
    }
    expect(OPERATOR_E2E_ISOLATED_SID).toBe('system:operator-e2e-isolated');
  });

  it('keeps the caller session id on a manual run', () => {
    const inv = buildOperatorE2eInvocation(
      ROOT,
      { fireId: 'x', workspaceId: 'ws', harnessSlug: 'papercusp' },
      { PAPERCUSP_SID: 'su-caller' },
      () => true,
    );
    expect(inv.env.PAPERCUSP_SID).toBe('su-caller');
  });
});

describe('operator e2e selection preflight', () => {
  it('holds the npm install reader lock and reports Playwright collection errors', () => {
    const runner = readFileSync(new URL('../../../../../scripts/run-operator-e2e-isolated.sh', import.meta.url), 'utf8');
    const start = runner.indexOf('# Collect with the SAME selection arguments');
    const end = runner.indexOf('if [ "$selection_status" -eq 3 ]', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const preflight = runner.slice(start, end);
    expect(preflight).toContain('node "$ROOT/scripts/npm-install-safe.mjs" --exec-under-lock --');
    expect(preflight).toContain('cd "$1" || exit 2; shift; exec $OPERATOR_E2E_PLAYWRIGHT');
    expect(preflight).toContain('-- "$ROOT/apps/operator" "$@"');
    expect(preflight).toContain('reportErrors.slice(0, 20)');
    expect(preflight).toContain('Playwright selection error: ${message}');
  });
});

describe('pruneOperatorE2eLogs', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps only the newest N log files and ignores other files', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'op-e2e-logs-'));
    for (const day of ['01', '02', '03', '04']) writeFileSync(path.join(dir, `2026-10-${day}T04-30-00-000Z-t.log`), '');
    writeFileSync(path.join(dir, 'notes.txt'), '');
    pruneOperatorE2eLogs(dir, 2);
    expect(readdirSync(dir).sort()).toEqual(['2026-10-03T04-30-00-000Z-t.log', '2026-10-04T04-30-00-000Z-t.log', 'notes.txt']);
  });

  it('does not prune manual verifier logs or let them consume routine retention slots', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'op-e2e-logs-'));
    const manual = ['p004-admitted-20261007T0830Z.log', ...Array.from({ length: 20 }, (_, i) => `voicefix-${i}.log`)];
    for (const name of manual) writeFileSync(path.join(dir, name), 'manual evidence');
    for (const day of ['01', '02', '03']) writeFileSync(path.join(dir, `2026-10-${day}T04-30-00-000Z-t.log`), '');
    // Calibration: the former all-*.log sorter selects the exact missing P-004
    // filename for deletion, even though it belongs to a different live writer.
    const legacyCandidates = readdirSync(dir).filter((name) => name.endsWith('.log')).sort();
    expect(legacyCandidates.slice(0, legacyCandidates.length - 2)).toContain(manual[0]);
    pruneOperatorE2eLogs(dir, 2);
    for (const name of manual) expect(readFileSync(path.join(dir, name), 'utf8')).toBe('manual evidence');
    expect(existsSync(path.join(dir, '2026-10-01T04-30-00-000Z-t.log'))).toBe(false);
    expect(existsSync(path.join(dir, '2026-10-02T04-30-00-000Z-t.log'))).toBe(true);
    expect(existsSync(path.join(dir, '2026-10-03T04-30-00-000Z-t.log'))).toBe(true);
  });

  it('is fail-soft on a missing directory', () => {
    expect(() => pruneOperatorE2eLogs(path.join(tmpdir(), 'does-not-exist-op-e2e'), 2)).not.toThrow();
  });
});

describe('runOperatorE2eIsolated', () => {
  let logDir = '';
  beforeEach(() => {
    taskManager.managedSpawn.mockReset();
    logDir = mkdtempSync(path.join(tmpdir(), 'op-e2e-run-'));
  });
  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  const baseOpts = () => ({
    root: ROOT,
    platform: 'linux' as NodeJS.Platform,
    exists: () => true,
    logDir,
    env: { PATH: '/bin' },
    listInFlight: async () => [],
    now: new Date('2026-10-07T04:30:00.000Z'),
  });

  it('skips off Linux, outside the operator home, without the runner, and while a run is in flight', async () => {
    await expect(runOperatorE2eIsolated(ctx, { ...baseOpts(), platform: 'darwin' })).resolves.toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/Linux-only/),
    });
    await expect(
      runOperatorE2eIsolated({ ...ctx, installSlug: 'some-hive' }, baseOpts()),
    ).resolves.toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not the operator-home harness/) });
    await expect(
      runOperatorE2eIsolated(ctx, { ...baseOpts(), exists: (p: string) => p !== RUNNER }),
    ).resolves.toMatchObject({ status: 'skipped', reason: expect.stringMatching(/run-operator-e2e-isolated\.sh not found/) });
    const listInFlight = vi.fn(async () => [{ taskId: 'live01' } as never]);
    await expect(runOperatorE2eIsolated(ctx, { ...baseOpts(), listInFlight })).resolves.toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/already in flight \(task live01\)/),
    });
    expect(listInFlight).toHaveBeenCalledWith('papercusp-workspace');
    expect(taskManager.managedSpawn).not.toHaveBeenCalled();
  });

  it('launches a bounded, enrolled test-run task keyed to the routine fire and logs to a file', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    taskManager.managedSpawn.mockResolvedValue({ taskId: 'e2etask01', child });
    const result = await runOperatorE2eIsolated(
      { ...ctx, workflowId: 'wf-777', routineId: 'rt_papercusp_operator_e2e_isolated' },
      { ...baseOpts(), taskId: 'e2etask01' },
    );
    expect(result).toMatchObject({ status: 'launched', taskId: 'e2etask01', runGroup: 'operator-e2e-nightly:wf-777' });
    expect(result.logPath).toBe(path.join(logDir, '2026-10-07T04-30-00-000Z-e2etask01.log'));
    expect(existsSync(result.logPath!)).toBe(true);

    const [command, args, spec, opts] = taskManager.managedSpawn.mock.calls[0];
    expect(command).toBe('bash');
    expect(args).toEqual([PC_HEAVY, '--', 'bash', RUNNER]);
    expect(spec).toMatchObject({
      class: 'test-run',
      launchedBy: 'system:operator-e2e-isolated',
      harnessSlug: 'papercusp',
      runtimeMaxSec: OPERATOR_E2E_RUNTIME_MAX_SEC,
      logPath: result.logPath,
      detail: { runGroup: 'operator-e2e-nightly:wf-777', workflowId: 'wf-777', routineId: 'rt_papercusp_operator_e2e_isolated' },
    });
    expect(spec.memoryMaxBytes).toBeGreaterThan(0);
    expect(opts.workspaceId).toBe('papercusp-workspace');
    expect(opts.taskId).toBe('e2etask01');
    expect(opts.spawnOptions.detached).toBe(true);
    expect(opts.spawnOptions.env.PAPERCUSP_TEST_RUN_GROUP).toBe('operator-e2e-nightly:wf-777');
    expect(opts.spawnOptions.env.PAPERCUSP_TEST_RUN_WORKSPACE).toBe('papercusp-workspace');
    expect(opts.spawnOptions.env.VERIFY_TAURI_ISOLATED_SEED).toBe('ready');
    expect(opts.spawnOptions.env.PAPERCUSP_DEV_BACKGROUND_WORKERS).toBe('1');
    expect(opts.spawnOptions.env.PAPERCUSP_NATIVE_INBOX_ACK_RECEIPT_FILE).toBe(`${result.logPath}.inbox-ack.json`);
    expect(opts.spawnOptions.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE).toBe(`${result.logPath}.test-runs.jsonl`);
    expect(opts.spawnOptions.stdio[0]).toBe('ignore');
    expect(typeof opts.spawnOptions.stdio[1]).toBe('number');
  });

  it('uses the task id as the fire id for a manual fire with no workflow id', async () => {
    taskManager.managedSpawn.mockResolvedValue({ taskId: 'manual01', child: new EventEmitter() });
    const result = await runOperatorE2eIsolated({ installSlug: '', workspaceId: 'ws' }, { ...baseOpts(), taskId: 'manual01' });
    expect(result.runGroup).toBe('operator-e2e-nightly:manual01');
    expect(taskManager.managedSpawn.mock.calls[0][2].harnessSlug).toBe('papercusp');
  });

  it('reports a spawn failure as a skip with the reason instead of throwing', async () => {
    taskManager.managedSpawn.mockRejectedValue(new Error('scope refused'));
    await expect(runOperatorE2eIsolated(ctx, baseOpts())).resolves.toMatchObject({
      status: 'skipped',
      reason: 'managed spawn failed: scope refused',
    });
  });

  it('keeps at most OPERATOR_E2E_LOGS_KEPT log files after a launch', async () => {
    taskManager.managedSpawn.mockResolvedValue({ taskId: 't', child: new EventEmitter() });
    for (let i = 0; i < OPERATOR_E2E_LOGS_KEPT + 3; i++) {
      writeFileSync(path.join(logDir, `2026-09-${String(i + 1).padStart(2, '0')}T04-30-00-000Z-old.log`), '');
    }
    await runOperatorE2eIsolated(ctx, { ...baseOpts(), taskId: 'newest' });
    const logs = readdirSync(logDir).filter((n) => n.endsWith('.log'));
    expect(logs).toHaveLength(OPERATOR_E2E_LOGS_KEPT);
    expect(logs).toContain('2026-10-07T04-30-00-000Z-newest.log');
  });
});

describe('production wiring', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..');
  const lib = path.join(repoRoot, 'packages/operator-core/lib');

  it('registers a standing, tree-executing action with a short routine step', () => {
    const entry = getSystemActionEntry('operator-e2e-isolated');
    expect(entry).toBeDefined();
    expect(entry?.scheduling).toBe('standing');
    expect(entry?.executesIntegrationTreeCode).toBe(true);
    expect(entry?.routineTimeoutMs).toBeLessThanOrEqual(60_000);
  });

  it('is imported, spend-classified, seeded nightly on the durable tier, and covered by the bespoke-seed guard', () => {
    const registry = readFileSync(path.join(lib, 'harness/routines/register-system-actions.ts'), 'utf8');
    const classification = readFileSync(path.join(lib, 'automation/routine-classification.ts'), 'utf8');
    const seed = readFileSync(path.join(lib, 'harness/routines/seed-operator-e2e-isolated-routine.ts'), 'utf8');
    const bespoke = readFileSync(path.join(lib, 'harness/routines/bespoke-active-seeds-check.ts'), 'utf8');
    expect(registry).toContain("import './operator-e2e-isolated-action'");
    expect(classification).toContain("'system:operator-e2e-isolated'");
    // The seed writes one row per SeedRow (P-003 added the red filer beside this one).
    expect(seed).toContain("targetRole: 'system:operator-e2e-isolated'");
    expect(seed).toContain("'skip', 'skip-old', ${active}, 'durable'");
    expect(seed).toMatch(/OPERATOR_E2E_ISOLATED_CRON = '0 30 4 \* \* \*'/);
    expect(bespoke).toContain("{ name: 'operator-e2e-isolated', seedScript: 'seed-operator-e2e-isolated-routine.ts' }");
  });

  it('still targets a rig that refuses an unattributed launch (why the action must supply PAPERCUSP_SID)', () => {
    // If the rig ever drops this refusal, the fallback identity above can be revisited;
    // until then a routine fire without it launches nothing.
    const rig = readFileSync(path.join(repoRoot, 'scripts/verify-tauri-headless.sh'), 'utf8');
    expect(rig).toContain('TAURI_OWNER_SID="${PAPERCUSP_SID:-}"');
    expect(rig).toContain('FATAL: PAPERCUSP_SID is unset');
  });
});
