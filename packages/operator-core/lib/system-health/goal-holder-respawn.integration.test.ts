/**
 * goal-holder-respawn.integration.test — P-010 of work-on-everything-goal-2026-08-23
 * (WI-41132): CONSUME the shipped goal-live-holder-guarantee-2026-08-18 holder policy +
 * respawner (its P-004/P-009) and verify respawn-on-loss END-TO-END for a started,
 * package-shaped goal against a real Postgres: kill its session (expressed as the
 * presence signals a dead session actually presents), watch it come back, no human.
 *
 * What the unit suite (goal-liveness-watchdog.test.ts) fakes and this file proves
 * actually COMPOSES (the same lesson as convert/spend-rollup integration tests —
 * unit-mocked halves had never been proven to compose):
 *
 *  - the REAL goals read (`makeReadGoals` via the default deps): the SQL status
 *    predicate, `launch_settings` jsonb → `parseGoalLaunchSettings` →
 *    `resolveGoalHolderPolicy` eligibility — over a STANDING, budget-windowed,
 *    package-shaped goal row (work-on-everything D-002 shape: installed row ≠ started);
 *  - the REAL holder-row read (`readGoalHolderRows`, mode='goal' filter) and the REAL
 *    fold (`resolveGoalHoldersFromRows`) over rows the REAL `setMode` wrote;
 *  - the REAL oracle derivation: `resolveSessionStates` → `deriveVerdict`, driven only
 *    through its DESIGNED DI fetch seams. "Kill its session" is not an injected
 *    verdict: it is the signal set a killed session presents (not wakeable, stale
 *    heartbeat, positive recorded-session-ended evidence), classified by the real code;
 *  - the REAL attach: the default `deps.attach` → `setMode` → agent_modes upsert +
 *    agent_mode_changes audit + the GOAL⇒AUTO/IDEATE implication cascade;
 *  - stability: the tick after recovery folds 'held' and does NOT double-launch.
 *
 * Only the spawn itself is stubbed (`deps.launch` returns a fresh pre-pinned ownerId,
 * exactly the contract `launchGoalHolderSession` documents): opening a real process is
 * the launch door's own tested seam (goal-holder-launch-action.test.ts), and P-010
 * forbids rebuilding anything the holder plan ships. FLAGS.GOAL_HOLDER_RESPAWN stays
 * dark (owner-authority, registered in DARK_FLAGS): these ticks inject
 * `flagEnabled: true` per tick, exactly what the armed timer's per-tick gate resolves
 * to after the owner flips the flag — the flag itself is deliberately NOT flipped here.
 *
 * ⚠ Schema: this fixture stands up the REAL head schema via `createOrgTestDb()`
 * (packages/operator-core/test/_org-test-db.ts — the real boot-path migration runner,
 * template-cached on a content hash of the whole migration set). It deliberately does
 * NOT hand-roll DDL, because this file did and drifted TWICE: first `agent_modes`
 * gained `implied_by jsonb` and `setMode`'s INSERT failed (WI-10002085, 8 tests red),
 * then `harness_shared.adv_sessions` was missing entirely, so `setMode`'s control-anchor
 * refresh degraded and 3 tests failed on its `console.warn` (WI-10002090) — a warn that
 * was telling the truth, which is why silencing it in the console-noise filter would have
 * been the wrong layer (that filter is deliberately scoped so a genuine bounded-timeout
 * failure still fails loudly). A hand-rolled fixture cannot track a migration on its own;
 * the real runner cannot fall behind one, because any new migration changes the template
 * key and forces a rebuild. Do not reintroduce inline `CREATE TABLE` here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getOrgPg } from '@papercusp/db-org';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';

import {
  GOAL_HOLDER_RESPAWN_RATE_LIMIT,
  GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS,
  GOAL_HOLDER_FIRST_TURN_GRACE_MS,
  GOAL_HOLDER_REKICK_INTERVAL_MS,
  pauseGoalForHolderRespawnRateCap,
  reconcileStrandedGoalHolderRespawnLatch,
  releaseGoalHolderRespawnRateSlot,
  reserveGoalHolderRespawnRateSlot,
  runGoalHolderRespawnOnce,
  type GoalHolderRespawnDeps,
} from './goal-liveness-watchdog';
import { setGoalTransitionExecutor, type GoalStopReport } from '@papercusp/agent-mcp';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import type { WakeabilitySignals } from '../agent-tools/coordination/presence-wakeability';
import type { SelfWakeSignals } from '../agent-tools/coordination/presence-selfwake';
import {
  readGoalHolderRows,
  resolveGoalHoldersFromRows,
} from '../goals/holder';
import { GOAL_MODE } from '../modes/goal-session';
import { setMode } from '../modes/store';
import { retireSupersededGoalHolderModes } from '../goals/holder-handoff';
import { readGoalHolderPortfolioAct } from '../goals/holder-attestation';

const WS = 'ws-woe-p010';
const HARNESS = 'papercusp-p010';
const GOAL = 'goal-woe-package-1';
const INITIAL_HOLDER = 'su-initial-holder';

let db: OrgTestDb;
let rootSql: postgres.Sql;
let coordination: BaselineCoordFixture | undefined;

/* ── the presence-signal fixture: what each session's substrate looks like ── */

interface SessionSignals {
  wakeable: boolean;
  liveTurn: boolean;
  wakeAttemptMiss?: boolean;
  stale: boolean;
  heartbeatAt: string;
  recordedLive: boolean;
  recordedEnded: boolean;
  selfWake?: SelfWakeSignals;
}

/** A healthy, working session: warm heartbeat, wakeable, recorded-live. */
function liveSignals(): SessionSignals {
  return {
    wakeable: true,
    liveTurn: true,
    stale: false,
    heartbeatAt: new Date().toISOString(),
    recordedLive: true,
    recordedEnded: false,
    selfWake: { loopArmed: true, selfWake: 'loop' } as SelfWakeSignals,
  };
}

/**
 * The KILL: the signal set a dead session actually presents — no wake await, a
 * stale heartbeat, and positive session-log evidence the recorded session ended.
 * `deriveVerdict` (the real classifier) must read this as 'ended'; nothing here
 * hands the code a verdict.
 */
function killedSignals(): SessionSignals {
  return {
    wakeable: false,
    liveTurn: false,
    stale: true,
    heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
    recordedLive: false,
    recordedEnded: true,
    selfWake: { loopArmed: false, selfWake: 'none' } as SelfWakeSignals,
  };
}

const sessions = new Map<string, SessionSignals>();

/**
 * The REAL oracle over the fixture substrate: `resolveSessionStates` runs its own
 * hydration + `deriveVerdict`; only the batched FETCHES (its documented DI seams)
 * read from the fixture map. An owner with no fixture entry gets NO verdict — the
 * oracle's own degraded-fetch contract, which the fold must render as 'unknown'.
 */
const resolveLiveness: GoalHolderRespawnDeps['resolveLiveness'] = async (ownerIds) =>
  await resolveSessionStates(
    ownerIds.map((ownerId) => ({ ownerId })),
    {
      hydratePerId: true,
      selfWake: true,
      getPresenceFn: async (ownerId) => {
        const s = sessions.get(ownerId);
        if (!s) return null;
        return { heartbeatAt: s.heartbeatAt, stale: s.stale, host: null, pid: null, source: 'psu' };
      },
      fetchWakeabilityFn: async (ids) => {
        const out = new Map<string, WakeabilitySignals>();
        for (const id of ids) {
          const s = sessions.get(id);
          if (s) {
            out.set(id, {
              wakeable: s.wakeable,
              liveTurn: s.liveTurn,
              ...(s.wakeAttemptMiss === undefined ? {} : { wakeAttemptMiss: s.wakeAttemptMiss }),
            });
          }
        }
        return out;
      },
      fetchSelfWakeFn: async (ids) => {
        const out = new Map<string, SelfWakeSignals>();
        for (const id of ids) {
          const s = sessions.get(id);
          if (s?.selfWake) out.set(id, s.selfWake);
        }
        return out;
      },
      fetchRecordedLiveFn: async (ids) =>
        new Set(ids.filter((id) => sessions.get(id)?.recordedLive === true)),
      fetchRecordedEndedFn: async (ids) =>
        new Set(ids.filter((id) => sessions.get(id)?.recordedEnded === true)),
      probePidFn: () => null,
      findHostFn: () => null,
    },
  );

/* ── goal seeding: the package-shaped standing goal (D-002 / D-005 shape) ── */

async function seedGoal(opts: {
  id: string;
  status?: string;
  launchSettings?: unknown;
  standing?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await rootSql`
    INSERT INTO harness_shared.goals
      (id, workspace_id, install_slug, title, status, launch_settings, standing, budget_window_sec, metadata)
    VALUES (${opts.id}, ${WS}, ${HARNESS}, ${'Work on everything (package goal) ' + opts.id},
            ${opts.status ?? 'active'},
            ${opts.launchSettings === undefined ? null : rootSql.json(opts.launchSettings as never)},
            ${opts.standing ?? true}, ${86_400},
            ${rootSql.json((opts.metadata ?? {}) as never)})`;
}

const RESPAWN_SETTINGS = { holder: { requireLive: true, onLoss: 'respawn' } };

/** Attach a holder the way the start door does: the REAL setMode, subject = goal id. */
async function attachHolder(ownerId: string, goalId: string, setBy = ownerId): Promise<void> {
  const res = await setMode({
    workspaceId: WS,
    ownerId,
    modeId: GOAL_MODE,
    enabled: true,
    reason: `test: started package goal ${goalId}`,
    setBy,
    subject: goalId,
    sql: rootSql,
  });
  expect(res.ok).toBe(true);
}

function drillDeps(overrides: Partial<GoalHolderRespawnDeps> = {}): {
  deps: Partial<GoalHolderRespawnDeps>;
  launches: string[];
} {
  const launches: string[] = [];
  const deps: Partial<GoalHolderRespawnDeps> = {
    resolveLiveness,
    flagEnabled: async () => true,
    launch: async (goal) => {
      launches.push(goal.goalId);
      return { ownerId: `su-replacement-${launches.length}`, warnings: [] };
    },
    // attach stays the DEFAULT: the real setMode against the fixture sql.
    neutralize: async () => {},
    notifyHandoff: async () => {},
    escalateGiveUp: async () => {},
    // Existing recovery cases test liveness; the new first-turn path has its
    // own explicit case below and must not inherit fixture absence as failure.
    attestHolder: async (goal, holder) => ({
      status: 'complete', workspaceId: goal.workspaceId, goalId: goal.goalId,
      ownerId: holder.ownerId, modeSetAt: new Date(holder.setAtMs).toISOString(),
      loopActive: true, checkpointAt: new Date(holder.setAtMs).toISOString(),
      portfolioAct: { tool: 'plans:new', at: new Date(holder.setAtMs).toISOString() },
      missing: [], unavailable: [],
    }),
    // WI-2140573 finding 5: the default assessor reads the box's LIVE account
    // pool, which this drill must not depend on — measure capacity as clear.
    assessLaunchCapacity: async () => ({
      kind: 'clear',
      target: { provider: 'claude', accountId: null, agent: 'claude' },
      reason: 'drill fixture: capacity clear',
    }),
    escalateCapacityDeferral: async () => {},
    capacityDeferrals: new Map(),
    // WI-10005559: the drill measures recovery on the first lost tick.
    lossConfirmMs: 0,
    lossObservations: new Map(),
    states: new Map(),
    ...overrides,
  };
  return { deps, launches };
}

async function goalModeRows(goalId: string) {
  return await rootSql<
    {
      owner_id: string;
      mode: string;
      subject: string | null;
      set_by: string;
      // bigint — a NUMBER through this fixture's production-mirroring client (see the
      // epoch assertion below), not the string a bare postgres() client would return.
      goal_lease_epoch: number | null;
      goal_handoff_from_owner_id: string | null;
      goal_handoff_expires_at: Date | null;
    }[]
  >`
    SELECT owner_id, mode, subject, set_by, goal_lease_epoch,
           goal_handoff_from_owner_id, goal_handoff_expires_at
      FROM harness_shared.agent_modes
     WHERE workspace_id = ${WS} AND mode = ${GOAL_MODE} AND subject = ${goalId}
     ORDER BY set_at`;
}

beforeAll(async () => {
  // Real head schema via the real boot-path migration runner (see the header note).
  // `adminSql` is the RLS-BYPASS client, which is what these assertions want — and it
  // mirrors the canonical operator client's bigint/timestamp parsers and raw
  // Date/jsonb serializers, so a raw read or write here binds exactly as production
  // does instead of in the opposite direction (EI-18698602043482898).
  db = await createOrgTestDb();
  rootSql = db.adminSql;
  // setMode's notification and control-anchor paths resolve their own pool.
  // Route those real paths to the SAME isolated DB as the injected writer.
  coordination = await setupBaselineCoordFixture({ dsn: db.adminDsn });
}, 300_000);

// Explicit timeout: dropping a throwaway database has to terminate other backends
// first, and under concurrent fleet load that has exceeded Vitest's default 10s hook
// timeout and failed suites whose assertions all passed (EI-23128538923529753,
// EI-22778982473804010).
afterAll(async () => {
  try {
    await coordination?.dispose();
  } finally {
    await db?.cleanup();
  }
}, 120_000);

beforeEach(async () => {
  sessions.clear();
  // CASCADE is required, not cosmetic: on the REAL head schema `goals` is referenced by
  // foreign keys, so a bare TRUNCATE is refused outright ("cannot truncate a table
  // referenced in a foreign key constraint"). Safe here because the database is a
  // throwaway provisioned per test file, and every row these tests read is seeded per-test.
  await rootSql`TRUNCATE harness_shared.goals, harness_shared.agent_modes, harness_shared.agent_mode_changes CASCADE`;
});

describe('respawn-on-loss for a started package goal (P-010, end-to-end)', () => {
  it('routes default notification and control pools to the holder writer database', async () => {
    const [writer] = await rootSql<{ name: string }[]>`SELECT current_database() AS name`;
    const [defaultPool] = await getOrgPg().sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(writer.name).toBe(db.dbName);
    expect(defaultPool.name).toBe(writer.name);
  });

  it('persists a pruned trailing-hour launch ledger and closes the seventh reservation', async () => {
    const goalId = 'goal-durable-respawn-cap';
    const nowMs = Date.now();
    const priorAttempt = nowMs - 5_000;
    await seedGoal({
      id: goalId,
      launchSettings: RESPAWN_SETTINGS,
      metadata: {
        preserved: 'goal-metadata',
        holderRespawn: {
          preserved: 'respawn-metadata',
          attempts: [nowMs - GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS - 1, priorAttempt],
        },
      },
    });

    for (let expected = 2; expected <= GOAL_HOLDER_RESPAWN_RATE_LIMIT; expected += 1) {
      await expect(reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs)).resolves.toEqual({
        kind: 'reserved',
        attemptsInWindow: expected,
      });
    }
    await expect(reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs)).resolves.toEqual({
      kind: 'capped',
      attemptsInWindow: GOAL_HOLDER_RESPAWN_RATE_LIMIT,
    });

    const [row] = await rootSql<{ metadata: Record<string, any> }[]>`
      SELECT metadata FROM harness_shared.goals
       WHERE workspace_id = ${WS} AND id = ${goalId}`;
    expect(row?.metadata).toMatchObject({
      preserved: 'goal-metadata',
      holderRespawn: {
        preserved: 'respawn-metadata',
        attempts: [priorAttempt, ...Array(GOAL_HOLDER_RESPAWN_RATE_LIMIT - 1).fill(nowMs)],
        limit: GOAL_HOLDER_RESPAWN_RATE_LIMIT,
        windowMs: GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS,
        needsHuman: true,
        needsHumanAtMs: nowMs,
        reason: 'hourly-respawn-cap',
      },
    });
  }, 60_000);

  it('returns exactly the slot a policy-refused launch reserved, so refusals cannot reach the cap (WI-10004329)', async () => {
    const goalId = 'goal-refused-launch-slot-release';
    const nowMs = Date.now();
    const earlier = nowMs - 10_000;
    await seedGoal({
      id: goalId,
      launchSettings: RESPAWN_SETTINGS,
      metadata: { holderRespawn: { preserved: 'respawn-metadata', attempts: [earlier] } },
    });

    // Six consecutive refused launches: reserve, then release. Before the fix
    // the sixth reservation's successor was capped with zero launches.
    for (let tick = 0; tick < GOAL_HOLDER_RESPAWN_RATE_LIMIT; tick += 1) {
      const reservedAtMs = nowMs + tick;
      await expect(
        reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, reservedAtMs),
      ).resolves.toEqual({ kind: 'reserved', attemptsInWindow: 2 });
      await expect(
        releaseGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, reservedAtMs),
      ).resolves.toBe(true);
    }

    const [row] = await rootSql<{ metadata: Record<string, any> }[]>`
      SELECT metadata FROM harness_shared.goals
       WHERE workspace_id = ${WS} AND id = ${goalId}`;
    expect(row?.metadata.holderRespawn).toMatchObject({
      preserved: 'respawn-metadata',
      attempts: [earlier],
      needsHuman: false,
    });

    // A slot that was never reserved is not found, and nothing else is removed.
    await expect(
      releaseGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs + 999),
    ).resolves.toBe(false);
    const [after] = await rootSql<{ attempts: unknown[] }[]>`
      SELECT metadata #> '{holderRespawn,attempts}' AS attempts
        FROM harness_shared.goals
       WHERE workspace_id = ${WS} AND id = ${goalId}`;
    expect(after?.attempts).toEqual([earlier]);
  }, 60_000);

  it('row-locks concurrent reservations so only one caller receives the sixth slot', async () => {
    const goalId = 'goal-concurrent-respawn-cap';
    const nowMs = Date.now();
    await seedGoal({
      id: goalId,
      launchSettings: RESPAWN_SETTINGS,
      metadata: {
        holderRespawn: {
          attempts: Array(GOAL_HOLDER_RESPAWN_RATE_LIMIT - 1).fill(nowMs - 1_000),
        },
      },
    });

    const decisions = await Promise.all([
      reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs),
      reserveGoalHolderRespawnRateSlot(rootSql, { goalId, workspaceId: WS }, nowMs),
    ]);
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['capped', 'reserved']);
    expect(decisions.map((decision) => decision.attemptsInWindow)).toEqual([
      GOAL_HOLDER_RESPAWN_RATE_LIMIT,
      GOAL_HOLDER_RESPAWN_RATE_LIMIT,
    ]);

    const [row] = await rootSql<{ attempts: unknown[] }[]>`
      SELECT metadata #> '{holderRespawn,attempts}' AS attempts
        FROM harness_shared.goals
       WHERE workspace_id = ${WS} AND id = ${goalId}`;
    expect(row?.attempts).toHaveLength(GOAL_HOLDER_RESPAWN_RATE_LIMIT);
  }, 60_000);

  it('concurrent GOAL entries atomically elect one successor and persist a bounded handoff', async () => {
    const goalId = 'goal-concurrent-election';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    const enter = (ownerId: string) =>
      setMode({
        workspaceId: WS,
        ownerId,
        modeId: GOAL_MODE,
        enabled: true,
        reason: `concurrent election ${ownerId}`,
        setBy: ownerId,
        subject: goalId,
        sql: rootSql,
      });
    const [a, b] = await Promise.all([enter('su-election-a'), enter('su-election-b')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const refused = a.ok ? b : a;
    expect(refused).toMatchObject({
      goalElectionConflict: { goalId, electedEpoch: 1 },
    });

    const rows = await goalModeRows(goalId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.goal_lease_epoch)).toBe(1);
    expect(rows[0]?.goal_handoff_from_owner_id).toBeNull();

    const elected = rows[0]!;
    sessions.set(elected.owner_id, liveSignals());
    const holderRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [goalId] });
    const verdicts = await resolveLiveness(holderRows.map((holder) => holder.ownerId));
    const fold = resolveGoalHoldersFromRows(
      goalId,
      WS,
      holderRows,
      verdicts,
    );
    expect(fold.elected?.ownerId).toBe(elected.owner_id);
    expect(fold.live.map((holder) => holder.ownerId)).toEqual([elected.owner_id]);
    expect(fold.overlap.status).toBe('none');
  }, 60_000);

  it('kill its session → the respawner brings it back → stable, no double launch, no human', async () => {
    await seedGoal({ id: GOAL, launchSettings: RESPAWN_SETTINGS });
    await attachHolder(INITIAL_HOLDER, GOAL);
    sessions.set(INITIAL_HOLDER, liveSignals());

    const { deps, launches } = drillDeps();

    // Tick A — the holder is alive: the real oracle classifies it, the real fold
    // says 'held', and the respawner leaves the goal alone.
    const tickA = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tickA).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0, skipped: false });
    expect(launches).toEqual([]);

    // THE KILL — the session dies: its substrate now presents dead-session
    // signals. No verdict is injected anywhere.
    sessions.set(INITIAL_HOLDER, killedSignals());

    // Tick B — loss detected via the real chain; a replacement is launched and
    // the REAL setMode attaches the pre-pinned identity.
    const tickB = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tickB).toMatchObject({
      scanned: 1,
      eligible: 1,
      attempted: 1,
      respawned: 1,
      launchFailed: 0,
      launchRefused: 0,
      attachFailed: 0,
    });
    expect(launches).toEqual([GOAL]);

    // The attach is real durable state: a second mode='goal' row for the
    // replacement, stamped by the respawner, subject = the goal.
    const rows = await goalModeRows(GOAL);
    expect(rows.map((r) => r.owner_id).sort()).toEqual([INITIAL_HOLDER, 'su-replacement-1'].sort());
    const replacement = rows.find((r) => r.owner_id === 'su-replacement-1');
    expect(replacement).toMatchObject({
      mode: GOAL_MODE,
      subject: GOAL,
      set_by: 'goal-holder-respawner',
      goal_handoff_from_owner_id: INITIAL_HOLDER,
    });
    expect(Number(replacement?.goal_lease_epoch)).toBe(2);

    // ...and it is audited (append-only agent_mode_changes).
    const audit = await rootSql<{ new_mode: string | null }[]>`
      SELECT new_mode FROM harness_shared.agent_mode_changes
       WHERE workspace_id = ${WS} AND owner_id = ${'su-replacement-1'} AND new_mode = ${GOAL_MODE}`;
    expect(audit.length).toBe(1);

    // "Watch it come back": the replacement session boots and registers live
    // presence; the REAL read-side fold over the REAL rows now says 'held' with
    // the replacement as the live holder.
    sessions.set('su-replacement-1', liveSignals());
    const holderRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [GOAL] });
    const verdicts = await resolveLiveness(holderRows.map((r) => r.ownerId));
    const fold = resolveGoalHoldersFromRows(GOAL, WS, holderRows, verdicts);
    expect(fold.liveness).toBe('held');
    expect(fold.live.map((h) => h.ownerId)).toEqual(['su-replacement-1']);

    // Tick C — stability: held ⇒ no second launch, damping heals, nothing new.
    const tickC = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tickC).toMatchObject({ attempted: 0, respawned: 0 });
    expect(launches).toEqual([GOAL]);
  }, 60_000);

  it('re-kicks a live but partial first-turn holder before a rate-governed replacement', async () => {
    const goalId = 'goal-partial-first-turn';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder(INITIAL_HOLDER, goalId);
    sessions.set(INITIAL_HOLDER, liveSignals());
    const holder = (await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [goalId] }))[0]!;
    let nowMs = holder.setAtMs + GOAL_HOLDER_FIRST_TURN_GRACE_MS - 1;
    let evidenceUnavailable = false;
    const kicks: number[] = [];
    const { deps, launches } = drillDeps({
      now: () => nowMs,
      rekickStates: new Map(),
      attestHolder: async () => ({
        status: evidenceUnavailable ? 'unknown' : 'partial', workspaceId: WS, goalId, ownerId: INITIAL_HOLDER,
        modeSetAt: new Date(holder.setAtMs).toISOString(), loopActive: true,
        checkpointAt: null, portfolioAct: null, missing: ['checkpoint', 'portfolio-act'],
        unavailable: evidenceUnavailable ? ['portfolio-act'] : [],
      }),
      rekick: async (_goal, _ownerId, attempt) => { kicks.push(attempt); return { woken: 1, staged: 0 }; },
    });
    expect(await runGoalHolderRespawnOnce(rootSql, deps)).toMatchObject({ partialFirstTurn: 0, attempted: 0 });
    nowMs += 2;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt === 2) {
        evidenceUnavailable = true;
        expect(await runGoalHolderRespawnOnce(rootSql, deps))
          .toMatchObject({ partialFirstTurn: 0, rekicked: 0, attempted: 0 });
        evidenceUnavailable = false;
      }
      const tick = await runGoalHolderRespawnOnce(rootSql, deps);
      expect(tick).toMatchObject({ partialFirstTurn: 1, rekicked: 1, attempted: 0 });
      nowMs += GOAL_HOLDER_REKICK_INTERVAL_MS;
    }
    expect(kicks).toEqual([1, 2, 3]);
    const recovered = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(recovered).toMatchObject({ partialFirstTurn: 1, attempted: 1, respawned: 1 });
    expect(launches).toEqual([goalId]);
    const rows = await goalModeRows(goalId);
    expect(rows.at(-1)).toMatchObject({ owner_id: 'su-replacement-1', subject: goalId });
  }, 60_000);

  it('accepts only a successful, current-window, exact-goal holder portfolio act from the real ledger', async () => {
    const goalId = 'goal-attestation-ledger';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder(INITIAL_HOLDER, goalId);
    const holder = (await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [goalId] }))[0]!;
    const insert = async (tool: string, goal: string, status: string, atMs: number) => {
      await rootSql`
        INSERT INTO harness_shared.tool_invocations
          (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key,
           status, coord_owner_id, goal_id, goal_actor_class, invoked_at)
        VALUES (${WS}, ${HARNESS}, 'test', ${tool}, 'su', 'test', 'test',
                ${status}, ${INITIAL_HOLDER}, ${goal}, 'holder-agent',
                to_timestamp(${atMs}::bigint / 1000.0))`;
    };
    await insert('plans:new', goalId, 'ok', holder.setAtMs - 1_000);
    await insert('plans:new', 'other-goal', 'ok', holder.setAtMs + 1_000);
    await insert('goals:list', goalId, 'ok', holder.setAtMs + 2_000);
    await insert('plans:new', goalId, 'refused', holder.setAtMs + 3_000);
    expect(await readGoalHolderPortfolioAct(rootSql, WS, goalId, INITIAL_HOLDER, holder.setAtMs)).toBeNull();
    await insert('plans:new', goalId, 'ok', holder.setAtMs + 4_000);
    expect(await readGoalHolderPortfolioAct(rootSql, WS, goalId, INITIAL_HOLDER, holder.setAtMs))
      .toMatchObject({ tool: 'plans:new' });
  }, 60_000);

  it('a post-wake tool-active turn stays held; a true warm wake miss still respawns', async () => {
    await seedGoal({ id: GOAL, launchSettings: RESPAWN_SETTINGS });
    await attachHolder(INITIAL_HOLDER, GOAL);
    // fetchWakeability's real-PG regression verifies this shape is produced
    // from tool_invocations even when agent_activity does not advance.
    sessions.set(INITIAL_HOLDER, { ...liveSignals(), wakeAttemptMiss: false });

    const holderRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [GOAL] });
    const liveVerdicts = await resolveLiveness(holderRows.map((holder) => holder.ownerId));
    const liveFold = resolveGoalHoldersFromRows(GOAL, WS, holderRows, liveVerdicts);
    expect(liveFold.liveness).toBe('held');
    expect(liveFold.live.map((holder) => holder.ownerId)).toEqual([INITIAL_HOLDER]);

    const { deps, launches } = drillDeps();
    const liveTick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(liveTick).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
    const [stillActive] = await rootSql<{ status: string }[]>`
      SELECT status FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    expect(stillActive?.status).toBe('active');

    // Negative control: no post-wake turn activity still produces the confirmed
    // miss and lets the same read/respawn path classify the holder as lost.
    sessions.set(INITIAL_HOLDER, { ...liveSignals(), liveTurn: false, wakeAttemptMiss: true });
    const missedRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [GOAL] });
    const missedVerdicts = await resolveLiveness(missedRows.map((holder) => holder.ownerId));
    const missedFold = resolveGoalHoldersFromRows(GOAL, WS, missedRows, missedVerdicts);
    expect(missedFold.liveness).toBe('lost');

    const missTick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(missTick).toMatchObject({ scanned: 1, eligible: 1, attempted: 1, respawned: 1 });
    expect(launches).toEqual([GOAL]);
  }, 60_000);

  it('install ≠ start (D-002): an installed-but-never-started package goal is never auto-spawned', async () => {
    await seedGoal({ id: 'goal-installed-only', launchSettings: RESPAWN_SETTINGS });
    // No holder was ever attached: the row exists (installed), nobody started it.
    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
    expect(await goalModeRows('goal-installed-only')).toEqual([]);
  }, 60_000);

  it('started metadata + lost GOAL row is recovered, then remains stable without a double launch', async () => {
    const goalId = 'goal-started-row-lost';
    await seedGoal({
      id: goalId,
      launchSettings: RESPAWN_SETTINGS,
      metadata: { agentOwnerId: INITIAL_HOLDER },
    });
    // The goal was started (the post-attach metadata stamp survived), but its
    // canonical GOAL-mode row was lost. This is the production failure: before
    // EI-211659 the respawner folded it as `unheld` and confused it with the
    // installed-only control above.
    expect(await goalModeRows(goalId)).toEqual([]);

    const { deps, launches } = drillDeps();
    const recovered = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(recovered).toMatchObject({ attempted: 1, respawned: 1 });
    expect(launches).toEqual([goalId]);
    expect((await goalModeRows(goalId)).map((r) => r.owner_id)).toEqual(['su-replacement-1']);

    sessions.set('su-replacement-1', liveSignals());
    const stable = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(stable).toMatchObject({ attempted: 0, respawned: 0 });
    expect(launches).toEqual([goalId]);
  }, 60_000);

  it('respawns the lost elected lease even when an older historical GOAL row is still live', async () => {
    const goalId = 'goal-elected-lost-historical-live';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-historical-live', goalId);
    await attachHolder('su-elected-dead', goalId, 'su-historical-live');
    sessions.set('su-historical-live', liveSignals());
    sessions.set('su-elected-dead', killedSignals());

    const beforeRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: [goalId] });
    const beforeVerdicts = await resolveLiveness(beforeRows.map((holder) => holder.ownerId));
    const before = resolveGoalHoldersFromRows(goalId, WS, beforeRows, beforeVerdicts);
    expect(before.elected?.ownerId).toBe('su-elected-dead');
    expect(before.liveness).toBe('lost');
    expect(before.allLive.map((holder) => holder.ownerId)).toEqual(['su-historical-live']);

    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ attempted: 1, respawned: 1 });
    expect(launches).toEqual([goalId]);
    const rows = await goalModeRows(goalId);
    const replacement = rows.find((row) => row.owner_id === 'su-replacement-1')!;
    expect(Number(replacement.goal_lease_epoch)).toBe(3);
    expect(replacement.goal_handoff_from_owner_id).toBe('su-elected-dead');
  }, 60_000);

  it('refuses and neutralizes a stale respawn attach after a concurrent legitimate takeover', async () => {
    const goalId = 'goal-respawn-cas-race';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder(INITIAL_HOLDER, goalId);
    sessions.set(INITIAL_HOLDER, killedSignals());

    let releaseLaunch!: () => void;
    let launchReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      launchReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const neutralize = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps } = drillDeps({
      launch: async () => {
        launchReached();
        await release;
        return { ownerId: 'su-stale-respawn', warnings: [] };
      },
      neutralize,
    });

    const tickPromise = runGoalHolderRespawnOnce(rootSql, deps);
    await reached;
    await attachHolder('su-legitimate-takeover', goalId, INITIAL_HOLDER);
    sessions.set('su-legitimate-takeover', liveSignals());
    releaseLaunch();

    const tick = await tickPromise;
    expect(tick).toMatchObject({ attempted: 1, respawned: 0, attachFailed: 1 });
    expect(neutralize).toHaveBeenCalledWith(
      expect.objectContaining({ goalId }),
      'su-stale-respawn',
      expect.stringContaining('already elected to su-legitimate-takeover at epoch 2'),
    );
    const rows = await goalModeRows(goalId);
    expect(rows.map((row) => row.owner_id).sort()).toEqual(
      [INITIAL_HOLDER, 'su-legitimate-takeover'].sort(),
    );
    // A NUMBER, not the string '2': the canonical operator client parses bigint as a JS
    // number and this fixture now mirrors it. The old hand-rolled fixture used a bare
    // postgres() client with no bigint parser, so this assertion used to require '2' —
    // i.e. it encoded the FIXTURE's non-production typing as the expected contract, the
    // exact direction-inverting hazard EI-18698602043482898 describes.
    expect(rows.find((row) => row.owner_id === 'su-legitimate-takeover')?.goal_lease_epoch).toBe(2);
    expect(rows.some((row) => row.owner_id === 'su-stale-respawn')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('already elected to su-legitimate-takeover at epoch 2'),
    );
    warn.mockRestore();
  }, 60_000);

  it('a goal on the DEFAULT holder policy (onLoss=deactivate) loses its holder without respawn', async () => {
    // launch_settings NULL: the real parse chain resolves the D-001 default —
    // requireLive true, onLoss 'deactivate' — so the respawner must not touch it.
    await seedGoal({ id: 'goal-default-policy', launchSettings: undefined });
    await attachHolder('su-default-holder', 'goal-default-policy');
    sessions.set('su-default-holder', killedSignals());

    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ scanned: 1, eligible: 0, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
    expect((await goalModeRows('goal-default-policy')).map((r) => r.owner_id)).toEqual([
      'su-default-holder',
    ]);
  }, 60_000);

  it('a paused package goal with a dead holder is not even swept (status predicate)', async () => {
    await seedGoal({ id: 'goal-paused', status: 'paused', launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-paused-holder', 'goal-paused');
    sessions.set('su-paused-holder', killedSignals());

    const { deps, launches } = drillDeps();
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ scanned: 0, eligible: 0, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
  }, 60_000);

  it("an UNRESOLVABLE holder (degraded oracle fetch) is 'unknown', never 'lost' — no spawn", async () => {
    await seedGoal({ id: 'goal-unknown', launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-vanished-holder', 'goal-unknown');
    // No fixture entry: the oracle returns an explicit, in-band UNKNOWN verdict.
    // Assert its classification as well as the absence of a launch: incorrectly
    // treating this verdict as a live holder also suppresses a launch.
    const holderRows = await readGoalHolderRows(rootSql, { workspaceId: WS, goalIds: ['goal-unknown'] });
    const verdicts = await resolveLiveness(holderRows.map((holder) => holder.ownerId));
    expect(verdicts.get('su-vanished-holder')).toMatchObject({ sessionState: null, signalMissing: true });
    const fold = resolveGoalHoldersFromRows('goal-unknown', WS, holderRows, verdicts);
    expect(fold.liveness).toBe('unknown');
    expect(fold.elected?.live).toBeNull();
    expect(fold.live).toEqual([]);
    // A selected permanent wrong-seam control deliberately turns the oracle's
    // measured UNKNOWN into ended only at the respawner input. The assertions
    // above still prove the real oracle and fold saw unknown. The launch
    // assertion below must fail under this control, proving it rejects the
    // original unknown-as-loss failure instead of merely seeing no holder row.
    const wrongUnknownAsLoss = process.env.PAPERCUSP_GOAL_UNKNOWN_CONTROL === 'treat-unknown-as-lost';
    const { deps, launches } = drillDeps(wrongUnknownAsLoss ? {
      resolveLiveness: async (ownerIds) => {
        const measured = await resolveLiveness(ownerIds);
        const actual = measured.get('su-vanished-holder');
        if (!actual) throw new Error('unknown-holder control lost its oracle calibration');
        return new Map([...measured, ['su-vanished-holder', {
          ...actual, sessionState: 'ended' as const, signalMissing: undefined,
        }]]);
      },
    } : {});
    const tick = await runGoalHolderRespawnOnce(rootSql, deps);
    expect(tick).toMatchObject({ scanned: 1, eligible: 1, attempted: 0, respawned: 0 });
    expect(launches).toEqual([]);
    // A passing outer harness must detect the permanent unknown-as-loss control,
    // rather than cite an intentionally failing suite as successful execution.
    const control = drillDeps({
      resolveLiveness: async (ownerIds) => {
        const measured = await resolveLiveness(ownerIds);
        const actual = measured.get('su-vanished-holder');
        if (!actual) throw new Error('unknown-holder control lost its oracle calibration');
        return new Map([...measured, ['su-vanished-holder', {
          ...actual, sessionState: 'ended' as const, signalMissing: undefined,
        }]]);
      },
    });
    const controlTick = await runGoalHolderRespawnOnce(rootSql, control.deps);
    expect(controlTick.attempted).toBe(1);
    expect(control.launches).toHaveLength(1);
  }, 60_000);
});

/**
 * WI-10002085 — the safety cap must actually PAUSE, against a real server.
 *
 * Why this exists. `pauseGoalForHolderRespawnRateCap` shipped with an uncast parameter inside
 * jsonb_build_object (VARIADIC "any"), so Postgres refused the UPDATE at PARSE time — "could
 * not determine data type of parameter $4" — on every call. The rail could therefore NEVER
 * pause a goal: one tripped the cap, was marked needsHuman at 15:37:31Z, and kept running as
 * status='active' for ~50 minutes with `pause` and `escalatedAtMs` both absent.
 *
 * It was invisible because the only coverage this statement had mocked `sql`, which asserts the
 * statement was BUILT correctly and cannot observe a server-side PARSE failure by construction.
 * So the test that closes it has to execute the real statement against a real Postgres.
 */
describe('holder-respawn safety cap actually pauses the goal (WI-10002085)', () => {
  type GoalMeta = {
    pause?: { reason?: string; pausedBy?: string; pausedAtMs?: number };
    holderRespawn?: { needsHuman?: boolean; escalatedAtMs?: number; attemptsInWindow?: number };
  };

  it('flips status to paused and records the pause + escalation stamps', async () => {
    const goalId = `goal-cap-${randomBytes(4).toString('hex')}`;
    await seedGoal({
      id: goalId,
      status: 'active',
      metadata: {
        holderRespawn: {
          needsHuman: true,
          reason: 'hourly-respawn-cap',
          limit: GOAL_HOLDER_RESPAWN_RATE_LIMIT,
          windowMs: GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS,
        },
      },
    });

    // The executor is installed by importing goals/stop-fanout for its side effect; stubbing the
    // seam keeps this test on the SQL. The code under test reads only `unattributedActiveLoops`
    // and `degraded` from the report, so the rest is filler for the interface.
    const stops: Array<{ goalId: string; status: string }> = [];
    setGoalTransitionExecutor(async (input) => {
      stops.push({ goalId: input.goalId, status: input.status });
      return {
        goalId: input.goalId,
        status: input.status,
        potsStopped: [],
        unattributedActiveLoops: 0,
        degraded: false,
      } as unknown as GoalStopReport;
    });

    const nowMs = Date.now();
    expect(await pauseGoalForHolderRespawnRateCap(rootSql, { goalId, workspaceId: WS }, 6, nowMs))
      .toBe(true);

    const [row] = await rootSql<Array<{ status: string; metadata: GoalMeta }>>`
      SELECT status, metadata FROM harness_shared.goals WHERE id = ${goalId}`;

    // metadata.pause must be an OBJECT, not a JSON string — and which of those you get depends
    // on the CLIENT, which is worth stating precisely because it is easy to misread as a
    // production bug (EI-18698602043482898). A pre-stringified `${v}::jsonb` param is resolved
    // to OID 3802 by the cast, so postgres-js serializes it through serializers['3802']: the
    // DEFAULT one JSON.stringifies it AGAIN and the value lands as a jsonb scalar string. The
    // canonical operator client is not affected — buildClient installs restoreRawJsonbSerializer,
    // a hybrid that passes an already-stringified string through unchanged. But THIS test (like
    // every integration test in this file) uses a raw postgres() client, where the default
    // serializer applies. `::text::jsonb` types the parameter as text first and so behaves
    // identically under BOTH clients, which is what lets this assertion mean the same thing here
    // as in production instead of diverging from it.
    // The symptom, inverted: status moved, and both stamps the live incident lacked are present.
    expect(row?.status).toBe('paused');
    expect(row?.metadata.pause?.reason).toMatch(/human review is required/i);
    expect(row?.metadata.pause?.pausedAtMs).toBe(nowMs);
    expect(row?.metadata.holderRespawn?.escalatedAtMs).toBe(nowMs);
    expect(row?.metadata.holderRespawn?.attemptsInWindow).toBe(6);
    expect(row?.metadata.holderRespawn?.needsHuman).toBe(true); // preserved, not clobbered
    expect(stops).toEqual([{ goalId, status: 'paused' }]);
  }, 60_000);

  it('is a no-op for a goal that is not flagged needsHuman (the WHERE guard holds)', async () => {
    const goalId = `goal-nocap-${randomBytes(4).toString('hex')}`;
    await seedGoal({ id: goalId, status: 'active', metadata: {} });
    const stops: string[] = [];
    setGoalTransitionExecutor(async (input) => {
      stops.push(input.goalId);
      return { goalId: input.goalId, status: input.status, potsStopped: [] } as unknown as GoalStopReport;
    });

    expect(await pauseGoalForHolderRespawnRateCap(rootSql, { goalId, workspaceId: WS }, 6, Date.now()))
      .toBe(false);

    const [row] = await rootSql<Array<{ status: string }>>`
      SELECT status FROM harness_shared.goals WHERE id = ${goalId}`;
    expect(row?.status).toBe('active');
    expect(stops).toEqual([]); // no row changed => no stop fan-out
  }, 60_000);

  it('NEGATIVE CONTROL: the uncast form this bug shipped cannot even PARSE', async () => {
    // Reproduced inline rather than by mutating the source tree — a mutate-and-restore probe
    // races git-sync's whole-tree sweep and has committed a mutant in this repo before. This is
    // what proves the two assertions above are not passing for some unrelated reason.
    await expect(rootSql`SELECT jsonb_build_object('attemptsInWindow', ${6}) AS v`).rejects.toThrow(
      /could not determine data type of parameter/i,
    );

    // ...and the cast — exactly the fix — is what makes it parse.
    const [ok] = await rootSql<Array<{ v: { attemptsInWindow: number } }>>`
      SELECT jsonb_build_object('attemptsInWindow', ${6}::int) AS v`;
    expect(ok?.v).toEqual({ attemptsInWindow: 6 });
  }, 60_000);
});

/**
 * EI-23821882158913073 — the SECOND half of the incident above, and the durable one.
 *
 * WI-10002085 fixed the PARSE failure that made the pause write throw. This covers what
 * happened NEXT: the throw was caught, the handler cleared an IN-MEMORY latch and
 * continued "so the next tick retries" — but every branch that can escalate or clear the
 * durable latch sits under decideFlapDamping({ healthy: false }). The holder then
 * RECOVERED, so the branch was never re-entered and the goal kept needsHuman:true with no
 * escalatedAtMs for 7h, while reserveGoalHolderRespawnRateSlot's clearing ELSE — reachable
 * only from the same restart path — could not run either. Measured on the live row for goal
 * work-on-everything-fresh-grading-and-improvement-60d3a8 (status active, needsHuman true,
 * escalatedAtMs NULL, 6 attempts spanning 15:31-15:36Z, still unconverged at 22:5xZ).
 *
 * These execute the real statement against a real Postgres for the same reason the block
 * above does: a mocked `sql` asserts a statement was BUILT and cannot observe a server-side
 * PARSE failure by construction — which is exactly how the original defect shipped.
 */
describe('a stranded needs-human latch converges instead of latching forever (EI-23821882158913073)', () => {
  type Latch = {
    needsHuman?: boolean;
    needsHumanAtMs?: number;
    escalatedAtMs?: number;
    reason?: string;
    attempts?: number[];
  };

  async function readLatch(goalId: string): Promise<{ status: string; latch: Latch }> {
    const [row] = await rootSql<Array<{ status: string; metadata: { holderRespawn?: Latch } }>>`
      SELECT status, metadata FROM harness_shared.goals WHERE id = ${goalId}`;
    return { status: row?.status ?? '', latch: row?.metadata?.holderRespawn ?? {} };
  }

  /** The capped shape the respawner leaves behind, with attempts at a chosen age. */
  async function seedStrandedGoal(opts: {
    id: string;
    attemptAgesMs: number[];
    escalatedAtMs?: number;
    needsHuman?: boolean;
    nowMs: number;
  }): Promise<void> {
    await seedGoal({
      id: opts.id,
      status: 'active',
      metadata: {
        holderRespawn: {
          needsHuman: opts.needsHuman ?? true,
          needsHumanAtMs: opts.nowMs - 60_000,
          reason: 'hourly-respawn-cap',
          limit: GOAL_HOLDER_RESPAWN_RATE_LIMIT,
          windowMs: GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS,
          attempts: opts.attemptAgesMs.map((age) => opts.nowMs - age),
          ...(opts.escalatedAtMs === undefined ? {} : { escalatedAtMs: opts.escalatedAtMs }),
        },
      },
    });
  }

  it('CLEARS the latch once the attempts age out — the live incident shape', async () => {
    const nowMs = Date.now();
    const goalId = `goal-strand-aged-${randomBytes(4).toString('hex')}`;
    // Every attempt far outside the trailing window, as on the measured row (~7h old).
    await seedStrandedGoal({
      id: goalId,
      nowMs,
      attemptAgesMs: Array.from(
        { length: GOAL_HOLDER_RESPAWN_RATE_LIMIT },
        (_, i) => GOAL_HOLDER_RESPAWN_RATE_WINDOW_MS + 60_000 * (i + 1),
      ),
    });

    await expect(
      reconcileStrandedGoalHolderRespawnLatch(rootSql, { goalId, workspaceId: WS }, nowMs),
    ).resolves.toEqual({ kind: 'cleared', attemptsInWindow: 0 });

    const { status, latch } = await readLatch(goalId);
    expect(latch.needsHuman).toBe(false);
    expect(latch.needsHumanAtMs).toBeUndefined();
    expect(latch.escalatedAtMs).toBeUndefined();
    expect(latch.reason).toBeUndefined();
    expect(latch.attempts).toEqual([]); // pruned, not merely unflagged
    // A stale latch whose holder recovered must NOT pause a working goal. This is the
    // assertion that keeps a future "reconcile = always pause" simplification honest:
    // the live row belongs to a goal with a healthy holder and running agents.
    expect(status).toBe('active');
  }, 60_000);

  it('ESCALATES rather than clearing while the cap still genuinely holds', async () => {
    const nowMs = Date.now();
    const goalId = `goal-strand-live-${randomBytes(4).toString('hex')}`;
    await seedStrandedGoal({
      id: goalId,
      nowMs,
      attemptAgesMs: Array.from({ length: GOAL_HOLDER_RESPAWN_RATE_LIMIT }, (_, i) => 60_000 * (i + 1)),
    });

    await expect(
      reconcileStrandedGoalHolderRespawnLatch(rootSql, { goalId, workspaceId: WS }, nowMs),
    ).resolves.toEqual({ kind: 'escalate', attemptsInWindow: GOAL_HOLDER_RESPAWN_RATE_LIMIT });

    // The reconciler decides; the CALLER drives escalate+pause. So the latch is left intact
    // and the durable budget is NOT handed back early.
    const { status, latch } = await readLatch(goalId);
    expect(latch.needsHuman).toBe(true);
    expect(latch.escalatedAtMs).toBeUndefined();
    expect(status).toBe('active');
  }, 60_000);

  it('IDEMPOTENT: a latch that already carries escalatedAtMs is never re-driven', async () => {
    const nowMs = Date.now();
    const escalatedAtMs = nowMs - 5_000;
    const goalId = `goal-strand-done-${randomBytes(4).toString('hex')}`;
    await seedStrandedGoal({
      id: goalId,
      nowMs,
      escalatedAtMs,
      attemptAgesMs: Array.from({ length: GOAL_HOLDER_RESPAWN_RATE_LIMIT }, (_, i) => 60_000 * (i + 1)),
    });

    await expect(
      reconcileStrandedGoalHolderRespawnLatch(rootSql, { goalId, workspaceId: WS }, nowMs),
    ).resolves.toEqual({ kind: 'noop' });

    // Untouched: no double-pause, no re-stamp.
    const { status, latch } = await readLatch(goalId);
    expect(latch.escalatedAtMs).toBe(escalatedAtMs);
    expect(latch.needsHuman).toBe(true);
    expect(status).toBe('active');
  }, 60_000);

  it('is a no-op for a goal carrying no needs-human latch at all', async () => {
    const nowMs = Date.now();
    const goalId = `goal-strand-none-${randomBytes(4).toString('hex')}`;
    await seedStrandedGoal({ id: goalId, nowMs, needsHuman: false, attemptAgesMs: [60_000] });

    await expect(
      reconcileStrandedGoalHolderRespawnLatch(rootSql, { goalId, workspaceId: WS }, nowMs),
    ).resolves.toEqual({ kind: 'noop' });

    const { latch } = await readLatch(goalId);
    expect(latch.needsHuman).toBe(false);
    // The untouched no-op must not prune the budget either.
    expect(latch.attempts).toHaveLength(1);
  }, 60_000);

  it('does not reach across workspaces or into a non-active goal', async () => {
    const nowMs = Date.now();
    const pausedId = `goal-strand-paused-${randomBytes(4).toString('hex')}`;
    await seedStrandedGoal({ id: pausedId, nowMs, attemptAgesMs: [60_000] });
    await rootSql`UPDATE harness_shared.goals SET status = 'paused' WHERE id = ${pausedId}`;

    // An already-paused goal has had its human hand-off; re-converging it would fight
    // whatever a human did next.
    await expect(
      reconcileStrandedGoalHolderRespawnLatch(rootSql, { goalId: pausedId, workspaceId: WS }, nowMs),
    ).resolves.toEqual({ kind: 'noop' });

    // A matching id in ANOTHER workspace must not be reachable.
    await expect(
      reconcileStrandedGoalHolderRespawnLatch(
        rootSql,
        { goalId: pausedId, workspaceId: 'some-other-workspace' },
        nowMs,
      ),
    ).resolves.toEqual({ kind: 'noop' });
  }, 60_000);
});

describe('superseded holder GOAL rows are retired after the handoff window (WI-10005573)', () => {
  async function impliedRows(ownerId: string, goalId: string) {
    return await rootSql<{ mode: string }[]>`
      SELECT mode FROM harness_shared.agent_modes
       WHERE workspace_id = ${WS} AND owner_id = ${ownerId}
         AND implied_by ->> 'mode' = ${GOAL_MODE} AND implied_by ->> 'subject' = ${goalId}`;
  }

  async function expireHandoff(goalId: string): Promise<void> {
    await rootSql`
      UPDATE harness_shared.agent_modes
         SET goal_handoff_expires_at = now() - interval '1 second'
       WHERE workspace_id = ${WS} AND mode = ${GOAL_MODE} AND subject = ${goalId}
         AND goal_handoff_expires_at IS NOT NULL`;
  }

  it('keeps superseded rows inside the handoff window, then retires them and their implied posture', async () => {
    const goalId = 'goal-superseded-retire';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-first', goalId);
    await attachHolder('su-second', goalId, 'su-first');
    await attachHolder('su-third', goalId, 'su-second');
    expect((await impliedRows('su-first', goalId)).length).toBeGreaterThan(0);

    // Inside the elected holder's bounded handoff window nothing is retired:
    // the predecessor may still be finishing its atomic handoff.
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId)).resolves.toEqual({
      retired: [],
      leftArmed: [],
      awaitsCancelled: 0,
      claimsReleased: [],
    });
    expect((await goalModeRows(goalId)).map((row) => row.owner_id).sort()).toEqual([
      'su-first',
      'su-second',
      'su-third',
    ]);

    await expireHandoff(goalId);
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId)).resolves.toEqual({
      retired: ['su-first', 'su-second'],
      leftArmed: [],
      awaitsCancelled: 0,
      claimsReleased: [],
    });
    const rows = await goalModeRows(goalId);
    expect(rows.map((row) => row.owner_id)).toEqual(['su-third']);
    expect(await impliedRows('su-first', goalId)).toEqual([]);
    expect(await impliedRows('su-second', goalId)).toEqual([]);
    expect((await impliedRows('su-third', goalId)).length).toBeGreaterThan(0);

    // Idempotent: a second sweep finds nothing left to retire.
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId)).resolves.toEqual({
      retired: [],
      leftArmed: [],
      awaitsCancelled: 0,
      claimsReleased: [],
    });
  }, 60_000);

  it('cancels exactly the retired holders\' goal-scoped awaits, and nothing else', async () => {
    // Measured 2026-10-02 18:03Z: one goal:plan-placement fire resumed six superseded
    // 60d3a8 holders headless, and each re-armed within a minute. Retiring the GOAL
    // row alone leaves that wake source live, so the reaper must cancel it too.
    const goalId = 'goal-superseded-awaits';
    const planSlug = 'goal-superseded-awaits-plan';
    const otherPlan = 'unrelated-plan-awaits';
    const placementKey = `goal:plan-placement:${goalId}`;
    const acceptanceKey = `plan:acceptance:${planSlug}`;
    await rootSql`DELETE FROM harness_shared.event_awaits WHERE event_key LIKE ${'%' + goalId + '%'} OR event_key LIKE ${'%' + otherPlan + '%'}`;
    await rootSql`DELETE FROM harness_shared.harness_plans WHERE plan_slug IN (${planSlug}, ${otherPlan})`;
    await rootSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, goal_id)
      VALUES (${WS}, 'papercusp', ${planSlug}, ${goalId}), (${WS}, 'papercusp', ${otherPlan}, NULL)`;
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-first', goalId);
    await attachHolder('su-second', goalId, 'su-first');
    await attachHolder('su-third', goalId, 'su-second');

    async function arm(subscriber: string, key: string, fired = false): Promise<number> {
      const [row] = await rootSql<{ id: number }[]>`
        INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key, policy, once, fired_at)
        VALUES ('default', ${subscriber}, ${key}, 'wake', true, ${fired ? new Date() : null})
        RETURNING id`;
      return Number(row!.id);
    }
    const cancelled = [
      await arm('su-first', placementKey),
      await arm('su-first', acceptanceKey),
      await arm('su-second', placementKey),
    ];
    const kept = [
      // The elected holder keeps its wake source.
      await arm('su-third', placementKey),
      // A retired holder's await on a key this goal does not own is not goal residue.
      await arm('su-first', `plan:acceptance:${otherPlan}`),
      await arm('su-first', 'work-item:done:WI-unrelated'),
      // A non-holder awaiting the goal's plan acceptance (a grader) is untouched.
      await arm('su-grader', acceptanceKey),
    ];
    // An already-fired registration is history, not a pending wake.
    const fired = await arm('su-second', placementKey, true);

    // Inside the handoff window: nothing retired, so nothing cancelled.
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId)).resolves.toEqual({
      retired: [],
      leftArmed: [],
      awaitsCancelled: 0,
      claimsReleased: [],
    });
    await expireHandoff(goalId);
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId)).resolves.toEqual({
      retired: ['su-first', 'su-second'],
      leftArmed: [],
      awaitsCancelled: 3,
      claimsReleased: [],
    });

    const state = await rootSql<{ id: number; cancelled_at: Date | null }[]>`
      SELECT id, cancelled_at FROM harness_shared.event_awaits
       WHERE id = ANY(${rootSql.array([...cancelled, ...kept, fired])}::bigint[])`;
    const byId = new Map(state.map((row) => [Number(row.id), row.cancelled_at]));
    for (const id of cancelled) expect(byId.get(id), `await ${id} should be cancelled`).not.toBeNull();
    for (const id of [...kept, fired]) expect(byId.get(id), `await ${id} should survive`).toBeNull();

    // The live 2026-10-02 shape: rows retired in an EARLIER pass, and a retired holder
    // that re-arms out of habit. Nothing is left to retire, yet the wake source must go.
    const rearmed = await arm('su-first', placementKey);
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId)).resolves.toEqual({
      retired: [],
      leftArmed: [],
      awaitsCancelled: 1,
      claimsReleased: [],
    });
    const [after] = await rootSql<{ cancelled_at: Date | null }[]>`
      SELECT cancelled_at FROM harness_shared.event_awaits WHERE id = ${rearmed}`;
    expect(after?.cancelled_at).not.toBeNull();
    const [elected] = await rootSql<{ cancelled_at: Date | null }[]>`
      SELECT cancelled_at FROM harness_shared.event_awaits WHERE id = ${kept[0]!}`;
    expect(elected?.cancelled_at, 'the elected holder keeps its wake source').toBeNull();
  }, 60_000);

  it('finds a former holder whose GOAL entry predates the subject column, via its retire row', async () => {
    // Measured 2026-10-02 on 60d3a8: su-2e6fb313 entered GOAL before migration 1331,
    // so its only enable row has a NULL subject, and the 18:12Z retire row was ALSO
    // written without one. Its pending plan:acceptance await was unattributable.
    const goalId = 'goal-pre-subject-holder';
    const placementKey = `goal:plan-placement:${goalId}`;
    await rootSql`DELETE FROM harness_shared.event_awaits WHERE event_key = ${placementKey}`;
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-legacy', goalId);
    await attachHolder('su-current', goalId, 'su-legacy');
    await rootSql`
      UPDATE harness_shared.agent_mode_changes SET subject = NULL
       WHERE workspace_id = ${WS} AND owner_id = 'su-legacy' AND new_mode = ${GOAL_MODE}`;
    const [legacyAwait] = await rootSql<{ id: number }[]>`
      INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key, policy, once)
      VALUES ('default', 'su-legacy', ${placementKey}, 'wake', true) RETURNING id`;

    await expireHandoff(goalId);
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId)).resolves.toEqual({
      retired: ['su-legacy'],
      leftArmed: [],
      awaitsCancelled: 1,
      claimsReleased: [],
    });
    // The retire row names the goal it cleared (setMode's disable audit carries the subject).
    const retireRows = await rootSql<{ subject: string | null }[]>`
      SELECT subject FROM harness_shared.agent_mode_changes
       WHERE workspace_id = ${WS} AND owner_id = 'su-legacy'
         AND old_mode = ${GOAL_MODE} AND new_mode IS NULL`;
    expect(retireRows.map((row) => row.subject)).toEqual([goalId]);
    const [after] = await rootSql<{ cancelled_at: Date | null }[]>`
      SELECT cancelled_at FROM harness_shared.event_awaits WHERE id = ${Number(legacyAwait!.id)}`;
    expect(after?.cancelled_at).not.toBeNull();
  }, 60_000);

  it('releases only the tenure claims a former holder left untouched (WI-10006948)', async () => {
    // Measured 2026-10-06: the epoch-25 holder of 60d3a8 self-claimed WI-10006823 at
    // 17:48Z, lost the lease at 19:13Z, and its carry-respawn successor never took a
    // turn (WI-10006814). Its session was parked, not ended, so no death sweep fired
    // and the item stayed wip on it for 2h+. The retirement sweep must free that claim
    // and nothing that is anyone's live work.
    const goalId = 'goal-former-holder-claims';
    await rootSql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id LIKE 'WI-fh-%'`;
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-old', goalId);
    await attachHolder('su-new', goalId, 'su-old');

    async function seedItem(id: string, opts: {
      takenBy: string; goal?: string | null; status?: string;
      takenAt: string; progressAt?: string;
    }): Promise<void> {
      await rootSql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, item_kind, status, goal_id, taken_by, taken_at, last_progress_at)
        VALUES (${WS}, 'papercusp', ${id}, 'task', ${opts.status ?? 'wip'},
                ${opts.goal === undefined ? goalId : opts.goal}, ${opts.takenBy},
                now() + ${opts.takenAt}::interval,
                ${opts.progressAt === undefined ? null : rootSql`now() + ${opts.progressAt}::interval`})`;
    }
    // Abandoned tenure custody: claimed while holding the goal, never touched again.
    await seedItem('WI-fh-pinned', { takenBy: 'su-old', takenAt: '-1 hour', progressAt: '-50 minutes' });
    // Same shape, but the claim moved by the time the release ran: not reported.
    await seedItem('WI-fh-moved', { takenBy: 'su-old', takenAt: '-1 hour' });
    // Kept: claimed AFTER the agent left GOAL (a later, deliberate act).
    await seedItem('WI-fh-after-exit', { takenBy: 'su-old', takenAt: '+1 hour' });
    // Kept: progressed after the exit (a holder that stood down but kept working).
    await seedItem('WI-fh-progressed', { takenBy: 'su-old', takenAt: '-1 hour', progressAt: '+1 hour' });
    // Kept: terminal.
    await seedItem('WI-fh-done', { takenBy: 'su-old', takenAt: '-1 hour', status: 'done' });
    // Kept: another goal's item, and an un-stamped item, held by the same former holder.
    await seedItem('WI-fh-other-goal', { takenBy: 'su-old', takenAt: '-1 hour', goal: 'some-other-goal' });
    await seedItem('WI-fh-unstamped', { takenBy: 'su-old', takenAt: '-1 hour', goal: null });
    // Kept: the elected holder's claim, and a worker who never held the goal.
    await seedItem('WI-fh-elected', { takenBy: 'su-new', takenAt: '-1 hour' });
    await seedItem('WI-fh-worker', { takenBy: 'su-worker', takenAt: '-1 hour' });

    const calls: Array<{ id: string; ownerId: string; harness: string; exitedAt: Date }> = [];
    // Models the compare-and-release on the test DB. The production default writes
    // through getOrgPg(), which here would reach the LIVE database (WI-10006585).
    const release = async (claim: { id: string; ownerId: string; harness: string; exitedAt: Date }) => {
      calls.push({ id: claim.id, ownerId: claim.ownerId, harness: claim.harness, exitedAt: claim.exitedAt });
      if (claim.id === 'WI-fh-moved') return false;
      const rows = await rootSql`
        UPDATE harness_shared.work_items SET taken_by = NULL, taken_at = NULL, status = 'open'
         WHERE workspace_id = ${WS} AND feature_id = ${claim.id} AND taken_by = ${claim.ownerId}
        RETURNING feature_id`;
      return rows.length === 1;
    };

    // Inside the handoff window su-old still holds its GOAL row, so it is not a
    // FORMER holder yet and nothing is touched.
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId, undefined, release)).resolves.toEqual({
      retired: [],
      leftArmed: [],
      awaitsCancelled: 0,
      claimsReleased: [],
    });
    expect(calls).toEqual([]);

    await expireHandoff(goalId);
    await expect(retireSupersededGoalHolderModes(rootSql, WS, goalId, undefined, release)).resolves.toEqual({
      retired: ['su-old'],
      leftArmed: [],
      awaitsCancelled: 0,
      claimsReleased: [{ id: 'WI-fh-pinned', ownerId: 'su-old' }],
    });
    expect(calls.map((c) => c.id).sort()).toEqual(['WI-fh-moved', 'WI-fh-pinned']);
    for (const call of calls) {
      expect(call).toMatchObject({ ownerId: 'su-old', harness: 'papercusp' });
      expect(call.exitedAt).toBeInstanceOf(Date);
    }

    const held = await rootSql<{ feature_id: string; taken_by: string | null }[]>`
      SELECT feature_id, taken_by FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id LIKE 'WI-fh-%' ORDER BY feature_id`;
    expect(Object.fromEntries(held.map((r) => [r.feature_id, r.taken_by]))).toEqual({
      'WI-fh-after-exit': 'su-old',
      'WI-fh-done': 'su-old',
      'WI-fh-elected': 'su-new',
      'WI-fh-moved': 'su-old',
      'WI-fh-other-goal': 'su-old',
      'WI-fh-pinned': null,
      'WI-fh-progressed': 'su-old',
      'WI-fh-unstamped': 'su-old',
      'WI-fh-worker': 'su-worker',
    });
  }, 60_000);

  it('the respawner sweep retires superseded rows on a healthy goal without launching', async () => {
    const goalId = 'goal-superseded-sweep';
    await seedGoal({ id: goalId, launchSettings: RESPAWN_SETTINGS });
    await attachHolder('su-old-holder', goalId);
    await attachHolder('su-live-holder', goalId, 'su-old-holder');
    sessions.set('su-old-holder', liveSignals());
    sessions.set('su-live-holder', liveSignals());
    await expireHandoff(goalId);

    const { deps, launches } = drillDeps();
    await runGoalHolderRespawnOnce(rootSql, deps);
    expect(launches).toEqual([]);
    expect((await goalModeRows(goalId)).map((row) => row.owner_id)).toEqual(['su-live-holder']);
    expect(await impliedRows('su-old-holder', goalId)).toEqual([]);
  }, 60_000);
});
