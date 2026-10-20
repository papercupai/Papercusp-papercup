/**
 * The verification-profile backfill keeps every existing outcome
 * (plan-verification-profiles-2026-10-17 P-002, requirement R-6).
 *
 * Runs `backfillPlanVerificationProfiles` against the integration-tier baseline PG with real
 * plan rows and real completion-audit history, then checks:
 *   - the R-6 rule: code audits -> coding, all-not-code audits -> general, others -> the harness
 *     default (D-005), with the audit HISTORY folded newest-pass-first;
 *   - a declared stamp is never overwritten and a second run updates nothing;
 *   - the write keeps the federation row clock, origin and updated_at (migration 1537);
 *   - the real ship gate returns the same verdict before and after the backfill.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { runWithWorkspace } from '../../../workspace-als';
import {
  backfillPlanVerificationProfiles,
  classifyAuditHistory,
  diffShipVerdicts,
  SHIP_VERDICT_CENSUS_GATE_OPTS,
  shipVerdictSnapshot,
  type ShipVerdictSnapshot,
} from '../verification-profile-backfill';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-vpbackfill-${RUN}`;
const GENERAL_HARNESS = `zzz-vpbackfill-gen-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;

const SLUG = {
  code: `vpb-code-${RUN}`,
  notCode: `vpb-notcode-${RUN}`,
  historyNotCode: `vpb-history-notcode-${RUN}`,
  historyCode: `vpb-history-code-${RUN}`,
  none: `vpb-none-${RUN}`,
  declared: `vpb-declared-${RUN}`,
  remote: `vpb-remote-${RUN}`,
  shipped: `vpb-shipped-${RUN}`,
  generalHarness: `vpb-genharness-${RUN}`,
};

let fx: PlanPgFixture;
let admin: postgres.Sql;

function planBody(slug: string): string {
  return `---\ntitle: ${slug}\nslug: ${slug}\nstatus: shipped\n---\n\n# ${slug}\n\n## Work\n`
    + '- **P-001** `done` First item\n- **P-002** `done` Second item\n';
}

async function seed(harness: string, slug: string): Promise<void> {
  await seedPlan(admin, WS, harness, slug, planBody(slug));
}

async function audit(slug: string, harness: string, seq: number, items: Array<{ itemId: string; verdict: string }>) {
  // Persisted audit entries always carry `citations` (the gate's code-truth leg reads them).
  const entries = items.map((item) => ({
    ...item,
    citations: item.verdict === 'not-code' || item.verdict === 'dropped'
      ? [{ kind: 'none', reason: 'fixture: no code deliverable' }]
      : [],
  }));
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, items)
    VALUES (${WS}, ${harness}, ${slug}, ${seq}, 'vpb-test', 'completion', ${admin.json(entries as never)})
  `;
}

async function profileOf(harness: string, slug: string) {
  const [row] = await admin<Array<{ verification_profile: string | null; verification_profile_source: string | null }>>`
    SELECT verification_profile, verification_profile_source FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND plan_slug = ${slug}`;
  return row;
}

async function clockOf(harness: string, slug: string) {
  const [row] = await admin<Array<{ fed_ts: string | null; fed_hlc: string | null; origin: string | null; updated_at: Date }>>`
    SELECT fed_ts::text, fed_hlc, origin, updated_at FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND plan_slug = ${slug}`;
  return row;
}

async function shipVerdicts(harness: string, slugs: string[]): Promise<ShipVerdictSnapshot[]> {
  const { evaluatePlanAcceptanceGate } = await import('../../../plan-acceptance-gate');
  const out: ShipVerdictSnapshot[] = [];
  for (const planSlug of slugs) {
    const gate = await runWithWorkspace(WS, () =>
      evaluatePlanAcceptanceGate(planSlug, { harnessSlug: harness, ...SHIP_VERDICT_CENSUS_GATE_OPTS }),
    );
    out.push(shipVerdictSnapshot({ workspaceId: WS, harnessSlug: harness, planSlug }, gate));
  }
  return out;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  for (const slug of [SLUG.code, SLUG.notCode, SLUG.historyNotCode, SLUG.historyCode, SLUG.none, SLUG.declared, SLUG.remote]) {
    await seed(HARNESS, slug);
  }
  await seed(GENERAL_HARNESS, SLUG.generalHarness);
  // An already-shipped plan. Inserted with its status (the shipment-receipt trigger guards an
  // UPDATE of status, not an insert), so the census has a real `shipped` row to re-evaluate.
  await admin`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, origin, status)
    VALUES (${WS}, ${HARNESS}, ${SLUG.shipped}, ${planBody(SLUG.shipped)}, md5(${planBody(SLUG.shipped)}), 1, 'local', 'shipped')`;

  // A code audit: one implemented item is enough, even beside a not-code one.
  await audit(SLUG.code, HARNESS, 1, [{ itemId: 'P-001', verdict: 'implemented' }, { itemId: 'P-002', verdict: 'not-code' }]);
  // All live items not-code; a dropped entry is not live and does not decide.
  await audit(SLUG.notCode, HARNESS, 1, [{ itemId: 'P-001', verdict: 'not-code' }, { itemId: 'P-002', verdict: 'dropped' }]);
  // History: a newer pass re-audits P-001 as not-code, so the old `implemented` no longer counts.
  await audit(SLUG.historyNotCode, HARNESS, 1, [{ itemId: 'P-001', verdict: 'implemented' }]);
  await audit(SLUG.historyNotCode, HARNESS, 2, [{ itemId: 'P-001', verdict: 'not-code' }]);
  // History: a newer subset pass covers only P-002; P-001's older `implemented` entry still counts.
  await audit(SLUG.historyCode, HARNESS, 1, [{ itemId: 'P-001', verdict: 'implemented' }]);
  await audit(SLUG.historyCode, HARNESS, 2, [{ itemId: 'P-002', verdict: 'not-code' }]);
  // A declared stamp that contradicts its audit must survive.
  await audit(SLUG.declared, HARNESS, 1, [{ itemId: 'P-001', verdict: 'implemented' }]);
  await admin`
    UPDATE harness_shared.harness_plans
       SET verification_profile = 'general', verification_profile_source = 'declared'
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG.declared}`;
  // A plan received from a peer: moving the wire clock explicitly is respected verbatim.
  await admin`
    UPDATE harness_shared.harness_plans
       SET origin = 'remote', fed_ts = fed_ts + 1
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG.remote}`;
}, 120_000);

afterAll(async () => {
  if (!admin) return;
  const slugs = Object.values(SLUG);
  await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND plan_slug IN ${admin(slugs)}`;
  await cleanupPlans(admin, WS, HARNESS);
  await cleanupPlans(admin, WS, GENERAL_HARNESS);
  await fx.dispose();
});

describe('classifyAuditHistory (R-6 rule)', () => {
  it('classes code, all-not-code and none', () => {
    expect(classifyAuditHistory([{ verdict: 'implemented' }, { verdict: 'not-code' }])).toBe('code');
    expect(classifyAuditHistory([{ verdict: 'missing' }])).toBe('code');
    expect(classifyAuditHistory([{ verdict: 'not-code' }, { verdict: 'dropped' }])).toBe('all-not-code');
    expect(classifyAuditHistory([{ verdict: 'dropped' }])).toBe('none');
    expect(classifyAuditHistory([])).toBe('none');
    expect(classifyAuditHistory(null)).toBe('none');
  });
});

describe('diffShipVerdicts', () => {
  const base = { workspaceId: 'w', harnessSlug: 'h' };
  it('reports a satisfied flip, a code change and a one-sided error, and nothing for an identical verdict', () => {
    const before: ShipVerdictSnapshot[] = [
      { ...base, planSlug: 'same', satisfied: false, code: 'acceptance_ungraded' },
      { ...base, planSlug: 'flip', satisfied: true, code: null },
      { ...base, planSlug: 'recode', satisfied: false, code: 'acceptance_ungraded' },
      { ...base, planSlug: 'threw', satisfied: null, code: null },
      { ...base, planSlug: 'gone', satisfied: true, code: null },
      { ...base, planSlug: 'blockers', satisfied: false, code: 'acceptance_ungraded', blockers: ['acceptance_ungraded'] },
    ];
    const after: ShipVerdictSnapshot[] = [
      { ...base, planSlug: 'same', satisfied: false, code: 'acceptance_ungraded' },
      { ...base, planSlug: 'flip', satisfied: false, code: 'acceptance_ungraded' },
      { ...base, planSlug: 'recode', satisfied: false, code: 'acceptance_unaudited' },
      { ...base, planSlug: 'threw', satisfied: null, code: null, error: 'boom' },
      { ...base, planSlug: 'new', satisfied: true, code: null },
      {
        ...base, planSlug: 'blockers', satisfied: false, code: 'acceptance_ungraded',
        blockers: ['acceptance_unaudited', 'acceptance_ungraded'],
      },
    ];
    const diff = diffShipVerdicts(before, after);
    expect(diff.compared).toBe(5);
    expect(diff.unchanged).toBe(1);
    expect(diff.changed.map((c) => c.key).sort()).toEqual(['w/h/blockers', 'w/h/flip', 'w/h/recode', 'w/h/threw']);
    expect(diff.onlyBefore).toEqual(['w/h/gone']);
    expect(diff.onlyAfter).toEqual(['w/h/new']);
  });
});

describe('backfillPlanVerificationProfiles against PG (R-6)', () => {
  it('backfills by audit history and harness default, keeps the clock and the ship verdict, and is idempotent', async () => {
    const gateSlugs = Object.values(SLUG).filter((s) => s !== SLUG.generalHarness);
    const clocksBefore = {
      remote: await clockOf(HARNESS, SLUG.remote),
      none: await clockOf(HARNESS, SLUG.none),
    };
    const verdictsBefore = await shipVerdicts(HARNESS, gateSlugs);

    // The census must RE-EVALUATE a shipped plan. The ordinary gate read skips it as already
    // shipped (always satisfied), which would make a before/after comparison measure nothing.
    const { evaluatePlanAcceptanceGate } = await import('../../../plan-acceptance-gate');
    const plain = await runWithWorkspace(WS, () => evaluatePlanAcceptanceGate(SLUG.shipped, { harnessSlug: HARNESS }));
    expect(plain.skipped).toBe('already-shipped');
    const shippedCensus = verdictsBefore.find((v) => v.planSlug === SLUG.shipped);
    expect(shippedCensus?.skipped).toBeNull();
    expect(shippedCensus?.satisfied).toBe(false);
    expect(shippedCensus?.blockers?.length).toBeGreaterThan(0);

    // A dry run writes nothing.
    const dry = await backfillPlanVerificationProfiles(admin, { workspaceId: WS, harnessSlug: HARNESS });
    expect(dry.executed).toBe(false);
    expect(dry.updated).toBe(0);
    expect((await profileOf(HARNESS, SLUG.code))?.verification_profile).toBeNull();

    // The real harness resolver: this throwaway harness has no blueprint, so D-005 fails safe to coding.
    const report = await backfillPlanVerificationProfiles(admin, { workspaceId: WS, harnessSlug: HARNESS, execute: true });
    expect(report.candidates).toBe(7);
    expect(report.updated).toBe(7);
    const basisBySlug = Object.fromEntries(report.rows.map((r) => [r.planSlug, `${r.profile}/${r.basis}`]));
    expect(basisBySlug).toEqual({
      [SLUG.code]: 'coding/code-audit',
      [SLUG.notCode]: 'general/all-not-code-audit',
      [SLUG.historyNotCode]: 'general/all-not-code-audit',
      [SLUG.historyCode]: 'coding/code-audit',
      [SLUG.none]: 'coding/harness-default:harness-unresolved',
      [SLUG.remote]: 'coding/harness-default:harness-unresolved',
      [SLUG.shipped]: 'coding/harness-default:harness-unresolved',
    });
    expect(await profileOf(HARNESS, SLUG.code)).toEqual({ verification_profile: 'coding', verification_profile_source: 'backfill' });
    expect(await profileOf(HARNESS, SLUG.notCode)).toEqual({ verification_profile: 'general', verification_profile_source: 'backfill' });
    expect(await profileOf(HARNESS, SLUG.declared)).toEqual({ verification_profile: 'general', verification_profile_source: 'declared' });

    // Migration 1537: a profile-only write keeps the row clock, the origin and updated_at.
    expect(await clockOf(HARNESS, SLUG.remote)).toEqual(clocksBefore.remote);
    expect(await clockOf(HARNESS, SLUG.none)).toEqual(clocksBefore.none);
    expect(clocksBefore.remote?.origin).toBe('remote');

    // The ship verdict of every plan is unchanged by the backfill.
    const verdictsAfter = await shipVerdicts(HARNESS, gateSlugs);
    const diff = diffShipVerdicts(verdictsBefore, verdictsAfter);
    expect(diff.compared).toBe(gateSlugs.length);
    expect(diff.changed).toEqual([]);

    // A second run finds nothing left to do.
    const again = await backfillPlanVerificationProfiles(admin, { workspaceId: WS, harnessSlug: HARNESS, execute: true });
    expect(again.candidates).toBe(0);
    expect(again.updated).toBe(0);
  }, 120_000);

  it('a non-coding harness defaults an unaudited plan to general', async () => {
    const report = await backfillPlanVerificationProfiles(admin, {
      workspaceId: WS,
      harnessSlug: GENERAL_HARNESS,
      execute: true,
      isCoding: async () => false,
    });
    expect(report.rows.map((r) => `${r.planSlug}:${r.profile}/${r.basis}`)).toEqual([
      `${SLUG.generalHarness}:general/harness-default:non-coding-harness`,
    ]);
    expect(await profileOf(GENERAL_HARNESS, SLUG.generalHarness)).toEqual({
      verification_profile: 'general',
      verification_profile_source: 'backfill',
    });
  });
});
