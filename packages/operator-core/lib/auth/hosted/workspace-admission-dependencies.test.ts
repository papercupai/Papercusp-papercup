import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedWorkspaceProvisioningRequest } from './workspace-admission';

const h = vi.hoisted(() => ({
  confidence: 'estimated' as 'estimated' | 'unknown', monthly: 1.234, architecture: 'x86_64',
  disks: [] as Array<{ resource: { kind: string; providerId: string } }>,
  stopped: false,
}));
vi.mock('../../workspace-host/hosted-lifecycle-store', () => ({
  refreshHostedStoppedOwnerObservation: vi.fn(async () => null),
  admitHostedLifecycleJob: vi.fn(), readHostedLifecycleAdmission: vi.fn(), completeHostedPoolReuse: vi.fn(),
}));
vi.mock('../../dbos/workspace-host-provision-workflow', () => ({
  startWorkspaceHostProvisioningWorkflow: vi.fn(), startWorkspaceHostLifecycleWorkflow: vi.fn(),
}));
vi.mock('../../workspace-host/provisioning-runner', () => ({
  resolveControllerWorkspaceHostBootstrap: async () => ({ runtimeRelease: { bundleSha256: 'a'.repeat(64) } }),
}));
vi.mock('../../workspace-host/gcp-provider', () => ({
  createConfiguredGcpWorkspaceHostProvider: () => ({
    listSizes: async () => [{ id: 'size-a', available: true, cpuCount: 4, memoryMiB: 8192, architectures: ['x86_64'] }],
    listImages: async () => [{ id: 'image-a', architecture: h.architecture }],
    estimatePrice: async () => ({ confidence: h.confidence, monthlyAmount: h.monthly, hourlyAmount: 0,
      currency: 'USD', observedAt: '2026-10-16T00:00:00Z' }),
  }),
}));
vi.mock('../../workspace-host/observability-store', () => ({
  readWorkspaceHostConnection: vi.fn(), upsertWorkspaceHost: vi.fn(),
  readWorkspaceHostDestroyTarget: async () => ({ id: 'host-a', observedState: h.stopped ? 'stopped' : 'running', resources: h.disks }),
}));

const { resolveHostedPoolAdmission } = await import('./workspace-admission-dependencies');
const { refreshHostedStoppedOwnerObservation } = await import('../../workspace-host/hosted-lifecycle-store');
const input: HostedWorkspaceProvisioningRequest = {
  controlPlaneWorkspaceId: 'control-a', customerWorkspaceId: 'customer-a', connectionId: 'connection-a',
  hostId: 'host-a', name: 'Trial', operationId: 'operation-a', actorId: 'user-a',
  desiredSpec: { hostId: 'host-a', target: 'gcp', scope: { kind: 'project', id: 'project-a' },
    region: 'us-central1', zone: 'us-central1-a', size: 'size-a', image: { id: 'image-a' },
    data: { encrypted: true, volumeGiB: 256 }, credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://fixture' } } },
};

describe('server-owned hosted pool requirements', () => {
  beforeEach(() => { h.confidence = 'estimated'; h.monthly = 1.234; h.architecture = 'x86_64'; h.disks = []; h.stopped = false; vi.clearAllMocks(); });
  const stored = { connection: { target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: 'adc://fixture' } } } as const;

  it('uses the configured provider without a DBOS registry, rounds a nonzero estimate up, and pins tenant/data/runtime affinity', async () => {
    const result = await resolveHostedPoolAdmission(input, stored);
    expect(result).toMatchObject({ estimate: { cents: 124, currency: 'USD', estimatedAt: '2026-10-16T00:00:00Z' },
      pool: { dataVolumeId: 'unprovisioned:customer-a', scope: input.desiredSpec.scope,
        architecture: 'x86_64', minimum: { cpuCount: 4, memoryMiB: 8192 }, runtimeBundleSha256: 'a'.repeat(64) } });
  });

  it('refuses an unknown zero quote rather than granting free capacity', async () => {
    h.confidence = 'unknown'; h.monthly = 0;
    await expect(resolveHostedPoolAdmission(input, stored)).rejects.toMatchObject({ code: 'lifecycle_admission_unavailable' });
  });

  it('measures an existing stopped owner before returning the pool requirements and propagates safety refusal', async () => {
    h.stopped = true;
    h.disks = [{ resource: { kind: 'disk', providerId: 'disk-a' } }];
    expect((await resolveHostedPoolAdmission(input, stored)).pool?.dataVolumeId).toBe('disk-a');
    expect(refreshHostedStoppedOwnerObservation).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'control-a', customerWorkspaceId: 'customer-a', hostId: 'host-a', requestId: 'operation-a',
    }, expect.objectContaining({ resolveProvider: expect.any(Function) }));
    vi.mocked(refreshHostedStoppedOwnerObservation).mockRejectedValueOnce(new Error('foreign-disk'));
    await expect(resolveHostedPoolAdmission(input, stored)).rejects.toThrow('foreign-disk');
  });

  it('requires a measured architecture and unambiguous retained data volume', async () => {
    h.architecture = '';
    await expect(resolveHostedPoolAdmission(input, stored)).rejects.toMatchObject({ code: 'lifecycle_admission_unavailable' });
    h.architecture = 'x86_64';
    h.disks = [{ resource: { kind: 'disk', providerId: 'disk-a' } }, { resource: { kind: 'disk', providerId: 'disk-b' } }];
    await expect(resolveHostedPoolAdmission(input, stored)).rejects.toThrow('ambiguous');
    h.disks.pop();
    expect((await resolveHostedPoolAdmission(input, stored)).pool?.dataVolumeId).toBe('disk-a');
  });
});
