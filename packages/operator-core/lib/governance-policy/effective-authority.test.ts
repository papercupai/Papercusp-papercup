import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_KINDS, authorityRevisionIsCurrent, comparePermissionPopulations,
  evaluateEffectivePermission, revalidateEffectivePermission, resourcePermissionValue,
  type AuthorityPolicy, type AuthorityRevisionVector, type AuthoritySnapshot, type PermissionPopulationProof, type PermissionRequest,
} from './effective-authority';

const request: PermissionRequest = {
  tool: 'capability:bash', action: 'net:connect',
  resource: { kind: 'network', operation: 'connect', target: 'https://approved.example:443' },
};
function fixture(): AuthoritySnapshot {
  const policies: AuthorityPolicy[] = AUTHORITY_KINDS.map(kind => ({
    kind, id: kind, revision: `${kind}:1`, state: 'present', rules: {},
  }));
  policies[0].rules = { tools: { allow: ['*'] }, actions: { allow: ['*'] }, resources: { allow: ['*'] } };
  policies.push({ kind: 'vault', id: 'second-vault', revision: 'second:1', state: 'present', rules: {} });
  return {
    required: policies.map(({ kind, id }) => ({ kind, id })), policies,
    contextRevision: 'context:1', contextVaultIds: ['vault', 'second-vault'],
  };
}

describe('effective authority contract (P-024)', () => {
  it.each(AUTHORITY_KINDS)('each independent %s authority can decide refusal despite all other grants', kind => {
    const snapshot = fixture();
    const policy = snapshot.policies.find(policy => policy.kind === kind)!;
    policy.rules = { ...policy.rules, resources: { allow: [] } };
    const decision = evaluateEffectivePermission(snapshot, request);
    expect(decision.allowed).toBe(false);
    expect(decision.decidingAuthority?.kind).toBe(kind);
    expect(decision.trace).toContainEqual(expect.objectContaining({
      authority: expect.objectContaining({ kind, revision: `${kind}:1` }),
      category: 'resources', outcome: 'not-allowed',
    }));
  });

  it('an additional retained vault narrows permission instead of adding grants', () => {
    const snapshot = fixture();
    snapshot.policies.find(policy => policy.id === 'second-vault')!.rules = { actions: { deny: ['net:*'] } };
    expect(evaluateEffectivePermission(snapshot, request)).toMatchObject({
      allowed: false, decidingAuthority: { kind: 'vault', id: 'second-vault' },
    });
  });

  it('a permitted tool does not confer a resource and the actual target decides', () => {
    const snapshot = fixture();
    snapshot.policies[0].rules = {
      tools: { allow: ['capability:bash'] },
      actions: { allow: ['net:connect'] },
      resources: { allow: [resourcePermissionValue(request.resource)] },
    };
    expect(evaluateEffectivePermission(snapshot, request).allowed).toBe(true);
    expect(evaluateEffectivePermission(snapshot, {
      ...request, resource: { ...request.resource, target: 'https://other.example:443' },
      constraints: { resources: [resourcePermissionValue(request.resource)] },
    }).allowed).toBe(false);
  });

  it('a tool-only identity grant cannot silently acquire actions or resources', () => {
    const snapshot = fixture();
    snapshot.policies[0].rules = { tools: { allow: ['capability:bash'] } };
    expect(evaluateEffectivePermission(snapshot, request)).toMatchObject({
      allowed: false, code: 'authority-unavailable',
    });
  });

  it.each(['/safe/*', '/safe/name*', '/safe/%2A'])('an exact resource grant for %s cannot grant a sibling', target => {
    const snapshot = fixture();
    const literal: PermissionRequest = {
      ...request, resource: { kind: 'filesystem', operation: 'read', target },
    };
    snapshot.policies[0].rules!.resources = { allow: [resourcePermissionValue(literal.resource)] };
    expect(evaluateEffectivePermission(snapshot, literal).allowed).toBe(true);
    expect(evaluateEffectivePermission(snapshot, {
      ...literal, resource: { ...literal.resource, target: '/safe/name-secret' },
    })).toMatchObject({ allowed: false, code: 'denied', decidingAuthority: { kind: 'identity' } });
    expect(resourcePermissionValue(literal.resource)).not.toContain('*');
  });

  it('verified no-vault context is neutral but an omitted retained vault fails closed', () => {
    const snapshot = fixture();
    const noVault: AuthoritySnapshot = {
      ...snapshot, required: snapshot.required.filter(ref => ref.kind !== 'vault'),
      policies: snapshot.policies.filter(policy => policy.kind !== 'vault'), contextVaultIds: [],
    };
    expect(evaluateEffectivePermission(noVault, request).allowed).toBe(true);
    expect(evaluateEffectivePermission({ ...noVault, contextVaultIds: ['lost-vault'] }, request)).toMatchObject({
      allowed: false, code: 'authority-unavailable',
    });
  });

  it('missing, unavailable, malformed, duplicate and undeclared authorities never permit access', () => {
    const snapshot = fixture();
    expect(evaluateEffectivePermission({ ...snapshot, policies: snapshot.policies.slice(1) }, request).allowed).toBe(false);
    expect(evaluateEffectivePermission({ ...snapshot, required: snapshot.required.slice(1) }, request).allowed).toBe(false);
    for (const policy of [
      { ...snapshot.policies[0], state: 'unavailable' as const },
      { ...snapshot.policies[0], state: 'not-applicable' as const },
      { ...snapshot.policies[0], revision: '' },
      { ...snapshot.policies[0], rules: { tools: { allow: 'all' } } } as unknown as AuthorityPolicy,
    ]) {
      expect(evaluateEffectivePermission({ ...snapshot, policies: [policy, ...snapshot.policies.slice(1)] }, request).allowed).toBe(false);
    }
    expect(evaluateEffectivePermission({ ...snapshot, policies: [...snapshot.policies, snapshot.policies[0]] }, request).allowed).toBe(false);
  });

  it('absent optional organization levels require explicit, revisioned absence', () => {
    const snapshot = fixture();
    const org = snapshot.policies.find(policy => policy.kind === 'organization')!;
    org.state = 'not-applicable'; delete org.rules;
    expect(evaluateEffectivePermission(snapshot, request).allowed).toBe(true);
    org.rules = {};
    expect(evaluateEffectivePermission(snapshot, request)).toMatchObject({ allowed: false, code: 'authority-malformed' });
  });

  it('invalid or empty action/resource requests refuse instead of vacuously passing', () => {
    expect(evaluateEffectivePermission(fixture(), { ...request, action: '' }).code).toBe('invalid-request');
    expect(evaluateEffectivePermission(fixture(), { ...request, resource: { ...request.resource, target: '' } }).allowed).toBe(false);
    expect(evaluateEffectivePermission(fixture(), { ...request, constraints: { futureCategory: ['ignored'] } } as PermissionRequest).code).toBe('invalid-request');
    expect(evaluateEffectivePermission(null as unknown as AuthoritySnapshot, request).allowed).toBe(false);
  });

  it('revision tokens detect context changes, policy changes, newly required policies and replay', () => {
    const snapshot = fixture();
    const decision = evaluateEffectivePermission(snapshot, request);
    expect(decision.revisions).not.toBeNull();
    expect(authorityRevisionIsCurrent(decision.revisions!, snapshot)).toBe(true);
    expect(authorityRevisionIsCurrent(decision.revisions!, { ...snapshot, contextRevision: 'context:2' })).toBe(false);
    snapshot.policies[0].revision = 'identity:2';
    expect(authorityRevisionIsCurrent(decision.revisions!, snapshot)).toBe(false);
    snapshot.policies[0].revision = 'identity:1';
    snapshot.required = [...snapshot.required, { kind: 'vault', id: 'new-vault' }];
    snapshot.contextVaultIds = [...snapshot.contextVaultIds, 'new-vault'];
    expect(authorityRevisionIsCurrent(decision.revisions!, snapshot)).toBe(false);
  });

  it.each([null, undefined, {}, { contextRevision: 'context:1', authorities: [null] },
    { contextRevision: 'context:1', authorities: 'all' }])('malformed stored revision tokens refuse: %j', token => {
    expect(authorityRevisionIsCurrent(token as unknown as AuthorityRevisionVector, fixture())).toBe(false);
    expect(revalidateEffectivePermission(fixture(), request, token as unknown as AuthorityRevisionVector))
      .toMatchObject({ allowed: false, code: 'authority-stale' });
  });

  it('a current revision token cannot authorize a different resolved target', () => {
    const snapshot = fixture();
    snapshot.policies[0].rules!.resources = { allow: [resourcePermissionValue(request.resource)] };
    const token = evaluateEffectivePermission(snapshot, request).revisions;
    expect(revalidateEffectivePermission(snapshot, request, token).allowed).toBe(true);
    expect(revalidateEffectivePermission(snapshot,
      { ...request, resource: { ...request.resource, target: 'https://denied.example:443' } }, token))
      .toMatchObject({ allowed: false, code: 'denied', decidingAuthority: { kind: 'identity' } });
  });

  it.each(['queued', 'in-flight'])('a %s authorization is checked again at the protected effect', async () => {
    const snapshot = fixture();
    const token = evaluateEffectivePermission(snapshot, request).revisions;
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const effects: string[] = [];
    const work = (async () => {
      await paused;
      const decision = revalidateEffectivePermission(snapshot, request, token);
      if (decision.allowed) effects.push(request.resource.target);
      return decision;
    })();
    const vault = snapshot.policies.find(policy => policy.id === 'second-vault')!;
    vault.revision = 'second:2';
    vault.rules = { resources: { allow: [] } };
    resume();
    expect(await work).toMatchObject({ allowed: false, code: 'denied',
      decidingAuthority: { kind: 'vault', id: 'second-vault' } });
    expect(effects).toEqual([]);
  });

  it('even a still-permitted action needs fresh authorization after a revision change', () => {
    const snapshot = fixture();
    const token = evaluateEffectivePermission(snapshot, request).revisions;
    snapshot.contextRevision = 'context:2';
    expect(revalidateEffectivePermission(snapshot, request, token))
      .toMatchObject({ allowed: false, code: 'authority-stale', revisions: { contextRevision: 'context:2' } });
    const fresh = evaluateEffectivePermission(snapshot, request);
    expect(revalidateEffectivePermission(snapshot, request, fresh.revisions).allowed).toBe(true);
  });

  it('authority load order and duplicate scoped values cannot change the canonical trace', () => {
    const snapshot = fixture();
    snapshot.policies.find(policy => policy.kind === 'user')!.rules = { actions: { deny: ['net:*'] } };
    snapshot.policies.find(policy => policy.kind === 'vault')!.rules = { resources: { allow: [] } };
    const first = evaluateEffectivePermission(snapshot,
      { ...request, constraints: { actions: ['net:read', 'net:connect', 'net:read'] } });
    const permuted = { ...snapshot, policies: [...snapshot.policies].reverse(),
      required: [...snapshot.required].reverse(), contextVaultIds: [...snapshot.contextVaultIds].reverse() };
    expect(evaluateEffectivePermission(permuted,
      { ...request, constraints: { actions: ['net:connect', 'net:read'] } })).toEqual(first);
    expect(first.decidingAuthority).toEqual({ kind: 'user', id: 'user' });
  });
});

describe('permission-change proof (D-024)', () => {
  const proof = (allowed: string[]): PermissionPopulationProof => ({
    populationRevision: 'manifest:1', complete: true, population: ['read', 'send'], allowed,
  });
  it('proves neutral/narrowing only on the same complete population and identifies any added authority', () => {
    expect(comparePermissionPopulations(proof(['read']), proof(['read'])).kind).toBe('neutral');
    expect(comparePermissionPopulations(proof(['read', 'send']), proof(['read']))).toMatchObject({ kind: 'narrowing', removed: ['send'] });
    expect(comparePermissionPopulations(proof(['read']), proof(['send']))).toMatchObject({ kind: 'widening', added: ['send'], removed: ['read'] });
  });
  it('incomplete, changed, empty or malformed populations are unknown, never silently narrowing', () => {
    for (const after of [
      { ...proof([]), complete: false },
      { ...proof([]), populationRevision: 'manifest:2' },
      { ...proof([]), population: ['read', 'delete'] },
      { ...proof([]), population: [] },
      { ...proof(['foreign']) },
      { ...proof([]), population: ['read', 'read'] },
    ]) expect(comparePermissionPopulations(proof(['read', 'send']), after).kind).toBe('unknown');
  });
  it.each(['false', 'true', 1, {}, []])('nonboolean completeness %j cannot prove an authority change', complete => {
    const malformed = { ...proof(['read']), complete } as unknown as PermissionPopulationProof;
    expect(comparePermissionPopulations(malformed, proof(['read']))).toMatchObject({ kind: 'unknown' });
    expect(comparePermissionPopulations(proof(['read', 'send']), malformed)).toMatchObject({ kind: 'unknown' });
  });
});
