import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertRubricRatingVocabulary,
  extractRubricRatingInstructions,
  validateRubricRatingVocabulary,
} from './rubric-rating-vocabulary';
import { canonicalScorecardRating } from './harness/improvements/observation-types';
import { proposeRubric, type ProposeRubricCriterion } from './rubrics';

const criterion = (over: Partial<ProposeRubricCriterion> & { key: string }): ProposeRubricCriterion => {
  const { key, title, model, method, driftMarkers, ...rest } = over;
  return {
    key,
    title: title ?? `Criterion ${key}`,
    model: model ?? 'How it should work.',
    method: method ?? 'How to investigate it.',
    driftMarkers: driftMarkers ?? 'What failure looks like.',
    ...rest,
  };
};

describe('rubric rating-vocabulary validation (WI-835208)', () => {
  it('extracts only explicit grade/rate instructions, not ordinary state prose', () => {
    const instructions = extractRubricRatingInstructions(
      'c1',
      'method',
      'The observed state may be partial. Grade `broken` if the probe fails. ' +
        'The rate limit response is recorded separately.',
    );

    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toMatchObject({
      criterionKey: 'c1',
      field: 'method',
      rating: 'broken',
    });
  });

  it.each([
    'Mandatory composite conjunction; no healthy rating is allowed unless every leg below is evidenced.',
    'A healthy rating is permitted when every mandatory leg is evidenced.',
    'Any healthy rating is allowed if the complete conjunction is evidenced.',
    'No `healthy` rating is allowed unless every leg below is evidenced.',
  ])('treats descriptive rating allowances as conditions rather than labels: %s', (method) => {
    const result = validateRubricRatingVocabulary(
      [criterion({ key: 'composite-conjunction', method })],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result).toMatchObject({ ok: true, instructions: [], violations: [] });
  });

  it.each([
    ['Rating is partial if a mandatory leg is missing.', 'partial'],
    ['The correct rating is partial if a mandatory leg is missing.', 'partial'],
    ['Rating is allowed unless a mandatory leg is missing.', 'allowed'],
    ['Grade allowed unless a mandatory leg is missing.', 'allowed'],
    ['No healthy rating is allowed unless every leg is evidenced. Grade partial if evidence is missing.', 'partial'],
  ])('preserves explicit off-scale directives around allowance prose: %s', (method, rating) => {
    const result = validateRubricRatingVocabulary(
      [criterion({ key: 'explicit-composite-directive', method })],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.rating)).toEqual([rating]);
  });

  it.each([
    'Enumerate change/delete/revoke streams, rate limits, private routes, and credential rotation.',
    'Exercise connector rate limits. Grade broken if recovery fails.',
    'Inspect the provider rate limit; Grade healthy when the recorded bound holds.',
  ])('treats rate-limit noun phrases as connector behavior: %s', (method) => {
    const result = validateRubricRatingVocabulary(
      [criterion({ key: 'connector-population', method })],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.instructions.every((instruction) => ['healthy', 'broken'].includes(instruction.rating))).toBe(true);
  });

  it.each([
    'Rate as limits when evidence is incomplete.',
    'Rate `limits` if the probe fails.',
    'Rating is limits when the check fails.',
    'Grade limits if the probe fails.',
  ])('still rejects explicit off-scale limits directives: %s', (method) => {
    const result = validateRubricRatingVocabulary(
      [criterion({ key: 'explicit-directive', method })],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.rating)).toEqual(['limits']);
  });

  it('finds quoted and unquoted explicit directives while ignoring ambiguous prose', () => {
    const result = validateRubricRatingVocabulary(
      [
        criterion({
          key: 'c1',
          method: 'Grade fail if the check fails.',
          replication: 'rate `partial` when only some consumers comply.',
        }),
        criterion({
          key: 'c2',
          method: 'A partial result is possible; use the evidence to decide.',
          replication: 'Discuss the rate limit behavior without prescribing a grade.',
        }),
      ],
      ['pass', 'partial', 'fail', 'unknown'],
    );

    expect(result.ok).toBe(true);
    expect(result.instructions.map((instruction) => instruction.rating)).toEqual(['fail', 'partial']);
    expect(result.violations).toEqual([]);
  });

  it('ignores contextual objects and compound labels that are not rating values', () => {
    const instructions = extractRubricRatingInstructions(
      'context',
      'method',
      'For leadership, grade it on observed claim counts. Verify GOAL+GRADE mode for the holder.',
    );

    expect(instructions).toEqual([]);
  });

  it('treats "at grade time" as a noun phrase while preserving an explicit time rating', () => {
    const incidental = extractRubricRatingInstructions(
      'timing',
      'method',
      'This bar grades broken while the share is below the floor at grade time, alarm or not.',
    );
    expect(incidental).toEqual([]);

    const explicit = validateRubricRatingVocabulary(
      [criterion({ key: 'time-rating', method: 'Grade time if the check runs in the requested window.' })],
      ['time'],
    );
    expect(explicit).toMatchObject({
      ok: true,
      instructions: [{ rating: 'time' }],
      violations: [],
    });
  });

  it('ignores ordinary prose using grade instead of a rating directive', () => {
    const method = 'Guarantee, and what to grade instead: it is STRUCTURAL.';

    expect(extractRubricRatingInstructions('ordinary-prose', 'method', method)).toEqual([]);
    expect(
      validateRubricRatingVocabulary(
        [criterion({ key: 'ordinary-prose', method })],
        ['healthy', 'degraded', 'broken', 'unknown'],
      ),
    ).toMatchObject({ ok: true, instructions: [], violations: [] });
  });

  it('treats grade lineage as an inspection object without hiding an explicit off-scale rating', () => {
    const scale = ['healthy', 'degraded', 'broken', 'unknown'];
    const inspection = validateRubricRatingVocabulary(
      [criterion({ key: 'lineage', method: 'Read the independent scorecard and grade lineage.' })],
      scale,
    );
    expect(inspection).toMatchObject({ ok: true, instructions: [], violations: [] });

    const directive = validateRubricRatingVocabulary(
      [criterion({ key: 'lineage', method: 'Read the scorecard. Grade lineage if the chain is incomplete.' })],
      scale,
    );
    expect(directive.violations.map((violation) => violation.rating)).toEqual(['lineage']);
    expect(
      validateRubricRatingVocabulary(
        [criterion({ key: 'lineage', method: "Read the scorecard and Grade 'lineage' if the chain is incomplete." })],
        scale,
      ).violations.map((violation) => violation.rating),
    ).toEqual(['lineage']);
  });

  it('treats qualified grade maps and grade receipts as artifact nouns', () => {
    const result = validateRubricRatingVocabulary(
      [
        criterion({ key: 'r-10', method: 'Reject the malformed grade map.' }),
        criterion({ key: 'r-18', method: 'Preserve canonical grade receipts.' }),
      ],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result).toMatchObject({ ok: true, instructions: [], violations: [] });
  });

  it('still rejects an explicit off-scale directive using an artifact word as its label', () => {
    const result = validateRubricRatingVocabulary(
      [criterion({ key: 'explicit-artifact-label', method: 'Grade map if the mapping is complete.' })],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.violations.map((violation) => violation.rating)).toEqual(['map']);
  });

  it('ignores numbered GRADE headings and rate-of noun phrases without hiding a real directive', () => {
    const instructions = extractRubricRatingInstructions(
      'procedure-prose',
      'method',
      '(5) GRADE: JUDGED, anchored to the recorded seed locations. ' +
        "Compare the polling cadence with the signal's rate of change. Grade fail if the probe disagrees.",
    );

    expect(instructions.map((instruction) => instruction.rating)).toEqual(['fail']);
  });

  it('accepts the complete shipped su-agent-behavior rubric vocabulary', () => {
    const rubric = JSON.parse(
      readFileSync(new URL('../../../rubrics/su-agent-behavior/rubric.json', import.meta.url), 'utf8'),
    ) as {
      criteria: ProposeRubricCriterion[];
      ratingScale: string[];
    };

    const result = validateRubricRatingVocabulary(rubric.criteria, rubric.ratingScale);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('ignores directive words inside SQL/code literals without hiding real rating instructions', () => {
    const result = validateRubricRatingVocabulary(
      [
        criterion({
          key: 'grade-vs-test-split',
          replication:
            "Query modes with mode IN ('grade','test') and inspect the `rating` column. " +
            "Grade 'healthy' when the two populations remain separate.",
        }),
      ],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.ok).toBe(true);
    expect(result.instructions.map((instruction) => instruction.rating)).toEqual(['healthy']);
    expect(result.violations).toEqual([]);
  });

  it('accepts the shipped tool-utilization criterion containing the code:run tool name', () => {
    const rubric = JSON.parse(
      readFileSync(new URL('../../../rubrics/pot-coordination-health/rubric.json', import.meta.url), 'utf8'),
    ) as { criteria: ProposeRubricCriterion[]; ratingScale: string[] };
    const toolUtilization = rubric.criteria.find((candidate) => candidate.key === 'tool-utilization');

    expect(toolUtilization).toBeDefined();
    expect(validateRubricRatingVocabulary([toolUtilization!], rubric.ratingScale)).toMatchObject({
      ok: true,
      instructions: [],
      violations: [],
    });

    const explicitColonDirective = validateRubricRatingVocabulary(
      [criterion({ key: 'explicit-colon', method: 'Grade partial: if the evidence is incomplete.' })],
      rubric.ratingScale,
    );
    expect(explicitColonDirective.violations.map((violation) => violation.rating)).toEqual(['partial']);
  });

  it.each([
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['“', '”'],
  ])('ignores quoted test titles between %s and %s while retaining explicit ratings', (open, close) => {
    const cite = (title: string) => `${open}${title}${close}`;
    const result = validateRubricRatingVocabulary(
      [
        criterion({
          key: 'test-citations',
          method:
            'Run tests ' +
            cite('leaves a sound all-accept batch unflagged solely for its acceptance rate') +
            '; ' +
            cite('labels a capped scan without inventing a zero error rate') +
            ' and inspect their assertions. Grade healthy when they pass. Grade partial if evidence is missing.',
        }),
      ],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.instructions.map((instruction) => instruction.rating)).toEqual(['healthy', 'partial']);
    expect(result.violations.map((violation) => violation.rating)).toEqual(['partial']);
  });

  it('ignores directives inside escaped citation text and nested code strings', () => {
    const method =
      String.raw`Run "retains a \"partial\" rating when quoted" and inspect ` +
      '`const example = "Grade partial if missing"`' +
      '. Grade broken if the actual probe fails.';

    expect(
      extractRubricRatingInstructions('escaped-citations', 'method', method).map((instruction) => instruction.rating),
    ).toEqual(['broken']);
  });

  it('does not hide real directives after apostrophes or unmatched quotes', () => {
    const method =
      "The operator's evidence isn't optional. Grade partial if it is missing. " +
      'An unmatched " citation must not hide this: Grade broken if the probe fails.';

    expect(
      extractRubricRatingInstructions('unbalanced-citations', 'method', method).map(
        (instruction) => instruction.rating,
      ),
    ).toEqual(['partial', 'broken']);
  });

  it('uses a criterion ratingScale override instead of the rubric default', () => {
    const result = validateRubricRatingVocabulary(
      [
        criterion({
          key: 'override',
          ratingScale: ['pass', 'partial', 'fail'],
          method: 'Grade `partial` if the partial path is observed.',
        }),
        criterion({
          key: 'default',
          method: 'Grade `partial` if the partial path is observed.',
        }),
      ],
      ['healthy', 'degraded', 'broken', 'unknown'],
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      criterionKey: 'default',
      field: 'method',
      rating: 'partial',
      allowedRatings: ['healthy', 'degraded', 'broken', 'unknown'],
    });
  });

  it('matches rating labels case-insensitively', () => {
    expect(
      validateRubricRatingVocabulary(
        [criterion({ key: 'c1', method: 'GRADE HEALTHY IF the probe passes.' })],
        ['healthy', 'degraded', 'broken', 'unknown'],
      ).ok,
    ).toBe(true);
  });

  it('assertion names the criterion, field, offending value, and effective scale', () => {
    expect(() =>
      assertRubricRatingVocabulary(
        [criterion({ key: 'c2', replication: 'Grade `partial` if a consumer re-projects its own view.' })],
        ['healthy', 'degraded', 'broken', 'unknown'],
        { rubricId: 'acceptance-rubric' },
      ),
    ).toThrow(
      /rubric 'acceptance-rubric'.*criterion 'c2' replication.*'partial'.*healthy \| degraded \| broken \| unknown/,
    );
  });

  it('rubrics:propose rejects an off-scale explicit instruction before any store access', async () => {
    await expect(
      proposeRubric({
        rubricId: 'rating-vocabulary-wiring',
        characteristic: 'rating-vocabulary',
        title: 'Rating vocabulary wiring',
        criteria: [
          criterion({
            key: 'c1',
            method: 'Grade `partial` if the check is only partially satisfied.',
          }),
        ],
        ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      }),
    ).rejects.toThrow(/off-scale rating instructions.*partial/);
  });

  // A rating scale routinely carries its definition inline. The authoring
  // validator and scorecards:emit must agree about that form, or every rubric
  // written that way becomes unproposable AND unamendable while grading it
  // would have worked fine (measured on
  // test-suite-recovery-2026-08-27-acceptance, whose C6 scale is em-dashed).
  describe('a `label — definition` scale entry is satisfied by its leading label', () => {
    const emDashScale = [
      'fail — an ADMISSIBLE run that is red on its merits',
      'undetermined — the verdict cannot be TRUSTED rather than being bad',
      'partial — exit 0 with Vitest evidence but Cargo refused pre-spawn',
      'pass — non-empty Vitest AND Cargo evidence, zero failed counts',
    ];

    it('accepts prose naming the short label, and agrees with canonicalScorecardRating', () => {
      const method = "If it did not, the correct rating is 'undetermined' under D-007.";
      const validation = validateRubricRatingVocabulary(
        [criterion({ key: 'c6', method, ratingScale: emDashScale })],
        ['healthy', 'degraded', 'broken', 'unknown'],
      );
      expect(validation.violations).toEqual([]);
      expect(validation.ok).toBe(true);
      // The half that ACCEPTS the rating resolves it to a real scale entry, which
      // is precisely why refusing it at authoring time was wrong.
      expect(emDashScale).toContain(canonicalScorecardRating('undetermined', emDashScale));
    });

    // CALIBRATION: the guard is still fail-closed for a genuinely off-scale
    // rating, so the case above is not passing because nothing is checked.
    it('still refuses a rating that no entry leads with', () => {
      const validation = validateRubricRatingVocabulary(
        [criterion({ key: 'c6', method: 'Grade `healthy` when the run is clean.', ratingScale: emDashScale })],
        ['healthy', 'degraded', 'broken', 'unknown'],
      );
      expect(validation.ok).toBe(false);
      expect(validation.violations[0]?.rating).toBe('healthy');
    });

    // A directive that ends a sentence must not capture the full stop — that
    // reported `undetermined.`, a rating no author wrote and no scale contains.
    it('does not swallow sentence punctuation into the rating', () => {
      const method = 'If it did not, the correct rating is undetermined.';
      expect(extractRubricRatingInstructions('c6', 'method', method).map((i) => i.rating)).toEqual([
        'undetermined',
      ]);
      const validation = validateRubricRatingVocabulary(
        [criterion({ key: 'c6', method, ratingScale: emDashScale })],
        ['healthy', 'degraded', 'broken', 'unknown'],
      );
      expect(validation.violations).toEqual([]);
    });

    // CALIBRATION: stripping the stop must not make an off-scale rating pass.
    it('still refuses an off-scale rating that ends a sentence', () => {
      const validation = validateRubricRatingVocabulary(
        [criterion({ key: 'c6', method: 'Otherwise the correct rating is healthy.', ratingScale: emDashScale })],
        ['healthy', 'degraded', 'broken', 'unknown'],
      );
      expect(validation.ok).toBe(false);
      expect(validation.violations[0]?.rating).toBe('healthy');
    });

    // An ambiguous leading label cannot resolve to one rating at emit time
    // either, so it stays a violation rather than silently picking the first.
    it('still refuses an ambiguous leading label', () => {
      const ambiguous = ['pass — with evidence', 'pass — without evidence', 'unknown'];
      const validation = validateRubricRatingVocabulary(
        [criterion({ key: 'c6', method: 'Grade `pass` when both evidences are present.', ratingScale: ambiguous })],
        ['healthy', 'degraded', 'broken', 'unknown'],
      );
      expect(validation.ok).toBe(false);
      expect(validation.violations[0]?.rating).toBe('pass');
    });
  });
});
