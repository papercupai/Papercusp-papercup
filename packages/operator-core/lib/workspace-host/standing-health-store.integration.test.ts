/**
 * standing-health-store.integration.test.ts — which hosts the standing health pass probes,
 * against REAL Postgres exercising REAL (forced) RLS (WI-10004950).
 *
 * Why this is an integration test and not a unit test with a fake store:
 *
 * 1. FORCED RLS. `workspace_hosts` FORCES row-level security, so a cross-workspace read through the
 *    RLS-subject app role returns ZERO rows — no error, just an empty list that reads exactly like
 *    "no live hosts". The pass would then probe nothing, forever, silently. Only a real policy can
 *    show the admin-pool read sees every workspace while the app role sees none.
 *
 * 2. THE FILTER IS THE AUTHORITY RULE. Only hosts stamped with THIS controller's id, meant to be up,
 *    on a target with standing seams, with a recorded spec, may be probed. Each exclusion here is a
 *    host that would otherwise cost an IAP reach or be attested by a controller that does not own it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any, adminSql: null as any }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(ws: string, cb: (tx: unknown) => Promise<T>, opts?: { bypassRlsForAdmin?: boolean }): Promise<T> =>
    (opts?.bypassRlsForAdmin ? h.adminSql : h.appSql).begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }),
}));
// The store fans sync invalidations on some writes; that transport is not under test here.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: () => {} }));

const { recordWorkspaceHostHealth, upsertWorkspaceHost, readWorkspaceHostReliability } = await import('./observability-store');
const { listWorkspaceHostSpotReclaimTargets, listWorkspaceHostStandingHealthTargets } = await import(
  './standing-health-store'
);
const { createOrgTestDb } = await import('../../test/_org-test-db');

const suffix = randomBytes(3).toString('hex');
const MINE = `papercusp-workspace-host-controller:standing-${suffix}`;
const OTHER = `papercusp-workspace-host-controller:other-${suffix}`;
const WS_A = `shs_a_${suffix}`;
const WS_B = `shs_b_${suffix}`;

function spec(hostId: string, provisioningModel?: 'spot' | 'standard'): WorkspaceHostDesiredSpec {
  return {
    hostId,
    target: 'gcp',
    scope: { kind: 'project', id: 'active-alcove-504205-q3' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'e2-standard-4',
    image: { id: 'projects/p/global/images/papercusp-host-v1' },
    data: { volumeGiB: 64, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
    // The GCP provider block, where a spot host records its model (gcp-provider.ts).
    ...(provisioningModel ? { provider: { projectId: 'active-alcove-504205-q3', provisioningModel } } : {}),
  } as WorkspaceHostDesiredSpec;
}

describe('listWorkspaceHostStandingHealthTargets (real PG + forced RLS)', () => {
  let db: OrgTestDb;

  async function seedConnection(workspaceId: string): Promise<string> {
    const connectionId = `conn_${randomBytes(3).toString('hex')}`;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref)
      VALUES (${workspaceId}, ${connectionId}, 'gcp', 'test connection', 'cloudCredentialRef:test')
    `;
    return connectionId;
  }

  async function seedHost(input: {
    workspaceId: string;
    connectionId: string;
    id: string;
    controllerId: string;
    desiredState: string;
    withSpec?: boolean;
    provisioningModel?: 'spot' | 'standard';
    target?: 'gcp' | 'aws';
  }): Promise<void> {
    await upsertWorkspaceHost({
      workspaceId: input.workspaceId,
      id: input.id,
      name: input.id,
      connectionId: input.connectionId,
      target: input.target ?? 'gcp',
      scopeLabel: 'test-project',
      region: 'us-central1',
      size: 'e2-standard-4',
      image: 'papercusp-host-v1',
      diskGiB: 64,
      network: 'default',
      desiredState: input.desiredState,
      observedState: input.desiredState,
      controllerAuthority: { controllerId: input.controllerId, fence: 1 },
      ...(input.withSpec === false ? {} : { desiredSpec: spec(input.id, input.provisioningModel) }),
    });
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
    const connA = await seedConnection(WS_A);
    const connB = await seedConnection(WS_B);
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-running', controllerId: MINE, desiredState: 'running' });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-stopped', controllerId: MINE, desiredState: 'stopped' });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-repairing', controllerId: MINE, desiredState: 'repairing' });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-absent', controllerId: MINE, desiredState: 'absent' });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-other-controller', controllerId: OTHER, desiredState: 'running' });
    await seedHost({
      workspaceId: WS_A,
      connectionId: connA,
      id: 'a-no-spec',
      controllerId: MINE,
      desiredState: 'running',
      withSpec: false,
    });
    await seedHost({ workspaceId: WS_B, connectionId: connB, id: 'b-degraded', controllerId: MINE, desiredState: 'degraded' });
    // Spot hosts (WI-10005210): the reclaim sweep's population, and still standing-health targets.
    const spot = { provisioningModel: 'spot' as const };
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-spot', controllerId: MINE, desiredState: 'running', ...spot });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-spot-stopped', controllerId: MINE, desiredState: 'stopped', ...spot });
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-spot-other', controllerId: OTHER, desiredState: 'running', ...spot });
    await seedHost({
      workspaceId: WS_A,
      connectionId: connA,
      id: 'a-standard',
      controllerId: MINE,
      desiredState: 'running',
      provisioningModel: 'standard',
    });
    await seedHost({ workspaceId: WS_B, connectionId: connB, id: 'b-spot-degraded', controllerId: MINE, desiredState: 'degraded', ...spot });
    // WI-10005389: an AWS spot host is in the sweep's population too (its restart is EC2's, not ours).
    await seedHost({ workspaceId: WS_A, connectionId: connA, id: 'a-aws-spot', controllerId: MINE, desiredState: 'running', target: 'aws', ...spot });
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('projects real scoped hosted health, lifecycle duration and sampled API evidence without customer fields', async () => {
    const now = Date.now();
    const wsA = `reliability_a_${suffix}`;
    const wsB = `reliability_b_${suffix}`;
    for (const ws of [wsA, wsB]) {
      const connectionId = await seedConnection(ws);
      await seedHost({ workspaceId: ws, connectionId, id: 'rly-host', controllerId: `${OTHER}:reliability`, desiredState: 'running' });
      await db.adminSql`
        UPDATE harness_shared.workspace_hosts
        SET observed_state = 'running', health_status = 'unreachable',
            health_attested_at = ${new Date(now)}, health_checks = '[{"detail":"private guest output"}]'::jsonb
        WHERE workspace_id = ${ws} AND id = 'rly-host'
      `;
      await db.adminSql`
        INSERT INTO harness_shared.customer_workspaces
          (workspace_id, id, organization_id, workspace_host_id, display_name, state,
           created_by_principal_kind, created_by_principal_id, billing_owner_kind, billing_owner_id)
        VALUES (${ws}, 'customer-rly', 'org-rly', 'rly-host', 'private customer name', 'active',
          'hosted-user', 'user-rly', ${ws === wsA ? 'platform' : 'organization'}, 'billing-rly')
      `;
      await db.adminSql`
        INSERT INTO harness_shared.workspace_host_operations
          (workspace_id, id, host_id, action, status, created_at, finished_at, customer_workspace_id)
        VALUES (${ws}, 'rly-ready', 'rly-host', 'provision', 'succeeded',
          ${new Date(now - 1000)}, ${new Date(now - 750)}, 'customer-rly')
      `;
      await db.adminSql`
        INSERT INTO harness_shared.route_invocations (workspace_id, method, path, status, duration_ms, invoked_at)
        VALUES (${ws}, 'GET', '/api/hosted/workspaces/:id', 'ok', 25, ${new Date(now - 500)}),
          (${ws}, 'GET', '/api/hosted/workspaces/:id', 'timeout', 500, ${new Date(now - 500)}),
          (${ws}, 'INTERNAL', 'internal:expertise-routing', 'error', 9000, ${new Date(now - 500)})
      `;
    }
    const reading = await readWorkspaceHostReliability(wsA, now);
    expect(reading.hosts).toEqual({ expectedRunning: 1, unhealthy: 1, unobserved: 0, platformOwnedRunning: 1 });
    expect(reading.lifecycle).toEqual({ succeeded: 1, failed: 0, queued: 0, running: 0, successP95Ms: 250 });
    expect(reading.api).toEqual({ samples: 2, errors: 1, p95Ms: 25 });
    expect(reading.providerConnections).toEqual({ connected: 0, degraded: 1 });
    expect(JSON.stringify(reading)).not.toMatch(/private|org-rly|user-rly|customer-rly|billing-rly/);
    await db.adminSql`UPDATE harness_shared.workspace_hosts SET health_status = 'healthy', health_attested_at = ${new Date(now)}
      WHERE workspace_id = ${wsA} AND id = 'rly-host'`;
    await db.adminSql`UPDATE harness_shared.workspace_host_connections SET status = 'connected'
      WHERE workspace_id = ${wsA}`;
    const recovered = await readWorkspaceHostReliability(wsA, now);
    expect(recovered.hosts?.unhealthy).toBe(0);
    expect(recovered.providerConnections).toEqual({ connected: 1, degraded: 0 });
    // Expired health is unknown, not an observed recovery or a fresh outage.
    const stale = await readWorkspaceHostReliability(wsB, now + 21 * 60_000);
    expect(stale.hosts).toEqual({ expectedRunning: 1, unhealthy: 0, unobserved: 1, platformOwnedRunning: 0 });
    await db.adminSql`UPDATE harness_shared.customer_workspaces
      SET monthly_lifecycle_budget_cents = 1000, lifecycle_budget_period_started_at = ${new Date(now - 60000)}
      WHERE workspace_id = ${wsA}`;
    for (const ws of [wsA, wsB]) {
      await db.adminSql`UPDATE harness_shared.workspace_host_operations
        SET organization_id = 'org-rly', provider_target = 'gcp',
          billing_owner_kind = ${ws === wsA ? 'platform' : 'organization'}, billing_owner_id = 'billing-rly',
          estimated_cost_cents = ${ws === wsA ? 2400 : 99999}, cost_currency = 'USD',
          cost_estimate_source = 'private-fixture', cost_estimate_ref = 'private-estimate', cost_estimated_at = ${new Date(now)}
        WHERE workspace_id = ${ws} AND id = 'rly-ready'`;
      await db.adminSql`INSERT INTO papercusp_auth.hosted_workspace_connectors
        (control_workspace_id, organization_id, customer_workspace_id, host_id, route_label,
         generation, credential_hash, state, transport, registered_at, heartbeat_at)
        VALUES (${ws}, 'org-rly', 'customer-rly', 'rly-host', ${ws + '-route'},
          1, ${'a'.repeat(64)}, 'active', 'websocket', ${new Date(now - 100000)}, ${new Date(now - 100000)})`;
    }
    const breached = await readWorkspaceHostReliability(wsA, now);
    expect(breached.reverseConnectors).toEqual({ active: 1, lost: 1 });
    expect(breached.ownedCost).toEqual({ estimatedUsdCents: 2400, estimates: 1, unpriced: 0, breachedBudgets: 1 });
    expect((await readWorkspaceHostReliability(wsB, now)).ownedCost)
      .toEqual({ estimatedUsdCents: null, estimates: 0, unpriced: 0, breachedBudgets: 0 });
    await db.adminSql`UPDATE papercusp_auth.hosted_workspace_connectors SET heartbeat_at = ${new Date(now)}
      WHERE control_workspace_id = ${wsA}`;
    expect((await readWorkspaceHostReliability(wsA, now)).reverseConnectors).toEqual({ active: 1, lost: 0 });
    // A connector explicitly detached by the existing producer clears heartbeat_at.
    await db.adminSql`UPDATE papercusp_auth.hosted_workspace_connectors SET heartbeat_at = NULL
      WHERE control_workspace_id = ${wsA}`;
    expect((await readWorkspaceHostReliability(wsA, now)).reverseConnectors).toEqual({ active: 1, lost: 1 });
  });

  it('lists exactly the live, spec-bearing hosts this controller owns, across workspaces', async () => {
    const targets = await listWorkspaceHostStandingHealthTargets(MINE, db.adminSql);
    expect(targets).toEqual([
      { workspaceId: WS_A, hostId: 'a-aws-spot', healthAttestedAt: null },
      { workspaceId: WS_A, hostId: 'a-running', healthAttestedAt: null },
      { workspaceId: WS_A, hostId: 'a-spot', healthAttestedAt: null },
      { workspaceId: WS_A, hostId: 'a-standard', healthAttestedAt: null },
      { workspaceId: WS_B, hostId: 'b-degraded', healthAttestedAt: null },
      { workspaceId: WS_B, hostId: 'b-spot-degraded', healthAttestedAt: null },
    ]);
  });

  it('the spot-reclaim sweep lists only the live SPOT hosts this controller owns (absent or standard model excluded)', async () => {
    expect(await listWorkspaceHostSpotReclaimTargets(MINE, db.adminSql)).toEqual([
      { workspaceId: WS_A, hostId: 'a-aws-spot' },
      { workspaceId: WS_A, hostId: 'a-spot' },
      { workspaceId: WS_B, hostId: 'b-spot-degraded' },
    ]);
    // Positive control: the same rows are invisible to the RLS-subject role, so the admin pool is load-bearing.
    expect(await listWorkspaceHostSpotReclaimTargets(MINE, db.appSql)).toEqual([]);
  });

  it('sees nothing through the RLS-subject app role, which is why the read must use the admin pool', async () => {
    // Positive control for the test itself: the rows above exist, yet the app role cannot see them.
    expect(await listWorkspaceHostStandingHealthTargets(MINE, db.appSql)).toEqual([]);
  });

  it('carries the last attestation as an ISO timestamp so the pass can skip a host a soak just attested', async () => {
    const observedAt = '2026-10-01T17:55:00.000Z';
    await recordWorkspaceHostHealth(WS_A, {
      hostId: 'a-running',
      observedAt,
      status: 'healthy',
      checks: [{ name: 'compute-running', ok: true, detail: 'RUNNING' }],
    });
    const targets = await listWorkspaceHostStandingHealthTargets(MINE, db.adminSql);
    expect(targets.find((row) => row.hostId === 'a-running')?.healthAttestedAt).toBe(observedAt);
  });
});
