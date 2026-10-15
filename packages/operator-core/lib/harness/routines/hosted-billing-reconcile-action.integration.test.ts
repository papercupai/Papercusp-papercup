/** P-016: action → authenticated reader/parser → real hosted-service transaction.
 * Provider transport and alert destination are private fixtures; no production
 * credential, schedule or outward notification is used by this suite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { listDueCronRoutines } from '@papercusp/db-org';
import type { HostedServiceContextRunner } from '../../auth/hosted/workos-lifecycle-postgres';
import { PostgresHostedBillingStore } from '../../auth/hosted/billing/billing-store';
import { createStripeBillingClient } from '../../auth/hosted/billing/stripe-billing-client';
import { parseHostedBillingEvent } from '../../auth/hosted/billing/stripe-billing-events';
import { webhookBodyDigest } from '../../cupboard/webhook-inbox';
import { HOSTED_BILLING_RECONCILE, makeHostedBillingReconcileAction } from './hosted-billing-reconcile-action';
import { materializePlanSchedule, deactivatePlanSchedule, planScheduleRoutineName } from './materialize-plan-schedule';
import { claimDueRoutine, claimedRoutineDispatchAllowed } from './claim';
import { getSystemActionEntry, registerSystemAction } from './system-actions';

let db: OrgTestDb;
const T0 = 1_790_000_000;
const accountId = 'acct_Recovery';
const planKeyForPrice = (id: string | null) => id === 'price_team' ? 'team' : null;
const hex = () => randomBytes(6).toString('hex');
const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;

async function fixture() {
  const store = new PostgresHostedBillingStore(runService);
  const organizationId = randomUUID();
  const customerId = `cus_${hex()}`;
  const subscriptionId = `sub_${hex()}`;
  await store.recordCustomer({ organizationId, stripeCustomerId: customerId, livemode: false });
  const event = (status: string, created: number) => ({ object: 'event', id: `evt_${hex()}`,
    type: 'customer.subscription.updated', created, livemode: false,
    data: { object: { id: subscriptionId, customer: customerId, status,
      metadata: { organizationId }, items: { data: [{ price: { id: 'price_team' } }] },
      description: 'private customer payload' } } });
  const observe = vi.fn(async (_value: { failureClass: string; eventId: string | null }) => {});
  const requests: Array<{ url: URL; method: string | undefined }> = [];
  let readEvents = (_url: URL): Response => new Response('{}', { status: 503 });
  let requestId = 0;
  const response = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'request-id': `req_Recovery${++requestId}` },
  });
  const built = createStripeBillingClient({ secretKey: 'sk_test_recovery', liveModeAllowed: false,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url)); requests.push({ url: parsed, method: init?.method });
      if (parsed.pathname === '/v1/account') return response({ object: 'account', id: accountId });
      if (parsed.pathname === `/v1/customers/${customerId}`) return response({ object: 'customer',
        id: customerId, livemode: false, metadata: { organizationId } });
      if (parsed.pathname === '/v1/events') return readEvents(parsed);
      throw new Error('unexpected fixture transport');
    }) as typeof fetch });
  if (!built.ok) throw new Error('fixture client refused');
  const action = () => makeHostedBillingReconcileAction({ makeDeps: async () => ({
    store: {
      beginReconciliation: input => store.beginReconciliation(input),
      applyReconciliationPage: input => store.applyReconciliationPage(input),
      deliveryIssues: input => store.deliveryIssues(input),
      reconciliationTargets: async input => (await store.reconciliationTargets(input))
        .filter(target => target.organizationId === organizationId),
    }, client: built.client, planKeyForPrice, observe,
  }) });
  const fire = (maxPages = 3, createdBefore = T0 + 100) => action()({ installSlug: 'papercusp',
    workspaceId: 'test-billing-recovery', triggerConfig: {}, payloadTemplate: { input: {
      accountId, createdFrom: T0 - 1, createdBefore, overlapSeconds: 5, maxCustomers: 100, maxPages,
    } } });
  const page = (data: unknown[], has_more = false) => response({ object: 'list', url: '/v1/events', data, has_more });
  const setProvider = (read: typeof readEvents) => { readEvents = read; };
  const checkpoint = async () => (await db.adminSql`
    SELECT reconciliation_checkpoint AS value FROM papercusp_auth.hosted_billing_customers
     WHERE organization_id = ${organizationId}::uuid`)[0]!.value;
  const mirror = async () => (await db.adminSql`
    SELECT status, plan_key FROM papercusp_auth.hosted_subscriptions
     WHERE stripe_subscription_id = ${subscriptionId}`)[0] ?? null;
  const audit = async () => db.adminSql`
    SELECT action, metadata FROM papercusp_auth.organization_audit_events
     WHERE organization_id = ${organizationId}::uuid`;
  const receipt = async (id: string) => (await db.adminSql`
    SELECT body_digest, api_observation, outcome FROM papercusp_auth.hosted_billing_webhook_events
     WHERE provider_event_id = ${id}`)[0] ?? null;
  const deliver = async (raw: string) => {
    const parsed = parseHostedBillingEvent(raw);
    if (!parsed.ok) throw new Error('fixture event refused');
    return store.applyEvent({ event: parsed.event, bodyDigest: webhookBodyDigest(raw), expectedLivemode: false, planKeyForPrice });
  };
  return { store, organizationId, event, observe, requests, action, fire, page, setProvider, checkpoint, mirror, audit, receipt, deliver };
}

describe('hosted billing reconciliation action composition (real Postgres)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(readFileSync(new URL(
      '../../../../../libs/papercusp/libs/db/sql/1515-hosted-billing-api-recovery.sql', import.meta.url), 'utf8'));
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  it('repairs a never-delivered event, reports it independently and preserves signed-byte authority on replay', async () => {
    const f = await fixture(); const event = f.event('active', T0 + 10);
    f.setProvider(() => f.page([event]));
    expect(await f.mirror()).toBeNull();
    const out = await f.fire();
    expect(out.diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 1, pages: 1, failed: 0,
      issues: expect.arrayContaining([{ eventId: event.id, failureClass: 'undelivered' }]) } });
    expect(await f.mirror()).toMatchObject({ status: 'active', plan_key: 'team' });
    expect(await f.receipt(event.id)).toMatchObject({ body_digest: null, outcome: 'ignored',
      api_observation: { source: 'stripe-authenticated-api', accountId } });
    expect(f.observe).toHaveBeenCalledWith({ failureClass: 'undelivered', eventId: event.id });
    const originalAllAudit = await f.audit();
    const originalAudit = originalAllAudit.filter(row => row.action === 'billing.event.reconciled');
    expect(originalAudit).toHaveLength(1);
    const readCount = f.requests.length;
    await f.fire();
    expect(f.requests).toHaveLength(readCount);
    expect(await f.audit()).toEqual(originalAllAudit);
    const raw = JSON.stringify(event);
    await f.deliver(raw);
    expect(await f.receipt(event.id)).toMatchObject({ body_digest: webhookBodyDigest(raw) });
    expect((await f.audit()).filter(row => row.action === 'billing.event.reconciled')).toEqual(originalAudit);
    const signedAudit = await f.audit();
    await f.deliver(raw);
    const changed = await f.deliver(`${raw} `);
    expect(changed).toEqual({ outcome: 'replay-mismatch' });
    expect(await f.audit()).toEqual(signedAudit);
    expect(await f.mirror()).toMatchObject({ status: 'active' });
    expect(f.requests.every(request => request.method === 'GET')).toBe(true);
    expect(JSON.stringify({ observations: f.observe.mock.calls, audit: originalAudit }))
      .not.toContain('private customer payload');
  });

  it('resumes a budget-limited fixed window in a new action without overwriting a newer signed webhook', async () => {
    const f = await fixture();
    const first = f.event('active', T0 + 20); const last = f.event('past_due', T0 + 10);
    f.setProvider(url => url.searchParams.has('starting_after') ? f.page([last]) : f.page([first], true));
    expect((await f.fire(1)).diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 0, budgetExhausted: true } });
    expect(await f.checkpoint()).toMatchObject({ startingAfter: first.id, complete: false, createdBefore: T0 + 100 });
    const newer = f.event('canceled', T0 + 30);
    await f.deliver(JSON.stringify(newer));
    expect((await f.fire(3, T0 + 200)).diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 1, failed: 0 } });
    expect(await f.checkpoint()).toMatchObject({ complete: true, createdBefore: T0 + 100 });
    expect(await f.mirror()).toMatchObject({ status: 'canceled' });
    const resumed = f.requests.filter(request => request.url.pathname === '/v1/events').at(-1)!.url;
    expect(resumed.searchParams.get('starting_after')).toBe(first.id);
    expect(resumed.searchParams.get('created[lt]')).toBe(String(T0 + 100));
    expect(f.observe).toHaveBeenCalledWith({ failureClass: 'budget-exhausted', eventId: null });
  });

  it('leaves a failed provider window recoverable and retries it through a new action instance', async () => {
    const f = await fixture(); const event = f.event('active', T0 + 5);
    const failed = await f.fire();
    expect(failed.diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 0, failed: 1 } });
    expect(await f.mirror()).toBeNull(); expect(await f.receipt(event.id)).toBeNull();
    expect(await f.checkpoint()).toMatchObject({ complete: false, startingAfter: null });
    expect(f.observe).toHaveBeenCalledWith({ failureClass: 'provider-unavailable', eventId: null });
    f.setProvider(() => f.page([event]));
    expect((await f.fire()).diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 1, failed: 0 } });
    expect(await f.mirror()).toMatchObject({ status: 'active' });
    expect((await f.audit()).filter(row => row.action === 'billing.event.reconciled')).toHaveLength(1);
  });

  it('claims a materialized cadence once, dispatches its persisted input and fences a paused fire', async () => {
    const f = await fixture(); const event = f.event('active', T0 + 5);
    f.setProvider(() => f.page([event]));
    const templateSlug = `billing-recovery-${hex()}`;
    const workspaceId = 'test-billing-recovery';
    const input = { accountId, createdFrom: T0 - 1, createdBefore: T0 + 100,
      overlapSeconds: 5, maxCustomers: 100, maxPages: 3 };
    const materialize = (active: boolean) => materializePlanSchedule({ sql: db.adminSql,
      workspaceId, harnessSlug: 'papercusp', templateSlug,
      schedule: { kind: 'cron', cron: '*/5 * * * *' },
      action: { system: HOSTED_BILLING_RECONCILE, input }, concurrency: 'skip', active,
    });
    const authored = await materialize(false);
    expect((await listDueCronRoutines(db.adminSql)).some(row => row.id === authored.id)).toBe(false);
    expect(f.requests).toHaveLength(0);
    await materialize(true);
    await db.adminSql`UPDATE harness_shared.routines SET next_fire_at = ${new Date(Date.now() - 1_000)}
      WHERE id = ${authored.id}`;
    const due = (await listDueCronRoutines(db.adminSql)).find(row => row.id === authored.id)!;
    expect(due).toMatchObject({ name: planScheduleRoutineName(templateSlug),
      targetRole: `system:${HOSTED_BILLING_RECONCILE}`, concurrency: 'skip',
      payloadTemplate: { templateSlug, harnessSlug: 'papercusp', input } });
    expect(due.triggerConfig).not.toHaveProperty('action');
    expect((await Promise.all([claimDueRoutine(db.adminSql, due), claimDueRoutine(db.adminSql, due)]))
      .filter(Boolean)).toHaveLength(1);
    const [afterClaim] = await db.adminSql`SELECT next_fire_at FROM harness_shared.routines WHERE id = ${due.id}`;
    expect(new Date(afterClaim!.next_fire_at).getTime()).toBeGreaterThan(Date.now());
    expect(await claimedRoutineDispatchAllowed(db.adminSql, due)).toBe(true);

    // Substitute only private provider/alert dependencies. The same registry lookup
    // and persisted context used by routineFireWorkflow select the actual action.
    const original = getSystemActionEntry(HOSTED_BILLING_RECONCILE)!;
    registerSystemAction(HOSTED_BILLING_RECONCILE, f.action(), original);
    try {
      const entry = getSystemActionEntry(due.targetRole.slice('system:'.length))!;
      const result = await entry.fn({ installSlug: due.installSlug, workspaceId: due.workspaceId,
        routineId: due.id, triggerConfig: due.triggerConfig, payloadTemplate: due.payloadTemplate });
      expect(result).toMatchObject({ diagnostics: { hostedBillingReconcile: { completed: 1, failed: 0 } } });
      expect(await f.mirror()).toMatchObject({ status: 'active', plan_key: 'team' });
      const request = f.requests.find(row => row.url.pathname === '/v1/events')!.url;
      expect(request.searchParams.get('created[gte]')).toBe(String(input.createdFrom));
      expect(request.searchParams.get('created[lt]')).toBe(String(input.createdBefore));
      const requestCount = f.requests.length;
      expect(await deactivatePlanSchedule('papercusp', templateSlug, { sql: db.adminSql })).toBe(true);
      expect(await claimedRoutineDispatchAllowed(db.adminSql, due)).toBe(false);
      expect(await claimDueRoutine(db.adminSql, due)).toBe(false);
      expect(f.requests).toHaveLength(requestCount);
    } finally {
      registerSystemAction(HOSTED_BILLING_RECONCILE, original.fn, original);
    }
  });

  it('recovers the actual durable routine after process death between billing commit and DBOS checkpoint', async () => {
    const f = await fixture();
    const event = f.event('active', T0 + 5);
    const workspaceId = 'test-billing-recovery';
    const routine = await materializePlanSchedule({ sql: db.adminSql, workspaceId,
      harnessSlug: 'papercusp', templateSlug: `billing-crash-${hex()}`,
      schedule: { kind: 'cron', cron: '*/5 * * * *' },
      action: { system: HOSTED_BILLING_RECONCILE, input: { accountId,
        createdFrom: T0 - 1, createdBefore: T0 + 100, maxPages: 3 } },
      concurrency: 'skip', active: true });
    await db.adminSql`UPDATE harness_shared.routines SET next_fire_at = ${new Date(Date.now() - 1_000)}
      WHERE id = ${routine.id}`;
    const due = (await listDueCronRoutines(db.adminSql)).find(row => row.id === routine.id)!;
    expect(await claimDueRoutine(db.adminSql, due)).toBe(true);
    await db.adminSql.unsafe('CREATE TABLE public.p016_recovery_test_calls (mode text NOT NULL, path text NOT NULL)');
    const workflowId = `billing-routine-crash:${routine.id}`;
    const runChild = (mode: 'crash' | 'recover') => spawnSync(process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('../../../test/_hosted-billing-routine-crash-child.ts', import.meta.url))], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...process.env, DATABASE_URL: db.adminDsn, HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
          HARNESS_DATABASE_URL: db.appDsn, PAPERCUSP_DBOS_ROUTINES: '0',
          P016_ROUTINE_CRASH_MODE: mode, P016_ROUTINE_CRASH_INPUT: JSON.stringify({
            workflowId, organizationId: f.organizationId, event, routine: due }) },
        encoding: 'utf8', timeout: 90_000,
      });

    const crashed = runChild('crash');
    expect(crashed.signal, `child stdout: ${crashed.stdout}\nstderr: ${crashed.stderr}`).toBe('SIGKILL');
    expect(await f.mirror()).toMatchObject({ status: 'active', plan_key: 'team' });
    expect(await f.checkpoint()).toMatchObject({ complete: true });
    const committedAudit = await f.audit();
    expect(committedAudit.filter(row => row.action === 'billing.event.reconciled')).toHaveLength(1);
    const originalSteps = await db.adminSql`SELECT function_name FROM dbos.operation_outputs
      WHERE workflow_uuid = ${workflowId} ORDER BY function_id`;
    expect(originalSteps.map(row => row.function_name)).toEqual(['routine-fire-start', 'routine-fire-active-fence']);

    const recovered = runChild('recover');
    expect(recovered.status, `child stdout: ${recovered.stdout}\nstderr: ${recovered.stderr}`).toBe(0);
    expect(recovered.stdout).toContain('HOSTED_BILLING_ROUTINE_RECOVERED');
    expect(await db.adminSql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${workflowId}`)
      .toEqual([{ status: 'SUCCESS' }]);
    expect(await f.audit()).toEqual(committedAudit);
    const calls = await db.adminSql`SELECT mode, path FROM public.p016_recovery_test_calls ORDER BY path`;
    expect(calls).toEqual([
      { mode: 'crash', path: '/v1/account' },
      { mode: 'crash', path: `/v1/customers/${event.data.object.customer}` },
      { mode: 'crash', path: '/v1/events' },
    ]);
    const steps = await db.adminSql`SELECT function_name FROM dbos.operation_outputs
      WHERE workflow_uuid = ${workflowId} ORDER BY function_id`;
    expect(steps.map(row => row.function_name)).toEqual([
      'routine-fire-start', 'routine-fire-active-fence', `system:${HOSTED_BILLING_RECONCILE}`, 'clear-reaper-last-error',
    ]);
  }, 240_000);
});
