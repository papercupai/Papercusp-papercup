/**
 * WI-1912: the `states` arg on the pull tools (scheduler:get_next /
 * work_items:claim_next) must not widen past the resolver-owned floors.
 *
 * A backlog-clearance fleet member passed states:['todo','open','blocked'] and
 * get_next surfaced WI-1591 — a `blocked`, leader-triage-only item — into their
 * pull loop. The claim-spec validator rejects a `blocked` filter TERM precisely
 * so a spec can never un-floor itself (D-002), but the sibling free-string
 * `states` arg re-opened the identical hole at the tool boundary. These tests
 * pin the clamp: `states` accepts only CLAIM_STATES_ALLOWLIST members.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { BUDGET, promptWeight } from '../tool-guidance-budget';

const scopeState = vi.hoisted(() => ({
  scope: null as any,
  quarantinedIds: [] as string[],
  fleetAssignmentRows: undefined as unknown[] | undefined,
  windingDown: false,
  pauseReason: null as string | null,
}));
const getNextM = vi.hoisted(() => vi.fn());
const diagnoseClaimNextMissM = vi.hoisted(() =>
  vi.fn(async () => ({
    drained: true,
    pendingUnclaimed: 0,
    readyUnclaimed: 0,
    flagReadError: null as string | null,
  })),
);
const aggregateIssueClaimExclusionsM = vi.hoisted(() =>
  vi.fn(async () => ({
    matchedByFilter: 0,
    claimable: 0,
    excluded: {} as Record<string, number>,
    queueControl: { pendingAgentReview: 0 },
  })),
);
type TestClaimSpecRecord = {
  source: 'default' | 'cup' | 'fleet';
  spec: { specId: string; revision: number; view?: { filter?: unknown } };
  revision: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
  fleetSlug?: string;
};
const getClaimSpecRecordM = vi.hoisted(() =>
  vi.fn(
    async (): Promise<TestClaimSpecRecord> => ({
      source: 'default',
      spec: { specId: 'default', revision: 0 },
      revision: null,
      updatedBy: null,
      updatedAt: null,
    }),
  ),
);
const getSessionBriefM = vi.hoisted(() =>
  vi.fn(
    async () =>
      null as {
        workspaceId?: string | null;
        harnessSlug?: string | null;
      } | null,
  ),
);
const getActiveClaimForOwnerM = vi.hoisted(() => vi.fn(async () => null));
// EI-16057: registry contents the harness-existence gate checks against — 'papercusp'
// is the only registered slug by default so every pre-existing test (which all pass
// `harness: 'papercusp'`) keeps resolving; the dedicated describe block below swaps
// this to exercise the harness_not_found path.
const registryState = vi.hoisted(() => ({ projects: [{ slug: 'papercusp' }] as Array<{ slug: string }> }));
const loadHarnessRegistryM = vi.hoisted(() => vi.fn(async () => ({ projects: registryState.projects })));
// EI-15777: the paused-miss branch cancels the caller's own standing
// `work-item:claimable` await(s) — mock the store call so these unit tests never
// touch real PG, and so tests below can assert it was invoked (self-scoped, by ownerId).
const cancelClaimableAwaitsM = vi.hoisted(() => vi.fn(async () => 0));
type LiveLockPhaseEventForTest = { phase: string; state: 'start' | 'end'; durationMs?: number };
type LiveLockPathsOptionsForTest = { onPhase?: (event: LiveLockPhaseEventForTest) => void };
const liveLockedPathsM = vi.hoisted(() => vi.fn(async (_options?: LiveLockPathsOptionsForTest) => [] as string[]));
const getFlagM = vi.hoisted(() => vi.fn(async () => true));
const resolveContextPressureRecoveryPathM = vi.hoisted(() => vi.fn(async () => ({
  path: 'self-compaction' as const,
  selfCompactionAvailable: true,
  carryNoteVerified: null,
  reason: 'host-backed' as const,
})));
const resolveContextPressureHeadroomM = vi.hoisted(() => vi.fn(async () => ({
  contextTokens: null,
  softLimit: null,
  selfSetCeiling: null,
})));
const autoBenchContextCriticalCallerM = vi.hoisted(() => vi.fn(async () => null as {
  benched: boolean;
  reason: string;
  wakeEvent: string | null;
} | null));
// Keep the timeout tests focused on the scheduler claim watchdog. These preflight reads were
// added after the original regression and otherwise fall through to the live org pool, where a
// fake-timer test can sit on a connection acquisition instead of reaching the claim timeout.
const fetchContextPressureM = vi.hoisted(() => vi.fn(async () => new Map()));
const readGoalHolderAuthorityM = vi.hoisted(() => vi.fn(async () => null));
const reconcileFleetScopeClaimsM = vi.hoisted(() => vi.fn());
const readFleetPauseStateM = vi.hoisted(() => vi.fn());
const diagnoseFleetScopeIssueFloorMissM = vi.hoisted(() => vi.fn(async () => null));
const diagnoseFleetScopePlanTerminalityM = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      planSlugs: string[];
      terminalPlanSlugs: string[];
      allTerminal: boolean;
    } | null> => null,
  ),
);
const diagnoseFleetScopeLeaderLivenessM = vi.hoisted(() => vi.fn(async () => null as boolean | null));
const reconcileFleetScopeLeaderSuccessionM = vi.hoisted(() => vi.fn(async () => null as 'live' | 'unavailable' | null));
const workItemClaimLeaseEnabledM = vi.hoisted(() => vi.fn(() => false));
const leaseClaimedWorkItemM = vi.hoisted(() => vi.fn(async () => true));
const releaseWorkItemM = vi.hoisted(() => vi.fn(async () => undefined));
const readClaimConcurrencyM = vi.hoisted(() =>
  vi.fn(async () => ({ blocked: false, activeClaims: 0, maxConcurrentClaims: 1, heldIds: [] as string[] })),
);
const clearClaimSpecM = vi.hoisted(() => vi.fn(async () => ({ ok: true, errors: [] as string[], cleared: true })));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-member', workspaceId: 'ws-1' }),
}));
vi.mock('../../session-brief', () => ({
  getSessionBrief: getSessionBriefM,
}));
vi.mock('../../work-item-claims', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveClaimForOwner: getActiveClaimForOwnerM,
}));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: loadHarnessRegistryM,
}));
vi.mock('../../events/await/store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cancelClaimableAwaits: cancelClaimableAwaitsM,
}));
vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: workItemClaimLeaseEnabledM,
  leaseClaimedWorkItem: leaseClaimedWorkItemM,
}));
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  releaseWorkItem: releaseWorkItemM,
  diagnoseClaimNextMiss: diagnoseClaimNextMissM,
}));
vi.mock('../../scheduler/get-next', () => ({
  aggregateIssueClaimExclusions: aggregateIssueClaimExclusionsM,
}));
vi.mock('../locks/live-lock-paths', () => ({
  liveLockedPaths: liveLockedPathsM,
}));
// EI-20099413453852234: a successful claim now declares the caller's intent, which is a
// presence WRITE — mocked here for the same reason as cancelClaimableAwaits above, so these
// unit tests never touch real PG, and so the block below can assert exactly what was written.
const getPresenceM = vi.hoisted(() => vi.fn(async (_ownerId?: string) => null as unknown));
// The parameters are DECLARED even though the body ignores them: a bare `vi.fn(async () => {})`
// types `mock.calls` as the empty tuple `[]`, so asserting on `calls[0][1]` (the PresenceInput
// this test exists to inspect) is TS2493 — caught by lint:tsc, never by vitest.
const writePresenceM = vi.hoisted(() =>
  vi.fn(async (_identity?: unknown, _input?: Record<string, unknown>, _harness?: unknown) => {}),
);
// EI-21834503221873518: the post-claim enrichment regression deliberately hangs this
// dynamically imported recall seam. Keep the rest of the suite off real memory/PG I/O
// and make the fake-timer test exercise the production timeout boundary directly.
const buildClaimRecallBlockM = vi.hoisted(() => vi.fn(async () => null as string | null));
const planTerminalityInWorkspaceM = vi.hoisted(() =>
  vi.fn(async () => null as { status: string | null; hasOpenItems: boolean } | null),
);
const planHarnessesForSlugsM = vi.hoisted(() => vi.fn(async () => new Map<string, string[]>()));
const gateWorkScopeM = vi.hoisted(() => vi.fn(async () => ({ allowed: true, reason: 'no-policy' })));
// PARTIAL mock, deliberately: this module also exports PRESENCE_STALE_MS, which
// presence-wakeability.ts -> fleet-roster.ts imports transitively. A whole-module factory
// drops it and the mock fails at import time rather than in a test.
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPresence: getPresenceM,
  writePresence: writePresenceM,
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFlag: getFlagM,
}));
vi.mock('../coordination/context-pressure', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchContextPressure: fetchContextPressureM,
  fetchContextPressureReadings: fetchContextPressureM,
  resolveContextPressureRecoveryPath: resolveContextPressureRecoveryPathM,
  resolveContextPressureHeadroom: resolveContextPressureHeadroomM,
}));
vi.mock('../../fleet/context-critical-bench', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  autoBenchContextCriticalCaller: autoBenchContextCriticalCallerM,
}));
vi.mock('../../goals/holder-authority', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGoalHolderAuthority: readGoalHolderAuthorityM,
}));
// The mocked authority reader ignores its SQL argument. Supplying that argument
// must not acquire a real pool before the mock is reached.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: () => { throw new Error('Unexpected SQL in scheduler handler unit tests'); } }),
}));
// WI-6554700010011595: real claim-time enrichment modules fail soft against the throwing
// getOrgPg above and record fallback observations. Their buffer flushes on a real 2 s timer
// through that same throwing SQL, and the flush's console.warn fails whichever test is
// running (vitest-fail-on-console) — measured: a cold run of one success-path test took
// 10.97 s and went red on the warn; a 2,182 ms full-file run went red on an unrelated test.
// No test here asserts fallback telemetry, so record nothing.
vi.mock('../../degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  observeFallback: vi.fn(() => true),
}));
// The work-scope gate is a pure allow/deny decision for this scheduler suite. Mocking the
// dynamically imported module keeps its pot-control-policy sync listener (and its real PG
// connection) out of fake-timer tests, so a missing local database cannot become an unrelated
// console error after the timeout watchdog settles.
vi.mock('../../work-scope-policy', () => ({
  gateWorkScope: gateWorkScopeM,
  workScopeRefusal: vi.fn(),
}));
vi.mock('../../memory/claim-port', () => ({
  buildClaimRecallBlock: buildClaimRecallBlockM,
}));
vi.mock('../plans/source', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planTerminalityInWorkspace: planTerminalityInWorkspaceM,
  planHarnessesForSlugs: planHarnessesForSlugsM,
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return {
    ...actual,
    getNextForBee: getNextM,
    getClaimSpecRecord: getClaimSpecRecordM,
    clearClaimSpec: clearClaimSpecM,
    readClaimConcurrency: readClaimConcurrencyM,
  };
});
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: reconcileFleetScopeClaimsM,
  readFleetPauseState: readFleetPauseStateM,
  // EI-13520: real fn returns null (no cooldown-diagnosis signal) by default — these tests
  // don't exercise the cooldown-attribution path, only fleetScopedMiss's existing shapes.
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  // WI-5561: real fn returns null (no issue-floor-breakdown signal) by default — these tests
  // don't exercise the issue-floor-breakdown path, only fleetScopedMiss's existing shapes.
  diagnoseFleetScopeIssueFloorMiss: diagnoseFleetScopeIssueFloorMissM,
  // WI-7151: only ever reached when a breakdown reports matchedByFilter===0 (the issueFloorMiss
  // mock above always returns null, so this path is unreachable here) — defensive stub only.
  diagnoseFleetScopeFeatureFamilyExclusions: vi.fn(async () => null),
  // EI-20260781488788952: the zero-match enrichment reads these diagnostics alongside the
  // existing family/exhaustion seams; keep this mock's module shape aligned with production.
  diagnoseFleetScopePlanTerminality: diagnoseFleetScopePlanTerminalityM,
  diagnoseFleetScopeLeaderLiveness: diagnoseFleetScopeLeaderLivenessM,
  reconcileFleetScopeLeaderSuccession: reconcileFleetScopeLeaderSuccessionM,
  fleetLeaderUnavailableRefusal: (scope: any) => ({
    ok: false,
    error: 'fleet_leader_unavailable',
    recoverable: true,
    leaderLiveness: false,
    noClaim: true,
    windDown: false,
    fleetScope: { fleet: scope.fleetSlug, member: scope.ownerId },
    recovery: { tool: 'fleet:take-leadership', args: { fleet: scope.fleetSlug } },
    advice: `Recover '${scope.fleetSlug}' and retry scheduler:get_next.`,
  }),
  fleetScopedMiss: (
    scope: any,
    quarantinedIds: string[],
    opts?: {
      pausedReason?: string | null;
      cooldownDiag?: { cooldownExcluded: number; earliestExpiryMs: number | null } | null;
      claimableAwaitsCancelled?: number;
      issueBreakdown?: unknown;
      planTerminality?: { allTerminal?: boolean; planSlugs?: string[]; terminalPlanSlugs?: string[] } | null;
      harness?: string;
    },
  ) => ({
    ok: false,
    error:
      opts?.pausedReason !== undefined
        ? `paused: ${opts.pausedReason ?? ''}`
        : opts?.cooldownDiag
          ? `cooldown-only miss; ${opts.cooldownDiag.cooldownExcluded} excluded`
          : opts?.planTerminality?.allTerminal
            ? 'plan complete; stand down'
            : opts?.issueBreakdown
              ? 'floor-gated miss (WI-5561); see excludedBreakdownSummary'
              : 'scoped miss; no generic fallback',
    fleetScope: { fleet: scope.fleetSlug, source: scope.record.source },
    quarantinedIds,
    windDown: true,
    ...(opts?.planTerminality?.allTerminal ? { reason: 'plan_complete', planTerminality: opts.planTerminality } : {}),
    ...(opts?.pausedReason !== undefined ? { paused: true } : {}),
    ...(opts?.pausedReason !== undefined ? { claimableAwaitsCancelled: opts?.claimableAwaitsCancelled ?? 0 } : {}),
    ...(opts?.cooldownDiag ? { cooldownOnly: true } : {}),
    ...(opts?.issueBreakdown ? { excludedBreakdown: opts.issueBreakdown } : {}),
  }),
}));

import getNextTool, {
  GET_NEXT_BUDGET_MS,
  GET_NEXT_ISSUE_DIAG_BUDGET_MS,
  GET_NEXT_TIMEOUT_RECONCILIATION_BUDGET_MS,
  GET_NEXT_TOTAL_BUDGET_MS,
  plansStartExactPlanBinding,
} from './get_next';
import claimNextTool from '../work_items/claim_next';
import { CLAIM_STATES_ALLOWLIST } from '../../work-items';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import {
  acceptanceReadinessHold,
  findOrFileAcceptanceRepairTask,
  incompleteAcceptanceBarsForItems,
  type AcceptanceReadinessHoldDeps,
  type AcceptanceRepairTaskInput,
  type RepairTaskStore,
  type RepairTaskTx,
} from '../../scheduler/acceptance-readiness-hold';

function handlerPayload(out: unknown): Record<string, unknown> {
  const response = out as { data?: unknown; content?: Array<{ text?: string }> };
  if (response.data !== undefined) return response.data as Record<string, unknown>;
  return JSON.parse(response.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  // clearAllMocks() resets call history but deliberately preserves queued
  // mockResolvedValueOnce entries. Reinstall the defaults explicitly so a
  // one-shot branch test cannot leak into the next describe block.
  scopeState.fleetAssignmentRows = undefined;
  diagnoseFleetScopeLeaderLivenessM.mockReset();
  diagnoseFleetScopeLeaderLivenessM.mockResolvedValue(null);
  reconcileFleetScopeLeaderSuccessionM.mockReset();
  reconcileFleetScopeLeaderSuccessionM.mockResolvedValue(null);
  reconcileFleetScopeClaimsM.mockImplementation(async () => ({
    scope: scopeState.scope,
    quarantinedIds: scopeState.quarantinedIds,
    ...(scopeState.fleetAssignmentRows ? { fleetAssignmentRows: scopeState.fleetAssignmentRows } : {}),
  }));
  readFleetPauseStateM.mockImplementation(async () => ({
    windingDown: scopeState.windingDown,
    reason: scopeState.pauseReason,
  }));
  diagnoseFleetScopeIssueFloorMissM.mockResolvedValue(null);
  diagnoseFleetScopePlanTerminalityM.mockResolvedValue(null);
  getFlagM.mockResolvedValue(true);
  fetchContextPressureM.mockResolvedValue(new Map());
  resolveContextPressureRecoveryPathM.mockResolvedValue({
    path: 'self-compaction',
    selfCompactionAvailable: true,
    carryNoteVerified: null,
    reason: 'host-backed',
  });
  resolveContextPressureHeadroomM.mockResolvedValue({
    contextTokens: null,
    softLimit: null,
    selfSetCeiling: null,
  });
  autoBenchContextCriticalCallerM.mockResolvedValue(null);
  readGoalHolderAuthorityM.mockResolvedValue(null);
  liveLockedPathsM.mockImplementation(async () => []);
  getPresenceM.mockResolvedValue(null);
  writePresenceM.mockResolvedValue(undefined);
  buildClaimRecallBlockM.mockResolvedValue(null);
  planTerminalityInWorkspaceM.mockResolvedValue(null);
  getClaimSpecRecordM.mockResolvedValue({
    source: 'default',
    spec: { specId: 'default', revision: 0 },
    revision: null,
    updatedBy: null,
    updatedAt: null,
  });
  workItemClaimLeaseEnabledM.mockReturnValue(false);
  leaseClaimedWorkItemM.mockResolvedValue(true);
  releaseWorkItemM.mockResolvedValue(undefined);
  clearClaimSpecM.mockResolvedValue({ ok: true, errors: [], cleared: true });
  readClaimConcurrencyM.mockReset();
  readClaimConcurrencyM.mockResolvedValue({ blocked: false, activeClaims: 0, maxConcurrentClaims: 1, heldIds: [] });
});

describe('plansStartExactPlanBinding — automatic cleanup stays narrower than arbitrary plan filters', () => {
  it('recognizes both exact shapes plans:start authors', () => {
    expect(
      plansStartExactPlanBinding({
        specId: 'plans-start-finished-plan',
        view: { filter: { field: 'plan', op: '=', value: 'finished-plan' } },
      }),
    ).toBe('finished-plan');
    expect(
      plansStartExactPlanBinding({
        specId: 'plans-start-finished-plan',
        view: {
          filter: {
            all: [
              { field: 'plan', op: '=', value: 'finished-plan' },
              { field: 'kind', op: 'in', value: ['bug', 'change'] },
            ],
          },
        },
      }),
    ).toBe('finished-plan');
  });

  it('rejects a user-authored union that still has a live non-plan branch', () => {
    expect(
      plansStartExactPlanBinding({
        specId: 'plans-start-finished-plan',
        view: {
          filter: {
            any: [
              { field: 'plan', op: '=', value: 'finished-plan' },
              { field: 'id', op: 'in', value: ['EI-still-live'] },
            ],
          },
        },
      }),
    ).toBeNull();
  });
});

describe('scheduler:get_next ambient transaction reservation', () => {
  it('opts out because the self-pull handler owns its DB accessors', () => {
    expect((getNextTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

const TOOLS: Array<{ name: string; args: ZodTypeAny }> = [
  { name: 'scheduler:get_next', args: (getNextTool as { args: ZodTypeAny }).args },
  { name: 'work_items:claim_next', args: (claimNextTool as { args: ZodTypeAny }).args },
];

describe('scheduler:get_next records early refusal dispositions (EI-25880074393060687)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getSessionBriefM.mockResolvedValue(null);
    getActiveClaimForOwnerM.mockResolvedValue(null);
    getNextM.mockResolvedValue(null);
    readClaimConcurrencyM.mockResolvedValue({ blocked: false, activeClaims: 0, maxConcurrentClaims: 1, heldIds: [] });
  });

  it('records an unresolved harness refusal without inventing a spec or claim', async () => {
    const metadata = vi.fn();
    const out = await getNextTool.handler({}, { metadata } as never);
    expect(handlerPayload(out)).toMatchObject({ error: 'harness_required' });
    expect(getNextM).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenLastCalledWith({
      schedulerDisposition: { kind: 'no-claim', reason: 'missing' },
    });
  });

  it.each(['paused', 'leader-unavailable', 'plan-complete'] as const)(
    'records the %s preflight refusal against its resolved fleet revision',
    async (branch) => {
      scopeState.scope = {
        ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member',
        record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 }, revision: 4 },
      };
      if (branch === 'paused') {
        scopeState.windingDown = true;
        scopeState.pauseReason = 'owner paused';
      } else if (branch === 'leader-unavailable') {
        reconcileFleetScopeLeaderSuccessionM.mockResolvedValue('unavailable');
      } else {
        diagnoseFleetScopePlanTerminalityM.mockResolvedValue({
          planSlugs: ['finished'], terminalPlanSlugs: ['finished'], allTerminal: true,
        });
      }
      const metadata = vi.fn();
      const out = await getNextTool.handler({ harness: 'papercusp' }, { metadata } as never);
      const payload = handlerPayload(out);
      expect(payload.ok).toBe(false);
      expect(getNextM).not.toHaveBeenCalled();
      expect(metadata).toHaveBeenLastCalledWith({
        schedulerDisposition: {
          kind: 'no-claim', reason: payload.reason ?? payload.error,
          specId: 'bugs-rev4', revision: 4,
        },
      });
    },
  );

  it('records a declared-plan refusal before selection', async () => {
    getPresenceM.mockResolvedValue({ currentPlanSlug: 'active-control-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'active', hasOpenItems: true });
    const metadata = vi.fn();
    const out = await getNextTool.handler({ harness: 'papercusp' }, { metadata } as never);
    expect(handlerPayload(out)).toMatchObject({ error: 'plan_scope_missing' });
    expect(getNextM).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenLastCalledWith({
      schedulerDisposition: { kind: 'no-claim', reason: 'declared_plan_without_claim_spec' },
    });
  });

  it('records a concurrency refusal without counting an existing hold as a new claim', async () => {
    scopeState.scope = {
      ownerId: 'su-member', fleetSlug: 'bugs', fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 }, revision: 4 },
    };
    readClaimConcurrencyM.mockResolvedValue({
      blocked: true, activeClaims: 1, maxConcurrentClaims: 1, heldIds: ['WI-already-held'],
    });
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup', spec: { specId: 'bugs-rev4', revision: 4 }, revision: 4,
      updatedBy: null, updatedAt: null,
    });
    const metadata = vi.fn();
    const out = await getNextTool.handler({ harness: 'papercusp' }, { metadata } as never);
    const payload = handlerPayload(out);
    expect(payload).toMatchObject({ diagnosis: { concurrencyBlocked: true } });
    expect(metadata).toHaveBeenLastCalledWith({
      schedulerDisposition: {
        kind: 'no-claim', reason: String(payload.reason ?? payload.error).slice(0, 500),
        specId: 'bugs-rev4', revision: 4,
      },
    });
  });
});

describe('scheduler:get_next claim-spec identity is inherited (EI-20225786201327575)', () => {
  it('teaches the accepted call shape and keeps spec identity read-only', () => {
    const tool = getNextTool as { args: ZodTypeAny; description?: string; guidance?: { when?: string } };
    expect(tool.description).toContain('specId and revision are result provenance, not request arguments');
    expect(tool.description).toContain("successful claim also declares the caller's WI-/EI- intent");
    expect(tool.guidance?.when).toContain('do NOT pass specId, revision, fleet, workspace, or claimSpec');
    expect(tool.guidance?.when).toContain('claimedUnder');

    for (const [field, value] of [
      ['specId', 'nonp2p-bug-drain-headless-0812'],
      ['revision', 1],
      ['fleet', 'nonp2p-bug-drain-headless-0812'],
      ['workspace', 'papercusp-workspace'],
      ['claimSpec', { specId: 'lane', revision: 1 }],
      ['limit', 1],
    ] as const) {
      const result = tool.args.safeParse({ harness: 'papercusp', [field]: value });
      expect(result.success, `scheduler:get_next must reject undeclared ${field}`).toBe(false);
    }
  });
});

describe('scheduler:get_next prompt guidance budget (EI-20226961413829051)', () => {
  it('stays within the shared non-grandfathered prompt-weight budget', () => {
    expect(promptWeight(getNextTool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });
});

describe('scheduler:get_next derives harness from the bound session (WI-38059)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
    getSessionBriefM.mockResolvedValue(null);
  });

  it('advertises an optional harness and passes the bound session harness to the claim path', async () => {
    const tool = getNextTool as { args: ZodTypeAny; description?: string };
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.description).toContain('specId and revision are result provenance');

    const out = (await getNextTool.handler({}, { harnessSlug: 'papercusp' } as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, windDown: true });
    expect(getNextM).toHaveBeenCalledOnce();
    expect(getNextM.mock.calls[0]?.[0]).toMatchObject({
      harness: 'papercusp',
      useDedicatedClaimPool: true,
    });
  });

  it('returns a typed harness_required error when neither the call nor session supplies one', async () => {
    const out = (await getNextTool.handler({}, {} as never)) as { content: Array<{ text: string }>; isError?: boolean };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, error: 'harness_required' });
    expect(out.isError).toBe(true);
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('resolves the durable session harness when transport context carries the unscoped sentinel', async () => {
    getSessionBriefM.mockResolvedValue({ workspaceId: 'ws-1', harnessSlug: 'papercusp' });

    const out = (await getNextTool.handler({}, { harnessSlug: '*' } as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0].text);

    expect(body).toMatchObject({ ok: false, windDown: true });
    expect(getSessionBriefM).toHaveBeenCalledWith({ ownerId: 'su-member' });
    expect(getNextM).toHaveBeenCalledOnce();
    expect(getNextM.mock.calls[0]?.[0]).toMatchObject({ harness: 'papercusp' });
  });

  it('does not pass the unscoped sentinel downstream when no durable harness exists', async () => {
    const out = (await getNextTool.handler({}, { harnessSlug: '*' } as never)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const body = JSON.parse(out.content[0].text);

    expect(body).toMatchObject({ ok: false, error: 'harness_required' });
    expect(out.isError).toBe(true);
    expect(getNextM).not.toHaveBeenCalled();
  });
});

describe('pull-tool `states` arg is clamped to the claimable allowlist (WI-1912)', () => {
  it('exposes the expected allowlist (open/failing — feature `todo` retired, floors + terminals excluded)', () => {
    expect([...CLAIM_STATES_ALLOWLIST]).toEqual(['open', 'failing']);
  });

  it('accepts every allowlisted state', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: [...CLAIM_STATES_ALLOWLIST] });
      expect(r.success, `${name} should accept states:${JSON.stringify(CLAIM_STATES_ALLOWLIST)}`).toBe(true);
    }
  });

  it('accepts an omitted `states` (the ["open"] default)', () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp' });
      expect(r.success, `${name} should accept omitted states`).toBe(true);
    }
  });

  it('REJECTS floor-protected and terminal states — the WI-1912 widening', () => {
    for (const { name, args } of TOOLS) {
      for (const bad of [
        'blocked',
        'cursed',
        'in_progress',
        'passed',
        'resolved',
        'closed',
        'deprecated',
        'needs-human',
        'todo',
      ]) {
        const r = args.safeParse({ harness: 'papercusp', states: ['open', bad] });
        expect(r.success, `${name} must reject states:['open','${bad}']`).toBe(false);
      }
    }
  });

  it("REJECTS the exact observed widening args (states:['todo','open','blocked'])", () => {
    for (const { name, args } of TOOLS) {
      const r = args.safeParse({ harness: 'papercusp', states: ['todo', 'open', 'blocked'] });
      expect(r.success, `${name} must reject the WI-1912 repro args`).toBe(false);
    }
  });
});

describe('scheduler:get_next hard fleet boundary (P-016)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.fleetAssignmentRows = undefined;
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
  });

  it('refuses a member with no explicit/inherited spec before generic selection', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'default', spec: { specId: 'default', revision: 0 } },
    };
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, fleetScope: { fleet: 'bugs', source: 'default' } });
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('returns a scoped wind-down verdict on miss, including the one-pass quarantine result', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.quarantinedIds = ['WI-out'];
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, quarantinedIds: ['WI-out'] });
    expect(getNextM).toHaveBeenCalledOnce();
  });

  // EI-12832: a member woken during a fleet pause (control_state='winding-down')
  // must stand down — the self-select path floors BEFORE it pulls, whatever the spec matches.
  it('EI-12832: a winding-down fleet floors self-select — paused miss, no pull', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.windingDown = true;
    scopeState.pauseReason = 'owner pause';
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true, paused: true });
    expect(getNextM).not.toHaveBeenCalled();
    // EI-15777: the paused-miss branch must cancel the caller's OWN standing
    // work-item:claimable await(s) (self-scoped by ownerId) so a compliant peer
    // stand-down doesn't keep re-waking this member on a pull it's forbidden to make.
    expect(cancelClaimableAwaitsM).toHaveBeenCalledWith('su-member', { includeStanding: true });
  });

  it('EI-21079515303301272: blocks an active member before claim when its registered leader is not live', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'leaderless-fleet',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'leaderless-rev4', revision: 4 } },
    };
    reconcileFleetScopeLeaderSuccessionM.mockResolvedValueOnce('unavailable');
    getNextM.mockResolvedValue({ workItem: { id: 'WI-must-not-claim' } });

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({
      ok: false,
      error: 'fleet_leader_unavailable',
      noClaim: true,
      recoverable: true,
      leaderLiveness: false,
      windDown: false,
      recovery: { tool: 'fleet:take-leadership', args: { fleet: 'leaderless-fleet' } },
    });
    expect(body.advice).toMatch(/retry scheduler:get_next/);
    expect(reconcileFleetScopeLeaderSuccessionM).toHaveBeenCalledWith({
      scope: scopeState.scope,
      identity: expect.objectContaining({ ownerId: 'su-member' }),
      resumeLeader: expect.any(Function),
    });
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('keeps the self-pull path fail-open when leader liveness is unreadable', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'leader-read-error-fleet',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'lane-rev4', revision: 4 } },
    };
    reconcileFleetScopeLeaderSuccessionM.mockResolvedValue(null);
    getNextM.mockResolvedValue(null);

    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);

    expect(getNextM).toHaveBeenCalledOnce();
  });

  it('allows the scoped pull through after succession reconciles a live leader', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'snapshot-fleet',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'lane-rev4', revision: 4 } },
    };
    scopeState.fleetAssignmentRows = [{ agentId: 'su-leader' }];
    reconcileFleetScopeLeaderSuccessionM.mockResolvedValueOnce('live');
    getNextM.mockResolvedValue({
      workItem: { id: 'WI-after-succession', title: 'Successor leader resumed the fleet pull' },
      claimedUnder: { specId: 'lane-rev4', revision: 4 },
    });

    const out = await getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as {
      data?: unknown;
      content?: Array<{ text?: string }>;
    };

    expect(reconcileFleetScopeLeaderSuccessionM).toHaveBeenCalledWith({
      scope: scopeState.scope,
      identity: expect.objectContaining({ ownerId: 'su-member' }),
      resumeLeader: expect.any(Function),
    });
    expect(getNextM).toHaveBeenCalledOnce();
    expect(handlerPayload(out)).toMatchObject({
      ok: true,
      workItem: { id: 'WI-after-succession' },
      claimedUnder: { specId: 'lane-rev4', revision: 4 },
    });
  });

  it('winds down a terminal plan before routing a dead leader into a takeover', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'finished-fleet',
      fleetRole: 'member',
      record: {
        source: 'fleet',
        spec: {
          specId: 'finished-plan-rev4',
          revision: 4,
          view: { filter: { field: 'plan', op: '=', value: 'finished-plan' } },
        },
      },
    };
    const planTerminality = {
      planSlugs: ['finished-plan'],
      terminalPlanSlugs: ['finished-plan'],
      allTerminal: true,
    };
    diagnoseFleetScopePlanTerminalityM.mockResolvedValueOnce(planTerminality);
    // The terminal-plan branch must short-circuit before leader-liveness. Keep
    // this fallback one-shot so the following describes retain their default
    // unreadable (fail-open) liveness result.
    diagnoseFleetScopeLeaderLivenessM.mockResolvedValueOnce(false);
    getNextM.mockResolvedValue({ workItem: { id: 'WI-must-not-claim' } });

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({
      ok: false,
      reason: 'plan_complete',
      windDown: true,
      planTerminality,
    });
    expect(diagnoseFleetScopePlanTerminalityM).toHaveBeenCalledWith({ scope: scopeState.scope });
    expect(diagnoseFleetScopeLeaderLivenessM).not.toHaveBeenCalled();
    expect(reconcileFleetScopeLeaderSuccessionM).not.toHaveBeenCalled();
    expect(getNextM).not.toHaveBeenCalled();
  });
});

describe('scheduler:get_next declared-plan boundary (EI-21238986333755666)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getClaimSpecRecordM.mockResolvedValue({
      source: 'default',
      spec: { specId: 'default', revision: 0 },
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });
    getNextM.mockResolvedValue({ workItem: { id: 'WI-must-not-claim', title: 'Unrelated work' } });
    getPresenceM.mockResolvedValue({ currentPlanSlug: 'active-control-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'active', hasOpenItems: true });
  });

  it('fails closed before getNextForBee when a non-fleet caller declares a plan but has only the default spec', async () => {
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({
      ok: false,
      error: 'plan_scope_missing',
      reason: 'declared_plan_without_claim_spec',
      noClaim: true,
      windDown: false,
      recoverable: true,
      declaredPlanSlug: 'active-control-plan',
      claimSpecSource: 'default',
    });
    expect(body.recovery).toMatchObject({
      tool: 'scheduler:set_claim_spec',
      args: {
        cupId: 'su-member',
        harness: 'papercusp',
        spec: {
          specVersion: '1.0',
          specId: 'declared-plan:active-control-plan',
          revision: 1,
          view: { filter: { field: 'plan', op: '=', value: 'active-control-plan' } },
          rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
        },
      },
    });
    expect((body.recovery as { args: Record<string, unknown> }).args).not.toHaveProperty('plan');
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('clears a positively terminal stale declaration before resuming the default pull', async () => {
    getPresenceM.mockResolvedValue({ intent: 'finished plan work', currentPlanSlug: 'shipped-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'shipped', hasOpenItems: false });
    getNextM.mockResolvedValue(null);

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body.error).not.toBe('plan_scope_missing');
    expect(getNextM).toHaveBeenCalledOnce();
    expect(planTerminalityInWorkspaceM).toHaveBeenCalledWith('ws-1', 'shipped-plan');
    expect(writePresenceM).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-member' }),
      { intent: 'finished plan work', currentPlanSlug: null },
      'papercusp',
    );
  });

  it('also clears an active plan declaration whose plan has no open items', async () => {
    getPresenceM.mockResolvedValue({ intent: 'drained plan work', currentPlanSlug: 'drained-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'active', hasOpenItems: false });
    getNextM.mockResolvedValue(null);

    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);

    expect(getNextM).toHaveBeenCalledOnce();
    expect(writePresenceM).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-member' }),
      { intent: 'drained plan work', currentPlanSlug: null },
      'papercusp',
    );
  });

  it('keeps the fail-closed refusal when clearing the terminal declaration fails', async () => {
    getPresenceM.mockResolvedValue({ intent: 'finished plan work', currentPlanSlug: 'shipped-plan' });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'shipped', hasOpenItems: false });
    writePresenceM.mockRejectedValue(new Error('presence write failed'));

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, error: 'plan_scope_missing', noClaim: true });
    expect(getNextM).not.toHaveBeenCalled();
  });

  it('keeps the fail-closed refusal when terminality cannot be positively established', async () => {
    planTerminalityInWorkspaceM.mockResolvedValue(null);

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, error: 'plan_scope_missing', noClaim: true });
    expect(getNextM).not.toHaveBeenCalled();
    expect(writePresenceM).not.toHaveBeenCalled();
  });

  it('allows a declared-plan caller whose explicit per-bee spec supplies the scope', async () => {
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'active-control-plan-lane', revision: 2 },
      revision: 2,
      updatedBy: 'leader',
      updatedAt: new Date().toISOString(),
    });
    getNextM.mockResolvedValue(null);

    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);

    expect(getNextM).toHaveBeenCalledOnce();
  });

  it('retires a shipped plans:start solo binding with CAS and immediately retries under the current/default spec', async () => {
    getPresenceM.mockResolvedValue(null);
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: {
        specId: 'plans-start-finished-plan',
        revision: 7,
        view: { filter: { field: 'plan', op: '=', value: 'finished-plan' } },
      },
      revision: 7,
      updatedBy: 'su-member',
      updatedAt: new Date().toISOString(),
    });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'shipped', hasOpenItems: false });
    getNextM.mockResolvedValueOnce(null).mockResolvedValueOnce({
      workItem: { id: 'EI-next', title: 'Next default-lane item' },
      claimedUnder: { specId: 'default-fixed-ordering', revision: 0 },
    });

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text?: string }>;
    };
    const body = handlerPayload(out);

    expect(getNextM).toHaveBeenCalledTimes(2);
    expect(clearClaimSpecM).toHaveBeenCalledWith({
      cupId: 'su-member',
      workspaceId: 'ws-1',
      expectedHead: { specId: 'plans-start-finished-plan', revision: 7 },
    });
    expect(body).toMatchObject({
      workItem: { id: 'EI-next' },
      retiredSoloPlanSpec: {
        planSlug: 'finished-plan',
        specId: 'plans-start-finished-plan',
        revision: 7,
        cleared: true,
      },
    });
  });

  it('does not retire an active plan binding or an arbitrary composite plan filter', async () => {
    getPresenceM.mockResolvedValue(null);
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: {
        specId: 'plans-start-live-plan',
        revision: 2,
        view: { filter: { field: 'plan', op: '=', value: 'live-plan' } },
      },
      revision: 2,
      updatedBy: 'su-member',
      updatedAt: new Date().toISOString(),
    });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'active', hasOpenItems: false });
    getNextM.mockResolvedValue(null);

    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(clearClaimSpecM).not.toHaveBeenCalled();

    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: {
        specId: 'plans-start-finished-plan',
        revision: 3,
        view: {
          filter: {
            any: [
              { field: 'plan', op: '=', value: 'finished-plan' },
              { field: 'id', op: 'in', value: ['EI-live'] },
            ],
          },
        },
      },
      revision: 3,
      updatedBy: 'su-member',
      updatedAt: new Date().toISOString(),
    });
    planTerminalityInWorkspaceM.mockResolvedValue({ status: 'shipped', hasOpenItems: false });
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(clearClaimSpecM).not.toHaveBeenCalled();
  });
});

// EI-16057: an unresolvable `harness` (e.g. a workspace id passed where a slug
// belongs) used to match zero rows in the claim query and render as `windDown:true`
// — indistinguishable from a genuinely drained fleet-scoped lane, so a member would
// stand its loop down and report a false all-clear. It must instead fail loud as a
// plain invalid_input, before any fleet-scope reconciliation runs, and NEVER set
// windDown.
describe('scheduler:get_next harness-existence gate (EI-16057)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
  });

  it('an unregistered harness (e.g. a workspace id) returns invalid_input, never windDown', async () => {
    const out = (await getNextTool.handler({ harness: 'papercusp-workspace' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      ok: false,
      error: 'invalid_input',
      reason: 'harness_not_found',
      passedHarness: 'papercusp-workspace',
      knownHarnesses: ['papercusp'],
    });
    expect(b.windDown).toBeUndefined();
    // The real claim query still runs (harness validity is checked only on the miss it
    // produces, so a correct pull never pays the extra read) — it's the WINDOWN-BEARING
    // fleetScopedMiss branch below it that must never fire for this cause.
    expect(getNextM).toHaveBeenCalledOnce();
  });

  it('a registered harness slug is unaffected — passes through to the normal claim path', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({ ok: false, windDown: true });
    expect(getNextM).toHaveBeenCalledOnce();
  });

  it('a registry-read failure fails OPEN — never blocks a legitimate claim on a read hiccup', async () => {
    loadHarnessRegistryM.mockImplementation(async () => {
      throw new Error('transient PG hiccup');
    });
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b.error).not.toBe('invalid_input');
    expect(getNextM).toHaveBeenCalledOnce();
  });
});

describe('scheduler:get_next keeps reviewable misses on the inherited fleet lane (EI-25982738611634117)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue(null);
    getClaimSpecRecordM.mockResolvedValue({
      source: 'fleet',
      fleetSlug: 'main-green-1013',
      spec: {
        specId: 'main-green-1013-owner1802',
        revision: 10,
        view: { filter: { field: 'kind', op: '=', value: 'bug' } },
      },
      revision: 10,
      updatedBy: 'fleet-leader',
      updatedAt: new Date().toISOString(),
    });
    diagnoseClaimNextMissM.mockResolvedValue({
      drained: false,
      pendingUnclaimed: 1,
      readyUnclaimed: 0,
      flagReadError: null,
    });
    aggregateIssueClaimExclusionsM.mockResolvedValue({
      matchedByFilter: 1,
      claimable: 0,
      excluded: { agent_review: 1 },
      queueControl: { pendingAgentReview: 1 },
    });
  });

  afterEach(() => {
    diagnoseClaimNextMissM.mockReset().mockResolvedValue({
      drained: true,
      pendingUnclaimed: 0,
      readyUnclaimed: 0,
      flagReadError: null,
    });
    aggregateIssueClaimExclusionsM.mockReset().mockResolvedValue({
      matchedByFilter: 0,
      claimable: 0,
      excluded: {},
      queueControl: { pendingAgentReview: 0 },
    });
  });

  it('passes the inherited fleet slug into the scoped claimable review route', async () => {
    const out = await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    const body = handlerPayload(out);

    expect(body).toMatchObject({ ok: false });
    expect(body.error).toContain("work_items:claimable { harness:'papercusp', spec:'main-green-1013'");
    expect(body.error).not.toContain("mode:'claim-next'");
  });
});

// EI-18167154191955470: a routine scheduler:get_next hung with ZERO response/progress for the
// full 300s MCP idle timeout (the signature of PG pool contention — a query stuck waiting on a
// pool connection blocks silently, no error) and was aborted by the client; an immediate retry
// succeeded in ~2s. The DB path (chiefly the atomic claim) is now bounded so such a stall returns
// a FAST, clean, retryable error WELL under the idle abort. These pin the two behaviors: fail
// FAST (never a silent hang) and fail LOUD (a real error is never swallowed into a false miss).
describe('scheduler:get_next bounds the claim path against a silent hang (EI-18167154191955470)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readClaimConcurrencyM.mockResolvedValue({ blocked: false, activeClaims: 0, maxConcurrentClaims: 1, heldIds: [] });
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a fast retryable timeout miss when the claim exceeds the budget, not a 300s hang', async () => {
    vi.useFakeTimers();
    // withBoundedTimeout logs a console.warn when it degrades; the warn is EXPECTED here (it is
    // the fail-fast firing), so capture it explicitly rather than let vitest-fail-on-console trip.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Simulate the pool-contention stall: the atomic claim never resolves within the budget.
    let claimSignal: AbortSignal | undefined;
    getNextM.mockImplementation((args: { signal?: AbortSignal; onClaimStep?: (step: string) => void }) => {
      claimSignal = args.signal;
      args.onClaimStep?.('claim-concurrency-read');
      return new Promise(() => {});
    });
    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    // Let the async handler reach its bounded preflight and arm the watchdog before advancing
    // fake time; otherwise the timer starts only after the clock has already jumped past it.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    // Advance past the internal budget so the bounded-timeout deadline fires; without the bound
    // this promise would never settle (the hang the bug reported).
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + 100);
    const out = await p;
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      budgetMs: GET_NEXT_BUDGET_MS,
      possiblyClaimed: true,
      heldIds: [],
      claimReconciliation: 'none-observed',
      lastClaimStep: 'claim-concurrency-read',
    });
    expect(typeof b.message).toBe('string');
    // The message must point the caller at the real failure (idle-timeout abort) + the retry.
    expect(b.message).toContain('300s');
    expect(b.message).toContain('claim-concurrency-read');
    expect(b.message).not.toContain('likely transient PG pool');
    // A transient timeout is NOT a drained lane — windDown must never be set for it.
    expect(b.windDown).toBeUndefined();
    // The bounded-timeout deadline fired (the fail-fast) — assert it explicitly.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:claim exceeded'));
    expect(claimSignal).toBeInstanceOf(AbortSignal);
    expect(claimSignal?.aborted).toBe(true);
    expect(readClaimConcurrencyM).toHaveBeenCalledWith({ cupId: 'su-member', workspaceId: 'ws-1' });
    warnSpy.mockRestore();
  });

  it('distinguishes a candidate stall from setup and freezes the phase before late progress', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reportStep: ((
      step: string,
      event?: { phase: 'start'; startedAtMs: number } | { phase: 'end'; elapsedMs: number },
    ) => void) | undefined;
    getNextM.mockImplementation((args: {
      onClaimStep?: (
        step: string,
        event?: { phase: 'start'; startedAtMs: number } | { phase: 'end'; elapsedMs: number },
      ) => void;
    }) => {
      reportStep = args.onClaimStep;
      reportStep?.('candidate-priority-issue-preclaim', { phase: 'start', startedAtMs: performance.now() });
      return new Promise(() => {});
    });
    readClaimConcurrencyM.mockImplementation(async () => {
      reportStep?.('claim-audit');
      return { blocked: false, activeClaims: 0, maxConcurrentClaims: 1, heldIds: [] };
    });
    const metadata = vi.fn();
    const pending = getNextTool.handler({ harness: 'papercusp' } as never, { metadata } as never);
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + 100);
    const out = (await pending) as { content: Array<{ text: string }> };
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({
      error: 'timeout',
      lastClaimStep: 'candidate-priority-issue-preclaim',
      possiblyClaimed: true,
    });
    const timeoutResult = JSON.parse(out.content[0]!.text);
    expect(timeoutResult.lastClaimStepElapsedMs).toEqual(expect.any(Number));
    expect(timeoutResult.lastClaimStepElapsedMs).toBeGreaterThanOrEqual(GET_NEXT_BUDGET_MS);
    expect(metadata).toHaveBeenCalledWith({
      schedulerTimeout: {
        phase: 'claim',
        lastClaimStep: 'candidate-priority-issue-preclaim',
        lastClaimStepElapsedMs: timeoutResult.lastClaimStepElapsedMs,
      },
    });
    warnSpy.mockRestore();
  });

  it('reports held ids when the timeout reconciliation sees a committed claim', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getNextM.mockImplementation(() => new Promise(() => {}));
    readClaimConcurrencyM.mockResolvedValue({
      blocked: true,
      activeClaims: 1,
      maxConcurrentClaims: 1,
      heldIds: ['EI-late-claim'],
    });

    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({
      ok: false,
      error: 'timeout',
      possiblyClaimed: true,
      heldIds: ['EI-late-claim'],
      claimReconciliation: 'held',
    });
    expect(body.message).toContain('may be among them');
    warnSpy.mockRestore();
  });

  it('keeps the timeout claim disposition unknown when reconciliation fails', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getNextM.mockImplementation(() => new Promise(() => {}));
    readClaimConcurrencyM.mockRejectedValue(new Error('pool still unavailable'));

    const metadata = vi.fn();
    const p = getNextTool.handler({ harness: 'papercusp' } as never, { metadata } as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({
      ok: false,
      error: 'timeout',
      possiblyClaimed: true,
      heldIds: [],
      claimReconciliation: 'unknown',
    });
    expect(body.message).toContain('inconclusive');
    expect(body.message).not.toContain('no claims for this caller');
    expect(metadata).toHaveBeenCalled();
    for (const [record] of metadata.mock.calls) expect(record).not.toHaveProperty('schedulerDisposition');
    warnSpy.mockRestore();
  });

  it('bounds a hanging timeout reconciliation and preserves the unknown disposition', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getNextM.mockImplementation(() => new Promise(() => {}));
    readClaimConcurrencyM.mockImplementation(() => new Promise(() => {}));

    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + GET_NEXT_TIMEOUT_RECONCILIATION_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({
      ok: false,
      error: 'timeout',
      possiblyClaimed: true,
      heldIds: [],
      claimReconciliation: 'unknown',
    });
    expect(Date.now() - startedAt).toBe(GET_NEXT_BUDGET_MS + GET_NEXT_TIMEOUT_RECONCILIATION_BUDGET_MS + 100);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:timeoutReconciliation exceeded'));
    warnSpy.mockRestore();
  });

  it('shares one deadline across a slow preflight and a hanging claim', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getFlagM
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20_000)))
      .mockResolvedValue(true);
    getNextM.mockImplementation(() => new Promise(() => {}));

    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_TOTAL_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, error: 'timeout', retryable: true });
    expect(body.budgetMs).toBeLessThan(GET_NEXT_BUDGET_MS);
    expect(Date.now() - startedAt).toBe(GET_NEXT_TOTAL_BUDGET_MS + 100);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:claim exceeded'));
    warnSpy.mockRestore();
  });

  it('bounds a hanging fleet issue-floor diagnosis below the whole-handler deadline', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      workspaceId: 'ws-1',
      record: {
        source: 'fleet',
        spec: {
          specId: 'bugs-rev1',
          revision: 1,
          states: ['open'],
          view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
        },
      },
    };
    getNextM.mockResolvedValue(null);
    diagnoseFleetScopeIssueFloorMissM.mockImplementation(() => new Promise(() => {}));

    const p = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_ISSUE_DIAG_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);

    expect(body).toMatchObject({ ok: false, windDown: true });
    expect(Date.now() - startedAt).toBeLessThan(GET_NEXT_TOTAL_BUDGET_MS);
    expect(diagnoseFleetScopeIssueFloorMissM).toHaveBeenCalledWith(
      expect.objectContaining({ totalBudgetMs: GET_NEXT_ISSUE_DIAG_BUDGET_MS }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:issueFloorMiss exceeded'));
    warnSpy.mockRestore();
  });

  it('re-surfaces a genuine underlying claim error loudly — never swallowed as a silent miss', async () => {
    // The degrade-warn is expected on the error path too (buildBoundedTimeout logs before
    // re-surfacing) — capture it so vitest-fail-on-console does not trip on the expected warn.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getNextM.mockRejectedValue(new Error('pool exhausted: boom'));
    await expect(getNextTool.handler({ harness: 'papercusp' } as never, {} as never)).rejects.toThrow(
      /pool exhausted: boom/,
    );
    warnSpy.mockRestore();
  });

  it('returns a retryable timeout for bounded PG contention instead of handler_error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const contention = new OrgTxnTimeoutError('55P03', new Error('lock timeout'));
    getNextM.mockRejectedValue(contention);
    const metadata = vi.fn();

    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, { metadata } as never)) as {
      content: Array<{ text: string }>;
    };
    const b = JSON.parse(out.content[0]!.text);
    expect(b).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      pgCode: '55P03',
    });
    expect(b.message).toContain('operator write timed out waiting for a row/advisory lock');
    expect(b.message).toContain('Retry now');
    expect(b.windDown).toBeUndefined();
    expect(metadata).toHaveBeenCalledWith({
      schedulerTimeout: {
        phase: 'claim',
        lastClaimStep: 'claim-start',
        lastClaimStepElapsedMs: expect.any(Number),
        pgCode: '55P03',
        timeoutSource: 'pg',
      },
    });
    warnSpy.mockRestore();
  });
});

// EI-20228674494907304: the first timeout was observed after a fleet spec revision wake, but
// the old watchdog began only at getNextForBee. These tests isolate every pre-claim await so a
// reconciliation, pause-state, flag, or lock-plane stall cannot regress into a 300s MCP hang.
describe('scheduler:get_next bounds every pre-claim await (EI-20228674494907304)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function expectPreflightTimeout(lastPreflightStep: string, expectedLiveLockPhase?: string) {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const metadata = vi.fn();
    const p = getNextTool.handler({ harness: 'papercusp' } as never, { metadata } as never) as Promise<{
      content: Array<{ text: string }>;
    }>;
    await vi.advanceTimersByTimeAsync(GET_NEXT_BUDGET_MS + 100);
    const out = await p;
    const body = JSON.parse(out.content[0]!.text);
    expect(body).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      phase: 'preflight',
      budgetMs: GET_NEXT_BUDGET_MS,
      lastPreflightStep,
      preflightTiming: {
        totalElapsedMs: expect.any(Number),
        completedSteps: expect.any(Array),
        activeStep: {
          step: lastPreflightStep,
          elapsedMs: expect.any(Number),
        },
      },
    });
    expect(body.preflightTiming.totalElapsedMs).toBeGreaterThanOrEqual(GET_NEXT_BUDGET_MS);
    expect(body.preflightTiming.activeStep.elapsedMs).toBeGreaterThan(0);
    if (lastPreflightStep === 'work-scope-policy') {
      expect(body.preflightTiming.completedSteps).toEqual([]);
    } else {
      expect(body.preflightTiming.completedSteps).toEqual(
        expect.arrayContaining([expect.objectContaining({ step: 'work-scope-policy' })]),
      );
    }
    expect(body.preflightTiming.completedSteps.every((step: { elapsedMs: unknown }) =>
      typeof step.elapsedMs === 'number' && Number.isFinite(step.elapsedMs) && step.elapsedMs >= 0,
    )).toBe(true);
    if (expectedLiveLockPhase) {
      expect(body.preflightTiming.liveLockRead).toMatchObject({
        activeStep: {
          phase: expectedLiveLockPhase,
          elapsedMs: expect.any(Number),
        },
      });
    }
    expect(body.message).toContain('No claim was attempted');
    expect(getNextM).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenLastCalledWith({
      schedulerDisposition: { kind: 'no-claim', reason: 'timeout' },
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:preflight exceeded'));
    warnSpy.mockRestore();
  }

  it('identifies fleet-scope reconciliation when its preflight stalls', async () => {
    reconcileFleetScopeClaimsM.mockImplementation(() => new Promise(() => {}));
    await expectPreflightTimeout('fleet-scope-reconciliation');
  });

  it('bounds the paused-fleet control-state read before any claim attempt', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev1', revision: 1 } },
    };
    reconcileFleetScopeClaimsM.mockResolvedValue({ scope: scopeState.scope, quarantinedIds: [] });
    readFleetPauseStateM.mockImplementation(() => new Promise(() => {}));
    await expectPreflightTimeout('fleet-pause-state');
  });

  it('bounds the fleet-leader liveness roster read before any claim attempt', async () => {
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev1', revision: 1 } },
    };
    reconcileFleetScopeClaimsM.mockResolvedValue({ scope: scopeState.scope, quarantinedIds: [] });
    reconcileFleetScopeLeaderSuccessionM.mockImplementation(() => new Promise(() => {}));
    await expectPreflightTimeout('fleet-leader-liveness');
  });

  it('identifies the context-pressure flag when its preflight read stalls', async () => {
    reconcileFleetScopeClaimsM.mockResolvedValue({ scope: null, quarantinedIds: [] });
    getFlagM.mockImplementation(() => new Promise(() => {}));
    await expectPreflightTimeout('context-pressure-flag');
  });

  it('bounds the live lock-plane snapshot before any claim attempt', async () => {
    reconcileFleetScopeClaimsM.mockResolvedValue({ scope: null, quarantinedIds: [] });
    getFlagM.mockResolvedValue(true);
    liveLockedPathsM.mockImplementation((options) => {
      options?.onPhase?.({ phase: 'pool-acquire-and-begin', state: 'start' });
      return new Promise(() => {});
    });
    await expectPreflightTimeout('live-lock-paths', 'pool-acquire-and-begin');
  });

  it('bounds the first-use work-scope policy gate before any claim attempt', async () => {
    gateWorkScopeM.mockImplementationOnce(
      () => new Promise<{ allowed: boolean; reason: string }>(() => {}),
    );
    await expectPreflightTimeout('work-scope-policy');
  });
});

describe('scheduler:get_next attributes async refusal tails (WI-6554700010012557)', () => {
  beforeEach(() => {
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    fetchContextPressureM.mockReset().mockResolvedValue(new Map());
    autoBenchContextCriticalCallerM.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
  });

  it('attributes a slow context-critical auto-bench after preflight', async () => {
    const { createPhaseTracker } = await import('@papercusp/tooldef');
    const tracker = createPhaseTracker();
    fetchContextPressureM.mockResolvedValueOnce(new Map([[
      'su-member',
      { bucket: 'critical', estimatedAt: new Date().toISOString(), ageSec: 0 },
    ]]));
    autoBenchContextCriticalCallerM.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { benched: true, reason: 'test park', wakeEvent: 'session:compacted:su-member' };
    });

    const out = await getNextTool.handler({ harness: 'papercusp' } as never, { phases: tracker } as never);
    const body = handlerPayload(out);
    const meta = tracker.toMetadata()!;
    const benchPhase = meta.phases.find((phase) => phase.phase === 'get_next:refusal:contextCriticalBench');

    expect(body).toMatchObject({ ok: false, diagnosis: { contextPressureBlocked: true } });
    expect(getNextM).not.toHaveBeenCalled();
    expect(benchPhase?.durationMs).toBeGreaterThanOrEqual(250);
    expect(meta.attributedMs / meta.elapsedMs).toBeGreaterThanOrEqual(0.8);
  });

  it('attributes a slow paused-fleet await cancellation after preflight', async () => {
    const { createPhaseTracker } = await import('@papercusp/tooldef');
    const tracker = createPhaseTracker();
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.windingDown = true;
    scopeState.pauseReason = 'owner pause';
    cancelClaimableAwaitsM.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return 1;
    });

    const out = await getNextTool.handler({ harness: 'papercusp' } as never, { phases: tracker } as never);
    const body = handlerPayload(out);
    const meta = tracker.toMetadata()!;
    const cancelPhase = meta.phases.find((phase) => phase.phase === 'get_next:refusal:cancelAwaits');

    expect(body).toMatchObject({ ok: false, windDown: true, paused: true, claimableAwaitsCancelled: 1 });
    expect(getNextM).not.toHaveBeenCalled();
    expect(cancelPhase?.durationMs).toBeGreaterThanOrEqual(250);
    expect(meta.attributedMs / meta.elapsedMs).toBeGreaterThanOrEqual(0.8);
  });
});

// EI-21834503221873518: the claim commits before advisory enrichment begins. A
// post-claim read that never settles must therefore degrade to the compact,
// committed receipt instead of leaving the caller to retry a destructive pull.
describe('scheduler:get_next bounds post-claim enrichment (EI-21834503221873518)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the committed claim receipt when claim-time recall hangs', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getNextM.mockResolvedValue({
      workItem: { id: 'WI-218345032', title: 'post-claim enrichment stalls' },
      claimedUnder: { specId: 'scheduler-spec', revision: 7 },
    });
    buildClaimRecallBlockM.mockImplementation(() => new Promise<string | null>(() => {}));

    const pending = getNextTool.handler({ harness: 'papercusp' } as never, {} as never) as Promise<{
      data?: unknown;
      content?: Array<{ text?: string }>;
    }>;
    // The handler reaches the post-claim enrichment only after several async preflight and
    // claim continuations, including dynamic imports. Wait for the mocked enrichment seam before
    // advancing fake time so its bounded watchdog is armed against the current clock; advancing
    // first jumps past the deadline and leaves the test promise waiting forever
    // (EI-22737331452243764).
    await vi.waitFor(() => expect(buildClaimRecallBlockM).toHaveBeenCalledOnce(), {
      timeout: 1_000,
      interval: 1,
    });
    await vi.advanceTimersByTimeAsync(GET_NEXT_TOTAL_BUDGET_MS + 100);

    const out = await pending;
    const body = handlerPayload(out);
    expect(body).toMatchObject({
      ok: true,
      claimReceipt: {
        committed: true,
        workItemId: 'WI-218345032',
        specId: 'scheduler-spec',
        revision: 7,
      },
      workItem: { id: 'WI-218345032' },
    });
    expect(buildClaimRecallBlockM).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'su-member',
        workspaceId: 'ws-1',
        items: [expect.objectContaining({ id: 'WI-218345032' })],
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scheduler:get_next:postClaimEnrichment exceeded'));
    warnSpy.mockRestore();
  });
});

/**
 * EI-20099413453852234 — claiming an item must also DECLARE it.
 *
 * get_next claimed an item and left the caller's declared intent untouched, so presence held a
 * live claim beside a stale intent and computed `intentDivergent: true` for an agent that was
 * actively mid-implementation. Peers use that signal to judge whether a claim is real: one read
 * it and offered to take an item out from under its holder, mid-fix. An agent in a get_next loop
 * re-claims every wake, so the intent was stale BY CONSTRUCTION unless it remembered a second,
 * optional call each time.
 */
describe('a successful claim declares the caller intent (EI-20099413453852234)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = null;
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue({ workItem: { id: 'WI-4242', title: 'Fix the flaky thing' } });
    getPresenceM.mockResolvedValue(null);
    writePresenceM.mockResolvedValue(undefined);
  });

  it('writes an intent naming the claimed item', async () => {
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(writePresenceM).toHaveBeenCalledTimes(1);
    expect(writePresenceM.mock.calls[0]![1]).toMatchObject({
      intent: 'WI-4242: Fix the flaky thing',
    });
  });

  it('publishes the complete committed claim through structuredContent for programmatic callers', async () => {
    const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
    const projected = lookupByMcpName('scheduler:get_next')!;
    const dispatched = await dispatchProjectedTool(
      projected,
      'scheduler:get_next',
      { harness: 'papercusp' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        runId: 'scheduler-structured-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: vi.fn(async () => []),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(projected.outputJsonSchema?.type).toBe('object');
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      claimReceipt: {
        committed: true,
        workItemId: 'WI-4242',
      },
      workItem: { id: 'WI-4242' },
    });
  });

  it('passes live peer lock paths into the atomic placement rank, excluding its own locks', async () => {
    liveLockedPathsM.mockResolvedValueOnce(['packages/operator-core/lib/hot.ts']);
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(liveLockedPathsM).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeOwner: 'su-member',
        onPhase: expect.any(Function),
      }),
    );
    expect(getNextM).toHaveBeenCalledWith(
      expect.objectContaining({
        cupId: 'su-member',
        contendedPaths: ['packages/operator-core/lib/hot.ts'],
      }),
    );
  });

  // WI-6554700010011595 (plan papercusp-performance-audit-2026-10-12 R-1): every await after
  // get_next:arbitrate used to run outside a named phase, so ~35% of get_next wall time on
  // :3170 (11-13 s on slow calls) was unattributable. A slow post-claim leg must now land in
  // a NAMED phase. Old code: the 300 ms leg is unattributed, so coverage is ~0.1.
  it('attributes a slow post-claim enrichment leg to a named phase', async () => {
    const { createPhaseTracker } = await import('@papercusp/tooldef');
    const tracker = createPhaseTracker();
    buildClaimRecallBlockM.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return null;
    });
    await getNextTool.handler({ harness: 'papercusp' } as never, { phases: tracker } as never);
    const meta = tracker.toMetadata();
    expect(meta).not.toBeNull();
    const names = meta!.phases.map((p) => p.phase);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_next:claim',
        'get_next:arbitrate',
        'get_next:enrich:memory',
        'get_next:enrich:checkpoint',
        'get_next:enrich:cancelAwaits',
        'get_next:enrich:declareIntent',
        'get_next:hint:planDecisions',
      ]),
    );
    const memoryPhase = meta!.phases.find((p) => p.phase === 'get_next:enrich:memory');
    expect(memoryPhase!.durationMs).toBeGreaterThanOrEqual(250);
    expect(meta!.attributedMs / meta!.elapsedMs).toBeGreaterThanOrEqual(0.8);
  });

  it('records named phases on the miss path too', async () => {
    const { createPhaseTracker } = await import('@papercusp/tooldef');
    const tracker = createPhaseTracker();
    getNextM.mockResolvedValue(null);
    await getNextTool.handler({ harness: 'papercusp' } as never, { phases: tracker } as never);
    const names = tracker.toMetadata()!.phases.map((p) => p.phase);
    expect(names).toEqual(
      expect.arrayContaining(['get_next:capacityCheck', 'get_next:missHarnessRegistry', 'get_next:missDiagnosis']),
    );
    expect(names.some((n) => n.startsWith('get_next:enrich:'))).toBe(false);
  });

  it('routes a legacy/pre-envelope bug through the cheap validation lane at claim time', async () => {
    getNextM.mockResolvedValue({ workItem: { id: 'WI-4242', title: 'Fix the flaky thing', kind: 'bug' } });
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).toMatchObject({
      ok: true,
      workItem: { id: 'WI-4242' },
      freshness: {
        lane: 'validation',
        likelyStale: true,
        reasons: ['no freshness envelope (pre-envelope or unknown-generation report)'],
      },
    });
  });

  // EI-20264587083609474: this pair used to be ONE test asserting that a `change`
  // claim gets no freshness at all. That was a bare pin of the bug-only gate, not a
  // stated decision — and it was wrong in the expensive direction: an absent
  // `freshness` key is indistinguishable from "this item is fresh", so a `change`
  // claimant was told nothing about work that may already be committed. `change` is
  // this repo's default kind for a code edit, and half the already-built evidence
  // that motivated the freshness lane was a `change`.
  //
  // The negative case is KEPT rather than deleted, moved to the kind that should
  // genuinely stay out: `task` is non-code work, so the scorer's only item-specific
  // axis (source movement over the item's own paths) can never measure anything for
  // it. Without this second test, widening the gate to every kind would pass.
  it('routes a pre-envelope change through the validation lane like a bug', async () => {
    getNextM.mockResolvedValue({ workItem: { id: 'WI-4243', title: 'Improve the flow', kind: 'change' } });
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).toMatchObject({
      ok: true,
      workItem: { id: 'WI-4243' },
      freshness: {
        lane: 'validation',
        likelyStale: true,
        reasons: ['no freshness envelope (pre-envelope or unknown-generation report)'],
      },
    });
  });

  it('does not attach freshness routing to a non-code kind', async () => {
    getNextM.mockResolvedValue({ workItem: { id: 'WI-4244', title: 'Write the runbook', kind: 'task' } });
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).not.toHaveProperty('freshness');
  });

  // THE REGRESSION CASE, and the reason this is a read-modify-write rather than a bare write.
  // PgPresenceStore's ON CONFLICT sets `current_plan_slug = EXCLUDED.current_plan_slug` — a BARE
  // assignment — so a write that omits it CLEARS it. Without this test a naive implementation
  // passes the one above while silently wiping the declared plan slug of every self-pulling
  // agent on every claim: strictly worse than the stale intent it set out to fix.
  it('CARRIES the existing currentPlanSlug — a claim must never wipe the declared plan', async () => {
    getPresenceM.mockResolvedValue({ intent: 'something older', currentPlanSlug: 'my-plan-slug' });
    getClaimSpecRecordM.mockResolvedValue({
      source: 'cup',
      spec: { specId: 'my-plan-lane', revision: 1 },
      revision: 1,
      updatedBy: 'leader',
      updatedAt: new Date().toISOString(),
    });
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(writePresenceM.mock.calls[0]![1]).toMatchObject({ currentPlanSlug: 'my-plan-slug' });
  });

  it('does not clobber an intent the caller already declared for THIS item', async () => {
    getPresenceM.mockResolvedValue({
      intent: 'WI-4242: my own richer wording, deliberately set',
      currentPlanSlug: null,
    });
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(writePresenceM).not.toHaveBeenCalled();
  });

  // The claim is COMMITTED before this runs, so losing the caller's result over a presence
  // hiccup would be far worse than a stale intent. Both legs must fail soft.
  it('still returns the claim when the presence write throws', async () => {
    writePresenceM.mockRejectedValue(new Error('presence pool exhausted'));
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).toMatchObject({ workItem: { id: 'WI-4242' } });
  });

  it('still returns the claim when the presence READ throws', async () => {
    getPresenceM.mockRejectedValue(new Error('presence read failed'));
    const out = (await getNextTool.handler({ harness: 'papercusp' } as never, {} as never)) as {
      data?: unknown;
      content?: Array<{ text: string }>;
    };
    expect(handlerPayload(out)).toMatchObject({ workItem: { id: 'WI-4242' } });
  });

  it('declares nothing on a MISS — an empty pull leaves the existing intent alone', async () => {
    getNextM.mockResolvedValue(null);
    await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);
    expect(writePresenceM).not.toHaveBeenCalled();
  });
});

describe('scheduler:get_next claim lease arbitration (WI-39730)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.scope = {
      ownerId: 'su-member',
      fleetSlug: 'bugs',
      fleetRole: 'member',
      record: { source: 'fleet', spec: { specId: 'bugs-rev4', revision: 4 } },
    };
    scopeState.quarantinedIds = [];
    scopeState.windingDown = false;
    scopeState.pauseReason = null;
    registryState.projects = [{ slug: 'papercusp' }];
    loadHarnessRegistryM.mockImplementation(async () => ({ projects: registryState.projects }));
    getNextM.mockResolvedValue({ workItem: { id: 'WI-lease-lost', title: 'Lease arbitration regression' } });
    workItemClaimLeaseEnabledM.mockReturnValue(true);
    leaseClaimedWorkItemM.mockResolvedValue(false);
    releaseWorkItemM.mockResolvedValue(undefined);
  });

  it('releases a local claim when the Hive lease is lost and never reports it committed', async () => {
    const out = await getNextTool.handler({ harness: 'papercusp' } as never, {} as never);

    expect(leaseClaimedWorkItemM).toHaveBeenCalledWith({
      harness: 'papercusp',
      workItemId: 'WI-lease-lost',
      owner: 'su-member',
    });
    expect(releaseWorkItemM).toHaveBeenCalledWith('WI-lease-lost', {
      harness: 'papercusp',
      expectedAssignee: 'su-member',
    });
    expect(handlerPayload(out as { data?: unknown; content?: Array<{ text?: string }> })).not.toMatchObject({
      ok: true,
      claimReceipt: { committed: true, workItemId: 'WI-lease-lost' },
    });
  });
});

/*
 * Acceptance-readiness hold detectors (plan feature-drain-delivery-readiness-and-outcome-
 * accounting-2026-10-01, P-002(b), D-008 §5 / D-011). The describe names ARE the BAR keys
 * this file is the check for. scheduler:get_next pulls through getNextForBee, whose second
 * post-claim verdict is acceptanceReadinessHold; the getNextForBee wiring (release before
 * route, audit reason) is pinned in scheduler/get-next-for-bee-plan-lane-guard.test.ts.
 * These cases drive the hold module itself with injected I/O, so no PG is needed.
 */
type HoldBar = {
  barKey: string;
  mappings: Array<{ planItemId: string; lifecycleStatus?: string }>;
  readiness: { codes: string[] };
};
const HOLD_PLAN = 'hold-plan-2026-10-01';
const holdBar = (barKey: string, items: Array<[string, string?]>, codes: string[]): HoldBar => ({
  barKey,
  mappings: items.map(([planItemId, lifecycleStatus]) => ({
    planItemId,
    ...(lifecycleStatus ? { lifecycleStatus } : {}),
  })),
  readiness: { codes },
});
const holdSnapshot = (...bars: HoldBar[]) =>
  ({ bars }) as unknown as Parameters<typeof incompleteAcceptanceBarsForItems>[0];
const holdItem = (id: string, itemIds: string[] | null) => ({
  id,
  harness: 'papercusp',
  payload: {},
  family: 'feature' as const,
  sourcePlanSlug: itemIds ? HOLD_PLAN : null,
  sourcePlanItemIds: itemIds,
});
const holdCtx = { by: 'su-test', workspaceId: 'ws-test' };

function holdDeps(snap: ReturnType<typeof holdSnapshot>) {
  const filed: AcceptanceRepairTaskInput[] = [];
  const edges: string[] = [];
  const deps: Partial<AcceptanceReadinessHoldDeps> = {
    resolveStamp: async (wi) =>
      wi.sourcePlanSlug && wi.sourcePlanItemIds
        ? { plan_slug: wi.sourcePlanSlug, item_ids: wi.sourcePlanItemIds }
        : null,
    readSnapshot: async () => snap,
    findOrFileRepairTask: vi.fn(async (input: AcceptanceRepairTaskInput) => {
      filed.push(input);
      return { id: `EI-REPAIR-${filed.length}`, filed: true };
    }),
    linkHold: vi.fn(async (input: { repairId: string; heldId: string }) => {
      edges.push(`${input.repairId}->${input.heldId}`);
      return null;
    }),
  };
  return { deps, filed, edges };
}

/**
 * A repair-task store with Postgres's relevant semantics: `pg_advisory_xact_lock` serializes
 * transactions on the same key until the holder's transaction settles, and createWorkItem
 * commits on its own connection (as production's createWorkItem does). Timer yields between
 * the read and the insert open the race window a missing lock would lose. `honorLock:false`
 * is the negative control: it shows the fixture can observe a duplicate at all.
 */
function advisoryLockRepairStore(opts: { honorLock?: boolean } = {}) {
  const honorLock = opts.honorLock ?? true;
  const rows: Array<{ feature_id: string; status: string; plan: string }> = [];
  const lockTails = new Map<string, Promise<void>>();
  const yieldTimer = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const lockKeys: string[] = [];
  const store: RepairTaskStore = {
    workspaceId: 'ws-test',
    isTerminal: (status) => status === 'done' || status === 'dropped',
    createWorkItem: async (wi) => {
      await yieldTimer();
      const id = `EI-REPAIR-${rows.length + 1}`;
      rows.push({ feature_id: id, status: 'open', plan: String(wi.payload.acceptanceContractRepairFor) });
      return { id };
    },
    begin: async <T>(fn: (tx: RepairTaskTx) => Promise<T>): Promise<T> => {
      const releases: Array<() => void> = [];
      const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?');
        if (text.includes('pg_advisory_xact_lock')) {
          const key = String(values[0]);
          lockKeys.push(key);
          if (!honorLock) return [];
          const prior = lockTails.get(key) ?? Promise.resolve();
          let release!: () => void;
          const mine = new Promise<void>((resolve) => {
            release = resolve;
          });
          lockTails.set(
            key,
            prior.then(() => mine),
          );
          releases.push(release);
          await prior;
          return [];
        }
        if (text.includes('FROM harness_shared.work_items')) {
          const plan = String(values[values.length - 1]);
          await yieldTimer();
          return rows.filter((row) => row.plan === plan).map(({ feature_id, status }) => ({ feature_id, status }));
        }
        throw new Error(`unexpected SQL in repair-task fixture: ${text}`);
      }) as RepairTaskTx;
      try {
        return await fn(tx);
      } finally {
        for (const release of releases) release();
      }
    },
  };
  return { store, rows, lockKeys };
}

const repairInput = (planSlug = HOLD_PLAN): AcceptanceRepairTaskInput => ({
  planSlug,
  harness: 'papercusp',
  workspaceId: 'ws-test',
  heldBars: [{ barKey: 'R-1', itemIds: ['P-001'], codes: ['bar_snapshot_clause_not_accepted'] }],
  by: 'su-test',
});

describe('AUTO-BAR-R-3-P-002 — an item bound to an incomplete acceptance contract is held and routed', () => {
  // One case per disjunct of the R-3 falsifier ("a draft, unaccepted or method-less
  // acceptance requirement"), plus the missing-check code the hold also covers.
  async function expectHeldAndRouted(lifecycle: string | undefined, code: string) {
    const { deps, filed, edges } = holdDeps(holdSnapshot(holdBar('R-1', [['P-001', lifecycle]], [code])));
    const hold = await acceptanceReadinessHold(holdItem('WI-held', ['P-001']), holdCtx, deps);

    expect(hold).toMatchObject({
      planSlug: HOLD_PLAN,
      itemId: 'P-001',
      effectiveStatus: 'acceptance-incomplete',
      staleBlockedHint: null,
    });
    expect(hold!.reason).toContain(code);
    // The verdict is side-effect free; routing runs only after the caller released the claim.
    expect(filed).toHaveLength(0);
    expect(await hold!.routeAfterRelease()).toBe('held behind repair task EI-REPAIR-1 (filed now)');
    expect(filed[0]).toMatchObject({ planSlug: HOLD_PLAN, heldBars: [{ barKey: 'R-1', codes: [code] }] });
    expect(edges).toEqual(['EI-REPAIR-1->WI-held']);
  }

  it('draft: holds a work-item bound to a draft clause', async () => {
    await expectHeldAndRouted('draft', 'bar_snapshot_clause_not_accepted');
  });

  // The hold trusts the snapshot's acceptance verdict, not the lifecycle label: a mapping
  // with no recorded lifecycle (an older snapshot) still binds, and is held when unaccepted.
  it('unaccepted: holds a work-item whose clause the snapshot reports not accepted, with no lifecycle label', async () => {
    await expectHeldAndRouted(undefined, 'bar_snapshot_clause_not_accepted');
  });

  it('method-less: holds a work-item bound to an accepted clause with no METHOD', async () => {
    await expectHeldAndRouted('active', 'bar_snapshot_method_missing');
  });

  it('check-less: holds a work-item bound to an accepted clause with no runnable check', async () => {
    await expectHeldAndRouted('active', 'bar_snapshot_check_missing');
  });

  it('only the three contract codes hold; proof and grading gaps do not', () => {
    const snap = holdSnapshot(
      holdBar('R-1', [['P-001']], ['bar_snapshot_proof_missing', 'bar_snapshot_grading_missing']),
      holdBar('R-2', [['P-001']], ['bar_snapshot_method_missing', 'bar_snapshot_proof_inadequate']),
    );
    expect(incompleteAcceptanceBarsForItems(snap, ['P-001'])).toEqual([
      { barKey: 'R-2', itemIds: ['P-001'], codes: ['bar_snapshot_method_missing'] },
    ]);
  });
});

describe('AUTO-BAR-R-16-P-002 — concurrent pulls file exactly one repair task per plan', () => {
  it('two concurrent find-or-file calls on one plan file ONE task and both receive its id', async () => {
    const { store, rows, lockKeys } = advisoryLockRepairStore();
    const [a, b] = await Promise.all([
      findOrFileAcceptanceRepairTask(repairInput(), store),
      findOrFileAcceptanceRepairTask(repairInput(), store),
    ]);

    expect(rows).toHaveLength(1);
    expect([a, b].filter((r) => r.filed)).toHaveLength(1);
    expect(a.id).toBe(b.id);
    expect(new Set(lockKeys)).toEqual(new Set([`acceptance-contract-repair:ws-test:${HOLD_PLAN}`]));
  });

  // Negative control: the same race WITHOUT the lock files twice, so the case above can fail.
  it('negative control: with the advisory lock ignored, the same race files a duplicate', async () => {
    const { store, rows } = advisoryLockRepairStore({ honorLock: false });
    await Promise.all([
      findOrFileAcceptanceRepairTask(repairInput(), store),
      findOrFileAcceptanceRepairTask(repairInput(), store),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('the lock is per plan: concurrent pulls on two plans each file their own task', async () => {
    const { store, rows } = advisoryLockRepairStore();
    const [a, b] = await Promise.all([
      findOrFileAcceptanceRepairTask(repairInput('plan-a'), store),
      findOrFileAcceptanceRepairTask(repairInput('plan-b'), store),
    ]);
    expect(rows).toHaveLength(2);
    expect(a.filed && b.filed).toBe(true);
  });

  it('a closed repair task is never reused: the next pull files a fresh one', async () => {
    const { store, rows } = advisoryLockRepairStore();
    const first = await findOrFileAcceptanceRepairTask(repairInput(), store);
    rows[0]!.status = 'done';
    const second = await findOrFileAcceptanceRepairTask(repairInput(), store);
    expect(second).toEqual({ id: 'EI-REPAIR-2', filed: true });
    expect(second.id).not.toBe(first.id);
  });
});

describe('AUTO-BAR-R-18-P-002 — the hold does not over-block', () => {
  const snap = holdSnapshot(
    holdBar('R-1', [['P-001', 'draft']], ['bar_snapshot_clause_not_accepted']),
    holdBar('R-2', [['P-002', 'active']], ['bar_snapshot_proof_missing', 'bar_snapshot_grading_missing']),
    holdBar('R-3', [['P-004', 'retired']], ['bar_snapshot_method_missing']),
  );

  it.each([
    ['a complete-contract item (only proof/grading still owed)', ['P-002']],
    ['an independent item no BAR maps, while a sibling is held', ['P-003']],
    ['an item mapped only by a retired clause', ['P-004']],
    ['unplanned work', null],
  ])('leaves %s claimable, with no repair task and no edge', async (_label, itemIds) => {
    const { deps, filed, edges } = holdDeps(snap);
    expect(await acceptanceReadinessHold(holdItem('WI-free', itemIds as string[] | null), holdCtx, deps)).toBeNull();
    expect(filed).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  // The R-18 behaviour in one scenario: the held sibling and both claimable items share
  // one snapshot, so a hold that leaked plan-wide would fail here.
  it('positive: while sibling P-001 is held, the complete-contract sibling and the independent item both stay claimable', async () => {
    const { deps, filed, edges } = holdDeps(snap);
    expect(await acceptanceReadinessHold(holdItem('WI-held', ['P-001']), holdCtx, deps)).not.toBeNull();
    expect(await acceptanceReadinessHold(holdItem('WI-complete', ['P-002']), holdCtx, deps)).toBeNull();
    expect(await acceptanceReadinessHold(holdItem('WI-independent', ['P-003']), holdCtx, deps)).toBeNull();
    expect(filed).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('a plan with no acceptance rubric yet holds nothing (rubrics are authored after implementation)', async () => {
    const { deps, filed } = holdDeps(holdSnapshot());
    expect(await acceptanceReadinessHold(holdItem('WI-free', ['P-001']), holdCtx, deps)).toBeNull();
    expect(filed).toHaveLength(0);
  });

  it('fails open on a snapshot read failure', async () => {
    const { deps, filed } = holdDeps(holdSnapshot());
    deps.readSnapshot = async () => {
      throw new Error('pg blip');
    };
    expect(await acceptanceReadinessHold(holdItem('WI-free', ['P-001']), holdCtx, deps)).toBeNull();
    expect(filed).toHaveLength(0);
  });

  // Discrimination: the same snapshot DOES hold the sibling bound to the draft clause, so the
  // nulls above are the verdict and not a hold that never fires.
  it('control: the sibling bound to the draft clause in the same snapshot is held', async () => {
    const { deps } = holdDeps(snap);
    expect(await acceptanceReadinessHold(holdItem('WI-held', ['P-001']), holdCtx, deps)).not.toBeNull();
  });
});
