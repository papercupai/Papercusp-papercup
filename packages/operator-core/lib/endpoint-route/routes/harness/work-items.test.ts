/**
 * work-items route (P-010) — the pure `mergeWorkItemDimensions` overlay (P-010 v2):
 * plan-link + spine-position joined ROUTE-SIDE onto the unified work items, WITHOUT
 * widening the FEATURE_COLS facade (D-009). The SQL fetch is live-exercised; this pins
 * the merge logic (match by id, null/[] for unmatched + issue-family).
 */
import { describe, it, expect, vi } from 'vitest';
import type { RouteContext } from '@papercusp/tooldef';

const f = vi.hoisted(() => ({ list: vi.fn(), count: vi.fn() }));
vi.mock('../../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../work-items')>()),
  listWorkItems: f.list,
  countWorkItems: f.count,
}));

import routes, { __test } from './work-items';
import type { WorkItem } from '../../../work-items';

const { mergeWorkItemDimensions } = __test;
const listRoute = routes.find((route) => route.method === 'GET' && route.path === '/harness/:slug/work-items')!;

const wi = (id: string, family: 'feature' | 'issue'): WorkItem => ({
  id,
  kind: family === 'feature' ? 'feature' : 'bug',
  family,
  harness: 'h',
  title: `title ${id}`,
  summary: '',
  state: 'todo',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  goalId: null,
  completionAuthority: null,
  severity: null,
  parent: null,
  payload: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  origin: 'local',
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  createdAt: '',
  updatedAt: '',
  closedAt: null,
});

describe('mergeWorkItemDimensions (P-010 v2 — route-side plan-link + spine join)', () => {
  it('overlays plan-link + spine onto matching feature items; null/[] for unmatched + issues', () => {
    const items = [wi('F-1', 'feature'), wi('F-2', 'feature'), wi('EI-9', 'issue')];
    const planMap = new Map([['F-1', { planSlug: 'my-plan', planItemIds: ['P-001', 'P-002'] }]]);
    const spineMap = new Map([['F-1', { role: 'worker', status: 'running' }]]);

    const byId = Object.fromEntries(mergeWorkItemDimensions(items, planMap, spineMap).map((o) => [o.id, o]));

    // F-1 enriched with both dimensions
    expect(byId['F-1'].planSlug).toBe('my-plan');
    expect(byId['F-1'].planItemIds).toEqual(['P-001', 'P-002']);
    expect(byId['F-1'].spineRole).toBe('worker');
    expect(byId['F-1'].spineStatus).toBe('running');
    // F-2: feature with no plan/spine row → nulls + []
    expect(byId['F-2'].planSlug).toBeNull();
    expect(byId['F-2'].planItemIds).toEqual([]);
    expect(byId['F-2'].spineRole).toBeNull();
    expect(byId['F-2'].spineStatus).toBeNull();
    // issue-family: never has plan-link / spine
    expect(byId['EI-9'].planSlug).toBeNull();
    expect(byId['EI-9'].spineRole).toBeNull();
    // base WorkItem fields preserved
    expect(byId['F-1'].kind).toBe('feature');
    expect(byId['EI-9'].family).toBe('issue');
  });

  it('returns one enriched item per input in order; empty maps → all-null dims', () => {
    const items = [wi('F-1', 'feature'), wi('EI-2', 'issue')];
    const out = mergeWorkItemDimensions(items, new Map(), new Map());
    expect(out.map((o) => o.id)).toEqual(['F-1', 'EI-2']);
    expect(out.every((o) => o.planItemIds.length === 0 && o.spineRole === null && o.planSlug === null)).toBe(true);
  });
});

describe('Work Items queue nature boundary', () => {
  it('keeps explicit-kind rows and their total restricted to nature=work', async () => {
    f.list.mockResolvedValue([]);
    f.count.mockResolvedValue(0);
    const ctx = { params: { slug: 'nature-test' }, log() {} } as unknown as RouteContext;
    const response = await listRoute.handler(
      new Request('http://localhost/api/harness/nature-test/work-items?kind=feature'),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ harness: 'nature-test', count: 0, total: 0, workItems: [] });
    expect(f.list).toHaveBeenCalledWith(expect.objectContaining({
      harness: 'nature-test',
      kind: 'feature',
      natures: ['work'],
    }));
    expect(f.count).toHaveBeenCalledWith(expect.objectContaining({
      harness: 'nature-test',
      kind: 'feature',
      natures: ['work'],
    }));
  });
});
