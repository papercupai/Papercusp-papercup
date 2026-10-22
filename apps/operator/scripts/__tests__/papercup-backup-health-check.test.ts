import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'papercup-backup-health-check.sh');
const PRODUCER = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');
const ALERT = resolve(__dirname, '..', 'systemd', 'kopia-backup-alert.sh');
const BACKUP_CONDITION_KEY = 'papercusp-db-backup-failing';

describe('papercup-backup-health-check.sh', () => {
  // NOTE (WI-2145430): `bash -n` is a SYNTAX check and is structurally blind to
  // an unescaped double quote inside a multi-line double-quoted body — that is
  // valid syntax which merely closes the string early. This case passed
  // unchanged for the whole time the disk-headroom alarm body was truncated.
  // The self-test's shell-runtime-error block below is what covers that class.
  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toBe('');
  });

  it('passes the shipped self-test, including disk-headroom discrimination', () => {
    // spawnSync, not execFileSync: a non-zero self-test used to surface only as
    // "Command failed: bash … --self-test", and the self-test's own FAIL lines
    // were dropped. The gate recorded exactly that for repairHead 709766df on
    // 2026-09-30 and it never reproduced, so the red carried no evidence. The
    // exit status, signal and FAIL lines now go into the assertion itself.
    // Nested health-check invocations otherwise inherit the production watch
    // list and rescan the shared /tmp and /tmp/pcv on every fixture. Keep this
    // self-test hermetic; the cases that exercise the entry-count probe pass
    // their own fixture path explicitly.
    const isolatedTmpWatch = mkdtempSync(join(tmpdir(), 'papercup-backup-health-watch-'));
    const run = (() => {
      try {
        return spawnSync('bash', [
          '-c',
          'test "$BACKUP_TMPDIR_WATCH" = "$1" || { echo "self-test did not receive its isolated tmp watch path" >&2; exit 97; }; exec bash "$2" --self-test',
          'backup-health-self-test',
          isolatedTmpWatch,
          SCRIPT,
        ], {
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, BACKUP_TMPDIR_WATCH: isolatedTmpWatch },
        });
      } finally {
        rmSync(isolatedTmpWatch, { recursive: true, force: true });
      }
    })();
    const output = run.stdout ?? '';
    // lastCheck names the last check that FINISHED. EI-25211496463956189: a timeout
    // (ETIMEDOUT/SIGTERM) left empty failLines and stderrTail, so the red never said
    // which probe was slow. The next check after lastCheck is the slow one.
    const checkLines = output.split('\n').filter((line) => /^\s+(ok|FAIL)\s/.test(line));
    expect({
      status: run.status,
      signal: run.signal,
      error: run.error?.message ?? null,
      failLines: output.split('\n').filter((line) => line.includes('FAIL')),
      stderrTail: (run.stderr ?? '').slice(-2000),
      lastCheck: checkLines.at(-1) ?? '(no check finished)',
    }).toEqual({
      status: 0,
      signal: null,
      error: null,
      failLines: [],
      stderrTail: expect.any(String),
      lastCheck: expect.any(String),
    });
    expect(output).toContain('post disk-headroom block');
    expect(output).toContain('stale stats do not create a false TOAST-bloat alarm');
    expect(output).toContain('persisted row estimate still flags genuine TOAST bloat');
    // WI-2145430: the self-test asserts that no probe path it exercised made
    // the SHELL itself complain. Anchored here so deleting that block from the
    // script fails this test instead of silently removing the only coverage of
    // a defect class `bash -n` cannot see.
    expect(output).toContain('post shell-runtime-error block');
    expect(output).toContain('no bash runtime error on any exercised probe path');
    expect(output).not.toMatch(/FAIL/);
  }, 150_000);

  it('keeps the degraded workspace-dump filing title stable for work-item dedupe', () => {
    const health = readFileSync(SCRIPT, 'utf8');

    // work_items:create fingerprints the admission title. Age is intentionally
    // measured in the body: including it in TITLE would turn each health-check
    // tick into a new critical item as the artifact gets older.
    expect(health).toContain(
      'TITLE="Workspace DB dump is stale after its latest snapshot hook degraded: $art"',
    );
    expect(health).not.toContain(
      'TITLE="Workspace DB dump is stale after its latest snapshot hook degraded: $art is ${age_hours}h old"',
    );
    expect(health).toContain(
      "BODY=\"The optional per-workspace dump '$f' is ${age_hours} hours old",
    );
  });

  it('never pipes a producer into an early-exit grep under pipefail (WI-10005986)', () => {
    // The script runs `set -uo pipefail`. In `producer | grep -q PAT`, grep exits on
    // the first match. A producer that writes in more than one chunk then dies of
    // SIGPIPE on its next write, and pipefail turns the pipeline non-zero WITH a
    // match. The gate recorded exactly that at repairHead c697f739 (2026-10-03): mawk
    // wrote the 5.3 KB check_db_disk_headroom range as 4096 + 1222 bytes, and
    // self-test check 19 read a present `${consumers}` as FAIL. It depends on load, so
    // it rarely reproduces locally. Here-strings (`grep -q PAT <<<"$x"`) have no producer.
    const earlyExitGrep = /\|\s*grep\s+(?:-[A-Za-z]+\s+)*(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)\b/;
    // Calibration: the detector must flag the defective shape and pass the fixed one,
    // or a clean result below would be vacuous.
    expect(earlyExitGrep.test(`  if guard_body | grep -q '\\\${consumers}'; then`)).toBe(true);
    expect(earlyExitGrep.test(`  if printf '%s' "$out" | grep -E -q "$want_re"; then`)).toBe(true);
    expect(earlyExitGrep.test(`  if grep -q '\\\${consumers}' <<<"$guard_text"; then`)).toBe(false);

    const health = readFileSync(SCRIPT, 'utf8');
    expect(health).toMatch(/^set -uo pipefail$/m);
    const offenders = health
      .split('\n')
      .map((line, index) => ({ line, lineNo: index + 1 }))
      .filter(({ line }) => !line.trimStart().startsWith('#') && earlyExitGrep.test(line))
      .map(({ line, lineNo }) => `${lineNo}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("keeps the health probe's producer-fit policy synchronized with db-backup.sh", () => {
    const health = readFileSync(SCRIPT, 'utf8');
    const producer = readFileSync(PRODUCER, 'utf8');

    // The probe intentionally mirrors the producer's env/default seam because
    // systemd snapshots each script independently. If either default changes,
    // this guard fails before the two thresholds can drift silently again.
    expect(health).toMatch(/PC_BACKUP_MIN_FREE_GB="\$\{PC_BACKUP_MIN_FREE_GB:-120\}"/);
    expect(health).toMatch(/PC_BACKUP_SPACE_SAFETY="\$\{PC_BACKUP_SPACE_SAFETY:-140\}"/);
    expect(producer).toMatch(/PC_BACKUP_MIN_FREE_GB="\$\{PC_BACKUP_MIN_FREE_GB:-120\}"/);
    expect(producer).toMatch(/PC_BACKUP_SPACE_SAFETY="\$\{PC_BACKUP_SPACE_SAFETY:-140\}"/);
  });

  it('raises and resolves the same sender-scoped backup condition', () => {
    const temp = mkdtempSync(join(tmpdir(), 'papercusp-backup-condition-'));
    try {
      const bin = join(temp, 'bin');
      const dump = join(temp, 'dump');
      const capture = join(temp, 'coord-send.json');
      mkdirSync(bin);
      const nodeShim = join(bin, 'node');
      writeFileSync(nodeShim, [
        '#!/usr/bin/env sh',
        'if [ "$2" = "coord:send" ]; then',
        '  printf "%s" "$3" > "$CAPTURE_PAYLOAD"',
        'fi',
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(nodeShim, 0o755);
      const notifyShim = join(bin, 'notify-send');
      writeFileSync(notifyShim, '#!/usr/bin/env sh\nexit 0\n');
      chmodSync(notifyShim, 0o755);

      const alertRun = spawnSync('bash', [ALERT, 'test failure'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          CAPTURE_PAYLOAD: capture,
          PAPERCUSP_HOST_PG_DUMP_DIR: dump,
        },
      });
      expect({
        status: alertRun.status,
        signal: alertRun.signal,
        error: alertRun.error?.message ?? null,
      }).toEqual({ status: 0, signal: null, error: null });

      const alert = readFileSync(capture, 'utf8');
      expect(JSON.parse(alert)).toMatchObject({
        to: ['*'],
        expects: 'none',
        conditionKey: BACKUP_CONDITION_KEY,
      });
      expect(readFileSync(ALERT, 'utf8')).toContain('--client system-backup-alert');

      const producer = readFileSync(PRODUCER, 'utf8');
      const successBranch = producer.slice(producer.lastIndexOf('if $OK; then'));
      const markerClear = successBranch.indexOf('rm -f "$DUMP/ALERT-BACKUP-FAILING"');
      const resolution = successBranch.indexOf(`"resolvesCondition":"${BACKUP_CONDITION_KEY}"`);
      expect(markerClear).toBeGreaterThanOrEqual(0);
      expect(resolution).toBeGreaterThan(markerClear);
      expect(successBranch).toContain('--client system-backup-alert');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
