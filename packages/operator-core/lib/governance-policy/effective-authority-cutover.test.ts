import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_KINDS, evaluateEffectivePermission, revalidateEffectivePermission, resourcePermissionValue,
  type AuthorityPolicy, type AuthorityRef, type AuthoritySnapshot, type PermissionRequest,
} from './effective-authority';

// These exercise the shared reauthorization contract, not production queues,
// transport, provider billing, or resource adapters (owned by P-005).
const request: PermissionRequest = {
  tool: 'store:write', action: 'record:write',
  resource: { kind: 'store', operation: 'write', target: 'audit-record' },
  constraints: { providers: ['approved-provider'] },
};
const authorities: AuthorityRef[] = [
  ...AUTHORITY_KINDS.map(kind => ({ kind, id: kind })),
  { kind: 'vault', id: 'second-vault' },
];
function snapshot(): AuthoritySnapshot {
  const policies: AuthorityPolicy[] = authorities.map(ref => ({
    ...ref, revision: `${ref.id}:1`, state: 'present', rules: {},
  }));
  policies[0].rules = {
    tools: { allow: ['store:write'] }, actions: { allow: ['record:write'] },
    resources: { allow: [resourcePermissionValue(request.resource)] },
  };
  return {
    required: authorities.map(ref => ({ ...ref })), policies, contextRevision: 'context:1',
    contextVaultIds: ['vault', 'second-vault'],
  };
}

async function resumeContract(current: AuthoritySnapshot, change: () => void) {
  const initial = evaluateEffectivePermission(current, request);
  expect(initial.allowed).toBe(true);
  let resume!: () => void;
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  const effects: string[] = [];
  const pending = (async () => {
    await barrier;
    const decision = revalidateEffectivePermission(current, request, initial.revisions);
    if (decision.allowed) effects.push(request.resource.target);
    return decision;
  })();
  change();
  resume();
  return { initial, decision: await pending, effects };
}

const cutovers = authorities.flatMap(authority =>
  (['revocation', 'narrowing'] as const).map(change => ({
    authority, change, name: `${authority.kind}/${authority.id} ${change}`,
  })));

describe('P-024 shared cutover contract', () => {
  it.each(cutovers)('$name rechecks the deciding revision before the contract effect', async ({ authority, change }) => {
    const unchanged = await resumeContract(snapshot(), () => {});
    expect(unchanged.decision).toMatchObject({ allowed: true, code: 'allowed', request });
    expect(unchanged.effects).toEqual(['audit-record']);
    expect(unchanged.decision.revisions).toEqual(unchanged.initial.revisions);

    const current = snapshot();
    const policy = current.policies.find(policy => policy.kind === authority.kind && policy.id === authority.id)!;
    const result = await resumeContract(current, () => {
      policy.revision = `${authority.id}:2`;
      policy.rules = { ...policy.rules, resources: {
        allow: change === 'revocation' ? [] : [resourcePermissionValue(request.resource)],
      } };
    });
    const revision = { ...authority, revision: `${authority.id}:2` };
    expect(result.effects).toEqual([]);
    expect(result.decision).toMatchObject({
      allowed: false, code: change === 'revocation' ? 'denied' : 'authority-stale', request,
      revisions: { contextRevision: 'context:1' },
    });
    expect(result.decision.revisions!.authorities).toHaveLength(authorities.length);
    expect(result.decision.revisions!.authorities).toContainEqual(revision);
    expect(result.decision.trace).toContainEqual(expect.objectContaining({
      authority: revision, category: 'resources', value: resourcePermissionValue(request.resource),
      outcome: change === 'revocation' ? 'not-allowed' : 'pass',
    }));
    if (change === 'revocation') expect(result.decision.decidingAuthority).toEqual(authority);
    else {
      expect(result.decision.decidingAuthority).toBeUndefined();
      const fresh = evaluateEffectivePermission(current, request);
      expect(revalidateEffectivePermission(current, request, fresh.revisions).allowed).toBe(true);
    }
  });

  it('a retained-context cutover requires fresh authorization even with unchanged policy revisions', async () => {
    const current = snapshot();
    const result = await resumeContract(current, () => { current.contextRevision = 'context:2'; });
    expect(result.effects).toEqual([]);
    expect(result.decision).toMatchObject({
      allowed: false, code: 'authority-stale', request, revisions: { contextRevision: 'context:2' },
    });
    expect(result.decision.revisions!.authorities).toEqual(result.initial.revisions!.authorities);
  });
});

describe('P-024 required authority and scoped arguments', () => {
  it.each(authorities.flatMap(authority => (['missing', 'unreadable', 'stale'] as const).map(failure => ({
    authority, failure, name: `${authority.kind}/${authority.id} ${failure}`,
  }))))('$name refuses while the unchanged authority control permits', ({ authority, failure }) => {
    const current = snapshot();
    const initial = evaluateEffectivePermission(current, request);
    expect(initial.allowed).toBe(true);
    const policy = current.policies.find(policy => policy.kind === authority.kind && policy.id === authority.id)!;
    if (failure === 'missing') current.policies = current.policies.filter(entry => entry !== policy);
    else if (failure === 'unreadable') policy.state = 'unavailable';
    else policy.revision = `${authority.id}:2`;
    expect(revalidateEffectivePermission(current, request, initial.revisions)).toMatchObject({
      allowed: false, code: failure === 'stale' ? 'authority-stale' : 'authority-unavailable', request,
    });
  });

  it.each(['tools', 'resources', 'providers'] as const)(
    'an empty %s allowlist refuses the actual tool, resource or scoped argument', category => {
      const current = snapshot();
      expect(evaluateEffectivePermission(current, request).allowed).toBe(true);
      current.policies.find(policy => policy.kind === 'user')!.rules = { [category]: { allow: [] } };
      const decision = evaluateEffectivePermission(current, request);
      expect(decision).toMatchObject({ allowed: false, code: 'denied', request,
        decidingAuthority: { kind: 'user', id: 'user' } });
      expect(decision.trace).toContainEqual(expect.objectContaining({
        authority: { kind: 'user', id: 'user', revision: 'user:1' }, category, outcome: 'not-allowed',
      }));
    },
  );

  it('verified no-active-vault context is neutral; declaring an unloaded retained vault refuses', () => {
    const current = snapshot();
    current.required = current.required.filter(ref => ref.kind !== 'vault');
    current.policies = current.policies.filter(ref => ref.kind !== 'vault');
    current.contextVaultIds = [];
    expect(evaluateEffectivePermission(current, request).allowed).toBe(true);
    current.contextVaultIds = ['unloaded-vault'];
    expect(evaluateEffectivePermission(current, request)).toMatchObject({
      allowed: false, code: 'authority-unavailable', request,
    });
  });
});
