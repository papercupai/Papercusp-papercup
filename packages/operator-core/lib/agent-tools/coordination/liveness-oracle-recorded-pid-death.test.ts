/**
 * liveness-oracle-recorded-pid-death.test.ts — EI-21572355077403526.
 *
 * THE EXECUTABLE SPEC: an affirmative ESRCH (`probePidFn` → `false`) beats the
 * `recorded` session-log rescue, and NOTHING WEAKER does.
 *
 * WHY THIS IS GUARDED. `recorded` infers liveness from
 * `adv_sessions.ended_at IS NULL`. That column is written by a session-end hook
 * that **SIGKILL bypasses**, so for a killed session the row is STALE rather
 * than live. The classification short-circuited to `recorded` BEFORE the
 * heartbeat/pid path, so the stale row outranked a direct OS observation that
 * the process was gone — permanently, since nothing would ever come back to
 * write `ended_at`.
 *
 * The consequence was not cosmetic. `holderCountsAsAlive` (goals/holder.ts)
 * treats `recorded` as alive, so a goal whose holder had been killed:
 *   - refused every relaunch with `already-held`, forever, AND
 *   - never fired `launch_settings.holder.onLoss: 'deactivate'`,
 * leaving the goal wedged `active` behind a dead holder. Observed 2026-08-27 on
 * goal `…-9425fe`; the only way out was hand-retiring the stale `agent_modes`
 * row via `mode:set { enabled:false }`, which is undiscoverable.
 *
 * THE SHAPE OF THIS TEST. Each case is a PAIR sharing one subject and one
 * wakeability map, differing ONLY in the pid probe. That is what makes it a
 * measurement rather than an assertion: the `null` twin is a positive control
 * proving the setup really does produce `recorded`, so a green `false` twin
 * cannot be an artifact of a subject that was never `recorded` to begin with.
 * A fix that simply deleted the `recorded` branch would pass the first
 * assertion of every pair and fail the second.
 */
import { hostname } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { deriveVerdict, resolveSessionStates, type LivenessSubject } from './liveness-oracle';
import type { WakeabilitySignals } from './presence-wakeability';
import { holderCountsAsAlive, resolveGoalHoldersFromRows } from '../../goals/holder';
import { mapAdvSessionRow } from '../../adv-sessions';

const NOW = Date.parse('2026-08-27T02:45:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const OWNER = 'su-test-killed-holder';
/** Any non-null host; the pid probe is injected, so the value is inert here. */
const HOST = 'test-host';

/** A killed holder: heartbeat still warm, no live turn, not wakeable. */
const killedHolder: LivenessSubject = {
  ownerId: OWNER,
  heartbeatAt: iso(5_000),
  stale: false,
  host: HOST,
  pid: 3959493,
};

/** Not wakeable + no turn in flight — the exact gate `recordedLiveOnly` opens on. */
const NOT_WAKEABLE: WakeabilitySignals = { wakeable: false, liveTurn: false };

/**
 * Everything pinned to a PG-free seam. `pidProbe` is the ONLY variable; the
 * owner is always in the recorded-live set, so absent a pid verdict the subject
 * is unambiguously `recorded`.
 */
const opts = (pidProbe: () => boolean | null) => ({
  nowMs: NOW,
  fetchWakeabilityFn: async () => new Map([[OWNER, NOT_WAKEABLE]]),
  fetchRecordedLiveFn: async () => new Set<string>([OWNER]),
  fetchRecordedEndedFn: async () => new Set<string>(),
  probePidFn: pidProbe,
  findHostFn: () => null,
});

describe('WI-10006572 — recorded PID hydration with no presence row', () => {
  // The immutable incarnation is identical on both paths. Only input assembly
  // differs: a roster caller already carries the PID; a bare-id caller must
  // recover it. Never mutate started_at/session_id to make the test pass.
  const ownerId = 'su-recorded-hydration';
  const recorded = mapAdvSessionRow({
    id: 72, workspace_id: 'ws-recorded-hydration', plan_slug: null,
    agent: 'codex', role: 'su', feature: null, mode: 'console',
    terminal_bin: null, pid: 3959493, window_id: null, omp_thread_id: null,
    label: null, cwd: null, coord_owner_id: ownerId, session_id: 'native-72',
    started_at: iso(3_600_000), ended_at: null, exit_code: null,
  });
  const PARKED: WakeabilitySignals = { wakeable: true, liveTurn: false };
  const common = (wake = PARKED, row = recorded) => ({
    nowMs: NOW,
    fetchWakeabilityFn: async () => new Map([[ownerId, wake]]),
    fetchRecordedLiveFn: async () => new Set<string>(),
    fetchRecordedEndedFn: async () => new Set<string>(),
    fetchRecordedSessionsFn: vi.fn(async () => new Map([[ownerId, row]])),
    getPresenceFn: vi.fn(async () => null),
    listPresenceFn: vi.fn(async () => []) as never,
    probePidFn: vi.fn(({ host, pid }: { host?: string | null; pid?: number | null }) =>
      host === hostname() && pid === recorded.pid ? false : null),
    findHostFn: () => null,
  });

  it.each(['hydratePerId', 'hydrateBatch'] as const)(
    '%s retains the exact recorded PID and agrees with the roster dead-PID verdict',
    async (mode) => {
      const options = common();
      const bindingBefore = JSON.stringify(recorded);
      const roster = deriveVerdict(
        { ownerId, host: hostname(), pid: recorded.pid }, PARKED,
        new Set(), NOW, options.probePidFn,
      );
      const hydrated = await resolveSessionStates(
        [{ ownerId, host: hostname() }], { ...options, [mode]: true },
      );
      expect(roster.sessionState).toBe('ended');
      expect(hydrated.get(ownerId)?.sessionState).toBe(roster.sessionState);
      expect(options.fetchRecordedSessionsFn).toHaveBeenCalledWith([ownerId]);
      expect(options.probePidFn).toHaveBeenCalledWith({ host: hostname(), pid: recorded.pid });
      expect(JSON.stringify(recorded)).toBe(bindingBefore);
    },
  );

  it('an identity-verified newer live host still supersedes the dead recorded PID', async () => {
    const options = common({ wakeable: true, liveTurn: true });
    const out = await resolveSessionStates([{ ownerId, host: hostname() }], {
      ...options, hydratePerId: true,
      findHostFn: () => ({ ownerId, pid: recorded.pid! + 1 }),
    });
    expect(out.get(ownerId)?.sessionState).toBe('live');
    expect(options.fetchRecordedSessionsFn).toHaveBeenCalledWith([ownerId]);
    expect(options.probePidFn).toHaveBeenCalledWith({ host: hostname(), pid: recorded.pid });
  });

  it('does not substitute a recorded PID for an existing presence incarnation', async () => {
    const options = common({ wakeable: true, liveTurn: true });
    const out = await resolveSessionStates([{ ownerId }], {
      ...options, hydratePerId: true,
      getPresenceFn: async () => ({
        heartbeatAt: iso(5_000), stale: false, host: hostname(),
        pid: recorded.pid! + 1, source: 'psu', agentRole: 'su',
      }),
    });
    expect(out.get(ownerId)?.sessionState).toBe('live');
    expect(options.fetchRecordedSessionsFn).not.toHaveBeenCalled();
  });

  it('uses terminal-local provenance, never a guessed hostname, for a bare recorded PID', async () => {
    const options = common(PARKED, { ...recorded, display: 'terminal' });
    const out = await resolveSessionStates([{ ownerId }], { ...options, hydratePerId: true });
    expect(out.get(ownerId)?.sessionState).toBe('ended');
    expect(options.probePidFn).toHaveBeenCalledWith({ host: hostname(), pid: recorded.pid });
  });

  it.each([true, null])('a terminal-local PID probe of %s is not death evidence', async (probe) => {
    const options = common(NOT_WAKEABLE, { ...recorded, display: 'terminal' });
    const out = await resolveSessionStates([{ ownerId }], {
      ...options, hydratePerId: true, probePidFn: () => probe,
    });
    expect(out.get(ownerId)?.sessionState).toBe('recorded');
  });

  it('unknown-host recorded evidence stays fail-closed even when started_at is old', async () => {
    const options = common(NOT_WAKEABLE);
    const out = await resolveSessionStates([{ ownerId }], { ...options, hydratePerId: true });
    expect(out.get(ownerId)).toMatchObject({
      sessionState: null, signalMissing: true, confirmLiveness: true,
    });
    expect(options.probePidFn).not.toHaveBeenCalled();
  });

  it('a remote host cannot turn a recorded PID into local death evidence', async () => {
    const options = common(PARKED);
    const out = await resolveSessionStates(
      [{ ownerId, host: 'remote-host' }], { ...options, hydratePerId: true },
    );
    expect(out.get(ownerId)?.sessionState).toBe('parked');
  });

  it('a failed presence read does not masquerade as an absent presence row', async () => {
    const options = common(NOT_WAKEABLE);
    const out = await resolveSessionStates([{ ownerId }], {
      ...options, hydratePerId: true,
      getPresenceFn: async () => { throw new Error('presence unavailable'); },
    });
    expect(out.get(ownerId)?.sessionState).toBeNull();
    expect(options.fetchRecordedSessionsFn).not.toHaveBeenCalled();
  });

  it('missing, failed or foreign recorded input never fabricates terminal evidence', async () => {
    for (const fetchRecordedSessionsFn of [
      async () => new Map(),
      async () => { throw new Error('recorded unavailable'); },
      async () => new Map([[ownerId, { ...recorded, coordOwnerId: 'su-other' }]]),
    ]) {
      const out = await resolveSessionStates([{ ownerId }], {
        ...common(NOT_WAKEABLE), hydratePerId: true, fetchRecordedSessionsFn,
      });
      expect(out.get(ownerId)?.sessionState).toBeNull();
    }
  });
});

const verdictFor = async (pidProbe: () => boolean | null) => {
  const out = await resolveSessionStates([killedHolder], opts(pidProbe));
  const v = out.get(OWNER);
  if (!v) throw new Error('oracle omitted the subject — totality contract broken');
  return v;
};

describe('EI-21572355077403526 — an affirmative ESRCH disqualifies the `recorded` rescue', () => {
  it('POSITIVE CONTROL: with an inconclusive probe the subject really is `recorded`', async () => {
    // If this ever stops being `recorded`, every other case below is measuring
    // nothing and their green means nothing.
    expect((await verdictFor(() => null)).sessionState).toBe('recorded');
  });

  it('a CONFIRMED-DEAD pid is no longer `recorded`', async () => {
    const v = await verdictFor(() => false);
    expect(v.sessionState).not.toBe('recorded');
    // No claims held ⇒ the honest verdict is positively gone.
    expect(v.sessionState).toBe('ended');
  });

  it('repaired PID loss contract: real-pid-loss (WI-1074216)', async () => {
    // This is the oracle's unit seam, paired with the existing real-process
    // integration receipt. The wrong probe preserves the stale recorded rescue.
    const wrongProbe = process.env.PAPERCUSP_GOAL_PID_LOSS_CONTROL === 'real-pid-loss';
    const v = await verdictFor(() => wrongProbe ? true : false);
    expect(v.sessionState, 'pid-loss-contract:real-pid-loss').toBe('ended');
  });

  it('detects permanent wrong-seam control: real-pid-loss', async () => {
    expect((await verdictFor(() => false)).sessionState).toBe('ended');
    // The deliberately wrong live-pid observation revives the recorded rescue.
    const wrong = await verdictFor(() => true);
    expect(wrong.sessionState).toBe('recorded');
    expect(wrong.sessionState).not.toBe('ended');
  });

  it('a probe reporting the process ALIVE leaves `recorded` intact', async () => {
    // Guards the disqualifier against being written as a mere truthiness check:
    // only `=== false` may disqualify, never `true`.
    expect((await verdictFor(() => true)).sessionState).toBe('recorded');
  });
});

describe('EI-21572355077403526 — the SECOND resurrection path: the psu-host positive rescue', () => {
  /**
   * Guarding only `recordedLiveOnly` would have been a HALF-FIX. A
   * confirmed-dead subject falls through to `deriveSessionState` (→ `ended`)
   * and the psu-host "positive" leg then flips `ended` straight back to
   * `recorded` for a non-wakeable owner — re-arming the identical
   * unrelaunchable-goal trap through a different leg.
   *
   * This subject is deliberately NOT in the recorded-live set, so the ONLY
   * thing that can produce `recorded` here is the psu-host leg.
   */
  const hostRescued: LivenessSubject = {
    ...killedHolder,
    ownerId: 'su-test-host-rescued',
    agentRole: 'su', // must be a known non-cup role for psuHostKnownRole
  };

  const hostOpts = (pidProbe: () => boolean | null) => ({
    nowMs: NOW,
    fetchWakeabilityFn: async () => new Map([[hostRescued.ownerId, NOT_WAKEABLE]]),
    fetchRecordedLiveFn: async () => new Set<string>(), // NOT recorded-live
    fetchRecordedEndedFn: async () => new Set<string>(),
    probePidFn: pidProbe,
    psuHostPositiveAuthority: true,
    findHostFn: () => ({ live: true }), // a live psu host witness
  });

  const stateFor = async (pidProbe: () => boolean | null) => {
    const out = await resolveSessionStates([hostRescued], hostOpts(pidProbe));
    return out.get(hostRescued.ownerId)?.sessionState;
  };

  it('POSITIVE CONTROL: an inconclusive probe still lets the host rescue produce `recorded`', async () => {
    // Proves the rescue leg is genuinely reachable in this setup. Without this,
    // the assertion below could pass simply because nothing ever rescued.
    expect(await stateFor(() => null)).toBe('recorded');
  });

  it('a confirmed-dead pid is NOT rescued back to `recorded` by a live host witness', async () => {
    expect(await stateFor(() => false)).not.toBe('recorded');
  });
});

describe('EI-21572355077403526 — the goal-holder consequence that actually broke', () => {
  const holderRow = {
    goalId: 'the-papercusp-desktop-gui-is-verified-end-to-end-9425fe',
    workspaceId: 'papercusp-workspace',
    ownerId: OWNER,
    setAtMs: NOW - 7_000_000,
  };

  const holdersWith = async (pidProbe: () => boolean | null) => {
    const verdicts = await resolveSessionStates([killedHolder], opts(pidProbe));
    return resolveGoalHoldersFromRows(
      holderRow.goalId,
      holderRow.workspaceId,
      [holderRow],
      verdicts as never,
    );
  };

  it('POSITIVE CONTROL: an inconclusive probe still reads `held` (generosity preserved)', async () => {
    // This is the behaviour the holder.ts docblock deliberately wants: a false
    // "abandoned" on a goal someone is actively working is worse than a late
    // alarm. The fix must NOT cost us this.
    expect((await holdersWith(() => null)).liveness).toBe('held');
  });

  it('a killed holder no longer blocks relaunch: liveness is `lost`, not `held`', async () => {
    const holders = await holdersWith(() => false);
    // `held` here is what produced the permanent `already-held` refusal.
    expect(holders.liveness).not.toBe('held');
    expect(holders.liveness).toBe('lost');
    expect(holders.live).toHaveLength(0);
    expect(holders.holders[0]?.live).toBe(false);
  });

  it('holderCountsAsAlive agrees, so onLoss:deactivate can finally fire', async () => {
    const holders = await holdersWith(() => false);
    const verdict = {
      ownerId: OWNER,
      sessionState: holders.holders[0]!.sessionState,
      selfWake: holders.holders[0]!.selfWake,
    };
    expect(holderCountsAsAlive(verdict as never)).toBe(false);
  });
});

describe('WI-10005725 — a dead RECORDED pid must not end a live successor incarnation', () => {
  /**
   * A session relaunched under a REUSED ownerId keeps its predecessor's pid on
   * the presence row until its own supervisor beat lands. The probe then
   * reports ESRCH for the PREDECESSOR while the successor is mid-turn, and the
   * ESRCH outranked `liveTurn`: a working successor read `ended`, and the goal
   * respawner replaced it. The only thing allowed to override the ESRCH is an
   * identity-verified live psu host under a DIFFERENT concrete pid.
   */
  const successor: LivenessSubject = {
    ...killedHolder,
    ownerId: 'su-test-relaunched-successor',
    agentRole: 'su',
  };
  const LIVE_TURN: WakeabilitySignals = { wakeable: true, liveTurn: true };

  const verdictWithHost = async (host: unknown) => {
    const out = await resolveSessionStates([successor], {
      nowMs: NOW,
      fetchWakeabilityFn: async () => new Map([[successor.ownerId, LIVE_TURN]]),
      fetchRecordedLiveFn: async () => new Set<string>(),
      fetchRecordedEndedFn: async () => new Set<string>(),
      probePidFn: () => false, // the RECORDED (predecessor) pid is gone
      findHostFn: () => host,
    });
    const v = out.get(successor.ownerId);
    if (!v) throw new Error('oracle omitted the subject — totality contract broken');
    return v;
  };

  it('CONTROL: with no live host, a dead recorded pid still ends a mid-turn session', async () => {
    // Keeps the WI-3898 / EI-21572355077403526 precedence: without positive
    // evidence of a current incarnation, ESRCH beats a fresh turn.
    expect((await verdictWithHost(null)).sessionState).toBe('ended');
  });

  it('a verified live host under a DIFFERENT pid supersedes the stale recorded pid', async () => {
    const v = await verdictWithHost({ ownerId: successor.ownerId, pid: successor.pid! + 1 });
    expect(v.sessionState).toBe('live');
  });

  it('a host witness carrying the SAME pid does not override the ESRCH', async () => {
    const v = await verdictWithHost({ ownerId: successor.ownerId, pid: successor.pid });
    expect(v.sessionState).toBe('ended');
  });

  it('a host witness without a concrete pid does not override the ESRCH', async () => {
    expect((await verdictWithHost({ live: true })).sessionState).toBe('ended');
    expect((await verdictWithHost({ pid: 'not-a-pid' })).sessionState).toBe('ended');
  });

  it('the goal-holder consequence: a superseded stale pid keeps the successor `held`', async () => {
    const out = await resolveSessionStates([successor], {
      nowMs: NOW,
      fetchWakeabilityFn: async () => new Map([[successor.ownerId, LIVE_TURN]]),
      fetchRecordedLiveFn: async () => new Set<string>(),
      fetchRecordedEndedFn: async () => new Set<string>(),
      probePidFn: () => false,
      findHostFn: () => ({ ownerId: successor.ownerId, pid: successor.pid! + 1 }),
    });
    const holders = resolveGoalHoldersFromRows(
      'goal-wi-10005725',
      'papercusp-workspace',
      [{ goalId: 'goal-wi-10005725', workspaceId: 'papercusp-workspace', ownerId: successor.ownerId, setAtMs: NOW - 60_000 }],
      out as never,
    );
    expect(holders.liveness).toBe('held');
  });
});
