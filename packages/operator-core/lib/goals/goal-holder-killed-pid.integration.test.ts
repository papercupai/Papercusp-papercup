/**
 * goal-holder-killed-pid.integration.test — the END-TO-END guard for
 * EI-21572355077403526: a goal whose holder PROCESS was KILLED must become
 * relaunchable, and must stop reading as active.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────────
 *
 *   A goal whose holder process is gone becomes relaunchable (`startGoalById`
 *   no longer refuses `already-held`), AND stops reading as active — which IS
 *   the `onLoss: 'deactivate'` disposition, declared `derived-at-read` in
 *   recovery-dependency-audit's HOLDER_LOSS_DISPOSITIONS ("there is no executor
 *   to be fate-shared WITH — the absence of an actor is the property").
 *
 * Both halves fall out of ONE derivation, so this file drives that derivation
 * for real and asserts both ends of it.
 *
 * ── WHY THE EXISTING GUARDS DO NOT COVER THIS ────────────────────────────────
 *
 * The defect was a COMPOSITION across four modules that each behaved exactly as
 * their own tests expected: a stale `adv_sessions` row (ended_at never written)
 * → `sessionState 'recorded'` → `holderCountsAsAlive` true → a permanent
 * `already-held` refusal → `onLoss` never fires. Every part was individually
 * correct; only the join was wrong. Two existing suites come close and both
 * MISS it, for the same reason:
 *
 *  - `liveness-oracle-recorded-pid-death.test.ts` (the fix's own unit guard) is
 *    unit-level on both sides through injected seams — no PG, no real process.
 *    It pins the classifier; it cannot see the composition.
 *  - `system-health/goal-holder-respawn.integration.test.ts` proves kill →
 *    respawn end-to-end, but its `killedSignals()` sets `recordedEnded: true`
 *    and stubs `probePidFn: () => null`. That is the GRACEFUL death — the
 *    session wrote its cleanup marker on the way out. It never exercises the
 *    pid leg at all.
 *
 * ⚠ THE DISTINCTION THIS FILE EXISTS FOR, and the easiest thing to get wrong
 * when editing it: the defect lived in the gap between "the cleanup marker was
 * never written" and "the process is alive". `adv_sessions.ended_at` is written
 * by a session-end hook that SIGKILL bypasses, so for a KILLED session the row
 * is STALE, not live. A test that sets `ended_at` is testing the graceful path
 * and will pass against the un-fixed code. **`ended_at` must stay NULL here.**
 * That is the whole point; do not "fix" a future failure by ending the session.
 *
 * ── WHAT IS REAL HERE ────────────────────────────────────────────────────────
 *
 * Everything on the derivation path, against the migrated baseline DB via
 * `setupBaselineCoordFixture` (which re-points the coordination modules' OWN
 * `getOrgPg()` at it, so the default fetch seams read real rows):
 *
 *  - a REAL dead pid — a process is genuinely spawned and reaped, then probed by
 *    the REAL `probeProcessLiveness` (an actual `kill(pid, 0)` ESRCH). Nothing
 *    stubs the probe, and the first assertion of each case is a POSITIVE
 *    CONTROL on the instrument, so pid reuse fails loudly instead of silently
 *    passing the wrong thing;
 *  - the REAL presence row (`coord_presence`, carrying pid + host) hydrated by
 *    the REAL `getPresence`; the REAL `adv_sessions` read (`recordedLiveOwnerIds`);
 *  - the REAL oracle (`resolveSessionStates` → `deriveVerdict`) and the REAL
 *    fold (`resolveGoalHolders`) — `startGoalById`'s `resolveHolders` seam is
 *    deliberately NOT stubbed, because it is the subject;
 *  - the REAL `setMode` attach, and the REAL `resolveGoalEffectiveActivity`.
 *
 * `deps.launch` is stubbed — opening a real process is the launch door's
 * own tested seam (goal-holder-launch-action.test.ts), the same seam both
 * sibling integration suites stub. `readReadiness` is stubbed actionable: this
 * goal declares no blockers and the real edge read is pinned by goal-deps'
 * own tests + start-goal-by-id.test.ts.
 * The unrelated control-anchor publication uses its existing dependency seam:
 * this isolated fixture checks the attached identity and SQL handle without
 * invoking the workspace's external projection refresh.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import type postgres from 'postgres';

import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { startGoalById, type StartGoalByIdDeps } from './start-goal-by-id';
import { resolveGoalHolders } from './holder';
import { resolveGoalEffectiveActivity, GOAL_DORMANT_STATUS } from './activity';
import { probeProcessLiveness } from '../agent-tools/coordination/presence';
import { RECORDED_SESSION_SOURCE } from '../agent-tools/coordination/recorded-sessions';
import { buildGoalKickoffBrief } from '../agent-tools/goals/start';
import { resolveGoalLaunchForGoal } from '../goal-launch-settings';
import { GOAL_MODE } from '../modes/goal-session';
import { setMode } from '../modes/store';

const WS = 'ws-goal-killed-pid';
const HARNESS = 'papercusp-killed-pid';
const GOAL = 'goal-killed-holder';
const HOLDER = 'su-killed-holder';
const REPLACEMENT = 'su-replacement-holder';

/** This machine's hostname — `probeProcessLiveness` only probes rows that name it. */
const HOST = hostname();

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

/**
 * A pid that is DEFINITIVELY not running: spawn a trivial process synchronously
 * (so it has already exited and been reaped when this returns) and hand back its
 * pid. Deliberately a real corpse rather than a made-up number — a fabricated
 * "probably free" pid could collide with a live process and make the killed case
 * silently assert the LIVE path. Callers must still assert the probe reads it as
 * dead; see `expectProbeDead`.
 */
function reapedPid(): number {
  const res = spawnSync(process.execPath, ['-e', '']);
  if (typeof res.pid !== 'number' || res.pid <= 0) {
    throw new Error(`could not spawn a probe process to reap: ${res.error?.message ?? 'no pid'}`);
  }
  return res.pid;
}

/**
 * POSITIVE CONTROL on the instrument. Between the reap above and this probe the
 * kernel could in principle recycle the pid; if it did, the fixture no longer
 * expresses a killed holder and every assertion downstream would be measuring
 * the wrong thing. Fail here, loudly, rather than there, quietly.
 */
function expectProbeDead(pid: number): void {
  expect(
    probeProcessLiveness({ host: HOST, pid }),
    `pid ${pid} was expected to be confirmed-dead (ESRCH); if this fails the pid was ` +
      'recycled and the fixture is no longer a killed holder — re-run',
  ).toBe(false);
}

async function seedGoal(opts: { status?: string; launchSettings?: unknown } = {}): Promise<void> {
  // Keep this outcome goal eligible for the real operating-input gate. The
  // subject is holder loss/relaunch, so a missing kill criterion or ceiling
  // must not mask the liveness result before the launch seam is exercised.
  await admin`
    INSERT INTO harness_shared.goals
      (id, workspace_id, install_slug, title, status, kill_criterion, budget_cents, launch_settings)
    VALUES (${GOAL}, ${WS}, ${HARNESS}, ${'killed-holder goal'}, ${opts.status ?? 'active'},
            ${'The lost holder is replaced once and the original goal reads dormant.'}, ${1000},
            ${opts.launchSettings === undefined ? null : admin.json(opts.launchSettings as never)})`;
  // Operating inputs require a budget, while this suite tests holder liveness.
  // Give the launch gate an actual priced, goal-attributed measurement below
  // that ceiling instead of relying on admission of an empty ledger.
  const ts = Date.now();
  await admin`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source, ingested_at,
       harness_slug, goal_id, cost_usd)
    VALUES (${WS}, ${ts}, ${'test:goal-holder'}, ${'anthropic'}, ${'test'},
            ${'interactive'}, ${ts}, ${HARNESS}, ${GOAL}, ${0.01})`;
}

/**
 * The holder's presence row. `source` is deliberately NOT
 * `RECORDED_SESSION_SOURCE`: that value is an independent trigger for the
 * session-log rescue, and using it here would let the case pass without the
 * `adv_sessions` row being read at all — i.e. it would stop testing the path
 * the real defect took.
 */
async function seedPresence(
  ownerId: string,
  opts: { pid: number | null; host?: string; ageSeconds?: number },
): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence
      (owner_id, owner_label, workspace_id, source, heartbeat_at, host, pid, agent_role)
    VALUES (${ownerId}, ${ownerId}, ${WS}, ${'psu'},
            now() - ${`${opts.ageSeconds ?? 3600} seconds`}::interval,
            ${opts.host ?? HOST}, ${opts.pid}, ${'su'})`;
}

/**
 * The `adv_sessions` row. `ended: false` (the default) leaves `ended_at` NULL —
 * the KILLED signature: the session-end hook never ran. See the header's ⚠.
 */
async function seedAdvSession(ownerId: string, opts: { ended?: boolean } = {}): Promise<void> {
  await admin`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, coord_owner_id, first_seen_at, started_at, ended_at)
    VALUES (${WS}, ${'omp'}, ${ownerId}, now(), now(), ${opts.ended ? new Date() : null})`;
}

/** Attach a holder the way the start door does: the REAL setMode, subject = goal id. */
async function attachHolder(ownerId: string): Promise<void> {
  const res = await setMode({
    workspaceId: WS,
    ownerId,
    modeId: GOAL_MODE,
    enabled: true,
    reason: `test: holder for ${GOAL}`,
    setBy: ownerId,
    subject: GOAL,
    sql: admin,
  });
  expect(res.ok).toBe(true);
}

/** The REAL deps, with only the documented seams overridden (see the header). */
function startDeps(capture: { launched: string[] }): StartGoalByIdDeps {
  return {
    launch: async (input) => {
      capture.launched.push(input.goalId);
      return { ownerId: REPLACEMENT, warnings: [] };
    },
    // NOT stubbed — the real fold over the real oracle is the subject of this file.
    resolveHolders: resolveGoalHolders,
    resolveGoalLaunch: resolveGoalLaunchForGoal,
    buildBrief: buildGoalKickoffBrief,
    readReadiness: async () => ({ actionable: true, premiseInvalidated: false, blockers: [] }),
    attach: async ({ sql, workspaceId, goalId, ownerId, setBy, expectedLease }) => {
      const res = await setMode({
        workspaceId,
        ownerId,
        modeId: GOAL_MODE,
        enabled: true,
        reason: `test attach for ${goalId}`,
        setBy,
        subject: goalId,
        ...(expectedLease ? { goalElectionExpectation: expectedLease } : {}),
        sql: sql as postgres.Sql,
      });
      return {
        ok: res.ok,
        error: res.ok ? null : 'mode store refused',
        ...(res.goalElection ? { goalElection: res.goalElection } : {}),
      };
    },
    neutralize: async () => {},
    notifyHandoff: async () => {},
    refreshControlAnchor: async (input) => {
      expect(input.ownerId).toBe(REPLACEMENT);
      expect(input.workspaceId).toBe(WS);
      expect(input.sql).toBe(admin);
      return null;
    },
    stampAgentOwner: async (sql, { workspaceId, goalId, ownerId }) => {
      await sql`
        UPDATE harness_shared.goals
           SET metadata = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object('agentOwnerId', ${ownerId}::text)
         WHERE id = ${goalId} AND workspace_id = ${workspaceId}`;
    },
  };
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
}, 120_000);

afterAll(async () => {
  await admin`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS}`.catch(() => {});
  await admin`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS}`.catch(() => {});
  await fx?.dispose();
});

beforeEach(async () => {
  await admin`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
  await admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS}`;
});

describe('P-002: holder election and bounded handoff through real PG and liveness', () => {
  async function electSuccessor(): Promise<void> {
    await seedGoal();
    await attachHolder(HOLDER);
    const [first] = await admin<Array<{ goal_lease_epoch: string }>>`
      SELECT goal_lease_epoch FROM harness_shared.agent_modes
       WHERE workspace_id = ${WS} AND owner_id = ${HOLDER} AND mode = ${GOAL_MODE}`;
    const elected = await setMode({
      workspaceId: WS, ownerId: REPLACEMENT, modeId: GOAL_MODE, enabled: true,
      reason: 'test: elected successor', setBy: HOLDER, subject: GOAL,
      goalElectionExpectation: { ownerId: HOLDER, epoch: Number(first.goal_lease_epoch) },
      sql: admin,
    });
    expect(elected.ok).toBe(true);
  }

  it('elects one effective holder and reports loss even while the historical holder is live', async () => {
    await electSuccessor();
    await seedPresence(HOLDER, { pid: process.pid, ageSeconds: 0 });
    await seedAdvSession(HOLDER);
    const deadPid = reapedPid();
    expectProbeDead(deadPid);
    await seedPresence(REPLACEMENT, { pid: deadPid, ageSeconds: 0 });
    await seedAdvSession(REPLACEMENT);

    const holders = await resolveGoalHolders(admin, { workspaceId: WS, goalId: GOAL });
    expect(holders.elected?.ownerId).toBe(REPLACEMENT);
    expect(holders.allLive.map((holder) => holder.ownerId)).toEqual([HOLDER]);
    expect(holders.live).toEqual([]);
    expect(holders.liveness).toBe('lost');
  });

  it('permits only the named predecessor during the deadline, then rejects expiry and a third live row', async () => {
    await electSuccessor();
    for (const ownerId of [HOLDER, REPLACEMENT]) {
      await seedPresence(ownerId, { pid: process.pid, ageSeconds: 0 });
      await seedAdvSession(ownerId);
    }
    const read = () => resolveGoalHolders(admin, { workspaceId: WS, goalId: GOAL });
    const bounded = await read();
    expect(bounded.elected?.ownerId).toBe(REPLACEMENT);
    expect(bounded.live.map((holder) => holder.ownerId)).toEqual([REPLACEMENT]);
    expect(bounded.overlap.status).toBe('handoff');

    await admin`UPDATE harness_shared.agent_modes
                   SET goal_handoff_expires_at = now() - interval '1 second'
                 WHERE workspace_id = ${WS} AND owner_id = ${REPLACEMENT} AND mode = ${GOAL_MODE}`;
    expect((await read()).overlap.status).toBe('violation');

    await admin`UPDATE harness_shared.agent_modes
                   SET goal_handoff_expires_at = now() + interval '1 minute'
                 WHERE workspace_id = ${WS} AND owner_id = ${REPLACEMENT} AND mode = ${GOAL_MODE}`;
    await admin`INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, reason, set_by, owner_directed, set_at, subject, goal_lease_epoch)
      VALUES (${WS}, ${'su-third-holder'}, ${GOAL_MODE}, ${GOAL_MODE},
              ${'test: stale third holder'}, ${HOLDER}, false, now(), ${GOAL}, 0)`;
    await seedPresence('su-third-holder', { pid: process.pid, ageSeconds: 0 });
    await seedAdvSession('su-third-holder');
    const third = await read();
    expect(third.elected?.ownerId).toBe(REPLACEMENT);
    expect(third.overlap.status).toBe('violation');
  });
});

describe('a KILLED goal holder (pid gone, adv_sessions.ended_at never written)', () => {
  it('resolves as lost, relaunches, and stops reading as active — the full invariant', async () => {
    const pid = reapedPid();
    expectProbeDead(pid);

    await seedGoal();
    await attachHolder(HOLDER);
    await seedPresence(HOLDER, { pid });
    // ended_at stays NULL: the session was killed, so its cleanup hook never ran.
    await seedAdvSession(HOLDER);

    // ── the derivation, through the real chain ──────────────────────────────
    const holders = await resolveGoalHolders(admin, { workspaceId: WS, goalId: GOAL });
    expect(holders.holders.map((h) => h.ownerId)).toEqual([HOLDER]);
    // PRE-FIX this was 'recorded' (the stale adv_sessions row outranking the pid
    // probe), which `holderCountsAsAlive` counts as ALIVE.
    expect(holders.holders[0].sessionState).toBe('ended');
    expect(holders.holders[0].live).toBe(false);
    expect(holders.liveness).toBe('lost');

    // ── half 1: RELAUNCHABLE (pre-fix: a permanent `already-held` refusal) ──
    const capture = { launched: [] as string[] };
    const res = await startGoalById(
      admin,
      { workspaceId: WS, goalId: GOAL, launcherOwnerId: 'test-launcher' },
      startDeps(capture),
    );
    expect(res, `holder restart result: ${JSON.stringify(res)}`).toMatchObject({
      ok: true,
      goalId: GOAL,
      ownerId: REPLACEMENT,
    });
    expect(capture.launched).toEqual([GOAL]);

    // The replacement was really attached — durable state, not just a return value.
    const rows = await admin<{ owner_id: string }[]>`
      SELECT owner_id FROM harness_shared.agent_modes
       WHERE workspace_id = ${WS} AND mode = ${GOAL_MODE} AND subject = ${GOAL}`;
    expect(rows.map((r) => r.owner_id).sort()).toEqual([HOLDER, REPLACEMENT].sort());

    const [goal] = await admin<{ metadata: Record<string, unknown> | null }[]>`
      SELECT metadata FROM harness_shared.goals
       WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    expect(goal.metadata).toMatchObject({ agentOwnerId: REPLACEMENT });

    // ── half 2: the onLoss='deactivate' disposition, derived at read ────────
    const activity = resolveGoalEffectiveActivity({
      status: 'active',
      launchSettings: null, // the D-001 default: requireLive true, onLoss 'deactivate'
      liveness: holders.liveness,
    });
    expect(activity.requiresLiveHolder).toBe(true);
    expect(activity.deactivated).toBe(true);
    expect(activity.effectiveStatus).toBe(GOAL_DORMANT_STATUS);
  }, 60_000);

  it('a goal whose holder is genuinely RUNNING is still held and still refuses to double-spawn', async () => {
    // The over-correction guard: the fix must disqualify the session-log rescue
    // for a CONFIRMED-dead process only. `process.pid` is this very test runner,
    // so the probe returns a positive `true` rather than an ESRCH.
    expect(probeProcessLiveness({ host: HOST, pid: process.pid })).toBe(true);

    await seedGoal();
    await attachHolder(HOLDER);
    await seedPresence(HOLDER, { pid: process.pid });
    await seedAdvSession(HOLDER);

    const holders = await resolveGoalHolders(admin, { workspaceId: WS, goalId: GOAL });
    expect(holders.liveness).toBe('held');
    expect(holders.live.map((h) => h.ownerId)).toEqual([HOLDER]);

    const capture = { launched: [] as string[] };
    const res = await startGoalById(
      admin,
      { workspaceId: WS, goalId: GOAL, launcherOwnerId: 'test-launcher' },
      startDeps(capture),
    );
    expect(res).toMatchObject({ ok: false, reason: 'already-held' });
    expect(capture.launched).toEqual([]);

    // ...and it keeps reading as active: nothing was lost.
    expect(
      resolveGoalEffectiveActivity({ status: 'active', launchSettings: null, liveness: holders.liveness }).deactivated,
    ).toBe(false);
  }, 60_000);

  it('an UNPROBEABLE holder keeps the session-log rescue — the disqualifier is narrow', async () => {
    // The narrowness guard, and the one most at risk from a future "simplify the
    // pid check" edit. `probeProcessLiveness` returns `false` ONLY for an
    // affirmative ESRCH on a row naming THIS host. A row with no pid recorded is
    // ambiguous, not dead, and must keep the generosity the holder predicate
    // depends on — otherwise every declare-intent-only holder reads as abandoned.
    expect(probeProcessLiveness({ host: HOST, pid: null })).toBeNull();

    await seedGoal();
    await attachHolder(HOLDER);
    await seedPresence(HOLDER, { pid: null }); // stale heartbeat, no pid to probe
    await seedAdvSession(HOLDER);

    const holders = await resolveGoalHolders(admin, { workspaceId: WS, goalId: GOAL });
    expect(holders.holders[0].sessionState).toBe('recorded');
    expect(holders.liveness).toBe('held');

    const capture = { launched: [] as string[] };
    const res = await startGoalById(
      admin,
      { workspaceId: WS, goalId: GOAL, launcherOwnerId: 'test-launcher' },
      startDeps(capture),
    );
    expect(res).toMatchObject({ ok: false, reason: 'already-held' });
    expect(capture.launched).toEqual([]);
  }, 60_000);

  it('a remote-host holder is never probed by this box, dead pid or not', async () => {
    // The federation guard: a pid from another machine's namespace is meaningless
    // here, so a coincidental match must never read as liveness — nor as death.
    const pid = reapedPid();
    expectProbeDead(pid); // ...on THIS host
    expect(probeProcessLiveness({ host: `${HOST}-elsewhere`, pid })).toBeNull();

    await seedGoal();
    await attachHolder(HOLDER);
    await seedPresence(HOLDER, { pid, host: `${HOST}-elsewhere` });
    await seedAdvSession(HOLDER);

    const holders = await resolveGoalHolders(admin, { workspaceId: WS, goalId: GOAL });
    expect(holders.holders[0].sessionState).toBe('recorded');
    expect(holders.liveness).toBe('held');
  }, 60_000);

  it('the GRACEFUL death still resolves lost — this file does not regress the marked path', async () => {
    // The sibling suite's case, re-asserted through THIS chain so the two cannot
    // drift: when the cleanup marker WAS written, `ended_at` is positive death
    // evidence and the holder is lost with no pid probe needed at all.
    await seedGoal();
    await attachHolder(HOLDER);
    await seedPresence(HOLDER, { pid: null });
    await seedAdvSession(HOLDER, { ended: true });

    const holders = await resolveGoalHolders(admin, { workspaceId: WS, goalId: GOAL });
    expect(holders.holders[0].sessionState).toBe('ended');
    expect(holders.liveness).toBe('lost');
  }, 60_000);
});

describe('the fixture itself', () => {
  it('uses a non-session-log presence source, so the adv_sessions row is what rescues', () => {
    // Guards the seeding choice documented on `seedPresence`: if a future edit
    // sets `source` to RECORDED_SESSION_SOURCE, the rescue would fire from the
    // presence row alone and the killed-holder cases would stop exercising the
    // adv_sessions path the real defect took — while still passing.
    expect(RECORDED_SESSION_SOURCE).toBe('session-log');
    expect('psu').not.toBe(RECORDED_SESSION_SOURCE);
  });
});
