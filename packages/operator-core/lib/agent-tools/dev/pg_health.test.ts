/**
 * dev:pg_health surfaces a latched store-identity violation
 * (plan outage-must-not-be-silent-2026-08-02, D-004).
 *
 * The guard's DETECTION is tested in the db package. What is tested here is DELIVERY — that
 * the verdict reaches a surface an agent actually reads while diagnosing. On 2026-08-02 six
 * separate guards were active and the outage still read as silence, because every one of them
 * reported into a log file or a service journal. A guard nobody is shown has not spoken.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../dev-data', () => ({
  pgHealth: vi.fn(async () => ({ version: 'PostgreSQL 16.4', total: 12, active: 3, idle: 9 })),
}));

import {
  _resetStoreIdentityForTests,
  beginAcquire,
  capturePgDiagnosticContext,
  pinOrVerifyStoreIdentity,
  setPgDiagnosticContextResolver,
  resetPgDiagnosticContextResolver,
  resetAcquireRegistryForTest,
} from '@papercusp/db-org';
import { recordPgResult } from '../../../../../libs/papercusp/libs/db/src/acquire-registry';
import { pgHealth } from '../../dev-data';
import pgHealthTool from './pg_health';

const OURS = { systemIdentifier: '7635091775813704249', database: 'papercusp' };
const IMPOSTOR = { systemIdentifier: '7111222333444555666', database: 'papercusp' };

// Via `unknown`: the tool's declared arg/event generics do not overlap this narrowed shape,
// and TS2352 correctly refuses the direct assertion.
const run = (args: { localOnly?: boolean; resultLimitPerPool?: number } = {}) =>
  (pgHealthTool as unknown as {
    handler: (a: unknown) => Promise<{ data: Record<string, any> }>;
  }).handler(args);

const recordResult = (
  pool = 'org-app',
  queryId = 1,
  status: 'ok' | 'error' = 'ok',
  context?: unknown,
) =>
  recordPgResult(pool, {
    connectionId: 2,
    queryId,
    backendPid: 8123,
    query: "SELECT id FROM harness_shared.sample WHERE token = 'never-retain-secret'",
    command: 'SELECT',
    rowCount: 7,
    wireBytes: 2048,
    elapsedMs: 25,
    status,
    errorCode: status === 'error' ? '42P01' : null,
    context,
  });

beforeEach(() => {
  _resetStoreIdentityForTests();
  resetAcquireRegistryForTest();
  resetPgDiagnosticContextResolver();
  vi.mocked(pgHealth).mockClear();
});

describe('dev:pg_health completed-result delivery', () => {
  it('delivers pending acquisition separately from completed results without a database query', async () => {
    beginAcquire('org-admin');
    const { data } = await run({ localOnly: true });
    expect(pgHealth).not.toHaveBeenCalled();
    expect(data.acquisitionDiagnostics).toMatchObject({
      source: 'current-process',
      pid: process.pid,
      coverage: 'registered-acquisition-tickets-in-selected-pools-only',
    });
    expect(data.acquisitionDiagnostics.pools[1]).toMatchObject({
      counters: { pool: 'org-admin', waiting: 1, held: 0 },
      tickets: { pool: 'org-admin', active: 1, tickets: [{ state: 'waiting' }] },
    });
    expect(data.processDiagnostics.pools[1].results).toEqual([]);
  });
  it.each([
    { label: 'is explicitly configured', value: '24', expected: '24' },
    { label: 'is unset', value: undefined, expected: null },
  ])('reports the raw PAPERCUSP_DB_POOL_MAX override when it $label', async ({ value, expected }) => {
    const previous = process.env.PAPERCUSP_DB_POOL_MAX;
    if (value === undefined) delete process.env.PAPERCUSP_DB_POOL_MAX;
    else process.env.PAPERCUSP_DB_POOL_MAX = value;

    try {
      const { data } = await run({ localOnly: true });
      expect(data.acquisitionDiagnostics).toMatchObject({
        source: 'current-process',
        pid: process.pid,
        poolConfiguration: { PAPERCUSP_DB_POOL_MAX: expected },
      });
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_DB_POOL_MAX;
      else process.env.PAPERCUSP_DB_POOL_MAX = previous;
    }
  });
  it('delivers safe current-process records through the public production reader', async () => {
    recordResult();

    const { data } = await run();
    const diagnostic = data.processDiagnostics;

    expect(data.version).toBe('PostgreSQL 16.4');
    expect(pgHealth).toHaveBeenCalledOnce();
    expect(diagnostic).toMatchObject({
      source: 'current-process',
      pid: process.pid,
      coverage: 'completed-results-and-recent-failures-in-selected-pools-only',
      resultLimitPerPool: 4,
    });
    expect(Number.isFinite(Date.parse(diagnostic.capturedAt))).toBe(true);
    expect(diagnostic.pools.map((pool: { pool: string }) => pool.pool)).toEqual([
      'org-app',
      'org-admin',
      'org-admin-lossless-bigint',
    ]);
    expect(diagnostic.pools[0].results).toEqual([
      expect.objectContaining({
        pool: 'org-app',
        backendPid: 8123,
        queryFamily: 'select:harness_shared.sample',
        command: 'select',
        rowCount: 7,
        wireBytes: 2048,
        elapsedMs: 25,
      }),
    ]);
    expect(JSON.stringify(diagnostic)).not.toMatch(/never-retain-secret|SELECT id|WHERE token/);
    expect(diagnostic.pools[0].results[0]).not.toHaveProperty('query');
    expect(diagnostic.pools[0].results[0]).not.toHaveProperty('rows');
    expect(diagnostic.pools[0].results[0]).not.toHaveProperty('parameters');
  });

  it('can read the local ring without querying the database', async () => {
    recordResult('org-admin');

    const { data } = await run({ localOnly: true });

    expect(pgHealth).not.toHaveBeenCalled();
    expect(data).not.toHaveProperty('version');
    expect(data.processDiagnostics.pools[1]).toMatchObject({ observed: true, totalRecorded: 1 });
  });

  it('distinguishes ring eviction from the bounded presentation window', async () => {
    for (let queryId = 1; queryId <= 40; queryId += 1) recordResult('org-app', queryId);

    const { data } = await run({ localOnly: true });
    const pool = data.processDiagnostics.pools[0];

    expect(pool).toMatchObject({
      capacity: 32,
      totalRecorded: 40,
      dropped: 8,
      retained: 32,
      omittedRetained: 28,
      observed: true,
    });
    expect(pool.results.map((result: { queryId: number }) => result.queryId)).toEqual([37, 38, 39, 40]);
  });

  it('can expose the complete retained ring without confusing eviction with omission', async () => {
    for (let queryId = 1; queryId <= 40; queryId += 1) recordResult('org-admin', queryId);

    const { data } = await run({ localOnly: true, resultLimitPerPool: 32 });
    const diagnostic = data.processDiagnostics;
    const pool = diagnostic.pools[1];

    expect(pgHealth).not.toHaveBeenCalled();
    expect(diagnostic.resultLimitPerPool).toBe(32);
    expect(pool).toMatchObject({ totalRecorded: 40, dropped: 8, retained: 32, omittedRetained: 0 });
    expect(pool.results.map((result: { queryId: number }) => result.queryId)).toEqual(
      Array.from({ length: 32 }, (_, i) => i + 9),
    );
    expect(JSON.stringify(diagnostic)).not.toMatch(/never-retain-secret|SELECT id|WHERE token/);
  });

  it('returns the requested bounded window across pools', async () => {
    for (const pool of ['org-app', 'org-admin', 'org-admin-lossless-bigint']) {
      for (let queryId = 1; queryId <= 6; queryId += 1) recordResult(pool, queryId);
    }

    const { data } = await run({ localOnly: true, resultLimitPerPool: 2 });

    expect(data.processDiagnostics.resultLimitPerPool).toBe(2);
    for (const pool of data.processDiagnostics.pools) {
      expect(pool).toMatchObject({ retained: 6, omittedRetained: 4 });
      expect(pool.results.map((result: { queryId: number }) => result.queryId)).toEqual([5, 6]);
    }
  });

  it('rejects invalid presentation limits at the public argument boundary', () => {
    for (const resultLimitPerPool of [0, 33, 1.5, NaN]) {
      expect(pgHealthTool.args.safeParse({ localOnly: true, resultLimitPerPool }).success).toBe(false);
    }
    expect(pgHealthTool.args.safeParse({ localOnly: true, resultLimitPerPool: 32 }).success).toBe(true);
  });

  it('labels empty and partial coverage without implying idleness or connectivity', async () => {
    recordResult('org-admin-dedicated-worker');

    const { data } = await run({ localOnly: true });
    const diagnostic = data.processDiagnostics;

    for (const pool of diagnostic.pools) {
      expect(pool).toMatchObject({ observed: false, totalRecorded: 0, retained: 0, results: [] });
    }
    expect(diagnostic.limitations).toMatch(/in-flight/i);
    expect(diagnostic.limitations).toMatch(/other pools and processes/i);
    expect(diagnostic.limitations).toMatch(/empty.*not.*idle.*connectivity/i);
  });

  it('does not let a caller mutate subsequent diagnostic reads', async () => {
    recordResult();
    const first = await run({ localOnly: true });
    first.data.processDiagnostics.pools[0].results[0].rowCount = 999;
    first.data.processDiagnostics.pools[0].results.length = 0;

    const second = await run({ localOnly: true });

    expect(second.data.processDiagnostics.pools[0].results[0].rowCount).toBe(7);
  });

  it('bounds all selected pools and preserves terminal failure metadata', async () => {
    for (const pool of ['org-app', 'org-admin', 'org-admin-lossless-bigint']) {
      for (let queryId = 1; queryId <= 6; queryId += 1) recordResult(pool, queryId, 'error');
    }

    const { data } = await run({ localOnly: true });
    const pools = data.processDiagnostics.pools;

    expect(pools).toHaveLength(3);
    for (const pool of pools) {
      expect(pool).toMatchObject({ totalRecorded: 6, dropped: 0, retained: 6, omittedRetained: 2 });
      expect(pool.results).toHaveLength(4);
      expect(pool.results[3]).toMatchObject({ queryId: 6, status: 'error', errorCode: '42p01' });
    }
  });

  it('surfaces a classified failure after successful-query churn through the local-only reader', async () => {
    const correlation = {
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: null,
      rowId: null,
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: null,
      stage: null,
      boundary: null,
      requestId: '33333333-3333-4333-8333-333333333333',
      operation: 'activity.report',
    };
    recordPgResult('org-admin', {
      connectionId: 2,
      queryId: 1,
      backendPid: 8123,
      query: "INSERT INTO harness_shared.agent_activity (summary) VALUES ('never-retain-failure-secret')",
      command: 'INSERT',
      rowCount: 0,
      wireBytes: 0,
      elapsedMs: 25,
      status: 'error',
      errorCode: 'XX000',
      context: { state: 'linked', correlation },
    });
    for (let queryId = 2; queryId <= 40; queryId += 1) recordResult('org-admin', queryId);

    const { data } = await run({ localOnly: true, resultLimitPerPool: 2 });
    const pool = data.processDiagnostics.pools[1];

    expect(pgHealth).not.toHaveBeenCalled();
    expect(pool).toMatchObject({ failureCapacity: 16, totalFailures: 1, droppedFailures: 0 });
    expect(pool.failures[0]).toMatchObject({
      queryId: 1,
      status: 'error',
      errorCode: 'xx000',
      failurePhase: 'statement',
      queryFamily: 'insert:harness_shared.agent_activity',
      correlation: { requestId: correlation.requestId, operation: 'activity.report' },
    });
    expect(pool.results.map((result: { queryId: number }) => result.queryId)).toEqual([39, 40]);
    expect(JSON.stringify(pool)).not.toContain('never-retain-failure-secret');
  });

  it('does not treat an acquired connection as a completed-query observation', async () => {
    const acquisition = beginAcquire('org-app');
    acquisition.acquired();
    try {
      const { data } = await run({ localOnly: true });

      expect(data.processDiagnostics.pools[0]).toMatchObject({
        observed: false,
        totalRecorded: 0,
        results: [],
      });
    } finally {
      acquisition.release();
    }
  });

  it('delivers optional local correlation through the query-free public snapshot', async () => {
    const correlation = {
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: null,
      rowId: '42',
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: 2,
      stage: 'epoch-query',
      boundary: 'await' as const,
    };
    setPgDiagnosticContextResolver(() => correlation);
    recordResult('org-app', 77, 'ok', capturePgDiagnosticContext());

    const { data } = await run({ localOnly: true });
    expect(pgHealth).not.toHaveBeenCalled();
    expect(data.processDiagnostics.pools[0].results[0]).toMatchObject({
      correlationState: 'linked',
      correlation,
    });
    data.processDiagnostics.pools[0].results[0].correlation.rowId = '999';
    data.processDiagnostics.pools[0].results[0].source.processInstanceId = 'wrong';
    const reread = (await run({ localOnly: true })).data.processDiagnostics;
    expect(reread.pools[0].results[0].correlation.rowId).toBe('42');
    expect(reread.pools[0].results[0].source.processInstanceId).not.toBe('wrong');
    expect(reread.timing).toBe('query-build-to-terminal-not-acquisition');
    expect(reread.limitations).toContain('Non-ReadyForQuery failures are not covered');
    resetPgDiagnosticContextResolver();
  });

  it('preserves store-identity warnings on the query-free path', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const { data } = await run({ localOnly: true });

    expect(pgHealth).not.toHaveBeenCalled();
    expect(data.storeIdentityViolation.severity).toBe('critical');
    expect(data.processDiagnostics.source).toBe('current-process');
  });

  it('does not disguise a normal health-query failure as a successful health check', async () => {
    vi.mocked(pgHealth).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(run()).rejects.toThrow('database unavailable');
  });
});

describe('dev:pg_health store-identity delivery', () => {
  it('OMITS the field entirely when no violation is latched', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    const { data } = await run();

    // Deliberately absent rather than `false`: an absent check and a passed check must not
    // look alike, so a reader can never mistake "never ran" for "cleared".
    expect(data).not.toHaveProperty('storeIdentityViolation');
    expect(data.version).toBe('PostgreSQL 16.4');
  });

  it('SURFACES the violation, and says the thing that stops the wrong conclusion', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const { data } = await run();
    const v = data.storeIdentityViolation;

    expect(v).toBeTruthy();
    expect(v.severity).toBe('critical');
    // The single most costly misreading of this outage: `not_found` taken as deletion.
    expect(v.whatThisMeans).toMatch(/NOT evidence of data loss/i);
    expect(v.whatThisMeans).toMatch(/do not delete/i);
    expect(v.observed.url).toContain('22060');
    expect(v.pinned.systemIdentifier).toBe(OURS.systemIdentifier);
  });

  it('still returns the ordinary health payload alongside the violation', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const { data } = await run();

    // The violation must AUGMENT the answer, never replace it — an agent polling health
    // during an incident still needs the connection counts.
    expect(data.version).toBe('PostgreSQL 16.4');
    expect(data.active).toBe(3);
    expect(data.storeIdentityViolation).toBeTruthy();
  });

  it('leaks no credentials into the surfaced verdict', async () => {
    pinOrVerifyStoreIdentity(OURS, 'postgresql://harness_admin:secret@localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://harness_admin:secret@127.0.0.1:22060/papercusp');

    const { data } = await run();

    expect(JSON.stringify(data)).not.toContain('secret');
  });
});
