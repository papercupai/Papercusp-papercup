/** Private worker for the P-016 real routine workflow process-death guard. */
import postgres, { type Sql } from 'postgres';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { applyRawSerializerFixes } from './_org-test-db';
import type { RoutineRow } from '@papercusp/db-org';
import type { HostedServiceContextRunner } from '../lib/auth/hosted/workos-lifecycle-postgres';
import { PostgresHostedBillingStore } from '../lib/auth/hosted/billing/billing-store';
import { createStripeBillingClient } from '../lib/auth/hosted/billing/stripe-billing-client';
import { HOSTED_BILLING_RECONCILE, makeHostedBillingReconcileAction } from '../lib/harness/routines/hosted-billing-reconcile-action';
import { getSystemActionEntry, registerSystemAction } from '../lib/harness/routines/system-actions';

const dsn = process.env.DATABASE_URL;
const appDsn = process.env.HARNESS_DATABASE_URL;
const mode = process.env.P016_ROUTINE_CRASH_MODE;
if (!dsn || !appDsn || (mode !== 'crash' && mode !== 'recover') || !process.env.P016_ROUTINE_CRASH_INPUT) {
  throw new Error('missing isolated P-016 worker configuration');
}
const input = JSON.parse(process.env.P016_ROUTINE_CRASH_INPUT) as {
  workflowId: string; organizationId: string; routine: RoutineRow;
  event: { id: string; data: { object: { customer: string } } };
};
const admin = applyRawSerializerFixes(postgres(dsn, { max: 2, prepare: false, onnotice: () => {} }));
const app = applyRawSerializerFixes(postgres(appDsn, { max: 2, prepare: false, onnotice: () => {} }));
const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  app.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
DBOS.setConfig({ name: 'hosted-billing-routine-crash', systemDatabaseUrl: dsn,
  systemDatabaseSchemaName: 'dbos', applicationVersion: 'hosted-billing-routine-crash-v1', runAdminServer: false });

// Import the production dispatcher before replacing only the private dependencies
// of its existing registered billing action. No scheduler tick or provider is armed.
const { routineFireWorkflow } = await import('../lib/dbos/routines-workflow');
const store = new PostgresHostedBillingStore(runService);
let requestId = 0;
const built = createStripeBillingClient({ secretKey: 'sk_test_recovery', liveModeAllowed: false,
  fetchImpl: (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    await admin`INSERT INTO public.p016_recovery_test_calls (mode, path) VALUES (${mode}, ${path})`;
    const body = path === '/v1/account' ? { object: 'account', id: 'acct_Recovery' }
      : path === `/v1/customers/${input.event.data.object.customer}` ? { object: 'customer',
        id: input.event.data.object.customer, livemode: false, metadata: { organizationId: input.organizationId } }
        : path === '/v1/events' ? { object: 'list', url: '/v1/events', data: [input.event], has_more: false }
          : null;
    if (!body) throw new Error('unexpected private provider request');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'request-id': `req_Crash${++requestId}` } });
  }) as typeof fetch });
if (!built.ok) throw new Error('private billing client refused');
registerSystemAction(HOSTED_BILLING_RECONCILE, makeHostedBillingReconcileAction({ makeDeps: async () => ({
  store: {
    beginReconciliation: value => store.beginReconciliation(value),
    applyReconciliationPage: async value => {
      const result = await store.applyReconciliationPage(value);
      if (mode === 'crash') {
        // The billing transaction committed, but DBOS has no action checkpoint.
        process.kill(process.pid, 'SIGKILL');
        await new Promise<never>(() => {});
      }
      return result;
    },
    deliveryIssues: value => store.deliveryIssues(value),
    reconciliationTargets: async value => (await store.reconciliationTargets(value))
      .filter(target => target.organizationId === input.organizationId),
  }, client: built.client, planKeyForPrice: value => value === 'price_team' ? 'team' : null,
  observe: async () => {},
}) }), getSystemActionEntry(HOSTED_BILLING_RECONCILE)!);

await DBOS.launch();
if (mode === 'crash') {
  const r = input.routine;
  const handle = await DBOS.startWorkflow(routineFireWorkflow, { workflowID: input.workflowId })(
    r.id, r.workspaceId, r.installSlug, r.targetRole, r.triggerConfig, r.payloadTemplate, r.name,
  );
  await handle.getResult();
  throw new Error('billing crash point was not reached');
}
await DBOS.getResult(input.workflowId, 30);
const [terminal] = await admin`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${input.workflowId}`;
if (terminal?.status !== 'SUCCESS') throw new Error('billing routine recovery did not reach SUCCESS');
await DBOS.shutdown();
await Promise.all([app.end({ timeout: 5 }), admin.end({ timeout: 5 })]);
process.stdout.write('HOSTED_BILLING_ROUTINE_RECOVERED\n');
process.exit(0);
