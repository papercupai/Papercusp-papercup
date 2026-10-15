/**
 * observation-candidate-acceptance-promotion-2026-09-30 P-008 (D-020 §§1,4,5):
 * the pure predicates the intake drain rides on.
 *
 *  - R-27: an intake drain is summarized with DISPOSITIONS apart from DELIVERY.
 *    Accepted work counts as delivered only once its item is done with committed
 *    completion authority, so "accepted" can never read as "shipped".
 *  - R-7: only an intake-triage run swaps feed membership for source liveness.
 *  - R-26: a low/insufficient-confidence promote is refused; nothing else is.
 */
import { describe, expect, it } from 'vitest';
import {
  BULK_INTAKE_DISPOSITIONS,
  INTAKE_APPLY_ACTION_ID,
  intakeConfidenceRefusal,
  isSourceLivenessRunKind,
  summarizeIntakeDrain,
  type BulkIntakeDecision,
  type BulkIntakeDisposition,
  type IntakeDrainRow,
} from './bulk-dispositions';
import { buildUnattendedRunOwnerDigest, UNATTENDED_BULK_REQUESTER, UNATTENDED_INTAKE_REQUESTER } from './bulk-run-owner-digest';

function decision(disposition: BulkIntakeDisposition): BulkIntakeDecision {
  return {
    disposition,
    reason: `because ${disposition}`,
    decidedBy: 'su-resolver',
    owner: 'agent',
    targetRef: disposition === 'merge' ? 'EI-9' : null,
    missingInformation: disposition === 'retry' ? 'the run id' : null,
    decidedAt: '2026-10-01T16:00:00.000Z',
    workKind: null,
    acceptance: null,
    sourceRevision: 'src-v1:abc',
    reproduction: null,
  };
}

const applied = (d: BulkIntakeDisposition, promoted?: IntakeDrainRow['promoted']): IntakeDrainRow => ({
  outcome: 'auto_resolved',
  actionId: INTAKE_APPLY_ACTION_ID,
  intakeDecision: decision(d),
  promoted,
});
const recorded = (d: BulkIntakeDisposition): IntakeDrainRow => ({
  outcome: 'recommended',
  actionId: null,
  intakeDecision: decision(d),
});

describe('summarizeIntakeDrain (R-27)', () => {
  it('separates what was decided from what was delivered', () => {
    const summary = summarizeIntakeDrain([
      applied('promote', { state: 'done', completionAuthority: 'committed' }),
      applied('promote', { state: 'done', completionAuthority: 'asserted' }),
      applied('investigate', { state: 'wip' }),
      applied('promote'),
      applied('retain'),
      applied('reject'),
      recorded('promote'),
      recorded('merge'),
      { outcome: 'pending', actionId: null, intakeDecision: null },
      { outcome: 'failed', actionId: null, intakeDecision: null },
    ]);
    expect(summary.intake).toEqual({
      total: 10,
      decided: 8,
      undecided: 1,
      failed: 1,
      applied: 6,
      byDisposition: { promote: 4, merge: 1, investigate: 1, retain: 1, reject: 1, retry: 0 },
    });
    // Only APPLIED promote/investigate is accepted work; a merely recorded promote is not.
    expect(summary.delivery).toEqual({ accepted: 4, delivered: 1, notDelivered: 3 });
  });

  it('never counts a done item without committed completion authority as delivered', () => {
    const summary = summarizeIntakeDrain([applied('promote', { state: 'done', completionAuthority: null })]);
    expect(summary.delivery).toEqual({ accepted: 1, delivered: 0, notDelivered: 1 });
  });

  it('counts every disposition key, starting at zero', () => {
    expect(Object.keys(summarizeIntakeDrain([]).intake.byDisposition)).toEqual([...BULK_INTAKE_DISPOSITIONS]);
  });
});

describe('isSourceLivenessRunKind (R-7)', () => {
  it('is true only for the intake-triage run kind', () => {
    expect(isSourceLivenessRunKind('intake-triage')).toBe(true);
    for (const kind of ['inbox-resolve', 'plan-cleanup', '', null, undefined, 'INTAKE-TRIAGE']) {
      expect(isSourceLivenessRunKind(kind)).toBe(false);
    }
  });
});

describe('intakeConfidenceRefusal (R-26)', () => {
  it('refuses only a low or insufficient promote', () => {
    expect(intakeConfidenceRefusal('promote', 'low')).toMatch(/cannot become accepted work/);
    expect(intakeConfidenceRefusal('promote', 'insufficient')).toMatch(/Record investigate .* or retry/);
    for (const level of ['high', 'medium', null, undefined]) {
      expect(intakeConfidenceRefusal('promote', level)).toBeNull();
    }
    for (const d of BULK_INTAKE_DISPOSITIONS.filter((x) => x !== 'promote')) {
      expect(intakeConfidenceRefusal(d, 'low')).toBeNull();
    }
  });
});

describe('owner digest for an unattended intake drain (R-27)', () => {
  const run = {
    runId: 'bulk-intake-1',
    phase: 'complete' as const,
    finishedAt: '2026-10-01T16:30:00.000Z',
    updatedAt: '2026-10-01T16:30:00.000Z',
    createdAt: '2026-10-01T16:00:00.000Z',
    autoResolved: 2,
  };
  const items = [
    { itemId: 'improvement:EI-1', title: 'gate flake', outcome: 'auto_resolved' as const, actionId: INTAKE_APPLY_ACTION_ID, rationale: 'apply', intakeDecision: decision('promote') },
    { itemId: 'improvement:EI-2', title: 'noise', outcome: 'auto_resolved' as const, actionId: INTAKE_APPLY_ACTION_ID, rationale: 'apply', intakeDecision: decision('reject') },
    { itemId: 'improvement:EI-3', title: 'unclear', outcome: 'recommended' as const, actionId: null, rationale: null, intakeDecision: decision('retry') },
  ];

  it('reports decisions apart from delivery, and never calls accepted work shipped', () => {
    const digest = buildUnattendedRunOwnerDigest({ ...run, requestedBy: UNATTENDED_INTAKE_REQUESTER }, items);
    expect(digest.title).toBe('Unattended intake triage pass auto-applied 2 items');
    expect(digest.body).toContain(
      'Intake decisions (not delivery): 3 of 3 decided — promote 1, reject 1, retry 1; 0 undecided, 0 failed; 2 applied.',
    );
    expect(digest.body).toContain('Accepted-work delivery: 1 accepted, 0 delivered, 1 not yet delivered.');
    expect(digest.body).toContain('Accepted is not shipped');
  });

  it('leaves the Inbox digest unchanged', () => {
    const digest = buildUnattendedRunOwnerDigest({ ...run, requestedBy: UNATTENDED_BULK_REQUESTER }, items);
    expect(digest.title).toBe('Unattended Inbox pass auto-applied 2 items');
    expect(digest.body).not.toContain('Intake decisions');
  });
});
