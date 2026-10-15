/**
 * rubric-template.test.ts — the built-in `rubric` plan-template schema + its
 * self-registration (plan-templates-and-rubric-v2-2026-06-20 P-006).
 *
 * Pins the structured-data contract (the templateData jsonb shape) the re-pointed
 * rubrics store maps to the v1 Rubric, and that importing the module registers
 * `rubric` so the write path (plans:set-template-data → validateTemplateData) and the
 * read path (rubrics store) both resolve it. Pure (no PG).
 */
import { describe, it, expect } from 'vitest';
import {
  rubricTemplateDataSchema,
  rubricTemplateDataAuthoringSchema,
  rubricCriterionSchema,
  rubricCriterionCheckSchema,
  rubricCriterionWindowSchema,
  resolveCriterionWindow,
  rubricKindOf,
  isUnknownRatingEquivalent,
  isForbiddenMandatoryPassRating,
  UNKNOWN_RATING_EQUIVALENTS,
  DEFAULT_CRITERION_WINDOW_MS,
  RUBRIC_TEMPLATE,
  RUBRIC_TEMPLATE_NAME,
  type RubricTemplateData,
} from './rubric-template';
import { getPlanTemplate, isKnownPlanTemplate, validateTemplateData } from './template-registry';
import type { RubricCriterion, ProposeRubricCriterion } from '../../rubrics';

// The brief's minimal rubric: characteristic + criteria[{key,title,model,method,driftMarkers}] + ratingScale.
const minimalCriterion = {
  key: 'placement-health',
  title: 'Placement health',
  model: 'The Queen places every ready, unblocked frontier item onto a live bee within a cadence.',
  method: 'Count ready work_items with no claim older than the cadence.',
  driftMarkers: 'A growing backlog of ready-but-unplaced items.',
};
const minimalData = {
  characteristic: 'hive-coordination',
  criteria: [minimalCriterion],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
};

describe('rubric template schema', () => {
  it('retains an additive 23-file guard inventory within the test runner 50-file bound', () => {
    const files = Array.from({ length: 50 }, (_, i) => `lib/guard-${i}.test.ts`);
    expect(rubricCriterionCheckSchema.parse({ kind: 'tests', files: files.slice(0, 23) }))
      .toEqual({ kind: 'tests', files: files.slice(0, 23) });
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'tests', files }).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'tests', files: [...files, 'extra.test.ts'] }).success)
      .toBe(false);
  });

  it('accepts the brief\'s minimal rubric (characteristic + criteria + ratingScale)', () => {
    const r = rubricTemplateDataSchema.safeParse(minimalData);
    expect(r.success).toBe(true);
  });

  it('accepts the full shape (methodRef + description + per-criterion ratingScale override)', () => {
    const r = rubricTemplateDataSchema.safeParse({
      ...minimalData,
      methodRef: 'pot-coordination-health-runbook',
      description: 'How well the placement/ideation/observation loop is turning.',
      criteria: [{ ...minimalCriterion, ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'] }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.criteria[0].ratingScale).toContain('n/a');
  });

  it('accepts unpinned rubric composition refs', () => {
    const r = rubricTemplateDataSchema.safeParse({
      ...minimalData,
      composes: ['goal-mode-e2e'],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.composes).toEqual(['goal-mode-e2e']);
  });

  it('rejects an empty composition list', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, composes: [] }).success).toBe(false);
  });

  it('allows methodRef = null (explicit "no runbook")', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, methodRef: null }).success).toBe(true);
  });

  it('rejects an empty criteria list', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, criteria: [] }).success).toBe(false);
  });

  it('rejects an empty ratingScale', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, ratingScale: [] }).success).toBe(false);
  });

  it('rejects a criterion missing a required field (model)', () => {
    const { model: _drop, ...noModel } = minimalCriterion;
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, criteria: [noModel] }).success).toBe(false);
  });

  it('rejects a missing characteristic', () => {
    const { characteristic: _drop, ...noChar } = minimalData;
    expect(rubricTemplateDataSchema.safeParse(noChar).success).toBe(false);
  });

  it('is STRICT: rejects an unknown top-level field (fail-loud, D-004)', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, title: 'should live in frontmatter' }).success).toBe(
      false,
    );
  });

  it('is STRICT: rejects an unknown criterion field', () => {
    expect(
      rubricCriterionSchema.safeParse({ ...minimalCriterion, weight: 3 }).success,
    ).toBe(false);
  });

  it('accepts an optional probe-check unit and refuses an empty one (test-rubric-unification P-010)', () => {
    const probe = { kind: 'sql', sql: 'SELECT 1 AS v', schemaRevision: 'r', expect: { path: '$.rows[0].v', op: 'lte', value: 100 } };
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'probe', probe, unit: 'pct' }).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'probe', all: [probe, probe], unit: 'ms' }).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'probe', probe }).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'probe', probe, unit: '   ' }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'probe', probe, unit: 'x'.repeat(33) }).success).toBe(false);
  });

  it('accepts explicit intermediate rating bands for instrument and probe ledger checks', () => {
    const near = [{ rating: 'degraded', expect: { op: 'lte', value: 200 } }];
    const probe = { kind: 'sql', sql: 'SELECT 1 AS v', schemaRevision: 'r', expect: { path: '$.rows[0].v', op: 'lte', value: 50 } };
    expect(
      rubricCriterionCheckSchema.safeParse({
        kind: 'instrument', instrumentKey: 'host:df-root-used-pct', expect: { op: 'lte', value: 50 }, ratingBands: near,
      }).success,
    ).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'instrument', instrumentKey: 'host:df-root-used-pct', ratingBands: near }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'probe', probe, unit: 'ms', ratingBands: near }).success).toBe(true);
    expect(
      rubricCriterionCheckSchema.safeParse({
        kind: 'probe', probe, ratingBands: [{ rating: 'degraded', expect: { op: 'close', value: 2 } }],
      }).success,
    ).toBe(false);
  });

  it('accepts a native Cargo check with explicit manifest/source attribution', () => {
    expect(
      rubricCriterionCheckSchema.safeParse({
        kind: 'cargo',
        manifestPath: 'apps/tui/Cargo.toml',
        sourceFiles: ['apps/tui/src/app.rs', 'apps/tui/src/ui.rs'],
        test: 'app::tests::renders',
      }).success,
    ).toBe(true);
    expect(
      rubricCriterionSchema.safeParse({
        ...minimalCriterion,
        check: {
          kind: 'cargo',
          manifestPath: 'apps/tui/Cargo.toml',
          sourceFiles: ['apps/tui/src/app.rs'],
        },
      }).success,
    ).toBe(true);
    expect(
      rubricCriterionCheckSchema.safeParse({
        kind: 'cargo',
        manifestPath: 'apps/tui/Cargo.toml',
        sourceFiles: ['apps/tui/src/app.rs'],
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('keeps the read schema compatible with historical light acceptance rows', () => {
    expect(
      rubricTemplateDataSchema.safeParse({
        characteristic: 'plan-acceptance',
        kind: 'acceptance',
        subjectPlan: 'some-plan-2026-08-11',
        criteria: [{ key: 'outcome', title: 'Outcome' }],
        ratingScale: ['pass', 'fail'],
      }).success,
    ).toBe(true);
  });

  it('preserves additive fields written by a newer server in the BAR contract', () => {
    const parsed = rubricTemplateDataSchema.safeParse({
      characteristic: 'plan-acceptance',
      kind: 'acceptance',
      subjectPlan: 'some-plan-2026-09-04',
      criteria: [{ key: 'outcome', title: 'Outcome' }],
      ratingScale: ['pass', 'fail', 'unknown'],
      barSetHash: 'a'.repeat(64),
      barContract: {
        schemaVersion: 1,
        adoptionEpoch: 1,
        cohort: 'post-epoch',
        subjectPlanRevision: 3,
        seededAt: '2026-09-04T12:00:00.000Z',
        seededBy: 'su-author',
        futureServerField: { revision: 4 },
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.barContract).toMatchObject({
        subjectPlanRevision: 3,
        futureServerField: { revision: 4 },
      });
    }
  });

  it('persists canonical acceptance BAR metadata but never a second bar text field', () => {
    const criterion = {
      key: 'activation-outcome',
      title: 'Coverage activation exists',
      model: 'The activation path produces coverage-evidence rows.',
      driftMarkers: 'No coverage-evidence rows exist for the activation path.',
      barKey: 'R-7',
      barHash: 'a'.repeat(64),
      role: 'outcome' as const,
      mandatory: true,
      requiredScope: ['cohort:post-epoch', 'surface:coverage-row'],
      evidencePlane: 'tree' as const,
      passRatings: ['pass'],
      barProvenance: {
        lifecycle: 'pre-implementation' as const,
        declaredAt: '2026-09-04T12:00:00.000Z',
        declaredBy: 'su-author',
      },
    };
    const data = {
      kind: 'acceptance' as const,
      subjectPlan: 'some-plan-2026-09-04',
      characteristic: 'plan-acceptance',
      criteria: [criterion],
      ratingScale: ['pass', 'fail', 'unknown'],
    };

    expect(rubricTemplateDataAuthoringSchema.safeParse(data).success).toBe(true);
    expect(
      rubricTemplateDataAuthoringSchema.safeParse({
        ...data,
        criteria: [{ ...criterion, bar: criterion.model }],
      }).success,
    ).toBe(false); // `bar` is a wire alias, never persisted template_data.
    expect(
      rubricTemplateDataSchema.safeParse({
        ...minimalData,
        criteria: [{ ...minimalCriterion, barHash: 'a'.repeat(64) }],
      }).success,
    ).toBe(false); // BAR metadata is acceptance-kind only.
  });

  it('refuses a partial persisted BAR contract without canonical model text or its hash', () => {
    const acceptance = {
      kind: 'acceptance' as const,
      subjectPlan: 'some-plan-2026-09-04',
      characteristic: 'plan-acceptance',
      ratingScale: ['pass', 'fail', 'unknown'],
    };
    expect(
      rubricTemplateDataAuthoringSchema.safeParse({
        ...acceptance,
        criteria: [
          {
            key: 'outcome',
            title: 'Outcome',
            driftMarkers: 'The outcome is absent.',
            role: 'outcome',
            mandatory: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      rubricTemplateDataAuthoringSchema.safeParse({
        ...acceptance,
        criteria: [
          {
            key: 'outcome',
            title: 'Outcome',
            model: 'The outcome exists.',
            driftMarkers: 'The outcome is absent.',
            role: 'outcome',
            mandatory: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires mandatory outcome passRatings to be positive members of the rubric scale', () => {
    const criterion = {
      key: 'outcome',
      title: 'Outcome',
      model: 'The outcome exists.',
      driftMarkers: 'The outcome is absent.',
      barKey: 'R-1',
      barHash: 'a'.repeat(64),
      role: 'outcome' as const,
      mandatory: true,
      evidencePlane: 'tree' as const,
    };
    const acceptance = {
      kind: 'acceptance' as const,
      subjectPlan: 'some-plan-2026-09-04',
      characteristic: 'plan-acceptance',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
    };

    expect(
      rubricTemplateDataAuthoringSchema.safeParse({ ...acceptance, criteria: [criterion] }).success,
    ).toBe(false);
    for (const forbidden of ['degraded', 'broken', 'unknown', 'not-applicable', 'waived']) {
      expect(isForbiddenMandatoryPassRating(forbidden)).toBe(true);
      expect(
        rubricTemplateDataAuthoringSchema.safeParse({
          ...acceptance,
          ratingScale: [...acceptance.ratingScale, forbidden],
          criteria: [{ ...criterion, passRatings: [forbidden] }],
        }).success,
      ).toBe(false);
    }
    expect(
      rubricTemplateDataAuthoringSchema.safeParse({
        ...acceptance,
        criteria: [{ ...criterion, passRatings: ['pass'] }],
      }).success,
    ).toBe(false); // pass is positive but absent from this rubric's scale.
    expect(
      rubricTemplateDataAuthoringSchema.safeParse({
        ...acceptance,
        criteria: [{ ...criterion, passRatings: ['healthy'] }],
      }).success,
    ).toBe(true);

    const disclosure = {
      ...criterion,
      key: 'outcome-disclosed',
      barKey: 'R-2',
      role: 'disclosure' as const,
      mandatory: false,
      coversBarKeys: ['R-1'],
      passRatings: [],
    };
    expect(
      rubricTemplateDataAuthoringSchema.safeParse({
        ...acceptance,
        criteria: [{ ...criterion, passRatings: ['healthy'] }, disclosure],
      }).success,
    ).toBe(true);

    const invalidDisclosure = rubricTemplateDataAuthoringSchema.safeParse({
      ...acceptance,
      criteria: [
        { ...criterion, passRatings: ['healthy'] },
        { ...disclosure, passRatings: ['healthy'] },
      ],
    });
    expect(invalidDisclosure.success).toBe(false);
    if (!invalidDisclosure.success) {
      expect(invalidDisclosure.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 1, 'passRatings'],
            message: expect.stringContaining('must be empty'),
          }),
        ]),
      );
    }
  });
});

describe('structured criterion grading-window (EI-12146)', () => {
  it('accepts a rolling window on a criterion', () => {
    const r = rubricCriterionSchema.safeParse({
      ...minimalCriterion,
      window: { kind: 'rolling', ms: 48 * 60 * 60 * 1000 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts a post-watermark window on a criterion', () => {
    const r = rubricTemplateDataSchema.safeParse({
      ...minimalData,
      criteria: [{ ...minimalCriterion, window: { kind: 'post-watermark', watermarkRef: 'bg-host-restart' } }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects 'rolling' without ms — a rolling window with no length judges nothing definite", () => {
    expect(rubricCriterionWindowSchema.safeParse({ kind: 'rolling' }).success).toBe(false);
  });

  it("rejects 'post-watermark' without watermarkRef", () => {
    expect(rubricCriterionWindowSchema.safeParse({ kind: 'post-watermark' }).success).toBe(false);
  });

  it('rejects an unknown kind and unknown fields (strict, fail-loud)', () => {
    expect(rubricCriterionWindowSchema.safeParse({ kind: 'lifetime' }).success).toBe(false);
    expect(
      rubricCriterionWindowSchema.safeParse({ kind: 'rolling', ms: 1000, days: 2 }).success,
    ).toBe(false);
  });
});

describe('resolveCriterionWindow (EI-12146) — one resolution, every consumer', () => {
  const nowMs = Date.parse('2026-07-14T22:00:00Z');

  it('no declared window → the default rolling box, tagged source:default', () => {
    const r = resolveCriterionWindow(undefined, { nowMs });
    expect(r).toEqual({
      sinceMs: nowMs - DEFAULT_CRITERION_WINDOW_MS,
      kind: 'rolling',
      windowMs: DEFAULT_CRITERION_WINDOW_MS,
      source: 'default',
    });
  });

  it('a rolling window resolves now - ms', () => {
    const r = resolveCriterionWindow({ kind: 'rolling', ms: 3_600_000 }, { nowMs });
    expect(r.sinceMs).toBe(nowMs - 3_600_000);
    expect(r.source).toBe('window');
    expect(r.kind).toBe('rolling');
  });

  it('a post-watermark window resolves through the supplied watermark — the generation boundary, not a look-back', () => {
    const restartMs = nowMs - 10 * 60 * 1000;
    const r = resolveCriterionWindow(
      { kind: 'post-watermark', watermarkRef: 'bg-host-restart' },
      { nowMs, watermarks: { 'bg-host-restart': restartMs } },
    );
    expect(r).toEqual({ sinceMs: restartMs, kind: 'post-watermark', watermarkRef: 'bg-host-restart', source: 'window' });
  });

  it('an UNRESOLVED watermark degrades to the rolling default WITH provenance — never silently judges the wrong window', () => {
    const r = resolveCriterionWindow(
      { kind: 'post-watermark', watermarkRef: 'bg-host-restart' },
      { nowMs, watermarks: {} },
    );
    expect(r.source).toBe('watermark-unresolved');
    expect(r.kind).toBe('rolling');
    expect(r.sinceMs).toBe(nowMs - DEFAULT_CRITERION_WINDOW_MS);
    // The failed ref stays visible so a consumer can surface WHICH watermark was missing.
    expect(r.watermarkRef).toBe('bg-host-restart');
  });

  it('honors a caller default (defaultMs) for both the no-window and fallback paths', () => {
    const defaultMs = 7 * 24 * 60 * 60 * 1000;
    expect(resolveCriterionWindow(undefined, { nowMs, defaultMs }).sinceMs).toBe(nowMs - defaultMs);
    expect(
      resolveCriterionWindow({ kind: 'post-watermark', watermarkRef: 'x' }, { nowMs, defaultMs }).sinceMs,
    ).toBe(nowMs - defaultMs);
  });
});

describe('self-registration', () => {
  it('importing the module registers the `rubric` template', () => {
    expect(isKnownPlanTemplate(RUBRIC_TEMPLATE_NAME)).toBe(true);
    expect(getPlanTemplate('rubric')?.name).toBe('rubric');
    expect(RUBRIC_TEMPLATE.name).toBe('rubric');
  });

  it('validateTemplateData("rubric", …) routes through the registered schema', () => {
    const ok = validateTemplateData('rubric', minimalData);
    expect(ok.ok).toBe(true);
    const bad = validateTemplateData('rubric', { ...minimalData, criteria: [] });
    expect(bad).toMatchObject({ ok: false, code: 'invalid_data' });
  });
});

// ─── per-kind validation profile (acceptance-rubrics-on-every-plan-2026-08-11 P-001) ──
describe('rubric kind (standard | acceptance)', () => {
  const issues = (d: unknown): string => {
    const r = rubricTemplateDataSchema.safeParse(d);
    return r.success ? '' : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  };

  it('rubricKindOf: absent/unknown maps to standard; acceptance maps to acceptance', () => {
    expect(rubricKindOf(undefined)).toBe('standard');
    expect(rubricKindOf({})).toBe('standard');
    expect(rubricKindOf({ kind: null })).toBe('standard');
    expect(rubricKindOf({ kind: 'acceptance' })).toBe('acceptance');
  });

  it('standard (absent kind): refuses subjectPlan / classRef / light criteria', () => {
    expect(issues({ ...minimalData, subjectPlan: 'some-plan' })).toContain('subjectPlan is acceptance-kind only');
    expect(issues({ ...minimalData, classRef: 'feature-ship' })).toContain('classRef is acceptance-kind only');
    expect(
      issues({ ...minimalData, criteria: [{ key: 'light', title: 'Light' }] }),
    ).toContain("standard-kind criterion 'light' requires model");
  });

  it('standard: refuses subjectGoal too (the goal-subject twin, consult-min-max-…-2026-08-17 P-009)', () => {
    expect(issues({ ...minimalData, subjectGoal: 'ship-a-paid-app-abc123' })).toContain(
      'subjectGoal is acceptance-kind only',
    );
  });

  it('acceptance: subjectGoal is a valid subject on its own; naming BOTH subjects is refused', () => {
    const goalSubject = {
      characteristic: 'goal-acceptance',
      kind: 'acceptance',
      subjectGoal: 'ship-a-paid-app-abc123',
      criteria: [
        {
          key: 'paying-user',
          title: 'At least one paying user exists',
          driftMarkers: 'No verified paying-user evidence exists in the measured window.',
        },
      ],
      ratingScale: ['pass', 'fail', 'unknown'],
    };
    expect(rubricTemplateDataSchema.safeParse(goalSubject).success).toBe(true);
    expect(issues({ ...goalSubject, subjectPlan: 'some-plan-2026-08-11' })).toContain('exactly ONE subject');
  });

  it('acceptance: requires subjectPlan; light criteria are valid', () => {
    expect(issues({ ...minimalData, kind: 'acceptance' })).toContain('requires subjectPlan');
    const ok = rubricTemplateDataSchema.safeParse({
      characteristic: 'plan-acceptance',
      kind: 'acceptance',
      subjectPlan: 'some-plan-2026-08-11',
      criteria: [
        {
          key: 'gate-rerun',
          title: 'The gate re-runs without a manual poke',
          driftMarkers: 'The gate remains stalled until an operator manually restarts it.',
        },
      ],
      ratingScale: ['pass', 'fail', 'unknown'],
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(rubricKindOf(ok.data)).toBe('acceptance');
  });

  it('acceptance: zero criteria valid ONLY with classRef (D-009); releaseGating refused', () => {
    const base = {
      characteristic: 'plan-acceptance',
      kind: 'acceptance',
      subjectPlan: 'some-plan-2026-08-11',
      criteria: [],
      ratingScale: ['pass', 'fail', 'unknown'],
    };
    expect(issues(base)).toContain('bespoke criteria OR a classRef');
    expect(rubricTemplateDataSchema.safeParse({ ...base, classRef: 'investigation' }).success).toBe(true);
    expect(
      issues({ ...base, classRef: 'investigation', releaseGating: true }),
    ).toContain('releaseGating is standard-kind only');
  });
});

describe('acceptance authoring profile (EI-21826845597011306)', () => {
  const acceptance = (over: Record<string, unknown> = {}) => ({
    characteristic: 'plan-acceptance',
    kind: 'acceptance',
    subjectPlan: 'some-plan-2026-08-11',
    criteria: [
      {
        key: 'outcome',
        title: 'Outcome',
        driftMarkers: 'The measured outcome is absent or contradicted.',
      },
    ],
    ratingScale: ['pass', 'fail', 'unknown'],
    ...over,
  });

  it('requires a concrete driftMarkers falsifier for every bespoke criterion', () => {
    const result = rubricTemplateDataAuthoringSchema.safeParse(
      acceptance({ criteria: [{ key: 'outcome', title: 'Outcome' }] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'driftMarkers'],
            message: expect.stringContaining('requires non-empty driftMarkers'),
          }),
        ]),
      );
    }
  });

  it('requires a no-verdict rating so unavailable evidence cannot be fabricated as pass/fail', () => {
    const result = rubricTemplateDataAuthoringSchema.safeParse(
      acceptance({ ratingScale: ['pass', 'partial', 'fail'] }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['ratingScale'],
            message: expect.stringContaining('unknown-equivalent'),
          }),
        ]),
      );
    }
  });

  it.each(['unknown', 'NOT-MEASURED', 'not assessed', 'indeterminate', 'n/a', 'not_applicable'])(
    'recognizes %s as an unknown-equivalent',
    (value) => {
      expect(isUnknownRatingEquivalent(value)).toBe(true);
    },
  );

  it.each([
    'unknown — evidence does not establish an outcome',
    'NOT-MEASURED: the measurement was unavailable',
    'not assessed — no admissible evidence was recorded',
  ])('recognizes a human-readable %s scale entry by its leading label', (value) => {
    expect(isUnknownRatingEquivalent(value)).toBe(true);
  });

  it('accepts an acceptance rubric whose unknown-equivalent scale entry includes a definition', () => {
    const result = rubricTemplateDataAuthoringSchema.safeParse(
      acceptance({ ratingScale: ['pass', 'fail', 'unknown — evidence does not establish an outcome'] }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a non-canonical unknown-equivalent and a concrete falsifier', () => {
    const result = rubricTemplateDataAuthoringSchema.safeParse(
      acceptance({ ratingScale: ['pass', 'fail', 'not-measured'] }),
    );
    expect(result.success).toBe(true);
  });

  it('does not impose acceptance-only guards on standard rubrics', () => {
    expect(
      rubricTemplateDataAuthoringSchema.safeParse({
        ...minimalData,
        ratingScale: ['healthy', 'degraded', 'broken'],
      }).success,
    ).toBe(true);
  });

  it('publishes the stricter profile through the registered template write schema', () => {
    expect(RUBRIC_TEMPLATE.schema.safeParse(acceptance({ ratingScale: ['pass', 'fail'] })).success).toBe(false);
    expect(UNKNOWN_RATING_EQUIVALENTS).toContain('unknown');
  });
});

describe('shape parity with the v1 Rubric', () => {
  // Kind-aware since acceptance-rubrics-on-every-plan-2026-08-11: the SCHEMA-level
  // criterion type allows acceptance-kind criteria to omit model/method/driftMarkers, so
  // the compile-time pin targets ProposeRubricCriterion (the write-path input shape) and
  // the FULL standard element schema pins against RubricCriterion directly. Runtime
  // presence for standard-kind criteria is enforced by the per-kind superRefine (tested
  // in the per-kind describe below).
  it('a parsed criterion is assignable to ProposeRubricCriterion; the full element schema pins RubricCriterion', () => {
    const data: RubricTemplateData = rubricTemplateDataSchema.parse(minimalData);
    const criterion: ProposeRubricCriterion = data.criteria[0];
    expect(criterion.key).toBe('placement-health');
    // Full-element pin: if rubricCriterionSchema's shape ever drifts from the v1
    // RubricCriterion, this fails tsc.
    const full: RubricCriterion = rubricCriterionSchema.parse(minimalCriterion);
    expect(full.model).toBe(minimalCriterion.model);
    // Standard-kind runtime guarantee: the prose fields survived the parse.
    expect(criterion.model).toBeTruthy();
    expect(criterion.method).toBeTruthy();
    expect(criterion.driftMarkers).toBeTruthy();
  });

  it('a parsed criterion WITH a window stays assignable (EI-12146 parity pin)', () => {
    const data: RubricTemplateData = rubricTemplateDataSchema.parse({
      ...minimalData,
      criteria: [{ ...minimalCriterion, window: { kind: 'post-watermark', watermarkRef: 'bg-host-restart' } }],
    });
    const criterion: ProposeRubricCriterion = data.criteria[0];
    expect(criterion.window?.kind).toBe('post-watermark');
  });
});
