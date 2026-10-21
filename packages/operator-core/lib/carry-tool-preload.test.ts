import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compactInputSchema, summaryGuidanceDescription } from '@papercusp/tooldef';
import { __resetSessionSurfaces, activateSessionTools, applyCompactTier, filterListingsByAllowlist, getSessionSurface, getSessionUsedTools, restoreSessionTools, sessionToolSurfaceKey } from './endpoint-route/routes/transport/tool-allowlist';

const sql = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql }),
}));
const seed = new Set(['tools:find', 'tools:invoke']);
const input = { sessionKey: sessionToolSurfaceKey('su-lineage', 'workspace-a')!, seed, ownerId: 'su-lineage', workspaceId: 'workspace-a' };
beforeEach(() => { __resetSessionSurfaces(); sql.mockReset(); });

describe('predecessor tool preload (R-12)', () => {
  it('isolates the same stable owner across workspaces in the in-memory surface', async () => {
    const otherKey = sessionToolSurfaceKey(input.ownerId, 'workspace-b')!;
    const readUsedTools = vi.fn(async (_owner: string, workspace: string) =>
      [workspace === 'workspace-a' ? 'plans:get' : 'facts:list']);
    await restoreSessionTools({ ...input, readUsedTools });
    await restoreSessionTools({ ...input, sessionKey: otherKey, workspaceId: 'workspace-b', readUsedTools });
    expect(getSessionSurface(input.sessionKey, seed)?.has('facts:list')).toBe(false);
    expect(getSessionSurface(otherKey, seed)?.has('plans:get')).toBe(false);
    expect(getSessionSurface(otherKey, seed)?.has('facts:list')).toBe(true);
    expect([...getSessionUsedTools(input.sessionKey)!]).toEqual(['plans:get']);
    expect([...getSessionUsedTools(otherKey)!]).toEqual(['facts:list']);
    expect(sessionToolSurfaceKey(null, 'workspace-a')).toBeNull();
  });
  it('advertises every previously called tool on the first restarted list without discovery, including beyond the orient cap', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `used:tool-${i}`);
    sql.mockResolvedValue(names.map((tool_name) => ({ tool_name })));
    await restoreSessionTools(input);
    const listings = [...seed, ...names].map((name) => ({ name, inputSchema: { type: 'object' } }));
    expect(filterListingsByAllowlist(listings, getSessionSurface(input.sessionKey, seed)))
      .toEqual(listings);
    expect(sql).toHaveBeenCalledOnce();
    const [strings, ...params] = sql.mock.calls[0]!;
    expect(strings.join(' ')).toContain('SELECT DISTINCT tool_name');
    expect(strings.join(' ')).toContain('coord_owner_id =');
    expect(params).toEqual(['workspace-a', 'su-lineage']);
  });

  it('survives an operator-memory reset by replaying the durable invocation ledger', async () => {
    sql.mockResolvedValue([{ tool_name: 'work_items:checkpoint' }]);
    await restoreSessionTools(input);
    __resetSessionSurfaces();
    await restoreSessionTools(input);
    expect(getSessionSurface(input.sessionKey, seed)?.has('work_items:checkpoint')).toBe(true);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it('loads tools called after the first listing when the successor reuses the same operator and owner', async () => {
    sql.mockResolvedValueOnce([{ tool_name: 'plans:get' }])
      .mockResolvedValueOnce([{ tool_name: 'plans:get' }, { tool_name: 'work_items:checkpoint' }]);
    await restoreSessionTools(input);
    await restoreSessionTools(input);
    expect(getSessionSurface(input.sessionKey, seed)?.has('work_items:checkpoint')).toBe(true);
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent lists and keeps another owner isolated', async () => {
    const readUsedTools = vi.fn(async (owner: string) => [owner === 'su-lineage' ? 'plans:get' : 'facts:list']);
    await Promise.all([restoreSessionTools({ ...input, readUsedTools }), restoreSessionTools({ ...input, readUsedTools })]);
    await restoreSessionTools({ ...input, sessionKey: 'su-other', ownerId: 'su-other', readUsedTools });
    expect(readUsedTools).toHaveBeenCalledTimes(2);
    expect(getSessionSurface('su-other', seed)?.has('plans:get')).toBe(false);
    expect(getSessionSurface(input.sessionKey, seed)?.has('facts:list')).toBe(false);
  });

  it('does not broaden a full-catalog or anonymous listing and does not turn unknown names into definitions', async () => {
    const readUsedTools = vi.fn(async () => ['retired:tool']);
    await restoreSessionTools({ ...input, seed: null, readUsedTools });
    await restoreSessionTools({ ...input, sessionKey: null, readUsedTools });
    expect(readUsedTools).not.toHaveBeenCalled();
    await restoreSessionTools({ ...input, readUsedTools });
    expect(filterListingsByAllowlist([{ name: 'tools:find' }], getSessionSurface(input.sessionKey, seed)))
      .toEqual([{ name: 'tools:find' }]);
  });

  it('leaves a failed restoration retryable instead of caching an empty success', async () => {
    const readUsedTools = vi.fn().mockRejectedValueOnce(new Error('ledger unavailable')).mockResolvedValue(['plans:get']);
    await expect(restoreSessionTools({ ...input, readUsedTools })).rejects.toThrow('ledger unavailable');
    await restoreSessionTools({ ...input, readUsedTools });
    expect(getSessionSurface(input.sessionKey, seed)?.has('plans:get')).toBe(true);
  });
});

describe('D-058 candidate detail promotion (not enabled on the host)', () => {
  const listings = ['plans:get', 'work_items:list'].map(name => ({
    name, description: 'Complete original definition. More detailed guidance for continued use.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', description: 'Full scope guidance' } } },
  }));
  const compact = new Set(listings.map(tool => tool.name));
  const project = () => applyCompactTier(listings, compact, compactInputSchema,
    summaryGuidanceDescription, getSessionUsedTools(input.sessionKey));

  it('keeps discovered but unused definitions compact and promotes only actual invoked names', async () => {
    getSessionSurface(input.sessionKey, seed);
    activateSessionTools(input.sessionKey, [...compact]);
    expect(getSessionUsedTools(input.sessionKey)?.size).toBe(0);
    expect(project()[0]?.inputSchema).not.toEqual(listings[0]?.inputSchema);
    await restoreSessionTools({ ...input, readUsedTools: async () => ['plans:get'] });
    const delivered = project();
    expect(delivered[0]).toBe(listings[0]);
    expect(delivered[1]?.inputSchema).not.toEqual(listings[1]?.inputSchema);
    expect(delivered.map(tool => tool.name)).toEqual(listings.map(tool => tool.name));
    expect([...compact]).toEqual(listings.map(tool => tool.name));
  });

  it('reconstructs full detail after a memory reset without inventing retired or unauthorized definitions', async () => {
    const readUsedTools = async () => ['plans:get', 'retired:tool', 'denied:tool'];
    await restoreSessionTools({ ...input, readUsedTools });
    __resetSessionSurfaces();
    expect(getSessionUsedTools(input.sessionKey)).toBeNull();
    await restoreSessionTools({ ...input, readUsedTools });
    expect(project()[0]).toBe(listings[0]);
    expect(project().map(tool => tool.name)).toEqual(['plans:get', 'work_items:list']);
  });

  it('does not turn a failed history read into used-tool detail and remains retryable', async () => {
    const readUsedTools = vi.fn().mockRejectedValueOnce(new Error('ledger unavailable'))
      .mockResolvedValue(['plans:get']);
    await expect(restoreSessionTools({ ...input, readUsedTools })).rejects.toThrow('ledger unavailable');
    expect(getSessionUsedTools(input.sessionKey)?.size).toBe(0);
    expect(project()[0]?.inputSchema).not.toEqual(listings[0]?.inputSchema);
    await restoreSessionTools({ ...input, readUsedTools });
    expect(project()[0]).toBe(listings[0]);
    expect(getSessionUsedTools(null)).toBeNull();
  });
});
