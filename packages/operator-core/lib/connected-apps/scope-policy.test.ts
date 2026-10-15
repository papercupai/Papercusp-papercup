import { describe, expect, it, vi } from 'vitest';
import {
  evaluateAppScope,
  evaluateAppScopeChain,
  grantedToolCapabilities,
  hardDenyReason,
  scopeEntryMatches,
  validateAppKeyScopes,
  type AppScopeRow,
  type AppScopeTool,
} from './scope-policy';

// Mutation-probe seam (copy-out tier): `scripts/mutation-probe.sh --test
// 'PAPERCUSP_SCOPE_POLICY_PROBE={} …'` points these tests at a mutated COPY of the policy, so
// proving them falsifiable never mutates the shared tree. Unset (every normal run): the real
// module. vi.mock is hoisted above the static import.
vi.mock('./scope-policy', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_SCOPE_POLICY_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

const WS = 'ws-app';

function row(over: Partial<AppScopeRow> = {}): AppScopeRow {
  return {
    id: 'abcdefgh12345678',
    workspace_id: WS,
    scopes: { capabilities: ['harness:read'], tools: ['harness:list', 'plans:*'] },
    revoked_at: null,
    paused_at: null,
    expires_at: null,
    ...over,
  };
}

const harnessList: AppScopeTool = { name: 'harness:list', capabilities: ['harness:read'] };
const plansGet: AppScopeTool = { name: 'plans:get', capabilities: ['plans:read'], acceptsHarness: true };

describe('evaluateAppScopeChain — restrictive parent/token explanation', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const input = { tool: plansGet, args: {}, workspaceId: WS, now };
  const parent = row({ id: 'parent', scopes: { tools: ['plans:get'] } });
  const child = row({ id: 'child', scopes: { tools: ['plans:*'] } });

  it('permits the shared grant and reports both governing rows without raw grants', () => {
    expect(evaluateAppScopeChain(input, [parent, child])).toEqual({
      verdict: { allow: true }, listable: true, blockingScopeId: null, blockingScopeIndex: null,
      decisions: [
        { scopeId: 'parent', scopeIndex: 0, verdict: { allow: true } },
        { scopeId: 'child', scopeIndex: 1, verdict: { allow: true } },
      ],
    });
  });

  it('a broader child cannot override an ancestor denial', () => {
    const result = evaluateAppScopeChain({ ...input, tool: { ...plansGet, name: 'plans:list' } }, [parent, child]);
    expect(result).toMatchObject({ verdict: { allow: false, code: 'tool_not_in_scope' }, listable: false, blockingScopeId: 'parent' });
    expect(result.decisions).toMatchObject([
      { scopeId: 'parent', verdict: { allow: false } },
      { scopeId: 'child', verdict: { allow: true } },
    ]);
  });

  it('a restricted child cannot be widened by an allowed parent', () => {
    expect(evaluateAppScopeChain(input, [child, { ...parent, id: 'restricted', scopes: { tools: ['plans:list'] } }]))
      .toMatchObject({ verdict: { allow: false, code: 'tool_not_in_scope' }, listable: false, blockingScopeId: 'restricted' });
  });

  it('an empty chain refuses invocation and listing', () => {
    expect(evaluateAppScopeChain(input, [])).toEqual({
      verdict: { allow: false, code: 'key_unknown', reason: 'no app scope rows were supplied' },
      listable: false, blockingScopeId: null, blockingScopeIndex: null, decisions: [],
    });
  });

  it('attributes a narrowed token when its loaded row retains the parent app id', () => {
    const sharedIdToken = { ...parent, scopes: { tools: ['plans:list'] } };
    const result = evaluateAppScopeChain(input, [parent, sharedIdToken]);
    expect(result).toMatchObject({
      verdict: { allow: false, code: 'tool_not_in_scope' },
      blockingScopeId: 'parent', blockingScopeIndex: 1,
      decisions: [
        { scopeId: 'parent', scopeIndex: 0, verdict: { allow: true } },
        { scopeId: 'parent', scopeIndex: 1, verdict: { allow: false } },
      ],
    });
  });

  it('uses one decision instant for the exact expiry boundary and retains all denials', () => {
    const result = evaluateAppScopeChain(input, [
      { ...parent, expires_at: now }, { ...child, expires_at: now },
    ]);
    expect(result.blockingScopeId).toBe('parent');
    expect(result.decisions).toMatchObject([
      { scopeId: 'parent', verdict: { allow: false, code: 'key_expired' } },
      { scopeId: 'child', verdict: { allow: false, code: 'key_expired' } },
    ]);
  });

  it('lists a harness-deferred chain while invocation still requires a harness', () => {
    const limited = { ...parent, scopes: { tools: ['plans:*'], harnesses: ['approved'] } };
    expect(evaluateAppScopeChain(input, [limited, child])).toMatchObject({
      verdict: { allow: false, code: 'harness_required_by_scope' }, listable: true, blockingScopeId: 'parent',
    });
    expect(evaluateAppScopeChain({ ...input, args: { harness: 'approved' } }, [limited, child]).verdict).toEqual({ allow: true });
  });

  it.each([
    { revoked_at: now }, { expires_at: now }, { paused_at: now },
    { scopes: { tools: ['harness:list'] } },
  ])('a listing deferral never hides a later token refusal: %j', (restriction) => {
    const limited = { ...parent, scopes: { tools: ['plans:*'], harnesses: ['approved'] } };
    const result = evaluateAppScopeChain(input, [limited, { ...child, ...restriction }]);
    expect(result.listable).toBe(false);
    expect(result.decisions[1].verdict.allow).toBe(false);
  });

  it('a grant chain never overrides the platform hard deny', () => {
    expect(evaluateAppScopeChain({ ...input, tool: { name: 'dev:restart', capabilities: [] } }, [parent, child]))
      .toMatchObject({ verdict: { allow: false, code: 'hard_denied' }, listable: false });
  });
});

function decide(tool: AppScopeTool, args: unknown = {}, r: AppScopeRow = row(), extra: { workspaceId?: string | null; harnessSlug?: string } = {}) {
  return evaluateAppScope({ tool, args, workspaceId: 'workspaceId' in extra ? extra.workspaceId : WS, harnessSlug: extra.harnessSlug }, r);
}

describe('evaluateAppScope — tool allowlist (R-5)', () => {
  it('allows a tool named exactly in the allowlist', () => {
    expect(decide(harnessList)).toEqual({ allow: true });
  });

  it('allows a tool covered by a group:* entry', () => {
    expect(decide(plansGet)).toEqual({ allow: true });
  });

  it('refuses a tool outside the allowlist even when the key holds its capability', () => {
    const v = decide({ name: 'harness:get', capabilities: ['harness:read'] });
    expect(v).toMatchObject({ allow: false, code: 'tool_not_in_scope' });
  });

  it('is default-deny: a key with no tools list reaches nothing', () => {
    const v = decide(harnessList, {}, row({ scopes: { capabilities: ['harness:read'] } }));
    expect(v).toMatchObject({ allow: false, code: 'tool_not_in_scope' });
  });

  it('never treats a bare wildcard entry as matching', () => {
    expect(scopeEntryMatches('*', 'harness:list')).toBe(false);
    expect(decide(harnessList, {}, row({ scopes: { tools: ['*'] } }))).toMatchObject({ allow: false, code: 'tool_not_in_scope' });
  });

  it('does not let group:* match a different group that shares a prefix', () => {
    expect(scopeEntryMatches('plan:*', 'plans:get')).toBe(false);
    expect(scopeEntryMatches('plans:*', 'plans:get')).toBe(true);
  });
});

describe('evaluateAppScope — hard-deny set (R-6)', () => {
  const hardDenied: AppScopeTool[] = [
    { name: 'capability:bash', capabilities: ['capability:bash'] },
    { name: 'dev:restart', capabilities: ['operator:write'] },
    { name: 'setup:save_key', capabilities: ['operator:write'] },
    { name: 'code:run', capabilities: ['agent_tools:read'] },
    { name: 'tools:invoke', capabilities: ['agent_tools:read'] },
    { name: 'fleet:launch-on-plan', capabilities: ['coord:write'] },
    { name: 'connected_apps:create', capabilities: ['operator:write'] },
    { name: 'harness:exec', capabilities: ['capability:fs-write'] },
    { name: 'accounts:read_secret', capabilities: ['secrets:operator-credentials:read'] },
  ];

  it.each(hardDenied)('refuses $name even when the allowlist names it', (tool) => {
    const r = row({ scopes: { capabilities: [...tool.capabilities], tools: [tool.name, `${tool.name.split(':')[0]}:*`] } });
    expect(decide(tool, {}, r)).toMatchObject({ allow: false, code: 'hard_denied' });
  });

  it('refuses a cross-workspace tool the allowlist names', () => {
    const tool: AppScopeTool = { name: 'search:semantic', capabilities: ['search:read'], crossWorkspace: true };
    expect(decide(tool, {}, row({ scopes: { tools: ['search:semantic'] } }))).toMatchObject({ allow: false, code: 'cross_workspace' });
  });

  it('does not hard-deny an ordinary workspace tool', () => {
    expect(hardDenyReason(harnessList)).toBeNull();
    expect(hardDenyReason(plansGet)).toBeNull();
  });
});

describe('evaluateAppScope — workspace and harness binding', () => {
  it('refuses a call dispatched under another workspace', () => {
    expect(decide(harnessList, {}, row(), { workspaceId: 'ws-other' })).toMatchObject({ allow: false, code: 'workspace_mismatch' });
  });

  it('refuses when no workspace is known (fail closed)', () => {
    expect(decide(harnessList, {}, row(), { workspaceId: null })).toMatchObject({ allow: false, code: 'workspace_mismatch' });
  });

  it('refuses a workspace argument naming another workspace', () => {
    expect(decide(harnessList, { workspace: 'ws-other' })).toMatchObject({ allow: false, code: 'workspace_mismatch' });
  });

  it('refuses a harness outside the harness allowlist (arg or transport)', () => {
    const r = row({ scopes: { tools: ['plans:*'], harnesses: ['alpha'] } });
    expect(decide(plansGet, { harness: 'beta' }, r)).toMatchObject({ allow: false, code: 'harness_not_in_scope' });
    expect(decide(plansGet, { harness: 'alpha' }, r, { harnessSlug: 'beta' })).toMatchObject({ allow: false, code: 'harness_not_in_scope' });
    expect(decide(plansGet, { harness: 'alpha' }, r)).toEqual({ allow: true });
  });

  it('requires a harness to be named when the key is harness-limited and the tool takes one', () => {
    const r = row({ scopes: { tools: ['plans:*'], harnesses: ['alpha'] } });
    expect(decide(plansGet, {}, r)).toMatchObject({ allow: false, code: 'harness_required_by_scope' });
    expect(decide(plansGet, {}, r, { harnessSlug: '*' })).toMatchObject({ allow: false, code: 'harness_required_by_scope' });
  });
});

describe('evaluateAppScope — live key state', () => {
  it('refuses revoked, paused and expired keys whatever they ask for', () => {
    expect(decide(harnessList, {}, row({ revoked_at: new Date() }))).toMatchObject({ allow: false, code: 'key_revoked' });
    expect(decide(harnessList, {}, row({ paused_at: new Date() }))).toMatchObject({ allow: false, code: 'key_paused' });
    expect(decide(harnessList, {}, row({ expires_at: new Date(Date.now() - 1000) }))).toMatchObject({ allow: false, code: 'key_expired' });
    expect(decide(harnessList, {}, row({ expires_at: new Date(Date.now() + 60_000) }))).toEqual({ allow: true });
  });
});

describe('validateAppKeyScopes — issue-time refusal (R-6)', () => {
  it('accepts an ordinary scope', () => {
    expect(validateAppKeyScopes({ capabilities: ['harness:read'], tools: ['harness:list', 'plans:*'], harnesses: ['alpha'] })).toEqual([]);
  });

  it('refuses the wildcard capability and hard-denied capability namespaces', () => {
    const problems = validateAppKeyScopes({ capabilities: ['*', 'capability:bash', 'secrets:x:read', 'processes:kill', 'harness:read'] });
    expect(problems.map((p) => p.value)).toEqual(['*', 'capability:bash', 'secrets:x:read', 'processes:kill']);
  });

  it('refuses wildcard tool entries and hard-denied groups', () => {
    const problems = validateAppKeyScopes({ tools: ['*', '*:*', 'dev:restart', 'tools:*', 'harness:list'] });
    expect(problems.map((p) => p.value)).toEqual(['*', '*:*', 'dev:restart', 'tools:*']);
  });

  it('with the catalog, refuses a tool whose declared capability is hard-denied, a cross-workspace tool, and an unknown tool', () => {
    const catalog = new Map<string, Pick<AppScopeTool, 'name' | 'capabilities' | 'crossWorkspace'>>([
      ['harness:list', { name: 'harness:list', capabilities: ['harness:read'] }],
      ['harness:shell', { name: 'harness:shell', capabilities: ['capability:bash'] }],
      ['search:semantic', { name: 'search:semantic', capabilities: ['search:read'], crossWorkspace: true }],
    ]);
    const problems = validateAppKeyScopes({ tools: ['harness:list', 'harness:shell', 'search:semantic', 'harness:nope'] }, catalog);
    expect(problems.map((p) => p.value)).toEqual(['harness:shell', 'search:semantic', 'harness:nope']);
  });
});

describe('grantedToolCapabilities — the principal a key authenticates as (WI-10004317)', () => {
  const catalog: AppScopeTool[] = [
    harnessList,
    plansGet,
    { name: 'plans:list', capabilities: ['plans:read', 'plans:list'] },
    { name: 'work_items:list', capabilities: ['work_items:read'] },
    { name: 'harness:shell', capabilities: ['capability:bash'] },
    { name: 'dev:restart', capabilities: ['dev:ops'] },
    { name: 'search:semantic', capabilities: ['search:read'], crossWorkspace: true },
  ];
  const caps = (scopes: Parameters<typeof grantedToolCapabilities>[0]) =>
    [...grantedToolCapabilities(scopes, catalog)].sort();

  it('an exact-tool key with no explicit capabilities carries the capabilities its tools declare', () => {
    expect(caps({ capabilities: [], tools: ['work_items:list'] })).toEqual(['work_items:read']);
  });

  it('a group entry covers every tool in the group; explicit capabilities are kept', () => {
    expect(caps({ capabilities: ['x:y'], tools: ['plans:*'] })).toEqual(['plans:list', 'plans:read', 'x:y']);
  });

  it('a tampered row naming hard-denied or cross-workspace tools lifts none of their capabilities', () => {
    expect(caps({ tools: ['harness:shell', 'dev:restart', 'search:semantic'] })).toEqual([]);
  });

  it('no tools named: only the explicit capabilities', () => {
    expect(caps({ capabilities: ['harness:read'] })).toEqual(['harness:read']);
    expect(caps(null)).toEqual([]);
  });
});
