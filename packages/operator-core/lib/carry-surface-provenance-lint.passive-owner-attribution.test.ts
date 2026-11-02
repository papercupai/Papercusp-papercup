/**
 * Passive-voice and name-based owner attribution (EI-21459558956325262 / WI-41690).
 *
 * OWNER_ATTRIBUTION_RE requires the literal token `owner` immediately followed by a
 * verb, so it only ever saw ACTIVE voice with the generic noun. Measured before the
 * fix: it caught 1 of 5 attribution forms. The form that actually bit —
 * "Approved by Avi for direct AUTO implementation by this session", sitting in a
 * plan's `## Now` and quoted back as authority by a later session — was one of the
 * four it missed.
 *
 * This file pins BOTH directions on purpose. The positives stop the detector
 * regressing to active-voice-only; the negatives stop someone "fixing" a future miss
 * by broadening the pattern until it nudges on ordinary prose, which the module's own
 * design note warns trains agents to ignore the warning. The negative cases ARE the
 * calibration — measured at 6 flagged of 1,380 real plan Now blocks (0.4%).
 */
import { describe, expect, it } from 'vitest';
import { lintCarrySurfaceProvenance } from './carry-surface-provenance-lint';

const flagged = (text: string) => lintCarrySurfaceProvenance(text).flagged;
const kinds = (text: string) => lintCarrySurfaceProvenance(text).matches.map((m) => m.kind);

describe('owner attribution — passive voice and personal names', () => {
  it('flags the exact line that motivated this guard', () => {
    // Verbatim from llm-agent-evaluation-measurement-integrity-2026-08-25's Now block.
    const incident = 'Approved by Avi for direct AUTO implementation by this session.';
    expect(flagged(incident)).toBe(true);
    expect(kinds(incident)).toContain('owner-attribution');
  });

  it.each([
    ['active voice, generic noun', 'The owner approved this plan for direct implementation.'],
    ['passive voice, generic noun', 'Approved by the owner for direct implementation.'],
    ['passive voice, no article', 'DEFERRED by owner (D-004): P-005 moved out of scope.'],
    ['passive voice, personal name', 'Deferred by Avi on 2026-08-25 while the predecessor lands.'],
    ['screaming case', 'SCOPE APPROVED by Avi on 2026-08-21.'],
    ['authorized variant', 'Authorized by Avi pending the credential.'],
    ['signed-off variant', 'Signed off by Avi after the demo.'],
  ])('flags %s', (_label, line) => {
    expect(flagged(line)).toBe(true);
    expect(kinds(line)).toContain('owner-attribution');
  });

  it.each([
    ['a capitalised non-human approver', 'Merged after being approved by CI and the green gate.'],
    ['an infrastructure approver', 'Authorized by the gate once the checkpoint went green.'],
    ['a lowercase common noun', 'approved by the release script before deploy.'],
    ['a grader', 'The rubric was approved by the grader, not the implementer.'],
    ['a schema literal naming an owner field', "Design sketch [inferred, not yet checked against the writer]: provenance {kind:'owner', turnRef} | {kind:'agent', ownerId} as plan_decisions columns."],
    ['an emphasized plan decision', '5. WI-2142667 — deferred BY DECISION (D-129b), released under claimHold.'],
    ['ordinary status prose', 'P-001 done; P-002 todo. Next: run the affected suites.'],
    ['a plain deferral with no attribution', 'Deferred until the dependency lands.'],
  ])('stays silent for %s', (_label, line) => {
    expect(flagged(line)).toBe(false);
  });

  it('still exempts an explicitly downgraded source tag', () => {
    // [self-imposed] already means "not owner authority" — re-flagging it would
    // punish the exact behaviour the note asks writers for.
    expect(flagged('[self-imposed] Approved by Avi is not authorization here.')).toBe(false);
  });

  it('reports the offending line so a writer can find it in a long block', () => {
    const block = [
      'P-001 done (WI-41656).',
      'Approved by Avi for direct AUTO implementation by this session.',
      'Next: run the activation audit.',
    ].join('\n');
    const result = lintCarrySurfaceProvenance(block);
    expect(result.flagged).toBe(true);
    const attribution = result.matches.find((m) => m.kind === 'owner-attribution');
    expect(attribution?.line).toContain('Approved by Avi');
    // The clean lines must not each produce their own match.
    expect(result.matches.filter((m) => m.kind === 'owner-attribution')).toHaveLength(1);
  });
});
