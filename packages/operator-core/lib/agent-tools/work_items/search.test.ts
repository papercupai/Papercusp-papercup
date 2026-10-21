import { describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  searchWorkItems: vi.fn(),
}));

import { emptyLegs } from '@papercusp/search';
import { getWorkItem, searchWorkItems } from '../../work-items';
import { mockResolvedOnceTyped } from '../../testing/typed-mock';
import search, { projectWorkItemSearchMatch, shapeWorkItemsSearch } from './search';

const searchMock = vi.mocked(searchWorkItems);

const workItem = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'EI-1',
    kind: 'bug',
    family: 'issue',
    harness: 'papercusp',
    title: 'A useful title',
    summary: 'A useful summary',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'minor',
    goalId: null,
    parent: null,
    payload: { giant: 'do not send this on every search hit' },
    origin: 'local',
    auditVerdict: null,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  }) as never;

describe('work_items:search transaction scope', () => {
  it('preserves work-items exports used by neighboring modules', () => {
    expect(typeof getWorkItem).toBe('function');
  });

  it('opts out of the ambient workspace transaction because search owns its DB scopes', () => {
    expect((search as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('work_items:search argument contract', () => {
  it('documents and enforces the required query-only input', () => {
    const args = search.args as {
      safeParse: (value: unknown) => { success: boolean };
      shape?: { query?: { description?: string } };
    };

    expect(args.safeParse({ q: 'legacy alias' }).success).toBe(false);
    expect(args.safeParse({ query: 'canonical input' }).success).toBe(true);
    expect(args.shape?.query?.description).toMatch(/use `query`.*`q` is not an alias/i);
  });
});

describe('work_items:search bounded result projection', () => {
  it('returns a compact match row and leaves detail payloads to work_items:get', () => {
    const match = projectWorkItemSearchMatch(
      workItem({ title: 'T'.repeat(300), summary: 'S'.repeat(400), payload: { evidence: 'x'.repeat(20_000) } }),
    );

    expect(match).toMatchObject({
      id: 'EI-1',
      kind: 'bug',
      family: 'issue',
      harness: 'papercusp',
      state: 'open',
      severity: 'minor',
      title_truncated: true,
      summary_truncated: true,
      title_full_chars: 300,
      summary_full_chars: 400,
    });
    expect(match.title.length).toBeLessThanOrEqual(180);
    expect(match.summary.length).toBeLessThanOrEqual(240);
    expect(match).not.toHaveProperty('payload');
    expect(JSON.stringify(match).length).toBeLessThan(1_000);
  });

  it('makes tier truncation explicit when a large result page is projected', () => {
    const data = {
      ok: true,
      count: 25,
      items: Array.from({ length: 25 }, (_, i) => projectWorkItemSearchMatch(workItem({ id: `EI-${i}` }))),
      legs: { degraded: false },
    };

    const shaped = shapeWorkItemsSearch(data, 'trimmed') as Record<string, unknown>;
    expect((shaped.items as unknown[]).length).toBe(20);
    expect(shaped).toMatchObject({ count: 25, returnedCount: 20, truncated: true });
    expect(shaped.note).toMatch(/narrow the query|work_items:get/);
  });

  it('returns structured data so the framework can shape the handler result', async () => {
    mockResolvedOnceTyped(searchMock, {
      items: [workItem({ summary: 'summary' })],
      // emptyLegs() rather than a hand-written `{ degraded: false }`: it is the library's own
      // typed factory, so this fixture cannot drift when a leg field is added (which is exactly
      // the strand the `as never` cast used to hide from tsc).
      legs: emptyLegs(),
      applied: { minScore: null, recency: false, policyRegistered: false },
    });

    const result = (await search.handler({ query: 'summary', semantic: false } as never, {} as never)) as {
      data: { ok: boolean; count: number; items: Array<Record<string, unknown>>; legs: unknown };
    };
    expect(result.data).toMatchObject({ ok: true, count: 1, legs: { degraded: false }, retryable: false });
    expect(result.data.items[0]).not.toHaveProperty('payload');
    expect(result.data.items[0]).toMatchObject({ id: 'EI-1', title: 'A useful title' });
  });

  it('includes draft plan items directly and preserves their label when compacted', async () => {
    mockResolvedOnceTyped(searchMock, {
      items: [], discovery: [{ id: 'papercusp:optional-evaluations#P-005', kind: 'plan_item', family: 'plan',
        harness: 'papercusp', title: 'Duplicate mechanism discovery', summary: 'Optional evaluations',
        state: 'todo', severity: null, planStatus: 'draft', planSlug: 'optional-evaluations', planItemId: 'P-005' }],
      legs: emptyLegs(),
      applied: { minScore: null, recency: false, policyRegistered: false },
    });
    const result = await search.handler({ query: 'duplicate discovery' } as never, {} as never) as {
      data: { count: number; retryable: boolean; items: Array<Record<string, unknown>> };
    };
    expect(searchMock).toHaveBeenLastCalledWith('duplicate discovery', expect.objectContaining({ includeDraftPlans: true }));
    expect(result.data).toMatchObject({ count: 1, retryable: false });
    expect(result.data.items[0]).toMatchObject({ kind: 'plan_item', planStatus: 'draft', planItemId: 'P-005', state: 'todo' });
    expect(result.data).not.toHaveProperty('plan_scope_hint');
    const shaped = shapeWorkItemsSearch(result.data, 'trimmed') as typeof result.data;
    expect(shaped.items[0]).toMatchObject({ planStatus: 'draft', planItemId: 'P-005' });
  });

  it('marks degraded searches retryable instead of presenting count zero as verified empty', async () => {
    mockResolvedOnceTyped(searchMock, {
      items: [],
      legs: { ...emptyLegs(), degraded: true, warning: 'semantic leg blocked: query embedder warming up' },
      applied: { minScore: null, recency: false, policyRegistered: false },
    });

    const result = (await search.handler({ query: 'cross-word duplicate', semantic: true } as never, {} as never)) as {
      data: { ok: boolean; count: number; items: Array<Record<string, unknown>>; retryable: boolean };
    };
    expect(result.data).toMatchObject({ ok: true, count: 0, items: [], retryable: true });
  });

  it('preserves the stable warmup retry receipt for degraded dedup searches', async () => {
    mockResolvedOnceTyped(searchMock, {
      items: [],
      legs: { ...emptyLegs(), degraded: true, warning: 'semantic leg blocked: query embedder warming up' },
      applied: { minScore: null, recency: false, policyRegistered: false },
      retry: { token: 'work-items-embedder-warmup:0:1', afterMs: 1_000, reason: 'query_embedder_warming' },
    });

    const result = (await search.handler({ query: 'same blocker' } as never, {} as never)) as {
      data: { retry?: { token: string; afterMs: number; reason: string } };
    };
    expect(result.data.retry).toEqual({
      token: 'work-items-embedder-warmup:0:1',
      afterMs: 1_000,
      reason: 'query_embedder_warming',
    });
  });
});
