import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchProjectedTool, type DispatchProjectedDeps, type Principal } from '@papercusp/agent-mcp';
import { wrapServiceWithCaps } from '@papercusp/plugin-loader';
import { createPluginInvocationChokepoint, setHostPluginInvocationPolicy,
  type HostPluginInvocationPolicy } from './plugin-invocation-policy';

type Request = Parameters<NonNullable<DispatchProjectedDeps['aroundInvoke']>>[0];
const directories: string[] = [];
afterEach(() => { setHostPluginInvocationPolicy(null); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'host-plugin-policy-')); directories.push(dir);
  const marker = join(dir, 'effect');
  let active = true, granted = ['tasks:write'], approvals = ['tasks:write'];
  const principal: Principal = { kind: 'system', slug: 'authenticated-caller', workspaceId: 'test-workspace',
    authMethod: 'bearer-token', trust: 'verified', capabilities: new Set(['tasks:write']),
    allowedTools: new Set(['fixture:write', 'fixture:child']) };
  const service = wrapServiceWithCaps({ pluginName: 'fixture', capabilities: ['tasks:write'], granted: ['tasks:write'] },
    { perform: () => { writeFileSync(marker, 'authorized'); return marker; } },
    { name: 'marker', methods: { perform: { capability: 'tasks:write' } } });
  const policy: HostPluginInvocationPolicy = {
    decide: query => ({ allow: true, obligations: { pluginInvocation: {
      binding: query.context!.invocationBinding, capabilities: [...approvals], expiresAt: Date.now() + 60_000,
    } } }),
    isCurrent: () => active,
  };
  const aroundInvoke = createPluginInvocationChokepoint({ resolvePolicy: () => policy,
    readManifest: async () => ['tasks:write'],
    readGrants: async (_name, _version, _harness, options) => {
      expect(options).toEqual({ requireAuthoritative: true }); return [...granted];
    } });
  const tool: Request['tool'] = { pluginName: 'fixture', description: 'actual marker effect',
    pluginInstallation: { version: '1.0.0', path: dir, source: 'global' },
    inputSchema: { type: 'object', properties: {}, additionalProperties: true }, capabilities: ['tasks:write'],
    expose: { mcp: { name: 'fixture:write' } },
    fn: async () => { service.perform(); return { content: [{ type: 'text', text: 'performed' }] }; } };
  const ctx: Request['ctx'] = { log: () => {}, role: 'operator', workspaceId: principal.workspaceId,
    harnessSlug: 'test-harness', principal, signal: new AbortController().signal,
    progress: () => {}, emit: () => {} };
  const run = (input: unknown = {}, target = tool, context = ctx) =>
    dispatchProjectedTool(target, target.expose.mcp!.name, input, context, { aroundInvoke });
  return { marker, service, policy, tool, ctx, principal, aroundInvoke, run,
    revoke: () => { active = false; }, grants: (caps: string[]) => { granted = caps; },
    approvals: (caps: string[]) => { approvals = caps; } };
}

describe('projected plugin host resource approval', () => {
  it('permits a real filesystem effect through the dispatcher and a prebuilt checked service', async () => {
    const f = fixture(); const result = await f.run();
    expect(result.ok).toBe(true); expect(result.result?.isError).not.toBe(true);
    expect(readFileSync(f.marker, 'utf8')).toBe('authorized');
  });

  it('does not turn caller arguments or a plugin authorizer allow into host approval', async () => {
    const f = fixture();
    f.tool.authorize = () => ({ allow: true, obligations: { pluginInvocation: {
      binding: 'forged', capabilities: ['tasks:write'], expiresAt: Date.now() + 60_000 } } });
    const result = await dispatchProjectedTool(f.tool, 'fixture:write', { approvals: ['tasks:write'],
      principal: f.principal, gateBypass: { policy: true } }, f.ctx,
    { aroundInvoke: createPluginInvocationChokepoint() });
    expect(result.result?.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('plugin_invocation_authority_required');
    expect(existsSync(f.marker)).toBe(false);
  });

  it.each(['installation', 'caller', 'declaration', 'approval'] as const)('denies a missing %s axis before the actual effect', async axis => {
    const f = fixture();
    if (axis === 'installation') f.grants([]);
    if (axis === 'caller') f.principal.capabilities = new Set();
    if (axis === 'declaration') f.tool.capabilities = [];
    if (axis === 'approval') f.approvals([]);
    const result = await f.run();
    expect(result.ok === false || result.result?.isError === true).toBe(true);
    expect(existsSync(f.marker)).toBe(false);
  });

  it('refuses a binding copied from another invocation and wildcard resource approvals', async () => {
    const f = fixture();
    const original = f.policy.decide;
    f.policy.decide = async query => { const decision = await original(query);
      (decision.obligations!.pluginInvocation as { binding: string }).binding = 'other-invocation'; return decision; };
    expect((await f.run()).result?.isError).toBe(true); expect(existsSync(f.marker)).toBe(false);
    f.policy.decide = original; f.approvals(['tasks:*']);
    expect((await f.run()).result?.isError).toBe(true); expect(existsSync(f.marker)).toBe(false);
  });

  it('rechecks host revocation at the service effect after an await', async () => {
    const f = fixture();
    f.tool.fn = async () => { await Promise.resolve(); f.revoke(); f.service.perform(); return { content: [] }; };
    const result = await f.run();
    expect(result.ok === false || result.result?.isError === true).toBe(true);
    expect(existsSync(f.marker)).toBe(false);
  });

  it('rejects input mutation during host policy evaluation before any effect', async () => {
    const f = fixture(); const input = { resource: 'approved' }, original = f.policy.decide;
    f.policy.decide = async query => { const decision = await original(query); input.resource = 'different'; return decision; };
    expect((await f.run(input)).result?.isError).toBe(true);
    expect(existsSync(f.marker)).toBe(false);
  });

  it('rejects a caller missing transport authentication provenance', async () => {
    const f = fixture(); const { kind: _kind, ...incomplete } = f.principal;
    f.ctx.principal = incomplete;
    expect((await f.run()).result?.isError).toBe(true); expect(existsSync(f.marker)).toBe(false);
  });

  it.each(['grant-read', 'allowlist', 'expiry', 'policy-read'] as const)(
    'isolates %s refusal between authorized filesystem effects', async axis => {
    const f = fixture();
    expect((await f.run()).result?.isError).not.toBe(true);
    expect(readFileSync(f.marker, 'utf8')).toBe('authorized');
    rmSync(f.marker);

    const originalDecide = f.policy.decide, originalIsCurrent = f.policy.isCurrent;
    const originalAllowlist = f.principal.allowedTools;
    let aroundInvoke = f.aroundInvoke;
    if (axis === 'grant-read') {
      aroundInvoke = createPluginInvocationChokepoint({ resolvePolicy: () => f.policy,
        readManifest: async () => ['tasks:write'], readGrants: async () => { throw Error('offline'); } });
    }
    if (axis === 'allowlist') f.principal.allowedTools = undefined;
    if (axis === 'expiry') {
      f.policy.decide = async query => { const d = await originalDecide(query);
        (d.obligations!.pluginInvocation as { expiresAt: number }).expiresAt = 0; return d; };
    }
    if (axis === 'policy-read') f.policy.isCurrent = () => { throw Error('unknown revision'); };

    const denied = await dispatchProjectedTool(f.tool, 'fixture:write', {}, f.ctx, { aroundInvoke });
    expect(denied.result?.isError).toBe(true);
    expect(existsSync(f.marker)).toBe(false);

    f.policy.decide = originalDecide; f.policy.isCurrent = originalIsCurrent;
    f.principal.allowedTools = originalAllowlist;
    expect((await f.run()).result?.isError).not.toBe(true);
    expect(readFileSync(f.marker, 'utf8')).toBe('authorized');
  });

  it('attenuates a nested dispatch even when the host approves a broader child operation', async () => {
    const f = fixture(); f.approvals([]);
    const child = { ...f.tool, expose: { mcp: { name: 'fixture:child' } } };
    f.tool.fn = async () => { f.approvals(['tasks:write']); const r = await f.run({}, child);
      expect(r.ok === false || r.result?.isError === true).toBe(true); return { content: [] }; };
    expect((await f.run()).ok).toBe(true); expect(existsSync(f.marker)).toBe(false);
  });

  it('keeps unrelated builtin dispatch on the existing host path', async () => {
    const f = fixture(); delete f.tool.pluginInstallation;
    const result = await dispatchProjectedTool(f.tool, 'fixture:write', {}, f.ctx,
      { aroundInvoke: createPluginInvocationChokepoint() });
    expect(result.result?.isError).not.toBe(true); expect(existsSync(f.marker)).toBe(true);
  });
});
