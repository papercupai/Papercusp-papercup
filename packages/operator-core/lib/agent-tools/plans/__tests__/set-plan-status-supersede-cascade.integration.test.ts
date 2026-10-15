/**
 * set-plan-status-supersede-cascade.integration.test.ts — review-system-rework-reduction-2026-09-23
 * P-030 (spec RSR-P-030-A), driven through the REAL plans:set-plan-status handler and Postgres.
 *
 * Probe (from the spec's falsifier): supersede a plan with an open carrier item in another plan,
 * then read the carrier's claimability and the carrier plan's readiness. Before P-030 the
 * carrier stayed claimable (it drew 1,840 calls on 09-21/22 after its subject was superseded)
 * and nothing re-evaluated the carrier plan's readiness.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/set-plan-status-supersede-cascade.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import setPlanStatusTool from '../set-plan-status';
import { MOOT_CARRIER_NOW_MARK } from '../plan-scope-cascade';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HARNESS = `zzz-sps-cascade-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SUBJECT = 'zzz-cascade-subject-2026-09-23';
const CARRIER_PLAN = 'zzz-cascade-carrier-2026-09-23';
const WS = DEFAULT_WORKSPACE_ID;
const CARRIER_ID = `WI-zzz-cascade-carrier-${Date.now()}`;
const UNRELATED_ID = `WI-zzz-cascade-unrelated-${Date.now()}`;
// A second harness holding a carrier with the SAME title and plan slugs: a different plan,
// so superseding SUBJECT in HARNESS must not touch it (the leak a killed run exposed 2026-09-23).
const OTHER_HARNESS = `${HARNESS}-other`;
const OTHER_CARRIER_ID = `WI-zzz-cascade-other-carrier-${Date.now()}`;

function planBody(slug: string, status: 'draft' | 'ready'): string {
  return `---
title: ${slug}
slug: ${slug}
created: 2026-09-23
updated: 2026-09-23
status: ${status}
---

# ${slug}

## Now

**State:** Author state for ${slug}.

**Next:** Author next for ${slug}.

## Background

prose
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: 'agent-sps-cascade-test', workspaceId: WS },
  } as never;
}

async function insertItem(id: string, title: string, planItem: string, harness: string = HARNESS): Promise<void> {
  await admin`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts,
       payload, source_plan_slug, source_plan_item_ids)
    VALUES (${harness}, ${id}, 'feature', ${title}, 'open', NULL, ${WS}, 0, 0,
       '{}'::jsonb, ${CARRIER_PLAN}, ${[planItem]}::text[])`;
}

async function cleanupItems(): Promise<void> {
  await admin`DELETE FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND harness_slug IN (${HARNESS}, ${OTHER_HARNESS})`;
}

/** The self-select floor claim_next / scheduler:get_next apply (claimHoldExclusionSql). */
async function selfSelectable(id: string, harness: string = HARNESS): Promise<boolean> {
  const rows = await admin<{ ok: boolean }[]>`
    SELECT (COALESCE(payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM 'true') AS ok
      FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND feature_id = ${id}`;
  return rows[0]?.ok ?? false;
}

async function planContent(slug: string): Promise<string> {
  const rows = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  return rows[0]?.content ?? '';
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 60_000);

afterAll(async () => {
  await cleanupItems().catch(() => {});
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await cleanupPlans(admin, WS, OTHER_HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupItems().catch(() => {});
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await cleanupPlans(admin, WS, OTHER_HARNESS).catch(() => {});
  await seedPlan(admin, WS, HARNESS, SUBJECT, planBody(SUBJECT, 'draft'));
  await seedPlan(admin, WS, HARNESS, CARRIER_PLAN, planBody(CARRIER_PLAN, 'ready'));
  // This harness has no seeded plan, so it needs its own canonical Pot identity.
  await registerHarnessProject(admin, WS, OTHER_HARNESS);
  await insertItem(CARRIER_ID, `Ship ${SUBJECT}: rebuild its acceptance chain`, 'P-001');
  await insertItem(UNRELATED_ID, 'Land the repair queue admission fix', 'P-002');
  await insertItem(OTHER_CARRIER_ID, `Ship ${SUBJECT}: rebuild its acceptance chain`, 'P-001', OTHER_HARNESS);
});

describe('plans:set-plan-status → superseded runs the P-030 scope cascade', () => {
  it('requires a real Pot for the other harness and cleans both fixture identities', async () => {
    const controlId = `${OTHER_CARRIER_ID}-membership-control`;
    await admin`DELETE FROM harness_shared.pots
      WHERE workspace_id = ${WS} AND pot_home_slug = ${OTHER_HARNESS}`;
    await expect(insertItem(controlId, 'Membership control', 'P-003', OTHER_HARNESS))
      .rejects.toThrow('pot-membership violation');

    await registerHarnessProject(admin, WS, OTHER_HARNESS);
    await insertItem(controlId, 'Membership control', 'P-003', OTHER_HARNESS);
    expect(await selfSelectable(controlId, OTHER_HARNESS)).toBe(true);

    await cleanupItems();
    await cleanupPlans(admin, WS, HARNESS);
    await cleanupPlans(admin, WS, OTHER_HARNESS);
    const identities = await admin`SELECT pot_home_slug FROM harness_shared.pots
      WHERE workspace_id = ${WS} AND pot_home_slug IN (${HARNESS}, ${OTHER_HARNESS})`;
    expect(identities).toEqual([]);
  });

  it('parks the moot carrier out of self-select, leaves the unrelated item claimable, and stamps readiness into the carrier plan Now', async () => {
    // Calibration: before the supersede, both items are self-selectable.
    expect(await selfSelectable(CARRIER_ID)).toBe(true);
    expect(await selfSelectable(UNRELATED_ID)).toBe(true);
    expect(await selfSelectable(OTHER_CARRIER_ID, OTHER_HARNESS)).toBe(true);

    const res = (await setPlanStatusTool.handler(
      { harness: HARNESS, slug: SUBJECT, status: 'superseded' } as never,
      makeCtx(),
    )) as { data: { results: Array<Record<string, unknown>> } };
    const out = res.data.results[0] as {
      ok: boolean;
      scopeCascade?: {
        carriers: Array<{ id: string; parked: boolean }>;
        carrierPlans: Array<{ slug: string; gate: { satisfied: boolean | null; code: string | null }; nowStamped: boolean }>;
        error?: string;
      };
    };

    expect(out.ok).toBe(true);
    expect(out.scopeCascade?.error).toBeUndefined();
    expect(out.scopeCascade?.carriers).toEqual([expect.objectContaining({ id: CARRIER_ID, parked: true })]);
    expect(await selfSelectable(CARRIER_ID)).toBe(false);
    expect(await selfSelectable(UNRELATED_ID)).toBe(true);
    // The same-slug carrier in another harness belongs to a different plan: untouched.
    expect(await selfSelectable(OTHER_CARRIER_ID, OTHER_HARNESS)).toBe(true);

    // Readiness was measured in the same call and surfaced in the carrier plan's Now.
    const planRow = out.scopeCascade?.carrierPlans[0];
    expect(planRow?.slug).toBe(CARRIER_PLAN);
    expect(typeof planRow?.gate.satisfied).toBe('boolean');
    expect(planRow?.nowStamped).toBe(true);
    const carrierNow = await planContent(CARRIER_PLAN);
    expect(carrierNow).toContain(`${MOOT_CARRIER_NOW_MARK}: ${SUBJECT}`);
    expect(carrierNow).toContain(CARRIER_ID);
    expect(carrierNow).toContain(
      planRow?.gate.satisfied ? 'acceptance gate satisfied' : `acceptance gate BLOCKED: ${planRow?.gate.code}`,
    );
    expect(carrierNow).toContain(`Author next for ${CARRIER_PLAN}.`);
  });

  it('a re-application of superseded (no status change) does not cascade again', async () => {
    await setPlanStatusTool.handler({ harness: HARNESS, slug: SUBJECT, status: 'superseded' } as never, makeCtx());
    const res = (await setPlanStatusTool.handler(
      { harness: HARNESS, slug: SUBJECT, status: 'superseded' } as never,
      makeCtx(),
    )) as { data: { results: Array<Record<string, unknown>> } };

    expect(res.data.results[0]).not.toHaveProperty('scopeCascade');
  });
});
