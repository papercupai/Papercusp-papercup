/**
 * P-025 — acceptance ownership handoff is transactional.
 *
 * The plan lifecycle flip and its keyed acceptance task must commit together.
 * A rollback must leave neither side behind, and a retry must not overwrite a
 * claim already held by the acceptance driver.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { ensureAcceptanceDrainCarryInTransaction, ensureAcceptanceDrainFiling } from '../acceptance-drain-filing';
import { applyPlanDrainTransition } from '../plan-drain-transition';
import { withPlanLock } from '../with-plan-lock';
import {
  cleanupPlans,
  registerHarnessProject,
  seedPlan,
  setupPlanPgFixture,
  type PlanPgFixture,
} from './_pg-tool-fixture';

const HARNESS = `zzz-carry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PLAN = (suffix: string) => `zzz-carry-plan-${suffix}-${Math.random().toString(36).slice(2, 8)}`;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let workspaceId: string;

function body(slug: string): string {
  return `---
title: ${slug}
slug: ${slug}
status: ready
created: 2026-09-20
updated: 2026-09-20
---

## Phase 1

- **P-001** \`done\` implementation
`;
}

async function cleanupAcceptanceRows(): Promise<void> {
  await admin`
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${HARNESS}
  `;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  workspaceId = fx.workspaceId;
});

afterEach(async () => {
  await cleanupAcceptanceRows();
  await cleanupPlans(admin, workspaceId, HARNESS);
});

afterAll(async () => {
  await fx?.dispose();
});

describe('P-025 transactional acceptance carry', () => {
  it('commits awaiting-acceptance and the keyed carry item together', async () => {
    const slug = PLAN('commit');
    await registerHarnessProject(admin, workspaceId, HARNESS);
    await seedPlan(admin, workspaceId, HARNESS, slug, body(slug));

    const result = await applyPlanDrainTransition(slug, HARNESS, {
      accountableOwnerId: 'su-carry-driver',
    });

    // A refused move names its door in `skipped`/`blindReview`; surface it on failure.
    expect(result.skipped, JSON.stringify(result)).toBeUndefined();
    expect(result).toMatchObject({
      applied: true,
      from: 'ready',
      to: 'awaiting-acceptance',
      acceptanceCarry: { outcome: 'created' },
    });
    const plans = await admin<{ status: string }[]>`
      SELECT status FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
    `;
    const items = await admin<{
      feature_id: string;
      status: string;
      condition_key: string | null;
      taken_by: string | null;
      payload: Record<string, unknown>;
    }[]>`
      SELECT feature_id, status, condition_key, taken_by, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${HARNESS}
         AND payload->>'acceptanceDrainPlan' = ${`${workspaceId}/${HARNESS}/${slug}`}
    `;

    expect(plans).toEqual([{ status: 'awaiting-acceptance' }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'open',
      condition_key: `acceptance-drain:${HARNESS}/${slug}`,
      taken_by: 'su-carry-driver',
      payload: { gateObservation: 'pending', blockerCode: null },
    });
  }, 60_000);

  it('gates the plan under its registered workspace when the ambient workspace differs — WI-6554700010010577', async () => {
    // The plan lives in the fixture workspace. Point the process-level workspace
    // (activeWorkspaceId()'s env pin) elsewhere: the blind review gate must read the
    // plan under the scope the plan lock resolved, or it finds no plan and refuses
    // the move as blind_review_unavailable.
    const slug = PLAN('ambient');
    await registerHarnessProject(admin, workspaceId, HARNESS);
    await seedPlan(admin, workspaceId, HARNESS, slug, body(slug));
    const prev = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = 'zzz-ambient-not-the-plan-workspace';
    let result: Awaited<ReturnType<typeof applyPlanDrainTransition>>;
    try {
      result = await applyPlanDrainTransition(slug, HARNESS, { accountableOwnerId: 'su-carry-driver' });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = prev;
    }
    expect(result.skipped, JSON.stringify(result)).toBeUndefined();
    expect(result).toMatchObject({ applied: true, to: 'awaiting-acceptance', acceptanceCarry: { outcome: 'created' } });
  }, 60_000);

  it('rolls back both records when the coupled handoff is interrupted', async () => {
    const slug = PLAN('rollback');
    await registerHarnessProject(admin, workspaceId, HARNESS);
    await seedPlan(admin, workspaceId, HARNESS, slug, body(slug));

    await expect(
      withPlanLock<{ ok: true }>(
        null,
        {
          slug,
          harnessSlug: HARNESS,
          workspaceId,
          intent: 'P-025 rollback probe',
          inTransaction: async (tx, _writtenBody, scope) => {
            await ensureAcceptanceDrainCarryInTransaction(tx, {
              workspaceId: scope.workspaceId,
              harnessSlug: scope.harnessSlug,
              planSlug: slug,
            });
            throw new Error('simulated handoff interruption');
          },
        },
        async (current) => ({
          newBody: current!.replace('status: ready', 'status: awaiting-acceptance'),
          value: { ok: true as const },
        }),
      ),
    ).rejects.toThrow('simulated handoff interruption');

    const plans = await admin<{ status: string }[]>`
      SELECT status FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
    `;
    const items = await admin`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${HARNESS}
         AND payload->>'acceptanceDrainPlan' = ${`${workspaceId}/${HARNESS}/${slug}`}
    `;
    // The fixture seeds canonical content; its derived status column is NULL
    // until a real lifecycle write populates it. Rollback must preserve that
    // exact pre-write value rather than inventing a baseline.
    expect(plans).toEqual([{ status: null }]);
    expect(items).toEqual([]);
  }, 60_000);

  it('does not overwrite a held acceptance claim on a keyed retry', async () => {
    const slug = PLAN('claim');
    await registerHarnessProject(admin, workspaceId, HARNESS);
    await seedPlan(admin, workspaceId, HARNESS, slug, body(slug));
    await applyPlanDrainTransition(slug, HARNESS, { accountableOwnerId: 'driver-a' });

    await admin.begin(async (tx) =>
      ensureAcceptanceDrainCarryInTransaction(tx, {
        workspaceId,
        harnessSlug: HARNESS,
        planSlug: slug,
        accountableOwnerId: 'driver-b',
      }),
    );

    const rows = await admin<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${HARNESS}
         AND payload->>'acceptanceDrainPlan' = ${`${workspaceId}/${HARNESS}/${slug}`}
    `;
    expect(rows).toEqual([{ taken_by: 'driver-a' }]);
  }, 60_000);

  it('mints no carry for a template instance (a scheduled run plan) — WI-6554700010010577', async () => {
    const slug = PLAN('instance');
    await registerHarnessProject(admin, workspaceId, HARNESS);
    await seedPlan(admin, workspaceId, HARNESS, slug, body(slug));
    // A run instance is a plan cloned from a template: the gate skips it
    // ('template-instance') and retireRunInstancePlan supersedes it when the run settles.
    await admin`
      UPDATE harness_shared.harness_plans SET template_slug = 'zzz-carry-template'
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
    `;

    const result = await applyPlanDrainTransition(slug, HARNESS, { accountableOwnerId: 'su-carry-driver' });
    expect(result).toMatchObject({
      applied: true,
      to: 'awaiting-acceptance',
      acceptanceCarry: { outcome: 'exempt-template-instance', id: null },
    });
    // The direct handoff (the plans:set-status caller's path) reports the same exemption.
    const direct = await admin.begin(async (tx) =>
      ensureAcceptanceDrainCarryInTransaction(tx, {
        workspaceId,
        harnessSlug: HARNESS,
        planSlug: slug,
        accountableOwnerId: 'su-carry-driver',
      }),
    );
    expect(direct).toMatchObject({ outcome: 'exempt-template-instance', id: null });

    const items = await admin`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${HARNESS}
         AND payload->>'acceptanceDrainPlan' = ${`${workspaceId}/${HARNESS}/${slug}`}
    `;
    expect(items).toEqual([]);
  }, 60_000);

  it('refreshes one keyed filing across blocker changes and readiness while preserving age evidence', async () => {
    const slug = PLAN('refresh');
    await registerHarnessProject(admin, workspaceId, HARNESS);
    await seedPlan(admin, workspaceId, HARNESS, slug, body(slug));
    await applyPlanDrainTransition(slug, HARNESS);

    const ref = `${workspaceId}/${HARNESS}/${slug}`;
    const first = new Date('2026-09-20T00:00:00.000Z');
    const blocked = await ensureAcceptanceDrainFiling({
      workspaceId,
      harnessSlug: HARNESS,
      planSlug: slug,
      code: 'acceptance_unaudited',
      message: 'run plans:audit',
      observation: { satisfied: false, code: 'acceptance_unaudited', message: 'run plans:audit' },
      observedAt: first,
    });
    expect(blocked).toMatchObject({ outcome: 'already-open' });

    const readyAt = new Date('2026-09-20T13:00:00.000Z');
    await ensureAcceptanceDrainFiling({
      workspaceId,
      harnessSlug: HARNESS,
      planSlug: slug,
      code: null,
      message: 'ready',
      observation: { satisfied: true, rubricId: 'rubric-refresh', gradedBy: 'peer' },
      observedAt: readyAt,
    });

    const rows = await admin<{ status: string; payload: Record<string, unknown> }[]>`
      SELECT status, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND payload->>'acceptanceDrainPlan' = ${ref}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.payload).toMatchObject({
      acceptanceDrainPlan: ref,
      gateObservation: 'ready',
      blockerCode: null,
      rubricId: 'rubric-refresh',
      firstObservedAt: readyAt.toISOString(),
      lastObservedAt: readyAt.toISOString(),
      ageMs: 0,
      escalation: 'none',
    });
  }, 60_000);
});
