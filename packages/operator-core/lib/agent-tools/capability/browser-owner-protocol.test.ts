import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => ({ locate: vi.fn(), call: vi.fn() }));
vi.mock('../../cluster-owner-rpc', () => ({ bindOwnerRpcResource: vi.fn(), locateOwnerRpcResource: rpc.locate,
  callOwnerProcess: rpc.call, registerOwnerRpcHandler: vi.fn() }));
import { runManagedBrowserSession } from './browser-owner';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
const id = 'f3e23fb1-7d32-49e8-af81-6cba0744e9d1';
const ctx = { uiClientId: 'browser-protocol-owner', workspaceId: 'browser-protocol-workspace', isSuperuser: true,
  harnessSlug: '*', role: 'operator', signal: new AbortController().signal, log: () => {}, authenticatedPrincipal: () => 'opaque' } as unknown as UnifiedToolContext;
const opts = { timeoutMs: 20, maxText: 500 };
const call = async () => JSON.parse((await runManagedBrowserSession({ op: 'observe', id }, undefined, ctx, opts)).content[0].text!);
beforeEach(() => { rpc.locate.mockReset(); rpc.call.mockReset(); });
describe('browser placement failure truth', () => {
  it('does not label a placement timeout as lost state', async () => {
    rpc.locate.mockResolvedValue({ ok: false, code: 'timeout', message: 'slow primary' });
    const out = await call(); expect(out.error).toBe('browser_owner_unreachable:timeout');
    expect(out.restartRecovery).toBeUndefined(); expect(rpc.call).not.toHaveBeenCalled();
  });
  it('distinguishes live owner timeout, sends cancellation, and never transports principal', async () => {
    rpc.locate.mockResolvedValue({ ok: true, result: { ownerPid: process.pid + 1 } });
    rpc.call.mockResolvedValue({ ok: false, code: 'timeout', message: 'slow worker' });
    const out = await call(); expect(out.error).toBe('browser_owner_unreachable:timeout');
    expect(out.restartRecovery).toBeUndefined();
    expect(rpc.call.mock.calls[0][0].payload.caller).toEqual({ workspaceId: ctx.workspaceId, ownerId: ctx.uiClientId, harnessSlug: undefined, role: 'operator' });
    expect(rpc.call.mock.calls[1][0].payload.op).toBe('abort');
  });
  it('reports unrecoverability only after the relay measures a gone/foreign owner', async () => {
    rpc.locate.mockResolvedValue({ ok: false, code: 'owner_gone', message: 'unknown scoped handle' });
    expect(await call()).toMatchObject({ error: 'browser_unrecoverable', restartRecovery: 'unrecoverable' });
  });
});
