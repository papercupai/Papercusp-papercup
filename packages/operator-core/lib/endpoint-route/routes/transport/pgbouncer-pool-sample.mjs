/**
 * Bounded PgBouncer + PostgreSQL activity sampler shared by the MCP host and
 * the external MCP proxy watchdog.
 *
 * A native-session verifier deadline can be caused by the process-local pool,
 * PgBouncer, or a PostgreSQL wait. The verifier already records its own pool
 * tickets; this sampler adds an out-of-band PgBouncer admin query and a short,
 * direct pg_stat_activity snapshot. Callers may fire it without awaiting: both
 * subprocesses have hard timeouts, bounded output, and share the existing
 * per-process debounce.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';

const ADMIN_HOST = process.env.PAPERCUSP_PGBOUNCER_ADMIN_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.PAPERCUSP_PGBOUNCER_PORT) || 6432;
const ADMIN_USER = process.env.PAPERCUSP_PGBOUNCER_ADMIN_USER || 'harness_admin';
const ADMIN_PASSWORD = process.env.PAPERCUSP_PGBOUNCER_ADMIN_PASSWORD || 'harness_admin_pwd';
export const SAMPLE_LOG_FILE =
  process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG ||
  join(homedir(), '.papercusp', 'mcp-proxy-watchdog-pgbouncer-samples.log');
const SAMPLE_TIMEOUT_MS = Number(process.env.PAPERCUSP_PGBOUNCER_SAMPLE_TIMEOUT_MS) || 5_000;
const ACTIVITY_TIMEOUT_MS = 1_500;
const MAX_PSQL_BUFFER_BYTES = 32 * 1024;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** Never sample more than once per this window within a process. */
export const MIN_SAMPLE_INTERVAL_MS = Number(process.env.PAPERCUSP_PGBOUNCER_SAMPLE_MIN_INTERVAL_MS) || 20_000;

const PG_ACTIVITY_QUERY = `SELECT COALESCE(json_agg(row_to_json(samples)), '[]'::json)::text
FROM (
  SELECT
    COALESCE(NULLIF(application_name, ''), '(unset)') AS application_name,
    COALESCE(state, '(unknown)') AS state,
    COALESCE(wait_event_type, '(none)') AS wait_event_type,
    COALESCE(wait_event, '(none)') AS wait_event,
    count(*)::int AS sessions
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
  GROUP BY application_name, state, wait_event_type, wait_event
  ORDER BY sessions DESC, application_name, state
  LIMIT 24
) AS samples;`;

/** Pure: the exact PgBouncer admin-console argv. */
export function buildShowPoolsArgs({ host = ADMIN_HOST, port = ADMIN_PORT, user = ADMIN_USER } = {}) {
  return ['-h', host, '-p', String(port), '-U', user, '-d', 'pgbouncer', '-At', '-c', 'SHOW POOLS;', '-c', 'SHOW STATS;'];
}

function defaultActivityConnectionString() {
  const configured = process.env.HARNESS_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
  if (configured) return configured;
  const pgPort = Number(process.env.PAPERCUSP_PG_PORT) || 5432;
  return `postgresql://harness_admin:harness_admin_pwd@127.0.0.1:${pgPort}/papercusp`;
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Pure argv/env builder for a direct pg_stat_activity read. If the supplied
 * endpoint is the transaction pooler itself, skip it: the snapshot must not
 * enqueue behind the pool whose state it is meant to explain.
 */
export function buildPgActivityArgs({
  connectionString = defaultActivityConnectionString(),
  pgbouncerPort = Number(process.env.PAPERCUSP_PGBOUNCER_PORT) || 6432,
} = {}) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    return { unavailable: 'no-admin-database-endpoint' };
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return { unavailable: 'invalid-admin-database-endpoint' };
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return { unavailable: 'unsupported-admin-database-endpoint' };
  }
  const port = Number(url.port) || 5432;
  if (port === pgbouncerPort) return { unavailable: 'admin-database-endpoint-is-pgbouncer' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const user = safeDecode(url.username || 'harness_admin');
  const database = safeDecode(url.pathname.replace(/^\//, '') || 'papercusp');
  const env = {
    PGAPPNAME: 'papercusp-native-session-diagnostic',
    PGOPTIONS: '-c statement_timeout=750 -c lock_timeout=250',
    ...(url.password ? { PGPASSWORD: safeDecode(url.password) } : {}),
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
  return {
    args: ['-h', host, '-p', String(port), '-U', user, '-d', database, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', PG_ACTIVITY_QUERY],
    env,
  };
}

function clippedText(value, maxChars = 16 * 1024) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(0, maxChars);
}

function safeErrorText(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return clippedText(message.replace(/\bpostgres(?:ql)?:\/\/\S+/gi, '[redacted-connection]'), 800);
}

function runPsqlSample(args, env, timeoutMs, { execFileImpl, now }) {
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const startedMonotonicMs = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      const completedAtMs = now();
      resolve({
        ok: !error,
        startedAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, Math.round(performance.now() - startedMonotonicMs)),
        output: clippedText(stdout),
        stderr: clippedText(stderr, 4_000),
        error: error ? safeErrorText(error) : null,
      });
    };
    try {
      execFileImpl(
        'psql',
        args,
        {
          env: { ...process.env, ...env },
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_PSQL_BUFFER_BYTES,
        },
        finish,
      );
    } catch (error) {
      finish(error, '', '');
    }
  });
}

function appendBoundedLog(line) {
  try {
    mkdirSync(dirname(SAMPLE_LOG_FILE), { recursive: true });
    try {
      if (statSync(SAMPLE_LOG_FILE).size + Buffer.byteLength(line, 'utf8') > MAX_LOG_BYTES) {
        const rotated = `${SAMPLE_LOG_FILE}.1`;
        rmSync(rotated, { force: true });
        renameSync(SAMPLE_LOG_FILE, rotated);
      }
    } catch {
      // First write, or a concurrently rotated file. append below is still safe.
    }
    appendFileSync(SAMPLE_LOG_FILE, line);
  } catch {
    /* diagnostic logging must never affect the verifier or watchdog */
  }
}

let lastSampleAt = 0;

/**
 * Run both bounded snapshots and append one correlated block. `requestFingerprint`
 * is a short SHA-256 prefix supplied by the MCP host; raw session and request
 * identifiers never enter this file.
 */
export async function samplePgBouncerPools(reason, {
  execFileImpl = execFile,
  now = Date.now,
  activityConnectionString,
  pid = process.pid,
  requestFingerprint,
} = {}) {
  const requestedAtMs = now();
  if (requestedAtMs - lastSampleAt < MIN_SAMPLE_INTERVAL_MS) {
    return { ok: false, skipped: 'debounced' };
  }
  lastSampleAt = requestedAtMs;

  const safeReason = typeof reason === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(reason) ? reason : 'unspecified';
  const safePid = Number.isSafeInteger(pid) && pid > 0 ? pid : process.pid;
  const safeFingerprint = typeof requestFingerprint === 'string' && /^[a-f0-9]{16,64}$/i.test(requestFingerprint)
    ? requestFingerprint.toLowerCase()
    : 'none';

  const poolPromise = runPsqlSample(
    buildShowPoolsArgs(),
    { PGPASSWORD: ADMIN_PASSWORD, PGAPPNAME: 'papercusp-pgbouncer-diagnostic' },
    SAMPLE_TIMEOUT_MS,
    { execFileImpl, now },
  );
  const activityArgs = buildPgActivityArgs({
    connectionString: activityConnectionString === undefined ? defaultActivityConnectionString() : activityConnectionString,
  });
  const activityPromise = activityArgs.unavailable
    ? Promise.resolve({ ok: false, skipped: activityArgs.unavailable })
    : runPsqlSample(
      activityArgs.args,
      activityArgs.env,
      ACTIVITY_TIMEOUT_MS,
      { execFileImpl, now },
    );
  const [pool, activity] = await Promise.all([poolPromise, activityPromise]);

  const line =
    `[pgbouncer-sample ${pool.completedAt}] reason=${safeReason} pid=${safePid} requestFingerprint=${safeFingerprint} ` +
    `startedAt=${pool.startedAt} completedAt=${pool.completedAt} durationMs=${pool.durationMs} ` +
    `pgActivityStartedAt=${activity.startedAt ?? 'unavailable'} ` +
    `pgActivityCompletedAt=${activity.completedAt ?? 'unavailable'} ` +
    `pgActivityDurationMs=${activity.durationMs ?? 'unavailable'}\n` +
    `PGBOUNCER:\n${pool.error ? `ERROR: ${pool.error}\n${pool.stderr}` : pool.output}\n` +
    `PG_STAT_ACTIVITY:\n${activity.skipped ? `SKIPPED: ${activity.skipped}` : activity.error ? `ERROR: ${activity.error}\n${activity.stderr}` : activity.output}\n\n`;
  appendBoundedLog(line);

  return {
    ok: pool.ok,
    output: pool.output,
    error: pool.error,
    pgActivity: activity,
  };
}

/** Test-only — resets the debounce state between tests. */
export function _resetSampleDebounceForTests() {
  lastSampleAt = 0;
}
