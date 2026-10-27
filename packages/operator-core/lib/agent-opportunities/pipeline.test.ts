import { expect, it, vi } from 'vitest';
import { assessMonitoredRun, boundedStage, miningFailureReason, MONITORED_FAMILIES, type MonitoredRunEvidence } from './pipeline';
import { fingerprintSqlIntent } from '../bash-substitution/sql-intent-fingerprint';
it('R18-UNKNOWN', async () => {
  expect(miningFailureReason(Object.assign(new Error('SELECT secret FROM private'), { code: '23505' }))).toBe('database-23505');
  expect(miningFailureReason(new Error('SELECT secret FROM private'))).toBe('dependency-error');
  vi.useFakeTimers();
  try {
    const pending = expect(boundedStage(() => new Promise<never>(() => {}), 30)).rejects.toThrow('sql_mining_time_budget');
    await vi.advanceTimersByTimeAsync(30); await pending;
  } finally { vi.useRealTimers(); }
});
it('R20-ISOLATION', async () => {
  let recorded = false;
  const source = async () => { recorded = true; return { status: 'ok' }; };
  await expect(source()).resolves.toEqual({ status: 'ok' }); expect(recorded).toBe(true);
  // The separate background instrument is allowed to fail; it has no source callback to poison.
  await expect(boundedStage(async () => { throw new Error('mining unavailable'); }, 50)).rejects.toThrow();
  expect(recorded).toBe(true);
});
it('R25-PASSIVE', () => {
  const scope = { workspaceId: 'test', sourceBoundary: 'ledger', epoch: 'one', key: new Uint8Array(32).fill(71) };
  expect(fingerprintSqlIntent("SELECT set_config('mining_must_not_run','executed',false)", scope).status).toBe('unknown');
  expect(fingerprintSqlIntent('DROP TABLE jobs', scope).status).toBe('unknown');
});

/** Authored assessor controls, never a deployed-run or source-completeness receipt. */
function authoredRun(): MonitoredRunEvidence {
  const runtime = { sha: 'a'.repeat(40), runtime: 'release-operator:test-runtime' };
  const schedule = { id: 'routine-test', configHash: 'b'.repeat(64), active: true, paused: false,
    expression: '17 4 * * *', timezone: 'America/New_York', dueAt: '2026-10-25T08:17:00Z' };
  return { run: { ...runtime, id: 'run-test', workspaceId: 'workspace-test', harnessSlug: 'harness-test',
    routineId: schedule.id, configHash: schedule.configHash, operationId: 'scheduler-operation-test',
    trigger: 'scheduler', scheduledAt: schedule.dueAt, startedAt: '2026-10-25T08:17:05Z', finishedAt: '2026-10-25T08:18:00Z' },
  runtimeBefore: { ...runtime }, runtimeAfter: { ...runtime }, scheduleBefore: { ...schedule }, scheduleAfter: { ...schedule },
  expectedSchedule: { id: schedule.id, expression: schedule.expression, timezone: schedule.timezone },
  families: MONITORED_FAMILIES.map(family => ({ ...runtime, runId: 'run-test', family,
    enabled: true, coverage: 'measured', scanned: 12, qualifying: family === 'sql' ? 1 : 0,
    plantedCandidateIds: family === 'sql' ? ['candidate-test'] : [] })),
  reviews: [{ runId: 'run-test', family: 'sql', candidateId: 'candidate-test', workItemId: 'EI-test',
    transitionId: 'transition-test', outcome: 'accepted', owner: 'reviewer-test' }],
  testRuns: [{ ...runtime, id: 'test-run-test', runId: 'run-test', result: 'passed',
    file: 'packages/operator-core/lib/agent-opportunities/pipeline.deployed.integration.test.ts', caseName: 'R13-DEPLOYED' }] };
}

it('R13-CONTRACT', () => {
  expect(assessMonitoredRun(authoredRun())).toMatchObject({ status: 'pass',
    coverage: { population: [...MONITORED_FAMILIES], checked: [...MONITORED_FAMILIES], notChecked: [], residue: [] } });
  for (const mutate of [
    (e: MonitoredRunEvidence) => { e.families = []; },
    (e: MonitoredRunEvidence) => { e.families[4] = { ...e.families[0]! }; },
    (e: MonitoredRunEvidence) => { e.reviews = []; },
    (e: MonitoredRunEvidence) => { e.reviews[0]!.owner = null; },
    (e: MonitoredRunEvidence) => { e.reviews[0]!.outcome = 'pending'; },
    (e: MonitoredRunEvidence) => { e.reviews[0]!.runId = 'different-run'; },
    (e: MonitoredRunEvidence) => { e.families[0]!.plantedCandidateIds = []; },
    (e: MonitoredRunEvidence) => { e.families[0]!.qualifying = 0; },
    (e: MonitoredRunEvidence) => { e.testRuns[0]!.sha = 'c'.repeat(40); },
    (e: MonitoredRunEvidence) => { e.runtimeAfter.sha = 'c'.repeat(40); },
    (e: MonitoredRunEvidence) => { e.families[0]!.runId = 'old-run'; },
    (e: MonitoredRunEvidence) => { e.families[0]!.enabled = false; },
  ]) {
    const evidence = authoredRun(); mutate(evidence);
    // A forged top-level success flag never repairs absent or contradictory native records.
    expect(assessMonitoredRun(Object.assign(evidence, { shipped: true, verified: true })).status).not.toBe('pass');
  }
  for (const coverage of ['missing', 'unsupported', 'truncated', 'UNKNOWN'] as const) {
    const evidence = authoredRun(); evidence.families[2]!.coverage = coverage;
    expect(assessMonitoredRun(evidence)).toMatchObject({ status: 'UNKNOWN',
      coverage: { notChecked: ['result-recovery'], residue: [`family:result-recovery:${coverage}`] } });
  }
});

it('rejects non-scheduler, disabled, drifted and mistimed production cadence evidence', () => {
  for (const mutate of [
    (e: MonitoredRunEvidence) => { e.run.trigger = 'manual'; },
    (e: MonitoredRunEvidence) => { e.run.trigger = 'test'; },
    (e: MonitoredRunEvidence) => { e.scheduleBefore.paused = true; },
    (e: MonitoredRunEvidence) => { e.scheduleAfter.active = false; },
    (e: MonitoredRunEvidence) => { e.scheduleBefore.expression = e.scheduleAfter.expression = '* * * * *'; },
    (e: MonitoredRunEvidence) => { e.run.routineId = 'other-routine'; },
    (e: MonitoredRunEvidence) => { e.run.startedAt = '2026-10-25T08:16:59Z'; },
    (e: MonitoredRunEvidence) => { e.run.startedAt = e.run.finishedAt = '2026-10-25T08:19:01Z'; },
    (e: MonitoredRunEvidence) => { e.scheduleAfter.configHash = 'c'.repeat(64); },
    (e: MonitoredRunEvidence) => { e.run.scheduledAt = '2026-10-25T08:16:00Z'; },
  ]) {
    const evidence = authoredRun(); mutate(evidence);
    expect(assessMonitoredRun(evidence).status).toBe('fail');
  }
});
