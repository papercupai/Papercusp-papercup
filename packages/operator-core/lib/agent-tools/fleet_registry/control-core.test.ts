/**
 * control-core tests (coord-authority-hardening-2026-07-11 P-009 / H4):
 * fleet:wind-down / resume / pause's shared engine — invoker guard (owner /
 * that fleet's leader / queen), typed registry persist, fleet-scoped cue to
 * the live member set. Store / presence / messages / audience are mocked
 * WHOLESALE (the DB-free unit surface); classifyAgentPane runs real (pure).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { COORD_ACK_ACCEPTED_KEYS, coordAckArgNamesIn } from '../coordination/tools/ack-keys';

const callerRef = { ownerId: 'su-4c85f9d7-aaaa-bbbb-cccc-ddddeeee0001' };

vi.mock('./_shared', () => ({
  ROUTING_LADDER: 'test routing ladder',
  resolveFleetCaller: vi.fn((ctx: { uiClientId?: string; workspaceId?: string } = {}) => {
    const ownerId = ctx.uiClientId ?? callerRef.ownerId;
    return {
      identity: { ownerId },
      ownerId,
      workspaceId: ctx.workspaceId ?? 'ws-1',
    };
  }),
}));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  getFleet: vi.fn(),
  setFleetControlState: vi.fn(),
}));
vi.mock('../coordination/messages', () => ({ sendMessage: vi.fn(async () => ({ msg_id: 'm-cue' })) }));
vi.mock('../coordination/presence', () => ({ getPresence: vi.fn(async () => null) }));
vi.mock('../coordination/audience-host', () => ({
  listFleetControlMembers: vi.fn(async () => [] as string[]),
  hostAudienceResolvers: { listFleetMembers: vi.fn(async () => [] as string[]) },
}));
vi.mock('../../session-brief', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-brief')>()),
  markSessionBriefReleased: vi.fn(async () => true),
  clearSessionBriefReleasedForFleet: vi.fn(async () => 0),
}));
// P-006: the drain-stamp helper hits PG (scheduler oracle) — mock it so control-core
// unit tests stay DB-free + deterministic. Default: no stamp (fails-soft path); a
// dedicated test overrides it to assert the auto-stamp augments the reason + result.
vi.mock('./drain-stamp', () => ({ buildFleetDrainStamp: vi.fn(async () => null) }));
vi.mock('./leader-control', () => ({
  retireFleetLeaderWatches: vi.fn(async () => 0),
  ensureFleetLeaderControl: vi.fn(async () => ({ healthy: true, repaired: true })),
}));
// WI-2034563: the park's resume gate is DECLARED through the await store and FIRED
// through the await engine. Both hit PG, so mock them for the DB-free unit surface —
// and mock them separately, because the two halves fail independently: a declaration
// that does not land must store no gate, and a fire that does not land must report
// members still parked rather than a clean resume.
const registerAnnouncementM = vi.fn(async (_input: unknown) => ({ id: 1, causalGeneration: 1 }));
const applyPauseHoldsM = vi.fn(async (_input: unknown) => ({ items: [], failed: [] }));
const clearPauseHoldsM = vi.fn(async (_input: unknown) => ({ items: [], failed: [] }));
const emitAwaitedEventM = vi.fn(async (_input: unknown) => ({ waiters: 2 }));
vi.mock('../../events/await/store', () => ({
  registerAnnouncement: (input: unknown) => registerAnnouncementM(input),
}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: (input: unknown) => emitAwaitedEventM(input),
}));
vi.mock('./pause-holds', () => ({
  applyFleetPauseHolds: (input: unknown) => applyPauseHoldsM(input),
  clearFleetPauseHolds: (input: unknown) => clearPauseHoldsM(input),
}));

import {
  applyFleetControl,
  classifyFleetControlInvoker,
  FLEET_CONTROL_RECONCILER,
  FLEET_CONTROL_RESPONSE_TIMEOUT_MS,
  fleetControlCueText,
  isReconciledEmptyFleet,
  windDownGoalFleet,
} from './control-core';
import windDownTool from './wind-down';
import { getFleet, setFleetControlState, type AgentFleetRecord } from '../../agent-fleets-store';
import { sendMessage } from '../coordination/messages';
import { getPresence } from '../coordination/presence';
import { hostAudienceResolvers, listFleetControlMembers } from '../coordination/audience-host';
import {
  CUE_AUTHORITY_FIELD,
  EXPECTED_LIFECYCLE_ACK_FIELD,
  expectedFleetWindDownAck,
} from '../coordination/cue-authority';
import { buildFleetDrainStamp } from './drain-stamp';
import { clearSessionBriefReleasedForFleet, markSessionBriefReleased } from '../../session-brief';
import { ensureFleetLeaderControl, retireFleetLeaderWatches } from './leader-control';
import { lintCarrySurfaceProvenance } from '../../carry-surface-provenance-lint';

const getFleetM = vi.mocked(getFleet);
const setControlM = vi.mocked(setFleetControlState);
const sendM = vi.mocked(sendMessage);
const presenceM = vi.mocked(getPresence);
const membersM = vi.mocked(listFleetControlMembers);
const deliveryMembersM = vi.mocked(hostAudienceResolvers.listFleetMembers);
const drainStampM = vi.mocked(buildFleetDrainStamp);
const markReleasedM = vi.mocked(markSessionBriefReleased);
const clearReleasedM = vi.mocked(clearSessionBriefReleasedForFleet);
const retireLeaderWatchesM = vi.mocked(retireFleetLeaderWatches);
const ensureLeaderControlM = vi.mocked(ensureFleetLeaderControl);

function fleet(over: Partial<AgentFleetRecord> = {}): AgentFleetRecord {
  return {
    workspaceId: 'ws-1',
    fleetSlug: 'backend',
    title: null,
    description: null,
    owner: null,
    leaderOwnerId: null,
    leaderMissingSinceMs: null,
    colorScheme: null,
    controlState: 'active',
    fleetType: 'single',
    controlReason: null,
    controlBy: null,
    controlAt: null,
    controlResumeGate: null,
    controlExpiresAt: null,
    controlNoResumePath: false,
    lastLaunchTransaction: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callerRef.ownerId = 'su-4c85f9d7-aaaa-bbbb-cccc-ddddeeee0001';
  presenceM.mockResolvedValue(null as never);
  sendM.mockResolvedValue({ msg_id: 'm-cue' } as never);
  membersM.mockResolvedValue([]);
    deliveryMembersM.mockResolvedValue([]);
    drainStampM.mockResolvedValue(null); // default: fails-soft, no auto-stamp
    applyPauseHoldsM.mockResolvedValue({ items: [], failed: [] });
    clearPauseHoldsM.mockResolvedValue({ items: [], failed: [] });
    markReleasedM.mockResolvedValue(true);
  clearReleasedM.mockResolvedValue(0);
  retireLeaderWatchesM.mockResolvedValue(0);
  // A fully-typed healthy outcome. Spelled out rather than cast `as never` so that a new
  // REQUIRED field on LeaderControlOutcome is a tsc error here, not a runtime surprise
  // in a file the change never touched (EI-19282401068515102).
  ensureLeaderControlM.mockResolvedValue({
    healthy: true,
    repaired: true,
    mode: { healthy: true, changed: false },
    loop: { healthy: true, changed: false, harness: null, intervalSec: null, mode: null },
    watches: {
      enabled: true,
      healthy: true,
      expected: [],
      active: [],
      added: [],
      repaired: [],
      removed: 0,
      awaitIds: [],
      cap: 16,
      capped: false,
      omitted: [],
      suppressed: [],
      wakeReachable: true,
      handleNote: null,
      cancel: null,
      flag: { fallback: false },
    },
    inboxWake: { healthy: true },
    errors: [],
  });
  // setFleetControlState echoes the applied state back (the RETURNING row).
  setControlM.mockImplementation(async (_ws, slug, control) =>
    fleet({ fleetSlug: slug, controlState: control.state, controlReason: control.reason ?? null, controlBy: control.by ?? null, controlAt: 99 }),
  );
});

describe('classifyFleetControlInvoker (pure guard)', () => {
  it('leader beats pane-kind; queen = mug/kettle; owner = su; everything else refused', () => {
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'a', paneKind: 'cup' })).toBe('leader');
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'b', paneKind: 'mug' })).toBe('queen');
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'b', paneKind: 'kettle' })).toBe('queen');
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'b', paneKind: 'su' })).toBe('owner');
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: 'b', paneKind: 'cup' })).toBeNull();
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: null, paneKind: 'papercup' })).toBeNull();
    expect(classifyFleetControlInvoker({ callerOwnerId: 'a', leaderOwnerId: null, paneKind: 'planner' })).toBeNull();
  });
});

describe('fleet:wind-down dispatch metadata (EI-21834728970912985)', () => {
  it('opts out of the ambient workspace transaction and declares idempotent completion', () => {
    expect((windDownTool as { idempotent?: boolean }).idempotent).toBe(true);
    expect((windDownTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('fleetControlCueText (pure)', () => {
  it('wind-down: binding, checkpoint-and-release, no new work until resume', () => {
    const { summary, body } = fleetControlCueText('wind-down', 'backend', 'release cut', '4c85f');
    expect(summary).toContain('WIND-DOWN');
    expect(summary).toContain('release cut');
    expect(body).toContain('BINDING');
    expect(body).toContain('[system-derived:fleet-control]');
    expect(lintCarrySurfaceProvenance(body)).toEqual({ flagged: false, matches: [] });
    expect(body).toContain('work_items:checkpoint');
    expect(body).toContain('acknowledgeOpenDirectives:true');
    expect(body).toContain('acknowledgeWakeLessAutonomy:true');
    expect(body).toContain('events:await');
    expect(body).toContain('coord:ack { msg_id }');
    expect(body).toContain('fleet:resume');
    expect(fleetControlCueText('wind-down', 'backend', null, '4c85f', 'm-cue').body).toContain(
      "coord:ack { msg_id: 'm-cue' }",
    );
  });

  // WI-2034563: the stop instruction is park-shaped. An OMITTED park means the caller
  // supplied no park information (the case asserted above) and must keep the
  // historical wording; a park that positively declares a gate, or positively
  // declares none, each say something different and neither may be the default.
  it('wind-down with a declared gate: hand over the key, do not stop wake-less', () => {
    const { body } = fleetControlCueText('wind-down', 'backend', 'release cut', '4c85f', 'm-cue', {
      gate: 'fleet:backend:resume',
      expiresAt: null,
      terminal: false,
    });
    expect(body).toContain("events:await { event: 'fleet:backend:resume' }");
    expect(body).toContain('Do NOT pass acknowledgeWakeLessAutonomy');
    expect(body).not.toContain('acknowledgeWakeLessAutonomy:true');
  });

  it('wind-down with a deadline names it, so a park is visibly bounded', () => {
    const at = Date.parse('2026-09-01T18:00:00.000Z');
    const { body } = fleetControlCueText('wind-down', 'backend', null, '4c85f', 'm-cue', {
      gate: 'fleet:backend:resume',
      expiresAt: at,
      terminal: false,
    });
    expect(body).toContain('2026-09-01T18:00:00.000Z');
  });

  it('wind-down with a park that declared NO gate warns instead of silently reading as routine', () => {
    const { body } = fleetControlCueText('wind-down', 'backend', null, '4c85f', 'm-cue', {
      gate: null,
      expiresAt: null,
      terminal: false,
    });
    expect(body).toContain('declared NO resume gate');
    // The escape hatch is still reachable — this warns, it does not wedge.
    expect(body).toContain('acknowledgeWakeLessAutonomy:true');
  });

  /**
   * EI-21329316352681219 — half 2 of the two-hop pin (half 1 lives in ack.test.ts, which
   * keeps COORD_ACK_ACCEPTED_KEYS equal to the tool's real schema).
   *
   * The cue used to read "…coord:ack { msg_id: 'X' } to send your one-line disposition to
   * the leader", attaching a free-text purpose to a receipt that carries none. A member who
   * followed it literally called coord:ack { msg_id, summary } and was refused invalid_args
   * while trying to wind down. This makes that class a BUILD failure: any argument the cue
   * names inside a coord:ack { … } snippet must be one the tool actually accepts.
   */
  it('never names a coord:ack argument the tool would reject (EI-21329316352681219)', () => {
    for (const cueMsgId of [undefined, 'm-cue']) {
      const { body } = fleetControlCueText('wind-down', 'backend', 'release cut', '4c85f', cueMsgId);
      const named = coordAckArgNamesIn(body);
      // POSITIVE CONTROL: if the parser stops finding the call at all, the subset check
      // below would pass vacuously — so require that it actually matched something.
      expect(named.length).toBeGreaterThan(0);
      for (const key of named) expect(COORD_ACK_ACCEPTED_KEYS).toContain(key);
    }
  });

  it('routes the one-line disposition to coord:send, not onto the ack (EI-21329316352681219)', () => {
    const { body } = fleetControlCueText('wind-down', 'backend', null, '4c85f', 'm-cue');
    expect(body).toContain("coord:send { expects:'none', summary:'…' }");
    expect(body).toMatch(/carries no free text/i);
    // The disposition must not be described as something the ack itself transmits.
    expect(body).not.toMatch(/coord:ack \{[^}]*\}\s*to send your one-line disposition/i);
  });

  /**
   * FALSIFIABILITY CONTROL. The two guards above pass today; that alone proves nothing
   * about whether they can FAIL. Note in particular that the subset guard would NOT have
   * caught the original defect — the pre-fix cue named only `msg_id`, and the member
   * invented `summary` from the surrounding prose — so the prose guard is the one doing
   * the real work here, and it is the one that must be shown to discriminate.
   *
   * Rather than mutate the shared tree (git-sync would happily commit the mutant), the
   * pre-fix cue body is frozen here as a permanent negative control, per the repo's
   * "keep a deliberately-wrong implementation in the test file" tier.
   */
  const PRE_FIX_CUE_BODY =
    'Fleet backend is WINDING DOWN. This is a TYPED, BINDING control cue ' +
    '[system-derived:fleet-control] (registry control_state=winding-down). ' +
    'Finish only the atomic step in hand, then: work_items:checkpoint + release your claims ' +
    '(or complete with evidence), release your file locks, loop:end any armed loop, and ack this ' +
    "exact cue with coord:ack { msg_id: 'm-cue' } " +
    'to send your one-line disposition to the leader. This lifecycle ack is recorded without ' +
    're-invoking the wound-down leader.';

  it('the guards REJECT the pre-fix cue body (negative control)', () => {
    // Each assertion the live cue satisfies must fail against the historical text —
    // otherwise the guard is decorative.
    expect(PRE_FIX_CUE_BODY).not.toContain("coord:send { expects:'none', summary:'…' }");
    expect(PRE_FIX_CUE_BODY).not.toMatch(/carries no free text/i);
    expect(PRE_FIX_CUE_BODY).not.toContain('acknowledgeWakeLessAutonomy:true');
    expect(PRE_FIX_CUE_BODY).not.toContain('acknowledgeOpenDirectives:true');
    expect(PRE_FIX_CUE_BODY).not.toContain('events:await');
    expect(PRE_FIX_CUE_BODY).toMatch(/coord:ack \{[^}]*\}\s*to send your one-line disposition/i);
  });

  it('the arg parser flags a cue that names an unaccepted arg (negative control)', () => {
    // The regression the subset guard exists for: a future edit "fixing" this by writing
    // the rejected key straight into the cue.
    const named = coordAckArgNamesIn("coord:ack { msg_id, summary }");
    expect(named).toEqual(['msg_id', 'summary']);
    expect(named.some((k) => !(COORD_ACK_ACCEPTED_KEYS as readonly string[]).includes(k))).toBe(true);
    // …and a quoted VALUE is never mistaken for an argument name.
    expect(coordAckArgNamesIn("coord:ack { msg_id: 'm-cue' }")).toEqual(['msg_id']);
  });
  it('resume: lifts the wind-down, resume the pull cadence', () => {
    const { summary, body } = fleetControlCueText('resume', 'backend', null, '4c85f');
    expect(summary).toContain('RESUMED');
    expect(body).toContain('control_state=active');
  });
});

describe('applyFleetControl', () => {
  it('recognizes only reconciler-owned winding-down fleets with no live members as terminal cleanup', () => {
    expect(
      isReconciledEmptyFleet(
        { controlState: 'winding-down', controlBy: FLEET_CONTROL_RECONCILER },
        [],
      ),
    ).toBe(true);
    expect(
      isReconciledEmptyFleet(
        { controlState: 'winding-down', controlBy: callerRef.ownerId },
        [],
      ),
    ).toBe(false);
    expect(
      isReconciledEmptyFleet(
        { controlState: 'winding-down', controlBy: FLEET_CONTROL_RECONCILER },
        ['live-member'],
      ),
    ).toBe(false);
  });

  it('the fleet LEADER winds down: typed persist + fleet-scoped cue to members (self excluded)', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
    membersM.mockResolvedValue(['m-1', 'm-2', callerRef.ownerId]);
    const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'release cut');
    expect(r).toMatchObject({
      ok: true,
      fleet: 'backend',
      controlState: 'winding-down',
      invokedAs: 'leader',
      notified: ['m-1', 'm-2'],
      cueMsgId: 'm-cue',
    });
    expect(setControlM).toHaveBeenCalledWith('ws-1', 'backend', {
      state: 'winding-down',
      reason: 'release cut',
      by: callerRef.ownerId,
      // WI-2034563: an ordinary wind-down publishes the default resume gate, so a
      // park created without thinking about it still leaves members a way back.
      resumeGate: 'fleet:backend:resume',
      expiresAt: null,
      noResumePath: false,
    }, undefined, callerRef.ownerId);
    const sendOpts = sendM.mock.calls[0][1] as unknown as Record<string, unknown>;
    expect(sendOpts.to).toEqual(['m-1', 'm-2']);
    expect(sendOpts.extra).toEqual({
      [CUE_AUTHORITY_FIELD]: {
        authority: 'fleet-leader',
        authorityRef: 'backend',
        scope: 'fleet-members',
        scopeRef: 'backend',
      },
      [EXPECTED_LIFECYCLE_ACK_FIELD]: expectedFleetWindDownAck('backend'),
      wakeOnReply: true,
    });
    const bodyWithMsgId = sendOpts.bodyWithMsgId as (msgId: string) => string;
    expect(bodyWithMsgId('m-cue')).toContain("coord:ack { msg_id: 'm-cue' }");
    expect(markReleasedM).toHaveBeenCalledTimes(2);
    expect(markReleasedM).toHaveBeenCalledWith(
      'm-1',
      'ws-1',
      expect.objectContaining({ fleet: 'backend', by: callerRef.ownerId }),
    );
    expect(retireLeaderWatchesM).toHaveBeenCalledWith(callerRef.ownerId, 'backend');
    expect(ensureLeaderControlM).not.toHaveBeenCalled();
    expect(Math.min(...markReleasedM.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...sendM.mock.invocationCallOrder),
    );
  });

  it('a terminal noResumePath park clears this fleet’s pause holds without applying new ones', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));

    await applyFleetControl({} as never, 'backend', 'wind-down', 'mission over', { noResumePath: true });

    expect(clearPauseHoldsM).toHaveBeenCalledWith({ fleetSlug: 'backend', workspaceId: 'ws-1' });
    expect(applyPauseHoldsM).not.toHaveBeenCalled();
  });

  it('a resumable wind-down still applies fleet pause holds with the pre-stamp reason', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));

    await applyFleetControl({} as never, 'backend', 'wind-down', 'release cut');

    expect(applyPauseHoldsM).toHaveBeenCalledWith({
      fleetSlug: 'backend',
      workspaceId: 'ws-1',
      byOwnerId: callerRef.ownerId,
      leaderOwnerId: callerRef.ownerId,
      reason: 'release cut',
      resumeGate: 'fleet:backend:resume',
    });
    expect(clearPauseHoldsM).not.toHaveBeenCalled();
  });

  it('uses the control roster so muted/digest members receive the binding release cue', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
    // The delivery audience would omit these members; typed control must not.
    deliveryMembersM.mockResolvedValue(['m-full']);
    membersM.mockResolvedValue(['m-muted', 'm-digest', 'm-full', callerRef.ownerId]);

    const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'release cut');

    expect(r).toMatchObject({
      ok: true,
      notified: ['m-muted', 'm-digest', 'm-full'],
    });
    expect(markReleasedM.mock.calls.map(([id]) => id)).toEqual(['m-muted', 'm-digest', 'm-full']);
    expect(deliveryMembersM).not.toHaveBeenCalled();
  });

  it('an su session invokes as OWNER (the owner-authority proxy) even when not leader', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: 'su-someone-else' }));
    presenceM.mockResolvedValue({} as never); // the registered leader is live
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: true, invokedAs: 'owner' });
  });

  it('refuses an owner control cue when the registry leader is absent', async () => {
    const registeredLeader = 'su-ended-leader';
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: registeredLeader }));
    membersM.mockResolvedValue(['m-1']);

    const r = await applyFleetControl({} as never, 'backend', 'resume', 'restart intake');

    expect(r).toMatchObject({
      ok: false,
      fleet: 'backend',
      invokedAs: 'owner',
      error: 'fleet_leader_mismatch',
    });
    expect(r.message).toContain(registeredLeader);
    expect(r.message).toContain('fleet:take-leadership');
    expect(r.message).toContain('fleet:launch-on-plan');
    expect(r.message).toContain('leader: "spawn"');
    expect(r.message).toContain('that new leader then calls fleet:resume');
    expect(presenceM).toHaveBeenCalledWith(registeredLeader);
    expect(setControlM).not.toHaveBeenCalled();
    expect(sendM).not.toHaveBeenCalled();
    expect(membersM).not.toHaveBeenCalled();
  });

  it('does not recommend takeover for reconciler-owned winding-down cleanup with no live members', async () => {
    getFleetM.mockResolvedValue(
      fleet({
        leaderOwnerId: 'su-ended-leader',
        controlState: 'winding-down',
        controlBy: FLEET_CONTROL_RECONCILER,
      }),
    );
    membersM.mockResolvedValue([]);

    const r = await applyFleetControl({} as never, 'backend', 'resume', 'owner requested resume');

    expect(r).toMatchObject({
      ok: false,
      fleet: 'backend',
      error: 'fleet_reconciled_terminal',
    });
    expect(r.message).toContain('No takeover was performed');
    expect(r.message).not.toContain('fleet:take-leadership');
    expect(setControlM).not.toHaveBeenCalled();
    expect(sendM).not.toHaveBeenCalled();
  });

  it('keeps takeover guidance when a reconciler-owned fleet still has a live member', async () => {
    getFleetM.mockResolvedValue(
      fleet({
        leaderOwnerId: 'su-ended-leader',
        controlState: 'winding-down',
        controlBy: FLEET_CONTROL_RECONCILER,
      }),
    );
    membersM.mockResolvedValue(['live-member']);

    const r = await applyFleetControl({} as never, 'backend', 'resume', 'owner requested resume');

    expect(r).toMatchObject({ ok: false, error: 'fleet_leader_mismatch' });
    expect(r.message).toContain('fleet:take-leadership');
  });

  it('refuses a stale leader control write when leadership changed after authorization', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
    setControlM.mockResolvedValueOnce(null);
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: false, error: 'fleet_leadership_superseded' });
    expect(sendM).not.toHaveBeenCalled();
  });

  it('a mug (queen) invokes as QUEEN', async () => {
    callerRef.ownerId = 's-172000-queen'; // not su-prefixed — kind comes from the role
    presenceM.mockImplementation(async (ownerId) =>
      (ownerId === callerRef.ownerId ? { agentRole: 'mug' } : {}) as never,
    );
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: 'su-someone-else' }));
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: true, invokedAs: 'queen' });
  });

  it('REFUSES a non-leader cup (the EI-9501 class) — nothing persisted, nothing sent', async () => {
    callerRef.ownerId = 's-172000-bee7';
    presenceM.mockResolvedValue({ agentRole: 'worker' } as never);
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: 'su-someone-else' }));
    const r = await applyFleetControl({} as never, 'backend', 'wind-down');
    expect(r).toMatchObject({ ok: false, error: 'not_authorized' });
    expect(r.message).toContain('EI-9501');
    expect(setControlM).not.toHaveBeenCalled();
    expect(sendM).not.toHaveBeenCalled();
  });

  it('unknown fleet → fleet_not_found', async () => {
    getFleetM.mockResolvedValue(null);
    const r = await applyFleetControl({} as never, 'nope', 'wind-down');
    expect(r).toMatchObject({ ok: false, error: 'fleet_not_found' });
  });

  it('already in the requested state: refresh persisted, NO duplicate cue', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId, controlState: 'winding-down' }));
    membersM.mockResolvedValue(['m-1']);
    const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'still winding');
    expect(r).toMatchObject({ ok: true, alreadyInState: true, notified: [] });
    expect(setControlM).toHaveBeenCalledTimes(1); // reason/by/at refresh
    expect(sendM).not.toHaveBeenCalled();
  });

  it('resume flips back to active with the resume cue', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId, controlState: 'winding-down' }));
    membersM.mockResolvedValue(['m-1']);
    const r = await applyFleetControl({} as never, 'backend', 'resume', 'incident cleared');
    expect(r).toMatchObject({ ok: true, controlState: 'active', notified: ['m-1'] });
    expect(setControlM).toHaveBeenCalledWith('ws-1', 'backend', {
      state: 'active',
      reason: 'incident cleared',
      by: callerRef.ownerId,
      // A resume clears the park's columns: an ACTIVE row must never carry a dead
      // park's gate for a later reader to mistake for a live one.
      resumeGate: null,
      expiresAt: null,
      noResumePath: false,
    }, undefined, callerRef.ownerId);
    expect((sendM.mock.calls[0][1] as { summary: string }).summary).toContain('RESUMED');
    const resumeExtra = (sendM.mock.calls[0][1] as { extra?: Record<string, unknown> }).extra;
    expect(resumeExtra?.[EXPECTED_LIFECYCLE_ACK_FIELD]).toBeUndefined();
    expect(resumeExtra?.wakeOnReply).toBeUndefined();
    expect(clearReleasedM).toHaveBeenCalledWith('ws-1', 'backend');
    expect(ensureLeaderControlM).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      ownerId: callerRef.ownerId,
      fleetSlug: 'backend',
    }));
  });

  it('a cue-leg failure never fails the state flip (registry is the source of truth)', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
    membersM.mockRejectedValue(new Error('presence down'));
    // This test DELIBERATELY fails the optional member/cue leg, and withBoundedTimeout
    // is supposed to announce that degradation on console.warn. vitest-fail-on-console
    // turns any unclaimed warn into a failure, so the warn has to be claimed here —
    // and claiming it by asserting the message is strictly better than silencing it:
    // the degradation signal is part of the contract this test is pinning (the flip
    // still succeeds AND the operator is told the cue leg fell back).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await applyFleetControl({} as never, 'backend', 'wind-down');
      expect(r).toMatchObject({ ok: true, controlState: 'winding-down', notified: [], cueMsgId: null });
      expect(warn.mock.calls.flat().join(' ')).toContain('fleet:wind-down:members');
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts a human fleet NAME (slugified like every registry surface)', async () => {
    getFleetM.mockResolvedValue(fleet({ fleetSlug: 'backend-team', leaderOwnerId: callerRef.ownerId }));
    await applyFleetControl({} as never, 'Backend Team', 'wind-down');
    expect(getFleetM).toHaveBeenCalledWith('ws-1', 'backend-team');
  });

  it('goal-owned wind-down reuses typed state, release, cue, and leader-watch retirement without the public invoker guard', async () => {
    getFleetM.mockResolvedValue(fleet({ leaderOwnerId: 'su-goal-agent' }));
    membersM.mockResolvedValue(['su-goal-agent', 'm-1']);

    const r = await windDownGoalFleet({
      workspaceId: 'ws-1',
      fleetSlug: 'backend',
      goalId: 'goal-1',
      status: 'killed',
      actor: 'su-stopper',
    });

    expect(r).toMatchObject({ ok: true, fleet: 'backend', controlState: 'winding-down' });
    expect(setControlM).toHaveBeenCalledWith(
      'ws-1',
      'backend',
      {
        state: 'winding-down',
        reason: 'goal goal-1 reached killed — standing drain fleet wind-down',
        by: 'su-stopper',
        // WI-2034563: a terminal goal is not coming back, so this park is TERMINAL —
        // no gate is published and members' wake-less loop:end stays authorized.
        resumeGate: null,
        expiresAt: null,
        noResumePath: true,
      },
      undefined,
      'su-goal-agent',
    );
    expect((sendM.mock.calls[0][1] as { to: string[] }).to).toEqual(['su-goal-agent', 'm-1']);
    expect(retireLeaderWatchesM).toHaveBeenCalledWith('su-goal-agent', 'backend');
  });

  describe('P-006 auto-drain stamp', () => {
    const STAMP = {
      harness: 'papercusp',
      breakdown: {
        matchedByFilter: 302,
        claimable: 0,
        affinityCoverage: { denominator: 0, nonEmptyPaths: 0, floor: 0.5, belowFloor: false },
        excluded: {
          taken: 0,
          claimHold: 33,
          needsOwnerAction: 80,
          agentReview: 0,
          observationLane: 21,
          externalBlocker: 0,
          planLaneReserved: 0,
          federationDetector: 169,
          loopNoise: 0,
          alreadyCompleted: 0,
          crossMachineRig: 0,
          blockedDep: 0,
          cooldown: 0,
          remoteOrigin: 0,
          admissionPending: 0,
          liveGateOps: 0,
          stopTheLine: 0,
          watchdogRecovery: 0,
        },
        queueControl: {
          activeClaims: 0,
          rawClaimHolds: 0,
          holdOpenLeases: 0,
          durableParks: 0,
          unattributedClaimHolds: 0,
          pendingAgentReview: 0,
          revisionRequestedAgentReview: 0,
          revisionReproductionValidation: 0,
          revisionContentAdoptionCandidates: 0,
          revisionLegacyException: 0,
        },
      },
      spec: { specId: 'bug-drain', revision: 4, source: 'cup' as const },
      summary:
        "[auto-drain-stamp 2026-07-21T00:00:00.000Z · spec bug-drain@4] 302 in-lane issue-family row(s) matched the fleet spec's filter; stranded by: federationDetector=169, needsOwnerAction=80. Re-verify against the authoritative oracle (no hand-rolled SQL): scheduler:get_next { harness: 'papercusp' }.",
      reVerifyCommand: "scheduler:get_next { harness: 'papercusp' }",
    };

    it('winds down: the live scheduler-oracle breakdown auto-stamps the reason + rides the result & cue', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      membersM.mockResolvedValue(['m-1']);
      drainStampM.mockResolvedValue(STAMP);
      const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'plans shipped', {
        harness: 'papercusp',
      });
      // 6e647f5111 took the stamp read OFF the receipt's critical path: the state
      // boundary is persisted FIRST with the caller's bare reason, and the stamp is
      // folded in by a SECOND, optional refresh write. So the augmented reason lands
      // on the LAST setControl call, not the first — assert both legs, because the
      // split IS the guarantee (a slow scheduler-oracle must not delay the flip).
      const [, , firstPersist] = setControlM.mock.calls[0];
      expect(firstPersist.reason).toBe('plans shipped');
      // caller's reason PREPENDED, the auto-stamp APPENDED — both durable on the row.
      const persisted = setControlM.mock.calls[setControlM.mock.calls.length - 1][2];
      expect(persisted.reason).toBe(`plans shipped | ${STAMP.summary}`);
      expect(applyPauseHoldsM).toHaveBeenCalledWith(expect.objectContaining({ reason: 'plans shipped' }));
      // structured stamp rides the result for the immediate caller.
      expect(r.drainStamp).toEqual(STAMP);
      // the member cue body carries the augmented reason (successor sees it at orient too).
      const cueOpts = sendM.mock.calls[0][1] as { bodyWithMsgId: (msgId: string) => string };
      const cueBody = cueOpts.bodyWithMsgId('m-cue');
      expect(cueBody).toContain(STAMP.reVerifyCommand);
      // the helper was fed the caller's harness first, then the session harness as fallback.
      expect(drainStampM).toHaveBeenCalledWith(
        expect.objectContaining({ fleetSlug: 'backend', harnessCandidates: ['papercusp', undefined] }),
      );
    });

    it('no explicit reason: the stamp becomes the whole reason', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      drainStampM.mockResolvedValue(STAMP);
      await applyFleetControl({} as never, 'backend', 'wind-down');
      // Same split as above: the flip persists a bare (here undefined) reason first,
      // then the optional refresh writes the stamp as the whole reason.
      expect(setControlM.mock.calls[setControlM.mock.calls.length - 1][2].reason).toBe(STAMP.summary);
    });

    it('RESUME never computes a drain stamp (wind-down-only)', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId, controlState: 'winding-down' }));
      await applyFleetControl({} as never, 'backend', 'resume', 'lane refilled');
      expect(drainStampM).not.toHaveBeenCalled();
      expect(setControlM.mock.calls[0][2].reason).toBe('lane refilled');
    });

    it('a stamp failure (null) leaves the bare reason untouched — never blocks the flip', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      drainStampM.mockResolvedValue(null);
      const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'just because');
      expect(setControlM.mock.calls[0][2].reason).toBe('just because');
      expect(r.drainStamp).toBeUndefined();
    });
  });

  // ── WI-2034563 / P-008: the park directive's resume path ──────────────────
  // The incident these cover: a wind-down published no key, members were told to
  // end their loops, and ~23 of 45 sat unreachable for 2.5-6h with claims held.
  describe('park resume path (WI-2034563)', () => {
    it('declares the default gate, scoped to the fleet, and reports it', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'release cut');
      expect(registerAnnouncementM).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: 'fleet:backend:resume',
          scopeKind: 'fleet',
          scopeRef: 'backend',
          logicalGateKey: 'fleet-park-resume:backend',
        }),
      );
      expect(r.resumePath).toMatchObject({ gate: 'fleet:backend:resume', declared: true, terminal: false });
    });

    it('scopes a leader-named gate rather than trusting a bare name on the flat key plane', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      await applyFleetControl({} as never, 'backend', 'wind-down', 'phase break', {
        resumeGate: 'phase3-open',
      });
      expect(registerAnnouncementM.mock.calls[0][0]).toMatchObject({ eventKey: 'fleet:backend:phase3-open' });
    });

    it('resumeWithinSec bounds BOTH the registry deadline and the declaration lapse', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      const before = Date.now();
      const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'short pause', {
        resumeWithinSec: 1800,
      });
      const persisted = setControlM.mock.calls[0][2];
      expect(persisted.expiresAt).toBeGreaterThanOrEqual(before + 1800 * 1000);
      // An abandoned park must not leave a standing declaration behind it.
      const declared = registerAnnouncementM.mock.calls[0][0] as { expiresSec: number | null };
      expect(declared.expiresSec).toBeGreaterThan(0);
      expect(declared.expiresSec).toBeLessThanOrEqual(1800);
      expect(r.resumePath?.expiresAt).toBe(persisted.expiresAt);
    });

    it('noResumePath declares NO gate and records the park terminal', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'mission over', {
        noResumePath: true,
      });
      expect(registerAnnouncementM).not.toHaveBeenCalled();
      expect(setControlM.mock.calls[0][2]).toMatchObject({ resumeGate: null, noResumePath: true });
      expect(r.resumePath).toMatchObject({ gate: null, terminal: true });
    });

    it('a failed declaration stores NO gate and warns — never a phantom key on the row', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      registerAnnouncementM.mockRejectedValueOnce(new Error('pg down'));
      const r = await applyFleetControl({} as never, 'backend', 'wind-down', 'release cut');
      // The row must never advertise a key with no announcement behind it: an
      // undeclared key does not latch, so a member registering late would miss the fire.
      expect(setControlM.mock.calls[0][2].resumeGate).toBeNull();
      expect(r.resumePath).toMatchObject({ gate: null, declared: false });
      expect(r.resumePath?.warning).toContain('fleet:backend:resume');
    });

    it('the wind-down cue hands over the exact key to await INSTEAD of a wake-less stop', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      membersM.mockResolvedValue(['m-1']);
      await applyFleetControl({} as never, 'backend', 'wind-down', 'release cut');
      const body = (sendM.mock.calls[0][1] as { bodyWithMsgId: (m: string) => string }).bodyWithMsgId('m-cue');
      expect(body).toContain("events:await { event: 'fleet:backend:resume' }");
      // The old text ended at acknowledgeWakeLessAutonomy, which is precisely how the
      // members stranded themselves while complying.
      expect(body).toContain('Do NOT pass acknowledgeWakeLessAutonomy');
    });

    it('a TERMINAL park still tells members a wake-less stop is correct', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId }));
      membersM.mockResolvedValue(['m-1']);
      await applyFleetControl({} as never, 'backend', 'wind-down', 'mission over', { noResumePath: true });
      const body = (sendM.mock.calls[0][1] as { bodyWithMsgId: (m: string) => string }).bodyWithMsgId('m-cue');
      expect(body).toContain('TERMINAL');
      expect(body).toContain('acknowledgeWakeLessAutonomy');
    });

    it('RESUME fires the gate the park declared and reports how many were waiting', async () => {
      getFleetM.mockResolvedValue(
        fleet({
          leaderOwnerId: callerRef.ownerId,
          controlState: 'winding-down',
          controlResumeGate: 'fleet:backend:resume',
        }),
      );
      const r = await applyFleetControl({} as never, 'backend', 'resume', 'incident cleared');
      // A resume CUE only reaches live listeners; the members this exists for ended
      // their loops and parked on the key, so only the emit can reach them.
      expect(emitAwaitedEventM).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'fleet:backend:resume' }),
      );
      expect(r.resumePath).toMatchObject({ gate: 'fleet:backend:resume', fired: true, waiters: 2 });
    });

    it('idempotent RESUME fires a stale declared gate even when the row is already active', async () => {
      getFleetM.mockResolvedValue(
        fleet({
          leaderOwnerId: callerRef.ownerId,
          controlState: 'active',
          controlResumeGate: 'fleet:backend:resume',
        }),
      );
      const r = await applyFleetControl({} as never, 'backend', 'resume', 'owner pause lifted');

      expect(r).toMatchObject({
        ok: true,
        controlState: 'active',
        alreadyInState: true,
        notified: [],
        resumePath: { gate: 'fleet:backend:resume', fired: true, waiters: 2 },
      });
      expect(emitAwaitedEventM).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'fleet:backend:resume' }),
      );
      expect(sendM).not.toHaveBeenCalled();
      expect(setControlM).toHaveBeenCalledWith('ws-1', 'backend', expect.objectContaining({
        state: 'active',
        resumeGate: null,
        noResumePath: false,
      }), undefined, callerRef.ownerId);
    });

    it('a resume whose gate fire fails reports members possibly still parked', async () => {
      getFleetM.mockResolvedValue(
        fleet({
          leaderOwnerId: callerRef.ownerId,
          controlState: 'winding-down',
          controlResumeGate: 'fleet:backend:resume',
        }),
      );
      emitAwaitedEventM.mockRejectedValueOnce(new Error('emit failed'));
      // withBoundedTimeout logs the degraded leg; that log IS the expected behaviour
      // here, so assert it is silenced deliberately rather than letting the
      // fail-on-console guard read a covered failure path as an unexpected warning.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = await applyFleetControl({} as never, 'backend', 'resume', 'incident cleared');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      expect(r.ok).toBe(false); // a resume is not successful while parked members may remain asleep
      expect(r.error).toBe('resume_gate_not_confirmed');
      expect(r.controlState).toBe('active'); // the durable state boundary remains the source of truth
      expect(setControlM).toHaveBeenCalledTimes(1);
      expect(r.resumePath).toMatchObject({ gate: 'fleet:backend:resume', fired: false });
      expect(r.resumePath?.warning).toContain('were NOT woken');
    });

    it('confirms the gate before a slow post-saga can exhaust the receipt budget', async () => {
      getFleetM.mockResolvedValue(
        fleet({
          leaderOwnerId: callerRef.ownerId,
          controlState: 'winding-down',
          controlResumeGate: 'fleet:backend:resume',
        }),
      );
      let resolveHolds!: (value: { items: never[]; failed: never[] }) => void;
      const holdsStarted = new Promise<void>((resolve) => {
        clearPauseHoldsM.mockImplementation(
          () =>
            new Promise<{ items: never[]; failed: never[] }>((resolveResult) => {
              resolveHolds = resolveResult;
              resolve();
            }),
        );
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        const pending = applyFleetControl({} as never, 'backend', 'resume', 'incident cleared');
        await holdsStarted;
        // The gate is the receipt-critical leg and must have completed before the
        // first optional post-saga leg begins, even though the saga itself is now
        // deliberately wedged past the outer five-second response budget.
        expect(emitAwaitedEventM).toHaveBeenCalledWith(
          expect.objectContaining({ key: 'fleet:backend:resume' }),
        );
        expect(
          Math.min(...emitAwaitedEventM.mock.invocationCallOrder),
        ).toBeLessThan(Math.min(...clearPauseHoldsM.mock.invocationCallOrder));
        expect(
          Math.min(...setControlM.mock.invocationCallOrder),
        ).toBeLessThan(Math.min(...emitAwaitedEventM.mock.invocationCallOrder));

        await vi.advanceTimersByTimeAsync(FLEET_CONTROL_RESPONSE_TIMEOUT_MS + 1);
        const r = await pending;
        expect(r).toMatchObject({
          ok: true,
          controlState: 'active',
          postControlPending: true,
          postControlDegraded: true,
          resumePath: { gate: 'fleet:backend:resume', fired: true, waiters: 2 },
        });

        resolveHolds({ items: [], failed: [] });
        await Promise.resolve();
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });

    it('a resume on a legacy park (no declared gate) fires nothing and claims nothing', async () => {
      getFleetM.mockResolvedValue(fleet({ leaderOwnerId: callerRef.ownerId, controlState: 'winding-down' }));
      const r = await applyFleetControl({} as never, 'backend', 'resume', 'lane refilled');
      expect(emitAwaitedEventM).not.toHaveBeenCalled();
      expect(r.resumePath).toBeUndefined();
    });
  });
});
