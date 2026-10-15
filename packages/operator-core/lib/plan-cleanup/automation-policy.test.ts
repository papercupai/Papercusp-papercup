import { describe, expect, it } from 'vitest';
import type { BulkAutomationPolicy } from '../attention/bulk-dispositions';
import type { CleanupFinding } from './scanner';
import { cleanupAutomationEligibility, cleanupFindingRisk } from './automation-policy';

const automatic: BulkAutomationPolicy = {
  mode: 'safe-high', level: 'L2', minConfidence: 'medium',
  riskLevels: { low: 'automatic', medium: 'automatic', high: 'automatic' },
};
function finding(kind: CleanupFinding['kind'], provable = false): CleanupFinding {
  return { kind, confidence: provable ? 'provable' : 'recommended', autoApply: provable,
    autoApplyBlockedBy: provable ? null : 'judgment-call' } as CleanupFinding;
}

describe('cleanup risk autonomy', () => {
  it('keeps shipment and worklist enlistment in the highest risk band', () => {
    expect(cleanupFindingRisk('finish-plan')).toBe('high');
    expect(cleanupFindingRisk('enlist-plan')).toBe('high');
    expect(cleanupFindingRisk('archive-candidate')).toBe('medium');
    expect(cleanupFindingRisk('cleared-blocker')).toBe('low');
  });
  it('honors mixed risk choices independently of the legacy launcher level', () => {
    const mixed = { ...automatic, riskLevels: { low: 'automatic', medium: 'review', high: 'review' } } as BulkAutomationPolicy;
    expect(cleanupAutomationEligibility(mixed, finding('cleared-blocker', true)).allowed).toBe(true);
    expect(cleanupAutomationEligibility(mixed, finding('flip-to-done', true))).toMatchObject({ allowed: false, reason: 'risk-review' });
    expect(cleanupAutomationEligibility(mixed, finding('finish-plan', true)).allowed).toBe(false);
  });
  it('allows executable judgment recommendations only under an explicit risk grant', () => {
    expect(cleanupAutomationEligibility(automatic, finding('archive-candidate')).allowed).toBe(true);
    expect(cleanupAutomationEligibility({ mode: 'safe-high', level: 'L2', minConfidence: 'medium' }, finding('archive-candidate')).allowed).toBe(false);
    expect(cleanupAutomationEligibility(null, finding('archive-candidate')).allowed).toBe(false);
  });
  it('keeps evidence confidence independent of full risk autonomy', () => {
    expect(cleanupAutomationEligibility({ ...automatic, minConfidence: 'high' }, finding('archive-candidate'))).toMatchObject({ allowed: false, reason: 'confidence-below-floor' });
    expect(cleanupAutomationEligibility(automatic, finding('archive-candidate'), 'insufficient').allowed).toBe(false);
  });
  it('never overrides a live plan hold', () => {
    const held = { ...finding('archive-candidate'), autoApplyBlockedBy: 'live-agents' as const };
    expect(cleanupAutomationEligibility(automatic, held)).toMatchObject({ allowed: false, reason: 'live-agents' });
  });

  it('requires owner selection for an enlistment even under full risk autonomy', () => {
    const enlist = { ...finding('enlist-plan', true), action: {
      kind: 'enlist-plan' as const, goalId: 'picked-goal', planRef: 'plan:h/unpicked',
      worklist: ['plan:h/picked'], expectedVersion: 16, ownerSelectionRequired: true,
    } };
    for (const policy of [automatic, null, { mode: 'safe-high', minConfidence: 'high' } as BulkAutomationPolicy]) {
      expect(cleanupAutomationEligibility(policy, enlist))
        .toMatchObject({ allowed: false, reason: 'owner-selection', risk: 'high' });
    }
    expect(cleanupAutomationEligibility(automatic, {
      ...enlist, action: { ...enlist.action, ownerSelectionRequired: false },
    }).allowed).toBe(true);
  });
});
