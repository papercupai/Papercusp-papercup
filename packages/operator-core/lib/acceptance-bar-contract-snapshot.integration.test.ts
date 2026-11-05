/**
 * P-006 real-Postgres proof for the acceptance snapshot's existing reuse seam.
 *
 * The unit suite proves the pure projection. This test proves that the migrated
 * stores compose the same contract end to end: one immutable evidence binding is
 * reused, tied to the current requirement/spec identity, freshness-classified from
 * a server measurement, and paired with an independent grading card. Mutating the
 * measured source file is the control: the same binding remains auditable but stops
 * counting as current proof.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import type { SpecClauseSql } from './agent-tools/plans/spec-clauses-store';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  repoRoot: '',
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(workspaceId: string, fn: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      h.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        return fn(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

vi.mock('./harness-registry', async (orig) => {
  const actual = await orig<typeof import('./harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: async () => ({ projects: [{ slug: 'papercusp', path: h.repoRoot }] }),
    resolveHarnessContentPath: (registry: { projects: Array<{ slug: string; path: string }> }, slug: string) =>
      registry.projects.find((project) => project.slug === slug)?.path,
  };
});

const { createOrgTestDb } = await import('../test/_org-test-db');
const { hashPlanContent } = await import('./agent-tools/plans/content-hash');
const { bindSpecEvidence, listSpecEvidence, measureRepoFilesEvidenceAtRoot } = await import('./agent-tools/plans/spec-evidence-store');
const { listSpecClauses, setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
const { MAX_BAR_PROJECTION_EDGES, seedAcceptanceBarsInTransaction } = await import('./acceptance-bar-seed');
const { readAcceptanceBarContractSnapshot } = await import('./acceptance-bar-contract-snapshot');
const { getRubric } = await import('./rubrics');
const { createIssue } = await import('./issues-engineer');
const { PAPERCUSP_WORKSPACE_ID } = await import('./harness/papercusp-workspace');
const { runWithWorkspace } = await import('./workspace-als');

const WORKSPACE = PAPERCUSP_WORKSPACE_ID;
const HARNESS = 'papercusp';
const PLAN = 'acceptance-snapshot-reuse-integration';
const RUBRIC = `acceptance-${PLAN}`;
const ITEM = 'P-001';
const WORK_ITEM = 'WI-acceptance-snapshot-reuse';
const SPEC = 'AUTO-BAR-R-1-P-001';
const EVIDENCE_REF = 'counterexample:acceptance-snapshot-reuse';
const SOURCE_PATH = 'src/acceptance-snapshot.ts';
const TEST_PATH = 'test/acceptance-snapshot.integration.test.ts';
const OBSERVED_AT = '2026-09-07T12:00:00.000Z';

const requirement = {
  intent: {
    request: 'Reuse an exact acceptance proof without weakening its current requirement.',
    constraints: ['Keep evidence identity, freshness, and independent grading separately visible.'],
    sourceRefs: ['P-006'],
  },
  acceptance: {
    condition:
      'The acceptance snapshot links reused evidence to the current requirement and an independent grading record.',
    falsifier:
      'A changed source fingerprint still counts as current, or the snapshot loses the evidence or grading identity.',
    requiredScope: ['tree'],
    evidencePlane: 'tree' as const,
    requiredTestLayers: ['integration'],
  },
  verification: {
    method: 'Read the migrated stores before and after changing the server-measured source fingerprint.',
    check: { kind: 'instrument' as const, instrumentKey: 'none' },
    replication: 'Run this integration test against the migrated throwaway Postgres fixture.',
  },
};

const planContent = `---
title: Acceptance snapshot reuse integration
slug: ${PLAN}
status: active
---

## Requirements

**R-1 — Reuse current proof.**
\`\`\`requirement
${JSON.stringify(requirement)}
\`\`\`

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | ${ITEM} | tree |

## Work

- **${ITEM}** \`done\` prove the existing acceptance snapshot reuse seam
`;

const measurement = {
  schemaVersion: 1 as const,
  kind: 'repo-files' as const,
  sourcePaths: [SOURCE_PATH],
  testPaths: [TEST_PATH],
  fixturePaths: [TEST_PATH],
};

let db: OrgTestDb;

beforeAll(async () => {
  h.repoRoot = await mkdtemp(path.join(tmpdir(), 'acceptance-snapshot-reuse-'));
  await Promise.all([
    mkdir(path.join(h.repoRoot, 'src'), { recursive: true }),
    mkdir(path.join(h.repoRoot, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(h.repoRoot, SOURCE_PATH), 'export const acceptanceSnapshot = true;\n'),
    writeFile(path.join(h.repoRoot, TEST_PATH), 'expect(acceptanceSnapshot).toBe(true);\n'),
  ]);
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await Promise.all([db?.cleanup(), h.repoRoot ? rm(h.repoRoot, { recursive: true, force: true }) : Promise.resolve()]);
}, 30_000);

describe('acceptance BAR contract snapshot — real Postgres reuse preflight', () => {
  it('reuses one exact current proof and invalidates only its freshness when the measured source changes', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status, owner,
         acceptance_bar_epoch, acceptance_bar_cohort)
      VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN}, ${planContent}, ${hashPlanContent(planContent)}, 1,
              'Acceptance snapshot reuse integration', 'active', 'su-author', 1, 'post-epoch')`;
    await db.adminSql`
      INSERT INTO harness_shared.plan_items
        (workspace_id, harness_slug, plan_slug, item_id, seq, status, item_text)
      VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN}, ${ITEM}, 1, 'done', 'Prove snapshot reuse')`;

    const seeded = await db.adminSql.begin((tx) =>
      seedAcceptanceBarsInTransaction({
        workspaceId: WORKSPACE,
        harnessSlug: HARNESS,
        planSlug: PLAN,
        planContent,
        planTitle: 'Acceptance snapshot reuse integration',
        planStatus: 'active',
        planVersion: 1,
        adoptionEpoch: 1,
        cohort: 'post-epoch',
        actorId: 'su-author',
        now: new Date(OBSERVED_AT),
        executor: tx as unknown as SpecClauseSql,
      }),
    );
    expect(seeded).toMatchObject({ ok: true, rubricSlug: RUBRIC, rubricRevision: 1 });
    if (!seeded.ok) throw new Error(seeded.message);

    // Acceptance seeding deliberately projects draft clauses. This fixture is
    // about evidence reuse AFTER independent review, so promote the generated
    // clause through the canonical append-only spec writer instead of silently
    // treating draft work as enforceable proof.
    const [draft] = await listSpecClauses({ harnessSlug: HARNESS, planSlug: PLAN, specIds: [SPEC] });
    expect(draft).toMatchObject({ revision: 1, lifecycleStatus: 'draft', acceptanceRef: `${RUBRIC}@1:R-1` });
    if (!draft?.acceptanceRef || !draft.sourceBar) throw new Error('seeded acceptance clause is incomplete');
    const promoted = await setSpecClause({
      harnessSlug: HARNESS,
      planSlug: PLAN,
      specId: SPEC,
      expectedRevision: draft.revision,
      sourceValId: draft.sourceValId ?? undefined,
      planItemId: draft.planItemId,
      behavior: draft.behavior,
      behaviorClass: draft.behaviorClass,
      requiredEvidence: draft.requiredEvidence,
      requiredTestLayers: draft.requiredTestLayers,
      mutationRequired: draft.mutationRequired,
      lifecycleStatus: 'active',
      falsifier: draft.falsifier ?? undefined,
      acceptanceRef: draft.acceptanceRef,
      sourceBar: draft.sourceBar,
      actorId: 'su-independent-reviewer',
    });
    expect(promoted).toMatchObject({ status: 'revised', revision: 2 });
    const promotedRevision = 2;

    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, source_plan_slug,
         source_plan_item_ids, taken_by)
      VALUES (${WORKSPACE}, ${HARNESS}, ${WORK_ITEM}, 'Implement acceptance snapshot reuse',
              'done', 'feature', ${PLAN}, ${[ITEM]}::text[], 'su-impl')`;
    // This migrated-store fixture models a reporter-written run, including the
    // execution facts the reader now requires independently of binding prose.
    const execution = {
      schemaVersion: 1, root: h.repoRoot, filePath: TEST_PATH,
      runGroupId: null, workspaceId: WORKSPACE, harnessSlug: HARNESS,
      testNamePattern: null, testLayer: 'integration', passed: 1, failed: 0,
      skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha: null, worktreeDirty: false,
    };
    expect(parseTestRunExecutionDetails(execution)).toEqual(execution);
    const [testRun] = await db.adminSql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs
        (workspace_id, harness_slug, file_path, framework, status, finished_at,
         worktree_dirty, execution_details)
      VALUES (${WORKSPACE}, ${HARNESS}, ${TEST_PATH}, 'vitest', 'pass', ${OBSERVED_AT},
              false, ${JSON.stringify(execution)}::jsonb)
      RETURNING id`;

    const fingerprints = await measureRepoFilesEvidenceAtRoot(h.repoRoot, measurement);
    expect(fingerprints.fixtureFingerprint).toEqual(expect.any(String));
    const bindingInput = {
      harnessSlug: HARNESS,
      planSlug: PLAN,
      workItemId: WORK_ITEM,
      specId: SPEC,
      evidenceKind: 'counterexample' as const,
      evidenceRef: EVIDENCE_REF,
      sourceFingerprint: fingerprints.sourceFingerprint,
      testFingerprint: fingerprints.testFingerprint,
      fixtureFingerprint: fingerprints.fixtureFingerprint,
      testRunId: Number(testRun!.id),
      details: {
        evidencePlane: 'tree',
        currentMeasurement: measurement,
        adequacy: {
          fixtureCalibrated: true,
          falsifiable: true,
          testLayer: 'integration',
          pathReachable: true,
          oracleIndependent: true,
          collected: true,
          skipped: false,
          executed: true,
          outcome: 'pass',
          targeted: SPEC.toLowerCase(),
        },
      },
      observedAt: OBSERVED_AT,
      actorId: 'su-impl',
    };
    const created = await bindSpecEvidence(bindingInput);
    const reused = await bindSpecEvidence(bindingInput);
    expect(created).toMatchObject({ status: 'created', planSlug: PLAN, specId: SPEC, specRevision: promotedRevision });
    expect(reused).toMatchObject({ status: 'unchanged', id: (created as { id: number }).id });

    const [classified] = await listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: [PLAN],
      evidenceRefs: [EVIDENCE_REF],
    });
    expect(classified?.currentness.unknownReasons).toEqual([]);
    expect(classified).toMatchObject({
      details: { currentMeasurement: measurement },
      serverMeasurement: { status: 'measured' },
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        dimensions: { source: 'current', test: 'current', testRun: 'current' },
      },
    });

    const currentRubric = await getRubric(RUBRIC);
    if (!currentRubric) throw new Error('seeded acceptance rubric is unavailable');
    const grading = await runWithWorkspace(WORKSPACE, () =>
      createIssue({
        title: 'Independent acceptance snapshot grading',
        kind: 'change',
        state: 'done',
        createdBy: 'su-independent-grader',
        payload: {
          observation: {
            rubricRef: RUBRIC,
            rubricRevision: seeded.rubricRevision,
            criteriaHash: currentRubric.criteriaHash,
            ...(currentRubric.barContract?.meaningRevision != null
              ? { rubricMeaningRevision: currentRubric.barContract.meaningRevision }
              : {}),
            sourceHive: HARNESS,
            ratings: {
              'r-1': { rating: 'healthy', evidence: 'The exact evidence identity and freshness decision are visible.' },
            },
          },
        },
      }),
    );

    const [classifiedAfterGrading] = await listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: [PLAN],
      evidenceRefs: [EVIDENCE_REF],
    });
    expect(classifiedAfterGrading).toMatchObject({
      specRevision: promotedRevision,
      currentRevision: promotedRevision,
      serverMeasurement: { status: 'measured' },
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        dimensions: { source: 'current', test: 'current', testRun: 'current' },
      },
    });

    const current = await readAcceptanceBarContractSnapshot(PLAN, {}, { harnessSlug: HARNESS });
    expect(current.bars).toHaveLength(1);
    const currentHistory = current.bars[0]!.proof.history ?? [];
    expect(currentHistory).toHaveLength(1);
    expect(currentHistory[0]!.currentness).toEqual(classifiedAfterGrading.currentness);
    expect(currentHistory[0]).toMatchObject({
      specId: SPEC,
      specRevision: promotedRevision,
      currentRevision: promotedRevision,
      matchesCurrentSpec: true,
    });
    expect(current.bars[0]).toMatchObject({
      barKey: 'R-1',
      criterionKey: 'r-1',
      requirement,
      mappings: [{ planItemId: ITEM, specId: SPEC, specRevision: promotedRevision }],
      workContracts: [{ workItemId: WORK_ITEM, specId: SPEC, specRevision: promotedRevision, current: true }],
      proof: {
        state: 'current',
        currentEvidence: 1,
        staleEvidence: 0,
        // Evaluator rev 4 (SPEC_TEST_ADEQUACY_EVALUATOR_REVISION): a counterexample alone cannot
        // establish falsifiability — its canonical test file must ALSO be bound as a successful
        // current test on the same clause revision. The proof is still reused exactly (current,
        // one row); only adequacy waits for that corroboration, which bindAttempt(2, 'pass')
        // below supplies and the `selected` read asserts flips adequacy to pass.
        adequacy: {
          state: 'unknown',
          checks: [{
            specId: SPEC,
            revision: promotedRevision,
            verdict: 'unknown',
            wouldBlock: ['falsifiability', 'plan-class-risk-floor'],
            evidenceRefs: [EVIDENCE_REF],
          }],
        },
      },
      grading: {
        state: 'pass',
        scorecardId: grading.id,
        gradedBy: 'su-independent-grader',
        rating: 'healthy',
      },
    });
    expect(current.bars[0]!.proof.history).toEqual([
      expect.objectContaining({
        id: (created as { id: number }).id,
        evidenceKind: 'counterexample',
        evidenceRef: EVIDENCE_REF,
        matchesCurrentSpec: true,
        currentness: expect.objectContaining({
          overall: 'current',
          provenance: 'server-measured',
          comparisonSupplied: true,
          dimensions: expect.objectContaining({ source: 'current', test: 'current', spec: 'current' }),
        }),
      }),
    ]);
    expect(current.bars[0]!.proof.history![0]!.details.adequacy).toMatchObject({
      targeted: SPEC.toLowerCase(),
      outcome: 'pass',
      testLayer: 'integration',
    });
    expect(current.bars[0]!.proof.history![0]!.details.adequacy).not.toHaveProperty('coverageRungs');
    expect(current.bars[0]!.grading.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scorecardId: grading.id,
          role: 'independent',
          authoritative: true,
          currentRevision: true,
        }),
      ]),
    );

    // Real immutable append ids, not caller timestamps, choose the attempt.
    // Keep the independent negative control above while replacing an older
    // unknown execution, and prove the inverse cannot hide a later failure.
    const bindAttempt = async (n: number, outcome: string) => {
      const binding = { specId: SPEC, specRevision: promotedRevision, testPath: TEST_PATH,
        sourcePaths: measurement.sourcePaths, testLayer: 'integration' };
      const pending = { ...bindingInput, evidenceKind: 'test' as const,
        evidenceRef: `test-run-group:attempt-${n}:0`, testRunId: null,
        details: { currentMeasurement: measurement,
          testExecution: { schemaVersion: 1, phase: 'pending', originRunId: `attempt-${n}`, binding },
          adequacy: { testLayer: 'integration', outcome: 'pending', executed: false, collected: false } } };
      expect(await bindSpecEvidence(pending)).toMatchObject({ status: 'created' });
      const settled = { ...pending, testRunId: Number(testRun!.id),
        details: { ...pending.details, evidencePlane: 'tree',
          testExecution: { ...pending.details.testExecution, phase: 'settled' },
          adequacy: { ...bindingInput.details.adequacy, outcome } } };
      expect(await bindSpecEvidence(settled)).toMatchObject({ status: 'created' });
      return settled;
    };
    const oldAttempt = await bindAttempt(1, 'unknown');
    await bindAttempt(2, 'pass');
    const selected = await readAcceptanceBarContractSnapshot(PLAN, {}, { harnessSlug: HARNESS });
    expect(selected.bars[0]!.proof.adequacy?.state).toBe('pass');
    expect(selected.bars[0]!.proof.history).toHaveLength(5);
    expect(selected.bars[0]!.proof.adequacy?.checks[0]?.evidenceRefs)
      .toEqual([EVIDENCE_REF, 'test-run-group:attempt-2:0'].sort());
    expect(selected.bars[0]!.proof.history?.filter(row => row.evidenceRef === oldAttempt.evidenceRef))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        activeAttempt: false, details: expect.objectContaining({
          adequacy: expect.objectContaining({ outcome: 'unknown' }),
        }),
      })]));
    await bindAttempt(3, 'failed');
    // A late corrected annotation of the older attempt cannot become a new run.
    await bindSpecEvidence({ ...oldAttempt, observedAt: '2099-01-01T00:00:00Z',
      details: { ...oldAttempt.details, adequacy: { ...oldAttempt.details.adequacy, outcome: 'pass' } } });
    const failing = await readAcceptanceBarContractSnapshot(PLAN, {}, { harnessSlug: HARNESS });
    expect(failing.bars[0]!.proof.adequacy?.checks[0]?.wouldBlock).toContain('execution-integrity');
    expect(failing.bars[0]!.proof.adequacy?.checks[0]?.evidenceRefs)
      .toEqual([EVIDENCE_REF, 'test-run-group:attempt-3:0'].sort());

    await writeFile(path.join(h.repoRoot, SOURCE_PATH), 'export const acceptanceSnapshot = false;\n');
    const stale = await readAcceptanceBarContractSnapshot(PLAN, {}, { harnessSlug: HARNESS });
    expect(stale.bars[0]).toMatchObject({
      proof: { state: 'stale', currentEvidence: 0, staleEvidence: 2 },
      grading: { state: 'pass', scorecardId: grading.id },
    });
    expect(stale.bars[0]!.proof.history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: (created as { id: number }).id,
        evidenceRef: EVIDENCE_REF,
        matchesCurrentSpec: true,
        currentness: expect.objectContaining({
          overall: 'stale',
          provenance: 'server-measured',
          comparisonSupplied: true,
          dimensions: expect.objectContaining({ source: 'stale', test: 'current', spec: 'current' }),
          staleReasons: ['source-stale'],
        }),
      }),
    ]));
  });

  // EI-25254803369850716. work_item_spec_revision_edges is append-only, so a long-lived plan
  // keeps one edge per spec revision each work item ever bound. Reading that whole history
  // let superseded rows alone exceed MAX_BAR_PROJECTION_EDGES and refuse the entire contract
  // (bar_snapshot_source_truncated) with zero BARs blocking. Builds on the plan the test
  // above leaves behind: SPEC at revision 2 and WORK_ITEM bound to revision 2.
  it('reads one edge per work item and spec, so superseded edge history cannot truncate the contract', async () => {
    const HISTORY_ITEMS = 100;
    const CURRENT_REVISION = 12;
    // Revisions 3..12 of the same clause (copies of revision 2 with distinct content hashes),
    // then make 12 current — the shape a repeatedly re-revised AUTO-BAR clause accrues.
    await db.adminSql`
      INSERT INTO harness_shared.plan_spec_clause_revisions
        (workspace_id, harness_slug, plan_slug, spec_id, revision, plan_item_id, behavior, behavior_class,
         required_evidence, required_test_layers, mutation_required, lifecycle_status, supersedes_spec_id,
         supersedes_revision, exemption, content_hash, created_by, accepted_by, accepted_at, acceptance_ref,
         falsifier, source_bar_key, source_bar_hash, source_bar_set_hash, source_rubric_slug,
         source_rubric_revision, evidence_plane)
      SELECT workspace_id, harness_slug, plan_slug, spec_id, g, plan_item_id, behavior, behavior_class,
             required_evidence, required_test_layers, mutation_required, lifecycle_status, supersedes_spec_id,
             supersedes_revision, exemption, encode(sha256(convert_to(content_hash || ':' || g, 'UTF8')), 'hex'),
             created_by, accepted_by, accepted_at, acceptance_ref, falsifier, source_bar_key, source_bar_hash,
             source_bar_set_hash, source_rubric_slug, source_rubric_revision, evidence_plane
        FROM harness_shared.plan_spec_clause_revisions, generate_series(3, ${CURRENT_REVISION}) AS g
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}
         AND spec_id = ${SPEC} AND revision = 2`;
    await db.adminSql`
      UPDATE harness_shared.plan_spec_clauses SET current_revision = ${CURRENT_REVISION}
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN} AND spec_id = ${SPEC}`;
    // 100 work items that each bound EVERY revision 2..12 (11 edges each, current one last),
    // plus one work item whose newest edge is revision 5: it must stay visible, as stale.
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, source_plan_slug, taken_by)
      SELECT ${WORKSPACE}, ${HARNESS}, 'WI-edge-history-' || n, 'edge history ' || n, 'done', 'feature', ${PLAN}, 'su-impl'
        FROM generate_series(1, ${HISTORY_ITEMS}) AS n
      UNION ALL
      SELECT ${WORKSPACE}, ${HARNESS}, 'WI-edge-stale-only', 'stale-only edge', 'done', 'feature', ${PLAN}, 'su-impl'`;
    await db.adminSql`
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint, created_by)
      SELECT r.workspace_id, r.harness_slug, 'WI-edge-history-' || n, r.plan_slug, r.spec_id, r.revision,
             r.content_hash, 'su-impl'
        FROM harness_shared.plan_spec_clause_revisions r, generate_series(1, ${HISTORY_ITEMS}) AS n
       WHERE r.workspace_id = ${WORKSPACE} AND r.harness_slug = ${HARNESS} AND r.plan_slug = ${PLAN}
         AND r.spec_id = ${SPEC} AND r.revision BETWEEN 2 AND ${CURRENT_REVISION}
      UNION ALL
      SELECT r.workspace_id, r.harness_slug, 'WI-edge-stale-only', r.plan_slug, r.spec_id, r.revision,
             r.content_hash, 'su-impl'
        FROM harness_shared.plan_spec_clause_revisions r
       WHERE r.workspace_id = ${WORKSPACE} AND r.harness_slug = ${HARNESS} AND r.plan_slug = ${PLAN}
         AND r.spec_id = ${SPEC} AND r.revision BETWEEN 2 AND 5`;

    // Control: the fixture really exceeds the cap as full history, so the pre-fix reader
    // (every edge, ordered, LIMIT cap+1) would have truncated. Without this the assertion
    // below could pass vacuously on a fixture that never reached the cap.
    const [history] = await db.adminSql<{ total: number }[]>`
      SELECT count(*)::int AS total FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    expect(history!.total).toBeGreaterThan(MAX_BAR_PROJECTION_EDGES);

    const snapshot = await readAcceptanceBarContractSnapshot(PLAN, {}, { harnessSlug: HARNESS });
    const livePairs = HISTORY_ITEMS + 2; // + WORK_ITEM (revision 2 only) + the stale-only item
    expect(snapshot.bounded.workContracts).toEqual({
      rowsRead: livePairs,
      limit: MAX_BAR_PROJECTION_EDGES,
      truncated: false,
    });
    expect(snapshot.completeness.problems.map((problem) => problem.code))
      .not.toContain('bar_snapshot_source_truncated');

    const contracts = snapshot.bars[0]!.workContracts;
    expect(contracts).toHaveLength(livePairs);
    const historyContracts = contracts.filter((contract) => contract.workItemId.startsWith('WI-edge-history-'));
    expect(historyContracts).toHaveLength(HISTORY_ITEMS);
    // The preferred row is the CURRENT-revision edge, not merely any edge per pair.
    expect(historyContracts.every((contract) => contract.current && contract.specRevision === CURRENT_REVISION))
      .toBe(true);
    expect(contracts.find((contract) => contract.workItemId === 'WI-edge-stale-only'))
      .toMatchObject({ specId: SPEC, specRevision: 5, current: false });
    expect(contracts.find((contract) => contract.workItemId === WORK_ITEM))
      .toMatchObject({ specId: SPEC, specRevision: 2, current: false });
  });
});
