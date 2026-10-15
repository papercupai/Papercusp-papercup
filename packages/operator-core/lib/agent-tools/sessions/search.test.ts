/**
 * search.test.ts — EI-18877285731929394 regression.
 *
 * mode:'verbatim' is an exact, contiguous, case-insensitive substring match
 * (ILIKE) — by design, not a bug (confirmed live: a single literal word/quote
 * DOES match, and DOES span every session under session:'self' across a
 * carry-respawn — see WI-5644's filters.test.ts). But the compaction-recovery
 * doc's own example query is "<what you remember>", which reads as an
 * invitation to paraphrase — and a paraphrase silently returns 0 hits even
 * when the content exists. A 0-hit result then reads exactly like "it never
 * happened" instead of "your query wasn't a literal quote", which is what
 * misled an agent into telling the owner something false (the WI's own
 * incident). The fix: surface a fallback hint in the 0-hit verbatim response
 * itself, right where the false negative occurs.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/sessions/search.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import type { SearchLegs } from '@papercusp/search';

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-self', ownerLabel: 'su · self' })),
}));

const refreshLiveSessionsBeforeRead = vi.fn(async (..._args: unknown[]) => ({ attempted: 0, refreshed: 0 }));
const refreshTargetSessionBeforeRead = vi.fn(async (..._args: unknown[]) => ({ attempted: 1, refreshed: 1 }));
vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshLiveSessionsBeforeRead: (...a: unknown[]) => refreshLiveSessionsBeforeRead(...a),
  refreshTargetSessionBeforeRead: (...a: unknown[]) => refreshTargetSessionBeforeRead(...a),
}));

const resolveSelfSession = vi.fn();
vi.mock('../../search/self-session', () => ({
  resolveSelfSession: (...a: unknown[]) => resolveSelfSession(...a),
}));

vi.mock('../../search/session-ingest', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ingestFileNow: vi.fn(async () => undefined),
}));

// The verbatim tests below never reach the hybrid branch, but search.ts
// statically imports both — mock them inertly so the module loads without a
// live embedder/DB, and let the one hybrid test override the return value.
// `legs` is optional on the mock's return type so a case can install the engine's
// per-leg verdict (WI-10005676) with a genuinely typechecked fixture — no
// `as never` cast on the mock argument (lint:mock-cast-escape is shrink-only).
interface HybridSearchMockResult {
  results: Array<{
    source: string;
    source_id: string;
    excerpt: string;
    score: number;
    highlight?: string;
    rankers?: string[];
    scope?: string | null;
  }>;
  totalHits: number;
  embedderAvailable: boolean;
  legs?: SearchLegs;
}
const runHybridSearch = vi.fn(async (): Promise<HybridSearchMockResult> => ({ results: [], totalHits: 0, embedderAvailable: true }));
// `configureSearchDefaults` is NOT used by these tests — it is here because
// `search.ts` -> `../search/sources` side-effect-imports
// `lib/search/configure-search-defaults`, which CALLS it at module load (P-017).
// Keep it inert.
//
// This MUST stay a partial mock over `importOriginal`, never a hand-listed
// factory. A hand-listed factory replaces the module wholesale, so any export
// a transitively-imported module touches at load time becomes a
// collection-time crash ("No export is defined on the mock") that fails the
// file before a single test runs. It broke twice that way: first on
// `configureSearchDefaults`, then (WI-10004518) on `createEmbeddingSpace`,
// which `lib/search/prose-vector-dims.ts` calls at module scope. Spreading the
// real module means a new library export can never break collection again;
// only the two overrides below are faked.
vi.mock('@papercusp/search', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runHybridSearch: (...a: unknown[]) => runHybridSearch(...(a as [])),
  configureSearchDefaults: vi.fn(),
}));
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: vi.fn(async () => vi.fn()),
  interactiveEmbedAcquireBudgetMs: vi.fn(() => 1000),
}));

const searchModule = await import('./search');
const tool = searchModule.default;

const argsSchema = tool.args as {
  safeParse: (value: unknown) => { success: boolean };
};

interface ParsedResult {
  ok: boolean;
  mode: string;
  total_hits: number;
  hasMore: boolean;
  nextCursor?: string;
  hint?: string;
  zeroHitCaveat?: string;
  resultsTruncated?: { requested: number; returned: number; reason: string };
  coord_search?: { requested: boolean; applied: boolean; reason: string };
  results: unknown[];
}

/** Stand-in for ctx.tx used by the verbatim (raw ILIKE) branch. */
function makeTx(rows: unknown[]) {
  return vi.fn(async () => rows);
}

function callTool(args: Record<string, unknown>, tx: unknown, log?: (message: string) => void, metadata?: (value: Record<string, unknown>) => void) {
  return (
    tool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, { workspaceId: 'default', tx, log, metadata });
}

describe('sessions:search limit contract', () => {
  it('accepts a bounded page of 20 hits and rejects values above the advertised ceiling', () => {
    expect(argsSchema.safeParse({ query: 'needle', limit: 20 }).success).toBe(true);
    expect(argsSchema.safeParse({ query: 'needle', limit: 21 }).success).toBe(false);
  });

  it('validates the context window cap before handler execution', () => {
    expect(argsSchema.safeParse({ query: 'needle', context: 5 }).success).toBe(true);
    expect(argsSchema.safeParse({ query: 'needle', context: 6 }).success).toBe(false);
  });

  it('publishes the enforced context maximum in the caller-facing schema (EI-22053600590865118)', () => {
    const contextField = (tool.args as unknown as {
      shape: Record<string, { description?: string }>;
    }).shape.context;

    expect(contextField.description).toContain('default 2');
    expect(contextField.description).toContain('maximum 5');
  });
});

describe('sessions:search explicit session refresh scope (EI-21720673196644332)', () => {
  it('refreshes only the requested active session instead of enumerating open Codex owners', async () => {
    refreshLiveSessionsBeforeRead.mockClear();
    refreshTargetSessionBeforeRead.mockClear();
    const tx = makeTx([]);
    const sessionId = '01a0504e-2562-7401-8bab-26d3cace9e8d';

    const res = await callTool({
      query: 'targeted needle',
      mode: 'verbatim',
      session: sessionId,
      context: 0,
    }, tx);
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(0);
    expect(refreshTargetSessionBeforeRead).toHaveBeenCalledWith(tx, undefined, sessionId);
    expect(refreshLiveSessionsBeforeRead).not.toHaveBeenCalled();
  });

  it('logs a bounded phase duration when a refresh is slow', async () => {
    refreshTargetSessionBeforeRead.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 125));
      return { attempted: 1, refreshed: 1 };
    });
    const logs: string[] = [];

    const res = await callTool({
      query: 'targeted needle',
      mode: 'verbatim',
      session: 'slow-session',
      context: 0,
    }, makeTx([]), (message) => logs.push(message));

    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true, total_hits: 0 });
    expect(logs.some((message) => /\[sessions:search:phase\] secondary_live_refresh duration_ms=\d+/.test(message))).toBe(true);
  });
});

describe('sessions:search explicit session + include_coord scope (EI-23130749427955806)', () => {
  it('does not add the unscoped coord source to a targeted transcript search', async () => {
    runHybridSearch.mockClear();
    runHybridSearch.mockResolvedValueOnce({ results: [], totalHits: 0, embedderAvailable: true });

    const res = await callTool({
      query: 'activity',
      mode: 'hybrid',
      session: '01a09999-7af0-7882-8f3a-9fa7eef612ea',
      include_coord: true,
      limit: 20,
      context: 0,
    }, makeTx([]));
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      ok: true,
      total_hits: 0,
      coord_search: { requested: true, applied: false },
    });

    const firstCall = runHybridSearch.mock.calls[0] as unknown as [Array<{ name: string }>];
    const sources = firstCall[0];
    expect(sources.map((source) => source.name)).toEqual(['session_turn']);
  });

  it('keeps coord recall for session:self because it is owner-scoped, not session-scoped', async () => {
    runHybridSearch.mockClear();
    runHybridSearch.mockResolvedValueOnce({ results: [], totalHits: 0, embedderAvailable: true });

    const res = await callTool({
      query: 'activity',
      mode: 'hybrid',
      session: 'self',
      include_coord: true,
      limit: 20,
      context: 0,
    }, makeTx([]));
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true, total_hits: 0 });

    const firstCall = runHybridSearch.mock.calls[0] as unknown as [
      Array<{ name: string }>,
      { filters?: { owners?: string[] } },
    ];
    const sources = firstCall[0];
    expect(sources.map((source) => source.name)).toEqual(['session_turn', 'coord_message']);
    const searchParams = firstCall[1];
    expect(searchParams.filters?.owners).toEqual(['su-self']);
  });
});

describe('sessions:search self cursor authority (EI-22528353817146321)', () => {
  it('replays a page cursor after the resolved native self session changes', async () => {
    let currentSelfSession = {
      sourceKind: 'codex' as const,
      sessionId: 'native-before-respawn',
      filePath: '/tmp/native-before-respawn.jsonl',
    };
    resolveSelfSession.mockImplementation(async () => currentSelfSession);

    const rows = [
      {
        source_kind: 'codex',
        session_id: 'native-before-respawn',
        turn_idx: 1,
        speaker: 'assistant',
        owner: 'su-self',
        harness_slug: null,
        ts: null,
        text: 'first cursor page hit',
      },
      {
        source_kind: 'codex',
        session_id: 'native-before-respawn',
        turn_idx: 2,
        speaker: 'assistant',
        owner: 'su-self',
        harness_slug: null,
        ts: null,
        text: 'second cursor page hit',
      },
    ];
    let mainQueryCount = 0;
    const tx = vi.fn(async (...args: unknown[]) => {
      const strings = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      const sql = strings.join(' ');
      if (sql.includes('left(text, 700)')) {
        mainQueryCount += 1;
        return mainQueryCount === 1 ? rows : [rows[1]];
      }
      return [];
    });

    const first = await callTool({
      query: 'cursor page hit',
      mode: 'verbatim',
      session: 'self',
      limit: 1,
      context: 0,
    }, tx);
    const firstParsed = JSON.parse(first.content[0].text) as ParsedResult;
    expect(firstParsed.ok).toBe(true);
    expect(firstParsed.nextCursor).toBeDefined();

    currentSelfSession = {
      sourceKind: 'codex',
      sessionId: 'native-after-respawn',
      filePath: '/tmp/native-after-respawn.jsonl',
    };
    const second = await callTool({
      query: 'cursor page hit',
      mode: 'verbatim',
      session: 'self',
      limit: 1,
      context: 0,
      cursor: firstParsed.nextCursor,
    }, tx);
    const secondParsed = JSON.parse(second.content[0].text) as ParsedResult;

    expect(secondParsed.ok).toBe(true);
    expect(secondParsed.total_hits).toBe(1);
    expect(secondParsed.results).toHaveLength(1);
  });
});

describe('sessions:search EI-18877285731929394 — verbatim 0-hit hint', () => {
  it('adds a fallback hint when verbatim mode finds nothing (the false-negative trap)', async () => {
    const tx = makeTx([]); // ILIKE query matched no rows
    const res = await callTool({ query: 'a paraphrase that is not a literal quote', mode: 'verbatim', context: 0 }, tx);
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(0);
    expect(parsed.hint).toBeDefined();
    expect(parsed.hint).toMatch(/verbatim mode matches only an exact/i);
    expect(parsed.hint).toMatch(/mode:'hybrid'/);
  });

  it('omits the hint when verbatim mode finds a hit (no false negative to explain)', async () => {
    const tx = makeTx([
      { source_kind: 'claude', session_id: 'sess-1', turn_idx: 3, speaker: 'assistant', owner: 'su-self', harness_slug: null, ts: null, text: 'contains the literal quote' },
    ]);
    const res = await callTool({ query: 'literal quote', mode: 'verbatim', context: 0 }, tx);
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(1);
    expect(parsed.hint).toBeUndefined();
  });

  it('never adds the verbatim hint in hybrid mode (default), even on 0 hits', async () => {
    runHybridSearch.mockResolvedValueOnce({ results: [], totalHits: 0, embedderAvailable: true });
    const res = await callTool({ query: 'anything', context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.mode).toBe('hybrid');
    expect(parsed.total_hits).toBe(0);
    expect(parsed.hint).toBeUndefined();
  });
});

describe('sessions:search owner-directive provenance filters', () => {
  it('applies turn_origin and owner_only to the verbatim session query', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const hit = {
      source_kind: 'claude',
      session_id: 'sess-owner-directive',
      turn_idx: 4,
      speaker: 'user',
      owner: 'su-self',
      harness_slug: null,
      ts: null,
      text: 'please implement the approved change',
    };
    const tx = vi.fn(async (...args: unknown[]) => {
      const [strings, ...values] = args;
      const sql = Array.isArray(strings) ? (strings as string[]).join(' ? ') : String(strings);
      calls.push({ sql, values });
      return sql.includes('left(text, 700)') ? [hit] : [];
    });

    const res = await callTool({
      query: 'approved change',
      mode: 'verbatim',
      context: 0,
      turn_origin: 'owner-typed',
      owner_only: true,
    }, tx);
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;
    const main = calls.find((call) => call.sql.includes('left(text, 700)'));

    expect(parsed.total_hits).toBe(1);
    expect(main).toBeDefined();
    expect(main?.sql).toContain('turn_origin_verdict =');
    expect(main?.sql).toContain("turn_origin_verdict IN ('owner-typed', 'owner-dialog')");
    expect(main?.values).toContain('owner-typed');
    expect(main?.values).toContain(true);
  });

  it('uses the indexed lower(text) LIKE predicate and escapes literal LIKE metacharacters', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const tx = vi.fn(async (...args: unknown[]) => {
      const [strings, ...values] = args;
      const sql = Array.isArray(strings) ? (strings as string[]).join(' ? ') : String(strings);
      calls.push({ sql, values });
      return [];
    });

    const res = await callTool({ query: 'Needle%_\\fragment', mode: 'verbatim', context: 0 }, tx);
    const main = calls.find((call) => call.sql.includes('left(text, 700)'));
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.ok).toBe(true);
    expect(main).toBeDefined();
    expect(main?.sql).toContain('lower(text) LIKE');
    expect(main?.sql).not.toContain('text ILIKE');
    expect(main?.values).toContain('%needle\\%\\_\\\\fragment%');
  });
});

describe('sessions:search response-door shaping', () => {
  it('returns valid bounded JSON and a cursor when many same-block hits include windows', async () => {
    const text = 'same-content-block '.repeat(80);
    const rows = Array.from({ length: 11 }, (_, index) => ({
      source_kind: 'claude',
      session_id: `session-${index}`,
      turn_idx: index,
      speaker: 'assistant',
      owner: 'su-self',
      harness_slug: null,
      ts: null,
      text,
    }));
    const windowRows = rows.slice(0, 5).map(({ turn_idx, speaker, ts, text: windowText }) => ({
      turn_idx,
      speaker,
      ts,
      text: windowText,
    }));
    const tx = vi.fn(async (strings: readonly string[]) => {
      const sql = strings.join(' ');
      if (sql.includes('left(text, 700)')) return rows;
      if (sql.includes('left(text, 512)')) return [];
      if (sql.includes('SELECT turn_idx, speaker')) return windowRows;
      return [];
    });

    const res = await callTool({
      query: 'same-content-block',
      mode: 'verbatim',
      limit: 10,
      context: 2,
    }, tx);
    const raw = res.content[0].text;
    const parsed = JSON.parse(raw) as ParsedResult;

    expect(raw.length).toBeLessThanOrEqual(searchModule.SESSION_SEARCH_RESPONSE_BUDGET_CHARS);
    expect(parsed.ok).toBe(true);
    expect(parsed.total_hits).toBe(parsed.results.length);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results.length).toBeLessThan(10);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextCursor).toBeDefined();
    expect(parsed.resultsTruncated).toMatchObject({ reason: 'response_budget' });
    expect(parsed.results[0]).toMatchObject({
      ref: 'session_turn:claude:session-0:0',
      provenance: { ref: 'session_turn:claude:session-0:0', session_id: 'session-0', source_kind: 'claude' },
      readMore: { tool: 'sessions:read', args: { ref: 'session_turn:claude:session-0:0', context: 10 } },
    });
  });
});

/**
 * A PROVENANCE-FILTERED ZERO IS NOT A QUERY MISS.
 *
 * `owner_only:true` / `turn_origin:'owner-typed'` filter the PERSISTED verdict.
 * Ingest keeps an uncorrelated file-backed CLI residual as
 * `unenrolled-origin`, but a hook-authenticated prompt-origin stamp can
 * correlate an exact row and promote it to persisted `owner-typed`. The
 * filters are therefore sparse on CLI sessions, not structurally impossible.
 * The generic "QUERY-MATCH MISS ... retry with a different fragment" caveat
 * still must not make a residual zero read as "the owner never said it" — the
 * documented EI-13472 / WI-37419 failure, and the exact inverse of the
 * false-confirmation bug turn-origin.ts exists to kill.
 *
 * The regression below keeps the caveat explicit about both the residual and
 * hook-correlation paths so the reader description cannot drift again.
 */
describe('sessions:search — a provenance-filtered zero must not read as a query miss', () => {
  it('explains the structural exclusion when owner_only finds nothing, and names the reachable filter', async () => {
    const res = await callTool({ query: 'stop and hand off', owner_only: true, mode: 'verbatim', context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(0);
    expect(parsed.zeroHitCaveat).toBeDefined();
    // Names the cause, the reachable alternative, and the misreading to avoid.
    expect(parsed.zeroHitCaveat).toMatch(/unenrolled-origin/);
    expect(parsed.zeroHitCaveat).toMatch(/owner_candidates:true/);
    expect(parsed.zeroHitCaveat).toMatch(/NOT evidence/i);
    expect(parsed.zeroHitCaveat).toMatch(/hook-authenticated prompt-origin|hook-correlated/i);
    expect(parsed.zeroHitCaveat).toMatch(/sparse rather than structurally impossible/i);
    expect(parsed.zeroHitCaveat).not.toMatch(/structurally unreachable|guaranteed-empty|by construction/i);
    // NEGATIVE CONTROL: must NOT tell the caller to retry with another query
    // fragment — no fragment can ever match, which is what made the old caveat
    // worse than silence here.
    expect(parsed.zeroHitCaveat).not.toMatch(/QUERY-MATCH MISS/);
  });

  it('fires the same way for turn_origin, which has the identical structural blind spot', async () => {
    const res = await callTool({ query: 'anything', turn_origin: 'owner-typed', mode: 'verbatim', context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.zeroHitCaveat).toBeDefined();
    expect(parsed.zeroHitCaveat).toMatch(/owner_candidates:true/);
  });

  it('explains the excluded classifications when owner_candidates itself finds nothing', async () => {
    const res = await callTool({ query: 'lane fix', owner_candidates: true, mode: 'verbatim', context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(0);
    expect(parsed.zeroHitCaveat).toBeDefined();
    expect(parsed.zeroHitCaveat).toMatch(/owner_candidates:true/);
    expect(parsed.zeroHitCaveat).toMatch(/not-user-turn/);
    expect(parsed.zeroHitCaveat).toMatch(/drop the provenance filter|sessions:read/i);
    // The candidate filter is already the recall path; do not fall through to
    // the generic QUERY-MATCH MISS framing for an impossible classification.
    expect(parsed.zeroHitCaveat).not.toMatch(/QUERY-MATCH MISS/i);
  });

  it('stays silent when the provenance filter actually returned hits — nothing to explain', async () => {
    const tx = makeTx([
      { source_kind: 'claude', session_id: 'sess-1', turn_idx: 3, speaker: 'user', owner: 'su-self', harness_slug: null, ts: null, text: 'put yourself on auto mode' },
    ]);
    const res = await callTool({ query: 'auto mode', mode: 'verbatim', owner_only: true, context: 0 }, tx);
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(1);
    expect(parsed.zeroHitCaveat).toBeUndefined();
  });

  it('does NOT fire on an ordinary unfiltered zero — that one really is a query miss', async () => {
    const res = await callTool({ query: 'no such text', mode: 'verbatim', context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as ParsedResult;

    expect(parsed.total_hits).toBe(0);
    expect(parsed.zeroHitCaveat ?? '').not.toMatch(/owner_candidates/);
  });
});

/**
 * EI-22100689099416717 — the `mode` enum is DELIBERATELY closed to two members.
 *
 * That item was filed as "live mode enum rejects DOCUMENTED semantic option",
 * i.e. as a docs-vs-implementation divergence. It is not one: `mode:'semantic'`
 * is documented nowhere in this tree (measured — zero hits for the literal
 * across .ts/.tsx/.md/.mdx/.mjs, against 99 hits for the identical pattern with
 * 'verbatim' as the positive control). The guess is a cross-surface NAME
 * collision, not a missing feature: "semantic" is the name of a sibling TOOL
 * (`search:semantic`, over other corpora), while at THIS door the meaning-based
 * mode is spelled `hybrid`.
 *
 * The repair a future reader will be tempted to make — accept 'semantic' as an
 * alias for 'hybrid' — is the one change that must not happen, which is why the
 * decision is pinned here rather than left in the closed item's prose. The two
 * words do not denote the same retrieval: on the sibling tool the mode axis is
 * `embeddings` (pure vector) vs `hybrid` (BM25 + embeddings), so a caller who
 * asks for "semantic" is asking for the pure-vector leg — and `sessions:search`
 * has no pure-vector mode at all. Aliasing it to `hybrid` would silently serve a
 * lexical+vector blend to a caller who asked for vector-only and report success,
 * which is strictly worse than the current honest refusal: the refusal already
 * names the entire valid space (both members), so recovery costs one hop.
 *
 * If a pure-vector leg is ever genuinely wanted here, ADD it under a name that
 * says what it does (`embeddings`, matching the sibling) and delete this block —
 * do not quietly widen the alias set.
 */
describe('sessions:search mode enum is closed (EI-22100689099416717)', () => {
  it('rejects mode:"semantic" rather than aliasing it onto hybrid', () => {
    expect(argsSchema.safeParse({ query: 'needle', mode: 'semantic' }).success).toBe(false);
  });

  it('still accepts both advertised modes — so the rejection above is not a broken schema', () => {
    expect(argsSchema.safeParse({ query: 'needle', mode: 'hybrid' }).success).toBe(true);
    expect(argsSchema.safeParse({ query: 'needle', mode: 'verbatim' }).success).toBe(true);
    expect(argsSchema.safeParse({ query: 'needle' }).success).toBe(true);
  });

  it('keeps the meaning-based mode discoverable at the point of rejection', () => {
    // The caller who guesses 'semantic' wants search-by-meaning. Whatever else
    // changes, the surviving vocabulary must still name which member does that,
    // or the refusal stops being one-hop recoverable.
    const modeField = (tool.args as unknown as { shape: Record<string, { description?: string }> }).shape.mode;
    expect(modeField.description ?? '').toMatch(/hybrid/);
    expect(modeField.description ?? '').toMatch(/meaning/i);
  });
});

/**
 * WI-10005676 / EI-19478862482607876 — the engine's per-leg verdict reaches the
 * RESULT.
 *
 * `sessions:search` used to destructure `{ results }` out of `runHybridSearch` and
 * discard `legs`. The tool the compaction contract tells a successor to recover
 * context with therefore could not say whether its semantic half had contributed
 * anything: a search that silently went lexical-only read exactly like one that
 * found nothing, and the only place the degradation was visible was a hook banner
 * on a DIFFERENT code path. These cases pin both halves of the contract: the verdict
 * is on a hybrid result (with the semantic candidate count stated even at zero), and
 * it is absent in verbatim mode, which never runs an engine leg.
 */
describe('sessions:search surfaces the engine leg report (WI-10005676)', () => {
  const healthyLeg = {
    status: 'ran' as const,
    candidates: 4,
    floored: 0,
    stage2Added: 0,
    callsRun: 1,
    callsFailed: 0,
    failures: [],
    blocked: null,
  };

  it('puts legs on a hybrid result and states semantic.candidates even when it is 0', async () => {
    runHybridSearch.mockClear();
    runHybridSearch.mockResolvedValueOnce({
      results: [],
      totalHits: 0,
      embedderAvailable: true,
      legs: {
        degraded: true,
        warning: 'semantic leg contributed 0 candidates',
        lexical: { ...healthyLeg, candidates: 3 },
        semantic: { ...healthyLeg, candidates: 0 },
      },
    });

    const metadata = vi.fn();
    const res = await callTool({ query: 'needle', mode: 'hybrid', limit: 20, context: 0 }, makeTx([]), undefined, metadata);
    const parsed = JSON.parse(res.content[0].text) as {
      legs?: {
        degraded: boolean;
        warning: string | null;
        lexical: { candidates: number };
        semantic: { candidates: number };
      };
    };

    expect(parsed.legs).toBeDefined();
    expect(parsed.legs?.degraded).toBe(true);
    expect(parsed.legs?.warning).toBe('semantic leg contributed 0 candidates');
    expect(parsed.legs?.lexical.candidates).toBe(3);
    // The load-bearing assertion: a zero is STATED, not omitted — it is what tells a
    // leg that ran and found nothing apart from a leg that never ran.
    expect(parsed.legs?.semantic.candidates).toBe(0);
    const engineContext = (runHybridSearch.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    const receipt = metadata.mock.lastCall?.[0].sessionsSearchRead;
    expect(engineContext.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(receipt).toMatchObject({ correlationId: engineContext.correlationId,
      legs: { degraded: true, warning: 'semantic leg contributed 0 candidates' } });
  });

  it('keeps lexical hits and reports a budget-blocked semantic leg without failing the tool', async () => {
    runHybridSearch.mockClear();
    const timeout = 'query embed exceeded 4000ms budget';
    const { newLegAccumulator, finaliseLeg, summariseLegs } = await import('@papercusp/search');
    type LegFacts = Partial<{
      attempted: boolean;
      candidates: number;
      callsRun: number;
      blocked: string | null;
    }>;
    const makeLeg = (facts: LegFacts) => Object.assign(newLegAccumulator(), facts);
    const legs = summariseLegs(
      finaliseLeg(makeLeg({ attempted: true, callsRun: 1, candidates: 1 })),
      finaliseLeg(makeLeg({ attempted: true, blocked: timeout })),
    );
    runHybridSearch.mockResolvedValueOnce({
      results: [{
        source: 'coord_message',
        source_id: 'coord-message-1',
        excerpt: 'lexical fallback hit',
        highlight: 'lexical fallback hit',
        score: 0.5,
        rankers: ['lexical'],
      }],
      totalHits: 1,
      embedderAvailable: false,
      legs,
    });

    const res = await callTool({ query: 'needle', mode: 'hybrid', limit: 20, context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as ParsedResult & {
      legs?: {
        degraded: boolean;
        warning: string | null;
        lexical: { status: string; candidates: number };
        semantic: { status: string; candidates: number; blocked: string | null };
      };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.total_hits).toBe(1);
    expect(parsed.results).toMatchObject([{ source: 'coord_message', excerpt: 'lexical fallback hit' }]);
    expect(parsed.legs).toMatchObject({
      degraded: true,
      lexical: { status: 'ran', candidates: 1 },
      semantic: { status: 'errored', candidates: 0, blocked: timeout },
    });
    expect(parsed.legs?.warning).toMatch(/semantic leg blocked/);
  });

  it('reports a healthy hybrid search as not degraded', async () => {
    runHybridSearch.mockClear();
    runHybridSearch.mockResolvedValueOnce({
      results: [],
      totalHits: 0,
      embedderAvailable: true,
      legs: {
        degraded: false,
        warning: null,
        lexical: healthyLeg,
        semantic: healthyLeg,
      },
    });

    const res = await callTool({ query: 'needle', mode: 'hybrid', limit: 20, context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as { legs?: { degraded: boolean; warning: string | null } };

    expect(parsed.legs?.degraded).toBe(false);
    expect(parsed.legs?.warning).toBeNull();
  });

  it('omits legs when the engine returned none rather than inventing a verdict', async () => {
    // The pre-existing hybrid fixtures return no `legs`; the response must stay
    // well-formed for them instead of throwing in the projection.
    runHybridSearch.mockClear();
    runHybridSearch.mockResolvedValueOnce({ results: [], totalHits: 0, embedderAvailable: true });

    const res = await callTool({ query: 'needle', mode: 'hybrid', limit: 20, context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as { ok: boolean; legs?: unknown };

    expect(parsed.ok).toBe(true);
    expect(parsed).not.toHaveProperty('legs');
  });

  it('does NOT report legs in verbatim mode, which never runs an engine leg', async () => {
    runHybridSearch.mockClear();

    const res = await callTool({ query: 'needle', mode: 'verbatim', limit: 20, context: 0 }, makeTx([]));
    const parsed = JSON.parse(res.content[0].text) as { ok: boolean; legs?: unknown };

    expect(parsed.ok).toBe(true);
    expect(runHybridSearch).not.toHaveBeenCalled();
    expect(parsed).not.toHaveProperty('legs');
  });
});
