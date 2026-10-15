import { describe, expect, it } from 'vitest';
import { normalizeRequirementSections, requirementSections } from './requirement-contract';
import { applyRubricAmendment, computeAcceptanceBarSetHash, normalizeAcceptanceBarCriterion, planRowToRubric, type Rubric } from './rubrics';
import { acceptanceRubricCriterionSchema, rubricTemplateDataSchema, rubricTemplateDataAuthoringSchema } from './agent-tools/plans/rubric-template';
import { guardAcceptanceBarTemplateDataWrite } from './agent-tools/plans/rubric-loss-guard';

const requirement = {
  key: 'export', title: 'Complete export', barKey: 'R-EXPORT',
  intent: { request: 'Export all customers matching my filters.', sourceRefs: ['session_turn:example'] },
  acceptance: {
    condition: 'Every authorized matching customer appears exactly once across all pages.',
    falsifier: 'An expected identifier is missing, repeated or has incorrect values.',
    requiredScope: ['pagination', 'permissions'], evidencePlane: 'tree' as const,
    requiredTestLayers: ['integration', 'e2e'],
    passRatings: ['healthy'], mandatory: true, role: 'outcome' as const,
  },
  verification: { method: 'Export a known multi-page dataset and compare the complete IDs and values.' },
};

describe('unified requirement contract', () => {
  it('authors one promise and method, with no separately persisted aliases', () => {
    const canonical = normalizeAcceptanceBarCriterion(requirement);
    expect(canonical.model).toBe(requirement.acceptance.condition);
    expect(canonical.driftMarkers).toBe(requirement.acceptance.falsifier);
    expect(canonical.method).toBe(requirement.verification.method);
    expect(canonical.intent).toEqual(requirement.intent);
    expect(canonical).not.toHaveProperty('acceptance');
    expect(canonical).not.toHaveProperty('verification');
    expect(acceptanceRubricCriterionSchema.safeParse(canonical).success).toBe(true);
  });

  it.each([
    { model: 'Only export the first page.' },
    { bar: 'Only export the first page.' },
    { driftMarkers: 'Missing rows are allowed.' },
    { method: 'Only inspect the first page.' },
    { requiredScope: ['pagination'] },
    { mandatory: false },
    { requiredTestLayers: ['unit'] },
  ])('refuses competing promises or methods: %j', (duplicate) => {
    expect(() => normalizeRequirementSections({ ...requirement, ...duplicate })).toThrow('requirement_alias_conflict');
  });

  it('accepts equivalent readback aliases without changing the canonical meaning', () => {
    expect(normalizeAcceptanceBarCriterion({
      ...requirement, model: ` ${requirement.acceptance.condition} `,
      requiredScope: ['permissions', 'pagination'],
    }).barHash).toBe(normalizeAcceptanceBarCriterion(requirement).barHash);
  });

  it('keeps the BAR fixed when a verification method improves; promise changes alter it', () => {
    const original = normalizeAcceptanceBarCriterion(requirement);
    expect(normalizeAcceptanceBarCriterion({ ...requirement, verification: { method: 'Repeat with ten pages and two accounts.' } }).barHash).toBe(original.barHash);
    expect(normalizeAcceptanceBarCriterion({ ...requirement, acceptance: { ...requirement.acceptance, condition: 'Export the first page.' } }).barHash).not.toBe(original.barHash);
    expect(normalizeAcceptanceBarCriterion({ ...requirement, intent: { request: 'Export only the first page.' } }).barHash).not.toBe(original.barHash);
  });

  it('preserves legacy criteria without manufacturing Intent', () => {
    const legacy = { key: 'old', title: 'Existing requirement', model: 'Existing promise', method: 'Existing check', driftMarkers: 'Failure' };
    expect(normalizeAcceptanceBarCriterion(legacy)).toEqual(legacy);
    expect(requirementSections(legacy).intent).toBeNull();
  });

  it('does not promote the readback bar=model echo on a legacy criterion into BAR-contract metadata', () => {
    const legacy = {
      key: 'old',
      title: 'Existing requirement',
      model: 'Existing promise',
      bar: 'Existing promise',
      method: 'Existing check',
      driftMarkers: 'Failure',
    };

    expect(normalizeAcceptanceBarCriterion(legacy)).toEqual({
      key: 'old',
      title: 'Existing requirement',
      model: 'Existing promise',
      method: 'Existing check',
      driftMarkers: 'Failure',
    });
  });

  it('patches a verification method without changing the promise, but treats weaker proof as an amendment', () => {
    const canonical = normalizeAcceptanceBarCriterion(requirement);
    const stored = { rubricId: 'export', kind: 'acceptance', status: 'active',
      criteria: [{ ...canonical, bar: canonical.model }], ratingScale: ['healthy', 'broken', 'unknown'],
    } as Rubric;
    const improved = applyRubricAmendment(stored, { rubricId: 'export',
      requirement: { key: 'export', verification: { method: 'Compare every exported row against an independent expected dataset.' } } });
    expect(normalizeAcceptanceBarCriterion(improved.criteria[0]!).barHash).toBe(canonical.barHash);
    expect(improved.criteria[0]).not.toHaveProperty('bar');
    const weakened = applyRubricAmendment(stored, { rubricId: 'export',
      requirement: { key: 'export', acceptance: { requiredTestLayers: ['unit'] } } });
    expect(normalizeAcceptanceBarCriterion(weakened.criteria[0]!).barHash).not.toBe(canonical.barHash);
    const contract = { schemaVersion: 1, adoptionEpoch: 1, cohort: 'post-epoch', subjectPlanRevision: 3,
      seededAt: '2026-09-05T00:00:00Z', seededBy: 'author' };
    const data = { kind: 'acceptance', subjectPlan: 'export', characteristic: 'export',
      ratingScale: stored.ratingScale, criteria: [canonical], barContract: contract, barSetHash: computeAcceptanceBarSetHash([canonical]) };
    rubricTemplateDataSchema.parse(data);
    expect(() => guardAcceptanceBarTemplateDataWrite({ slug: 'export', storedTemplateData: data,
      nextTemplateData: { ...data, criteria: [{ ...canonical, requiredTestLayers: ['unit'] }] },
    })).toThrow('BAR meaning cannot change');
    // An attacker retaining the old hash cannot rewrite the original request either.
    expect(() => guardAcceptanceBarTemplateDataWrite({ slug: 'export', storedTemplateData: data,
      nextTemplateData: { ...data, criteria: [{ ...canonical, intent: { request: 'Only first-page export.' } }] },
    })).toThrow('BAR meaning cannot change');
  });

  it('normalizes explicit template-data sections without persisting duplicate fields', () => {
    const canonical = normalizeAcceptanceBarCriterion(requirement);
    const parsed = rubricTemplateDataAuthoringSchema.parse({ kind: 'acceptance', subjectPlan: 'export',
      characteristic: 'export', ratingScale: ['healthy', 'broken', 'unknown'],
      criteria: [{ ...requirement, barHash: canonical.barHash }] });
    expect(normalizeAcceptanceBarCriterion(parsed.criteria[0]!)).toMatchObject(canonical);
    expect(parsed.criteria[0]).not.toHaveProperty('acceptance');
    expect(parsed.criteria[0]).not.toHaveProperty('verification');
  });

  /**
   * PERMANENT NEGATIVE CONTROL — falsifiability proof for AUTO-BAR-R-1-P-001 (P-006).
   *
   * The alias-conflict guard is what stops a wire alias silently overwriting the
   * canonical promise, and a guard that has never failed is a guard nobody has
   * tested. So the deliberately-wrong implementation lives HERE, in the test file,
   * permanently: production code is never mutated to prove this (CLAUDE.md forbids
   * proving falsifiability by mutating the shared tree, because git-sync can commit
   * the mutant mid-probe).
   *
   * The wrong oracle is the exact `!==` -> `===` inversion of the comparison at
   * requirement-contract.ts:68. Both directions are covered on purpose: a predicate
   * forced always-on and one forced always-off fail differently, and either alone
   * leaves the other half unproven. The `conflicts: false` rows are the calibration
   * — without them a subject that simply threw on everything would pass.
   */
  const comparable = (value: unknown): unknown => {
    // Mirrors the module-private comparable() at requirement-contract.ts:50, so the
    // control differs from the subject in exactly one place: the conflict predicate.
    if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').trim();
    if (Array.isArray(value)) return value.map(comparable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, comparable(v)]),
    );
    return value;
  };

  it.each([
    { label: 'a conflicting model alias', overlay: { model: 'Only export the first page.' },
      alias: 'Only export the first page.', canonical: requirement.acceptance.condition, conflicts: true },
    { label: 'an equivalent model alias differing only by whitespace', overlay: { model: `  ${requirement.acceptance.condition}\r\n` },
      alias: `  ${requirement.acceptance.condition}\r\n`, canonical: requirement.acceptance.condition, conflicts: false },
    { label: 'a conflicting requiredTestLayers alias', overlay: { requiredTestLayers: ['unit'] },
      alias: ['unit'], canonical: requirement.acceptance.requiredTestLayers, conflicts: true },
    { label: 'an equivalent requiredTestLayers alias in a different order', overlay: { requiredTestLayers: ['e2e', 'integration'] },
      alias: ['e2e', 'integration'], canonical: requirement.acceptance.requiredTestLayers, conflicts: false },
  ])('negative control: the guard follows the real comparison and contradicts the inverted one for $label', ({ overlay, alias, canonical, conflicts }) => {
    const correctOracle = JSON.stringify(comparable(alias)) !== JSON.stringify(comparable(canonical));
    const invertedOracle = JSON.stringify(comparable(alias)) === JSON.stringify(comparable(canonical));

    // The two oracles must genuinely disagree, or this control proves nothing.
    expect(correctOracle).toBe(conflicts);
    expect(invertedOracle).toBe(!conflicts);

    const subject = () => normalizeRequirementSections({ ...requirement, ...overlay });
    if (conflicts) expect(subject).toThrow('requirement_alias_conflict');
    else expect(subject).not.toThrow();
  });

  it('reads persisted intent, canonical acceptance and method through the existing rubric store', () => {
    const canonical = normalizeAcceptanceBarCriterion(requirement);
    const rubric = planRowToRubric({
      plan_slug: 'acceptance-export', workspace_id: 'test-workspace', harness_slug: 'test-harness',
      title: 'Export', status: 'active', created: '2026-09-05', updated: '2026-09-05',
      updated_at: '2026-09-05T00:00:00Z', version: 2, owner: 'author', archived: false,
      template_data: { kind: 'acceptance', subjectPlan: 'export', characteristic: 'export', criteria: [canonical], ratingScale: ['healthy', 'broken', 'unknown'] },
    });
    expect(rubric).not.toBeNull();
    expect(requirementSections(rubric!.criteria[0]!)).toMatchObject({
      intent: requirement.intent, acceptance: { condition: requirement.acceptance.condition },
      verification: { method: requirement.verification.method },
    });
  });
});
