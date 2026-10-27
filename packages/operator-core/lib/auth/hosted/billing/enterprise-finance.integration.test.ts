/** R6 engineering detector controls, using real private PostgreSQL stores.
 * Frozen amounts, artifacts and completions below are SYNTHETIC. They neither
 * supply the absent operational spend census/funded allowance nor qualify R6,
 * native execution, customer value, a real trial, or shipment. */
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { seedSupportWorkflowNativeFixture, type SupportWorkflowNativeFixture }
  from '../../../../../../apps/operator/e2e/_support-workflow-native-fixture';
import { seedSupportWorkflowSyntheticCompletion } from '../../../blueprint/fixtures/support-workflow-synthetic-completion';
import { supportWorkflowTrialEvidenceFixture } from '../../../blueprint/fixtures/support-workflow-trial-cases';
import { getBlueprintOperationResult, signalBlueprintOperation, submitBlueprintOperation,
  type BlueprintOperationHandle } from '../../../blueprint/operation-service';
import { recordSupportWorkflowOutcome, reserveSupportOperationAttempt,
  supportOperationReservationId } from '../../../blueprint/support-workflow-budget';
import { evaluateSupportWorkflowTrial, supportTrialBodyHash,
  type SupportTrialArtifact, type SupportTrialAuthority } from '../../../blueprint/support-workflow-trial';
import { runWithWorkspace } from '../../../workspace-als';
import { defineHostedAllocation, reserveHostedAllocation, recordHostedOutcome, readHostedAllocationAccountingExport,
  readHostedAllocationReport, settleHostedAllocation, type HostedAllocationHoldRequest } from './allocation-store';
import { PostgresHostedBudgetStore } from './budget-store';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));
const workspaceId = 'verify-tauri-isolated-enterprise-finance';
let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); connection.sql = db.adminSql; }, 180_000);
afterAll(async () => db?.cleanup(), 120_000);

const fixture = () => seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId });
const submit = (f: SupportWorkflowNativeFixture, key: string) => runWithWorkspace(workspaceId,
  () => submitBlueprintOperation(db.adminSql, { workspaceId, harnessSlug: f.harnessSlug,
    operationId: f.operationId, callerId: `${f.actors.employee.id}/employee`, requestKey: key,
    expectedSpecificationRevision: f.approvedRevision, input: f.input },
  { principal: { kind: 'user', trust: 'verified', slug: f.actors.employee.id, workspaceId } }));
const attempt = (f: SupportWorkflowNativeFixture, handle: BlueprintOperationHandle) => ({
  handle, funding: f.funding, operationMaximumMicros: 100_000,
  attemptId: randomUUID(), attemptMaximumMicros: 10_000, bodySha256: 'c'.repeat(64),
});
const accounting = (f: SupportWorkflowNativeFixture) => db.adminSql.begin(tx =>
  readHostedAllocationAccountingExport(tx as unknown as Sql, f.funding));
const report = (f: SupportWorkflowNativeFixture) => db.adminSql.begin(tx =>
  readHostedAllocationReport(tx as unknown as Sql, f.funding));

/** Reuses the maintained authoring fixture, but acceptance and cost are read
 * independently from real operation/reviewer/finance rows by the detector. */
async function reviewedTrial(decision: 'accept' | 'reject' | 'rework' = 'accept') {
  const f = await fixture();
  const trial = supportWorkflowTrialEvidenceFixture({ workspace: workspaceId, harness: f.harnessSlug,
    workflowRevision: f.approvedRevision, operationId: f.operationId,
    submitter: `${f.actors.employee.id}/employee`, reviewer: f.actors.reviewer.id,
    supportCaseId: f.supportCaseId, documentIds: [f.documentId], now: Date.now() + 60_000 });
  trial.registration.startsAt = new Date(Date.now() - 20_000).toISOString();
  trial.input.registration = trial.put('fixture:registration', trial.registration, true);
  for (const use of [1, 2]) {
    const handle = await submit(f, `finance-repeat:${use}`);
    expect(await submit(f, `finance-repeat:${use}`)).toEqual(handle);
    expect(await reserveSupportOperationAttempt(db.adminSql, attempt(f, handle))).toBe(true);
    await seedSupportWorkflowSyntheticCompletion(db.adminSql, { handle, role: f.role,
      output: { supportCaseId: f.supportCaseId, summary: 'Synthetic finance handoff',
        reproduction: ['Open the synthetic case'], checklist: ['Check source and liability'],
        suggestedRole: 'engineering', citations: [{ id: f.documentId, source: 'slack', externalId: f.externalId }] } });
    const ready = await getBlueprintOperationResult(db.adminSql, handle, `${f.actors.employee.id}/employee`);
    if (ready.state !== 'ready' || !ready.businessReview) throw new Error('Synthetic completion is not reviewable');
    const request = { channel: 'business-review', requestKey: `finance-review:${use}`,
      payload: { decision, reason: 'Independent synthetic review',
        resultFingerprint: ready.businessReview.resultFingerprint } };
    await expect(signalBlueprintOperation(db.adminSql, handle, `${f.actors.employee.id}/employee`, request,
      { principalId: f.actors.employee.id })).rejects.toThrow(/distinct authenticated reviewer/);
    const event = await signalBlueprintOperation(db.adminSql, handle, f.actors.reviewer.id, request,
      { principalId: f.actors.reviewer.id });
    expect(await signalBlueprintOperation(db.adminSql, handle, f.actors.reviewer.id, request,
      { principalId: f.actors.reviewer.id })).toMatchObject({ replayed: true, eventId: event.eventId });
    // A completed and accepted result does not create an invoice or human timing.
    const pending = (await accounting(f)).rows.find(r => r.reservationId === supportOperationReservationId(handle));
    expect(pending?.providerFinalCostMicros).toHaveProperty('unknownReason');
    const outcome = (await accounting(f)).outcomes.find(r => r.outcomeId === supportOperationReservationId(handle));
    expect(outcome).toMatchObject({ resultState: decision === 'accept' ? 'accepted'
      : decision === 'reject' ? 'rejected' : 'rework-requested', evidenceClass: 'internal-simulation',
      reviewEffortSeconds: { unknownReason: 'review-duration-not-measured' },
      reworkCount: { unknownReason: 'rework-effort-not-measured' } });
    await db.adminSql.begin(async tx => {
      expect((await settleHostedAllocation(tx as unknown as Sql, { organization: f.funding.organization,
        reservationId: supportOperationReservationId(handle), costSource: 'provider-billed',
        providerFinal: true, costMicros: 23_000, observedAtMs: Date.now(),
        evidenceRef: 'synthetic:finance-final' })).outcome).toBe('settled');
      await recordSupportWorkflowOutcome(tx as unknown as Sql, { handle, funding: f.funding,
        decision, reviewerPrincipal: f.actors.reviewer.id, evidenceRef: 'synthetic:finance-final' });
    });
    trial.observe(handle, ready.businessReview.resultFingerprint);
  }
  const prefix = `r6:${randomUUID()}`;
  for (const [ref, artifact] of trial.artifacts) await db.adminSql`INSERT INTO harness_shared.coord_event_log
    (workspace_id, surface, writer_key, msg_id, body) VALUES (${workspaceId}, 'r6-test-artifact', ${prefix}, ${ref},
      ${db.adminSql.json(JSON.parse(JSON.stringify(artifact)))})`;
  const authority: SupportTrialAuthority = { ...trial.authority, resolve: async ref => {
    const [row] = await db.adminSql<{ body: SupportTrialArtifact }[]>`SELECT body FROM harness_shared.coord_event_log
      WHERE workspace_id = ${workspaceId} AND surface = 'r6-test-artifact' AND writer_key = ${prefix} AND msg_id = ${ref}`;
    return row?.body;
  } };
  return { f, trial, authority };
}

describe('enterprise finance cross-surface controls (synthetic private-PG population)', () => {
  it('joins two independently reviewed repeat uses to unique provider-final costs without inventing human measurements', async () => {
    const { f, trial, authority } = await reviewedTrial();
    const verdict = await evaluateSupportWorkflowTrial(db.adminSql, trial.input, authority);
    expect(verdict.status, JSON.stringify(verdict.findings)).toBe('satisfied');
    expect(verdict.evidenceClass).toBe('internal-simulation');
    const exported = await accounting(f);
    expect(exported.currency).toBe('USD');
    expect(exported.rows).toHaveLength(2);
    expect(new Set(exported.rows.map(r => r.reservationId)).size).toBe(2);
    expect(exported.byCostClass.model).toMatchObject({ reservations: 2, pendingProviderFinal: 0,
      providerFinalMicros: 46_000, committedMicros: 46_000, unreconciledMicros: 0 });
    for (const row of exported.rows) {
      expect(row.providerFinalCostMicros).toEqual({ value: 23_000 });
      expect(row.allocationPath).toHaveLength(3);
      const observation = trial.input.observations.find(o => supportOperationReservationId(o.handle) === row.reservationId);
      expect(observation).toBeDefined();
      expect(row.outcomeIds).toEqual([row.reservationId]);
    }
    const summary = (await report(f)).outcomes.find(o => o.allocationId === f.funding.allocationId);
    expect(summary).toMatchObject({ outcomes: 2, acceptedResultCostMicros: 46_000,
      costPerAcceptedOutcomeMicros: 23_000, reviewEffortUnknown: 2, reworkUnknown: 2 });
    expect(exported.byCostClass.hosting.reservations).toBe(0);
    expect(exported.byCostClass.subscription.reservations).toBe(0);
    const foreign = await db.adminSql.begin(tx => readHostedAllocationAccountingExport(tx as unknown as Sql,
      { ...f.funding, organization: { ...f.funding.organization, organizationId: 'unrelated-synthetic-org' } }));
    const otherPeriod = await db.adminSql.begin(tx => readHostedAllocationAccountingExport(tx as unknown as Sql,
      { ...f.funding, month: '2099-12' }));
    expect(foreign.rows).toEqual([]);
    expect(otherPeriod.rows).toEqual([]);
  }, 120_000);

  it('joins synthetic human measurement revisions to independently reviewed repeat uses without duplicating value', async () => {
    const { f, trial, authority } = await reviewedTrial();
    const original = await accounting(f);
    const revise = (row: typeof original.outcomes[number], seconds: number, rework: number,
      change: Record<string, unknown> = {}) => db.adminSql.begin(tx => recordHostedOutcome(tx as unknown as Sql, {
      organization: f.funding.organization, outcomeId: row.outcomeId, allocationId: row.allocationId,
      workflowRef: row.workflowRef, evidenceClass: 'internal-simulation', result: { state: 'accepted' },
      reservationIds: row.reservationIds, reviewEffortSeconds: { value: seconds }, reworkCount: { value: rework },
      observedAtMs: Date.now(), evidenceRef: 'synthetic:independent-human-measurement',
      recordedBy: f.actors.reviewer.id, ...change,
    }));
    // These invented durations exercise the measurement writer, never the
    // absent operating human-effort census or the adopted P-003 thresholds.
    for (const [index, row] of original.outcomes.entries()) {
      expect(await revise(row, (index + 1) * 150, index + 1)).toMatchObject({ outcome: 'recorded',
        record: { revision: row.revision + 1, resultCostMicros: { value: 23_000 } } });
    }
    const summary = () => report(f).then(r => r.outcomes.find(o => o.allocationId === f.funding.allocationId)!);
    expect(await summary()).toMatchObject({ outcomes: 2, acceptedResultCostMicros: 46_000,
      reviewEffortKnownSeconds: 450, reviewEffortUnknown: 0, reworkKnownTotal: 3, reworkUnknown: 0 });
    const first = original.outcomes[0]!;
    expect((await revise(first, 90, 0)).outcome).toBe('recorded');
    expect(await summary()).toMatchObject({ outcomes: 2, acceptedResultCostMicros: 46_000,
      costPerAcceptedOutcomeMicros: 23_000, reviewEffortKnownSeconds: 390, reworkKnownTotal: 2 });
    await expect(revise(first, 90, 0, { workflowRef: 'synthetic:foreign-workflow' }))
      .rejects.toThrow(/keep immutable fields/);
    await expect(revise(first, 90, 0, { reviewEffortSeconds: undefined }))
      .rejects.toThrow(/explicit unknownReason/);
    await expect(revise(first, 90, 0, { reservationIds: [...first.reservationIds, ...first.reservationIds] }))
      .rejects.toThrow(/invalid hosted outcome record/);
    expect(await revise(first, 90, 0, { reservationIds: ['synthetic-unmatched-reservation'] }))
      .toMatchObject({ outcome: 'refused', reason: 'unknown-reservation' });
    const after = await accounting(f);
    expect(after.rows.map(r => r.reservationId)).toEqual(original.rows.map(r => r.reservationId));
    expect(after.byCostClass).toEqual(original.byCostClass);
    expect(after.outcomes).toHaveLength(2);
    expect(after.outcomes.find(o => o.outcomeId === first.outcomeId)?.revision).toBe(first.revision + 2);
    expect((await evaluateSupportWorkflowTrial(db.adminSql, trial.input, authority)).status).toBe('satisfied');
  }, 120_000);

  it('detects forged value attribution and unqualified provenance while preserving missing-data findings', async () => {
    const { trial, authority } = await reviewedTrial();
    expect((await evaluateSupportWorkflowTrial(db.adminSql, trial.input, authority)).status).toBe('satisfied');
    const original = trial.input.observations[0]!;
    const forged = structuredClone((await authority.resolve(original.record.ref))!);
    const body = forged.body as { measured: { costMicros: { value: number } }; resultFingerprint: string };
    body.measured.costMicros.value = 1;
    forged.record.hash = supportTrialBodyHash(forged.body);
    const wrong = structuredClone(trial.input);
    wrong.observations[0]!.record = forged.record;
    wrong.prerequisites = wrong.prerequisites.filter(p => p.id !== 'P-003');
    const wrongAuthority = { ...authority, resolve: async (ref: string) =>
      ref === forged.record.ref ? forged : authority.resolve(ref) };
    let verdict = await evaluateSupportWorkflowTrial(db.adminSql, wrong, wrongAuthority);
    expect(verdict.status).toBe('refused');
    expect(verdict.findings.map(f => f.code)).toEqual(expect.arrayContaining(['cost-misattributed', 'prerequisite-population']));
    const canonical = structuredClone(trial.input);
    canonical.observations[0]!.handle.workspaceId = 'foreign-workspace';
    expect((await evaluateSupportWorkflowTrial(db.adminSql, canonical, authority)).findings.map(f => f.code))
      .toContain('operation-scope');
    const unapproved = structuredClone((await authority.resolve(trial.input.registration.ref))!);
    unapproved.approval = { principal: 'unqualified-synthetic-principal', at: unapproved.approval!.at };
    verdict = await evaluateSupportWorkflowTrial(db.adminSql, trial.input,
      { ...authority, resolve: async ref => ref === unapproved.record.ref ? unapproved : authority.resolve(ref) });
    expect(verdict.findings.map(f => f.code)).toContain('prior-qualified-approval');
    const missing = await evaluateSupportWorkflowTrial(db.adminSql, trial.input, { ...authority, resolve: async () => undefined });
    expect(missing.status).toBe('unknown');
    expect(missing.findings.map(f => f.code)).toContain('registration-missing-or-invalid');
  }, 120_000);

  it('fences concurrent operation spend, replay and unpriced exposure before releasing only provider-final liability', async () => {
    const f = await fixture();
    const handles = await Promise.all(Array.from({ length: 4 }, (_, i) => submit(f, `finance-concurrent:${i}`)));
    const requests = handles.map(h => attempt(f, h));
    const pool = postgres(db.adminDsn, { max: 8, prepare: false, onnotice: () => {} });
    let arrived = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // Every real transaction reaches the barrier before entering the production
    // reservation function; the small default pool cannot serialize the race.
    const racing = { begin: (callback: (sql: Sql) => Promise<boolean>) => pool.begin(async tx => {
      if (++arrived === requests.length) release();
      await gate;
      return callback(tx as unknown as Sql);
    }) } as unknown as Sql;
    try {
      const admitted = await Promise.all(requests.map(r => reserveSupportOperationAttempt(racing, r)));
      expect(admitted.filter(Boolean)).toHaveLength(1);
      const winner = requests[admitted.indexOf(true)]!;
      const waiting = requests[admitted.indexOf(false)]!;
      expect(await reserveSupportOperationAttempt(pool, winner)).toBe(false);
      expect(await reserveSupportOperationAttempt(pool, { ...winner, attemptId: randomUUID(),
        attemptMaximumMicros: 100_001 })).toBe(false);
      expect(await reserveSupportOperationAttempt(pool, { ...waiting, funding: { ...f.funding,
        organization: { ...f.funding.organization, controlWorkspaceId: 'foreign-workspace' } } })).toBe(false);
      expect((await report(f)).byCostClass.model).toMatchObject({ committedMicros: 100_000, unreconciledMicros: 100_000 });
      const reservationId = supportOperationReservationId(winner.handle);
      await db.adminSql.begin(tx => settleHostedAllocation(tx as unknown as Sql, { organization: f.funding.organization,
        reservationId, costSource: 'provider-reported', costMicros: 0, providerFinal: false,
        observedAtMs: Date.now(), evidenceRef: 'synthetic:nonfinal-zero' }));
      expect(await reserveSupportOperationAttempt(pool, waiting)).toBe(false);
      expect((await accounting(f)).byCostClass.model).toMatchObject({ pendingProviderFinal: 1, unreconciledMicros: 100_000 });
      await db.adminSql.begin(tx => settleHostedAllocation(tx as unknown as Sql, { organization: f.funding.organization,
        reservationId, costSource: 'provider-billed', costMicros: 23_000, providerFinal: true,
        observedAtMs: Date.now(), evidenceRef: 'synthetic:final' }));
      expect(await reserveSupportOperationAttempt(pool, waiting)).toBe(true);
      expect((await accounting(f)).byCostClass.model).toMatchObject({ reservations: 2,
        providerFinalMicros: 23_000, committedMicros: 123_000, unreconciledMicros: 100_000 });
      expect(await db.adminSql.begin(tx => settleHostedAllocation(tx as unknown as Sql,
        { organization: f.funding.organization, reservationId: 'unmatched-bill', costSource: 'provider-billed',
          costMicros: 1, providerFinal: true, observedAtMs: Date.now(), evidenceRef: 'synthetic:unmatched' })))
        .toMatchObject({ outcome: 'refused', reason: 'unknown-reservation' });
    } finally { await pool.end(); }
  }, 120_000);

  it('shares ancestor exposure across operation and direct sibling spend while keeping cost classes and forecasts separate', async () => {
    const f = await fixture();
    const { organization, allocationId, month } = f.funding;
    const model = (await report(f)).byCostClass.model.allocations;
    const project = model.find(n => n.allocationId === allocationId)!;
    const sibling = `${allocationId}-sibling`;
    const define = (id: string, parent: string | null, level: 'organization' | 'department' | 'project',
      costClass: 'model' | 'hosting' | 'subscription', cap = 500_000) =>
      db.adminSql.begin(tx => defineHostedAllocation(tx as unknown as Sql, { organization, month,
        allocationId: id, parentAllocationId: parent, level, costClass, capMicros: cap,
        maxUnreconciledMicros: Math.min(100_000, cap), evidenceRef: 'synthetic:mixed-spend', recordedBy: f.actors.admin.id }));
    expect((await define(allocationId, project.parentAllocationId, 'project', 'model')).outcome).toBe('revised');
    expect((await define(sibling, project.parentAllocationId, 'project', 'model')).outcome).toBe('created');
    expect(await define(`${sibling}-bypass`, project.parentAllocationId, 'project', 'model', 1))
      .toMatchObject({ outcome: 'refused', reason: 'children-exceed-parent' });
    const handle = await submit(f, 'mixed-spend-operation');
    const operationRequest = attempt(f, handle);
    const direct = { organization, month, allocationId: sibling, reservationId: `direct-${randomUUID()}`,
      costClass: 'model' as const, maximumCostMicros: 100_000, observedAtMs: Date.now(), evidenceRef: 'synthetic:direct-spend' };
    const pool = postgres(db.adminDsn, { max: 4, prepare: false, onnotice: () => {} });
    let arrived = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const barrier = async <T,>(fn: (sql: Sql) => Promise<T>) => pool.begin(async tx => {
      if (++arrived === 2) release();
      await gate;
      return fn(tx as unknown as Sql);
    });
    const racing = { begin: barrier } as unknown as Sql;
    try {
      const [operationAdmitted, directResult] = await Promise.all([
        reserveSupportOperationAttempt(racing, operationRequest), barrier(sql => reserveHostedAllocation(sql, direct)),
      ]);
      expect(Number(operationAdmitted) + Number(directResult.outcome === 'admitted')).toBe(1);
      if (!operationAdmitted) expect(directResult.outcome).toBe('admitted');
      else expect(directResult).toMatchObject({ outcome: 'refused', reason: 'unreconciled-bound' });
      const after = (await report(f)).byCostClass.model;
      for (const parent of model.filter(n => n.level !== 'project')) {
        expect(after.allocations.find(n => n.allocationId === parent.allocationId))
          .toMatchObject({ committedMicros: 100_000, unreconciledMicros: 100_000, openHolds: 1 });
      }
      const reserve = (value: HostedAllocationHoldRequest) => db.adminSql.begin(tx => reserveHostedAllocation(tx as unknown as Sql, value));
      await expect(reserve({ ...direct, reservationId: 'forged-currency', currency: 'EUR' } as typeof direct))
        .rejects.toThrow(/invalid hosted allocation hold/);
      expect(await reserve({ ...direct, reservationId: 'wrong-period', month: '2099-12' }))
        .toMatchObject({ outcome: 'refused', reason: 'cost-class-or-month-mismatch' });
      expect(await reserve({ ...direct, reservationId: 'wrong-class', costClass: 'hosting' }))
        .toMatchObject({ outcome: 'refused', reason: 'cost-class-or-month-mismatch' });
      // A display projection and its complete census are not budget authority.
      for (const costClass of ['hosting', 'subscription'] as const) {
        const root = `${costClass}-org`, dept = `${costClass}-dept`, leaf = `${costClass}-project`;
        expect((await define(root, null, 'organization', costClass)).outcome).toBe('created');
        expect((await define(dept, root, 'department', costClass)).outcome).toBe('created');
        expect((await define(leaf, dept, 'project', costClass)).outcome).toBe('created');
        expect((await db.adminSql.begin(tx => reserveHostedAllocation(tx as unknown as Sql, {
          ...direct, allocationId: leaf, costClass, reservationId: `${costClass}-spend`, maximumCostMicros: 50_000 }))).outcome)
          .toBe('admitted');
      }
      const beforeForecast = await report(f), at = Date.now();
      const forecast = await db.adminSql.begin(tx => readHostedAllocationReport(tx as unknown as Sql,
        { ...f.funding, forecast: { asOfMs: at, source: { complete: true, observedAtMs: at,
          maximumAgeMs: 1000, evidenceRef: 'synthetic:cost-census' } } }));
      for (const c of ['model', 'hosting', 'subscription'] as const) {
        const { forecast: estimate, ...position } = forecast.byCostClass[c];
        expect(position).toEqual(beforeForecast.byCostClass[c]);
        expect(estimate).toMatchObject({ basisMicros: null, projectedConsumptionMicros: null,
          unavailableReason: 'unpriced-usage', scope: 'recorded-allocation-costs' });
      }
      expect((await accounting(f)).byCostClass).toMatchObject({
        model: { reservations: 1, committedMicros: 100_000 },
        hosting: { reservations: 1, committedMicros: 50_000 },
        subscription: { reservations: 1, committedMicros: 50_000 },
      });
      const unconfigured = new PostgresHostedBudgetStore({ run: callback =>
        db.adminSql.begin(tx => callback(tx as unknown as Sql)) as ReturnType<typeof callback> });
      expect(await unconfigured.reserve({ scope: { ...organization, customerWorkspaceId: 'synthetic-workspace' },
        reservationId: 'forecast-cannot-fund', month, budgetKey: 'consumption.usd_cents',
        maximumCostMicros: 1, providerLimitRef: 'synthetic:forecast-only', asOfMs: at }))
        .toMatchObject({ outcome: 'refused', reason: 'unconfigured-context' });
      if (operationAdmitted) expect(await reserve(direct)).toMatchObject({ outcome: 'refused' });
      else expect(await reserveSupportOperationAttempt(pool, operationRequest)).toBe(false);
    } finally { await pool.end(); }
  }, 120_000);

  it.each(['reject', 'rework'] as const)('keeps %s results out of accepted value even when executor and provider billing succeeded', async decision => {
    const { f, trial, authority } = await reviewedTrial(decision);
    const verdict = await evaluateSupportWorkflowTrial(db.adminSql, trial.input, authority);
    expect(verdict.status).toBe('failed');
    expect(verdict.findings).toContainEqual({ kind: 'failed', code: 'threshold-stop', subject: 'acceptedRate' });
    const exported = await accounting(f), summary = (await report(f)).outcomes[0]!;
    expect(exported.rows).toHaveLength(2);
    expect(exported.byCostClass.model.providerFinalMicros).toBe(46_000);
    expect(summary).toMatchObject({ outcomes: 2, acceptedResultCostMicros: 0,
      costPerAcceptedOutcomeMicros: null, costPerAcceptedUnknownReason: 'no-accepted-outcomes',
      reviewEffortUnknown: 2, reworkUnknown: 2 });
    expect(summary.byState.accepted).toBe(0);
    expect(summary.byState[decision === 'reject' ? 'rejected' : 'rework-requested']).toBe(2);
  }, 120_000);
});
