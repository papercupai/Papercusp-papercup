import { describe, expect, it } from 'vitest';
import {
  buildAcceptanceBarSeed,
  acceptanceBarTestCitationProblems,
  canSeedAcceptanceBarSuccessor,
  parseBarMappings,
  acceptanceBarProjectedBehavior,
  acceptanceBarBehaviorClass,
  parseRequirementBars,
  validateAcceptanceBarSource,
} from './acceptance-bar-seed';
import { computeAcceptanceBarSetHash, normalizeAcceptanceBarCriterion } from './rubrics';
import { guardAcceptanceBarTemplateDataWrite } from './agent-tools/plans/rubric-loss-guard';
import { rubricCriterionCheckSchema } from './agent-tools/plans/rubric-template';
import type { ItemTypeBar } from './plan-types/item-type-contract';
import { specBehaviorNonAtomicReason } from './agent-tools/plans/spec-clause-compiler';

function plan(opts: { requirements?: string; map?: string } = {}): string {
  return `---
title: Seed target
slug: seed-target
status: draft
created: 2026-09-04
updated: 2026-09-04
---

# Seed target

## Requirements

${opts.requirements ?? `**R-1 — First outcome.** The writer persists one canonical bar.

**R-2 — Runtime outcome.** The live service exposes the current verdict.`}

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
${opts.map ?? `| R-1 | P-001, P-002 | tree |
| R-2 | P-002 | live |`}

## Phase 1 — Build

- **P-001** \`todo\` persist the canonical BAR
- **P-002** \`blocked\` expose the BAR verdict
`;
}

const input = {
  planSlug: 'seed-target',
  actorId: 'su-seeder',
  declaredAt: '2026-09-04T20:00:00.000Z',
  cohort: 'post-epoch' as const,
  adoptionEpoch: 1,
  subjectPlanRevision: 7,
  rubricSlug: 'acceptance-seed-target',
  rubricRevision: 1,
};

describe('activation named-case preflight (EI-26971745324820138)', () => {
  const file = 'packages/operator-core/lib/acceptance-bar-seed.test.ts';
  const testName = 'rejects embedded tags before the direct activation write R5-CONTRACT';
  it('rejects embedded tags before the direct activation write R5-CONTRACT', () => {
    const criterion = (name: string) => [{ key: 'R-5', check: { kind: 'tests' as const, files: [file], testName: name } }];
    expect(acceptanceBarTestCitationProblems(criterion('R5-CONTRACT'))).toEqual([
      expect.objectContaining({ code: 'bar_contract_check_invalid', barKey: 'R-5', detail: expect.stringContaining('matches no maintained case title') }),
    ]);
    expect(acceptanceBarTestCitationProblems(criterion(testName))).toEqual([]);
    expect(acceptanceBarTestCitationProblems(criterion(`activation named-case preflight (EI-26971745324820138) > ${testName}`))).toEqual([]);
  });

  it('activation registers an explicitly planned case extension without relaxing unmarked maintained citations', () => {
    const future = { file, testName: 'future activation contract', plannedReason: 'The plan adds this case to this maintained suite.' };
    const criteria = [{ key: 'R-5', check: { kind: 'tests' as const, files: [file], cases: [future] } }];
    expect(acceptanceBarTestCitationProblems(criteria, undefined, { allowPlannedPaths: true })).toEqual([]);
    expect(acceptanceBarTestCitationProblems(criteria)).toEqual([
      expect.objectContaining({ code: 'bar_contract_check_invalid' }),
    ]);
    expect(acceptanceBarTestCitationProblems([{ key: 'R-5', check: { kind: 'tests', files: [file], cases: [
      future, { file, testName: 'R5-CONTRACT' },
    ] } }], undefined, { allowPlannedPaths: true })).toEqual([
      expect.objectContaining({ code: 'bar_contract_check_invalid', barKey: 'R-5', detail: expect.stringContaining("test case 'R5-CONTRACT'") }),
    ]);
  });
});

describe('reopened draft successor adoption', () => {
  function authoredSuccessor() {
    const bars = Array.from({ length: 14 }, (_, index) => {
      const n = index + 1;
      const title = `Outcome ${n}`;
      const outcome = `The observed result ${n} is available.`;
      return normalizeAcceptanceBarCriterion({
        key: `r-${n}`, barKey: `R-${n}`, title,
        model: n <= 8 ? `${title}. ${outcome}` : outcome,
        ...(n > 8 ? { intent: { request: outcome } } : {}),
        driftMarkers: `The observed result ${n} is missing.`,
        role: 'outcome', mandatory: true, requiredScope: ['tree'], evidencePlane: 'tree',
        passRatings: ['healthy'], requiredTestLayers: ['unit'],
        method: `Run the detector for outcome ${n}.`,
        check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
        replication: `Inspect the persisted outcome ${n} and its exact evidence.`,
        barProvenance: { lifecycle: 'pre-implementation', declaredAt: input.declaredAt, declaredBy: input.actorId },
      });
    });
    const content = plan({
      requirements: bars.map((bar, index) => `**${bar.barKey} — ${bar.title}.** The observed result ${index + 1} is available.`).join('\n\n'),
      map: bars.map((bar) => `| ${bar.barKey} | P-001 | tree |`).join('\n'),
    });
    return { bars, content, template: { kind: 'acceptance', subjectPlan: input.planSlug,
      characteristic: 'plan-acceptance', description: 'Reviewed successor', proposedBy: input.actorId,
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'], criteria: bars } };
  }

  it('adopts complete authored successor criteria verbatim, including eight historical hashes without Intent', () => {
    const fixture = authoredSuccessor();
    const before = JSON.stringify(fixture);
    const result = buildAcceptanceBarSeed({ ...input, planStatus: 'draft',
      planContent: fixture.content, existingTemplateData: fixture.template, requireContractCompleteness: true });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.criteria).toEqual(fixture.bars);
    expect(result.criteria.slice(0, 8).map((bar) => bar.barHash)).toEqual(fixture.bars.slice(0, 8).map((bar) => bar.barHash));
    expect(result.criteria.slice(0, 8).every((bar) => bar.intent === undefined)).toBe(true);
    expect(result.projections.map((projection) => projection.falsifier?.observation)).toEqual(fixture.bars.map((bar) => bar.driftMarkers));
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it.each(['outcome', 'title', 'plane'])('refuses %s source drift instead of silently rebuilding an authored successor', (field) => {
    const fixture = authoredSuccessor();
    const changed = field === 'outcome' ? fixture.content.replace('The observed result 1 is available.', 'A different result is available.')
      : field === 'title' ? fixture.content.replace('R-1 — Outcome 1.', 'R-1 — Different title.')
      : fixture.content.replace('| R-1 | P-001 | tree |', '| R-1 | P-001 | live |');
    expect(buildAcceptanceBarSeed({ ...input, planStatus: 'draft', planContent: changed,
      existingTemplateData: fixture.template, requireContractCompleteness: true })).toMatchObject({
      ok: false, error: 'bar_rubric_conflict', problems: [expect.objectContaining({ barKey: 'R-1' })],
    });
  });

  it('validates the preserved successor contract rather than exempting it as previously seeded', () => {
    const fixture = authoredSuccessor();
    delete fixture.bars[0]!.method;
    expect(buildAcceptanceBarSeed({ ...input, planStatus: 'draft', planContent: fixture.content,
      existingTemplateData: fixture.template, requireContractCompleteness: true })).toMatchObject({
      ok: false, error: 'bar_contract_method_missing', problems: [expect.objectContaining({ barKey: 'R-1' })],
    });
  });

  it('fills missing server provenance on first adoption without changing BAR hashes', () => {
    const fixture = authoredSuccessor();
    delete fixture.bars[0]!.barProvenance;
    const result = buildAcceptanceBarSeed({ ...input, planStatus: 'draft', planContent: fixture.content,
      existingTemplateData: fixture.template, requireContractCompleteness: true });
    if (!result.ok) throw new Error(result.message);
    expect(result.criteria[0]).toMatchObject({ barHash: fixture.bars[0]!.barHash,
      barProvenance: { lifecycle: 'pre-implementation', declaredAt: input.declaredAt, declaredBy: input.actorId } });
  });

  function adoption() {
    const built = buildAcceptanceBarSeed({ ...input, planContent: plan() });
    if (!built.ok) throw new Error('valid retired contract fixture required');
    const { barContract: _contract, barSetHash: _hash, ...unstarted } = built.templateData;
    return {
      planStatus: 'draft', planSlug: 'seed-target',
      pinnedRubricSlug: 'acceptance-seed-target', pinnedRubricStatus: 'superseded',
      pinnedRubricArchived: false, pinnedTemplateData: built.templateData,
      activeRubrics: [{ plan_slug: 'acceptance-successor', template_data: unstarted }],
    };
  }

  it('routes an intact retired contract and one unstarted successor to the seeder without mutation', () => {
    const args = adoption();
    const before = JSON.stringify(args);
    expect(canSeedAcceptanceBarSuccessor(args)).toBe(true);
    expect(JSON.stringify(args)).toBe(before);
  });

  it.each(['active', 'ready', 'shipped', 'superseded', null])('keeps subject status %s on its existing contract path', (planStatus) => {
    expect(canSeedAcceptanceBarSuccessor({ ...adoption(), planStatus })).toBe(false);
  });

  it.each(['active', 'ready', 'draft', null])('does not bypass a pinned rubric with status %s', (pinnedRubricStatus) => {
    expect(canSeedAcceptanceBarSuccessor({ ...adoption(), pinnedRubricStatus })).toBe(false);
  });

  it('refuses absent, ambiguous, pinned, started or unrelated successor identities', () => {
    const args = adoption();
    const candidate = args.activeRubrics[0]!;
    const variants = [
      [],
      [candidate, { ...candidate, plan_slug: 'acceptance-second-successor' }],
      [{ ...candidate, plan_slug: args.pinnedRubricSlug }],
      [{ ...candidate, template_data: args.pinnedTemplateData }],
      [{ ...candidate, template_data: { ...candidate.template_data, subjectPlan: 'another-plan' } }],
      [{ ...candidate, template_data: {} }],
    ];
    for (const activeRubrics of variants) {
      expect(canSeedAcceptanceBarSuccessor({ ...args, activeRubrics })).toBe(false);
    }
    expect(canSeedAcceptanceBarSuccessor({ ...args, pinnedTemplateData: candidate.template_data })).toBe(false);
    expect(canSeedAcceptanceBarSuccessor({ ...args, pinnedTemplateData: {} })).toBe(false);
  });
});

describe('Requirements BAR parser', () => {
  it('parses every explicit R-N record and refuses malformed partial records', () => {
    const parsed = parseRequirementBars(plan());
    expect(parsed).toMatchObject({
      ok: true,
      bars: [
        { barKey: 'R-1', title: 'First outcome', model: 'The writer persists one canonical bar.' },
        { barKey: 'R-2', title: 'Runtime outcome', model: 'The live service exposes the current verdict.' },
      ],
    });
    if (!parsed.ok) throw new Error('expected plain-text requirements to parse');
    expect(parsed.bars.every((bar) => specBehaviorNonAtomicReason(bar.model) === null)).toBe(true);

    const malformed = parseRequirementBars(plan({
      requirements: '**R-1 First outcome.** Missing the required dash delimiter.',
    }));
    expect(malformed).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({ code: 'bar_requirement_parse_failed' })],
    });
  });

  it('refuses nested requirement insertion without accepting the remaining bars', () => {
    const parsed = parseRequirementBars(plan({
      requirements: `**R-3 — Deliberate scope.**

**R-4 — Immutable publication.**
\`\`\`requirement
{}
\`\`\`**`,
    }));

    expect(parsed).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ code: 'bar_requirement_parse_failed', barKey: 'R-3' }),
        expect.objectContaining({ code: 'bar_requirement_parse_failed', barKey: 'R-4' }),
      ]),
    });
  });

  it('requires an exact non-dropped map row per bar and validates the evidence plane', () => {
    const keys = new Set(['R-1', 'R-2']);
    expect(parseBarMappings(plan(), keys)).toMatchObject({
      ok: true,
      mappings: [
        { barKey: 'R-1', planItemIds: ['P-001', 'P-002'], evidencePlane: 'tree' },
        { barKey: 'R-2', planItemIds: ['P-002'], evidencePlane: 'live' },
      ],
    });
    expect(parseBarMappings(plan({ map: '| R-1 | P-001 | cloud |' }), keys)).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ code: 'bar_evidence_plane_invalid', barKey: 'R-1' }),
        expect.objectContaining({ code: 'bar_mapping_missing', barKey: 'R-2' }),
      ]),
    });
  });

  it('identifies a title-bearing map cell as an invalid key', () => {
    const result = parseBarMappings(plan({ map: '| R-1 — First outcome | P-001 | tree |\n| R-2 | P-002 | live |' }), new Set(['R-1', 'R-2']));
    expect(result).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ code: 'bar_mapping_invalid', barKey: 'R-1', detail: expect.stringContaining('bare R-1 key') }),
      ]),
    });
  });

  it('distinguishes an absent plan item from a map row without a Requirements record', () => {
    const keys = new Set(['R-1']);
    const result = parseBarMappings(plan({
      requirements: '**R-1 — First outcome.** The writer persists one canonical bar.',
      map: '| R-1 | P-999 | tree |\n| R-8 | P-001 | tree |',
    }), keys);
    expect(result).toMatchObject({
      ok: false,
      problems: expect.arrayContaining([
        expect.objectContaining({ code: 'bar_mapping_unknown', barKey: 'R-1', planItemId: 'P-999' }),
        expect.objectContaining({ code: 'bar_mapping_requirement_missing', barKey: 'R-8', detail: expect.stringContaining('no Requirements record') }),
      ]),
    });
  });
});

describe('acceptance BAR seed builder', () => {
  it.each([
    ['tree', 'live'],
    ['live', 'tree'],
    ['tree', 'deployed'],
  ] as const)('rejects %s/%s evidence-plane conflicts in preview and writer', (accepted, mapped) => {
    const requirement = {
      intent: { request: 'Preserve the selected evidence plane.', sourceRefs: ['session_turn:fixture'] },
      acceptance: {
        condition: 'The evidence describes the selected source version.',
        falsifier: 'Evidence from another plane is accepted as current.',
        evidencePlane: accepted,
        requiredScope: ['P-001'],
        requiredTestLayers: ['unit'],
      },
      verification: {
        method: 'Compare the declared plane with the evidence source.',
        check: { kind: 'tests', files: ['lib/evidence.test.ts'] },
      },
    };
    const content = plan({
      requirements: '**R-1 — Selected evidence.**\n```requirement\n' + JSON.stringify(requirement) + '\n```',
      map: `| R-1 | P-001 | ${mapped} |`,
    });
    const preview = validateAcceptanceBarSource(content);
    const written = buildAcceptanceBarSeed({ ...input, planContent: content });
    expect(preview).toMatchObject({
      ok: false,
      problems: [{ code: 'bar_evidence_plane_invalid', barKey: 'R-1' }],
    });
    expect(written).toMatchObject({ ok: false, error: 'bar_evidence_plane_invalid' });
    if (preview.ok || written.ok) throw new Error('conflicting planes were admitted');
    expect(preview.problems).toEqual(written.problems);

    const consistent = content.replace(`| ${mapped} |`, `| ${accepted} |`);
    expect(validateAcceptanceBarSource(consistent).ok).toBe(true);
    expect(buildAcceptanceBarSeed({ ...input, planContent: consistent }).ok).toBe(true);
  });

  // WI-10008304: an activation dry run once passed a block whose explicit passRatings were
  // off the seeded rubric's rating scale, and the real run then refused it. Preview and writer
  // both build through this function, so the refusal is pinned HERE, where they converge.
  it('refuses a requirement pass rating that is not on the rubric rating scale', () => {
    const sections = {
      intent: { request: 'Keep the rubric gradeable.', sourceRefs: ['session_turn:fixture'] },
      acceptance: { condition: 'The seeded rubric accepts the declared pass rating.',
        falsifier: 'A pass rating outside the rating scale is seeded.', evidencePlane: 'tree',
        requiredScope: ['P-001'], requiredTestLayers: ['unit'], passRatings: ['pass'] },
      verification: { method: 'Seed the rubric and read its criteria.',
        check: { kind: 'tests', files: ['lib/evidence.test.ts'] } },
    };
    const content = plan({ requirements: '**R-1 — Gradeable rubric.**\n```requirement\n' + JSON.stringify(sections) + '\n```',
      map: '| R-1 | P-001 | tree |' });
    const refused = buildAcceptanceBarSeed({ ...input, planContent: content });
    expect(refused).toMatchObject({ ok: false, error: 'bar_rubric_conflict' });
    if (refused.ok) throw new Error('an off-scale pass rating was seeded');
    expect(refused.problems[0]!.detail).toMatch(/passRatings.*not present in the rubric ratingScale/);
    const onScale = content.replace('"passRatings":["pass"]', '"passRatings":["healthy"]');
    expect(onScale).not.toBe(content);
    expect(buildAcceptanceBarSeed({ ...input, planContent: onScale }).ok).toBe(true);
  });

  // EI-25649770239138025: plans:edit on build d740fc3802 refused a multi-probe requirement
  // (`check: { kind:'probe', all:[...] }`) that the rubric template accepted. Both paths now
  // share rubricCriterionCheckSchema; this pins the round-trip so they cannot diverge again.
  it('round-trips a multi-probe check from a requirement block into the seeded criterion', () => {
    const probes = [
      { kind: 'state-cell', schemaRevision: 1, cell: 'verification.health', expect: { path: 'status', op: 'eq', value: 'measured' } },
      { kind: 'state-cell', schemaRevision: 1, cell: 'verification.health', expect: { path: 'denominator', op: 'gt', value: 0 } },
    ];
    const sections = (check: Record<string, unknown>) => ({
      intent: { request: 'Grade a metric and its denominator together.', sourceRefs: ['session_turn:fixture'] },
      acceptance: { condition: 'The metric and its positive control both pass.',
        falsifier: 'Either probe fails.', evidencePlane: 'tree',
        requiredScope: ['P-001'], requiredTestLayers: ['unit'] },
      verification: { method: 'Run both read-only probes.', check },
    });
    const content = (check: Record<string, unknown>) => plan({
      requirements: '**R-1 — Metric with control.**\n```requirement\n' + JSON.stringify(sections(check)) + '\n```',
      map: '| R-1 | P-001 | tree |',
    });

    const multi = { kind: 'probe', all: probes };
    // Every member of the rubric check union, not only the shape that failed: the item's
    // defect class is the two schemas diverging on ANY shape. One entry per union kind
    // (probe twice: single and all), so a new kind added to the union without a case
    // here is caught by the length assertion below.
    const everyShape: Record<string, Record<string, unknown>> = {
      tests: { kind: 'tests', files: ['lib/evidence.test.ts'], testName: 'suite > exact case' },
      'tests-cases': { kind: 'tests', files: ['lib/evidence.test.ts', 'lib/evidence.integration.test.ts'], cases: [
        { file: 'lib/evidence.test.ts', testName: 'unit behavior' },
        { file: 'lib/evidence.integration.test.ts', testName: 'integrated behavior' },
      ] },
      cargo: { kind: 'cargo', manifestPath: 'native/Cargo.toml', sourceFiles: ['native/src/lib.rs'], test: 'limits' },
      instrument: { kind: 'instrument', instrumentKey: 'upload-limit-meter' },
      'probe-single': { kind: 'probe', probe: probes[0] },
      'probe-all': multi,
      coverage: { kind: 'coverage', scope: { surfaceKind: 'mcp-tool', planTouched: true }, floor: 'l2' },
      requirements: { kind: 'requirements' },
    };
    const unionKinds = rubricCriterionCheckSchema.options.map((o) => o.shape.kind.value);
    expect(new Set(Object.values(everyShape).map((s) => s.kind))).toEqual(new Set(unionKinds));
    for (const [label, shape] of Object.entries(everyShape)) {
      expect(rubricCriterionCheckSchema.safeParse(shape).success, label).toBe(true);
      const parsed = parseRequirementBars(content(shape));
      if (!parsed.ok) throw new Error(`${label} requirement refused: ${JSON.stringify(parsed.problems)}`);
      expect(parsed.bars[0]!.criterion?.check, label).toEqual(shape);
    }
    expect(buildAcceptanceBarSeed({ ...input, planContent: content(multi) }).ok).toBe(true);

    // Controls: the shared refinement refuses neither/both on both paths alike, so the
    // calibration above cannot pass vacuously on a parser that accepts anything.
    for (const bad of [
      { kind: 'probe' },
      { kind: 'probe', probe: probes[0], all: probes },
      { kind: 'tests', files: ['a.test.ts', 'b.test.ts'], testName: 'selected case' },
    ]) {
      expect(rubricCriterionCheckSchema.safeParse(bad).success).toBe(false);
      expect(parseRequirementBars(content(bad))).toMatchObject({
        ok: false,
        problems: [expect.objectContaining({ code: 'bar_requirement_parse_failed', barKey: 'R-1' })],
      });
    }
  });

  it('authors one unified requirement and derives all mapped proof contracts without rewriting its promise', () => {
    const sections = {
      intent: { request: 'Export every matching customer.', sourceRefs: ['session_turn:export'] },
      acceptance: { condition: 'Every matching ID appears exactly once with correct values.',
        falsifier: 'Any ID is missing or duplicated.', evidencePlane: 'tree',
        requiredScope: ['filters', 'pagination'], requiredTestLayers: ['e2e'] },
      verification: { method: 'Export a multi-page fixture and compare all expected rows.',
        check: { kind: 'instrument', instrumentKey: 'none' } },
    };
    const content = plan({ requirements: '**R-1 — Complete export.**\n```requirement\n' + JSON.stringify(sections) + '\n```',
      map: '| R-1 | P-001, P-002 | tree |' });
    const built = buildAcceptanceBarSeed({ ...input, planContent: content });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.criteria[0]).toMatchObject({ model: sections.acceptance.condition,
      driftMarkers: sections.acceptance.falsifier, intent: sections.intent,
      method: sections.verification.method, requiredTestLayers: ['e2e'] });
    expect(built.projections).toHaveLength(2);
    expect(built.projections.every((clause) => clause.requiredTestLayers?.[0] === 'e2e')).toBe(true);
    expect(buildAcceptanceBarSeed({ ...input, planContent: content.replace('| tree |', '| live |') }))
      .toMatchObject({ ok: false, error: 'bar_evidence_plane_invalid' });
    expect(parseRequirementBars(content.replace('\n```\n', '\n```\nA different promise.\n')).ok).toBe(false);
  });
  it('adopts explicitly mapped legacy criteria without losing their identity, stronger outcomes or METHODS', () => {
    const existing = { kind: 'acceptance', subjectPlan: input.planSlug, characteristic: 'plan-acceptance',
      ratingScale: ['pass', 'partial', 'fail', 'unknown'], criteria: [
        { key: 'persisted-outcome', title: 'Persisted outcome', model: 'The canonical bar is durably persisted and immediately readable.', method: 'Run the exact roundtrip fixture.', driftMarkers: 'The read misses the committed value.' },
        { key: 'visible-outcome', title: 'Visible outcome', model: 'The live service exposes the current verdict and its exact revision.', method: 'Read the service verdict and compare the revision.', driftMarkers: 'The response names an older revision.' },
      ] };
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: existing }).ok).toBe(false);
    const map = { 'R-1': 'persisted-outcome', 'R-2': 'visible-outcome' };
    const built = buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: existing,
      backfilled: true, legacyCriterionMap: map });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.criteria[0]).toMatchObject({ ...existing.criteria[0], barKey: 'R-1',
      passRatings: ['pass'], barProvenance: { lifecycle: 'legacy-backfilled' } });
    expect(built.templateData.barContract).toMatchObject({ cohort: 'post-epoch' });
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: existing,
      backfilled: true, legacyCriterionMap: { 'R-1': 'persisted-outcome', 'R-2': 'persisted-outcome' } }).ok).toBe(false);
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: built.templateData,
      backfilled: true, legacyCriterionMap: map }).ok).toBe(false);
  });

  // EI-23376469015732685: a rubric authored BEFORE BAR adoption has no barKey on any
  // criterion, so every one reads as an "extra" against the Requirements set. Refusing
  // that FATALLY deadlocked the whole post-epoch + draft + pre-BAR class: `ready` needs a
  // recorded activation audit, and the audit died on exactly this code. The refusal still
  // stands — it is now merely RECORDABLE, so the audit can persist while the backfill is
  // still owed. The ship floor is untouched (`acceptance_bar_contract_not_ready`).
  it('marks a pre-BAR legacy rubric repairable, but keeps a genuine bar conflict fatal', () => {
    const legacyCriteria = [
      { key: 'persisted-outcome', title: 'Persisted outcome', model: 'The canonical bar is durably persisted.', method: 'Run the roundtrip fixture.', driftMarkers: 'The read misses the committed value.' },
      { key: 'visible-outcome', title: 'Visible outcome', model: 'The live service exposes the verdict.', method: 'Read the service verdict.', driftMarkers: 'The response names an older revision.' },
    ];
    const templateData = (criteria: unknown[]) => ({ kind: 'acceptance', subjectPlan: input.planSlug,
      characteristic: 'plan-acceptance', ratingScale: ['pass', 'partial', 'fail', 'unknown'], criteria });

    // LEGACY: no criterion carries a barKey at all -> recordable as a pending backfill.
    const legacy = buildAcceptanceBarSeed({ ...input, planContent: plan(),
      existingTemplateData: templateData(legacyCriteria) });
    expect(legacy.ok).toBe(false);
    if (legacy.ok) throw new Error('expected the legacy rubric to refuse');
    expect(legacy.problems).toHaveLength(1);
    expect(legacy.problems[0]).toMatchObject({
      code: 'bar_rubric_conflict',
      repairable: 'legacy_criteria_unmapped',
      rubricSlug: input.rubricSlug,
    });
    // The detail must name the owed backfill, not merely "outside the Requirements set" —
    // that wording is what sent readers hunting for a nonexistent renamed requirement.
    expect(legacy.problems[0]!.detail).toContain('predates BAR adoption');
    expect(legacy.problems[0]!.detail).toContain('persisted-outcome');

    // CONTROL 1: a criterion carrying a barKey the Requirements map does not know is a
    // REAL conflict (renamed/removed requirement, or the wrong rubric pinned). If this
    // ever acquires `repairable`, activation would record an audit over a rubric whose
    // bars disagree with its plan — the exact thing the extras check exists to catch.
    // A barKey-bearing criterion cannot be hand-authored: the authoring schema demands a
    // server-derived `barHash`. So the control is built by SEEDING a valid rubric and then
    // renaming one bar to something the Requirements map does not know — which is also the
    // real-world shape of this failure (a renamed or removed requirement).
    const seeded = buildAcceptanceBarSeed({ ...input, planContent: plan() });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw new Error(seeded.message);
    const renameFirstBar = (extra?: unknown) => {
      const next = JSON.parse(JSON.stringify(seeded.templateData));
      next.criteria[0].barKey = 'R-99';
      if (extra) next.criteria.push(extra);
      return next;
    };
    const conflicting = buildAcceptanceBarSeed({ ...input, planContent: plan(),
      existingTemplateData: renameFirstBar() });
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('expected the conflicting rubric to refuse');
    expect(conflicting.problems[0]).toMatchObject({ code: 'bar_rubric_conflict' });
    expect(conflicting.problems[0]!.repairable).toBeUndefined();
    expect(conflicting.problems[0]!.detail).toContain('outside the current Requirements set');

    // CONTROL 2: MIXED — one legacy criterion beside one genuinely conflicting one. The
    // presence of a single unknown barKey must make the whole refusal fatal; a per-problem
    // OR would let a real conflict ride in behind a legacy sibling.
    const mixed = buildAcceptanceBarSeed({ ...input, planContent: plan(),
      existingTemplateData: renameFirstBar({ ...legacyCriteria[0], key: 'stray-legacy-outcome' }) });
    expect(mixed.ok).toBe(false);
    if (mixed.ok) throw new Error('expected the mixed rubric to refuse');
    expect(mixed.problems[0]!.repairable).toBeUndefined();
  });

  it('creates one mandatory outcome per requirement and one hash-pinned clause per map edge', () => {
    const built = buildAcceptanceBarSeed({ ...input, classRef: 'plan-class-bugfix', planContent: plan() });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.criteria).toHaveLength(2);
    expect(built.criteria[0]).toMatchObject({
      key: 'r-1',
      barKey: 'R-1',
      role: 'outcome',
      mandatory: true,
      requiredScope: ['tree'],
      evidencePlane: 'tree',
      passRatings: ['healthy'],
      barProvenance: {
        lifecycle: 'pre-implementation',
        declaredAt: input.declaredAt,
        declaredBy: input.actorId,
      },
    });
    expect(built.criteria[0]?.method).toBeUndefined();
    expect(built.projections).toHaveLength(3);
    expect(built.projections.every((clause) => specBehaviorNonAtomicReason(clause.behavior) === null)).toBe(true);
    expect(built.projections.map((clause) => clause.behaviorClass)).toEqual([
      'happy-path', 'happy-path', 'non-automated',
    ]);
    expect(built.projections[2]?.requiredTestLayers).toBeUndefined();
    expect(built.projections[0]).toMatchObject({
      specId: 'AUTO-BAR-R-1-P-001',
      planItemId: 'P-001',
      requiredEvidence: ['tree'],
      lifecycleStatus: 'draft',
      sourceBar: {
        barKey: 'R-1',
        barSetHash: built.barSetHash,
        rubricSlug: input.rubricSlug,
        rubricRevision: 1,
        evidencePlane: 'tree',
      },
    });
    expect(built.templateData).toMatchObject({
      kind: 'acceptance',
      subjectPlan: 'seed-target',
      classRef: 'plan-class-bugfix',
      barSetHash: built.barSetHash,
      barContract: {
        schemaVersion: 1,
        adoptionEpoch: 1,
        subjectPlanRevision: 7,
      },
    });
  });

  it('preserves METHOD fields only when the canonical BAR hash is unchanged', () => {
    const first = buildAcceptanceBarSeed({ ...input, planContent: plan() });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const existing = {
      ...first.templateData,
      classRef: 'plan-class-migration',
      criteria: first.criteria.map((criterion) =>
        criterion.barKey === 'R-1'
          ? { ...criterion, method: 'Run the focused test.', check: { kind: 'requirements' } }
          : criterion,
      ),
    };
    const second = buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: existing });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.criteria[0]).toMatchObject({ method: 'Run the focused test.', check: { kind: 'requirements' } });
    expect(second.templateData).toMatchObject({ classRef: 'plan-class-migration' });

    const changed = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({
        requirements: `**R-1 — First outcome.** The canonical promise changed.

**R-2 — Runtime outcome.** The live service exposes the current verdict.`,
      }),
      existingTemplateData: existing,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.criteria[0]?.method).toBeUndefined();
  });

  it('derives an order-independent set hash and refuses an unmapped bar', () => {
    const built = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({ map: '| R-1 | P-001 | tree |' }),
    });
    expect(built).toMatchObject({
      ok: false,
      error: 'bar_mapping_missing',
      problems: expect.arrayContaining([expect.objectContaining({ barKey: 'R-2' })]),
    });

    const a = { key: 'a', barKey: 'R-1', barHash: 'a'.repeat(64) };
    const b = { key: 'b', barKey: 'R-2', barHash: 'b'.repeat(64) };
    expect(computeAcceptanceBarSetHash([a, b])).toBe(computeAcceptanceBarSetHash([b, a]));
  });

  it.each(['draft', 'ready', 'active'])('preserves approved BARs pinned to the current %s subject revision', (planStatus) => {
    const seeded = buildAcceptanceBarSeed({ ...input, planContent: plan(), planStatus });
    if (!seeded.ok) throw new Error(seeded.message);
    const criteria = seeded.criteria.map((criterion) => normalizeAcceptanceBarCriterion({
      ...criterion,
      intent: { request: 'Preserve the complete original request.', constraints: ['Keep the original proof plane.'] },
      model: `The approved ${criterion.barKey} outcome is delivered.`,
      driftMarkers: `The approved ${criterion.barKey} outcome is missing.`,
      requiredTestLayers: ['integration'],
      method: 'Exercise the complete writer and reader with an isolated fixture.',
    }));
    const approved = { ...seeded.templateData, criteria, barSetHash: computeAcceptanceBarSetHash(criteria) };
    expect(approved.barSetHash).not.toBe(seeded.barSetHash);

    const current = buildAcceptanceBarSeed({
      ...input, planContent: plan(), planStatus, existingTemplateData: approved,
    });
    if (!current.ok) throw new Error(current.message);
    expect(current.criteria).toEqual(criteria);
    expect(current.barSetHash).toBe(approved.barSetHash);
    expect(current.projections.every((clause) => clause.requiredTestLayers?.includes('integration'))).toBe(true);
    expect(() => guardAcceptanceBarTemplateDataWrite({
      slug: input.rubricSlug, storedTemplateData: approved, nextTemplateData: current.templateData,
      subjectPlan: { status: planStatus, revision: input.subjectPlanRevision, adoptionEpoch: 1, cohort: 'post-epoch' },
      actorId: input.actorId,
    })).not.toThrow();

    const unapprovedRevision = buildAcceptanceBarSeed({
      ...input, planContent: plan(), planStatus, existingTemplateData: approved,
      subjectPlanRevision: input.subjectPlanRevision + 1,
    });
    if (!unapprovedRevision.ok) throw new Error(unapprovedRevision.message);
    expect(() => guardAcceptanceBarTemplateDataWrite({
      slug: input.rubricSlug, storedTemplateData: approved, nextTemplateData: unapprovedRevision.templateData,
      subjectPlan: { status: planStatus, revision: input.subjectPlanRevision + 1, adoptionEpoch: 1, cohort: 'post-epoch' },
      actorId: input.actorId,
    })).toThrow('BAR meaning cannot change outside rubrics:amend');
  });
});

describe('acceptanceBarProjectedBehavior', () => {
  // A BAR model routinely opens by restating its own title. That reads fine in a
  // rubric and is fatal in the DERIVED clause: two sentences fail
  // atomic-observable-behavior, which blocks promotion and shipping. Repairing the
  // projected clause instead does not survive — preserveRefinements only holds while
  // the BAR hash material is unchanged (EI-23920059935763829).
  const title = 'Every in-scope plan ships';
  const behavior = 'Each of the ten plans named IN SCOPE by D-001 reads `status: shipped` in harness_plans';

  it('strips a restated title so the projected behavior is atomic, where the raw model is not', () => {
    const model = `${title}. ${behavior}`;
    // Control first: the raw model is what the projection used to emit, and it FAILS.
    // Without this the assertion below could pass against a checker that accepts anything.
    expect(specBehaviorNonAtomicReason(model)).not.toBeNull();
    expect(acceptanceBarProjectedBehavior({ title, model })).toBe(behavior);
    expect(specBehaviorNonAtomicReason(acceptanceBarProjectedBehavior({ title, model }))).toBeNull();
  });

  it('tolerates a title written with its own trailing period', () => {
    expect(acceptanceBarProjectedBehavior({ title: `${title}.`, model: `${title}. ${behavior}` })).toBe(behavior);
  });

  it('leaves a model that does not restate its title untouched', () => {
    expect(acceptanceBarProjectedBehavior({ title, model: behavior })).toBe(behavior);
    expect(acceptanceBarProjectedBehavior({ title, model: 'Every in-scope plan shipped somewhere. And more.' }))
      .toBe('Every in-scope plan shipped somewhere. And more.');
  });

  it('keeps a model that is ONLY its own title rather than emptying the clause', () => {
    expect(acceptanceBarProjectedBehavior({ title, model: `${title}.` })).toBe(`${title}.`);
  });

  it('is a no-op when either side is missing', () => {
    expect(acceptanceBarProjectedBehavior({ title: '', model: behavior })).toBe(behavior);
    expect(acceptanceBarProjectedBehavior({ title, model: '' })).toBe('');
    expect(acceptanceBarProjectedBehavior({})).toBe('');
  });
});

// review-system-rework-reduction-2026-09-23 P-003/P-029: the activation seed demands the
// METHOD/check/layer contract while the repair is still a draft text edit.
describe('activation seed contract completeness (requireContractCompleteness)', () => {
  const block = (sections: Record<string, unknown>) =>
    '**R-1 — Complete export.**\n```requirement\n' + JSON.stringify(sections) + '\n```';
  const completeSections = {
    intent: { request: 'Export every matching customer.' },
    acceptance: { condition: 'Every matching ID appears exactly once.', falsifier: 'Any ID is missing.',
      requiredTestLayers: ['integration'] },
    verification: { method: 'Export a multi-page fixture and compare rows.',
      check: { kind: 'tests', files: ['packages/operator-core/lib/export.integration.test.ts'] } },
  };
  const oneBarMap = '| R-1 | P-001 | tree |';

  it('refuses prose BARs once each, with the conversion template shown a single time', () => {
    const built = buildAcceptanceBarSeed({ ...input, planContent: plan(), requireContractCompleteness: true });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('expected refusal');
    expect(built.problems.map((problem) => [problem.barKey, problem.code])).toEqual([
      ['R-1', 'bar_contract_method_missing'],
      ['R-2', 'bar_contract_method_missing'],
    ]);
    // R-1 is tree-plane (owes automated proof); R-2 is live with no layers (manual delivery).
    expect(built.problems[0]!.contractGaps).toEqual(['method_missing', 'check_missing', 'test_layers_missing']);
    expect(built.problems[1]!.contractGaps).toEqual(['method_missing', 'check_missing']);
    // The template (identified by its unique placeholder) appears once, not per BAR.
    expect(built.message.split('<what was asked>').length - 1).toBe(1);
  });

  it('seeds a complete requirement block and refuses a check that cannot prove its declared layer', () => {
    const ok = buildAcceptanceBarSeed({ ...input, planContent: plan({ requirements: block(completeSections), map: oneBarMap }),
      requireContractCompleteness: true });
    expect(ok.ok).toBe(true);

    const unitOnly = { ...completeSections, verification: { ...completeSections.verification,
      check: { kind: 'tests', files: ['packages/operator-core/lib/export.test.ts'] } } };
    const mismatch = buildAcceptanceBarSeed({ ...input, planContent: plan({ requirements: block(unitOnly), map: oneBarMap }),
      requireContractCompleteness: true });
    expect(mismatch).toMatchObject({ ok: false, error: 'bar_contract_check_layer_mismatch' });

    // WI-10006536: a declared layer the run ledger never records cannot pass correct-layer.
    const unrecordable = { ...completeSections, acceptance: { ...completeSections.acceptance,
      requiredTestLayers: ['integration', 'component'] } };
    const refused = buildAcceptanceBarSeed({ ...input, planContent: plan({ requirements: block(unrecordable), map: oneBarMap }),
      requireContractCompleteness: true });
    expect(refused).toMatchObject({ ok: false, error: 'bar_contract_check_layer_mismatch' });
    if (refused.ok) throw new Error('expected refusal');
    expect(refused.problems[0]!.contractGaps).toEqual(['test_layer_unrecordable']);
  });

  it('requires layers for a live-plane tests check while preserving an explicit manual check', () => {
    const liveMap = '| R-1 | P-001 | live |';
    const noLayers = {
      ...completeSections,
      acceptance: { condition: 'Every matching ID appears exactly once.', falsifier: 'Any ID is missing.' },
    };
    const automated = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({ requirements: block(noLayers), map: liveMap }),
      requireContractCompleteness: true,
    });
    expect(automated).toMatchObject({ ok: false, error: 'bar_contract_test_layers_missing' });

    const manual = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({ requirements: block({
        ...noLayers,
        verification: { method: 'Inspect the live state.', check: { kind: 'instrument', instrumentKey: 'none' } },
      }), map: liveMap }),
      requireContractCompleteness: true,
    });
    expect(manual.ok).toBe(true);

    const manualWithExplicitEmptyLayers = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({ requirements: block({
        ...noLayers,
        acceptance: { ...noLayers.acceptance, requiredTestLayers: [] },
        verification: { method: 'Inspect the live state.', check: { kind: 'instrument', instrumentKey: 'none' } },
      }), map: liveMap }),
      requireContractCompleteness: true,
    });
    expect(manualWithExplicitEmptyLayers.ok).toBe(true);

    const automatedWithExplicitEmptyLayers = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({ requirements: block({
        ...noLayers,
        acceptance: { ...noLayers.acceptance, requiredTestLayers: [] },
      }), map: liveMap }),
      requireContractCompleteness: true,
    });
    expect(automatedWithExplicitEmptyLayers).toMatchObject({
      ok: false,
      error: 'bar_requirement_parse_failed',
    });
  });

  it.each(['tree', 'deployed', 'live'] as const)('projects explicit manual %s review without an automated clause class', (plane) => {
    const manual = buildAcceptanceBarSeed({
      ...input,
      planContent: plan({ requirements: block({
        ...completeSections,
        acceptance: { condition: 'The reviewed offer has explicit cancellation terms.', falsifier: 'Cancellation terms are missing.' },
        verification: { method: 'Read the offer and retain the actual demonstration receipt.', check: { kind: 'instrument', instrumentKey: 'none' } },
      }), map: `| R-1 | P-001 | ${plane} |` }),
      requireContractCompleteness: true,
    });
    expect(manual.ok).toBe(true);
    if (!manual.ok) throw new Error(manual.message);
    expect(manual.projections).toHaveLength(1);
    expect(manual.projections[0]?.behaviorClass).toBe('non-automated');
    expect(manual.projections[0]?.mutationRequired ?? false).toBe(false);
    expect(manual.projections[0]?.requiredTestLayers ?? []).toEqual([]);
    expect(manual.criteria[0]?.method).toContain('actual demonstration receipt');
  });

  it('retains automated classes for tree work without explicit manual intent or with declared layers', () => {
    expect(acceptanceBarBehaviorClass('tree')).toBe('happy-path');
    expect(acceptanceBarBehaviorClass('tree', [], { kind: 'requirements' })).toBe('happy-path');
    expect(acceptanceBarBehaviorClass('tree', ['unit'], { kind: 'instrument', instrumentKey: 'none' })).toBe('happy-path');
    expect(acceptanceBarBehaviorClass('live', ['integration'], { kind: 'instrument', instrumentKey: 'none' })).toBe('happy-path');
    expect(acceptanceBarBehaviorClass('tree', [], { kind: 'instrument', instrumentKey: 'none' })).toBe('non-automated');
  });

  it('judges only fresh post-epoch BARs: opt-out, legacy backfill and unchanged priors are untouched', () => {
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan() }).ok).toBe(true);
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan(), cohort: 'legacy-backfilled',
      requireContractCompleteness: true }).ok).toBe(true);
    // A re-audit of an already-seeded contract re-derives nothing fresh, so it cannot be
    // refused on a gap the start door (not a re-audit) owns.
    const seeded = buildAcceptanceBarSeed({ ...input, planContent: plan() });
    if (!seeded.ok) throw new Error(seeded.message);
    expect(buildAcceptanceBarSeed({ ...input, planContent: plan(), existingTemplateData: seeded.templateData,
      requireContractCompleteness: true }).ok).toBe(true);
  });
});

describe('item-type bars carry their criterion verification (D-011)', () => {
  const TEST_FILE = 'packages/operator-core/lib/plan-types/item-type-contract.test.ts';
  const typeBar = (verification?: ItemTypeBar['verification']): ItemTypeBar => ({
    barKey: 'T-acme--memo-cites-sources',
    title: 'Cites its sources',
    model: 'Every claim names its source.',
    planItemIds: ['P-001'],
    source: { itemType: 'acme/memo', revision: 2, criterionKey: 'cites-sources' },
    ...(verification ? { verification } : {}),
  });
  const seededTypeBar = (verification?: ItemTypeBar['verification']) => {
    const result = buildAcceptanceBarSeed({ ...input, planStatus: 'draft', planContent: plan(), itemTypeBars: [typeBar(verification)] });
    if (!result.ok) throw new Error(result.message);
    return result.criteria.find((criterion) => criterion.barKey === 'T-acme--memo-cites-sources')!;
  };

  it('seeds the METHOD, the structured check and the replication the item type declares', () => {
    const bar = seededTypeBar({
      method: 'Run the memo source checker over the item.',
      check: { kind: 'tests', params: { files: [TEST_FILE] } },
      replication: `npm run test:file -- ${TEST_FILE}`,
    });
    expect(bar.method).toBe('Run the memo source checker over the item.');
    expect(bar.check).toMatchObject({ kind: 'tests', files: [TEST_FILE] });
    expect(rubricCriterionCheckSchema.safeParse(bar.check).success).toBe(true);
    expect(bar.replication).toBe(`npm run test:file -- ${TEST_FILE}`);
    expect(bar.title).toBe('Cites its sources');
  });

  it('leaves the METHOD for the plan author when the criterion declares no verification', () => {
    const bar = seededTypeBar();
    expect(bar.method).toBeUndefined();
    expect(bar.check).toBeUndefined();
  });

  it('refuses a criterion check that is not a declarative rubric check, naming the type and criterion', () => {
    const result = buildAcceptanceBarSeed({ ...input, planStatus: 'draft', planContent: plan(),
      itemTypeBars: [typeBar({ method: 'Read it.', check: { kind: 'shell', params: { command: 'true' } } })] });
    expect(result).toMatchObject({
      ok: false,
      error: 'bar_contract_check_invalid',
      problems: [expect.objectContaining({ barKey: 'T-acme--memo-cites-sources', detail: expect.stringMatching(/acme\/memo .*cites-sources.*'shell'/) })],
    });
  });
});
