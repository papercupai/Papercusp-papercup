import { describe, expect, it, vi } from 'vitest';
import { scoreSemanticRelevance, type RelevanceCandidate } from './semantic-code-relevance';
import retained from './__fixtures__/semantic-calibration-v2-diagnostics.json';
import frozen from './__fixtures__/semantic-calibration-v1.json';

const candidate = (id: string): RelevanceCandidate => ({ id, path: `src/${id}.ts`, blobSha: 'blob',
  name: id, line: 1, column: 1, summary: 'behavior', normalizedBody: '{ return 1; }', cosineSimilarity: .60 });

describe('semantic relevance scoring in distinct cross-encoder units', () => {
  it('scores exact summary/body inputs and applies the preregistered .70 boundary independently of raw cosine', async () => {
    const rows = [candidate('a'), candidate('b'), candidate('c')];
    const scorer = vi.fn(async () => [.6999, .70, .9]);
    const deadline = Date.now() + 15_000;
    const result = await scoreSemanticRelevance('query', rows, scorer, deadline);
    expect(scorer).toHaveBeenCalledWith('query', rows.map(row => `${row.summary}\n${row.normalizedBody}`), { deadline });
    expect(result.status).toBe('measured');
    expect(result.scored.map(row => row.relevanceEligible)).toEqual([false, true, true]);
    expect(result.matches.map(row => row.id)).toEqual(['c', 'b']);
    expect(result.matches.every(row => row.cosineSimilarity === .60)).toBe(true);
    expect(rows[0]).not.toHaveProperty('relevanceScore');
  });
  it('uses stable location tie breaks without reordering raw receipts', async () => {
    const result = await scoreSemanticRelevance('query', [candidate('b'), candidate('a')], async () => [.8, .8]);
    expect(result.scored.map(row => row.id)).toEqual(['b', 'a']);
    expect(result.matches.map(row => row.id)).toEqual(['a', 'b']);
  });
  it('scores retained behavioral summary passages alone in the separately registered C edition', async () => {
    const scorer = vi.fn(async () => [.8]);
    const row = candidate('a'), deadline = Date.now() + 15_000;
    const result = await scoreSemanticRelevance('query', [row], scorer, deadline, 'summary');
    expect(scorer).toHaveBeenCalledWith('query', [row.summary], { deadline });
    expect(result.scored[0]?.normalizedBody).toBe(row.normalizedBody);
    expect(result.matches).toHaveLength(1);
  });
  it('keeps outage, malformed and out-of-unit scores unknown without retrieval passthrough', async () => {
    for (const scores of [[], [NaN], [Infinity], [-.01], [1.01], [.8, .9]]) {
      const result = await scoreSemanticRelevance('query', [candidate('a')], async () => scores);
      expect(result).toMatchObject({ status: 'unknown', scored: [], matches: [] });
    }
    expect(await scoreSemanticRelevance('query', [candidate('a')], async () => { throw new Error('outage'); }))
      .toMatchObject({ status: 'unknown', error: 'outage', matches: [] });
  });
  it('refuses duplicate, excessive or expired candidate requests before inference', async () => {
    const scorer = vi.fn(async () => [.9]);
    for (const rows of [[candidate('a'), candidate('a')], Array.from({ length: 11 }, (_, i) => candidate(String(i)))]) {
      expect((await scoreSemanticRelevance('query', rows, scorer)).status).toBe('unknown');
    }
    expect((await scoreSemanticRelevance('query', [candidate('a')], scorer, Date.now() - 1)).status).toBe('unknown');
    expect(scorer).not.toHaveBeenCalled();
  });
  it('retains the complete frozen query/label population and ten aligned candidates for each query', () => {
    expect(retained.queries.map(row => [row.id, row.query, row.relevant]))
      .toEqual(frozen.samples.map(row => [row.id, row.query, row.relevant]));
    expect(retained.documents).toHaveLength(20);
    for (const row of retained.queries) {
      expect(row.diagnostics.rawTop10).toHaveLength(10);
      expect(new Set(row.diagnostics.rawTop10.map(hit => hit.id)).size).toBe(10);
      for (const hit of row.diagnostics.rawTop10) {
        expect(retained.documents.find(doc => doc.function_id === hit.id)).toMatchObject({ path: hit.path,
          blob_sha: hit.blobSha, summary: hit.summary, normalized_body: hit.normalizedBody });
      }
    }
  });
});
