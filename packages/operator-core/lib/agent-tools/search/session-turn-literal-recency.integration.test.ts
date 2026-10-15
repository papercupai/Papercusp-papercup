/**
 * Real-Postgres coverage for the recency-walk fallback of the exact tier (plan
 * session-transcript-exact-fuzzy-search-2026-09-14, WI-10005294 / D-015, inside the R-1 bar).
 *
 * WHY THIS FILE EXISTS: a near-ubiquitous literal ('the', 'papercusp') matches most turns, so the trigram
 * route cannot finish inside the exact deadline and USED TO return `status=deadline` with ZERO hits even
 * though thousands of matches exist. The fix: on a trigram deadline, spend the rest of the budget walking
 * `session_turns` newest-first in time slices (cost tracks turns walked, not the literal's posting list); a
 * filled/exhausted walk is a COMPLETE answer, a timed-out walk is a bounded PARTIAL carrying an honest marker.
 *
 * DETERMINISM: the trigram route is forced to time out by holding ACCESS EXCLUSIVE on session_turns from a
 * reserved connection while the first `sql.begin` runs (its statement_timeout then expires on the lock wait),
 * and releasing it before the walk. No wall-clock race on a "slow enough" corpus. The only timing assumption is
 * that the timeout budgets are small and the unlocked walk is fast on a few hundred rows.
 *
 * Kept in its own file: editing the sibling integration files would re-fingerprint their evidence bindings.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { applyDisclosureLedgerForTest, applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { readSessionSearchReadiness, runSessionSearchIndexBuildOnce } from '../../session-search-index-build';
import {
  SESSION_TURN_LITERAL_POLICY,
  recencySlices,
  retrieveSessionTurnExact,
  retrieveSessionTurnLiteralTiers,
  runRecencyWalk,
  type SessionTurnLiteralHit,
  type SessionTurnLiteralPolicy,
} from './session-turn-literal';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../../../libs/papercusp/libs/db/sql');
const WS = 'w-recency';
const MIN = 60_000;

let db: FreshPgDb;
let sql: postgres.Sql;

async function seed(
  sid: string,
  idx: number,
  text: string,
  tsMs: number,
  extra: { ws?: string; speaker?: string } = {},
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts, ingested_at)
    VALUES (${extra.ws ?? WS}, 'claude', ${sid}, ${idx}, ${extra.speaker ?? 'user'}, ${text},
            ${new Date(tsMs).toISOString()}::timestamptz, now())`;
}

/** Hold ACCESS EXCLUSIVE on session_turns from a reserved connection; returns the release. */
async function holdTableLock(): Promise<() => Promise<void>> {
  const r = await sql.reserve();
  await r.unsafe('BEGIN');
  await r.unsafe('LOCK TABLE harness_shared.session_turns IN ACCESS EXCLUSIVE MODE');
  return async () => {
    await r.unsafe('ROLLBACK');
    r.release();
  };
}

/**
 * Wrap `sql` so the Nth `sql.begin` call runs while the table lock is held (its statement_timeout expires on the
 * lock wait) and the lock is released as soon as that call returns. Every other call passes straight through.
 */
function lockOnNthBegin(n: number): { sql: postgres.Sql; calls: () => number } {
  let calls = 0;
  const wrapped = new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop !== 'begin') return Reflect.get(target, prop, receiver);
      return async (...args: unknown[]) => {
        calls++;
        const begin = (target.begin as (...a: unknown[]) => Promise<unknown>).bind(target);
        if (calls !== n) return begin(...args);
        const release = await holdTableLock();
        try {
          return await begin(...args);
        } finally {
          await release();
        }
      };
    },
  });
  return { sql: wrapped as postgres.Sql, calls: () => calls };
}

const keys = (hits: readonly SessionTurnLiteralHit[]): string[] => hits.map((h) => `${h.sessionId}:${h.turnIdx}`);
/** `ts::text` renders as `2026-10-02 05:00:00.123+00` — normalise to ISO before Date.parse. */
const tsMs = (t: string): number => Date.parse(t.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
const tsDesc = (tss: readonly (string | null)[]): boolean =>
  tss.length > 0 && tss.every((t, i) => Number.isFinite(tsMs(t!)) && (i === 0 || tsMs(t!) <= tsMs(tss[i - 1]!)));

beforeAll(async () => {
  db = await createFreshPgDb('sess-turn-literal-recency');
  sql = db.sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`);
  await applyMigrationForTest(sql, path.join(SQL_DIR, '501-session-turns.sql'));
  await applyMigrationForTest(sql, path.join(SQL_DIR, '794-session-turns-provenance-at-ingest.sql'));
  await applyMigrationForTest(sql, path.join(SQL_DIR, '1273-session-turns-trigram-exact-fuzzy-index.sql'));
  await applyDisclosureLedgerForTest(sql); // D-006 reader rule (WI-10005570)
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql.unsafe(`TRUNCATE harness_shared.session_turns`);
});

describe('runRecencyWalk — newest-first, verified per turn', () => {
  const NEEDLE = 'recwalk-token';
  let base = 0;

  beforeEach(async () => {
    base = Date.now();
    // idx 0..39, 3 minutes apart, newest first. Even idx carry the literal (mixed case on purpose).
    for (let i = 0; i < 40; i++) {
      await seed('w', i, i % 2 === 0 ? `Message ${i} mentions RecWalk-Token here` : `Message ${i} is unrelated filler`, base - i * 3 * MIN);
    }
    // Same literal but another workspace, and an older assistant turn in this one.
    await seed('other', 0, 'RecWalk-Token in someone else’s workspace', base, { ws: 'w-elsewhere' });
    await seed('a', 100, 'assistant mentions RecWalk-Token too', base - 200 * MIN, { speaker: 'assistant' });
  });

  const walk = (limit: number, budgetMs: number, q: { filters?: { speaker?: string } } = {}, slices?: ReturnType<typeof recencySlices>) =>
    runRecencyWalk(sql, { workspaceId: WS, query: NEEDLE, ...q }, NEEDLE, limit, budgetMs, SESSION_TURN_LITERAL_POLICY, slices);

  it('fills `limit` with the NEWEST matches, in ts-descending order', async () => {
    const out = await walk(5, 5000);
    expect(out.status).toBe('filled');
    expect(out.rows.map((r) => `${r.session_id}:${r.turn_idx}`)).toEqual(['w:0', 'w:2', 'w:4', 'w:6', 'w:8']);
    const brute = await sql<Array<{ session_id: string; turn_idx: number }>>`
      SELECT session_id, turn_idx FROM harness_shared.session_turns
       WHERE workspace_id = ${WS} AND position(${NEEDLE} in lower(text)) > 0 ORDER BY ts DESC LIMIT 5`;
    expect(out.rows.map((r) => `${r.session_id}:${r.turn_idx}`)).toEqual(brute.map((r) => `${r.session_id}:${r.turn_idx}`));
  });

  it('is case-insensitive, workspace-scoped, and exhausts when fewer than `limit` matches exist', async () => {
    const out = await walk(100, 5000);
    expect(out.status).toBe('exhausted');
    expect(out.completeSinceMs).toBeNull();
    // 20 user matches + 1 older assistant match; the other workspace's turn is excluded.
    expect(out.rows).toHaveLength(21);
    expect(out.rows.some((r) => r.session_id === 'other')).toBe(false);
    expect(tsDesc(out.rows.map((r) => r.ts))).toBe(true);
    expect(out.rows[0]!.snippet).toContain('RecWalk-Token');
  });

  it('applies the shared scope predicate (speaker filter)', async () => {
    const out = await walk(100, 5000, { filters: { speaker: 'user' } });
    expect(out.rows).toHaveLength(20);
    expect(out.rows.every((r) => r.speaker === 'user')).toBe(true);
  });

  it('a zero budget is a deterministic timeout with nothing walked', async () => {
    const out = await walk(10, 0);
    expect(out).toEqual({ rows: [], status: 'timeout', completeSinceMs: null });
  });

  it('a timeout MID-walk is a partial whose completeSince covers exactly what was returned', async () => {
    const slices = recencySlices(base, SESSION_TURN_LITERAL_POLICY.recencyFirstSliceMs, SESSION_TURN_LITERAL_POLICY.recencySliceGrowth);
    // The 2nd begin is the 2nd slice: it blocks on the table lock until its statement_timeout.
    const { sql: locked } = lockOnNthBegin(2);
    const out = await runRecencyWalk(
      locked, { workspaceId: WS, query: NEEDLE }, NEEDLE, 10, 600, SESSION_TURN_LITERAL_POLICY, slices,
    );
    expect(out.status).toBe('timeout');
    // Slice 1 [base-20min, ∞) holds idx 0..6 → matches 0,2,4,6; it completed, slice 2 did not.
    expect(out.rows.map((r) => r.turn_idx)).toEqual([0, 2, 4, 6]);
    expect(out.completeSinceMs).toBe(slices[0]!.loMs);
    // The completeness claim, checked against the table: every match at or after completeSince was returned.
    const [{ n }] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM harness_shared.session_turns
       WHERE workspace_id = ${WS} AND position(${NEEDLE} in lower(text)) > 0
         AND ts >= ${new Date(out.completeSinceMs!).toISOString()}::timestamptz`;
    expect(Number(n)).toBe(out.rows.length);
  }, 30_000);
});

describe('retrieveSessionTurnExact — never answers a trigram deadline with nothing when matches exist', () => {
  const LITERAL = 'quick';
  const LIMIT = SESSION_TURN_LITERAL_POLICY.exactReserve + SESSION_TURN_LITERAL_POLICY.fuzzyReserve;
  // Trigram route gets 15% of 2000ms = 300ms (spent blocked on the lock); the walk gets the rest.
  const FORCED: SessionTurnLiteralPolicy = { ...SESSION_TURN_LITERAL_POLICY, exactDeadlineMs: 2000, recencyTrigramShare: 0.15 };

  beforeEach(async () => {
    const base = Date.now();
    // 300 turns that ALL contain the literal (the near-ubiquitous case), newest = idx 1.
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts, ingested_at)
      SELECT ${WS}, 'claude', 'r', g, 'user', 'common filler turn ' || g || ' the quick brown fox',
             ${new Date(base).toISOString()}::timestamptz - g * interval '1 minute', now()
        FROM generate_series(1, 300) AS g`;
  });

  it('forced trigram deadline → the walk returns the newest `limit` matches, COMPLETE (no deadline, no partial)', async () => {
    const { sql: locked, calls } = lockOnNthBegin(1);
    const out = await retrieveSessionTurnExact(locked, { workspaceId: WS, query: LITERAL }, FORCED, 'legacy');
    expect(calls()).toBeGreaterThanOrEqual(2); // 1 = the blocked trigram branch, then ≥1 walk slice
    expect(out.deadline).toBe(false);
    expect(out.partial).toBeUndefined();
    expect(out.hits).toHaveLength(LIMIT);
    expect(keys(out.hits)).toEqual(Array.from({ length: LIMIT }, (_, i) => `r:${i + 1}`));
    expect(tsDesc(out.hits.map((h) => h.ts))).toBe(true);
  }, 30_000);

  it('the same forced deadline with NO budget left for a walk stays an honest deadline + partial marker', async () => {
    const { sql: locked } = lockOnNthBegin(1);
    // share 1 → the trigram route is allowed the WHOLE budget, so nothing is left for the walk.
    const out = await retrieveSessionTurnExact(
      locked, { workspaceId: WS, query: LITERAL }, { ...SESSION_TURN_LITERAL_POLICY, exactDeadlineMs: 300, recencyTrigramShare: 1 }, 'legacy',
    );
    expect(out.deadline).toBe(true);
    expect(out.hits).toEqual([]);
    expect(out.partial).toEqual({ completeSince: null });
  }, 30_000);

  it('an unforced run is unchanged: trigram answers, no partial marker', async () => {
    const out = await retrieveSessionTurnExact(sql, { workspaceId: WS, query: LITERAL }, SESSION_TURN_LITERAL_POLICY, 'legacy');
    expect(out.deadline).toBe(false);
    expect(out.partial).toBeUndefined();
    expect(out.hits).toHaveLength(LIMIT);
  });

  it('the tier receipt carries status=deadline + partial=true (no completeSince when no slice completed)', async () => {
    const built = await runSessionSearchIndexBuildOnce(sql, { minFreeDiskBytes: 0 });
    expect([...built.indexes, ...built.vocab].filter((e) => e.action === 'failed')).toEqual([]);
    const readiness = await readSessionSearchReadiness(sql, [WS, 'default']);
    // 'fox' is below the fuzzy token minimum, so only the exact tier runs and only it contends for the lock.
    const policy = { ...SESSION_TURN_LITERAL_POLICY, exactDeadlineMs: 300 };
    const release = await holdTableLock();
    let out;
    try {
      out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'fox' }, { policy, readiness });
    } finally {
      await release();
    }
    expect(out.receipt.exact.status).toBe('deadline');
    expect(out.receipt.exact.partial).toBe(true);
    expect(out.receipt.exact.completeSince).toBeUndefined();
    expect(out.receipt.exact.returned).toBe(0);
    expect(out.receipt.fuzzy.status).toBe('skipped');

    const ok = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'fox' }, { readiness });
    expect(ok.receipt.exact.status).toBe('ran');
    expect(ok.receipt.exact.partial).toBeUndefined();
    expect(ok.exact.length).toBeGreaterThan(0);
  }, 60_000);
});
