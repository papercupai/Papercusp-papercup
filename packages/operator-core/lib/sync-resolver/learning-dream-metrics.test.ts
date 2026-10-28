import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistryEntryV2, resolveNamedQueryV2 } from './index';
import { queryNamesForTriggerEvent } from './table-to-query-names';
import { DREAM_ACTION_DECISION_PREFIX } from '../dream/dream-config';
import { GYM_ADMISSION_DECISION_PREFIX } from '../gym/autoloop-tick';
import { namedQueryStageTimings, withNamedQueryDiagnosticContext } from '../agent-tools/db-diagnostic-correlation-wiring';
import { observeResolve } from './resolve-observability';

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(), controls: vi.fn(), history: vi.fn(), detail: vi.fn(), observations: vi.fn(), journal: vi.fn(), snapshot: vi.fn(), tx: {},
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'metrics-workspace' }));
vi.mock('../route-workspace', () => ({ routeWithWorkspace: (fn: (tx: unknown) => unknown) => fn(mocks.tx) }));
vi.mock('../dream/dream-metrics', () => ({ readDreamMetrics: mocks.metrics }));
vi.mock('../dream/dream-control', () => ({ readDreamControlSnapshot: mocks.controls }));
vi.mock('../dream/dream-read', () => ({ readDreamHistory: mocks.history, readDreamDetail: mocks.detail }));
vi.mock('../dream/dream-control-observations', () => ({ readDreamControlObservations: mocks.observations }));
// WI-6554700010030749: the observation view must never run journalctl. It reads
// the precomputed learning.dreamDecisionJournal snapshot instead; readJournal
// stays mocked only so a regression is caught as a call rather than a spawn.
vi.mock('../journal-read', () => ({ readJournal: mocks.journal }));
vi.mock('../derived-reads/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../derived-reads/registry')>()), readDerivedSnapshotRows: mocks.snapshot,
}));
vi.mock('../derived-reads/producers', () => ({}));

const WINDOW = { since: '2026-10-16T12:00:00Z', until: '2026-10-17T12:00:00Z' };
const IN_WINDOW = '2026-10-17T00:00:00.000Z';
const record = (unit: string, message: string, extra: Record<string, unknown> = {}) =>
  ({ ts: IN_WINDOW, unit, level: 'info', message, repeat: 1, ...extra });
const coveredRow = (unit: string, entries: Array<{ repeat: number }>, scan: Record<string, unknown> = {},
  coveredSince = '2026-10-16T00:00:00.000Z') => ({
  unit, coveredSince, coveredUntil: '2026-10-18T00:00:00.000Z',
  scan: { entries, matched: entries.reduce((n, e) => n + e.repeat, 0), collapsed: 0, truncated: false,
    window: { since: '@0', until: '@1', resolved: null }, units: [unit], journalAvailable: true, backend: 'systemd',
    journalError: null, unitsUnknown: [], windowOutsideJournal: null, command: 'journalctl', ...scan },
});

describe('learning.dream metrics use the existing scoped sync path', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    mocks.metrics.mockReset().mockResolvedValue({ schemaVersion: 'dream-metrics-v1', population: { attempts: 501 } });
    mocks.controls.mockReset().mockResolvedValue({ potSlug: 'pot', manual: { active: false } });
    mocks.history.mockReset().mockResolvedValue({ runs: [], nextCursor: null });
    mocks.detail.mockReset().mockResolvedValue(null);
    mocks.observations.mockReset().mockResolvedValue({ status: 'unknown', reason: 'wrong-or-unproven-serving-runtime' });
    mocks.journal.mockReset();
    mocks.snapshot.mockReset().mockResolvedValue([]);
  });
  it('preserves the default control read and resolves explicit metrics with the requested window', async () => {
    await expect(resolveNamedQueryV2('learning.dream', { potSlug: 'pot' })).resolves.toEqual([
      { potSlug: 'pot', manual: { active: false } },
    ]);
    expect(mocks.metrics).not.toHaveBeenCalled();
    const args = { potSlug: 'pot', view: 'metrics', since: '2026-09-07T00:00:00Z', until: '2026-09-08T00:00:00Z' };
    await expect(resolveNamedQueryV2('learning.dream', args)).resolves.toEqual([
      { schemaVersion: 'dream-metrics-v1', population: { attempts: 501 } },
    ]);
    expect(mocks.metrics).toHaveBeenCalledWith(mocks.tx, {
      workspaceId: 'metrics-workspace', potSlug: 'pot', since: args.since, until: args.until,
    });
  });
  it('does not convert a metrics read failure into an empty or zero report', async () => {
    mocks.metrics.mockRejectedValue(new Error('metrics read failed'));
    await expect(resolveNamedQueryV2('learning.dream', { potSlug: 'pot', view: 'metrics' })).rejects.toThrow(/metrics read failed/);
  });
  it('reads the automatic routine limits for the dropdown Dreaming toggle', async () => {
    const args = getRegistryEntryV2('learning.dream')!.argsSchema!.parse({ potSlug: 'pot', mode: 'auto' });
    await resolveNamedQueryV2('learning.dream', args);
    expect(mocks.controls).toHaveBeenCalledWith(mocks.tx, { workspaceId: 'metrics-workspace', potSlug: 'pot', mode: 'auto' });
    expect(() => getRegistryEntryV2('learning.dream')!.argsSchema!.parse({ potSlug: 'pot', mode: 'invalid' })).toThrow();
  });
  it('validates view/date arguments and invalidates on run, grade and experiment changes', () => {
    const schema = getRegistryEntryV2('learning.dream')!.argsSchema!;
    expect(() => schema.parse({ potSlug: 'pot', view: 'made-up' })).toThrow();
    expect(() => schema.parse({ potSlug: 'pot', view: 'metrics', since: 'bad-date' })).toThrow();
    for (const table of ['dream_runs', 'scout_routed_ideas', 'experiment_runs'])
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`)).toContain('learning.dream');
  });

  it('routes lightweight history and single-run details through the same workspace and pot scope', async () => {
    const window = { since: '2026-09-07T00:00:00Z', until: '2026-09-08T00:00:00Z' };
    await resolveNamedQueryV2('learning.dream', { potSlug: 'pot', view: 'history', ...window, cursor: 'cursor' });
    expect(mocks.history).toHaveBeenCalledWith(mocks.tx, { workspaceId: 'metrics-workspace', potSlug: 'pot', ...window }, 'cursor');
    await expect(resolveNamedQueryV2('learning.dream', { potSlug: 'pot', view: 'run', runId: 'missing' })).resolves.toEqual([]);
    expect(mocks.detail).toHaveBeenCalledWith(mocks.tx, { workspaceId: 'metrics-workspace', potSlug: 'pot', runId: 'missing' });
    expect(() => getRegistryEntryV2('learning.dream')!.argsSchema!.parse({ potSlug: 'pot', view: 'run' })).toThrow();
    mocks.detail.mockRejectedValue(new Error('failed detail read'));
    await expect(resolveNamedQueryV2('learning.dream', { potSlug: 'pot', view: 'run', runId: 'r' })).rejects.toThrow('failed detail read');
  });

  it('routes observations through the existing scoped read and requires runtime/window evidence', async () => {
    const schema = getRegistryEntryV2('learning.dream')!.argsSchema!;
    expect(() => schema.parse({ potSlug: 'pot', view: 'observations' })).toThrow();
    const args = schema.parse({ potSlug: 'pot', view: 'observations', since: '2026-10-16T12:00:00Z', until: '2026-10-17T12:00:00Z',
      expectedRuntime: { host: 'port-3170', processId: 'process', buildSha: 'build' } });
    const observationArgs = args as { potSlug: string; view: 'observations'; since: string; until: string; expectedRuntime: { host: string; processId: string; buildSha: string } };
    await resolveNamedQueryV2('learning.dream', args);
    expect(mocks.observations).toHaveBeenCalledWith(mocks.tx, { workspaceId: 'metrics-workspace', potSlug: 'pot',
      since: observationArgs.since, until: observationArgs.until, expectedRuntime: observationArgs.expectedRuntime });
    expect(mocks.controls).not.toHaveBeenCalled();
    for (const table of ['gym_autoloop_config', 'operator_gym_gates', 'scout_ticks', 'learning_spend_reservations'])
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`)).toContain('learning.dream');
  });
  it('serves the action journal from the precomputed snapshot before a workspace transaction, never running journalctl', async () => {
    const schema = getRegistryEntryV2('learning.dream')!.argsSchema!;
    const base = { potSlug: 'pot', view: 'observations', ...WINDOW,
      expectedRuntime: { host: 'port-3170', processId: 'p', buildSha: 'b' } };
    expect(() => schema.parse({ ...base, actionJournalUnit: 'bg.service' })).toThrow();
    const decision = record('bg.service', `${DREAM_ACTION_DECISION_PREFIX}record`);
    mocks.snapshot.mockResolvedValue([coveredRow('bg.service', [decision])]);
    await resolveNamedQueryV2('learning.dream', schema.parse({ ...base, actionJournalUnit: 'bg.service', expectedActionRuntime: base.expectedRuntime }));
    expect(mocks.journal).not.toHaveBeenCalled();
    expect(mocks.snapshot).toHaveBeenCalledWith('learning.dreamDecisionJournal');
    expect(mocks.snapshot.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.observations.mock.invocationCallOrder.at(-1)!);
    expect(mocks.observations).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ actionJournalUnit: 'bg.service' }), expect.objectContaining({ journal: expect.any(Function) }));
    const supplied = mocks.observations.mock.calls.at(-1)![2];
    await expect(supplied.journal({ grep: DREAM_ACTION_DECISION_PREFIX })).resolves.toMatchObject({
      entries: [decision], matched: 1, journalError: null, units: ['bg.service'],
      precomputed: { key: 'learning.dreamDecisionJournal', unit: 'bg.service' } });
  });
  it('requires exact Gym runtime and serves both sources from one snapshot read', async () => {
    const schema = getRegistryEntryV2('learning.dream')!.argsSchema!;
    const base = { potSlug: 'pot', view: 'observations', ...WINDOW,
      expectedRuntime: { host: 'read', processId: 'read-1', buildSha: 'current' } };
    expect(() => schema.parse({ ...base, gymJournalUnit: 'gym.service' })).toThrow();
    mocks.snapshot.mockResolvedValue([coveredRow('bg.service', []), coveredRow('gym.service', [])]);
    await resolveNamedQueryV2('learning.dream', schema.parse({ ...base, actionJournalUnit: 'bg.service',
      expectedActionRuntime: base.expectedRuntime, gymJournalUnit: 'gym.service', expectedGymRuntime: { ...base.expectedRuntime, processId: 'gym-1' } }));
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.journal).not.toHaveBeenCalled();
    const supplied = mocks.observations.mock.calls.at(-1)!;
    expect(supplied[1]).toMatchObject({ gymJournalUnit: 'gym.service', expectedGymRuntime: { processId: 'gym-1' } });
    expect(await supplied[2].journal({ grep: GYM_ADMISSION_DECISION_PREFIX })).toMatchObject({
      units: ['gym.service'], matched: 0, journalError: null });
  });

  it('shares one same-unit snapshot while preserving each decision source and its row cap', async () => {
    const runtime = { host: 'read', processId: 'p', buildSha: 'current' };
    const dream = Array.from({ length: 21 }, (_, n) => record('bg.service', `${DREAM_ACTION_DECISION_PREFIX}${n}`));
    const gym = record('bg.service', `${GYM_ADMISSION_DECISION_PREFIX}gym`, { repeat: 2 });
    mocks.snapshot.mockResolvedValue([coveredRow('bg.service', [...dream, gym])]);
    await resolveNamedQueryV2('learning.dream', { potSlug: 'pot', view: 'observations',
      ...WINDOW, expectedRuntime: runtime,
      actionJournalUnit: 'bg.service', expectedActionRuntime: runtime,
      gymJournalUnit: 'bg.service', expectedGymRuntime: runtime });
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.journal).not.toHaveBeenCalled();
    const supplied = mocks.observations.mock.calls[0][2];
    await expect(supplied.journal({ grep: DREAM_ACTION_DECISION_PREFIX })).resolves.toMatchObject({
      entries: dream.slice(1), matched: 21, collapsed: 0, truncated: true, journalError: null });
    await expect(supplied.journal({ grep: GYM_ADMISSION_DECISION_PREFIX })).resolves.toMatchObject({
      entries: [gym], matched: 2, collapsed: 1, truncated: false, journalError: null });
  });

  it.each(['truncated', 'clipped', 'failed'] as const)('keeps both shared sources incomplete when the precomputed scan is %s', async failure => {
    const runtime = { host: 'read', processId: 'p', buildSha: 'current' };
    const entry = record('bg.service', `${DREAM_ACTION_DECISION_PREFIX}record`, failure === 'clipped' ? { clipped: true } : {});
    // A scan that hit its row cap only covers from its oldest retained line,
    // which here starts AFTER the requested window does.
    mocks.snapshot.mockResolvedValue([coveredRow('bg.service', [entry],
      failure === 'failed' ? { journalError: 'read failed', matched: null } : { truncated: failure === 'truncated' },
      failure === 'truncated' ? '2026-10-16T18:00:00.000Z' : undefined)]);
    await resolveNamedQueryV2('learning.dream', { potSlug: 'pot', view: 'observations',
      ...WINDOW, expectedRuntime: runtime,
      actionJournalUnit: 'bg.service', expectedActionRuntime: runtime,
      gymJournalUnit: 'bg.service', expectedGymRuntime: runtime });
    const supplied = mocks.observations.mock.calls[0][2];
    for (const prefix of [DREAM_ACTION_DECISION_PREFIX, GYM_ADMISSION_DECISION_PREFIX]) {
      const value = await supplied.journal({ grep: prefix });
      expect(value.truncated || value.journalError !== null).toBe(true);
      if (failure === 'failed') expect(value.matched).toBeNull();
    }
  });

  it.each(['unscanned-unit', 'cold-snapshot'] as const)('keeps an unavailable %s source UNKNOWN without losing the other source', async failure => {
    const runtime = { host: 'read', processId: 'p', buildSha: 'current' };
    const args = { potSlug: 'pot', view: 'observations', ...WINDOW,
      expectedRuntime: runtime, actionJournalUnit: 'bg.service', expectedActionRuntime: runtime,
      gymJournalUnit: 'gym.service', expectedGymRuntime: runtime };
    const retained = record('bg.service', `${DREAM_ACTION_DECISION_PREFIX}retained-actual-dream-record`);
    // The producer scans only the background-host unit; a cold snapshot has no rows yet.
    mocks.snapshot.mockResolvedValue(failure === 'cold-snapshot' ? [] : [coveredRow('bg.service', [retained])]);
    await resolveNamedQueryV2('learning.dream', args);
    expect(mocks.journal).not.toHaveBeenCalled();
    expect(mocks.observations).toHaveBeenCalledTimes(1);
    const supplied = mocks.observations.mock.calls[0][2];
    const action = await supplied.journal({ grep: DREAM_ACTION_DECISION_PREFIX });
    if (failure === 'cold-snapshot') {
      expect(action).toMatchObject({ matched: null, entries: [], journalError: 'journal-unit-not-precomputed:bg.service' });
    } else {
      expect(action).toMatchObject({ entries: [retained], matched: 1, journalError: null });
    }
    await expect(supplied.journal({ grep: GYM_ADMISSION_DECISION_PREFIX })).resolves.toMatchObject({
      matched: null, entries: [], journalError: 'journal-unit-not-precomputed:gym.service' });
  });

  it('identifies a pending decision-journal snapshot read separately from the workspace read in the timeout diagnostic', async () => {
    let release!: (value: never[]) => void;
    mocks.snapshot.mockReset().mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const runtime = { host: 'read', processId: 'p', buildSha: 'current' };
    await withNamedQueryDiagnosticContext('learning.dream', async requestId => {
      const pending = resolveNamedQueryV2('learning.dream', { potSlug: 'pot', view: 'observations',
        since: '2026-10-16T12:00:00Z', until: '2026-10-17T12:00:00Z', expectedRuntime: runtime,
        actionJournalUnit: 'bg.service', expectedActionRuntime: runtime });
      try {
        await vi.waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
        const lines: string[] = [];
        observeResolve({ name: 'learning.dream', argsJson: '{}', elapsedMs: 10_000,
          error: { name: 'QueryResolveTimeoutError', message: 'deadline' }, now: Date.now() + 120_000,
          emit: line => lines.push(line) });
        expect(lines).toHaveLength(1);
        const diagnostic = JSON.parse(lines[0].split(' stages=')[1]);
        expect(diagnostic).toMatchObject({ requestId });
        expect(diagnostic.stages).toContainEqual({ stage: 'dream-decision-journal-snapshot', outcome: 'pending', elapsedMs: expect.any(Number) });
        expect(diagnostic.stages.some((stage: { stage: string }) => stage.stage === 'dream-workspace-transaction')).toBe(false);
      } finally {
        release([]);
        await pending;
      }
      expect(namedQueryStageTimings()?.stages).toEqual(expect.arrayContaining([
        { stage: 'dream-workspace-transaction', outcome: 'fulfilled', elapsedMs: expect.any(Number) },
        { stage: 'dream-observation-read', outcome: 'fulfilled', elapsedMs: expect.any(Number) },
      ]));
    });
  });
});
