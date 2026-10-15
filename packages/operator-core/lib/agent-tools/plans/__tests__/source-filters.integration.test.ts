/**
 * source-filters.integration.test.ts — the server-side recency/order/limit
 * filters on listPlanIndexRows (createdSince / updatedSince / order / limit),
 * against real Postgres. These let plans:list ask PG for "the N most-recent
 * plans" instead of fetching every row and post-filtering.
 *
 * Three plans seeded under a unique harness with controlled created_at /
 * updated_at (the mig-211 trigger RESPECTS an explicit updated_at write, so the
 * UPDATE stamps stick).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { listPlanIndexRows } from '../source';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-filt-${STAMP}`;
const WS = DEFAULT_WORKSPACE_ID;

const P_OLD = 'zzz-filt-old-2026-06-01';
const P_MID = 'zzz-filt-mid-2026-06-10';
const P_NEW = 'zzz-filt-new-2026-06-20';

const T_OLD = '2026-06-01T00:00:00.000Z';
const T_MID = '2026-06-10T00:00:00.000Z';
const T_NEW = '2026-06-20T00:00:00.000Z';

function body(slug: string): string {
  return `---
title: ${slug}
slug: ${slug}
created: 2026-06-01
updated: 2026-06-01
status: active
---

# ${slug}

## Now

**State:** seeded.

**Next:** read it back.

## Decisions
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;
let sourceId: string;

async function stamp(slug: string, ts: string): Promise<void> {
  await admin`
    UPDATE harness_shared.harness_plans
       SET created_at = ${ts}, updated_at = ${ts}
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
  `;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, WS, HARNESS, P_OLD, body(P_OLD));
  await seedPlan(admin, WS, HARNESS, P_MID, body(P_MID));
  await seedPlan(admin, WS, HARNESS, P_NEW, body(P_NEW));
  await admin`
    UPDATE harness_shared.harness_plans
       SET input_schema = '{"type":"object","properties":{"topic":{"type":"string"}}}'::jsonb
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${P_MID}`;
  const sources = await admin<Array<{ id: string }>>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES (${WS}, 'slack', 'ready')
    RETURNING id::text`;
  sourceId = sources[0].id;
  await admin`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
       action, armed)
    VALUES (
      ${WS}, ${sourceId}::uuid, ${HARNESS}, ${P_NEW}, 'ext:slack:mention',
      '{"type":"launch-plan"}'::jsonb, FALSE
    )`;
  await stamp(P_OLD, T_OLD);
  await stamp(P_MID, T_MID);
  await stamp(P_NEW, T_NEW);
}, 180_000);

afterAll(async () => {
  await admin`
    DELETE FROM harness_shared.trigger_bindings
     WHERE workspace_id = ${WS} AND plan_harness_slug = ${HARNESS}
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.data_sources
     WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
  `.catch(() => {});
  await fx?.dispose();
});

describe('listPlanIndexRows recency/order/limit filters', () => {
  const opts = { harnessSlug: HARNESS, workspaceId: WS };

  it('no filter returns all three', async () => {
    const rows = await listPlanIndexRows(opts);
    expect(rows.map((r) => r.planSlug).sort()).toEqual([P_MID, P_NEW, P_OLD].sort());
  });

  it('projects manual-input and disarmed external-binding presence without loading schema JSON', async () => {
    const rows = await listPlanIndexRows(opts);
    const bySlug = new Map(rows.map((row) => [row.planSlug, row]));
    expect(bySlug.get(P_OLD)).toMatchObject({ hasInputSchema: false, hasExternalTrigger: false });
    expect(bySlug.get(P_MID)).toMatchObject({ hasInputSchema: true, hasExternalTrigger: false });
    expect(bySlug.get(P_NEW)).toMatchObject({ hasInputSchema: false, hasExternalTrigger: true });
    // The hot list projection carries only the boolean; the JSON schema stays undetoasted.
    expect(bySlug.get(P_MID)?.inputSchema).toBeNull();
  });

  it('drops a soft-detached binding from derived trigger presence', async () => {
    await admin`
      UPDATE harness_shared.trigger_bindings
         SET detached_at = now()
       WHERE workspace_id = ${WS} AND plan_harness_slug = ${HARNESS} AND plan_slug = ${P_NEW}`;
    const rows = await listPlanIndexRows(opts);
    expect(rows.find((row) => row.planSlug === P_NEW)).toMatchObject({ hasExternalTrigger: false });
    await admin`
      UPDATE harness_shared.trigger_bindings
         SET detached_at = NULL
       WHERE workspace_id = ${WS} AND plan_harness_slug = ${HARNESS} AND plan_slug = ${P_NEW}`;
  });

  it('createdSince filters server-side (>= mid → mid + new)', async () => {
    const rows = await listPlanIndexRows({ ...opts, createdSince: T_MID });
    expect(rows.map((r) => r.planSlug).sort()).toEqual([P_MID, P_NEW].sort());
  });

  it('updatedSince filters server-side (mid-window → only new)', async () => {
    const rows = await listPlanIndexRows({ ...opts, updatedSince: '2026-06-15T00:00:00.000Z' });
    expect(rows.map((r) => r.planSlug)).toEqual([P_NEW]);
  });

  it('order:"updated" returns most-recent first', async () => {
    const rows = await listPlanIndexRows({ ...opts, order: 'updated' });
    expect(rows.map((r) => r.planSlug)).toEqual([P_NEW, P_MID, P_OLD]);
  });

  it('limit caps the result (top-N by order)', async () => {
    const rows = await listPlanIndexRows({ ...opts, order: 'updated', limit: 1 });
    expect(rows.map((r) => r.planSlug)).toEqual([P_NEW]);
  });
});
