/**
 * emit.checks.test.ts — deterministic criterion checks on scorecards:emit
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-011, owner-ratified D-006).
 *
 * Unit-level, mirroring emit.vetting.test.ts: collaborators are mocked; the check
 * evaluator is injected via emitScorecard's deps seam (production shells the real
 * Vitest router through the testing:run core — that path is covered by
 * rubrics-criterion-checks.test.ts). Pinned here: a refusal from the evaluator
 * refuses the EMIT (nothing filed), a clean evaluation stamps observation.checkRuns,
 * a rubric without tests-checks never invokes the evaluator, and the
 * unchanged-evidence decline fires BEFORE any check run (a deduped re-emit never
 * burns a suite).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTracker } from '@papercusp/tooldef';

const getRubric = vi.fn();
const getRubricPlanRevision = vi.fn();
const readRubricPlanRevision = vi.fn();
const listScorecards = vi.fn();
const captureImprovement = vi.fn();
const resolveHarnessPaths = vi.fn();
const resolvePlanHarness = vi.fn();
const dispatchPendingGradingAudits = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));

vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return {
    ...real,
    getRubric: (...a: unknown[]) => getRubric(...a),
    // scorecards:emit uses the failure-aware writer read; keep this unit suite on
    // the same mocked rubric fixtures instead of falling through to live PG.
    readRubric: async (rubricId: string) => {
      const rubric = await getRubric(rubricId);
      return rubric ? { kind: 'found' as const, rubric } : { kind: 'missing' as const };
    },
    getRubricPlanRevision: (...a: unknown[]) => getRubricPlanRevision(...a),
    readRubricPlanRevision: (...a: unknown[]) => readRubricPlanRevision(...a),
    // The real identity helper closes over the real getRubric, bypassing this suite's mock.
    getRubricEvidenceIdentity: async (rubricId: string) => ({
      revision: await getRubricPlanRevision(rubricId),
      criteriaHash: null,
      meaningRevision: null,
    }),
  };
});
vi.mock('../../scorecards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../scorecards')>();
  return { ...real, listScorecards: (...a: unknown[]) => listScorecards(...a) };
});
vi.mock('../../harness/improvements/capture-core', () => ({
  captureImprovement: (...a: unknown[]) => captureImprovement(...a),
}));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: async () => null,
}));
vi.mock('../../issues-engineer', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...real, getIssue: async () => null };
});
vi.mock('../../workspace-registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../workspace-registry')>();
  return { ...real, activeWorkspaceId: () => 'ws-test' };
});
vi.mock('../../grading-integrity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../grading-integrity')>();
  return { ...real, dispatchPendingGradingAudits: (...args: unknown[]) => dispatchPendingGradingAudits(...args) };
});
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...real, getOrgPg: () => ({ sql: {} }) };
});
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: () => {} }));
// Collaborator mock, matching emit-evaluate.test.ts. emit.ts's acceptance branch
// calls these identity helpers, which fall back to a REAL org-admin pool when no
// sql seam is injected — a unit tier must not open a live connection. This file
// declares itself unit-level ("collaborators are mocked") and simply predated the
// callerInImplementerLineage guard added to emit.ts on 2026-08-30.
vi.mock('../../acceptance-author-identity', () => ({
  isAcceptanceAuthorIdentity: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  areAcceptanceLineageRelated: vi.fn(async (author: string | null, candidate: string | null) => author === candidate),
  resolvePlanImplementerIdentities: vi.fn(async () => []),
}));
// These tests own deterministic criterion checks, not the post-write wake bridge.
// Keep the newly-created-card event from reaching its real PG-backed await latch.
vi.mock('../../scorecard-emitted-events', () => ({ emitScorecardEmitted: async () => {} }));
vi.mock('../../resolve-harness-paths', () => ({
  resolveHarnessPaths: (...a: unknown[]) => resolveHarnessPaths(...a),
}));
vi.mock('../plans/source', () => ({
  resolvePlanHarness: (...a: unknown[]) => resolvePlanHarness(...a),
}));

import scorecardEmitTool, {
  emitScorecard,
  emitScorecardForToolContext,
  runRecoverableScorecardChecks,
  scorecardCheckRunPrefix,
  SCORECARD_EMIT_TIMEOUT_SEC,
  SCORECARD_TEST_CHECK_TIMEOUT_MS,
} from './emit';
// Register the real judge-readable target in the projected-tool contract used by probes.
import './get';
import { scorecardEvidenceFingerprint } from '../../scorecards';
import { asStructuredObservation } from '../../harness/improvements/observation-types';
import type { ObservationRatings } from '../../harness/improvements/observation-types';
import type {
  evaluateCriterionCargoChecks,
  evaluateCriterionCoverageChecks,
  evaluateCriterionProbeChecks,
  evaluateCriterionRequirementChecks,
  evaluateCriterionTestChecks,
  CriterionCheckRun,
} from '../../rubrics-criterion-checks';
import type { recordRubricCheckResults } from '../../check-results-ledger';
import { REPO_ROOT } from '../docs/_repo-paths';

type EvaluateChecks = typeof evaluateCriterionTestChecks;
type EvaluateCargoChecks = typeof evaluateCriterionCargoChecks;

describe('scorecards:emit interrupted check-run recovery (EI-24189399333592974)', () => {
  const files = Array.from({ length: 5 }, (_, i) => `packages/operator-core/lib/check-${i}.test.ts`);
  const root = '/repo';
  const sha = 'a'.repeat(40);
  const opts = { files, root, workspaceId: 'ws-test', harnessSlug: 'papercusp' };
  const binding = {
    rubricRef: 'acceptance-pui-first-party-public-release-2026-09-07',
    rubricRevision: 7,
    criteriaHash: 'criteria-hash',
    evidenceFingerprint: 'ratings-fingerprint',
    createdBy: 'su-independent',
    subjectRef: 'WI-10003073',
  };
  const prefix = scorecardCheckRunPrefix({ ...binding, ...opts, sourceSha: sha });
  const rows = (runId: string, worktreeDirty = false) => files.map((file, index) => ({
    id: index + 101,
    file_path: file,
    status: 'pass',
    finished_at: '2026-09-25T04:00:00.000Z',
    workspace_id: opts.workspaceId,
    harness_slug: opts.harnessSlug,
    run_group_id: runId,
    commit_sha: sha,
    worktree_dirty: worktreeDirty,
    execution_details: JSON.stringify({
      schemaVersion: 1,
      root,
      filePath: file,
      runGroupId: runId,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      testNamePattern: null,
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: sha,
      worktreeDirty,
    }),
  }));
  const runFiles = vi.fn(async ({ runId }: { runId?: string } = {}) => ({
    ok: true, runId: runId!, root, files: 5, passed: 5, failed: 0, skipped: 0,
    byFile: Object.fromEntries(files.map((file) => [file, { passed: 1, failed: 0, skipped: 0, collectionFailed: false }])),
    failures: [], failuresTruncated: false, durationMs: 1000, testRunIds: [101, 102, 103, 104, 105],
  }));

  beforeEach(() => runFiles.mockClear());

  it('keeps the event loop responsive while asynchronously resolving the source SHA', async () => {
    let sourceShaFinished = false;
    let timerRan = false;
    const pending = runRecoverableScorecardChecks(opts, binding, {
      sourceSha: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        sourceShaFinished = true;
        return sha;
      },
      readRows: async () => [],
      listTaskRows: async () => [],
      runFiles,
    });

    await new Promise<void>((resolve) => setTimeout(() => {
      timerRan = true;
      resolve();
    }, 0));

    expect(timerRan).toBe(true);
    expect(sourceShaFinished).toBe(false);
    await pending;
    expect(sourceShaFinished).toBe(true);
    expect(runFiles).toHaveBeenCalledOnce();
  });

  it('starts one request-bound group, then reuses all five durable rows after the API host dies', async () => {
    const first = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      readRows: async () => [],
      listTaskRows: async () => [],
      runFiles,
    });
    expect(first.runId).toBe(`${prefix}-0`);
    expect(runFiles).toHaveBeenCalledOnce();

    runFiles.mockClear();
    const replay = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      // The measured interrupted PUI batch had five green but DIRTY rows.
      readRows: async ({ runGroupId }) => rows(runGroupId, true),
      listTaskRows: async () => [{ state: 'ended_unobserved', exitCode: null }],
      runFiles,
    });
    expect(replay).toMatchObject({ ok: true, runId: `${prefix}-0`, passed: 5, failed: 0,
      testRunIds: [101, 102, 103, 104, 105] });
    expect(runFiles).not.toHaveBeenCalled();
  });

  it('does not start a duplicate process while the original group is still running', async () => {
    const pending = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      readRows: async () => [],
      listTaskRows: async () => [{ state: 'running', exitCode: null }],
      runFiles,
    });
    expect(pending).toMatchObject({ ok: false, error: 'timeout', runId: `${prefix}-0` });
    expect(runFiles).not.toHaveBeenCalled();
  });

  it('refuses an indeterminate task state instead of endlessly calling it active', async () => {
    const result = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      readRows: async () => [],
      listTaskRows: async () => [{ state: 'unaccounted', exitCode: null }],
      runFiles,
    });
    expect(result).toMatchObject({ ok: false, error: 'route_error' });
    expect(runFiles).not.toHaveBeenCalled();
  });

  it('refuses cross-source or partial evidence and advances only after a terminal attempt', async () => {
    const seen: string[] = [];
    const result = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      readRows: async ({ runGroupId }) => {
        seen.push(runGroupId);
        return runGroupId.endsWith('-0') ? rows(runGroupId).slice(0, 4) : [];
      },
      listTaskRows: async (launchedBy) => launchedBy.endsWith('-0')
        ? [{ state: 'ended_unobserved', exitCode: null }]
        : [],
      runFiles,
    });
    expect(seen).toEqual([`${prefix}-0`, `${prefix}-1`]);
    expect(result.runId).toBe(`${prefix}-1`);
    expect(runFiles).toHaveBeenCalledOnce();

    runFiles.mockClear();
    const changed = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => 'b'.repeat(40),
      readRows: async () => [],
      listTaskRows: async () => [],
      runFiles,
    });
    expect(changed.runId).not.toBe(`${prefix}-0`);
  });

  it('does not recycle a green group whose recorded source or router exit contradicts it', async () => {
    const stale = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      readRows: async ({ runGroupId }) => runGroupId.endsWith('-0')
        ? rows(runGroupId).map((row) => ({ ...row, commit_sha: 'b'.repeat(40) }))
        : [],
      listTaskRows: async (launchedBy) => launchedBy.endsWith('-0')
        ? [{ state: 'ended_unobserved', exitCode: null }]
        : [],
      runFiles,
    });
    expect(stale.runId).toBe(`${prefix}-1`);
    runFiles.mockClear();

    const routerRed = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      readRows: async ({ runGroupId }) => runGroupId.endsWith('-0') ? rows(runGroupId) : [],
      listTaskRows: async (launchedBy) => launchedBy.endsWith('-0')
        ? [{ state: 'exited', exitCode: 1 }]
        : [],
      runFiles,
    });
    expect(routerRed.runId).toBe(`${prefix}-1`);
    expect(runFiles).toHaveBeenCalledOnce();
  });

  it('refuses a dirty-row flag that disagrees with its reporter details', async () => {
    const result = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      readRows: async ({ runGroupId }) => runGroupId.endsWith('-0')
        ? rows(runGroupId, true).map((row, index) => index === 0 ? { ...row, worktree_dirty: false } : row)
        : [],
      listTaskRows: async (launchedBy) => launchedBy.endsWith('-0')
        ? [{ state: 'ended_unobserved', exitCode: null }]
        : [],
      runFiles,
    });
    expect(result.runId).toBe(`${prefix}-1`);
    expect(runFiles).toHaveBeenCalledOnce();
  });

  it('fails closed when it cannot read the test ledger', async () => {
    const result = await runRecoverableScorecardChecks(opts, binding, {
      sourceSha: () => sha,
      readRows: async () => null,
      listTaskRows: async () => [],
      runFiles,
    });
    expect(result).toMatchObject({ ok: false, error: 'route_error' });
    expect(runFiles).not.toHaveBeenCalled();
  });
});

const CHECKED_RUBRIC = {
  rubricId: 'ar-checked-plan',
  revision: 3,
  workspaceId: 'ws-test',
  kind: 'acceptance',
  subjectPlan: 'checked-plan-2026-08-17',
  characteristic: 'shipping',
  title: 'Acceptance: checked plan',
  description: '',
  criteria: [
    { key: 'fuzzy-outcome', title: 'Fuzzy', model: 'm', method: 'm', driftMarkers: 'd' },
    {
      key: 'det-outcome',
      title: 'Deterministic',
      model: 'm',
      method: 'm',
      driftMarkers: 'd',
      check: { kind: 'tests', files: ['packages/x/real.test.ts'] },
    },
  ],
  ratingScale: ['pass', 'weak', 'fail'],
  methodRef: null,
  status: 'active',
  createdBy: 'su-author',
  proposedBy: 'su-author',
  ratifiedBy: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:00.000Z',
};

const RATINGS: ObservationRatings = {
  'fuzzy-outcome': { rating: 'pass', evidence: 'reads well' },
  'det-outcome': { rating: 'pass', evidence: 'suite green' },
};

const EMIT_INPUT = { createdBy: 'su-grader', ctxHarness: 'papercusp', checkRoot: '/tmp/fake-root' };

// EI-22177729599840121: a valid meta-acceptance-rubric attestation for CHECKED_RUBRIC's
// current revision (3, matching getRubricPlanRevision's default below) — satisfies the
// vet-before-grade prerequisite emitScorecard now enforces for every non-implementer
// acceptance-kind grading (EMIT_INPUT's 'su-grader' ≠ CHECKED_RUBRIC's author 'su-author').
// Returned only for a query against the META rubric ref, so the pre-existing
// duplicate/dedup listScorecards({ rubricRef: args.rubricRef, ... }) queries against
// 'ar-checked-plan' are left exactly as they were (empty), unlike a blanket mockResolvedValue.
const META_VETTING_CARD = {
  issueId: 'EI-vetting',
  createdAt: '2026-08-25T21:00:12Z',
  createdBy: 'su-vetting-author',
  rubricRef: 'meta-acceptance-rubric',
  subject: { kind: 'rubric', ref: 'ar-checked-plan' },
  ratings: RATINGS,
  nKeys: 2,
  missingKeys: [],
  extraKeys: [],
  rubricResolved: true,
  synthesized: false,
  score10: 10,
  linkedItems: [],
  vetting: { consultId: 'conv-vet-1', rubricRevision: 3, critiquePosts: 1, critics: ['su-critic'] },
};

const PASS_RUN: CriterionCheckRun = {
  kind: 'tests',
  files: ['packages/x/real.test.ts'],
  verdict: 'pass',
  passed: 3,
  failed: 0,
  runId: 'run-1',
  testRunIds: [101, 102],
  measuredAt: '2026-08-17T12:00:00.000Z',
};

const CARGO_PASS_RUN: CriterionCheckRun = {
  kind: 'cargo',
  manifestPath: 'apps/tui/Cargo.toml',
  sourceFiles: ['apps/tui/src/app.rs'],
  verdict: 'pass',
  passed: 12,
  failed: 0,
  ignored: 1,
  runId: 'cargo-1',
  measuredAt: '2026-08-30T07:30:00.000Z',
};

const emitArgs = (over: Record<string, unknown> = {}) => ({
  rubricRef: 'ar-checked-plan',
  ratings: RATINGS,
  ...over,
});

beforeEach(() => {
  dispatchPendingGradingAudits.mockClear();
  getRubric.mockReset().mockImplementation(async (id: unknown) =>
    id === 'ar-checked-plan' ? CHECKED_RUBRIC : null,
  );
  getRubricPlanRevision.mockReset().mockResolvedValue(3);
  readRubricPlanRevision.mockReset().mockResolvedValue({ ok: true, revision: 3 });
  // EI-22177729599840121: vet-before-grade now queries listScorecards for the
  // meta-acceptance-rubric before every non-implementer acceptance grading — answer
  // that one query with a satisfying attestation, everything else stays '[]' exactly
  // as before (this file's own dedup/duplicate-detection queries key on the REAL
  // rubricRef, 'ar-checked-plan', never the meta ref).
  listScorecards.mockReset().mockImplementation(async (filter: { rubricRef?: string } = {}) =>
    filter.rubricRef === 'meta-acceptance-rubric' ? [META_VETTING_CARD] : [],
  );
  captureImprovement.mockReset().mockResolvedValue({ created: true, issue: { id: 'EI-1' } });
  resolveHarnessPaths.mockReset();
  // Default: the subject plan is not store-backed, so checks keep the caller root.
  resolvePlanHarness.mockReset().mockResolvedValue({ status: 'missing' });
});

describe('scorecards:emit deterministic criterion checks (P-011)', () => {
  it.each([
    { count: 2, failed: 0, accepted: true },
    { count: 0, failed: 0, accepted: false },
    { count: 2, failed: 1, accepted: false },
  ])('preserves ALL evaluator receipts through emission and reading: $count/$failed', async ({ count, failed, accepted }) => {
    const probe = {
      kind: 'tool' as const, tool: 'acceptance:read', args: {},
      schemaRevision: 'synthetic-read-revision',
    };
    const all = [
      { ...probe, expect: { path: '$.count', op: 'eq' as const, value: 2 } },
      { ...probe, expect: { path: '$.failed', op: 'eq' as const, value: 0 } },
    ];
    getRubric.mockResolvedValue({
      ...CHECKED_RUBRIC,
      criteria: [CHECKED_RUBRIC.criteria[0], {
        ...CHECKED_RUBRIC.criteria[1], check: { kind: 'probe', all },
      }],
    });
    // The real evaluator's populated/empty/failing predicates are exercised in
    // continuity-probes.test.ts. This suite owns the persistence boundary.
    const children = all.map((child, index) => {
      const pass = index === 0 ? count === 2 : failed === 0;
      return { kind: 'probe' as const, probe: child, observed: index === 0 ? count : failed,
        verdict: pass ? 'pass' as const : 'fail' as const,
        status: pass ? 'fresh' as const : 'stale' as const,
        executed: true as const, measuredAt: '2026-10-03T07:00:00Z' };
    });
    const run = { kind: 'probe' as const, all: children, executed: true as const,
      verdict: accepted ? 'pass' as const : 'fail' as const,
      status: accepted ? 'fresh' as const : 'stale' as const, measuredAt: children[0].measuredAt };
    const evaluateProbeChecks = vi.fn<typeof evaluateCriterionProbeChecks>().mockResolvedValue(accepted
      ? { ok: true, checkRuns: { 'det-outcome': run } }
      : { ok: false, error: 'probe_contradicted', criterionKey: 'det-outcome', rating: RATINGS['det-outcome'].rating, run, detail: 'ALL child predicate failed' });
    // test-rubric-unification-2026-10-12 P-006 (R-6): every executed probe child writes one
    // results-ledger row — the contradicted run that refuses this emit included.
    const recordCheckResults = vi.fn<typeof recordRubricCheckResults>().mockResolvedValue([101, 102]);
    const result = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateProbeChecks, recordCheckResults });
    expect(evaluateProbeChecks).toHaveBeenCalledOnce();
    expect(evaluateProbeChecks.mock.calls[0][0].criteria[1].check).toEqual({ kind: 'probe', all });
    expect(recordCheckResults).toHaveBeenCalledOnce();
    const [ledgerResults, ledgerScope] = recordCheckResults.mock.calls[0]!;
    expect(ledgerScope).toMatchObject({ workspaceId: 'ws-test' });
    expect(ledgerResults.map((r) => [r.check.id, r.check.rubricRef, r.check.kind, r.check.value, r.check.unit, r.verdict])).toEqual([
      ['det-outcome:0', CHECKED_RUBRIC.rubricId, 'probe', count, null, count === 2 ? 'pass' : 'fail'],
      ['det-outcome:1', CHECKED_RUBRIC.rubricId, 'probe', failed, null, failed === 0 ? 'pass' : 'fail'],
    ]);
    expect(result.ok).toBe(accepted);
    if (!accepted) {
      expect(captureImprovement).not.toHaveBeenCalled();
      expect(result).toMatchObject({ checkRefusal: { error: 'probe_contradicted' } });
      return;
    }
    expect(result).toMatchObject({ checkLedger: { recorded: 2, testRunIds: [101, 102] } });
    const observation = captureImprovement.mock.calls[0][0].payloadExtra.observation;
    const expected = {
      kind: 'probe', verdict: 'pass', status: 'fresh', executed: true,
      all: [
        { probe: all[0], observed: 2, verdict: 'pass', executed: true },
        { probe: all[1], observed: 0, verdict: 'pass', executed: true },
      ],
    };
    expect(observation.checkRuns['det-outcome']).toMatchObject(expected);
    expect(asStructuredObservation(observation)?.checkRuns?.['det-outcome']).toEqual(observation.checkRuns['det-outcome']);
    expect(result).toMatchObject({ checkRuns: { 'det-outcome': expected } });
  });

  it('reports a results-ledger write failure without changing the probe-checked verdict (P-006)', async () => {
    const probe = {
      kind: 'tool' as const, tool: 'acceptance:read', args: {},
      schemaRevision: 'synthetic-read-revision', expect: { path: '$.count', op: 'eq' as const, value: 2 },
    };
    getRubric.mockResolvedValue({
      ...CHECKED_RUBRIC,
      criteria: [CHECKED_RUBRIC.criteria[0], { ...CHECKED_RUBRIC.criteria[1], check: { kind: 'probe', probe } }],
    });
    const run = { kind: 'probe' as const, probe, observed: 2, verdict: 'pass' as const, status: 'fresh' as const,
      executed: true as const, measuredAt: '2026-10-03T07:00:00Z' };
    const evaluateProbeChecks = vi.fn<typeof evaluateCriterionProbeChecks>()
      .mockResolvedValue({ ok: true, checkRuns: { 'det-outcome': run } });
    const recordCheckResults = vi.fn<typeof recordRubricCheckResults>().mockRejectedValue(new Error('connection refused'));
    const result = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateProbeChecks, recordCheckResults });
    expect(recordCheckResults).toHaveBeenCalledOnce();
    expect(recordCheckResults.mock.calls[0]![0].map((r) => r.check.id)).toEqual(['det-outcome:0']);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ checkLedger: { recorded: 0, error: expect.stringMatching(/results-ledger write failed: connection refused/) } });
  });

  it('files a five-file card through the real evaluator and request-bound recovery seam', async () => {
    const checkFiles = [
      'packages/operator-core/lib/agent-tools/scorecards/emit.checks.test.ts',
      'packages/operator-core/lib/agent-tools/scorecards/emit.test.ts',
      'packages/operator-core/lib/agent-tools/scorecards/emit.replay.test.ts',
      'packages/operator-core/lib/agent-tools/scorecards/evaluate.release-gate.test.ts',
      'packages/operator-core/lib/agent-tools/scorecards/list.test.ts',
    ];
    const criteria = checkFiles.map((file, index) => ({
      key: `det-${index}`, title: file, model: 'm', method: 'm', driftMarkers: 'd',
      check: { kind: 'tests' as const, files: [file] },
    }));
    getRubric.mockResolvedValue({ ...CHECKED_RUBRIC, criteria });
    const ratings = Object.fromEntries(criteria.map((criterion) => [criterion.key, {
      rating: 'pass', evidence: 'exact installed candidate and file run checked',
    }]));
    const runRecoverableChecks = vi.fn(async (runOpts: { files: string[]; root: string }) => ({
      ok: true, runId: 'scorecard-check-recovered-0', root: runOpts.root,
      files: runOpts.files.length, passed: runOpts.files.length, failed: 0, skipped: 0,
      byFile: Object.fromEntries(runOpts.files.map((file) => [file, {
        passed: 1, failed: 0, skipped: 0, collectionFailed: false,
      }])),
      failures: [], failuresTruncated: false, durationMs: null,
      testRunIds: [101, 102, 103, 104, 105],
    }));
    const result = await emitScorecard(
      emitArgs({ ratings }) as never,
      { ...EMIT_INPUT, checkRoot: REPO_ROOT },
      { runRecoverableChecks },
    );
    expect(result.ok).toBe(true);
    expect(runRecoverableChecks).toHaveBeenCalledOnce();
    expect(runRecoverableChecks.mock.calls[0][0].files).toEqual(checkFiles);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { checkRuns?: Record<string, CriterionCheckRun> } };
    };
    expect(Object.keys(payload.payloadExtra.observation.checkRuns ?? {})).toEqual(criteria.map((criterion) => criterion.key));
    expect(payload.payloadExtra.observation.checkRuns?.['det-0']).toMatchObject({
      verdict: 'pass', runId: 'scorecard-check-recovered-0', testRunIds: [101, 102, 103, 104, 105],
    });
  });

  it('stamps observation.checkRuns from a clean evaluation and surfaces it on the result', async () => {
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    // the evaluator got the rubric's criteria, the canonical ratings, and the ctx root.
    expect(evaluateChecks).toHaveBeenCalledTimes(1);
    const call = evaluateChecks.mock.calls[0][0];
    expect(call.root).toBe('/tmp/fake-root');
    expect(call.workspaceId).toBe('ws-test');
    expect(call.harnessSlug).toBe('papercusp');
    expect(call.criteria).toBe(CHECKED_RUBRIC.criteria);
    expect(call.timeoutMs).toBe(SCORECARD_TEST_CHECK_TIMEOUT_MS);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { checkRuns?: Record<string, CriterionCheckRun> } };
    };
    expect(payload.payloadExtra.observation.checkRuns?.['det-outcome']).toMatchObject({
      kind: 'tests',
      verdict: 'pass',
      runId: 'run-1',
      testRunIds: [101, 102],
    });
    expect((res as { checkRuns?: Record<string, unknown> }).checkRuns?.['det-outcome']).toBeDefined();
  });

  it('runs native Cargo checks through their own evaluator and stamps the native run', async () => {
    const cargoRubric = {
      ...CHECKED_RUBRIC,
      criteria: [
        CHECKED_RUBRIC.criteria[0],
        {
          ...CHECKED_RUBRIC.criteria[1],
          check: {
            kind: 'cargo' as const,
            manifestPath: 'apps/tui/Cargo.toml',
            sourceFiles: ['apps/tui/src/app.rs'],
          },
        },
      ],
    };
    getRubric.mockResolvedValue(cargoRubric);
    const evaluateCargoChecks = vi.fn<EvaluateCargoChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': CARGO_PASS_RUN },
    });
    const evaluateChecks = vi.fn<EvaluateChecks>();
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, {
      evaluateChecks,
      evaluateCargoChecks,
    });

    expect(res.ok).toBe(true);
    expect(evaluateChecks).not.toHaveBeenCalled();
    expect(evaluateCargoChecks).toHaveBeenCalledTimes(1);
    const call = evaluateCargoChecks.mock.calls[0][0];
    expect(call.root).toBe('/tmp/fake-root');
    expect(call.criteria).toBe(cargoRubric.criteria);
    expect(call.timeoutMs).toBe(SCORECARD_TEST_CHECK_TIMEOUT_MS);
    const payload = captureImprovement.mock.calls[0][0] as {
      payloadExtra: { observation: { checkRuns?: Record<string, CriterionCheckRun> } };
    };
    expect(payload.payloadExtra.observation.checkRuns?.['det-outcome']).toMatchObject({
      kind: 'cargo',
      manifestPath: 'apps/tui/Cargo.toml',
      sourceFiles: ['apps/tui/src/app.rs'],
      verdict: 'pass',
      runId: 'cargo-1',
    });
  });

  it('runs checks against targetHive paths for a cross-hive grader', async () => {
    resolveHarnessPaths.mockResolvedValue({
      projectDir: '/tmp/papercusp-target-tree',
      stateDir: '/tmp/papercusp-target-tree/.papercusp',
    });
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });

    const res = await emitScorecard(
      emitArgs({ sourceHive: 'sb-devboard-hive', targetHive: 'papercusp' }) as never,
      {
        createdBy: 'su-grader',
        ctxHarness: 'sb-devboard-hive',
        workspaceId: 'ws-test',
        checkRoot: '/tmp/sb-devboard-grader-tree',
      },
      { evaluateChecks },
    );

    expect(res.ok).toBe(true);
    expect(resolveHarnessPaths).toHaveBeenCalledWith('papercusp', 'ws-test');
    expect(evaluateChecks.mock.calls[0][0].root).toBe('/tmp/papercusp-target-tree');
    expect(resolvePlanHarness).not.toHaveBeenCalled();
  });

  it('derives targetHive from the rubric subject plan when targetHive is omitted', async () => {
    resolvePlanHarness.mockResolvedValue({ status: 'resolved', harnessSlug: 'papercusp' });
    resolveHarnessPaths.mockResolvedValue({
      projectDir: '/tmp/papercusp-target-tree',
      stateDir: '/tmp/papercusp-target-tree/.papercusp',
    });
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });

    const res = await emitScorecard(
      emitArgs({ sourceHive: 'sb-devboard-hive' }) as never,
      {
        createdBy: 'su-grader',
        ctxHarness: 'sb-devboard-hive',
        workspaceId: 'ws-test',
        checkRoot: '/tmp/sb-devboard-grader-tree',
      },
      { evaluateChecks },
    );

    expect(res.ok).toBe(true);
    expect(resolvePlanHarness).toHaveBeenCalledWith('ws-test', CHECKED_RUBRIC.subjectPlan);
    expect(resolveHarnessPaths).toHaveBeenCalledWith('papercusp', 'ws-test');
    expect(evaluateChecks.mock.calls[0][0].root).toBe('/tmp/papercusp-target-tree');
  });

  // scope-unique-identifiers-2026-07-26 P-006: a subject-plan slug held by several
  // harnesses used to resolve to the most recently updated one, so the checks ran
  // in whichever same-slug plan's tree was touched last.
  it('refuses with the candidates when the subject plan slug is ambiguous and nothing names its harness', async () => {
    resolvePlanHarness.mockResolvedValue({ status: 'ambiguous', candidates: ['email', 'papercusp'] });
    const evaluateChecks = vi.fn<EvaluateChecks>();

    const res = await emitScorecard(
      emitArgs({ sourceHive: 'sb-devboard-hive' }) as never,
      {
        createdBy: 'su-grader',
        ctxHarness: 'sb-devboard-hive',
        workspaceId: 'ws-test',
        checkRoot: '/tmp/sb-devboard-grader-tree',
      },
      { evaluateChecks },
    );

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({
      checkScopeRefusal: {
        error: 'subject_plan_ambiguous_across_harnesses',
        subjectPlan: CHECKED_RUBRIC.subjectPlan,
        candidates: ['email', 'papercusp'],
      },
    });
    expect(evaluateChecks).not.toHaveBeenCalled();
    expect(resolveHarnessPaths).not.toHaveBeenCalled();
  });

  it("uses the rubric's recorded subject harness before any slug lookup", async () => {
    getRubric.mockResolvedValue({ ...CHECKED_RUBRIC, subjectHarnessSlug: 'email' });
    resolveHarnessPaths.mockResolvedValue({
      projectDir: '/tmp/email-target-tree',
      stateDir: '/tmp/email-target-tree/.papercusp',
    });
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });

    const res = await emitScorecard(
      emitArgs({ sourceHive: 'sb-devboard-hive' }) as never,
      {
        createdBy: 'su-grader',
        ctxHarness: 'sb-devboard-hive',
        workspaceId: 'ws-test',
        checkRoot: '/tmp/sb-devboard-grader-tree',
      },
      { evaluateChecks },
    );

    expect(res.ok).toBe(true);
    expect(resolvePlanHarness).not.toHaveBeenCalled();
    expect(resolveHarnessPaths).toHaveBeenCalledWith('email', 'ws-test');
    expect(evaluateChecks.mock.calls[0][0].root).toBe('/tmp/email-target-tree');
  });

  it('uses the rubric workspace when a superuser dispatch omits workspaceId', async () => {
    resolveHarnessPaths.mockResolvedValue({
      projectDir: '/tmp/papercusp-target-tree',
      stateDir: '/tmp/papercusp-target-tree/.papercusp',
    });
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: true,
      checkRuns: { 'det-outcome': PASS_RUN },
    });

    const res = await emitScorecard(
      emitArgs({ targetHive: 'email' }) as never,
      { createdBy: 'su-grader', ctxHarness: 'papercusp', checkRoot: '/tmp/grader-tree' },
      { evaluateChecks },
    );

    expect(res.ok).toBe(true);
    expect(resolveHarnessPaths).toHaveBeenCalledWith('email', 'ws-test');
    expect(evaluateChecks.mock.calls[0][0].root).toBe('/tmp/papercusp-target-tree');
  });

  it('a check refusal refuses the EMIT — nothing is filed', async () => {
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: false,
      error: 'check_contradicted',
      criterionKey: 'det-outcome',
      rating: 'pass',
      run: { ...PASS_RUN, verdict: 'fail', failed: 1, passed: 2 },
      detail: "criterion 'det-outcome' is rated 'pass' but its deterministic tests-check FAILED",
    });
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('FAILED');
      expect((res as { checkRefusal?: { error: string } }).checkRefusal?.error).toBe('check_contradicted');
    }
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('surfaces the internal test-run identity and bounded router evidence on an unjudgeable check', async () => {
    const evaluateChecks = vi.fn<EvaluateChecks>().mockResolvedValue({
      ok: false, error: 'check_run_failed', criterionKey: 'det-outcome',
      detail: 'the batched tests-check run could not be judged (route_error; runId route-run-42)',
      runner: { runId: 'route-run-42', root: '/tmp/fake-root', error: 'route_error',
        routerOutput: 'TEST_FILE_ROUTE_ERROR exact router evidence' },
    });
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected an unjudgeable check refusal');
    expect(res.checkRefusal).toMatchObject({
      error: 'check_run_failed',
      runner: { runId: 'route-run-42', error: 'route_error',
        routerOutput: 'TEST_FILE_ROUTE_ERROR exact router evidence' },
    });
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a rubric without tests-checks never invokes the evaluator (fuzzy grading unchanged)', async () => {
    getRubric.mockImplementation(async () => ({
      ...CHECKED_RUBRIC,
      criteria: CHECKED_RUBRIC.criteria.map(({ check: _check, ...c }) => c),
    }));
    const evaluateChecks = vi.fn<EvaluateChecks>();
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(true);
    expect(evaluateChecks).not.toHaveBeenCalled();
  });

  it('the unchanged-evidence decline fires BEFORE any check run — a deduped re-emit burns no suite', async () => {
    const canonical: ObservationRatings = {
      'det-outcome': { rating: 'pass', evidence: 'suite green' },
      'fuzzy-outcome': { rating: 'pass', evidence: 'reads well' },
    };
    listScorecards.mockResolvedValue([
      {
        issueId: 'EI-prev',
        rubricRef: 'ar-checked-plan',
        ratings: canonical,
        sourceHive: 'papercusp',
        rubricRevision: 3,
        evidenceFingerprint: scorecardEvidenceFingerprint({ rubricRef: 'ar-checked-plan', ratings: canonical }),
      },
    ]);
    const evaluateChecks = vi.fn<EvaluateChecks>();
    const res = await emitScorecard(emitArgs() as never, EMIT_INPUT, { evaluateChecks });
    expect(res.ok).toBe(true);
    expect((res as { created?: boolean }).created).toBe(false);
    expect((res as { reason?: string }).reason).toBe('unchanged-evidence');
    expect(evaluateChecks).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('records separate timings for every deterministic evaluator', async () => {
    let clock = 0;
    const phases = createPhaseTracker({ now: () => clock });
    const criteria = [
      { ...CHECKED_RUBRIC.criteria[0], key: 'tests-wait', check: { kind: 'tests', files: ['packages/x/a.test.ts'] } },
      { ...CHECKED_RUBRIC.criteria[0], key: 'probe-wait', check: { kind: 'probe', probe: { kind: 'tool', tool: 'acceptance:read', args: {}, schemaRevision: 'phase-test', expect: { path: '$.ok', op: 'eq', value: true } } } },
      { ...CHECKED_RUBRIC.criteria[0], key: 'cargo-wait', check: { kind: 'cargo', manifestPath: 'apps/x/Cargo.toml', sourceFiles: ['apps/x/src/lib.rs'] } },
      { ...CHECKED_RUBRIC.criteria[0], key: 'coverage-wait', check: { kind: 'coverage', scope: { sourceFiles: ['packages/x/a.ts'] }, floor: 'required' } },
      { ...CHECKED_RUBRIC.criteria[0], key: 'requirements-wait', check: { kind: 'requirements' } },
    ];
    getRubric.mockResolvedValue({ ...CHECKED_RUBRIC, criteria, subjectPlan: 'phase-test-plan' });
    const ratings = Object.fromEntries(criteria.map(({ key }) => [key, { rating: 'pass', evidence: 'phase timing fixture' }]));
    const advanceClock = async () => {
      clock += 7;
      return { ok: true as const, checkRuns: {} };
    };
    const evaluateChecks = vi.fn<EvaluateChecks>().mockImplementation(advanceClock);
    const evaluateProbeChecks = vi.fn<typeof evaluateCriterionProbeChecks>().mockImplementation(advanceClock);
    const evaluateCargoChecks = vi.fn<EvaluateCargoChecks>().mockImplementation(advanceClock);
    const evaluateCoverageChecks = vi.fn<typeof evaluateCriterionCoverageChecks>().mockImplementation(advanceClock);
    const evaluateRequirementChecks = vi.fn<typeof evaluateCriterionRequirementChecks>().mockImplementation(advanceClock);
    const recordCheckResults = vi.fn<typeof recordRubricCheckResults>().mockResolvedValue([]);

    const result = await emitScorecard(emitArgs({ ratings }) as never, { ...EMIT_INPUT, phases }, {
      evaluateChecks,
      evaluateProbeChecks,
      evaluateCargoChecks,
      evaluateCoverageChecks,
      evaluateRequirementChecks,
      recordCheckResults,
    });

    expect(result.ok).toBe(true);
    expect(phases.intervals()).toEqual([
      { phase: 'scorecards:emit:checks:tests', startMs: 0, durationMs: 7 },
      { phase: 'scorecards:emit:checks:probe', startMs: 7, durationMs: 7 },
      { phase: 'scorecards:emit:checks:cargo', startMs: 14, durationMs: 7 },
      { phase: 'scorecards:emit:checks:coverage', startMs: 21, durationMs: 7 },
      { phase: 'scorecards:emit:checks:requirements', startMs: 28, durationMs: 7 },
    ]);
  });

  it('forwards the dispatcher phase tracker through the tool-context bridge', async () => {
    const phases = createPhaseTracker();
    const probe = {
      kind: 'tool' as const,
      tool: 'scorecards:get',
      args: { issueId: 'EI-phase-bridge-probe' },
      schemaRevision: 'live',
      expect: { path: '$.count', op: 'eq' as const, value: 2 },
    };
    getRubric.mockResolvedValue({
      ...CHECKED_RUBRIC,
      criteria: [CHECKED_RUBRIC.criteria[0], { ...CHECKED_RUBRIC.criteria[1], check: { kind: 'probe', probe } }],
    });
    const dispatchTool = vi.fn(async () => ({ count: 2 }));
    const result = await emitScorecardForToolContext(emitArgs() as never, {
      uiClientId: 'su-scorecard-phase',
      isSuperuser: true,
      workspaceId: 'ws-test',
      harnessSlug: 'papercusp',
      role: 'engineer',
      projectDir: REPO_ROOT,
      dispatchTool,
      phases,
    } as never);

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(phases.intervals().map(({ phase }) => phase)).toContain('scorecards:emit:checks:probe');
  });
});

describe('scorecards:emit deterministic-check transport budget', () => {
  it('covers the 50-file contract and keeps outer headroom for cleanup + persistence', () => {
    // WI-41341: a measured 16-file acceptance batch takes about four minutes.
    // Linear capacity at the 50-file schema cap is 12.5 minutes, rounded up.
    const measuredBatchMs = 4 * 60_000;
    const measuredFiles = 16;
    const maxFiles = 50;
    const scaledContractMs = Math.ceil((measuredBatchMs * maxFiles) / measuredFiles);

    expect(SCORECARD_TEST_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(scaledContractMs);
    expect(scorecardEmitTool.timeoutSec).toBe(SCORECARD_EMIT_TIMEOUT_SEC);
    expect(SCORECARD_EMIT_TIMEOUT_SEC * 1_000 - SCORECARD_TEST_CHECK_TIMEOUT_MS)
      .toBeGreaterThanOrEqual(2 * 60_000);
  });
});
