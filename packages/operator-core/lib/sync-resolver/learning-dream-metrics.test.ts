import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegistryEntryV2, resolveNamedQueryV2 } from './index';
import { queryNamesForTriggerEvent } from './table-to-query-names';

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(), controls: vi.fn(), history: vi.fn(), detail: vi.fn(), observations: vi.fn(), tx: {},
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'metrics-workspace' }));
vi.mock('../route-workspace', () => ({ routeWithWorkspace: (fn: (tx: unknown) => unknown) => fn(mocks.tx) }));
vi.mock('../dream/dream-metrics', () => ({ readDreamMetrics: mocks.metrics }));
vi.mock('../dream/dream-control', () => ({ readDreamControlSnapshot: mocks.controls }));
vi.mock('../dream/dream-read', () => ({ readDreamHistory: mocks.history, readDreamDetail: mocks.detail }));
vi.mock('../dream/dream-control-observations', () => ({ readDreamControlObservations: mocks.observations }));

describe('learning.dream metrics use the existing scoped sync path', () => {
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
    for (const table of ['gym_autoloop_config', 'operator_gym_gates', 'scout_ticks'])
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`)).toContain('learning.dream');
  });
});
