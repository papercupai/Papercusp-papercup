import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');
const source = readFileSync(SCRIPT, 'utf8');

function watchdogSource(): string {
  const match = source.match(/run_bounded_watched\(\) \{[\s\S]*?\n\}/);
  expect(match, 'run_bounded_watched must be extractable').toBeTruthy();
  return match?.[0] ?? '';
}

function functionBody(name: string): string {
  const start = source.indexOf(`${name}() {`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

describe('papercusp database-backup progress watchdog', () => {
  it('publishes a PID-bound host writer marker and removes it on EXIT', async () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-host-progress-marker-'));
    try {
      const dump = join(root, 'dump');
      const ready = join(root, 'ready');
      const release = join(root, 'release');
      const harness = join(root, 'marker-harness.sh');
      const markerWriter = functionBody('write_host_backup_progress_marker');
      const markerCleanup = functionBody('cleanup_host_backup_progress_marker');
      writeFileSync(harness, [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        'DUMP="$TEST_DUMP"',
        'mkdir -p "$DUMP"',
        'HOST_BACKUP_PROGRESS_PATH="$DUMP/IN_PROGRESS.$$.json"',
        markerWriter,
        markerCleanup,
        'trap cleanup_host_backup_progress_marker EXIT',
        'write_host_backup_progress_marker',
        'touch "$READY_PATH"',
        'while [ ! -e "$RELEASE_PATH" ]; do sleep 0.01; done',
        '',
      ].join('\n'));
      chmodSync(harness, 0o755);

      const child = spawn('bash', [harness], {
        env: { ...process.env, TEST_DUMP: dump, READY_PATH: ready, RELEASE_PATH: release },
        stdio: 'ignore',
      });
      const closed = new Promise<number | null>((resolve) => child.once('close', resolve));
      const deadline = Date.now() + 5_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(existsSync(ready)).toBe(true);

      const markerPath = join(dump, `IN_PROGRESS.${child.pid}.json`);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
      expect(marker).toMatchObject({ pid: child.pid, phase: 'host-backup' });
      expect(marker.processStartTicks).toMatch(/^\d+$/);
      expect(marker.startedAtEpoch).toBeTypeOf('number');

      writeFileSync(release, 'finish');
      expect(await closed).toBe(0);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a finite stall floor and a 150-minute absolute ceiling', () => {
    expect(source).toContain('TIMEOUT_SEC="${PC_BACKUP_TIMEOUT_SEC:-2700}"');
    expect(source).toContain('TIMEOUT_MAX_SEC="${PC_BACKUP_TIMEOUT_MAX_SEC:-9000}"');
    expect(source).toContain('PROGRESS_STALE_SEC="${PC_BACKUP_PROGRESS_STALE_SEC:-300}"');
    expect(source).toContain('KILL_GRACE_SEC="${PC_BACKUP_KILL_GRACE_SEC:-5}"');
    expect(source).toContain('[ "$TIMEOUT_MAX_SEC" -lt "$TIMEOUT_SEC" ]');
  });

  it('lets archive growth extend the floor but never the absolute ceiling', () => {
    const body = functionBody('run_bounded_watched');
    expect(body).toContain('measurement_output=$(sudo -n -u postgres du -sb "$progress_path" 2>&1)');
    expect(body).not.toContain('current_bytes=$(du -sb "$progress_path"');
    expect(body).not.toContain('current_bytes=${current_bytes:-0}');
    expect(body).toContain('[ "$current_bytes" -gt "$last_bytes" ]');
    expect(body).toContain('last_progress_epoch="$now_epoch"');
    expect(body).toContain('[ "$elapsed" -ge "$max_secs" ]');
    expect(body).toContain('[ "$elapsed" -ge "$floor_secs" ]');
    expect(body).toContain('[ $(( now_epoch - last_progress_epoch )) -ge "$PROGRESS_STALE_SEC" ]');
  });

  it('wires the live temporary directory into the watchdog and removes the blind timeout wrapper', () => {
    expect(source).toContain(
      'run_bounded_watched "$TIMEOUT_SEC" "$TIMEOUT_MAX_SEC" "$out.tmp"',
    );
    expect(source).not.toContain(
      'run_bounded_watched "$TIMEOUT_SEC" timeout --kill-after=20s "$TIMEOUT_SEC"',
    );
  });

  it.each([
    ['growing', 9, 'absolute watchdog ceiling'],
    ['stalled-after-floor', 6, 'killing stalled producer'],
    ['stalled-from-start', 4, 'killing stalled producer'],
  ] as const)('observes liveness before and termination at the %s boundary', (mode, due, reason) => {
    const root = mkdtempSync(join(tmpdir(), 'backup-watchdog-boundary-'));
    try {
      const clock = join(root, 'clock');
      const observations = join(root, 'observations');
      const progress = join(root, 'archive.tmp');
      const harness = join(root, 'boundary.sh');
      writeFileSync(clock, '0');
      // The injected clock and growth schedule drive the real watchdog. Its
      // privileged du still measures an actual directory and compressed-named
      // member. Only the fixture's wait/clock are synthetic (D-005).
      writeFileSync(harness, `#!/usr/bin/env bash
set -uo pipefail
PC_BACKUP_WATCH_SEC=1
PC_BACKUP_MIN_FREE_GB=0
PROGRESS_STALE_SEC=2
KILL_GRACE_SEC=0
mkdir -p "$PROGRESS_PATH"
: > "$PROGRESS_PATH/1.dat.zst"
fs_avail_gb() { echo 999999; }
log() { printf '%s\\n' "$*" >&2; }
reap_own_stragglers() { :; }
sudo() { shift 3; command "$@"; }
date() {
  local now
  now=$(cat "$CLOCK")
  if [[ -v dump_pid ]] && builtin kill -0 "$dump_pid" 2>/dev/null; then
    printf 'alive %s\\n' "$now" >> "$OBSERVATIONS"
  fi
  printf '%s\\n' "$now"
}
sleep() {
  [ "$1" != 0 ] || return 0
  local tick
  tick=$(( $(cat "$CLOCK") + 1 ))
  printf '%s\\n' "$tick" > "$CLOCK"
  if [ "$MODE" = growing ] || { [ "$MODE" = stalled-after-floor ] && [ "$tick" -le 4 ]; }; then
    printf x >> "$PROGRESS_PATH/1.dat.zst"
  fi
}
kill() {
  if [ "$1" = -TERM ]; then
    printf 'terminate %s\\n' "$(cat "$CLOCK")" >> "$OBSERVATIONS"
  fi
  builtin kill "$@"
}
${watchdogSource()}
run_bounded_watched 4 9 "$PROGRESS_PATH" /bin/sleep 30
`);
      const run = spawnSync('bash', [harness], {
        encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, MODE: mode, CLOCK: clock, OBSERVATIONS: observations, PROGRESS_PATH: progress },
      });
      expect(run.error, run.stderr).toBeUndefined();
      expect([137, 143], run.stderr).toContain(run.status);
      expect(run.stderr).toContain(reason);
      const observed = readFileSync(observations, 'utf8').trim().split('\n');
      expect(observed).toEqual([
        ...Array.from({ length: due }, (_, i) => `alive ${i + 1}`),
        `terminate ${due}`,
      ]);
      // The complete ordered trace falsifies an early kill even when a later
      // "dead by ceiling" assertion would pass. Production defaults are pinned
      // separately above; this fixture preserves the same predicate ordering.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('extends a growing archive past the floor but stops a stalled producer and a forever-growing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'backup-progress-watchdog-'));
    try {
      const harness = join(root, 'watchdog.sh');
      const progress = join(root, 'archive.tmp');
      writeFileSync(
        harness,
        `#!/usr/bin/env bash
set -uo pipefail
PC_BACKUP_WATCH_SEC=0.25
PC_BACKUP_MIN_FREE_GB=0
PROGRESS_STALE_SEC=2
KILL_GRACE_SEC=0
fs_avail_gb() { echo 999999; }
log() { printf '%s\\n' "$*" >&2; }
reap_own_stragglers() { :; }
sudo() {
  printf '%s\\n' "$*" >>"$SUDO_LOG"
  [ "$1" = "-n" ] && [ "$2" = "-u" ] && [ "$3" = "postgres" ] || return 125
  shift 3
  if [ "\${FAIL_PROGRESS_MEASURE:-0}" = "1" ]; then
    printf '%s\\n' 'du: Permission denied' >&2
    return 1
  fi
  command "$@"
}
${watchdogSource()}
case "$1" in
  growing)
    run_bounded_watched 2 12 "$PROGRESS_PATH" bash -c 'for i in 1 2 3 4 5 6 7 8; do printf x >> "$PROGRESS_PATH"; sleep 0.5; done'
    ;;
  startup)
    run_bounded_watched 2 12 "$PROGRESS_PATH" bash -c 'sleep 1; for i in 1 2 3 4; do printf x >> "$PROGRESS_PATH"; sleep 0.25; done'
    ;;
  stalled)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 8 "$PROGRESS_PATH" bash -c 'sleep 20'
    ;;
  ceiling)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 4 "$PROGRESS_PATH" bash -c 'for i in $(seq 1 20); do printf x >> "$PROGRESS_PATH"; sleep 1; done'
    ;;
  unmeasurable)
    : > "$PROGRESS_PATH"
    run_bounded_watched 2 8 "$PROGRESS_PATH" bash -c 'sleep 20'
    ;;
esac
`,
      );
      chmodSync(harness, 0o755);
      const sudoLog = join(root, 'sudo.log');
      const run = (mode: string, failMeasurement = false) => spawnSync('bash', [harness, mode], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PROGRESS_PATH: progress,
          SUDO_LOG: sudoLog,
          FAIL_PROGRESS_MEASURE: failMeasurement ? '1' : '0',
        },
        timeout: 15_000,
      });

      const growing = run('growing');
      expect(growing.status, growing.stderr).toBe(0);
      expect(readFileSync(progress, 'utf8')).toHaveLength(8);
      expect(readFileSync(sudoLog, 'utf8')).toContain('-n -u postgres du -sb');

      rmSync(progress, { force: true });
      const startup = run('startup');
      expect(startup.status, startup.stderr).toBe(0);
      expect(readFileSync(progress, 'utf8')).toHaveLength(4);

      rmSync(progress, { force: true });
      const stalled = run('stalled');
      expect(stalled.status, stalled.stderr).not.toBe(0);
      expect(stalled.stderr).toContain('killing stalled producer');

      rmSync(progress, { force: true });
      const ceiling = run('ceiling');
      expect(ceiling.status, ceiling.stderr).not.toBe(0);
      expect(ceiling.stderr).toContain('absolute watchdog ceiling 4s reached');

      rmSync(progress, { force: true });
      rmSync(sudoLog, { force: true });
      const unmeasurable = run('unmeasurable', true);
      expect(unmeasurable.status, unmeasurable.stderr).not.toBe(0);
      expect(unmeasurable.stderr).toContain('unable to measure archive progress');
      expect(unmeasurable.stderr).toContain('du_status=1 output=du: Permission denied');
      expect(unmeasurable.stderr).not.toContain('killing stalled producer');
      expect(readFileSync(sudoLog, 'utf8')).toContain('-n -u postgres du -sb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
