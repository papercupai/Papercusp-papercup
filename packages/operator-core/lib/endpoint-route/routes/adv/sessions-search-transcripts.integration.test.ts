/**
 * Route-level real-Postgres coverage for GET /adv/sessions/search-transcripts — the ONE shared
 * endpoint behind every owner-facing transcript search (plan
 * session-transcript-exact-fuzzy-search-2026-09-14 P-004; SPEC-P004-OWNER-SEARCH-PARITY /
 * VAL-P004-OWNER-SEARCH-PARITY).
 *
 * The three consumers differ only in the query string they send:
 *   - agents-running pill (AgentsPillSessions.tsx): `?q=&limit=30[&since=]`
 *   - HUD board (hud-board-model.ts):                `?q=&limit=100`
 *   - plan Sessions tab (PlanSessionsTab.tsx):       `?q=&plan=<slug>&limit=30`
 * so driving the real handler with each consumer's exact URL shape proves parity at the layer they
 * share. Real: the route handler, the real session_turns DDL (M501 + M794 + M1273), the real
 * deferred index/vocab build, the real exact + fuzzy retrieval SQL, `composeSessionTurnTiers`,
 * `ownerVisiblePage`, `groupHitsBySession`, `classifySessionGroups`. Stubbed (each one is a
 * collaborator whose own behaviour is covered elsewhere and which has no place in a unit
 * environment): the org PG accessor (pointed at this test's throwaway DB), the hybrid engine
 * (returns nothing — the premise of the regression is that the tokenized leg CANNOT reach
 * `furnishedfinder` inside `www.furnishedfinder.com`, so the literal tiers must carry it alone), the
 * reranker, the roster, the query-embedder warmup, and the plan→owners lookup.
 *
 * Test names starting "Agents-running endpoint regression", "HUD shared-endpoint regression" and
 * "Owner-visibility and scope-filter regression" are the VAL-P004-OWNER-SEARCH-PARITY evidence
 * names — keep them verbatim.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { applyDisclosureLedgerForTest, applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { runSessionSearchIndexBuildOnce } from '../../../session-search-index-build';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  active: [] as unknown[],
  planSessions: [] as Array<{ coordOwnerId: string | null }>,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('@papercusp/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/search')>();
  return { ...actual, runHybridSearch: async () => ({ results: [] }) };
});
vi.mock('../../../agent-tools/search/rerank', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../agent-tools/search/rerank')>();
  return { ...actual, rerankPageHead: async (_q: string, results: unknown[]) => results };
});
vi.mock('../../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../workspace-registry')>();
  return { ...actual, activeWorkspaceId: () => 'w-route' };
});
vi.mock('../../../adv-roster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../adv-roster')>();
  return {
    ...actual,
    mergeRosterWithAssignments: async () => ({ active: h.active }),
    resolveThinkingForEntries: async () => {},
  };
});
vi.mock('../../../adv-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../adv-sessions')>();
  return {
    ...actual,
    advSessionsByTranscriptHandles: async () => [],
    advSessionsByIdToken: async () => [],
    listPlanSessions: async () => h.planSessions,
  };
});
vi.mock('../../../search/query-embedder-warmup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../search/query-embedder-warmup')>();
  return { ...actual, createQueryEmbedderWarmup: () => ({ select: () => ({ embedder: undefined }) }) };
});

import routes from './sessions';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../../../../libs/papercusp/libs/db/sql');
const M501 = path.join(SQL_DIR, '501-session-turns.sql');
const M794 = path.join(SQL_DIR, '794-session-turns-provenance-at-ingest.sql');
const M1273 = path.join(SQL_DIR, '1273-session-turns-trigram-exact-fuzzy-index.sql');
const WS = 'w-route';

const route = (routes as Array<{ path?: string; handler: (req: Request, ctx: unknown) => Promise<Response> }>).find(
  (r) => r.path === '/adv/sessions/search-transcripts',
);
if (!route) throw new Error('search-transcripts route not registered');

interface WireHit {
  turnIdx: number;
  tier?: string;
  excerpt: string;
  highlight: string;
  focusTerm?: string;
  fuzzy?: { token: string; word: string; similarity: number };
}
interface WireSession {
  sourceKind: string;
  sessionId: string;
  active: unknown;
  hits: WireHit[];
}
interface SearchBody {
  ok: boolean;
  query: string;
  plan?: string;
  totalHits?: number;
  hiddenMachineHits?: { count: number; truncatedByLimit: boolean };
  _tiers?: {
    exact: { status: string; error?: string };
    fuzzy: { status: string; error?: string };
  };
  sessions: WireSession[];
}

async function search(qs: string): Promise<SearchBody> {
  const res = await route!.handler(new Request(`http://localhost/adv/sessions/search-transcripts?${qs}`), {
    signal: new AbortController().signal,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SearchBody;
}
const ids = (b: SearchBody): string[] => b.sessions.map((s) => s.sessionId);

const MACHINE_ENVELOPE = '⟦turn-origin:loop-fire nonce:0123456789abcdef⟧ ';

let db: FreshPgDb;
let sql: postgres.Sql;

interface SeedRow {
  ws?: string;
  sid: string;
  idx?: number;
  owner: string;
  text: string;
  ts: string;
}
async function seed(r: SeedRow): Promise<void> {
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, speaker, owner, text, ts, ingested_at)
    VALUES (${r.ws ?? WS}, 'claude', ${r.sid}, ${r.idx ?? 0}, 'user', ${r.owner}, ${r.text},
            ${r.ts}::timestamptz, ${r.ts}::timestamptz)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('sess-search-route');
  sql = db.sql;
  h.sql = sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`);
  await applyMigrationForTest(sql, M501);
  await applyMigrationForTest(sql, M794);
  await applyMigrationForTest(sql, M1273);
  await applyDisclosureLedgerForTest(sql);

  // The target: the literal sits INSIDE a URL lexeme — unreachable by the tokenized hybrid leg.
  await seed({
    sid: 'sess-target', owner: 'su-target', ts: '2026-09-20T10:00:00Z',
    text: 'check https://www.furnishedfinder.com/listing for the unit',
  });
  // A live (roster-active) session whose turn holds the bare word — also the fuzzy-typo target.
  await seed({
    sid: 'sess-active', owner: 'su-live', ts: '2026-09-21T10:00:00Z',
    text: 'I signed up at furnishedfinder yesterday',
  });
  // The spaced spelling the owner actually types.
  await seed({
    sid: 'sess-spaced', owner: 'su-spaced', ts: '2026-09-22T10:00:00Z',
    text: 'we listed the apartment on Furnished Finder last week',
  });
  // Older than the `since` window.
  await seed({
    sid: 'sess-old', owner: 'su-old', ts: '2020-01-01T00:00:00Z',
    text: 'ancient note about furnishedfinder from years ago',
  });
  // Machine-authored `user` turn: never part of the owner's conversation.
  await seed({
    sid: 'sess-machine', owner: 'su-machine', ts: '2026-09-23T10:00:00Z',
    text: `${MACHINE_ENVELOPE}LIVE RE-CHECK furnishedfinder deploy status`,
  });
  // A different workspace entirely.
  await seed({
    ws: 'w-other', sid: 'sess-other-ws', owner: 'su-other', ts: '2026-09-24T10:00:00Z',
    text: 'furnishedfinder in someone else workspace',
  });

  const built = await runSessionSearchIndexBuildOnce(sql, { minFreeDiskBytes: 0 });
  expect([...built.indexes, ...built.vocab].filter((e) => e.action === 'failed'), 'no build step may fail').toEqual([]);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

/** Rows excluded by a filter must never appear, whichever consumer is asking. */
const NEVER_VISIBLE = ['sess-other-ws', 'sess-machine'];

describe('route search-transcripts — disclosure ledger fixture controls', () => {
  it('fails closed with explicit tier errors when the ledger is absent, then retrieves after it is restored', async () => {
    h.active = [];
    h.planSessions = [];
    await sql.unsafe('ALTER TABLE harness_shared.personal_disclosures RENAME TO personal_disclosures_fixture_unavailable');
    try {
      const missing = await search('q=furnishedfinder&limit=30');
      expect(missing.sessions).toEqual([]);
      for (const tier of [missing._tiers?.exact, missing._tiers?.fuzzy]) {
        expect(tier).toMatchObject({ status: 'error' });
        expect(tier?.error).toContain('personal_disclosures');
      }
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.personal_disclosures_fixture_unavailable RENAME TO personal_disclosures');
    }
    const restored = await search('q=furnishedfinder&limit=30');
    expect(restored._tiers?.exact.status).toBe('ran');
    expect(restored._tiers?.fuzzy.status).toBe('ran');
    expect(ids(restored)).toContain('sess-target');
  }, 60_000);

  it('withholds a turn inside an active disclosure window and retrieves it again after fixture cleanup', async () => {
    h.active = [];
    h.planSessions = [];
    const [user] = await sql<Array<{ id: string }>>`INSERT INTO harness_shared.users DEFAULT VALUES RETURNING id`;
    try {
      await seed({ sid: 'sess-disclosed', owner: 'su-disclosed', ts: '2026-09-25T10:00:00Z', text: 'furnishedfinder inside a disclosure window' });
      expect(ids(await search('q=furnishedfinder&limit=30'))).toContain('sess-disclosed');
      await sql`
        INSERT INTO harness_shared.personal_disclosures
          (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set, delivered_via, delivered_at)
        VALUES (${WS}, ${user!.id}, 'su-disclosed', gen_random_uuid(), 'fixture', 'sender-only',
                ARRAY['sender@example.test'], 'fixture', '2026-09-25T09:00:00Z'::timestamptz)`;
      for (const query of ['q=furnishedfinder', 'q=furnisedfinder']) {
        const restricted = await search(`${query}&limit=30&includeMachineTurns=1`);
        expect(ids(restricted)).not.toContain('sess-disclosed');
        expect(ids(restricted)).toContain('sess-active');
      }
      await sql`DELETE FROM harness_shared.personal_disclosures WHERE user_id = ${user!.id}`;
      expect(ids(await search('q=furnishedfinder&limit=30'))).toContain('sess-disclosed');
    } finally {
      await sql`DELETE FROM harness_shared.session_turns WHERE session_id = 'sess-disclosed'`;
      await sql`DELETE FROM harness_shared.users WHERE id = ${user!.id}`;
    }
  }, 60_000);
});

describe('route search-transcripts — every owner-facing consumer shows the target', () => {
  it('Agents-running endpoint regression: the pill query shape surfaces furnishedfinder sessions, active first, exact tier', async () => {
    h.active = [{ sessionId: 'sess-active', ownerId: 'su-live' }];
    h.planSessions = [];
    const body = await search('q=furnishedfinder&limit=30');

    expect(body.ok).toBe(true);
    expect(body.query).toBe('furnishedfinder');
    // The literal inside the URL lexeme is found even though the (stubbed-empty) hybrid leg
    // contributes nothing — the exact tier carries it.
    const target = body.sessions.find((s) => s.sessionId === 'sess-target');
    expect(target, 'target session must be shown').toBeDefined();
    expect(target!.hits[0]!.tier).toBe('exact');
    expect(target!.hits[0]!.excerpt).toContain('furnishedfinder');
    expect(target!.hits[0]!.highlight).toContain('<mark>furnishedfinder</mark>');
    expect(target!.active).toBeNull();
    // Active/inactive classification is preserved: a roster-matched session leads the inactive ones.
    expect(body.sessions[0]!.sessionId).toBe('sess-active');
    expect(body.sessions[0]!.active).not.toBeNull();
    for (const bad of NEVER_VISIBLE) expect(ids(body)).not.toContain(bad);
    // The pill's optional `since` window rides on the same endpoint and drops the 2020 row.
    const windowed = await search('q=furnishedfinder&limit=30&since=2026-01-01T00:00:00Z');
    expect(ids(windowed)).toContain('sess-target');
    expect(ids(windowed)).not.toContain('sess-old');
    expect(ids(body)).toContain('sess-old');
  }, 60_000);

  it('Agents-running endpoint regression: a one-letter typo still reaches the session, labelled fuzzy with what it expanded to', async () => {
    h.active = [];
    const body = await search('q=furnisedfinder&limit=30');
    const typo = body.sessions.find((s) => s.sessionId === 'sess-active');
    expect(typo, 'the bare-word session must be found through the vocabulary expansion').toBeDefined();
    expect(typo!.hits[0]!.tier).toBe('fuzzy');
    expect(typo!.hits[0]!.fuzzy).toMatchObject({ token: 'furnisedfinder', word: 'furnishedfinder' });
    for (const bad of NEVER_VISIBLE) expect(ids(body)).not.toContain(bad);
  }, 60_000);

  it('HUD shared-endpoint regression: the HUD query shape (limit=100) shows the target and the spaced "Furnished Finder" spelling', async () => {
    h.active = [];
    h.planSessions = [];
    const bare = await search('q=furnishedfinder&limit=100');
    expect(ids(bare)).toEqual(expect.arrayContaining(['sess-target', 'sess-active', 'sess-old']));
    expect(bare.sessions.find((s) => s.sessionId === 'sess-target')!.hits[0]!.tier).toBe('exact');

    const spaced = await search('q=Furnished%20Finder&limit=100');
    expect(ids(spaced)).toContain('sess-spaced');
    expect(spaced.sessions.find((s) => s.sessionId === 'sess-spaced')!.hits[0]!.tier).toBe('exact');

    for (const body of [bare, spaced]) for (const bad of NEVER_VISIBLE) expect(ids(body)).not.toContain(bad);
  }, 60_000);
});

describe('route search-transcripts — visibility and scope filters hold for the new tiers', () => {
  it('Owner-visibility and scope-filter regression: a machine-authored turn is hidden (and disclosed), and is only returned on the explicit opt-in', async () => {
    h.active = [];
    h.planSessions = [];
    const owner = await search('q=furnishedfinder&limit=30');
    expect(ids(owner)).not.toContain('sess-machine');
    expect(owner.hiddenMachineHits).toMatchObject({ count: 1 });

    // Control: the SAME retrieval with the opt-in returns it — so the owner-facing filter, not a
    // retrieval gap, is what removed it.
    const opted = await search('q=furnishedfinder&limit=30&includeMachineTurns=1');
    expect(ids(opted)).toContain('sess-machine');
    expect(opted.hiddenMachineHits).toMatchObject({ count: 0 });
  }, 60_000);

  it('Owner-visibility and scope-filter regression: workspace isolation — another workspace\'s turn never appears on either tier', async () => {
    h.active = [];
    h.planSessions = [];
    for (const q of ['q=furnishedfinder', 'q=furnisedfinder', 'q=Furnished%20Finder']) {
      const body = await search(`${q}&limit=50&includeMachineTurns=1`);
      expect(ids(body), q).not.toContain('sess-other-ws');
    }
  }, 60_000);

  it('Owner-visibility and scope-filter regression: ?plan= scope narrows both literal tiers to the plan\'s owners, and an empty plan is an explicit zero', async () => {
    h.active = [];
    h.planSessions = [{ coordOwnerId: 'su-target' }];
    const exact = await search('q=furnishedfinder&limit=30&plan=plan-x');
    expect(ids(exact)).toEqual(['sess-target']);
    expect(exact.plan).toBe('plan-x');

    // The fuzzy tier honours the same scope: sess-active would match the typo but is not in the plan.
    const fuzzy = await search('q=furnisedfinder&limit=30&plan=plan-x');
    expect(ids(fuzzy)).not.toContain('sess-active');

    h.planSessions = [];
    const empty = await search('q=furnishedfinder&limit=30&plan=plan-empty');
    expect(empty).toMatchObject({ ok: true, plan: 'plan-empty', totalHits: 0, sessions: [] });
    expect(empty.hiddenMachineHits).toEqual({ count: 0, truncatedByLimit: false });
  }, 60_000);
});
