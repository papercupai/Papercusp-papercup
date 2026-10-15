/** EI-25166050736574344: execute the production census SQL in isolated Postgres.
 * The oracle seam controls verdicts; existing liveness tests cover that oracle.
 * These synthetic controls do not establish the historical incident's cause.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { goalHeadcount, registerGoalLaunch, REFUSAL_SCOPES, type GoalLaunchResolution, type resolveGoalLaunchForGoal } from './goal-launch-settings';

vi.mock('./modes/goal-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('./modes/goal-context')>(),
  resolveGoalContext: async () => 'census-goal',
}));

const oracle = vi.hoisted(() => ({ seen: [] as string[][] }));
vi.mock('./agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: async (subjects: readonly { ownerId: string }[]) => {
    oracle.seen.push(subjects.map((subject) => subject.ownerId));
    return new Map(subjects.map(({ ownerId }) => [ownerId, {
      sessionState: ownerId === 'ended' ? 'ended' : ownerId === 'recorded' ? 'recorded' : 'live',
    }]));
  },
}));

const WS = 'census-workspace';
const GOAL = 'census-goal';
const FLEET = 'census-fleet';
let db: FreshPgDb;

async function receipt(owner: string, overrides: Record<string, unknown> = {}) {
  const record = {
    schemaVersion: 1, namespace: 'agent-process', admissionClass: 'agent', state: 'running',
    enqueuedAtMs: Date.now(), lease: { expiresAtMs: Date.now() + 60_000 },
    metadata: { goalId: GOAL, goalReservation: true, targetOwnerId: owner, fleetSlug: FLEET },
    ...overrides,
  };
  await db.sql`INSERT INTO harness_shared.work_items (feature_id, workspace_id, payload)
    VALUES (${`receipt-${owner}`}, ${WS}, ${JSON.stringify({ resource_governor: record })}::text::jsonb)`;
}

/** Keep policy fixed so these tests distinguish registration serialization. */
const policy = (maxAgents = 6, maxPerFleet = 10): typeof resolveGoalLaunchForGoal => async (args) => {
  const result = await goalHeadcount({
    workspaceId: args.workspaceId, goalId: args.goalId!, fleetSlug: args.fleetSlug,
    excludeOwnerIds: args.excludeOwnerIds, sql: args.sql,
  });
  expect(result.error).toBeNull();
  const totalFull = result.headcount.total + 1 > maxAgents;
  const fleetFull = (result.headcount.fleet ?? 0) + 1 > maxPerFleet;
  return {
    goalId: args.goalId, settings: null, goalBrief: null, holderReadiness: null, effective: {},
    ceilings: { maxAgents, maxPerFleet }, headcount: result.headcount, headcountMeasurement: result.measurement,
    budget: null, degraded: false, degradedReasons: [],
    refusal: totalFull || fleetFull ? {
      reason: totalFull ? 'goal_max_agents' : 'fleet_max_agents', requested: 1,
      limit: totalFull ? maxAgents : maxPerFleet,
      current: totalFull ? result.headcount.total : result.headcount.fleet!, message: 'fixture ceiling reached',
      currentScope: totalFull ? REFUSAL_SCOPES.LIVE_AGENTS_IN_GOAL : REFUSAL_SCOPES.LIVE_AGENTS_IN_FLEET,
    } : null,
  } satisfies GoalLaunchResolution;
};

beforeAll(async () => {
  db = await createFreshPgDb('goal_census');
  // Only columns read by the census: no production workspace or actor is touched.
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY, workspace_id text NOT NULL, goal_id text,
      first_seen_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE harness_shared.coord_presence (
      owner_id text PRIMARY KEY, fleet_slug text, heartbeat_at timestamptz NOT NULL,
      host text, pid integer, source text
    );
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY, workspace_id text NOT NULL, payload jsonb NOT NULL
    );
  `);
});
afterAll(async () => { await db?.cleanup(); });

beforeEach(async () => {
  oracle.seen = [];
  await db.sql.unsafe('TRUNCATE harness_shared.coord_presence, harness_shared.session_briefs, harness_shared.work_items');
  const rows = [
    { owner: 'live', fleet: FLEET },
    { owner: 'recorded', fleet: FLEET },
    { owner: 'ended', fleet: FLEET },
    { owner: 'other-fleet', fleet: 'another-fleet' },
    { owner: 'boot', fleet: null },
    { owner: 'stale', fleet: FLEET, stale: true },
    { owner: 'expired-boot', fleet: null, stale: true },
    { owner: 'replacement', fleet: FLEET },
    { owner: 'other-goal', fleet: FLEET, goal: 'another-goal' },
    { owner: 'other-workspace', fleet: FLEET, workspace: 'another-workspace' },
  ];
  for (const row of rows) {
    const age = row.stale ? '1 hour' : '5 seconds';
    await db.sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, goal_id, updated_at)
      VALUES (${row.owner}, ${row.workspace ?? WS}, ${row.goal ?? GOAL}, now() - ${age}::interval)`;
    if (row.fleet) {
      await db.sql`
        INSERT INTO harness_shared.coord_presence (owner_id, fleet_slug, heartbeat_at, host, pid, source)
        VALUES (${row.owner}, ${row.fleet}, now() - ${age}::interval, 'fixture-host', 123, 'fixture')`;
    }
  }
});

describe('goalHeadcount same-query population in real Postgres', () => {
  it('reconciles aggregate identities, fleet membership, boot grace and oracle exclusions in one query', async () => {
    let censusQueries = 0;
    const sql = new Proxy(db.sql, {
      apply(target, thisArg, args) {
        if ((args[0] as TemplateStringsArray).join('').includes('count(*)::int AS total')) censusQueries += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const result = await goalHeadcount({
      workspaceId: WS, goalId: GOAL, fleetSlug: FLEET,
      excludeOwnerIds: ['replacement', 'replacement'], sql,
    });
    expect(result.error).toBeNull();
    expect(censusQueries).toBe(1);
    expect(result.headcount).toEqual({ total: 4, fleet: 2 });
    expect(result.measurement).toMatchObject({
      populationComplete: true, candidate: { total: 5, fleet: 3 },
      excludedOwnerIds: ['replacement'], oracleEndedOwnerIds: ['ended'],
    });
    expect(Number.isFinite(Date.parse(result.measurement!.measuredAt!))).toBe(true);
    const counted = result.measurement!.counted;
    expect(counted.map((row) => row.ownerId).sort()).toEqual(['boot', 'live', 'other-fleet', 'recorded']);
    expect(counted.filter((row) => row.inFleet).map((row) => row.ownerId).sort()).toEqual(['live', 'recorded']);
    expect(counted.find((row) => row.ownerId === 'boot')).toMatchObject({
      basis: 'boot-grace', heartbeatAt: null, inFleet: false,
    });
    expect(counted.find((row) => row.ownerId === 'recorded')).toMatchObject({ basis: 'heartbeat', inFleet: true });
    expect(oracle.seen).toHaveLength(1);
    expect(oracle.seen[0].sort()).toEqual(['ended', 'live', 'other-fleet', 'recorded']);
  });

  it('represents an empty measured population and an omitted fleet without inventing fleet zero', async () => {
    const result = await goalHeadcount({ workspaceId: WS, goalId: GOAL, sql: db.sql });
    expect(result.error).toBeNull();
    expect(result.headcount).toEqual({ total: 5, fleet: null });
    expect(result.measurement).toMatchObject({
      populationComplete: true, candidate: { total: 6, fleet: null },
    });
    const empty = await goalHeadcount({ workspaceId: 'empty-workspace', goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    expect(empty.error).toBeNull();
    expect(empty.headcount).toEqual({ total: 0, fleet: 0 });
    expect(empty.measurement).toMatchObject({
      populationComplete: true, candidate: { total: 0, fleet: 0 }, counted: [], oracleEndedOwnerIds: [],
    });
  });

  it('distinguishes one new identity from an existing identity becoming goal-countable', async () => {
    const count = () => goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    const before = await count();
    await db.sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, goal_id)
      VALUES ('sole-new-launch', ${WS}, ${GOAL})`;
    const afterLaunch = await count();
    const identitiesBeforeTransition = await db.sql`SELECT count(*)::int AS n FROM harness_shared.session_briefs`;
    await db.sql`UPDATE harness_shared.session_briefs SET goal_id = ${GOAL} WHERE owner_id = 'other-goal'`;
    const afterTransition = await count();
    const identitiesAfterTransition = await db.sql`SELECT count(*)::int AS n FROM harness_shared.session_briefs`;
    expect([before, afterLaunch, afterTransition].map((r) => r.headcount.total)).toEqual([5, 6, 7]);
    expect([before, afterLaunch, afterTransition].every((r) => r.error === null && r.measurement?.populationComplete)).toBe(true);
    expect(identitiesAfterTransition).toEqual(identitiesBeforeTransition);
    const added = (a: typeof before, b: typeof before) => b.measurement!.counted
      .map((row) => row.ownerId).filter((id) => !a.measurement!.counted.some((row) => row.ownerId === id));
    expect(added(before, afterLaunch)).toEqual(['sole-new-launch']);
    expect(added(afterLaunch, afterTransition)).toEqual(['other-goal']);
  });

  it('counts an active launch receipt, but not cancelled, expired, old or foreign-goal receipts', async () => {
    await receipt('pending');
    await receipt('cancelled', { state: 'cancelled' });
    await receipt('expired', { lease: { expiresAtMs: Date.now() - 1_000 } });
    await receipt('old', { enqueuedAtMs: Date.now() - 60 * 60_000 });
    await receipt('foreign', { metadata: { goalId: 'other-goal', goalReservation: true, targetOwnerId: 'foreign' } });
    const result = await goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    expect(result.error).toBeNull();
    expect(result.headcount).toEqual({ total: 6, fleet: 4 });
    expect(result.measurement?.populationComplete).toBe(true);
    expect(result.measurement?.counted.find((row) => row.ownerId === 'pending')).toMatchObject({
      basis: 'launch-reservation', heartbeatAt: null, inFleet: true,
    });
    expect(result.measurement?.counted.map((row) => row.ownerId).sort())
      .toEqual(['boot', 'live', 'other-fleet', 'pending', 'recorded', 'replacement']);
  });

  it('reconciles a reserved identity with newer presence without counting it twice or dropping an old ended replacement', async () => {
    await receipt('ended');
    const waiting = await goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    expect(waiting.error).toBeNull();
    expect(waiting.headcount.total).toBe(6);
    expect(waiting.measurement?.counted.find((row) => row.ownerId === 'ended')?.basis).toBe('launch-reservation');
    expect(waiting.measurement?.oracleEndedOwnerIds).toEqual([]);
    await db.sql`UPDATE harness_shared.coord_presence SET heartbeat_at = clock_timestamp() + interval '1 second'
      WHERE owner_id = 'ended'`;
    const registered = await goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    expect(registered.error).toBeNull();
    expect(registered.measurement?.candidate.total).toBe(6);
    expect(registered.measurement?.populationComplete).toBe(true);
    expect(registered.headcount.total).toBe(5);
    expect(registered.measurement?.oracleEndedOwnerIds).toEqual(['ended']);
  });

  it('reserves exactly one remaining goal seat under concurrent registration; an unlocked control over-admits', async () => {
    const resolve = policy();
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    const unlocked = async (owner: string) => {
      const result = await resolve({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, count: 1, sql: db.sql });
      if (++reads === 2) release();
      await barrier;
      if (!result.refusal) await receipt(owner);
      return result;
    };
    const controls = await Promise.all([unlocked('control-a'), unlocked('control-b')]);
    expect(controls.map((r) => r.headcount.total)).toEqual([5, 5]);
    expect(controls.map((r) => r.refusal)).toEqual([null, null]);
    expect((await goalHeadcount({ workspaceId: WS, goalId: GOAL, sql: db.sql })).headcount.total).toBe(7);
    await db.sql.unsafe('TRUNCATE harness_shared.work_items');
    const guarded = await Promise.all(['guarded-a', 'guarded-b'].map((targetOwnerId) => registerGoalLaunch({
      workspaceId: WS, launcherOwnerId: 'fixture-launcher', targetOwnerId, fleetSlug: FLEET, sql: db.sql, resolve,
    }, async () => { await receipt(targetOwnerId); return targetOwnerId; })));
    expect(guarded.filter((r) => r.value !== null)).toHaveLength(1);
    expect(guarded.filter((r) => r.resolution?.refusal?.reason === 'goal_max_agents')).toHaveLength(1);
    expect(guarded.map((r) => r.resolution!.headcount.total).sort()).toEqual([5, 6]);
    expect((await goalHeadcount({ workspaceId: WS, goalId: GOAL, sql: db.sql })).headcount.total).toBe(6);
  });

  it('deduplicates receipts, brief boot grace and fresh presence for the same pinned fork identity', async () => {
    await receipt('fork-first', { metadata: {
      goalId: GOAL, goalReservation: true, targetOwnerId: 'fork-pinned', fleetSlug: FLEET,
    } });
    await receipt('fork-replay', { metadata: {
      goalId: GOAL, goalReservation: true, targetOwnerId: 'fork-pinned', fleetSlug: FLEET,
    } });
    await db.sql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, goal_id)
      VALUES ('fork-pinned', ${WS}, ${GOAL})`;
    const waiting = await goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    expect(waiting.error).toBeNull();
    expect(waiting.headcount).toEqual({ total: 6, fleet: 4 });
    expect(waiting.measurement?.populationComplete).toBe(true);
    expect(waiting.measurement?.counted.filter((row) => row.ownerId === 'fork-pinned'))
      .toEqual([expect.objectContaining({ basis: 'launch-reservation', inFleet: true })]);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, fleet_slug, heartbeat_at)
      VALUES ('fork-pinned', ${FLEET}, clock_timestamp() + interval '1 second')`;
    const registered = await goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    expect(registered.error).toBeNull();
    expect(registered.headcount).toEqual(waiting.headcount);
    expect(registered.measurement?.populationComplete).toBe(true);
    expect(registered.measurement?.counted.filter((row) => row.ownerId === 'fork-pinned'))
      .toEqual([expect.objectContaining({ basis: 'heartbeat', inFleet: true })]);
  });

  it('admits an identity-preserving resume at both ceilings without adding a counted seat', async () => {
    const result = await registerGoalLaunch({
      workspaceId: WS, launcherOwnerId: 'fixture-launcher', targetOwnerId: 'live',
      fleetSlug: FLEET, sql: db.sql, resolve: policy(5, 3),
    }, async () => { await receipt('live'); return 'live'; });
    expect(result.resolution?.refusal).toBeNull();
    expect(result.resolution?.headcount).toEqual({ total: 4, fleet: 2 });
    const counted = await goalHeadcount({ workspaceId: WS, goalId: GOAL, fleetSlug: FLEET, sql: db.sql });
    expect(counted.error).toBeNull();
    expect(counted.headcount).toEqual({ total: 5, fleet: 3 });
    expect(counted.measurement?.populationComplete).toBe(true);
    expect(counted.measurement?.counted.filter((row) => row.ownerId === 'live')).toHaveLength(1);
  });

  it('supplies the exact locked final population to the receipt writer before registration', async () => {
    const register = vi.fn(async (goalId: string | null, resolution: GoalLaunchResolution | null, degradedReason: string | null) => {
      expect(goalId).toBe(GOAL);
      expect(degradedReason).toBeNull();
      await receipt('final-proof', { metadata: { goalId: GOAL, goalReservation: true,
        targetOwnerId: 'final-proof', fleetSlug: FLEET, goalAdmission: JSON.stringify(resolution) } });
      return 'final-proof';
    });
    const result = await registerGoalLaunch({
      workspaceId: WS, launcherOwnerId: 'fixture-launcher', targetOwnerId: 'final-proof',
      excludeOwnerIds: ['replacement'], fleetSlug: FLEET, sql: db.sql, resolve: policy(),
    }, register);
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0][1]).toBe(result.resolution);
    const rows = await db.sql`SELECT payload->'resource_governor'->'metadata'->>'goalAdmission' AS admission
      FROM harness_shared.work_items WHERE feature_id = 'receipt-final-proof'`;
    expect(JSON.parse(rows[0].admission)).toEqual(result.resolution);
    expect(result.resolution?.headcountMeasurement?.excludedOwnerIds).toEqual(['replacement', 'final-proof']);
    expect(result.resolution?.headcount.total).toBe(4);
    expect((await goalHeadcount({ workspaceId: WS, goalId: GOAL, sql: db.sql })).headcount.total).toBe(6);
  });

  it('reserves the fleet seat independently of the goal ceiling and preserves replacement exclusion', async () => {
    const guarded = await Promise.all(['fleet-a', 'fleet-b'].map((targetOwnerId) => registerGoalLaunch({
      workspaceId: WS, launcherOwnerId: 'fixture-launcher', targetOwnerId, fleetSlug: FLEET,
      sql: db.sql, resolve: policy(100, 4),
    }, async () => { await receipt(targetOwnerId); return targetOwnerId; })));
    expect(guarded.filter((r) => r.value !== null)).toHaveLength(1);
    expect(guarded.filter((r) => r.resolution?.refusal?.reason === 'fleet_max_agents')).toHaveLength(1);
    const replacement = await registerGoalLaunch({
      workspaceId: WS, launcherOwnerId: 'fixture-launcher', targetOwnerId: 'replacement-new',
      excludeOwnerIds: ['replacement'], fleetSlug: FLEET, sql: db.sql, resolve: policy(100, 4),
    }, async () => { await receipt('replacement-new'); return 'replacement-new'; });
    expect(replacement.resolution?.refusal).toBeNull();
  });

  it('does not repeat registration after a callback writes its durable receipt then throws', async () => {
    const register = vi.fn(async () => { await receipt('unknown-outcome'); throw new Error('write receipt lost'); });
    await expect(registerGoalLaunch({ workspaceId: WS, launcherOwnerId: 'fixture-launcher',
      targetOwnerId: 'unknown-outcome', fleetSlug: FLEET, sql: db.sql, resolve: policy(),
    }, register)).rejects.toThrow('write receipt lost');
    expect(register).toHaveBeenCalledTimes(1);
    expect((await db.sql`SELECT feature_id FROM harness_shared.work_items`)).toHaveLength(1);
  });

  it('reports a pre-registration lock failure and registers exactly once under the existing fail-open policy', async () => {
    const sql = { begin: async () => { throw new Error('fixture lock unavailable'); } } as unknown as FreshPgDb['sql'];
    const register = vi.fn(async (goalId: string | null) => { await receipt('fail-open'); return goalId; });
    const result = await registerGoalLaunch({ workspaceId: WS, launcherOwnerId: 'fixture-launcher', sql }, register);
    expect(result).toEqual({ value: GOAL, resolution: null,
      degradedReason: 'goal admission registration not enforced — fixture lock unavailable' });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(GOAL, null, 'goal admission registration not enforced — fixture lock unavailable');
  });
});
