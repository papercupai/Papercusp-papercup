/**
 * scope-unique-identifiers-2026-07-26 P-004: a `plan:<slug>#P-NNN` ref that crosses a
 * plan boundary (coord:dispatch / coord:handoff / carry-brief all hydrate it through
 * makePlanItemResolver) names the workspace-unique work-item the item resolves through,
 * using the SAME fold plans:items prints as `workItemId` (linkedFieldsFromCoverage).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  getAllPlanItemCoverage: vi.fn(),
  getPlanRow: vi.fn(),
}));

vi.mock('./plan-item-coverage', async (orig) => ({
  ...(await orig<typeof import('./plan-item-coverage')>()),
  getAllPlanItemCoverage: M.getAllPlanItemCoverage,
}));
vi.mock('./agent-tools/plans/source', async (orig) => ({
  ...(await orig<typeof import('./agent-tools/plans/source')>()),
  getPlanRow: M.getPlanRow,
  planItemsForRow: (row: { items: unknown[] }) => row.items,
}));
vi.mock('./agent-tools/plans/effective-status', () => ({
  resolveEffectiveStatusForItems: (items: Array<{ id: string; status: string }>) => ({
    items: items.map((item) => ({ ...item, effectiveStatus: item.status })),
  }),
}));

import { STAMP_ONLY_REL } from './plan-item-coverage';
import { PLAN_ITEM_IMPLEMENTS_REL } from './plan-item-linked-work-item';
import {
  linkedFieldsFromCoverage,
  readPlanItemLinkedWorkItem,
  renderLinkedWorkItemSuffix,
} from './plan-item-linked-work-item-read';
import { makePlanItemResolver } from './agent-tools/coordination/ref-hydrate-resolve';
import { DEFAULT_REF_BUDGET } from './agent-tools/coordination/ref-hydrate';

const link = (workItemId: string, rel: string, terminal = false) => ({ workItemId, rel, terminal });
const coverageOf = (ref: string, links: ReturnType<typeof link>[]) =>
  new Map([[ref, { ref, links, directlyClaimed: false }]]);

beforeEach(() => {
  M.getAllPlanItemCoverage.mockReset();
  M.getPlanRow.mockReset();
});

describe('linkedFieldsFromCoverage', () => {
  it('counts only identity edges (implements + the plan_item stamp), never fixes/relates/duplicates', () => {
    expect(
      linkedFieldsFromCoverage({
        links: [
          link('WI-1', PLAN_ITEM_IMPLEMENTS_REL),
          link('EI-2', 'fixes'),
          link('EI-3', 'relates'),
          link('EI-4', 'duplicates'),
        ],
      }),
    ).toEqual({ workItemId: 'WI-1', workItemIds: ['WI-1'] });
    expect(linkedFieldsFromCoverage({ links: [link('WI-9', STAMP_ONLY_REL, true)] })).toEqual({
      workItemId: 'WI-9',
      workItemIds: ['WI-9'],
    });
  });

  it('reads no coverage as unlinked', () => {
    expect(linkedFieldsFromCoverage(undefined)).toEqual({ workItemId: null, workItemIds: [] });
    expect(linkedFieldsFromCoverage({ links: [link('EI-2', 'fixes')] })).toEqual({ workItemId: null, workItemIds: [] });
  });
});

describe('readPlanItemLinkedWorkItem', () => {
  it('reads exactly the one plan-item ref and folds its links', async () => {
    M.getAllPlanItemCoverage.mockResolvedValue(
      coverageOf('plan-a#P-003', [link('WI-30', PLAN_ITEM_IMPLEMENTS_REL, true), link('WI-31', PLAN_ITEM_IMPLEMENTS_REL)]),
    );
    await expect(readPlanItemLinkedWorkItem('plan-a', 'P-003')).resolves.toEqual({
      workItemId: 'WI-31',
      workItemIds: ['WI-31', 'WI-30'],
    });
    expect(M.getAllPlanItemCoverage).toHaveBeenCalledWith({ planItemRefs: ['plan-a#P-003'] });
  });
});

describe('renderLinkedWorkItemSuffix', () => {
  it('names one work-item, reports several, and adds nothing when unlinked', () => {
    expect(renderLinkedWorkItemSuffix({ workItemId: 'WI-7', workItemIds: ['WI-7', 'WI-6'] })).toBe(' → WI-7');
    expect(renderLinkedWorkItemSuffix({ workItemId: null, workItemIds: ['WI-1', 'WI-2'] })).toBe(' → one of WI-1, WI-2');
    expect(renderLinkedWorkItemSuffix({ workItemId: null, workItemIds: [] })).toBe('');
  });
});

describe('makePlanItemResolver — cross-plan plan-item refs resolve through the linked work-item (P-004)', () => {
  const planRow = { items: [{ id: 'P-004', status: 'wip', text: 'make refs resolve' }] };
  const resolve = () =>
    makePlanItemResolver('papercusp')({ kind: 'plan-item', slug: 'plan-a', item: 'P-004' }, DEFAULT_REF_BUDGET);

  it('appends the single resolvable work-item id to the label', async () => {
    M.getPlanRow.mockResolvedValue(planRow);
    M.getAllPlanItemCoverage.mockResolvedValue(
      coverageOf('plan-a#P-004', [link('WI-10008273', PLAN_ITEM_IMPLEMENTS_REL)]),
    );
    await expect(resolve()).resolves.toEqual({
      label: 'plan:plan-a#P-004 [wip] → WI-10008273',
      snippet: 'make refs resolve',
    });
    expect(M.getPlanRow).toHaveBeenCalledWith('plan-a', { harnessSlug: 'papercusp' });
  });

  it('reports every candidate when several live work-items qualify', async () => {
    M.getPlanRow.mockResolvedValue(planRow);
    M.getAllPlanItemCoverage.mockResolvedValue(
      coverageOf('plan-a#P-004', [link('WI-2', PLAN_ITEM_IMPLEMENTS_REL), link('WI-1', STAMP_ONLY_REL)]),
    );
    expect((await resolve())?.label).toBe('plan:plan-a#P-004 [wip] → one of WI-1, WI-2');
  });

  it('keeps the original label when the item has no linked work-item', async () => {
    M.getPlanRow.mockResolvedValue(planRow);
    M.getAllPlanItemCoverage.mockResolvedValue(new Map());
    expect((await resolve())?.label).toBe('plan:plan-a#P-004 [wip]');
  });

  // D-013: P-NNN is unique only inside its plan, so <slug>#P-NNN resolves within ITS plan.
  it('D-013: resolves within its own plan when another plan has a same-numbered item', async () => {
    M.getPlanRow.mockResolvedValue(planRow);
    M.getAllPlanItemCoverage.mockResolvedValue(
      new Map([
        ...coverageOf('plan-b#P-004', [link('WI-99', PLAN_ITEM_IMPLEMENTS_REL)]),
        ...coverageOf('plan-a#P-004', [link('WI-1', PLAN_ITEM_IMPLEMENTS_REL)]),
      ]),
    );
    expect((await resolve())?.label).toBe('plan:plan-a#P-004 [wip] → WI-1');
    expect(M.getAllPlanItemCoverage).toHaveBeenCalledWith({ planItemRefs: ['plan-a#P-004'] });
    expect(M.getPlanRow).toHaveBeenCalledWith('plan-a', { harnessSlug: 'papercusp' });
  });

  it('D-013 control: a same-numbered item in another plan never lends its work-item', async () => {
    M.getPlanRow.mockResolvedValue(planRow);
    M.getAllPlanItemCoverage.mockResolvedValue(
      coverageOf('plan-b#P-004', [link('WI-99', PLAN_ITEM_IMPLEMENTS_REL)]),
    );
    expect((await resolve())?.label).toBe('plan:plan-a#P-004 [wip]');
  });

  it('fails soft: a coverage read error never drops the hydration', async () => {
    M.getPlanRow.mockResolvedValue(planRow);
    M.getAllPlanItemCoverage.mockRejectedValue(new Error('coverage down'));
    expect((await resolve())?.label).toBe('plan:plan-a#P-004 [wip]');
  });
});
