import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActiveRunError extends Error {
    code = 'run_already_active';
    activeRunId = 'cleanup-live';
    activePhase = 'running';
  }
  return {
    ActiveRunError,
    createRun: vi.fn(),
    getRun: vi.fn(),
    getLatestRun: vi.fn(),
    getActiveRun: vi.fn(),
    setRunPhase: vi.fn(),
    settleRunPhase: vi.fn(),
    failRunIfExecuting: vi.fn(),
    restartRun: vi.fn(),
    classifyRunLiveness: vi.fn(),
    runDeterministicPlanCleanup: vi.fn(),
    scanCleanupRun: vi.fn(),
    buildPlanCleanupSystemCall: vi.fn(),
    markCleanupFindingAccepted: vi.fn(),
    markCleanupFindingDismissed: vi.fn(),
    getRunFindings: vi.fn(),
    getCleanupReviewRuns: vi.fn(),
    notifyPlanCleanupRunChanged: vi.fn(),
    requireAllowedOriginOr403: vi.fn(),
    gateApiRoute: vi.fn(),
    buildConsoleEnvelope: vi.fn(),
    spawnHeadless: vi.fn(),
    resolveSpawnHostOperatorBaseUrl: vi.fn(),
    buildResolverLaunchCommand: vi.fn(),
    resolverSpawnOutcome: vi.fn(),
    child: { once: vi.fn() },
  };
});

vi.mock('../attention/bulk-run-store', () => ({
  BulkRunAlreadyActiveError: h.ActiveRunError,
  createRun: h.createRun,
  getRun: h.getRun,
  getLatestRun: h.getLatestRun,
  getActiveRun: h.getActiveRun,
  setRunPhase: h.setRunPhase,
  settleRunPhase: h.settleRunPhase,
  failRunIfExecuting: h.failRunIfExecuting,
  restartRun: h.restartRun,
  classifyRunLiveness: h.classifyRunLiveness,
}));
vi.mock('./run-store', () => ({
  markCleanupFindingAccepted: h.markCleanupFindingAccepted,
  markCleanupFindingDismissed: h.markCleanupFindingDismissed,
  getRunFindings: h.getRunFindings,
  getCleanupReviewRuns: h.getCleanupReviewRuns,
}));
vi.mock('./deterministic-runner', () => ({
  runDeterministicPlanCleanup: h.runDeterministicPlanCleanup,
  scanCleanupRun: h.scanCleanupRun,
  buildPlanCleanupSystemCall: h.buildPlanCleanupSystemCall,
}));
vi.mock('../attention/bulk-run-sync', () => ({
  notifyPlanCleanupRunChanged: h.notifyPlanCleanupRunChanged,
}));
vi.mock('../endpoint-route/cors', () => ({
  requireAllowedOriginOr403: h.requireAllowedOriginOr403,
}));
vi.mock('../require-flag', () => ({ gateApiRoute: h.gateApiRoute }));
vi.mock('../console-launcher', () => ({ buildConsoleEnvelope: h.buildConsoleEnvelope }));
vi.mock('../console-spawn', () => ({ spawnHeadless: h.spawnHeadless }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
// launchCleanupResolver derives the spawn's logDir from the workspace's papercusp root,
// which reads the real on-disk workspace registry. Pin it so the launch path stays
// hermetic and never resolves against this machine's ~/.papercusp.
vi.mock('../papercusp-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../papercusp-root')>()),
  papercuspPathForWorkspace: (workspaceId: string, ...parts: string[]) =>
    ['/plan-cleanup-policy-test', workspaceId, ...parts].join('/'),
}));
vi.mock('../mcp-base-url', () => ({
  resolveSpawnHostOperatorBaseUrl: h.resolveSpawnHostOperatorBaseUrl,
}));
// Only the two SPAWNING helpers are stubbed. `preflightResolverLaunch` is a pure
// validator with no process side-effects, so it stays REAL via importOriginal —
// stubbing it would make this suite pass while the shared start-route gate the
// plan-cleanup route depends on went untested here.
vi.mock('../endpoint-route/routes/admin/attention-bulk-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../endpoint-route/routes/admin/attention-bulk-resolve')>();
  return {
    ...actual,
    buildResolverLaunchCommand: h.buildResolverLaunchCommand,
    resolverSpawnOutcome: h.resolverSpawnOutcome,
  };
});

import { planCleanupHandler } from '../endpoint-route/routes/admin/plan-cleanup';
import { MAX_RUN_PLANS, normalizePlanSlugs, selectPlansForRun } from './start-run';
import { getRegistryEntryV2 } from '../sync-resolver/index';

const run = {
  runId: 'cleanup-1',
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
  phase: 'pending',
  runKind: 'plan-cleanup',
  seedRefs: ['plan-a', 'plan-b'],
  totalItems: 2,
};

function request(body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1:3070/api/admin/plan-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createRun.mockResolvedValue(run);
  h.setRunPhase.mockResolvedValue({ ...run, phase: 'running' });
  h.settleRunPhase.mockResolvedValue({ ...run, phase: 'complete' });
  h.failRunIfExecuting.mockResolvedValue(null);
  h.classifyRunLiveness.mockReturnValue({ state: 'not-executing', phase: 'review' });
  h.runDeterministicPlanCleanup.mockResolvedValue({
    needsResolver: true,
    phase: 'pending',
    passes: 1,
    applied: 0,
    skipped: 0,
    failed: 0,
    appliedFindingIds: [],
    recommendationFindingIds: ['f-1'],
    reconciliationRequired: [],
    fatalError: null,
    authorityRevoked: false,
    authorityRefusal: null,
  });
  h.buildPlanCleanupSystemCall.mockReturnValue(vi.fn());
  h.markCleanupFindingAccepted.mockResolvedValue({
    finding: { findingId: 'stale-now:papercusp/plan-a', outcome: 'accepted' },
    run: { ...run, phase: 'review' },
  });
  h.markCleanupFindingDismissed.mockResolvedValue({
    finding: { findingId: 'stale-now:papercusp/plan-a', outcome: 'dismissed' },
    run: { ...run, phase: 'review' },
  });
  h.notifyPlanCleanupRunChanged.mockResolvedValue(undefined);
  h.requireAllowedOriginOr403.mockReturnValue(null);
  h.gateApiRoute.mockResolvedValue(null);
  h.buildConsoleEnvelope.mockResolvedValue({ env: { BASE: '1' }, greetingCmd: 'old' });
  h.resolveSpawnHostOperatorBaseUrl.mockResolvedValue('http://127.0.0.1:3070');
  h.buildResolverLaunchCommand.mockReturnValue('psu --headless');
  h.spawnHeadless.mockResolvedValue({ status: 'ok', child: h.child });
  h.resolverSpawnOutcome.mockReturnValue({ ok: true, sessionId: 'su-resolver', child: h.child });
  h.getRunFindings.mockResolvedValue([{ findingId: 'f-1' }]);
  h.getCleanupReviewRuns.mockResolvedValue({ runs: [], total: 0 });
  h.scanCleanupRun.mockResolvedValue([]);
});

describe('plan-cleanup route policy', () => {
  it('dedupes the click-time plan snapshot and REPORTS the cap instead of silently cutting', () => {
    const input = [' plan-a ', 'plan-a', ...Array.from({ length: MAX_RUN_PLANS + 10 }, (_, i) => `p-${i}`)];
    const parsed = normalizePlanSlugs(input);
    expect(parsed[0]).toBe('plan-a');
    expect(new Set(parsed).size).toBe(parsed.length);
    const selection = selectPlansForRun(parsed, new Map());
    expect(selection.planSlugs).toHaveLength(MAX_RUN_PLANS);
    expect(selection).toMatchObject({ requested: MAX_RUN_PLANS + 11, accepted: MAX_RUN_PLANS, truncated: 11 });
  });

  it('creates a plan-kind run and launches a supervised resolver with the run brief', async () => {
    const response = await planCleanupHandler(
      request({ planSlugs: ['plan-a', 'plan-b'], harness: 'papercusp', filter: { q: 'active' } }),
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      runId: run.runId,
      launched: true,
      // P-005: the start response reports coverage, so a cap is never silent.
      requested: 2,
      accepted: 2,
      truncated: 0,
    });
    expect(h.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [],
        runKind: 'plan-cleanup',
        seedRefs: ['plan-a', 'plan-b'],
        harnessSlug: 'papercusp',
      }),
    );
    expect(h.spawnHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        label: expect.stringContaining('plan-cleanup-'),
        launchedBy: 'plan-cleanup',
        envelope: expect.objectContaining({
          greetingCmd: 'psu --headless',
          env: expect.objectContaining({
            PAPERCUSP_KICKOFF_PROMPT: expect.stringContaining('plans:cleanup-manifest'),
          }),
        }),
      }),
    );
    const pending = h.setRunPhase.mock.calls.find((call) => call[0]?.phase === 'pending')?.[0];
    const running = h.setRunPhase.mock.calls.find((call) => call[0]?.phase === 'running')?.[0];
    expect(pending).toMatchObject({ runId: run.runId, resolverOwner: expect.stringMatching(/^su-/) });
    expect(running).toEqual({
      runId: run.runId,
      phase: 'running',
      resolverOwner: pending.resolverOwner,
      workspaceId: run.workspaceId,
    });
    expect(h.spawnHeadless).toHaveBeenCalledWith(expect.objectContaining({ coordOwnerId: pending.resolverOwner }));
  });

  it('returns a visible failed run when launch fails instead of failing the request', async () => {
    h.resolverSpawnOutcome.mockReturnValue({ ok: false, error: 'psu boot failed' });
    const response = await planCleanupHandler(request({ planSlugs: ['plan-a'] }), {} as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      runId: run.runId,
      phase: 'failed',
      launched: false,
      launchError: 'psu boot failed',
    });
    expect(h.setRunPhase).toHaveBeenCalledWith({
      runId: run.runId,
      phase: 'failed',
      error: 'psu boot failed',
      workspaceId: run.workspaceId,
    });
  });

  it('keeps stop reachable while the feature gate would refuse acting', async () => {
    h.gateApiRoute.mockResolvedValue(new Response(null, { status: 404 }));
    const response = await planCleanupHandler(request({ op: 'stop', runId: run.runId }), {} as never);
    expect(response.status).toBe(200);
    expect(h.gateApiRoute).not.toHaveBeenCalled();
    expect(h.settleRunPhase).toHaveBeenCalledWith({ runId: run.runId });
  });

  it('records acceptance only after the client names the reviewed finding', async () => {
    const response = await planCleanupHandler(
      request({ op: 'accept', runId: run.runId, findingId: 'stale-now:papercusp/plan-a', note: 'Approved' }),
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(h.markCleanupFindingAccepted).toHaveBeenCalledWith({
      runId: run.runId,
      findingId: 'stale-now:papercusp/plan-a',
      note: 'Approved',
    });
    expect(h.settleRunPhase).toHaveBeenCalledWith({ runId: run.runId });
  });

  it('preserves review when a legacy client dismisses only the report view', async () => {
    h.getRun.mockResolvedValueOnce({ ...run, phase: 'review' });
    const response = await planCleanupHandler(request({ op: 'dismiss', runId: run.runId }), {} as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      phase: 'review',
      dismissed: true,
      reviewPreserved: true,
    });
    expect(h.setRunPhase).not.toHaveBeenCalled();
  });

  it('dismisses one finding durably before re-settling the run', async () => {
    const response = await planCleanupHandler(
      request({
        op: 'dismiss-finding',
        runId: run.runId,
        findingId: 'stale-now:papercusp/plan-a',
        note: 'Owner declined this rewrite',
      }),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(h.markCleanupFindingDismissed).toHaveBeenCalledWith({
      runId: run.runId,
      findingId: 'stale-now:papercusp/plan-a',
      note: 'Owner declined this rewrite',
    });
    expect(h.markCleanupFindingDismissed.mock.invocationCallOrder[0]).toBeLessThan(
      h.settleRunPhase.mock.invocationCallOrder[0]!,
    );
  });

  it('rechecks the live plan and reconciles a finding only after it disappears', async () => {
    h.getRun.mockResolvedValueOnce({ ...run, phase: 'review' });
    h.getRunFindings.mockResolvedValueOnce([
      { findingId: 'stale-now:papercusp/plan-a', kind: 'stale-now', planSlug: 'plan-a' },
    ]);
    const response = await planCleanupHandler(
      request({
        op: 'recheck-finding',
        runId: run.runId,
        findingId: 'stale-now:papercusp/plan-a',
      }),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(h.scanCleanupRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId }), ['plan-a']);
    expect(h.markCleanupFindingAccepted).toHaveBeenCalledWith({
      runId: run.runId,
      findingId: 'stale-now:papercusp/plan-a',
      note: 'Owner recheck confirmed the finding no longer exists in live plan state',
    });
    expect(await response.json()).toMatchObject({ resolved: true });
  });

  it('keeps a finding unresolved when the live recheck still emits it', async () => {
    h.getRun.mockResolvedValueOnce({ ...run, phase: 'review' });
    h.getRunFindings.mockResolvedValueOnce([
      { findingId: 'stale-now:papercusp/plan-a', kind: 'stale-now', planSlug: 'plan-a' },
    ]);
    h.scanCleanupRun.mockResolvedValueOnce([{ findingId: 'stale-now:papercusp/plan-a' }]);
    const response = await planCleanupHandler(
      request({
        op: 'recheck-finding',
        runId: run.runId,
        findingId: 'stale-now:papercusp/plan-a',
      }),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolved: false, phase: 'review' });
    expect(h.markCleanupFindingAccepted).not.toHaveBeenCalled();
    expect(h.settleRunPhase).not.toHaveBeenCalled();
  });
});

describe('plans.cleanupRun sync resolver', () => {
  it('returns an explicit idle row and filters the latest read to plan-cleanup', async () => {
    h.getActiveRun.mockResolvedValue(null);
    h.getLatestRun.mockResolvedValue(null);
    const rows = await getRegistryEntryV2('plans.cleanupRun')!.resolve!({} as never);
    // WI-10004730: an open run outranks a newer terminal one — active first.
    expect(h.getActiveRun).toHaveBeenCalledWith(undefined, 'plan-cleanup');
    expect(h.getLatestRun).toHaveBeenCalledWith(undefined, 'plan-cleanup');
    expect(rows).toEqual([{ run: null, findings: [], reviewInventory: { runs: [], total: 0 } }]);
    expect(h.getCleanupReviewRuns).toHaveBeenCalledOnce();
  });

  it('returns one run with its findings and rejects an explicit inbox-kind run', async () => {
    const reviewInventory = {
      runs: [{ runId: 'older-review', createdAt: '2026-10-06T12:00:00Z', unresolved: 2 }],
      total: 1,
    };
    h.getCleanupReviewRuns.mockResolvedValue(reviewInventory);
    h.getRun.mockResolvedValue({ ...run, phase: 'review' });
    expect(await getRegistryEntryV2('plans.cleanupRun')!.resolve!({ runId: run.runId } as never)).toEqual([
      {
        run: {
          ...run,
          phase: 'review',
          liveness: { state: 'not-executing', phase: 'review' },
        },
        findings: [{ findingId: 'f-1' }],
        reviewInventory,
      },
    ]);

    h.getRun.mockResolvedValue({ ...run, runKind: 'inbox-resolve' });
    expect(await getRegistryEntryV2('plans.cleanupRun')!.resolve!({ runId: 'inbox-1' } as never)).toEqual([
      { run: null, findings: [], reviewInventory },
    ]);
    expect(h.getCleanupReviewRuns).toHaveBeenCalledTimes(2);
  });
});
