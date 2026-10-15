/**
 * fleet-transition-events.test — the P-009 / D-008 leader transition feed.
 *
 * The behaviours worth pinning are the ones that make a monitor TRUSTWORTHY: it
 * fires on a real crossing, and it does NOT fire on a first sighting, a steady
 * state, a disappearance, or an unconfirmed liveness suspicion. A monitor that
 * cries wolf is worse than no monitor — the leader learns to ignore it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WorkItem } from './work-items';
import { CLAIM_STATES_ALLOWLIST } from './scheduler/claim-states';
import {
  announceFleetClaimReleased,
  announceFleetItemCompleted,
  claimReleasedDisposition,
  detectFleetTransitions,
  emitFleetClaimReleasedEvent,
  emitFleetItemCompletedEvent,
  emitFleetTransitionEdge,
  fleetTransitionKey,
  indexObservations,
  isActionableFleetObservation,
  type FleetDeadLatchEntry,
  type FleetLeftLatchEntry,
  type FleetMemberObservation,
  type FleetTransitionEdge,
} from './fleet-transition-events';

const member = (over: Partial<FleetMemberObservation> = {}): FleetMemberObservation => ({
  agentId: 'su-a',
  fleetSlug: 'push-not-poll',
  sessionState: 'live',
  contextPressure: 'ok',
  ...over,
});

/** Await the fire-and-forget microtask chain the emitters use. */
const settle = () => new Promise((r) => setImmediate(r));

function releasedItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'EI-1',
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    title: 'released item',
    summary: '',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    createdBy: null,
    severity: 'minor',
    goalId: null,
    parent: null,
    payload: {},
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    completionAuthority: null,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

describe('fleetTransitionKey', () => {
  it('builds the fleet-scoped key shape the catalog advertises', () => {
    expect(fleetTransitionKey('push-not-poll', 'member-dead')).toBe('fleet:member-dead:push-not-poll');
    expect(fleetTransitionKey('push-not-poll', 'member-left')).toBe('fleet:member-left:push-not-poll');
    expect(fleetTransitionKey('push-not-poll', 'item-completed')).toBe('fleet:item-completed:push-not-poll');
    expect(fleetTransitionKey('push-not-poll', 'repeated-recovery')).toBe('fleet:repeated-recovery:push-not-poll');
  });

  it('puts the SLUG LAST so the catalog prefix stays precise — a slug-first template would truncate to `fleet:` and match every fleet key', () => {
    // The regression this shape exists to prevent: familyKeyPrefix truncates a
    // template at its first placeholder, so `fleet:<slug>:member-dead` would
    // register the prefix `fleet:` and silently disarm the orphan guard for the
    // whole namespace. Uniform with the pre-existing `fleet:drained:<slug>`.
    for (const kind of ['member-dead', 'member-left', 'context-critical', 'claim-released', 'item-completed'] as const) {
      expect(fleetTransitionKey('any-slug', kind).startsWith(`fleet:${kind}:`)).toBe(true);
    }
  });
});

describe('detectFleetTransitions', () => {
  it('fires member-dead on the live → ended crossing', () => {
    const prev = indexObservations([member({ sessionState: 'live' })]);
    const edges = detectFleetTransitions(prev, [member({ sessionState: 'ended' })]);
    expect(edges).toEqual([
      { kind: 'member-dead', fleetSlug: 'push-not-poll', agentId: 'su-a', to: 'ended', from: 'live' },
    ]);
  });

  it('fires member-left when a recorded, non-wakeable member still holds claims', () => {
    const prev = indexObservations([member({ sessionState: 'live', wakeable: true, claimCount: 3 })]);
    const edges = detectFleetTransitions(
      prev,
      [member({ sessionState: 'recorded', wakeable: false, claimCount: 3 })],
    );
    expect(edges).toEqual([
      {
        kind: 'member-left',
        fleetSlug: 'push-not-poll',
        agentId: 'su-a',
        to: 'recorded',
        from: 'live',
        claimCount: 3,
      },
    ]);
  });

  it('does not report member-left while a healthy engine loop will wake the member', () => {
    const prev = indexObservations([member({ sessionState: 'live', wakeable: true, claimCount: 2 })]);
    expect(
      detectFleetTransitions(prev, [
        member({ sessionState: 'recorded', wakeable: false, claimCount: 2, loopMonitorState: 'waiting' }),
      ]),
    ).toEqual([]);
  });

  it('reports member-left if the healthy engine loop disappears while recorded claims remain', () => {
    const prev = indexObservations([
      member({ sessionState: 'recorded', wakeable: false, claimCount: 2, loopMonitorState: 'waiting' }),
    ]);
    expect(
      detectFleetTransitions(prev, [
        member({ sessionState: 'recorded', wakeable: false, claimCount: 2, loopMonitorState: null }),
      ]),
    ).toEqual([
      {
        kind: 'member-left',
        fleetSlug: 'push-not-poll',
        agentId: 'su-a',
        to: 'recorded',
        from: 'recorded',
        claimCount: 2,
      },
    ]);
  });

  it('does not fire member-left for claimless or wakeable recorded members', () => {
    const prev = indexObservations([member({ sessionState: 'live', wakeable: true, claimCount: 2 })]);
    expect(
      detectFleetTransitions(prev, [member({ sessionState: 'recorded', wakeable: false, claimCount: 0 })]),
    ).toEqual([]);
    expect(
      detectFleetTransitions(prev, [member({ sessionState: 'recorded', wakeable: true, claimCount: 2 })]),
    ).toEqual([]);
  });

  it('does not repeat member-left while the recorded claim-bearing state persists', () => {
    const recorded = member({ sessionState: 'recorded', wakeable: false, claimCount: 2 });
    expect(detectFleetTransitions(indexObservations([recorded]), [recorded])).toEqual([]);
  });

  it('latches member-left across short live flaps with the same claims', () => {
    const latch = new Map<string, FleetLeftLatchEntry>();
    const live = member({ sessionState: 'live', wakeable: true, claimCount: 2, claimKeys: ['WI-1', 'WI-2'] });
    const recorded = member({ sessionState: 'recorded', wakeable: false, claimCount: 2, claimKeys: ['WI-2', 'WI-1'] });
    let previous = indexObservations([live]);
    let notices = 0;
    for (let i = 0; i < 4; i++) {
      const edges = detectFleetTransitions(previous, [recorded], { leftLatch: latch, nowMs: i * 60_000 });
      notices += edges.filter((edge) => edge.kind === 'member-left').length;
      previous = indexObservations([recorded]);
      expect(detectFleetTransitions(previous, [live], { leftLatch: latch, nowMs: i * 60_000 + 30_000 })).toEqual([]);
      previous = indexObservations([live]);
    }
    expect(notices).toBe(1);
  });

  it('rearms member-left when the claim set changes even if its count stays constant', () => {
    const latch = new Map<string, FleetLeftLatchEntry>();
    const first = member({ sessionState: 'recorded', wakeable: false, claimCount: 2, claimKeys: ['WI-1', 'WI-2'] });
    const changed = member({ sessionState: 'recorded', wakeable: false, claimCount: 2, claimKeys: ['WI-1', 'WI-3'] });
    detectFleetTransitions(indexObservations([member({ sessionState: 'live', claimCount: 2 })]), [first], { leftLatch: latch, nowMs: 0 });
    expect(detectFleetTransitions(indexObservations([first]), [changed], { leftLatch: latch, nowMs: 60_000 })).toEqual([
      { kind: 'member-left', fleetSlug: 'push-not-poll', agentId: 'su-a', to: 'recorded', from: 'recorded', claimCount: 2 },
    ]);
  });

  it('rearms member-left after sustained wakeable recovery', () => {
    const latch = new Map<string, FleetLeftLatchEntry>();
    const live = member({ sessionState: 'live', wakeable: true, claimCount: 1, claimKeys: ['WI-1'] });
    const recorded = member({ sessionState: 'recorded', wakeable: false, claimCount: 1, claimKeys: ['WI-1'] });
    detectFleetTransitions(indexObservations([live]), [recorded], { leftLatch: latch, nowMs: 0 });
    detectFleetTransitions(indexObservations([recorded]), [live], { leftLatch: latch, nowMs: 60_000, rearmDwellMs: 120_000 });
    detectFleetTransitions(indexObservations([live]), [live], { leftLatch: latch, nowMs: 180_000, rearmDwellMs: 120_000 });
    expect(detectFleetTransitions(indexObservations([live]), [recorded], { leftLatch: latch, nowMs: 240_000 })).toHaveLength(1);
  });

  it('fires context-critical on the high → critical crossing', () => {
    const prev = indexObservations([member({ contextPressure: 'high' })]);
    const edges = detectFleetTransitions(prev, [member({ contextPressure: 'critical' })]);
    expect(edges).toEqual([
      { kind: 'context-critical', fleetSlug: 'push-not-poll', agentId: 'su-a', to: 'critical', from: 'high' },
    ]);
  });

  it('does NOT fire on a first sighting — an already-dead member seen for the first time is not a crossing', () => {
    // Rule 1. Without it the first sweep after any operator restart wakes every
    // leader for every historically-dead row still in the roster.
    expect(detectFleetTransitions(new Map(), [member({ sessionState: 'ended' })])).toEqual([]);
    expect(detectFleetTransitions(new Map(), [member({ contextPressure: 'critical' })])).toEqual([]);
    expect(
      detectFleetTransitions(new Map(), [
        member({ sessionState: 'recorded', wakeable: false, claimCount: 1 }),
      ]),
    ).toEqual([]);
  });

  it('does NOT re-fire while the member STAYS dead or STAYS critical', () => {
    // Rule 2. Both states persist for many sweeps; re-firing is a wake storm.
    const dead = indexObservations([member({ sessionState: 'ended', contextPressure: 'critical' })]);
    expect(detectFleetTransitions(dead, [member({ sessionState: 'ended', contextPressure: 'critical' })])).toEqual([]);
  });

  it('does NOT fire context-critical on an UNKNOWN → critical reading — a lapsed estimate is not a crossing (EI-21968977558564590)', () => {
    // Rule 3. `null` means the bucket could not be derived, not that the member
    // was comfortable. deriveContextPressure degrades any estimate older than
    // CONTEXT_ESTIMATE_STALE_MS to null, and gatherFleetObservations falls back
    // to an empty pressure map on a failed batch read — so a member that never
    // left critical is routinely observed as null and then critical again.
    const lapsed = indexObservations([member({ contextPressure: null })]);
    expect(detectFleetTransitions(lapsed, [member({ contextPressure: 'critical' })])).toEqual([]);
  });

  it('does NOT re-fire across a lapse for a member that never left critical — the eight-coalesced-edges regression', () => {
    // The reported shape end to end: critical, estimate lapses to unknown,
    // estimate returns still-critical. Before rule 3 the third sweep fired a
    // fresh edge, and repeated once per lapse for as long as the member stayed
    // critical — eight of them for one RETIRED member whose telemetry is frozen.
    let snapshot = indexObservations([member({ contextPressure: 'critical' })]);
    for (const bucket of [null, 'critical', null, 'critical'] as const) {
      const next = [member({ contextPressure: bucket })];
      expect(detectFleetTransitions(snapshot, next)).toEqual([]);
      snapshot = indexObservations(next);
    }
  });

  it('STILL fires on a KNOWN non-critical → critical crossing — rule 3 narrows the signal, it does not disable it', () => {
    // Calibration for the two tests above: if this ever goes quiet, rule 3 has
    // suppressed the real signal rather than only the manufactured one.
    for (const from of ['ok', 'high'] as const) {
      const prev = indexObservations([member({ contextPressure: from })]);
      expect(detectFleetTransitions(prev, [member({ contextPressure: 'critical' })])).toEqual([
        { kind: 'context-critical', fleetSlug: 'push-not-poll', agentId: 'su-a', to: 'critical', from },
      ]);
    }
  });

  it('does NOT treat draining or suspect as dead — both need a wake confirmation first (WI-4400)', () => {
    const prev = indexObservations([member({ sessionState: 'live' })]);
    expect(detectFleetTransitions(prev, [member({ sessionState: 'draining' })])).toEqual([]);
    expect(detectFleetTransitions(prev, [member({ sessionState: 'suspect' })])).toEqual([]);
  });

  it('does NOT treat a DISAPPEARANCE as a death — a reaped row and a departed member are indistinguishable', () => {
    const prev = indexObservations([member({ sessionState: 'live' })]);
    expect(detectFleetTransitions(prev, [])).toEqual([]);
  });

  it('re-fires when a member recovers and then dies again — the crossing is what matters, not the history', () => {
    const dead = indexObservations([member({ sessionState: 'ended' })]);
    expect(detectFleetTransitions(dead, [member({ sessionState: 'live' })])).toEqual([]);
    const revived = indexObservations([member({ sessionState: 'live' })]);
    expect(detectFleetTransitions(revived, [member({ sessionState: 'ended' })])).toHaveLength(1);
  });

  it('scopes a member to its fleet — the same agent id in a different fleet is a different member, so no crossing', () => {
    const prev = indexObservations([member({ fleetSlug: 'fleet-a', sessionState: 'live' })]);
    expect(detectFleetTransitions(prev, [member({ fleetSlug: 'fleet-b', sessionState: 'ended' })])).toEqual([]);
  });

  it('emits BOTH edges when a member dies and goes critical in the same sweep', () => {
    const prev = indexObservations([member({ sessionState: 'live', contextPressure: 'ok' })]);
    const edges = detectFleetTransitions(prev, [member({ sessionState: 'ended', contextPressure: 'critical' })]);
    expect(edges.map((e) => e.kind).sort()).toEqual(['context-critical', 'member-dead']);
  });

  it('returns a deterministic order across fleets and members', () => {
    const prev = indexObservations([
      member({ fleetSlug: 'b-fleet', agentId: 'su-z', sessionState: 'live' }),
      member({ fleetSlug: 'a-fleet', agentId: 'su-y', sessionState: 'live' }),
      member({ fleetSlug: 'a-fleet', agentId: 'su-x', sessionState: 'live' }),
    ]);
    const edges = detectFleetTransitions(prev, [
      member({ fleetSlug: 'b-fleet', agentId: 'su-z', sessionState: 'ended' }),
      member({ fleetSlug: 'a-fleet', agentId: 'su-y', sessionState: 'ended' }),
      member({ fleetSlug: 'a-fleet', agentId: 'su-x', sessionState: 'ended' }),
    ]);
    expect(edges.map((e) => `${e.fleetSlug}/${e.agentId}`)).toEqual(['a-fleet/su-x', 'a-fleet/su-y', 'b-fleet/su-z']);
  });

  it('fires repeated-recovery only on the measured 1 → 2 edge', () => {
    const one = indexObservations([member({ consecutiveRecoveryOnlyCycles: 1 })]);
    expect(detectFleetTransitions(one, [member({ consecutiveRecoveryOnlyCycles: 2 })])).toEqual([
      {
        kind: 'repeated-recovery',
        fleetSlug: 'push-not-poll',
        agentId: 'su-a',
        from: '1',
        to: '2',
        consecutiveRecoveryOnlyCycles: 2,
        action: 'diagnose',
        takeoverAuthorized: false,
      },
    ]);
    expect(detectFleetTransitions(new Map(), [member({ consecutiveRecoveryOnlyCycles: 2 })])).toEqual([]);
    expect(
      detectFleetTransitions(
        indexObservations([member({ consecutiveRecoveryOnlyCycles: null })]),
        [member({ consecutiveRecoveryOnlyCycles: 2 })],
      ),
    ).toEqual([]);
    expect(
      detectFleetTransitions(
        indexObservations([member({ consecutiveRecoveryOnlyCycles: 2 })]),
        [member({ consecutiveRecoveryOnlyCycles: 3 })],
      ),
    ).toEqual([]);
  });
});

describe('isActionableFleetObservation', () => {
  it('drops recorded, non-wakeable, claimless stand-down residue', () => {
    expect(
      isActionableFleetObservation({ sessionState: 'recorded', wakeable: false, claimCount: 0 }),
    ).toBe(false);
  });

  it('keeps a recorded member when it still has a claim or enrichment is unknown', () => {
    expect(isActionableFleetObservation({ sessionState: 'recorded', wakeable: false, claimCount: 1 })).toBe(true);
    expect(isActionableFleetObservation({ sessionState: 'recorded', wakeable: null, claimCount: 0 })).toBe(true);
  });
});

describe('emitFleetTransitionEdge', () => {
  it('emits the fleet-scoped key with the crossing in the payload, awaiter-only (no `to` push)', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetTransitionEdge(
      { kind: 'member-dead', fleetSlug: 'push-not-poll', agentId: 'su-a', to: 'ended', from: 'live' },
      { emit },
    );
    await settle();
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0][0];
    expect(arg.key).toBe('fleet:member-dead:push-not-poll');
    expect(arg.payload).toMatchObject({ fleetSlug: 'push-not-poll', agentId: 'su-a', from: 'live', to: 'ended' });
    expect(arg.to).toBeUndefined();
  });

  it('emits member-left with claim count after last-moment revalidation', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentMemberObservation = vi.fn(async () => ({
      sessionState: 'recorded' as const,
      wakeable: false,
      claimCount: 2,
    }));
    emitFleetTransitionEdge(
      {
        kind: 'member-left',
        fleetSlug: 'push-not-poll',
        agentId: 'su-a',
        from: 'live',
        to: 'recorded',
        claimCount: 2,
      },
      { emit, currentMemberObservation },
    );
    await settle();
    expect(currentMemberObservation).toHaveBeenCalledWith('push-not-poll', 'su-a');
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'fleet:member-left:push-not-poll',
      payload: {
        fleetSlug: 'push-not-poll',
        agentId: 'su-a',
        transition: 'member-left',
        claimCount: 2,
      },
    });
  });

  it('suppresses a member-left wake when a healthy engine loop exists before delivery', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentMemberObservation = vi.fn(async () => ({
      sessionState: 'recorded' as const,
      wakeable: false,
      claimCount: 2,
      loopMonitorState: 'waiting' as const,
    }));
    emitFleetTransitionEdge(
      {
        kind: 'member-left',
        fleetSlug: 'push-not-poll',
        agentId: 'su-a',
        from: 'live',
        to: 'recorded',
        claimCount: 2,
      },
      { emit, currentMemberObservation },
    );
    await settle();
    expect(currentMemberObservation).toHaveBeenCalledWith('push-not-poll', 'su-a');
    expect(emit).not.toHaveBeenCalled();
  });

  it('suppresses member-left if claims are gone before delivery', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetTransitionEdge(
      {
        kind: 'member-left',
        fleetSlug: 'f',
        agentId: 'su-a',
        from: 'live',
        to: 'recorded',
        claimCount: 2,
      },
      {
        emit,
        currentMemberObservation: vi.fn(async () => ({
          sessionState: 'recorded' as const,
          wakeable: false,
          claimCount: 0,
        })),
      },
    );
    await settle();
    expect(emit).not.toHaveBeenCalled();
  });

  it('never throws when the emit rejects — a monitor emit can never break its caller', async () => {
    const emit = vi.fn().mockRejectedValue(new Error('relation "x" does not exist'));
    expect(() =>
      emitFleetTransitionEdge(
        { kind: 'context-critical', fleetSlug: 'f', agentId: 'su-a', to: 'critical', from: 'high' },
        { emit },
      ),
    ).not.toThrow();
    await settle();
  });

  it('suppresses a context-critical wake when the current writer has recovered before delivery', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    let current: 'ok' | 'critical' = 'critical';
    const currentContextPressure = vi.fn(async () => current);

    emitFleetTransitionEdge(
      { kind: 'context-critical', fleetSlug: 'f', agentId: 'su-a', to: 'critical', from: 'high' },
      { emit, currentContextPressure },
    );
    // The detached emitter must validate after this recovery, not trust the
    // stale edge payload captured by the earlier sweep.
    current = 'ok';
    await settle();

    expect(currentContextPressure).toHaveBeenCalledWith('su-a');
    expect(emit).not.toHaveBeenCalled();
  });

  it('suppresses a member-dead wake when the current writer has recovered before delivery', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentMemberObservation = vi.fn(async () => ({
      sessionState: 'live' as const,
      wakeable: true,
      claimCount: 1,
    }));

    emitFleetTransitionEdge(
      { kind: 'member-dead', fleetSlug: 'f', agentId: 'su-a', to: 'ended', from: 'live' },
      { emit, currentMemberObservation },
    );
    await settle();

    expect(currentMemberObservation).toHaveBeenCalledWith('f', 'su-a');
    expect(emit).not.toHaveBeenCalled();
  });

  it('still emits a member-dead wake while the current writer remains ended', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentMemberObservation = vi.fn(async () => ({
      sessionState: 'ended' as const,
      wakeable: false,
      claimCount: 1,
    }));

    emitFleetTransitionEdge(
      { kind: 'member-dead', fleetSlug: 'f', agentId: 'su-a', to: 'ended', from: 'live' },
      { emit, currentMemberObservation },
    );
    await settle();

    expect(emit).toHaveBeenCalledOnce();
  });

  it('suppresses a member-stalled wake when the current assignment is parked/healthy', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentMemberObservation = vi.fn(async () => ({
      sessionState: 'parked' as const,
      wakeable: true,
      claimCount: 1,
      stalled: false,
    }));

    emitFleetTransitionEdge(
      { kind: 'member-stalled', fleetSlug: 'f', agentId: 'su-a', to: 'stalled', from: 'clear' },
      { emit, currentMemberObservation },
    );
    await settle();

    expect(currentMemberObservation).toHaveBeenCalledWith('f', 'su-a');
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits a member-stalled wake when the current assignment remains stalled', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentMemberObservation = vi.fn(async () => ({
      sessionState: 'live' as const,
      wakeable: true,
      claimCount: 1,
      stalled: true,
    }));

    emitFleetTransitionEdge(
      { kind: 'member-stalled', fleetSlug: 'f', agentId: 'su-a', to: 'stalled', from: 'clear' },
      { emit, currentMemberObservation },
    );
    await settle();

    expect(emit).toHaveBeenCalledOnce();
  });

  it('still emits a context-critical wake while the current writer remains critical', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentContextPressure = vi.fn(async () => 'critical' as const);
    const currentContextEpoch = vi.fn(async () => null);

    emitFleetTransitionEdge(
      { kind: 'context-critical', fleetSlug: 'f', agentId: 'su-a', to: 'critical', from: 'high' },
      { emit, currentContextPressure, currentContextEpoch },
    );
    await settle();

    expect(emit).toHaveBeenCalledOnce();
  });

  it('suppresses a queued wake when the member has gracefully become recorded, non-wakeable, and claimless', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const currentMemberObservation = vi.fn(async () => ({
      sessionState: 'recorded' as const,
      wakeable: false,
      claimCount: 0,
    }));
    const currentContextPressure = vi.fn(async () => 'critical' as const);

    emitFleetTransitionEdge(
      { kind: 'context-critical', fleetSlug: 'f', agentId: 'su-a', to: 'critical', from: 'high' },
      { emit, currentMemberObservation, currentContextPressure },
    );
    await settle();

    expect(currentMemberObservation).toHaveBeenCalledWith('f', 'su-a');
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits repeated-recovery as diagnostic-only and suppresses it if the member is now progressing', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const edge: FleetTransitionEdge = {
      kind: 'repeated-recovery',
      fleetSlug: 'f',
      agentId: 'su-a',
      from: '1',
      to: '2',
      consecutiveRecoveryOnlyCycles: 2,
      action: 'diagnose',
      takeoverAuthorized: false,
    };
    emitFleetTransitionEdge(edge, { emit });
    await settle();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'fleet:repeated-recovery:f',
        payload: expect.objectContaining({ action: 'diagnose', takeoverAuthorized: false }),
      }),
    );

    emit.mockClear();
    emitFleetTransitionEdge(edge, {
      emit,
      currentMemberObservation: async () => ({
        sessionState: 'live',
        wakeable: true,
        claimCount: 1,
        isRegisteredLeader: false,
        hasProgressingClaim: true,
      }),
    });
    await settle();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('the work-item co-fires', () => {
  it('suppresses a release wake when the released item is outside the holder fleet scope', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const fleetClaimScopeMatches = vi.fn().mockResolvedValue(false);

    announceFleetClaimReleased('su-a', releasedItem({ harness: 'papercusp' }), {
      emit,
      fleetOfAgent: async () => 'sidestage-fleet',
      fleetClaimScopeMatches,
      workspaceId: async () => 'workspace-1',
    });
    await settle();

    expect(fleetClaimScopeMatches).toHaveBeenCalledWith('workspace-1', 'sidestage-fleet', expect.anything());
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits a release wake when the released item matches the holder fleet scope', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const fleetClaimScopeMatches = vi.fn().mockResolvedValue(true);

    announceFleetClaimReleased('su-a', releasedItem(), {
      emit,
      fleetOfAgent: async () => 'push-not-poll',
      fleetClaimScopeMatches,
      workspaceId: async () => 'workspace-1',
    });
    await settle();

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'fleet:claim-released:push-not-poll',
        payload: expect.objectContaining({ id: 'EI-1', priorAssignee: 'su-a' }),
      }),
    );
  });

  it('emits fleet:<slug>:claim-released carrying the PRIOR holder', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetClaimReleasedEvent('push-not-poll', { id: 'WI-1', title: 't', harness: 'papercusp' }, 'su-a', { emit });
    await settle();
    expect(emit.mock.calls[0][0].key).toBe('fleet:claim-released:push-not-poll');
    expect(emit.mock.calls[0][0].payload).toMatchObject({ id: 'WI-1', priorAssignee: 'su-a' });
  });

  // EI-23773284013147023: a released claim is a TRANSITION, not an instruction. The leader
  // acts from this payload/summary, so the verdict must travel WITH the event — an item
  // released while BLOCKED must never read as free work.
  describe('claim-released disposition (EI-23773284013147023)', () => {
    const fire = async (item: Parameters<typeof emitFleetClaimReleasedEvent>[1]) => {
      const emit = vi.fn().mockResolvedValue(undefined);
      emitFleetClaimReleasedEvent('push-not-poll', item, 'su-a', { emit });
      await settle();
      return emit.mock.calls[0][0] as { summary: string; payload: Record<string, unknown> };
    };

    it.each([
      ['open', 'replaceable'],
      ['failing', 'replaceable'],
      ['blocked', 'held'],
      ['needs-human', 'held'],
      ['done', 'not-replaceable'],
      ['wip', 'not-replaceable'],
    ] as const)('classifies a release from %s as %s', (state, disposition) => {
      expect(claimReleasedDisposition(state)).toBe(disposition);
    });

    it('classifies a missing/blank state as unknown rather than guessing', () => {
      expect(claimReleasedDisposition(undefined)).toBe('unknown');
      expect(claimReleasedDisposition(null)).toBe('unknown');
      expect(claimReleasedDisposition('  ')).toBe('unknown');
    });

    it('carries state, disposition and the plan slug in the payload', async () => {
      const ev = await fire({ id: 'WI-9', state: 'blocked', sourcePlanSlug: 'some-plan', harness: 'papercusp' });
      expect(ev.payload).toMatchObject({
        id: 'WI-9',
        state: 'blocked',
        disposition: 'held',
        sourcePlanSlug: 'some-plan',
      });
    });

    it('a BLOCKED release LEADS its summary with the do-not-re-place verdict and names the plan', async () => {
      const ev = await fire({ id: 'WI-9', state: 'blocked', sourcePlanSlug: 'some-plan' });
      // The verdict is the first clause after the holder — a leader skimming only the head of
      // the wake must not be able to read this as re-placeable work.
      expect(ev.summary).toMatch(/released by su-a while blocked — NOT re-placeable work/);
      expect(ev.summary).toContain('do NOT re-place it');
      expect(ev.summary).toContain("plan some-plan's Decisions");
      expect(ev.summary).not.toContain('back to the pool');
    });

    it('a needs-human release is held too, and omits the plan clause when there is no plan', async () => {
      const ev = await fire({ id: 'WI-9', state: 'needs-human' });
      expect(ev.payload.disposition).toBe('held');
      expect(ev.summary).toContain('while needs-human — NOT re-placeable work');
      expect(ev.summary).not.toContain('Decisions');
    });

    it('an OPEN release keeps the original "back to the pool" wording', async () => {
      const ev = await fire({ id: 'WI-9', state: 'open' });
      expect(ev.payload.disposition).toBe('replaceable');
      expect(ev.summary).toBe('fleet push-not-poll: WI-9 released by su-a — back to the pool');
    });

    it('a settled/other-state release is flagged not-replaceable and points at work_items:get', async () => {
      const ev = await fire({ id: 'WI-9', state: 'done' });
      expect(ev.payload.disposition).toBe('not-replaceable');
      expect(ev.summary).toContain('in state done — not claimable from the pool');
      expect(ev.summary).toContain('work_items:get');
    });

    it('a caller that supplies no state keeps the legacy wording and a null state', async () => {
      const ev = await fire({ id: 'WI-9' });
      expect(ev.payload).toMatchObject({ state: null, disposition: 'unknown', sourcePlanSlug: null });
      expect(ev.summary).toBe('fleet push-not-poll: WI-9 released by su-a — back to the pool');
    });

    it('reads "replaceable" from the scheduler CLAIM_STATES_ALLOWLIST so the two cannot drift', () => {
      for (const s of CLAIM_STATES_ALLOWLIST) expect(claimReleasedDisposition(s)).toBe('replaceable');
    });
  });

  it('emits fleet:<slug>:item-completed carrying the settling state and holder', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetItemCompletedEvent('push-not-poll', { id: 'WI-1', state: 'resolved', assignee: 'su-a' }, { emit });
    await settle();
    expect(emit.mock.calls[0][0].key).toBe('fleet:item-completed:push-not-poll');
    expect(emit.mock.calls[0][0].payload).toMatchObject({ id: 'WI-1', state: 'resolved', assignee: 'su-a' });
  });

  it('resolves and attributes a terminal event from the pre-clear holder without mutating the post-state item', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const fleetOfAgent = vi.fn(async (_workspaceId: string, ownerId: string) =>
      ownerId === 'su-a' ? 'push-not-poll' : null,
    );
    const item = { id: 'WI-1', state: 'resolved', assignee: null };

    announceFleetItemCompleted(item, 'su-a', {
      emit,
      fleetOfAgent,
      workspaceId: async () => 'workspace-1',
    });
    await settle();

    expect(fleetOfAgent).toHaveBeenCalledWith('workspace-1', 'su-a');
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0][0].payload).toMatchObject({
      id: 'WI-1',
      state: 'resolved',
      assignee: 'su-a',
    });
    expect(item.assignee).toBeNull();
  });

  it('fires NOTHING when the holder is in no fleet — an unfleeted release is not a fleet transition', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    emitFleetClaimReleasedEvent(null, { id: 'WI-1' }, 'su-a', { emit });
    emitFleetClaimReleasedEvent(undefined, { id: 'WI-1' }, 'su-a', { emit });
    emitFleetItemCompletedEvent(null, { id: 'WI-1', state: 'resolved' }, { emit });
    await settle();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('detectFleetTransitions — the member-dead latch (rule 3)', () => {
  /**
   * Drive a sequence of one-minute sweeps for a single member, feeding each
   * sweep's observations forward as the next sweep's `prev` exactly as the real
   * sweep does.
   */
  const runSweeps = (
    states: readonly { sessionState: string; atMs: number }[],
    opts: { deadLatch?: Map<string, FleetDeadLatchEntry>; rearmDwellMs?: number } = {},
  ) => {
    let prev = new Map<string, FleetMemberObservation>();
    const fired: FleetTransitionEdge[] = [];
    for (const s of states) {
      const obs = [member({ sessionState: s.sessionState })];
      fired.push(...detectFleetTransitions(prev, obs, { ...opts, nowMs: s.atMs }));
      prev = indexObservations(obs);
    }
    return fired;
  };

  /**
   * The MEASURED shape from EI-22125312396899848, not an invented one: a dead
   * session keeps drawing a 2–7/hour trickle of `agent_activity`, and each row
   * re-satisfies the ~10-minute liveTurn window. So the derived verdict reads
   * `live` for ~10 minutes, lapses to `ended`, and repeats — for hours.
   */
  const trickleFlap = (hours: number) => {
    const out: { sessionState: string; atMs: number }[] = [];
    for (let m = 0; m < hours * 60; m++) {
      out.push({ sessionState: m % 12 < 10 ? 'live' : 'ended', atMs: m * 60_000 });
    }
    return out;
  };

  it('fires ONCE for a member whose verdict oscillates ended→live→ended all night', () => {
    const edges = runSweeps(trickleFlap(10), { deadLatch: new Map() });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: 'member-dead', agentId: 'su-a' });
  });

  it('CONTROL — the same sequence without the latch fires on every lapse (this is the measured bug)', () => {
    // Falsifiability: if this control ever stops firing dozens of times, the
    // scenario above has stopped exercising the flap and its `toHaveLength(1)`
    // would be passing for the wrong reason.
    const edges = runSweeps(trickleFlap(10));
    expect(edges.length).toBeGreaterThan(40);
  });

  it('re-arms after SUSTAINED liveness, so a genuine relaunch that dies again is still reported', () => {
    const seq = [
      { sessionState: 'live', atMs: 0 },
      { sessionState: 'ended', atMs: 60_000 }, // first death — fires
      // a real relaunch: continuously live for well past the dwell
      ...Array.from({ length: 40 }, (_, i) => ({ sessionState: 'live', atMs: (2 + i) * 60_000 })),
      { sessionState: 'ended', atMs: 42 * 60_000 }, // second, genuine death — fires again
    ];
    expect(runSweeps(seq, { deadLatch: new Map() })).toHaveLength(2);
  });

  it('does NOT re-arm on a live window shorter than the dwell — the flap must not look like a relaunch', () => {
    const seq = [
      { sessionState: 'live', atMs: 0 },
      { sessionState: 'ended', atMs: 60_000 },
      // 20 minutes of "live" — long, but under the 30-minute dwell
      ...Array.from({ length: 20 }, (_, i) => ({ sessionState: 'live', atMs: (2 + i) * 60_000 })),
      { sessionState: 'ended', atMs: 22 * 60_000 },
    ];
    expect(runSweeps(seq, { deadLatch: new Map() })).toHaveLength(1);
  });

  it('keeps accruing the dwell across a snapshot gap, so a restart cannot strand a member latched forever', () => {
    const latch = new Map<string, FleetDeadLatchEntry>();
    runSweeps([{ sessionState: 'live', atMs: 0 }, { sessionState: 'ended', atMs: 60_000 }], { deadLatch: latch });
    expect(latch.size).toBe(1);
    // The post-restart shape: `prev` is empty every sweep, so rule 1 suppresses
    // any edge — but rule 3's dwell must still count, or the member stays
    // latched forever and a real later death is never reported.
    for (let i = 0; i < 40; i++) {
      detectFleetTransitions(new Map(), [member({ sessionState: 'live' })], {
        deadLatch: latch,
        nowMs: (2 + i) * 60_000,
      });
    }
    expect(latch.size).toBe(0);
  });

  it('prunes latch entries by AGE, never by absence from a sweep', () => {
    const latch = new Map<string, FleetDeadLatchEntry>();
    runSweeps([{ sessionState: 'live', atMs: 0 }, { sessionState: 'ended', atMs: 60_000 }], { deadLatch: latch });
    expect(latch.size).toBe(1);
    // A sweep that does not mention the member must NOT drop its latch —
    // isActionableFleetObservation filters members out transiently, and pruning
    // on absence would hand back the very re-fire this rule exists to stop.
    detectFleetTransitions(new Map(), [], { deadLatch: latch, nowMs: 2 * 60_000 });
    expect(latch.size).toBe(1);
    // Past the TTL it is dropped, capping the worst case at one notice per day.
    detectFleetTransitions(new Map(), [], { deadLatch: latch, nowMs: 25 * 60 * 60 * 1000 });
    expect(latch.size).toBe(0);
  });

  it('latches per (fleet, agent) — one member going quiet never suppresses another', () => {
    const latch = new Map<string, FleetDeadLatchEntry>();
    const first = detectFleetTransitions(
      indexObservations([
        member({ agentId: 'su-a', sessionState: 'live' }),
        member({ agentId: 'su-b', sessionState: 'live' }),
      ]),
      [member({ agentId: 'su-a', sessionState: 'ended' }), member({ agentId: 'su-b', sessionState: 'live' })],
      { deadLatch: latch, nowMs: 0 },
    );
    expect(first).toHaveLength(1);
    const second = detectFleetTransitions(
      indexObservations([
        member({ agentId: 'su-a', sessionState: 'ended' }),
        member({ agentId: 'su-b', sessionState: 'live' }),
      ]),
      [member({ agentId: 'su-a', sessionState: 'ended' }), member({ agentId: 'su-b', sessionState: 'ended' })],
      { deadLatch: latch, nowMs: 60_000 },
    );
    expect(second).toHaveLength(1);
    expect(second[0].agentId).toBe('su-b');
  });
});
