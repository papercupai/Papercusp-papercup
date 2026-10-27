/** Real migrated invocation ledger; fixture identity: result-recovery-ledger-v1. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { fetchResultRecovery, groupResultRecovery, rankResultRecovery, type RecoveryCorpusOptions } from './result-recovery';

let db: OrgTestDb;
const workspaceId = 'result-recovery-test', harnessSlug = 'recovery-test';
const scope = { workspaceId, sourceBoundary: 'authorized-recovery', epoch: 'ledger-v1', key: new Uint8Array(32).fill(83) };
const outputs = new Map<string, Awaited<ReturnType<RecoveryCorpusOptions['readOutput']>>>();
let sequence = 0;
beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.adminSql`DELETE FROM harness_shared.tool_invocations`; outputs.clear(); sequence = 0; });
const opts = (over: Partial<RecoveryCorpusOptions> = {}): RecoveryCorpusOptions => ({
  workspaceId, harnessSlug, scope, client: db.adminSql, since: '2026-10-24T00:00:00Z', until: '2026-10-25T00:00:00Z',
  authorize: async () => true, authorizeSource: async () => ({ sourceBoundary: scope.sourceBoundary }),
  readOutput: async ({ id }) => outputs.get(id) ?? null, ...over,
});
async function seed(over: { workspace?: string; harness?: string; tool?: string; args?: unknown; body?: unknown;
  status?: string; at?: string; actor?: string; origin?: string; role?: string; metadata?: unknown } = {}) {
  const at = over.at ?? new Date(Date.parse('2026-10-24T12:00:00Z') + sequence++ * 1000).toISOString();
  const [row] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.tool_invocations
    (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,
      coord_owner_id,args_json,metadata_json,transport,call_origin,call_origin_source,duration_ms)
    VALUES (${over.workspace ?? workspaceId},${over.harness ?? harnessSlug},'agent-mcp',${over.tool ?? 'plans:get'},
      ${over.role ?? 'operator'},'recovery-request','result-recovery-ledger-v1',${at}::timestamptz,
      ${over.status ?? 'ok'},${over.actor ?? 'su-recovery-test'},${JSON.stringify(over.args ?? { slug: 'confidential' })}::jsonb,
      ${JSON.stringify(over.metadata ?? { returnedContextBytes: 100 })}::jsonb,'mcp',${over.origin ?? 'agent'},'declared',12)
    RETURNING id::text`;
  const id = row!.id;
  outputs.set(id, { callId: `invocation:${id}`, provider: 'ledger', namespace: 'operator-dispatch', complete: true,
    body: { content: [{ type: 'text', text: JSON.stringify(over.body ?? { ok: true }) }] } });
  return id;
}
const spill = (uri: string) => ({ spillUri: uri, returnedContextBytes: 6000, spilledBytes: 90000, spillFailed: false });
const read = (uri: string, offset = 0) => ({ tool: 'capability:read', args: { uri, byte_offset: offset } });

it('R10-CONTRACT OUTCOME-P-010: ledger repeated spill reads remain one episode; independent recovery and complete exposure rank recurring burden', async () => {
  const uri = 'papercusp://scratch/confidential';
  await seed({ metadata: spill(uri) });
  await seed({ ...read(uri), body: { eof: false, next_cursor: { offset: 100 } } });
  const final = await seed(read(uri, 100));
  const first = await fetchResultRecovery(opts());
  expect(groupResultRecovery([...first.observations, ...first.observations])).toMatchObject({ copiesCollapsed: 3 });
  const grouped = groupResultRecovery(first.observations);
  expect(grouped.episodes).toHaveLength(1);
  expect(grouped.episodes[0]).toMatchObject({ extraCalls: 2, returnedBytes: 6200, finalOutcome: 'success',
    finalOutcomeRef: first.observations.find(o => o.sourceToken === grouped.episodes[0]!.sourceRefs[2])!.operationToken });
  expect(rankResultRecovery(first.observations).rankings).toEqual([]);
  expect(outputs.has(final)).toBe(true);
  await seed({ metadata: spill('papercusp://scratch/second'), at: '2026-10-24T12:10:00Z' });
  await seed({ ...read('papercusp://scratch/second'), at: '2026-10-24T12:10:01Z' });
  await seed({ at: '2026-10-24T12:20:00Z' });
  const page = await fetchResultRecovery(opts());
  expect(rankResultRecovery(page.observations).rankings[0]).toMatchObject({ exposure: 3, recoveryEpisodes: 2,
    extraCalls: 3, successEpisodes: 2, burdenPerExposure: 1 });
  expect(JSON.stringify(page)).not.toContain('confidential');
  expect(page.coverage).toMatchObject({ status: 'unknown', unmeasuredProviders: ['claude', 'codex', 'omp'] });
});

it('R10-ACL: scope isolation and fresh per-source authorization precede output hydration; missing output stays UNKNOWN', async () => {
  const uri = 'papercusp://scratch/private';
  await seed({ workspace: 'other', metadata: spill(uri) });
  await seed({ harness: 'other', metadata: spill(uri) });
  const allowed = await seed({ metadata: spill(uri) });
  const denied = await seed({ ...read(uri), args: { uri, private: 'forbidden-secret' } });
  const absent = await seed(read(uri)); outputs.delete(absent);
  await seed({ origin: 'system', metadata: spill(uri) });
  const hydrated: string[] = [];
  const page = await fetchResultRecovery(opts({ authorizeSource: async id => id === denied ? null : { sourceBoundary: scope.sourceBoundary },
    readOutput: async ({ id }) => { hydrated.push(id); return outputs.get(id) ?? null; } }));
  expect(hydrated).toContain(allowed); expect(hydrated).not.toContain(denied);
  expect(groupResultRecovery(page.observations).episodes[0]).toMatchObject({ extraCalls: 1, finalOutcome: 'UNKNOWN', finalOutcomeRef: null });
  expect(page.coverage.denied).toBe(1);
  expect(JSON.stringify(page)).not.toContain('forbidden-secret');
  let reads = 0;
  await expect(fetchResultRecovery(opts({ authorize: async () => false,
    authorizeSource: async () => { reads++; return null; } }))).rejects.toThrow('recovery_source_denied');
  expect(reads).toBe(0);
  expect((await fetchResultRecovery(opts({ authorizeSource: async () => { throw new Error('ACL down'); } }))).observations).toEqual([]);
});

it('R21-SHARED-ID-COLLISION R21-NAMESPACE-PROVIDER-MISMATCH R21-INTERLEAVED-SAME-ACTOR: verified ledger results cannot be borrowed across operations', async () => {
  const uri = 'papercusp://scratch/first';
  const root = await seed({ metadata: spill(uri) }), reader = await seed(read(uri));
  const first = await fetchResultRecovery(opts());
  const saved = outputs.get(reader)!;
  outputs.set(reader, outputs.get(root)!);
  expect(groupResultRecovery((await fetchResultRecovery(opts())).observations).episodes[0]!.finalOutcome).toBe('UNKNOWN');
  for (const wrong of [{ ...saved, namespace: 'other' }, { ...saved, provider: 'codex' as const }]) {
    outputs.set(reader, wrong);
    expect(groupResultRecovery((await fetchResultRecovery(opts())).observations).episodes[0]!.finalOutcome).toBe('UNKNOWN');
  }
  outputs.set(reader, saved);
  await db.adminSql`UPDATE harness_shared.tool_invocations SET metadata_json=${JSON.stringify(spill('papercusp://scratch/other'))}::jsonb WHERE id=${root}::bigint`;
  const after = await fetchResultRecovery(opts());
  expect(groupResultRecovery([...first.observations, ...after.observations])).toMatchObject({ collisions: 1, episodes: [] });
  expect(groupResultRecovery(first.observations).episodes[0]!.finalOutcome).toBe('success');
});

it('R21-PAIRING R21-EXACT-ID-CONTROL: keyset pages retain exact identities; truncated coverage never becomes complete', async () => {
  await seed({ metadata: spill('papercusp://scratch/a'), at: '2026-10-24T12:00:00.123456Z' });
  const secondId = await seed({ ...read('papercusp://scratch/a'), at: '2026-10-24T12:00:00.123457Z' });
  await seed({ at: '2026-10-24T12:00:00.123458Z' });
  const first = await fetchResultRecovery(opts({ limit: 2 }));
  expect(first.next).toEqual({ id: secondId, at: '2026-10-24T12:00:00.123457Z' });
  const second = await fetchResultRecovery(opts({ after: first.next!, limit: 2 }));
  const grouped = groupResultRecovery([...first.observations, ...second.observations, ...first.observations]);
  expect(grouped).toMatchObject({ copiesCollapsed: 2, collisions: 0 });
  expect(grouped.episodes).toHaveLength(1); expect(grouped.episodes[0]!.extraCalls).toBe(1);
  expect(first.coverage.status).toBe('truncated'); expect(second.coverage.status).toBe('truncated');
});
