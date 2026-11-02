import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchProjectedTool, type DispatchProjectedDeps, type AuthDecision, type AuthzQuery,
  type Principal } from '@papercusp/agent-mcp';
import { wrapServiceWithCaps } from '@papercusp/plugin-loader';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { canonicalizeHivePolicy, hivePolicySignedBytes, type HivePolicy,
  type HivePolicyPluginInvocationApproval } from './hive-policy-schema';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from './identity/ed25519';
import { createPluginInvocationChokepoint, pluginInvocationChokepoint, type HostPluginInvocationPolicy } from './plugin-invocation-policy';
import { pluginInvocationInputSha256, withPinnedPluginInvocationPolicy } from './plugin-invocation-policy-store';

type Request = Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0];
const host = vi.hoisted(() => ({ sql: undefined as unknown as import('postgres').Sql, loaded: [] as unknown[] }));
// Only route host infrastructure into this file's real isolated PG/installation.
// Production signature verification, SQL locks, PDP, dispatcher and effects run.
vi.mock('@papercusp/db-org', async original => ({ ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: host.sql }) }));
vi.mock('./plugin-host-runtime', () => ({ getPluginHost: async () => ({ loaded: host.loaded }) }));
const key = generateEd25519KeypairDer();
let db: FreshPgDb, directory: string, approval: HivePolicyPluginInvocationApproval;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; }

beforeAll(async () => {
  db = await createFreshPgDb('plugin-invocation-policy');
  await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.pots (workspace_id text, pot_home_slug text, public_key bytea,
      PRIMARY KEY(workspace_id,pot_home_slug));
    CREATE TABLE harness_shared.pot_policy (workspace_id text, harness_slug text, policy_json text,
      owner_pubkey text, signature text, policy_version integer, PRIMARY KEY(workspace_id,harness_slug));
    CREATE TABLE harness_shared.plugin_capability_grants (plugin_name text, plugin_version text, harness_slug text,
      capability text, PRIMARY KEY(plugin_name,plugin_version,harness_slug,capability));`);
}, 90_000);
afterAll(async () => { if (db) await db.cleanup(); });
afterEach(() => { vi.restoreAllMocks(); if (directory) rmSync(directory, { recursive: true, force: true }); });

async function writePolicy(policy: HivePolicy, signer = key) {
  const policyJson = canonicalizeHivePolicy(policy);
  const signature = signWithPrivateKeyDer(signer.privateKeyDer, hivePolicySignedBytes({
    workspaceId: 'fixture-workspace', potHomeSlug: 'fixture-harness', policyVersion: 1,
    canonicalPolicyJson: policyJson,
  })).toString('base64');
  await db.sql`INSERT INTO harness_shared.pot_policy VALUES
    ('fixture-workspace', 'fixture-harness', ${policyJson}, ${signer.pubkeyBase64}, ${signature}, 1)
    ON CONFLICT (workspace_id,harness_slug) DO UPDATE SET policy_json = EXCLUDED.policy_json,
      owner_pubkey = EXCLUDED.owner_pubkey, signature = EXCLUDED.signature`;
}

beforeEach(async () => {
  host.sql = db.sql;
  await db.sql.unsafe('TRUNCATE harness_shared.pot_policy, harness_shared.pots, harness_shared.plugin_capability_grants');
  directory = mkdtempSync(join(tmpdir(), 'pinned-plugin-policy-'));
  approval = { pluginName: 'fixture', pluginVersion: '1.0.0', installationPath: directory,
    installationSource: 'global', principalSlug: 'fixture-caller', principalKind: 'system', authMethod: 'bearer-token',
    toolName: 'fixture:write', inputSha256: pluginInvocationInputSha256({ resource: 'approved' }),
    capabilities: ['tasks:write'], expiresAt: Date.now() + 60_000 };
  host.loaded = [{ plugin: { name: 'fixture', version: '1.0.0', capabilities: ['tasks:write'] },
    path: directory, source: 'global' }];
  await db.sql`INSERT INTO harness_shared.pots VALUES ('fixture-workspace', 'fixture-harness', ${Buffer.from(key.pubkeyBase64, 'base64')})`;
  await db.sql`INSERT INTO harness_shared.plugin_capability_grants VALUES ('fixture', '1.0.0', 'fixture-harness', 'tasks:write')`;
  await writePolicy({ pluginInvocations: { approvals: [approval] } });
});

function fixture() {
  const marker = join(directory, 'effect'), controller = new AbortController();
  const principal: Principal = { kind: 'system', slug: 'fixture-caller', workspaceId: 'fixture-workspace',
    authMethod: 'bearer-token', trust: 'verified', capabilities: new Set(['tasks:write']), allowedTools: new Set(['fixture:write']) };
  const service = wrapServiceWithCaps({ pluginName: 'fixture', capabilities: ['tasks:write'], granted: ['tasks:write'] },
    { perform: () => writeFileSync(marker, 'authorized') }, { name: 'marker', methods: { perform: { capability: 'tasks:write' } } });
  const tool: Request['tool'] = { pluginName: 'fixture', description: 'actual marker effect',
    pluginInstallation: { version: '1.0.0', path: directory, source: 'global' },
    inputSchema: { type: 'object', properties: {}, additionalProperties: true }, capabilities: ['tasks:write'],
    expose: { mcp: { name: 'fixture:write' } }, fn: async () => { service.perform(); return { content: [] }; } };
  const ctx: Request['ctx'] = { log: () => {}, role: 'operator', workspaceId: principal.workspaceId,
    harnessSlug: 'fixture-harness', principal, signal: controller.signal, progress: () => {}, emit: () => {} };
  let retained: { policy: HostPluginInvocationPolicy; query: AuthzQuery; decision: AuthDecision } | undefined;
  const aroundInvoke: NonNullable<DispatchProjectedDeps['aroundInvoke']> = request =>
    withPinnedPluginInvocationPolicy(request, async (policy, grants) => {
      const decide = policy.decide;
      policy.decide = async query => { const decision = await decide(query); retained = { policy, query, decision }; return decision; };
      return createPluginInvocationChokepoint({ resolvePolicy: () => policy,
        readManifest: async () => ['tasks:write'], readGrants: async () => grants })(request);
    }, { sql: db.sql });
  return { marker, principal, tool, ctx, controller, service,
    runProduction: () => dispatchProjectedTool(tool, 'fixture:write', { resource: 'approved' }, ctx,
      { aroundInvoke: pluginInvocationChokepoint }),
    retained: () => retained!, run: (input: unknown = { resource: 'approved' }) =>
      dispatchProjectedTool(tool, 'fixture:write', input, ctx, { aroundInvoke }) };
}

describe('production signed plugin invocation policy', () => {
  it('binds the exported production entry point without installing a test PDP', async () => {
    const f = fixture(); const allowed = await f.runProduction();
    expect(allowed.ok).toBe(true); expect(allowed.result?.isError).not.toBe(true);
    expect(readFileSync(f.marker, 'utf8')).toBe('authorized');
    await db.sql.unsafe('DELETE FROM harness_shared.plugin_capability_grants'); rmSync(f.marker);
    const denied = await f.runProduction();
    expect(denied.ok === false || denied.result?.isError === true).toBe(true);
    expect(existsSync(f.marker)).toBe(false);
  });

  it.each(['declaration', 'caller', 'approval', 'allowlist', 'identity'] as const)
  ('attenuates a separately signed production child by its parent %s across awaits', async axis => {
    const f = fixture(), caps = ['tasks:write', 'tasks:read'] as const;
    const childName = 'fixture:child', childMarker = join(directory, 'child-effect');
    host.loaded = [{ plugin: { name: 'fixture', version: '1.0.0', capabilities: [...caps] },
      path: directory, source: 'global' }];
    await db.sql`INSERT INTO harness_shared.plugin_capability_grants VALUES
      ('fixture', '1.0.0', 'fixture-harness', 'tasks:read')`;
    f.tool.capabilities = [...caps];
    f.principal.capabilities = new Set(caps);
    f.principal.allowedTools = new Set([...f.principal.allowedTools!, childName]);
    const childPrincipal: Principal = { ...f.principal, capabilities: new Set(caps),
      allowedTools: new Set(f.principal.allowedTools) };
    const service = wrapServiceWithCaps({ pluginName: 'fixture', capabilities: caps, granted: caps },
      { perform: () => writeFileSync(childMarker, 'authorized child') },
      { name: 'child-marker', methods: { perform: { capability: 'tasks:read' } } });
    const child: Request['tool'] = { ...f.tool, capabilities: [...caps], expose: { mcp: { name: childName } },
      fn: async () => { await Promise.resolve(); service.perform(); return { content: [] }; } };
    const childCtx: Request['ctx'] = { ...f.ctx, principal: childPrincipal };
    const childApproval = { ...approval, toolName: childName, capabilities: [...caps] };
    const parentApproval = { ...approval, capabilities: [...caps] };
    await writePolicy({ pluginInvocations: { approvals: [parentApproval, childApproval] } });
    const runChild = () => dispatchProjectedTool(child, childName, { resource: 'approved' }, childCtx,
      { aroundInvoke: pluginInvocationChokepoint });
    f.tool.fn = async () => {
      await Promise.resolve();
      const result = await runChild();
      return result.result ?? { isError: true, content: [] };
    };

    const positive = await f.runProduction();
    expect(positive.ok).toBe(true); expect(positive.result?.isError).not.toBe(true);
    expect(readFileSync(childMarker, 'utf8')).toBe('authorized child'); rmSync(childMarker);

    if (axis === 'declaration') f.tool.capabilities = ['tasks:write'];
    if (axis === 'caller') f.principal.capabilities = new Set(['tasks:write']);
    if (axis === 'approval') parentApproval.capabilities = ['tasks:write'];
    if (axis === 'allowlist') f.principal.allowedTools = new Set(['fixture:write']);
    if (axis === 'identity') {
      childPrincipal.slug = 'separately-approved-caller';
      childApproval.principalSlug = childPrincipal.slug;
    }
    await writePolicy({ pluginInvocations: { approvals: [parentApproval, childApproval] } });

    // Its own signed approval still permits the child outside the parent.
    // A nested denial must therefore come from attenuation, not a broken PDP.
    const standalone = await runChild();
    expect(standalone.ok).toBe(true); expect(standalone.result?.isError).not.toBe(true);
    expect(readFileSync(childMarker, 'utf8')).toBe('authorized child'); rmSync(childMarker);
    const denied = await f.runProduction();
    expect(denied.ok === false || denied.result?.isError === true).toBe(true);
    expect(existsSync(childMarker)).toBe(false);
  });

  it('expires a pinned decision before a later checked effect', async () => {
    const f = fixture();
    f.tool.fn = async () => {
      await Promise.resolve();
      vi.spyOn(Date, 'now').mockReturnValue(approval.expiresAt + 1);
      const r = f.retained(); expect(r.policy.isCurrent(r.query, r.decision)).toBe(false);
      expect(() => f.service.perform()).toThrow();
      return { content: [] };
    };
    expect((await f.run()).ok).toBe(true); expect(existsSync(f.marker)).toBe(false);
  });
  it('permits an exact signed operation through the real dispatcher, PG and checked filesystem effect', async () => {
    const f = fixture(); expect((await f.run()).ok).toBe(true);
    expect(readFileSync(f.marker, 'utf8')).toBe('authorized');
    const r = f.retained(); expect(r.policy.isCurrent(r.query, r.decision)).toBe(false);
  });

  it.each(['caller', 'input', 'path', 'version', 'workspace', 'grant', 'expiry', 'unsigned', 'wrong-signer'] as const)
  ('refuses %s mismatch before the actual effect', async axis => {
    const f = fixture(); let input = { resource: 'approved' };
    if (axis === 'caller') f.principal.slug = 'other';
    if (axis === 'input') input = { resource: 'other' };
    if (axis === 'path') f.tool.pluginInstallation = { ...f.tool.pluginInstallation!, path: directory + '-other' };
    if (axis === 'version') f.tool.pluginInstallation = { ...f.tool.pluginInstallation!, version: '2.0.0' };
    if (axis === 'workspace') { f.principal.workspaceId = 'other'; f.ctx.workspaceId = 'other'; }
    if (axis === 'grant') await db.sql.unsafe('DELETE FROM harness_shared.plugin_capability_grants');
    if (axis === 'expiry') await writePolicy({ pluginInvocations: { approvals: [{ ...approval, expiresAt: 1 }] } });
    if (axis === 'unsigned') await db.sql`UPDATE harness_shared.pot_policy SET signature = 'invalid'`;
    if (axis === 'wrong-signer') await writePolicy({ pluginInvocations: { approvals: [approval] } }, generateEd25519KeypairDer());
    const result = await f.run(input);
    expect(result.ok === false || result.result?.isError === true).toBe(true);
    expect(existsSync(f.marker)).toBe(false);
  });

  it.each(['policy', 'grant', 'identity'] as const)('pins the %s revision until the active call finishes', async axis => {
    const f = fixture(), started = deferred(), resume = deferred();
    f.tool.fn = async () => { started.resolve(); await resume.promise; f.service.perform(); return { content: [] }; };
    const run = f.run(); await started.promise;
    const statement = axis === 'policy' ? 'DELETE FROM harness_shared.pot_policy'
      : axis === 'grant' ? 'DELETE FROM harness_shared.plugin_capability_grants' : 'DELETE FROM harness_shared.pots';
    try {
      await expect(db.sql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '50ms'"); await tx.unsafe(statement);
      })).rejects.toMatchObject({ code: '55P03' });
    } finally { resume.resolve(); }
    expect((await run).ok).toBe(true);
    await db.sql.unsafe(statement); rmSync(f.marker);
    const result = await f.run(); expect(result.ok === false || result.result?.isError === true).toBe(true);
    expect(existsSync(f.marker)).toBe(false);
  });

  it.each(['abort', 'disconnect'] as const)('invalidates detached continuations on %s before their checked effect', async axis => {
    const f = fixture(), started = deferred(), resume = deferred(), finished = deferred();
    let blocked = false;
    f.tool.fn = async () => {
      started.resolve(); await resume.promise;
      try { f.service.perform(); } catch { blocked = true; }
      finally { finished.resolve(); }
      return { content: [] };
    };
    const run = f.run(); await started.promise;
    if (axis === 'abort') f.controller.abort();
    else {
      const backends = await db.sql<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`;
      expect(backends).toHaveLength(1);
      await db.sql`SELECT pg_terminate_backend(${backends[0].pid})`;
    }
    expect((await run).ok).toBe(false);
    const r = f.retained(); expect(r.policy.isCurrent(r.query, r.decision)).toBe(false);
    resume.resolve(); await finished.promise;
    expect(blocked).toBe(true); expect(existsSync(f.marker)).toBe(false);
  });
});
