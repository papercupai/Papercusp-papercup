/**
 * get-item.test.ts — the plans:get-item HANDLER, bulk keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Pins: the inline { slug, item }
 * single form → one result; itemIds:[…] (one plan) + items:[…] (cross-plan) fan-out;
 * a missing item / missing plan → that item's { ok:false } WITHOUT failing the batch;
 * and that the per-slug row fetch is memoized across the batch.
 *
 * The plan-source layer is mocked so this runs as a pure unit test (no PG).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/get-item.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: vi.fn(async () => ({})) }));
// Keep the real `harnessArg` zod schema; only stub `harnessScopedCtx` so the test
// ctx (which carries no harnessSlug) does not trip the harness-required gate.
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_h: unknown, ctx: unknown) => ctx),
}));
vi.mock('./slug-scope', () => ({
  recoverHarnessFromSlugs: vi.fn(async (_ctx: unknown, slugs: string[]) => ({
    status: 'resolved',
    harnessSlug: 'papercusp',
    bySlug: Object.fromEntries(slugs.map((slug) => [slug, 'papercusp'])),
  })),
  slugScopeErrorResult: vi.fn(),
}));
vi.mock('./source', () => ({ getPlanItemRow: vi.fn(), planItemsForRow: (row: { items: unknown[] }) => row.items }));
vi.mock('./effective-status', () => ({
  // pass the items through unchanged (effectiveStatus resolution is tested elsewhere)
  resolveEffectiveStatusForItems: (items: unknown[]) => ({ items }),
}));
vi.mock('../../issue-blocks-merge', () => ({
  getAllBlockedPlanItems: vi.fn(async () => new Map()),
  applyPlanItemBlocks: (items: unknown[]) => ({ items, blockingIssues: {} }),
  planItemRef: (slug: string, id: string) => `${slug}#${id}`,
}));

import { getPlanItemRow } from './source';
import { harnessScopedCtx } from '../_harness-scope';
import { recoverHarnessFromSlugs } from './slug-scope';
const getRowM = vi.mocked(getPlanItemRow);
const scopeM = vi.mocked(harnessScopedCtx);
const recoverM = vi.mocked(recoverHarnessFromSlugs);
const tool = (await import('./get-item')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  (((await tool.handler(args as never, {} as never)) as Out).data);

// A minimal PlanRow stub carrying the items the handler reads.
const rowOf = (slug: string, ids: string[]) =>
  ({
    planSlug: slug,
    isLegacy: false,
    archived: false,
    items: ids.map((id) => ({ id, storedStatus: 'todo', effectiveStatus: 'todo' })),
  }) as never;

beforeEach(() => vi.clearAllMocks());

describe('plans:get-item handler (bulk keyed-array)', () => {
  it('uses the item-index projection instead of fetching a full plan row', async () => {
    getRowM.mockResolvedValue(rowOf('plan-a', ['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(getRowM).toHaveBeenCalledTimes(1);
  });

  it('inline { slug, item } returns a single result', async () => {
    getRowM.mockResolvedValue(rowOf('plan-a', ['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, slug: 'plan-a', itemId: 'P-001', item: { id: 'P-001' } });
  });

  it('rejects `itemId` — the input vocabulary is `item`, with no compatibility alias', () => {
    // EI-21901062936431252 briefly ACCEPTED `itemId` here as an alias, because
    // plans:audit keys its per-item entries `itemId` and a caller reasonably reused
    // that spelling. It was removed: the ratified alpha policy (P-005 / EI-11400,
    // enforced for this exact tool by semantic-argument-vocabulary.test.ts) is "a
    // breaking rename, not a compatibility-alias layer" — one public spelling, strict
    // rejection, and define-tool's did-you-mean hint teaches the correction. The two
    // tests could not both pass, so the tree sat red until this one was inverted.
    // The friction is real; its cause is plans:audit's own `itemId` spelling, tracked
    // separately rather than papered over one tool at a time.
    expect(tool.args.safeParse({ slug: 'plan-a', itemId: 'P-001' }).success).toBe(false);
    expect(tool.args.safeParse({ slug: 'plan-a', item: 'P-001' }).success).toBe(true);
    // Neither form present is still a validation error (the original combined check).
    expect(tool.args.safeParse({ slug: 'plan-a' }).success).toBe(false);
  });

  it('auto-resolves the owning harness for an exact slug when ambient scope is absent', async () => {
    getRowM.mockResolvedValue(rowOf('plan-a', ['P-001']));
    const b = await body({ slug: 'plan-a', item: 'P-001' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(recoverM).toHaveBeenCalledWith({}, ['plan-a']);
    expect(scopeM).toHaveBeenCalledWith('papercusp', {});
  });

  it('itemIds:[…] reads many of one plan; a missing item fails only itself', async () => {
    getRowM.mockResolvedValue(rowOf('plan-a', ['P-001', 'P-002']));
    const b = await body({ slug: 'plan-a', itemIds: ['P-001', 'P-099', 'P-002'] });
    expect(b.ok).toBe(false); // DERIVED from counts.failed — P-099 failed
    expect(b.results).toHaveLength(3); // …but the batch still RAN, all 3 items attempted
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: { itemId: string; ok: boolean }) => [r.itemId, r.ok])).toEqual([
      ['P-001', true],
      ['P-099', false],
      ['P-002', true],
    ]);
    expect(recoverM).toHaveBeenCalledWith({}, ['plan-a']);
    expect(scopeM).toHaveBeenCalledWith('papercusp', {});
    expect(b.results[1]).toMatchObject({ ok: false, slug: 'plan-a', itemId: 'P-099', error: 'item_not_found' });
    // the per-slug row is fetched ONCE for all three items
    expect(getRowM).toHaveBeenCalledTimes(1);
  });

  it('a missing plan maps to not_found per item (batch survives)', async () => {
    getRowM.mockImplementation(async (slug: string) => (slug === 'gone' ? null : rowOf(slug, ['P-001'])));
    const b = await body({ items: [{ slug: 'plan-a', item: 'P-001' }, { slug: 'gone', item: 'P-001' }] });
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, slug: 'gone', itemId: 'P-001', error: 'not_found' });
  });

  it('items:[…] cross-plan keeps each result keyed by { slug, itemId }', async () => {
    getRowM.mockImplementation(async (slug: string) => rowOf(slug, ['P-001']));
    const b = await body({ items: [{ slug: 'plan-a', item: 'P-001' }, { slug: 'plan-b', item: 'P-001' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { slug: string }) => r.slug)).toEqual(['plan-a', 'plan-b']);
    expect(getRowM).toHaveBeenCalledTimes(2); // distinct slugs → distinct fetches
  });

  it('a legacy plan maps to legacy_plan per item', async () => {
    getRowM.mockResolvedValue({ planSlug: 'plan-a', isLegacy: true } as never);
    const b = await body({ slug: 'plan-a', item: 'P-001' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, error: 'legacy_plan' });
  });
});
