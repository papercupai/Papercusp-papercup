import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: vi.fn(), auth: vi.fn(), send: vi.fn() }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: mocks.user }));
vi.mock('../../personal-vault/authorization', () => ({ authorizePersonalAccess: mocks.auth }));
vi.mock('../../capability-verbs/notify', async (original) => ({ ...(await original<object>()), sendNotification: mocks.send }));
import tool from './send';
const args = { providerId: 'discord', sourceId: 'source', text: 'Release 0.4 is out.', idempotencyKey: 'release-0.4', addressee: { from: 'owner-instruction' as const } };
const ctx = { workspaceId: 'workspace', role: 'papercup', tx: () => [], ownerId: 'agent' } as unknown as Parameters<typeof tool.handler>[1];
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: 'owner' }); mocks.auth.mockResolvedValue({ allowed: true }); mocks.send.mockResolvedValue({ status: 'sent' }); });
describe('notify:send tool boundary (P-005)', () => {
  it('is an irreversible owner write that authorizes the provider-specific personal scope', async () => {
    expect(tool.name).toBe('notify:send');
    expect(tool.irreversible).toBe(true);
    expect(await tool.handler(args, ctx)).toMatchObject({ data: { status: 'sent' } });
    expect(mocks.auth).toHaveBeenCalledWith(ctx.tx, ctx, 'workspace', 'owner', ['personal:discord']);
    expect(mocks.send).toHaveBeenCalledWith(ctx.tx, expect.objectContaining({ workspaceId: 'workspace', userId: 'owner', sourceId: 'source',
      text: args.text, idempotencyKey: args.idempotencyKey, provenance: args.addressee }));
  });
  it('refuses a denied personal scope before the outbound path', async () => {
    mocks.auth.mockResolvedValue({ allowed: false, reason: 'coding_agent_denied' });
    expect(await tool.handler(args, ctx)).toMatchObject({ data: { allowed: false, refusal: 'coding_agent_denied' } });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('requires a concrete workspace', async () => {
    await expect(tool.handler(args, { ...ctx, workspaceId: '*' })).rejects.toThrow('workspace_required');
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('rejects unknown arguments so a caller cannot smuggle a channel', () => {
    expect(tool.args.safeParse({ ...args, channelId: '123456789012345678' }).success).toBe(false);
    expect(tool.args.safeParse(args).success).toBe(true);
  });
});
