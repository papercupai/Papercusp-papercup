/**
 * Real-Postgres coverage for the bounded-latency windows exact route (plan
 * session-transcript-exact-fuzzy-search-2026-09-14 P-011 / WI-10005256; R-1 Route B per D-013/D-014).
 *
 * WHY THIS FILE EXISTS (root cause of the R-1 miss): the exact tier ran `lower(text) LIKE '%lit%'`
 * against ONE trigram GIN over whole turns. For a literal whose trigrams are each common ('finder' =
 * fin+ind+nde+der) the GIN intersection returns a huge candidate set (126k of 1.4M turns live) that is
 * almost all false positives, each rechecked against a detoasted turn of up to 8000 chars => ~10 s of CPU
 * against a 2 s deadline. The windows route indexes overlapping 512-char windows instead, so a literal
 * whose trigrams are spread across a turn but never co-occur inside one window is rejected by the INDEX.
 *
 * The recurrence guard is the "filler-heavy" describe: its corpus is built so EVERY filler turn contains
 * all four trigrams of 'finder' (adversarial for the legacy route) but never inside one 512-char window.
 * Deterministic by construction — it counts rows rechecked away in EXPLAIN ANALYZE, not wall-clock.
 *
 * Kept in its own file: editing the sibling integration files would re-fingerprint evidence bindings.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { applyDisclosureLedgerForTest, applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  SESSION_TURN_WINDOW_MAX_LITERAL,
  SESSION_TURN_WINDOW_OVERLAP,
  SESSION_TURN_WINDOW_STRIDE,
  readSessionSearchReadiness,
  runSessionSearchIndexBuildOnce,
  sessionSearchTierAvailability,
} from '../../session-search-index-build';
import {
  retrieveSessionTurnExact,
  retrieveSessionTurnLiteralTiers,
  SESSION_TURN_LITERAL_POLICY,
  type SessionTurnLiteralHit,
} from './session-turn-literal';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../../../libs/papercusp/libs/db/sql');
const WS = 'w-win';
const WINDOWS_IDX = 'session_turn_windows_wtext_trgm_idx';
const LEGACY_IDX = 'session_turns_text_trgm_idx';

let db: FreshPgDb;
let sql: postgres.Sql;

const keys = (hits: readonly SessionTurnLiteralHit[]): string[] => hits.map((h) => `${h.sessionId}:${h.turnIdx}`).sort();

async function seed(sid: string, idx: number, text: string, extra: { ws?: string; kind?: string; ts?: string } = {}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts, ingested_at)
    VALUES (${extra.ws ?? WS}, ${extra.kind ?? 'claude'}, ${sid}, ${idx}, 'user', ${text},
            ${extra.ts ?? '2026-01-01T00:00:00Z'}::timestamptz, now())`;
}

/**
 * The real deferred build. `preexisting` (default) first drops the windows the TRIGGER already wrote for the
 * seeded rows, so the BACKFILL (not the trigger) is what fills them — the shape of a deployed corpus that
 * predates migration 1334.
 */
async function build(opts: { preexisting?: boolean } = {}): Promise<void> {
  if (opts.preexisting !== false) await sql.unsafe(`TRUNCATE harness_shared.session_turn_windows`);
  const r = await runSessionSearchIndexBuildOnce(sql, { minFreeDiskBytes: 0 });
  expect([...r.indexes, ...r.vocab].filter((e) => e.action === 'failed'), 'no build step may fail').toEqual([]);
}

async function route(): Promise<'windows' | 'legacy' | undefined> {
  const readiness = await readSessionSearchReadiness(sql, [WS, 'default']);
  return sessionSearchTierAvailability(readiness, [WS, 'default']).exact.route;
}

/** Back to "migration applied, nothing backfilled": the state a deployed operator is in right after 1334. */
async function resetToPreBackfill(): Promise<void> {
  await sql.unsafe(`TRUNCATE harness_shared.session_turns CASCADE`);
  await sql.unsafe(`DROP INDEX IF EXISTS harness_shared.${WINDOWS_IDX}`);
  await sql.unsafe(
    `UPDATE harness_shared.session_turn_windows_state
        SET status = 'absent', cursor_workspace_id = NULL, cursor_source_kind = NULL, cursor_session_id = NULL,
            cursor_turn_idx = NULL, turns_done = 0, build_started_at = NULL, build_finished_at = NULL,
            heartbeat_at = NULL, last_error = NULL`,
  );
}

const exactVia = async (query: string, r: 'windows' | 'legacy', filters?: Parameters<typeof retrieveSessionTurnExact>[1]['filters']) =>
  retrieveSessionTurnExact(sql, { workspaceId: WS, query, filters }, SESSION_TURN_LITERAL_POLICY, r);

beforeAll(async () => {
  db = await createFreshPgDb('sess-turn-literal-windows');
  sql = db.sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`);
  await applyMigrationForTest(sql, path.join(SQL_DIR, '501-session-turns.sql'));
  // Migration 1117's column only: its backfill joins session_turn_chunks, which this fixture lacks.
  await sql.unsafe(`ALTER TABLE harness_shared.session_turns ADD COLUMN IF NOT EXISTS chunked_at timestamptz`);
  await applyMigrationForTest(sql, path.join(SQL_DIR, '794-session-turns-provenance-at-ingest.sql'));
  await applyMigrationForTest(sql, path.join(SQL_DIR, '1273-session-turns-trigram-exact-fuzzy-index.sql'));
  await applyMigrationForTest(sql, path.join(SQL_DIR, '1334-session-turn-windows.sql'));
  await applyDisclosureLedgerForTest(sql); // D-006 reader rule (WI-10005570)
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

/** The recurrence-guard describe builds ONE corpus in its beforeAll and must keep it across its tests. */
let keepCorpus = false;

beforeEach(async () => {
  if (!keepCorpus) await resetToPreBackfill();
});

describe('windows backfill + readiness gating (D-005: never consult a half-filled windows table)', () => {
  it('serves the LEGACY route until the backfill is complete AND the window GIN is valid, then flips to windows', async () => {
    await seed('a', 0, 'alpha zebracorn omega');
    await seed('a', 1, 'beta unrelated text');
    // Migration 1334 ran on an EMPTY table (=> inline 'ready'); reset made it pre-backfill again.
    expect(await route()).toBe('legacy');
    // Half-filled: windows rows exist for one turn, state still 'absent' => still legacy.
    await sql`INSERT INTO harness_shared.session_turn_windows SELECT workspace_id, source_kind, session_id, turn_idx, 0, 'x' FROM harness_shared.session_turns WHERE turn_idx = 0 ON CONFLICT DO NOTHING`;
    expect(await route()).toBe('legacy');
    await sql.unsafe(`TRUNCATE harness_shared.session_turn_windows`);

    await build();
    expect(await route()).toBe('windows');
    const [st] = await sql<Array<{ status: string; turns_done: string }>>`
      SELECT status, turns_done::text FROM harness_shared.session_turn_windows_state WHERE scope = 'all'`;
    expect(st!.status).toBe('ready');
    // Every pre-existing turn has window rows (the terminating predicate the backfill relies on).
    const [{ missing }] = await sql<Array<{ missing: string }>>`
      SELECT count(*)::text AS missing FROM harness_shared.session_turns t
       WHERE NOT EXISTS (SELECT 1 FROM harness_shared.session_turn_windows w
                          WHERE (w.workspace_id, w.source_kind, w.session_id, w.turn_idx)
                              = (t.workspace_id, t.source_kind, t.session_id, t.turn_idx))`;
    expect(missing).toBe('0');

    // An invalid/absent window GIN drops the route back to legacy even with state 'ready'.
    await sql.unsafe(`DROP INDEX harness_shared.${WINDOWS_IDX}`);
    expect(await route()).toBe('legacy');
  }, 90_000);

  it('does not let a live lease be stolen (in-flight) and resumes an expired one from the cursor without duplicating', async () => {
    for (let i = 0; i < 6; i++) await seed('r', i, `resume turn ${i} marker-${i}`);
    // The trigger already wrote windows for these seeded rows; a deployed corpus predating 1334 has none.
    await sql.unsafe(`TRUNCATE harness_shared.session_turn_windows`);
    // A live lease: heartbeat is fresh => the pass reports in-flight and must NOT flip ready.
    await sql.unsafe(`UPDATE harness_shared.session_turn_windows_state SET status = 'building', heartbeat_at = now() WHERE scope = 'all'`);
    const held = await runSessionSearchIndexBuildOnce(sql, { minFreeDiskBytes: 0 });
    expect(held.indexes.find((e) => e.name === 'session_turn_windows_backfill')?.action).toBe('in-flight');
    expect(await route()).toBe('legacy');

    // An EXPIRED lease with the cursor mid-corpus and the first half already filled: the pass resumes.
    await sql.unsafe(`
      INSERT INTO harness_shared.session_turn_windows
        SELECT t.workspace_id, t.source_kind, t.session_id, t.turn_idx, f.win_idx, f.wtext
          FROM harness_shared.session_turns t, LATERAL harness_shared.session_turn_windows_of(t.text) f
         WHERE t.turn_idx < 3`);
    await sql.unsafe(`
      UPDATE harness_shared.session_turn_windows_state
         SET status = 'building', heartbeat_at = now() - interval '2 hours',
             cursor_workspace_id = '${WS}', cursor_source_kind = 'claude', cursor_session_id = 'r', cursor_turn_idx = 2`);
    await build({ preexisting: false });
    expect(await route()).toBe('windows');
    const [{ n, distinctTurns }] = await sql<Array<{ n: string; distinctTurns: string }>>`
      SELECT count(*)::text AS n, count(DISTINCT turn_idx)::text AS "distinctTurns" FROM harness_shared.session_turn_windows`;
    expect(distinctTurns).toBe('6');
    expect(n).toBe('6'); // one window per short turn: resume neither skipped nor duplicated any turn
  }, 90_000);

  it('records a backfill failure on the state row and keeps serving the legacy route', async () => {
    await seed('f', 0, 'failure probe turn');
    // Sabotage the INSERT target so the backfill batch throws; the state row must say why.
    await sql.unsafe(`ALTER TABLE harness_shared.session_turn_windows RENAME COLUMN wtext TO wtext_renamed`);
    try {
      const r = await runSessionSearchIndexBuildOnce(sql, { minFreeDiskBytes: 0 });
      expect(r.indexes.find((e) => e.name === 'session_turn_windows_backfill')?.action).toBe('failed');
    } finally {
      await sql.unsafe(`ALTER TABLE harness_shared.session_turn_windows RENAME COLUMN wtext_renamed TO wtext`);
    }
    const [st] = await sql<Array<{ status: string; last_error: string | null }>>`
      SELECT status, last_error FROM harness_shared.session_turn_windows_state WHERE scope = 'all'`;
    expect(st!.status).toBe('failed');
    expect(st!.last_error).toBeTruthy();
    expect(await route()).toBe('legacy');
  }, 90_000);
});

describe('windows route == legacy route (recall-complete, precision-verified)', () => {
  /** Text with `literal` starting exactly at char offset `at` inside neutral filler (no 'zq' letters). */
  const placed = (literal: string, at: number, total = 1500): string => {
    const head = 'lorem ipsum dolor sit amet '.repeat(100).slice(0, at);
    const tail = ' consectetur adipiscing elit '.repeat(100);
    return (head + literal + tail).slice(0, Math.max(total, at + literal.length + 5));
  };

  it('finds the literal wherever it falls relative to the window cut, including windows boundaries', async () => {
    const lit = 'zqbridgewordzq';
    const S = SESSION_TURN_WINDOW_STRIDE;
    const cases: Array<[string, number]> = [
      ['start', 0],
      ['inside-first-window', 100],
      ['straddles-first-boundary', S - 6],
      ['starts-at-boundary', S],
      ['ends-at-window-end', SESSION_TURN_WINDOW_OVERLAP + S - lit.length],
      ['mid-second-window', S + 200],
      ['straddles-second-boundary', 2 * S - 5],
      ['near-end', 1400],
    ];
    for (const [i, [, at]] of cases.entries()) await seed('p', i, placed(lit, at));
    await seed('p', 100, 'no needle in this turn at all');
    await build();
    expect(await route()).toBe('windows');

    const expected = cases.map((_, i) => `p:${i}`).sort();
    const viaWindows = await exactVia(lit, 'windows');
    const viaLegacy = await exactVia(lit, 'legacy');
    expect(viaWindows.deadline).toBe(false);
    expect(keys(viaWindows.hits)).toEqual(expected);
    expect(keys(viaLegacy.hits)).toEqual(expected);
  }, 90_000);

  it('a literal of exactly the maximum window-resolvable length (65 chars) straddling a boundary is still found', async () => {
    const lit = ('q'.repeat(10) + 'abcde').repeat(5).slice(0, SESSION_TURN_WINDOW_MAX_LITERAL);
    expect(lit.length).toBe(SESSION_TURN_WINDOW_MAX_LITERAL);
    // Place it so it spans the maximum overlap: starts one char into window 1's exclusive part.
    await seed('m', 0, placed(lit, SESSION_TURN_WINDOW_STRIDE - SESSION_TURN_WINDOW_OVERLAP + 1));
    await seed('m', 1, placed(lit, SESSION_TURN_WINDOW_STRIDE - 3));
    await build();
    expect(keys((await exactVia(lit, 'windows')).hits)).toEqual(['m:0', 'm:1']);
  }, 90_000);

  it('a literal LONGER than one window overlap is prefix-filtered then VERIFIED against the whole turn (decoys excluded)', async () => {
    const stem = 'zqlongstem'.repeat(7).slice(0, SESSION_TURN_WINDOW_MAX_LITERAL); // exactly the prefix length
    const real = `${stem}-the-real-tail-that-is-long-enough-to-exceed-the-prefix`;
    const decoy = `${stem}-a-different-tail-that-shares-only-the-prefix`;
    expect(real.length).toBeGreaterThan(SESSION_TURN_WINDOW_MAX_LITERAL);
    await seed('l', 0, placed(real, 300));
    await seed('l', 1, placed(decoy, 300));
    await seed('l', 2, placed(real, SESSION_TURN_WINDOW_STRIDE - 20)); // real literal straddling a boundary
    await build();
    const viaWindows = await exactVia(real, 'windows');
    expect(keys(viaWindows.hits)).toEqual(['l:0', 'l:2']);
    expect(keys((await exactVia(real, 'legacy')).hits)).toEqual(['l:0', 'l:2']);
  }, 90_000);

  it('matches case-insensitively, treats LIKE metacharacters literally, and handles non-ASCII text', async () => {
    await seed('c', 0, 'Ask the ZQCaseMixed team');
    await seed('c', 1, 'got 100%_zqdone today');
    await seed('c', 2, 'got 100xxzqdone today');
    await seed('c', 3, 'path back\\zqslash here');
    await seed('c', 4, 'naïve café zqünïcode 日本語 text');
    await build();
    expect(keys((await exactVia('zqcasemixed', 'windows')).hits)).toEqual(['c:0']);
    expect(keys((await exactVia('100%_zqdone', 'windows')).hits)).toEqual(['c:1']);
    expect(keys((await exactVia('back\\zqslash', 'windows')).hits)).toEqual(['c:3']);
    expect(keys((await exactVia('zqünïcode', 'windows')).hits)).toEqual(['c:4']);
  }, 90_000);

  it('preserves scope parity: workspace + host-global default only, plus session/source filters', async () => {
    await seed('s1', 0, 'shared zqscoped literal', { kind: 'claude' });
    await seed('s2', 0, 'shared zqscoped literal', { kind: 'codex' });
    await seed('s3', 0, 'shared zqscoped literal', { ws: 'default' });
    await seed('s4', 0, 'shared zqscoped literal', { ws: 'other-workspace' });
    await build();
    expect(keys((await exactVia('zqscoped', 'windows')).hits)).toEqual(['s1:0', 's2:0', 's3:0']);
    expect(keys((await exactVia('zqscoped', 'windows', { sessionId: 's2' })).hits)).toEqual(['s2:0']);
    expect(keys((await exactVia('zqscoped', 'windows', { sourceKind: 'codex' })).hits)).toEqual(['s2:0']);
  }, 90_000);

  it('the tier composer picks the windows route when ready and reports the hit through the normal receipt', async () => {
    await seed('t', 0, placed('zqcomposerhit', 600));
    await build();
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'zqcomposerhit' });
    expect(out.receipt.exact.status).toBe('ran');
    expect(keys(out.exact)).toEqual(['t:0']);
    expect(out.exact[0]!.excerpt).toContain('zqcomposerhit');
  }, 90_000);
});

describe('trigger maintenance keeps windows current AFTER the backfill', () => {
  it('insert, text update and delete are reflected without a rebuild', async () => {
    await seed('g', 0, 'baseline turn');
    await build();
    expect(await route()).toBe('windows');

    await seed('g', 1, 'freshly inserted zqtrigone turn');
    expect(keys((await exactVia('zqtrigone', 'windows')).hits)).toEqual(['g:1']);

    await sql`UPDATE harness_shared.session_turns SET text = 'rewritten to carry zqtrigtwo instead', chunked_at = NULL WHERE session_id = 'g' AND turn_idx = 1`;
    expect(keys((await exactVia('zqtrigone', 'windows')).hits)).toEqual([]);
    expect(keys((await exactVia('zqtrigtwo', 'windows')).hits)).toEqual(['g:1']);

    await sql`DELETE FROM harness_shared.session_turns WHERE session_id = 'g' AND turn_idx = 1`;
    expect(keys((await exactVia('zqtrigtwo', 'windows')).hits)).toEqual([]);
    const [{ n }] = await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM harness_shared.session_turn_windows WHERE turn_idx = 1`;
    expect(n).toBe('0'); // the FK cascade removed the windows with their turn
  }, 90_000);
});

describe('R-1 recurrence guard — a filler-heavy corpus where every turn carries the literal\'s trigrams but not the literal', () => {
  // 'finder' => trigrams fin, ind, nde, der. A filler turn holds all four in three WORDS ('finish', 'indigo',
  // 'wonder') separated by > 512 chars of neutral text: the whole-turn GIN lists EVERY filler turn as a
  // candidate (all trigrams present), while no single 512-char window contains them together.
  const NEUTRAL = 'lorem ipsum dolor sit amet consectetur '; // 38 chars; contains none of fin/ind/nde/der
  const gap = NEUTRAL.repeat(18); // 684 chars > one 512-char window
  const fillerText = (g: number): string => `row${g} finish ${gap}indigo ${gap}wonder ${gap}tail`;
  const FILLER = 320;
  let recorder: postgres.Sql;
  let captured: Array<{ query: string; params: unknown[] }> = [];

  beforeAll(async () => {
    await resetToPreBackfill();
    keepCorpus = true;
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts)
      SELECT ${WS}, 'claude', 'filler', g, 'user',
             'row' || g || ' finish ' || ${gap} || 'indigo ' || ${gap} || 'wonder ' || ${gap} || 'tail',
             '2025-01-01T00:00:00Z'::timestamptz
        FROM generate_series(1, ${FILLER}) g`;
    // The true matches: the literal contiguous, once per turn, at different offsets.
    for (let i = 0; i < 3; i++) await seed('real', i, `${gap.slice(0, 100 + 300 * i)} the finder is here ${gap}`);
    await build();
    await sql.unsafe('ANALYZE harness_shared.session_turns');
    await sql.unsafe('ANALYZE harness_shared.session_turn_windows');
    recorder = postgres(db.url, {
      max: 1,
      debug: (_c: number, query: string, parameters: unknown[]) => {
        captured.push({ query, params: parameters });
      },
    });
  }, 180_000);

  afterAll(async () => {
    keepCorpus = false;
    await recorder?.end({ timeout: 5 });
  });

  const branchOf = (needle: RegExp): { query: string; params: unknown[] } => {
    const found = captured.filter((c) => /FROM\s+harness_shared\.session_turn/i.test(c.query) && /LIKE/i.test(c.query) && needle.test(c.query));
    expect(found.length, 'exactly one literal branch must have run').toBe(1);
    return found[0]!;
  };

  /** EXPLAIN ANALYZE the recorded production statement; return plan text + rows rechecked away. */
  async function analyse(c: { query: string; params: unknown[] }): Promise<{ plan: string; recheckRemoved: number }> {
    const plan = await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off'); // reveal INDEX-servability, as the sibling plan test does
      const rows = await tx.unsafe(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${c.query}`, c.params as never[]);
      return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
    });
    const recheckRemoved = [...plan.matchAll(/Rows Removed by (?:Index Recheck|Filter): (\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    return { plan, recheckRemoved };
  }

  it('the corpus is adversarial for the legacy route (control): every filler turn is a whole-turn trigram candidate', async () => {
    captured = [];
    const out = await retrieveSessionTurnExact(recorder, { workspaceId: WS, query: 'finder' }, SESSION_TURN_LITERAL_POLICY, 'legacy');
    expect(keys(out.hits)).toEqual(['real:0', 'real:1', 'real:2']);
    const { plan, recheckRemoved } = await analyse(branchOf(/lower\(text\) LIKE/));
    // If this control stops holding the fixture no longer exercises the failure — the guard below is vacuous.
    expect(recheckRemoved, `legacy plan:\n${plan}`).toBeGreaterThanOrEqual(FILLER - 20);
  }, 90_000);

  it('the windows route rejects those turns in the INDEX: hits found, ~no rows rechecked away, window GIN used', async () => {
    captured = [];
    const t0 = Date.now();
    const out = await retrieveSessionTurnLiteralTiers(recorder, { workspaceId: WS, query: 'finder' });
    expect(out.receipt.exact.status).toBe('ran'); // inside the exact deadline, not 'deadline'
    expect(keys(out.exact)).toEqual(['real:0', 'real:1', 'real:2']);
    expect(Date.now() - t0).toBeLessThan(SESSION_TURN_LITERAL_POLICY.exactDeadlineMs * 2);
    const { plan, recheckRemoved } = await analyse(branchOf(/hit AS MATERIALIZED/));
    expect(plan, `WINDOWS plan:\n${plan}`).toContain(WINDOWS_IDX);
    expect(plan).not.toMatch(/Seq Scan on (harness_shared\.)?session_turn_windows/);
    // The legacy control rechecks >= FILLER-20 rows; the windows route must recheck an order of magnitude fewer.
    expect(recheckRemoved, `windows plan:\n${plan}`).toBeLessThan(25);
  }, 90_000);
});
