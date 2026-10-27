/**
 * reconcileLoopRoutines — the loop completion-rebase (B-LOOP-2 / P-002), proven against a
 * REAL migrated Postgres (testcontainer, so migration 323's reschedule_interval_sec +
 * target_owner_id columns are present).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/reconcile-loop-routines.integration.test.ts
 *
 * Plan: loop-routines-interval-recurrence-2026-06-20 (B-LOOP-2). Covers: re-arms N sec
 * after a turn settles (lifecycle signal); idempotent; never moves next_fire_at backwards
 * (a pre-fire turn is excluded); stays parked while in flight; the dropped-report presence
 * fallback; the cron+loop "take the sooner" fold; the stuck-park backstop.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { listDueCronRoutines } from '@papercusp/db-org';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { claimDueRoutine } from './claim';
import { getLoopStatus, materializeLoop } from './loop';
import { insertTurns } from '../../search/session-ingest';
import { createPgTelemetryStore } from '../../activity-pg-store';
import { recordLoopTurnStart } from './loop-turn-start-stamp';
import { ledgerPathForSid, readLedgerRows, tagTurnForInjection } from '../../turn-provenance/turn-provenance';
import { persistMonitorNoDeltaBudget } from './monitor-standdown';
import { reconcileLoopRoutines } from './reconcile-loop-routines';
import { activeWorkspaceId } from '../../workspace-registry';

const privateDb = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  // Legacy loop helpers also resolve alarm state through this seam. Keep those
  // calls inside this owned cluster; the rollback test detects a producer that
  // escapes its caller's transaction through this pool instead.
  getOrgPg: () => ({ sql: privateDb.sql }),
}));

let org: OrgTestDb;
let privatePg: DedicatedNativePg;
let provenanceDir: string;
const savedAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
const savedProvenanceDir = process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
/** HERMETIC wrapper — do NOT call reconcileLoopRoutines bare in this file. The DEFAULT
 *  recordFire/readFireState bind getOrgPg() — the LIVE dev database, not the testcontainer
 *  `sql` — so every historical full-file run silently wrote fire-state 'error' rows for
 *  ('papercup','rt-loop-9') into the DEV DB until the accumulated streak crossed the
 *  EI-7006 circuit threshold and the circuit-open fast path TERMINATED the backstop test's
 *  loop (a 12-runs-later time-bomb flake, 2026-07-03). The circuit feed itself is covered
 *  by the unit file with injected spies; here both seams are stubbed hermetic. */
const reconcile = (o: NonNullable<Parameters<typeof reconcileLoopRoutines>[0]>) =>
  reconcileLoopRoutines({ recordFire: async () => {}, readFireState: async () => null, ...o });

let sql: Sql;
const WS = 'ws-loop';
const HARNESS = 'papercup';
/** A fixed clock so every rebase computation is deterministic. */
const T0 = 1_780_000_000_000;
let rtSeq = 0;

beforeAll(async () => {
  privatePg = await startDedicatedNativePg();
  process.env.PAPERCUSP_TEST_PG_ADMIN_URL = privatePg.getConnectionUri();
  org = await createOrgTestDb();
  sql = org.adminSql;
  privateDb.sql = sql;
  provenanceDir = await mkdtemp(join(tmpdir(), 'indexed-loop-start-'));
  process.env.PAPERCUSP_TURN_PROVENANCE_DIR = provenanceDir;
}, 180_000);
afterAll(async () => {
  try { await org?.cleanup(); } finally {
    try { await privatePg?.stop(); } finally {
      if (provenanceDir) await rm(provenanceDir, { recursive: true, force: true });
      if (savedAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = savedAdminUrl;
      if (savedProvenanceDir === undefined) delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
      else process.env.PAPERCUSP_TURN_PROVENANCE_DIR = savedProvenanceDir;
    }
  }
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.autoloop_state WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.agent_activity WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.session_turn_journal WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${WS}`;
});

describe('indexed native producer integration', () => {
  async function nativeCase(source = 'codex', wakeCount = 10) {
    const now = Date.now(), owner = `su-indexed-${++rtSeq}`;
    const loop = await seedLoop({ ownerId: owner, intervalSec: 60, lastFiredAtMs: now - 4000, parked: true });
    await sql`UPDATE harness_shared.routines SET metadata =
      ${JSON.stringify({ fire_count: 10, armed_at: new Date(now - 6000).toISOString() })}::jsonb WHERE id = ${loop.id}`;
    const tagged = await tagTurnForInjection({ sid: owner, origin: 'loop-fire', text: 'A native loop turn.',
      dir: provenanceDir, nowMs: now - 3000, loopFire: { routineId: loop.id, wakeCount } });
    expect(tagged.ledgerWritten).toBe(true);
    const user = { workspace_id: 'default', source_kind: source, session_id: `native-${owner}`, turn_idx: 0,
      ts: new Date(now - 2000).toISOString(), owner, harness_slug: null, cwd: null, speaker: 'user', text: tagged.taggedText };
    // The indexed producer now requires the exact launch-selected namespace.
    const workspace = activeWorkspaceId();
    await sql`INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, omp_thread_id, launch_spec)
      VALUES (${workspace}, ${source}, 'omp', ${owner},
              ${source === 'omp' ? null : user.session_id}, ${source === 'omp' ? user.session_id : null},
              ${JSON.stringify({ workspaceId: workspace, turnProvenanceDir: provenanceDir })}::text::jsonb)`;
    const reply = { ...user, turn_idx: 1, ts: new Date(now - 1000).toISOString(), speaker: 'assistant', text: 'Finished this exact fire.' };
    const awaits = await sql<Array<{ id: number }>>`INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
      VALUES (${WS}, ${owner}, ${'test:' + loop.id}) RETURNING id`;
    const delivered = new Date(now - 3500);
    await sql`INSERT INTO harness_shared.event_wake_deliveries
      (workspace_id, await_id, subscriber_id, event_key, source, status, channel, created_at, delivered_at, turn_proof, turn_started_at)
      VALUES (${WS}, ${awaits[0]!.id}, ${owner}, ${'test:' + loop.id}, ${'loop:' + loop.id},
              'delivered', 'inbox', ${delivered}, ${delivered}, 'observed', ${delivered})`;
    return { now, owner, loop, user, reply };
  }

  async function assertReaders(c: Awaited<ReturnType<typeof nativeCase>>, recognized: boolean) {
    expect((await getLoopStatus(c.owner, { sql }))!.lastLoopTurnAt).toBe(recognized ? c.reply.ts : null);
    const result = await reconcile({ sql, nowMs: c.now + 10_000, countAgentToolCallsInWindow: async () => null });
    const own = result.loops.find(loop => loop.id === c.loop.id);
    if (recognized) expect(own).toMatchObject({ via: 'loop-turn', completedAt: Date.parse(c.reply.ts) });
    else expect(own).toBeUndefined();
  }

  it.each(['claude', 'codex', 'omp'])('persists newly inserted %s rows with full attribution and real write time, once', async source => {
    const c = await nativeCase(source);
    expect(await insertTurns(sql, [c.user, c.reply])).toBe(2);
    const stamps = await sql<Array<{ created_at: Date; workspace_id: string; owner_id: string; session_id: string; detail: any }>>`
      SELECT created_at, workspace_id, owner_id, session_id, detail FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ workspace_id: 'default', owner_id: c.owner, session_id: c.user.session_id,
      detail: { source: 'session-ingest', loopFire: { routineId: c.loop.id, wakeCount: 10 },
        indexedTurn: { workspaceId: 'default', sourceKind: source, sessionId: c.user.session_id, turnIdx: 0 } } });
    expect(new Date(stamps[0]!.created_at).getTime()).toBeGreaterThan(Date.parse(c.user.ts));
    expect(await insertTurns(sql, [c.user, c.reply])).toBe(0);
    expect(await sql`SELECT id FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`).toHaveLength(1);
    await assertReaders(c, true);
  });

  it('uses the caller connection: native and activity rows roll back together', async () => {
    const c = await nativeCase();
    await expect(sql.begin(async tx => {
      await insertTurns(tx as unknown as Sql, [c.user, c.reply]);
      expect(await tx`SELECT id FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`).toHaveLength(1);
      throw new Error('rollback both writes');
    })).rejects.toThrow('rollback both writes');
    expect(await sql`SELECT turn_idx FROM harness_shared.session_turns WHERE owner = ${c.owner}`).toHaveLength(0);
    expect(await sql`SELECT id FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`).toHaveLength(0);
  });

  it('rolls back a failed activity write so the same native rows can retry successfully', async () => {
    const c = await nativeCase();
    await sql.unsafe(`CREATE FUNCTION harness_shared.reject_indexed_start() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'private activity failure'; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_indexed_start BEFORE INSERT ON harness_shared.agent_activity
      FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_indexed_start()`);
    try {
      await expect(insertTurns(sql, [c.user, c.reply])).rejects.toThrow('private activity failure');
    } finally {
      await sql.unsafe('DROP TRIGGER reject_indexed_start ON harness_shared.agent_activity');
      await sql.unsafe('DROP FUNCTION harness_shared.reject_indexed_start()');
    }
    expect(await sql`SELECT turn_idx FROM harness_shared.session_turns WHERE owner = ${c.owner}`).toHaveLength(0);
    expect(await insertTurns(sql, [c.user, c.reply])).toBe(2);
    expect(await sql`SELECT id FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`).toHaveLength(1);
    await assertReaders(c, true);
  });

  it('admits original enrollment after delayed ingest and payload mangling', async () => {
    const c = await nativeCase(), original = Date.now() - 20 * 60_000;
    const ledger = readLedgerRows(c.owner, { includeExpired: true })[0]!;
    await writeFile(ledgerPathForSid(c.owner), JSON.stringify({ ...ledger, ts: original - 1000 }) + '\n');
    c.user.ts = new Date(original).toISOString(); c.reply.ts = new Date(original + 1000).toISOString();
    c.user.text += '\nPTY transit changed this payload.';
    await sql`UPDATE harness_shared.routines SET last_fired_at = ${new Date(original - 3000)},
      metadata = ${JSON.stringify({ fire_count: 10, armed_at: new Date(original - 4000).toISOString() })}::jsonb WHERE id = ${c.loop.id}`;
    await sql`UPDATE harness_shared.event_wake_deliveries SET created_at = ${new Date(original - 2000)},
      delivered_at = ${new Date(original - 2000)} WHERE subscriber_id = ${c.owner}`;
    await insertTurns(sql, [c.user, c.reply]); await assertReaders(c, true);
  });

  it.each(['missing', 'foreign-owner', 'foreign-origin', 'wrong-nonce', 'future', 'expired', 'malformed', 'assistant', 'non-native', 'non-loop'])(
    'keeps %s enrollment unknown through normal ingest', async control => {
      const c = await nativeCase(), ledger = readLedgerRows(c.owner, { includeExpired: true })[0]!;
      const change: Record<string, unknown> = {};
      if (control === 'missing') await rm(ledgerPathForSid(c.owner));
      if (control === 'foreign-owner') change.sid = 'foreign';
      if (control === 'foreign-origin') change.origin = 'wake-pump';
      if (control === 'future') change.ts = Date.parse(c.user.ts) + 1;
      if (control === 'expired') change.ts = Date.parse(c.user.ts) - 600_001;
      if (control === 'malformed') change.loopFire = { routineId: '', wakeCount: 10 };
      if (Object.keys(change).length) await writeFile(ledgerPathForSid(c.owner), JSON.stringify({ ...ledger, ...change }) + '\n');
      if (control === 'wrong-nonce') c.user.text = c.user.text.replace(ledger.nonce, 'aaaaaaaaaaaaaaaa');
      if (control === 'assistant') c.user.speaker = 'assistant';
      if (control === 'non-native') c.user.source_kind = c.reply.source_kind = 'agent_chat';
      if (control === 'non-loop') c.user.text = c.user.text.replace('turn-origin:loop-fire', 'turn-origin:wake-pump');
      await insertTurns(sql, [c.user, c.reply]);
      expect(await sql`SELECT id FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`).toHaveLength(0);
      await assertReaders(c, false);
    },
  );

  it('does not recover pre-existing/conflicted rows', async () => {
    const c = await nativeCase();
    await sql`INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, turn_origin)
      VALUES (${c.user.workspace_id}, ${c.user.source_kind}, ${c.user.session_id}, 0, ${c.user.ts}, ${c.owner}, 'user', ${c.user.text}, 'loop-fire')`;
    expect(await insertTurns(sql, [c.user, c.reply])).toBe(1);
    expect(await sql`SELECT id FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`).toHaveLength(0);
    await assertReaders(c, false);
  });

  describe('indexed native producer completion', () => {
    it.each(['workspace', 'activity-workspace', 'source', 'session', 'turn-index', 'routine', 'stale9'])(
      'rejects wrong %s in both actual SQL readers', async control => {
        const c = await nativeCase('codex', control === 'stale9' ? 9 : 10);
        await insertTurns(sql, [c.user, c.reply]);
        const paths: Record<string, [string[], string]> = {
          workspace: [['indexedTurn', 'workspaceId'], 'foreign-workspace'], source: [['indexedTurn', 'sourceKind'], 'claude'],
          session: [['indexedTurn', 'sessionId'], 'foreign-session'], 'turn-index': [['indexedTurn', 'turnIdx'], '1'],
          routine: [['loopFire', 'routineId'], 'foreign-routine'],
        };
        if (control === 'activity-workspace') {
          await sql`UPDATE harness_shared.agent_activity SET workspace_id = 'foreign-workspace' WHERE owner_id = ${c.owner}`;
        } else if (control !== 'stale9') {
          const [path, value] = paths[control]!;
          await sql`UPDATE harness_shared.agent_activity SET detail = jsonb_set(detail, ${sql.array(path)}::text[], ${JSON.stringify(value)}::text::jsonb)
            WHERE owner_id = ${c.owner}`;
        }
        await assertReaders(c, false);
      },
    );

    it('preserves the original hook-before-user path', async () => {
      const c = await nativeCase();
      // nativeCase persists the launch in the active namespace; WS is only the
      // separate routine fixture namespace and cannot select that launch ledger.
      expect(await recordLoopTurnStart({ owner: c.owner, workspaceId: activeWorkspaceId(), prompt: c.user.text }, createPgTelemetryStore(sql))).toBe(true);
      const stamp = await sql<Array<{ created_at: Date; detail: { loopFire?: unknown } }>>`SELECT created_at, detail FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`;
      expect(stamp[0]!.detail.loopFire).toEqual({ routineId: c.loop.id, wakeCount: 10 });
      c.user.ts = new Date(new Date(stamp[0]!.created_at).getTime() + 1).toISOString();
      c.reply.ts = new Date(Date.parse(c.user.ts) + 1).toISOString();
      await insertTurns(sql, [c.user, c.reply]);
      await sql`DELETE FROM harness_shared.agent_activity WHERE owner_id = ${c.owner} AND detail->>'source' = 'session-ingest'`;
      await assertReaders(c, true);
    });

    it('keeps a hook outside its persisted launch workspace unknown', async () => {
      const c = await nativeCase();
      expect(await recordLoopTurnStart({ owner: c.owner, workspaceId: WS, prompt: c.user.text }, createPgTelemetryStore(sql))).toBe(true);
      const stamp = await sql<Array<{ created_at: Date; detail: { loopFire?: unknown } }>>`SELECT created_at, detail FROM harness_shared.agent_activity WHERE owner_id = ${c.owner}`;
      expect(stamp[0]!.detail).not.toHaveProperty('loopFire');
      c.user.ts = new Date(new Date(stamp[0]!.created_at).getTime() + 1).toISOString();
      c.reply.ts = new Date(Date.parse(c.user.ts) + 1).toISOString();
      await insertTurns(sql, [c.user, c.reply]);
      await sql`DELETE FROM harness_shared.agent_activity WHERE owner_id = ${c.owner} AND detail->>'source' = 'session-ingest'`;
      await assertReaders(c, false);
    });
  });
});

/**
 * Seed a loop routine. `parked` → next_fire_at='infinity' (a pure loop mid-turn);
 * otherwise `nextFireAtMs` is the armed time (a cron+loop's cron-next). `cron` makes it a
 * cron+loop. Returns the routine id + the target owner id.
 */
async function seedLoop(opts: {
  ownerId: string;
  intervalSec: number;
  lastFiredAtMs: number;
  parked?: boolean;
  nextFireAtMs?: number;
  cron?: string;
}): Promise<{ id: string; ownerId: string }> {
  const id = `rt-loop-${++rtSeq}`;
  const triggerConfig = opts.cron ? { cron: opts.cron } : {};
  const nextFire = opts.parked
    ? sql`'infinity'::timestamptz`
    : sql`${new Date(opts.nextFireAtMs ?? opts.lastFiredAtMs)}`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       active, workspace_id, last_fired_at, next_fire_at,
       reschedule_interval_sec, target_owner_id)
    VALUES (
      ${id}, ${HARNESS}, ${id}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb, 'su',
      TRUE, ${WS}, ${new Date(opts.lastFiredAtMs)}, ${nextFire},
      ${opts.intervalSec}, ${opts.ownerId}
    )`;
  return { id, ownerId: opts.ownerId };
}

/** Seed a turn-lifecycle marker (the cc/ Stop+SessionEnd hook's agent_activity row). */
async function seedLifecycle(ownerId: string, summary: string, atMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_activity
      (workspace_id, owner_id, kind, summary, created_at)
    VALUES (${WS}, ${ownerId}, 'lifecycle', ${summary}, ${new Date(atMs)})`;
}

/** Seed a per-turn Stop-hook journal write (session_turn_journal, P-012, WI-6069) — the
 *  signal that actually fires at the end of EVERY ordinary turn (unlike the lifecycle
 *  'ended' marker, which only fires at a genuine session restart). session_id must be
 *  unique per row (part of the UNIQUE index with turn_ts) — rtSeq keeps it distinct. */
async function seedTurnJournal(ownerId: string, atMs: number): Promise<void> {
  const sessionId = 'sess-' + ++rtSeq;
  await sql`
    INSERT INTO harness_shared.session_turn_journal
      (workspace_id, owner_id, session_id, turn_ts, note, source, created_at)
    VALUES (${WS}, ${ownerId}, ${sessionId}, ${new Date(atMs)}, 'test turn', 'mechanical', ${new Date(atMs)})`;
}

/** Seed/refresh the session's genuine-activity timestamp (presence-v2 last_active_at).
 *  WI-5964: coord_presence_pkey is PRIMARY KEY(owner_id) ONLY — globally unique,
 *  not scoped by workspace_id — so a bare INSERT can collide with a same-named
 *  literal owner_id seeded by another concurrent *.integration.test.ts process on
 *  this shared fixture. Upsert so this test's own values always win. */
async function seedPresence(ownerId: string, lastActiveMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, last_active_at)
    VALUES (${ownerId}, ${WS}, ${new Date(lastActiveMs)})
    ON CONFLICT (owner_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      last_active_at = EXCLUDED.last_active_at`;
}

/** Prove the claimed routine entered fireLoopWake. The production writer stamps this
 *  before calling the wake ledger; a newer clock rules out the claim→dispatch gap while
 *  still allowing this fixture to exercise the later stuck-turn backstop. */
async function seedFireDispatch(routineName: string, atMs: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.autoloop_state
      (workspace_id, harness_slug, role, last_fired_at, last_status, consecutive_errors)
    VALUES (${WS}, ${HARNESS}, ${routineName}, ${new Date(atMs)}, 'queued', 0)
    ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE SET
      last_fired_at = EXCLUDED.last_fired_at,
      last_status = EXCLUDED.last_status,
      consecutive_errors = EXCLUDED.consecutive_errors`;
}

/** Read a routine's parked-ness + next_fire_at. Parked-ness is a SQL boolean because
 *  postgres-js parses 'infinity'::timestamptz to an INVALID JS Date. */
async function readFire(id: string): Promise<{ parked: boolean; nextFireMs: number | null }> {
  const r = await sql<{ parked: boolean; next_fire_at: Date | null }[]>`
    SELECT (next_fire_at = 'infinity'::timestamptz) AS parked, next_fire_at
      FROM harness_shared.routines WHERE id = ${id}`;
  const row = r[0];
  return {
    parked: row.parked,
    nextFireMs: row.parked || !row.next_fire_at ? null : row.next_fire_at.getTime(),
  };
}

describe('persistMonitorNoDeltaBudget — overlapping same-fire settlement (real PG)', () => {
  it('does not let a stale concurrent pass overwrite the first settlement', async () => {
    const ownerId = `su-monitor-budget-race-${++rtSeq}`;
    const fireToken = String(T0);
    const routine = await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId,
      intervalSec: 60,
      kickoff: 'same-fire monitor budget race',
      mode: 'monitor',
      monitor: {
        predicateKey: 'fleet:budget-race',
        stopCondition: 'the same fire settles once',
        noDeltaBudget: 3,
        remainingNoDeltaBudget: 3,
        authority: { kind: 'fleet-leader', fleet: 'budget-race' },
      },
      now: new Date(T0),
      sql,
    });
    const winner = await sql.reserve();
    const stalePass = await sql.reserve();
    let winnerTransactionOpen = false;
    let staleWrite: Promise<boolean> | undefined;

    try {
      await winner`BEGIN`;
      winnerTransactionOpen = true;
      const winnerBackend = await winner<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      expect(await persistMonitorNoDeltaBudget(winner, routine.id, 2, fireToken)).toBe(true);

      // Keep the winning update uncommitted so the stale pass is demonstrably in flight
      // against the same row and fire token, rather than merely running after it.
      const staleBackend = await stalePass<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      staleWrite = persistMonitorNoDeltaBudget(stalePass, routine.id, 1, fireToken);
      const deadline = Date.now() + 2_000;
      let blockedByWinner = false;
      while (Date.now() < deadline) {
        const waits = await winner<Array<{ blocked: boolean }>>`
          SELECT ${winnerBackend[0]!.pid} = ANY(pg_blocking_pids(${staleBackend[0]!.pid})) AS blocked`;
        if (waits[0]?.blocked) {
          blockedByWinner = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedByWinner).toBe(true);

      await winner`COMMIT`;
      winnerTransactionOpen = false;
      expect(await staleWrite).toBe(true);

      const persisted = await winner<Array<{ remaining_budget: number; settled_fire: string | null }>>`
        SELECT (payload_template #>> '{monitor,remainingNoDeltaBudget}')::int AS remaining_budget,
               metadata->>'monitor_budget_fire_at' AS settled_fire
          FROM harness_shared.routines
         WHERE id = ${routine.id}`;
      expect(persisted).toEqual([{ remaining_budget: 2, settled_fire: fireToken }]);
    } finally {
      if (winnerTransactionOpen) await winner`ROLLBACK`.catch(() => {});
      if (staleWrite) await staleWrite.catch(() => {});
      stalePass.release();
      winner.release();
    }
  });
});

describe('reconcileLoopRoutines — pure loop completion-rebase', () => {
  it('re-arms a parked loop N sec after the turn settles (lifecycle signal)', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-1', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedLifecycle(ownerId, '■ session ended', T0 + 5_000); // turn ended 5s after the fire
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id, via: 'lifecycle' });
    const fire = await readFire(id);
    expect(fire.parked).toBe(false);
    expect(fire.nextFireMs).toBe(T0 + 5_000 + 60_000); // completed_at + interval
  });

  it("re-arms via the per-turn journal signal when NO lifecycle marker exists (WI-6069 — the case a session driven entirely by push wakes never produces)", async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-1b', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // No seedLifecycle call at all — mirrors a warm session whose Stop hook never wires the
    // lifecycle 'ended' marker (only SessionStart/SessionEnd do). The Stop hook's OTHER
    // per-turn write (session_turn_journal, P-012) is what must settle this loop instead.
    await seedTurnJournal(ownerId, T0 + 5_000);
    const res = await reconcile({ sql, nowMs: T0 + 6_000 }); // only 1s of quiet — presence-quiescence could not have fired
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id, via: 'turn-journal' });
    const fire = await readFire(id);
    expect(fire.parked).toBe(false);
    expect(fire.nextFireMs).toBe(T0 + 5_000 + 60_000); // completed_at + interval
  });

  it('is idempotent — a second pass does not move an already-rebased loop', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-2', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedLifecycle(ownerId, '■ session ended', T0 + 5_000);
    await reconcile({ sql, nowMs: T0 + 10_000 });
    const first = await readFire(id);
    const res2 = await reconcile({ sql, nowMs: T0 + 20_000 });
    expect(res2.rearmed).toBe(0);
    expect((await readFire(id)).nextFireMs).toBe(first.nextFireMs);
  });

  it('NEVER rebases off a pre-fire turn (never backwards) — stays parked', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-3', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // A turn that ended BEFORE this fire must not re-arm the loop.
    await seedLifecycle(ownerId, '■ session ended', T0 - 10_000);
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });

  it('leaves a loop parked while its turn is still in flight (no settle, recent activity)', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-4', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // No lifecycle 'ended'; activity is RECENT (within the fallback quiet window) → mid-turn.
    await seedPresence(ownerId, T0 + 9_000);
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });

  it('takes the MOST-RECENT settled turn when several ended after the fire', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-5', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedLifecycle(ownerId, '■ session ended', T0 + 3_000);
    await seedLifecycle(ownerId, '■ session ended', T0 + 8_000); // most recent
    await reconcile({ sql, nowMs: T0 + 12_000 });
    expect((await readFire(id)).nextFireMs).toBe(T0 + 8_000 + 60_000);
  });

  it('ignores the "▶ session started" lifecycle marker (only end settles)', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-6', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedLifecycle(ownerId, '▶ session started', T0 + 2_000); // the wake start, NOT a settle
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });
});

describe('reconcileLoopRoutines — robustness layers', () => {
  it('FALLBACK: recovers a dropped lifecycle report via presence quiescence', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-7', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // No lifecycle 'ended' (the detached report was lost), but the session did work after
    // the fire and has since been quiet ≥ 60s.
    await seedPresence(ownerId, T0 + 4_000);
    const res = await reconcile({ sql, nowMs: T0 + 70_000 }); // 66s quiet since last_active
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
    // The activity-relative candidate is already expired, so reconciliation leaves a full
    // interval from this pass instead of persisting another immediately-due timestamp.
    expect((await readFire(id)).nextFireMs).toBe(T0 + 70_000 + 60_000);
  });

  it('FALLBACK does NOT fire while the session is still recently active', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-8', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    await seedPresence(ownerId, T0 + 50_000);
    const res = await reconcile({ sql, nowMs: T0 + 80_000 }); // only 30s quiet (<60s)
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });

  it('CLAIM-DISPATCH GAP: re-arms when the parked claim advances but no fire or wake writer does', async () => {
    const interval = 60;
    const { id } = await seedLoop({
      ownerId: 'o-dispatch-gap',
      intervalSec: interval,
      lastFiredAtMs: T0,
      parked: true,
    });

    const res = await reconcile({ sql, nowMs: T0 + 2 * interval * 1_000 });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id, via: 'claim-dispatch-gap' });
    // The claim-relative retry is stale at this pass; keep the new fire in the future.
    expect((await readFire(id)).nextFireMs).toBe(T0 + 3 * interval * 1_000);
  });

  it('BACKSTOP: re-arms a loop parked long past the fire with no signal at all', async () => {
    // The backstop logs a warning (intended visibility for a wedged loop) — mock + assert it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const interval = 60;
    // No lifecycle, no presence — a dead/undelivered fire.
    const { id } = await seedLoop({ ownerId: 'o-9', intervalSec: interval, lastFiredAtMs: T0, parked: true });
    await seedFireDispatch(id, T0 + 1); // dispatched, then produced no completion signal
    const longAfter = T0 + 31 * 60_000; // > the 30m default stuck-park floor
    const res = await reconcile({ sql, nowMs: longAfter });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('stuck-backstop');
    // The last-fired-relative retry is long past; re-arm one full interval from this pass.
    expect((await readFire(id)).nextFireMs).toBe(longAfter + interval * 1_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-armed to retry'));
    warn.mockRestore();
  });

  it('BACKSTOP does NOT fire for a legitimately long turn (recent activity present)', async () => {
    const { id, ownerId } = await seedLoop({ ownerId: 'o-10', intervalSec: 60, lastFiredAtMs: T0, parked: true });
    // A long turn that is STILL working: activity well after the fire, recent vs now.
    await seedPresence(ownerId, T0 + 31 * 60_000);
    const res = await reconcile({ sql, nowMs: T0 + 31 * 60_000 + 1_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).parked).toBe(true);
  });
});

describe('reconcileLoopRoutines — ARMED-loop reachability sweep (EI-11407)', () => {
  it('an ARMED pure loop (settled once, no in-flight turn) past the terminal window with an unreachable owner is auto-paused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { id, ownerId } = await seedLoop({
      ownerId: 'o-armed-dead', intervalSec: 60, lastFiredAtMs: T0, parked: false, nextFireAtMs: T0 + 3_660_000,
    });
    const cancelInboxWake = vi.fn(async () => 0);
    const escalateDeadLoop = vi.fn(async () => {});
    const checkUnreachableTerminalGuard = vi.fn(async () => ({
      breach: true,
      reason: 'dead-owner: unreachable (EI-11407 armed sweep)',
    }));
    const res = await reconcile({
      sql,
      nowMs: T0 + 2 * 3_600_000 + 1_000, // past the 2h terminal window (60s interval floors there)
      checkUnreachableTerminalGuard,
      cancelInboxWake,
      escalateDeadLoop,
    });
    expect(res.terminated).toEqual([
      { id, targetOwnerId: ownerId, reason: 'dead-owner: unreachable (EI-11407 armed sweep)' },
    ]);
    expect(res.rearmed).toBe(0);
    expect(cancelInboxWake).toHaveBeenCalledWith(ownerId, WS);
    expect(escalateDeadLoop).toHaveBeenCalledWith(expect.objectContaining({ routineId: id, targetOwnerId: ownerId }));
    // The reconcile itself never re-arms next_fire_at on breach (the guard's own autoPause —
    // exercised for real in loop-unreachable-guard.test.ts — owns deactivating the row).
    const fire = await readFire(id);
    expect(fire.nextFireMs).toBe(T0 + 3_660_000); // untouched by THIS sweep
    warn.mockRestore();
  });

  it('an ARMED pure loop still within the terminal window is left untouched — guard never consulted', async () => {
    const { id } = await seedLoop({
      ownerId: 'o-armed-fresh', intervalSec: 60, lastFiredAtMs: T0, parked: false, nextFireAtMs: T0 + 3_660_000,
    });
    const checkUnreachableTerminalGuard = vi.fn(async () => ({ breach: true, reason: 'should-not-fire' }));
    const res = await reconcile({ sql, nowMs: T0 + 3_600_000, checkUnreachableTerminalGuard }); // 1h < 2h window
    expect(checkUnreachableTerminalGuard).not.toHaveBeenCalled();
    expect(res.terminated).toEqual([]);
    const fire = await readFire(id);
    expect(fire.nextFireMs).toBe(T0 + 3_660_000); // untouched
  });
});

describe('reconcileLoopRoutines — cron+loop composition (take the sooner)', () => {
  it('lowers a cron+loop next_fire_at to completed+interval when the loop fires sooner', async () => {
    const cronNext = T0 + 3_600_000; // cron-next an hour out
    const { id, ownerId } = await seedLoop({
      ownerId: 'o-11', intervalSec: 60, lastFiredAtMs: T0, parked: false, nextFireAtMs: cronNext, cron: '0 * * * *',
    });
    await seedLifecycle(ownerId, '■ session ended', T0 + 5_000);
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect((await readFire(id)).nextFireMs).toBe(T0 + 5_000 + 60_000); // the sooner loop re-arm
  });

  it('leaves a cron+loop alone when the cron fires sooner than the loop re-arm', async () => {
    const cronNext = T0 + 30_000; // cron in 30s — sooner than completed(5s)+interval(60s)=65s
    const { id, ownerId } = await seedLoop({
      ownerId: 'o-12', intervalSec: 60, lastFiredAtMs: T0, parked: false, nextFireAtMs: cronNext, cron: '* * * * *',
    });
    await seedLifecycle(ownerId, '■ session ended', T0 + 5_000);
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect((await readFire(id)).nextFireMs).toBe(cronNext); // cron-next preserved
  });
});

describe('cold first-fire settlement — materialize → reconcile → claim (EI-20988940040434762)', () => {
  it('does not stage the first wake before the arm note, then re-arms and claims it after settlement', async () => {
    const ownerId = `su-cold-first-${++rtSeq}`;
    const armAtMs = T0 + 1_000;
    const intervalSec = 60;
    const intervalMs = intervalSec * 1_000;
    const noteAtMs = armAtMs + 5_000; // the arm turn settles after its nominal first-fire window

    const routine = await materializeLoop({
      workspaceId: WS,
      harnessSlug: HARNESS,
      ownerId,
      intervalSec,
      kickoff: 'cold first-fire integration',
      carry: 'cold',
      now: new Date(armAtMs),
      sql,
    });

    const initial = (
      await sql<
        Array<{
          parked: boolean;
          last_fired_at: Date | null;
          payload_template: Record<string, unknown> | null;
          armed_at: string | null;
        }>
      >`
        SELECT (next_fire_at = 'infinity'::timestamptz) AS parked,
               last_fired_at,
               payload_template,
               metadata->>'armed_at' AS armed_at
          FROM harness_shared.routines
         WHERE id = ${routine.id}
      `
    )[0];
    expect(initial).toMatchObject({
      parked: true,
      last_fired_at: null,
      payload_template: { carry: 'cold' },
      armed_at: new Date(armAtMs).toISOString(),
    });
    expect((await listDueCronRoutines(sql)).some((row) => row.id === routine.id)).toBe(false);

    await sql`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, updated_ts)
      VALUES (${WS}, ${`loop:${HARNESS}:${ownerId}`}, 'arm turn settled', ${noteAtMs})
    `;

    const reconciled = await reconcile({ sql, nowMs: noteAtMs + 10_000 });
    expect(reconciled.rearmed).toBe(1);
    expect(reconciled.loops[0]).toMatchObject({
      id: routine.id,
      completedAt: noteAtMs,
      nextFireAt: noteAtMs + intervalMs,
      via: 'initial-cold-note-refresh',
    });

    const rearmed = (
      await sql<Array<{ parked: boolean; next_fire_at: Date | null }>>`
        SELECT (next_fire_at = 'infinity'::timestamptz) AS parked, next_fire_at
          FROM harness_shared.routines
         WHERE id = ${routine.id}
      `
    )[0];
    expect(rearmed.parked).toBe(false);
    expect(rearmed.next_fire_at?.getTime()).toBe(noteAtMs + intervalMs);

    // Use a JS Date here so the claim CAS sees the same millisecond precision as the
    // due-list read; this test is about the cold handoff, not PostgreSQL microseconds.
    const dueAt = new Date(noteAtMs + intervalMs - 1_000);
    await sql`UPDATE harness_shared.routines SET next_fire_at = ${dueAt} WHERE id = ${routine.id}`;
    const due = (await listDueCronRoutines(sql)).find((row) => row.id === routine.id);
    expect(due).toBeDefined();
    expect(await claimDueRoutine(sql, due!)).toBe(true);

    const claimed = (
      await sql<Array<{ parked: boolean; last_fired_at: Date | null }>>`
        SELECT (next_fire_at = 'infinity'::timestamptz) AS parked, last_fired_at
          FROM harness_shared.routines
         WHERE id = ${routine.id}
      `
    )[0];
    expect(claimed.parked).toBe(true);
    expect(claimed.last_fired_at).not.toBeNull();
  });
});
