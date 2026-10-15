import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuSessionCapabilities, SuSessionDescriptor } from '@papercusp/chat-protocol';
import { SuSessionHost, registerSuSessionHost, getRegisteredSuSessionHost, _resetSuSessionHostsForTest } from './su-session-host';
import {
  _configureSuSessionRoutingForTest, localSuSessionHostOwner, registerSuNativeToolDispatcher,
  runOnSuNativeToolOwner, serveForwardedSuSessionOp, SuNativeToolOwnerError,
  SU_SESSION_HOST_RPC_KIND, type SuNativeToolAddress,
} from './su-session-owner-routing';

const rpc = vi.hoisted(() => ({ call: vi.fn(), available: true }));
vi.mock('./cluster-owner-rpc', () => ({
  callOwnerProcess: rpc.call, ownerRpcAvailable: () => rpc.available, registerOwnerRpcHandler: vi.fn(),
}));

const nativeId = 'native-thread-77';
const address: SuNativeToolAddress = {
  workspaceId: 'fixture-workspace', advSessionId: 77, ownerId: 'su-fixture',
  nativeSessionIdFingerprint: createHash('sha256').update(nativeId).digest('hex'),
};
const supported = { state: 'supported', implementation: 'native' } as const;
const capabilities: SuSessionCapabilities = {
  commands: { owner_turn: supported, interrupt: supported, resume: supported, fork: supported, focus: supported, end: supported },
  features: { 'tool-events': supported, 'interactive-cards': supported, 'reasoning-stream': supported,
    usage: supported, compaction: supported, approvals: supported, context: supported, modes: supported },
};
function descriptor(over: Partial<SuSessionDescriptor<'codex'>['identity']> = {}): SuSessionDescriptor<'codex'> {
  return { identity: { agentChatId: 'same-chat', advSessionId: address.advSessionId, backend: 'codex',
    nativeSessionId: nativeId, ownerId: address.ownerId, workspaceId: address.workspaceId, harnessSlug: 'fixture', ...over },
  lifecycle: 'ready', runtimeGeneration: 1, role: 'su', model: null, accountServed: null,
  accountRoute: 'default', carry: 'warm', modes: [], capabilities, backendExtension: { backend: 'codex', codexHome: null } };
}
function attach(over: Partial<SuSessionDescriptor<'codex'>['identity']> = {}, runtime = true) {
  const host = new SuSessionHost({ descriptor: descriptor(over),
    ...(runtime ? { executeCommand: async () => ({ status: 'completed' as const }) } : {}) });
  registerSuSessionHost(host);
  return host;
}
const request = { toolName: 'tools:invoke', args: { name: 'paid:work', args: {} }, callIdFingerprint: 'original-call' };

describe('D-063 whole native MCP dispatch owner routing', () => {
  beforeEach(() => { rpc.call.mockReset(); rpc.available = true; _configureSuSessionRoutingForTest({ readOwner: async () => null }); });
  afterEach(() => { _resetSuSessionHostsForTest(); _configureSuSessionRoutingForTest(); });

  it('reads the exact adv row, never the latest chat incarnation, and keeps the ordinary unowned path', async () => {
    const readOwner = vi.fn(async () => null);
    _configureSuSessionRoutingForTest({ readOwner });
    const local = vi.fn(async () => 'ordinary-admission');
    expect(await runOnSuNativeToolOwner(address, request, local)).toBe('ordinary-admission');
    expect(readOwner).toHaveBeenCalledWith({ workspaceId: address.workspaceId, advSessionId: 77 });
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('runs a locally owned exact live incarnation once', async () => {
    attach();
    _configureSuSessionRoutingForTest({ readOwner: async () => localSuSessionHostOwner() });
    const local = vi.fn(async () => 'local');
    expect(await runOnSuNativeToolOwner(address, request, local)).toBe('local');
    expect(local).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ advSessionId: 78 }, true], [{ ownerId: 'another-owner' }, true],
    [{ nativeSessionId: 'replacement-thread' }, true], [{ workspaceId: 'other-workspace' }, true], [{}, false],
  ] as const)('refuses a stale/foreign/descriptor-only local runtime (%j, runtime %s)', async (identity, runtime) => {
    attach(identity, runtime);
    _configureSuSessionRoutingForTest({ readOwner: async () => localSuSessionHostOwner() });
    const local = vi.fn();
    await expect(runOnSuNativeToolOwner(address, request, local)).rejects.toMatchObject({ code: 'not_owner' });
    expect(local).not.toHaveBeenCalled();
  });

  it('rejects a recycled local pid with another nonce', async () => {
    attach();
    _configureSuSessionRoutingForTest({ readOwner: async () => ({ ...localSuSessionHostOwner(), nonce: 'old-process' }) });
    const local = vi.fn();
    await expect(runOnSuNativeToolOwner(address, request, local)).rejects.toMatchObject({ code: 'not_owner' });
    expect(local).not.toHaveBeenCalled();
  });

  it('forwards the entire original wrapper request and returns only the owner result', async () => {
    const owner = { ...localSuSessionHostOwner(), pid: process.pid + 1, nonce: 'remote-owner' };
    _configureSuSessionRoutingForTest({ readOwner: async () => owner });
    rpc.call.mockResolvedValue({ ok: true, result: { status: 'ok', result: { paid: 'owner-observation' } } });
    const local = vi.fn();
    expect(await runOnSuNativeToolOwner(address, request, local, 1234)).toEqual({ paid: 'owner-observation' });
    expect(rpc.call).toHaveBeenCalledWith({ targetPid: owner.pid, kind: SU_SESSION_HOST_RPC_KIND,
      payload: { address, hostId: owner.hostId, nonce: owner.nonce, request: { op: 'native-tool', body: request } }, timeoutMs: 1234 });
    expect(local).not.toHaveBeenCalled();
  });

  it.each(['owner_gone', 'no_handler', 'not_clustered', 'timeout', 'handler_error', 'send_failed'] as const)(
    'never falls back after remote %s and preserves outcome uncertainty', async code => {
      _configureSuSessionRoutingForTest({ readOwner: async () => ({ ...localSuSessionHostOwner(), pid: process.pid + 1 }) });
      rpc.call.mockResolvedValue({ ok: false, code, message: code });
      const local = vi.fn();
      let error: unknown;
      try { await runOnSuNativeToolOwner(address, request, local); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(SuNativeToolOwnerError);
      expect(error).toMatchObject({ code, outcomeUnknown: ['timeout', 'handler_error', 'send_failed'].includes(code) });
      expect(local).not.toHaveBeenCalled();
    });

  it.each(['absent', 'not_owner'] as const)('refuses owner %s without dispatching locally', async status => {
    _configureSuSessionRoutingForTest({ readOwner: async () => ({ ...localSuSessionHostOwner(), pid: process.pid + 1 }) });
    rpc.call.mockResolvedValue({ ok: true, result: { status } });
    const local = vi.fn();
    await expect(runOnSuNativeToolOwner(address, request, local)).rejects.toMatchObject({ code: status });
    expect(local).not.toHaveBeenCalled();
  });

  it('the owner checks its nonce and live lineage before dispatch and never forwards again', async () => {
    attach();
    const dispatch = vi.fn(async () => ({ content: [{ type: 'text', text: 'owner-result' }] }));
    registerSuNativeToolDispatcher(dispatch);
    const owner = localSuSessionHostOwner();
    const payload = { address, hostId: owner.hostId, nonce: owner.nonce, request: { op: 'native-tool', body: request } };
    expect(await serveForwardedSuSessionOp({ ...payload, nonce: 'recycled' })).toEqual({ status: 'not_owner' });
    expect(await serveForwardedSuSessionOp({ ...payload, address: { ...address, ownerId: 'foreign' } })).toEqual({ status: 'absent' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await serveForwardedSuSessionOp(payload)).toEqual({ status: 'ok', result: { content: [{ type: 'text', text: 'owner-result' }] } });
    expect(dispatch).toHaveBeenCalledWith(request, address);
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('exact registry lookup does not select a new incarnation of the same chat', () => {
    attach({ advSessionId: 78 });
    expect(getRegisteredSuSessionHost({ workspaceId: address.workspaceId, advSessionId: 77 })).toBeNull();
    expect(getRegisteredSuSessionHost({ workspaceId: address.workspaceId, advSessionId: 78 })?.descriptor().identity.advSessionId).toBe(78);
  });
});
