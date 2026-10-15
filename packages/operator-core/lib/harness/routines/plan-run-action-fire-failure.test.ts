/**
 * WI-10004731 — a scheduled fire that throws AFTER its seed transaction
 * committed must be recorded as failed, not left `running` with zero
 * work-items for reconcile to settle as done/success.
 *
 * Measured 2026-10-01: plan-cleanup-recurring-sweep-2026-09-01 fired on
 * 09-07, 09-14 and 10-01; each fire was refused by promotion
 * (plan_run_acceptance_bar_blocked on 10-01) and each plan_runs row read
 * done/success.
 */
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  promote: vi.fn(),
  retire: vi.fn(),
}));

vi.mock('../../plan-workitem-promotion-run', () => ({ promotePlanItems: H.promote }));
// The retirement itself (status + items + plan_items index) is pinned by
// retire-run-instance-plan.test.ts and the reconcile integration test; here we only
// pin that the fire-failure path ROUTES through it rather than a bare status UPDATE
// (WI-10005040: a bare UPDATE left the instance's plan_items open forever).
vi.mock('./retire-run-instance-plan', () => ({ retireRunInstancePlan: H.retire }));
vi.mock('../../pot-membership', () => ({ routineStorageSlug: async (slug: string) => slug }));

import { recordScheduledFireFailure, runScheduledPlanFire } from './plan-run-action';

interface Recorded {
  text: string;
  values: unknown[];
}

/** A tagged-template `sql` double that records every statement it is handed. */
function fakeSql(prepared: Record<string, unknown>) {
  const calls: Recorded[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve([]);
  }) as unknown as Sql & { begin: unknown };
  (sql as unknown as { begin: unknown }).begin = async () => prepared;
  return { sql: sql as unknown as Sql, calls };
}

const PREPARED = {
  started: true,
  instanceSlug: 'plan-cleanup-recurring-sweep-2026-09-01@run-1790819461432',
  runId: 1320,
  runSeq: 3,
  replayed: false,
  itemKind: 'feature',
  runInputs: null,
  appHarnessSlug: 'papercusp',
  execution: null,
};

const OPTS = {
  installSlug: 'papercusp',
  workspaceId: 'papercusp-workspace',
  templateSlug: 'plan-cleanup-recurring-sweep-2026-09-01',
};

beforeEach(() => {
  H.promote.mockReset();
  H.retire.mockReset();
  H.retire.mockResolvedValue({ retired: true, itemsClosed: 0 });
});

describe('runScheduledPlanFire — a fire that throws after its seed transaction', () => {
  it('records the plan_runs row FAILED with the error, retires the instance, and rethrows', async () => {
    H.promote.mockResolvedValue({
      promoted: 0,
      skipped: 0,
      workItems: [],
      acceptanceBarBlocked: true,
      acceptanceBarLifecycle: { codes: ['acceptance_bar_contract_missing'] },
    });
    const { sql, calls } = fakeSql(PREPARED);

    await expect(runScheduledPlanFire(sql, OPTS)).rejects.toThrow(/plan_run_acceptance_bar_blocked/);

    const runUpdate = calls.find((c) => c.text.startsWith('UPDATE harness_shared.plan_runs'));
    expect(runUpdate?.text).toMatch(/status = 'failed', outcome = 'failed'/);
    expect(runUpdate?.values).toContain(1320);
    expect(runUpdate?.values.join(' ')).toMatch(/fire failed: plan_run_acceptance_bar_blocked/);
    // No bare status UPDATE on the instance — retirement goes through the helper.
    expect(calls.some((c) => c.text.startsWith('UPDATE harness_shared.harness_plans'))).toBe(false);
    expect(H.retire).toHaveBeenCalledTimes(1);
    expect(H.retire).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: OPTS.workspaceId,
      planStorageSlug: 'papercusp',
      instanceSlug: PREPARED.instanceSlug,
      templateSlug: OPTS.templateSlug,
      outcome: 'failed',
    });
  });

  it('control: a fire whose promotion succeeds writes no failure', async () => {
    H.promote.mockResolvedValue({ promoted: 1, skipped: 0, workItems: [{ workItemId: 'WI-1', actionable: true }] });
    const { sql, calls } = fakeSql(PREPARED);

    const result = await runScheduledPlanFire(sql, OPTS);

    expect(result).toMatchObject({ started: true, runId: 1320, workItemIds: ['WI-1'] });
    expect(calls.some((c) => c.text.includes("status = 'failed'"))).toBe(false);
    expect(H.retire).not.toHaveBeenCalled();
  });

  it('still rethrows the ORIGINAL error when recording the failure itself fails', async () => {
    H.promote.mockRejectedValue(new Error('promotion exploded'));
    const broken = Object.assign(
      (() => Promise.reject(new Error('pg down'))) as unknown as Sql,
      { begin: async () => PREPARED },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(runScheduledPlanFire(broken, OPTS)).rejects.toThrow('promotion exploded');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not record failed fire/));
    warn.mockRestore();
  });
});

describe('recordScheduledFireFailure', () => {
  it('only touches a still-running row, so a concurrent settle wins', async () => {
    const { sql, calls } = fakeSql(PREPARED);
    await recordScheduledFireFailure(sql, {
      runId: 9,
      workspaceId: 'ws',
      appHarnessSlug: 'papercusp',
      instanceSlug: 'x@run-1',
      templateSlug: 'x',
      error: 'boom',
    });
    expect(calls[0]?.text).toMatch(/WHERE id = \? AND status = 'running'/);
  });
});
