import { describe, expect, it, vi } from 'vitest';
import {
  fakeWorkspaceHostCapabilities,
  makeFakeWorkspaceHostProvider,
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  workspaceHostCanaryIdentityLabels,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostPlan,
  type WorkspaceHostPlanStep,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostResourceCheckpoint,
} from '@papercusp/deployment-driver';
import {
  assertProviderConnectionUsable,
  bindWorkspaceHostPlanRevision,
  nextWorkspaceHostControllerAuthority,
  runWorkspaceHostProvisioning,
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
  WorkspaceHostProvisioningTransientError,
  type WorkspaceHostProvisioningStore,
  type WorkspaceHostCanaryAdmission,
} from './provisioning-runner';

const bootstrapMocks = vi.hoisted(() => ({
  resolveProfile: vi.fn(),
  renderBootstrap: vi.fn(),
}));

vi.mock('./provision-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./provision-bootstrap')>()),
  resolveWorkspaceHostProvisionBootstrapProfile: bootstrapMocks.resolveProfile,
  renderWorkspaceHostProvisionBootstrap: bootstrapMocks.renderBootstrap,
}));

const desired: WorkspaceHostDesiredSpec = {
  hostId: 'host-1',
  target: 'gcp',
  scope: { kind: 'project', id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
  provider: { network: { mode: 'managed', networkName: 'host-1-net' } },
};

const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
  scope: desired.scope,
};

function planStep(id: string, dependsOn: readonly string[] = []): WorkspaceHostPlanStep {
  return {
    id,
    action: 'provision',
    resourceKind: id === 'create-instance' ? 'vm' : 'network',
    dependsOn,
    idempotencyKey: `key:${id}`,
    destructive: false,
    input: { op: id === 'create-instance' ? 'insert-instance' : 'insert-network' },
  };
}

function providerPlan(steps: readonly WorkspaceHostPlanStep[]): WorkspaceHostPlan {
  return {
    planId: 'plan-1',
    operationId: 'op-1',
    target: 'gcp',
    hostId: 'host-1',
    generatedAt: '2026-08-25T00:00:00Z',
    steps,
    warnings: [],
  };
}

function providerHarness(steps: readonly WorkspaceHostPlanStep[], hostBootstrap = false) {
  const apply = vi.fn<WorkspaceHostProvider['apply']>();
  const reconcile = vi.fn<WorkspaceHostProvider['reconcile']>();
  const observe = vi.fn<WorkspaceHostProvider['observe']>(async (host) => ({
    host,
    state: 'running',
    resources: host.resources,
    observedAt: '2026-08-25T00:00:10Z',
    drift: [],
  }));
  // WI-40474 (bb2c68cd) added the hostBootstrap gate at
  // input.provider.capabilities.lifecycle.hostBootstrap. The builder's all-false defaults
  // preserve this suite's pre-existing behavior (no bootstrap render/consume), and being a
  // real WorkspaceHostProviderCapabilities they cannot go silently stale the way the
  // hand-written literal that used to sit here did (WI-2144032).
  const provider = makeFakeWorkspaceHostProvider({
    target: 'gcp',
    ...(hostBootstrap
      ? { capabilities: fakeWorkspaceHostCapabilities({ lifecycle: { hostBootstrap: true } }) }
      : {}),
    validateConnection: vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-08-25T00:00:00Z',
      warnings: [],
      errors: [],
    })),
    plan: vi.fn(async () => providerPlan(steps)),
    apply,
    reconcile,
    observe,
  });
  return { provider, apply, reconcile, observe };
}

function storeHarness(initial: readonly WorkspaceHostResourceCheckpoint[] = []) {
  const calls: string[] = [];
  let checkpoints = initial.map((entry) => ({ ...entry }));
  const store: WorkspaceHostProvisioningStore = {
    upsertHost: vi.fn(async (input) => {
      calls.push('host');
      expect(input.desiredSpec).toEqual(desired);
    }),
    beginOperation: vi.fn(async () => {
      calls.push('operation');
    }),
    updateOperation: vi.fn(async (input) => {
      calls.push(`operation:${input.status}`);
    }),
    readCheckpoints: vi.fn(async () => checkpoints.map((entry) => ({ ...entry }))),
    upsertCheckpoint: vi.fn(async ({ checkpoint }) => {
      calls.push(`checkpoint:${checkpoint.logicalKey}:${checkpoint.state}`);
      checkpoints = [...checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey), { ...checkpoint }];
    }),
    appendEvent: vi.fn(async (input) => {
      calls.push(`event:${input.phase}`);
      return `event-${calls.length}`;
    }),
    recordObservation: vi.fn(async () => {
      calls.push('observation');
    }),
  };
  return { store, calls, checkpoints: () => checkpoints.map((entry) => ({ ...entry })) };
}

function runInput(provider: WorkspaceHostProvider, store: WorkspaceHostProvisioningStore) {
  return {
    workspaceId: 'ws-1',
    connectionId: 'connection-1',
    name: 'Research host',
    desired,
    connection,
    provider,
    operationId: 'op-1',
    store,
  };
}

describe('workspace-host provisioning bootstrap release selection', () => {
  it('forwards an operation-scoped release pin through the provision runner', async () => {
    const bootstrapReleaseOverride = {
      manifestPath: '/var/lib/papercusp/releases/aws-canary.json',
      migrationId: '1101',
    } as const;
    const profile = {
      release: {
        version: '2026.10.10-aws-canary',
        bundleSha256: 'a'.repeat(64),
        signingKeySha256: 'b'.repeat(64),
      },
      migrationId: bootstrapReleaseOverride.migrationId,
    };
    const bootstrapScript = '#!/usr/bin/env bash\necho operation release';
    bootstrapMocks.resolveProfile.mockReset().mockResolvedValue(profile);
    bootstrapMocks.renderBootstrap.mockReset().mockReturnValue(bootstrapScript);

    const { store } = storeHarness();
    const { provider, apply } = providerHarness([planStep('create-instance')], true);
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'create-instance',
      state: 'applied',
      observedAt: '2026-08-25T00:00:05Z',
      resource: { target: 'gcp', kind: 'vm', providerId: 'provider-create-instance' },
    });
    await runWorkspaceHostProvisioning({
      ...runInput(provider, store),
      bootstrapReleaseOverride,
    });

    expect(bootstrapMocks.resolveProfile).toHaveBeenCalledWith({ bootstrapReleaseOverride });
    expect(provider.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        hostBootstrapScript: bootstrapScript,
      }),
    );
    expect(store.upsertHost).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeRelease: expect.objectContaining({
          version: profile.release.version,
          schemaVersion: bootstrapReleaseOverride.migrationId,
        }),
      }),
    );
  });
});

describe('workspace-host controller revision identity', () => {
  it('keeps one controller fence stable and advances it exactly once on takeover', () => {
    const local = { controllerId: 'controller:local', fence: 4 } as const;

    expect(nextWorkspaceHostControllerAuthority(local, 'controller:local')).toBe(local);
    expect(nextWorkspaceHostControllerAuthority(local, 'controller:hosted')).toEqual({
      controllerId: 'controller:hosted',
      fence: 5,
    });
    expect(nextWorkspaceHostControllerAuthority(undefined, 'controller:first')).toEqual({
      controllerId: 'controller:first',
      fence: 1,
    });
    expect(() => nextWorkspaceHostControllerAuthority(local, '   ')).toThrow(
      WorkspaceHostProvisioningRequestError,
    );
  });

  it('binds the plan and every provider mutation key to one positive desired revision', () => {
    const plan = providerPlan([planStep('create-network'), planStep('create-instance')]);

    const bound = bindWorkspaceHostPlanRevision(plan, 7);

    expect(bound.planId).toBe('plan-1:desired-revision:7');
    expect(bound.steps.map((entry) => entry.idempotencyKey)).toEqual([
      'key:create-network:desired-revision:7',
      'key:create-instance:desired-revision:7',
    ]);
    expect(plan).toEqual(providerPlan([planStep('create-network'), planStep('create-instance')]));
    expect(() => bindWorkspaceHostPlanRevision(plan, 0)).toThrow(WorkspaceHostProvisioningRequestError);
  });
});

describe('runWorkspaceHostProvisioning', () => {
  const canary: WorkspaceHostCanaryAdmission = {
    runId: 'canary-1', workspaceId: 'ws-1', maxSpendCents: 100,
    teardownDeadlineAt: '2099-01-01T00:00:00Z',
    budgetEvidenceRef: 'gcp://billing/budgets/canary-1',
    preRunZeroBaseline: { cents: 0, observedAt: '2020-01-01T00:00:00Z', providerEvidenceRef: 'gcp://billing/baseline-1' },
    contractApproval: {
      status: 'approved', suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
      approvedBy: 'test-reviewer', approvedAt: '2020-01-01T00:00:00Z', reportRef: 'report://gcp/contract-1',
    },
  };
  const canaryDesired = { ...desired, labels: workspaceHostCanaryIdentityLabels(canary) };

  it.each([
    ['missing admission', undefined],
    ['missing baseline', { ...canary, preRunZeroBaseline: undefined }],
    ['nonzero baseline', { ...canary, preRunZeroBaseline: { ...canary.preRunZeroBaseline, cents: 1 } }],
    ['future baseline', { ...canary, preRunZeroBaseline: { ...canary.preRunZeroBaseline, observedAt: '2199-01-01T00:00:00Z' } }],
    ['missing budget', { ...canary, budgetEvidenceRef: '' }],
    ['wrong run', { ...canary, runId: 'different-run' }],
    ['unapproved contract', { ...canary, contractApproval: undefined }],
    ['expired deadline', { ...canary, teardownDeadlineAt: '2020-01-01T00:00:00Z' }],
    ['oversized budget', { ...canary, maxSpendCents: 100_000 }],
  ])('refuses canary creation with %s before durable writes or provider access', async (_label, evidence) => {
    const { store } = storeHarness();
    const { provider, apply } = providerHarness([planStep('create-instance')]);
    await expect(runWorkspaceHostProvisioning({
      ...runInput(provider, store), desired: canaryDesired, canary: evidence as WorkspaceHostCanaryAdmission | undefined,
    })).rejects.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect(provider.validateConnection).not.toHaveBeenCalled();
    expect(provider.plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(store.upsertHost).not.toHaveBeenCalled();
    expect(store.beginOperation).not.toHaveBeenCalled();
  });

  it('refuses canary evidence admitted for a different workspace, even when its identity labels agree', async () => {
    // WI-10005226: isolate the workspaceId guard. Labels are derived from the foreign evidence so the
    // label/identity checks agree and only the canary.workspaceId === input.workspaceId check can refuse.
    const foreign: WorkspaceHostCanaryAdmission = { ...canary, workspaceId: 'ws-2' };
    const { store } = storeHarness();
    const { provider, apply } = providerHarness([planStep('create-instance')]);
    await expect(runWorkspaceHostProvisioning({
      ...runInput(provider, store),
      desired: { ...desired, labels: workspaceHostCanaryIdentityLabels(foreign) },
      canary: foreign,
    })).rejects.toThrow(/canary\.workspaceId must match the active workspace/);
    expect(provider.validateConnection).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(store.upsertHost).not.toHaveBeenCalled();
    expect(store.beginOperation).not.toHaveBeenCalled();
  });

  it('persists the exact pre-run economics before creating a canary resource', async () => {
    const { store } = storeHarness();
    vi.mocked(store.upsertHost).mockResolvedValue(undefined);
    const { provider, apply } = providerHarness([planStep('create-instance')]);
    apply.mockImplementation(async (request) => {
      expect(store.beginOperation).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ canary }) }));
      return {
        operationId: 'op-1', stepId: request.step.id, state: 'applied', observedAt: '2026-08-25T00:00:05Z',
        resource: { target: 'gcp', kind: 'vm', providerId: 'canary-vm' },
      };
    });
    await expect(runWorkspaceHostProvisioning({
      ...runInput(provider, store), desired: canaryDesired, canary,
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('persists intent and every resource plan before the first provider mutation', async () => {
    const steps = [planStep('create-network'), planStep('create-instance', ['create-network'])];
    const { store, calls, checkpoints } = storeHarness();
    const { provider, apply, observe } = providerHarness(steps);
    apply.mockImplementation(async (request): Promise<WorkspaceHostApplyResult> => {
      calls.push(`provider:${request.step.id}`);
      expect(calls.indexOf('host')).toBeLessThan(calls.indexOf(`provider:${request.step.id}`));
      expect(calls.indexOf('checkpoint:create-network:planned')).toBeLessThan(
        calls.indexOf(`provider:${request.step.id}`),
      );
      expect(calls.indexOf('checkpoint:create-instance:planned')).toBeLessThan(
        calls.indexOf(`provider:${request.step.id}`),
      );
      if (request.step.id === 'create-instance') {
        expect(request.knownResources).toEqual([
          { target: 'gcp', kind: 'network', providerId: 'provider-create-network' },
        ]);
      }
      return {
        operationId: 'op-1',
        stepId: request.step.id,
        state: 'applied',
        observedAt: '2026-08-25T00:00:05Z',
        resource: {
          target: 'gcp',
          kind: request.step.resourceKind,
          providerId: `provider-${request.step.id}`,
        },
      };
    });

    const result = await runWorkspaceHostProvisioning(runInput(provider, store));

    expect(result.status).toBe('succeeded');
    expect(checkpoints().map(({ logicalKey, state }) => ({ logicalKey, state }))).toEqual([
      { logicalKey: 'create-network', state: 'applied' },
      { logicalKey: 'create-instance', state: 'applied' },
    ]);
    expect(observe).toHaveBeenCalledOnce();
    expect(calls).toContain('observation');
    expect(calls.at(-2)).toBe('operation:succeeded');
  });

  it.each(['running', 'stopped'] as const)(
    'persists running intent before mutation and preserves the actual %s observation',
    async (observedState) => {
      const { store } = storeHarness();
      const { provider, apply, observe } = providerHarness([planStep('create-instance')]);
      let admission: Parameters<WorkspaceHostProvisioningStore['upsertHost']>[0] | undefined;
      apply.mockImplementation(async () => {
        admission = vi.mocked(store.upsertHost).mock.calls[0]?.[0];
        return {
          operationId: 'op-1',
          stepId: 'create-instance',
          state: 'applied',
          observedAt: '2026-08-25T00:00:05Z',
          resource: { target: 'gcp', kind: 'vm', providerId: 'provider-vm' },
        };
      });
      observe.mockImplementation(async (host) => ({
        host,
        state: observedState,
        resources: host.resources,
        observedAt: '2026-08-25T00:00:10Z',
        drift: [],
      }));

      const result = await runWorkspaceHostProvisioning(runInput(provider, store));

      expect(result.status).toBe('succeeded');
      expect(admission).toMatchObject({
        desiredState: 'running',
        observedState: 'provisioning',
        observedRevision: 0,
      });
      expect(store.recordObservation).toHaveBeenCalledWith(
        'ws-1', expect.objectContaining({ state: observedState }), expect.anything(),
      );
      // Intent is not rewritten from observation: a stopped VM must still drift,
      // while a running VM must no longer falsely drift back to provisioning.
      expect(store.upsertHost).toHaveBeenCalledOnce();
      expect(vi.mocked(store.upsertHost).mock.calls[0]![0].desiredState).toBe('running');
    },
  );

  it('passes the desired revision through the provider request and persisted plan identity', async () => {
    const { store } = storeHarness();
    const { provider, apply } = providerHarness([planStep('create-network')]);
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'create-network',
      state: 'applied',
      observedAt: '2026-08-25T00:00:05Z',
      resource: { target: 'gcp', kind: 'network', providerId: 'provider-create-network' },
    });

    const result = await runWorkspaceHostProvisioning({
      ...runInput(provider, store),
      desiredRevision: 7,
      controllerAuthority: { controllerId: 'controller:test', fence: 3 },
    });

    expect(provider.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op-1',
        idempotencyKey: 'workspace-host:ws-1:host-1:revision:7:op-1:provision',
      }),
      expect.anything(),
    );
    expect(result.plan).toMatchObject({
      planId: 'plan-1:desired-revision:7',
      steps: [expect.objectContaining({ idempotencyKey: 'key:create-network:desired-revision:7' })],
    });
    expect(store.beginOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredRevision: 7,
        request: expect.objectContaining({
          plan: {
            planId: 'plan-1:desired-revision:7',
            steps: [{ id: 'create-network', idempotencyKey: 'key:create-network:desired-revision:7' }],
          },
        }),
      }),
    );
  });

  it('returns an in-progress receipt and reconciles on replay instead of blindly applying again', async () => {
    const steps = [planStep('create-network')];
    const { store, checkpoints } = storeHarness();
    const { provider, apply, reconcile } = providerHarness(steps);
    apply.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'create-network',
      state: 'in-progress',
      observedAt: '2026-08-25T00:00:01Z',
      providerRequestId: 'provider-operation-1',
      retryAfterMs: 7_500,
    });
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'create-network',
      state: 'unchanged',
      observedAt: '2026-08-25T00:00:08Z',
      resource: { target: 'gcp', kind: 'network', providerId: 'provider-network' },
    });

    const first = await runWorkspaceHostProvisioning(runInput(provider, store));
    expect(first).toMatchObject({ status: 'in-progress', retryAfterMs: 7_500 });
    expect(checkpoints()[0]).toMatchObject({
      state: 'retry-wait',
      retryClass: 'ambiguous',
      providerRequestId: 'provider-operation-1',
    });

    const replay = await runWorkspaceHostProvisioning(runInput(provider, store));
    expect(replay.status).toBe('succeeded');
    expect(apply).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]?.[0]).toMatchObject({
      reason: 'resume',
      previousProviderRequestId: 'provider-operation-1',
    });
  });

  it('records a thrown provider outcome as ambiguous and reconciles it on the next request', async () => {
    const steps = [planStep('create-network')];
    const { store, checkpoints } = storeHarness();
    const { provider, apply, reconcile } = providerHarness(steps);
    apply.mockRejectedValueOnce(new Error('connection closed after request write'));
    reconcile.mockResolvedValue({
      operationId: 'op-1',
      stepId: 'create-network',
      state: 'applied',
      observedAt: '2026-08-25T00:00:08Z',
      resource: { target: 'gcp', kind: 'network', providerId: 'provider-network' },
    });

    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).resolves.toMatchObject({
      status: 'in-progress',
    });
    expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass: 'ambiguous' });
    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('persists nothing when the provider rejects the plan', async () => {
    const { store } = storeHarness();
    const { provider } = providerHarness([planStep('create-network')]);
    vi.mocked(provider.plan).mockRejectedValueOnce(new Error('desired.zone must belong to desired.region'));

    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).rejects.toEqual(
      expect.objectContaining<Partial<WorkspaceHostProvisioningRequestError>>({
        name: 'WorkspaceHostProvisioningRequestError',
        problems: ['desired.zone must belong to desired.region'],
      }),
    );
    expect(store.upsertHost).not.toHaveBeenCalled();
    expect(store.beginOperation).not.toHaveBeenCalled();
    expect(store.upsertCheckpoint).not.toHaveBeenCalled();
  });

  // EI-23498781044665167. The failure this exists to prevent: a TRANSPORT error from the plan
  // seam was wrapped into the non-retryable REQUEST class, so one network blip permanently
  // killed a provision at 14% after ~22min of recovery churn. The test above is this one's
  // calibration control — a genuine validation rejection must STAY a RequestError.
  it('keeps a transport failure from the plan seam RETRYABLE instead of calling it a bad request', async () => {
    const { store } = storeHarness();
    const { provider } = providerHarness([planStep('create-network')]);
    // undici's real shape: a generic `fetch failed` whose reason hides in `.cause.code`.
    vi.mocked(provider.plan).mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }),
    );

    const error = await runWorkspaceHostProvisioning(runInput(provider, store)).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(WorkspaceHostProvisioningTransientError);
    expect(error).not.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
  });

  // The test above pins only the cause code the classifier ALREADY recognised, so it passed
  // identically before and after the guard existed — it could never have caught this hole.
  // undici omits `.cause` entirely on some transport failures, and uses codes outside the two
  // recognised sets (EAI_AGAIN, ENETUNREACH, TLS) on others; for every one of those the bare
  // string "fetch failed" matches none of the classifier's message patterns, so the seam fell
  // through to the caller-fault class. Provision failures are billed in leaked VMs, so a
  // transport blip must never be recorded as a malformed request.
  it('keeps a BARE "fetch failed" (no cause code) from the plan seam RETRYABLE', async () => {
    const { store } = storeHarness();
    const { provider } = providerHarness([planStep('create-network')]);
    vi.mocked(provider.plan).mockRejectedValueOnce(new TypeError('fetch failed'));

    const error = await runWorkspaceHostProvisioning(runInput(provider, store)).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(WorkspaceHostProvisioningTransientError);
    expect(error).not.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect(store.upsertCheckpoint).not.toHaveBeenCalled();
  });

  // A stored problem of exactly "fetch failed" is undiagnosable: it cannot distinguish a DNS
  // failure from a refused connection from a TLS error. That is the whole reason the P-317
  // root cause had to be guessed, and was guessed wrong twice.
  it('records the CAUSE CODE in the problem, so a transport failure is self-diagnosing', async () => {
    const { store } = storeHarness();
    const { provider } = providerHarness([planStep('create-network')]);
    vi.mocked(provider.plan).mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN compute.googleapis.com' } }),
    );

    const error = await runWorkspaceHostProvisioning(runInput(provider, store)).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(WorkspaceHostProvisioningTransientError);
    const [problem] = (error as WorkspaceHostProvisioningTransientError).problems;
    expect(problem).toContain('EAI_AGAIN');
    expect(problem).not.toBe('fetch failed');
  });

  // `.message` is all that reaches a journal line or a stored operation row. Dropping `problems`
  // there is what made the EI-23498781044665167 provision failure undiagnosable — and it was then
  // carried forward as an entirely wrong root cause.
  it('surfaces the rejection reason in .message, not only on .problems', () => {
    const error = new WorkspaceHostProvisioningRequestError(['fetch failed', 'second reason']);

    expect(error.message).toContain('workspace-host provisioning request rejected');
    expect(error.message).toContain('fetch failed');
    expect(error.message).toContain('second reason');
    expect(error.problems).toEqual(['fetch failed', 'second reason']);
    // An empty problems list must not leave a dangling separator.
    expect(new WorkspaceHostProvisioningRequestError([]).message).toBe(
      'workspace-host provisioning request rejected',
    );
  });

  function httpError(status: number): Error {
    return Object.assign(new Error(`gcp_preflight_http_${status}`), { status });
  }

  // The failure this exists to prevent: every thrown provider call was classified 'ambiguous', so
  // a deterministic 400 (a boot disk smaller than its source image) reconciled every 2s past 40
  // attempts — never terminal, never surfaced, and indistinguishable from a hang.
  it('halts on a deterministic provider rejection instead of reconciling it forever', async () => {
    const steps = [planStep('create-instance')];
    const { store, checkpoints } = storeHarness();
    const { provider, apply, reconcile } = providerHarness(steps);
    apply.mockRejectedValueOnce(httpError(400));

    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).resolves.toMatchObject({
      status: 'failed',
    });
    expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass: 'terminal' });
    expect(checkpoints()[0]).not.toHaveProperty('retryAfterMs');
    expect(reconcile).not.toHaveBeenCalled();
    expect(store.updateOperation).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it.each([
    ['a throttle', 429, 'throttled'],
    ['a request timeout', 408, 'throttled'],
    ['a conflict that an idempotent replay can cause', 409, 'ambiguous'],
    ['a provider-side fault', 503, 'ambiguous'],
  ])('keeps retrying %s (%i)', async (_label, status, retryClass) => {
    const steps = [planStep('create-instance')];
    const { store, checkpoints } = storeHarness();
    const { provider, apply } = providerHarness(steps);
    apply.mockRejectedValueOnce(httpError(status));

    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).resolves.toMatchObject({
      status: 'in-progress',
    });
    expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass });
  });

  // WI-1818869, end to end. Google rate-limits Compute with 403, not 429, so this exact shape used
  // to classify as `terminal` -> `halt`: the durable workflow stopped for good on a throttle, which
  // a 24h soak is near-certain to hit. The assertion that matters is `in-progress` (the run is
  // still alive), not merely the retry class.
  it('retries a 403 that the provider marked as a rate limit instead of halting forever', async () => {
    const steps = [planStep('create-instance')];
    const { store, checkpoints } = storeHarness();
    const { provider, apply, reconcile } = providerHarness(steps);
    apply.mockRejectedValueOnce(Object.assign(httpError(403), { throttled: true }));

    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).resolves.toMatchObject({
      status: 'in-progress',
    });
    expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass: 'throttled' });
    expect(reconcile).not.toHaveBeenCalled();
  });

  // The control that keeps the fix honest: an UNMARKED 403 is still a settled refusal, so a real
  // permission denial must keep halting rather than reconciling against the wall forever.
  it('still halts on a 403 the provider did not mark as a rate limit', async () => {
    const steps = [planStep('create-instance')];
    const { store, checkpoints } = storeHarness();
    const { provider, apply } = providerHarness(steps);
    apply.mockRejectedValueOnce(httpError(403));

    await expect(runWorkspaceHostProvisioning(runInput(provider, store))).resolves.toMatchObject({
      status: 'failed',
    });
    expect(checkpoints()[0]).toMatchObject({ state: 'failed', retryClass: 'terminal' });
  });
});

describe('assertProviderConnectionUsable (WI-1743793)', () => {
  const context = { workspaceId: 'ws-1', requestId: 'op-1', connection } as never;

  function validator(result: unknown) {
    return { validateConnection: vi.fn().mockResolvedValue(result) } as never;
  }

  it('admits a connection the provider reports usable', async () => {
    await expect(
      assertProviderConnectionUsable(
        validator({ ok: true, checkedAt: '2026-01-01T00:00:00.000Z', warnings: [], errors: [] }),
        context,
      ),
    ).resolves.toBeUndefined();
  });

  it('raises a RETRYABLE transient error when the provider could not reach its API', async () => {
    // The regression: a transport blip during admission was thrown as a ConnectionError, which the
    // durable workflow's shouldRetry excludes from retry — so one dropped packet permanently
    // failed a lifecycle action against a connection that was demonstrably fine.
    const error = await assertProviderConnectionUsable(
      validator({
        ok: false,
        checkedAt: '2026-01-01T00:00:00.000Z',
        warnings: [],
        errors: ['GCP Compute API was unreachable'],
        retryable: true,
      }),
      context,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WorkspaceHostProvisioningTransientError);
    expect(error).not.toBeInstanceOf(WorkspaceHostProvisioningConnectionError);
    expect((error as WorkspaceHostProvisioningTransientError).problems).toEqual(['GCP Compute API was unreachable']);
  });

  it('raises a TERMINAL connection error when the provider settled that the connection is bad', async () => {
    const error = await assertProviderConnectionUsable(
      validator({
        ok: false,
        checkedAt: '2026-01-01T00:00:00.000Z',
        warnings: [],
        errors: ['GCP connection project is missing; reconnect with an explicit project.'],
        retryable: false,
      }),
      context,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WorkspaceHostProvisioningConnectionError);
    expect(error).not.toBeInstanceOf(WorkspaceHostProvisioningTransientError);
  });

  it('keeps an UNCLASSIFIED failure terminal, so a provider that never classifies cannot silently become retryable', async () => {
    const error = await assertProviderConnectionUsable(
      validator({ ok: false, checkedAt: '2026-01-01T00:00:00.000Z', warnings: [], errors: ['nope'] }),
      context,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WorkspaceHostProvisioningConnectionError);
  });

  it('treats a THROWING validator as transient, because nothing was learned about the connection', async () => {
    const error = await assertProviderConnectionUsable(
      { validateConnection: vi.fn().mockRejectedValue(new Error('socket hang up')) } as never,
      context,
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WorkspaceHostProvisioningTransientError);
  });

  it('keeps the transient class OUTSIDE the two classes the workflow refuses to retry', () => {
    // workspace-host-provision-workflow.ts's shouldRetry retries anything that is neither a
    // request nor a connection error. If the transient class were ever made to extend either of
    // them, retry would silently stop happening with no other test failing.
    const transient = new WorkspaceHostProvisioningTransientError(['x']);
    expect(transient).not.toBeInstanceOf(WorkspaceHostProvisioningConnectionError);
    expect(transient).not.toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect(transient.name).toBe('WorkspaceHostProvisioningTransientError');
  });
});
