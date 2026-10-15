/**
 * Real-Postgres coverage for plan session-transcript-exact-fuzzy-search-2026-09-14 P-011
 * (migration 1334 — session_turn_windows). SPEC-P011-MIGRATION-REPLAY-SAFE + the window-cut
 * correctness property that makes the windows route RECALL-COMPLETE for literals <= 65 chars.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  SESSION_TURN_WINDOW_LEN,
  SESSION_TURN_WINDOW_OVERLAP,
  SESSION_TURN_WINDOW_STRIDE,
} from './session-search-index-build';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../libs/papercusp/libs/db/sql');
const M501 = path.join(SQL_DIR, '501-session-turns.sql');
const M1334_ARMED = path.join(SQL_DIR, '1334-session-turn-windows.sql');
// scripts/mutation-probe.sh points this at a mutated COPY (copy-out mode); the .DRAFT fallback lets
// the migration be validated BEFORE it is armed (an armed file is auto-applied by every boot).
const M1334 =
  process.env.P011_MIGRATION_SQL_UNDER_TEST ??
  (existsSync(M1334_ARMED) ? M1334_ARMED : `${M1334_ARMED}.DRAFT`);

const WINDOWS_IDX = 'session_turn_windows_wtext_trgm_idx';

let db: FreshPgDb;
let sql: postgres.Sql;

async function seedTurn(ws: string, session: string, idx: number, text: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts, ingested_at)
    VALUES (${ws}, 'claude', ${session}, ${idx}, 'user', ${text}, now(), now())`;
}

async function windowsOf(text: string): Promise<Array<{ win_idx: number; wtext: string }>> {
  return sql<Array<{ win_idx: number; wtext: string }>>`
    SELECT win_idx, wtext FROM harness_shared.session_turn_windows_of(${text}) ORDER BY win_idx`;
}

async function indexValid(name: string): Promise<boolean | null> {
  const [r] = await sql<Array<{ valid: boolean }>>`
    SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = ${name}`;
  return r ? r.valid : null;
}

beforeAll(async () => {
  db = await createFreshPgDb('sess-windows');
  sql = db.sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`);
  await applyMigrationForTest(sql, M501);
  // Migration 1117's column only: its backfill joins session_turn_chunks, which this fixture lacks.
  await sql.unsafe(`ALTER TABLE harness_shared.session_turns ADD COLUMN IF NOT EXISTS chunked_at timestamptz`);
  await applyMigrationForTest(sql, M1334);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql.unsafe(`TRUNCATE harness_shared.session_turns CASCADE`);
});

describe('migration 1334 — replay safety', () => {
  it('is idempotent: applying it repeatedly leaves one trigger, one index, one state row', async () => {
    await applyMigrationForTest(sql, M1334);
    await applyMigrationForTest(sql, M1334);
    const [{ trg }] = await sql<Array<{ trg: number }>>`
      SELECT count(*)::int AS trg FROM pg_trigger
       WHERE tgname = 'session_turn_windows_sync_trg' AND NOT tgisinternal`;
    expect(trg).toBe(1);
    expect(await indexValid(WINDOWS_IDX)).toBe(true);
    const states = await sql`SELECT scope, status FROM harness_shared.session_turn_windows_state`;
    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe('ready');
  });

  it('replaying over a populated table backfills inline (small table) without duplicating windows', async () => {
    await seedTurn('w1', 's1', 0, 'x'.repeat(2000));
    const [{ before }] = await sql<Array<{ before: number }>>`
      SELECT count(*)::int AS before FROM harness_shared.session_turn_windows`;
    await sql.unsafe('TRUNCATE harness_shared.session_turn_windows');
    await applyMigrationForTest(sql, M1334);
    await applyMigrationForTest(sql, M1334);
    const [{ after }] = await sql<Array<{ after: number }>>`
      SELECT count(*)::int AS after FROM harness_shared.session_turn_windows`;
    expect(after).toBe(before);
    expect(after).toBeGreaterThan(1);
  });

  it('the TS window constants equal the SQL function the migration defines', async () => {
    expect([SESSION_TURN_WINDOW_LEN, SESSION_TURN_WINDOW_STRIDE, SESSION_TURN_WINDOW_OVERLAP]).toEqual([
      512, 448, 64,
    ]);
    const ws = await windowsOf('a'.repeat(1000));
    expect(ws[0]!.wtext).toHaveLength(SESSION_TURN_WINDOW_LEN);
    expect(ws.map((w) => w.win_idx)).toEqual([0, 1, 2]);
    expect(ws[2]!.wtext).toHaveLength(1000 - 2 * SESSION_TURN_WINDOW_STRIDE);
  });
});

describe('session_turn_windows_of — window cut properties', () => {
  it('an empty turn still gets exactly ONE window (so "turn has no window" terminates a backfill)', async () => {
    const ws = await windowsOf('');
    expect(ws).toEqual([{ win_idx: 0, wtext: '' }]);
  });

  it('windows hold lower(text), and a short turn is one whole window', async () => {
    const ws = await windowsOf('Hello ÉCOLE World');
    expect(ws).toEqual([{ win_idx: 0, wtext: 'hello école world' }]);
  });

  it('COVERAGE: every substring of <= 65 chars lies wholly inside at least one window (recall-complete)', async () => {
    const alphabet = ['a', 'b', 'c', 'É', ' ', '%', '_'];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const lengths = [0, 1, 2, 63, 64, 65, 66, 447, 448, 449, 511, 512, 513, 559, 560, 561, 961, 1500];
    for (const n of lengths) {
      const raw = Array.from({ length: n }, () => alphabet[rnd() % alphabet.length]!).join('');
      const [{ lowered }] = await sql<Array<{ lowered: string }>>`SELECT lower(${raw}::text) AS lowered`;
      const chars = Array.from(lowered);
      const wins = (await windowsOf(raw)).map((w) => w.wtext);
      for (let p = 0; p < chars.length; p++) {
        for (const len of [1, 2, 3, 33, 64, 65]) {
          if (p + len > chars.length) continue;
          const sub = chars.slice(p, p + len).join('');
          expect(
            wins.some((w) => w.includes(sub)),
            `turn length ${n}: substring at ${p}+${len} must be inside a window`,
          ).toBe(true);
        }
      }
    }
  });
});

describe('session_turn_windows_sync_trg — maintenance', () => {
  const count = async (session: string) => {
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.session_turn_windows WHERE session_id = ${session}`;
    return n;
  };

  it('INSERT writes the windows, UPDATE OF text rewrites them, DELETE cascades them away', async () => {
    await seedTurn('w1', 'sx', 0, 'z'.repeat(1000));
    expect(await count('sx')).toBe(3);
    await sql`UPDATE harness_shared.session_turns SET text = ${'q'.repeat(100)}, chunked_at = NULL WHERE session_id = 'sx'`;
    expect(await count('sx')).toBe(1);
    const [w] = await sql<Array<{ wtext: string }>>`
      SELECT wtext FROM harness_shared.session_turn_windows WHERE session_id = 'sx'`;
    expect(w!.wtext).toBe('q'.repeat(100));
    await sql`DELETE FROM harness_shared.session_turns WHERE session_id = 'sx'`;
    expect(await count('sx')).toBe(0);
  });

  it('an UPDATE that does not touch text leaves the windows alone', async () => {
    await seedTurn('w1', 'sy', 0, 'hello world');
    await sql`UPDATE harness_shared.session_turns SET speaker = 'assistant' WHERE session_id = 'sy'`;
    expect(await count('sy')).toBe(1);
  });

  it('the wtext trigram GIN serves a LIKE over the windows (EXPLAIN uses the index)', async () => {
    for (let i = 0; i < 40; i++) await seedTurn('w1', 'sz', i, `turn ${i} about furnishedfinder and papercusp`);
    const plan = await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.unsafe(
        `EXPLAIN SELECT 1 FROM harness_shared.session_turn_windows WHERE wtext LIKE '%finder%'`,
      );
      return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
    });
    expect(plan).toContain(WINDOWS_IDX);
  });
});
