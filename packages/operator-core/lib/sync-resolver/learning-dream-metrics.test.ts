import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistryEntryV2, resolveNamedQueryV2 } from './index';
import { queryNamesForTriggerEvent } from './table-to-query-names';
import { DREAM_ACTION_DECISION_PREFIX } from '../dream/dream-config';
import { GYM_ADMISSION_DECISION_PREFIX } from '../gym/autoloop-tick';

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(), controls: vi.fn(), history: vi.fn(), detail: vi.fn(), observations: vi.fn(), journal: vi.fn(), tx: {},
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'metrics-workspace' }));
vi.mock('../route-workspace', () => ({ routeWithWorkspace: (fn: (tx: unknown) => unknown) => fn(mocks.tx) }));
vi.mock('../dream/dream-metrics', () => ({ readDreamMetrics: mocks.metrics }));
vi.mock('../dream/dream-control', () => ({ readDreamControlSnapshot: mocks.controls }));
vi.mock('../dream/dream-read', () => ({ readDreamHistory: mocks.history, readDreamDetail: mocks.detail }));
vi.mock('../dream/dream-control-observations', () => ({ readDreamControlObservations: mocks.observations }));
vi.mock('../journal-read', () => ({ readJournal: mocks.journal }));

describe('learning.dream metrics use the existing scoped sync path', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    mocks.metrics.mockReset().mockResolvedValue({ schemaVersion: 'dream-metrics-v1', population: { attempts: 501 } });
    mocks.controls.mockReset().mockResolvedValue({ potSlug: 'pot', manual: { active: false } });
    mocks.history.mockReset().mockResolvedValue({ runs: [], nextCursor: null });
    mocks.detail.mockReset().mockResolvedValue(null);
    mocks.observations.mockReset().mockResolvedValue({ status: 'unknown', reason: 'wrong-or-unproven-serving-runtime' });
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
  it('passes explicit action identity and reads its journal before a workspace transaction', async () => {
    const schema = getRegistryEntryV2('learning.dream')!.argsSchema!;
    const base = { potSlug: 'pot', view: 'observations', since: '2026-10-16T12:00:00Z', until: '2026-10-17T12:00:00Z',
      expectedRuntime: { host: 'port-3170', processId: 'p', buildSha: 'b' } };
    expect(() => schema.parse({ ...base, actionJournalUnit: 'bg.service' })).toThrow();
    const journal = { journalAvailable: true, entries: [] };
    mocks.journal.mockResolvedValue(journal);
    await resolveNamedQueryV2('learning.dream', schema.parse({ ...base, actionJournalUnit: 'bg.service', expectedActionRuntime: base.expectedRuntime }));
    expect(mocks.journal).toHaveBeenCalledWith(expect.objectContaining({ units: ['bg.service'], since: '@1792152000', until: '@1792238400' }));
    expect(mocks.journal.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.observations.mock.invocationCallOrder.at(-1)!);
    expect(mocks.observations).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ actionJournalUnit: 'bg.service' }), expect.objectContaining({ journal: expect.any(Function) }));
  });
  it('requires exact Gym runtime and captures both journals before opening the scoped read', async () => {
    const schema = getRegistryEntryV2('learning.dream')!.argsSchema!;
    const base = { potSlug: 'pot', view: 'observations', since: '2026-10-16T12:00:00Z', until: '2026-10-17T12:00:00Z',
      expectedRuntime: { host: 'read', processId: 'read-1', buildSha: 'current' } };
    expect(() => schema.parse({ ...base, gymJournalUnit: 'gym.service' })).toThrow();
    mocks.journal.mockImplementation(async ({ units }) => ({ journalAvailable: true, entries: [], units }));
    await resolveNamedQueryV2('learning.dream', schema.parse({ ...base, actionJournalUnit: 'bg.service',
      expectedActionRuntime: base.expectedRuntime, gymJournalUnit: 'gym.service', expectedGymRuntime: { ...base.expectedRuntime, processId: 'gym-1' } }));
    expect(mocks.journal).toHaveBeenCalledWith(expect.objectContaining({ units: ['gym.service'], grep: 'GYM_ADMISSION_DECISION ' }));
    expect(mocks.journal.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.observations.mock.invocationCallOrder.at(-1)!);
    const supplied = mocks.observations.mock.calls.at(-1)!;
    expect(supplied[1]).toMatchObject({ gymJournalUnit: 'gym.service', expectedGymRuntime: { processId: 'gym-1' } });
    expect(await supplied[2].journal({ grep: 'GYM_ADMISSION_DECISION ' })).toMatchObject({ units: ['gym.service'] });
  });

  it.each(['pending', 'rejected'] as const)('preserves an unavailable %s journal without losing the other source or timing out the query', async failure => {
    vi.useFakeTimers();
    const began = Date.now();
    const runtime = { host: 'read', processId: 'p', buildSha: 'current' };
    const args = { potSlug: 'pot', view: 'observations', since: '2026-10-16T12:00:00Z', until: '2026-10-17T12:00:00Z',
      expectedRuntime: runtime, actionJournalUnit: 'bg.service', expectedActionRuntime: runtime,
      gymJournalUnit: 'bg.service', expectedGymRuntime: runtime };
    const retained = { journalAvailable: true, entries: [{ message: 'retained-actual-dream-record' }] };
    mocks.journal.mockReset().mockImplementation(({ grep }) => grep === DREAM_ACTION_DECISION_PREFIX
      ? Promise.resolve(retained)
      : failure === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('gym journal unavailable')));
    const pending = resolveNamedQueryV2('learning.dream', args);
    await vi.waitFor(() => expect(mocks.journal).toHaveBeenCalledTimes(2));
    if (failure === 'pending') {
      expect(mocks.observations).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6_000);
    }
    await pending;
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(mocks.observations).toHaveBeenCalledTimes(1);
    const supplied = mocks.observations.mock.calls[0][2];
    await expect(supplied.journal({ grep: DREAM_ACTION_DECISION_PREFIX })).resolves.toBe(retained);
    await expect(supplied.journal({ grep: GYM_ADMISSION_DECISION_PREFIX })).rejects.toThrow(
      failure === 'pending' ? 'gym-admission-journal exceeded the read budget' : 'gym journal unavailable');
  });
});
