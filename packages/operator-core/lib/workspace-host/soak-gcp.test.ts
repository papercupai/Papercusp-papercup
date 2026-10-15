import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import { describe, expect, it, vi } from 'vitest';
import { resolveGcpWorkspaceHostSoakSeams } from './soak-gcp';
import { WORKSPACE_HOST_SOAK_READ_ATTEMPTS, WORKSPACE_HOST_SOAK_READ_RETRY_MS } from './soak-ssh-probe';

const desired = {
  hostId: 'host-soak',
  target: 'gcp',
  scope: { kind: 'project', id: 'soak-project' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-standard-4',
  image: { id: 'projects/p/global/images/papercusp-host-v1' },
  data: { encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
} as WorkspaceHostDesiredSpec;

const running = {
  name: 'pc-host-soak-vm',
  status: 'RUNNING',
  instanceId: '4715512353118305137',
  sourceImage: 'https://www.googleapis.com/compute/v1/projects/p/global/images/papercusp-host-v1',
};

/** What undici throws for a dropped request: the r39 soak persisted exactly this message. */
function fetchFailed(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
}

async function readWith(getInstance: (...args: unknown[]) => Promise<unknown>) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const seams = await resolveGcpWorkspaceHostSoakSeams({
    workspaceId: 'workspace-1',
    hostId: desired.hostId,
    readDesiredSpec: (async () => ({ desired, connectionId: 'connection-1' })) as never,
    gcpClient: { getInstance } as never,
    timing: { sleep },
  });
  return { reading: await seams.readInstance(), sleep };
}

describe('soak instance read (WI-10002796)', () => {
  it('asks again after a dropped request, so one transport blip does not cost a measured sample', async () => {
    const getInstance = vi.fn().mockRejectedValueOnce(fetchFailed()).mockResolvedValueOnce(running);

    const { reading, sleep } = await readWith(getInstance);

    expect(reading).toEqual({
      kind: 'observed',
      status: 'RUNNING',
      instanceId: running.instanceId,
      sourceImage: running.sourceImage,
    });
    expect(getInstance).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(WORKSPACE_HOST_SOAK_READ_RETRY_MS);
  });

  it('marks a SPOT instance preemptible, so standing health can tell a reclaim from a stop (WI-10005210)', async () => {
    const spot = await readWith(vi.fn(async () => ({ ...running, status: 'TERMINATED', provisioningModel: 'SPOT' })));
    expect(spot.reading).toEqual({
      kind: 'observed',
      status: 'TERMINATED',
      instanceId: running.instanceId,
      sourceImage: running.sourceImage,
      preemptible: true,
    });
    const standard = await readWith(vi.fn(async () => ({ ...running, provisioningModel: 'STANDARD' })));
    expect(standard.reading).not.toHaveProperty('preemptible');
  });

  it('stays unreadable after the attempt budget, naming the cause code and the attempts', async () => {
    const getInstance = vi.fn(async () => {
      throw fetchFailed();
    });

    const { reading, sleep } = await readWith(getInstance);

    expect(reading.kind).toBe('unreadable');
    expect(reading.kind === 'unreadable' && reading.detail).toBe(
      `fetch failed (UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error) (after ${WORKSPACE_HOST_SOAK_READ_ATTEMPTS} attempts)`,
    );
    expect(getInstance).toHaveBeenCalledTimes(WORKSPACE_HOST_SOAK_READ_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(WORKSPACE_HOST_SOAK_READ_ATTEMPTS - 1);
  });

  it('does not repeat a non-transient failure: it would fail the same way every time', async () => {
    const getInstance = vi.fn(async () => {
      throw new Error('GCP compute instances.get failed: HTTP 403 PERMISSION_DENIED');
    });

    const { reading, sleep } = await readWith(getInstance);

    expect(reading).toEqual({ kind: 'unreadable', detail: 'GCP compute instances.get failed: HTTP 403 PERMISSION_DENIED' });
    expect(getInstance).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('takes an absent instance as the answer on the first read', async () => {
    const getInstance = vi.fn(async () => undefined);

    const { reading, sleep } = await readWith(getInstance);

    expect(reading).toEqual({ kind: 'absent' });
    expect(getInstance).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('hosted GCP soak credential binding (EI-24251466668871395)', () => {
  const credentialRef = 'delegation://ws-soak/conn-soak';
  const hostedDesired = {
    ...desired,
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: credentialRef } },
  } as WorkspaceHostDesiredSpec;

  it('uses the recorded host connection for delegated Compute reads', async () => {
    const provider = { hostedDelegation: { marker: 'recorded-connection' } };
    const readConnection = vi.fn(async () => ({ connection: { provider } }));
    const resolveHostedAuth = vi.fn(async () => ({ accessToken: 'hosted-test-token' }));
    const gcpFetch = vi.fn(async () => new Response('', { status: 404 }));
    const seams = await resolveGcpWorkspaceHostSoakSeams({
      workspaceId: 'workspace-1',
      hostId: hostedDesired.hostId,
      readDesiredSpec: (async () => ({ desired: hostedDesired, connectionId: 'connection-1' })) as never,
      readConnection: readConnection as never,
      resolveHostedAuth,
      gcpFetch: gcpFetch as typeof fetch,
    });

    expect(await seams.readInstance()).toEqual({ kind: 'absent' });
    expect(readConnection).toHaveBeenCalledWith('workspace-1', 'connection-1');
    expect(resolveHostedAuth).toHaveBeenCalledWith({ credentialRef, provider });
    expect(gcpFetch).toHaveBeenCalledOnce();
  });

  it('refuses a hosted delegation whose saved connection is missing', async () => {
    await expect(resolveGcpWorkspaceHostSoakSeams({
      workspaceId: 'workspace-1',
      hostId: hostedDesired.hostId,
      readDesiredSpec: (async () => ({ desired: hostedDesired, connectionId: 'connection-1' })) as never,
      readConnection: (async () => null) as never,
    })).rejects.toThrow('gcp_workspace_host_hosted_connection_missing');
  });
});
