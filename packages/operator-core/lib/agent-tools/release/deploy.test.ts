/**
 * deploy.test.ts — the release:deploy TOOL routing + safety gates (release-pipeline-resilience P-015).
 * Mocks all I/O (status read, deploy launch, audit, notify) so it asserts the decision logic —
 * refuse / dry-run / fire / role-gate — without touching PG or firing a real deploy.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/deploy.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeployStatus } from '../../release-deploy-launch';
// The live tool barrel installs the built-in cells before any door is dispatched.
// This file imports the door directly, so reproduce that bootstrap explicitly.
import '../cell-registrations-wiring';

const auditUnsafeM = vi.hoisted(() => vi.fn());
const gateOwnershipM = vi.hoisted(() => vi.fn());
const ownerDirectiveM = vi.hoisted(() => vi.fn());

vi.mock('../../owner-directives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../owner-directives')>()),
  getOwnerDirective: ownerDirectiveM,
}));

vi.mock('../../release-deploy-launch', () => ({
  readDeployStatus: vi.fn(),
  launchDetachedDeploy: vi.fn(),
  // EI-20482937744589016: the subject stamp names the integration TREE the shas come from, so
  // the tool now reads integrationRoot too. A fixed value here keeps the assertion about the
  // stamp's shape, not about this box's checkout path.
  integrationRoot: () => '/test/integration-root',
}));
// Partial-mocks (importOriginal) — the tool's import graph (agent-mcp bootstrap) needs the
// real OTHER exports of these modules; we override only the single function each touches.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { unsafe: auditUnsafeM,
    begin: (fn: (tx: { unsafe: typeof auditUnsafeM }) => Promise<unknown>) => fn({ unsafe: auditUnsafeM }),
  } }) as never,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'test-ws',
}));
vi.mock('../../coord/gate-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coord/gate-ownership')>()),
  readGateOwnership: gateOwnershipM,
}));
vi.mock('../locks/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/identity')>()),
  readIdentity: () => ({ ownerId: 'o', ownerLabel: 'tester', coordinationDomain: 'd' }) as never,
}));
// Hoisted like the spies above: '../cell-registrations-wiring' now reaches attention-notify
// during static import, so this factory runs before a plain top-level `const` is initialised.
const notifyM = vi.hoisted(() => vi.fn());
vi.mock('../../attention-notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention-notify')>()),
  notifyAttention: notifyM,
}));
// WI-1320: a confirmed release:deploy fires git-sync FIRST (so it ships current staging, not
// stale). Mock that I/O (no-op) so the tool's decision logic is tested in isolation — same as
// the readDeployStatus / launch / notify mocks above. Spread the real module so the rest of
// the import graph keeps git-sync-action's other exports.
vi.mock('../../harness/git-sync/git-sync-action', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/git-sync/git-sync-action')>()),
  fireGitSyncNow: vi.fn(),
}));
vi.mock('../../harness/operator-home-harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/operator-home-harness')>()),
  operatorHomeHarnessSlug: () => 'test-home',
}));
// WI-5377: op:gate-history's own I/O — independent of readDeployStatus, so it needs its
// own mock rather than reusing statusM.
vi.mock('../../harness/git-sync/pipeline-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/git-sync/pipeline-events')>()),
  recentPipelineEvents: vi.fn(),
}));
// WI-10004340: diagnosticVintage.processSha falls back to getBuildInfo(), which shells out to
// `git rev-parse` with a 2s timeout. The gate's loaded checkout resolved null there ('unknown'),
// while the shared tree resolved a real sha ('stale'). Pin the process identity so the vintage
// assertions measure the tool, not the host running them.
vi.mock('../../build-info', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../build-info')>()),
  getBuildInfo: () => ({ sha: 'process0sha', version: '0.0.0-test' }),
}));

import { readDeployStatus, launchDetachedDeploy } from '../../release-deploy-launch';
import { fireGitSyncNow } from '../../harness/git-sync/git-sync-action';
import { recentPipelineEvents } from '../../harness/git-sync/pipeline-events';
const statusM = vi.mocked(readDeployStatus);
const launchM = vi.mocked(launchDetachedDeploy);
const fireGitSyncM = vi.mocked(fireGitSyncNow);
const recentPipelineEventsM = vi.mocked(recentPipelineEvents);
const deployModule = await import('./deploy');
const tool = deployModule.default;
const RELEASE_STATUS_READ_TIMEOUT_MS = deployModule.RELEASE_STATUS_READ_TIMEOUT_MS;

type Out = { content: { text: string }[] };
const body = (o: unknown) => JSON.parse((o as Out).content[0]!.text);

function mkStatus(over: Partial<DeployStatus> = {}): DeployStatus {
  return {
    gate: {
      green: true,
      consecutiveReds: 0,
      stalled: false,
      fireStale: false,
      fireStaleReason: null,
      lastGreenAtMs: null,
      verdictStale: false,
      verdictStaleReason: null,
      lastFixerStatus: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      failingTests: [],
      lastVerdict: null,
    },
    deploy: {
      deployedSha: 'deployed0',
      stagingHeadSha: 'staging0head',
      greenPinSha: 'greenpin0',
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      deployedAtMs: 1,
    },
    deployInFlight: null,
    deployTerminal: null,
    checkpointRunInFlight: null,
    checkpoint: {
      state: 'idle',
      authority: 'live-probe',
      phase: null,
      blocker: null,
      verdictPending: false,
      probe: { status: 'ok', detail: null },
    },
    manualRunAuthority: null,
    releaseTrigger: {
      active: true,
      cron: null,
      lastFiredAtMs: null,
      nextFireAtMs: null,
      pause: null,
      blocked: false,
      blockReason: null,
      fireStale: false,
      fireStaleReason: null,
    },
    liveCertification: null,
    canTriggerGreen: false,
    nothingToDeploy: true,
    state: 'up-to-date',
    recommendation: 'up to date',
    summary: 'up to date',
    errors: [],
    ...over,
  };
}

/** EI-18724155280048738: a running deploy, as `readDeployStatus` reports it. */
function inFlight(over: Partial<NonNullable<DeployStatus['deployInFlight']>> = {}): NonNullable<
  DeployStatus['deployInFlight']
> {
  return {
    active: true,
    unit: 'papercup-auto-deploy',
    activeState: 'active',
    subState: 'running',
    startedAtMs: Date.parse('2026-07-26T16:09:43Z'),
    logPath: '/tmp/papercup-auto-deploy.log',
    logMtimeMs: null,
    source: 'systemd',
    ...over,
  };
}

function checkpointRun(
  over: Partial<NonNullable<DeployStatus['checkpointRunInFlight']>> = {},
): NonNullable<DeployStatus['checkpointRunInFlight']> {
  return {
    active: true,
    logPath: '/tmp/papercup-green-checkpoint-manual-demo.log',
    candidate: 'fb941a2c',
    initialCandidate: '80cde64e',
    refireObserved: true,
    startedAtMs: Date.parse('2026-08-12T07:29:34Z'),
    elapsedSec: 2400,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gateOwnershipM.mockResolvedValue({
    assessment: 'held-live', claimState: 'held', workItem: 'WI-gate', takenBy: 'o',
    takenAt: '2026-09-26T18:00:00.000Z', eventKey: 'gate-red-streak:papercusp',
    holderSessionState: 'live', unknown: null, duplicates: [],
  });
  ownerDirectiveM.mockResolvedValue({ id: 123, workspaceId: 'test-ws', capturedByHook: true,
    sourceTurnRef: 'owner-turn:123', verbatimText: 'Force deploy feedface or bb694a6af028 now.' });
  fireGitSyncM.mockResolvedValue(undefined as never);
  auditUnsafeM.mockImplementation(async (query: string) => query.includes('SELECT w.feature_id')
    ? [{ work_item: 'WI-gate', holder: 'o', taken_at: '2026-09-26T18:00:00.000Z', expires_at: null }]
    : []);
  launchM.mockResolvedValue({ launched: true, unit: 'papercup-auto-deploy', mode: 'trigger', argv: [], logPath: '/tmp/x.log' });
});

describe('release:deploy — orchestration effect classification', () => {
  it('classifies status as read while keeping trigger and force writes', () => {
    const classifier = (tool as unknown as { effectForCall?: (args: { op: string }) => string }).effectForCall;
    expect(classifier).toBeTypeOf('function');
    expect(classifier!({ op: 'status' })).toBe('read');
    expect(classifier!({ op: 'trigger' })).toBe('write');
    expect(classifier!({ op: 'force' })).toBe('write');
  });

  it('explains that an external checkpoint run-lock outranks a not-found manual-unit probe', () => {
    const chaining = (tool as unknown as { guidance?: { chaining?: string } }).guidance?.chaining ?? '';
    expect(chaining).toContain('heldExternally:true');
    expect(chaining).toContain('systemd.appliesToActiveRun:false');
    expect(chaining).toContain('not evidence it ended');
    expect(chaining).toContain('Null or unchanged progressAtMs');
    expect(chaining).toContain('Do not fire a duplicate checkpoint from these fields');
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('release:deploy — status', () => {
  it('returns the full status read-only (no launch)', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        state: 'gate-red',
        canTriggerGreen: false,
        gate: { ...mkStatus().gate, fireStale: false },
        releaseTrigger: {
          ...mkStatus().releaseTrigger,
          cron: '0 */15 * * * *',
          lastFiredAtMs: 1_790_161_000_000,
          nextFireAtMs: 1_790_161_900_000,
          fireStale: true,
          fireStaleReason: 'release-trigger has not fired while green commits are pending',
        },
      }),
    );
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'gate-red' });
    expect(b.gate.fireStale).toBe(false);
    expect(b.releaseTrigger).toMatchObject({
      cron: '0 */15 * * * *',
      lastFiredAtMs: 1_790_161_000_000,
      nextFireAtMs: 1_790_161_900_000,
      fireStale: true,
      fireStaleReason: 'release-trigger has not fired while green commits are pending',
    });
    expect(b.diagnosticVintage).toMatchObject({
      status: 'stale',
      stagingHeadSha: 'staging0head',
      greenPinSha: 'greenpin0',
    });
    expect(b.diagnosticVintage.warning).toContain('Verify any nextVerb');
    expect(statusM).toHaveBeenCalledWith({ readerOwnerId: 'o', onReadProgress: expect.any(Function) });
    expect(launchM).not.toHaveBeenCalled();
  });

  it('preserves an unknown stalled measurement in the full status response', async () => {
    statusM.mockResolvedValue(
      mkStatus({ gate: { ...mkStatus().gate, stalled: null } }),
    );
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b.gate.stalled).toBeNull();
  });

  it('emits registry-derived re-read handles for the gate verdict and deployed SHA', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        gate: { ...mkStatus().gate, consecutiveReds: 2 },
        deploy: { ...mkStatus().deploy, deployedSha: 'deployed-plane-sha' },
      }),
    );
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'su', harnessSlug: 'papercusp' } as never));
    expect(b.plane?.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'gate.consecutiveReds',
          cell: 'gate.greenCheckpoint.verdict',
          reread: { tool: 'state:read', args: { cell: 'gate.greenCheckpoint.verdict' } },
        }),
        expect.objectContaining({
          path: 'deploy.deployedSha',
          cell: 'deploy.3070.sha',
          reread: { tool: 'state:read', args: { cell: 'deploy.3070.sha' } },
        }),
      ]),
    );
  });

  it('returns a structured retryable error when the status read rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    statusM.mockRejectedValue(new Error('pipeline snapshot unavailable'));
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({
      ok: false,
      op: 'status',
      error: { code: 'status_unavailable', retryable: true },
      status: null,
    });
    expect(b.error.message).toContain('pipeline snapshot unavailable');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pipeline snapshot unavailable'));
    expect(launchM).not.toHaveBeenCalled();
  });

  it('returns a bounded structured error when the status read hangs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    statusM.mockImplementation((deps) => {
      if (!deps) throw new Error('status read dependencies are required for this test');
      deps.onReadProgress?.(['snapshot']);
      return new Promise<DeployStatus>(() => {});
    });
    const pending = tool.handler({ op: 'status' } as never, { role: 'cup' } as never);
    await vi.advanceTimersByTimeAsync(RELEASE_STATUS_READ_TIMEOUT_MS);
    const b = body(await pending);
    expect(b).toMatchObject({
      ok: false,
      op: 'status',
      error: {
        code: 'status_timeout',
        retryable: true,
        timeoutMs: RELEASE_STATUS_READ_TIMEOUT_MS,
        pendingReads: ['snapshot'],
      },
      status: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeded 20000ms'));
    expect(launchM).not.toHaveBeenCalled();
  });
});

describe('release:deploy — gate-history (WI-5377)', () => {
  it('reads the last N green_checkpoint ticks and maps each to the lastVerdict shape, plus per-tick failingTests', async () => {
    recentPipelineEventsM.mockResolvedValue([
      {
        id: '3',
        kind: 'green_checkpoint',
        status: 'advanced',
        detail: { candidate: 'cand3', from: 'from3', failingTests: [], logPath: '/tmp/run3.log' },
        createdAtMs: 300,
      },
      {
        id: '2',
        kind: 'green_checkpoint',
        status: 'not-green',
        detail: { candidate: 'cand2', from: 'from2', failingTests: ['pkg/a.test.ts', 'pkg/b.test.ts'], logPath: '/tmp/run2.log' },
        createdAtMs: 200,
      },
      {
        id: '1',
        kind: 'green_checkpoint',
        status: 'advanced',
        detail: { candidate: 'cand1', from: null, failingTests: [], logPath: '/tmp/run1.log' },
        createdAtMs: 100,
      },
    ]);
    const b = body(await tool.handler({ op: 'gate-history' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'gate-history', limit: 6 });
    expect(b.ticks).toEqual([
      { tickAtMs: 300, candidate: 'cand3', from: 'from3', status: 'advanced', failingTests: [], logPath: '/tmp/run3.log' },
      { tickAtMs: 200, candidate: 'cand2', from: 'from2', status: 'not-green', failingTests: ['pkg/a.test.ts', 'pkg/b.test.ts'], logPath: '/tmp/run2.log' },
      { tickAtMs: 100, candidate: 'cand1', from: null, status: 'advanced', failingTests: [], logPath: '/tmp/run1.log' },
    ]);
    // The default limit (6) and a kind filter scoped to green_checkpoint ONLY — an
    // unfiltered read would let interleaved git_sync/deploy rows crowd out real ticks.
    expect(recentPipelineEventsM).toHaveBeenCalledWith('test-home', 6, undefined, { kinds: ['green_checkpoint'] });
  });

  it('forwards a caller-supplied limit instead of the default', async () => {
    recentPipelineEventsM.mockResolvedValue([]);
    await tool.handler({ op: 'gate-history', limit: 20 } as never, { role: 'cup' } as never);
    expect(recentPipelineEventsM).toHaveBeenCalledWith('test-home', 20, undefined, { kinds: ['green_checkpoint'] });
  });

  it('returns an empty ticks array (not an error) when no green_checkpoint tick has ever been recorded', async () => {
    recentPipelineEventsM.mockResolvedValue([]);
    const b = body(await tool.handler({ op: 'gate-history' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'gate-history', ticks: [] });
  });

  it('tolerates a malformed detail blob per-tick (missing/wrong-typed fields never throw)', async () => {
    // Fed newest-first, matching recentPipelineEvents' own real contract (ORDER BY
    // created_at DESC) — the handler trusts that ordering rather than re-sorting.
    recentPipelineEventsM.mockResolvedValue([
      { id: '2', kind: 'green_checkpoint', status: 'error', detail: { failingTests: 'not-an-array', candidate: 42 }, createdAtMs: 200 },
      { id: '1', kind: 'green_checkpoint', status: 'error', detail: {}, createdAtMs: 100 },
    ]);
    const b = body(await tool.handler({ op: 'gate-history' } as never, { role: 'cup' } as never));
    expect(b.ticks).toEqual([
      { tickAtMs: 200, candidate: null, from: null, status: 'error', failingTests: [], logPath: null },
      { tickAtMs: 100, candidate: null, from: null, status: 'error', failingTests: [], logPath: null },
    ]);
  });

  it('never calls readDeployStatus — gate-history is independent of deploy status', async () => {
    recentPipelineEventsM.mockResolvedValue([]);
    await tool.handler({ op: 'gate-history' } as never, { role: 'cup' } as never);
    expect(statusM).not.toHaveBeenCalled();
  });

  it('is classified as a read effect, like status (never gated behind the write/dry-run path)', () => {
    expect(tool.effectForCall!({ op: 'gate-history' } as never)).toBe('read');
  });

  it('REFUSES a harness assertion naming another harness — without reading pipeline events at all', async () => {
    const b = body(
      await tool.handler({ op: 'gate-history', harness: 'sidestage' } as never, { role: 'cup' } as never),
    );
    expect(b).toMatchObject({ ok: false, op: 'gate-history', refused: true });
    expect(b.reason).toContain('harness_not_reportable');
    expect(recentPipelineEventsM).not.toHaveBeenCalled();
  });
});

describe('release:deploy — skipWorkspaceTx (EI-18733783500981433)', () => {
  it('opts out of the ambient workspace tx — trigger/force await fireGitSyncNow + ' +
    'readDeployStatus (tens of seconds) before launching, and never read ctx.tx, so holding ' +
    'one open the whole time hits Postgres\'s idle_in_transaction_session_timeout (60s) and ' +
    'surfaces as a bare CONNECTION_CLOSED even though the deploy itself launched (the exact ' +
    'false-negative EI-18724155280048738 had to work around with the deployInFlight check). ' +
    'Same fix as capability:bash (EI-18666279107998059).', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('release:deploy — timeoutSec (EI-18761103623054929)', () => {
  it('raises the dispatch-stack timeout above the 60s default — trigger/force await ' +
    'fireGitSyncNow, which is NOT bounded by "tens of seconds" under real load: measured live ' +
    '2026-07-26 (60 commits stranded behind 5 consecutive gate reds), 4 of 5 consecutive ' +
    'trigger calls took 83s/96s/177s/61s, each surfacing as a spurious timeout (or transport ' +
    'CONNECTION_CLOSED) past the 60s default even though the deploy launch itself succeeded.', () => {
    expect((tool as unknown as { timeoutSec?: number }).timeoutSec).toBe(300);
    expect((tool as unknown as { timeoutSec?: number }).timeoutSec!).toBeGreaterThan(177);
  });
});

describe('release:deploy — trigger', () => {
  it('refuses a deliberate release-trigger pause and preserves its provenance in the status brief', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        state: 'release-trigger-paused',
        canTriggerGreen: false,
        nothingToDeploy: false,
        releaseTrigger: {
          active: false,
          cron: null,
          lastFiredAtMs: null,
          nextFireAtMs: null,
          pause: {
            reason: 'hold until repaired checkout is green',
            pausedBy: 'su-release-owner',
            pausedAtMs: Date.parse('2026-08-15T09:07:00Z'),
            expiresAtMs: null,
          },
          blocked: true,
          blockReason: 'release-trigger is deliberately paused: hold until repaired checkout is green',
          fireStale: false,
          fireStaleReason: null,
        },
        recommendation: 'Do NOT resume until the repaired checkout is green.',
      }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({
      refused: true,
      status: {
        releaseTrigger: {
          active: false,
          blocked: true,
          pause: { pausedBy: 'su-release-owner' },
        },
      },
    });
    expect(b.reason).toMatch(/release-trigger-paused.*Do NOT resume/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses when the gate is red (no green pin to ship)', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', canTriggerGreen: false }));
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/gate_red/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('dry-run (no confirm) previews but does NOT launch even when green-deployable', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false, deploy: { ...mkStatus().deploy, deployedBehindGreenPin: 2, greenPinSha: 'gp' } }),
    );
    const b = body(await tool.handler({ op: 'trigger' } as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('confirm:true fires a detached GREEN deploy (no force flags)', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false, deploy: { ...mkStatus().deploy, deployedBehindGreenPin: 2 } }),
    );
    const metadata = vi.fn();
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator', metadata } as never));
    expect(b).toMatchObject({ ok: true, launched: true });
    expect(launchM).toHaveBeenCalledWith({}); // green deploy — no force/commit
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      gateActionReceipt: expect.objectContaining({
        action: 'deploy-trigger',
        ownership: expect.objectContaining({ certainty: 'claim-row-locked-through-effect' }),
        effect: expect.objectContaining({ status: 'detached-launch-accepted', deployedSha: 'unknown' }),
      }),
    }));
  });

  it('refuses a confirmed trigger while a live peer owns the gate condition', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false,
      deploy: { ...mkStatus().deploy, deployedBehindGreenPin: 2 } }));
    gateOwnershipM.mockResolvedValue({
      assessment: 'held-live', claimState: 'held', workItem: 'WI-38026', takenBy: 'su-live-peer',
      eventKey: 'gate-red-streak:papercusp', takenAt: '2026-09-26T18:00:00.000Z',
      holderSessionState: 'live', unknown: null, duplicates: [],
    });
    const metadata = vi.fn();
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator', metadata } as never));
    expect(b).toMatchObject({ ok: false, refused: true, reason: 'gate_condition_claimed_by_live_peer' });
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ gateActionReceipt: expect.objectContaining({
      ownership: expect.objectContaining({ certainty: 'prelaunch-observation',
        conditionKey: 'gate-red-streak:papercusp', workItem: 'WI-38026', holder: 'su-live-peer',
        takenAt: '2026-09-26T18:00:00.000Z', claimState: 'held', observedAt: expect.any(String) }),
      effect: { status: 'refused-live-peer' },
    }) }));
    expect(launchM).not.toHaveBeenCalled();
  });

  it('does not launch when the durable pre-effect intent cannot be written', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        state: 'green-deployable',
        canTriggerGreen: true,
        nothingToDeploy: false,
        deploy: { ...mkStatus().deploy, deployedBehindGreenPin: 2 },
      }),
    );
    auditUnsafeM.mockRejectedValue(new Error('audit unavailable'));

    const outcome = await Promise.race([
      tool
        .handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never)
        .then((value) => ({ kind: 'result' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 250)),
    ]);

    expect(outcome.kind).toBe('result');
    if (outcome.kind === 'result') {
      expect(body(outcome.value)).toMatchObject({ ok: false, op: 'trigger', refused: true,
        reason: 'gate_action_intent_unavailable' });
    }
    expect(launchM).not.toHaveBeenCalled();
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
  });

  /**
   * EI-18724155280048738 — the double-trigger hazard. A trigger can return a TRANSPORT error
   * (CONNECTION_CLOSED against PgBouncer :6432) after the handler already launched the deploy;
   * the caller then re-checks, sees `ps` show nothing for ~20s, reads that as "the trigger did
   * nothing", and fires again at the shared release checkout. These lock the surfaces that make
   * the two states distinguishable.
   */
  it('REFUSES a second trigger while a deploy is in flight, and says so definitely', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'deploy-in-flight', canTriggerGreen: false, nothingToDeploy: false, deployInFlight: inFlight() }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/deploy_in_flight/);
    // it must name the running unit and tell the caller their "failed" trigger probably worked
    expect(b.reason).toMatch(/papercup-auto-deploy/);
    expect(b.reason).toMatch(/transport error/i);
    expect(b.reason).toMatch(/do not re-trigger/i);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('the in-flight refusal WINS over the gate-red message (the caller needs their deploy, not a lecture)', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'deploy-in-flight', canTriggerGreen: false, deployInFlight: inFlight() }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.reason).toMatch(/deploy_in_flight/);
    expect(b.reason).not.toMatch(/gate_red/);
  });

  it('op:status surfaces deployInFlight so a caller who lost the reply can re-check authoritatively', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'deploy-in-flight', deployInFlight: inFlight() }));
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'deploy-in-flight' });
    expect((b.deployInFlight as { active: boolean }).active).toBe(true);
  });

  it('op:status surfaces checkpoint candidate/liveness so an auto-refire is not duplicated', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        state: 'gate-verdict-stale',
        checkpointRunInFlight: checkpointRun(),
      }),
    );
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b.checkpointRunInFlight).toMatchObject({
      active: true,
      logPath: '/tmp/papercup-green-checkpoint-manual-demo.log',
      candidate: 'fb941a2c',
      initialCandidate: '80cde64e',
      refireObserved: true,
    });
  });

  it('op:status returns direct capability:read handles for file-backed logs', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        gate: {
          ...mkStatus().gate,
          lastVerdict: {
            tickAtMs: 1,
            candidate: 'candidate0',
            from: 'base0',
            status: 'not-green',
            logPath: '/home/test/.papercusp/checkpoint-logs/verdict.log',
          },
        },
        checkpointRunInFlight: checkpointRun(),
        deployInFlight: inFlight(),
      }),
    );
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b.gate.lastVerdict.read).toEqual({
      tool: 'capability:read',
      args: { file_path: '/home/test/.papercusp/checkpoint-logs/verdict.log', tail: 200 },
    });
    expect(b.checkpointRunInFlight.read).toEqual({
      tool: 'capability:read',
      args: { file_path: '/tmp/papercup-green-checkpoint-manual-demo.log', tail: 200 },
    });
    expect(b.deployInFlight.read).toEqual({
      tool: 'capability:read',
      args: { file_path: '/tmp/papercup-auto-deploy.log', tail: 200 },
    });
  });

  it('a FINISHED deploy does not keep refusing — the normal green trigger still fires', async () => {
    statusM.mockResolvedValue(
      mkStatus({
        state: 'green-deployable',
        canTriggerGreen: true,
        nothingToDeploy: false,
        deployInFlight: inFlight({ active: false, activeState: 'inactive', subState: 'dead' }),
      }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, launched: true });
  });

  it('the success note pre-warns that a transport error still means the deploy LAUNCHED', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false }),
    );
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.note).toMatch(/TRANSPORT ERROR/i);
    expect(b.note).toMatch(/deployInFlight/);
    // and it must disqualify the discriminator that caused the incident
    expect(b.note).toMatch(/\bps\b/);
  });

  it('a duplicate-unit refusal from systemd is reported as the guard working, not as a maybe', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false }),
    );
    launchM.mockResolvedValue({
      launched: false,
      unit: 'papercup-auto-deploy',
      mode: 'trigger',
      argv: [],
      logPath: '/tmp/x.log',
      reason: 'systemd-run exited 1 (a deploy may already be in flight): Unit papercup-auto-deploy.service was already loaded',
    });
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b.launched).toBe(false);
    expect(b.note).toMatch(/already in flight/i);
    expect(b.note).not.toMatch(/likely/i);
    expect(b.note).toMatch(/deployInFlight/);
  });

  // WI-10005763: the launcher's restricted-write fence refuses before spawning deploy-cli. The
  // reply must name the fence and carry its refusal, never tell the caller a deploy is running.
  it('a restricted-hold refusal is reported as the fence, not as a deploy in flight', async () => {
    statusM.mockResolvedValue(
      mkStatus({ state: 'green-deployable', canTriggerGreen: true, nothingToDeploy: false }),
    );
    const restrictedHold = { error: 'restricted_write_held' as const, hint: '1 held restricted write(s) in /repo (a.ts)' };
    launchM.mockResolvedValue({
      launched: false, unit: 'papercup-auto-deploy', mode: 'trigger', argv: [], logPath: '/tmp/x.log',
      reason: 'restricted_write_held', restrictedHold,
    });
    const b = body(await tool.handler({ op: 'trigger', confirm: true } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: false, launched: false, reason: 'restricted_write_held', restricted_hold: restrictedHold });
    expect(b.note).toMatch(/restricted-write fence/);
    expect(b.note).toContain(restrictedHold.hint);
    expect(b.note).not.toMatch(/a deploy is already in flight/i);
  });
});

describe('release:deploy — force (owner-gated)', () => {
  const forceArgs = { op: 'force', reason: 'no-users window: ship the ledger fix', ownerSignoffRef: 'owner-directive:123', acknowledgeRedTests: ['orchestrator/invoke.test'], confirm: true };

  it('is role-gated: a bee cannot force, and no deploy fires', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red' }));
    const b = body(await tool.handler(forceArgs as never, { role: 'cup' } as never));
    expect(b.refused).toBe(true);
    expect(b.reason).toMatch(/role_forbidden/);
    expect(launchM).not.toHaveBeenCalled();
  });

  it('dry-run (no confirm) previews the commit + acknowledged reds, does NOT launch', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', deploy: { ...mkStatus().deploy, stagingHeadSha: 'feedface' } }));
    const b = body(await tool.handler({ ...forceArgs, confirm: false } as never, { role: 'operator' } as never));
    expect(b.dry_run).toBe(true);
    expect(b.would_force_deploy).toMatchObject({ commit: 'feedface' });
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses a confirmed force without a durable owner signoff reference', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', deploy: { ...mkStatus().deploy, stagingHeadSha: 'feedface' } }));
    const { ownerSignoffRef: _omitted, ...missingSignoff } = forceArgs;
    const b = body(await tool.handler(missingSignoff as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: false, refused: true, reason: 'owner_signoff_reference_required' });
    expect(launchM).not.toHaveBeenCalled();
  });

  it('refuses a forged or mismatched force signoff before effect', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red',
      deploy: { ...mkStatus().deploy, stagingHeadSha: 'feedface' } }));
    ownerDirectiveM.mockResolvedValueOnce(null);
    expect(body(await tool.handler(forceArgs as never, { role: 'operator' } as never)))
      .toMatchObject({ refused: true, reason: 'owner_signoff_not_owner_captured' });
    ownerDirectiveM.mockResolvedValueOnce({ id: 123, workspaceId: 'test-ws', capturedByHook: true,
      sourceTurnRef: 'owner-turn:123', verbatimText: 'Force deploy a different commit.' });
    expect(body(await tool.handler(forceArgs as never, { role: 'operator' } as never)))
      .toMatchObject({ refused: true, reason: 'owner_signoff_does_not_name_force_target' });
    expect(launchM).not.toHaveBeenCalled();
  });

  it('confirm:true fires force (un-green commit) AND notifies the owner', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', deploy: { ...mkStatus().deploy, stagingHeadSha: 'feedface' } }));
    launchM.mockResolvedValue({ launched: true, unit: 'papercup-auto-deploy', mode: 'force', commit: 'feedface', argv: [], logPath: '/tmp/x.log' });
    const metadata = vi.fn();
    const b = body(await tool.handler(forceArgs as never, { role: 'operator', metadata } as never));
    expect(b).toMatchObject({ ok: true, launched: true, op: 'force', commit: 'feedface' });
    expect(launchM).toHaveBeenCalledWith({ force: true, commit: 'feedface' });
    expect(notifyM).toHaveBeenCalledTimes(1); // loud owner notification
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      gateActionReceipt: expect.objectContaining({
        action: 'deploy-force', target: expect.objectContaining({ commit: 'feedface', ownerSignoffRef: 'owner-directive:123',
          ownerSignoffAssessment: 'owner-captured-target-matched' }),
        effect: expect.objectContaining({ status: 'detached-launch-accepted', deployedSha: 'unknown' }),
      }),
    }));
  });

  it('an explicit immutable force commit launches without waiting for git-sync', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red' }));
    fireGitSyncM.mockImplementation(() => new Promise(() => {}));
    launchM.mockResolvedValue({
      launched: true,
      unit: 'papercup-auto-deploy',
      mode: 'force',
      commit: 'bb694a6af028',
      argv: [],
      logPath: '/tmp/x.log',
    });

    const b = body(
      await tool.handler(
        { ...forceArgs, commit: 'bb694a6af028' } as never,
        { role: 'operator' } as never,
      ),
    );

    expect(b).toMatchObject({ ok: true, launched: true, op: 'force', commit: 'bb694a6af028' });
    expect(fireGitSyncM).not.toHaveBeenCalled();
    expect(launchM).toHaveBeenCalledWith({ force: true, commit: 'bb694a6af028' });
  });

  // WI-10005763: force does not bypass the restricted-write fence, and the owner is not told a
  // force deploy fired when nothing was started.
  it('a restricted-hold refusal on force names the fence and does not notify the owner', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', deploy: { ...mkStatus().deploy, stagingHeadSha: 'feedface' } }));
    const restrictedHold = { error: 'restricted_hold_state_unknown' as const, hint: 'could not verify (census down)' };
    launchM.mockResolvedValue({
      launched: false, unit: 'papercup-auto-deploy', mode: 'force', commit: 'feedface', argv: [], logPath: '/tmp/x.log',
      reason: 'restricted_hold_state_unknown', restrictedHold,
    });
    const b = body(await tool.handler(forceArgs as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: false, launched: false, op: 'force', restricted_hold: restrictedHold });
    expect(b.note).toMatch(/restricted-write fence/);
    expect(b.note).not.toMatch(/likely a deploy is already in flight/i);
    expect(notifyM).not.toHaveBeenCalled();
  });
});

/**
 * EI-20482937744589016 — the SUBJECT STAMP guards.
 *
 * The defect was a MISATTRIBUTION, not a wrong number: release:deploy reports the
 * operator-HOME pipeline and only that, but its reply carried nothing saying so, so a
 * SideStage-scoped caller received Papercusp SHAs / gate reds / a commit backlog that read
 * exactly like an answer about SideStage. Measured live at HEAD 4824a92b before the fix:
 * `release:deploy {op:status}` called from a `sidestage` session returned the Papercusp
 * pipeline with NO `subject` and NO `harness` field anywhere in the payload — which is why
 * every assertion below necessarily fails against the pre-fix tool (the fields did not exist).
 *
 * `operatorHomeHarnessSlug` is mocked to 'test-home' at the top of this file, so 'test-home'
 * IS the home pipeline for these tests and any other slug is a foreign harness.
 */
describe('release:deploy — subject stamp + cross-harness misattribution (EI-20482937744589016)', () => {
  it('names its subject on op:status — the reply says WHICH pipeline the shas describe', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', canTriggerGreen: false }));
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup' } as never));
    expect(b.subject).toMatchObject({ harness: 'test-home', scope: 'operator-home-release-pipeline' });
    expect(b.subject.integrationRoot).toEqual(expect.any(String));
    expect(b.subject.note).toContain('test-home');
  });

  it('WARNS LOUDLY when the caller\'s own harness is not the reported one', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', canTriggerGreen: false }));
    const b = body(
      await tool.handler({ op: 'status' } as never, { role: 'cup', harnessSlug: 'sidestage' } as never),
    );
    expect(b.harnessMismatch).toMatchObject({ callerHarness: 'sidestage', reportedHarness: 'test-home' });
    // The warning must name BOTH harnesses — the misread it prevents is a reader quoting these
    // numbers as SideStage's release truth.
    expect(b.harnessMismatch.warning).toContain('sidestage');
    expect(b.harnessMismatch.warning).toContain('test-home');
    // ...and the numbers still come back: this is a disclosure, never a refusal to answer.
    expect(b).toMatchObject({ ok: true, state: 'gate-red' });
  });

  it('does NOT claim a mismatch for a same-harness caller, the superuser wildcard, or an unknown slug', async () => {
    statusM.mockResolvedValue(mkStatus());
    for (const ctx of [
      { role: 'cup', harnessSlug: 'test-home' },
      { role: 'cup', harnessSlug: '*' }, // superuser wildcard — cannot assert a mismatch
      { role: 'cup', harnessSlug: '  ' }, // blank
      { role: 'cup' }, // absent
    ]) {
      const b = body(await tool.handler({ op: 'status' } as never, ctx as never));
      expect(b.harnessMismatch).toBeUndefined();
      expect(b.subject.harness).toBe('test-home'); // the stamp still rides, always
    }
  });

  it('canonicalizes a RETIRED caller slug before judging it foreign', async () => {
    statusM.mockResolvedValue(mkStatus());
    const b = body(await tool.handler({ op: 'status' } as never, { role: 'cup', harnessSlug: 'papercup' } as never));
    // 'papercup' is the retired alias of 'papercusp'; the alert must report the CURRENT slug so
    // a reader chasing it does not go looking for a harness that no longer exists.
    expect(b.harnessMismatch.callerHarness).toBe('papercusp');
  });

  it('REFUSES a harness assertion naming another harness — without reading status at all', async () => {
    statusM.mockResolvedValue(mkStatus());
    const b = body(
      await tool.handler({ op: 'status', harness: 'sidestage' } as never, { role: 'cup' } as never),
    );
    expect(b).toMatchObject({ ok: false, refused: true, op: 'status' });
    expect(b.reason).toContain('harness_not_reportable');
    expect(b.reason).toContain('sidestage');
    expect(b.subject.harness).toBe('test-home');
    // Refused BEFORE the work: an unanswerable question must not cost a pipeline read.
    expect(statusM).not.toHaveBeenCalled();
  });

  it('accepts a harness assertion that matches the home pipeline (incl. a retired alias)', async () => {
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red' }));
    const b = body(await tool.handler({ op: 'status', harness: 'test-home' } as never, { role: 'cup' } as never));
    expect(b).toMatchObject({ ok: true, op: 'status', state: 'gate-red' });
    expect(b.refused).toBeUndefined();
  });

  it('REFUSES a foreign harness assertion on the WRITE ops too — no cross-harness deploy by mistake', async () => {
    statusM.mockResolvedValue(mkStatus({ canTriggerGreen: true }));
    const trig = body(
      await tool.handler({ op: 'trigger', harness: 'sidestage', confirm: true } as never, { role: 'operator' } as never),
    );
    expect(trig).toMatchObject({ ok: false, refused: true, op: 'trigger' });
    expect(trig.reason).toContain('harness_not_reportable');
    const forced = body(
      await tool.handler(
        { op: 'force', harness: 'sidestage', reason: 'testing the gate', acknowledgeRedTests: ['x'], confirm: true } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(forced).toMatchObject({ ok: false, refused: true, op: 'force' });
    expect(launchM).not.toHaveBeenCalled();
  });

  it('stamps EVERY exit — degraded envelope, refusal, dry-run and fire all name the subject', async () => {
    const ctx = { role: 'operator', harnessSlug: 'sidestage' } as never;
    const expectStamped = (b: { subject?: { harness?: string }; harnessMismatch?: { callerHarness?: string } }, where: string) => {
      expect(b.subject?.harness, `subject missing on ${where}`).toBe('test-home');
      expect(b.harnessMismatch?.callerHarness, `mismatch missing on ${where}`).toBe('sidestage');
    };

    // 1. degraded status_unavailable envelope — the reply a caller gets when the read fails is
    //    exactly where an unstamped sha would be most confusing.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    statusM.mockRejectedValue(new Error('snapshot unavailable'));
    expectStamped(body(await tool.handler({ op: 'status' } as never, ctx)), 'status_unavailable');

    // 2. trigger refusal (gate red — nothing green to ship)
    statusM.mockResolvedValue(mkStatus({ state: 'gate-red', canTriggerGreen: false }));
    expectStamped(body(await tool.handler({ op: 'trigger', confirm: true } as never, ctx)), 'trigger refusal');

    // 3. trigger dry-run
    statusM.mockResolvedValue(mkStatus({ canTriggerGreen: true }));
    expectStamped(body(await tool.handler({ op: 'trigger' } as never, ctx)), 'trigger dry-run');

    // 4. trigger fire
    expectStamped(body(await tool.handler({ op: 'trigger', confirm: true } as never, ctx)), 'trigger fire');

    // 5. force role refusal
    expectStamped(
      body(
        await tool.handler(
          { op: 'force', reason: 'testing the gate', acknowledgeRedTests: ['x'] } as never,
          { role: 'cup', harnessSlug: 'sidestage' } as never,
        ),
      ),
      'force role_forbidden',
    );

    // 6. force dry-run
    expectStamped(
      body(
        await tool.handler(
          { op: 'force', reason: 'testing the gate', acknowledgeRedTests: ['x'] } as never,
          ctx,
        ),
      ),
      'force dry-run',
    );

    // 7. force fire
    expectStamped(
      body(
        await tool.handler(
          { op: 'force', reason: 'testing the gate', acknowledgeRedTests: ['x'], confirm: true } as never,
          ctx,
        ),
      ),
      'force fire',
    );
  });
});
