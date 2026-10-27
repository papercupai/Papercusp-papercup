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
