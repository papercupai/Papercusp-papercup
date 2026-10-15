/**
 * Route-level recurrence guards for bulk-resolver owner generations.
 *
 * Store tests prove a prior owner is rejected after rotation. These tests pin
 * the other half of that guarantee: both owner routes persist the generated
 * owner before the replacement process can start, and launch that process with
 * exactly the same identity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  createRun: vi.fn(),
  failRunIfExecuting: vi.fn(),
  getRun: vi.fn(),
  restartRun: vi.fn(),
  resumeReviewRun: vi.fn(),
  markItemAccepted: vi.fn(),
  markItemDismissed: vi.fn(),
  setRunPhase: vi.fn(),
  settleRunPhase: vi.fn(),
  markCleanupFindingAccepted: vi.fn(),
  notifyBulkRunChanged: vi.fn(),
  notifyPlanCleanupRunChanged: vi.fn(),
  runDeterministicPlanCleanup: vi.fn(),
  buildPlanCleanupSystemCall: vi.fn(),
  buildConsoleEnvelope: vi.fn(),
  spawnHeadless: vi.fn(),
  revertAttentionBulkItemHandle: vi.fn(),
}));

vi.mock('../../require-flag', () => ({ gateApiRoute: vi.fn(async () => null) }));
vi.mock('../cors', () => ({ requireAllowedOriginOr403: vi.fn(() => null) }));
vi.mock('../../harness/operator-home-harness', () => ({
  operatorHomeHarnessSlug: () => 'papercusp',
}));
vi.mock('../../attention/bulk-run-store', () => {
  class BulkRunAlreadyActiveError extends Error {
    code = 'run_already_active';
    activeRunId = null;
    activePhase = null;
  }
  return {
    BulkRunAlreadyActiveError,
    createRun: (...args: unknown[]) => h.createRun(...args),
    failRunIfExecuting: (...args: unknown[]) => h.failRunIfExecuting(...args),
    getRun: (...args: unknown[]) => h.getRun(...args),
    restartRun: (...args: unknown[]) => h.restartRun(...args),
    resumeReviewRun: (...args: unknown[]) => h.resumeReviewRun(...args),
    markItemAccepted: (...args: unknown[]) => h.markItemAccepted(...args),
    markItemDismissed: (...args: unknown[]) => h.markItemDismissed(...args),
    setRunPhase: (...args: unknown[]) => h.setRunPhase(...args),
    settleRunPhase: (...args: unknown[]) => h.settleRunPhase(...args),
  };
});
vi.mock('../../attention/bulk-run-sync', () => ({
  notifyBulkRunChanged: (...args: unknown[]) => h.notifyBulkRunChanged(...args),
  notifyPlanCleanupRunChanged: (...args: unknown[]) => h.notifyPlanCleanupRunChanged(...args),
}));
vi.mock('../../attention/bulk-run-reversal', () => ({
  revertAttentionBulkItemHandle: (...args: unknown[]) => h.revertAttentionBulkItemHandle(...args),
}));
vi.mock('../../plan-cleanup/run-store', () => ({
  markCleanupFindingAccepted: (...args: unknown[]) => h.markCleanupFindingAccepted(...args),
}));
vi.mock('../../plan-cleanup/resolver-brief', () => ({
  buildCleanupResolverBrief: vi.fn(() => 'cleanup resolver brief'),
}));
vi.mock('../../plan-cleanup/deterministic-runner', () => ({
  buildPlanCleanupSystemCall: (...args: unknown[]) => h.buildPlanCleanupSystemCall(...args),
  runDeterministicPlanCleanup: (...args: unknown[]) => h.runDeterministicPlanCleanup(...args),
}));
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: (...args: unknown[]) => h.buildConsoleEnvelope(...args),
}));
vi.mock('../../console-spawn', () => ({
  spawnHeadless: (...args: unknown[]) => h.spawnHeadless(...args),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
vi.mock('../../mcp-base-url', () => ({
  resolveSpawnHostOperatorBaseUrl: vi.fn(async () => 'http://127.0.0.1:3070'),
}));

import attentionRoutes from '../routes/admin/attention-bulk-resolve';
import { planCleanupHandler } from '../routes/admin/plan-cleanup';

const launchSnapshot = {
  model: null,
  effort: null,
  account: 'default' as const,
  carry: 'warm' as const,
  backend: 'claude' as const,
};

const baseRun = {
  runId: 'run-1',
  workspaceId: 'papercusp-workspace',
  harnessSlug: 'papercusp',
  requestedBy: 'owner',
  resolverOwner: null,
  phase: 'pending' as const,
  runKind: 'inbox-resolve' as const,
  seedRefs: [] as string[],
  filterSnapshot: {},
  launchSnapshot,
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

const ctx = () => ({
  principal: null,
  input: undefined,
  params: {},
  log: vi.fn(),
  signal: new AbortController().signal,
});

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function spawnedOwner(): string {
  const input = h.spawnHeadless.mock.calls.at(-1)?.[0] as { coordOwnerId?: string } | undefined;
  expect(input?.coordOwnerId).toMatch(/^su-/);
  return input!.coordOwnerId!;
}

function expectPinnedBeforeSpawn(owner: string): void {
  const pending = h.setRunPhase.mock.calls.find(([input]) => input.phase === 'pending')?.[0];
  expect(pending).toMatchObject({ runId: 'run-1', phase: 'pending', resolverOwner: owner });
  expect(h.setRunPhase.mock.invocationCallOrder[0]).toBeLessThan(h.spawnHeadless.mock.invocationCallOrder[0]!);
  const running = h.setRunPhase.mock.calls.find(([input]) => input.phase === 'running')?.[0];
  expect(running).toMatchObject({ runId: 'run-1', phase: 'running', resolverOwner: owner });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.failRunIfExecuting.mockResolvedValue(null);
  h.createRun.mockResolvedValue({ ...baseRun });
  h.getRun.mockResolvedValue({ ...baseRun, phase: 'review' });
  h.setRunPhase.mockImplementation(async (input: { phase: string; resolverOwner?: string }) => ({
    ...baseRun,
    phase: input.phase,
    resolverOwner: input.resolverOwner ?? null,
  }));
  h.markItemAccepted.mockResolvedValue({ itemId: 'item-1', outcome: 'auto_resolved' });
  h.markItemDismissed.mockResolvedValue({ itemId: 'item-1', outcome: 'dismissed' });
  h.settleRunPhase.mockResolvedValue({ ...baseRun, phase: 'review' });
  h.notifyBulkRunChanged.mockResolvedValue(undefined);
  h.notifyPlanCleanupRunChanged.mockResolvedValue(undefined);
  h.buildPlanCleanupSystemCall.mockReturnValue(vi.fn());
  h.runDeterministicPlanCleanup.mockResolvedValue({
    needsResolver: true,
    phase: 'pending',
    passes: 1,
    applied: 0,
    skipped: 0,
    failed: 0,
    appliedFindingIds: [],
    recommendationFindingIds: ['stale-now:papercusp/plan-a'],
    reconciliationRequired: [],
    fatalError: null,
    authorityRevoked: false,
    authorityRefusal: null,
  });
  h.buildConsoleEnvelope.mockResolvedValue({ env: {} });
  h.spawnHeadless.mockResolvedValue({
    status: 'ok',
    pid: 42,
    terminal: 'headless',
    child: { once: vi.fn() },
    display: null,
    desktopEnvResolvedVia: null,
  });
});

describe('Inbox bulk-resolver owner lifecycle', () => {
  const handler = attentionRoutes[0]!.handler;

  it('pre-pins the generated owner before start can spawn', async () => {
    const response = await handler(
      post('/api/admin/attention-bulk-resolve', {
        op: 'start',
        items: [{ itemId: 'coord-escalation:1' }],
      }),
      ctx(),
    );

    expect(response.status).toBe(200);
    const owner = spawnedOwner();
    expectPinnedBeforeSpawn(owner);
  });

  it('fails an exit captured during launch after the run is marked running', async () => {
    h.spawnHeadless.mockResolvedValueOnce({
      status: 'ok',
      pid: 42,
      terminal: 'headless',
      child: { once: vi.fn() },
      childExit: Promise.resolve({ code: 137, signal: null }),
      display: null,
      desktopEnvResolvedVia: null,
    });

    const response = await handler(
      post('/api/admin/attention-bulk-resolve', {
        op: 'start',
        items: [{ itemId: 'coord-escalation:1' }],
      }),
      ctx(),
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(h.failRunIfExecuting).toHaveBeenCalledTimes(1));

    const runningIndex = h.setRunPhase.mock.calls.findIndex(([input]) => input.phase === 'running');
    expect(runningIndex).toBeGreaterThanOrEqual(0);
    expect(h.setRunPhase.mock.invocationCallOrder[runningIndex]).toBeLessThan(
      h.failRunIfExecuting.mock.invocationCallOrder[0]!,
    );
    expect(h.failRunIfExecuting).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        resolverOwner: spawnedOwner(),
        error: 'resolver process ended before settling the run: exit 137',
      }),
    );
  });

  it('rotates the owner in restartRun before spawning the replacement', async () => {
    h.restartRun.mockResolvedValueOnce({
      ok: true,
      run: { ...baseRun, resolverOwner: 'su-prior' },
      preservedOutcomes: 1,
    });

    const response = await handler(post('/api/admin/attention-bulk-resolve', { op: 'restart', runId: 'run-1' }), ctx());

    expect(response.status).toBe(200);
    const owner = spawnedOwner();
    expect(h.restartRun).toHaveBeenCalledWith({ runId: 'run-1', resolverOwner: owner });
    expect(h.restartRun.mock.invocationCallOrder[0]).toBeLessThan(h.spawnHeadless.mock.invocationCallOrder[0]!);
    expect(h.setRunPhase).toHaveBeenCalledWith({ runId: 'run-1', phase: 'running', resolverOwner: owner });
  });

  it('pins a fresh owner while selectively resuming review rows', async () => {
    h.resumeReviewRun.mockResolvedValueOnce({
      ok: true,
      run: { ...baseRun, phase: 'pending' },
      requeuedIds: ['item-1'],
      preservedOutcomes: 2,
    });
    const response = await handler(
      post('/api/admin/attention-bulk-resolve', { op: 'resume', runId: 'run-1', itemIds: ['item-1'] }),
      ctx(),
    );
    expect(response.status).toBe(200);
    const owner = spawnedOwner();
    expect(h.resumeReviewRun).toHaveBeenCalledWith({ runId: 'run-1', itemIds: ['item-1'], resolverOwner: owner });
    expect(h.resumeReviewRun.mock.invocationCallOrder[0]).toBeLessThan(h.spawnHeadless.mock.invocationCallOrder[0]!);
  });

  it('dismisses one unresolved review row, then re-settles the run', async () => {
    h.settleRunPhase.mockResolvedValueOnce({ ...baseRun, phase: 'complete' });
    const response = await handler(
      post('/api/admin/attention-bulk-resolve', {
        op: 'dismiss-item',
        runId: 'run-1',
        itemId: 'item-1',
        note: 'Owner deliberately declined this row',
      }),
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(h.markItemDismissed).toHaveBeenCalledWith({
      runId: 'run-1',
      itemId: 'item-1',
      note: 'Owner deliberately declined this row',
    });
    expect(h.markItemDismissed.mock.invocationCallOrder[0]).toBeLessThan(h.settleRunPhase.mock.invocationCallOrder[0]!);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      itemId: 'item-1',
      phase: 'complete',
      dismissed: true,
    });
  });

  it('reconciles a successful hand resolution through the accepted outcome, then re-settles', async () => {
    const response = await handler(
      post('/api/admin/attention-bulk-resolve', {
        op: 'reconcile-item',
        runId: 'run-1',
        itemId: 'item-1',
      }),
      ctx(),
    );

    expect(response.status).toBe(200);
    expect(h.markItemAccepted).toHaveBeenCalledWith({
      runId: 'run-1',
      itemId: 'item-1',
      actionId: 'manual',
      note: 'Owner rechecked the live source after resolving it manually',
    });
    expect(h.markItemAccepted.mock.invocationCallOrder[0]).toBeLessThan(h.settleRunPhase.mock.invocationCallOrder[0]!);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      itemId: 'item-1',
      reconciled: true,
    });
  });

  it('does not settle when a row-level owner operation names no actionable review row', async () => {
    h.markItemDismissed.mockResolvedValueOnce(null);
    const response = await handler(
      post('/api/admin/attention-bulk-resolve', {
        op: 'dismiss-item',
        runId: 'run-1',
        itemId: 'already-handled',
      }),
      ctx(),
    );

    expect(response.status).toBe(409);
    expect(h.settleRunPhase).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'review_item_not_actionable' },
    });
  });

  it('preserves review when a legacy client dismisses only the report view', async () => {
    const response = await handler(
      post('/api/admin/attention-bulk-resolve', {
        op: 'dismiss',
        runId: 'run-1',
      }),
      ctx(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      phase: 'review',
      dismissed: true,
      reviewPreserved: true,
    });
    expect(h.setRunPhase).not.toHaveBeenCalled();
    expect(h.settleRunPhase).not.toHaveBeenCalled();
  });

  it('executes one item undo through the shared compensation handle', async () => {
    h.revertAttentionBulkItemHandle.mockResolvedValueOnce({ reverted: true, note: 'restored source' });
    const response = await handler(
      post('/api/admin/attention-bulk-resolve', {
        op: 'undo-item',
        runId: 'run-1',
        itemId: 'coord-message:m-1',
      }),
      ctx(),
    );
    expect(response.status).toBe(200);
    expect(h.revertAttentionBulkItemHandle).toHaveBeenCalledWith({
      kind: 'attention-bulk-item',
      workspaceId: 'papercusp-workspace',
      runId: 'run-1',
      itemId: 'coord-message:m-1',
    });
    await expect(response.json()).resolves.toMatchObject({ reverted: true, note: 'restored source' });
  });
});

describe('plan-cleanup resolver owner lifecycle', () => {
  it('pre-pins the generated owner before judgment-resolver start can spawn', async () => {
    h.createRun.mockResolvedValueOnce({
      ...baseRun,
      runKind: 'plan-cleanup',
      seedRefs: ['plan-a'],
    });

    const response = await planCleanupHandler(
      post('/api/admin/plan-cleanup', { op: 'start', planSlugs: ['plan-a'] }),
      ctx(),
    );

    expect(response.status).toBe(200);
    const owner = spawnedOwner();
    expectPinnedBeforeSpawn(owner);
  });

  it('rotates the owner in restartRun before spawning the replacement', async () => {
    h.restartRun.mockResolvedValueOnce({
      ok: true,
      run: {
        ...baseRun,
        resolverOwner: 'su-prior',
        runKind: 'plan-cleanup',
        seedRefs: ['plan-a'],
      },
      preservedOutcomes: 1,
    });

    const response = await planCleanupHandler(
      post('/api/admin/plan-cleanup', { op: 'restart', runId: 'run-1' }),
      ctx(),
    );

    expect(response.status).toBe(200);
    const owner = spawnedOwner();
    expect(h.restartRun).toHaveBeenCalledWith({ runId: 'run-1', resolverOwner: owner });
    expect(h.restartRun.mock.invocationCallOrder[0]).toBeLessThan(h.spawnHeadless.mock.invocationCallOrder[0]!);
    expect(h.setRunPhase).toHaveBeenCalledWith({ runId: 'run-1', phase: 'running', resolverOwner: owner });
  });

  it('pins a fresh owner while selectively resuming cleanup findings', async () => {
    h.resumeReviewRun.mockResolvedValueOnce({
      ok: true,
      run: { ...baseRun, phase: 'pending', runKind: 'plan-cleanup', seedRefs: ['plan-a'] },
      requeuedIds: ['stale-now:papercusp/plan-a'],
      preservedOutcomes: 3,
    });
    const response = await planCleanupHandler(
      post('/api/admin/plan-cleanup', { op: 'resume', runId: 'run-1', findingIds: ['stale-now:papercusp/plan-a'] }),
      ctx(),
    );
    expect(response.status).toBe(200);
    const owner = spawnedOwner();
    expect(h.resumeReviewRun).toHaveBeenCalledWith({
      runId: 'run-1',
      itemIds: ['stale-now:papercusp/plan-a'],
      resolverOwner: owner,
    });
  });
});
