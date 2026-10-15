/**
 * The one-shot autonomy release (EI-25573324094056113).
 *
 * getItemIdsAwaitingOwnerReview holds every item that already sits in an open
 * review run, so the scheduled seeder does not re-adjudicate it. One exception
 * releases held recommendations: the owner grants automatic autonomy, and
 * recommendations that were held under the old policy get ONE fresh live
 * adjudication so report auto-accept can perform them.
 *
 * Before this fix the release had no memory. With every risk level set to
 * automatic, it re-released each high-confidence recommendation on every
 * 15-minute fire, including recommendations made under that same policy and
 * recommendations with no terminal action at all. Each re-release re-consulted
 * the same assignee. Measured on real rows: work-item-blocked:WI-10007929 sat
 * in about 40 review runs between 2026-10-09 and 2026-10-11, each under the
 * receipt {level:'L2', riskLevels:all automatic, minConfidence:'medium'}, each
 * recommended 'routed'/'investigate' at high confidence with no action_id, and
 * each answered "retain".
 *
 * The predicate is pure so the rule is pinned without PG. The SQL that feeds it
 * is covered in bulk-run-store.integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { standingAutomationEligibility } from './automation-policy';
import { bulkAutomationSnapshot, type BulkConfidence, type StandingBulkAutomationPolicy } from './bulk-dispositions';
import { releasedForAutonomousReadjudication, runStandingPolicy, type BulkItemOutcome } from './bulk-run-store';

/** The live workspace standing policy the incident ran under. */
const ALL_AUTOMATIC: StandingBulkAutomationPolicy = {
  level: 'L2',
  minConfidence: 'medium',
  riskLevels: { low: 'automatic', medium: 'automatic', high: 'automatic' },
};
const REVIEW_ALL: StandingBulkAutomationPolicy = { level: 'L0', minConfidence: 'high' };

/** The receipt createRun persists, re-read the way the store reads it. */
function receipt(policy: StandingBulkAutomationPolicy): StandingBulkAutomationPolicy | null {
  return runStandingPolicy(JSON.parse(JSON.stringify(bulkAutomationSnapshot(policy))));
}

/** The pre-fix predicate, kept as a falsifiability control (no run receipt consulted). */
function legacyReleased(
  row: { outcome: BulkItemOutcome; kind: string; confidence: BulkConfidence | null },
  policy: StandingBulkAutomationPolicy,
): boolean {
  return row.outcome === 'recommended' && standingAutomationEligibility(policy, row.kind, row.confidence).allowed;
}

const incidentRow = {
  outcome: 'recommended' as const,
  kind: 'work-item-blocked',
  confidence: 'high' as const,
};

describe('releasedForAutonomousReadjudication', () => {
  it('holds a recommendation already adjudicated under the same automatic policy (the incident)', () => {
    const row = { ...incidentRow, runPolicy: receipt(ALL_AUTOMATIC) };
    expect(releasedForAutonomousReadjudication(row, ALL_AUTOMATIC)).toBe(false);
    // Control: the pre-fix predicate released exactly this row on every fire.
    // If this flips, the fixture no longer reproduces the incident and the
    // assertion above would pass vacuously.
    expect(legacyReleased(incidentRow, ALL_AUTOMATIC)).toBe(true);
  });

  it('releases once when autonomy is newly granted over a review-all recommendation', () => {
    const row = { ...incidentRow, runPolicy: receipt(REVIEW_ALL) };
    expect(releasedForAutonomousReadjudication(row, ALL_AUTOMATIC)).toBe(true);
  });

  it('releases a recommendation from a legacy run that carries no automation receipt', () => {
    expect(releasedForAutonomousReadjudication({ ...incidentRow, runPolicy: null }, ALL_AUTOMATIC)).toBe(true);
    expect(runStandingPolicy(null)).toBeNull();
    expect(runStandingPolicy({})).toBeNull();
  });

  it('releases when the grant widened to this risk tier, and holds once the tier was already granted', () => {
    // work-item-needs-human is owner-by-right, so it is the medium risk tier.
    const lowOnly: StandingBulkAutomationPolicy = {
      level: 'L1',
      minConfidence: 'medium',
      riskLevels: { low: 'automatic', medium: 'review', high: 'review' },
    };
    const medium = { outcome: 'recommended' as const, kind: 'work-item-needs-human', confidence: 'high' as const };
    expect(releasedForAutonomousReadjudication({ ...medium, runPolicy: receipt(lowOnly) }, ALL_AUTOMATIC)).toBe(true);
    // blocked-session is delegable, so it is the low risk tier, already automatic under lowOnly.
    const low = { outcome: 'recommended' as const, kind: 'blocked-session', confidence: 'high' as const };
    expect(releasedForAutonomousReadjudication({ ...low, runPolicy: receipt(lowOnly) }, ALL_AUTOMATIC)).toBe(false);
  });

  it('releases when the confidence floor dropped below a recommendation the old floor excluded', () => {
    const highFloor: StandingBulkAutomationPolicy = { ...ALL_AUTOMATIC, minConfidence: 'high' };
    const row = { ...incidentRow, confidence: 'medium' as const };
    expect(releasedForAutonomousReadjudication({ ...row, runPolicy: receipt(highFloor) }, ALL_AUTOMATIC)).toBe(true);
    expect(releasedForAutonomousReadjudication({ ...row, runPolicy: receipt(ALL_AUTOMATIC) }, ALL_AUTOMATIC)).toBe(false);
  });

  it('never releases a non-recommendation or a row the current policy does not permit', () => {
    for (const outcome of ['dismissed', 'skipped', 'failed', 'pending'] as const) {
      expect(releasedForAutonomousReadjudication({ ...incidentRow, outcome, runPolicy: null }, ALL_AUTOMATIC)).toBe(false);
    }
    expect(releasedForAutonomousReadjudication({ ...incidentRow, runPolicy: null }, REVIEW_ALL)).toBe(false);
    expect(releasedForAutonomousReadjudication({ ...incidentRow, confidence: 'low', runPolicy: null }, ALL_AUTOMATIC)).toBe(false);
    expect(releasedForAutonomousReadjudication({ ...incidentRow, kind: 'not-a-kind', runPolicy: null }, ALL_AUTOMATIC)).toBe(false);
  });
});

describe('runStandingPolicy', () => {
  it('reads the live L2 receipt shape the incident runs persisted', () => {
    expect(runStandingPolicy({
      mode: 'safe-high',
      level: 'L2',
      riskLevels: { low: 'automatic', high: 'automatic', medium: 'automatic' },
      minConfidence: 'medium',
    })).toEqual(ALL_AUTOMATIC);
  });

  it('reads a legacy mode-only receipt the way normalizeBulkAutomationPolicy does', () => {
    expect(runStandingPolicy({ mode: 'review-all', minConfidence: 'high' })).toEqual({ level: 'L0', minConfidence: 'high' });
    expect(runStandingPolicy({ mode: 'safe-high', minConfidence: 'high' })).toEqual({ level: 'L1', minConfidence: 'high' });
    expect(runStandingPolicy('{"mode":"safe-medium-plus","minConfidence":"medium"}')).toEqual({ level: 'L1', minConfidence: 'medium' });
  });
});
