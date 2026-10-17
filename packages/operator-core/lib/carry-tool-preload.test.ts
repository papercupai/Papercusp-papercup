import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSessionSurfaces, filterListingsByAllowlist, getSessionSurface, restoreSessionTools } from './endpoint-route/routes/transport/tool-allowlist';

const sql = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql }),
}));
const seed = new Set(['tools:find', 'tools:invoke']);
const input = { sessionKey: 'su-lineage', seed, ownerId: 'su-lineage', workspaceId: 'workspace-a' };
beforeEach(() => { __resetSessionSurfaces(); sql.mockReset(); });

describe('predecessor tool preload (R-12)', () => {
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
