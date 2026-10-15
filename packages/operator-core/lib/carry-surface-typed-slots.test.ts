/** P-015 (deterministic-context-carry) — owner-blocking questions must be
 *  coord:ask-owner records: the typed-slot lint. */
import { describe, expect, it } from 'vitest';
import {
  lintOwnerQuestionSlots,
  ownerQuestionSlotField,
  OWNER_QUESTION_SLOT_NOTE,
} from './carry-surface-typed-slots';
// Real renderer + real heading: the regression below must exercise what
// loop:checkpoint actually writes, not a hand-typed approximation of it.
import { CARRY_NOTE_WALLS_HEADING, renderWallLine, type WallEntry } from './carry-note';

describe('lintOwnerQuestionSlots', () => {
  it('is clean on empty / null / ordinary progress prose', () => {
    expect(lintOwnerQuestionSlots('')).toEqual({ flagged: false, matches: [] });
    expect(lintOwnerQuestionSlots(null)).toEqual({ flagged: false, matches: [] });
    expect(
      lintOwnerQuestionSlots('Finished the migration; 12/12 tests green; docs update next wake.').flagged,
    ).toBe(false);
    expect(
      lintOwnerQuestionSlots(
        'VERIFY RUN IS GENUINELY IN FLIGHT against repairHead ecf20af2 - confirmed by direct OS measurement, not a status surface. pid 3000039 vitest run --passWithNoTests in papercusp-checkpoint at 7m11s/30',
      ).flagged,
    ).toBe(false);
  });

  it('treats explicit empty owner-wait status values as negative without masking a real wait', () => {
    expect(
      lintOwnerQuestionSlots('Owner-facing open threads: NONE. Waiting on owner: NOTHING.').flagged,
    ).toBe(false);
    expect(lintOwnerQuestionSlots('Waiting on owner: decide whether the release is safe.').flagged).toBe(true);
  });

  it('flags "need to ask the owner" / "question for the owner" prose', () => {
    const r = lintOwnerQuestionSlots('need to ask the owner whether the beta page ships this cut');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('owner-question-prose');
    expect(lintOwnerQuestionSlots('question for the owner: keep the legacy route?').flagged).toBe(true);
  });

  it('does not treat the coord:ask owner-UI-only tool name as an owner question', () => {
    const line =
      'The intentional coord:ask owner-UI-only message is caller-side; generic unauthorized workspace-scope remains structural.';
    expect(lintOwnerQuestionSlots(line)).toEqual({ flagged: false, matches: [] });
    expect(lintOwnerQuestionSlots(`${line} Separately, ask the owner which behavior should ship.`).flagged).toBe(true);
  });

  it('flags blocked-on-owner-answer shapes', () => {
    expect(lintOwnerQuestionSlots('waiting on the owner to pick the pricing model').flagged).toBe(true);
    expect(lintOwnerQuestionSlots("blocked on owner's decision about the schema split").flagged).toBe(true);
    expect(lintOwnerQuestionSlots("needs the owner's approval before the force-push").flagged).toBe(true);
  });

  it('an [ask:<conversation_id>] ref on the line CLEARS it — the question is a typed record', () => {
    expect(
      lintOwnerQuestionSlots('waiting on the owner to pick the pricing model [ask:conv_8f31ab2c]').flagged,
    ).toBe(false);
  });

  it('a wall marker clears the line — the walls slot is also typed', () => {
    expect(
      lintOwnerQuestionSlots('⚠ OWNER-WALL: capital arming needs the owner\'s approval (loop walls row)').flagged,
    ).toBe(false);
  });

  // EI-21762824239199233 — the lint flagged a row supplied through `walls` and
  // stored as a wall, and its remedy text prescribed moving it to `walls`. Cause:
  // the only wall exemption was WALL_MARKER_RE (`OWNER-WALL` / `[wall]`), which
  // renderWallLine does NOT emit, so the exemption never fired for a real wall.
  // The pre-existing marker test above passes a hand-written marker string and so
  // could never catch this; these use the REAL renderer and the REAL heading.
  describe('walls SECTION rows are the typed form (EI-21762824239199233)', () => {
    const wall: WallEntry = {
      claim: "capital arming needs the owner's approval before the first live trade",
      id: 'capital-arming',
      recheck: 'ask the owner whether the arming budget is signed off',
    };

    it('does not flag a rendered wall line inside the walls section', () => {
      const text = [
        '## Did',
        'drained the checkpoint cluster',
        `## ${CARRY_NOTE_WALLS_HEADING}`,
        renderWallLine(wall),
      ].join('\n');
      expect(lintOwnerQuestionSlots(text).flagged).toBe(false);
    });

    it('POSITIVE CONTROL: the identical claim OUTSIDE the walls section is still flagged', () => {
      // Without this, the test above would also pass if the claim simply stopped
      // matching the owner-question patterns — proving nothing about the exemption.
      const text = ['## Left', renderWallLine(wall)].join('\n');
      expect(lintOwnerQuestionSlots(text).flagged).toBe(true);
    });

    it('the section ENDS at the next heading — a later untyped question is still flagged', () => {
      const text = [
        `## ${CARRY_NOTE_WALLS_HEADING}`,
        renderWallLine(wall),
        '## Next',
        'need to ask the owner about the retention window',
      ].join('\n');
      const r = lintOwnerQuestionSlots(text);
      expect(r.flagged).toBe(true);
      expect(r.matches).toHaveLength(1);
      expect(r.matches[0].line).toContain('retention window');
    });

    it('DRIFT PIN: the walls heading the lint skips is the one carry-note renders', () => {
      // The lint keeps a local pattern to stay dependency-free; this pins it to
      // the canonical constant so a rename cannot silently reopen the bug.
      const underCanonical = [`## ${CARRY_NOTE_WALLS_HEADING}`, renderWallLine(wall)].join('\n');
      const underWrongHeading = ['## Wallz', renderWallLine(wall)].join('\n');
      expect(lintOwnerQuestionSlots(underCanonical).flagged).toBe(false);
      expect(lintOwnerQuestionSlots(underWrongHeading).flagged).toBe(true);
    });
  });

  it('is LINE-scoped: an ask ref on one line does not clear a different untyped question', () => {
    const text = [
      'pricing question filed [ask:conv_8f31ab2c]',
      'also need to ask the owner about the retention window',
    ].join('\n');
    const r = lintOwnerQuestionSlots(text);
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].line).toContain('retention window');
  });

  it('does NOT flag plain owner mentions (provenance lint\'s beat, not this one)', () => {
    expect(lintOwnerQuestionSlots('the owner said to ship dark').flagged).toBe(false);
    expect(lintOwnerQuestionSlots('owner-directed AUTO mode stays active').flagged).toBe(false);
  });

  it('caps matches at 5 and truncates long lines to 200 chars', () => {
    const many = Array.from({ length: 8 }, (_, i) => `need to ask the owner about item ${i}`).join('\n');
    expect(lintOwnerQuestionSlots(many).matches).toHaveLength(5);
    const long = 'need to ask the owner about ' + 'x'.repeat(400);
    expect(lintOwnerQuestionSlots(long).matches[0].line.length).toBe(200);
  });
});

describe('EI-19988500685566622: negation and third-party-subject suppression', () => {
  it('does NOT flag a DENIAL of an owner-gated item ("no need to ask the owner")', () => {
    expect(
      lintOwnerQuestionSlots(
        'ONE item, blocked on nothing human or peer: no need to ask the owner here, this closes on its own.',
      ).flagged,
    ).toBe(false);
    expect(lintOwnerQuestionSlots('not blocked on the owner at all, just waiting on CI.').flagged).toBe(false);
    expect(lintOwnerQuestionSlots("there's no question for the owner in this one.").flagged).toBe(false);
  });

  it('does NOT flag a grader/monitor describing a THIRD PARTY\'s owner-wait', () => {
    expect(
      lintOwnerQuestionSlots(
        "Subject su-6e9985dd-1234-4a11-9f01-abc123456789 was waiting on the owner's answer, not ended.",
      ).flagged,
    ).toBe(false);
    expect(
      lintOwnerQuestionSlots('peer claude-8f31ab2c-1111-4a11-9f01-abcdef012345 needs the owner\'s approval next.')
        .flagged,
    ).toBe(false);
  });

  it('does NOT flag a peer/work-item owner confirming an event', () => {
    expect(
      lintOwnerQuestionSlots(
        'await_id 93424 registered; ask WI-40086 peer owner to confirm the exact event emitter.',
      ).flagged,
    ).toBe(false);
    expect(lintOwnerQuestionSlots('work-item owner to confirm the event emitter.').flagged).toBe(false);
  });

  it('does NOT flag a possessive owner that owns a peer artifact, not a human decision', () => {
    expect(
      lintOwnerQuestionSlots("Wait for the owner's true exit-0 build and single restart").flagged,
    ).toBe(false);
    expect(lintOwnerQuestionSlots("waiting on the owner's build artifact").flagged).toBe(false);
  });

  describe('quoted dev:why repair diagnostics (EI-22175896286054778)', () => {
    const diagnostic =
      'dev:why nextVerb — "wait for the owner of the in-flight repair to finish (repair-in-progress) — ' +
      'there is nothing for you to clear, and a re-fire contends with them"';

    it('does NOT flag a fully-marked peer-owned repair nextVerb quote', () => {
      expect(lintOwnerQuestionSlots(diagnostic).flagged).toBe(false);
    });

    it('still flags the same quote without the dev:why nextVerb marker', () => {
      const withoutMarker = diagnostic.replace('dev:why nextVerb — ', '');
      expect(lintOwnerQuestionSlots(withoutMarker).flagged).toBe(true);
    });

    it('still flags a dev:why quote when a peer-owned repair clause is missing', () => {
      const withoutPeerClause = diagnostic.replace(', and a re-fire contends with them', '');
      expect(lintOwnerQuestionSlots(withoutPeerClause).flagged).toBe(true);
    });

    it('still flags an unquoted dev:why diagnostic', () => {
      expect(lintOwnerQuestionSlots(diagnostic.replaceAll('"', '')).flagged).toBe(true);
    });
  });

  it('still flags a possessive owner when a human decision is awaited', () => {
    expect(lintOwnerQuestionSlots("waiting on the owner's approval before the force-push").flagged).toBe(true);
    expect(lintOwnerQuestionSlots("blocked on the owner's decision about the schema split").flagged).toBe(true);
    expect(lintOwnerQuestionSlots("waiting for the owner's final decision about the schema split").flagged).toBe(true);
  });

  it('calibration: the SAME trigger phrase, undenied and about the writer, still flags', () => {
    expect(lintOwnerQuestionSlots('blocked on the owner: no idea when this unblocks.').flagged).toBe(true);
    expect(lintOwnerQuestionSlots('need to ask the owner here, this closes on its own.').flagged).toBe(true);
  });

  it('a negation in an EARLIER, unrelated clause does not mask a real question later in the line', () => {
    const r = lintOwnerQuestionSlots(
      'nothing else to report this wake; separately, need to ask the owner about the cutover date.',
    );
    expect(r.flagged).toBe(true);
  });

  it('a third-party subject in an EARLIER, unrelated clause does not mask the writer\'s own question', () => {
    const r = lintOwnerQuestionSlots(
      'su-6e9985dd-1234-4a11-9f01-abc123456789 finished its item; separately, need to ask the owner about scope.',
    );
    expect(r.flagged).toBe(true);
  });
});

describe('EI-25663783345644648: matcher vocabulary and visible trigger', () => {
  const matcherDescription =
    'Current source `packages/operator-core/lib/carry-surface-typed-slots.ts` OWNER_QUESTION_RES patterns look for ' +
    'ask owner/human, question for owner/human, waits/blocks on owner, owner input/answer/decision/etc., or owner ' +
    'decide/confirm/answer/approve/choose.';

  it('does not treat the detector\'s explicit trigger enumeration as an owner question', () => {
    expect(lintOwnerQuestionSlots(matcherDescription)).toEqual({ flagged: false, matches: [] });
  });

  it('still flags a real ask in a later sentence after the matcher description', () => {
    expect(lintOwnerQuestionSlots(`${matcherDescription} Separately, ask the owner about the retention window.`).flagged)
      .toBe(true);
  });

  it('reports the exact trigger when the display-capped line prefix hides it', () => {
    const retainedNext =
      '[self-imposed] On the next wake, read coord inbox for the leader’s exact host/run receipt. If absent, ' +
      'continue a bounded search for host1690631 activity metadata and loaded_build_identity without repeating the ' +
      'broad log window. Keep dependency headroom work nondestructive, do not run VH retention before the owner answer, ' +
      'and do not scheduler:get_next until both held items are terminal.';
    const result = lintOwnerQuestionSlots(retainedNext);
    expect(result.flagged).toBe(true);
    expect(result.matches[0]).toMatchObject({ kind: 'owner-question-prose', matchedText: 'owner answer' });
    expect(result.matches[0].line).not.toContain('owner answer');
  });
});

describe('ownerQuestionSlotField', () => {
  it('undefined on clean; { flagged, note, matches } when flagged', () => {
    expect(ownerQuestionSlotField('routine note')).toBeUndefined();
    const f = ownerQuestionSlotField('waiting for owner input on the cut date');
    expect(f?.flagged).toBe(true);
    expect(f?.note).toBe(OWNER_QUESTION_SLOT_NOTE);
    expect(f?.matches.length).toBe(1);
  });
});
