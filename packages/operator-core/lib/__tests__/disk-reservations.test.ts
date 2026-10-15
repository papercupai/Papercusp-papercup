/**
 * Guards the build disk-reservation ledger reader (EI-21951384112327922).
 *
 * THE BUG: disk-admission preflights only READ free space and reserve nothing, so
 * concurrent multi-GB builds each pass on the same bytes and collectively exhaust
 * the disk. Measured before the fix: two callers each demanding 75% of free space
 * were BOTH admitted, promising 606GB against 404GB free.
 *
 * The shell half is guarded by papercusp-desktop/bin/lib/disk-preflight.selftest.sh.
 * This file guards the Node half, and — the property neither side can check alone —
 * that the two agree on WHERE the ledger is. A divergence there does not throw: it
 * silently splits the ledger so each language reads an empty one, which is
 * indistinguishable from "no other builds are running". That is the failure mode
 * worth a test, because it disables the guard while every test still passes.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assessCargoDiskAdmission,
  // @ts-ignore -- runtime reporter module intentionally tested from TypeScript.
} from '../../../../scripts/lib/cargo-result.mjs';
import {
  mountKeyForPath,
  assessAllocationDiskAdmission,
  readReservedGb,
  readReservationSnapshot,
  reservationDir,
  // @ts-ignore -- runtime reporter module intentionally tested from TypeScript.
} from '../../../../scripts/lib/disk-reservations.mjs';

const GIB = 1024 * 1024 * 1024;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..', '..', '..', '..');
const SHELL_LIB = join(REPO_ROOT, 'papercusp-desktop', 'bin', 'lib', 'disk-preflight.sh');

const tmpDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'pc-resv-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function seedReservation(
  ledger: string,
  key: string,
  name: string,
  fields: Record<string, string | number>,
): void {
  mkdirSync(join(ledger, key), { recursive: true });
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(join(ledger, key, name), `${body}\n`);
}

describe('disk reservation ledger — Node reader', () => {
  it('keeps the shared ledger fixed when builders redirect TMPDIR', () => {
    const scratchRoot = scratch();
    const otherScratch = scratch();
    const defaultLedger = '/tmp/papercusp-disk-reservations';
    const shell = (env: NodeJS.ProcessEnv) => execFileSync('bash', [
      '-c', 'source "$1"; papercusp_reservation_dir', 'bash', SHELL_LIB,
    ], { env, encoding: 'utf8' });
    const first = { ...process.env, TMPDIR: scratchRoot, PAPERCUSP_DISK_RESERVATION_DIR: '' };
    const second = { ...first, TMPDIR: otherScratch };

    expect(reservationDir(first)).toBe(defaultLedger);
    expect(reservationDir(second)).toBe(defaultLedger);
    expect(shell(first)).toBe(defaultLedger);
    expect(shell(second)).toBe(defaultLedger);

    const explicit = { ...second, PAPERCUSP_DISK_RESERVATION_DIR: join(scratchRoot, 'isolated-ledger') };
    expect(reservationDir(explicit)).toBe(explicit.PAPERCUSP_DISK_RESERVATION_DIR);
    expect(shell(explicit)).toBe(explicit.PAPERCUSP_DISK_RESERVATION_DIR);
  });

  it('distinguishes measured absence from unreadable and malformed reservation evidence', () => {
    const root = scratch(), target = scratch();
    const ledger = join(root, 'ledger');
    const env = { ...process.env, PAPERCUSP_DISK_RESERVATION_DIR: ledger };
    expect(readReservationSnapshot(target, { env })).toMatchObject({ state: 'measured', reservedBytes: 0, issues: [] });
    writeFileSync(ledger, 'not a directory');
    expect(readReservationSnapshot(target, { env })).toMatchObject({ state: 'unknown', reservedBytes: null });
    expect(readReservedGb(target, { env })).toBe(0); // Existing admission semantics.
    rmSync(ledger);
    seedReservation(ledger, mountKeyForPath(target), 'invalid.res', {
      pid: process.pid, gb: 'invalid', expires: Math.floor(Date.now() / 1000) + 600,
    });
    expect(readReservationSnapshot(target, { env })).toMatchObject({
      state: 'unknown', reservedBytes: null, issues: ['claim:invalid-demand'],
    });
    expect(readReservedGb(target, { env })).toBe(0);
  });

  it('retains known live demand on aliases while an additional live claim remains unknown', () => {
    const root = scratch(), ledger = scratch(), alias = join(root, 'alias');
    mkdirSync(alias);
    const env = { ...process.env, PAPERCUSP_DISK_RESERVATION_DIR: ledger };
    const key = mountKeyForPath(root), expires = Math.floor(Date.now() / 1000) + 600;
    seedReservation(ledger, key, 'known.res', { pid: process.pid, gb: 2, expires });
    expect(readReservationSnapshot(alias, { env })).toMatchObject({ state: 'measured', deviceKey: key, reservedBytes: 2 * GIB });
    seedReservation(ledger, key, 'unknown.res', { pid: process.pid, gb: 'bad', expires });
    expect(readReservationSnapshot(alias, { env })).toMatchObject({ state: 'unknown', reservedBytes: null, knownReservedBytes: 2 * GIB });
    expect(readReservedGb(root, { env })).toBe(2);
  });

  it.each(['blank-demand', 'blank-expiry', 'expired'])('does not interpret a %s record as healthy live evidence', (scenario) => {
    const target = scratch(), ledger = scratch();
    const env = { ...process.env, PAPERCUSP_DISK_RESERVATION_DIR: ledger };
    seedReservation(ledger, mountKeyForPath(target), 'claim.res', {
      pid: process.pid, gb: scenario === 'blank-demand' ? '' : 'invalid',
      expires: scenario === 'blank-expiry' ? '' : Math.floor(Date.now() / 1000) + (scenario === 'expired' ? -10 : 600),
    });
    const result = readReservationSnapshot(target, { env });
    expect(result).toMatchObject(scenario === 'expired' ? { state: 'measured', reservedBytes: 0 } : { state: 'unknown', reservedBytes: null });
    expect(readReservedGb(target, { env })).toBe(0);
  });

  it('R11 CLI dry-run groups all destinations and preserves the full window budget without reserving', () => {
    const root = scratch();
    const ledger = join(root, 'ledger');
    const primary = join(root, 'primary');
    const recovery = join(root, 'recovery');
    const journals = join(root, 'journals');
    const result = spawnSync(join(REPO_ROOT, 'node_modules/.bin/tsx'), [
      join(REPO_ROOT, 'scripts/r11-window-snapshot.mts'), 'reserve', join(primary, 'T0.json.gz'), '--dry-run',
    ], { encoding: 'utf8', timeout: 30_000, env: { ...process.env,
      R11_RECOVERY_ROOT: recovery, R11_JOURNAL_ROOT: journals, PAPERCUSP_DISK_RESERVATION_DIR: ledger } });
    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout.trim());
    expect(report.lifetimeSec).toBe(93600);
    expect(report.admission.devices).toHaveLength(1);
    expect(report.admission.devices[0]).toMatchObject({ paths: [primary, recovery, journals],
      allocationBytes: 88 * GIB, protectedBytes: 36 * GIB, requiredBytes: 124 * GIB });
    expect(result.status, result.stderr).toBe(report.admission.admitted ? 0 : 2);
    expect(existsSync(ledger)).toBe(false);
  }, 35_000);
  it('strict evidence admission rejects measure-only success and verifies a long-lived receipt', () => {
    const ledger = scratch();
    const target = scratch();
    const command = (override: string) => execFileSync('bash', ['-c',
      'source "$1"; export PAPERCUSP_DISK_RESERVATION_DIR="$2" PAPERCUSP_DISK_RESERVATION_TTL_SEC=100800; ' +
      override + '; papercusp_require_disk_reservation "$3" 1 evidence',
      'strict-test', SHELL_LIB, ledger, target], { encoding: 'utf8', stdio: 'pipe' });
    expect(() => command('papercusp_free_gb() { printf 100; }')).not.toThrow();
    expect(() => command('papercusp_free_gb() { :; }')).toThrow();
    expect(() => command('papercusp_free_gb() { printf 100; }; papercusp_ledger_lock() { return 1; }')).toThrow();
    expect(() => command('papercusp_require_free_gb() { return 0; }')).toThrow();
  });
  it.each(['valid', 'short-life', 'small-budget', 'wrong-purpose', 'peer', 'physical-shortage'])(
    'strict pre-admitted window validates %s and preserves the ancestor receipt', (scenario) => {
      const ledger = scratch();
      const target = scratch();
      const child = [
        'source "$1"',
        'scenario="$4"',
        'papercusp_free_gb() { if [ "$scenario" = physical-shortage ]; then printf 77; else printf 100; fi; }',
        'status=0',
        'papercusp_require_disk_reservation "$2" 78 native "$3" || status=$?',
        'if [ "$status" = 0 ]; then',
        '  [ "$PAPERCUSP_DISK_RESERVATION_FILE" = "$3" ] || exit 99',
        '  papercusp_release_disk_reservation',
        'fi',
        '[ -f "$3" ] || exit 98',
        'printf "CHILD_STATUS=%s\\n" "$status"',
        'exit "$status"',
      ].join('\n');
      const parent = [
        'source "$1"',
        'export PAPERCUSP_DISK_RESERVATION_DIR="$2" PAPERCUSP_DISK_RESERVATION_TTL_SEC=32400',
        'papercusp_free_gb() { printf 100; }',
        // Linux ancestry must read exact kernel metadata, not run a scanner per edge.
        'if [ -d /proc/self ]; then ps() { printf "UNEXPECTED_ANCESTRY_PS\\n" >&2; return 91; }; export -f ps; fi',
        'papercusp_require_disk_reservation "$3" 78 native || exit $?',
        'receipt="$PAPERCUSP_DISK_RESERVATION_FILE"',
        'trap \'PAPERCUSP_DISK_RESERVATION_FILE="$receipt" papercusp_release_disk_reservation; [ -z "${peer:-}" ] || kill "$peer" 2>/dev/null\' EXIT',
        'case "$5" in',
        '  short-life) sed -i "s/^expires=.*/expires=$(($(date +%s) + 60))/" "$receipt" ;;',
        '  small-budget) sed -i "s/^gb=.*/gb=65/" "$receipt" ;;',
        '  wrong-purpose) sed -i "s/^label=.*/label=other/" "$receipt" ;;',
        '  peer) sleep 30 >/dev/null 2>&1 & peer=$!; sed -i "s/^pid=.*/pid=$peer/; s/^start=.*/start=$(papercusp_proc_starttime "$peer")/" "$receipt" ;;',
        'esac',
        'export PAPERCUSP_DISK_RESERVATION_TTL_SEC=21600',
        'bash -c "$4" strict-child "$1" "$3" "$receipt" "$5"',
      ].join('\n');
      const result = spawnSync('bash', ['-c', parent, 'strict-parent', SHELL_LIB, ledger, target, child, scenario],
        { encoding: 'utf8', timeout: 15_000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(scenario === 'valid' ? 0 : 28);
      expect(result.stdout).toContain(`CHILD_STATUS=${scenario === 'valid' ? 0 : 28}`);
      if (scenario === 'valid') expect(result.stdout).toContain('adopted 78GB ancestor reservation');
      if (scenario === 'peer') expect(result.stdout).not.toContain('adopted');
    }, 20_000);

  it('rejects collectively oversized evidence destinations on one physical device', () => {
    const paths = [scratch(), scratch(), scratch()];
    const allocations = paths.map((path, i) => ({ path, bytes: [25, 24, 24][i] * GIB }));
    const options = { protectedBytes: 36 * GIB,
      availableBytesForPath: () => 100 * GIB, reservedBytesForPath: () => 5 * GIB };
    // Every destination individually fits; collectively 73 + 36 exceeds 95.
    for (const allocation of allocations) {
      expect(assessAllocationDiskAdmission([allocation], options).admitted).toBe(true);
    }
    const result = assessAllocationDiskAdmission(allocations, options);
    expect(result.admitted).toBe(false);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]).toMatchObject({ allocationBytes: 73 * GIB,
      requiredBytes: 109 * GIB, effectiveBytes: 95 * GIB });
    expect(assessAllocationDiskAdmission(allocations, {
      ...options, availableBytesForPath: () => 114 * GIB,
    }).admitted).toBe(true);
  });
  it('keeps distinct devices separate and refuses unknown evidence capacity', () => {
    const allocations = [{ path: '/a', bytes: 24 * GIB }, { path: '/b', bytes: 24 * GIB }];
    const options = { keyForPath: (path: string) => path, protectedBytes: 36 * GIB,
      availableBytesForPath: () => 60 * GIB, reservedBytesForPath: () => 0 };
    expect(assessAllocationDiskAdmission(allocations, options).admitted).toBe(true);
    expect(() => assessAllocationDiskAdmission(allocations, {
      ...options, keyForPath: () => '',
    })).toThrow('unknown');
    expect(() => assessAllocationDiskAdmission(allocations, {
      ...options, availableBytesForPath: () => NaN,
    })).toThrow('unknown');
  });
  it('counts live legacy claims across mount aliases before admitting another build', () => {
    const ledger = scratch();
    const a = scratch();
    const b = scratch();
    const fakeBin = scratch();
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(fakeBin, 'df'), '#!/bin/sh\nprintf "%s\\n" ' + [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      `same-device 209715200 104857600 104857600 50% ${a}`,
      `same-device 209715200 104857600 104857600 50% ${b}`,
    ].map(quote).join(' ') + '\nexit 1 # an unrelated inaccessible mount must not hide readable mount rows\n');
    chmodSync(join(fakeBin, 'df'), 0o755);
    const fields = { pid: process.pid, start: currentStart(process.pid), expires: Math.floor(Date.now() / 1000) + 3600 };
    seedReservation(ledger, a.replace(/[^A-Za-z0-9]/g, '_'), 'a.res', { ...fields, gb: 60 });
    seedReservation(ledger, b.replace(/[^A-Za-z0-9]/g, '_'), 'b.res', { ...fields, gb: 35 });
    seedReservation(ledger, 'dev-0', 'other.res', { ...fields, gb: 500 });
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PAPERCUSP_DISK_RESERVATION_DIR: ledger };
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = env.PATH;
      expect(mountKeyForPath(a)).toBe(mountKeyForPath(b));
      expect(readReservedGb(a, { env })).toBe(95);
      expect(readReservedGb(b, { env })).toBe(95);
      expect(readReservationSnapshot(a, { env })).toMatchObject({ state: 'measured', reservedBytes: 95 * GIB, issues: [] });
      expect(readReservationSnapshot(b, { env })).toMatchObject({ state: 'measured', reservedBytes: 95 * GIB, issues: [] });
      const unmapped = '_unmapped_fixture';
      seedReservation(ledger, unmapped, 'live.res', { ...fields, gb: 7 });
      expect(readReservationSnapshot(a, { env })).toMatchObject({ state: 'unknown', reservedBytes: null,
        knownReservedBytes: 95 * GIB, issues: [`legacy-mounts:unresolved-claim:${unmapped}`] });
      seedReservation(ledger, unmapped, 'live.res', { ...fields, gb: 7, expires: 1 });
      expect(readReservationSnapshot(a, { env })).toMatchObject({ state: 'measured', reservedBytes: 95 * GIB });
      seedReservation(ledger, unmapped, 'live.res', { ...fields, gb: 7, start: 'not-the-current-process' });
      expect(readReservationSnapshot(a, { env })).toMatchObject({ state: 'measured', reservedBytes: 95 * GIB });
    } finally { process.env.PATH = originalPath; }
    const refusal = execFileSync('bash', ['-c', 'source "$1"; papercusp_require_free_gb "$2" 10 alias >/dev/null 2>&1; printf "%s" "$?"', '--', SHELL_LIB, a], { env, encoding: 'utf8', timeout: 30_000 });
    expect(refusal).toBe('28'); // 100 free - 95 reserved cannot admit ten.
  });

  it('a new shell claim is visible to the Node reader through a filesystem alias', () => {
    const ledger = scratch();
    const a = scratch();
    const b = scratch();
    const reader = join(REPO_ROOT, 'scripts/lib/disk-reservations.mjs');
    const script = 'source "$1"; papercusp_free_gb() { printf 100; }; papercusp_require_free_gb "$2" 12 alias >/dev/null || exit $?; ' +
      '"$4" --input-type=module -e \'import(process.argv[2]).then(m=>process.stdout.write(String(m.readReservedGb(process.argv[1]))))\' "$3" "$5"';
    expect(execFileSync('bash', ['-c', script, '--', SHELL_LIB, a, b, process.execPath, reader], {
      env: { ...process.env, PAPERCUSP_DISK_RESERVATION_DIR: ledger }, encoding: 'utf8', timeout: 30_000,
    })).toBe('12');
  });

  it('agrees with the shell writer on the ledger key for the same path', () => {
    // The load-bearing cross-language property. Executes BOTH derivations rather
    // than asserting a hardcoded string, so a change to either side is caught.
    const path = scratch();
    const fromShell = execFileSync(
      'bash',
      ['-c', `source ${JSON.stringify(SHELL_LIB)} && papercusp_mount_key ${JSON.stringify(path)}`],
      { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' },
    ).trim();
    const fromNode = mountKeyForPath(path);

    expect(fromNode).not.toBe('');
    expect(fromNode).toBe(fromShell);
  });

  it('sums a live reservation written in the shell format', () => {
    const ledger = scratch();
    const key = mountKeyForPath(ledger);
    // process.pid is live and its /proc start time is genuine, so this survives
    // both the liveness and the pid-recycling check.
    seedReservation(ledger, key, 'a.res', {
      pid: process.pid,
      start: currentStart(process.pid),
      gb: 12,
      expires: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: ledger } })).toBe(12);
  });

  it('ignores a reservation whose owner is gone', () => {
    const ledger = scratch();
    const key = mountKeyForPath(ledger);
    // A pid that cannot be running: exceeds any pid_max on this platform.
    seedReservation(ledger, key, 'dead.res', {
      pid: 4_294_967_000,
      gb: 500,
      expires: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: ledger } })).toBe(0);
  });

  it('ignores a reservation whose pid was recycled (start time differs)', () => {
    const ledger = scratch();
    const key = mountKeyForPath(ledger);
    // Live pid, wrong start time — the exact shape of a wrapped pid, which happens
    // ~daily here under fleet load, so trusting the pid alone is a false positive.
    seedReservation(ledger, key, 'recycled.res', {
      pid: process.pid,
      start: '999999999',
      gb: 500,
      expires: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: ledger } })).toBe(0);
  });

  it('ignores an expired reservation even when its owner is alive', () => {
    const ledger = scratch();
    const key = mountKeyForPath(ledger);
    seedReservation(ledger, key, 'expired.res', {
      pid: process.pid,
      start: currentStart(process.pid),
      gb: 500,
      expires: Math.floor(Date.now() / 1000) - 1,
    });
    expect(readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: ledger } })).toBe(0);
  });

  it('fails open to 0 when the ledger does not exist', () => {
    const ledger = scratch();
    expect(
      readReservedGb(ledger, { env: { PAPERCUSP_DISK_RESERVATION_DIR: join(ledger, 'nope') } }),
    ).toBe(0);
  });

  it('reservationDir honours an explicit ledger override', () => {
    expect(reservationDir({ PAPERCUSP_DISK_RESERVATION_DIR: '/x/y' })).toBe('/x/y');
  });
});

describe('assessCargoDiskAdmission — reservation awareness', () => {
  const roomy = { totalBytes: 2_000 * GIB, freeBytes: 300 * GIB };

  it('admits when nothing is reserved', () => {
    expect(assessCargoDiskAdmission(roomy).allowed).toBe(true);
  });

  it('omitting reservedBytes reproduces the previous decision exactly', () => {
    // The additive-change guarantee: every existing caller is unaffected.
    const without = assessCargoDiskAdmission(roomy);
    const withZero = assessCargoDiskAdmission({ ...roomy, reservedBytes: 0 });
    expect(withZero.allowed).toBe(without.allowed);
    expect(withZero.reasons).toEqual(without.reasons);
    expect(withZero.freeGiB).toBe(without.freeGiB);
  });

  it('REFUSES when other live builds have reserved the headroom', () => {
    // The defect, at this writer: 300 GiB free looks admissible, but 298 GiB of it
    // is already promised. Admitting here is how the disk gets collectively drained.
    const admission = assessCargoDiskAdmission({ ...roomy, reservedBytes: 298 * GIB });
    expect(admission.allowed).toBe(false);
    expect(admission.reasons).toContain('reserved-by-other-builds');
    expect(admission.effectiveFreeGiB).toBe(2);
  });

  it('keeps freeBytes as the RAW measurement while deciding on the effective one', () => {
    // A caller reporting disk pressure still wants the true figure; only the
    // decision uses free-minus-reserved.
    const admission = assessCargoDiskAdmission({ ...roomy, reservedBytes: 298 * GIB });
    expect(admission.freeGiB).toBe(300);
    expect(admission.reservedGiB).toBe(298);
  });

  it('never lets a nonsense reservation invert the measurement', () => {
    const admission = assessCargoDiskAdmission({ ...roomy, reservedBytes: 5_000 * GIB });
    expect(admission.effectiveFreeBytes).toBe(0);
    expect(admission.allowed).toBe(false);
  });

  it('ignores a negative or non-finite reservedBytes rather than adding space', () => {
    for (const bad of [-100 * GIB, Number.NaN, Number.POSITIVE_INFINITY]) {
      const admission = assessCargoDiskAdmission({ ...roomy, reservedBytes: bad });
      expect(admission.reservedBytes).toBe(0);
      expect(admission.allowed).toBe(true);
    }
  });
});

/** Read this process's own /proc start time, the way the reader does. */
function currentStart(pid: number): string {
  try {
    const stat = execFileSync('cat', [`/proc/${pid}/stat`], {
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    const rest = stat.slice(stat.lastIndexOf(') ') + 2);
    return rest.split(/\s+/)[19] || '';
  } catch {
    return '';
  }
}
