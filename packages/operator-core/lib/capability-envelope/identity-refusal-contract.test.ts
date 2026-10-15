/**
 * EI-23766133296678780: every fail-closed identity refusal must say what would LIFT it,
 * who can make that true, and what the gate actually compared.
 *
 * The exhaustiveness checks DERIVE from `IDENTITY_GRANT_FAILURE_CAUSES` rather than
 * restating the cause list, so a cause added to the gate without a lift condition fails
 * here (and at compile time, via the `Record` key type on the table).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification, type ResolvedCapabilityProviderInput } from '@papercusp/orchestrator/blueprint';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import { checkIdentityGrantKernel, type IdentityGrantPolicy } from './identity-grants-port';
import { IDENTITY_GRANT_FAILURE_CAUSES } from './blueprint-envelopes';
import {
  IDENTITY_REFUSAL_LIFT, identityRefusalContract, renderRefusalContract, shortRevision,
} from './identity-refusal-contract';

const io = vi.hoisted(() => ({ state: vi.fn(), binding: vi.fn(), tools: vi.fn(), flag: vi.fn() }));
vi.mock('../operator-state-pg', async (original) => ({
  ...(await original<typeof import('../operator-state-pg')>()), readOperatorState: io.state,
}));
vi.mock('../capability-class-registry-store', async (original) => ({
  ...(await original<typeof import('../capability-class-registry-store')>()), getPotCapabilityProviderBinding: io.binding,
}));
vi.mock('@papercusp/agent-mcp', async (original) => ({
  ...(await original<typeof import('@papercusp/agent-mcp')>()), listAllProjectedTools: io.tools,
}));
vi.mock('@papercusp/flags/server', async (original) => ({
  ...(await original<typeof import('@papercusp/flags/server')>()), getFlag: io.flag,
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: vi.fn() }),
}));

beforeEach(() => {
  for (const mock of Object.values(io)) mock.mockReset();
});

const CLASS = 'crm.email@1.0.0';
const pin: ResolvedCapabilityProviderInput = {
  kind: 'capability-provider', ref: CLASS, providerPackage: 'mail-provider', providerVersion: '1.0.0',
  conformanceRunId: 'run-a', registryRevision: 'registry-a', verbBindings: { send: 'mail:send' },
};

function fixture() {
  const artifact = compileAgentSpecification({
    source: {
      id: 'refusal-contract', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
      grants: { requires: [CLASS] },
    },
    prompt: { role: 'worker', text: 'Use mail.' }, inputClosure: [pin],
  });
  const applied = { specificationRevision: artifact.specificationRevision, stateRevision: 'state-a' };
  const record = { workspaceId: 'ws-a', harnessSlug: 'sales', ...applied, specificationArtifact: artifact };
  const state = { activation: { applied }, policyRevision: 'control:1' };
  const policy: IdentityGrantPolicy = {
    policyRevision: 'policy-a', potSlug: 'sales', ceilings: [{ allowCapabilities: ['mail:send'] }],
    protectedAdditions: [], tools: new Map([['mail:send', ['mail:send']]]),
    bindings: [{
      classRef: CLASS, providerPackage: pin.providerPackage, providerVersion: pin.providerVersion,
      conformanceRunId: pin.conformanceRunId, registryRevision: pin.registryRevision, verbBindings: pin.verbBindings,
      status: 'active', conformanceStatus: 'passed', behavioralStatus: 'not-required', behavioralRunRef: null,
      potSlug: 'sales', boundBy: 'admin', boundAt: '2026-09-13', updatedAt: '2026-09-13',
    }],
  };
  const request: KernelEnforcementRequest = {
    phase: 'enforce', boundary: 'dispatch', toolName: 'mail:send', capabilities: ['mail:send'],
    ctx: {
      workspaceId: 'ws-a', uiClientId: 'su-test', isSuperuser: true,
      log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    }, args: {},
  };
  return { artifact, applied, record, state, policy, request };
}

type Denial = {
  decision: string; reason?: string;
  obligations?: { capabilityUnsatisfied?: { cause?: string; refusal?: {
    observed: Record<string, string | null>; liftsWhen: string; whoCanMakeItTrue: string[];
  } } };
};
const denied = (result: unknown): Denial => {
  expect(result).toMatchObject({ decision: 'deny' });
  return result as Denial;
};

describe('refusal contract table (EI-23766133296678780)', () => {
  it('has exactly one lift condition per refusal cause', () => {
    expect(Object.keys(IDENTITY_REFUSAL_LIFT).sort()).toEqual([...IDENTITY_GRANT_FAILURE_CAUSES].sort());
  });

  it.each([...IDENTITY_GRANT_FAILURE_CAUSES])('%s names a lift condition and someone who can satisfy it', (cause) => {
    const contract = identityRefusalContract(cause, { applied: 'aaaaaaaa/bbbbbbbb' });
    expect(contract.liftsWhen.length).toBeGreaterThan(20);
    expect(contract.whoCanMakeItTrue.length).toBeGreaterThan(0);
    const rendered = renderRefusalContract(contract);
    expect(rendered).toContain('lifts when:');
    expect(rendered).toContain('observed: applied=aaaaaaaa/bbbbbbbb');
  });

  it('renders a missing observation as `none`, never an empty string', () => {
    expect(renderRefusalContract(identityRefusalContract('stale-artifact', { desired: null })))
      .toContain('desired=none');
    expect(renderRefusalContract(identityRefusalContract('outside-ceiling'))).not.toContain('observed:');
  });

  it('shortens a revision pair for comparison by eye', () => {
    expect(shortRevision({ specificationRevision: 'a'.repeat(64), stateRevision: 'b'.repeat(64) }))
      .toBe('aaaaaaaa/bbbbbbbb');
    expect(shortRevision(null)).toBeNull();
  });

  it('only an authority-statement cause is escalate-only; a state fault is self-recoverable', () => {
    // outside-ceiling does not lift by retrying or converging; stale-artifact is the one a session
    // can act on itself, which is the whole point of emitting the contract.
    expect(IDENTITY_REFUSAL_LIFT['outside-ceiling'].whoCanMakeItTrue).toEqual(['owner']);
    expect(IDENTITY_REFUSAL_LIFT['stale-artifact'].whoCanMakeItTrue).toContain('self');
  });
});

describe('the gate attaches the contract to its live denials', () => {
  it('stale-artifact: names the recovery door and the values compared, prefix unchanged', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    const desired = { specificationRevision: 'd'.repeat(64), stateRevision: 'e'.repeat(64) };
    const tampered = { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } };
    const result = denied(await checkIdentityGrantKernel(
      f.request,
      { ...f.state, activation: { applied: f.applied, desired } } as never,
      tampered, read,
    ));

    // The classifier keys on this prefix; the contract is APPENDED, never substituted.
    expect(result.reason).toMatch(/^Identity capability \(unresolved\): stale-artifact \(mail:send\)/);
    expect(result.reason).toContain('coord:orient');
    const refusal = result.obligations?.capabilityUnsatisfied?.refusal;
    expect(result.obligations?.capabilityUnsatisfied?.cause).toBe('stale-artifact');
    expect(refusal?.whoCanMakeItTrue).toContain('self');
    expect(refusal?.observed).toMatchObject({
      applied: shortRevision(f.applied),
      desired: shortRevision(desired),
      launchSpec: f.artifact.specificationRevision.slice(0, 8),
    });
    expect(refusal?.observed.resolution).toMatch(
      /^(replay-failed|record-revision-mismatch|receipt-missing|grants-asymmetric)$/,
    );
  });

  it('no-launch-record: says the HOST writes the record, and carries a null launchSpec', async () => {
    const f = fixture();
    const result = denied(await checkIdentityGrantKernel(
      f.request, { ...f.state, identityLaunchRecordMissing: true }, null, vi.fn(async () => f.policy),
    ));
    const refusal = result.obligations?.capabilityUnsatisfied?.refusal;
    expect(result.obligations?.capabilityUnsatisfied?.cause).toBe('no-launch-record');
    expect(refusal?.whoCanMakeItTrue).toEqual(['host']);
    expect(refusal?.liftsWhen).toContain('launch record');
  });

  it('policy-unavailable: points at a transient fault the host or owner can clear', async () => {
    const f = fixture();
    const result = denied(await checkIdentityGrantKernel(
      f.request, f.state, f.record, async () => { throw new Error('offline'); },
    ));
    expect(result.obligations?.capabilityUnsatisfied?.cause).toBe('policy-unavailable');
    expect(result.obligations?.capabilityUnsatisfied?.refusal?.whoCanMakeItTrue).toEqual(['host', 'owner']);
  });

  it('outside-ceiling: says it is an authority statement and escalates to the owner', async () => {
    const f = fixture();
    const narrowed: IdentityGrantPolicy = { ...f.policy, ceilings: [{ allowCapabilities: ['other:capability'] }] };
    const result = denied(await checkIdentityGrantKernel(f.request, f.state, f.record, async () => narrowed));
    const refusal = result.obligations?.capabilityUnsatisfied?.refusal;
    expect(refusal).toBeDefined();
    expect(result.reason).toMatch(/^Identity capability /);
    expect(result.reason).toContain('lifts when:');
  });

  it('leaves the recovery door untouched: an admitted coord:orient carries no refusal and no obligation', async () => {
    const f = fixture();
    const tampered = { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } };
    const result = await checkIdentityGrantKernel(
      { ...f.request, toolName: 'coord:orient', capabilities: [] }, f.state, tampered, vi.fn(async () => f.policy),
    );
    expect(result).toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });
    expect(result).not.toHaveProperty('obligations');
  });
});
