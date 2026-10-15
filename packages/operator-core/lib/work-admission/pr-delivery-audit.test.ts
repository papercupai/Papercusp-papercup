import { describe, expect, it } from 'vitest';
import { auditPrDelivery, inspectPrDeliveryRow, prDeliveryAuditScopeSchema } from './pr-delivery-audit';

const rule = '57f548d3-f246-41b0-8888-24992ba725ef';
const row = { id: 'EI-1', harness: 'subject', ruleId: rule, state: 'wip', authority: null, payload: {} };

describe('PR-delivery cohort evidence', () => {
  const projects = async () => [];
  it('does not pass an empty or missing-rule population', async () => {
    for (const missingRuleIds of [[], [rule]]) {
      const result = await auditPrDelivery('ws', { ruleIds: [rule] }, { projects,
        population: async () => ({ rows: [], total: 0, missingRuleIds }) });
      expect(result.verdict).toBe('unknown');
    }
  });
  it('does not infer a complete cohort from a bounded page', async () => {
    const result = await auditPrDelivery('ws', { ruleIds: [rule] }, { projects,
      population: async () => ({ rows: [row], total: 101, missingRuleIds: [] }) });
    expect(result).toMatchObject({ verdict: 'unknown', complete: false, population: 101, pending: 1 });
  });
  it('marks unresolved work-item identities unknown rather than pending', async () => {
    const result = await auditPrDelivery('ws', { ruleIds: [rule] }, { projects,
      population: async () => ({ rows: [{ ...row, state: null as unknown as string }], total: 1, missingRuleIds: [] }) });
    expect(result.verdict).toBe('unknown');
  });
  it('distinguishes pending work from an uncommitted terminal completion', async () => {
    expect(await inspectPrDeliveryRow(row, undefined, { host: null })).toMatchObject({ verdict: 'pending' });
    expect(await inspectPrDeliveryRow({ ...row, state: 'done' }, undefined, { host: null }))
      .toMatchObject({ verdict: 'unknown', reason: 'The fix completion is not committed.' });
  });
  it('requires explicit canonical rule identities', () => {
    expect(prDeliveryAuditScopeSchema.safeParse({ ruleIds: [] }).success).toBe(false);
    expect(prDeliveryAuditScopeSchema.safeParse({ ruleIds: ['guess'] }).success).toBe(false);
  });
  it('does not accept a terminal assertion without a content receipt', async () => {
    const result = await auditPrDelivery('ws', { ruleIds: [rule] }, { projects,
      population: async () => ({ rows: [{ ...row, state: 'done', authority: 'committed' }], total: 1, missingRuleIds: [] }) });
    expect(result.verdict).toBe('unknown');
    expect(result.rows[0]?.reason).toBe('No valid completion content receipt.');
  });
});
