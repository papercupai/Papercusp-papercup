import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';

const source = vi.hoisted(() => ({
  lookup: vi.fn(), dispatch: vi.fn(), readPage: vi.fn(), listHarnesses: vi.fn(),
  sql: {},
  withWorkspace: vi.fn(),
  releaseGateTile: vi.fn(), releaseGateApplicability: vi.fn(), poolTile: vi.fn(), systemAlerts: vi.fn(),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (definition: unknown) => definition,
  lookupByMcpName: source.lookup,
  dispatchProjectedTool: source.dispatch,
}));
vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: source.withWorkspace,
}));
vi.mock('../../../device-harnesses', () => ({ listHarnessesFor: source.listHarnesses }));
vi.mock('../../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'operator-home' }));
vi.mock('../../../sync-resolver/work-items-list-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sync-resolver/work-items-list-query')>()),
  readWorkItemsPageFromStore: source.readPage,
}));
vi.mock('../../../device-monitoring', () => ({
  releaseGateTile: source.releaseGateTile, poolTile: source.poolTile, systemAlerts: source.systemAlerts,
  releaseGateApplicability: source.releaseGateApplicability,
}));

import routes from './attention';

const attention = routes[0]!;
const context: RouteContext = {
  principal: {
    kind: 'device', slug: 'phone-test', workspaceId: 'paired-workspace',
    authMethod: 'jwt', trust: 'verified', capabilities: new Set(),
  },
  input: undefined, params: {}, log: () => {}, signal: new AbortController().signal,
};
const read = () => attention.handler(new Request('http://localhost/api/device/attention'), context);
const dispatched = (body: unknown) => ({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
const page = (rows: unknown[] = [], hasMore = false, nextCursor: string | null = null) => ({ rows, hasMore, nextCursor });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  source.lookup.mockReturnValue({});
  source.dispatch.mockResolvedValue(dispatched({ groups: [] }));
  source.withWorkspace.mockImplementation(async (_workspace: string, read: (sql: object) => Promise<unknown>) => read(source.sql));
  source.listHarnesses.mockResolvedValue([{ slug: 'paired-project' }]);
  source.readPage.mockResolvedValue(page());
  source.releaseGateTile.mockResolvedValue({ gate: 'green', red: false, checkedAtMs: 1 });
  source.releaseGateApplicability.mockResolvedValue('configured');
  source.poolTile.mockResolvedValue({ exhausted: false, accounts: [] });
  source.systemAlerts.mockReturnValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe('device attention read integrity', () => {
  it('reports an empty inbox only after every source was successfully measured', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      groups: [], workItems: [], systemAlerts: [], counts: { groups: 0, workItems: 0, systemAlerts: 0 },
    });
    expect(source.dispatch).toHaveBeenCalledWith(expect.anything(), 'plans:attention',
      { limit: 100, offset: 0, payloadTier: 'full' },
      expect.objectContaining({ workspaceId: 'paired-workspace', harnessSlug: 'operator-home', signal: context.signal }), {});
    expect(source.listHarnesses).toHaveBeenCalledExactlyOnceWith('paired-workspace', { includeHiveHomes: true });
    expect(source.withWorkspace).toHaveBeenCalledWith('paired-workspace', expect.any(Function));
    expect(source.readPage).toHaveBeenCalledWith(source.sql, 'paired-workspace', expect.anything(), { includeDetails: true });
    expect(source.poolTile).toHaveBeenCalledExactlyOnceWith('paired-workspace');
  });

  it('retains attention groups, eligible work items and a system-only alert', async () => {
    const groups = [{ items: [{ title: 'Needs a reply' }] }];
    const blocked = { id: 'feature', family: 'feature', state: 'blocked' };
    const bug = { id: 'bug', family: 'issue', kind: 'bug', state: 'open' };
    const alert = { id: 'system:red', title: 'Release needs attention' };
    source.dispatch.mockResolvedValue(dispatched({ groups }));
    source.readPage.mockResolvedValue(page([blocked, bug,
      { id: 'done', family: 'feature', state: 'done' },
      { id: 'task', family: 'issue', kind: 'task', state: 'open' }]));
    source.systemAlerts.mockReturnValue([alert]);
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      groups, workItems: [blocked, bug], systemAlerts: [alert],
      counts: { groups: 1, workItems: 2, systemAlerts: 1 },
    });
  });

  it('does not claim an empty inbox when the canonical reader is missing', async () => {
    source.lookup.mockReturnValue(undefined);
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'attention_unavailable' });
    expect(source.readPage).not.toHaveBeenCalled();
  });

  it.each([{}, { groups: null }, { groups: {} }, { ok: false, groups: [] }])(
    'rejects a missing, malformed or failed canonical result: %j', async (body) => {
      source.dispatch.mockResolvedValue(dispatched(body));
      expect((await read()).status).toBe(503);
    },
  );

  it.each(['invalid-json', 'mcp-error', 'thrown'])('surfaces canonical %s as unavailable', async (failure) => {
    if (failure === 'thrown') source.dispatch.mockRejectedValue(new Error('reader failed'));
    else source.dispatch.mockResolvedValue({ ok: true, result: {
      isError: failure === 'mcp-error', content: [{ type: 'text', text: 'unreadable result' }],
    } });
    expect((await read()).status).toBe(503);
  });

  it('does not hide a failed work-item read behind valid groups', async () => {
    source.dispatch.mockResolvedValue(dispatched({ groups: [{ items: [{ title: 'Visible' }] }] }));
    source.readPage.mockRejectedValue(new Error('work-item read failed'));
    expect((await read()).status).toBe(503);
  });

  it.each(['releaseGateTile', 'poolTile'] as const)('does not treat unknown %s as healthy', async (tile) => {
    source[tile].mockResolvedValue(null);
    expect((await read()).status).toBe(503);
  });

  it('loads customer attention after proving the checkpoint routine is absent', async () => {
    source.releaseGateTile.mockResolvedValue(null);
    source.releaseGateApplicability.mockResolvedValue('not-applicable');
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ systemAlerts: [] });
    expect(source.systemAlerts).toHaveBeenCalledWith({ gate: null, pool: { exhausted: false, accounts: [] } });
  });

  it.each(['configured', 'unknown'])('keeps unavailable %s pipelines fail-closed', async (status) => {
    source.releaseGateTile.mockResolvedValue(null);
    source.releaseGateApplicability.mockResolvedValue(status);
    expect((await read()).status).toBe(503);
    expect(source.systemAlerts).not.toHaveBeenCalled();
  });

  it('keeps an unreadable pool fail-closed even when the release gate is inapplicable', async () => {
    source.releaseGateTile.mockResolvedValue(null);
    source.releaseGateApplicability.mockResolvedValue('not-applicable');
    source.poolTile.mockResolvedValue(null);
    expect((await read()).status).toBe(503);
  });

  it('uses a measured gate without a redundant applicability read', async () => {
    expect((await read()).status).toBe(200);
    expect(source.releaseGateApplicability).not.toHaveBeenCalled();
  });

  it('does not hide a system-alert producer failure as a healthy zero', async () => {
    source.systemAlerts.mockImplementation(() => { throw new Error('composer unavailable'); });
    expect((await read()).status).toBe(503);
  });

  it('merges complete canonical pages and retains eligible work items from every store page', async () => {
    source.dispatch
      .mockResolvedValueOnce(dispatched({ groups: [{ key: 'plan', items: [{ title: 'First' }],
        _meta: { hasMore: true, nextOffset: 1, total: 2, returned: 1 } }] }))
      .mockResolvedValueOnce(dispatched({ groups: [{ key: 'plan', items: [{ title: 'Second' }],
        _meta: { hasMore: false, total: 2, returned: 1 } }] }));
    const blocked = { id: 'blocked', family: 'feature', kind: 'feature', state: 'blocked' };
    const bug = { id: 'bug', family: 'issue', kind: 'bug', state: 'open' };
    source.readPage.mockResolvedValueOnce(page([blocked], true, 'next')).mockResolvedValueOnce(page([bug]));
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      groups: [{ key: 'plan', items: [{ title: 'First' }, { title: 'Second' }] }],
      workItems: [blocked, bug], counts: { groups: 1, workItems: 2, systemAlerts: 0 },
    });
    expect(source.dispatch.mock.calls.map((call) => call[2].offset)).toEqual([0, 1]);
    expect(source.readPage).toHaveBeenCalledTimes(2);
  });

  it('refuses canonical pages that advertise more content without advancing', async () => {
    source.dispatch.mockResolvedValue(dispatched({ groups: [{ items: [{ title: 'Partial' }],
      _meta: { hasMore: true, nextOffset: 0, total: 2, returned: 1 } }] }));
    expect((await read()).status).toBe(503);
    expect(source.readPage).not.toHaveBeenCalled();
  });

  it('refuses a repeating work-item cursor instead of reporting a partial inbox', async () => {
    source.readPage.mockResolvedValue(page([{ family: 'feature', kind: 'feature', state: 'blocked' }], true, 'same'));
    expect((await read()).status).toBe(503);
    expect(source.readPage).toHaveBeenCalledTimes(2);
    expect(source.releaseGateTile).not.toHaveBeenCalled();
  });
});
