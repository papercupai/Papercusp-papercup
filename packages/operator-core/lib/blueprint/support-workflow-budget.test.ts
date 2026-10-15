import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSupportWorkflowBudgetController, supportOperationReservationId } from './support-workflow-budget';
import { processMonotonicClock } from '../process-monotonic-clock';
import type { NativeGymProviderAuthorization } from '../gym/proposer';
import type { GatewayCarryTrialAttempt } from '../inference-gateway/gateway';

const handle = { workspaceId: 'w', harnessSlug: 'support', receiptId: 12,
  operationId: 'handoff', specificationRevision: 'a'.repeat(64), target: { kind: 'work-item' as const, id: 'WI-12' } };
const funding = { organization: { controlWorkspaceId: 'w', organizationId: 'org' }, allocationId: 'project', month: '2026-10' };
function attempt(): GatewayCarryTrialAttempt {
  const body = JSON.stringify({ model: 'gpt-6.1-sol', max_output_tokens: 100 });
  return { attemptId: randomUUID(), manifestSha256: handle.specificationRevision,
    armId: supportOperationReservationId(handle), transport: 'bearer-http', accountId: 'account',
    target: 'https://api.openai.com/v1/responses', credentialHeader: 'authorization',
    credentialSha256: 'c'.repeat(64), body, bodySha256: createHash('sha256').update(body).digest('hex'),
    clockId: processMonotonicClock.id, signal: new AbortController().signal };
}
function authority(value: GatewayCarryTrialAttempt): NativeGymProviderAuthorization {
  return { attemptKind: 'evaluation', requestedUsd: 0.04, inputTokens: 100, outputTokens: 100,
    validUntilMonotonicMs: processMonotonicClock.now() + 5000, validateAuthorization() {},
    inputEvidence: { kind: 'provider-input-count', bodySha256: value.bodySha256,
      countBodySha256: 'c'.repeat(64), responseSha256: 'd'.repeat(64), sourceSha256: 'e'.repeat(64),
      requestId: null, measuredInputTokens: 100 } };
}
function setup(authenticateProvider = vi.fn(async (value: GatewayCarryTrialAttempt) => authority(value))) {
  const reserveAttempt = vi.fn(async () => true);
  const validateOperationAuthority = vi.fn(async () => {});
  const controller = createSupportWorkflowBudgetController({ handle, funding, maximumCostMicros: 100_000,
    authenticateProvider, reserveAttempt, validateOperationAuthority });
  return { ...controller, authenticateProvider, reserveAttempt, validateOperationAuthority };
}
describe('support operation native budget authority', () => {
  it('reserves only authenticated native exposure and rechecks revocation at the actual send', async () => {
    const c = setup(), value = attempt();
    const receipt = await c.binding.authorizeAttempt(value);
    expect(c.reserveAttempt).toHaveBeenCalledWith(expect.objectContaining({ attemptMaximumMicros: 40_000,
      operationMaximumMicros: 100_000, bodySha256: value.bodySha256 }));
    expect(receipt?.validateAuthorization?.()).toBeUndefined();
    c.revoke();
    expect(() => receipt?.validateAuthorization?.()).toThrow(/revoked/);
  });
  it.each(['wrong-revision', 'changed-body', 'aborted', 'foreign-clock'])('refuses %s before authentication or reservation', async kind => {
    const c = setup(), value = attempt();
    const aborted = new AbortController(); aborted.abort();
    const bad = { ...value, ...(kind === 'wrong-revision' ? { manifestSha256: 'b'.repeat(64) }
      : kind === 'changed-body' ? { body: '{}' } : kind === 'aborted' ? { signal: aborted.signal } : { clockId: 'foreign' }) };
    expect(await c.binding.authorizeAttempt(bad)).toBeNull();
    expect(c.authenticateProvider).not.toHaveBeenCalled();
    expect(c.reserveAttempt).not.toHaveBeenCalled();
  });
  it('refuses a reservation when authentication completes after revocation', async () => {
    let finish!: (value: NativeGymProviderAuthorization) => void;
    const c = setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const value = attempt(), pending = c.binding.authorizeAttempt(value);
    await vi.waitFor(() => expect(c.authenticateProvider).toHaveBeenCalledOnce());
    c.revoke(); finish(authority(value));
    expect(await pending).toBeNull();
    expect(c.reserveAttempt).not.toHaveBeenCalled();
  });
  it.each(['stop', 'claim-loss', 'source-revocation', 'worker-replacement'])(
    'refuses %s during native input counting before reserving or sending', async reason => {
      let finish!: (value: NativeGymProviderAuthorization) => void;
      const c = setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
      const value = attempt(), pending = c.binding.authorizeAttempt(value);
      await vi.waitFor(() => expect(c.authenticateProvider).toHaveBeenCalledOnce());
      c.validateOperationAuthority.mockRejectedValue(new Error(reason));
      finish(authority(value));
      expect(await pending).toBeNull();
      expect(c.reserveAttempt).not.toHaveBeenCalled();
    });
  it('does not begin provider input counting without current operation and source authority', async () => {
    const c = setup(); c.validateOperationAuthority.mockRejectedValue(new Error('revoked'));
    expect(await c.binding.authorizeAttempt(attempt())).toBeNull();
    expect(c.authenticateProvider).not.toHaveBeenCalled();
    expect(c.reserveAttempt).not.toHaveBeenCalled();
  });
  it('retains the funding hold but refuses a send when control changes while reservation waits', async () => {
    const c = setup();
    c.reserveAttempt.mockImplementationOnce(async () => {
      c.validateOperationAuthority.mockRejectedValue(new Error('stopped'));
      return true;
    });
    expect(await c.binding.authorizeAttempt(attempt())).toBeNull();
    expect(c.reserveAttempt).toHaveBeenCalledOnce();
  });
  it.each(['over-cap', 'no-input-proof', 'foreign-body', 'expired'])('refuses %s authority without reserving', async kind => {
    const c = setup(vi.fn(async value => {
      const a = authority(value);
      if (kind === 'over-cap') a.requestedUsd = 1;
      if (kind === 'no-input-proof') delete a.inputEvidence;
      if (kind === 'foreign-body') a.inputEvidence!.bodySha256 = 'f'.repeat(64);
      if (kind === 'expired') a.validUntilMonotonicMs = 0;
      return a;
    }));
    expect(await c.binding.authorizeAttempt(attempt())).toBeNull();
    expect(c.reserveAttempt).not.toHaveBeenCalled();
  });
  it('cannot send when the durable operation or P009 allocation is exhausted', async () => {
    const c = setup(); c.reserveAttempt.mockResolvedValue(false);
    expect(await c.binding.authorizeAttempt(attempt())).toBeNull();
  });
  it('binds a restarted controller to the same receipt reservation while separating revisions', () => {
    expect(setup().binding.armId).toBe(setup().binding.armId);
    expect(supportOperationReservationId({ ...handle, specificationRevision: 'b'.repeat(64) }))
      .not.toBe(supportOperationReservationId(handle));
  });
});
