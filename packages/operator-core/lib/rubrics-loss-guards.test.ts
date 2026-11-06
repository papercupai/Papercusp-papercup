/**
 * rubrics-loss-guards.test.ts — the WI-4287 pure surfaces: assertNoSilentRubricLoss
 * (the propose whole-document-replace loss-guard), rubricCompleteness (the per-aspect
 * testing-procedure report), the criterion `replication` field end-to-end through the
 * template schema + planRowToRubric mapping.
 *
 * [owner 2026-07-12] "how can we improve our system so that the next agent who
 * updates the rubric also knows to add the full detailed testing procedure and doesn't
 * drop it? … i think each aspect should come with its own testing procedure in addition
 * to one main one for the whole rubric." These tests pin exactly that: a proposal that
 * silently drops a criterion or guts its procedure is REJECTED with a teaching error;
 * gaps in per-aspect procedures are REPORTED.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoSilentRubricLoss,
  proposeRubric,
  rubricCompleteness,
  planRowToRubric,
  normalizeAcceptanceRubricProposal,
  applyRubricAmendment,
  normalizeAcceptanceBarCriterion,
  computeAcceptanceBarHash,
  normalizeRubricCompositionRefs,
  REPLICATION_DRILL_MARKER,
  METHOD_SHRINK_GUARD_MIN_CHARS,
  type Rubric,
  type RubricCriterion,
  type ProposeRubricInput,
  type ProposeRubricCriterion,
} from './rubrics';
import {
  rubricCriterionSchema,
  rubricTemplateDataSchema,
  rubricTemplateDataAuthoringSchema,
} from './agent-tools/plans/rubric-template';
import { classifyToolError } from './harness/improvements/tool-error-classifier';

const LONG_DRILL =
  `${REPLICATION_DRILL_MARKER} — full end-to-end procedure: create two SYNTHETIC work items, ` +
  'park them on a dead holder id, author the drill plan, spawn a headless subject with the ' +
  'verbatim neutral brief, then grade via the tool_invocations SQL and clean up the fixtures. ' +
  'Repeat lines to exceed the shrink-guard floor. '.repeat(4);

const crit = (over: Partial<RubricCriterion> & { key: string }): RubricCriterion => ({
  title: `Criterion ${over.key}`,
  model: 'How this is supposed to work.',
  method: 'How to investigate it.',
  driftMarkers: 'What broken looks like.',
  ...over,
});

const rubric = (criteria: RubricCriterion[], over: Partial<Rubric> = {}): Rubric => ({
  gradingAuthority: 'independent',
  rubricId: 'su-agent-behavior',
  workspaceId: 'default',
  kind: 'standard',
  characteristic: 'su-behavior',
  title: 'SU agent behavior',
  description: 'test fixture',
  criteria,
  ratingScale: ['pass', 'partial', 'fail', 'unknown'],
  methodRef: 'su-agent-behavior',
  status: 'active',
  createdBy: 'su-1',
  proposedBy: 'su-1',
  ratifiedBy: 'su-1',
  createdAt: '2026-07-12',
  updatedAt: '2026-07-12T00:00:00.000Z',
  ...over,
});

const proposal = (criteria: RubricCriterion[], over: Partial<ProposeRubricInput> = {}): ProposeRubricInput => ({
  rubricId: 'su-agent-behavior',
  characteristic: 'su-behavior',
  title: 'SU agent behavior',
  criteria,
  ...over,
});

describe('assertNoSilentRubricLoss (WI-4287 propose loss-guard)', () => {
  it('EI-21268788942647452: malformed rubric data classifies as caller input, not structural', async () => {
    let thrown: unknown;
    try {
      await proposeRubric({
        rubricId: 'acceptance-with-release-gate',
        kind: 'acceptance',
        subjectPlan: 'some-plan',
        characteristic: 'acceptance',
        title: 'Acceptance rubric',
        criteria: [crit({ key: 'outcome', instrumentKey: 'acceptance-outcome' })],
        releaseGating: true,
        by: 'author-a',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('releaseGating is standard-kind only');
    expect(classifyToolError(undefined, 'handler_error', message)).toBe('caller');
  });

  it('a brand-new rubric (stored=null) always passes — the seeder/new-propose path', () => {
    expect(() => assertNoSilentRubricLoss(null, proposal([crit({ key: 'a' })]))).not.toThrow();
  });

  it('an identical re-propose passes (idempotent upsert stays idempotent)', () => {
    const c = [crit({ key: 'a', method: LONG_DRILL }), crit({ key: 'b' })];
    expect(() => assertNoSilentRubricLoss(rubric(c), proposal(c))).not.toThrow();
  });

  it('ADDING a criterion passes (superset never loses content)', () => {
    const stored = rubric([crit({ key: 'a' })]);
    expect(() =>
      assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' }), crit({ key: 'new' })])),
    ).not.toThrow();
  });

  it('dropping a stored criterion WITHOUT a dropKeys ack throws, naming the key and the fix', () => {
    const stored = rubric([crit({ key: 'a' }), crit({ key: 'batched-tool-calls' })]);
    expect(() => assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' })]))).toThrowError(
      /SILENTLY LOSE[\s\S]*'batched-tool-calls'[\s\S]*dropKeys/,
    );
  });

  it('EI-10148: the loss-guard rejection classifies as `caller`, not `structural` (no spurious auto-implement EI)', () => {
    const stored = rubric([crit({ key: 'a' }), crit({ key: 'batched-tool-calls' })]);
    let thrown: unknown;
    try {
      assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' })]));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    // The teaching content is preserved (the caller still learns the fix)...
    expect(msg).toMatch(/SILENTLY LOSE[\s\S]*dropKeys/);
    // ...but it now carries the `invalid_args:` caller convention, so the tool-error
    // watchdog classifies it `caller` (DX/schema) instead of the `structural` default —
    // the loss-guard is a caller-input rejection, NOT a tool bug for the auto-implement lane.
    expect(classifyToolError(undefined, 'handler_error', msg)).toBe('caller');
  });

  it('dropping a stored criterion WITH the dropKeys ack passes', () => {
    const stored = rubric([crit({ key: 'a' }), crit({ key: 'b' })]);
    expect(() =>
      assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' })], { dropKeys: ['b'] })),
    ).not.toThrow();
  });

  it('a >40% shrink of a long method throws with the before/after char counts', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    const gutted = proposal([crit({ key: 'a', method: `${REPLICATION_DRILL_MARKER}: see docs.` })]);
    expect(() => assertNoSilentRubricLoss(stored, gutted)).toThrowError(
      /criterion 'a' procedure text[\s\S]*chars[\s\S]*allowMethodShrink/,
    );
  });

  it('losing the REPLICATION DRILL marker throws even when the text stays long', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    // Same length, marker stripped — length guard alone would pass; marker guard must not.
    const stripped = LONG_DRILL.replaceAll(REPLICATION_DRILL_MARKER, 'procedure notes');
    expect(() =>
      assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a', method: stripped })])),
    ).toThrowError(/LOSES its 'REPLICATION DRILL'/);
  });

  it('allowMethodShrink WITHOUT a shrinkReason still throws (a conscious edit must be explained)', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    const gutted = proposal([crit({ key: 'a', method: 'short now' })], { allowMethodShrink: true });
    expect(() => assertNoSilentRubricLoss(stored, gutted)).toThrowError(/shrinkReason/);
  });

  it('allowMethodShrink + shrinkReason passes (the explicit override)', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    const gutted = proposal([crit({ key: 'a', method: 'short now' })], {
      allowMethodShrink: true,
      shrinkReason: 'drill moved to the shared runbook; method now points at it',
    });
    expect(() => assertNoSilentRubricLoss(stored, gutted)).not.toThrow();
  });

  it('P-011: dropping a stored structured check throws (deterministic enforcement must not silently revert to fuzzy)', () => {
    const stored = rubric([
      crit({ key: 'a', check: { kind: 'tests', files: ['packages/x/a.test.ts'] } }),
    ]);
    expect(() => assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a' })]))).toThrowError(
      /LOSES its structured tests check/,
    );
    // the ack path: a conscious, explained removal passes (same lever as a procedure shrink).
    expect(() =>
      assertNoSilentRubricLoss(
        stored,
        proposal([crit({ key: 'a' })], { allowMethodShrink: true, shrinkReason: 'check retired with the suite' }),
      ),
    ).not.toThrow();
    // CONTROL: resubmitting the check unchanged (or changed — a visible edit) passes unguarded.
    expect(() =>
      assertNoSilentRubricLoss(
        stored,
        proposal([crit({ key: 'a', check: { kind: 'tests', files: ['packages/x/b.test.ts'] } })]),
      ),
    ).not.toThrow();
  });

  it('MOVING the drill from .method into .replication passes — combined text is what is compared (D-002)', () => {
    const stored = rubric([crit({ key: 'a', method: LONG_DRILL })]);
    const moved = proposal([
      crit({ key: 'a', method: 'Drill lives in this criterion’s replication field.', replication: LONG_DRILL }),
    ]);
    expect(() => assertNoSilentRubricLoss(stored, moved)).not.toThrow();
  });

  it('rewording a SHORT method (under the guard floor, no marker) passes — no noise on small edits', () => {
    const short = 'Check the ledger for stalls.';
    expect(short.length).toBeLessThan(METHOD_SHRINK_GUARD_MIN_CHARS);
    const stored = rubric([crit({ key: 'a', method: short })]);
    expect(() => assertNoSilentRubricLoss(stored, proposal([crit({ key: 'a', method: 'Check it.' })]))).not.toThrow();
  });
});

describe('rubricCompleteness (WI-4287 per-aspect procedure report)', () => {
  it('complete when every criterion carries a procedure and methodRef is set', () => {
    const r = rubric([
      crit({ key: 'a', replication: 'fixtures → prompt → grade → cleanup' }),
      crit({ key: 'b', method: `${LONG_DRILL}` }), // marker embedded in method also counts
    ]);
    const c = rubricCompleteness(r);
    expect(c.complete).toBe(true);
    expect(c.criteriaWithoutReplication).toEqual([]);
    expect(c.methodRefMissing).toBe(false);
    expect(c.note).toBeUndefined();
  });

  it('lists criteria lacking any procedure and flags a missing methodRef, with a teaching note', () => {
    const r = rubric([crit({ key: 'bare' }), crit({ key: 'ok', replication: 'the drill' })], {
      methodRef: null,
    });
    const c = rubricCompleteness(r);
    expect(c.complete).toBe(false);
    expect(c.criteriaWithoutReplication).toEqual(['bare']);
    expect(c.methodRefMissing).toBe(true);
    expect(c.note).toMatch(/bare/);
    expect(c.note).toMatch(/methodRef/);
  });

  it('release-gating rubrics report missing and duplicate instrument bindings', () => {
    const r = rubric(
      [
        crit({ key: 'missing' }),
        crit({ key: 'a', instrumentKey: 'shared' }),
        crit({ key: 'b', model: 'legacy binding [instrumentKey: shared]' }),
      ],
      { releaseGating: true },
    );
    const c = rubricCompleteness(r);
    expect(c.criteriaWithoutInstrument).toEqual(['missing']);
    expect(c.duplicateInstrumentKeys).toEqual(['shared']);
    expect(c.complete).toBe(false);
  });
});

describe('criterion `replication` field end-to-end (schema + plan-row mapping)', () => {
  const baseCrit = {
    key: 'a',
    title: 'A',
    model: 'm',
    method: 'how',
    driftMarkers: 'bad',
  };

  it('rubricCriterionSchema accepts an optional replication string and stays strict on unknowns', () => {
    expect(rubricCriterionSchema.safeParse({ ...baseCrit, replication: 'the drill' }).success).toBe(true);
    expect(rubricCriterionSchema.safeParse(baseCrit).success).toBe(true);
    expect(rubricCriterionSchema.safeParse({ ...baseCrit, replication: '' }).success).toBe(false);
    expect(rubricCriterionSchema.safeParse({ ...baseCrit, replicatoin: 'typo' }).success).toBe(false);
  });

  it('rubricCriterionSchema accepts a structured instrumentKey', () => {
    expect(rubricCriterionSchema.safeParse({ ...baseCrit, instrumentKey: 'blender:success-metrics.cycleErrorRate' }).success).toBe(true);
    expect(rubricCriterionSchema.safeParse({ ...baseCrit, instrumentKey: '' }).success).toBe(false);
  });

  it('planRowToRubric passes replication through (and omits it when absent)', () => {
    const row = {
      plan_slug: 'r1',
      workspace_id: 'default',
      harness_slug: 'papercusp',
      title: 'R1',
      status: 'active' as string | null,
      created: '2026-07-12',
      updated: '2026-07-12',
      updated_at: '2026-07-12T00:00:00.000Z',
      owner: 'su-1',
      archived: false,
      template_data: {
        characteristic: 'c',
        criteria: [{ ...baseCrit, replication: 'the drill' }, { ...baseCrit, key: 'b' }],
        ratingScale: ['healthy', 'unknown'],
      },
    };
    expect(rubricTemplateDataSchema.safeParse(row.template_data).success).toBe(true);
    const mapped = planRowToRubric(row);
    expect(mapped).not.toBeNull();
    expect(mapped?.criteria[0]?.replication).toBe('the drill');
    expect(mapped?.criteria[1]).not.toHaveProperty('replication');
  });
});

describe('legacy acceptance successor compatibility normalization (EI-22056951528892875)', () => {
  it('preserves a canonical omitted METHOD without accepting an explicitly blank amendment', () => {
    const canonical: ProposeRubricCriterion = {
      key: 'current', title: 'Current BAR', barKey: 'R-1',
      model: 'The current outcome survives the amendment.',
      driftMarkers: 'The current outcome is absent after the amendment.',
      requiredScope: ['current'], evidencePlane: 'tree',
    };
    const stored = rubric([crit({ ...canonical, method: '' })], {
      kind: 'acceptance', subjectPlan: 'current-bar',
    });
    const validate = (input: Parameters<typeof applyRubricAmendment>[1]) => {
      const amended = applyRubricAmendment(stored, input, [canonical]);
      const normalized = normalizeAcceptanceRubricProposal(amended.criteria, 'acceptance', stored.ratingScale);
      return {
        criteria: normalized.criteria,
        parsed: rubricTemplateDataAuthoringSchema.safeParse({
          kind: 'acceptance', subjectPlan: 'current-bar', characteristic: 'current',
          criteria: normalized.criteria, ratingScale: normalized.ratingScale,
        }),
      };
    };
    const unchanged = validate({ rubricId: stored.rubricId, classRef: 'plan-class-feature-ship' });
    expect(unchanged.criteria[0]).not.toHaveProperty('method');
    expect(unchanged.parsed.success).toBe(true);
    for (const input of [
      { rubricId: stored.rubricId, criteria: [{ ...canonical, method: '' }] },
      { rubricId: stored.rubricId, criterion: {
        key: 'current', field: 'method' as const, mode: 'replace' as const, text: '',
      } },
    ]) {
      const explicit = validate(input);
      expect(explicit.criteria[0]?.method).toBe('');
      expect(explicit.parsed.success).toBe(false);
      if (!explicit.parsed.success) {
        expect(explicit.parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('criteria.0.method');
      }
    }
  });

  it('preserves invalid current BAR observables and falsifiers for authoring rejection', () => {
    const criterion = {
      key: 'current', title: 'Current BAR', barKey: 'R-1',
      model: '', method: '', driftMarkers: '', requiredScope: ['current'], evidencePlane: 'tree' as const,
    };
    const normalized = normalizeAcceptanceRubricProposal([criterion], 'acceptance', ['pass', 'fail', 'unknown']);
    expect(normalized.criteria[0]).toMatchObject({ model: '', method: '', driftMarkers: '' });
    expect(normalized.compatibility).toBeUndefined();
    const parsed = rubricTemplateDataAuthoringSchema.safeParse({
      kind: 'acceptance', subjectPlan: 'current-bar', characteristic: 'current',
      criteria: normalized.criteria, ratingScale: normalized.ratingScale,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['criteria.0.model', 'criteria.0.method', 'criteria.0.driftMarkers']));
    }
  });

  it('upgrades projected blanks and an old scale without changing the legacy input', () => {
    const legacyCriteria: ProposeRubricCriterion[] = [
      { key: 'outcome', title: 'Outcome', model: '', method: '   ', driftMarkers: '' },
      { key: 'native', title: 'Native criterion', driftMarkers: 'native regression marker' },
    ];
    const legacyScale = ['fail', 'weak', 'adequate', 'strong'];

    const normalized = normalizeAcceptanceRubricProposal(legacyCriteria, 'acceptance', legacyScale);

    expect(normalized.criteria[0]).toMatchObject({
      key: 'outcome',
      title: 'Outcome',
      driftMarkers: expect.stringContaining("Legacy acceptance criterion 'outcome'"),
    });
    expect(normalized.criteria[0]).not.toHaveProperty('model');
    expect(normalized.criteria[0]).not.toHaveProperty('method');
    expect(normalized.criteria[1]).toEqual(legacyCriteria[1]);
    expect(normalized.ratingScale).toEqual([...legacyScale, 'unknown']);
    expect(
      rubricTemplateDataAuthoringSchema.safeParse({
        kind: 'acceptance',
        subjectPlan: 'legacy-successor-subject',
        characteristic: 'legacy-successor',
        criteria: normalized.criteria,
        ratingScale: normalized.ratingScale,
      }).success,
    ).toBe(true);
    expect(normalized.compatibility).toMatchObject({
      source: 'legacy-acceptance-read-projection',
      upgrades: expect.arrayContaining([
        expect.objectContaining({ field: 'criteria[0].model', action: 'omit-empty' }),
        expect.objectContaining({ field: 'criteria[0].method', action: 'omit-empty' }),
        expect.objectContaining({ field: 'criteria[0].driftMarkers', action: 'supply-falsifier' }),
        expect.objectContaining({
          field: 'ratingScale',
          action: 'append-unknown-equivalent',
          value: 'unknown',
        }),
      ]),
    });
    expect(legacyCriteria[0]).toEqual({
      key: 'outcome',
      title: 'Outcome',
      model: '',
      method: '   ',
      driftMarkers: '',
    });
    expect(legacyScale).toEqual(['fail', 'weak', 'adequate', 'strong']);
  });

  it('does not rewrite standard rubrics or current acceptance vocabularies', () => {
    const currentCriteria: ProposeRubricCriterion[] = [
      { key: 'outcome', title: 'Outcome', driftMarkers: 'outcome regresses' },
    ];
    expect(normalizeAcceptanceRubricProposal(currentCriteria, 'acceptance', ['healthy', 'degraded', 'broken', 'unknown'])).toEqual({
      criteria: currentCriteria,
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
    });
    expect(normalizeAcceptanceRubricProposal(currentCriteria, 'standard', ['pass', 'partial', 'fail'])).toEqual({
      criteria: currentCriteria,
      ratingScale: ['pass', 'partial', 'fail'],
    });
  });
});

describe('canonical acceptance BAR metadata (requirements-with-teeth P-001)', () => {
  const bar = {
    key: 'activation-outcome',
    title: 'Coverage activation exists',
    bar: 'The activation path produces coverage evidence.',
    driftMarkers: 'No coverage-evidence row exists for the activation path.',
    barKey: 'R-7',
    role: 'outcome' as const,
    mandatory: true,
    requiredScope: ['surface:coverage-row', 'cohort:post-epoch', 'surface:coverage-row'],
    passRatings: ['PASS', 'healthy', 'pass'],
    coversBarKeys: ['R-7'],
    barHash: '0'.repeat(64),
  };

  it('canonicalizes the wire alias into model, normalizes sets, and replaces a caller hash', () => {
    const normalized = normalizeAcceptanceBarCriterion(bar);

    expect(normalized).toMatchObject({
      model: bar.bar,
      barKey: 'R-7',
      role: 'outcome',
      mandatory: true,
      requiredScope: ['cohort:post-epoch', 'surface:coverage-row'],
      passRatings: ['healthy', 'pass'],
      coversBarKeys: ['R-7'],
      barHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(normalized).not.toHaveProperty('bar');
    expect(normalized.barHash).not.toBe(bar.barHash);
    expect(normalized.barHash).toBe(computeAcceptanceBarHash(normalized));
  });

  it('binds every declared semantic dimension while ignoring set order and duplicates', () => {
    const baseHash = computeAcceptanceBarHash(bar);
    expect(
      computeAcceptanceBarHash({
        ...bar,
        requiredScope: ['cohort:post-epoch', 'surface:coverage-row'],
        passRatings: ['healthy', 'pass'],
      }),
    ).toBe(baseHash);

    const changes: Array<Partial<ProposeRubricCriterion>> = [
      { key: 'other-key' },
      { barKey: 'R-8' },
      { bar: 'The activation path produces a different outcome.' },
      { driftMarkers: 'A different falsifier.' },
      { requiredScope: ['surface:other'] },
      { role: 'disclosure' },
      { mandatory: false },
      { passRatings: ['exceptional'] },
      { coversBarKeys: ['R-8'] },
    ];
    for (const change of changes) {
      expect(computeAcceptanceBarHash({ ...bar, ...change })).not.toBe(baseHash);
    }
  });

  it('binds structured check content, including a changed tests-check file', () => {
    const checked = {
      ...bar,
      check: { kind: 'tests' as const, files: ['packages/x/a.test.ts'] },
    };
    const reorderedKeys = {
      ...bar,
      check: { files: ['packages/x/a.test.ts'], kind: 'tests' as const },
    };
    expect(computeAcceptanceBarHash(checked)).toBe(computeAcceptanceBarHash(reorderedKeys));
    expect(
      computeAcceptanceBarHash({
        ...checked,
        check: { kind: 'tests', files: ['packages/x/b.test.ts'] },
      }),
    ).not.toBe(computeAcceptanceBarHash(checked));
  });

  it('refuses two competing BAR texts instead of choosing a hidden winner', () => {
    expect(() =>
      normalizeAcceptanceBarCriterion({
        ...bar,
        model: 'Canonical model text.',
        bar: 'Different alias text.',
      }),
    ).toThrow(/conflicting model and bar text.*model.*canonical/i);
  });
});

// ─── rubric-system-hardening-2026-07-14 P-001/P-004 (EI-12146/EI-12149) ───────────────
// releaseGating + the structured criterion window ride template_data end-to-end: the
// schema accepts them, planRowToRubric projects them, and the AMENDMENT path carries
// them — dropping either on a re-write is the WI-4287 loss class (a silently un-gated
// release rubric / a criterion silently back on the hardcoded window).
describe('releaseGating + criterion window end-to-end (EI-12146/EI-12149)', () => {
  it('rubricTemplateDataSchema accepts releaseGating and stays strict on unknowns', () => {
    const data = {
      characteristic: 'c',
      criteria: [crit({ key: 'a' })],
      ratingScale: ['pass', 'fail', 'unknown'],
      releaseGating: true,
    };
    expect(rubricTemplateDataSchema.safeParse(data).success).toBe(true);
    expect(rubricTemplateDataSchema.safeParse({ ...data, releaseGatting: true }).success).toBe(false);
  });

  it('planRowToRubric projects releaseGating + criterion window (and omits them when absent)', () => {
    const row = {
      plan_slug: 'r1',
      workspace_id: 'default',
      harness_slug: 'papercusp',
      title: 'R1',
      status: 'active' as string | null,
      created: '2026-07-14',
      updated: '2026-07-14',
      updated_at: '2026-07-14T00:00:00.000Z',
      owner: 'su-1',
      archived: false,
      template_data: {
        characteristic: 'c',
        criteria: [
          {
            key: 'cycle-error-rate',
            title: 'A',
            model: 'm',
            method: 'how',
            driftMarkers: 'bad',
            window: { kind: 'post-watermark', watermarkRef: 'bg-host-restart' },
          },
          { key: 'b', title: 'B', model: 'm', method: 'how', driftMarkers: 'bad' },
        ],
        ratingScale: ['healthy', 'unknown'],
        releaseGating: true,
      },
    };
    const mapped = planRowToRubric(row);
    expect(mapped?.releaseGating).toBe(true);
    expect(mapped?.criteria[0]?.window).toEqual({ kind: 'post-watermark', watermarkRef: 'bg-host-restart' });
    expect(mapped?.criteria[1]).not.toHaveProperty('window');
    const unmarked = planRowToRubric({
      ...row,
      template_data: { ...row.template_data, releaseGating: undefined },
    });
    expect(unmarked).not.toBeNull();
    expect(unmarked).not.toHaveProperty('releaseGating');
  });
});

// ─── rubric-system-improvements-2026-07-12 P-003: the small-amendment path ────────────
// applyRubricAmendment is the pure core of rubrics:amend — patch one criterion field /
// methodRef and shape the whole-doc ProposeRubricInput (status preserved, guards
// inherited downstream by proposeRubric's assertNoSilentRubricLoss).
describe('applyRubricAmendment kind round-trip (acceptance-rubrics-on-every-plan-2026-08-11)', () => {
  it('binds a missing acceptance class without losing BARs, checks, lifecycle or authorship', () => {
    const stored = rubric([crit({ key: 'r-1', check: { kind: 'tests', files: ['guard.test.ts'] } })], {
      kind: 'acceptance',
      subjectPlan: 'grading-study',
      status: 'active',
      barSetHash: 'a'.repeat(64),
      barContract: {
        schemaVersion: 1,
        adoptionEpoch: 2,
        cohort: 'post-epoch',
        subjectPlanRevision: 4,
        seededAt: '2026-09-06T16:59:00.000Z',
        seededBy: 'original-author',
      },
    });
    const out = applyRubricAmendment(stored, {
      rubricId: stored.rubricId,
      classRef: ' plan-class-investigation ',
    });
    expect(out.classRef).toBe('plan-class-investigation');
    expect(out.criteria).toEqual(stored.criteria);
    expect(out.barSetHash).toBe(stored.barSetHash);
    expect(out.barContract).toEqual(stored.barContract);
    expect(out.subjectPlan).toBe(stored.subjectPlan);
    expect(out.status).toBe(stored.status);
    expect(out.by).toBe(stored.createdBy);
    expect(() => assertNoSilentRubricLoss(stored, out)).not.toThrow();
  });

  it('allows the same acceptance class but refuses a replacement', () => {
    const stored = rubric([crit({ key: 'k1' })], {
      kind: 'acceptance', subjectPlan: 'grading-study', classRef: 'plan-class-bugfix',
    });
    expect(applyRubricAmendment(stored, {
      rubricId: stored.rubricId, classRef: 'plan-class-bugfix',
    }).classRef).toBe('plan-class-bugfix');
    expect(() => applyRubricAmendment(stored, {
      rubricId: stored.rubricId, classRef: 'plan-class-investigation',
    })).toThrow(/existing acceptance class cannot be replaced/);
  });

  it('refuses a class binding on a standard rubric and refuses an empty reference', () => {
    const standard = rubric([crit({ key: 'k1' })]);
    expect(() => applyRubricAmendment(standard, {
      rubricId: standard.rubricId, classRef: 'plan-class-investigation',
    })).toThrow(/requires an acceptance rubric/);
    expect(() => applyRubricAmendment({ ...standard, kind: 'acceptance' }, {
      rubricId: standard.rubricId, classRef: '   ',
    })).toThrow(/non-empty class reference/);
  });

  it.each(['plan-class-investigation', 'plan-class-general'])(
    'strengthens %s to shipment while retaining adopted BARs and prior standards',
    (priorClass) => {
      const stored = rubric([crit({ key: 'r-1', check: { kind: 'tests', files: ['guard.test.ts'] } })], {
        kind: 'acceptance', subjectPlan: 'hybrid-pool', classRef: priorClass,
        status: 'active', composes: ['prior-standard'], barSetHash: 'a'.repeat(64),
        barContract: {
          schemaVersion: 1, adoptionEpoch: 2, cohort: 'post-epoch', subjectPlanRevision: 230,
          seededAt: '2026-09-06T16:59:00.000Z', seededBy: 'original-author',
        },
      });
      const out = applyRubricAmendment(stored, {
        rubricId: stored.rubricId, classRef: 'plan-class-feature-ship',
        reason: 'The investigation now includes customer implementation and verified shipment.',
        composes: ['new-standard', 'prior-standard'],
      });
      expect(out.classRef).toBe('plan-class-feature-ship');
      expect(out.composes).toEqual(['prior-standard', 'new-standard', priorClass]);
      expect(out.criteria).toEqual(stored.criteria);
      expect(out.barSetHash).toBe(stored.barSetHash);
      expect(out.barContract).toEqual(stored.barContract);
      expect(out.status).toBe(stored.status);
      expect(out.by).toBe(stored.createdBy);
      expect(() => assertNoSilentRubricLoss(stored, out)).not.toThrow();
    },
  );

  it('refuses an unexplained promotion, unknown target, or downgrade even with a reason', () => {
    const stored = rubric([crit({ key: 'r-1' })], {
      kind: 'acceptance', subjectPlan: 'hybrid-pool', classRef: 'plan-class-investigation',
    });
    for (const reason of [undefined, '   ']) {
      expect(() => applyRubricAmendment(stored, {
        rubricId: stored.rubricId, classRef: 'plan-class-feature-ship', reason,
      })).toThrow(/non-empty reason/);
    }
    for (const [prior, next] of [
      ['plan-class-investigation', 'unregistered-class'],
      ['plan-class-feature-ship', 'plan-class-investigation'],
      ['plan-class-bugfix', 'plan-class-feature-ship'],
    ]) {
      expect(() => applyRubricAmendment({ ...stored, classRef: prior }, {
        rubricId: stored.rubricId, classRef: next, reason: 'Change the profile.',
      })).toThrow(/existing acceptance class cannot be replaced/);
    }
    expect(applyRubricAmendment(stored, {
      rubricId: stored.rubricId, classRef: 'plan-class-feature-ship', reason: 'Ship the implementation.',
    }).composes).toEqual(['plan-class-investigation']);
  });

  it('carries kind/subjectPlan/classRef through an amendment (identity fields, WI-4287 loss class)', () => {
    const stored = rubric([crit({ key: 'k1' })], {
      kind: 'acceptance',
      subjectPlan: 'some-plan-2026-08-11',
      classRef: 'plan-class-bugfix',
      status: 'active',
    });
    const out = applyRubricAmendment(stored, { rubricId: stored.rubricId, methodRef: 'some-runbook' });
    expect(out).toMatchObject({
      kind: 'acceptance',
      subjectPlan: 'some-plan-2026-08-11',
      classRef: 'plan-class-bugfix',
    });
  });

  it('a standard rubric emits NO kind field (absent = standard, pre-kind rows byte-stable)', () => {
    const out = applyRubricAmendment(rubric([crit({ key: 'k1' })]), {
      rubricId: 'su-agent-behavior',
      methodRef: 'some-runbook',
    });
    expect('kind' in out).toBe(false);
    expect('subjectPlan' in out).toBe(false);
  });

  it('preserves unpinned composition refs through a prose amendment', () => {
    const stored = rubric([crit({ key: 'k1' })], {
      composes: ['goal-mode-e2e', 'pot-coordination-health'],
    });
    const out = applyRubricAmendment(stored, { rubricId: stored.rubricId, methodRef: 'updated-runbook' });
    expect(out.composes).toEqual(['goal-mode-e2e', 'pot-coordination-health']);
  });

  it('normalizes an explicit composition replacement without revision pins', () => {
    expect(normalizeRubricCompositionRefs([' goal-mode-e2e ', 'goal-mode-e2e', 'pot-coordination-health'])).toEqual([
      'goal-mode-e2e',
      'pot-coordination-health',
    ]);
    const out = applyRubricAmendment(rubric([crit({ key: 'k1' })]), {
      rubricId: 'su-agent-behavior',
      composes: [' goal-mode-e2e ', 'goal-mode-e2e'],
    });
    expect(out.composes).toEqual(['goal-mode-e2e']);
  });
});

describe('applyRubricAmendment (rubrics:amend pure core)', () => {
  const stored = () =>
    rubric([
      crit({ key: 'placement', replication: LONG_DRILL }),
      crit({ key: 'wake' }),
    ]);

  it('an amendment CARRIES releaseGating + criterion windows — never silently un-gates (EI-12149)', () => {
    const gated = rubric([
      crit({ key: 'placement', window: { kind: 'rolling', ms: 3_600_000 } }),
      crit({ key: 'wake' }),
    ], { releaseGating: true });
    const out = applyRubricAmendment(gated, {
      rubricId: 'su-agent-behavior',
      criterion: { key: 'wake', field: 'method', mode: 'append', text: 'also check X' },
    });
    expect(out.releaseGating).toBe(true);
    expect(out.criteria.find((c) => c.key === 'placement')?.window).toEqual({ kind: 'rolling', ms: 3_600_000 });
    // ...and an un-gated rubric stays un-gated (no manufactured field).
    expect(
      applyRubricAmendment(stored(), { rubricId: 'su-agent-behavior', methodRef: 'x' }),
    ).not.toHaveProperty('releaseGating');
  });

  it('append adds a paragraph to the field, keeps every other criterion, and PRESERVES status', () => {
    const out = applyRubricAmendment(stored(), {
      rubricId: 'su-agent-behavior',
      criterion: { key: 'placement', field: 'replication', mode: 'append', text: 'LIVE-AGENT VARIANT: …' },
    });
    const patched = out.criteria.find((c) => c.key === 'placement')!;
    expect(patched.replication).toBe(`${LONG_DRILL}\n\nLIVE-AGENT VARIANT: …`);
    expect(out.criteria.find((c) => c.key === 'wake')).toEqual(stored().criteria[1]); // untouched
    expect(out.status).toBe('active'); // amending never demotes
    expect(out.criteria).toHaveLength(2); // whole doc shaped → no dropKeys needed
  });

  it('append onto an ABSENT optional field creates it (no leading separator)', () => {
    const out = applyRubricAmendment(stored(), {
      rubricId: 'su-agent-behavior',
      criterion: { key: 'wake', field: 'replication', mode: 'replace', text: 'new drill' },
    });
    expect(out.criteria.find((c) => c.key === 'wake')!.replication).toBe('new drill');
    const appended = applyRubricAmendment(stored(), {
      rubricId: 'su-agent-behavior',
      criterion: { key: 'wake', field: 'replication', mode: 'append', text: 'first drill text' },
    });
    expect(appended.criteria.find((c) => c.key === 'wake')!.replication).toBe('first drill text');
  });

  it('replace swaps the field verbatim and passes the shrink-guard acks through', () => {
    const out = applyRubricAmendment(stored(), {
      rubricId: 'su-agent-behavior',
      criterion: { key: 'placement', field: 'model', mode: 'replace', text: 'the corrected model' },
      allowMethodShrink: true,
      shrinkReason: 'procedure moved to the runbook',
    });
    expect(out.criteria.find((c) => c.key === 'placement')!.model).toBe('the corrected model');
    expect(out.allowMethodShrink).toBe(true);
    expect(out.shrinkReason).toBe('procedure moved to the runbook');
  });

  it('model-only acceptance amendments drop stale BAR read aliases before normalization', () => {
    const existing = rubric(
      [
        crit({
          key: 'r-1',
          model: 'The old acceptance promise.',
          bar: 'The old acceptance promise.',
          barHash: 'a'.repeat(64),
          barKey: 'R-1',
          role: 'outcome',
          mandatory: true,
          requiredScope: ['tree'],
          evidencePlane: 'tree',
          passRatings: ['healthy'],
        }),
      ],
      { kind: 'acceptance', subjectPlan: 'subject-plan' },
    );
    const out = applyRubricAmendment(existing, {
      rubricId: existing.rubricId,
      criterion: {
        key: 'r-1',
        field: 'model',
        mode: 'replace',
        text: 'The corrected acceptance promise.',
      },
    });
    const patched = out.criteria[0]!;

    expect(patched.model).toBe('The corrected acceptance promise.');
    expect(patched).not.toHaveProperty('bar');
    expect(patched).not.toHaveProperty('barHash');
    expect(() => normalizeAcceptanceBarCriterion(patched)).not.toThrow();
    expect(normalizeAcceptanceBarCriterion(patched).barHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('acceptance amendments resolve the displayed barKey as a criterion target alias', () => {
    const existing = rubric(
      [
        crit({
          key: 'r-1',
          barKey: 'R-1',
          model: 'The outcome is true.',
          role: 'outcome',
          mandatory: true,
          requiredScope: ['tree'],
          evidencePlane: 'tree',
          passRatings: ['healthy'],
        }),
      ],
      { kind: 'acceptance', subjectPlan: 'subject-plan' },
    );

    const prose = applyRubricAmendment(existing, {
      rubricId: existing.rubricId,
      criterion: { key: 'R-1', field: 'method', mode: 'append', text: 'Also inspect the retry log.' },
    });
    expect(prose.criteria[0]?.method).toContain('Also inspect the retry log.');

    const requirement = applyRubricAmendment(existing, {
      rubricId: existing.rubricId,
      requirement: { key: 'R-1', acceptance: { condition: 'The corrected outcome is true.' } },
    });
    expect(requirement.criteria[0]?.model).toBe('The corrected outcome is true.');

    const classified = applyRubricAmendment(existing, {
      rubricId: existing.rubricId,
      criterionClass: { key: 'R-1', class: 'violatable' },
    });
    expect(classified.criteria[0]?.criterionClass).toBe('violatable');

    const replanned = applyRubricAmendment(existing, {
      rubricId: existing.rubricId,
      criterionEvidencePlane: { key: 'R-1', evidencePlane: 'deployed' },
    });
    expect(replanned.criteria[0]).toMatchObject({
      evidencePlane: 'deployed',
      requiredScope: ['deployed'],
    });
  });

  it('re-derives the evidence-plane requiredScope token without dropping other scope entries', () => {
    const existing = rubric(
      [
        crit({
          key: 'r-1',
          barKey: 'R-1',
          role: 'outcome',
          mandatory: true,
          requiredScope: ['tree', 'cohort:post-epoch'],
          evidencePlane: 'tree',
          passRatings: ['healthy'],
        }),
      ],
      { kind: 'acceptance', subjectPlan: 'subject-plan' },
    );
    const out = applyRubricAmendment(existing, {
      rubricId: existing.rubricId,
      criterionEvidencePlane: { key: 'r-1', evidencePlane: 'deployed' },
    });

    expect(out.criteria[0]).toMatchObject({
      evidencePlane: 'deployed',
      requiredScope: ['deployed', 'cohort:post-epoch'],
    });
  });

  it('methodRef-only amendment keeps criteria byte-identical', () => {
    const out = applyRubricAmendment(stored(), { rubricId: 'su-agent-behavior', methodRef: 'su-agent-behavior-grading-runbook' });
    expect(out.methodRef).toBe('su-agent-behavior-grading-runbook');
    expect(out.criteria).toEqual(stored().criteria);
  });

  it('replaces a complete acceptance criterion set so checks and a declared BAR can land atomically', () => {
    const existing = rubric([crit({ key: 'r-1', barKey: 'R-1', role: 'outcome', mandatory: true })], {
      kind: 'acceptance',
      subjectPlan: 'subject-plan',
      status: 'active',
    });
    const replacement = [
      { ...existing.criteria[0]!, check: { kind: 'tests' as const, files: ['r-1.test.ts'] } },
      crit({
        key: 'r-2',
        barKey: 'R-2',
        role: 'outcome',
        mandatory: true,
        check: { kind: 'instrument', instrumentKey: 'none' },
      }),
    ];
    const out = applyRubricAmendment(existing, {
      rubricId: existing.rubricId,
      criteria: replacement,
    });
    expect(out.criteria).toEqual(replacement);
    expect(out.status).toBe('active');
    expect(out.subjectPlan).toBe('subject-plan');
  });

  it('keeps complete-set replacement acceptance-only and mutually exclusive with a patch', () => {
    expect(() =>
      applyRubricAmendment(stored(), {
        rubricId: 'su-agent-behavior',
        criteria: stored().criteria,
      }),
    ).toThrow(/acceptance-kind only/);
    const acceptance = rubric([crit({ key: 'r-1' })], {
      kind: 'acceptance',
      subjectPlan: 'subject-plan',
    });
    expect(() =>
      applyRubricAmendment(acceptance, {
        rubricId: acceptance.rubricId,
        criteria: acceptance.criteria,
        criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'extra' },
      }),
    ).toThrow(/cannot be combined/);
  });

  it('an amendment shaped for proposeRubric passes the loss-guard (all criteria present)', () => {
    const out = applyRubricAmendment(stored(), {
      rubricId: 'su-agent-behavior',
      criterion: { key: 'placement', field: 'replication', mode: 'append', text: 'more procedure' },
    });
    expect(() => assertNoSilentRubricLoss(stored(), out)).not.toThrow();
  });

  it('teaching errors: unknown criterion key (names the valid keys) and empty amendment', () => {
    expect(() =>
      applyRubricAmendment(stored(), {
        rubricId: 'su-agent-behavior',
        criterion: { key: 'typo-key', field: 'model', mode: 'append', text: 'x' },
      }),
    ).toThrow(/no criterion 'typo-key'.*placement, wake/);
    expect(() => applyRubricAmendment(stored(), { rubricId: 'su-agent-behavior' })).toThrow(/nothing to amend/);
  });
});
