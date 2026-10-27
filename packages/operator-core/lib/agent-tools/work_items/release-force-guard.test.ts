/**
 * release-force-guard.test.ts — WI-4198 authority/liveness legs, deps injected.
 * The classifiers (classifyAgentPane / classifyFleetControlInvoker) run REAL —
 * they are pure — so these tests pin the actual authority semantics, including
 * the deliberate "an su pane is NOT authority over a live peer claim" decision
 * (the incident actor was an su pane leading its OWN fleet).
 */
import { describe, expect, it } from 'vitest';
import {
  assessCriticalClaimProgressLease,
  assessForceRelease,
  CRITICAL_CLAIM_PROGRESS_LEASE_MS,
  forceRefusalHint,
  OWNER_FORCE_DIRECTIVE_MAX_AGE_MS,
  verifyOwnerForceDirective,
  WARM_IDLE_ACTIVITY_STALE_MS,
  type ForceReleaseDeps,
  type OwnerForceDirectiveRow,
} from './release-force-guard';

const NOW = Date.parse('2026-07-11T20:00:00Z');
const min = (n: number) => 60_000 * n;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const base = { callerOwnerId: 'su-caller', holderOwnerId: 'su-holder', workspaceId: 'ws1' };
const expiredReclaimRequest = {
  by: 'su-caller',
  holder: 'su-holder',
  reason: 'holder did not respond',
  onSilence: 'reclaim' as const,
  deadlineAt: NOW - min(1),
  requestedAt: NOW - min(2),
  resolved: false,
  resolution: null,
  resolvedAt: null,
};

describe('P-008 critical-claim progress lease', () => {
  it('expires from item progress alone even when the holder may be active elsewhere', () => {
    const verdict = assessCriticalClaimProgressLease({
      takenAt: iso(min(90)),
      lastProgressAt: iso(CRITICAL_CLAIM_PROGRESS_LEASE_MS + min(1)),
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({
      expired: true,
      ageMs: CRITICAL_CLAIM_PROGRESS_LEASE_MS + min(1),
      leaseMs: CRITICAL_CLAIM_PROGRESS_LEASE_MS,
    });
  });

  it('uses fresh item progress as the renewal even when takenAt is old', () => {
    const verdict = assessCriticalClaimProgressLease({
      takenAt: iso(min(180)),
      lastProgressAt: iso(min(2)),
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({ expired: false, ageMs: min(2) });
  });

  it('anchors a new claim at takenAt until its first progress checkpoint', () => {
    const verdict = assessCriticalClaimProgressLease({
      takenAt: iso(min(3)),
      lastProgressAt: null,
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({ expired: false, ageMs: min(3) });
  });

  it('renews a reclaimed item at takenAt when prior progress belongs to the old claim', () => {
    const takenAt = iso(min(3));
    const verdict = assessCriticalClaimProgressLease({
      takenAt,
      lastProgressAt: iso(CRITICAL_CLAIM_PROGRESS_LEASE_MS + min(1)),
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({
      expired: false,
      anchorMs: Date.parse(takenAt),
      ageMs: min(3),
    });
  });

  it('fails closed when neither progress nor claim time is readable', () => {
    expect(
      assessCriticalClaimProgressLease({ takenAt: null, lastProgressAt: null, nowMs: NOW }),
    ).toMatchObject({ expired: false, anchorMs: null, ageMs: null });
  });
});

type Pres = { heartbeatAt: string; lastActiveAt: string | null; agentRole: string | null };
const deps = (over: {
  holder?: Pres | null;
  caller?: Pres | null;
  holderFleet?: string | null;
  leader?: string | null;
  recordedEnded?: boolean;
  shutdownAccepted?: boolean;
  lastToolInvocationAt?: string | null;
  /** EI-18907586326157984: the shared liveness oracle's verdict for the holder.
   *  Defaults to `null` (no oracle signal — the pre-fix behavior every OTHER test
   *  here relies on) unless a test explicitly exercises the new oracle leg. */
  oracleSessionState?: 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded' | null;
  oracleWakeAttemptMiss?: boolean | null;
}): ForceReleaseDeps => ({
  now: () => NOW,
  getPresence: async (o) => (o === 'su-holder' ? (over.holder ?? null) : (over.caller ?? null)),
  getLastToolInvocationAt: async () => over.lastToolInvocationAt ?? null,
  latestFleetMembership: async () =>
    over.holderFleet === undefined ? null : { fleetSlug: over.holderFleet, fleetRole: 'member' },
  getFleet: async () => (over.leader === undefined ? null : { leaderOwnerId: over.leader }),
  endedRecordedOwnerIds: async (owners) =>
    over.recordedEnded ? new Set(owners.filter((owner) => owner === 'su-holder')) : new Set(),
  shutdownAcceptedOwnerIds: async (owners) =>
    over.shutdownAccepted ? new Set(owners.filter((owner) => owner === 'su-holder')) : new Set(),
  resolveHolderSessionState: async () => {
    if (over.oracleWakeAttemptMiss !== undefined) {
      return {
        sessionState: over.oracleSessionState ?? null,
        wakeAttemptMiss: over.oracleWakeAttemptMiss === true,
      } as never;
    }
    return over.oracleSessionState ?? null;
  },
});

describe('assessForceRelease — liveness leg (a)', () => {
  it('no presence + no progress → holder-not-live (the reaper case)', async () => {
    const v = await assessForceRelease({ ...base, itemLastProgressAt: null }, deps({}));
    expect(v).toMatchObject({ allowed: true, basis: 'holder-not-live' });
    expect(v.holderLiveness).toMatchObject({ presenceFound: false, live: false, freshestAgeMs: null });
  });

  it('stale presence (heartbeat 11min) + old progress → holder-not-live, freshest signal reported', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(30)) },
      deps({ holder: { heartbeatAt: iso(min(11)), lastActiveAt: iso(min(25)), agentRole: 'su' } }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-not-live' });
    expect(v.holderLiveness.live).toBe(false);
    expect(v.holderLiveness.freshestAgeMs).toBe(min(11));
  });

  it('recent ITEM progress alone keeps the claim live even when presence is gone (no silent grab mid-handover)', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(2)) },
      deps({ caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'worker' } }),
    );
    expect(v.holderLiveness.live).toBe(true);
    expect(v.allowed).toBe(false); // worker pane, no fleet authority
  });

  it('authoritative recorded end overrides warm presence and recent progress after teardown', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(1)) },
      deps({
        holder: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'su' },
        recordedEnded: true,
      }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-not-live' });
    expect(v.holderLiveness).toMatchObject({
      presenceFound: true,
      recordedEnded: true,
      live: false,
      freshestAgeMs: 0,
    });
  });

  it('parses PG-format timestamps (space separator, 2-digit offset)', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: '2026-07-11 15:58:41.614276-04' }, // 19:58:41Z — 79s before NOW
      deps({ caller: { heartbeatAt: iso(0), lastActiveAt: null, agentRole: 'worker' } }),
    );
    expect(v.holderLiveness.live).toBe(true);
  });

  it('EI-18712366018708650: fresh heartbeat ALONE with hours-stale real activity → warm-idle, force allowed', async () => {
    // The concrete evidence shape: heartbeat 44s old, lastActiveAt ~2h51m old,
    // itemLastProgressAt ~3h old — a bare max-of-three used to certify "live".
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(180)) },
      deps({ holder: { heartbeatAt: iso(44_000), lastActiveAt: iso(min(171)), agentRole: 'su' } }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-warm-idle' });
    expect(v.holderLiveness).toMatchObject({ live: false, warmIdle: true });
    // freshestAgeMs still reports the heartbeat's true age — the divergence is visible,
    // not hidden, even though the verdict is no longer "live".
    expect(v.holderLiveness.freshestAgeMs).toBe(44_000);
  });

  it('EI-22949563449232791: stale lastActiveAt + NULL item progress → warm-idle, force allowed', async () => {
    // A newly claimed item can have no checkpoint yet. Once the holder's real
    // activity signal is stale, that absence must not make its claim unreclaimable.
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({ holder: { heartbeatAt: iso(44_000), lastActiveAt: iso(min(171)), agentRole: 'su' } }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-warm-idle' });
    expect(v.holderLiveness).toMatchObject({ live: false, warmIdle: true, itemLastProgressAt: null });
  });

  it('EI-21377805080867612: a fresh tool invocation vetoes warm-idle during a long Codex polling turn', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(180)), releaseRequest: expiredReclaimRequest },
      deps({
        holder: { heartbeatAt: iso(44_000), lastActiveAt: iso(min(171)), agentRole: 'su' },
        lastToolInvocationAt: iso(min(1)),
        oracleSessionState: 'live',
      }),
    );

    expect(v.allowed).toBe(false);
    expect(v.holderLiveness).toMatchObject({
      live: true,
      warmIdle: false,
      lastToolInvocationAt: iso(min(1)),
      freshestAgeMs: 44_000,
    });
  });

  it.each(['parked', 'recorded'] as const)(
    'EI-21458682859181510: expired announced reclaim overrides background activity once the oracle is %s',
    async (oracleSessionState) => {
      const v = await assessForceRelease(
        { ...base, itemLastProgressAt: iso(min(180)), releaseRequest: expiredReclaimRequest },
        deps({
          holder: { heartbeatAt: iso(10_000), lastActiveAt: iso(min(171)), agentRole: 'su' },
          lastToolInvocationAt: iso(10_000),
          oracleSessionState,
        }),
      );

      expect(v).toMatchObject({ allowed: true, basis: 'announced-release-request-expired' });
      expect(v.holderLiveness).toMatchObject({ live: true, oracleSessionState });
    },
  );

  it('EI-23831380926942341: post-request item progress prevents the parked-session reclaim override', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(90_000), releaseRequest: expiredReclaimRequest },
      deps({
        holder: { heartbeatAt: iso(10_000), lastActiveAt: iso(10_000), agentRole: 'su' },
        lastToolInvocationAt: iso(10_000),
        oracleSessionState: 'parked',
      }),
    );

    expect(v.allowed).toBe(false);
    expect(v.holderLiveness).toMatchObject({ live: true, oracleSessionState: 'parked' });
  });

  it('expired authority is bound to the original requester and holder', async () => {
    const v = await assessForceRelease(
      {
        ...base,
        callerOwnerId: 'different-requester',
        itemLastProgressAt: iso(min(180)),
        releaseRequest: expiredReclaimRequest,
      },
      deps({
        holder: { heartbeatAt: iso(10_000), lastActiveAt: iso(min(171)), agentRole: 'su' },
        lastToolInvocationAt: iso(10_000),
        oracleSessionState: 'recorded',
      }),
    );

    expect(v.allowed).toBe(false);
  });

  it('warm-idle threshold is exclusive on the near side: just under WARM_IDLE_ACTIVITY_STALE_MS stays live', async () => {
    const justUnder = WARM_IDLE_ACTIVITY_STALE_MS - 1_000;
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(justUnder) },
      deps({ holder: { heartbeatAt: iso(0), lastActiveAt: iso(justUnder), agentRole: 'su' } }),
    );
    expect(v.holderLiveness).toMatchObject({ live: true, warmIdle: false });
    expect(v.allowed).toBe(false); // still a live claim, no authority over it
  });

  it('fresh heartbeat + ONLY ONE stale activity signal (the other missing) never demotes to warm-idle', async () => {
    // lastActiveAt is null (never inferred as stale from missing data) even though
    // itemLastProgressAt is ancient — must NOT warm-idle on partial evidence.
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(180)) },
      deps({ holder: { heartbeatAt: iso(0), lastActiveAt: null, agentRole: 'su' } }),
    );
    expect(v.holderLiveness).toMatchObject({ live: true, warmIdle: false });
    expect(v.allowed).toBe(false);
  });

  it('warm-idle demotion never fires when the heartbeat itself is already stale (existing reaper path unaffected)', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(200)) },
      deps({ holder: { heartbeatAt: iso(min(11)), lastActiveAt: iso(min(200)), agentRole: 'su' } }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-not-live' });
    expect(v.holderLiveness.warmIdle).toBe(false); // demoted via plain staleness, not the warm-idle path
  });
});

/**
 * EI-18907586326157984: the shared sessionState oracle leg. A holder can look
 * "live" by the raw heartbeat/activity heuristic above (heartbeat fresh, well
 * under both PRESENCE_STALE_MS and WARM_IDLE_ACTIVITY_STALE_MS) while the SAME
 * oracle coord:wake trusts has already, independently, and much faster proven
 * the session dead (its `wakeable` + `liveTurn` legs detect a clean end in
 * seconds — see liveness-oracle.ts/presence-wakeability.ts). Either signal now
 * authorizes a reclaim; the oracle can only ever WIDEN what force allows, never
 * narrow it (a null/degraded oracle read behaves exactly like before this fix).
 */
describe('assessForceRelease — oracle leg (EI-18907586326157984)', () => {
  // The exact repro shape: heartbeat only ~4.8min old (well under every raw-heartbeat
  // threshold this guard has), yet the shared oracle says `ended` — the divergence
  // between coord:wake (recipient_dead) and the old release force-auth (live:true).
  const freshHeartbeatHolder: Pres = { heartbeatAt: iso(289_679), lastActiveAt: iso(289_679), agentRole: 'su' };

  it('oracle sessionState=ended overrides a fresh-looking heartbeat → holder-session-ended, force allowed', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({ holder: freshHeartbeatHolder, oracleSessionState: 'ended' }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-session-ended' });
    expect(v.holderLiveness).toMatchObject({ live: false, warmIdle: false, oracleSessionState: 'ended' });
  });

  it('oracle sessionState=suspect (confirmed-dead process, claims still held) also authorizes a reclaim', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({ holder: freshHeartbeatHolder, oracleSessionState: 'suspect' }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-session-ended' });
    expect(v.holderLiveness.oracleSessionState).toBe('suspect');
  });

  it.each(['live', 'parked', 'draining', 'recorded'] as const)(
    'oracle sessionState=%s does NOT override a genuinely-live-looking holder (still needs authority)',
    async (state) => {
      const v = await assessForceRelease(
        { ...base, itemLastProgressAt: null },
        deps({ holder: freshHeartbeatHolder, oracleSessionState: state }),
      );
      expect(v.holderLiveness).toMatchObject({ live: true, oracleSessionState: state });
      expect(v.allowed).toBe(false); // worker pane, no authority — still refused, just not on liveness
    },
  );

  it('a degraded/absent oracle read (null) never flips a live-looking holder to not-live', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({ holder: freshHeartbeatHolder, oracleSessionState: null }),
    );
    expect(v.holderLiveness).toMatchObject({ live: true, oracleSessionState: null });
  });

  it('EI-21216592915615709: terminal wake after recent pre-wake activity with no pickup authorizes reclaim', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({
        holder: freshHeartbeatHolder,
        oracleSessionState: 'live',
        oracleWakeAttemptMiss: true,
      }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'holder-wake-missed' });
    expect(v.holderLiveness).toMatchObject({
      live: false,
      oracleSessionState: 'live',
      oracleWakeAttemptMiss: true,
    });
  });

  it('EI-21216592915615709: post-attempt activity preserves live-holder authority', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({
        holder: freshHeartbeatHolder,
        oracleSessionState: 'live',
        oracleWakeAttemptMiss: false,
      }),
    );
    expect(v).toMatchObject({ allowed: false });
    expect(v.holderLiveness).toMatchObject({
      live: true,
      oracleSessionState: 'live',
      oracleWakeAttemptMiss: false,
    });
  });

  it('the two liveness legs are independent: a genuinely dead-by-heartbeat holder still reports basis holder-not-live even if the oracle disagrees (degraded to null here)', async () => {
    const v = await assessForceRelease({ ...base, itemLastProgressAt: null }, deps({}));
    expect(v).toMatchObject({ allowed: true, basis: 'holder-not-live' });
    expect(v.holderLiveness.oracleSessionState).toBeNull();
  });

  it('recurrence guard: mirrors coord:wake\'s recipient_dead verdict — a holder the oracle calls ended is NEVER refused force_unauthorized on liveness grounds, regardless of caller authority', async () => {
    // A bare worker pane, no fleet leadership, no queen role — the WEAKEST possible
    // authority — must still succeed once the oracle says the holder is ended,
    // because liveness (not authority) is what gates the reaper path.
    const v = await assessForceRelease(
      { callerOwnerId: 'su-nobody', holderOwnerId: 'su-holder', workspaceId: 'ws1', itemLastProgressAt: null },
      deps({
        holder: freshHeartbeatHolder,
        caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'worker' },
        oracleSessionState: 'ended',
      }),
    );
    expect(v.allowed).toBe(true);
    expect(v.basis).not.toBe(undefined);
  });
});

describe('assessForceRelease — accepted shutdown leg (EI-21266145962856513)', () => {
  it('accepted session:end overrides a fresh loop heartbeat', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({
        holder: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'su' },
        shutdownAccepted: true,
      }),
    );
    expect(v).toMatchObject({
      allowed: true,
      basis: 'holder-shutdown-accepted',
      holderLiveness: { live: false, shutdownAccepted: true },
    });
  });

  it('a missing accepted-shutdown marker never weakens the existing live-holder guard', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({ holder: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'su' } }),
    );
    expect(v).toMatchObject({ allowed: false, holderLiveness: { live: true, shutdownAccepted: false } });
  });
});

describe('assessForceRelease — authority legs (b)/(c) over a LIVE holder', () => {
  const liveHolder: Pres = { heartbeatAt: iso(min(1)), lastActiveAt: iso(min(1)), agentRole: 'su' };

  it("caller leading the HOLDER's fleet → leads-holder-fleet", async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({
        holder: liveHolder,
        caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'worker' },
        holderFleet: 'drain-f1',
        leader: 'su-caller',
      }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'leads-holder-fleet' });
  });

  it('queen pane (mug role) → queen, no fleet needed', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({ holder: liveHolder, caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'mug' } }),
    );
    expect(v).toMatchObject({ allowed: true, basis: 'queen' });
  });

  it('WI-4198 incident shape: su pane leading its OWN fleet, holder fleetless → REFUSED', async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: iso(min(1)) },
      deps({
        holder: liveHolder,
        caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'su' },
        holderFleet: null, // holder is in no fleet — caller cannot possibly lead it
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.holderLiveness.live).toBe(true);
  });

  it("leader of a DIFFERENT fleet than the holder's → REFUSED", async () => {
    const v = await assessForceRelease(
      { ...base, itemLastProgressAt: null },
      deps({
        holder: liveHolder,
        caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'worker' },
        holderFleet: 'other-fleet',
        leader: 'su-someone-else',
      }),
    );
    expect(v.allowed).toBe(false);
  });
});

describe('forceRefusalHint', () => {
  it('names all three authorizing legs so the caller coordinates instead of retrying', () => {
    const h = forceRefusalHint('su-holder');
    expect(h).toMatch(/stale/i);
    expect(h).toMatch(/warm-idle/i);
    expect(h).toMatch(/queen/i);
    expect(h).toMatch(/fleet/i);
    expect(h).toMatch(/coord:send/);
  });
});

// EI-23701433507513915: a holder stored as its SHORT-FORM id (`su-851c1a7a`) must be judged as
// the agent it names. Looked up verbatim, the short string has no presence row, no fleet and no
// session: a LIVE holder read as dead and was reclaimable, while its own fleet leader was not.
describe('assessForceRelease — short-form stored holder (EI-23701433507513915)', () => {
  const liveHolder: Pres = { heartbeatAt: iso(min(1)), lastActiveAt: iso(min(1)), agentRole: 'su' };
  const shortHolder = { ...base, holderOwnerId: 'su-851c1a7a', itemLastProgressAt: null };
  const canonical: ForceReleaseDeps['resolveHolderOwnerId'] = async (stored) =>
    stored === 'su-851c1a7a' ? 'su-holder' : stored;

  it('judges liveness by the canonical holder: a LIVE holder behind a short id is NOT reclaimable', async () => {
    const v = await assessForceRelease(shortHolder, { ...deps({ holder: liveHolder }), resolveHolderOwnerId: canonical });
    expect(v.allowed).toBe(false);
    expect(v.holderLiveness).toMatchObject({ live: true });
  });

  it("authorizes the leader of the canonical holder's fleet", async () => {
    const v = await assessForceRelease(shortHolder, {
      ...deps({
        holder: liveHolder,
        caller: { heartbeatAt: iso(0), lastActiveAt: iso(0), agentRole: 'worker' },
        leader: 'su-caller',
      }),
      latestFleetMembership: async (_ws, owner) =>
        owner === 'su-holder' ? { fleetSlug: 'drain-f1', fleetRole: 'member' } : null,
      resolveHolderOwnerId: canonical,
    });
    expect(v).toMatchObject({ allowed: true, basis: 'leads-holder-fleet' });
  });
});

describe('verifyOwnerForceDirective (WI-6554700010029971)', () => {
  const directive = (over: Partial<OwnerForceDirectiveRow> = {}): OwnerForceDirectiveRow => ({
    id: 2494,
    workspaceId: 'ws1',
    recordedBy: 'su-caller',
    verbatimText: 'JUST TAKE THE GATE   and any other work they had',
    createdAtMs: NOW - min(5),
    dispositionedAtMs: null,
    capturedByHook: true,
    ...over,
  });
  const verify = (row: OwnerForceDirectiveRow | null, callerOwnerId = 'su-caller') =>
    verifyOwnerForceDirective(
      { directiveId: 2494, callerOwnerId, workspaceId: 'ws1' },
      { getDirective: async () => row, now: () => NOW },
    );

  it('accepts an open, hook-captured directive addressed to the caller and returns a normalized excerpt', async () => {
    await expect(verify(directive())).resolves.toEqual({
      ok: true,
      directiveId: 2494,
      excerpt: 'JUST TAKE THE GATE and any other work they had',
    });
  });

  it.each([
    ['missing', null, 'not found'],
    ['another workspace', directive({ workspaceId: 'ws2' }), 'not found'],
    ['agent-recorded via orders:record', directive({ capturedByHook: false }), 'agent-recorded'],
    ['addressed to another session', directive({ recordedBy: 'su-other' }), 'addressed to su-other'],
    ['already closed', directive({ dispositionedAtMs: NOW - min(1) }), 'already closed'],
    ['too old', directive({ createdAtMs: NOW - OWNER_FORCE_DIRECTIVE_MAX_AGE_MS - 1 }), 'older than'],
  ])('refuses a directive that is %s', async (_label, row, reason) => {
    const v = await verify(row);
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.reason).toContain(reason);
  });

  it('fails closed when the directive read throws', async () => {
    const v = await verifyOwnerForceDirective(
      { directiveId: 7, callerOwnerId: 'su-caller', workspaceId: 'ws1' },
      { getDirective: async () => { throw new Error('pg down'); }, now: () => NOW },
    );
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining('could not be read') });
  });

  it('the live-holder refusal hint teaches the directiveRef path', () => {
    expect(forceRefusalHint('su-holder')).toContain('directiveRef');
  });
});
