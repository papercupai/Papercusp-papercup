import { describe, expect, it } from 'vitest';
import { groupSearchReformulations, observeSearchSource, searchResultFacts, type SearchSource } from './search-reformulation';
import type { SqlIntentScope } from '../bash-substitution/sql-intent-fingerprint';

const scope: SqlIntentScope = { workspaceId: 'search-test', sourceBoundary: 'authorized-a', epoch: '2026-10', key: new Uint8Array(32).fill(37) };
function source(over: Partial<SearchSource> = {}): SearchSource {
  return { workspaceId: scope.workspaceId, harnessSlug: 'search', authorizationScope: scope.sourceBoundary,
    provider: 'codex', namespace: 'codex-session-a', actor: 'su-search-a', verifiedAgent: true, origin: 'agent',
    at: '2026-10-24T12:00:00Z', copyRef: 'copy-a', tool: 'tools:find', args: { query: 'work item owner' },
    callId: 'call-a', identityAuthority: 'provider', sourceComplete: true,
    result: { callId: 'call-a', provider: 'codex', namespace: 'codex-session-a', status: 'ok', complete: true,
      body: { hits: [{ tool: 'work_items:get' }] } }, ...over };
}
const observe = (s: SearchSource, scoped = scope) => observeSearchSource(s, scoped)!;
const group = (...sources: SearchSource[]) => groupSearchReformulations(sources.map(s => observe(s)));

it('R23-DERIVED-ACL distinguishes deleted output from a readable unrecognized UNKNOWN result', () => {
  const a = source({ result: { ...source().result!, body: { unrecognized: true } } });
  const readable = observe(a), missing = observe({ ...a, result: null });
  expect(readable).toMatchObject({ outcome: 'UNKNOWN', resultAvailable: true });
  expect(missing).toMatchObject({ outcome: 'UNKNOWN', resultAvailable: false });
  const { resultAvailable: _available, ...before } = readable;
  const { resultAvailable: _missing, ...after } = missing;
  expect(before).toEqual(after);
});

it('R9-CONTRACT: groups normalized reformulations and SQL/shell fallbacks; recommends existing tools first', () => {
  const a = source(), b = source({ callId: 'call-b', copyRef: 'b', at: '2026-10-24T12:00:05Z',
    tool: 'docs:search', args: { query: 'owner work items' }, result: { ...a.result!, callId: 'call-b', body: { hits: [] } } });
  const c = source({ callId: 'sql-c', copyRef: 'c', at: '2026-10-24T12:00:07Z', tool: 'dev:pg_query',
    args: { sql: 'SELECT owner FROM work_items' }, result: { ...a.result!, callId: 'sql-c', body: { rows: [] } } });
  const d = source({ callId: 'shell-d', copyRef: 'd', at: '2026-10-24T12:00:08Z', tool: 'capability:bash',
    args: { command: 'rg owner work_items' }, result: { ...a.result!, callId: 'shell-d', body: {} } });
  const result = group(a, b, c, d);
  expect(result.chains).toHaveLength(1);
  expect(result.chains[0]).toMatchObject({ reformulations: 1, fallbacks: 2, recommendation: { kind: 'existing-tool', tools: ['work_items:get'] } });
  for (const tool of ['tools:find', 'recipes:search', 'docs:search', 'plans:search']) {
    const body = tool === 'recipes:search' ? { recipes: [] } : { hits: [] };
    expect(searchResultFacts(tool, { content: [{ type: 'text', text: JSON.stringify(body) }] }).returned).toBe(0);
    expect(observe(source({ tool, result: { ...a.result!, body } })).outcome).toBe('no-results');
  }
  expect(group(b).chains[0]!.recommendation.kind).toBe('improve-docs');
  const truncated = source({ result: { ...a.result!, body: { hits: [{ tool: 'work_items:get' }], truncated: true } } });
  expect(observe(truncated)).toMatchObject({ outcome: 'UNKNOWN', returned: null, existingTools: [] });
  expect(group(truncated).chains[0]!.recommendation.kind).toBe('improve-filters');
});

it('OUTCOME-P-009: separates authorization boundaries, actors, harnesses and idle bursts', () => {
  const a = source(), otherScope = { ...scope, sourceBoundary: 'authorized-b' };
  const b = observe(source({ authorizationScope: otherScope.sourceBoundary }), otherScope);
  const rows = [observe(a), b, observe(source({ actor: 'su-other' })),
    observe(source({ harnessSlug: 'foreign' })), observe(source({ callId: 'late', copyRef: 'late', at: '2026-10-24T13:00:00Z' }))];
  expect(groupSearchReformulations(rows).chains).toHaveLength(5);
  expect(() => observe(source({ authorizationScope: otherScope.sourceBoundary }))).toThrow('invalid_search_scope');
});

it('R9-SHARED-ID-COLLISION: unrelated shared-ID results cannot alter grouping or recommendation', () => {
  const a = source(), missing = source({ result: null });
  const unrelated = source({ copyRef: 'unrelated', tool: 'docs:search', args: { query: 'deployment artifact signing' },
    result: { ...a.result!, body: { hits: [{ tool: 'release:deploy' }] } } });
  const result = group(missing, unrelated);
  expect(result.collisions).toBe(1);
  expect(result.chains).toHaveLength(2);
  expect(result.chains.map(c => c.recommendation)).toEqual([
    { kind: 'review-search', tools: [] }, { kind: 'review-search', tools: [] },
  ]);
  expect(group(a).chains[0]!.recommendation.tools).toEqual(['work_items:get']);
});

it('R21-ID-COLLISION: same identity on ambiguous operations invalidates both outcomes', () => {
  const a = source(), result = group(a, source({ copyRef: 'different', args: { query: 'disk cleanup' } }));
  expect(result.collisions).toBe(1);
  expect(result.chains.flatMap(c => c.operations).every(o => o.outcome === 'UNKNOWN')).toBe(true);
});

it('R21-NAMESPACE-PROVIDER-MISMATCH: canonical IDs are scoped by provider and namespace', () => {
  const a = source();
  for (const result of [{ ...a.result!, namespace: 'different-session' }, { ...a.result!, provider: 'claude' as const }])
    expect(observe(source({ result }))).toMatchObject({ outcome: 'UNKNOWN', existingTools: [] });
  const b = source({ provider: 'claude', namespace: 'claude-session', copyRef: 'claude',
    result: { ...a.result!, provider: 'claude', namespace: 'claude-session' } });
  expect(group(a, b)).toMatchObject({ collisions: 0, copiesCollapsed: 0 });
  expect(group(a, b).chains[0]!.operations).toHaveLength(2);
});

it('R21-INTERLEAVED-SAME-ACTOR: adjacency never supplies missing or mismatched outcomes', () => {
  const a = source();
  const result = group(a, source({ callId: 'second', copyRef: 'second', at: '2026-10-24T12:00:01Z', result: a.result }),
    source({ callId: null, copyRef: 'third', at: '2026-10-24T12:00:02Z', result: null }));
  expect(result.chains[0]!.operations.map(o => o.outcome)).toEqual(['results', 'UNKNOWN', 'UNKNOWN']);
});

describe.each(['ledger', 'claude', 'codex', 'omp'] as const)('provider %s', provider => {
  it('R21-PAIRING R21-EXACT-ID-CONTROL: exact identity pairs and identical copies collapse', () => {
    const a = source({ provider, result: { ...source().result!, provider } });
    const result = group(a, { ...a, copyRef: 'duplicate' });
    expect(result).toMatchObject({ collisions: 0, copiesCollapsed: 1 });
    expect(result.chains[0]!.operations).toHaveLength(1);
    expect(result.chains[0]!.operations[0]!.outcome).toBe('results');
    expect(observe({ ...a, result: { ...a.result!, complete: false } }).outcome).toBe('UNKNOWN');
    expect(observe({ ...a, identityAuthority: 'unknown' }).outcome).toBe('UNKNOWN');
  });
});

it('keeps passive telemetry private and excludes non-agent and incomplete inputs', () => {
  const raw = source({ args: { query: 'owner password secret-private-value' } });
  const observation = observe(raw, { ...scope, knownSecrets: ['secret-private-value'] });
  expect(JSON.stringify(observation)).not.toContain('secret-private-value');
  expect(JSON.stringify(observation)).not.toContain('password');
  for (const over of [{ verifiedAgent: false }, { origin: 'system' as const }, { sourceComplete: false }])
    expect(observeSearchSource(source(over), scope)).toBeNull();
});
