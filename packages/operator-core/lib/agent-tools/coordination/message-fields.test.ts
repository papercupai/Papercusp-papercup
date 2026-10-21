/**
 * message-fields.test.ts — the ratified semantics of the authored message
 * fields (unified-agent-state-plane-2026-07-27 P-032, reopened by D-070).
 *
 * These tests assert the RULINGS, not the plumbing: the envelope/section split
 * (D-064), `'other'` requiring a note and being excluded from the divergence
 * check (D-043), and D-026's "any ref may be cited; the KIND decides staleness".
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  classifyPremiseRef,
  participatesInCouplingDivergence,
  couplingDivergenceVerdict,
  FOR_YOU_BECAUSE_RELATIONS,
  assertEnvelopeSectionSplit,
  EnvelopeFieldOnSectionError,
  messageSectionSchema,
  PREMISES_SHAPE_MESSAGE,
  SECTION_ONLY_FIELDS,
  stampMessageFields,
  toSections,
  sectionsToText,
  ENVELOPE_ONLY_FIELDS,
  renderAuthoredFieldsSuffix,
  projectAuthoredFields,
  YOU_MAY_NOT_KNOW_SHAPE_MESSAGE,
  COULD_NOT_DETERMINE_SHAPE_MESSAGE,
} from './message-fields';
import { DERIVED_COUPLING_RELATIONS } from '../../coord/couplings';

describe('renderAuthoredFieldsSuffix — making the fields visible', () => {
  it('renders nothing for an ordinary message (no sections stamped)', () => {
    expect(renderAuthoredFieldsSuffix({ body: 'hi' })).toBe('');
    expect(renderAuthoredFieldsSuffix({ sections: [] })).toBe('');
  });

  it('renders nothing when sections carry no authored fields', () => {
    expect(renderAuthoredFieldsSuffix({ sections: [{ text: 'a' }, { text: 'b' }] })).toBe('');
  });

  it('NAMES premises rather than counting them — the point of a premise is that it can be re-checked', () => {
    // CHANGED (coordination-spec-adoption Phase 5): this used to count anything
    // past the first, to respect the line's shared ~200-char cap. The cap is now
    // enforced centrally by allocateMarkerBudget, so the cap no longer has to be
    // paid for by withholding content that fits.
    expect(renderAuthoredFieldsSuffix({ sections: [{ text: 'a', premises: ['WI-1#completion'] }] })).toContain(
      '⊨ WI-1#completion',
    );
    const several = renderAuthoredFieldsSuffix({
      sections: [{ text: 'a', premises: ['x#D-001', 'y#D-002', 'msg:z'] }],
    });
    expect(several).toContain('x#D-001');
    expect(several).toContain('y#D-002');
    expect(several).not.toContain('⊨ 3 premises');
  });

  it('COUNTS premises again when the shared budget is genuinely tight', () => {
    // The degradation still exists — it is now a budget decision, not a
    // per-field default. A high-priority clarify + undetermined eat the line,
    // so premises (lowest priority) fall back to their count form.
    const out = renderAuthoredFieldsSuffix({
      sections: [
        {
          text: 'a',
          clarify: [{ question: 'x'.repeat(90), assuming: 'y'.repeat(50) }],
          couldNotDetermine: [{ what: 'z'.repeat(110) }],
          premises: ['p#D-001', 'q#D-002', 'r#D-003'],
        },
      ],
    });
    expect(out).toContain('⊨ 3 premises');
    expect(out.length).toBeLessThanOrEqual(260);
  });

  it('does NOT reuse `⊢` — that glyph already means the evidence band on this line', () => {
    expect(renderAuthoredFieldsSuffix({ sections: [{ text: 'a', premises: ['WI-1#completion'] }] })).not.toContain(
      '⊢',
    );
  });

  it('clarify is SECTION-scoped and REQUIRES its assumption (D-106)', () => {
    expect(SECTION_ONLY_FIELDS).toContain('clarify');
    // `assuming` is mandatory: an ask with no stated fallback is precisely the
    // blocking round-trip this field replaces, and the measured reason the
    // existing clarification VERB went unused (coord:ask 6 calls/30d vs
    // coord:send 3512; 76% of question conversations orphaned).
    expect(
      messageSectionSchema.safeParse({ text: 'a', clarify: [{ question: 'which harness?' }] })
        .success,
    ).toBe(false);
    expect(
      messageSectionSchema.safeParse({
        text: 'a',
        clarify: [{ question: 'which harness?', assuming: 'papercusp' }],
      }).success,
    ).toBe(true);
  });

  it('SPELLS OUT couldNotDetermine — it marks a question OPEN, which is a different action', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [{ text: 'a', couldNotDetermine: [{ what: 'whether the deploy carries the fix' }] }],
    });
    expect(out).toContain('? undetermined: whether the deploy carries the fix');
  });

  it('SPELLS OUT clarify WITH its assumption — the stake is that a peer is already acting (D-106)', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [
        {
          text: 'a',
          clarify: [
            { question: 'is the release gate mine to green?', assuming: 'yes, greening it myself' },
          ],
        },
      ],
    });
    expect(out).toContain('is the release gate mine to green?');
    // The ASSUMPTION must render too. A counted "1 clarification" would hide the
    // recipient's entire reason to answer: a peer is proceeding on a fallback
    // that may be wrong, and silence has a cost.
    expect(out).toContain('assuming: yes, greening it myself');
    expect(out).not.toMatch(/1 clarif/);
  });

  // ── youMayNotKnow is SPELLED OUT, not counted ──────────────────────────────
  // coordination-spec-adoption-2026-08-03 Phase 5. The refs are the actionable
  // payload; a bare count forced a second coord:read, which fired 15 times in a
  // week against 1,611 sends. These pin the delivery, not the formatting.

  it('DELIVERS the youMayNotKnow refs in-band rather than a bare count', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [
        {
          text: 'a',
          youMayNotKnow: [
            { ref: 'WI-7423', provenance: 'authored' },
            { ref: 'EI-19300252001829260', provenance: 'computed' },
          ],
        },
      ],
    });
    expect(out).toContain('WI-7423');
    expect(out).toContain('EI-19300252001829260');
    // The old shape leaked no ref at all — a reader could not act without a
    // second call. Guard against a silent regression to counting.
    expect(out).not.toMatch(/⚠ 2 you-may-not-know/);
  });

  it('puts AUTHORED refs before COMPUTED ones — the reader cannot re-derive the sender\'s model', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [
        {
          text: 'a',
          youMayNotKnow: [
            { ref: 'COMPUTED-REF', provenance: 'computed' },
            { ref: 'AUTHORED-REF', provenance: 'authored' },
          ],
        },
      ],
    });
    expect(out.indexOf('AUTHORED-REF')).toBeLessThan(out.indexOf('COMPUTED-REF'));
  });

  it('stays BOUNDED under many refs, and says how many it withheld', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ref: `WI-${1000 + i}`,
      provenance: 'authored' as const,
    }));
    const out = renderAuthoredFieldsSuffix({ sections: [{ text: 'a', youMayNotKnow: many }] });
    // The [coord+N] line is compact by design: the fix for a starved read path
    // is delivering the actionable part, never lifting the cap.
    expect(out.length).toBeLessThan(200);
    expect(out).toMatch(/\(\+\d+\)/);
  });

  it('still SUPPRESSES youMayNotKnow when the field was DERIVED, not authored (D-072)', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [{ text: 'a', youMayNotKnow: [{ ref: 'WI-1', provenance: 'computed' }] }],
      fieldProvenance: { youMayNotKnow: 'owner-gui-derived' },
    });
    expect(out).toBe('');
  });

  // ── forYouBecause: the NOTE is the field (D-090) ───────────────────────────

  it('DELIVERS the forYouBecause note in-band, not just the relation enum', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [
        {
          text: 'a',
          forYouBecause: { relation: 'owns', ref: 'x.ts', note: 'you wrote the resolver this breaks' },
        },
      ],
    });
    expect(out).toContain('∵ owns x.ts');
    // The note IS the sender's model of the recipient — D-090 is explicit that
    // the model is the payload, and the line used to drop it entirely.
    expect(out).toContain('you wrote the resolver this breaks');
  });

  it("keeps the note even under pressure when relation is 'other' — there the enum means nothing", () => {
    // D-043 makes a note MANDATORY on `other` precisely because the enum cannot
    // carry the meaning. Degrading `∵ other — <note>` to `∵ other` would deliver
    // a marker with literally zero information, so `other` has no cheap form.
    const out = renderAuthoredFieldsSuffix({
      sections: [
        {
          text: 'a',
          clarify: [{ question: 'q'.repeat(90), assuming: 'a'.repeat(60) }],
          couldNotDetermine: [{ what: 'w'.repeat(115) }],
          forYouBecause: { relation: 'other', note: 'you own the release gate today' },
        },
      ],
    });
    if (out.includes('∵ other')) expect(out).toContain('you own the release gate today');
  });

  it('honours ONE shared line budget across all fragments (the ~200-char cap)', () => {
    // The regression this guards: spelling out four fields independently is
    // >400 chars, which does not fail loudly — it truncates the reader's line
    // somewhere arbitrary, losing content without saying so.
    const out = renderAuthoredFieldsSuffix({
      blocking: true,
      sections: [
        {
          text: 'a',
          premises: Array.from({ length: 8 }, (_, i) => `premise-ref-number-${i}#D-00${i}`),
          forYouBecause: { relation: 'owns', ref: 'some/long/path/to/a/file.ts', note: 'n'.repeat(120) },
          youMayNotKnow: Array.from({ length: 8 }, (_, i) => ({
            ref: `WI-${9000 + i}-with-a-long-suffix`,
            provenance: 'authored' as const,
          })),
          couldNotDetermine: [{ what: 'c'.repeat(150) }],
        },
      ],
    });
    expect(out.length).toBeLessThanOrEqual(260);
    // BLOCKING is priority 1 and must never be the thing that gets dropped.
    expect(out).toContain('BLOCKING');
  });

  it('surfaces blocking and the coupling relation', () => {
    const out = renderAuthoredFieldsSuffix({
      blocking: true,
      sections: [{ text: 'a', forYouBecause: { relation: 'holds-a-lock-on', ref: 'x.ts' } }],
    });
    expect(out).toContain('BLOCKING');
    expect(out).toContain('∵ holds-a-lock-on x.ts');
  });

  it('⚠ SUPPRESSES a DERIVED field (D-072) — a GUI default is not the sender\'s model of you', () => {
    const out = renderAuthoredFieldsSuffix({
      blocking: false,
      sections: [{ text: 'a', forYouBecause: { relation: 'other', note: 'owner addressed you' } }],
      fieldProvenance: { forYouBecause: 'owner-gui-derived', blocking: 'owner-gui-derived' },
    });
    expect(out).toBe('');
  });

  it('still renders the AUTHORED fields of a message whose OTHER fields were derived', () => {
    const out = renderAuthoredFieldsSuffix({
      sections: [
        {
          text: 'a',
          forYouBecause: { relation: 'other', note: 'derived' },
          couldNotDetermine: [{ what: 'the real question' }],
        },
      ],
      fieldProvenance: { forYouBecause: 'owner-gui-derived' },
    });
    expect(out).not.toContain('∵');
    expect(out).toContain('? undetermined: the real question');
  });
});

describe('premise ref classification (D-026)', () => {
  it('classifies each admissible ref kind', () => {
    expect(classifyPremiseRef('fact:owner:su-709bb:gate-reds-unrelated@v7').kind).toBe('fact');
    expect(classifyPremiseRef('unified-agent-state-plane-2026-07-27#D-023').kind).toBe('plan-decision');
    expect(classifyPremiseRef('WI-6199#completion').kind).toBe('work-item-completion');
    expect(classifyPremiseRef('msg:ms2ipk0d-0000-abc').kind).toBe('peer-message');
    expect(classifyPremiseRef('owner-turn:2026-07-27').kind).toBe('owner-directive');
    expect(classifyPremiseRef('/internal/docs/agent-insights/reading-pipeline-state').kind).toBe('doc');
  });

  it('keeps the COMPLETION CLAIM a distinct kind from the bare item (D-026 correction 2)', () => {
    expect(classifyPremiseRef('WI-6199#completion').kind).toBe('work-item-completion');
    // A bare id is a DIFFERENT claim, not a weaker one: it asserts existence,
    // never completion. It used to degrade to `opaque` — which honoured D-026
    // by giving up entirely. Giving it its own kind honours the same rule for
    // the same reason (no silent upgrade into a completion assertion) while
    // still catching a mistyped id on the recipient's behalf.
    expect(classifyPremiseRef('WI-6199').kind).toBe('work-item');
    expect(classifyPremiseRef('wi:EI-18834967602055309').kind).toBe('work-item');
    expect(classifyPremiseRef('WI-6502#checkpoint').kind).toBe('work-item');
  });

  it('classifies a plan ITEM, and only the container plan is left unclassified', () => {
    expect(classifyPremiseRef('no-http-anywhere-2026-07-28#P-020').kind).toBe('plan-item');
    // The container itself is not a claim — the D-026 rule that makes a plan
    // DECISION citable and a plan not.
    expect(classifyPremiseRef('no-http-anywhere-2026-07-28').kind).toBe('opaque');
  });

  it('accepts a decision id the parser accepts — the classifier must not be narrower', () => {
    // REGRESSION: the arm demanded `#D-\d{3,}` while `parsePlanDecisionRef`
    // accepts `^D-\d+$`, so a two-digit id classified opaque and never reached
    // the parser that would have handled it. A classifier stricter than its own
    // parser is a false negative with no compensating benefit.
    expect(classifyPremiseRef('some-plan#D-90').kind).toBe('plan-decision');
    expect(classifyPremiseRef('some-plan#D-004').kind).toBe('plan-decision');
  });

  it('leaves irreducible prose opaque — widening is not a mandate to classify everything', () => {
    // Both observed live 2026-08-01. There is nothing to resolve here, and
    // inventing a shape that swallowed them would manufacture verdicts.
    for (const prose of [
      'dev:pg_query GROUP BY kind over harness_shared.engineer_issues state=open',
      'scheduler:set_claim_spec rev3 admissibilityPreview matched=174 previousMatched=1252',
    ]) {
      expect(classifyPremiseRef(prose).kind).toBe('opaque');
    }
  });

  it('NEVER excludes an unrecognised ref — it degrades to opaque (the governing rule)', () => {
    const odd = classifyPremiseRef('something nobody anticipated');
    expect(odd.kind).toBe('opaque');
    expect(odd.ref).toBe('something nobody anticipated');
    expect(odd.invalidatable).toBe(false);
  });

  it('the ref KIND determines invalidatability, not the citation site', () => {
    for (const ref of [
      'fact:owner:su-1:k@v1',
      'plan-x#D-001',
      'WI-1#completion',
      'msg:abc',
      'owner-turn:x',
    ]) {
      expect(classifyPremiseRef(ref).invalidatable).toBe(true);
    }
    // Declarable, but nothing can make them go stale.
    expect(classifyPremiseRef('/internal/docs/x').invalidatable).toBe(false);
    expect(classifyPremiseRef('freeform').invalidatable).toBe(false);
  });

  it('a prefixed ref never falls through to an anchor arm', () => {
    expect(classifyPremiseRef('msg:thread#D-001').kind).toBe('peer-message');
    expect(classifyPremiseRef('owner-turn:ruling#D-002').kind).toBe('owner-directive');
    // REGRESSION: the `doc` arm used to be tested LAST, so a docs path carrying
    // a decision-shaped anchor classified `plan-decision` and would then be
    // probed as a plan that does not exist — a dangling-citation verdict
    // against a perfectly real doc.
    expect(classifyPremiseRef('/internal/docs/x#D-001').kind).toBe('doc');
    expect(classifyPremiseRef('/internal/docs/x#P-001').kind).toBe('doc');
  });
});

describe('forYouBecause (D-043)', () => {
  it("REFUSES relation:'other' without a note", () => {
    const parsed = messageSectionSchema.safeParse({
      text: 'hi',
      forYouBecause: { relation: 'other' },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/D-043/);
  });

  it("accepts relation:'other' WITH a note", () => {
    expect(
      messageSectionSchema.safeParse({
        text: 'hi',
        forYouBecause: { relation: 'other', note: 'you wrote the lint this refactor trips' },
      }).success,
    ).toBe(true);
  });

  it('accepts a structural relation without a note', () => {
    expect(
      messageSectionSchema.safeParse({
        text: 'hi',
        forYouBecause: { relation: 'holds-a-lock-on', ref: 'packages/x/y.ts' },
      }).success,
    ).toBe(true);
  });

  it("EXCLUDES 'other' from the asserted-vs-computed divergence check, by construction", () => {
    // The load-bearing half of D-043: an 'other' that participated in the diff
    // would reintroduce the false-agreement failure the escape hatch prevents.
    expect(participatesInCouplingDivergence({ relation: 'other', note: 'n' })).toBe(false);
    // The CONTROL, and it has to be a relation that genuinely participates or the
    // `false` above proves nothing. It was `same-fleet` until 2026-08-09, when
    // that relation stopped being comparable (D-054) — which would have quietly
    // turned this control into a second copy of the assertion above it.
    expect(participatesInCouplingDivergence({ relation: 'holds-a-lock-on' })).toBe(true);
  });

  it("EXCLUDES 'owns' too — it has no counterpart in the computed vocabulary", () => {
    // D-087, extending D-043. Measured 2026-08-01: `owns` is 27 of 51 live
    // asserted uses. Ownership is a work-item fact, never a coupling edge, so a
    // metric that compared it would report the MAJORITY relation as permanent
    // disagreement — a number that measures the vocabulary gap, not the sender.
    expect(participatesInCouplingDivergence({ relation: 'owns' })).toBe(false);
    expect(couplingDivergenceVerdict({ relation: 'owns' }, ['holds-a-lock-on'])).toBe(
      'not-comparable',
    );
  });
});

describe('couplingDivergenceVerdict (D-087) — three-valued, deliberately', () => {
  it('agrees when the computed graph carries the asserted signal', () => {
    expect(couplingDivergenceVerdict({ relation: 'awaits' }, ['awaits'])).toBe('agrees');
    expect(
      couplingDivergenceVerdict({ relation: 'holds-a-lock-on', ref: 'x.ts' }, [
        'coord-exchange',
        'holds-a-lock-on',
      ]),
    ).toBe('agrees');
  });

  it('scores DIVERGENCE only for the genuinely two-sided relations', () => {
    // `is-blocked-on` is two-sided AND computed, so a miss really is a
    // contradiction of the sender's claim, and that is worth counting.
    expect(couplingDivergenceVerdict({ relation: 'is-blocked-on' }, [])).toBe('diverges');
  });

  // THE HALF-FIX GUARD (D-054 / D-002 ruling 1). `same-fleet` was scored as
  // divergence here until 2026-08-09, when the derivation stopped emitting the
  // `same-fleet` edge. Removing that emitter WITHOUT flipping this rule is the
  // expensive half-fix: `confirmedBy` becomes unsatisfiable, so an
  // `absenceIsInformative: true` would score EVERY correctly-asserted
  // `same-fleet` as divergence — manufacturing disagreement out of a signal we
  // ourselves stopped computing, and then reporting it as a SENDER-accuracy
  // problem. The assertion stays perfectly valid; it is simply undiffable now,
  // exactly like `owns`.
  it('never scores an asserted relation the graph no longer computes', () => {
    expect(participatesInCouplingDivergence({ relation: 'same-fleet' })).toBe(false);
    expect(couplingDivergenceVerdict({ relation: 'same-fleet' }, [])).toBe('not-comparable');
    // Not even against a fully-populated graph — there is no token left to hit.
    expect(
      couplingDivergenceVerdict({ relation: 'same-fleet' }, ['holds-a-lock-on', 'awaits']),
    ).toBe('not-comparable');
  });

  it('is DIRECTION-INSENSITIVE for is-blocked-on — one asserted token, two computed', () => {
    // The graph splits the direction because it means opposite things to a
    // reader; the asserted vocabulary does not. Comparing against one direction
    // would score every correctly-asserted other-direction message as divergent.
    for (const dir of ['blocks-me', 'blocked-by-me'] as const) {
      expect(couplingDivergenceVerdict({ relation: 'is-blocked-on' }, [dir])).toBe('agrees');
    }
    expect(couplingDivergenceVerdict({ relation: 'is-blocked-on' }, ['coord-exchange'])).toBe(
      'diverges',
    );
  });

  it('a MISS on a one-sided relation is not-comparable, never divergence', () => {
    // The computed lock signal fires only on OVERLAP with the sender, while the
    // assertion is about the RECIPIENT alone. A recipient may hold a lock the
    // sender does not — absence of the edge is silence, not contradiction.
    expect(couplingDivergenceVerdict({ relation: 'holds-a-lock-on', ref: 'x.ts' }, [])).toBe(
      'not-comparable',
    );
    expect(couplingDivergenceVerdict({ relation: 'awaits' }, ['coord-exchange'])).toBe(
      'not-comparable',
    );
  });

  it('does not accept a merely-ADJACENT computed signal as confirmation of a LOCK claim', () => {
    // Quietly widening the token to "near enough" is how a diff starts agreeing
    // with itself. Until 2026-08-10 this was asserted against `shared-file` — a
    // DECLARED working-file, which is not a lock — but D-093 retired that relation
    // and the case became inexpressible in the type. The rule is unchanged, so it
    // is re-anchored on another live relation rather than deleted with its signal.
    expect(couplingDivergenceVerdict({ relation: 'holds-a-lock-on' }, ['awaits'])).toBe(
      'not-comparable',
    );
  });

  it("never scores 'other' either way", () => {
    expect(couplingDivergenceVerdict({ relation: 'other', note: 'n' }, ['coord-exchange'])).toBe(
      'not-comparable',
    );
  });

  // The rule table is the single source for BOTH exported functions, so this
  // holds by construction rather than by two definitions being kept in step.
  it('participatesInCouplingDivergence agrees with the verdict on what is comparable', () => {
    for (const relation of FOR_YOU_BECAUSE_RELATIONS) {
      const everyComputed = [...DERIVED_COUPLING_RELATIONS];
      const comparable = couplingDivergenceVerdict({ relation, note: 'n' }, everyComputed);
      expect(participatesInCouplingDivergence({ relation, note: 'n' })).toBe(
        comparable !== 'not-comparable',
      );
    }
  });
});

describe('the envelope/section split (D-064) — enforced, not documented', () => {
  it.each(ENVELOPE_ONLY_FIELDS)('refuses envelope field %s on a section', (field) => {
    expect(() => assertEnvelopeSectionSplit([{ text: 'a' }, { text: 'b', [field]: 'x' }])).toThrow(
      EnvelopeFieldOnSectionError,
    );
  });

  it('names the offending index and teaches the rule', () => {
    try {
      assertEnvelopeSectionSplit([{ text: 'a' }, { text: 'b', blocking: true }]);
      expect.unreachable('should have refused');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvelopeFieldOnSectionError);
      expect((e as EnvelopeFieldOnSectionError).code).toBe('coord_envelope_field_on_section');
      expect((e as Error).message).toContain('body[1].blocking');
      expect((e as Error).message).toMatch(/scheduler acts on a message as a UNIT/);
    }
  });

  it('allows all four SECTION fields on a section', () => {
    expect(
      messageSectionSchema.safeParse({
        text: 'the gate red is mine and already fixed',
        premises: ['WI-6199#completion', '/internal/docs/x'],
        forYouBecause: { relation: 'is-blocked-on', ref: 'gate' },
        youMayNotKnow: [{ ref: 'fact:owner:su-1:k@v2', provenance: 'computed' }],
        couldNotDetermine: [{ what: 'whether the next candidate carries the fix' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown key outright (strict)', () => {
    expect(messageSectionSchema.safeParse({ text: 'a', vibes: 'good' }).success).toBe(false);
  });
});

describe('structured section fields refuse a wrong shape by TEACHING it (EI-20021148706594627)', () => {
  const issuesOf = (input: unknown, field: 'youMayNotKnow' | 'couldNotDetermine') => {
    const r = messageSectionSchema.safeParse({ text: 'a', [field]: input });
    return r.success ? '' : r.error.issues.map((i) => i.message).join(' | ');
  };

  // The three shapes measured live on 2026-08-10, each of which previously cost its own
  // round-trip because zod disclosed exactly one layer at a time.
  const wrongShapes: Array<[string, unknown]> = [
    ['a bare string', 'some prose'],
    ['an array of strings', ['some prose']],
    ['an array of the WRONG object', [{ text: 'some prose' }]],
  ];

  describe.each(wrongShapes)('youMayNotKnow given %s', (_label, input) => {
    it('refuses it', () => {
      expect(messageSectionSchema.safeParse({ text: 'a', youMayNotKnow: input }).success).toBe(
        false,
      );
    });

    it('names the member shape in the FIRST error', () => {
      expect(issuesOf(input, 'youMayNotKnow')).toContain(YOU_MAY_NOT_KNOW_SHAPE_MESSAGE);
    });
  });

  describe.each(wrongShapes)('couldNotDetermine given %s', (_label, input) => {
    it('refuses it', () => {
      expect(messageSectionSchema.safeParse({ text: 'a', couldNotDetermine: input }).success).toBe(
        false,
      );
    });

    it('names the member shape in the FIRST error', () => {
      expect(issuesOf(input, 'couldNotDetermine')).toContain(COULD_NOT_DETERMINE_SHAPE_MESSAGE);
    });
  });

  it('still accepts the correct shape for both fields', () => {
    expect(
      messageSectionSchema.safeParse({
        text: 'a',
        youMayNotKnow: [{ ref: 'WI-1234', provenance: 'authored' }],
        couldNotDetermine: [{ what: 'whether the next candidate carries the fix', note: 'n' }],
      }).success,
    ).toBe(true);
  });

  /**
   * `premises` is the THIRD field of this family and was the last to get a taught refusal
   * (EI-20088434414057337, measured 2026-08-10 — five independent filings of the same
   * round-trip loop). Its wrong-shape set is NOT the same as its siblings': premises entries
   * are BARE REF STRINGS, so `['WI-1']` is CORRECT here and wrong for the other two. The
   * confusable neighbours are `forYouBecause` and `youMayNotKnow`, which use objects on the
   * very same section — which is why those shapes are commonly sent in `premises` by mistake.
   */
  const premisesWrongShapes: Array<[string, unknown]> = [
    ['a bare string', 'WI-1234#completion'],
    ['an array of ref OBJECTS (the forYouBecause generalization)', [{ ref: 'WI-1234' }]],
    ['an array of youMayNotKnow entries', [{ ref: 'WI-1234', provenance: 'authored' }]],
    ['an array of the wrong object', [{ text: 'WI-1234' }]],
  ];

  describe.each(premisesWrongShapes)('premises given %s', (_label, input) => {
    it('refuses it', () => {
      expect(messageSectionSchema.safeParse({ text: 'a', premises: input }).success).toBe(false);
    });

    it('names the member shape in the FIRST error', () => {
      const r = messageSectionSchema.safeParse({ text: 'a', premises: input });
      const messages = r.success ? '' : r.error.issues.map((i) => i.message).join(' | ');
      expect(messages).toContain(PREMISES_SHAPE_MESSAGE);
    });
  });

  it('accepts premises as an array of ref strings', () => {
    expect(
      messageSectionSchema.safeParse({
        text: 'a',
        premises: ['WI-1234#completion', 'my-plan#D-007'],
      }).success,
    ).toBe(true);
  });

  /**
   * REGRESSION PIN. `shapeTaughtArray` does not carry `.optional()`, so a field converted to it
   * becomes REQUIRED unless the call site chains `.optional()` — and the symptom is a bare
   * "Invalid input" on a plain `{ text }` section, i.e. EVERY message the fleet sends, failing
   * for a reason that names neither the field nor the cause. Caught in review of the very change
   * that added the taught refusal above; this pins it so the next conversion cannot repeat it.
   */
  it.each(['premises', 'youMayNotKnow', 'couldNotDetermine'] as const)(
    'leaves %s OPTIONAL — a section carrying only `text` is valid',
    (field) => {
      const r = messageSectionSchema.safeParse({ text: 'a' });
      expect(r.success).toBe(true);
      // …and the field is genuinely absent rather than defaulted to an empty array, which would
      // make "the sender declared nothing" indistinguishable from "the sender declared none".
      if (r.success) expect(r.data[field]).toBeUndefined();
    },
  );

  it('publishes only the strict array shape for taught fields', () => {
    const schema = z.toJSONSchema(messageSectionSchema) as {
      properties?: Record<
        string,
        {
          anyOf?: unknown[];
          items?: unknown;
          maxItems?: number;
          type?: string;
        }
      >;
    };

    for (const field of ['premises', 'youMayNotKnow', 'couldNotDetermine']) {
      const published = schema.properties?.[field];
      expect(published).toMatchObject({ type: 'array', maxItems: 20 });
      expect(published).not.toHaveProperty('anyOf');
      expect(published?.items).not.toEqual({});
    }
  });

  /**
   * THE RULING THIS PINS (owner 2026-07-28, interactive, for `body`; applied here):
   * a bare string must NOT be sugared into `{ ref, provenance: 'authored' }`. Six
   * agents have proposed exactly that sugar, so this test exists to make the next
   * such "fix" fail loudly rather than silently collapse `provenance` to the one
   * value that can never be refuted (D-040 / D-070 reinstated that split twice).
   */
  it('does NOT silently normalise a bare string into an entry (the sugar is the bug)', () => {
    const r = messageSectionSchema.safeParse({ text: 'a', youMayNotKnow: 'WI-1234' });
    expect(r.success).toBe(false);
    if (r.success) return;
    // and it must not have been coerced on the way to failing
    expect(JSON.stringify(r.error.issues)).not.toContain('"provenance":"authored"');
  });

  it('reports the length cap in ENTRIES, since `maxItems: 20` has been misread as characters', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      ref: `WI-${i}`,
      provenance: 'authored' as const,
    }));
    const msg = issuesOf(tooMany, 'youMayNotKnow');
    expect(msg).toMatch(/at most 20 ENTRIES/);
    expect(msg).toMatch(/not on the length of any string/);
  });

  /**
   * CONTROL: the guard could pass while teaching nothing — if the message stopped
   * naming the required keys, every assertion above would still be green because
   * they only check that SOME shared constant came back.
   */
  it('CONTROL: the taught message actually names the required keys', () => {
    expect(YOU_MAY_NOT_KNOW_SHAPE_MESSAGE).toMatch(/\bref\b/);
    expect(YOU_MAY_NOT_KNOW_SHAPE_MESSAGE).toMatch(/\bprovenance\b/);
    expect(YOU_MAY_NOT_KNOW_SHAPE_MESSAGE).toMatch(/computed/);
    expect(YOU_MAY_NOT_KNOW_SHAPE_MESSAGE).toMatch(/authored/);
    expect(COULD_NOT_DETERMINE_SHAPE_MESSAGE).toMatch(/\bwhat\b/);
    expect(COULD_NOT_DETERMINE_SHAPE_MESSAGE).toMatch(/\bnote\b/);
  });
});

describe('body normalisation (D-064 n=1)', () => {
  it('a plain string is the one-element array', () => {
    expect(toSections('hello')).toEqual([{ text: 'hello' }]);
  });

  it('empty/undefined bodies carry no sections', () => {
    expect(toSections(undefined)).toEqual([]);
    expect(toSections('')).toEqual([]);
  });

  it('round-trips section text for the readers that render plain body', () => {
    expect(sectionsToText([{ text: 'one' }, { text: 'two' }])).toBe('one\n\ntwo');
  });
});

describe('stampMessageFields', () => {
  it('leaves a plain-string send byte-identical on the wire (the n=1 case costs nothing)', () => {
    expect(stampMessageFields({ body: 'just prose' })).toEqual({});
  });

  it('stamps sections once they actually CARRY something', () => {
    const stamp = stampMessageFields({
      body: [{ text: 'a', premises: ['unified-agent-state-plane-2026-07-27#D-070'] }],
    });
    expect(stamp.sections).toHaveLength(1);
    expect(stamp.premisesClassified?.[0]?.[0]).toEqual({
      ref: 'unified-agent-state-plane-2026-07-27#D-070',
      kind: 'plan-decision',
      invalidatable: true,
    });
  });

  it('stamps multi-section bodies even when no authored field is set', () => {
    expect(stampMessageFields({ body: [{ text: 'a' }, { text: 'b' }] }).sections).toHaveLength(2);
  });

  it('classifies premises AT SEND TIME so no reader re-derives D-026', () => {
    const stamp = stampMessageFields({
      body: [{ text: 'a', premises: ['/internal/docs/x', 'msg:abc'] }],
    });
    expect(stamp.premisesClassified?.[0]?.map((p) => p.invalidatable)).toEqual([false, true]);
  });

  it('carries the envelope fields through unchanged', () => {
    const stamp = stampMessageFields({
      body: 'x',
      why: { goalRef: 'unified-agent-state-plane-2026-07-27#P-032', note: 'owner directive' },
      blocking: false,
    });
    expect(stamp.why?.goalRef).toBe('unified-agent-state-plane-2026-07-27#P-032');
    expect(stamp.blocking).toBe(false);
  });
});

/**
 * P-033 (e) — the READER projection. `coord:read`, `coord:thread` and the pui pane
 * all showed only the FLATTENED body string, so a field nobody could see could not
 * be judged by its VALUES — the only check D-070 leaves standing.
 */
describe('projectAuthoredFields — making the fields readable', () => {
  /** The exact shape the send path writes onto the envelope. */
  function stamped(input: Parameters<typeof stampMessageFields>[0], rest: Record<string, unknown> = {}) {
    return { ...stampMessageFields(input), ...rest };
  }

  it('returns undefined for a plain message — an ordinary send grows no new block', () => {
    expect(projectAuthoredFields(undefined)).toBeUndefined();
    expect(projectAuthoredFields({})).toBeUndefined();
    expect(projectAuthoredFields(stamped({ body: 'just text' }))).toBeUndefined();
  });

  it('is total on junk — a malformed envelope never throws at a reader', () => {
    expect(projectAuthoredFields(null)).toBeUndefined();
    expect(projectAuthoredFields('nonsense')).toBeUndefined();
    expect(projectAuthoredFields(42)).toBeUndefined();
    expect(projectAuthoredFields({ sections: 'not-an-array' })).toBeUndefined();
  });

  it('surfaces the four SECTION fields per section (D-064)', () => {
    const out = projectAuthoredFields(
      stamped({
        body: [
          {
            text: 'a',
            premises: ['WI-1#completion'],
            forYouBecause: { relation: 'owns', ref: 'P-033' },
            youMayNotKnow: [{ ref: 'D-072', provenance: 'authored' }],
            couldNotDetermine: [{ what: 'whether the deploy landed' }],
          },
          { text: 'b' },
        ],
      }),
    );
    expect(out?.sections).toHaveLength(2);
    expect(out?.sections?.[0]?.forYouBecause?.relation).toBe('owns');
    expect(out?.sections?.[0]?.youMayNotKnow).toHaveLength(1);
    expect(out?.sections?.[0]?.couldNotDetermine?.[0]?.what).toBe('whether the deploy landed');
    // The second section authored nothing — it keeps its text and gains no fields.
    expect(out?.sections?.[1]).toEqual({ text: 'b' });
  });

  it('hands the reader premises ALREADY CLASSIFIED, so nobody re-derives D-026', () => {
    const out = projectAuthoredFields(
      stamped({ body: [{ text: 'a', premises: ['/internal/docs/x', 'msg:abc'] }] }),
    );
    expect(out?.sections?.[0]?.premises?.map((p) => p.invalidatable)).toEqual([false, true]);
    expect(out?.sections?.[0]?.premises?.[0]?.ref).toBe('/internal/docs/x');
  });

  it('classifies on the fly for a message stamped before premisesClassified existed', () => {
    // Back-compat: sections present, classification absent. D-026 forbids dropping a
    // citation for being unrecognised, so it must still come back classified.
    const out = projectAuthoredFields({ sections: [{ text: 'a', premises: ['msg:abc'] }] });
    expect(out?.sections?.[0]?.premises).toEqual([
      { ref: 'msg:abc', kind: 'peer-message', invalidatable: true },
    ]);
  });

  it('surfaces the ENVELOPE fields once, never per section (D-064’s load-bearing half)', () => {
    const out = projectAuthoredFields(
      stamped(
        { body: [{ text: 'a', premises: ['WI-1#x'] }], why: { goalRef: 'plan#P-033' }, blocking: true },
        { expects: 'action' },
      ),
    );
    expect(out?.expects).toBe('action');
    expect(out?.blocking).toBe(true);
    expect(out?.why?.goalRef).toBe('plan#P-033');
    for (const section of out?.sections ?? []) {
      for (const field of ENVELOPE_ONLY_FIELDS) {
        expect(section).not.toHaveProperty(field);
      }
    }
  });

  it('marks DERIVED values so adoption measurement can exclude them (D-072)', () => {
    const out = projectAuthoredFields(
      stamped({ body: [{ text: 'a', premises: ['WI-1#x'] }] }, {
        expects: 'none',
        fieldProvenance: { expects: 'owner-gui-derived' },
      }),
    );
    // The VALUE is still shown — a reader needs it — but it is flagged as not authored.
    expect(out?.expects).toBe('none');
    expect(out?.derivedFields).toContain('expects');
  });

  it('projects clarify through to the reader — an unrendered field is a mechanism with no consumer', () => {
    const out = projectAuthoredFields(
      stamped(
        {
          body: [
            { text: 'a', clarify: [{ question: 'which harness?', assuming: 'papercusp' }] },
          ],
        },
        {},
      ),
    );
    expect(out?.sections?.[0]?.clarify?.[0]?.question).toBe('which harness?');
    expect(out?.sections?.[0]?.clarify?.[0]?.assuming).toBe('papercusp');
  });

  it('a fully-derived message is still distinguishable from an authored one', () => {
    const authoredMsg = projectAuthoredFields(stamped({ body: 'x' }, { expects: 'action' }));
    const derivedMsg = projectAuthoredFields(
      stamped({ body: 'x' }, { expects: 'action', fieldProvenance: { expects: 'machine-derived' } }),
    );
    expect(authoredMsg?.derivedFields).toBeUndefined();
    expect(derivedMsg?.derivedFields).toEqual(['expects']);
  });
});
