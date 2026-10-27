import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(__dirname, '../systemd/papercusp-db-backup.sh');
const servicePath = resolve(__dirname, '../systemd/papercusp-db-backup.service');
const timerPath = resolve(__dirname, '../systemd/papercusp-db-backup.timer');
const source = readFileSync(scriptPath, 'utf8');
const service = readFileSync(servicePath, 'utf8');
const timer = readFileSync(timerPath, 'utf8');

function between(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('backup script marker not found');
  return source.slice(start, end);
}

const receiptHelpers = between('json_string() {', '# Cluster identity of what we just dumped');
const recentSuccessFunction = between(
  'recent_success_is_fresh() {',
  '# pg_dump runs as the ',
);

const NOW = 1_798_000_000;

function runRecentSuccessCheck(
  receipt: Record<string, unknown> | null,
  scheduled: boolean,
  extraEnv: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'papercusp-backup-scheduled-success-'));
  try {
    const statusPath = join(dir, 'STATUS.json');
    if (receipt) writeFileSync(statusPath, JSON.stringify(receipt));
    const harness = [
      recentSuccessFunction,
      'date() { printf "%s\\n" "$TEST_NOW"; }',
      'if recent_success_is_fresh; then',
      '  printf "fresh:%s:%s\\n" "$RECENT_SUCCESS_AGE_SEC" "$RECENT_SUCCESS_WINDOW_SEC"',
      'else',
      '  printf "run\\n"',
      'fi',
      '',
    ].join('\n');
    const run = spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STATUS: statusPath,
        TEST_NOW: String(NOW),
        PC_BACKUP_SCHEDULED: scheduled ? '1' : '0',
        ...extraEnv,
      },
    });
    if (run.error) throw run.error;
    expect(run.status, run.stderr).toBe(0);
    return run.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runBash(script: string, env: Record<string, string> = {}): string {
  const run = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (run.error) throw run.error;
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
}

describe('papercusp-db-backup scheduled catch-up', () => {
  it.each([
    ['fresh scheduled success', { ok: true, lastSuccessEpoch: NOW - 100 }, true, {}, 'fresh:100:2700'],
    ['manual success', { ok: true, lastSuccessEpoch: NOW - 100 }, false, {}, 'run'],
    ['failed scheduled run', { ok: false, lastSuccessEpoch: NOW - 100 }, true, {}, 'run'],
    ['stale scheduled success', { ok: true, lastSuccessEpoch: NOW - 2700 }, true, {}, 'run'],
    ['future scheduled success', { ok: true, lastSuccessEpoch: NOW + 1 }, true, {}, 'run'],
  ])('classifies a %s', (_label, receipt, scheduled, extraEnv, expected) => {
    expect(runRecentSuccessCheck(receipt, scheduled, extraEnv)).toBe(expected);
  });

  it('keeps the catch-up guard ahead of backup setup and marks only the systemd service as scheduled', () => {
    expect(source.indexOf('if recent_success_is_fresh; then')).toBeGreaterThan(-1);
    expect(source.indexOf('if recent_success_is_fresh; then')).toBeLessThan(
      source.indexOf('mkdir -p "$DUMP"'),
    );
    expect(service).toContain('Environment=PC_BACKUP_SCHEDULED=1');
    expect(timer).toMatch(/^OnCalendar=.*$/m);
    expect(timer).toContain('Persistent=true');
  });
});

describe('papercusp-db-backup artifact receipt serialization', () => {
  it('serializes a receipt for every completed artifact with its own start and cluster identity', () => {
    const json = runBash([
      receiptHelpers,
      'DUMPED=(papercusp-state papercusp-transcript)',
      'declare -A ARTIFACT_DUMP_START_EPOCHS=([papercusp-state]=100 [papercusp-transcript]=200)',
      'declare -A ARTIFACT_DUMP_SYSTEM_IDENTIFIERS=([papercusp-state]=123456 [papercusp-transcript]=123456)',
      'printf "[%s]" "$(artifact_receipts_json)"',
      '',
    ].join('\n'));
    expect(JSON.parse(json)).toEqual([
      { artifact: 'papercusp-state', dumpStartEpoch: 100, systemIdentifier: '123456' },
      { artifact: 'papercusp-transcript', dumpStartEpoch: 200, systemIdentifier: '123456' },
    ]);
  });

  it('JSON-escapes artifact names before embedding them in STATUS.json', () => {
    const value = 'db"quoted\\path\nnext\tfield';
    const json = runBash(
      receiptHelpers + '\njson_string "$TEST_VALUE"',
      { TEST_VALUE: value },
    );
    expect(JSON.parse(json)).toBe(value);
  });
});
