/**
 * Unit coverage for the work-item operational brief (plan
 * use-existing-router-for-review-requests-2026-09-08 P-008, spec
 * OP-BRIEF-P008-WORKITEM): the brief must never hide an active claim, a blocked
 * dependency, a missing checkpoint, or successor residue that the same
 * work_items:get row exposes — and must never substitute a value for a gap.
 */
import { describe, expect, it } from 'vitest';
import { renderOperationalBrief } from './brief';
import { projectWorkItemOperationalBrief, renderWorkItemFactLines } from './work-item-brief';

const HOLDER = 'su-holder-1';

function row(overrides: {
  workItem?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ok: true,
    id: 'WI-1',
    availability: 'available',
    workItem: {
      id: 'WI-1',
      kind: 'feature',
      state: 'open',
      assignee: null,
      takenAt: null,
      lastProgressAt: null,
      payload: {},
      ...overrides.workItem,
    },
    checkpoint: null,
    completion: null,
    hasCompletionEvidence: false,
    ...overrides.extra,
  };
}

const STRUCTURED = [
  '## Did',
  'Wrote the projection.',
  '',
  '## Left',
  'Integration test, then evidence binding.',
  '',
  '## Next action',
  'Run the integration suite.',
].join('\n');

describe('projectWorkItemOperationalBrief', () => {
  it('surfaces an active claim, its structured next action and successor residue', () => {
    const brief = projectWorkItemOperationalBrief(
      row({
        workItem: { state: 'wip', assignee: HOLDER, takenAt: '2026-09-22T20:00:00.000Z', lastProgressAt: '2026-09-22T20:10:00.000Z' },
        extra: {
          checkpoint: STRUCTURED,
          checkpointUpdatedAtMs: Date.parse('2026-09-22T20:10:00.000Z'),
          checkpointContentHash: 'abc123',
          holder: { goalText: 'P-008 work-item brief', stale: false },
        },
      }),
      { linksRead: false },
    );
    expect(brief.surface).toBe('work-item');
    expect(brief.subject).toBe('WI-1');
    expect(brief.state).toMatchObject({ status: 'known', value: 'wip' });
    expect(brief.owner).toMatchObject({ status: 'known', value: HOLDER });
    expect(brief.facts.claim).toMatchObject({
      status: 'known',
      value: { assignee: HOLDER, takenAt: '2026-09-22T20:00:00.000Z', holderGoal: 'P-008 work-item brief', holderStale: false },
    });
    expect(brief.nextAction).toEqual({ status: 'known', value: 'Run the integration suite.', source: 'checkpoint carry-note ## Next action' });
    expect(brief.facts.checkpoint).toMatchObject({ status: 'known', value: { status: 'available', structured: true, contentHash: 'abc123', updatedAt: '2026-09-22T20:10:00.000Z' } });
    expect(brief.facts.successorResidue).toMatchObject({ status: 'known', value: { left: 'Integration test, then evidence binding.', walls: [] } });
    expect(brief.blockers).toMatchObject({ status: 'known', value: [] });
    const text = [renderOperationalBrief(brief), ...renderWorkItemFactLines(brief)].join('\n');
    expect(text).toContain(`claim: ${HOLDER} since 2026-09-22T20:00:00.000Z`);
    expect(text).toContain('residue: Integration test, then evidence binding.');
  });

  it('reports every blocker source for a blocked item — plan lane and set_blocker records', () => {
    const brief = projectWorkItemOperationalBrief(
      row({
        workItem: {
          state: 'blocked',
          assignee: HOLDER,
          payload: {
            externalBlockers: [
              { kind: 'gate', ref: 'green-checkpoint', summary: 'waiting on a green main', status: 'active', createdAt: 'x', createdBy: HOLDER, updatedAt: 'x', nextVerb: 'release:deploy status' },
              { kind: 'human', ref: 'owner', summary: 'old question', status: 'cleared', createdAt: 'x', createdBy: HOLDER, updatedAt: 'x' },
            ],
          },
        },
        extra: { planItemBlocked: { planSlug: 'a-plan', itemId: 'P-9', effectiveStatus: 'blocked', reason: 'blocked by P-8' } },
      }),
      { linksRead: false },
    );
    expect(brief.blockers.status).toBe('known');
    if (brief.blockers.status !== 'known') return;
    expect(brief.blockers.value).toEqual([
      'plan item a-plan#P-9 is blocked (blocked by P-8)',
      'gate blocker green-checkpoint: waiting on a green main (next: release:deploy status)',
    ]);
    // The cleared record is history, never a live blocker.
    expect(brief.blockers.value.join(' ')).not.toContain('old question');
    // Incoming blocks edges are not in this read: an explicit gap, not "no dependencies".
    expect(brief.facts.blockedByLinks.status).toBe('unknown');
    expect(brief.unknowns).toContain('facts.blockedByLinks');
  });

  it('never reports a blocked state as unblocked when no reason is recorded', () => {
    const brief = projectWorkItemOperationalBrief(row({ workItem: { state: 'blocked', assignee: HOLDER } }), { linksRead: false });
    expect(brief.blockers).toMatchObject({ status: 'known', value: ['state is blocked but no blocker reason is recorded'] });
  });

  it('marks blockers unknown — not empty — when the payload was not read', () => {
    const r = row({});
    delete (r.workItem as Record<string, unknown>).payload;
    const brief = projectWorkItemOperationalBrief(r, { linksRead: false });
    expect(brief.blockers.status).toBe('unknown');
    expect(brief.unknowns).toContain('blockers');
    expect(brief.nextAction).toEqual({
      status: 'unknown',
      reason: 'blocker and plan eligibility are unknown: the work-item payload is not in this read, so set_blocker records are unmeasured',
    });
  });

  it('shows a missing checkpoint on an unclaimed item and derives the claim action', () => {
    const brief = projectWorkItemOperationalBrief(row({}), { linksRead: false });
    expect(brief.owner).toMatchObject({ status: 'known', value: null });
    expect(brief.facts.checkpoint).toMatchObject({ status: 'known', value: { status: 'absent', structured: false } });
    expect(brief.nextAction).toMatchObject({ status: 'known', value: "claim it: work_items:claim { id: 'WI-1' }" });
    expect(brief.facts.successorResidue.status).toBe('unknown');
    const text = [renderOperationalBrief(brief), ...renderWorkItemFactLines(brief)].join('\n');
    expect(text).toContain('claim: unclaimed');
    expect(text).toContain('checkpoint: absent');
  });

  it('does not derive a claim action when state or plan eligibility blocks it', () => {
    const blockedState = projectWorkItemOperationalBrief(row({ workItem: { state: 'blocked' } }), { linksRead: false });
    expect(blockedState.nextAction).toEqual({
      status: 'unknown',
      reason: 'the work-item state is blocked; resolve its blocker before claiming',
    });

    const blockedPlan = projectWorkItemOperationalBrief(
      row({
        extra: {
          planItemBlocked: { planSlug: 'a-plan', itemId: 'P-9', effectiveStatus: 'blocked', reason: 'blocked by P-8' },
        },
      }),
      { linksRead: false },
    );
    expect(blockedPlan.blockers).toMatchObject({
      status: 'known',
      value: ['plan item a-plan#P-9 is blocked (blocked by P-8)'],
    });
    expect(blockedPlan.nextAction).toEqual({
      status: 'unknown',
      reason: 'active blockers are present; resolve them before claiming',
    });

    const inFlight = projectWorkItemOperationalBrief(row({ workItem: { state: 'wip' } }), { linksRead: false });
    expect(inFlight.nextAction).toEqual({ status: 'unknown', reason: 'work-item state wip is not claimable' });
  });

  it('does not invent a next action for a claimed item with no checkpoint', () => {
    const brief = projectWorkItemOperationalBrief(row({ workItem: { state: 'wip', assignee: HOLDER } }), { linksRead: false });
    expect(brief.nextAction).toEqual({ status: 'unknown', reason: `claimed by ${HOLDER} but no checkpoint records a next action` });
    expect(brief.facts.checkpoint).toMatchObject({ status: 'known', value: { status: 'absent' } });
  });

  it('keeps a failed checkpoint read distinct from an absent checkpoint', () => {
    const brief = projectWorkItemOperationalBrief(
      row({ workItem: { state: 'wip', assignee: HOLDER }, extra: { checkpointReadFailed: true } }),
      { linksRead: false },
    );
    expect(brief.facts.checkpoint.status).toBe('unknown');
    expect(brief.nextAction.status).toBe('unknown');
    expect(brief.facts.successorResidue.status).toBe('unknown');
  });

  it('never promotes free-form checkpoint prose into a next action or residue', () => {
    const brief = projectWorkItemOperationalBrief(
      row({ workItem: { state: 'wip', assignee: HOLDER }, extra: { checkpoint: 'DONE: wrote code. NEXT: maybe run tests?' } }),
      { linksRead: false },
    );
    expect(brief.facts.checkpoint).toMatchObject({ status: 'known', value: { status: 'available', structured: false } });
    expect(brief.nextAction.status).toBe('unknown');
    expect(brief.facts.successorResidue.status).toBe('unknown');
  });

  it('carries walls as successor residue', () => {
    const note = [STRUCTURED, '', '## Walls', '- waiting on owner credential'].join('\n');
    const brief = projectWorkItemOperationalBrief(
      row({ workItem: { state: 'wip', assignee: HOLDER }, extra: { checkpoint: note } }),
      { linksRead: false },
    );
    expect(brief.facts.successorResidue.status).toBe('known');
    if (brief.facts.successorResidue.status !== 'known') return;
    expect(brief.facts.successorResidue.value.walls.join(' ')).toContain('waiting on owner credential');
  });

  it('reports completion evidence as last verified for a terminal item', () => {
    const brief = projectWorkItemOperationalBrief(
      row({
        workItem: { state: 'done', closedAt: '2026-09-22T21:00:00.000Z' },
        extra: { completion: { summary: 'shipped', verifiedHow: 'integration run 42 green' }, hasCompletionEvidence: true },
      }),
      { linksRead: false },
    );
    expect(brief.lastVerified).toMatchObject({
      status: 'known',
      value: { ref: 'WI-1#completion', at: '2026-09-22T21:00:00.000Z', summary: 'integration run 42 green' },
    });
    expect(brief.nextAction).toMatchObject({ status: 'known', value: 'none — the item is terminal (done)' });
    expect(brief.deadline).toMatchObject({ status: 'known', value: null });
  });

  it('keeps last verified unknown without completion evidence', () => {
    const brief = projectWorkItemOperationalBrief(row({ extra: { checkpoint: STRUCTURED } }), { linksRead: false });
    expect(brief.lastVerified.status).toBe('unknown');
  });

  it('projects outgoing blocks links only when the read loaded them', () => {
    const links = [
      { rel: 'blocks', dst: { kind: 'feature', ref: 'WI-2' } },
      { rel: 'relates', dst: { kind: 'feature', ref: 'WI-3' } },
    ];
    const withLinks = projectWorkItemOperationalBrief(row({ workItem: { links } }), { linksRead: true });
    expect(withLinks.facts.holdsUp).toEqual({ status: 'known', value: ['feature:WI-2'], source: 'workItem.links (outgoing rel=blocks)' });
    const without = projectWorkItemOperationalBrief(row({}), { linksRead: false });
    expect(without.facts.holdsUp.status).toBe('unknown');
  });
});
