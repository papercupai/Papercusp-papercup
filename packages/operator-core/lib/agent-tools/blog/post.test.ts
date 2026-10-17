import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), auth: vi.fn(), post: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: mocks.user }));
vi.mock('../../personal-vault/authorization', () => ({ authorizePersonalAccess: mocks.auth }));
vi.mock('../../capability-verbs/blog', () => ({ postToBlog: mocks.post }));
import tool from './post';
const args = { providerId: 'devto', sourceId: 'source', title: 'Title', markdown: '# Content', canonicalUrl: 'https://papercusp.com/blog/title', addressee: { from: 'owner-instruction' as const } };
const ctx = { workspaceId: 'workspace', role: 'papercup', tx: () => [], ownerId: 'agent' } as unknown as Parameters<typeof tool.handler>[1];
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: 'owner' }); mocks.auth.mockResolvedValue({ allowed: true }); mocks.post.mockResolvedValue({ status: 'drafted' }); });
describe('blog:post tool boundary', () => {
  it('authorizes the provider-specific personal scope and forwards the owner/workspace/source', async () => {
    expect(await tool.handler(args, ctx)).toMatchObject({ data: { status: 'drafted' } });
    expect(mocks.auth).toHaveBeenCalledWith(ctx.tx, ctx, 'workspace', 'owner', ['personal:devto']);
    expect(mocks.post).toHaveBeenCalledWith(ctx.tx, expect.objectContaining({ workspaceId: 'workspace', userId: 'owner', sourceId: 'source', provenance: args.addressee }));
  });
  it('refuses a denied personal scope before the outbound path', async () => {
    mocks.auth.mockResolvedValue({ allowed: false, reason: 'coding_agent_denied' });
    expect(await tool.handler(args, ctx)).toMatchObject({ data: { allowed: false, refusal: 'coding_agent_denied' } }); expect(mocks.post).not.toHaveBeenCalled();
  });
  it('requires a concrete workspace', async () => {
    await expect(tool.handler(args, { ...ctx, workspaceId: '*' })).rejects.toThrow('workspace_required'); expect(mocks.post).not.toHaveBeenCalled();
  });
});
