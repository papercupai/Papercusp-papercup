import { parsePlan } from '@papercusp/plan-parser';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMPAIGN_CONCURRENCY_CAP, DEFAULT_RECENT_EDIT_WINDOW_MS } from './admission';
import { buildCampaignPlan, campaignBatchesFromPlan, campaignBatchId } from './campaign-plan';
import type { TriageBatch, TriagedFamily } from './triage';

const family = (id: string, paths: string[]): TriagedFamily => ({
  id, score: 1, churn: 2, redundantMass: 100, packageDistance: 0,
  coChange: { minLinkScore: 0.5, files: paths.length, basis: 'file' as const },
  members: paths.map((path, i) => ({ path, line: 10 + i, symbol: `fn${i}` })),
});
const batch = (area: string, index: number, families: TriagedFamily[], score = 2.5): TriageBatch =>
  ({ area, index, score, redundantMass: families.length * 100, families });

const BATCHES: TriageBatch[] = [
  batch('pkg/a', 0, [family('f1', ['pkg/a/x.ts', 'pkg/a/y.ts']), family('f2', ['pkg/a/y.ts', 'pkg/a/z.ts'])], 3.25),
  batch('pkg/b', 0, [family('f3', ['pkg/b/q.ts', 'pkg/b/r.ts'])], 1.5),
  batch('pkg/a', 1, [family('f4', ['pkg/a/w.ts', 'pkg/a/v.ts'])], 1.125),
];

describe('buildCampaignPlan', () => {
  it('emits one plan item per batch, best first, with deduplicated sorted target files', () => {
    const plan = buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES });
    expect(plan.batches.map(b => [b.itemId, b.id])).toEqual([
      ['P-001', 'pkg/a#0'], ['P-002', 'pkg/b#0'], ['P-003', 'pkg/a#1'],
    ]);
    expect(plan.batches[0].targetFiles).toEqual(['pkg/a/x.ts', 'pkg/a/y.ts', 'pkg/a/z.ts']);
    expect(plan.batches[2].targetFiles).toEqual(['pkg/a/v.ts', 'pkg/a/w.ts']);
    expect(campaignBatchId(BATCHES[1])).toBe('pkg/b#0');
  });

  it('produces plan content whose items parse with the real plan parser', () => {
    const plan = buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES });
    const parsed = parsePlan(plan.content);
    expect(parsed.items.map(i => [i.id, i.storedStatus])).toEqual([
      ['P-001', 'todo'], ['P-002', 'todo'], ['P-003', 'todo'],
    ]);
    expect(parsed.items[0].text).toContain('Batch pkg/a#0');
    expect(parsed.items[0].text).toContain('Eject:');
  });

  it('defaults to safe aggressiveness, review off and the admission defaults', () => {
    const plan = buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES });
    expect(plan.settings).toEqual({
      aggressiveness: 'safe', review: 'off',
      cap: DEFAULT_CAMPAIGN_CONCURRENCY_CAP, recentEditWindowMs: DEFAULT_RECENT_EDIT_WINDOW_MS,
    });
    expect(plan.content).toContain('- review: off');
    expect(plan.batches[0].eject).toMatch(/revert the single commit/);
  });

  it('names the PR eject path when review is required', () => {
    const plan = buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES, review: 'required' });
    expect(plan.batches.every(b => /close the batch PR/.test(b.eject))).toBe(true);
  });

  it('launches no more fleet members than the concurrency cap or the batch count', () => {
    expect(buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES }).launch.count).toBe(2);
    expect(buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES, cap: 5 }).launch.count).toBe(3);
    expect(buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES.slice(0, 1) }).launch.count).toBe(1);
    const { launch } = buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES, cap: 1 });
    expect(launch).toMatchObject({ name: 'cleanup-test-campaign', plan: 'cleanup-test-campaign', count: 1, headless: true });
    expect(launch.brief).toContain('never runs more than 1 batches at once');
  });

  it('refuses an empty campaign, a bad slug, a bad cap and duplicate batch ids', () => {
    expect(() => buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: [] })).toThrow(/at least one batch/);
    expect(() => buildCampaignPlan({ slug: 'Bad Slug', batches: BATCHES })).toThrow(/kebab-case/);
    expect(() => buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES, cap: 0 })).toThrow(/cap must be/);
    expect(() => buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: [BATCHES[0], BATCHES[0]] }))
      .toThrow(/duplicate batch id pkg\/a#0/);
  });
});

describe('campaignBatchesFromPlan', () => {
  it('reads back exactly the batches admission needs, in plan order', () => {
    const plan = buildCampaignPlan({ slug: 'cleanup-test-campaign', batches: BATCHES });
    expect(campaignBatchesFromPlan(plan.content)).toEqual(
      plan.batches.map(({ itemId, id, targetFiles, eject }) => ({ itemId, id, targetFiles, eject })));
  });

  it('refuses a plan with no batch block or a malformed row', () => {
    expect(() => campaignBatchesFromPlan('# x\n## Items\n')).toThrow(/no `campaign-batches` block/);
    expect(() => campaignBatchesFromPlan('```campaign-batches\n[{"id":"a"}]\n```')).toThrow(/row 0 is malformed/);
  });
});
