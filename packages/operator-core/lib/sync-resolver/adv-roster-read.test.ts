import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { projectAdvRoster, type RosterSnapshot } from './adv-roster-read';

describe('header roster projection', () => {
  it('preserves between-turn lifecycle facts while dropping large details', () => {
    const live = { ownerId: 'live', sessionState: 'live', transcriptFresh: true,
      machineLabel: 'desktop', isLocal: true, fleetSlug: 'repair', fleetColor: '#123456',
      checkpoint: 'large checkpoint'.repeat(1000), intent: 'large intent'.repeat(1000) };
    const snapshot = { active: [live, { ...live, ownerId: 'parked', sessionState: 'parked' }],
      ended: [live], pending: [live], starting: [], orphanedClaims: [],
      degradedFields: [{ field: 'ended', kind: 'read-failed', reason: 'unavailable' }] } as unknown as RosterSnapshot;
    const header = projectAdvRoster(snapshot, 'header');
    expect(header.active).toEqual(['live', 'parked'].map((sessionState) => ({
      ownerId: sessionState, sessionState, liveness: undefined, loopArmed: undefined, transcriptFresh: true,
      thinking: undefined, machineLabel: 'desktop', isLocal: true, fleetSlug: 'repair', fleetColor: '#123456',
    })));
    expect(header).toHaveProperty('degradedFields', snapshot.degradedFields);
    expect(header).not.toHaveProperty('ended');
    expect(JSON.stringify(header)).not.toContain('large');
    expect(projectAdvRoster(snapshot)).toBe(snapshot);
  });
});

/**
 * adv-roster-read — the read deadline on the Sessions roster fan-out (WI-39825).
 *
 * Every case here HANGS a leg rather than rejecting it, because a hang is the
 * failure the pre-WI-39825 code could not survive and a rejection is the one it
 * already could. Four legs fan out under one `Promise.all`, which waits for the
 * slowest: one wedged store took the whole roster past the sync layer's
 * `RESOLVER_READ_TIMEOUT_MS` and the Sessions view rendered nothing at all. This
 * is a POLLED query behind the header pill and the Agents tile, so that is not a
 * one-off 500 — it is every poll, for as long as the store stays slow.
 *
 * The subject is `readAdvRoster` and not the `advRoster.list` resolver,
 * deliberately: proving a deadline fires requires MOVING it, and a resolver's
 * only input is its wire `argsSchema`, so a resolver-level guard would have to
 * either ship a `budgetMs` test knob to every client or genuinely wait the 6s
 * budget out (blowing vitest's 5s default). `budgetMs` is a FUNCTION parameter
 * on the extracted read, so the budget here is milliseconds and the shipped
 * contract is untouched. See the module header for the full reasoning.
 *
 * The CONTROL and CALIBRATION cases are PERMANENT, per CLAUDE.md's falsifiability
 * tiers: this subject is imported, so the deliberately-wrong version lives in the
 * test file as a control rather than being produced by mutating the tree.
 */

const mergeRosterWithAssignments = vi.fn();
const listEndedAdvSessions = vi.fn();
const listPendingWorkbenchLaunches = vi.fn();
const listStartingTerminalLaunches = vi.fn();

// The pure projection/dedupe helpers are pass-throughs here so that what the
// snapshot reports about a leg is exactly what that leg returned — the point
// under test is which legs SURVIVE a wedge, not how rows are shaped afterwards
// (that is `adv-roster`'s own suite).
vi.mock('../adv-roster', () => ({
  mergeRosterWithAssignments: (...a: unknown[]) => mergeRosterWithAssignments(...a),
  dedupeEndedAgainstActive: (ended: unknown) => ended,
  pendingLaunchesToRosterEntries: (rows: unknown) => rows,
  startingLaunchesToRosterEntries: (rows: unknown) => rows,
  readStartingLaunchLogHints: async () => new Map(),
  dedupeStartingAgainstActive: (starting: unknown) => starting,
}));

// Spread the real module rather than enumerating the three legs this file drives.
// A bare `() => ({ ... })` factory lists only the exports the subject imports
// TODAY, so the next export added to adv-sessions (45 and counting) strands this
// file and reds the fleet gate hours later, in a file its author never touched.
// That is WI-7185/WI-7187, and this file was the 28th occurrence; the spread form
// is immune BY CONSTRUCTION and `lint:full-replacement-mocks` enforces it here.
vi.mock('../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../adv-sessions')>()),
  listEndedAdvSessions: (...a: unknown[]) => listEndedAdvSessions(...a),
  listPendingWorkbenchLaunches: (...a: unknown[]) => listPendingWorkbenchLaunches(...a),
  listStartingTerminalLaunches: (...a: unknown[]) => listStartingTerminalLaunches(...a),
}));

import {
  readAdvRoster,
  ROSTER_READ_BUDGET_MS,
  ROSTER_CACHE_FRESH_MS,
  ROSTER_CACHE_STALE_MS,
  _resetRosterCacheForTests,
} from './adv-roster-read';

/**
 * Pay the real `../adv-sessions` module-load cost ONCE, outside any timed window.
 *
 * The mock above spreads the real module, and adv-sessions is ~96KB that pulls in
 * `@papercusp/db-org` — a multi-second first import. Every deadline case below
 * races a millisecond-scale budget against a 120-500ms observation window, so if
 * that load lands inside the first timed case it eats the whole window and the
 * case reports `pending` — i.e. a PASSING deadline reads as a broken one. Warming
 * it here moves a fixed setup cost out of the measurement, and changes nothing
 * about what is measured: the budgets, the windows and the assertions are
 * untouched. Without this, the spread form and these timings cannot coexist.
 */
beforeAll(async () => {
  await import('../adv-sessions');
}, 60_000);

beforeEach(() => {
  mergeRosterWithAssignments.mockReset().mockResolvedValue({ active: [], orphanedClaims: [] });
  listEndedAdvSessions.mockReset().mockResolvedValue([]);
  listPendingWorkbenchLaunches.mockReset().mockResolvedValue([]);
  listStartingTerminalLaunches.mockReset().mockResolvedValue([]);
});

/** A store read that never settles — the wedge, not a rejection. */
const hang = () => new Promise<never>(() => {});

type Roster = {
  active: unknown[];
  ended: unknown[];
  pending: unknown[];
  starting: unknown[];
  orphanedClaims: unknown[];
  degradedFields?: Array<{ field: string; kind: string; reason: string }>;
};
type Settled =
  | { kind: 'resolved'; roster: Roster }
  | { kind: 'rejected'; message: string }
  | { kind: 'pending' };

/**
 * Observe WITHOUT waiting forever. "Never settles" is the failure mode under
 * test, so it has to be an assertable OUTCOME (`pending`) rather than a vitest
 * timeout — a timeout would report the control as a broken test instead of as
 * the guard discriminating correctly.
 */
const settleWithin = (p: Promise<unknown>, ms: number): Promise<Settled> =>
  Promise.race([
    p.then(
      (roster): Settled => ({ kind: 'resolved', roster: roster as Roster }),
      (error): Settled => ({ kind: 'rejected', message: String((error as Error)?.message ?? error) }),
    ),
    new Promise<Settled>((resolve) => {
      const t = setTimeout(() => resolve({ kind: 'pending' }), ms);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);

const read = (budgetMs: number) => readAdvRoster({ workspaceId: 'ws-test', budgetMs });

describe('readAdvRoster — the read deadline (WI-39825)', () => {
  it('the shipped budget sits under the resolver timeout it exists to beat', async () => {
    // Not a tautology: a budget at or above RESOLVER_READ_TIMEOUT_MS cannot
    // prevent the timeout, so the bound would be decorative. The relationship
    // is the invariant, and it is the one a later "just bump the budget" breaks.
    const { RESOLVER_READ_TIMEOUT_MS } = await import('./read-deadline');
    expect(ROSTER_READ_BUDGET_MS).toBeLessThan(RESOLVER_READ_TIMEOUT_MS);
  });

  // PRIMARY leg. `active` IS the roster: a snapshot without it is not a degraded
  // roster but a wrong one — an empty fleet reads as "nothing is running", the
  // most misleading thing this view can say. So a lapse PROPAGATES, exactly as a
  // throw from that reader already does. The gain is a fast, LABELLED failure at
  // the budget instead of a hang the resolver timeout converts into nothing.
  it('a hung PRIMARY leg (active) is REJECTED at the budget instead of hanging the read', async () => {
    mergeRosterWithAssignments.mockReturnValue(hang());

    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('rejected');
    // The label is the point: a bare timeout hides WHICH leg wedged, which is
    // the first thing anyone triaging a spinning roster needs.
    expect(outcome.kind === 'rejected' && outcome.message).toContain(
      'roster active exceeded the read budget',
    );
  });

  it('CONTROL: the same hung leg NEVER settles when the bound is widened — so it is the deadline doing the work', async () => {
    mergeRosterWithAssignments.mockReturnValue(hang());

    // The deliberately-wrong version: a budget so large it cannot fire, which IS
    // the pre-WI-39825 behaviour. If this ever reports anything but `pending`,
    // the case above has stopped measuring the deadline and passes for some
    // other reason.
    const outcome = await settleWithin(read(10_000_000), 120);

    expect(outcome.kind).toBe('pending');
  });

  it('CALIBRATION: a healthy read still returns its roster under the same tight budget', async () => {
    // Guards the opposite failure: a bound that "passes" every case above by
    // breaking every read, healthy or not. Same 25ms budget, working store.
    mergeRosterWithAssignments.mockResolvedValue({
      active: [{ id: 'agent-1' }],
      orphanedClaims: [{ id: 'WI-1' }],
    });
    listEndedAdvSessions.mockResolvedValue([{ id: 'ended-1' }]);
    listPendingWorkbenchLaunches.mockResolvedValue([{ id: 'pending-1' }]);
    listStartingTerminalLaunches.mockResolvedValue([{ id: 'starting-1' }]);

    const outcome = await settleWithin(read(25), 500);

    expect(outcome.kind).toBe('resolved');
    const roster = outcome.kind === 'resolved' ? outcome.roster : null;
    expect(roster?.active).toEqual([{ id: 'agent-1' }]);
    expect(roster?.ended).toEqual([{ id: 'ended-1' }]);
    expect(roster?.pending).toEqual([{ id: 'pending-1' }]);
    expect(roster?.starting).toEqual([{ id: 'starting-1' }]);
    expect(roster?.orphanedClaims).toEqual([{ id: 'WI-1' }]);
    // A healthy roster stays byte-identical to what it was before the bound:
    // the flag's PRESENCE is the signal, so it must be absent, not empty.
    expect(roster?.degradedFields).toBeUndefined();
  });

  // SUPPLEMENTARY legs render empty perfectly well, so their lapse costs their
  // own section and nothing else. This is the partial the whole class-fix exists
  // to preserve: the fleet still ships.
  for (const [field, mockFn, label] of [
    ['ended', () => listEndedAdvSessions, 'roster ended'],
    ['pending', () => listPendingWorkbenchLaunches, 'roster pending'],
    ['starting', () => listStartingTerminalLaunches, 'roster starting'],
  ] as const) {
    it(`a hung SUPPLEMENTARY leg (${field}) lands as a NAMED degradedFields entry and the roster still ships`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mergeRosterWithAssignments.mockResolvedValue({ active: [{ id: 'agent-1' }], orphanedClaims: [] });
      mockFn().mockReturnValue(hang());

      const outcome = await settleWithin(read(25), 500);
      warn.mockRestore();

      expect(outcome.kind).toBe('resolved');
      const roster = outcome.kind === 'resolved' ? outcome.roster : null;
      // The intact legs are TRUE, not sacrificed to the wedged one.
      expect(roster?.active).toEqual([{ id: 'agent-1' }]);
      expect(roster?.[field]).toEqual([]);
      // ...and the casualty is NAMED. Without this the empty section is
      // indistinguishable from "no sessions have ended" / "nothing is booting",
      // which is exactly the calm-and-empty answer the in-place `.catch(() => [])`
      // used to give and the degradedFields channel exists to prevent.
      const degraded = roster?.degradedFields ?? [];
      expect(degraded.map((d) => d.field)).toEqual([field]);
      expect(degraded[0]?.reason).toContain(`${label} exceeded the read budget`);
      // Classified as a read failure, NOT a new `timed-out` kind: UnavailableKind
      // is a shared union the client degraded-provenance guards consume, and
      // widening it to say what the verbatim reason already says would strand
      // them for no information gain.
      expect(degraded[0]?.kind).toBe('read-failed');
    });

    it(`a REJECTING supplementary leg (${field}) is named too, not swallowed into an empty section`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFn().mockRejectedValue(new Error('relation "adv_sessions" does not exist'));

      const outcome = await settleWithin(read(25), 500);
      warn.mockRestore();

      expect(outcome.kind).toBe('resolved');
      const roster = outcome.kind === 'resolved' ? outcome.roster : null;
      expect(roster?.[field]).toEqual([]);
      const degraded = roster?.degradedFields ?? [];
      expect(degraded.map((d) => d.field)).toEqual([field]);
      expect(degraded[0]?.reason).toContain('does not exist');
    });
  }
});

/**
 * readAdvRoster — the stale-while-revalidate cache (EI-22091013068319789).
 *
 * MEASURED 2026-09-01: readAdvRosterUncached took 3.1-6.3s at 193 active rows
 * on the green operator under load, and this is a POLLED query (the header
 * pill's 5s interval, plus the cross-origin portal, the Sessions view, and
 * every open tab) with no de-dup between callers hitting the same key — so
 * that cost was paid on every tick, by every consumer. This describe block
 * pins the cache LAYER (`readAdvRoster`) that wraps the deadline-bound read
 * proven above; it never exercises the underlying legs' timeout behavior,
 * which is what the describe block above already owns.
 *
 * Every case drives the cache with an injected `nowMs` rather than real or
 * fake timers — same reasoning as `budgetMs`: `nowMs` is a FUNCTION parameter
 * (see the module header), never a wire field, so a boundary can be crossed
 * by moving a number instead of waiting or mocking the global clock. That
 * matters doubly here because `readAdvRosterUncached`'s first await is a
 * dynamic `import('node:os')`, which interacts unpredictably with
 * `vi.useFakeTimers()` + `setSystemTime()` (see the module's `nowMs` doc).
 */
describe('readAdvRoster — the stale-while-revalidate cache (EI-22091013068319789)', () => {
  beforeEach(() => {
    // A module-scoped cache map outlives any one test; start every case cold
    // so a passing assertion here can never be an artifact of another test's
    // leftover entry under the same key.
    _resetRosterCacheForTests();
  });

  it('a FRESH cache hit (age < ROSTER_CACHE_FRESH_MS) is served with NO extra read', async () => {
    let now = 1_000;
    const nowMs = () => now;
    mergeRosterWithAssignments.mockResolvedValueOnce({ active: [{ id: 'v1' }], orphanedClaims: [] });

    const first = await readAdvRoster({ workspaceId: 'ws-fresh', nowMs });
    expect(first.active).toEqual([{ id: 'v1' }]);
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(1);

    now += ROSTER_CACHE_FRESH_MS - 1; // still inside the fresh window
    const second = await readAdvRoster({ workspaceId: 'ws-fresh', nowMs });
    expect(second.active).toEqual([{ id: 'v1' }]); // the same cached snapshot
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(1); // no extra read
  });

  it('a STALE cache hit (FRESH_MS <= age < STALE_MS) is served IMMEDIATELY while ONE background refresh runs', async () => {
    let now = 1_000;
    const nowMs = () => now;
    mergeRosterWithAssignments.mockResolvedValueOnce({ active: [{ id: 'v1' }], orphanedClaims: [] });

    const first = await readAdvRoster({ workspaceId: 'ws-stale', nowMs });
    expect(first.active).toEqual([{ id: 'v1' }]);

    mergeRosterWithAssignments.mockResolvedValueOnce({ active: [{ id: 'v2' }], orphanedClaims: [] });
    now += ROSTER_CACHE_FRESH_MS + 1; // stale, but not yet past STALE_MS
    const second = await readAdvRoster({ workspaceId: 'ws-stale', nowMs });
    // The OLD snapshot, served immediately — the caller never blocks on the refresh.
    expect(second.active).toEqual([{ id: 'v1' }]);

    // Let the fire-and-forget background refresh (readAdvRoster never awaits
    // it) settle before inspecting its effect.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(2); // exactly one background refresh

    // A later read, within FRESH_MS of the BACKGROUND refresh's own
    // computedAt, observes the refreshed value with no further read.
    now += 1;
    const third = await readAdvRoster({ workspaceId: 'ws-stale', nowMs });
    expect(third.active).toEqual([{ id: 'v2' }]);
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(2);
  });

  it('past STALE_MS the cache is NOT re-served — the caller blocks on a genuinely fresh read', async () => {
    let now = 1_000;
    const nowMs = () => now;
    mergeRosterWithAssignments.mockResolvedValueOnce({ active: [{ id: 'v1' }], orphanedClaims: [] });
    await readAdvRoster({ workspaceId: 'ws-verystale', nowMs });

    mergeRosterWithAssignments.mockResolvedValueOnce({ active: [{ id: 'v-fresh' }], orphanedClaims: [] });
    now += ROSTER_CACHE_STALE_MS + 1;
    const result = await readAdvRoster({ workspaceId: 'ws-verystale', nowMs });

    // The old value is gone entirely — a genuinely fresh read, not a stale re-serve.
    expect(result.active).toEqual([{ id: 'v-fresh' }]);
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(2);
  });

  it('different cache keys (distinct workspaceId) never share an entry', async () => {
    const nowMs = () => 1_000;
    mergeRosterWithAssignments
      .mockResolvedValueOnce({ active: [{ id: 'ws-a' }], orphanedClaims: [] })
      .mockResolvedValueOnce({ active: [{ id: 'ws-b' }], orphanedClaims: [] });

    const a = await readAdvRoster({ workspaceId: 'ws-A', nowMs });
    const b = await readAdvRoster({ workspaceId: 'ws-B', nowMs });

    expect(a.active).toEqual([{ id: 'ws-a' }]);
    expect(b.active).toEqual([{ id: 'ws-b' }]);
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(2);

    // Re-reading either, still fresh, hits its OWN entry — no cross-talk.
    const aAgain = await readAdvRoster({ workspaceId: 'ws-A', nowMs });
    const bAgain = await readAdvRoster({ workspaceId: 'ws-B', nowMs });
    expect(aAgain.active).toEqual([{ id: 'ws-a' }]);
    expect(bAgain.active).toEqual([{ id: 'ws-b' }]);
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(2); // still just the original two
  });

  it('an explicit budgetMs BYPASSES the cache even on a fresh hit — every call is a real read', async () => {
    const nowMs = () => 1_000;
    mergeRosterWithAssignments
      .mockResolvedValueOnce({ active: [{ id: 'cached' }], orphanedClaims: [] })
      .mockResolvedValueOnce({ active: [{ id: 'bypassed' }], orphanedClaims: [] });

    const cached = await readAdvRoster({ workspaceId: 'ws-bypass', nowMs });
    expect(cached.active).toEqual([{ id: 'cached' }]);
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(1);

    // Same key, well within FRESH_MS — a normal call would hit the cache above.
    const bypassed = await readAdvRoster({ workspaceId: 'ws-bypass', budgetMs: 25, nowMs });
    expect(bypassed.active).toEqual([{ id: 'bypassed' }]); // a genuinely fresh, uncached read
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers racing a COLD key share exactly ONE underlying read', async () => {
    const nowMs = () => 1_000;
    mergeRosterWithAssignments.mockResolvedValue({ active: [{ id: 'shared' }], orphanedClaims: [] });

    // No await between the two calls: both must observe the cache as cold and
    // race into the SAME dedupeInFlight entry, not each start their own read.
    const [a, b] = await Promise.all([
      readAdvRoster({ workspaceId: 'ws-race', nowMs }),
      readAdvRoster({ workspaceId: 'ws-race', nowMs }),
    ]);

    expect(a.active).toEqual([{ id: 'shared' }]);
    expect(b.active).toEqual([{ id: 'shared' }]);
    expect(mergeRosterWithAssignments).toHaveBeenCalledTimes(1); // one read, not two
  });
});
