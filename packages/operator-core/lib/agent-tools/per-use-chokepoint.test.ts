import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { registerProjectedTool, unregisterProjectedToolsForPlugin,
  runDispatchStack, type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import { admitInstalledPerUseToolTurn, attachedInstalledToolLifecycle, createInstalledPerUseChokepoint, NativeInstalledPerUseTurns,
  nativeInstalledPerUseTurns, type AdmittedPerUseToolTurn } from './per-use-chokepoint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { FundedToolTurnBinding, FundedToolTurnResult } from '../cupboard/funded-tool-turn-store';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import { readInstalledPluginProvenance } from '../cupboard/install-plugin-core';
import type { InstalledPluginProvenance } from '../cupboard/types';
import type { readInstalledPluginCommerceProvenance } from '../cupboard/install-io';
import { declareMeter, LocalMeteredTurn, type LocalMeteredTurnState } from '../p2p/metered-invocation';
import { createMicrochargeChannel } from '../p2p/microcharge';
import { signPaymentTestBytes } from '../p2p/_payment-voucher-fixture';
import invokeTool, { NestedToolRefusalError } from './tools/invoke';
import type { ToolResult } from '@papercusp/tooldef';
import { verifyNativeRuntimeBearer } from '@papercusp/agent-mcp/provisioning';

type IdentityLifecycleAdmit = NonNullable<Parameters<NativeInstalledPerUseTurns['nativeLifecycle']>[0]['identityLifecycle']>['admit'];

vi.mock('../cupboard/install-plugin-core', () => ({ readInstalledPluginProvenance: vi.fn() }));
vi.mock('@papercusp/agent-mcp/provisioning', () => ({ verifyNativeRuntimeBearer: vi.fn() }));

const terms = { unitPriceMicros: 250, meterUnit: 'tool-call', priceVersion: 'v1',
  splitManifestHash: `sha256:${'a'.repeat(64)}` };
const provenance: InstalledPluginProvenance = {
  schema: 'papercusp.plugin-installation/v1', name: 'paid-plugin', version: '1.0.0',
  contentFingerprint: 'b'.repeat(64), hadListing: true, contentSource: 'r2',
  listing: { listingId: 'listing-paid', githubUrl: 'https://github.com/seller/tool', ref: '.',
    publisherId: 'gh:4242', skuRef: 'opaque-paid-sku', releaseVersion: '1.0.0',
    priceModel: 'per-use', releaseContentHash: 'c'.repeat(64) },
};
const ctx = (): UnifiedToolContext => ({ log: vi.fn(), signal: new AbortController().signal,
  progress: vi.fn(), emit: vi.fn(), workspaceId: 'workspace', role: 'worker',
  principal: { slug: 'target-agent', workspaceId: 'workspace', trust: 'verified', capabilities: new Set() },
}) as UnifiedToolContext;
const tool = (fn = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'served' }] }))): ProjectedTool => ({
  pluginName: provenance.name, pluginInstallation: { version: provenance.version, path: '/loaded/plugin', source: 'project' },
  description: 'paid tool', capabilities: [], inputSchema: { type: 'object' },
  expose: { mcp: { name: 'paid.run' }, http: { path: '/api/plugins/paid/run' } }, fn,
});

describe('host-local native request principal', () => {
  const fp = (value: string) => createHash('sha256').update(value).digest('hex');
  async function fixture(args: unknown = { harness: 'selected', resource: 'private' }) {
    const registry = new NativeInstalledPerUseTurns();
    const principal = { kind: 'system' as const, slug: 'system:superuser', workspaceId: 'workspace',
      trust: 'trusted' as const, authMethod: 'bearer-token' as const, capabilities: new Set(['*']) };
    const resolve = vi.fn(async () => principal);
    const hooks = registry.register({ workspaceId: 'workspace', ownerId: 'host-owner',
      principalId: 'synthetic-commerce-only', advSessionId: 7, nativeSessionId: 'native-session',
      ownerTurnId: 'owner-turn', mcpServer: 'papercusp-su', nativeTools: { core_read: 'core:read',
        tools_invoke: 'tools:invoke' }, admissions: [], resolveRequestPrincipal: resolve });
    await hooks.bindNativeTurn('native-turn');
    const observation = { nativeTurnId: 'native-turn', callId: 'call', server: 'papercusp-su', tool: 'core_read', arguments: args };
    await hooks.observeToolCall!(observation);
    const input = { workspaceId: 'workspace', ownerId: 'host-owner', advSessionId: 7,
      nativeSessionFingerprint: fp('native-session'), callIdFingerprint: fp('call'),
      toolName: 'core:read', arguments: args, runtimeBearer: 'r'.repeat(43) };
    vi.mocked(verifyNativeRuntimeBearer).mockResolvedValue(true);
    return { registry, principal, resolve, hooks, observation, input };
  }

  it('uses the genuine request principal for one exact core call with independent possession', async () => {
    const f = await fixture();
    const principal = await f.registry.resolveRequestPrincipal(f.input);
    expect(principal).toEqual(f.principal);
    expect(principal!.slug).not.toBe('synthetic-commerce-only');
    expect(verifyNativeRuntimeBearer).toHaveBeenLastCalledWith(f.input.runtimeBearer,
      { workspaceId: 'workspace', ownerId: 'host-owner', advSessionId: 7, provider: 'codex' });
    expect(await f.registry.resolveRequestPrincipal(f.input)).toBeNull();
    expect(f.resolve).toHaveBeenCalledOnce();
    (principal!.capabilities as Set<string>).clear();
    expect(f.principal.capabilities.has('*')).toBe(true);
    await f.hooks.withdraw();
  });

  it.each([
    { workspaceId: 'other' }, { ownerId: 'other' }, { advSessionId: 8 },
    { nativeSessionFingerprint: fp('other') }, { callIdFingerprint: fp('other') },
    { toolName: 'other:read' }, { toolName: 'tools:invoke' }, { toolName: 'code:run' },
    { arguments: { harness: 'selected', resource: 'different' } }, { arguments: null },
  ])('refuses changed exact-call binding %j before resolving authority', async changes => {
    const f = await fixture();
    expect(await f.registry.resolveRequestPrincipal({ ...f.input, ...changes })).toBeNull();
    expect(f.resolve).not.toHaveBeenCalled();
    await f.hooks.withdraw();
  });

  it('does not let legacy missing arguments or a wrapper borrow direct-call authority', async () => {
    const f = await fixture(undefined);
    // Explicit undefined bypasses the fixture default only on the observation.
    await f.hooks.observeToolCall!({ ...f.observation, callId: 'legacy', arguments: undefined });
    expect(await f.registry.resolveRequestPrincipal({ ...f.input, callIdFingerprint: fp('legacy'), arguments: {} })).toBeNull();
    await f.hooks.observeToolCall!({ ...f.observation, callId: 'wrapper', tool: 'tools_invoke', arguments: { name: 'core:read', args: f.input.arguments } });
    expect(await f.registry.resolveRequestPrincipal({ ...f.input, callIdFingerprint: fp('wrapper') })).toBeNull();
    expect(f.resolve).not.toHaveBeenCalled(); await f.hooks.withdraw();
  });

  it('refuses absent possession, revoked principal, and disposal during each awaited check', async () => {
    const absent = await fixture();
    vi.mocked(verifyNativeRuntimeBearer).mockResolvedValue(false);
    expect(await absent.registry.resolveRequestPrincipal(absent.input)).toBeNull();
    expect(absent.resolve).not.toHaveBeenCalled(); await absent.hooks.withdraw();
    const revoked = await fixture();
    revoked.resolve.mockRejectedValueOnce(new Error('revoked'));
    expect(await revoked.registry.resolveRequestPrincipal(revoked.input)).toBeNull(); await revoked.hooks.withdraw();
    for (const phase of ['possession', 'principal']) {
      const f = await fixture();
      let release!: () => void, entered!: () => void;
      const started = new Promise<void>(done => { entered = done; });
      const wait = async () => { entered(); await new Promise<void>(done => { release = done; }); };
      if (phase === 'possession') vi.mocked(verifyNativeRuntimeBearer).mockImplementationOnce(async () => { await wait(); return true; });
      else f.resolve.mockImplementationOnce(async () => { await wait(); return f.principal; });
      const pending = f.registry.resolveRequestPrincipal(f.input);
      await started; await f.hooks.withdraw(); release(); expect(await pending).toBeNull();
    }
  });

  it('reserves an exact call before asynchronous verification so concurrent requests cannot share it', async () => {
    const f = await fixture();
    let release!: (value: boolean) => void;
    vi.mocked(verifyNativeRuntimeBearer).mockImplementationOnce(() => new Promise(done => { release = done; }));
    const first = f.registry.resolveRequestPrincipal(f.input);
    expect(await f.registry.resolveRequestPrincipal(f.input)).toBeNull();
    release(true); expect(await first).toEqual(f.principal); await f.hooks.withdraw();
  });

  it('still requires the existing dispatcher resource ACL after resolving a genuine principal', async () => {
    const f = await fixture(), principal = await f.registry.resolveRequestPrincipal(f.input);
    const target: ProjectedTool = { ...tool(), pluginInstallation: undefined,
      authorize: vi.fn(async ({ principal: actual, input }) => {
        expect(actual?.slug).toBe('system:superuser'); expect(input).toEqual(f.input.arguments);
        return { allow: false, reason: 'resource revoked' };
      }) };
    const result = await runDispatchStack(target, 'core:read', f.input.arguments, { ...ctx(), principal: principal! }, {});
    expect(result).toMatchObject({ ok: false, error: { code: 'authorization_denied' } });
    expect(target.fn).not.toHaveBeenCalled(); await f.hooks.withdraw();
  });
});

describe('trusted observed native call lookup', () => {
  const fp = (value: string) => createHash('sha256').update(value).digest('hex');
  function nativeFixture(registry = new NativeInstalledPerUseTurns(), verifyCurrentAuthority?: () => Promise<void>) {
    const base = admitted(), { turn } = base;
    const authority = { ...base.authority, verifyCurrentAuthority };
    const binding: FundedToolTurnBinding = { kind: 'tool', workspaceId: 'workspace', ownerId: 'host-owner',
      principalId: 'target-agent', executionId: 'native-session', admissionId: 'owner-turn',
      provenanceHash: fp(canonicalJson(provenance)), payer: authority.payer, seller: authority.offer.creatorId,
      channelId: 'funded-channel', offer: authority.offer, quantityCeiling: 4n, expiresAtMs: 10_000 };
    const input = { workspaceId: 'workspace', ownerId: 'host-owner', principalId: 'target-agent',
      nativeSessionId: 'native-session', ownerTurnId: 'owner-turn', advSessionId: 7,
      mcpServer: 'papercusp-su', nativeTools: { paid_run: 'paid.run', tools_invoke: 'tools:invoke' },
      admissions: [{ ok: true as const, admission: authority, turnId: 'host-turn', binding }] };
    const context = ctx();
    Object.assign(context, { advSessionId: 7, uiClientId: 'host-owner',
      requestOrigin: { transport: 'mcp', nativeSession: { carrier: 'meta:threadId', binding: 'bound',
        valueFingerprint: fp('native-session'), callIdFingerprint: fp('native-call'), candidateAdvSessionId: 7 } } });
    const hooks = registry.register(input);
    const observation = { nativeTurnId: 'native-turn', callId: 'native-call', server: 'papercusp-su', tool: 'paid_run' };
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: request => registry.resolve(request) });
    const observe = async (changes: Partial<typeof observation> = {}) => {
      await hooks.bindNativeTurn('native-turn');
      await hooks.observeToolCall!({ ...observation, ...changes });
    };
    return { registry, input, context, hooks, observe, observation, aroundInvoke, turn };
  }

  it('production consumes the exact observed native call once across different dispatch nonces', async () => {
    const f = nativeFixture(nativeInstalledPerUseTurns);
    vi.mocked(readInstalledPluginProvenance).mockResolvedValue(provenance);
    try {
      await f.observe();
      const target = tool();
      expect((await execute(target, PROJECTED_DEPS.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
      expect((await execute(target, PROJECTED_DEPS.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
      expect(target.fn).toHaveBeenCalledOnce();
      expect(Object.values(f.turn.snapshot().units)).toHaveLength(1);
      expect(Object.keys(f.turn.snapshot().units)[0]).not.toBe('native-call');
    } finally { await f.hooks.withdraw(); }
  });

  it('a host authority refusal withdraws the cohort and preserves already served units', async () => {
    const refresh = vi.fn(async () => {}), f = nativeFixture(undefined, refresh);
    await f.observe();
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
    const units = f.turn.snapshot().units;
    refresh.mockRejectedValueOnce(new Error('hosted entitlement revoked'));
    await f.observe({ callId: 'revoked-call' });
    f.context.requestOrigin!.nativeSession!.callIdFingerprint = fp('revoked-call');
    const refused = await execute(target, f.aroundInvoke, { entitled: true }, f.context);
    expect(refused.result?.isError).toBe(true);
    expect(JSON.stringify(refused.result)).toContain('tool_current_authority_required');
    expect(target.fn).toHaveBeenCalledOnce();
    expect(f.turn.snapshot()).toMatchObject({ admissionClosed: true, units });
    await expect(f.observe({ callId: 'later-call' })).rejects.toThrow('original bound turn');
  });

  it('a successful authority read cannot resurrect an externally revoked cohort', async () => {
    let release!: () => void, started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const refresh = vi.fn(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
    const f = nativeFixture(undefined, refresh); await f.observe();
    const target = tool(), pending = execute(target, f.aroundInvoke, {}, f.context);
    await reading;
    await f.registry.revoke({ workspaceId: 'workspace', principalId: 'target-agent', target: { kind: 'principal' } });
    release();
    expect((await pending).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled(); expect(f.turn.snapshot().units).toEqual({});
  });

  it('failed withdrawal persistence retains the refusal tombstone and holds', async () => {
    const f = nativeFixture(undefined, async () => { throw new Error('authority unavailable'); });
    await f.observe();
    const stop = vi.spyOn(f.turn, 'stopAdmission').mockRejectedValueOnce(new Error('stop persistence failed'));
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
    expect(target.fn).not.toHaveBeenCalled(); expect(f.turn.snapshot().units).toEqual({});
    stop.mockRestore(); await f.hooks.withdraw();
  });

  it('native metadata and forged arguments without a trusted observation grant no execution', async () => {
    const f = nativeFixture(), target = tool(); await f.hooks.bindNativeTurn('native-turn');
    const result = await execute(target, f.aroundInvoke, { funded: true, callId: 'native-call', entitled: true }, f.context);
    expect(result.result?.isError).toBe(true); expect(target.fn).not.toHaveBeenCalled();
    expect(f.turn.snapshot().units).toEqual({});
  });

  it.each(['binding', 'carrier', 'session', 'call', 'adv-session', 'context-adv-session', 'owner', 'principal', 'workspace', 'trust']) (
    'refuses changed %s lineage without consuming the original observation', async kind => {
      const f = nativeFixture(); await f.observe();
      const changed = { ...f.context, principal: { ...f.context.principal! },
        requestOrigin: { ...f.context.requestOrigin!, nativeSession: { ...f.context.requestOrigin!.nativeSession! } } };
      const native = changed.requestOrigin.nativeSession;
      if (kind === 'binding') native.binding = 'unbound';
      if (kind === 'carrier') native.carrier = 'header:x-papercusp-native-session';
      if (kind === 'session') native.valueFingerprint = fp('other-session');
      if (kind === 'call') native.callIdFingerprint = fp('other-call');
      if (kind === 'adv-session') native.candidateAdvSessionId = 8;
      if (kind === 'context-adv-session') changed.advSessionId = 8;
      if (kind === 'owner') changed.uiClientId = 'other-owner';
      if (kind === 'principal') changed.principal.slug = 'other-agent';
      if (kind === 'workspace') changed.workspaceId = 'other-workspace';
      if (kind === 'trust') changed.principal.trust = 'unverified-loopback';
      const target = tool();
      expect((await execute(target, f.aroundInvoke, {}, changed)).result?.isError).toBe(true);
      expect(target.fn).not.toHaveBeenCalled();
      expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
      expect(target.fn).toHaveBeenCalledOnce();
    });

  it('does not associate a foreign MCP server or unknown tool with the funded host', async () => {
    const f = nativeFixture(), target = tool();
    await f.observe({ server: 'other-server' }); await f.observe({ tool: 'unknown' });
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
    await f.observe();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
  });

  it('requires the exact native turn before observations and refuses rebinding', async () => {
    const f = nativeFixture();
    await expect(f.hooks.observeToolCall!(f.observation)).rejects.toThrow('original active bound turn');
    await f.hooks.bindNativeTurn('native-turn');
    await expect(f.hooks.observeToolCall!({ ...f.observation, nativeTurnId: 'other-turn' })).rejects.toThrow('original active bound turn');
    await expect(f.hooks.bindNativeTurn('other-turn')).rejects.toThrow('original bound turn');
    await f.observe();
    await expect(f.hooks.observeToolCall!({ ...f.observation, tool: 'tools_invoke' })).rejects.toThrow('changed its target');
  });

  it('direct target observation cannot authorize another target or an indirect dispatch', async () => {
    const f = nativeFixture(); await f.observe();
    const target = tool();
    const other = await runDispatchStack(target, 'paid.other', {}, f.context, { aroundInvoke: f.aroundInvoke });
    expect(other.result?.isError).toBe(true);
    expect((await execute(target, f.aroundInvoke, {}, { ...f.context, indirectDispatch: true })).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
  });

  it('retains exact argument identity and withdraws on a conflicting re-observation', async () => {
    const f = nativeFixture(); await f.hooks.bindNativeTurn('native-turn');
    const args = { nested: { original: true }, harness: 'selected' };
    await f.hooks.observeToolCall!({ ...f.observation, arguments: args });
    args.nested.original = false;
    await expect(f.hooks.observeToolCall!({ ...f.observation,
      arguments: { harness: 'selected', nested: { original: true } } })).resolves.toBeUndefined();
    await expect(f.hooks.observeToolCall!({ ...f.observation, arguments: args }))
      .rejects.toThrow('changed its arguments');
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
    await f.hooks.withdraw();
  });

  it('a conflicting target observation withdraws the original call before dispatch', async () => {
    const f = nativeFixture(), target = tool();
    await f.observe();
    await expect(f.hooks.observeToolCall!({ ...f.observation, tool: 'tools_invoke' }))
      .rejects.toThrow('changed its target');
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
    expect(f.turn.snapshot().units).toEqual({});
    await f.hooks.withdraw();
  });

  it('tools:invoke observation grants one indirect funded target and cannot be reused', async () => {
    const f = nativeFixture(); await f.observe({ tool: 'tools_invoke' });
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    const outer = { ...f.context, dispatchTool: async (_name: string, args: unknown) =>
      (await execute(target, f.aroundInvoke, args, { ...f.context, indirectDispatch: true })).result! };
    const wrapper = invokeTool as unknown as { handler(args: { name: string }, context: UnifiedToolContext): Promise<ToolResult> };
    expect((await wrapper.handler({ name: 'paid.run' }, outer)).isError).not.toBe(true);
    await expect(wrapper.handler({ name: 'paid.run' }, outer)).rejects.toBeInstanceOf(NestedToolRefusalError);
    expect(target.fn).toHaveBeenCalledOnce();
  });

  it('a direct observed call cannot substitute resources or lose its exact argument payload', async () => {
    const f = nativeFixture(), target = tool();
    await f.hooks.bindNativeTurn('native-turn');
    const args = { harness: 'original', nested: { id: 7 } };
    await f.hooks.observeToolCall!({ ...f.observation, arguments: args });
    for (const input of [{}, { ...args, harness: 'other' }, { ...args, nested: { id: 8 } }]) {
      expect((await execute(target, f.aroundInvoke, input, f.context)).result?.isError).toBe(true);
    }
    expect(target.fn).not.toHaveBeenCalled();
    expect(f.turn.snapshot().units).toEqual({});
    expect((await execute(target, f.aroundInvoke,
      { nested: { id: 7 }, harness: 'original' }, f.context)).result?.isError).not.toBe(true);
    expect(target.fn).toHaveBeenCalledOnce();
    await f.hooks.withdraw();
  });

  it('an observed tools:invoke call binds both its exact target and target arguments', async () => {
    const f = nativeFixture(), target = tool();
    await f.hooks.bindNativeTurn('native-turn');
    const args = { harness: 'original', id: 7 };
    await f.hooks.observeToolCall!({ ...f.observation, tool: 'tools_invoke',
      arguments: { name: 'paid.run', args } });
    const context = { ...f.context, indirectDispatch: true };
    const other = await runDispatchStack(target, 'paid.other', args, context, { aroundInvoke: f.aroundInvoke });
    expect(other.result?.isError).toBe(true);
    expect((await execute(target, f.aroundInvoke, { ...args, harness: 'other' }, context)).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
    expect(f.turn.snapshot().units).toEqual({});
    expect((await execute(target, f.aroundInvoke, args, context)).result?.isError).not.toBe(true);
    expect((await execute(target, f.aroundInvoke, args, context)).result?.isError).toBe(true);
    expect(target.fn).toHaveBeenCalledOnce();
    await f.hooks.withdraw();
  });

  it('an observed wrapper with omitted args binds the empty object only', async () => {
    const f = nativeFixture(), target = tool();
    await f.hooks.bindNativeTurn('native-turn');
    await f.hooks.observeToolCall!({ ...f.observation, tool: 'tools_invoke', arguments: { name: 'paid.run' } });
    const context = { ...f.context, indirectDispatch: true };
    expect((await execute(target, f.aroundInvoke, { injected: true }, context)).result?.isError).toBe(true);
    expect((await execute(target, f.aroundInvoke, {}, context)).result?.isError).not.toBe(true);
    expect(target.fn).toHaveBeenCalledOnce();
    await f.hooks.withdraw();
  });

  it.each([null, [], 'invalid'])('malformed observed wrapper args cannot authorize an empty dispatch (%j)', async args => {
    const f = nativeFixture(), target = tool();
    await f.hooks.bindNativeTurn('native-turn');
    await f.hooks.observeToolCall!({ ...f.observation, tool: 'tools_invoke', arguments: { name: 'paid.run', args } });
    expect((await execute(target, f.aroundInvoke, {}, { ...f.context, indirectDispatch: true })).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
    expect(f.turn.snapshot().units).toEqual({});
    await f.hooks.withdraw();
  });

  it('parallel duplicate requests elect only one dispatch', async () => {
    const f = nativeFixture(), target = tool(); await f.observe();
    const results = await Promise.all([execute(target, f.aroundInvoke, {}, f.context), execute(target, f.aroundInvoke, {}, f.context)]);
    expect(results.filter(result => result.result?.isError === true)).toHaveLength(1);
    expect(target.fn).toHaveBeenCalledOnce();
  });

  it('retains call consumption across duplicate observations', async () => {
    const f = nativeFixture(), target = tool(); await f.observe();
    await execute(target, f.aroundInvoke, {}, f.context); await f.observe();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(target.fn).toHaveBeenCalledOnce();
  });

  it('withdraws lookup authority synchronously and refuses a late observation', async () => {
    const f = nativeFixture(); await f.observe();
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.spyOn(f.turn, 'stopAdmission').mockImplementation(() => stopped);
    const withdrawing = f.hooks.withdraw(), target = tool();
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    await expect(f.hooks.observeToolCall!(f.observation)).rejects.toThrow('original active bound turn');
    expect(target.fn).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce();
    release(); await withdrawing;
  });

  it.each(['channel', 'product', 'installation', 'principal'] as const)(
    'host revocation by %s refuses the next tool without erasing served usage', async kind => {
      const f = nativeFixture(); await f.observe();
      const target = tool();
      await execute(target, f.aroundInvoke, {}, f.context);
      const units = f.turn.snapshot().units;
      await f.observe({ callId: 'next-call' });
      f.context.requestOrigin!.nativeSession!.callIdFingerprint = fp('next-call');
      const binding = f.input.admissions[0]!.binding;
      const selection = kind === 'principal' ? { kind } : kind === 'installation'
        ? { kind, provenanceHash: binding.provenanceHash }
        : { kind, id: kind === 'channel' ? binding.channelId : f.input.admissions[0]!.admission.offer.productId };
      expect(await f.registry.revoke({ workspaceId: 'workspace', principalId: 'target-agent', target: selection }))
        .toEqual([{ nativeSessionId: 'native-session', ownerTurnId: 'owner-turn', turnIds: ['host-turn'] }]);
      expect(f.turn.snapshot().admissionClosed).toBe(true);
      expect(f.turn.snapshot().units).toEqual(units);
      expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
      expect(target.fn).toHaveBeenCalledOnce();
      await expect(f.hooks.observeToolCall!(f.observation)).rejects.toThrow('original active bound turn');
      await expect(f.hooks.bindNativeTurn('native-turn')).rejects.toThrow('original bound turn');
    });

  it.each(['workspace', 'principal', 'target'])(
    'host revocation does not cross another %s scope', async kind => {
      const f = nativeFixture(); await f.observe();
      const input = { workspaceId: 'workspace', principalId: 'target-agent',
        target: { kind: 'channel' as const, id: 'funded-channel' } };
      if (kind === 'workspace') input.workspaceId = 'other-workspace';
      if (kind === 'principal') input.principalId = 'other-agent';
      if (kind === 'target') input.target.id = 'other-channel';
      expect(await f.registry.revoke(input)).toEqual([]);
      const target = tool();
      expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
      expect(target.fn).toHaveBeenCalledOnce();
      await f.hooks.withdraw();
    });

  it('retains revoked tombstones through failed persistence and retries the same host notification', async () => {
    const f = nativeFixture(); await f.observe();
    let release!: () => void;
    const stopping = new Promise<void>(resolve => { release = resolve; });
    const stop = vi.spyOn(f.turn, 'stopAdmission').mockImplementationOnce(async () => {
      await stopping;
      throw new Error('durable stop failed');
    });
    const input = { workspaceId: 'workspace', principalId: 'target-agent', target: { kind: 'principal' as const } };
    const pending = f.registry.revoke(input), target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
    await expect(f.hooks.observeToolCall!(f.observation)).rejects.toThrow('original active bound turn');
    release(); await expect(pending).rejects.toThrow('durable stop failed');
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
    stop.mockRestore();
    expect(await f.registry.revoke(input)).toEqual([
      { nativeSessionId: 'native-session', ownerTurnId: 'owner-turn', turnIds: ['host-turn'] },
    ]);
    expect(f.turn.snapshot().admissionClosed).toBe(true);
    expect(await f.registry.revoke(input)).toEqual([]);
    expect(target.fn).not.toHaveBeenCalled();
  });

  it('withdraws every matching turn before the first persistence callback runs', async () => {
    const registry = new NativeInstalledPerUseTurns(), first = nativeFixture(registry);
    const second = nativeFixture(); await first.observe(); await second.observe();
    const secondInput = { ...second.input, nativeSessionId: 'second-session',
      admissions: [{ ...second.input.admissions[0]!, binding: { ...second.input.admissions[0]!.binding, executionId: 'second-session' } }] };
    const hooks = registry.register(secondInput);
    await hooks.bindNativeTurn('native-turn'); await hooks.observeToolCall!(second.observation);
    const secondContext = { ...second.context, requestOrigin: { ...second.context.requestOrigin!, nativeSession: {
      ...second.context.requestOrigin!.nativeSession!, valueFingerprint: fp('second-session') } } };
    const stopped = vi.spyOn(first.turn, 'stopAdmission').mockImplementation(async () => {
      expect((await execute(tool(), first.aroundInvoke, {}, secondContext)).result?.isError).toBe(true);
    });
    expect(await registry.revoke({ workspaceId: 'workspace', principalId: 'target-agent', target: { kind: 'principal' } }))
      .toHaveLength(2);
    stopped.mockRestore(); await second.hooks.withdraw();
  });

  it('failed durable revocation does not restore lookup authority', async () => {
    const f = nativeFixture(); await f.observe();
    vi.spyOn(f.turn, 'stopAdmission').mockRejectedValue(new Error('storage unavailable'));
    await expect(f.hooks.withdraw()).rejects.toThrow('storage unavailable');
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).toBe(true);
    expect(target.fn).not.toHaveBeenCalled();
  });

  it('copies original authority and catalog terms rather than retaining mutable caller objects', async () => {
    const f = nativeFixture();
    Object.assign(f.input.admissions[0]!.admission, { payer: 'forged-payer' });
    Object.assign(f.input.admissions[0]!.binding, { executionId: 'other-session' });
    f.input.nativeTools.paid_run = 'paid.other';
    await f.observe();
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.context)).result?.isError).not.toBe(true);
    expect(target.fn).toHaveBeenCalledOnce();
    expect(Object.values(f.turn.snapshot().units)[0]!.voucher.payer).toBe('authenticated-buyer');
  });

  it.each(['owner', 'session', 'admission', 'principal', 'provenance', 'terms', 'turn']) (
    'rejects registration that borrows a funded %s binding', kind => {
      const f = nativeFixture();
      const input = { ...f.input, nativeSessionId: 'second-session',
        admissions: [{ ...f.input.admissions[0]!, binding: { ...f.input.admissions[0]!.binding, executionId: 'second-session' } }] };
      const b = input.admissions[0]!.binding;
      if (kind === 'owner') b.ownerId = 'other-owner';
      if (kind === 'session') b.executionId = 'other-session';
      if (kind === 'admission') b.admissionId = 'other-admission';
      if (kind === 'principal') b.principalId = 'other-agent';
      if (kind === 'provenance') b.provenanceHash = 'd'.repeat(64);
      if (kind === 'terms') b.offer = { ...b.offer, terms: { ...b.offer.terms, unitPriceMicros: 1 } };
      if (kind === 'turn') input.admissions[0]!.turnId = 'other-turn';
      expect(() => f.registry.register(input)).toThrow('original funded installation');
    });

  it('rejects a concurrent admission for the same native execution', () => {
    const f = nativeFixture();
    expect(() => f.registry.register(f.input)).toThrow('already has a host admission');
  });
});

describe('host-owned installed tool admission composition', () => {
  function fixture(entitled = true) {
    const { authority, turn } = admitted();
    const admit = vi.fn(async (binding: FundedToolTurnBinding): Promise<FundedToolTurnResult> => ({ ok: true,
      turn: { turnId: 'host-turn', accountId: 'account', revision: 2, state: 'running', binding,
        fundingReceipt: null, meterState: turn.snapshot(), usageEventKeys: null, closedAtMs: null, settlementOutbox: null } }));
    // Typed with the REAL reader signature so tests can install its genuine `null` (absent) result uncast.
    const localTurn = vi.fn(() => turn),
      readProvenance = vi.fn<typeof readInstalledPluginCommerceProvenance>(async () => structuredClone(provenance));
    const resolvePayer = vi.fn(async () => authority.payer);
    const resolveFunding = vi.fn(async () => ({ channelId: 'bound-channel', quantityCeiling: 4n, expiresAtMs: 10_000 }));
    const fetchImpl = vi.fn<typeof fetch>(async url => String(url).includes('/commerce/offers')
      ? Response.json({ offers: [{ ...authority.offer, pricingModel: 'per-use', perUse: terms }] })
      : Response.json({ buyer: authority.payer, entitlements: entitled
        ? [{ buyer_id: authority.payer, product_id: authority.offer.productId, state: 'active', revoked_at_ms: null }] : [] }));
    const input = { host: { admit, localTurn }, payerTransport: { baseUrl: 'https://cupboard.test', authToken: 'host-auth', fetchImpl },
      context: { workspaceId: authority.workspaceId, principalId: authority.principalId,
        ownerId: 'authenticated-owner', executionId: 'native-session', admissionId: 'host-turn-identity' },
      installation: { name: provenance.name, version: provenance.version, path: '/loaded/plugin' },
      resolvePayer, resolveFunding, readProvenance };
    return { input, admit, localTurn, fetchImpl, readProvenance, resolvePayer, resolveFunding };
  }

  it('binds hosted provenance, authenticated buyer and exact offer before requesting turn funding', async () => {
    const f = fixture(), result = await admitInstalledPerUseToolTurn(f.input);
    expect(result).toMatchObject({ ok: true, turnId: 'host-turn', admission: { payer: 'authenticated-buyer', entitled: true } });
    expect(f.readProvenance).toHaveBeenCalledWith(f.input.installation);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.resolveFunding).toHaveBeenCalledWith(admitted().authority.offer);
    expect(f.admit).toHaveBeenCalledWith({ ...f.input.context, kind: 'tool', payer: 'authenticated-buyer', seller: 'gh:4242',
      channelId: 'bound-channel', quantityCeiling: 4n, expiresAtMs: 10_000, offer: admitted().authority.offer,
      provenanceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.localTurn).toHaveBeenCalledOnce();
  });

  it('uses the hosted bearer payer when the host supplies no organization resolver', async () => {
    const f = fixture();
    const { resolvePayer: _unused, ...input } = f.input;
    f.fetchImpl.mockImplementation(async url => String(url).includes('/commerce/offers')
      ? Response.json({ offers: [{ ...admitted().authority.offer, pricingModel: 'per-use', perUse: terms }] })
      : Response.json({ buyer: 'gh:1001', entitlements: [{ buyer_id: 'gh:1001', product_id: 'product', state: 'active', revoked_at_ms: null }] }));
    expect(await admitInstalledPerUseToolTurn(input)).toMatchObject({ ok: true, admission: { payer: 'gh:1001' } });
    expect(f.admit.mock.calls[0]?.[0].payer).toBe('gh:1001');
    expect(f.resolvePayer).not.toHaveBeenCalled();
    expect(String(f.fetchImpl.mock.calls[1]?.[0])).toBe('https://cupboard.test/commerce/entitlements');
  });

  it('refuses an unverified hosted self principal before funding', async () => {
    const f = fixture();
    const { resolvePayer: _unused, ...input } = f.input;
    expect(await admitInstalledPerUseToolTurn(input)).toMatchObject({ ok: false, code: 'invalid_entitlements' });
    expect(f.resolveFunding).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });

  it('refuses revoked entitlement before funding resolution or monetary admission', async () => {
    const f = fixture(false);
    expect(await admitInstalledPerUseToolTurn(f.input)).toMatchObject({ ok: false, code: 'tool-entitlement-required' });
    expect(f.resolveFunding).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.localTurn).not.toHaveBeenCalled();
  });

  it('refuses a token read for another buyer before funding resolution', async () => {
    const f = fixture();
    f.fetchImpl.mockImplementation(async url => String(url).includes('/commerce/offers')
      ? Response.json({ offers: [{ ...admitted().authority.offer, pricingModel: 'per-use', perUse: terms }] })
      : Response.json({ buyer: 'someone-else', entitlements: [] }));
    expect(await admitInstalledPerUseToolTurn(f.input)).toMatchObject({ ok: false, code: 'invalid_entitlements' });
    expect(f.resolveFunding).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('preserves a hosted funding refusal rather than manufacturing an admitted local handle', async () => {
    const f = fixture(); f.admit.mockResolvedValue({ ok: false, code: 'funding-not-confirmed', detail: 'no authoritative reservation' });
    expect(await admitInstalledPerUseToolTurn(f.input)).toMatchObject({ ok: false, code: 'funding-not-confirmed' });
    expect(f.localTurn).not.toHaveBeenCalled();
  });

  function lifecycleFixture() {
    const f = fixture(), registry = new NativeInstalledPerUseTurns();
    const identity = { ok: true as const, bindNativeTurn: vi.fn(async (_id: string) => {}),
      observeToolCall: vi.fn(async () => {}), complete: vi.fn(async () => {}), reconcile: vi.fn(async () => {}) };
    // Typed with the REAL identity-lifecycle `admit` signature so refusal variants install uncast.
    const admitIdentity = vi.fn<IdentityLifecycleAdmit>(async () => identity);
    const complete = vi.fn(async (_workspace: string, _id: string, _turn: LocalMeteredTurn, _time: number): Promise<FundedToolTurnResult> =>
      ({ ok: true, turn: { ...(await f.admit.mock.results[0]!.value as Extract<FundedToolTurnResult, { ok: true }>).turn, state: 'settled' } }));
    const { host: _host, context: _context, ...installation } = f.input;
    const plan = { context: { principalId: 'target-agent', advSessionId: 7, mcpServer: 'papercusp-su',
      nativeTools: { paid_run: 'paid.run' } }, host: { ...f.input.host, complete }, installations: [installation] };
    const resolvePlan = vi.fn(async () => plan), recordFailure = vi.fn(async () => {});
    const lifecycle = registry.nativeLifecycle({ identityLifecycle: { admit: admitIdentity }, resolvePlan, recordFailure, nowMs: () => 1_000 });
    const context = { workspaceId: 'workspace', ownerId: 'authenticated-owner', nativeSessionId: 'native-session', ownerTurnId: 'owner-turn' };
    const fp = (value: string) => createHash('sha256').update(value).digest('hex');
    const requestContext = ctx();
    Object.assign(requestContext, { advSessionId: 7, uiClientId: context.ownerId,
      requestOrigin: { transport: 'mcp', nativeSession: { carrier: 'meta:threadId', binding: 'bound',
        valueFingerprint: fp(context.nativeSessionId), callIdFingerprint: fp('native-call'), candidateAdvSessionId: 7 } } });
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: request => registry.resolve(request) });
    const observation = { nativeTurnId: 'native-turn', callId: 'native-call', server: 'papercusp-su', tool: 'paid_run' };
    const closure = { nativeTurnId: 'native-turn', status: 'completed', completedAtMs: 1_000 };
    return { ...f, registry, identity, admitIdentity, complete, plan, resolvePlan, recordFailure, lifecycle,
      context, requestContext, aroundInvoke, observation, closure };
  }

  function catalogFixture() {
    const f = lifecycleFixture();
    const catalog = [tool()];
    const selected = { context: structuredClone(f.plan.context), host: f.plan.host, toolNames: ['paid.run'] };
    const resolveContext = vi.fn(async () => selected);
    const { installation: _installation, readProvenance: _read, host: _host, context: _context, ...capability } = f.input;
    const resolveInstallation = vi.fn(async () => capability);
    const readTools = vi.fn(() => catalog);
    const deps = { identityLifecycle: { admit: f.admitIdentity }, resolveContext, resolveInstallation,
      readTools, readProvenance: f.readProvenance, recordFailure: f.recordFailure, nowMs: () => 1_000 };
    const lifecycle = f.registry.nativeLifecycleFromCatalog(deps);
    return { ...f, selected, catalog, resolveContext, resolveInstallation, readTools, deps, lifecycle };
  }

  function attachedFixture(funded = true, lazy = false) {
    const f = catalogFixture();
    const readNativeToolNames = vi.fn(async () => ['paid_run']);
    const resolveFunding = vi.fn(async () => ({ host: f.plan.host, resolveInstallation: f.resolveInstallation }));
    const lifecycle = attachedInstalledToolLifecycle({
      session: { workspaceId: f.context.workspaceId, ownerId: f.context.ownerId,
        advSessionId: f.plan.context.advSessionId, principalId: f.plan.context.principalId },
      identityLifecycle: f.deps.identityLifecycle, readNativeToolNames,
      recordFailure: f.recordFailure, registry: f.registry, readTools: f.readTools,
      readProvenance: f.readProvenance,
      resolveNativeName: name => ({ paid_run: 'paid.run', tools_invoke: 'tools:invoke' } as Record<string, string>)[name],
      ...(lazy ? { resolveFunding } : funded ? { funding: { host: f.plan.host, resolveInstallation: f.resolveInstallation } } : {}),
    });
    return { ...f, lifecycle, readNativeToolNames, resolveFunding };
  }

  it('resolves the production financial capability for each paid turn before funding', async () => {
    const f = attachedFixture(false, true);
    const admitted = await f.lifecycle.admit(f.context);
    expect(admitted.ok).toBe(true);
    expect(f.resolveFunding).toHaveBeenCalledOnce();
    expect(f.admit).toHaveBeenCalledOnce();
    if (admitted.ok) await admitted.reconcile({ phase: 'delivery', message: 'not delivered' });
    await f.lifecycle.admit({ ...f.context, ownerTurnId: 'another-turn' });
    expect(f.resolveFunding).toHaveBeenCalledTimes(2);
  });

  it('does not load financial credentials for a verified free installed cohort', async () => {
    const f = attachedFixture(false, true);
    f.readProvenance.mockResolvedValue({ ...provenance, listing: { ...provenance.listing, priceModel: 'free' } });
    expect((await f.lifecycle.admit(f.context)).ok).toBe(true);
    expect(f.resolveFunding).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('attached default refuses an installed paid cohort before any tool or funding entry without host capabilities', async () => {
    const f = attachedFixture(false);
    expect(await f.lifecycle.admit(f.context)).toMatchObject({ ok: false,
      code: 'native-installed-admission-failed', message: expect.stringContaining('native-installed-funding-unavailable') });
    expect(f.admitIdentity).toHaveBeenCalledOnce(); expect(f.admit).not.toHaveBeenCalled();
    expect(f.recordFailure).toHaveBeenCalledOnce();
  });

  it('attached default registers hosted-verified free tools and withdraws them on completion', async () => {
    const f = attachedFixture(false), free = structuredClone(provenance);
    free.listing.priceModel = 'free'; f.readProvenance.mockResolvedValue(free);
    const lease = await f.lifecycle.admit(f.context);
    if (!lease.ok) throw new Error(lease.message);
    await lease.bindNativeTurn('native-turn'); await lease.observeToolCall!(f.observation);
    expect(f.registry.resolve({ tool: f.catalog[0]!, toolName: 'paid.run', ctx: f.requestContext } as never)).toMatchObject({ kind: 'free' });
    await lease.complete(f.closure);
    expect(f.registry.resolve({ tool: f.catalog[0]!, toolName: 'paid.run', ctx: f.requestContext } as never)).toBeNull();
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('attached supplier funds deferred installed targets reachable through the native wrapper', async () => {
    const f = attachedFixture();
    f.catalog.push({ ...tool(), pluginName: 'core', pluginInstallation: undefined, expose: { mcp: { name: 'tools:invoke' } } });
    f.readNativeToolNames.mockResolvedValue(['tools_invoke']);
    const lease = await f.lifecycle.admit(f.context);
    if (!lease.ok) throw new Error(lease.message);
    expect(f.resolveInstallation).toHaveBeenCalledOnce(); expect(f.admit).toHaveBeenCalledOnce();
    await lease.bindNativeTurn('native-turn');
    await lease.observeToolCall!({ ...f.observation, tool: 'tools_invoke' });
    expect(f.registry.resolve({ tool: f.catalog[0]!, toolName: 'paid.run', ctx: { ...f.requestContext, indirectDispatch: true } } as never)).toMatchObject({ kind: 'per-use' });
    await lease.complete(f.closure);
  });

  it('attached supplier refreshes inventory each turn and preserves identity refusals', async () => {
    const f = attachedFixture(false);
    f.admitIdentity.mockResolvedValueOnce({ ok: false, code: 'identity-refused', message: 'blocked', retryable: false });
    expect(await f.lifecycle.admit(f.context)).toMatchObject({ ok: false, code: 'identity-refused' });
    expect(f.readNativeToolNames).not.toHaveBeenCalled();
    f.readNativeToolNames.mockResolvedValueOnce([]);
    expect(await f.lifecycle.admit(f.context)).toMatchObject({ ok: true });
    expect(await f.lifecycle.admit({ ...f.context, ownerTurnId: 'next-owner-turn' })).toMatchObject({ ok: false });
    expect(f.readNativeToolNames).toHaveBeenCalledTimes(2);
  });

  it('supplies one funding admission for several exact loaded targets of the same installation', async () => {
    const f = catalogFixture();
    f.catalog.push({ ...tool(), expose: { mcp: { name: 'paid.other' } } });
    f.selected.toolNames.push('paid.other');
    const lease = await f.lifecycle.admit(f.context);
    if (!lease.ok) throw new Error(lease.message);
    expect(f.readProvenance).toHaveBeenCalledExactlyOnceWith(f.input.installation);
    expect(f.resolveInstallation).toHaveBeenCalledExactlyOnceWith({ context: f.context,
      installation: f.input.installation, provenance });
    expect(f.admit).toHaveBeenCalledOnce();
    await lease.bindNativeTurn('native-turn'); await lease.observeToolCall!(f.observation);
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.requestContext)).result?.isError).not.toBe(true);
    expect(target.fn).toHaveBeenCalledOnce();
    await lease.complete(f.closure);
  });

  it('uses the actual production projected registry when no catalog reader is supplied', async () => {
    const f = catalogFixture(), target = tool();
    registerProjectedTool(target);
    try {
      const { readTools: _reader, ...deps } = f.deps;
      const lease = await f.registry.nativeLifecycleFromCatalog(deps).admit(f.context);
      if (!lease.ok) throw new Error(lease.message);
      expect(f.readTools).not.toHaveBeenCalled(); expect(f.admit).toHaveBeenCalledOnce();
      await lease.reconcile({ phase: 'delivery', message: 'test withdrawal' });
    } finally { unregisterProjectedToolsForPlugin(provenance.name); }
  });

  it.each(['missing-target', 'duplicate-target', 'conflicting-installation', 'escaping-map', 'wrong-provenance']) (
    'refuses %s before resolving financial capabilities or reserving', async kind => {
      const f = catalogFixture();
      if (kind === 'missing-target') f.selected.toolNames[0] = 'missing.tool';
      if (kind === 'duplicate-target') f.selected.toolNames.push('paid.run');
      if (kind === 'conflicting-installation') {
        f.catalog.push({ ...tool(), pluginInstallation: { ...tool().pluginInstallation!, path: '/shadow/plugin' },
          expose: { mcp: { name: 'paid.other' } } });
        f.selected.toolNames.push('paid.other');
      }
      if (kind === 'escaping-map') f.selected.context.nativeTools.paid_run = 'missing.tool';
      if (kind === 'wrong-provenance') f.readProvenance.mockResolvedValue({ ...provenance, version: 'other' });
      expect(await f.lifecycle.admit(f.context)).toMatchObject({ ok: false, code: 'native-installed-admission-failed' });
      expect(f.resolveInstallation).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
      expect(f.identity.reconcile).toHaveBeenCalledOnce(); expect(f.recordFailure).toHaveBeenCalledOnce();
    });

  it('retains a snapshot of loaded installation and verified terms across asynchronous financial resolution', async () => {
    const f = catalogFixture();
    f.resolveInstallation.mockImplementation(async () => {
      Object.assign(f.catalog[0]!.pluginInstallation!, { path: '/changed', version: 'other' });
      f.selected.context.nativeTools.paid_run = 'other.tool';
      return { payerTransport: f.input.payerTransport, resolvePayer: f.input.resolvePayer, resolveFunding: f.input.resolveFunding };
    });
    const lease = await f.lifecycle.admit(f.context);
    if (!lease.ok) throw new Error(lease.message);
    expect(f.admit.mock.calls[0]![0].offer.skuRef).toBe(provenance.listing.skuRef);
    await lease.bindNativeTurn('native-turn'); await lease.observeToolCall!(f.observation);
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.requestContext)).result?.isError).not.toBe(true);
    expect(target.fn).toHaveBeenCalledOnce(); await lease.complete(f.closure);
  });

  it.each(['completion', 'reconciliation', 'installation-revocation', 'principal-revocation'] as const)(
    'admits a hosted-verified free installation without reserves and withdraws it on %s', async phase => {
      const f = catalogFixture(), free = { ...provenance, listing: { ...provenance.listing, priceModel: 'free' as const } };
      f.readProvenance.mockResolvedValue(free);
      const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => free,
        resolveAdmittedTurn: request => f.registry.resolve(request) });
      const lease = await f.lifecycle.admit(f.context);
      if (!lease.ok) throw new Error(lease.message);
      expect(f.resolveInstallation).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
      await lease.bindNativeTurn('native-turn'); await lease.observeToolCall!(f.observation);
      const target = tool();
      expect((await execute(target, aroundInvoke, {}, f.requestContext)).result?.isError).not.toBe(true);
      expect(target.fn).toHaveBeenCalledOnce();
      expect((await execute(target, aroundInvoke, {}, f.requestContext)).result?.isError).toBe(true);
      await lease.observeToolCall!({ ...f.observation, callId: 'next-free-call' });
      f.requestContext.requestOrigin!.nativeSession!.callIdFingerprint = createHash('sha256').update('next-free-call').digest('hex');
      if (phase === 'completion') await lease.complete(f.closure);
      else if (phase === 'reconciliation') await lease.reconcile({ phase: 'delivery', message: 'withdraw free admission' });
      else expect(await f.registry.revoke({ workspaceId: f.context.workspaceId, principalId: 'target-agent', target:
        phase === 'principal-revocation' ? { kind: 'principal' } :
          { kind: 'installation', provenanceHash: createHash('sha256').update(canonicalJson(free)).digest('hex') },
      })).toEqual([{ nativeSessionId: 'native-session', ownerTurnId: 'owner-turn', turnIds: [] }]);
      expect(f.complete).not.toHaveBeenCalled();
      expect((await execute(target, aroundInvoke, {}, f.requestContext)).result?.isError).toBe(true);
      expect(target.fn).toHaveBeenCalledOnce();
    });

  it('does not treat an unreceipted loaded plugin as a hosted free admission', async () => {
    const f = catalogFixture(); f.readProvenance.mockResolvedValue(null);
    const lease = await f.lifecycle.admit(f.context); expect(lease.ok).toBe(true);
    expect(f.resolveInstallation).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
    if (!lease.ok) throw new Error('expected identity admission');
    await lease.reconcile({ phase: 'delivery', message: 'test teardown' });
  });

  it('keeps identity refusal ahead of the loaded catalog and financial supplier', async () => {
    const f = catalogFixture();
    f.admitIdentity.mockResolvedValue({ ok: false, code: 'identity-required', message: 'identity refusal', retryable: false });
    expect(await f.lifecycle.admit(f.context)).toMatchObject({ ok: false, code: 'identity-required' });
    expect(f.resolveContext).not.toHaveBeenCalled(); expect(f.readTools).not.toHaveBeenCalled();
    expect(f.resolveInstallation).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });

  it('funds installed tools before publishing lookup and binds/settles the exact original native lifecycle', async () => {
    const f = lifecycleFixture(), lease = await f.lifecycle.admit(f.context);
    if (!lease.ok) throw new Error(lease.message);
    expect(f.admitIdentity).toHaveBeenCalledWith(f.context);
    expect(f.admit).toHaveBeenCalledOnce();
    expect(f.admit.mock.calls[0]![0]).toMatchObject({ ownerId: f.context.ownerId,
      executionId: f.context.nativeSessionId, admissionId: f.context.ownerTurnId });
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.requestContext)).result?.isError).toBe(true);
    await lease.bindNativeTurn('native-turn'); await lease.observeToolCall!(f.observation);
    expect((await execute(target, f.aroundInvoke, {}, f.requestContext)).result?.isError).not.toBe(true);
    await lease.complete(f.closure); await lease.complete(f.closure);
    expect(f.complete).toHaveBeenCalledExactlyOnceWith('workspace', 'host-turn', f.localTurn(), 1_000);
    expect(f.identity.complete).toHaveBeenCalledExactlyOnceWith(f.closure);
    expect(target.fn).toHaveBeenCalledOnce(); expect(f.recordFailure).not.toHaveBeenCalled();
  });

  it('preserves an identity refusal before resolving or funding installed tools', async () => {
    const f = lifecycleFixture();
    const refused = { ok: false as const, code: 'identity-native-billing-unsupported', message: 'unproven cost', retryable: false };
    f.admitIdentity.mockResolvedValueOnce(refused);
    expect(await f.lifecycle.admit(f.context)).toBe(refused);
    expect(f.resolvePlan).not.toHaveBeenCalled(); expect(f.admit).not.toHaveBeenCalled();
  });

  it('registers core observations without manufacturing a funded installation', async () => {
    const f = lifecycleFixture(); f.plan.installations = [];
    const register = vi.spyOn(f.registry, 'register');
    const lease = await f.lifecycle.admit(f.context); expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error('expected core admission');
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ admissions: [] }));
    await lease.bindNativeTurn('native-turn');
    await lease.observeToolCall!({ ...f.observation, arguments: { harness: 'selected' } });
    expect(f.identity.bindNativeTurn).toHaveBeenCalledWith('native-turn');
    expect(f.identity.observeToolCall).toHaveBeenCalledOnce();
    expect(f.admit).not.toHaveBeenCalled();
    expect((await execute(tool(), f.aroundInvoke, {}, f.requestContext)).result?.isError).toBe(true);
    await lease.complete(f.closure);
    expect(f.identity.complete).toHaveBeenCalledWith(f.closure);
    expect(f.complete).not.toHaveBeenCalled();
    await expect(lease.observeToolCall!(f.observation)).rejects.toThrow('original active bound turn');
  });

  it('closes only known unserved handles after a later installation admission fails', async () => {
    const f = lifecycleFixture(); f.plan.installations.push(f.plan.installations[0]!);
    f.readProvenance.mockResolvedValueOnce(provenance).mockResolvedValueOnce(null);
    expect(await f.lifecycle.admit(f.context)).toMatchObject({ ok: false, code: 'native-installed-admission-failed',
      message: expect.stringContaining('installation-binding-required') });
    expect(f.complete).toHaveBeenCalledExactlyOnceWith('workspace', 'host-turn', f.localTurn(), 1_000);
    expect(f.identity.reconcile).toHaveBeenCalledOnce();
    expect(f.recordFailure).toHaveBeenCalledWith({ context: f.context, turnIds: ['host-turn'],
      phase: 'delivery', message: expect.stringContaining('installation-binding-required') });
    expect(f.localTurn().snapshot().admissionClosed).toBe(true);
  });

  it('does not infer a refund for an uncertain reservation without a successful local handle', async () => {
    const f = lifecycleFixture(); f.admit.mockResolvedValue({ ok: false, code: 'funding-not-confirmed', detail: 'lost reserve response' });
    expect(await f.lifecycle.admit(f.context)).toMatchObject({ ok: false, message: expect.stringContaining('funding-not-confirmed') });
    expect(f.complete).not.toHaveBeenCalled(); expect(f.localTurn).not.toHaveBeenCalled();
    expect(f.recordFailure).toHaveBeenCalledWith({ context: f.context, turnIds: [], phase: 'delivery',
      message: expect.stringContaining('funding-not-confirmed') });
  });

  it('elects the native binding before an async write and rejects concurrent changed bindings', async () => {
    const f = lifecycleFixture(), lease = await f.lifecycle.admit(f.context);
    if (!lease.ok) throw new Error(lease.message);
    let release!: () => void;
    f.identity.bindNativeTurn.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const binding = lease.bindNativeTurn('native-turn');
    expect(lease.bindNativeTurn('native-turn')).toBe(binding);
    await expect(lease.bindNativeTurn('other-turn')).rejects.toThrow('original binding');
    await expect(lease.observeToolCall!(f.observation)).rejects.toThrow('active bound turn');
    expect(f.identity.bindNativeTurn).toHaveBeenCalledOnce(); release(); await binding;
    await lease.reconcile({ phase: 'delivery', message: 'delivery uncertain' });
  });

  it.each(['delivery', 'binding', 'completion'] as const)('withdraws lookup and retains monetary holds on %s reconciliation', async phase => {
    const f = lifecycleFixture(), lease = await f.lifecycle.admit(f.context);
    if (!lease.ok) throw new Error(lease.message);
    await lease.bindNativeTurn('native-turn'); await lease.observeToolCall!(f.observation);
    const recovery = lease.reconcile({ phase, message: 'uncertain native execution' });
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.requestContext)).result?.isError).toBe(true);
    await recovery;
    expect(f.complete).not.toHaveBeenCalled(); expect(target.fn).not.toHaveBeenCalled();
    expect(f.identity.reconcile).toHaveBeenCalledWith({ phase, message: 'uncertain native execution' });
    expect(f.recordFailure).toHaveBeenCalledWith({ context: f.context, turnIds: ['host-turn'], phase, message: 'uncertain native execution' });
  });

  it('withdraws before async completion, shares concurrent closure and retries only the same metadata', async () => {
    const f = lifecycleFixture(), lease = await f.lifecycle.admit(f.context);
    if (!lease.ok) throw new Error(lease.message);
    await lease.bindNativeTurn('native-turn'); await lease.observeToolCall!(f.observation);
    await expect(lease.complete({ ...f.closure, nativeTurnId: 'wrong' })).rejects.toThrow('original turn');
    f.complete.mockResolvedValueOnce({ ok: false, code: 'tool-completion-unconfirmed', detail: 'retained hold' });
    const closing = lease.complete(f.closure);
    expect(lease.complete(f.closure)).toBe(closing);
    const target = tool();
    expect((await execute(target, f.aroundInvoke, {}, f.requestContext)).result?.isError).toBe(true);
    await expect(closing).rejects.toThrow('recovery remains unconfirmed');
    expect(f.identity.complete).toHaveBeenCalledOnce();
    await expect(lease.complete({ ...f.closure, completedAtMs: 1_001 })).rejects.toThrow('original turn');
    await lease.complete(f.closure);
    expect(f.complete).toHaveBeenCalledTimes(2); expect(target.fn).not.toHaveBeenCalled();
  });
});

function admitted(overrides: Partial<LocalMeteredTurnState> = {}) {
  const declared = declareMeter(terms);
  if (!declared.ok) throw new Error(declared.detail);
  let persisted: LocalMeteredTurnState | undefined;
  const turn = new LocalMeteredTurn({ state: { turnId: 'host-turn', payer: 'authenticated-buyer',
    seller: 'gh:4242', releaseRef: 'opaque-paid-sku', meter: declared.meter, ceilingMicros: 1_000n,
    expiresAtMs: 10_000, reservedMicros: 0n, channel: createMicrochargeChannel('funded-channel', 2_000n),
    units: {}, ...overrides }, nowMs: () => 1_000, signVoucher: signPaymentTestBytes,
    signReceipt: () => 'seller-signature', persist: async (state) => { persisted = state; } });
  const authority: AdmittedPerUseToolTurn = { kind: 'per-use', workspaceId: 'workspace', principalId: 'target-agent',
    payer: 'authenticated-buyer',
    provenance: structuredClone(provenance), offer: { offerId: 'offer', productId: 'product',
      skuRef: 'opaque-paid-sku', creatorId: 'gh:4242', active: true, productActive: true, terms },
    entitled: true, turn };
  return { authority, turn, persisted: () => persisted };
}
const execute = (target: ProjectedTool, aroundInvoke = PROJECTED_DEPS.aroundInvoke, input: unknown = {}, context = ctx()) =>
  runDispatchStack(target, 'paid.run', input, context, { aroundInvoke });

afterEach(() => vi.resetAllMocks());

describe('installed per-use shared chokepoint', () => {
  it('R16 refusal oracle catches a deliberately bypassed entitlement check', async () => {
    const witness = async (aroundInvoke: NonNullable<typeof PROJECTED_DEPS.aroundInvoke>) => {
      const target = tool();
      const result = await execute(target, aroundInvoke, { entitled: true, funded: true });
      return { target, result };
    };
    const assertRefused = ({ target, result }: Awaited<ReturnType<typeof witness>>) => {
      expect(result.result).toMatchObject({ isError: true });
      expect(target.fn).not.toHaveBeenCalled();
    };
    const production = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: () => null });
    assertRefused(await witness(production));
    // Permanent broken control: caller-supplied funding must not authorize the handler.
    const bypassed = await witness(request => request.invoke());
    expect(bypassed.target.fn).toHaveBeenCalledOnce();
    expect(() => assertRefused(bypassed)).toThrow();
  });

  it.each(['omitted', 'duplicated'] as const)(
    'R17 charge oracle catches a deliberately %s settlement', async (corruption) => {
      const witness = async (broken: boolean) => {
        const { authority, turn, persisted } = admitted();
        const production = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
          resolveAdmittedTurn: () => authority });
        const aroundInvoke: NonNullable<typeof production> = !broken ? production : corruption === 'omitted'
          ? request => request.invoke()
          : async request => {
            const result = await production(request);
            // A second nonce charges the same handler result again without another dispatch.
            await production({ ...request, callId: `${request.callId}-duplicate`, invoke: async () => result });
            return result;
          };
        const target = tool();
        const result = await execute(target, aroundInvoke);
        return { target, result, units: Object.values(turn.snapshot().units),
          committedMicros: persisted()?.channel.committedMicros ?? 0n };
      };
      const assertExactlyOneCharge = (observed: Awaited<ReturnType<typeof witness>>) => {
        expect(observed.result.result?.isError).not.toBe(true);
        expect(observed.target.fn).toHaveBeenCalledOnce();
        expect(observed.units).toHaveLength(1);
        expect(observed.units[0]!.receipt?.amountMicros).toBe(250n);
        expect(observed.committedMicros).toBe(250n);
      };
      assertExactlyOneCharge(await witness(false));
      const broken = await witness(true);
      expect(broken.target.fn).toHaveBeenCalledOnce();
      expect(broken.units).toHaveLength(corruption === 'omitted' ? 0 : 2);
      expect(broken.committedMicros).toBe(corruption === 'omitted' ? 0n : 500n);
      expect(() => assertExactlyOneCharge(broken)).toThrow();
    },
  );

  it('production refuses an installed paid tool before dispatch, including forged funding arguments', async () => {
    vi.mocked(readInstalledPluginProvenance).mockResolvedValue(provenance);
    const target = tool();
    const result = await execute(target, undefined, { entitled: true, payer: 'authenticated-buyer', funded: true });
    expect(result.result).toMatchObject({ isError: true });
    expect(JSON.parse((result.result!.content[0] as { text: string }).text).error).toBe('funded_tool_turn_required');
    expect(target.fn).not.toHaveBeenCalled();
    expect(readInstalledPluginProvenance).toHaveBeenCalledWith({ name: 'paid-plugin', version: '1.0.0', path: '/loaded/plugin' });
  });

  it('refuses unreadable installation provenance before the handler', async () => {
    vi.mocked(readInstalledPluginProvenance).mockRejectedValue(new Error('loaded bytes changed'));
    const target = tool();
    expect((await execute(target)).result).toMatchObject({ isError: true });
    expect(target.fn).not.toHaveBeenCalled();
  });

  it.each([null, { slug: 'target-agent', workspaceId: 'workspace', capabilities: new Set<string>(), trust: 'unverified-loopback' as const }])(
    'refuses an unauthenticated target', async (principal) => {
      const target = tool();
      const lookup = vi.fn(() => admitted().authority);
      const context = ctx(); context.principal = principal;
      expect((await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
        resolveAdmittedTurn: lookup }), {}, context)).result).toMatchObject({ isError: true });
      expect(lookup).not.toHaveBeenCalled(); expect(target.fn).not.toHaveBeenCalled();
    });

  it.each(['principal', 'workspace', 'payer', 'provenance', 'entitlement', 'publisher', 'sku', 'terms', 'meter-unit', 'seller', 'release']) (
    'refuses changed %s before serving', async (kind) => {
      const { authority } = admitted(kind === 'seller' ? { seller: 'other' } : kind === 'release' ? { releaseRef: 'other' } : {});
      const changed = { ...authority };
      if (kind === 'principal') changed.principalId = 'outer-wrapper';
      if (kind === 'workspace') changed.workspaceId = 'other';
      if (kind === 'payer') changed.payer = 'another-buyer';
      if (kind === 'provenance') changed.provenance = { ...provenance, contentFingerprint: 'd'.repeat(64) };
      if (kind === 'entitlement') changed.entitled = false;
      if (kind === 'publisher') changed.offer = { ...authority.offer, creatorId: 'other' };
      if (kind === 'sku') changed.offer = { ...authority.offer, skuRef: 'other' };
      if (kind === 'terms') changed.offer = { ...authority.offer, terms: { ...terms, priceVersion: 'other' } };
      if (kind === 'meter-unit') changed.offer = { ...authority.offer, terms: { ...terms, meterUnit: 'seconds' } };
      const target = tool();
      const result = await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
        resolveAdmittedTurn: () => changed }));
      expect(result.result).toMatchObject({ isError: true }); expect(target.fn).not.toHaveBeenCalled();
    });

  it('persists one reservation before serving and awaits exactly one local settlement', async () => {
    const { authority, persisted, turn } = admitted();
    const target = tool(vi.fn(async () => {
      expect(Object.keys(persisted()!.channel.reservations)).toHaveLength(1);
      return { content: [{ type: 'text' as const, text: 'served' }] };
    }));
    const lookup = vi.fn((_request: Parameters<ReturnType<typeof createInstalledPerUseChokepoint>>[0]) => authority);
    const result = await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: lookup }));
    expect(result.result?.isError).not.toBe(true); expect(target.fn).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]![0].ctx.principal?.slug).toBe('target-agent');
    const entries = Object.values(turn.snapshot().units);
    expect(entries).toHaveLength(1); expect(entries[0]!.receipt?.amountMicros).toBe(250n);
    expect(persisted()!.channel.committedMicros).toBe(250n);
  });

  it('settles a thrown handler and refuses a depleted turn before another handler', async () => {
    const { authority, turn } = admitted({ ceilingMicros: 250n });
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: () => authority });
    const throwing = tool(vi.fn(async () => { throw new Error('handler failed'); }));
    expect((await execute(throwing, aroundInvoke)).error?.code).toBe('handler_error');
    expect(Object.values(turn.snapshot().units)[0]!.receipt?.amountMicros).toBe(250n);
    const next = tool();
    expect((await execute(next, aroundInvoke)).result).toMatchObject({ isError: true });
    expect(next.fn).not.toHaveBeenCalled();
  });

  it('passes built-in and unmanaged/free installations through without funding lookup', async () => {
    const lookup = vi.fn();
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => null, resolveAdmittedTurn: lookup });
    const builtIn = tool(); delete builtIn.pluginInstallation;
    const local = tool();
    await execute(builtIn, aroundInvoke); await execute(local, aroundInvoke);
    expect(builtIn.fn).toHaveBeenCalledTimes(1); expect(local.fn).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('requires hosted classification even when an editable receipt claims free pricing', async () => {
    const free = { ...provenance, listing: { ...provenance.listing, priceModel: 'free' as const } };
    const target = tool();
    const refused = await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => free }));
    expect(refused.result).toMatchObject({ isError: true }); expect(target.fn).not.toHaveBeenCalled();
    await execute(target, createInstalledPerUseChokepoint({ readProvenance: async () => free,
      resolveAdmittedTurn: () => ({ kind: 'free', workspaceId: 'workspace', principalId: 'target-agent', provenance: free }) }));
    expect(target.fn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('tools:invoke reaches the same target-bound paid seat (admitted=%s)', async (funded) => {
    const { authority, turn } = admitted();
    const target = tool();
    const aroundInvoke = createInstalledPerUseChokepoint({ readProvenance: async () => provenance,
      resolveAdmittedTurn: () => funded ? authority : null });
    const outer = ctx(); outer.principal = { ...outer.principal!, slug: 'synthesized-wrapper' };
    outer.dispatchTool = async (name, input) => {
      expect(name).toBe('paid.run');
      const result = await execute(target, aroundInvoke, input);
      return result.result!;
    };
    const wrapper = invokeTool as unknown as { handler(args: { name: string; args?: Record<string, unknown> },
      context: UnifiedToolContext): Promise<ToolResult> };
    const result = wrapper.handler({ name: 'paid.run', args: { entitled: true } }, outer);
    if (funded) {
      expect((await result).isError).not.toBe(true); expect(target.fn).toHaveBeenCalledTimes(1);
      expect(Object.values(turn.snapshot().units)).toHaveLength(1);
      expect(Object.values(turn.snapshot().units)[0]!.receipt?.amountMicros).toBe(250n);
    } else {
      await expect(result).rejects.toBeInstanceOf(NestedToolRefusalError);
      expect(target.fn).not.toHaveBeenCalled(); expect(turn.snapshot().units).toEqual({});
    }
  });
});
