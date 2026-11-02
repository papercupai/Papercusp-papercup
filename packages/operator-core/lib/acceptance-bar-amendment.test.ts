import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ withWorkspace: vi.fn() }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: h.withWorkspace,
}));

import {
  acceptanceBarApprovalSchema,
  approvalReceiptJsonSource,
  resolveAcceptanceBarApproval,
  acceptanceBarAmendmentKey,
  acceptanceBarSourceFingerprint,
  synchronizeAcceptanceBarSubjectRevision,
  withAcceptanceBarAmendmentTransaction,
  carryUnchangedBarEvidenceBindings,
  shouldCarryBarEvidence,
} from './acceptance-bar-amendment';
import { specEvidenceBindingFingerprint } from './agent-tools/plans/spec-evidence-store';
import { buildAcceptanceBarSeed } from './acceptance-bar-seed';
import {
  acceptanceCanonicalUnchangedIgnoringLegacyChecks,
  computeAcceptanceBarSetHash,
  normalizeAcceptanceBarCriterion,
} from './rubrics';
import { OrgTxnTimeoutError } from './pg-bounded-txn';
import {
  ACCEPTANCE_BAR_MEANING_FIELDS,
  acceptanceBarMeaningField,
} from './agent-tools/plans/rubric-loss-guard';

function subjectPlan(overrides: { requirements?: string; map?: string; now?: string } = {}): string {
  return `---
title: Subject plan
slug: subject-plan
status: active
created: 2026-09-06
updated: 2026-09-06
---

# Subject plan

## Now

**State:** ${overrides.now ?? 'working'}

**Next:** keep going

## Requirements

${overrides.requirements ?? '**R-1 — Canonical outcome.** The writer persists one canonical BAR.'}

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
${overrides.map ?? '| R-1 | P-001 | tree |'}

## Phase 1 — Build

- **P-001** \`todo\` persist the canonical BAR
`;
}

describe('acceptance BAR amendment transaction contract', () => {
  it('derives a stable replay key independent of BAR hash ordering', () => {
    const first = acceptanceBarAmendmentKey({
      rubricId: 'acceptance-plan',
      subjectPlan: 'plan',
      actorId: 'actor',
      reason: 'correct the contract',
      priorRubricRevision: 4,
      nextBarHashes: ['b'.repeat(64), 'a'.repeat(64)],
    });
    const second = acceptanceBarAmendmentKey({
      rubricId: 'acceptance-plan',
      subjectPlan: 'plan',
      actorId: 'actor',
      reason: 'correct the contract',
      priorRubricRevision: 4,
      nextBarHashes: ['a'.repeat(64), 'b'.repeat(64)],
    });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(
      acceptanceBarAmendmentKey({
        rubricId: 'acceptance-plan',
        subjectPlan: 'plan',
        actorId: 'actor',
        reason: 'different reason',
        priorRubricRevision: 4,
        nextBarHashes: ['a'.repeat(64), 'b'.repeat(64)],
      }),
    ).not.toBe(first);
  });

  it('keeps the BAR meaning field set explicit and excludes METHOD-only fields', () => {
    expect(ACCEPTANCE_BAR_MEANING_FIELDS).toContain('model');
    expect(ACCEPTANCE_BAR_MEANING_FIELDS).toContain('driftMarkers');
    expect(ACCEPTANCE_BAR_MEANING_FIELDS).toContain('check');
    expect(acceptanceBarMeaningField('model')).toBe(true);
    expect(acceptanceBarMeaningField('check')).toBe(true);
    expect(acceptanceBarMeaningField('method')).toBe(false);
    expect(acceptanceBarMeaningField('replication')).toBe(false);
  });

  it('ignores stale check projections but detects METHOD and class edits', () => {
    const stored = {
      kind: 'acceptance',
      subjectPlan: 'plan',
      characteristic: 'plan-acceptance',
      ratingScale: ['healthy', 'unknown'],
      barSetHash: 'set-hash',
      criteria: [{
        key: 'r-1',
        title: 'Outcome',
        model: 'The outcome is true.',
        barKey: 'R-1',
        barHash: 'bar-hash',
        driftMarkers: 'The outcome is false.',
        method: 'Read the old method.',
        replication: 'Repeat the old method.',
        criterionClass: 'settle-once',
        check: { kind: 'tool', tool: 'retired-tool', schemaRevision: 'd084' },
      }],
    };
    const checkMigrated = {
      ...stored,
      criteria: [{ ...stored.criteria[0], check: { kind: 'tool', tool: 'current-tool', schemaRevision: 'live' } }],
    };
    expect(acceptanceCanonicalUnchangedIgnoringLegacyChecks(stored, checkMigrated)).toBe(true);
    expect(acceptanceCanonicalUnchangedIgnoringLegacyChecks(stored, {
      ...checkMigrated,
      criteria: [{ ...checkMigrated.criteria[0], method: 'Read the complete method.' }],
    })).toBe(false);
    expect(acceptanceCanonicalUnchangedIgnoringLegacyChecks(stored, {
      ...checkMigrated,
      criteria: [{ ...checkMigrated.criteria[0], criterionClass: 'violatable' }],
    })).toBe(false);
  });

  it('represents BAR additions and removals explicitly in approval receipts', () => {
    const added = acceptanceBarApprovalSchema.safeParse({
      schemaVersion: 1,
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-plan',
      subjectPlan: 'plan',
      proposedPatchHash: 'c'.repeat(64),
      bars: [{ barKey: 'R-11', priorBarHash: null, nextBarHash: 'a'.repeat(64) }],
    });
    expect(added.success).toBe(true);

    const removed = acceptanceBarApprovalSchema.safeParse({
      schemaVersion: 1,
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-plan',
      subjectPlan: 'plan',
      proposedPatchHash: 'c'.repeat(64),
      bars: [{ barKey: 'R-2', priorBarHash: 'b'.repeat(64), nextBarHash: null }],
    });
    expect(removed.success).toBe(true);
    const scoped = acceptanceBarApprovalSchema.safeParse({
      schemaVersion: 1,
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-plan',
      subjectPlan: 'plan',
      certifies: 'R-1 was checked against the source and focused tests.',
      doesNotCertify: ['runtime deployment', 'unrelated rubric bars'],
      proposedPatchHash: 'c'.repeat(64),
      bars: [{ barKey: 'R-2', priorBarHash: 'b'.repeat(64), nextBarHash: null }],
    });
    expect(scoped.success).toBe(true);
    expect(scoped.success && scoped.data.certifies).toContain('R-1');
    expect(scoped.success && scoped.data.doesNotCertify).toEqual(['runtime deployment', 'unrelated rubric bars']);
    expect(acceptanceBarApprovalSchema.safeParse({
      schemaVersion: 1,
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-plan',
      subjectPlan: 'plan',
      bars: [{ barKey: 'R-1', priorBarHash: 'a'.repeat(64), nextBarHash: 'b'.repeat(64) }],
    }).success).toBe(false);
    expect(
      acceptanceBarApprovalSchema.safeParse({
        schemaVersion: 1,
        kind: 'acceptance-bar-amendment-approval',
        rubricRef: 'acceptance-plan',
        subjectPlan: 'plan',
        bars: [{ barKey: 'R-2', priorBarHash: null, nextBarHash: null }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty cross-plan transaction before opening a workspace', async () => {
    await expect(withAcceptanceBarAmendmentTransaction({ plans: [] }, async () => true)).rejects.toThrow(
      /at least one plan is required/,
    );
  });

  it('rejects plans from different workspaces before locking either plan', async () => {
    await expect(
      withAcceptanceBarAmendmentTransaction(
        {
          plans: [
            { workspaceId: 'ws-a', harnessSlug: 'h', planSlug: 'subject' },
            { workspaceId: 'ws-b', harnessSlug: 'h', planSlug: 'rubric' },
          ],
        },
        async () => true,
      ),
    ).rejects.toThrow(/must share one workspace/);
  });

  it('normalizes a raw advisory lock timeout to OrgTxnTimeoutError', async () => {
    const raw = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const tx = ((strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('pg_advisory_xact_lock')) return Promise.reject(raw);
      return Promise.resolve([]);
    }) as unknown;
    h.withWorkspace.mockImplementationOnce(
      async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );

    const rejected = withAcceptanceBarAmendmentTransaction(
      { plans: [{ workspaceId: 'ws', harnessSlug: 'h', planSlug: 'rubric' }] },
      async () => true,
    );

    await expect(rejected).rejects.toBeInstanceOf(OrgTxnTimeoutError);
    await expect(rejected).rejects.toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '55P03', cause: raw });
  });
});

describe('BAR-neutral subject-plan revision synchronization', () => {
  function legacyMaterializationFixture(canonicalIntent?: string) {
    const before = subjectPlan();
    const seeded = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: before, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 2, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
    });
    if (!seeded.ok) throw new Error(seeded.message);
    // The reviewed rubric has superseded the original prose, as on PUI's legacy plan.
    const criterion = normalizeAcceptanceBarCriterion({
      ...seeded.criteria[0]!, model: 'The reviewed canonical outcome holds.',
      ...(canonicalIntent ? { intent: { request: canonicalIntent } } : {}),
      driftMarkers: 'The reviewed outcome is absent.', requiredTestLayers: ['integration'],
      method: 'Run the named installed-product journey.',
      check: { kind: 'tests', files: ['packages/product.test.ts'] },
    });
    const data = { ...seeded.templateData, criteria: [criterion], barSetHash: computeAcceptanceBarSetHash([criterion]) };
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT status, acceptance_bar_rubric_slug')) return [{
        status: 'active', acceptance_bar_rubric_slug: 'acceptance-subject-plan',
        acceptance_bar_rubric_revision: 4, acceptance_bar_set_hash: data.barSetHash,
      }];
      if (statement.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
      if (statement.includes('SELECT version, template_data')) return [{ version: 4, template_data: data }];
      if (statement.includes('UPDATE harness_shared.harness_plans')) return [{ plan_slug: 'acceptance-subject-plan' }];
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const sections = {
      ...(canonicalIntent ? { intent: { request: canonicalIntent } } : {}),
      acceptance: {
        condition: criterion.model, falsifier: criterion.driftMarkers,
        requiredScope: criterion.requiredScope, evidencePlane: criterion.evidencePlane,
        requiredTestLayers: criterion.requiredTestLayers, passRatings: criterion.passRatings,
        mandatory: criterion.mandatory, role: criterion.role,
      },
      verification: {
        method: criterion.method!,
        check: { kind: 'tests', files: ['packages/product.test.ts'], cases: [
          { file: 'packages/product.test.ts', testName: 'exact installed-product journey' },
        ] },
      },
    };
    const render = (value = sections, map?: string) => subjectPlan({
      requirements: `**R-1 — Canonical outcome.**\n\n\`\`\`requirement\n${JSON.stringify(value)}\n\`\`\``,
      ...(map ? { map } : {}),
    });
    const synchronize = (after: string, previousBody = before) => synchronizeAcceptanceBarSubjectRevision(sql as never, {
      workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: 'subject-plan',
      previousBody, nextBody: after, previousVersion: 2, nextVersion: 3,
    });
    return { before, data, sections, sql, render, synchronize };
  }

  it('materializes the exact reviewed legacy BAR with named verification selectors without revising its rubric', async () => {
    const f = legacyMaterializationFixture();
    const after = f.render();
    // A non-null fingerprint proves this is a valid historical block, not a
    // parser refusal masquerading as a discriminating source-identity change.
    expect(await acceptanceBarSourceFingerprint(after)).toMatch(/^[a-f0-9]{64}$/);
    expect(await acceptanceBarSourceFingerprint(after)).not.toBe(await acceptanceBarSourceFingerprint(f.before));
    await expect(f.synchronize(after)).resolves.toBe(true);
    const updates = f.sql.mock.calls.map(([strings]) => strings.join(' ')).filter((s) => s.includes('UPDATE '));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain('{barContract,subjectPlanRevision}');
    expect(updates[0]).not.toContain('criteria');
    expect(updates[0]).not.toContain('SET version');
  });

  it.each([false, true])('still requires original Intent for a fresh BAR with completeness=%s', (requireContractCompleteness) => {
    const f = legacyMaterializationFixture();
    const built = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: f.render(), actorId: 'new-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 1, planStatus: 'draft', rubricSlug: 'acceptance-subject-plan',
      rubricRevision: 1, requireContractCompleteness,
    });
    expect(built).toMatchObject({ ok: false, error: 'bar_requirement_parse_failed' });
  });

  it('refuses to invent original Intent while materializing a historical BAR', async () => {
    const f = legacyMaterializationFixture();
    const sections = { ...f.sections, intent: { request: 'An unrecorded original request.' } };
    await expect(f.synchronize(f.render(sections))).resolves.toBe(false);
    expect(f.sql.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE '))).toBe(false);
  });

  it.each([
    ['condition', 'A weaker promise.'], ['falsifier', 'Only a narrower failure.'],
    ['requiredScope', ['live']], ['evidencePlane', 'live'], ['requiredTestLayers', ['unit']],
    ['passRatings', ['degraded']], ['mandatory', false], ['role', 'disclosure'],
  ])('refuses legacy materialization that changes the canonical %s', async (field, value) => {
    const f = legacyMaterializationFixture();
    const changed = { ...f.sections, acceptance: { ...f.sections.acceptance, [field]: value } };
    await expect(f.synchronize(f.render(changed as typeof f.sections))).resolves.toBe(false);
    expect(f.sql.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE '))).toBe(false);
  });

  it('refuses a legacy materialization combined with a discharge-map change', async () => {
    const f = legacyMaterializationFixture();
    await expect(f.synchronize(f.render(f.sections, '| R-1 | P-002 | tree |'))).resolves.toBe(false);
    expect(f.sql).not.toHaveBeenCalled();
  });

  it('refuses to use legacy materialization to replace an existing structured promise', async () => {
    const f = legacyMaterializationFixture();
    const previous = f.render({ ...f.sections, acceptance: { ...f.sections.acceptance, condition: 'A different authored promise.' } });
    await expect(f.synchronize(f.render(), previous)).resolves.toBe(false);
    expect(f.sql).not.toHaveBeenCalled();
  });

  it('restores only an already-reviewed canonical Intent without revising the rubric', async () => {
    const f = legacyMaterializationFixture('Original outcome plus the approved ownership clarification.');
    const previous = f.render({ ...f.sections, intent: { request: 'Original outcome.' } });
    await expect(f.synchronize(f.render(), previous)).resolves.toBe(true);
    const updates = f.sql.mock.calls.map(([strings]) => strings.join(' ')).filter(s => s.includes('UPDATE '));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain('{barContract,subjectPlanRevision}');
    expect(updates[0]).not.toContain('criteria');
    expect(updates[0]).not.toContain('SET version');
  });

  it('refuses an Intent repair that does not equal the locked canonical Intent', async () => {
    const f = legacyMaterializationFixture('Original outcome plus the approved ownership clarification.');
    const previous = f.render({ ...f.sections, intent: { request: 'Original outcome.' } });
    const after = f.render({ ...f.sections, intent: { request: 'A newly invented clarification.' } });
    await expect(f.synchronize(after, previous)).resolves.toBe(false);
    expect(f.sql.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE '))).toBe(false);
  });

  it('treats Now/Decision prose as neutral but fingerprints BAR source and map changes', async () => {
    const before = subjectPlan();
    const nowEdit = subjectPlan({ now: 'the Now block changed' });
    const decisionEdit = `${before}\n## Decisions\n\n### D-001 — Keep the BAR source canonical\n\nDate: 2026-09-06\n\nThe decision prose is not BAR source.\n`;
    const requirementEdit = subjectPlan({
      requirements: '**R-1 — Canonical outcome.** The canonical promise changed.',
    });
    const mapEdit = subjectPlan({ map: '| R-1 | P-002 | tree |' });

    await expect(acceptanceBarSourceFingerprint(before)).resolves.toBe(
      await acceptanceBarSourceFingerprint(nowEdit),
    );
    await expect(acceptanceBarSourceFingerprint(before)).resolves.toBe(
      await acceptanceBarSourceFingerprint(decisionEdit),
    );
    await expect(acceptanceBarSourceFingerprint(before)).resolves.not.toBe(
      await acceptanceBarSourceFingerprint(requirementEdit),
    );
    await expect(acceptanceBarSourceFingerprint(before)).resolves.not.toBe(
      await acceptanceBarSourceFingerprint(mapEdit),
    );
  });

  it('repairs a stale subjectPlanRevision only when the canonical BAR set still matches', async () => {
    const before = subjectPlan();
    const after = subjectPlan({ now: 'the Now block changed' });
    const seeded = buildAcceptanceBarSeed({
      planSlug: 'subject-plan',
      planContent: before,
      actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z',
      cohort: 'post-epoch',
      adoptionEpoch: 1,
      subjectPlanRevision: 1,
      planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan',
      rubricRevision: 4,
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT status, acceptance_bar_rubric_slug')) {
        return [{
          status: 'active',
          acceptance_bar_rubric_slug: 'acceptance-subject-plan',
          acceptance_bar_rubric_revision: 4,
          acceptance_bar_set_hash: seeded.barSetHash,
        }];
      }
      if (statement.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
      if (statement.includes('SELECT version, template_data')) {
        return [{ version: 4, template_data: seeded.templateData }];
      }
      if (statement.includes('UPDATE harness_shared.harness_plans')) return [{ plan_slug: 'acceptance-subject-plan' }];
      throw new Error(`unexpected SQL: ${statement}`);
    });

    await expect(
      synchronizeAcceptanceBarSubjectRevision(sql as never, {
        workspaceId: 'workspace',
        harnessSlug: 'papercusp',
        planSlug: 'subject-plan',
        previousBody: before,
        nextBody: after,
        previousVersion: 2,
        nextVersion: 3,
      }),
    ).resolves.toBe(true);

    expect(sql.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE harness_shared.harness_plans'))).toBe(true);
  });

  // WI-10000058. Two defects made the pin repair silently impossible for a real plan.
  // Both failures returned `false` out of a boolean nobody reads, so the plan write
  // succeeded, the pin went stale, and ship later refused bar_snapshot_rubric_revision_mismatch.
  it('derives the mandatory pass rating from the rubric ratingScale instead of hardcoding healthy', async () => {
    const body = subjectPlan();
    const healthyScale = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: body, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 1, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
    });
    expect(healthyScale.ok).toBe(true);
    if (!healthyScale.ok) return;
    // CALIBRATION: the default scale is healthy-based, so the pre-fix hardcode was
    // correct HERE. This case must keep passing or the test proves nothing about the fix.
    expect(healthyScale.criteria[0]!.passRatings).toEqual(['healthy']);

    // A pass/partial/fail/unknown rubric is equally valid and must not be normalised.
    // subjectPlanRevision deliberately DIFFERS from the stored pin (1) so that
    // preserveCanonicalBars is false and the criteria are genuinely re-derived — a
    // matching pin returns the stored criterion verbatim and would make this test
    // vacuous (caught by mutation probe: the mutant survived until this was fixed).
    const passScale = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: body, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 2, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
      // A self-consistent pass-scale rubric: scale AND stored criteria both on 'pass'.
      existingTemplateData: {
        ...healthyScale.templateData,
        ratingScale: ['pass', 'partial', 'fail', 'unknown'],
        criteria: (healthyScale.criteria as Array<Record<string, unknown>>).map((c) => ({
          ...c, passRatings: ['pass'],
        })),
      },
    });
    // Pre-fix this refused bar_rubric_conflict: "mandatory outcome pass rating 'healthy'
    // is not present in the rubric ratingScale".
    expect(passScale.ok).toBe(true);
    if (!passScale.ok) return;
    expect(passScale.criteria[0]!.passRatings).toEqual(['pass']);
  });

  it('preserves amended canonical BAR text when advancing the pin, instead of reverting it to the seed', async () => {
    const before = subjectPlan();
    const after = subjectPlan({ now: 'the Now block changed' });
    const seeded = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: before, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 2, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    // Simulate a rubric AMENDED after seeding: its criterion model is richer than the
    // text a fresh seed of the same body produces. This is the real shape — an amendment
    // that removed a factually-false constant from the original seed.
    const amendedModel = 'The AMENDED canonical promise, corrected after seeding.';
    const amended = {
      ...seeded.templateData,
      // Normalise so barHash is genuinely RECOMPUTED from the amended text. A hand-spread
      // that leaves the original barHash in place does not move barSetHash, which made an
      // earlier version of this fixture non-discriminating (caught by mutation probe).
      criteria: seeded.criteria.map((c) => normalizeAcceptanceBarCriterion({
        ...c, model: amendedModel,
      })),
    };

    // The STORED hash must be the AMENDED set's hash, not the fresh seed's — otherwise a
    // re-derivation reproduces it and preservation is not discriminating (caught by
    // mutation probe: the mutant survived until this fixture was corrected).
    const amendedSeed = buildAcceptanceBarSeed({
      planSlug: 'subject-plan', planContent: before, actorId: 'seed-author',
      declaredAt: '2026-09-06T00:00:00.000Z', cohort: 'post-epoch', adoptionEpoch: 1,
      subjectPlanRevision: 2, planStatus: 'active',
      rubricSlug: 'acceptance-subject-plan', rubricRevision: 4,
      existingTemplateData: amended,
    });
    expect(amendedSeed.ok).toBe(true);
    if (!amendedSeed.ok) return;
    // Sanity: the amendment really did move the hash away from the fresh seed's.
    expect(amendedSeed.barSetHash).not.toBe(seeded.barSetHash);

    const updates: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT status, acceptance_bar_rubric_slug')) {
        return [{
          status: 'active',
          acceptance_bar_rubric_slug: 'acceptance-subject-plan',
          acceptance_bar_rubric_revision: 4,
          acceptance_bar_set_hash: amendedSeed.barSetHash,
        }];
      }
      if (statement.includes('pg_try_advisory_xact_lock')) return [{ ok: true }];
      if (statement.includes('SELECT version, template_data')) {
        // The realistic post-amendment row: amended criteria AND the matching
        // barSetHash the amendment wrote alongside them.
        return [{ version: 4, template_data: amendedSeed.templateData }];
      }
      if (statement.includes('UPDATE harness_shared.harness_plans')) {
        updates.push(statement);
        return [{ plan_slug: 'acceptance-subject-plan' }];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });

    // Pre-fix, preserveCanonicalBars was false by construction on a pin repair (the
    // stored pin never equals the incoming revision), so the criteria were re-derived
    // from the plan body and the barSetHash check then failed — returning false here.
    await expect(
      synchronizeAcceptanceBarSubjectRevision(sql as never, {
        workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: 'subject-plan',
        previousBody: before, nextBody: after, previousVersion: 2, nextVersion: 3,
      }),
    ).resolves.toBe(true);

    // The rubric UPDATE must touch ONLY the pin — the amended text is never rewritten by it.
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain('{barContract,subjectPlanRevision}');
    expect(updates[0]).not.toContain('criteria');
    // WI-10004146: once the rubric pin names this node's revision again, the
    // receiver-side verified-revision override on the subject plan is cleared.
    expect(updates[1]).toContain('SET acceptance_bar_verified_revision = NULL');
    expect(updates[1]).not.toContain('template_data');
  });

  it('does not repair the pin when the Requirements BAR meaning changes', async () => {
    const before = subjectPlan();
    const after = subjectPlan({
      requirements: '**R-1 — Canonical outcome.** The canonical promise changed.',
    });
    const sql = vi.fn();

    await expect(
      synchronizeAcceptanceBarSubjectRevision(sql as never, {
        workspaceId: 'workspace',
        harnessSlug: 'papercusp',
        planSlug: 'subject-plan',
        previousBody: before,
        nextBody: after,
        previousVersion: 2,
        nextVersion: 3,
      }),
    ).resolves.toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('approval receipt parsing (EI-22617748468342848)', () => {
  const RECEIPT = {
    schemaVersion: 1,
    kind: 'acceptance-bar-amendment-approval',
    rubricRef: 'acceptance-plan',
    subjectPlan: 'plan',
    proposedPatchHash: 'c'.repeat(64),
    bars: [{ barKey: 'R-1', priorBarHash: 'a'.repeat(64), nextBarHash: 'b'.repeat(64) }],
  } as const;

  const expected = {
    schemaVersion: 1 as const,
    kind: 'acceptance-bar-amendment-approval' as const,
    rubricRef: 'acceptance-plan',
    subjectPlan: 'plan',
    proposedPatchHash: 'c'.repeat(64),
    bars: [{ barKey: 'R-1', priorBarHash: 'a'.repeat(64), nextBarHash: 'b'.repeat(64) }],
  };

  function sqlReturning(body: string) {
    return (() =>
      Promise.resolve([
        { author_id: 'su-reviewer', body, approved_at: '2026-09-07T00:00:00.000Z' },
      ])) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];
  }

  const resolve = (body: string) =>
    resolveAcceptanceBarApproval(sqlReturning(body), {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    });

  it('resolves an approval by workspace and post id without binding it to the request thread', async () => {
    let query = '';
    let values: unknown[] = [];
    const sql = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
      query = strings.join('?');
      values = parameters;
      return Promise.resolve([
        { author_id: 'su-reviewer', body: JSON.stringify(RECEIPT), approved_at: '2026-09-07T00:00:00.000Z' },
      ]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(
      resolveAcceptanceBarApproval(sql, {
        workspaceId: 'papercusp-workspace',
        approvalRef: 'thread-post:123',
        expected,
      }),
    ).resolves.toMatchObject({ approvedBy: 'su-reviewer' });
    expect(query).toContain('WHERE workspace_id = ? AND id = ?::bigint');
    expect(query).toContain("AND origin = 'local'");
    expect(query).not.toMatch(/\b(?:thread|work_item)_id\b/);
    expect(values).toEqual(['papercusp-workspace', '123']);
  });

  it('accepts a compact reviewer pointer to the immutable preview and keeps reviewer authorship', async () => {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    let call = 0;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ query: strings.join('?'), values });
      call += 1;
      return Promise.resolve(call === 1
        ? [{ author_id: 'su-reviewer', body: 'approve thread-post:456', approved_at: '2026-09-07T00:00:00.000Z' }]
        : [{ author_id: 'su-requester', body: JSON.stringify(RECEIPT) }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(
      resolveAcceptanceBarApproval(sql, {
        workspaceId: 'papercusp-workspace',
        approvalRef: 'thread-post:123',
        expected,
      }),
    ).resolves.toMatchObject({
      approvalRef: 'thread-post:123',
      approvedBy: 'su-reviewer',
      approvedAt: '2026-09-07T00:00:00.000Z',
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]!.values).toEqual(['papercusp-workspace', '123']);
    expect(queries[1]!.query).toContain('WHERE workspace_id = ? AND id = ?::bigint');
    expect(queries[1]!.query).toContain("AND origin = 'local'");
    expect(queries[1]!.values).toEqual(['papercusp-workspace', '456']);
  });

  it('accepts a first-line reviewer pointer followed by verification notes', async () => {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    let call = 0;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ query: strings.join('?'), values });
      call += 1;
      return Promise.resolve(call === 1
        ? [{
            author_id: 'su-reviewer',
            body: '\n  approve thread-post:456\n\nRecomputed the changed BAR hashes and confirmed they match the preview.',
            approved_at: '2026-10-02T07:11:00.000Z',
          }]
        : [{ author_id: 'su-requester', body: JSON.stringify(RECEIPT) }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(resolveAcceptanceBarApproval(sql, {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    })).resolves.toMatchObject({
      approvalRef: 'thread-post:123',
      approvedBy: 'su-reviewer',
      approvedAt: '2026-10-02T07:11:00.000Z',
    });
    expect(queries).toHaveLength(2);
    expect(queries[1]!.values).toEqual(['papercusp-workspace', '456']);
  });

  it('accepts a first-line reviewer pointer followed by same-line verification notes', async () => {
    const queries: Array<{ query: string; values: unknown[] }> = [];
    let call = 0;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ query: strings.join('?'), values });
      call += 1;
      return Promise.resolve(call === 1
        ? [{
            author_id: 'su-reviewer',
            body: 'approve thread-post:456 Reviewed all changed BARs and verified the preview.',
            approved_at: '2026-10-02T07:11:00.000Z',
          }]
        : [{ author_id: 'su-requester', body: JSON.stringify(RECEIPT) }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(resolveAcceptanceBarApproval(sql, {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    })).resolves.toMatchObject({
      approvalRef: 'thread-post:123',
      approvedBy: 'su-reviewer',
      approvedAt: '2026-10-02T07:11:00.000Z',
    });
    expect(queries).toHaveLength(2);
    expect(queries[1]!.values).toEqual(['papercusp-workspace', '456']);
  });

  it('rejects a legacy multiline approval whose immutable preview lacks full patch binding', async () => {
    const previewBody = JSON.stringify({
      kind: 'acceptance-bar-amendment-approval',
      rubricRef: 'acceptance-full-text-knowledge-retrieval-2026-10-08',
      schemaVersion: 1,
      subjectPlan: 'full-text-knowledge-retrieval-2026-10-08',
      bars: [
        { barKey: 'R-1', priorBarHash: 'e0f798143b9d05157c03ea97aa41ea15e4bca69e8242a2674720e20ff05e3cd3', nextBarHash: 'cdbda161c8b15be11e0d00c001e497b7d46d9362ad26db61d217cac5b40a9934' },
        { barKey: 'R-2', priorBarHash: '3414db5465c8e876f272f6d8fbf0575e84df1529246c362b4db6c1add1b26929', nextBarHash: '5c82880f0d6d739a768312b5d36dd39067220b724d52de9287a6d703973bf33f' },
        { barKey: 'R-3', priorBarHash: 'ea74769adf1e45097e0b2276c7eb9b0357ed05d6b3a4158e081f523071343dd0', nextBarHash: 'd13ccd3e531c6b4547cfda5cf5ba5f2b63e92ab9629ea89c7cbcaa87353500b5' },
        { barKey: 'R-10', priorBarHash: 'ab38ed94f1f8c9a6a84f221da59db8d1a3326f3e70f178a44b5349718de8ae26', nextBarHash: '16583c7eb94ae9077c995fe5c7f35db8cecf5e55e7754cbf8867815681b8cf4d' },
        { barKey: 'R-12', priorBarHash: '566c489f6044ffe3e6a3757adf461845c9284b683c729e8a413dd0b9960c1b97', nextBarHash: '3269f5713245948424510264ac62ca037e53f72ec96e5a700eae1a67afeae802' },
      ],
    });
    const approvalBody = [
      'approve thread-post:1167173',
      '',
      'Verified against acceptance-full-text-knowledge-retrieval-2026-10-08 revision 2 and the complete critique at WI-10007702/comment1167130. The approval delta changes only R-1, R-2, R-3, R-10, and R-12; every prior hash matches the live rubric, every next hash is non-null, and all 12 omitted BARs remain present. Required scope, evidence plane, test layer, and privacy/access expectations are preserved.',
      '',
      'The amendment closes the cited gaps: R-1/R-2/R-3 make D-002/D-009 canonical-parent/store/registry reuse and no-parallel-store-or-scheduler architecture falsifiable; R-10 binds plan/doc automatic currentness plus explicit historical plan identity/provenance; R-12 binds prose-profile memoization, equal-width incompatible-profile rejection, and explicit turn-start delivered-ref dedup while retaining mem0 and bound-plan contributions. Named tree tests contain the canonical registry, historical-plan, profile-identity, and source-exclusion controls; any not-yet-present turn-start fixture is now an explicit acceptance obligation rather than an assumed behavior.',
    ].join('\n');
    const expectedOriginal = {
      schemaVersion: 1 as const,
      kind: 'acceptance-bar-amendment-approval' as const,
      rubricRef: 'acceptance-full-text-knowledge-retrieval-2026-10-08',
      subjectPlan: 'full-text-knowledge-retrieval-2026-10-08',
      proposedPatchHash: 'c'.repeat(64),
      bars: [
        { barKey: 'R-1', priorBarHash: 'e0f798143b9d05157c03ea97aa41ea15e4bca69e8242a2674720e20ff05e3cd3', nextBarHash: 'cdbda161c8b15be11e0d00c001e497b7d46d9362ad26db61d217cac5b40a9934' },
        { barKey: 'R-2', priorBarHash: '3414db5465c8e876f272f6d8fbf0575e84df1529246c362b4db6c1add1b26929', nextBarHash: '5c82880f0d6d739a768312b5d36dd39067220b724d52de9287a6d703973bf33f' },
        { barKey: 'R-3', priorBarHash: 'ea74769adf1e45097e0b2276c7eb9b0357ed05d6b3a4158e081f523071343dd0', nextBarHash: 'd13ccd3e531c6b4547cfda5cf5ba5f2b63e92ab9629ea89c7cbcaa87353500b5' },
        { barKey: 'R-10', priorBarHash: 'ab38ed94f1f8c9a6a84f221da59db8d1a3326f3e70f178a44b5349718de8ae26', nextBarHash: '16583c7eb94ae9077c995fe5c7f35db8cecf5e55e7754cbf8867815681b8cf4d' },
        { barKey: 'R-12', priorBarHash: '566c489f6044ffe3e6a3757adf461845c9284b683c729e8a413dd0b9960c1b97', nextBarHash: '3269f5713245948424510264ac62ca037e53f72ec96e5a700eae1a67afeae802' },
      ],
    };
    const queries: Array<{ query: string; values: unknown[] }> = [];
    let call = 0;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ query: strings.join('?'), values });
      call += 1;
      return Promise.resolve(call === 1
        ? [{
            author_id: 'system:judge/su-4a0f1492-f767-4a4c-92b2-6b3c4795ce71',
            body: approvalBody,
            approved_at: '2026-10-09T04:06:19.140Z',
          }]
        : [{ author_id: 'su-5e26d68f-60b7-4d7c-b1b7-0dbf07bcc96d', body: previewBody }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(resolveAcceptanceBarApproval(sql, {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:1167191',
      expected: expectedOriginal,
    })).rejects.toThrow('acceptance_bar_approval_invalid_receipt');
    expect(queries).toHaveLength(2);
    expect(queries.map((query) => query.values)).toEqual([
      ['papercusp-workspace', '1167191'],
      ['papercusp-workspace', '1167173'],
    ]);
  });

  it('refuses a later pointer to a different preview', async () => {
    let calls = 0;
    const sql = (() => {
      calls += 1;
      return Promise.resolve([{
        author_id: 'su-reviewer',
        body: 'approve thread-post:456\nVerified the hashes.\nFor a different rubric, approve thread-post:789.',
        approved_at: '2026-10-02T07:11:00.000Z',
      }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(resolveAcceptanceBarApproval(sql, {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    })).rejects.toThrow('acceptance_bar_approval_ambiguous_preview_pointer');
    expect(calls).toBe(1);
  });

  it('does not accept a reviewer pointer below preceding verification prose', async () => {
    await expect(resolve('Verified the hashes first.\napprove thread-post:456')).rejects.toThrow(
      /acceptance_bar_approval_unparseable/,
    );
  });

  it('resolves a reviewer pointer to one inline approval JSON line surrounded by preview prose', async () => {
    let call = 0;
    const preview = [
      'R3 live-evidence amendment preview at subject plan revision 14.',
      'Exact approval JSON:',
      JSON.stringify(RECEIPT),
      'The test check remains required; runtime evidence is owed after apply.',
    ].join('\n');
    const sql = (() => {
      call += 1;
      return Promise.resolve(call === 1
        ? [{ author_id: 'su-reviewer', body: 'approve thread-post:456', approved_at: '2026-09-25T00:00:00.000Z' }]
        : [{ author_id: 'su-requester', body: preview }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(resolveAcceptanceBarApproval(sql, {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    })).resolves.toMatchObject({ approvedBy: 'su-reviewer', approvalRef: 'thread-post:123' });
  });

  it('accepts explanation following a first-line reviewer preview pointer', async () => {
    let call = 0;
    const sql = (() => {
      call += 1;
      return Promise.resolve(call === 1
        ? [{
            author_id: 'su-reviewer',
            body: 'approve thread-post:456\nVerified the preview hashes and source.',
            approved_at: '2026-09-25T00:00:00.000Z',
          }]
        : [{ author_id: 'su-requester', body: JSON.stringify(RECEIPT) }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(resolveAcceptanceBarApproval(sql, {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    })).resolves.toMatchObject({
      approvalRef: 'thread-post:123',
      approvedBy: 'su-reviewer',
      approvedAt: '2026-09-25T00:00:00.000Z',
    });
    expect(call).toBe(2);
  });

  it('attributes an unparseable receipt to the referenced preview post', async () => {
    let call = 0;
    const sql = (() => {
      call += 1;
      return Promise.resolve(call === 1
        ? [{ author_id: 'su-reviewer', body: 'approve thread-post:456', approved_at: '2026-09-25T00:00:00.000Z' }]
        : [{ author_id: 'su-requester', body: 'Preview posted without an approval receipt.' }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(resolveAcceptanceBarApproval(sql, {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    })).rejects.toThrow('acceptance_bar_preview_unparseable: referenced preview thread-post:456');
  });

  it('resolves one pretty-printed approval object embedded in preview prose', async () => {
    let call = 0;
    const preview = [
      'The exact approval JSON follows:',
      JSON.stringify(RECEIPT, null, 2),
      'The remaining BARs are unchanged.',
    ].join('\n');
    const sql = (() => {
      call += 1;
      return Promise.resolve(call === 1
        ? [{ author_id: 'su-reviewer', body: 'approve thread-post:456', approved_at: '2026-09-25T00:00:00.000Z' }]
        : [{ author_id: 'su-requester', body: preview }]);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(resolveAcceptanceBarApproval(sql, {
      workspaceId: 'papercusp-workspace',
      approvalRef: 'thread-post:123',
      expected,
    })).resolves.toMatchObject({ approvedBy: 'su-reviewer', approvalRef: 'thread-post:123' });
  });

  it('refuses ambiguous prose with two inline approval receipts', () => {
    const body = ['Exact approval JSON:', JSON.stringify(RECEIPT), JSON.stringify(RECEIPT)].join('\n');
    expect(approvalReceiptJsonSource(body)).toBe(body);
  });

  it('refuses a compact pointer whose preview post is absent in this workspace', async () => {
    let call = 0;
    const sql = ((strings: TemplateStringsArray) => {
      call += 1;
      return Promise.resolve(call === 1
        ? [{ author_id: 'su-reviewer', body: 'approve thread-post:456', approved_at: '2026-09-07T00:00:00.000Z' }]
        : []);
    }) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];

    await expect(
      resolveAcceptanceBarApproval(sql, {
        workspaceId: 'papercusp-workspace',
        approvalRef: 'thread-post:123',
        expected,
      }),
    ).rejects.toThrow('acceptance_bar_approval_preview_unreadable');
  });

  it('strips a ```json fence before parsing, and leaves an unfenced body untouched', () => {
    expect(approvalReceiptJsonSource('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(approvalReceiptJsonSource('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(approvalReceiptJsonSource('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts the first JSON fence from surrounding review prose', () => {
    expect(
      approvalReceiptJsonSource(
        'I checked the amendment and its source mappings.\n\n```json\n{"a":1}\n```\n\nThe prose is part of the review.',
      ),
    ).toBe('{"a":1}');
    expect(approvalReceiptJsonSource('```json\n{"first":1}\n```\n```json\n{"second":2}\n```')).toBe(
      '{"first":1}',
    );
  });

  // A reviewer who SHOWS their recomputation before signing used to have that
  // evidence block handed to JSON.parse, so their valid receipt below it was
  // never read and the refusal claimed the body contained no JSON. The more
  // rigorous the reviewer, the more likely their approval was rejected — the
  // exact opposite of the incentive an approval receipt exists to create.
  // Observed live: WI-10002280 post 972067.
  it('prefers the ```json receipt over an earlier untagged evidence fence', () => {
    const body = [
      '## APPROVED — all six hashes recomputed and matched',
      '',
      '```',
      'R-1: MATCH  computed=3f1ec48198ea5952…',
      'R-6: MATCH  computed=bd0d0ce59b11c8d9…',
      'VERDICT=ALL_MATCH',
      '```',
      '',
      '```json',
      '{"kind":"acceptance-bar-amendment-approval","bars":[{"barKey":"R-1"}]}',
      '```',
    ].join('\n');

    expect(approvalReceiptJsonSource(body)).toBe(
      '{"kind":"acceptance-bar-amendment-approval","bars":[{"barKey":"R-1"}]}',
    );
    // CONTROL: the old first-wins behaviour returned the evidence block, which
    // is what made this a silent, misattributed refusal.
    expect(approvalReceiptJsonSource(body)).not.toContain('VERDICT=ALL_MATCH');
  });

  it('falls back to the first fence that actually parses when none is tagged json', () => {
    const body = ['```', 'not json at all', '```', '', '```', '{"b":2}', '```'].join('\n');
    expect(approvalReceiptJsonSource(body)).toBe('{"b":2}');
  });

  it('CONTROL: a body whose only fence is unparseable still reaches JSON.parse to report its own error', () => {
    // Never silently swallow a malformed receipt — the caller must still see a
    // parse failure rather than an empty string that looks like an absent body.
    expect(approvalReceiptJsonSource('```\n{oops\n```')).toBe('{oops');
  });

  it('accepts a fenced reviewer receipt', async () => {
    await expect(resolve('```json\n' + JSON.stringify(RECEIPT) + '\n```')).resolves.toMatchObject({
      approvalRef: 'thread-post:123',
      approvedBy: 'su-reviewer',
    });
  });

  it('returns reviewer scope from a prose-wrapped receipt', async () => {
    const scopedReceipt = {
      ...RECEIPT,
      certifies: 'all changed BAR hashes were checked against source',
      doesNotCertify: ['runtime deployment', 'unrelated plan items'],
    };
    await expect(
      resolve(`Review complete.\n\n\`\`\`json\n${JSON.stringify(scopedReceipt)}\n\`\`\`\n\nNo other claims.`),
    ).resolves.toMatchObject({
      approvedBy: 'su-reviewer',
      certifies: 'all changed BAR hashes were checked against source',
      doesNotCertify: ['runtime deployment', 'unrelated plan items'],
    });
  });

  it('still accepts a raw receipt', async () => {
    await expect(resolve(JSON.stringify(RECEIPT))).resolves.toMatchObject({
      approvedBy: 'su-reviewer',
    });
  });

  it('reports a non-JSON body as _unparseable, naming the cause', async () => {
    await expect(resolve('Approved! see above.')).rejects.toThrow(
      /acceptance_bar_approval_unparseable/,
    );
  });

  // The case that proves the split is real rather than cosmetic: well-formed JSON
  // that fails the schema must KEEP the old code, one line below the new one.
  it('keeps _invalid_receipt for well-formed JSON that fails the schema', async () => {
    const wrongSchema = JSON.stringify({ schemaVersion: 1, kind: 'not-an-approval' });
    await expect(resolve(wrongSchema)).rejects.toThrow(/acceptance_bar_approval_invalid_receipt/);
    await expect(resolve(wrongSchema)).rejects.not.toThrow(/unparseable/);
  });
});

describe('approval covers the full amendment delta (R-5)', () => {
  const PRIOR = 'a'.repeat(64);
  const NEXT = 'b'.repeat(64);
  const PATCH = 'c'.repeat(64);

  function sqlReturning(body: string) {
    return (() =>
      Promise.resolve([
        { author_id: 'su-reviewer', body, approved_at: '2026-09-07T00:00:00.000Z' },
      ])) as unknown as Parameters<typeof resolveAcceptanceBarApproval>[0];
  }

  const bar = (barKey: string, priorBarHash: string | null, nextBarHash: string | null) => ({
    barKey,
    priorBarHash,
    nextBarHash,
  });

  const resolve = (
    receiptBars: Array<ReturnType<typeof bar>>,
    appliedBars: Array<ReturnType<typeof bar>>,
    receiptPatchHash = PATCH,
    appliedPatchHash = PATCH,
  ) =>
    resolveAcceptanceBarApproval(
      sqlReturning(
        JSON.stringify({
          schemaVersion: 1,
          kind: 'acceptance-bar-amendment-approval',
          rubricRef: 'acceptance-plan',
          subjectPlan: 'plan',
          proposedPatchHash: receiptPatchHash,
          bars: receiptBars,
        }),
      ),
      {
        workspaceId: 'papercusp-workspace',
        approvalRef: 'thread-post:123',
        expected: {
          schemaVersion: 1,
          kind: 'acceptance-bar-amendment-approval',
          rubricRef: 'acceptance-plan',
          subjectPlan: 'plan',
          proposedPatchHash: appliedPatchHash,
          bars: appliedBars,
        },
      },
    );

  // The R-5 case: the reviewer approved R-1, and the amendment ALSO changes R-2.
  // R-2 was never reviewed, so this must not read as "your approval went stale".
  it('refuses _incomplete, naming every applied bar the approval never covers', async () => {
    const applied = [bar('R-1', PRIOR, NEXT), bar('R-2', PRIOR, NEXT), bar('R-9', null, NEXT)];
    await expect(resolve([bar('R-1', PRIOR, NEXT)], applied)).rejects.toThrow(
      /acceptance_bar_approval_incomplete/,
    );
    const err = await resolve([bar('R-1', PRIOR, NEXT)], applied).catch((e: Error) => e.message);
    expect(err).toContain('R-2');
    expect(err).toContain('R-9');
    // Naming the uncovered bars is the whole point — a code with no bar keys sends
    // the caller back to re-approve the same preview instead of the missing half.
    expect(err).not.toContain('R-1');
  });

  // The split is only real if the OTHER failure keeps its own code: a bar that IS
  // covered but whose hashes moved is stale, not uncovered, and its repair differs.
  it('keeps _stale_or_mismatched when the bar IS covered but its hashes moved', async () => {
    const stale = await resolve(
      [bar('R-1', PRIOR, 'c'.repeat(64))],
      [bar('R-1', PRIOR, NEXT)],
    ).catch((e: Error) => e.message);
    expect(stale).toMatch(/acceptance_bar_approval_stale_or_mismatched/);
    expect(stale).toContain('R-1');
    expect(stale).toContain(`reviewed prior=${PRIOR}, next=${'c'.repeat(64)}`);
    expect(stale).toContain(`current prior=${PRIOR}, next=${NEXT}`);
    expect(stale).not.toMatch(/incomplete/);
  });

  it('rejects a changed verification patch even when its BAR hashes still match', async () => {
    await expect(
      resolve([bar('R-1', PRIOR, NEXT)], [bar('R-1', PRIOR, NEXT)], PATCH, 'd'.repeat(64)),
    ).rejects.toThrow('acceptance_bar_approval_patch_mismatched');
  });

  it('accepts a receipt that covers every applied bar, and tolerates extra approved bars', async () => {
    await expect(
      resolve([bar('R-1', PRIOR, NEXT), bar('R-2', PRIOR, NEXT)], [bar('R-1', PRIOR, NEXT)]),
    ).resolves.toMatchObject({ approvedBy: 'su-reviewer' });
  });
});

/**
 * P-008: an amendment re-projects EVERY clause so each pins the global rubric
 * revision, which used to strand the proof of a BAR whose own meaning never
 * changed — amending one criterion invalidated every other criterion's evidence.
 * These bind the carry contract, whose subtle half is that the binding
 * fingerprint must be RECOMPUTED (it is defined over the revision it pins), not
 * copied from the superseded row.
 */
describe('shouldCarryBarEvidence (P-008) — which clause may keep its proof', () => {
  const base = { sourceBarKey: 'R-1', changedBars: ['R-3'], priorRevision: 7, nextRevision: 8 };

  it('carries an unchanged bar whose clause was re-projected by the global pin', () => {
    expect(shouldCarryBarEvidence(base)).toBe(true);
  });

  it('refuses a bar the preview reported as changed — different meaning, re-prove it', () => {
    expect(shouldCarryBarEvidence({ ...base, changedBars: ['R-1', 'R-3'] })).toBe(false);
    expect(shouldCarryBarEvidence({ ...base, sourceBarKey: 'R-3' })).toBe(false);
  });

  it('refuses an unattributable clause rather than guessing it is unchanged', () => {
    // The one direction where a wrong guess PRESERVES a proof that should die.
    expect(shouldCarryBarEvidence({ ...base, sourceBarKey: null })).toBe(false);
    expect(shouldCarryBarEvidence({ ...base, sourceBarKey: '' })).toBe(false);
    expect(shouldCarryBarEvidence({ ...base, sourceBarKey: '   ' })).toBe(false);
  });

  it('refuses when there is nothing to carry across', () => {
    expect(shouldCarryBarEvidence({ ...base, priorRevision: undefined })).toBe(false);
    expect(shouldCarryBarEvidence({ ...base, priorRevision: 8 })).toBe(false);
  });

  it('matches bar keys exactly, never by prefix', () => {
    // 'R-1' must not be considered changed because 'R-10' changed.
    expect(shouldCarryBarEvidence({ ...base, changedBars: ['R-10'] })).toBe(true);
    expect(shouldCarryBarEvidence({ ...base, sourceBarKey: 'R-10', changedBars: ['R-1'] })).toBe(true);
  });
});

describe('carryUnchangedBarEvidenceBindings (P-008)', () => {
  const SCOPE = {
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    planSlug: 'subject-plan',
    specId: 'AUTO-BAR-R-1-P-001',
  } as const;
  const PRIOR_FP = 'a'.repeat(64);
  const NEXT_FP = 'b'.repeat(64);

  function storedRow(over: Record<string, unknown> = {}) {
    return {
      id: 41,
      verifies_binding_id: null,
      work_item_id: 'WI-1',
      evidence_kind: 'test',
      evidence_ref: 'packages/operator-core/lib/thing.test.ts',
      source_fingerprint: 'src-fp',
      test_fingerprint: 'test-fp',
      fixture_fingerprint: null,
      rubric_fingerprint: null,
      environment_fingerprint: null,
      coverage_evidence_ref: null,
      test_run_id: 42,
      details: { note: 'proof' },
      observed_at: new Date('2026-09-01T00:00:00.000Z'),
      created_by: 'su-original-prover',
      ...over,
    };
  }

  function fakeSql(resultsInOrder: unknown[][]) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    let next = 0;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      const rows = resultsInOrder[next] ?? [];
      next += 1;
      return Promise.resolve(rows);
    }) as never;
    return { sql, calls };
  }

  it('issues no query at all when the revision did not move', async () => {
    const { sql, calls } = fakeSql([]);
    const carried = await carryUnchangedBarEvidenceBindings(sql, {
      ...SCOPE,
      priorRevision: 7,
      nextRevision: 7,
      nextSpecFingerprint: NEXT_FP,
    });
    expect(carried).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('selects only bindings whose contract edge already exists at the NEW revision', async () => {
    const { sql, calls } = fakeSql([[]]);
    const carried = await carryUnchangedBarEvidenceBindings(sql, {
      ...SCOPE,
      priorRevision: 7,
      nextRevision: 8,
      nextSpecFingerprint: NEXT_FP,
    });
    expect(carried).toBe(0);
    expect(calls).toHaveLength(1);
    // The join must pin the NEW revision + fingerprint: the FK to
    // work_item_spec_revision_edges demands it, and a missing edge means that
    // work-item is no longer bound and must not silently inherit proof.
    expect(calls[0]!.text).toContain('work_item_spec_revision_edges');
    expect(calls[0]!.values).toContain(8);
    expect(calls[0]!.values).toContain(NEXT_FP);
    expect(calls[0]!.values).toContain(7);
  });

  it('excludes retracted bindings from the carry so a withdrawal is not resurrected', async () => {
    const { sql, calls } = fakeSql([[]]);
    await carryUnchangedBarEvidenceBindings(sql, {
      ...SCOPE,
      priorRevision: 7,
      nextRevision: 8,
      nextSpecFingerprint: NEXT_FP,
    });
    // Carry re-INSERTS rather than reads, so without this predicate a retracted binding comes
    // back as a fresh, un-retracted row at the next bar amendment — the retraction silently
    // undone at an unrelated later event, which is the one repair path D-011 sanctions. The
    // behavioural proof (retract, amend, assert only the control carries) lives in
    // spec-evidence-store.integration.test.ts; this cheap twin exists because that suite runs
    // only under test:affected:integration, so an edit to this SQL in the ordinary unit loop
    // would otherwise be checked by nothing.
    expect(calls[0]!.text).toContain('b.retracted_at IS NULL');
  });

  it('recomputes the binding fingerprint over the new revision instead of copying it', async () => {
    const row = storedRow();
    const { sql, calls } = fakeSql([[row], [{ id: 42 }]]);
    const carried = await carryUnchangedBarEvidenceBindings(sql, {
      ...SCOPE,
      priorRevision: 7,
      nextRevision: 8,
      nextSpecFingerprint: NEXT_FP,
    });
    expect(carried).toBe(1);
    const insert = calls[1]!;
    expect(insert.text).toContain('INSERT INTO harness_shared.spec_evidence_bindings');

    const canonical = {
      workspaceId: SCOPE.workspaceId,
      harnessSlug: SCOPE.harnessSlug,
      workItemId: 'WI-1',
      planSlug: SCOPE.planSlug,
      specId: SCOPE.specId,
      specFingerprint: NEXT_FP,
      evidenceKind: 'test' as never,
      evidenceRef: row.evidence_ref,
      sourceFingerprint: row.source_fingerprint,
      testFingerprint: row.test_fingerprint,
      fixtureFingerprint: null,
      rubricFingerprint: null,
      environmentFingerprint: null,
      coverageEvidenceRef: null,
      testRunId: 42,
      details: row.details,
    };
    const expected = specEvidenceBindingFingerprint({ ...canonical, specRevision: 8 });
    const stale = specEvidenceBindingFingerprint({
      ...canonical,
      specRevision: 7,
      specFingerprint: PRIOR_FP,
    });
    expect(insert.values).toContain(expected);
    // A copied fingerprint would stop matching its own row, so the next
    // identical bind would append a duplicate instead of deduplicating.
    expect(insert.values).not.toContain(stale);
    expect(expected).not.toBe(stale);
  });

  it('preserves the original observation time and prover, and pins the new revision', async () => {
    const row = storedRow();
    const { sql, calls } = fakeSql([[row], [{ id: 42 }]]);
    await carryUnchangedBarEvidenceBindings(sql, {
      ...SCOPE,
      priorRevision: 7,
      nextRevision: 8,
      nextSpecFingerprint: NEXT_FP,
    });
    const insert = calls[1]!;
    // The proof was observed when it was observed; the carry is not a fresh
    // observation by the amending actor.
    expect(insert.values).toContain(row.observed_at);
    expect(insert.values).toContain('su-original-prover');
    expect(insert.values).toContain(8);
    expect(insert.values).toContain(NEXT_FP);
    expect(insert.values).not.toContain(7);
  });

  it('refuses an unbounded carry rather than silently truncating proof', async () => {
    const rows = Array.from({ length: 1001 }, (_unused, index) =>
      storedRow({ work_item_id: `WI-${index}` }),
    );
    const { sql } = fakeSql([rows]);
    await expect(
      carryUnchangedBarEvidenceBindings(sql, {
        ...SCOPE,
        priorRevision: 7,
        nextRevision: 8,
        nextSpecFingerprint: NEXT_FP,
      }),
    ).rejects.toThrow('acceptance_bar_amendment_evidence_carry_truncated');
  });
});
