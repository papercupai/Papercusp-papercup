/** R-5 attention macro: real sources, parser, aggregate/cache and JSON consumer.
 * The baseline reconstructs the full-feed consumer, not a historical source tree.
 * This is attention evidence only; orientation and whole-program acceptance are separate.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { DARK_FLAGS, DARK_FLAGS_OWNER_CASES } from '@papercusp/flags';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { runWithWorkspace } from '../../workspace-als';
import {
  __setCachedReadEnabledForTests, getOperatorCache, resetOperatorCacheForTests,
} from '../../cache';
import { _refreshCacheLayerForTests } from '../../cache/instance';
import { _refreshL2FlagForTests, getL2Store } from '../../cache/l2-tier';
import { fireBuiltinReactionAction } from '../../events/builtin-actions';
import { deriveAttentionCounts, deriveAttentionRefs } from '../../sync-resolver/attention-counts';
import { cleanupPlans, seedPlan } from './__tests__/_pg-tool-fixture';
import { readPlanBySlug } from './source';
import { withPlanLock } from './with-plan-lock';
import attention from './attention';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = `test-r5-attention-${RUN}`;
const HARNESS = `zzz-r5-attention-${RUN}`;
const PLAN_COUNT = 8;
const ITEMS_PER_PLAN = 128;
const WINDOWS = 10;
const WARM_READS = 20;
const CONCURRENCY = 8;
const ROOT = resolve(__dirname, '../../../../..');
const SOURCE_PATHS = [
  'packages/operator-core/lib/agent-tools/plans/attention.ts',
  'packages/operator-core/lib/agent-tools/plans/source.ts',
  'packages/operator-core/lib/plan-item-coverage.ts',
  'packages/operator-core/lib/sync-resolver/attention-counts.ts',
  'packages/operator-core/lib/agent-tools/plans/attention.performance.integration.test.ts',
  'libs/flags/src/types.ts',
  'packages/operator-core/lib/cache/cached-read.ts',
  'packages/operator-core/lib/cache/l2-tier.ts',
  'packages/operator-core/lib/cache/pg-l2-store.ts',
  'packages/operator-core/lib/events/builtin-actions.ts',
  'packages/operator-core/lib/agent-tools/plans/with-plan-lock.ts',
  'packages/operator-core/lib/agent-tools/plans/__tests__/_pg-tool-fixture.ts',
];
type Output = 'counts' | 'refs';
type Arm = 'full-feed-consumer' | 'compact-consumer';
interface ReadSample { phase: string; output: Output; ms: number; wireBytes: number; resultHash: string }
interface Window { window: number; arm: Arm; samples: ReadSample[]; complete: boolean }
let fx: BaselineCoordFixture;
const pendingL2: Promise<unknown>[] = [];
const ctx = { workspaceId: WS, harnessSlug: HARNESS, isSuperuser: true,
  uiClientId: `su-r5-${RUN}`, metadata: vi.fn(), log: vi.fn(), progress: vi.fn() };

async function settleL2() {
  await Promise.all(pendingL2.splice(0));
}
async function invalidateAttention() {
  // Exercise the actual write-bus action (L1 AND L2). Its durable delete is
  // fire-and-forget in production; observe its completion without replacing it.
  expect(await fireBuiltinReactionAction('cache.bumpTags', { tags: ['harness_plans'] }, WS)).toEqual({ ok: true });
  await settleL2();
}
async function writeFirstItem(done: boolean) {
  const result = await runWithWorkspace(WS, () => withPlanLock(ctx, {
    workspaceId: WS, harnessSlug: HARNESS, slug: 'r5-plan-0', intent: 'R-5 private fixture content write',
  }, async () => ({ newBody: body('r5-plan-0', done), value: null })));
  expect(result.kind).toBe('applied');
}
function population() {
  const refs = new Set(Array.from({ length: PLAN_COUNT }, (_, n) =>
    Array.from({ length: ITEMS_PER_PLAN }, (_, i) => `plan-item:r5-plan-${n}:P-${String(i + 1).padStart(3, '0')}`)).flat());
  const registryRefs = [...DARK_FLAGS].filter(([, entry]) => DARK_FLAGS_OWNER_CASES.has(entry.case))
    .map(([key]) => `dark-flag-ratification:${key}`).sort();
  for (const id of registryRefs) refs.add(id);
  return { refs, registryRefs, counts: { decisionItems: PLAN_COUNT * ITEMS_PER_PLAN / 4 + registryRefs.length,
    decisionPlans: PLAN_COUNT, alerts: 0, total: refs.size } };
}

async function invalidationPreflight() {
  const expected = population();
  const changedCounts = { ...expected.counts, decisionItems: expected.counts.decisionItems - 1, total: expected.counts.total - 1 };
  const snapshots: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = { schemaVersion: 1, incomplete: true, sourceStart: hashes(), snapshots,
    hypothesis: 'L1-only fixture invalidation reuses the old durable L2 value',
    alternativeHypothesis: 'Unbumped seed version makes the production plan reader return old content' };
  const publish = () => {
    if (process.env.PAPERCUSP_R5_ATTENTION_INVALIDATION_REPORT) {
      writeFileSync(process.env.PAPERCUSP_R5_ATTENTION_INVALIDATION_REPORT, JSON.stringify(report, null, 2) + '\n');
    }
  };
  const counts = async (phase: string) => {
    const result = await runWithWorkspace(WS, () => attention.handler({ output: 'counts', harnessSlug: HARNESS }, ctx as never));
    const data = JSON.parse(JSON.stringify((result as { data: unknown }).data));
    snapshots.push({ phase, data }); publish();
    return data;
  };
  publish();
  try {
    await settleL2();
    await invalidateAttention();
    expect(await counts('baseline')).toEqual({ counts: expected.counts, degraded: false });
    await settleL2();
    const before = await readPlanBySlug('r5-plan-0', { workspaceId: WS, harnessSlug: HARNESS });
    await seedPlan(fx.admin, WS, HARNESS, 'r5-plan-0', body('r5-plan-0', true));
    const after = await readPlanBySlug('r5-plan-0', { workspaceId: WS, harnessSlug: HARNESS });
    snapshots.push({ phase: 'direct-source-after-unversioned-seed', beforeVersion: before?.row.version,
      afterVersion: after?.row.version, item: after?.parsed.items[0] }); publish();
    expect(after?.row.version).toBe(before?.row.version);
    expect(after?.parsed.items[0]?.storedStatus).toBe('done');
    getOperatorCache().invalidateByTags(WS, ['harness_plans']);
    expect(await counts('L1-only-negative-control')).toEqual({ counts: expected.counts, degraded: false });
    __setCachedReadEnabledForTests(false);
    try {
      expect(await counts('uncached-source-control')).toEqual({ counts: changedCounts, degraded: false });
    } finally { __setCachedReadEnabledForTests(true); }
    await invalidateAttention();
    expect(await counts('production-two-tier-invalidation')).toEqual({ counts: changedCounts, degraded: false });
    const result = await runWithWorkspace(WS, () => attention.handler({ output: 'refs', harnessSlug: HARNESS }, ctx as never));
    const refs = (result as { data: { refs: { id: string }[]; degraded: boolean } }).data;
    expect(refs.degraded).toBe(false);
    expect(new Set(refs.refs.map(row => row.id))).toEqual(new Set([...expected.refs].filter(id => id !== 'plan-item:r5-plan-0:P-001')));
    await settleL2();
    await writeFirstItem(false);
    const restored = await readPlanBySlug('r5-plan-0', { workspaceId: WS, harnessSlug: HARNESS });
    expect(restored?.row.version).toBe(after!.row.version + 1);
    expect(restored?.parsed.items[0]?.storedStatus).toBe('needs-human');
    await invalidateAttention();
    expect(await counts('production-writer-restored')).toEqual({ counts: expected.counts, degraded: false });
    await settleL2();
    report.sourceEnd = hashes();
    expect(report.sourceEnd).toEqual(report.sourceStart);
    report.incomplete = false;
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally { publish(); }
}

function body(slug: string, firstDone = false): string {
  const items = Array.from({ length: ITEMS_PER_PLAN }, (_, i) => {
    const status = firstDone && i === 0 ? 'done' : i % 4 === 0 ? 'needs-human' : 'todo';
    return `- **P-${String(i + 1).padStart(3, '0')}** \`${status}\` Item ${i}: ${'controlled-content-'.repeat(100)}`;
  });
  return `---\ntitle: ${slug}\nslug: ${slug}\nstatus: active\ncreated: 2026-10-02\nupdated: 2026-10-02\n---\n\n## Now\n\n**State:** frozen macro fixture.\n**Next:** verify reads.\n\n## Items\n\n${items.join('\n')}\n`;
}

function hashes() {
  return SOURCE_PATHS.map(path => ({ path,
    sha256: createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex') }));
}
function digest(value: unknown) {
  // Object property insertion order is a transport detail. Array order, keys
  // and values are semantic and must still distinguish different results.
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function p95(samples: readonly number[]) {
  expect(samples.length).toBeGreaterThan(0);
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  for (let i = 0; i < PLAN_COUNT; i++) {
    const slug = `r5-plan-${i}`;
    await seedPlan(fx.admin, WS, HARNESS, slug, body(slug));
  }
  setFlagOverridesForTest({ 'papercusp-cache-layer': true, 'papercusp-cache-l2': true });
  resetOperatorCacheForTests();
  __setCachedReadEnabledForTests(true);
  await _refreshCacheLayerForTests();
  await _refreshL2FlagForTests();
  const store = getL2Store();
  const set = store.set.bind(store);
  const invalidate = store.invalidateByTags.bind(store);
  vi.spyOn(store, 'set').mockImplementation((...args) => {
    const pending = set(...args); pendingL2.push(pending); return pending;
  });
  vi.spyOn(store, 'invalidateByTags').mockImplementation((...args) => {
    const pending = invalidate(...args); pendingL2.push(pending); return pending;
  });
}, 180_000);

afterAll(async () => {
  await settleL2();
  if (fx) await getL2Store().invalidateByTags(WS, ['harness_plans']);
  await settleL2();
  vi.restoreAllMocks();
  resetOperatorCacheForTests();
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  if (fx) {
    await cleanupPlans(fx.admin, WS, HARNESS);
    await fx.admin`DELETE FROM harness_shared.projects WHERE id = ${HARNESS}`;
    await fx.dispose();
  }
});

describe('R-5 real PostgreSQL attention macro', () => {
  it('verifies both cache tiers independently before repeated measurements', invalidationPreflight, 180_000);
  it('compares semantic values without mistaking object insertion order for a result change', () => {
    expect(digest({ counts: { total: 2, alerts: 1 }, degraded: false }))
      .toBe(digest({ degraded: false, counts: { alerts: 1, total: 2 } }));
    expect(digest({ refs: ['a', 'b'] })).not.toBe(digest({ refs: ['b', 'a'] }));
    expect(digest({ counts: { total: 2 } })).not.toBe(digest({ counts: { total: 3 } }));
    expect(digest({ total: 2 })).not.toBe(digest({ total: 2, degraded: false }));
  });

  it('compares matched cold, warm and concurrent consumers and preserves exact invalidation', async () => {
    const windows: Window[] = [];
    const report: Record<string, unknown> = {
      schemaVersion: 1, incomplete: true, workspaceId: WS, harness: HARNESS,
      workload: { plans: PLAN_COUNT, itemsPerPlan: ITEMS_PER_PLAN, windows: WINDOWS, warmReads: WARM_READS, concurrency: CONCURRENCY },
      sourceStart: hashes(), windows,
      baselineDefinition: 'Current real handler full feed, JSON round trip, then production count/ref derivation. Consumer counterfactual; not an old source checkout.',
      coldDefinition: 'Production cache.bumpTags clears L1 and durable L2 before each cold window; both invalidations are joined. PostgreSQL buffers and process imports remain warm. This measures a full aggregate rebuild, not a physical cold database.',
      limitations: ['Attention only; no orientation/obligation/fact timing.', 'Named source hashes are not a complete imported graph.', 'No deployment or historical source-tree performance claim.'],
    };
    const publish = () => {
      if (process.env.PAPERCUSP_R5_ATTENTION_REPORT) {
        writeFileSync(process.env.PAPERCUSP_R5_ATTENTION_REPORT, JSON.stringify(report, null, 2) + '\n');
      }
    };
    // These source-code registry notices intentionally appear in every harness.
    // Freeze their exact independent IDs; never accept an unexplained count delta.
    const { refs: expectedRefs, registryRefs, counts: expectedCounts } = population();
    report.registryPopulation = registryRefs;
    const expected = new Map<Output, string>();
    const expectedValues = new Map<Output, unknown>();
    async function read(arm: Arm, output: Output, phase: string): Promise<ReadSample> {
      const start = performance.now();
      const res = await runWithWorkspace(WS, () => attention.handler({
        harnessSlug: HARNESS, limit: null, output: arm === 'compact-consumer' ? output : 'feed',
      }, ctx as never));
      const wire = JSON.stringify((res as { data: Record<string, unknown> }).data);
      const parsed = JSON.parse(wire);
      if (arm === 'full-feed-consumer' && !report.populationObserved) {
        const rows = parsed.groups.flatMap((group: { items: Record<string, unknown>[] }) => group.items);
        report.populationObserved = { total: rows.length,
          unexpected: rows.filter((row: { id: string }) => !expectedRefs.has(row.id)).map((row: Record<string, unknown>) => ({
            id: row.id, kind: row.kind, source: row.source, harnessSlug: row.harnessSlug,
            planSlug: row.planSlug, status: row.status, tier: row.tier,
          })) };
        publish();
      }
      const value = arm === 'compact-consumer' ? parsed : output === 'counts'
        ? { counts: deriveAttentionCounts(parsed.groups), degraded: parsed.degraded === true }
        : { refs: deriveAttentionRefs(parsed.groups), degraded: parsed.degraded === true };
      const ms = performance.now() - start;
      expect(value.degraded, 'Empty fallback is not a successful macro read').toBe(false);
      if (output === 'counts') expect(value.counts).toEqual(expectedCounts);
      else {
        expect(value.refs).toHaveLength(expectedRefs.size);
        expect(new Set(value.refs.map((row: { id: string }) => row.id))).toEqual(expectedRefs);
      }
      const resultHash = digest(value);
      if (!expected.has(output)) {
        expected.set(output, resultHash);
        expectedValues.set(output, structuredClone(value));
      }
      if (resultHash !== expected.get(output)) {
        report.semanticMismatch = { arm, output, phase, expected: expectedValues.get(output), actual: value };
        publish();
      }
      expect(value, 'Exact values and reference array order must match the paired oracle').toEqual(expectedValues.get(output));
      expect(resultHash, 'Full and compact consumers must have identical values and ordering').toBe(expected.get(output));
      return { phase, output, ms, wireBytes: Buffer.byteLength(wire), resultHash };
    }
    publish();
    try {
      report.invalidationPreflight = await invalidationPreflight();
      // Check both consumers before the repeated windows so population/schema
      // errors produce complete diagnostics after two reads, not after an arm.
      for (const output of ['counts', 'refs'] as const) {
        await read('full-feed-consumer', output, 'preflight');
        await read('compact-consumer', output, 'preflight');
      }
      report.pairedPreflight = { counts: true, refs: true };
      for (let window = 0; window < WINDOWS; window++) {
        const arms: Arm[] = window % 2 ? ['compact-consumer', 'full-feed-consumer'] : ['full-feed-consumer', 'compact-consumer'];
        for (const arm of arms) {
          const row: Window = { window, arm, samples: [], complete: false };
          windows.push(row); publish();
          await invalidateAttention();
          row.samples.push(await read(arm, 'counts', 'cold'));
          for (let i = 0; i < WARM_READS; i++) row.samples.push(await read(arm, i % 2 ? 'refs' : 'counts', 'warm'));
          row.samples.push(...await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) =>
            read(arm, i % 2 ? 'refs' : 'counts', 'warm-concurrent'))));
          await invalidateAttention();
          row.samples.push(...await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) =>
            read(arm, i % 2 ? 'refs' : 'counts', 'cold-concurrent'))));
          row.complete = true; publish();
        }
      }
      const summary = (['full-feed-consumer', 'compact-consumer'] as Arm[]).map(arm => ({ arm,
        phases: Object.fromEntries(['cold', 'warm', 'warm-concurrent', 'cold-concurrent'].map(phase => {
          const samples = windows.filter(row => row.arm === arm).flatMap(row => row.samples).filter(sample => sample.phase === phase);
          return [phase, { reads: samples.length, p95Ms: p95(samples.map(sample => sample.ms)),
            maxWireBytes: Math.max(...samples.map(sample => sample.wireBytes)) }];
        })),
      }));
      report.summary = summary;
      report.sourceEnd = hashes();
      expect(report.sourceEnd, 'Named measured source files moved during the macro').toEqual(report.sourceStart);
      const candidate = summary.find(row => row.arm === 'compact-consumer')!;
      expect(candidate.phases.cold.p95Ms).toBeLessThanOrEqual(1_000);
      expect(candidate.phases['cold-concurrent'].p95Ms).toBeLessThanOrEqual(1_000);
      expect(candidate.phases.warm.p95Ms).toBeLessThanOrEqual(250);
      expect(candidate.phases['warm-concurrent'].p95Ms).toBeLessThanOrEqual(250);

      // Drive an actual PostgreSQL plan write, then the production tag-invalidation
      // seam used by the write bus; do not manufacture a new cache entry by reset.
      await settleL2();
      await writeFirstItem(true);
      await invalidateAttention();
      const changed = await runWithWorkspace(WS, () => attention.handler({ output: 'counts', harnessSlug: HARNESS }, ctx as never));
      expect((changed as { data: unknown }).data).toEqual({ counts: {
        ...expectedCounts, decisionItems: expectedCounts.decisionItems - 1, total: expectedCounts.total - 1,
      }, degraded: false });
      const changedRefs = await runWithWorkspace(WS, () => attention.handler({ output: 'refs', harnessSlug: HARNESS }, ctx as never));
      const refs = (changedRefs as { data: { refs: { id: string }[]; degraded: boolean } }).data;
      expect(refs.degraded).toBe(false);
      expect(new Set(refs.refs.map(row => row.id))).toEqual(new Set([...expectedRefs].filter(id => id !== 'plan-item:r5-plan-0:P-001')));
      report.invalidation = { countsExact: true, refsExact: true, removed: 'plan-item:r5-plan-0:P-001' };
      report.incomplete = false;
      console.log('R5_ATTENTION_MACRO ' + JSON.stringify(summary));
    } catch (error) {
      report.error = error instanceof Error ? error.stack : String(error);
      throw error;
    } finally { publish(); }
  }, 180_000);
});
