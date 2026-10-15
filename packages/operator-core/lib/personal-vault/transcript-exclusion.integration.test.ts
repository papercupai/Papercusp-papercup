/**
 * Transcript exclusion against real Postgres (WI-10005552, plan
 * personal-data-reader-set-labels-2026-10-01 P-013, D-006 point 3, D-009, BAR R-9).
 *
 * A turn agent A recorded inside one of its disclosure windows
 * [delivered_at, released_at) is withheld from every caller but A; an
 * unattributed turn inside ANY other agent's window is withheld too. This suite
 * drives the real sessions:read and sessions:search handlers through projected
 * dispatch on the migrated throwaway database and asserts:
 *
 *  - the SQL rule (restrictedTurnSql) and the TypeScript rule
 *    (TranscriptExclusion.withholds) agree on every fixture turn, window
 *    boundaries included;
 *  - a withheld turn's text never reaches another caller, by read, verbatim or
 *    hybrid search, a context window, or the tool-part caveat;
 *  - the withheld count a search reports does not depend on the query (D-009):
 *    a query that matches only a restricted turn and a query that matches
 *    nothing report the same receipt;
 *  - the recording agent still sees its own turns, and an unreadable ledger
 *    refuses the read instead of serving it unfiltered.
 *
 * Seams pinned: the feature gate, the live-transcript refresh, the archive
 * fall-through, filter resolution and the query embedder (none of them decide
 * exclusion). Consult routing is covered in consult/relevance-router.integration.test.ts.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const WS = 'transcript-excl-test';
// Session-shaped, so sessions:timeline accepts it as a full ownerId without a presence row.
const PEER = 'su-7e570000-0000-4000-8000-00000000beef';
const READER = 'su-tx-reader';
const OTHER = 'su-tx-other';
const SECRET = 'zebracopper: Alice says the merger closes Friday';
const TOOL_ONLY = 'toolonlyquasar';

// The peer's disclosure window is [T1, T3).
const T0 = '2026-01-01T00:30:00Z';
const T1 = '2026-01-01T01:00:00Z';
const T2 = '2026-01-01T02:00:00Z';
const T3 = '2026-01-01T03:00:00Z';
const T4 = '2026-01-01T04:00:00Z';

// WI-10005570: a second workspace holds the fixture for the remaining readers, so
// the counts the suites above assert over WS are untouched. The peer's window
// (the ledger is not workspace-scoped) covers p2-sess turns 2 and 3.
const WS2 = 'transcript-excl-test-2';
const P2 = 'p2-sess';

vi.mock('../agent-tools/sessions/_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshTargetSessionBeforeRead: vi.fn(async () => ({ attempted: 0, refreshed: 0 })),
  refreshLiveSessionsBeforeRead: vi.fn(async () => ({ attempted: 0, refreshed: 0 })),
}));
vi.mock('../agent-tools/search/filters', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSearchFilters: vi.fn(async () => ({ filters: undefined, selfSession: null })),
}));
vi.mock('../session-archive-read', () => ({ readArchivedSessionTurns: vi.fn(async () => null) }));
// The caller identity is the coordination ownerId; tests name it as uiClientId.
vi.mock('../agent-tools/coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentIdentity: (ctx: { uiClientId?: string | null }) => ({ ownerId: ctx?.uiClientId ?? null, ownerLabel: 'test' }),
}));
// No embedding service here: hybrid search runs its lexical leg only.
vi.mock('../agent-tools/search/embedder', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildQueryEmbedder: vi.fn(async () => null),
}));
// Readers that open their own connection (plans:revision-transcript's index read,
// the fact-provenance loader) run against the throwaway database.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withWorkspace: (_ws: string, cb: (tx: unknown) => Promise<unknown>) => sql.begin(cb as never),
  getOrgPg: () => ({ sql }),
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const {
  loadTranscriptExclusion,
  restrictedTurnSql,
  countRestrictedTurnsInScope,
  D006_TRANSCRIPT_RULE,
} = await import('./transcript-exclusion');
await import('../agent-tools/sessions/read');
await import('../agent-tools/sessions/search');
await import('../agent-tools/sessions/digest');
await import('../agent-tools/sessions/timeline');
const { SEARCH_SOURCES } = await import('../agent-tools/search/sources');
const { retrieveSessionTurnExact } = await import('../agent-tools/search/session-turn-literal');
const { readAgentSessionTranscript } = await import('../agent-tools/plans/revision-session-transcript');
const { resolveFactSourceProvenance } = await import('../agent-tools/facts/source-provenance-resolve');
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
type OrgTestDb = import('../../test/_org-test-db').OrgTestDb;

let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'transcript-excl-' + Date.now()}, 'Transcript Exclusion')
    RETURNING id`;
  userId = user.id;
  await sql`
    INSERT INTO harness_shared.personal_disclosures
      (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set,
       delivered_via, delivered_at, released_at, released_by, release_ref)
    VALUES (${WS}, ${userId}::uuid, ${PEER}, gen_random_uuid(), 'gmail', 'participants',
            ${['owner@me.example']}::text[], 'personal:search', ${T1}::timestamptz,
            ${T3}::timestamptz, 'owner', 'test-release')`;
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
    VALUES
      (${WS}, 'claude', 'peer-sess', 0, ${T0}::timestamptz, ${PEER}, 'assistant', 'alpha public preface'),
      (${WS}, 'claude', 'peer-sess', 1, ${T1}::timestamptz, ${PEER}, 'assistant', 'boundary start note'),
      (${WS}, 'claude', 'peer-sess', 2, ${T2}::timestamptz, ${PEER}, 'assistant', ${'alpha ' + SECRET}),
      (${WS}, 'claude', 'peer-sess', 3, ${T3}::timestamptz, ${PEER}, 'assistant', 'alpha after release'),
      (${WS}, 'claude', 'other-sess', 0, ${T2}::timestamptz, ${OTHER}, 'assistant', 'alpha other agent'),
      (${WS}, 'claude', 'orphan-sess', 0, ${T2}::timestamptz, NULL, 'assistant', 'alpha orphan line')`;
  await sql`
    INSERT INTO harness_shared.session_turn_parts
      (workspace_id, source_kind, session_id, part_idx, ts, owner, speaker, part_kind, tool_name, text)
    VALUES (${WS}, 'claude', 'peer-sess', 5, ${T2}::timestamptz, ${PEER}, 'assistant', 'tool_result', 'Bash',
            ${'output: ' + TOOL_ONLY})`;
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text, turn_origin_verdict)
    VALUES
      (${WS2}, 'claude', ${P2}, 0, ${T0}::timestamptz, ${PEER}, 'user', 'beta kickoff public', 'owner-typed'),
      (${WS2}, 'claude', ${P2}, 1, ${T0}::timestamptz, ${PEER}, 'assistant', 'beta first answer public', NULL),
      (${WS2}, 'claude', ${P2}, 2, ${T2}::timestamptz, ${PEER}, 'user', ${'beta question ' + SECRET}, 'owner-typed'),
      (${WS2}, 'claude', ${P2}, 3, ${T2}::timestamptz, ${PEER}, 'assistant', ${'beta closing ' + SECRET}, NULL)`;
}, 120_000);

afterAll(async () => {
  if (org && userId) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

function ctxFor(caller: string, workspaceId: string = WS) {
  return {
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    workspaceId, uiClientId: caller, isSuperuser: true,
    runId: `transcript-exclusion-${caller}`, role: 'operator',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    tx: sql,
  } as never;
}

type ToolName = 'sessions:read' | 'sessions:search' | 'sessions:digest' | 'sessions:timeline';

async function dispatch(tool: ToolName, caller: string, args: Record<string, unknown>, workspaceId: string = WS) {
  return dispatchProjectedTool(lookupByMcpName(tool)!, tool, args, ctxFor(caller, workspaceId), {});
}

/** The whole structured result of a WS2 call, as text — the leak check reads every field. */
async function ws2Body(tool: ToolName, caller: string, args: Record<string, unknown>): Promise<string> {
  const result = await dispatch(tool, caller, args, WS2);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return JSON.stringify(result.result!.structuredContent);
}

interface Receipt { restricted_turns: number; unattributed_turns?: number; rule: string; [k: string]: number | string | undefined }
interface ReadOut { ok: boolean; turn_count: number; turns: Array<{ turn_idx: number; text: string }>; withheld?: Receipt }
interface SearchOut {
  ok: boolean;
  total_hits: number;
  hint?: string;
  results: Array<{ ref?: string; excerpt?: string }>;
  withheld?: Receipt;
}

async function call<T>(tool: 'sessions:read' | 'sessions:search', caller: string, args: Record<string, unknown>): Promise<T> {
  const result = await dispatch(tool, caller, args);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.result!.structuredContent as unknown as T;
}

/** `session_id:turn_idx` of every fixture turn the SQL rule withholds from `caller`. */
async function sqlWithheld(caller: string): Promise<string[]> {
  const rows = await sql<Array<{ key: string }>>`
    SELECT st.session_id || ':' || st.turn_idx AS key
      FROM harness_shared.session_turns st
     WHERE st.workspace_id = ${WS} AND ${restrictedTurnSql(sql, 'st', [caller])}
     ORDER BY 1`;
  return rows.map((r) => r.key);
}

describe('D-006 transcript rule — SQL and TypeScript agree', () => {
  it('withholds the peer’s in-window turns and the unattributed in-window turn from another reader, boundaries included', async () => {
    // [T1, T3): the turn AT delivered_at is in, the turn AT released_at is out.
    expect(await sqlWithheld(READER)).toEqual(['orphan-sess:0', 'peer-sess:1', 'peer-sess:2']);
    // The recording agent sees its own turns; no OTHER agent's window covers the orphan.
    expect(await sqlWithheld(PEER)).toEqual([]);
  });

  it.each([READER, PEER, OTHER])('restrictedTurnSql matches TranscriptExclusion.withholds for caller %s', async (caller) => {
    const rows = await sql<Array<{ owner: string | null; at: Date; withheld: boolean }>>`
      SELECT st.owner, COALESCE(st.ts, st.ingested_at) AS at,
             ${restrictedTurnSql(sql, 'st', [caller])} AS withheld
        FROM harness_shared.session_turns st
       WHERE st.workspace_id = ${WS}`;
    expect(rows.length).toBe(6);
    const exclusion = await loadTranscriptExclusion(sql, {
      selfOwnerIds: [caller],
      stamps: rows.map((r) => ({ owner: r.owner, at: r.at })),
    });
    for (const row of rows) {
      expect(exclusion.withholds({ owner: row.owner, at: row.at }) !== null, JSON.stringify(row)).toBe(row.withheld);
    }
  });

  it('countRestrictedTurnsInScope counts both reasons, and nothing for the recording agent', async () => {
    const scope = sql`st.workspace_id = ${WS}`;
    expect(await countRestrictedTurnsInScope(sql, { selfOwnerIds: [READER], scope })).toEqual({
      turns: 3,
      byReason: { 'disclosure-window': 2, unattributed: 1 },
    });
    expect((await countRestrictedTurnsInScope(sql, { selfOwnerIds: [PEER], scope })).turns).toBe(0);
  });
});

describe('sessions:read', () => {
  it('serves another reader only the turns outside the window and counts the rest', async () => {
    const out = await call<ReadOut>('sessions:read', READER, { session: 'peer-sess', source_kind: 'claude' });
    expect(out.turns.map((t) => t.turn_idx)).toEqual([0, 3]);
    expect(out.withheld).toMatchObject({ restricted_turns: 2, rule: D006_TRANSCRIPT_RULE });
    expect(JSON.stringify(out)).not.toContain('zebracopper');
    expect(JSON.stringify(out)).not.toContain('boundary start');
  });

  it('serves the recording agent its whole transcript', async () => {
    const out = await call<ReadOut>('sessions:read', PEER, { session: 'peer-sess', source_kind: 'claude' });
    expect(out.turns.map((t) => t.turn_idx)).toEqual([0, 1, 2, 3]);
    expect(out.withheld).toBeUndefined();
  });
});

describe('sessions:search', () => {
  it('a query that matches only a restricted turn and a query that matches nothing report the same receipt (no oracle)', async () => {
    const onlySecret = await call<SearchOut>('sessions:search', READER, { query: 'zebracopper', mode: 'verbatim', context: 0 });
    const nothing = await call<SearchOut>('sessions:search', READER, { query: 'nomatchxylophage', mode: 'verbatim', context: 0 });
    expect(onlySecret.total_hits).toBe(0);
    expect(nothing.total_hits).toBe(0);
    expect(onlySecret.withheld).toMatchObject({ restricted_turns: 3, unattributed_turns: 1, in_search_scope: 3 });
    expect(nothing.withheld).toEqual(onlySecret.withheld);
    expect(JSON.stringify(onlySecret)).not.toContain('merger');
  });

  it('a broad verbatim query returns every visible match and none of the withheld ones', async () => {
    const out = await call<SearchOut>('sessions:search', READER, { query: 'alpha', mode: 'verbatim', context: 0 });
    expect(out.total_hits).toBe(3);
    const body = JSON.stringify(out.results);
    expect(body).toContain('alpha public preface');
    expect(body).toContain('alpha after release');
    expect(body).toContain('alpha other agent');
    expect(body).not.toContain('zebracopper');
    expect(body).not.toContain('alpha orphan line');
    expect(out.withheld?.in_search_scope).toBe(3);
  });

  it('the recording agent finds its own restricted turn', async () => {
    const out = await call<SearchOut>('sessions:search', PEER, { query: 'zebracopper', mode: 'verbatim', context: 0 });
    expect(out.total_hits).toBe(1);
    expect(JSON.stringify(out.results)).toContain('zebracopper');
    expect(out.withheld).toBeUndefined();
  });

  it('a context window around a visible hit drops the restricted neighbour and counts it', async () => {
    const out = await call<SearchOut>('sessions:search', READER, { query: 'preface', mode: 'verbatim', context: 1 });
    expect(out.total_hits).toBe(1);
    expect(JSON.stringify(out)).not.toContain('boundary start');
    expect(out.withheld).toMatchObject({ from_context_windows: 1 });
  });

  it('the tool-part caveat does not count another agent’s restricted tool output', async () => {
    const reader = await call<SearchOut>('sessions:search', READER, { query: TOOL_ONLY, mode: 'verbatim', context: 0 });
    expect(reader.total_hits).toBe(0);
    expect(JSON.stringify(reader)).not.toContain('FOUND, JUST NOT IN A TEXT TURN');
    // Control: the recording agent is told the string sits in a tool part.
    const peer = await call<SearchOut>('sessions:search', PEER, { query: TOOL_ONLY, mode: 'verbatim', context: 0 });
    expect(JSON.stringify(peer)).toContain('FOUND, JUST NOT IN A TEXT TURN');
  });

  it('hybrid search excludes the restricted turn inside the query', async () => {
    // Control first: the lexical leg does find the turn for its recording agent.
    const peer = await call<SearchOut>('sessions:search', PEER, { query: 'zebracopper', mode: 'hybrid', context: 0 });
    expect(JSON.stringify(peer.results)).toContain('zebracopper');
    const reader = await call<SearchOut>('sessions:search', READER, { query: 'zebracopper', mode: 'hybrid', context: 0 });
    expect(JSON.stringify(reader.results)).not.toContain('zebracopper');
    expect(reader.withheld?.in_search_scope).toBe(3);
  });
});

// ───────────── the remaining session_turns readers (WI-10005570) ─────────────

describe('TranscriptExclusion.withholdsSpan (a whole-session decision, query-independent)', () => {
  it('withholds a span that overlaps the owner’s window, open bounds included, and never the caller’s own', async () => {
    const forReader = await loadTranscriptExclusion(sql, {
      selfOwnerIds: [READER],
      stamps: [{ owner: PEER, at: null }, { owner: null, at: null }],
    });
    expect(forReader.withholdsSpan({ owner: PEER, from: T0, to: T0 })).toBeNull();
    expect(forReader.withholdsSpan({ owner: PEER, from: T0, to: T2 })).toBe('disclosure-window');
    expect(forReader.withholdsSpan({ owner: PEER, from: T1, to: T1 })).toBe('disclosure-window');
    // released_at is exclusive: a span that starts at it does not overlap.
    expect(forReader.withholdsSpan({ owner: PEER, from: T3, to: T4 })).toBeNull();
    // An unknown bound is open, so the span is withheld (fail closed).
    expect(forReader.withholdsSpan({ owner: PEER, from: null, to: null })).toBe('disclosure-window');
    expect(forReader.withholdsSpan({ owner: PEER, from: T0, to: undefined })).toBe('disclosure-window');
    expect(forReader.withholdsSpan({ owner: null, from: T2, to: T2 })).toBe('unattributed');
    expect(forReader.withholdsSpan({ owner: OTHER, from: T0, to: T4 })).toBeNull();

    const forPeer = await loadTranscriptExclusion(sql, {
      selfOwnerIds: [PEER],
      stamps: [{ owner: PEER, at: null }, { owner: null, at: null }],
    });
    expect(forPeer.withholdsSpan({ owner: PEER, from: null, to: null })).toBeNull();
    // The peer's own window does not withhold an unattributed span from the peer.
    expect(forPeer.withholdsSpan({ owner: null, from: T2, to: T2 })).toBeNull();
  });
});

describe('search:semantic / search:fulltext session_turn source', () => {
  const sessionTurn = () => SEARCH_SOURCES.find((s) => s.name === 'session_turn')!;
  const params = (filters?: Record<string, unknown>) => ({
    sql,
    query: 'zebracopper',
    workspaceId: WS2,
    scopeFilter: null,
    limit: 20,
    embeddingProfile: { profileId: 'gemma-embeddinggemma-300m-768@v1', legacyMode: 'gemma' },
    ...(filters ? { filters } : {}),
  }) as never;

  it('a caller that names no reader is treated as nobody: every restricted turn is excluded (fail closed)', async () => {
    const out = JSON.stringify(await sessionTurn().lexical(params()));
    expect(out).not.toContain(P2);
    expect(out).not.toContain('merger');
  });

  it('the recording agent, named as reader, still finds its own turn (control)', async () => {
    expect(JSON.stringify(await sessionTurn().lexical(params({ readerIds: [PEER] })))).toContain(P2);
    expect(JSON.stringify(await sessionTurn().lexical(params({ readerIds: [READER] })))).not.toContain(P2);
  });
});

describe('session-turn literal tier', () => {
  it('excludes another agent’s restricted turn, with or without readerIds, and keeps the recorder’s own', async () => {
    const q = (filters: Record<string, unknown>) => ({ workspaceId: WS2, query: 'zebracopper', filters }) as never;
    expect((await retrieveSessionTurnExact(sql, q({}))).hits).toEqual([]);
    expect((await retrieveSessionTurnExact(sql, q({ readerIds: [READER] }))).hits).toEqual([]);
    const own = await retrieveSessionTurnExact(sql, q({ readerIds: [PEER] }));
    expect(own.hits.length).toBe(2);
    expect(JSON.stringify(own.hits)).toContain(P2);
  });
});

describe('sessions:digest', () => {
  it('another caller’s digest counts and quotes only the turns outside the window', async () => {
    const body = await ws2Body('sessions:digest', READER, { session: P2, source_kind: 'claude' });
    expect(body).toContain('"turns":2');
    expect(body).toContain('beta first answer public');
    expect(body).not.toContain('zebracopper');
  });

  it('the recording agent’s digest covers the whole session (control)', async () => {
    const body = await ws2Body('sessions:digest', PEER, { session: P2, source_kind: 'claude' });
    expect(body).toContain('"turns":4');
    expect(body).toContain('zebracopper');
  });
});

describe('sessions:timeline', () => {
  const args = { owner: PEER, since: '2025-12-31T23:00:00Z', until: T4 };

  it('another caller sees the peer’s turns outside the window and none inside it', async () => {
    const body = await ws2Body('sessions:timeline', READER, args);
    expect(body).toContain('beta kickoff public');
    expect(body).not.toContain('zebracopper');
  });

  it('the recording agent sees its whole timeline (control)', async () => {
    expect(await ws2Body('sessions:timeline', PEER, { ...args, owner: 'self' })).toContain('zebracopper');
  });
});

describe('plans:revision-transcript index read (readAgentSessionTranscript)', () => {
  it('another caller gets the turns outside the window and a whole-session withheld count', async () => {
    const page = await readAgentSessionTranscript(WS2, 'claude', P2, {}, [READER]);
    expect(page.turns.map((t) => t.seq)).toEqual([0, 1]);
    expect(JSON.stringify(page)).not.toContain('zebracopper');
    expect(page).toMatchObject({ withheld: { restricted_turns: 2 } });
  });

  it('no reader ids fails closed, and a query that matches only a withheld turn returns what a no-match query does', async () => {
    const anonymous = await readAgentSessionTranscript(WS2, 'claude', P2, {}, []);
    expect(anonymous.turns.map((t) => t.seq)).toEqual([0, 1]);
    const onlySecret = await readAgentSessionTranscript(WS2, 'claude', P2, { query: 'zebracopper' }, [READER]);
    const nothing = await readAgentSessionTranscript(WS2, 'claude', P2, { query: 'nomatchxylophage' }, [READER]);
    expect(onlySecret).toEqual(nothing);
  });

  it('the recording agent reads its whole session (control)', async () => {
    const page = await readAgentSessionTranscript(WS2, 'claude', P2, {}, [PEER]);
    expect(page.turns.map((t) => t.seq)).toEqual([0, 1, 2, 3]);
  });
});

describe('fact source provenance (a turn quoted into a fact)', () => {
  const ref = `session_turn:claude:${P2}:2`;

  it('a withheld turn resolves as absent for another asserter, so its text is never quoted', async () => {
    const out = await resolveFactSourceProvenance({ ownerId: READER, workspaceId: WS2 } as never, ref);
    expect(out).toMatchObject({ verified: false, error: 'not_found' });
    expect(JSON.stringify(out)).not.toContain('zebracopper');
  });

  it('the recording agent resolves and quotes its own turn (control)', async () => {
    const out = await resolveFactSourceProvenance({ ownerId: PEER, workspaceId: WS2 } as never, ref);
    expect(out).toMatchObject({ verified: true });
    expect(JSON.stringify(out)).toContain('zebracopper');
  });
});

describe('an unreadable ledger refuses the read', () => {
  it('sessions:search and sessions:read refuse rather than serve unfiltered', async () => {
    await sql.unsafe('ALTER TABLE harness_shared.personal_disclosures RENAME TO personal_disclosures_gone');
    try {
      const search = await dispatch('sessions:search', READER, { query: 'alpha', mode: 'verbatim', context: 0 });
      expect(JSON.stringify(search)).toContain('disclosure_ledger_unavailable');
      expect(JSON.stringify(search)).not.toContain('alpha public preface');
      const read = await dispatch('sessions:read', READER, { session: 'peer-sess', source_kind: 'claude' });
      expect(JSON.stringify(read)).toContain('disclosure_ledger_unavailable');
      expect(JSON.stringify(read)).not.toContain('alpha public preface');
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.personal_disclosures_gone RENAME TO personal_disclosures');
    }
  });
});
