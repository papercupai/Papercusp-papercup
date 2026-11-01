import { describe, expect, it } from 'vitest';
import { captureRetainedCoverage, parseProseCaptureRequests, requireCaptureDatabase } from './prose-adapter-capture-cli';

const request = { id: 'work-lexical', adapter: 'search:fulltext',
  args: { query: 'scope witness', scope: ['work_item'], harness_slug: 'papercusp', limit: 5 } };
const dsn = 'postgres://test@127.0.0.1:24567/search_baseline_0123456789abcdef';
const env = { PAPERCUSP_TEST_PG_ADMIN_URL: dsn, HARNESS_ADMIN_DATABASE_URL: dsn, HARNESS_DATABASE_URL: dsn,
  PAPERCUSP_WORKSPACE_ID: 'corpus-workspace', PAPERCUSP_MEMORY_EMBEDDER: 'gemma', PAPERCUSP_EMBED_DEVICE: 'cpu',
  PAPERCUSP_TRANSFORMERS_LOCAL_ONLY: '1', PAPERCUSP_SKIP_PG_DISCOVERY: '1' };

describe('retained direct prose adapter capture boundaries', () => {
  it('uses production eligible and stale predicates and rejects impossible counts', async () => {
    const queries: string[] = [];
    let impossible = false;
    const sql = { unsafe: async (query: string) => {
      queries.push(query);
      if (query.includes('information_schema.columns')) return [
        'embedding', 'text_embedding', 'embedding_mode', 'text_embedding_mode',
        'embedding_recipe', 'text_embedding_recipe',
      ].map(column_name => ({ column_name }));
      return [{ total_rows: '10', eligible_rows: '8', embedded_rows: impossible ? '9' : '6',
        recent_eligible: '3', recent_embedded: '2', settled_eligible: '2', settled_embedded: '1' }];
    } };
    const result = await captureRetainedCoverage(sql);
    const work = result.readings.find(row => row.surface === 'harness_shared.work_items.embedding');
    expect(work).toMatchObject({ status: 'measured', reading: { totalRows: 10,
      eligibleRows: 8, embeddedRows: 6, ineligibleRows: 2, backlog: 2, eligibleCoverage: 0.75 } });
    expect(queries.some(query => query.includes('FILTER (WHERE') && query.includes('NOT ('))).toBe(true);
    expect(queries.every(query => query.startsWith('SELECT'))).toBe(true);
    impossible = true;
    const invalid = await captureRetainedCoverage(sql);
    expect(invalid.readings.find(row => row.surface === 'harness_shared.work_items.embedding'))
      .toMatchObject({ status: 'unknown', reason: 'coverage measurement failed' });
  });
  it('keeps unretained tables unknown and isolates failed surface measurements without writes', async () => {
    const queries: string[] = [];
    const result = await captureRetainedCoverage({ unsafe: async (query) => {
      queries.push(query);
      throw new Error('private connection detail');
    } });
    expect(result).toMatchObject({ queryGateChanged: false, baselineAccepted: false });
    expect(result.readings.length).toBeGreaterThan(2);
    expect(result.readings.every(row => row.status === 'unknown')).toBe(true);
    expect(result.readings).toContainEqual({ surface: 'harness_shared.harness_plans.embedding',
      status: 'unknown', reason: 'table data not retained' });
    expect(queries.every(query => query.startsWith('SELECT'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private connection detail');
  });
  it('preserves explicit requests and rejects scope widening or implicit defaults', () => {
    expect(parseProseCaptureRequests([request])).toEqual([request]);
    for (const args of [{ ...request.args, scope: ['all'] }, { ...request.args, scope: [] },
      { ...request.args, scope: ['work_item', 'work_item'] }, { ...request.args, harness_slug: '' },
      { ...request.args, limit: undefined }, { ...request.args, owner: 'self' }])
      expect(() => parseProseCaptureRequests([{ ...request, args }])).toThrow();
  });
  it('rejects duplicates, unsupported adapters, empty populations and fulltext mode', () => {
    for (const rows of [[], [request, request], [{ ...request, adapter: 'docs:search' }],
      [{ ...request, args: { ...request.args, mode: 'hybrid' } }]])
      expect(() => parseProseCaptureRequests(rows)).toThrow();
  });
  it('accepts scoped semantic requests without inventing a vector or replacing output', () => {
    const semantic = { ...request, id: 'turn-hybrid', adapter: 'search:semantic',
      args: { ...request.args, scope: ['session_turn'], mode: 'hybrid' } };
    expect(parseProseCaptureRequests([semantic])).toEqual([semantic]);
  });
  it('refuses real hosts, mismatched resolvers and missing corpus/model policy', () => {
    expect(requireCaptureDatabase(env)).toBe(dsn);
    for (const patch of [{ HARNESS_ADMIN_DATABASE_URL: 'postgres://other/db' },
      { PAPERCUSP_WORKSPACE_ID: '' }, { PAPERCUSP_TRANSFORMERS_LOCAL_ONLY: '0' },
      { PAPERCUSP_SKIP_PG_DISCOVERY: '0' }])
      expect(() => requireCaptureDatabase({ ...env, ...patch })).toThrow();
    for (const url of ['postgres://test@remote:24567/search_baseline_0123456789abcdef',
      'postgres://test@127.0.0.1:5432/search_baseline_0123456789abcdef',
      'postgres://test@127.0.0.1:24567/production'])
      expect(() => requireCaptureDatabase({ ...env, PAPERCUSP_TEST_PG_ADMIN_URL: url,
        HARNESS_ADMIN_DATABASE_URL: url, HARNESS_DATABASE_URL: url })).toThrow();
  });
});
