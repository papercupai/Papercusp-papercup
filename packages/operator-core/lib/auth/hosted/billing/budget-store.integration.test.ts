/** Real Postgres/roles/transactions for hosted commitments (P-005). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { journalEntryForMovement } from '../../../cupboard/money-journal';
import { postMoneyJournalEntry } from '../../../cupboard/money-journal-store';
import { pgPaymentReceiptStore, type NewPaymentReceipt } from '../../../cupboard/payment-receipt-store';
import { receiptCommitment } from '../../../cupboard/payment-receipt';
import type { HostedPrepaidFundingInput } from './budget-funding';
import { PostgresHostedBudgetStore, type HostedBudgetContextReader, type HostedBudgetObservation,
  type HostedBudgetRequest, type HostedBudgetScope, type HostedPrepaidAllocationRequest, type HostedPrepaidFundingReader,
  createLockedHostedStripeFundingReader, evaluateLockedHostedPrepaidFunding,
  readLockedHostedPrepaidAllocations, readLockedHostedStripeFundingPopulation,
  readLockedHostedBudgetPopulation } from './budget-store';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
let db: OrgTestDb;
const T = Date.UTC(2026, 9, 2);
const service: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>) => db.appSql.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
  await tx.unsafe('SET LOCAL ROLE hosted_service');
  return fn(tx as unknown as Sql);
}) as Promise<T>;

// The production funding reader is not installed by this fixture. The fixture
// uses real locked rows to exercise the SAME-transaction authority contract;
// these grants are engineering inputs, not paid customer evidence.
const readContext: HostedBudgetContextReader = async (sql, input) => {
  const [row] = await sql<{ cap: number; funding: number; retained: number | null; workspace_cap: number | null }[]>`
    SELECT * FROM papercusp_auth.test_budget_authority
    WHERE control = ${input.scope.controlWorkspaceId} AND org = ${input.scope.organizationId} FOR UPDATE`;
  if (!row) return null;
  const limit = (customerWorkspaceId: string | null, cents: number) => ({ customerWorkspaceId,
    entitlements: { budgets: { [input.budgetKey]: Number(cents) } }, fundedMicros: Number(row.funding),
    externalSpentMicros: 0, retainedReserveMicros: row.retained === null ? null : Number(row.retained), unreconciled: false });
  const { startMs, endMs } = shadowMonthBounds(input.month);
  return { scope: input.scope, month: input.month, asOfMs: input.asOfMs, evidenceRef: 'fixture:verified-funding',
    policy: { policyId: 'fixture-policy', revision: 1, budgetKey: input.budgetKey,
      effectiveFromMs: startMs, effectiveUntilMs: endMs, warningBps: 8000 },
    limits: [limit(null, row.cap), ...(row.workspace_cap === null ? [] : [limit(input.scope.customerWorkspaceId, row.workspace_cap)])] };
};
const store = (reader: HostedBudgetContextReader = readContext, run = service, now = () => T) =>
  new PostgresHostedBudgetStore({ readContext: reader, run, now });

async function tenant(controlWorkspaceId: string = randomUUID(), organizationId: string = randomUUID()): Promise<HostedBudgetScope> {
  const customerWorkspaceId = randomUUID();
  await db.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${organizationId}::uuid, ${'budget-' + organizationId}, 'Budget fixture') ON CONFLICT DO NOTHING`;
  await db.adminSql`INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref, status)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, 'gcp', 'Budget fixture', 'delegation://fixture/gcp', 'connected')`;
  await db.adminSql`INSERT INTO harness_shared.workspace_hosts
    (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network, desired_state, observed_state)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, 'Budget fixture', ${customerWorkspaceId}, 'gcp', 'fixture-project',
      'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')`;
  await db.adminSql`INSERT INTO harness_shared.customer_workspaces
    (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, ${organizationId}, ${customerWorkspaceId}, 'Budget fixture', 'active', 'user', 'fixture-user')`;
  await db.adminSql`INSERT INTO papercusp_auth.test_budget_authority (control, org, cap, funding, retained)
    VALUES (${controlWorkspaceId}, ${organizationId}, 10, 100000, 0) ON CONFLICT DO NOTHING`;
  return { controlWorkspaceId, organizationId, customerWorkspaceId };
}
const request = (scope: HostedBudgetScope, change: Partial<HostedBudgetRequest> = {}): HostedBudgetRequest => ({
  scope, reservationId: randomUUID(), month: '2026-10', budgetKey: 'consumption.usd_cents', maximumCostMicros: 100_000,
  providerLimitRef: 'fixture:enforced-limit', asOfMs: T, ...change,
});
const observation = (r: HostedBudgetRequest, change: Partial<HostedBudgetObservation> = {}): HostedBudgetObservation => ({
  scope: r.scope, reservationId: r.reservationId, eventId: randomUUID(), revision: 1, observedAtMs: T + 1,
  costSource: 'provider-billed', costMicros: 40_003, providerFinal: true, evidenceRef: 'fixture:final-bill', ...change,
});
const rows = (s: HostedBudgetScope) => db.adminSql`SELECT * FROM papercusp_auth.hosted_budget_receipts
  WHERE control_workspace_id = ${s.controlWorkspaceId} AND organization_id = ${s.organizationId}`;

const prepaidRequest = (s: HostedBudgetScope, stripeAccountId = 'acct_' + randomUUID().replaceAll('-', '')): HostedPrepaidAllocationRequest => ({
  scope: s, stripeAccountId, month: '2026-10', asOfMs: T,
  allocation: { allocationId: randomUUID(), paymentTransactionId: 'txn_source', organizationId: s.organizationId,
    customerWorkspaceId: s.customerWorkspaceId, budgetKey: 'consumption.usd_cents', micros: 100_000 },
});
// Authenticated-source-shaped fixture, not a production verifier. The real
// callback must read Stripe/bank/provider/journal/entitlement evidence itself.
function prepaidEvidence(r: HostedPrepaidAllocationRequest, grossCents = 100): Omit<HostedPrepaidFundingInput, 'allocations'> {
  const transaction = { id: r.allocation.paymentTransactionId, amount: grossCents, fee: 0, currency: 'usd', created: T / 1000 };
  const built = journalEntryForMovement({ entryId: 'stripe-bt:' + transaction.id, occurredAtMs: T, currency: 'USD',
    externalRef: { kind: 'stripe-balance-transaction', id: transaction.id },
    movement: { kind: 'credit-purchase', grossCents, feeCents: 0, taxCents: 0 } });
  if (!built.ok) throw new Error(built.detail);
  const salt = 'a'.repeat(64);
  return { scope: r.scope, budgetKey: r.allocation.budgetKey, windowStartMs: shadowMonthBounds(r.month).startMs, asOfMs: r.asOfMs,
    snapshot: { controlWorkspaceId: r.scope.controlWorkspaceId, organizationId: r.scope.organizationId,
      stripeAccountId: r.stripeAccountId, stripeCustomerId: 'cus_A', livemode: true, complete: true,
      asOfMs: r.asOfMs, evidenceRef: 'fixture:source-census' },
    payments: [{ entry: built.entry, available: true, receipt: { transaction, receiptSeq: 1, salt,
      commitment: receiptCommitment(transaction, salt), sourceId: 'ch_fixture', sourceCustomer: 'cus_A' } }],
    reversals: [], priorCharges: [], cashBacking: { controlWorkspaceId: r.scope.controlWorkspaceId, stripeAccountId: r.stripeAccountId,
      asOfMs: r.asOfMs, livemode: true, complete: true, evidenceRef: 'fixture:cash-census', journalEntries: [built.entry],
      availableMicros: grossCents * 10_000, unpaidProviderMicros: 0, retainedReserveMicros: 0 } };
}
const prepaidStore = (reader: HostedPrepaidFundingReader = async (_sql, r) => prepaidEvidence(r), run = service, now = () => T) =>
  new PostgresHostedBudgetStore({ readPrepaidFunding: reader, run, now });
const allocationRows = (account: string) => db.adminSql`SELECT * FROM papercusp_auth.hosted_prepaid_allocations
  WHERE stripe_account_id = ${account}`;
const populationInput = { pool: { controlWorkspaceId: 'fixture-funding-control', stripeAccountId: 'acct_FundingPopulation' },
  journalWorkspaceId: 'fixture-funding-journal' };
const populationReceipt = (id: string, customer = 'cus_PopulationA'): NewPaymentReceipt => {
  const transaction = { id, amount: 100, fee: 0, currency: 'usd', created: T / 1000 };
  const salt = 'b'.repeat(64);
  return { transaction, salt, commitment: receiptCommitment(transaction, salt), sourceId: 'ch_' + id, sourceCustomer: customer };
};
const populationEntry = (id: string) => {
  const built = journalEntryForMovement({ entryId: 'stripe-bt:' + id, occurredAtMs: T, currency: 'USD',
    externalRef: { kind: 'stripe-balance-transaction', id },
    movement: { kind: 'credit-purchase', grossCents: 100, feeCents: 0, taxCents: 0 } });
  if (!built.ok) throw new Error(built.detail);
  return built.entry;
};
const stripeFundingConfiguration = () => ({ ...structuredClone(populationInput),
  policy: { daoBasisPoints: 0, refundReserveBasisPoints: 0 }, maximumAgeMs: 1000 });
function emptyStripeTransport(organizationId: string, accountId = populationInput.pool.stripeAccountId) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_live_fixture');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe('error');
    const path = new URL(String(url)).pathname; calls.push(path);
    let body: unknown;
    if (path === '/v1/account') body = { object: 'account', id: accountId };
    else if (path === '/v1/customers/cus_ServerBinding') body = { object: 'customer', id: 'cus_ServerBinding',
      livemode: true, metadata: { organizationId } };
    else if (path === '/v1/balance') body = { object: 'balance', livemode: true, available: [], pending: [] };
    else if (['/v1/charges', '/v1/refunds', '/v1/disputes', '/v1/balance_transactions'].includes(path)) {
      body = { object: 'list', data: [], has_more: false };
    } else throw new Error('unexpected Stripe fixture path');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'request-id': 'req_BindingFixture' } });
  };
  return { calls, fetchImpl };
}
async function withStripeBinding(check: (sql: Sql, s: HostedBudgetScope) => Promise<void>, livemode = true) {
  const s = { controlWorkspaceId: populationInput.pool.controlWorkspaceId, organizationId: randomUUID(),
    customerWorkspaceId: 'fixture-server-bound-workspace' };
  const rollback = new Error('stripe binding fixture rollback');
  try {
    await service(async sql => {
      await sql`INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
        VALUES (${s.organizationId}::uuid, 'cus_ServerBinding', ${livemode})`;
      await check(sql, s);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}
async function withPopulationHeld(check: () => Promise<void>, rollback = false) {
  let release!: () => void; let announce!: () => void; let failed!: (error: unknown) => void;
  const unblock = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>((resolve, reject) => { announce = resolve; failed = reject; });
  const holder = service(async sql => {
    await readLockedHostedStripeFundingPopulation(sql, populationInput);
    announce(); await unblock;
    if (rollback) throw new Error('population rollback');
  });
  // A failed read must reject ready, never leave the test awaiting a phantom holder.
  void holder.catch(failed);
  try { await ready; await check(); }
  finally {
    release();
    if (rollback) await expect(holder).rejects.toThrow('population rollback');
    else await holder;
  }
}

describe('PostgresHostedBudgetStore (real hosted service transactions)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    const draft = new URL('../../../../../../libs/papercusp/libs/db/sql/1352-hosted-budget-reservations.sql.DRAFT', import.meta.url);
    const armed = new URL('../../../../../../libs/papercusp/libs/db/sql/1352-hosted-budget-reservations.sql', import.meta.url);
    let migration: string;
    try { migration = readFileSync(draft, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; migration = readFileSync(armed, 'utf8'); }
    await db.adminSql.unsafe(migration); await db.adminSql.unsafe(migration);
    const exactDraft = new URL('../../../../../../libs/papercusp/libs/db/sql/1356-hosted-budget-exact-micros.sql.DRAFT', import.meta.url);
    const exactArmed = new URL('../../../../../../libs/papercusp/libs/db/sql/1356-hosted-budget-exact-micros.sql', import.meta.url);
    let exactMigration: string;
    try { exactMigration = readFileSync(exactDraft, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exactMigration = readFileSync(exactArmed, 'utf8'); }
    await db.adminSql.unsafe(exactMigration); await db.adminSql.unsafe(exactMigration);
    const allocationDraft = new URL('../../../../../../libs/papercusp/libs/db/sql/1372-hosted-prepaid-allocations.sql.DRAFT', import.meta.url);
    const allocationArmed = new URL('../../../../../../libs/papercusp/libs/db/sql/1372-hosted-prepaid-allocations.sql', import.meta.url);
    let allocationMigration: string;
    try { allocationMigration = readFileSync(allocationDraft, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; allocationMigration = readFileSync(allocationArmed, 'utf8'); }
    await db.adminSql.unsafe(allocationMigration); await db.adminSql.unsafe(allocationMigration);
    const populationDraft = new URL('../../../../../../libs/papercusp/libs/db/sql/1375-hosted-stripe-funding-population.sql.DRAFT', import.meta.url);
    const populationArmed = new URL('../../../../../../libs/papercusp/libs/db/sql/1375-hosted-stripe-funding-population.sql', import.meta.url);
    let populationMigration: string;
    try { populationMigration = readFileSync(populationDraft, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; populationMigration = readFileSync(populationArmed, 'utf8'); }
    await db.adminSql.unsafe(populationMigration); await db.adminSql.unsafe(populationMigration);
    // Apply the current extension LAST: replaying 1375 above intentionally
    // replaces the bridge, so template application alone is insufficient.
    let liabilityMigration: string;
    try { liabilityMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1385-hosted-journal-liability-population.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      liabilityMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1385-hosted-journal-liability-population.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(liabilityMigration); await db.adminSql.unsafe(liabilityMigration);
    let budgetPopulationMigration: string;
    try { budgetPopulationMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1388-hosted-budget-population-writer-fence.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      budgetPopulationMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1388-hosted-budget-population-writer-fence.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(budgetPopulationMigration); await db.adminSql.unsafe(budgetPopulationMigration);
    await db.adminSql.unsafe(`CREATE TABLE papercusp_auth.test_budget_authority (
      control text NOT NULL, org text NOT NULL, cap bigint NOT NULL, funding bigint NOT NULL,
      retained bigint, workspace_cap bigint, PRIMARY KEY(control, org));
      GRANT SELECT, UPDATE ON papercusp_auth.test_budget_authority TO hosted_service`);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  it('takes the population writer fence before context reads even when empty, then inserts without an upgrade', async () => {
    const s = await tenant();
    const outcome = await store(async (sql, input) => {
      const population = await readLockedHostedBudgetPopulation(sql);
      expect(population).toEqual({ history: [], latest: [] });
      const [fence] = await sql`SELECT mode FROM pg_locks WHERE pid = pg_backend_pid() AND granted
        AND relation = 'papercusp_auth.hosted_budget_receipts'::regclass AND mode = 'ShareRowExclusiveLock'`;
      expect(fence?.mode).toBe('ShareRowExclusiveLock');
      // A zero-row writer still needs a table lock: row-only locks do not
      // protect an empty population against a first admission.
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await tx`LOCK TABLE papercusp_auth.hosted_budget_receipts IN ROW EXCLUSIVE MODE`;
      })).rejects.toMatchObject({ code: '55P03' });
      return readContext(sql, input);
    }).reserve(request(s));
    expect(outcome.outcome).toBe('reserved'); expect(await rows(s)).toHaveLength(1);
    await db.adminSql.begin(async tx => {
      await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
      await tx`LOCK TABLE papercusp_auth.hosted_budget_receipts IN ROW EXCLUSIVE MODE`;
    });
  });

  it('refuses an absent or released writer fence instead of acquiring it after an account lock', async () => {
    await expect(service(sql => readLockedHostedBudgetPopulation(sql)))
      .rejects.toThrow('budget population requires the early writer fence');
    // Autocommit releases the fence at statement end, even on the same pool.
    await db.adminSql`SELECT papercusp_auth.lock_hosted_stripe_funding_population('budget-writer')`;
    await expect(readLockedHostedBudgetPopulation(db.adminSql))
      .rejects.toThrow('budget population requires the early writer fence');
    await service(async sql => {
      await readLockedHostedPrepaidAllocations(sql, populationInput.pool);
      await expect(readLockedHostedBudgetPopulation(sql))
        .rejects.toThrow('budget population requires the early writer fence');
    });
  });

  it('refuses stale snapshot isolation even with a retained writer fence', async () => {
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
      await expect(db.appSql.begin(async tx => {
        await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        await tx`SELECT papercusp_auth.lock_hosted_stripe_funding_population('budget-writer')`;
        return readLockedHostedBudgetPopulation(tx as unknown as Sql);
      })).rejects.toThrow('budget population requires read committed');
    }
  });

  it('retains every exact revision and separates identical reservation IDs across controls and organizations', async () => {
    const control = randomUUID(); const org = randomUUID(); const reservationId = randomUUID();
    const scopes = [await tenant(control, org), await tenant(control), await tenant(randomUUID(), org)];
    const current = request(scopes[0]!, { reservationId });
    const unpriced = request(scopes[1]!, { reservationId, budgetKey: 'fixture.other-key' });
    const oldTime = Date.UTC(2026, 8, 2);
    const old = request(scopes[2]!, { reservationId, month: '2026-09', asOfMs: oldTime });
    expect((await store().reserve(current)).outcome).toBe('reserved');
    expect((await store().reserve(unpriced)).outcome).toBe('reserved');
    expect((await store(readContext, service, () => oldTime).reserve(old)).outcome).toBe('reserved');
    expect((await store().observe(observation(current, { costSource: 'provider-reported', providerFinal: false,
      costMicros: 40_003, costMicrosExact: '40003.001' }))).outcome).toBe('recorded');
    expect((await store().observe(observation(current, { revision: 2, observedAtMs: T + 2,
      costMicros: 0, costMicrosExact: '0.002' }))).outcome).toBe('recorded');
    expect((await store().observe(observation(old, { observedAtMs: oldTime + 1 }))).outcome).toBe('recorded');
    await service(async sql => {
      await sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population('budget-writer')`;
      const population = await readLockedHostedBudgetPopulation(sql);
      const all = population.history.filter(r => r.reservationId === reservationId);
      const latest = population.latest.filter(r => r.reservationId === reservationId);
      expect(all).toHaveLength(6); expect(latest).toHaveLength(3);
      expect(all.find(r => r.scope.organizationId === org && r.scope.controlWorkspaceId === control && r.revision === 1))
        .toMatchObject({ costMicros: 40_003, costMicrosExact: '40003.001', providerFinal: false });
      expect(latest.find(r => r.scope.controlWorkspaceId === control && r.scope.organizationId === org))
        .toMatchObject({ revision: 2, costMicros: 0, costMicrosExact: '0.002', providerFinal: true,
          providerLimitRef: 'fixture:enforced-limit', maximumCostMicros: 100_000 });
      expect(latest.find(r => r.scope.organizationId === unpriced.scope.organizationId))
        .toMatchObject({ revision: 0, costMicros: null, costSource: 'unpriced', budgetKey: 'fixture.other-key' });
      expect(latest.find(r => r.scope.controlWorkspaceId === old.scope.controlWorkspaceId))
        .toMatchObject({ month: '2026-09', costSource: 'provider-billed' });
      expect(Object.isFrozen(population)).toBe(true); expect(Object.isFrozen(population.history)).toBe(true);
      expect(Object.isFrozen(population.latest)).toBe(true);
      for (const r of all) { expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.scope)).toBe(true); }
    });
  });

  it('serializes actual reservation readers before organization/account locks and commits both without SHARE upgrades', async () => {
    const scopes = [await tenant(), await tenant()]; const account = 'acct_BudgetCensus';
    const snapshots: number[] = [];
    const reader: HostedBudgetContextReader = async (sql, input) => {
      await readLockedHostedPrepaidAllocations(sql, { controlWorkspaceId: input.scope.controlWorkspaceId,
        stripeAccountId: account });
      const population = await readLockedHostedBudgetPopulation(sql);
      snapshots.push(population.latest.filter(r => scopes.some(s => s.organizationId === r.scope.organizationId)).length);
      return readContext(sql, input);
    };
    const bounded: HostedServiceContextRunner = fn => service(async sql => {
      await sql.unsafe("SET LOCAL statement_timeout = '5s'"); return fn(sql);
    });
    const results = await Promise.all(scopes.map(s => store(reader, bounded).reserve(request(s))));
    expect(results.map(r => r.outcome)).toEqual(['reserved', 'reserved']);
    expect(snapshots).toEqual([0, 1]);
  });

  it('holds the population through an actual observation INSERT and releases it after rollback', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    await expect(service(async sql => {
      await sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population('budget-writer')`;
      const inTransaction: HostedServiceContextRunner = fn => fn(sql);
      expect((await store(readContext, inTransaction).observe(observation(r))).outcome).toBe('recorded');
      const population = await readLockedHostedBudgetPopulation(sql);
      expect(population.latest.find(p => p.reservationId === r.reservationId)?.revision).toBe(1);
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await tx`LOCK TABLE papercusp_auth.hosted_budget_receipts IN ROW EXCLUSIVE MODE`;
      })).rejects.toMatchObject({ code: '55P03' });
      throw new Error('budget census rollback');
    })).rejects.toThrow('budget census rollback');
    expect(await rows(s)).toHaveLength(1);
    expect((await store().observe(observation(r))).outcome).toBe('recorded');
  });

  it('waits at the early table fence for a real observation writer and reads its committed correction', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    let ready!: () => void; let release!: () => void; let failed!: (error: unknown) => void;
    const entered = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let readerPid = 0;
    const writer = service(async sql => {
      const inTransaction: HostedServiceContextRunner = fn => fn(sql);
      const result = await store(readContext, inTransaction).observe(observation(r,
        { costMicros: 0, costMicrosExact: '0.001' }));
      ready(); await released; return result;
    });
    void writer.catch(failed);
    let reader: Promise<unknown> | undefined;
    try {
      await entered;
      reader = store(async (sql, input) => {
        const population = await readLockedHostedBudgetPopulation(sql);
        expect(population.latest.find(p => p.reservationId === r.reservationId))
          .toMatchObject({ revision: 1, costMicrosExact: '0.001' });
        return readContext(sql, input);
      }, fn => service(async sql => {
        const [backend] = await sql`SELECT pg_backend_pid() AS pid`; readerPid = backend!.pid;
        await sql.unsafe("SET LOCAL statement_timeout = '5s'"); return fn(sql);
      })).reserve(request(s, { maximumCostMicros: 1 }));
      await vi.waitFor(async () => {
        const waiting = await db.adminSql`SELECT mode FROM pg_locks WHERE pid = ${readerPid} AND NOT granted
          AND relation = 'papercusp_auth.hosted_budget_receipts'::regclass`;
        expect(waiting).toEqual([{ mode: 'ShareRowExclusiveLock' }]);
      }, { timeout: 2000 });
    } finally { release(); await Promise.all([writer, reader]); }
    expect((await writer).outcome).toBe('recorded');
    expect(await reader).toMatchObject({ outcome: 'reserved' });
  });

  it('keeps the new phase service-only, refuses unknown phases, and adds no financial UPDATE grants', async () => {
    const [permissions] = await db.adminSql`SELECT
      has_function_privilege('hosted_service', 'papercusp_auth.lock_hosted_stripe_funding_population(text)', 'EXECUTE') AS service,
      has_function_privilege('hosted_app', 'papercusp_auth.lock_hosted_stripe_funding_population(text)', 'EXECUTE') AS app,
      has_function_privilege('harness_app', 'papercusp_auth.lock_hosted_stripe_funding_population(text)', 'EXECUTE') AS harness,
      has_table_privilege('hosted_service', 'papercusp_auth.hosted_budget_receipts', 'UPDATE') AS update,
      has_table_privilege('hosted_service', 'harness_shared.money_journal_entries', 'UPDATE') AS financial_update`;
    expect(permissions).toEqual({ service: true, app: false, harness: false, update: false, financial_update: false });
    await expect(service(sql => sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population('arbitrary-table')`))
      .rejects.toThrow('invalid hosted funding population phase');
    await expect(service(sql => sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population(NULL::text)`))
      .rejects.toThrow('invalid hosted funding population phase');
  });

  it('refuses a late writer fence after either an account or the existing source phase', async () => {
    await expect(service(async sql => {
      await readLockedHostedPrepaidAllocations(sql, populationInput.pool);
      await sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population('budget-writer')`;
    })).rejects.toThrow('budget writer fence must precede organization account and source locks');
    await expect(service(async sql => {
      await sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population()`;
      await sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population('budget-writer')`;
    })).rejects.toThrow('budget writer fence must precede organization account and source locks');
  });

  it('reproduces the unsafe concurrent SHARE-to-write upgrade in disposable transactions', async () => {
    let readyCount = 0; let ready!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const attempt = () => db.adminSql.begin(async tx => {
      await tx.unsafe("SET LOCAL deadlock_timeout = '50ms'");
      await tx.unsafe("SET LOCAL statement_timeout = '5s'");
      await tx`LOCK TABLE papercusp_auth.hosted_budget_receipts IN SHARE MODE`;
      if (++readyCount === 2) ready();
      await released;
      // This is the same table mode any INSERT must acquire, even into an
      // empty population. No product-source mutation or fixture data damage.
      await tx`LOCK TABLE papercusp_auth.hosted_budget_receipts IN ROW EXCLUSIVE MODE`;
    }).then(() => ({ ok: true as const }), error => ({ ok: false as const, code: error.code }));
    const attempts = [attempt(), attempt()];
    try { await Promise.race([entered, Promise.all(attempts)]); }
    finally { release(); }
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter(r => !r.ok && r.code === '40P01')).toHaveLength(1);
    expect(outcomes.filter(r => r.ok)).toHaveLength(1);
  });

  it('dispatches exactly once across concurrent instances, only after the reservation commits', async () => {
    const s = await tenant(); const r = request(s); const launches: string[] = [];
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => store().executeOnce(r, async grant => {
      // A separate connection sees the admission, proving commit-before-I/O.
      expect(await rows(s)).toHaveLength(1);
      expect(grant).toMatchObject({ reservationId: r.reservationId, maximumCostMicros: 100_000,
        providerLimitRef: r.providerLimitRef, policyId: 'fixture-policy', policyRevision: 1 });
      expect(Object.isFrozen(grant)).toBe(true); expect(Object.isFrozen(grant.scope)).toBe(true);
      launches.push(grant.reservationId); return 'provider-operation';
    })));
    expect(launches).toEqual([r.reservationId]);
    expect(outcomes.filter(o => o.execution === 'dispatched')).toHaveLength(1);
    expect(outcomes.filter(o => o.execution === 'not-started' && o.reservation.outcome === 'duplicate')).toHaveLength(11);
    expect(outcomes.find(o => o.execution === 'dispatched')?.value).toBe('provider-operation');
  });

  it('keeps the launch fence and full hold after a provider starts but its response is lost', async () => {
    const s = await tenant(); const r = request(s); let launches = 0;
    await expect(store().executeOnce(r, async () => { launches++; throw new Error('lost provider response'); }))
      .rejects.toThrow('lost provider response');
    const retry = await store().executeOnce(r, async () => { launches++; });
    expect(retry.execution).toBe('not-started'); expect(retry.reservation.outcome).toBe('duplicate');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    expect(launches).toBe(1); expect(await rows(s)).toHaveLength(1);
  });

  it('never treats an orphaned admission or a final zero bill as permission to dispatch again', async () => {
    const s = await tenant(); const r = request(s); let launches = 0;
    // Crash after commit, before any network I/O; a successor cannot know that.
    await store().reserve(r);
    expect((await store().executeOnce(r, async () => { launches++; })).execution).toBe('not-started');
    await store().observe(observation(r, { costMicros: 0 }));
    expect((await store().executeOnce(r, async () => { launches++; })).execution).toBe('not-started');
    // A separately admitted operation may use the released funding.
    expect((await store().executeOnce(request(s), async () => { launches++; })).execution).toBe('dispatched');
    expect(launches).toBe(1);
  });

  it('does not dispatch refused, conflicting, cross-workspace or unconfigured requests', async () => {
    const s = await tenant(); const r = request(s); let launches = 0;
    const execute = async () => { launches++; };
    expect((await new PostgresHostedBudgetStore({ run: service }).executeOnce(r, execute)).execution).toBe('not-started');
    expect((await store().executeOnce({ ...r, maximumCostMicros: 100_001 }, execute)).reservation.outcome).toBe('refused');
    await store().reserve(r);
    expect((await store().executeOnce({ ...r, providerLimitRef: 'fixture:other-limit' }, execute)).reservation.outcome).toBe('conflict');
    const foreign = { ...r, scope: { ...s, customerWorkspaceId: randomUUID() } };
    expect((await store().executeOnce(foreign, execute)).execution).toBe('not-started');
    expect(launches).toBe(0);
  });

  it('does not call the provider before a failed commit and permits a subsequent successful admission', async () => {
    const s = await tenant(); const r = request(s); let launches = 0;
    const execute = async () => { launches++; };
    const crashing: HostedServiceContextRunner = fn => service(async sql => { await fn(sql); throw new Error('commit failed'); });
    await expect(store(readContext, crashing).executeOnce(r, execute)).rejects.toThrow('commit failed');
    expect(launches).toBe(0); expect(await rows(s)).toHaveLength(0);
    expect((await store().executeOnce(r, execute)).execution).toBe('dispatched');
    expect(launches).toBe(1);
  });

  it('dispatches the frozen admitted binding even if the caller mutates its request during admission', async () => {
    const s = await tenant(); const r = request(s);
    const original = { ...r, scope: { ...s } };
    const mutating: HostedBudgetContextReader = async (sql, input) => {
      Object.assign(r, { maximumCostMicros: 1, providerLimitRef: 'fixture:changed' });
      Object.assign(r.scope, { customerWorkspaceId: randomUUID() });
      return readContext(sql, input);
    };
    const result = await store(mutating).executeOnce(r, async grant => {
      expect(grant).toMatchObject({ scope: original.scope, maximumCostMicros: original.maximumCostMicros,
        providerLimitRef: original.providerLimitRef });
      return grant.reservationId;
    });
    expect(result.execution).toBe('dispatched'); expect(result.value).toBe(original.reservationId);
  });

  it('retains exposure and refuses redispatch after an actual streaming cancellation', async () => {
    const s = await tenant(); const r = request(s); let cancellations = 0; let launches = 0;
    const first = await store().executeOnce(r, async () => {
      launches++;
      return new ReadableStream<string>({ start(controller) { controller.enqueue('partial output'); },
        cancel() { cancellations++; } });
    });
    expect(first.execution).toBe('dispatched');
    const reader = first.value!.getReader(); expect((await reader.read()).value).toBe('partial output');
    await reader.cancel(); expect(cancellations).toBe(1);
    await store().observe(observation(r, { costSource: 'provider-reported', costMicros: 0, providerFinal: false }));
    expect((await store().executeOnce(r, async () => { launches++; })).execution).toBe('not-started');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    expect(launches).toBe(1);
  });

  it('serializes parallel work across separate store instances at the exact organization cap', async () => {
    const s = await tenant();
    const outcomes = await Promise.all(Array.from({ length: 15 }, () => store().reserve(request(s, { maximumCostMicros: 10_000 }))));
    expect(outcomes.filter(r => r.outcome === 'reserved')).toHaveLength(10);
    expect(outcomes.filter(r => r.outcome === 'refused')).toHaveLength(5);
    expect(await rows(s)).toHaveLength(10);
  });

  it('deduplicates a lost-response retry after restart and refuses changed request bindings', async () => {
    const s = await tenant(); const r = request(s);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().reserve(r)));
    expect(outcomes.filter(o => o.outcome === 'reserved')).toHaveLength(1);
    expect(outcomes.filter(o => o.outcome === 'duplicate')).toHaveLength(7);
    expect((await store().reserve({ ...r, asOfMs: T + 100 })).outcome).toBe('duplicate');
    expect((await store().reserve({ ...r, maximumCostMicros: 1 })).outcome).toBe('conflict');
    expect((await store().reserve({ ...r, providerLimitRef: 'fixture:different-limit' })).outcome).toBe('conflict');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    expect(await rows(s)).toHaveLength(1);
  });

  it('retains cancelled/unpriced/incomplete holds, then settles/replays a final bill and replaces a correction', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    expect((await store().observe(observation(r, { costSource: 'unpriced', costMicros: null, providerFinal: false }))).outcome).toBe('recorded');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    await store().observe(observation(r, { revision: 2, costSource: 'provider-reported', costMicros: 0, providerFinal: false }));
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    const final = observation(r, { revision: 3 });
    expect((await store().observe(final)).outcome).toBe('recorded');
    expect((await store().observe(final)).outcome).toBe('duplicate');
    expect((await store().reserve(request(s, { maximumCostMicros: 59_998 }))).outcome).toBe('refused');
    await store().observe(observation(r, { revision: 4, observedAtMs: T + 2, costMicros: 60_001 }));
    expect((await store().reserve(request(s, { maximumCostMicros: 39_999 }))).outcome).toBe('reserved');
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
  });

  it('aggregates fractional final liabilities without flooring each bill or over-rounding each hold', async () => {
    const s = await tenant();
    for (const exact of ['0.4', '0.6', '0.0000000000000000001']) {
      const r = request(s, { maximumCostMicros: 1 });
      expect((await store().reserve(r)).outcome).toBe('reserved');
      await store().observe(observation(r, { costMicros: 0, costMicrosExact: exact }));
    }
    const refused = await store().reserve(request(s, { maximumCostMicros: 99_999 }));
    expect(refused.outcome).toBe('refused');
    expect(refused.decisions[0]).toMatchObject({ availableMicros: 99_998, availableMicrosExact: '99998.9999999999999999999' });
    expect((await store().reserve(request(s, { maximumCostMicros: 99_998 }))).outcome).toBe('reserved');
  });

  it('persists exact amounts across restarts, replaces corrections and rejects changed fractional replays', async () => {
    const s = await tenant(); const r = request(s, { maximumCostMicros: 1 }); await store().reserve(r);
    const first = observation(r, { costMicros: 0, costMicrosExact: '0.1234567890123456789' });
    expect((await store().observe(first)).receipt?.costMicrosExact).toBe(first.costMicrosExact);
    expect((await store().observe(first)).outcome).toBe('duplicate');
    expect((await store().observe({ ...first, costMicrosExact: '0.1234567890123456788' })).outcome).toBe('conflict');
    const [saved] = await db.adminSql`SELECT cost_micros::text AS exact FROM papercusp_auth.hosted_budget_receipts
      WHERE organization_id = ${s.organizationId} AND revision = 1`;
    expect(saved?.exact).toBe(first.costMicrosExact);
    await store().observe(observation(r, { revision: 2, observedAtMs: T + 2, costMicros: 0, costMicrosExact: '0.2' }));
    const next = await store().reserve(request(s, { maximumCostMicros: 99_999 }));
    expect(next.outcome).toBe('reserved'); expect(next.decisions[0]?.availableMicrosExact).toBe('99999.8');
  });

  it('retains pending fractional reports and suspends even submicro old-month overruns', async () => {
    const s = await tenant(); const r = request(s, { maximumCostMicros: 1, month: '2026-09', asOfMs: Date.UTC(2026, 8, 2) });
    await store(readContext, service, () => r.asOfMs).reserve(r);
    const report = observation(r, { costSource: 'provider-reported', costMicros: 0, costMicrosExact: '0.1', providerFinal: false });
    expect((await store().observe(report)).settlement).toMatchObject({ state: 'pending', heldMicros: 1, releasedMicros: 0 });
    expect((await store().reserve(request(s, { maximumCostMicros: 100_000 }))).outcome).toBe('refused');
    const overrun = await store().observe(observation(r, { revision: 2, observedAtMs: T + 2,
      costMicros: 1, costMicrosExact: '1.0000000000000000001' }));
    expect(overrun.settlement).toMatchObject({ overrunMicros: 0, overrunMicrosExact: '0.0000000000000000001', suspend: true });
    expect((await store().reserve(request(s, { maximumCostMicros: 0 }))).decisions[0]?.reason).toBe('unreconciled-charge');
  });

  it('accounts for exact external liabilities and net window funding from the locked authority reader', async () => {
    const s = await tenant();
    const fractional: HostedBudgetContextReader = async (sql, input) => {
      const ctx = (await readContext(sql, input))!;
      return { ...ctx, limits: ctx.limits.map(limit => ({ ...limit, fundedMicros: 99_999,
        fundedMicrosExact: '99999.9', externalSpentMicros: 0, externalSpentMicrosExact: '0.1' })) };
    };
    const refused = await store(fractional).reserve(request(s, { maximumCostMicros: 100_000 }));
    expect(refused.decisions[0]).toMatchObject({ capMicros: 99_999, capMicrosExact: '99999.9', availableMicros: 99_999, availableMicrosExact: '99999.8' });
    expect((await store(fractional).reserve(request(s, { maximumCostMicros: 99_999 }))).outcome).toBe('reserved');
  });

  it('rejects invalid exact projections before changing immutable reservation history', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    for (const costMicrosExact of ['0.1', '40003.00', '40003e0', '-1', '9007199254740991.1']) {
      await expect(store().observe(observation(r, { costMicrosExact }))).rejects.toThrow(/budget/);
    }
    await expect(store().observe(observation(r, { costSource: 'unpriced', costMicros: null, costMicrosExact: '0.1', providerFinal: false })))
      .rejects.toThrow(/budget/);
    expect(await rows(s)).toHaveLength(1);
  });

  it('enforces lossless NUMERIC precision at the database boundary without changing integer provider maxima', async () => {
    const s = await tenant(); const r = request(s, { maximumCostMicros: 1 }); await store().reserve(r);
    const [column] = await db.adminSql`SELECT data_type, numeric_scale FROM information_schema.columns
      WHERE table_schema = 'papercusp_auth' AND table_name = 'hosted_budget_receipts' AND column_name = 'cost_micros'`;
    expect(column).toMatchObject({ data_type: 'numeric', numeric_scale: null });
    for (const exact of ['-0.1', '9007199254740991.1', '0.' + '0'.repeat(324) + '1']) {
      const change = { revision: 1, event_id: randomUUID(), cost_source: 'provider-billed', provider_final: true, cost_micros: exact };
      await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_receipts
        SELECT (jsonb_populate_record(NULL::papercusp_auth.hosted_budget_receipts, to_jsonb(row) || ${db.adminSql.json(change)})).*
        FROM papercusp_auth.hosted_budget_receipts row WHERE organization_id = ${s.organizationId}`)
        .rejects.toThrow(/check constraint/);
    }
    expect(await rows(s)).toHaveLength(1);
    const tiniest = '0.' + '0'.repeat(323) + '1';
    expect((await store().observe(observation(r, { costMicros: 0, costMicrosExact: tiniest }))).receipt?.costMicrosExact).toBe(tiniest);
    expect((await store().reserve(request(s, { maximumCostMicros: 100_000 }))).outcome).toBe('refused');
  });

  it('does not hide a final overrun, permit a downgrade, or erase exposure with a new budget key', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    const result = await store().observe(observation(r, { costMicros: 100_001 }));
    expect(result.settlement).toMatchObject({ chargedMicros: 100_001, overrunMicros: 1, suspend: true });
    const next = await store().reserve(request(s, { budgetKey: 'another.usd_cents', maximumCostMicros: 0 }));
    expect(next.outcome).toBe('refused');
    expect(next.decisions[0]?.reason).toBe('unreconciled-charge');
    await expect(store().observe(observation(r, { revision: 2, providerFinal: false }))).rejects.toThrow('downgrade');
    await expect(store().observe(observation(r, { revision: 2, costSource: 'estimate' }))).rejects.toThrow('downgrade');
  });

  it('serializes concurrent final-bill replays and corrections without double spend or lost revisions', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    const first = observation(r, { costMicros: 20_000 });
    const retries = await Promise.all(Array.from({ length: 8 }, () => store().observe(first)));
    expect(retries.filter(o => o.outcome === 'recorded')).toHaveLength(1);
    expect(retries.filter(o => o.outcome === 'duplicate')).toHaveLength(7);
    const corrections = await Promise.all([
      store().observe(observation(r, { revision: 2, observedAtMs: T + 2, costMicros: 40_000 })),
      store().observe(observation(r, { revision: 3, observedAtMs: T + 3, costMicros: 60_000 })),
    ]);
    expect(corrections.every(o => o.outcome === 'recorded' || o.outcome === 'stale')).toBe(true);
    const next = await store().reserve(request(s, { maximumCostMicros: 40_000 }));
    expect(next.outcome).toBe('reserved');
    expect(next.decisions[0]?.availableMicros).toBe(40_000);
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
  });

  it('keeps old-month unfinished work reserved in the next window', async () => {
    const s = await tenant(); const old = request(s, { month: '2026-09', asOfMs: Date.UTC(2026, 8, 2) });
    await store(readContext, service, () => old.asOfMs).reserve(old);
    expect((await store().reserve(request(s, { maximumCostMicros: 1 }))).outcome).toBe('refused');
  });

  it('applies workspace limits while sharing the organization cap across workspaces', async () => {
    const a = await tenant();
    // Preserve the directory's one-live-workspace invariant. Financial holds
    // survive retirement while its successor uses the same organization cap.
    await db.adminSql`UPDATE harness_shared.customer_workspaces SET state = 'deleted', deleted_at = now()
      WHERE workspace_id = ${a.controlWorkspaceId} AND id = ${a.customerWorkspaceId}`;
    const b = await tenant(a.controlWorkspaceId, a.organizationId);
    await db.adminSql`UPDATE papercusp_auth.test_budget_authority SET workspace_cap = 2 WHERE org = ${a.organizationId}`;
    expect((await store().reserve(request(a, { maximumCostMicros: 20_001 }))).outcome).toBe('refused');
    expect((await store().reserve(request(a, { maximumCostMicros: 20_000 }))).outcome).toBe('reserved');
    expect((await store().reserve(request(a, { maximumCostMicros: 1 }))).outcome).toBe('refused');
    expect((await store().reserve(request(b, { maximumCostMicros: 20_000 }))).outcome).toBe('reserved');
    await db.adminSql`UPDATE papercusp_auth.test_budget_authority SET workspace_cap = NULL WHERE org = ${a.organizationId}`;
    expect((await store().reserve(request(b, { maximumCostMicros: 60_000 }))).outcome).toBe('reserved');
  });

  it('separates overlapping reservation/event IDs in distinct organization/control scopes', async () => {
    const a = await tenant(); const b = await tenant(a.controlWorkspaceId); const c = await tenant(undefined, a.organizationId);
    const id = randomUUID();
    for (const s of [a, b, c]) expect((await store().reserve(request(s, { reservationId: id }))).outcome).toBe('reserved');
    const eventId = randomUUID();
    for (const s of [a, b, c]) expect((await store().observe(observation(request(s, { reservationId: id }), { eventId }))).outcome).toBe('recorded');
    const foreign = { ...a, customerWorkspaceId: b.customerWorkspaceId };
    expect((await store().observe(observation(request(foreign, { reservationId: id })))).outcome).toBe('unknown');
    expect((await store().reserve(request(foreign, { reservationId: id }))).receipt).toBeNull();
  });

  it('rolls back the admission receipt on transaction failure and permits a fresh retry', async () => {
    const s = await tenant(); const r = request(s);
    const crashing: HostedServiceContextRunner = fn => service(async sql => { await fn(sql); throw new Error('fixture crash before commit'); });
    await expect(store(readContext, crashing).reserve(r)).rejects.toThrow('before commit');
    expect(await rows(s)).toHaveLength(0);
    expect((await store().reserve(r)).outcome).toBe('reserved');
  });

  it('uses the same transaction lock as the DB guard before reading funding, and refuses reduced funding', async () => {
    const s = await tenant();
    const checking: HostedBudgetContextReader = async (sql, r) => {
      const held = await db.adminSql.begin(async other => {
        const [row] = await other`SELECT pg_try_advisory_xact_lock(hashtextextended(
          json_build_array('hosted-budget', ${s.controlWorkspaceId}::text, ${s.organizationId}::text)::text, 0)) AS granted`;
        return row?.granted;
      });
      expect(held).toBe(false);
      return readContext(sql, r);
    };
    await store(checking).reserve(request(s, { maximumCostMicros: 60_000 }));
    await db.adminSql`UPDATE papercusp_auth.test_budget_authority SET funding = 50000 WHERE org = ${s.organizationId}`;
    expect((await store().reserve(request(s, { maximumCostMicros: 0 }))).outcome).toBe('refused');
  });

  it('fails closed without authority, on scope/period mismatch, or on unbounded retained costs', async () => {
    const s = await tenant();
    expect((await new PostgresHostedBudgetStore({ run: service }).reserve(request(s))).outcome).toBe('refused');
    const bad: HostedBudgetContextReader = async (sql, r) => ({ ...(await readContext(sql, r))!, scope: { ...s, organizationId: randomUUID() } });
    await expect(store(bad).reserve(request(s))).rejects.toThrow('context mismatch');
    const period: HostedBudgetContextReader = async (sql, r) => { const ctx = (await readContext(sql, r))!;
      return { ...ctx, policy: { ...ctx.policy, effectiveUntilMs: ctx.policy.effectiveUntilMs + 1 } }; };
    await expect(store(period).reserve(request(s))).rejects.toThrow('context mismatch');
    await db.adminSql`UPDATE papercusp_auth.test_budget_authority SET retained = NULL WHERE org = ${s.organizationId}`;
    expect((await store().reserve(request(s))).outcome).toBe('refused');
    expect(await rows(s)).toHaveLength(0);
  });

  it('rejects replay conflicts, out-of-order/downgraded observations and event collisions', async () => {
    const s = await tenant(); const r = request(s, { maximumCostMicros: 50_000 }); await store().reserve(r);
    const o = observation(r, { revision: 3, costMicros: 20_000 }); await store().observe(o);
    expect((await store().observe({ ...o, costMicros: 20_001 })).outcome).toBe('conflict');
    expect((await store().observe(observation(r, { revision: 2 }))).outcome).toBe('stale');
    expect((await store().observe(observation(r, { revision: 3 }))).outcome).toBe('conflict');
    const other = request(s, { maximumCostMicros: 50_000 }); await store().reserve(other);
    expect((await store().observe(observation(other, { eventId: o.eventId }))).outcome).toBe('conflict');
    expect(await rows(s)).toHaveLength(3);
  });

  it('protects metadata-only, immutable history and exact composite directory bindings at the database boundary', async () => {
    const s = await tenant(); const r = request(s); await store().reserve(r);
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_budget_receipts SET maximum_cost_micros = 1
      WHERE organization_id = ${s.organizationId}`).rejects.toThrow('append-only');
    await expect(db.adminSql`DELETE FROM papercusp_auth.hosted_budget_receipts WHERE organization_id = ${s.organizationId}`).rejects.toThrow('append-only');
    await expect(db.appSql`SELECT * FROM papercusp_auth.hosted_budget_receipts`).rejects.toThrow(/permission denied/);
    const changed = { revision: 1, event_id: randomUUID(), maximum_cost_micros: 1 };
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_receipts
      SELECT (jsonb_populate_record(NULL::papercusp_auth.hosted_budget_receipts, to_jsonb(r) || ${db.adminSql.json(changed)})).*
      FROM papercusp_auth.hosted_budget_receipts r WHERE organization_id = ${s.organizationId}`).rejects.toThrow('history conflict');
    const unadmitted = { revision: 1, event_id: randomUUID(), reservation_id: randomUUID() };
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_receipts
      SELECT (jsonb_populate_record(NULL::papercusp_auth.hosted_budget_receipts, to_jsonb(r) || ${db.adminSql.json(unadmitted)})).*
      FROM papercusp_auth.hosted_budget_receipts r WHERE organization_id = ${s.organizationId}`).rejects.toThrow('needs an admission');
    await expect(store().reserve({ ...request(s), customerContent: 'private' } as HostedBudgetRequest)).rejects.toThrow('invalid budget request');
    const foreign = { ...s, customerWorkspaceId: randomUUID() };
    await expect(store().reserve(request(foreign, { maximumCostMicros: 0 }))).rejects.toThrow(/foreign key/);
    expect(await rows(s)).toHaveLength(1);
  });

  it('refuses allocation without an installed verifier or with foreign/stale/insolvent evidence', async () => {
    const r = prepaidRequest(await tenant());
    expect(await new PostgresHostedBudgetStore({ run: service }).allocatePrepaid(r))
      .toMatchObject({ outcome: 'refused', reason: 'unconfigured-funding' });
    for (const change of [
      (e: ReturnType<typeof prepaidEvidence>) => ({ ...e, snapshot: { ...e.snapshot, complete: false } }),
      (e: ReturnType<typeof prepaidEvidence>) => ({ ...e, snapshot: { ...e.snapshot, asOfMs: T - 1 } }),
      (e: ReturnType<typeof prepaidEvidence>) => ({ ...e, cashBacking: null }),
    ]) expect((await prepaidStore(async (_sql, q) => change(prepaidEvidence(q))).allocatePrepaid(r)).outcome).toBe('refused');
    await expect(prepaidStore(async (_sql, q) => ({ ...prepaidEvidence(q), scope: { ...q.scope, organizationId: randomUUID() } }))
      .allocatePrepaid(r)).rejects.toThrow('authority mismatch');
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(0);
  });

  it('accepts a fresh funding completion after the request and persists the server decision time', async () => {
    const r = prepaidRequest(await tenant()); let now = T + 10;
    const reader: HostedPrepaidFundingReader = async (_sql, q) => {
      expect(q.asOfMs).toBe(T + 10); expect(Object.isFrozen(q)).toBe(true);
      now = T + 20;
      return prepaidEvidence({ ...q, asOfMs: now });
    };
    expect((await prepaidStore(reader, service, () => now).allocatePrepaid(r)).outcome).toBe('allocated');
    const [saved] = await allocationRows(r.stripeAccountId);
    expect(Number(saved!.observed_at_ms)).toBe(T + 20);
  });

  it('refuses stale, future and backward-clock funding without persisting any allocation', async () => {
    for (const [observed, completed] of [[T - 1, T + 1], [T + 2, T + 1], [T, T - 1], [T, T + 60_001],
      [NaN, T + 1], [T, Infinity]]) {
      const r = prepaidRequest(await tenant()); let now = T;
      const reader: HostedPrepaidFundingReader = async (_sql, q) => {
        now = completed!; return prepaidEvidence({ ...q, asOfMs: observed! });
      };
      expect(await prepaidStore(reader, service, () => now).allocatePrepaid(r))
        .toMatchObject({ outcome: 'refused', reason: 'unverified-time', allocation: null });
      expect(await allocationRows(r.stripeAccountId)).toHaveLength(0);
    }
  });

  it('checks both allocation window and reservation policy at completion across a month boundary', async () => {
    const end = shadowMonthBounds('2026-10').endMs;
    const r = prepaidRequest(await tenant()); let now = end - 1;
    const funding: HostedPrepaidFundingReader = async (_sql, q) => {
      now = end; return prepaidEvidence({ ...q, asOfMs: end });
    };
    expect(await prepaidStore(funding, service, () => now).allocatePrepaid(r))
      .toMatchObject({ outcome: 'refused', reason: 'inactive-window' });
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(0);
    now = end - 1;
    const context: HostedBudgetContextReader = async (sql, q) => {
      const c = (await readContext(sql, q))!; now = end; return { ...c, asOfMs: end };
    };
    const result = await store(context, service, () => now).reserve(request(r.scope));
    expect(result.outcome).toBe('refused'); expect(result.decisions[0]?.reason).toBe('inactive-policy');
    expect(await rows(r.scope)).toHaveLength(0);
  });

  it('uses the server clock for reservation context and blocks stale/future/regressed authority', async () => {
    const s = await tenant(); let now = T + 10;
    const fresh: HostedBudgetContextReader = async (sql, q) => {
      expect(q.asOfMs).toBe(T + 10); now = T + 20;
      return { ...(await readContext(sql, q))!, asOfMs: now };
    };
    const admitted = await store(fresh, service, () => now).reserve(request(s));
    expect(admitted.outcome).toBe('reserved'); expect(admitted.receipt?.observedAtMs).toBe(T + 20);
    for (const [observed, completed] of [[T - 1, T + 1], [T + 2, T + 1], [T, T - 1], [T, T + 60_001],
      [NaN, T + 1], [T, Infinity]]) {
      const other = await tenant(); now = T;
      const reader: HostedBudgetContextReader = async (sql, q) => {
        const c = (await readContext(sql, q))!; now = completed!; return { ...c, asOfMs: observed! };
      };
      expect(await store(reader, service, () => now).executeOnce(request(other), async () => { throw new Error('must not dispatch'); }))
        .toMatchObject({ execution: 'not-started', reservation: { outcome: 'refused', reason: 'unverified-time' } });
      expect(await rows(other)).toHaveLength(0);
    }
  });

  it('refuses future requests and invalid start clocks before invoking an authority reader', async () => {
    const r = prepaidRequest(await tenant()); let calls = 0;
    const funding: HostedPrepaidFundingReader = async (_sql, q) => { calls++; return prepaidEvidence(q); };
    const context: HostedBudgetContextReader = async (sql, q) => { calls++; return readContext(sql, q); };
    for (const clock of [T - 1, NaN, Infinity]) {
      expect((await prepaidStore(funding, service, () => clock).allocatePrepaid(r)).outcome).toBe('refused');
      expect((await store(context, service, () => clock).reserve(request(r.scope))).outcome).toBe('refused');
    }
    expect(calls).toBe(0); expect(await allocationRows(r.stripeAccountId)).toHaveLength(0);
    expect(await rows(r.scope)).toHaveLength(0);
  });

  it('serializes concurrent exact partitions across instances and every budget key', async () => {
    const r = prepaidRequest(await tenant());
    const outcomes = await Promise.all(Array.from({ length: 16 }, (_, i) => prepaidStore().allocatePrepaid({ ...r,
      allocation: { ...r.allocation, allocationId: randomUUID(), budgetKey: i % 2 ? 'storage.usd_cents' : r.allocation.budgetKey } })));
    expect(outcomes.filter(o => o.outcome === 'allocated')).toHaveLength(10);
    expect(outcomes.filter(o => o.outcome === 'refused' && o.reason === 'funding-overallocated')).toHaveLength(6);
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(10);
  });

  it('keeps fractional partitions lossless through replay/restart and refuses the smallest excess', async () => {
    const r = prepaidRequest(await tenant());
    const precise = { ...r, allocation: { ...r.allocation, micros: 9_999, microsExact: '9999.9999999999999999999' } };
    const oneCent: HostedPrepaidFundingReader = async (_sql, q) => prepaidEvidence(q, 1);
    expect((await prepaidStore(oneCent).allocatePrepaid(precise)).outcome).toBe('allocated');
    expect(await prepaidStore(oneCent).allocatePrepaid(precise)).toMatchObject({ outcome: 'duplicate', allocation: precise.allocation });
    expect(await prepaidStore(oneCent).allocatePrepaid({ ...precise, allocation: { ...precise.allocation,
      microsExact: '9999.9999999999999999998' } })).toMatchObject({ outcome: 'conflict', allocation: null });
    const extra = { ...r, allocation: { ...r.allocation, allocationId: randomUUID(), micros: 0, microsExact: '0.0000000000000000002' } };
    expect(await prepaidStore(oneCent).allocatePrepaid(extra)).toMatchObject({ outcome: 'refused', reason: 'funding-overallocated' });
    const [saved] = await allocationRows(r.stripeAccountId);
    expect(String(saved!.micros)).toBe(precise.allocation.microsExact);
  });

  it('retains other organizations in the global population and refuses reuse of their payment', async () => {
    const a = await tenant(); const b = await tenant(a.controlWorkspaceId);
    const r = prepaidRequest(a);
    expect((await prepaidStore().allocatePrepaid(r)).outcome).toBe('allocated');
    const foreign = { ...prepaidRequest(b, r.stripeAccountId), allocation: { ...r.allocation, allocationId: randomUUID(),
      organizationId: b.organizationId, customerWorkspaceId: b.customerWorkspaceId } };
    expect(await prepaidStore().allocatePrepaid(foreign)).toMatchObject({ outcome: 'refused', reason: 'funding-scope-mismatch' });
    expect(await prepaidStore().allocatePrepaid({ ...foreign, allocation: { ...foreign.allocation, allocationId: r.allocation.allocationId } }))
      .toMatchObject({ outcome: 'conflict', allocation: null });
    const ownPayment = { ...foreign, allocation: { ...foreign.allocation, paymentTransactionId: 'txn_other' } };
    const fullPool: HostedPrepaidFundingReader = async (_sql, q) => {
      const e = prepaidEvidence(q); const other = prepaidEvidence(r);
      return { ...e, cashBacking: { ...e.cashBacking!, availableMicros: 2_000_000,
        journalEntries: [...e.cashBacking!.journalEntries, ...other.cashBacking!.journalEntries] } };
    };
    expect((await prepaidStore(fullPool).allocatePrepaid(ownPayment)).outcome).toBe('allocated');
    await service(async sql => { const all = await readLockedHostedPrepaidAllocations(sql,
      { controlWorkspaceId: a.controlWorkspaceId, stripeAccountId: r.stripeAccountId });
      expect(all).toHaveLength(2); expect(Object.isFrozen(all)).toBe(true); expect(all.every(Object.isFrozen)).toBe(true); });
  });

  it('locks even an empty pool before collecting source evidence, with the identical database writer key', async () => {
    const r = prepaidRequest(await tenant());
    const reader: HostedPrepaidFundingReader = async (_sql, q) => {
      const held = await db.adminSql.begin(async other => {
        const [row] = await other`SELECT pg_try_advisory_xact_lock(hashtextextended(
          json_build_array('hosted-prepaid', ${q.stripeAccountId}::text)::text, 0)) AS granted`;
        return row?.granted;
      });
      expect(held).toBe(false);
      expect(await allocationRows(q.stripeAccountId)).toHaveLength(0);
      return prepaidEvidence(q);
    };
    expect((await prepaidStore(reader).allocatePrepaid(r)).outcome).toBe('allocated');
  });

  it('reads funding and writes a reservation under the same pool lock and transaction', async () => {
    const s = await tenant(); const r = prepaidRequest(s);
    expect((await prepaidStore().allocatePrepaid(r)).outcome).toBe('allocated');
    const context: HostedBudgetContextReader = async (sql, q) => {
      const funding = await evaluateLockedHostedPrepaidFunding(sql, prepaidEvidence(r));
      if (!funding.ok) return null;
      const [lock] = await db.adminSql.begin(other => other`SELECT pg_try_advisory_xact_lock(hashtextextended(
        json_build_array('hosted-prepaid', ${r.stripeAccountId}::text)::text, 0)) AS granted`);
      expect(lock?.granted).toBe(false);
      expect(await rows(s)).toHaveLength(0);
      const c = (await readContext(sql, q))!;
      return { ...c, limits: c.limits.map(l => ({ ...l, ...funding.organization })) };
    };
    const crashing: HostedServiceContextRunner = fn => service(async sql => { await fn(sql); throw new Error('atomic reservation rollback'); });
    await expect(store(context, crashing).reserve(request(s))).rejects.toThrow('atomic reservation rollback');
    expect(await rows(s)).toHaveLength(0);
    expect((await store(context).reserve(request(s))).outcome).toBe('reserved');
    expect(await rows(s)).toHaveLength(1);
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(1);
  });

  it('never accepts a caller replacement population or hides a formerly allocated payment after a reversal', async () => {
    const r = prepaidRequest(await tenant());
    const all = { ...r, allocation: { ...r.allocation, micros: 1_000_000, customerWorkspaceId: null } };
    expect((await prepaidStore().allocatePrepaid(all)).outcome).toBe('allocated');
    await service(async sql => {
      const e = prepaidEvidence(r);
      const transaction = { id: 'txn_refund', amount: -50, fee: 0, currency: 'usd', created: T / 1000 };
      const built = journalEntryForMovement({ entryId: 'stripe-bt:txn_refund', occurredAtMs: T, currency: 'USD',
        externalRef: { kind: 'stripe-balance-transaction', id: transaction.id },
        movement: { kind: 'refund', amountCents: 50, taxCents: 0 } });
      if (!built.ok) throw new Error(built.detail);
      const salt = 'b'.repeat(64);
      const refunded = { ...e, reversals: [{ entry: built.entry, paymentTransactionId: r.allocation.paymentTransactionId,
        receipt: { transaction, receiptSeq: 2, salt, commitment: receiptCommitment(transaction, salt), sourceId: 're_fixture', sourceCustomer: 'cus_A' } }],
        cashBacking: { ...e.cashBacking!, availableMicros: 500_000, journalEntries: [...e.cashBacking!.journalEntries, built.entry] } };
      expect(await evaluateLockedHostedPrepaidFunding(sql, { ...refunded, allocations: [] } as typeof refunded))
        .toMatchObject({ ok: false, reason: 'funding-overallocated' });
    });
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(1);
  });

  it('rolls back allocations atomically and snapshots mutable requests before waiting for authority', async () => {
    const r = prepaidRequest(await tenant()); const original = structuredClone(r);
    const crashing: HostedServiceContextRunner = fn => service(async sql => { await fn(sql); throw new Error('allocation rollback'); });
    await expect(prepaidStore(undefined, crashing).allocatePrepaid(r)).rejects.toThrow('allocation rollback');
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(0);
    const mutating: HostedPrepaidFundingReader = async (_sql, q) => {
      Object.assign(r.allocation, { micros: 1, paymentTransactionId: 'txn_changed' });
      Object.assign(r.scope, { customerWorkspaceId: randomUUID() });
      return prepaidEvidence(q);
    };
    expect(await prepaidStore(mutating).allocatePrepaid(r)).toMatchObject({ outcome: 'allocated', allocation: original.allocation });
    expect(await allocationRows(original.stripeAccountId)).toHaveLength(1);
  });

  it('enforces service-only immutable exact partitions and global account/organization scope at the SQL boundary', async () => {
    const s = await tenant(); const r = prepaidRequest(s); await prepaidStore().allocatePrepaid(r);
    await expect(db.appSql`SELECT * FROM papercusp_auth.hosted_prepaid_allocations`).rejects.toThrow(/permission denied/);
    await expect(service(sql => sql`UPDATE papercusp_auth.hosted_prepaid_allocations SET micros = 1`)).rejects.toThrow(/permission denied/);
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_prepaid_allocations SET micros = 1 WHERE stripe_account_id = ${r.stripeAccountId}`)
      .rejects.toThrow('append-only');
    await expect(db.adminSql`DELETE FROM papercusp_auth.hosted_prepaid_allocations WHERE stripe_account_id = ${r.stripeAccountId}`)
      .rejects.toThrow('append-only');
    const other = await tenant(s.controlWorkspaceId);
    for (const change of [
      { allocation_id: randomUUID(), organization_id: other.organizationId, customer_workspace_id: other.customerWorkspaceId },
      { allocation_id: randomUUID(), control_workspace_id: randomUUID() },
      { allocation_id: randomUUID(), micros: '0.' + '0'.repeat(324) + '1', payment_transaction_id: 'txn_precision' },
      { allocation_id: randomUUID(), customer_workspace_id: null, binding_customer_workspace_id: randomUUID(), payment_transaction_id: 'txn_unbound' },
    ]) await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_prepaid_allocations
      SELECT (jsonb_populate_record(NULL::papercusp_auth.hosted_prepaid_allocations, to_jsonb(a) || ${db.adminSql.json(change)})).*
      FROM papercusp_auth.hosted_prepaid_allocations a WHERE stripe_account_id = ${r.stripeAccountId}`).rejects.toThrow();
    const unbound = { ...r, stripeAccountId: 'acct_' + randomUUID().replaceAll('-', ''), scope: { ...s, customerWorkspaceId: randomUUID() },
      allocation: { ...r.allocation, customerWorkspaceId: null } };
    await expect(prepaidStore().allocatePrepaid(unbound)).rejects.toThrow(/foreign key/);
    expect(await allocationRows(r.stripeAccountId)).toHaveLength(1);
  });

  it('reads an empty local funding population without manufacturing backing or admission authority', async () => {
    const population = await service(sql => readLockedHostedStripeFundingPopulation(sql, populationInput));
    expect(population).toEqual({ allocations: [], entries: [], receipts: [], customers: [] });
    expect(Object.isFrozen(population)).toBe(true);
    expect('cashBacking' in population).toBe(false);
  });

  it('selects the persisted customer in the same transaction and authenticates the configured account', async () => {
    await withStripeBinding(async (sql, s) => {
      // The uncommitted binding is visible only through this exact Sql.
      expect(await db.adminSql`SELECT 1 FROM papercusp_auth.hosted_billing_customers
        WHERE organization_id = ${s.organizationId}::uuid`).toHaveLength(0);
      const transport = emptyStripeTransport(s.organizationId);
      const configuration = stripeFundingConfiguration();
      const built = createLockedHostedStripeFundingReader(configuration,
        { secretKey: 'sk_live_fixture', liveModeAllowed: true, fetchImpl: transport.fetchImpl });
      if (!built.ok) throw new Error('fixture');
      // Mutating the original configuration cannot redirect the pinned reader.
      configuration.pool.stripeAccountId = 'acct_Mutated'; configuration.journalWorkspaceId = 'mutated-workspace';
      const result = await built.read(sql, s);
      expect(result).toMatchObject({ ok: true, snapshot: { stripeAccountId: populationInput.pool.stripeAccountId,
        stripeCustomerId: 'cus_ServerBinding', organizationId: s.organizationId, livemode: true },
      payments: [], reversals: [], allocations: [], entries: [] });
      expect(transport.calls).toContain('/v1/customers/cus_ServerBinding');
      expect('cashBacking' in result).toBe(false);
      expect('limits' in result).toBe(false);
      // Successful remote collection does not release any of the source locks.
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await tx`UPDATE harness_shared.payment_receipts SET workspace_id = workspace_id WHERE false`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
  });

  it.each(['account', 'organization'] as const)('refuses authenticated %s mismatch before using the remote population', async mismatch => {
    await withStripeBinding(async (sql, s) => {
      const transport = emptyStripeTransport(mismatch === 'organization' ? randomUUID() : s.organizationId,
        mismatch === 'account' ? 'acct_OtherCredential' : populationInput.pool.stripeAccountId);
      const built = createLockedHostedStripeFundingReader(stripeFundingConfiguration(),
        { secretKey: 'sk_live_fixture', liveModeAllowed: true, fetchImpl: transport.fetchImpl });
      if (!built.ok) throw new Error('fixture');
      expect(await built.read(sql, s)).toEqual({ ok: false, reason: 'unverified-stripe-read' });
      expect(transport.calls).toEqual(mismatch === 'account' ? ['/v1/account']
        : ['/v1/account', '/v1/customers/cus_ServerBinding']);
    });
  });

  it.each(['missing', 'test'] as const)('refuses a %s stored target binding without contacting Stripe', async binding => {
    await withStripeBinding(async (sql, s) => {
      const transport = emptyStripeTransport(s.organizationId);
      const built = createLockedHostedStripeFundingReader(stripeFundingConfiguration(),
        { secretKey: 'sk_live_fixture', liveModeAllowed: true, fetchImpl: transport.fetchImpl });
      if (!built.ok) throw new Error('fixture');
      expect(await built.read(sql, binding === 'missing' ? { ...s, organizationId: randomUUID() } : s))
        .toEqual({ ok: false, reason: 'unverified-stripe-read' });
      expect(transport.calls).toEqual([]);
    }, binding !== 'test');
  });

  it('keeps other customer modes actual and refuses an unverified mixed pool', async () => {
    await withStripeBinding(async (sql, s) => {
      await sql`INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
        VALUES (${randomUUID()}::uuid, 'cus_OtherTestCustomer', false)`;
      const transport = emptyStripeTransport(s.organizationId);
      const built = createLockedHostedStripeFundingReader(stripeFundingConfiguration(),
        { secretKey: 'sk_live_fixture', liveModeAllowed: true, fetchImpl: transport.fetchImpl });
      if (!built.ok) throw new Error('fixture');
      expect(await built.read(sql, s)).toEqual({ ok: false, reason: 'unverified-stripe-read' });
      expect(transport.calls).toEqual([]);
    });
  });

  it('refuses a different control workspace and prior cancellation before taking SQL locks', async () => {
    const transport = emptyStripeTransport('unused');
    const built = createLockedHostedStripeFundingReader(stripeFundingConfiguration(),
      { secretKey: 'sk_live_fixture', liveModeAllowed: true, fetchImpl: transport.fetchImpl });
    if (!built.ok) throw new Error('fixture');
    const s = { controlWorkspaceId: 'different-control', organizationId: randomUUID(), customerWorkspaceId: 'fixture-workspace' };
    // Autocommit would fail the population reader; these refuse BEFORE that read.
    expect(await built.read(db.adminSql, s)).toEqual({ ok: false, reason: 'unverified-stripe-read' });
    expect(await built.read(db.adminSql, { ...s, controlWorkspaceId: populationInput.pool.controlWorkspaceId }, AbortSignal.abort()))
      .toEqual({ ok: false, reason: 'unverified-stripe-read' });
    expect(transport.calls).toEqual([]);
  });

  it.each([{ secretKey: 'sk_test_fixture', liveModeAllowed: true },
    { secretKey: 'sk_live_fixture', liveModeAllowed: false },
    { secretKey: 'invalid', liveModeAllowed: true }])('never installs a source reader from $secretKey with live allowed $liveModeAllowed', dependencies => {
    expect(createLockedHostedStripeFundingReader(stripeFundingConfiguration(), dependencies))
      .toEqual({ ok: false, reason: 'unverified-stripe-read' });
  });

  it.each([0, 10_001, Number.POSITIVE_INFINITY])('cannot disable or extend the collection deadline to %s', maximumDurationMs => {
    expect(() => createLockedHostedStripeFundingReader(stripeFundingConfiguration(),
      { secretKey: 'sk_live_fixture', liveModeAllowed: true, maximumDurationMs })).toThrow('invalid locked Stripe funding configuration');
  });

  it('keeps source locks until cancelled Stripe I/O settles and releases them on reservation rollback', async () => {
    const org = randomUUID();
    const parent = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    let transportActive = false;
    const fetchImpl: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error('missing transport cancellation');
      signal.throwIfAborted();
      transportActive = true;
      signal.addEventListener('abort', () => { transportActive = false; reject(new Error('private cancellation')); }, { once: true });
      started();
    });
    const built = createLockedHostedStripeFundingReader(stripeFundingConfiguration(),
      { secretKey: 'sk_live_fixture', fetchImpl, liveModeAllowed: true, now: () => T });
    if (!built.ok) throw new Error('fixture');
    await expect(service(async sql => {
      await sql`INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
        VALUES (${org}::uuid, 'cus_CancelledPopulation', true)`;
      const pending = built.read(sql, { controlWorkspaceId: populationInput.pool.controlWorkspaceId,
        organizationId: org, customerWorkspaceId: 'fixture-cancelled-workspace' }, parent.signal);
      try {
        await requestStarted;
        expect(transportActive).toBe(true);
        await expect(db.adminSql.begin(async tx => {
          await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
          await tx`UPDATE harness_shared.payment_receipts SET workspace_id = workspace_id WHERE false`;
        })).rejects.toMatchObject({ code: '55P03' });
      } finally {
        parent.abort();
        expect(await pending).toEqual({ ok: false, reason: 'unverified-stripe-read' });
      }
      expect(transportActive).toBe(false);
      throw new Error('cancelled reservation rollback');
    })).rejects.toThrow('cancelled reservation rollback');
    // The real transaction has ended; a writer can take each population lock.
    await db.adminSql.begin(async tx => {
      await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
      for (const table of ['harness_shared.money_journal_entries', 'harness_shared.money_journal_lines',
        'harness_shared.payment_receipts', 'papercusp_auth.hosted_billing_customers']) {
        const column = table === 'papercusp_auth.hosted_billing_customers' ? 'livemode' : 'workspace_id';
        await tx.unsafe(`UPDATE ${table} SET ${column} = ${column} WHERE false`);
      }
    });
    expect(await service(sql => sql`SELECT stripe_customer_id FROM papercusp_auth.hosted_billing_customers
      WHERE organization_id = ${org}::uuid`)).toHaveLength(0);
  });

  it('locks every source relation even when empty, permits concurrent readers and releases on commit', async () => {
    const tables = ['harness_shared.money_journal_entries', 'harness_shared.money_journal_lines',
      'harness_shared.payment_receipts', 'papercusp_auth.hosted_billing_customers'];
    await withPopulationHeld(async () => {
      // Any SQL writer needs RowExclusiveLock, even a zero-row UPDATE. This
      // distinguishes a real population lock from locking only existing rows.
      for (const table of tables) await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        const column = table === 'papercusp_auth.hosted_billing_customers' ? 'livemode' : 'workspace_id';
        await tx.unsafe(`UPDATE ${table} SET ${column} = ${column} WHERE false`);
      })).rejects.toMatchObject({ code: '55P03' });
      // A different account may read the same source tables concurrently;
      // account allocations still serialize only under their account key.
      await service(async sql => {
        await sql.unsafe("SET LOCAL lock_timeout = '100ms'");
        expect(await readLockedHostedStripeFundingPopulation(sql, { ...populationInput,
          pool: { ...populationInput.pool, stripeAccountId: 'acct_AnotherReader' } })).toMatchObject({ entries: [], receipts: [] });
      });
    });
    await db.adminSql`INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
      VALUES (${randomUUID()}::uuid, 'cus_PopulationA', true)`;
  });

  it('serializes real journal and receipt writers and keeps every customer binding in the local census', async () => {
    const entry = populationEntry('txn_PopulationA'); const receipt = populationReceipt('txn_PopulationA');
    await withPopulationHeld(async () => {
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await pgPaymentReceiptStore(tx as unknown as Sql).insertMissing(populationInput.journalWorkspaceId, [receipt]);
      })).rejects.toMatchObject({ code: '55P03' });
      await expect(postMoneyJournalEntry({ workspaceId: populationInput.journalWorkspaceId, entry }, {
        // The production writer runs its real SQL transaction; this wrapper
        // adds only a bounded lock wait before its first query.
        sql: { begin: (fn: (tx: Sql) => Promise<unknown>) => db.adminSql.begin(async tx => {
          await tx.unsafe("SET LOCAL lock_timeout = '100ms'"); return fn(tx as unknown as Sql);
        }) } as unknown as Sql, ledgerChain: null,
      })).rejects.toMatchObject({ code: '55P03' });
    });
    expect(await postMoneyJournalEntry({ workspaceId: populationInput.journalWorkspaceId, entry },
      { sql: db.adminSql, ledgerChain: null })).toMatchObject({ ok: true, duplicate: false });
    expect(await pgPaymentReceiptStore(db.adminSql).insertMissing(populationInput.journalWorkspaceId, [receipt])).toBe(1);
    const otherOrg = randomUUID();
    await db.adminSql`INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
      VALUES (${otherOrg}::uuid, 'cus_PopulationB', false)`;
    const population = await service(sql => readLockedHostedStripeFundingPopulation(sql, populationInput));
    expect(population.entries).toEqual([entry]);
    expect(population.receipts).toEqual([{ ...receipt, receiptSeq: population.receipts[0]!.receiptSeq }]);
    expect(population.customers.map(c => c.stripeCustomerId)).toEqual(['cus_PopulationA', 'cus_PopulationB']);
    expect(population.customers.find(c => c.stripeCustomerId === 'cus_PopulationB'))
      .toEqual({ organizationId: otherOrg, stripeCustomerId: 'cus_PopulationB', livemode: false });
  });

  it('uses the supplied transaction for bindings and releases the population on rollback', async () => {
    const org = randomUUID();
    await expect(service(async sql => {
      await sql`INSERT INTO papercusp_auth.hosted_billing_customers (organization_id, stripe_customer_id, livemode)
        VALUES (${org}::uuid, 'cus_PopulationRollback', true)`;
      const population = await readLockedHostedStripeFundingPopulation(sql, populationInput);
      expect(population.customers.some(c => c.organizationId === org)).toBe(true);
      throw new Error('population rollback');
    })).rejects.toThrow('population rollback');
    expect(await service(sql => sql`SELECT organization_id FROM papercusp_auth.hosted_billing_customers
      WHERE organization_id = ${org}::uuid`)).toHaveLength(0);
    await withPopulationHeld(async () => {
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await pgPaymentReceiptStore(tx as unknown as Sql).insertMissing(populationInput.journalWorkspaceId, [populationReceipt('txn_AfterRollback')]);
      })).rejects.toMatchObject({ code: '55P03' });
    }, true);
    expect(await pgPaymentReceiptStore(db.adminSql).insertMissing(populationInput.journalWorkspaceId, [populationReceipt('txn_AfterRollback')])).toBe(1);
  });

  it('refuses other-workspace receipts instead of silently omitting a competing cash-pool partition', async () => {
    await expect(db.adminSql.begin(async tx => {
      await pgPaymentReceiptStore(tx as unknown as Sql).insertMissing('fixture-unmapped-workspace', [populationReceipt('txn_Unmapped')]);
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      await readLockedHostedStripeFundingPopulation(tx as unknown as Sql, populationInput);
    })).rejects.toThrow('unmapped funding journal workspace');
  });

  it('refuses other-workspace journal entries even when its receipt is absent', async () => {
    await expect(db.adminSql.begin(async tx => {
      const e = populationEntry('txn_UnmappedJournal');
      await tx`INSERT INTO harness_shared.money_journal_entries
        (workspace_id, entry_id, occurred_at, currency, movement, external_ref_kind, external_ref, rollup_id, memo)
        VALUES ('fixture-unmapped-journal', ${e.entryId}, ${new Date(e.occurredAtMs)}, ${e.currency}, ${e.movement},
          ${e.externalRef.kind}, 'txn_UnmappedJournal', ${e.rollupId}, ${e.memo})`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      await readLockedHostedStripeFundingPopulation(tx as unknown as Sql, populationInput);
    })).rejects.toThrow('unmapped funding journal workspace');
  });

  it('keeps the bridge service-only and grants no financial writes or customer directory access', async () => {
    await expect(db.appSql`SELECT papercusp_auth.lock_hosted_stripe_funding_population()`).rejects.toThrow(/permission denied/);
    await expect(service(sql => sql`SELECT * FROM harness_shared.customer_workspaces`)).rejects.toThrow(/permission denied/);
    for (const table of ['harness_shared.money_journal_entries', 'harness_shared.money_journal_lines', 'harness_shared.payment_receipts']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const [row] = await db.adminSql`SELECT has_table_privilege('hosted_service', ${table}, ${privilege}) AS allowed`;
        expect(row!.allowed).toBe(false);
      }
    }
    await expect(db.appSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_app');
      await tx`SELECT salt FROM harness_shared.payment_receipts`;
    })).rejects.toThrow(/permission denied/);
    const [role] = await service(sql => sql`SELECT current_user AS role`);
    expect(role!.role).toBe('hosted_service');
  });

  it('refuses stale-snapshot isolation in both the reader and the fixed SQL lock bridge', async () => {
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
      await expect(db.appSql.begin(async tx => {
        await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        await readLockedHostedStripeFundingPopulation(tx as unknown as Sql, populationInput);
      })).rejects.toThrow('funding population requires read committed');
      await expect(db.appSql.begin(async tx => {
        await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        await tx`SELECT papercusp_auth.lock_hosted_stripe_funding_population()`;
      })).rejects.toThrow('funding population requires read committed');
    }
  });

  it('refuses a pool autocommit client whose locks were released between reads', async () => {
    await expect(readLockedHostedStripeFundingPopulation(db.adminSql, populationInput))
      .rejects.toThrow('funding population requires one transaction');
  });
});
