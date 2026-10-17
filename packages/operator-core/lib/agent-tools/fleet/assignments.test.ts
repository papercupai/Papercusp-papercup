/**
 * assignments.test.ts — `reconcileWakeability` (EI-6077): fleet:assignments'
 * `alive` is heartbeat-freshness only, which can diverge from whether
 * coord:dispatch/coord:send can actually REACH the agent (a live
 * `coord:inbox-wake:<id>` standing await). This pins the reconciliation with an
 * INJECTED wakeability fetcher — no PG needed (mirrors dispatch.test.ts's
 * composeDispatch pattern: extract the pure/DI-testable core, mock the IO seam).
 */
import { describe, expect, it } from 'vitest';
import {
  reconcileWakeability,
  deriveMemberVerdict,
  decorateMemberVerdicts,
  decorateParkedOn,
  decorateProductiveToolCalls,
  decorateLoopMonitorStates,
  deriveLoopMonitorState,
  decorateContextPressure,
  decorateUnansweredDirected,
  decorateDirectiveActuation,
  decorateCoordDeafness,
  filterActiveCoverage,
  agentPlansFromLiveCoverage,
  projectSchedulerClaimState,
  COVERAGE_ORDER,
  COVERAGE_ACTIVE_WINDOW_MS,
  VERDICT_SPEAKING_FRESH_MS,
  VERDICT_STALL_MS,
  findAbandonedIntentWorkItems,
  hasIntentWorkItemReference,
  type IntentWorkItemSnapshot,
  type MemberVerdict,
} from './assignments';
import fleetAssignmentsTool from './assignments';
import { shapeFleetAssignments } from './assignments-shape';
import type { AgentAssignment } from '../../fleet/assignments';
import {
  COVERAGE_LEVELS,
  duplicateCoverage,
  type PlanItemCoverage,
  type CoverageLevel,
} from '../../plan-item-coverage';
import type { WakeMode } from '../coordination/wake-mode';
import { ACTIVITY_DEAD_MS } from '../coordination/presence-wakeability';
import type { SessionState, WakeabilitySignals } from '../coordination/presence-wakeability';
import type { ContextPressureBucket } from '../coordination/context-pressure';
import type { UnansweredDirectedSummary } from '../coordination/unanswered-directed';
import type { DirectiveActuationSummary } from '../coordination/directive-effect';
import type { LoopStatus } from '../../harness/routines/loop';

function baseAgent(overrides: Partial<AgentAssignment> = {}): AgentAssignment & {
  sessionState?: SessionState | null;
  confirmLiveness?: boolean | null;
  wakeable?: boolean | null;
} {
  return {
    agentId: 'su-agent-1',
    label: null,
    name: null,
    present: true,
    alive: true,
    // Fresh by default — the fixture models a "heartbeat-alive" agent (it sets
    // alive:true), and since fleet-liveness-zombie-await-2026-07-07 an hour-cold
    // heartbeat is authoritatively `ended`, so a static past date would read dead.
    heartbeatAt: new Date().toISOString(),
    intent: '',
    declaredPlanSlug: null,
    fleetSlug: null,
    fleetRole: null,
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
    ...overrides,
  };
}

const fakeFetch =
  (signals: Record<string, WakeabilitySignals>) =>
  async (ids: string[]): Promise<Map<string, WakeabilitySignals>> =>
    new Map(ids.filter((id) => id in signals).map((id) => [id, signals[id]]));

const noSelfWake = async () => new Map();
const noRecordedEnded = async () => new Set<string>();

it('fleet:assignments opts out of the dispatcher ambient workspace transaction', () => {
  expect((fleetAssignmentsTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
});

it('fleet:assignments keeps oversized include_stale JSON intact for structured callers', () => {
  expect((fleetAssignmentsTool as { skipResultDoor?: string }).skipResultDoor).toBe(
    'oversize-by-design',
  );
});

describe('fleet:assignments judge scope', () => {
  const handler = fleetAssignmentsTool.handler as unknown as (
    args: Record<string, unknown>,
    ctx: Record<string, unknown>,
  ) => Promise<{ data?: Record<string, unknown> }>;

  it.each([
    ['omitted agent filter', {}],
    ['a named agent filter', { agent: 'su-other' }],
  ])('refuses judge access with %s', async (_label, args) => {
    const result = await handler(args, { role: 'judge' });
    expect(result.data).toMatchObject({
      ok: false,
      error: 'judge_assignment_scope_only',
    });
  });
});

describe('abandoned intent work-item detection (EI-21560781905286213)', () => {
  const item = (
    overrides: Partial<IntentWorkItemSnapshot> = {},
  ): IntentWorkItemSnapshot => ({
    id: 'WI-42199',
    harness: 'papercusp',
    state: 'open',
    title: 'Partition crew',
    assignee: null,
    ...overrides,
  });

  it('keeps intent-bearing stale rows eligible for the liveness fold', () => {
    expect(hasIntentWorkItemReference('Resume WI-42199: implement partition_crew')).toBe(true);
    expect(hasIntentWorkItemReference('idle between fleet pulls')).toBe(false);
  });

  it('surfaces a dead member whose intent names a nonterminal unassigned item', () => {
    const agent = { ...baseAgent({ intent: 'Resume WI-42199 now' }), verdict: 'dead' as const };
    expect(findAbandonedIntentWorkItems([agent], new Map([['WI-42199', item()]]))).toEqual([
      expect.objectContaining({
        agentId: 'su-agent-1',
        workItemId: 'WI-42199',
        state: 'open',
        harness: 'papercusp',
      }),
    ]);
  });

  it.each([
    ['live member', { verdict: 'speaking' as const }, item()],
    ['terminal item', { verdict: 'dead' as const }, item({ state: 'done' })],
    ['assigned item', { verdict: 'dead' as const }, item({ assignee: 'su-other' })],
  ])('does not surface a %s', (_label, agentOverrides, workItem) => {
    const agent = {
      ...baseAgent({ intent: 'Resume WI-42199 now' }),
      ...agentOverrides,
    };
    expect(findAbandonedIntentWorkItems([agent], new Map([['WI-42199', workItem]]))).toEqual([]);
  });

  it('keeps abandoned_intents visible at every payload tier', () => {
    const data = {
      ok: true,
      summary: { agents: 1, abandoned_intents: 1 },
      orphaned: [],
      stalled: [],
      abandoned_intents: [
        {
          agentId: 'su-dead',
          intent: 'Resume WI-42199',
          workItemId: 'WI-42199',
          title: 'Partition crew',
          state: 'open',
          harness: 'papercusp',
        },
      ],
      agents: [],
    };
    for (const tier of ['trimmed', 'standard'] as const) {
      const shaped = shapeFleetAssignments(data, tier) as Record<string, unknown>;
      expect((shaped.summary as { abandoned_intents: number }).abandoned_intents).toBe(1);
      expect(shaped.abandoned_intents).toEqual([
        expect.objectContaining({ agentId: 'su-dead', workItemId: 'WI-42199' }),
      ]);
    }
  });
});

describe('scheduler claim state projection (EI-25482945548879685)', () => {
  it('surfaces parked held claims without inflating actionable work load', () => {
    const agent = baseAgent({ agentId: 'su-parked', claims: [], queued: [], load: 0 });
    const [projected] = projectSchedulerClaimState(
      [agent],
      new Map([
        [
          'su-parked',
          {
            blocked: true,
            activeClaims: 2,
            maxConcurrentClaims: 2,
            heldIds: ['EI-blocked-1', 'EI-blocked-2'],
            blockerParkedIds: ['EI-parked-on-blocker'],
          },
        ],
      ]),
    );

    expect(projected.claims).toEqual([]);
    expect(projected.load).toBe(0);
    // P-010: a hold parked on a typed external blocker is held but not counted — named here.
    expect(projected.schedulerClaimState).toEqual({
      activeClaims: 2,
      heldIds: ['EI-blocked-1', 'EI-blocked-2'],
      blockerParkedIds: ['EI-parked-on-blocker'],
    });
  });

  it('keeps the scheduler state unknown when its read is unavailable', () => {
    const [projected] = projectSchedulerClaimState([baseAgent()], null);
    expect(projected.schedulerClaimState).toBeNull();
  });
});

describe('reconcileWakeability (EI-6077)', () => {
  it('the exact EI-6077 evidence: heartbeat-alive but no live inbox-wake await → sessionState ended, alive downgraded', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: false, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(), noSelfWake, noRecordedEnded);
    expect(out.sessionState).toBe('ended');
    expect(out.alive).toBe(false);
  });

  it('EI-8106: actively tool-calling recorded successor is live before inbox wake is armed', async () => {
    // A live turn is stronger than the recorded-session fallback: the
    // successor is already doing work even though its inbox wake is not armed.
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: false, liveTurn: true } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(['su-agent-1']), noSelfWake, noRecordedEnded);
    expect(out.sessionState).toBe('live');
    expect(out.alive).toBe(true);
  });

  it('WI-40871: positive recorded-ended evidence ends a warm, wakeable, claimless owner immediately', async () => {
    const agent = baseAgent({ alive: false });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: false } });
    const [out] = await reconcileWakeability(
      [agent],
      fetchFn,
      async () => new Set(),
      async () => new Map(),
      async () => new Set(['su-agent-1']),
    );
    expect(out.sessionState).toBe('ended');
    expect(out.wakeable).toBe(true);
    expect(out.alive).toBe(false);
  });

  it('positive newest-session death evidence wins a contradictory recorded-live set', async () => {
    // Both store readers select the newest session. Overlapping results can
    // occur across reads, but an explicit death must not resurrect that owner.
    const agent = baseAgent({ alive: false });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: false, liveTurn: false } });
    const [out] = await reconcileWakeability(
      [agent],
      fetchFn,
      async () => new Set(['su-agent-1']),
      async () => new Map(),
      async () => new Set(['su-agent-1']),
    );
    expect(out.sessionState).toBe('ended');
    expect(out.alive).toBe(false);
  });

  it('heartbeat-alive AND wakeable with a running turn → sessionState live, alive stays true', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: true } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(), noSelfWake, noRecordedEnded);
    expect(out.sessionState).toBe('live');
    expect(out.alive).toBe(true);
  });

  it('heartbeat-alive, wakeable, but idle (no running turn) → sessionState parked, alive stays true', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(), noSelfWake, noRecordedEnded);
    expect(out.sessionState).toBe('parked');
    expect(out.alive).toBe(true);
  });

  it('EI-22674977242712134: hydrated psu-host authority preserves an activity-dead parked member', async () => {
    const owner = 'su-pty-activity-dead';
    const agent = baseAgent({
      agentId: owner,
      alive: false,
      heartbeatAt: new Date().toISOString(),
    });
    const fetchFn = fakeFetch({
      [owner]: {
        wakeable: true,
        liveTurn: false,
        lastActivityMs: Date.now() - ACTIVITY_DEAD_MS - 1,
      },
    });
    const [out] = await reconcileWakeability(
      [agent],
      fetchFn,
      async () => new Set(),
      async () => new Map(),
      async () => new Set(),
      {
        hydratePresence: true,
        psuHostPositiveAuthority: true,
        fetchPresenceFn: async (ids) => {
          expect(ids).toEqual([owner]);
          return new Map([
            [
              owner,
              {
                heartbeatAt: new Date().toISOString(),
                stale: false,
                host: 'fixture-host',
                pid: null,
                source: 'psu',
                agentRole: 'su',
              },
            ],
          ]);
        },
        findHostFn: (id) => (id === owner ? { ownerId: id } : null),
      },
    );

    expect(out.sessionState).toBe('parked');
    expect(out.alive).toBe(true);
    expect(
      deriveMemberVerdict({ ...out, lastToolCallAtMs: Date.now() - VERDICT_SPEAKING_FRESH_MS - 1 }),
    ).not.toBe('dead');
  });

  // P-011(a) / D-011: fleet:assignments trusts a live psu host as proof of life, so
  // it runs the same host-condition leg as resolveSessionStates and coord:presence.
  const reconcileWithHost = async (owner: string, host: Record<string, unknown>) => {
    const tailReads: string[] = [];
    const readHostTailFn = async (id: string) => {
      tailReads.push(id);
      return [];
    };
    const [row] = await reconcileWakeability(
      [baseAgent({ agentId: owner, alive: true })],
      fakeFetch({ [owner]: { wakeable: true, liveTurn: false } }),
      async () => new Set(),
      async () => new Map(),
      async () => new Set(),
      {
        hydratePresence: true,
        psuHostPositiveAuthority: true,
        fetchPresenceFn: async () =>
          new Map([[owner, { heartbeatAt: new Date().toISOString(), stale: false, host: 'h', pid: null, source: 'psu', agentRole: 'su' }]]),
        findHostFn: (id) => (id === owner ? { ownerId: id, ...host } : null),
        readHostTailFn,
      },
    );
    const out = row as typeof row & { wedged?: string | null };
    return { out, tailReads };
  };

  it('P-011: a healthy live psu host keeps a wakeable member parked (positive control)', async () => {
    const { out, tailReads } = await reconcileWithHost('su-host-healthy', { authBlocked: false });
    expect(out.sessionState).toBe('parked');
    expect(out.wedged ?? null).toBeNull();
    expect(tailReads).toEqual(['su-host-healthy']);
  });

  it('P-011: a live psu host with dead provider auth reads suspect + wedged auth-blocked, not parked', async () => {
    const { out } = await reconcileWithHost('su-host-dead-auth', { authBlocked: true });
    expect(out.sessionState).toBe('suspect');
    expect(out.wedged).toBe('auth-blocked');
    expect(out.alive).toBe(false);
  });

  it('WI-4400: stale wakeable holder gets confirmLiveness before takeover', async () => {
    const agent = baseAgent({ alive: false });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(), noSelfWake, noRecordedEnded);
    expect(out.sessionState).toBe('draining');
    expect(out.confirmLiveness).toBe(true);
    expect(out.alive).toBe(false);
  });

  it('EI-21125380796386851: suspect + wakeable stays recoverable and carries wakeability', async () => {
    const agent = baseAgent({
      alive: false,
      load: 1,
      heartbeatAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(), noSelfWake, noRecordedEnded);
    expect(out.sessionState).toBe('suspect');
    expect(out.wakeable).toBe(true);
    expect(out.alive).toBe(false);
  });

  it('fleet-liveness-zombie-await-2026-07-07: wakeable but hour-cold heartbeat → ended, not parked', async () => {
    // The reboot-zombie shape on the fleet:assignments surface: a lingering
    // (never-cancelled) wake-await makes it wakeable, but the heartbeat has been
    // cold for an hour → the DEAD-ceiling backstop forces `ended`, not `parked`.
    const agent = baseAgent({ alive: false, heartbeatAt: new Date(Date.now() - 72 * 60_000).toISOString() });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: false } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(), noSelfWake, noRecordedEnded);
    expect(out.sessionState).toBe('ended');
    expect(out.alive).toBe(false);
  });

  it('no wakeability signal for the agent (e.g. a federated peer) — leaves alive/sessionState untouched', async () => {
    const agent = baseAgent({ alive: true });
    const fetchFn = fakeFetch({});
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(['su-agent-1']), noSelfWake, noRecordedEnded);
    expect(out.sessionState).toBeUndefined();
    expect(out.alive).toBe(true);
  });

  it('never REVIVES an already-dead (heartbeat-stale) agent', async () => {
    const agent = baseAgent({ alive: false });
    const fetchFn = fakeFetch({ 'su-agent-1': { wakeable: true, liveTurn: true } });
    const [out] = await reconcileWakeability([agent], fetchFn, async () => new Set(), noSelfWake, noRecordedEnded);
    // stale:true (since !alive) with wakeable+liveTurn still resolves 'parked' per
    // deriveSessionState (liveTurn && !stale is required for 'live') — the point
    // pinned here is it does NOT flip a heartbeat-dead agent back to alive:true.
    expect(out.alive).toBe(false);
  });

  it('empty input is a no-op (never calls the fetcher)', async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return new Map<string, WakeabilitySignals>();
    };
    const out = await reconcileWakeability([], fetchFn);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

// ─────────────────── EI-8995: the single derived member verdict ───────────────────

const NOW = 1_800_000_000_000;

function verdictInput(overrides: Partial<Parameters<typeof deriveMemberVerdict>[0]> = {}) {
  return {
    present: true,
    alive: true,
    sessionState: 'live' as SessionState,
    stalled: false,
    load: 0,
    lastToolCallAtMs: null as number | null,
    ...overrides,
  };
}

describe('deriveMemberVerdict (EI-8995)', () => {
  it('sessionState ended → dead, regardless of a warm heartbeat', () => {
    expect(deriveMemberVerdict(verdictInput({ sessionState: 'ended', alive: true }), NOW)).toBe('dead');
  });

  it('a currently executing long call is direct speaking evidence without a settled row', () => {
    expect(
      deriveMemberVerdict(
        verdictInput({
          sessionState: 'suspect',
          wakeable: false,
          load: 1,
          lastToolCallAtMs: null,
          longCallInFlight: { tool: 'testing:run', ageSec: 1_200 },
        }),
        NOW,
      ),
    ).toBe('speaking');
    // A confirmed terminal session still outranks the process-local snapshot.
    expect(
      deriveMemberVerdict(
        verdictInput({ sessionState: 'ended', longCallInFlight: { tool: 'testing:run', ageSec: 1_200 } }),
        NOW,
      ),
    ).toBe('dead');
  });

  it('EI-21125380796386851: suspect + wakeable → recoverable suspect', () => {
    expect(deriveMemberVerdict(verdictInput({ sessionState: 'suspect', wakeable: true }), NOW)).toBe('suspect');
  });

  it('EI-21125380796386851: suspect without wakeability → terminal dead', () => {
    expect(deriveMemberVerdict(verdictInput({ sessionState: 'suspect', wakeable: false }), NOW)).toBe('dead');
    expect(deriveMemberVerdict(verdictInput({ sessionState: 'suspect' }), NOW)).toBe('dead');
  });

  it('EI-21557715307606072: suspect + momentarily-unwakeable but freshly tool-calling → speaking', () => {
    const last = NOW - 60_000;
    expect(
      deriveMemberVerdict(
        verdictInput({
          alive: false,
          sessionState: 'suspect',
          wakeable: false,
          load: 1,
          lastToolCallAtMs: last,
        }),
        NOW,
      ),
    ).toBe('speaking');
  });

  it('heartbeat-dead → dead', () => {
    expect(deriveMemberVerdict(verdictInput({ alive: false, sessionState: null }), NOW)).toBe('dead');
  });

  it('EI-18690950786179315: a FRESH tool call overrides a bare (unconfirmed) heartbeat-dead read — a missing/stale coord_presence row (e.g. around a compaction respawn) must not blank out a genuinely-working agent', () => {
    const last = NOW - 60_000; // well within VERDICT_SPEAKING_FRESH_MS
    expect(deriveMemberVerdict(verdictInput({ alive: false, sessionState: null, lastToolCallAtMs: last }), NOW)).toBe(
      'speaking',
    );
  });

  it('EI-18690950786179315: a CONFIRMED terminal sessionState still wins dead even with a fresh tool call (the oracle actually looked and found it over)', () => {
    const last = NOW - 60_000;
    expect(
      deriveMemberVerdict(verdictInput({ alive: true, sessionState: 'ended', lastToolCallAtMs: last }), NOW),
    ).toBe('dead');
  });

  it('fresh tool call → speaking (really working right now)', () => {
    const last = NOW - VERDICT_SPEAKING_FRESH_MS + 1_000;
    expect(deriveMemberVerdict(verdictInput({ lastToolCallAtMs: last }), NOW)).toBe('speaking');
  });

  it('healthy loop lifecycle outranks stale work timestamps', () => {
    expect(
      deriveMemberVerdict(
        verdictInput({
          monitorState: 'waiting',
          stalled: true,
          load: 2,
          lastToolCallAtMs: NOW - VERDICT_STALL_MS - 60_000,
        }),
        NOW,
      ),
    ).toBe('waiting');
  });

  it('EI-20980974612370508: a healthy cold loop outranks a stale/absent heartbeat', () => {
    expect(
      deriveMemberVerdict(
        verdictInput({
          alive: false,
          sessionState: null,
          monitorState: 'parked-awaiting-capability',
          load: 1,
        }),
        NOW,
      ),
    ).toBe('parked-awaiting-capability');
  });

  it('EI-20980974612370508: an event-await park outranks a stale/absent heartbeat', () => {
    expect(
      deriveMemberVerdict(
        verdictInput({
          alive: false,
          sessionState: null,
          parkedOn: ['work-item:claimable'],
        }),
        NOW,
      ),
    ).toBe('parked-awaiting-capability');
  });

  it('speaking OUTRANKS a stalled claim: a live member with one stuck ITEM is a re-steer, not a relaunch', () => {
    const last = NOW - 60_000;
    expect(deriveMemberVerdict(verdictInput({ stalled: true, load: 2, lastToolCallAtMs: last }), NOW)).toBe(
      'speaking',
    );
  });

  it('holding work + quiet past the stall window → stalled (the member-level wedge)', () => {
    const last = NOW - VERDICT_STALL_MS - 60_000;
    expect(deriveMemberVerdict(verdictInput({ load: 1, lastToolCallAtMs: last }), NOW)).toBe('stalled');
  });

  it('per-claim stall rollup (not speaking) → stalled even when idle-loaded recently', () => {
    const last = NOW - VERDICT_SPEAKING_FRESH_MS - 60_000;
    expect(deriveMemberVerdict(verdictInput({ stalled: true, lastToolCallAtMs: last }), NOW)).toBe('stalled');
  });

  it('worked before, quiet now, holding nothing → first-turn-done (between wakes / drained)', () => {
    const last = NOW - VERDICT_STALL_MS - 60_000;
    expect(deriveMemberVerdict(verdictInput({ load: 0, lastToolCallAtMs: last }), NOW)).toBe('first-turn-done');
  });

  it('present but ZERO tool calls ever → joined (a join event is NOT liveness)', () => {
    expect(deriveMemberVerdict(verdictInput({ lastToolCallAtMs: null }), NOW)).toBe('joined');
  });

  it('claims at boot with no tool call yet is joined, NOT stalled (never wedge-flag a boot window)', () => {
    expect(deriveMemberVerdict(verdictInput({ load: 3, lastToolCallAtMs: null }), NOW)).toBe('joined');
  });

  it('recorded-live but not coord-registered → booted (the pre-join bootstrap gap)', () => {
    expect(
      deriveMemberVerdict(verdictInput({ sessionState: 'recorded' as SessionState, lastToolCallAtMs: null }), NOW),
    ).toBe('booted');
    expect(deriveMemberVerdict(verdictInput({ present: false, sessionState: null }), NOW)).toBe('booted');
  });

  // EI-15655: a healthy between-items member (0 held claims, deliberately parked
  // on an events:await key) must never misread as stalled/first-turn-done, even
  // when it has no active monitorState (loop ended/never armed).
  describe('parkedOn priority (EI-15655 — healthy between-items member)', () => {
    it('0 claims + parkedOn + quiet-past-stall-window → parked-awaiting-capability, not stalled', () => {
      const last = NOW - VERDICT_STALL_MS - 60_000;
      expect(
        deriveMemberVerdict(
          verdictInput({ load: 0, lastToolCallAtMs: last, parkedOn: ['work-item:claimable'] }),
          NOW,
        ),
      ).toBe('parked-awaiting-capability');
    });

    it('0 claims + parkedOn + never spoken → parked-awaiting-capability, not joined', () => {
      expect(
        deriveMemberVerdict(verdictInput({ load: 0, lastToolCallAtMs: null, parkedOn: ['fleet:bar:gate'] }), NOW),
      ).toBe('parked-awaiting-capability');
    });

    it('a genuinely stalled HELD claim is never masked by an unrelated park (load > 0)', () => {
      const last = NOW - VERDICT_STALL_MS - 60_000;
      expect(
        deriveMemberVerdict(
          verdictInput({ load: 1, lastToolCallAtMs: last, parkedOn: ['some:other:event'] }),
          NOW,
        ),
      ).toBe('stalled');
    });

    it('an active healthy loop (monitorState) still outranks parkedOn — no double-decision', () => {
      expect(
        deriveMemberVerdict(
          verdictInput({ load: 0, monitorState: 'waiting', parkedOn: ['work-item:claimable'] }),
          NOW,
        ),
      ).toBe('waiting');
    });

    it('empty/absent parkedOn is a no-op — falls through to the pre-existing logic unchanged', () => {
      const last = NOW - VERDICT_STALL_MS - 60_000;
      expect(deriveMemberVerdict(verdictInput({ load: 0, lastToolCallAtMs: last, parkedOn: [] }), NOW)).toBe(
        'first-turn-done',
      );
      expect(
        deriveMemberVerdict(verdictInput({ load: 0, lastToolCallAtMs: last, parkedOn: undefined }), NOW),
      ).toBe('first-turn-done');
    });
  });

  // WI-42457: a member whose ENTIRE tool history is HOUSEKEEPING_TOOL_NAMES has
  // never taken an agent-authored turn, but `lastToolCallAtByOwner` counts those
  // hook-emitted rows, so `last != null` reported `first-turn-done` — whose own
  // contract is "has completed real work (>= 1 recorded tool call)".
  //
  // Measured on the P-003 acceptance canary
  // (su-respawn-829ef88b24abde91c8a6d37bdc2678a2): its whole tool_invocations
  // history was ONE `activity:report` row with call_origin='hook'. The session
  // reached zero assistant turns and zero agent-authored tools — it died in the
  // Codex admission path — yet fleet:assignments reported first-turn-done, so a
  // launch that never started read as a launch that succeeded. A failed canary
  // that reports success is worse than one that reports nothing.
  describe('housekeeping-only history is NOT a first turn (WI-42457)', () => {
    it('housekeeping-only + quiet + holding nothing → joined, NOT first-turn-done', () => {
      const last = NOW - VERDICT_STALL_MS - 60_000;
      expect(
        deriveMemberVerdict(
          verdictInput({ load: 0, lastToolCallAtMs: last, lastProductiveToolCallAtMs: null }),
          NOW,
        ),
      ).toBe('joined');
    });

    it('a real productive call still reports first-turn-done (the fix does not swallow real work)', () => {
      const last = NOW - VERDICT_STALL_MS - 60_000;
      expect(
        deriveMemberVerdict(
          verdictInput({ load: 0, lastToolCallAtMs: last, lastProductiveToolCallAtMs: last }),
          NOW,
        ),
      ).toBe('first-turn-done');
    });

    it('OMITTING the field preserves the pre-existing verdict exactly (no stranded caller)', () => {
      const last = NOW - VERDICT_STALL_MS - 60_000;
      expect(deriveMemberVerdict(verdictInput({ load: 0, lastToolCallAtMs: last }), NOW)).toBe(
        'first-turn-done',
      );
    });

    it('does NOT touch the stall branch: housekeeping-only while HOLDING quiet claims stays stalled', () => {
      const last = NOW - VERDICT_STALL_MS - 60_000;
      expect(
        deriveMemberVerdict(
          verdictInput({ load: 1, lastToolCallAtMs: last, lastProductiveToolCallAtMs: null }),
          NOW,
        ),
      ).toBe('stalled');
    });

    it('does NOT touch the speaking branch: a FRESH housekeeping call still proves the process is alive', () => {
      const last = NOW - 60_000;
      expect(
        deriveMemberVerdict(
          verdictInput({ load: 0, lastToolCallAtMs: last, lastProductiveToolCallAtMs: null }),
          NOW,
        ),
      ).toBe('speaking');
    });
  });
});

describe('loop-owned monitor state — P-010 agent-operability (EI-11402)', () => {
  const loop = (overrides: Partial<LoopStatus> = {}): LoopStatus => ({
    name: 'loop-su-agent-1',
    ownerId: 'su-agent-1',
    harnessSlug: 'papercusp',
    active: true,
    intervalSec: 300,
    carry: 'warm',
    continuation: 'settle',
    mode: 'work',
    monitor: null,
    monitorStanddown: null,
    standdown: null,
    goal: null,
    fireCount: 2,
    firesSinceArm: 2,
    expectedFiresSinceArm: null,
    effectiveIntervalSec: null,
    cadenceRatio: null,
    longestObservedGapSec: null,
    cadenceDrift: false,
    parked: false,
    nextFireAt: new Date(NOW + 300_000).toISOString(),
    lastFiredAt: new Date(NOW - 300_000).toISOString(),
    armedAt: new Date(NOW - 300_000).toISOString(),
    costCapCents: null,
    maxFires: null,
    maxDurationSec: null,
    fireStarved: false,
    stalled: false,
    stalledSinceMs: null,
    lastDeliveryOutcome: 'loop-lifecycle',
    consecutiveErrors: 0,
    lastWakeChannel: null,
    lastWakeStatus: null,
    lastWakeAt: null,
    lastWakeError: null,
    lastTurnAt: new Date(NOW - 300_000).toISOString(),
    // WI-6951: the strict "a real turn completed" signal. This fixture models a
    // HEALTHY loop, so it matches lastTurnAt — the two diverge only when the
    // lifecycle session-end marker is the newest evidence, which is the case the
    // strict field exists to keep out of an "was a turn produced after T" test.
    lastRealTurnAt: new Date(NOW - 300_000).toISOString(),
    turnsStalled: false,
    parkedForSec: null,
    lifecycleBackoff: null,
    ...overrides,
  });

  it('derives waiting between fires, monitoring in-flight, and capability-parked on an event', () => {
    expect(deriveLoopMonitorState(loop(), [])).toBe('waiting');
    expect(deriveLoopMonitorState(loop({ parked: true, nextFireAt: null }), [])).toBe('monitoring');
    expect(deriveLoopMonitorState(loop({ parked: true, nextFireAt: null }), ['deploy:sha'])).toBe(
      'parked-awaiting-capability',
    );
  });

  it('does not mask the loop engine\'s own dead-man stall or an inactive loop', () => {
    expect(deriveLoopMonitorState(loop({ stalled: true }), [])).toBeNull();
    expect(deriveLoopMonitorState(loop({ active: false }), [])).toBeNull();
  });

  it('decorates nextFireAt and suppresses false stalled/unclaimed state', async () => {
    const stalledClaim = {
      type: 'work-item' as const,
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      id: 'WI-1',
      itemKind: 'task',
      detail: 'monitor',
      status: 'wip',
      acquiredTs: null,
      expiresTs: null,
      active: true,
      orphaned: false,
      stalled: true,
      lastProgressAt: null,
      activity: 'stalled' as const,
      rank: 0,
      rankWriter: 'cup',
    };
    const agent = baseAgent({
      declaredPlanSlug: 'plan-a',
      declaredUnclaimed: true,
      stalled: true,
      claims: [stalledClaim],
      queued: [
        {
          id: 'WI-1', itemKind: 'task', title: 'monitor', status: 'wip', rank: 0,
          rankWriter: 'cup', activity: 'stalled',
        },
      ],
      doing: {
        id: 'WI-1', itemKind: 'task', title: 'monitor', status: 'wip', rank: 0,
        rankWriter: 'cup', activity: 'stalled',
      },
      load: 1,
    });
    const [out] = await decorateLoopMonitorStates(
      [agent],
      async () => new Map([['su-agent-1', loop()]]),
    );
    expect(out.monitorState).toBe('waiting');
    expect(out.nextFireAt).toBe(loop().nextFireAt);
    expect(out.declaredUnclaimed).toBe(false);
    expect(out.stalled).toBe(false);
    expect(out.claims[0].activity).toBe('alive');
    expect(out.queued[0].activity).toBe('alive');
    expect(out.doing?.activity).toBe('alive');
  });

  it("WI-5345: decorates loopMode from the loop's armed mode, independent of monitorState", async () => {
    const agent = baseAgent({ declaredPlanSlug: 'plan-a' });
    const [workOut] = await decorateLoopMonitorStates(
      [agent],
      async () => new Map([['su-agent-1', loop({ mode: 'work' })]]),
    );
    expect(workOut.loopMode).toBe('work');

    const [monitorOut] = await decorateLoopMonitorStates(
      [baseAgent({ declaredPlanSlug: 'plan-a' })],
      async () => new Map([['su-agent-1', loop({ mode: 'monitor' })]]),
    );
    expect(monitorOut.loopMode).toBe('monitor');
  });

  it('WI-5345: loopMode is null when there is no active loop', async () => {
    const [out] = await decorateLoopMonitorStates(
      [baseAgent({ declaredPlanSlug: 'plan-a' })],
      async () => new Map(),
    );
    expect(out.loopMode).toBeNull();
  });

  // EI-19381528967421062: a loop backed off from a provider wall reads active:true with
  // nextFireAt far in the future and nothing else here distinguished that from a healthy
  // between-wakes wait. Thread the SAME derivation loop:status already computes.
  it('EI-19381528967421062: threads lifecycleBackoff through when the loop backed off from a provider wall', async () => {
    const backoff = { reason: 'rate_limited', until: new Date(NOW + 6_000_000).toISOString(), resumesInMs: 6_000_000 };
    const [out] = await decorateLoopMonitorStates(
      [baseAgent({ declaredPlanSlug: 'plan-a' })],
      async () => new Map([['su-agent-1', loop({ lifecycleBackoff: backoff })]]),
    );
    expect(out.lifecycleBackoff).toEqual(backoff);
  });

  it('lifecycleBackoff is null for a healthy loop (no backoff stamped)', async () => {
    const [out] = await decorateLoopMonitorStates(
      [baseAgent({ declaredPlanSlug: 'plan-a' })],
      async () => new Map([['su-agent-1', loop()]]),
    );
    expect(out.lifecycleBackoff).toBeNull();
  });

  it('lifecycleBackoff is null when there is no active loop at all', async () => {
    const [out] = await decorateLoopMonitorStates(
      [baseAgent({ declaredPlanSlug: 'plan-a' })],
      async () => new Map(),
    );
    expect(out.lifecycleBackoff).toBeNull();
  });
});

describe('decorateMemberVerdicts (EI-8995)', () => {
  function memberAgent(overrides: Partial<AgentAssignment> = {}): AgentAssignment & {
    sessionState?: SessionState | null;
    verdict?: MemberVerdict;
    wakeMode?: WakeMode;
    lastToolCallAt?: string | null;
  } {
    return {
      agentId: 'su-member-1',
      label: null,
      name: null,
      present: true,
      alive: true,
      heartbeatAt: new Date(NOW).toISOString(),
      intent: '',
      declaredPlanSlug: null,
      fleetSlug: 'f-1',
      fleetRole: 'member',
      claims: [],
      orphaned: false,
      stalled: false,
      declaredUnclaimed: false,
      doing: null,
      queued: [],
      load: 0,
      sessionState: 'live',
      ...overrides,
    };
  }

  it('stamps verdict + lastToolCallAt from the batch fetch, wakeMode from override ?? default', async () => {
    const lastIso = new Date(NOW - 30_000).toISOString();
    const [speaking, manual] = await decorateMemberVerdicts(
      [memberAgent(), memberAgent({ agentId: 'su-member-2' })],
      async () => new Map([['su-member-1', lastIso]]),
      async () => new Map<string, WakeMode>([['su-member-2', 'manual']]),
      async () => 'auto',
      NOW,
      async () => new Map([['su-member-1', lastIso]]),
    );
    expect(speaking.verdict).toBe('speaking');
    expect(speaking.lastToolCallAt).toBe(lastIso);
    expect(speaking.wakeMode).toBe('auto'); // no override → the global default
    expect(manual.verdict).toBe('joined'); // no tool call ever
    expect(manual.lastToolCallAt).toBeNull();
    expect(manual.wakeMode).toBe('manual'); // per-agent override wins
  });

  it('uses an injected in-flight call when settled telemetry has no row yet', async () => {
    const [out] = await decorateMemberVerdicts(
      [memberAgent()],
      async () => new Map(),
      async () => new Map<string, WakeMode>(),
      async () => 'auto',
      NOW,
      async () => new Map(),
      () => new Map([['su-member-1', { tool: 'testing:run', ageSec: 1_200 }]]),
    );
    expect(out.verdict).toBe('speaking');
  });

  it('a manual GLOBAL default stamps manual on members with no override — the silently-staged-wakes read', async () => {
    const [out] = await decorateMemberVerdicts(
      [memberAgent()],
      async () => new Map(),
      async () => new Map<string, WakeMode>(),
      async () => 'manual',
      NOW,
      async () => new Map(),
    );
    expect(out.wakeMode).toBe('manual');
  });

  it('empty input is a no-op (never calls any fetcher)', async () => {
    let called = 0;
    const out = await decorateMemberVerdicts(
      [],
      async () => ((called += 1), new Map()),
      async () => ((called += 1), new Map()),
      async () => ((called += 1), 'auto' as WakeMode),
      NOW,
      async () => ((called += 1), new Map()),
    );
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  // WI-42457: the wiring half of the housekeeping-only fix. deriveMemberVerdict
  // can only refuse a false first turn if this decorator actually hands it the
  // productive-call map; without it the field is undefined and the legacy
  // any-tool verdict stands.
  describe('housekeeping-only members (WI-42457)', () => {
    it('a member whose ONLY tool call is housekeeping reports joined, not first-turn-done', async () => {
      // The measured shape: one hook-emitted `activity:report`, nothing else.
      const housekeepingIso = new Date(NOW - VERDICT_STALL_MS - 60_000).toISOString();
      const [out] = await decorateMemberVerdicts(
        [memberAgent()],
        async () => new Map([['su-member-1', housekeepingIso]]),
        async () => new Map<string, WakeMode>(),
        async () => 'auto',
        NOW,
        async () => new Map(), // no productive call ever
      );
      expect(out.verdict).toBe('joined');
      // lastToolCallAt still reports the raw fact — the fix changes the VERDICT,
      // not the underlying observation.
      expect(out.lastToolCallAt).toBe(housekeepingIso);
    });

    it('the same member WITH a productive call reports first-turn-done', async () => {
      const iso = new Date(NOW - VERDICT_STALL_MS - 60_000).toISOString();
      const [out] = await decorateMemberVerdicts(
        [memberAgent()],
        async () => new Map([['su-member-1', iso]]),
        async () => new Map<string, WakeMode>(),
        async () => 'auto',
        NOW,
        async () => new Map([['su-member-1', iso]]),
      );
      expect(out.verdict).toBe('first-turn-done');
    });

    it('a THROWN productive fetch is unknown, not "nobody worked" — the legacy verdict stands', async () => {
      const iso = new Date(NOW - VERDICT_STALL_MS - 60_000).toISOString();
      const [out] = await decorateMemberVerdicts(
        [memberAgent()],
        async () => new Map([['su-member-1', iso]]),
        async () => new Map<string, WakeMode>(),
        async () => 'auto',
        NOW,
        async () => {
          throw new Error('pg down');
        },
      );
      // Never flip a whole healthy fleet to `joined` because one read failed.
      expect(out.verdict).toBe('first-turn-done');
    });
  });
});

describe('decorateProductiveToolCalls (EI-19307414464301772)', () => {
  it('stamps productiveToolCallAt from the batch fetch', async () => {
    const iso = new Date(NOW - 60_000).toISOString();
    // `productiveToolCallAt` is OPTIONAL in the generic constraint, so inferring T
    // from baseAgent() alone gives a T without it and the reads below are TS2339.
    // Annotate the input so T carries the key the function stamps.
    const input: Array<AgentAssignment & { productiveToolCallAt?: string | null }> = [
      baseAgent({ agentId: 'su-agent-1' }),
      baseAgent({ agentId: 'su-agent-2' }),
    ];
    const [stamped, absent] = await decorateProductiveToolCalls(
      input,
      async () => new Map([['su-agent-1', iso]]),
    );
    expect(stamped.productiveToolCallAt).toBe(iso);
    expect(absent.productiveToolCallAt).toBeNull();
  });

  it('empty input is a no-op (never calls the fetcher)', async () => {
    let called = 0;
    const out = await decorateProductiveToolCalls([], async () => ((called += 1), new Map()));
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });
});

describe('decorateParkedOn — P-001 fleet-member-dx (EI-9014)', () => {
  it('stamps parkedOn from active non-inbox-wake awaits (injected fetcher)', async () => {
    const agents = [baseAgent({ agentId: 'a1' }), baseAgent({ agentId: 'a2' })];
    await decorateParkedOn(agents, async () => [
      { subscriberId: 'a1', eventKey: 'p2p-git:phase3-open' },
    ]);
    expect((agents[0] as { parkedOn?: string[] }).parkedOn).toEqual(['p2p-git:phase3-open']);
    expect((agents[1] as { parkedOn?: string[] }).parkedOn).toBeUndefined();
  });

  it('dedupes repeated keys and caps at 6 per agent', async () => {
    const agents = [baseAgent({ agentId: 'a1' })];
    const rows = [
      { subscriberId: 'a1', eventKey: 'k1' },
      { subscriberId: 'a1', eventKey: 'k1' }, // dupe
      ...Array.from({ length: 10 }, (_, i) => ({ subscriberId: 'a1', eventKey: `k${i + 2}` })),
    ];
    await decorateParkedOn(agents, async () => rows);
    const parked = (agents[0] as { parkedOn?: string[] }).parkedOn ?? [];
    expect(parked[0]).toBe('k1');
    expect(new Set(parked).size).toBe(parked.length); // no dupes
    expect(parked.length).toBeLessThanOrEqual(6);
  });

  it('empty agent list is a no-op that never calls the fetcher', async () => {
    let called = false;
    await decorateParkedOn([], async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
  });

  it('no parked rows leaves every row unstamped', async () => {
    const agents = [baseAgent({ agentId: 'a1' })];
    await decorateParkedOn(agents, async () => []);
    expect((agents[0] as { parkedOn?: string[] }).parkedOn).toBeUndefined();
  });
});

describe('decorateContextPressure — P-007 (fleet-deltas-leader-primitives-2026-07-10)', () => {
  it('stamps the fetched bucket per agent (injected fetcher)', async () => {
    const agents = [baseAgent({ agentId: 'a1' }), baseAgent({ agentId: 'a2' })];
    await decorateContextPressure(
      agents,
      async () => new Map<string, ContextPressureBucket>([['a1', 'critical']]),
    );
    expect((agents[0] as { contextPressure?: ContextPressureBucket | null }).contextPressure).toBe('critical');
    expect((agents[0] as { contextPressureAgeSec?: number | null }).contextPressureAgeSec).toBeNull();
  });

  it('stamps the bucket and estimate age from one structured reading', async () => {
    const agents = [baseAgent({ agentId: 'a1' })];
    await decorateContextPressure(
      agents,
      async () => new Map([['a1', { bucket: 'critical' as const, estimatedAt: '2026-09-01T00:00:00Z', ageSec: 840 }]]),
    );
    expect((agents[0] as { contextPressure?: ContextPressureBucket | null }).contextPressure).toBe('critical');
    expect((agents[0] as { contextPressureAgeSec?: number | null }).contextPressureAgeSec).toBe(840);
  });

  it('an untracked agent (no fetcher entry) is stamped null, not left undefined', async () => {
    const agents = [baseAgent({ agentId: 'a1' })];
    await decorateContextPressure(agents, async () => new Map());
    expect((agents[0] as { contextPressure?: ContextPressureBucket | null }).contextPressure).toBeNull();
    expect((agents[0] as { contextPressureAgeSec?: number | null }).contextPressureAgeSec).toBeNull();
  });

  it('empty agent list is a no-op that never calls the fetcher', async () => {
    let called = false;
    await decorateContextPressure([], async () => {
      called = true;
      return new Map();
    });
    expect(called).toBe(false);
  });
});

describe('shapeFleetAssignments carries parkedOn at every tier (P-001 fleet-member-dx)', () => {
  const data = {
    ok: true,
    summary: { agents: 2 },
    orphaned: [],
    stalled: [],
    agents: [
      { agentId: 'a1', parkedOn: ['p2p-git:phase3-open'], claims: [], queued: [] },
      { agentId: 'a2', claims: [], queued: [] },
    ],
  };

  it('trimmed tier keeps parkedOn on parked rows and omits it elsewhere', () => {
    const shaped = shapeFleetAssignments(data, 'trimmed') as {
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.agents[0].parkedOn).toEqual(['p2p-git:phase3-open']);
    expect('parkedOn' in shaped.agents[1]).toBe(false);
  });

  it('standard tier keeps it too', () => {
    const shaped = shapeFleetAssignments(data, 'standard') as {
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.agents[0].parkedOn).toEqual(['p2p-git:phase3-open']);
  });
});

describe('shapeFleetAssignments carries scheduler claim state at every tier (EI-25482945548879685)', () => {
  const data = {
    ok: true,
    summary: {
      scheduler_claim_state_status: 'measured',
      scheduler_active_work_item_claims: 2,
    },
    orphaned: [],
    stalled: [],
    agents: [
      {
        agentId: 'su-parked',
        claims: [],
        load: 0,
        schedulerClaimState: {
          activeClaims: 2,
          heldIds: ['EI-blocked-1', 'EI-blocked-2'],
          blockerParkedIds: ['EI-parked-on-blocker'],
        },
      },
      { agentId: 'su-unknown', claims: [], load: 0, schedulerClaimState: null },
      {
        agentId: 'su-many-parked',
        claims: [],
        load: 0,
        schedulerClaimState: {
          activeClaims: 0,
          heldIds: [],
          blockerParkedIds: Array.from({ length: 10 }, (_, i) => `EI-parked-${i}`),
        },
      },
    ],
  };

  it.each(['trimmed', 'standard'] as const)('%s preserves measured and unknown states', (tier) => {
    const shaped = shapeFleetAssignments(data, tier) as {
      summary: Record<string, unknown>;
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.summary.scheduler_active_work_item_claims).toBe(2);
    expect(shaped.agents[0].schedulerClaimState).toEqual({
      activeClaims: 2,
      heldIds: ['EI-blocked-1', 'EI-blocked-2'],
      heldIdsOmitted: 0,
      blockerParkedIds: ['EI-parked-on-blocker'],
      blockerParkedIdsOmitted: 0,
    });
    expect(shaped.agents[1].schedulerClaimState).toBeNull();
  });

  // P-010 (plan D-010): the shaper is the default fleet:assignments view; it must never drop the
  // blocker-parked holds (they are held but uncounted), only cap them with an explicit omitted count.
  it.each(['trimmed', 'standard'] as const)('%s caps blocker-parked holds without hiding them', (tier) => {
    const shaped = shapeFleetAssignments(data, tier) as { agents: Array<Record<string, unknown>> };
    const state = shaped.agents.find((a) => a.agentId === 'su-many-parked')?.schedulerClaimState as
      | { blockerParkedIds: string[]; blockerParkedIdsOmitted: number }
      | undefined;
    expect(state?.blockerParkedIds).toHaveLength(8);
    expect(state?.blockerParkedIdsOmitted).toBe(2);
  });
});

describe('shapeFleetAssignments carries loop monitor state at every tier (P-010)', () => {
  const data = {
    ok: true,
    summary: { agents: 1 },
    orphaned: [],
    stalled: [],
    agents: [{
      agentId: 'a1', claims: [], queued: [], verdict: 'waiting', monitorState: 'waiting',
      nextFireAt: '2026-07-13T18:30:00.000Z',
    }],
  };

  it.each(['trimmed', 'standard'] as const)('%s keeps state + nextFireAt', (tier) => {
    const shaped = shapeFleetAssignments(data, tier) as { agents: Array<Record<string, unknown>> };
    expect(shaped.agents[0].verdict).toBe('waiting');
    expect(shaped.agents[0].monitorState).toBe('waiting');
    expect(shaped.agents[0].nextFireAt).toBe('2026-07-13T18:30:00.000Z');
  });
});

// EI-19381528967421062: lifecycleBackoff is the ONE signal that a member's nextFireAt is a
// provider-wall WAIT, not a normal cadence tick — dropping it at any tier would leave the
// trimmed/standard reads (the ones a monitor loop actually calls) exactly as blind as before.
describe('shapeFleetAssignments carries lifecycleBackoff at every tier (EI-19381528967421062)', () => {
  const backoff = { reason: 'rate_limited', until: '2026-08-02T23:58:00.000Z', resumesInMs: 5_940_000 };
  const dataWithBackoff = {
    ok: true,
    summary: { agents: 1 },
    orphaned: [],
    stalled: [],
    agents: [{
      agentId: 'a1', claims: [], queued: [], verdict: 'waiting', monitorState: 'waiting',
      nextFireAt: backoff.until, lifecycleBackoff: backoff,
    }],
  };

  it.each(['trimmed', 'standard'] as const)('%s keeps lifecycleBackoff verbatim', (tier) => {
    const shaped = shapeFleetAssignments(dataWithBackoff, tier) as { agents: Array<Record<string, unknown>> };
    expect(shaped.agents[0].lifecycleBackoff).toEqual(backoff);
  });

  it.each(['trimmed', 'standard'] as const)('%s omits lifecycleBackoff when null (healthy loop) — never a bare null stub', (tier) => {
    const healthy = { ...dataWithBackoff, agents: [{ ...dataWithBackoff.agents[0], lifecycleBackoff: null }] };
    const shaped = shapeFleetAssignments(healthy, tier) as { agents: Array<Record<string, unknown>> };
    expect('lifecycleBackoff' in shaped.agents[0]).toBe(false);
  });
});

describe('shapeFleetAssignments carries contextPressure at every tier (P-007)', () => {
  const data = {
    ok: true,
    summary: { agents: 2 },
    orphaned: [],
    stalled: [],
    agents: [
      { agentId: 'a1', contextPressure: 'critical', contextPressureAgeSec: 840, claims: [], queued: [] },
      { agentId: 'a2', claims: [], queued: [] },
    ],
  };

  it('trimmed tier keeps the bucket; an unstamped row reads null', () => {
    const shaped = shapeFleetAssignments(data, 'trimmed') as {
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.agents[0].contextPressure).toBe('critical');
    expect(shaped.agents[0].contextPressureAgeSec).toBe(840);
    expect(shaped.agents[1].contextPressure).toBeNull();
    expect(shaped.agents[1].contextPressureAgeSec).toBeNull();
  });

  it('standard tier keeps it too', () => {
    const shaped = shapeFleetAssignments(data, 'standard') as {
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.agents[0].contextPressure).toBe('critical');
    expect(shaped.agents[0].contextPressureAgeSec).toBe(840);
  });
});

describe('shapeFleetAssignments carries confirmLiveness at every tier (WI-4400)', () => {
  const data = {
    ok: true,
    summary: { agents: 2 },
    orphaned: [],
    stalled: [],
    agents: [
      { agentId: 'a1', sessionState: 'suspect', confirmLiveness: true, claims: [], queued: [] },
      { agentId: 'a2', sessionState: 'live', confirmLiveness: false, claims: [], queued: [] },
    ],
  };

  it.each(['trimmed', 'standard'] as const)('%s keeps the takeover hint', (tier) => {
    const shaped = shapeFleetAssignments(data, tier) as { agents: Array<Record<string, unknown>> };
    expect(shaped.agents[0].confirmLiveness).toBe(true);
    expect(shaped.agents[1].confirmLiveness).toBe(false);
  });
});

describe('shapeFleetAssignments carries wakeable at every tier (EI-21125380796386851)', () => {
  const data = {
    ok: true,
    summary: { agents: 2 },
    orphaned: [],
    stalled: [],
    agents: [
      { agentId: 'a1', sessionState: 'suspect', wakeable: true, verdict: 'suspect', claims: [], queued: [] },
      { agentId: 'a2', sessionState: 'suspect', wakeable: false, verdict: 'dead', claims: [], queued: [] },
    ],
  };

  it.each(['trimmed', 'standard'] as const)('%s keeps the oracle delivery axis and verdict', (tier) => {
    const shaped = shapeFleetAssignments(data, tier) as { agents: Array<Record<string, unknown>> };
    expect(shaped.agents[0]).toMatchObject({ wakeable: true, verdict: 'suspect' });
    expect(shaped.agents[1]).toMatchObject({ wakeable: false, verdict: 'dead' });
  });
});

describe('decorateUnansweredDirected — P-007 (fleet-reliability-verification-2026-07-10)', () => {
  it('stamps the fetched summary per agent (injected fetcher)', async () => {
    const agents = [baseAgent({ agentId: 'a1' }), baseAgent({ agentId: 'a2' })];
    const summary: UnansweredDirectedSummary = {
      count: 2,
      oldestAgeMs: 90_000,
      newest: [{ msgId: 'm1', from: 'a2', ageMs: 1000 }],
      staleCount: 0,
      staleOldestAgeMs: 0,
      senders: [{ from: 'a2', count: 2, oldestAgeMs: 90_000 }],
    };
    await decorateUnansweredDirected(agents, async () => new Map([['a1', summary]]));
    expect((agents[0] as { unanswered?: UnansweredDirectedSummary }).unanswered).toEqual(summary);
    expect((agents[1] as { unanswered?: UnansweredDirectedSummary }).unanswered).toBeUndefined();
  });

  it('an agent with none stays absent, never stamped an empty/zero summary', async () => {
    const agents = [baseAgent({ agentId: 'a1' })];
    await decorateUnansweredDirected(agents, async () => new Map());
    expect((agents[0] as { unanswered?: UnansweredDirectedSummary }).unanswered).toBeUndefined();
  });

  it('empty agent list is a no-op that never calls the fetcher', async () => {
    let called = false;
    await decorateUnansweredDirected([], async () => {
      called = true;
      return new Map();
    });
    expect(called).toBe(false);
  });
});

describe('decorateDirectiveActuation — P-013 (fleet-leadership-continuity-and-actuation)', () => {
  const summary: DirectiveActuationSummary = {
    total: 2,
    satisfied: 1,
    notYet: 1,
    unprovable: 0,
    outstanding: ['✗ NOT ACTED ON — expected `checkpoint` on WI-9: no checkpoint has ever been written for WI-9.'],
  };

  it('stamps the fetched summary per agent (injected fetcher)', async () => {
    const agents = [baseAgent({ agentId: 'a1' }), baseAgent({ agentId: 'a2' })];
    await decorateDirectiveActuation(agents, 'leader-1', async () => new Map([['a1', summary]]));
    expect((agents[0] as { directiveActuation?: DirectiveActuationSummary }).directiveActuation).toEqual(summary);
    expect((agents[1] as { directiveActuation?: DirectiveActuationSummary }).directiveActuation).toBeUndefined();
    // P-030: the actuation ledger must NOT be reachable under the old name —
    // that name now belongs exclusively to OWNER directives.
    expect('directives' in (agents[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('scopes the read to the CALLER as sender — a leader is accountable for its own directives', async () => {
    let seen: { fromId?: string } | undefined;
    await decorateDirectiveActuation([baseAgent({ agentId: 'a1' })], 'leader-1', async (_ids, opts) => {
      seen = opts;
      return new Map();
    });
    expect(seen).toEqual({ fromId: 'leader-1' });
  });

  it('omits fromId entirely when the caller is unresolved, rather than sending an empty sender', async () => {
    let seen: { fromId?: string } | undefined;
    await decorateDirectiveActuation([baseAgent({ agentId: 'a1' })], undefined, async (_ids, opts) => {
      seen = opts;
      return new Map();
    });
    expect(seen).toEqual({});
  });

  it('NEVER stamps a zeroed block — no expectations means no field, not "complied with nothing"', async () => {
    const agents = [baseAgent({ agentId: 'a1' })];
    await decorateDirectiveActuation(
      agents,
      'leader-1',
      async () => new Map([['a1', { total: 0, satisfied: 0, notYet: 0, unprovable: 0, outstanding: [] }]]),
    );
    expect((agents[0] as { directiveActuation?: DirectiveActuationSummary }).directiveActuation).toBeUndefined();
  });

  it('empty agent list is a no-op that never calls the fetcher', async () => {
    let called = false;
    await decorateDirectiveActuation([], 'leader-1', async () => {
      called = true;
      return new Map();
    });
    expect(called).toBe(false);
  });
});

describe('shapeFleetAssignments carries unanswered at every tier (P-007 fleet-reliability-verification)', () => {
  const data = {
    ok: true,
    summary: { agents: 2 },
    orphaned: [],
    stalled: [],
    agents: [
      {
        agentId: 'a1',
        claims: [],
        queued: [],
        unanswered: { count: 2, oldestAgeMs: 90_000, newest: [{ msgId: 'm1', from: 'a2', ageMs: 1000 }] },
      },
      { agentId: 'a2', claims: [], queued: [] },
    ],
  };

  it('trimmed tier keeps count/oldestAgeMs but drops the per-message `newest` detail', () => {
    const shaped = shapeFleetAssignments(data, 'trimmed') as {
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.agents[0].unanswered).toEqual({ count: 2, oldestAgeMs: 90_000 });
    expect('unanswered' in shaped.agents[1]).toBe(false);
  });

  it('standard tier keeps the full per-message `newest` detail', () => {
    const shaped = shapeFleetAssignments(data, 'standard') as {
      agents: Array<Record<string, unknown>>;
    };
    expect(shaped.agents[0].unanswered).toEqual(data.agents[0].unanswered);
  });
});

describe('COVERAGE_ORDER', () => {
  // The rollup sorts by COVERAGE_ORDER.indexOf(level), and indexOf returns -1 for
  // an unlisted band — which sorts it ABOVE 'complete', i.e. a NEW level silently
  // renders as the MOST-covered thing on the board. That is the worst possible
  // default for a level like 'held-not-live' whose whole point is "nobody is live
  // on this, go take it". Adding a CoverageLevel must therefore also extend this
  // list; pinning it against COVERAGE_LEVELS makes the omission fail here rather
  // than as a quietly-mis-sorted leader read.
  it('covers every CoverageLevel — an unlisted band would sort as most-covered', () => {
    expect([...COVERAGE_ORDER].sort()).toEqual([...COVERAGE_LEVELS].sort());
  });

  it('runs most-covered → least', () => {
    expect(COVERAGE_ORDER.indexOf('complete')).toBeLessThan(COVERAGE_ORDER.indexOf('full'));
    expect(COVERAGE_ORDER.indexOf('full')).toBeLessThan(COVERAGE_ORDER.indexOf('partial'));
    // A live-but-non-progressing holder is safer to surface before a dead/unknown
    // holder: neither counts as active coverage, but only the latter is reclaimable.
    expect(COVERAGE_ORDER.indexOf('partial')).toBeLessThan(COVERAGE_ORDER.indexOf('held-stalled'));
    expect(COVERAGE_ORDER.indexOf('held-stalled')).toBeLessThan(COVERAGE_ORDER.indexOf('held-not-live'));
    expect(COVERAGE_ORDER.indexOf('held-not-live')).toBeLessThan(COVERAGE_ORDER.indexOf('unclaimed'));
    expect(COVERAGE_ORDER.indexOf('unclaimed')).toBeLessThan(COVERAGE_ORDER.indexOf('none'));
  });
});

describe('filterActiveCoverage (EI-9015)', () => {
  const NOW = Date.UTC(2026, 6, 10, 12, 0, 0); // fixed epoch for determinism
  const DAY = 24 * 3600 * 1000;

  const cov = (
    ref: string,
    level: CoverageLevel,
    lastActivityAt: Date | null,
  ): PlanItemCoverage => ({
    ref,
    links: [],
    directlyClaimed: false,
    directHolder: null,
    directActivity: null,
    // P-029/D-060 made `holder` required on PlanItemCoverage; unclaimed ⇒ null.
    holder: null,
    level,
    workers: [],
    lastActivityAt,
  });

  const refs = (entries: PlanItemCoverage[]) => entries.map((c) => c.ref);

  it('drops a long-complete entry (older than the ~7d window) by default', () => {
    const stale = cov('old-plan#P-1', 'complete', new Date(NOW - 30 * DAY));
    expect(filterActiveCoverage([stale], { now: NOW })).toEqual([]);
  });

  it('keeps a recently-completed entry (inside the window)', () => {
    const recent = cov('warm-plan#P-1', 'complete', new Date(NOW - 2 * DAY));
    expect(refs(filterActiveCoverage([recent], { now: NOW }))).toEqual(['warm-plan#P-1']);
  });

  it('keeps a stale-complete entry when its plan is one of the caller lane plans', () => {
    const stale = cov('my-lane#P-1', 'complete', new Date(NOW - 30 * DAY));
    const out = filterActiveCoverage([stale], {
      now: NOW,
      lanePlans: new Set(['my-lane']),
    });
    expect(refs(out)).toEqual(['my-lane#P-1']);
  });

  it('always keeps non-complete entries however stale (still in motion)', () => {
    const staleTs = new Date(NOW - 90 * DAY);
    const entries = [
      cov('p#P-1', 'full', staleTs),
      cov('p#P-2', 'partial', staleTs),
      cov('p#P-3', 'unclaimed', staleTs),
      cov('p#P-4', 'unclaimed', null),
      cov('p#P-5', 'held-not-live', staleTs),
    ];
    expect(refs(filterActiveCoverage(entries, { now: NOW }))).toEqual([
      'p#P-1',
      'p#P-2',
      'p#P-3',
      'p#P-4',
      'p#P-5',
    ]);
  });

  it('drops a complete entry with no lastActivityAt by default (no recency signal)', () => {
    const noTs = cov('p#P-1', 'complete', null);
    expect(filterActiveCoverage([noTs], { now: NOW })).toEqual([]);
  });

  it('fullCoverage:true returns the untrimmed ledger', () => {
    const stale = cov('old#P-1', 'complete', new Date(NOW - 30 * DAY));
    const noTs = cov('old#P-2', 'complete', null);
    const out = filterActiveCoverage([stale, noTs], { now: NOW, fullCoverage: true });
    expect(refs(out)).toEqual(['old#P-1', 'old#P-2']);
  });

  it('an explicit {plan} query returns the untrimmed ledger', () => {
    const stale = cov('old#P-1', 'complete', new Date(NOW - 30 * DAY));
    const out = filterActiveCoverage([stale], { now: NOW, explicitPlan: 'old' });
    expect(refs(out)).toEqual(['old#P-1']);
  });

  it('the window is exactly COVERAGE_ACTIVE_WINDOW_MS (boundary inclusive)', () => {
    const atEdge = cov('p#P-1', 'complete', new Date(NOW - COVERAGE_ACTIVE_WINDOW_MS));
    const pastEdge = cov('p#P-2', 'complete', new Date(NOW - COVERAGE_ACTIVE_WINDOW_MS - 1));
    expect(refs(filterActiveCoverage([atEdge, pastEdge], { now: NOW }))).toEqual(['p#P-1']);
  });
});

describe('agentPlansFromLiveCoverage (EI-21216638867560930)', () => {
  it('keeps a P-033-only linked duplicate in an agent-scoped coverage lane', () => {
    const linkedDuplicate: PlanItemCoverage = {
      ref: 'linked-only-plan#P-033',
      links: [
        {
          workItemId: 'WI-P033-A',
          rel: 'fixes',
          terminal: false,
          activity: 'alive',
          holder: 'su-agent-1',
        },
        {
          workItemId: 'WI-P033-B',
          rel: 'relates',
          terminal: false,
          activity: 'progressing',
          holder: 'su-agent-1',
        },
      ],
      directlyClaimed: false,
      directHolder: null,
      directActivity: null,
      holder: null,
      level: 'full',
      workers: ['su-agent-1'],
      lastActivityAt: null,
    };
    const unrelated: PlanItemCoverage = {
      ...linkedDuplicate,
      ref: 'other-plan#P-022',
      links: linkedDuplicate.links.map((link) => ({ ...link, holder: 'other-agent' })),
      workers: ['other-agent'],
    };

    const plans = agentPlansFromLiveCoverage(
      [linkedDuplicate, unrelated],
      new Set(['su-agent-1']),
    );
    const scoped = [linkedDuplicate, unrelated].filter((coverage) => {
      const hash = coverage.ref.indexOf('#');
      return hash > 0 && plans.has(coverage.ref.slice(0, hash));
    });

    expect(plans).toEqual(new Set(['linked-only-plan']));
    expect(duplicateCoverage(scoped)).toEqual([
      {
        ref: 'linked-only-plan#P-033',
        holder: 'su-agent-1',
        workItemIds: ['WI-P033-A', 'WI-P033-B'],
      },
    ]);
  });
});

describe('decorateCoordDeafness — P-001 (coord-delivery-residual-gaps-2026-07-11)', () => {
  const NOW = Date.parse('2026-07-11T12:00:00Z');
  const BUDGET = 10 * 60_000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  type DeafRow = AgentAssignment & {
    sessionState?: SessionState | null;
    startedAt?: string | null;
    coordHook?: 'stale' | 'missing' | null;
    coordLastReadAgoSec?: number | null;
  };
  const liveAgent = (overrides: Partial<DeafRow> = {}): DeafRow => ({
    ...baseAgent(),
    sessionState: 'live',
    heartbeatAt: iso(30_000),
    ...overrides,
  });

  it('stamps stale on a live agent whose last read is past budget', async () => {
    const agents = [liveAgent({ agentId: 'a1' })];
    await decorateCoordDeafness(
      agents,
      async () => new Map([['a1', iso(25 * 60_000)]]),
      NOW,
      BUDGET,
    );
    expect(agents[0].coordHook).toBe('stale');
    expect(agents[0].coordLastReadAgoSec).toBe(25 * 60);
  });

  it('a fresh reader stays unstamped', async () => {
    const agents = [liveAgent({ agentId: 'a1' })];
    await decorateCoordDeafness(agents, async () => new Map([['a1', iso(60_000)]]), NOW, BUDGET);
    expect(agents[0].coordHook).toBeUndefined();
  });

  it('never-read WITHOUT a startedAt is not flagged (assignments rows carry no start time)', async () => {
    const agents = [liveAgent({ agentId: 'a1' })];
    await decorateCoordDeafness(agents, async () => new Map(), NOW, BUDGET);
    expect(agents[0].coordHook).toBeUndefined();
  });

  it('never-read WITH an old startedAt → missing', async () => {
    const agents = [liveAgent({ agentId: 'a1', startedAt: iso(60 * 60_000) })];
    await decorateCoordDeafness(agents, async () => new Map(), NOW, BUDGET);
    expect(agents[0].coordHook).toBe('missing');
    expect(agents[0].coordLastReadAgoSec).toBeNull();
  });

  it('parked/ended rows are never candidates and never reach the fetcher', async () => {
    const fetched: string[][] = [];
    const agents = [
      liveAgent({ agentId: 'p1', sessionState: 'parked' }),
      liveAgent({ agentId: 'e1', sessionState: 'ended' }),
    ];
    await decorateCoordDeafness(agents, async (ids) => {
      fetched.push(ids);
      return new Map();
    }, NOW, BUDGET);
    expect(fetched).toEqual([]);
    expect(agents[0].coordHook).toBeUndefined();
    expect(agents[1].coordHook).toBeUndefined();
  });

  it('a live row with a cold heartbeat (not demonstrably active) is not flagged', async () => {
    const agents = [liveAgent({ agentId: 'a1', heartbeatAt: iso(20 * 60_000) })];
    await decorateCoordDeafness(
      agents,
      async () => new Map([['a1', iso(30 * 60_000)]]),
      NOW,
      BUDGET,
    );
    expect(agents[0].coordHook).toBeUndefined();
  });
});

// ── WI-5975: the reclaim NUDGE must not fire on live-held claims ───────────────
//
// The tool's seeAlso used to sum orphaned_claims + stalled_claims and tell the
// leader to go free N claims. Measured on the live fleet while fixing this: all
// 9 claims flagged `stalled` were held by agents heartbeating 2-58s ago, and 6
// of the 9 had never checkpointed at all — so the prompt actively recommended
// releasing work out from under agents that were mid-task.
describe('fleet:assignments seeAlso — WI-5975 reclaim nudge', () => {
  const seeAlso = fleetAssignmentsTool.guidance?.seeAlso as (result: {
    content?: { type: string; text: string }[];
  }) => (string | { tool: string; reason: string })[];

  it('is wired as a result-aware callback (guard: a renamed field must fail loudly)', () => {
    expect(typeof seeAlso).toBe('function');
  });

  const asJson = (summary: Record<string, number>) => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: true, summary }) }],
  });
  const asToon = (summary: Record<string, number>) => ({
    content: [
      {
        type: 'text',
        text: ['ok: true', 'summary:', ...Object.entries(summary).map(([k, v]) => `  ${k}: ${v}`)].join('\n'),
      },
    ],
  });
  const releasePointer = (out: ReturnType<typeof seeAlso>) =>
    out.find((e) => typeof e === 'object' && e.tool === 'work_items:release');

  it('does NOT advise releasing when every flagged claim has a live holder', () => {
    const summary = {
      orphaned_claims: 0,
      stalled_claims: 9,
      reclaimable_claims: 0,
      held_by_live_agent: 9,
    };
    expect(releasePointer(seeAlso(asJson(summary)))).toBeUndefined();
    // …and on the TOON transport, where the regex fallback reads the count.
    expect(releasePointer(seeAlso(asToon(summary)))).toBeUndefined();
  });

  it('DOES advise releasing genuinely-orphaned claims, counting only those', () => {
    const summary = {
      orphaned_claims: 2,
      stalled_claims: 9,
      reclaimable_claims: 2,
      held_by_live_agent: 9,
    };
    for (const result of [asJson(summary), asToon(summary)]) {
      const p = releasePointer(seeAlso(result));
      expect(p).toBeDefined();
      // 2 — not the pre-fix 11 (orphaned + stalled).
      expect((p as { reason: string }).reason).toContain('2 orphaned');
    }
  });

  it('always keeps the two static adjacent-lens pointers', () => {
    const out = seeAlso(asJson({ reclaimable_claims: 0 }));
    expect(out.filter((e) => typeof e === 'string')).toHaveLength(2);
  });
});
