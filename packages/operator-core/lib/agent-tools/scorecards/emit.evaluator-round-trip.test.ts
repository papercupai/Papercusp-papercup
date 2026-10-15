/**
 * Evaluator → auditor ROUND TRIP for spec-test-adequacy cards
 * (review-system-rework-reduction-2026-09-23 P-005, WI-10002645; regression class WI-10002320).
 *
 * Every other emit replay test hands `dispatchTool` a CANNED replay row. That proves the
 * gate compares ratings correctly, but it never asks the question that actually broke the
 * fleet: can the evaluator's OWN `scorecardDraft` survive the evaluator's OWN replay? For
 * WI-10002320 the answer was structurally "no" — `rerunRecipeFor` always emits
 * `replaySnapshot:true` plus a matching `current` tuple, the store suppressed server
 * measurement on every replay, the classifier capped freshness at `unknown`, and
 * scorecards:emit refused every freshness=pass card the evaluator had just produced.
 * Both halves were individually tested and individually green.
 *
 * So this suite wires the REAL pieces end to end, mocking only the I/O seams below them:
 *
 *   plans:evaluate-spec-test-adequacy (real handler)
 *     → listSpecEvidence (real; DB rows faked at withWorkspace, repo measured for real
 *       against a temp checkout)
 *     → evaluateSpecTestAdequacy + rerunRecipeFor (real)
 *   scorecards:emit (real emitScorecard, real replay gate)
 *     → dispatchTool → THE SAME real evaluator handler, args parsed by its real schema
 *
 * An emitted card is "auditor-reproducible by construction" exactly when the first test
 * holds. The second is its falsifier: the same round trip after the proven code moves
 * must be REFUSED, which is what makes the first a measurement rather than an echo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  querySql: [] as string[],
  measurementRoot: '',
}));

// Repo-file measurement checks live mutation-probe locks. This round-trip uses a private
// temporary checkout and does not exercise the shared lock store; keep that I/O seam empty
// here (the lock behavior is covered by spec-evidence-store-mutation-probe.test.ts).
vi.mock('../locks/su-lock-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/su-lock-store')>()),
  ensureBootstrap: vi.fn(async () => undefined),
  getTxPool: vi.fn(() => ({} as never)),
  readQueue: vi.fn(async () => ({ active_locks: [], waiting: [] })),
}));

// ── evidence-store I/O seams ────────────────────────────────────────────────────────
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      const tx = ((strings: TemplateStringsArray | string[], ...values: unknown[]) => {
        const sql = Array.from(strings).join(' ');
        h.querySql.push(sql);
        // The subject plan's slug-only harness lookup (planHarnessesForSlugs) answers like the
        // real table: one row per requested slug, owned by 'papercusp' (resolvePlanScope above).
        // harness_plans' primary key is (workspace_id, harness_slug, plan_slug), so a slug never
        // lists one harness twice; handing it the binding rows would read as an ambiguous slug.
        if (sql.includes('SELECT plan_slug, harness_slug FROM harness_shared.harness_plans')) {
          const slugs = (values.find(Array.isArray) ?? []) as string[];
          return Promise.resolve(slugs.map((plan_slug) => ({ plan_slug, harness_slug: 'papercusp' })));
        }
        // The provisional-scorecard lookup finds none; every other read returns the bindings.
        return Promise.resolve(sql.includes('provisional') ? [] : h.rows);
      }) as unknown;
      return fn(tx);
    },
  };
});
vi.mock('../plans/source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans/source')>()),
  resolvePlanScope: async () => ({ workspaceId: 'workspace-test', harnessSlug: 'papercusp' }),
}));
// Server measurement resolves a real harness checkout: point it at this suite's temp root so
// the replay's re-measurement is observable. Without it every measurement would fail with
// repo_measurement_harness_root_unavailable and the round trip would pass or fail for the
// wrong reason.
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: async () => ({}) as never,
  resolveHarnessContentPath: () => h.measurementRoot,
}));

// ── evaluator-handler seams ─────────────────────────────────────────────────────────
vi.mock('../_harness-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_harness: unknown, ctx: unknown) => ctx),
}));
vi.mock('../plans/_ctx-opts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans/_ctx-opts')>()),
  resolveEffectiveHarnessSlug: vi.fn(() => 'papercusp'),
}));
vi.mock('../plans/spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plans/spec-clauses-store')>()),
  listSpecClauses: vi.fn(),
}));
// One build for the evaluator AND the recipe it records, so the replay is a same-build
// replay: build drift is a different refusal with its own tests (emit.replay.test.ts).
vi.mock('../../build-info', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../build-info')>()),
  getBuildInfo: vi.fn(() => ({ sha: 'round-trip-evaluator-sha', version: '1.0.0' })),
}));

// ── scorecards:emit persistence seams (same set as emit.replay.test.ts) ─────────────
const getRubric = vi.fn();
const getRubricCriteriaHash = vi.fn();
const getRubricEvidenceIdentity = vi.fn();
const getRubricPlanRevision = vi.fn();
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const getAcceptanceRubricsForPlan = vi.fn();
const getRetiredAcceptanceRubricsForPlan = vi.fn();

vi.mock('../../rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rubrics')>()),
  getRubric: (...args: unknown[]) => getRubric(...args),
  getRubricWithoutSeeding: (...args: unknown[]) => getRubric(...args),
  // The real helper calls getRubric through its module-local binding, bypassing the
  // export mock above and reaching PostgreSQL. This round-trip only needs the fixture's
  // unversioned identity, so stub the helper at the I/O seam too.
  getRubricEvidenceIdentity: (...args: unknown[]) => getRubricEvidenceIdentity(...args),
  readRubric: async (rubricId: string) => {
    const rubric = await getRubric(rubricId);
    return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
  },
  getRubricCriteriaHash: (...args: unknown[]) => getRubricCriteriaHash(...args),
  getRubricPlanRevision: (...args: unknown[]) => getRubricPlanRevision(...args),
  readRubricPlanRevision: (...args: unknown[]) => readRubricPlanRevision(...args),
  getAcceptanceRubricsForPlan: (...args: unknown[]) => getAcceptanceRubricsForPlan(...args),
  getRetiredAcceptanceRubricsForPlan: (...args: unknown[]) => getRetiredAcceptanceRubricsForPlan(...args),
}));
vi.mock('../../scorecards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scorecards')>()),
  listScorecards: (...args: unknown[]) => listScorecards(...args),
}));
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...args: unknown[]) => captureImprovement(...args),
}));
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: async () => null }));
vi.mock('../../issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../issues-engineer')>()),
  getIssue: async () => null,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));

import evaluatorTool, { argsSchema as evaluatorArgsSchema } from '../plans/evaluate-spec-test-adequacy';
import { listSpecClauses } from '../plans/spec-clauses-store';
import { measureAndPinRepoFilesEvidenceAtRoot } from '../plans/spec-evidence-store';
import { ADEQUACY_CRITERIA, SPEC_TEST_ADEQUACY_EVALUATOR_REVISION } from '../plans/spec-test-adequacy';
import { resolveLocalRubric } from '../../cupboard/rubric-store';
import { emitScorecard, scorecardEmitArgs } from './emit';
import type {
  SpecTestAdequacyMeasurementEvidence,
  SpecTestAdequacyRerunRecipe,
} from '../../harness/improvements/observation-types';

const listClauses = vi.mocked(listSpecClauses);

const PLAN = 'reconnect-plan';
const SPEC = 'SPEC-003-01';
const SPEC_FINGERPRINT = 'sha256:spec-v1';
const MEASURED_PASSED_CASE_TITLE = 'reconnect after acknowledgement';
const MEASUREMENT = {
  schemaVersion: 1 as const,
  kind: 'repo-files' as const,
  sourcePaths: ['src/reconnect.ts'],
  testPaths: ['test/reconnect.test.ts'],
  fixturePaths: ['fixtures/reconnect.fixture.ts'],
};

const ADEQUACY = {
  fixtureCalibrated: true,
  falsifiable: true,
  testLayer: 'integration',
  pathReachable: true,
  oracleIndependent: true,
  collected: true,
  skipped: false,
  executed: true,
  // This fixture's clause declares no falsifier scenarios, so name the clause itself.
  targeted: SPEC.toLowerCase(),
  coverageRungs: { l3: true, l4: false },
};

/** A stored binding row exactly as listSpecEvidence's SQL returns it (snake_case). */
function bindingRow(
  over: {
    id: number;
    evidenceKind: string;
    evidenceRef: string;
    outcome: string;
    testRunId?: number;
    testRunSource?: string;
    testRunStatus?: string;
    testRunOutputTail?: string | null;
    testCases?: string[];
  },
  fingerprints: Awaited<ReturnType<typeof measureAndPinRepoFilesEvidenceAtRoot>>,
): Record<string, unknown> {
  const testRunStatus = over.testRunStatus ?? (over.evidenceKind === 'mutation' ? 'fail' : 'pass');
  // Mirrors the store's SQL (WI-10006745): a failed mutation-probe run's raw ledger tail.
  const mutationFailureTail =
    over.evidenceKind === 'mutation' &&
    over.testRunSource === 'mutation-probe' &&
    testRunStatus === 'fail'
      ? over.testRunOutputTail ?? null
      : null;
  const mutationFailedCaseTitle =
    'code-search.callers-lookup — measurement and promotion state > keeps the lane honest';
  const executionDetails = {
    schemaVersion: 1,
    root: '/repo',
    filePath: 'test/reconnect.test.ts',
    runGroupId: null,
    workspaceId: 'workspace-test',
    harnessSlug: 'papercusp',
    testNamePattern: null,
    passed: mutationFailureTail === null ? 1 : 0,
    failed: mutationFailureTail === null ? 0 : 1,
    skipped: 0,
    collectionFailed: false,
    testLayer: 'integration',
    passedCaseTitles: mutationFailureTail === null ? [MEASURED_PASSED_CASE_TITLE] : [],
    mutationPhase: mutationFailureTail === null ? null : 'mutant',
    ...(mutationFailureTail === null ? {} : { failedCaseTitles: [mutationFailedCaseTitle] }),
    commitSha: 'fixture-clean-commit',
    worktreeDirty: false,
  };
  return {
    id: over.id,
    work_item_id: 'WI-101',
    plan_slug: PLAN,
    spec_id: SPEC,
    source_val_id: 'VAL-003-01',
    spec_revision: 1,
    current_revision: 1,
    spec_fingerprint: SPEC_FINGERPRINT,
    evidence_kind: over.evidenceKind,
    evidence_ref: over.evidenceRef,
    source_fingerprint: fingerprints.sourceFingerprint,
    test_fingerprint: fingerprints.testFingerprint,
    // Source, test, and fixture dimensions are all measured from this same temporary root.
    fixture_fingerprint: fingerprints.fixtureFingerprint ?? null,
    rubric_fingerprint: null,
    environment_fingerprint: null,
    coverage_evidence_ref: 42,
    coverage_evidence_present: true,
    test_run_id: over.testRunId ?? 43,
    test_run_present: true,
    // The fake durable ledger represents a measured clean run. Missing/dirty
    // provenance must stay unknown, independently of matching file hashes.
    test_run_file_path: 'test/reconnect.test.ts',
    test_run_commit_sha: 'fixture-clean-commit',
    test_run_worktree_dirty: false,
    test_run_status: testRunStatus,
    test_run_execution_details: executionDetails,
    mutation_failure_tail: mutationFailureTail,
    ...(mutationFailureTail === null ? {} : { mutation_execution_details: executionDetails }),
    details: {
      adequacy: {
        ...ADEQUACY,
        outcome: over.outcome,
        ...(over.testCases ? { testCases: over.testCases } : {}),
      },
      currentMeasurement: MEASUREMENT,
      measurementPin: fingerprints.pin,
    },
    observed_at: '2026-09-20 17:10:00-04',
    binding_fingerprint: `sha256:binding-${over.id}`,
    created_by: 'su-binder',
    created_at: `2026-09-20T21:10:0${over.id}.000Z`,
    spec_is_current: true,
  };
}

const MUTATION_FAILURE_CASE_TITLE =
  'code-search.callers-lookup — measurement and promotion state > keeps the lane honest';

async function installMeasuredFalsifiabilityProof(): Promise<void> {
  const fingerprints = await measureAndPinRepoFilesEvidenceAtRoot(root, MEASUREMENT);
  h.rows = h.rows
    .filter((row) => row.id !== 2)
    .map((row) => {
      if (row.id !== 3) return row;
      const details = row.details as Record<string, unknown>;
      const adequacy = details.adequacy as Record<string, unknown>;
      const run = row.test_run_execution_details as Record<string, unknown>;
      return {
        ...row,
        test_run_execution_details: { ...run, passedCaseTitles: [MUTATION_FAILURE_CASE_TITLE] },
        details: { ...details, adequacy: { ...adequacy, testCases: [MUTATION_FAILURE_CASE_TITLE] } },
      };
    });
  h.rows.push(bindingRow({
    id: 5,
    evidenceKind: 'mutation',
    evidenceRef: 'mutation-probe:callers-lookup:caught',
    outcome: 'caught',
    testRunId: 44,
    testRunSource: 'mutation-probe',
    testRunStatus: 'fail',
    testRunOutputTail: `${MUTATION_FAILURE_CASE_TITLE}: expected 'needs-widening' to be 'equivalent'`,
  }, fingerprints));
}

const activeClause = {
  planSlug: PLAN,
  specId: SPEC,
  sourceValId: 'VAL-003-01',
  currentRevision: 1,
  revision: 1,
  planItemId: 'P-003',
  behavior: 'An acknowledged event is not replayed after reconnect.',
  behaviorClass: 'happy-path',
  requiredEvidence: ['integration fixture'],
  requiredTestLayers: ['integration'],
  mutationRequired: false,
  lifecycleStatus: 'active',
  supersedes: null,
  exemption: null,
  falsifier: null,
  contentHash: SPEC_FINGERPRINT,
  createdBy: 'su-author',
  createdAt: '2026-09-20T00:00:00.000Z',
  acceptedBy: 'reviewer',
  acceptedAt: '2026-09-20T00:01:00.000Z',
  acceptanceRef: 'D-003',
  sourceBar: null,
};

type EvaluatorPayload = {
  ok: boolean;
  rows: Array<{
    verdict: string;
    wouldBlock: string[];
    measurementEvidence: SpecTestAdequacyMeasurementEvidence;
    ratings: Record<string, { rating: string; evidence: string; suggestion?: string }>;
    scorecardDraft: {
      rubricRef: string;
      subject: { kind: 'plan'; ref: string };
      ratings: Record<string, { rating: string; evidence: string; suggestion?: string }>;
      // The REAL recipe contract, not a hand-narrowed copy: a local subset silently fell
      // behind when assertions on evaluatorRevision/evaluatorBuild/selection were added
      // (WI-10006618), and vitest never typechecks, so only lint:tsc saw it.
      rerunRecipe: SpecTestAdequacyRerunRecipe;
    };
  }>;
};

/** Exactly what a real dispatch does to evaluator args: parse with the tool's own schema
 *  (which strips framework-reserved keys such as payloadTier), then run the handler. */
async function runEvaluator(args: Record<string, unknown>): Promise<EvaluatorPayload> {
  const parsed = evaluatorArgsSchema.parse(args);
  return ((await evaluatorTool.handler(parsed as never, {} as never)) as { data: EvaluatorPayload }).data;
}

let root = '';

async function writeSubject(sourceBody: string): Promise<void> {
  await writeFile(join(root, 'src', 'reconnect.ts'), sourceBody);
  await writeFile(join(root, 'test', 'reconnect.test.ts'), 'expect(replayed).toEqual([]);\n');
  await writeFile(join(root, 'fixtures', 'reconnect.fixture.ts'), 'export const reconnectFixture = true;\n');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'emit-evaluator-round-trip-'));
  h.measurementRoot = root;
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    mkdir(join(root, 'test'), { recursive: true }),
    mkdir(join(root, 'fixtures'), { recursive: true }),
  ]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.querySql = [];
  await writeSubject('export const ackedEventsReplayed = false;\n');
  execFileSync('git', ['add', '--all'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', [
    '-c', 'user.name=Spec Adequacy Test',
    '-c', 'user.email=spec-adequacy@example.invalid',
    'commit', '--quiet', '--allow-empty', '-m', 'spec adequacy measurement fixture',
  ], { cwd: root, stdio: 'ignore' });
  // Stored fingerprints are what binding MEASURED: derive them from the fixture checkout
  // at run time, so 'current' can only mean the server re-derived them.
  const bound = await measureAndPinRepoFilesEvidenceAtRoot(root, MEASUREMENT);
  h.rows = [
    bindingRow({ id: 1, evidenceKind: 'coverage-census', evidenceRef: 'surface:reconnect', outcome: 'passed' }, bound),
    bindingRow({ id: 2, evidenceKind: 'counterexample', evidenceRef: 'counterexample:reconnect', outcome: 'pass' }, bound),
    // Evaluator revision 5 requires a successful current test binding for the mutation or
    // counterexample's canonical test file on this exact clause revision.
    bindingRow({
      id: 3,
      evidenceKind: 'test',
      evidenceRef: 'test:reconnect',
      outcome: 'passed',
      testCases: [MEASURED_PASSED_CASE_TITLE],
    }, bound),
    // The clause requires an 'integration fixture'. Only fixture-scoped proof (an
    // evidenceKind='fixture' binding or a non-null fixture fingerprint) may attest
    // fixtureCalibrated; the flag on the test row above no longer counts
    // (guard-rail:spec-fixture-calibration-requires-proof). A fixture-kind binding keeps the
    // attested fixture fingerprint null, so freshness stays a measured pass.
    bindingRow({ id: 4, evidenceKind: 'fixture', evidenceRef: 'fixture:reconnect', outcome: 'passed' }, bound),
  ];
  listClauses.mockResolvedValue([activeClause as never]);

  const bundled = resolveLocalRubric('spec-test-adequacy');
  if (!bundled) throw new Error('rubrics/spec-test-adequacy/rubric.json must resolve');
  getRubric.mockResolvedValue({
    rubricId: 'spec-test-adequacy',
    workspaceId: 'workspace-test',
    kind: 'standard',
    characteristic: 'plan-proof',
    title: bundled.title,
    description: '',
    criteria: bundled.criteria,
    ratingScale: bundled.ratingScale,
    methodRef: null,
    status: 'active',
    createdBy: null,
    proposedBy: null,
    ratifiedBy: null,
  });
  getRubricPlanRevision.mockResolvedValue(7);
  readRubricPlanRevision.mockResolvedValue({ ok: true, revision: 7 });
  getAcceptanceRubricsForPlan.mockResolvedValue([
    { rubricId: 'rubric-fixture', classRef: 'plan-class-feature-ship' },
  ]);
  getRetiredAcceptanceRubricsForPlan.mockResolvedValue([]);
  getRubricCriteriaHash.mockResolvedValue(null);
  getRubricEvidenceIdentity.mockResolvedValue({
    revision: null,
    criteriaHash: null,
    meaningRevision: null,
  });
  listScorecards.mockResolvedValue([]);
  captureImprovement.mockResolvedValue({ ok: true, created: true, issue: { id: 'EI-ROUND-TRIP' } });
});

const dispatchTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name !== 'plans:evaluate-spec-test-adequacy') throw new Error(`unexpected replay dispatch: ${name}`);
  return runEvaluator(args);
});

/** Submit the evaluator's draft verbatim — the auditor-facing contract is "file what the
 *  evaluator returned, unedited". */
const emitDraft = (draft: EvaluatorPayload['rows'][number]['scorecardDraft']) =>
  emitScorecard(
    scorecardEmitArgs.parse(draft),
    { createdBy: 'su-grader' },
    { dispatchTool },
  );

describe('spec-test-adequacy evaluator → scorecards:emit round trip', () => {
  it('requires the measured mutation failed case in the successful same-clause testCases before scoring falsifiability', async () => {
    h.rows = h.rows
      .filter((row) => row.id !== 2)
      .map((row) => {
        if (row.id !== 3) return row;
        const details = row.details as Record<string, unknown>;
        const adequacy = details.adequacy as Record<string, unknown>;
        return {
          ...row,
          details: { ...details, adequacy: { ...adequacy, testCases: ['code-search.definition-lookup'] } },
        };
      });
    h.rows.push(bindingRow({
      id: 5,
      evidenceKind: 'mutation',
      evidenceRef: 'mutation-probe:callers-lookup:caught',
      outcome: 'caught',
      testRunId: 44,
      testRunSource: 'mutation-probe',
      testRunStatus: 'fail',
      // The ledger reporter's real format: `<case full name>: <message>` (the em dash is part
      // of the describe title, exactly as in live rows — WI-10006745).
      testRunOutputTail: "code-search.callers-lookup — measurement and promotion state > keeps the lane honest: expected 'needs-widening' to be 'equivalent'",
    }, await measureAndPinRepoFilesEvidenceAtRoot(root, MEASUREMENT)));

    const result = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      detail: 'full',
    });

    expect(result.rows[0]!.ratings.falsifiability.rating).toBe('unknown');
    expect(result.rows[0]!.ratings.falsifiability.evidence).toContain('code-search.callers-lookup');
    expect(result.rows[0]!.ratings.falsifiability.suggestion).toContain('adequacy.testCases');
    expect(h.querySql.some((sql) => sql.includes('tr.output_tail'))).toBe(true);
  });

  it.each([true, null])('refuses freshness pass when the durable run cleanliness is %s', async (dirty) => {
    h.rows = h.rows.map((row) => ({ ...row, test_run_worktree_dirty: dirty }));
    const live = await runEvaluator({ harness: 'papercusp', slug: PLAN, classRef: 'plan-class-feature-ship', specIds: [SPEC], detail: 'full' });
    expect(live.rows[0]!.verdict).toBe('unknown');
    expect(live.rows[0]!.wouldBlock).toContain('freshness');
    expect(live.rows[0]!.ratings.freshness.evidence).toContain(
      dirty === true ? 'test-run-worktree-not-clean' : 'test-run-worktree-cleanliness-unproven',
    );
  });

  it('files the evaluator’s own all-pass card, freshness included, through its own exact replay', async () => {
    await installMeasuredFalsifiabilityProof();
    const live = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      detail: 'full',
    });

    // Calibration: the live grade must itself be a full pass, or a green emit below
    // proves nothing about freshness=pass reproducing.
    expect(live.ok).toBe(true);
    expect(live.rows).toHaveLength(1);
    const [row] = live.rows;
    expect(Object.keys(row!.ratings).sort()).toEqual([...ADEQUACY_CRITERIA].sort());
    expect(row!.verdict, JSON.stringify({ wouldBlock: row!.wouldBlock, freshness: row!.ratings.freshness })).toBe('pass');
    expect(row!.ratings.freshness.rating, row!.ratings.freshness.evidence).toBe('pass');
    // `disclosed-gap` is legitimately not-applicable when the clause discloses no gap;
    // every other criterion must be a real pass for the card to be all-pass.
    for (const [criterion, rating] of Object.entries(row!.ratings)) {
      expect({ criterion, rating: rating.rating }).toEqual({
        criterion,
        rating: criterion === 'disclosed-gap' ? 'not-applicable' : 'pass',
      });
    }
    expect(row!.wouldBlock).toEqual([]);
    // The recipe carries the SERVER-measured tuple, so emit's supplied:false refusal
    // cannot be what lets freshness through.
    expect(row!.scorecardDraft.rerunRecipe.current.supplied).toBe(true);
    const recipe = row!.scorecardDraft.rerunRecipe;
    expect(row!.measurementEvidence.bindings.map(binding => binding.bindingId)).toEqual([1, 3, 4, 5]);
    expect(recipe.measurementEvidence).toEqual(row!.measurementEvidence);
    for (const binding of row!.measurementEvidence.bindings) {
      expect(binding.status).toBe('measured');
      expect(binding.measuredAtCommit).toMatch(/^[0-9a-f]{40}$/);
    }
    // The graded rule revision is envelope metadata; executable args stay valid against
    // the evaluator's strict schema while preserving the full scored input population.
    expect(recipe.evaluatorRevision).toBe(SPEC_TEST_ADEQUACY_EVALUATOR_REVISION);
    expect(recipe.args).not.toHaveProperty('evaluatorRevision');
    expect(recipe.args.evaluatorBuild).toEqual(recipe.evaluatorBuild);
    expect(recipe.args).toMatchObject({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      specRevision: recipe.selection.specRevision,
      specFingerprint: recipe.selection.specFingerprint,
      replaySnapshot: true,
      bindingIds: [1, 3, 4, 5],
      current: recipe.current.fingerprints,
    });
    expect(recipe.args.evidenceRefs).toEqual(
      recipe.selection.evidence.map(({ evidenceRef }) => evidenceRef).sort((a, b) => a.localeCompare(b)),
    );
    expect(row!.scorecardDraft.rerunRecipe.args).toMatchObject({ replaySnapshot: true, bindingIds: [1, 3, 4, 5] });
    expect(scorecardEmitArgs.parse(row!.scorecardDraft).rerunRecipe?.selection.bindingIds).toEqual([1, 3, 4, 5]);

    const exactReplay = await runEvaluator({
      ...row!.scorecardDraft.rerunRecipe.args,
      detail: 'summary',
      payloadTier: 'full',
    });
    const ratingValues = (ratings: Record<string, { rating: string }>) =>
      Object.fromEntries(Object.entries(ratings).map(([key, value]) => [key, value.rating]));
    expect({
      ratings: ratingValues(exactReplay.rows[0]!.ratings),
      wouldBlock: exactReplay.rows[0]!.wouldBlock,
    }).toEqual({ ratings: ratingValues(row!.ratings), wouldBlock: row!.wouldBlock });
    expect(exactReplay.rows[0]!.measurementEvidence).toEqual(recipe.measurementEvidence);

    const result = await emitDraft(row!.scorecardDraft);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, created: true, issueId: 'EI-ROUND-TRIP' });
    // The gate really replayed through the evaluator with the recipe's exact args.
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...row!.scorecardDraft.rerunRecipe.args,
      detail: 'summary',
      includeDraft: true,
      payloadTier: 'full',
    });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('replays an evaluator-generated draft-clause card with draft eligibility preserved', async () => {
    listClauses.mockResolvedValue([{ ...activeClause, lifecycleStatus: 'draft' } as never]);
    await installMeasuredFalsifiabilityProof();

    const live = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      includeDraft: true,
      detail: 'full',
    });

    expect(live.ok, JSON.stringify(live)).toBe(true);
    expect(live.rows).toHaveLength(1);
    expect(live.rows[0]!.verdict).toBe('pass');
    const draft = live.rows[0]!.scorecardDraft;
    expect(draft.rerunRecipe.args.includeDraft).toBe(true);

    const result = await emitDraft(draft);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, created: true, issueId: 'EI-ROUND-TRIP' });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledWith('plans:evaluate-spec-test-adequacy', {
      ...draft.rerunRecipe.args,
      detail: 'summary',
      includeDraft: true,
      payloadTier: 'full',
    });
  });

  it('refuses a card stamped by an older evaluator rule revision even when its build replay matches', async () => {
    const live = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      detail: 'full',
    });
    const draft = {
      ...live.rows[0]!.scorecardDraft,
      rerunRecipe: {
        ...live.rows[0]!.scorecardDraft.rerunRecipe,
        evaluatorRevision: SPEC_TEST_ADEQUACY_EVALUATOR_REVISION - 1,
      },
    };

    const result = await emitDraft(draft);

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining(
        `evaluator rule revision ${SPEC_TEST_ADEQUACY_EVALUATOR_REVISION - 1} does not match current revision ${SPEC_TEST_ADEQUACY_EVALUATOR_REVISION}`,
      ),
    });
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('refuses the same card once the proven source moves because its stored measurement no longer matches replay', async () => {
    await installMeasuredFalsifiabilityProof();
    const live = await runEvaluator({
      harness: 'papercusp',
      slug: PLAN,
      classRef: 'plan-class-feature-ship',
      specIds: [SPEC],
      detail: 'full',
    });
    expect(live.rows[0]!.ratings.freshness.rating, live.rows[0]!.ratings.freshness.evidence).toBe('pass');

    // The source changes after grading and before filing. The fresh replay re-measures at its
    // current commit, so emit must refuse the card when its stored measurement provenance is stale.
    await writeSubject('export const ackedEventsReplayed = true;\n');
    execFileSync('git', ['add', '--all'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', [
      '-c', 'user.name=Spec Adequacy Test',
      '-c', 'user.email=spec-adequacy@example.invalid',
      'commit', '--quiet', '-m', 'move the proven source after grading',
    ], { cwd: root, stdio: 'ignore' });

    const result = await emitDraft(live.rows[0]!.scorecardDraft);

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_spec_test_adequacy_binding',
      error: expect.stringContaining(
        'recorded server-measured per-binding measurement provenance does not match',
      ),
    });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});
