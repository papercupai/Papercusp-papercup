/**
 * P-018 / P-011 (review-system-rework-reduction-2026-09-23): `testing:run { remeasureEvidence }`
 * re-runs ONLY the test proofs whose measured source/test files moved, from the recipes the
 * bindings already persisted, and withdraws a replaced stale row only after its fresh run
 * PASSES. Nothing here weakens a check: a clause whose meaning moved is never re-measured, and
 * a failed re-run keeps its predecessors so the clause stays honestly red.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildTestEvidenceRemeasure,
  planTestEvidenceRemeasure,
  remeasureJudgmentLossWarning,
  retireRemeasuredPredecessors,
  PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS,
} from './evidence';

type Currentness = {
  overall: 'current' | 'stale' | 'unknown';
  dimensions: Record<string, string>;
  staleReasons: string[];
  unknownReasons: string[];
};

const recipe = (specId: string, testPath: string, sourceGlobs?: string[]) => ({
  specId, specRevision: 3, testPath, sourcePaths: ['src/subject.ts'],
  ...(sourceGlobs ? { sourceGlobs } : {}), testLayer: 'unit' as const,
});

function row(id: number, opts: {
  specId?: string; testPath?: string; kind?: string; phase?: string; revision?: number;
  currentness?: Partial<Currentness>; moved?: unknown; outcome?: string; evidenceRef?: string;
  adequacy?: Record<string, unknown>;
  sourceGlobs?: string[];
  /** Bound by hand (plans:bind-spec-evidence): no stored recipe, only the measured paths. */
  handBound?: boolean;
  runId?: string;
  originRunId?: string;
  observedAt?: string;
  framework?: string;
}) {
  const specId = opts.specId ?? 'S-1';
  const testPath = opts.testPath ?? 'src/subject.test.ts';
  const currentness: Currentness = {
    overall: 'current', dimensions: { spec: 'current', source: 'current', test: 'current' },
    staleReasons: [], unknownReasons: [], ...opts.currentness,
  };
  const handBound = opts.handBound ?? opts.kind === 'mutation';
  return {
    id, specId, specRevision: opts.revision ?? 3, evidenceKind: opts.kind ?? 'test',
    evidenceRef: opts.evidenceRef ?? (
      handBound
        ? opts.kind === 'mutation' ? `mutation-probe:${testPath}:${id}` : testPath
        : `test-run-group:old:${id}`
    ),
    details: {
      ...(handBound
        ? { currentMeasurement: { schemaVersion: 1, kind: 'repo-files', testPaths: [testPath], sourcePaths: ['src/subject.ts'],
            ...(opts.sourceGlobs ? { sourceGlobs: opts.sourceGlobs } : {}) } }
        : { testExecution: { phase: opts.phase ?? 'settled',
            ...(opts.runId ? { runId: opts.runId } : {}),
            ...(opts.originRunId ? { originRunId: opts.originRunId } : {}),
            binding: recipe(specId, testPath, opts.sourceGlobs) } }),
      adequacy: { outcome: opts.outcome ?? 'pass', ...(handBound ? { testLayer: 'unit' } : {}), ...opts.adequacy },
    },
    testRunId: null,
    ...(opts.framework ? { testRunProvenance: { framework: opts.framework } } : {}),
    observedAt: opts.observedAt ?? '2026-10-06T00:00:00.000Z',
    currentness,
    ...(opts.moved ? { serverMeasurement: { status: 'measured', movedPaths: opts.moved } } : {}),
  } as never;
}

const sourceStale = { overall: 'stale' as const, dimensions: { spec: 'current', source: 'stale' }, staleReasons: ['source-stale'] };

describe('planTestEvidenceRemeasure', () => {
  it.each(['error', 'fail'])('re-selects a current settled %s binding that shadows a stale proof', (outcome) => {
    const plan = planTestEvidenceRemeasure([
      row(15972, { currentness: sourceStale }),
      row(16218, { outcome }),
      row(15969, { specId: 'S-2' }),
    ]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0]).toMatchObject({
      bindingId: 16218, binding: recipe('S-1', 'src/subject.test.ts'),
      staleReasons: [], supersedes: [15972, 16218],
    });
    expect(plan.skipped).toEqual([
      { specId: 'S-2', testPath: 'src/subject.test.ts', bindingId: 15969, reason: 'current' },
    ]);
  });

  it('recovers an exact hand-bound test recipe without replaying the old outcome or adequacy claims', () => {
    const plan = planTestEvidenceRemeasure([
      row(12, {
        handBound: true,
        currentness: sourceStale,
        adequacy: { falsifiable: true, pathReachable: true, oracleIndependent: true },
      }),
    ]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0]).toMatchObject({
      specId: 'S-1',
      testPath: 'src/subject.test.ts',
      bindingId: 12,
      staleReasons: ['source-stale'],
      binding: recipe('S-1', 'src/subject.test.ts'),
      supersedes: [12],
    });
    expect(plan.selected[0]!.binding).not.toHaveProperty('falsifiable');
    expect(plan.skipped).toEqual([]);
  });

  it('preserves source globs from a hand-bound measurement when recovering its retrospective recipe', () => {
    const sourceGlobs = ['dynamic/plugins/*/papercusp.json'];
    const plan = planTestEvidenceRemeasure([
      row(13, { handBound: true, currentness: sourceStale, sourceGlobs }),
    ]);

    expect(plan.selected).toMatchObject([{
      binding: recipe('S-1', 'src/subject.test.ts', sourceGlobs),
      supersedes: [13],
    }]);
    expect(plan.skipped).toEqual([]);
  });

  it('selects only the latest stale-by-drift binding per (clause, test file) and lists every live predecessor', () => {
    const moved = [{ path: 'src/subject.ts', dimension: 'source', change: 'changed' }];
    const plan = planTestEvidenceRemeasure([
      row(10, { currentness: sourceStale, moved }),
      row(9, { phase: 'pending', currentness: sourceStale }),
      row(11, { specId: 'S-2', testPath: 'src/other.test.ts' }),
    ]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0]).toMatchObject({
      specId: 'S-1', testPath: 'src/subject.test.ts', bindingId: 10, staleReasons: ['source-stale'],
      movedPaths: moved, supersedes: [9, 10], binding: recipe('S-1', 'src/subject.test.ts'),
    });
    expect(plan.skipped).toEqual([{ specId: 'S-2', testPath: 'src/other.test.ts', bindingId: 11, reason: 'current' }]);
  });

  it('re-runs a saved recipe when an edited path matches only its source glob', async () => {
    const sourceGlobs = ['dynamic/plugins/*/papercusp.json'];
    const moved = [{ path: 'dynamic/plugins/linear-sync/papercusp.json', dimension: 'source', change: 'changed' }];
    const built = await buildTestEvidenceRemeasure(
      { workItemId: 'WI-1', planSlug: 'p' },
      { harnessSlug: 'h' },
      { list: vi.fn().mockResolvedValue([row(14, { currentness: sourceStale, moved, sourceGlobs })]) },
    );

    expect(built.plan.selected).toMatchObject([{
      movedPaths: moved,
      binding: recipe('S-1', 'src/subject.test.ts', sourceGlobs),
    }]);
    expect(built.request).toEqual({
      workItemId: 'WI-1',
      planSlug: 'p',
      bindings: [recipe('S-1', 'src/subject.test.ts', sourceGlobs)],
    });
    expect(built.files).toEqual(['src/subject.test.ts']);
  });

  it('never re-measures a clause whose MEANING moved, an in-flight run, or an unmeasurable row', () => {
    const plan = planTestEvidenceRemeasure([
      row(1, { specId: 'S-1', currentness: { overall: 'stale', dimensions: { spec: 'stale' }, staleReasons: ['spec-stale', 'source-stale'] } }),
      row(2, { specId: 'S-2', phase: 'pending', currentness: sourceStale }),
      row(3, { specId: 'S-3', currentness: { overall: 'unknown', dimensions: { spec: 'current' }, unknownReasons: ['server-measurement-unavailable:gone'] } }),
      row(4, { specId: 'S-4', currentness: { overall: 'stale', dimensions: { spec: 'current', coverage: 'stale' }, staleReasons: ['coverage-stale'] } }),
    ]);
    expect(plan.selected).toEqual([]);
    expect(plan.skipped.map((entry) => `${entry.specId}:${entry.reason}`)).toEqual([
      'S-1:clause-moved', 'S-2:run-in-flight', 'S-3:unmeasurable', 'S-4:not-remeasurable',
    ]);
  });

  it('re-measures an abandoned pending proof even when its file fingerprints are current', () => {
    const plan = planTestEvidenceRemeasure([row(12, { phase: 'pending' })], new Set([12]));

    expect(plan.selected).toMatchObject([{ bindingId: 12, staleReasons: [], abandonedPending: true,
      supersedes: [12], binding: recipe('S-1', 'src/subject.test.ts') }]);
    expect(plan.skipped).toEqual([]);
  });

  it('ignores counterexample proofs, which assert a failure against a deliberately broken subject', () => {
    expect(planTestEvidenceRemeasure([row(1, { kind: 'counterexample', currentness: sourceStale })]))
      .toEqual({ selected: [], skipped: [] });
  });

  it('reports a stale proof it cannot re-run instead of dropping it silently', () => {
    // Measured 2026-09-23 on WI-10002643: the pass answered examined 1 / selected 0 /
    // skipped [] while the completion gate failed freshness on exactly these bindings.
    const plan = planTestEvidenceRemeasure([
      row(10363, { specId: 'S-B', handBound: true, evidenceRef: 'opaque:manual-proof', currentness: sourceStale }),
      row(10554, { specId: 'S-B', kind: 'mutation', currentness: sourceStale }),
      row(10435, { specId: 'S-B', kind: 'mutation', currentness: sourceStale }),
      row(7, { specId: 'S-C', kind: 'mutation' }),
    ]);
    expect(plan.selected).toEqual([]);
    expect(plan.skipped.map((entry) => `${entry.specId}:${entry.bindingId}:${entry.reason}:${entry.testPath}`)).toEqual([
      'S-B:10554:probe-required:src/subject.test.ts',
      'S-B:10363:no-recipe:src/subject.test.ts',
      'S-C:7:current:src/subject.test.ts',
    ]);
    expect(plan.skipped.find((entry) => entry.bindingId === 10363)!.detail).toMatch(/^source-stale: .*testing:run \{ evidence \}/);
    expect(plan.skipped.find((entry) => entry.bindingId === 10554)!.detail).toMatch(/^source-stale: .*scripts\/mutation-probe\.sh/);
    expect(plan.skipped.find((entry) => entry.bindingId === 10554)!.detail).toContain("source='mutation-probe'");
    expect(plan.skipped.find((entry) => entry.bindingId === 10554)!.detail).toContain('test-only route cannot reproduce a mutant');
  });

  it('lets a newer recipe-bearing proof supersede a hand-bound one for the same clause and file', () => {
    const plan = planTestEvidenceRemeasure([
      row(1, { handBound: true, currentness: sourceStale }),
      row(2, { currentness: sourceStale }),
    ]);
    expect(plan.selected.map((entry) => entry.bindingId)).toEqual([2]);
    expect(plan.skipped).toEqual([]);
  });

  it('treats a run whose sources moved WHILE it ran as the same drift', () => {
    const plan = planTestEvidenceRemeasure([row(1, { phase: 'source-changed', currentness: sourceStale })]);
    expect(plan.selected.map((entry) => entry.bindingId)).toEqual([1]);
  });

  it('caps one request at 20 bindings and reports the overflow instead of dropping it', () => {
    const rows = Array.from({ length: 23 }, (_, index) =>
      row(index + 1, { specId: `S-${String(index).padStart(2, '0')}`, currentness: sourceStale }));
    const plan = planTestEvidenceRemeasure(rows);
    expect(plan.selected).toHaveLength(20);
    expect(plan.skipped.filter((entry) => entry.reason === 'cap')).toHaveLength(3);
  });
});

describe('buildTestEvidenceRemeasure', () => {
  it.each([true, false])('keeps non-Vitest proofs out of a mixed remeasure batch (hand-bound: %s)', async (handBound) => {
    const browserPath = 'apps/operator/e2e/cloud-tutorial.spec.ts';
    const list = vi.fn().mockResolvedValue([
      row(1, { handBound, testPath: browserPath, currentness: sourceStale, framework: 'playwright' }),
      // A retry without a ledger result must retain the last measured runner.
      row(2, { testPath: browserPath, currentness: sourceStale, outcome: 'error' }),
      row(3, { specId: 'S-2', currentness: sourceStale, framework: 'vitest' }),
    ]);
    const built = await buildTestEvidenceRemeasure(
      { workItemId: 'WI-1', planSlug: 'p' }, { harnessSlug: 'h' }, { list },
    );

    expect(built.files).toEqual(['src/subject.test.ts']);
    expect(built.request?.bindings).toEqual([recipe('S-2', 'src/subject.test.ts')]);
    expect(built.plan.skipped).toEqual([expect.objectContaining({
      specId: 'S-1', testPath: browserPath, bindingId: 2, reason: 'unsupported-runner',
      detail: expect.stringMatching(/playwright.*re-bind/),
    })]);
  });

  it('uses the latest measured framework when a proof migrated to Vitest', async () => {
    const list = vi.fn().mockResolvedValue([
      row(1, { currentness: sourceStale, framework: 'playwright' }),
      row(2, { currentness: sourceStale, framework: 'vitest' }),
    ]);
    const built = await buildTestEvidenceRemeasure(
      { workItemId: 'WI-1', planSlug: 'p' }, { harnessSlug: 'h' }, { list },
    );

    expect(built.files).toEqual(['src/subject.test.ts']);
    expect(built.plan.skipped).toEqual([]);
  });

  it('starts nothing when no proof is stale by drift', async () => {
    const list = vi.fn().mockResolvedValue([row(1, {})]);
    const built = await buildTestEvidenceRemeasure({ workItemId: 'WI-1', planSlug: 'p' }, { harnessSlug: 'h' }, { list });
    expect(built.request).toBeNull();
    expect(built.files).toEqual([]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ planSlugs: ['p'], workItemIds: ['WI-1'], evidenceKinds: ['test', 'mutation'] }));
  });

  it('turns stale bindings into an ordinary evidence request over the exact test files', async () => {
    const list = vi.fn().mockResolvedValue([row(1, { currentness: sourceStale })]);
    const built = await buildTestEvidenceRemeasure({ workItemId: 'WI-1', planSlug: 'p' }, { harnessSlug: 'h' }, { list });
    expect(built.request).toEqual({ workItemId: 'WI-1', planSlug: 'p', bindings: [recipe('S-1', 'src/subject.test.ts')] });
    expect(built.files).toEqual(['src/subject.test.ts']);
  });

  it('names the checkout each selected proof was measured in, null for the session root (EI-25203154942838341)', async () => {
    // A proof measured in a hive app's own repo must be re-run THERE: re-measuring it at the
    // session harness root is what made phone-app bindings permanently unmeasurable (ENOENT).
    const inHive = row(1, { handBound: true, currentness: sourceStale, specId: 'S-1',
      testPath: 'packages/data/src/usage.test.ts' }) as { details: { currentMeasurement: Record<string, unknown> } };
    inHive.details.currentMeasurement.rootHarnessSlug = 'phone-app';
    const inSession = row(2, { handBound: true, currentness: sourceStale, specId: 'S-2', testPath: 'src/other.test.ts' });
    const viaRecipe = row(3, { currentness: sourceStale, specId: 'S-3', testPath: 'src/third.test.ts' });
    const build = (rows: unknown[]) => buildTestEvidenceRemeasure({ workItemId: 'WI-1', planSlug: 'p' },
      { harnessSlug: 'h' }, { list: vi.fn().mockResolvedValue(rows) });

    expect((await build([inHive])).rootHarnessSlugs).toEqual(['phone-app']);
    // Unstamped measurements and recipe-only rows were measured at the session root.
    expect((await build([inSession, viaRecipe])).rootHarnessSlugs).toEqual([null]);
    const mixed = await build([inHive, inSession]);
    expect(mixed.plan.selected).toHaveLength(2);
    expect(mixed.rootHarnessSlugs).toHaveLength(2);
    expect(mixed.rootHarnessSlugs).toEqual(expect.arrayContaining(['phone-app', null]));
  });

  it('treats an old pending binding as abandoned only when its run and exact file ledger are absent', async () => {
    const now = Date.parse('2026-10-06T00:00:00.000Z');
    const oldRun = 'f04cdb70-ad2d-4757-9ff0-3a3d9f4440ad';
    const list = vi.fn().mockResolvedValue([row(12, {
      phase: 'pending', currentness: sourceStale, runId: oldRun, originRunId: oldRun,
      observedAt: new Date(now - PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS - 1).toISOString(),
    })]);
    const runStatus = vi.fn().mockResolvedValue(null);
    const ledger = vi.fn().mockResolvedValue([]);

    const built = await buildTestEvidenceRemeasure({ workItemId: 'WI-1', planSlug: 'p' },
      { harnessSlug: 'h', workspaceId: 'ws', root: '/repo' }, { list, runStatus, ledger, now: () => now });

    expect(built.abandonedPendingBindingIds).toEqual([12]);
    expect(built.request?.bindings).toEqual([recipe('S-1', 'src/subject.test.ts')]);
    expect(built.plan.selected[0]).toMatchObject({ bindingId: 12, abandonedPending: true });
    expect(runStatus).toHaveBeenCalledExactlyOnceWith(oldRun, undefined,
      { workspaceId: 'ws', harnessSlug: 'h', root: '/repo' });
    expect(ledger).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws', harnessSlug: 'h',
      runGroupId: oldRun, filePaths: ['src/subject.test.ts'] });
  });

  it.each(['inside grace', 'a live run snapshot', 'an existing file ledger row', 'an unreadable file ledger'])
    ('keeps pending evidence in flight when it is %s', async reason => {
      const now = Date.parse('2026-10-06T00:00:00.000Z');
      const oldRun = 'f04cdb70-ad2d-4757-9ff0-3a3d9f4440ad';
      const pending = row(12, {
        phase: 'pending', currentness: sourceStale, runId: oldRun, originRunId: oldRun,
        // row() returns `never`, so the age is chosen here rather than assigned afterwards.
        observedAt: new Date(reason === 'inside grace'
          ? now - 1_000
          : now - PENDING_TEST_EVIDENCE_ABANDONMENT_GRACE_MS - 1).toISOString(),
      });
      const list = vi.fn().mockResolvedValue([pending]);
      const runStatus = vi.fn().mockResolvedValue(reason === 'a live run snapshot'
        ? { runId: oldRun, status: 'running', startedAt: now - 10_000, finishedAt: null } as never
        : null);
      const ledger = vi.fn().mockResolvedValue(reason === 'an existing file ledger row'
        ? [{ id: 77, file_path: 'src/subject.test.ts' }] as never
        : reason === 'an unreadable file ledger' ? null : []);

      const built = await buildTestEvidenceRemeasure({ workItemId: 'WI-1', planSlug: 'p' },
        { harnessSlug: 'h', workspaceId: 'ws', root: '/repo' }, { list, runStatus, ledger, now: () => now });

      expect(built.abandonedPendingBindingIds).toEqual([]);
      expect(built.request).toBeNull();
      expect(built.plan.skipped).toEqual([{ specId: 'S-1', testPath: 'src/subject.test.ts',
        bindingId: 12, reason: 'run-in-flight' }]);
      if (reason === 'inside grace') expect(runStatus).not.toHaveBeenCalled();
      else expect(runStatus).toHaveBeenCalledOnce();
    });

  it('builds a fresh test request from a hand-bound row without carrying forward its old pass or quality claims', async () => {
    const list = vi.fn().mockResolvedValue([
      row(1, {
        handBound: true,
        currentness: sourceStale,
        adequacy: { falsifiable: true, fixtureCalibrated: true, pathReachable: true, oracleIndependent: true },
      }),
    ]);
    const built = await buildTestEvidenceRemeasure(
      { workItemId: 'WI-1', planSlug: 'p' },
      { harnessSlug: 'h' },
      { list },
    );

    expect(built.request).toEqual({
      workItemId: 'WI-1',
      planSlug: 'p',
      bindings: [recipe('S-1', 'src/subject.test.ts')],
    });
    expect(built.files).toEqual(['src/subject.test.ts']);
    expect(JSON.stringify(built.request)).not.toMatch(/outcome|falsifiable|fixtureCalibrated|pathReachable|oracleIndependent/);
  });
});

describe('retireRemeasuredPredecessors', () => {
  const scope = { workspaceId: 'ws', harnessSlug: 'h', actorId: 'su-x', root: '/r' };
  const prepared = [{ input: { planSlug: 'p', workItemId: 'WI-1', evidenceRef: 'test-run-group:new:0' } }] as never;
  const selected = planTestEvidenceRemeasure([row(10, { currentness: sourceStale }), row(9, { currentness: sourceStale })]).selected;

  it('retracts exactly the replaced predecessors once the fresh run is a current pass', async () => {
    const list = vi.fn().mockResolvedValue([row(20, { evidenceRef: 'test-run-group:new:0' })]);
    const retract = vi.fn().mockResolvedValue({ status: 'retracted' });
    const outcome = await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract.mock.calls.map(([call]) => call.bindingId)).toEqual([9, 10]);
    expect(retract.mock.calls[0]![0].reason).toContain('superseded by re-measured binding 20');
    expect(outcome).toEqual([{ specId: 'S-1', testPath: 'src/subject.test.ts', replacementId: 20, retired: [9, 10] }]);
  });

  it('keeps every predecessor when the fresh run failed, so the clause stays honestly red', async () => {
    const list = vi.fn().mockResolvedValue([row(20, { evidenceRef: 'test-run-group:new:0', outcome: 'fail' })]);
    const retract = vi.fn();
    const outcome = await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract).not.toHaveBeenCalled();
    expect(outcome[0]).toMatchObject({ retired: [], kept: [9, 10] });
  });

  it('keeps every predecessor when the fresh proof is itself already stale', async () => {
    const list = vi.fn().mockResolvedValue([row(20, { evidenceRef: 'test-run-group:new:0', currentness: sourceStale })]);
    const retract = vi.fn();
    await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract).not.toHaveBeenCalled();
  });
});

describe('re-measure never retires a clean-tree proof for a dirty-tree run (WI-10005451)', () => {
  // Measured 2026-10-02 on WI-10001893: remeasure ran in the shared tree (test_run worktree_dirty=true)
  // and retracted bindings whose run came from a lint:as-committed clone (worktree_dirty=false); the
  // acceptance BAR rejects dirty runs, so the one-call repair downgraded an accepted proof.
  const scope = { workspaceId: 'ws', harnessSlug: 'h', actorId: 'su-x', root: '/r' };
  const prepared = [{ input: { planSlug: 'p', workItemId: 'WI-1', evidenceRef: 'test-run-group:new:0' } }] as never;
  const withRun = (bound: unknown, worktreeDirty: boolean | null) =>
    ({ ...(bound as object), testRunProvenance: { filePath: 'src/subject.test.ts', commitSha: 'abc', worktreeDirty } }) as never;
  const selected = planTestEvidenceRemeasure([
    withRun(row(10, { currentness: sourceStale }), false),
    withRun(row(9, { currentness: sourceStale }), true),
  ]).selected;

  it('records which superseded rows were measured on a clean tree', () => {
    expect(selected[0]).toMatchObject({ supersedes: [9, 10], cleanBindingIds: [10] });
    expect(planTestEvidenceRemeasure([row(10, { currentness: sourceStale })]).selected[0]).not.toHaveProperty('cleanBindingIds');
  });

  it.each([true, null])('keeps the clean proof when the fresh run worktreeDirty=%s, and retires only the dirty one', async (dirty) => {
    const list = vi.fn().mockResolvedValue([withRun(row(20, { evidenceRef: 'test-run-group:new:0' }), dirty)]);
    const retract = vi.fn().mockResolvedValue({ status: 'retracted' });
    const outcome = await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract.mock.calls.map(([call]) => call.bindingId)).toEqual([9]);
    expect(outcome[0]).toMatchObject({ replacementId: 20, retired: [9], cleanProofKept: { bindingIds: [10] } });
    expect((outcome[0] as { cleanProofKept: { repair: string } }).cleanProofKept.repair).toContain('lint:as-committed');
  });

  it('lets a known-clean fresh run retire a clean predecessor', async () => {
    const list = vi.fn().mockResolvedValue([withRun(row(20, { evidenceRef: 'test-run-group:new:0' }), false)]);
    const retract = vi.fn().mockResolvedValue({ status: 'retracted' });
    const outcome = await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract.mock.calls.map(([call]) => call.bindingId)).toEqual([9, 10]);
    expect(outcome[0]).not.toHaveProperty('cleanProofKept');
  });
});

describe('re-measure names the reviewer judgment it cannot carry (WI-10004452)', () => {
  // Observed 2026-09-30 on plan jev-performance-improvements-2026-09-30: remeasure retired
  // hand-bound binding 17183 (adequacy.pathReachable/oracleIndependent/falsifiable plus
  // details.pathReachability and details.observations) for a thin replacement, and the BAR
  // moved from pass to unknown on correct-layer + oracle-independence with no word in the
  // response. The recipe still must NOT replay the judgment; the retirement must SAY it dropped it.
  const scope = { workspaceId: 'ws', harnessSlug: 'h', actorId: 'su-x', root: '/r' };
  const prepared = [{ input: { planSlug: 'p', workItemId: 'WI-1', evidenceRef: 'test-run-group:new:0' } }] as never;
  const judged = (id: number) => {
    const bound = row(id, {
      handBound: true, currentness: sourceStale,
      adequacy: { falsifiable: true, pathReachable: true, oracleIndependent: true },
    }) as unknown as { details: Record<string, unknown> };
    bound.details.pathReachability = 'drives createJevConflictJudge through checkConflicts';
    bound.details.observations = 'expected labels are hand-written, not derived from the judge';
    return bound as never;
  };

  it('records which judgment fields the superseded rows carried, without putting them in the recipe', () => {
    const [entry] = planTestEvidenceRemeasure([judged(17183)]).selected;
    expect(entry!.judgment).toEqual({
      fields: ['adequacy.falsifiable', 'adequacy.oracleIndependent', 'adequacy.pathReachable', 'observations', 'pathReachability'],
      bindingIds: [17183],
    });
    expect(JSON.stringify(entry!.binding)).not.toMatch(/falsifiable|pathReachable|oracleIndependent|observations/);
  });

  it('reports the judgment a thin replacement lacks when it retires the richer predecessor, and warns at the top', async () => {
    const selected = planTestEvidenceRemeasure([judged(17183)]).selected;
    const list = vi.fn().mockResolvedValue([row(17303, { evidenceRef: 'test-run-group:new:0' })]);
    const retract = vi.fn().mockResolvedValue({ status: 'retracted' });
    const outcome = await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract });
    expect(retract.mock.calls.map(([call]) => call.bindingId)).toEqual([17183]);
    expect(outcome[0]).toMatchObject({
      replacementId: 17303, retired: [17183],
      judgmentNotCarried: {
        fields: ['adequacy.falsifiable', 'adequacy.oracleIndependent', 'adequacy.pathReachable', 'observations', 'pathReachability'],
        fromBindingIds: [17183],
      },
    });
    const warning = remeasureJudgmentLossWarning(outcome);
    expect(warning).toContain('S-1');
    expect(warning).toContain('17183');
    expect(warning).toContain('plans:bind-spec-evidence');
  });

  it('says nothing when the predecessor carried no judgment, or the replacement carries it all', async () => {
    const plain = planTestEvidenceRemeasure([row(10, { handBound: true, currentness: sourceStale })]).selected;
    expect(plain[0]!.judgment).toBeUndefined();
    const retract = vi.fn().mockResolvedValue({ status: 'retracted' });
    const thin = vi.fn().mockResolvedValue([row(20, { evidenceRef: 'test-run-group:new:0' })]);
    const quiet = await retireRemeasuredPredecessors(plain, prepared, 'new', scope, { list: thin, retract });
    expect(quiet[0]).not.toHaveProperty('judgmentNotCarried');
    expect(remeasureJudgmentLossWarning(quiet)).toBeNull();

    // A fresh, current, passing replacement that was re-bound WITH the same judgment.
    const rich = row(21, {
      evidenceRef: 'test-run-group:new:0',
      adequacy: { falsifiable: true, pathReachable: true, oracleIndependent: true },
    }) as unknown as { details: Record<string, unknown> };
    rich.details.pathReachability = 're-verified';
    rich.details.observations = 're-verified';
    const carried = await retireRemeasuredPredecessors(
      planTestEvidenceRemeasure([judged(17183)]).selected, prepared, 'new', scope,
      { list: vi.fn().mockResolvedValue([rich]), retract });
    expect(carried[0]).toMatchObject({ replacementId: 21, retired: [17183] });
    expect(carried[0]).not.toHaveProperty('judgmentNotCarried');
  });

  it('keeps silent about judgment when the fresh run did not pass, because nothing was retired', async () => {
    const selected = planTestEvidenceRemeasure([judged(17183)]).selected;
    const list = vi.fn().mockResolvedValue([row(17303, { evidenceRef: 'test-run-group:new:0', outcome: 'fail' })]);
    const outcome = await retireRemeasuredPredecessors(selected, prepared, 'new', scope, { list, retract: vi.fn() });
    expect(outcome[0]).toMatchObject({ retired: [], kept: [17183] });
    expect(remeasureJudgmentLossWarning(outcome)).toBeNull();
  });
});
