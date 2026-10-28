/**
 * WI-10006330 — one transient ClickHouse export stall must not silently drop a table
 * from the daily estate backup.
 *
 * Measured 2026-10-05 on hetzner-restore-mesh: posthog.sharded_query_log_archive
 * (1.17 GiB, 4M rows) failed with "DB::NetException: Timeout exceeded while writing to
 * socket (127.0.0.1:49878, 300000 ms). (SOCKET_TIMEOUT)" — the server's default
 * 300 s send_timeout fired when the docker-exec -> gzip consumer stopped reading. The
 * producer made a single attempt, so the snapshot shipped 108/109 artifacts. 10-04 and
 * 10-06 exported the same table cleanly.
 *
 * Hermetic: every case runs the REAL pc-estate-backup.sh under a tmp PC_BACKUP_STAGE
 * with PATH shims. `hostname` selects the mesh inventory (the host that has a
 * ClickHouse container); `docker` answers the ClickHouse catalog queries and fails the
 * first N data exports with the exact 10-05 error text; every other leg (PG, Redis,
 * volumes, upload) is allowed to fail, and the assertions read only the ClickHouse leg.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the suite at a historical copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../infra/estate-backup/pc-estate-backup.sh');
const SOCKET_TIMEOUT =
  'Code: 209. DB::NetException: Timeout exceeded while writing to socket (127.0.0.1:49878, 300000 ms). (SOCKET_TIMEOUT)';

function shim(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, '#!/usr/bin/env bash\n' + body + '\n');
  chmodSync(p, 0o755);
}

const DOCKER = `
if [ "$1" = ps ]; then exit 0; fi
[ "$1" = exec ] || exit 1
shift; [ "$1" = "-i" ] && shift
c="$1"; shift
[ "$c" = posthog-clickhouse-1 ] || exit 1
q="\${@: -1}"
case "$q" in
  *system.databases*)
    if [ "\${SHIM_CH_ENUM_FAIL:-}" = databases ]; then printf 'cannot exec in a stopped state\r\n'; exit 1; fi
    printf '%s\n' "\${SHIM_CH_DB:-posthog}" ;;
  *"engine LIKE"*)
    if [ "\${SHIM_CH_ENUM_FAIL:-}" = data_tables ]; then printf 'cannot exec in a stopped state\r\n'; exit 1; fi
    printf '%s\n' "\${SHIM_CH_TABLE:-t1}" ;;
  *create_table_query*) echo "CREATE TABLE posthog.t1 (x UInt8) ENGINE = MergeTree ORDER BY x" ;;
  *"FROM system.tables"*)
    if [ "\${SHIM_CH_ENUM_FAIL:-}" = tables ]; then printf 'cannot exec in a stopped state\r\n'; exit 1; fi
    printf '%s\n' "\${SHIM_CH_TABLE:-t1}" ;;
  *"FORMAT Native"*)
    echo "$*" >>"$SHIM_ROOT/ch-export-args.log"
    n=$(( $(cat "$SHIM_ROOT/ch-attempts" 2>/dev/null || echo 0) + 1 ))
    echo "$n" >"$SHIM_ROOT/ch-attempts"
    if [ "$n" -le "$SHIM_CH_FAILS" ]; then echo "$SHIM_CH_ERROR" >&2; exit 209; fi
    printf 'NATIVE-BLOCK-PAYLOAD' ;;
  *) exit 1 ;;
esac
`;

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function runBackup(opts: { chFails: number; sendTimeout?: string; enumFail?: string; dbName?: string; tableName?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'estate-backup-ch-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  shim(bin, 'hostname', 'echo hetzner-restore-mesh');
  shim(bin, 'docker', DOCKER);
  shim(bin, 'gcloud', 'exit 1');
  shim(bin, 'sudo', 'exit 1');
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    PC_BACKUP_STAGE: join(root, 'stage'),
    PC_BACKUP_BUCKET: 'gs://shim-bucket',
    SHIM_ROOT: root,
    SHIM_CH_FAILS: String(opts.chFails),
    SHIM_CH_ERROR: SOCKET_TIMEOUT,
    SHIM_CH_ENUM_FAIL: opts.enumFail ?? '',
    SHIM_CH_DB: opts.dbName ?? 'posthog',
    SHIM_CH_TABLE: opts.tableName ?? 't1',
  };
  if (opts.sendTimeout !== undefined) env.PC_BACKUP_CH_SEND_TIMEOUT = opts.sendTimeout;
  const run = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env, timeout: 60_000 });
  const attemptsPath = join(root, 'ch-attempts');
  const argsPath = join(root, 'ch-export-args.log');
  const stageRoot = join(root, 'stage');
  const snapshot = existsSync(stageRoot) ? readdirSync(stageRoot)[0] : undefined;
  const manifestPath = snapshot ? join(stageRoot, snapshot, 'MANIFEST.json') : undefined;
  return {
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    attempts: existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, 'utf8').trim()) : 0,
    exportArgs: existsSync(argsPath) ? readFileSync(argsPath, 'utf8').split('\n').filter(Boolean) : [],
    manifestText: manifestPath && existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : undefined,
  };
}

describe('pc-estate-backup.sh ClickHouse export (WI-10006330)', () => {
  it('calibration: a clean export takes ONE attempt and is emitted as an artifact', () => {
    const r = runBackup({ chFails: 0 });
    // Positive control: the shim really was driven — a run that never reached the
    // ClickHouse leg would pass every negative assertion below vacuously.
    expect(r.attempts).toBe(1);
    expect(r.stdout).toContain('ok posthog.t1');
    expect(r.stdout).not.toContain('retry clickhouse');
    expect(r.stderr).not.toContain('FAIL: clickhouse');
  });

  it('one transient SOCKET_TIMEOUT is retried and the table still lands in the backup', () => {
    const r = runBackup({ chFails: 1 });
    expect(r.attempts).toBe(2);
    expect(r.stdout).toContain('retry clickhouse posthog.t1: attempt 1 failed: Code: 209');
    expect(r.stdout).toContain('ok posthog.t1');
    expect(r.stderr).not.toContain('FAIL: clickhouse');
  });

  it('a persistent failure is still a FAIL that quotes the server error, after exactly 2 attempts', () => {
    const r = runBackup({ chFails: 99 });
    expect(r.attempts).toBe(2);
    expect(r.stderr).toContain('!! FAIL: clickhouse posthog.t1: Native export failed after 2 attempts:');
    expect(r.stderr).toContain('SOCKET_TIMEOUT');
    expect(r.stdout).not.toContain('ok posthog.t1');
  });

  it('every export attempt widens send_timeout past the 300 s server default (and the knob overrides it)', () => {
    const dflt = runBackup({ chFails: 1 });
    expect(dflt.exportArgs).toHaveLength(2);
    for (const line of dflt.exportArgs) expect(line).toContain('--send_timeout=1800');
    const tuned = runBackup({ chFails: 0, sendTimeout: '77' });
    expect(tuned.exportArgs).toHaveLength(1);
    expect(tuned.exportArgs[0]).toContain('--send_timeout=77');
  });

  it.each(['databases', 'tables', 'data_tables'])(
    'rejects failed %s enumeration instead of treating its CR-terminated error as an identifier',
    (enumFail) => {
      const r = runBackup({ chFails: 0, enumFail });
      expect(r.attempts).toBe(0);
      expect(r.stdout).toContain('enumeration failed');
      expect(r.manifestText).toBeDefined();
      const manifest = JSON.parse(r.manifestText!);
      expect(manifest.artifacts.some((artifact: { name: string }) => artifact.name.includes('cannot exec'))).toBe(false);
      expect(manifest.failures).toBeGreaterThan(0);
    },
  );

  it('serializes catalog identifiers safely and validates the manifest before upload', () => {
    const dbName = 'posthog"db\\name';
    const tableName = 't"1\\name';
    const r = runBackup({ chFails: 0, dbName, tableName });
    expect(r.manifestText).toBeDefined();
    const manifest = JSON.parse(r.manifestText!);
    expect(manifest.artifacts.some((artifact: { name: string }) => artifact.name === dbName + '/schema')).toBe(true);
    expect(manifest.artifacts.some((artifact: { name: string }) => artifact.name === dbName + '.' + tableName)).toBe(true);
    expect(r.stderr).not.toContain('manifest JSON validation failed');
  });
});
