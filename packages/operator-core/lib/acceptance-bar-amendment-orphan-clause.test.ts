import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ setSpecClause: vi.fn() }));

vi.mock('./agent-tools/plans/spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/plans/spec-clauses-store')>()),
  setSpecClause: h.setSpecClause,
}));

import {
  synchronizeAcceptanceBarRevision,
  validateAcceptanceBarRevisionProjectionPreview,
} from './acceptance-bar-amendment';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';
import { specClauseWriteIssues } from './agent-tools/plans/spec-clauses-store';
import { AcceptanceBarCandidateError } from './acceptance-bar-projection';

// Mirrors the fixture in acceptance-bar-amendment.test.ts. R-1 mapped to P-001 is what
// makes the canonical identity `AUTO-BAR-R-1-P-001` -- the exact clause that wedged the
// activation audit in EI-23816909807579931.
function subjectPlan(mapRow = '| R-1 | P-001 | tree |'): string {
  return `---
title: Subject plan
slug: subject-plan
status: active
created: 2026-09-06
updated: 2026-09-06
---

# Subject plan

## Now

**State:** working

**Next:** keep going

## Requirements

**R-1 — Canonical outcome.** The writer persists one canonical BAR.

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
${mapRow}

## Phase 1 — Build

- **P-001** \`todo\` persist the canonical BAR
- **P-002** \`todo\` consume the canonical BAR
`;
}

function seedTemplateData(planContent = subjectPlan()) {
  const seeded = buildAcceptanceBarSeed({
    planSlug: 'subject-plan',
    planContent,
    actorId: 'seed-author',
    declaredAt: '2026-09-06T00:00:00.000Z',
    cohort: 'post-epoch',
    adoptionEpoch: 1,
    subjectPlanRevision: 2,
    planStatus: 'active',
    rubricSlug: 'acceptance-subject-plan',
    rubricRevision: 4,
  });
  if (!seeded.ok) throw new Error('fixture seed failed');
  return seeded.templateData;
}

/** One row of the clause-projection SELECT, defaulting to a healthy bar-linked clause. */
function clauseRow(overrides: Record<string, unknown> = {}) {
  return {
    spec_id: 'AUTO-BAR-R-1-P-001',
    source_val_id: null,
    current_revision: 1,
    source_bar_key: 'R-1',
    source_bar_hash: 'stored-bar-hash',
    plan_item_id: 'P-001',
    behavior: 'The writer persists one canonical BAR.',
    behavior_class: 'observable',
    falsifier: null,
    required_evidence: ['tree'],
    required_test_layers: [],
    mutation_required: false,
    lifecycle_status: 'active',
    supersedes_spec_id: null,
    supersedes_revision: null,
    exemption: null,
    ...overrides,
  };
}

/**
 * `rows` is what the clause-projection SELECT returns. The amendment re-reads that
 * projection after its repair pass, so `rowsAfterRepair` models the write landing --
 * without it a create is correctly reported as still-missing. Everything else is stubbed
 * to the minimum the transaction needs, so the only variable under test is what the
 * amendment believes about an already-stored clause.
 */
function sqlStub(
  rows: unknown[],
  rowsAfterRepair: unknown[] = rows,
  currentPlanContent = subjectPlan(),
) {
  let clauseReads = 0;
  const clauseQueries: Array<{ statement: string; values: unknown[] }> = [];
  const fn = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join(' ');
    if (statement.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
    if (statement.includes('SELECT plan_slug, content')) {
      return [{ plan_slug: 'subject-plan', content: currentPlanContent }];
    }
    if (statement.includes('FROM harness_shared.plan_spec_clauses c')) {
      clauseQueries.push({ statement, values });
      clauseReads += 1;
      return clauseReads === 1 ? rows : rowsAfterRepair;
    }
    return [];
  });
  return Object.assign(fn, { clauseQueries });
}

function runAmendment(
  sql: ReturnType<typeof sqlStub>,
  options: { templateData?: unknown; previousTemplateData?: unknown } = {},
) {
  return synchronizeAcceptanceBarRevision(sql as never, {
    workspaceId: 'workspace',
    harnessSlug: 'papercusp',
    rubricSlug: 'acceptance-subject-plan',
    rubricRevision: 4,
    templateData: options.templateData ?? seedTemplateData(),
    previousTemplateData: options.previousTemplateData,
    actorId: 'amender',
  });
}

describe('complete generated candidate preflight (P-002)', () => {
  function preview(rows: unknown[], templateData = seedTemplateData(), rubricRevision = 4) {
    return validateAcceptanceBarRevisionProjectionPreview(sqlStub(rows) as never, {
      workspaceId: 'workspace', harnessSlug: 'papercusp', rubricSlug: 'acceptance-subject-plan',
      rubricRevision, templateData, previousTemplateData: templateData,
    });
  }

  it('collects independent defects retained in generated specifications before writes', async () => {
    const data = seedTemplateData();
    const row = clauseRow({
      source_bar_hash: data.criteria[0]!.barHash,
      required_test_layers: ['unrecordable-layer'],
      falsifier: { observation: ' ' },
    });
    await expect(preview([row], data, 0)).rejects.toThrow(
      /test_layers_invalid.*falsifier_invalid.*bar_pin_invalid/,
    );
    expect(h.setSpecClause).not.toHaveBeenCalled();
  });

  it('uses the immutable writer validator for malformed generated fields', async () => {
    const data = seedTemplateData();
    const falsifier = { observation: 'The wrong BAR is retained.', requiredScenarios: ['same', 'same'] };
    const row = clauseRow({
      source_bar_hash: data.criteria[0]!.barHash,
      falsifier,
    });
    const expected = specClauseWriteIssues({
      specId: row.spec_id, expectedRevision: 1, planItemId: 'P-001',
      behavior: row.behavior, behaviorClass: 'happy-path', lifecycleStatus: 'active',
      falsifier,
    });
    expect(expected).toEqual([{ status: 'falsifier_invalid', specId: row.spec_id, reason: 'required_scenario_duplicate' }]);
    await expect(preview([row], data)).rejects.toThrow(JSON.stringify(expected[0]));
  });

  it('returns consolidated semantic failures bound to the whole failed candidate', async () => {
    const data = seedTemplateData();
    const row = clauseRow({
      source_bar_hash: data.criteria[0]!.barHash,
      behavior: 'The writer works; the reader works.',
      falsifier: { observation: ' ' },
    });
    const failure = await preview([row], data).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcceptanceBarCandidateError);
    const validation = (failure as AcceptanceBarCandidateError).candidateValidation;
    expect(validation).toMatchObject({ status: 'failed', candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(validation.issues.join('; ')).toMatch(/falsifier_invalid.*behavior.atomicity/);
    const repeated = await preview([row], data).catch((error: AcceptanceBarCandidateError) => error.candidateValidation);
    expect(repeated).toEqual(validation);
    const changed = await preview([{ ...row, behavior: 'The reader works; the writer works.' }], data)
      .catch((error: AcceptanceBarCandidateError) => error.candidateValidation);
    expect(changed).not.toEqual(validation);
    expect(h.setSpecClause).not.toHaveBeenCalled();
  });

  it('binds a corrected preflight pass to the exact normalized candidate and generated refinements', async () => {
    const data = seedTemplateData();
    const falsifier = { observation: 'The wrong BAR is retained.', probeMethod: 'Read the immutable revision.' };
    const row = clauseRow({
      source_bar_hash: data.criteria[0]!.barHash,
      falsifier,
    });
    const first = await preview([row], data);
    expect(first).toMatchObject({ candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/), generatedSpecCount: 1 });
    expect(await preview([row], data)).toEqual(first);
    const changed = await preview([{ ...row, falsifier: { ...falsifier, probeMethod: 'Read the replaced revision.' } }], data);
    expect(changed!.candidateHash).not.toBe(first!.candidateHash);
    const changedCriterion = structuredClone(data);
    changedCriterion.criteria[0]!.method = 'Read the complete revision history.';
    expect((await preview([row], changedCriterion))!.candidateHash).not.toBe(first!.candidateHash);
    expect(h.setSpecClause).not.toHaveBeenCalled();
  });
});

describe('plan-only BAR mapping (EI-25651776897214505)', () => {
  const extendedPlan = subjectPlan('| R-1 | P-001 | tree |\n| R-2 | P-002 | tree |')
    .replace('## Design', '**R-2 — Second outcome.** The reader consumes the canonical BAR.\n\n## Design');

  beforeEach(() => h.setSpecClause.mockReset());

  function preview(templateData = seedTemplateData()) {
    return validateAcceptanceBarRevisionProjectionPreview(
      sqlStub([clauseRow()], undefined, extendedPlan) as never,
      {
        workspaceId: 'workspace', harnessSlug: 'papercusp',
        rubricSlug: 'acceptance-subject-plan', rubricRevision: 4, templateData,
      },
    );
  }

  it('refuses a preview when a mapped plan BAR is absent from the candidate rubric', async () => {
    await expect(preview()).rejects.toThrow('acceptance_bar_revision_mapping_missing:R-2');
    expect(h.setSpecClause).not.toHaveBeenCalled();
  });

  it('refuses the same missing BAR on apply before any projection write', async () => {
    await expect(runAmendment(sqlStub([clauseRow()], undefined, extendedPlan)))
      .rejects.toThrow('acceptance_bar_revision_mapping_missing:R-2');
    expect(h.setSpecClause).not.toHaveBeenCalled();
  });

  it('allows a preview that adds the mapped BAR even before its clause exists', async () => {
    await expect(preview(seedTemplateData(extendedPlan))).resolves.toMatchObject({
      candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/), generatedSpecCount: 2,
    });
    expect(h.setSpecClause).not.toHaveBeenCalled();
  });
});

function writeFor(specId: string) {
  return h.setSpecClause.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((write) => write.specId === specId);
}

// A clause whose current revision lost its bar linkage: a write that omitted `sourceBar`
// NULLed source_bar_key, but the row is emphatically present -- at revision 2.
const orphaned = (overrides: Record<string, unknown> = {}) => clauseRow({
  current_revision: 2,
  source_bar_key: null,
  source_bar_hash: null,
  ...overrides,
});

describe('AUTO-BAR clause whose bar linkage was lost (EI-23816909807579931)', () => {
  beforeEach(() => {
    h.setSpecClause.mockReset();
    h.setSpecClause.mockResolvedValue({
      status: 'revised', specId: 'AUTO-BAR-R-1-P-001', revision: 3,
    });
  });

  it('re-projects an existing clause at its REAL revision instead of creating it at 0', async () => {
    await runAmendment(sqlStub([orphaned()]));

    const write = writeFor('AUTO-BAR-R-1-P-001');
    expect(write).toBeDefined();
    // The defect: the clause was invisible to the projection query, so it was treated as
    // absent and written with expectedRevision 0 against a row at 2 -- a CAS conflict on
    // every retry, and the failing operation was the only one that could have healed it.
    expect(write!.expectedRevision).toBe(2);
  });

  it('restores the missing bar linkage rather than leaving the clause orphaned', async () => {
    await runAmendment(sqlStub([orphaned()]));

    const write = writeFor('AUTO-BAR-R-1-P-001');
    expect((write!.sourceBar as { barKey?: string } | undefined)?.barKey).toBe('R-1');
    // Healing must not silently demote a live clause back to draft: this one is active.
    expect(write!.lifecycleStatus).toBe('active');
  });

  it('still CREATES a genuinely absent clause at revision 0', async () => {
    // Calibration. Without this, widening clause ownership could pass the cases above
    // simply by never using 0 again -- which would break first-time projection instead.
    await runAmendment(sqlStub([], [clauseRow({ lifecycle_status: 'draft' })]));

    const write = writeFor('AUTO-BAR-R-1-P-001');
    expect(write).toBeDefined();
    expect(write!.expectedRevision).toBe(0);
    expect(write!.lifecycleStatus).toBe('draft');
  });

  it('asks the database for clauses by canonical identity, not by bar linkage alone', async () => {
    // The cases above stub the SELECT's result, so they pin the inference but cannot see
    // the predicate. In production the predicate is half the fix: filtering on
    // source_bar_key alone is what hid the row in the first place.
    const sql = sqlStub([orphaned()]);
    await runAmendment(sql);

    const [projection] = sql.clauseQueries;
    expect(projection).toBeDefined();
    expect(projection!.statement).toContain('c.spec_id = ANY(');
    expect(projection!.values.flat()).toContain('AUTO-BAR-R-1-P-001');
  });

  it('retires a prior generated pair when an approved map amendment moves the BAR to another item', async () => {
    const priorPlan = subjectPlan();
    const currentPlan = subjectPlan('| R-1 | P-002 | tree |');
    const priorTemplateData = seedTemplateData(priorPlan);
    const currentTemplateData = seedTemplateData(currentPlan);
    const oldClause = clauseRow({ spec_id: 'AUTO-BAR-R-1-P-001', plan_item_id: 'P-001' });
    const newClause = clauseRow({
      spec_id: 'AUTO-BAR-R-1-P-002',
      plan_item_id: 'P-002',
      lifecycle_status: 'draft',
    });
    h.setSpecClause.mockImplementation(async (write: Record<string, unknown>) => ({
      status: write.specId === 'AUTO-BAR-R-1-P-002' ? 'created' : 'revised',
      specId: write.specId,
      revision: write.specId === 'AUTO-BAR-R-1-P-002' ? 1 : 2,
    }));
    const sql = sqlStub([oldClause], [oldClause, newClause], currentPlan);

    await runAmendment(sql, {
      templateData: currentTemplateData,
      previousTemplateData: priorTemplateData,
    });

    const retired = writeFor('AUTO-BAR-R-1-P-001');
    expect(retired).toMatchObject({
      expectedRevision: 1,
      lifecycleStatus: 'superseded',
      acceptanceRef: null,
      sourceBar: null,
    });
    expect(retired!.behavior).toContain('pair is absent from the current map');
    // The old revision keeps the prior behavior; only its current lifecycle is retired.
    expect(retired!.planItemId).toBe('P-001');
    const replacement = writeFor('AUTO-BAR-R-1-P-002');
    expect(replacement).toMatchObject({ expectedRevision: 0, lifecycleStatus: 'draft', planItemId: 'P-002' });
  });

  it('uses the canonical generated pair to retire a stale clause whose source BAR pin was lost', async () => {
    const priorPlan = subjectPlan();
    const currentPlan = subjectPlan('| R-1 | P-002 | tree |');
    const oldClause = orphaned({
      spec_id: 'AUTO-BAR-R-1-P-001',
      plan_item_id: 'P-001',
    });
    const newClause = clauseRow({
      spec_id: 'AUTO-BAR-R-1-P-002',
      plan_item_id: 'P-002',
      lifecycle_status: 'draft',
    });
    h.setSpecClause.mockImplementation(async (write: Record<string, unknown>) => ({
      status: write.specId === 'AUTO-BAR-R-1-P-002' ? 'created' : 'revised',
      specId: write.specId,
      revision: write.specId === 'AUTO-BAR-R-1-P-002' ? 1 : 3,
    }));
    const sql = sqlStub([oldClause], [oldClause, newClause], currentPlan);

    await runAmendment(sql, {
      templateData: seedTemplateData(currentPlan),
      previousTemplateData: seedTemplateData(priorPlan),
    });

    expect(sql.clauseQueries[0]!.statement).toContain("c.spec_id ~ '^AUTO-BAR-R-[0-9]+-P-[0-9]{3,}$'");
    expect(writeFor('AUTO-BAR-R-1-P-001')).toMatchObject({ lifecycleStatus: 'superseded', sourceBar: null });
  });

  it('leaves a reviewed non-canonical clause tied to the old item intact as an additive contract', async () => {
    const priorPlan = subjectPlan();
    const currentPlan = subjectPlan('| R-1 | P-002 | tree |');
    const currentTemplateData = seedTemplateData(currentPlan);
    const currentCriteria = currentTemplateData.criteria as Array<{ barHash: string }>;
    const reviewed = clauseRow({
      spec_id: 'AUTO-BAR-R-1-P-001-reviewed',
      source_bar_hash: currentCriteria[0]!.barHash,
      plan_item_id: 'P-001',
      behavior: 'Reviewed atomic proof remains bound to its authored outcome.',
    });
    const newClause = clauseRow({
      spec_id: 'AUTO-BAR-R-1-P-002',
      plan_item_id: 'P-002',
      lifecycle_status: 'draft',
    });
    h.setSpecClause.mockImplementation(async (write: Record<string, unknown>) => ({
      status: write.specId === 'AUTO-BAR-R-1-P-002' ? 'created' : 'revised',
      specId: write.specId,
      revision: 1,
    }));
    const sql = sqlStub([reviewed], [reviewed, newClause], currentPlan);

    await runAmendment(sql, {
      templateData: currentTemplateData,
      previousTemplateData: seedTemplateData(priorPlan),
    });

    expect(writeFor('AUTO-BAR-R-1-P-001-reviewed')).toMatchObject({
      lifecycleStatus: 'active',
      behavior: 'Reviewed atomic proof remains bound to its authored outcome.',
      planItemId: 'P-001',
    });
  });
});

// WI-10004061: an amendment that DROPS a BAR supersedes its generated projection. The
// NEXT amendment must treat that row as finished business. Its BAR is absent from both
// the current and the previous rubric, and the retire branch used to read that as
// `unmapped`, so any plan that had ever dropped a BAR could never be amended again.
describe('generated projection retired by an EARLIER amendment (WI-10004061)', () => {
  // R-9 is in neither the current nor the previous fixture rubric (both carry only R-1).
  const retiredEarlier = (overrides: Record<string, unknown> = {}) => clauseRow({
    spec_id: 'AUTO-BAR-R-9-P-001',
    plan_item_id: 'P-001',
    current_revision: 4,
    source_bar_key: null,
    source_bar_hash: null,
    lifecycle_status: 'superseded',
    behavior: 'RETIRED with acceptance bar R-9 (rubric acceptance-subject-plan rev 3).',
    ...overrides,
  });

  beforeEach(() => {
    h.setSpecClause.mockReset();
    h.setSpecClause.mockImplementation(async (write: Record<string, unknown>) => ({
      status: 'revised', specId: write.specId, revision: 2,
    }));
  });

  it.each(['superseded', 'retired'])('leaves an already-%s projection alone instead of refusing the amendment', async (status) => {
    const sql = sqlStub([clauseRow(), retiredEarlier({ lifecycle_status: status })]);

    await expect(runAmendment(sql, { previousTemplateData: seedTemplateData() })).resolves.toBeDefined();

    expect(writeFor('AUTO-BAR-R-9-P-001')).toBeUndefined();
  });

  it('still refuses a LIVE generated projection whose BAR is unknown to both rubrics', async () => {
    // Calibration: the skip must be about the terminal lifecycle, not about the unknown
    // BAR. Without this the fix could pass by swallowing every unmapped projection.
    const sql = sqlStub([clauseRow(), retiredEarlier({ lifecycle_status: 'active' })]);

    await expect(runAmendment(sql, { previousTemplateData: seedTemplateData() }))
      .rejects.toThrow('acceptance_bar_revision_projection_unmapped:AUTO-BAR-R-9-P-001');
  });

  it.each(['superseded', 'retired'] as const)(
    're-enters the draft activation pipeline when a %s clause pair returns to the current map',
    async (lifecycleStatus) => {
      // A re-added BAR must not be skipped merely because its old projection was retired.
      const sql = sqlStub([orphaned({ lifecycle_status: lifecycleStatus, current_revision: 3 })]);

      await runAmendment(sql, { previousTemplateData: seedTemplateData() });

      const write = writeFor('AUTO-BAR-R-1-P-001');
      expect(write).toBeDefined();
      expect(write!.expectedRevision).toBe(3);
      expect(write!.lifecycleStatus).toBe('draft');
    },
  );
});
