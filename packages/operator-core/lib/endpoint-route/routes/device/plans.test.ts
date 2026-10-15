import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({
  listPlanIndexRows: vi.fn(),
  listPlanIndexRowsForWorkspace: vi.fn(),
  readPlanBySlug: vi.fn(),
  harnessExistsInWorkspace: vi.fn(),
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (definition: unknown) => definition,
  dispatchProjectedTool: vi.fn(),
  lookupByMcpName: vi.fn(),
}));
const blocks = vi.hoisted(() => ({
  getAllBlockedPlanItems: vi.fn(),
  overlayIssueBlocksForPlan: vi.fn(),
}));

vi.mock('../../../agent-tools/index', () => ({}));
// Keep the pure overlay + ref helpers real; stub only the two PG reads.
vi.mock('../../../issue-blocks-merge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../issue-blocks-merge')>()),
  ...blocks,
}));
vi.mock('../../../agent-tools/plans/source', () => source);
vi.mock('../../../device-harnesses', () => source);

import routes from './plans';
import { applyPlanItemBlocks, planItemRef } from '../../../issue-blocks-merge';

const list = routes[0] as unknown as {
  handler: (req: Request, ctx: { principal: { kind: string; slug: string; workspaceId: string } }) => Promise<Response>;
};
const context = { principal: { kind: 'device', slug: 'phone-test', workspaceId: 'paired-workspace' } };
const row = (slug: string, updatedAt: string, harnessSlug = 'hive-home') => ({
  planSlug: slug, harnessSlug, updatedAt, title: null, status: null,
  updated: null, owner: null, archived: false,
  items: [
    { id: 'P-001', status: 'done', blockedBy: [] },
    { id: 'P-002', status: 'todo', blockedBy: [] },
    { id: 'P-003', status: 'todo', blockedBy: [] },
  ],
  nowState: 'Compatibility work', nowNext: 'Verify the candidate',
});

beforeEach(() => {
  vi.resetAllMocks();
  source.listPlanIndexRowsForWorkspace.mockResolvedValue([]);
  source.listPlanIndexRows.mockResolvedValue([]);
  source.harnessExistsInWorkspace.mockResolvedValue(true);
  blocks.getAllBlockedPlanItems.mockResolvedValue(new Map());
  blocks.overlayIssueBlocksForPlan.mockImplementation(async (_slug: string, items: { id: string; effectiveStatus: string }[]) =>
    ({ items, blockingIssues: {} }));
});

describe('device plans list', () => {
  it.each(['', '?harness=all', '?harness=*'])('reads the paired workspace index once for All Pots %s', async (query) => {
    source.listPlanIndexRowsForWorkspace.mockResolvedValue([
      row('older', '2026-08-01'), row('newer', '2026-10-01'),
    ]);
    const response = await list.handler(new Request(`http://localhost/api/device/plans${query}`), context);
    expect(response.status).toBe(200);
    expect(source.listPlanIndexRowsForWorkspace).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'paired-workspace', includeArchived: false,
      includeInstances: true, heavyFields: true,
    });
    expect(source.listPlanIndexRows).not.toHaveBeenCalled();
    expect(source.harnessExistsInWorkspace).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.plans.map((p: { slug: string }) => p.slug)).toEqual(['newer', 'older']);
    expect(body.plans[0]).toEqual({
      slug: 'newer', harness: 'hive-home', title: 'newer', status: null,
      updated: '2026-10-01', owner: null, archived: false,
      itemCounts: { done: 1, todo: 2 },
      nowState: 'Compatibility work', nowNext: 'Verify the candidate',
    });
  });

  it('keeps archive selection and same-named plans from different Hive homes', async () => {
    source.listPlanIndexRowsForWorkspace.mockResolvedValue([
      row('release', '2026-10-01', 'home-a'), row('release', '2026-10-01', 'home-b'),
    ]);
    const response = await list.handler(new Request('http://localhost/api/device/plans?includeArchived=true'), context);
    expect(source.listPlanIndexRowsForWorkspace).toHaveBeenCalledWith(expect.objectContaining({ includeArchived: true }));
    expect((await response.json()).plans).toHaveLength(2);
  });

  it('pins a selected member pot to the paired workspace for canonical Hive resolution', async () => {
    source.listPlanIndexRows.mockResolvedValue([row('release', '2026-10-01')]);
    const response = await list.handler(new Request('http://localhost/api/device/plans?harness=member-pot'), context);
    expect(response.status).toBe(200);
    expect(source.harnessExistsInWorkspace).toHaveBeenCalledExactlyOnceWith('paired-workspace', 'member-pot');
    expect(source.listPlanIndexRows).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'paired-workspace', harnessSlug: 'member-pot', includeArchived: false,
      includeInstances: true, heavyFields: true,
    });
    expect(source.listPlanIndexRowsForWorkspace).not.toHaveBeenCalled();
  });

  it('rejects a foreign pot before querying its plans', async () => {
    source.harnessExistsInWorkspace.mockResolvedValue(false);
    const response = await list.handler(new Request('http://localhost/api/device/plans?harness=foreign-pot'), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'harness_not_in_workspace' });
    expect(source.listPlanIndexRows).not.toHaveBeenCalled();
    expect(source.listPlanIndexRowsForWorkspace).not.toHaveBeenCalled();
  });

  it('surfaces a failed source read instead of reporting a healthy empty workspace', async () => {
    source.listPlanIndexRowsForWorkspace.mockRejectedValue(new Error('plan index unavailable'));
    await expect(list.handler(new Request('http://localhost/api/device/plans'), context))
      .rejects.toThrow('plan index unavailable');
  });

  it('counts EFFECTIVE status: dependency blocks and open issue blocks, not the authored status', async () => {
    source.listPlanIndexRowsForWorkspace.mockResolvedValue([{
      ...row('release', '2026-10-01'),
      items: [
        { id: 'P-001', status: 'todo', blockedBy: [] },
        { id: 'P-002', status: 'todo', blockedBy: ['P-001'] },
        { id: 'P-003', status: 'todo', blockedBy: [] },
        { id: 'P-004', status: 'done', blockedBy: [] },
      ],
    }]);
    blocks.getAllBlockedPlanItems.mockResolvedValue(new Map([[planItemRef('release', 'P-003'), ['EI-9']]]));
    const response = await list.handler(new Request('http://localhost/api/device/plans'), context);
    expect((await response.json()).plans[0].itemCounts).toEqual({ todo: 1, blocked: 2, done: 1 });
    expect(blocks.getAllBlockedPlanItems).toHaveBeenCalledOnce();
  });

  it('degrades to resolver-only counts when the issue-block read fails', async () => {
    source.listPlanIndexRowsForWorkspace.mockResolvedValue([row('release', '2026-10-01')]);
    blocks.getAllBlockedPlanItems.mockRejectedValue(new Error('coord_links unavailable'));
    const response = await list.handler(new Request('http://localhost/api/device/plans'), context);
    expect(response.status).toBe(200);
    expect((await response.json()).plans[0].itemCounts).toEqual({ done: 1, todo: 2 });
  });
});

describe('device plan detail', () => {
  const get = routes[1] as unknown as {
    handler: (req: Request, ctx: typeof context & { params: { slug: string } }) => Promise<Response>;
  };
  const item = (id: string, storedStatus: string, blockedBy: string[] = []) => ({
    id, text: `item ${id}`, storedStatus, importance: 'normal', blockedBy,
    decisionRefs: [], phase: null, lineNumber: 0, rawLine: '',
  });

  it('returns effectiveStatus on every item so the iOS client stops defaulting to todo', async () => {
    source.readPlanBySlug.mockResolvedValue({
      archived: false,
      row: { planSlug: 'release', harnessSlug: 'hive-home', title: 'Release', status: 'active', owner: null },
      parsed: {
        frontmatter: {}, now: null, decisions: [],
        items: [item('P-001', 'wip'), item('P-002', 'todo', ['P-001']), item('P-003', 'todo'), item('P-004', 'done')],
      },
    });
    blocks.overlayIssueBlocksForPlan.mockImplementation(async (slug: string, items: { id: string; effectiveStatus: string }[]) =>
      applyPlanItemBlocks(items, (id) => (planItemRef(slug, id) === planItemRef('release', 'P-003') ? ['EI-9'] : undefined)));

    const response = await get.handler(new Request('http://localhost/api/device/plans/release'), { ...context, params: { slug: 'release' } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(blocks.overlayIssueBlocksForPlan).toHaveBeenCalledWith('release', expect.any(Array));
    expect(body.items.map((i: { id: string; storedStatus: string; effectiveStatus: string }) =>
      [i.id, i.storedStatus, i.effectiveStatus])).toEqual([
      ['P-001', 'wip', 'wip'],
      ['P-002', 'todo', 'blocked'],
      ['P-003', 'todo', 'blocked'],
      ['P-004', 'done', 'done'],
    ]);
    expect(body.items[2].blockedByIssues).toEqual(['EI-9']);
    expect(body.items[1]).not.toHaveProperty('blockedByIssues');
  });

  it('404s an unknown plan without reading issue blocks', async () => {
    source.readPlanBySlug.mockResolvedValue(null);
    const response = await get.handler(new Request('http://localhost/api/device/plans/missing'), { ...context, params: { slug: 'missing' } });
    expect(response.status).toBe(404);
    expect(blocks.overlayIssueBlocksForPlan).not.toHaveBeenCalled();
  });

  it.each(['', '?harness=all', '?harness=*', '?harness=member-pot'])('pins detail reads to the paired workspace %s', async (query) => {
    source.readPlanBySlug.mockResolvedValue(null);
    const response = await get.handler(new Request(`http://localhost/api/device/plans/missing${query}`), {
      ...context, params: { slug: 'missing' },
    });
    expect(response.status).toBe(404);
    expect(source.readPlanBySlug).toHaveBeenCalledExactlyOnceWith('missing', {
      workspaceId: 'paired-workspace',
      harnessSlug: query.includes('member-pot') ? 'member-pot' : undefined,
    });
  });

  it('rejects a foreign detail harness before reading or overlaying its plan', async () => {
    source.harnessExistsInWorkspace.mockResolvedValue(false);
    const response = await get.handler(new Request('http://localhost/api/device/plans/release?harness=foreign-pot'), {
      ...context, params: { slug: 'release' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'harness_not_in_workspace' });
    expect(source.harnessExistsInWorkspace).toHaveBeenCalledExactlyOnceWith('paired-workspace', 'foreign-pot');
    expect(source.readPlanBySlug).not.toHaveBeenCalled();
    expect(blocks.overlayIssueBlocksForPlan).not.toHaveBeenCalled();
  });
});
