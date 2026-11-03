/**
 * plans:certify-spec-clauses (review-system-rework-reduction-2026-09-23 P-005, absorbing P-006).
 *
 * The verb must add NO grading logic: it runs the real evaluator and files each passing
 * clause's draft, unedited, through the real scorecards:emit body — so every card it files
 * has crossed emit's exact-replay gate against the SAME evaluator. These tests therefore
 * mock only I/O seams (DB rows, harness root, rubric/ledger persistence) and run the real
 * evaluator, real listSpecEvidence measurement over a temp checkout, and real emitScorecard.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  measurementRoot: '',
  planSlug: 'reconnect-plan',
  orgQueries: [] as string[],
  leaseHeld: false,
}));

const resourceAcquire = vi.hoisted(() => vi.fn());
const resourceRelease = vi.hoisted(() => vi.fn());
vi.mock('../locks/su-lock-store', async (original) => ({
  ...(await original<typeof import('../locks/su-lock-store')>()),
  acquireSharedResourceAtomic: (...args: unknown[]) => resourceAcquire(...args),
  releaseSharedResourceAtomic: (...args: unknown[]) => resourceRelease(...args),
  readResourceQueue: async () => ({
    holders: [{ owner: 'restart-owner', owner_label: 'restart', mode: 'exclusive', status: 'held' }],
    draining: false,
  }),
}));
vi.mock('../locks/in-workspace-txn', () => ({
  inWorkspaceTxn: async (_domain: string, _owner: string, run: (tx: unknown) => Promise<unknown>) => run({}),
}));

vi.mock('../../work-items', async (original) => ({
  ...(await original<typeof import('../../work-items')>()),
  getWorkItem: async () => ({ id: 'WI-101', harness: 'papercusp', kind: 'bug' }),
}));
vi.mock('./behavior-contract-resolver', async (original) => ({
  ...(await original<typeof import('./behavior-contract-resolver')>()),
  resolveWorkItemBehaviorContract: async () => ({
    groups: [{ planSlug: 'adhoc-work-item-specs', clauses: [{ specId: 'SPEC-PASS' }] }],
  }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({
      sql: (strings: TemplateStringsArray) => {
        const query = Array.from(strings).join(' ');
        // The SQL tag also constructs predicates; those are interpolated into the
        // SELECT, never executed as separate queries.
        if (query.trim() === 'TRUE' || query.trim() === "(template_data->>'kind' IS DISTINCT FROM 'acceptance')") return query;
        h.orgQueries.push(query);
        return Promise.resolve([]);
      },
    }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      const tx = ((strings: TemplateStringsArray | string[], ...values: unknown[]) => {
        const sql = Array.from(strings).join(' ');
        if (sql.includes('b.id = ANY')) return { bindingIds: values[0] };
        const selection = values.find((value): value is { bindingIds: number[] } =>
          !!value && typeof value === 'object' && 'bindingIds' in value);
        if (sql.includes('FROM harness_shared.spec_evidence_bindings b') && selection)
          return Promise.resolve(h.rows.filter(row => selection.bindingIds.includes(Number(row.id))));
        return Promise.resolve(sql.includes('provisional') ? [] : h.rows);
      }) as unknown;
      return fn(tx);
    },
  };
});
vi.mock('./source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source')>()),
  resolvePlanScope: async () => ({ workspaceId: 'workspace-test', harnessSlug: 'papercusp' }),
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: async () => ({}) as never,
  resolveHarnessContentPath: () => h.measurementRoot,
}));
vi.mock('../_harness-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_harness-scope')>()),
  harnessScopedCtx: vi.fn((_harness: unknown, ctx: unknown) => ctx),
}));
vi.mock('./_ctx-opts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_ctx-opts')>()),
  resolveEffectiveHarnessSlug: vi.fn(() => 'papercusp'),
}));
vi.mock('./spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spec-clauses-store')>()),
  listSpecClauses: vi.fn(),
}));
vi.mock('../../build-info', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../build-info')>()),
  getBuildInfo: vi.fn(() => ({ sha: 'certify-evaluator-sha', version: '1.0.0' })),
}));

const getRubric = vi.fn();
const getRubricEvidenceIdentity = vi.fn();
const getRubricPlanRevision = vi.fn();
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const completionGate = vi.fn();

vi.mock('../work_items/spec-test-adequacy-gate', () => ({
  specTestAdequacyCompletionGate: (...args: unknown[]) => completionGate(...args),
}));

vi.mock('../../rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: async () => [{ rubricId: 'reconnect-acceptance', classRef: 'plan-class-feature-ship' }],
  getRetiredAcceptanceRubricsForPlan: async () => [],
  getRubric: (...args: unknown[]) => getRubric(...args),
  getRubricCriteriaHash: async (rubricId: string) => (await getRubric(rubricId))?.criteriaHash ?? null,
  getRubricWithoutSeeding: (...args: unknown[]) => getRubric(...args),
  readRubric: async (...args: unknown[]) => {
    const rubric = await getRubric(...args);
    return rubric ? { kind: 'found', rubric } : { kind: 'missing' };
  },
  readRubricWithoutSeeding: async (...args: unknown[]) => {
    const rubric = await getRubric(...args);
    return rubric ? { kind: 'found', rubric } : { kind: 'missing' };
  },
  getRubricEvidenceIdentity: (...args: unknown[]) => getRubricEvidenceIdentity(...args),
  getRubricPlanRevision: (...args: unknown[]) => getRubricPlanRevision(...args),
  readRubricPlanRevision: (...args: unknown[]) => readRubricPlanRevision(...args),
}));
vi.mock('../../scorecards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scorecards')>()),
  listScorecards: (...args: unknown[]) => listScorecards(...args),
}));
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...args: unknown[]) => captureImprovement(...args),
}));
vi.mock('../../scout/generation-watermark', () => ({ readRunningGeneration: async () => null }));
// Emit's supersede validation reads the superseded card through getIssue.
const getIssue = vi.fn(async (_id: string): Promise<unknown> => null);
vi.mock('../../issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../issues-engineer')>()),
  getIssue: (id: string) => getIssue(id),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));
// grading-integrity's audit stand-down read records a fallback observation (31bff9e09f).
// Its buffered background flush writes through the faked org PG and would trip the
// unexpected-query guard in whichever test crosses the flush threshold or timer, so the
// sink is neutralized here as in the sibling tool tests.
vi.mock('../../degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../degradation/fallback-observations')>()),
  observeFallback: vi.fn(() => true),
}));

import certifyTool from './certify-spec-clauses';
import { certifyPassingRef } from './evaluate-spec-test-adequacy';
import { validateGradingAuditReplayConsistency } from '../scorecards/emit';
import { specTestAdequacySubjectRef } from './spec-test-adequacy';
import { asStructuredObservation } from '../../harness/improvements/observation-types';
import evaluatorTool, { argsSchema as evaluatorArgsSchema } from './evaluate-spec-test-adequacy';
import { listSpecClauses } from './spec-clauses-store';
import { measureRepoFilesEvidenceAtRoot } from './spec-evidence-store';
import { resolveLocalRubric } from '../../cupboard/rubric-store';

const listClauses = vi.mocked(listSpecClauses);

const PLAN = 'reconnect-plan';
const SPEC_FINGERPRINT = 'sha256:spec-v1';
const MEASUREMENT = {
  schemaVersion: 1 as const,
  kind: 'repo-files' as const,
  sourcePaths: ['src/reconnect.ts'],
  testPaths: ['test/reconnect.test.ts'],
  fixturePaths: ['test/reconnect.fixture.json'],
};
const FIXTURE_MEASUREMENT = { ...MEASUREMENT, fixturePaths: ['test/reconnect.fixture.json'] };
const CASE_TITLE = 'acknowledged events are not replayed';

function bindingRow(
  over: {
    id: number;
    specId: string;
    evidenceKind: string;
    evidenceRef: string;
    outcome: string;
    /**
     * adequacy.targeted. A mutation/counterexample row only demonstrates falsifiability when
     * this is the clause's own lowercase specId (spec-test-adequacy isAcceptedMutationTarget,
     * WI-10002724); a boolean `true` rates falsifiability `unknown` (WI-10002879).
     */
    targeted?: boolean | string;
  },
  fingerprints: { sourceFingerprint: string; testFingerprint: string | null },
): Record<string, unknown> {
  // A counterexample only demonstrates red capability as a measured mutant failure
  // (spec-test-adequacy measuredExecutionVerdict): a mutation-probe run in the mutant phase
  // that failed the declared case. A passing counterexample run rates execution `unknown`.
  const mutant = over.evidenceKind === 'counterexample';
  const execution = {
    schemaVersion: 1, root: h.measurementRoot, filePath: 'test/reconnect.test.ts', runGroupId: null,
    workspaceId: 'workspace-test', harnessSlug: 'papercusp', testNamePattern: null,
    passed: mutant ? 0 : 1, failed: mutant ? 1 : 0, skipped: 0, collectionFailed: false,
    mutationPhase: mutant ? 'mutant' : null,
    commitSha: 'fixture-clean-commit', worktreeDirty: false, testLayer: 'integration',
    ...(mutant ? { failedCaseTitles: [CASE_TITLE] } : { passedCaseTitles: [CASE_TITLE] }),
  };
  return {
    id: over.id,
    work_item_id: 'WI-101',
    plan_slug: h.planSlug,
    spec_id: over.specId,
    source_val_id: null,
    spec_revision: 1,
    current_revision: 1,
    spec_fingerprint: SPEC_FINGERPRINT,
    evidence_kind: over.evidenceKind,
    evidence_ref: over.evidenceRef,
    source_fingerprint: fingerprints.sourceFingerprint,
    test_fingerprint: fingerprints.testFingerprint,
    fixture_fingerprint: fixtureBound.fixtureFingerprint,
    rubric_fingerprint: null,
    environment_fingerprint: null,
    coverage_evidence_ref: 42,
    coverage_evidence_present: true,
    test_run_id: 43,
    test_run_present: true,
    test_run_file_path: 'test/reconnect.test.ts',
    test_run_commit_sha: 'fixture-clean-commit',
    test_run_worktree_dirty: false,
    test_run_status: mutant ? 'fail' : 'pass',
    test_run_execution_details: execution,
    ...(mutant ? { test_run_source: 'mutation-probe', mutation_failure_tail: null, mutation_execution_details: execution } : {}),
    details: {
      adequacy: {
        fixtureFree: false,
        testCases: [CASE_TITLE],
        // An empty scenarioIds list is malformed contract metadata (scenarioIds:invalid).
        ...(mutant ? { scenarioIds: ['acknowledged-event-negative-control'] } : {}),
        fixtureCalibrated: true,
        falsifiable: true,
        testLayer: 'integration',
        pathReachable: true,
        oracleIndependent: true,
        collected: true,
        skipped: false,
        executed: true,
        // Correct-layer and the L3 risk floor count a binding only when its target names this
        // exact clause (spec-test-adequacy bindingTargetsClause): the lowercase specId.
        targeted: over.targeted ?? over.specId.toLowerCase(),
        coverageRungs: { l3: true, l4: false },
        outcome: over.outcome,
      },
      currentMeasurement: over.evidenceKind === 'fixture' ? FIXTURE_MEASUREMENT : MEASUREMENT,
    },
    observed_at: '2026-09-20 17:10:00-04',
    binding_fingerprint: `sha256:binding-${over.id}`,
    created_by: 'su-binder',
    created_at: `2026-09-20T21:10:${String(over.id).padStart(2, '0')}.000Z`,
    spec_is_current: true,
  };
}

const clause = (specId: string, lifecycleStatus: 'active' | 'draft' = 'active'): Awaited<ReturnType<typeof listSpecClauses>>[number] =>
  ({
    planSlug: h.planSlug,
    specId,
    sourceValId: null,
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-003',
    behavior: `${specId}: an acknowledged event is not replayed after reconnect.`,
    behaviorClass: 'happy-path',
    // Must not name a fixture: since 076100a289 a clause whose requiredEvidence names one needs
    // fixture-fingerprinted executable proof, and these executable bindings attest fixtureFree.
    requiredEvidence: ['integration test'],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus,
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: SPEC_FINGERPRINT,
    createdBy: 'su-author',
    createdAt: '2026-09-20T00:00:00.000Z',
    acceptedBy: lifecycleStatus === 'draft' ? null : 'reviewer',
    acceptedAt: lifecycleStatus === 'draft' ? null : '2026-09-20T00:01:00.000Z',
    acceptanceRef: lifecycleStatus === 'draft' ? null : 'D-003',
    sourceBar: null,
  });

let root = '';
let bound: { sourceFingerprint: string; testFingerprint: string | null };
let fixtureBound: Awaited<ReturnType<typeof measureRepoFilesEvidenceAtRoot>>;

const writeSubject = (body: string) => writeFile(join(root, 'src', 'reconnect.ts'), body);

/** Replay dispatch the way a real host does it: the evaluator's own schema, then its handler. */
const replayViaEvaluator = async (args: Record<string, unknown>) =>
  ((await evaluatorTool.handler(evaluatorArgsSchema.parse(args) as never, {} as never)) as { data: unknown }).data;

const dispatchTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name !== 'plans:evaluate-spec-test-adequacy') throw new Error(`unexpected dispatch: ${name}`);
  return replayViaEvaluator(args);
});

const ctx = () =>
  ({ isSuperuser: true, uiClientId: 'su-certifier', workspaceId: 'workspace-test', projectDir: root, dispatchTool }) as never;

type CertifyResult = {
  ok: boolean;
  dryRun: boolean;
  counts?: Record<string, number>;
  clauses?: Array<{ specId: string; verdict: string; wouldBlock: string[]; card: Record<string, unknown> }>;
  evaluator?: Record<string, unknown>;
};

const certify = async (args: Record<string, unknown>) =>
  ((await certifyTool.handler(
    certifyTool.args.parse({ harness: 'papercusp', slug: PLAN, classRef: 'plan-class-feature-ship', ...args }) as never,
    ctx(),
  )) as { data: CertifyResult }).data;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'certify-spec-clauses-'));
  h.measurementRoot = root;
  await Promise.all([mkdir(join(root, 'src'), { recursive: true }), mkdir(join(root, 'test'), { recursive: true })]);
  await writeFile(join(root, 'test', 'reconnect.test.ts'), 'expect(replayed).toEqual([]);\n');
  await writeFile(join(root, 'test', 'reconnect.fixture.json'), '{"acknowledgedEventIds":["event-1"]}\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.leaseHeld = false;
  resourceAcquire.mockReset().mockImplementation(async () => {
    h.leaseHeld = true;
    return { ok: true, lock_id: 'certification-lease', expires_ts: new Date(Date.now() + 60_000), reused: false };
  });
  resourceRelease.mockReset().mockImplementation(async () => {
    h.leaseHeld = false;
    return { released: 1, expired: false };
  });
  completionGate.mockResolvedValue({ ok: true, applicable: true, checked: ['SPEC-PASS@1'] });
  h.planSlug = PLAN;
  h.orgQueries = [];
  await writeSubject('export const ackedEventsReplayed = false;\n');
  bound = await measureRepoFilesEvidenceAtRoot(root, MEASUREMENT);
  fixtureBound = await measureRepoFilesEvidenceAtRoot(root, FIXTURE_MEASUREMENT);
  // SPEC-PASS has a positive proof AND a counterexample; SPEC-BLOCKED has only the
  // positive proof, so falsifiability cannot be demonstrated and the clause is blocked.
  h.rows = [
    bindingRow({ id: 1, specId: 'SPEC-PASS', evidenceKind: 'coverage-census', evidenceRef: 'surface:pass', outcome: 'passed' }, bound),
    bindingRow(
      { id: 2, specId: 'SPEC-PASS', evidenceKind: 'counterexample', evidenceRef: 'counterexample:pass', outcome: 'pass', targeted: 'spec-pass' },
      bound,
    ),
    bindingRow({ id: 3, specId: 'SPEC-BLOCKED', evidenceKind: 'coverage-census', evidenceRef: 'surface:blocked', outcome: 'passed' }, bound),
    // Current falsifiability requires a successful test binding to the same immutable clause
    // revision and canonical test file as its counterexample.
    bindingRow({ id: 4, specId: 'SPEC-PASS', evidenceKind: 'test', evidenceRef: 'test:pass', outcome: 'passed' }, bound),
    // `fixtureCalibrated` only counts when fixture-scoped evidence is bound to this clause.
    bindingRow({ id: 5, specId: 'SPEC-PASS', evidenceKind: 'fixture', evidenceRef: 'fixture:pass', outcome: 'passed' }, bound),
  ];
  listClauses.mockImplementation(async (input: { specIds?: string[] }) => {
    const all = [clause('SPEC-PASS'), clause('SPEC-BLOCKED')] as Array<{ specId: string }>;
    return (input.specIds ? all.filter((c) => input.specIds!.includes(c.specId)) : all) as never;
  });

  const bundled = resolveLocalRubric('spec-test-adequacy');
  if (!bundled) throw new Error('rubrics/spec-test-adequacy/rubric.json must resolve');
  getRubric.mockResolvedValue({
    rubricId: 'spec-test-adequacy',
    revision: 7,
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
  getRubricEvidenceIdentity.mockResolvedValue({ revision: 7, criteriaHash: null, meaningRevision: null });
  readRubricPlanRevision.mockResolvedValue({ ok: true, revision: 7 });
  listScorecards.mockResolvedValue([]);
  getIssue.mockImplementation(async () => null);
  let seq = 0;
  captureImprovement.mockImplementation(async () => ({ ok: true, created: true, issue: { id: `EI-CERT-${++seq}` } }));
});

afterEach(() => {
  // Audit stand-down and scorecard plan-template lookup are the modeled direct
  // org-PG reads. No plan template exists in this fixture; its rubric is mocked above.
  // A new query cannot silently succeed against an empty fake database.
  const unexpected = h.orgQueries.filter((query) =>
    !/^\s*SELECT target_owner_id, metadata->'pause' AS pause\s+FROM harness_shared\.routines\b/.test(query) &&
    !/^\s*SELECT plan_slug, workspace_id, harness_slug,[\s\S]*?FROM harness_shared\.harness_plans\b/.test(query),
  );
  expect(unexpected).toEqual([]);
});

describe('plans:certify-spec-clauses', () => {
  describe('mechanical proof without judgment cards', () => {
    async function mechanicalClause(): Promise<Awaited<ReturnType<typeof listSpecClauses>>[number]> {
      const standard = await getRubric('spec-test-adequacy');
      const sourceBar = { rubricSlug: 'mechanical-bar', rubricRevision: 1, barSetHash: 'bars',
        barKey: 'R-1', barHash: 'bar-1', evidencePlane: 'tree' as const };
      getRubric.mockImplementation(async (slug: string) => slug === sourceBar.rubricSlug ? {
        ...standard, rubricId: sourceBar.rubricSlug, revision: 1, kind: 'acceptance', barSetHash: 'bars',
        criteria: [{ ...standard.criteria[0], barKey: 'R-1', barHash: 'bar-1', evidencePlane: 'tree',
          check: { kind: 'tests', files: ['test/reconnect.test.ts'] } }],
      } : standard);
      return { ...clause('SPEC-PASS'), sourceBar };
    }

    function calibrateMutant() {
      const mutant = h.rows.find(row => row.id === 2)!;
      const execution = mutant.test_run_execution_details as Record<string, unknown>;
      const mutation: import('@papercusp/test-config/mutation-descriptor').MutationDescriptor = {
        schemaVersion: 1, probeInvocationId: 'certify-mechanical', leg: 'mutant', mode: 'copy-out',
        subjectPath: 'src/reconnect.ts', mutateExpression: 's/false/true/', againstCommit: null,
        subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
        mutantDiff: '-false\n+true', mutantDiffTruncated: false,
        testCommandSha256: 'c'.repeat(64), testFileSha256: 'd'.repeat(64),
      };
      mutant.test_run_execution_details = { ...execution, mutation };
      mutant.mutation_execution_details = mutant.test_run_execution_details;
      mutant.mutation_baseline_id = 99;
      mutant.mutation_baseline_status = 'pass';
      mutant.mutation_baseline_execution_details = { ...execution, mutationPhase: 'baseline',
        passed: 1, failed: 0, failedCaseTitles: undefined, passedCaseTitles: [CASE_TITLE],
        mutation: { ...mutation, leg: 'baseline' } };
    }

    it('rejects descriptorless historical proof even when the legacy evaluator passes it', async () => {
      const selected = await mechanicalClause();
      listClauses.mockResolvedValue([selected]);
      const historical = await replayViaEvaluator({ harness: 'papercusp', slug: PLAN,
        classRef: 'plan-class-feature-ship', specIds: ['SPEC-PASS'], specRevision: 1,
        specFingerprint: SPEC_FINGERPRINT, replaySnapshot: true, detail: 'full' });
      expect(historical).toMatchObject({ rows: [{ verdict: 'pass', evaluationMode: 'judgment' }] });

      const result = await certify({ specIds: ['SPEC-PASS'] });
      expect(result).toMatchObject({ ok: true, counts: { filed: 0, notPassing: 1, mechanicallyVerified: 0 },
        clauses: [{ verdict: 'fail', card: { status: 'not-passing' },
          mechanicalProof: { caughtMutantBindingIds: [], gaps: [expect.stringContaining('verified calibration linkage')] } }] });
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(dispatchTool).not.toHaveBeenCalled();
    });

    it.each([false, true])('returns calibrated ledger verification without filing or replaying a card (dryRun=%s)', async dryRun => {
      listClauses.mockResolvedValue([await mechanicalClause()]);
      calibrateMutant();
      const result = await certify({ specIds: ['SPEC-PASS'], dryRun });
      expect(result).toMatchObject({ ok: true, counts: { passing: 1, filed: 0, notPassing: 0, mechanicallyVerified: 1 },
        clauses: [{ verdict: 'pass', card: { status: 'not-required', reason: 'mechanical-test-adequacy' },
          mechanicalProof: { passingTestBindingIds: { 'test/reconnect.test.ts': 4 },
            caughtMutantBindingIds: [2], gaps: [] } }] });
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(dispatchTool).not.toHaveBeenCalled();
    });

    it.each(['missing-test', 'missing-mutant', 'stale-source'])(
      'keeps %s proof non-passing without scorecard creation', async defect => {
        listClauses.mockResolvedValue([await mechanicalClause()]);
        calibrateMutant();
        if (defect === 'missing-test') h.rows = h.rows.filter(row => row.evidence_kind !== 'test');
        if (defect === 'missing-mutant') h.rows = h.rows.filter(row => row.id !== 2);
        if (defect === 'stale-source') await writeSubject('export const ackedEventsReplayed = true;\n');
        const result = await certify({ specIds: ['SPEC-PASS'] });
        expect(result).toMatchObject({ counts: { filed: 0, notPassing: 1, mechanicallyVerified: 0 },
          clauses: [{ verdict: 'fail', card: { status: 'not-passing' } }] });
        expect(captureImprovement).not.toHaveBeenCalled();
      },
    );

    it('files only the judgment clause in a mixed mechanical and legacy evaluation', async () => {
      const mechanical = await mechanicalClause();
      const legacy = clause('SPEC-LEGACY');
      h.rows.push(...h.rows.filter(row => row.spec_id === 'SPEC-PASS').map(row => ({
        ...row, id: Number(row.id) + 20, spec_id: legacy.specId,
        evidence_ref: `${row.evidence_ref}:legacy`, binding_fingerprint: `${row.binding_fingerprint}:legacy`,
        details: { ...(row.details as Record<string, unknown>), adequacy: {
          ...((row.details as { adequacy: Record<string, unknown> }).adequacy), targeted: 'spec-legacy',
        } },
      })));
      calibrateMutant();
      listClauses.mockImplementation(async input =>
        [mechanical, legacy].filter(row => !input.specIds || input.specIds.includes(row.specId)));
      const result = await certify({});
      expect(result).toMatchObject({ ok: true, counts: { passing: 2, filed: 1, mechanicallyVerified: 1 },
        clauses: [{ specId: 'SPEC-PASS', card: { status: 'not-required' } },
          { specId: 'SPEC-LEGACY', card: { status: 'filed' } }] });
      expect(captureImprovement).toHaveBeenCalledTimes(1);
    });
  });

  describe('staging runtime lease', () => {
    it.each([false, true])('refuses before evaluation or filing while a restart owns staging (dryRun=%s)', async (dryRun) => {
      resourceAcquire.mockResolvedValueOnce({
        ok: false,
        reason: 'held_exclusive',
        holders: [{ owner: 'restart-owner', owner_label: 'restart', mode: 'exclusive', status: 'held' }],
      });

      const result = await certify({ dryRun });

      expect(result).toMatchObject({
        ok: false,
        reason: 'resource_held_exclusive',
        resource: 'staging-server',
        holders: [{ owner: 'restart-owner', mode: 'exclusive', status: 'held' }],
      });
      expect(listClauses).not.toHaveBeenCalled();
      expect(dispatchTool).not.toHaveBeenCalled();
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(resourceRelease).not.toHaveBeenCalled();
    });

    it('holds one host-wide shared lease across evaluation, both serial filings and their replays', async () => {
      h.rows.push(
        bindingRow({ id: 6, specId: 'SPEC-BLOCKED', evidenceKind: 'counterexample', evidenceRef: 'counterexample:second', outcome: 'pass' }, bound),
        bindingRow({ id: 7, specId: 'SPEC-BLOCKED', evidenceKind: 'test', evidenceRef: 'test:second', outcome: 'passed' }, bound),
        bindingRow({ id: 8, specId: 'SPEC-BLOCKED', evidenceKind: 'fixture', evidenceRef: 'fixture:second', outcome: 'passed' }, bound),
      );
      listClauses.mockImplementation(async (input: { specIds?: string[] }) => {
        expect(h.leaseHeld).toBe(true);
        const all = [clause('SPEC-PASS'), clause('SPEC-BLOCKED')];
        return (input.specIds ? all.filter((row) => input.specIds!.includes(row.specId)) : all) as never;
      });
      let filed = 0;
      captureImprovement.mockImplementation(async () => {
        expect(h.leaseHeld).toBe(true);
        expect(resourceRelease).not.toHaveBeenCalled();
        return { ok: true, created: true, issue: { id: `EI-LEASE-${++filed}` } };
      });

      const result = await certify({});

      expect(result.counts, JSON.stringify(result)).toMatchObject({ filed: 2, refused: 0 });
      expect(resourceAcquire).toHaveBeenCalledOnce();
      expect(resourceAcquire).toHaveBeenCalledWith(expect.objectContaining({
        coordinationDomain: 'papercusp-host-global',
        resource: 'staging-server',
        owner: 'su-certifier',
        ttlSec: (certifyTool.timeoutSec ?? 0) + 60,
      }));
      expect(resourceRelease).toHaveBeenCalledOnce();
      expect(resourceRelease).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'su-certifier', lockId: 'certification-lease',
      }));
      expect(h.leaseHeld).toBe(false);
    });

    it('releases the lease when evaluation throws before any card is filed', async () => {
      const failure = new Error('evaluation failed');
      const evaluation = vi.spyOn(evaluatorTool, 'handler').mockRejectedValueOnce(failure);
      try {
        await expect(certify({})).rejects.toBe(failure);
      } finally {
        evaluation.mockRestore();
      }
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(resourceRelease).toHaveBeenCalledOnce();
      expect(h.leaseHeld).toBe(false);
    });

    it('releases the lease when a serial card filing fails', async () => {
      captureImprovement.mockRejectedValueOnce(new Error('card persistence failed'));

      await expect(certify({ specIds: ['SPEC-PASS'] })).rejects.toThrow('card persistence failed');
      expect(captureImprovement).toHaveBeenCalledOnce();
      expect(resourceRelease).toHaveBeenCalledOnce();
      expect(h.leaseHeld).toBe(false);
    });
  });

  it('does not certify calibrated fixture claims without a measured fixture fingerprint', async () => {
    h.rows = h.rows.map((row) => row.evidence_kind === 'fixture' ? { ...row, fixture_fingerprint: null } : row);
    const result = await certify({ specIds: ['SPEC-PASS'] });
    expect(result.counts).toMatchObject({ passing: 0, filed: 0 });
    expect(result.clauses![0]!.wouldBlock).toContain('freshness');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it.each([false, true])('retains measurement diagnostics when certification cannot measure source (dryRun=%s)', async (dryRun) => {
    await rm(join(root, 'src', 'reconnect.ts'));
    const evaluated = await replayViaEvaluator({
      harness: 'papercusp', slug: PLAN, classRef: 'plan-class-feature-ship',
      specIds: ['SPEC-PASS'], detail: 'full',
    }) as { evaluatorBuild: unknown; rows: Array<{ measurementEvidence: unknown }> };
    expect(evaluated.rows[0]!.measurementEvidence).toMatchObject({
      status: 'degraded', measuredBindings: 0,
      unavailableBindings: expect.arrayContaining([expect.objectContaining({ reason: expect.any(String) })]),
    });

    const result = await certify({ specIds: ['SPEC-PASS'], dryRun });
    expect(result).toMatchObject({
      evaluatorBuild: evaluated.evaluatorBuild,
      counts: { passing: 0, filed: 0 },
      clauses: [{
        measurementEvidence: evaluated.rows[0]!.measurementEvidence,
        wouldBlock: expect.arrayContaining(['freshness']),
        card: { status: 'not-passing' },
      }],
    });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('certifies an exact ad-hoc bug clause through the real evaluator and replay without a namespace acceptance class', async () => {
    h.planSlug = 'adhoc-work-item-specs';
    h.rows = h.rows.filter((row) => row.spec_id === 'SPEC-PASS').map((row) => ({ ...row, plan_slug: h.planSlug }));
    const result = await certify({
      slug: h.planSlug, classRef: 'plan-class-bugfix', workItemIds: ['WI-101'], specIds: ['SPEC-PASS'],
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, counts: { clauses: 1, passing: 1, filed: 1, refused: 0 },
    });
    const observation = asStructuredObservation((captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } }).payloadExtra.observation)!;
    expect(observation.rerunRecipe?.args).toMatchObject({
      slug: h.planSlug, classRef: 'plan-class-bugfix', workItemIds: ['WI-101'], specIds: ['SPEC-PASS'],
    });
    const replay = await replayViaEvaluator(observation.rerunRecipe!.args!);
    expect(replay).toMatchObject({ ok: true, classRefSource: 'work-item-completion-attestation', count: 1 });
  });

  it.each([true, null])('does not file a passing card from run cleanliness=%s', async (dirty) => {
    h.rows = h.rows.map((row) => ({ ...row, test_run_worktree_dirty: dirty }));
    const result = await certify({ specIds: ['SPEC-PASS'] });
    expect(result.counts).toMatchObject({ passing: 0, filed: 0 });
    expect(result.clauses![0]!.wouldBlock).toContain('freshness');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('files a terminal card for each passing clause, through the exact replay, and never files a blocked one', async () => {
    const result = await certify({ specIds: ['SPEC-PASS', 'SPEC-BLOCKED'] });

    expect(result.ok).toBe(true);
    expect(result.counts, JSON.stringify(result.clauses)).toEqual({ clauses: 2, passing: 1, filed: 1, unchanged: 0, refused: 0, notPassing: 1 });
    const bySpec = Object.fromEntries((result.clauses ?? []).map((c) => [c.specId, c]));
    expect(bySpec['SPEC-PASS']).toMatchObject({ verdict: 'pass', wouldBlock: [], card: { status: 'filed', issueId: 'EI-CERT-1' } });
    expect(bySpec['SPEC-BLOCKED']!.card).toEqual({ status: 'not-passing' });
    expect(bySpec['SPEC-BLOCKED']!.wouldBlock).toContain('falsifiability');

    // Exactly one card filed, and it crossed emit's exact-replay gate: the replay ran the
    // evaluator with the filed card's own recipe (a pinned, replaySnapshot replay).
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool.mock.calls[0]![1]).toMatchObject({ specIds: ['SPEC-PASS'], replaySnapshot: true });
  });

  it('certifies and replays only the exact pinned cohort despite a later same-ref binding', async () => {
    h.rows.push({
      ...bindingRow({ id: 6, specId: 'SPEC-PASS', evidenceKind: 'test', evidenceRef: 'test:pass', outcome: 'passed' }, bound),
      test_run_worktree_dirty: true,
    });
    const unselected = await certify({ specIds: ['SPEC-PASS'], dryRun: true });
    expect(unselected.counts).toMatchObject({ passing: 0, filed: 0 });

    const bindingIds = [1, 2, 4, 5];
    const result = await certify({ specIds: ['SPEC-PASS'], bindingIds });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true, counts: { passing: 1, filed: 1, refused: 0 },
    });
    expect(result.clauses![0]).toMatchObject({ measurementEvidence: {
      selectedBindings: 4, bindings: bindingIds.map(bindingId => expect.objectContaining({ bindingId })),
    } });
    expect(dispatchTool.mock.calls[0]![1]).toMatchObject({ bindingIds, replaySnapshot: true });
    const observation = asStructuredObservation((captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } }).payloadExtra.observation)!;
    expect(observation.rerunRecipe?.args).toMatchObject({ bindingIds });
    expect((await replayViaEvaluator(observation.rerunRecipe!.args!))).toMatchObject({
      ok: true, rows: [{ verdict: 'pass', measurementEvidence: { selectedBindings: 4 } }],
    });
  });

  it('an explicitly empty binding cohort cannot widen into all available proof', async () => {
    const result = await certify({ specIds: ['SPEC-PASS'], bindingIds: [] });
    expect(result).toMatchObject({ ok: false, evaluator: { ok: false, error: 'selection_empty' } });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('keeps a draft clause in the exact replay when includeDraft:true was used for grading', async () => {
    const specId = 'SPEC-DRAFT';
    h.rows = [
      ...h.rows,
      bindingRow({ id: 6, specId, evidenceKind: 'coverage-census', evidenceRef: 'surface:draft', outcome: 'passed' }, bound),
      bindingRow(
        { id: 7, specId, evidenceKind: 'counterexample', evidenceRef: 'counterexample:draft', outcome: 'pass', targeted: specId.toLowerCase() },
        bound,
      ),
      bindingRow({ id: 8, specId, evidenceKind: 'test', evidenceRef: 'test:draft', outcome: 'passed' }, bound),
      bindingRow({ id: 9, specId, evidenceKind: 'fixture', evidenceRef: 'fixture:draft', outcome: 'passed' }, bound),
    ];
    listClauses.mockImplementation(async (input: { specIds?: string[] }) => {
      const all = [clause(specId, 'draft')] as Array<{ specId: string }>;
      return (input.specIds ? all.filter((c) => input.specIds!.includes(c.specId)) : all) as never;
    });

    const preview = await certify({ specIds: [specId], includeDraft: true, dryRun: true });
    expect(preview).toMatchObject({ ok: true, dryRun: true, clauses: [{ card: { status: 'would-file' } }] });
    expect(dispatchTool).not.toHaveBeenCalled();

    const result = await certify({ specIds: [specId], includeDraft: true });

    expect(result).toMatchObject({ ok: true, counts: { passing: 1, filed: 1, refused: 0 } });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool.mock.calls[0]![1]).toMatchObject({ specIds: [specId], includeDraft: true, replaySnapshot: true });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('EI-24340389297788793: the refusal remedy is accepted and reaches scorecards:emit', async () => {
    const first = await certify({ specIds: ['SPEC-PASS'] });
    expect(first.counts).toMatchObject({ filed: 1 });
    const persisted = (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } })
      .payloadExtra.observation;
    const prior = asStructuredObservation(persisted);
    expect(prior).toBeTruthy();
    listScorecards.mockResolvedValue([{
      issueId: 'EI-PRIOR-INDEPENDENT',
      rubricRef: 'spec-test-adequacy',
      rubricRevision: 7,
      subject: { kind: 'plan', ref: specTestAdequacySubjectRef(PLAN, 'SPEC-PASS', 1) },
      createdBy: 'su-peer',
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      synthesized: false,
    }]);

    const refused = await certify({ specIds: ['SPEC-PASS'] });
    expect(refused).toMatchObject({
      ok: false,
      clauses: [{ card: { status: 'refused', code: 'existing_independent_scorecards' } }],
    });

    const acknowledged = await certify({ specIds: ['SPEC-PASS'], acknowledgeExisting: true });
    expect(acknowledged).toMatchObject({ ok: true, counts: { filed: 1, refused: 0 } });
    expect(captureImprovement).toHaveBeenCalledTimes(2);
  });

  // Clause RSR-P-005-A: "A card emitted by the evaluate-and-emit verb passes the auditor
  // replay unchanged." Falsifier: the auditor rejects or alters a card the evaluator
  // emitted from the same snapshot. So: take the observation emit ACTUALLY PERSISTED for
  // the card this verb filed, and run the grading-integrity auditor's own replay on it.
  // 'grading_audit_replay_consistent' is the auditor's verdict that the exact replay
  // reproduced every applicable rating with no wouldBlock contradiction.
  describe('auditor replay on a card the verb filed (RSR-P-005-A)', () => {
    // Historical audit reconstructs the card at emission; it never reads today's code
    // as though it were the recorded snapshot.
    const historicalContext = { gradedCardCreatedAt: '2026-09-20T22:00:00.000Z', workspaceId: 'workspace-test' };
    const auditClaim = {
      're-runnable-evidence': { rating: 'pass', evidence: 'replayed the stored recipe' },
      'degenerate-distribution': { rating: 'fail', evidence: 'claimed contradiction to corroborate' },
    };

    const filedObservation = async () => {
      const result = await certify({ specIds: ['SPEC-PASS'] });
      expect(result.counts).toMatchObject({ filed: 1 });
      expect(captureImprovement).toHaveBeenCalledTimes(1);
      const persisted = (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } })
        .payloadExtra.observation;
      const observation = asStructuredObservation(persisted);
      // Calibration: the persisted card is a spec-test-adequacy card with its recipe, or
      // the auditor below would short-circuit and its verdict would mean nothing.
      expect(observation).toMatchObject({ rubricRef: 'spec-test-adequacy' });
      expect(observation?.rerunRecipe).toBeTruthy();
      return observation!;
    };

    it('reproduces every rating unchanged', async () => {
      const observation = await filedObservation();

      const verdict = await validateGradingAuditReplayConsistency(observation, auditClaim as never, dispatchTool, historicalContext);

      expect(verdict).toMatchObject({ code: 'grading_audit_replay_consistent' });
    });

    it('preserves the historical verdict after code moves while current certification refuses it', async () => {
      const observation = await filedObservation();
      await writeSubject('export const ackedEventsReplayed = true;\n');

      const verdict = await validateGradingAuditReplayConsistency(observation, auditClaim as never, dispatchTool, historicalContext);

      expect(verdict).toMatchObject({ code: 'grading_audit_replay_consistent' });
      const current = await certify({ specIds: ['SPEC-PASS'] });
      expect(current.counts).toMatchObject({ passing: 0, filed: 0 });
      expect(current.clauses![0]!.wouldBlock).toContain('freshness');
      expect(captureImprovement).toHaveBeenCalledTimes(1);
    });

    it('finds an altered recorded rating through the exact historical replay (falsifier)', async () => {
      const observation = await filedObservation();
      const altered = {
        ...observation,
        ratings: { ...observation.ratings, freshness: { rating: 'fail', evidence: 'Altered recorded rating.' } },
      };
      const verdict = await validateGradingAuditReplayConsistency(altered, auditClaim as never, dispatchTool, historicalContext);

      // undefined = the auditor found a mismatch, so its claimed contradiction stands.
      expect(verdict).toBeUndefined();
    });
  });

  it('dryRun grades and reports without filing or replaying anything', async () => {
    const result = await certify({ specIds: ['SPEC-PASS', 'SPEC-BLOCKED'], dryRun: true });

    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(result.counts).toMatchObject({ passing: 1, filed: 0, notPassing: 1 });
    expect(result.clauses?.find((c) => c.specId === 'SPEC-PASS')?.card).toEqual({ status: 'would-file' });
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('does not claim work-item readiness from an unscoped certification', async () => {
    const result = await certify({ specIds: ['SPEC-PASS'], dryRun: true });
    expect(result).toMatchObject({
      counts: { passing: 1 },
      completionReadiness: { status: 'not-checked', note: expect.stringContaining('multiple work items') },
    });
    expect(completionGate).not.toHaveBeenCalled();
  });

  it('reports the real scoped gate refusal without changing the globally passing clause or filing a duplicate', async () => {
    // The real evaluator reads the combined clause cohort; the completion seam
    // supplies the canonical refusal for a target missing its sibling's proof.
    h.rows[0]!.work_item_id = 'WI-parent';
    completionGate.mockResolvedValue({
      ok: false, applicable: true, retryable: true, checked: [],
      reason: 'SPEC-PASS@1: target WI-101 lacks clause-bound mutation proof',
    });
    const result = await certify({ specIds: ['SPEC-PASS'], completionWorkItemId: 'WI-101', dryRun: true });
    expect(completionGate).toHaveBeenCalledWith({
      workItem: { id: 'WI-101', harness: 'papercusp', kind: 'bug' },
      attestation: { classRef: 'plan-class-feature-ship' },
    });
    expect(result).toMatchObject({
      ok: true, counts: { passing: 1, filed: 0 },
      clauses: [{ specId: 'SPEC-PASS', verdict: 'pass', card: { status: 'would-file' } }],
      completionReadiness: {
        status: 'not-ready', workItemId: 'WI-101', checkedBeforeFiling: true,
        gate: { ok: false, reason: expect.stringContaining('mutation proof') },
      },
    });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('defaults the advisory target from one workItemIds entry and preserves unavailable gate evidence', async () => {
    completionGate.mockRejectedValue(new Error('completion measurement unavailable'));
    const result = await certify({ specIds: ['SPEC-PASS'], workItemIds: ['WI-101'], dryRun: true });
    expect(completionGate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true, counts: { passing: 1 },
      completionReadiness: { status: 'unavailable', workItemId: 'WI-101', reason: 'completion measurement unavailable' },
    });
  });

  it('dryRun reports a pending grading-audit refusal for an existing clause card', async () => {
    const subjectRef = specTestAdequacySubjectRef(PLAN, 'SPEC-PASS', 1);
    listScorecards.mockResolvedValue([{
      issueId: 'EI-existing-pending',
      createdBy: 'su-prior-grader',
      subject: { kind: 'plan', ref: subjectRef },
      gradingAudit: { state: 'pending' },
      supersededBy: null,
    }]);

    const result = await certify({ specIds: ['SPEC-PASS'], dryRun: true });

    expect(result).toMatchObject({
      ok: false,
      dryRun: true,
      counts: { clauses: 1, passing: 1, filed: 0, unchanged: 0, refused: 1, notPassing: 0 },
      clauses: [{
        specId: 'SPEC-PASS',
        card: { status: 'refused', code: 'grading_audit_required' },
      }],
    });
    expect(result.clauses?.[0]?.card.error).toContain('pending grading audit');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  // WI-6554700010008541: the grading-integrity sweep dispatches a pending card only on a
  // host serving its recorded evaluator build. Once that build is retired the card can
  // never be audited, and emit's grading_audit_required refusal would block the clause
  // forever. Certify supersedes such a card with the card it just reproduced.
  describe('a pending card stranded on a retired evaluator build', () => {
    const LIVE_BUILD = { sha: 'certify-evaluator-sha', version: '1.0.0' };
    const RETIRED_BUILD = { sha: 'retired-evaluator-sha', version: '1.0.0' };

    /** File one real card so the stranded card's stored observation is emit-shaped. */
    const realObservation = async () => {
      const filed = await certify({ specIds: ['SPEC-PASS'] });
      expect(filed.clauses?.[0]?.card.status, JSON.stringify(filed)).toBe('filed');
      const raw = (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } })
        .payloadExtra.observation;
      captureImprovement.mockClear();
      dispatchTool.mockClear();
      return raw;
    };

    const arrangeStranded = async (
      evaluatorBuild: { sha: string; version: string },
      gradingAudit: Record<string, unknown> = {},
      sameEvidence = false,
      stalePendingCards: object[] = [],
    ) => {
      const observation = await realObservation();
      const subjectRef = specTestAdequacySubjectRef(PLAN, 'SPEC-PASS', 1);
      const stranded = {
        issueId: 'EI-stranded-pending',
        createdBy: 'su-certifier',
        sourceHive: 'papercusp',
        rubricRef: 'spec-test-adequacy',
        subject: { kind: 'plan', ref: subjectRef },
        gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity', stampedAt: '2026-10-11T12:36:00.000Z', ...gradingAudit },
        supersededBy: null,
        // A real filed card's recipe carries its args; emit fingerprints them when superseding.
        rerunRecipe: { ...(observation as { rerunRecipe?: Record<string, unknown> }).rerunRecipe, evaluatorBuild },
        ...(sameEvidence ? {
          rubricRevision: 7,
          criteriaHash: null,
          rubricMeaningRevision: null,
          evidenceFingerprint: asStructuredObservation(observation)!.evidenceFingerprint,
          ratings: asStructuredObservation(observation)!.ratings,
          instrumentSnapshots: asStructuredObservation(observation)!.instrumentSnapshots,
          rubricResolved: true,
          synthesized: false,
        } : {}),
        missingKeys: [],
        extraKeys: [],
      };
      listScorecards.mockImplementation(async (filter: { rubricRef?: string; subjectRef?: string }) =>
        filter.rubricRef === 'spec-test-adequacy' && filter.subjectRef === subjectRef
          ? [stranded, ...stalePendingCards]
          : []);
      getIssue.mockImplementation(async (id: string) =>
        id === stranded.issueId ? { id, payload: { observation } } : null);
    };

    it('supersedes the stranded card and reports it on the clause row', async () => {
      await arrangeStranded(RETIRED_BUILD);

      const preview = await certify({ specIds: ['SPEC-PASS'], dryRun: true });

      expect(preview).toMatchObject({
        ok: true,
        counts: { passing: 1, refused: 0 },
        clauses: [{
          specId: 'SPEC-PASS',
          card: { status: 'would-file' },
          strandedSuperseded: { issueId: 'EI-stranded-pending', evaluatorBuild: RETIRED_BUILD },
        }],
      });

      const filed = await certify({ specIds: ['SPEC-PASS'] });

      expect(filed).toMatchObject({
        ok: true,
        counts: { filed: 1, refused: 0 },
        clauses: [{ card: { status: 'filed' }, strandedSuperseded: { issueId: 'EI-stranded-pending' } }],
      });
      const written = asStructuredObservation(
        (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } }).payloadExtra.observation,
      );
      expect(written?.supersedes).toBe('EI-stranded-pending');
    });

    it('supersedes a stranded pending audit even when its evidence is unchanged', async () => {
      await arrangeStranded(RETIRED_BUILD, {}, true);

      const preview = await certify({ specIds: ['SPEC-PASS'], dryRun: true });
      expect(preview).toMatchObject({
        ok: true,
        clauses: [{ card: { status: 'would-file' }, strandedSuperseded: { issueId: 'EI-stranded-pending' } }],
      });

      const filed = await certify({ specIds: ['SPEC-PASS'] });
      expect(filed).toMatchObject({
        ok: true,
        counts: { filed: 1, unchanged: 0, refused: 0 },
        clauses: [{ card: { status: 'filed' }, strandedSuperseded: { issueId: 'EI-stranded-pending' } }],
      });
      const written = asStructuredObservation(
        (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } }).payloadExtra.observation,
      );
      expect(written?.supersedes).toBe('EI-stranded-pending');
    });

    it('ignores pending cards whose cited proof was retracted when superseding a stranded card', async () => {
      const subjectRef = specTestAdequacySubjectRef(PLAN, 'SPEC-PASS', 1);
      const stalePendingCard = {
        issueId: 'EI-stale-retracted-proof',
        createdBy: 'su-prior-grader',
        sourceHive: 'papercusp',
        rubricRef: 'spec-test-adequacy',
        subject: { kind: 'plan', ref: subjectRef },
        gradingAudit: { state: 'pending', metaRubricRef: 'grading-integrity' },
        supersededBy: null,
        auditTarget: {
          current: false,
          superseded: false,
          supersededBy: null,
          retracted: false,
          subjectRubricCurrentness: null,
          evidenceBindingCurrentness: {
            state: 'stale',
            reason: 'cited-binding-retracted',
            citedBindingCount: 2,
            retractedBindingIds: ['37610', '37592'],
            unavailableBindingIds: [],
          },
        },
      };
      await arrangeStranded(RETIRED_BUILD, {}, false, [stalePendingCard]);

      const filed = await certify({ specIds: ['SPEC-PASS'] });

      expect(filed).toMatchObject({
        ok: true,
        counts: { filed: 1, refused: 0 },
        clauses: [{ card: { status: 'filed' }, strandedSuperseded: { issueId: 'EI-stranded-pending' } }],
      });
      const written = asStructuredObservation(
        (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } }).payloadExtra.observation,
      );
      expect(written?.supersedes).toBe('EI-stranded-pending');
    });

    it.each(['same-build', 'live-lease'])('keeps unchanged evidence when the pending audit has a %s', async (guard) => {
      await arrangeStranded(guard === 'same-build' ? LIVE_BUILD : RETIRED_BUILD,
        guard === 'live-lease' ? {
          dispatchReservation: { key: 'grading-audit:EI-stranded-pending', reservedAt: new Date().toISOString() },
        } : {}, true);

      const result = await certify({ specIds: ['SPEC-PASS'], dryRun: true });
      expect(result).toMatchObject({
        ok: true,
        counts: { filed: 0, unchanged: 1, refused: 0 },
        clauses: [{ card: { status: 'unchanged', issueId: 'EI-stranded-pending' } }],
      });
      expect(result.clauses?.[0]).not.toHaveProperty('strandedSuperseded');
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(getIssue).not.toHaveBeenCalled();
    });

    it('still refuses while the pending card was minted by the live evaluator build', async () => {
      await arrangeStranded(LIVE_BUILD);

      const result = await certify({ specIds: ['SPEC-PASS'], dryRun: true });

      expect(result).toMatchObject({
        ok: false,
        clauses: [{ card: { status: 'refused', code: 'grading_audit_required' } }],
      });
      expect(result.clauses?.[0]).not.toHaveProperty('strandedSuperseded');
      expect(getIssue).not.toHaveBeenCalled();
    });

    it('still refuses while an auditor holds a live dispatch reservation on the card', async () => {
      await arrangeStranded(RETIRED_BUILD, {
        dispatchReservation: { key: 'grading-audit:EI-stranded-pending', reservedAt: new Date().toISOString() },
      });

      const result = await certify({ specIds: ['SPEC-PASS'], dryRun: true });

      expect(result).toMatchObject({
        ok: false,
        clauses: [{ card: { status: 'refused', code: 'grading_audit_required' } }],
      });
      expect(result.clauses?.[0]).not.toHaveProperty('strandedSuperseded');
    });
  });

  it('dryRun reports unchanged when the same evaluator evidence is already filed', async () => {
    const filed = await certify({ specIds: ['SPEC-PASS'] });
    expect(filed.clauses?.[0]?.card.status).toBe('filed');
    const raw = (captureImprovement.mock.calls[0]![0] as { payloadExtra: { observation: unknown } })
      .payloadExtra.observation;
    const observation = asStructuredObservation(raw);
    const subjectRef = specTestAdequacySubjectRef(PLAN, 'SPEC-PASS', 1);
    expect(observation?.evidenceFingerprint).toBeTruthy();
    listScorecards.mockResolvedValue([{
      issueId: 'EI-existing-same-evidence',
      createdBy: 'su-certifier',
      sourceHive: 'papercusp',
      subject: { kind: 'plan', ref: subjectRef },
      rubricRef: 'spec-test-adequacy',
      rubricRevision: 7,
      criteriaHash: null,
      rubricMeaningRevision: null,
      evidenceFingerprint: observation!.evidenceFingerprint,
      rubricResolved: true,
      missingKeys: [],
      extraKeys: [],
      synthesized: false,
    }]);

    const preview = await certify({ specIds: ['SPEC-PASS'], dryRun: true });

    expect(preview).toMatchObject({
      ok: true,
      dryRun: true,
      counts: { filed: 0, unchanged: 1, refused: 0 },
      clauses: [{ card: { status: 'unchanged', issueId: 'EI-existing-same-evidence' } }],
    });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
  });

  it('attributes an emit refusal to its clause and reports ok:false when the replay no longer reproduces the pass', async () => {
    // The proven source moves between grading and the gate's replay.
    dispatchTool.mockImplementationOnce(async (_name: string, args: Record<string, unknown>) => {
      await writeSubject('export const ackedEventsReplayed = true;\n');
      return replayViaEvaluator(args);
    });

    const result = await certify({ specIds: ['SPEC-PASS'] });

    expect(result.ok).toBe(false);
    expect(result.counts).toMatchObject({ passing: 1, filed: 0, refused: 1 });
    expect(result.clauses?.[0]).toMatchObject({
      specId: 'SPEC-PASS',
      card: { status: 'refused', code: 'invalid_spec_test_adequacy_binding' },
    });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('passes an evaluator refusal through unchanged instead of reporting a vacuous success', async () => {
    listClauses.mockResolvedValue([clause('SPEC-PASS', 'draft')]);

    const result = await certify({ specIds: ['SPEC-PASS'] });

    expect(result).toMatchObject({ ok: false, evaluator: { ok: false, error: 'selection_empty' } });
    expect(result).not.toHaveProperty('counts');
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});

// oversized-tool-results-reduction-2026-10-12 P-006: plans:evaluate-spec-test-adequacy hands
// passing-row callers this certify call so they stop fetching the full body only to shuttle
// drafts into scorecards:emit by hand. Falsifier: the ref carries an argument certify
// rejects, or is offered for a pinned/replayed read whose cohort certify cannot reproduce,
// for a non-active class source, or with nothing passing.
describe('certifyPassingRef (plans:evaluate-spec-test-adequacy → plans:certify-spec-clauses)', () => {
  const ctx = { classRef: 'plan-class-feature-ship' as const, classRefSource: 'active-acceptance-rubric' as const, passingCount: 2 };
  const live = {
    harness: 'papercusp',
    slug: 'plan-a',
    specIds: ['SPEC-001'],
    workItemIds: ['WI-1'],
    evidenceRefs: ['ref-1'],
    planItemIds: ['P-001'],
    includeDraft: true,
    limit: 200,
  };

  it('emits only arguments certify accepts, carrying the resolved classRef', () => {
    const ref = certifyPassingRef(live, ctx);
    expect(ref).toMatchObject({ tool: 'plans:certify-spec-clauses', passing: 2 });
    const certifyKeys = Object.keys((certifyTool.args as unknown as { shape: Record<string, unknown> }).shape);
    for (const key of Object.keys(ref!.args)) expect(certifyKeys).toContain(key);
    expect(certifyTool.args.safeParse(ref!.args).success).toBe(true);
    expect(ref!.args).toEqual({ ...live, classRef: 'plan-class-feature-ship' });
  });

  it('preserves exact binding IDs in a live certification referral', () => {
    const ref = certifyPassingRef({ ...live, bindingIds: [7] }, ctx);
    expect(ref?.args).toMatchObject({ bindingIds: [7] });
    expect(certifyTool.args.safeParse(ref!.args).success).toBe(true);
  });

  it('is withheld when nothing passes, the class is not active, or the clause is pinned or replayed', () => {
    expect(certifyPassingRef(live, { ...ctx, passingCount: 0 })).toBeUndefined();
    expect(certifyPassingRef(live, { ...ctx, classRefSource: 'retired-acceptance-rubric' })).toBeUndefined();
    expect(certifyPassingRef(live, { ...ctx, classRefSource: 'work-item-completion-attestation' })).toBeUndefined();
    expect(certifyPassingRef({ ...live, replaySnapshot: true }, ctx)).toBeUndefined();
    expect(certifyPassingRef({ ...live, specRevision: 3 }, ctx)).toBeUndefined();
  });
});
