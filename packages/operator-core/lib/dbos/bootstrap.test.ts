/**
 * bootstrap.test.ts — WI-2790: DBOS's own system-database pool must get extra
 * idle-in-transaction slack (via a startup `options` GUC on its own connection
 * string) WITHOUT touching the cluster-wide EI-49 default any other connection
 * relies on. Also covers WI-3619's PG-reachability launch-retry cadence (a
 * bounded retry instead of skip-DBOS-for-the-process-lifetime on a boot-time
 * PG probe timeout). Pure-function unit tests only (no PG, no
 * DBOS.setConfig/launch).
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  withDbosIdleTxGrace,
  resolvePgLaunchRetryMs,
  assertSafeDbosAppVersionPartition,
  isRetryableDbosLaunchError,
  awaitDbosLaunchInFlight,
} from './bootstrap';

// WI-10004957: provisioning routes wait on this only for a launch that is already in flight.
describe('awaitDbosLaunchInFlight', () => {
  it('returns false at once when DBOS is not started and no launch is in flight', async () => {
    const started = Date.now();
    await expect(awaitDbosLaunchInFlight(10_000)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('returns true at once when DBOS already started', async () => {
    const g = globalThis as unknown as { __papercuspDbosStarted?: boolean };
    const prior = g.__papercuspDbosStarted;
    g.__papercuspDbosStarted = true;
    try {
      await expect(awaitDbosLaunchInFlight(0)).resolves.toBe(true);
    } finally {
      g.__papercuspDbosStarted = prior;
    }
  });
});

describe('withDbosIdleTxGrace', () => {
  const ENV_KEY = 'PAPERCUSP_DBOS_IDLE_IN_TX_TIMEOUT_SEC';
  const prior = process.env[ENV_KEY];

  afterEach(() => {
    if (prior === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prior;
  });

  it('appends a 300s (5min) default idle-in-transaction override as a `?options=` startup GUC', () => {
    delete process.env[ENV_KEY];
    const out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db');
    expect(out).toBe(
      'postgresql://user:pass@host:5432/db?options=' +
        encodeURIComponent('-c idle_in_transaction_session_timeout=300000'),
    );
  });

  it('uses `&options=` (not a second `?`) when the url already carries a query string', () => {
    const out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db?sslmode=require');
    expect(out.startsWith('postgresql://user:pass@host:5432/db?sslmode=require&options=')).toBe(true);
  });

  it('honors PAPERCUSP_DBOS_IDLE_IN_TX_TIMEOUT_SEC when set above the 60s floor', () => {
    process.env[ENV_KEY] = '600';
    const out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db');
    expect(out).toContain(encodeURIComponent('idle_in_transaction_session_timeout=600000'));
  });

  it('clamps a below-floor / non-numeric override up to the 60s floor (never LOWER than the cluster default)', () => {
    process.env[ENV_KEY] = '10';
    let out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db');
    expect(out).toContain(encodeURIComponent('idle_in_transaction_session_timeout=60000'));

    process.env[ENV_KEY] = 'not-a-number';
    out = withDbosIdleTxGrace('postgresql://user:pass@host:5432/db');
    expect(out).toContain(encodeURIComponent('idle_in_transaction_session_timeout=300000'));
  });
});

describe('resolvePgLaunchRetryMs (WI-3619)', () => {
  it('defaults to 30s when unset', () => {
    expect(resolvePgLaunchRetryMs({})).toBe(30_000);
  });

  it('honors PAPERCUSP_DBOS_PG_RETRY_MS when set above the 10s floor', () => {
    expect(resolvePgLaunchRetryMs({ PAPERCUSP_DBOS_PG_RETRY_MS: '60000' })).toBe(60_000);
  });

  it('clamps a below-floor override up to the 10s floor (never hammer a down/loaded PG)', () => {
    expect(resolvePgLaunchRetryMs({ PAPERCUSP_DBOS_PG_RETRY_MS: '1000' })).toBe(10_000);
  });

  it('falls back to the 30s default (not the floor) on a non-numeric override', () => {
    expect(resolvePgLaunchRetryMs({ PAPERCUSP_DBOS_PG_RETRY_MS: 'not-a-number' })).toBe(30_000);
  });

  it('defaults to process.env when no env is passed', () => {
    const prior = process.env.PAPERCUSP_DBOS_PG_RETRY_MS;
    try {
      delete process.env.PAPERCUSP_DBOS_PG_RETRY_MS;
      expect(resolvePgLaunchRetryMs()).toBe(30_000);
      process.env.PAPERCUSP_DBOS_PG_RETRY_MS = '45000';
      expect(resolvePgLaunchRetryMs()).toBe(45_000);
    } finally {
      if (prior === undefined) delete process.env.PAPERCUSP_DBOS_PG_RETRY_MS;
      else process.env.PAPERCUSP_DBOS_PG_RETRY_MS = prior;
    }
  });
});

describe('isRetryableDbosLaunchError (EI-22022209900260112)', () => {
  it('recognizes a DBOS-wrapped PostgreSQL lock-timeout SQLSTATE', () => {
    expect(
      isRetryableDbosLaunchError({
        dbosErrorCode: 3,
        message: 'Failed to initialize workflow executor',
        error: { code: '55P03', message: 'canceling statement due to lock timeout' },
      }),
    ).toBe(true);
  });

  it('recognizes the lock-timeout message when a pg client omits the SQLSTATE', () => {
    expect(isRetryableDbosLaunchError(new Error('canceling statement due to lock timeout'))).toBe(true);
    expect(isRetryableDbosLaunchError({ cause: { message: 'lock_not_available' } })).toBe(true);
  });

  it('does not retry non-transient DBOS initialization failures', () => {
    expect(
      isRetryableDbosLaunchError({
        dbosErrorCode: 3,
        message: 'Failed to initialize workflow executor: relation does not exist',
        error: { code: '42P01', message: 'relation does not exist' },
      }),
    ).toBe(false);
    expect(isRetryableDbosLaunchError(new Error('workflow registration failed'))).toBe(false);
  });

  // WI-6554700010009759: the 2026-10-13 00:15Z bg-host boot logged exactly this message
  // from DBOS.launch() and stayed DBOS-dark for ~2h because it was not retried.
  it('retries the node-postgres connect timeout seen in the 2026-10-13 incident', () => {
    expect(isRetryableDbosLaunchError(new Error('Connection terminated due to connection timeout'))).toBe(true);
    expect(
      isRetryableDbosLaunchError({
        dbosErrorCode: 3,
        message: 'Failed to initialize workflow executor',
        cause: new Error('Connection terminated due to connection timeout'),
      }),
    ).toBe(true);
    expect(isRetryableDbosLaunchError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isRetryableDbosLaunchError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(isRetryableDbosLaunchError(new Error('timeout expired when trying to connect'))).toBe(true);
  });

  it('retries connection-class SQLSTATEs and socket errnos', () => {
    for (const code of ['08000', '08001', '08003', '08004', '08006', '57P03', '53300']) {
      expect(isRetryableDbosLaunchError({ error: { code } })).toBe(true);
    }
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) {
      expect(isRetryableDbosLaunchError({ originalError: Object.assign(new Error('socket'), { code }) })).toBe(true);
    }
    expect(isRetryableDbosLaunchError(new Error('FATAL: the database system is starting up'))).toBe(true);
  });

  it('still refuses auth, permission and syntax failures', () => {
    expect(isRetryableDbosLaunchError({ error: { code: '28P01', message: 'password authentication failed' } })).toBe(false);
    expect(isRetryableDbosLaunchError({ error: { code: '42501', message: 'permission denied for schema dbos' } })).toBe(false);
    expect(isRetryableDbosLaunchError({ error: { code: '42601', message: 'syntax error at or near' } })).toBe(false);
  });
});

describe('assertSafeDbosAppVersionPartition (EI-90 — 2026-06-08 DBOS appVersion war)', () => {
  it('throws when armed on the :3170 staging port with no explicit DBOS__APPVERSION override', () => {
    expect(() =>
      assertSafeDbosAppVersionPartition({ PAPERCUSP_HONO_PORT: '3170' }),
    ).toThrow(/refusing to launch/);
  });

  it('throws even when DBOS__APPVERSION is present but empty (falsy override)', () => {
    expect(() =>
      assertSafeDbosAppVersionPartition({ PAPERCUSP_HONO_PORT: '3170', DBOS__APPVERSION: '' }),
    ).toThrow(/refusing to launch/);
  });

  it('does NOT throw on :3170 when DBOS__APPVERSION is explicitly overridden', () => {
    expect(() =>
      assertSafeDbosAppVersionPartition({
        PAPERCUSP_HONO_PORT: '3170',
        DBOS__APPVERSION: 'staging-canary-v1',
      }),
    ).not.toThrow();
  });

  it('does NOT throw on the bg-host / primary port (3270) with no override — only :3170 is guarded', () => {
    expect(() =>
      assertSafeDbosAppVersionPartition({ PAPERCUSP_HONO_PORT: '3270' }),
    ).not.toThrow();
  });

  it('does NOT throw when PAPERCUSP_HONO_PORT is unset (the default green :3070 host)', () => {
    expect(() => assertSafeDbosAppVersionPartition({})).not.toThrow();
  });

  it('the thrown message names the shared/default appVersion so the operator knows what collided', () => {
    expect(() =>
      assertSafeDbosAppVersionPartition({ PAPERCUSP_HONO_PORT: '3170' }),
    ).toThrow(/papercusp-jobs-v1/);
  });
});
