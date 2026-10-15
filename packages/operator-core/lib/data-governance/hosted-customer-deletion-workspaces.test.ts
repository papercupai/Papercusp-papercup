import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
vi.mock('@papercusp/db-org', () => ({ withWorkspace: vi.fn() }));
vi.mock('../workspace-host/observability-store', () => ({ readWorkspaceHostConnection: vi.fn(), readWorkspaceHostDestroyTarget: vi.fn() }));
import { createHostedCustomerDeletionWorkspaceAdapter } from './hosted-customer-deletion-workspaces';
import type { HostedCustomerDeletionRequest } from './hosted-customer-deletion';
import type { HostedCustomerDeletionSnapshot } from './hosted-customer-deletion-store';
import type { StoredWorkspaceHostConnection, StoredWorkspaceHostDestroyTarget } from '../workspace-host/observability-store';

const request: HostedCustomerDeletionRequest = { operationId: 'operation', organizationId: 'tenant', requestedBy: 'actor',
  target: { kind: 'organization' }, policy: { approvalRef: 'approved', stripe: 'delete', consent: 'retain' } };

function fixture() {
  const tx = {} as Sql;
  const snapshot: HostedCustomerDeletionSnapshot = { schemaVersion: 1, request, controlPlaneWorkspaceId: 'control-plane',
    organizationIdentity: { provider: 'workos', subject: 'org_1' }, users: [], stripeCustomerId: null,
    workspaces: [{ workspaceId: 'customer-workspace', hostId: 'host-1' }] };
  const readAuthorizedSnapshot = vi.fn(async () => snapshot);
  const target: StoredWorkspaceHostDestroyTarget = { id: 'host-1', name: 'Customer host', connectionId: 'connection-1',
    hostGeneration: 1, desiredRevision: 1, observedRevision: 1,
    target: 'gcp', observedState: 'ready', resources: [], desired: { hostId: 'host-1', target: 'gcp',
      scope: { kind: 'project', id: 'customer-project' }, region: 'us-central1', size: 'e2-small', image: { id: 'image-1' },
      data: { volumeGiB: 20, encrypted: true }, credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'organization-bound-reference' } } } };
  const stored: StoredWorkspaceHostConnection = { id: 'connection-1', target: 'gcp', status: 'connected', connection: {
    target: 'gcp', cloudCredentialRef: { kind: 'cloud', ref: 'organization-bound-reference' },
    scope: { kind: 'project', id: 'wrong-default-project' },
  } };
  const readTarget = vi.fn(async (): Promise<StoredWorkspaceHostDestroyTarget | null> => target);
  const readConnection = vi.fn(async () => stored);
  let transactionOpen = false;
  const runWorkspace = async <T>(workspaceId: string, fn: (sql: Sql) => Promise<T>): Promise<T> => {
    expect(workspaceId).toBe('control-plane'); transactionOpen = true;
    try { return await fn(tx); } finally { transactionOpen = false; }
  };
  const destroy = vi.fn(async (input: { operationId?: string; hostId: string }) => {
    expect(transactionOpen).toBe(false);
    return { status: 'succeeded', operationId: input.operationId!, hostId: input.hostId };
  });
  const adapter = createHostedCustomerDeletionWorkspaceAdapter({ readAuthorizedSnapshot, readTarget, readConnection, runWorkspace, destroy });
  return { adapter, snapshot, tx, readAuthorizedSnapshot, readTarget, readConnection, destroy };
}

describe('customer deletion workspace teardown', () => {
  it('uses frozen targets and the target provider scope, waits outside SQL and reuses the same child identity on replay', async () => {
    const f = fixture();
    await expect(f.adapter(request)).resolves.toBe('workspace_destroy_workflows_completed');
    await f.adapter(request);
    expect(f.readTarget).toHaveBeenCalledWith('control-plane', 'host-1', f.tx);
    expect(f.readConnection).toHaveBeenCalledWith('control-plane', 'connection-1', f.tx);
    const [first, replay] = f.destroy.mock.calls.map(([input]) => input);
    expect(first?.operationId).toEqual(replay?.operationId);
    expect(first).toMatchObject({ workspaceId: 'control-plane', hostId: 'host-1', connectionId: 'connection-1',
      actorId: 'actor', disposition: 'discard', connection: { scope: { kind: 'project', id: 'customer-project' } },
      confirmation: { expectedHostId: 'host-1', confirmedBy: 'actor' } });
  });

  it('refuses policy failure and user scope before reading or mutating workspace resources', async () => {
    const f = fixture();
    f.readAuthorizedSnapshot.mockRejectedValueOnce(new Error('policy-not-approved'));
    await expect(f.adapter(request)).rejects.toThrow('policy-not-approved');
    await expect(f.adapter({ ...request, target: { kind: 'user', userId: 'actor' } })).rejects.toThrow('workspace-snapshot-mismatch');
    expect(f.readTarget).not.toHaveBeenCalled();
    expect(f.destroy).not.toHaveBeenCalled();
  });

  it('refuses missing or mismatched controller targets instead of inventing an absence receipt', async () => {
    const f = fixture();
    f.readTarget.mockResolvedValue(null);
    await expect(f.adapter(request)).rejects.toThrow('workspace-target-unavailable');
    expect(f.destroy).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'failed'])('does not interpret %s as completed teardown', async status => {
    const f = fixture();
    f.destroy.mockImplementation(async input => ({ status, operationId: input.operationId!, hostId: input.hostId }));
    await expect(f.adapter(request)).rejects.toThrow('workspace-destruction-unconfirmed');
  });

  it('refuses a success receipt for another operation or host', async () => {
    const f = fixture();
    f.destroy.mockResolvedValue({ status: 'succeeded', operationId: 'other-operation', hostId: 'host-1' });
    await expect(f.adapter(request)).rejects.toThrow('workspace-destruction-unconfirmed');
  });
});
