import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ read: vi.fn(), config: vi.fn() }));
vi.mock('../../auth/hosted-lead-usage', async orig => ({
  ...await orig<typeof import('../../auth/hosted-lead-usage')>(),
  HostedLeadUsageService: class {
    constructor(config: unknown) { h.config(config); }
    read = h.read;
  },
}));
const tool = (await import('./usage')).default;
const args = { personRef: 'PER-a', windowStart: '2026-10-15T00:00:00Z', windowEnd: '2026-10-27T00:00:00Z' };
const ctx = { workspaceId: 'graph', principal: { kind: 'service', trust: 'verified', authMethod: 'bearer-token',
  slug: 'app:crm/token', workspaceId: 'graph' } };
const call = (context: unknown = ctx) => tool.handler(args, context as never) as Promise<{ data: { usage: unknown } }>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID', 'graph');
  vi.stubEnv('PORT', '3170'); vi.stubEnv('NODE_ENV', 'production');
  h.read.mockResolvedValue({ status: 'unknown', reason: 'no_observations' });
});
afterEach(() => vi.unstubAllEnvs());
describe('people:usage D053 tool boundary', () => {
  it('passes authenticated transport context and server-owned staging scope to the service', async () => {
    expect((await call()).data.usage).toEqual({ status: 'unknown', reason: 'no_observations' });
    expect(h.config).toHaveBeenCalledWith({ graphWorkspaceId: 'graph', environment: 'staging' });
    expect(h.read).toHaveBeenCalledWith(args, { phase: 'enforce', boundary: 'dispatch', toolName: 'people:usage',
      capabilities: ['intel:read'], args, ctx });
  });
  it('uses production only from existing host configuration', async () => {
    vi.stubEnv('PORT', '3070'); await call();
    expect(h.config).toHaveBeenCalledWith({ graphWorkspaceId: 'graph', environment: 'production' });
  });
  it.each([
    {}, { ...ctx, role: 'coding' }, { ...ctx, workspaceId: 'foreign' },
    { ...ctx, principal: { ...ctx.principal, workspaceId: 'foreign' } },
    { ...ctx, principal: { ...ctx.principal, kind: 'user' } },
    { ...ctx, principal: { ...ctx.principal, trust: 'local' } },
    { ...ctx, principal: { ...ctx.principal, authMethod: 'cookie-session' } },
  ])('refuses an unauthorized context without constructing the adapter: %j', async context => {
    expect((await call(context)).data.usage).toMatchObject({ status: 'unknown' });
    expect(h.config).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });
  it.each(['', '*'])('fails closed when host graph configuration is unavailable: %s', async value => {
    vi.stubEnv('PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID', value);
    await call(); expect(h.read).not.toHaveBeenCalled();
  });
  it.each(['userId', 'organizationId', 'consent', 'environment', 'distinctId', 'graphWorkspaceId', 'bindingRef'])
    ('rejects caller-owned selector %s at schema admission', key => {
      expect(tool.args.safeParse({ ...args, [key]: 'injected' }).success).toBe(false);
    });
  it('admits only an exact person and bounded half-open window', () => {
    expect(tool.args.safeParse(args).success).toBe(true);
    for (const bad of [{ ...args, personRef: 'email@example.com' }, { ...args, windowEnd: args.windowStart },
      { ...args, windowStart: '2025-10-15T00:00:00Z' }]) expect(tool.args.safeParse(bad).success).toBe(false);
  });
});
