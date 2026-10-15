import { describe, expect, it, vi } from 'vitest';
import type { BulkRunRow } from '../attention/bulk-run-store';
import type { BulkAutomationPolicy } from '../attention/bulk-dispositions';
import { DEFAULT_ENLIST_PLAN_LIMIT, type CleanupFinding } from './scanner';
import type { CleanupRunFindingRow } from './run-store';
import { runDeterministicPlanCleanup } from './deterministic-runner';

function run(seedRefs: string[] = ['plan-a'], automationPolicy?: BulkAutomationPolicy): BulkRunRow {
  return {
    runId: 'run-1',
    workspaceId: 'workspace-1',
    harnessSlug: 'papercusp',
    requestedBy: 'owner',
    resolverOwner: null,
    phase: 'pending',
    runKind: 'plan-cleanup',
    seedRefs,
    filterSnapshot: {},
    launchSnapshot: {},
    automationPolicy,
    totalItems: 1,
    autoResolved: 0,
    recommended: 0,
    skipped: 0,
    failed: 0,
    error: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    heartbeatAt: null,
  };
}

function finding(
  kind: CleanupFinding['kind'],
  autoApply: boolean,
  planSlug = 'plan-a',
): CleanupFinding {
  const itemId = kind === 'finish-plan' || kind === 'stale-now' || kind === 'enlist-plan'
    ? null
    : 'P-001';
  const value: CleanupFinding = {
    findingId: `${kind}:papercusp/${planSlug}${itemId ? `#${itemId}` : ''}`,
    kind,
    workspaceId: 'workspace-1',
    harnessSlug: 'papercusp',
    planSlug,
    itemId,
    target: itemId ?? 'plan-a',
    from: 'todo',
    to: kind === 'finish-plan' ? 'shipped' : 'done',
    confidence: autoApply ? 'provable' : 'recommended',
    autoApply,
    autoApplyBlockedBy: autoApply ? null : 'judgment-call',
    evidence: [{ kind: 'plan', ref: planSlug, note: 'fixture proof' }],
  };
  if (kind === 'enlist-plan') {
    value.action = {
      kind: 'enlist-plan',
      goalId: 'goal-everything',
      planRef: `plan:papercusp/${planSlug}`,
      worklist: [],
      expectedVersion: 0,
    };
  }
  return value;
}

function rowOf(value: CleanupFinding): CleanupRunFindingRow {
  return {
    workspaceId: 'workspace-1',
    runId: 'run-1',
    findingId: value.findingId,
    kind: value.kind,
    planSlug: value.planSlug,
    harnessSlug: value.harnessSlug,
    itemId: value.itemId,
    target: value.target,
    from: value.from,
    to: value.to,
    confidence: value.confidence,
    evidence: value.evidence,
    position: 0,
    outcome: 'pending',
    error: null,
    decidedAt: null,
  };
}

function storeHarness(rows: CleanupRunFindingRow[]) {
  return {
    seed: vi.fn(async ({ findings }: { findings: readonly CleanupFinding[] }) => {
      for (const value of findings) {
        if (!rows.some((row) => row.findingId === value.findingId)) rows.push(rowOf(value));
      }
      return { findings: rows, refused: null };
    }),
    read: vi.fn(async () => rows),
    execute: vi.fn(async (input: { findingId: string; execute: (row: CleanupRunFindingRow) => Promise<unknown> }) => {
      const row = rows.find((candidate) => candidate.findingId === input.findingId)!;
      const actionResult = await input.execute(row);
      row.outcome = 'auto_applied';
      return { actionResult, finding: row, run: run(), refused: null };
    }),
    report: vi.fn(async ({ reports }: { reports: Array<{ findingId: string; outcome: CleanupRunFindingRow['outcome']; error?: string }> }) => {
      for (const report of reports) {
        const row = rows.find((candidate) => candidate.findingId === report.findingId)!;
        row.outcome = report.outcome;
        row.error = report.error ?? null;
      }
      return { updated: rows, missing: [], run: run(), refused: null };
    }),
  };
}

describe('runDeterministicPlanCleanup', () => {
  it('settles carried review decisions without launching another resolver and preserves policy revalidation', async () => {
    const candidate = finding('archive-candidate', false);
    const carried = { ...rowOf(candidate), outcome: 'recommended' as const };
    const seed = vi.fn(async (_input: unknown) => ({ findings: [carried], refused: null }));
    const result = await runDeterministicPlanCleanup({ run: run(), call: vi.fn(), deps: {
      scanRun: vi.fn(async () => [candidate]), seed, read: vi.fn(async () => [carried]),
      settle: vi.fn(async () => ({ ...run(), phase: 'review' as const })), notify: vi.fn(async () => undefined),
    } });
    expect(result).toMatchObject({ needsResolver: false, phase: 'review', applied: 0 });
    expect(seed.mock.calls[0]?.[0]).toMatchObject({ reconcile: { carryReviewFindingIds: [candidate.findingId] } });
  });

  it('automatically applies an archive recommendation and observes the changed plan', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    const archive = finding('archive-candidate', false);
    archive.confidence = 'recommended';
    let archived = false;
    const cleanupRun = run();
    cleanupRun.automationPolicy = {
      mode: 'safe-high', level: 'L2', minConfidence: 'medium',
      riskLevels: { low: 'automatic', medium: 'automatic', high: 'automatic' },
    };
    const result = await runDeterministicPlanCleanup({
      run: cleanupRun, call: vi.fn(), deps: {
        ...store, scanRun: vi.fn(async () => archived ? [] : [archive]),
        dispatch: vi.fn(async () => { archived = true; return { ok: true }; }),
        settle: vi.fn(async () => ({ ...cleanupRun, phase: 'complete' as const })),
        notify: vi.fn(async () => undefined),
      } as never,
    });
    expect(archived).toBe(true);
    expect(rows[0].outcome).toBe('auto_applied');
    expect(result).toMatchObject({ applied: 1, failed: 0, needsResolver: false, phase: 'complete' });
  });

  it('preserves review for a withheld tier while applying an allowed tier', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    const blocker = finding('cleared-blocker', true);
    const archive = finding('archive-candidate', false);
    archive.confidence = 'recommended';
    let cleared = false;
    const cleanupRun = run();
    cleanupRun.automationPolicy = {
      mode: 'safe-high', level: 'L2', minConfidence: 'medium',
      riskLevels: { low: 'automatic', medium: 'review', high: 'review' },
    };
    const result = await runDeterministicPlanCleanup({
      run: cleanupRun, call: vi.fn(), deps: {
        ...store, scanRun: vi.fn(async () => [...(cleared ? [] : [blocker]), archive]),
        dispatch: vi.fn(async () => { cleared = true; return { ok: true }; }),
        settle: vi.fn(), notify: vi.fn(async () => undefined),
      } as never,
    });
    expect(cleared).toBe(true);
    expect(rows.find((row) => row.kind === 'archive-candidate')?.outcome).toBe('pending');
    expect(result).toMatchObject({ applied: 1, needsResolver: true });
  });

  it('enforces one run-wide enlistment cap across locked rescans and later passes', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    const all = Array.from(
      { length: DEFAULT_ENLIST_PLAN_LIMIT + 1 },
      (_, index) => finding('enlist-plan', true, `plan-${String(index + 1).padStart(2, '0')}`),
    );
    const cleanupRun = run(all.map((candidate) => candidate.planSlug));
    const scanRun = vi.fn(async (
      _run: BulkRunRow,
      planSlugs: readonly string[] = _run.seedRefs,
      options: { enlistPlanLimit?: number } = {},
    ) => all
      .filter((candidate) => planSlugs.includes(candidate.planSlug))
      .slice(0, Math.max(0, options.enlistPlanLimit ?? DEFAULT_ENLIST_PLAN_LIMIT)));
    const dispatch = vi.fn(async () => ({ ok: true }));
    const settle = vi.fn(async () => ({ ...cleanupRun, phase: 'complete' as const }));

    const result = await runDeterministicPlanCleanup({
      run: cleanupRun,
      call: vi.fn(),
      deps: {
        scanRun,
        ...store,
        dispatch,
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(result).toMatchObject({
      needsResolver: false,
      phase: 'complete',
      applied: DEFAULT_ENLIST_PLAN_LIMIT,
      failed: 0,
    });
    expect(dispatch).toHaveBeenCalledTimes(DEFAULT_ENLIST_PLAN_LIMIT);
    expect(result.appliedFindingIds).toEqual(
      all.slice(0, DEFAULT_ENLIST_PLAN_LIMIT).map((candidate) => candidate.findingId),
    );
    expect(result.appliedFindingIds).not.toContain(all.at(-1)?.findingId);
    expect(scanRun.mock.calls.map((call) => call[2]?.enlistPlanLimit)).toContain(0);
  });

  it('re-scans to a fixed point and finishes without an LLM when every finding is provable', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    let state = 0;
    const flip = finding('flip-to-done', true);
    const finish = finding('finish-plan', true);
    const scanRun = vi.fn(async () => state === 0 ? [flip] : state === 1 ? [finish] : []);
    const dispatch = vi.fn(async ({ finding: current }: { finding: CleanupFinding }) => {
      expect(current.autoApply).toBe(true);
      state += 1;
      return { ok: true };
    });
    const settle = vi.fn(async () => ({ ...run(), phase: 'complete' as const }));

    const result = await runDeterministicPlanCleanup({
      run: run(),
      call: vi.fn(),
      deps: {
        scanRun,
        ...store,
        dispatch,
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(result).toMatchObject({ needsResolver: false, phase: 'complete', applied: 2, failed: 0 });
    expect(result.appliedFindingIds).toEqual([flip.findingId, finish.findingId]);
    expect(dispatch.mock.calls.map((call) => call[0].finding.kind)).toEqual(['flip-to-done', 'finish-plan']);
    expect(settle).toHaveBeenCalledWith({ runId: 'run-1', workspaceId: 'workspace-1', scanCompleted: true });
  });

  /*
   * WI-10004729 — the seam the layer-mocked tests missed. Every other test here
   * stubs `settle` with a canned `complete`, and the settle-rule tests in
   * bulk-run-settle.test.ts call deriveSettleOutcome with a heartbeat already
   * set. Neither layer saw what PRODUCTION composed: the deterministic pass
   * settles a zero-finding run before any resolver exists to beat the heartbeat,
   * and the real rule then refused it as "no evidence the resolver ran". This
   * composes the runner with the REAL deriveSettleOutcome over the exact facts
   * production sees (zero findings, heartbeat_at NULL) and asserts `complete`.
   */
  describe('clean scan through the REAL settle rule (WI-10004729)', () => {
    async function settleClean(passScanCompleted: boolean) {
      const { deriveSettleOutcome } = await import('../attention/bulk-run-store');
      const rows: CleanupRunFindingRow[] = [];
      const store = storeHarness(rows);
      const cleanRun = run(['plan-clean']);
      const settle = vi.fn(async (input: { runId: string; scanCompleted?: boolean }) => {
        const outcome = deriveSettleOutcome({
          runKind: cleanRun.runKind,
          outcomes: rows.map((row) => row.outcome),
          // The production fact: no resolver was launched, so no heartbeat.
          everReportedLife: cleanRun.heartbeatAt != null,
          scanCompleted: passScanCompleted ? input.scanCompleted : undefined,
        });
        return { ...cleanRun, phase: outcome.phase, error: outcome.refusedReason };
      });
      const result = await runDeterministicPlanCleanup({
        run: cleanRun,
        call: vi.fn(),
        deps: {
          scanRun: vi.fn(async () => []),
          ...store,
          dispatch: vi.fn(),
          settle,
          notify: vi.fn(async () => undefined),
        } as never,
      });
      return { result, settle };
    }

    it('settles a zero-finding scan COMPLETE, not failed', async () => {
      const { result, settle } = await settleClean(true);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ needsResolver: false, phase: 'complete', applied: 0, failed: 0 });
    });

    it('control: dropping the scan evidence reproduces the measured failed settle', async () => {
      const { result } = await settleClean(false);
      expect(result.phase).toBe('failed');
    });
  });

  it('leaves only judgment findings pending and requests the resolver', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    const recommendation = finding('stale-now', false);
    const settle = vi.fn();

    const result = await runDeterministicPlanCleanup({
      run: run(),
      call: vi.fn(),
      deps: {
        scanRun: vi.fn(async () => [recommendation]),
        ...store,
        dispatch: vi.fn(),
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(result.needsResolver).toBe(true);
    expect(result.recommendationFindingIds).toEqual([recommendation.findingId]);
    expect(rows[0]?.outcome).toBe('pending');
    expect(settle).not.toHaveBeenCalled();
  });

  it('preserves the live run phase when deterministic write authority is revoked', async () => {
    const settle = vi.fn();
    const result = await runDeterministicPlanCleanup({
      run: run(),
      call: vi.fn(),
      deps: {
        scanRun: vi.fn(async () => [finding('flip-to-done', true)]),
        seed: vi.fn(async () => ({
          findings: [],
          refused: { reason: 'run_authority_revoked', phase: 'review' },
        })),
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(result).toMatchObject({
      needsResolver: false,
      phase: 'review',
      applied: 0,
      authorityRevoked: true,
      authorityRefusal: { reason: 'run_authority_revoked', phase: 'review' },
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it('withholds a provable finding from auto-apply under a review-all/L0 standing policy and routes it to the resolver (WI-2141525)', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    const provable = finding('flip-to-done', true);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const settle = vi.fn();

    const result = await runDeterministicPlanCleanup({
      run: run(['plan-a'], { mode: 'review-all', level: 'L0', minConfidence: 'high' }),
      call: vi.fn(),
      deps: {
        scanRun: vi.fn(async () => [provable]),
        ...store,
        dispatch,
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ needsResolver: true, applied: 0, failed: 0 });
    expect(result.recommendationFindingIds).toEqual([provable.findingId]);
    expect(result.appliedFindingIds).toEqual([]);
    expect(rows[0]?.outcome).toBe('pending');
    expect(settle).not.toHaveBeenCalled();
  });

  it('still auto-applies a provable finding when the standing policy permits automation', async () => {
    const rows: CleanupRunFindingRow[] = [];
    const store = storeHarness(rows);
    const provable = finding('flip-to-done', true);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const settle = vi.fn(async () => ({ ...run(), phase: 'complete' as const }));

    const result = await runDeterministicPlanCleanup({
      run: run(['plan-a'], { mode: 'safe-high', level: 'L1', minConfidence: 'high' }),
      call: vi.fn(),
      deps: {
        scanRun: vi.fn(async () => [provable]),
        ...store,
        dispatch,
        settle,
        notify: vi.fn(async () => undefined),
      } as never,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ needsResolver: false, phase: 'complete', applied: 1, failed: 0 });
    expect(result.appliedFindingIds).toEqual([provable.findingId]);
  });
});
