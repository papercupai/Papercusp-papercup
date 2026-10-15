/** Cleanup consumes the existing bulk risk policy and immutable run receipt. */
import {
  bulkAutomationEligibility,
  meetsBulkConfidenceFloor,
  type BulkAutomationPolicy,
  type BulkAutomationRisk,
  type BulkConfidence,
} from '../attention/bulk-dispositions';
import type { CleanupFinding } from './scanner';

export function cleanupFindingRisk(kind: CleanupFinding['kind']): BulkAutomationRisk {
  const risks: Record<CleanupFinding['kind'], BulkAutomationRisk> = {
    'enlist-plan': 'high',
    'finish-plan': 'high',
    'archive-candidate': 'medium',
    'flip-to-done': 'medium',
    'cleared-blocker': 'low',
    'orphaned-claim': 'low',
    'stale-now': 'low',
  };
  return risks[kind];
}

export function cleanupAutomationEligibility(
  policy: BulkAutomationPolicy | null,
  finding: CleanupFinding,
  confidence: BulkConfidence = finding.confidence === 'provable' ? 'high' : 'medium',
): { allowed: boolean; reason: string | null; risk: BulkAutomationRisk } {
  const risk = cleanupFindingRisk(finding.kind);
  if (finding.autoApplyBlockedBy === 'live-agents') return { allowed: false, reason: 'live-agents', risk };
  if (finding.kind === 'enlist-plan' && finding.action?.ownerSelectionRequired) {
    return { allowed: false, reason: 'owner-selection', risk };
  }
  if (!policy?.riskLevels) {
    const eligibility = policy ? bulkAutomationEligibility(policy, confidence) : { allowed: true, reason: null };
    return {
      allowed: finding.autoApply && eligibility.allowed,
      reason: !eligibility.allowed ? eligibility.reason : finding.autoApplyBlockedBy,
      risk,
    };
  }
  if (policy.riskLevels[risk] !== 'automatic') return { allowed: false, reason: 'risk-review', risk };
  if (!meetsBulkConfidenceFloor(confidence, policy.minConfidence)) {
    return { allowed: false, reason: 'confidence-below-floor', risk };
  }
  return { allowed: true, reason: null, risk };
}

/** Now rewrites need an authored proposal; other canonical actions are mechanical. */
export function cleanupHasDeterministicAction(finding: CleanupFinding): boolean {
  return finding.kind !== 'stale-now';
}
