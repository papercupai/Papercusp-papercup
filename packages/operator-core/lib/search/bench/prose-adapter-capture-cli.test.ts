import { describe, expect, it } from 'vitest';
import { parseProseCaptureRequests, requireCaptureDatabase } from './prose-adapter-capture-cli';

const request = { id: 'work-lexical', adapter: 'search:fulltext',
  args: { query: 'scope witness', scope: ['work_item'], harness_slug: 'papercusp', limit: 5 } };
const dsn = 'postgres://test@127.0.0.1:24567/search_baseline_0123456789abcdef';
const env = { PAPERCUSP_TEST_PG_ADMIN_URL: dsn, HARNESS_ADMIN_DATABASE_URL: dsn, HARNESS_DATABASE_URL: dsn,
  PAPERCUSP_WORKSPACE_ID: 'corpus-workspace', PAPERCUSP_MEMORY_EMBEDDER: 'gemma', PAPERCUSP_EMBED_DEVICE: 'cpu',
  PAPERCUSP_TRANSFORMERS_LOCAL_ONLY: '1', PAPERCUSP_SKIP_PG_DISCOVERY: '1' };

describe('retained direct prose adapter capture boundaries', () => {
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
