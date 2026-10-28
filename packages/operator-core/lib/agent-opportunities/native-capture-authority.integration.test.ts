import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { provisionNativeRuntimeBearer, verifyNativeRuntimeBearer } from '@papercusp/agent-mcp/provisioning';
import { registerProjectedTool, _resetProjectionRegistryForTests, type ProjectedTool } from '@papercusp/tooldef/tool-projection';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { inspectNativeDispatchCandidate, reconcileNativeCapture } from './native-capture';
import type { SearchSource } from './search-reformulation';

let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
// Exercise the real issuer SQL under the same workspace RLS as production.
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  withWorkspace: async (workspace: string, callback: (tx: unknown) => Promise<unknown>) =>
    f.db.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return callback(tx);
    }),
}));
const workspaceId = 'sql-mining-test', owner = 'su-exact-call', harness = 'mining-test';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const unknown = { authority: 'unknown', correlation: 'unknown' };
const tool: ProjectedTool = { pluginName: 'native-authority-fixture', description: 'Exact call fixture',
  inputSchema: { type: 'object' }, capabilities: [], expose: { mcp: { name: 'native-proof:inspect' } },
  fn: async () => ({ content: [] }) };
beforeAll(async () => { f = await sqlMiningFixture(); registerProjectedTool(tool); }, 120_000);
afterAll(async () => { _resetProjectionRegistryForTests(); await f?.cleanup(); });
beforeEach(async () => { await f.clear(); await f.db.adminSql`DELETE FROM harness_shared.adv_sessions`; });
async function fixture() {
  const [r] = await f.db.adminSql`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,agent,session_id) VALUES (${workspaceId},'console',${owner},'codex','native-session') RETURNING id::text`;
  const binding = { id: String(r!.id), owner, provider: 'codex' as const, harness: null };
  const source: SearchSource = { workspaceId, harnessSlug: harness, authorizationScope: 'tool-ledger',
    actor: owner, provider: 'codex', namespace: 'native-session', callId: 'native-call',
    identityAuthority: 'provider', verifiedAgent: true, origin: 'agent', at: '2026-10-25T12:00:00Z',
    copyRef: 'transcript:codex:native-session:1', tool: 'mcp__papercusp_su__native_proof_inspect',
    args: { harness, query: 'private-query' }, result: null, sourceComplete: true };
  const metadata = { requestOrigin: { transport: 'mcp', nativeSession: { carrier: 'meta:threadId',
    binding: 'bound', candidateAdvSessionId: Number(binding.id), valueFingerprint: sha(source.namespace),
    callIdFingerprint: sha(source.callId!) } } };
  const insert = async (scope = harness, toolName = 'native-proof:inspect') => {
    const [row] = await f.db.adminSql`INSERT INTO harness_shared.tool_invocations
      (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,status,
       coord_owner_id,args_json,transport,principal_kind,principal_auth_method,principal_trust,metadata_json)
      VALUES (${workspaceId},${scope},'agent-mcp',${toolName},'operator','test-request','test','ok',
        ${owner},${JSON.stringify(source.args)}::jsonb,'mcp','system','bearer-token','trusted',${f.db.adminSql.json(metadata)}) RETURNING id::text`;
    return String(row!.id);
  };
  const id = await insert();
  const opts = { workspaceId, client: f.db.adminSql, authorize: async () => true };
  const inspect = (s = source) => inspectNativeDispatchCandidate(s, binding, opts);
  return { binding, source, metadata, id, insert, opts, inspect };
}

it('D030 issuer SQL binds capabilityless possession to the real runtime and immediately invalidates rotation/end', async () => {
  const s = await fixture();
  const issuer = { kind: 'system' as const, slug: 'system:superuser', workspaceId,
    trust: 'trusted' as const, authMethod: 'bearer-token' as const, capabilities: new Set(['*']) };
  const input = { workspaceId, advSessionId: Number(s.binding.id), issuer };
  const issued = await provisionNativeRuntimeBearer(input);
  expect(issued.binding).toEqual({ workspaceId, advSessionId: input.advSessionId, ownerId: owner, provider: 'codex' });
  expect(await verifyNativeRuntimeBearer(issued.bearer, issued.binding)).toBe(true);
  const [principal] = await f.db.adminSql`SELECT p.capabilities FROM harness_shared.system_principals p
    JOIN harness_shared.token_index t ON t.workspace_id=p.workspace_id AND t.harness_slug='system:' || p.name
    WHERE t.token=${issued.bearer}`;
  expect(principal?.capabilities).toEqual([]);
  // Possession alone still cannot turn a perfectly correlated call into scope.
  expect((await s.inspect()).authority).toBe('unknown');
  const rotated = await provisionNativeRuntimeBearer(input);
  expect(rotated.bearer).not.toBe(issued.bearer);
  expect(await verifyNativeRuntimeBearer(issued.bearer, issued.binding)).toBe(false);
  expect(await verifyNativeRuntimeBearer(rotated.bearer, rotated.binding)).toBe(true);
  await f.db.adminSql`UPDATE harness_shared.adv_sessions SET coord_owner_id='su-retargeted' WHERE id=${input.advSessionId}`;
  expect(await verifyNativeRuntimeBearer(rotated.bearer, rotated.binding)).toBe(false);
  expect(await verifyNativeRuntimeBearer(rotated.bearer, { ...rotated.binding, ownerId: 'su-retargeted' })).toBe(false);
  await f.db.adminSql`UPDATE harness_shared.adv_sessions SET coord_owner_id=${owner},ended_at=now() WHERE id=${input.advSessionId}`;
  expect(await verifyNativeRuntimeBearer(rotated.bearer, rotated.binding)).toBe(false);
  await expect(provisionNativeRuntimeBearer(input)).rejects.toThrow('native_runtime_issuance_binding_unavailable');
});

it('D030 exact candidate from full dispatch population still grants NO owner or scope authority', async () => {
  const s = await fixture();
  const read = await s.inspect();
  expect(read).toMatchObject({ authority: 'unknown', correlation: 'exact', candidateHarness: harness });
  expect(read.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(read)).not.toMatch(/private-query|native-session|su-exact-call/);
  // Object order is irrelevant, while arguments remain exact.
  expect(await s.inspect({ ...s.source, args: { query: 'private-query', harness } })).toEqual(read);
});

it('D030 production reconciliation refuses an exact candidate before writing scope-derived index or receipts', async () => {
  const s = await fixture();
  expect((await s.inspect()).correlation).toBe('exact');
  const snapshot = async () => ({
    activity: [...await f.db.adminSql`SELECT to_jsonb(a) AS row FROM harness_shared.agent_activity a ORDER BY id`],
    progress: [...await f.db.adminSql`SELECT to_jsonb(p) AS row FROM harness_shared.sql_intent_progress p ORDER BY scope_id`],
  });
  const before = await snapshot();
  const opts = { ...s.opts, harnessSlug: harness, sourceBoundary: 'tool-ledger',
    since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
  expect(await reconcileNativeCapture(opts)).toBe('unknown');
  expect(await reconcileNativeCapture({ ...opts, authorize: async () => false })).toBe('unknown');
  expect(await snapshot()).toEqual(before);
});

it('D030 a scoped candidate never scopes unknown siblings or a mixed-harness root', async () => {
  const s = await fixture();
  expect((await s.inspect()).correlation).toBe('exact');
  expect(await s.inspect({ ...s.source, callId: 'unknown-sibling' })).toEqual(unknown);
  s.source.callId = 'other-call'; s.source.args = { harness: 'other-harness', query: 'private-query' };
  s.metadata.requestOrigin.nativeSession.callIdFingerprint = sha(s.source.callId);
  await s.insert('other-harness');
  expect(await s.inspect()).toMatchObject({ authority: 'unknown', correlation: 'exact', candidateHarness: 'other-harness' });
  expect(s.binding.harness).toBeNull();
});

it.each(['exec_command', 'functions.exec', 'Bash', 'browser', 'tools:invoke', 'code:run',
  'mcp__papercusp_su__native_proof_inspectt'])('D030 native/wrapper/typo %s cannot borrow an inner dispatch', async name => {
  const s = await fixture();
  expect(await s.inspect({ ...s.source, tool: name })).toEqual(unknown);
});

it.each(['owner', 'provider', 'runtime', 'session', 'call', 'args', 'harness', 'workspace'])('D030 rejects exact %s mismatch', async key => {
  const s = await fixture();
  if (key === 'owner') s.source.actor = 'su-other';
  if (key === 'provider') s.source.provider = 'claude';
  if (key === 'runtime') s.binding.id = '999999999';
  if (key === 'session') s.source.namespace = 'other-session';
  if (key === 'call') s.source.callId = 'other-call';
  if (key === 'args') s.source.args = { harness, query: 'different' };
  if (key === 'harness') s.source.args = { harness: 'other-harness', query: 'private-query' };
  if (key === 'workspace') s.source.workspaceId = 'other-workspace';
  expect(await s.inspect()).toEqual(unknown);
});

it.each(['same', 'other-harness', 'other-tool'])('D030 rejects duplicate/conflicting %s population without filtering it away', async kind => {
  const s = await fixture();
  await s.insert(kind === 'other-harness' ? 'other-harness' : harness, kind === 'other-tool' ? 'other:tool' : undefined);
  expect(await s.inspect()).toEqual(unknown);
});

it('D030 activity/reconciliation rows and declared origin=hook cannot manufacture a candidate', async () => {
  const s = await fixture();
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations`;
  await f.db.adminSql`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,summary,detail)
    VALUES (${workspaceId},${harness},${owner},'codex',${s.source.namespace},'tool',${s.source.tool},'pre',
      ${s.source.callId},'Canonical native operation','{"origin":"hook","authority":true}')`;
  expect(await s.inspect()).toEqual(unknown);
  s.metadata.requestOrigin.nativeSession.carrier = 'query:native_session';
  await s.insert();
  expect(await s.inspect()).toEqual(unknown);
});

it.each(['delete', 'rewrite', 'runtime', 'revoke'])('D030 fresh %s invalidates a prior exact candidate and an overlapping read', async mutation => {
  const s = await fixture();
  expect((await s.inspect()).correlation).toBe('exact');
  let reads = 0;
  const authorize = async () => {
    if (++reads !== 2) return true;
    if (mutation === 'revoke') return false;
    if (mutation === 'delete') await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${s.id}::bigint`;
    if (mutation === 'rewrite') await f.db.adminSql`UPDATE harness_shared.tool_invocations
      SET metadata_json='{}'::jsonb WHERE id=${s.id}::bigint`;
    if (mutation === 'runtime') await f.db.adminSql`UPDATE harness_shared.adv_sessions
      SET coord_owner_id='su-rebound' WHERE id=${s.binding.id}::bigint`;
    return true;
  };
  expect(await inspectNativeDispatchCandidate(s.source, s.binding, { ...s.opts, authorize })).toEqual(unknown);
  expect(await inspectNativeDispatchCandidate(s.source, s.binding, { ...s.opts, authorize: async () => mutation !== 'revoke' })).toEqual(unknown);
});
