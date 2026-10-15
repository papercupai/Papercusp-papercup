/**
 * goal-headcount-liveness.test.ts — WI-10005672.
 *
 * THE EXECUTABLE SPEC: `goalHeadcount` counts a session against a goal's
 * `maxAgents` / `maxPerFleet` ceiling by the SHARED liveness oracle's verdict,
 * not by raw heartbeat freshness.
 *
 * Heartbeat freshness is process KEEPALIVE. A session the oracle calls `ended`
 * (a confirmed-dead pid, a wake that was never picked up, ...) can still carry a
 * heartbeat inside GOAL_HEADCOUNT_STALE_MS, and before this fix it kept counting
 * against the ceiling — so a goal's relaunch right after its members died was
 * refused or under-admitted although zero agents were alive.
 *
 * THE SHAPE. Two layers, because each proves what the other cannot:
 *   • a FAKE oracle parametrised over EVERY SessionState pins the exclusion rule
 *     (exactly `ended` is removed; `recorded` — "authoritatively LIVE per the
 *     session log" — and an unmeasured `null` verdict are NOT);
 *   • the REAL oracle (`deriveVerdict` via `resolveSessionStates`, PG-free seams)
 *     with a PAIR of subjects differing only in the pid probe: the live twin is a
 *     positive control proving the setup really produces a counted state, so a
 *     green `ended` twin cannot be an artifact of a subject that was never alive.
 * A mock cannot prove the SQL; the json_agg shape was run against live PG
 * (see the work-item completion), and the tolerant parser is pinned below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { LivenessSubject, LivenessVerdict, ResolveSessionStatesOpts } from './agent-tools/coordination/liveness-oracle';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';
import { goalHeadcount } from './goal-launch-settings';

const oracle = vi.hoisted(() => ({
  /** When set, replaces the oracle wholesale (fake layer). */
  fake: null as null | ((subjects: readonly { ownerId: string }[]) => Map<string, unknown>),
  /** Otherwise the REAL oracle runs with these PG-free seams (real layer). */
  realOpts: {} as Record<string, unknown>,
  seen: [] as Array<readonly LivenessSubject[]>,
}));

vi.mock('./agent-tools/coordination/liveness-oracle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-tools/coordination/liveness-oracle')>();
  return {
    ...actual,
    resolveSessionStates: async (subjects: readonly LivenessSubject[], opts: ResolveSessionStatesOpts = {}) => {
      oracle.seen.push(subjects);
      if (oracle.fake) return oracle.fake(subjects) as Map<string, LivenessVerdict>;
      return actual.resolveSessionStates(subjects, { ...opts, ...(oracle.realOpts as ResolveSessionStatesOpts) });
    },
  };
});

beforeEach(() => {
  oracle.fake = null;
  oracle.realOpts = {};
  oracle.seen = [];
});

const WS = 'ws-1';
const GOAL = 'goal-1';
const FLEET = 'fleet-a';

/** One tagged-template Sql that answers the headcount query with `row`. */
function fakeSql(row: Record<string, unknown>): Sql {
  const fn = () => Promise.resolve([row]);
  return fn as unknown as Sql;
}

const presence = (ownerId: string, inFleet = true, over: Record<string, unknown> = {}) => ({
  ownerId,
  inFleet,
  heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
  host: 'test-host',
  pid: 4242,
  source: 'omp-hook-session',
  ...over,
});

const verdicts = (byOwner: Record<string, SessionState | null>) => (subjects: readonly { ownerId: string }[]) =>
  new Map(
    subjects.map((s) => [
      s.ownerId,
      { ownerId: s.ownerId, sessionState: byOwner[s.ownerId] ?? null, wakeable: true, liveTurn: false },
    ]),
  );

const count = (row: Record<string, unknown>, fleetSlug: string | null = FLEET) =>
  goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug, sql: fakeSql(row) });

describe('goalHeadcount — admission population evidence (EI-25166050736574344)', () => {
  const measuredAt = '2026-10-05 18:40:16+00';
  const member = (ownerId: string, inFleet: boolean, basis = 'heartbeat') => ({
    ownerId, inFleet, basis, heartbeatAt: basis === 'heartbeat' ? measuredAt : null,
    briefUpdatedAt: measuredAt,
  });

  it('retains recorded and boot-grace owners, excluding ended and replacement owners in the SAME count', async () => {
    oracle.fake = verdicts({ recorded: 'recorded', ended: 'ended' });
    const query = vi.fn(async () => [{
      total: 3, fleet: 2, measured_at: measuredAt,
      presence_rows: [presence('recorded'), presence('ended')],
      population_rows: [member('recorded', true), member('ended', true), member('boot', false, 'boot-grace')],
    }]);
    const result = await goalHeadcount({
      workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, excludeOwnerIds: ['replacement', 'replacement'],
      sql: query as unknown as Sql,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(result.headcount).toEqual({ total: 2, fleet: 1 });
    expect(result.measurement).toEqual({
      measuredAt, populationComplete: true, candidate: { total: 3, fleet: 2 },
      counted: [member('recorded', true), member('boot', false, 'boot-grace')],
      oracleEndedOwnerIds: ['ended'], excludedOwnerIds: ['replacement'],
    });
    expect(oracle.seen[0].map((subject) => subject.ownerId)).toEqual(['recorded', 'ended']);
  });

  it('marks missing or inconsistent population as incomplete rather than proving an empty census', async () => {
    oracle.fake = verdicts({});
    for (const population_rows of [undefined, 'invalid json', [member('only-one', true)]]) {
      const result = await count({ total: 5, fleet: 1, measured_at: measuredAt, population_rows });
      expect(result.headcount).toEqual({ total: 5, fleet: 1 });
      expect(result.measurement?.populationComplete).toBe(false);
    }
  });

  it('distinguishes one new launch plus an existing actor becoming countable from two new launches', async () => {
    oracle.fake = verdicts({});
    const baseline = Array.from({ length: 5 }, (_, index) => member(`existing-${index}`, index === 0));
    const launched = member('sole-new-launch', true);
    const previouslyUncounted = member('existing-attribution-transition', true);
    const populations = [baseline, [...baseline, launched], [...baseline, launched, previouslyUncounted]];
    const results = await Promise.all(populations.map((population_rows) => count({
      total: population_rows.length, fleet: population_rows.filter((row) => row.inFleet).length,
      measured_at: measuredAt, population_rows,
    })));
    expect(results.map((result) => result.headcount)).toEqual([
      { total: 5, fleet: 1 }, { total: 6, fleet: 2 }, { total: 7, fleet: 3 },
    ]);
    expect(results[2].measurement?.counted.map((row) => row.ownerId)).toContain('existing-attribution-transition');
    expect(results.every((result) => result.measurement?.populationComplete)).toBe(true);
  });
});

describe('goalHeadcount — liveness comes from the shared oracle, not a heartbeat window (WI-10005672)', () => {
  it('keeps the heartbeat/boot-grace count untouched when there is no presence row to judge', async () => {
    // Boot-grace-only population: counted by the SQL, has no presence to judge.
    const r = await count({ total: 2, fleet: 0 });
    expect(r).toEqual({ headcount: { total: 2, fleet: 0 }, error: null, measurement: {
      measuredAt: null, populationComplete: false, candidate: { total: 2, fleet: 0 },
      counted: [], oracleEndedOwnerIds: [], excludedOwnerIds: [],
    } });
    expect(oracle.seen).toEqual([]); // the oracle is not even paid for
  });

  // EI-24909345582884838 — a respawn is net-zero on headcount, so the member being replaced must
  // not occupy a seat while its replacement is admitted. The exclusion lives in the SQL (the
  // session row never reaches the oracle), so these capture the tagged template and pin that the
  // set is bound as a deduped `text[]` against `b.owner_id <> ALL(...)`.
  const capturingSql = () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([{ total: 2, fleet: 1 }]);
    };
    return { sql: fn as unknown as Sql, calls };
  };

  it('binds excludeOwnerIds (deduped, empty ids dropped) as a text[] exclusion in the headcount SQL', async () => {
    const { sql, calls } = capturingSql();
    const r = await goalHeadcount({
      workspaceId: WS,
      goalId: GOAL,
      fleetSlug: FLEET,
      excludeOwnerIds: ['o-old', '', 'o-old', 'o-other'],
      sql,
    });
    expect(r).toEqual({ headcount: { total: 2, fleet: 1 }, error: null, measurement: {
      measuredAt: null, populationComplete: false, candidate: { total: 2, fleet: 1 },
      counted: [], oracleEndedOwnerIds: [], excludedOwnerIds: ['o-old', 'o-other'],
    } });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/b\.owner_id <> ALL\(\?::text\[\]\)/);
    expect(calls[0].values).toContainEqual(['o-old', 'o-other']);
  });

  it('binds an EMPTY exclusion when none is given — `<> ALL` over the empty set admits every row', async () => {
    const { sql, calls } = capturingSql();
    await goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toContainEqual([]);
  });

  it('RECURRENCE GUARD: removes exactly the sessions the oracle calls `ended` — for EVERY SessionState', async () => {
    const states: Array<SessionState | null> = ['live', 'parked', 'draining', 'suspect', 'ended', 'recorded', null];
    for (const state of states) {
      oracle.fake = verdicts({ 'o-x': state });
      const r = await count({ total: 1, fleet: 1, presence_rows: [presence('o-x')] });
      const expected = state === 'ended' ? 0 : 1;
      expect(r.error, `state=${state}`).toBeNull();
      expect(r.headcount.total, `total for ${state}`).toBe(expected);
      expect(r.headcount.fleet, `fleet for ${state}`).toBe(expected);
    }
  });

  it('subtracts per-fleet only for ended sessions that were in the fleet, and leaves boot-grace rows counted', async () => {
    // total 4 = 1 boot-grace (no presence) + live-in-fleet + ended-in-fleet + ended-elsewhere
    oracle.fake = verdicts({ live1: 'live', gone1: 'ended', gone2: 'ended' });
    const r = await count({
      total: 4,
      fleet: 2,
      presence_rows: [presence('live1', true), presence('gone1', true), presence('gone2', false)],
    });
    expect(r.headcount).toEqual({ total: 2, fleet: 1 });
    // Only presence-bearing rows were judged, with the inputs the oracle needs.
    expect(oracle.seen).toHaveLength(1);
    expect(oracle.seen[0].map((s) => s.ownerId)).toEqual(['live1', 'gone1', 'gone2']);
    expect(oracle.seen[0][0]).toMatchObject({ host: 'test-host', pid: 4242, source: 'omp-hook-session' });
    expect(typeof oracle.seen[0][0].heartbeatAt).toBe('string');
  });

  it('reports fleet as null when no fleet slug was asked about, even when sessions are removed', async () => {
    oracle.fake = verdicts({ gone: 'ended' });
    const r = await count({ total: 2, fleet: 0, presence_rows: [presence('gone', false)] }, null);
    expect(r.headcount).toEqual({ total: 1, fleet: null });
  });

  it('never goes negative if the oracle names more ended rows than the SQL counted', async () => {
    oracle.fake = verdicts({ a: 'ended', b: 'ended' });
    const r = await count({ total: 1, fleet: 1, presence_rows: [presence('a'), presence('b')] });
    expect(r.headcount).toEqual({ total: 0, fleet: 0 });
  });

  it('tolerates a json-as-string aggregate and discards malformed entries (the count stands)', async () => {
    oracle.fake = verdicts({ gone: 'ended' });
    const asString = JSON.stringify([presence('gone'), { ownerId: '' }, null, 7]);
    expect((await count({ total: 3, fleet: 3, presence_rows: asString })).headcount.total).toBe(2);
    expect((await count({ total: 3, fleet: 3, presence_rows: 'not json' })).headcount.total).toBe(3);
    expect((await count({ total: 3, fleet: 3, presence_rows: { not: 'an array' } })).headcount.total).toBe(3);
  });

  it('an oracle failure surfaces as the in-band count error (the callers fail OPEN and say so)', async () => {
    oracle.fake = () => {
      throw new Error('oracle down');
    };
    const r = await count({ total: 1, fleet: 1, presence_rows: [presence('o-x')] });
    expect(r.error).toBe('oracle down');
    expect(r.headcount).toEqual({ total: 0, fleet: 0 });
  });
});

describe('goalHeadcount — with the REAL oracle: a fresh heartbeat does not keep a dead session counted', () => {
  const DEAD_PID = 666;
  const LIVE_PID = 777;
  const seams = {
    fetchWakeabilityFn: async (ids: string[]) =>
      new Map(ids.map((id) => [id, { wakeable: true, liveTurn: false }])),
    fetchRecordedLiveFn: async () => new Set<string>(),
    fetchRecordedEndedFn: async () => new Set<string>(),
    // An affirmative ESRCH for DEAD_PID only; everything else is inconclusive.
    probePidFn: (r: { pid?: number | null }) => (r.pid === DEAD_PID ? false : null),
    findHostFn: () => null,
  };

  it('POSITIVE CONTROL: an identical session whose pid is NOT confirmed dead is counted', async () => {
    oracle.realOpts = seams;
    const r = await count({ total: 1, fleet: 1, presence_rows: [presence('alive', true, { pid: LIVE_PID })] });
    expect(r.headcount).toEqual({ total: 1, fleet: 1 });
  });

  it('a session with a FRESH heartbeat but a confirmed-dead pid is `ended` per the oracle and is NOT counted', async () => {
    oracle.realOpts = seams;
    const r = await count({
      total: 2,
      fleet: 2,
      presence_rows: [presence('alive', true, { pid: LIVE_PID }), presence('dead', true, { pid: DEAD_PID })],
    });
    expect(r.headcount).toEqual({ total: 1, fleet: 1 });
  });
});
