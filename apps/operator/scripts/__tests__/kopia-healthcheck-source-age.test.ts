import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh copy-out mode), never by mutating the shared checkout.
const SOURCE_SCRIPT =
  process.env.KOPIA_HEALTHCHECK_SCRIPT ?? resolve(__dirname, '../systemd/kopia-healthcheck.sh');
const CACHE_BOOTSTRAP = resolve(__dirname, '../systemd/kopia-cache-bootstrap.sh');
const tempDirs: string[] = [];

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function snapshotTime(ageSeconds: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(new Date(Date.now() - ageSeconds * 1000))
      .map((part) => [part.type, part.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second + ' ' + parts.timeZoneName;
}

function sourceBlock(source: string, time: string): string[] {
  return [
    'jdoe@host:' + source,
    '  ' + time + ' abc123 1 GB drwxr-xr-x files:1 dirs:1',
  ];
}

interface UnitCgroupFixture {
  unit: string;
  /** cgroup.procs content, one pid per line. */
  procs: string;
  /** Successive `systemctl show -p SubState` answers; the last one repeats. */
  subStates: string[];
}

function runHealthcheck(
  dumpSnapshotAgeSeconds: number,
  status: Record<string, unknown> = {},
  unitCgroup?: UnitCgroupFixture,
) {
  const root = mkdtempSync(join(tmpdir(), 'kopia-healthcheck-source-age-'));
  tempDirs.push(root);
  // Every run gets its OWN unit-cgroup root (absent unless a fixture is given), so no
  // case ever reads the host's real kopia unit cgroups (WI-6554700010011924).
  const unitCgroupRoot = join(root, 'unit-cgroups');
  const fakeSystemctl = join(root, 'systemctl-stub.sh');
  const subStateCounter = join(root, 'substate-count');
  if (unitCgroup) {
    const cg = join(unitCgroupRoot, 'app.slice', unitCgroup.unit);
    mkdirSync(cg, { recursive: true });
    writeFileSync(join(cg, 'cgroup.procs'), unitCgroup.procs);
  }
  writeFileSync(
    fakeSystemctl,
    [
      '#!/usr/bin/env bash',
      'n=$(cat "$TEST_SUBSTATE_COUNTER" 2>/dev/null || echo 0)',
      'IFS=, read -ra states <<< "$TEST_SUBSTATES"',
      'i=$(( n < ${#states[@]} ? n : ${#states[@]} - 1 ))',
      'echo $((n + 1)) > "$TEST_SUBSTATE_COUNTER"',
      'printf "%s\\n" "${states[$i]}"',
    ].join('\n') + '\n',
  );
  chmodSync(fakeSystemctl, 0o755);

  const home = join(root, 'home');
  const dumpDir = join(root, 'db-dumps');
  const scriptDir = join(root, 'script');
  const fakeBin = join(root, 'bin');
  const logDir = join(root, 'logs');
  const stateDir = join(root, 'state');
  const fakeKopia = join(fakeBin, 'kopia');
  const testScript = join(scriptDir, 'kopia-healthcheck.sh');
  const alertStub = join(root, 'alert-stub.sh');
  const alertLog = join(root, 'alert.log');

  for (const path of [home, dumpDir, scriptDir, fakeBin, logDir, stateDir, join(home, 'macos-vm')]) {
    mkdirSync(path, { recursive: true });
  }

  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    join(dumpDir, 'STATUS.json'),
    JSON.stringify({ lastSuccessEpoch: now - 10 * 60, ...status }, null, 2),
  );

  const unrelated = join(root, 'unrelated-source');
  const allSources = [
    ...sourceBlock(unrelated, snapshotTime(60)),
    '',
    ...sourceBlock(dumpDir, snapshotTime(dumpSnapshotAgeSeconds)),
  ].join('\n');
  const homeListing = sourceBlock(home, snapshotTime(60)).join('\n');
  const vmListing = sourceBlock(join(home, 'macos-vm'), snapshotTime(60)).join('\n');

  writeFileSync(
    fakeKopia,
    [
      '#!/usr/bin/env bash',
      '[ "$KOPIA_LOG_DIR" = "$KOPIA_TEST_EXPECT_LOG_DIR" ] || { echo "missing KOPIA_LOG_DIR" >&2; exit 90; }',
      'if [ "$1" != "snapshot" ] || [ "$2" != "list" ]; then exit 2; fi',
      'case "$3" in',
      '  --all) printf %s\\n ' + shellQuote(allSources) + ' ;;',
      '  "$PAPERCUSP_HOST_PG_DUMP_DIR") printf %s\\n ' + shellQuote(sourceBlock(dumpDir, snapshotTime(dumpSnapshotAgeSeconds)).join('\n')) + ' ;;',
      '  "$HOME") printf %s\\n ' + shellQuote(homeListing) + ' ;;',
      '  "$HOME/macos-vm") printf %s\\n ' + shellQuote(vmListing) + ' ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n') + '\n',
  );
  chmodSync(fakeKopia, 0o755);

  const fakeSudo = join(fakeBin, 'sudo');
  writeFileSync(
    fakeSudo,
    '#!/usr/bin/env bash\nwhile [ "$1" = "-n" ] || [ "$1" = "--" ]; do shift; done\nexec "$@"\n',
  );
  chmodSync(fakeSudo, 0o755);

  writeFileSync(alertStub, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$TEST_ALERT_LOG"\n');
  chmodSync(alertStub, 0o755);

  const source = readFileSync(SOURCE_SCRIPT, 'utf8');
  writeFileSync(testScript, source);
  chmodSync(testScript, 0o755);
  writeFileSync(join(scriptDir, 'kopia-cache-bootstrap.sh'), readFileSync(CACHE_BOOTSTRAP, 'utf8'));

  const result = spawnSync('/usr/bin/env', ['bash', testScript], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: home,
      TZ: 'America/New_York',
      PATH: fakeBin + ':' + (process.env.PATH ?? '/usr/bin:/bin'),
      PAPERCUSP_HOST_PG_DUMP_DIR: dumpDir,
      KOPIA_HEALTHCHECK_BIN: fakeKopia,
      KOPIA_HEALTHCHECK_SUDO: fakeSudo,
      KOPIA_LOG_DIR: join(root, 'kopia-cli-logs'),
      KOPIA_TEST_EXPECT_LOG_DIR: join(root, 'kopia-cli-logs'),
      KOPIA_HEALTHCHECK_LOG_DIR: logDir,
      HEALTHCHECK_STATE_DIR: stateDir,
      ODDSMITH_DISCOVERY: join(root, 'missing-oddsmith.json'),
      KOPIA_VM_VERIFY_MARKER: join(root, 'missing-vm-marker'),
      BACKUP_ALERT_CMD: alertStub,
      TEST_ALERT_LOG: alertLog,
      MAX_SNAP_AGE_S: '3600',
      KOPIA_UNIT_CGROUP_ROOT: unitCgroupRoot,
      KOPIA_HEALTHCHECK_SYSTEMCTL: fakeSystemctl,
      TEST_SUBSTATES: (unitCgroup?.subStates ?? ['dead']).join(','),
      TEST_SUBSTATE_COUNTER: subStateCounter,
    },
  });

  return {
    systemctlCalls: existsSync(subStateCounter) ? Number(readFileSync(subStateCounter, 'utf8').trim()) : 0,
    result,
    log: readFileSync(join(logDir, 'healthcheck.log'), 'utf8'),
    alertLog: existsSync(alertLog) ? readFileSync(alertLog, 'utf8') : '',
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Kopia healthcheck dump-source recency', () => {
  it('fails when a fresh unrelated source masks a stale db-dumps source', () => {
    const run = runHealthcheck(3 * 60 * 60);
    const evidence = [run.result.stdout, run.result.stderr, run.log].join('\n');

    expect(run.result.status, evidence).toBe(1);
    expect(evidence).toContain('Postgres dump source snapshot is STALE');
    expect(evidence).toContain('ALARM SUPPRESSED');
    expect(run.alertLog).toBe('');
  });

  it('stays green when the exact db-dumps source has a recent complete snapshot', () => {
    const run = runHealthcheck(10 * 60);

    expect(run.result.status, [run.result.stdout, run.result.stderr, run.log].join('\n')).toBe(0);
    expect(run.log).toContain('OK: dump ');
    expect(run.alertLog).toBe('');
  });
});

describe('Kopia healthcheck dump duty cycle (WI-10004603)', () => {
  // Every run in this regime SUCCEEDS and the dump stays fresh, so no freshness
  // check can see it: the only signal is how long the last run took against the
  // hourly timer period. 3397 s is the run measured on 2026-10-01.
  it('fails when the last dump run took most of its hourly period, even though the dump is fresh', () => {
    const run = runHealthcheck(10 * 60, { elapsedSec: 3397, periodSec: 3600 });
    const evidence = [run.result.stdout, run.result.stderr, run.log].join('\n');

    expect(run.result.status, evidence).toBe(1);
    expect(evidence).toContain('Postgres dump run is near-continuous');
    expect(run.log).not.toContain('OK: dump ');
  });

  it('stays green when the last dump run left headroom in the hour', () => {
    const run = runHealthcheck(10 * 60, { elapsedSec: 1800, periodSec: 3600 });

    expect(run.result.status, [run.result.stdout, run.result.stderr, run.log].join('\n')).toBe(0);
    expect(run.log).toContain('OK: dump ');
  });

  it('does not judge a status written by a producer without the cadence lever (no periodSec)', () => {
    // The first runs after deploy still carry the old producer's 3397 s; paging on
    // them would page about a condition the next run already addresses.
    const run = runHealthcheck(10 * 60, { elapsedSec: 3397 });

    expect(run.result.status, [run.result.stdout, run.result.stderr, run.log].join('\n')).toBe(0);
    expect(run.log).toContain('OK: dump ');
  });

  it('does not let a duty-cycle warning hide a stale dump source (the duty check runs last)', () => {
    const run = runHealthcheck(3 * 60 * 60, { elapsedSec: 3397, periodSec: 3600 });
    const evidence = [run.result.stdout, run.result.stderr, run.log].join('\n');

    expect(run.result.status, evidence).toBe(1);
    expect(evidence).toContain('Postgres dump source snapshot is STALE');
    expect(evidence).not.toContain('near-continuous');
  });
});

describe('Kopia healthcheck: a process that outlived its stopped unit (WI-6554700010011924)', () => {
  // Measured 2026-10-14 04:53Z: ExecStopPost timed out, systemd logged "Unit process
  // ... remains running after unit stopped", and the unit sat in auto-restart for 30 min
  // with a root process still in its cgroup. Nothing paged.
  it('fails when a stopped kopia unit still holds a process in its cgroup', () => {
    const run = runHealthcheck(10 * 60, {}, {
      unit: 'kopia-home-snapshot.service',
      procs: '3691914\n473367\n',
      subStates: ['auto-restart'],
    });
    const evidence = [run.result.stdout, run.result.stderr, run.log].join('\n');

    expect(run.result.status, evidence).toBe(1);
    expect(evidence).toContain('outlived their stopped unit');
    expect(evidence).toContain('kopia-home-snapshot.service is stopped but its cgroup still holds pid(s) 3691914 473367');
    expect(run.log).not.toContain('OK: dump ');
  });

  it('stays green while the unit is legitimately running', () => {
    const run = runHealthcheck(10 * 60, {}, {
      unit: 'kopia-snapshots.service',
      procs: '4242\n',
      subStates: ['running'],
    });

    expect(run.result.status, [run.result.stdout, run.result.stderr, run.log].join('\n')).toBe(0);
    expect(run.log).toContain('OK: dump ');
  });

  it('does not flag a unit that starts between the two SubState reads', () => {
    const run = runHealthcheck(10 * 60, {}, {
      unit: 'kopia-home-snapshot.service',
      procs: '5151\n',
      subStates: ['auto-restart', 'start-pre'],
    });

    expect(run.result.status, [run.result.stdout, run.result.stderr, run.log].join('\n')).toBe(0);
    expect(run.systemctlCalls).toBe(2);
  });

  it('asks systemd nothing when the unit cgroup is empty', () => {
    const run = runHealthcheck(10 * 60, {}, {
      unit: 'kopia-home-snapshot.service',
      procs: '',
      subStates: ['failed'],
    });

    expect(run.result.status, [run.result.stdout, run.result.stderr, run.log].join('\n')).toBe(0);
    expect(run.systemctlCalls).toBe(0);
  });

  it('a stale dump source leads the page, and the leftover still rides on it (never silenced)', () => {
    // A leaked walk is likeliest exactly while backups are failing. The first version
    // only checked for leftovers after every other check passed, so a stale dump hid it.
    const run = runHealthcheck(3 * 60 * 60, {}, {
      unit: 'kopia-home-snapshot.service',
      procs: '3691914\n',
      subStates: ['auto-restart'],
    });
    const evidence = [run.result.stdout, run.result.stderr, run.log].join('\n');
    const failLine = run.log.split('\n').find((l) => l.includes('FAIL: ')) ?? '';

    expect(run.result.status, evidence).toBe(1);
    expect(failLine).toContain('Postgres dump source snapshot is STALE');
    expect(failLine).toContain('ALSO: Kopia process(es) outlived their stopped unit');
    expect(failLine).toContain('kopia-home-snapshot.service is stopped but its cgroup still holds pid(s) 3691914');
    expect(failLine.indexOf('STALE')).toBeLessThan(failLine.indexOf('ALSO:'));
  });

  it('does not append the leftover note to its own page', () => {
    const run = runHealthcheck(10 * 60, {}, {
      unit: 'kopia-home-snapshot.service',
      procs: '3691914\n',
      subStates: ['auto-restart'],
    });
    const failLine = run.log.split('\n').find((l) => l.includes('FAIL: ')) ?? '';

    expect(failLine).toContain('outlived their stopped unit');
    expect(failLine).not.toContain('ALSO:');
  });
});
