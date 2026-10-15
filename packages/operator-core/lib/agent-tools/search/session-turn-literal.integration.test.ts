/**
 * Real-Postgres coverage for the exact + fuzzy session-turn tiers (plan
 * session-transcript-exact-fuzzy-search-2026-09-14 P-003; D-001..D-005). The fixture replays the
 * real session_turns DDL (M501 + M794 provenance columns) and the P-002 migration (M1273), builds
 * the indexes + vocabulary with the real deferred build, and then drives the real retrieval SQL.
 *
 * Test names starting "Exact compact-literal regression" are the VAL-P003-RETRIEVAL-PRECEDENCE
 * evidence names — keep them verbatim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { applyDisclosureLedgerForTest, applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  SESSION_SEARCH_INDEXES,
  runSessionSearchIndexBuildOnce as runSessionSearchIndexBuildOnceRaw,
} from '../../session-search-index-build';
import { OWNER_CANDIDATE_TURN_VERDICTS } from '../../turn-provenance/turn-ref';
import {
  SESSION_TURN_LITERAL_POLICY,
  retrieveSessionTurnExact,
  retrieveSessionTurnLiteralTiers,
  type SessionTurnLiteralHit,
} from './session-turn-literal';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../../../libs/papercusp/libs/db/sql');
const M501 = path.join(SQL_DIR, '501-session-turns.sql');
const M794 = path.join(SQL_DIR, '794-session-turns-provenance-at-ingest.sql');
const M1273 = path.join(SQL_DIR, '1273-session-turns-trigram-exact-fuzzy-index.sql');
const TRGM = 'session_turns_text_trgm_idx';
const WS = 'w-lit';

let db: FreshPgDb;
let sql: postgres.Sql;

interface SeedRow {
  ws?: string;
  kind?: string;
  sid: string;
  idx?: number;
  speaker?: string;
  owner?: string | null;
  harness?: string | null;
  verdict?: string | null;
  text: string;
  ts?: string | null;
  ingested?: string;
}

async function seedTurn(r: SeedRow): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, speaker, owner, harness_slug,
       turn_origin_verdict, text, ts, ingested_at)
    VALUES (${r.ws ?? WS}, ${r.kind ?? 'claude'}, ${r.sid}, ${r.idx ?? 0}, ${r.speaker ?? 'user'},
            ${r.owner ?? null}, ${r.harness ?? null}, ${r.verdict ?? null}, ${r.text},
            ${r.ts ?? null}::timestamptz, ${r.ingested ?? '2026-01-01T00:00:00Z'}::timestamptz)`;
}

/** The real deferred build; a swallowed per-step failure would otherwise read as an assertion miss. */
async function build(): Promise<void> {
  const r = await runSessionSearchIndexBuildOnceRaw(sql, { minFreeDiskBytes: 0 });
  expect([...r.indexes, ...r.vocab].filter((e) => e.action === 'failed'), 'no build step may fail').toEqual([]);
}

const keys = (hits: readonly SessionTurnLiteralHit[]): string[] => hits.map((h) => `${h.sessionId}:${h.turnIdx}`);

beforeAll(async () => {
  db = await createFreshPgDb('sess-turn-literal');
  sql = db.sql;
  // 501 indexes harness_shared.coord_event_log (an unrelated coord leg); stub only that table.
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`);
  await applyMigrationForTest(sql, M501);
  await applyMigrationForTest(sql, M794);
  await applyMigrationForTest(sql, M1273);
  await applyDisclosureLedgerForTest(sql); // D-006 reader rule (WI-10005570)
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql.unsafe(
    `TRUNCATE harness_shared.session_turns, harness_shared.session_turn_vocab, harness_shared.session_turn_vocab_state`,
  );
  for (const i of SESSION_SEARCH_INDEXES) await sql.unsafe(`DROP INDEX IF EXISTS harness_shared.${i.name}`);
});

describe('exact tier — contiguous literal containment, index-backed', () => {
  it('Exact compact-literal regression: a literal inside a URL lexeme is found even when it is older than thousands of newer turns', async () => {
    await seedTurn({
      sid: 'old',
      text: 'check https://www.furnishedfinder.com/listing for the unit',
      ts: '2020-01-01T00:00:00Z',
    });
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts)
      SELECT ${WS}, 'claude', 'filler', g, 'user', 'filler turn ' || g || ' about papercusp sessions',
             now() - g * interval '1 second'
        FROM generate_series(1, 5000) g`;
    // The premise: the tokenized (english tsvector) leg cannot reach this literal at all.
    const [{ tokenized }] = await sql<Array<{ tokenized: boolean }>>`
      SELECT text_tsv @@ plainto_tsquery('english', 'furnishedfinder') AS tokenized
        FROM harness_shared.session_turns WHERE session_id = 'old'`;
    expect(tokenized).toBe(false);

    await build();
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnishedfinder' });
    expect(out.receipt.exact.status).toBe('ran');
    expect(keys(out.exact)).toEqual(['old:0']);
    const [hit] = out.exact;
    expect(hit!.tier).toBe('exact');
    expect(hit!.excerpt).toContain('furnishedfinder');
    expect(hit!.highlight).toContain('<mark>furnishedfinder</mark>');
    expect(hit!.excerpt.startsWith('[user ')).toBe(true);
  }, 90_000);

  it('matches case-insensitively', async () => {
    await seedTurn({ sid: 'c', text: 'Ask the FurnishedFinder team' });
    await build();
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnishedFINDER' });
    expect(keys(out.exact)).toEqual(['c:0']);
  }, 60_000);

  it('treats LIKE metacharacters in the query literally (% _ \\)', async () => {
    await seedTurn({ sid: 'm', idx: 0, text: 'got 100%_done today' });
    await seedTurn({ sid: 'm', idx: 1, text: 'got 100xxdone today' });
    await seedTurn({ sid: 'm', idx: 2, text: 'path back\\slash here' });
    await build();
    expect(keys((await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: '100%_done' })).exact)).toEqual(['m:0']);
    expect(keys((await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'back\\slash' })).exact)).toEqual(['m:2']);
  }, 60_000);

  it('orders newest-first and enforces the candidate cap', async () => {
    for (const [i, ts] of [
      [0, '2021-01-01T00:00:00Z'],
      [1, '2023-01-01T00:00:00Z'],
      [2, '2022-01-01T00:00:00Z'],
    ] as const) {
      await seedTurn({ sid: 'z', idx: i, text: 'the zebracorn appears', ts });
    }
    await build();
    const all = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'zebracorn' });
    expect(keys(all.exact)).toEqual(['z:1', 'z:2', 'z:0']);

    const capped = await retrieveSessionTurnLiteralTiers(
      sql,
      { workspaceId: WS, query: 'zebracorn' },
      { policy: { ...SESSION_TURN_LITERAL_POLICY, candidateCap: 2 } },
    );
    expect(capped.exact).toHaveLength(2);
  }, 60_000);

  it('skips a literal shorter than the trigram minimum instead of scanning', async () => {
    await seedTurn({ sid: 's', text: 'ab cd ef' });
    // Fuzzy availability needs BOTH vocabularies ready; seed the host-global one so the receipt
    // reaches the real skip reason (no expandable token) rather than vocab-default:absent.
    await seedTurn({ ws: 'default', sid: 'dflt', text: 'unrelated filler vocabulary words' });
    await build();
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: ' ab ' });
    expect(out.exact).toEqual([]);
    expect(out.receipt.exact).toMatchObject({ status: 'skipped', skipReason: 'literal-too-short' });
    expect(out.receipt.fuzzy).toMatchObject({ status: 'skipped', skipReason: 'no-expandable-token' });
  }, 60_000);

  it('serves the exact predicate from the trigram GIN (single pattern and LIKE ANY alike)', async () => {
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text)
      SELECT ${WS}, 'claude', 'e', g, 'user', md5(g::text) || ' furnishedfinder ' || md5((g + 1)::text)
        FROM generate_series(1, 3000) g`;
    await build();
    await sql.unsafe('ANALYZE harness_shared.session_turns');
    const plan = async (where: string): Promise<string> =>
      sql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL enable_seqscan = off');
        const rows = await tx.unsafe(`EXPLAIN SELECT 1 FROM harness_shared.session_turns WHERE ${where}`);
        return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
      });
    expect(await plan(`lower(text) LIKE '%furnishedfinder%'`)).toContain(TRGM);
    const any = await plan(`lower(text) LIKE ANY (ARRAY['%furnishedfinder%', '%furnishedfinders%']::text[])`);
    expect(any).toContain(TRGM);
    expect(any).not.toMatch(/Seq Scan/);
  }, 90_000);
});

describe('filter parity with the session_turn source', () => {
  const NEEDLE = 'zebracorn';
  beforeEach(async () => {
    await seedTurn({ sid: 'sA', idx: 0, owner: 'su-1', speaker: 'user', harness: 'h1', verdict: 'owner-typed', kind: 'claude', ts: '2026-03-01T00:00:00Z', text: `a ${NEEDLE}` });
    await seedTurn({ ws: 'default', sid: 'sB', idx: 0, owner: 'su-2', speaker: 'assistant', harness: 'h2', verdict: 'agent-injected', kind: 'omp', ts: '2026-02-01T00:00:00Z', text: `b ${NEEDLE}` });
    await seedTurn({ ws: 'other', sid: 'sC', idx: 0, owner: 'su-3', speaker: 'user', harness: 'h1', verdict: 'owner-typed', ts: '2026-03-15T00:00:00Z', text: `c ${NEEDLE}` });
    await seedTurn({ sid: 'sA', idx: 1, owner: null, speaker: 'user', harness: 'h1', verdict: 'unknown', ts: '2026-01-01T00:00:00Z', text: `d ${NEEDLE}` });
    // ts NULL: the time predicates and ordering fall back to ingested_at.
    await seedTurn({ sid: 'sD', idx: 0, owner: 'su-1', speaker: 'user', harness: 'h3', verdict: 'owner-typed', ts: null, ingested: '2026-04-01T00:00:00Z', text: `e ${NEEDLE}` });
    await build();
  }, 90_000);

  const run = async (filters: Parameters<typeof retrieveSessionTurnLiteralTiers>[1]['filters'], scopeFilter?: string) =>
    keys((await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: NEEDLE, filters, scopeFilter })).exact);

  it('isolates workspaces but includes the host-global "default" workspace; orders by COALESCE(ts, ingested_at) desc', async () => {
    expect(await run(undefined)).toEqual(['sD:0', 'sA:0', 'sB:0', 'sA:1']);
  });
  it('scopeFilter narrows by harness_slug', async () => {
    expect(await run(undefined, 'h1')).toEqual(['sA:0', 'sA:1']);
  });
  it('owners / speaker / turnOrigin / sessionId / sourceKind', async () => {
    expect(await run({ owners: ['su-2'] })).toEqual(['sB:0']);
    expect(await run({ owners: ['su-1', 'su-2'] })).toEqual(['sD:0', 'sA:0', 'sB:0']);
    expect(await run({ speaker: 'assistant' })).toEqual(['sB:0']);
    expect(await run({ turnOrigin: 'agent-injected' })).toEqual(['sB:0']);
    expect(await run({ sessionId: 'sB' })).toEqual(['sB:0']);
    expect(await run({ sourceKind: 'omp' })).toEqual(['sB:0']);
  });
  it('ownerOnly keeps owner-typed/owner-dialog; ownerCandidates keeps the shared candidate verdict set', async () => {
    expect(await run({ ownerOnly: true })).toEqual(['sD:0', 'sA:0']);
    const candidate = new Set<string>(OWNER_CANDIDATE_TURN_VERDICTS);
    const expected = [
      ['sD:0', 'owner-typed'],
      ['sA:0', 'owner-typed'],
      ['sB:0', 'agent-injected'],
      ['sA:1', 'unknown'],
    ]
      .filter(([, v]) => candidate.has(v!))
      .map(([k]) => k);
    expect(await run({ ownerCandidates: true })).toEqual(expected);
    expect(expected).toContain('sA:0');
  });
  it('since is inclusive and until exclusive, on COALESCE(ts, ingested_at)', async () => {
    expect(await run({ since: '2026-02-15T00:00:00Z' })).toEqual(['sD:0', 'sA:0']);
    expect(await run({ until: '2026-02-15T00:00:00Z' })).toEqual(['sB:0', 'sA:1']);
    expect(await run({ since: '2026-02-01T00:00:00Z', until: '2026-03-01T00:00:00Z' })).toEqual(['sB:0']);
  });
});

describe('fuzzy tier — vocabulary expansion resolved through the exact predicate', () => {
  it('a typo finds the turn that contains the real word, reporting what it was expanded to', async () => {
    await seedTurn({ sid: 'fz', text: 'I signed up at furnishedfinder yesterday' });
    await seedTurn({ ws: 'default', sid: 'dflt', text: 'unrelated filler vocabulary words' });
    await build();
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnisedfinder' });
    expect(out.exact).toEqual([]);
    expect(out.receipt.fuzzy.status).toBe('ran');
    expect(keys(out.fuzzy)).toEqual(['fz:0']);
    const [hit] = out.fuzzy;
    expect(hit!.tier).toBe('fuzzy');
    expect(hit!.fuzzy).toMatchObject({ token: 'furnisedfinder', word: 'furnishedfinder' });
    expect(hit!.fuzzy!.similarity).toBeGreaterThanOrEqual(SESSION_TURN_LITERAL_POLICY.fuzzySimilarity);
    expect(hit!.highlight).toContain('<mark>furnishedfinder</mark>');
    expect(out.receipt.fuzzy.expanded?.[0]?.words.map((w) => w.word)).toContain('furnishedfinder');
  }, 90_000);

  it('keeps the rest of a multi-word query contiguous: only the typo token is replaced', async () => {
    await seedTurn({ sid: 'ph', idx: 0, text: 'new furnishedfinder listing posted' });
    await seedTurn({ sid: 'ph', idx: 1, text: 'furnishedfinder and then a separate listing' });
    await seedTurn({ ws: 'default', sid: 'dflt', text: 'unrelated filler vocabulary words' });
    await build();
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnisedfinder listing' });
    expect(keys(out.fuzzy)).toEqual(['ph:0']);
  }, 90_000);

  it('never expands a short token (4-char "plam") and says why', async () => {
    await seedTurn({ sid: 'p', text: 'a palm tree' });
    await seedTurn({ ws: 'default', sid: 'dflt', text: 'unrelated filler vocabulary words' });
    await build();
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'plam' });
    expect(out.fuzzy).toEqual([]);
    expect(out.receipt.fuzzy).toMatchObject({ status: 'skipped', skipReason: 'no-expandable-token' });
  }, 60_000);

  it("expands only through this workspace's (and the host-global default) vocabulary, never another workspace's", async () => {
    await seedTurn({ ws: 'other', sid: 'o', text: 'secret furnishedfinder talk' });
    await seedTurn({ sid: 'mine', text: 'plain filler vocabulary words' });
    await seedTurn({ ws: 'default', sid: 'dflt', text: 'unrelated filler vocabulary words' });
    await build();
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnisedfinder' });
    expect(out.fuzzy).toEqual([]);
    expect(out.receipt.fuzzy.expanded?.[0]?.words ?? []).toEqual([]);
  }, 90_000);
});

describe('D-005 degrade: an unready tier is skipped with a reason, never a scan', () => {
  it('index absent: both tiers skip with exact-index-absent and return nothing although a match exists', async () => {
    await seedTurn({ sid: 'x', text: 'www.furnishedfinder.com' });
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnishedfinder' });
    expect(out.exact).toEqual([]);
    expect(out.fuzzy).toEqual([]);
    expect(out.receipt.exact).toMatchObject({ status: 'skipped', skipReason: 'exact-index-absent' });
    expect(out.receipt.fuzzy).toMatchObject({ status: 'skipped', skipReason: 'exact-index-absent' });
  });

  it('vocabulary building: fuzzy skips, exact still runs', async () => {
    await seedTurn({ sid: 'v', text: 'furnishedfinder is here' });
    await seedTurn({ ws: 'default', sid: 'dflt', text: 'unrelated filler vocabulary words' });
    await build();
    await sql`UPDATE harness_shared.session_turn_vocab_state SET status = 'building' WHERE workspace_id = ${WS}`;
    const out = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnishedfinder' });
    expect(keys(out.exact)).toEqual(['v:0']);
    expect(out.receipt.fuzzy).toMatchObject({ status: 'skipped', skipReason: `vocab-${WS}:building` });
  }, 60_000);
});

describe('D-003 deadlines', () => {
  it('a branch that cannot finish inside its deadline returns a bounded empty result with a deadline marker, then recovers', async () => {
    await seedTurn({ sid: 'dl', text: 'furnishedfinder is here' });
    await seedTurn({ ws: 'default', sid: 'dflt', text: 'unrelated filler vocabulary words' });
    await build();
    const tight = { ...SESSION_TURN_LITERAL_POLICY, exactDeadlineMs: 250, fuzzyExpandDeadlineMs: 250, fuzzyResolveDeadlineMs: 250 };

    // A second connection holds ACCESS EXCLUSIVE on the corpus, so the branch waits on the lock
    // and statement_timeout fires deterministically — no timing race against a fast query.
    const blocked = await sql.begin(async (tx) => {
      await tx.unsafe('LOCK TABLE harness_shared.session_turns IN ACCESS EXCLUSIVE MODE');
      return {
        direct: await retrieveSessionTurnExact(sql, { workspaceId: WS, query: 'furnishedfinder' }, tight),
        tiers: await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnisedfinder' }, { policy: tight }),
      };
    });
    // WI-10005294 (D-015): a deadline now carries an honest `partial` marker. Here the corpus is locked
    // for the whole budget, so no recency slice ever completes → `completeSince: null` (nothing proven complete).
    expect(blocked.direct).toEqual({ hits: [], deadline: true, partial: { completeSince: null } });
    expect(blocked.tiers.exact).toEqual([]);
    expect(blocked.tiers.receipt.exact.status).toBe('deadline');
    expect(blocked.tiers.receipt.fuzzy.status).toBe('deadline');

    const after = await retrieveSessionTurnLiteralTiers(sql, { workspaceId: WS, query: 'furnishedfinder' });
    expect(after.receipt.exact.status).toBe('ran');
    expect(keys(after.exact)).toEqual(['dl:0']);
  }, 90_000);
});
