import { describe, it, expect } from 'vitest';
import {
  lintCarrySurfaceProvenance,
  provenanceLintField,
  PROVENANCE_LINT_NOTE,
  PROVENANCE_LINT_DOWNGRADED_NOTE,
  TURN_REF_SOURCE_GUIDANCE,
} from './carry-surface-provenance-lint';

describe('lintCarrySurfaceProvenance', () => {
  it('is clean on empty / null / undefined text', () => {
    expect(lintCarrySurfaceProvenance('')).toEqual({ flagged: false, matches: [] });
    expect(lintCarrySurfaceProvenance(null)).toEqual({ flagged: false, matches: [] });
    expect(lintCarrySurfaceProvenance(undefined)).toEqual({ flagged: false, matches: [] });
  });

  it('is clean on ordinary progress-note prose with no attribution phrasing', () => {
    const text = 'Finished the migration, ran the affected suite (12/12 green), left the docs update for next wake.';
    expect(lintCarrySurfaceProvenance(text)).toEqual({ flagged: false, matches: [] });
  });

  it('EI-20340458419044934: does NOT flag observational live-state evidence from a WAKE checkpoint', () => {
    const text =
      'No scorecard emitted. mode:get ... still shows goal + auto + ideate + grade. ' +
      'coord:presence shows the subject live and wakeable ...';
    expect(lintCarrySurfaceProvenance(text)).toEqual({ flagged: false, matches: [] });
  });

  it('flags an untagged "the owner said" imperative', () => {
    const r = lintCarrySurfaceProvenance('the owner said to hold off on deploying until Friday');
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].kind).toBe('owner-attribution');
  });

  it('flags "owner wants" / "owner approved" / "owner requires" variants', () => {
    expect(lintCarrySurfaceProvenance('owner wants this shipped dark for now').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('the owner approved the force-deploy').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('owner requires a second review before merge').flagged).toBe(true);
  });

  describe('EI-22787623747935751: peer-owned role prefixes are not human-owner attribution', () => {
    it.each([
      'Gate owner asked for an exact frozen0d6 shared-chat source/test closure.',
      'the gate owner asked for the exact event emitter.',
      'peer owner asked for a handoff update.',
      'work-item owner requires the claim to stay open.',
      'fleet owner directed the member to retry.',
      'the root owner asked for an exact recovery update.',
      'the storage owner asked for the exact artifact source.',
    ])('does not flag %s', (line) => {
      expect(lintCarrySurfaceProvenance(line)).toEqual({ flagged: false, matches: [] });
    });

    it('keeps an unqualified human-owner attribution loud', () => {
      const r = lintCarrySurfaceProvenance('the owner asked for an exact frozen0d6 shared-chat source/test closure.');
      expect(r.flagged).toBe(true);
      expect(r.matches).toEqual([
        {
          line: 'the owner asked for an exact frozen0d6 shared-chat source/test closure.',
          kind: 'owner-attribution',
        },
      ]);
    });
  });

  it('flags a bare "do not X until Y" gate imperative even without the word owner', () => {
    const r = lintCarrySurfaceProvenance('do NOT resolve WI-3532 until the UI pass is done');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  it('EI-22739052265201730: does not flag an owner-verified loop pause-transition gate', () => {
    expect(
      lintCarrySurfaceProvenance('do not re-arm awaits or pull until an owner-verified resume directive.'),
    ).toEqual({ flagged: false, matches: [] });
    expect(
      lintCarrySurfaceProvenance('Do NOT rearm the warm loop or pull new work until an owner verified resume cue lands.'),
    ).toEqual({ flagged: false, matches: [] });
  });

  it('EI-22739052265201730: keeps non-pause gates and unverified approval conditions loud', () => {
    expect(lintCarrySurfaceProvenance('do not deploy until an owner-verified approval.').matches[0]?.kind).toBe(
      'bare-gate-imperative',
    );
    expect(lintCarrySurfaceProvenance('do not re-arm awaits or pull until the UI pass is done').matches[0]?.kind).toBe(
      'bare-gate-imperative',
    );
  });

  // EI-16031: a "do not X until Y" match must be an IMPERATIVE (no expressed
  // subject) to flag — a DECLARATIVE sentence describing some other subject's
  // behavior is a measurement, not a directive, and must not false-positive.
  it('EI-16031: does NOT flag a descriptive "<subject> do not X until Y" sentence with no attribution', () => {
    const r = lintCarrySurfaceProvenance(
      'tag_weight is in the claim-spec rank vocabulary but compiles to NEUTRAL ' +
        '("they do not reorder until their lanes ship"), referenced by 0 of 133 live specs.',
    );
    expect(r.flagged).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('EI-16031: does NOT flag other third-person-subject "does not ... until" descriptions', () => {
    expect(lintCarrySurfaceProvenance('the scheduler does not reorder until lanes ship').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('it does not retry until the backoff window elapses').flagged).toBe(false);
  });

  it('EI-16031: still flags a genuine bare directive at the start of a sentence', () => {
    const r = lintCarrySurfaceProvenance('do not resolve WI-3532 until the UI pass is done');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  it('EI-16031: still flags a bare directive after a sentence boundary', () => {
    const r = lintCarrySurfaceProvenance('Finished the audit pass. Do not deploy until reviewed.');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  it('EI-21306957457076433: does not flag a writer-backed timeout classification as an owner imperative', () => {
    const text =
      'The green-checkpoint:inconclusive notification was a TIMEOUT, not a verdict; ' +
      'do not treat it as a verdict until release:trace confirms the state.';
    expect(lintCarrySurfaceProvenance(text)).toEqual({ flagged: false, matches: [] });
  });

  it('EI-21306957457076433: keeps an ordinary timeout-adjacent gate loud', () => {
    const r = lintCarrySurfaceProvenance('The last run timed out; do not deploy until release:trace confirms the state.');
    expect(r.flagged).toBe(true);
    expect(r.matches[0]?.kind).toBe('bare-gate-imperative');
  });

  it('EI-27076574392480618: ignores gate-pattern notation without an action word and keeps a real gate', () => {
    expect(lintCarrySurfaceProvenance('The check describes the pattern “do not … until” as a trigger.'))
      .toEqual({ flagged: false, matches: [] });
    expect(lintCarrySurfaceProvenance('Do not publish until release:trace reports green.')
      .matches[0]?.kind).toBe('bare-gate-imperative');
  });

  it('EI-20246140574201628: does NOT flag an inline-code quoted factual pending-verdict gate', () => {
    const r = lintCarrySurfaceProvenance(
      'The evidence records the safety phrase `do not act on the 18-red names until a real verdict is rendered` as a factual pending-verdict constraint.',
    );
    expect(r).toEqual({ flagged: false, matches: [] });
  });

  it('EI-20246140574201628: still flags a real gate alongside unrelated inline code', () => {
    const r = lintCarrySurfaceProvenance('Do not deploy until `release:checkpoint-run` returns green.');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  it('EI-20246140574201628: does not let a later quoted gate hide an earlier real gate', () => {
    const r = lintCarrySurfaceProvenance(
      'Do not deploy until reviewed; the note quotes `do not act on the 18-red names until a real verdict is rendered`.',
    );
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  it('does NOT flag when the line carries a NON-OWNER source tag', () => {
    expect(lintCarrySurfaceProvenance('[self-imposed] do not resolve WI-3532 until the UI pass is done').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[peer:su-4dc3b] the owner approved this').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[inferred] owner wants this merged').flagged).toBe(false);
  });

  it('accepts a typed system-derived fleet-control cue without masking an untagged line', () => {
    const r = lintCarrySurfaceProvenance(
      '[system-derived:fleet-control] Fleet backend is winding down. ' +
        'Do NOT pull new work from this fleet\'s lanes until a fleet:resume cue lands.',
    );
    expect(r).toEqual({ flagged: false, matches: [] });
  });

  it('does NOT treat an unrelated system-derived marker as a source tag', () => {
    const r = lintCarrySurfaceProvenance(
      '[system-derived:other] Do NOT pull new work from this fleet\'s lanes until a fleet:resume cue lands.',
    );
    expect(r.flagged).toBe(true);
    expect(r.matches[0]?.kind).toBe('bare-gate-imperative');
  });

  // P-014 (deterministic-context-carry): manual [owner:…] tags are retired as
  // evidence — a turn ref is the verifiable anchor.
  it('P-014: a manual [owner:…] tag with NO turn ref is flagged manual-owner-tag', () => {
    const r = lintCarrySurfaceProvenance('[owner:jane 2026-07-10] the owner said to hold off until Friday');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('manual-owner-tag');
  });

  // EI-18672153930631150: the lint could not tell a MENTION of the `[owner:…]`
  // convention (documenting/comparing its syntax) from a real USE of it.
  describe('EI-18672153930631150: mention vs use of the [owner:…] tag convention', () => {
    it('downgrades a placeholder-name tag to possible-owner-tag-mention (the filed repro)', () => {
      const r = lintCarrySurfaceProvenance(
        'the detector matches the bracket form [owner:Name] and the parenthetical form',
      );
      expect(r.flagged).toBe(true);
      expect(r.matches).toHaveLength(1);
      expect(r.matches[0].kind).toBe('possible-owner-tag-mention');
    });

    it('never flags a backtick-quoted tag at all (definite quoting, not a use)', () => {
      const r = lintCarrySurfaceProvenance(
        '   `[owner:Name]` + parenthetical `OWNER MANDATE (Name, date)`), imported by BOTH consumers',
      );
      expect(r.flagged).toBe(false);
      expect(r.matches).toEqual([]);
    });

    it('downgrades other placeholder stand-ins: <name>, foo, ...', () => {
      expect(
        lintCarrySurfaceProvenance('the tag looks like [owner:<name>]').matches[0]?.kind,
      ).toBe('possible-owner-tag-mention');
      expect(
        lintCarrySurfaceProvenance('a fixture asserting [owner:foo] gets scrubbed').matches[0]?.kind,
      ).toBe('possible-owner-tag-mention');
      expect(
        lintCarrySurfaceProvenance('write it as [owner:...] with a real name and date').matches[0]?.kind,
      ).toBe('possible-owner-tag-mention');
    });

    it('downgrades on nearby mention-context words even with a name-shaped placeholder', () => {
      const r = lintCarrySurfaceProvenance('e.g. [owner:Name] is the bracket convention');
      expect(r.matches[0]?.kind).toBe('possible-owner-tag-mention');
    });

    it('still flags manual-owner-tag for a REAL name with no quoting/placeholder/context', () => {
      const r = lintCarrySurfaceProvenance('[owner:jane 2026-07-10] the owner said to hold off until Friday');
      // two matches expected: the tag itself, plus the "the owner said" phrase on the same line
      // is suppressed by SOURCE_TAG_RE continuing past it — assert on the tag-kind specifically.
      expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(true);
      expect(r.matches.some((m) => m.kind === 'possible-owner-tag-mention')).toBe(false);
    });

    // EI-18762822878138952: the repo's OWN documented tag shape — root CLAUDE.md's
    // "Directive provenance" convention spells the example as `[owner:<name> <date>]`,
    // chaining TWO placeholder tokens. Before the fix, only a single placeholder token
    // was recognized, so this exact canonical example (which any agent implementing or
    // documenting the convention naturally reproduces) fell through to the loud
    // `manual-owner-tag` category instead of being downgraded as a mention.
    it('EI-18762822878138952: downgrades a chained multi-token placeholder like [owner:<name> <date>]', () => {
      const r = lintCarrySurfaceProvenance(
        'tag every directive with its source: [owner:<name> <date>] · [self-imposed] · [peer:<sid>] · [inferred]',
      );
      expect(r.flagged).toBe(true);
      expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(false);
      expect(r.matches.some((m) => m.kind === 'possible-owner-tag-mention')).toBe(true);
    });

    it('EI-18762822878138952: a real name chained with a placeholder token still flags manual-owner-tag', () => {
      const r = lintCarrySurfaceProvenance('[owner:jane <date>] hold off until Friday');
      expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(true);
      expect(r.matches.some((m) => m.kind === 'possible-owner-tag-mention')).toBe(false);
    });

    // EI-18762822878138952 (filed repro): a bare `|`-separated ENUMERATION of the P-010
    // evidence-band vocabulary (observed / tool-output / reported-by / inferred / assumed)
    // — no brackets, no owner attribution, no completed-action claim. None of the tag/
    // attribution/action regexes require brackets or an assertive verb be absent, so this
    // was never actually reachable through the bracket-gated OWNER_TAG_RE path; locking it
    // in here as a named regression so a future tightening of any of the line-scoped
    // detectors can't reintroduce a false positive on vocabulary-listing prose like this.
    it('EI-18762822878138952: does NOT flag a bare enumeration of the evidence-band vocabulary', () => {
      const line =
        'Shipped the evidence band INSIDE relay-provenance.ts (the item forbids a third provenance surface): ' +
        'observed | tool-output | reported-by | inferred | assumed. Confidence is DERIVED via a total mapping';
      expect(lintCarrySurfaceProvenance(line)).toEqual({ flagged: false, matches: [] });
      expect(
        lintCarrySurfaceProvenance('observed | tool-output | reported-by | inferred | assumed'),
      ).toEqual({ flagged: false, matches: [] });
    });
  });

  // EI-19393929983792049: a bare NOUN-PHRASE ("owner directive N: …") asserts the same
  // authority as a `[owner:…]` tag or an OWNER_ATTRIBUTION_RE verb phrase, but matched
  // neither before this fix — the exact shape a self-compaction turn wrote live.
  describe('EI-19393929983792049: bare "owner directive" / "owner mandate" noun-phrase attribution', () => {
    it('flags the filed repro verbatim: "start owner directive 1: …"', () => {
      const r = lintCarrySurfaceProvenance(
        'start owner directive 1: the READ-ONLY P-011 audit runs first',
      );
      expect(r.flagged).toBe(true);
      expect(r.matches[0].kind).toBe('manual-owner-tag');
    });

    it('flags the loop-goal re-emission shape: "Owner directive 2 (only outstanding unit): …"', () => {
      const r = lintCarrySurfaceProvenance(
        'Owner directive 2 (only outstanding unit): writing the plan is NOT approval to build it',
      );
      expect(r.flagged).toBe(true);
      expect(r.matches[0].kind).toBe('manual-owner-tag');
    });

    it('flags the repo\'s own dated citation convention the same way (P-014: asserts, does not prove)', () => {
      const r = lintCarrySurfaceProvenance(
        'Owner directive 2026-07-06: do not spend V1 effort on P2P/cross-machine federation',
      );
      expect(r.flagged).toBe(true);
      expect(r.matches[0].kind).toBe('manual-owner-tag');
    });

    it('flags "owner mandate" the same way', () => {
      expect(
        lintCarrySurfaceProvenance('per the owner mandate: ship this dark for now').matches[0]?.kind,
      ).toBe('manual-owner-tag');
    });

    it('does not flag an execution command that references a recorded owner order', () => {
      expect(lintCarrySurfaceProvenance('Execute owner directive order 10')).toEqual({
        flagged: false,
        matches: [],
      });
    });

    it('keeps the exemption structural while accepting common order-reference spellings', () => {
      expect(lintCarrySurfaceProvenance('Follow the owner mandate #10')).toEqual({
        flagged: false,
        matches: [],
      });
      expect(lintCarrySurfaceProvenance('Apply owner directive 10')).toEqual({
        flagged: false,
        matches: [],
      });
      expect(lintCarrySurfaceProvenance('owner directive order 10: hold the deploy').matches[0]?.kind).toBe(
        'manual-owner-tag',
      );
    });

    it('treats neutral actions on directive records as references, while preserving attributed directives', () => {
      expect(
        lintCarrySurfaceProvenance('Reconcile owner directives and omitted session history.'),
      ).toEqual({ flagged: false, matches: [] });
      expect(lintCarrySurfaceProvenance('Review the existing owner directive records.')).toEqual({
        flagged: false,
        matches: [],
      });
      expect(
        lintCarrySurfaceProvenance('Owner directive #17: reconcile owner directives and session history.')
          .matches[0]?.kind,
      ).toBe('manual-owner-tag');
    });

    it('EI-20234090473445932: does not flag a factual status report for a recorded directive', () => {
      expect(
        lintCarrySurfaceProvenance(
          'Owner directive #9 remains open and was acknowledged, not falsely marked complete.',
        ),
      ).toEqual({ flagged: false, matches: [] });
    });

    it('EI-20234090473445932: does not flag neutral deferred-tool evidence about a directive', () => {
      expect(
        lintCarrySurfaceProvenance(
          'The open owner directive was checked via orders:list; tools:invoke returned count=1 and row id=9.',
        ),
      ).toEqual({ flagged: false, matches: [] });
    });

    it('a [turn:…] ref on the same line clears it, exactly like the bracket tag', () => {
      const r = lintCarrySurfaceProvenance(
        'owner directive 1: hold the deploy [turn:bf1881bc@2026-07-14T17:42:41.307Z]',
      );
      expect(r.flagged).toBe(false);
    });

    it('a [self-imposed]/[peer:]/[inferred] tag on the same line clears it too', () => {
      expect(
        lintCarrySurfaceProvenance('[self-imposed] treat this as owner directive 1 for now').flagged,
      ).toBe(false);
      expect(
        lintCarrySurfaceProvenance('[inferred] owner directive 2 no longer applies').flagged,
      ).toBe(false);
    });

    it('downgrades meta-discussion of the convention to a mention, not the loud category', () => {
      expect(
        lintCarrySurfaceProvenance('Directive provenance — never manufacture an owner directive').matches[0]
          ?.kind,
      ).toBe('possible-owner-tag-mention');
      expect(
        lintCarrySurfaceProvenance(
          'this is the telephone game that manufactures owner directives out of notes-to-self',
        ).matches[0]?.kind,
      ).toBe('possible-owner-tag-mention');
    });

    it('does not treat a safety requirement list for preserving directive records as owner attribution', () => {
      expect(
        lintCarrySurfaceProvenance(
          'Preserve directed asks, owner directives, required wakes, and Stop authority.',
        ),
      ).toEqual({ flagged: false, matches: [] });

      expect(
        lintCarrySurfaceProvenance(
          'Owner directive 2026-07-06: Preserve directed asks, owner directives, required wakes, and Stop authority.',
        ).matches[0]?.kind,
      ).toBe('manual-owner-tag');
    });

    it('downgrades to possible-owner-tag-mention on nearby mention-context words', () => {
      const r = lintCarrySurfaceProvenance('a claimed owner directive with no turn ref is suspect');
      expect(r.matches[0]?.kind).toBe('possible-owner-tag-mention');
    });

    it('EI-22454606387399213: does not flag a copular disclaimer that denies owner authority', () => {
      expect(
        lintCarrySurfaceProvenance(
          'Constraints below are NOT owner directives - sourced and tagged so a successor does not inherit them as one:',
        ),
      ).toEqual({ flagged: false, matches: [] });
      expect(
        lintCarrySurfaceProvenance('These constraints were never owner mandates; each is [self-imposed].'),
      ).toEqual({ flagged: false, matches: [] });
    });

    it('EI-22454606387399213: keeps asserted directive references and mixed gate imperatives loud', () => {
      expect(
        lintCarrySurfaceProvenance('Do not ignore owner directive #9.').matches[0]?.kind,
      ).toBe('manual-owner-tag');
      expect(
        lintCarrySurfaceProvenance('Owner directive #9 says not to deploy.').matches[0]?.kind,
      ).toBe('manual-owner-tag');
      expect(
        lintCarrySurfaceProvenance('This is not an owner directive; do NOT deploy until reviewed.').matches[0]?.kind,
      ).toBe('bare-gate-imperative');
    });

    it('EI-25438670819476017: accepts a negative-existence owner-directive disclaimer', () => {
      expect(
        lintCarrySurfaceProvenance('No applicable owner directive was provided for this task.'),
      ).toEqual({ flagged: false, matches: [] });
    });

    it('EI-27706343693041409: accepts the recovery checkpoint identity/control evidence', () => {
      const line =
        '[turn:self] SAME identity verified via coord:whoami; control hashbdefcb44.../AUTO/original fleet leadership and WARM route retained. One orient recovered deliberately omitted obligations, no new owner directive applies.';
      expect(lintCarrySurfaceProvenance(line)).toEqual({ flagged: false, matches: [] });
      expect(lintCarrySurfaceProvenance('No new owner directive applies.')).toEqual({
        flagged: false,
        matches: [],
      });
    });

    it('EI-27706343693041409: keeps new directives and mixed authority claims loud', () => {
      expect(lintCarrySurfaceProvenance('New owner directive #9: hold the deploy.').matches[0]?.kind).toBe(
        'manual-owner-tag',
      );
      expect(
        lintCarrySurfaceProvenance('No new owner directive applies; do NOT deploy until reviewed.')
          .matches[0]?.kind,
      ).toBe('bare-gate-imperative');
      expect(
        lintCarrySurfaceProvenance('No new owner directive applies; the owner said to hold the deploy.')
          .matches[0]?.kind,
      ).toBe('owner-attribution');
      expect(
        lintCarrySurfaceProvenance('No new owner directive applies; [owner:Jane] hold the deploy.')
          .matches[0]?.kind,
      ).toBe('manual-owner-tag');
    });

    it('EI-25438670819476017: keeps an imperative loud beside a negative-existence disclaimer', () => {
      expect(
        lintCarrySurfaceProvenance('No applicable owner directive was found; do NOT deploy until reviewed.')
          .matches[0]?.kind,
      ).toBe('bare-gate-imperative');
      expect(lintCarrySurfaceProvenance('Do not ignore owner directive #9.').matches[0]?.kind).toBe(
        'manual-owner-tag',
      );
    });

    it('never flags a backtick-quoted mention of the phrase', () => {
      expect(
        lintCarrySurfaceProvenance('the doc uses the phrase `owner directive` loosely').flagged,
      ).toBe(false);
    });

    it('EI-23902378389781007: does not treat technical labels or Markdown headings as owner attributions', () => {
      expect(
        lintCarrySurfaceProvenance(
          '- It OVERSTATED the scope. Those are `CarryBrief.directives` = OWNER directives and are correctly NOT renamed.',
        ),
      ).toEqual({ flagged: false, matches: [] });
      expect(
        lintCarrySurfaceProvenance(
          "...NOT text drift: the anchor '## Owner directives — durable capture and resolution' is byte-IDENTICAL in live su.md:800 and su-decomposition.ts:300...",
        ),
      ).toEqual({ flagged: false, matches: [] });
      expect(
        lintCarrySurfaceProvenance('## Owner directives — durable capture and resolution'),
      ).toEqual({ flagged: false, matches: [] });

      // Mention handling must not silence a real unanchored owner directive.
      expect(
        lintCarrySurfaceProvenance(
          'Owner directive 2026-07-06: do not spend V1 effort on P2P/cross-machine federation',
        ).matches[0]?.kind,
      ).toBe('manual-owner-tag');
    });

    it('EI-23902378389781007: recognizes classifier prose without silencing real owner claims', () => {
      const sourceLine =
        "PROVENANCE RAIL (the part most worth not regressing): a hook-captured row (capturedByHook) becomes authority { kind:'owner', turnOrigin:'owner-typed' } because the UserPromptSubmit provenance hook is the only mechanism here that CLASSIFIES a turn as OWNER. An orders:record row becomes { kind:'owner-candidate', turnOrigin:'unknown' } — an agent asserting the owner said it. Representing the second as owner is exactly how a note-to-self becomes an owner directive.";
      expect(lintCarrySurfaceProvenance(sourceLine)).toEqual({ flagged: false, matches: [] });
      expect(
        lintCarrySurfaceProvenance('The real dated owner directive control remains flagged.'),
      ).toEqual({ flagged: false, matches: [] });

      expect(
        lintCarrySurfaceProvenance('The owner said to defer the deployment until Friday.').matches[0]
          ?.kind,
      ).toBe('owner-attribution');
      expect(
        lintCarrySurfaceProvenance(
          'Owner directive 2026-07-06: do not spend V1 effort on P2P/cross-machine federation',
        ).matches[0]?.kind,
      ).toBe('manual-owner-tag');
    });

    it('an "owner directed" VERB phrase still routes through the existing owner-attribution match, not this one', () => {
      const r = lintCarrySurfaceProvenance('the owner directed us to hold off, per the standup');
      expect(r.flagged).toBe(true);
      expect(r.matches[0].kind).toBe('owner-attribution');
    });

    it('does NOT flag unrelated prose mentioning "owner" and "director" separately', () => {
      expect(
        lintCarrySurfaceProvenance('the project director met with the owner to review the roadmap').flagged,
      ).toBe(false);
    });
  });

  it('P-014: a [turn:<session>@<ts>] ref clears the line — with or without an owner tag', () => {
    expect(
      lintCarrySurfaceProvenance(
        '[owner:jane 2026-07-10] [turn:bf1881bc@2026-07-14T17:42:41.307Z] hold off until Friday',
      ).flagged,
    ).toBe(false);
    expect(
      lintCarrySurfaceProvenance('the owner said to ship dark [turn:bf1881bc@2026-07-14T17:42:41.307Z]').flagged,
    ).toBe(false);
  });

  it('is LINE-scoped: a tag on one line does not mask an untagged imperative on another', () => {
    const text = ['[self-imposed] finished the audit pass.', 'the owner said to skip the retro this week.'].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].line).toContain('the owner said to skip the retro this week.');
  });

  it('caps at MAX_MATCH_LINES (5) even when many lines match', () => {
    const text = Array.from({ length: 10 }, (_, i) => `the owner said item ${i} is done`).join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.matches.length).toBe(5);
  });

  it('truncates an overlong matched line to 200 chars', () => {
    const long = 'the owner said ' + 'x'.repeat(500);
    const r = lintCarrySurfaceProvenance(long);
    expect(r.matches[0].line.length).toBe(200);
  });

  // EI-10994: complying with the bare-gate nudge (writing an explicit, source-tagged
  // PROVENANCE block that restates the imperative it attributes) must CLEAR the flag —
  // before the fix it re-fired on the original line AND on the block's own restatement line.
  it('EI-10994: an explicit source-tagged PROVENANCE block clears the bare-gate-imperative it attributes', () => {
    const text = [
      'do not widen the isCapacityError match until the SDK ships the typed error',
      '',
      "PROVENANCE: the 'do not widen isCapacityError until the SDK ships' constraint above",
      '  is [self-imposed] by su-eb9b7ae3 on 2026-07-13. It is NOT an owner directive.',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('EI-10994: a PROVENANCE block with NO source tag does not suppress — still nudges to tag it', () => {
    const text = [
      'do not resolve WI-3532 until the UI pass is done',
      'PROVENANCE: this constraint above — I forgot to actually tag it.',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches.some((m) => m.kind === 'bare-gate-imperative')).toBe(true);
  });

  it('EI-10994: a tagged PROVENANCE block does not launder an affirmative "the owner said" claim on another line', () => {
    const text = [
      "PROVENANCE: the 'do not merge until review' gate is [self-imposed] by su-abc on 2026-07-13.",
      'the owner said to ship this dark',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].kind).toBe('owner-attribution');
    expect(r.matches[0].line).toContain('the owner said to ship this dark');
  });

  // EI-18226077402946717: a checkpoint that NARRATES a coordination side-effect as
  // already DONE ("posted evidence to WI-####", "messaged fleet leader su-…") with no
  // verifiable anchor is the shape that silently drops a handoff when it never happened.
  it('EI-18226077402946717: flags the exact bug shape — a narrated post + peer message with a coordination target', () => {
    const r = lintCarrySurfaceProvenance(
      'Posted full evidence to WI-5672 (posts 53500-53501) and updated the plan. Messaged fleet leader su-bce40c51 directly.',
    );
    expect(r.flagged).toBe(true);
    const kinds = r.matches.map((m) => m.kind);
    expect(kinds).toContain('unverified-action-claim');
  });

  it('EI-18226077402946717: flags "commented on WI-…" / "notified the fleet" / "escalated to su-…" narrated actions', () => {
    expect(lintCarrySurfaceProvenance('commented on WI-5137 that the gate is green').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('notified the fleet that the reds are cleared').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('escalated to su-a7d08fd3 for the credential').flagged).toBe(true);
  });

  it('EI-18226077402946717: a [turn:…] ref on the action line CLEARS it — the one valid completion anchor', () => {
    const r = lintCarrySurfaceProvenance(
      'Posted evidence to WI-5672 (post 53502) [turn:6ffd5ea8@2026-07-21T04:14:03.101Z]',
    );
    expect(r.flagged).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('EI-18226077402946717: does NOT flag ordinary in-file progress prose (past verbs, no coordination target)', () => {
    // These carry past-tense verbs but describe the agent's OWN in-tree work, not a
    // cross-agent/cross-item side-effect — must stay clean (high-precision discipline).
    expect(lintCarrySurfaceProvenance('committed the fix and posted the results to the log').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('sent the request to the embedding sidecar; notified the user via toast').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('replied to the review comment and refactored the helper').flagged).toBe(false);
  });

  it('EI-18226077402946717: does NOT flag a PLAN (base-form verb) to do the action next', () => {
    // A checkpoint's "Next:" line uses the base form — a plan, not a completed claim.
    expect(lintCarrySurfaceProvenance('Next: post evidence to WI-5672 and message the fleet leader').flagged).toBe(false);
  });

  it('EI-21165322848724914: does NOT flag a conditional future plan that mentions a past-tense handoff', () => {
    // Verbatim from the reported canonical next field. "handed off" is inside the
    // future wake's "Verify whether ..." clause, so it is not a completed action claim.
    const next =
      'At the next hourly fire begin strictly after 2026-08-22T14:44:14.113Z. Re-orient; read goals:get, ' +
      'RELEASE-READINESS, EI-21165017285995198 provisional/audit state, and trend exclusion. Verify whether ' +
      'the subject re-armed its loop around the GOAL outcome, restored a launched-leader standing DRAIN fleet, ' +
      'handed off its plan-fleet leadership, and woke/redirected WI-40537. Prove new subject/child execution ' +
      'from sessions:list + tool_invocations; rerun the exact session_turn_parts native-edit classifier with repo ' +
      'positive control, bounded Bash write legs, three-source owner-report union, launch/settings sequence, ' +
      'activity reference control, modes/goal-stamped items, five fleets, federation verdict bank, and WI-40086/pipeline owner.';
    expect(lintCarrySurfaceProvenance(next)).toEqual({ flagged: false, matches: [] });
  });

  it('EI-26098960267148036: does not flag a next-cold-wake verification plan without whether/if', () => {
    const next =
      'On the next cold wake, verify both work-item claims: the subject handed off its plan-fleet leadership to WI-40537.';
    expect(lintCarrySurfaceProvenance(next)).toEqual({ flagged: false, matches: [] });
    expect(lintCarrySurfaceProvenance('I handed off its plan-fleet leadership to WI-40537.').matches[0]?.kind).toBe(
      'unverified-action-claim',
    );
  });

  it('EI-18226077402946717: an action-claim is NOT laundered by a [self-imposed] directive tag on the same line', () => {
    // A source tag attributes the DIRECTIVE that ordered the action; it does not prove
    // the action happened — so the action-claim still flags (only a [turn:…] ref clears it).
    const r = lintCarrySurfaceProvenance('[self-imposed] posted evidence to WI-5672 for the handoff');
    expect(r.flagged).toBe(true);
    expect(r.matches.some((m) => m.kind === 'unverified-action-claim')).toBe(true);
  });
});

// EI-19461711239876849: a line that WITHDRAWS an owner attribution is the compliance
// the convention asks for, not a violation of it. Every string below is a VERBATIM line
// from this workspace's stored carry-surface corpus (harness_shared.carry_notes /
// agent_facts), lightly truncated — the positives are real retractions the lint used to
// penalise, and the negatives are the real asserted attributions that the filed
// suggestion (suppress on a downgrade tag alone) would have silently laundered.
describe('lintCarrySurfaceProvenance — owner-attribution WITHDRAWALS (EI-19461711239876849)', () => {
  const withdrawals: [string, string][] = [
    [
      'the filed repro: refuses an owner tag and downgrades it to [peer:…]',
      '⚠ PROVENANCE: the 2026-07-11 note "owner-authorization stands" is a THIRD-PARTY claim in a checkpoint, not a quoted owner turn. I could not verify it against an owner turn. Treat it as [peer:su-28637], NOT as [owner:Someone].',
    ],
    [
      'a PROVENANCE CORRECTION block retracting a bare assertion',
      'PROVENANCE CORRECTION: the "Owner approved implementing P-008" line is NOT anchored to an OWNER-stamped turn — it is [self-imposed]. Do not carry it forward as [owner:jane 2026-08-01].',
    ],
    [
      'a trailing [self-imposed …, not an owner directive] tag (the dominant real-world form)',
      'DO NOT relax the gate just because the chain is persuasive — that is the exact move this item was filed against. [self-imposed gate — not an owner directive]',
    ],
    [
      'the noun-phrase form, with no [owner:…] bracket at all',
      'Restarting kills the live panes, so it is the human call [self-imposed reasoning, not an owner directive].',
    ],
  ];
  for (const [label, line] of withdrawals) {
    it(`does not flag a withdrawal — ${label}`, () => {
      const kinds = lintCarrySurfaceProvenance(line).matches.map((m) => m.kind);
      expect(kinds).not.toContain('manual-owner-tag');
      expect(kinds).not.toContain('possible-owner-tag-mention');
    });
  }

  // The guard on the guard: these carry a downgrade tag AND assert real owner authority.
  // Suppressing them is the laundering failure the conjunctive rule exists to avoid, so
  // a future "simplification" to a downgrade-tag-only check must fail HERE.
  const realAttributions: [string, string][] = [
    [
      'a relayed-verbatim owner ask — cites a [peer:…] relayer but asserts owner authority',
      'SECOND LIVE OWNER ASK (relayed VERBATIM by [peer:su-bf97d] who received it interactively; treat as owner-sourced, relay noted): [owner:jane 2026-07-12] "test the shortcuts on all platforms."',
    ],
    [
      'a dated pause directive asserted as owner-sourced',
      '[owner:jane 2026-07-11, relayed via su-63834, verified verbatim in coord inbox] Pause directive: parking per token-conservation directive. [inferred] scope.',
    ],
    [
      'an owner DEMAND asserted inside an otherwise [self-imposed]-tagged status line',
      '[self-imposed 2026-07-12, AUTO] MASTER/DETAIL REWORK IMPLEMENTED — visual verify PENDING (owner [owner:jane 2026-07-12] demands real GUI verify before close).',
    ],
  ];
  for (const [label, line] of realAttributions) {
    it(`still flags a real asserted attribution — ${label}`, () => {
      const kinds = lintCarrySurfaceProvenance(line).matches.map((m) => m.kind);
      expect(kinds).toContain('manual-owner-tag');
    });
  }

  it('does not suppress a bare-gate imperative merely because a withdrawal sits elsewhere', () => {
    const text = [
      'The "do NOT ship until the audit lands" rule below is mine.',
      'Separately: that gate is [self-imposed], NOT an owner directive.',
    ].join('\n');
    const kinds = lintCarrySurfaceProvenance(text).matches.map((m) => m.kind);
    expect(kinds).toContain('bare-gate-imperative');
  });
});

describe('provenanceLintField', () => {
  it('returns undefined on a clean write (no noise on the common case)', () => {
    expect(provenanceLintField('routine progress note, nothing attributed')).toBeUndefined();
    expect(provenanceLintField(null)).toBeUndefined();
  });

  it('returns { flagged:true, note, matches } on a flagged write', () => {
    const field = provenanceLintField('the owner said to hold off until reviewed');
    expect(field).toBeDefined();
    expect(field?.flagged).toBe(true);
    expect(field?.note).toBe(PROVENANCE_LINT_NOTE);
    expect(field?.matches.length).toBeGreaterThan(0);
  });

  it('names the copy source and rejects constructing refs from wake-pump nonces', () => {
    expect(PROVENANCE_LINT_NOTE).toContain('turnProvenance.writtenDuring.ref');
    expect(PROVENANCE_LINT_NOTE).toContain('copy the exact');
    expect(PROVENANCE_LINT_NOTE).toContain('wake-pump nonce');
    expect(PROVENANCE_LINT_NOTE).toContain(TURN_REF_SOURCE_GUIDANCE);
  });
});

/**
 * P-014 (fleet-lead-instrumentation-audit-2026-08-09) — the action lint had no notion of
 * WHO ACTED, so recording a peer's report as a peer's report tripped the same accusation
 * as fabricating one's own side-effect. Punishing the compliant case is how a
 * high-precision leg gets tuned out.
 */
describe('unverified-action-claim: the ACTOR decides the kind (P-014)', () => {
  const kinds = (t: string) => lintCarrySurfaceProvenance(t).matches.map((m) => m.kind);

  it('DOWNGRADES an action whose subject is a peer session id', () => {
    expect(kinds('su-6dc49b99 replied that my reported defect is fixed, see WI-37162')).toEqual([
      'peer-reported-action',
    ]);
  });

  it('downgrades the other third-party subjects agents actually write', () => {
    for (const line of [
      'a peer messaged the fleet leader about WI-123',
      'they posted evidence to WI-5672 overnight',
      'the leader notified the fleet about WI-9',
      'another agent has already commented on WI-42',
      'the queen just escalated WI-7 to the owner',
    ]) {
      expect(kinds(line), line).toEqual(['peer-reported-action']);
    }
  });

  it('CONTROL — still ACCUSES the author\'s own narrated side-effect (the WI-5137 shape)', () => {
    // The motivating fabrication: line OPENS with the verb, so the subject is implicitly
    // first-person. If this ever downgrades, the lint has stopped doing its job.
    expect(kinds('Messaged fleet leader su-bce40c51 directly')).toEqual(['unverified-action-claim']);
    expect(kinds('Posted full evidence to WI-5672 (posts 53500-53501)')).toEqual(['unverified-action-claim']);
    expect(kinds('I commented on WI-37162 with the census')).toEqual(['unverified-action-claim']);
  });

  it('CONTROL — a peer mentioned as the TARGET, not the actor, is still the author\'s claim', () => {
    // "su-…" appears in the line either way; only its POSITION relative to the verb
    // separates "I told them" from "they told me".
    expect(kinds('I pinged su-6dc49b99 about the regression in WI-37162')).toEqual(['unverified-action-claim']);
  });

  it('still clears entirely when the line carries a [turn:…] ref, whoever acted', () => {
    expect(kinds('su-6dc49b99 replied about WI-37162 [turn:abc123@2026-08-09T10:00:00.000Z]')).toEqual([]);
  });

  it('clears a namespaced Codex turn ref on the action line', () => {
    expect(
      kinds(
        'Posted evidence to EI-21165235642497045 [turn:codex:01a029f0-dec6-7022-871d-92e4ca8f28ed@2026-08-22T14:51:07.729Z]',
      ),
    ).toEqual([]);
  });

  it('flags only the retained unanchored history, not the newly anchored action', () => {
    const retained = 'Posted evidence to EI-21165235642497045';
    const current =
      'Posted evidence to EI-21165235642497045 [turn:codex:01a029f0-dec6-7022-871d-92e4ca8f28ed@2026-08-22T14:51:07.729Z]';
    const r = lintCarrySurfaceProvenance(`${retained}\n\n---\n${current}`);
    expect(r.matches).toEqual([{ line: retained, kind: 'unverified-action-claim' }]);
  });

  it('softens the NOTE when every match is downgraded, but not when one is loud', () => {
    const soft = provenanceLintField('su-6dc49b99 replied that my defect is fixed, see WI-37162');
    expect(soft?.note).toBe(PROVENANCE_LINT_DOWNGRADED_NOTE);
    expect(soft?.note).toContain('nothing to fix');

    // One real violation must never ride in under the FYI note.
    const mixed = provenanceLintField(
      'su-6dc49b99 replied about WI-37162\nPosted full evidence to WI-5672 (posts 53500-53501)',
    );
    expect(mixed?.matches.map((m) => m.kind)).toEqual(['peer-reported-action', 'unverified-action-claim']);
    expect(mixed?.note).toBe(PROVENANCE_LINT_NOTE);
  });
});

describe('EI-19988211953593959: near-miss owner-tag separator shapes (space/equals/dash, not just colon)', () => {
  // CONTROL — pins the regression this ticket fixed. The OLD colon-only anchor
  // (`/\[owner:[^\]]+\]/i`) does not match any of these three, which is exactly the
  // "invisible, not merely mis-categorised" failure the ticket described: had the fix
  // regressed back to colon-only, every assertion below would fail because `flagged`
  // would be false instead of true.
  const OLD_COLON_ONLY_RE = /\[owner:[^\]]+\]/i;

  it.each([
    ['space', '[owner jane 2026-08-09] hold off on the release until Friday'],
    ['equals', '[owner=jane] hold off on the release until Friday'],
    ['dash', '[owner - jane] hold off on the release until Friday'],
  ])('a real %s-separated owner tag is SEEN (flags manual-owner-tag), not invisible', (_shape, line) => {
    expect(OLD_COLON_ONLY_RE.test(line)).toBe(false); // control: proves the old anchor missed it
    const r = lintCarrySurfaceProvenance(line);
    expect(r.flagged).toBe(true);
    expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(true);
  });

  it('a space-separated PLACEHOLDER tag still downgrades to possible-owner-tag-mention', () => {
    const r = lintCarrySurfaceProvenance('the convention form is [owner Name] <date>, tag every directive');
    expect(r.flagged).toBe(true);
    expect(r.matches[0]?.kind).toBe('possible-owner-tag-mention');
    expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(false);
  });

  it('a backtick-quoted near-miss shape still never flags (definite quoting)', () => {
    const r = lintCarrySurfaceProvenance('the syntax is `[owner=Name]`, not a real attribution');
    expect(r.flagged).toBe(false);
  });

  it('does NOT false-positive inside an unrelated word like "ownership"', () => {
    const r = lintCarrySurfaceProvenance('ownership of the migration is still being discussed');
    expect(r.flagged).toBe(false);
  });

  it('a hasTaggedProvenanceBlock check recognizes a near-miss-tagged PROVENANCE block (SOURCE_TAG_RE)', () => {
    // Compliance path from EI-10994: a tagged PROVENANCE block suppresses bare-gate-imperative
    // re-triggering on its own restatement. Must recognize the tag even in a near-miss shape.
    const text =
      'PROVENANCE: the "do not deploy until Friday" constraint above is attributed to [owner=jane 2026-08-09].\n' +
      'do not deploy until Friday';
    const r = lintCarrySurfaceProvenance(text);
    // the bare-gate-imperative line is suppressed because the block is recognized as tagged
    expect(r.matches.some((m) => m.kind === 'bare-gate-imperative')).toBe(false);
  });
});

describe('EI-21918777703977266: unverified dialog (AskUserQuestion) answer claims', () => {
  it('flags a bare owner tag claiming an AskUserQuestion answer as the sharper kind, not the generic one', () => {
    const r = lintCarrySurfaceProvenance(
      '[owner:jane 2026-08-30] the owner answered an AskUserQuestion, route = "build it myself"',
    );
    expect(r.flagged).toBe(true);
    expect(r.matches.some((m) => m.kind === 'unverified-dialog-answer-claim')).toBe(true);
    expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(false);
  });

  it('flags a bare owner tag naming AskUserQuestion by tool name, any name in the tag', () => {
    const r = lintCarrySurfaceProvenance('[owner:jane 2026-08-30] answered the AskUserQuestion with option 2');
    expect(r.matches.some((m) => m.kind === 'unverified-dialog-answer-claim')).toBe(true);
  });

  it('flags "answered a/an/the dialog" phrasing under an owner tag', () => {
    const r = lintCarrySurfaceProvenance('[owner:jane 2026-08-30] the owner answered the dialog: proceed');
    expect(r.matches.some((m) => m.kind === 'unverified-dialog-answer-claim')).toBe(true);
  });

  it('a generic owner tag with NO dialog language still gets the ordinary manual-owner-tag kind', () => {
    const r = lintCarrySurfaceProvenance('[owner:jane 2026-08-30] hold off on deploying until Friday');
    expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(true);
    expect(r.matches.some((m) => m.kind === 'unverified-dialog-answer-claim')).toBe(false);
  });

  it('a [turn:…] ref still clears a dialog-answer claim — the verifiable anchor is still the escape hatch', () => {
    const r = lintCarrySurfaceProvenance(
      '[owner:jane 2026-08-30] answered the AskUserQuestion [turn:claude:abcd1234@2026-08-30T10:00:00Z]',
    );
    expect(r.flagged).toBe(false);
  });

  it('a withdrawal ("NOT an owner directive") of a dialog claim is not flagged', () => {
    const r = lintCarrySurfaceProvenance(
      'This is [self-imposed] — I could NOT verify it against an owner turn; the AskUserQuestion was never answered.',
    );
    expect(r.matches.some((m) => m.kind === 'unverified-dialog-answer-claim')).toBe(false);
    expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(false);
  });

  it('does not false-positive on ordinary prose mentioning "dialog" with no owner tag', () => {
    const r = lintCarrySurfaceProvenance('the confirmation dialog closed without an answer');
    expect(r.flagged).toBe(false);
  });

  it('provenanceLintField selects the sharper dialog note and cites the incident', () => {
    const field = provenanceLintField('[owner:jane 2026-08-30] answered the AskUserQuestion, proceed with P-006');
    expect(field?.flagged).toBe(true);
    expect(field?.note).toContain('EI-21918777703977266');
    expect(field?.note).toContain('AskUserQuestion');
    expect(field?.note).not.toBe(PROVENANCE_LINT_NOTE);
    expect(field?.note).not.toBe(PROVENANCE_LINT_DOWNGRADED_NOTE);
  });

  it('the dialog note takes priority even when a generic manual-owner-tag also matches elsewhere', () => {
    const text =
      '[owner:jane 2026-08-30] answered the AskUserQuestion\n' + '[owner:jane 2026-08-30] hold off until Friday';
    const field = provenanceLintField(text);
    expect(field?.note).toContain('EI-21918777703977266');
  });
});
