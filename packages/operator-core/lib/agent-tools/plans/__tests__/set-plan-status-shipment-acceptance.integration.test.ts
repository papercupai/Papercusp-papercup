/**
 * The database must reject shipped status writes that bypass the plan
 * acceptance gate, while the canonical handler carries its successful gate
 * receipt through the real withPlanLock transaction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  evaluatePlanAcceptanceGate: vi.fn(),
  reconcileStaleAcceptanceBarSubjectPin: vi.fn(),
}));
vi.mock('../../../plan-acceptance-gate', () => ({
  evaluatePlanAcceptanceGate: mocks.evaluatePlanAcceptanceGate,
  messageWithAdditionalBlockers: (message?: string) => message ?? '',
}));
vi.mock('../../../acceptance-bar-pin-reconcile', () => ({
  reconcileStaleAcceptanceBarSubjectPin: mocks.reconcileStaleAcceptanceBarSubjectPin,
}));

import setPlanStatusTool from '../set-plan-status';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, cleanupPlans, seedPlan, type PlanPgFixture } from './_pg-tool-fixture';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = `zzz-sps-acceptance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'zzz-sps-acceptance-plan-2026-10-01';
const WS = DEFAULT_WORKSPACE_ID;
const ACTOR = 'agent-status-acceptance-test';
const SQL_PATH = path.resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql/1279-plan-shipment-acceptance-gate-receipt.sql');
const MIGRATION_PATH = existsSync(SQL_PATH) ? SQL_PATH : `${SQL_PATH}.DRAFT`;
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

function planBody(): string {
  return `---
title: Acceptance Guard Plan
slug: ${SLUG}
created: 2026-10-01
updated: 2026-10-01
status: ready
---

# Acceptance Guard Plan

## Now

**State:** The implementation is complete and verified.

**Next:** Prepare the accepted release.

## Background

This plan has a complete implementation record.

## Decisions
`;
}

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: ACTOR, workspaceId: WS },
  } as never;
}

async function runStatus(options: { dryRun?: boolean } = {}) {
  const res = (await setPlanStatusTool.handler({
    harness: HARNESS,
    slug: SLUG,
    status: 'shipped',
    ...(options.dryRun ? { dryRun: true } : {}),
  } as never, makeCtx())) as {
    data: { results: Record<string, unknown>[]; counts?: { failed?: number } };
  };
  return {
    data: res.data.results[0]!,
    isError: (res.data.counts?.failed ?? 0) > 0,
  };
}

async function storedPlan(): Promise<{ content: string; status: string }> {
  const rows = await admin<{ content: string; status: string }[]>`
    SELECT content, status
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  return rows[0]!;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await admin.unsafe(migrationSql);
}, 60_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await seedPlan(admin, WS, HARNESS, SLUG, planBody());
  await admin`
    UPDATE harness_shared.harness_plans
       SET status = 'ready'
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
  `;
  mocks.evaluatePlanAcceptanceGate.mockReset().mockResolvedValue({ satisfied: true });
  mocks.reconcileStaleAcceptanceBarSubjectPin.mockReset().mockResolvedValue({
    reconciled: false,
    reason: 'no_witness',
  });
});

describe('plans:set-plan-status — database acceptance receipt', () => {
  it('rolls back a direct shipped status update without the gate receipt', async () => {
    await expect(admin.begin(async (tx) => {
      await tx`
        UPDATE harness_shared.harness_plans
           SET status = 'shipped'
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
      `;
    })).rejects.toThrow(/requires a matching acceptance gate receipt/i);

    await expect(storedPlan()).resolves.toMatchObject({ status: 'ready' });
  });

  it('commits a ship through the real handler after its acceptance gate passes', async () => {
    const { data, isError } = await runStatus();

    expect(isError, JSON.stringify({ data })).toBe(false);
    expect(data).toMatchObject({ ok: true, changed: true, newStatus: 'shipped' });
    await expect(storedPlan()).resolves.toMatchObject({
      status: 'shipped',
      content: expect.stringContaining('status: shipped'),
    });
  });

  it('reconciles a stale pre-grading subject pin and re-evaluates before returning the next blocker', async () => {
    mocks.evaluatePlanAcceptanceGate
      .mockResolvedValueOnce({
        satisfied: false,
        code: 'acceptance_bar_contract_not_ready',
        blockingPhase: 'pre-grading',
        blockingPhaseLifecycle: { codes: ['bar_snapshot_rubric_revision_mismatch'] },
      })
      .mockResolvedValueOnce({
        satisfied: false,
        code: 'acceptance_bar_contract_not_ready',
        acceptanceBarLifecycle: { codes: ['bar_snapshot_method_missing'] },
      });
    mocks.reconcileStaleAcceptanceBarSubjectPin.mockResolvedValueOnce({
      reconciled: true,
      fromRevision: 1,
      toRevision: 2,
      witness: 'pinned_revision',
    });

    const { data, isError } = await runStatus();

    expect(isError).toBe(true);
    expect(mocks.reconcileStaleAcceptanceBarSubjectPin).toHaveBeenCalledWith({
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: SLUG,
    });
    expect(mocks.evaluatePlanAcceptanceGate).toHaveBeenCalledTimes(2);
    expect(data).toMatchObject({
      ok: false,
      error: 'acceptance_bar_contract_not_ready',
      acceptanceBarLifecycle: { codes: ['bar_snapshot_method_missing'] },
    });
    await expect(storedPlan()).resolves.toMatchObject({ status: 'ready' });
  });

  it('keeps dry-run ship checks read-only when the BAR pin is stale', async () => {
    mocks.evaluatePlanAcceptanceGate.mockResolvedValue({
      satisfied: false,
      code: 'acceptance_bar_contract_not_ready',
      blockingPhase: 'pre-grading',
      blockingPhaseLifecycle: { codes: ['bar_snapshot_rubric_revision_mismatch'] },
    });

    await runStatus({ dryRun: true });

    expect(mocks.reconcileStaleAcceptanceBarSubjectPin).not.toHaveBeenCalled();
    await expect(storedPlan()).resolves.toMatchObject({ status: 'ready' });
  });
});
