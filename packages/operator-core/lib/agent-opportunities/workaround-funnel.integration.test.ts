/** Real migrated ledger; fixture identity workaround-funnel-ledger-v1. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { fetchWorkaroundFunnels, groupWorkarounds, rankWorkarounds } from './workaround-funnel';
import type { RecoveryCorpusOptions } from './result-recovery';

let db: OrgTestDb, sequence = 0;
const workspaceId = 'workaround-integration', harnessSlug = 'workaround-test';
const scope = { workspaceId, sourceBoundary: 'authorized', epoch: 'ledger-v1', key: new Uint8Array(32).fill(89) };
const outputs = new Map<string, Awaited<ReturnType<RecoveryCorpusOptions['readOutput']>>>();
beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.adminSql`DELETE FROM harness_shared.tool_invocations`; outputs.clear(); sequence = 0; });
const opts = (over: Partial<RecoveryCorpusOptions> = {}): RecoveryCorpusOptions => ({
  workspaceId, harnessSlug, scope, client: db.adminSql, since: '2026-10-24T00:00:00Z', until: '2026-10-25T00:00:00Z',
  authorize: async () => true, authorizeSource: async () => ({ sourceBoundary: scope.sourceBoundary }),
  readOutput: async ({ id }) => outputs.get(id) ?? null, ...over,
});
async function seed(over: { tool?: string; args?: unknown; body?: unknown; status?: string; at?: string;
  actor?: string; workspace?: string; harness?: string; origin?: string; role?: string } = {}) {
  const at = over.at ?? new Date(Date.parse('2026-10-24T12:00:00Z') + sequence++ * 1000).toISOString();
  const [row] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.tool_invocations
    (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,
      coord_owner_id,args_json,metadata_json,transport,call_origin,call_origin_source,duration_ms)
    VALUES (${over.workspace ?? workspaceId},${over.harness ?? harnessSlug},'agent-mcp',${over.tool ?? 'plans:get'},
      ${over.role ?? 'operator'},'funnel-request','workaround-funnel-ledger-v1',${at}::timestamptz,${over.status ?? 'ok'},
      ${over.actor ?? 'su-funnel'},${JSON.stringify(over.args ?? { slug: 'private-target' })}::jsonb,
      '{}'::jsonb,'mcp',${over.origin ?? 'agent'},'declared',12) RETURNING id::text`;
  const id = row!.id;
  outputs.set(id, { callId: `invocation:${id}`, provider: 'ledger', namespace: 'operator-dispatch', complete: true,
    body: { content: [{ type: 'text', text: JSON.stringify(over.body ?? { ok: true }) }] } });
  return id;
}

it('R11-CONTRACT', async () => {
  for (const [i, error] of ['invalid_args: old parameter', 'column x does not exist', 'stale_tool_contract', 'tool_not_found'].entries()) {
    for (const episode of [0, 1]) {
      const start = Date.parse('2026-10-24T12:00:00Z') + (i * 2 + episode) * 600_000;
      await seed({ at: new Date(start).toISOString(), status: 'error', body: { ok: false, error, servingBuild: 'old' } });
      await seed({ tool: 'docs:search', at: new Date(start + 1000).toISOString(), args: { query: 'private-target schema' } });
      await seed({ at: new Date(start + 2000).toISOString(), args: { slug: 'private-target', corrected: true }, body: { ok: true, servingBuild: 'new' } });
    }
  }
  // Intentional exploration with no measured preceding error is not repair demand.
  await seed({ args: { slug: 'exploration' }, at: '2026-10-24T16:00:00Z' });
  const rows = (await fetchWorkaroundFunnels(opts())).observations;
  const ranked = rankWorkarounds([...rows, ...rows]);
  expect(ranked).toMatchObject({ copiesCollapsed: 25, collisions: 0 });
  expect(ranked.rankings.map(r => r.repair).sort()).toEqual(['availability', 'build', 'parameter', 'schema']);
  for (const r of ranked.rankings) {
    expect(r).toMatchObject({ successfulEpisodes: 2, extraCalls: 4, elapsedMs: 4000, confidence: 'observed-sequence' });
    expect(r.finalOutcomeRefs).toHaveLength(2);
    expect(r.episodes[0]).toMatchObject({ callTimeMs: 36, changes: { schemaLookup: true, parameters: true, build: true } });
  }
  await seed({ at: '2026-10-24T17:00:00Z', status: 'error', body: { ok: false, error: 'tool_not_found' } });
  await seed({ at: '2026-10-24T17:00:01Z', tool: 'capability:bash', args: { command: 'rg private-target source.ts' }, body: { exit_code: 0, output: 'found' } });
  expect(groupWorkarounds((await fetchWorkaroundFunnels(opts())).observations).episodes.at(-1))
    .toMatchObject({ evidence: 'observed-sequence', changes: { manualReconstruction: true } });
  expect(JSON.stringify(ranked)).not.toContain('private-target');
});

it('OUTCOME-P-011', async () => {
  await seed({ status: 'error', body: { ok: false, error: 'invalid_args' } });
  const final = await seed();
  const saved = outputs.get(final)!;
  for (const replacement of [null, { ...saved, complete: false }, { ...saved, callId: 'wrong' },
    { ...saved, provider: 'codex' as const }, { ...saved, namespace: 'wrong' }, { ...saved, body: { _partial: true } }]) {
    outputs.set(final, replacement);
    const rows = (await fetchWorkaroundFunnels(opts())).observations;
    expect(groupWorkarounds(rows).episodes[0]).toMatchObject({ evidence: 'incomplete', finalOutcomeRef: null, extraCalls: 1 });
    expect(rankWorkarounds(rows).rankings).toEqual([]);
  }
  outputs.set(final, saved);
  expect(groupWorkarounds((await fetchWorkaroundFunnels(opts())).observations).episodes[0])
    .toMatchObject({ evidence: 'observed-sequence' });
  await seed({ at: '2026-10-24T12:10:00Z', status: 'error', body: { ok: false, error: 'invalid_args' } });
  const manual = await seed({ at: '2026-10-24T12:10:01Z', tool: 'capability:bash',
    args: { command: 'rg private-target source.ts' }, body: { exit_code: 0, output: 'found' } });
  const complete = outputs.get(manual)!;
  for (const flags of [{ _partial: true }, { truncated: true }, { _projection: { truncated: true } },
    { eof: false }, { next_cursor: 'remaining' }]) {
    for (const body of [{ exit_code: 0, ...flags }, { structuredContent: { exit_code: 0, ...flags } }]) {
      outputs.set(manual, { ...complete, body });
      expect(groupWorkarounds((await fetchWorkaroundFunnels(opts())).observations).episodes.at(-1))
        .toMatchObject({ evidence: 'incomplete', finalOutcomeRef: null });
    }
  }
  outputs.set(manual, complete);
  expect(groupWorkarounds((await fetchWorkaroundFunnels(opts())).observations).episodes.at(-1))
    .toMatchObject({ evidence: 'observed-sequence' });
});

it('Workaround ledger authorization and keyset coverage fail closed', async () => {
  await seed({ workspace: 'other', status: 'error', body: { ok: false, error: 'invalid_args' } });
  await seed({ harness: 'other', status: 'error', body: { ok: false, error: 'invalid_args' } });
  const root = await seed({ at: '2026-10-24T12:00:00.123456Z', status: 'error', body: { ok: false, error: 'invalid_args' } });
  const denied = await seed({ at: '2026-10-24T12:00:00.123457Z' });
  await seed({ at: '2026-10-24T12:00:00.123458Z', origin: 'system' });
  const reads: string[] = [];
  const options = opts({ limit: 2, authorizeSource: async id => id === denied ? null : { sourceBoundary: scope.sourceBoundary },
    readOutput: async ({ id }) => { reads.push(id); return outputs.get(id) ?? null; } });
  const first = await fetchWorkaroundFunnels(options);
  expect(first.next).toEqual({ id: denied, at: '2026-10-24T12:00:00.123457Z' });
  expect(first.coverage).toMatchObject({ scanned: 2, denied: 1, status: 'truncated', unmeasuredProviders: ['claude', 'codex', 'omp'] });
  expect(reads).toEqual([root]);
  const second = await fetchWorkaroundFunnels({ ...options, after: first.next! });
  expect(second.coverage.status).toBe('truncated');
  expect(groupWorkarounds([...first.observations, ...second.observations]).episodes[0]!.evidence).toBe('incomplete');
  let checks = 0;
  await expect(fetchWorkaroundFunnels(opts({ authorize: async () => false, authorizeSource: async () => { checks++; return null; } })))
    .rejects.toThrow('recovery_source_denied');
  expect(checks).toBe(0);
  expect((await fetchWorkaroundFunnels(opts({ authorizeSource: async () => { throw new Error('ACL unavailable'); } }))).observations).toEqual([]);
});

it('R21-SHARED-ID-COLLISION R21-NAMESPACE-PROVIDER-MISMATCH', async () => {
  const root = await seed({ status: 'error', body: { ok: false, error: 'invalid_args' } });
  const final = await seed();
  const before = await fetchWorkaroundFunnels(opts()), saved = outputs.get(final)!;
  for (const wrong of [{ ...saved, namespace: 'other' }, { ...saved, provider: 'codex' as const }, outputs.get(root)!]) {
    outputs.set(final, wrong);
    expect(groupWorkarounds((await fetchWorkaroundFunnels(opts())).observations).episodes[0]!.finalOutcomeRef).toBeNull();
  }
  outputs.set(final, saved);
  outputs.set(root, { ...outputs.get(root)!, body: { ok: false, error: 'stale_tool_contract' } });
  expect(groupWorkarounds([...before.observations, ...(await fetchWorkaroundFunnels(opts())).observations]))
    .toMatchObject({ collisions: 1, episodes: [] });
  expect(groupWorkarounds(before.observations).episodes[0]!.evidence).toBe('observed-sequence');
});

it('R21-INTERLEAVED-SAME-ACTOR R21-EXACT-ID-CONTROL', async () => {
  await seed({ status: 'error', body: { ok: false, error: 'invalid_args' } });
  await seed({ args: { slug: 'unrelated' } });
  await seed({ actor: 'su-other' });
  await seed();
  const page = await fetchWorkaroundFunnels(opts());
  const grouped = groupWorkarounds([...page.observations, ...page.observations]);
  expect(grouped).toMatchObject({ copiesCollapsed: 4, collisions: 0 });
  expect(grouped.episodes).toHaveLength(1);
  expect(grouped.episodes[0]).toMatchObject({ extraCalls: 1, evidence: 'observed-sequence',
    finalOutcomeRef: page.observations[3]!.operationToken });
});
