/**
 * Tests for silent-halt-reconcile (WI-35718).
 *
 * The load-bearing test in this file is INCIDENT ANCHOR (the fifth term). Everything else guards
 * an exemption; that one guards the difference between a detector and a 4,037-page metronome.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  countPendingWakeSources,
  evaluateSilentHalt,
  silentHaltWakeBody,
  sweepSilentHalts,
  disarmEpochToken,
  wakeMarkerSummary,
  SILENT_HALT_MIN_STALE_MS,
  SILENT_HALT_HEARTBEAT_FRESH_MS,
  SILENT_HALT_MAX_PAGES_PER_SWEEP,
  SILENT_HALT_MAX_WAKES_PER_SWEEP,
  type SilentHaltCandidate,
  type SilentHaltSweepDeps,
  type SilentHaltWakeMarker,
} from './silent-halt-reconcile';
import { resolveFleetParkResumePath } from '../../fleet-park-resume-path';
import { broadcastSevereEvent } from '../../severe-event-broadcast';
import { resolveAlarm } from '../../alarm-attention';
import type { StalledLoopHostClass } from '../../events/await/host-recovery-eligibility';

// Never publish synthetic halt conditions to the shared fleet.
vi.mock('../../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('../../alarm-attention', () => ({ resolveAlarm: vi.fn(async () => true) }));

// Keep the real attention helper and DEFAULT sweep adapter. Only isolate the durable
// store and external channels; injecting deps.notify hid the production return loss.
const attention = vi.hoisted(() => ({
  ensureIntent: vi.fn(),
  claimChannel: vi.fn(),
  recordIntent: vi.fn(),
  recordOutcome: vi.fn(),
  mobile: vi.fn(),
  desktop: vi.fn(),
}));
vi.mock('../../attention-notify-store', () => ({
  ensureAttentionNotifyIntent: attention.ensureIntent,
  claimAttentionNotifyChannel: attention.claimChannel,
  recordAttentionNotifyIntent: attention.recordIntent,
  recordAttentionNotifyOutcome: attention.recordOutcome,
}));
vi.mock('../../device-push-dispatcher', () => ({ notifyWorkspace: attention.mobile }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: attention.desktop }));

// The default host reader (D-006 (2)) discovers live psu hosts on disk. Tests that call
// sweepSilentHalts without injecting readHostClass must never read the real ~/.papercusp/psu-pty.
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/await/psu-pty-discovery')>()),
  findLiveHostAsync: vi.fn(async () => null),
  readHostEventTailAsync: vi.fn(async () => []),
}));

const MIN = 60 * 1000;

/** A genuinely halted session: alive, autonomous, loop off, no wake source, long silent. */
function haltedInput(over: Partial<Parameters<typeof evaluateSilentHalt>[0]> = {}) {
  return {
    loopActive: false,
    hasPosture: true,
    pendingAwaits: 0,
    heartbeatAgeMs: 30 * 1000,
    lastRealTurnAgeMs: 120 * MIN,
    inactiveForMs: 120 * MIN,
    intervalSec: 60,
    heldWorkItems: 1,
    ...over,
  };
}

describe('evaluateSilentHalt', () => {
  it('flags the real thing: alive process, autonomy posture, loop off, no await, no recent turn', () => {
    const v = evaluateSilentHalt(haltedInput());
    expect(v.halted).toBe(true);
    expect(v.exemption).toBeNull();
    expect(v.reason).toMatch(/loop INACTIVE/);
  });

  it('INCIDENT ANCHOR (2026-09-01) — a session with NO presence row is GONE, not halted', () => {
    // THE FIFTH TERM, and the reason this module is not a metronome. Measured live before this
    // file existed: the conjunction WI-35718 specifies (posture + inactive loop + no pending
    // await) selects 4,037 rows in this workspace, of which 4,091 candidates have no presence
    // row at all — a cleanly-ended session leaves a mode row beside an inactive loop FOREVER,
    // and that residue is indistinguishable from a halt without liveness. Adding the presence
    // join collapsed 4,037 -> 67. If this test ever fails, the sweep has reverted to paging the
    // owner about every session that ever ended.
    const v = evaluateSilentHalt(haltedInput({ heartbeatAgeMs: null }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/no-presence-row/);
  });

  it('BOUNDARY (unguarded-halt-rescue) — a load-0 halt is NOT ours; that module wakes it', () => {
    // unguarded-halt-rescue-action.ts (2026-07-26) targets exactly the load-0 population and
    // WAKES it, which beats bothering a human. Double-reporting it here would be noise. This
    // test is the seam between the two modules: if it ever fails, they have started overlapping.
    const v = evaluateSilentHalt(haltedInput({ heldWorkItems: 0 }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/holds-no-work/);
  });

  it('held work is what JUSTIFIES the page — the strand is real either way', () => {
    // The one case that survives the abandoned-vs-halted ambiguity without resolving it: a
    // heartbeat-fresh owner is not reclaimed by the dead-owner reaper, and a session taking no
    // turns will not advance the item, so it is stuck whichever the agent turns out to be.
    expect(evaluateSilentHalt(haltedInput({ heldWorkItems: 2 })).halted).toBe(true);
  });

  it('active typed external-blocker holds alone do not justify a silent-halt page (D-010/P-010)', () => {
    const v = evaluateSilentHalt(haltedInput({
      heldWorkItems: 0,
      blockerParkedWorkItemIds: ['WI-CREDENTIAL'],
    }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toContain('holds-only-active-external-blockers');
    expect(v.exemption).toContain('WI-CREDENTIAL');
  });

  it('a blocker park with NO re-check time names no wake: a WAKE-ONLY halt (WI-6554700010018551)', () => {
    const v = evaluateSilentHalt(haltedInput({
      heldWorkItems: 0,
      blockerParkedWorkItemIds: ['WI-BOUNDED', 'WI-LEGACY'],
      unboundedBlockerParkedWorkItemIds: ['WI-LEGACY'],
    }));
    expect(v.halted).toBe(true);
    expect(v.wakeOnly).toBe(true);
    expect(v.exemption).toBeNull();
    expect(v.reason).toContain('blocker names no wake (no re-check time): WI-LEGACY');
    expect(v.reason).not.toContain('actionable held work item(s)');
  });

  it('a wake-only park still respects every earlier exemption and both clocks', () => {
    const park = { heldWorkItems: 0, unboundedBlockerParkedWorkItemIds: ['WI-LEGACY'] };
    expect(evaluateSilentHalt(haltedInput({ ...park, pendingAwaits: 1 })).exemption).toMatch(/pending-await/);
    expect(evaluateSilentHalt(haltedInput({ ...park, loopActive: true })).exemption).toMatch(/loop-armed/);
    expect(evaluateSilentHalt(haltedInput({ ...park, hasPosture: false })).exemption).toMatch(/no-autonomy-posture/);
    expect(evaluateSilentHalt(haltedInput({ ...park, lastRealTurnAgeMs: 5 * MIN })).exemption).toMatch(/recent-turn/);
  });

  it('actionable held work keeps the PAGEABLE verdict even beside an unbounded park', () => {
    const v = evaluateSilentHalt(haltedInput({
      heldWorkItems: 1,
      blockerParkedWorkItemIds: ['WI-LEGACY'],
      unboundedBlockerParkedWorkItemIds: ['WI-LEGACY'],
    }));
    expect(v.halted).toBe(true);
    expect(v.wakeOnly).toBe(false);
    expect(v.reason).toContain('1 actionable held work item');
    expect(v.reason).toContain('active external-blocker parks excluded: WI-LEGACY (no re-check time: WI-LEGACY)');
  });

  it('still pages on actionable held work and names coexisting blocker-parked IDs', () => {
    const v = evaluateSilentHalt(haltedInput({
      heldWorkItems: 1,
      blockerParkedWorkItemIds: ['WI-CREDENTIAL'],
    }));
    expect(v.halted).toBe(true);
    expect(v.reason).toContain('1 actionable held work item');
    expect(v.reason).toContain('WI-CREDENTIAL');
  });

  it('a stale heartbeat means the process is gone, not halted', () => {
    const v = evaluateSilentHalt(haltedInput({ heartbeatAgeMs: SILENT_HALT_HEARTBEAT_FRESH_MS + MIN }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/heartbeat-stale/);
  });

  it('a pending await IS a wake source — the 67 -> 3 collapse', () => {
    // 63 of 67 live candidates were exempt here at authoring time. This term, not liveness, is
    // what separates a WAITING agent from a halted one.
    const v = evaluateSilentHalt(haltedInput({ pendingAwaits: 1 }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/pending-await/);
  });

  it('an ARMED loop belongs to stalled-loops-guard, never this module', () => {
    const v = evaluateSilentHalt(haltedInput({ loopActive: true }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/loop-armed/);
  });

  it('a session with no autonomy posture has a human in front of it', () => {
    const v = evaluateSilentHalt(haltedInput({ hasPosture: false }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/no-autonomy-posture/);
  });

  it('does not page a loop disarmed seconds ago — most disarms self-heal', () => {
    const v = evaluateSilentHalt(haltedInput({ inactiveForMs: 2 * MIN }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/recently-disarmed/);
  });

  it('does not page an agent that produced a turn inside the floor', () => {
    const v = evaluateSilentHalt(haltedInput({ lastRealTurnAgeMs: 2 * MIN }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/recent-turn/);
  });

  it('fails quiet when nothing establishes DURATION (no turn ever, no disarm timestamp)', () => {
    // Without a clock there is no evidence of a HALT as opposed to a session that has not
    // started yet, and an assertion the data cannot support must not become a page.
    const v = evaluateSilentHalt(haltedInput({ lastRealTurnAgeMs: null, inactiveForMs: null }));
    expect(v.halted).toBe(false);
    expect(v.exemption).toMatch(/no-duration-evidence/);
  });

  it('still flags a halt when the agent never produced a turn but the disarm clock is old', () => {
    const v = evaluateSilentHalt(haltedInput({ lastRealTurnAgeMs: null, inactiveForMs: 200 * MIN }));
    expect(v.halted).toBe(true);
    expect(v.reason).toMatch(/no real turn ever recorded/);
  });

  it('scales the staleness floor with the loop interval, never below the 30m floor', () => {
    // A 60s loop: 5 intervals = 5m, so the 30m floor binds.
    expect(evaluateSilentHalt(haltedInput({ intervalSec: 60 })).staleFloorMs).toBe(SILENT_HALT_MIN_STALE_MS);
    // A 1h loop: 5 intervals = 5h, which now binds instead.
    const slow = evaluateSilentHalt(haltedInput({ intervalSec: 3600, inactiveForMs: 60 * MIN, lastRealTurnAgeMs: 60 * MIN }));
    expect(slow.staleFloorMs).toBe(5 * 3600 * 1000);
    expect(slow.halted).toBe(false); // 60m is inside a 5h floor
  });
});

/** Build a sweep whose PG reads are stubbed, so the conjunction is exercised without a database. */
function sweepHarness(
  candidates: SilentHaltCandidate[],
  statuses: Record<string, { active: boolean; lastRealTurnAt: string | null }>,
  opts: {
    nowMs?: number;
    notify?: ReturnType<typeof vi.fn>;
    dryRun?: boolean;
    /** Legacy tests exercise the page path; the P-003 wake-first rung is opt-in per test. */
    wakeFirstEnabled?: boolean;
    markers?: SilentHaltWakeMarker[] | (() => Promise<readonly SilentHaltWakeMarker[]>);
    sendWakeMessage?: ReturnType<typeof vi.fn>;
    fireWake?: ReturnType<typeof vi.fn>;
    readFleetParkPath?: SilentHaltSweepDeps['readFleetParkPath'];
    /** Engine-loop residue fed to the end classifier; default = never armed (⇒ 'abnormal'). */
    readEngineLoopRows?: SilentHaltSweepDeps['readEngineLoopRows'];
    /** D-006 (2) host class per owner; default = unreadable (null), i.e. today's wake-first. */
    readHostClass?: SilentHaltSweepDeps['readHostClass'];
    alertFleetLeader?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const nowMs = opts.nowMs ?? Date.now();
  const notify = opts.notify ?? vi.fn(async () => {});
  const sendWakeMessage =
    opts.sendWakeMessage ?? vi.fn(async (_owner: string, _summary: string, _body: string) => {});
  const fireWake = opts.fireWake ?? vi.fn(async (_owner: string, _summary: string, _ws: string) => {});
  const markers = opts.markers;
  const readWakeMarkers: SilentHaltSweepDeps['readWakeMarkers'] =
    typeof markers === 'function' ? markers : async () => markers ?? [];
  const alertFleetLeader =
    opts.alertFleetLeader ?? vi.fn(async (_slug: string, _summary: string, _body: string, _ws: string) => {});
  return {
    notify,
    sendWakeMessage,
    fireWake,
    alertFleetLeader,
    run: () =>
      sweepSilentHalts({
        workspaceId: 'ws',
        dryRun: opts.dryRun,
        sql: {} as never,
        deps: {
          nowMs,
          readCandidates: async () => candidates,
          readLoopStatuses: (async () => new Map(Object.entries(statuses))) as never,
          notify: notify as unknown as SilentHaltSweepDeps['notify'],
          wakeFirstEnabled: opts.wakeFirstEnabled ?? false,
          readWakeMarkers,
          sendWakeMessage: sendWakeMessage as unknown as SilentHaltSweepDeps['sendWakeMessage'],
          fireWake: fireWake as unknown as SilentHaltSweepDeps['fireWake'],
          readEngineLoopRows: opts.readEngineLoopRows ?? ((async () => ({})) as never),
          readFleetParkPath: opts.readFleetParkPath ?? (async () => null),
          readHostClass: opts.readHostClass ?? (async () => null),
          alertFleetLeader: alertFleetLeader as unknown as SilentHaltSweepDeps['alertFleetLeader'],
        },
      }),
  };
}

function candidate(over: Partial<SilentHaltCandidate> = {}): SilentHaltCandidate {
  return {
    ownerId: 'su-halted',
    workspaceId: 'ws',
    routineId: 'rt_loop_su_halted',
    intervalSec: 60,
    heartbeatAgeMs: 30 * 1000,
    inactiveForMs: 120 * MIN,
    pendingAwaits: 0,
    heldWorkItems: 1,
    modes: [{ mode: 'auto' }],
    ...over,
  };
}

describe('silent-halt wake guidance', () => {
  it('checks checkpoint gates before resuming or releasing held work', () => {
    const body = silentHaltWakeBody(
      candidate(),
      { halted: true, reason: 'held work with no wake source', exemption: null, staleFloorMs: 30 * MIN },
      null,
    );

    expect(body).toContain('governing decision');
    expect(body).toContain('Preserve any named evidence gate or explicit stop');
    expect(body).toContain('this alarm does not prove the gate cleared');
    expect(body).toContain('only when that named condition permits it');
  });
});

describe('sweepSilentHalts', () => {
  const now = Date.parse('2026-09-01T07:00:00.000Z');
  const oldTurn = new Date(now - 120 * MIN).toISOString();

  it('pages the OWNER once for a halted session, with a dedupeKey', async () => {
    const h = sweepHarness([candidate()], { 'su-halted': { active: false, lastRealTurnAt: oldTurn } }, { nowMs: now });
    const r = await h.run();

    expect(r.halted).toEqual(['su-halted']);
    expect(r.paged).toEqual(['su-halted']);
    expect(h.notify).toHaveBeenCalledOnce();
    const payload = h.notify.mock.calls[0][0];
    expect(payload.importance).toBe('urgent');
    expect(payload.dedupeKey).toMatch(/^silent-halt:su-halted:/);
    expect(payload.workspaceId).toBe('ws');
  });

  it('keys the dedupeKey to the DISARM EPOCH, so a still-halted session never re-pages', async () => {
    // The item's central complaint: claim-discipline-watch fired hourly for four days. Two
    // sweeps 10 minutes apart over the same unchanged halt must produce the SAME key, so the
    // second is deduped by attention-notify rather than becoming a second page.
    const first = sweepHarness([candidate()], { 'su-halted': { active: false, lastRealTurnAt: oldTurn } }, { nowMs: now });
    await first.run();
    const later = now + 10 * MIN;
    const second = sweepHarness(
      [candidate({ inactiveForMs: 130 * MIN })], // same disarm instant, 10 minutes more elapsed
      { 'su-halted': { active: false, lastRealTurnAt: oldTurn } },
      { nowMs: later },
    );
    await second.run();

    expect(second.notify.mock.calls[0][0].dedupeKey).toBe(first.notify.mock.calls[0][0].dedupeKey);
  });

  it('a re-armed loop between the two round-trips is NOT paged', async () => {
    // The candidate query and the status read are separate round-trips. An agent that re-armed
    // in between is healthy, and paging it would be a false alarm sourced purely from our own
    // read skew.
    const h = sweepHarness([candidate()], { 'su-halted': { active: true, lastRealTurnAt: oldTurn } }, { nowMs: now });
    const r = await h.run();

    expect(r.halted).toEqual([]);
    expect(r.exempt['su-halted']).toMatch(/loop-armed/);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('names an exemption for every spared candidate — a mute sweep is unexplainable', async () => {
    const h = sweepHarness(
      [candidate({ ownerId: 'a', pendingAwaits: 2 }), candidate({ ownerId: 'b', heartbeatAgeMs: null })],
      { a: { active: false, lastRealTurnAt: oldTurn }, b: { active: false, lastRealTurnAt: oldTurn } },
      { nowMs: now },
    );
    const r = await h.run();

    expect(r.halted).toEqual([]);
    expect(r.exempt.a).toMatch(/pending-await/);
    expect(r.exempt.b).toMatch(/no-presence-row/);
  });

  it('dry_run detects without paging', async () => {
    const h = sweepHarness(
      [candidate()],
      { 'su-halted': { active: false, lastRealTurnAt: oldTurn } },
      { nowMs: now, dryRun: true },
    );
    const r = await h.run();

    expect(r.halted).toEqual(['su-halted']);
    expect(r.paged).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('caps pages on a mass halt — a cluster is ONE incident, not N', async () => {
    const many = Array.from({ length: SILENT_HALT_MAX_PAGES_PER_SWEEP + 3 }, (_, i) =>
      candidate({ ownerId: `su-${i}`, routineId: `rt_${i}` }),
    );
    const statuses = Object.fromEntries(many.map((c) => [c.ownerId, { active: false, lastRealTurnAt: oldTurn }]));
    const h = sweepHarness(many, statuses, { nowMs: now });
    const r = await h.run();

    expect(r.halted).toHaveLength(SILENT_HALT_MAX_PAGES_PER_SWEEP + 3);
    expect(r.paged).toHaveLength(SILENT_HALT_MAX_PAGES_PER_SWEEP);
    expect(r.pageCapReached).toBe(true);
  });

  it('a downed push transport does not throw away the remaining pages, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notify = vi.fn(async (p: { data?: Record<string, unknown> }) => {
        if (p.data?.ownerId === 'a') throw new Error('push transport down');
      });
      const h = sweepHarness(
        [candidate({ ownerId: 'a' }), candidate({ ownerId: 'b' })],
        { a: { active: false, lastRealTurnAt: oldTurn }, b: { active: false, lastRealTurnAt: oldTurn } },
        { nowMs: now, notify: notify as never },
      );
      const r = await h.run();

      expect(r.halted).toEqual(['a', 'b']);
      expect(r.paged).toEqual(['b']); // 'a' failed, 'b' still delivered
      // A swallowed failure must still be VISIBLE: a page that silently never arrived is
      // indistinguishable from no halt, which is the failure this whole module is about.
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/owner page failed for a/));
    } finally {
      warn.mockRestore();
    }
  });

  it('an empty candidate set does no status read and pages nobody', async () => {
    const notify = vi.fn(async () => {});
    const r = await sweepSilentHalts({
      workspaceId: 'ws',
      sql: {} as never,
      deps: {
        readCandidates: async () => [],
        readLoopStatuses: (() => {
          throw new Error('must not be called for an empty candidate set');
        }) as never,
        notify,
      },
    });

    expect(r.checked).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('survives a failed loop-status read by sweeping without turn evidence', async () => {
    // The disarm clock alone still establishes duration, so a status outage degrades the verdict
    // rather than silencing the detector entirely.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notify = vi.fn(async () => {});
      const r = await sweepSilentHalts({
        workspaceId: 'ws',
        sql: {} as never,
        deps: {
          nowMs: now,
          readCandidates: async () => [candidate()],
          readLoopStatuses: (async () => {
            throw new Error('pg down');
          }) as never,
          notify,
        },
      });

      expect(r.halted).toEqual(['su-halted']);
      expect(notify).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/loop-status read failed/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('sweepSilentHalts — wake-first rung (P-003)', () => {
  const now = Date.parse('2026-09-01T07:00:00.000Z');
  const oldTurn = new Date(now - 120 * MIN).toISOString();
  const halted = { 'su-halted': { active: false, lastRealTurnAt: oldTurn } };

  it('first tick: WAKES the halted holder instead of paging — marker written before the wake fires', async () => {
    const h = sweepHarness([candidate()], halted, { nowMs: now, wakeFirstEnabled: true });
    const r = await h.run();

    expect(r.woken).toEqual(['su-halted']);
    expect(r.paged).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.sendWakeMessage).toHaveBeenCalledOnce();
    const [owner, summary, body] = h.sendWakeMessage.mock.calls[0];
    expect(owner).toBe('su-halted');
    expect(summary).toBe(wakeMarkerSummary('su-halted', disarmEpochToken(now, 120 * MIN)));
    expect(body).toMatch(/HOLDING 1 actionable work-item/);
    expect(body).toMatch(/next sweep tick pages the human owner/);
    expect(h.fireWake).toHaveBeenCalledOnce();
    // Restart-safety ordering: the durable marker strictly precedes the wake fire.
    expect(h.sendWakeMessage.mock.invocationCallOrder[0]).toBeLessThan(
      h.fireWake.mock.invocationCallOrder[0],
    );
  });

  it('second tick: a marker for the SAME disarm epoch pages with the wake evidence', async () => {
    const later = now + 10 * MIN;
    const c = candidate({ inactiveForMs: 130 * MIN }); // same disarm instant, 10 minutes later
    const marker: SilentHaltWakeMarker = {
      to: ['su-halted'],
      summary: wakeMarkerSummary('su-halted', disarmEpochToken(later, 130 * MIN)),
      ts: new Date(now).toISOString(),
    };
    const h = sweepHarness([c], halted, { nowMs: later, wakeFirstEnabled: true, markers: [marker] });
    const r = await h.run();

    expect(r.woken).toEqual([]);
    expect(h.sendWakeMessage).not.toHaveBeenCalled();
    expect(r.paged).toEqual(['su-halted']);
    const payload = h.notify.mock.calls[0][0];
    expect(payload.body).toMatch(/wake was already attempted/);
    expect(payload.body).toMatch(/produced no real turn/);
    expect(payload.data.wakeAttemptedAt).toBe(marker.ts);
    expect(payload.data.endClassification).toBe('abnormal');
  });

  it("a marker from an OLDER disarm epoch does not spend the new epoch's wake", async () => {
    const stale: SilentHaltWakeMarker = {
      to: ['su-halted'],
      summary: wakeMarkerSummary('su-halted', disarmEpochToken(now, 500 * MIN)),
      ts: new Date(now - 500 * MIN).toISOString(),
    };
    const h = sweepHarness([candidate()], halted, { nowMs: now, wakeFirstEnabled: true, markers: [stale] });
    const r = await h.run();

    expect(r.woken).toEqual(['su-halted']);
    expect(r.paged).toEqual([]);
  });

  describe('WAKE-ONLY halts: a blocker park that names no wake (WI-6554700010018551)', () => {
    const wakeOnlyCandidate = (over: Partial<SilentHaltCandidate> = {}) =>
      candidate({
        heldWorkItems: 0,
        blockerParkedWorkItemIds: ['WI-LEGACY'],
        unboundedBlockerParkedWorkItemIds: ['WI-LEGACY'],
        ...over,
      });
    const relaunch: StalledLoopHostClass = {
      kind: 'needs-relaunch',
      condition: 'unbound-successor' as never,
      why: 'the carry-respawn child never bound a native session.',
      remedy: 'Relaunch the session (psu --resume).',
    };

    it('wakes the holder with name-your-wake guidance and raises no owner-facing condition', async () => {
      vi.mocked(broadcastSevereEvent).mockClear();
      vi.mocked(resolveAlarm).mockClear();
      const h = sweepHarness([wakeOnlyCandidate()], halted, { nowMs: now, wakeFirstEnabled: true });
      const r = await h.run();

      expect(r.halted).toEqual(['su-halted']);
      expect(r.wakeOnly).toEqual(['su-halted']);
      expect(r.woken).toEqual(['su-halted']);
      expect(r.paged).toEqual([]);
      expect(h.notify).not.toHaveBeenCalled();
      expect(broadcastSevereEvent).not.toHaveBeenCalled();
      // Nothing pageable is halted, so the aggregate condition is resolved, not refreshed.
      expect(resolveAlarm).toHaveBeenCalledWith('alarm:silent-halt:ws', 'silent-halt-reconcile');
      const body = h.sendWakeMessage.mock.calls[0][2] as string;
      expect(body).toContain('blocker names no wake: WI-LEGACY');
      expect(body).toContain('work_items:set_blocker');
      expect(body).toMatch(/does not\s+page the human owner/);
      expect(body).not.toMatch(/next sweep tick pages/);
    });

    it('a spent wake for this epoch is never followed by a page', async () => {
      const marker: SilentHaltWakeMarker = {
        to: ['su-halted'],
        summary: wakeMarkerSummary('su-halted', disarmEpochToken(now, 120 * MIN)),
        ts: new Date(now - 10 * MIN).toISOString(),
      };
      const h = sweepHarness([wakeOnlyCandidate()], halted, { nowMs: now, wakeFirstEnabled: true, markers: [marker] });
      const r = await h.run();

      expect(r.wakeOnly).toEqual(['su-halted']);
      expect(r.woken).toEqual([]);
      expect(r.paged).toEqual([]);
      expect(h.notify).not.toHaveBeenCalled();
    });

    it('with the wake rung off, or a host that needs a relaunch, it still never pages', async () => {
      for (const opts of [
        { wakeFirstEnabled: false },
        { wakeFirstEnabled: true, readHostClass: async () => relaunch },
      ]) {
        const h = sweepHarness([wakeOnlyCandidate()], halted, { nowMs: now, ...opts });
        const r = await h.run();
        expect(r.woken).toEqual([]);
        expect(r.paged).toEqual([]);
        expect(h.notify).not.toHaveBeenCalled();
      }
    });

    it('actionable strands are woken first under the cap, and only they reach the owner condition', async () => {
      vi.mocked(broadcastSevereEvent).mockClear();
      const parked = Array.from({ length: SILENT_HALT_MAX_WAKES_PER_SWEEP }, (_, i) => `su-park-${i}`);
      const owners = [...parked, 'su-actionable'];
      const h = sweepHarness(
        [...parked.map((ownerId) => wakeOnlyCandidate({ ownerId })), candidate({ ownerId: 'su-actionable' })],
        Object.fromEntries(owners.map((o) => [o, { active: false, lastRealTurnAt: oldTurn }])),
        { nowMs: now, wakeFirstEnabled: true },
      );
      const r = await h.run();

      expect(r.halted).toHaveLength(owners.length);
      expect(r.wakeOnly).toEqual(parked);
      expect(r.wakeCapReached).toBe(true);
      expect(r.woken).toHaveLength(SILENT_HALT_MAX_WAKES_PER_SWEEP);
      expect(r.woken[0]).toBe('su-actionable');
      expect(r.paged).toEqual([]);
      const event = vi.mocked(broadcastSevereEvent).mock.calls[0][0] as { summary: string; body: string };
      expect(event.summary).toBe('1 autonomous session(s) silently halted while holding work');
      expect(event.body).not.toContain('su-park-');
    });
  });

  it('wake produced a turn but the session re-halted in the SAME epoch: the page says so', async () => {
    const marker: SilentHaltWakeMarker = {
      to: ['su-halted'],
      summary: wakeMarkerSummary('su-halted', disarmEpochToken(now, 120 * MIN)),
      ts: new Date(now - 60 * MIN).toISOString(),
    };
    const h = sweepHarness(
      [candidate()],
      { 'su-halted': { active: false, lastRealTurnAt: new Date(now - 40 * MIN).toISOString() } },
      { nowMs: now, wakeFirstEnabled: true, markers: [marker] },
    );
    const r = await h.run();

    expect(r.paged).toEqual(['su-halted']);
    expect(h.notify.mock.calls[0][0].body).toMatch(/a turn followed, but the session halted again/);
  });

  it('caps the wake fan and DEFERS the overflow — it never falls through to the page', async () => {
    const many = Array.from({ length: SILENT_HALT_MAX_WAKES_PER_SWEEP + 2 }, (_, i) =>
      candidate({ ownerId: `su-${i}`, routineId: `rt_${i}` }),
    );
    const statuses = Object.fromEntries(many.map((c) => [c.ownerId, { active: false, lastRealTurnAt: oldTurn }]));
    const h = sweepHarness(many, statuses, { nowMs: now, wakeFirstEnabled: true });
    const r = await h.run();

    expect(r.woken).toHaveLength(SILENT_HALT_MAX_WAKES_PER_SWEEP);
    expect(r.wakeCapReached).toBe(true);
    expect(r.paged).toEqual([]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('marker-READ failure falls back to page-only (never a re-wake storm), and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = sweepHarness([candidate()], halted, {
        nowMs: now,
        wakeFirstEnabled: true,
        markers: async () => {
          throw new Error('pg down');
        },
      });
      const r = await h.run();

      expect(r.woken).toEqual([]);
      expect(h.sendWakeMessage).not.toHaveBeenCalled();
      expect(r.paged).toEqual(['su-halted']);
      // The page must not CLAIM a wake was attempted — no marker was readable.
      expect(h.notify.mock.calls[0][0].body).not.toMatch(/wake was already attempted/);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/wake-marker read failed/));
    } finally {
      warn.mockRestore();
    }
  });

  it('marker-WRITE failure skips the wake AND the page — the next tick retries the wake', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const send = vi.fn(async () => {
        throw new Error('outbox down');
      });
      const h = sweepHarness([candidate()], halted, {
        nowMs: now,
        wakeFirstEnabled: true,
        sendWakeMessage: send as never,
      });
      const r = await h.run();

      expect(r.woken).toEqual([]);
      expect(h.fireWake).not.toHaveBeenCalled();
      expect(r.paged).toEqual([]);
      expect(h.notify).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/wake marker write for su-halted failed/));
    } finally {
      warn.mockRestore();
    }
  });

  it('flag OFF: pages immediately with no wake attempt — the pre-P-003 behavior, exactly', async () => {
    const h = sweepHarness([candidate()], halted, { nowMs: now, wakeFirstEnabled: false });
    const r = await h.run();

    expect(r.woken).toEqual([]);
    expect(h.sendWakeMessage).not.toHaveBeenCalled();
    expect(h.fireWake).not.toHaveBeenCalled();
    expect(r.paged).toEqual(['su-halted']);
  });

  it("a parked fleet's member is woken WITH its way back — the park contract, verbatim", async () => {
    const h = sweepHarness([candidate({ fleetSlug: 'f1' })], halted, {
      nowMs: now,
      wakeFirstEnabled: true,
      readFleetParkPath: async () =>
        resolveFleetParkResumePath(
          { controlState: 'winding-down', controlResumeGate: 'fleet:f1:resume' },
          now,
        ),
    });
    const r = await h.run();

    expect(r.woken).toEqual(['su-halted']);
    const body = h.sendWakeMessage.mock.calls[0][2] as string;
    expect(body).toMatch(/park directive in force/);
    // The awaitable key is COPIED from the declaration (describeParkResumePath), never re-typed.
    expect(body).toMatch(/events:await \{ event: 'fleet:f1:resume' \}/);
  });

  it("FRAMING, not gating (D-005): a holder the classifier calls 'deliberate' is still WOKEN, and its page names that verdict", async () => {
    // Engine-loop residue present and all inactive ⇒ isStoodDownOwner ⇒ 'deliberate'.
    // Over the silent-halt population that is EVERY candidate (D-005), so gating the
    // wake on abnormalEnd would wake nobody. This case FAILS if gating is reintroduced:
    // the wake leg must select on the marker alone and consume the verdict as framing.
    const stoodDown: SilentHaltSweepDeps['readEngineLoopRows'] = async () => ({
      'su-halted': [{ active: false }],
    });
    const first = sweepHarness([candidate()], halted, {
      nowMs: now,
      wakeFirstEnabled: true,
      readEngineLoopRows: stoodDown,
    });
    const r1 = await first.run();
    expect(r1.woken).toEqual(['su-halted']);
    expect(r1.paged).toEqual([]);

    const later = now + 10 * MIN;
    const marker: SilentHaltWakeMarker = {
      to: ['su-halted'],
      summary: wakeMarkerSummary('su-halted', disarmEpochToken(later, 130 * MIN)),
      ts: new Date(now).toISOString(),
    };
    const second = sweepHarness([candidate({ inactiveForMs: 130 * MIN })], halted, {
      nowMs: later,
      wakeFirstEnabled: true,
      markers: [marker],
      readEngineLoopRows: stoodDown,
    });
    const r2 = await second.run();
    expect(r2.paged).toEqual(['su-halted']);
    expect(second.notify.mock.calls[0][0].data.endClassification).toBe('deliberate');
  });
});

describe('sweepSilentHalts — P-007 slice 2 (D-006)', () => {
  const now = Date.parse('2026-10-10T23:00:00.000Z');
  const oldTurn = new Date(now - 120 * MIN).toISOString();
  const haltedAs = (...owners: string[]) =>
    Object.fromEntries(owners.map((o) => [o, { active: false, lastRealTurnAt: oldTurn }]));
  const unbound: StalledLoopHostClass = {
    kind: 'needs-relaunch',
    condition: 'unbound-successor' as never,
    why: 'the carry-respawn child never bound a native session.',
    remedy: 'Relaunch the session (psu --resume).',
  };

  /**
   * Drives the REAL default candidate read end to end against a routing fake: the candidate query
   * yields one AUTO session with its loop off, and `event_awaits` yields `awaitRows` for it.
   */
  async function sweepWithAwaits(
    awaitRows: Array<Record<string, unknown>>,
    items: Array<Record<string, unknown>> = [],
    heldItems: Array<Record<string, unknown>> = [
      { owner_id: 'su-x', work_item_id: 'WI-BASE', status: 'open', external_blockers: null },
    ],
  ) {
    const fakeSql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('WITH loops AS')) {
        return Promise.resolve([
          {
            owner_id: 'su-x',
            workspace_id: 'ws',
            routine_id: 'loop-su-x',
            interval_sec: 300,
            fleet_slug: null,
            heartbeat_age_ms: 30_000,
            inactive_for_ms: 120 * MIN,
            modes: ['auto'],
          },
        ]);
      }
      if (text.includes('/* silent-halt-held-work */')) return Promise.resolve(heldItems);
      if (text.includes('harness_shared.event_awaits')) return Promise.resolve(awaitRows);
      if (text.includes('FROM harness_shared.work_items')) return Promise.resolve(items);
      return Promise.resolve([]);
    }) as never;
    return sweepSilentHalts({
      workspaceId: 'ws',
      sql: fakeSql,
      dryRun: true,
      deps: {
        nowMs: now,
        notify: vi.fn() as never,
        readLoopStatuses: (async () =>
          new Map([['su-x', { active: false, lastRealTurnAt: oldTurn }]])) as never,
      },
    });
  }

  it("the candidate read does NOT count the session's own inbox-wake watcher as a wake source", async () => {
    // The measured blind spot: every parked session holds coord:inbox-wake:<self>, which fires
    // only on an inbound message — counting it exempted 115 of 115 candidates on 2026-10-10.
    // Since P-009 the exclusion lives in the shared wake-source predicate (D-008 (1)).
    const r = await sweepWithAwaits([
      { subscriber_id: 'su-x', event_key: 'coord:inbox-wake:su-x', expires_ts: null, timeout_behavior: 'expire', once: false },
    ]);
    expect(r.checked).toBe(1);
    expect(r.exempt['su-x'] ?? '').not.toMatch(/pending-await/);
    expect(r.halted).toEqual(['su-x']);
  });

  it('a dead work-item await does not exempt the session either (D-008 (1), via the shared predicate)', async () => {
    const r = await sweepWithAwaits(
      [{ subscriber_id: 'su-x', event_key: 'work-item:done:WI-7', expires_ts: null, timeout_behavior: null, once: true }],
      [{ feature_id: 'WI-7', status: 'wip', taken_by: 'su-x' }],
    );
    expect(r.exempt['su-x'] ?? '').not.toMatch(/pending-await/);
    expect(r.halted).toEqual(['su-x']);
  });

  it('a live untimed await still exempts the session (D-009: the detector stays lenient)', async () => {
    const r = await sweepWithAwaits([
      { subscriber_id: 'su-x', event_key: 'work-item:claimable', expires_ts: null, timeout_behavior: null, once: true },
    ]);
    expect(r.exempt['su-x']).toMatch(/pending-await x1/);
    expect(r.halted).toEqual([]);
  });

  it.each([
    { itemStatus: 'blocked', blockerStatus: 'active', shouldPark: true },
    { itemStatus: 'needs-human', blockerStatus: 'active', shouldPark: true },
    { itemStatus: 'needs-human', blockerStatus: 'cleared', shouldPark: false },
    { itemStatus: 'wip', blockerStatus: 'active', shouldPark: false },
  ])(
    'applies D-010/P-010 to $itemStatus work with a $blockerStatus blocker',
    async ({ itemStatus, blockerStatus, shouldPark }) => {
      const r = await sweepWithAwaits([], [], [{
        owner_id: 'su-x',
        work_item_id: 'WI-CREDENTIAL',
        status: itemStatus,
        external_blockers: [{
          kind: 'runtime',
          capability: 'credential',
          capabilitySource: 'explicit',
          ref: 'credential:provider',
          summary: 'Waiting for the credential provider',
          status: blockerStatus,
          createdAt: new Date(now).toISOString(),
          createdBy: 'su-x',
          updatedAt: new Date(now).toISOString(),
          // A named wake: the blocker reaper revisits it then (WI-6554700010018551).
          recheckAt: new Date(now + 60 * MIN).toISOString(),
        }],
      }]);
      expect(r.checked).toBe(1);
      if (shouldPark) {
        expect(r.halted).toEqual([]);
        expect(r.exempt['su-x']).toContain('holds-only-active-external-blockers');
        expect(r.exempt['su-x']).toContain('WI-CREDENTIAL');
      } else {
        expect(r.halted).toEqual(['su-x']);
        expect(r.wakeOnly).toEqual([]);
        expect(r.exempt).not.toHaveProperty('su-x');
      }
    },
  );

  it.each([
    { label: 'no recheckAt (a pre-default legacy row)', recheckAt: undefined },
    { label: 'an unparseable recheckAt', recheckAt: 'not-a-date' },
  ])('a blocker park with $label names no wake: halted as WAKE-ONLY, not exempt', async ({ recheckAt }) => {
    const r = await sweepWithAwaits([], [], [{
      owner_id: 'su-x',
      work_item_id: 'WI-LEGACY',
      status: 'blocked',
      external_blockers: [{
        kind: 'runtime',
        ref: 'runtime:provider',
        summary: 'Waiting for the provider',
        status: 'active',
        createdAt: new Date(now).toISOString(),
        createdBy: 'su-x',
        updatedAt: new Date(now).toISOString(),
        ...(recheckAt !== undefined ? { recheckAt } : {}),
      }],
    }]);
    expect(r.checked).toBe(1);
    expect(r.exempt).not.toHaveProperty('su-x');
    expect(r.halted).toEqual(['su-x']);
    expect(r.wakeOnly).toEqual(['su-x']);
  });

  it('a host that needs a relaunch is NOT woken; it is paged at once with the HOST UNHEALTHY remedy', async () => {
    const h = sweepHarness([candidate()], haltedAs('su-halted'), {
      nowMs: now,
      wakeFirstEnabled: true,
      readHostClass: async () => unbound,
    });
    const r = await h.run();

    expect(r.woken).toEqual([]);
    expect(h.sendWakeMessage).not.toHaveBeenCalled();
    expect(h.fireWake).not.toHaveBeenCalled();
    expect(r.paged).toEqual(['su-halted']);
    const payload = h.notify.mock.calls[0][0];
    expect(payload.body).toMatch(/HOST UNHEALTHY \(unbound-successor\)/);
    expect(payload.body).toMatch(/No wake was attempted/);
    expect(payload.body).toMatch(/psu --resume/);
    expect(payload.data.hostClass).toBe('needs-relaunch');
  });

  it('a healthy, recoverable, or unreadable host keeps the wake-first rung exactly as before', async () => {
    for (const host of [{ kind: 'healthy' }, null] as (StalledLoopHostClass | null)[]) {
      const h = sweepHarness([candidate()], haltedAs('su-halted'), {
        nowMs: now,
        wakeFirstEnabled: true,
        readHostClass: async () => host,
      });
      const r = await h.run();
      expect(r.woken).toEqual(['su-halted']);
      expect(h.notify).not.toHaveBeenCalled();
    }
  });

  it('a host read that THROWS degrades to the wake-first rung, never to silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = sweepHarness([candidate()], haltedAs('su-halted'), {
        nowMs: now,
        wakeFirstEnabled: true,
        readHostClass: async () => {
          throw new Error('psu-pty dir unreadable');
        },
      });
      const r = await h.run();
      expect(r.woken).toEqual(['su-halted']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/host read for su-halted failed/));
    } finally {
      warn.mockRestore();
    }
  });

  it('a DEDUPED page does not consume the per-sweep cap, so standing halts cannot starve a new one', async () => {
    const owners = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(owners.length).toBeGreaterThan(SILENT_HALT_MAX_PAGES_PER_SWEEP);
    // a..f already paged this epoch (deduped); g is a NEW halt and must still be paged.
    const notify = vi.fn(async (p: { data: { ownerId: string } }) => ({ deduped: p.data.ownerId !== 'g' }));
    const h = sweepHarness(owners.map((o) => candidate({ ownerId: o })), haltedAs(...owners), {
      nowMs: now,
      notify,
    });
    const r = await h.run();

    expect(r.paged).toEqual(owners);
    expect(r.pageCapReached).toBe(false);
  });

  it('the cap still bounds NEWLY created pages', async () => {
    const owners = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const h = sweepHarness(owners.map((o) => candidate({ ownerId: o })), haltedAs(...owners), { nowMs: now });
    const r = await h.run();

    expect(r.paged).toHaveLength(SILENT_HALT_MAX_PAGES_PER_SWEEP);
    expect(r.pageCapReached).toBe(true);
  });

  it("a fleet member's NEW page also alerts its fleet leader, once; a deduped page does not", async () => {
    const fresh = sweepHarness([candidate({ fleetSlug: 'fleet-x', heldWorkItems: 3 })], haltedAs('su-halted'), {
      nowMs: now,
    });
    const r = await fresh.run();

    expect(r.fleetLeaderAlerted).toEqual(['su-halted']);
    expect(fresh.alertFleetLeader).toHaveBeenCalledOnce();
    const [slug, summary, body, ws] = fresh.alertFleetLeader.mock.calls[0];
    expect(slug).toBe('fleet-x');
    expect(summary).toMatch(/su-halted is halted holding 3 work-item\(s\)/);
    expect(summary).toMatch(/inspect checkpoints; re-place or resume only if their gates permit/);
    expect(body).toMatch(/re-read each held item's checkpoint and governing decision/);
    expect(body).toMatch(/Preserve any named evidence gate or explicit stop/);
    expect(body).toMatch(/is alive but has taken no turns/);
    expect(ws).toBe('ws');

    const deduped = sweepHarness([candidate({ fleetSlug: 'fleet-x' })], haltedAs('su-halted'), {
      nowMs: now,
      notify: vi.fn(async () => ({ deduped: true })),
    });
    const r2 = await deduped.run();
    expect(r2.paged).toEqual(['su-halted']);
    expect(r2.fleetLeaderAlerted).toEqual([]);
    expect(deduped.alertFleetLeader).not.toHaveBeenCalled();
  });

  it('a non-fleet session is paged without any fleet-leader alert', async () => {
    const h = sweepHarness([candidate()], haltedAs('su-halted'), { nowMs: now });
    const r = await h.run();
    expect(r.paged).toEqual(['su-halted']);
    expect(h.alertFleetLeader).not.toHaveBeenCalled();
  });
});

describe('sweepSilentHalts — default notification adapter', () => {
  const now = Date.parse('2026-10-10T23:00:00.000Z');
  const alertLeader = vi.fn(async () => {});

  beforeEach(() => {
    attention.ensureIntent.mockReset().mockResolvedValue({ id: 9, created: true });
    attention.claimChannel.mockReset().mockResolvedValue(true);
    attention.recordIntent.mockReset().mockResolvedValue(10);
    attention.recordOutcome.mockReset().mockResolvedValue(undefined);
    attention.mobile.mockReset().mockResolvedValue([]);
    attention.desktop.mockReset().mockResolvedValue(undefined);
    alertLeader.mockClear();
  });

  const run = (candidates: SilentHaltCandidate[], nowMs = now) => sweepSilentHalts({
    workspaceId: 'ws',
    sql: {} as never,
    deps: {
      nowMs,
      readCandidates: async () => candidates,
      readLoopStatuses: (async () => new Map(candidates.map((c) => [c.ownerId, {
        active: false, lastRealTurnAt: new Date(nowMs - 180 * MIN).toISOString(),
      }]))) as never,
      wakeFirstEnabled: false,
      readEngineLoopRows: (async () => ({})) as never,
      readFleetParkPath: async () => null,
      readHostClass: async () => null,
      alertFleetLeader: alertLeader,
    },
  });

  it('alerts once for the same owner and epoch, then alerts again for a new epoch', async () => {
    const member = candidate({ fleetSlug: 'fleet-x' });
    expect((await run([member])).fleetLeaderAlerted).toEqual(['su-halted']);

    attention.ensureIntent.mockResolvedValueOnce({ id: 9, created: false });
    attention.claimChannel.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    expect((await run([candidate({ ...member, inactiveForMs: 130 * MIN })], now + 10 * MIN)).fleetLeaderAlerted).toEqual([]);
    expect(alertLeader).toHaveBeenCalledTimes(1);
    const firstKey = attention.ensureIntent.mock.calls[0][1];
    expect(attention.ensureIntent.mock.calls[1][1]).toBe(firstKey);

    expect((await run([member], now + 20 * MIN)).fleetLeaderAlerted).toEqual(['su-halted']);
    expect(attention.ensureIntent.mock.calls[2][1]).not.toBe(firstKey);
    expect(alertLeader).toHaveBeenCalledTimes(2);
    expect(attention.recordIntent).not.toHaveBeenCalled();
  });

  it('does not re-alert for an existing intent even when an unfinished channel is delivered', async () => {
    attention.ensureIntent.mockResolvedValue({ id: 9, created: false });
    attention.claimChannel.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await run([candidate({ fleetSlug: 'fleet-x' })]);
    expect(attention.mobile).toHaveBeenCalledTimes(1);
    expect(attention.desktop).not.toHaveBeenCalled();
    expect(result.fleetLeaderAlerted).toEqual([]);
    expect(alertLeader).not.toHaveBeenCalled();
  });

  it('does not let existing intents with channel attempts starve a new halt out of the page cap', async () => {
    const owners = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    attention.ensureIntent.mockImplementation(async (input: { data: { ownerId: string } }) => ({
      id: owners.indexOf(input.data.ownerId) + 1, created: input.data.ownerId === 'g',
    }));
    const result = await run(owners.map((ownerId) => candidate({ ownerId, fleetSlug: 'fleet-x' })));
    expect(result.paged).toEqual(owners);
    expect(result.pageCapReached).toBe(false);
    expect(result.fleetLeaderAlerted).toEqual(['g']);
    expect(alertLeader).toHaveBeenCalledTimes(1);
  });

  it('preserves fail-soft delivery and leader alerting when intent storage is unavailable', async () => {
    attention.ensureIntent.mockResolvedValue(null);
    const result = await run([candidate({ fleetSlug: 'fleet-x' })]);
    expect(attention.mobile).toHaveBeenCalledTimes(1);
    expect(attention.desktop).toHaveBeenCalledTimes(1);
    expect(result.fleetLeaderAlerted).toEqual(['su-halted']);
  });
});

// ── P-009 / D-008 (1): the candidate read's await count comes from the shared predicate ──────────
describe('countPendingWakeSources — the seam to wake-source-predicate', () => {
  const INBOX = 'coord:inbox-wake:';
  type AwaitRow = {
    subscriber_id: string;
    event_key: string;
    expires_ts: string | null;
    timeout_behavior: string | null;
    once: boolean | null;
  };
  type ItemRow = { feature_id: string; status: string; taken_by: string | null };

  /** A tagged-template stand-in for `Sql`: routes by the table the statement reads. */
  function fakeSql(awaits: AwaitRow[], items: ItemRow[]) {
    const queries: string[] = [];
    const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      queries.push(text);
      const ids = (values.find(Array.isArray) as string[] | undefined) ?? [];
      if (text.includes('harness_shared.event_awaits')) {
        return Promise.resolve(awaits.filter((a) => ids.includes(a.subscriber_id)));
      }
      if (text.includes('harness_shared.work_items')) {
        return Promise.resolve(items.filter((i) => ids.includes(i.feature_id)));
      }
      throw new Error(`unexpected statement: ${text}`);
    };
    return { sql: fn as unknown as Parameters<typeof countPendingWakeSources>[2], queries };
  }
  const row = (subscriber_id: string, event_key: string, over: Partial<AwaitRow> = {}): AwaitRow => ({
    subscriber_id,
    event_key,
    expires_ts: null,
    timeout_behavior: null,
    once: true,
    ...over,
  });

  it('counts none of the four dead shapes, so a stranded session reads as having no wake source', async () => {
    const { sql } = fakeSql(
      [
        // the session's own standing inbox keepalive (D-006)
        row('su-a', `${INBOX}su-a`, { once: false, timeout_behavior: 'expire' }),
        // waiting for its OWN held item to finish: a self-deadlock
        row('su-a', 'work-item:done:WI-1'),
        // the item already closed: the event already happened
        row('su-a', 'work-item:done:WI-2'),
        // the item does not exist: the event can never happen
        row('su-a', 'work-item:done:WI-3'),
      ],
      [
        { feature_id: 'WI-1', status: 'wip', taken_by: 'su-a' },
        { feature_id: 'WI-2', status: 'done', taken_by: 'su-z' },
      ],
    );
    const counts = await countPendingWakeSources(['su-a'], INBOX, sql);
    expect(counts.get('su-a') ?? 0).toBe(0);
  });

  it('still counts an UNTIMED live watch (D-009: this detector stays lenient) and a bounded inbox await', async () => {
    const { sql } = fakeSql(
      [
        row('su-a', 'work-item:claimable'),
        row('su-b', `${INBOX}su-b`, { expires_ts: '2099-01-01T00:00:00.000Z', timeout_behavior: 'wake' }),
        row('su-c', 'work-item:done:WI-9'),
      ],
      [{ feature_id: 'WI-9', status: 'wip', taken_by: 'su-peer' }],
    );
    const counts = await countPendingWakeSources(['su-a', 'su-b', 'su-c'], INBOX, sql);
    expect(Object.fromEntries(counts)).toEqual({ 'su-a': 1, 'su-b': 1, 'su-c': 1 });
  });

  it('does not query work_items when no candidate has an open await', async () => {
    const { sql, queries } = fakeSql([], []);
    const counts = await countPendingWakeSources(['su-a'], INBOX, sql);
    expect(counts.size).toBe(0);
    expect(queries.filter((q) => q.includes('harness_shared.work_items'))).toEqual([]);
  });
});
