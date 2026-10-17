/**
 * pot_git:integration_requests handler unit tests (WI-1555) — PG-free, mocks the
 * store module + workspace-registry (mirrors trust/add.test.ts's pattern).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTIVE_WS = 'ws-active';

type Body = { ok: boolean; [k: string]: unknown };
const body = (r: { content?: Array<{ text: string }> }): Body => JSON.parse(r.content![0].text);

function ctxWith(principal: { workspaceId?: string; slug?: string } | null): unknown {
  return { principal: principal ?? undefined } as never;
}

let activeWorkspaceId: ReturnType<typeof vi.fn>;
let listIntegrationRequests: ReturnType<typeof vi.fn>;
let ratifyIntegrationRequest: ReturnType<typeof vi.fn>;

const SAMPLE_ROW = {
  workspaceId: ACTIVE_WS,
  potSlug: 'pot-1',
  repoKey: 'papercup',
  devicePubkey: 'dev-pk',
  headSha: 'a'.repeat(40),
  authorGithubUserId: 42,
  reason: 'below-steer-tier' as const,
  state: 'pending' as const,
  createdTs: 1000,
  ratifiedTs: null,
};

beforeEach(() => {
  vi.resetModules();
  activeWorkspaceId = vi.fn(() => ACTIVE_WS);
  listIntegrationRequests = vi.fn(async () => [SAMPLE_ROW]);
  ratifyIntegrationRequest = vi.fn(async () => true);
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId }));
  vi.doMock('../../sync/pot-git/integration-requests', () => ({
    listIntegrationRequests,
    ratifyIntegrationRequest,
  }));
});

afterEach(() => {
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../sync/pot-git/integration-requests');
});

async function tool() {
  return (await import('./integration_requests')).default as unknown as {
    handler: (a: unknown, c: unknown) => Promise<{ content?: Array<{ text: string }>; isError?: boolean }>;
  };
}

describe('pot_git:integration_requests', () => {
  it("action:'list' returns the queue + resolves workspace from the principal", async () => {
    const t = await tool();
    const b = body(await t.handler({ action: 'list' }, ctxWith({ workspaceId: 'ws-1' })));
    expect(listIntegrationRequests.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws-1' });
    expect(activeWorkspaceId).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, workspaceId: 'ws-1', count: 1 });
    expect((b.requests as unknown[])[0]).toMatchObject({ headSha: SAMPLE_ROW.headSha, state: 'pending' });
  });

  it("action:'list' falls back to the active workspace when no principal ws is set", async () => {
    const t = await tool();
    const b = body(await t.handler({ action: 'list' }, ctxWith(null)));
    expect(activeWorkspaceId).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true, workspaceId: ACTIVE_WS });
  });

  it("a scoped principal cannot list or ratify another workspace's requests", async () => {
    const t = await tool();
    const list = await t.handler(
      { action: 'list', workspaceId: 'ws-foreign' },
      ctxWith({ workspaceId: 'ws-1' }),
    );
    expect(list.isError).toBe(true);
    expect(list.content?.[0]?.text).toContain('workspace_forbidden');
    expect(listIntegrationRequests).not.toHaveBeenCalled();

    const ratify = await t.handler(
      {
        action: 'ratify',
        workspaceId: 'ws-foreign',
        potSlug: 'pot-1',
        repoKey: 'papercup',
        devicePubkey: 'dev-pk',
        headSha: SAMPLE_ROW.headSha,
      },
      ctxWith({ workspaceId: 'ws-1' }),
    );
    expect(ratify.isError).toBe(true);
    expect(ratify.content?.[0]?.text).toContain('workspace_forbidden');
    expect(ratifyIntegrationRequest).not.toHaveBeenCalled();
  });

  it("action:'list' threads state/limit/scope filters through to the store", async () => {
    const t = await tool();
    await t.handler(
      { action: 'list', potSlug: 'pot-1', repoKey: 'papercup', devicePubkey: 'dev-pk', state: 'ratified', limit: 5 },
      ctxWith({ workspaceId: 'ws-1' }),
    );
    expect(listIntegrationRequests.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1',
      potSlug: 'pot-1',
      repoKey: 'papercup',
      devicePubkey: 'dev-pk',
      state: 'ratified',
      limit: 5,
    });
  });

  it("action:'ratify' promotes the (device, sha) row and reports ratified:true", async () => {
    const t = await tool();
    const b = body(
      await t.handler(
        { action: 'ratify', potSlug: 'pot-1', repoKey: 'papercup', devicePubkey: 'dev-pk', headSha: SAMPLE_ROW.headSha },
        ctxWith({ workspaceId: 'ws-1' }),
      ),
    );
    expect(ratifyIntegrationRequest.mock.calls[0]![0]).toMatchObject({
      workspaceId: 'ws-1',
      potSlug: 'pot-1',
      repoKey: 'papercup',
      devicePubkey: 'dev-pk',
      headSha: SAMPLE_ROW.headSha,
    });
    expect(b).toMatchObject({ ok: true, ratified: true });
  });

  it("action:'ratify' on a non-existent (device, sha) row reports ok:false, ratified:false — never throws", async () => {
    ratifyIntegrationRequest.mockResolvedValueOnce(false);
    const t = await tool();
    const b = body(
      await t.handler(
        { action: 'ratify', potSlug: 'pot-1', repoKey: 'papercup', devicePubkey: 'dev-pk', headSha: 'b'.repeat(40) },
        ctxWith({ workspaceId: 'ws-1' }),
      ),
    );
    expect(b).toMatchObject({ ok: false, ratified: false });
    expect(b.error).toMatch(/no such queued/);
  });

  it("the args schema itself rejects action:'ratify' missing a required field", async () => {
    const t = (await import('./integration_requests')).default as unknown as {
      args: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(t.args.safeParse({ action: 'ratify', potSlug: 'pot-1' }).success).toBe(false);
    expect(
      t.args.safeParse({ action: 'ratify', potSlug: 'h', repoKey: 'r', devicePubkey: 'd', headSha: 's' }).success,
    ).toBe(true);
    expect(t.args.safeParse({ action: 'list' }).success).toBe(true);
  });
});
