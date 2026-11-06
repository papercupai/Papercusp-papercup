import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { dispatchProjectedToolToMcp } from '@papercusp/tooldef-mcp';

const h = vi.hoisted(() => ({
  getFleet: vi.fn(),
  getFleetHeadcountTarget: vi.fn(),
  governorFlagOn: vi.fn(),
  listFleetRosterDiagnosed: vi.fn(),
  liveFleetMemberIds: vi.fn(),
  countRunningWorkspaceBees: vi.fn(),
  countRunningFleetBees: vi.fn(),
  getCompletionIntegrityStats: vi.fn(),
  fleetEverMembers: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  executingOwnersSince: vi.fn(),
  getLoopStatuses: vi.fn(),
  findLiveHostAsync: vi.fn(),
  // P-007 / R-17: pending event_awaits rows for the silence rule's await leg.
  awaitRows: [] as { subscriber_id: string; event_key: string }[],
}));

// P-007 / R-17: the headcount `current` read goes through readFleetMemberSilence,
// whose await leg queries harness_shared.event_awaits. Answer ONLY that query from
// the fixture; every other query is delegated to the real getOrgPg untouched, so
// the pre-existing legs behave exactly as before this double existed. The real pool
// is resolved LAZILY: in this test env `actual.getOrgPg()` itself throws, and calling
// it eagerly would fail the event_awaits leg too (→ null partition → unknown count).
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  type Pg = ReturnType<typeof actual.getOrgPg>;
  return {
    ...actual,
    getOrgPg: (...args: Parameters<typeof actual.getOrgPg>) => {
      let real: Pg | undefined;
      const realPg = (): Pg => (real ??= actual.getOrgPg(...args));
      const realSql = () =>
        realPg().sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
      const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join('$').includes('harness_shared.event_awaits')
          ? Promise.resolve(h.awaitRows)
          : realSql()(strings, ...values);
      const sqlProxy = new Proxy(sql, { get: (_t, p) => Reflect.get(realSql(), p) });
      return new Proxy({} as Pg, {
        get: (_t, p) => (p === 'sql' ? sqlProxy : Reflect.get(realPg() as object, p)),
      });
    },
  };
});

vi.mock('../../agent-fleets-store', async () => {
  const actual =
    await vi.importActual<typeof import('../../agent-fleets-store')>('../../agent-fleets-store');
  return {
    ...actual,
    getFleet: (...a: unknown[]) => h.getFleet(...a),
    getFleetHeadcountTarget: (...a: unknown[]) => h.getFleetHeadcountTarget(...a),
  };
});
vi.mock('../../fleet/fleet-staffing-read', async () => {
  const actual = await vi.importActual<typeof import('../../fleet/fleet-staffing-read')>('../../fleet/fleet-staffing-read');
  return {
    ...actual,
    defaultFleetStaffingReadDeps: () => ({
      ...actual.defaultFleetStaffingReadDeps(),
      governorFlagOn: () => h.governorFlagOn(),
    }),
  };
});
// Real split helpers (pure) + a mocked roster/bee-count IO seam. status.ts now calls
// listFleetRosterDiagnosed (WI-3818) — mocked to resolve { entries, degradedLegs }.
vi.mock('../../fleet/fleet-roster', async () => {
  const actual =
    await vi.importActual<typeof import('../../fleet/fleet-roster')>('../../fleet/fleet-roster');
  return {
    isBeeRole: actual.isBeeRole,
    splitFleetRosterCounts: actual.splitFleetRosterCounts,
    listFleetRosterDiagnosed: (...a: unknown[]) => h.listFleetRosterDiagnosed(...a),
    liveFleetMemberIds: (...a: unknown[]) => h.liveFleetMemberIds(...a),
    countRunningWorkspaceBees: (...a: unknown[]) => h.countRunningWorkspaceBees(...a),
    countRunningFleetBees: (...a: unknown[]) => h.countRunningFleetBees(...a),
  };
});
// WI-2034624: productive headcount is attested from recent agent-origin
// execution over the canonical live roster, so the telemetry read is its own
// mocked IO seam. `null` is its honest "leg failed" value, NOT a measured zero.
vi.mock('../../fleet/assignments', async () => {
  const actual =
    await vi.importActual<typeof import('../../fleet/assignments')>('../../fleet/assignments');
  return {
    ...actual,
    executingOwnersSince: (...a: unknown[]) => h.executingOwnersSince(...a),
  };
});
vi.mock('../../work-items', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-items')>(),
  getCompletionIntegrityStats: (...a: unknown[]) => h.getCompletionIntegrityStats(...a),
}));
// WI-7286: the per-member engine-loop batch read is its own IO seam. Spread the real
// module so the rest of loop.ts (imported transitively) keeps its real behavior — only
// the batch fetch is stubbed.
vi.mock('../../harness/routines/loop', async () => {
  const actual =
    await vi.importActual<typeof import('../../harness/routines/loop')>('../../harness/routines/loop');
  return {
    ...actual,
    getLoopStatuses: (...a: unknown[]) => h.getLoopStatuses(...a),
  };
});
vi.mock('../../events/await/psu-pty-discovery', async () => {
  const actual = await vi.importActual<typeof import('../../events/await/psu-pty-discovery')>(
    '../../events/await/psu-pty-discovery',
  );
  return {
    ...actual,
    findLiveHostAsync: (...a: unknown[]) => h.findLiveHostAsync(...a),
  };
});
vi.mock('../../fleet-membership-store', () => ({
  fleetEverMembers: (...a: unknown[]) => h.fleetEverMembers(...a),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: (...a: unknown[]) => h.resolveAgentIdentity(...a),
}));
// Mirrors the real resolveConcreteWorkspaceId contract (workspace-registry.ts): the
// first CONCRETE candidate wins, the unscoped '*' sentinel is skipped rather than
// passed into a workspace_id equality filter, and an all-empty list falls back to the
// active workspace.
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws',
  resolveConcreteWorkspaceId: (...candidates: Array<string | null | undefined>) => {
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed && trimmed !== '*') return trimmed;
      }
    }
    return 'ws';
  },
}));

import statusTool, {
  classifyLaunchTransactionUnconfirmedMembers,
  FLEET_STATUS_TIER_CAPS,
  reconcileFleetStatusLiveness,
  shapeFleetStatus,
} from './status';
import type { FleetRosterEntry } from '../../fleet/fleet-roster';
import { fleetSlugFromName } from '../../agent-fleets-store';
import { FLEET_LEADER_MISSING_GRACE_MS } from '../../scheduler/fleet-scope-admission';

const CTX = { workspaceId: 'ws', role: 'operator' } as const;
const parse = (res: { content?: { text: string }[]; data?: unknown }) =>
  res.data ?? JSON.parse(res.content?.[0]?.text ?? '{}');
const invoke = (args: Record<string, unknown>) =>
  (
    statusTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content?: { text: string }[]; data?: unknown }>;
    }
  ).handler(args, CTX);

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-test', workspaceId: 'ws' });
  h.getFleet.mockResolvedValue({
    workspaceId: 'ws',
    fleetSlug: 'rocket',
    title: 'Rocket Fleet',
    description: 'Handles the rocket lane',
    owner: 'su-owner',
    leaderOwnerId: 'su-leader',
    colorScheme: 'forest',
    lastLaunchTransaction: {
      version: 1,
      transactionId: 'tx-1',
      state: 'partial',
      recovery: { retryOwnerIds: ['su-missing'], nextAction: 'retry unresolved members' },
    },
    createdAt: 0,
    updatedAt: 0,
  });
  h.listFleetRosterDiagnosed.mockResolvedValue({
    entries: [
      {
        agentId: 'su-leader',
        ownerLabel: 'Leader',
        fleetRole: 'leader',
        agentRole: 'su',
        intent: 'ship it',
        alive: true,
        sessionState: 'live',
        lastActiveSecAgo: 2,
        doing: 'WI-1',
        load: 1,
      },
    ],
    degradedLegs: [],
  });
  h.countRunningWorkspaceBees.mockResolvedValue(0);
  h.countRunningFleetBees.mockResolvedValue(0);
  h.getFleetHeadcountTarget.mockResolvedValue(null);
  h.governorFlagOn.mockResolvedValue(true);
  h.liveFleetMemberIds.mockResolvedValue([]);
  // Matches the real helper: an empty id list short-circuits to an empty Set —
  // a MEASURED zero, never the `null` that means the telemetry leg failed.
  h.executingOwnersSince.mockResolvedValue(new Set<string>());
  h.getCompletionIntegrityStats.mockResolvedValue({
    harness: 'papercusp',
    terminalTotal: 10,
    genuineCompletions: 7,
    dedupOrUnverified: 3,
    gateJudged: 4,
  });
  h.fleetEverMembers.mockResolvedValue(new Set(['su-leader']));
  // An empty map is a MEASURED "no loop rows for these owners", not a failed read —
  // so the healthy-payload tests above stay byte-identical (no degraded leg).
  h.getLoopStatuses.mockResolvedValue(new Map());
  h.findLiveHostAsync.mockResolvedValue(null);
  h.awaitRows = [];
});

describe('fleet:status', () => {
  it('opts out of the dispatcher ambient workspace transaction', () => {
    expect((statusTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it.each(['trimmed', 'standard'] as const)(
    'applies the %s payload tier through the registered MCP dispatcher',
    async (payloadTier) => {
      const entries = Array.from({ length: FLEET_STATUS_TIER_CAPS[payloadTier].members + 3 }, (_, index) => ({
        agentId: index === 0 ? 'su-leader' : `su-member-${index}`,
        ownerLabel: index === 0 ? 'Leader' : `Member ${index}`,
        fleetRole: index === 0 ? 'leader' : 'member',
        agentRole: 'su',
        intent: `work ${index}`,
        alive: true,
        heartbeatFresh: true,
        sessionState: 'live',
        lastActiveSecAgo: 1,
        doing: `WI-${index}`,
        load: 1,
      }));
      h.listFleetRosterDiagnosed.mockResolvedValueOnce({ entries, degradedLegs: [] });

      const projected = lookupByMcpName('fleet:status');
      expect(projected).toBeTruthy();
      const result = await dispatchProjectedToolToMcp(
        projected!,
        'fleet:status',
        { fleet: 'rocket', payloadTier },
        {
          ...CTX,
          transport: 'mcp',
          requestedFormat: 'json',
          requestedStructured: false,
          gateBypass: { capability: true, role: true, quota: true },
          log: vi.fn(),
          signal: new AbortController().signal,
          progress: vi.fn(),
          emit: vi.fn(),
        } as never,
        {},
      );

      expect(result.isError).toBeUndefined();
      const out = JSON.parse((result.content[0] as { text: string }).text);
      expect(out.members).toHaveLength(FLEET_STATUS_TIER_CAPS[payloadTier].members + 1);
      expect(out.members.at(-1).agentId).toBe('(truncated)');
      expect(out.members_note).toContain(`roster capped at ${FLEET_STATUS_TIER_CAPS[payloadTier].members}`);
    },
  );

  it('keeps the deliberate full-roster response parseable for machine consumers', () => {
    expect((statusTool as { skipResultDoor?: string }).skipResultDoor).toBe('oversize-by-design');
  });

  it('returns the live roster without completion stats when no harness is requested', async () => {
    const result = await invoke({ fleet: 'rocket' });
    expect(result).toMatchObject({
      data: expect.objectContaining({ ok: true, members: expect.any(Array) }),
    });
    const out = parse(result);
    expect(out.ok).toBe(true);
    expect(out.completionStats).toBeUndefined();
    expect(out.launchTransaction).toMatchObject({ transactionId: 'tx-1', state: 'partial' });
    expect(out.populationLifecycle).toMatchObject({
      schemaVersion: 'fleet-population-lifecycle-v1',
      fleet: 'rocket',
      currentRunnableRoster: {
        census: { population: 'current-runnable-roster', counted: 1 },
        ownerIds: ['su-leader'],
      },
      relevantRoster: {
        census: { population: 'relevant-roster', counted: 1 },
        ownerIds: ['su-leader'],
      },
      everMembers: { counted: 1, ownerIds: ['su-leader'] },
      liveness: { live: 1, dead: 0 },
      claimFlow: { status: 'unknown', values: null },
    });
    expect(h.getCompletionIntegrityStats).not.toHaveBeenCalled();
  });

  it('resolves an untruncated launch name to the canonical fleet slug', async () => {
    const launchName = 'papercusp-session-transcript-exact-fuzzy-search-2026-09-14-plan-fleet';
    const slug = fleetSlugFromName(launchName);
    h.getFleet.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: slug,
      title: launchName,
      description: 'Handles the test lane',
      owner: 'su-owner',
      leaderOwnerId: 'su-leader',
      colorScheme: 'forest',
      lastLaunchTransaction: null,
      createdAt: 0,
      updatedAt: 0,
    });

    const out = parse(await invoke({ fleet: launchName }));

    expect(h.getFleet).toHaveBeenCalledWith('ws', slug);
    expect(h.listFleetRosterDiagnosed).toHaveBeenCalledWith(
      expect.objectContaining({ fleetSlug: slug, workspaceId: 'ws' }),
    );
    expect(out).toMatchObject({ ok: true, slug });
  });

  it('returns unknown_fleet instead of an untyped not-found response', async () => {
    h.getFleet.mockResolvedValueOnce(null);

    const out = parse(await invoke({ fleet: 'does-not-exist' }));

    expect(out).toMatchObject({ ok: false, error: 'unknown_fleet', fleet: 'does-not-exist', workspaceSearched: 'ws' });
    expect(h.listFleetRosterDiagnosed).not.toHaveBeenCalled();
  });

  it('reports an enabled target against the exact current launch membership', async () => {
    h.getFleetHeadcountTarget.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: 'rocket',
      enabled: true,
      target: 5,
      config: {},
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    h.liveFleetMemberIds.mockResolvedValueOnce(['su-1', 'su-2', 'su-3']);
    // Telemetry unreadable: only then does a legacy fleet fall back to its
    // live-roster count.
    h.executingOwnersSince.mockResolvedValueOnce(null);

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.headcount).toMatchObject({
      enabled: true,
      target: 5,
      current: 3,
      shortfall: 2,
      underStrength: true,
      verdict: 'under-strength',
      basis: {
        kind: 'legacy-live-roster-fallback',
        liveRosterMembers: 3,
        executingMembers: null,
        transactionWorkerReadyMembers: null,
      },
    });
    expect(h.liveFleetMemberIds).toHaveBeenCalledWith('rocket', 'ws', 'launch');
  });

  it('retains an in-force no-top-up rule in the fleet status read', async () => {
    const now = Date.now();
    const rule = {
      kind: 'supervise-revoked', ratifiedBy: 'su-leader', ratifiedAt: now,
      reason: 'Independent source admission is still closed', until: now + 3_600_000,
      suspendedTarget: 3, suspendedSupervise: true,
    };
    h.getFleetHeadcountTarget.mockResolvedValueOnce({
      workspaceId: 'ws', fleetSlug: 'rocket', enabled: true, target: 3,
      config: { supervise: false, topUpRule: rule },
      nextAttemptAt: null, backoffMs: 0, lastError: null,
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.headcount).toMatchObject({
      held: false,
      notHeldBecause: 'top-up-rule',
      topUpRule: {
        status: 'in-force', inherited: false, kind: rule.kind,
        ratifiedBy: rule.ratifiedBy, reason: rule.reason, until: rule.until,
      },
    });
  });

  it.each([true, false, null])('reports governor eligibility with flag %s', async (governorFlagOn) => {
    h.governorFlagOn.mockResolvedValueOnce(governorFlagOn);
    h.getFleetHeadcountTarget.mockResolvedValueOnce({
      workspaceId: 'ws', fleetSlug: 'rocket', enabled: true, target: 3,
      config: { supervise: true },
      nextAttemptAt: null, backoffMs: 0, lastError: null,
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.headcount).toMatchObject({
      held: governorFlagOn,
      notHeldBecause: governorFlagOn === false ? 'governor-flag-off' : null,
      topUpRule: { status: 'none' },
    });
    expect(out.degradedLegs ?? []).toEqual(governorFlagOn === null ? ['headcountGovernorFlag'] : []);
  });

  it('keeps a disabled saved launch recipe from masquerading as an active target', async () => {
    h.getFleetHeadcountTarget.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: 'rocket',
      enabled: false,
      target: 1,
      config: {},
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    h.liveFleetMemberIds.mockResolvedValueOnce(['su-1', 'su-2']);
    h.executingOwnersSince.mockResolvedValueOnce(new Set(['su-1', 'su-2']));

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.headcount).toMatchObject({
      enabled: false,
      target: null,
      current: 2,
      shortfall: null,
      underStrength: null,
      verdict: 'disabled',
      basis: {
        kind: 'agent-origin-execution-attested',
        liveRosterMembers: 2,
        executingMembers: 2,
        transactionWorkerReadyMembers: null,
      },
    });
  });

  // P-007 / R-17: a heartbeat-only member holding just the inbox-wake keepalive is
  // silent and does not count; a member parked on a declared await does count.
  it('excludes a silent member from current and counts a member parked on a declared await', async () => {
    h.getFleetHeadcountTarget.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: 'rocket',
      enabled: true,
      target: 3,
      config: {},
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    h.liveFleetMemberIds.mockResolvedValueOnce(['su-busy', 'su-waiting', 'su-quiet']);
    h.executingOwnersSince.mockResolvedValueOnce(new Set(['su-busy']));
    h.awaitRows = [
      { subscriber_id: 'su-waiting', event_key: 'work-item:done:WI-1' },
      { subscriber_id: 'su-quiet', event_key: 'coord:inbox-wake:su-quiet' },
    ];

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.headcount).toMatchObject({
      enabled: true,
      target: 3,
      current: 2,
      shortfall: 1,
      underStrength: true,
      verdict: 'under-strength',
      basis: { kind: 'agent-origin-execution-attested', liveRosterMembers: 3, executingMembers: 2 },
    });
    expect(out.degradedLegs ?? []).not.toContain('headcountExecuting');
  });

  // WI-2034624: `su-prior-transaction-live` is deliberately ABSENT from
  // `workerReadyMemberIds` and present in the execution attestation — the exact
  // shape the old transaction-scoped intersection dropped.
  it('reports productive headcount from agent-origin execution over the live roster', async () => {
    h.getFleet.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: 'rocket',
      leaderOwnerId: 'su-leader',
      controlState: 'active',
      lastLaunchTransaction: {
        workerReadyMemberIds: ['su-ready-live', 'su-ready-gone'],
        unconfirmedMemberIds: [],
        failed: [],
      },
      createdAt: 0,
      updatedAt: 0,
    });
    h.getFleetHeadcountTarget.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: 'rocket',
      enabled: true,
      target: 3,
      config: {},
      nextAttemptAt: null,
      backoffMs: 0,
      lastError: null,
    });
    h.liveFleetMemberIds.mockResolvedValueOnce([
      'su-ready-live',
      'su-unready-live',
      'su-prior-transaction-live',
    ]);
    h.executingOwnersSince.mockResolvedValueOnce(
      new Set(['su-ready-live', 'su-prior-transaction-live']),
    );

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.headcount).toMatchObject({
      enabled: true,
      target: 3,
      current: 2,
      shortfall: 1,
      underStrength: true,
      verdict: 'under-strength',
      basis: {
        kind: 'agent-origin-execution-attested',
        liveRosterMembers: 3,
        executingMembers: 2,
        transactionWorkerReadyMembers: 2,
      },
    });
    expect(out.degradedLegs ?? []).not.toContain('headcountExecuting');
  });

  it('labels unconfirmed launch ids by the roster presence read', async () => {
    h.getFleet.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: 'rocket',
      leaderOwnerId: 'su-leader',
      controlState: 'active',
      lastLaunchTransaction: {
        unconfirmedMemberIds: ['su-unconfirmed-live', 'su-unconfirmed-absent'],
      },
    });
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        {
          agentId: 'su-leader',
          ownerLabel: 'Leader',
          agentRole: 'su',
          fleetRole: 'leader',
          alive: true,
          sessionState: 'live',
        },
        {
          agentId: 'su-unconfirmed-live',
          agentRole: 'su',
          fleetRole: 'member',
          alive: true,
          heartbeatFresh: true,
          sessionState: 'live',
          lastActiveSecAgo: 4,
        },
      ],
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.launchTransactionUnconfirmedMembers).toEqual([
      {
        ownerId: 'su-unconfirmed-live',
        presence: 'present',
        sessionState: 'live',
        heartbeatFresh: true,
        lastActiveSecAgo: 4,
      },
      {
        ownerId: 'su-unconfirmed-absent',
        presence: 'absent',
        sessionState: null,
        heartbeatFresh: null,
        lastActiveSecAgo: null,
      },
    ]);
  });

  it('returns an ended leader with an explicit liveness annotation', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        {
          agentId: 'su-leader',
          agentRole: 'su',
          fleetRole: 'leader',
          alive: false,
          sessionState: 'ended',
        },
        {
          agentId: 'su-member',
          agentRole: 'su',
          fleetRole: 'member',
          alive: true,
          sessionState: 'live',
        },
      ],
      leaderLiveness: {
        ownerId: 'su-leader',
        presenceRow: true,
        recordedLive: false,
        sessionState: 'ended',
        complete: true,
      },
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leader).toEqual({
      agentId: 'su-leader',
      sessionState: 'ended',
      heartbeatFresh: false,
      lastActiveSecAgo: null,
      presenceRow: true,
    });
    expect(out.leaderId).toBe('su-leader');
    expect(out.leaderLive).toBe(false);
    expect(out.leaderSessionState).toBe('ended');
    expect(out.leaderVacant).toBe(true);
    expect(out.leadershipBlockage).toEqual({
      reason: 'registered-leader-ended',
      leaderOwnerId: 'su-leader',
      liveMemberCount: 1,
    });
  });

  it('reports complete leader absence with the persisted succession grace clock', async () => {
    const nowMs = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const missingSinceMs = nowMs - 2 * 60_000;
    h.getFleet.mockResolvedValueOnce({
      workspaceId: 'ws',
      fleetSlug: 'rocket',
      title: 'Rocket Fleet',
      description: 'Handles the rocket lane',
      owner: 'su-owner',
      leaderOwnerId: 'su-leader',
      leaderMissingSinceMs: missingSinceMs,
      colorScheme: 'forest',
      lastLaunchTransaction: null,
      createdAt: 0,
      updatedAt: 0,
    });
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [{
        agentId: 'su-member',
        agentRole: 'su',
        fleetRole: 'member',
        alive: true,
        sessionState: 'live',
      }],
      leaderLiveness: {
        ownerId: 'su-leader',
        presenceRow: false,
        recordedLive: false,
        sessionState: null,
        complete: true,
      },
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leaderVacant).toBe(true);
    expect(out.leaderVacancy).toEqual({
      state: 'complete-absence',
      vacant: true,
      livenessComplete: true,
      recordedLive: false,
      missingSinceMs,
      graceMs: FLEET_LEADER_MISSING_GRACE_MS,
      graceRemainingMs: FLEET_LEADER_MISSING_GRACE_MS - 2 * 60_000,
    });
    expect(out.leadershipBlockage).toEqual({
      reason: 'registered-leader-missing',
      leaderOwnerId: 'su-leader',
      liveMemberCount: 1,
    });
  });

  it('treats a completely verified recorded-live leader as present, not vacant', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [],
      leaderLiveness: {
        ownerId: 'su-leader',
        presenceRow: false,
        recordedLive: true,
        sessionState: 'recorded',
        complete: true,
      },
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leaderLive).toBe(true);
    expect(out.leaderSessionState).toBe('recorded');
    expect(out.leaderVacant).toBe(false);
    expect(out.leaderVacancy).toMatchObject({
      state: 'leader-live',
      vacant: false,
      livenessComplete: true,
      recordedLive: true,
      missingSinceMs: null,
      graceRemainingMs: null,
    });
  });

  it('does not present a durable leader with no presence row as live', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        {
          agentId: 'su-member',
          agentRole: 'su',
          fleetRole: 'member',
          alive: true,
          sessionState: 'live',
        },
      ],
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leader).toEqual({
      agentId: 'su-leader',
      sessionState: 'unknown',
      heartbeatFresh: false,
      lastActiveSecAgo: null,
      presenceRow: false,
    });
    expect(out.leaderId).toBe('su-leader');
    expect(out.leaderLive).toBe(false);
    // Missing presence is not enough evidence to seize leadership on a read.
    expect(out.leaderSessionState).toBeNull();
    expect(out.leaderVacant).toBe(false);
    expect(out).not.toHaveProperty('leadershipBlockage');
  });

  // EI-24962274233684871: a parked (wakeable, between-turns) or draining leader
  // holds its seat. It must not read vacant / registered-leader-missing.
  it.each(['parked', 'draining'])('reports a %s registered leader as present, not missing', async (state) => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [{
        agentId: 'su-member',
        agentRole: 'su',
        fleetRole: 'member',
        alive: true,
        sessionState: 'live',
      }],
      leaderEntry: {
        agentId: 'su-leader',
        agentRole: 'su',
        fleetRole: 'leader',
        fleetSlug: 'rocket',
        alive: true,
        sessionState: state,
        heartbeatFresh: true,
        lastActiveSecAgo: 30,
      },
      leaderLiveness: {
        ownerId: 'su-leader',
        presenceRow: true,
        recordedLive: false,
        sessionState: state,
        complete: true,
      },
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leader).toMatchObject({ agentId: 'su-leader', sessionState: state });
    expect(out.leaderLive).toBe(true);
    expect(out.leaderVacant).toBe(false);
    expect(out.leaderVacancy).toMatchObject({ state: 'leader-live', vacant: false });
    expect(out).not.toHaveProperty('leadershipBlockage');
  });

  it('uses a leader liveness-only enrichment without changing the queried fleet census', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        {
          agentId: 'su-member',
          agentRole: 'su',
          fleetRole: 'member',
          alive: true,
          sessionState: 'live',
        },
      ],
      // The leader is live, but its one presence row is labelled with another
      // fleet. This entry must inform the leader verdict without becoming a
      // member of `rocket`.
      leaderEntry: {
        agentId: 'su-leader',
        agentRole: 'su',
        fleetRole: 'leader',
        fleetSlug: 'other-fleet',
        alive: true,
        sessionState: 'live',
        heartbeatFresh: true,
        lastActiveSecAgo: 1,
      },
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.leader).toEqual({
      agentId: 'su-leader',
      sessionState: 'live',
      heartbeatFresh: true,
      lastActiveSecAgo: 1,
      presenceRow: true,
    });
    expect(out.leaderLive).toBe(true);
    expect(out.leaderVacant).toBe(false);
    expect(out.memberCount).toBe(1);
    expect(out.members.map((member: { agentId: string }) => member.agentId)).toEqual(['su-member']);
    expect(h.listFleetRosterDiagnosed).toHaveBeenCalledWith({
      fleetSlug: 'rocket',
      workspaceId: 'ws',
      leaderOwnerId: 'su-leader',
    });
  });

  it('reports memberCount from the roster (presence) and beeCount from the nursery, plus workspace runningBees (WI-1764 #4 / WI-1813)', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        { agentId: 'su-leader', agentRole: 'su', fleetRole: 'leader', alive: true },
        { agentId: 'su-m2', agentRole: 'su', fleetRole: 'member', alive: true },
        { agentId: 's-bee1', agentRole: 'cup', fleetRole: 'member', alive: true },
      ],
      degradedLegs: [],
    });
    h.countRunningWorkspaceBees.mockResolvedValueOnce(4);
    // WI-1813: beeCount is the nursery-authoritative per-fleet count, NOT the roster's
    // presence-labeled bee (the roster has 1 bee; the nursery reports 3 — beeCount = 3).
    h.countRunningFleetBees.mockResolvedValueOnce(3);
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.memberCount).toBe(2); // su-leader + su-m2 (roster split, presence)
    expect(out.beeCount).toBe(3); // from countRunningFleetBees, not the 1 presence-labeled bee
    expect(out.runningBees).toBe(4);
    expect(h.countRunningFleetBees).toHaveBeenCalledWith('rocket', 'ws');
    // full roster still returned regardless of the split
    expect(out.members).toHaveLength(3);
  });

  // EI-7137: an `ended` former member (a dead wave, presence row not yet reaped) must
  // not inflate memberCount forever — but stays visible in the full `members[]` list.
  it('excludes sessionState:"ended" entries from memberCount but keeps them in members[]', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        { agentId: 'su-live1', agentRole: 'su', fleetRole: 'member', alive: true, sessionState: 'live' },
        { agentId: 'su-live2', agentRole: 'su', fleetRole: 'member', alive: true, sessionState: 'parked' },
        // A dead prior-wave member: heartbeat may still look fresh, but wakeability
        // reconciliation (EI-5858) has already determined the session truly ended.
        { agentId: 'su-dead1', agentRole: 'su', fleetRole: 'member', alive: false, sessionState: 'ended' },
        { agentId: 'su-dead2', agentRole: 'su', fleetRole: 'member', alive: false, sessionState: 'ended' },
        { agentId: 's-bee1', agentRole: 'cup', fleetRole: 'member', alive: true, sessionState: 'live' },
      ],
      degradedLegs: [],
    });
    const out = parse(await invoke({ fleet: 'rocket' }));
    expect(out.memberCount).toBe(2); // su-live1 + su-live2 only — the 2 ended rows excluded
    // The full roster (all 5, including the dead ones) is still surfaced for visibility.
    expect(out.members).toHaveLength(5);
    expect(out.members.map((m: { agentId: string }) => m.agentId).sort()).toEqual(
      ['s-bee1', 'su-dead1', 'su-dead2', 'su-live1', 'su-live2'].sort(),
    );
  });

  it('excludes sessionState:"recorded" entries from memberCount but keeps them in members[]', async () => {
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [
        { agentId: 'su-live', agentRole: 'su', fleetRole: 'member', alive: true, sessionState: 'live' },
        // A recorded session has no live presence, but its stale row can remain in the roster.
        { agentId: 'su-recorded', agentRole: 'su', fleetRole: 'member', alive: false, sessionState: 'recorded' },
        { agentId: 's-bee1', agentRole: 'cup', fleetRole: 'member', alive: true, sessionState: 'live' },
      ],
      degradedLegs: [],
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.memberCount).toBe(1);
    expect(out.members).toHaveLength(3);
    expect(out.members.map((m: { agentId: string }) => m.agentId).sort()).toEqual(
      ['s-bee1', 'su-live', 'su-recorded'].sort(),
    );
  });

  it('ends hostless visible rows while preserving headless su members and nursery cups', () => {
    const roster = [
      {
        agentId: 'su-visible-live',
        agentRole: 'su',
        tty: '/dev/pts/11',
        sessionState: 'live',
        alive: true,
      },
      {
        agentId: 'su-visible-dead',
        agentRole: 'su',
        tty: '/dev/pts/12',
        sessionState: 'parked',
        alive: true,
      },
      {
        agentId: 'su-headless',
        agentRole: 'su',
        tty: null,
        sessionState: 'live',
        alive: true,
      },
      {
        agentId: 'cup-without-pty',
        agentRole: 'cup',
        tty: '/dev/pts/13',
        sessionState: 'live',
        alive: true,
      },
    ] as unknown as FleetRosterEntry[];

    reconcileFleetStatusLiveness(roster, (ownerId) =>
      ownerId === 'su-visible-live' ? { host: 'local' } : null,
    );

    expect(roster.find((m) => m.agentId === 'su-visible-live')).toMatchObject({
      sessionState: 'live',
      alive: true,
    });
    expect(roster.find((m) => m.agentId === 'su-visible-dead')).toMatchObject({
      sessionState: 'ended',
      alive: false,
    });
    expect(roster.find((m) => m.agentId === 'su-headless')).toMatchObject({
      sessionState: 'live',
      alive: true,
    });
    expect(roster.find((m) => m.agentId === 'cup-without-pty')).toMatchObject({
      sessionState: 'live',
      alive: true,
    });
  });

  it('keeps harness-wide authority counts explicitly separate from fleet verified fixes', async () => {
    h.getCompletionIntegrityStats.mockResolvedValue({
      ...await h.getCompletionIntegrityStats(),
      population: { kind: 'harness', harness: 'papercusp', window: 'all-time', fleetAttribution: 'none' },
      authorityRecordedCompletions: 7,
      independentlyVerifiedNewChanges: null,
    });
    h.getCompletionIntegrityStats.mockClear();
    const out = parse(await invoke({ fleet: 'rocket', harness: 'papercusp' }));
    expect(h.getCompletionIntegrityStats).toHaveBeenCalledWith('papercusp');
    expect(out.completionStats).toEqual({
      harness: 'papercusp',
      population: { kind: 'harness', harness: 'papercusp', window: 'all-time', fleetAttribution: 'none' },
      authorityRecordedCompletions: 7,
      independentlyVerifiedNewChanges: null,
      gateJudged: 4,
      terminalTotal: 10,
      genuineCompletions: 7,
      dedupOrUnverified: 3,
    });
    expect(out.members).toEqual([
      expect.objectContaining({
        agentId: 'su-leader',
        doing: 'WI-1',
        load: 1,
      }),
    ]);
  });

  // WI-3818: a slow optional leg (completionStats / bee counts) must degrade to its
  // fallback within its own budget instead of hanging the whole handler — and the
  // degradation must be REPORTED (`degraded`/`degradedLegs`), not silently swallowed.
  describe('WI-3818 bounded fan-out — degraded legs', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops completionStats first when it never resolves, still returning the roster promptly', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.getCompletionIntegrityStats.mockReturnValue(new Promise(() => {}));
      const resultPromise = invoke({ fleet: 'rocket', harness: 'papercusp' });
      await vi.advanceTimersByTimeAsync(10_000);
      const out = parse(await resultPromise);
      expect(out.ok).toBe(true);
      expect(out.completionStats).toBeUndefined();
      expect(out.members).toHaveLength(1); // the roster itself still came back
      expect(out.degraded).toBe(true);
      expect(out.degradedLegs).toEqual(['completionStats']);
      warnSpy.mockRestore();
    });

    it('falls back bee counts to 0 + reports the legs when the nursery counts hang', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.countRunningWorkspaceBees.mockReturnValue(new Promise(() => {}));
      h.countRunningFleetBees.mockReturnValue(new Promise(() => {}));
      const resultPromise = invoke({ fleet: 'rocket' });
      await vi.advanceTimersByTimeAsync(10_000);
      const out = parse(await resultPromise);
      expect(out.runningBees).toBe(0);
      expect(out.beeCount).toBe(0);
      expect(out.degraded).toBe(true);
      expect(out.degradedLegs.sort()).toEqual(['beeCount', 'runningBees']);
      warnSpy.mockRestore();
    });

    it('reports unknown headcount instead of a healthy zero when the target read hangs', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.getFleetHeadcountTarget.mockReturnValue(new Promise(() => {}));
      h.liveFleetMemberIds.mockResolvedValueOnce(['su-live']);
      h.executingOwnersSince.mockResolvedValueOnce(new Set(['su-live']));
      const resultPromise = invoke({ fleet: 'rocket' });
      await vi.advanceTimersByTimeAsync(10_000);
      const out = parse(await resultPromise);
      expect(out.headcount).toMatchObject({
        enabled: null,
        target: null,
        current: 1,
        shortfall: null,
        underStrength: null,
        verdict: 'unknown',
        basis: {
          kind: 'agent-origin-execution-attested',
          liveRosterMembers: 1,
          executingMembers: 1,
          transactionWorkerReadyMembers: null,
        },
      });
      expect(out.degradedLegs).toContain('headcountTarget');
      warnSpy.mockRestore();
    });

    it('surfaces a degraded roster sub-read as a prefixed `roster.<leg>` entry', async () => {
      h.listFleetRosterDiagnosed.mockResolvedValueOnce({
        entries: [{ agentId: 'su-leader', agentRole: 'su', fleetRole: 'leader', alive: true }],
        degradedLegs: ['assignments'],
      });
      const out = parse(await invoke({ fleet: 'rocket' }));
      expect(out.degraded).toBe(true);
      expect(out.degradedLegs).toEqual(['roster.assignments']);
      // the roster itself is still returned — the whole point of WI-3818.
      expect(out.members).toHaveLength(1);
    });

    it('omits degraded/degradedLegs entirely when every leg answers in time', async () => {
      const out = parse(await invoke({ fleet: 'rocket', harness: 'papercusp' }));
      expect(out.degraded).toBeUndefined();
      expect(out.degradedLegs).toBeUndefined();
    });
  });

  describe('WI-7286 / EI-19381528967421062 — provider-wall backoff on the roster', () => {
    const backoff = { reason: 'usage_limit', until: '2026-09-04T12:00:00.000Z', resumesInMs: 6_000_000 };

    it('surfaces lifecycleBackoff for a member whose loop is walled', async () => {
      h.getLoopStatuses.mockResolvedValueOnce(
        new Map([['su-leader', { active: true, lifecycleBackoff: backoff }]]),
      );
      const out = parse(await invoke({ fleet: 'rocket' }));
      expect(out.members[0].lifecycleBackoff).toEqual(backoff);
      // The row still reads live — which is exactly why the backoff has to be on it.
      expect(out.members[0].sessionState).toBe('live');
      expect(out.degradedLegs).toBeUndefined();
    });

    it('reads the batch once, for exactly the roster owners', async () => {
      await invoke({ fleet: 'rocket' });
      expect(h.getLoopStatuses).toHaveBeenCalledTimes(1);
      expect(h.getLoopStatuses).toHaveBeenCalledWith(['su-leader']);
    });

    it('omits lifecycleBackoff when the loop is armed but not backed off', async () => {
      h.getLoopStatuses.mockResolvedValueOnce(
        new Map([['su-leader', { active: true, lifecycleBackoff: null }]]),
      );
      const out = parse(await invoke({ fleet: 'rocket' }));
      expect(out.members[0]).not.toHaveProperty('lifecycleBackoff');
    });

    it('does not report a disarmed loop as backed off', async () => {
      // A stale backoff record on an INACTIVE loop is not a silenced member — mirrors
      // decorateLoopMonitorStates, which gates every loop field on loop.active.
      h.getLoopStatuses.mockResolvedValueOnce(
        new Map([['su-leader', { active: false, lifecycleBackoff: backoff }]]),
      );
      const out = parse(await invoke({ fleet: 'rocket' }));
      expect(out.members[0]).not.toHaveProperty('lifecycleBackoff');
    });

    it('reports a failed loop read as a degraded leg, never as a silent all-clear', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      h.getLoopStatuses.mockRejectedValueOnce(new Error('pg down'));
      const out = parse(await invoke({ fleet: 'rocket' }));
      // The absent field alone is ambiguous — "no backoff" and "unread" look identical.
      // degradedLegs is what distinguishes them, so it must name this leg.
      expect(out.members[0]).not.toHaveProperty('lifecycleBackoff');
      expect(out.degraded).toBe(true);
      expect(out.degradedLegs).toContain('loopStatuses');
      // The roster itself still comes back — a backoff read must never fail the status.
      expect(out.ok).toBe(true);
      expect(out.members).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it('skips the batch entirely for an empty roster without degrading', async () => {
      h.listFleetRosterDiagnosed.mockResolvedValueOnce({ entries: [], degradedLegs: [] });
      const out = parse(await invoke({ fleet: 'rocket' }));
      expect(h.getLoopStatuses).not.toHaveBeenCalled();
      expect(out.degradedLegs).toBeUndefined();
    });
  });
});

describe('launch transaction unconfirmed presence classification', () => {
  it('does not turn a degraded presence read into a false absent verdict', () => {
    expect(
      classifyLaunchTransactionUnconfirmedMembers(
        ['su-missing'],
        [],
        ['presence'],
      ),
    ).toEqual([
      {
        ownerId: 'su-missing',
        presence: 'unknown',
        sessionState: null,
        heartbeatFresh: null,
        lastActiveSecAgo: null,
        reason: 'fleet roster presence read degraded; absence is unverified',
      },
    ]);
  });
});

describe('fleet:status payload-tier shaping', () => {
  it('bounds oversized rosters and keeps leader/non-runnable rows visible', () => {
    const source = [
      { agentId: 'su-live-0', sessionState: 'live', intent: 'ordinary' },
      { agentId: 'su-leader', sessionState: 'live', intent: 'leader work' },
      { agentId: 'su-ended', sessionState: 'ended', intent: 'recover me', resumable: true },
      ...Array.from({ length: 24 }, (_, i) => ({ agentId: `su-live-${i + 1}`, sessionState: 'live' })),
    ];

    const out = shapeFleetStatus(
      {
        ok: true,
        slug: 'rocket',
        leaderId: 'su-leader',
        controlState: 'winding-down',
        memberCount: 25,
        members: source,
      },
      'trimmed',
    ) as { controlState: string; members: Array<Record<string, unknown>>; members_note: string };

    expect(out.controlState).toBe('winding-down');
    expect(out.members).toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.members + 1);
    expect(out.members.map((m) => m.agentId)).toContain('su-leader');
    expect(out.members.map((m) => m.agentId)).toContain('su-ended');
    expect(out.members.at(-1)).toMatchObject({ agentId: '(truncated)' });
    expect(out.members_note).toContain('roster capped at');
  });

  it('carries lifecycleBackoff through every tier — the shaper is a whitelist (WI-7286)', () => {
    const backoff = { reason: 'rate_limited', until: '2026-09-04T12:00:00.000Z', resumesInMs: 900_000 };
    // `trimmed` is the DEFAULT read, so a member silenced by a provider wall has to be
    // legible there — not only to a caller who asked for payloadTier:'full'.
    for (const tier of ['trimmed', 'standard'] as const) {
      const out = shapeFleetStatus(
        {
          members: [
            { agentId: 'su-walled', sessionState: 'live', lifecycleBackoff: backoff },
            { agentId: 'su-fine', sessionState: 'live' },
            // A dead row takes the ended/suspect branch — it must not lose the field either.
            { agentId: 'su-gone', sessionState: 'ended', lifecycleBackoff: backoff },
          ],
        },
        tier,
      ) as { members: Array<Record<string, unknown>> };
      expect(out.members[0].lifecycleBackoff, tier).toEqual(backoff);
      expect(out.members[1], tier).not.toHaveProperty('lifecycleBackoff');
      expect(out.members[2].lifecycleBackoff, tier).toEqual(backoff);
    }
  });

  it('retains the liveness decision core and exposes both tier registrations', () => {
    const out = shapeFleetStatus(
      {
        members: [
          {
            agentId: 'su-ended',
            label: 'A'.repeat(400),
            intent: 'B'.repeat(400),
            sessionState: 'ended',
            heartbeatFresh: true,
            resumable: true,
            endedAt: '2026-08-12T10:00:00Z',
            resumeHint: 'launch fresh',
          },
        ],
      },
      'standard',
    ) as { members: Array<Record<string, unknown>> };
    const row = out.members[0];

    expect(row).toMatchObject({
      agentId: 'su-ended',
      heartbeatFresh: true,
      sessionState: 'ended',
      resumable: true,
      endedAt: '2026-08-12T10:00:00Z',
    });
    expect(String(row.label).length).toBeLessThanOrEqual(FLEET_STATUS_TIER_CAPS.standard.label);
    expect(String(row.intent).length).toBeLessThanOrEqual(FLEET_STATUS_TIER_CAPS.standard.intent);
    // WI-2145871: kept as an exact deep-equal on purpose — this assertion is what
    // makes a silent addition to `shape` detectable, so the `contract` added here
    // is ENUMERATED rather than the assertion being loosened to toMatchObject.
    // The `fields` list is the intersection of every projectMember return path's
    // UNCONDITIONAL keys; a conditional key added here would fail on an ordinary
    // live row (measured: .papercusp/scratch/fleet-status-contract-teeth.mts ARM C).
    expect(
      (statusTool as unknown as { shape: { trimmed?: unknown; standard?: unknown; contract?: unknown } }).shape,
    ).toEqual({
      contract: {
        rows: 'members',
        fields: [
          'agentId',
          'label',
          'fleetRole',
          'intent',
          'heartbeatFresh',
          'sessionState',
          'lastActiveSecAgo',
          'doing',
          'load',
        ],
      },
      trimmed: expect.any(Function),
      standard: expect.any(Function),
    });
  });
});

/**
 * EI-21934696112365508 — fleet:status could not name the workspace it meant.
 *
 * `getFleet` is a `workspace_id = $1 AND fleet_slug = $2` equality read and fleet
 * slugs are unique PER WORKSPACE, not globally (observed live: `p2p-release` exists
 * in both `default` and `papercusp-workspace`; `citations-sweep` only in `papercusp`).
 * The tool accepted only { fleet, harness }, so a caller whose workspace differed
 * from the fleet's was stranded — `citations-sweep` was `active` and unreachable,
 * with no argument that could reach it — while every sibling `fleet/`-family read
 * (assignments, leader-brief, bench, kill, tree, ...) already took a `workspace`
 * override. The original report surfaced as a hard `invalid_args` reject.
 */
describe('fleet:status workspace targeting (EI-21934696112365508)', () => {
  it("accepts an explicit workspace and reads the fleet THERE, not in the caller's", async () => {
    // The caller sits in 'ws'; the fleet it names lives in another workspace.
    h.getFleet.mockImplementation(async (workspaceId: string) =>
      workspaceId === 'other-ws'
        ? { workspaceId: 'other-ws', fleetSlug: 'rocket', title: 'Elsewhere', leaderOwnerId: null }
        : null,
    );

    const res = parse(await invoke({ fleet: 'rocket', workspace: 'other-ws' })) as {
      ok?: boolean;
      slug?: string;
    };

    // The read must be issued against the REQUESTED workspace...
    expect(h.getFleet).toHaveBeenCalledWith('other-ws', 'rocket');
    // ...and must not silently fall back to the caller's own.
    expect(h.getFleet).not.toHaveBeenCalledWith('ws', 'rocket');
    expect(res.ok).not.toBe(false);
    expect(res.slug).toBe('rocket');
  });

  it("defaults to the caller's workspace when none is passed", async () => {
    await invoke({ fleet: 'rocket' });
    expect(h.getFleet).toHaveBeenCalledWith('ws', 'rocket');
  });

  it('declares workspace as an OPTIONAL arg the schema actually admits', () => {
    // The filed failure was a hard invalid_args reject: undeclared args are rejected,
    // never ignored, so the arg has to exist on the schema for any of the above to hold.
    const schema = (
      statusTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }
    ).args;
    expect(schema.safeParse({ fleet: 'rocket', workspace: 'other-ws' }).success).toBe(true);
    expect(schema.safeParse({ fleet: 'rocket' }).success).toBe(true);
  });

  it('names the workspace it searched when the fleet is absent', async () => {
    h.getFleet.mockResolvedValue(null);

    const res = parse(await invoke({ fleet: 'citations-sweep', workspace: 'papercusp' })) as {
      ok?: boolean;
      error?: string;
      message?: string;
      workspaceSearched?: string;
    };

    expect(res.ok).toBe(false);
    // "not in this workspace" is unactionable when the caller cannot see which
    // workspace "this" resolved to — the miss must name it, and say how to retarget.
    expect(res.workspaceSearched).toBe('papercusp');
    expect(res.error).toBe('unknown_fleet');
    expect(res.message).toContain('papercusp');
    expect(res.message).toContain('workspace');
  });

  it("skips the unscoped-su '*' sentinel rather than querying for it (EI-13820)", async () => {
    // An unscoped su session's identity echoes ctx.workspaceId verbatim, and that is
    // the literal '*' — which no real row matches, so it must never reach the filter.
    h.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-test', workspaceId: '*' });
    h.getFleet.mockResolvedValue(null);

    await (
      statusTool as unknown as {
        handler: (a: unknown, c: unknown) => Promise<unknown>;
      }
    ).handler({ fleet: 'rocket' }, { workspaceId: '*', role: 'operator' } as never);

    expect(h.getFleet).toHaveBeenCalledWith('ws', 'rocket');
    expect(h.getFleet).not.toHaveBeenCalledWith('*', 'rocket');
  });
});

describe('fleet:status slow-path bounds', () => {
  it('bounds live-sized launch transaction lists, failures, governor history and reasons', () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      at: index,
      action: 'observe',
      reason: 'x'.repeat(600),
    }));
    const memberIds = Array.from({ length: 53 }, (_, index) => `su-member-${index}`);
    const failed = Array.from({ length: 30 }, (_, index) => ({
      ownerId: `su-failed-${index}`,
      phase: 'spawn',
      reason: 'failure detail '.repeat(80),
    }));
    const source = {
      members: [],
      launchTransaction: {
        transactionId: 'tx-history',
        requestedMemberIds: memberIds,
        failed,
        governor: {
          history,
          terminalVerdict: {
            liveMemberIds: memberIds,
            workerReadyMemberIds: memberIds.slice(0, 3),
            unreadyMemberIds: [],
            unverifiedMemberIds: memberIds.slice(0, 50),
            reason: 'launch result',
          },
        },
      },
    };

    const trimmed = shapeFleetStatus(source, 'trimmed') as {
      launchTransaction: Record<string, unknown> & { governor: Record<string, unknown> };
    };
    const trimmedTransaction = trimmed.launchTransaction;
    const trimmedGovernor = trimmedTransaction.governor;
    const trimmedHistory = trimmedGovernor.history as Array<Record<string, unknown>>;
    expect(trimmedHistory).toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.launchHistory);
    expect(trimmedHistory[0]?.at).toBe(28);
    expect(trimmedHistory[0]?.reason).toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.launchHistoryReason);
    expect(trimmedGovernor.historyTotal).toBe(40);
    expect(trimmedGovernor.historyTruncated).toBe(true);
    expect(trimmedGovernor.historyReasonsTruncated).toBe(FLEET_STATUS_TIER_CAPS.trimmed.launchHistory);
    expect(trimmedTransaction.requestedMemberIds).toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.members);
    expect(trimmedTransaction.requestedMemberIdsTotal).toBe(memberIds.length);
    expect(trimmedTransaction.requestedMemberIdsTruncated).toBe(true);
    expect(trimmedTransaction.failed).toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.launchHistory);
    expect(trimmedTransaction.failedTotal).toBe(failed.length);
    expect(trimmedTransaction.failedReasonsTruncated).toBe(FLEET_STATUS_TIER_CAPS.trimmed.launchHistory);
    expect((trimmedTransaction.failed as Array<Record<string, unknown>>)[0]?.reason)
      .toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.launchHistoryReason);
    const trimmedVerdict = trimmedGovernor.terminalVerdict as Record<string, unknown>;
    expect(trimmedVerdict.liveMemberIds).toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.members);
    expect(trimmedVerdict.liveMemberIdsTotal).toBe(memberIds.length);
    expect(trimmedVerdict.unverifiedMemberIds).toHaveLength(FLEET_STATUS_TIER_CAPS.trimmed.members);
    expect(trimmedVerdict.unverifiedMemberIdsTotal).toBe(50);

    const standard = shapeFleetStatus(source, 'standard') as {
      launchTransaction: Record<string, unknown> & { governor: Record<string, unknown> };
    };
    const standardTransaction = standard.launchTransaction;
    const standardGovernor = standardTransaction.governor;
    const standardHistory = standardGovernor.history as unknown[];
    expect(standardHistory).toHaveLength(FLEET_STATUS_TIER_CAPS.standard.launchHistory);
    expect(standardTransaction.requestedMemberIds).toHaveLength(FLEET_STATUS_TIER_CAPS.standard.members);
    expect(standardTransaction.failed).toHaveLength(FLEET_STATUS_TIER_CAPS.standard.launchHistory);
    expect((standardTransaction.failed as Array<Record<string, unknown>>)[0]?.reason)
      .toHaveLength(FLEET_STATUS_TIER_CAPS.standard.launchHistoryReason);
    const standardVerdict = standardGovernor.terminalVerdict as Record<string, unknown>;
    expect(standardVerdict.liveMemberIds).toHaveLength(FLEET_STATUS_TIER_CAPS.standard.members);
    expect(standardVerdict.unverifiedMemberIds).toHaveLength(FLEET_STATUS_TIER_CAPS.standard.members);
  });

  it('uses the roster liveness snapshot without a second host discovery pass', async () => {
    const leader = {
      agentId: 'su-leader',
      ownerLabel: 'Leader',
      fleetRole: 'leader',
      agentRole: 'su',
      tty: '/dev/pts/10',
      intent: 'lead',
      alive: true,
      heartbeatFresh: true,
      sessionState: 'live',
      lastActiveSecAgo: 1,
      doing: 'WI-1',
      load: 1,
    };
    const visibleMember = {
      agentId: 'su-visible-member',
      ownerLabel: 'Visible member',
      fleetRole: 'member',
      agentRole: 'su',
      tty: '/dev/pts/11',
      intent: 'work',
      alive: true,
      heartbeatFresh: true,
      sessionState: 'live',
      lastActiveSecAgo: 1,
      doing: 'WI-2',
      load: 1,
    };
    h.listFleetRosterDiagnosed.mockResolvedValueOnce({
      entries: [leader, visibleMember],
      degradedLegs: [],
      leaderEntry: leader,
      leaderLiveness: { recordedLive: false, complete: true },
    });

    const out = parse(await invoke({ fleet: 'rocket' }));

    expect(out.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'su-visible-member', sessionState: 'live' }),
    ]));
    expect(h.findLiveHostAsync).not.toHaveBeenCalled();
  });
});
