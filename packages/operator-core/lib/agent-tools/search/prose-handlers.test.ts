/**
 * search:fulltext / search:semantic — PURE handler-level tests for the
 * post-query shaping logic the two `defineTool` projections own.
 *
 * The heavy lifting (BM25 / pgvector / RRF) lives in `@papercusp/search`
 * (`runFullTextSearch` / `runHybridSearch`) and is unit-tested there. The
 * cross-encoder rerank is `./rerank` (tested in rerank.test.ts) and the
 * embedder cascade is `./embedder`. All three are mocked here so we isolate
 * exactly the handler-only logic:
 *
 *   - scope normalization: empty/absent → the 4 historic default sources
 *     (escalations/brainstorm/turns/decisions, unchanged so existing unscoped
 *     callers see no behavior change); explicit `all` → every registered
 *     source from the live registry; an
 *     explicit subset passes through verbatim;
 *   - `SEARCH_SOURCES.filter(scope.includes(name))` → which sources reach
 *     the engine;
 *   - limit defaulting (5) + workspaceId fallback ('' when ctx.workspaceId
 *     is unset);
 *   - fulltext output projection: `rank: r.score`, `harness_slug` only when
 *     `scope` is present, `query`/`scope`/`total_hits` echo;
 *   - semantic output projection: `mode` default 'hybrid', `embedder_available`
 *     passthrough, the generic `scope` → domain `harness_slug` remap;
 *   - embedding-call failure / no key → graceful fallback: the engine reports
 *     `embedderAvailable: false` and the handler surfaces it, no throw.
 *
 * Each engine mock records the `sources` + ctx it was handed so we can assert
 * the scope→sources translation without a real PG handle.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  capturePgDiagnosticContext,
  createPgDiagnosticHooks,
  pgResultDiagnosticSnapshot,
  resetAcquireRegistryForTest,
  resetPgDiagnosticContextResolver,
} from '@papercusp/db-org';
import { installDbDiagnosticCorrelationWiring } from '../db-diagnostic-correlation-wiring';

// --- Engine mock: records inputs, returns scripted hits. ---------------------
interface EngineCall {
  sourceNames: string[];
  ctx: Record<string, unknown>;
}
const ftCalls: EngineCall[] = [];
const hybridCalls: EngineCall[] = [];

let ftResult = { results: [] as unknown[], totalHits: 0 };
let hybridResult: {
  results: unknown[];
  totalHits: number;
  embedderAvailable: boolean;
  // P-020: scriptable so a test can drive a genuinely DEGRADED search. Left
  // absent by default; the stub fills in an all-`not-run` report.
  legs?: unknown;
} = { results: [], totalHits: 0, embedderAvailable: true };

const runFullTextSearch = vi.fn(async (sources: Array<{ name: string }>, ctx: Record<string, unknown>) => {
  ftCalls.push({ sourceNames: sources.map((s) => s.name), ctx });
  return ftResult;
});
const runHybridSearch = vi.fn(async (sources: Array<{ name: string }>, ctx: Record<string, unknown>) => {
  hybridCalls.push({ sourceNames: sources.map((s) => s.name), ctx });
  // P-020: `legs` is a REQUIRED field of the engine's result, so the default
  // stub supplies a real (all `not-run`) report rather than omitting it. A
  // mock that returns less than the contract makes the handler look broken
  // when it is the mock that is lying — and the alternative "fix", making the
  // handler tolerate a missing report, would permanently hide exactly the
  // silent-degradation class this field exists to expose.
  //
  // Resolved LAZILY, not via a top-level import: importing the mocked module
  // at file scope makes vitest run the (hoisted) factory before these consts
  // initialise, which fails collection with "Cannot access 'runFullTextSearch'
  // before initialization" — a message that points nowhere near the cause.
  // Spread FIRST so a test can script its own legs via `hybridResult.legs`.
  const { emptyLegs } = await import('@papercusp/search');
  return { legs: emptyLegs(), ...hybridResult };
});

// configureSearchDefaults is inert here, but REQUIRED: an inline factory
// replaces the module wholesale, and lib/search/configure-search-defaults.ts
// calls it at module load (P-017), so omitting it fails COLLECTION.
// importOriginal, NOT a wholesale replacement: the module owns real helpers
// the handler and these tests both need (`emptyLegs`), and an inline factory
// that drops them fails at COLLECTION with an undefined-export error that
// looks nothing like its cause (WI-7262 class).
vi.mock('@papercusp/search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/search')>()),
  // Copy-out mutation probes: an absolute path to a module whose exports replace
  // the library's (e.g. a mutated copy of libs/generic/search/src/coverage-gate.ts),
  // so the papercusp wiring is proven to depend on the library without dirtying
  // the shared tree.
  ...(process.env.PAPERCUSP_SEARCH_LIBRARY_SUBJECT
    ? ((await import(process.env.PAPERCUSP_SEARCH_LIBRARY_SUBJECT)) as object)
    : {}),
  runFullTextSearch,
  runHybridSearch,
  configureSearchDefaults: vi.fn(),
}));

// Keep engine stand-ins tied to the real registry: a stale seven-source
// fixture hid plan/report/doc coverage from these handler tests.
vi.mock('./sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sources')>();
  return { ...actual, SEARCH_SOURCES: actual.SEARCH_SOURCES.map(({ name }) => ({ name })) };
});

// rerankProseHits is identity-passthrough (sliced) — its own fail-safe
// behavior is covered in rerank.test.ts; here it must not reorder/drop so we
// can assert the handler's field mapping on a stable list. rerankCandidateCount
// is delegated to the REAL implementation (via importOriginal) rather than
// stubbed, so this mock can never drift from RERANK_OVERFETCH/RERANK_MAX_CANDIDATES
// — a hand-picked stub would silently stop covering the over-fetch sizing the
// handler actually sends to the engine.
vi.mock('./rerank', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rerank')>();
  return {
    ...actual,
    rerankProseHits: vi.fn(async (_q: string, hits: unknown[], limit: number) => hits.slice(0, limit)),
  };
});

// embedder: scripted per-test (null = no embedder available).
const buildQueryEmbedder = vi.fn(async () => null as unknown);
// interactiveEmbedAcquireBudgetMs: semantic.ts calls this to compute the
// acquisition budget it passes to buildQueryEmbedder / embedTimeoutMs (EI-9334)
// — a fixed stand-in is fine here since the handler-level tests never assert
// on the budget value itself, only on buildQueryEmbedder's scripted return.
const interactiveEmbedAcquireBudgetMs = vi.fn(() => 4000);
// P-001: semantic.ts acquires the RESOLVED embedder (it needs the mode to pick
// a minScore floor in that model's units). Derived from the same scripted
// `buildQueryEmbedder` mock above so every existing per-test script
// (mockResolvedValueOnce / mockRejectedValueOnce) keeps driving it, and the
// call-count assertions keep counting. A rejection is deliberately NOT
// swallowed here — the real builder owns that try/catch, and the last test in
// this file pins that the HANDLER adds no boundary of its own.
// `mode: 'test'` is deliberately an UNMEASURED mode ⇒ no floor is applied, so
// these engine-wiring tests stay independent of the floor's value.
const buildQueryEmbedderResolved = vi.fn(async (...args: unknown[]) => {
  const embed = await (buildQueryEmbedder as (...a: unknown[]) => Promise<unknown>)(...args);
  return embed ? { mode: 'test', dims: 768, embed } : null;
});
vi.mock('./embedder', () => ({
  buildQueryEmbedder,
  buildQueryEmbedderResolved,
  interactiveEmbedAcquireBudgetMs,
}));

const CTX = (over: Record<string, unknown> = {}) => ({
  tx: (() => {}) as never,
  workspaceId: 'ws_1',
  log: vi.fn(),
  ...over,
});

function payloadOf(res: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  resetAcquireRegistryForTest();
  installDbDiagnosticCorrelationWiring();
  ftCalls.length = 0;
  hybridCalls.length = 0;
  runFullTextSearch.mockClear();
  runHybridSearch.mockClear();
  buildQueryEmbedder.mockClear();
  ftResult = { results: [], totalHits: 0 };
  hybridResult = { results: [], totalHits: 0, embedderAvailable: true };
});

afterEach(() => {
  resetPgDiagnosticContextResolver();
  resetAcquireRegistryForTest();
});

// =============================================================================
// search:fulltext
// =============================================================================
describe('search:fulltext — invocation stage attribution', () => {
  it('distinguishes slow retrieval from reranking in invocation metadata', async () => {
    const tool = (await import('./fulltext')).default;
    const rerank = await import('./rerank');
    const metadata = vi.fn();
    let now = 20;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const page = vi.spyOn(rerank, 'rerankPageHead').mockImplementationOnce(async () => {
      now += 25;
      return [];
    });
    runFullTextSearch.mockImplementationOnce(async () => {
      now += 3000;
      return ftResult;
    });
    try {
      await tool.handler({ query: 'memory admission', scope: ['session_turn'] } as never, CTX({ metadata }) as never);
      expect(metadata.mock.lastCall?.[0].searchFulltextRead).toEqual({
        schemaVersion: 'fulltext-read-v1',
        unit: 'ms',
        timing: 'wall-time-sequential-stages',
        elapsedMs: 3025,
        stages: [
          { name: 'filters', elapsedMs: 0, status: 'ok' },
          { name: 'retrieval', elapsedMs: 3000, status: 'ok' },
          { name: 'rerank', elapsedMs: 25, status: 'ok' },
        ],
        queryDiagnostics: {
          processInstanceId: expect.any(String),
          buildSha: expect.toSatisfy((value: unknown) => value === null || typeof value === 'string'),
          rowId: null,
          attemptId: expect.any(String),
          stage: 'scope-query',
          coverage: 'queries-created-during-retrieval',
          timing: 'query-build-to-terminal-not-acquisition',
        },
      });
      expect(page).toHaveBeenCalledOnce();
    } finally {
      page.mockRestore();
      clock.mockRestore();
    }
  });

  it('preserves a retrieval failure and records its failed stage', async () => {
    const tool = (await import('./fulltext')).default;
    const metadata = vi.fn();
    const failure = new Error('retrieval unavailable');
    runFullTextSearch.mockRejectedValueOnce(failure);
    await expect(tool.handler({ query: 'memory admission' } as never, CTX({ metadata }) as never)).rejects.toBe(failure);
    expect(metadata.mock.lastCall?.[0].searchFulltextRead.stages).toEqual([
      { name: 'filters', elapsedMs: expect.any(Number), status: 'ok' },
      { name: 'retrieval', elapsedMs: expect.any(Number), status: 'error' },
    ]);
    expect(capturePgDiagnosticContext().state).toBe('unobserved');
  });

  it('joins a completed query to this invocation without retaining search text or SQL values', async () => {
    const tool = (await import('./fulltext')).default;
    const metadata = vi.fn();
    const hooks = createPgDiagnosticHooks('org-admin');
    runFullTextSearch.mockImplementationOnce(async () => {
      const context = hooks.onquerycontext();
      hooks.onresult({ connectionId: 7, queryId: 23, backendPid: null,
        query: "SELECT body FROM session_turns WHERE token = 'never-retain-secret'",
        rowCount: 0, wireBytes: 0, elapsedMs: 42, status: 'ok', context });
      return ftResult;
    });
    await tool.handler({ query: 'private-search-text', scope: ['session_turn'] } as never, CTX({ metadata }) as never);
    const identity = metadata.mock.lastCall?.[0].searchFulltextRead.queryDiagnostics;
    const result = pgResultDiagnosticSnapshot('org-admin').results[0];
    expect(result.correlationState).toBe('linked');
    expect(result.correlation).toMatchObject({ attemptId: identity.attemptId,
      processInstanceId: identity.processInstanceId, rowId: null, stage: 'scope-query', boundary: 'await' });
    expect(result.elapsedMs).toBe(42);
    expect(JSON.stringify({ identity, result })).not.toContain('private-search-text');
    expect(JSON.stringify({ identity, result })).not.toContain('never-retain-secret');
    expect(capturePgDiagnosticContext().state).toBe('unobserved');
  });

  it('keeps concurrent searches from sharing or leaking query attribution', async () => {
    const tool = (await import('./fulltext')).default;
    const contexts: ReturnType<typeof capturePgDiagnosticContext>[] = [];
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    runFullTextSearch.mockImplementationOnce(async () => {
      contexts[0] = capturePgDiagnosticContext();
      await together;
      expect(capturePgDiagnosticContext()).toEqual(contexts[0]);
      return ftResult;
    }).mockImplementationOnce(async () => {
      contexts[1] = capturePgDiagnosticContext();
      release();
      await Promise.resolve();
      expect(capturePgDiagnosticContext()).toEqual(contexts[1]);
      return ftResult;
    });
    const first = vi.fn(), second = vi.fn();
    await Promise.all([
      tool.handler({ query: 'first' } as never, CTX({ metadata: first }) as never),
      tool.handler({ query: 'second' } as never, CTX({ metadata: second }) as never),
    ]);
    const ids = [first, second].map((sink) => sink.mock.lastCall?.[0].searchFulltextRead.queryDiagnostics.attemptId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(contexts.map((context) => context.correlation?.attemptId)).toEqual(ids);
    expect(capturePgDiagnosticContext().state).toBe('unobserved');
  });
});

describe('search:semantic — exact retrieval observation receipt', () => {
  it('stores the engine correlation id and exact leg verdict in invocation metadata', async () => {
    const tool = (await import('./semantic')).default;
    const metadata = vi.fn();
    await tool.handler({ query: 'memory admission', scope: ['session_turn'] } as never, CTX({ metadata }) as never);

    const correlationId = hybridCalls.at(-1)?.ctx.correlationId;
    const receipt = metadata.mock.lastCall?.[0].searchSemanticRead;
    expect(correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(receipt).toMatchObject({ correlationId, legs: { degraded: false } });
  });
});

describe('search:fulltext — scope normalization', () => {
  it('no scope → the 4 default sources, in canonical order', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'pricing decision' } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
    expect(ftCalls[0].sourceNames).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
  });

  // EI-6984: 'work_item' (and the session/coord corpora,
  // session-search-scope-2026-07-05) are opt-in-only for the OMITTED-scope
  // default (a bare search:fulltext call keeps returning exactly the historic
  // 4 sources so existing unscoped callers see no behavior change) but an
  // EXPLICIT scope:['all'] means "every source", so it expands to all 7.
  it('scope:["all"] expands to every registered source (the 4 historic defaults + work_item + session_turn + coord_message)', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['all'] } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual([
      'escalations', 'brainstorm', 'turns', 'decisions', 'work_item', 'session_turn', 'coord_message', 'report', 'plan', 'doc',
    ]);
  });

  it('an explicit subset is passed through and limits the sources reaching the engine', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['brainstorm', 'decisions'] } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual(['brainstorm', 'decisions']);
    expect(ftCalls[0].sourceNames).toEqual(['brainstorm', 'decisions']);
  });

  // EI-6984: the actual bug this closes — scope:['work_item'] used to be silently
  // dropped (not a recognized enum value at all), so a dedup-before-filing check
  // always reused the same 4-source scope with no error and no work_item results.
  it('scope:["work_item"] is accepted and echoed (the EI-6984 fix) — not silently dropped', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['work_item'] } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual(['work_item']);
  });

  // GAP 12 — scope edge: `!args.scope?.length` (an empty array, distinct from
  // absent/`['all']`) is the third path through the normalization at
  // fulltext.ts:53-56. It must expand to the same 4 defaults, not collapse to
  // "no sources".
  it('scope:[] (empty array) → the 4 defaults reach the engine (not zero sources)', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: [] } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
    expect(ftCalls[0].sourceNames).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
  });

  // GAP 12 — a scope naming only sources that don't exist in SEARCH_SOURCES →
  // `.filter(scope.includes)` yields zero sources. The engine is still called
  // (with []), returns no hits, and the handler returns results:[] without
  // throwing. (`['all']` is special-cased to the defaults, so the test uses a
  // non-'all' unknown scope value the enum-bypassing `as never` cast allows.)
  it('a scope matching no source → zero sources → results:[], no throw', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['nonexistent-source'] } as never, CTX() as never);
    expect(ftCalls[0].sourceNames).toEqual([]); // nothing reaches the engine
    const p = payloadOf(res as never);
    expect(p.results).toEqual([]);
    expect(p.total_hits).toBe(0);
    expect(p.scope).toEqual(['nonexistent-source']);
  });
});

describe('search:fulltext — limit + workspaceId defaulting', () => {
  it('defaults limit to 5 when omitted — over-fetched to the Stage B rerank pool size, not the raw page size', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'x' } as never, CTX() as never);
    // rerankCandidateCount(5) = max(5, min(5*RERANK_OVERFETCH, RERANK_MAX_CANDIDATES)) = 20.
    // The engine is asked to retrieve the over-fetched pool; rerankProseHits (mocked
    // above as identity-passthrough) slices the RETURNED page back to `limit` in the
    // handler's own output, so callers still see 5 results — only the retrieval size differs.
    expect(ftCalls[0].ctx.limit).toBe(20);
  });

  it('passes the over-fetched (rerankCandidateCount) limit through, not the raw requested limit', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'x', limit: 12 } as never, CTX() as never);
    // rerankCandidateCount(12) = max(12, min(12*4, 24)) = 24.
    expect(ftCalls[0].ctx.limit).toBe(24);
  });

  it('falls back to empty-string workspaceId when ctx.workspaceId is unset', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'x' } as never, CTX({ workspaceId: undefined }) as never);
    expect(ftCalls[0].ctx.workspaceId).toBe('');
  });

  it('forwards harness_slug as the engine scopeFilter (null when absent)', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'x' } as never, CTX() as never);
    expect(ftCalls[0].ctx.scopeFilter).toBeNull();
    await tool.handler({ query: 'x', harness_slug: 'sheets' } as never, CTX() as never);
    expect(ftCalls[1].ctx.scopeFilter).toBe('sheets');
  });
});

describe('search:fulltext — output projection', () => {
  it('renames hit.score → rank and includes harness_slug only when scope present', async () => {
    ftResult = {
      results: [
        { source: 'escalations', source_id: 'e1', scope: 'sheets', excerpt: 'ex1', highlight: 'h1', score: 0.9 },
        { source: 'turns', source_id: 't1', excerpt: 'ex2', highlight: 'h2', score: 0.4 },
      ],
      totalHits: 2,
    };
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    const p = payloadOf(res as never);
    expect(p.total_hits).toBe(2);
    expect(p.results[0]).toEqual({
      source: 'escalations',
      source_id: 'e1',
      harness_slug: 'sheets',
      excerpt: 'ex1',
      highlight: 'h1',
      rank: 0.9,
    });
    // No scope on the second hit → no harness_slug key (not null).
    expect(p.results[1]).not.toHaveProperty('harness_slug');
    expect(p.results[1].rank).toBe(0.4);
    // `score` field is renamed away — the agent surface uses `rank`.
    expect(JSON.stringify(p.results)).not.toContain('"score"');
  });

  it('echoes the query verbatim in the payload', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'the pricing discussion' } as never, CTX() as never);
    expect(payloadOf(res as never).query).toBe('the pricing discussion');
  });
});

// =============================================================================
// search:semantic
// =============================================================================
describe('search:semantic — mode + scope defaulting', () => {
  it('defaults mode to "hybrid"', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'auth strategy' } as never, CTX() as never);
    expect(payloadOf(res as never).mode).toBe('hybrid');
    expect(hybridCalls[0].ctx.mode).toBe('hybrid');
  });

  it('honors an explicit mode="embeddings"', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x', mode: 'embeddings' } as never, CTX() as never);
    expect(payloadOf(res as never).mode).toBe('embeddings');
    expect(hybridCalls[0].ctx.mode).toBe('embeddings');
  });

  it('no scope → 4 default sources reach the engine', async () => {
    const tool = (await import('./semantic')).default;
    await tool.handler({ query: 'x' } as never, CTX() as never);
    expect(hybridCalls[0].sourceNames).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
  });

  // GAP 12 — semantic.ts shares the same `scope?.includes('all') || !scope?.length`
  // normalization (semantic.ts:59-62). Empty array → the 4 defaults.
  it('scope:[] (empty array) → the 4 defaults reach the engine', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x', scope: [] } as never, CTX() as never);
    expect(hybridCalls[0].sourceNames).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
    expect(payloadOf(res as never).scope).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
  });

  // GAP 12 — a scope matching no source → zero sources → results:[], no throw.
  it('a scope matching no source → zero sources → results:[], no throw', async () => {
    buildQueryEmbedder.mockResolvedValueOnce(null);
    hybridResult = { results: [], totalHits: 0, embedderAvailable: false };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x', scope: ['nope'] } as never, CTX() as never);
    expect(hybridCalls[0].sourceNames).toEqual([]);
    const p = payloadOf(res as never);
    expect(p.results).toEqual([]);
    expect(p.total_hits).toBe(0);
  });
});

// P-020 — the handler must SURFACE a silently single-legged search.
//
// ⚠ Without these, every other test in this file passes with an all-`not-run`
// leg report, i.e. green while proving nothing about the contract. The legs
// here are built by the ENGINE'S OWN `summariseLegs`, not hand-written
// literals, so this asserts the real predicate end-to-end rather than a copy
// of it that can drift.
describe('search:semantic — leg honesty (P-020)', () => {
  /** Build a real SearchLegs from per-leg facts, via the engine's own rule. */
  type LegFacts = Partial<{
    attempted: boolean;
    candidates: number;
    floored: number;
    callsRun: number;
    callsFailed: number;
    blocked: string | null;
  }>;
  const realLegs = async (
    lex: LegFacts,
    sem: LegFacts,
  ) => {
    const { newLegAccumulator, finaliseLeg, summariseLegs } = await import('@papercusp/search');
    const mk = (o: typeof lex) => Object.assign(newLegAccumulator(), o);
    return summariseLegs(finaliseLeg(mk(lex)), finaliseLeg(mk(sem)));
  };

  it('reports degraded + names the leg when the LEXICAL leg contributes nothing (EI-19447237774252790)', async () => {
    // The measured case: the lexical leg runs perfectly and returns zero rows
    // (plainto_tsquery ANDs every term), so the search is silently
    // semantic-only while embedder_available stays true.
    hybridResult = {
      results: [],
      totalHits: 12,
      embedderAvailable: true,
      legs: await realLegs(
        { attempted: true, callsRun: 4, candidates: 0 },
        { attempted: true, callsRun: 4, candidates: 12 },
      ),
    };
    const tool = (await import('./semantic')).default;
    const p = payloadOf((await tool.handler({ query: 'x' } as never, CTX() as never)) as never);
    expect(p.legs.degraded).toBe(true);
    expect(p.legs.warning).toMatch(/lexical leg contributed 0 candidates/);
    expect(p.legs.warning).toMatch(/semantic-only/);
    expect(p.legs.lexical).toMatchObject({ status: 'ran', candidates: 0 });
    expect(p.legs.semantic).toMatchObject({ status: 'ran', candidates: 12 });
    // The degradation must be visible EVEN THOUGH the old signal reads healthy.
    expect(p.embedder_available).toBe(true);
    expect(p.status).toBe('degraded');
    expect(p.warning).toMatch(/SEARCH DEGRADED/);
    expect(p.warning).toMatch(/lexical leg contributed 0 candidates/);
  });

  it('promotes a blocked semantic leg to the primary verdict even when lexical fallback returns plausible hits', async () => {
    hybridResult = {
      results: [
        { source: 'turns', source_id: 't1', excerpt: 'lexical hit', highlight: 'lexical hit', score: 0.5, rankers: ['lexical'] },
      ],
      totalHits: 1,
      embedderAvailable: false,
      legs: await realLegs(
        { attempted: true, callsRun: 4, candidates: 1 },
        { attempted: true, blocked: 'query embed exceeded 4000ms budget' },
      ),
    };
    const tool = (await import('./semantic')).default;
    const p = payloadOf((await tool.handler({ query: 'x' } as never, CTX() as never)) as never);
    expect(p.results).toHaveLength(1);
    expect(p.total_hits).toBe(1);
    expect(p.status).toBe('degraded');
    expect(p.warning).toMatch(/SEARCH DEGRADED/);
    expect(p.warning).toMatch(/semantic leg blocked/);
    expect(p.warning).toMatch(/query embed exceeded 4000ms budget/);
  });

  it('distinguishes "the floor ate it" from "the query found nothing"', async () => {
    hybridResult = {
      results: [],
      totalHits: 9,
      embedderAvailable: true,
      legs: await realLegs(
        { attempted: true, callsRun: 4, candidates: 9 },
        { attempted: true, callsRun: 4, candidates: 0, floored: 40 },
      ),
    };
    const tool = (await import('./semantic')).default;
    const p = payloadOf((await tool.handler({ query: 'x' } as never, CTX() as never)) as never);
    expect(p.legs.degraded).toBe(true);
    expect(p.legs.warning).toMatch(/score floor removed all 40/);
    expect(p.legs.semantic).toMatchObject({ candidates: 0, floored: 40 });
  });

  // CALIBRATION: the controls above must not fire on a healthy search, or the
  // warning becomes noise readers learn to ignore. Both-legs-empty is a query
  // with no matches, NOT a degradation — the asymmetry is deliberate.
  it('does NOT report degraded when both legs contribute', async () => {
    hybridResult = {
      results: [],
      totalHits: 5,
      embedderAvailable: true,
      legs: await realLegs(
        { attempted: true, callsRun: 4, candidates: 7 },
        { attempted: true, callsRun: 4, candidates: 5 },
      ),
    };
    const tool = (await import('./semantic')).default;
    const p = payloadOf((await tool.handler({ query: 'x' } as never, CTX() as never)) as never);
    expect(p.legs.degraded).toBe(false);
    expect(p.legs.warning).toBeNull();
  });

  it('does NOT report degraded when BOTH legs ran and found nothing (no matches ≠ degraded)', async () => {
    hybridResult = {
      results: [],
      totalHits: 0,
      embedderAvailable: true,
      legs: await realLegs(
        { attempted: true, callsRun: 4, candidates: 0 },
        { attempted: true, callsRun: 4, candidates: 0 },
      ),
    };
    const tool = (await import('./semantic')).default;
    const p = payloadOf((await tool.handler({ query: 'x' } as never, CTX() as never)) as never);
    expect(p.legs.degraded).toBe(false);
    expect(p.legs.warning).toBeNull();
  });
});

describe('search:semantic — embedder availability', () => {
  it('passes the built embedder to the engine and surfaces embedder_available:true', async () => {
    const fakeEmbedder = vi.fn(async () => [0.1, 0.2]);
    buildQueryEmbedder.mockResolvedValueOnce(fakeEmbedder);
    hybridResult = { results: [], totalHits: 0, embedderAvailable: true };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    expect(buildQueryEmbedder).toHaveBeenCalledTimes(1);
    expect(hybridCalls[0].ctx.embedder).toBe(fakeEmbedder);
    expect(payloadOf(res as never).embedder_available).toBe(true);
  });

  it('no embedder (null) → graceful fallback, embedder_available:false, no throw', async () => {
    buildQueryEmbedder.mockResolvedValueOnce(null);
    hybridResult = { results: [], totalHits: 0, embedderAvailable: false };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    const p = payloadOf(res as never);
    expect(hybridCalls[0].ctx.embedder).toBeNull();
    expect(p.embedder_available).toBe(false);
    expect(p.total_hits).toBeNull();
    expect(p.zeroHitCaveat).toMatch(/NOT AN ABSENCE CLAIM/);
  });

  it('keeps a numeric lexical fallback count when the embedder is unavailable', async () => {
    buildQueryEmbedder.mockResolvedValueOnce(null);
    hybridResult = {
      results: [{ source: 'turns', source_id: 't1', excerpt: 'e', score: 0.5 }],
      totalHits: 1,
      embedderAvailable: false,
    };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    const p = payloadOf(res as never);
    expect(p.embedder_available).toBe(false);
    expect(p.total_hits).toBe(1);
    expect(p.zeroHitCaveat).toBeUndefined();
    expect(p.status).toBe('degraded');
    expect(p.warning).toMatch(/query embedding unavailable/);
    expect(p.warning).toMatch(/lexical-only/);
  });

  it('embedder builder throwing is NOT caught by the handler (builder is the fail-safe boundary)', async () => {
    // buildQueryEmbedder owns the try/catch internally and returns null on
    // failure; if it rejected, the handler would propagate. Pin that contract
    // so a future refactor that moves the boundary is caught.
    buildQueryEmbedder.mockRejectedValueOnce(new Error('embedder boom'));
    const tool = (await import('./semantic')).default;
    await expect(
      tool.handler({ query: 'x' } as never, CTX() as never),
    ).rejects.toThrow('embedder boom');
  });
});

describe('search:semantic — output projection (scope → harness_slug remap)', () => {
  it('remaps the generic engine `scope` field to domain `harness_slug`', async () => {
    hybridResult = {
      results: [
        { source: 'escalations', source_id: 'e1', scope: 'sheets', excerpt: 'ex', highlight: 'h', score: 0.7, rankers: ['lexical'] },
        { source: 'turns', source_id: 't1', excerpt: 'ex2', highlight: 'h2', score: 0.3, rankers: ['vec'] },
      ],
      totalHits: 2,
      embedderAvailable: true,
    };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    const p = payloadOf(res as never);
    // Hit WITH scope: `scope` removed, `harness_slug` added; `score` kept (semantic keeps score).
    expect(p.results[0].harness_slug).toBe('sheets');
    expect(p.results[0]).not.toHaveProperty('scope');
    expect(p.results[0].score).toBe(0.7);
    // Hit WITHOUT scope: untouched, no harness_slug key.
    expect(p.results[1]).not.toHaveProperty('harness_slug');
    expect(p.results[1]).not.toHaveProperty('scope');
    expect(p.total_hits).toBe(2);
  });
});

// ── P-009 runtime honesty ───────────────────────────────────────────────────
// These drive the REAL handler with a working `tx`, so they cover the wiring
// end-to-end rather than the `no handle` early-return the other tests take.
describe('search:semantic — coverage honesty (P-009)', () => {
  const TURNS_SURFACE = 'harness_shared.operator_turns.text_embedding';

  /** A tx whose one query returns scripted coverage-sample rows. */
  const txWith = (rows: unknown[]) => ({ unsafe: async () => rows });

  const sample = (embedded: number, eligible: number, recent?: [number, number]) => ({
    surface: TURNS_SURFACE,
    observed_at: new Date().toISOString(),
    eligible_rows: String(eligible),
    embedded_rows: String(embedded),
    recent_eligible: recent ? String(recent[0]) : null,
    recent_embedded: recent ? String(recent[1]) : null,
  });

  beforeEach(async () => {
    (await import('../../search/coverage-gate')).resetCoverageSnapshotCache();
  });

  it('reports a degraded surface with real numbers instead of answering confidently', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler(
      { query: 'x', scope: ['turns'] } as never,
      CTX({ tx: txWith([sample(720, 1000)]) }) as never,
    );
    const p = payloadOf(res as never);
    expect(p.coverage.degraded).toBe(true);
    expect(p.coverage.sources[0]).toMatchObject({ source: 'turns', verdict: 'degraded' });
    expect(p.coverage.sources[0].coverage).toBeCloseTo(0.72, 4);
    expect(p.coverage.warning).toMatch(/DEGRADED/);
    expect(p.status).toBe('degraded');
    expect(p.warning).toMatch(/SEARCH DEGRADED/);
    expect(p.warning).toMatch(/DEGRADED/);
  });

  it('stays quiet — and cheap — when the index is healthy', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler(
      { query: 'x', scope: ['turns'] } as never,
      CTX({ tx: txWith([sample(1000, 1000)]) }) as never,
    );
    const p = payloadOf(res as never);
    expect(p.coverage.degraded).toBe(false);
    expect(p.coverage.warning).toBeNull();
    // A healthy search must not pay a per-source payload tax.
    expect(p.coverage.sources).toEqual([]);
    expect(p.status).toBe('ok');
    expect(p.warning).toBeNull();
  });

  it("escalates the wording for mode='embeddings', where a missing row is UNREACHABLE", async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler(
      { query: 'x', scope: ['turns'], mode: 'embeddings' } as never,
      CTX({ tx: txWith([sample(720, 1000)]) }) as never,
    );
    const p = payloadOf(res as never);
    expect(p.coverage.warning).toMatch(/UNREACHABLE/);
    expect(p.coverage.warning).toMatch(/hybrid/);
  });

  it('reports UNKNOWN (never healthy) when no sample exists', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler(
      { query: 'x', scope: ['turns'] } as never,
      CTX({ tx: txWith([]) }) as never,
    );
    const p = payloadOf(res as never);
    expect(p.coverage.degraded).toBe(true);
    expect(p.coverage.sources[0].verdict).toBe('unknown');
    expect(p.coverage.warning).toMatch(/UNKNOWN/);
  });

  it('does not fail the search when the coverage read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tool = (await import('./semantic')).default;
      const boom = { unsafe: async () => { throw new Error('pg is down'); } };
      const res = await tool.handler(
        { query: 'x', scope: ['turns'] } as never,
        CTX({ tx: boom }) as never,
      );
      const p = payloadOf(res as never);
      // Search still answers; honesty degrades to unknown rather than blocking.
      expect(p.query).toBe('x');
      expect(p.coverage.sources[0].verdict).toBe('unknown');
      // ...and the degradation is logged, not swallowed.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// =============================================================================
// Partial-corpus coverage, at the HANDLER boundary.
//
// ./scope-residue.test.ts covers the pure helper and the registry bijection.
// These tests exist because those cannot fail if someone deletes the
// `...(residue ? { scope_residue: residue } : {})` spread from the handlers:
// the helper would stay perfect while callers mistook narrow matches for
// complete discovery. A tool's OUTPUT is part of its contract, so it is asserted
// on the tool.
// =============================================================================
describe('search:fulltext — scope residue', () => {
  it('a zero from a partial scope discloses the corpora it never queried', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['turns'] } as never, CTX() as never);
    const p = payloadOf(res as never);

    expect(p.total_hits).toBe(0);
    expect(p.scope_residue).toBeTruthy();
    expect(p.scope_residue.not_searched.map((r: { scope: string }) => r.scope))
      .toContain('session_turn');
    expect(p.scope_residue.caveat).toMatch(/NOT AN ABSENCE CLAIM/);
  });

  it('discloses unsearched plan items even when work-items and decisions have hits', async () => {
    ftResult = {
      results: [{ source: 'turns', source_id: 't1', excerpt: 'e', highlight: 'h', score: 0.5 }],
      totalHits: 1,
    };
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'duplicates', scope: ['work_item', 'decisions'] } as never, CTX() as never);
    const p = payloadOf(res as never);
    expect(p.total_hits).toBe(1);
    expect(p.results).toHaveLength(1);
    expect(p.scope_residue.searched).toEqual(['decisions', 'work_item']);
    expect(p.scope_residue.not_searched.find((row: { scope: string }) => row.scope === 'plan').holds)
      .toMatch(/P-NNN.*draft.*unstarted/i);
    expect(p.scope_residue.caveat).toMatch(/NOT AN ABSENCE CLAIM/);
    expect(p.scope_residue.caveat).not.toMatch(/THIS ZERO/);
  });

  it('CALIBRATION: a zero over scope:["all"] has no residue — nothing was left out', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['all'] } as never, CTX() as never);
    const p = payloadOf(res as never);
    expect(p.total_hits).toBe(0);
    expect(p.scope_residue).toBeUndefined();
  });
});

describe('search:semantic — scope residue', () => {
  it('discloses the unsearched corpora on a zero, same as fulltext', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x', scope: ['turns'] } as never, CTX() as never);
    const p = payloadOf(res as never);

    expect(p.total_hits).toBe(0);
    expect(p.scope_residue.not_searched.map((r: { scope: string }) => r.scope))
      .toContain('session_turn');
  });

  it('keeps plan-item exclusions visible alongside positive semantic matches', async () => {
    hybridResult = {
      results: [{ source: 'turns', source_id: 't1', excerpt: 'e', highlight: 'h', score: 0.5 }],
      totalHits: 1,
      embedderAvailable: true,
    };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'duplicates', scope: ['work_item', 'decisions'] } as never, CTX() as never);
    const p = payloadOf(res as never);
    expect(p.total_hits).toBe(1);
    expect(p.scope_residue.not_searched.find((row: { scope: string }) => row.scope === 'plan').holds)
      .toMatch(/P-NNN.*draft.*unstarted/i);
  });
});
