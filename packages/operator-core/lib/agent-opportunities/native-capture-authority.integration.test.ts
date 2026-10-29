import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionNativeRuntimeBearer, verifyNativeRuntimeBearer } from '@papercusp/agent-mcp/provisioning';
import { registerProjectedTool, _resetProjectionRegistryForTests, type ProjectedTool } from '@papercusp/tooldef/tool-projection';
import { runDispatchStack, type UnifiedToolContext } from '@papercusp/tooldef';
import { NativeInstalledPerUseTurns } from '../agent-tools/per-use-chokepoint';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { appendAuthorizedNativeDispatch, verifyNativeDispatchReceipt, inspectNativeDispatchCandidate, readAuthorizedNativeDispatch,
  reconcileNativeCapture, type NativeDispatchAppend } from './native-capture';
import type { SearchSource } from './search-reformulation';
import { productionOpportunityReaders } from './source-readers';
import { canonicalJson } from '../external-bench/reproducibility/canonical-json';

let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
let root: string, oldCodexRoot: string | undefined;
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
beforeAll(async () => {
  f = await sqlMiningFixture(); registerProjectedTool(tool);
  root = await mkdtemp(join(tmpdir(), 'native-authority-'));
  oldCodexRoot = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR; process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
}, 120_000);
afterAll(async () => {
  _resetProjectionRegistryForTests(); await f?.cleanup();
  if (oldCodexRoot === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = oldCodexRoot;
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => { await f.clear(); await f.db.adminSql`DELETE FROM harness_shared.adv_sessions`; });

async function signingFixture() {
  await f.db.adminSql`CREATE TABLE IF NOT EXISTS harness_shared.operator_secrets
    (name text PRIMARY KEY,value_b64 text NOT NULL)`;
  await f.db.adminSql`INSERT INTO harness_shared.operator_secrets (name,value_b64)
    VALUES ('spawn-signing-key',${Buffer.alloc(32, 73).toString('base64')})
    ON CONFLICT (name) DO UPDATE SET value_b64=EXCLUDED.value_b64`;
  await f.db.adminSql`DELETE FROM harness_shared.agent_activity`;
  const input: NativeDispatchAppend = { workspaceId, harnessSlug: harness, ownerId: owner, advSessionId: 7,
    nativeSessionId: 'issued-native-session', callId: 'exact-call', toolName: 'native-proof:inspect',
    argsFingerprint: sha('{"query":"private-query"}'), principal: { slug: 'system:superuser',
      kind: 'system', authMethod: 'bearer-token', trust: 'trusted' } };
  const rows = () => f.db.adminSql<{ detail: { nativeDispatch: Record<string, unknown> } }[]>`
    SELECT detail FROM harness_shared.agent_activity WHERE workspace_id=${workspaceId}`;
  return { input, rows };
}

it('protected append signs only the exact attempt and does not retain arguments or credentials', async () => {
  const s = await signingFixture(), authorize = vi.fn(async () => true);
  expect(await appendAuthorizedNativeDispatch(s.input, authorize, f.db.adminSql)).toBe(true);
  expect(authorize).toHaveBeenCalledTimes(3);
  const rows = await s.rows(), receipt = rows[0]!.detail.nativeDispatch;
  expect(rows).toHaveLength(1);
  expect(await verifyNativeDispatchReceipt(receipt, f.db.adminSql)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('private-query');
  for (const field of ['activityId', 'workspaceId', 'harnessSlug', 'ownerId', 'nativeSessionId', 'callId', 'toolName', 'argsFingerprint']) {
    expect(await verifyNativeDispatchReceipt({ ...receipt, [field]: 'substituted' }, f.db.adminSql)).toBe(false);
  }
  expect(await verifyNativeDispatchReceipt({ ...receipt, principal: { ...s.input.principal, slug: 'other' } }, f.db.adminSql)).toBe(false);
  expect(await verifyNativeDispatchReceipt({ ...receipt, authority: true }, f.db.adminSql)).toBe(false);
  await f.db.adminSql`UPDATE harness_shared.operator_secrets SET value_b64=${Buffer.alloc(32, 74).toString('base64')}
    WHERE name='spawn-signing-key'`;
  expect(await verifyNativeDispatchReceipt(receipt, f.db.adminSql)).toBe(false);
});

it.each([1, 2, 3])('protected append rolls back when authority is withdrawn at check %s', async denied => {
  const s = await signingFixture(); let checks = 0;
  expect(await appendAuthorizedNativeDispatch(s.input, async () => ++checks !== denied, f.db.adminSql)).toBe(false);
  expect(await s.rows()).toHaveLength(0);
});

it.each(['wildcard', 'wrapper', 'bad-key'])('protected append refuses %s without changing the activity index', async kind => {
  const s = await signingFixture();
  if (kind === 'wildcard') s.input.harnessSlug = '*';
  if (kind === 'wrapper') s.input.toolName = 'tools:invoke';
  if (kind === 'bad-key') await f.db.adminSql`UPDATE harness_shared.operator_secrets SET value_b64=''
    WHERE name='spawn-signing-key'`;
  expect(await appendAuthorizedNativeDispatch(s.input, async () => true, f.db.adminSql)).toBe(false);
  expect(await s.rows()).toHaveLength(0);
});

it('real issuer possession and host observation reach the existing dispatcher ACL and transactional receipt writer', async () => {
  const s = await fixture(), signing = await signingFixture();
  const issuer = { kind: 'system' as const, slug: 'system:superuser', workspaceId,
    trust: 'trusted' as const, authMethod: 'bearer-token' as const, capabilities: new Set(['*']) };
  const issued = await provisionNativeRuntimeBearer({ workspaceId, advSessionId: Number(s.binding.id), issuer });
  const registry = new NativeInstalledPerUseTurns();
  const hooks = registry.register({ workspaceId, ownerId: owner, principalId: 'synthetic-commerce-only',
    advSessionId: Number(s.binding.id), nativeSessionId: s.source.namespace!, ownerTurnId: 'host-owner-turn',
    mcpServer: 'papercusp-su', nativeTools: { native_proof_inspect: 'native-proof:inspect' }, admissions: [],
    resolveRequestPrincipal: async () => issuer });
  try {
    await hooks.bindNativeTurn('native-turn');
    await hooks.observeToolCall!({ nativeTurnId: 'native-turn', callId: s.source.callId!, server: 'papercusp-su',
      tool: 'native_proof_inspect', arguments: s.source.args });
    const principal = await registry.resolveRequestPrincipal({ workspaceId, ownerId: owner,
      advSessionId: Number(s.binding.id), nativeSessionFingerprint: sha(s.source.namespace!),
      callIdFingerprint: sha(s.source.callId!), toolName: 'native-proof:inspect', arguments: s.source.args,
      runtimeBearer: issued.bearer });
    expect(principal?.slug).toBe('system:superuser');
    const authorize = vi.fn(async () => ({ allow: true })), fn = vi.fn(async () => ({ content: [] }));
    const ctx = { workspaceId, harnessSlug: harness, uiClientId: owner, transport: 'mcp', role: 'operator', principal,
      requestOrigin: s.metadata.requestOrigin, signal: new AbortController().signal,
      log: vi.fn(), progress: vi.fn(), emit: vi.fn() } as unknown as UnifiedToolContext;
    const result = await runDispatchStack({ ...tool, requirePrincipal: true, authorize, fn }, 'native-proof:inspect',
      s.source.args, ctx, { aroundInvoke: async request => {
        expect(await registry.appendAuthorizedCapture(request, (input, renew) =>
          appendAuthorizedNativeDispatch(input, renew, f.db.adminSql))).toBe(true);
        return request.invoke();
      } });
    expect(result.ok).toBe(true); expect(fn).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledTimes(4);
    const rows = await signing.rows(); expect(rows).toHaveLength(1);
    expect(await verifyNativeDispatchReceipt(rows[0]!.detail.nativeDispatch, f.db.adminSql)).toBe(true);
    expect(rows[0]!.detail.nativeDispatch).toMatchObject({ advSessionId: Number(s.binding.id),
      ownerId: owner, harnessSlug: harness, nativeSessionId: s.source.namespace, callId: s.source.callId });
    const native = await canonicalFixture(s);
    expect((await productionOpportunityReaders(native.opts).readTranscript(native.input))?.sources[0]?.args).toEqual(s.source.args);
    // This proves one attempt only; continuity still requires all source calls.
    expect(await reconcileNativeCapture({ ...s.opts, harnessSlug: harness, sourceBoundary: 'tool-ledger',
      since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' })).toBe('unknown');
  } finally { await hooks.withdraw(); }
});
async function fixture() {
  const sessionId = randomUUID();
  const [r] = await f.db.adminSql`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,agent,session_id) VALUES (${workspaceId},'console',${owner},'codex',${sessionId}) RETURNING id::text`;
  const binding = { id: String(r!.id), owner, provider: 'codex' as const, harness: null };
  const source: SearchSource = { workspaceId, harnessSlug: harness, authorizationScope: 'tool-ledger',
    actor: owner, provider: 'codex', namespace: sessionId, callId: 'native-call',
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

async function canonicalFixture(s: Awaited<ReturnType<typeof fixture>>) {
  const [row] = await f.db.adminSql<{ id: string }[]>`SELECT id::text FROM harness_shared.agent_activity
    WHERE detail->'nativeDispatch'->>'nativeSessionId'=${s.source.namespace!}`;
  const input = { id: row!.id, actor: owner, provider: 'codex' as const, sessionId: s.source.namespace!, callId: s.source.callId! };
  const opts = { ...s.opts, harnessSlug: harness, sourceBoundary: 'tool-ledger' };
  const dir = join(root, `session-${s.binding.id}`, 'sessions'); await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-time-${input.sessionId}.jsonl`);
  const records = [
    { type: 'session_meta', payload: { id: input.sessionId } },
    { type: 'response_item', timestamp: s.source.at, payload: { type: 'function_call',
      name: s.source.tool, call_id: input.callId, arguments: JSON.stringify(s.source.args) } },
    { type: 'response_item', timestamp: s.source.at, payload: { type: 'function_call_output',
      call_id: input.callId, output: '{"private":"canonical-result"}' } },
  ];
  await writeFile(path, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { ...s, input, opts, path, records };
}

async function authorizedFixture() {
  const s = await fixture(), signing = await signingFixture();
  expect(await appendAuthorizedNativeDispatch({ ...signing.input, advSessionId: Number(s.binding.id),
    nativeSessionId: s.source.namespace!, callId: s.source.callId!, argsFingerprint: sha(canonicalJson(s.source.args)) },
  async () => true, f.db.adminSql)).toBe(true);
  return canonicalFixture(s);
}

async function eventCopy(s: Awaited<ReturnType<typeof authorizedFixture>>, at = s.source.at) {
  // An event index copies identity, never the signed detail or receipt ID.
  const [row] = await f.db.adminSql`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,created_at)
    SELECT workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,'{}'::jsonb,${at}::timestamptz
    FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint RETURNING id::text`;
  return { ...s.input, id: String(row!.id) };
}

it('pairs an unsigned event-time index only with the independent original receipt and canonical event', async () => {
  const s = await authorizedFixture(), input = await eventCopy(s);
  const [times] = await f.db.adminSql`SELECT
    (SELECT created_at FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint)
      IS DISTINCT FROM created_at AS distinct_times,detail
    FROM harness_shared.agent_activity WHERE id=${input.id}::bigint`;
  expect(times).toMatchObject({ distinct_times: true, detail: {} });
  const read = productionOpportunityReaders(s.opts).readTranscript;
  expect((await read(input))?.sources[0]?.at).toBe(s.source.at);
  expect((await read(input))?.sources[0]?.result?.body).toEqual({ private: 'canonical-result' });
  expect(await reconcileNativeCapture({ ...s.opts, since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' })).toBe('unknown');
});

it.each(['event-time', 'receipt-time', 'scope', 'owner', 'tool', 'session', 'call', 'original-loss', 'revoked'] as const)(
  'an unsigned event-time index cannot replace original authority after %s', async mismatch => {
    const s = await authorizedFixture(), input = await eventCopy(s,
      mismatch === 'event-time' ? '2026-10-25T12:00:00.000001Z' : s.source.at);
    if (mismatch === 'receipt-time') await f.db.adminSql`UPDATE harness_shared.agent_activity
      SET created_at=created_at + interval '1 microsecond' WHERE id=${s.input.id}::bigint`;
    if (mismatch === 'scope') await f.db.adminSql`UPDATE harness_shared.agent_activity SET harness_slug='other' WHERE id=${input.id}::bigint`;
    if (mismatch === 'owner') await f.db.adminSql`UPDATE harness_shared.agent_activity SET owner_id='su-other' WHERE id=${input.id}::bigint`;
    if (mismatch === 'tool') await f.db.adminSql`UPDATE harness_shared.agent_activity SET tool_name='tools:invoke' WHERE id=${input.id}::bigint`;
    if (mismatch === 'session') await f.db.adminSql`UPDATE harness_shared.agent_activity SET session_id='other' WHERE id=${input.id}::bigint`;
    if (mismatch === 'call') await f.db.adminSql`UPDATE harness_shared.agent_activity SET tool_use_id='other' WHERE id=${input.id}::bigint`;
    if (mismatch === 'original-loss') await f.db.adminSql`DELETE FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
    const opts = { ...s.opts, authorize: async () => mismatch !== 'revoked' };
    expect(await productionOpportunityReaders(opts).readTranscript(input)).toBeNull();
  });

it('consumes the row-bound receipt only for its independent canonical source and current read ACL', async () => {
  const s = await authorizedFixture();
  expect(await readAuthorizedNativeDispatch({ ...s.input, source: s.source }, s.opts)).toMatchObject({ binding: { id: s.binding.id } });
  const locateTranscript = vi.fn(async () => '/untrusted/override');
  const result = await productionOpportunityReaders(s.opts, { locateTranscript }).readTranscript(s.input);
  expect(result?.sources).toHaveLength(1);
  expect(result?.sources[0]?.result?.body).toEqual({ private: 'canonical-result' });
  expect(locateTranscript).not.toHaveBeenCalled();
  expect(await productionOpportunityReaders({ ...s.opts, authorize: async () => false }).readTranscript(s.input)).toBeNull();
  // Even an independently valid exact attempt never supplies a root certificate.
  expect(await reconcileNativeCapture({ ...s.opts, since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' })).toBe('unknown');
});

it.each(['arguments', 'tool', 'provider', 'owner', 'scope', 'call', 'session', 'incomplete'])(
  'rejects a canonical-source %s mismatch despite a valid signature', async mismatch => {
    const s = await authorizedFixture();
    const source = { ...s.source };
    if (mismatch === 'arguments') source.args = { harness, query: 'different' };
    if (mismatch === 'tool') source.tool = 'mcp__papercusp_su__tools_invoke';
    if (mismatch === 'provider') source.provider = 'claude';
    if (mismatch === 'owner') source.actor = 'su-other';
    if (mismatch === 'scope') source.harnessSlug = 'other';
    if (mismatch === 'call') source.callId = 'other';
    if (mismatch === 'session') source.namespace = randomUUID();
    if (mismatch === 'incomplete') source.sourceComplete = false;
    expect(await readAuthorizedNativeDispatch({ ...s.input, source }, s.opts)).toBeNull();
  });

it.each(['arguments', 'identity', 'truncated', 'missing'])(
  'production body reader refuses %s canonical files instead of trusting the receipt', async mismatch => {
    const s = await authorizedFixture();
    if (mismatch === 'missing') await rm(s.path);
    else if (mismatch === 'truncated') await writeFile(s.path, (await readFile(s.path)).subarray(0, -1));
    else {
      if (mismatch === 'arguments') s.records[1]!.payload.arguments = '{"harness":"mining-test","query":"other"}';
      else s.records[0]!.payload.id = randomUUID();
      await writeFile(s.path, s.records.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    expect(await productionOpportunityReaders(s.opts).readTranscript(s.input)).toBeNull();
  });

it.each(['duplicate-dispatch', 'duplicate-receipt', 'replacement-copy', 'row-scope', 'runtime-owner', 'key-rotation'])(
  'rejects %s across the whole call population', async mismatch => {
    const s = await authorizedFixture();
    let input = s.input;
    if (mismatch === 'duplicate-dispatch') await s.insert('other-harness', 'other:tool');
    if (mismatch === 'duplicate-receipt' || mismatch === 'replacement-copy') {
      const [copy] = await f.db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.agent_activity
        (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,created_at)
        SELECT workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,created_at
        FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint RETURNING id::text`;
      if (mismatch === 'replacement-copy') {
        await f.db.adminSql`DELETE FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
        input = { ...input, id: copy!.id };
      }
    }
    if (mismatch === 'row-scope') await f.db.adminSql`UPDATE harness_shared.agent_activity SET harness_slug='other'
      WHERE id=${s.input.id}::bigint`;
    if (mismatch === 'runtime-owner') await f.db.adminSql`UPDATE harness_shared.adv_sessions SET coord_owner_id='su-other'
      WHERE id=${s.binding.id}::bigint`;
    if (mismatch === 'key-rotation') await f.db.adminSql`UPDATE harness_shared.operator_secrets
      SET value_b64=${Buffer.alloc(32, 74).toString('base64')} WHERE name='spawn-signing-key'`;
    expect(await productionOpportunityReaders(s.opts).readTranscript(input)).toBeNull();
  });

it('rechecks current ACL and full population after filesystem and authorization awaits', async () => {
  const s = await authorizedFixture(); let checks = 0;
  expect(await productionOpportunityReaders({ ...s.opts, authorize: async () => ++checks < 4 }).readTranscript(s.input)).toBeNull();
  expect(checks).toBe(4); // Three preflight checks, then the first check after canonical IO.
  checks = 0;
  expect(await readAuthorizedNativeDispatch(s.input, { ...s.opts, authorize: async () => {
    if (++checks === 2) await s.insert('other');
    return true;
  } })).toBeNull();
});

it('does not scope an unsigned sibling in the same canonical runtime', async () => {
  const s = await authorizedFixture();
  const sibling = { ...s.records[1]!, payload: { ...s.records[1]!.payload, call_id: 'unsigned-sibling' } };
  await writeFile(s.path, [...s.records, sibling].map(r => JSON.stringify(r)).join('\n') + '\n');
  expect((await productionOpportunityReaders(s.opts).readTranscript(s.input))?.sources).toHaveLength(1);
  expect(await productionOpportunityReaders(s.opts).readTranscript({ ...s.input, callId: 'unsigned-sibling' })).toBeNull();
});

it.each(['receipt', 'event-index'] as const)('discards a canonical source changed during final authority renewal through %s', async via => {
  const s = await authorizedFixture(); let checks = 0;
  const input = via === 'receipt' ? s.input : await eventCopy(s);
  const result = await productionOpportunityReaders({ ...s.opts, authorize: async () => {
    if (++checks === 5) {
      s.records[1]!.payload.arguments = '{"harness":"mining-test","query":"rewritten-after-read"}';
      await writeFile(s.path, s.records.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    return true;
  } }).readTranscript(input);
  expect(checks).toBeGreaterThanOrEqual(5);
  expect(result).toBeNull();
});

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
