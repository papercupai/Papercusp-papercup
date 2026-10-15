/**
 * _create-core.plan-item-stamp.test — EI-19390496242545842.
 *
 * `targetPlanItem` (the `plan_item:{slug,item}` create arg) used to write ONLY the
 * coord_links coverage edge (`linkWorkItem(..., 'relates')`) — but
 * `work_items:complete`'s plan-item auto-flip (`synchronizeFinishWork` →
 * `finishPlanStamp`) reads a completely SEPARATE mechanism: a `payload.plan_item`
 * STAMP shaped `{ plan_slug, item_id, harness_slug }`. Every other path that mints a
 * work-item FOR a plan item (plan-run scheduled minting, plan launch/promotion,
 * convert-at-pickup) writes this stamp; `createOneWorkItem` never did, so an item
 * created via `work_items:create { plan_item }` could never auto-flip its plan
 * item's status at completion — `work_items:complete` always reported
 * `planItem:'not-linked'`, regardless of whether the coverage edge succeeded.
 *
 * These pin the fix: `createOneWorkItem` now ALSO stamps `payload.plan_item` when
 * `targetPlanItem` is set, using the SAME shape `plan-workitem-promotion-run.ts` /
 * `plan-items/convert.ts` already write — so `work_items:complete` can find it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
const createWorkItemMock = vi.fn(async (input: { kind: string; title: string; harness?: string; payload?: Record<string, unknown> }) => ({
  id: 'WI-NEW',
  kind: input.kind,
  title: input.title,
  harness: input.harness ?? null,
  payload: input.payload,
}));
const linkWorkItemMock = vi.fn(async (...args: unknown[]) => {});
let planItemRows: Array<{ planSlug: string; itemId: string; status: string }> = [];
const getPlanItemRowMock = vi.fn(async (slug: string) => {
  const rows = planItemRows.filter((row) => row.planSlug === slug);
  if (rows.length === 0) return null;
  return {
    planSlug: slug,
    archived: false,
    isLegacy: false,
    content: '',
    items: rows.map((row) => ({
      id: row.itemId,
      status: row.status,
      text: '',
      importance: '',
      blockedBy: [],
      decisionRefs: [],
      phase: null,
    })),
  } as never;
});
let planCollisionRows: Array<{ feature_id: string; status: string }> = [];
const sqlQueryMock = vi.fn(async (strings: readonly string[], ..._args: unknown[]) =>
  strings.join('').includes('SELECT wi.feature_id, wi.status') ? planCollisionRows : [],
);
const sqlMock = Object.assign(sqlQueryMock, {
  begin: vi.fn(async <T>(transaction: (sql: typeof sqlQueryMock) => Promise<T>) => transaction(sqlQueryMock)),
});
vi.mock('../../work-items', () => ({
  createWorkItem: (...args: unknown[]) => createWorkItemMock(...(args as [never])),
  getWorkItem: vi.fn(async () => null),
  linkWorkItem: (...args: unknown[]) => linkWorkItemMock(...(args as [never])),
  isWorkItemKind: (k: string) => ['feature', 'chunk', 'bug', 'change', 'task'].includes(k),
  isDeprecatedWorkItemKind: (k: string) => k === 'chunk',
  familyOf: (k: string) => (['bug', 'change', 'task'].includes(k) ? 'issue' : 'feature'),
  ensureClaimHoldAttribution: (payload: unknown) => payload,
}));
vi.mock('./mirror-guard', () => ({ findMirroredOpenItem: vi.fn(async () => null) }));
vi.mock('../_pot-scope', () => ({
  resolvePotScope: vi.fn(async () => ({ kind: 'pot', slug: 'papercusp' })),
  POT_REQUIRED_DETAIL: 'hive required',
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../../datatype-registry-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datatype-registry-store')>()),
  getGenericKindDatatype: vi.fn(async () => null),
  getDatatype: vi.fn(async () => null),
}));
vi.mock('../../datatype-payload-validation', () => ({ validateDatatypePayload: () => ({ ok: true as const }) }));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));
vi.mock('../../issue-blocks-merge', () => ({ planItemRef: (s: string, i: string) => `${s}#${i}`, PLAN_ITEM_KIND: 'plan_item' }));
vi.mock('../plans/source', () => ({ getPlanItemRow: (slug: string) => getPlanItemRowMock(slug) }));
vi.mock('./semantic-dupe-guard', () => ({ findSemanticDupes: vi.fn(async () => null) }));
vi.mock('./recent-lexical-dupe-guard', () => ({ findRecentLexicalDupes: vi.fn(async () => null) }));
vi.mock('./fulltext-lexical-dupe-guard', () => ({ findFulltextLexicalDupes: vi.fn(async () => null) }));

import { createOneWorkItem } from './_create-core';

const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

beforeEach(() => {
  createWorkItemMock.mockClear();
  linkWorkItemMock.mockClear();
  sqlMock.mockClear();
  sqlMock.begin.mockClear();
  planCollisionRows = [];
  planItemRows = [
    { planSlug: 'some-plan', itemId: 'P-413', status: 'todo' },
    { planSlug: 'caller-plan', itemId: 'P-999', status: 'todo' },
  ];
  getPlanItemRowMock.mockClear();
});

describe('createOneWorkItem × plan-item finish stamp (EI-19390496242545842)', () => {
  it('stamps payload.plan_item when targetPlanItem is set, so work_items:complete can find it', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'fix the thing',
        harness: 'papercusp',
        targetPlanItem: { slug: 'some-plan', itemId: 'P-413' },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as {
      payload?: { plan_item?: unknown };
      admission?: string;
      admittedBy?: string | null;
    };
    expect(call.payload?.plan_item).toEqual({
      plan_slug: 'some-plan',
      item_id: 'P-413',
      harness_slug: 'papercusp',
    });
    expect((createWorkItemMock.mock.calls[0][0] as { sourcePlanSlug?: string }).sourcePlanSlug).toBe('some-plan');
    expect((createWorkItemMock.mock.calls[0][0] as { sourcePlanItemIds?: string[] }).sourcePlanItemIds).toEqual(['P-413']);
    expect(call.admission).toBe('auto');
    expect(call.admittedBy).toBe('bypass:plan-item');
    // The coverage edge is STILL written too — this fix is additive, not a replacement.
    expect(linkWorkItemMock).toHaveBeenCalledWith(
      'WI-NEW',
      { kind: 'plan_item', ref: 'some-plan#P-413' },
      'relates',
      expect.objectContaining({ harness: 'papercusp' }),
    );
  });

  it('falls back to ctx.harnessSlug for harness_slug when no explicit harness arg is passed', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'fix the thing', targetPlanItem: { slug: 'some-plan', itemId: 'P-413' } },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { plan_item?: unknown } };
    expect(call.payload?.plan_item).toEqual({
      plan_slug: 'some-plan',
      item_id: 'P-413',
      harness_slug: 'papercusp', // ctx.harnessSlug
    });
  });

  it('never stamps plan_item when targetPlanItem is not set', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: 'unrelated fix' }, ctx);
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as {
      payload?: { plan_item?: unknown };
      admission?: string;
      admittedBy?: string | null;
    };
    expect(call.payload?.plan_item).toBeUndefined();
    expect(call.admission).toBe('pending');
    expect(call.admittedBy).toBeNull();
  });

  it('never clobbers an explicit caller-supplied payload.plan_item', async () => {
    const explicitStamp = { plan_slug: 'caller-plan', item_id: 'P-999', harness_slug: 'other-harness' };
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'fix the thing',
        harness: 'papercusp',
        payload: { plan_item: explicitStamp },
        targetPlanItem: { slug: 'some-plan', itemId: 'P-413' },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { plan_item?: unknown } };
    expect(call.payload?.plan_item).toEqual(explicitStamp);
  });

  it('preserves other payload keys alongside the stamp', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'fix the thing',
        harness: 'papercusp',
        payload: { severity_hint: 'high' },
        targetPlanItem: { slug: 'some-plan', itemId: 'P-413' },
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const call = createWorkItemMock.mock.calls[0][0] as { payload?: { severity_hint?: string; plan_item?: unknown } };
    expect(call.payload?.severity_hint).toBe('high');
    expect(call.payload?.plan_item).toEqual({
      plan_slug: 'some-plan',
      item_id: 'P-413',
      harness_slug: 'papercusp',
    });
  });

  it('rejects a caller-supplied payload.plan_item when an open canonical row covers the same lane', async () => {
    planCollisionRows = [{ feature_id: 'WI-EXISTING', status: 'wip' }];

    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'duplicate lane work',
        harness: 'papercusp',
        payload: { plan_item: { plan_slug: 'some-plan', item_id: 'P-413', harness_slug: 'papercusp' } },
      },
      ctx,
    );

    expect(r).toEqual({
      ok: false,
      error: 'duplicate_plan_item',
      message: expect.stringContaining('WI-EXISTING'),
      existing: { id: 'WI-EXISTING', state: 'wip' },
    });
    expect(createWorkItemMock).not.toHaveBeenCalled();
    const query = sqlMock.mock.calls.map(([strings]) => strings.join('')).join('\n');
    expect(query).toContain('source_plan_slug');
    expect(query).toContain("payload->'plan_item'");
  });

  it('allows a payload.plan_item whose only existing history is terminal', async () => {
    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'follow up completed lane',
        harness: 'papercusp',
        payload: { plan_item: { plan_slug: 'some-plan', item_id: 'P-413', harness_slug: 'papercusp' } },
      },
      ctx,
    );

    expect(r.ok).toBe(true);
    expect(createWorkItemMock).toHaveBeenCalledTimes(1);
    const query = sqlMock.mock.calls.map(([strings]) => strings.join('')).join('\n');
    expect(query).toContain('NOT (wi.status = ANY(');
  });

  it.each(['done', 'dropped'])('refuses a %s plan item at create time', async (status) => {
    planItemRows[0] = { planSlug: 'some-plan', itemId: 'P-413', status };

    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'work for a terminal plan item',
        harness: 'papercusp',
        targetPlanItem: { slug: 'some-plan', itemId: 'P-413' },
      },
      ctx,
    );

    expect(r).toMatchObject({ ok: false, error: 'terminal_plan_item' });
    if (!r.ok) expect(r.message).toContain('status=' + status);
    expect(createWorkItemMock).not.toHaveBeenCalled();
  });

  it('rejects a terminal explicit payload stamp even when targetPlanItem is absent', async () => {
    planItemRows[0] = { planSlug: 'some-plan', itemId: 'P-413', status: 'done' };

    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'work for a terminal plan item',
        harness: 'papercusp',
        payload: {
          plan_item: { plan_slug: 'some-plan', item_id: 'P-413', harness_slug: 'papercusp' },
        },
      },
      ctx,
    );

    expect(r).toMatchObject({ ok: false, error: 'terminal_plan_item' });
    expect(createWorkItemMock).not.toHaveBeenCalled();
  });

  it('fails closed when the plan item cannot be read', async () => {
    getPlanItemRowMock.mockRejectedValueOnce(new Error('plan reader unavailable'));

    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'work for an unreadable plan item',
        harness: 'papercusp',
        targetPlanItem: { slug: 'some-plan', itemId: 'P-413' },
      },
      ctx,
    );

    expect(r).toMatchObject({ ok: false, error: 'plan_item_status_unavailable' });
    expect(createWorkItemMock).not.toHaveBeenCalled();
  });

  it('rejects a plan item id absent from the resolved plan', async () => {
    planItemRows = [];

    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'work for a missing plan item',
        harness: 'papercusp',
        targetPlanItem: { slug: 'some-plan', itemId: 'P-413' },
      },
      ctx,
    );

    expect(r).toMatchObject({ ok: false, error: 'plan_item_not_found' });
    expect(createWorkItemMock).not.toHaveBeenCalled();
  });
});
