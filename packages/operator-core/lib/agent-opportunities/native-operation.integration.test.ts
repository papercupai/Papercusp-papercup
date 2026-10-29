/** Real migrated agent_activity fixture: native-activity-provider-v1. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { fetchNativeOperations, groupNativeOperations, readableNativeChains, type NativeCorpusOptions, type NativeProvider } from './native-operation';
import type { SearchSource } from './search-reformulation';

let db: OrgTestDb;
const workspaceId = 'native-operation-test', harnessSlug = 'native-test';
const scope = { workspaceId, sourceBoundary: 'native-authorized', epoch: 'activity-v1', key: new Uint8Array(32).fill(92) };
const transcripts = new Map<string, SearchSource>();
let sequence = 0;
beforeAll(async () => { db = await createOrgTestDb(); }, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.adminSql`DELETE FROM harness_shared.agent_activity`; transcripts.clear(); sequence = 0; });
const opts = (over: Partial<NativeCorpusOptions> = {}): NativeCorpusOptions => ({
  workspaceId, harnessSlug, scope, client: db.adminSql, since: '2026-10-24T00:00:00Z', until: '2026-10-25T00:00:00Z',
  authorize: async () => true, authorizeSource: async () => ({ sourceBoundary: scope.sourceBoundary }),
  readTranscript: async ({ id }) => transcripts.has(id) ? { sources: [transcripts.get(id)!], status: 'measured' } : null, ...over,
});
async function seed(over: { workspace?: string; harness?: string; provider?: string; actor?: string; session?: string;
  tool?: string; args?: unknown; callId?: string | null; at?: string; body?: unknown; phase?: string } = {}) {
  const callId = over.callId === undefined ? `call-${sequence}` : over.callId;
  const at = over.at ?? new Date(Date.parse('2026-10-24T12:00:00Z') + sequence++ * 1000).toISOString();
  const provider = over.provider ?? 'codex', actor = over.actor ?? 'su-native-test', session = over.session ?? 'session-one';
  const tool = over.tool ?? 'exec_command', args = over.args ?? { cmd: 'rg -n confidential ./src | head -5' };
  const [row] = await db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status,created_at)
    VALUES (${over.workspace ?? workspaceId},${over.harness ?? harnessSlug},${actor},${provider},${session},'tool',${tool},
      ${over.phase ?? 'pre'},${callId},${JSON.stringify(args)}::jsonb,'ok',${at}::timestamptz) RETURNING id::text`;
  const id = row!.id;
  transcripts.set(id, { workspaceId: over.workspace ?? workspaceId, harnessSlug: over.harness ?? harnessSlug,
    authorizationScope: scope.sourceBoundary, provider: provider as NativeProvider, actor, namespace: session,
    verifiedAgent: true, origin: 'agent', at, tool, args, callId, identityAuthority: 'provider', sourceComplete: true,
    copyRef: `transcript:${provider}:${session}:${callId}`,
    result: { provider: provider as NativeProvider, namespace: session, callId, complete: true, status: 'ok', body: over.body ?? { exit_code: 0 } } });
  return id;
}

it('R12-CONTRACT', async () => {
  await seed(); await seed();
  await seed({ tool: 'browser', args: { action: 'click', selector: '#save' }, body: { ok: true } });
  await seed({ tool: 'browser', args: { action: 'click', selector: '#save' }, body: { ok: true } });
  const page = await fetchNativeOperations(opts());
  const grouped = groupNativeOperations(page.observations);
  expect(grouped.chains.map(c => [c.kind, c.logicalDemand, c.successCount])).toEqual([['shell', 2, 2], ['browser', 2, 2]]);
  expect(grouped.copiesCollapsed).toBe(4);
  expect(JSON.stringify(grouped)).not.toContain('confidential');
  const activity = await fetchNativeOperations(opts({ readTranscript: undefined }));
  expect(groupNativeOperations(activity.observations).chains.every(c => c.unknownCount === 2)).toBe(true);
});

it('OUTCOME-P-012', async () => {
  await seed({ args: { cmd: 'curl --password tiny --token=first-secret-value first"opaque\\secret' } });
  await seed({ args: { cmd: 'curl --password other --token=second-secret-value second"opaque\\secret' } });
  await seed({ tool: 'browser', args: { action: 'fill', selector: '#password', text: 'first-private-password' }, body: { ok: true } });
  await seed({ tool: 'browser', args: { action: 'fill', selector: '#password', text: 'second-private-password' }, body: { ok: true } });
  const page = await fetchNativeOperations(opts({ scope: { ...scope, knownSecrets: ['first"opaque\\secret', 'second"opaque\\secret'] } }));
  const chains = await readableNativeChains(page.observations, async () => true);
  expect(chains).toHaveLength(2);
  expect(chains.every(c => c.logicalDemand === 2)).toBe(true);
  expect(JSON.stringify({ page, chains })).not.toMatch(/first-secret|second-secret|private-password|tiny|curl|#password/);
  const other = await fetchNativeOperations(opts({ scope: { ...scope, sourceBoundary: 'other' },
    authorizeSource: async () => ({ sourceBoundary: 'other' }), readTranscript: undefined }));
  expect(other.observations[0]!.fingerprint).not.toBe(page.observations[0]!.fingerprint);
});

it('R15-CURRENT-ACL R23-DERIVED-ACL', async () => {
  await seed({ workspace: 'other' }); await seed({ harness: 'other' });
  const first = await seed(), denied = await seed();
  await seed({ actor: 'human-native-test' });
  let readable = true;
  const reads: string[] = [];
  const config = opts({ authorizeSource: async id => id === denied && !readable ? null : { sourceBoundary: scope.sourceBoundary },
    readTranscript: async ({ id }) => { reads.push(id); return { sources: [transcripts.get(id)!], status: 'measured' }; } });
  const allowed = await fetchNativeOperations(config);
  expect(groupNativeOperations(allowed.observations).chains).toHaveLength(1);
  readable = false; reads.length = 0;
  const revoked = await fetchNativeOperations(config);
  expect(reads).toEqual([first]); expect(revoked.coverage.denied).toBe(1);
  expect(groupNativeOperations(revoked.observations).chains).toEqual([]);
  expect(await readableNativeChains(allowed.observations, async () => readable)).toEqual([]);
  readable = true;
  expect(await readableNativeChains(allowed.observations, async () => readable)).toHaveLength(1);
  expect((await fetchNativeOperations(opts({ authorizeSource: async () => { throw new Error('ACL unavailable'); } }))).observations).toEqual([]);
  let aclCalls = 0;
  await expect(fetchNativeOperations(opts({ authorize: async () => false, authorizeSource: async () => { aclCalls++; return null; } }))).rejects.toThrow('native_source_denied');
  expect(aclCalls).toBe(0);
});

it('R22-DEDUP', async () => {
  await seed({ callId: 'same' }); await seed({ callId: 'same', phase: 'post' }); await seed({ callId: 'distinct' });
  const page = await fetchNativeOperations(opts());
  expect(groupNativeOperations(page.observations)).toMatchObject({ copiesCollapsed: 4, collisions: 0 });
  expect(groupNativeOperations(page.observations).chains[0]).toMatchObject({ logicalDemand: 2 });
  const first = await fetchNativeOperations(opts({ limit: 1 }));
  const second = await fetchNativeOperations(opts({ after: first.next!, limit: 2 }));
  expect(groupNativeOperations([...first.observations, ...second.observations]).chains[0]!.logicalDemand).toBe(2);
  expect(first.coverage).toMatchObject({ pageLimited: true, complete: false });
  expect(first.coverage.matrix).toContainEqual({ provider: 'codex', kind: 'shell', source: 'transcript', status: 'measured' });
});

it('R21-SHARED-ID-COLLISION R21-NAMESPACE-PROVIDER-MISMATCH R21-INTERLEAVED-SAME-ACTOR R21-EXACT-ID-CONTROL', async () => {
  const first = await seed(), second = await seed();
  const original = transcripts.get(second)!;
  for (const result of [{ ...original.result!, callId: transcripts.get(first)!.callId },
    { ...original.result!, namespace: 'other-session' }, { ...original.result!, provider: 'omp' as const }]) {
    transcripts.set(second, { ...original, result });
    const grouped = groupNativeOperations((await fetchNativeOperations(opts())).observations);
    expect(grouped.chains[0]).toMatchObject({ successCount: 1, unknownCount: 1 });
  }
  transcripts.set(second, original);
  const positive = await fetchNativeOperations(opts());
  expect(groupNativeOperations(positive.observations).chains[0]!.successCount).toBe(2);
  await db.adminSql`UPDATE harness_shared.agent_activity SET detail='{"cmd":"rm private"}'::jsonb WHERE id=${first}::bigint`;
  expect(groupNativeOperations((await fetchNativeOperations(opts())).observations)).toMatchObject({ collisions: 1, chains: [] });
});

it('R26-PROVIDERS', async () => {
  for (const provider of ['claude', 'codex', 'omp']) {
    await seed({ provider, tool: provider === 'claude' ? 'Bash' : 'shell' });
    await seed({ provider, tool: 'browser', args: { action: 'navigate', url: 'https://private.example/' }, body: { ok: true } });
  }
  const full = await fetchNativeOperations(opts());
  expect(full.coverage.matrix).toHaveLength(12);
  expect(full.coverage.matrix.filter(c => c.source === 'transcript' || c.kind === 'browser').every(c => c.status === 'measured')).toBe(true);
  expect(full.coverage.matrix.filter(c => c.source === 'activity' && c.kind === 'shell').every(c => c.status === 'truncated')).toBe(true);
  expect(full.coverage.complete).toBe(false);
  const missing = await fetchNativeOperations(opts({ readTranscript: undefined }));
  expect(missing.coverage.matrix.filter(c => c.source === 'transcript').every(c => c.status === 'missing')).toBe(true);
  await db.adminSql`DELETE FROM harness_shared.agent_activity`;
  await seed({ provider: 'codex', args: { cmd: 'truncated…' } });
  await seed({ provider: 'claude', tool: 'unsupported-widget', args: {} });
  const partial = await fetchNativeOperations(opts({ readTranscript: undefined }));
  expect(partial.coverage.matrix.some(c => c.provider === 'codex' && c.status === 'truncated')).toBe(true);
  expect(partial.coverage.matrix.some(c => c.provider === 'claude' && c.status === 'unsupported')).toBe(true);
  expect(partial.coverage.matrix.filter(c => c.provider === 'omp').every(c => c.status === 'missing')).toBe(true);
  expect(groupNativeOperations(partial.observations).chains).toEqual([]);
});

it.each([
  ['before', '2026-10-23T23:59:59.999Z', false],
  ['start', '2026-10-24T00:00:00Z', true],
  ['last', '2026-10-24T23:59:59.999Z', true],
  ['end', '2026-10-25T00:00:00Z', false],
  ['invalid', 'not-a-time', false],
] as const)('D030 canonical event at %s cannot inherit the selected receipt timestamp', async (_boundary, at, admitted) => {
  const id = await seed();
  transcripts.get(id)!.at = at;
  const page = await fetchNativeOperations(opts());
  expect(page.coverage.scanned).toBe(1);
  expect(page.observations.filter(o => o.resultAvailable)).toHaveLength(admitted ? 1 : 0);
  expect(page.coverage.matrix.find(c => c.provider === 'codex' && c.kind === 'shell' && c.source === 'transcript')?.status)
    .toBe(admitted ? 'measured' : 'missing');
  expect(page.coverage.incomplete).toBe(admitted ? 0 : 1);
  expect(page.coverage.complete).toBe(false);
});

it('R25-PASSIVE', async () => {
  const path = `/tmp/native-mining-sentinel-${process.pid}-${Date.now()}`;
  await seed({ args: { cmd: `touch ${path}` } });
  await seed({ tool: 'browser', args: { action: 'evaluate', script: 'globalThis.__nativeSentinel = true' } });
  await fetchNativeOperations(opts());
  expect(existsSync(path)).toBe(false);
  expect((globalThis as { __nativeSentinel?: boolean }).__nativeSentinel).toBeUndefined();
});

it('R20-ISOLATION', async () => {
  const id = await seed();
  let release!: () => void;
  const held = new Promise<null>(resolve => { release = () => resolve(null); });
  const mining = fetchNativeOperations(opts({ readTranscript: async () => held }));
  // Canonical source recording remains a real independent DB write while mining
  // is held. There is no adapter import/callback in the activity writer path.
  const next = await seed();
  expect(next).not.toBe(id);
  expect(await db.adminSql`SELECT id FROM harness_shared.agent_activity WHERE id=${next}::bigint`).toHaveLength(1);
  release(); await mining;
  expect((await fetchNativeOperations(opts({ readTranscript: async () => { throw new Error('sink failed'); } }))).observations.length).toBeGreaterThan(0);
});
