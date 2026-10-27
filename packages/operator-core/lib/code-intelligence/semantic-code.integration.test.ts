import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { extractSemanticFunctions, SemanticCodeIndex, semanticRepositoryId, type SemanticCodeEmbedder } from './semantic-code';
import { collectSemanticSweepCandidates, refreshSemanticCode, semanticCodeProvider, semanticConceptQuery, semanticSimilarQuery } from './semantic-code-runtime';
import { buildCloneIndex } from './clone-index';
import { composeReuseBrief, type ReuseContribution } from './reuse-brief-providers';
import { createHash } from 'node:crypto';

let db: FreshPgDb;
let root: string;
let repositoryId: string;
let documentCalls = 0;
let outage = false;
let queryOutage = false;
let mutateDuringEmbedding = false;
const pay = 'export function settle(invoice: number) { const balance = invoice - 1; return balance; }';
const sky = 'export function forecast(cloud: number) { return cloud * 2; }';
// A named, controlled embedding fixture proves storage/fusion independently of
// the sidecar's relevance quality. It is NOT production calibration evidence.
const fixture: SemanticCodeEmbedder = {
  profile: 'semantic-controlled-fixture@v1', dimensions: 4,
  async document(text) {
    documentCalls++;
    if (outage) throw new Error('fixture sidecar unavailable');
    if (mutateDuringEmbedding) writeFileSync(join(root, 'pay.ts'), sky);
    return text.includes('invoice') ? [1, 0, 0, 0] : [0, 1, 0, 0];
  },
  async query(text) {
    if (queryOutage) throw new Error('fixture query unavailable');
    return text.includes('weather') ? [0, 1, 0, 0] : [1, 0, 0, 0];
  },
};
const index = (workspaceId = 'semantic-test', profile = fixture.profile) => new SemanticCodeIndex(db.sql,
  { workspaceId, repositoryId, profile, dimensions: 4 }, { ...fixture, profile });

beforeAll(async () => {
  db = await createFreshPgDb('semantic-code');
  const file = resolve(dirname(fileURLToPath(import.meta.url)),
    '../../../../libs/papercusp/libs/db/sql/1568-semantic-code-index.sql');
  await applyMigrationForTest(db.sql, existsSync(file) ? file : `${file}.DRAFT`);
}, 120_000);
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.semantic_code_files CASCADE`;
  root = mkdtempSync(join(tmpdir(), 'semantic-code-'));
  repositoryId = await semanticRepositoryId(root);
  writeFileSync(join(root, 'pay.ts'), pay);
  writeFileSync(join(root, 'sky.ts'), sky);
  documentCalls = 0; outage = false; queryOutage = false; mutateDuringEmbedding = false;
});
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
afterAll(async () => { await db?.cleanup(); });

describe('P012 semantic code index in real pgvector', () => {
  it('uses identified hybrid relevance independently of cosine and exposes each score in its own units', async () => {
    const base = index();
    const store = new SemanticCodeIndex(db.sql, base.space, { ...fixture, query: async () => [.6, .8, 0, 0],
      relevance: { id: 'controlled-hybrid', score: async (_query, pool) => pool.map(row => ({
        relevanceScore: row.path === 'pay.ts' ? .9 : .1, crossEncoderRelevance: .8,
      })) } });
    await store.updateFile(root, 'pay.ts'); await store.updateFile(root, 'sky.ts');
    const result = await store.search(root, 'compensation disbursement', { diagnostics: true });
    expect(result).toMatchObject({ vectorStatus: 'measured', relevanceStatus: 'measured', relevanceMethod: 'controlled-hybrid' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: 'pay.ts', relevanceScore: .9, crossEncoderRelevance: .8 });
    expect(result.matches[0].cosineSimilarity).toBeCloseTo(.6);
    expect(result.diagnostics?.scoredCandidates).toHaveLength(2);
  });
  it('refuses malformed or unavailable relevance and detects source drift during scoring before suggestions', async () => {
    const base = index(); await base.updateFile(root, 'pay.ts');
    for (const score of [async () => { throw new Error('controlled rerank outage'); }, async () => []]) {
      const failed = new SemanticCodeIndex(db.sql, base.space, { ...fixture, relevance: { id: 'controlled', score } });
      expect(await failed.search(root, 'invoice')).toMatchObject({ vectorStatus: 'measured', relevanceStatus: 'unknown', matches: [] });
    }
    const raced = new SemanticCodeIndex(db.sql, base.space, { ...fixture, relevance: { id: 'controlled', score: async (_query, pool) => {
      writeFileSync(join(root, 'pay.ts'), sky);
      return pool.map(() => ({ relevanceScore: .99, crossEncoderRelevance: .99 }));
    } } });
    expect(await raced.search(root, 'invoice')).toMatchObject({ matches: [], stalePaths: ['pay.ts'] });
  });
  it('retains source-checked uncut calibration diagnostics without admitting a below-cutoff candidate', async () => {
    const store = index(); await store.updateFile(root, 'pay.ts'); await store.updateFile(root, 'sky.ts');
    const result = await store.search(root, 'compensation disbursement', { diagnostics: true });
    expect(result.relevanceCutoff).toBe(.70);
    expect(result.matches.map(fn => fn.path)).toEqual(['pay.ts']);
    expect(result.diagnostics?.rawTop10.map(fn => [fn.path, fn.eligible])).toEqual([['pay.ts', true], ['sky.ts', false]]);
    expect(result.diagnostics?.rawTop10[1].cosineSimilarity).toBe(0);
  });
  it('reindexes the same blob when its summary recipe changes and fails closed on summary outage', async () => {
    const base = index(); await base.updateFile(root, 'pay.ts');
    const enriched = new SemanticCodeIndex(db.sql, base.space, { ...fixture, summaryVersion: 'behavior-test-v1',
      summarize: async fn => `${fn.summary} — Decrements an invoice balance by one.` });
    expect(await enriched.updateFile(root, 'pay.ts')).toMatchObject({ changed: true });
    expect((await enriched.search(root, 'invoice')).matches[0].summary).toContain('Decrements');
    const failed = new SemanticCodeIndex(db.sql, base.space, { ...fixture, summaryVersion: 'behavior-test-v2',
      summarize: async () => { throw new Error('controlled summary outage'); } });
    await expect(failed.updateFile(root, 'pay.ts')).rejects.toThrow('summary outage');
    expect((await failed.search(root, 'invoice')).matches).toEqual([]);
    expect((await enriched.search(root, 'invoice')).matches).toEqual([]);
  });
  it('retrieves bounded off-hook Type-4 candidates and retains abstention/outage as unfileable judgments', async () => {
    const sources = [ { path: 'pay.ts', source: pay },
      { path: 'other.ts', source: 'export function disburse(invoice: number) { let total = invoice; total -= 1; return total; }' } ];
    writeFileSync(join(root, 'other.ts'), sources[1].source);
    const clones = buildCloneIndex(sources, { minMass: 1 });
    const result = await collectSemanticSweepCandidates(root, clones, index(), {
      model: 'controlled-replay-v1', harness: 'test', maxPairs: 1, maxFiles: 2,
      call: async () => { throw new Error('controlled gateway outage'); } });
    expect(result).toMatchObject({ status: 'ok', examinedPairs: 1, bounded: true });
    expect(result.candidates[0].judgment).toMatchObject({ status: 'unknown', output: null });
    queryOutage = true;
    expect(await collectSemanticSweepCandidates(root, clones, index(), {
      model: 'controlled-replay-v1', harness: 'test', maxPairs: 1, maxFiles: 2 })).toMatchObject({ status: 'unknown', candidates: [] });
  });
  it('finds a differently worded concept through stored vectors and fuses compiler evidence', async () => {
    const store = index();
    await store.updateFile(root, 'pay.ts'); await store.updateFile(root, 'sky.ts');
    const result = await store.search(root, 'compensation disbursement', { graphIds: ['pay.ts:0'] });
    expect(result.vectorStatus).toBe('measured');
    expect(result.matches[0]).toMatchObject({ name: 'settle', path: 'pay.ts', rankers: ['graph', 'vector'] });
    expect(result.matches[0].summary).toContain('invoice');
    expect(result.matches[0].normalizedBody).toContain('balance');
    expect(result.ranking).toContain('not probability');
    expect(result.completeness).toBe('bounded-index-lower-bound');
    expect((await store.search(root, 'weather')).matches[0].path).toBe('sky.ts');
    const [row] = await db.sql`SELECT vector_dims(embedding) AS dimensions FROM harness_shared.semantic_code_functions LIMIT 1`;
    expect(row.dimensions).toBe(4);
  });
  it('skips unchanged blobs and atomically replaces all functions after a changed blob', async () => {
    const store = index(); await store.updateFile(root, 'pay.ts');
    expect(await store.updateFile(root, 'pay.ts')).toMatchObject({ changed: false });
    expect(documentCalls).toBe(1);
    writeFileSync(join(root, 'pay.ts'), sky);
    const stale = await store.search(root, 'disbursement');
    expect(stale.matches).toEqual([]); expect(stale.stalePaths).toEqual(['pay.ts']);
    await store.updateFile(root, 'pay.ts');
    expect((await store.search(root, 'weather')).matches.map(row => row.name)).toEqual(['forecast']);
    expect(documentCalls).toBe(2);
    const [count] = await db.sql`SELECT count(*)::int AS n FROM harness_shared.semantic_code_functions`;
    expect(count.n).toBe(1);
  });
  it('retains lexical and compiler retrieval when query inference is unavailable', async () => {
    const store = index(); await store.updateFile(root, 'pay.ts'); queryOutage = true;
    const lexical = await store.search(root, 'invoice');
    expect(lexical).toMatchObject({ vectorStatus: 'unknown', vectorError: 'fixture query unavailable' });
    expect(lexical.matches[0].rankers).toEqual(['lexical']);
    const graph = await store.search(root, 'different words', { graphIds: ['pay.ts:0'] });
    expect(graph.matches[0]).toMatchObject({ name: 'settle', rankers: ['graph'] });
    expect((await store.search(root, 'different words', { graphIds: ['pay.ts:1'] })).matches[0].rankers).toEqual(['graph']);
  });
  it('never retains old blob vectors after an embedding outage or source race', async () => {
    const store = index(); await store.updateFile(root, 'pay.ts');
    writeFileSync(join(root, 'pay.ts'), sky); outage = true;
    await expect(store.updateFile(root, 'pay.ts')).rejects.toThrow('unavailable');
    expect((await store.search(root, 'invoice')).matches).toEqual([]);
    outage = false; writeFileSync(join(root, 'pay.ts'), pay); mutateDuringEmbedding = true;
    await expect(store.updateFile(root, 'pay.ts')).rejects.toThrow('changed during embedding');
    const [row] = await db.sql`SELECT state FROM harness_shared.semantic_code_files`;
    expect(row.state).toBe('failed');
    const [count] = await db.sql`SELECT count(*)::int AS n FROM harness_shared.semantic_code_functions`;
    expect(count.n).toBe(0);
  });
  it('isolates workspace, repository, profile and path scopes and rejects bad vector dimensions', async () => {
    const store = index(); await store.updateFile(root, 'pay.ts');
    expect((await index('other-workspace').search(root, 'invoice')).matches).toEqual([]);
    expect((await index('semantic-test', 'other-profile@v1').search(root, 'invoice')).matches).toEqual([]);
    expect((await store.search(root, 'invoice', { paths: ['sky.ts'] })).matches).toEqual([]);
    const otherRoot = mkdtempSync(join(tmpdir(), 'semantic-other-'));
    try { await expect(store.search(otherRoot, 'invoice')).rejects.toThrow('repository identity'); }
    finally { rmSync(otherRoot, { recursive: true, force: true }); }
    await expect(store.search(root, 'invoice', { paths: ['../escape.ts'] })).rejects.toThrow('relative');
    const bad = new SemanticCodeIndex(db.sql, { ...store.space }, { ...fixture, query: async () => [1] });
    expect((await bad.search(root, 'invoice')).vectorStatus).toBe('unknown');
  });
  it('prunes deletion and refuses symlink escape, malformed source and classified files', async () => {
    const store = index(); await store.updateFile(root, 'pay.ts'); rmSync(join(root, 'pay.ts'));
    await expect(store.updateFile(root, 'pay.ts')).rejects.toThrow();
    expect((await store.search(root, 'invoice')).matches).toEqual([]);
    symlinkSync('/etc/passwd', join(root, 'escape.ts'));
    await expect(store.updateFile(root, 'escape.ts')).rejects.toThrow('escapes repository');
    writeFileSync(join(root, 'broken.ts'), 'export function (');
    await expect(store.updateFile(root, 'broken.ts')).rejects.toThrow('syntax-error');
    expect(extractSemanticFunctions({ path: 'sample.test.ts', source: pay })).toEqual([]);
    const [fn] = extractSemanticFunctions({ path: 'src/sample.ts', source: pay.replace('const', '// comment\n const') });
    expect(fn.normalizedBody).not.toContain('// comment');
  });
  it('runs off-hook refresh and runtime query adapters through the same persistent index', async () => {
    const store = index(), open = async () => store;
    const refreshed = await refreshSemanticCode(root, 'semantic-test', ['pay.ts', 'sky.ts'], undefined, open);
    expect(refreshed.complete).toBe(true);
    const result = await semanticConceptQuery(root, 'semantic-test', 'compensation disbursement', {}, open);
    expect(result.matches[0].name).toBe('settle');
    const similar = await semanticSimilarQuery(root, 'semantic-test', { snippet: pay, paths: ['pay.ts', 'sky.ts'] }, undefined, open);
    expect(similar).toMatchObject({ candidateOnly: true, calibration: { status: 'unknown' } });
    expect(similar.matches[0].name).toBe('settle');
    const ambiguous = await semanticSimilarQuery(root, 'semantic-test', { name: 'settle' }, undefined, open);
    expect(ambiguous.status).toBe('unknown');
    const unavailable = await semanticConceptQuery(root, undefined, 'invoice', {}, open);
    expect(unavailable).toMatchObject({ status: 'unknown', matches: [] });
    expect(documentCalls).toBe(2); // Queries did not perform document inference.
  });
  it('suggests source-checked anchors in the shared capped authoring composer and preserves the mandatory base', async () => {
    const store = index(); await store.updateFile(root, 'pay.ts');
    const provider = semanticCodeProvider(async () => store);
    const context = { surface: 'authoring' as const, workspaceId: 'semantic-test', owner: 'su-test', invocation: 'author-dispatch',
      paths: [], sourceFiles: [], sourceVersion: createHash('sha256').update('[]').digest('hex'),
      itemText: 'compensation disbursement', repository: { workspaceId: 'semantic-test', rootPath: root } };
    const base: { mandatory: string; impact: ReuseContribution[] } = { mandatory: 'Original item text and anchors', impact: [] };
    const result = await composeReuseBrief({ base, context, providers: [provider], deadline: Date.now() + 6000,
      append: (brief, contribution) => ({ ...brief, impact: [...brief.impact, contribution] }) });
    expect(base.impact).toEqual([]); expect(result.brief.mandatory).toBe(base.mandatory);
    expect(result.brief.impact[0].text).toContain('Suggested anchor, semantic candidate: pay.ts:1 settle');
    expect(result.observations[0]).toMatchObject({ provider: 'semantic', status: 'issued' });
    expect((await provider.read({ ...context, surface: 'claim' }, new AbortController().signal)).lines[0]).toContain('no anchors');
    expect((await provider.read({ ...context, sourceVersion: 'stale' }, new AbortController().signal)).status).toBe('unknown');
    writeFileSync(join(root, 'pay.ts'), sky);
    expect((await provider.read(context, new AbortController().signal)).lines).toEqual([]);
  });
});
