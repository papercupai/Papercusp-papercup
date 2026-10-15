/**
 * Production-path query-plan coverage for the exact + fuzzy session-turn tiers (plan
 * session-transcript-exact-fuzzy-search-2026-09-14, SPEC-P001-INDEXED-DESIGN / SPEC-P001-SHORT-GUARD).
 *
 * WHY THIS FILE EXISTS (root cause, measured by mutation probe M10 on 2026-10-01): the sibling
 * `session-turn-literal.integration.test.ts` EXPLAINs a HAND-WRITTEN `lower(text) LIKE '%x%'`
 * predicate. That proves the trigram GIN *can* serve that shape, but nothing pinned the SQL that
 * `session-turn-literal.ts` actually sends — rewriting the production predicate to `text ILIKE ...`
 * (which the index cannot serve) left every test green (M10 SURVIVED). This file records the
 * statements the REAL retrieval path executes (postgres.js `debug` hook on a recording connection)
 * and EXPLAINs THOSE, so the plan evidence is about production SQL, not a copy of it.
 *
 * Kept in its own file on purpose: editing the sibling would re-fingerprint every evidence binding
 * that already measures it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { applyDisclosureLedgerForTest, applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { runSessionSearchIndexBuildOnce } from '../../session-search-index-build';
import { retrieveSessionTurnFuzzy, retrieveSessionTurnLiteralTiers } from './session-turn-literal';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../../../libs/papercusp/libs/db/sql');
const M501 = path.join(SQL_DIR, '501-session-turns.sql');
const M794 = path.join(SQL_DIR, '794-session-turns-provenance-at-ingest.sql');
const M1273 = path.join(SQL_DIR, '1273-session-turns-trigram-exact-fuzzy-index.sql');
const M1347 = path.join(SQL_DIR, '1347-personal-disclosures-reader-window-idx.sql');
const TRGM = 'session_turns_text_trgm_idx';
const LEDGER_IDX = 'personal_disclosures_owner_window_idx';
const WS = 'w-plan';

interface Captured {
  query: string;
  params: unknown[];
}

let db: FreshPgDb;
let sql: postgres.Sql;
let recorder: postgres.Sql;
let captured: Captured[] = [];

beforeAll(async () => {
  db = await createFreshPgDb('sess-turn-literal-plan');
  sql = db.sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`);
  await applyMigrationForTest(sql, M501);
  await applyMigrationForTest(sql, M794);
  await applyMigrationForTest(sql, M1273);
  await applyDisclosureLedgerForTest(sql); // D-006 reader rule (WI-10005570)
  await applyMigrationForTest(sql, M1347); // the index that serves the reader rule (WI-10005669)
  // The corpus is large enough, and the target literal RARE enough, for the planner to prefer the GIN
  // (a literal present in every row is correctly served by the newest-first btree instead — that is a
  // selectivity fact, not an index defect; and on a ~3k-row table the workspace pkey bitmap + post-filter
  // is genuinely cheaper than any GIN scan, so the corpus must be production-shaped: workspace_id is NOT
  // selective, the literal IS). 40000 filler turns of random hex words + 25 target turns.
  await sql`
    INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text)
    SELECT ${WS}, 'claude', 'plan', g, 'user', md5(g::text) || ' ' || md5((g + 1)::text)
      FROM generate_series(1, 40000) g`;
  await sql`
    INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text)
    SELECT ${WS}, 'claude', 'plan-target', g, 'user', 'about furnishedfinder listings ' || md5((g + 7)::text)
      FROM generate_series(1, 25) g`;
  // Fuzzy availability needs BOTH vocabularies ready (workspace + the host-global 'default').
  await sql`
    INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text)
    VALUES ('default', 'claude', 'dflt', 0, 'user', 'unrelated filler vocabulary words')`;
  const built = await runSessionSearchIndexBuildOnce(sql, { minFreeDiskBytes: 0 });
  expect([...built.indexes, ...built.vocab].filter((e) => e.action === 'failed'), 'no build step may fail').toEqual([]);
  await sql.unsafe('ANALYZE harness_shared.session_turns');
  recorder = postgres(db.url, {
    max: 1,
    debug: (_connection: number, query: string, parameters: unknown[]) => {
      captured.push({ query, params: parameters });
    },
  });
}, 180_000);

afterAll(async () => {
  await recorder?.end({ timeout: 5 });
  await db?.cleanup();
});

/** The production statements that scan session_turns with a trigram predicate (excludes SET LOCAL etc.). */
const literalBranches = (): Captured[] =>
  captured.filter((c) => /FROM\s+harness_shared\.session_turns/i.test(c.query) && /LIKE/i.test(c.query));

/**
 * Every seq-scanned relation in a plan. Both halves of each statement must be index-servable:
 * the session_turns access (the trigram GIN), and the D-006 reader rule's correlated EXISTS over
 * `personal_disclosures` (WI-10005570). The ledger's 1302 indexes are partial (released_at IS NULL),
 * so before migration 1347 that subquery seq-scanned the ledger on every transcript read even with
 * enable_seqscan=off (WI-10005669). No relation is exempt any more.
 */
const seqScans = (plan: string): string[] => plan.split('\n').filter((l) => /Seq Scan/.test(l));

async function planOf(c: Captured): Promise<string> {
  return sql.begin(async (tx) => {
    // Forbid the seq scan fallback so the plan reveals whether the predicate is INDEX-SERVABLE at all.
    await tx.unsafe('SET LOCAL enable_seqscan = off');
    const rows = await tx.unsafe(`EXPLAIN ${c.query}`, c.params as never[]);
    return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
  });
}

describe('production literal branches are served by the trigram GIN (not a hand-copied predicate)', () => {
  it('the EXACT branch the retrieval path executes is a plain lower(text) LIKE and uses the trigram index', async () => {
    captured = [];
    const out = await retrieveSessionTurnLiteralTiers(recorder, { workspaceId: WS, query: 'furnishedfinder' });
    expect(out.receipt.exact).toMatchObject({ status: 'ran' });
    const branches = literalBranches().filter((c) => !/LIKE\s+ANY/i.test(c.query));
    expect(branches.length, 'the exact tier must issue exactly one literal branch').toBe(1);
    expect(branches[0]!.query).toMatch(/lower\(text\) LIKE/);
    const plan = await planOf(branches[0]!);
    expect(plan, `EXACT plan:\n${plan}`).toContain(TRGM);
    expect(plan, `EXACT plan (reader rule must use the ledger index):\n${plan}`).toContain(LEDGER_IDX);
    expect(seqScans(plan), `EXACT plan:\n${plan}`).toEqual([]);
  }, 90_000);

  it('every FUZZY variant statement (typo query) is a lower(text) LIKE and uses the trigram index', async () => {
    captured = [];
    // The fuzzy tier alone (the exact tier would add its own branch for the typo literal itself).
    // Since WI-10004501 it resolves ONE statement PER vocabulary variant, so there is >= 1 branch.
    const out = await retrieveSessionTurnFuzzy(recorder, { workspaceId: WS, query: 'furnishedfindr' });
    expect(out.expanded[0]?.words.length, 'the typo must expand to vocabulary neighbours, not skip').toBeGreaterThan(0);
    const branches = literalBranches();
    expect(branches.length, 'the fuzzy tier must issue one literal branch per variant').toBeGreaterThanOrEqual(1);
    for (const b of branches) {
      expect(b.query).toMatch(/lower\(text\) LIKE/);
      const plan = await planOf(b);
      expect(plan).toContain(TRGM);
      expect(plan, `FUZZY plan (reader rule must use the ledger index):\n${plan}`).toContain(LEDGER_IDX);
      expect(seqScans(plan), `FUZZY plan:\n${plan}`).toEqual([]);
    }
  }, 90_000);

  it('a literal below the trigram minimum issues NO scan of session_turns at all (sub-boundary guard)', async () => {
    captured = [];
    const out = await retrieveSessionTurnLiteralTiers(recorder, { workspaceId: WS, query: ' ab ' });
    expect(out.exact).toEqual([]);
    expect(out.receipt.exact).toMatchObject({ status: 'skipped', skipReason: 'literal-too-short' });
    expect(literalBranches(), 'no trigram-predicate statement may run for a 2-char literal').toEqual([]);
  }, 90_000);
});
