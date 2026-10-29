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
  canonicalNativeRuntimeSources, reconcileAuthorizedNativeCall, reconcileNativeCapture, type NativeDispatchAppend } from './native-capture';
import type { SearchSource } from './search-reformulation';
import { productionOpportunityReaders } from './source-readers';
import { canonicalJson } from '../external-bench/reproducibility/canonical-json';

let f: Awaited<ReturnType<typeof sqlMiningFixture>>;
let root: string, oldCodexRoot: string | undefined;
const nativeBodyReads = vi.hoisted(() => ({ target: '', opens: 0 }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === nativeBodyReads.target) nativeBodyReads.opens++;
    return fs.open(...args);
  } };
});
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

it.each(['included', 'excluded'] as const)('D030 each canonical call earns its own %s receipt scope', async scope => {
  const s = await authorizedFixture();
  const requested = scope === 'included' ? harness : 'separate-harness';
  const opts = { ...s.opts, harnessSlug: requested };
  const read = await canonicalNativeRuntimeSources(s.binding, opts);
  const call = read.sources[0]!;
  expect(call.harnessSlug).toBe(requested); // Parser context is not authority.
  const proof = await reconcileAuthorizedNativeCall(call, s.binding, opts);
  expect(proof).toMatchObject({ scope, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(proof)).not.toMatch(/private-query|separate-harness|su-exact-call/);
  expect(await reconcileAuthorizedNativeCall({ ...call, callId: 'unsigned-sibling' }, s.binding, opts)).toBeNull();
  expect(s.binding.harness).toBeNull();
});

it.each(['receipt-loss', 'invocation-loss', 'duplicate-other-scope', 'conflicting-row-identity', 'key-rotation', 'runtime', 'args', 'acl'] as const)(
  'D030 per-call scope is renewed after %s rather than borrowed from a previous proof', async mutation => {
    const s = await authorizedFixture();
    const read = await canonicalNativeRuntimeSources(s.binding, s.opts), call = read.sources[0]!;
    expect(await reconcileAuthorizedNativeCall(call, s.binding, s.opts)).toMatchObject({ scope: 'included' });
    if (mutation === 'receipt-loss') await f.db.adminSql`DELETE FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
    if (mutation === 'invocation-loss') await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${s.id}::bigint`;
    if (mutation === 'duplicate-other-scope') await f.db.adminSql`INSERT INTO harness_shared.agent_activity
      (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,created_at)
      SELECT workspace_id,'other-harness',owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,created_at
      FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
    if (mutation === 'conflicting-row-identity') await f.db.adminSql`INSERT INTO harness_shared.agent_activity
      (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,created_at)
      SELECT workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,
        jsonb_set(detail,'{nativeDispatch,callId}','"tampered-other-call"'::jsonb),created_at
      FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
    if (mutation === 'key-rotation') await f.db.adminSql`UPDATE harness_shared.operator_secrets
      SET value_b64=${Buffer.alloc(32, 74).toString('base64')} WHERE name='spawn-signing-key'`;
    if (mutation === 'runtime') s.binding.id = String(Number(s.binding.id) + 100000);
    if (mutation === 'args') call.args = { harness, query: 'substituted' };
    expect(await reconcileAuthorizedNativeCall(call, s.binding,
      { ...s.opts, authorize: async () => mutation !== 'acl' })).toBeNull();
  });

it.each(['exec_command', 'functions.exec', 'browser', 'tools:invoke', 'code:run'])(
  'D030 unreceipted native or wrapper %s cannot use its sibling scope', async tool => {
    const s = await authorizedFixture();
    const read = await canonicalNativeRuntimeSources(s.binding, s.opts);
    expect(await reconcileAuthorizedNativeCall({ ...read.sources[0]!, tool }, s.binding, s.opts)).toBeNull();
  });

it.each(['authorized', 'unknown-sibling', 'outside-scope'] as const)(
  'D030 production source phase reconciles %s calls before earning a prospective floor', async kind => {
    const s = await authorizedFixture();
    await f.db.adminSql.unsafe(await readFile(new URL(
      '../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url), 'utf8'));
    const opts = { ...s.opts, since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
    await f.db.adminSql`UPDATE harness_shared.adv_sessions SET first_seen_at=${opts.since}::timestamptz
      WHERE id=${s.binding.id}::bigint`;
    if (kind !== 'authorized') {
      s.records.push({ type: 'response_item', timestamp: s.source.at, payload: { type: 'function_call',
        name: s.source.tool, call_id: 'sibling-call', arguments: JSON.stringify({ harness: 'other-harness', query: 'sibling' }) } });
      await writeFile(s.path, s.records.map(r => JSON.stringify(r)).join('\n') + '\n');
      if (kind === 'outside-scope') {
        s.source.callId = 'sibling-call'; s.source.args = { harness: 'other-harness', query: 'sibling' };
        s.metadata.requestOrigin.nativeSession.callIdFingerprint = sha(s.source.callId);
        await s.insert('other-harness');
        const signing = await signingFixture(); // This fixture clears activity; restore both originals below.
        for (const [callId, scope, args] of [
          ['native-call', harness, { harness, query: 'private-query' }],
          ['sibling-call', 'other-harness', s.source.args],
        ] as const) expect(await appendAuthorizedNativeDispatch({ ...signing.input,
          advSessionId: Number(s.binding.id), nativeSessionId: s.source.namespace!, callId,
          harnessSlug: scope, argsFingerprint: sha(canonicalJson(args)) }, async () => true, f.db.adminSql)).toBe(true);
      }
    }
    const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt,
      native_capture_from::text AS floor FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0];
    // First turn only prepares identities; sourceEnrollment never scopes calls.
    expect(await reconcileNativeCapture(opts)).toBe('unknown');
    const enrolled = await receipt();
    expect(enrolled?.receipt).toMatchObject({ sourceEnrollment: { prepared: true } });
    let latest = enrolled;
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(await reconcileNativeCapture(opts)).toBe('unknown');
      latest = await receipt();
      if (kind === 'unknown-sibling' || Object.keys(latest?.receipt?.sourceReconciliation?.roots ?? {}).length) break;
    }
    const roots = Object.values(latest?.receipt?.sourceReconciliation?.roots ?? {}) as { calls: Record<string, { scope: string }> }[];
    if (kind === 'unknown-sibling') expect(roots).toHaveLength(0);
    else {
      expect(roots).toHaveLength(1);
      expect(Object.values(roots[0]!.calls).map(p => p.scope).sort()).toEqual(
        kind === 'authorized' ? ['included'] : ['excluded', 'included']);
    }
    if (kind === 'unknown-sibling') expect(latest?.floor).toBe(enrolled?.floor);
    else {
      expect(latest?.receipt.sourceReconciliation.closed).toMatchObject({ from: expect.any(String), signature: expect.any(String) });
      expect(new Date(latest!.floor).getTime()).toBeGreaterThanOrEqual(new Date(enrolled!.floor).getTime());
    }
    expect(JSON.stringify(latest?.receipt)).not.toMatch(/private-query|sibling-call|other-harness|su-exact-call/);
    // Only independently authorized INCLUDED canonical calls get an event-time
    // index copy; a root or an exclusion never supplies index scope.
    expect((await f.db.adminSql`SELECT id FROM harness_shared.agent_activity
      WHERE NOT (detail ? 'nativeDispatch')`)).toHaveLength(1);
  }, 120_000);

it.each(['excluded-receipt-loss', 'excluded-receipt-rewrite', 'invocation-loss', 'key-rotation', 'source-rewrite'] as const)(
  'D030 final ACL renewal revokes prepared exclusions after %s without relying on requested-scope CAS', async mutation => {
    const s = await authorizedFixture();
    await f.db.adminSql.unsafe(await readFile(new URL(
      '../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url), 'utf8'));
    const opts = { ...s.opts, harnessSlug: 'requested-scope', since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
    await f.db.adminSql`UPDATE harness_shared.adv_sessions SET first_seen_at=${opts.since}::timestamptz
      WHERE id=${s.binding.id}::bigint`;
    expect(await reconcileNativeCapture(opts)).toBe('unknown');
    const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt,
      native_capture_revision::text AS revision,native_capture_from::text AS floor
      FROM harness_shared.sql_intent_progress WHERE harness_slug=${opts.harnessSlug}`)[0]!;
    const before = await receipt();
    expect(before.receipt.sourceEnrollment.prepared).toBe(true);
    let populations = 0, mutated = false;
    const client = new Proxy(f.db.adminSql, { apply(target, thisArg, args) {
      if (Array.isArray(args[0]) && args[0].join('').includes('SELECT s.id::text,s.coord_owner_id')) populations++;
      return Reflect.apply(target, thisArg, args);
    } });
    // The third population read follows the source/root's own authority
    // renewal. Mutate from the NEXT (final) ACL callback, after that renewal.
    const authorize = async () => {
      if (populations < 3 || mutated) return true;
      mutated = true;
      if (mutation === 'excluded-receipt-loss') await f.db.adminSql`DELETE FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
      if (mutation === 'excluded-receipt-rewrite') await f.db.adminSql`UPDATE harness_shared.agent_activity SET
        detail=jsonb_set(detail,'{nativeDispatch,callId}','"changed-call"'::jsonb) WHERE id=${s.input.id}::bigint`;
      if (mutation === 'invocation-loss') await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${s.id}::bigint`;
      if (mutation === 'key-rotation') await f.db.adminSql`UPDATE harness_shared.operator_secrets
        SET value_b64=${Buffer.alloc(32, 74).toString('base64')} WHERE name='spawn-signing-key'`;
      if (mutation === 'source-rewrite') await writeFile(s.path, JSON.stringify(s.records[0]) + '\n');
      return true;
    };
    expect(await reconcileNativeCapture({ ...opts, client, authorize })).toBe('unknown');
    expect(mutated).toBe(true);
    const after = await receipt();
    expect(after.revision).toBe(before.revision); // This is the cross-harness detector gap.
    expect(after.floor).toBe(before.floor);
    expect(Object.keys(after.receipt.sourceReconciliation.roots)).toHaveLength(0);
  }, 120_000);

it.each(['fixed', 'moving'] as const)('D030 production source preparation resumes bounded chunks with a %s window without storing transcript content or advancing the floor', async window => {
  const s = await authorizedFixture();
  await f.db.adminSql.unsafe(await readFile(new URL(
    '../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url), 'utf8'));
  const opts = { ...s.opts, since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
  await f.db.adminSql`UPDATE harness_shared.adv_sessions SET first_seen_at=${opts.since}::timestamptz
    WHERE id=${s.binding.id}::bigint`;
  const padding = JSON.stringify({ type: 'metadata', note: 'private-padding'.repeat(2400) });
  await writeFile(s.path, [JSON.stringify(s.records[0]), JSON.stringify(s.records[1]),
    ...Array<string>(280).fill(padding), JSON.stringify(s.records[2])].join('\n') + '\n');
  const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt,
    native_capture_from::text AS floor FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!;
  expect(await reconcileNativeCapture(opts)).toBe('unknown');
  const enrolled = await receipt();
  let latest = enrolled, lastOffset = 0, partials = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = window === 'fixed' ? opts : { ...opts,
      since: new Date(Date.parse(opts.since) + attempt * 1000).toISOString(),
      until: new Date(Date.parse(opts.until) + attempt * 1000).toISOString() };
    expect(await reconcileNativeCapture(current)).toBe('unknown'); latest = await receipt();
    const pending = Object.values(latest.receipt.sourceReconciliation.pending ?? {}) as {
      continuation: { files: Record<string, { offset: number; done: boolean }> }; calls: Record<string, unknown>;
    }[];
    if (Object.keys(latest.receipt.sourceReconciliation.roots).length) break;
    expect(pending).toHaveLength(1);
    const files = Object.values(pending[0]!.continuation.files);
    expect(files).toHaveLength(1);
    const offset = files[0]!.offset;
    expect(offset).toBeGreaterThan(lastOffset);
    expect(offset - lastOffset).toBeLessThanOrEqual(4 * 1024 * 1024 + 64 * 1024);
    expect(files[0]!.done).toBe(false);
    expect(Object.keys(pending[0]!.calls)).toHaveLength(1);
    expect(latest.floor).toBe(enrolled.floor);
    expect(JSON.stringify(latest.receipt)).not.toMatch(/private-query|private-padding|canonical-result|jsonl|su-exact-call/);
    lastOffset = offset; partials++;
  }
  expect(partials).toBeGreaterThan(0);
  expect(Object.values(latest.receipt.sourceReconciliation.roots)).toMatchObject([
    { calls: { [sha(JSON.stringify([owner, 'codex', s.source.namespace, s.source.callId]))]: { scope: 'included' } } },
  ]);
  expect(latest.receipt.sourceReconciliation.pending).toEqual({});
  expect(latest.receipt.sourceReconciliation.closed).toMatchObject({ from: expect.any(String) });
  expect(new Date(latest.floor).getTime()).toBeGreaterThanOrEqual(new Date(enrolled.floor).getTime());
}, 120_000);

it.each(['before', 'after'] as const)(
  'D032 moving windows reopen a parsed prefix when an omitted %s call enters', async side => {
    const s = await authorizedFixture();
    await f.db.adminSql.unsafe(await readFile(new URL(
      '../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url), 'utf8'));
    const opts = { ...s.opts, since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
    await f.db.adminSql`UPDATE harness_shared.adv_sessions SET first_seen_at='2026-10-24T00:00:00Z'::timestamptz
      WHERE id=${s.binding.id}::bigint`;
    const omittedAt = side === 'before' ? '2026-10-24T23:59:59Z' : opts.until;
    const omitted = { type: 'response_item', timestamp: omittedAt, payload: {
      type: 'function_call', name: s.source.tool, call_id: 'unproved-entering-call', arguments: '{}' } };
    const padding = JSON.stringify({ type: 'metadata', note: 'private-padding'.repeat(2400) });
    await writeFile(s.path, [JSON.stringify(s.records[0]), JSON.stringify(omitted), JSON.stringify(s.records[1]),
      ...Array<string>(280).fill(padding), JSON.stringify(s.records[2])].join('\n') + '\n');
    const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt,
      native_capture_from::text AS floor FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!;
    expect(await reconcileNativeCapture(opts)).toBe('unknown');
    expect(await reconcileNativeCapture(opts)).toBe('unknown');
    const before = await receipt();
    const pending = Object.values(before.receipt.sourceReconciliation.pending) as {
      coverage: { before: string | null; after: string | null }; calls: Record<string, unknown>;
    }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.coverage[side]).toBe(omittedAt);
    expect(Object.keys(pending[0]!.calls)).toHaveLength(1);
    // A tick strictly before the omitted event can keep parsing. Entering the
    // event (inclusive since / exclusive until) must revisit its own authority.
    const entering = side === 'before' ? { ...opts, since: omittedAt }
      : { ...opts, until: '2026-10-26T00:00:00.001Z' };
    expect(await reconcileNativeCapture(entering)).toBe('unknown');
    const after = await receipt();
    expect(after.floor).toBe(before.floor);
    expect(after.receipt.sourceReconciliation.pending).toEqual({});
    expect(after.receipt.sourceReconciliation.roots).toEqual({});
    expect(after.receipt.sourceReconciliation.closed).toBeUndefined();
  }, 120_000);

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

it('D032 binds reusable canonical parsing to its original protected preparation, not serialized call labels', async () => {
  const s = await authorizedFixture();
  await f.db.adminSql.unsafe(await readFile(new URL(
    '../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url), 'utf8'));
  const opts = { ...s.opts, since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
  await f.db.adminSql`UPDATE harness_shared.adv_sessions SET first_seen_at=${opts.since}::timestamptz
    WHERE id=${s.binding.id}::bigint`;
  const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt
    FROM harness_shared.sql_intent_progress WHERE harness_slug=${harness}`)[0]!.receipt;
  for (let attempt = 0; attempt < 20; attempt++) {
    expect(await reconcileNativeCapture(opts)).toBe('unknown');
    if (Object.keys((await receipt()).sourceReconciliation.roots).length) break;
  }
  const saved = await receipt(), rootKey = Object.keys(saved.sourceReconciliation.roots)[0]!;
  expect(saved.sourceReconciliation.roots[rootKey].signature).toMatch(/^[a-f0-9]{64}$/);
  const [callKey] = Object.keys(saved.sourceReconciliation.roots[rootKey].calls);
  expect(saved.sourceReconciliation.roots[rootKey].calls[callKey!]).toMatchObject({ activityId: s.input.id, at: s.source.at });
  // This is an actual additional canonical call, not a caller-supplied source.
  // Copying an old root or changing its signed call population cannot hide it.
  s.records.push({ type: 'response_item', timestamp: s.source.at, payload: { type: 'function_call',
    name: s.source.tool, call_id: 'unproved-sibling', arguments: '{}' } });
  await writeFile(s.path, s.records.map(r => JSON.stringify(r)).join('\n') + '\n');
  saved.sourceReconciliation.roots[rootKey].calls[callKey!].scope = 'excluded';
  await f.db.adminSql`UPDATE harness_shared.sql_intent_progress SET native_capture_receipt=${f.db.adminSql.json(saved)}`;
  expect(await reconcileNativeCapture(opts)).toBe('unknown');
  expect(Object.keys((await receipt()).sourceReconciliation.roots)).toHaveLength(0);
}, 120_000);

it('D032 earns a prospective floor and renews current authority while reusing unchanged canonical parsing', async () => {
  const s = await authorizedFixture();
  await f.db.adminSql.unsafe(await readFile(new URL(
    '../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url), 'utf8'));
  const opts = { ...s.opts, since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
  await f.db.adminSql`UPDATE harness_shared.adv_sessions SET first_seen_at=${opts.since}::timestamptz
    WHERE id=${s.binding.id}::bigint`;
  const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt,
    native_capture_from::text AS floor FROM harness_shared.sql_intent_progress WHERE harness_slug=${harness}`)[0]!;
  for (let attempt = 0; attempt < 20; attempt++) {
    expect(await reconcileNativeCapture(opts)).toBe('unknown');
    if ((await receipt()).receipt.sourceReconciliation.closed) break;
  }
  const baseline = await receipt();
  expect(baseline.receipt.sourceReconciliation.closed).toMatchObject({ from: expect.any(String) });
  const [{ detail }] = await f.db.adminSql`SELECT detail FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
  const original = detail.nativeDispatch;
  const [{ now }] = await f.db.adminSql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`;
  s.source.callId = 'after-floor'; s.source.at = now;
  s.metadata.requestOrigin.nativeSession.callIdFingerprint = sha(s.source.callId);
  await s.insert();
  expect(await appendAuthorizedNativeDispatch({ workspaceId, harnessSlug: harness, ownerId: owner,
    advSessionId: Number(s.binding.id), nativeSessionId: s.source.namespace!, callId: s.source.callId,
    toolName: original.toolName, argsFingerprint: original.argsFingerprint, principal: original.principal },
  async () => true, f.db.adminSql)).toBe(true);
  const appended = await receipt();
  // A brand-new protected attempt is an INSERT, not destructive loss of an
  // earlier proof. Its transactional signing must not trip the UPDATE detector.
  expect(appended.floor).toBe(baseline.floor);
  expect(appended.receipt.sourceReconciliation.closed).toEqual(baseline.receipt.sourceReconciliation.closed);
  s.records.push({ type: 'response_item', timestamp: now, payload: { type: 'function_call',
    name: s.source.tool, call_id: s.source.callId, arguments: JSON.stringify(s.source.args) } });
  await writeFile(s.path, s.records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const [{ until }] = await f.db.adminSql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS until`;
  const current = { ...opts, since: baseline.receipt.sourceReconciliation.closed.from, until };
  // PostgreSQL preserves microseconds, whereas the validator's host clock has
  // millisecond precision. A same-tick microtask retry burst can otherwise
  // reject this window as future-dated without ever entering reconciliation.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(until) - 1);
  try { expect(await reconcileNativeCapture(current)).toBe('unknown'); }
  finally { clock.mockRestore(); }
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(Date.parse(until)), { interval: 1 });
  let verdict: 'complete' | 'gap' | 'unknown' = 'unknown';
  for (let attempt = 0; attempt < 20 && verdict === 'unknown'; attempt++) verdict = await reconcileNativeCapture(current);
  const finalPreparation = await receipt();
  expect(verdict, JSON.stringify({ current, baselineFloor: baseline.floor, floor: finalPreparation.floor,
    reconciliation: finalPreparation.receipt?.sourceReconciliation })).toBe('complete');
  const before = await receipt();
  expect(before.floor).toBe(baseline.floor);
  // No canonical body open on the next read: a source rewrite from an open
  // callback would reveal a hidden replay; current manifests still run.
  nativeBodyReads.target = s.path; nativeBodyReads.opens = 0;
  try { expect(await reconcileNativeCapture(current)).toBe('complete'); }
  finally { nativeBodyReads.target = ''; }
  expect(nativeBodyReads.opens).toBe(0);
  // Excluded receipt mutation elsewhere cannot be masked by a current marker.
  await f.db.adminSql`DELETE FROM harness_shared.tool_invocations
    WHERE metadata_json->'requestOrigin'->'nativeSession'->>'callIdFingerprint'=${sha(s.source.callId)}`;
  expect(await reconcileNativeCapture(current)).toBe('unknown');
  expect((await receipt()).receipt.sourceReconciliation.closed).toBeUndefined();
}, 120_000);

it.each(['excluded-delete', 'excluded-rewrite', 'invocation-delete', 'key-rotation', 'source-rewrite', 'population-insert'] as const)(
  'D032 atomic whole-population closure rejects %s during the final progress write', async mutation => {
    const s = await authorizedFixture();
    await f.db.adminSql.unsafe(await readFile(new URL(
      '../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url), 'utf8'));
    const opts = { ...s.opts, harnessSlug: 'requested-scope', since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
    await f.db.adminSql`UPDATE harness_shared.adv_sessions SET first_seen_at=${opts.since}::timestamptz
      WHERE id=${s.binding.id}::bigint`;
    const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt,
      native_capture_revision::text AS revision,native_capture_from::text AS floor
      FROM harness_shared.sql_intent_progress WHERE harness_slug=${opts.harnessSlug}`)[0]!;
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(await reconcileNativeCapture(opts)).toBe('unknown');
      if ((await receipt()).receipt.sourceReconciliation.closed) break;
    }
    const before = await receipt();
    expect(before.receipt.sourceReconciliation.closed).toMatchObject({ from: expect.any(String) });
    let mutated = false;
    const client = new Proxy(f.db.adminSql, { apply(target, thisArg, args) {
      const query = Array.isArray(args[0]) ? args[0].join('') : '';
      if (!mutated && query.includes('UPDATE harness_shared.sql_intent_progress SET') && query.includes('FULL JOIN')) {
        mutated = true;
        return (async () => {
          if (mutation === 'excluded-delete') await f.db.adminSql`DELETE FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
          if (mutation === 'excluded-rewrite') await f.db.adminSql`UPDATE harness_shared.agent_activity SET
            detail=jsonb_set(detail,'{nativeDispatch,callId}','"changed-call"'::jsonb) WHERE id=${s.input.id}::bigint`;
          if (mutation === 'invocation-delete') await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${s.id}::bigint`;
          if (mutation === 'key-rotation') await f.db.adminSql`UPDATE harness_shared.operator_secrets
            SET value_b64=${Buffer.alloc(32, 74).toString('base64')} WHERE name='spawn-signing-key'`;
          if (mutation === 'source-rewrite') await writeFile(s.path, JSON.stringify(s.records[0]) + '\n');
          if (mutation === 'population-insert') await f.db.adminSql`INSERT INTO harness_shared.adv_sessions
            (workspace_id,mode,coord_owner_id,agent,session_id,first_seen_at)
            VALUES (${workspaceId},'console','su-new-issued','codex',${randomUUID()},${opts.since}::timestamptz)`;
          return Reflect.apply(target, thisArg, args);
        })();
      }
      return Reflect.apply(target, thisArg, args);
    } });
    expect(await reconcileNativeCapture({ ...opts, client })).toBe('unknown');
    expect(mutated).toBe(true);
    const after = await receipt();
    expect(after.revision).toBe(before.revision);
    expect(after.floor).toBe(before.floor);
    // The old signed marker cannot bypass a new current renewal either.
    expect(await reconcileNativeCapture(opts)).toBe('unknown');
  }, 120_000);

it('D032 renews an earlier excluded root across more than one preparation wave', async () => {
  const first = await authorizedFixture();
  const [{ detail }] = await f.db.adminSql`SELECT detail FROM harness_shared.agent_activity WHERE id=${first.input.id}::bigint`;
  const original = detail.nativeDispatch;
  for (let index = 1; index < 33; index++) {
    const s = await fixture();
    expect(await appendAuthorizedNativeDispatch({ workspaceId, harnessSlug: harness, ownerId: owner,
      advSessionId: Number(s.binding.id), nativeSessionId: s.source.namespace!, callId: s.source.callId!,
      toolName: original.toolName, argsFingerprint: original.argsFingerprint, principal: original.principal },
    async () => true, f.db.adminSql)).toBe(true);
    await canonicalFixture(s);
  }
  await f.db.adminSql.unsafe(await readFile(new URL(
    '../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url), 'utf8'));
  const opts = { ...first.opts, harnessSlug: 'requested-scope', since: '2026-10-25T00:00:00Z', until: '2026-10-26T00:00:00Z' };
  await f.db.adminSql`UPDATE harness_shared.adv_sessions SET first_seen_at=${opts.since}::timestamptz`;
  const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt,
    native_capture_from::text AS floor,native_capture_revision::text AS revision
    FROM harness_shared.sql_intent_progress WHERE harness_slug=${opts.harnessSlug}`)[0]!;
  let partial = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    expect(await reconcileNativeCapture(opts)).toBe('unknown');
    const current = await receipt(), count = Object.keys(current.receipt.sourceReconciliation.roots).length;
    if (count > 0 && count < 33) partial = true;
    if (current.receipt.sourceReconciliation.closed) break;
  }
  const before = await receipt();
  expect(partial).toBe(true);
  expect(Object.keys(before.receipt.sourceReconciliation.roots)).toHaveLength(33);
  expect(before.receipt.sourceReconciliation.closed).toMatchObject({ from: expect.any(String) });
  let mutated = false;
  const client = new Proxy(f.db.adminSql, { apply(target, thisArg, args) {
    const query = Array.isArray(args[0]) ? args[0].join('') : '';
    if (!mutated && query.includes('UPDATE harness_shared.sql_intent_progress SET') && query.includes('FULL JOIN')) {
      mutated = true;
      return (async () => {
        await f.db.adminSql`DELETE FROM harness_shared.agent_activity WHERE id=${first.input.id}::bigint`;
        return Reflect.apply(target, thisArg, args);
      })();
    }
    return Reflect.apply(target, thisArg, args);
  } });
  expect(await reconcileNativeCapture({ ...opts, client })).toBe('unknown');
  expect(mutated).toBe(true);
  const after = await receipt();
  expect(after.revision).toBe(before.revision); expect(after.floor).toBe(before.floor);
}, 120_000);

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

it.each(['receipt', 'invocation', 'runtime', 'key'] as const)(
  'D030 the last per-call ACL callback cannot leave a stale %s proof', async mutation => {
    const s = await authorizedFixture(); let checks = 0;
    const proof = await readAuthorizedNativeDispatch({ ...s.input, source: s.source }, { ...s.opts, authorize: async () => {
      if (++checks !== 3) return true;
      if (mutation === 'receipt') await f.db.adminSql`DELETE FROM harness_shared.agent_activity WHERE id=${s.input.id}::bigint`;
      if (mutation === 'invocation') await f.db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE id=${s.id}::bigint`;
      if (mutation === 'runtime') await f.db.adminSql`UPDATE harness_shared.adv_sessions SET coord_owner_id='su-other'
        WHERE id=${s.binding.id}::bigint`;
      if (mutation === 'key') await f.db.adminSql`UPDATE harness_shared.operator_secrets
        SET value_b64=${Buffer.alloc(32, 74).toString('base64')} WHERE name='spawn-signing-key'`;
      return true;
    } });
    expect(checks).toBe(3);
    expect(proof).toBeNull();
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
