/**
 * trust:add / trust:remove / trust:list handler unit tests (TR1) —
 * shared-hive-trust-admission-2026-06-14 / P-009.
 *
 * Trust is a SECURITY GRANT and the workspace it lands in is a PRIVILEGE
 * BOUNDARY. Each handler resolves the target workspace as
 * `principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId()`
 * (add.ts:37-38, remove.ts:31-32, list.ts:29-30). These PG-free tests pin that
 * resolution per-tool by mocking `../../workspace-registry` (activeWorkspaceId)
 * + `../../trust/user-trust-list` (the store), and assert the resolved ws is the
 * one threaded into the store call:
 *   (a) principal ws 'ws-1'         → store called with 'ws-1'
 *   (b) principal ws '*'            → falls back to activeWorkspaceId()  ← the
 *                                      security-sensitive branch
 *   (c) no principal                → falls back to activeWorkspaceId()
 *   (d) store rejects (add)         → { ok:false, reason, isError:true }
 *   (e) actor defaults to 'agent'   → store called with actor:'agent'
 *
 * The handlers `await import()` their deps, so we vi.resetModules() + vi.doMock
 * then dynamically import the tool (mirrors processes/__tests__/kill.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTIVE_WS = 'ws-active';

// Bulk envelope: { ok, results:[…], counts }. Permissive type so per-item reads
// (b.results[0], b.results.map(...)) type-check in this PG-free unit.
type Body = { ok: boolean; results: any[]; counts: { ok: number; failed: number }; [k: string]: unknown };
const body = (r: { data?: any; content?: Array<{ text: string }> }): Body => (r.data ?? JSON.parse(r.content![0].text));

/** A ctx with the given principal fields; pass `null` to omit the principal entirely. */
function ctxWith(principal: { workspaceId?: string; slug?: string } | null): unknown {
  return { principal: principal ?? undefined } as never;
}

let activeWorkspaceId: ReturnType<typeof vi.fn>;
let addTrustedUser: ReturnType<typeof vi.fn>;
let removeTrustedUser: ReturnType<typeof vi.fn>;
let listTrustedUsers: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  activeWorkspaceId = vi.fn(() => ACTIVE_WS);
  addTrustedUser = vi.fn(async () => ({ githubUserId: 42, note: null, createdTs: 1000 }));
  removeTrustedUser = vi.fn(async () => ({ removed: true }));
  listTrustedUsers = vi.fn(async () => [{ githubUserId: 42, note: null, createdTs: 1000 }]);
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));
  vi.doMock('../../trust/user-trust-list', () => ({ addTrustedUser, removeTrustedUser, listTrustedUsers }));
});

afterEach(() => {
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../trust/user-trust-list');
});

async function addTool() {
  return (await import('./add')).default as unknown as {
    handler: (a: unknown, c: unknown) => Promise<{ data?: any; content?: Array<{ text: string }>; isError?: boolean }>;
  };
}
async function removeTool() {
  return (await import('./remove')).default as unknown as {
    handler: (a: unknown, c: unknown) => Promise<{ data?: any; content?: Array<{ text: string }>; isError?: boolean }>;
  };
}
async function listTool() {
  return (await import('./list')).default as unknown as {
    handler: (a: unknown, c: unknown) => Promise<{ data?: any; content?: Array<{ text: string }>; isError?: boolean }>;
  };
}

describe('trust:add — workspace resolution (privilege boundary) + bulk envelope (P-006)', () => {
  it('(a) n=1 principal workspace is honoured — store called with that ws; one keyed result', async () => {
    const tool = await addTool();
    const b = body(await tool.handler({ githubUserId: 42 }, ctxWith({ workspaceId: 'ws-1', slug: 'owner' })));
    expect(addTrustedUser).toHaveBeenCalledTimes(1);
    expect(addTrustedUser.mock.calls[0]![0]).toBe('ws-1');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, githubUserId: 42, workspaceId: 'ws-1' });
  });

  it("(b) SECURITY: principal workspace '*' falls back to the active workspace, NOT '*'", async () => {
    const tool = await addTool();
    const b = body(await tool.handler({ githubUserId: 42 }, ctxWith({ workspaceId: '*', slug: 'owner' })));
    expect(addTrustedUser.mock.calls[0]![0]).toBe(ACTIVE_WS);
    expect(addTrustedUser.mock.calls[0]![0]).not.toBe('*');
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(b.results[0]).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it('(c) no principal falls back to the active workspace', async () => {
    const tool = await addTool();
    const b = body(await tool.handler({ githubUserId: 42 }, ctxWith(null)));
    expect(addTrustedUser.mock.calls[0]![0]).toBe(ACTIVE_WS);
    expect(b.results[0]).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it('(d) a rejecting store fails ONLY that item ({ ok:false, githubUserId, error }); batch ok:true', async () => {
    addTrustedUser.mockRejectedValueOnce(new Error('boom-add'));
    const tool = await addTool();
    const b = body(await tool.handler({ githubUserId: 42 }, ctxWith({ workspaceId: 'ws-1' })));
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, githubUserId: 42, error: 'boom-add' });
  });

  it('(e) actor defaults to "agent" when the principal has no slug', async () => {
    const tool = await addTool();
    await tool.handler({ githubUserId: 42 }, ctxWith({ workspaceId: 'ws-1' }));
    expect(addTrustedUser.mock.calls[0]![1]).toMatchObject({ actor: 'agent', githubUserId: 42, note: null });
  });

  it('threads the principal slug + note through as the audit actor', async () => {
    const tool = await addTool();
    await tool.handler({ githubUserId: 42, note: 'co-maintainer' }, ctxWith({ workspaceId: 'ws-1', slug: 'su-owner' }));
    expect(addTrustedUser.mock.calls[0]![1]).toMatchObject({ actor: 'su-owner', note: 'co-maintainer' });
  });

  it('githubUserIds:[…] trusts many, each keyed by githubUserId; one failing id fails only itself', async () => {
    addTrustedUser.mockImplementation(async (_ws: string, opts: { githubUserId: number }) => {
      if (opts.githubUserId === 99) throw new Error('grant denied');
      return { githubUserId: opts.githubUserId, note: null, createdTs: 1 };
    });
    const tool = await addTool();
    const b = body(await tool.handler({ githubUserIds: [42, 99, 7] }, ctxWith({ workspaceId: 'ws-1', slug: 'owner' })));
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 2, failed: 1 });
    expect(b.results.map((r: any) => [r.githubUserId, r.ok])).toEqual([
      [42, true],
      [99, false],
      [7, true],
    ]);
    expect(b.results[1].error).toContain('grant denied');
  });
});

describe('trust:remove — workspace resolution (privilege boundary) + bulk envelope (P-006)', () => {
  it('(a) n=1 principal workspace is honoured; one keyed result', async () => {
    const tool = await removeTool();
    const b = body(await tool.handler({ githubUserId: 7 }, ctxWith({ workspaceId: 'ws-1', slug: 'owner' })));
    expect(removeTrustedUser).toHaveBeenCalledWith('ws-1', 7, 'owner');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, workspaceId: 'ws-1', githubUserId: 7, removed: true });
  });

  it("(b) SECURITY: principal workspace '*' falls back to the active workspace", async () => {
    const tool = await removeTool();
    const b = body(await tool.handler({ githubUserId: 7 }, ctxWith({ workspaceId: '*', slug: 'owner' })));
    expect(removeTrustedUser).toHaveBeenCalledWith(ACTIVE_WS, 7, 'owner');
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(b.results[0]).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it('(c) no principal falls back to the active workspace + actor "agent"', async () => {
    const tool = await removeTool();
    await tool.handler({ githubUserId: 7 }, ctxWith(null));
    expect(removeTrustedUser).toHaveBeenCalledWith(ACTIVE_WS, 7, 'agent');
  });

  it('projects removed:false from the store verbatim', async () => {
    removeTrustedUser.mockResolvedValueOnce({ removed: false });
    const tool = await removeTool();
    const b = body(await tool.handler({ githubUserId: 7 }, ctxWith({ workspaceId: 'ws-1' })));
    expect(b.results[0]).toMatchObject({ ok: true, removed: false });
  });

  it('githubUserIds:[…] revokes many, each keyed by githubUserId', async () => {
    removeTrustedUser.mockImplementation(async (_ws: string, id: number) => ({ removed: id !== 8 }));
    const tool = await removeTool();
    const b = body(await tool.handler({ githubUserIds: [7, 8] }, ctxWith({ workspaceId: 'ws-1', slug: 'owner' })));
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: any) => [r.githubUserId, r.removed])).toEqual([
      [7, true],
      [8, false],
    ]);
  });
});

describe('trust:list — workspace resolution (privilege boundary)', () => {
  it('(a) principal workspace is honoured', async () => {
    const tool = await listTool();
    const result = await tool.handler({}, ctxWith({ workspaceId: 'ws-1', slug: 'owner' }));
    const res = body(result);
    expect(result.data).toEqual(res);
    expect(result.content).toBeUndefined();
    expect(listTrustedUsers).toHaveBeenCalledWith('ws-1');
    expect(activeWorkspaceId).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, workspaceId: 'ws-1', count: 1 });
  });

  it("(b) SECURITY: principal workspace '*' falls back to the active workspace", async () => {
    const tool = await listTool();
    const res = body(await tool.handler({}, ctxWith({ workspaceId: '*', slug: 'owner' })));
    expect(listTrustedUsers).toHaveBeenCalledWith(ACTIVE_WS);
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it('(c) no principal falls back to the active workspace', async () => {
    const tool = await listTool();
    await tool.handler({}, ctxWith(null));
    expect(listTrustedUsers).toHaveBeenCalledWith(ACTIVE_WS);
  });

  it('reports the trusted-user count from the store', async () => {
    listTrustedUsers.mockResolvedValueOnce([
      { githubUserId: 1, note: null, createdTs: 1 },
      { githubUserId: 2, note: 'x', createdTs: 2 },
    ]);
    const tool = await listTool();
    const res = body(await tool.handler({}, ctxWith({ workspaceId: 'ws-1' })));
    expect(res).toMatchObject({ ok: true, count: 2 });
    expect((res.trusted as unknown[]).length).toBe(2);
  });
});
