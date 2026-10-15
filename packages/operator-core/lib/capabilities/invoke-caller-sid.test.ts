/**
 * invoke-caller-sid.test.ts — EI-1751: invokeServerCapability threads an
 * optional `callerSid` into the dispatch ctx as `uiClientId` (attribution
 * only), while `spawnId` STAYS the fixed literal 'palette' every existing
 * 'palette'-keyed consumer (fleet-ekg/features.ts, decision-ledger/emit.ts's
 * isReadShapedCoordPoll) depends on.
 *
 * External layers (catalog lookup + dispatch + workspace tx) are mocked at
 * the module boundary; `dispatchProjectedToolToMcp` is stubbed to CAPTURE the
 * ctx it was called with so the test can assert on it directly, instead of
 * inferring it indirectly through a real dispatch.
 *
 * Run: cd packages/operator-core && npx vitest run lib/capabilities/invoke-caller-sid.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const scope = vi.hoisted(() => ({ registry: vi.fn() }));
vi.mock('../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness-registry')>()),
  loadHarnessRegistry: scope.registry,
}));

const fakeProjected = {
  description: 'a low-risk test tool',
  inputSchema: {},
  capabilities: [] as string[],
};

vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    lookupByMcpName: vi.fn(() => fakeProjected),
    tierFor: vi.fn(() => 'low'),
  };
});

let capturedCtx: UnifiedToolContext | null = null;
vi.mock('@papercusp/tooldef-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/tooldef-mcp')>()),
  dispatchProjectedToolToMcp: vi.fn(async (_projected: unknown, _name: string, _args: unknown, ctx: UnifiedToolContext) => {
    capturedCtx = ctx;
    return { ok: true };
  }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => unknown) => fn({})),
  };
});

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws1') }));

const { invokeServerCapability } = await import('./invoke');

beforeEach(() => {
  capturedCtx = null;
  scope.registry.mockReset().mockResolvedValue({ projects: [{ slug: 'desktop-pot' }] });
});

describe('invokeServerCapability — EI-1751 callerSid attribution', () => {
  const employee = { kind: 'user' as const, slug: 'employee-id', workspaceId: 'ws1',
    authMethod: 'cookie-session' as const, trust: 'verified' as const, capabilities: new Set(['blueprint:submit']) };

  it('preserves the server-resolved actor and enforces its capabilities on direct and nested calls', async () => {
    await invokeServerCapability({ name: 'tools:invoke', harness: 'desktop-pot', authenticatedPrincipal: employee });
    expect(capturedCtx?.principal).toEqual(employee);
    expect(capturedCtx?.gateBypass?.capability).not.toBe(true);
    const dispatch = capturedCtx?.dispatchTool;
    await dispatch!('t:x', {});
    expect(capturedCtx?.principal).toEqual(employee);
    expect(capturedCtx?.gateBypass?.capability).not.toBe(true);
  });

  it('rejects a cookie actor from another workspace before dispatch', async () => {
    const result = await invokeServerCapability({ name: 't:x',
      authenticatedPrincipal: { ...employee, workspaceId: 'other-workspace' } });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'invalid_authenticated_principal' });
    expect(capturedCtx).toBeNull();
  });

  it('rejects a system identity passed as a cookie actor', async () => {
    const result = await invokeServerCapability({ name: 't:x',
      authenticatedPrincipal: { ...employee, kind: 'system', trust: 'trusted' } });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'invalid_authenticated_principal' });
    expect(capturedCtx).toBeNull();
  });

  it('no callerSid ⇒ ctx.uiClientId stays null (today\'s behavior)', async () => {
    const r = await invokeServerCapability({ name: 't:x' });
    expect(r.ok).toBe(true);
    expect(capturedCtx?.spawnId).toBe('palette');
    expect(capturedCtx?.uiClientId).toBeNull();
    expect(capturedCtx?.principal).toMatchObject({
      kind: 'system',
      slug: 'loopback',
      workspaceId: 'ws1',
      authMethod: 'process-internal',
      trust: 'trusted',
    });
    expect(capturedCtx?.principal?.capabilities.has('*')).toBe(true);
  });

  it('a callerSid is folded into ctx.uiClientId WITHOUT touching spawnId', async () => {
    const r = await invokeServerCapability({ name: 't:x', callerSid: 'pui-4242' });
    expect(r.ok).toBe(true);
    expect(capturedCtx?.spawnId).toBe('palette');
    expect(capturedCtx?.uiClientId).toBe('pui-4242');
  });

  it('binds the selected harness within the active workspace without changing the principal', async () => {
    const r = await invokeServerCapability({ name: 't:x', harness: ' desktop-pot ' });
    expect(r.ok).toBe(true);
    expect(scope.registry).toHaveBeenCalledWith('ws1');
    expect(capturedCtx).toMatchObject({
      workspaceId: 'ws1', harnessSlug: 'desktop-pot', spawnId: 'palette', role: 'operator', isSuperuser: false,
      principal: { slug: 'loopback', workspaceId: 'ws1', authMethod: 'process-internal' },
    });
  });

  it('preserves selected harness through nested tools:invoke dispatch', async () => {
    await invokeServerCapability({ name: 'tools:invoke', harness: 'desktop-pot', callerSid: 'pui-4242' });
    const dispatch = capturedCtx?.dispatchTool;
    expect(dispatch).toBeTypeOf('function');
    await dispatch!('t:x', {});
    expect(capturedCtx).toMatchObject({ harnessSlug: 'desktop-pot', workspaceId: 'ws1', uiClientId: 'pui-4242' });
  });

  it('refuses a harness absent from this workspace instead of searching other workspaces', async () => {
    const r = await invokeServerCapability({ name: 't:x', harness: 'other-workspace-pot' });
    expect(r).toMatchObject({ ok: false, status: 404, code: 'harness_not_found' });
    expect(scope.registry.mock.calls).toEqual([['ws1']]);
    expect(capturedCtx).toBeNull();
  });

  it.each(['', '   ', '*', 'all', 'x'.repeat(121)])('refuses invalid selected harness %j before dispatch', async (harness) => {
    const r = await invokeServerCapability({ name: 't:x', harness });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'invalid_harness' });
    expect(capturedCtx).toBeNull();
    expect(scope.registry).not.toHaveBeenCalled();
  });

  it('does not treat an unreadable registry as an absent harness or fall back to operator scope', async () => {
    scope.registry.mockRejectedValue(new Error('private datastore diagnostic'));
    const r = await invokeServerCapability({ name: 't:x', harness: 'desktop-pot' });
    expect(r).toMatchObject({ ok: false, status: 503, code: 'harness_registry_unavailable' });
    expect(JSON.stringify(r)).not.toContain('private datastore diagnostic');
    expect(capturedCtx).toBeNull();
  });
});
