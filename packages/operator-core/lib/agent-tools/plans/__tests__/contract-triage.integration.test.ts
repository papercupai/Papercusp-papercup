/**
 * P-004 (verification-system-improvements-2026-10-10, D-013 / D-018 / D-019): every active
 * plan without a requirement contract ends in exactly one recorded disposition, and the
 * measurement that the verification.health cell reports cannot read a clean 0 while a plan is
 * uncovered, a bulk closure pasted one reason, or the scope is empty.
 *
 * Runs against the real schema: the measurement is SQL over harness_plans +
 * plan_contract_triage, so a mocked `sql` would prove nothing about it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  CONTRACT_TRIAGE_GRACE_HOURS,
  measureContractTriage,
  recordContractTriageDisposition,
  validateContractTriageDisposition,
  type PlanScopeProbe,
} from '../contract-triage';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-ctriage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const RUN = Math.random().toString(36).slice(2, 8);
const PLAN = (suffix: string) => `zzz-ctriage-plan-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
const NOW = new Date('2026-10-10T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The fixture harness is not a registered Hive home, so the real scope probe is replaced (D-030). */
const REACHABLE: PlanScopeProbe = async () => 'reachable';

/** The armed migration that creates the ledger — applied idempotently to the test DB. */
const MIGRATION = new URL(
  '../../../../../../libs/papercusp/libs/db/sql/1446-plan-contract-triage.sql',
  import.meta.url,
);

let fx: PlanPgFixture;
let admin: postgres.Sql;
let workspaceId: string;

function body(slug: string, status: string): string {
  return `---\ntitle: ${slug}\nslug: ${slug}\nstatus: ${status}\n---\n\n## Phase 1\n\n- **P-001** \`todo\` work\n`;
}

/** A plan with the given status, created `ageMs` before NOW, optionally carrying a contract. */
async function seed(slug: string, opts: { ageMs: number; status?: string; contract?: boolean }): Promise<void> {
  const status = opts.status ?? 'active';
  await seedPlan(admin, workspaceId, HARNESS, slug, body(slug, status));
  // harness_plans_acceptance_bar_seed_pin_complete: a contract is all five pin columns or none,
  // and the hash must be 64 lowercase hex. The measurement reads only the hash.
  const contract = opts.contract === true;
  await admin`
    UPDATE harness_shared.harness_plans
       SET status = ${status},
           created_at = ${new Date(NOW.getTime() - opts.ageMs).toISOString()}::timestamptz,
           acceptance_bar_set_hash = ${contract ? createHash('sha256').update(`bar-${slug}`).digest('hex') : null},
           acceptance_bar_rubric_slug = ${contract ? 'zzz-ctriage-rubric' : null},
           acceptance_bar_rubric_revision = ${contract ? 1 : null},
           acceptance_bar_seeded_at = ${contract ? NOW.toISOString() : null}::timestamptz,
           acceptance_bar_seeded_by = ${contract ? 'su-test' : null}
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
  `;
}

const record = (planSlug: string, disposition: string, reason: string) =>
  recordContractTriageDisposition(admin, {
    workspaceId, harnessSlug: HARNESS, planSlug, disposition, reason,
    evidenceRef: 'D-013', recordedBy: 'su-test', now: NOW,
  });

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  workspaceId = fx.workspaceId;
  await admin.unsafe(readFileSync(MIGRATION, 'utf8'));
});

afterEach(async () => {
  await admin`
    DELETE FROM harness_shared.plan_contract_triage
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS}
  `;
  await cleanupPlans(admin, workspaceId, HARNESS);
});

afterAll(async () => {
  await fx?.dispose();
});

describe('P-004 measureContractTriage', () => {
  it('counts uncovered active plans past grace and shared closure reasons, and nothing else', async () => {
    const uncovered = PLAN('uncovered');
    const contracted = PLAN('contract');
    const exempt = PLAN('exempt');
    const young = PLAN('young');
    const ownClosure = PLAN('own');
    const bulkA = PLAN('bulk-a');
    const bulkB = PLAN('bulk-b');

    await seed(uncovered, { ageMs: 30 * DAY });
    await seed(contracted, { ageMs: 30 * DAY, contract: true });
    await seed(exempt, { ageMs: 30 * DAY });
    expect(await record(exempt, 'exempt', `operational runbook, no product claims ${RUN}`)).toMatchObject({ ok: true });
    await seed(young, { ageMs: 2 * HOUR });

    await seed(ownClosure, { ageMs: 40 * DAY, status: 'superseded' });
    expect(await record(ownClosure, 'closed', `folded into a later plan ${RUN}`)).toMatchObject({ ok: true });

    // A bulk closure that pasted ONE reason onto two plans. The writer refuses this, so the
    // second row is inserted directly — the measurement must still catch a row that reached
    // the ledger some other way.
    await seed(bulkA, { ageMs: 40 * DAY, status: 'superseded' });
    await seed(bulkB, { ageMs: 40 * DAY, status: 'superseded' });
    const pasted = `stale plan ${RUN}`;
    expect(await record(bulkA, 'closed', pasted)).toMatchObject({ ok: true });
    await admin`
      INSERT INTO harness_shared.plan_contract_triage
        (workspace_id, harness_slug, plan_slug, disposition, reason, recorded_by)
      VALUES (${workspaceId}, ${HARNESS}, ${bulkB}, 'closed', ${`  Stale   PLAN ${RUN} `}, 'su-test')
    `;

    const m = await measureContractTriage(admin, { workspaceId, harnessSlug: HARNESS, now: NOW, planScope: REACHABLE });
    expect(m).toEqual({
      // The harness has a Hive plan scope, so nothing is unreachable (D-030).
      unreachablePlans: 0,
      unreachablePlanRefs: [],
      // Active plans examined: uncovered, contracted, exempt, young.
      activePlansConsidered: 4,
      // uncovered + young; young is inside its grace window.
      uncoveredActivePlansRaw: 2,
      uncoveredActivePlans: 1,
      // Both halves of the pasted reason (whitespace/case-normalised) count as missing.
      closureReasonMissing: 2,
      triageGaps: 3,
      thresholds: { graceHours: CONTRACT_TRIAGE_GRACE_HOURS },
    });
  });

  it('starts counting a plan the moment its grace window closes', async () => {
    const slug = PLAN('edge');
    await seed(slug, { ageMs: CONTRACT_TRIAGE_GRACE_HOURS * HOUR - HOUR });
    const inside = await measureContractTriage(admin, { workspaceId, harnessSlug: HARNESS, now: NOW, planScope: REACHABLE });
    expect(inside).toMatchObject({ uncoveredActivePlans: 0, uncoveredActivePlansRaw: 1 });

    const after = new Date(NOW.getTime() + 2 * HOUR);
    const past = await measureContractTriage(admin, { workspaceId, harnessSlug: HARNESS, now: after, planScope: REACHABLE });
    expect(past).toMatchObject({ uncoveredActivePlans: 1, triageGaps: 1 });
  });

  it('D-030: reports uncovered plans in a harness with no Hive plan scope as unreachable, never as gaps', async () => {
    const old = PLAN('orphan-old');
    const young = PLAN('orphan-young');
    const contracted = PLAN('orphan-contract');
    await seed(old, { ageMs: 30 * DAY });
    await seed(young, { ageMs: 2 * HOUR });
    await seed(contracted, { ageMs: 30 * DAY, contract: true });
    const asked: string[] = [];
    const noScope: PlanScopeProbe = async (ws, harness) => {
      asked.push(`${ws}:${harness}`);
      return 'no-plan-scope';
    };

    const m = await measureContractTriage(admin, { workspaceId, harnessSlug: HARNESS, now: NOW, planScope: noScope });
    expect(m).toMatchObject({
      // The denominator still counts every active plan examined (D-019).
      activePlansConsidered: 3,
      uncoveredActivePlans: 0,
      uncoveredActivePlansRaw: 0,
      triageGaps: 0,
      // Both uncovered plans, regardless of grace; the contracted one is not uncovered.
      unreachablePlans: 2,
      unreachablePlanRefs: [`${HARNESS}/${old}`, `${HARNESS}/${young}`].sort(),
    });
    // One probe per harness, scoped to the measured workspace.
    expect(asked).toEqual([`${workspaceId}:${HARNESS}`]);
  });

  it('D-030: a scope-probe fault fails the measurement instead of hiding the plans', async () => {
    await seed(PLAN('fault'), { ageMs: 30 * DAY });
    const fault: PlanScopeProbe = async () => {
      throw new Error('registry read unavailable');
    };
    await expect(
      measureContractTriage(admin, { workspaceId, harnessSlug: HARNESS, now: NOW, planScope: fault }),
    ).rejects.toThrow(/registry read unavailable/);
  });

  it('reads an empty scope as zero plans considered, distinguishable from a clean scope', async () => {
    const m = await measureContractTriage(admin, { workspaceId, harnessSlug: HARNESS, now: NOW, planScope: REACHABLE });
    expect(m).toMatchObject({ activePlansConsidered: 0, triageGaps: 0, unreachablePlans: 0 });
  });
});

describe('P-004 recordContractTriageDisposition', () => {
  it('refuses every disposition that would not settle the plan', async () => {
    const active = PLAN('active');
    const contracted = PLAN('contracted');
    const closedA = PLAN('closed-a');
    const closedB = PLAN('closed-b');
    await seed(active, { ageMs: 30 * DAY });
    await seed(contracted, { ageMs: 30 * DAY, contract: true });
    await seed(closedA, { ageMs: 30 * DAY, status: 'superseded' });
    await seed(closedB, { ageMs: 30 * DAY, status: 'superseded' });

    expect(await record(active, 'drop', 'x')).toMatchObject({ ok: false, code: 'contract_triage_disposition_invalid' });
    expect(await record(active, 'exempt', '   ')).toMatchObject({ ok: false, code: 'contract_triage_reason_missing' });
    expect(await record(PLAN('missing'), 'exempt', 'r')).toMatchObject({ ok: false, code: 'contract_triage_plan_not_found' });
    expect(await record(contracted, 'exempt', 'r')).toMatchObject({ ok: false, code: 'contract_triage_has_contract' });
    expect(await record(active, 'closed', 'still running')).toMatchObject({ ok: false, code: 'contract_triage_not_closed' });

    const reason = `duplicate of another plan ${RUN}`;
    expect(await record(closedA, 'closed', reason)).toMatchObject({
      ok: true, replaced: false, record: { disposition: 'closed', closedToStatus: 'superseded' },
    });
    expect(await record(closedB, 'closed', ` DUPLICATE of another   plan ${RUN}`)).toMatchObject({
      ok: false, code: 'contract_triage_reason_shared',
    });
    // Re-recording the SAME plan with its own reason is a replacement, not a share.
    expect(await record(closedA, 'closed', reason)).toMatchObject({ ok: true, replaced: true });
  });

  it('upserts: a later disposition replaces the plan\'s earlier one', async () => {
    const slug = PLAN('upsert');
    await seed(slug, { ageMs: 30 * DAY });
    expect(await record(slug, 'exempt', `first reason ${RUN}`)).toMatchObject({ ok: true, replaced: false });
    expect(await record(slug, 'exempt', `second reason ${RUN}`)).toMatchObject({ ok: true, replaced: true });
    const rows = await admin<{ reason: string }[]>`
      SELECT reason FROM harness_shared.plan_contract_triage
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
    `;
    expect(rows.map((r) => r.reason)).toEqual([`second reason ${RUN}`]);
  });
});

describe('P-004 validateContractTriageDisposition', () => {
  it('never coerces an unknown disposition and trims the reason and evidence', () => {
    expect(validateContractTriageDisposition({ disposition: 'backfilled', reason: 'r' })).toMatchObject({
      ok: false, code: 'contract_triage_disposition_invalid',
    });
    expect(validateContractTriageDisposition({ disposition: ' exempt ', reason: ' r ', evidenceRef: '  ' })).toEqual({
      ok: true, disposition: 'exempt', reason: 'r', evidenceRef: null,
    });
  });
});
