import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Types come from pgbouncer-pool-sample.d.mts — without it this import is an implicit `any`
// (TS7016) and every assertion below silently stops type-checking (see watchdog.test.ts for
// the identical rationale — this module is plain .mjs on purpose, imported by a bare-`node`
// systemd entrypoint, so it cannot become TypeScript).
type PoolSample = typeof import('./pgbouncer-pool-sample.mjs');
let buildShowPoolsArgs: PoolSample['buildShowPoolsArgs'];
let buildPgActivityArgs: PoolSample['buildPgActivityArgs'];
let samplePgBouncerPools: PoolSample['samplePgBouncerPools'];
let _resetSampleDebounceForTests: PoolSample['_resetSampleDebounceForTests'];
let SAMPLE_LOG_FILE: PoolSample['SAMPLE_LOG_FILE'];
let MIN_SAMPLE_INTERVAL_MS: PoolSample['MIN_SAMPLE_INTERVAL_MS'];

let tmpHome: string;

beforeAll(async () => {
  // Redirect the sampler's log file into a scratch dir BEFORE importing the module, since the
  // log path is resolved once at module load from PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG.
  tmpHome = mkdtempSync(join(tmpdir(), 'pgbouncer-pool-sample-test-'));
  process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG = join(tmpHome, 'samples.log');
  ({ buildShowPoolsArgs, buildPgActivityArgs, samplePgBouncerPools, _resetSampleDebounceForTests, SAMPLE_LOG_FILE, MIN_SAMPLE_INTERVAL_MS } =
    await import('./pgbouncer-pool-sample.mjs'));
});

beforeEach(() => {
  _resetSampleDebounceForTests();
});

afterEach(() => {
  try {
    rmSync(SAMPLE_LOG_FILE, { force: true });
  } catch {
    /* fine if it was never written this test */
  }
});

describe('pgbouncer pool sampler — buildShowPoolsArgs (EI-19384024494946006)', () => {
  it('queries SHOW POOLS + SHOW STATS against the admin virtual database, as the admin user', () => {
    const args = buildShowPoolsArgs({ host: '127.0.0.1', port: 6432, user: 'harness_admin' });
    expect(args).toEqual(['-h', '127.0.0.1', '-p', '6432', '-U', 'harness_admin', '-d', 'pgbouncer', '-At', '-c', 'SHOW POOLS;', '-c', 'SHOW STATS;']);
  });

  it('defaults to the box-standard admin console coordinates when no override is given', () => {
    const args = buildShowPoolsArgs();
    // -d pgbouncer (never an app database — the admin console is a separate virtual DB)
    expect(args).toContain('pgbouncer');
    expect(args).toContain('SHOW POOLS;');
    expect(args).toContain('SHOW STATS;');
  });
});

describe('pgbouncer pool sampler — samplePgBouncerPools (EI-19384024494946006)', () => {
  it('builds a bounded direct activity query and skips a URL that points at PgBouncer', () => {
    const direct = buildPgActivityArgs({ connectionString: 'postgresql://harness_admin:secret@127.0.0.1:5432/papercusp' });
    expect(direct.unavailable).toBeUndefined();
    if (!direct.args) throw new Error(`expected direct activity args, got unavailable=${direct.unavailable}`);
    expect(direct.args.join(' ')).toContain('pg_stat_activity');
    expect(direct.args.join(' ')).toContain('LIMIT 24');
    expect(direct.args.join(' ')).not.toMatch(/\bquery\b/i);
    expect(direct.env).toMatchObject({
      PGPASSWORD: 'secret',
      PGAPPNAME: 'papercusp-native-session-diagnostic',
      PGOPTIONS: expect.stringContaining('statement_timeout=750'),
    });

    expect(buildPgActivityArgs({
      connectionString: 'postgresql://harness_admin:secret@127.0.0.1:6432/papercusp',
      pgbouncerPort: 6432,
    })).toMatchObject({ unavailable: 'admin-database-endpoint-is-pgbouncer' });
  });

  it('starts bounded PgBouncer and activity captures, records aligned timings, and redacts connection credentials', async () => {
    const calls: unknown[] = [];
    let clock = 1_000_000;
    const execFileImpl = (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      cb: (err: (Error & { message: string }) | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ cmd, args, options });
      cb(null, args.includes('pgbouncer')
        ? 'pool output here'
        : '[{"application_name":"papercusp:api","wait_event_type":"Lock"}]', '');
    };

    const result = await samplePgBouncerPools('test-reason', {
      execFileImpl,
      now: () => (clock += 100),
      activityConnectionString: 'postgresql://harness_admin:test-secret@127.0.0.1:5432/papercusp',
      requestFingerprint: '0123456789abcdef',
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('pool output here');
    expect(result.pgActivity).toMatchObject({ ok: true, output: expect.stringContaining('wait_event_type') });
    expect(calls).toHaveLength(2);
    const poolCall = calls[0] as { cmd: string; args: string[]; options: Record<string, unknown> };
    const activityCall = calls[1] as { cmd: string; args: string[]; options: Record<string, unknown> };
    expect(poolCall.cmd).toBe('psql');
    expect(poolCall.args).toEqual(buildShowPoolsArgs());
    expect(poolCall.options.env).toMatchObject({ PGPASSWORD: expect.any(String) });
    expect(poolCall.options.timeout).toBeGreaterThan(0);
    expect(poolCall.options.killSignal).toBe('SIGKILL');
    expect(activityCall.cmd).toBe('psql');
    expect(activityCall.args.join(' ')).toContain('pg_stat_activity');
    expect(activityCall.options.env).toMatchObject({ PGPASSWORD: 'test-secret' });
    expect(activityCall.options.timeout).toBeLessThanOrEqual(1_500);
    expect(activityCall.options.maxBuffer).toBeLessThanOrEqual(32 * 1024);
    expect(activityCall.options.killSignal).toBe('SIGKILL');

    const logged = readFileSync(SAMPLE_LOG_FILE, 'utf8');
    expect(logged).toContain('reason=test-reason');
    expect(logged).toContain('pid=');
    expect(logged).toContain('requestFingerprint=0123456789abcdef');
    expect(logged).toContain('startedAt=1970-01-01T00:16:40.200Z');
    expect(logged).toContain('completedAt=1970-01-01T00:16:40.300Z');
    expect(logged).toMatch(/durationMs=\d+/);
    expect(logged).toContain('pool output here');
    expect(logged).toContain('pgActivityStartedAt=1970-01-01T00:16:40.400Z');
    expect(logged).toContain('pgActivityCompletedAt=1970-01-01T00:16:40.500Z');
    expect(logged).toContain('wait_event_type');
    expect(logged).not.toContain('test-secret');
  });

  it('never throws when psql errors — logs the error and reports ok:false', async () => {
    const execFileImpl = (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      cb: (err: (Error & { message: string }) | null, stdout: string, stderr: string) => void,
    ) => {
      cb(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6432'), { message: 'connect ECONNREFUSED 127.0.0.1:6432' }), '', 'connection refused');
    };

    const result = await samplePgBouncerPools('test-error', {
      execFileImpl,
      activityConnectionString: 'postgresql://harness_admin:test-secret@127.0.0.1:5432/papercusp',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    const logged = readFileSync(SAMPLE_LOG_FILE, 'utf8');
    expect(logged).toContain('reason=test-error');
    expect(logged).toContain('ERROR:');
  });

  it('never throws when execFileImpl itself throws synchronously', async () => {
    const execFileImpl = () => {
      throw new Error('boom — broken test double / spawn failure');
    };
    await expect(samplePgBouncerPools('test-sync-throw', {
      execFileImpl,
      activityConnectionString: 'postgresql://harness_admin:test-secret@127.0.0.1:5432/papercusp',
    })).resolves.toMatchObject({ ok: false });
  });

  it('debounces repeat calls within MIN_SAMPLE_INTERVAL_MS — a burst of onsets samples once', async () => {
    let calls = 0;
    const execFileImpl = (
      cmd: string,
      args: string[],
      options: Record<string, unknown>,
      cb: (err: (Error & { message: string }) | null, stdout: string, stderr: string) => void,
    ) => {
      calls += 1;
      cb(null, 'output', '');
    };
    let clock = 1_000_000;
    const now = () => clock;

    const opts = { execFileImpl, now, activityConnectionString: 'postgresql://harness_admin:secret@127.0.0.1:5432/papercusp' };
    const first = await samplePgBouncerPools('onset-a', opts);
    expect(first.skipped).toBeUndefined();
    expect(calls).toBe(2);

    clock += 1_000; // well inside the debounce window
    const second = await samplePgBouncerPools('onset-b', opts);
    expect(second.skipped).toBe('debounced');
    expect(calls).toBe(2); // the debounced call spawns neither snapshot

    clock += MIN_SAMPLE_INTERVAL_MS + 1; // past the debounce window
    const third = await samplePgBouncerPools('onset-c', opts);
    expect(third.skipped).toBeUndefined();
    expect(calls).toBe(4);
  });

  it('keeps PgBouncer capture working when a direct activity endpoint is unavailable', async () => {
    const calls: unknown[] = [];
    const execFileImpl = (
      cmd: string,
      args: string[],
      _options: Record<string, unknown>,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ cmd, args });
      cb(null, 'pool output here', '');
    };
    const result = await samplePgBouncerPools('pool-only', { execFileImpl, activityConnectionString: null });

    expect(result.ok).toBe(true);
    expect(result.pgActivity).toMatchObject({ ok: false, skipped: 'no-admin-database-endpoint' });
    expect(calls).toHaveLength(1);
    expect(readFileSync(SAMPLE_LOG_FILE, 'utf8')).toContain('SKIPPED: no-admin-database-endpoint');
  });
});
