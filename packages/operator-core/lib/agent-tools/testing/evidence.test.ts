import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSpecEvidence, measureRepoFilesEvidenceAtRoot, type RetractSpecEvidenceOptions } from '../plans/spec-evidence-store';
import {
  deferredTestEvidenceRecoveryBundle,
  prepareTestEvidence,
  finishTestEvidence,
  recoverTestEvidence,
  recoverTestEvidenceSchema,
  retractRefusedTestEvidence,
  testEvidenceOutcome,
  testEvidenceSchema,
  PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS,
  RECOVERY_WAIT_CEILING_MS,
} from './evidence';
import type { TestFilesCoreResult } from './run';
import { getRunAsync, parseVitestJsonForHarnessRows, persistHarnessTestRuns } from '../../testing-run-store';
import type { RunSnapshot } from '../../testing-run-store';

/**
 * The SUCCESS member of the result union. Every helper below builds a run that COMPLETED, and
 * annotating one with the whole union checks its object literal against the ERROR member too —
 * where `passed` is an excess property, not a field. Naming the member is what lets a helper
 * spread another helper's result; the union stays in use wherever a caller really accepts both.
 */
type TestFilesRunResult = Extract<TestFilesCoreResult, { error?: undefined }>;
type ListedSpecEvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];

const runId = 'ca5fce52-7c67-4d38-8c26-96a952f6a2a2';
const scope = { workspaceId: 'ws', harnessSlug: 'h1', actorId: 'su-test', root: '/repo' };
const binding = { specId: 'R-1', specRevision: 2, testPath: 'test/feature.test.ts', sourcePaths: ['src/feature.ts'],
  testLayer: 'unit' as const, scenarioIds: ['happy'], causalPairId: 'original-failure' };
const request = { workItemId: 'WI-1', planSlug: 'p1', bindings: [binding] };
const result = (counts: { passed?: number; failed?: number; skipped?: number; collectionFailed?: boolean } = {}): TestFilesRunResult => ({
  ok: true, runId, root: '/repo', passed: 1, failed: 0, skipped: 0, files: 1,
  failures: [], failuresTruncated: false, durationMs: 10,
  byFile: { [binding.testPath]: { passed: 1, failed: 0, skipped: 0, collectionFailed: false, ...counts } },
});
const deps = () => ({
  bind: vi.fn().mockResolvedValue({ status: 'created', id: 1 }),
  measure: vi.fn().mockResolvedValue({ sourceFingerprint: 'source-before', testFingerprint: 'test-before' }),
  ledger: vi.fn().mockResolvedValue([{ id: 42, file_path: binding.testPath, status: 'pass', finished_at: '2026-09-08T00:00:00Z' }]),
  list: vi.fn<typeof listSpecEvidence>().mockResolvedValue([]),
  unattributed: vi.fn().mockResolvedValue(0),
  runStatus: vi.fn(async (_runId: string): Promise<RunSnapshot | null> => null),
  now: vi.fn(() => Date.parse('2026-10-06T01:00:00.000Z')),
  retract: vi.fn(async (options: RetractSpecEvidenceOptions) => ({
    status: 'retracted' as const,
    bindingId: options.bindingId,
    binding: {
      id: options.bindingId,
      work_item_id: 'WI-1',
      plan_slug: 'p1',
      spec_id: 'R-1',
      spec_revision: 2,
      evidence_kind: 'test' as const,
      evidence_ref: `test-run-group:${runId}:0`,
      retracted_at: new Date('2026-09-24T00:00:00Z'),
      retracted_by: options.actorId,
      retraction_reason: options.reason,
    },
    cancelledAuditIssueIds: [],
  })),
});

const detachedRunSnapshot = (runId: string, status: RunSnapshot['status'], exitCode: number | null,
  finishedAt: number | null = 10_000): RunSnapshot => ({
  runId, kind: 'vitest', label: 'detached test run', command: ['node', 'scripts/test-files.mjs'],
  status, exitCode, startedAt: 1, finishedAt, output: '', truncated: false,
});

describe('test-time evidence continuity', () => {
  it.each([false, true])('keeps an observed unit run from settling a claimed integration binding (recovery=%s)', async (recovery) => {
    const d = deps();
    d.ledger.mockResolvedValue([{ id: 42, file_path: binding.testPath, status: 'pass',
      finished_at: '2026-09-08T00:00:00Z',
      execution_details: JSON.stringify({ schemaVersion: 1, testLayer: 'unit' }) }]);
    const requested = { ...request, bindings: [{ ...binding, testLayer: 'integration' as const }] };
    const prepared = await prepareTestEvidence(requested, runId, [binding.testPath], scope, d);
    if (recovery) {
      prepared[0].input.testRunId = 42;
      prepared[0].input.details = { ...prepared[0].input.details,
        testExecution: { phase: 'settled', runId, ledgerStatus: 'pass' } };
    }
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, recovery ? undefined : result(), d);
    expect(bundle.rows[0]).toMatchObject({ phase: 'layer-mismatch', outcome: 'unknown' });
    expect(bundle.verificationFingerprint).toBeNull();
    expect(d.bind.mock.calls[1][0].details.adequacy).toMatchObject({ testLayer: 'unit', outcome: 'unknown', executed: false });
  });

  it('stamps the measured checkout into the binding when it is not the session root (EI-25203154942838341)', async () => {
    // Without the stamp the evaluator re-measured hive-app proofs at the session harness root
    // and rated them freshness:unknown forever (ENOENT on a path that only exists in the app repo).
    const d = deps();
    const hiveScope = { ...scope, root: '/hives/phone-app', rootHarnessSlug: 'phone-app' };
    const [stamped] = await prepareTestEvidence(request, runId, [binding.testPath], hiveScope, d);
    expect(d.measure).toHaveBeenCalledWith('/hives/phone-app', expect.objectContaining({ rootHarnessSlug: 'phone-app' }));
    expect(stamped.measurement).toMatchObject({ rootHarnessSlug: 'phone-app', testPaths: [binding.testPath] });
    expect(stamped.input.details?.currentMeasurement).toEqual(stamped.measurement);

    // A run at the session root keeps the historical shape: no stamp at all, never null.
    const plain = deps();
    const [unstamped] = await prepareTestEvidence(request, runId, [binding.testPath], scope, plain);
    expect(unstamped.measurement).not.toHaveProperty('rootHarnessSlug');
    expect(plain.measure.mock.calls[0][1]).not.toHaveProperty('rootHarnessSlug');
  });

  it('keeps source globs in validated test evidence, measurements, and the stored run recipe', async () => {
    const sourceGlobs = ['dynamic/plugins/*/papercusp.json'];
    const globbedRequest = testEvidenceSchema.parse({
      ...request,
      bindings: [{ ...binding, sourceGlobs }],
    });
    const d = deps();
    const prepared = await prepareTestEvidence(globbedRequest, runId, [binding.testPath], scope, d);
    const expectedMeasurement = {
      schemaVersion: 1,
      kind: 'repo-files',
      sourcePaths: binding.sourcePaths,
      sourceGlobs,
      testPaths: [binding.testPath],
    };

    expect(d.measure).toHaveBeenCalledWith(scope.root, expectedMeasurement);
    expect(prepared[0]!.measurement).toEqual(expectedMeasurement);
    expect(prepared[0]!.input.details?.currentMeasurement).toEqual(expectedMeasurement);
    expect(prepared[0]!.input.details?.testExecution).toMatchObject({ binding: { sourceGlobs } });

    await finishTestEvidence(prepared, runId, runId, scope, result(), d);
    expect(d.bind.mock.calls[1]![0].details.currentMeasurement).toEqual(expectedMeasurement);
    expect(d.bind.mock.calls[1]![0].details.testExecution).toMatchObject({ binding: { sourceGlobs } });
  });

  it('returns a bounded pending recovery bundle for foreground timeouts', () => {
    const detached = '1a40bd16-98ca-4092-8b88-5707ed6e0e64';
    const bundle = deferredTestEvidenceRecoveryBundle(request, runId, detached, scope.harnessSlug);
    expect(bundle).toMatchObject({
      status: 'incomplete',
      acceptance: 'requires-review',
      rows: [{ specId: 'R-1', evidenceRef: `test-run-group:${runId}:0`, testRunId: null,
        phase: 'pending', outcome: 'unknown' }],
      total: 1,
      recovery: { args: { recoverEvidence: { workItemId: 'WI-1', originRunId: runId, runId: detached } } },
    });
    expect(bundle.readRef.args.evidenceRefs).toEqual([`test-run-group:${runId}:0`]);
  });

  it('persists exact requirement/correction links before execution and adds measured ledger proof afterward', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    expect(d.bind.mock.calls[0][0]).toMatchObject({ workItemId: 'WI-1', specRevision: 2,
      sourceFingerprint: 'source-before', details: { adequacy: { outcome: 'pending', executed: false,
        scenarioIds: ['happy'], causalPairIds: ['original-failure'] } } });
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, result(), d);
    expect(bundle).toMatchObject({ status: 'recorded', acceptance: 'requires-review', total: 1,
      rows: [{ testRunId: 42, outcome: 'pass', phase: 'settled' }] });
    expect(d.bind.mock.calls[1][0]).toMatchObject({ testRunId: 42, sourceFingerprint: 'source-before',
      details: { currentMeasurement: { sourcePaths: ['src/feature.ts'], testPaths: [binding.testPath] },
        adequacy: { collected: true, executed: true, skipped: false, outcome: 'pass' } } });
    expect(d.bind.mock.calls[1][0].details.adequacy).not.toHaveProperty('oracleIndependent');
  });

  it('retracts earlier pending bindings when a later evidence registration is refused', async () => {
    const d = deps();
    const batch = {
      ...request,
      bindings: [binding, { ...binding, specId: 'R-2', specRevision: 99 }],
    };
    d.bind
      .mockResolvedValueOnce({ status: 'created', id: 101 } as never)
      .mockResolvedValueOnce({ status: 'spec_revision_not_found', specId: 'R-2', specRevision: 99 } as never);
    d.list.mockResolvedValue([{
      id: 101,
      withdrawal: null,
      evidenceKind: 'test',
      specId: 'R-1',
      specRevision: 2,
      evidenceRef: 'test-run-group:' + runId + ':0',
      testRunId: null,
      details: { testExecution: { schemaVersion: 1, phase: 'pending', runId, originRunId: runId } },
    }] as never);

    await expect(prepareTestEvidence(batch, runId, [binding.testPath], scope, d))
      .rejects.toThrow('evidence_registration_failed:spec_revision_not_found');

    expect(d.bind).toHaveBeenCalledTimes(2);
    expect(d.retract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      harnessSlug: scope.harnessSlug,
      bindingId: 101,
      reason: expect.stringContaining('evidence_registration_failed:spec_revision_not_found'),
      actorId: scope.actorId,
    }));
  });

  it('rejects a nonexistent source path before binding any evidence rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'testing-run-missing-evidence-source-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'test'), { recursive: true });
      await writeFile(join(root, 'src/feature.ts'), 'export const answer = 42;\n');
      await writeFile(join(root, 'test/feature.test.ts'), "import { it } from 'vitest'; it('noop', () => {});\n");
      const d = deps();
      d.measure = measureRepoFilesEvidenceAtRoot;
      const batch = {
        ...request,
        bindings: [
          { ...binding, testPath: 'test/feature.test.ts', sourcePaths: ['src/feature.ts'] },
          { ...binding, specId: 'R-2', testPath: 'test/feature.test.ts',
            sourcePaths: ['packages/operator-core/lib/agent-tools/plans/plan-converge.ts'] },
        ],
      };

      await expect(prepareTestEvidence(batch, runId, ['test/feature.test.ts'], { ...scope, root }))
        .rejects.toThrow();

      expect(d.bind).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // R-8: an infrastructure/attribution failure must not be reported as a missing run.
  // A test_runs row written without workspace_id/harness_slug is invisible to the
  // tenant-scoped ledger read, so the binding used to settle as a bare `pending` with
  // ledgerMatches:0 — indistinguishable from "the test never executed". The run DID
  // happen; only its attribution is absent. Say so, without promoting it to proof.
  it('separates an unattributed ledger row from a genuinely absent run', async () => {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    d.unattributed.mockResolvedValue(1);
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, undefined, d);
    expect(bundle.rows[0]).toMatchObject({ phase: 'ledger-unattributed', testRunId: null });
    expect(d.bind.mock.calls[1][0].details.testExecution).toMatchObject({
      ledgerAttribution: 'unattributed', ledgerUnattributedRows: 1, ledgerMatches: 0 });
    // Attribution is not execution: an unattributed row is still never passing proof.
    expect(d.bind.mock.calls[1][0].details.adequacy).toMatchObject({ outcome: 'unknown', executed: false });
  });

  it('keeps a genuinely absent run pending without appending another pending row', async () => {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, undefined, d);
    expect(bundle.rows[0]).toMatchObject({ phase: 'pending', bindingStatus: 'pending-retained' });
    expect(d.unattributed).toHaveBeenCalledOnce();
    expect(d.bind).toHaveBeenCalledTimes(1);
  });

  it('refuses an unselected test before registering any mapping', async () => {
    const d = deps();
    await expect(prepareTestEvidence(request, runId, ['test/unrelated.test.ts'], scope, d)).rejects.toThrow('evidence_test_not_selected');
    expect(d.bind).not.toHaveBeenCalled();
    expect(() => testEvidenceSchema.parse({ ...request, bindings: [{ ...binding, sourcePaths: ['../secret'] }] })).toThrow();
    expect(() => testEvidenceSchema.parse({
      ...request,
      bindings: [{ ...binding, sourceGlobs: ['../outside/*.json'] }],
    })).toThrow();
  });

  it.each([
    [{ passed: 0, collectionFailed: true }, 'error', false],
    [{ passed: 0, skipped: 1, collectionFailed: true }, 'error', false],
    [{ passed: 0, failed: 1 }, 'fail', true],
    [{ passed: 0, skipped: 1 }, 'skip', false],
    [{ passed: 1, skipped: 1 }, 'skip', true],
    [{ passed: 0 }, 'unknown', false],
  ] as const)('never converts an incomplete or failing execution into success: %j', (counts, outcome, executed) => {
    expect(testEvidenceOutcome(binding, result(counts))).toMatchObject({ outcome, executed });
  });

  it('does not turn explicitly name-filtered exclusions into a skipped proof', () => {
    const filtered = { ...result({ passed: 2, skipped: 519 }), testNamePattern: 'P-001' };
    expect(testEvidenceOutcome(binding, filtered)).toMatchObject({ outcome: 'pass', executed: true,
      skipped: false, filteredSkipped: 519 });
  });

  it('keeps filtered skip counts in execution metadata while adequacy describes selected proof', async () => {
    const d = deps();
    const filtered = { ...result({ passed: 2, skipped: 519 }), testNamePattern: 'P-001' };
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, filtered, d);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(d.bind.mock.calls[1][0].details.testExecution).toMatchObject({
      testNamePattern: 'P-001', filteredSkipped: 519, measuredOutcome: 'pass' });
    expect(d.bind.mock.calls[1][0].details.adequacy).toMatchObject({
      collected: true, executed: true, skipped: false, outcome: 'pass' });
  });

  it('requires the exact declared assertion for a successful counterexample', () => {
    const counterexample = { ...binding, counterexample: { test: 'restores omitted duty', messageIncludes: 'expected delivered' } };
    const failed = result({ passed: 0, failed: 1 });
    if (failed.error) throw new Error('fixture');
    failed.failures = [{ file: binding.testPath, test: 'restores omitted duty', message: 'expected delivered but omitted' }];
    expect(testEvidenceOutcome(counterexample, failed).outcome).toBe('killed');
    failed.failures[0].test = 'unrelated failure';
    expect(testEvidenceOutcome(counterexample, failed).outcome).toBe('fail');
  });

  it.each([
    [{ passed: 0, collectionFailed: true }, 'error'],
    [{ passed: 0, skipped: 1 }, 'skip'],
    [{ passed: 0 }, 'unknown'],
  ] as const)('preserves an unexecuted counterexample outcome: %j', (counts, outcome) => {
    const counterexample = { ...binding, counterexample: { test: 'target assertion', messageIncludes: 'expected' } };
    expect(testEvidenceOutcome(counterexample, result(counts))).toMatchObject({ outcome, executed: false });
  });

  it.each([null, [], [{ id: 98, file_path: 'other.test.ts', status: 'pass', finished_at: 'now' }]])('keeps missing/unreadable/misattributed ledger proof pending', async ledger => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    d.ledger.mockResolvedValue(ledger);
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, result(), d);
    expect(bundle.rows[0]).toMatchObject({ testRunId: null, phase: 'pending', outcome: 'unknown',
      bindingStatus: 'pending-retained' });
    expect(d.bind).toHaveBeenCalledTimes(1);
  });

  it('retains the original fingerprint when files change during execution', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    d.measure.mockResolvedValue({ sourceFingerprint: 'changed', testFingerprint: 'test-before' });
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, result(), d);
    expect(bundle.rows[0].phase).toBe('source-changed');
    expect(d.bind.mock.calls[1][0].sourceFingerprint).toBe('source-before');
  });

  it('rehydrates recorded mappings after a timeout without claiming unmeasured collection/skip details', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const detached = '1a40bd16-98ca-4092-8b88-5707ed6e0e64';
    await finishTestEvidence(prepared, runId, detached, scope, { ok: false, runId, root: '/repo', error: 'timeout' }, d);
    const stored = d.bind.mock.calls[1][0];
    d.list.mockResolvedValue([{ ...stored, id: 2,
      fingerprints: { sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1', originRunId: runId, runId: detached }, scope, d);
    expect(bundle.rows[0]).toMatchObject({ testRunId: 42, phase: 'review-required', outcome: 'unknown' });
    expect(d.bind.mock.calls[2][0].details.adequacy.executed).toBe(false);
    await expect(recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1', originRunId: runId,
      runId: 'faf310d9-ea4e-498c-be6b-6773fe46a276' }, scope, d)).rejects.toThrow('evidence_recovery_not_found');
  });

  it('recovers a timed-out run whose reporter retained the origin group instead of the detached handle', async () => {
    const d = deps();
    const detached = '1a40bd16-98ca-4092-8b88-5707ed6e0e64';
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    await finishTestEvidence(prepared, runId, detached, scope,
      { ok: false, runId, root: scope.root, error: 'timeout' }, d);
    const stored = d.bind.mock.calls.at(-1)![0];
    d.list.mockResolvedValue([{ ...stored, id: 2, fingerprints: {
      sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
    d.ledger.mockImplementation(async ({ runGroupId: requested }) => requested === detached ? [] : [{
      id: 42, file_path: binding.testPath, status: 'pass', finished_at: '2026-09-09T00:00:00Z',
      execution_details: { schemaVersion: 1, root: scope.root, filePath: binding.testPath,
        workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: runId,
        testNamePattern: null, passed: 1, failed: 0, skipped: 0, collectionFailed: false,
        mutationPhase: null, commitSha: null, worktreeDirty: false },
    }]);

    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId: detached }, scope, d);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42,
      evidenceRef: `test-run-group:${runId}:0`, ledgerRunGroupId: runId });
    expect(d.bind.mock.calls.at(-1)![0].details.testExecution).toMatchObject({
      runId: detached, ledgerRunGroupId: runId, ledgerAttribution: 'attributed' });

    const originOnly = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId }, scope, d);
    expect(originOnly.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42 });
    expect(d.bind.mock.calls.at(-1)![0].details.testExecution).toMatchObject({
      runId: detached, ledgerRunGroupId: runId, ledgerAttribution: 'attributed' });
  });

  it('recovers with the detached handle while the initial evidence row still stores the origin id', async () => {
    const d = deps();
    const detached = '1a40bd16-98ca-4092-8b88-5707ed6e0e64';
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const stored = d.bind.mock.calls[0]![0];
    d.list.mockResolvedValue([{ ...stored, id: 2, fingerprints: {
      sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
    d.ledger.mockResolvedValue([{
      id: 42, file_path: binding.testPath, status: 'pass', finished_at: '2026-09-09T00:00:00Z',
      execution_details: { schemaVersion: 1, root: scope.root, filePath: binding.testPath,
        workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: detached,
        testNamePattern: null, passed: 1, failed: 0, skipped: 0, collectionFailed: false,
        mutationPhase: null, commitSha: null, worktreeDirty: false },
    }]);

    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId: detached }, scope, d);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42,
      evidenceRef: `test-run-group:${runId}:0`, ledgerRunGroupId: detached });
    expect(d.bind.mock.calls.at(-1)![0].details.testExecution).toMatchObject({
      runId: detached, originRunId: runId, ledgerRunGroupId: detached, ledgerAttribution: 'attributed' });
    expect(prepared).toHaveLength(1);
  });

  it.each([{ id: 42, status: 'fail' }, { id: 43, status: 'pass' }])(
    'invalidates settled passing recovery when ledger attribution changes: %j', async changed => {
      const d = deps();
      const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
      await finishTestEvidence(prepared, runId, runId, scope, result(), d);
      const stored = d.bind.mock.calls[1][0];
      d.list.mockResolvedValue([{ ...stored, id: 2,
        fingerprints: { sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
      const recovery = { workItemId: 'WI-1', planSlug: 'p1', originRunId: runId, runId };
      expect((await recoverTestEvidence(recovery, scope, d)).rows[0])
        .toMatchObject({ testRunId: 42, phase: 'settled', outcome: 'pass' });
      d.ledger.mockResolvedValue([{ ...changed, file_path: binding.testPath, finished_at: 'now' }]);
      expect((await recoverTestEvidence(recovery, scope, d)).rows[0])
        .toMatchObject({ testRunId: changed.id, phase: 'review-required', outcome: 'unknown' });
      expect(d.bind.mock.calls.at(-1)![0].details.adequacy.executed).toBe(false);
    },
  );

  const detached = '1a40bd16-98ca-4092-8b88-5707ed6e0e64';
  const measured = { schemaVersion: 1, root: scope.root, filePath: binding.testPath,
    workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, runGroupId: detached,
    testNamePattern: null, passed: 2, failed: 0, skipped: 0, collectionFailed: false,
    mutationPhase: null, commitSha: null, worktreeDirty: false };
  async function pendingRecovery(detail: unknown, status = 'pass', sourceChanged = false, detachedRun?: RunSnapshot) {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    d.unattributed.mockResolvedValue(0);
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    await finishTestEvidence(prepared, runId, detached, scope,
      { ok: false, runId, root: scope.root, error: 'timeout' }, d);
    const stored = d.bind.mock.calls.at(-1)![0];
    d.list.mockResolvedValue([{ ...stored, id: 2, fingerprints: {
      sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
    d.ledger.mockResolvedValue([{ id: 42, file_path: binding.testPath, status,
      finished_at: '2026-09-09T00:00:00Z', execution_details: detail }]);
    d.runStatus.mockResolvedValue(detachedRun ?? null);
    if (sourceChanged) d.measure.mockResolvedValue({ sourceFingerprint: 'changed', testFingerprint: 'test-before' });
    return { d, bundle: await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId: detached }, scope, d) };
  }

  const pendingEvidenceRow = (id: number, details: Record<string, unknown>): ListedSpecEvidenceRow => ({
    id, workItemId: 'WI-1', planSlug: 'p1', specId: 'R-1', specRevision: 2, evidenceKind: 'test',
    evidenceRef: `test-run-group:${runId}:0`, testRunId: null, testRunProvenance: null, details,
    sourceValId: null, currentRevision: 2, specFingerprint: 'spec-fingerprint',
    fingerprints: {
      sourceFingerprint: 'source-before', testFingerprint: 'test-before',
      fixtureFingerprint: null, rubricFingerprint: null, environmentFingerprint: null,
    },
    coverageEvidenceRef: null, observedAt: '2026-09-24T00:00:00.000Z',
    bindingFingerprint: `binding-${id}`, createdBy: 'su-test', createdAt: '2026-09-24T00:00:00.000Z',
    currentness: {
      overall: 'unknown',
      dimensions: {
        spec: 'current', source: 'current', test: 'current', fixture: 'not-applicable',
        rubric: 'not-applicable', environment: 'not-applicable',
        coverageEvidence: 'not-applicable', testRun: 'not-applicable',
      },
      staleReasons: [], unknownReasons: ['fixture'], comparisonSupplied: false,
      provenance: 'not-supplied',
    },
  });

  it('retires pending rows for a detached run that terminated before a file-level ledger result', async () => {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    d.unattributed.mockResolvedValue(0);
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const initial = d.bind.mock.calls[0]![0];
    const detachedTwin = { ...initial.details,
      testExecution: { ...initial.details.testExecution, runId: detached } };
    d.list.mockResolvedValue([
      pendingEvidenceRow(1, initial.details),
      pendingEvidenceRow(2, detachedTwin),
    ]);
    d.runStatus.mockResolvedValue(detachedRunSnapshot(detached, 'fail', 143));

    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId: detached }, scope, d);

    expect(bundle.rows[0]).toMatchObject({ phase: 'terminal-no-result', outcome: 'unknown',
      testRunId: null, bindingStatus: 'not-bound' });
    expect(bundle.detachedRunStatus).toMatchObject({ status: 'fail', exitCode: 143 });
    expect(bundle.pendingRetirement).toMatchObject({ status: 'complete', retiredCount: 2, bindingIds: [1, 2] });
    expect(d.bind).toHaveBeenCalledTimes(1);
    expect(d.retract.mock.calls.map(([options]) => options.bindingId)).toEqual([1, 2]);
    expect(d.retract.mock.calls[0]![0].reason).toContain('exit 143');
  });

  it('recovers runner-retired pending mappings when the saved reporter result arrives later', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const initial = d.bind.mock.calls[0]![0];
    const retired = { ...pendingEvidenceRow(2, {
      ...initial.details, testExecution: { ...initial.details.testExecution, runId: detached },
    }), withdrawal: {
      at: '2026-09-24T00:00:01.000Z', by: scope.actorId,
      reason: `Detached test run ${detached} terminated (error, exit unknown) without an attributed result for ${binding.testPath}; this attempt cannot settle and must be rerun.`,
    } };
    d.list.mockImplementation(async options => options.includeRetracted ? [retired] : []);
    d.runStatus.mockResolvedValue(detachedRunSnapshot(detached, 'pass', 0));
    d.ledger.mockResolvedValue([{ id: 42, file_path: binding.testPath, status: 'pass',
      finished_at: '2026-09-24T00:00:02Z', execution_details: measured }]);

    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId: detached, waitMs: 0 }, scope, d);

    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42 });
    expect(d.bind.mock.calls.at(-1)![0]).toMatchObject({
      sourceFingerprint: 'source-before', testFingerprint: 'test-before',
      details: { testExecution: { runId: detached, originRunId: runId } },
    });
    expect(retired.withdrawal.reason).toContain('without an attributed result');
  });

  it.each<{ reason?: string; phase?: string; testRunId?: number; reasonRunId?: string; reasonPath?: string }>([
    { reason: 'Reviewer withdrew invalid evidence deliberately.' },
    { phase: 'settled' },
    { testRunId: 99 },
    { reasonRunId: 'faf310d9-ea4e-498c-be6b-6773fe46a276' },
    { reasonPath: 'test/another.test.ts' },
  ])('does not revive an unrelated or deliberately withdrawn mapping: %j', async change => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const initial = d.bind.mock.calls[0]![0];
    const retired = { ...pendingEvidenceRow(2, {
      ...initial.details, testExecution: { ...initial.details.testExecution, runId: detached,
        ...(change.phase === undefined ? {} : { phase: change.phase }) },
    }), ...(change.testRunId === undefined ? {} : { testRunId: change.testRunId }), withdrawal: {
      at: '2026-09-24T00:00:01.000Z', by: scope.actorId,
      reason: change.reason ?? `Detached test run ${change.reasonRunId ?? detached} terminated (error, exit unknown) without an attributed result for ${change.reasonPath ?? binding.testPath}; this attempt cannot settle and must be rerun.`,
    } };
    d.list.mockImplementation(async options => options.includeRetracted ? [retired] : []);

    await expect(recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId: detached, waitMs: 0 }, scope, d)).rejects.toThrow('evidence_recovery_not_found');
    expect(d.runStatus).not.toHaveBeenCalled();
    expect(d.bind).toHaveBeenCalledTimes(1);
  });

  it('keeps evidence pending while the detached run is still progressing', async () => {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    d.unattributed.mockResolvedValue(0);
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const initial = d.bind.mock.calls[0]![0];
    d.list.mockResolvedValue([pendingEvidenceRow(1, initial.details)]);
    d.runStatus.mockResolvedValue(detachedRunSnapshot(detached, 'running', null, null));

    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId: detached, waitMs: 0 }, scope, d);

    expect(bundle.status).toBe('incomplete');
    expect(bundle.rows[0]).toMatchObject({ phase: 'pending', outcome: 'unknown' });
    expect(bundle.detachedRunStatus).toMatchObject({ status: 'running' });
    expect(bundle.recoveryWait).toMatchObject({ limitMs: 0, outcome: 'still-running' });
    expect(d.retract).not.toHaveBeenCalled();
    expect(bundle.rows[0]).toMatchObject({ bindingStatus: 'pending-retained' });
    expect(d.bind).toHaveBeenCalledTimes(1);
  });

  it('retires an unknown run without adding a duplicate pending binding after the grace period', async () => {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    d.unattributed.mockResolvedValue(0);
    await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    d.list.mockResolvedValue([pendingEvidenceRow(1, d.bind.mock.calls[0]![0].details)]);

    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId, waitMs: 0 }, scope, d);

    expect(bundle).toMatchObject({ status: 'abandoned', recoveryWait: { outcome: 'abandoned' },
      rows: [{ phase: 'abandoned', outcome: 'unknown', bindingStatus: 'abandoned' }],
      pendingRetirement: { status: 'complete', retiredCount: 1, bindingIds: [1] } });
    expect(d.retract.mock.calls.map(([options]) => options.bindingId)).toEqual([1]);
    expect(d.retract.mock.calls[0]![0].reason).toContain(
      `${Math.round(PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS / 1000)}s pending grace`);
    expect(d.bind).toHaveBeenCalledTimes(1);
  });

  it('does not abandon an origin whose foreground task is running without a snapshot or reporter row', async () => {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    d.unattributed.mockResolvedValue(0);
    await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    d.list.mockResolvedValue([pendingEvidenceRow(1, d.bind.mock.calls[0]![0].details)]);
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join(' ').includes('FROM harness_shared.task_ledger') && values.includes(`testing:run:${runId}`)) {
        return [{ task_id: 'live-foreground-task', title: `testing:run foreground ${runId}`,
          argv: ['node', 'scripts/test-files.mjs'], state: 'running',
          started_at: new Date('2026-09-24T00:00:00.000Z'), ended_at: null }];
      }
      return [];
    });
    d.runStatus.mockImplementation(id => getRunAsync(id, sql, scope));

    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId, waitMs: 0 }, scope, d);

    expect(bundle).toMatchObject({ status: 'incomplete', recoveryWait: { outcome: 'still-running' },
      detachedRunStatus: { runId, status: 'running' },
      rows: [{ phase: 'pending', outcome: 'unknown', bindingStatus: 'pending-retained' }] });
    expect(d.retract).not.toHaveBeenCalled();
    expect(d.bind).toHaveBeenCalledTimes(1);
  });

  it('retains a young unknown run without creating another pending binding', async () => {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    d.unattributed.mockResolvedValue(0);
    await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    d.now.mockReturnValue(Date.parse('2026-09-24T00:00:30.000Z'));
    d.list.mockResolvedValue([pendingEvidenceRow(1, d.bind.mock.calls[0]![0].details)]);

    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1',
      originRunId: runId, runId, waitMs: 0 }, scope, d);

    expect(bundle).toMatchObject({ recoveryWait: { outcome: 'not-found' },
      rows: [{ phase: 'pending', outcome: 'unknown', bindingStatus: 'pending-retained' }] });
    expect(d.retract).not.toHaveBeenCalled();
    expect(d.bind).toHaveBeenCalledTimes(1);
  });

  // EI-24207525450988644: one recovery call waits for the detached run itself, replacing the
  // caller's testing:run-status loop (6 and 8 polls on the two R-8 canary groups that timed out).
  async function waitingRecovery(configure: (d: ReturnType<typeof deps>) => void, waitMs?: number) {
    const d = deps();
    d.ledger.mockResolvedValue([]);
    d.unattributed.mockResolvedValue(0);
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    await finishTestEvidence(prepared, runId, detached, scope,
      { ok: false, runId, root: scope.root, error: 'timeout' }, d);
    const stored = d.bind.mock.calls.at(-1)![0];
    d.list.mockResolvedValue([{ ...stored, id: 2, fingerprints: {
      sourceFingerprint: stored.sourceFingerprint, testFingerprint: stored.testFingerprint } }]);
    configure(d);
    let clockMs = 0;
    const clock = { now: () => clockMs, sleep: vi.fn(async (ms: number) => { clockMs += ms; }) };
    const bundle = await recoverTestEvidence({ workItemId: 'WI-1', planSlug: 'p1', originRunId: runId,
      runId: detached, ...(waitMs === undefined ? {} : { waitMs }) }, scope, { ...d, ...clock });
    const sleptMs = clock.sleep.mock.calls.reduce((total, [ms]) => total + ms, 0);
    return { d, clock, bundle, sleptMs };
  }
  const running = () => detachedRunSnapshot(detached, 'running', null, null);

  it('waits in one recovery call for a still-running detached run, then settles it', async () => {
    const { d, clock, bundle } = await waitingRecovery((d) => {
      d.ledger.mockResolvedValue([{ id: 42, file_path: binding.testPath, status: 'pass',
        finished_at: '2026-09-09T00:00:00Z', execution_details: measured }]);
      d.runStatus.mockResolvedValueOnce(running()).mockResolvedValueOnce(running())
        .mockResolvedValueOnce(detachedRunSnapshot(detached, 'pass', 0));
    });

    expect(d.runStatus).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(bundle.recoveryWait).toMatchObject({ outcome: 'terminal', waitedMs: 4_000, limitMs: 30_000 });
    expect(bundle.recoveryWait).not.toHaveProperty('nextStep');
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42 });
  });

  it('uses only the remaining recovery budget for a file-level row published after a passing terminal snapshot', async () => {
    const lateRow = { id: 42, file_path: binding.testPath, status: 'pass' as const,
      finished_at: '2026-09-09T00:00:00Z', execution_details: measured };
    let detachedReads = 0;
    const { d, bundle, sleptMs } = await waitingRecovery((d) => {
      d.runStatus.mockResolvedValue(detachedRunSnapshot(detached, 'pass', 0));
      d.ledger.mockImplementation(async options => {
        if (options.runGroupId === detached && ++detachedReads > 1) return [lateRow];
        return [];
      });
    }, 1_000);

    expect(sleptMs).toBe(1_000);
    expect(bundle.recoveryWait).toMatchObject({ outcome: 'terminal', limitMs: 1_000,
      waitedMs: 1_000, ledgerWaitedMs: 1_000 });
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42 });
    expect(bundle.pendingRetirement).toMatchObject({ status: 'complete', retiredCount: 1 });
  });

  it('stops looking for a passing run ledger row at the remaining recovery bound', async () => {
    const { d, bundle, sleptMs } = await waitingRecovery((d) => {
      d.runStatus.mockResolvedValue(detachedRunSnapshot(detached, 'pass', 0));
    }, 1_000);

    expect(sleptMs).toBe(1_000);
    expect(bundle.recoveryWait).toMatchObject({ outcome: 'terminal', limitMs: 1_000,
      waitedMs: 1_000, ledgerWaitedMs: 1_000 });
    expect(bundle.rows[0]).toMatchObject({ phase: 'terminal-no-result', outcome: 'unknown', bindingStatus: 'not-bound' });
    expect(bundle.pendingRetirement).toMatchObject({ status: 'complete', retiredCount: 1 });
  });

  it('stops exactly at the wait bound and says to repeat recovery rather than poll run-status', async () => {
    const { d, bundle, sleptMs } = await waitingRecovery((d) => { d.runStatus.mockResolvedValue(running()); }, 5_000);

    // 2s + 2s + the 1s remainder: the last sleep is clamped so the wait never overshoots its bound.
    expect(sleptMs).toBe(5_000);
    expect(d.runStatus).toHaveBeenCalledTimes(4);
    expect(bundle.recoveryWait).toMatchObject({ outcome: 'still-running', waitedMs: 5_000, limitMs: 5_000 });
    expect(bundle.recoveryWait.nextStep).toMatch(/testing:run \{ recoverEvidence \} again/);
    expect(bundle.rows[0]).toMatchObject({ phase: 'pending', outcome: 'unknown' });
  });

  it('waits the default bound when the caller passes no waitMs', async () => {
    const { sleptMs, bundle } = await waitingRecovery((d) => { d.runStatus.mockResolvedValue(running()); });

    expect(sleptMs).toBe(30_000);
    expect(bundle.recoveryWait).toMatchObject({ outcome: 'still-running', limitMs: 30_000 });
  });

  it('does not wait on an unknown run or a failed snapshot read', async () => {
    const unknown = await waitingRecovery((d) => { d.runStatus.mockResolvedValue(null); });
    expect(unknown.clock.sleep).not.toHaveBeenCalled();
    expect(unknown.bundle.recoveryWait).toMatchObject({ outcome: 'not-found', waitedMs: 0 });

    const failed = await waitingRecovery((d) => { d.runStatus.mockRejectedValue(new Error('snapshot store down')); });
    expect(failed.clock.sleep).not.toHaveBeenCalled();
    expect(failed.bundle.recoveryWait).toMatchObject({ outcome: 'unavailable' });
    expect(failed.bundle.detachedRunStatus).toMatchObject({ status: 'unavailable' });
  });

  it('refuses a recovery wait above the ceiling', () => {
    const base = { workItemId: 'WI-1', originRunId: runId, runId: detached };
    expect(recoverTestEvidenceSchema.safeParse({ ...base, waitMs: RECOVERY_WAIT_CEILING_MS }).success).toBe(true);
    expect(recoverTestEvidenceSchema.safeParse({ ...base, waitMs: RECOVERY_WAIT_CEILING_MS + 1 }).success).toBe(false);
  });

  it('retires pending twins after a terminal run yielded a settled file-level result', async () => {
    const { d, bundle } = await pendingRecovery(measured, 'pass', false,
      detachedRunSnapshot(detached, 'fail', 143));

    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42 });
    expect(bundle.pendingRetirement).toMatchObject({ status: 'complete', retiredCount: 1, bindingIds: [2] });
    expect(d.retract.mock.calls.map(([options]) => options.bindingId)).toEqual([2]);
  });

  // EI-24100872054224181: a run refused before launch used to be FINISHED, which bound a second
  // pending row per binding that remeasure then skipped as run-in-flight.
  it('retracts only this attempt\'s pending rows when the run was refused before launch', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    const initial = d.bind.mock.calls[0]![0];
    const otherAttempt = { ...initial.details, testExecution: { ...initial.details.testExecution,
      runId: 'other-run', originRunId: 'other-run' } };
    const settled = { ...initial.details, testExecution: { ...initial.details.testExecution, phase: 'settled' } };
    d.list.mockResolvedValue([
      pendingEvidenceRow(1, initial.details), pendingEvidenceRow(2, otherAttempt), pendingEvidenceRow(3, settled),
    ]);

    const bundle = await retractRefusedTestEvidence(prepared, runId, scope, 'mutation_probe_active', d);

    expect(bundle).toMatchObject({ status: 'not-recorded', reason: 'mutation_probe_active', retiredCount: 1, bindingIds: [1] });
    expect(d.retract.mock.calls.map(([options]) => options.bindingId)).toEqual([1]);
    expect(d.retract.mock.calls[0]![0].reason).toContain('mutation_probe_active');
    expect(d.bind).toHaveBeenCalledTimes(1);
  });

  it('reports an incomplete retraction instead of claiming the refusal left nothing behind', async () => {
    const d = deps();
    const prepared = await prepareTestEvidence(request, runId, [binding.testPath], scope, d);
    d.list.mockResolvedValue([pendingEvidenceRow(1, d.bind.mock.calls[0]![0].details)]);
    d.retract.mockRejectedValueOnce(new Error('store unavailable'));

    const bundle = await retractRefusedTestEvidence(prepared, runId, scope, 'mutation_probe_active', d);

    expect(bundle).toMatchObject({ status: 'retirement-incomplete', retiredCount: 0,
      failures: [{ bindingId: 1, error: expect.stringContaining('store unavailable') }] });
  });

  it('settles a current reporter row with mutationPhase:null from complete measured details', async () => {
    const { bundle } = await pendingRecovery(measured);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42 });
    expect(bundle.verificationFingerprint).toBeTruthy();
  });
  // WI-10002465: the admin reporter writes JSON.stringify(details) through
  // postgres-js's multi-row helper, so the ledger column holds a jsonb STRING
  // scalar and the ledger read hands recovery a JS string — not the object the
  // other cases here feed it. Every detached run arrived in this shape and was
  // rejected as review-required, so no integration file past the foreground
  // cap could settle its spec evidence.
  it('settles a reporter row whose details are stored as the jsonb string encoding', async () => {
    const { bundle } = await pendingRecovery(JSON.stringify(measured));
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: 42 });
    expect(bundle.verificationFingerprint).toBeTruthy();
  });
  it.each([
    '{not json', '"just a string"', JSON.stringify([measured]),
    JSON.stringify({ ...measured, root: '/other' }), JSON.stringify({ ...measured, extra: true }),
  ])('keeps an undecodable or wrong-scope string encoding unproven: %s', async detail => {
    const { bundle } = await pendingRecovery(detail);
    expect(bundle.rows[0]).toMatchObject({ phase: 'review-required', outcome: 'unknown' });
    expect(bundle.verificationFingerprint).toBeNull();
  });
  it.each([
    ['selected proof', 'pass'],
    [null, 'skip'],
  ])('recovers JSON-ingested evidence with its actual name selector %j', async (testNamePattern, outcome) => {
    const rows = parseVitestJsonForHarnessRows(JSON.stringify({ testResults: [{
      name: `${scope.root}/${binding.testPath}`, status: 'passed',
      assertionResults: [{ status: 'passed' }, { status: 'pending' }],
    }] }), scope.root);
    let executionDetails: unknown;
    await persistHarnessTestRuns({
      root: scope.root, harnessSlug: scope.harnessSlug, workspaceId: scope.workspaceId,
      runGroupId: detached, rows, testNamePattern, commit: 'tested-sha', worktreeDirty: false,
      sql: async (strings, ...values) => {
        expect(strings.join(' ')).toContain('execution_details, configuration_snapshot');
        const configurationSnapshot = values.at(-1);
        const detailsParameter = values.at(-2);
        expect(configurationSnapshot).toBeNull();
        expect(detailsParameter).toBeTypeOf('object');
        executionDetails = detailsParameter;
        return [{ id: 42 }];
      },
    });
    const { bundle } = await pendingRecovery(executionDetails);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome, testRunId: 42 });
  });
  it.each([
    [{ skipped: 1 }, 'pass', 'skip'],
    [{ passed: 0, failed: 1 }, 'fail', 'fail'],
    [{ passed: 0, skipped: 1, collectionFailed: true }, 'fail', 'error'],
    [{ passed: 0 }, 'pass', 'unknown'],
  ])('preserves measured non-passing recovery %j', async (delta, status, outcome) => {
    const { bundle } = await pendingRecovery({ ...measured, ...delta }, status);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome });
  });
  it.each([
    null, {}, { ...measured, skipped: undefined }, { ...measured, passed: -1 },
    { ...measured, workspaceId: 'other' }, { ...measured, harnessSlug: 'other' },
    { ...measured, runGroupId: runId }, { ...measured, root: '/other' },
    { ...measured, filePath: 'other.test.ts' }, { ...measured, collectionFailed: true },
  ])('keeps missing, malformed, contradictory or wrong-scope details unproven: %j', async detail => {
    const { bundle } = await pendingRecovery(detail);
    expect(bundle.rows[0]).toMatchObject({ phase: 'review-required', outcome: 'unknown' });
    expect(bundle.verificationFingerprint).toBeNull();
  });
  it('does not make measured recovery source-current after a source edit', async () => {
    const { bundle } = await pendingRecovery(measured, 'pass', true);
    expect(bundle.rows[0].phase).toBe('source-changed');
    expect(bundle.verificationFingerprint).toBeNull();
  });
  it('retires pending predecessors after a source-changed failed recovery without proving currentness', async () => {
    const failed = { ...measured, passed: 0, failed: 1 };
    const { d, bundle } = await pendingRecovery(failed, 'fail', true);

    expect(bundle.rows[0]).toMatchObject({ phase: 'source-changed', outcome: 'fail', testRunId: 42 });
    expect(bundle.verificationFingerprint).toBeNull();
    expect(bundle.pendingRetirement).toMatchObject({ status: 'complete', retiredCount: 1, bindingIds: [2] });
    expect(d.retract.mock.calls.map(([options]) => options.bindingId)).toEqual([2]);
  });
});

/**
 * SPEC-P006-FAILED-SCENARIO-RERUN@1 — the stale-evidence full-coverage control.
 *
 *   behavior:  "A failed scenario rerun starts only the failed scenario when applicable
 *               evidence for the remaining matrix is still current."
 *   falsifier: "A recoverable single-scenario failure reruns the full matrix OR stale
 *               remaining evidence is reused."
 *   probe:     "Create one failed scenario with current sibling evidence, then repeat with
 *               a stale sibling fingerprint."
 *
 * The hazard is specific to a name-filtered rerun. `testNamePattern` narrows execution to
 * the ONE failed scenario, but the binding's proof covers every id in `scenarioIds`, and
 * vitest reports the unmatched siblings as `skipped`. `testEvidenceOutcome` deliberately
 * refuses to read those exclusions as a `skip` — correct, they are not evidence either way
 * — so the narrowed run settles `pass` for the WHOLE matrix having measured one member of
 * it. That carry is sound only while the evidence already recorded for the remaining
 * scenarios is still current. After a source or test edit it is the falsifier's second arm
 * verbatim: stale remaining evidence reused.
 *
 * Both arms below are the SAME call with ONE variable changed — the prior row's
 * fingerprint — which is what makes this a control rather than two separate assertions.
 */
describe('failed-scenario rerun scope (SPEC-P006-FAILED-SCENARIO-RERUN)', () => {
  const matrix = { ...binding, scenarioIds: ['boot', 'retry', 'teardown', 'recover'] };
  const matrixRequest = { ...request, bindings: [matrix] };

  /** The rerun of one failed scenario: 1 executed, the 3 siblings excluded by the filter. */
  const narrowed = (): TestFilesRunResult => ({ ...result(), passed: 1, failed: 0, skipped: 3,
    byFile: { [matrix.testPath]: { passed: 1, failed: 0, skipped: 3, collectionFailed: false } },
    testNamePattern: 'recover' });

  /** What a PRIOR full-matrix run left behind as evidence for the remaining scenarios. */
  const priorMatrixEvidence = (
    fingerprints: { sourceFingerprint: string; testFingerprint: string },
  ): ListedSpecEvidenceRow[] => ([{
    id: 7, workItemId: 'WI-1', planSlug: 'p1', specId: matrix.specId,
    sourceValId: null, specRevision: matrix.specRevision, currentRevision: matrix.specRevision,
    specFingerprint: 'matrix-spec-fingerprint',
    evidenceKind: 'test', evidenceRef: 'test-run-group:00000000-0000-4000-8000-00000000prio:0',
    testRunId: 41, testRunProvenance: null, coverageEvidenceRef: null,
    fingerprints: {
      ...fingerprints, fixtureFingerprint: null, rubricFingerprint: null, environmentFingerprint: null,
    },
    details: {
      testExecution: { schemaVersion: 1, phase: 'settled', binding: matrix },
      adequacy: { outcome: 'pass', executed: true, scenarioIds: matrix.scenarioIds },
    },
    observedAt: '2026-09-24T00:00:00.000Z', bindingFingerprint: 'matrix-binding',
    createdBy: 'su-test', createdAt: '2026-09-24T00:00:00.000Z',
    currentness: {
      overall: 'current',
      dimensions: {
        spec: 'current', source: 'current', test: 'current', fixture: 'not-applicable',
        rubric: 'not-applicable', environment: 'not-applicable',
        coverageEvidence: 'not-applicable', testRun: 'current',
      },
      staleReasons: [], unknownReasons: [], comparisonSupplied: true,
      provenance: 'server-measured',
    },
  }]);

  const CURRENT = { sourceFingerprint: 'source-before', testFingerprint: 'test-before' };
  const STALE_SOURCE = { sourceFingerprint: 'source-after-an-edit', testFingerprint: 'test-before' };

  async function rerun(prior: ListedSpecEvidenceRow[], run: TestFilesCoreResult = narrowed(),
    req: typeof matrixRequest = matrixRequest) {
    const d = deps();
    d.list.mockResolvedValue(prior);
    const prepared = await prepareTestEvidence(req, runId, [matrix.testPath], scope, d);
    return { d, bundle: await finishTestEvidence(prepared, runId, runId, scope, run, d) };
  }

  // ARM 1 — current sibling evidence. The narrowing is sound, so the binding settles.
  it('settles a narrowed rerun while the remaining matrix evidence is still current', async () => {
    const { d, bundle } = await rerun(priorMatrixEvidence(CURRENT));
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(bundle.verificationFingerprint).not.toBeNull();
    expect(d.bind.mock.calls.at(-1)![0].details.testExecution.rerunScope)
      .toMatchObject({ scope: 'failed-scenario', reason: 'sibling-evidence-current' });
  });

  // ARM 2 — the identical rerun with ONE variable changed: a stale sibling fingerprint.
  it('refuses to carry the remaining matrix from a stale sibling fingerprint', async () => {
    const { d, bundle } = await rerun(priorMatrixEvidence(STALE_SOURCE));
    expect(bundle.rows[0]).toMatchObject({ phase: 'stale-sibling-evidence', outcome: 'unknown' });
    expect(bundle.verificationFingerprint).toBeNull();
    const settled = d.bind.mock.calls.at(-1)![0];
    expect(settled.details.adequacy).toMatchObject({ outcome: 'unknown', executed: false });
    expect(settled.details.testExecution.rerunScope).toMatchObject({
      scope: 'full-matrix', reason: 'stale-sibling-evidence', stale: ['source'] });
  });

  // Absence is not currency. A matrix whose siblings were NEVER recorded has nothing to
  // carry, so a narrowed run over it measures strictly less than the binding claims.
  it('does not read absent sibling evidence as current', async () => {
    const { bundle } = await rerun([]);
    expect(bundle.rows[0]).toMatchObject({ phase: 'stale-sibling-evidence', outcome: 'unknown' });
    expect(bundle.verificationFingerprint).toBeNull();
  });

  // CALIBRATION. The guard must fire on the NARROWING, not on stale prior evidence alone.
  // An unfiltered run measures the whole matrix itself and therefore carries nothing, so it
  // must still settle against the same stale row. Without this, an implementation that
  // simply rejected any binding with a stale prior row would pass both arms above.
  it('still settles an UNFILTERED full-matrix run against the same stale prior row', async () => {
    const { bundle } = await rerun(priorMatrixEvidence(STALE_SOURCE), { ...result(), skipped: 0 });
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(bundle.verificationFingerprint).not.toBeNull();
  });

  // CALIBRATION. A single-scenario binding has no remaining matrix, so a narrowed run over
  // it is not this hazard — guarding it would block the ordinary one-test rerun R-8 exists
  // to make cheap.
  it('leaves a single-scenario binding alone under the same stale prior row', async () => {
    const { bundle } = await rerun(priorMatrixEvidence(STALE_SOURCE), narrowed(), request);
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
  });
});
