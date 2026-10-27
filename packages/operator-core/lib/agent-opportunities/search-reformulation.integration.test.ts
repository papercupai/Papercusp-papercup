/** Maintained P-009 controls against the migrated invocation ledger. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { fetchSearchReformulations, groupSearchReformulations, type SearchCorpusOptions } from './search-reformulation';

let db: OrgTestDb;
const workspaceId = 'search-reformulation-test', harnessSlug = 'search-test';
const scope = { workspaceId, sourceBoundary: 'authorized-search', epoch: 'test-1', key: new Uint8Array(32).fill(79) };
type Receipt = Awaited<ReturnType<SearchCorpusOptions['readOutput']>>;
const outputs = new Map<string, Receipt>();
let sourceSequence = 0;
beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.adminSql`DELETE FROM harness_shared.tool_invocations`; outputs.clear(); sourceSequence = 0; });
const opts = (over: Partial<SearchCorpusOptions> = {}): SearchCorpusOptions => ({
  workspaceId, harnessSlug, scope, client: db.adminSql, since: '2026-10-24T00:00:00Z', until: '2026-10-25T00:00:00Z',
  authorize: async () => true, authorizeSource: async () => ({ sourceBoundary: scope.sourceBoundary }),
  readOutput: async ({ id }) => outputs.get(id) ?? null, ...over,
});
async function seed(over: { workspace?: string; harness?: string; tool?: string; args?: unknown; body?: unknown;
  status?: string; at?: string; actor?: string; origin?: string; role?: string; meta?: unknown } = {}) {
  const at = over.at ?? new Date(Date.parse('2026-10-24T12:00:00Z') + sourceSequence++ * 1000).toISOString();
  const [r] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.tool_invocations
    (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,
     coord_owner_id,args_json,metadata_json,transport,call_origin,call_origin_source,duration_ms)
    VALUES (${over.workspace ?? workspaceId},${over.harness ?? harnessSlug},'agent-mcp',${over.tool ?? 'tools:find'},
      ${over.role ?? 'operator'},'search-request','test',${at}::timestamptz,
      ${over.status ?? 'ok'},${over.actor ?? 'su-search-test'},${JSON.stringify(over.args ?? { query: 'work item owner' })}::jsonb,
      ${JSON.stringify(over.meta ?? {})}::jsonb,'mcp',${over.origin ?? 'agent'},'declared',12)
    RETURNING id::text`;
  const id = r!.id;
  outputs.set(id, { callId: `invocation:${id}`, provider: 'ledger', namespace: 'operator-dispatch', complete: true,
    body: { content: [{ type: 'text', text: JSON.stringify(over.body ?? { hits: [{ tool: 'work_items:get' }] }) }] } });
  return id;
}

it('R9-CONTRACT: reads real search metadata, reformulations and later SQL/shell fallback with existing-tool priority', async () => {
  await seed();
  await seed({ tool: 'recipes:search', args: { query: 'owner work items' }, body: { ok: true, recipes: [] } });
  await seed({ tool: 'docs:search', args: { query: 'work item owners' }, body: { hitCount: 0, hits: [] } });
  await seed({ tool: 'plans:search', args: { query: 'work items owner' }, body: { hits: [], truncatedCandidates: false } });
  await seed({ tool: 'dev:pg_query', args: { sql: 'SELECT owner FROM work_items' } });
  await seed({ tool: 'capability:bash', args: { command: 'rg owner work_items' } });
  const page = await fetchSearchReformulations(opts());
  expect(page.observations.map(o => o.outcome)).toEqual(['results', 'no-results', 'no-results', 'no-results', 'results', 'results']);
  expect(groupSearchReformulations(page.observations).chains[0]).toMatchObject({ reformulations: 3, fallbacks: 2,
    recommendation: { kind: 'existing-tool', tools: ['work_items:get'] } });
  expect(page.coverage).toMatchObject({ scanned: 6, status: 'unknown', providers: ['ledger'], unmeasuredProviders: ['claude', 'codex', 'omp'] });
  expect(groupSearchReformulations(page.observations.slice(1, 4)).chains[0]!.recommendation.kind).toBe('improve-docs');
  await seed({ tool: 'plans:search', body: { hits: [{ slug: 'owner' }], truncatedCandidates: true } });
  const truncated = (await fetchSearchReformulations(opts())).observations.at(-1)!;
  expect(truncated).toMatchObject({ outcome: 'UNKNOWN', returned: null });
  expect(groupSearchReformulations([truncated]).chains[0]!.recommendation.kind).toBe('improve-filters');
});

it('OUTCOME-P-009: confines raw reads and output hydration to current authorized source scope', async () => {
  const allowed = await seed(), denied = await seed({ args: { query: 'denied-secret' } });
  await seed({ workspace: 'other-workspace' }); await seed({ harness: 'other-harness' });
  await seed({ origin: 'system' }); await seed({ role: 'test' });
  await seed({ meta: { nestedDispatch: { codeMode: true } } });
  await seed({ args: { query: 'partial', _truncated: true } });
  const hydrated: string[] = [];
  const page = await fetchSearchReformulations(opts({ authorizeSource: async id => id === denied ? null : { sourceBoundary: scope.sourceBoundary },
    readOutput: async ({ id }) => { hydrated.push(id); return outputs.get(id) ?? null; } }));
  expect(page.observations).toHaveLength(1);
  expect(page.coverage.denied).toBe(1);
  expect(hydrated).toContain(allowed); expect(hydrated).not.toContain(denied);
  expect(JSON.stringify(page)).not.toContain('denied-secret');
  let reads = 0;
  await expect(fetchSearchReformulations(opts({ authorize: async () => false,
    authorizeSource: async () => { reads++; return null; } }))).rejects.toThrow('search_source_denied');
  expect(reads).toBe(0);
  expect((await fetchSearchReformulations(opts({ authorizeSource: async () => { throw new Error('ACL unavailable'); } }))).observations).toEqual([]);
  const boundaryB = { ...scope, sourceBoundary: 'authorized-b' };
  const otherBoundary = await fetchSearchReformulations(opts({ scope: boundaryB,
    authorizeSource: async id => id === allowed ? { sourceBoundary: boundaryB.sourceBoundary } : null }));
  expect(groupSearchReformulations([...page.observations, ...otherBoundary.observations]).chains).toHaveLength(2);
  expect(groupSearchReformulations([...page.observations, ...page.observations]).chains).toHaveLength(1);
});

it('R9-SHARED-ID-COLLISION R21-ID-COLLISION: conflicting canonical ledger copies cannot manufacture a recommendation', async () => {
  const id = await seed(); outputs.set(id, null);
  const before = await fetchSearchReformulations(opts());
  // A second source view reuses the identity but disagrees on the operation itself.
  await db.adminSql`UPDATE harness_shared.tool_invocations SET args_json='{"query":"deployment artifact signing"}'::jsonb WHERE id=${id}::bigint`;
  outputs.set(id, { callId: `invocation:${id}`, provider: 'ledger', namespace: 'operator-dispatch', complete: true,
    body: { hits: [{ tool: 'release:deploy' }] } });
  const after = await fetchSearchReformulations(opts());
  const grouped = groupSearchReformulations([...before.observations, ...after.observations]);
  expect(grouped.collisions).toBe(1); expect(grouped.chains).toHaveLength(2);
  expect(grouped.chains.flatMap(c => c.operations).map(o => o.outcome)).toEqual(['UNKNOWN', 'UNKNOWN']);
  expect(grouped.chains.map(c => c.recommendation)).toEqual([
    { kind: 'review-search', tools: [] }, { kind: 'review-search', tools: [] },
  ]);
  expect(groupSearchReformulations(after.observations).chains[0]!.recommendation.tools).toEqual(['release:deploy']);
});

it('R21-NAMESPACE-PROVIDER-MISMATCH: rejects output from another provider or namespace', async () => {
  const id = await seed(), receipt = outputs.get(id)!;
  for (const wrong of [{ ...receipt, provider: 'claude' as const }, { ...receipt, namespace: 'other-dispatch' }]) {
    outputs.set(id, wrong);
    expect((await fetchSearchReformulations(opts())).observations[0]).toMatchObject({ outcome: 'UNKNOWN', existingTools: [] });
  }
  outputs.set(id, receipt);
  expect((await fetchSearchReformulations(opts())).observations[0]!.outcome).toBe('results');
});

it('R21-INTERLEAVED-SAME-ACTOR: never pairs nearby invocations without their exact result identity', async () => {
  const ids = [await seed(), await seed(), await seed({ status: 'error' }), await seed({ status: 'quota-exceeded' })];
  outputs.set(ids[1]!, outputs.get(ids[0]!)!);
  const page = await fetchSearchReformulations(opts());
  expect(page.observations.map(o => o.outcome)).toEqual(['results', 'UNKNOWN', 'error', 'refused']);
  outputs.delete(ids[1]!);
  expect((await fetchSearchReformulations(opts())).observations[1]!.outcome).toBe('UNKNOWN');
});

it('R21-PAIRING R21-EXACT-ID-CONTROL: exact ledger identity works; replay pages collapse while distinct calls survive', async () => {
  await db.adminSql`SELECT setval(pg_get_serial_sequence('harness_shared.tool_invocations','id'),7)`;
  const sameTime = { at: '2026-10-24T12:00:00.123456Z' };
  const ids = [await seed(sameTime), await seed(sameTime), await seed(sameTime)];
  const first = await fetchSearchReformulations(opts({ limit: 2 }));
  expect(first.next).toEqual({ id: ids[1], at: '2026-10-24T12:00:00.123456Z' });
  const second = await fetchSearchReformulations(opts({ after: first.next!, limit: 2 }));
  const grouped = groupSearchReformulations([...first.observations, ...second.observations, ...first.observations]);
  expect(grouped).toMatchObject({ collisions: 0, copiesCollapsed: 2 });
  expect(grouped.chains[0]!.operations).toHaveLength(3);
  expect(grouped.chains[0]!.operations.every(o => o.outcome === 'results')).toBe(true);
  expect(first.coverage.status).toBe('truncated');
  outputs.set(ids[0]!, { ...outputs.get(ids[0]!)!, complete: false });
  expect((await fetchSearchReformulations(opts())).observations.filter(o => o.outcome === 'UNKNOWN')).toHaveLength(1);
});
