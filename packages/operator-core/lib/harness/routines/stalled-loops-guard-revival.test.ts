/**
 * WI-37546 — the LIVENESS VETO and the RECOVERABLE DISARM.
 *
 * Split out of `stalled-loops-guard.test.ts` (already 76KB) because these two branches are one
 * coherent fix with a single motivating measurement, and they need fixtures the older file does
 * not have: a tool-activity oracle and a set of ALREADY-DISARMED loops.
 *
 * THE MEASUREMENT UNDER TEST (census of 2026-08-09, workspace papercusp-workspace): of 19 loops
 * this module disarmed as turn-stalled that day, 18 owners were making tool calls in the hour
 * BEFORE their disarm. The control that makes it a finding rather than a correlation is the same
 * module's OTHER verdict path — `dead-owner`, 7 disarms, 7/7 correct — so the signal is fine and
 * the `turns-stalled` INFERENCE is what over-fires.
 *
 * Both halves are represented here, and both have an explicit CONTROL, because each is a
 * REAPER-BLUNTING change and WI-36792's measured lesson is that blunting a reaper is invisible
 * (it still reports `checked: N`). A veto with no falsifying test is indistinguishable from a
 * disabled guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sweepStalledLoops,
  isProgressingToolActivity,
  TURN_STALLED_PAUSE_PREFIX,
  TOOL_LIVENESS_VETO_CEILING_MS,
  REVIVE_WINDOW_MS,
  MAX_REVIVALS,
  type StalledLoopsSweepDeps,
  type OwnerToolActivity,
  type RevivableLoopCandidate,
} from './stalled-loops-guard';
import { RESUMABLE_DEAD_PAUSE_PREFIX } from './loop-unreachable-guard';
import { deactivateLoop, reviveDisarmedLoop, LOOP_END_PAUSE_PREFIX, type LoopStatus } from './loop';

// P-007: keep the sweep's default host reader off the real ~/.papercusp/psu-pty directory — see
// the same mock in stalled-loops-guard.test.ts.
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/await/psu-pty-discovery')>()),
  findLiveHostAsync: vi.fn(async () => null),
  readHostEventTailAsync: vi.fn(async () => []),
}));

// Bound to the REAL dep signatures for the reason the sibling file documents at length: a bare
// `vi.fn(async () => {})` records a ZERO-arg call tuple, so every `.mock.calls[0][1]` read below
// is a lint:tsc error that a green vitest run cannot see.
type AutoPauseFn = NonNullable<StalledLoopsSweepDeps['autoPause']>;
type RearmFn = NonNullable<StalledLoopsSweepDeps['rearm']>;
type ReviveFn = NonNullable<StalledLoopsSweepDeps['revive']>;
type BroadcastFn = NonNullable<StalledLoopsSweepDeps['broadcast']>;
type NotifyFn = NonNullable<StalledLoopsSweepDeps['notify']>;
type ReadActivityFn = NonNullable<StalledLoopsSweepDeps['readOwnerToolActivity']>;
type ReadRevivableFn = NonNullable<StalledLoopsSweepDeps['readRevivableLoops']>;
type ResetFireErrorsFn = NonNullable<StalledLoopsSweepDeps['resetFireErrors']>;

function fakeSql(rows: Array<{ id: string; target_owner_id: string }>) {
  return ((strings: TemplateStringsArray) => {
    if (/SELECT/i.test(strings.join('?'))) return Promise.resolve(rows);
    return Promise.resolve([]);
  }) as never;
}

/**
 * Is the placeholder that FOLLOWS `prefix` sitting inside an `unnest(...)` argument list?
 *
 * The guard below is about ONE binding site — the multi-arg `unnest(a, b)` that pairs each owner
 * with its own `since`, which needs explicitly-typed arrays (`sql.array`) rather than raw JS ones.
 * It is deliberately NOT "no raw arrays anywhere": postgres-js binds a raw JS array fine, and this
 * repo relies on that at ~10 live call sites (`= ANY(${[...CONST]}::text[])`). A blanket rejection
 * therefore models the driver WRONGLY, and its first victim was a legitimate change — see the
 * calibration + CONTROL pair below.
 */
function bindsInsideUnnest(prefix: string): boolean {
  const open = prefix.toLowerCase().lastIndexOf('unnest(');
  if (open < 0) return false;
  let depth = 0;
  for (let i = open + 'unnest'.length; i < prefix.length; i++) {
    if (prefix[i] === '(') depth++;
    else if (prefix[i] === ')' && --depth === 0) return false;
  }
  return depth > 0;
}

function strictArraySql(rows: Array<{ id: string; target_owner_id: string }>) {
  const array = vi.fn((values: unknown[]) => ({ values }));
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    values.forEach((v, i) => {
      if (Array.isArray(v) && bindsInsideUnnest(strings.slice(0, i + 1).join('?'))) {
        throw new Error('Received an instance of Array');
      }
    });
    const statement = strings.join('?');
    if (/FROM harness_shared\.routines/i.test(statement)) return Promise.resolve(rows);
    if (/FROM unnest/i.test(statement) && /harness_shared\.tool_invocations/i.test(statement)) {
      return Promise.resolve([
        {
          owner_id: 'su-live',
          calls: 17,
          distinct_tools: 15,
          ok_calls: 17,
          last_call_at: '2026-08-09T17:08:00.000Z',
        },
      ]);
    }
    return Promise.resolve([]);
  }) as unknown as {
    (...args: unknown[]): Promise<unknown[]>;
    array: typeof array;
    unsafe: (fragment: string) => unknown;
  };
  sql.array = array;
  // postgres-js composes nested fragments, and `sql.unsafe` is how a predicate helper splices an
  // identifier in (`agentToolInvocationPredicate` uses it for the table alias). A double missing it
  // throws a TypeError that the sweep's `.catch` swallows into "no activity" — i.e. the veto silently
  // reads as absent and the failure looks like a veto regression rather than a stale double.
  sql.unsafe = (fragment: string) => ({ unsafe: fragment });
  return { sql: sql as never, array };
}

function status(overrides: Partial<LoopStatus> & { turnsStalled: boolean }): LoopStatus {
  return {
    name: 'loop-x',
    ownerId: 'owner-x',
    harnessSlug: 'papercusp',
    active: true,
    intervalSec: 60,
    carry: 'warm',
    continuation: 'settle',
    mode: 'work',
    fireCount: 10,
    firesSinceArm: 10,
    parked: false,
    nextFireAt: null,
    // Deliberately RECENT-ish relative to the fixtures below, and always EARLIER than lastTurnAt
    // is not assumed: these tests drive the turn-stalled path, so the last turn must not sit at
    // or after the last fire (that is the fire-starved branch, tested elsewhere).
    lastFiredAt: '2026-08-09T17:07:00.000Z',
    armedAt: '2026-08-09T10:00:00.000Z',
    costCapCents: null,
    maxFires: null,
    maxDurationSec: null,
    stalled: false,
    stalledSinceMs: null,
    lastDeliveryOutcome: null,
    consecutiveErrors: 0,
    lastWakeChannel: null,
    lastWakeStatus: null,
    // Non-null and tracking the fire, so the WAKE-STARVED branch does not claim these fixtures.
    lastWakeAt: '2026-08-09T17:07:00.000Z',
    lastWakeError: null,
    lastTurnAt: '2026-08-09T16:29:00.000Z',
    lastRealTurnAt: '2026-08-09T16:29:00.000Z',
    cadenceDrift: false,
    lastWithheldAt: null,
    lifecycleBackoff: null,
    ...overrides,
  } as LoopStatus;
}

/** The corpse-shaped reachability verdict: nothing live, nothing repairable. */
const reach = (reachable: boolean) =>
  vi.fn(async () => ({
    reachable,
    channel: (reachable ? 'psu-socket' : 'none') as never,
    durableWhileAlive: reachable,
    summary: reachable ? 'live injectable session' : 'no wake path',
    awaitRepairable: false,
    wouldBeChannel: null,
  }));

function activity(o: Partial<OwnerToolActivity>): OwnerToolActivity {
  return { calls: 0, distinctTools: 0, okCalls: 0, lastCallAt: null, ...o };
}

/** An agent doing real work: several tools, calls that succeed. */
const WORKING = activity({ calls: 629, distinctTools: 24, okCalls: 601, lastCallAt: '2026-08-09T19:21:00.000Z' });

/**
 * D-006's CONVERGENT POPULATION, as a fixture: an agent wedged in a tight retry loop. Thousands
 * of calls, ONE tool, ZERO successes. This is the shape that makes raw call volume an unsafe
 * liveness signal, and every test that uses it is asserting the veto does NOT fire.
 */
const RETRY_STORM = activity({ calls: 4000, distinctTools: 1, okCalls: 0, lastCallAt: '2026-08-09T19:21:00.000Z' });

const noActivity = () => vi.fn<ReadActivityFn>(async () => new Map<string, OwnerToolActivity>());
const noRevivable = () => vi.fn<ReadRevivableFn>(async () => []);

// These suites are fail-on-console and EVERY branch under test logs its reasoning by design —
// that logging is the operator-visible half of both fixes (a veto nobody can see in the routine
// log is indistinguishable from a disabled guard). Silenced rather than asserted-on here; the
// dispositions are asserted through the result and the write mocks.
/**
 * THE CLOCK IS FROZEN, and that is load-bearing — this file EXPIRED once.
 *
 * Every fixture above is an ABSOLUTE wall-clock instant, but the code under test compares them
 * against `Date.now()`: the veto is refused once `nowMs - lastRealTurnAt` reaches
 * `TOOL_LIVENESS_VETO_CEILING_MS` (stalled-loops-guard.ts ~L1173-1177). With a real clock the
 * default `lastRealTurnAt` of 16:29Z therefore aged past the 6h ceiling at exactly
 * 2026-08-09T22:29:00Z, and 'refuses to disarm an owner still making PROGRESSING tool calls'
 * began failing — permanently, and with no code change to explain it. The last green run was
 * 22:25:32Z; the red was attributed to the commit that happened to land at 22:26 (61eaf8a4c2),
 * which had touched nothing in this module. A time bomb reads exactly like a regression.
 *
 * Freezing (rather than making each fixture `Date.now()`-relative) is deliberate: it keeps the
 * absolute literals the other tests assert on — the `sinceIso` probe identities, `pausedAtMs` —
 * meaningful forever, and it means a test added LATER with a literal timestamp inherits the
 * fix instead of re-arming the bomb.
 *
 * Only `Date` is faked. Faking timers wholesale would stall the awaited sweep.
 *
 * The instant is the fixture narrative's own "now": just after WORKING's last tool call (19:21Z),
 * with the last completed turn 3h01m back — inside the 6h ceiling, as these tests intend.
 */
const FROZEN_NOW = '2026-08-09T19:30:00.000Z';

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FROZEN_NOW));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

/**
 * The recurrence guard for the expiry described at FROZEN_NOW. It fails LOUDLY and by name the
 * moment the calibration these fixtures rely on stops holding — instead of the suite quietly
 * going red hours later and reading as a regression in the module under test.
 */
describe('fixture clock (recurrence guard — this file expired once, see FROZEN_NOW)', () => {
  it('runs under the frozen clock, so no fixture can age out mid-suite', () => {
    expect(Date.now()).toBe(Date.parse(FROZEN_NOW));
  });

  it("keeps the default status() INSIDE the veto ceiling — the exact calibration that expired", () => {
    const s = status({ turnsStalled: true });
    const turnlessForMs = Date.now() - Date.parse(s.lastRealTurnAt as string);
    expect(turnlessForMs).toBeGreaterThan(0);
    expect(turnlessForMs).toBeLessThan(TOOL_LIVENESS_VETO_CEILING_MS);
  });

  it('keeps the turn-stalled shape: the last turn precedes the last fire', () => {
    const s = status({ turnsStalled: true });
    expect(Date.parse(s.lastTurnAt as string)).toBeLessThan(Date.parse(s.lastFiredAt as string));
  });
});

describe('isProgressingToolActivity (WI-37546 — progress, not volume)', () => {
  it('absent or empty activity is not progress', () => {
    expect(isProgressingToolActivity(undefined)).toBe(false);
    expect(isProgressingToolActivity(null)).toBe(false);
    expect(isProgressingToolActivity(activity({ calls: 0, distinctTools: 0, okCalls: 0 }))).toBe(false);
  });

  it('CONTROL — a 4000-call single-tool error storm is NOT progress (the population D-006 named)', () => {
    expect(isProgressingToolActivity(RETRY_STORM)).toBe(false);
  });

  it('a second distinct tool is progress, even with no successes yet', () => {
    expect(isProgressingToolActivity(activity({ calls: 2, distinctTools: 2, okCalls: 0 }))).toBe(true);
  });

  it('one successful call is progress, even on a single tool', () => {
    expect(isProgressingToolActivity(activity({ calls: 3, distinctTools: 1, okCalls: 1 }))).toBe(true);
  });

  it('CALIBRATION — the real working shape passes, so the two controls above are not just strict', () => {
    expect(isProgressingToolActivity(WORKING)).toBe(true);
  });
});

/**
 * The double that the `binds the default activity reader arrays…` test below leans on is itself a
 * guard, so it needs its own falsifiability proof — kept here permanently rather than proven by a
 * one-off mutation, because mutating the shared checkout lets git-sync commit the mutant (CLAUDE.md,
 * "Proving a guard is falsifiable"). The pair is the point: the CONTROL shows the guard still bites
 * on the binding it exists for, and the CALIBRATION shows it does not bite on the legitimate raw
 * array that a blanket check wrongly rejected.
 */
describe('strictArraySql — the double is calibrated, so the veto test cannot pass vacuously', () => {
  type TaggedSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

  it('CONTROL — a RAW JS array bound inside unnest(...) still throws (the guard is not vacuous)', () => {
    const { sql } = strictArraySql([]);
    const tagged = sql as unknown as TaggedSql;
    expect(
      () => tagged`
        SELECT 1
          FROM unnest(${['su-live']}::text[], ${['2026-08-09T17:07:00.000Z']}::timestamptz[])
               AS b(owner_id, since)
          JOIN harness_shared.tool_invocations t ON t.coord_owner_id = b.owner_id
      `,
    ).toThrow(/Received an instance of Array/);
  });

  it('CALIBRATION — a raw array bound OUTSIDE unnest is valid postgres-js and must NOT throw', () => {
    const { sql } = strictArraySql([]);
    const tagged = sql as unknown as TaggedSql;
    expect(
      () => tagged`SELECT 1 FROM harness_shared.tool_invocations t WHERE t.tool_name = ANY(${['a', 'b']}::text[])`,
    ).not.toThrow();
  });

  it('CALIBRATION — sql.unsafe exists, so a composed predicate fragment builds instead of throwing', () => {
    const { sql } = strictArraySql([]);
    expect(() => (sql as unknown as { unsafe: (s: string) => unknown }).unsafe('t.call_origin')).not.toThrow();
  });
});

describe('sweepStalledLoops — liveness veto (WI-37546: 18 of 19 disarms on 2026-08-09)', () => {
  const deps = (over: Partial<StalledLoopsSweepDeps> = {}): StalledLoopsSweepDeps => ({
    probeReachability: reach(false),
    broadcast: vi.fn<BroadcastFn>(async () => true),
    notify: vi.fn<NotifyFn>(async () => {}),
    readRevivableLoops: noRevivable(),
    ...over,
  });

  it('refuses to disarm an owner still making PROGRESSING tool calls since its last fire', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-live' }]);
    const getStatuses = vi.fn(async () => new Map([['su-live', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-live', WORKING]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual(['su-live']);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('P-008 repairs a progressing owner whose turn-stalled loop is still parked instead of only vetoing', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-live-parked' }]);
    const getStatuses = vi.fn(async () => new Map([['su-live-parked', status({ turnsStalled: true, parked: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-live-parked', WORKING]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, rearm, broadcast, readOwnerToolActivity }),
    );

    expect(res.reArmedToolLiveParked).toEqual(['su-live-parked']);
    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(rearm).toHaveBeenCalledWith(sql, 'rt1', expect.stringContaining('tool-live parked repair'));
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0]?.[0]).toMatchObject({
      summary: expect.stringContaining('TOOL-LIVE'),
      body: expect.stringContaining('su-live-parked'),
    });
  });

  it('P-008 keeps a parked repair eligible past the plain-veto ceiling — the sentinel is the repair gate', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-old-parked' }]);
    const longAgo = new Date(Date.now() - TOOL_LIVENESS_VETO_CEILING_MS - 60_000).toISOString();
    const getStatuses = vi.fn(
      async () =>
        new Map([
          [
            'su-old-parked',
            status({
              turnsStalled: true,
              parked: true,
              lastTurnAt: longAgo,
              lastRealTurnAt: longAgo,
              armedAt: longAgo,
            }),
          ],
        ]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const rearm = vi.fn<RearmFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(
      async () => new Map([['su-old-parked', WORKING]]),
    );

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, rearm, readOwnerToolActivity }),
    );

    expect(res.reArmedToolLiveParked).toEqual(['su-old-parked']);
    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(0);
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('binds the default activity reader arrays through postgres-js, preserving the live-owner veto', async () => {
    const { sql, array } = strictArraySql([{ id: 'rt1', target_owner_id: 'su-live' }]);
    const getStatuses = vi.fn(async () => new Map([['su-live', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({
        getStatuses,
        autoPause,
        resolveOwnerWorkspaces: vi.fn(async () => new Map<string, string>()),
      }),
    );

    expect(array).toHaveBeenNthCalledWith(1, ['su-live']);
    expect(array).toHaveBeenNthCalledWith(2, ['2026-08-09T17:07:00.000Z']);
    expect(array).toHaveBeenCalledWith(['loop:checkpoint', 'work_items:checkpoint']);
    expect(res.vetoedByToolActivity).toEqual(['su-live']);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('CONTROL — an owner with NO tool activity is still disarmed (the guard is not blunted)', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-corpse' }]);
    const getStatuses = vi.fn(async () => new Map([['su-corpse', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity: noActivity() }),
    );

    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(1);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — a retry storm is disarmed: volume alone never buys the veto', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-spin' }]);
    const getStatuses = vi.fn(async () => new Map([['su-spin', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-spin', RETRY_STORM]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(1);
  });

  it('CONTROL — progressing calls stop counting past the ceiling, so the veto cannot become permanent', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-eternal' }]);
    const longAgo = new Date(Date.now() - TOOL_LIVENESS_VETO_CEILING_MS - 60_000).toISOString();
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-eternal', status({ turnsStalled: true, lastTurnAt: longAgo, lastRealTurnAt: longAgo, armedAt: longAgo })],
        ]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-eternal', WORKING]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(1);
  });

  it('an owner with NO turn history at all takes the veto — unknown is not old', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-new' }]);
    const getStatuses = vi.fn(
      async () =>
        new Map([['su-new', status({ turnsStalled: true, lastTurnAt: null, lastRealTurnAt: null, armedAt: null })]]),
    );
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-new', WORKING]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual(['su-new']);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it("probes each owner from ITS OWN last fire, and only for owners the verdict condemned", async () => {
    const sql = fakeSql([
      { id: 'rt1', target_owner_id: 'su-a' },
      { id: 'rt2', target_owner_id: 'su-b' },
      { id: 'rt3', target_owner_id: 'su-healthy' },
    ]);
    const getStatuses = vi.fn(
      async () =>
        new Map([
          ['su-a', status({ turnsStalled: true, lastFiredAt: '2026-08-09T17:07:00.000Z' })],
          ['su-b', status({ turnsStalled: true, lastFiredAt: '2026-08-09T13:07:00.000Z' })],
          ['su-healthy', status({ turnsStalled: false })],
        ]),
    );
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map<string, OwnerToolActivity>());

    await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause: vi.fn<AutoPauseFn>(async () => {}), readOwnerToolActivity }),
    );

    const probes = readOwnerToolActivity.mock.calls[0][0];
    expect(probes).toEqual([
      { ownerId: 'su-a', sinceIso: '2026-08-09T17:07:00.000Z' },
      { ownerId: 'su-b', sinceIso: '2026-08-09T13:07:00.000Z' },
    ]);
  });

  it('a FAILING activity read falls back to the pre-WI-37546 behaviour, never a blanket veto', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(async () => new Map([['su-x', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => {
      throw new Error('tool_invocations unreachable');
    });

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ getStatuses, autoPause, readOwnerToolActivity }),
    );

    expect(res.vetoedByToolActivity).toEqual([]);
    expect(res.paused).toBe(1);
  });

  it('rethrows programmer errors from the activity reader instead of disabling the veto', async () => {
    const sql = fakeSql([{ id: 'rt1', target_owner_id: 'su-x' }]);
    const getStatuses = vi.fn(async () => new Map([['su-x', status({ turnsStalled: true })]]));
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => {
      throw new TypeError('sql.unsafe is not a function');
    });

    await expect(
      sweepStalledLoops(
        { sql, workspaceId: 'ws' },
        deps({ getStatuses, autoPause, readOwnerToolActivity }),
      ),
    ).rejects.toThrow(TypeError);
    expect(autoPause).not.toHaveBeenCalled();
  });
});

describe('sweepStalledLoops — recoverable disarm (WI-37546 sub-case B)', () => {
  const pausedAtMs = Date.parse('2026-08-09T17:07:00.000Z');
  const pauseReason = TURN_STALLED_PAUSE_PREFIX + ' candidate fixture';
  const candidate = (over: Partial<RevivableLoopCandidate> = {}) => ({
    routineId: 'rt-dead',
    ownerId: 'su-b8422496',
    installSlug: 'papercusp',
    routineName: 'loop-su-b8422496',
    pausedAtMs,
    pauseReason,
    revivedCount: 0,
    lastFiredAt: '2026-08-09 17:06:59.123456+00',
    consecutiveErrors: 0,
    ...over,
  });

  const deps = (over: Partial<StalledLoopsSweepDeps> = {}): StalledLoopsSweepDeps => ({
    probeReachability: reach(false),
    broadcast: vi.fn<BroadcastFn>(async () => true),
    notify: vi.fn<NotifyFn>(async () => {}),
    getStatuses: vi.fn(async () => new Map<string, LoopStatus>()),
    autoPause: vi.fn<AutoPauseFn>(async () => {}),
    readOwnerToolActivity: noActivity(),
    resetFireErrors: vi.fn<ResetFireErrorsFn>(async () => 0),
    ...over,
  });

  it('re-arms a wrongly-disarmed loop whose owner has since made progressing tool calls', async () => {
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.revivedAfterDisarm).toEqual(['su-b8422496']);
    expect(revive).toHaveBeenCalledTimes(1);
    expect(revive.mock.calls[0][1]).toBe('rt-dead');
    expect(revive.mock.calls[0][2]).toEqual({ pausedAtMs, pauseReason });
    expect(revive.mock.calls[0][3]).toContain('WI-37546');
  });

  it('recovers a RESUMABLE-DEAD pause only after a new real turn and progressing tool activity', async () => {
    const resumablePause = `${RESUMABLE_DEAD_PAUSE_PREFIX} (probe reports reachable via claude resume)`;
    const lastFiredAt = '2026-08-09 17:06:59.123456+00';
    const revive = vi.fn<ReviveFn>(async () => true);
    const resetFireErrors = vi.fn<ResetFireErrorsFn>(async () => 1);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate({
      pauseReason: resumablePause,
      lastFiredAt,
      consecutiveErrors: 8,
    })]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));
    const getStatuses = vi.fn(async () => new Map([[
      'su-b8422496',
      status({ turnsStalled: false, lastRealTurnAt: new Date(pausedAtMs + 1_000).toISOString() }),
    ]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, resetFireErrors, readRevivableLoops, readOwnerToolActivity, getStatuses }),
    );

    expect(res.revivedAfterDisarm).toEqual(['su-b8422496']);
    expect(revive).toHaveBeenCalledWith(
      expect.anything(),
      'rt-dead',
      { pausedAtMs, pauseReason: resumablePause },
      expect.stringContaining('EI-26879418910767205'),
    );
    expect(resetFireErrors).toHaveBeenCalledWith('papercusp', 'loop-su-b8422496', {
      workspaceId: 'ws',
      expectedLastFiredAt: lastFiredAt,
    });
  });

  it('does not recover RESUMABLE-DEAD from tool calls without a real post-pause turn', async () => {
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate({
      pauseReason: `${RESUMABLE_DEAD_PAUSE_PREFIX} (old resume circuit)`,
      consecutiveErrors: 8,
    })]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));
    const getStatuses = vi.fn(async () => new Map([[
      'su-b8422496',
      status({ turnsStalled: false, lastRealTurnAt: new Date(pausedAtMs - 1_000).toISOString() }),
    ]]));
    const resetFireErrors = vi.fn<ResetFireErrorsFn>(async () => 1);

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, resetFireErrors, readRevivableLoops, readOwnerToolActivity, getStatuses }),
    );

    expect(res.revivedAfterDisarm).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
    expect(resetFireErrors).not.toHaveBeenCalled();
  });

  it('keeps generic dead-owner pauses outside the revival path even with later owner activity', async () => {
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate({
      pauseReason: 'dead-owner: unreachable (no injectable/resumable wake channel)',
    })]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.revivedAfterDisarm).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
  });

  it('does not report a revival when the candidate pause snapshot lost the compare-and-set', async () => {
    const sql = fakeSql([]);
    const revive = vi.fn<ReviveFn>(async () => false);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    const res = await sweepStalledLoops(
      { sql, workspaceId: 'ws' },
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(revive).toHaveBeenCalledWith(
      sql,
      'rt-dead',
      { pausedAtMs, pauseReason },
      expect.stringContaining('WI-37546'),
    );
    expect(res.revivedAfterDisarm).toEqual([]);
  });

  it('THE EARLY-RETURN TRAP — revives even when the workspace has ZERO active loops left', async () => {
    // The state a fleet lands in once every loop has been disarmed. The rest of the sweep reads
    // this as "nothing to do"; it is precisely when a revival pass matters most.
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' }, // zero ACTIVE loop rows
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.checked).toBe(0);
    expect(res.revivedAfterDisarm).toEqual(['su-b8422496']);
    expect(revive).toHaveBeenCalledTimes(1);
  });

  it('CONTROL — a retry storm since the disarm does NOT earn a revival', async () => {
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', RETRY_STORM]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.revivedAfterDisarm).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
  });

  it('CONTROL — a genuinely silent owner stays disarmed', async () => {
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops, readOwnerToolActivity: noActivity() }),
    );

    expect(res.revivedAfterDisarm).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
  });

  it('probes activity from the DISARM time, and asks for candidates inside the documented bounds', async () => {
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map<string, OwnerToolActivity>());
    const before = Date.now();

    await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive: vi.fn<ReviveFn>(async () => true), readRevivableLoops, readOwnerToolActivity }),
    );

    const args = readRevivableLoops.mock.calls[0][0];
    expect(args.workspaceId).toBe('ws');
    expect(args.maxRevivals).toBe(MAX_REVIVALS);
    // The window is applied as a floor on the pause time, so a stale disarm is never revived.
    expect(args.pausedAfterMs).toBeGreaterThanOrEqual(before - REVIVE_WINDOW_MS);
    expect(args.pausedAfterMs).toBeLessThanOrEqual(Date.now() - REVIVE_WINDOW_MS);
    // The activity boundary is the DISARM, not the last fire: the question is what the owner has
    // done since we gave up on it.
    expect(readOwnerToolActivity.mock.calls[0][0]).toEqual([
      { ownerId: 'su-b8422496', sinceIso: new Date(pausedAtMs).toISOString() },
    ]);
  });

  it('does not re-disarm a loop it revived in the SAME sweep', async () => {
    // The revival flips `active = TRUE`, so the discovery query that runs after it returns the
    // very row just revived — still carrying the stale turnsStalled verdict, because its rescue
    // fire is scheduled for now() and has not happened. Without the skip the sweep would undo its
    // own repair and spend a bounded revival attempt doing it.
    const revive = vi.fn<ReviveFn>(async () => true);
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate({ ownerId: 'su-back' })]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-back', WORKING]]));
    const getStatuses = vi.fn(async () => new Map([['su-back', status({ turnsStalled: true })]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([{ id: 'rt-dead', target_owner_id: 'su-back' }]), workspaceId: 'ws' },
      deps({ revive, autoPause, readRevivableLoops, readOwnerToolActivity, getStatuses }),
    );

    expect(res.revivedAfterDisarm).toEqual(['su-back']);
    expect(res.paused).toBe(0);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('dryRun reports the revival without writing it', async () => {
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws', dryRun: true },
      deps({ revive, readRevivableLoops, readOwnerToolActivity }),
    );

    expect(res.revivedAfterDisarm).toEqual(['su-b8422496']);
    expect(revive).not.toHaveBeenCalled();
  });

  it('a FAILING candidate read revives nobody rather than throwing the sweep', async () => {
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => {
      throw new Error('routines unreachable');
    });

    const res = await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ revive, readRevivableLoops }),
    );

    expect(res.revivedAfterDisarm).toEqual([]);
    expect(revive).not.toHaveBeenCalled();
  });

  it('rethrows programmer errors from the revival activity reader', async () => {
    const revive = vi.fn<ReviveFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => {
      throw new ReferenceError('readOwnerToolActivity is undefined');
    });

    await expect(
      sweepStalledLoops(
        { sql: fakeSql([]), workspaceId: 'ws' },
        deps({ revive, readRevivableLoops, readOwnerToolActivity }),
      ),
    ).rejects.toThrow(ReferenceError);
    expect(revive).not.toHaveBeenCalled();
  });

  it('broadcasts a revival-only sweep under its OWN headline, not a starvation one', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => true);
    const readRevivableLoops = vi.fn<ReadRevivableFn>(async () => [candidate()]);
    const readOwnerToolActivity = vi.fn<ReadActivityFn>(async () => new Map([['su-b8422496', WORKING]]));

    await sweepStalledLoops(
      { sql: fakeSql([]), workspaceId: 'ws' },
      deps({ broadcast, revive: vi.fn<ReviveFn>(async () => true), readRevivableLoops, readOwnerToolActivity }),
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].summary).toContain('RE-ARMED');
    expect(broadcast.mock.calls[0][0].body).toContain('su-b8422496');
  });
});

describe('the DEFAULT revival candidate read carries the supersession bound (2026-08-18 incident)', () => {
  /**
   * The 2026-08-18 04:07:03Z sweep re-armed a loop whose owner had explicitly re-armed at
   * 00:18:52Z — superseding the 2026-08-17T21:07:03Z turn-stalled disarm — and then explicitly
   * `loop:end`'d at 03:44:18Z under a fleet stand-down. The candidate SQL matched the row anyway:
   * `loop_paused_reason`/`pause` are deliberately sticky (see the census test below), and nothing
   * compared the pause instant against `armed_at`, so the pass "compensated" a disarm the owner
   * had already compensated and undid an explicit owner `loop:end`.
   *
   * Same proof budget as the census test: this inspects the STATEMENT the default reader issues,
   * not a database. It pins the `armed_at`-vs-pause comparison into the query text, so removing
   * the bound breaks a named test instead of silently resurrecting explicitly-ended loops again.
   */
  it('selects only rows NOT armed since the pause instant it would compensate', async () => {
    const statements: string[] = [];
    const bindings: unknown[] = [];
    const captureSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(strings.join(' ? '));
      bindings.push(...values);
      return Promise.resolve([]);
    }) as never;

    await sweepStalledLoops(
      { sql: captureSql, workspaceId: 'ws' },
      {
        probeReachability: reach(false),
        broadcast: vi.fn<BroadcastFn>(async () => true),
        notify: vi.fn<NotifyFn>(async () => {}),
        getStatuses: vi.fn(async () => new Map<string, LoopStatus>()),
        autoPause: vi.fn<AutoPauseFn>(async () => {}),
        readOwnerToolActivity: noActivity(),
        // readRevivableLoops deliberately NOT injected: the DEFAULT reader's SQL is the subject.
      },
    );

    // Exactly one statement in the sweep selects on the disarm-reason prefix: the revival read.
    const revivalReads = statements.filter((s) => s.includes('loop_paused_reason'));
    expect(revivalReads).toHaveLength(1);
    const revivalSql = revivalReads[0];
    expect(revivalSql).toContain("r.metadata->>'loop_paused_reason'");
    expect(revivalSql).toContain('OR r.metadata->>');
    expect(bindings).toContain(TURN_STALLED_PAUSE_PREFIX + '%');
    expect(bindings).toContain(RESUMABLE_DEAD_PAUSE_PREFIX + '%');
    // The supersession bound, by its moving parts: the stamp every arm writes, compared against
    // the pause instant the revival would compensate, with absence failing toward revival.
    expect(revivalSql).toContain(`'armed_at'`);
    expect(revivalSql).toContain('to_timestamp');
    expect(revivalSql).toContain(`'-infinity'`);
    // And the pre-existing bounds are still in the same statement, not displaced by the new one.
    expect(revivalSql).toContain('loop_revived_count');
    expect(revivalSql).toContain('active = false');
  });
});

describe('end-after-DISARM: a loop:end with no intervening re-arm must exclude the row (WI-39786)', () => {
  /**
   * The shape the item's TITLE names, measured by its reporter (su-50a96a51, thread post 69711):
   * guard disarms at 02:07 -> owner `loop:end`s at 03:26 -> the deactivation no-ops (already
   * inactive), `armed_at` never advances, so the SUPERSESSION BOUND reads "not superseded" and
   * the sweep revives a loop its owner explicitly ended. The armed_at comparison structurally
   * CANNOT cover this shape — nothing it compares ever moves. The fix discriminates on the
   * reason-prefix predicate instead: `deactivateLoop` stamps `loop_paused_reason` with its own
   * prefix EVEN WHEN the loop is already inactive, so the revival read's
   * `LIKE TURN_STALLED_PAUSE_PREFIX || '%'` (pinned one describe down) no longer matches.
   *
   * Same proof budget as the neighbours: statement inspection, not a database. The chain is
   * (a) an already-inactive loop:end WRITES the stamp, (b) the stamped reason CANNOT match the
   * revival predicate's prefix, (c) the prior down-cause words survive under the superseded-copy
   * key (the census stays auditable), and the anti-drift test below keeps (b) honest against
   * the query's own prefix constant.
   */
  it('stamps loop_paused_reason on an ALREADY-INACTIVE row — the no-op path that hid the bug', async () => {
    const statements: string[] = [];
    const captureSql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join(' ? '));
      return Promise.resolve([]);
    }) as never;

    const ended = await deactivateLoop('su-50a96a51', { sql: captureSql, reason: 'standing down per fleet pause' });

    // The end still reports "no active loop crossed TRUE->FALSE" — the stamp is not a disarm.
    expect(ended).toBe(false);
    // One statement targets rows that are ALREADY inactive, and it writes the pause family.
    const inactiveStamps = statements.filter((s) => s.includes('active = FALSE') && !s.includes('active = TRUE'));
    expect(inactiveStamps).toHaveLength(1);
    const stamp = inactiveStamps[0]!;
    expect(stamp).toContain(`'loop_paused_reason'`);
    expect(stamp).toContain(`'loop_paused_at'`);
    // The canonical shape readStalePausedRoutines consumes — a deliberate end is an EXPLAINED
    // pause, not a reasonMissing flag.
    expect(stamp).toContain(`'pausedAtMs'`);
    // The prior down-cause is COPIED, never deleted (reviveDisarmedLoop's census constraint,
    // arriving at this write): the guard's words survive the owner's end.
    expect(stamp).toContain(`'loop_end_superseded_pause_reason'`);
    expect(stamp).not.toContain(`- 'loop_paused_reason'`);
    expect(stamp).not.toContain(`- 'pause'`);
  });

  it('stamps the ACTIVE path too, so end-after-re-arm is excluded by prefix as well as by armed_at', async () => {
    const statements: string[] = [];
    const captureSql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join(' ? '));
      return Promise.resolve([]);
    }) as never;

    await deactivateLoop('su-03eda174', { sql: captureSql });

    const activeEnd = statements.filter((s) => s.includes('active = TRUE'));
    expect(activeEnd).toHaveLength(1);
    expect(activeEnd[0]!).toContain(`'loop_paused_reason'`);
    expect(activeEnd[0]!).toContain(`'loop_end_superseded_pause_reason'`);
  });

  it('the stamped reason can NEVER match the revival predicate — the discriminator itself', () => {
    // The revival read matches `loop_paused_reason LIKE TURN_STALLED_PAUSE_PREFIX || '%'`
    // (prefix-anchored, no wildcards in the constant). A stamped reason always begins with
    // LOOP_END_PAUSE_PREFIX, so mutual prefix-exclusion is exactly the non-match proof.
    expect(LOOP_END_PAUSE_PREFIX.startsWith(TURN_STALLED_PAUSE_PREFIX)).toBe(false);
    expect(TURN_STALLED_PAUSE_PREFIX.startsWith(LOOP_END_PAUSE_PREFIX)).toBe(false);
    // LIKE treats % and _ as wildcards; the guard prefix must stay literal or the anchored
    // comparison above stops being a proof.
    expect(TURN_STALLED_PAUSE_PREFIX).not.toMatch(/[%_]/);
  });
});

describe('reviveDisarmedLoop must not blind the census that judges it (WI-37546, peer review 56734)', () => {
  /**
   * The first draft of this write cleared `pause` and `loop_paused_reason` as "no longer true".
   * `loop_paused_reason` is the key WI-37546's OWN census — and the Falsifier that item stakes
   * itself on — selects with (`ILIKE '%stalled-loops-guard%'`). Deleting it drops every rescued
   * row out of the population, so "the veto works" and "the guard stopped disarming anyone"
   * collapse into the same shrinking number.
   *
   * ⚠ WHAT THIS TEST CAN AND CANNOT PROVE. It inspects the STATEMENT, not a database: it proves
   * the write does not ask Postgres to remove those keys, which is exactly the regression to
   * guard (someone re-adding the `- 'loop_paused_reason'` cleanup). It does NOT prove the census
   * still matches end-to-end — only a run against a real row does that.
   */
  it('leaves the disarm record intact and only ADDS the revival keys', async () => {
    const statements: string[] = [];
    const bindings: unknown[] = [];
    const selectedPause = {
      pausedAtMs: Date.parse('2026-08-09T17:07:00.000Z'),
      pauseReason: TURN_STALLED_PAUSE_PREFIX + ' selected candidate',
    };
    const captureSql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(strings.join(' ? '));
      bindings.push(...values);
      return Promise.resolve([]);
    }) as never;

    await reviveDisarmedLoop(captureSql, 'rt-dead', selectedPause, 'revived because the owner is working');

    expect(statements).toHaveLength(1);
    const sql = statements[0];
    // The census key, and the canonical pause shape, must survive the revive.
    expect(sql).not.toContain(`- 'loop_paused_reason'`);
    expect(sql).not.toContain(`- 'pause'`);
    // The revival is recorded additively, including the ratchet that bounds the flap.
    expect(sql).toContain('loop_revived_at');
    expect(sql).toContain('loop_revived_count');
    // A revival IS an arm: it restamps the arm epoch (the stampLoopArmedAt pair), so an owner
    // who loop:end's the revived loop reads as end-after-arm and the supersession bound in
    // readRevivableLoops excludes the row instead of letting the next sweep undo the end
    // (2026-08-18 incident, loop-su-50a96a51).
    expect(sql).toContain(`'armed_at'`);
    expect(sql).toContain(`'fire_count_at_arm'`);
    // And it only ever crosses back over a genuinely disarmed row.
    expect(sql).toContain('active = FALSE');
    expect(sql).toContain("metadata->>'loop_paused_reason' =");
    expect(sql).toContain("(metadata->'pause'->>'pausedAtMs')::bigint =");
    expect(bindings).toContain(selectedPause.pauseReason);
    expect(bindings).toContain(selectedPause.pausedAtMs);
  });
});

describe('the disarm reason and the revival predicate are ONE string (WI-37546 anti-drift)', () => {
  /**
   * The load-bearing pairing, and the one a reader cannot check by eye: the revival query selects
   * `metadata->>'loop_paused_reason' LIKE TURN_STALLED_PAUSE_PREFIX || '%'`. If the disarm ever
   * stops writing a reason that starts with that exact prefix, the revival pass silently matches
   * NOTHING — and a revival pass that finds nobody looks identical to one that had nobody to find.
   *
   * Asserted against the reason this module ACTUALLY writes, so a reword breaks this test rather
   * than the recovery path.
   */
  it('the reason autoPause receives is selected by the prefix the revival query uses', async () => {
    const autoPause = vi.fn<AutoPauseFn>(async () => {});
    const getStatuses = vi.fn(async () => new Map([['su-dead', status({ turnsStalled: true })]]));

    await sweepStalledLoops(
      { sql: fakeSql([{ id: 'rt1', target_owner_id: 'su-dead' }]), workspaceId: 'ws' },
      {
        getStatuses,
        autoPause,
        probeReachability: reach(false),
        broadcast: vi.fn<BroadcastFn>(async () => true),
        notify: vi.fn<NotifyFn>(async () => {}),
        readOwnerToolActivity: noActivity(),
        readRevivableLoops: noRevivable(),
      },
    );

    const reason = autoPause.mock.calls[0][2];
    expect(reason.startsWith(TURN_STALLED_PAUSE_PREFIX)).toBe(true);
    // Keep the old prefix specific; only the separate RESUMABLE-DEAD prefix is allowed through
    // the narrowly evidenced recovery path.
    expect(TURN_STALLED_PAUSE_PREFIX).toContain('turns-stalled');
    expect(TURN_STALLED_PAUSE_PREFIX).not.toContain('dead-owner');
    expect(RESUMABLE_DEAD_PAUSE_PREFIX).toBe('dead-owner: RESUMABLE-DEAD');
    expect(RESUMABLE_DEAD_PAUSE_PREFIX).not.toMatch(/[%_]/);
  });
});
