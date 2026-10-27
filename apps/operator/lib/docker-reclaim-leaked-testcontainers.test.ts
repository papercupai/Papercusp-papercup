/**
 * WI-6554700010009309 (plan papercusp-performance-audit-2026-10-12 P-009):
 * the hourly docker reclaim (`bin/reclaim-docker-disk.sh`, step 4) removes
 * LEAKED testcontainers, and nothing else.
 *
 * libs/test-config starts every shared container with `.withReuse()` and Ryuk
 * disabled, so before this step nothing ever removed one. Each start now stamps
 * a last-use marker (libs/test-config/src/testcontainer-last-used.ts). The
 * script removes a container only when it carries `org.testcontainers=true`,
 * its marker is older than the idle threshold, AND it has no established
 * connection on a published port.
 *
 * These tests drive the SHIPPING script with fake `docker` / `ss` / `df` /
 * `podman` / `sudo` executables on PATH. No real container is touched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../bin/reclaim-docker-disk.sh');

const IDLE_ID = 'a'.repeat(64);
const BUSY_ID = 'b'.repeat(64);
const FRESH_ID = 'c'.repeat(64);
const UNMARKED_ID = 'd'.repeat(64);
const GONE_ID = 'e'.repeat(64);

const DAY_SECS = 86_400;
const HOUR_SECS = 3_600;
// WI-6554700010010406: 5 h, so the hourly timer keeps every leak under 6 h (R-4).
const DEFAULT_IDLE_SECS = 5 * HOUR_SECS;

interface Fixture {
  root: string;
  markers: string;
  calls: () => string[];
  run: (env?: Record<string, string>) => string;
  mark: (id: string, ageSecs: number) => void;
  mtimeAgeSecs: (id: string) => number;
}

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(opts: { ids: string[]; busyPorts?: string[] }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'reclaim-testcontainers-'));
  fixtures.push(root);
  const bin = join(root, 'bin');
  const markers = join(root, 'last-used');
  const log = join(root, 'calls');
  mkdirSync(bin);
  mkdirSync(join(root, 'store'));
  const executable = (name: string, body: string) =>
    writeFileSync(join(bin, name), '#!/bin/bash\n' + body, { mode: 0o755 });

  // Each container publishes one host port derived from its first id char, so
  // the busy container is told apart by the port ss reports connections on.
  executable(
    'docker',
    [
      'printf "docker %s\\n" "$*" >>"$FIXTURE_LOG"',
      'case "$1" in',
      '  info) if [[ "$*" == *--format* ]]; then echo "$FIXTURE_ROOT/store"; exit "${FIXTURE_INFO_FAIL:-0}"; fi; exit 0 ;;',
      '  ps) [[ "${FIXTURE_PS_FAIL:-0}" == 0 ]] || exit 31; printf "%s\\n" $FIXTURE_TC_IDS ;;',
      '  inspect) echo "/fixture-container img created=2026-10-01T00:00:00Z" ;;',
      '  port) [[ "${FIXTURE_PORT_FAIL:-0}" == 0 ]] || exit 32; p="${2:0:1}"; case "$p" in a) n=41001;; b) n=41002;; c) n=41003;; d) n=41004;; *) n=41009;; esac',
      '        echo "5432/tcp -> 0.0.0.0:$n"; echo "5432/tcp -> [::]:$n" ;;',
      '  volume) if [[ "$2" == ls ]]; then printf "%s\\n" ${FIXTURE_VOLUME_IDS:-}; exit "${FIXTURE_VOLUME_FAIL:-0}"; fi',
      '          if [[ "$2" == inspect ]]; then echo 2020-01-01T00:00:00Z; fi; exit 0 ;;',
      '  rm) exit "${FIXTURE_RM_EXIT:-0}" ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
  );
  // `ss` prints one established line per busy port named in its filter.
  executable(
    'ss',
    [
      'printf "ss %s\\n" "$*" >>"$FIXTURE_LOG"',
      '[[ "${FIXTURE_SS_FAIL:-0}" == 0 ]] || exit 33',
      'for p in $FIXTURE_BUSY_PORTS; do',
      '  if [[ "$*" == *":$p "* || "$*" == *":$p)"* ]]; then echo "ESTAB 0 0 127.0.0.1:$p 127.0.0.1:5555"; fi',
      'done',
    ].join('\n') + '\n',
  );
  executable('df', 'echo 100000000000\n');
  executable('podman', 'exit 1\n');
  executable('sudo', 'exit 1\n');

  return {
    root,
    markers,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    run: (env = {}) => {
      // An inherited override would mask the script's own default.
      const { TESTCONTAINER_IDLE_MAX_SECS: _inherited, ...inherited } = process.env;
      return execFileSync('bash', [SCRIPT], {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...inherited,
          PATH: `${bin}:${process.env.PATH}`,
          FIXTURE_LOG: log,
          FIXTURE_ROOT: root,
          PAPERCUSP_RELEASE_RETENTION_ROOT: join(root, 'pins'),
          PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, 'mutex'),
          FIXTURE_TC_IDS: opts.ids.join(' '),
          FIXTURE_BUSY_PORTS: (opts.busyPorts ?? []).join(' '),
          PAPERCUSP_TESTCONTAINERS_LAST_USED_DIR: markers,
          DRY_RUN: '0',
          SKIP_IMAGES: '1',
          RECLAIM_MIN_FREE_PCT: '101',
          ...env,
        },
      });
    },
    mark: (id, ageSecs) => {
      mkdirSync(markers, { recursive: true });
      const path = join(markers, id);
      writeFileSync(path, '');
      const t = new Date(Date.now() - ageSecs * 1000);
      utimesSync(path, t, t);
    },
    mtimeAgeSecs: (id) => (Date.now() - statSync(join(markers, id)).mtimeMs) / 1000,
  };
}

const removed = (calls: string[]) =>
  calls.filter((c) => c.startsWith('docker rm ')).map((c) => c.split(' ').pop());

describe('WI-6554700010009309 — docker reclaim removes only leaked testcontainers', () => {
  it('asks docker ONLY for containers labelled org.testcontainers=true', () => {
    const f = makeFixture({ ids: [] });
    f.run();
    const ps = f.calls().filter((c) => c.startsWith('docker ps'));
    expect(ps).toEqual(['docker ps -aq --no-trunc --filter label=org.testcontainers=true']);
  });

  it('removes an idle, unconnected testcontainer with its anonymous volumes, and drops its marker', () => {
    const f = makeFixture({ ids: [IDLE_ID] });
    f.mark(IDLE_ID, 2 * DAY_SECS);
    const out = f.run();
    expect(f.calls()).toContain(`docker rm -f -v ${IDLE_ID}`);
    expect(existsSync(join(f.markers, IDLE_ID))).toBe(false);
    expect(out).toMatch(/testcontainers removed=1 /);
  });

  it('keeps an idle-marked container that has an established connection, and refreshes its marker', () => {
    const f = makeFixture({ ids: [BUSY_ID], busyPorts: ['41002'] });
    f.mark(BUSY_ID, 2 * DAY_SECS);
    const out = f.run();
    expect(removed(f.calls())).toEqual([]);
    expect(f.mtimeAgeSecs(BUSY_ID)).toBeLessThan(60);
    expect(out).toMatch(/busy=1 /);
  });

  it('keeps a container used within the idle window', () => {
    const f = makeFixture({ ids: [FRESH_ID] });
    f.mark(FRESH_ID, DEFAULT_IDLE_SECS - HOUR_SECS / 2);
    f.run();
    expect(removed(f.calls())).toEqual([]);
  });

  it('defaults the idle threshold to 5 h, so the hourly tick never leaves a leak idle past 6 h (R-4)', () => {
    // Worst observed idle is threshold + one timer period (hourly). A 24 h or
    // 6 h default would let a leaked container sit 25 h or 7 h before removal.
    const f = makeFixture({ ids: [IDLE_ID] });
    f.mark(IDLE_ID, DEFAULT_IDLE_SECS + HOUR_SECS / 2);
    const out = f.run();
    expect(removed(f.calls())).toEqual([IDLE_ID]);
    expect(out).toMatch(/idle threshold 18000s/);
  });

  it('never removes a container on first sight: an unmarked one is stamped and its idle window starts', () => {
    const f = makeFixture({ ids: [UNMARKED_ID] });
    const out = f.run();
    expect(removed(f.calls())).toEqual([]);
    expect(existsSync(join(f.markers, UNMARKED_ID))).toBe(true);
    expect(f.mtimeAgeSecs(UNMARKED_ID)).toBeLessThan(60);
    expect(out).toMatch(/first_seen=1 /);
  });

  it('decides each container independently in a mixed population', () => {
    const f = makeFixture({ ids: [IDLE_ID, BUSY_ID, FRESH_ID, UNMARKED_ID], busyPorts: ['41002'] });
    f.mark(IDLE_ID, 3 * DAY_SECS);
    f.mark(BUSY_ID, 3 * DAY_SECS);
    f.mark(FRESH_ID, 600);
    f.run();
    expect(removed(f.calls())).toEqual([IDLE_ID]);
  });

  it('DRY_RUN previews the removal without removing, stamping, or collecting markers', () => {
    const f = makeFixture({ ids: [IDLE_ID, UNMARKED_ID] });
    f.mark(IDLE_ID, 2 * DAY_SECS);
    f.mark(GONE_ID, 2 * DAY_SECS);
    const out = f.run({ DRY_RUN: '1' });
    expect(removed(f.calls())).toEqual([]);
    expect(out).toMatch(/DRY_RUN would remove leaked testcontainer/);
    expect(existsSync(join(f.markers, UNMARKED_ID))).toBe(false);
    expect(existsSync(join(f.markers, GONE_ID))).toBe(true);
    expect(f.mtimeAgeSecs(IDLE_ID)).toBeGreaterThan(DAY_SECS);
  });

  it('collects markers whose container no longer exists', () => {
    const f = makeFixture({ ids: [FRESH_ID] });
    f.mark(FRESH_ID, 600);
    f.mark(GONE_ID, 600);
    writeFileSync(join(f.markers, 'not-a-container-id'), '');
    f.run();
    expect(existsSync(join(f.markers, GONE_ID))).toBe(false);
    expect(existsSync(join(f.markers, FRESH_ID))).toBe(true);
    expect(existsSync(join(f.markers, 'not-a-container-id'))).toBe(true);
  });

  it('honours SKIP_TESTCONTAINERS=1', () => {
    const f = makeFixture({ ids: [IDLE_ID] });
    f.mark(IDLE_ID, 2 * DAY_SECS);
    f.run({ SKIP_TESTCONTAINERS: '1' });
    expect(f.calls().some((c) => c.startsWith('docker ps'))).toBe(false);
    expect(removed(f.calls())).toEqual([]);
  });

  it('clamps an idle threshold below one hour to the 3600s floor', () => {
    const f = makeFixture({ ids: [FRESH_ID] });
    f.mark(FRESH_ID, 1800);
    const out = f.run({ TESTCONTAINER_IDLE_MAX_SECS: '60' });
    expect(removed(f.calls())).toEqual([]);
    expect(out).toMatch(/below the 3600s floor/);
  });

  it.each(['FIXTURE_PORT_FAIL', 'FIXTURE_SS_FAIL'])('retains an idle-marked container when %s makes live references unknown', (failure) => {
    const f = makeFixture({ ids: [IDLE_ID] });
    f.mark(IDLE_ID, 2 * DAY_SECS);
    const out = f.run({ [failure]: '1' });
    expect(removed(f.calls())).toEqual([]);
    const line = out.split('\n').find(line => line.startsWith('[docker-reclaim] store-receipt '))!;
    expect(JSON.parse(line.slice('[docker-reclaim] store-receipt '.length)))
      .toMatchObject({ status: 'native-failed', nativeFailures: 1, complete: false });
  });

  it.each(['FIXTURE_PS_FAIL', 'FIXTURE_VOLUME_FAIL', 'FIXTURE_RM_EXIT'])('preserves native failure evidence for %s without failing the timer', (failure) => {
    const f = makeFixture({ ids: [IDLE_ID] });
    f.mark(IDLE_ID, 2 * DAY_SECS);
    const out = f.run({ [failure]: '1' });
    const line = out.split('\n').find(line => line.startsWith('[docker-reclaim] store-receipt '))!;
    expect(JSON.parse(line.slice('[docker-reclaim] store-receipt '.length)))
      .toMatchObject({ status: 'native-failed', nativeFailures: 1, complete: false });
  });

  it('reports an absent ss instrument as incomplete and retains containers', () => {
    const f = makeFixture({ ids: [IDLE_ID] });
    f.mark(IDLE_ID, 2 * DAY_SECS);
    const tools = join(f.root, 'without-ss'); mkdirSync(tools);
    // A real PATH with only the needed executables makes command -v ss fail;
    // no production skip knob or replacement shell classifier is involved.
    for (const name of ['bash', 'node', 'python3', 'git', 'dirname', 'date', 'tail', 'tr',
      'timeout', 'grep', 'sed', 'sort', 'mkdir', 'stat', 'touch', 'rm', 'wc']) {
      symlinkSync(execFileSync('which', [name], { encoding: 'utf8' }).trim(), join(tools, name));
    }
    for (const name of ['docker', 'podman', 'sudo', 'df']) symlinkSync(join(f.root, 'bin', name), join(tools, name));
    const out = f.run({ PATH: tools });
    expect(out).toContain('ss not found');
    expect(removed(f.calls())).toEqual([]);
    const line = out.split('\n').find(line => line.startsWith('[docker-reclaim] store-receipt '))!;
    expect(JSON.parse(line.slice('[docker-reclaim] store-receipt '.length)))
      .toMatchObject({ status: 'native-failed', nativeFailures: 1, complete: false });
  });

  it('never consumes partial volume discovery after a native failure', () => {
    const f = makeFixture({ ids: [] });
    const out = f.run({ FIXTURE_VOLUME_IDS: IDLE_ID, FIXTURE_VOLUME_FAIL: '34', SKIP_TESTCONTAINERS: '1' });
    expect(f.calls().some(call => call.startsWith('docker volume rm'))).toBe(false);
    expect(out).toContain('"nativeFailures":1');
  });

  it('does not prune a store reported only by a failed Docker discovery command', () => {
    const f = makeFixture({ ids: [] });
    const out = f.run({ FIXTURE_INFO_FAIL: '35' });
    expect(f.calls().some(call => /docker (builder|image|volume|rm) /.test(call))).toBe(false);
    expect(out).toContain('"status":"discovery-failed"');
  });

  it('removes only old anonymous volumes even when discovery includes dangling named data', () => {
    const f = makeFixture({ ids: [] });
    f.run({ FIXTURE_VOLUME_IDS: IDLE_ID + ' bytebot_postgres_data', SKIP_TESTCONTAINERS: '1' });
    expect(f.calls().filter(call => call.startsWith('docker volume rm'))).toEqual([`docker volume rm ${IDLE_ID}`]);
  });
});
