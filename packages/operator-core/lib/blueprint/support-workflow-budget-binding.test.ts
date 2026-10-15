import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentRequestWorkspaceId, runWithWorkspace } from '../workspace-als';
import { processMonotonicClock } from '../process-monotonic-clock';
import { readSupportOperationBudgetBinding } from './support-workflow-budget';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialBinding } from '../inference-gateway/gateway';
import type { NativeGymProviderAuthorization } from '../gym/proposer';

const ports = vi.hoisted(() => ({ worker: vi.fn(), accepted: vi.fn(), item: vi.fn(),
  provider: vi.fn(), source: vi.fn(), sql: vi.fn() }));
vi.mock('./operation-worker-binding', () => ({ readActiveOperationWorkerClaimBinding: ports.worker }));
vi.mock('./operation-admission', () => ({ readAcceptedBlueprintDirectWorkItem: ports.accepted }));
vi.mock('../work-items', () => ({ getWorkItem: ports.item }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: ports.sql }) }));
vi.mock('../external-bench/current-su', () => ({ createNativeProviderAuthenticator: () => ({ authenticateProvider: ports.provider }) }));
vi.mock('./support-workflow-operation', () => ({ supportWorkflowFromOperation: () => ({ id: 'approved-support' }) }));
vi.mock('./support-workflow-case', () => ({ readSelectedSupportCase: ports.source }));

const workspaceId = 'budget-workspace', ownerId = 'support-worker', revision = 'a'.repeat(64);
const pin = { kind: 'blueprint-operation', harnessSlug: 'support', operationId: 'handoff',
  operationVersion: '1', specificationRevision: revision, input: { supportCaseId: 'case-a' },
  callerId: '12345678-1234-4234-8234-123456789012/employee', requestKey: 'case-a' };
const worker = { status: 'bound', binding: { workItemId: 'WI-12', harnessSlug: 'support', storageHarnessSlug: 'support',
  operationId: 'handoff', specificationRevision: revision, pin }, receipt: { sessionId: 4, ownerId,
  workspaceId, specificationRevision: revision, stateRevision: 'state-a', acceptedOperation: {} } };
const item = { id: 'WI-12', harness: 'support', assignee: ownerId, state: 'wip', payload: {} };
const operation = { id: 'handoff', execution: { kind: 'agent', role: 'support-role' }, policy: {
  model: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium' }, supportCase: {
    maximumCostMicros: 100_000,
    funding: { organization: { controlWorkspaceId: workspaceId, organizationId: 'synthetic-org' },
      allocationId: 'synthetic-project', month: '2026-10' },
    native: { payer: 'api-key', model: 'gpt-6.1-sol', effort: 'medium', account: 'auto',
      inputTokenCeiling: 1000, outputTokenCeiling: 100 },
  } } };
function attempt(binding: GatewayCarryTrialBinding): GatewayCarryTrialAttempt {
  const body = JSON.stringify({ model: 'gpt-6.1-sol', max_output_tokens: 100 });
  return { attemptId: randomUUID(), manifestSha256: binding.manifestSha256, armId: binding.armId,
    transport: 'bearer-http', accountId: 'synthetic', target: 'https://api.openai.com/v1/responses',
    credentialHeader: 'authorization', credentialSha256: 'c'.repeat(64), body,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    clockId: processMonotonicClock.id, signal: new AbortController().signal };
}
function authority(value: GatewayCarryTrialAttempt): NativeGymProviderAuthorization {
  return { attemptKind: 'evaluation', requestedUsd: 0.04, inputTokens: 1000, outputTokens: 100,
    validUntilMonotonicMs: processMonotonicClock.now() + 5000, validateAuthorization() {},
    inputEvidence: { kind: 'provider-input-count', bodySha256: value.bodySha256,
      countBodySha256: 'c'.repeat(64), responseSha256: 'd'.repeat(64), sourceSha256: 'e'.repeat(64),
      requestId: null, measuredInputTokens: 1000 } };
}
beforeEach(() => {
  vi.resetAllMocks();
  ports.worker.mockResolvedValue(structuredClone(worker));
  ports.accepted.mockResolvedValue({ pin: structuredClone(pin), operation: structuredClone(operation) });
  ports.item.mockResolvedValue(structuredClone(item));
  ports.sql.mockResolvedValue([{ id: 12 }]);
  ports.source.mockResolvedValue({ allowed: true, results: [] });
  ports.provider.mockResolvedValue(null);
});
describe('support native binding current authority', () => {
  it('refuses an item pin that differs from the applied worker even within the same revision', async () => {
    ports.accepted.mockResolvedValue({ operation, pin: { ...pin, input: { supportCaseId: 'changed-case' } } });
    await expect(readSupportOperationBudgetBinding(workspaceId, ownerId)).rejects.toThrow(/pin|authority/);
    expect(ports.provider).not.toHaveBeenCalled();
  });
  it('re-enters the bound workspace when the returned callback runs in another request', async () => {
    const seen: Array<string | undefined> = [];
    ports.item.mockImplementation(async () => { seen.push(currentRequestWorkspaceId()); return structuredClone(item); });
    const binding = await readSupportOperationBudgetBinding(workspaceId, ownerId);
    expect(binding).not.toBeNull();
    await runWithWorkspace('other-workspace', () => binding!.authorizeAttempt(attempt(binding!)));
    expect(ports.provider).toHaveBeenCalledOnce();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every(value => value === workspaceId)).toBe(true);
  });
  it.each(['stop', 'claim-loss', 'source-revocation', 'worker-replacement'] as const)(
    'refuses actual %s changes during provider counting before budget storage', async reason => {
      const binding = (await readSupportOperationBudgetBinding(workspaceId, ownerId))!;
      let finish!: (value: NativeGymProviderAuthorization) => void;
      ports.provider.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const value = attempt(binding), pending = binding.authorizeAttempt(value);
      await vi.waitFor(() => expect(ports.provider).toHaveBeenCalledOnce());
      if (reason === 'stop') ports.item.mockResolvedValue({ ...item, payload: { blueprintCancellation: { reason: 'stop' } } });
      if (reason === 'claim-loss') ports.item.mockResolvedValue({ ...item, assignee: 'other-worker' });
      if (reason === 'source-revocation') ports.source.mockResolvedValue({ allowed: false, reason: 'no_live_grant' });
      if (reason === 'worker-replacement') ports.worker.mockResolvedValue({ ...worker,
        receipt: { ...worker.receipt, stateRevision: 'state-b' } });
      finish(authority(value));
      expect(await pending).toBeNull();
      // Only the initial invocation lookup ran; no reservation transaction.
      expect(ports.sql).toHaveBeenCalledOnce();
    });
});
