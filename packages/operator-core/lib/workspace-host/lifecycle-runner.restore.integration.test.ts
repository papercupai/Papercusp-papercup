/**
 * Snapshot restore through the PRODUCTION lifecycle store, against real Postgres and real RLS.
 *
 * The chaos suite drives the same runner through a fake store, and that is exactly why every
 * restore defect found live on 2026-09-22 slipped past it: the D-388 absent-source gate, the
 * post-restore observe target, and the controller fence all live in the store's SQL, which a fake
 * store does not have. Measured live: restore op p318-j23-restore-r39-20260922-1 wrote its new host
 * row at desired_revision=5 and then had its own first operation at revision 5 refused as stale,
 * retrying forever with no operation row. Provider calls stay fake; the store is the subject.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type {
  WorkspaceHostDesiredSpec,
  WorkspaceHostPlan,
  WorkspaceHostProvider,
  WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';
import { makeFakeWorkspaceHostProvider } from '@papercusp/deployment-driver';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(workspaceId: string, run: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: () => {} }));

const { runWorkspaceHostLifecycle } = await import('./lifecycle-runner');
const { DEFAULT_WORKSPACE_HOST_CONTROLLER_AUTHORITY } = await import('./provisioning-runner');
const {
  WorkspaceHostControllerFenceError,
  beginWorkspaceHostOperation,
  readWorkspaceHostDestroyTarget,
  updateWorkspaceHostLifecycleState,
  upsertWorkspaceHost,
  upsertWorkspaceHostResourceCheckpoint,
} = await import('./observability-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let sequence = 0;
const NOW = '2026-09-22T20:30:00.000Z';
const freshWorkspace = () => `wh_restore_ws_${++sequence}_${randomBytes(2).toString('hex')}`;
const SOURCE = 'host-restore-source';
const REPLACEMENT = 'host-restore-replacement';
const authority = DEFAULT_WORKSPACE_HOST_CONTROLLER_AUTHORITY;

const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://integration-test' },
  scope: { kind: 'project', id: 'project-1' },
};

function desired(hostId: string): WorkspaceHostDesiredSpec {
  return {
    hostId,
    target: 'gcp',
    scope: { kind: 'project', id: 'project-1' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-small',
    image: { id: 'projects/images/global/images/papercusp-v1' },
    data: { volumeGiB: 20, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://integration-test' } },
  };
}

const snapshot = { target: 'gcp' as const, providerId: 'pc-snap-source', hostId: SOURCE };

function restoreProvider(
  operationId: string,
  observeFails = false,
  beforeApply?: (request: Parameters<WorkspaceHostProvider['apply']>[0]) => Promise<void>,
) {
  const plan: WorkspaceHostPlan = {
    planId: `plan:${operationId}`,
    operationId,
    target: 'gcp',
    hostId: REPLACEMENT,
    generatedAt: NOW,
    steps: [
      {
        id: 'restore-instance',
        action: 'restore',
        resourceKind: 'vm',
        dependsOn: [],
        idempotencyKey: `restore:${operationId}`,
        destructive: false,
        input: { op: 'restore-instance', snapshotId: snapshot.providerId },
      },
    ],
    warnings: [],
  };
  const apply = vi.fn<WorkspaceHostProvider['apply']>(async (request) => {
    await beforeApply?.(request);
    return {
      operationId,
      stepId: request.step.id,
      state: 'applied' as const,
      observedAt: NOW,
      resource: { target: 'gcp', kind: 'vm', providerId: 'pc-host-restored', zone: 'us-central1-a' },
    };
  });
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
    validateConnection: vi.fn(async () => ({ ok: true, checkedAt: NOW, warnings: [], errors: [] })),
    plan: vi.fn(async () => plan),
    apply,
    reconcile: vi.fn<WorkspaceHostProvider['reconcile']>(),
    observe: vi.fn<WorkspaceHostProvider['observe']>(async (host) => {
      if (observeFails) throw new Error('compute read timed out');
      return { host, state: 'running' as const, resources: host.resources, observedAt: NOW, drift: [] };
    }),
  });
  return { provider, apply };
}

describe('workspace-host snapshot restore (real PG + real RLS)', () => {
  let db: OrgTestDb;

  /** A source host exactly as a real provision leaves it: fenced, revision 1, one applied VM. */
  async function seedProvisionedSource(workspaceId: string): Promise<void> {
    const connectionId = `conn_${randomBytes(3).toString('hex')}`;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections (
        workspace_id, id, target, label, credential_ref, status
      ) VALUES (
        ${workspaceId}, ${connectionId}, 'gcp', 'restore integration connection',
        'adc://integration-test', 'connected'
      )
    `;
    await upsertWorkspaceHost({
      workspaceId,
      id: SOURCE,
      name: 'Restore source',
      connectionId,
      target: 'gcp',
      scopeLabel: 'project-1',
      region: 'us-central1',
      size: 'e2-small',
      image: 'projects/images/global/images/papercusp-v1',
      diskGiB: 20,
      network: 'default',
      desiredState: 'running',
      observedState: 'running',
      desiredSpec: desired(SOURCE),
      hostGeneration: 1,
      desiredRevision: 1,
      observedRevision: 0,
      controllerAuthority: authority,
    });
    await beginWorkspaceHostOperation({
      workspaceId,
      operationId: 'provision-source',
      hostId: SOURCE,
      action: 'provision',
      desiredRevision: 1,
      controllerAuthority: authority,
    });
    await upsertWorkspaceHostResourceCheckpoint({
      workspaceId,
      hostId: SOURCE,
      operationId: 'provision-source',
      checkpoint: {
        logicalKey: 'create-instance',
        state: 'applied',
        attempts: 1,
        providerResource: { target: 'gcp', kind: 'vm', providerId: 'pc-host-source', zone: 'us-central1-a' },
      },
      controllerAuthority: authority,
    });
  }

  function restore(workspaceId: string, operationId: string, provider: WorkspaceHostProvider) {
    return runWorkspaceHostLifecycle({
      workspaceId,
      hostId: SOURCE,
      connection,
      provider,
      action: 'restore',
      operationId,
      snapshot,
      desired: desired(REPLACEMENT),
    });
  }

  async function hostRow(workspaceId: string, hostId: string) {
    const [row] = await db.adminSql<
      { host_generation: number; desired_revision: number; observed_state: string; desired_state: string }[]
    >`
      SELECT host_generation, desired_revision, observed_state, desired_state
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}
    `;
    return row;
  }

  async function operationRow(workspaceId: string, operationId: string) {
    const [row] = await db.adminSql<
      { host_id: string; action: string; status: string; desired_revision: number }[]
    >`
      SELECT host_id, action, status, desired_revision
      FROM harness_shared.workspace_host_operations
      WHERE workspace_id = ${workspaceId} AND id = ${operationId}
    `;
    return row;
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('opens the replacement host\'s first operation at the revision it was written with', async () => {
    const workspaceId = freshWorkspace();
    await seedProvisionedSource(workspaceId);
    const { provider, apply } = restoreProvider('op-restore');

    await expect(restore(workspaceId, 'op-restore', provider)).resolves.toMatchObject({
      status: 'succeeded',
      hostId: REPLACEMENT,
      requiresInitialization: true,
    });

    expect(apply).toHaveBeenCalledTimes(1);
    await expect(operationRow(workspaceId, 'op-restore')).resolves.toEqual({
      host_id: REPLACEMENT,
      action: 'restore',
      status: 'succeeded',
      desired_revision: 2,
    });
    await expect(hostRow(workspaceId, REPLACEMENT)).resolves.toEqual({
      host_generation: 2,
      desired_revision: 2,
      observed_state: 'running',
      desired_state: 'running',
    });
    // The source is only READ by a restore: its revision and state must not move.
    await expect(hostRow(workspaceId, SOURCE)).resolves.toMatchObject({ host_generation: 1, desired_revision: 1 });
  });

  it('never lends the SOURCE host\'s resources to the replacement it is building', async () => {
    const workspaceId = freshWorkspace();
    await seedProvisionedSource(workspaceId);
    const seen: { known: string[]; checkpointed: string | null }[] = [];
    const { provider } = restoreProvider('op-restore-own', false, async (request) => {
      const [row] = await db.adminSql<{ provider_id: string | null }[]>`
        SELECT provider_id FROM harness_shared.workspace_host_resources
        WHERE workspace_id = ${workspaceId} AND host_id = ${REPLACEMENT} AND logical_key = ${request.step.id}
      `;
      seen.push({
        known: request.knownResources.map((resource) => resource.providerId),
        checkpointed: row?.provider_id ?? null,
      });
    });

    await restore(workspaceId, 'op-restore-own', provider);

    // The source VM 'pc-host-source' is an applied, same-kind resource — exactly what the plan
    // matcher used to adopt into the replacement's 'applying' checkpoint.
    expect(seen).toEqual([{ known: [], checkpointed: null }]);
  });

  it('replays the same restore operation (a retried workflow step) without a second provider mutation', async () => {
    const workspaceId = freshWorkspace();
    await seedProvisionedSource(workspaceId);
    const first = restoreProvider('op-restore-replay');
    await restore(workspaceId, 'op-restore-replay', first.provider);

    const replay = restoreProvider('op-restore-replay');
    await expect(restore(workspaceId, 'op-restore-replay', replay.provider)).resolves.toMatchObject({
      status: 'succeeded',
      hostId: REPLACEMENT,
    });
    expect(replay.apply).not.toHaveBeenCalled();
  });

  it('keeps the first-operation exception narrow: a SECOND operation at the same revision is still stale', async () => {
    const workspaceId = freshWorkspace();
    await seedProvisionedSource(workspaceId);
    await restore(workspaceId, 'op-restore-first', restoreProvider('op-restore-first').provider);

    await expect(
      beginWorkspaceHostOperation({
        workspaceId,
        operationId: 'op-restore-second',
        hostId: REPLACEMENT,
        action: 'restore',
        desiredRevision: 2,
        controllerAuthority: authority,
      }),
    ).rejects.toBeInstanceOf(WorkspaceHostControllerFenceError);
    // WI-10005312 records fenced requests as terminal failures for the timeline.
    // The receipt must not turn the rejected request into an admitted restore.
    await expect(operationRow(workspaceId, 'op-restore-second')).resolves.toEqual({
      host_id: REPLACEMENT,
      action: 'restore',
      status: 'failed',
      desired_revision: 2,
    });
    await expect(hostRow(workspaceId, REPLACEMENT)).resolves.toMatchObject({
      host_generation: 2,
      desired_revision: 2,
    });
  });

  it('registers a snapshot as a recovery point the host (and its destroy census) can see (D-389, WI-10002470)', async () => {
    // Measured live: a succeeded snapshot op left its checkpoint with NULL provider identity and the
    // host reading "No recovery point recorded", so the later destroy census called the host's own
    // backup an untracked orphan. Both halves live in store SQL, which a fake store cannot see.
    const workspaceId = freshWorkspace();
    await seedProvisionedSource(workspaceId);
    const operationId = 'op-snapshot-recovery-point';
    const provider = makeFakeWorkspaceHostProvider({
      target: 'gcp',
      validateConnection: vi.fn(async () => ({ ok: true, checkedAt: NOW, warnings: [], errors: [] })),
      plan: vi.fn(async () => ({
        planId: `plan:${operationId}`,
        operationId,
        target: 'gcp' as const,
        hostId: SOURCE,
        generatedAt: NOW,
        steps: [
          {
            id: 'snapshot-data-disk',
            action: 'snapshot' as const,
            resourceKind: 'snapshot',
            dependsOn: [],
            idempotencyKey: `snapshot:${operationId}`,
            destructive: false,
            input: { op: 'create-snapshot', request: { name: 'pc-snap-registered' } },
          },
        ],
        warnings: [],
      })),
      apply: vi.fn<WorkspaceHostProvider['apply']>(async (request) => ({
        operationId,
        stepId: request.step.id,
        state: 'applied' as const,
        observedAt: NOW,
        snapshot: { target: 'gcp', providerId: 'pc-snap-registered', hostId: SOURCE, createdAt: NOW },
      })),
      reconcile: vi.fn<WorkspaceHostProvider['reconcile']>(),
      observe: vi.fn<WorkspaceHostProvider['observe']>(async (host) => ({
        host,
        state: 'running' as const,
        resources: host.resources,
        observedAt: NOW,
        drift: [],
      })),
    });

    await expect(
      runWorkspaceHostLifecycle({
        workspaceId,
        hostId: SOURCE,
        connection,
        provider,
        action: 'snapshot',
        operationId,
        name: 'pc-snap-registered',
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });

    const target = await readWorkspaceHostDestroyTarget(workspaceId, SOURCE);
    const registered = target!.resources.map((entry) => `${entry.resource.kind}:${entry.resource.providerId}`);
    // POSITIVE CONTROL: the seeded VM must read back, or an empty population would pass vacuously.
    expect(registered).toContain('vm:pc-host-source');
    expect(registered).toContain('snapshot:pc-snap-registered');
    expect(target!.recoverability).toMatchObject({ kind: 'snapshot', label: 'pc-snap-registered' });
    // A snapshot keeps the host in service: it must not move the host toward destroy.
    await expect(hostRow(workspaceId, SOURCE)).resolves.toMatchObject({ observed_state: 'running' });
  });

  it('restores from a READY snapshot after its source host was destroyed (D-388)', async () => {
    const workspaceId = freshWorkspace();
    await seedProvisionedSource(workspaceId);
    await db.adminSql`
      UPDATE harness_shared.workspace_host_resources
      SET state = 'absent'
      WHERE workspace_id = ${workspaceId} AND host_id = ${SOURCE}
    `;
    await updateWorkspaceHostLifecycleState({ workspaceId, hostId: SOURCE, state: 'absent', observedAt: NOW });

    await expect(
      restore(workspaceId, 'op-restore-absent', restoreProvider('op-restore-absent').provider),
    ).resolves.toMatchObject({ status: 'succeeded', hostId: REPLACEMENT });
    await expect(hostRow(workspaceId, SOURCE)).resolves.toMatchObject({ observed_state: 'absent' });
  });

  it('records a failed post-restore observation against the NEW host instead of throwing', async () => {
    const workspaceId = freshWorkspace();
    await seedProvisionedSource(workspaceId);

    await expect(
      restore(workspaceId, 'op-restore-blind', restoreProvider('op-restore-blind', true).provider),
    ).resolves.toMatchObject({ status: 'succeeded', hostId: REPLACEMENT });
    const events = await db.adminSql<{ host_id: string; phase: string }[]>`
      SELECT host_id, phase FROM harness_shared.workspace_host_events
      WHERE workspace_id = ${workspaceId} AND operation_id = 'op-restore-blind' AND phase = 'observe'
    `;
    expect(events).toEqual([{ host_id: REPLACEMENT, phase: 'observe' }]);
  });
});
