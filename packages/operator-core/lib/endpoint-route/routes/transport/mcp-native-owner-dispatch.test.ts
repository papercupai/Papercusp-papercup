import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProjectedTool, unregisterProjectedToolsForPlugin, type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import { dispatchNativeMcpTargetOnOwner, normalizeNativeMcpOwnerSpawn, recordMcpPreflightFailure, runNativeMcpTargetOnOwner,
  retainNativeRequestPrincipalForDispatch, type BuiltSpawnContext } from './_mcp-host';
import { nativeInstalledPerUseTurns } from '../../../agent-tools/per-use-chokepoint';
import type { SuNativeToolAddress } from '../../../su-session-owner-routing';
const telemetry = vi.hoisted(() => ({ recordInvocation: vi.fn() }));
const nativeOwnerRouting = vi.hoisted(() => ({ run: vi.fn() }));
const servingGeneration = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../../su-session-owner-routing', async importOriginal => ({
  ...await importOriginal<typeof import('../../../su-session-owner-routing')>(),
  runOnSuNativeToolOwner: nativeOwnerRouting.run,
}));
vi.mock('../../../serving-generation', async importOriginal => ({
  ...await importOriginal<typeof import('../../../serving-generation')>(),
  readServingGeneration: servingGeneration.read,
}));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  withWorkspace: vi.fn(async () => { throw new Error('fixture principal synthesis failed'); }),
  retryOnRetryableDbDeadline: async (run: () => Promise<unknown>) => run(),
}));

// Exercise the real generic dispatcher and rebuilt context without an external
// DB. Monetary admission/retention has its own suite; this fixture claims none.
vi.mock('../../../projected-tool-deps', () => ({
  PROJECTED_DEPS: telemetry, backfillResultDoorOutputRef: vi.fn(), wrapOperatorKernelSpawn: vi.fn(),
}));

const fingerprint = createHash('sha256').update('native-test-thread').digest('hex');
const address: SuNativeToolAddress = { workspaceId: 'native-fixture', advSessionId: 77,
  ownerId: 'su-fixture', nativeSessionIdFingerprint: fingerprint };
const spawn: BuiltSpawnContext = {
  workspaceId: address.workspaceId, harnessSlug: '*', role: 'operator', featureId: null, chunkId: null,
  runId: 'native-fixture', spawnId: 'per-request-never-owner', parentSpawnId: null,
  uiClientId: address.ownerId, detectorSessionKey: null, advSessionId: 77, isSuperuser: true,
  requestOrigin: { transport: 'mcp', nativeSession: { carrier: 'meta:threadId', binding: 'bound',
    candidateAdvSessionId: 77, valueFingerprint: fingerprint, callIdFingerprint: 'a'.repeat(64) } },
};
const request = () => ({ toolName: 'native-fixture:run', args: { value: 7 }, spawn: structuredClone(spawn),
  servingGeneration: 'serving-generation-v1:test',
  fullSource: true, structuredSource: true, sourceProjection: { pick: ['value'] }, indirect: false,
  requestedFormat: 'compact', requestedStructured: true, requestedDelta: 'cursor', idempotencyKey: 'native-key' });
function target(fn: (args: unknown, ctx: UnifiedToolContext) => Promise<unknown>, extra: Partial<ProjectedTool> = {}) {
  registerProjectedTool({ name: 'run', pluginName: 'native-fixture', roles: ['operator'],
    expose: { mcp: { name: 'native-fixture:run' } }, requirePrincipal: false,
    ...extra, fn } as ProjectedTool);
}
afterEach(() => {
  vi.restoreAllMocks();
  unregisterProjectedToolsForPlugin('native-fixture');
  telemetry.recordInvocation.mockClear();
  nativeOwnerRouting.run.mockReset();
  servingGeneration.read.mockReset();
});

beforeEach(() => {
  servingGeneration.read.mockResolvedValue({
    state: 'known', revision: 'serving-generation-v1:test',
    buildSha: 'native-fixture', appliedMigrationDigest: 'native-fixture', toolRegistryRevision: 'native-fixture',
  });
});

describe('D-063 owner rebuild of native MCP targets', () => {
  it.each(['meta:threadId', 'header:x-papercusp-native-session'] as const)('retains a genuine principal only via the local exact-call registry with %s', async carrier => {
    target(vi.fn());
    const principal = { kind: 'system' as const, slug: 'system:superuser', workspaceId: address.workspaceId,
      authMethod: 'bearer-token' as const, trust: 'trusted' as const, capabilities: new Set(['*']) };
    const resolve = vi.spyOn(nativeInstalledPerUseTurns, 'resolveRequestPrincipal').mockResolvedValue(principal);
    const r = request();
    r.spawn.requestOrigin!.nativeSession!.carrier = carrier;
    const enriched = await retainNativeRequestPrincipalForDispatch(r.spawn, r.toolName, r.args, 'private-runtime-bearer');
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ workspaceId: address.workspaceId, advSessionId: 77,
      ownerId: address.ownerId, nativeSessionFingerprint: fingerprint, callIdFingerprint: 'a'.repeat(64),
      toolName: r.toolName, arguments: r.args, runtimeBearer: 'private-runtime-bearer' });
    expect(enriched.authenticatedPrincipal).toBe(principal);
    expect(enriched.isSuperuser).toBe(true);
    expect(JSON.stringify(enriched)).not.toContain('private-runtime-bearer');
    expect(() => normalizeNativeMcpOwnerSpawn(enriched)).toThrow('native_tool_owner_unsupported_capability');
  });

  it('removes synthetic bypass when the retained original principal has narrower capabilities', async () => {
    target(vi.fn());
    const principal = { kind: 'user' as const, slug: 'actual-user', workspaceId: address.workspaceId,
      authMethod: 'cookie-session' as const, trust: 'verified' as const, capabilities: new Set(['tasks:read']) };
    vi.spyOn(nativeInstalledPerUseTurns, 'resolveRequestPrincipal').mockResolvedValue(principal);
    const enriched = await retainNativeRequestPrincipalForDispatch(spawn, 'native-fixture:run', {}, 'runtime-bearer');
    expect(enriched).toMatchObject({ authenticatedPrincipal: principal, isSuperuser: false, isPowerUser: false });
  });

  it('grants no retained authority when the local registry or independent possession is unavailable', async () => {
    target(vi.fn());
    const resolve = vi.spyOn(nativeInstalledPerUseTurns, 'resolveRequestPrincipal').mockResolvedValue(null);
    expect(await retainNativeRequestPrincipalForDispatch(spawn, 'native-fixture:run', {}, 'runtime-bearer')).toBe(spawn);
    expect(await retainNativeRequestPrincipalForDispatch(spawn, 'native-fixture:run', {}, '')).toBe(spawn);
    const ordinary = { ...spawn, requestOrigin: undefined };
    expect(await retainNativeRequestPrincipalForDispatch(ordinary, 'native-fixture:run', {}, 'runtime-bearer')).toBe(ordinary);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({ runtimeBearer: '' }));
    expect(spawn.authenticatedPrincipal).toBeUndefined();
  });

  it('preserves installed funding bindings and grants nothing for an unloaded target', async () => {
    const resolve = vi.spyOn(nativeInstalledPerUseTurns, 'resolveRequestPrincipal').mockResolvedValue(null);
    target(vi.fn(), { pluginInstallation: { version: '1.0.0', path: '/installed', source: 'project' } });
    expect(await retainNativeRequestPrincipalForDispatch(spawn, 'native-fixture:run', {}, 'runtime-bearer')).toBe(spawn);
    expect(await retainNativeRequestPrincipalForDispatch(spawn, 'not-loaded:run', {}, 'runtime-bearer')).toBe(spawn);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('uses the owning loaded handler and preserves materialization and native call lineage', async () => {
    const fn = vi.fn(async (_args, ctx: UnifiedToolContext) => {
      expect(ctx.requestOrigin).toEqual(spawn.requestOrigin);
      expect(ctx.principal?.slug).toBe('system:operator');
      expect(ctx.uiClientId).toBe(address.ownerId);
      expect(ctx.spawnId).toBe('per-request-never-owner');
      expect(() => ctx.tx).toThrow('workspace_tx_not_declared');
      expect(ctx.contextTier).toBe('full'); expect(ctx.payloadTierOverride).toBe('full');
      expect(ctx.transportCapExempt).toBe(true); expect(ctx.requestedFormat).toBe('json');
      expect(ctx.requestedStructured).toBe(true); expect(ctx.requestedDelta).toBe('cursor');
      expect(ctx.idempotencyKey).toBe('native-key'); expect(ctx.sourceProjection).toEqual({ pick: ['value'] });
      expect(typeof ctx.dispatchTool).toBe('function');
      return { content: [{ type: 'text', text: 'owner-result' }] };
    });
    target(fn);
    expect(await dispatchNativeMcpTargetOnOwner(JSON.parse(JSON.stringify(request())), address))
      .toMatchObject({ content: [{ type: 'text', text: 'owner-result' }] });
    expect(fn).toHaveBeenCalledExactlyOnceWith({ value: 7 }, expect.any(Object));
  });

  it('re-emits owner progress notifications with the caller progress token', async () => {
    const notifications: unknown[] = [];
    const fn = vi.fn(async (_args, ctx: UnifiedToolContext) => {
      ctx.progress(34, 'applying migration');
      ctx.emit('migration-heartbeat', { phase: 'apply', elapsedSec: 30 });
      return { content: [{ type: 'text' as const, text: 'complete' }] };
    });
    target(fn);
    const r = { ...request(), progressToken: 'migrate-call-1' };

    await dispatchNativeMcpTargetOnOwner(r, address, { progress: value => notifications.push(value) });

    expect(notifications).toEqual([
      { method: 'notifications/papercusp/event', params: {
        progressToken: 'migrate-call-1', event: 'progress',
        data: { progress: 34, total: 100, message: 'applying migration' },
      } },
      { method: 'notifications/progress', params: {
        progressToken: 'migrate-call-1', progress: 34, total: 100, message: 'applying migration',
      } },
      { method: 'notifications/papercusp/event', params: {
        progressToken: 'migrate-call-1', event: 'migration-heartbeat', data: { phase: 'apply', elapsedSec: 30 },
      } },
    ]);
  });

  it('passes a caller-selected progress receiver into the native-owner relay', async () => {
    const receive = vi.fn();
    const r = request();
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'local' }] }));
    nativeOwnerRouting.run.mockImplementation(async (_address, _remoteRequest, runLocal) => runLocal());

    await runNativeMcpTargetOnOwner(r, local, 1_000, receive);

    expect(nativeOwnerRouting.run).toHaveBeenCalledOnce();
    expect(nativeOwnerRouting.run.mock.calls[0][4]).toBe(receive);
  });

  it('binds the current serving generation only when the request crosses the owner relay', async () => {
    const r = request();
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'local' }] }));
    nativeOwnerRouting.run.mockImplementation(async (_address, requestFactory, runLocal) => {
      const forwarded = await requestFactory();
      expect(forwarded.servingGeneration).toBe('serving-generation-v1:test');
      return runLocal();
    });

    await expect(runNativeMcpTargetOnOwner(r, local, 1_000))
      .resolves.toMatchObject({ content: [{ text: 'local' }] });
    expect(servingGeneration.read).toHaveBeenCalledOnce();
  });

  it.each(['workspace', 'adv', 'owner', 'thread', 'carrier', 'unbound'] as const)(
    'refuses a mismatched %s before handler execution', async kind => {
      const fn = vi.fn(); target(fn); const r = request();
      if (kind === 'workspace') r.spawn.workspaceId = 'other';
      if (kind === 'adv') r.spawn.advSessionId = 78;
      if (kind === 'owner') r.spawn.uiClientId = 'su-other';
      if (kind === 'thread') r.spawn.requestOrigin!.nativeSession!.valueFingerprint = 'b'.repeat(64);
      if (kind === 'carrier') r.spawn.requestOrigin!.nativeSession!.carrier = 'query:native_session';
      if (kind === 'unbound') r.spawn.requestOrigin!.nativeSession!.binding = 'unbound';
      await expect(dispatchNativeMcpTargetOnOwner(r, address)).rejects.toThrow(/native_tool_owner/);
      expect(fn).not.toHaveBeenCalled();
    });

  it('preserves a schema-valid recovery proof and the verified native session on owner dispatch', async () => {
    const r = request();
    r.spawn.harnessSlug = 'native-fixture-harness';
    const authority = { kind: 'superuser' as const, credentialSha256: 'a'.repeat(64), role: 'operator' };
    r.spawn.admissionRecoveryAuthority = authority;
    expect(normalizeNativeMcpOwnerSpawn(r.spawn).admissionRecoveryAuthority).toEqual(authority);
    const fn = vi.fn(async (_args, ctx: UnifiedToolContext) => {
      expect((ctx as UnifiedToolContext & Pick<BuiltSpawnContext, 'admissionRecoveryAuthority'>).admissionRecoveryAuthority).toEqual(authority);
      expect(ctx.advSessionId).toBe(address.advSessionId);
      expect(ctx.uiClientId).toBe(address.ownerId);
      return { content: [{ type: 'text' as const, text: 'recovery-proof-preserved' }] };
    });
    target(fn);
    expect(await dispatchNativeMcpTargetOnOwner(JSON.parse(JSON.stringify(r)), address))
      .toMatchObject({ content: [{ type: 'text', text: 'recovery-proof-preserved' }] });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('rejects malformed recovery proof before dispatch', async () => {
    const fn = vi.fn(); target(fn);
    const r = request();
    r.spawn.admissionRecoveryAuthority = {
      kind: 'superuser', credentialSha256: 'not-a-digest', role: 'operator',
    } as never;
    expect(() => normalizeNativeMcpOwnerSpawn(r.spawn)).toThrow('native_tool_owner_invalid_authority');
    await expect(dispatchNativeMcpTargetOnOwner(JSON.parse(JSON.stringify(r)), address))
      .rejects.toThrow('native_tool_owner_invalid_authority');
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects nonserializable principal grants rather than losing them during IPC', async () => {
    const fn = vi.fn(); target(fn); const r = request();
    r.spawn.authenticatedPrincipal = { slug: 'pi', capabilities: new Set(['grant']) } as never;
    expect(() => normalizeNativeMcpOwnerSpawn(r.spawn)).toThrow('native_tool_owner_unsupported_capability');
    await expect(dispatchNativeMcpTargetOnOwner(r, address)).rejects.toThrow('invalid_request');
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps a host-local principal on the owner process and only normalizes for forwarding', async () => {
    const r = request();
    r.spawn.authenticatedPrincipal = { slug: 'pi', capabilities: new Set(['grant']) } as never;
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'owner-local' }] }));
    nativeOwnerRouting.run.mockImplementation(async (_address, _remoteRequest, runLocal) => runLocal());

    await expect(runNativeMcpTargetOnOwner(r, local, 1_000))
      .resolves.toMatchObject({ content: [{ text: 'owner-local' }] });
    expect(local).toHaveBeenCalledOnce();
    expect(nativeOwnerRouting.run).toHaveBeenCalledOnce();
    expect(typeof nativeOwnerRouting.run.mock.calls[0][1]).toBe('function');
  });

  it('still refuses a host-local principal before a remote worker can receive it', async () => {
    const r = request();
    r.spawn.authenticatedPrincipal = { slug: 'pi', capabilities: new Set(['grant']) } as never;
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must-not-run' }] }));
    nativeOwnerRouting.run.mockImplementation(async (_address, remoteRequest) => remoteRequest());

    await expect(runNativeMcpTargetOnOwner(r, local, 1_000))
      .rejects.toThrow('native_tool_owner_unsupported_capability');
    expect(local).not.toHaveBeenCalled();
  });

  it('refuses malformed call fingerprints before the handler', async () => {
    const fn = vi.fn(); target(fn); const r = request();
    r.spawn.requestOrigin!.nativeSession!.callIdFingerprint = 'unbound-call';
    await expect(dispatchNativeMcpTargetOnOwner(r, address)).rejects.toThrow('invalid_lineage');
    expect(fn).not.toHaveBeenCalled(); expect(telemetry.recordInvocation).not.toHaveBeenCalled();
  });

  it('refuses a stale owner generation before target execution', async () => {
    const fn = vi.fn(); target(fn);
    const r = request(); r.servingGeneration = 'serving-generation-v1:stale';
    await expect(dispatchNativeMcpTargetOnOwner(r, address)).rejects.toThrow('stale_tool_contract');
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses an unknown owner generation before target execution', async () => {
    const fn = vi.fn(); target(fn);
    servingGeneration.read.mockResolvedValue({ state: 'unknown', reason: 'build-sha-unknown' });
    await expect(dispatchNativeMcpTargetOnOwner(request(), address)).rejects.toThrow('serving_generation_unknown');
    expect(fn).not.toHaveBeenCalled();
  });

  it('records owner principal synthesis failure once before dispatch', async () => {
    const fn = vi.fn(); target(fn, { requirePrincipal: true });
    await expect(dispatchNativeMcpTargetOnOwner(request(), address)).rejects.toThrow('fixture principal synthesis failed');
    expect(fn).not.toHaveBeenCalled();
    expect(telemetry.recordInvocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      toolName: 'native-fixture:run', status: 'error', args: { value: 7 },
      ctx: expect.objectContaining({ uiClientId: address.ownerId, requestOrigin: spawn.requestOrigin }),
    }));
  });

  it('persists the expected native-owner refusal code while leaving generic preflight errors code-less', async () => {
    const projected = { pluginName: 'native-fixture' } as ProjectedTool;
    const ctx = structuredClone(spawn) as unknown as UnifiedToolContext;
    const args = { value: 7 };

    await recordMcpPreflightFailure(projected, 'native-fixture:run', ctx, args, Date.now(),
      new Error('native_tool_owner_unsupported_capability'));
    expect(telemetry.recordInvocation).toHaveBeenCalledOnce();
    expect(telemetry.recordInvocation.mock.calls[0][0]).toMatchObject({
      toolName: 'native-fixture:run', pluginName: 'native-fixture', status: 'error',
      errorCode: 'native_tool_owner_unsupported_capability',
      errorMessage: 'native_tool_owner_unsupported_capability', args,
    });

    telemetry.recordInvocation.mockClear();
    await recordMcpPreflightFailure(projected, 'native-fixture:run', ctx, args, Date.now(),
      new Error('fixture principal synthesis failed'));
    expect(telemetry.recordInvocation).toHaveBeenCalledOnce();
    expect(telemetry.recordInvocation.mock.calls[0][0]).not.toHaveProperty('errorCode');
  });

  it('lets generic owner dispatch record a thrown handler once', async () => {
    const fn = vi.fn(async () => { throw new Error('fixture handler failed'); }); target(fn);
    expect(await dispatchNativeMcpTargetOnOwner(request(), address)).toMatchObject({ isError: true });
    expect(fn).toHaveBeenCalledOnce(); expect(telemetry.recordInvocation).toHaveBeenCalledOnce();
  });

  it('marks indirect targets and honors explicit tier with structured JSON materialization', async () => {
    target(vi.fn(async (_args, ctx) => {
      expect(ctx.indirectDispatch).toBe(true); expect(ctx.contextTier).toBe('trimmed');
      expect(ctx.transportCapExempt).not.toBe(true); expect(ctx.requestedFormat).toBe('json');
      return { content: [{ type: 'text', text: 'indirect' }] };
    }));
    const r = request(); r.fullSource = false; r.indirect = true; r.spawn.contextTier = 'trimmed';
    expect(await dispatchNativeMcpTargetOnOwner(r, address)).toMatchObject({ content: [{ text: 'indirect' }] });
  });
});
