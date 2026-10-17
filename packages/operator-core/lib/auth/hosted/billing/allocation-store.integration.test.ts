/** Real Postgres/roles/transactions for enterprise budget allocations and pilot
 * outcome cost (enterprise readiness P-009, WI-10007904). Figures are
 * engineering inputs on the ASSUMED enterprise profile (A-8 finite funded
 * allowance, A-9 internal-simulation evidence), never buyer facts. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { hostedBillingAllocationAdmin, hostedBillingAllocationSource } from '../../../endpoint-route/hosted-billing-runtime';
import { HOSTED_COST_CLASSES, PostgresHostedAllocationStore, type HostedAllocationHoldRequest,
  type HostedAllocationLevel, type HostedAllocationOrganization, type HostedAllocationRequest,
  type HostedAllocationSettlement, type HostedCostClass, type HostedOutcomeRecordRequest } from './allocation-store';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
let db: OrgTestDb;
const T = Date.UTC(2026, 9, 2);
const MONTH = '2026-10';
const service: HostedServiceContextRunner = <R>(fn: (sql: Sql) => Promise<R>) => db.appSql.begin(async tx => {
  await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
  await tx.unsafe('SET LOCAL ROLE hosted_service');
  return fn(tx as unknown as Sql);
}) as Promise<R>;
const store = new PostgresHostedAllocationStore({ run: service });
// The fixture's app pool holds 2 connections, which serializes "concurrent"
// writers by accident. Races get their own wide pool plus a start barrier: every
// transaction opens and reaches the barrier before ANY of them reads, so a
// writer that skips the organization fence over-admits deterministically.
let wide: postgres.Sql;
function racing(n: number): PostgresHostedAllocationStore {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run: HostedServiceContextRunner = <R>(fn: (sql: Sql) => Promise<R>) => wide.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    arrived += 1;
    if (arrived >= n) release();
    await gate;
    return fn(tx as unknown as Sql);
  }) as Promise<R>;
  return new PostgresHostedAllocationStore({ run });
}

const org = (): HostedAllocationOrganization => ({ controlWorkspaceId: randomUUID(), organizationId: randomUUID() });
const node = (o: HostedAllocationOrganization, allocationId: string, parentAllocationId: string | null,
  level: HostedAllocationLevel, capMicros: number, maxUnreconciledMicros = capMicros,
  costClass: HostedCostClass = 'model'): HostedAllocationRequest => ({
  organization: o, allocationId, parentAllocationId, level, costClass, month: MONTH, capMicros, maxUnreconciledMicros,
  evidenceRef: 'assumption:A-8', recordedBy: 'fixture',
});
const hold = (o: HostedAllocationOrganization, allocationId: string, maximumCostMicros: number,
  change: Partial<HostedAllocationHoldRequest> = {}): HostedAllocationHoldRequest => ({
  organization: o, reservationId: 'res-' + randomUUID(), allocationId, costClass: 'model', month: MONTH,
  maximumCostMicros, observedAtMs: T, evidenceRef: 'fixture:enforced-limit', ...change,
});
async function define(r: HostedAllocationRequest) {
  const out = await store.define(r);
  if (out.outcome !== 'created' && out.outcome !== 'revised') {
    throw new Error(`fixture define ${r.allocationId}: ${out.outcome} ${'reason' in out ? out.reason : ''}`);
  }
  return out.allocation;
}
/** organization -> department -> two projects, in one cost class. */
async function smallTree(o: HostedAllocationOrganization, opts: { deptCap?: number; deptUnreconciled?: number;
    projectCap?: number; projectUnreconciled?: number; costClass?: HostedCostClass; prefix?: string } = {}) {
  const { deptCap = 1_000_000, projectCap = 500_000, costClass = 'model', prefix = '' } = opts;
  await define(node(o, `${prefix}org`, null, 'organization', 10_000_000, 10_000_000, costClass));
  await define(node(o, `${prefix}dept`, `${prefix}org`, 'department', deptCap, opts.deptUnreconciled ?? deptCap, costClass));
  for (const p of ['proj-a', 'proj-b']) {
    await define(node(o, `${prefix}${p}`, `${prefix}dept`, 'project', projectCap, opts.projectUnreconciled ?? projectCap, costClass));
  }
}
const report = (o: HostedAllocationOrganization) => store.report({ organization: o, month: MONTH });
const position = async (o: HostedAllocationOrganization, allocationId: string, costClass: HostedCostClass = 'model') =>
  (await report(o)).byCostClass[costClass].allocations.find(a => a.allocationId === allocationId);
const count = async (table: string, o: HostedAllocationOrganization) => Number((await db.adminSql.unsafe(
  `SELECT count(*)::int AS n FROM papercusp_auth.${table} WHERE control_workspace_id = $1 AND organization_id = $2`,
  [o.controlWorkspaceId, o.organizationId]))[0]!.n);

describe('PostgresHostedAllocationStore (real hosted service transactions)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    const draft = new URL('../../../../../../libs/papercusp/libs/db/sql/1495-hosted-budget-allocations.sql.DRAFT', import.meta.url);
    const armed = new URL('../../../../../../libs/papercusp/libs/db/sql/1495-hosted-budget-allocations.sql', import.meta.url);
    let migration: string;
    try { migration = readFileSync(draft, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; migration = readFileSync(armed, 'utf8'); }
    // Twice: the migration must be replay-safe.
    await db.adminSql.unsafe(migration); await db.adminSql.unsafe(migration);
    wide = postgres(db.appDsn, { max: 16, prepare: false, onnotice: () => {} });
  }, 180_000);
  afterAll(async () => { await wide?.end(); await db?.cleanup(); });

  it('keeps children within their parent and refuses malformed trees without writing', async () => {
    const o = org();
    expect((await store.define(node(o, 'org', null, 'organization', 1_000_000))).outcome).toBe('created');
    expect(await store.define(node(o, 'org-2', null, 'organization', 1))).toMatchObject({ outcome: 'refused', reason: 'organization-root-exists' });
    expect(await store.define(node(o, 'p', 'org', 'project', 1))).toMatchObject({ outcome: 'refused', reason: 'level-order' });
    expect(await store.define(node(o, 'd', 'missing', 'department', 1))).toMatchObject({ outcome: 'refused', reason: 'parent-missing' });
    expect((await store.define(node(o, 'd1', 'org', 'department', 600_000))).outcome).toBe('created');
    expect(await store.define(node(o, 'd2', 'org', 'department', 400_001))).toMatchObject({ outcome: 'refused', reason: 'children-exceed-parent' });
    expect((await store.define(node(o, 'd2', 'org', 'department', 400_000))).outcome).toBe('created');
    expect((await store.define(node(o, 'd2', 'org', 'department', 400_000))).outcome).toBe('duplicate');
    expect(await store.define({ ...node(o, 'd2', 'org', 'department', 400_000), costClass: 'hosting' }))
      .toMatchObject({ outcome: 'conflict', reason: 'immutable-allocation-fields' });
    expect((await store.define(node(o, 'p1', 'd1', 'project', 500_000))).outcome).toBe('created');
    expect(await store.define(node(o, 'd1', 'org', 'department', 499_999))).toMatchObject({ outcome: 'refused', reason: 'cap-below-children' });
    expect(await store.define(node(o, 'org', null, 'organization', 999_999))).toMatchObject({ outcome: 'refused', reason: 'cap-below-children' });
    expect(await store.define(node(o, 'd2', 'org', 'department', 400_001))).toMatchObject({ outcome: 'refused', reason: 'children-exceed-parent' });
    const revised = await store.define(node(o, 'd1', 'org', 'department', 550_000));
    expect(revised).toMatchObject({ outcome: 'revised', allocation: { revision: 2, capMicros: 550_000 } });
    await expect(store.define(node(o, 'x', 'org', 'department', 10, 11))).rejects.toThrow('invalid hosted allocation request');
    await expect(store.define(node(o, 'y', 'org', 'organization', 10))).rejects.toThrow('invalid hosted allocation request');
    // org, d1 (x2), d2, p1: refusals, duplicates and conflicts wrote nothing.
    expect(await count('hosted_budget_allocations', o)).toBe(5);
  });

  it('serializes concurrent sibling definitions so they never sum above the parent cap', async () => {
    const o = org();
    await define(node(o, 'org', null, 'organization', 1_000_000));
    const race = racing(10);
    const outcomes = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      race.define(node(o, `dept-${i}`, 'org', 'department', 300_000))));
    expect(outcomes.filter(x => x.outcome === 'created')).toHaveLength(3);
    const refused = outcomes.filter(x => x.outcome === 'refused');
    expect(refused).toHaveLength(7);
    for (const r of refused) expect(r).toMatchObject({ reason: 'children-exceed-parent' });
    const departments = (await report(o)).byCostClass.model.allocations.filter(a => a.level === 'department');
    expect(departments.reduce((t, a) => t + a.capMicros, 0)).toBe(900_000);
  });

  it('admits concurrent holds only within every ancestor bound', async () => {
    const o = org();
    // Department exposure (700k) is tighter than its two projects together (1M).
    await smallTree(o, { deptCap: 1_000_000, deptUnreconciled: 700_000, projectCap: 500_000 });
    const requests = Array.from({ length: 15 }, (_, i) => hold(o, i % 2 === 0 ? 'proj-a' : 'proj-b', 100_000));
    const race = racing(requests.length);
    const outcomes = await Promise.all(requests.map(r => race.reserve(r)));
    const admitted = outcomes.filter(x => x.outcome === 'admitted');
    expect(admitted).toHaveLength(7);
    const refused = outcomes.filter(x => x.outcome === 'refused');
    expect(refused).toHaveLength(8);
    for (const r of refused) expect(['unreconciled-bound', 'allocation-exhausted']).toContain((r as { reason: string }).reason);
    const r = await report(o);
    const at = (id: string) => r.byCostClass.model.allocations.find(a => a.allocationId === id)!;
    expect(at('dept')).toMatchObject({ committedMicros: 700_000, unreconciledMicros: 700_000, openHolds: 7 });
    expect(at('org')).toMatchObject({ committedMicros: 700_000, unreconciledMicros: 700_000 });
    expect(at('proj-a').committedMicros).toBeLessThanOrEqual(500_000);
    expect(at('proj-b').committedMicros).toBeLessThanOrEqual(500_000);
    expect(at('proj-a').committedMicros + at('proj-b').committedMicros).toBe(700_000);
    expect(await count('hosted_budget_allocation_holds', o)).toBe(7);
  });

  it('bounds unreconciled exposure until a provider-billed final settlement releases it', async () => {
    const o = org();
    await smallTree(o, { projectCap: 500_000, projectUnreconciled: 200_000 });
    const first = hold(o, 'proj-a', 100_000);
    expect((await store.reserve(first)).outcome).toBe('admitted');
    expect((await store.reserve(first)).outcome).toBe('duplicate');
    expect(await store.reserve({ ...first, maximumCostMicros: 1 })).toMatchObject({ outcome: 'conflict', reason: 'reservation-binding-changed' });
    expect((await store.reserve(hold(o, 'proj-a', 100_000))).outcome).toBe('admitted');
    const third = hold(o, 'proj-a', 100_000);
    expect(await store.reserve(third)).toMatchObject({ outcome: 'refused', reason: 'unreconciled-bound', allocationId: 'proj-a' });
    const settle = (change: Partial<HostedAllocationSettlement> = {}): HostedAllocationSettlement => ({
      organization: o, reservationId: first.reservationId, costSource: 'provider-reported', costMicros: 40_000,
      providerFinal: false, observedAtMs: T + 1, evidenceRef: 'fixture:usage-report', ...change });
    // A provider-reported (non-final) observation does not reconcile.
    expect((await store.settle(settle())).outcome).toBe('settled');
    expect(await store.reserve(third)).toMatchObject({ outcome: 'refused', reason: 'unreconciled-bound' });
    expect(await store.settle(settle({ observedAtMs: T }))).toMatchObject({ outcome: 'refused', reason: 'stale-observation' });
    await expect(store.settle(settle({ providerFinal: true }))).rejects.toThrow('invalid hosted allocation settlement');
    expect(await store.settle(settle({ costSource: 'provider-billed', costMicros: 40_003, providerFinal: true,
      observedAtMs: T + 2, evidenceRef: 'fixture:final-bill' }))).toMatchObject({ outcome: 'settled', hold: { revision: 3, providerFinal: true } });
    expect(await store.settle(settle({ observedAtMs: T + 3 }))).toMatchObject({ outcome: 'refused', reason: 'provider-final-is-terminal' });
    expect(await store.settle(settle({ reservationId: 'res-missing' }))).toMatchObject({ outcome: 'refused', reason: 'unknown-reservation' });
    expect((await store.reserve(third)).outcome).toBe('admitted');
    expect(await position(o, 'proj-a')).toMatchObject({ committedMicros: 240_003, unreconciledMicros: 200_000,
      providerFinalMicros: 40_003, openHolds: 2, availableMicros: 259_997 });
    // An observed overrun above the enforced maximum commits the larger amount.
    const overrun = hold(o, 'proj-b', 100_000);
    expect((await store.reserve(overrun)).outcome).toBe('admitted');
    await store.settle(settle({ reservationId: overrun.reservationId, costMicros: 150_000 }));
    expect(await position(o, 'proj-b')).toMatchObject({ committedMicros: 150_000, unreconciledMicros: 150_000 });
    expect(await store.define(node(o, 'proj-b', 'dept', 'project', 149_999))).toMatchObject({ outcome: 'refused', reason: 'cap-below-committed' });
  });

  it('keeps model, hosting and subscription money in separate trees and totals', async () => {
    const o = org();
    for (const costClass of HOSTED_COST_CLASSES) await smallTree(o, { costClass, prefix: `${costClass}-` });
    expect((await store.reserve(hold(o, 'model-proj-a', 100_000))).outcome).toBe('admitted');
    expect((await store.reserve(hold(o, 'hosting-proj-a', 50_000, { costClass: 'hosting' }))).outcome).toBe('admitted');
    expect(await store.reserve(hold(o, 'hosting-proj-a', 1))).toMatchObject({ outcome: 'refused', reason: 'cost-class-or-month-mismatch' });
    expect(await store.reserve(hold(o, 'model-proj-a', 1, { month: '2026-11' }))).toMatchObject({ outcome: 'refused', reason: 'cost-class-or-month-mismatch' });
    expect(await store.reserve(hold(o, 'model-dept', 1))).toMatchObject({ outcome: 'refused', reason: 'not-a-project-allocation' });
    expect(await store.reserve(hold(o, 'missing', 1))).toMatchObject({ outcome: 'refused', reason: 'unknown-allocation' });
    const r = await report(o);
    expect(r.byCostClass.model).toMatchObject({ committedMicros: 100_000, unreconciledMicros: 100_000, providerFinalMicros: 0 });
    expect(r.byCostClass.hosting).toMatchObject({ committedMicros: 50_000, unreconciledMicros: 50_000 });
    expect(r.byCostClass.subscription).toMatchObject({ committedMicros: 0, unreconciledMicros: 0 });
    for (const costClass of HOSTED_COST_CLASSES) {
      expect(r.byCostClass[costClass].allocations.map(a => a.allocationId).every(id => id.startsWith(`${costClass}-`))).toBe(true);
    }
  });

  it('records outcome cost with explicit unknowns and derives result cost from provider-final holds', async () => {
    const o = org();
    await smallTree(o);
    const h1 = hold(o, 'proj-a', 100_000);
    const h2 = hold(o, 'proj-a', 100_000);
    const other = hold(o, 'proj-b', 100_000);
    for (const h of [h1, h2, other]) expect((await store.reserve(h)).outcome).toBe('admitted');
    const outcome = (change: Partial<HostedOutcomeRecordRequest> = {}): HostedOutcomeRecordRequest => ({
      organization: o, outcomeId: 'outcome-1', allocationId: 'proj-a', workflowRef: 'pilot:invoice-triage',
      evidenceClass: 'internal-simulation', result: { state: 'accepted' }, reservationIds: [h1.reservationId, h2.reservationId],
      reviewEffortSeconds: { unknownReason: 'reviewer-time-not-instrumented' }, reworkCount: { value: 1 },
      observedAtMs: T + 5, evidenceRef: 'fixture:pilot-run', recordedBy: 'fixture', ...change });
    const pending = await store.recordOutcome(outcome());
    expect(pending).toMatchObject({ outcome: 'recorded', record: { revision: 1, resultState: 'accepted',
      evidenceClass: 'internal-simulation', reviewEffortSeconds: { unknownReason: 'reviewer-time-not-instrumented' },
      reworkCount: { value: 1 } } });
    expect(pending.record?.resultCostMicros).toEqual({
      unknownReason: `provider-final-pending:${[h1.reservationId, h2.reservationId].sort().join(',')}` });
    const before = (await report(o)).outcomes.find(s => s.allocationId === 'proj-a')!;
    expect(before).toMatchObject({ outcomes: 1, acceptedWithUnknownCost: 1, costPerAcceptedOutcomeMicros: null,
      reviewEffortUnknown: 1, reworkKnownTotal: 1 });
    expect(before.costPerAcceptedUnknownReason).toMatch(/unknown result cost/);

    for (const [h, cost] of [[h1, 30_000], [h2, 20_000]] as const) {
      expect((await store.settle({ organization: o, reservationId: h.reservationId, costSource: 'provider-billed',
        costMicros: cost, providerFinal: true, observedAtMs: T + 6, evidenceRef: 'fixture:final-bill' })).outcome).toBe('settled');
    }
    const final = await store.recordOutcome(outcome({ observedAtMs: T + 7 }));
    expect(final.record).toMatchObject({ revision: 2, resultCostMicros: { value: 50_000 } });
    expect((await store.recordOutcome(outcome({ outcomeId: 'outcome-2', result: { state: 'rejected' }, reservationIds: [],
      resultCostMicros: { value: 5_000 }, reviewEffortSeconds: { value: 600 }, reworkCount: { value: 0 } }))).outcome).toBe('recorded');
    const unknown = await store.recordOutcome(outcome({ outcomeId: 'outcome-3',
      result: { state: 'unknown', unknownReason: 'reviewer-has-not-decided' }, reservationIds: [],
      reviewEffortSeconds: { unknownReason: 'not-reviewed' }, reworkCount: { unknownReason: 'not-reviewed' } }));
    expect(unknown.record).toMatchObject({ resultState: 'unknown', resultUnknownReason: 'reviewer-has-not-decided',
      resultCostMicros: { unknownReason: 'no-linked-reservations' } });

    const after = (await report(o)).outcomes.find(s => s.allocationId === 'proj-a')!;
    expect(after).toMatchObject({ outcomes: 3, byState: { accepted: 1, rejected: 1, 'rework-requested': 0, unknown: 1 },
      evidenceClasses: ['internal-simulation'], acceptedResultCostMicros: 50_000, acceptedWithUnknownCost: 0,
      costPerAcceptedOutcomeMicros: 50_000, costPerAcceptedUnknownReason: null, reviewEffortKnownSeconds: 600,
      reviewEffortUnknown: 2, reworkKnownTotal: 1, reworkUnknown: 1 });

    expect(await store.recordOutcome(outcome({ outcomeId: 'o-4', allocationId: 'missing' }))).toMatchObject({ outcome: 'refused', reason: 'unknown-allocation' });
    expect(await store.recordOutcome(outcome({ outcomeId: 'o-4', reservationIds: ['res-missing'] }))).toMatchObject({ outcome: 'refused', reason: 'unknown-reservation' });
    expect(await store.recordOutcome(outcome({ outcomeId: 'o-4', reservationIds: [other.reservationId] })))
      .toMatchObject({ outcome: 'refused', reason: 'reservation-allocation-mismatch' });
    // Never a silent zero: each measure needs a value or an explicit reason.
    await expect(store.recordOutcome(outcome({ outcomeId: 'o-4', reviewEffortSeconds: undefined as never })))
      .rejects.toThrow(/explicit unknownReason/);
    await expect(store.recordOutcome(outcome({ outcomeId: 'o-4', reworkCount: { value: 1, unknownReason: 'x' } as never })))
      .rejects.toThrow(/explicit unknownReason/);
    // The database keeps an outcome's identity fields immutable across revisions.
    await expect(store.recordOutcome(outcome({ workflowRef: 'pilot:other', observedAtMs: T + 8 }))).rejects.toThrow(/keep immutable fields/);
    await expect(store.recordOutcome(outcome({ allocationId: 'proj-b', reservationIds: [], observedAtMs: T + 8 })))
      .rejects.toThrow(/keep immutable fields/);
    expect(await count('hosted_outcome_cost_records', o)).toBe(4);
  });

  it('forecasts recorded costs separately by class without treating commitments as costs or changing admission', async () => {
    const o = org();
    const start = Date.UTC(2026, 9, 1); const end = Date.UTC(2026, 10, 1);
    const mid = start + (end - start) / 2;
    for (const [index, costClass] of HOSTED_COST_CLASSES.entries()) {
      await smallTree(o, { costClass, prefix: `${costClass}-` });
      const h = hold(o, `${costClass}-proj-a`, 10_000, { costClass, reservationId: `${costClass}-cost` });
      expect((await store.reserve(h)).outcome).toBe('admitted');
      expect((await store.settle({ organization: o, reservationId: h.reservationId,
        costSource: 'provider-reported', costMicros: 101 * (index + 1), providerFinal: false,
        observedAtMs: T + 1, evidenceRef: 'fixture:reported' })).outcome).toBe('settled');
    }
    const before = await report(o);
    const result = await store.report({ organization: o, month: MONTH, forecast: { asOfMs: mid,
      source: { complete: true, observedAtMs: mid, maximumAgeMs: 0, evidenceRef: 'fixture:allocation-census' } } });
    for (const [index, c] of HOSTED_COST_CLASSES.entries()) {
      expect(before.byCostClass[c].forecast).toBeUndefined();
      const { forecast, ...position } = result.byCostClass[c];
      expect(position).toEqual(before.byCostClass[c]);
      expect(forecast).toEqual({ method: 'linear-elapsed-utc-month', scope: 'recorded-allocation-costs',
        evidenceRef: 'fixture:allocation-census', basisMicros: 101 * (index + 1),
        elapsedMs: (end - start) / 2, periodMs: end - start, projectedConsumptionMicros: 202 * (index + 1),
        provisional: true, unavailableReason: null });
      expect(position.committedMicros).toBe(10_000);
      expect(position.providerFinalMicros).toBe(0);
    }
    expect(result.outcomes).toEqual(before.outcomes);
    // A display forecast cannot supply extra funding or relax the existing cap.
    expect(await store.reserve(hold(o, 'model-proj-a', 500_001)))
      .toMatchObject({ outcome: 'refused', reason: 'allocation-exhausted' });
    expect(await report(o)).toEqual(before);
  });

  it('keeps allocation forecasts unknown for missing costs, incomplete/stale census and newer receipts', async () => {
    const o = org(); await smallTree(o);
    const mid = Date.UTC(2026, 9, 16, 12);
    const source = { complete: true, observedAtMs: mid, maximumAgeMs: 1000, evidenceRef: 'fixture:allocation-census' };
    const h = hold(o, 'proj-a', 100_000);
    expect((await store.reserve(h)).outcome).toBe('admitted');
    const first = await store.report({ organization: o, month: MONTH, forecast: { asOfMs: mid, source } });
    expect(first.byCostClass.model.forecast).toMatchObject({ basisMicros: null,
      projectedConsumptionMicros: null, unavailableReason: 'unpriced-usage' });
    // Empty is only a known zero when the matching population was completely observed.
    expect(first.byCostClass.hosting.forecast).toMatchObject({ basisMicros: 0, projectedConsumptionMicros: 0 });
    for (const patch of [{ complete: false }, { observedAtMs: mid - 1001 }, { observedAtMs: mid + 1 }]) {
      const r = await store.report({ organization: o, month: MONTH, forecast: { asOfMs: mid, source: { ...source, ...patch } } });
      expect(r.byCostClass.hosting.forecast).toMatchObject({ basisMicros: null, projectedConsumptionMicros: null,
        unavailableReason: patch.complete === false ? 'incomplete-source' : 'source-not-current' });
    }
    expect((await store.settle({ organization: o, reservationId: h.reservationId, costSource: 'provider-billed',
      costMicros: 1, providerFinal: true, observedAtMs: mid + 1, evidenceRef: 'fixture:late-bill' })).outcome).toBe('settled');
    const newer = await store.report({ organization: o, month: MONTH, forecast: { asOfMs: mid + 2, source } });
    expect(newer.byCostClass.model.forecast).toMatchObject({ basisMicros: null, projectedConsumptionMicros: null,
      unavailableReason: 'receipt-newer-than-census' });
    expect(newer.byCostClass.model.providerFinalMicros).toBe(1);
    const closed = await store.report({ organization: o, month: MONTH, forecast: { asOfMs: endOfMonth(),
      source: { ...source, observedAtMs: endOfMonth() } } });
    expect(closed.byCostClass.model.forecast).toMatchObject({ basisMicros: 1, projectedConsumptionMicros: 1,
      provisional: false, unavailableReason: null });
    function endOfMonth() { return Date.UTC(2026, 10, 1); }
  });

  it('exports each reservation once across ancestor rollups and preserves incomplete bills and human measurements', async () => {
    const o = org();
    for (const costClass of HOSTED_COST_CLASSES) {
      const prefix = `${costClass}-`;
      await smallTree(o, { costClass, prefix });
      const final = hold(o, `${prefix}proj-a`, 100_000, { costClass, reservationId: `${prefix}final` });
      const pending = hold(o, `${prefix}proj-a`, 100_000, { costClass, reservationId: `${prefix}pending` });
      expect((await store.reserve(final)).outcome).toBe('admitted');
      expect((await store.reserve(pending)).outcome).toBe('admitted');
      for (const [h, cost, providerFinal] of [[final, 30_003, true], [pending, 25_000, false]] as const) {
        expect((await store.settle({ organization: o, reservationId: h.reservationId,
          costSource: providerFinal ? 'provider-billed' : 'provider-reported', costMicros: cost, providerFinal,
          observedAtMs: T + 1, evidenceRef: 'fixture:provider-observation' })).outcome).toBe('settled');
      }
      expect((await store.recordOutcome({ organization: o, outcomeId: `${prefix}outcome`, allocationId: `${prefix}proj-a`,
        workflowRef: 'pilot:finance', evidenceClass: 'internal-simulation', result: { state: 'accepted' },
        reservationIds: [final.reservationId, pending.reservationId],
        reviewEffortSeconds: { unknownReason: 'human-review-not-measured' }, reworkCount: { unknownReason: 'rework-not-measured' },
        observedAtMs: T + 2, evidenceRef: 'fixture:outcome', recordedBy: 'fixture' })).outcome).toBe('recorded');
    }
    const exported = await store.accountingExport({ organization: o, month: MONTH });
    expect(exported).toMatchObject({ organization: o, month: MONTH, currency: 'USD' });
    expect(exported.rows).toHaveLength(6);
    for (const costClass of HOSTED_COST_CLASSES) {
      const rows = exported.rows.filter(r => r.costClass === costClass);
      expect(rows).toHaveLength(2);
      expect(rows.reduce((sum, r) => sum + r.committedMicros, 0)).toBe(130_003);
      expect(exported.byCostClass[costClass]).toEqual({ reservations: 2, pendingProviderFinal: 1,
        committedMicros: 130_003, unreconciledMicros: 100_000, providerFinalMicros: 30_003 });
      expect(rows[0]!.allocationPath).toEqual([`${costClass}-org`, `${costClass}-dept`, `${costClass}-proj-a`]);
      expect(rows.find(r => r.reservationId.endsWith('final'))).toMatchObject({ revision: 2,
        providerFinalCostMicros: { value: 30_003 }, outcomeIds: [`${costClass}-outcome`] });
      expect(rows.find(r => r.reservationId.endsWith('pending'))).toMatchObject({ costSource: 'provider-reported',
        observedCostMicros: { value: 25_000 }, providerFinalCostMicros: { unknownReason: 'provider-final-bill-not-recorded' } });
      expect(exported.outcomes.find(r => r.outcomeId === `${costClass}-outcome`)).toMatchObject({
        resultState: 'accepted', evidenceClass: 'internal-simulation', resultCostMicros: {
          unknownReason: `provider-final-pending:${costClass}-pending` } });
      expect(exported.gaps).toEqual(expect.arrayContaining([
        { kind: 'provider-final-pending', ref: `${costClass}-pending`, reason: 'provider-final-bill-not-recorded' },
        { kind: 'unknown-review-effort', ref: `${costClass}-outcome`, reason: 'human-review-not-measured' },
        { kind: 'unknown-rework', ref: `${costClass}-outcome`, reason: 'rework-not-measured' },
      ]));
    }
  });

  it('isolates accounting exports by both organization keys and month, including reused reservation IDs', async () => {
    const o = org();
    const foreign = [{ ...o, organizationId: randomUUID() }, { ...o, controlWorkspaceId: randomUUID() }];
    for (const [index, scope] of [o, ...foreign].entries()) {
      await smallTree(scope);
      expect((await store.reserve(hold(scope, 'proj-a', (index + 1) * 10_000, { reservationId: 'same-id' }))).outcome).toBe('admitted');
    }
    const exported = await store.accountingExport({ organization: o, month: MONTH });
    expect(exported.rows).toHaveLength(1);
    expect(exported.rows[0]).toMatchObject({ reservationId: 'same-id', committedMicros: 10_000,
      observedCostMicros: { unknownReason: 'usage-cost-not-recorded' }, outcomeIds: [] });
    expect(exported.gaps).toContainEqual({ kind: 'unattributed-reservation', ref: 'same-id', reason: 'no-recorded-workflow-outcome' });
    const absent = await store.accountingExport({ organization: o, month: '2026-11' });
    expect(absent.rows).toEqual([]); expect(absent.outcomes).toEqual([]);
    expect(absent.byCostClass.model).toEqual({ reservations: 0, pendingProviderFinal: 0,
      committedMicros: 0, unreconciledMicros: 0, providerFinalMicros: 0 });
    await expect(store.accountingExport({ organization: o, month: '2026-13' })).rejects.toThrow('invalid hosted allocation month');
  });

  it('counts shared outcome costs once and exports only the latest outcome links and measurement revisions', async () => {
    const o = org(); await smallTree(o);
    expect((await store.reserve(hold(o, 'proj-a', 100_000, { reservationId: 'shared' }))).outcome).toBe('admitted');
    const outcome = (outcomeId: string, change: Partial<HostedOutcomeRecordRequest> = {}): HostedOutcomeRecordRequest => ({
      organization: o, outcomeId, allocationId: 'proj-a', workflowRef: 'pilot:finance', evidenceClass: 'synthetic',
      result: { state: 'accepted' }, reservationIds: ['shared'], reviewEffortSeconds: { value: 0 }, reworkCount: { value: 0 },
      observedAtMs: T + 1, evidenceRef: 'fixture:outcome', recordedBy: 'fixture', ...change,
    });
    for (const id of ['a', 'b']) expect((await store.recordOutcome(outcome(id))).outcome).toBe('recorded');
    const first = await store.accountingExport({ organization: o, month: MONTH });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ committedMicros: 100_000, outcomeIds: ['a', 'b'] });
    expect(first.gaps).toContainEqual({ kind: 'shared-outcome-reservation', ref: 'shared',
      reason: 'cost-counted-once;per-outcome-allocation-weights-not-recorded' });
    expect((await store.recordOutcome(outcome('a', { reservationIds: [], result: { state: 'unknown',
      unknownReason: 'review-pending' }, reviewEffortSeconds: { unknownReason: 'not-reviewed' }, observedAtMs: T + 2 }))).outcome).toBe('recorded');
    const revised = await store.accountingExport({ organization: o, month: MONTH });
    expect(revised.rows[0]!.outcomeIds).toEqual(['b']);
    expect(revised.outcomes).toHaveLength(2);
    expect(revised.outcomes.find(r => r.outcomeId === 'a')).toMatchObject({ revision: 2, reservationIds: [],
      resultState: 'unknown', resultCostMicros: { unknownReason: 'no-linked-reservations' } });
    expect(revised.gaps).toContainEqual({ kind: 'unknown-result', ref: 'a', reason: 'review-pending' });
    expect(revised.gaps.some(g => g.kind === 'shared-outcome-reservation')).toBe(false);
  });

  it('composes finance projections in one service transaction and isolates both tenant keys and month', async () => {
    const o = org();
    const others = [{ ...o, organizationId: randomUUID() }, { ...o, controlWorkspaceId: randomUUID() }];
    for (const [index, scope] of [o, ...others].entries()) {
      await smallTree(scope);
      const h = hold(scope, 'proj-a', 100_000, { reservationId: 'same-reservation' });
      expect((await store.reserve(h)).outcome).toBe('admitted');
      expect((await store.settle({ organization: scope, reservationId: h.reservationId,
        costSource: 'provider-billed', costMicros: 20_003 + index, providerFinal: true,
        observedAtMs: T, evidenceRef: 'fixture:finance-final' })).outcome).toBe('settled');
    }
    let transactions = 0;
    const source = hostedBillingAllocationSource(fn => { transactions++; return service(fn); });
    const snapshot = await source({ organization: o, month: MONTH, asOfMs: T });
    expect(transactions).toBe(1);
    expect(snapshot).toMatchObject({ organization: o, asOfMs: T, report: { month: MONTH },
      accounting: { organization: o, month: MONTH, rows: [{ reservationId: 'same-reservation',
        observedCostMicros: { value: 20_003 }, providerFinalCostMicros: { value: 20_003 } }] } });
    for (const c of HOSTED_COST_CLASSES) {
      expect(snapshot.report.byCostClass[c]).toMatchObject({
        committedMicros: snapshot.accounting.byCostClass[c].committedMicros,
        unreconciledMicros: snapshot.accounting.byCostClass[c].unreconciledMicros,
        providerFinalMicros: snapshot.accounting.byCostClass[c].providerFinalMicros,
        forecast: { scope: 'recorded-allocation-costs', evidenceRef: `hosted-allocation-ledger:${MONTH}` },
      });
    }
    expect(snapshot.report.byCostClass.model.forecast).toMatchObject({ basisMicros: 20_003,
      projectedConsumptionMicros: 620_093, provisional: true });
    expect((await source({ organization: o, month: '2026-11', asOfMs: T })).accounting.rows).toEqual([]);
    // Read-only finance views never revise the accounting facts.
    expect(await store.accountingExport({ organization: o, month: MONTH })).toEqual(snapshot.accounting);
  });

  it('composes billing allocation administration with durable hierarchy rules and tenant isolation', async () => {
    const o = org(); const other = { ...o, organizationId: randomUUID() };
    let transactions = 0;
    const admin = hostedBillingAllocationAdmin(fn => { transactions++; return service(fn); });
    for (const scope of [o, other]) {
      for (const input of [node(scope, 'org', null, 'organization', 1_000_000),
        node(scope, 'dept', 'org', 'department', 500_000), node(scope, 'project', 'dept', 'project', 100_000)]) {
        expect(await admin(input)).toMatchObject({ organization: scope, result: { outcome: 'created',
          allocation: { allocationId: input.allocationId, revision: 1 } } });
      }
    }
    expect(transactions).toBe(6);
    const project = node(o, 'project', 'dept', 'project', 100_000);
    expect((await admin(project)).result.outcome).toBe('duplicate');
    expect((await admin({ ...project, capMicros: 200_000, maxUnreconciledMicros: 200_000 })).result)
      .toMatchObject({ outcome: 'revised', allocation: { revision: 2 } });
    expect((await position(o, 'project'))?.capMicros).toBe(200_000);
    expect((await position(other, 'project'))?.capMicros).toBe(100_000);
    const before = await count('hosted_budget_allocations', o);
    for (const [input, reason] of [
      [{ ...project, capMicros: 500_001 }, 'children-exceed-parent'],
      [{ ...project, parentAllocationId: 'org' }, 'immutable-allocation-fields'],
      [node(o, 'dept', 'org', 'department', 199_999), 'cap-below-children'],
    ] as const) expect((await admin(input)).result).toMatchObject({ outcome: expect.stringMatching(/refused|conflict/), reason });
    expect(await count('hosted_budget_allocations', o)).toBe(before);
    expect((await store.reserve(hold(o, 'project', 150_000))).outcome).toBe('admitted');
    expect((await admin(project)).result).toMatchObject({ outcome: 'refused', reason: 'cap-below-committed' });
    expect(await count('hosted_budget_allocations', o)).toBe(before);
  });

  it('enforces dense immutable revisions and service-only access in the database itself', async () => {
    const o = org();
    await smallTree(o);
    const hash = 'a'.repeat(64);
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_allocation_holds
      (control_workspace_id, organization_id, reservation_id, revision, allocation_id, cost_class, month,
       maximum_cost_micros, request_hash, cost_source, cost_micros, provider_final, observed_at_ms, evidence_ref)
      VALUES (${o.controlWorkspaceId}, ${o.organizationId}, 'res-raw', 2, 'proj-a', 'model', ${MONTH}, 1, ${hash},
        'unpriced', NULL, false, ${T}, 'fixture:raw')`).rejects.toThrow(/first revision must be 1/);
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_allocations
      (control_workspace_id, organization_id, allocation_id, revision, parent_allocation_id, level, cost_class, month,
       cap_micros, max_unreconciled_micros, request_hash, evidence_ref, recorded_by)
      VALUES (${o.controlWorkspaceId}, ${o.organizationId}, 'dept', 2, 'org', 'department', 'hosting', ${MONTH},
        1, 1, ${hash}, 'fixture:raw', 'fixture')`).rejects.toThrow(/keep immutable fields/);
    await expect(db.adminSql`INSERT INTO papercusp_auth.hosted_budget_allocations
      (control_workspace_id, organization_id, allocation_id, revision, parent_allocation_id, level, cost_class, month,
       cap_micros, max_unreconciled_micros, request_hash, evidence_ref, recorded_by)
      VALUES (${o.controlWorkspaceId}, ${o.organizationId}, 'dept', 3, 'org', 'department', 'model', ${MONTH},
        1, 1, ${hash}, 'fixture:raw', 'fixture')`).rejects.toThrow(/dense/);
    // Only the hosted service role may touch these tables.
    await expect(db.appSql.begin(tx => tx`SELECT count(*) FROM papercusp_auth.hosted_budget_allocations`))
      .rejects.toThrow(/permission denied/);
  });
});
