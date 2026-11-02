import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification, type ResolvedCapabilityProviderInput } from '@papercusp/orchestrator/blueprint';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { createPhaseTracker } from '@papercusp/tooldef';
import { checkIdentityGrantKernel, type IdentityGrantPolicy } from './identity-grants-port';
import {
  __resetListedIdentitySurfaces,
  IDENTITY_SURFACE_RECHECK_MS,
  recheckListedIdentitySurface,
  rememberListedIdentitySurface,
  resolveIdentityToolSurface,
  type IdentitySurfaceDeps,
} from './identity-tool-surface';

const CLASS = 'crm.email@1.0.0';
const pin: ResolvedCapabilityProviderInput = {
  kind: 'capability-provider', ref: CLASS, providerPackage: 'mail-provider', providerVersion: '1.0.0',
  conformanceRunId: 'run-a', registryRevision: 'registry-a', verbBindings: { send: 'mail:send' },
};
const ctx = {
  workspaceId: 'ws-a', uiClientId: 'su-surface', isSuperuser: true,
  log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
} as unknown as UnifiedToolContext;
const candidates = [
  { name: 'coord:orient', capabilities: ['coord:read'] },
  { name: 'mail:send', capabilities: ['mail:send'] },
  { name: 'other:send', capabilities: ['mail:send'] },
  { name: 'tools:invoke', capabilities: [] },
];
const policy: IdentityGrantPolicy = {
  policyRevision: 'policy-a', potSlug: 'sales', ceilings: [{ allowCapabilities: ['mail:send', 'coord:read'] }],
  protectedAdditions: [],
  tools: new Map(candidates.map((candidate) => [candidate.name, candidate.capabilities])),
  bindings: [{
    classRef: CLASS, providerPackage: pin.providerPackage, providerVersion: pin.providerVersion,
    conformanceRunId: pin.conformanceRunId, registryRevision: pin.registryRevision, verbBindings: pin.verbBindings,
    status: 'active', conformanceStatus: 'passed', behavioralStatus: 'not-required', behavioralRunRef: null,
    potSlug: 'sales', boundBy: 'admin', boundAt: '2026-09-13', updatedAt: '2026-09-13',
  }],
};

let session = 0;
function stateFor(grants: { requires: string[] } | undefined, opts: { staleApplied?: boolean; generation?: number } = {}) {
  const artifact = compileAgentSpecification({
    source: {
      id: 'surface', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
      ...(grants ? { grants } : {}),
    },
    prompt: { role: 'worker', text: 'Use mail.' }, inputClosure: [pin],
  });
  const applied = {
    specificationRevision: opts.staleApplied ? 'f'.repeat(64) : artifact.specificationRevision,
    stateRevision: 'state-a',
  };
  session += 1;
  return {
    activation: { applied },
    identityLaunchRecord: {
      workspaceId: 'ws-a', harnessSlug: 'sales',
      specificationRevision: artifact.specificationRevision, stateRevision: 'state-a', specificationArtifact: artifact,
    },
    identityLaunchRecordVersion: { sessionId: `surface-${session}`, rowVersion: '1' },
    controlGeneration: opts.generation ?? 1,
  };
}

function deps(state: unknown, readPolicy = vi.fn(async () => policy)): IdentitySurfaceDeps {
  return {
    readState: vi.fn(async () => state as never),
    readPolicy,
    check: checkIdentityGrantKernel,
  };
}

beforeEach(() => __resetListedIdentitySurfaces());

describe('P-012 / D-040(b): a governed wearer sees what the kernel admits', () => {
  it('lists exactly the class-granted tool, whatever the seed held, with one policy read', async () => {
    const readPolicy = vi.fn(async () => policy);
    const surface = await resolveIdentityToolSurface(ctx, candidates, deps(stateFor({ requires: [CLASS] }), readPolicy));
    expect(surface.kind).toBe('governed');
    // tools:invoke and tools:find are not granted, so the wearer cannot reach
    // the class tool through them: it must be listed directly.
    expect(surface.kind === 'governed' && [...surface.admitted]).toEqual(['mail:send']);
    expect(readPolicy).toHaveBeenCalledTimes(1);
    for (const candidate of candidates) {
      const verdict = await checkIdentityGrantKernel(
        { phase: 'enforce', boundary: 'dispatch', toolName: candidate.name, capabilities: candidate.capabilities,
          args: {}, ctx },
        stateFor({ requires: [CLASS] }), stateFor({ requires: [CLASS] }).identityLaunchRecord, async () => policy);
      expect(verdict?.decision === 'allow').toBe(surface.kind === 'governed' && surface.admitted.has(candidate.name));
    }
  });

  it('separates the one-time authority and policy reads from candidate evaluation timings', async () => {
    const phases = createPhaseTracker();
    const readPolicy = vi.fn(async () => policy);

    const surface = await resolveIdentityToolSurface(
      ctx, candidates, deps(stateFor({ requires: [CLASS] }), readPolicy), undefined, phases,
    );

    expect(surface.kind).toBe('governed');
    expect(readPolicy).toHaveBeenCalledTimes(1);
    expect(phases.intervals().map((phase) => phase.phase)).toEqual([
      'identitySurface.controlState',
      'identitySurface.grantPolicy',
      'identitySurface.firstCandidate',
      'identitySurface.remainingCandidates',
    ]);
  });

  it('expands an accepted operation receipt before the same identity-kernel listing gate', async () => {
    const state = stateFor({ requires: [] });
    const record = state.identityLaunchRecord as Record<string, unknown>;
    const revision = record.specificationRevision as string;
    record.acceptedOperation = {
      kind: 'blueprint-operation-worker',
      workItemId: 'WI-1',
      operationId: 'prep',
      specificationRevision: revision,
      requiredTools: ['work_items:claim', 'work_items:checkpoint', 'plans:set-status'],
      pin: {
        kind: 'blueprint-operation',
        harnessSlug: 'sales',
        operationId: 'prep',
        specificationRevision: revision,
        operationVersion: '1.0.0',
        input: {},
      },
    };
    const operationCandidates = [
      { name: 'work_items:claim', capabilities: ['work_items:write'] },
      { name: 'work_items:checkpoint', capabilities: ['work_items:write'] },
      { name: 'plans:set-status', capabilities: ['plans:write'] },
      { name: 'coord:send', capabilities: ['coord:write'] },
    ];
    const operationPolicy: IdentityGrantPolicy = {
      ...policy,
      ceilings: [{}, { allowCapabilities: ['work_items:read', 'work_items:write'] }],
      tools: new Map(operationCandidates.map((candidate) => [candidate.name, candidate.capabilities])),
    };
    const expand = vi.fn((identityLaunchRecord: unknown) => {
      const accepted = (identityLaunchRecord as { acceptedOperation?: { requiredTools?: unknown } })
        .acceptedOperation;
      const requiredTools = accepted?.requiredTools;
      if (!Array.isArray(requiredTools)) return [];
      return operationCandidates.filter((candidate) => requiredTools.includes(candidate.name));
    });

    const surface = await resolveIdentityToolSurface(ctx, [], deps(state, vi.fn(async () => operationPolicy)), expand);

    expect(surface.kind).toBe('governed');
    expect(expand).toHaveBeenCalledWith(record);
    expect(surface.kind === 'governed' && [...surface.admitted])
      .toEqual(['work_items:claim', 'work_items:checkpoint']);
    expect(surface.kind === 'governed' && surface.admitted.has('coord:send')).toBe(false);
    expect(surface.kind === 'governed' && surface.admitted.has('plans:set-status')).toBe(false);
  });

  it('leaves an ungoverned session unnarrowed', async () => {
    expect(await resolveIdentityToolSurface(ctx, candidates, deps(stateFor(undefined))))
      .toMatchObject({ kind: 'ungoverned' });
    expect(await resolveIdentityToolSurface(ctx, candidates, deps({ controlGeneration: 3 })))
      .toMatchObject({ kind: 'ungoverned' });
    expect(await resolveIdentityToolSurface(ctx, candidates, deps(null)))
      .toMatchObject({ kind: 'ungoverned' });
  });

  it('does not narrow an unresolved identity to the recovery door', async () => {
    expect(await resolveIdentityToolSurface(ctx, candidates, deps(stateFor({ requires: [CLASS] }, { staleApplied: true }))))
      .toMatchObject({ kind: 'unresolved' });
    const failing = vi.fn(async (): Promise<IdentityGrantPolicy> => { throw new Error('policy store down'); });
    expect(await resolveIdentityToolSurface(ctx, candidates, deps(stateFor({ requires: [CLASS] }), failing)))
      .toMatchObject({ kind: 'unresolved' });
    const unreadable: IdentitySurfaceDeps = { ...deps(null), readState: async () => { throw new Error('pg down'); } };
    expect(await resolveIdentityToolSurface(ctx, candidates, unreadable)).toEqual({ kind: 'unresolved', key: null });
  });
});

describe('P-012 / D-040(c): an attach re-announces the surface', () => {
  it('fires list_changed exactly once when the applied identity changes the admitted set', async () => {
    const ungoverned = stateFor(undefined);
    const initial = await resolveIdentityToolSurface(ctx, candidates, deps(ungoverned));
    rememberListedIdentitySurface('mcp-1', { ctx, candidates, surface: initial }, 0);
    const notify = vi.fn(async () => {});

    expect(await recheckListedIdentitySurface('mcp-1', notify, 1_000, deps(ungoverned))).toBe('throttled');
    expect(await recheckListedIdentitySurface('mcp-1', notify, IDENTITY_SURFACE_RECHECK_MS, deps(ungoverned)))
      .toBe('unchanged');

    const attached = stateFor({ requires: [CLASS] }, { generation: 2 });
    expect(await recheckListedIdentitySurface('mcp-1', notify, 2 * IDENTITY_SURFACE_RECHECK_MS, deps(attached)))
      .toBe('notified');
    expect(await recheckListedIdentitySurface('mcp-1', notify, 3 * IDENTITY_SURFACE_RECHECK_MS, deps(attached)))
      .toBe('unchanged');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await recheckListedIdentitySurface('mcp-never-listed', notify, 0, deps(attached))).toBe('unlisted');
  });

  it('stays quiet when the key moves but the admitted set does not', async () => {
    const governed = stateFor({ requires: [CLASS] });
    const initial = await resolveIdentityToolSurface(ctx, candidates, deps(governed));
    rememberListedIdentitySurface('mcp-2', { ctx, candidates, surface: initial }, 0);
    const notify = vi.fn(async () => {});
    expect(await recheckListedIdentitySurface('mcp-2', notify, IDENTITY_SURFACE_RECHECK_MS,
      deps({ ...governed, controlGeneration: 9 }))).toBe('unchanged');
    expect(notify).not.toHaveBeenCalled();
  });
});
