import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { _resetCardCorrelatorForTests, registerCard } from '@papercusp/agent-mcp';
import type { SuSessionDescriptor } from '@papercusp/chat-protocol';
import { SuSessionHost, registerSuSessionHost, _resetSuSessionHostsForTest } from './su-session-host';
import type { DurableSuSessionRecord } from './su-session-persistence';
import { _configureSuSessionRoutingForTest, localSuSessionHostOwner, routeSuNativeCard,
  serveForwardedSuSessionOp } from './su-session-owner-routing';
import { nativeCardCorrelationId } from './su-session-native-card-identity';

const rpc = vi.hoisted(() => ({ call: vi.fn(), available: true }));
vi.mock('./cluster-owner-rpc', () => ({ callOwnerProcess: rpc.call,
  ownerRpcAvailable: () => rpc.available, registerOwnerRpcHandler: vi.fn() }));

function descriptor(backend: 'claude' | 'codex' = 'claude'): SuSessionDescriptor {
  const supported = { state: 'supported', implementation: 'native' } as const;
  const base: SuSessionDescriptor<'claude'> = { identity: { workspaceId: 'workspace', agentChatId: 'chat', advSessionId: 77, ownerId: 'owner',
    nativeSessionId: 'native-77', backend: 'claude', harnessSlug: 'fixture' }, runtimeGeneration: 3, lifecycle: 'ready',
    role: 'su', model: null, accountServed: null, accountRoute: 'default', carry: 'warm', modes: [],
    capabilities: { commands: { owner_turn: supported, interrupt: supported, resume: supported, fork: supported,
      focus: supported, end: supported }, features: { approvals: supported, compaction: supported, context: supported,
      'interactive-cards': supported, modes: supported, 'reasoning-stream': supported, 'tool-events': supported, usage: supported } },
    backendExtension: { backend: 'claude', configDir: null, configDirSource: null } };
  return backend === 'claude' ? base : { ...base, identity: { ...base.identity, backend: 'codex' },
    backendExtension: { backend: 'codex', codexHome: null } };
}
function row(d: SuSessionDescriptor): DurableSuSessionRecord {
  return { ...d.identity, descriptor: d, runtimeGeneration: d.runtimeGeneration, lifecycle: d.lifecycle,
    cwd: null, pid: process.pid, endedAt: null };
}
function fixture(backend: 'claude' | 'codex' = 'claude') {
  const d = descriptor(backend);
  const host = new SuSessionHost({ descriptor: d, executeCommand: async () => ({ status: 'completed' }) });
  registerSuSessionHost(host);
  _configureSuSessionRoutingForTest({ readOwner: async () => localSuSessionHostOwner(), readDurable: async () => row(d) });
  const correlationId = nativeCardCorrelationId('pui-native:77:3')!;
  const card = registerCard({ correlationId, workspaceId: 'workspace', runId: 'pui-native:77:3',
    spec: { prompt: 'Private', dataSchema: z.object({ value: z.string().min(3) }),
      privateLink: 'https://auth.example/?code=PRIVATE' } });
  const input = { workspaceId: 'workspace', agentChatId: 'chat', request: {
    kind: 'response' as const, correlationId, action: 'submit' as const, payload: { value: 'private-answer' } } };
  return { d, host, card, correlationId, input };
}

describe('P007 exact-incarnation private card routing', () => {
  beforeEach(() => { rpc.call.mockReset(); rpc.available = true; });
  afterEach(() => { _resetCardCorrelatorForTests(); _resetSuSessionHostsForTest(); _configureSuSessionRoutingForTest(); });

  it.each(['claude', 'codex'] as const)('validates a %s answer and closes private links without retaining its value', async backend => {
    const f = fixture(backend);
    expect(await routeSuNativeCard({ ...f.input, request: { ...f.input.request, payload: { value: 'x' } } }))
      .toEqual({ kind: 'response', ok: false, status: 400, error: 'payload does not match dataSchema' });
    const link = { workspaceId: 'workspace', request: { kind: 'link' as const, correlationId: f.correlationId } };
    expect(await routeSuNativeCard(link)).toEqual({ kind: 'link', target: 'https://auth.example/?code=PRIVATE' });
    expect(await routeSuNativeCard(f.input)).toEqual({ kind: 'response', ok: true });
    expect(await f.card.result).toEqual({ action: 'submit', payload: { value: 'private-answer' } });
    expect(await routeSuNativeCard(link)).toEqual({ kind: 'link', target: null });
    expect(await routeSuNativeCard(f.input)).toMatchObject({ ok: false, status: 404 });
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'chat', 'generation', 'owner', 'native', 'descriptor-only', 'nonce'])(
    'refuses %s mismatch before resolving a local private waiter', async mismatch => {
      const f = fixture();
      let input = f.input;
      if (mismatch === 'workspace') input = { ...input, workspaceId: 'foreign' };
      if (mismatch === 'chat') input = { ...input, agentChatId: 'foreign' };
      if (mismatch === 'generation') _configureSuSessionRoutingForTest({ readDurable: async () => ({ ...row(f.d), runtimeGeneration: 4 }) });
      if (mismatch === 'owner') f.d.identity.ownerId = 'replacement-owner';
      if (mismatch === 'native') f.d.identity.nativeSessionId = 'replacement-native';
      if (mismatch === 'owner' || mismatch === 'native') {
        const original = descriptor();
        _configureSuSessionRoutingForTest({ readOwner: async () => localSuSessionHostOwner(), readDurable: async () => row(original) });
        // SuSessionHost snapshots its descriptor; register the replacement explicitly.
        _resetSuSessionHostsForTest();
        registerSuSessionHost(new SuSessionHost({ descriptor: f.d, executeCommand: async () => ({ status: 'completed' }) }));
      }
      if (mismatch === 'descriptor-only') {
        _resetSuSessionHostsForTest(); registerSuSessionHost(new SuSessionHost({ descriptor: f.d }));
      }
      if (mismatch === 'nonce') _configureSuSessionRoutingForTest({ readOwner: async () => ({ ...localSuSessionHostOwner(), nonce: 'recycled' }),
        readDurable: async () => row(f.d) });
      let delivered = false; void f.card.result.then(() => { delivered = true; });
      if (['workspace', 'chat', 'generation'].includes(mismatch)) expect(await routeSuNativeCard(input)).toBeNull();
      else await expect(routeSuNativeCard(input)).rejects.toMatchObject({ code: 'not_owner' });
      expect(delivered).toBe(false); expect(rpc.call).not.toHaveBeenCalled();
    });

  it.each(['owner_gone', 'timeout', 'handler_error', 'send_failed', 'no_handler'])(
    'never falls back locally after a remote %s', async code => {
      const f = fixture(), owner = { ...localSuSessionHostOwner(), pid: process.pid + 1 };
      _configureSuSessionRoutingForTest({ readOwner: async () => owner, readDurable: async () => row(f.d) });
      rpc.call.mockResolvedValue({ ok: false, code });
      let delivered = false; void f.card.result.then(() => { delivered = true; });
      await expect(routeSuNativeCard(f.input)).rejects.toMatchObject({ code });
      expect(delivered).toBe(false); expect(rpc.call).toHaveBeenCalledOnce();
      const payload = rpc.call.mock.calls[0][0].payload;
      expect(JSON.stringify(payload)).not.toContain('https://auth.example');
      expect(payload.request.op).toBe('native-card');
    });

  it('the receiving owner verifies lineage, generation and run binding and never forwards twice', async () => {
    const f = fixture(), owner = { ...localSuSessionHostOwner(), pid: process.pid + 1 };
    _configureSuSessionRoutingForTest({ readOwner: async () => owner, readDurable: async () => row(f.d) });
    rpc.call.mockImplementation(async ({ payload }) => ({ ok: true, result: await serveForwardedSuSessionOp(payload) }));
    expect(await routeSuNativeCard(f.input)).toEqual({ kind: 'response', ok: true });
    expect(rpc.call).toHaveBeenCalledOnce();
    const payload = rpc.call.mock.calls[0][0].payload;
    expect(await serveForwardedSuSessionOp({ ...payload, nonce: 'foreign' })).toEqual({ status: 'not_owner' });
    expect(await serveForwardedSuSessionOp({ ...payload, address: { ...payload.address, runtimeGeneration: 4 },
      request: { op: 'native-card', body: { ...payload.request.body,
        correlationId: nativeCardCorrelationId('pui-native:77:4') } } })).toEqual({ status: 'absent' });
  });

  it('never resolves another run even when its public correlation hint matches the live incarnation', async () => {
    const f = fixture(); _resetCardCorrelatorForTests();
    const foreign = registerCard({ correlationId: f.correlationId, workspaceId: 'workspace', runId: 'foreign-run',
      spec: { prompt: 'Foreign', privateLink: 'https://auth.example/?code=FOREIGN', dataSchema: z.object({ value: z.string() }) } });
    expect(await routeSuNativeCard(f.input)).toMatchObject({ ok: false, status: 404 });
    expect(await routeSuNativeCard({ workspaceId: 'workspace', request: { kind: 'link', correlationId: f.correlationId } }))
      .toEqual({ kind: 'link', target: null });
    let settled = false; void foreign.result.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
  });
});
