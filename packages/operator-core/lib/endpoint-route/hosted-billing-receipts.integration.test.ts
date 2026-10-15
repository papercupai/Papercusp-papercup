/**
 * WI-10004802 (agent-economy-flywheel-2026-08-30 P-046, D-029 §7), integration
 * layer: `GET /hosted/billing/receipts` reads a real Postgres ledger.
 *
 * Real: Postgres with every migration applied, receipts recorded and chained
 * by the reconciliation path, the configured receipts source
 * (`workspaceReceiptSource`) reading as harness_app — the RLS-subject role the
 * hosted pool connects as — under a transaction-local `app.workspace_id`, the
 * same context `withWorkspace` sets. Substituted: the principal resolver and
 * the billing store (only `customerFor` is consulted).
 *
 * The other-workspace case is the control: the same read under a different
 * workspace context returns nothing, so the workspace context is load-bearing
 * and a source that skipped it would be caught.
 */
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { HostedBillingStore } from '../auth/hosted/billing/billing-store';
import { pgLedgerChainLinkStore } from '../cupboard/ledger-chain';
import type { StripeBalanceTransaction } from '../cupboard/money-journal-producers';
import { pgPaymentReceiptStore, recordPaymentReceipts } from '../cupboard/payment-receipt-store';
import { createHostedBillingRuntime, type HostedBillingWorkspaceRunner } from './hosted-billing-runtime';

const WS = 'ws-wi10004802-receipts';
const OTHER_WS = 'ws-wi10004802-other';
const ORG = '11111111-2222-4333-8444-555555555555';
const CREATED = 1_790_000_000;
let db: OrgTestDb;

function bt(id: string, amount: number, customer: string): StripeBalanceTransaction {
  return { id, type: 'charge', amount, fee: 30, currency: 'usd', created: CREATED, source: { id: `ch_${id}`, object: 'charge', customer } };
}

const resolvePrincipal: HostedPrincipalResolver = async () => ({
  ok: true,
  principal: createHostedPrincipal({
    workspaceId: 'control-plane',
    userId: 'user-1',
    activeOrganizationId: ORG,
    sessionId: 'sess-1',
    sessionVersion: 1,
    permissions: ['workspace:view', 'billing:manage'],
  }),
  session: {} as never,
  membership: {} as never,
});

const billingStore = {
  async customerFor(organizationId: string) {
    return organizationId === ORG ? { organizationId: ORG, stripeCustomerId: 'cus_1', livemode: false } : null;
  },
} as unknown as HostedBillingStore;

/** harness_app + a transaction-local workspace context — what withWorkspace does on the hosted pool. */
function appRunner(pinTo?: string): HostedBillingWorkspaceRunner {
  return <T,>(workspaceId: string, fn: (sql: Sql) => Promise<T>) =>
    db.appSql.begin(async (tx) => {
      const sql = tx as unknown as Sql;
      await sql`SELECT set_config('app.workspace_id', ${pinTo ?? workspaceId}, true)`;
      return fn(sql);
    }) as Promise<T>;
}

async function receiptsResponse(runWorkspace: HostedBillingWorkspaceRunner) {
  const built = await createHostedBillingRuntime(
    {
      publicOrigin: 'https://app.example',
      stripeSecretKeyRef: null,
      stripeWebhookSecretRef: null,
      plans: [],
      receiptsWorkspaceId: WS,
    },
    { resolvePrincipal, store: billingStore, runWorkspace },
  );
  const response = await built.app.request('/api/hosted/billing/receipts', { headers: { cookie: 'session=owner' } });
  return { status: response.status, body: await response.json() as { ok: boolean; receipts: Array<Record<string, unknown>> } };
}

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 4 });
  await recordPaymentReceipts(
    WS,
    [bt('txn_a', 1000, 'cus_1'), bt('txn_b', 2500, 'cus_2'), bt('txn_c', 700, 'cus_1')],
    { store: pgPaymentReceiptStore(db.adminSql), chain: pgLedgerChainLinkStore(db.adminSql) },
  );
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('GET /hosted/billing/receipts on Postgres (WI-10004802)', () => {
  it("lists only the org's own receipts, newest first, read as harness_app under the receipts workspace", async () => {
    const { status, body } = await receiptsResponse(appRunner());
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.receipts.map((r) => r.balanceTransactionId)).toEqual(['txn_c', 'txn_a']);
    expect(body.receipts.map((r) => r.amount)).toEqual([700, 1000]);
    // Recorded and chained but no anchor tick has run: listed, not yet verifiable.
    expect(body.receipts.every((r) => r.status === 'not-yet-anchored' && r.receipt === null)).toBe(true);
    expect(body.receipts[0]).toMatchObject({ currency: 'usd', created: new Date(CREATED * 1000).toISOString() });
  });

  it('the same read under another workspace context sees nothing (the context is load-bearing)', async () => {
    const { status, body } = await receiptsResponse(appRunner(OTHER_WS));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, receipts: [] });
  });
});
