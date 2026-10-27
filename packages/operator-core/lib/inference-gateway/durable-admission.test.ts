import { describe, expect, it, vi } from 'vitest';
import { AdmissionPersistenceError, Governor } from '../resource-governor/admission';
// The in-memory store used to be a ~130-line copy inline here, and near-identical
// copies still live in resource-governor/{queue,execution}.test.ts. P-014 needed a
// store that survives driver reconstruction, so the copy was promoted to a shared
// seam rather than duplicated a fourth time.
import { MemoryAdmissionQueueStore } from '../resource-governor/memory-admission-queue-store';
import { DurableGatewayAdmissionDriver, createDurableGatewayAdmissionGovernor } from './durable-admission';

function request() {
  return {
    idempotencyKey: 'gateway:test:1',
    admissionClass: 'inference',
    demand: { providerRequests: 1 },
    metadata: { 'gateway.ownerId': 'owner-test' },
  } as const;
}

describe('DurableGatewayAdmissionDriver', () => {
  it.each(['throw', 'rejected'] as const)('fences stale cleanup when markRunning is %s after another owner takes over', async failure => {
    const store = new MemoryAdmissionQueueStore();
    const original = createDurableGatewayAdmissionGovernor({ store, namespace: 'gateway-test',
      now: () => 1_000, leaseIdFactory: () => 'lease-original' });
    const replacement = createDurableGatewayAdmissionGovernor({ store, namespace: 'gateway-test',
      now: () => 1_000, leaseIdFactory: () => 'lease-replacement' });
    let replacementContext: Parameters<typeof replacement.release>[0] | undefined;
    vi.spyOn(original.driver.queue, 'markRunning').mockImplementationOnce(async (receiptId, leaseId) => {
      await original.driver.queue.releaseLease(receiptId, leaseId);
      const outcome = await replacement.admit(request());
      expect(outcome.kind).toBe('admitted');
      replacementContext = outcome.context;
      if (failure === 'throw') throw new AdmissionPersistenceError('lost transition response');
      return null;
    });
    await expect(original.admit(request())).rejects.toBeInstanceOf(AdmissionPersistenceError);
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('running');
    expect(replacementContext?.leaseId).toBe('lease-replacement');
    expect((await replacement.release(replacementContext!)).released).toBe(true);
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('completed');
  });

  it('persists, leases, marks running, and releases one synchronous request', async () => {
    const store = new MemoryAdmissionQueueStore();
    const driver = new DurableGatewayAdmissionDriver({
      store,
      namespace: 'gateway-test',
      now: () => 1_000,
      leaseIdFactory: () => 'lease-test',
    });
    const governor = new Governor(driver, { now: () => 1_000, idFactory: () => 'request-test' });
    const outcome = await governor.admit(request());
    expect(outcome).toMatchObject({ kind: 'admitted', context: { receiptId: 'WI-1', leaseId: 'lease-test' } });
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('running');
    const released = await governor.release(outcome.context, { providerRequests: 1 });
    expect(released.released).toBe(true);
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('completed');
  });

  it('does not return a false receipt when persistence fails', async () => {
    const store = new MemoryAdmissionQueueStore();
    store.fail = true;
    const governor = createDurableGatewayAdmissionGovernor({ store, namespace: 'gateway-test' });
    await expect(governor.admit(request())).rejects.toBeInstanceOf(AdmissionPersistenceError);
  });

  it('rejects a replay after the first lease is running instead of starting a second upstream call', async () => {
    const store = new MemoryAdmissionQueueStore();
    const first = createDurableGatewayAdmissionGovernor({
      store,
      namespace: 'gateway-test',
      now: () => 1_000,
      leaseIdFactory: () => 'lease-first',
    });
    const outcome = await first.admit(request());
    expect(outcome.kind).toBe('admitted');
    await expect(
      createDurableGatewayAdmissionGovernor({
        store,
        namespace: 'gateway-test',
        now: () => 1_000,
        leaseIdFactory: () => 'lease-replay',
      }).admit(request()),
    ).rejects.toBeInstanceOf(AdmissionPersistenceError);
    await first.release(outcome.context);
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('completed');
  });

  it('reconciles an expired running receipt before an idempotent targeted retry', async () => {
    const store = new MemoryAdmissionQueueStore();
    const first = createDurableGatewayAdmissionGovernor({
      store,
      namespace: 'gateway-test',
      now: () => 1_000,
      leaseTtlMs: 100,
      leaseIdFactory: () => 'lease-expired',
    });
    const original = await first.admit(request());
    expect(original).toMatchObject({ kind: 'admitted', lease: { leaseId: 'lease-expired' } });

    const retry = createDurableGatewayAdmissionGovernor({
      store,
      namespace: 'gateway-test',
      now: () => 1_101,
      leaseTtlMs: 100,
      leaseIdFactory: () => 'lease-retry',
    });
    await expect(retry.admit(request())).resolves.toMatchObject({
      kind: 'admitted',
      lease: { leaseId: 'lease-retry', generation: 4 },
    });
    expect(store.state('gateway-test', request().idempotencyKey)).toBe('running');
  });
});
