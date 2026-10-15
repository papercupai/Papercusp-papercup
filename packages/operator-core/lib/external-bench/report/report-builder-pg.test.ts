/**
 * PG-source report builder tests (plan benchmark-report-portable-trace-2026-06-17, P-001).
 * Injected fake readers — NO PG. Proves the live-store → bundle adapter joins rollouts, derives
 * arms/models, maps coord/spawn, and degrades gracefully.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildBundleFromPg, type PgReportReaders } from './report-builder-pg';
import { currentProtocolFixture } from '../reproducibility/_protocol-test-fixture';

const defaults = vi.hoisted(() => ({ listRunResults: vi.fn(), getRollout: vi.fn(), getBenchRunDetail: vi.fn(), getPrereg: vi.fn() }));
vi.mock('../reproducibility/store', async importOriginal => ({
  ...await importOriginal<typeof import('../reproducibility/store')>(),
  listRunResults: defaults.listRunResults, getRollout: defaults.getRollout, getPrereg: defaults.getPrereg,
}));
vi.mock('../run-store', () => ({ getBenchRunDetail: defaults.getBenchRunDetail }));

function fakeReaders(over: Partial<PgReportReaders> = {}): PgReportReaders {
  return {
    listRunResults: async () => [
      { runId: 'r1', suite: 'swe-bench-pro', taskId: 't1', arm: 'hive', seed: 0, resolved: true, graderStatus: 'passed',
        generationStatus: 'completed', rolloutId: 'roll-1', tokensIn: 5, tokensOut: 5, tokensTotal: 10, costUsd: 2, wallClockMs: 100 },
      { runId: 'r1', suite: 'swe-bench-pro', taskId: 't2', arm: 'su-independent', seed: 0, resolved: false, graderStatus: 'failed',
        generationStatus: 'completed', rolloutId: 'roll-2', tokensIn: 5, tokensOut: 5, tokensTotal: 10, costUsd: 3, wallClockMs: 200 },
    ],
    getRollout: async (id) => ({
      rolloutId: id, taskId: id === 'roll-1' ? 't1' : 't2', arm: id === 'roll-1' ? 'hive' : 'su-independent', seed: 0,
      modelId: 'claude-opus-4-8[1m]', harnessVersion: 'external-bench@abc', harnessGitSha: 'cafe1234',
      submission: 'diff --git a/x b/x', rawGraderOutput: '{"resolved":true}', trajectoryRef: 'xbench://t-' + id,
      configSnapshot: { tier: 'max' }, createdAt: '2026-06-17T00:00:00Z',
    }),
    getBenchRunDetail: async () => ({
      coordEvents: [{ ts: 1718600000000, kind: 'spawn', agent: 'mug', taskId: 't1', detail: 'placed t1' }],
      perTask: [{ instanceId: 't1', cupId: 's-bee-1', stopReason: 'done', costUsd: 2 }],
    }),
    ...over,
  };
}

describe('buildBundleFromPg', () => {
  const prereg = { runId: 'r1', preregHash: 'frozen', suites: ['swe-bench-pro'], createdAt: '2026-10-09', filePath: 'frozen.json', gitCommitted: true,
    config: { taskIds: ['t1', 't2', 't3'], seeds: [0, 1], arms: ['hive', 'su-independent', 'absent'] } };
  it('reads the frozen population from preregistration including wholly absent arms and tasks', async () => {
    const b = await buildBundleFromPg('r1', { readers: fakeReaders({ getPrereg: async () => prereg }) });
    expect(b?.run.totals.tasks).toBe(3);
    expect(b?.run.arms).toEqual(['hive', 'su-independent', 'absent']);
    expect(b?.arms[0]).toMatchObject({ assignedAttempts: 6, primaryResolvedPct: 1 / 6 });
    expect(b?.arms[2]).toMatchObject({ absentAttempts: 6, primaryResolvedPct: 0 });
    expect(b?.run.prereg?.hash).toBe('frozen');
  });
  it('keeps an entirely unattempted preregistered run exportable', async () => {
    const b = await buildBundleFromPg('r1', { readers: fakeReaders({ getPrereg: async () => prereg,
      listRunResults: async () => [] }) });
    expect(b?.suite).toBe('swe-bench-pro');
    expect(b?.arms).toHaveLength(3);
    expect(b?.arms.every(a => a.primaryResolvedPct === 0 && a.assignedAttempts === 6)).toBe(true);
  });
  it('fails closed on an unreadable preregistration rather than shrinking the population', async () => {
    await expect(buildBundleFromPg('r1', { readers: fakeReaders({ getPrereg: async () => {
      throw new Error('prereg unavailable');
    } }) })).rejects.toThrow('prereg unavailable');
  });
  it('uses maintained structured controls and refuses frozen identity or protocol drift', async () => {
    const protocol = currentProtocolFixture('r1');
    const frozen = { ...prereg, config: { ...protocol } };
    const row = { ...(await fakeReaders().listRunResults({ runId: 'r1' }))[0], arm: 'papercusp',
      taskId: 't1', seed: 1, modelId: 'configured-alias', preregHash: 'frozen' };
    const readers = fakeReaders({ listRunResults: async () => [row], getPrereg: async () => frozen,
      getRollout: async () => ({ rolloutId: 'roll-1', taskId: 't1', arm: 'papercusp', seed: 1,
        modelId: 'configured-alias', harnessVersion: 'fixture-current' }) });
    const bundle = await buildBundleFromPg('r1', { readers });
    expect(bundle?.run.arms).toEqual(['papercusp', 'baseline']);
    expect(bundle?.run.models).toEqual({ papercusp: 'configured-alias', baseline: 'configured-alias' });
    await expect(buildBundleFromPg('r1', { readers: { ...readers, listRunResults: async () => [{ ...row, preregHash: 'foreign' }] } }))
      .rejects.toThrow('preregistration');
    await expect(buildBundleFromPg('r1', { readers: { ...readers, getPrereg: async () => ({ ...frozen, config: { ...protocol, priceSchedule: undefined } }) } }))
      .rejects.toThrow();
  });
  it('retains source cost uncertainty and native timing metadata through the store adapter', async () => {
    const readers = fakeReaders(), rows = await readers.listRunResults({ runId: 'r1' });
    const armMeta = { costUsdMeasurementMissing: true, nativeCostAccounting: { billedCostUsd: null,
      basis: 'frozen-normalized-native-source', taskLedgerConcurrency: { complete: false, wallClockMs: null } } };
    const b = await buildBundleFromPg('r1', { readers: fakeReaders({ listRunResults: async () => [
      { ...rows[0], armMeta }, rows[1],
    ] }) });
    expect(b?.rollouts[0]).toMatchObject({ costUsd: null, costKnownSubtotalUsd: 2, costUsdMeasurementMissing: true, armMeta });
    expect(b?.run.totals).toMatchObject({ costUsd: null, costKnownSubtotalUsd: 5, costUsdMeasurementMissing: true });
  });
  it('binds the requested workspace on each default store read', async () => {
    const fixtures = fakeReaders();
    defaults.listRunResults.mockResolvedValue(await fixtures.listRunResults({ runId: 'r1' }));
    defaults.getPrereg.mockResolvedValue(null);
    defaults.getRollout.mockImplementation(fixtures.getRollout);
    defaults.getBenchRunDetail.mockImplementation(fixtures.getBenchRunDetail!);
    const report = await buildBundleFromPg('r1', { workspace: 'bench-private' });
    expect(report?.rollouts).toHaveLength(2);
    expect(defaults.listRunResults).toHaveBeenCalledWith({ runId: 'r1', workspaceId: 'bench-private' });
    expect(defaults.getRollout).toHaveBeenCalledWith('roll-1', { workspaceId: 'bench-private' });
    expect(defaults.getRollout).toHaveBeenCalledWith('roll-2', { workspaceId: 'bench-private' });
    expect(defaults.getPrereg).toHaveBeenCalledWith({ runId: 'r1' }, { workspaceId: 'bench-private' });
    expect(defaults.getBenchRunDetail).toHaveBeenCalledWith('r1', { workspaceId: 'bench-private' });
  });

  it('assembles a bundle from the live store: rollups, replay fingerprint, coord + spawn', async () => {
    const b = (await buildBundleFromPg('r1', { readers: fakeReaders() }))!;
    expect(b).not.toBeNull();
    expect(b.run.runId).toBe('r1');
    expect(b.suite).toBe('swe-bench-pro');
    expect(b.run.arms.sort()).toEqual(['hive', 'su-independent']);
    expect(b.run.models.hive).toBe('claude-opus-4-8[1m]');
    expect(b.rollouts).toHaveLength(2);
    // replay fingerprint joined onto the row
    const t1 = b.rollouts.find((r) => r.taskId === 't1')!;
    expect(t1.harnessGitSha).toBe('cafe1234');
    expect(t1.submission).toContain('diff --git');
    expect(t1.trajectoryRef).toBe('xbench://t-roll-1');
    // coord + spawn projected
    expect(b.coordTrace).toHaveLength(1);
    expect(b.coordTrace![0].kind).toBe('spawn');
    expect(b.spawnTree).toHaveLength(1);
    expect(b.spawnTree![0].spawnId).toBe('s-bee-1');
    // per-arm rollup
    expect(b.arms.find((a) => a.arm === 'hive')!.resolved).toBe(1);
  });

  it('returns null for a run with no result rows', async () => {
    const b = await buildBundleFromPg('empty', { readers: fakeReaders({ listRunResults: async () => [] }) });
    expect(b).toBeNull();
  });

  it('degrades gracefully when rollout + detail reads return nothing', async () => {
    const b = (await buildBundleFromPg('r1', {
      readers: fakeReaders({ getRollout: async () => null, getBenchRunDetail: async () => null }),
    }))!;
    expect(b.rollouts).toHaveLength(2); // still has the scoreable rows
    expect(b.rollouts[0].submission).toBeNull(); // no replay fingerprint, but no crash
    expect(b.coordTrace).toBeUndefined();
    expect(b.spawnTree).toBeUndefined();
    expect(b.arms.find((a) => a.arm === 'hive')!.resolved).toBe(1); // rollups still computed
  });

  // D-007 / WI-6554700010008413: the PG path resolves task creation dates through the run's task set.
  describe('task creation dates (contamination policy)', () => {
    const dated = (over: Partial<PgReportReaders> = {}) => {
      const base = fakeReaders();
      return fakeReaders({
        getRollout: async (id) => ({ ...(await base.getRollout(id))!, modelId: 'claude-opus-5-5' }),
        getBenchRunDetail: async () => ({ taskSetId: 'swe-bench-verified' }),
        getTaskCreatedAt: async () => ({ t1: '2026-08-14T09:00:00Z', t2: '2024-03-02T00:00:00Z' }),
        ...over,
      });
    };

    it('labels each arm from dated rows instead of reading unknown', async () => {
      const seen: Array<[string, readonly string[]]> = [];
      const b = (await buildBundleFromPg('r1', { readers: dated({
        getTaskCreatedAt: async (taskSetId, ids) => { seen.push([taskSetId, ids]); return { t1: '2026-08-14T09:00:00Z', t2: '2026-09-02T00:00:00Z' }; },
      }) }))!;
      expect(seen).toEqual([['swe-bench-verified', ['t1', 't2']]]);
      expect(b.arms.map((a) => a.contamination?.label)).toEqual(['post-cutoff', 'post-cutoff']);
    });

    it('splits the assigned population into post-cutoff and exposed subsets', async () => {
      const b = (await buildBundleFromPg('r1', { readers: dated() }))!;
      for (const a of b.arms) {
        expect(a.contamination).toMatchObject({
          label: 'contamination-exposed', modelId: 'claude-opus-5-5',
          postCutoff: { taskIds: ['t1'] }, exposed: { taskIds: ['t2'] }, unknown: { taskIds: [] },
        });
      }
    });

    it('reads unknown when the run records no task set, and when the corpus cannot be read', async () => {
      const noSet = (await buildBundleFromPg('r1', { readers: dated({ getBenchRunDetail: async () => ({}) }) }))!;
      const broken = (await buildBundleFromPg('r1', { readers: dated({
        getTaskCreatedAt: async () => { throw new Error('corpus missing'); },
      }) }))!;
      for (const b of [noSet, broken]) {
        expect(b.arms.map((a) => a.contamination?.label)).toEqual(['contamination-unknown', 'contamination-unknown']);
      }
    });
  });

  it('attaches an injected call-log (the defineTool replay-grade audit)', async () => {
    const b = (await buildBundleFromPg('r1', {
      readers: fakeReaders(),
      extraCallLog: [{ ts: '2026-06-17T00:00:01Z', tool: 'capability:edit', ok: true, costUsd: 0.01 }],
    }))!;
    expect(b.callLog).toHaveLength(1);
    expect(b.callLog![0].tool).toBe('capability:edit');
  });
});
