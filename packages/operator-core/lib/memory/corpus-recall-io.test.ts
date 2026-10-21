/**
 * Live-leg tests for the P-008 second retrieval corpus (D-037).
 *
 * The search engine, the embedder, PG and the flag store are all mocked — what
 * is under test here is the CONTRACT this leg hands the engine (which sources,
 * which scopeFilter, which budgets) and its degradation behaviour, not the
 * engine's own retrieval.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryWorkDeadline } from './op-deadline';
import { currentStageDiagnosticContext } from '../sync/hyperbee/stage-stall-log';
import type { pgResultDiagnosticSnapshot } from '@papercusp/db-org';

type PgDiagnosticRow = ReturnType<typeof pgResultDiagnosticSnapshot>['results'][number];
const pgDiagnosticRows = vi.hoisted(() => [] as Array<Partial<PgDiagnosticRow>>);
const acquisitionDiagnosticControl = vi.hoisted(() => ({
  counters: null as null | ((pool: string) => unknown),
  tickets: null as null | ((pool: string) => unknown),
  signalAborted: null as null | (() => boolean),
  observed: [] as Array<{ kind: 'counters' | 'tickets'; pool: string; signalAborted: boolean | null }>,
}));
const runHybridSearch = vi.fn();
const buildQueryEmbedder = vi.fn(async () => (async () => [0.1, 0.2]) as unknown);
const getFlag = vi.fn(async () => true);
const planSource = vi.fn(() => ({ name: 'plan' }));
const docSource = vi.fn(() => ({ name: 'doc' }));
const reportSource = vi.fn(() => ({ name: 'report' }));
vi.mock('../agent-tools/search/knowledge-sources', () => ({ createPlanSearchSource: planSource, createDocSearchSource: docSource }));
vi.mock('../agent-tools/search/report-source', () => ({ createReportSearchSource: reportSource }));

/** The owner→own-session lookup runs through this tagged template. Default: the
 *  caller owns nothing, i.e. no exclusions. */
const sql = vi.fn(async (..._args: unknown[]) => [] as Array<{ session_id: string }>);
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql }),
    pgResultDiagnosticSnapshot: (pool: string, limit?: number) => {
      const snapshot = actual.pgResultDiagnosticSnapshot(pool, limit);
      return { ...snapshot, results: pgDiagnosticRows.slice(-(limit ?? 32)) as typeof snapshot.results };
    },
    acquireSnapshot: (pool: string) => {
      acquisitionDiagnosticControl.observed.push({ kind: 'counters', pool,
        signalAborted: acquisitionDiagnosticControl.signalAborted?.() ?? null });
      return (acquisitionDiagnosticControl.counters?.(pool) as ReturnType<typeof actual.acquireSnapshot> | undefined)
        ?? actual.acquireSnapshot(pool);
    },
    acquireTicketSnapshot: (pool: string) => {
      acquisitionDiagnosticControl.observed.push({ kind: 'tickets', pool,
        signalAborted: acquisitionDiagnosticControl.signalAborted?.() ?? null });
      return (acquisitionDiagnosticControl.tickets?.(pool) as ReturnType<typeof actual.acquireTicketSnapshot> | undefined)
        ?? actual.acquireTicketSnapshot(pool);
    },
  };
});
// Partial mock over `importOriginal`, never a hand-listed factory: a factory
// replaces the module wholesale, so ANY export a transitively-imported module
// touches at load time (configureSearchDefaults via P-017, createEmbeddingSpace
// via lib/search/prose-vector-dims.ts) fails COLLECTION. WI-10004518.
vi.mock('@papercusp/search', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runHybridSearch,
  configureSearchDefaults: vi.fn(),
}));
vi.mock('../agent-tools/search/sources', () => ({
  SEARCH_SOURCES: [
    { name: 'escalations' },
    { name: 'brainstorm' },
    { name: 'turns' },
    { name: 'decisions' },
    { name: 'work_item' },
    { name: 'session_turn' },
    { name: 'coord_message' },
    { name: 'plan' },
    { name: 'doc' },
    { name: 'report' },
  ],
}));
vi.mock('../agent-tools/search/embedder', async () => ({
  ...(await import('../search/embedder-mode-registry')),
  buildQueryEmbedder,
}));
vi.mock('@papercusp/flags', () => ({ FLAGS: { MEMORY_CORPUS_RECALL: 'papercusp-memory-corpus-recall' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag }));

const {
  recallCorpusContext,
  warmCorpusEmbedder,
  resetCorpusEmbedderWarmup,
  CORPUS_RECENCY_HALF_LIFE_MS,
  CORPUS_RECENCY_WEIGHT,
  corpusSearchStageBudgetMs,
  corpusCanRunSecondSearch,
} = await import('./corpus-recall-io');

const hit = (over: Record<string, unknown> = {}) => ({
  source: 'work_item',
  source_id: 'WI-6512',
  scope: 'harness:papercusp',
  excerpt: '[bug/open/major] http2 transport regression on the sse endpoint',
  highlight: '',
  score: 0.032,
  ts: null,
  rankers: ['bm25'],
  ...over,
});

const ok = (results: unknown[] = [hit()]) => ({
  results,
  totalHits: results.length,
  embedderAvailable: true,
});

const QUERY = 'why did the http2 transport change on the sse endpoint';
const base = { queryText: QUERY, workspaceId: 'ws-1' };

beforeEach(() => {
  vi.clearAllMocks();
  runHybridSearch.mockReset();
  pgDiagnosticRows.length = 0;
  acquisitionDiagnosticControl.counters = null;
  acquisitionDiagnosticControl.tickets = null;
  acquisitionDiagnosticControl.signalAborted = null;
  acquisitionDiagnosticControl.observed.length = 0;
  sql.mockResolvedValue([]);
  getFlag.mockResolvedValue(true);
  buildQueryEmbedder.mockResolvedValue((async () => [0.1, 0.2]) as unknown);
  delete process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS;
  // The embedder warm state is per-PROCESS by design (EI-19460902984682209), so
  // without this a warmup kicked off by an earlier test silently supplies the
  // NEXT test's embedder — which is exactly how two tests here first went red:
  // one asserting the cold path saw a live embedder, one asserting an embed
  // count saw a stale embedder from a previous test's mock and counted zero.
  resetCorpusEmbedderWarmup();
});

it('does not start a second corpus search after the parent prompt expired', async () => {
  const parent = new AbortController();
  let release!: (result: ReturnType<typeof ok>) => void;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  runHybridSearch.mockImplementationOnce(async () => {
    started();
    return await new Promise<ReturnType<typeof ok>>((resolve) => { release = resolve; });
  });
  const recall = recallCorpusContext({ ...base, signal: parent.signal });
  await didStart;
  const options = runHybridSearch.mock.calls[0][1];
  expect(options.signal).toBeInstanceOf(AbortSignal);
  parent.abort(new Error('obsolete prompt'));
  expect((await recall).outcome).toBe('timed-out');
  expect(options.signal.aborted).toBe(true);
  release(ok([]));
  await new Promise((resolve) => setImmediate(resolve));
  expect(runHybridSearch).toHaveBeenCalledOnce();
});

it('cancels the session_turn BM25 catalog read inside its bounded read-only transaction', async () => {
  const { SEARCH_SOURCES } = await vi.importActual<typeof import('../agent-tools/search/sources')>('../agent-tools/search/sources');
  const { resetBm25Availability } = await import('../search/lexical/rank');
  resetBm25Availability();
  const sessionTurn = SEARCH_SOURCES.find((source) => source.name === 'session_turn')!;
  const controller = new AbortController();
  const reason = new Error('source budget expired');
  let resolveCatalogStart!: (source: string) => void;
  const catalogStarted = new Promise<string>((resolve) => { resolveCatalogStart = resolve; });
  const transactionQueries: string[] = [];
  const rawQueries: string[] = [];
  let rejectCatalog!: (error: unknown) => void;
  const cancel = vi.fn(() => rejectCatalog(new Error('postgres query canceled')));

  const tag = (source: 'raw' | 'transaction') => (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    (source === 'raw' ? rawQueries : transactionQueries).push(query);
    if (query.includes('FROM pg_index')) {
      resolveCatalogStart(source);
      const pending = new Promise<never>((_resolve, reject) => { rejectCatalog = reject; });
      controller.signal.addEventListener('abort', () => rejectCatalog(reason), { once: true });
      return Object.assign(pending, {
        cancel,
        executed: true,
        active: true,
      });
    }
    return Promise.resolve([]);
  };
  const tx = Object.assign(tag('transaction'), { unsafe: vi.fn(() => Promise.resolve([])) });
  const begin = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(tx));
  const sourceSql = Object.assign(tag('raw'), {
    begin,
    unsafe: vi.fn(() => Promise.resolve([])),
  }) as never;

  const sourceCall = sessionTurn.lexical({
    sql: sourceSql,
    query: 'unique cancellation query',
    workspaceId: 'ws-1',
    scopeFilter: null,
    limit: 3,
    signal: controller.signal,
  });
  const sourceAssertion = expect(sourceCall).rejects.toBe(reason);

  expect(await catalogStarted).toBe('transaction');
  controller.abort(reason);
  await sourceAssertion;

  expect(begin).toHaveBeenCalledOnce();
  expect(transactionQueries[0]).toMatch(/SET TRANSACTION READ ONLY/i);
  expect(transactionQueries.some((query) => query.includes('FROM pg_index'))).toBe(true);
  expect(rawQueries.some((query) => query.includes('FROM pg_index'))).toBe(false);
  expect(cancel).toHaveBeenCalledOnce();
  resetBm25Availability();
});

it('uses the owning SQL client cache so a second session_turn call skips only the availability transaction', async () => {
  const { SEARCH_SOURCES } = await vi.importActual<typeof import('../agent-tools/search/sources')>('../agent-tools/search/sources');
  const { resetBm25Availability } = await import('../search/lexical/rank');
  resetBm25Availability();
  const sessionTurn = SEARCH_SOURCES.find((source) => source.name === 'session_turn')!;
  const transactionQueries: string[] = [];
  let beginCount = 0;
  const tx = Object.assign((strings: TemplateStringsArray) => {
    const query = strings.join('?');
    transactionQueries.push(query);
    return Promise.resolve([]);
  }, { unsafe: vi.fn(() => Promise.resolve([])) });
  const sourceSql = Object.assign(
    (strings: TemplateStringsArray) => Promise.resolve([]),
    {
      unsafe: vi.fn(() => Promise.resolve([])),
      begin: async (callback: (transaction: unknown) => Promise<unknown>) => {
        beginCount++;
        return callback(tx);
      },
    },
  ) as never;
  const params = {
    sql: sourceSql,
    query: 'two words',
    workspaceId: 'ws-1',
    scopeFilter: null,
    limit: 3,
  };

  await sessionTurn.lexical(params);
  expect(beginCount).toBe(2); // availability miss + primary read
  expect(transactionQueries.filter((query) => query.includes('FROM pg_index'))).toHaveLength(1);

  await sessionTurn.lexical(params);
  expect(beginCount).toBe(3); // cache hit adds no availability transaction
  expect(transactionQueries.filter((query) => query.includes('FROM pg_index'))).toHaveLength(1);
  resetBm25Availability();
});

describe('recallCorpusContext — the contract handed to the search engine', () => {
  it('keeps a useful source window without consuming the later-stage reserve', () => {
    expect(corpusSearchStageBudgetMs(95, false)).toBe(80);
    expect(corpusSearchStageBudgetMs(1_000, false)).toBe(500);
    expect(corpusSearchStageBudgetMs(1_000, true)).toBe(250);
    expect(corpusSearchStageBudgetMs(0, false)).toBe(1);
  });

  it('skips the underfill cascade unless two minimum source windows remain', () => {
    expect(corpusCanRunSecondSearch(159)).toBe(false);
    expect(corpusCanRunSecondSearch(160)).toBe(true);
  });

  it('keeps first-stage hits when a caller deadline cannot fund another source search', async () => {
    const deadline = createMemoryWorkDeadline(120);
    runHybridSearch
      .mockResolvedValueOnce(ok([hit()]))
      .mockResolvedValueOnce(ok([hit({ source_id: 'WI-2' })]));
    try {
      const result = await recallCorpusContext({ ...base, signal: deadline.signal, deadline });
      expect(result.outcome).toBe('ok');
      expect(result.block).toContain('http2 transport regression');
      expect(runHybridSearch).toHaveBeenCalledOnce();
    } finally {
      deadline.close();
    }
  });

  it('reads the registered session/work-item and complete knowledge sources', async () => {
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext(base);
    const [sources] = runHybridSearch.mock.calls[0];
    expect((sources as Array<{ name: string }>).map((s) => s.name).sort()).toEqual([
      'doc',
      'plan',
      'report',
      'session_turn',
      'work_item',
    ]);
  });

  it('binds agent visibility and ambient exclusions before source ranking', async () => {
    runHybridSearch.mockResolvedValue(ok([hit({ source: 'doc', source_id: 'harness:papercusp:repair',
      excerpt: 'http2 transport prerequisite: keep snapshot', meta: { section: 'Repair' } })]));
    const excluded = new Set(['report:R-secret']);
    const result = await recallCorpusContext({ ...base,harnessSlugs: ['papercusp'],
      excludeOwnerId: 'su-me',ambientExcludedRefs: excluded });
    expect(planSource).toHaveBeenCalledWith({ harnessSlugs: ['papercusp'],automatic: true,excludedRefs: excluded });
    expect(docSource).toHaveBeenCalledWith({ harnessSlugs: ['papercusp'],automatic: true,excludedRefs: excluded });
    expect(reportSource).toHaveBeenCalledWith({ ownerId: 'su-me',potSlug: 'papercusp' },
      { harnessSlugs: ['papercusp'],automatic: true,excludedRefs: excluded });
    expect(result.block).toContain('doc:');
    expect(result.block).toContain('docs:get');
    expect(result.block).toContain('keep snapshot');
  });

  it('preserves the prose query profile across memoization instead of borrowing a mem0 profile', async () => {
    const { stampEmbedderMode,embedderModeOf,embedderProfileIdOf } = await import('../search/embedder-mode-registry');
    const { EMBEDDER_DIM_SPECS } = await import('@papercusp/memory');
    const prose = vi.fn(async()=>Array(EMBEDDER_DIM_SPECS.gemma.targetDims).fill(0.1));
    stampEmbedderMode(prose,'gemma',EMBEDDER_DIM_SPECS.gemma.profileId);
    buildQueryEmbedder.mockResolvedValue(prose);
    await warmCorpusEmbedder();
    prose.mockClear(); // Warmup has its own probe; count only the recall's query.
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext(base);
    const options = runHybridSearch.mock.calls[0][1];
    expect(options.embedder).not.toBe(prose);
    expect(embedderModeOf(options.embedder)).toBe('gemma');
    expect(embedderProfileIdOf(options.embedder)).toBe(EMBEDDER_DIM_SPECS.gemma.profileId);
    expect(embedderProfileIdOf(options.embedder)).not.toBe(EMBEDDER_DIM_SPECS.local.profileId);
    expect(await options.embedder('transport')).toHaveLength(EMBEDDER_DIM_SPECS.gemma.targetDims);
    expect(await options.embedder('transport')).toHaveLength(EMBEDDER_DIM_SPECS.gemma.targetDims);
    expect(prose).toHaveBeenCalledOnce();
  });

  it('does not widen a public-host recall into plan/doc/report corpora', async () => {
    const engine = await vi.importActual<typeof import('@papercusp/search')>('@papercusp/search');
    runHybridSearch.mockResolvedValue({ ...ok(),legs: engine.emptyLegs() });
    const result = await recallCorpusContext({ ...base,knowledgeSourcesAllowed: false });
    expect(runHybridSearch.mock.calls[0][0].map((s: { name: string })=>s.name).sort())
      .toEqual(['session_turn','work_item']);
    expect(planSource).not.toHaveBeenCalled();
    expect(docSource).not.toHaveBeenCalled();
    expect(reportSource).not.toHaveBeenCalled();
    expect(result.stages?.[0]?.lexical.sourceCalls).toEqual(expect.arrayContaining(
      ['plan','doc','report'].map(source => expect.objectContaining({ source,status: 'not-run',rows: null,
        reason: 'knowledge source not granted by host' })),
    ));
  });

  it('joins terminal PG query identity and timing to one corpus source call', async () => {
    const engine = await vi.importActual<typeof import('@papercusp/search')>('@papercusp/search');
    runHybridSearch.mockImplementation(engine.runHybridSearch);
    const { SEARCH_SOURCES } = await import('../agent-tools/search/sources');
    const source = SEARCH_SOURCES.find(candidate => candidate.name === 'session_turn')!;
    const mutableSource = source as unknown as { lexical?: typeof source.lexical };
    const oldLexical = mutableSource.lexical;
    let nextQueryId = 187;
    mutableSource.lexical = async () => {
      const context = currentStageDiagnosticContext();
      expect(context?.attemptId).toBeTruthy();
      pgDiagnosticRows.push({
        pool: 'org-admin',
        connectionId: 7,
        queryId: nextQueryId++,
        backendPid: 4812,
        elapsedMs: 11,
        preBuildMs: 2,
        status: 'ok',
        correlation: context ?? undefined,
      });
      return [];
    };
    try {
      const result = await recallCorpusContext({ ...base, knowledgeSourcesAllowed: false });
      const sourceCall = result.stages?.[0]?.lexical.sourceCalls?.find(call => call.source === 'session_turn');
      expect(sourceCall?.queryDiagnostics).toMatchObject({
        attemptId: expect.any(String),
        timing: 'query-build-to-terminal-not-acquisition',
        coverage: 'completed-query-results-only',
        snapshotCapacity: 32,
        queries: [expect.objectContaining({
          connectionId: 7,
          queryId: 187,
          backendPid: 4812,
          elapsedMs: 11,
          preBuildMs: 2,
          status: 'ok',
        })],
      });
    } finally {
      if (oldLexical) mutableSource.lexical = oldLexical;
      else delete mutableSource.lexical;
      runHybridSearch.mockReset();
    }
  });

  it('keeps a doc section and source receipts through the real engine when a plan source stalls', async () => {
    const engine = await vi.importActual<typeof import('@papercusp/search')>('@papercusp/search');
    runHybridSearch.mockImplementation(engine.runHybridSearch);
    let stalledSignal: AbortSignal | undefined;
    planSource.mockImplementation(() => ({ name: 'plan', lexical: async (params: { signal?: AbortSignal }) => {
      stalledSignal = params.signal;
      return await new Promise<never>(() => {});
    } }));
    const row = hit({ source: 'doc',source_id: 'harness:papercusp:repair',
      excerpt: 'http2 transport repair prerequisite: keep snapshot',score: 1,
      meta: { section: 'Repair' } });
    docSource.mockImplementation(() => ({ name: 'doc',lexical: async () => [{ key: 'doc:repair',row,score: 1 }] }));
    reportSource.mockImplementation(() => ({ name: 'report',lexical: async () => [] }));
    process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS = '800';
    try {
      const result = await recallCorpusContext({ ...base,harnessSlugs: ['papercusp'],excludeOwnerId: 'su-me' });
      expect(result.outcome).toBe('ok');
      expect(result.block).toContain('keep snapshot');
      expect(stalledSignal?.aborted).toBe(true);
      expect(result.stages?.[0]?.lexical.sourceCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'plan',status: 'timed-out',rows: null }),
        expect.objectContaining({ source: 'doc',status: 'ran',rows: 1 }),
        expect.objectContaining({ source: 'report',status: 'ran',rows: 0 }),
      ]));
      expect(result.stages?.[0]?.semantic.sourceCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'plan',status: 'not-run' }),
      ]));
    } finally {
      planSource.mockImplementation(() => ({ name: 'plan' }));
      docSource.mockImplementation(() => ({ name: 'doc' }));
      reportSource.mockImplementation(() => ({ name: 'report' }));
    }
  });

  it('retains healthy sources when both plan rankers stall under a shorter native caller deadline', async () => {
    const engine = await vi.importActual<typeof import('@papercusp/search')>('@papercusp/search');
    runHybridSearch.mockImplementation(engine.runHybridSearch);
    await warmCorpusEmbedder();
    const stalled = vi.fn(async () => await new Promise<never>(() => {}));
    planSource.mockImplementation(() => ({ name: 'plan', lexical: stalled, embedding: stalled }));
    const row = hit({ source: 'doc', source_id: 'harness:papercusp:repair',
      excerpt: 'http2 transport repair prerequisite: keep snapshot', score: 1,
      meta: { section: 'Repair' } });
    docSource.mockImplementation(() => ({ name: 'doc', lexical: async () => [{ key: 'doc:repair', row, score: 1 }] }));
    reportSource.mockImplementation(() => ({ name: 'report', lexical: async () => [] }));
    const deadline = createMemoryWorkDeadline(400);
    try {
      const result = await recallCorpusContext({ ...base, harnessSlugs: ['papercusp'],
        excludeOwnerId: 'su-me', signal: deadline.signal, deadline });
      expect(result.outcome).toBe('ok');
      expect(result.block).toContain('keep snapshot');
      expect(result.stages).toHaveLength(2);
      for (const stage of result.stages!) {
        expect(stage.lexical.sourceCalls).toEqual(expect.arrayContaining([
          expect.objectContaining({ source: 'plan', status: 'timed-out', rows: null }),
          expect.objectContaining({ source: 'doc', status: 'ran', rows: 1 }),
        ]));
        expect(stage.semantic.sourceCalls).toEqual(expect.arrayContaining([
          expect.objectContaining({ source: 'plan', status: 'timed-out', rows: null }),
        ]));
      }
      expect(deadline.signal.aborted).toBe(false);
    } finally {
      deadline.close();
      planSource.mockImplementation(() => ({ name: 'plan' }));
      docSource.mockImplementation(() => ({ name: 'doc' }));
      reportSource.mockImplementation(() => ({ name: 'report' }));
    }
  });

  it('captures acquisition snapshots at the source timeout edge before aborting the source', async () => {
    const engine = await vi.importActual<typeof import('@papercusp/search')>('@papercusp/search');
    runHybridSearch.mockImplementation(engine.runHybridSearch);
    let sourceSignal: AbortSignal | undefined;
    acquisitionDiagnosticControl.signalAborted = () => sourceSignal?.aborted ?? false;
    acquisitionDiagnosticControl.counters = pool => ({
      pool, waiting: 2, oldestWaitMs: 231, held: 6, oldestHeldMs: 804, max: 12,
      totalAcquired: 48, lastAcquiredAgoMs: 3,
    });
    acquisitionDiagnosticControl.tickets = pool => ({
      pool, capacity: 8, active: 2, omitted: 0,
      tickets: [
        { state: 'waiting', ageMs: 231, requestId: null, operation: 'memory-corpus-search' },
        { state: 'held', ageMs: 804, requestId: null, operation: 'memory-corpus-search' },
      ],
    });
    planSource.mockImplementation(() => ({ name: 'plan', lexical: async (params: { signal?: AbortSignal }) => {
      sourceSignal = params.signal;
      return await new Promise<never>(() => {});
    } }));
    const deadline = createMemoryWorkDeadline(200);
    try {
      const result = await recallCorpusContext({ ...base, harnessSlugs: ['papercusp'],
        signal: deadline.signal, deadline });
      const sourceCall = result.stages?.flatMap(stage => stage.lexical.sourceCalls ?? [])
        .find(call => call.source === 'plan' && call.ranker === 'lexical');
      expect(sourceCall?.status).toBe('timed-out');
      expect(sourceCall?.queryDiagnostics).toMatchObject({
        coverage: 'completed-query-results-only',
        acquisitionAtTimeout: {
          timing: 'source-timeout-before-abort',
          counters: { pool: 'org-admin', waiting: 2, held: 6, max: 12 },
          tickets: { pool: 'org-admin', active: 2, tickets: [
            { state: 'waiting', ageMs: 231, requestId: null, operation: 'memory-corpus-search' },
            { state: 'held', ageMs: 804, requestId: null, operation: 'memory-corpus-search' },
          ] },
        },
      });
      expect(acquisitionDiagnosticControl.observed).toEqual([
        { kind: 'counters', pool: 'org-admin', signalAborted: false },
        { kind: 'tickets', pool: 'org-admin', signalAborted: false },
      ]);
      expect(sourceSignal?.aborted).toBe(true);
    } finally {
      deadline.close();
      planSource.mockImplementation(() => ({ name: 'plan' }));
    }
  });

  it('keeps a healthy lexical source that completes within a short caller deadline', async () => {
    const engine = await vi.importActual<typeof import('@papercusp/search')>('@papercusp/search');
    runHybridSearch.mockImplementation(engine.runHybridSearch);
    const row = hit({ source: 'doc', source_id: 'harness:papercusp:repair',
      excerpt: 'http2 transport repair prerequisite: keep snapshot', score: 1,
      meta: { section: 'Repair' } });
    planSource.mockImplementation(() => ({ name: 'plan' }));
    docSource.mockImplementation(() => ({ name: 'doc', lexical: async (params: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 75);
        params.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('doc source was aborted before its result was ready'));
        }, { once: true });
      });
      return [{ key: 'doc:short-deadline', row, score: 1 }];
    } }));
    reportSource.mockImplementation(() => ({ name: 'report' }));
    const deadline = createMemoryWorkDeadline(150);
    try {
      const result = await recallCorpusContext({ ...base, harnessSlugs: ['papercusp'],
        signal: deadline.signal, deadline });
      expect(result.outcome).toBe('ok');
      expect(result.block).toContain('keep snapshot');
      expect(result.stages?.[0]?.lexical.sourceCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'doc', status: 'ran', rows: 1 }),
      ]));
      expect(result.stages).toHaveLength(1);
      expect(deadline.signal.aborted).toBe(false);
    } finally {
      deadline.close();
      planSource.mockImplementation(() => ({ name: 'plan' }));
      docSource.mockImplementation(() => ({ name: 'doc' }));
      reportSource.mockImplementation(() => ({ name: 'report' }));
    }
  });

  it('enables the recency re-rank (P-009) with the documented tunables', async () => {
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext(base);
    const [, ctx] = runHybridSearch.mock.calls[0];
    const recency = (ctx as { recency?: Record<string, unknown> }).recency;
    expect(recency).toEqual({
      halfLifeMs: CORPUS_RECENCY_HALF_LIFE_MS,
      weight: CORPUS_RECENCY_WEIGHT,
      getTime: expect.any(Function),
    });
  });

  it('preserves source timestamps and keeps current procedural/plan guidance eligible', async () => {
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext(base);
    const [, ctx] = runHybridSearch.mock.calls[0];
    const getTime = (ctx as { recency: { getTime: (hit: { source: string; ts: string }) => unknown } }).recency.getTime;
    const ts = '2026-01-01T00:00:00Z';
    expect(getTime({ source: 'work_item',ts })).toBe(ts);
    expect(getTime({ source: 'report',ts })).toBe(ts);
    expect(getTime({ source: 'doc',ts })).not.toBe(ts);
    expect(getTime({ source: 'plan',ts })).not.toBe(ts);
  });

  it('does NOT enable the fresh-candidate window — it labels hits lexical-fresh', async () => {
    // freshWindowMs adds a second BM25 leg whose hits carry a `lexical-fresh`
    // ranker, which any agreement measure would count as a second ranker
    // agreeing. Off deliberately, not by omission — see the call site.
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext(base);
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { recency?: Record<string, unknown> }).recency).not.toHaveProperty(
      'freshWindowMs',
    );
  });

  it('passes scopeFilter: null — the regression that would silently empty this leg', async () => {
    // 396,798 of 396,826 session turns carry harness_slug IS NULL, so a
    // harness-scoped SQL filter leaves the turn leg able to match at most 28
    // rows: structurally empty while every surface reports healthy. Harness
    // narrowing belongs in the pure core, on work-items only.
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext({ ...base, harnessSlugs: ['papercusp'] });
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { scopeFilter: unknown }).scopeFilter).toBeNull();
    expect((ctx as { workspaceId: string }).workspaceId).toBe('ws-1');
  });

  it('sends the COMPACT query, never the raw prompt envelope', async () => {
    // The engine ANDs every lexeme; a 1000-char turn-start envelope (the
    // measured median) would match nothing at all.
    runHybridSearch.mockResolvedValue(ok());
    const envelope = `${'envelope preamble boilerplate '.repeat(40)}${QUERY}`;
    await recallCorpusContext({ ...base, queryText: envelope });
    const [, ctx] = runHybridSearch.mock.calls[0];
    const sent = (ctx as { query: string }).query;
    expect(sent.length).toBeLessThan(40);
    expect(sent.split(' ').length).toBeLessThanOrEqual(2);
  });

  it('sends a work-item id ALONE when the turn mentions one', async () => {
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext({ ...base, queryText: 'what happened with WI-6512 and the sse leg' });
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { query: string }).query).toBe('wi-6512');
  });

  it('skips a query with nothing searchable in it', async () => {
    const res = await recallCorpusContext({ ...base, queryText: 'a of to the and' });
    expect(res.block).toBeNull();
    expect(runHybridSearch).not.toHaveBeenCalled();
  });

  it('over-fetches so the pure core has candidates left after filtering', async () => {
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext({ ...base, maxItems: 3 });
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { limit: number }).limit).toBeGreaterThanOrEqual(12);
    expect((ctx as { mode: string }).mode).toBe('hybrid');
  });

  it('still narrows work-items by harness — in the pure core, not the SQL', async () => {
    runHybridSearch.mockResolvedValue(
      ok([hit({ source_id: 'WI-999', scope: 'harness:other' })]),
    );
    const res = await recallCorpusContext({ ...base, harnessSlugs: ['papercusp'] });
    expect(res.lines).toHaveLength(0);
    expect(res.dropped).toContainEqual({ ref: 'WI-999', reason: 'out-of-scope' });
  });
});

describe('recallCorpusContext — output', () => {
  it('renders a self-contained matched-excerpt block from a hit', async () => {
    runHybridSearch.mockResolvedValue(ok());
    const res = await recallCorpusContext(base);
    expect(res.block).toContain('WI-6512');
    expect(res.block).toContain('http2 transport regression');
    expect(res.block).not.toContain("work_items:get { id: 'WI-6512' }");
    expect(res.candidateCount).toBe(1);
    expect(res.embedderAvailable).toBe(true);
  });

  it('drops the caller’s own turns, resolved from its OWNER id', async () => {
    runHybridSearch.mockResolvedValue(
      ok([hit({ source: 'session_turn', source_id: 'claude:sess-self:4', scope: null })]),
    );
    sql.mockResolvedValue([{ session_id: 'sess-self' }]);
    const res = await recallCorpusContext({ ...base, excludeOwnerId: 'su-me' });
    expect(res.block).toBeNull();
    expect(res.dropped).toContainEqual({ ref: 'claude:sess-self', reason: 'self-session' });
  });

  it('filters a strongly matching ambient holdout while retaining a strong non-holdout', async () => {
    // The holdout is first and the cap is one, so a missing IO→selector fence
    // would return WI-40293 and make this regression falsely look green only if
    // the excluded row happened to rank weakly.
    runHybridSearch.mockResolvedValue(
      ok([hit({ source_id: 'WI-40293' }), hit({ source_id: 'WI-71001' })]),
    );
    const res = await recallCorpusContext({
      ...base,
      ambientExcludedRefs: new Set(['WI-40293']),
      maxItems: 1,
    });
    expect(res.lines.map((l) => l.handle.ref)).toEqual(['WI-71001']);
    expect(res.dropped).toContainEqual({ ref: 'WI-40293', reason: 'ambient-excluded' });
  });

  it('drops EVERY session the owner lookup returns, and keeps the ones it does not', async () => {
    // The regression this guards is the one that shipped: the filter keyed on a
    // SINGLE session id while both injection ports pass an OWNER id, so it never
    // fired at all (EI-19460887729945170). Owner-wide is the unit.
    runHybridSearch.mockResolvedValue(
      ok([
        hit({ source: 'session_turn', source_id: 'claude:sess-live:1', scope: null }),
        hit({ source: 'session_turn', source_id: 'claude:sess-prior:7', scope: null }),
        hit({ source: 'session_turn', source_id: 'claude:sess-peer:2', scope: null }),
      ]),
    );
    sql.mockResolvedValue([{ session_id: 'sess-live' }, { session_id: 'sess-prior' }]);
    const res = await recallCorpusContext({ ...base, excludeOwnerId: 'su-me' });
    expect(res.dropped).toContainEqual({ ref: 'claude:sess-live', reason: 'self-session' });
    expect(res.dropped).toContainEqual({ ref: 'claude:sess-prior', reason: 'self-session' });
    expect(res.lines.map((l) => l.handle.ref)).toEqual(['claude:sess-peer']);
  });

  it('asks the owner lookup ONLY about the sessions in the candidate pool', async () => {
    // Bounded by the candidates, never by the owner's lifetime history — an agent
    // running for weeks must not turn this into an unbounded scan.
    runHybridSearch.mockResolvedValue(
      ok([hit({ source: 'session_turn', source_id: 'claude:sess-live:1', scope: null })]),
    );
    await recallCorpusContext({ ...base, excludeOwnerId: 'su-me' });
    const values = sql.mock.calls[0]?.slice(1);
    expect(values).toContain('su-me');
    expect(values).toContainEqual(['sess-live']);
  });

  it('issues no owner lookup at all when there is no owner to exclude', async () => {
    runHybridSearch.mockResolvedValue(
      ok([hit({ source: 'session_turn', source_id: 'claude:sess-live:1', scope: null })]),
    );
    const res = await recallCorpusContext(base);
    expect(sql).not.toHaveBeenCalled();
    expect(res.lines.map((l) => l.handle.ref)).toEqual(['claude:sess-live']);
  });

  it('degrades to NO exclusion when the owner lookup throws — never a dead leg', async () => {
    runHybridSearch.mockResolvedValue(
      ok([hit({ source: 'session_turn', source_id: 'claude:sess-live:1', scope: null })]),
    );
    sql.mockRejectedValue(new Error('pg down'));
    const res = await recallCorpusContext({ ...base, excludeOwnerId: 'su-me' });
    expect(res.lines.map((l) => l.handle.ref)).toEqual(['claude:sess-live']);
  });

  it('returns an empty block, not null, when the engine returns nothing', async () => {
    runHybridSearch.mockResolvedValue(ok([]));
    const res = await recallCorpusContext(base);
    expect(res.block).toBeNull();
    expect(res.lines).toEqual([]);
  });
});

describe('recallCorpusContext — degradation (never throws, never blocks a turn)', () => {
  it('is a no-op when the flag is OFF', async () => {
    getFlag.mockResolvedValue(false);
    const res = await recallCorpusContext(base);
    expect(res.block).toBeNull();
    expect(runHybridSearch).not.toHaveBeenCalled();
  });

  it('stays ON when the flag store itself fails — a default-ON feature must not fail closed', async () => {
    getFlag.mockRejectedValue(new Error('flags down'));
    runHybridSearch.mockResolvedValue(ok());
    const res = await recallCorpusContext(base);
    expect(res.block).toContain('WI-6512');
  });

  it('skips an empty query without touching the engine', async () => {
    const res = await recallCorpusContext({ ...base, queryText: '   ' });
    expect(res.block).toBeNull();
    expect(runHybridSearch).not.toHaveBeenCalled();
  });

  it('swallows a throwing search', async () => {
    runHybridSearch.mockRejectedValue(new Error('pg down'));
    await expect(recallCorpusContext(base)).resolves.toMatchObject({ block: null });
  });

  it('gives up on its own wall-clock bound instead of stalling the turn', async () => {
    process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS = '20';
    runHybridSearch.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok()), 500)),
    );
    const t0 = Date.now();
    const res = await recallCorpusContext(base);
    expect(res.block).toBeNull();
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it('runs BM25-only when no embedder resolves (a cold ONNX start must not stall)', async () => {
    buildQueryEmbedder.mockResolvedValue(null as unknown);
    runHybridSearch.mockResolvedValue({ ...ok(), embedderAvailable: false });
    const res = await recallCorpusContext(base);
    expect(res.block).toContain('WI-6512');
    expect(res.embedderAvailable).toBe(false);
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { embedder: unknown }).embedder).toBeNull();
  });

  /**
   * EI-19460902984682209 — the COLD-START regression guard.
   *
   * Measured on this box: acquiring the embedder costs ~1374ms and its first
   * embed ~2222ms, against a whole-leg bound of 2000ms. Awaiting acquisition
   * inline therefore spent the leg's entire deadline discovering the embedder
   * was not ready, and the FIRST call in every fresh process returned an empty
   * block — indistinguishable from "nothing relevant". Single-variable arms,
   * same bound: 2003ms/0 lines inline vs 1197ms/6 lines when the acquisition is
   * off the critical path.
   *
   * This is the falsifier: an acquisition that NEVER settles must not cost the
   * leg anything. Revert to an inline `await buildQueryEmbedder(...)` and the
   * leg stalls until its bound and hands back a null block, failing here.
   */
  it('never awaits embedder acquisition — a never-resolving acquire costs the leg nothing', async () => {
    buildQueryEmbedder.mockReturnValue(new Promise<unknown>(() => {})); // never settles
    runHybridSearch.mockResolvedValue({ ...ok(), embedderAvailable: false });
    const t0 = Date.now();
    const res = await recallCorpusContext(base);
    expect(res.block).toContain('WI-6512');
    expect(res.outcome).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(200);
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { embedder: unknown }).embedder).toBeNull();
  });

  it('the FIRST call runs BM25-only even when acquisition would succeed, then warms for later ones', async () => {
    runHybridSearch.mockResolvedValue({ ...ok(), embedderAvailable: false });
    const cold = await recallCorpusContext(base);
    expect(cold.block).toContain('WI-6512'); // the cold call still ANSWERS
    expect((runHybridSearch.mock.calls[0][1] as { embedder: unknown }).embedder).toBeNull();

    await warmCorpusEmbedder();
    runHybridSearch.mockClear();
    await recallCorpusContext(base);
    expect((runHybridSearch.mock.calls[0][1] as { embedder: unknown }).embedder).not.toBeNull();
  });

  it('accepts the longer boot acquisition budget so startup can finish a cold warm', async () => {
    const warmed = await warmCorpusEmbedder({ acquireBudgetMs: 60_000 });

    expect(warmed).toBe(true);
    expect(buildQueryEmbedder).toHaveBeenCalledWith({ acquireBudgetMs: 60_000 });
  });

  it('a failed acquisition does not latch — a later call retries', async () => {
    buildQueryEmbedder.mockResolvedValue(null as unknown);
    await warmCorpusEmbedder();
    buildQueryEmbedder.mockResolvedValue((async () => [0.1, 0.2]) as unknown);
    await warmCorpusEmbedder();
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext(base);
    expect((runHybridSearch.mock.calls[0][1] as { embedder: unknown }).embedder).not.toBeNull();
  });

  /**
   * `lines: []` used to wear five faces at once. The dangerous pair is
   * `timed-out` (the leg never finished — says NOTHING about the corpus) and a
   * completed run that genuinely found nothing; reading the first as the second
   * is what hid this bug for the leg's whole life.
   */
  it('distinguishes a bound expiry from a genuinely empty corpus', async () => {
    process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS = '20';
    runHybridSearch.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok()), 500)),
    );
    const timedOut = await recallCorpusContext(base);
    expect(timedOut.outcome).toBe('timed-out');
    expect(timedOut.lines).toEqual([]);
    expect(timedOut.timeout).toMatchObject({ scope: 'backend-operation', phase: 'corpus-leg' });
    expect(timedOut.timeout?.elapsedMs).toBeGreaterThanOrEqual(0);

    delete process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS;
    runHybridSearch.mockReset();
    runHybridSearch.mockResolvedValue(ok([]));
    const reallyEmpty = await recallCorpusContext(base);
    expect(reallyEmpty.outcome).toBe('ok'); // ran to completion, found nothing
    expect(reallyEmpty.lines).toEqual([]);
  });

  it('reports why it declined to run at all', async () => {
    getFlag.mockResolvedValue(false);
    expect((await recallCorpusContext(base)).outcome).toBe('disabled');
    getFlag.mockResolvedValue(true);
    expect((await recallCorpusContext({ ...base, queryText: 'a of to the and' })).outcome).toBe(
      'no-query',
    );
    runHybridSearch.mockRejectedValue(new Error('pg down'));
    expect((await recallCorpusContext(base)).outcome).toBe('failed');
  });
});

/**
 * P-017 / D-062 R2 — the two-stage cascade.
 *
 * The property under test is ADDITIVITY: stage 2 may only fill slots stage 1
 * left empty, never displace what stage 1 admitted. That is not a nicety — a
 * single coverage-graded query (the shape this replaced) was measured live over
 * 120 real turns to LOSE 180 admitted lines across 79 queries, 18 of them the
 * control's top-1, while the mean admitted count stayed flat. It swapped
 * results rather than adding them, because the leg's overlap guard, 6-item cap
 * and char budget are applied over a REORDERED walk.
 */
describe('recallCorpusContext — the P-017 cascade', () => {
  const wi = (id: string, over: Record<string, unknown> = {}) =>
    hit({ source_id: id, excerpt: `[bug/open/major] ${id} transport regression on the sse endpoint`, ...over });

  // `vi.clearAllMocks()` in the outer beforeEach does NOT drain a queued
  // `mockResolvedValueOnce`, so a test whose queue outlives it leaks into the
  // next one. Caught the hard way: a cap-1 case queued two responses, the
  // cascade correctly short-circuited after one, and the survivor rewrote the
  // FOLLOWING test's stage-1 result.
  beforeEach(() => {
    runHybridSearch.mockReset();
  });

  it('does NOT fire stage 2 when stage 1 already fills the cap — one engine call, mode `and`', async () => {
    runHybridSearch.mockResolvedValue(ok([wi('WI-1'), wi('WI-2')]));
    await recallCorpusContext({ ...base, maxItems: 2 });
    expect(runHybridSearch).toHaveBeenCalledTimes(1);
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { lexicalMode: string }).lexicalMode).toBe('and');
  });

  it('fires stage 2 ONLY on under-fill, and asks for `coverage-graded` the second time', async () => {
    runHybridSearch
      .mockResolvedValueOnce(ok([wi('WI-1')]))
      .mockResolvedValueOnce(ok([wi('WI-1'), wi('WI-2')]));
    const res = await recallCorpusContext(base);
    expect(runHybridSearch).toHaveBeenCalledTimes(2);
    expect((runHybridSearch.mock.calls[0][1] as { lexicalMode: string }).lexicalMode).toBe('and');
    expect((runHybridSearch.mock.calls[1][1] as { lexicalMode: string }).lexicalMode).toBe(
      'coverage-graded',
    );
    // Stage 1's line is kept AND the graded-only hit is appended after it.
    expect(res.lines.map((l) => l.handle.ref)).toEqual(['WI-1', 'WI-2']);
  });

  it('ADDITIVITY — higher-agreement graded hits cannot evict a stage-1 line by filling the cap ahead of it', async () => {
    // The exact case a naive concat-then-select gets wrong. `selectCorpusLines`
    // orders by multi-ranker agreement BEFORE input order, so over the merged
    // list [WI-1, WI-2, WI-3] with a cap of 2 it would admit WI-2 and WI-3 (both
    // bm25+embeddings) and drop WI-1 (bm25 only) as cap-exhausted — losing a
    // line the AND query had already admitted. The cascade computes stage 1
    // first and gives stage 2 only the LEFTOVER cap, so WI-1 cannot be reached.
    //
    // ⚠ The cap must exceed stage 1's yield or stage 2 never fires and this
    // test passes vacuously — which is exactly how the first draft was wrong.
    runHybridSearch
      .mockResolvedValueOnce(ok([wi('WI-1')]))
      .mockResolvedValueOnce(
        ok([
          wi('WI-1'),
          wi('WI-2', { rankers: ['bm25', 'embeddings'] }),
          wi('WI-3', { rankers: ['bm25', 'embeddings'] }),
        ]),
      );
    const res = await recallCorpusContext({ ...base, maxItems: 2 });
    expect(runHybridSearch).toHaveBeenCalledTimes(2); // stage 2 really ran
    expect(res.lines.map((l) => l.handle.ref)).toEqual(['WI-1', 'WI-2']);

    // SELF-PROVING: show the naive merge really does drop WI-1 on this fixture.
    // Without this, a change that made the fixture non-discriminating would
    // leave the assertion above passing while guarding nothing.
    const { selectCorpusLines } = await import('./corpus-recall');
    const naive = selectCorpusLines({
      hits: [
        wi('WI-1'),
        wi('WI-2', { rankers: ['bm25', 'embeddings'] }),
        wi('WI-3', { rankers: ['bm25', 'embeddings'] }),
      ].map((h) => ({
        source: h.source,
        sourceId: h.source_id,
        scope: h.scope,
        excerpt: h.excerpt,
        highlight: h.highlight,
        score: h.score,
        ts: h.ts,
        rankers: h.rankers,
      })),
      queryText: QUERY,
      harnessSlugs: [],
      maxItems: 2,
    });
    expect(naive.lines.map((l) => l.handle.ref)).toEqual(['WI-2', 'WI-3']);
    expect(naive.dropped).toContainEqual({ ref: 'WI-1', reason: 'cap-exhausted' });
  });

  it('stage 2 never re-offers a hit stage 1 already saw (no duplicate lines)', async () => {
    runHybridSearch
      .mockResolvedValueOnce(ok([wi('WI-1')]))
      .mockResolvedValueOnce(ok([wi('WI-1'), wi('WI-1'), wi('WI-2')]));
    const res = await recallCorpusContext(base);
    const refs = res.lines.map((l) => l.handle.ref);
    expect(refs).toEqual(['WI-1', 'WI-2']);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('embeds ONCE across both stages — the cascade must not double the embed bill', async () => {
    const embed = vi.fn(async () => [0.1, 0.2]);
    buildQueryEmbedder.mockResolvedValue(embed as unknown);
    // The leg only ever uses an ALREADY-warm embedder, so warm it explicitly —
    // this is the hybrid path, and without the warmup the cascade would
    // correctly run BM25-only and embed zero times.
    await warmCorpusEmbedder();
    embed.mockClear(); // the warmup itself embeds once; count only the cascade
    runHybridSearch.mockImplementation(async (_s: unknown, ctx: { embedder: ((t: string) => Promise<number[]>) | null }) => {
      // The engine calls the embedder itself; both stages share one context.
      if (ctx.embedder) await ctx.embedder(QUERY);
      return ok([wi('WI-1')]);
    });
    await recallCorpusContext(base);
    expect(runHybridSearch).toHaveBeenCalledTimes(2);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('the whole cascade stays inside the one whole-leg bound (a slow stage 2 cannot extend it)', async () => {
    process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS = '40';
    runHybridSearch
      .mockResolvedValueOnce(ok([wi('WI-1')]))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(ok()), 500)));
    const t0 = Date.now();
    const res = await recallCorpusContext(base);
    expect(res.block).toBeNull();
    expect(Date.now() - t0).toBeLessThan(400);
  });
});
