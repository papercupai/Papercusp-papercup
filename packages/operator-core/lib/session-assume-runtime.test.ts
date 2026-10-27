import { describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { createAssumeAuthorizer } from './session-assume-runtime';

const actor = { ownerId: 'su-fixture-caller', workspaceId: 'fixture-workspace' };
const request = { requestId: 'request-1', targetOwnerId: 'su-fixture-target', contextMode: 'native-resume' as const };
function fixture() {
  const ctx: UnifiedToolContext = { log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
    uiClientId: actor.ownerId, workspaceId: actor.workspaceId, isSuperuser: true,
    gateBypass: { role: true, capability: true }, principal: { kind: 'system', slug: 'system:superuser',
      authMethod: 'bearer-token', trust: 'trusted', workspaceId: actor.workspaceId, capabilities: new Set() } };
  const target = { ok: true as const, ownerId: request.targetOwnerId, workspaceId: actor.workspaceId,
    advSessionId: 42, role: 'su' as string | null, binding: { coordOwnerId: request.targetOwnerId, sessionId: 'native-target', startedAt: 'start' } };
  const ports = { confinement: vi.fn(async (_owner: string | null | undefined) => null), resolve: vi.fn(async () => target),
    inspect: vi.fn(async () => ({ binding: null, recruiterLaunch: false })), envelope: vi.fn(async () => true) };
  // Resolver fixtures deliberately contain metadata only: authorization may
  // not read conversation files or acquire a reservation.
  const authorize = createAssumeAuthorizer(ctx, request, ports as unknown as NonNullable<Parameters<typeof createAssumeAuthorizer>[2]>);
  return { ctx, ports, target, authorize };
}

describe('trusted takeover launch authority', () => {
  it('binds stable authority and rechecks it at execution', async () => {
    const { authorize, ctx, ports } = fixture();
    const ref = await authorize(actor, 'su');
    expect(ref).toMatch(/^launch-envelope:[a-f0-9]{64}$/);
    expect(await authorize(actor, 'su')).toBe(ref);
    expect(ports.envelope).toHaveBeenCalledTimes(2);
    ctx.gateBypass!.capability = false;
    expect(await authorize(actor, 'su')).toBeNull();
  });

  it.each(['principal', 'trust', 'bypass', 'capability', 'scope', 'power', 'metadata'])(
    'refuses missing or weaker %s administrative authority', async field => {
      const { ctx, authorize, ports } = fixture();
      if (field === 'principal') ctx.principal = null;
      if (field === 'trust') ctx.principal!.trust = 'unverified-loopback';
      if (field === 'bypass') ctx.gateBypass = undefined;
      if (field === 'capability') ctx.gateBypass!.capability = false;
      if (field === 'scope') ctx.principal!.workspaceId = 'foreign';
      if (field === 'power') { ctx.isSuperuser = false; ctx.isPowerUser = true; }
      if (field === 'metadata') ctx.isSuperuser = false;
      expect(await authorize(actor)).toBeNull();
      expect(ports.resolve).not.toHaveBeenCalled();
    });

  it('refuses another caller, a tool-scoped principal and a changed target role', async () => {
    const { ctx, authorize } = fixture();
    expect(await authorize({ ...actor, ownerId: 'su-other' })).toBeNull();
    expect(await authorize(actor, 'operator')).toBeNull();
    ctx.principal!.allowedTools = new Set(['capability:launch-agent']);
    expect(await authorize(actor)).toBeNull();
  });

  it('uses the context resolver default for a legacy unrecorded role', async () => {
    const { target, authorize } = fixture();
    target.role = null;
    expect(await authorize(actor, 'su')).toMatch(/^launch-envelope:/);
    expect(await authorize(actor, 'operator')).toBeNull();
  });

  it('does not treat a trusted label as authenticated loopback authority', async () => {
    const { ctx, authorize } = fixture();
    ctx.principal!.authMethod = 'host-loopback';
    expect(await authorize(actor)).toBeNull();
  });

  it.each(['caller', 'target', 'binding', 'recruiter', 'envelope', 'unreadable'])(
    'preserves the %s restriction before context is read', async restriction => {
      const { ports, authorize } = fixture();
      if (restriction === 'caller' || restriction === 'target') ports.confinement.mockImplementation(async owner =>
        owner === (restriction === 'caller' ? actor.ownerId : request.targetOwnerId) ? { denyTools: [], imposedBy: 'fixture', reason: 'frozen review' } as never : null);
      if (restriction === 'binding') ports.inspect.mockResolvedValue({ binding: {} as never, recruiterLaunch: false });
      if (restriction === 'recruiter') ports.inspect.mockResolvedValue({ binding: null, recruiterLaunch: true });
      if (restriction === 'envelope') ports.envelope.mockResolvedValue(false);
      if (restriction === 'unreadable') ports.confinement.mockRejectedValue(new Error('read unavailable'));
      expect(await authorize(actor)).toBeNull();
    });
});
