/**
 * Real-Postgres coverage for the deferred-spend half of hosted lifecycle reconciliation.
 *
 * The provider reader is injected and read-only; the properties under test are the RLS-scoped
 * candidate scan, provider-call/transaction separation, locked whole-array RMW, concurrent-tick
 * deduplication, and two-pass settlement convergence.
 */
import { randomBytes } from 'node:crypto';
import { createWorkspaceHostSpendObservation, type WorkspaceHostSpendObservation } from '@papercusp/deployment-driver';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ appSql: null as any, adminSql: null as any }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  // Recovery updates also notify SSE consumers through the admin pool. Keep that
  // real pg_notify in the same throwaway database as the RLS-scoped writes.
  getOrgPg: () => ({ sql: h.adminSql }),
  withWorkspace: async <T>(workspaceId: string, run: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return run(tx);
    }),
}));

const { HOSTED_LIFECYCLE_SPEND_STABILITY_WINDOW_MS, reconcileHostedLifecycleJobs, setHostedLifecycleStoreHooks } =
  await import('./hosted-lifecycle-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let sequence = 0;
const freshWorkspace = () => `wh_spend_ws_${++sequence}_${randomBytes(2).toString('hex')}`;
const FIRST_ATTEMPT_AT = '2026-09-08T02:00:00.000Z';
const SECOND_ATTEMPT_AT = new Date(
  Date.parse(FIRST_ATTEMPT_AT) + HOSTED_LIFECYCLE_SPEND_STABILITY_WINDOW_MS + 60_000,
).toISOString();

const billingExport = {
  schemaVersion: 'gcp-billing-export-v1',
  projectId: 'billing-project',
  datasetId: 'cloud_billing_export',
  tableId: 'gcp_billing_export_v1_test',
  location: 'US',
  labelKey: 'papercusp_run',
  maximumBytesBilled: '1000000',
};

const spendSettlement = {
  status: 'deferred',
  actorId: 'operator:integration-test',
  reason: 'provider billing export is delayed',
  procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
  reconcileAfter: '2026-09-08T01:30:00.000Z',
};

function deferredSignal() {
  return {
    kind: 'workspace-host-canary-cost-evidence-v1',
    runId: 'r4-canary',
    budgetEvidenceRef: 'gcp://billing/budgets/workspace-host-canary',
    preRunZeroBaseline: {
      cents: 0,
      observedAt: '2026-09-08T00:00:00.000Z',
      providerEvidenceRef: 'gcp://billing/baseline-zero',
    },
    cumulative: [],
    lateObservedSpend: [],
    completion: { completedAt: '2026-09-08T01:00:00.000Z' },
    spendSettlement,
  };
}

function observation(observedAt: string, job: string): WorkspaceHostSpendObservation {
  return createWorkspaceHostSpendObservation({
    currency: 'USD',
    grossMicros: '1234567',
    creditMicros: '-34567',
    netMicros: '1200000',
    observedAt,
    providerEvidenceRef: `gcp://bigquery/projects/billing-project/jobs/${job}`,
  });
}

describe('hosted lifecycle deferred-spend reconciliation (real PG + real RLS)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.appSql = db.appSql;
    h.adminSql = db.adminSql;
  }, 180_000);

  afterEach(() => setHostedLifecycleStoreHooks(null));

  afterAll(async () => {
    await db?.cleanup();
  });

  /**
   * WI-10001739 link 3a. The exhaustion branch used to write
   * `error = jsonb_build_object('code','hosted_lifecycle_recovery_exhausted')` unconditionally,
   * which both ERASED a recorded cause and presented the reaper's own behaviour as a finding.
   *
   * These assert the SQL semantics of the CASE, so they need real Postgres: a faked `tx` would
   * happily return whatever it was told and prove nothing about `jsonb_typeof` or `||`.
   */
  describe('recovery exhaustion never fabricates over a real cause (WI-10001739 link 3a)', () => {
    async function seedExhaustedOperation(
      workspaceId: string,
      operationId: string,
      error: unknown,
    ): Promise<void> {
      const connectionId = `conn-${operationId}`;
      const hostId = `host-${operationId}`;
      await db.adminSql`
        INSERT INTO harness_shared.workspace_host_connections (
          workspace_id, id, target, label, credential_ref, provider_config, status
        ) VALUES (
          ${workspaceId}, ${connectionId}, 'gcp', 'link3a connection',
          'gcloud://active-user', ${JSON.stringify({ projectId: 'billing-project' })}::jsonb,
          'connected'
        )`;
      await db.adminSql`
        INSERT INTO harness_shared.workspace_hosts (
          workspace_id, id, name, connection_id, target, scope_label, region, size,
          image, disk_gib, network, desired_state, observed_state
        ) VALUES (
          ${workspaceId}, ${hostId}, 'link3a host', ${connectionId}, 'gcp',
          'billing-project', 'us-central1', 'e2-small', 'papercusp-v1', 20, 'default',
          'absent', 'absent'
        )`;
      // recovery_attempts at the policy ceiling (3) is what makes classify return
      // 'recovery-exhausted', so this lands in the branch under test regardless of heartbeat age.
      await db.adminSql`
        INSERT INTO harness_shared.workspace_host_operations (
          workspace_id, id, host_id, action, status, recovery_attempts, error
        ) VALUES (
          ${workspaceId}, ${operationId}, ${hostId}, 'destroy', 'running', 3,
          ${error === null ? null : JSON.stringify(error)}::jsonb
        )`;
    }

    async function readOperation(workspaceId: string, operationId: string) {
      const [row] = await db.adminSql<{ error: unknown; status: string; recovery_state: string }[]>`
        SELECT error, status, recovery_state
          FROM harness_shared.workspace_host_operations
         WHERE workspace_id = ${workspaceId} AND id = ${operationId}`;
      return row;
    }

    it('preserves a recorded terminal cause and records exhaustion alongside it', async () => {
      const workspaceId = freshWorkspace();
      // Exactly the shape link 2 persists: the REAL provider failure, with its cause chain.
      const realCause = {
        code: 'workspace_host_provider_error',
        message: 'googleapi: Error 403: Required permission compute.routers.delete',
        cause: { code: 'gcp_permission_denied', status: 403 },
      };
      await seedExhaustedOperation(workspaceId, 'op-real-cause', realCause);

      const out = await reconcileHostedLifecycleJobs(workspaceId, new Date(FIRST_ATTEMPT_AT));
      expect(out.exhausted).toEqual(['op-real-cause']);

      const row = await readOperation(workspaceId, 'op-real-cause');
      expect(row.status).toBe('failed');
      expect(row.recovery_state).toBe('exhausted');
      // The real cause survives INTACT — including the nested provider cause, which is the part a
      // blanket overwrite destroyed and which is what actually names the failure.
      expect(row.error).toMatchObject(realCause);
      // ...and exhaustion is still recorded, as an ADDITIONAL fact rather than a replacement.
      expect(row.error).toMatchObject({ recoveryExhausted: true });
      // The fabricated code must NOT appear when a real cause was available.
      expect((row.error as { code: string }).code).toBe('workspace_host_provider_error');
      expect(row.error).not.toMatchObject({ synthesized: true });
    });

    it('marks a cause it had to invent as synthesized-by-recency, not as a diagnosis', async () => {
      const workspaceId = freshWorkspace();
      await seedExhaustedOperation(workspaceId, 'op-no-cause', null);

      const out = await reconcileHostedLifecycleJobs(workspaceId, new Date(FIRST_ATTEMPT_AT));
      expect(out.exhausted).toEqual(['op-no-cause']);

      const row = await readOperation(workspaceId, 'op-no-cause');
      expect(row.status).toBe('failed');
      // The code is still written — a reader needs SOMETHING — but it now carries the provenance
      // that stops it being mistaken for a measured cause.
      expect(row.error).toMatchObject({
        code: 'hosted_lifecycle_recovery_exhausted',
        synthesized: true,
        classifiedBy: 'recency',
      });
      // Assert the OPERATIVE sentence verbatim. Asserting a paraphrase of it ('not a diagnosis')
      // failed here while the code was correct — a guessed literal reads exactly like a real
      // defect, which is the same trap the synthesized code itself sets one layer up.
      const detail = String((row.error as { detail: string }).detail);
      expect(detail).toContain('Do not read it as a diagnosis');
      expect(detail).toContain('describes the RECONCILER giving up');
    });
  });

  it('deduplicates concurrent first reads, preserves the whole signal array, and settles on the next due pass', async () => {
    const workspaceId = freshWorkspace();
    const connectionId = 'connection-r4';
    const hostId = 'host-r4';
    const unrelatedBefore = { kind: 'quota-snapshot', remaining: 8 };
    const unrelatedAfter = { kind: 'health-cost-note', source: 'operator', value: 17 };
    const originalSignal = deferredSignal();
    await db.adminSql`
      INSERT INTO harness_shared.workspace_host_connections (
        workspace_id, id, target, label, credential_ref, provider_config, status
      ) VALUES (
        ${workspaceId}, ${connectionId}, 'gcp', 'R4 billing connection',
        'gcloud://active-user', ${JSON.stringify({ projectId: 'billing-project', billingExport })}::jsonb,
        'connected'
      )`;
    await db.adminSql`
      INSERT INTO harness_shared.workspace_hosts (
        workspace_id, id, name, connection_id, target, scope_label, region, size,
        image, disk_gib, network, desired_state, observed_state, cost_signals
      ) VALUES (
        ${workspaceId}, ${hostId}, 'R4 retained host', ${connectionId}, 'gcp',
        'billing-project', 'us-central1', 'e2-small', 'papercusp-v1', 20, 'default',
        'absent', 'absent',
        ${JSON.stringify([unrelatedBefore, originalSignal, unrelatedAfter])}::jsonb
      )`;

    const firstObservation = observation(FIRST_ATTEMPT_AT, 'settlement-first');
    const secondObservation = observation(SECOND_ATTEMPT_AT, 'settlement-second');
    let pairReaders = 0;
    let releasePair!: () => void;
    const bothReadersEntered = new Promise<void>((resolve) => {
      releasePair = resolve;
    });
    const readGcpBilling = vi.fn(async () => {
      if (pairReaders < 2) {
        pairReaders += 1;
        if (pairReaders === 2) releasePair();
        await bothReadersEntered;
        return {
          status: 'observed' as const,
          retryable: false as const,
          observation: firstObservation,
          jobReference: { projectId: 'billing-project', jobId: 'settlement-first' },
        };
      }
      return {
        status: 'observed' as const,
        retryable: false as const,
        observation: secondObservation,
        jobReference: { projectId: 'billing-project', jobId: 'settlement-second' },
      };
    });
    setHostedLifecycleStoreHooks({ readGcpBilling });

    const concurrent = await Promise.all([
      reconcileHostedLifecycleJobs(workspaceId, new Date(FIRST_ATTEMPT_AT)),
      reconcileHostedLifecycleJobs(workspaceId, new Date(FIRST_ATTEMPT_AT)),
    ]);

    expect(readGcpBilling).toHaveBeenCalledTimes(2);
    expect(concurrent.reduce((sum, result) => sum + result.spend.observed, 0)).toBe(1);
    expect(concurrent.reduce((sum, result) => sum + result.spend.skipped, 0)).toBe(1);
    let [persisted] = await db.adminSql`
      SELECT cost_signals
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}`;
    expect(persisted.cost_signals).toHaveLength(3);
    expect(persisted.cost_signals[0]).toEqual(unrelatedBefore);
    expect(persisted.cost_signals[2]).toEqual(unrelatedAfter);
    expect(persisted.cost_signals[1]).toMatchObject({
      spendSettlement,
      spendObservations: [firstObservation],
      spendReconciliation: {
        status: 'retryable',
        reason: 'insufficient-observations',
        attempts: 1,
      },
    });

    const insideBackoff = await reconcileHostedLifecycleJobs(workspaceId, new Date('2026-09-08T02:10:00.000Z'));
    expect(insideBackoff.spend).toMatchObject({ due: 0, attempted: 0, errors: [] });
    expect(readGcpBilling).toHaveBeenCalledTimes(2);

    const converged = await reconcileHostedLifecycleJobs(workspaceId, new Date(SECOND_ATTEMPT_AT));

    expect(converged.spend).toMatchObject({
      due: 1,
      attempted: 1,
      observed: 1,
      settled: 1,
      retryable: 0,
      skipped: 0,
      errors: [],
    });
    expect(readGcpBilling).toHaveBeenCalledTimes(3);
    expect(readGcpBilling).toHaveBeenLastCalledWith({
      descriptor: billingExport,
      runId: 'r4-canary',
      usageStartAt: '2026-09-08T00:00:00.000Z',
      usageEndAt: '2026-09-08T01:00:00.000Z',
    });
    [persisted] = await db.adminSql`
      SELECT cost_signals
      FROM harness_shared.workspace_hosts
      WHERE workspace_id = ${workspaceId} AND id = ${hostId}`;
    const settledSignal = persisted.cost_signals[1];
    expect(persisted.cost_signals).toHaveLength(3);
    expect(persisted.cost_signals[0]).toEqual(unrelatedBefore);
    expect(persisted.cost_signals[2]).toEqual(unrelatedAfter);
    expect(settledSignal.spendSettlement).toEqual(spendSettlement);
    expect(settledSignal.spendObservations).toEqual([firstObservation, secondObservation]);
    expect(
      new Set(settledSignal.spendObservations.map((entry: WorkspaceHostSpendObservation) => entry.providerEvidenceRef))
        .size,
    ).toBe(2);
    expect(settledSignal.spendReconciliation).toMatchObject({
      status: 'settled',
      attempts: 2,
      finality: {
        status: 'settled',
        observationCount: 2,
        stableObservationCount: 2,
        observation: {
          currency: 'USD',
          grossMicros: '1234567',
          creditMicros: '-34567',
          netMicros: '1200000',
          budgetCents: 124,
        },
      },
    });
  }, 180_000);
});
