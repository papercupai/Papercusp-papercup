// vite-build-singleflight — the one seam every operator-vite bundle build goes
// through. Two properties are under test:
//
//   EI-9836  two ONE-SHOT `vite build` invocations must not race the same dist/:
//            the second BLOCKS (bounded) until the first finishes, then proceeds
//            — unlike vite-watch-singleton (EI-306), which REFUSES a second
//            watcher outright.
//   EI-10539 a build that FAILS must not destroy the bundle that is serving.
//            vite empties outDir in a renderStart hook, so a link-time failure
//            (e.g. a missing named export — measured on vite 8.0.16) dies AFTER
//            dist/ has been emptied and leaves a dead app behind a 503 telling
//            you to run the very build that just failed. The script therefore
//            builds into dist.next/ and renames it over dist/ ONLY on success.
//
// Both are exercised through the VITE_BUILD_CMD seam (a shell command stands in
// for vite; it writes into $PAPERCUSP_VITE_OUT_DIR exactly as the real vite
// config does) and VITE_BUILD_OUT_ROOT (dist/ lives in a tmp tree, never the
// app's live bundle).
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../bin/vite-build-singleflight');

let tmp = '';
const children: ChildProcess[] = [];

function launch(env: Record<string, string>): ChildProcess {
  const child = spawn(SCRIPT, [], {
    env: {
      ...process.env,
      VITE_BUILD_LOCK: join(tmp, 'build.lock'),
      // Never let a test touch the app's real dist/.
      VITE_BUILD_OUT_ROOT: tmp,
      // Retention is the DEFAULT now (dist-chunk-retention-default-2026-07-26),
      // so the STAGING path these tests exercise is reached only via the explicit
      // `=0` opt-out. Pinning it here also isolates the suite from whatever the
      // ambient environment happens to set. The tests that care about the default
      // regime override this back to '' / '1' themselves.
      PAPERCUSP_RETAIN_DIST_CHUNKS: '0',
      // Keep the shared reservation ledger out of the live host ledger. The
      // script's preflight still runs against the real temp filesystem.
      PAPERCUSP_DISK_RESERVATION_DIR: join(tmp, 'disk-reservations'),
      // Pin the measured production default so the suite is independent of an
      // operator's ambient override. Heap-contract cases override this value.
      PAPERCUSP_VITE_BUILD_HEAP_MB: '8192',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

function collect(child: ChildProcess): { stdout: () => string; stderr: () => string; exited: Promise<number | null> } {
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => (out += String(d)));
  child.stderr?.on('data', (d) => (err += String(d)));
  const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));
  return { stdout: () => out, stderr: () => err, exited };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// WI-10008303: how long a spawned build may take to reach its command. Startup
// latency is not what these tests measure, and under a loaded gate run a spawned
// bash + preflight lost more than the old fixed 5 s. Bounded by a deadline, not
// an attempt count, so a slow poll loop cannot shrink the budget.
const START_DEADLINE_MS = 30_000;
// The holder's safety valve: it exits 9 on its own after HOLD_SECS so a leaked
// holder cannot run forever. It must outlast the start deadline plus a waiter's
// own startup, or a slow waiter finds the lock already free and races.
const HOLD_SECS = 90;
// Timeout for cases that start multiple build processes and verify the default lock.
const DEFAULT_LOCK_TEST_TIMEOUT_MS = 120_000;

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + START_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(50);
  }
  if (existsSync(path)) return;
  throw new Error(`Build did not reach its command within ${START_DEADLINE_MS}ms: ${path}`);
}

const holdBuild = `touch "$TEST_STARTED"; end=$(( $(date +%s) + ${HOLD_SECS} )); while [ "$(date +%s)" -lt "$end" ]; do [ ! -e "$TEST_RELEASE" ] || exit 0; sleep 0.05; done; exit 9`;

/** Seed a previous, WORKING bundle in dist/ — the thing a red build must not eat. */
function seedWorkingBundle(): void {
  mkdirSync(join(tmp, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(tmp, 'dist', 'index.html'), 'OLD-WORKING-BUNDLE');
  writeFileSync(join(tmp, 'dist', 'assets', 'app-old.js'), 'console.log(1)');
}

/** Stand-in for vite: writes a complete bundle into the staging dir, then exits `status`. */
function fakeVite(status: number, opts: { sleepSecs?: number } = {}): string {
  const nap = opts.sleepSecs ? `sleep ${opts.sleepSecs}; ` : '';
  return (
    `mkdir -p "$PAPERCUSP_VITE_OUT_DIR/assets"; ` +
    `echo NEW-BUNDLE > "$PAPERCUSP_VITE_OUT_DIR/index.html"; ` +
    `echo 'console.log(2)' > "$PAPERCUSP_VITE_OUT_DIR/assets/app-new.js"; ` +
    `${nap}exit ${status}`
  );
}

const distIndex = () => readFileSync(join(tmp, 'dist', 'index.html'), 'utf8').trim();

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      if (c.pid && c.exitCode === null) process.kill(c.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  }
});

describe('vite-build-singleflight — build serialization (EI-9836)', () => {
  it('allows independent output roots to build concurrently with the default lock', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const started = join(tmp, 'started');
    const release = join(tmp, 'release');
    const first = collect(launch({
      VITE_BUILD_LOCK: '', TMPDIR: tmp, VITE_BUILD_OUT_ROOT: join(tmp, 'first'),
      TEST_STARTED: started, TEST_RELEASE: release, VITE_BUILD_CMD: holdBuild,
    }));
    try {
      await waitForFile(started);
      const second = collect(launch({
        VITE_BUILD_LOCK: '', TMPDIR: tmp, VITE_BUILD_OUT_ROOT: join(tmp, 'second'),
        VITE_BUILD_WAIT_SECS: '1', VITE_BUILD_CMD: 'echo independent-build',
      }));
      expect(await second.exited).toBe(0);
      expect(second.stdout()).toContain('independent-build');
    } finally {
      writeFileSync(release, 'release');
      await first.exited;
    }
  }, DEFAULT_LOCK_TEST_TIMEOUT_MS);

  it('serializes symlink aliases of the same output root with the default lock', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const output = join(tmp, 'output');
    const alias = join(tmp, 'alias');
    mkdirSync(output);
    symlinkSync(output, alias, 'dir');
    const started = join(tmp, 'started');
    const release = join(tmp, 'release');
    const first = collect(launch({
      VITE_BUILD_LOCK: '', TMPDIR: tmp, VITE_BUILD_OUT_ROOT: output,
      TEST_STARTED: started, TEST_RELEASE: release, VITE_BUILD_CMD: holdBuild,
    }));
    try {
      await waitForFile(started);
      const second = collect(launch({
        VITE_BUILD_LOCK: '', TMPDIR: tmp, VITE_BUILD_OUT_ROOT: alias,
        VITE_BUILD_WAIT_SECS: '1', VITE_BUILD_CMD: 'echo raced',
      }));
      expect(await second.exited).toBe(1);
      expect(second.stderr()).toContain('TIMED OUT');
      expect(second.stdout()).not.toContain('raced');
    } finally {
      writeFileSync(release, 'release');
      await first.exited;
    }
  }, DEFAULT_LOCK_TEST_TIMEOUT_MS);

  // WI-10008303: the budgets above only hold together if they are ordered. A
  // holder that self-releases before a slow waiter starts lets the waiter race,
  // and a start deadline past the test timeout reports as a bare timeout.
  it('keeps its own start and hold budgets ordered', () => {
    expect(START_DEADLINE_MS).toBeLessThan(HOLD_SECS * 1000);
    expect(HOLD_SECS * 1000).toBeLessThan(DEFAULT_LOCK_TEST_TIMEOUT_MS);
  });

  // WI-6554700010009957: the disk preflight runs in front of EVERY build. The host
  // lists hundreds of mounts (285 measured), and one subprocess per mount cost ~1.6 s
  // of each trivial build under gate load, which timed out the 10 s cases in this
  // file. Count the external commands the reservation-key scan runs when `df -a`
  // reports 2,000 extra mounts: the count must not grow with the mount table, and a
  // legacy (mount-name) key must still be found.
  it('the disk preflight runs no subprocess per host mount', () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const lib = resolve(__dirname, '../../../../papercusp-desktop/bin/lib/disk-preflight.sh');
    const shims = join(tmp, 'shims');
    const target = join(tmp, 'target');
    const resRoot = join(tmp, 'disk-reservations');
    const counter = join(tmp, 'exec-count');
    const legacyKey = target.replace(/[^A-Za-z0-9]/g, '_');
    mkdirSync(shims);
    mkdirSync(target);
    // A legacy key directory, so the mount-table scan really runs.
    mkdirSync(join(resRoot, legacyKey), { recursive: true });
    const realPath = process.env.PATH ?? '/usr/bin:/bin';
    for (const tool of ['tr', 'sed', 'awk', 'cut', 'stat', 'basename', 'dirname', 'cat']) {
      writeFileSync(
        join(shims, tool),
        ['#!/bin/sh', `echo ${tool} >> "$EXEC_COUNT"`, `PATH="$REAL_PATH" exec ${tool} "$@"`, ''].join('\n'),
        { mode: 0o755 },
      );
    }
    writeFileSync(
      join(shims, 'df'),
      [
        '#!/bin/sh',
        'echo df >> "$EXEC_COUNT"',
        'PATH="$REAL_PATH" df "$@"',
        'case " $* " in *" -a "*)',
        '  i=0',
        '  while [ "$i" -lt 2000 ]; do echo "fakefs 1 1 1 1% /fake/mnt/$i"; i=$((i + 1)); done',
        '  echo "fakefs 1 1 1 1% $TARGET" ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const res = spawnSync('bash', ['-c', 'source "$LIB" && papercusp_reservation_keys "$TARGET"'], {
      env: {
        ...process.env,
        PATH: `${shims}:${realPath}`,
        REAL_PATH: realPath,
        EXEC_COUNT: counter,
        LIB: lib,
        TARGET: target,
        PAPERCUSP_DISK_RESERVATION_DIR: resRoot,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(res.status).toBe(0);
    const keys = res.stdout.trim().split('\n');
    expect(keys[0]).toMatch(/^dev-\d+$/);
    expect(keys).toContain(legacyKey);
    // One subprocess per mount would be more than 2,000 here; the scan needs a handful.
    const execs = readFileSync(counter, 'utf8').trim().split('\n');
    expect(execs.length).toBeLessThan(50);
  }, 75_000);

  it('derives the default lock key without starting Node', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const io = collect(launch({
      VITE_BUILD_LOCK: '', TMPDIR: tmp, VITE_BUILD_OUT_ROOT: join(tmp, 'out'),
      // No node on PATH: a key derivation that still needs Node fails here.
      PATH: '/usr/bin:/bin',
      VITE_BUILD_CMD: 'echo keyed',
    }));
    expect(await io.exited).toBe(0);
    expect(io.stdout()).toContain('keyed');
    const locks = readdirSync(tmp).filter((n) => n.startsWith('papercup-operator-vite-build-') && n.endsWith('.lock'));
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatch(/^papercup-operator-vite-build-[0-9a-f]{64}\.lock$/);
  }, DEFAULT_LOCK_TEST_TIMEOUT_MS);

  it('a second one-shot build WAITS for the first, then runs — never races or refuses', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const started = join(tmp, 'first-started');
    const release = join(tmp, 'first-release');
    const first = launch({ TEST_STARTED: started, TEST_RELEASE: release, VITE_BUILD_CMD: holdBuild });
    const firstRes = collect(first);
    let secondRes: ReturnType<typeof collect> | undefined;
    try {
      await waitForFile(started);
      const second = launch({ VITE_BUILD_CMD: 'echo second-done' });
      secondRes = collect(second);

      // The second invocation must remain pending while the known-ready holder owns the lock.
      await sleep(200);
      expect(second.exitCode).toBeNull();
    } finally {
      writeFileSync(release, 'release');
    }

    expect(await firstRes.exited).toBe(0);
    expect(secondRes).toBeDefined();
    expect(await secondRes!.exited).toBe(0);
    expect(secondRes!.stdout()).toContain('second-done');
  }, DEFAULT_LOCK_TEST_TIMEOUT_MS);

  it('captures a requested snapshot before releasing the lock to the next build', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const started = join(tmp, 'first-started');
    const release = join(tmp, 'first-release');
    const first = launch({
      VITE_BUILD_SNAPSHOT_DIR: join(tmp, 'snapshot'),
      TEST_STARTED: started,
      TEST_RELEASE: release,
      VITE_BUILD_CMD:
        'mkdir -p "$PAPERCUSP_VITE_OUT_DIR"; echo FIRST > "$PAPERCUSP_VITE_OUT_DIR/index.html"; ' +
        'touch "$TEST_STARTED"; while [ ! -e "$TEST_RELEASE" ]; do sleep 0.05; done; exit 0',
    });
    const firstRes = collect(first);
    let secondRes: ReturnType<typeof collect> | undefined;
    try {
      await waitForFile(started);
      const second = launch({
        VITE_BUILD_CMD: 'mkdir -p "$PAPERCUSP_VITE_OUT_DIR"; echo SECOND > "$PAPERCUSP_VITE_OUT_DIR/index.html"; exit 0',
      });
      secondRes = collect(second);
      await sleep(200); // Give the second process time to queue before releasing the holder.
    } finally {
      writeFileSync(release, 'release');
    }

    expect(await firstRes.exited).toBe(0);
    expect(secondRes).toBeDefined();
    expect(await secondRes!.exited).toBe(0);
    expect(readFileSync(join(tmp, 'snapshot', 'index.html'), 'utf8').trim()).toBe('FIRST');
    expect(distIndex()).toBe('SECOND');
  }, DEFAULT_LOCK_TEST_TIMEOUT_MS);

  it('a fresh lock is acquired uncontested and the command exit status propagates', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const ok = launch({ VITE_BUILD_CMD: 'true' });
    const { exited } = collect(ok);
    expect(await exited).toBe(0);
  }, 10_000);

  it('refuses before invoking Vite when the target filesystem lacks headroom', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const attempted = join(tmp, 'vite-was-invoked');
    const blocked = launch({
      PAPERCUSP_VITE_BUILD_MIN_FREE_GB: '99999999',
      VITE_BUILD_CMD: `touch "${attempted}"; exit 0`,
    });
    const io = collect(blocked);

    expect(await io.exited).toBe(28);
    expect(existsSync(attempted)).toBe(false);
    expect(io.stderr()).toContain('insufficient disk');
    expect(io.stderr()).toContain('operator-vite dist build');
    expect(io.stderr()).toContain(tmp);
  }, 10_000);

  it('propagates a failing build command status instead of masking it', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const failing = launch({ VITE_BUILD_CMD: 'exit 7' });
    const { exited } = collect(failing);
    expect(await exited).toBe(7);
  }, 10_000);

  it('a waiter that TIMES OUT reports the holder pid and does not hang', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const started = join(tmp, 'started');
    const release = join(tmp, 'release');
    const holder = launch({ TEST_STARTED: started, TEST_RELEASE: release, VITE_BUILD_CMD: holdBuild });
    const holderRes = collect(holder);
    try {
      await waitForFile(started);
      const waiter = launch({ VITE_BUILD_CMD: 'echo unreachable', VITE_BUILD_WAIT_SECS: '1' });
      const { stderr, exited } = collect(waiter);
      expect(await exited).toBe(1);
      expect(stderr()).toContain('TIMED OUT');
      expect(stderr()).toContain('EI-9836');

      // The holder is untouched by the waiter's timeout — still running.
      expect(holder.exitCode).toBeNull();
    } finally {
      writeFileSync(release, 'release');
    }
    expect(await holderRes.exited).toBe(0);
  }, DEFAULT_LOCK_TEST_TIMEOUT_MS);

  // EI-24961470606265468: an unattended build sets ONE knob for every lock wait in
  // its chain. Here it alone sets the wait (1s), and an explicit
  // VITE_BUILD_WAIT_SECS still beats a large umbrella value.
  it('the unattended lock-wait knob sets the wait, and the specific knob still wins', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const started = join(tmp, 'started');
    const release = join(tmp, 'release');
    const holderRes = collect(launch({
      TEST_STARTED: started, TEST_RELEASE: release, VITE_BUILD_CMD: holdBuild,
    }));
    try {
      // Do not race the waiter against holder startup. Once this marker exists,
      // the holder has acquired the build lock and entered its command.
      await waitForFile(started);

      const umbrellaOnly = collect(launch({
        VITE_BUILD_CMD: 'echo unreachable', VITE_BUILD_WAIT_SECS: '',
        PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: '1',
      }));
      expect(await umbrellaOnly.exited).toBe(1);
      expect(umbrellaOnly.stderr()).toContain('TIMED OUT after 1s');

      const specificWins = collect(launch({
        VITE_BUILD_CMD: 'echo unreachable', VITE_BUILD_WAIT_SECS: '1',
        PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: '600',
      }));
      expect(await specificWins.exited).toBe(1);
      expect(specificWins.stderr()).toContain('TIMED OUT after 1s');
    } finally {
      writeFileSync(release, 'release');
    }
    expect(await holderRes.exited).toBe(0);
  }, DEFAULT_LOCK_TEST_TIMEOUT_MS);
});

describe('vite-build-singleflight — Node heap contract (EI-22614955223428270)', () => {
  const captureNodeOptions = (path: string) => `printf '%s' "$NODE_OPTIONS" > "${path}"`;

  it('sets the measured 8 GiB default when the caller has no heap pin', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const captured = join(tmp, 'node-options');
    const build = launch({
      NODE_OPTIONS: '',
      VITE_BUILD_CMD: captureNodeOptions(captured),
    });
    const io = collect(build);

    expect(await io.exited).toBe(0);
    expect(readFileSync(captured, 'utf8')).toBe('--max-old-space-size=8192');
    expect(io.stderr()).toContain('set Node old-space ceiling to 8192 MiB');
  }, 10_000);

  it('raises a smaller heap while preserving unrelated NODE_OPTIONS', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const captured = join(tmp, 'node-options');
    const build = launch({
      NODE_OPTIONS: '--trace-warnings --max-old-space-size 4096',
      VITE_BUILD_CMD: captureNodeOptions(captured),
    });
    const io = collect(build);

    expect(await io.exited).toBe(0);
    expect(readFileSync(captured, 'utf8')).toBe(
      '--trace-warnings --max-old-space-size 4096 --max-old-space-size=8192',
    );
    expect(io.stderr()).toContain('raised Node old-space ceiling from 4096 MiB to 8192 MiB');
  }, 10_000);

  it('preserves a larger caller heap byte-for-byte', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const captured = join(tmp, 'node-options');
    const callerOptions = '--trace-warnings --max-old-space-size=12288';
    const build = launch({
      NODE_OPTIONS: callerOptions,
      VITE_BUILD_CMD: captureNodeOptions(captured),
    });

    expect(await collect(build).exited).toBe(0);
    expect(readFileSync(captured, 'utf8')).toBe(callerOptions);
  }, 10_000);

  it('honors a valid configured heap and falls back from malformed input', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const configuredPath = join(tmp, 'configured-node-options');
    const configured = launch({
      NODE_OPTIONS: '',
      PAPERCUSP_VITE_BUILD_HEAP_MB: '10240',
      VITE_BUILD_CMD: captureNodeOptions(configuredPath),
    });
    expect(await collect(configured).exited).toBe(0);
    expect(readFileSync(configuredPath, 'utf8')).toBe('--max-old-space-size=10240');

    const fallbackPath = join(tmp, 'fallback-node-options');
    const fallback = launch({
      NODE_OPTIONS: '',
      PAPERCUSP_VITE_BUILD_HEAP_MB: 'not-a-number',
      VITE_BUILD_CMD: captureNodeOptions(fallbackPath),
    });
    const fallbackIo = collect(fallback);
    expect(await fallbackIo.exited).toBe(0);
    expect(readFileSync(fallbackPath, 'utf8')).toBe('--max-old-space-size=8192');
    expect(fallbackIo.stderr()).toContain("invalid PAPERCUSP_VITE_BUILD_HEAP_MB='not-a-number'; using 8192");
  }, 10_000);
});

describe('vite-build-singleflight — a red build must not destroy the bundle (EI-10539)', () => {
  it('a FAILING build leaves the previous working dist/ completely intact', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    // The real killer: vite empties outDir at renderStart, then dies at link
    // time — so it HAS written into its out dir and still exits non-zero.
    const failing = launch({ VITE_BUILD_CMD: fakeVite(1) });
    const { exited } = collect(failing);
    expect(await exited).toBe(1);

    // The app that was serving is still serving. This is the whole fix.
    expect(distIndex()).toBe('OLD-WORKING-BUNDLE');
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-old.js'))).toBe(true);
    // Nothing from the failed build leaked into dist/, and no staging debris is left.
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-new.js'))).toBe(false);
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false);
    expect(existsSync(join(tmp, 'dist.prev'))).toBe(false);
  }, 15_000);

  it('records the failure so the 503 can say "the last build FAILED" instead of "run the build"', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    const failing = launch({ VITE_BUILD_CMD: `echo 'does not provide an export named tapClientResource'; ${fakeVite(1)}` });
    expect(await collect(failing).exited).toBe(1);

    const marker = JSON.parse(readFileSync(join(tmp, '.vite-build-failure.json'), 'utf8'));
    expect(marker.exitCode).toBe(1);
    expect(marker.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The log the 503 points at actually names the error.
    expect(readFileSync(marker.log, 'utf8')).toContain('tapClientResource');
  }, 15_000);

  // WI-10003916: a green-pin release deploy (setup-release runs the DEFAULT retain
  // regime and discards stdout with `1>/dev/null`) failed with no vite error anywhere:
  // the marker was written only in the RETAIN=0 branch, and the rollback's rebuild
  // truncated .vite-build.log minutes later. Pin all three halves of the evidence.
  it('a failing RETAIN-regime build records a marker and puts the vite error on STDERR', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    const failing = launch({
      PAPERCUSP_RETAIN_DIST_CHUNKS: '1',
      VITE_BUILD_CMD: `echo 'RolldownError: "tapClientResource" is not exported'; exit 1`,
    });
    const io = collect(failing);
    expect(await io.exited).toBe(1);

    // A caller that throws stdout away still sees WHY the build failed.
    expect(io.stderr()).toContain('build FAILED (exit 1)');
    expect(io.stderr()).toContain('tapClientResource');
    const marker = JSON.parse(readFileSync(join(tmp, '.vite-build-failure.json'), 'utf8'));
    expect(marker.exitCode).toBe(1);
    expect(readFileSync(marker.log, 'utf8')).toContain('tapClientResource');
  }, 15_000);

  it('the failed build log survives the NEXT build, and a retain success clears the stale marker', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    const failing = launch({ PAPERCUSP_RETAIN_DIST_CHUNKS: '1', VITE_BUILD_CMD: `echo 'ERR-FIRST-BUILD'; exit 1` });
    expect(await collect(failing).exited).toBe(1);
    const failedLog = JSON.parse(readFileSync(join(tmp, '.vite-build-failure.json'), 'utf8')).log;

    // The recovery build (setup-release's rollback) runs next and rewrites .vite-build.log.
    const recovery = launch({
      PAPERCUSP_RETAIN_DIST_CHUNKS: '1',
      VITE_BUILD_CMD: 'echo RECOVERED > "$VITE_BUILD_OUT_ROOT/dist/index.html"; echo recovery-ok; exit 0',
    });
    expect(await collect(recovery).exited).toBe(0);

    expect(readFileSync(join(tmp, '.vite-build.log'), 'utf8')).not.toContain('ERR-FIRST-BUILD');
    expect(readFileSync(failedLog, 'utf8')).toContain('ERR-FIRST-BUILD');
    expect(existsSync(join(tmp, '.vite-build-failure.json'))).toBe(false);
  }, 15_000);

  it('a SUCCESSFUL build swaps the staged bundle over dist/ and clears a stale failure record', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();
    writeFileSync(join(tmp, '.vite-build-failure.json'), '{"failedAt":"2026-07-12T00:00:00Z","exitCode":1,"log":"/x"}');

    const ok = launch({ VITE_BUILD_CMD: fakeVite(0) });
    expect(await collect(ok).exited).toBe(0);

    expect(distIndex()).toBe('NEW-BUNDLE');
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-new.js'))).toBe(true);
    // A clean-empty build is a REPLACEMENT, not a merge — the old chunks go.
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-old.js'))).toBe(false);
    // Staging dirs cleaned up, and the stale failure record is gone.
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false);
    expect(existsSync(join(tmp, 'dist.prev'))).toBe(false);
    expect(existsSync(join(tmp, '.vite-build-failure.json'))).toBe(false);
  }, 15_000);

  it('dist/ keeps serving the OLD bundle for the whole build — never a half-written or empty dist', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    // A build that takes real time: mid-flight, dist/ must still be the old
    // bundle — in-place builds spend this entire window empty (the 503 / "failed
    // to import module script" window that EI-9836 chased).
    const building = launch({ VITE_BUILD_CMD: fakeVite(0, { sleepSecs: 1.5 }) });
    const res = collect(building);
    await sleep(600);
    expect(building.exitCode).toBeNull(); // still building
    expect(distIndex()).toBe('OLD-WORKING-BUNDLE'); // …and still serving

    expect(await res.exited).toBe(0);
    expect(distIndex()).toBe('NEW-BUNDLE'); // swapped only at the end
  }, 15_000);

  it('a build that exits 0 without producing a bundle never touches dist/', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    // `--help`, a no-op, or the plain `echo` seams above: nothing to swap in.
    // The one thing we must not do is mistake "no output" for "empty bundle".
    const noop = launch({ VITE_BUILD_CMD: 'echo nothing-to-build' });
    expect(await collect(noop).exited).toBe(0);

    expect(distIndex()).toBe('OLD-WORKING-BUNDLE');
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false);
  }, 10_000);

  it('a RETAIN-regime build is passed through unstaged — it accumulates chunks in dist/ by design', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    // A retain build runs with emptyOutDir:false — it never empties dist/, so it
    // is already crash-safe, and staging it would throw away the very chunks an
    // open webview is pinned to. It must build straight into dist/, as before.
    const retain = launch({
      PAPERCUSP_RETAIN_DIST_CHUNKS: '1',
      VITE_BUILD_CMD: 'echo NEW-IN-PLACE > "$VITE_BUILD_OUT_ROOT/dist/index.html"; exit 0',
    });
    expect(await collect(retain).exited).toBe(0);

    expect(distIndex()).toBe('NEW-IN-PLACE');
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-old.js'))).toBe(true); // retained
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false); // never staged
  }, 10_000);

  // The load-bearing regression test for dist-chunk-retention-default-2026-07-26.
  // The bug that shipped: retention was opt-IN, so a bare `npm run build` on the
  // shared tree wiped every hashed chunk and 404'd the owner's open windows. A
  // bare build must now RETAIN without anyone remembering an env var — if this
  // ever goes back to staging-by-default, the whole class is armed again.
  it('a BARE build (no env at all) retains by default — chunks survive, nothing is staged', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    const bare = launch({
      PAPERCUSP_RETAIN_DIST_CHUNKS: '', // as if never set — NOT the '0' opt-out
      VITE_BUILD_CMD: 'echo NEW-IN-PLACE > "$VITE_BUILD_OUT_ROOT/dist/index.html"; exit 0',
    });
    expect(await collect(bare).exited).toBe(0);

    expect(distIndex()).toBe('NEW-IN-PLACE');
    // The chunk an already-open window is pinned to is STILL THERE.
    expect(existsSync(join(tmp, 'dist', 'assets', 'app-old.js'))).toBe(true);
    expect(existsSync(join(tmp, 'dist.next'))).toBe(false);
  }, 10_000);

  it('warns loudly on the =0 opt-out, naming the consequence for open windows', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();

    const wiping = launch({
      PAPERCUSP_RETAIN_DIST_CHUNKS: '0',
      VITE_BUILD_CMD: 'mkdir -p "$PAPERCUSP_VITE_OUT_DIR"; echo NEW > "$PAPERCUSP_VITE_OUT_DIR/index.html"; exit 0',
    });
    const io = collect(wiping);
    expect(await io.exited).toBe(0);
    expect(io.stderr()).toContain('PAPERCUSP_RETAIN_DIST_CHUNKS=0');
    expect(io.stderr()).toContain('Importing a module script failed');
  }, 10_000);
});

// WI-10006797: the bundle carries its own source-read time, dated AFTER the
// singleflight lock wait. scripts/lib/spa-require-built.sh compares it with
// source mtimes; the caller's earlier stamp made every edit made while the build
// was queued (38 min, measured 2026-10-06) look unbuilt.
describe('vite-build-singleflight — source-read stamp (WI-10006797)', () => {
  const stampPath = () => join(tmp, 'dist', '.vite-build-source-read-at');
  const mtime = (p: string) => statSync(p).mtimeMs;
  const marksLeft = () => readdirSync(tmp).filter((n) => n.startsWith('.vite-build-source-read.'));

  it('dates the stamp to when the build began reading source — after its lock wait, not when it queued', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    const started = join(tmp, 'first-started');
    const release = join(tmp, 'first-release');
    const cmdAt = join(tmp, 'second-cmd-at');
    const first = collect(launch({ TEST_STARTED: started, TEST_RELEASE: release, VITE_BUILD_CMD: holdBuild }));
    await waitForFile(started);
    const second = collect(launch({ TEST_CMD_AT: cmdAt, VITE_BUILD_CMD: `touch "$TEST_CMD_AT"; ${fakeVite(0)}` }));
    await sleep(1500);
    const releasedAt = Date.now();
    writeFileSync(release, '');
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(distIndex()).toBe('NEW-BUNDLE');
    const stamp = mtime(stampPath());
    // Kernel timestamps are coarse (a few ms) and can trail Date.now() slightly.
    expect(stamp).toBeGreaterThanOrEqual(releasedAt - 100);
    expect(stamp).toBeLessThanOrEqual(mtime(cmdAt));
    expect(marksLeft()).toEqual([]);
  }, 20_000);

  it('a retain-regime build stamps dist/ in place', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();
    const io = collect(
      launch({
        PAPERCUSP_RETAIN_DIST_CHUNKS: '1',
        VITE_BUILD_CMD: 'echo NEW-IN-PLACE > "$VITE_BUILD_OUT_ROOT/dist/index.html"; exit 0',
      }),
    );
    expect(await io.exited).toBe(0);
    expect(distIndex()).toBe('NEW-IN-PLACE');
    expect(existsSync(stampPath())).toBe(true);
    expect(mtime(stampPath())).toBeLessThanOrEqual(mtime(join(tmp, 'dist', 'index.html')));
    expect(marksLeft()).toEqual([]);
  }, 10_000);

  it('a failed build or a build that produced no bundle leaves the previous stamp exactly as it was', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'vbsf-'));
    seedWorkingBundle();
    const oldSec = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(stampPath(), '');
    utimesSync(stampPath(), oldSec, oldSec);
    utimesSync(join(tmp, 'dist', 'index.html'), oldSec, oldSec);
    const cases: Record<string, string>[] = [
      { VITE_BUILD_CMD: fakeVite(1) }, // staged, fails after writing a bundle
      { VITE_BUILD_CMD: 'true' }, // staged, exits 0 with no bundle
      { PAPERCUSP_RETAIN_DIST_CHUNKS: '1', VITE_BUILD_CMD: 'exit 3' }, // in place, fails
      { PAPERCUSP_RETAIN_DIST_CHUNKS: '1', VITE_BUILD_CMD: 'true' }, // in place, no bundle
    ];
    for (const env of cases) {
      await collect(launch(env)).exited;
      expect(Math.round(mtime(stampPath()))).toBe(oldSec * 1000);
    }
    expect(distIndex()).toBe('OLD-WORKING-BUNDLE');
    expect(marksLeft()).toEqual([]);
  }, 30_000);
});
