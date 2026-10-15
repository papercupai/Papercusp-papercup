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
});
