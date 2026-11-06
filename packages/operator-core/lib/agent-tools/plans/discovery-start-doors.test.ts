import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanRow } from './source';
import { PLAN_ADMISSION_DOORS } from './plan-admission-enforcement';

const h = vi.hoisted(() => ({
  row: vi.fn(), discovery: vi.fn(), lifecycle: vi.fn(), admission: vi.fn(), promote: vi.fn(),
}));
vi.mock('./source', async original => ({
  ...await original<typeof import('./source')>(), getPlanRow: h.row,
}));
vi.mock('../../plan-audits', async original => ({
  ...await original<typeof import('../../plan-audits')>(), withCurrentDiscovery: h.discovery,
}));
vi.mock('../../acceptance-bar-lifecycle-evaluator', async original => ({
  ...await original<typeof import('../../acceptance-bar-lifecycle-evaluator')>(),
  readAndEvaluateAcceptanceBarLifecycle: h.lifecycle,
}));
vi.mock('./plan-admission-gate', async original => ({
  ...await original<typeof import('./plan-admission-gate')>(), checkPlanAdmission: h.admission,
}));
vi.mock('../../plan-types/pins', async original => ({
  ...await original<typeof import('../../plan-types/pins')>(),
  withPinnedPlanTypes: async (_scope: unknown, read: () => Promise<unknown>) => read(),
}));
vi.mock('../../plan-workitem-promotion-run', async original => ({
  ...await original<typeof import('../../plan-workitem-promotion-run')>(), promotePlanItems: h.promote,
}));
vi.mock('../../pot-membership', async original => ({
  ...await original<typeof import('../../pot-membership')>(),
  routineStorageSlug: async (slug: string) => slug,
}));

import { checkPlanStartable } from './plan-start-gate';
import { runScheduledPlanFire } from '../../harness/routines/plan-run-action';

const scope = { workspaceId: 'discovery-door-workspace', harnessSlug: 'discovery-door-harness' };
const slug = 'discovery-door-plan';
const current = {
  ...scope, planSlug: slug, status: 'active', content: '# Plan\n', contentHash: 'a'.repeat(64),
  template: null, templateData: null, inputSchema: null,
} as PlanRow;
const refusal = { ok: false, error: 'discovery_not_ready',
  nextAction: 'Reconcile the changed feasibility finding before starting implementation.' };

beforeEach(() => {
  vi.clearAllMocks();
  h.row.mockResolvedValue(current);
  h.discovery.mockResolvedValue(refusal);
  h.lifecycle.mockResolvedValue({ satisfied: true, codes: [], blockingBars: [] });
  h.admission.mockResolvedValue({ admitted: true });
});

describe('current discovery at shared start and admission doors', () => {
  it.each(PLAN_ADMISSION_DOORS)('%s refuses before BAR repair or governance effects, then admits reconciled discovery', async door => {
    const denied = await checkPlanStartable(slug, scope, undefined, door);
    expect(denied).toMatchObject({ ok: false, kind: 'inputs', refusal: {
      code: 'discovery_not_ready', source: 'plan-discovery', hint: refusal.nextAction,
    } });
    expect(h.lifecycle).not.toHaveBeenCalled();
    expect(h.admission).not.toHaveBeenCalled();
    h.discovery.mockResolvedValueOnce({ ok: true, result: undefined });
    expect(await checkPlanStartable(slug, scope, undefined, door)).toMatchObject({ ok: true });
    expect(h.admission).toHaveBeenCalledWith(expect.objectContaining({ slug, door, row: current }));
    expect(h.discovery).toHaveBeenCalledWith(expect.objectContaining({ ...scope, planSlug: slug }), expect.any(Function));
  });

  it('propagates an unavailable discovery read without admitting the plan', async () => {
    h.discovery.mockRejectedValueOnce(new Error('source authority unavailable'));
    await expect(checkPlanStartable(slug, scope)).rejects.toThrow('source authority unavailable');
    expect(h.admission).not.toHaveBeenCalled();
  });
});

describe('scheduled, manual and event fires use the accepting transaction', () => {
  function transaction() {
    const queries: string[] = [];
    const tx = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim();
      queries.push(query);
      if (query.startsWith('SELECT content, content_hash')) return [{
        content: '# Plan\n', content_hash: 'a'.repeat(64), version: 1, title: 'Plan',
        template: null, template_data: null, input_schema: null, schedule: null, acceptance_bar_epoch: null,
      }];
      throw new Error(`Unexpected query before discovery admission: ${query}`);
    });
    const sql = Object.assign(tx, { begin: async (run: (client: unknown) => Promise<unknown>) => run(tx) });
    return { sql: sql as unknown as Sql, tx, queries };
  }

  it.each(['scheduled', 'manual', 'event'] as const)('%s refuses with no instance/run/promotion writes and resumes at admission after reconciliation', async trigger => {
    const { sql, tx, queries } = transaction();
    const options = { ...scope, installSlug: scope.harnessSlug, templateSlug: slug, trigger };
    expect(await runScheduledPlanFire(sql, options)).toMatchObject({
      started: false, reason: 'not-startable', minted: 0, runId: -1,
      detail: `discovery_not_ready: ${refusal.nextAction}`,
    });
    expect(h.discovery).toHaveBeenCalledWith(expect.objectContaining({ ...scope, planSlug: slug }),
      expect.any(Function), undefined, tx);
    expect(queries).toHaveLength(1);
    expect(h.admission).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();

    // Reaching the independent admission seam proves the positive route without
    // fabricating later instance/promotion transactions in this focused test.
    const admitted = new Error('reconciled discovery reached admission');
    h.discovery.mockResolvedValueOnce({ ok: true, result: undefined });
    h.admission.mockRejectedValueOnce(admitted);
    await expect(runScheduledPlanFire(sql, options)).rejects.toBe(admitted);
    expect(h.admission).toHaveBeenCalledWith(expect.objectContaining({ slug, door: 'scheduled' }));
    expect(h.promote).not.toHaveBeenCalled();
  });
});
