/**
 * P-005 (verification-system-improvements-2026-10-10, D-013 / D-015 / D-018):
 * stale awaiting-acceptance plans are surfaced by the drain, owe exactly one
 * typed disposition, and are counted by a measurement that cannot read 0 while
 * the drain is dead.
 *
 * Runs against the real schema: the measurement is SQL over harness_plans +
 * work_items, so a unit test with a mocked `sql` would prove nothing about it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { ensureAcceptanceDrainFiling } from '../acceptance-drain-filing';
import {
  ACCEPTANCE_NEVER_SURFACED_AFTER_DAYS,
  measureStaleAcceptance,
  recordAcceptanceDrainDisposition,
} from '../acceptance-drain-disposition';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './_pg-tool-fixture';
import { runWithWorkspace } from '../../../workspace-als';

const HARNESS = `zzz-stale-acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
/** A second harness the D-029 case treats as excluded by the work-scope policy. */
const OUT_HARNESS = `${HARNESS}-out`;
const PLAN = (suffix: string) => `zzz-stale-plan-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
const NOW = new Date('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let workspaceId: string;

function isoDay(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
}

function body(slug: string): string {
  return `---\ntitle: ${slug}\nslug: ${slug}\nstatus: awaiting-acceptance\n---\n\n## Phase 1\n\n- **P-001** \`done\` implementation\n`;
}

/** A plan in `awaiting-acceptance` whose last recorded write was `idleDays` before NOW. */
async function seedAwaiting(
  slug: string,
  idleDays: number,
  status = 'awaiting-acceptance',
  harness: string = HARNESS,
): Promise<void> {
  await seedPlan(admin, workspaceId, harness, slug, body(slug));
  await admin`
    UPDATE harness_shared.harness_plans
       SET status = ${status}, updated = ${isoDay(idleDays)}
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harness} AND plan_slug = ${slug}
  `;
}

/** One drain pass over the plan, as the sweep makes it (with the plan's write date). */
async function drainPass(slug: string, idleDays: number, observedAt: Date) {
  // The CREATE path is an issue-family (kind 'task') write, which resolves its Pot and
  // workspace from the ambient request scope, not from `workspaceId` (issuesScopeWorkspace).
  // Run it inside the fixture workspace, exactly as the sweep runs inside its own.
  const res = await runWithWorkspace(workspaceId, () => ensureAcceptanceDrainFiling({
    workspaceId,
    harnessSlug: HARNESS,
    planSlug: slug,
    code: 'acceptance_unaudited',
    message: 'run plans:audit',
    observation: { satisfied: false, code: 'acceptance_unaudited', message: 'run plans:audit' },
    planUpdated: isoDay(idleDays),
    observedAt,
  }));
  // The filing writer swallows its own failure into outcome:'error'; surface the
  // message so a broken seed reads as its cause, not as a wrong outcome string.
  if (res.outcome === 'error') throw new Error(`ensureAcceptanceDrainFiling failed: ${res.error}`);
  return res;
}

async function filingFor(slug: string) {
  const rows = await admin<{ feature_id: string; title: string; payload: Record<string, unknown> }[]>`
    SELECT feature_id, title, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${HARNESS}
       AND payload->>'planSlug' = ${slug}
     ORDER BY created_ts
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  workspaceId = fx.workspaceId;
});

afterEach(async () => {
  await admin`
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS}
  `;
  await cleanupPlans(admin, workspaceId, HARNESS);
  await cleanupPlans(admin, workspaceId, OUT_HARNESS);
});

afterAll(async () => {
  await fx?.dispose();
});

describe('P-005 stale acceptance surfacing', () => {
  it('stamps staleSurfacedAt once and retitles the filing for a plan idle past 14 days', async () => {
    const slug = PLAN('stale');
    await seedAwaiting(slug, 30);

    const first = await drainPass(slug, 30, NOW);
    expect(first).toMatchObject({ outcome: 'created' });
    const created = await filingFor(slug);
    expect(created.payload.staleSurfacedAt).toBe(NOW.toISOString());
    expect(created.payload.dispositionRequired).toBe(true);
    expect(created.title).toMatch(/^Disposition stale plan '/);
    expect(created.title).toContain('regrade | repair | accept-risk | drop');

    // A later pass must not move the stamp forward: that would restart the
    // grace window on every sweep and pin the stale count at zero forever.
    const later = new Date(NOW.getTime() + 2 * DAY);
    expect((await drainPass(slug, 30, later)).outcome).toBe('already-open');
    const again = await filingFor(slug);
    expect(again.payload.staleSurfacedAt).toBe(NOW.toISOString());
    expect(again.payload.dispositionRequired).toBe(true);
  });

  it('does not stamp a plan idle 14 days or fewer', async () => {
    const slug = PLAN('fresh');
    await seedAwaiting(slug, 5);
    expect((await drainPass(slug, 5, NOW)).outcome).toBe('created');
    const row = await filingFor(slug);
    expect(row.payload.staleSurfacedAt).toBeUndefined();
    expect(row.payload.dispositionRequired).toBeUndefined();
    expect(row.title).not.toMatch(/^Disposition stale plan/);
  });
});

describe('P-005 typed acceptance disposition', () => {
  it('refuses an out-of-set kind, missing evidence, a missing reason, and an unfiled plan', async () => {
    const slug = PLAN('refuse');
    await seedAwaiting(slug, 30);
    const base = { workspaceId, harnessSlug: HARNESS, planSlug: slug, recordedBy: 'su-test' };

    expect(await recordAcceptanceDrainDisposition(admin, {
      ...base, kind: 'regrade', evidenceRef: 'WI-1', reason: 'x',
    })).toMatchObject({ ok: false, code: 'acceptance_disposition_no_filing' });

    await drainPass(slug, 30, NOW);
    expect(await recordAcceptanceDrainDisposition(admin, {
      ...base, kind: 'approve', evidenceRef: 'WI-1', reason: 'x',
    })).toMatchObject({ ok: false, code: 'acceptance_disposition_kind_invalid' });
    expect(await recordAcceptanceDrainDisposition(admin, {
      ...base, kind: 'drop', evidenceRef: '  ', reason: 'x',
    })).toMatchObject({ ok: false, code: 'acceptance_disposition_evidence_missing' });
    expect(await recordAcceptanceDrainDisposition(admin, {
      ...base, kind: 'drop', evidenceRef: 'WI-1', reason: '',
    })).toMatchObject({ ok: false, code: 'acceptance_disposition_reason_missing' });

    const row = await filingFor(slug);
    expect(row.payload.acceptanceDisposition).toBeUndefined();
    expect(row.payload.dispositionRequired).toBe(true);
  });

  it('records the disposition on the filing, clears dispositionRequired, and a later pass keeps it cleared', async () => {
    const slug = PLAN('record');
    await seedAwaiting(slug, 30);
    await drainPass(slug, 30, NOW);
    const base = { workspaceId, harnessSlug: HARNESS, planSlug: slug, recordedBy: 'su-test', now: NOW };

    const dropped = await recordAcceptanceDrainDisposition(admin, {
      ...base, kind: 'drop', evidenceRef: 'WI-10008292', reason: 'superseded by a later plan',
    });
    expect(dropped).toMatchObject({ ok: true, replaced: null, disposition: { kind: 'drop', evidenceRef: 'WI-10008292' } });

    const row = await filingFor(slug);
    expect(row.payload.dispositionRequired).toBe(false);
    expect(row.payload.acceptanceDisposition).toMatchObject({
      kind: 'drop', evidenceRef: 'WI-10008292', reason: 'superseded by a later plan', recordedBy: 'su-test',
    });

    const regraded = await recordAcceptanceDrainDisposition(admin, {
      ...base, kind: 'regrade', evidenceRef: 'scorecard-1', reason: 'grade it after all',
    });
    expect(regraded).toMatchObject({ ok: true, replaced: { kind: 'drop' } });

    await drainPass(slug, 30, new Date(NOW.getTime() + DAY));
    const after = await filingFor(slug);
    expect(after.payload.dispositionRequired).toBe(false);
    expect(after.payload.acceptanceDisposition).toMatchObject({ kind: 'regrade' });
    expect(after.title).not.toMatch(/^Disposition stale plan/);
  });
});

describe('P-005 measureStaleAcceptance', () => {
  it('counts surfaced-past-grace and never-surfaced plans, and nothing else', async () => {
    const withinGrace = PLAN('grace');
    const pastGrace = PLAN('past');
    const dispositioned = PLAN('disp');
    const neverSurfaced = PLAN('never');
    const youngUnfiled = PLAN('young');
    const notAwaiting = PLAN('ready');

    await seedAwaiting(withinGrace, 30);
    await drainPass(withinGrace, 30, new Date(NOW.getTime() - 3_600_000));

    await seedAwaiting(pastGrace, 30);
    await drainPass(pastGrace, 30, new Date(NOW.getTime() - 4 * DAY));

    await seedAwaiting(dispositioned, 30);
    await drainPass(dispositioned, 30, new Date(NOW.getTime() - 4 * DAY));
    expect(await recordAcceptanceDrainDisposition(admin, {
      workspaceId, harnessSlug: HARNESS, planSlug: dispositioned, recordedBy: 'su-test',
      kind: 'accept-risk', evidenceRef: 'D-015', reason: 'risk accepted',
    })).toMatchObject({ ok: true });

    // The drain never reached these two: one is old enough that a dead drain must show.
    await seedAwaiting(neverSurfaced, ACCEPTANCE_NEVER_SURFACED_AFTER_DAYS + 1);
    await seedAwaiting(youngUnfiled, 10);
    await seedAwaiting(notAwaiting, 40, 'ready');

    const m = await measureStaleAcceptance(admin, { workspaceId, harnessSlug: HARNESS, now: NOW });
    expect(m).toMatchObject({
      staleAcceptanceSurfaced: 1,
      staleAcceptanceNeverSurfaced: 1,
      staleAcceptanceUndispositioned: 2,
      // D-019 denominator: every non-archived, non-rubric plan in scope, ANY status —
      // including the `ready` one — so an empty or misfiltered scope reads 0 here, and
      // the health cell can report the stale metrics as unmeasured instead of a clean 0.
      acceptancePlansConsidered: 6,
      thresholds: { surfaceAfterDays: 14, graceDays: 3, neverSurfacedAfterDays: 17 },
    });
  });

  it('reads zero, as integers, when nothing in scope is stale', async () => {
    const m = await measureStaleAcceptance(admin, { workspaceId, harnessSlug: HARNESS, now: NOW });
    expect(m.staleAcceptanceSurfaced).toBe(0);
    expect(m.staleAcceptanceNeverSurfaced).toBe(0);
    expect(m.staleAcceptanceUndispositioned).toBe(0);
    // An empty scope must be distinguishable from a clean one (D-019).
    expect(m.acceptancePlansConsidered).toBe(0);
    expect(m.staleAcceptanceScopeExcluded).toBe(0);
  });

  it('D-029: counts stale plans in an out-of-scope harness as scope-excluded, never as stalls', async () => {
    const inScopeStale = PLAN('in-stale');
    const outStale = PLAN('out-stale');
    const outYoung = PLAN('out-young');
    await seedAwaiting(inScopeStale, ACCEPTANCE_NEVER_SURFACED_AFTER_DAYS + 1);
    await seedAwaiting(outStale, ACCEPTANCE_NEVER_SURFACED_AFTER_DAYS + 1, 'awaiting-acceptance', OUT_HARNESS);
    await seedAwaiting(outYoung, 10, 'awaiting-acceptance', OUT_HARNESS);
    // The same predicate the sweep applies (isHarnessInScope), injected: OUT_HARNESS is
    // outside the policy, everything else inside.
    const inScope = (slug: string) => slug !== OUT_HARNESS;

    // The excluded harness alone: its stale plan is reported, not counted as a stall, and
    // the D-019 denominator is 0, so the health cell reads the stale metric as unmeasured
    // rather than a passing 0 (D-029 point 3).
    const outOnly = await measureStaleAcceptance(admin, { workspaceId, harnessSlug: OUT_HARNESS, now: NOW, inScope });
    expect(outOnly).toMatchObject({
      staleAcceptanceSurfaced: 0,
      staleAcceptanceNeverSurfaced: 0,
      staleAcceptanceUndispositioned: 0,
      staleAcceptanceScopeExcluded: 1,
      acceptancePlansConsidered: 0,
    });

    const inOnly = await measureStaleAcceptance(admin, { workspaceId, harnessSlug: HARNESS, now: NOW, inScope });
    expect(inOnly).toMatchObject({
      staleAcceptanceNeverSurfaced: 1,
      staleAcceptanceUndispositioned: 1,
      staleAcceptanceScopeExcluded: 0,
      acceptancePlansConsidered: 1,
    });

    // Workspace-wide: the per-harness grouping routes OUT_HARNESS to the excluded count
    // (other harnesses in the fixture workspace are in scope, so only it can land there).
    const all = await measureStaleAcceptance(admin, { workspaceId, now: NOW, inScope });
    expect(all.staleAcceptanceScopeExcluded).toBe(1);
    expect(all.staleAcceptanceUndispositioned).toBeGreaterThanOrEqual(1);

    // Without an injected predicate and with no stored policy, nothing is excluded.
    const unscoped = await measureStaleAcceptance(admin, { workspaceId, harnessSlug: OUT_HARNESS, now: NOW });
    expect(unscoped).toMatchObject({ staleAcceptanceUndispositioned: 1, staleAcceptanceScopeExcluded: 0, acceptancePlansConsidered: 2 });
  });
});
