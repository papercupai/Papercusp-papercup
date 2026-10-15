import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getWorkItem, readAcceptedBlueprintDirectWorkItem, getIdentitySource, sqlMock } = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  readAcceptedBlueprintDirectWorkItem: vi.fn(),
  getIdentitySource: vi.fn(),
  sqlMock: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('../work-items', () => ({ getWorkItem }));
vi.mock('./operation-admission', () => ({ readAcceptedBlueprintDirectWorkItem }));
vi.mock('../agent-identities/source', () => ({ getIdentitySource }));
vi.mock('../workspace-als', () => ({ runWithWorkspace: (_workspace: string, run: () => unknown) => run() }));
// getOrgPg is stubbed above, so the real pot lookup reads a stub, is reported as
// unmeasured (console.warn, by design since WI-10004845), and vitest-fail-on-console
// fails the case (WI-10005470). Pot resolution is not this file's subject.
vi.mock('../pot-membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pot-membership')>()),
  workItemStorageSlug: async (slug: string) => slug,
}));

import { assertExternalRuntimeProducerOutcome, assertVerifiedExternalRuntimeCompletion, verifyExternalRuntimeCompletionAttempt, describeOperationReceiptReadFault, matchOperationWorkerClaim, readActiveOperationModelPolicy, resolveAcceptedOperationWorkerBinding, selectAcceptedOperationWorkerModel, type ExternalRuntimeProducerBinding, type ExternalRuntimeStoredOutcome } from './operation-worker-binding';

const HASH = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
describe('external voice producer retained outcome validation (D037)', () => {
  const binding: ExternalRuntimeProducerBinding = {
    kind: 'external-runtime-producer', workspaceId: 'ws-a', harnessSlug: 'phone',
    storageHarnessSlug: 'phone-home',
    workItemId: 'WI-voice', executionOwnerId: 'voice-executor', ownerId: 'customer-a',
    callKey: 'inbound:room-a', callId: 'call-a', runId: 'run-a', jobId: 'job-a',
    configurationSha256: HASH, registeredAt: '2026-10-07T13:00:00Z',
  };
  function fixture() {
    const stored: ExternalRuntimeStoredOutcome = {
      binding: { ...binding }, endReason: 'completed', endedAt: '2026-10-07T13:01:00Z',
      transcriptSegmentCount: 2, transcriptSha256: REVISION,
      retainedSegmentCount: 2, retainedSha256: REVISION, contentDeleted: false,
    };
    return { workspaceId: 'ws-a', by: 'voice-executor', stored,
      item: { id: 'WI-voice', harness: 'phone-home', assignee: 'voice-executor',
        payload: { externalRuntimeProducer: { ...binding } } } };
  }
  it('accepts a retained completed call without claiming source files or a CLI receipt', () => {
    expect(assertExternalRuntimeProducerOutcome(fixture())).toEqual(binding);
  });
  it.each(['ownerId', 'callKey', 'callId', 'runId', 'jobId', 'configurationSha256', 'workItemId', 'harnessSlug', 'storageHarnessSlug', 'workspaceId', 'executionOwnerId'] as const)(
    'refuses a foreign or rebound %s', (key) => {
      const input = fixture();
      input.stored.binding[key] = key === 'configurationSha256' ? 'c'.repeat(64) : 'foreign';
      expect(() => assertExternalRuntimeProducerOutcome(input)).toThrow(/binding|registration/);
    });
  it('refuses a changed current claim even when the registration is unchanged', () => {
    const input = fixture();
    input.item.assignee = 'replacement-worker';
    expect(() => assertExternalRuntimeProducerOutcome(input)).toThrow('current holder changed');
  });
  it.each(['worker-lost', 'failed', 'cancelled'] as const)('never promotes %s partial content to success', (reason) => {
    const input = fixture();
    input.stored.endReason = reason;
    expect(() => assertExternalRuntimeProducerOutcome(input)).toThrow('no verified complete');
  });
  it.each(['retainedSegmentCount', 'retainedSha256', 'endedAt', 'contentDeleted'] as const)(
    'refuses absent or contradictory retained evidence: %s', (key) => {
      const input = fixture();
      if (key === 'retainedSegmentCount') input.stored[key] = 1;
      if (key === 'retainedSha256') input.stored[key] = HASH;
      if (key === 'endedAt') input.stored[key] = null;
      if (key === 'contentDeleted') input.stored[key] = true;
      expect(() => assertExternalRuntimeProducerOutcome(input)).toThrow('no verified complete');
    });
  it('refuses an end predating the admitted runtime', () => {
    const input = fixture();
    input.stored.endedAt = '2026-10-07T12:59:00Z';
    expect(() => assertExternalRuntimeProducerOutcome(input)).toThrow('no verified complete');
  });
  function attemptFixture() {
    const input = fixture();
    const updatedTs = Date.parse('2026-10-07T13:00:30Z');
    return { ...input, item: { ...input.item, state: 'open', updatedAt: new Date(updatedTs).toISOString() },
      attempt: { binding: { ...binding }, updatedTs,
        readStoredOutcome: vi.fn(async () => input.stored) } };
  }
  it('reads the trusted host and freezes the independently verified receipt', async () => {
    const input = attemptFixture();
    const receipt = await verifyExternalRuntimeCompletionAttempt(input);
    expect(() => assertVerifiedExternalRuntimeCompletion(receipt)).not.toThrow();
    expect(() => assertVerifiedExternalRuntimeCompletion({ ...receipt })).toThrow('not minted');
    expect(input.attempt.readStoredOutcome).toHaveBeenCalledOnce();
    input.attempt.binding.runId = 'mutated';
    input.stored.binding.runId = 'also-mutated';
    expect(receipt.binding.runId).toBe('run-a');
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.binding)).toBe(true);
  });
  it('refuses host registration changes during asynchronous verification', async () => {
    const input = attemptFixture();
    input.attempt.readStoredOutcome.mockImplementation(async () => {
      input.stored.binding.jobId = 'replacement-job';
      return input.stored;
    });
    await expect(verifyExternalRuntimeCompletionAttempt(input)).rejects.toThrow('trusted host registration');
  });
  it.each(['epoch', 'terminal', 'cancelled', 'reopened'] as const)(
    'refuses %s attempts before asking the host to verify', async (condition) => {
      const input = attemptFixture();
      if (condition === 'epoch') input.attempt.updatedTs++;
      if (condition === 'terminal') input.item.state = 'done';
      if (condition === 'cancelled') Object.assign(input.item.payload, { blueprintCancellation: {} });
      if (condition === 'reopened') Object.assign(input.item.payload, { reopenHistory: [] });
      await expect(verifyExternalRuntimeCompletionAttempt(input)).rejects.toThrow(/stale|cancelled|reopened/);
      expect(input.attempt.readStoredOutcome).not.toHaveBeenCalled();
    });
  it('propagates an unavailable host rather than treating missing evidence as success', async () => {
    const input = attemptFixture();
    input.attempt.readStoredOutcome.mockRejectedValue(new Error('host unavailable'));
    await expect(verifyExternalRuntimeCompletionAttempt(input)).rejects.toThrow('host unavailable');
  });
});
const args = {
  sql: {} as never,
  workspaceId: 'ws-a',
  harnessSlug: 'harness-a',
  workItemId: 'WI-1',
  role: 'worker',
  repoDir: '/repo/harness-a',
};
const item = { id: 'WI-1', harness: 'harness-a', payload: { blueprintOperation: { kind: 'blueprint-operation' } } };
const pin = { kind: 'blueprint-operation' as const, harnessSlug: 'harness-a',
  operationId: 'run', specificationRevision: REVISION, operationVersion: '1.0.0', input: {} };
const operation = {
  execution: { kind: 'agent', role: 'worker' },
  policy: {
    identity: { kind: 'identity', ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
    requiredTools: ['work_items:get', 'coord:orient', 'work_items:get'],
  },
};
const source = {
  ok: true,
  sourcePath: '/repo/blueprint-operation-worker/blueprint.yaml',
  identity: { id: 'blueprint-operation-worker', version: '0.1.0', slots: [{ slot: 'domain' }], grants: {} },
  contentHash: HASH,
};

beforeEach(() => {
  vi.resetAllMocks();
  getWorkItem.mockResolvedValue(item);
  readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation });
  getIdentitySource.mockResolvedValue(source);
});

describe('accepted blueprint operation worker binding', () => {
  it('derives the exact identity and tool set from the accepted item', async () => {
    const binding = await resolveAcceptedOperationWorkerBinding(args);
    expect(binding).toEqual({
      workItemId: 'WI-1', harnessSlug: 'harness-a', storageHarnessSlug: 'harness-a',
      operationId: 'run', specificationRevision: REVISION,
      pin,
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      stack: ['domain:blueprint-operation-worker'],
      requiredTools: ['coord:orient', 'work_items:get'],
    });
    expect(getIdentitySource).toHaveBeenCalledWith('blueprint-operation-worker', { repoDir: '/repo/harness-a' });
  });

  it('can ignore an accepted operation that belongs to a different requested role', async () => {
    await expect(resolveAcceptedOperationWorkerBinding({
      ...args,
      sql: undefined,
      role: 'independent-auditor',
      roleMismatch: 'ignore',
    })).resolves.toBeNull();
    expect(readAcceptedBlueprintDirectWorkItem).toHaveBeenCalledWith(sqlMock, 'ws-a', item);
    expect(getIdentitySource).not.toHaveBeenCalled();
  });

  it('keeps role mismatches strict unless the caller explicitly ignores them', async () => {
    await expect(resolveAcceptedOperationWorkerBinding({
      ...args,
      role: 'independent-auditor',
    })).rejects.toThrow('accepted blueprint operation does not authorize this worker role');
  });

  it('matches only the exact pinned item for an active worker', () => {
    const binding = {
      workItemId: 'WI-1', harnessSlug: 'harness-a', storageHarnessSlug: 'harness-a',
      operationId: 'run', specificationRevision: REVISION,
      pin,
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      stack: ['domain:blueprint-operation-worker'], requiredTools: ['work_items:get'],
    };
    const pinned = { id: 'WI-1', harness: 'harness-a', payload: { blueprintOperation: pin } };
    const read = { status: 'bound' as const, binding, receipt: {
      sessionId: 1, workspaceId: 'ws-a', ownerId: 'worker-a',
      specificationRevision: HASH, stateRevision: 'state-a', acceptedOperation: {},
    } };
    expect(matchOperationWorkerClaim(read, pinned)).toEqual({ allowed: true });
    expect(matchOperationWorkerClaim(read, { ...pinned, id: 'WI-2' }).allowed).toBe(false);
    expect(matchOperationWorkerClaim(read, { ...pinned, harness: 'harness-b' }).allowed).toBe(false);
    expect(matchOperationWorkerClaim(read, { ...pinned, payload: {} }).allowed).toBe(false);
    expect(matchOperationWorkerClaim(read, { ...pinned, payload: {
      blueprintOperation: { ...pinned.payload.blueprintOperation, specificationRevision: 'c'.repeat(64) },
    } }).allowed).toBe(false);
    expect(matchOperationWorkerClaim(read, { ...pinned, payload: {
      blueprintOperation: { ...pin, input: { changed: true } },
    } }).allowed).toBe(false);
    expect(matchOperationWorkerClaim({ status: 'none' }, pinned).allowed).toBe(false);
    expect(matchOperationWorkerClaim({ status: 'none' }, { ...pinned, payload: {} })).toEqual({ allowed: true });
    expect(matchOperationWorkerClaim({ status: 'unavailable', reason: 'ended' }, pinned).allowed).toBe(false);
    expect(matchOperationWorkerClaim({ status: 'unavailable', reason: 'ended' }, { ...pinned, payload: {} }).allowed).toBe(false);

    // WI-10004367: a pot MEMBER harness's row sits under the pot home, its pin under the member.
    const potted = { ...read, binding: { ...binding, storageHarnessSlug: 'pot-home' } };
    expect(matchOperationWorkerClaim(potted, { ...pinned, harness: 'pot-home' })).toEqual({ allowed: true });
    expect(matchOperationWorkerClaim(potted, pinned).allowed).toBe(false);
    expect(matchOperationWorkerClaim(potted, { ...pinned, harness: 'pot-home', payload: {
      blueprintOperation: { ...pin, harnessSlug: 'pot-home' },
    } }).allowed).toBe(false);
  });

  it('leaves ordinary work items on their existing role launch path', async () => {
    getWorkItem.mockResolvedValue({ ...item, payload: {} });
    expect(await resolveAcceptedOperationWorkerBinding(args)).toBeNull();
    expect(readAcceptedBlueprintDirectWorkItem).not.toHaveBeenCalled();
  });

  it('pins an accepted exact model and refuses an incompatible launch selector', async () => {
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation: {
      ...operation, policy: { ...operation.policy,
        model: { mode: 'exact', models: ['anthropic/claude-opus-4-8'], onUnavailable: 'fail' },
      },
    } });
    const binding = await resolveAcceptedOperationWorkerBinding(args);
    expect(binding?.modelPolicy).toEqual({
      mode: 'exact', models: ['anthropic/claude-opus-4-8'], onUnavailable: 'fail',
    });
    expect(selectAcceptedOperationWorkerModel(binding, 'claude-opus-4-8', 'claude')).toEqual({
      model: 'claude-opus-4-8', requestedModel: 'claude-opus-4-8',
      backend: 'claude', source: 'operation-policy',
    });
    expect(() => selectAcceptedOperationWorkerModel(binding, 'claude-sonnet-4-6', 'claude'))
      .toThrow('outside the accepted exact model policy');
    expect(() => selectAcceptedOperationWorkerModel(binding, 'openai-codex/claude-opus-4-8', 'claude'))
      .toThrow('outside the accepted exact model policy');
  });

  it('selects only listed allowed/preferred models and preserves required effort', () => {
    const binding = {
      workItemId: 'WI-1', harnessSlug: 'harness-a', storageHarnessSlug: 'harness-a',
      operationId: 'run', specificationRevision: REVISION,
      pin, identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      stack: ['domain:blueprint-operation-worker'], requiredTools: [],
      modelPolicy: { mode: 'allowed' as const, models: ['gpt-5.6-terra', 'gpt-5.6-sol'],
        effort: 'high', onUnavailable: 'wait' as const },
    };
    expect(selectAcceptedOperationWorkerModel(binding, null, 'codex')?.model).toBe('gpt-5.6-terra:high');
    expect(selectAcceptedOperationWorkerModel(binding, 'sol:high', 'codex')?.model).toBe('gpt-5.6-sol:high');
    expect(() => selectAcceptedOperationWorkerModel(binding, 'gpt-5.6-luna:high', 'codex'))
      .toThrow('outside the accepted allowed model policy');
    expect(() => selectAcceptedOperationWorkerModel(binding, 'sol:low', 'codex'))
      .toThrow('reasoning effort differs');
    expect(selectAcceptedOperationWorkerModel({ ...binding,
      modelPolicy: { ...binding.modelPolicy, mode: 'preferred' },
    }, null, 'codex')?.model).toBe('gpt-5.6-terra:high');
    expect(() => selectAcceptedOperationWorkerModel(binding, null, 'omp'))
      .toThrow('no verifiable OMP provider response path');
    expect(selectAcceptedOperationWorkerModel({ ...binding, modelPolicy: undefined }, 'gpt-5.6-luna', 'codex')).toBeNull();
    expect(selectAcceptedOperationWorkerModel({ ...binding, modelPolicy: undefined }, 'gpt-5.6-luna', 'omp')).toBeNull();
  });

  it('checks the active launch receipt against the immutable accepted model policy', async () => {
    const modelPolicy = { mode: 'exact' as const, models: ['claude-opus-4'], onUnavailable: 'fail' as const };
    const modelSelection = { model: 'claude-opus-4', requestedModel: null,
      backend: 'claude' as const, source: 'operation-policy' as const };
    const accepted = {
      kind: 'blueprint-operation-worker', workItemId: 'WI-1', operationId: 'run',
      specificationRevision: REVISION, pin,
      identity: { ref: 'blueprint-operation-worker', revision: '0.1.0', contentHash: HASH },
      requiredTools: ['work_items:get'], modelPolicy, modelSelection,
    };
    const revision = { specificationRevision: HASH, stateRevision: 'state-a' };
    const row = {
      accepted_operation: accepted as Record<string, unknown>, launch_workspace_id: 'ws-a', launch_harness_slug: 'harness-a',
      launch_role: 'worker', specification_revision: HASH, state_revision: 'state-a',
      grants_kind: 'object', activation: {
        schemaVersion: 1, status: 'applied', attribution: {
          actorId: 'worker-a', principalId: 'system:superuser', sessionId: 'worker-a',
        }, desired: revision, prepared: null, applied: revision,
      },
    };
    let attestationRow = { native_session_id: 'native-worker-a' as string | null,
      session_backend: 'claude' as 'claude' | 'codex', operation_receipt_id: 19 as number | null };
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join('');
      if (query.includes('SELECT id, role')) return [{ id: 7, role: 'worker' }];
      if (query.includes('SELECT s.session_id AS native_session_id')) {
        return [attestationRow];
      }
      return [row];
    });
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation: {
      ...operation, id: 'run', policy: { ...operation.policy, model: modelPolicy },
    } });
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a')).toEqual({
      status: 'bound', policy: modelPolicy,
      attestation: { operationReceiptId: 19, advSessionId: 7, nativeSessionId: 'native-worker-a',
        workspaceId: 'ws-a', ownerId: 'worker-a', harnessSlug: 'harness-a', workItemId: 'WI-1',
        operationId: 'run',
        specificationRevision: REVISION },
    });

    attestationRow = { native_session_id: null, session_backend: 'claude', operation_receipt_id: null };
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a')).toEqual({
      status: 'bound', policy: modelPolicy, attestation: null,
    });

    const codexPolicy = { mode: 'exact' as const, models: ['gpt-5.6-sol'],
      effort: 'high', onUnavailable: 'fail' as const };
    row.accepted_operation = { ...accepted, modelPolicy: codexPolicy,
      modelSelection: { model: 'gpt-5.6-sol:high', requestedModel: null,
        backend: 'codex', source: 'operation-policy' } };
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation: {
      ...operation, id: 'run', policy: { ...operation.policy, model: codexPolicy },
    } });
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a', 'codex')).toEqual({
      status: 'unavailable', reason: 'accepted operation backend differs from its active worker session',
    });
    attestationRow.session_backend = 'codex';
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a', 'codex')).toEqual({
      status: 'bound', policy: codexPolicy, attestation: null,
    });
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a', 'claude')).toEqual({
      status: 'unavailable', reason: 'accepted operation model selection differs from its policy',
    });
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation: {
      ...operation, id: 'run', policy: { ...operation.policy, model: modelPolicy },
    } });
    attestationRow.session_backend = 'claude';

    row.accepted_operation = { ...accepted, modelPolicy: { ...modelPolicy, models: ['claude-sonnet-4-6'] } };
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a')).toEqual({
      status: 'unavailable', reason: 'accepted operation model policy differs from its launch receipt',
    });
    row.accepted_operation = accepted;
    readAcceptedBlueprintDirectWorkItem.mockResolvedValueOnce({ pin: { ...pin, input: { changed: true } },
      operation: { ...operation, id: 'run', policy: { ...operation.policy, model: modelPolicy } } });
    expect(await readActiveOperationModelPolicy('ws-a', 'worker-a')).toEqual({
      status: 'unavailable', reason: 'accepted operation model pin changed',
    });
  });

  it('refuses a different role or harness', async () => {
    await expect(resolveAcceptedOperationWorkerBinding({ ...args, role: 'reviewer' }))
      .rejects.toThrow('does not authorize this worker role');
    getWorkItem.mockResolvedValue({ ...item, harness: 'harness-b' });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('in its harness');
  });

  it('refuses a moved identity source or a changed source version', async () => {
    getIdentitySource.mockResolvedValue({ ...source, contentHash: 'c'.repeat(64) });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('differs from its pinned revision');
    getIdentitySource.mockResolvedValue({ ...source, identity: { ...source.identity, version: '0.2.0' } });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('differs from its pinned revision');
  });

  it('refuses an unpinned identity or a multi-slot worker identity', async () => {
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation: {
      ...operation, policy: { ...operation.policy, identity: undefined },
    } });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('no pinned worker identity');
    readAcceptedBlueprintDirectWorkItem.mockResolvedValue({ pin, operation });
    getIdentitySource.mockResolvedValue({ ...source, identity: {
      ...source.identity, slots: [{ slot: 'domain' }, { slot: 'practice' }],
    } });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('exactly the domain slot');
    getIdentitySource.mockResolvedValue({ ...source, identity: { ...source.identity, grants: undefined } });
    await expect(resolveAcceptedOperationWorkerBinding(args)).rejects.toThrow('declare grants explicitly');
  });
});

describe('describeOperationReceiptReadFault (EI-24400810686776632)', () => {
  const generic = 'active operation worker receipt could not be read';

  it('names a missing relation, so a fixture that never built adv_sessions says so', () => {
    const err = Object.assign(new Error('relation "harness_shared.adv_sessions" does not exist'), { code: '42P01' });
    const reason = describeOperationReceiptReadFault(err);
    expect(reason.startsWith(`${generic}: `)).toBe(true);
    expect(reason).toContain('harness_shared.adv_sessions');
    expect(reason).toContain('42P01');
  });

  it('names a missing column the same way', () => {
    const err = Object.assign(new Error('column s.launch_spec does not exist'), { code: '42703' });
    expect(describeOperationReceiptReadFault(err)).toContain('s.launch_spec');
  });

  it('keeps the generic reason for transient and unknown faults', () => {
    expect(describeOperationReceiptReadFault(Object.assign(new Error('Connection terminated'), { code: '57P01' }))).toBe(generic);
    expect(describeOperationReceiptReadFault(new Error('boom'))).toBe(generic);
    expect(describeOperationReceiptReadFault(undefined)).toBe(generic);
    expect(describeOperationReceiptReadFault({ code: '42P01', message: '' })).toBe(generic);
  });
});
