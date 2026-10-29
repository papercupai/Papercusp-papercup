import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  defaultSql: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: mocks.defaultSql }),
}));
vi.mock('../pg-bounded-txn', () => ({ boundedOrgTxn: mocks.transaction }));

import { PgAdmissionLedgerQueueStore } from './admission-ledger-store';
import { PgAdmissionCutoverQueueStore } from './admission-cutover-store';
import { PgWorkItemAdmissionQueueStore } from './queue';
import {
  resetGovernedExecutionRuntimesForTests,
  setGovernedProcessClientFactoryForTests,
  withGovernedProcessRuntime,
} from './execution';

describe('admission ledger acquisition attribution', () => {
  it('labels mark-running timeout phases at the exact ledger statement', async () => {
    const sql = vi.fn((strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('SELECT receipt_id, record')) {
        return Promise.resolve([{
          receipt_id: 'RG-phase-test',
          record: {
            schemaVersion: 1,
            namespace: 'integration',
            idempotencyKey: 'phase-test',
            requestFingerprint: 'fingerprint',
            admissionClass: 'process',
            priority: 0,
            deadlineAtMs: null,
            demand: {},
            payloadRef: null,
            coalesceKey: null,
            metadata: {},
            context: {},
            state: 'leased',
            enqueuedAtMs: 1,
            updatedAtMs: 1,
            decision: { generation: 1, atMs: 1, reason: 'leased', evidence: {} },
            lease: { leaseId: 'lease-1', owner: 'worker', generation: 1, expiresAtMs: 1000 },
          },
        }]);
      }
      if (statement.includes('UPDATE harness_shared.resource_governor_admissions')) {
        return Promise.reject(new Error('simulated update timeout'));
      }
      return 'FOR UPDATE';
    });
    let phaseAtFailure: string | undefined;
    mocks.transaction.mockReset().mockImplementation(async (fn, options) => {
      try {
        return await fn(sql as never);
      } catch (error) {
        phaseAtFailure = options?.phase?.();
        throw error;
      }
    });
    const store = new PgAdmissionLedgerQueueStore({ workspaceId: 'phase-test', sql: sql as never });

    await expect(store.markRunning('RG-phase-test', 'lease-1', 2)).rejects.toThrow('simulated update timeout');
    expect(phaseAtFailure).toBe('resource-governor.admission-ledger.mark-running.update');
  });

  it.each([
    [PgAdmissionLedgerQueueStore, false],
    [PgAdmissionLedgerQueueStore, true],
    [PgAdmissionCutoverQueueStore, false],
    [PgAdmissionCutoverQueueStore, true],
    [PgWorkItemAdmissionQueueStore, false],
    [PgWorkItemAdmissionQueueStore, true],
  ] as const)('tracks the default pool for %s (injected=%s)', async (Store, injected) => {
    const sql = vi.fn();
    const failure = new Error('stop before transaction body');
    mocks.transaction.mockReset().mockRejectedValue(failure);
    const store = new Store({
      workspaceId: 'acquisition-test',
      ...(injected ? { sql: sql as never } : {}),
    });
    await expect(store.enqueue({} as never)).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      client: injected ? sql : mocks.defaultSql,
      acquirePool: injected ? undefined : 'org-admin',
    });
  });

  it.each([
    PgAdmissionLedgerQueueStore,
    PgAdmissionCutoverQueueStore,
    PgWorkItemAdmissionQueueStore,
  ])('preserves explicit acquisition attribution through %s', async (Store) => {
    const sql = vi.fn();
    const failure = new Error('stop before transaction body');
    mocks.transaction.mockReset().mockRejectedValue(failure);
    const store = new Store({
      workspaceId: 'acquisition-test',
      sql: sql as never,
      acquirePool: 'registered-test-pool',
    });
    await expect(store.enqueue({} as never)).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      client: sql,
      acquirePool: 'registered-test-pool',
    });
  });

  it('attributes process-runtime admission transactions to the registered dedicated pool', async () => {
    resetGovernedExecutionRuntimesForTests();
    const sql = vi.fn() as never;
    const failure = new Error('stop before transaction body');
    mocks.transaction.mockReset().mockRejectedValue(failure);
    setGovernedProcessClientFactoryForTests(() => ({ sql, async end() {} }));

    try {
      await expect(withGovernedProcessRuntime('acquisition-test', 'governed-process', async ({ driver }) => {
        const store = (driver as unknown as { store: PgAdmissionCutoverQueueStore }).store;
        await store.enqueue({} as never);
      })).rejects.toBe(failure);

      expect(mocks.transaction).toHaveBeenCalledTimes(1);
      expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
        client: sql,
        acquirePool: 'org-admin-governed-process',
      });
    } finally {
      resetGovernedExecutionRuntimesForTests();
      setGovernedProcessClientFactoryForTests(null);
    }
  });
});
