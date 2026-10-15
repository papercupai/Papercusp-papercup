/**
 * EI-24434635346407728 — a live llm-test scenario must land in harness_shared.test_runs
 * as an `llm`-layer row that the SAME reader the acceptance-bar layer check uses accepts.
 * Without it, a BAR clause whose requiredTestLayers includes `llm` is unsatisfiable.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTestRunExecutionDetails, recordedTestLayer, stableRecordedRuntimeEnvironment } from '@papercusp/test-config/execution-details';

import { SCENARIOS } from './scenarios';
import type { LlmCallDiagnostic, LlmCallDiagnosticSummary } from '@papercusp/testing-shell/llm';
import { beginLlmScenarioLedger, llmScenarioLedgerRow, prepareLlmScenarioRuntimeReader, recordLlmScenarioTestRun, recordLlmScenarioTestRunFailure, resolveScenarioSourceFile, scenarioLedgerPath } from './test-run-ledger';
import { captureWorktreeSnapshot } from '../testing-worktree';

const ledger = vi.hoisted(() => ({ sql: vi.fn(), root: '', reportRuntime: vi.fn(), listRuntime: vi.fn(), measureRuntime: vi.fn() }));
vi.mock('../runtime-vintage', () => ({ reportRuntimeVintage: ledger.reportRuntime,
  listRuntimeVintage: ledger.listRuntime, measureRuntimeVintageEnvironment: ledger.measureRuntime }));
vi.mock('../long-lived-admin-pool', () => ({ getLongLivedAdminPool: () => ledger.sql }));
vi.mock('../agent-tools/capability/base-dir', () => ({
  resolveAgentWorkspaceRoot: (ctx: { projectDir?: string }) => ctx.projectDir ?? ledger.root,
}));
vi.mock('../testing-branch-resolve', () => ({ resolveGitContext: async () => ({ branch: 'staging' }) }));
vi.mock('../testing-worktree', () => ({
  captureWorktreeSnapshot: vi.fn(() => ({ commit: 'abc123' })), computeWorktreeDirty: () => false,
}));

const SCENARIOS_ROOT = join(__dirname, 'scenarios');

describe('recordLlmScenarioTestRun scope attribution', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    vi.mocked(captureWorktreeSnapshot).mockClear();
    dir = mkdtempSync(join(tmpdir(), 'llm-ledger-scope-'));
    file = join(dir, 'scenario.ts');
    writeFileSync(file, '');
    ledger.root = dir;
    ledger.sql.mockReset().mockResolvedValue([{ id: 123 }]);
    ledger.reportRuntime.mockReset().mockResolvedValue(undefined);
    ledger.listRuntime.mockReset().mockResolvedValue([]);
    ledger.measureRuntime.mockReset().mockReturnValue('a'.repeat(64));
    for (const key of ['PAPERCUSP_TEST_RUN_WORKSPACE', 'PAPERCUSP_WORKSPACE_ID',
      'PAPERCUSP_WORKSPACE', 'PAPERCUSP_TEST_RUN_HARNESS', 'HARNESS_SLUG', 'PAPERCUSP_HARNESS_SLUG']) {
      vi.stubEnv(key, '');
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  async function recordedScope() {
    expect(await recordLlmScenarioTestRun(report([run('passed', '2026-10-08T00:00:00Z',
      '2026-10-08T00:00:01Z')]), file, null)).toBe(123);
    const values = ledger.sql.mock.calls[0]!.slice(1);
    return { harness: values[10], workspace: values[11] };
  }
  it('records the interactive CLI workspace and harness on the actual insert', async () => {
    vi.stubEnv('PAPERCUSP_WORKSPACE', 'papercusp-workspace');
    vi.stubEnv('PAPERCUSP_HARNESS_SLUG', 'papercusp');
    expect(await recordedScope()).toEqual({ harness: 'papercusp', workspace: 'papercusp-workspace' });
  });
  it('records a thrown runner failure with its bounded transport diagnostics', async () => {
    const diagnostics: LlmCallDiagnosticSummary = {
      events: [{
        callId: 'local-call', attempt: 1, phase: 'transport-error', observedAt: '2026-10-08T00:00:00Z',
        label: 'anthropic-direct', endpointOrigin: 'http://127.0.0.1:8788', loopback: true,
        governorMode: 'shared-provider', requestedAccount: null, servedAccount: null,
        providerRequestId: null, status: null, transportFailureCode: 'ETIMEDOUT', callerAborted: false,
      }],
      total: 1,
      omitted: 0,
    };
    expect(await recordLlmScenarioTestRunFailure({
      scenarioId: 'su-S01-harness-scope',
      startedAt: new Date('2026-10-08T00:00:00Z'),
      finishedAt: new Date('2026-10-08T00:00:10Z'),
      llmCallDiagnostics: diagnostics,
    }, file, null)).toBe(123);
    const values = ledger.sql.mock.calls[0]!.slice(1);
    expect(values[1]).toBe('error');
    expect(values[5]).toContain('ETIMEDOUT');
  });
  it('preserves explicit ledger scope over an isolated runtime scope', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'caller-workspace');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'verify-tauri-isolated-90');
    vi.stubEnv('PAPERCUSP_WORKSPACE', 'interactive-workspace');
    vi.stubEnv('PAPERCUSP_TEST_RUN_HARNESS', 'caller-harness');
    vi.stubEnv('HARNESS_SLUG', 'runtime-harness');
    vi.stubEnv('PAPERCUSP_HARNESS_SLUG', 'interactive-harness');
    expect(await recordedScope()).toEqual({ harness: 'caller-harness', workspace: 'caller-workspace' });
  });
  it('keeps absent scope and a wildcard harness unattributed', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_HARNESS', '*');
    expect(await recordedScope()).toEqual({ harness: null, workspace: null });
  });
  it('records a committed-clone scenario even when the inherited workspace points elsewhere', async () => {
    ledger.root = join(dir, 'different-inherited-tree');
    const before = await beginLlmScenarioLedger(file);
    expect(before.worktree).toEqual({ commit: 'abc123' });
    expect(await recordLlmScenarioTestRun(report([run('passed', '2026-10-08T00:00:00Z',
      '2026-10-08T00:00:01Z')]), file, before)).toBe(123);
    expect(ledger.sql.mock.calls[0]![1]).toBe('scenario.ts');
    expect(vi.mocked(captureWorktreeSnapshot).mock.calls).toEqual([[dir], [dir]]);
  });
  it('records both independent SUT observations on the actual insert, with recorder-owned times', async () => {
    const read = vi.fn(async () => ({ schemaVersion: 1 as const, units: ['actual-sut'],
      fingerprint: 'a'.repeat(64), observedAt: '2000-01-01T00:00:00Z' }));
    const before = await beginLlmScenarioLedger(file, read);
    expect(read).toHaveBeenCalledTimes(1);
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    await recordLlmScenarioTestRun(report([run('passed', startedAt, finishedAt)]), file, before);
    expect(read).toHaveBeenCalledTimes(2);
    const execution = parseTestRunExecutionDetails(ledger.sql.mock.calls[0]![14]);
    expect(execution).toMatchObject({ runtimeEnvironmentBeforeCaptureStatus: 'captured',
      runtimeEnvironmentAfterCaptureStatus: 'captured', testLayer: 'llm' });
    expect(stableRecordedRuntimeEnvironment(execution?.runtimeEnvironmentBefore, execution?.runtimeEnvironmentAfter))
      .toMatchObject({ fingerprint: 'a'.repeat(64), units: ['actual-sut'] });
    expect(Date.parse(execution!.runtimeEnvironmentBefore!.observedAt)).toBeLessThanOrEqual(Date.parse(startedAt));
    expect(Date.parse(execution!.runtimeEnvironmentAfter!.observedAt)).toBeGreaterThanOrEqual(Date.parse(finishedAt));
  });
  it('preserves a runtime replacement as unstable instead of forging a matching witness', async () => {
    const read = vi.fn().mockResolvedValueOnce({ schemaVersion: 1, units: ['actual-sut'],
      fingerprint: 'a'.repeat(64), observedAt: new Date().toISOString() })
      .mockResolvedValueOnce({ schemaVersion: 1, units: ['actual-sut'],
        fingerprint: 'b'.repeat(64), observedAt: new Date().toISOString() });
    const before = await beginLlmScenarioLedger(file, read);
    await recordLlmScenarioTestRun(report([run('passed', new Date().toISOString(), new Date().toISOString())]), file, before);
    const execution = parseTestRunExecutionDetails(ledger.sql.mock.calls[0]![14]);
    expect(execution).toBeDefined();
    expect(stableRecordedRuntimeEnvironment(execution?.runtimeEnvironmentBefore, execution?.runtimeEnvironmentAfter)).toBeUndefined();
  });
  it.each([
    ['unavailable', async () => null],
    ['invalid', async () => ({ fingerprint: 'forged' })],
    ['error', async () => { throw new Error('reader failed'); }],
  ])('keeps a %s runtime observation explicit without changing the scenario result', async (status, read) => {
    const before = await beginLlmScenarioLedger(file, read as never);
    expect(await recordLlmScenarioTestRun(report([run('passed', new Date().toISOString(), new Date().toISOString())]), file, before)).toBe(123);
    const execution = parseTestRunExecutionDetails(ledger.sql.mock.calls[0]![14]);
    expect(execution).toMatchObject({ passed: 1, runtimeEnvironmentBeforeCaptureStatus: status,
      runtimeEnvironmentAfterCaptureStatus: status });
    expect(execution).not.toHaveProperty('runtimeEnvironmentBefore');
    expect(execution).not.toHaveProperty('runtimeEnvironmentAfter');
  });
  it('pins the actual in-process SUT PID and source, rather than a provider host', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'caller-workspace');
    const read = await prepareLlmScenarioRuntimeReader(file, 'in-process');
    expect(ledger.reportRuntime).toHaveBeenCalledWith(expect.objectContaining({
      pid: process.pid, treeSha: 'abc123', workspaceId: 'caller-workspace',
      unit: `llm-test-in-process-${process.pid}` }));
    expect(await read!()).toMatchObject({ fingerprint: 'a'.repeat(64),
      units: [`llm-test-in-process-${process.pid}`] });
    expect(ledger.listRuntime).toHaveBeenCalledWith('caller-workspace', undefined, [`llm-test-in-process-${process.pid}`]);
    expect(await prepareLlmScenarioRuntimeReader(file, 'http')).toBeUndefined();
    expect(ledger.reportRuntime).toHaveBeenCalledTimes(1);
  });
  it('measures the live kernel at both boundaries without awaiting the database again', async () => {
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'caller-workspace');
    ledger.listRuntime.mockResolvedValueOnce([]).mockImplementation(() => new Promise(() => {}));
    const read = await prepareLlmScenarioRuntimeReader(file, 'in-process');
    expect(read).toBeDefined();
    const before = await beginLlmScenarioLedger(file, read);
    expect(before.runtime.status).toBe('captured');
    ledger.measureRuntime.mockReturnValueOnce(null); // The original process no longer matches its kernel pin.
    expect(await read!()).toBeNull();
    expect(await read!()).toMatchObject({ fingerprint: 'a'.repeat(64) });
    expect(ledger.listRuntime).toHaveBeenCalledTimes(1);
    expect(ledger.measureRuntime).toHaveBeenCalledTimes(3);
  });
  it('bounds a stalled runtime reader and still records the completed scenario', async () => {
    vi.useFakeTimers();
    try {
      const pending = beginLlmScenarioLedger(file, () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(1_000);
      const before = await pending;
      const recording = recordLlmScenarioTestRun(report([run('passed', new Date().toISOString(),
        new Date().toISOString())]), file, before);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await recording).toBe(123);
      expect(parseTestRunExecutionDetails(ledger.sql.mock.calls[0]![14])).toMatchObject({
        runtimeEnvironmentBeforeCaptureStatus: 'timed-out', runtimeEnvironmentAfterCaptureStatus: 'timed-out' });
    } finally { vi.useRealTimers(); }
  });
  it('reports a database failure while preserving the completed scenario outcome', async () => {
    ledger.sql.mockRejectedValueOnce(new Error('ledger unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await recordLlmScenarioTestRun(report([run('passed', '2026-10-08T00:00:00Z',
        '2026-10-08T00:00:01Z')]), file, null)).toBeNull();
      expect(warning).toHaveBeenCalledWith('[llm-test] test-run ledger write failed', 'ledger unavailable');
    } finally { warning.mockRestore(); }
  });
});

describe('resolveScenarioSourceFile', () => {
  // Recurrence guard: an id that fails to resolve silently drops the live run's
  // llm-layer ledger row, which strands any BAR clause requiring `llm`
  // (su-S33-agenda-* did exactly this — ten cases, one file).
  it('resolves every registered scenario to its defining source file', () => {
    const unresolved = SCENARIOS.filter(
      (s) => !resolveScenarioSourceFile(s.id, s.target, SCENARIOS_ROOT),
    ).map((s) => `${s.target}:${s.id}`);
    expect(unresolved).toEqual([]);
  });

  it('maps a multi-scenario file by its id token and refuses ambiguity', () => {
    expect(resolveScenarioSourceFile('su-S33-agenda-delegate', 'su', SCENARIOS_ROOT)).toBe(
      join(SCENARIOS_ROOT, 'su', 'S33-goal-agenda.ts'),
    );
    expect(resolveScenarioSourceFile('su-S02-tauri-only', 'su', SCENARIOS_ROOT)).toBe(
      join(SCENARIOS_ROOT, 'su', 'S02-tauri-only.ts'),
    );
    // One factory, two registering files: each set resolves to the file spelling its ids.
    expect(resolveScenarioSourceFile('su-S37a-absence-claim', 'su-code', SCENARIOS_ROOT)).toBe(
      join(SCENARIOS_ROOT, 'su', 'S37-code-search-discipline.ts'),
    );
    expect(resolveScenarioSourceFile('worker-W01c-definition-lookup', 'worker', SCENARIOS_ROOT)).toBe(
      join(SCENARIOS_ROOT, 'worker', 'W01-code-search-discipline.ts'),
    );
    const dir = mkdtempSync(join(tmpdir(), 'scen-resolve-'));
    try {
      mkdirSync(join(dir, 'su'));
      writeFileSync(join(dir, 'su', 'S40-a.ts'), '');
      writeFileSync(join(dir, 'su', 'S40-b.ts'), '');
      writeFileSync(join(dir, 'su', 'S41-x.test.ts'), '');
      expect(resolveScenarioSourceFile('su-S40-case', 'su', dir)).toBeUndefined();
      expect(resolveScenarioSourceFile('su-S41-case', 'su', dir)).toBeUndefined();
      expect(resolveScenarioSourceFile('su-S99-none', 'nope', dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a bare role prefix claims ids only inside the target dir, never across the tree', () => {
    // A fixture builder like `su-${n}` in a helper file once captured su-S37a (target
    // su-code, no su-code dir) and misattributed its llm ledger rows.
    const dir = mkdtempSync(join(tmpdir(), 'scen-resolve-'));
    try {
      mkdirSync(join(dir, 'su'));
      mkdirSync(join(dir, 'papercup'));
      writeFileSync(join(dir, 'su', '_helpers.ts'), 'export const owner = (n: number) => `su-${n}`;\n');
      writeFileSync(join(dir, 'papercup', '_mirror.ts'), 'export const id = (b: string) => `sn-${b}`;\n');
      expect(resolveScenarioSourceFile('su-S50-new-case', 'su-code', dir)).toBeUndefined();
      // Inside its own target dir the role prefix still resolves (mirror-generated ids).
      expect(resolveScenarioSourceFile('sn-S01-mirrored', 'papercup', dir)).toBe(
        join(dir, 'papercup', '_mirror.ts'),
      );
      // A family prefix (role + token) still resolves across the tree.
      writeFileSync(join(dir, 'su', 'S50-family.ts'), 'export const id = (c: string) => `su-S50-${c}`;\n');
      expect(resolveScenarioSourceFile('su-S50-new-case', 'su-code', dir)).toBe(
        join(dir, 'su', 'S50-family.ts'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function run(
  status: 'passed' | 'failed' | 'errored',
  startIso: string,
  endIso: string,
  summary: Record<string, unknown> = {},
) {
  return { status, summary: { startedAt: new Date(startIso), finishedAt: new Date(endIso), ...summary } };
}

function report(runs: ReturnType<typeof run>[]) {
  return { scenarioId: 'su-S01-harness-scope', verdict: 'preview', runs, varianceByAxis: {}, varianceFindings: [] } as never;
}

const ctx = {
  root: '/repo',
  filePath: 'packages/operator-core/lib/llm-testing/scenarios/su/S01-harness-scope.ts',
  runGroupId: null,
  workspaceId: 'w1',
  harnessSlug: 'papercusp',
  commitSha: 'abc123',
  worktreeDirty: false,
};

describe('llmScenarioLedgerRow', () => {
  it('stamps the llm layer and is accepted by the shared execution-details parser', () => {
    const row = llmScenarioLedgerRow(
      report([run('passed', '2026-09-27T00:00:00Z', '2026-09-27T00:00:10Z'), run('passed', '2026-09-27T00:00:05Z', '2026-09-27T00:00:20Z')]),
      ctx,
    );
    expect(row.status).toBe('pass');
    expect(row.durationMs).toBe(20_000);
    expect(row.outputTail).toBeNull();
    expect(recordedTestLayer(row.executionDetails)).toBe('llm');
    const parsed = parseTestRunExecutionDetails(JSON.parse(JSON.stringify(row.executionDetails)));
    expect(parsed).toMatchObject({
      passed: 2,
      failed: 0,
      skipped: 0,
      runGroupId: null,
      filePath: ctx.filePath,
      scenarioId: 'su-S01-harness-scope',
      commitSha: 'abc123',
      worktreeDirty: false,
    });
  });

  it('a failed run fails the row; errored runs count as failures, not passes', () => {
    const row = llmScenarioLedgerRow(
      report([run('passed', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z'), run('failed', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z'), run('errored', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z')]),
      ctx,
    );
    expect(row.status).toBe('fail');
    expect(row.executionDetails).toMatchObject({ passed: 1, failed: 2 });
    expect(row.outputTail).toContain('failed=1 errored=1');
  });

  it('errored-only is an error row, and an empty report measured nothing (skip, never pass)', () => {
    expect(llmScenarioLedgerRow(report([run('errored', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z')]), ctx).status).toBe('error');
    const empty = llmScenarioLedgerRow(report([]), { ...ctx, now: new Date('2026-09-27T01:00:00Z') });
    expect(empty.status).toBe('skip');
    expect(empty.executionDetails.passed).toBe(0);
  });

  it('retains timeout stage and allowlisted transport cause in a bounded error tail', () => {
    const diagnostic: LlmCallDiagnostic = {
      callId: 'local-call', attempt: 1, phase: 'transport-error', observedAt: '2026-09-27T00:00:00Z',
      label: 'anthropic-direct', endpointOrigin: 'http://127.0.0.1:8788', loopback: true,
      governorMode: 'shared-provider', requestedAccount: null, servedAccount: null,
      providerRequestId: null, status: null, transportFailureCode: 'ETIMEDOUT', callerAborted: false,
    };
    const row = llmScenarioLedgerRow(report([run('errored', '2026-09-27T00:00:00Z', '2026-09-27T00:00:01Z', {
      timeout: { cause: 'wallclock_deadline', stage: 'sim_user_next_action', turnIndex: 0 },
      llmCallDiagnostics: { events: [diagnostic], total: 34, omitted: 2 },
    })]), ctx);
    expect(row.status).toBe('error');
    expect(row.outputTail).toContain('sim_user_next_action');
    expect(row.outputTail).toContain('ETIMEDOUT');
    expect(row.outputTail).toContain('diagnosticsOmitted=2');
    expect(row.outputTail).not.toContain('127.0.0.1');
    expect(row.outputTail!.length).toBeLessThanOrEqual(1200);
  });
});

describe('scenarioLedgerPath', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('returns a workspace-relative POSIX path only for a scenario file that exists under the root', () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-ledger-'));
    mkdirSync(join(dir, 'scen'), { recursive: true });
    const file = join(dir, 'scen', 'S01.ts');
    writeFileSync(file, 'export {}');
    expect(scenarioLedgerPath(file, dir)).toBe('scen/S01.ts');
    expect(scenarioLedgerPath(join(dir, 'scen', 'missing.ts'), dir)).toBeNull();
    expect(scenarioLedgerPath(undefined, dir)).toBeNull();
    expect(scenarioLedgerPath(file, join(dir, 'scen', 'nested'))).toBeNull();
  });
});
