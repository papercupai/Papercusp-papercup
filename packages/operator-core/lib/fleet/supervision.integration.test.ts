/**
 * supervision.integration.test.ts — the spawn tree as a supervision tree (P1, D-002).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Drives the REAL supervision engine
 * against real Postgres: the restart-intensity governor (> MaxR in MaxT ⇒ escalate),
 * the three OTP restart strategies, and the crash-loop → tear-down + escalate decision.
 * The escalation + lock-release effects are injected as spies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { recordSpawn, finishSpawn, getSpawn } from './spawn-tree';
import { admitSpawn } from './operator-spawn';
import {
  recordRestartIntensity,
  restartSet,
  superviseCrash,
  DEFAULT_MAX_RESTARTS,
} from './supervision';
import type { LockTarget, LockReleaseResult } from './lock-release';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY, workspace_id text NOT NULL, harness_slug text NOT NULL,
    parent_spawn_id text, parent_role text, child_role text NOT NULL,
    feature_id text, chunk_id text, run_id text NOT NULL,
    status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz, duration_ms bigint, exit_code int, output_tail text, error_message text,
    cancel_requested boolean NOT NULL DEFAULT false, session_owner text,
    coordination_domain text NOT NULL DEFAULT 'default', plan_slug text, item_id text,
    model_spec text, model_tier text, brief text,
    restart_strategy text NOT NULL DEFAULT 'one_for_one', restart_count int NOT NULL DEFAULT 0,
    restart_window_start timestamptz, cancel_reason text, cancelled_at timestamptz,
    pid int, launcher_host text, launcher_boot_id text, heartbeat_at timestamptz NOT NULL DEFAULT now(), last_output_at timestamptz)`;
const PLAN_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.plan_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL, item_id text NOT NULL,
    owner text NOT NULL, expires_ts timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id))`;

const WS = 'default';
const ACTOR: AgentIdentity = { ownerId: 'curator', ownerLabel: 'curator', source: 'principal', workspaceId: WS, userId: null };

let db: FreshPgDb;
let escalations: { severity: string; summary: string }[] = [];
let lockCalls: LockTarget[][] = [];
let relaunchCalls: string[] = [];
const spyEscalate = async (input: { severity: 'blocker'; summary: string }) => {
  escalations.push(input);
  return { msg_id: 'esc-' + escalations.length };
};
const spyReleaser = async (targets: LockTarget[]): Promise<LockReleaseResult> => {
  lockCalls.push(targets);
  return { owners: targets.map((t) => t.owner), filePathsReleased: targets.length, resourcesReleased: 0 };
};
const spyNotifier = async () => {};
// Declines every relaunch (records the attempt) — the DEFAULT relaunch effect goes
// through the real spawn chokepoint (getOrgPg + spawnAgentInHarness), which has no
// place in a hermetic real-PG-but-fake-everything-else test; every test that expects
// a 'restart' action injects this (or a bespoke spy) via `relaunch`.
const spyDeclineRelaunch = async (spawnId: string) => {
  relaunchCalls.push(spawnId);
  return { spawnId, ok: false, newSpawnId: null, error: 'no relaunch capability in this test' };
};

async function spawn(spawnId: string, opts: { parent?: string | null; strategy?: string; owner?: string } = {}) {
  await recordSpawn(db.sql, {
    spawnId, workspaceId: WS, harnessSlug: 'papercup', runId: 'r-' + spawnId, childRole: 'worker',
    parentSpawnId: opts.parent ?? null, sessionOwner: opts.owner ?? spawnId,
    restartStrategy: (opts.strategy as 'one_for_one' | 'one_for_all' | 'rest_for_one') ?? 'one_for_one',
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('supervision');
  await db.sql.unsafe(SPAWNED_AGENTS_DDL);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(PLAN_ITEM_CLAIMS_DDL);
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  escalations = []; lockCalls = []; relaunchCalls = [];
  await db.sql`TRUNCATE harness_shared.spawned_agents, harness_shared.work_items, harness_shared.plan_item_claims `;
});

describe('supervision — restart-intensity governor (D-002, real PG)', () => {
  it('counts restarts in a sliding window and trips when count exceeds MaxR', async () => {
    await spawn('w');
    const results = [];
    for (let i = 0; i < DEFAULT_MAX_RESTARTS + 1; i++) {
      results.push(await recordRestartIntensity(db.sql, { workspaceId: WS, spawnId: 'w' }));
    }
    // counts climb 1..MaxR (not exceeded), then MaxR+1 (exceeded).
    expect(results.map((r) => r!.count)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r!.intensityExceeded)).toEqual([false, false, false, true]);
    expect(results[0]!.windowReset).toBe(true);
    expect(results[1]!.windowReset).toBe(false);
  });

  it('resets the window once it has lapsed (windowSec elapsed)', async () => {
    await spawn('w');
    const r1 = await recordRestartIntensity(db.sql, { workspaceId: WS, spawnId: 'w', windowSec: 600 });
    expect(r1!.count).toBe(1);
    // Force the window to look lapsed by backdating its start.
    await db.sql`UPDATE harness_shared.spawned_agents SET restart_window_start = now() - interval '700 seconds' WHERE spawn_id='w'`;
    const r2 = await recordRestartIntensity(db.sql, { workspaceId: WS, spawnId: 'w', windowSec: 600 });
    expect(r2!.windowReset).toBe(true);
    expect(r2!.count).toBe(1); // fresh window
  });

  it('returns null for an unknown spawn', async () => {
    expect(await recordRestartIntensity(db.sql, { workspaceId: WS, spawnId: 'ghost' })).toBeNull();
  });
});

describe('supervision — restart strategies (D-002, real PG)', () => {
  it('one_for_one restarts only the crashed node', async () => {
    await spawn('parent', { strategy: 'one_for_one' });
    await spawn('a', { parent: 'parent', strategy: 'one_for_one' });
    await spawn('b', { parent: 'parent', strategy: 'one_for_one' });
    const rs = await restartSet(db.sql, { workspaceId: WS, crashedSpawnId: 'a' });
    expect(rs.toRestart).toEqual(['a']);
  });

  it('one_for_all restarts the crashed node + all active siblings', async () => {
    await spawn('parent');
    await spawn('a', { parent: 'parent', strategy: 'one_for_all' });
    await spawn('b', { parent: 'parent', strategy: 'one_for_all' });
    await spawn('c', { parent: 'parent', strategy: 'one_for_all' });
    await finishSpawn(db.sql, { spawnId: 'c', workspaceId: WS, status: 'done' }); // terminal sibling excluded
    const rs = await restartSet(db.sql, { workspaceId: WS, crashedSpawnId: 'a' });
    expect(rs.toRestart.sort()).toEqual(['a', 'b']);
  });

  it('rest_for_one restarts the crashed node + siblings started after it', async () => {
    await spawn('parent');
    // created in order a, b, c → started_at order a<b<c (tie-broken by spawn_id).
    await spawn('a', { parent: 'parent', strategy: 'rest_for_one' });
    await spawn('b', { parent: 'parent', strategy: 'rest_for_one' });
    await spawn('c', { parent: 'parent', strategy: 'rest_for_one' });
    const rs = await restartSet(db.sql, { workspaceId: WS, crashedSpawnId: 'b' });
    expect(rs.toRestart).toEqual(['b', 'c']); // a (earlier) untouched
  });
});

describe('supervision — superviseCrash decision (D-002, real PG)', () => {
  it('within budget → marks the restart set as restarting, then tries to relaunch each', async () => {
    await spawn('parent');
    await spawn('a', { parent: 'parent', strategy: 'rest_for_one' });
    await spawn('b', { parent: 'parent', strategy: 'rest_for_one' });
    await finishSpawn(db.sql, { spawnId: 'a', workspaceId: WS, status: 'failed', exitCode: 1 });

    const res = await superviseCrash(db.sql, {
      workspaceId: WS, spawnId: 'a', actor: ACTOR, reason: 'exit 1',
      escalate: spyEscalate, lockReleaser: spyReleaser, notifier: spyNotifier,
      relaunch: spyDeclineRelaunch,
    });
    expect(res.action).toBe('restart');
    expect(res.toRestart.sort()).toEqual(['a', 'b']);
    // WI-5541: the engine's restart decision now ALWAYS drives a real relaunch attempt
    // for every id it marks 'restarting' — never just a status flip left for someone
    // else to notice.
    expect(relaunchCalls.sort()).toEqual(['a', 'b']);
    expect(res.relaunches.map((r) => r.spawnId).sort()).toEqual(['a', 'b']);
    expect(res.relaunches.every((r) => r.ok === false)).toBe(true);
    // A declined/failed relaunch leaves the row 'restarting' (never silently
    // dropped) — the next reclaim sweep / a manual retry is the backstop.
    expect((await getSpawn(db.sql, WS, 'a'))?.status).toBe('restarting');
    expect((await getSpawn(db.sql, WS, 'b'))?.status).toBe('restarting');
    expect(escalations).toHaveLength(0);
  });

  it('a successful relaunch retires the superseded row to \'reaped\' (frees the ceiling debit)', async () => {
    await spawn('parent');
    await spawn('a', { parent: 'parent', strategy: 'one_for_one' });
    const invalidReplacement = await admitSpawn(db.sql, {
      workspaceId: WS,
      spawnId: 'a-invalid-replacement',
      idempotencyKey: null,
      replacesSpawnId: 'a',
      cap: 2,
      record: (tx) => recordSpawn(tx, {
        spawnId: 'a-invalid-replacement',
        workspaceId: WS,
        harnessSlug: 'papercup',
        parentSpawnId: 'parent',
        runId: 'r-a-invalid-replacement',
        childRole: 'worker',
      }),
    });
    // The parent plus child already fill the cap. A running row is not a
    // replacement credit, even when a caller supplies its id.
    expect(invalidReplacement.admission).toEqual({ kind: 'over_cap', running: 2, cap: 2 });
    await finishSpawn(db.sql, { spawnId: 'a', workspaceId: WS, status: 'failed', exitCode: 1 });

    const res = await superviseCrash(db.sql, {
      workspaceId: WS, spawnId: 'a', actor: ACTOR, reason: 'exit 1',
      escalate: spyEscalate, lockReleaser: spyReleaser, notifier: spyNotifier,
      relaunch: async (spawnId) => {
        relaunchCalls.push(spawnId);
        const newSpawnId = 'a-replacement';
        const replacement = await admitSpawn(db.sql, {
          workspaceId: WS,
          spawnId: newSpawnId,
          idempotencyKey: null,
          replacesSpawnId: spawnId,
          cap: 2,
          record: (tx) => recordSpawn(tx, {
            spawnId: newSpawnId,
            workspaceId: WS,
            harnessSlug: 'papercup',
            parentSpawnId: 'parent',
            runId: 'r-' + newSpawnId,
            childRole: 'worker',
          }),
        });
        expect(replacement.admission).toEqual({ kind: 'admitted' });
        return { spawnId, ok: true, newSpawnId };
      },
    });

    expect(res.action).toBe('restart');
    expect(res.relaunches).toEqual([{ spawnId: 'a', ok: true, newSpawnId: 'a-replacement' }]);
    const row = await getSpawn(db.sql, WS, 'a');
    expect(row?.status).toBe('reaped');
    expect((await getSpawn(db.sql, WS, 'a-replacement'))?.status).toBe('running');
    const [raw] = await db.sql<{ error_message: string | null }[]>`
      SELECT error_message FROM harness_shared.spawned_agents WHERE workspace_id=${WS} AND spawn_id='a'`;
    expect(raw.error_message).toMatch(/superseded by supervised restart/);
  });

  it('the crash-loop escalate path never invokes relaunch', async () => {
    await spawn('lone', { owner: 'own-lone' });
    await db.sql`UPDATE harness_shared.spawned_agents SET restart_count=${DEFAULT_MAX_RESTARTS}, restart_window_start=now() WHERE spawn_id='lone'`;

    const res = await superviseCrash(db.sql, {
      workspaceId: WS, spawnId: 'lone', actor: ACTOR, reason: 'exit 1',
      escalate: spyEscalate, lockReleaser: spyReleaser, notifier: spyNotifier,
      relaunch: spyDeclineRelaunch,
    });

    expect(res.action).toBe('escalate');
    expect(res.relaunches).toEqual([]);
    expect(relaunchCalls).toEqual([]);
  });

  it('crash-loop (over budget) → tears the subtree down + escalates to a human', async () => {
    await spawn('root', { owner: 'own-root' });
    await spawn('child', { parent: 'root', owner: 'own-child' });
    // Drive it to the brink: MaxR restarts already in the window.
    await db.sql`UPDATE harness_shared.spawned_agents SET restart_count=${DEFAULT_MAX_RESTARTS}, restart_window_start=now() WHERE spawn_id='root'`;

    const res = await superviseCrash(db.sql, {
      workspaceId: WS, spawnId: 'root', actor: ACTOR, reason: 'exit 1',
      escalate: spyEscalate, lockReleaser: spyReleaser, notifier: spyNotifier,
    });

    expect(res.action).toBe('escalate');
    expect(res.intensity?.intensityExceeded).toBe(true);
    expect(res.escalationId).toBe('esc-1');
    // Escalation raised to the human, severity blocker.
    expect(escalations).toEqual([expect.objectContaining({ severity: 'blocker' })]);
    // Subtree torn down: child cancelled, locks released for both owners; root marked failed.
    expect((await getSpawn(db.sql, WS, 'child'))?.status).toBe('cancelled');
    expect((await getSpawn(db.sql, WS, 'root'))?.status).toBe('failed');
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].map((t) => t.owner).sort()).toEqual(['own-child', 'own-root']);
  });

  it('no-actor escalate path returns the noop escalation without throwing (Gap 11)', async () => {
    // buildSupervisor's escalate defaults to a NOOP (`{ msg_id: 'noop' }`) when there
    // is no actor and no override — the read-only entry points (recordRestartIntensity
    // / restartSet) reach it. Drive a crash-loop with NO actor + NO escalate override
    // (lockReleaser injected only so the teardown does not hit real lock tables): the
    // escalate branch must still tear the subtree down and return cleanly, not throw on
    // a missing escalation effect.
    await spawn('lone', { owner: 'own-lone' });
    await db.sql`UPDATE harness_shared.spawned_agents SET restart_count=${DEFAULT_MAX_RESTARTS}, restart_window_start=now() WHERE spawn_id='lone'`;

    const res = await superviseCrash(db.sql, {
      // actor is required by the type, but the no-actor noop default is the path under test.
      workspaceId: WS, spawnId: 'lone', actor: undefined as unknown as AgentIdentity,
      reason: 'exit 1', lockReleaser: spyReleaser,
    });

    expect(res.action).toBe('escalate');
    expect(res.escalationId).toBe('noop'); // the no-actor default escalate effect
    expect((await getSpawn(db.sql, WS, 'lone'))?.status).toBe('failed');
    // No human escalation spy fired (we used the real noop, not spyEscalate).
    expect(escalations).toHaveLength(0);
  });
});
