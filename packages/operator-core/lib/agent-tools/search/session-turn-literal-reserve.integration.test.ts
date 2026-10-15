/**
 * Saturated-leg precedence over a REAL corpus (plan session-transcript-exact-fuzzy-search-2026-09-14,
 * SPEC-P001-EXACT-RESERVE).
 *
 * WHY THIS FILE EXISTS (measured by mutation probe M9 on 2026-10-01): the exact-candidate reserve
 * (`const eFloor = Math.min(policy.exactReserve, limit, exact.length)` in `composeSessionTurnTiers`)
 * was pinned only by a UNIT test over hand-built tier arrays. Replacing it with `const eFloor = 0` was
 * CAUGHT by the unit test and PASSED the integration file — so nothing at integration level proved that
 * a fuzzy leg with MORE and NEWER rows than the page can hold still leaves the exact matches their
 * slots. This file drives the real tier retrieval against Postgres (the exact tier from the trigram
 * predicate, the fuzzy tier through the vocabulary), then composes a page smaller than the fuzzy supply.
 *
 * Kept in its own file on purpose: editing the sibling integration file would re-fingerprint every
 * evidence binding that already measures it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDisclosureLedgerForTest, applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { runSessionSearchIndexBuildOnce } from '../../session-search-index-build';
import {
  composeSessionTurnTiers,
  retrieveSessionTurnLiteralTiers,
  type SessionTurnLiteralHit,
} from './session-turn-literal';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../../../libs/papercusp/libs/db/sql');
const WS = 'w-reserve';
const EXACT_TERM = 'zanzibarquartz';
const FUZZY_ONLY_TERM = 'zanzibarquarts'; // one edit away: reachable only through the vocabulary expansion
const EXACT_TURNS = 12;
const FUZZY_TURNS = 30; // more than any page below, and NEWER than every exact turn

let db: FreshPgDb;
let exact: SessionTurnLiteralHit[];
let fuzzy: SessionTurnLiteralHit[];

beforeAll(async () => {
  db = await createFreshPgDb('sess-turn-literal-reserve');
  const sql = db.sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`);
  await applyMigrationForTest(sql, path.join(SQL_DIR, '501-session-turns.sql'));
  await applyMigrationForTest(sql, path.join(SQL_DIR, '794-session-turns-provenance-at-ingest.sql'));
  await applyMigrationForTest(sql, path.join(SQL_DIR, '1273-session-turns-trigram-exact-fuzzy-index.sql'));
  await applyDisclosureLedgerForTest(sql); // D-006 reader rule (WI-10005570)
  // Exact turns are OLD; fuzzy-only turns are NEWER, so a newest-first slotter that ignored tier
  // precedence would fill a small page with fuzzy rows.
  await sql`
    INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts)
    SELECT ${WS}, 'claude', 'exact-' || g, 0, 'user', 'discussion of ' || ${EXACT_TERM} || ' number ' || g,
           now() - interval '30 days' + (g || ' minutes')::interval
      FROM generate_series(1, ${EXACT_TURNS}) g`;
  await sql`
    INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts)
    SELECT ${WS}, 'claude', 'fuzzy-' || g, 0, 'user', 'discussion of ' || ${FUZZY_ONLY_TERM} || ' number ' || g,
           now() - interval '1 day' + (g || ' minutes')::interval
      FROM generate_series(1, ${FUZZY_TURNS}) g`;
  // Fuzzy availability needs BOTH vocabularies ready (workspace + the host-global 'default').
  await sql`
    INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text)
    VALUES ('default', 'claude', 'dflt', 0, 'user', 'unrelated filler vocabulary words')`;
  const built = await runSessionSearchIndexBuildOnce(sql, { minFreeDiskBytes: 0 });
  expect([...built.indexes, ...built.vocab].filter((e) => e.action === 'failed'), 'no build step may fail').toEqual([]);

  const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: EXACT_TERM });
  expect(out.receipt.exact, 'the exact tier must run').toMatchObject({ status: 'ran' });
  expect(out.receipt.fuzzy, 'the fuzzy tier must run').toMatchObject({ status: 'ran' });
  exact = out.exact;
  fuzzy = out.fuzzy;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('exact reserve under a saturated fuzzy leg (real corpus)', () => {
  it('the real tiers saturate as designed: every exact turn found, fuzzy supply larger than the page and fuzzy-only', () => {
    expect(exact).toHaveLength(EXACT_TURNS);
    expect(fuzzy.length).toBeGreaterThan(EXACT_TURNS);
    expect(fuzzy.every((h) => h.excerpt.includes(FUZZY_ONLY_TERM) || h.highlight.includes(FUZZY_ONLY_TERM))).toBe(true);
    expect(fuzzy.some((h) => h.excerpt.includes(EXACT_TERM))).toBe(false);
  });

  it('a page smaller than the exact supply is ALL exact — the reserve outranks newer, more numerous fuzzy rows', () => {
    const page = composeSessionTurnTiers({ exact, fuzzy, hybrid: [], limit: 10 });
    expect(page.hits).toHaveLength(10);
    expect(page.hits.every((h) => h.tier === 'exact')).toBe(true);
    expect(page.counts.exact.kept).toBe(10);
    expect(page.counts.fuzzy.kept).toBe(0);
  });

  it('a page larger than the exact supply keeps EVERY exact turn first, then fills with fuzzy', () => {
    const limit = EXACT_TURNS + 8;
    const page = composeSessionTurnTiers({ exact, fuzzy, hybrid: [], limit });
    expect(page.hits).toHaveLength(limit);
    expect(page.hits.slice(0, EXACT_TURNS).every((h) => h.tier === 'exact')).toBe(true);
    expect(page.hits.slice(EXACT_TURNS).every((h) => h.tier === 'fuzzy')).toBe(true);
    expect(page.counts.exact.kept).toBe(EXACT_TURNS);
  });
});
