import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CLASS_EXACT_REF, compileAgentSpecification, GrantsSchema, type ResolvedCapabilityProviderInput,
} from '@papercusp/orchestrator/blueprint';
import {
  CAPABILITY_CLASS_ID_PATTERN, CAPABILITY_CLASS_VERSION_PATTERN, type PotCapabilityProviderBindingRow,
} from '../capability-class-registry-store';
import { resolveIdentityGrantEnvelope } from './blueprint-envelopes';
import { identityRefusalContract } from './identity-refusal-contract';
import { grantProviderToolReach, type GrantProviderEvidence } from '../agent-identities/grant-provider-kinds';
import { recipeProviderPins } from '../cupboard/capability-grant-resolver';

const CLASS = 'crm.email@1.0.0';
const pin = (over: Partial<ResolvedCapabilityProviderInput> = {}): ResolvedCapabilityProviderInput => ({
  kind: 'capability-provider', ref: CLASS, providerPackage: 'acme-mail', providerVersion: '1.0.0',
  conformanceRunId: 'run-1', registryRevision: 'registry-1', verbBindings: { send: 'acme:send' }, ...over,
});
const binding = (over: Partial<PotCapabilityProviderBindingRow> = {}): PotCapabilityProviderBindingRow => ({
  classRef: CLASS, providerPackage: 'acme-mail', providerVersion: '1.0.0',
  conformanceRunId: 'run-1', registryRevision: 'registry-1', verbBindings: { send: 'acme:send' },
  status: 'active', conformanceStatus: 'passed', behavioralStatus: 'not-required', behavioralRunRef: null,
  potSlug: 'sales', boundBy: 'owner', boundAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z', ...over,
});
function fixture(grants: { requires?: string[]; optional?: string[] } | undefined = { requires: [CLASS] }, pins = [pin()]) {
  const specification = compileAgentSpecification({
    source: { id: 'grant-test', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } }, ...(grants ? { grants } : {}) },
    prompt: { role: 'worker', text: 'Use the selected mail provider.' }, inputClosure: pins,
  });
  return { specification, appliedSpecificationRevision: specification.specificationRevision,
    policyRevision: 'policy-1', potSlug: 'sales', bindings: [binding()],
    ceilings: [{ allowCapabilities: ['mail:send'] }],
    tools: new Map<string, readonly string[]>([['acme:send', ['mail:send']], ['evil:send', ['mail:send']]]),
  };
}

describe('P-005 applied identity capability grants', () => {
  it('grants exact provider tools without granting other tools sharing their capability', () => {
    const input = fixture();
    const result = resolveIdentityGrantEnvelope(input);
    expect(result).toMatchObject({ applied: true, allowedTools: ['acme:send'], failures: [], policyRevision: 'policy-1' });
    expect(result.applied && result.allowedTools).not.toContain('evil:send');
  });

  it('preserves an absent grant declaration but confines explicitly empty grants to no tools', () => {
    const empty = fixture({ requires: [] }, []);
    expect(resolveIdentityGrantEnvelope(empty)).toMatchObject({ applied: true, allowedTools: [], failures: [] });
    const specification = compileAgentSpecification({
      source: { id: 'plain-test', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
      prompt: { role: 'worker', text: 'Plain.' },
    });
    expect(resolveIdentityGrantEnvelope({ ...empty, specification })).toEqual({ applied: false });
  });

  it.each([
    { providerPackage: 'other' }, { providerVersion: '2.0.0' }, { registryRevision: 'registry-2' },
    { conformanceRunId: 'run-2' }, { verbBindings: { send: 'evil:send' } },
  ])('refuses a current provider that differs from the applied pin: %j', (over) => {
    const result = resolveIdentityGrantEnvelope({ ...fixture(), bindings: [binding(over)] });
    expect(result).toMatchObject({ allowedTools: [], failures: [{ code: 'capability_unsatisfied', classRef: CLASS, cause: 'provider-changed' }] });
  });

  it('WI-10005197: every resolver refusal carries the lift condition for its cause', () => {
    // The envelope is a union (`applied:false` carries no failures), so narrow before reading.
    const failuresOf = (envelope: ReturnType<typeof resolveIdentityGrantEnvelope>) => envelope.applied ? envelope.failures : [];
    const failures = [
      ...failuresOf(resolveIdentityGrantEnvelope({ ...fixture(), appliedSpecificationRevision: 'b'.repeat(64) })), // stale-artifact
      ...failuresOf(resolveIdentityGrantEnvelope({ ...fixture(), ceilings: null })),                              // policy-unavailable
      ...failuresOf(resolveIdentityGrantEnvelope({ ...fixture(), bindings: [] })),                                // provider-unbound
      ...failuresOf(resolveIdentityGrantEnvelope({ ...fixture(), bindings: [binding({ providerVersion: '2.0.0' })] })), // provider-changed
    ];
    expect(failures.map((failure) => failure.cause).sort())
      .toEqual(['policy-unavailable', 'provider-changed', 'provider-unbound', 'stale-artifact']);
    for (const failure of failures) {
      expect(failure.refusal).toEqual(identityRefusalContract(failure.cause));
      expect(failure.refusal?.liftsWhen).toBeTruthy();
      expect(failure.refusal?.whoCanMakeItTrue.length).toBeGreaterThan(0);
    }
  });

  it.each(['retired', 'removed'])('revokes immediately when the provider is %s, with the old artifact still applied', (status) => {
    const input = fixture();
    expect(resolveIdentityGrantEnvelope(input)).toMatchObject({ allowedTools: ['acme:send'] });
    expect(resolveIdentityGrantEnvelope({ ...input, policyRevision: 'policy-2', bindings: [binding({ status })] }))
      .toMatchObject({ allowedTools: [], policyRevision: 'policy-2', failures: [{ cause: 'provider-unbound', classRef: CLASS }] });
  });

  it('cannot reuse another pot binding or silently continue after unbind', () => {
    for (const bindings of [[], [binding({ potSlug: 'other-pot' })]]) {
      expect(resolveIdentityGrantEnvelope({ ...fixture(), bindings })).toMatchObject({ allowedTools: [], failures: [{ cause: 'provider-unbound' }] });
    }
  });

  it('requires the applied artifact and current policy evidence', () => {
    expect(resolveIdentityGrantEnvelope({ ...fixture(), appliedSpecificationRevision: 'b'.repeat(64) }))
      .toMatchObject({ allowedTools: [], failures: [{ cause: 'stale-artifact' }] });
    for (const missing of [{ bindings: null }, { ceilings: null }, { ceilings: [] }, { policyRevision: '' }]) {
      expect(resolveIdentityGrantEnvelope({ ...fixture(), ...missing }))
        .toMatchObject({ allowedTools: [], failures: [{ cause: 'policy-unavailable' }] });
    }
  });

  it('intersects all ceilings and rejects explicit empty authority', () => {
    for (const ceilings of [
      [{ allowCapabilities: [] }],
      [{ allowCapabilities: ['mail:send'] }, { denyCapabilities: ['mail:*'] }],
      [{ allowCapabilities: ['mail:send'] }, { allowCapabilities: ['mail:read'] }],
    ]) {
      expect(resolveIdentityGrantEnvelope({ ...fixture(), ceilings }))
        .toMatchObject({ allowedTools: [], failures: [{ cause: 'outside-ceiling', classRef: CLASS, toolName: 'acme:send' }] });
    }
  });

  it('does not turn a provider pin or a wildcard ceiling into protected authority', () => {
    expect(resolveIdentityGrantEnvelope({ ...fixture(), ceilings: [{ allowCapabilities: ['*'] }],
      tools: new Map([['acme:send', ['secrets:read:mail']]]) }))
      .toMatchObject({ allowedTools: [], failures: [{ cause: 'outside-ceiling' }] });
  });

  it('refuses missing host tool metadata, duplicate pins and duplicate binding evidence', () => {
    expect(resolveIdentityGrantEnvelope({ ...fixture(), tools: new Map() }))
      .toMatchObject({ allowedTools: [], failures: [{ cause: 'tool-unavailable' }] });
    expect(() => fixture({ requires: [CLASS] }, [pin(), pin({ providerPackage: 'other' })]))
      .toThrow('input-conflict');
    expect(resolveIdentityGrantEnvelope({ ...fixture(), bindings: [binding(), binding({ providerPackage: 'other' })] }))
      .toMatchObject({ allowedTools: [], failures: [{ cause: 'provider-changed' }] });
  });

  it('never auto-activates an optional class that was not pinned, and removes an optional unbound grant', () => {
    expect(resolveIdentityGrantEnvelope(fixture({ optional: [CLASS] }, [])))
      .toMatchObject({ allowedTools: [], failures: [] });
    expect(resolveIdentityGrantEnvelope({ ...fixture({ optional: [CLASS] }), bindings: [] }))
      .toMatchObject({ allowedTools: [], failures: [] });
  });

  it('unions declared classes while ignoring unrelated provider inputs', () => {
    const ref = 'crm.contacts@1.0.0';
    const second = pin({ ref, verbBindings: { read: 'acme:contacts' } });
    const input = fixture({ requires: [CLASS, ref] }, [pin(), second, pin({ ref: 'crm.admin@1.0.0', verbBindings: { delete: 'acme:delete' } })]);
    const result = resolveIdentityGrantEnvelope({ ...input,
      bindings: [binding(), binding({ classRef: ref, verbBindings: second.verbBindings })],
      ceilings: [{ allowCapabilities: ['mail:send', 'contacts:read'] }],
      tools: new Map([...input.tools, ['acme:contacts', ['contacts:read']]]),
    });
    expect(result).toMatchObject({ allowedTools: ['acme:contacts', 'acme:send'], failures: [] });
  });
});

// P-012 / D-040(a): a need is a capability class at an exact class@version.
describe('P-012 grants name classes, never tool ids', () => {
  it('refuses a tool id or a major-only ref and accepts an exact class version', () => {
    for (const ref of ['work_items:claim', 'acme:send', 'crm.email@1', 'crm.email']) {
      const parsed = GrantsSchema.safeParse({ requires: [ref] });
      expect(parsed.success, ref).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('never a tool id');
      expect(GrantsSchema.safeParse({ optional: [ref] }).success, ref).toBe(false);
    }
    expect(GrantsSchema.parse({ requires: [CLASS], optional: ['crm.contacts@2.1.0-beta.1'] }))
      .toMatchObject({ requires: [CLASS], optional: ['crm.contacts@2.1.0-beta.1'] });
  });

  it('spells the grant ref exactly as the registry spells a class id and version', () => {
    const strip = (pattern: RegExp) => pattern.source.replace(/^\^/, '').replace(/\$$/, '');
    expect(CAPABILITY_CLASS_EXACT_REF.source)
      .toBe(`^${strip(CAPABILITY_CLASS_ID_PATTERN)}@${strip(CAPABILITY_CLASS_VERSION_PATTERN)}$`);
  });
});

// P-012 / D-040(e): a recipe provider's verbBindings name recipes. Its grant is
// the tool reach its inspection recorded, the same reach install checks.
describe('P-012 recipe-provided grant reach', () => {
  const RECIPE = 'acme-send-recipe';
  const recipeBinding = (toolNames: string[], recipeId = RECIPE) => ({
    ...binding({ verbBindings: { send: RECIPE } }),
    providerKind: 'recipe' as const, latencyClass: 'sync' as const,
    recipeInspections: { send: { recipe: { id: recipeId, revision: 'r1' }, inspectionPin: { recipe: recipeId }, toolNames } },
  }) as unknown as PotCapabilityProviderBindingRow;

  it('grants the tools the inspected recipe calls, never the recipe id as a tool', () => {
    const input = fixture({ requires: [CLASS] }, [pin({ verbBindings: { send: RECIPE } })]);
    const result = resolveIdentityGrantEnvelope({ ...input, bindings: [recipeBinding(['acme:send'])] });
    expect(result).toMatchObject({ applied: true, allowedTools: ['acme:send'], failures: [] });
  });

  it('closes the envelope when a recipe reach exceeds the ceiling or lacks inspection evidence', () => {
    const input = fixture({ requires: [CLASS] }, [pin({ verbBindings: { send: RECIPE } })]);
    const tools = new Map([...input.tools, ['acme:purge', ['mail:delete']]]);
    expect(resolveIdentityGrantEnvelope({ ...input, tools, bindings: [recipeBinding(['acme:send', 'acme:purge'])] }))
      .toMatchObject({ allowedTools: [], failures: [{ cause: 'outside-ceiling', toolName: 'acme:purge' }] });
    expect(resolveIdentityGrantEnvelope({ ...input, bindings: [recipeBinding(['acme:send'], 'other-recipe')] }))
      .toMatchObject({ allowedTools: [], failures: [{ cause: 'provider-unbound', classRef: CLASS }] });
  });

  it('reaches exactly the tools install admits for the same provider row', () => {
    // The install seat's expression (validateIdentityInstallGrants), kept verbatim.
    const installReach = (provider: GrantProviderEvidence) => {
      const names = provider.providerKind === 'recipe'
        ? recipeProviderPins(provider as never)?.flatMap((entry) => entry.toolNames) ?? null
        : Object.values(provider.verbBindings);
      return names ? [...new Set(names)].sort() : null;
    };
    for (const provider of [binding(), recipeBinding(['acme:send', 'acme:read']), recipeBinding(['acme:send'], 'other-recipe')]) {
      expect(grantProviderToolReach(provider)).toEqual(installReach(provider));
    }
  });
});
