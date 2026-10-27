import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { pinModuleState } from '@papercusp/module-singleton';
import { compileAgentSpecification, replayAgentSpecification, type ResolvedCapabilityProviderInput } from '@papercusp/orchestrator/blueprint';
import type { KernelEnforcementRequest } from '@papercusp/agent-mcp';
import { appliedIdentityArtifact, appliedOrCurrentIdentityArtifact, checkIdentityGrantKernel as checkCurrentIdentityGrantKernel, launchRecordAdmitsApplied, resolveIdentityArtifact, IDENTITY_BREAK_GLASS, IDENTITY_RESOLUTION_CACHE_MAX, IDENTITY_RESOLUTION_CACHE_TTL_MS, readIdentityGrantPolicy, readIdentityReactionCeiling, validateIdentityInstallGrants, type IdentityGrantPolicy } from './identity-grants-port';
import type { CapabilityGrantResolutionVerdict } from '../cupboard/capability-grant-resolver';
import { identityRefusalContract } from './identity-refusal-contract';
import { isLazyIdentityLaunchRecord, lazyIdentityLaunchRecord } from './lazy-launch-record';
import { carryIdentityReceiptForControlActivation, type SuLaunchSpecRecord } from '../su-persona-render';

// Reuse the standard copy-out probe for the runtime authority checks.
const checkIdentityGrantKernel: typeof checkCurrentIdentityGrantKernel = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
  ? (await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)).checkIdentityGrantKernel
  : checkCurrentIdentityGrantKernel;

const io = vi.hoisted(() => ({
  state: vi.fn(), binding: vi.fn(), load: vi.fn(), source: vi.fn(), flag: vi.fn(), tools: vi.fn(), replay: vi.fn(),
}));
vi.mock('../operator-state-pg', async (original) => ({
  ...(await original<typeof import('../operator-state-pg')>()), readOperatorState: io.state,
}));
vi.mock('../capability-class-registry-store', async (original) => ({
  ...(await original<typeof import('../capability-class-registry-store')>()), getPotCapabilityProviderBinding: io.binding,
}));
vi.mock('@papercusp/orchestrator/blueprint', async (original) => {
  const actual = await original<typeof import('@papercusp/orchestrator/blueprint')>();
  return {
    ...actual,
    loadBlueprintFromFile: io.load,
    layerSourceDocument: io.source,
    replayAgentSpecification: (value: unknown) => {
      io.replay(value);
      return actual.replayAgentSpecification(value);
    },
  };
});
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
function fixture(grants: { requires?: string[]; optional?: string[] } | undefined = { requires: [CLASS] }) {
  const artifact = compileAgentSpecification({
    source: {
      id: 'grant-port', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } },
      ...(grants ? { grants } : {}),
    },
    prompt: { role: 'worker', text: 'Use mail.' }, inputClosure: [pin],
  });
  const applied = { specificationRevision: artifact.specificationRevision, stateRevision: 'state-a' };
  const record = { workspaceId: 'ws-a', harnessSlug: 'sales', ...applied, specificationArtifact: artifact };
  const state = { activation: { applied }, policyRevision: 'control:1' };
  const policy: IdentityGrantPolicy = {
    policyRevision: 'policy-a', potSlug: 'sales', ceilings: [{ allowCapabilities: ['mail:send'] }],
    protectedAdditions: [], tools: new Map([['mail:send', ['mail:send']], ['other:send', ['mail:send']]]),
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

describe('P-005 current identity grants at the common kernel seat', () => {
  it.each(['dispatch', 'indirect-dispatch', 'native'] as const)(
    'intersects a pinned operation tool set at the %s boundary',
    async (boundary) => {
      const f = fixture();
      const read = vi.fn(async () => f.policy);
      const acceptedOperation = {
        kind: 'blueprint-operation-worker', workItemId: 'WI-1',
        operationId: 'send', specificationRevision: 'a'.repeat(64), requiredTools: ['mail:send'],
        pin: { kind: 'blueprint-operation', harnessSlug: 'sales', operationId: 'send',
          specificationRevision: 'a'.repeat(64), operationVersion: '1.0.0', input: {} },
      };
      const record = { ...f.record, acceptedOperation };
      const request = { ...f.request, boundary };
      expect(await checkIdentityGrantKernel(request, f.state, record, read, async () => true))
        .toMatchObject({ decision: 'allow', applied: true });
      expect(await checkIdentityGrantKernel(request, f.state, record, read, async () => false))
        .toMatchObject({ decision: 'deny', code: 'operation-claim-stale' });
      expect(await checkIdentityGrantKernel(request, f.state,
        { ...record, acceptedOperation: { ...acceptedOperation, requiredTools: [] } }, read))
        .toMatchObject({ decision: 'deny', obligations: {
          capabilityUnsatisfied: { cause: 'outside-ceiling', toolName: 'mail:send' },
        } });
      expect(await checkIdentityGrantKernel(request, f.state,
        { ...record, acceptedOperation: { ...acceptedOperation, requiredTools: 'mail:send' } }, read))
        .toMatchObject({ decision: 'deny', obligations: {
          capabilityUnsatisfied: { cause: 'outside-ceiling' },
        } });
    },
  );

  it('admits only the declared hook continuation door without widening the operation receipt', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    const readClaim = vi.fn(async () => false);
    const acceptedOperation = {
      kind: 'blueprint-operation-worker', workItemId: 'WI-1',
      operationId: 'send', specificationRevision: 'a'.repeat(64), requiredTools: ['mail:send'],
      pin: { kind: 'blueprint-operation', harnessSlug: 'sales', operationId: 'send',
        specificationRevision: 'a'.repeat(64), operationVersion: '1.0.0', input: {} },
    };
    const record = { ...f.record, acceptedOperation };
    const door = { ...f.request, toolName: 'sessions:continue-released-operation',
      capabilities: ['capability:terminal'] };
    const hook = { ...door, ctx: { ...door.ctx,
      requestOrigin: { transport: 'mcp' as const, query: { origin: 'hook' } } } };
    const model = { ...door, ctx: { ...door.ctx,
      requestOrigin: { transport: 'mcp' as const, query: { origin: 'agent' } } } };

    expect(await checkIdentityGrantKernel(hook, f.state, record, read, readClaim))
      .toMatchObject({ decision: 'allow', applied: true });
    expect(readClaim).not.toHaveBeenCalled();
    expect(await checkIdentityGrantKernel(model, f.state, record, read, readClaim))
      .toMatchObject({ decision: 'deny', obligations: {
        capabilityUnsatisfied: { cause: 'outside-ceiling', toolName: 'sessions:continue-released-operation' },
      } });
  });

  it('authorizes a deny-all worker identity\'s PLATFORM requiredTools under the role ceiling, and nothing else (WI-10007010)', async () => {
    // The blueprint-operation-worker identity grants no class, so the grant envelope
    // reaches nothing; before WI-10007010 every required platform tool was refused.
    const f = fixture({ requires: [], optional: [] });
    const policy: IdentityGrantPolicy = {
      ...f.policy,
      ceilings: [{}, { allowCapabilities: ['work_items:read', 'work_items:write', 'memory:read', 'coord:write', 'mail:send'] }],
      tools: new Map([
        ...f.policy.tools,
        ['work_items:claim', ['work_items:write']],
        ['work_items:checkpoint', ['work_items:write']],
        ['plans:set-status', ['plans:write']],
        ['coord:send', ['coord:write']],
      ]),
    };
    const read = vi.fn(async () => policy);
    const acceptedOperation = {
      kind: 'blueprint-operation-worker', workItemId: 'WI-1',
      operationId: 'prep', specificationRevision: 'b'.repeat(64),
      requiredTools: ['mail:send', 'plans:set-status', 'work_items:checkpoint', 'work_items:claim'],
      pin: { kind: 'blueprint-operation', harnessSlug: 'sales', operationId: 'prep',
        specificationRevision: 'b'.repeat(64), operationVersion: '1.0.0', input: {} },
    };
    const record = { ...f.record, acceptedOperation };
    const call = (toolName: string, capabilities: string[], claimed = true) => checkIdentityGrantKernel(
      { ...f.request, toolName, capabilities }, f.state, record, read, async () => claimed);
    const refused = (toolName: string) => ({ decision: 'deny',
      obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling', toolName } } });

    // Required platform tools inside the role ceiling: the claim door, then a claimed write.
    expect(await call('work_items:claim', ['work_items:write'])).toMatchObject({ decision: 'allow', applied: true });
    expect(await call('work_items:checkpoint', ['work_items:write'])).toMatchObject({ decision: 'allow', applied: true });
    // The receipt's live-claim rule still binds the platform path.
    expect(await call('work_items:checkpoint', ['work_items:write'], false))
      .toMatchObject({ decision: 'deny', code: 'operation-claim-stale' });
    // Required, but outside the role ceiling.
    expect(await call('plans:set-status', ['plans:write'])).toMatchObject(refused('plans:set-status'));
    // Inside the role ceiling, but not required by the operation.
    expect(await call('coord:send', ['coord:write'])).toMatchObject(refused('coord:send'));
    // Required and inside the ceiling, but provider-reachable: it still needs a grant.
    expect(await call('mail:send', ['mail:send'])).toMatchObject(refused('mail:send'));
  });

  it.each(['dispatch', 'indirect-dispatch', 'reaction', 'native', 'shell'] as const)(
    'denies tools outside the exact provider set at %s, including superusers',
    async (boundary) => {
      const f = fixture();
      const read = vi.fn(async () => f.policy);
      expect(await checkIdentityGrantKernel({ ...f.request, boundary, toolName: 'other:send' }, f.state, f.record, read))
        .toMatchObject({ decision: 'deny', code: 'capability_unsatisfied',
          obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling', classRef: CLASS } } });
    },
  );

  it('re-reads policy and refuses a revocation between preflight and execution', async () => {
    const f = fixture();
    const read = vi.fn().mockResolvedValueOnce(f.policy)
      .mockResolvedValueOnce({ ...f.policy, policyRevision: 'policy-b', bindings: [] });
    expect(await checkIdentityGrantKernel({ ...f.request, phase: 'preflight' }, f.state, f.record, read))
      .toMatchObject({ decision: 'allow', executionRevision: f.applied, policyRevision: 'policy-a' });
    expect(await checkIdentityGrantKernel(f.request, f.state, f.record, read))
      .toMatchObject({ decision: 'deny', policyRevision: 'policy-b',
        obligations: { capabilityUnsatisfied: { cause: 'provider-unbound' } } });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reuses a validated launch row while applying a changed administrator policy on the next call', async () => {
    const f = fixture();
    const state = { ...f.state, identityLaunchRecordVersion: { sessionId: 'cache-policy-test', rowVersion: '41' } };
    const read = vi.fn().mockResolvedValueOnce(f.policy)
      .mockResolvedValueOnce({ ...f.policy, policyRevision: 'policy-b', bindings: [] });

    expect(await checkIdentityGrantKernel(f.request, state, f.record, read))
      .toMatchObject({ decision: 'allow', policyRevision: 'policy-a' });
    const replayCount = io.replay.mock.calls.length;
    expect(replayCount).toBeGreaterThan(0);

    expect(await checkIdentityGrantKernel(f.request, state, f.record, read))
      .toMatchObject({ decision: 'deny', policyRevision: 'policy-b',
        obligations: { capabilityUnsatisfied: { cause: 'provider-unbound' } } });
    expect(io.replay).toHaveBeenCalledTimes(replayCount);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('bounds the pinned identity replay cache and replays an evicted row', async () => {
    expect(IDENTITY_RESOLUTION_CACHE_MAX).toBe(128);
    const cache = pinModuleState('@papercusp/operator-core.identity-resolution-cache',
      () => new Map<string, { validatedAt: number; resolution: unknown }>());
    cache.clear();
    try {
      const f = fixture();
      const read = vi.fn(async () => f.policy);
      const stateFor = (rowVersion: string) => ({
        ...f.state, identityLaunchRecordVersion: { sessionId: 'cache-size-test', rowVersion },
      });

      expect(await checkIdentityGrantKernel(f.request, stateFor('0'), f.record, read))
        .toMatchObject({ decision: 'allow' });
      const firstReplayCount = io.replay.mock.calls.length;
      expect(firstReplayCount).toBeGreaterThan(0);

      for (let index = 1; index <= IDENTITY_RESOLUTION_CACHE_MAX; index += 1) {
        expect(await checkIdentityGrantKernel(f.request, stateFor(String(index)), f.record, read))
          .toMatchObject({ decision: 'allow' });
      }
      expect(cache.size).toBeLessThanOrEqual(IDENTITY_RESOLUTION_CACHE_MAX);
      const replayCountAfterEviction = io.replay.mock.calls.length;
      expect(await checkIdentityGrantKernel(f.request, stateFor('0'), f.record, read))
        .toMatchObject({ decision: 'allow' });
      expect(io.replay.mock.calls.length).toBeGreaterThan(replayCountAfterEviction);
    } finally {
      cache.clear();
    }
  });

  it('replays an unchanged launch row after the identity cache age bound', async () => {
    expect(IDENTITY_RESOLUTION_CACHE_TTL_MS).toBe(5 * 60_000);
    const cache = pinModuleState('@papercusp/operator-core.identity-resolution-cache',
      () => new Map<string, { validatedAt: number; resolution: unknown }>());
    cache.clear();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const f = fixture();
      const state = { ...f.state, identityLaunchRecordVersion: { sessionId: 'cache-ttl-test', rowVersion: '1' } };
      const read = vi.fn(async () => f.policy);

      expect(await checkIdentityGrantKernel(f.request, state, f.record, read))
        .toMatchObject({ decision: 'allow' });
      const firstReplayCount = io.replay.mock.calls.length;
      expect(firstReplayCount).toBeGreaterThan(0);
      expect(await checkIdentityGrantKernel(f.request, state, f.record, read))
        .toMatchObject({ decision: 'allow' });
      expect(io.replay).toHaveBeenCalledTimes(firstReplayCount);

      vi.advanceTimersByTime(IDENTITY_RESOLUTION_CACHE_TTL_MS + 1);
      expect(await checkIdentityGrantKernel(f.request, state, f.record, read))
        .toMatchObject({ decision: 'allow' });
      expect(io.replay.mock.calls.length).toBeGreaterThan(firstReplayCount);
    } finally {
      vi.useRealTimers();
      cache.clear();
    }
  });

  it('revalidates on a launch-row or applied-revision change and denies a tampered artifact', async () => {
    const f = fixture();
    const state = { ...f.state, identityLaunchRecordVersion: { sessionId: 'cache-invalidation-test', rowVersion: '51' } };
    const read = vi.fn(async () => f.policy);

    expect(await checkIdentityGrantKernel(f.request, state, f.record, read))
      .toMatchObject({ decision: 'allow' });
    const firstReplayCount = io.replay.mock.calls.length;

    const changedApplied = { ...f.applied, stateRevision: 'state-b' };
    expect(await checkIdentityGrantKernel(f.request, {
      ...state, activation: { applied: changedApplied },
    }, f.record, read)).toMatchObject({ decision: 'allow' });
    expect(io.replay.mock.calls.length).toBeGreaterThan(firstReplayCount);
    const secondReplayCount = io.replay.mock.calls.length;

    const tampered = { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } };
    expect(await checkIdentityGrantKernel(f.request, {
      ...state, identityLaunchRecordVersion: { sessionId: 'cache-invalidation-test', rowVersion: '52' },
    }, tampered, read)).toMatchObject({ decision: 'deny',
      obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
    expect(io.replay.mock.calls.length).toBeGreaterThan(secondReplayCount);
  });

  // WI-10002721: the live resolver hands the gate a header + loader instead of
  // the launch record body. The header must reproduce the cache key the full
  // record produces, or every lazy preflight would miss and read the body.
  describe('lazy launch record (WI-10002721)', () => {
    const lazyFor = (record: Record<string, unknown>, rowVersion: string, isObject = true) => {
      const load = vi.fn(async () => ({ record, rowVersion }));
      return {
        load,
        handle: lazyIdentityLaunchRecord({
          isObject, workspaceId: record.workspaceId, harnessSlug: record.harnessSlug,
          hasAcceptedOperation: Object.prototype.hasOwnProperty.call(record, 'acceptedOperation'),
          acceptedOperation: record.acceptedOperation ?? null, load,
        }),
      };
    };

    it('loads the body on a miss and answers the repeat preflight without loading it', async () => {
      const f = fixture();
      const state = { ...f.state, identityLaunchRecordVersion: { sessionId: 'lazy-hit-test', rowVersion: '61' } };
      const read = vi.fn(async () => f.policy);
      const { handle, load } = lazyFor(f.record, '61');

      expect(await checkIdentityGrantKernel(f.request, state, handle, read)).toMatchObject({ decision: 'allow' });
      expect(load).toHaveBeenCalledTimes(1);
      const replayCount = io.replay.mock.calls.length;
      expect(await checkIdentityGrantKernel({ ...f.request, toolName: 'other:send' }, state, handle, read))
        .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling' } } });
      expect(load).toHaveBeenCalledTimes(1);
      expect(io.replay).toHaveBeenCalledTimes(replayCount);
      // Policy is still re-read on every call; only the artifact replay is cached.
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('enforces the accepted operation tool ceiling on a cached repeat call', async () => {
      const f = fixture();
      const read = vi.fn(async () => f.policy);
      const acceptedOperation = {
        kind: 'blueprint-operation-worker', workItemId: 'WI-1',
        operationId: 'send', specificationRevision: 'a'.repeat(64), requiredTools: ['mail:send'],
        pin: { kind: 'blueprint-operation', harnessSlug: 'sales', operationId: 'send',
          specificationRevision: 'a'.repeat(64), operationVersion: '1.0.0', input: {} },
      };
      const record = { ...f.record, acceptedOperation };
      const state = { ...f.state, identityLaunchRecordVersion: { sessionId: 'operation-header-test', rowVersion: '67' } };
      const { handle, load } = lazyFor(record, '67');
      expect(await checkIdentityGrantKernel(f.request, state, handle, read, async () => true)).toMatchObject({ decision: 'allow' });
      expect(await checkIdentityGrantKernel(f.request, state, handle, read, async () => true)).toMatchObject({ decision: 'allow' });
      expect(load).toHaveBeenCalledTimes(1);

      const narrowed = lazyFor({ ...record, acceptedOperation: { ...acceptedOperation, requiredTools: [] } }, '68');
      const narrowedState = { ...state, identityLaunchRecordVersion: { sessionId: 'operation-header-test', rowVersion: '68' } };
      expect(await checkIdentityGrantKernel(f.request, narrowedState, narrowed.handle, read))
        .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling' } } });
      expect(await checkIdentityGrantKernel(f.request, narrowedState, narrowed.handle, read))
        .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling' } } });
      expect(narrowed.load).toHaveBeenCalledTimes(1);
    });

    it('audits the exact adv_sessions xmin returned with the lazily loaded record', async () => {
      const f = fixture();
      const state = {
        ...f.state,
        identityLaunchRecordVersion: { sessionId: 'audit-row-id-test', rowVersion: 'header-xmin' },
      };
      const read = vi.fn(async () => f.policy);
      const { handle, load } = lazyFor(f.record, 'loaded-xmin');

      expect(await checkIdentityGrantKernel(f.request, state, handle, read)).toMatchObject({
        decision: 'allow',
        serverAudit: { identityLaunchRecord: { advSessionId: 'audit-row-id-test', xmin: 'loaded-xmin' } },
      });
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('derives the same cache key from the header as from the full record', async () => {
      const f = fixture();
      const state = { ...f.state, identityLaunchRecordVersion: { sessionId: 'lazy-key-test', rowVersion: '62' } };
      const read = vi.fn(async () => f.policy);
      expect(await checkIdentityGrantKernel(f.request, state, f.record, read)).toMatchObject({ decision: 'allow' });
      const { handle, load } = lazyFor(f.record, '62');
      expect(await checkIdentityGrantKernel(f.request, state, handle, read)).toMatchObject({ decision: 'allow' });
      expect(load).not.toHaveBeenCalled();
    });

    it('caches a miss under the row version the body was read at', async () => {
      const f = fixture();
      const read = vi.fn(async () => f.policy);
      const { handle, load } = lazyFor(f.record, '64');
      const at = (rowVersion: string) => ({
        ...f.state, identityLaunchRecordVersion: { sessionId: 'lazy-version-test', rowVersion },
      });
      await checkIdentityGrantKernel(f.request, at('63'), handle, read);
      expect(load).toHaveBeenCalledTimes(1);
      await checkIdentityGrantKernel(f.request, at('64'), handle, read);
      expect(load).toHaveBeenCalledTimes(1);
      await checkIdentityGrantKernel(f.request, at('63'), handle, read);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('takes the no-record branch for a non-object header without loading the body', async () => {
      const f = fixture();
      const { handle, load } = lazyFor(f.record, '65', false);
      expect(await checkIdentityGrantKernel(f.request, f.state, handle, vi.fn()))
        .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
      expect(load).not.toHaveBeenCalled();
      // Unacknowledged (no applied receipt) stays the legacy, ungoverned path.
      expect(await checkIdentityGrantKernel(f.request, {}, handle, vi.fn())).toBeNull();
    });

    it('refuses a body that is gone or no longer an object at load time', async () => {
      const f = fixture();
      const state = { ...f.state, identityLaunchRecordVersion: { sessionId: 'lazy-gone-test', rowVersion: '66' } };
      for (const loaded of [null, { record: null, rowVersion: '66' }, { record: ['x'], rowVersion: '66' }]) {
        const handle = lazyIdentityLaunchRecord({
          isObject: true, workspaceId: 'ws-a', harnessSlug: 'sales',
          hasAcceptedOperation: false, acceptedOperation: null, load: async () => loaded,
        });
        expect(await checkIdentityGrantKernel(f.request, state, handle, vi.fn()))
          .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
      }
    });

    it('never mistakes a stored JSON record for the handle', () => {
      expect(isLazyIdentityLaunchRecord(JSON.parse(JSON.stringify(lazyFor(fixture().record, '1').handle)))).toBe(false);
      expect(isLazyIdentityLaunchRecord(fixture().record)).toBe(false);
      expect(isLazyIdentityLaunchRecord(lazyFor(fixture().record, '1').handle)).toBe(true);
    });
  });

  it('selects the exact applied history receipt, not the current desired artifact', () => {
    const f = fixture();
    const newer = fixture({ requires: [] });
    const record = { ...newer.record, stateRevision: 'state-b', identityHistory: [f.record] };
    expect(appliedIdentityArtifact(record, f.applied)).toEqual(f.artifact);
    expect(appliedIdentityArtifact(record, { ...f.applied, stateRevision: 'wrong' })).toBeNull();
  });

  // P-009 (EI-23431478594488191): the WRITER's output must satisfy THIS reader's
  // exact-match lookup on its own, without the control-only fallback below. A
  // receipt the writer considers well-formed but that this selection rejects
  // would leave the denial in place while looking fixed at the write site.
  it('selects a receipt carried forward by a control-source activation', () => {
    const f = fixture();
    const advanced = { specificationRevision: f.applied.specificationRevision, stateRevision: 'state-b' };

    expect(appliedIdentityArtifact(f.record, advanced)).toBeNull();

    const identityHistory = carryIdentityReceiptForControlActivation(
      f.record as unknown as SuLaunchSpecRecord, advanced,
    );
    expect(identityHistory).not.toBeNull();

    expect(appliedIdentityArtifact({ ...f.record, identityHistory }, advanced)).toEqual(f.artifact);
    // The launch pair keeps resolving; carrying a receipt never displaces one.
    expect(appliedIdentityArtifact({ ...f.record, identityHistory }, f.applied)).toEqual(f.artifact);
  });

  it('accepts a control-only state-revision advance when the applied specification is unchanged', async () => {
    // EI-23431478594488191: a mode re-registration advances activation.applied
    // to a new stateRevision without re-rendering launch_spec, so no receipt
    // can carry it. Same specification ⇒ same grants ⇒ the current artifact is
    // the applied one; the session must not be stranded.
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    const applied = { ...f.applied, stateRevision: 'state-b' };
    const state = { activation: { applied, status: 'applied' as const }, policyRevision: 'control:2' };
    expect(await checkIdentityGrantKernel(f.request, state, f.record, read))
      .toMatchObject({ decision: 'allow', revisionSource: 'applied' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('still fails closed on a broadening, whatever phase the pending activation is in', async () => {
    // The conjunct that enforces fail-closed is SPECIFICATION equality, not the
    // activation status. A pending broadening carries a different
    // specificationRevision, so it must be refused in EVERY phase — including
    // 'applied', which is the only phase this previously covered.
    const narrow = fixture({ requires: [] });
    const broad = fixture();
    for (const status of ['desired', 'prepared', 'failed', 'applied'] as const) {
      expect(await checkIdentityGrantKernel(
        broad.request, { activation: { applied: { ...narrow.applied, stateRevision: 'state-b' }, status } },
        broad.record, async () => broad.policy,
      )).toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
    }
  });

  // WI-10002005: a pending activation is a request about FUTURE authority and
  // must never retract authority the host already acknowledged. `applied` is
  // written only by acknowledgement, so a non-null `applied` is acknowledged
  // truth by construction; `status` describes the in-flight transition, not the
  // validity of that receipt. Conflating the two produced a TOTAL, self-sealing
  // denial: a 'relaunch-with-carry' stack mutation makes turn-start skip both
  // markControlTransitionPrepared and acknowledgeControlTransition, leaving
  // prepared:null/status:'desired' with no throw and no failure record, while
  // acknowledgeControlTransition's WHERE clause requires prepared = desired — so
  // the row can never converge and every tool is refused for the life of the
  // session, including the coord:orient recovery door.
  it('does not retract acknowledged authority while an activation is pending', async () => {
    const f = fixture();
    const applied = { ...f.applied, stateRevision: 'state-b' };
    for (const status of ['desired', 'prepared', 'failed'] as const) {
      const read = vi.fn(async () => f.policy);
      expect(await checkIdentityGrantKernel(
        f.request,
        // prepared:null is the exact shape the requiresFreshContext branch leaves behind.
        { activation: { applied, prepared: null, status }, policyRevision: 'control:2' },
        f.record, read,
      )).toMatchObject({ decision: 'allow', revisionSource: 'applied' });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it('applies a pending narrowing immediately without attributing it as applied', async () => {
    const f = fixture();
    const narrowed = fixture({ requires: [] });
    const record = { ...narrowed.record, stateRevision: 'state-b', identityHistory: [f.record] };
    expect(await checkIdentityGrantKernel(f.request, f.state, record, async () => f.policy))
      .toMatchObject({ decision: 'deny', code: 'capability_unsatisfied' });
  });

  // WI-10001769 / identities-v1 R-3 `authority-reduction-fails-closed`: a FAILED
  // reduction must bind the NARROWER authority, never retain the wider one.
  // identity-management writes the narrowed specificationArtifact into the
  // launch record in the SAME transaction that requests the activation, before
  // any render; a later render failure (failControlTransitionActivation) leaves
  // `applied` on the wider revision with prepared:null/status:'failed'. The
  // kernel checks the applied receipt AND the record's current specification,
  // so the narrowing binds in every pending phase — including the exact row
  // shape the failure writer leaves behind.
  it('binds a failed authority reduction to the narrower specification instead of retaining the wider one', async () => {
    const wide = fixture();
    const narrowed = fixture({ requires: [] });
    // Positive control: the wide receipt on its own authorises the tool.
    expect(await checkIdentityGrantKernel(wide.request, wide.state, wide.record, async () => wide.policy))
      .toMatchObject({ decision: 'allow', revisionSource: 'applied' });
    const record = { ...narrowed.record, stateRevision: 'state-b', identityHistory: [wide.record] };
    for (const status of ['desired', 'prepared', 'failed'] as const) {
      const state = {
        activation: {
          applied: wide.applied, prepared: null, status,
          ...(status === 'failed' ? { failure: 'stack transition render failed' } : {}),
        },
        policyRevision: 'control:2',
      };
      expect(await checkIdentityGrantKernel(wide.request, state, record, async () => wide.policy))
        .toMatchObject({ decision: 'deny', code: 'capability_unsatisfied' });
    }
  });

  it('cannot widen a previously empty grant set with an unacknowledged revision', async () => {
    const f = fixture({ requires: [] });
    const broad = fixture();
    const record = { ...broad.record, stateRevision: 'state-b', identityHistory: [f.record] };
    expect(await checkIdentityGrantKernel(f.request, f.state, record, async () => broad.policy))
      .toMatchObject({ decision: 'deny' });
  });

  it('refuses missing receipts, tampered artifacts, wrong workspace and unavailable policy', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    for (const record of [
      null,
      // Tampering that rewrites the SPECIFICATION is caught independently of any
      // activation phase, by the replay/record specificationRevision comparison.
      { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } },
      { ...f.record, workspaceId: 'other' },
    ]) {
      expect(await checkIdentityGrantKernel(f.request, f.state, record, read)).toMatchObject({ decision: 'deny' });
    }
    expect(read).not.toHaveBeenCalled();

    // A record whose STATE revision alone disagrees is NOT refused, and must not
    // be: EI-23431478594488191's fallback exists precisely because a control-only
    // state advance can never be carried by a receipt. It is gated on
    // specification equality, so the authority granted is byte-identical to the
    // acknowledged one — a mismatch here is not a broadening and never was
    // load-bearing for tamper resistance. Asserting deny here only ever held
    // because this fixture's state carries no `status` field (WI-10002005).
    expect(await checkIdentityGrantKernel(
      f.request, f.state, { ...f.record, stateRevision: 'wrong' }, async () => f.policy,
    )).toMatchObject({ decision: 'allow', revisionSource: 'applied' });
    expect(await checkIdentityGrantKernel(f.request, f.state, f.record, async () => { throw new Error('offline'); }))
      .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'policy-unavailable' } } });
  });

  it('opens only coord:orient for an explicitly missing launch record', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    const state = { ...f.state, identityLaunchRecordMissing: true };

    expect(await checkIdentityGrantKernel({ ...f.request, toolName: 'coord:orient' }, state, null, read))
      .toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });
    expect(await checkIdentityGrantKernel(f.request, state, null, read))
      .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'no-launch-record' } } });
    expect(read).not.toHaveBeenCalled();
  });

  // A missing launch row is a FAULT only for an acknowledged identity. A session
  // that never opted in — no activation at all — is the legacy path whether or
  // not a session_briefs row exists for it, because any coord verb (and the
  // compaction watchdog's carry write) creates that row without conferring an
  // identity. Measured 2026-09-23 on a consult-expiry-sweep fork: ungoverned
  // until the watchdog force-compacted it, then denied every verb (98
  // activity:report + 84 coord:glance hook refusals in 15 min) with nothing for
  // coord:orient to converge. The wedged-identity sweep classifies this same
  // shape as NOT wedged, so the kernel must agree or the brick is silent.
  it('does not brick an unacknowledged session on a missing launch row (legacy path)', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    const unacknowledged = { policyRevision: 'control:1', identityLaunchRecordMissing: true };

    expect(await checkIdentityGrantKernel(f.request, unacknowledged, null, read)).toBeNull();
    expect(await checkIdentityGrantKernel({ ...f.request, toolName: 'coord:orient' }, unacknowledged, null, read))
      .toBeNull();
    expect(read).not.toHaveBeenCalled();

    // Control: the SAME missing row with an acknowledged receipt is still the fault.
    expect(await checkIdentityGrantKernel(f.request, { ...f.state, identityLaunchRecordMissing: true }, null, read))
      .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'no-launch-record' } } });
  });

  // WI-10002028: the recovery door must not ride the failure domain it recovers.
  // `stale-artifact` does not say "this session lacks authority for coord:orient";
  // it says "we cannot establish WHICH specification is in force". Denying the
  // resync verb on that basis is self-sealing: coord:orient({afterCompaction:true})
  // is the only caller of acknowledgeControlTransition (orient.ts), so it is the
  // one verb that can converge the activation — and the preflight was holding it
  // shut. The live consequence was a session bricked for its entire life, with
  // BOTH documented toolless fallbacks denied (scripts/mcp-call.mjs reaches the
  // same server-side preflight, so changing client/port/transport cannot help),
  // recoverable only by an undocumented sudo psql UPDATE.
  //
  // Opening it is not a widening: the door already opens with NO launch record at
  // all (the test above), which is strictly LESS identity evidence than a record
  // that replays but whose `applied` pointer is unresolved. Anyone able to tamper
  // a record into this state could equally delete it and take the weaker door, so
  // gating on artifact integrity protected nothing and bricked honest sessions.
  // Authority is unchanged either way: `applied:false` confers no grants.
  it('keeps the coord:orient recovery door open for every stale-artifact shape', async () => {
    const f = fixture();
    const stranded = fixture({ requires: [] });
    // Each entry is a distinct shape that reaches a `stale-artifact` denial.
    const shapes: Array<[string, unknown, unknown]> = [
      // `applied` names a specification no receipt in the record can produce —
      // the exact residue of a relaunch-with-carry (applied stuck on the PREVIOUS
      // session's revision while the successor runs a new one).
      ['unresolvable applied receipt', { activation: { applied: stranded.applied } }, f.record],
      // Artifact tampering: the replayed specification disagrees with the record.
      ['tampered artifact', f.state, { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } }],
      // A record that is absent without being flagged as explicitly missing.
      ['absent record', f.state, null],
    ];

    for (const [label, state, record] of shapes) {
      const read = vi.fn(async () => f.policy);
      expect(await checkIdentityGrantKernel(
        { ...f.request, toolName: 'coord:orient' }, state as never, record, read,
      ), label).toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });

      // Calibration: the SAME shape must still fail closed for an ordinary tool.
      // Without this, a blanket allow would pass the assertion above.
      expect(await checkIdentityGrantKernel(f.request, state as never, record, read), label)
        .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'stale-artifact' } } });
    }
  });

  // The door above is keyed on the tool NAME, and on the path that actually
  // bricks sessions the name never matches. A TRIMMED su surface does not carry
  // coord:orient in its seed, so the only route to the door is
  // `tools:invoke { name: 'coord:orient' }` — the gate saw `tools:invoke`, the
  // comparison failed, and the door stayed shut. Measured live 2026-09-20T10:43Z
  // by su-56d0a9bd, who had shipped the previous fix and was still bricked by
  // this on the first call of their next life ("that fix could not have saved me").
  it('opens the recovery door for the dispatch wrapper carrying coord:orient', async () => {
    const f = fixture();
    const stranded = fixture({ requires: [] });
    const shapes: Array<[string, unknown, unknown]> = [
      ['unresolvable applied receipt', { activation: { applied: stranded.applied } }, f.record],
      ['tampered artifact', f.state, { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } }],
      ['absent record', f.state, null],
    ];

    for (const [label, state, record] of shapes) {
      const read = vi.fn(async () => f.policy);
      const wrapped = {
        ...f.request,
        toolName: IDENTITY_BREAK_GLASS.dispatchWrapper,
        args: { name: 'coord:orient', args: {} },
      };
      expect(await checkIdentityGrantKernel(wrapped, state as never, record, read), label)
        .toMatchObject({ decision: 'allow', code: 'identity-recovery', applied: false });

      // Calibration, and the control that keeps this a DOOR rather than a hole:
      // admitting the WRAPPER itself would make the entire catalogue reachable
      // through it. The declared target must decide, not the wrapper's presence.
      const ordinary = {
        ...f.request,
        toolName: IDENTITY_BREAK_GLASS.dispatchWrapper,
        args: { name: 'work_items:complete', args: {} },
      };
      expect(await checkIdentityGrantKernel(ordinary, state as never, record, read), label)
        .toMatchObject({ decision: 'deny' });
    }
  });

  // A wrapper call whose target is absent or not a string must not fall through
  // to the door: `{}` and a non-string name are the shapes a malformed or
  // probing call produces, and neither names the recovery verb.
  it('denies the dispatch wrapper when it declares no usable target', async () => {
    const f = fixture();
    for (const args of [{}, { name: 42 }, { name: null }, undefined]) {
      const read = vi.fn(async () => f.policy);
      const wrapped = { ...f.request, toolName: IDENTITY_BREAK_GLASS.dispatchWrapper, args };
      expect(await checkIdentityGrantKernel(wrapped, f.state as never, null, read), JSON.stringify(args))
        .toMatchObject({ decision: 'deny' });
    }
  });

  // Derived-truth pin: the wrapper name is a second copy of a name invoke.ts
  // owns. A rename there would silently re-seal this door with every test green,
  // which is exactly how the original defect survived its own fix.
  it('pins the break-glass wrapper to the tool that actually registers it', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../agent-tools/tools/invoke.ts', import.meta.url), 'utf8');
    expect(source).toContain(`name: '${IDENTITY_BREAK_GLASS.dispatchWrapper}'`);
  });

  // EI-23745120264597384 — the RECOVERY-REACHABILITY invariant, enforced
  // structurally instead of by enumerating shapes.
  //
  // The self-sealing class is not "a gate denies too much". It is "a gate denies
  // the very verb documented to clear the state it is denying for", which leaves
  // the session stuck in exactly the condition it has a cure for. The previous
  // guard was a hand-written list of shapes, and a list only covers the paths
  // someone already thought of: `denial(failure.cause, …)` on the envelope path
  // sat unguarded while every test here passed, even though
  // IdentityGrantFailure['cause'] spans BOTH break-glass causes — so a producer
  // returning one there would brick a session for its entire life, undetected.
  //
  // Asserting on the SOURCE is what closes the class rather than the instance: a
  // denial site added later fails here the moment it bypasses the contract.
  it('INVARIANT: every denial routes through the break-glass chokepoint', async () => {
    const { readFileSync } = await import('node:fs');
    // Overridable so this guard's own falsifiability can be proven against a
    // COPY outside the tree, instead of mutating this shared checkout — where
    // git-sync sweeps every few minutes and can commit the mutant while the
    // probe is legitimately still running.
    const override = process.env.IDENTITY_GRANTS_PORT_SOURCE;
    const source = readFileSync(
      override ? new URL(`file://${override}`) : new URL('./identity-grants-port.ts', import.meta.url),
      'utf8',
    );

    const callSites = source.split('\n')
      .filter((line) => /\bdenial\(/.test(line))
      .filter((line) => !/^\s*\*/.test(line))          // prose inside a doc comment
      .filter((line) => !/^function denial\(/.test(line)) // the definition itself
      .map((line) => line.trim());

    // EI-23766133296678780: the chokepoint now also threads the values the gate compared
    // (`observed`) into the refusal contract. Still exactly ONE call site.
    expect(callSites).toEqual(['return denial(cause, classRef, toolName, policyRevision, observed);']);

    // ...and that sole call must live INSIDE the chokepoint, not in some later
    // function that merely happens to spell the same statement.
    const chokepoint = source.slice(source.indexOf('function denyUnlessRecoveryDoor('));
    expect(chokepoint).toContain('return denial(cause, classRef, toolName, policyRevision, observed);');
  });

  // The companion half, and the one that keeps this a DOOR rather than a hole.
  // A cause that is a statement about AUTHORITY (rather than about identity
  // resolution) must keep denying the recovery verb — otherwise "never deny the
  // recovery door" silently becomes "coord:orient is ungated". Without this,
  // widening IDENTITY_BREAK_GLASS.causes to the whole union would still pass.
  it('still denies the recovery verb for a cause outside the break-glass set', async () => {
    const f = fixture();
    const read = vi.fn(async () => f.policy);
    // coord:orient is absent from the fixture policy's ceiling, so this reaches
    // an authority denial, which is deliberately NOT a break-glass cause.
    const result = await checkIdentityGrantKernel(
      { ...f.request, toolName: 'coord:orient' }, f.state as never, f.record, read,
    );
    expect(result).toMatchObject({ decision: 'deny' });
    const cause = (result as { obligations?: { capabilityUnsatisfied?: { cause?: string } } })
      .obligations?.capabilityUnsatisfied?.cause;
    expect(cause).toBeTruthy();
    expect(IDENTITY_BREAK_GLASS.causes).not.toContain(cause);
  });

  it('keeps verified grantless artifacts and legacy sessions unchanged without policy I/O', async () => {
    const f = fixture();
    const artifact = compileAgentSpecification({
      source: { id: 'plain', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
      prompt: { role: 'worker', text: 'Plain.' },
    });
    const applied = { specificationRevision: artifact.specificationRevision, stateRevision: 'plain' };
    const read = vi.fn(async () => f.policy);
    expect(await checkIdentityGrantKernel(f.request, {}, null, read)).toBeNull();
    expect(await checkIdentityGrantKernel(f.request, { appliedRevision: applied },
      { ...f.record, ...applied, specificationArtifact: artifact }, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  // D-007: no live session is governed, so the per-call row reference must also
  // come from the ungoverned outcome — without changing that outcome.
  it('names the evaluated launch row for a grantless artifact while keeping the null verdict', async () => {
    const f = fixture();
    const artifact = compileAgentSpecification({
      source: { id: 'plain-audit', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
      prompt: { role: 'worker', text: 'Plain.' },
    });
    const applied = { specificationRevision: artifact.specificationRevision, stateRevision: 'plain-audit' };
    const record = { ...f.record, ...applied, specificationArtifact: artifact };
    const state = {
      appliedRevision: applied,
      identityLaunchRecordVersion: { sessionId: 'ungoverned-audit-test', rowVersion: '71' },
    };
    const read = vi.fn(async () => f.policy);
    const sink = vi.fn();

    expect(await checkIdentityGrantKernel(f.request, state, record, read, undefined, sink)).toBeNull();
    expect(sink).toHaveBeenCalledWith({ advSessionId: 'ungoverned-audit-test', xmin: '71' });
    // The cached resolution is judged against the same row, so it names it too.
    expect(await checkIdentityGrantKernel(f.request, state, record, read, undefined, sink)).toBeNull();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenLastCalledWith({ advSessionId: 'ungoverned-audit-test', xmin: '71' });

    // No database row version, no reference: nothing is invented.
    sink.mockClear();
    expect(await checkIdentityGrantKernel(f.request, { appliedRevision: applied }, record, read, undefined, sink))
      .toBeNull();
    expect(sink).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the governed stamp on the decision itself and never reports it as ungoverned', async () => {
    const f = fixture();
    const state = { ...f.state, identityLaunchRecordVersion: { sessionId: 'governed-audit-test', rowVersion: '72' } };
    const read = vi.fn(async () => f.policy);
    const sink = vi.fn();
    expect(await checkIdentityGrantKernel(f.request, state, f.record, read, undefined, sink)).toMatchObject({
      decision: 'allow',
      serverAudit: { identityLaunchRecord: { advSessionId: 'governed-audit-test', xmin: '72' } },
    });
    // A changed row (new xmin) is re-evaluated; a tampered artifact is denied, not reported.
    const changed = { ...state, identityLaunchRecordVersion: { sessionId: 'governed-audit-test', rowVersion: '73' } };
    expect(await checkIdentityGrantKernel(f.request, changed,
      { ...f.record, specificationArtifact: { tampered: true } }, read, undefined, sink))
      .toMatchObject({ decision: 'deny' });
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('P-005 production policy reader', () => {
  function prepare() {
    const f = fixture();
    io.state.mockImplementation(async (table) => table === 'harness_registry'
      ? { projects: [
        { slug: 'sales', path: '/fixture/sales', hive_slug: 'sales-pot' },
        { slug: 'sales-pot', path: '/fixture/pot', harness_kind: 'hive' },
      ] } : { roleEnvelopes: { su: { allowCapabilities: ['mail:send'] } } });
    io.load.mockReturnValue({ layers: [{}], blueprint: { fleet: { workerRoles: [{ id: 'su', capabilities: ['*'] }] } } });
    io.source.mockReturnValue({ id: 'sales-pot', fleet: { workerRoles: [{ id: 'su', capabilities: ['mail:send'] }] } });
    io.flag.mockResolvedValue(true);
    io.tools.mockReturnValue([{ expose: { mcp: { name: 'mail:send' } }, capabilities: ['mail:send'] }]);
    io.binding.mockResolvedValue({ ...f.policy.bindings[0], potSlug: 'sales-pot' });
    return { workspaceId: 'ws-a', harnessSlug: 'sales', role: 'su', classRefs: [CLASS] };
  }

  it('resolves the current pot, scopes reads, and intersects independent role and pot ceilings', async () => {
    const input = prepare();
    const policy = await readIdentityGrantPolicy(input);
    expect(policy.potSlug).toBe('sales-pot');
    expect(policy.ceilings).toEqual([{ allowCapabilities: ['mail:send'] }, { allowCapabilities: ['mail:send'] }]);
    expect(io.load).toHaveBeenCalledWith('/fixture/pot/.papercusp/blueprint.yaml', expect.any(Function));
    expect(io.state).toHaveBeenCalledWith('harness_registry', 'ws-a', { fresh: true });
    expect(io.state).toHaveBeenCalledWith('operator_capability_envelopes', 'ws-a', { fresh: true });
    expect(io.binding).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: 'ws-a', potSlug: 'sales-pot', classId: 'crm.email', classVersion: '1.0.0',
      providerKinds: ['tool', 'recipe'],
    });
  });

  it('does not cache bindings or administrator reductions across execution checks', async () => {
    const input = prepare();
    const first = await readIdentityGrantPolicy(input);
    io.binding.mockResolvedValue(null);
    io.source.mockReturnValue({ id: 'sales-pot', fleet: { workerRoles: [{ id: 'su', capabilities: [] }] } });
    const second = await readIdentityGrantPolicy(input);
    expect(second.bindings).toEqual([]);
    expect(second.ceilings[1]).toEqual({ allowCapabilities: [] });
    expect(second.policyRevision).not.toEqual(first.policyRevision);
  });

  it('does not swallow policy-store or blueprint failures into an unrestricted ceiling', async () => {
    const input = prepare();
    io.state.mockRejectedValueOnce(new Error('policy offline'));
    await expect(readIdentityGrantPolicy(input)).rejects.toThrow('policy offline');
    io.load.mockImplementationOnce(() => { throw new Error('invalid pot'); });
    await expect(readIdentityGrantPolicy(input)).rejects.toThrow('invalid pot');
  });

  it('refuses an inherited ceiling when the administrator pot declares none', async () => {
    const input = prepare();
    // The merged blueprint still advertises "*", authored by a parent. The
    // actual administrator source has no ceiling and cannot authorize grants.
    io.source.mockReturnValue({ id: 'sales-pot', extends: 'remote-identity' });
    await expect(readIdentityGrantPolicy(input)).rejects.toThrow('no explicit role capability ceiling');
    expect(io.binding).not.toHaveBeenCalled();
  });

  it('infers only a single administrator role and refuses an ambiguous install target', async () => {
    const input = prepare();
    expect((await readIdentityGrantPolicy({ ...input, role: undefined })).ceilings).toHaveLength(2);
    io.source.mockReturnValue({ id: 'sales-pot', fleet: { workerRoles: [
      { id: 'su', capabilities: ['*'] }, { id: 'worker', capabilities: [] },
    ] } });
    await expect(readIdentityGrantPolicy({ ...input, role: undefined })).rejects.toThrow('ambiguous');
  });
});

describe('P-005 install and runtime use the same ceiling', () => {
  function installFixture() {
    const f = fixture();
    const resolution: CapabilityGrantResolutionVerdict = {
      ok: true, requirements: [{ classRef: CLASS, optional: false, state: 'satisfied', binding: { ...f.policy.bindings[0]!, providerKind: 'tool' } }],
      satisfied: [CLASS], selected: [], missingRequired: [], requiresChoice: [], missingOptional: [], disclosures: [],
    };
    return { ...f, input: { workspaceId: 'ws-a', potSlug: 'sales', role: 'worker', resolution } };
  }

  it('accepts a conformant bound provider only inside both administrator ceilings', async () => {
    const f = installFixture();
    expect(await validateIdentityInstallGrants(f.input, async () => f.policy)).toEqual([]);
    const narrowed = { ...f.policy, ceilings: [...f.policy.ceilings, { allowCapabilities: [] }] };
    expect(await validateIdentityInstallGrants(f.input, async () => narrowed))
      .toMatchObject([{ cause: 'outside-ceiling', classRef: CLASS, toolName: 'mail:send' }]);
    expect(await checkIdentityGrantKernel(f.request, f.state, f.record, async () => narrowed))
      .toMatchObject({ decision: 'deny', obligations: { capabilityUnsatisfied: { cause: 'outside-ceiling' } } });
  });

  it('refuses policy failure, foreign-pot evidence and a binding changed since resolution', async () => {
    const f = installFixture();
    expect(await validateIdentityInstallGrants(f.input, async () => { throw new Error('offline'); }))
      .toMatchObject([{ cause: 'policy-unavailable', classRef: CLASS }]);
    expect(await validateIdentityInstallGrants(f.input, async () => ({ ...f.policy, potSlug: 'foreign' })))
      .toMatchObject([{ cause: 'policy-unavailable' }]);
    expect(await validateIdentityInstallGrants(f.input, async () => ({ ...f.policy, bindings: [] })))
      .toMatchObject([{ cause: 'provider-changed' }]);
  });

  it('WI-10005197: every install-time refusal carries the same lift condition the runtime denial does', async () => {
    const f = installFixture();
    const narrowed = { ...f.policy, ceilings: [...f.policy.ceilings, { allowCapabilities: [] }] };
    const unbound = { ...f.input, resolution: { ...f.input.resolution, ok: false } };
    const failures = [
      ...await validateIdentityInstallGrants(f.input, async () => narrowed),                       // outside-ceiling
      ...await validateIdentityInstallGrants(f.input, async () => { throw new Error('offline'); }), // policy-unavailable
      ...await validateIdentityInstallGrants(f.input, async () => ({ ...f.policy, bindings: [] })), // provider-changed
      ...await validateIdentityInstallGrants(unbound, async () => f.policy),                        // provider-unbound
    ];
    expect(failures.map((failure) => failure.cause).sort())
      .toEqual(['outside-ceiling', 'policy-unavailable', 'provider-changed', 'provider-unbound']);
    for (const failure of failures) {
      // Same cause => same contract as the runtime kernel verdict (observed is runtime-only).
      expect(failure.refusal).toEqual(identityRefusalContract(failure.cause));
      expect(failure.refusal?.liftsWhen).toBeTruthy();
      expect(failure.refusal?.whoCanMakeItTrue.length).toBeGreaterThan(0);
    }
  });

  it('checks a selected candidate without first installing it or binding it', async () => {
    const f = installFixture();
    const selection = {
      classRef: CLASS, providerPackage: 'mail-provider', providerVersion: '1.0.0', providerKind: 'tool' as const,
      reason: 'explicit-selection' as const, disclosureRequired: true,
    };
    f.input.resolution.requirements = [{
      classRef: CLASS, optional: false, state: 'choosable', selection,
      candidates: [{ ...f.policy.bindings[0]!, providerKind: 'tool', price: null, activePotBindings: 0, passingStructuralRuns: 1, totalStructuralRuns: 1 }],
    }];
    f.input.resolution.selected = [selection];
    const policy = { ...f.policy, bindings: [] };
    expect(await validateIdentityInstallGrants(f.input, async () => policy)).toEqual([]);
    expect(await validateIdentityInstallGrants(f.input, async () => ({ ...policy, tools: new Map() })))
      .toMatchObject([{ cause: 'tool-unavailable', classRef: CLASS }]);
    expect(await validateIdentityInstallGrants(f.input, async () => ({ ...policy, protectedAdditions: ['mail:*'] })))
      .toMatchObject([{ cause: 'outside-ceiling', classRef: CLASS }]);
  });
});

// EI-23703586803892464: acknowledgeControlTransition asks THIS before writing
// `applied`, so an acknowledgement can never manufacture a stale-artifact wedge.
describe('launchRecordAdmitsApplied — may this revision be acknowledged?', () => {
  it('admits the revision the selected launch record carries', () => {
    const f = fixture();
    expect(launchRecordAdmitsApplied(f.record, f.applied)).toBe(true);
  });

  it('admits a control-only activation: same specification, new state revision', () => {
    const f = fixture();
    expect(launchRecordAdmitsApplied(f.record, { ...f.applied, stateRevision: 'state-next' })).toBe(true);
  });

  it('refuses a specification the selected record does not run (the sibling-record wedge)', () => {
    const running = fixture();
    const sibling = fixture({ optional: [CLASS] });
    expect(sibling.applied.specificationRevision).not.toBe(running.applied.specificationRevision);
    expect(launchRecordAdmitsApplied(running.record, sibling.applied)).toBe(false);
  });

  it('refuses when the record is tampered, absent, or not an object', () => {
    const f = fixture();
    const tampered = { ...f.record, specificationArtifact: { ...f.artifact, configuration: {} } };
    expect(launchRecordAdmitsApplied(tampered, f.applied)).toBe(false);
    for (const record of [null, undefined, 'launch-spec', [f.record]]) {
      expect(launchRecordAdmitsApplied(record, f.applied)).toBe(false);
    }
  });
});

describe('P-018 appliedOrCurrentIdentityArtifact (worn-content reads)', () => {
  it('resolves a control-only activation to the record\'s current artifact, as the kernel admits it', () => {
    const f = fixture(undefined);
    // Re-registering an active mode advanced only the state revision: no receipt carries it.
    const advanced = { ...f.applied, stateRevision: 'state-b' };
    expect(appliedIdentityArtifact(f.record, advanced)).toBeNull();
    expect(appliedOrCurrentIdentityArtifact(f.record, advanced)?.specificationRevision)
      .toBe(f.artifact.specificationRevision);
  });

  it('never substitutes the current artifact for a DIFFERENT applied specification', () => {
    const f = fixture(undefined);
    const other = { specificationRevision: 'f'.repeat(64), stateRevision: 'state-a' };
    expect(appliedOrCurrentIdentityArtifact(f.record, other)).toBeNull();
    expect(appliedOrCurrentIdentityArtifact(f.record, null)).toBeNull();
    expect(appliedOrCurrentIdentityArtifact({ ...f.record, specificationArtifact: undefined },
      { ...f.applied, stateRevision: 'state-b' })).toBeNull();
  });
});

describe('resolveIdentityArtifact — one replay per distinct artifact (WI-10008237)', () => {
  it('replays once when the applied receipt IS the record, with the same verdict as two replays', () => {
    const f = fixture();
    const replay = vi.fn(replayAgentSpecification);
    const out = resolveIdentityArtifact(f.record, f.applied, replay);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: 'governed' });
    if (out.kind !== 'governed') throw new Error('unreachable');
    expect(out.artifact.specificationRevision).toBe(f.artifact.specificationRevision);
    expect(out.current).toBe(out.artifact);
  });

  it('still replays BOTH when the applied receipt is a different, historical artifact', () => {
    const older = fixture();
    const newer = compileAgentSpecification({
      source: { id: 'grant-port-next', workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
      prompt: { role: 'worker', text: 'Next.' }, inputClosure: [],
    });
    const record = {
      workspaceId: 'ws-a', harnessSlug: 'sales',
      specificationRevision: newer.specificationRevision, stateRevision: 'state-b', specificationArtifact: newer,
      identityHistory: [{ ...older.applied, specificationArtifact: older.artifact }],
    };
    const replay = vi.fn(replayAgentSpecification);
    resolveIdentityArtifact(record, older.applied, replay);
    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay.mock.calls.map(([v]) => v)).toEqual([older.artifact, newer]);
  });

  it('a throwing replay is not remembered: the resolution still fails closed as replay-failed', () => {
    const f = fixture();
    const replay = vi.fn(() => { throw new Error('specification-hash-mismatch'); });
    expect(resolveIdentityArtifact(f.record, f.applied, replay)).toEqual({ kind: 'stale-artifact', reason: 'replay-failed' });
  });
});

describe('P040 retained receipt shape calibration', () => {
  function retained() {
    const applied = fixture();
    const current = fixture({ requires: [], optional: [CLASS] });
    expect(current.applied.specificationRevision).not.toBe(applied.applied.specificationRevision);
    return { applied, record: { ...current.record, stateRevision: 'prepared-state', identityHistory: [applied.record] } };
  }

  it('resolves the genuine acknowledged receipt while preserving the current narrowing', () => {
    const { applied, record } = retained();
    const before = structuredClone(record);
    expect(resolveIdentityArtifact(record, applied.applied)).toMatchObject({
      kind: 'governed', artifact: applied.artifact, current: record.specificationArtifact,
    });
    expect(record).toEqual(before);
  });

  it.each(['absent', 'non-array', 'null-entry', 'wrong-state', 'wrong-specification',
    'missing-artifact', 'different-artifact', 'tampered-artifact'] as const)(
    'refuses %s history without synthesizing an acknowledged receipt', (shape) => {
      const { applied, record } = retained();
      const receipt = { ...applied.record };
      const history: unknown = shape === 'absent' ? []
        : shape === 'non-array' ? { receipt }
        : shape === 'null-entry' ? [null]
        : [shape === 'wrong-state' ? { ...receipt, stateRevision: 'not-acknowledged' }
          : shape === 'wrong-specification' ? { ...receipt, specificationRevision: 'f'.repeat(64) }
          : shape === 'missing-artifact' ? { ...receipt, specificationArtifact: undefined }
          : shape === 'different-artifact' ? { ...receipt, specificationArtifact: record.specificationArtifact }
          : { ...receipt, specificationArtifact: { ...applied.artifact, configuration: {} } }];
      const candidate = { ...record, identityHistory: history };
      const before = structuredClone(candidate);
      expect(resolveIdentityArtifact(candidate, applied.applied)).toEqual({
        kind: 'stale-artifact', reason: shape === 'tampered-artifact' ? 'replay-failed' : 'receipt-missing',
      });
      expect(candidate).toEqual(before);
    },
  );
});

describe('P-018 readIdentityReactionCeiling', () => {
  function prepare(workerRoles: unknown[]) {
    io.state.mockImplementation(async (table) => table === 'harness_registry'
      ? { projects: [
        { slug: 'sales', path: '/fixture/sales', hive_slug: 'sales-pot' },
        { slug: 'sales-pot', path: '/fixture/pot', harness_kind: 'hive' },
      ] } : { roleEnvelopes: { su: { denyCapabilities: ['capability:bash'] } }, protectedAdditions: ['billing:*'] });
    io.load.mockReturnValue({ layers: [{}] });
    io.source.mockReturnValue({ id: 'sales-pot', fleet: { workerRoles } });
    io.flag.mockResolvedValue(true);
  }

  it('reads the same sources as the grant policy: role envelope override plus the pot\'s own role ceiling', async () => {
    prepare([{ id: 'su', capabilities: ['mail:send'] }]);
    expect(await readIdentityReactionCeiling({ workspaceId: 'ws-a', harnessSlug: 'sales', role: 'su' })).toEqual({
      potSlug: 'sales-pot',
      ceilings: [{ denyCapabilities: ['capability:bash'] }, { allowCapabilities: ['mail:send'] }],
      protectedAdditions: ['billing:*'],
    });
    expect(io.load).toHaveBeenCalledWith('/fixture/pot/.papercusp/blueprint.yaml', expect.any(Function));
  });

  it('adds no pot ceiling when the administrator pot declares none for the role, instead of throwing', async () => {
    prepare([{ id: 'worker', capabilities: ['mail:send'] }]);
    const ceiling = await readIdentityReactionCeiling({ workspaceId: 'ws-a', harnessSlug: 'sales', role: 'su' });
    expect(ceiling.ceilings).toEqual([{ denyCapabilities: ['capability:bash'] }]);
  });

  it('throws on an unreadable source so the durable step retries rather than authorizing', async () => {
    prepare([]);
    io.state.mockRejectedValueOnce(new Error('registry offline'));
    await expect(readIdentityReactionCeiling({ workspaceId: 'ws-a', harnessSlug: 'sales', role: 'su' }))
      .rejects.toThrow('registry offline');
    await expect(readIdentityReactionCeiling({ workspaceId: 'ws-a', harnessSlug: 'unregistered', role: 'su' }))
      .rejects.toThrow('identity harness is not registered');
  });
});
