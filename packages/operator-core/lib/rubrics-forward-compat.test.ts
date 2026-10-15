import { describe, expect, it } from 'vitest';
import { assertRubricWritable, existingRubricRowForSeed, planRowToRubric } from './rubrics';
import { stripUnknownRubricKeys } from './agent-tools/plans/rubric-template';

// WI-10002803: goal-mode-e2e revision 46 carries a TOP-LEVEL field (`gradingAuthority`) added by
// a newer build. The release build's strict read projected nothing, so the rubric vanished from
// rubrics:get, grading and the Learning tab's definition view. The criterion-only tolerant retry
// (acceptance-runtime-plane P-002) could not help because the unknown key was not in a criterion.

const criterion = {
  key: 'never-implements',
  title: 'Never implements',
  model: 'the goal owner files work, never edits',
  method: 'edit_attribution_ledger rows by the owner',
  driftMarkers: 'any edit-claim',
};
const cleanCheck = {
  kind: 'probe',
  probe: { kind: 'tool', tool: 'dev:build_status', args: {} },
  unit: 'ms',
  ratingBands: [{ rating: 'near', expect: { op: 'lte', value: 150 } }],
};
const cleanData = {
  characteristic: 'goal-mode',
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  criteria: [criterion],
};
// What a NEWER build wrote: one unknown top-level field and one unknown criterion field.
const newerBuildData = {
  ...cleanData,
  someFutureTopLevel: 'owner-authorized',
  criteria: [{
    ...criterion,
    check: {
      ...cleanCheck,
      futureProbePolicy: 'read-only',
      ratingBands: [{ ...cleanCheck.ratingBands[0], confidence: 'measured' }],
    },
    someFutureCriterionField: 1,
  }],
};
const compatibleNewerBuildData = {
  ...cleanData,
  criteria: [{ ...criterion, check: cleanCheck }],
};
const row = (templateData: unknown) =>
  ({
    plan_slug: 'goal-mode-e2e',
    workspace_id: 'ws',
    harness_slug: 'papercusp',
    title: 'Goal mode e2e',
    status: 'active',
    created: '2026-08-01',
    updated: '2026-08-01',
    updated_at: '2026-08-01T00:00:00.000Z',
    owner: 'su-author',
    archived: false,
    template_data: templateData,
  }) as Parameters<typeof planRowToRubric>[0];

describe('stripUnknownRubricKeys (WI-10002803)', () => {
  it('strips unknown top-level AND criterion keys and names each one', () => {
    const tolerant = stripUnknownRubricKeys(newerBuildData);
    expect(tolerant.stripped).toEqual([
      'someFutureTopLevel',
      'criteria[].check.futureProbePolicy',
      'criteria[].check.ratingBands[0].confidence',
      'criteria[].someFutureCriterionField',
    ]);
    expect(tolerant.data).toEqual(compatibleNewerBuildData);
  });

  it('is a no-op on data this build fully understands', () => {
    expect(stripUnknownRubricKeys(cleanData)).toEqual({ data: cleanData, stripped: [] });
  });
});

describe('planRowToRubric forward compatibility (WI-10002803)', () => {
  it('projects a rubric carrying a newer build’s top-level field instead of dropping it', () => {
    const rubric = planRowToRubric(row(newerBuildData));
    expect(rubric).not.toBeNull();
    expect(rubric!.criteria.map((c) => c.key)).toEqual(['never-implements']);
    expect(rubric!.readCompat).toEqual({
      strippedKeys: [
        'someFutureTopLevel',
        'criteria[].check.futureProbePolicy',
        'criteria[].check.ratingBands[0].confidence',
        'criteria[].someFutureCriterionField',
      ],
    });
    expect(rubric!.criteria[0]!.check).toEqual(cleanCheck);
  });

  it('still refuses a malformed KNOWN field — tolerance never masks corruption', () => {
    expect(planRowToRubric(row({ ...newerBuildData, ratingScale: 'not-an-array' }))).toBeNull();
  });

  it('marks nothing on a fully understood rubric', () => {
    expect(planRowToRubric(row(cleanData))!.readCompat).toBeUndefined();
  });
});

describe('write guards for rubrics read through the tolerant path (WI-10002803)', () => {
  it('refuses a rebuild-and-write from a lossy projection, naming the fields it would delete', () => {
    const lossy = planRowToRubric(row(newerBuildData))!;
    expect(() => assertRubricWritable(lossy, 'rubrics:amend')).toThrow(
      /rubric_newer_than_this_build: rubrics:amend: .*someFutureTopLevel/,
    );
    expect(() => assertRubricWritable(planRowToRubric(row(cleanData))!, 'rubrics:amend')).not.toThrow();
  });

  it('never lets the seeder treat a newer build’s rubric as a wedged placeholder or upgrade it', () => {
    const newer = existingRubricRowForSeed('su-agent-behavior', 'first-party-bundle', newerBuildData);
    // valid ⇒ not reclaimed (WI-3617); no templateData ⇒ the content-drift upgrade skips it.
    expect(newer).toEqual({ rubricId: 'su-agent-behavior', owner: 'first-party-bundle', valid: true });

    const wedged = existingRubricRowForSeed('su-agent-behavior', 'first-party-bundle', { criteria: 'broken' });
    expect(wedged.valid).toBe(false);

    const clean = existingRubricRowForSeed('su-agent-behavior', 'first-party-bundle', cleanData);
    expect(clean.valid).toBe(true);
    expect(clean.templateData).toBeTruthy();
  });
});
