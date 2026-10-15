import { describe, expect, it } from 'vitest';
import { parsePlan } from '../parser';
import { detectNowItemContradictions, detectNowItemOmissions } from '../now-item-contradictions';
import { evaluateSetContent } from '../set-content';
import { evaluateNowUpdate } from '../set-now';
import { lintParsed } from '../lint';
import { applyNowNoteToParsed, type PlanNowNote } from '../now-note-store';
import type { NowItemContradiction } from '../now-item-contradictions';

const SLUG = 'now-item-contradictions-2026-08-23';

const CURRENT = `---
title: Now contradiction test
slug: ${SLUG}
status: active
created: 2026-08-23
updated: 2026-08-23
---

# Now contradiction test

## Now

**State:** P-001 is done.

**Next:** Continue with P-002.

## Phase 1

- **P-001** \`done\` Finished item.
- **P-002** \`todo\` Open item.

## Decisions
`;

const EXACT_REPRO_SLUG = 'deterministic-plan-state-derivation-2026-08-31';
const EXACT_REPORTED_COMPLETIONS = [
  'P-002 (WI-1744270) made the `## Now` next-pointer DERIVED at read time',
  'P-002 landed, making the `## Now` next-pointer DERIVED at read time',
];
const EXACT_REPORTED_PROVENANCE =
  'P-001 and P-002 are done. Exact-plan launch path remains intentionally unused because the plan lacked promoted P-002 execution metadata.';
const EXACT_REPRO_CURRENT = CURRENT.replace(`slug: ${SLUG}`, `slug: ${EXACT_REPRO_SLUG}`)
  .replace(
    '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
    '**State:** P-001 is done.\n\n**Next:** Continue with acceptance review.',
  )
  .replace('- **P-002** `todo` Open item.', '- **P-002** `done` Finished item.');
const EXACT_REPRO_WITH_TERMINAL_P008 = EXACT_REPRO_CURRENT.replace(
  '- **P-002** `done` Finished item.',
  '- **P-002** `done` Finished item.\n- **P-008** `done` Finished item.',
);

const GROUPED_COMPLETION = CURRENT.replace(
  '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
  '**State:** NOT COMPLETE: The engineering half (P-001/P-002/P-003/P-004/P-005/P-007) is code-truth audited and independently accepted; P-008 remains blocked.\n\n**Next:** Continue with P-008.',
).replace(
  '- **P-002** `todo` Open item.',
  '- **P-002** `done` Finished item.\n- **P-003** `done` Finished item.\n- **P-004** `done` Finished item.\n- **P-005** `done` Finished item.\n- **P-006** `todo` Open item.\n- **P-007** `done` Finished item.',
);

const RETROSPECTIVE_GROUP_COMPLETION = CURRENT.replace(
  '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
  '**State:** The precedence rule (P-003) and the top-index reverse binding (P-005) were pure logic inlined in components with ZERO coverage; both are now extracted into session-turn-index.ts and tested (13 new cases).\n\n**Next:** Continue with P-002.',
).replace(
  '- **P-002** `todo` Open item.',
  '- **P-002** `todo` Open item.\n- **P-003** `done` Fixed item.\n- **P-004** `done` Fixed item.\n- **P-005** `done` Fixed item.',
);

const RETROSPECTIVE_METADATA_REFERENCE = CURRENT.replace(
  '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
  '**State:** P-003/P-004 blobShas went stale when the structural tests landed; references now point to the current implementation.\n\n**Next:** Continue with P-002.',
).replace(
  '- **P-002** `todo` Open item.',
  '- **P-002** `todo` Open item.\n- **P-003** `done` Fixed item.\n- **P-004** `done` Fixed item.',
);

const DECISION_REFERENCE = CURRENT.replace(
  '**State:** P-001 is done.',
  "**State:** D-022 records P-001's stack-mutation primitive — attach/detach with delivery semantics.",
);

const RESIDUE_HANDOFF = CURRENT.replace(
  '**State:** P-001 is done.',
  "**State:** P-001's measurement residue is owned by WI-1311290, not dropped.",
);

const RESIDUE_CARRY_FORWARD = CURRENT.replace(
  '**State:** P-001 is done.',
  "**State:** P-001's measurement residue carries forward under WI-1311290.",
);

const DROPPED_ITEM_EXPLANATION = CURRENT.replace(
  '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
  "**State:** P-002 and P-003 item text states its trigger as 'only if P-001 resolves', but P-001 is DROPPED and will never report.\n\n**Next:** Continue with P-002.",
)
  .replace('- **P-001** `done` Finished item.', '- **P-001** `dropped` Dropped item.')
  .replace('- **P-002** `todo` Open item.', '- **P-002** `todo` Open item.\n- **P-003** `todo` Open item.');

const MEASURED_TERMINAL_ITEM = CURRENT.replace(
  '**State:** P-001 is done.',
  '**State:** P-005 measured 9.27% of rows / 5.73% of cost.',
).replace('- **P-002** `todo` Open item.', '- **P-002** `todo` Open item.\n- **P-005** `done` Measured item.');

const EXHAUSTIVE_OMISSION = CURRENT.replace(
  '**Next:** Continue with P-002.',
  '**Next:** P-002 only, and it is not actionable yet.',
).replace('- **P-002** `todo` Open item.', '- **P-002** `todo` Open item.\n- **P-003** `todo` Urgent open item.');

const DESCRIBED_REMAINING_WORK = CURRENT.replace(
  '**State:** P-001 is done.',
  '**State:** Remaining work is P-005 retirement and P-007 final acceptance/shipment, held by successor su-455545e0 in owner-directed AUTO.',
)
  .replace('**Next:** Continue with P-002.', '**Next:** Read the current checkpoints.')
  .replace(
    '- **P-002** `todo` Open item.',
    '- **P-002** `done` Finished item.\n- **P-005** `blocked` Retirement item.\n- **P-007** `todo` Acceptance and shipment item.',
  );

describe('detectNowItemContradictions', () => {
  it('flags an action-oriented mention of a terminal item', () => {
    const proposed = parsePlan(
      CURRENT.replace('**Next:** Continue with P-002.', '**Next:** Revisit P-001 before continuing.'),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('allows terminal items to be described as completed', () => {
    const parsed = parsePlan(CURRENT);

    expect(detectNowItemContradictions(parsed)).toEqual([]);
  });

  it('allows a neutral possessive citation after an explicit terminal completion', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.',
        "**State:** P-001 IS DONE as of 2026-09-16T17:07Z; of P-001's 5 AUTO-REQ-M-* specs only M-004 and M-102 are item-specific.",
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it('still flags a possessive citation that describes remaining terminal work', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.',
        "**State:** P-001 IS DONE as of 2026-09-16T17:07Z; of P-001's remaining work, fix the item-specific specs.",
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('allows a terminal item named only by an explicit do-not-reopen guard', () => {
    const proposed = parsePlan(
      CURRENT
        .replace('**Next:** Continue with P-002.', '**Next:** Claim P-007 ...; do not reopen completed Phone or P-002.')
        .replace('- **P-002** `todo` Open item.', '- **P-002** `done` Finished item.'),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it('still flags a later positive reopen after a do-not-reopen guard', () => {
    const proposed = parsePlan(
      CURRENT
        .replace(
          '**Next:** Continue with P-002.',
          '**Next:** do not reopen completed Phone or P-002, but reopen P-002.',
        )
        .replace('- **P-002** `todo` Open item.', '- **P-002** `done` Finished item.'),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-002', status: 'done' }),
    ]);
  });

  it('ignores a quoted stale trigger and accepts the explicit dropped status that corrects it', () => {
    expect(detectNowItemContradictions(parsePlan(DROPPED_ITEM_EXPLANATION))).toEqual([]);
  });

  it('allows an affirmative past-tense measurement of a terminal item', () => {
    expect(detectNowItemContradictions(parsePlan(MEASURED_TERMINAL_ITEM))).toEqual([]);
  });

  it.each([
    'P-005 will measure 9.27% of rows.',
    'Measure P-005 again before continuing.',
    'P-005 is still open for measurement.',
  ])('keeps future, imperative, and active measurement prose contradictory: %s', (state) => {
    const proposed = MEASURED_TERMINAL_ITEM.replace('**State:** P-005 measured 9.27% of rows / 5.73% of cost.', `**State:** ${state}`);
    expect(detectNowItemContradictions(parsePlan(proposed))).toEqual([
      expect.objectContaining({ id: 'P-005', status: 'done' }),
    ]);
  });

  it.each(['P-001–P-002', 'P-001-P-002', 'P-001 to P-002'])(
    'does not treat a plan-item range reference as an individual terminal claim: %s',
    (range) => {
      const proposed = parsePlan(
        CURRENT.replace(
          '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
          `**State:** On each AUTO wake, re-read latest ${range}.\n\n**Next:** Continue with P-002.`,
        ),
      );

      expect(detectNowItemContradictions(proposed)).toEqual([]);
    },
  );

  it('allows an item completed on staging while absent from main/deployed', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.',
        '**State:** P-001 is done on staging but not in main/deployed.',
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it.each([
    ['negated', 'P-001 is not done on staging but not in main/deployed.'],
    ['future', 'P-001 will be done on staging but not in main/deployed.'],
    ['action-oriented', 'Finish P-001 on staging but not in main/deployed.'],
  ])('still flags %s staging wording', (_label, state) => {
    const proposed = parsePlan(CURRENT.replace('**State:** P-001 is done.', `**State:** ${state}`));

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  // EI-21920559821120577 (partial) — the exemption vocabulary was missing the
  // past-tense completion verbs this codebase actually uses. Found while
  // implementing deterministic-plan-state-derivation-2026-08-31 P-002, whose
  // read-time caution reuses this classifier: "P-001 landed; pick up P-002" —
  // the most common shape a Now block takes — was reported as a contradiction,
  // which on the WRITE path is a hard refusal of a correct sentence.
  describe('past-tense completion verbs (EI-21920559821120577, partial)', () => {
    for (const verb of ['landed', 'merged', 'resolved']) {
      it(`treats "P-001 ${verb}" as completion prose, not a contradiction`, () => {
        const proposed = parsePlan(
          CURRENT.replace('**State:** P-001 is done.', `**State:** P-001 ${verb}; pick up P-002.`),
        );
        expect(detectNowItemContradictions(proposed)).toEqual([]);
      });

      // PAIRED CONTROL — the whole point of restricting the addition to
      // past-tense forms. If the bare stem were added too, the guard would stop
      // catching a direction to redo finished work, and this half would fail.
      it(`still flags the IMPERATIVE stem of "${verb}"`, () => {
        const stem = verb === 'landed' ? 'land' : verb === 'merged' ? 'merge' : 'resolve';
        const proposed = parsePlan(
          CURRENT.replace('**Next:** Continue with P-002.', `**Next:** ${stem} P-001 first.`),
        );
        expect(detectNowItemContradictions(proposed)).toEqual([
          expect.objectContaining({ id: 'P-001', status: 'done' }),
        ]);
      });
    }

    it('does not exempt a NEGATED past-tense completion', () => {
      // "P-001 has not landed" asserts the item is unfinished while it is
      // stored done — still a contradiction, exactly like "not done yet".
      const proposed = parsePlan(
        CURRENT.replace('**State:** P-001 is done.', '**State:** P-001 has not landed yet.'),
      );
      expect(detectNowItemContradictions(proposed)).toEqual([
        expect.objectContaining({ id: 'P-001', status: 'done' }),
      ]);
    });

    it('accepts quantitative test-pass evidence as completion narration', () => {
      const proposed = parsePlan(
        CURRENT.replace(
          '**State:** P-001 is done.',
          '**State:** P-001 passed 113/113 focused tests plus 9/9 migrated-Postgres tests.',
        ),
      );

      expect(detectNowItemContradictions(proposed)).toEqual([]);
    });

    it.each([
      'P-001 has not passed 113/113 focused tests yet.',
      'P-001 will have passed 113/113 focused tests.',
      'Pass P-001 focused tests before continuing.',
    ])('still flags non-completion test-pass wording: %s', (state) => {
      const proposed = parsePlan(CURRENT.replace('**State:** P-001 is done.', `**State:** ${state}`));

      expect(detectNowItemContradictions(proposed)).toEqual([
        expect.objectContaining({ id: 'P-001', status: 'done' }),
      ]);
    });
  });

  it('flags negated completion instead of treating it as closure', () => {
    const proposed = parsePlan(
      CURRENT.replace('**State:** P-001 is done.', '**State:** P-001 is not done yet.'),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('preserves dropped as the terminal status in contradiction evidence', () => {
    const proposed = parsePlan(
      CURRENT
        .replace('- **P-001** `done` Finished item.', '- **P-001** `dropped` Dropped item.')
        .replace('**Next:** Continue with P-002.', '**Next:** Revisit P-001 before continuing.'),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'dropped' }),
    ]);
  });

  it('allows grouped affirmative completion evidence before unrelated blocked work', () => {
    expect(detectNowItemContradictions(parsePlan(GROUPED_COMPLETION))).toEqual([]);
  });

  it('allows retrospective group prose resolved by a later affirmative clause', () => {
    expect(detectNowItemContradictions(parsePlan(RETROSPECTIVE_GROUP_COMPLETION))).toEqual([]);
  });

  it('keeps future group resolution contradictory', () => {
    const proposed = RETROSPECTIVE_GROUP_COMPLETION.replace(
      'both are now extracted into session-turn-index.ts and tested',
      'both will now be extracted into session-turn-index.ts and tested',
    );

    expect(detectNowItemContradictions(parsePlan(proposed))).toEqual([
      expect.objectContaining({ id: 'P-003', status: 'done' }),
      expect.objectContaining({ id: 'P-005', status: 'done' }),
    ]);
  });

  it('keeps negated group resolution contradictory', () => {
    const proposed = RETROSPECTIVE_GROUP_COMPLETION.replace(
      'both are now extracted into session-turn-index.ts and tested',
      'both are not now extracted into session-turn-index.ts and tested',
    );

    expect(detectNowItemContradictions(parsePlan(proposed))).toEqual([
      expect.objectContaining({ id: 'P-003', status: 'done' }),
      expect.objectContaining({ id: 'P-005', status: 'done' }),
    ]);
  });

  it('does not let a collective resolution excuse a clause containing open work', () => {
    const proposed = RETROSPECTIVE_GROUP_COMPLETION.replace(
      '(P-003) and the top-index reverse binding (P-005)',
      '(P-003) and the top-index reverse binding (P-002)',
    );

    expect(detectNowItemContradictions(parsePlan(proposed))).toEqual([
      expect.objectContaining({ id: 'P-003', status: 'done' }),
    ]);
  });

  it('allows terminal IDs used as a slash-separated metadata reference in past-tense prose', () => {
    expect(detectNowItemContradictions(parsePlan(RETROSPECTIVE_METADATA_REFERENCE))).toEqual([]);
  });

  it('still flags an action against a slash-separated metadata reference', () => {
    const proposed = RETROSPECTIVE_METADATA_REFERENCE.replace(
      'P-003/P-004 blobShas went stale when the structural tests landed; references now point to the current implementation.',
      'Refresh P-003/P-004 blobShas before continuing.',
    );

    expect(detectNowItemContradictions(parsePlan(proposed))).toEqual([
      expect.objectContaining({ id: 'P-003', status: 'done' }),
      expect.objectContaining({ id: 'P-004', status: 'done' }),
    ]);
  });

  it('allows terminal IDs in an explicit historical promotion reference', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** COMPLETE: all items are terminal. Historical promotion record: P-001–P-001/WI-41306.',
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it('allows a neutral cross-ledger implementation mapping for a terminal item', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** The consumer lane is now WI-41755/P-001 under D-081; its affected-radius verification remains in progress.\n\n**Next:** Continue the affected-radius verification.',
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it('allows a neutral decision reference for a terminal item', () => {
    expect(detectNowItemContradictions(parsePlan(DECISION_REFERENCE))).toEqual([]);
  });

  it('still flags action or status wording around a decision reference', () => {
    const action = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** Revisit D-022 records P-001 before continuing.\n\n**Next:** Continue with P-002.',
      ),
    );
    const pending = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** D-022 records P-001 as pending work.\n\n**Next:** Continue with P-002.',
      ),
    );

    expect(detectNowItemContradictions(action)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
    expect(detectNowItemContradictions(pending)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it.each([
    ['owned residue', RESIDUE_HANDOFF],
    ['carried residue', RESIDUE_CARRY_FORWARD],
  ])('allows a terminal item in a neutral %s handoff', (_label, proposed) => {
    expect(detectNowItemContradictions(parsePlan(proposed))).toEqual([]);
  });

  it.each([
    "P-001's measurement residue remains open under WI-1311290.",
    "Revisit P-001's measurement residue is owned by WI-1311290, not dropped.",
    "P-001's measurement residue is owned by WI-1311290, not dropped yet.",
  ])('still flags an active, action-oriented, or future residue handoff: %s', (state) => {
    const proposed = parsePlan(CURRENT.replace('**State:** P-001 is done.', `**State:** ${state}`));
    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('still flags action or active-status wording around a cross-ledger reference', () => {
    const action = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** Revisit WI-41755/P-001 under D-081 before continuing.',
      ),
    );
    const active = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** Active implementation lane: WI-41755/P-001 under D-081.',
      ),
    );

    expect(detectNowItemContradictions(action)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
    expect(detectNowItemContradictions(active)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('still flags an action-oriented mention inside a historical note', () => {
    const proposed = parsePlan(
      CURRENT.replace(
        '**State:** P-001 is done.\n\n**Next:** Continue with P-002.',
        '**State:** COMPLETE: the prior run is recorded. Historical note: revisit P-001.',
      ),
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('exempts a P-NNN mention explicitly prefixed by a DIFFERENT plan slug', () => {
    // EI-21900747713795768: "Audited under <other-plan> P-001" cites the
    // OTHER plan's P-001, not this plan's own (terminal) P-001 — even though
    // the reference reads exactly like the action-oriented shape this guard
    // otherwise flags.
    const proposed = parsePlan(
      CURRENT.replace(
        '**Next:** Continue with P-002.',
        '**Next:** Audited under pui-tui-ship-drive-2026-08-30 P-001.',
      ),
      { filePath: `${SLUG}.md` },
    );

    expect(detectNowItemContradictions(proposed)).toEqual([]);
  });

  it('still flags a P-NNN mention prefixed by THIS plan\'s own slug', () => {
    // The slug-prefix exemption is scoped to a genuinely DIFFERENT plan — a
    // citation of this plan's own slug is not a foreign reference and must
    // not silently defeat the guard.
    const proposed = parsePlan(
      CURRENT.replace(
        '**Next:** Continue with P-002.',
        `**Next:** Revisit ${SLUG} P-001 before continuing.`,
      ),
      { filePath: `${SLUG}.md` },
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });

  it('does not exempt a bare terminal-status word merely resembling a slug segment', () => {
    // Guard against a regression that treats any hyphenated word before the
    // id as a foreign-plan citation: without a trailing -YYYY-MM-DD date the
    // prefix regex must not match at all, so ordinary action wording is
    // still caught.
    const proposed = parsePlan(
      CURRENT.replace('**Next:** Continue with P-002.', '**Next:** re-revisit P-001 before continuing.'),
      { filePath: `${SLUG}.md` },
    );

    expect(detectNowItemContradictions(proposed)).toEqual([
      expect.objectContaining({ id: 'P-001', status: 'done' }),
    ]);
  });
});

describe('detectNowItemOmissions', () => {
  it('counts described plan-item references in exhaustive remaining-work prose', () => {
    expect(detectNowItemOmissions(parsePlan(DESCRIBED_REMAINING_WORK))).toEqual([]);
  });

  it('still flags a described remaining-work list that omits an open item', () => {
    const proposed = DESCRIBED_REMAINING_WORK.replace(
      'P-005 retirement and P-007 final acceptance/shipment',
      'P-005 retirement',
    );

    expect(detectNowItemOmissions(parsePlan(proposed))).toEqual([
      expect.objectContaining({ listed: ['P-005'], omitted: ['P-007'] }),
    ]);
  });

  it('flags an exhaustive "only" list that omits a non-terminal item', async () => {
    const parsed = parsePlan(EXHAUSTIVE_OMISSION);
    expect(detectNowItemOmissions(parsed)).toEqual([
      expect.objectContaining({ listed: ['P-002'], omitted: ['P-003'] }),
    ]);
  });

  it('does not flag an ordinary next-item pointer as exhaustive', async () => {
    const parsed = parsePlan(EXHAUSTIVE_OMISSION.replace('P-002 only', 'Continue with P-002'));
    expect(detectNowItemOmissions(parsed)).toEqual([]);
  });

  it('does not treat a neutral item-scoped sentence as a closed plan list', () => {
    const parsed = parsePlan(
      EXHAUSTIVE_OMISSION.replace(
        '**Next:** P-002 only, and it is not actionable yet.',
        '**Next:** The focused tests cover P-002 only.',
      ),
    );
    expect(detectNowItemOmissions(parsed)).toEqual([]);
  });

  it.each([
    'Only P-002 remains actionable.',
    'Remaining items: P-002.',
  ])('recognizes the exhaustive wording %s', (next) => {
    const parsed = parsePlan(
      EXHAUSTIVE_OMISSION.replace(
        '**Next:** P-002 only, and it is not actionable yet.',
        `**Next:** ${next}`,
      ),
    );
    expect(detectNowItemOmissions(parsed)).toEqual([
      expect.objectContaining({ listed: ['P-002'], omitted: ['P-003'] }),
    ]);
  });

  it('accepts a complete exhaustive list', () => {
    const parsed = parsePlan(
      EXHAUSTIVE_OMISSION.replace(
        '**Next:** P-002 only, and it is not actionable yet.',
        '**Next:** P-002 and P-003 only.',
      ),
    );
    expect(detectNowItemOmissions(parsed)).toEqual([]);
  });

  it('surfaces the omission as a plan-lint error', async () => {
    const report = await lintParsed(
      parsePlan(EXHAUSTIVE_OMISSION, { filePath: `${SLUG}.md` }),
      SLUG,
      false,
    );
    expect(report.errors).toEqual([
      expect.objectContaining({ code: 'now_item_omission', itemId: 'P-003' }),
    ]);
  });
});

describe('evaluateSetContent — Now/item contradiction guard', () => {
  it('rejects a whole-document write that introduces a terminal-item contradiction', async () => {
    const proposed = CURRENT.replace(
      '**Next:** Continue with P-002.',
      '**Next:** Revisit P-001 before continuing.',
    );
    const result = await evaluateSetContent(CURRENT, proposed, SLUG, undefined, {
      wholeDocumentRewrite: true,
    });

    expect(result.newBody).toBeNull();
    expect(result.value.ok).toBe(false);
    if (!result.value.ok) {
      expect(result.value.code).toBe('lint_failed');
      if (result.value.code === 'lint_failed') {
        expect(result.value.errors).toEqual([
          expect.objectContaining({ code: 'now_item_status_contradiction', itemId: 'P-001' }),
        ]);
      }
    }
  });
});

/**
 * derived-status-not-hand-written-2026-10-12 P-006 retired the plans:set-now
 * contradiction refusal: set-now now stores a note that names a finished item
 * (pinned in set-now.note-only.test.ts). The detector is unchanged and still
 * drives plans:lint's `now_item_status_contradiction` and the derived Next, so
 * the wording cases below keep pinning how it reads a Now NOTE. `noteVerdict`
 * returns the omission refusal set-now still makes, else the contradiction
 * verdict lint reports for the plan once the note is written, beside the note
 * set-now wrote.
 */
function noteVerdict(
  current: string,
  state: string,
  next: string,
  slug: string,
): {
  nowNote: PlanNowNote | undefined;
  value:
    | { ok: true }
    | { ok: false; code: 'now_item_status_contradiction'; contradictions: NowItemContradiction[] }
    | { ok: false; code: 'not_found' | 'now_item_omission'; [key: string]: unknown };
} {
  const written = evaluateNowUpdate(current, state, next, slug);
  if (!written.value.ok || !written.nowNote) return { nowNote: written.nowNote, value: written.value };
  const asRead = applyNowNoteToParsed(parsePlan(current, { filePath: `${slug}.md` }), written.nowNote);
  const contradictions = detectNowItemContradictions(asRead);
  return {
    nowNote: written.nowNote,
    value: contradictions.length > 0
      ? { ok: false, code: 'now_item_status_contradiction', contradictions }
      : { ok: true },
  };
}

describe('evaluateNowUpdate — a note may mention finished items (P-006)', () => {
  it('stores a note that points back at a terminal item; lint still reports it', () => {
    const written = evaluateNowUpdate(CURRENT, 'Work remains.', 'Revisit P-001.', SLUG);
    expect(written.value).toEqual({ ok: true });
    expect(written.nowNote?.next).toBe('Revisit P-001.');
    expect(noteVerdict(CURRENT, 'Work remains.', 'Revisit P-001.', SLUG).value).toMatchObject({
      ok: false,
      code: 'now_item_status_contradiction',
    });
  });
});

describe('Now note wording — the plans:lint contradiction verdict', () => {
  it('flags a note that points back at a terminal item', () => {
    const result = noteVerdict(CURRENT, 'Work remains.', 'Revisit P-001.', SLUG);

    expect(result.nowNote).toBeDefined(); // P-006: set-now stores it; lint flags it
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-001', status: 'done' })],
    });
  });

  it('accepts a structured Now write that records completion and advances to open work', () => {
    const result = noteVerdict(CURRENT, 'P-001 is done.', 'Continue with P-002.', SLUG);

    expect(result.value).toEqual({ ok: true });
    expect(result.nowNote?.next).toBe('Continue with P-002.');
  });

  it('accepts a structured Now write with a neutral possessive citation after completion', () => {
    const result = noteVerdict(
      CURRENT,
      "P-001 IS DONE as of 2026-09-16T17:07Z; of P-001's 5 AUTO-REQ-M-* specs only M-004 and M-102 are item-specific.",
      'Continue with P-002.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
    expect(result.nowNote?.state).toContain("of P-001's 5 AUTO-REQ-M-* specs only M-004 and M-102 are item-specific.");
  });

  it('accepts a structured Now write with an explicit do-not-reopen terminal guard', () => {
    const current = CURRENT.replace('- **P-002** `todo` Open item.', '- **P-002** `done` Finished item.');
    const result = noteVerdict(
      current,
      'Work remains.',
      'Claim P-007 ...; do not reopen completed Phone or P-002.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
    expect(result.nowNote?.next).toContain('do not reopen completed Phone or P-002.');
  });

  it('rejects a positive reopen that follows a do-not-reopen terminal guard', () => {
    const current = CURRENT.replace('- **P-002** `todo` Open item.', '- **P-002** `done` Finished item.');
    const result = noteVerdict(
      current,
      'Work remains.',
      'do not reopen completed Phone or P-002, but reopen P-002.',
      SLUG,
    );

    expect(result.nowNote).toBeDefined(); // P-006: set-now stores it; lint flags it
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-002', status: 'done' })],
    });
  });

  it('accepts a structured Now write that references an item range', () => {
    const result = noteVerdict(
      CURRENT,
      'On each AUTO wake, re-read latest P-001–P-002.',
      'Continue with P-002.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it.each(EXACT_REPORTED_COMPLETIONS)(
    'accepts the reported completion narration at current HEAD: %s',
    (state) => {
      const result = noteVerdict(
        EXACT_REPRO_CURRENT,
        state,
        'Continue with acceptance review.',
        EXACT_REPRO_SLUG,
      );

      expect(result.value).toEqual({ ok: true });
    },
  );

  it('accepts a terminal item in neutral historical promotion provenance', () => {
    const result = noteVerdict(
      EXACT_REPRO_CURRENT,
      EXACT_REPORTED_PROVENANCE,
      'Continue with acceptance review.',
      EXACT_REPRO_SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it('accepts committed closure authority as terminal completion evidence', () => {
    const result = noteVerdict(
      EXACT_REPRO_CURRENT,
      'P-002 closure authority is committed.',
      'Continue with acceptance review.',
      EXACT_REPRO_SLUG,
    );

    expect(result.value).toEqual({ ok: true });
    expect(result.nowNote?.state).toBe('P-002 closure authority is committed.');
  });

  it.each([
    'P-002 closure authority is not committed.',
    'P-002 closure authority will be committed.',
    'P-002 committed the closure authority for a later review.',
  ])('still rejects negated, future, or non-authoritative closure prose: %s', (state) => {
    const result = noteVerdict(
      EXACT_REPRO_CURRENT,
      state,
      'Continue with acceptance review.',
      EXACT_REPRO_SLUG,
    );

    expect(result.nowNote).toBeDefined(); // P-006: set-now stores it; lint flags it
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-002', status: 'done' })],
    });
  });

  it('accepts a short named foreign-plan reference to a terminal local id', () => {
    const result = noteVerdict(
      EXACT_REPRO_WITH_TERMINAL_P008,
      'Evaluation UI integration remains open behind modernization P-008.',
      'Continue with acceptance review.',
      EXACT_REPRO_SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it('does not treat a same-plan name as a foreign-plan reference', () => {
    const result = noteVerdict(
      EXACT_REPRO_WITH_TERMINAL_P008,
      'Evaluation UI integration remains open behind deterministic P-008.',
      'Continue with acceptance review.',
      EXACT_REPRO_SLUG,
    );

    expect(result.nowNote).toBeDefined(); // P-006: set-now stores it; lint flags it
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-008', status: 'done' })],
    });
  });

  it.each([
    'P-001 and P-002 are done. Exact-plan launch path remains intentionally unused because the plan lacks promoted P-002 execution metadata.',
    'P-001 and P-002 are done. Exact-plan launch path remains intentionally unused because the plan will lack promoted P-002 execution metadata.',
    'P-001 and P-002 are done. Exact-plan launch path remains intentionally unused because the plan lacked promoted P-002 execution metadata; revisit P-002.',
  ])('still rejects non-historical or action-oriented promotion provenance: %s', (state) => {
    const result = noteVerdict(
      EXACT_REPRO_CURRENT,
      state,
      'Continue with acceptance review.',
      EXACT_REPRO_SLUG,
    );

    expect(result.nowNote).toBeDefined(); // P-006: set-now stores it; lint flags it
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-002', status: 'done' })],
    });
  });

  it.each([
    'P-002 did not make the `## Now` next-pointer DERIVED at read time',
    'P-002 will make the `## Now` next-pointer DERIVED at read time',
    'P-002 made the `## Now` next-pointer stale at read time',
  ])('keeps non-completion resulting-state prose contradictory: %s', (state) => {
    const result = noteVerdict(
      EXACT_REPRO_CURRENT,
      state,
      'Continue with acceptance review.',
      EXACT_REPRO_SLUG,
    );

    expect(result.nowNote).toBeDefined(); // P-006: set-now stores it; lint flags it
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-002', status: 'done' })],
    });
  });

  it('accepts staging completion before the item reaches main/deployed', () => {
    const result = noteVerdict(
      CURRENT,
      'P-001 is done on staging but not in main/deployed.',
      'Continue with P-002.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
    expect(result.nowNote?.state).toBe('P-001 is done on staging but not in main/deployed.');
  });

  it('accepts grouped affirmative completion evidence in an incomplete plan', () => {
    const result = noteVerdict(
      GROUPED_COMPLETION,
      'NOT COMPLETE: The engineering half (P-001/P-002/P-003/P-004/P-005/P-007) is code-truth audited and independently accepted; P-008 remains blocked.',
      'Continue with P-008.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it('accepts a neutral cross-ledger implementation mapping while verification continues', () => {
    const result = noteVerdict(
      CURRENT,
      'The consumer lane is now WI-41755/P-001 under D-081; its affected-radius verification remains in progress.',
      'Continue the affected-radius verification.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it('accepts a neutral decision reference for a terminal item', () => {
    const result = noteVerdict(
      CURRENT,
      "D-022 records P-001's stack-mutation primitive — attach/detach with delivery semantics.",
      'Continue with P-002.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it('rejects a status-invalidating decision reference for a terminal item', () => {
    const result = noteVerdict(
      CURRENT,
      'D-022 records P-001 as pending work.',
      'Continue with P-002.',
      SLUG,
    );

    expect(result.nowNote).toBeDefined(); // P-006: set-now stores it; lint flags it
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-001', status: 'done' })],
    });
  });

  it.each([
    "P-001's measurement residue is owned by WI-1311290, not dropped.",
    "P-001's measurement residue carries forward under WI-1311290.",
  ])('accepts a neutral terminal residue handoff: %s', (state) => {
    const result = noteVerdict(CURRENT, state, 'Continue with P-002.', SLUG);

    expect(result.value).toEqual({ ok: true });
  });

  it('rejects an active terminal residue handoff', () => {
    const result = noteVerdict(
      CURRENT,
      "P-001's measurement residue remains open under WI-1311290.",
      'Continue with P-002.',
      SLUG,
    );

    expect(result.nowNote).toBeDefined(); // P-006: set-now stores it; lint flags it
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_status_contradiction',
      contradictions: [expect.objectContaining({ id: 'P-001', status: 'done' })],
    });
  });

  it('accepts a cross-plan P-NNN citation even when this plan has its own terminal item of the same number', () => {
    // EI-21900747713795768's exact reproduction shape: citing another
    // plan's item id by writing "<other-plan-slug> P-001" into a plan whose
    // OWN P-001 happens to already be done must not be read as a
    // contradiction about this plan's P-001.
    const result = noteVerdict(
      CURRENT,
      'Audited under pui-tui-ship-drive-2026-08-30 P-001.',
      'Continue with P-002.',
      SLUG,
    );

    expect(result.value).toEqual({ ok: true });
  });

  it('rejects a structured Now write that makes an exhaustive list omitting open work', () => {
    const result = noteVerdict(EXHAUSTIVE_OMISSION, 'Work remains.', 'P-002 only, and it is not actionable yet.', SLUG);

    expect(result.nowNote).toBeUndefined(); // the omission guard still refuses the write
    expect(result.value).toEqual({
      ok: false,
      code: 'now_item_omission',
      omissions: [expect.objectContaining({ listed: ['P-002'], omitted: ['P-003'] })],
    });
  });
});
