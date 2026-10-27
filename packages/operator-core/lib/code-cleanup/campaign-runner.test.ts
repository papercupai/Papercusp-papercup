/**
 * P-009 (plan code-cleanup-campaigns-2026-10-26, R-8; D-015): one campaign round composes triage,
 * divergence filing, aggressiveness, the extraction planner, the tests-first executor, the
 * regression throttle and admission in a fixed order. These tests pin that order and each gate:
 * a diverged pair is filed before anything is locked, a dry run changes nothing, uncovered or
 * unplannable batches never start, and a throttled campaign starts nothing.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryCommit } from '../code-intelligence/change-history';
import type { AdmissionDeps } from './admission';
import { cleanupBatchRecord, linesRemovedFromNumstat, planCampaignRound, type CampaignRoundDeps, type CampaignRoundInput } from './campaign-runner';
import type { CoverageView, ExecutorMember } from './executor';
import { initialThrottleState, type CampaignThrottleState, type GateRed, type LandedBatch } from './throttle';
import type { DivergenceBug, TriageFamily } from './triage';

const END = '2026-10-01T00:00:00.000Z';
const NOW = new Date(END);
let seq = 0;
const commit = (day: number, ...paths: string[]): HistoryCommit => ({
  sha: (++seq).toString(16).padStart(40, '0'), parents: ['f'.repeat(40)],
  at: new Date(Date.parse(END) - day * 86_400_000).toISOString(),
  files: paths.map(path => ({ status: 'M', path })),
});

// The exact pair the extraction planner can merge (same fixture as extract-codemod.test.ts).
const A1 = 'src/a/sum.ts', A2 = 'src/b/c/sum.ts';
const SUM_A = `import { clamp } from '../util/math';

function total(values: number[]): number {
  let acc = 0;
  for (const v of values) acc += clamp(v);
  return acc;
}

export function report(xs: number[]) { return total(xs); }
`;
const SUM_B = `import { clamp } from '../../util/math';

/** Sum of clamped values. */
function total(values: number[]): number {
  let acc = 0; // running sum
  for (const v of values) acc   +=   clamp(v);
  return acc;
}

export const used = total([1]);
`;
const FILES: Record<string, string> = { [A1]: SUM_A, [A2]: SUM_B, 'src/util/math.ts': 'export const clamp = (n: number) => n;' };

// A diverged pair (one copy has a guard the other lacks) that also co-changes, so triage holds it.
const C1 = 'packages/delta/src/auth/session.ts', C2 = 'packages/delta/src/auth/token.ts';
const guarded = `function readSession(store, id) {
  if (!id) throw new Error('session id required');
  const row = store.get(id);
  return row ? row.value : null;
}`;
const unguarded = `function readToken(cache, key) {
  const entry = cache.get(key);
  return entry ? entry.value : null;
}`;

const member = (path: string, symbol: string, line: number, source?: string) =>
  ({ id: `${path}:${line}`, path, line, symbol, ...(source ? { source } : {}) });
const sumFamily: TriageFamily = {
  id: 'family-sum', kind: 'exact', redundantMass: 120, packageDistance: 1,
  members: [member(A1, 'total', 3), member(A2, 'total', 4)],
};
const divergedFamily: TriageFamily = {
  id: 'family-diverged', kind: 'near', redundantMass: 90, packageDistance: 0,
  members: [member(C1, 'readSession', 10, guarded), member(C2, 'readToken', 40, unguarded)],
};
const history = () => ({
  end: END, commit: 'e'.repeat(40), complete: true,
  commits: [...[3, 9, 15, 21, 30].map(d => commit(d, A1, A2)), ...[4, 10, 16, 22].map(d => commit(d, C1, C2))],
});

/** Coverage answering from the set of covered files (by member path). */
const coverage = (covered: readonly string[]): CoverageView => ({
  takenAt: { commit: 'e'.repeat(40), observedAt: END },
  coveringTests: (m: ExecutorMember) => (covered.includes(m.path) ? ['src/sum.test.ts'] : []),
});

function harness(opts: { state?: CampaignThrottleState; files?: Record<string, string> } = {}) {
  const log: string[] = [];
  const saved: CampaignThrottleState[] = [];
  const files = opts.files ?? FILES;
  const admission: AdmissionDeps = {
    liveLocks: async () => [],
    editsSince: async () => [],
    acquire: async batch => { log.push(`acquire:${batch.id}`); return { ok: true, lockId: `lock-${batch.id}` }; },
  };
  const deps: CampaignRoundDeps = {
    divergenceBug: async (): Promise<DivergenceBug> => ({ status: 'missing' }),
    fileDiverged: async holds => {
      log.push(`file:${holds.map(h => h.familyId).join(',')}`);
      return holds.map(h => ({ familyId: h.familyId, conditionKey: h.conditionKey, bugId: 'WI-diverged', disposition: 'created' as const }));
    },
    readFile: async p => files[p] ?? null,
    executor: { coverageTakenAtOrAfter: async () => true },
    admission,
    throttle: {
      load: async () => opts.state ?? initialThrottleState('off'),
      save: async (_c, s) => { saved.push(s); },
    },
  };
  return { deps, log, saved };
}

const input = (over: Partial<CampaignRoundInput> = {}): CampaignRoundInput => ({
  campaignId: 'cleanup-papercusp', self: 'su-runner', aggressiveness: 'safe',
  families: [sumFamily, divergedFamily], history: history(), coverage: coverage([A1, A2]),
  running: [], reds: [], landed: [], now: NOW, ...over,
});

describe('planCampaignRound (P-009, R-8)', () => {
  it('files the diverged pair before locking, then starts the covered batch with its edits', async () => {
    const { deps, log } = harness();
    const r = await planCampaignRound(input(), deps);

    expect(r.diverged.map(d => d.familyId)).toEqual(['family-diverged']);
    expect(r.divergedFiled.map(f => f.bugId)).toEqual(['WI-diverged']);
    expect(r.started).toHaveLength(1);
    const [batch] = r.started;
    expect(batch.familyIds).toEqual(['family-sum']);
    expect(batch.targetFiles).toEqual(expect.arrayContaining([A1, A2]));
    expect(batch.edits.every(e => e.before === FILES[e.path] || !(e.path in FILES))).toBe(true);
    expect(batch.lockId).toBe(`lock-${batch.batchId}`);
    // Divergence is filed before any acquire.
    expect(log[0]).toBe('file:family-diverged');
    expect(log.slice(1)).toEqual([`acquire:${batch.batchId}`]);
    expect(r.throttle.tripped).toBe(false);
  });

  it('on a dry run files nothing, saves nothing and takes no lock', async () => {
    const { deps, log, saved } = harness();
    const r = await planCampaignRound(input({ dryRun: true }), deps);
    expect(r.dryRun).toBe(true);
    expect(r.divergedFiled).toEqual([]);
    expect(r.started.map(b => b.lockId)).toEqual(['dry-run']);
    expect(log).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('under safe withholds a family with an uncovered member and starts nothing', async () => {
    const { deps, log } = harness();
    const r = await planCampaignRound(input({ coverage: coverage([A1]) }), deps);
    expect(r.started).toEqual([]);
    expect(r.withheldUnits.map(w => [w.unitId, w.reason])).toEqual([['family-sum', 'uncovered-under-safe']]);
    expect(log.some(l => l.startsWith('acquire:'))).toBe(false);
  });

  it('under standard routes an uncovered batch to characterization instead of refactoring it', async () => {
    const { deps, log } = harness();
    const r = await planCampaignRound(input({ aggressiveness: 'standard', coverage: coverage([A1]) }), deps);
    expect(r.started).toEqual([]);
    expect(r.withheldBatches).toHaveLength(1);
    expect(r.withheldBatches[0].reason).toBe('executor-step');
    expect(r.withheldBatches[0].step?.kind).toBe('characterize');
    expect(log.some(l => l.startsWith('acquire:'))).toBe(false);
  });

  it('withholds a batch whose every family the extraction planner refuses', async () => {
    const { deps, log } = harness({ files: { [A1]: SUM_A } });
    const r = await planCampaignRound(input(), deps);
    expect(r.started).toEqual([]);
    expect(r.codemodRefused.map(c => c.familyId)).toEqual(['family-sum']);
    expect(r.withheldBatches.map(w => w.reason)).toEqual(['no-planned-family']);
    expect(log.some(l => l.startsWith('acquire:'))).toBe(false);
  });

  it('trips the throttle on attributed reds above the threshold, saves the trip and starts nothing', async () => {
    const { deps, log, saved } = harness();
    const landed: LandedBatch[] = [{ batchId: 'earlier#0', workItemId: 'WI-1', editedFiles: ['src/x.ts'] }];
    const reds: GateRed[] = [1, 2, 3].map(i => ({
      id: `red-${i}`, testFile: `src/x${i}.test.ts`, at: new Date(NOW.getTime() - i * 3_600_000), affectedRadius: ['src/x.ts'],
    }));
    const r = await planCampaignRound(input({ landed, reds }), deps);
    expect(r.throttle.tripped).toBe(true);
    expect(r.throttle.count).toBe(3);
    expect(r.throttle.state.review).toBe('required');
    expect(saved).toHaveLength(1);
    expect(r.started).toEqual([]);
    expect(r.skipped.every(s => s.reason === 'campaign-throttled')).toBe(true);
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(log.some(l => l.startsWith('acquire:'))).toBe(false);
  });

  it('starts nothing while an earlier trip still holds the campaign', async () => {
    const tripped: CampaignThrottleState = { ...initialThrottleState('off'), throttled: true, review: 'required', reviewBeforeTrip: 'off', trippedAt: NOW };
    const { deps, log, saved } = harness({ state: tripped });
    const r = await planCampaignRound(input(), deps);
    expect(r.started).toEqual([]);
    expect(r.throttle.tripped).toBe(false);
    expect(saved).toEqual([]);
    expect(log.some(l => l.startsWith('acquire:'))).toBe(false);
  });
});

describe('cleanupBatchRecord (D-014)', () => {
  const numstat = ['3\t10\tsrc/a/sum.ts', '1\t7\tsrc/b/c/sum.ts', '40\t0\tsrc/unrelated.ts', '-\t-\tsrc/a/logo.png', ''].join('\n');

  it('counts net lines removed over the batch\'s own files only, binary entries as zero', () => {
    expect(linesRemovedFromNumstat(numstat, ['src/a/sum.ts', 'src/b/c/sum.ts', 'src/a/logo.png'])).toBe(13);
  });

  it('builds the payload record with sorted, de-duplicated red ids', () => {
    expect(cleanupBatchRecord({
      campaign: 'cleanup-papercusp', batchId: 'src#0', numstat, files: ['src/a/sum.ts'], attributedRedIds: ['r2', 'r1', 'r2'],
    })).toEqual({ campaign: 'cleanup-papercusp', batchId: 'src#0', linesRemoved: 7, attributedRedIds: ['r1', 'r2'] });
  });

  it('refuses a record without a campaign or batch id', () => {
    expect(() => cleanupBatchRecord({ campaign: ' ', batchId: 'b', numstat: '', files: [] })).toThrow(/campaign/);
  });
});
