/**
 * papercusp-enterprise-readiness-roadmap-2026-10-09 P-005 — ENT-P-005-OUTCOME:
 * "A workspace action forbidden by its inherited organization policy is rejected through every
 * selected execution path."
 *
 * These tests go THROUGH the real seat (`operatorKernelEnforcement` / `wrapOperatorKernelSpawn`
 * / `dispatchProjectedTool` with PROJECTED_DEPS-style kernel enforcement) with only the chain
 * loader replaced, so a regression that unhooks `enforceInheritedPolicy` from the seat fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Same partial mocks as projected-tool-deps.test.ts: keep the heavy dispatch graph real, but
// stop a kernel denial's fire-and-forget ledger insert and presence beat from reaching PG.
vi.mock('../decision-ledger/emit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../decision-ledger/emit')>()),
  recordDecisionLedger: vi.fn(),
}));
vi.mock('../agent-tools/coordination/dispatch-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/dispatch-heartbeat')>()),
  maybeBeatPresenceOnDispatch: vi.fn(),
}));

import { dispatchProjectedTool, type ProjectedTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { operatorKernelEnforcement, wrapOperatorKernelSpawn } from '../projected-tool-deps';
import {
  enforceInheritedPolicy,
  governedRequestOf,
  invalidateGovernancePolicyCache,
  isGovernanceAdminTool,
  isGovernancePolicyEnforcementInstalled,
  setGovernancePolicyChainLoader,
} from './enforce';
import type { ChainLoad, StoredPolicyLayer } from './store';

const WS = 'ws-governed';

function ctx(over: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return { workspaceId: WS, ...over } as UnifiedToolContext;
}

function layer(over: Partial<StoredPolicyLayer> & Pick<StoredPolicyLayer, 'layerId' | 'level'>): StoredPolicyLayer {
  return {
    version: 1, rules: {}, exceptions: [], scopeRef: over.layerId, parentLayerId: null,
    contentHash: 'h', updatedBy: 'test', updatedAt: '2026-10-14T00:00:00.000Z', ...over,
  };
}

/** Org forbids capability:bash and the shell boundary's `rm`; workspace layer is wide open. */
const ORG = layer({
  layerId: 'org-acme',
  level: 'organization',
  rules: { tools: { deny: ['capability:bash'] }, actions: { deny: ['exec:rm'] }, egress: { allow: ['*.acme.example'] } },
});
const WS_LAYER = layer({ layerId: 'ws-governed', level: 'workspace', version: 3, rules: { tools: { allow: ['*'] } } });
const CHAIN: ChainLoad = { status: 'ok', chain: [ORG, WS_LAYER] } as ChainLoad;

function install(load: ChainLoad | (() => Promise<ChainLoad>)) {
  const loader = vi.fn(typeof load === 'function' ? load : async () => load);
  setGovernancePolicyChainLoader(loader);
  return loader;
}

function fixtureTool(fn: ProjectedTool['fn'], name: string): ProjectedTool {
  return { pluginName: 'fixture', description: 'fixture', inputSchema: { type: 'object' }, capabilities: [], expose: { mcp: { name } }, fn };
}

afterEach(() => {
  setGovernancePolicyChainLoader(null);
  vi.clearAllMocks();
});

describe('governedRequestOf — subject mapping', () => {
  it('maps tool, tools:invoke inner name, plugin prefix, models, egress host, data use and actions', () => {
    expect(
      governedRequestOf({
        toolName: 'tools:invoke',
        capabilities: ['secrets:read', 'net:fetch'],
        boundary: 'indirect-dispatch',
        args: { name: 'repomix.pack', args: { model: 'claude-x', url: 'https://API.Example.com/v1', dataClass: 'pii' } },
      }),
    ).toEqual({
      tools: ['tools:invoke', 'repomix.pack'],
      plugins: ['repomix'],
      models: ['claude-x'],
      // A bare model id and an ordinary web host name no processing route (P-016a).
      providers: [],
      regions: [],
      egress: ['api.example.com'],
      // A dataClass naming a customer data class is also judged as its class: label (P-016a DLP).
      dataUse: ['pii', 'class:pii', 'secrets'],
      actions: ['secrets:read', 'net:fetch', 'boundary:indirect-dispatch'],
    });
  });

  it('takes the executable from args.bin, else the first token of the whole command line', () => {
    expect(governedRequestOf({ toolName: 'native:shell', capabilities: [], boundary: 'shell', operation: '/bin/rm -rf /tmp/x', args: { bin: '/bin/rm' } }).actions)
      .toContain('exec:rm');
    expect(governedRequestOf({ toolName: 'native:shell', capabilities: [], boundary: 'native', operation: '/usr/bin/curl -s x', args: {} }).actions)
      .toContain('exec:curl');
  });

  it('judges an unparseable URL verbatim so it cannot slip past an egress allow list', () => {
    expect(governedRequestOf({ toolName: 'web:fetch', capabilities: [], boundary: 'dispatch', args: { url: 'not a url' } }).egress).toEqual(['not a url']);
  });
});

describe('enforceInheritedPolicy — the seat is inert until a host installs it', () => {
  it('returns null with no loader installed (unit tests never touch Postgres)', async () => {
    expect(isGovernancePolicyEnforcementInstalled()).toBe(false);
    await expect(
      enforceInheritedPolicy({ phase: 'preflight', boundary: 'dispatch', toolName: 'capability:bash', capabilities: [], args: {}, ctx: ctx() }),
    ).resolves.toBeNull();
  });

  it('returns null for a workspace with no governing chain', async () => {
    install({ status: 'none' } as ChainLoad);
    await expect(
      operatorKernelEnforcement({ phase: 'preflight', boundary: 'dispatch', toolName: 'capability:bash', capabilities: [], args: {}, ctx: ctx() }),
    ).resolves.not.toMatchObject({ decision: 'deny' });
  });
});

describe('operatorKernelEnforcement — an organization refusal holds on every boundary', () => {
  it.each(['dispatch', 'indirect-dispatch', 'reaction'] as const)('denies org-forbidden capability:bash on %s', async (boundary) => {
    install(CHAIN);
    const verdict = await operatorKernelEnforcement({ phase: 'preflight', boundary, toolName: 'capability:bash', capabilities: [], args: {}, ctx: ctx() });
    expect(verdict).toMatchObject({ decision: 'deny', code: 'org_policy:denied', policyRevision: 'org-acme@v1>ws-governed@v3' });
    expect(verdict?.reason).toContain('organization policy org-acme v1 denies tools');
  });

  it('denies the same tool reached through the tools:invoke wrapper (the outer dispatch)', async () => {
    install(CHAIN);
    const verdict = await operatorKernelEnforcement({
      phase: 'preflight', boundary: 'dispatch', toolName: 'tools:invoke', capabilities: [], args: { name: 'capability:bash', args: {} }, ctx: ctx(),
    });
    expect(verdict).toMatchObject({ decision: 'deny', code: 'org_policy:denied' });
  });

  it('a wide-open workspace layer cannot widen the organization egress allow list', async () => {
    install(CHAIN);
    const verdict = await operatorKernelEnforcement({
      phase: 'preflight', boundary: 'dispatch', toolName: 'web:fetch', capabilities: [], args: { url: 'https://evil.example.org/x' }, ctx: ctx(),
    });
    expect(verdict).toMatchObject({ decision: 'deny', code: 'org_policy:denied' });
    expect(verdict?.reason).toContain("does not allow egress 'evil.example.org'");
  });

  it('allows what every layer permits (falls through to the normal kernel decision)', async () => {
    install(CHAIN);
    const verdict = await operatorKernelEnforcement({
      phase: 'preflight', boundary: 'dispatch', toolName: 'web:fetch', capabilities: [], args: { url: 'https://docs.acme.example/a' }, ctx: ctx(),
    });
    expect(verdict?.decision).not.toBe('deny');
  });

  it('refuses a wrapped native/shell spawn before the executor runs', async () => {
    install(CHAIN);
    const spawn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', killed: false }));
    const wrapped = wrapOperatorKernelSpawn(spawn, ctx({ isSuperuser: true, uiClientId: 'su-a' }), ['compute:exec:rm']);
    await expect(wrapped('/bin/rm', ['-rf', '/tmp/x'])).rejects.toMatchObject({ name: 'KernelEnforcementDeniedError' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['dispatch', 'indirect-dispatch', 'reaction'] as const)('the handler never runs on a %s dispatch', async (kernelBoundary) => {
    install(CHAIN);
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    const result = await dispatchProjectedTool(fixtureTool(handler, 'capability:bash'), 'capability:bash', {}, ctx({ kernelBoundary }), {
      kernelEnforcement: operatorKernelEnforcement,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('org_policy:denied');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('fail closed once installed', () => {
  it('a malformed chain refuses', async () => {
    install({ status: 'malformed', reason: 'cycle at org-acme', chain: [] });
    await expect(
      operatorKernelEnforcement({ phase: 'preflight', boundary: 'dispatch', toolName: 'coord:send', capabilities: [], args: {}, ctx: ctx() }),
    ).resolves.toMatchObject({ decision: 'deny', code: 'org_policy:malformed' });
  });

  it('a workspace never read successfully is refused when the read fails', async () => {
    install(async () => { throw new Error('pg down'); });
    const verdict = await operatorKernelEnforcement({ phase: 'preflight', boundary: 'dispatch', toolName: 'coord:send', capabilities: [], args: {}, ctx: ctx() });
    expect(verdict).toMatchObject({ decision: 'deny', code: 'org_policy:unavailable' });
    expect(verdict?.reason).toContain('pg down');
  });

  it('a transient read failure after a good read keeps enforcing the last-known chain', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
      let fail = false;
      const loader = install(async () => {
        if (fail) throw new Error('blip');
        return CHAIN;
      });
      const req = { phase: 'preflight', boundary: 'dispatch', toolName: 'capability:bash', capabilities: [], args: {}, ctx: ctx() } as const;
      await expect(operatorKernelEnforcement(req)).resolves.toMatchObject({ code: 'org_policy:denied' });
      fail = true;
      vi.setSystemTime(new Date('2026-10-14T00:00:30Z')); // past the 5s TTL → a real re-read that fails
      await expect(operatorKernelEnforcement(req)).resolves.toMatchObject({ code: 'org_policy:denied' });
      expect(loader).toHaveBeenCalledTimes(2);
      // With the last-known entry dropped, the same failure refuses rather than allows.
      invalidateGovernancePolicyCache();
      await expect(operatorKernelEnforcement(req)).resolves.toMatchObject({ code: 'org_policy:unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches per workspace and re-reads after invalidation', async () => {
    const loader = install(CHAIN);
    const req = { phase: 'preflight', boundary: 'dispatch', toolName: 'coord:send', capabilities: [], args: {}, ctx: ctx() } as const;
    await operatorKernelEnforcement(req);
    await operatorKernelEnforcement(req);
    expect(loader).toHaveBeenCalledTimes(1);
    invalidateGovernancePolicyCache(WS);
    await operatorKernelEnforcement(req);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('anti-lockout', () => {
  it('never refuses the governance administration tool, even under a deny-all chain', async () => {
    install({ status: 'ok', chain: [layer({ layerId: 'org-acme', level: 'organization', rules: { tools: { allow: [] } } })] } as ChainLoad);
    const admin = await operatorKernelEnforcement({ phase: 'preflight', boundary: 'dispatch', toolName: 'governance:policy', capabilities: [], args: {}, ctx: ctx() });
    expect(admin?.decision).not.toBe('deny');
    const other = await operatorKernelEnforcement({ phase: 'preflight', boundary: 'dispatch', toolName: 'coord:send', capabilities: [], args: {}, ctx: ctx() });
    expect(other).toMatchObject({ decision: 'deny', code: 'org_policy:denied' });
  });

  it('never refuses the admin pane HTTP doors under a deny-all chain, whatever prefix the projection adds', async () => {
    install({ status: 'ok', chain: [layer({ layerId: 'org-acme', level: 'organization', rules: { tools: { allow: [] } } })] } as ChainLoad);
    for (const toolName of [
      '/governance-policy/set',
      '/governance-policy/add-exception',
      '/api/governance-policy/simulate',
      'POST /governance-policy/explain',
    ]) {
      const door = await operatorKernelEnforcement({ phase: 'enforce', boundary: 'dispatch', toolName, capabilities: [], args: {}, ctx: ctx() });
      expect(door?.decision, toolName).not.toBe('deny');
    }
  });

  it('does not widen the exemption to look-alike routes', async () => {
    install({ status: 'ok', chain: [layer({ layerId: 'org-acme', level: 'organization', rules: { tools: { allow: [] } } })] } as ChainLoad);
    for (const toolName of ['/governance-policy-evil/set', '/governance-policy/settings', '/xgovernance-policy/set', 'governance:policy-shadow']) {
      expect(isGovernanceAdminTool(toolName), toolName).toBe(false);
      const out = await operatorKernelEnforcement({ phase: 'enforce', boundary: 'dispatch', toolName, capabilities: [], args: {}, ctx: ctx() });
      expect(out, toolName).toMatchObject({ decision: 'deny', code: 'org_policy:denied' });
    }
  });
});
