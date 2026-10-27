import { describe, expect, it } from 'vitest';
import { decodeDocsSearchCapture, DOCS_FINAL_INPUT_CONTRACT } from './adapter-baseline-capture';

function fixture() {
  const args = { query: 'retrieval quality', harness: 'engineering', semantic: true, limit: 2 };
  const response = { query: args.query, surface: 'engineering', hitCount: 37,
    legs: { degraded: false, lexical: { status: 'ran' }, semantic: { status: 'ran' } },
    hits: [{ slug: 'known-doc', url: '/internal/docs/known-doc', title: 'Retrieval quality',
      excerpt: 'Only if approved. Never promote untrusted content.\n…', score: 0.2,
      trust: { superseded: true, correction: 'Read the current authority first.' } }] };
  return { expected: { id: 'opportunity-1', args }, response,
    saved: { schemaVersion: 1, adapter: 'docs:search', attemptId: 'opportunity-1',
      request: structuredClone(args), exitCode: 0, stdout: JSON.stringify(response), deliveryWallMs: 123 } };
}

describe('real docs adapter capture inputs', () => {
  it('preserves the complete delivered row and response without another excerpt or metric inference', () => {
    const f = fixture();
    f.response.hits[0]!.excerpt += ' Long qualifier. '.repeat(800);
    f.saved.stdout = JSON.stringify(f.response);
    const result = decodeDocsSearchCapture(f.saved, f.expected);
    expect(result.inputContract).toBe(DOCS_FINAL_INPUT_CONTRACT);
    expect(result.hits[0]).toMatchObject({ docId: 'known-doc', rank: 1, source: 'docs:search', score: 0.2 });
    expect(JSON.parse(result.hits[0]!.docText)).toEqual(f.response.hits[0]);
    expect(result.hits[0]!.docText.length).toBeGreaterThan(10_000);
    expect(result.response).toEqual(f.response);
    expect(result.clientDeliveryWallMs).toBe(123);
    expect(result).not.toHaveProperty('quality');
    expect(result).not.toHaveProperty('costUsd');
    expect(result).not.toHaveProperty('pins');
  });

  it.each(['query', 'harness', 'limit', 'semantic'] as const)('rejects changed %s requests', key => {
    const f = fixture();
    const changed = { ...f.saved, request: { ...f.saved.request, [key]: 'different' } };
    expect(() => decodeDocsSearchCapture(changed, f.expected)).toThrow(/request differs/);
  });

  it.each(['adapter', 'attemptId'] as const)('rejects a foreign %s capture', key => {
    const f = fixture();
    expect(() => decodeDocsSearchCapture({ ...f.saved, [key]: 'foreign' }, f.expected)).toThrow(/adapter or attempt/);
  });

  it('preserves delivered order instead of sorting on a native or fused score', () => {
    const f = fixture();
    f.response.hits.push({ ...f.response.hits[0]!, slug: 'higher-scored-second', score: 99 });
    f.saved.stdout = JSON.stringify(f.response);
    expect(decodeDocsSearchCapture(f.saved, f.expected).hits.map(h => [h.docId, h.rank]))
      .toEqual([['known-doc', 1], ['higher-scored-second', 2]]);
  });

  it('keeps a degraded response explicit and a successful empty response empty', () => {
    const f = fixture();
    f.response.legs.degraded = true;
    f.response.hits = [];
    f.saved.stdout = JSON.stringify(f.response);
    expect(decodeDocsSearchCapture(f.saved, f.expected)).toMatchObject({ degraded: true, hits: [] });
  });

  it.each([{ _partial: true }, { _projection: { truncated: true } },
    { content_truncated: true }, { __truncated: 'missing final fields' }])('refuses partial transport evidence %j', marker => {
    const f = fixture();
    f.saved.stdout = JSON.stringify({ ...f.response, ...marker });
    expect(() => decodeDocsSearchCapture(f.saved, f.expected)).toThrow(/partial delivered/);
  });

  it('detects a nested omitted row while allowing a literal marker in document text', () => {
    const f = fixture();
    f.response.hits[0]!.excerpt = 'An explanation of _partial and [TRUNCATED] markers.';
    f.saved.stdout = JSON.stringify(f.response);
    expect(decodeDocsSearchCapture(f.saved, f.expected).hits).toHaveLength(1);
    f.saved.stdout = JSON.stringify({ ...f.response, hits: [{ ...f.response.hits[0], __truncated: 'omitted' }] });
    expect(() => decodeDocsSearchCapture(f.saved, f.expected)).toThrow(/partial delivered/);
  });

  it('refuses errors, missing durations, malformed output and output envelopes', () => {
    const f = fixture();
    for (const saved of [{ ...f.saved, exitCode: 5 }, { ...f.saved, deliveryWallMs: null },
      { ...f.saved, stdout: 'not JSON' }, { ...f.saved, stdout: '{"state":"incomplete","content":[]}' }]) {
      expect(() => decodeDocsSearchCapture(saved, f.expected)).toThrow();
    }
  });

  it('does not turn missing observations, scope changes or duplicate rows into healthy emptiness', () => {
    const f = fixture();
    for (const response of [{ ...f.response, legs: {} }, { ...f.response, query: 'other query' },
      { ...f.response, surface: 'harness', harness_slug: 'other' },
      { ...f.response, hits: [f.response.hits[0], f.response.hits[0]] },
      { ...f.response, hits: [{ slug: 'incomplete-row' }] }]) {
      expect(() => decodeDocsSearchCapture({ ...f.saved, stdout: JSON.stringify(response) }, f.expected)).toThrow();
    }
  });

  it('binds harness responses to the exact harness and enforces the delivered cutoff', () => {
    const f = fixture();
    f.expected.args.harness = 'fixture-harness';
    f.saved.request.harness = 'fixture-harness';
    const response = { ...f.response, surface: 'harness', harness_slug: 'fixture-harness' };
    expect(decodeDocsSearchCapture({ ...f.saved, stdout: JSON.stringify(response) }, f.expected).hits).toHaveLength(1);
    expect(() => decodeDocsSearchCapture({ ...f.saved, stdout: JSON.stringify({ ...response, harness_slug: 'foreign' }) }, f.expected))
      .toThrow(/scope/);
    f.expected.args.limit = 1; f.saved.request.limit = 1;
    expect(() => decodeDocsSearchCapture({ ...f.saved, stdout: JSON.stringify({ ...response,
      hits: [f.response.hits[0], { ...f.response.hits[0], slug: 'extra' }] }) }, f.expected)).toThrow(/cutoff/);
  });
});
