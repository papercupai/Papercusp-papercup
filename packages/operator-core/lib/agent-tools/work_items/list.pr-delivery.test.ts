import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('../../work-admission/pr-delivery-audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-admission/pr-delivery-audit')>()),
  auditPrDelivery: h.audit,
}));
import listTool, { shapeWorkItemsList } from './list';

const ruleId = '57f548d3-f246-41b0-8888-24992ba725ef';
const measurement = { verdict: 'fail', complete: true, population: 1, checked: 1, pending: 0,
  ruleIds: [ruleId], missingRuleIds: [], rows: [{ id: 'EI-1', harness: 'subject', ruleId,
    verdict: 'fail', reason: 'Fix reached upstream without a valid standing PR receipt.' }] };

describe('work_items:list actual PR-delivery audit option', () => {
  beforeEach(() => { h.audit.mockReset(); h.audit.mockResolvedValue(measurement); });
  it('measures the full explicit cohort freshly, without ordinary list filters or cached rows', async () => {
    const args = listTool.args.parse({ prDeliveryAudit: { ruleIds: [ruleId] }, state: 'wip', q: 'exclude all' });
    const read = listTool.handler as (args: unknown, ctx: unknown) => Promise<unknown>;
    const result = await read(args, { workspaceId: 'exact-workspace' });
    await read(args, { workspaceId: 'exact-workspace' });
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit).toHaveBeenCalledWith('exact-workspace', { ruleIds: [ruleId] });
    expect(result).toEqual({ data: { prDeliveryAudit: measurement } });
  });
  it('preserves the verdict and completeness contract in every output tier', async () => {
    const body = { prDeliveryAudit: measurement };
    for (const tier of ['standard', 'trimmed'] as const) expect(shapeWorkItemsList(body, tier)).toEqual(body);
    const validated = await listTool.result?.['~standard'].validate(body);
    expect(validated).toHaveProperty('value', body);
  });
});
