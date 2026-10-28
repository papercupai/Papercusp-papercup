/**
 * Regression coverage for the datastore legs used by service-health.
 *
 * These reads run while diagnosing a restarting bg-host, so they must enter the
 * shared bounded read-only transaction rather than acquiring a raw org-PG
 * client whose promise can outlive the MCP request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { boundedPgReadTxnMock, listRuntimeVintageMock } = vi.hoisted(() => ({
  boundedPgReadTxnMock: vi.fn(),
  listRuntimeVintageMock: vi.fn(),
}));

vi.mock('./pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pg-read-query')>()),
  boundedPgReadTxn: (...args: unknown[]) => boundedPgReadTxnMock(...args),
}));

vi.mock('./runtime-vintage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtime-vintage')>()),
  listRuntimeVintage: (...args: unknown[]) => listRuntimeVintageMock(...args),
}));

import {
  PG_READ_TXN_DEFAULT_ACQUIRE_TIMEOUT_MS,
  PG_READ_TXN_DEFAULT_TIMEOUT_MS,
} from './pg-read-query';
import {
  probeBgHostTicker,
  readRuntimeVintageForServiceHealth,
} from './service-health';

const NOW = Date.parse('2026-09-09T17:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('service-health bounded datastore reads', () => {
  it('runs the bg-host ticker query through boundedPgReadTxn with explicit deadlines', async () => {
    const query = vi.fn(async () => [{ last: new Date(NOW - 30_000) }]);
    const tx = Object.assign(query, { unsafe: vi.fn(async () => []) });
    boundedPgReadTxnMock.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));

    const result = await probeBgHostTicker(NOW);

    expect(result).toMatchObject({ name: 'bg-host-ticker', up: true });
    expect(query).toHaveBeenCalledTimes(1);
    const queryCalls = query.mock.calls as unknown as unknown[][];
    expect(String(queryCalls[0]?.[0])).toContain('MAX(last_fired_at)');
    // WI-6554700010042546: only DBOS-fired (durable) routines prove the DBOS ticker
    // alive. Ephemeral-executor fires kept this probe green through a dead DBOS.
    expect(String(queryCalls[0]?.[0])).toMatch(/\btier\s*=\s*'durable'/);
    expect(boundedPgReadTxnMock).toHaveBeenCalledWith(
      expect.any(Function),
      {
        timeoutMs: PG_READ_TXN_DEFAULT_TIMEOUT_MS,
        acquireTimeoutMs: PG_READ_TXN_DEFAULT_ACQUIRE_TIMEOUT_MS,
      },
    );
  });

  it('passes the bounded transaction client into the runtime-vintage store', async () => {
    const tx = Object.assign(vi.fn(async () => []), { unsafe: vi.fn(async () => []) });
    boundedPgReadTxnMock.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn(tx));
    listRuntimeVintageMock.mockResolvedValue([]);

    await expect(readRuntimeVintageForServiceHealth()).resolves.toEqual([]);

    expect(listRuntimeVintageMock).toHaveBeenCalledWith(undefined, tx);
    expect(boundedPgReadTxnMock).toHaveBeenCalledWith(
      expect.any(Function),
      {
        timeoutMs: PG_READ_TXN_DEFAULT_TIMEOUT_MS,
        acquireTimeoutMs: PG_READ_TXN_DEFAULT_ACQUIRE_TIMEOUT_MS,
      },
    );
  });

  it('turns a bounded ticker timeout into an honest unknown result', async () => {
    boundedPgReadTxnMock.mockRejectedValue(new Error('db-call-deadline: ticker read'));

    await expect(probeBgHostTicker(NOW)).resolves.toMatchObject({
      name: 'bg-host-ticker',
      up: true,
      present: false,
      note: 'ticker liveness unknown (routines read failed)',
    });
  });
});
