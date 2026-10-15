import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hostState = vi.hoisted(() => ({ host: null as any }));
const rpc = vi.hoisted(() => ({ available: vi.fn(), call: vi.fn() }));

vi.mock('./su-session-host', async importOriginal => ({
  ...await importOriginal<typeof import('./su-session-host')>(),
  getRegisteredSuSessionHost: vi.fn(() => hostState.host),
}));
vi.mock('./cluster-owner-rpc', async importOriginal => ({
  ...await importOriginal<typeof import('./cluster-owner-rpc')>(),
  ownerRpcAvailable: rpc.available,
  callOwnerProcess: rpc.call,
}));

import {
  _configureSuSessionRoutingForTest,
  localSuSessionHostOwner,
  runOnSuNativeToolOwner,
  type SuNativeToolAddress,
} from './su-session-owner-routing';

const address: SuNativeToolAddress = {
  workspaceId: 'fixture-workspace',
  advSessionId: 77,
  ownerId: 'su-fixture',
  nativeSessionIdFingerprint: createHash('sha256').update('native-77').digest('hex'),
};

beforeEach(() => {
  hostState.host = {
    hasRuntime: () => true,
    descriptor: () => ({
      lifecycle: 'ready',
      identity: {
        backend: 'codex',
        workspaceId: address.workspaceId,
        advSessionId: address.advSessionId,
        ownerId: address.ownerId,
        nativeSessionId: 'native-77',
      },
    }),
  };
  rpc.available.mockReturnValue(true);
  rpc.call.mockResolvedValue({ ok: true, result: { status: 'ok', result: 'forwarded' } });
  _configureSuSessionRoutingForTest({ readOwner: async () => localSuSessionHostOwner() });
});

afterEach(() => {
  _configureSuSessionRoutingForTest();
  vi.clearAllMocks();
});

describe('native MCP owner request materialization', () => {
  it('does not materialize a host-local request when this process owns the session', async () => {
    const makeRemoteRequest = vi.fn(() => { throw new Error('host-local request was serialized'); });
    const local = vi.fn(async () => 'local-result');

    await expect(runOnSuNativeToolOwner(address, makeRemoteRequest, local)).resolves.toBe('local-result');
    expect(makeRemoteRequest).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledOnce();
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('materializes the request only after selecting a different live owner', async () => {
    const localOwner = localSuSessionHostOwner();
    _configureSuSessionRoutingForTest({ readOwner: async () => ({ ...localOwner, pid: localOwner.pid + 1 }) });
    const makeRemoteRequest = vi.fn(() => ({ toolName: 'native-fixture:run' }));
    const local = vi.fn(async () => 'local-result');

    await expect(runOnSuNativeToolOwner(address, makeRemoteRequest, local)).resolves.toBe('forwarded');
    expect(makeRemoteRequest).toHaveBeenCalledOnce();
    expect(local).not.toHaveBeenCalled();
    expect(rpc.call).toHaveBeenCalledOnce();
    expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        request: { op: 'native-tool', body: { toolName: 'native-fixture:run' } },
      }),
    }));
  });
});
