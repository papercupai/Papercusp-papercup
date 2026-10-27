/**
 * SPEC-P-006-BLIND-BRIEF (verification-system-improvements-2026-10-10 P-006, D-039 (6)):
 * the blind reviewer brief is built only from the owner source turns of the activation
 * audit. Falsifier: the brief contains text from the plan body, its rubric or its bound
 * evidence.
 */
import { describe, expect, it } from 'vitest';
import { buildBlindReviewBrief } from './blind-review-brief';
import type { SourceTurn } from './activation-item-provenance';

const OWNER_A = 'session_turn:claude:sess-a:3';
const OWNER_B = 'session_turn:claude:sess-a:7';
const ASSISTANT = 'session_turn:claude:sess-a:4';
const LOOP_FIRE = 'session_turn:claude:sess-a:5';
const MISSING = 'session_turn:claude:sess-a:9';

// Sentinels for everything that must never reach the reviewer.
const PLAN_TEXT_SENTINEL = 'PLAN-BODY-SENTINEL-7c1e';
const PARAPHRASE_SENTINEL = 'AUDITOR-PARAPHRASE-SENTINEL-41ab';
const ASSISTANT_SENTINEL = 'ASSISTANT-TURN-SENTINEL-9d02';
const LOOP_SENTINEL = 'LOOP-FIRE-SENTINEL-55e3';

const turns = new Map<string, SourceTurn>([
  [OWNER_B, { speaker: 'user', text: 'Also the export button must work offline.', verdict: 'owner-typed' }],
  [OWNER_A, { speaker: 'user', text: 'I want a CSV export of every invoice.', verdict: 'owner-dialog' }],
  [ASSISTANT, { speaker: 'assistant', text: `Plan: ${ASSISTANT_SENTINEL} ${PLAN_TEXT_SENTINEL}`, verdict: 'not-user-turn' }],
  [LOOP_FIRE, { speaker: 'user', text: `${LOOP_SENTINEL} keep working on the plan`, verdict: 'agent-injected' }],
]);

const activation = {
  auditSeq: 4,
  // `requirement` and `planTargets` are what an auditor wrote; the builder must not read them.
  mappings: [
    { id: 'M-001', sourceRefs: [OWNER_B, ASSISTANT], requirement: PARAPHRASE_SENTINEL, planTargets: ['P-001'] },
    { id: 'M-002', sourceRefs: [OWNER_A, LOOP_FIRE, MISSING], requirement: `${PARAPHRASE_SENTINEL} ${PLAN_TEXT_SENTINEL}`, planTargets: ['R-1'] },
    { id: 'M-003', sourceRefs: [OWNER_A], requirement: 'duplicate ref', planTargets: ['P-002'] },
  ],
};

describe('buildBlindReviewBrief', () => {
  const brief = buildBlindReviewBrief({ planSlug: 'demo-plan', activation, turns });

  it('carries exactly the owner turns, de-duplicated and in conversation order', () => {
    expect(brief.ownerTurns.map((t) => t.ref)).toEqual([OWNER_A, OWNER_B]);
    expect(brief.text).toContain('I want a CSV export of every invoice.');
    expect(brief.text).toContain('Also the export button must work offline.');
    expect(brief.text.indexOf('CSV export')).toBeLessThan(brief.text.indexOf('work offline'));
    expect(brief.activationAuditSeq).toBe(4);
  });

  it('never carries the auditor paraphrase, plan text, assistant or machine-injected turns', () => {
    for (const sentinel of [PLAN_TEXT_SENTINEL, PARAPHRASE_SENTINEL, ASSISTANT_SENTINEL, LOOP_SENTINEL]) {
      expect(brief.text).not.toContain(sentinel);
      expect(JSON.stringify(brief.ownerTurns)).not.toContain(sentinel);
    }
  });

  it('names every dropped ref and why', () => {
    expect(brief.excludedRefs).toEqual(
      expect.arrayContaining([
        { ref: ASSISTANT, reason: 'not-owner' },
        { ref: LOOP_FIRE, reason: 'not-owner' },
        { ref: MISSING, reason: 'unresolved' },
      ]),
    );
    expect(brief.excludedRefs).toHaveLength(3);
  });

  it('tells the reviewer how to post and what disqualifies it', () => {
    expect(brief.text).toContain("outcome: 'conclusive' | 'inconclusive'");
    expect(brief.text).toContain('an inconclusive receipt cannot satisfy acceptance');
    expect(brief.text).toContain("plans:blind-review { slug: 'demo-plan', op: 'post', activationAuditSeq: 4,");
    expect(brief.text).toContain('Do NOT read this plan');
  });

  // Owner directive #2499 (2026-10-27): an unverified-origin user turn is carried, labelled,
  // instead of being dropped (which made the owner re-type their requirements to ship).
  it('carries an unknown-origin user turn, labelled unverified, and never as verified owner speech', () => {
    const only = buildBlindReviewBrief({
      planSlug: 'demo-plan',
      activation: { auditSeq: 1, mappings: [{ sourceRefs: [OWNER_A] }] },
      turns: new Map([[OWNER_A, { speaker: 'user', text: 'maybe owner', verdict: 'unknown' }]]),
    });
    expect(only.ownerTurns).toEqual([]);
    expect(only.unverifiedTurns).toEqual([{ ref: OWNER_A, text: 'maybe owner' }]);
    expect(only.excludedRefs).toEqual([]);
    expect(only.text).toContain(`origin unverified (${OWNER_A})`);
    expect(only.text).toContain('maybe owner');
  });

  it('still drops an unknown verdict that is not a user turn, and verified agent origins', () => {
    const mixed = buildBlindReviewBrief({
      planSlug: 'demo-plan',
      activation: { auditSeq: 2, mappings: [{ sourceRefs: [OWNER_A, LOOP_FIRE, ASSISTANT] }] },
      turns: new Map<string, SourceTurn>([
        [OWNER_A, { speaker: 'assistant', text: ASSISTANT_SENTINEL, verdict: 'unknown' }],
        [LOOP_FIRE, { speaker: 'user', text: LOOP_SENTINEL, verdict: 'synthetic' }],
        [ASSISTANT, { speaker: 'user', text: PLAN_TEXT_SENTINEL, verdict: 'machine-surface' }],
      ]),
    });
    expect(mixed.ownerTurns).toEqual([]);
    expect(mixed.unverifiedTurns).toEqual([]);
    expect(mixed.excludedRefs.map((r) => r.reason)).toEqual(['not-owner', 'not-owner', 'not-owner']);
    for (const sentinel of [ASSISTANT_SENTINEL, LOOP_SENTINEL, PLAN_TEXT_SENTINEL]) expect(mixed.text).not.toContain(sentinel);
  });

  it('a brief with only verified owner turns carries no unverified label', () => {
    expect(brief.unverifiedTurns).toEqual([]);
    expect(brief.text).not.toContain('origin unverified');
  });
});
