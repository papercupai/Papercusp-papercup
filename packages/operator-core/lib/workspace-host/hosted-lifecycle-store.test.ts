import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createWorkspaceHostSpendObservation } from '@papercusp/deployment-driver';
import { WorkspaceHostReleaseBindingError } from './release-stage-receipt';
import {
  HOSTED_LIFECYCLE_SPEND_RECONCILE_BATCH_LIMIT,
  HOSTED_LIFECYCLE_SPEND_RETRY_BASE_MS,
  HostedLifecycleAdmissionError,
  admitHostedLifecycleJob,
  readHostedLifecycleSupportDiagnostics,
  reconcileHostedLifecycleJobs,
  setHostedLifecycleStoreHooks,
} from './hosted-lifecycle-store';

type QueryHandler = (text: string, values: unknown[]) => unknown[] | Promise<unknown[]>;

// Notifications are an effect too; a unit reconciliation must never open a live PG pool.
vi.mock('../attention-notify', () => ({
  notifyAttentionOnce: vi.fn(async () => ({ recordId: 1, deduped: false, mobileDelivered: false, desktopDelivered: false })),
}));

function fakeTransaction(handler: QueryHandler) {
  return async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>): Promise<T> => {
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      return Promise.resolve(handler(text, values));
    }) as unknown as Sql;
    tag.json = ((value: unknown) => value) as Sql['json'];
    return fn(tag);
  };
}

const baseInput = {
  workspaceId: 'control-a',
  customerWorkspaceId: 'customer-a',
  hostId: 'host-a',
  providerTarget: 'gcp',
  action: 'start' as const,
  actorId: 'owner-a',
  riskTier: 'moderate' as const,
  approvalStatus: 'not-required' as const,
  estimate: {
    cents: 1200,
    currency: 'USD',
    source: 'gcp-catalog-v1',
    evidenceRef: 'gcp://catalog/e2-small',
    estimatedAt: '2026-08-28T00:00:00Z',
  },
  operationId: 'op-1',
};

const directory = {
  organization_id: 'org-a',
  customer_workspace_id: 'customer-a',
  workspace_host_id: 'host-a',
  provider_target: 'gcp',
  state: 'active',
  tenant_concurrency_limit: 2,
  provider_concurrency_limit: 8,
  monthly_lifecycle_budget_cents: 5000,
  lifecycle_budget_period_started_at: '2026-08-01T00:00:00Z',
  billing_owner_kind: 'organization',
  billing_owner_id: 'org-a',
  idle_stop_after_minutes: 60,
};

const deferredSpendSignal = () => ({
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
  spendSettlement: {
    status: 'deferred',
    actorId: 'operator:test',
    reason: 'provider export is delayed',
    procedureRef: 'runbook://workspace-host/gcp/deferred-spend-reconciliation-v1',
    reconcileAfter: '2026-09-08T01:30:00.000Z',
  },
});

afterEach(() => setHostedLifecycleStoreHooks(null));

describe('hosted lifecycle store', () => {
  it('replays the saved admission before directory/quota reads', async () => {
    const saved = {
      operationId: 'op-1', created: true, hostId: 'selected-warm', organizationId: 'org-a',
      customerWorkspaceId: 'customer-a', providerTarget: 'gcp',
      decision: { allowed: true, reasons: [], projectedMonthlyCents: 1200, emergencyBypass: false },
    };
    setHostedLifecycleStoreHooks({ transaction: fakeTransaction((text) => {
      if (text.includes('SELECT admission_receipt,')) return [{ admission_receipt: { result: saved }, input_matches: true }];
      if (!text.includes('pg_advisory_xact_lock')) throw new Error('replay must not re-admit');
      return [];
    }) });
    expect(await admitHostedLifecycleJob(baseInput)).toEqual({ ...saved, created: false });
  });

  it('refuses an operation identity collision before admission writes', async () => {
    setHostedLifecycleStoreHooks({ transaction: fakeTransaction((text) => {
      if (text.includes('SELECT admission_receipt,')) return [{ admission_receipt: null, input_matches: false }];
      if (!text.includes('pg_advisory_xact_lock')) throw new Error('collision must not write');
      return [];
    }) });
    await expect(admitHostedLifecycleJob(baseInput)).rejects.toThrow('hosted_lifecycle_operation_conflict');
  });

  it('serializes admission, reads the writer counters, and inserts the canonical operation row', async () => {
    const queries: string[] = [];
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        queries.push(text);
        if (text.includes('FROM harness_shared.customer_workspaces customer')) return [directory];
        if (text.includes('AS active_tenant_jobs')) {
          return [{ active_tenant_jobs: 1, active_provider_jobs: 3, committed_monthly_cents: '2000' }];
        }
        if (text.includes('INSERT INTO harness_shared.workspace_host_operations')) return [{ id: 'op-1' }];
        return [];
      }),
    });

    await expect(admitHostedLifecycleJob(baseInput)).resolves.toMatchObject({
      operationId: 'op-1',
      created: true,
      organizationId: 'org-a',
      decision: { allowed: true, projectedMonthlyCents: 3200 },
    });
    expect(queries.filter((query) => query.includes('pg_advisory_xact_lock'))).toHaveLength(3);
    expect(queries.some((query) => query.includes('INSERT INTO harness_shared.workspace_host_operations'))).toBe(true);
  });

  it('rejects before inserting when the persisted tenant limit is reached', async () => {
    let inserted = false;
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        if (text.includes('FROM harness_shared.customer_workspaces customer')) return [directory];
        if (text.includes('AS active_tenant_jobs')) {
          return [{ active_tenant_jobs: 2, active_provider_jobs: 3, committed_monthly_cents: '2000' }];
        }
        if (text.includes('INSERT INTO harness_shared.workspace_host_operations')) inserted = true;
        return [];
      }),
    });
    await expect(admitHostedLifecycleJob(baseInput)).rejects.toBeInstanceOf(HostedLifecycleAdmissionError);
    expect(inserted).toBe(false);
  });

  it('marks orphaned work and uses replay-safe notifications', async () => {
    const notify = vi.fn(async (_input: { dedupeKey: string }) => ({
      recordId: 1,
      deduped: false,
      mobileDelivered: true,
      desktopDelivered: true,
    }));
    setHostedLifecycleStoreHooks({
      notify,
      transaction: fakeTransaction((text) => {
        if (text.includes('FOR UPDATE OF operation')) {
          return [
            {
              ...directory,
              operation_id: 'orphan-1',
              host_id: 'host-a',
              action: 'repair',
              status: 'running',
              heartbeat_at: '2026-08-28T00:00:00Z',
              operation_updated_at: '2026-08-28T00:00:00Z',
              recovery_attempts: 0,
            },
          ];
        }
        return [];
      }),
    });
    const result = await reconcileHostedLifecycleJobs('control-a', new Date('2026-08-28T02:00:00Z'));
    expect(result.orphaned).toEqual(['orphan-1']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls.map(([input]) => input.dedupeKey)).toEqual([
      'hosted-lifecycle:control-a:orphan-1:orphaned',
    ]);
  });

  it('clears orphaned_at when recovery advances to pending or exhausted', async () => {
    const queries: string[] = [];
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        queries.push(text);
        if (text.includes('FOR UPDATE OF operation')) {
          return [
            {
              operation_id: 'stale-orphan-1',
              host_id: 'host-a',
              action: 'repair',
              status: 'running',
              heartbeat_at: '2026-08-28T01:50:00Z',
              operation_updated_at: '2026-08-28T01:50:00Z',
              recovery_attempts: 0,
              customer_workspace_id: 'customer-a',
            },
            {
              operation_id: 'stale-orphan-2',
              host_id: 'host-a',
              action: 'restart',
              status: 'running',
              heartbeat_at: '2026-08-28T01:50:00Z',
              operation_updated_at: '2026-08-28T01:50:00Z',
              recovery_attempts: 3,
              customer_workspace_id: 'customer-a',
            },
          ];
        }
        return [];
      }),
    });

    const result = await reconcileHostedLifecycleJobs('control-a', new Date('2026-08-28T02:00:00Z'));
    expect(result.recoveryPending).toEqual(['stale-orphan-1']);
    expect(result.exhausted).toEqual(['stale-orphan-2']);
    const recoveryUpdates = queries.filter((query) =>
      query.includes('UPDATE harness_shared.workspace_host_operations'),
    );
    expect(recoveryUpdates).toHaveLength(2);
    expect(recoveryUpdates.every((query) => query.includes('orphaned_at = NULL'))).toBe(true);
  });

  // WI-2143803. The BYOC case is the one that motivated the sweep and the one it could not see:
  // an operation created through /api/workspace-hosts/action has customer_workspace_id NULL, so
  // the reconciler's former INNER JOIN to customer_workspaces eliminated it. Measured on a live
  // rig DB: 38 of 38 operations had a NULL customer_workspace_id and customer_workspaces held 0
  // rows, so the inner join matched NOTHING at all. This fixture is deliberately a row with every
  // customer-derived column absent — it must still classify.
  it('classifies a BYOC operation that has NO customer_workspaces row (customer_workspace_id NULL)', async () => {
    const notify = vi.fn(async (_input: { dedupeKey: string; title: string; body: string }) => ({
      recordId: 1,
      deduped: false,
      mobileDelivered: true,
      desktopDelivered: true,
    }));
    setHostedLifecycleStoreHooks({
      notify,
      transaction: fakeTransaction((text) => {
        if (text.includes('FOR UPDATE OF operation')) {
          return [
            {
              operation_id: 'byoc-orphan-1',
              host_id: 'p046-canary-14',
              action: 'restart',
              status: 'running',
              heartbeat_at: null,
              operation_updated_at: '2026-08-28T00:00:00Z',
              recovery_attempts: 0,
              customer_workspace_id: null,
              provider_target: 'gcp',
            },
          ];
        }
        return [];
      }),
    });
    const result = await reconcileHostedLifecycleJobs('control-a', new Date('2026-08-28T02:00:00Z'));
    expect(result.orphaned).toEqual(['byoc-orphan-1']);
    // The notice must name SOMETHING identifiable. Before the fix the body interpolated
    // job.customer_workspace_id directly, so a BYOC row would have read "restart on undefined".
    const [notice] = notify.mock.calls.map(([input]) => input);
    expect(notice.body).toContain('p046-canary-14');
    expect(notice.body).not.toContain('undefined');
    expect(notice.body).not.toContain('null');
  });

  // Guard the JOIN itself, not just the outcome: the fake transaction returns whatever rows the
  // test hands it regardless of the SQL, so the behavioural test above would keep passing even if
  // someone restored the inner join. This asserts on the emitted query text, which is the only
  // thing that decides whether a real BYOC row is reachable.
  it('never references customer_workspaces at all — harness_app has no privilege on it', async () => {
    const queries: string[] = [];
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        queries.push(text);
        return [];
      }),
    });
    await reconcileHostedLifecycleJobs('control-a', new Date('2026-08-28T02:00:00Z'));
    const sweep = queries.find((query) => query.includes('FOR UPDATE OF operation'));
    expect(sweep).toBeDefined();

    // CALIBRATION: prove the captured text is really the reconciliation SELECT, so the absence
    // assertions below mean "the relation is not referenced" rather than "the matcher read
    // nothing" — an empty string would satisfy every `not.toContain` identically.
    expect(sweep).toContain('harness_shared.workspace_host_operations');
    expect(sweep).toContain('operation.customer_workspace_id');

    // The relation is granted to `hosted_app`, and migration 997 grants that role to the pool role
    // `harness_app` WITH INHERIT FALSE — so touching it from `withWorkspace` (plain harness_app,
    // no SET LOCAL ROLE) is `permission denied for table customer_workspaces` on EVERY tick.
    // Measured on the rig 2026-09-04, the first time this sweep had a real caller. A LEFT join
    // does not fix it: the privilege check is on the RELATION, not the rows.
    expect(sweep).not.toContain('customer_workspaces customer');
    expect(sweep).not.toMatch(/JOIN\s+harness_shared\.customer_workspaces/);
    expect(sweep).not.toContain('customer.workspace_host_id');
    // Nothing in this sweep reads host.target, so it must not join workspace_hosts either.
    expect(sweep).not.toMatch(/JOIN\s+harness_shared\.workspace_hosts/);
  });

  it('NEGATIVE CONTROL: the join matcher really does detect a join it must reject', () => {
    // Without this, the assertions above pass just as happily on a regex that matches nothing.
    const planted =
      'SELECT x FROM harness_shared.workspace_host_operations operation\n' +
      '  LEFT JOIN harness_shared.customer_workspaces customer ON customer.id = operation.customer_workspace_id';
    expect(planted).toMatch(/JOIN\s+harness_shared\.customer_workspaces/);
    expect(planted).toContain('customer_workspaces customer');
  });

  it('no longer issues an idle-stop query against customer_workspaces (the sweep was retired)', async () => {
    const queries: string[] = [];
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        queries.push(text);
        return [];
      }),
    });
    await reconcileHostedLifecycleJobs('control-a', new Date('2026-08-28T02:00:00Z'));
    expect(queries.some((query) => query.includes('idle_stop_after_minutes IS NOT NULL'))).toBe(false);
    expect(queries.some((query) => query.includes('active_lifecycle_jobs'))).toBe(false);
  });

  it('persists an explicit bounded retry without replacing the deferral or unrelated signals', async () => {
    const signal = deferredSpendSignal();
    const unrelated = { kind: 'quota-snapshot', remaining: 8 };
    const updates: unknown[][] = [];
    const candidateQueryValues: unknown[][] = [];
    const readGcpBilling = vi.fn(async () => ({
      status: 'retryable' as const,
      retryable: true as const,
      reason: 'missing-config' as const,
    }));
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text, values) => {
        if (text.includes('jsonb_array_elements(host.cost_signals)')) {
          candidateQueryValues.push(values);
          return [
            {
              host_id: 'host-r4',
              connection_id: 'connection-r4',
              signal_ordinal: 2,
              cost_signal: signal,
            },
          ];
        }
        if (text.includes('FOR UPDATE OF host')) {
          return [{ connection_id: 'connection-r4', cost_signals: [unrelated, signal] }];
        }
        if (text.startsWith('UPDATE harness_shared.workspace_hosts')) {
          updates.push(values);
          return [];
        }
        return [];
      }),
      readConnection: async () => ({
        id: 'connection-r4',
        target: 'gcp',
        status: 'connected',
        connection: {
          target: 'gcp',
          cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
          provider: { projectId: 'project-r4' },
        },
      }),
      readGcpBilling,
    });

    const now = new Date('2026-09-08T02:00:00.000Z');
    const result = await reconcileHostedLifecycleJobs('control-a', now);

    expect(result.spend).toMatchObject({
      due: 1,
      attempted: 1,
      observed: 0,
      settled: 0,
      retryable: 1,
      skipped: 0,
      errors: [{ hostId: 'host-r4', runId: 'r4-canary', reason: 'missing-config' }],
    });
    expect(readGcpBilling).toHaveBeenCalledWith({
      descriptor: undefined,
      runId: 'r4-canary',
      usageStartAt: '2026-09-08T00:00:00.000Z',
      usageEndAt: '2026-09-08T01:00:00.000Z',
    });
    expect(candidateQueryValues[0]).toContain(HOSTED_LIFECYCLE_SPEND_RECONCILE_BATCH_LIMIT);
    expect(updates).toHaveLength(1);
    const written = updates[0]![0] as Array<Record<string, unknown>>;
    expect(written[0]).toEqual(unrelated);
    expect(written[1]).toMatchObject({
      spendSettlement: signal.spendSettlement,
      spendReconciliation: {
        status: 'retryable',
        attempts: 1,
        reason: 'missing-config',
        nextAttemptAt: new Date(now.getTime() + HOSTED_LIFECYCLE_SPEND_RETRY_BASE_MS).toISOString(),
      },
    });
  });

  it('projects bounded support diagnostics from the canonical writer fields', async () => {
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text) => {
        if (text.includes("count(*) FILTER (WHERE status = 'queued')")) {
          return [{ queued: 2, running: 1, stuck: 1, orphaned: 1, exhausted: 0 }];
        }
        if (text.includes('SELECT id, host_id, action'))
          return [{ id: 'op-1', cost_estimate_ref: 'gcp://catalog/e2-small' }];
        return [];
      }),
    });
    await expect(readHostedLifecycleSupportDiagnostics('control-a', 5)).resolves.toMatchObject({
      workspaceId: 'control-a',
      counts: { queued: 2, running: 1, stuck: 1, orphaned: 1, exhausted: 0 },
      jobs: [{ id: 'op-1', cost_estimate_ref: 'gcp://catalog/e2-small' }],
    });
  });
});

// D-395: billing.closure is recorded by the reconciler from ITS settled reading, before the spend is
// marked settled (a settled signal is never due again), and a receipt that can never be written does
// not hold the money back.
describe('deferred spend that closes a release (D-395)', () => {
  const releaseClosure = {
    schemaVersion: 'workspace-host-release-closure-v1',
    releaseTaskId: 'release-task-1',
    runRef: 'destroy-operation:op-destroy-1',
    runId: 'r4-canary',
    maxSpendCents: 2_500,
  };

  function observed(observedAt: string, providerEvidenceRef: string) {
    return createWorkspaceHostSpendObservation({
      currency: 'USD',
      grossMicros: '712000',
      creditMicros: '0',
      netMicros: '712000',
      observedAt,
      providerEvidenceRef,
    });
  }

  /** One due signal whose next reading settles it: an identical spend 30 minutes after the first. */
  async function reconcile(
    signalExtra: Record<string, unknown>,
    recordBillingClosure: NonNullable<Parameters<typeof setHostedLifecycleStoreHooks>[0]>['recordBillingClosure'],
    priorObservations = [observed('2026-09-08T01:30:00.000Z', 'gcp://bigquery/job-1')],
  ) {
    const signal = { ...deferredSpendSignal(), spendObservations: priorObservations, ...signalExtra };
    const order: string[] = [];
    const written: Array<Record<string, unknown>> = [];
    setHostedLifecycleStoreHooks({
      transaction: fakeTransaction((text, values) => {
        if (text.includes('jsonb_array_elements(host.cost_signals)')) {
          return [{ host_id: 'host-r4', connection_id: 'connection-r4', signal_ordinal: 1, cost_signal: signal }];
        }
        if (text.includes('FOR UPDATE OF host')) return [{ connection_id: 'connection-r4', cost_signals: [signal] }];
        if (text.startsWith('UPDATE harness_shared.workspace_hosts')) {
          order.push('signal-patch');
          written.push((values[0] as Array<Record<string, unknown>>)[0]!);
        }
        return [];
      }),
      readConnection: async () => ({
        id: 'connection-r4',
        target: 'gcp',
        status: 'connected',
        connection: {
          target: 'gcp',
          cloudCredentialRef: { kind: 'cloud', ref: 'gcloud://active-user' },
          provider: { projectId: 'project-r4' },
        },
      }),
      readGcpBilling: async () => ({
        status: 'observed' as const,
        retryable: false as const,
        observation: observed('2026-09-08T02:00:00.000Z', 'gcp://bigquery/job-2'),
        jobReference: { projectId: 'project-r4', jobId: 'job-2' },
      }),
      ...(recordBillingClosure
        ? {
            recordBillingClosure: async (input) => {
              order.push('release-receipt');
              return recordBillingClosure(input);
            },
          }
        : {}),
    });
    const result = await reconcileHostedLifecycleJobs('control-a', new Date('2026-09-08T02:00:30.000Z'));
    return { result, order, written };
  }

  it('records billing.closure from the settled reading BEFORE it marks the spend settled', async () => {
    const recordBillingClosure = vi.fn(async () => ({ outcome: 'committed' as const, evidenceRefs: [] }));

    const { result, order, written } = await reconcile({ releaseClosure }, recordBillingClosure);

    expect(order).toEqual(['release-receipt', 'signal-patch']);
    expect(recordBillingClosure).toHaveBeenCalledWith({
      workspaceId: 'control-a',
      hostId: 'host-r4',
      pointer: releaseClosure,
      finality: expect.objectContaining({ status: 'settled', stableForMs: 1_800_000, stableObservationCount: 2 }),
    });
    expect(result.spend).toMatchObject({ settled: 1, retryable: 0, errors: [] });
    expect(written[0]).toMatchObject({
      spendReconciliation: { status: 'settled' },
      releaseClosureReceipt: { status: 'recorded', outcome: 'committed', releaseTaskId: 'release-task-1' },
    });
  });

  it('keeps the spend due, with its new reading, when the receipt could not be written', async () => {
    const recordBillingClosure = vi.fn(async () => {
      throw new Error('release journal unavailable');
    });

    const { result, written } = await reconcile({ releaseClosure }, recordBillingClosure);

    expect(result.spend).toMatchObject({
      settled: 0,
      retryable: 1,
      errors: [{ hostId: 'host-r4', runId: 'r4-canary', reason: 'release-receipt-unwritten' }],
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ spendReconciliation: { status: 'retryable', reason: 'release-receipt-unwritten' } });
    expect(written[0]!.spendObservations).toHaveLength(2);
    expect(written[0]).not.toHaveProperty('releaseClosureReceipt');
  });

  it('settles the money even when the release receipt can never be written, and says why', async () => {
    const recordBillingClosure = vi.fn(async () => {
      throw new WorkspaceHostReleaseBindingError('stage-refused', 'billing.closure', 'the stage is refused');
    });

    const { result, written } = await reconcile({ releaseClosure }, recordBillingClosure);

    expect(result.spend).toMatchObject({ settled: 1, retryable: 0 });
    expect(written[0]).toMatchObject({
      spendReconciliation: { status: 'settled' },
      releaseClosureReceipt: { status: 'unrecordable', reason: 'stage-refused', releaseTaskId: 'release-task-1' },
    });
  });

  it.each([
    ['pointer-malformed', { ...releaseClosure, runRef: 'initialize-operation:op-1' }],
    ['run-mismatch', { ...releaseClosure, runId: 'some-other-run' }],
  ])('never records a closure through an untrusted pointer (%s)', async (reason, pointer) => {
    const recordBillingClosure = vi.fn(async () => ({ outcome: 'committed' as const, evidenceRefs: [] }));

    const { result, written } = await reconcile({ releaseClosure: pointer }, recordBillingClosure);

    expect(recordBillingClosure).not.toHaveBeenCalled();
    expect(result.spend).toMatchObject({ settled: 1 });
    expect(written[0]).toMatchObject({ releaseClosureReceipt: { status: 'unrecordable', reason } });
  });

  it('settles a spend that closes no release exactly as before', async () => {
    const recordBillingClosure = vi.fn(async () => ({ outcome: 'committed' as const, evidenceRefs: [] }));

    const { result, written } = await reconcile({}, recordBillingClosure);

    expect(recordBillingClosure).not.toHaveBeenCalled();
    expect(result.spend).toMatchObject({ settled: 1 });
    expect(written[0]).not.toHaveProperty('releaseClosureReceipt');
  });

  it('leaves the release alone while the spend is still settling', async () => {
    const recordBillingClosure = vi.fn(async () => ({ outcome: 'committed' as const, evidenceRefs: [] }));

    const { result } = await reconcile({ releaseClosure }, recordBillingClosure, []);

    expect(recordBillingClosure).not.toHaveBeenCalled();
    expect(result.spend).toMatchObject({ settled: 0, retryable: 1 });
  });
});
