/**
 * review-system-rework-reduction-2026-09-23 P-001 — stable clause identity.
 *
 * An acceptance-BAR amendment re-projects every AUTO-BAR clause. Before P-001 each
 * re-projection carried the rubric-wide provenance (BAR-set hash, rubric revision, the
 * revision inside acceptanceRef) into the clause's content hash, so an amendment that
 * touched ONE bar minted a new revision for EVERY clause, re-keying their evidence and
 * scorecards (D-003: 4 of R-11's 7 revisions changed only the set hash).
 *
 * The oracle for "what the store holds" is a hash computed here from fixture literals at
 * rubric revision 3 — not by the code under test — and the amendment runs at revision 4
 * with a different BAR-set hash.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ setSpecClause: vi.fn() }));

vi.mock('./agent-tools/plans/spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/plans/spec-clauses-store')>()),
  setSpecClause: h.setSpecClause,
}));

import {
  isProvenanceOnlyReprojection,
  synchronizeAcceptanceBarRevision,
} from './acceptance-bar-amendment';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';
import { specClauseContentHash, type SpecClauseWrite } from './agent-tools/plans/spec-clauses-store';
import { computeAcceptanceBarHash, computeAcceptanceBarSetHash, formatRubricRevisionSnapshot } from './rubrics';

const RUBRIC = 'acceptance-subject-plan';
const OLD_SET_HASH = 'a'.repeat(64);

function subjectPlan(withR2 = true): string {
  const r2Requirement = withR2 ? '\n**R-2 — Second outcome.** The reader consumes the canonical BAR.\n' : '';
  const r2Map = withR2 ? '\n| R-2 | P-002 | tree |' : '';
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
${r2Requirement}
## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |${r2Map}

## Phase 1 — Build

- **P-001** \`todo\` persist the canonical BAR
- **P-002** \`todo\` consume the canonical BAR
`;
}

type Criterion = {
  key: string; barKey?: string; barHash?: string; evidencePlane?: 'tree' | 'deployed' | 'live';
};

function seedTemplateData(withR2 = true): { criteria: Criterion[]; barSetHash: string } {
  const seeded = buildAcceptanceBarSeed({
    planSlug: 'subject-plan',
    planContent: subjectPlan(withR2),
    actorId: 'seed-author',
    declaredAt: '2026-09-06T00:00:00.000Z',
    cohort: 'post-epoch',
    adoptionEpoch: 1,
    subjectPlanRevision: 2,
    planStatus: 'active',
    rubricSlug: RUBRIC,
    rubricRevision: 4,
  });
  if (!seeded.ok) throw new Error('fixture seed failed');
  return seeded.templateData as never;
}

const template = seedTemplateData();
const criterionOf = (barKey: string): Criterion => {
  const found = template.criteria.find((entry) => (entry.barKey ?? entry.key) === barKey);
  if (!found?.barHash || !found.evidencePlane) throw new Error(`fixture criterion ${barKey} incomplete`);
  return found;
};

/** The clause as the store wrote it at rubric revision 3 under an OLDER bar set. */
function storedClause(barKey: string, planItemId: string, overrides: {
  barHash?: string; rubricSlug?: string; storedSetHash?: string | null; storedRubricRevision?: number | null;
  behaviorClass?: SpecClauseWrite['behaviorClass']; mutationRequired?: boolean; requiredTestLayers?: string[];
} = {}) {
  const criterion = criterionOf(barKey);
  const specId = `AUTO-BAR-${barKey}-${planItemId}`;
  const row = {
    spec_id: specId,
    source_val_id: null,
    current_revision: 5,
    source_bar_key: barKey,
    source_bar_hash: overrides.barHash ?? criterion.barHash!,
    plan_item_id: planItemId,
    behavior: `Reviewed atomic behavior for ${barKey}.`,
    behavior_class: overrides.behaviorClass ?? 'happy-path',
    falsifier: null,
    required_evidence: ['tree'],
    required_test_layers: overrides.requiredTestLayers ?? [],
    mutation_required: overrides.mutationRequired ?? false,
    lifecycle_status: 'active' as const,
    supersedes_spec_id: null,
    supersedes_revision: null,
    exemption: null,
    acceptance_ref: `${RUBRIC}@3:${barKey}`,
    source_bar_set_hash: overrides.storedSetHash === undefined ? OLD_SET_HASH : overrides.storedSetHash,
    source_rubric_revision: overrides.storedRubricRevision === undefined ? 3 : overrides.storedRubricRevision,
  };
  const storedWrite: SpecClauseWrite = {
    planSlug: 'subject-plan', specId, expectedRevision: 4, planItemId,
    behavior: row.behavior, behaviorClass: row.behavior_class,
    requiredEvidence: row.required_evidence, requiredTestLayers: row.required_test_layers,
    mutationRequired: row.mutation_required, lifecycleStatus: 'active', exemption: null, supersedes: null, falsifier: null,
    acceptanceRef: row.acceptance_ref,
    sourceBar: {
      barKey, barHash: row.source_bar_hash, barSetHash: OLD_SET_HASH,
      rubricSlug: overrides.rubricSlug ?? RUBRIC, rubricRevision: 3, evidencePlane: criterion.evidencePlane!,
    },
    actorId: 'earlier-amender',
  };
  return { ...row, content_hash: specClauseContentHash(storedWrite) };
}

/** `rowsAfterCreate` models a create landing: the amendment re-reads the projection after it. */
function sqlStub(rows: unknown[], rowsAfterCreate: unknown[] = rows, planContent = subjectPlan(),
  snapshots = [formatRubricRevisionSnapshot('', { ...template, barSetHash: OLD_SET_HASH }, null, 3)]) {
  let clauseReads = 0;
  return vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join(' ');
    if (statement.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
    if (statement.includes('SELECT plan_slug, content')) return [{ plan_slug: 'subject-plan', content: planContent }];
    if (statement.includes('FROM harness_shared.plan_spec_clauses c')) {
      clauseReads += 1;
      return clauseReads === 1 ? rows : rowsAfterCreate;
    }
    if (statement.includes('FROM harness_shared.plan_revisions')) {
      return snapshots.map((content_snapshot) => ({ content_snapshot }));
    }
    return [];
  });
}

function amend(rows: unknown[], rowsAfterCreate?: unknown[], opts: { withR2?: boolean } = {}) {
  const withR2 = opts.withR2 ?? true;
  return synchronizeAcceptanceBarRevision(sqlStub(rows, rowsAfterCreate, subjectPlan(withR2)) as never, {
    workspaceId: 'workspace', harnessSlug: 'papercusp', rubricSlug: RUBRIC, rubricRevision: 4,
    templateData: withR2 ? template : seedTemplateData(false), previousTemplateData: template, actorId: 'amender',
  });
}

const writtenSpecIds = () =>
  h.setSpecClause.mock.calls.map((call) => (call[0] as { specId: string }).specId);

describe('P-001 stable clause identity across acceptance-BAR amendments', () => {
  beforeEach(() => {
    h.setSpecClause.mockReset();
    h.setSpecClause.mockImplementation(async (write: { specId: string; expectedRevision: number }) => ({
      status: 'revised', specId: write.specId, revision: write.expectedRevision + 1,
    }));
  });

  it('fixture sanity: the amendment runs under a different BAR set than the stored clauses', () => {
    expect(template.barSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(template.barSetHash).not.toBe(OLD_SET_HASH);
  });

  it('repairs an existing neutral class when its unchanged tree BAR is explicitly manual', async () => {
    const criteria = template.criteria.map((criterion) => {
      if (criterion.barKey !== 'R-1') return criterion;
      const manual = { ...criterion, check: { kind: 'instrument' as const, instrumentKey: 'none' } };
      return { ...manual, barHash: computeAcceptanceBarHash(manual) };
    });
    const row = storedClause('R-1', 'P-001', { barHash: criteria[0]!.barHash });
    const manualTemplate = { ...template, criteria, barSetHash: computeAcceptanceBarSetHash(criteria) };
    const rows = [row, storedClause('R-2', 'P-002')];
    // The sync judges the whole projection population, including the unchanged
    // sibling. A missing fixture row is a mapping error, not a classifier verdict.
    expect(rows.map((entry) => entry.source_bar_key).sort()).toEqual(criteria.map((entry) => entry.barKey).sort());
    await synchronizeAcceptanceBarRevision(sqlStub(rows) as never, {
      workspaceId: 'workspace', harnessSlug: 'papercusp', rubricSlug: RUBRIC, rubricRevision: 4,
      templateData: manualTemplate, previousTemplateData: manualTemplate, actorId: 'amender',
    });
    expect(h.setSpecClause).toHaveBeenCalled();
    expect(h.setSpecClause.mock.calls.find(([write]) => write.specId === row.spec_id)?.[0]).toMatchObject({
      behaviorClass: 'non-automated', behavior: row.behavior, requiredTestLayers: [], mutationRequired: false,
    });
  });

  // WI-6554700010009658: an approved amendment that rewords a BAR AND removes its
  // layers took the full-rewrite path, whose `criterion.requiredTestLayers ??
  // clause.required_test_layers` fallback kept the removed parent layer. The clause
  // then made an explicitly-manual BAR "owe automated proof" and plans:start refused
  // (mobile-agent-sessions-2026-10-12 R-17: iPhone -> iOS reword + e2e removed).
  it.each([
    { authored: [] as string[], expected: [] as string[] },
    { authored: ['integration'], expected: ['integration'] },
  ])('drops a removed parent layer when the same amendment also rewords the BAR, keeping authored extras %j', async ({ authored, expected }) => {
    type Bar = Criterion & { model?: string; requiredTestLayers?: string[]; check?: unknown };
    const priorCriteria = (template.criteria as Bar[]).map((criterion) => {
      if (criterion.barKey !== 'R-1') return criterion;
      const automated = { ...criterion, requiredTestLayers: ['e2e'] };
      return { ...automated, barHash: computeAcceptanceBarHash(automated as never) };
    });
    const priorR1 = priorCriteria.find((criterion) => criterion.barKey === 'R-1')!;
    const amendedCriteria = priorCriteria.map((criterion) => {
      if (criterion.barKey !== 'R-1') return criterion;
      const { requiredTestLayers: _removed, ...rest } = criterion;
      const manual = {
        ...rest,
        model: `${criterion.model ?? ''} (reworded)`,
        check: { kind: 'instrument' as const, instrumentKey: 'none' },
      };
      return { ...manual, barHash: computeAcceptanceBarHash(manual as never) };
    });
    const amendedR1 = amendedCriteria.find((criterion) => criterion.barKey === 'R-1')!;
    // Fixture sanity: restoring the prior layers + check does NOT reproduce the prior
    // hash, so this exercises the full-rewrite branch, not the layers-only one.
    expect(computeAcceptanceBarHash({ ...amendedR1, requiredTestLayers: priorR1.requiredTestLayers, check: priorR1.check } as never))
      .not.toBe(priorR1.barHash);
    const row = storedClause('R-1', 'P-001', { barHash: priorR1.barHash, requiredTestLayers: ['e2e', ...authored] });
    const rows = [row, storedClause('R-2', 'P-002')];
    const priorTemplate = { ...template, criteria: priorCriteria, barSetHash: computeAcceptanceBarSetHash(priorCriteria as never) };
    const amendedTemplate = { ...template, criteria: amendedCriteria, barSetHash: computeAcceptanceBarSetHash(amendedCriteria as never) };
    await synchronizeAcceptanceBarRevision(sqlStub(rows, rows, subjectPlan(), [
      formatRubricRevisionSnapshot('', { ...priorTemplate, barSetHash: OLD_SET_HASH }, null, 3),
    ]) as never, {
      workspaceId: 'workspace', harnessSlug: 'papercusp', rubricSlug: RUBRIC, rubricRevision: 4,
      templateData: amendedTemplate, previousTemplateData: priorTemplate, actorId: 'amender',
    });
    const write = h.setSpecClause.mock.calls.find(([candidate]) => candidate.specId === row.spec_id)?.[0];
    expect(write).toMatchObject({ requiredTestLayers: expected, mutationRequired: false });
    expect(write?.behaviorClass).toBe(expected.length === 0 ? 'non-automated' : 'happy-path');
  });

  it.each([
    { behaviorClass: 'concurrency' as const },
    { mutationRequired: true },
    { requiredTestLayers: ['integration'] },
  ])('retains a stronger authored obligation beside manual intent: %j', async (obligation) => {
    const criteria = template.criteria.map((criterion) => {
      if (criterion.barKey !== 'R-1') return criterion;
      const manual = { ...criterion, check: { kind: 'instrument' as const, instrumentKey: 'none' } };
      return { ...manual, barHash: computeAcceptanceBarHash(manual) };
    });
    const row = storedClause('R-1', 'P-001', { barHash: criteria[0]!.barHash, ...obligation });
    // The changed sibling is the positive control: the mechanism must still
    // perform real projection work while retaining R-1's stronger obligation.
    const rows = [row, storedClause('R-2', 'P-002', { barHash: 'b'.repeat(64) })];
    const manualTemplate = { ...template, criteria, barSetHash: computeAcceptanceBarSetHash(criteria) };
    const revisions = await synchronizeAcceptanceBarRevision(sqlStub(rows, rows, subjectPlan(), [
      formatRubricRevisionSnapshot('', { ...manualTemplate, barSetHash: OLD_SET_HASH }, null, 3),
    ]) as never, {
      workspaceId: 'workspace', harnessSlug: 'papercusp', rubricSlug: RUBRIC, rubricRevision: 4,
      templateData: manualTemplate, previousTemplateData: manualTemplate, actorId: 'amender',
    });
    expect(revisions.get(row.spec_id)).toBe(row.current_revision);
    expect(writtenSpecIds()).toEqual(['AUTO-BAR-R-2-P-002']);
    expect(revisions.get('AUTO-BAR-R-2-P-002')).toBe(6);
  });

  it('keeps every unchanged-bar clause at its revision: no write, no new revision', async () => {
    const revisions = await amend([storedClause('R-1', 'P-001'), storedClause('R-2', 'P-002')]);

    expect(writtenSpecIds()).toEqual([]);
    expect(revisions.get('AUTO-BAR-R-1-P-001')).toBe(5);
    expect(revisions.get('AUTO-BAR-R-2-P-002')).toBe(5);
  });

  it.each([
    ['missing', []],
    ['markdown-only', ['# Prior rubric without a structured revision']],
    ['ambiguous', Array(2).fill(formatRubricRevisionSnapshot('', { ...template, barSetHash: OLD_SET_HASH }, null, 3))],
    ['mismatched BAR set', [formatRubricRevisionSnapshot('', template, null, 3)]],
  ])('refreshes unchanged promises whose pinned history is %s', async (_kind, snapshots) => {
    const rows = [storedClause('R-1', 'P-001'), storedClause('R-2', 'P-002')];
    const revisions = await synchronizeAcceptanceBarRevision(sqlStub(rows, rows, subjectPlan(), snapshots as string[]) as never, {
      workspaceId: 'workspace', harnessSlug: 'papercusp', rubricSlug: RUBRIC, rubricRevision: 4,
      templateData: template, previousTemplateData: template, actorId: 'amender',
    });
    expect(writtenSpecIds()).toEqual(rows.map(row => row.spec_id));
    for (const [write] of h.setSpecClause.mock.calls) {
      const original = rows.find(row => row.spec_id === write.specId)!;
      expect(write).toMatchObject({ behavior: original.behavior, falsifier: original.falsifier,
        requiredTestLayers: original.required_test_layers, lifecycleStatus: original.lifecycle_status,
        sourceBar: { rubricRevision: 4, barHash: original.source_bar_hash, barSetHash: template.barSetHash } });
      expect(revisions.get(write.specId)).toBe(original.current_revision + 1);
    }
  });

  it('re-projects ONLY the clause whose own bar changed and leaves its sibling untouched', async () => {
    const revisions = await amend([
      storedClause('R-1', 'P-001', { barHash: 'b'.repeat(64) }),
      storedClause('R-2', 'P-002'),
    ]);

    expect(writtenSpecIds()).toEqual(['AUTO-BAR-R-1-P-001']);
    expect(revisions.get('AUTO-BAR-R-1-P-001')).toBe(6);
    expect(revisions.get('AUTO-BAR-R-2-P-002')).toBe(5);
  });

  it('creates the clause for an ADDED bar and leaves the existing sibling at its revision', async () => {
    const existing = storedClause('R-1', 'P-001');
    const created = { ...storedClause('R-2', 'P-002'), current_revision: 1, content_hash: 'fresh-create' };
    const revisions = await amend([existing], [existing, created]);

    expect(writtenSpecIds()).toEqual(['AUTO-BAR-R-2-P-002']);
    expect(h.setSpecClause.mock.calls[0]![0]).toMatchObject({ expectedRevision: 0 });
    expect(revisions.get('AUTO-BAR-R-1-P-001')).toBe(5);
  });

  it('retires the clause of a REMOVED bar and leaves the surviving sibling at its revision', async () => {
    const revisions = await amend([storedClause('R-1', 'P-001'), storedClause('R-2', 'P-002')], undefined, { withR2: false });

    expect(writtenSpecIds()).toEqual(['AUTO-BAR-R-2-P-002']);
    expect(h.setSpecClause.mock.calls[0]![0]).toMatchObject({ lifecycleStatus: 'superseded', sourceBar: null });
    expect(revisions.get('AUTO-BAR-R-1-P-001')).toBe(5);
  });

  it('still rewrites a clause whose rubric slug moved (the slug is part of its identity)', async () => {
    await amend([storedClause('R-1', 'P-001', { rubricSlug: 'acceptance-some-other-rubric' }), storedClause('R-2', 'P-002')]);

    expect(writtenSpecIds()).toEqual(['AUTO-BAR-R-1-P-001']);
  });

  it('still heals a clause whose stored provenance is missing (legacy or orphaned row)', async () => {
    await amend([storedClause('R-1', 'P-001', { storedSetHash: null }), storedClause('R-2', 'P-002')]);

    expect(writtenSpecIds()).toEqual(['AUTO-BAR-R-1-P-001']);
  });
});

describe('isProvenanceOnlyReprojection', () => {
  const stored = storedClause('R-1', 'P-001');
  const next = (patch: Partial<SpecClauseWrite> = {}): SpecClauseWrite => ({
    planSlug: 'subject-plan', specId: 'AUTO-BAR-R-1-P-001', expectedRevision: 5, planItemId: 'P-001',
    behavior: stored.behavior, behaviorClass: 'happy-path', requiredEvidence: ['tree'], requiredTestLayers: [],
    mutationRequired: false, lifecycleStatus: 'active', exemption: null, supersedes: null, falsifier: null,
    acceptanceRef: `${RUBRIC}@4:R-1`,
    sourceBar: {
      barKey: 'R-1', barHash: stored.source_bar_hash, barSetHash: 'c'.repeat(64), rubricSlug: RUBRIC,
      rubricRevision: 4, evidencePlane: criterionOf('R-1').evidencePlane!,
    },
    actorId: 'amender',
    ...patch,
  });

  it('is true when only the rubric-wide provenance differs', () => {
    expect(isProvenanceOnlyReprojection(stored, next())).toBe(true);
  });

  it.each<[string, Partial<SpecClauseWrite>]>([
    ['behavior', { behavior: 'A different promise.' }],
    ['required test layers', { requiredTestLayers: ['integration'] }],
    ['lifecycle', { lifecycleStatus: 'draft' }],
    ['falsifier', { falsifier: { observation: 'a new drift marker' } }],
  ])('is false when %s changes', (_name, patch) => {
    expect(isProvenanceOnlyReprojection(stored, next(patch))).toBe(false);
  });

  it('is false when the clause would be unlinked from its bar', () => {
    expect(isProvenanceOnlyReprojection(stored, next({ sourceBar: null }))).toBe(false);
  });

  it('is false without a stored content hash or rubric revision', () => {
    expect(isProvenanceOnlyReprojection({ ...stored, content_hash: null }, next())).toBe(false);
    expect(isProvenanceOnlyReprojection({ ...stored, source_rubric_revision: null }, next())).toBe(false);
  });
});
