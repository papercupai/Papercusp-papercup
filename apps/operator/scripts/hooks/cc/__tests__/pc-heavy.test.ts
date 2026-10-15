/**
 * scripts/pc-heavy.sh — the flock COUNTING-semaphore wrapper for heavy
 * build/test commands (WI-3821). Companion to the heavy-command admission gate
 * in pretooluse-bash-resource-gate.sh; this suite proves the wrapper's
 * invariants: it caps concurrency at PC_HEAVY_SLOTS, frees a slot the instant a
 * holder dies (kernel flock, crash-safe), exports PC_HEAVY_BYPASS=1 into the
 * child so the admission gate doesn't also deny it, and short-circuits when the
 * caller already bypassed.
 *
 * ionice is disabled in-suite (PC_HEAVY_IONICE='') so an ionice-permission
 * quirk on CI can't flake the timing; `nice` (always allowed for a positive
 * increment) still exercises the runner path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, execSync, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// NEVER hand-roll an "unwritable path" here: a made-up '/proc/…' hangs Node's
// recursive mkdir forever (EI-19369372064589484). This fixture fails ENOTDIR in 0ms.
import { unwritablePath } from '@papercusp/operator-core/lib/testing/unwritable-path';
// Boundary-safe stderr capture (WI-6728) — child-output-guard.test.ts ratchets
// the raw `acc += String(chunk)` idiom to zero new sites.
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

// __tests__ → cc → hooks → scripts → operator → apps → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
// PROBE_SCRIPT points the WHOLE suite — the spawn paths AND the source-text greps below — at a
// mutated COPY outside the tree, so scripts/mutation-probe.sh can prove these guards are
// falsifiable without ever mutating the shared working tree (git-sync commits the whole tree on a
// short cadence, so an in-tree mutation can be committed mid-probe even when nothing goes wrong).
//
// ⚠ Every reference to the subject MUST go through this constant. A suite that honours the
// override on only some paths runs happily, reports "MUTANT SURVIVED", and was measuring the real
// file the whole time — reading as evidence that a perfectly good guard is weak (caught that way
// in bghost-watchdog.test.ts, 2026-08-10).
const PC_HEAVY = process.env.PROBE_SCRIPT || join(ROOT, 'scripts', 'pc-heavy.sh');

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pcheavy-')); });
// A preemptible monitor survives the outer wrapper long enough to reap its
// isolated child group. The test's `finally` sends the teardown signal, but a
// synchronous rm immediately afterwards can race that last cleanup and report
// ENOTEMPTY when the monitor recreates one of its pid/lock artifacts. Keep the
// guard bounded: transient teardown gets a chance to settle; a genuine leak
// still fails the suite instead of being hidden by an unbounded sleep.
async function removeFixtureDirEventually(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOTEMPTY' || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
afterEach(async () => removeFixtureDirEventually(dir));

// Returns ProcessEnv, not Record<string, string>: every `spawn(..., { env: baseEnv(...) })`
// site in this file failed overload resolution under the narrower type (TS2769, then TS2339
// "Property 'on' does not exist on type 'never'" on the resulting child) — 6+ errors that
// vitest never saw, because vitest does not typecheck.
const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  PC_HEAVY_DIR: dir,
  PC_HEAVY_IONICE: '', // skip ionice in tests (nice still applies)
  // Point the release-gate reserve (EI-19315056231449472) at an empty per-test
  // dir. Without this the suite reads the REAL ~/.papercusp/checkpoint-logs, so
  // every slot-count assertion below would silently depend on whether this box
  // happens to be running a green-checkpoint at the time — passing at 03:00 and
  // failing mid-gate. Same hermeticity reasoning as `cwd: dir` for the git probe.
  // Tests that WANT the clamp plant a lock dir under here explicitly.
  PAPERCUSP_CHECKPOINT_LOG_DIR: join(dir, 'checkpoint-logs'),
  // Neutralise the MEMORY clamp (EI-20336929607862174) for the same hermeticity
  // reason as the gate-reserve dir above: it reads the REAL /proc/meminfo, so
  // without this every slot-count assertion in this file silently depends on how
  // much memory this box happens to have free — `slots=12` on an idle machine
  // and `slots=8` while a couple of agents are typechecking. That is not a
  // theoretical flake: adding the clamp turned 7 existing tests red exactly this
  // way. A value far above any real budget keeps the clamp non-binding; the
  // memory-clamp tests below override it explicitly to exercise it.
  PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '4096',
  PC_HEAVY_MEM_PSI_OVERRIDE: '0',
  // Neutralise the PSI SCARCITY FLOOR for the same reason, and note that the two
  // settings above are what make it necessary: the floor asks "is memory ACTUALLY
  // scarce", and it answers that from PC_HEAVY_MEMAVAIL_GIB_OVERRIDE when one is
  // supplied — so the deliberately-enormous 4096 above (chosen to keep the SLOT
  // clamp non-binding) also reads as "vastly ample", and every freeze/thaw
  // scenario below would find the freeze declined and time out waiting for a
  // state=frozen that can never arrive. The freeze cases here exercise the freeze
  // MECHANISM (election, accounting, thaw, stdout isolation), not the scarcity
  // DECISION; that decision has its own dedicated suite
  // (pc-heavy-psi-scarcity-gate.test.ts), which is where an ample-memory host
  // declining to freeze is asserted rather than neutralised.
  PC_HEAVY_MEM_PSI_MIN_AVAIL_GIB: '0',
  // Neutralise the caller-cgroup typecheck guard (EI-21206772578500745). The
  // suite itself may run inside a finite CI/agent cgroup; every unrelated test
  // must see a deterministic unlimited envelope. The focused guard cases below
  // inject the finite max/current pair explicitly.
  PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
  PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '0',
  ...extra,
});

/**
 * Wait for an OBSERVABLE STATE instead of guessing a wall-clock duration.
 *
 * Every `await sleep(500) // let it grab the slot` in a concurrency suite is a bet that 500ms is
 * simultaneously ENOUGH (or the test flakes) and NOT MUCH MORE than needed (or the suite is slow).
 * On this box both halves are wrong at once: a fixed wait sized on an idle machine is too short
 * under 40 concurrent agents, and pure overhead the rest of the time. Polling the real state is
 * strictly better on both axes — it returns in ~10ms when the box is idle and still waits as long
 * as genuinely needed when it is loaded.
 *
 * The timeout is a FAILURE, never a silent fall-through: a state that never arrives must fail the
 * test loudly rather than let the assertion below run against a world that never got set up.
 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `waitFor(${JSON.stringify(label)}) timed out after ${timeoutMs}ms — the state never arrived. ` +
          'This is a real failure, not a slow box: the assertions after it would have run against ' +
          'an unprepared world.',
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Wait for a LANDMARK IN A LIVE CHILD'S STDERR — the async twin of `waitFor`.
 *
 * The concurrency tests here need a holder to occupy a slot "long enough" for a waiter to
 * genuinely queue. Sizing that with the holder's own `sleep N` makes N a bet on BOTH sides:
 * too short and the holder expires before the waiter enqueues (the test silently degrades
 * into the uncontended path it exists to distinguish from); long enough to be safe and every
 * run pays N seconds in full, because the waiter cannot proceed until the holder finishes.
 * Anchoring on the script's OWN stderr landmarks removes the bet: the holder sleeps far
 * longer than needed and is KILLED the instant the landmark proves the waiter really queued.
 *
 * `seen` is created by the caller so it can assert on the same buffer afterwards; create it
 * IMMEDIATELY after `spawn` and before calling this, because Node fires 'data' handlers in
 * registration order and the check below reads what the collector already decoded.
 * `peek()`, never `text()`, in the per-chunk check (WI-6728): text() flushes the decoder's
 * pending partial character and resets it, so polling it per chunk re-creates the multi-byte
 * corruption the collector exists to prevent. text() is correct in the terminal paths below.
 *
 * Exiting WITHOUT the landmark is a loud failure, never a silent fall-through — the
 * assertions after it would otherwise run against a world that never got set up.
 */
async function untilStderr(
  p: ReturnType<typeof spawn>,
  seen: ReturnType<typeof createTextCollector>,
  ready: (stderr: string) => boolean,
  label: string,
  ms = 30_000,
): Promise<void> {
  if (ready(seen.peek())) return;
  await new Promise<void>((res, rej) => {
    const finish = (err?: Error) => {
      clearTimeout(timer);
      p.stderr?.off('data', onData);
      p.off('close', onClose);
      if (err) rej(err); else res();
    };
    const timer = setTimeout(
      () => finish(new Error(`untilStderr(${JSON.stringify(label)}) timed out after ${ms}ms; stderr so far: ${seen.text()}`)),
      ms,
    );
    const onData = () => { if (ready(seen.peek())) finish(); };
    const onClose = () => {
      if (ready(seen.peek())) finish();
      else finish(new Error(`untilStderr(${JSON.stringify(label)}): the process exited first; stderr: ${seen.text()}`));
    };
    p.stderr?.on('data', onData);
    p.on('close', onClose);
  });
}

/**
 * Marker files in the ready dir that the CHILD actually PUBLISHED — as distinct from the
 * ones pc-heavy merely ALLOCATED.
 *
 * pc-heavy reserves each marker path with `mktemp "$readyDir/<prefix>XXXXXX"` and then
 * immediately `rm -f`s it, because it wants the atomically-unique NAME, not the file
 * (pc-heavy.sh, the `_preempt_after_ready` setup). `mktemp` CREATES the file to reserve it,
 * so a ZERO-BYTE `ready.*` and a zero-byte `finalization.*` each exist in the ready dir for
 * a couple of milliseconds during setup — before the child has published anything at all.
 *
 * A predicate that merely globs the prefix cannot tell that allocation probe from the real
 * marker, and a poll landing inside the window reports "the child finalized" when it has
 * not. Size is an EXACT discriminator rather than a heuristic: the published marker is
 * `${pid}\n`, written by `publishPreemptMarker` in scripts/test-files.mjs, so it is always
 * non-empty; the allocation probe is always 0 bytes.
 *
 * MEASURED, not inferred (EI-21814172909778521, 2026-08-29): against a child that never
 * publishes a marker at all, a tight poller observed the transient in 10/10 runs —
 * `ready.*` at +52ms and `finalization.*` at +57ms, each present for ~2ms. The real suite
 * polls every 10ms, so it lands inside that window intermittently, and MORE OFTEN under
 * load, because the box can deschedule bash between the `mktemp` and the `rm -f`.
 *
 * Believing the probe is what actually reddened this file: the test raised PSI before the
 * run was protected, so pc-heavy CORRECTLY froze an unprotected run, its freeze lease
 * expired, and the harness reported `PC_HEAVY_RESULT status=undetermined` — which the suite
 * then rendered as a test FAILURE. That looked like host coupling ("it reds while alone,
 * worse under load") and was really a readiness predicate matching the wrong file.
 */
function publishedMarkers(readyDir: string, prefix: string): string[] {
  if (!existsSync(readyDir)) return [];
  return readdirSync(readyDir).filter((name) => {
    if (!name.startsWith(prefix)) return false;
    try {
      return statSync(join(readyDir, name)).size > 0;
    } catch {
      // Vanished between readdir and stat — that is the allocation probe being removed,
      // which is exactly the thing this helper must not report as published.
      return false;
    }
  });
}

/**
 * pc-heavy distinguishes "could not measure" from "measured and failed": when its bounded
 * high-PSI freeze lease expires it reaps the group and emits an explicit
 * `PC_HEAVY_RESULT status=undetermined reason=memory-psi-high-timeout exit=75`.
 *
 * An UNDETERMINED result must EXIT as undetermined and never as a red — a guard that fails
 * toward "there is a problem" costs the most time of any failure direction, and three
 * independent sightings of that class landed on one day (ship-main-greening-plans D-014).
 *
 * ⚠ This marker is NOT on its own grounds to skip. The `bounds a stalled finalization
 * handoff` case below asserts this exact line as its EXPECTED terminal outcome, so a
 * blanket "undetermined ⇒ skip" would silently stop exercising it — treating undetermined
 * as a pass, which blinds the guard just as badly in the other direction. Each call site
 * must pair this with positive evidence that the behaviour under test was reached.
 */
const HOST_PRESSURE_UNDETERMINED = /PC_HEAVY_RESULT status=undetermined reason=memory-psi-high-timeout/;

/** TERM a detached child's whole process GROUP so pc-heavy can reap its isolated runner. */
const killGroup = (p: ReturnType<typeof spawn>) => {
  try { process.kill(-(p.pid as number), 'SIGTERM'); } catch { /* already gone */ }
};

/**
 * Return the size of pc-heavy's first admitted cohort without using elapsed
 * time as a concurrency proxy. Every admitted child waits behind one shared
 * release barrier; every non-admitted wrapper therefore reaches pc-heavy's
 * observable queue marker while all available slots remain held. Once every
 * wrapper is either ready or queued, the ready-file count is the actual cap.
 *
 * This is deliberately shared by every slot-count assertion in this file. The
 * old probes inferred concurrency from overlapping fixed 400ms sleeps. A loaded
 * host could delay a later wrapper by >400ms, let an early child finish, and
 * undercount a healthy semaphore. Making the sleep longer only moves that race.
 */
async function admittedCohortSize(jobs: number, env: Record<string, string>): Promise<number> {
  const cohortDir = mkdtempSync(join(dir, 'admitted-cohort-'));
  const release = join(cohortDir, 'release');
  const children: Array<{
    child: ReturnType<typeof spawn>;
    ready: string;
    stderr: ReturnType<typeof createTextCollector>;
    exited: Promise<number>;
  }> = [];

  try {
    for (let i = 0; i < jobs; i += 1) {
      const ready = join(cohortDir, `ready.${i}`);
      const child = spawn(
        'bash',
        [PC_HEAVY, 'bash', '-c', `touch "${ready}"; while [ ! -f "${release}" ]; do sleep 0.02; done`],
        {
          env: baseEnv({
            PC_HEAVY_COALESCE: '0',
            PC_HEAVY_GATE_RESERVE: '0',
            ...env,
          }),
          cwd: dir,
          detached: true,
        },
      );
      children.push({
        child,
        ready,
        stderr: createTextCollector(child.stderr),
        exited: new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1))),
      });
    }

    await waitFor('every concurrency probe being admitted or observably queued', () =>
      children.every(({ child, ready, stderr }) => {
        if (existsSync(ready)) return true;
        if (stderr.peek().includes('[pc-heavy] queued for a heavy slot')) return true;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `concurrency probe exited ${child.exitCode ?? child.signalCode} before admission or queueing`,
          );
        }
        return false;
      }));
    const admitted = children.filter(({ ready }) => existsSync(ready)).length;
    writeFileSync(release, 'go\n');
    const exitCodes = await Promise.all(children.map(({ exited }) => exited));
    expect(exitCodes).toEqual(Array(jobs).fill(0));
    return admitted;
  } finally {
    writeFileSync(release, 'go\n');
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) killGroup(child);
    }
  }
}

/**
 * How many of `slots` slot-files are currently flocked BY SOMEONE ELSE.
 *
 * Probes the same primitive pc-heavy.sh itself uses (`flock -n` on `$PC_HEAVY_DIR/slot.$i`,
 * pc-heavy.sh:774) rather than inferring occupancy from a lockfile's existence — the slot file is
 * created on open and outlives the holder, so presence proves nothing and absence proves nothing.
 * A failed non-blocking acquire is the only honest evidence that a slot is held.
 */
function heldSlotCount(slotsDir: string, slots: number): number {
  let held = 0;
  for (let i = 0; i < slots; i += 1) {
    const probe = spawnSync('flock', ['-n', join(slotsDir, `slot.${i}`), 'true'], { stdio: 'ignore' });
    if (probe.status !== 0) held += 1;
  }
  return held;
}

function runSync(args: string[], env: Record<string, string> = {}, cwd?: string) {
  // cwd: dir — a fresh, non-git tmpdir per test, so the tree-state token's
  // Git probe naturally no-ops unless a test deliberately `git init`s it.
  // Non-Git identity tests use a subdirectory: the fallback must not hash
  // pc-heavy's own cache sidecars when PC_HEAVY_DIR is the fixture root.
  //
  // A test that `git init`s MUST pass an explicit `cwd` pointing at a SUBDIR of
  // `dir` rather than initing `dir` itself (EI-19424611266793426). The cache lives
  // at PC_HEAVY_DIR (= `dir` in this suite), so initing `dir` puts pc-heavy's OWN
  // coalesce/slot artifacts inside the worktree it is probing — every run then
  // writes untracked files that bust the next run's token, and coalescing can
  // never happen. That is a pure fixture artifact: the real default is
  // ${XDG_RUNTIME_DIR:-/tmp}/pc-heavy-slots, always outside the repo. Keeping the
  // worktree one level down keeps the probe measuring the TEST's edits only.
  return spawnSync('bash', [PC_HEAVY, ...args], {
    encoding: 'utf8',
    env: baseEnv(env),
    cwd: cwd ?? dir,
    timeout: 30_000,
  });
}

describe('pc-heavy.sh — flock counting semaphore (WI-3821)', () => {
  it('exports PC_HEAVY_BYPASS=1 into the child', () => {
    const r = runSync(['bash', '-c', 'printf %s "$PC_HEAVY_BYPASS"'], { PC_HEAVY_SLOTS: '2' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('1');
  });

  it('short-circuits (exec) when the caller already set PC_HEAVY_BYPASS=1 — no slot dir touched', () => {
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'echo ok'], {
      encoding: 'utf8',
      // an unwritable slot dir proves the bypass path never tries to lock
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_BYPASS: '1', PC_HEAVY_DIR: unwritablePath('slots') },
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
  });

  // WI-6140: green-checkpoint's greenCmd IS `npm run test:affected`, which now routes
  // through this wrapper. The release gate must never QUEUE behind ad-hoc agent sweeps —
  // it races a 60-min wall-clock reaper measured from workflow CREATION, so a slot wait
  // (up to PC_HEAVY_TIMEOUT_SEC=900s) comes straight off that budget and resurfaces as a
  // "stale routine" reap that reads as an infra flake.
  it('exempts the release gate (PC_HEAVY_RELEASE_GATE=1) from the semaphore entirely', () => {
    // A slot dir path that does NOT exist yet but IS creatable: a non-exempt run would
    // mkdir it and take a slot, so "never created" proves we exec'd before the slot
    // machinery — and distinguishes this from the fail-open path below, which only
    // triggers when the dir CANNOT be made.
    const slots = join(dir, 'never-created');
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'printf %s "$PC_HEAVY_BYPASS"'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_DIR: slots, PC_HEAVY_RELEASE_GATE: '1' },
      cwd: dir,
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    // still marked bypassed, so nested heavy children don't re-queue either
    expect(r.stdout).toBe('1');
    expect(existsSync(slots)).toBe(false);
  });

  // WI-6140 hole (caught in review by su-055aef7f): GREEN_CHECKPOINT is DOUBLE-DUTY — it
  // also drives describe.skipIf in load-/network-sensitive tests, so agents legitimately
  // export it by hand to reproduce the gate's skip-set. If it ALSO granted admission,
  // `GREEN_CHECKPOINT=1 npm run test:affected` would bypass the semaphore at nice 0 and
  // re-open the unadmitted-sweep hole this wrapper exists to close. Keep the two keys
  // separate; this test fails if anyone merges them back.
  it('does NOT exempt on the double-duty GREEN_CHECKPOINT marker — only the dedicated key', () => {
    const slots = join(dir, 'made-despite-green-checkpoint');
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'echo ok'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        PC_HEAVY_DIR: slots,
        PC_HEAVY_IONICE: '',
        PC_HEAVY_SLOTS: '2',
        GREEN_CHECKPOINT: '1', // the skip-marker alone must NOT buy admission
      },
      cwd: dir,
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    // it went through the slot machinery like any other sweep
    expect(existsSync(slots)).toBe(true);
  });

  it('exclusive materialization drains a pre-existing holder and blocks new heavy work until its child exits', async () => {
    const env = { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE: '0', PC_HEAVY_TIMEOUT_SEC: '10' };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let barrier: ReturnType<typeof spawn> | undefined;
    let waiter: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the pre-existing heavy holder');

      const barrierStarted = join(dir, 'barrier-started');
      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `echo started > "${barrierStarted}"; sleep 30`],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      await untilStderr(
        barrier,
        barrierErr,
        (t) => t.includes('exclusive materialization barrier waiting'),
        'the materialization barrier beginning its drain',
      );
      expect(existsSync(barrierStarted)).toBe(false);

      killGroup(holder);
      await untilStderr(
        barrier,
        barrierErr,
        (t) => t.includes('exclusive materialization barrier acquired'),
        'the materialization barrier acquiring every slot',
      );
      await waitFor('the barrier child starting', () => existsSync(barrierStarted));
      expect(heldSlotCount(dir, 2)).toBe(2);

      const waiterRan = join(dir, 'waiter-ran');
      waiter = spawn('bash', [PC_HEAVY, 'bash', '-c', `echo ran > "${waiterRan}"`], {
        env: baseEnv(env), cwd: dir,
      });
      const waiterErr = createTextCollector(waiter.stderr);
      const waiterExit = new Promise<number>((res) => waiter?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(waiter, waiterErr, (t) => t.includes('queued for a heavy slot'), 'new heavy work queueing');
      expect(existsSync(waiterRan)).toBe(false);

      killGroup(barrier);
      expect(await waiterExit).toBe(0);
      expect(readFileSync(waiterRan, 'utf8').trim()).toBe('ran');
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
      if (waiter) killGroup(waiter);
    }
  });

  // EI-21322804786723906 — the drain refusal used to report only a COUNT
  // ("only 1/2 heavy slots drained"). A count cannot distinguish a LIVE holder
  // from an orphaned one, and that gap is not theoretical: this very incident
  // was first filed as a stale writer lock and had to be retracted after a
  // hand-run kernel-lock/process-tree walk found a live materializer still making
  // progress. Several sessions then repeated that same manual archaeology. The
  // refusal must name the undrained slot AND the pid still holding it, so the
  // "stale or live?" question is answered by the log instead of by hand.
  it('names the undrained slot and its live holder pid when the drain times out', async () => {
    const env = { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE: '0', PC_HEAVY_TIMEOUT_SEC: '4' };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '60'], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the pre-existing heavy holder');

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'echo should-not-run'],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((res) => barrier?.on('exit', (c) => res(c ?? -1)));

      // The holder is never released, so the drain must reach its deadline.
      expect(await barrierExit).toBe(75);

      const err = barrierErr.text();
      expect(err).toContain('REFUSED materialization');
      // WHICH slot never drained — not just how many.
      expect(err).toMatch(/undrained slot\.\d+ held by:/);
      // WHO still holds it. This is the assertion that makes "stale vs live"
      // answerable from the log, and the one a count-only refusal cannot pass.
      expect(err).toContain(`pid ${holder.pid}`);
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
    }
  // The child refusal budget is 4s, but holder diagnostics and process teardown
  // can be delayed by the shared host's scheduler. Keep this bounded while
  // leaving enough room for the assertion to observe the live-holder evidence.
  }, 20_000);

  it('does not label an unverified owner-sidecar pid as a lock holder', async () => {
    const env = { PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE: '0', PC_HEAVY_TIMEOUT_SEC: '3', PC_HEAVY_HEARTBEAT_SEC: '1' };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '60'], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the pre-existing heavy holder');
      // Sidecars are diagnostic hints, never ownership evidence. Model a torn
      // write, stale pid, or pid reuse by replacing the real candidate with a
      // process that cannot possibly expose the matching locked fd.
      writeFileSync(join(dir, 'slot.0.owner'), '987654321\n');

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'echo should-not-run'],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((res) => barrier?.on('exit', (c) => res(c ?? -1)));

      expect(await barrierExit).toBe(75);
      const err = barrierErr.text();
      expect(err).not.toContain('pid 987654321');
      expect(err).toContain('holder could not be identified');
      expect(err).not.toContain('/proc/987654321/cmdline');
      expect(err).not.toContain('No such file or directory');
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
    }
  });

  it('uses direct kernel holder metadata without invoking a stalled fuser fallback', async () => {
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '1',
      PC_HEAVY_HEARTBEAT_SEC: '1',
    };
    const fakeBin = join(dir, 'slow-fuser-bin');
    mkdirSync(fakeBin);
    const fuserInvoked = join(dir, 'fuser-invoked');
    // The marker proves the fallback was never invoked. An elapsed-time bound
    // also charges unrelated bash startup to this behavior and can fail even
    // when direct kernel holder lookup succeeds (WI-6554700010008342).
    const FUSER_STALL_SEC = 60;
    writeFileSync(
      join(fakeBin, 'fuser'),
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(fuserInvoked)}\nsleep ${FUSER_STALL_SEC}\n`,
      { mode: 0o755 },
    );

    const holder = spawn('bash', [PC_HEAVY, 'sleep', '60'], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the pre-existing heavy holder');
      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'echo should-not-run'],
        { env: baseEnv({ ...env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` }), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((res) => barrier?.on('exit', (c) => res(c ?? -1)));

      expect(await barrierExit).toBe(75);
      expect(barrierErr.text()).toContain(`pid ${holder.pid}`);
      expect(barrierErr.text()).not.toContain('holder could not be identified');
      expect(existsSync(fuserInvoked)).toBe(false);
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
    }
  }, 45_000);

  it('WI-41318: every ordinary holder yields its whole child group to an exclusive materializer by default', async () => {
    const workloadPidFile = join(dir, 'preemptible-workload.pid');
    const terminatedFile = join(dir, 'preemptible-workload.terminated');
    const barrierRan = join(dir, 'exclusive-barrier-ran');
    const env = {
      PC_HEAVY_SLOTS: '1',
      // Exercise the harder coalescing-leader path: the old late opt-in block
      // sat after this path's early exit and therefore never covered it.
      PC_HEAVY_COALESCE: '1',
      PC_HEAVY_TIMEOUT_SEC: '5',
      PC_HEAVY_HEARTBEAT_SEC: '1',
      PC_HEAVY_PREEMPT_GRACE_SEC: '0',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    };
    const workload = [
      `trap 'echo terminated > ${JSON.stringify(terminatedFile)}; exit 143' TERM`,
      // Publish readiness only after the TERM handler is installed. The hard-kill
      // follows this file immediately; publishing the pid first leaves a real
      // echo→trap race where correct group cleanup can beat the sentinel setup.
      `echo "$$" > ${JSON.stringify(workloadPidFile)}`,
      'while :; do sleep 1; done',
    ].join('; ');
    const holder = spawn('bash', [PC_HEAVY, 'bash', '-c', workload], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const holderExit = new Promise<number>((res) => holder.on('exit', (c) => res(c ?? -1)));
    let barrier: ReturnType<typeof spawn> | undefined;
    let workloadPid = 0;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the preemptible holder taking slot.0');
      await waitFor('the preemptible workload process starting', () => existsSync(workloadPidFile));
      workloadPid = Number(readFileSync(workloadPidFile, 'utf8').trim());

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `echo acquired > ${JSON.stringify(barrierRan)}`],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((res) => barrier?.on('exit', (c) => res(c ?? -1)));

      expect(
        await barrierExit,
        `holder stderr:\n${holderErr.peek()}\nbarrier stderr:\n${barrierErr.peek()}`,
      ).toBe(0);
      expect(await holderExit).toBe(75);
      expect(existsSync(barrierRan)).toBe(true);
      expect(existsSync(terminatedFile)).toBe(true);
      expect(holderErr.text()).toContain('PREEMPTING ordinary holder for exclusive materialization');
      expect(holderErr.text()).toContain('PC_HEAVY_RESULT status=preempted reason=exclusive-materializer');
      expect(holderErr.text()).not.toMatch(
        /^setsid: child \d+ did not exit normally: No such file or directory$/m,
      );
      expect(barrierErr.text()).toContain('exclusive materialization barrier acquired');
      await waitFor('the preempted workload process group being fully reaped', () => {
        try { process.kill(-workloadPid, 0); return false; } catch { return true; }
      });
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
      if (workloadPid > 1) {
        try { process.kill(-workloadPid, 'SIGKILL'); } catch { /* already reaped */ }
      }
    }
  }, 15_000);

  it('retries only an exact exclusive-materializer preemption and leaves unrelated exit 75 untouched', async () => {
    const attemptsFile = join(dir, 'retry-attempts');
    const successFile = join(dir, 'retry-success');
    const barrierRan = join(dir, 'retry-barrier-ran');
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '1',
      PC_HEAVY_RETRY_PREEMPTIONS: '1',
      PC_HEAVY_TIMEOUT_SEC: '8',
      PC_HEAVY_PREEMPT_GRACE_SEC: '0',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    };
    const workload = [
      `attempt=$(cat ${JSON.stringify(attemptsFile)} 2>/dev/null || printf '0')`,
      'attempt=$((attempt + 1))',
      `printf '%s\\n' "$attempt" > ${JSON.stringify(attemptsFile)}`,
      `if [ "$attempt" -gt 1 ]; then printf success > ${JSON.stringify(successFile)}; exit 0; fi`,
      'while :; do sleep 1; done',
    ].join('; ');
    const retrying = spawn('bash', [PC_HEAVY, 'bash', '-c', workload], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const retryingErr = createTextCollector(retrying.stderr);
    const retryingExit = new Promise<number>((resolve) => retrying.on('exit', (code) => resolve(code ?? -1)));
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await waitFor('the first retry attempt starting', () => existsSync(attemptsFile));
      expect(readFileSync(attemptsFile, 'utf8').trim()).toBe('1');

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `printf acquired > ${JSON.stringify(barrierRan)}`],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((resolve) => barrier?.on('exit', (code) => resolve(code ?? -1)));

      expect(
        await barrierExit,
        `retry stderr:\n${retryingErr.text()}\nbarrier stderr:\n${barrierErr.text()}`,
      ).toBe(0);
      expect(await retryingExit, `retry stderr:\n${retryingErr.text()}`).toBe(0);
      expect(readFileSync(attemptsFile, 'utf8').trim()).toBe('2');
      expect(readFileSync(successFile, 'utf8')).toBe('success');
      expect(readFileSync(barrierRan, 'utf8')).toBe('acquired');
      expect(retryingErr.text()).toContain('PC_HEAVY_RESULT status=preempted reason=exclusive-materializer');
      expect(retryingErr.text()).toContain('retrying after exclusive-materializer preemption (retry 1/1)');
      expect(retryingErr.text()).not.toContain('coalesced:');
    } finally {
      killGroup(retrying);
      if (barrier) killGroup(barrier);
    }

    const unrelated75 = runSync(
      ['bash', '-c', `printf 'ran\\n' >> ${JSON.stringify(join(dir, 'unrelated-75-runs'))}; exit 75`],
      {
        PC_HEAVY_RETRY_PREEMPTIONS: '2',
        PC_HEAVY_PREEMPTIBLE: '0',
      },
    );
    expect(unrelated75.status).toBe(75);
    expect(readFileSync(join(dir, 'unrelated-75-runs'), 'utf8')).toBe('ran\n');
    expect(unrelated75.stderr).not.toContain('retrying after exclusive-materializer preemption');
  }, 15_000);

  it('waits for a still-pending exclusive materializer before starting its retry', async () => {
    const attemptsFile = join(dir, 'pending-retry-attempts');
    const successFile = join(dir, 'pending-retry-success');
    const barrierRan = join(dir, 'pending-retry-barrier-ran');
    const writerPath = join(dir, 'exclusive-materialization.lock');
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_RETRY_PREEMPTIONS: '1',
      // Give-up timers far above the loaded sequence: the test releases the writer blocker
      // itself, so nothing here needs to expire (8s was beaten under gate load, WI-6554700010008342).
      PC_HEAVY_RETRY_INTENT_WAIT_SEC: '60',
      PC_HEAVY_TIMEOUT_SEC: '60',
      PC_HEAVY_PREEMPT_GRACE_SEC: '0',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
      PC_HEAVY_HEARTBEAT_SEC: '1',
    };
    // Keep the external writer until this test releases it. A timed sleeper can
    // expire while the full suite is scheduling other tests, before the retry's
    // holder diagnostic runs.
    const writerBlocker = spawn('flock', [writerPath, 'cat'], {
      env: baseEnv(env), cwd: dir, detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const retryWorkload = [
      `attempt=$(cat ${JSON.stringify(attemptsFile)} 2>/dev/null || printf '0')`,
      'attempt=$((attempt + 1))',
      `printf '%s\\n' "$attempt" > ${JSON.stringify(attemptsFile)}`,
      `if [ "$attempt" -gt 1 ]; then printf success > ${JSON.stringify(successFile)}; exit 0; fi`,
      'while :; do sleep 1; done',
    ].join('; ');
    let retrying: ReturnType<typeof spawn> | undefined;
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await waitFor('the writer blocker acquiring the materializer writer lock', () =>
        spawnSync('flock', ['-n', writerPath, 'true'], { stdio: 'ignore' }).status !== 0,
      );

      retrying = spawn('bash', [PC_HEAVY, 'bash', '-c', retryWorkload], {
        env: baseEnv(env), cwd: dir, detached: true,
      });
      const retryingErr = createTextCollector(retrying.stderr);
      const retryingExit = new Promise<number>((resolve) => retrying?.on('exit', (code) => resolve(code ?? -1)));
      await waitFor('the first pending retry attempt starting', () => existsSync(attemptsFile));
      expect(readFileSync(attemptsFile, 'utf8').trim()).toBe('1');

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `printf acquired > ${JSON.stringify(barrierRan)}`],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((resolve) => barrier?.on('exit', (code) => resolve(code ?? -1)));
      await untilStderr(
        barrier,
        barrierErr,
        (t) => t.includes('another exclusive materializer owns the writer lock — waiting before touching heavy slots'),
        'the materializer remaining pending on the writer lock',
        20_000,
      );
      await untilStderr(
        retrying,
        retryingErr,
        (t) => t.includes('retry waiting for exclusive materializer intent to clear'),
        'the retry waiting for the materializer intent',
        20_000,
      );
      await untilStderr(
        retrying,
        retryingErr,
        (t) => t.includes('retry still waiting for exclusive materializer intent'),
        'the retry emitting a progress heartbeat while the materializer remains pending',
        20_000,
      );
      // The regression is about re-admission ordering: while the materializer is
      // still intent-pending, no second workload attempt may have started. The
      // heartbeat proves that a minutes-long production wait remains visibly
      // alive without weakening that ordering barrier.
      expect(readFileSync(attemptsFile, 'utf8').trim()).toBe('1');
      expect(writerBlocker.exitCode).toBeNull();
      expect(spawnSync('flock', ['-n', writerPath, 'true'], { stdio: 'ignore' }).status).not.toBe(0);
      expect(retryingErr.text()).toContain('retry materializer progress: elapsed=');
      expect(retryingErr.text()).toContain('retry materializer intent owner:');
      expect(retryingErr.text()).toContain('retry materializer writer lock holder:');
      expect(retryingErr.text()).toContain(`pid ${writerBlocker.pid}`);
      expect(retryingErr.text()).not.toContain(`pid ${barrier.pid}`);

      killGroup(writerBlocker);
      expect(
        await barrierExit,
        `retry stderr:\n${retryingErr.text()}\nbarrier stderr:\n${barrierErr.text()}`,
      ).toBe(0);
      expect(await retryingExit, `retry stderr:\n${retryingErr.text()}`).toBe(0);
      expect(readFileSync(attemptsFile, 'utf8').trim()).toBe('2');
      expect(readFileSync(successFile, 'utf8')).toBe('success');
      expect(readFileSync(barrierRan, 'utf8')).toBe('acquired');
      expect(retryingErr.text()).toContain('PC_HEAVY_RESULT status=preempted reason=exclusive-materializer');
      expect(retryingErr.text()).toContain('exclusive materializer intent cleared; starting retry');
    } finally {
      if (retrying) killGroup(retrying);
      if (barrier) killGroup(barrier);
      killGroup(writerBlocker);
    }
  }, 90_000);

  it('keeps an opt-in run preemptible until it publishes the after-ready marker', async () => {
    const readyDir = join(dir, 'after-ready-before');
    const started = join(dir, 'after-ready-before-started');
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '8',
      PC_HEAVY_PREEMPT_AFTER_READY: '1',
      PC_HEAVY_PREEMPT_READY_DIR: readyDir,
      PC_HEAVY_PREEMPT_GRACE_SEC: '0',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    };
    const holder = spawn('bash', [PC_HEAVY, 'bash', '-c', [
      `echo started > ${JSON.stringify(started)}`,
      'while :; do sleep 1; done',
    ].join('; ')], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const holderExit = new Promise<number>((res) => holder.on('exit', (c) => res(c ?? -1)));
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the before-ready holder taking a slot');
      await waitFor('the before-ready workload starting', () => existsSync(started));
      expect(existsSync(readyDir)).toBe(true);
      // The wrapper allocates an absent path up front, but the child must publish
      // it only after its irreversible derivation. This run intentionally never
      // publishes, so the exclusive materializer must still be allowed to win.
      expect(readdirSync(readyDir)).toEqual([]);

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'echo before-ready-barrier-ran'],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((res) => barrier?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(barrier, barrierErr, (t) => t.includes('exclusive materialization barrier waiting'), 'the before-ready barrier waiting');

      const [holderCode, barrierCode] = await Promise.all([holderExit, barrierExit]);
      expect(holderCode, `holder stderr:\n${holderErr.text()}`).toBe(75);
      expect(barrierCode, `barrier stderr:\n${barrierErr.text()}`).toBe(0);
      expect(holderErr.text()).toContain('PREEMPTING ordinary holder for exclusive materialization');
      expect(holderErr.text()).toContain('PC_HEAVY_RESULT status=preempted reason=exclusive-materializer');
      expect(barrierErr.text()).toContain('exclusive materialization barrier acquired');
      expect(readdirSync(readyDir)).toEqual([]);
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
    }
  }, 15_000);

  it('allocates the marker PATH without creating a file, so a PATH where `rm` deletes nothing cannot break the barrier (EI-22197976300039578)', () => {
    // Reproduces `scripts/mutation-probe.sh --fake-destructive`, the tier-0 safe
    // mode this repo tells agents to prefer: it prepends shims for rm/rmdir/
    // unlink/shred/truncate/mkfs/dd that log their argv and `exit 0` while
    // deleting NOTHING.
    //
    // The allocation used to be mktemp-then-`rm -f`, which trusted rm's EXIT
    // CODE as proof of deletion. Under these shims the reservation file
    // survived, so the child's O_CREAT|O_EXCL publish hit EEXIST on a
    // zero-length marker microseconds old — which the shared liveness rule
    // resolves to LIVE, correctly, since it cannot know the incumbent is our
    // own leftover. That surfaced as TEST_FILE_ROUTE_ERROR exit 75 with ZERO
    // tests measured, deterministically on every retry, making the sanctioned
    // safe tier unusable for every pc-heavy-routed subject
    // (EI-22197835728112932) and littering the marker dir for days.
    const readyDir = join(dir, 'after-ready-noop-rm');
    const fakeBin = join(dir, 'fake-bin');
    mkdirSync(fakeBin, { recursive: true });
    for (const tool of ['rm', 'rmdir', 'unlink']) {
      const shim = join(fakeBin, tool);
      writeFileSync(shim, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(shim, 0o755);
    }

    const r = spawnSync(
      'bash',
      [PC_HEAVY, 'bash', '-c', 'printf %s "$PC_HEAVY_PREEMPT_READY_FILE"'],
      {
        env: baseEnv({
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          PC_HEAVY_COALESCE: '0',
          PC_HEAVY_PREEMPT_AFTER_READY: '1',
          PC_HEAVY_PREEMPT_READY_DIR: readyDir,
        }),
        cwd: dir,
        encoding: 'utf8',
      },
    );

    // The barrier must still be OFFERED — degrading to "no barrier" would hide
    // the defect rather than fix it.
    expect(r.status, `stderr:\n${r.stderr}`).toBe(0);
    const allocated = r.stdout.trim();
    expect(allocated).toMatch(/\/ready\.[A-Za-z0-9]{6}$/);

    // The two assertions that fail against the mktemp-then-rm allocation: the
    // reserved path must not exist (nothing for the exclusive publish to
    // collide with), and reservation must leave no debris behind at all.
    expect(existsSync(allocated)).toBe(false);
    expect(readdirSync(readyDir)).toEqual([]);
  });

  it('lets a marked run finish before an exclusive materializer and cleans the marker', async () => {
    const readyDir = join(dir, 'after-ready-after');
    const readyPublished = join(dir, 'after-ready-published');
    const finished = join(dir, 'after-ready-finished');
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '8',
      PC_HEAVY_PREEMPT_AFTER_READY: '1',
      PC_HEAVY_PREEMPT_READY_DIR: readyDir,
      PC_HEAVY_PREEMPT_GRACE_SEC: '0',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    };
    const workload = [
      `test -n "$PC_HEAVY_PREEMPT_READY_FILE"`,
      `printf '%s\\n' "$$" > "$PC_HEAVY_PREEMPT_READY_FILE"`,
      `echo published > ${JSON.stringify(readyPublished)}`,
      'sleep 2',
      `echo finished > ${JSON.stringify(finished)}`,
    ].join('; ');
    const holder = spawn('bash', [PC_HEAVY, 'bash', '-c', workload], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const holderExit = new Promise<number>((res) => holder.on('exit', (c) => res(c ?? -1)));
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the after-ready holder taking a slot');
      await waitFor('the after-ready marker being published', () => {
        if (!existsSync(readyPublished) || !existsSync(readyDir)) return false;
        return readdirSync(readyDir).length === 1;
      });

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'echo after-ready-barrier-ran'],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((res) => barrier?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(barrier, barrierErr, (t) => t.includes('exclusive materialization barrier waiting'), 'the after-ready barrier waiting');

      const [holderCode, barrierCode] = await Promise.all([holderExit, barrierExit]);
      expect(holderCode, `holder stderr:\n${holderErr.text()}`).toBe(0);
      expect(barrierCode, `barrier stderr:\n${barrierErr.text()}`).toBe(0);
      expect(existsSync(finished)).toBe(true);
      expect(holderErr.text()).not.toContain('PREEMPTING ordinary holder for exclusive materialization');
      expect(holderErr.text()).not.toContain('PC_HEAVY_RESULT status=preempted reason=exclusive-materializer');
      expect(barrierErr.text()).toContain('exclusive materialization barrier acquired');
      // The monitor is the last-resort cleanup owner for a TERM/KILL, and also
      // clears a marker a command published itself after the normal exit path.
      expect(readdirSync(readyDir)).toEqual([]);
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
    }
  }, 15_000);

  it('bounds after-ready protection so a marked run cannot starve release materialization', async () => {
    const readyDir = join(dir, 'after-ready-bounded');
    const readyPublished = join(dir, 'after-ready-bounded-published');
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '8',
      PC_HEAVY_PREEMPT_AFTER_READY: '1',
      PC_HEAVY_PREEMPT_READY_MAX_SEC: '1',
      PC_HEAVY_PREEMPT_READY_DIR: readyDir,
      PC_HEAVY_PREEMPT_GRACE_SEC: '0',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    };
    const workload = [
      `test -n "$PC_HEAVY_PREEMPT_READY_FILE"`,
      `printf '%s\\n' "$$" > "$PC_HEAVY_PREEMPT_READY_FILE"`,
      `echo published > ${JSON.stringify(readyPublished)}`,
      'while :; do sleep 1; done',
    ].join('; ');
    const holder = spawn('bash', [PC_HEAVY, 'bash', '-c', workload], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const holderExit = new Promise<number>((res) => holder.on('exit', (c) => res(c ?? -1)));
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the bounded after-ready holder taking a slot');
      await waitFor('the bounded after-ready marker being published', () => {
        if (!existsSync(readyPublished) || !existsSync(readyDir)) return false;
        return readdirSync(readyDir).length === 1;
      });

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'echo bounded-after-ready-barrier-ran'],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((res) => barrier?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(barrier, barrierErr, (t) => t.includes('exclusive materialization barrier waiting'), 'the bounded after-ready barrier waiting');

      const [holderCode, barrierCode] = await Promise.all([holderExit, barrierExit]);
      expect(holderCode, `holder stderr:\n${holderErr.text()}`).toBe(75);
      expect(barrierCode, `barrier stderr:\n${barrierErr.text()}`).toBe(0);
      expect(holderErr.text()).toContain('after-ready protection expired after 1s');
      expect(holderErr.text()).toContain('PC_HEAVY_RESULT status=preempted reason=exclusive-materializer');
      expect(barrierErr.text()).toContain('exclusive materialization barrier acquired');
      expect(readdirSync(readyDir)).toEqual([]);
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
    }
  }, 15_000);

  it('EI-21399496097779784: reaps an after-ready workload when its original caller exits', async () => {
    const readyDir = join(dir, 'caller-exit-ready');
    const readyPublished = join(dir, 'caller-exit-published');
    const wrapperPidFile = join(dir, 'caller-exit-wrapper.pid');
    const workloadPidFile = join(dir, 'caller-exit-workload.pid');
    const terminatedFile = join(dir, 'caller-exit-terminated');
    const holderOut = join(dir, 'caller-exit-holder.out');
    const holderErr = join(dir, 'caller-exit-holder.err');
    const workload = [
      `echo "$$" > "$WORKLOAD_PID_FILE"`,
      `trap 'echo terminated > "$TERMINATED_FILE"; exit 143' TERM`,
      `printf '%s\\n' "$$" > "$PC_HEAVY_PREEMPT_READY_FILE"`,
      `echo published > "$READY_PUBLISHED"`,
      'while :; do sleep 1; done',
    ].join('; ');
    const env = baseEnv({
      PC_HEAVY_SCRIPT: PC_HEAVY,
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_PREEMPT_AFTER_READY: '1',
      PC_HEAVY_PREEMPT_READY_DIR: readyDir,
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      WORKLOAD_SCRIPT: workload,
      WORKLOAD_PID_FILE: workloadPidFile,
      TERMINATED_FILE: terminatedFile,
      READY_PUBLISHED: readyPublished,
      WRAPPER_PID_FILE: wrapperPidFile,
      HOLDER_OUT: holderOut,
      HOLDER_ERR: holderErr,
    });
    // The short-lived shell is the real caller. It waits until the protected
    // marker is published, then exits while leaving pc-heavy itself alive and
    // reparented — exactly the live incident. Redirecting the background
    // wrapper's stdio prevents the caller's Node pipes from keeping it alive.
    const caller = spawn(
      'bash',
      ['-c', [
        'nohup bash "$PC_HEAVY_SCRIPT" bash -c "$WORKLOAD_SCRIPT" >"$HOLDER_OUT" 2>"$HOLDER_ERR" &',
        'echo "$!" > "$WRAPPER_PID_FILE"',
        'while [ ! -e "$READY_PUBLISHED" ]; do sleep 0.02; done',
      ].join('\n')],
      { env, cwd: dir },
    );
    const callerExit = new Promise<number>((resolve) => caller.on('exit', (code) => resolve(code ?? -1)));
    let wrapperPid = 0;
    let workloadPid = 0;
    try {
      expect(await callerExit).toBe(0);
      await waitFor('the orphan fixture publishing wrapper and workload pids', () =>
        existsSync(wrapperPidFile) && existsSync(workloadPidFile),
      );
      wrapperPid = Number(readFileSync(wrapperPidFile, 'utf8').trim());
      workloadPid = Number(readFileSync(workloadPidFile, 'utf8').trim());
      expect(Number.isSafeInteger(wrapperPid) && wrapperPid > 1).toBe(true);
      expect(Number.isSafeInteger(workloadPid) && workloadPid > 1).toBe(true);

      // The ready marker must NOT immunize a job whose owner disappeared.
      await waitFor('the orphaned after-ready workload receiving TERM', () => existsSync(terminatedFile), 5_000);
      await waitFor('the reparented pc-heavy wrapper exiting', () => {
        try { process.kill(wrapperPid, 0); return false; } catch { return true; }
      }, 5_000);
      await waitFor('the orphaned workload process group being fully reaped', () => {
        try { process.kill(-workloadPid, 0); return false; } catch { return true; }
      }, 5_000);

      const err = readFileSync(holderErr, 'utf8');
      expect(err).toContain('original caller exited — reaping its orphaned heavy workload');
      expect(err).toContain("use the harness's run_in_background rather than nohup/&; pc-heavy kills orphans by design");
      expect(err).toContain('PC_HEAVY_RESULT status=undetermined reason=caller-exited exit=143');
      expect(readdirSync(readyDir)).toEqual([]);
      expect(heldSlotCount(dir, 1)).toBe(0);
    } finally {
      try { caller.kill('SIGKILL'); } catch { /* already exited */ }
      if (wrapperPid > 1) {
        try { process.kill(wrapperPid, 'SIGTERM'); } catch { /* already exited */ }
      }
      if (workloadPid > 1) {
        try { process.kill(-workloadPid, 'SIGKILL'); } catch { /* already reaped */ }
      }
    }
  }, 15_000);

  it('EI-21434250273517260: keeps a durable background workload alive when its launch host exits', async () => {
    const readyDir = join(dir, 'durable-caller-ready');
    const readyPublished = join(dir, 'durable-caller-published');
    const wrapperPidFile = join(dir, 'durable-caller-wrapper.pid');
    const workloadPidFile = join(dir, 'durable-caller-workload.pid');
    const terminatedFile = join(dir, 'durable-caller-terminated');
    const finishedFile = join(dir, 'durable-caller-finished');
    const holderOut = join(dir, 'durable-caller-holder.out');
    const holderErr = join(dir, 'durable-caller-holder.err');
    const workload = [
      `echo "$$" > "$WORKLOAD_PID_FILE"`,
      `trap 'echo terminated > "$TERMINATED_FILE"; exit 143' TERM`,
      `printf '%s\n' "$$" > "$PC_HEAVY_PREEMPT_READY_FILE"`,
      `echo published > "$READY_PUBLISHED"`,
      'sleep 1',
      `echo finished > "$FINISHED_FILE"`,
    ].join('; ');
    const env = baseEnv({
      PC_HEAVY_SCRIPT: PC_HEAVY,
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_PREEMPT_AFTER_READY: '1',
      PC_HEAVY_DURABLE_CALLER: '1',
      PC_HEAVY_PREEMPT_READY_DIR: readyDir,
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      WORKLOAD_SCRIPT: workload,
      WORKLOAD_PID_FILE: workloadPidFile,
      TERMINATED_FILE: terminatedFile,
      FINISHED_FILE: finishedFile,
      READY_PUBLISHED: readyPublished,
      WRAPPER_PID_FILE: wrapperPidFile,
      HOLDER_OUT: holderOut,
      HOLDER_ERR: holderErr,
    });
    const caller = spawn(
      'bash',
      ['-c', [
        'nohup bash "$PC_HEAVY_SCRIPT" bash -c "$WORKLOAD_SCRIPT" >"$HOLDER_OUT" 2>"$HOLDER_ERR" &',
        'echo "$!" > "$WRAPPER_PID_FILE"',
        'while [ ! -e "$READY_PUBLISHED" ]; do sleep 0.02; done',
      ].join('\n')],
      { env, cwd: dir },
    );
    const callerExit = new Promise<number>((resolve) => caller.on('exit', (code) => resolve(code ?? -1)));
    let wrapperPid = 0;
    let workloadPid = 0;
    try {
      expect(await callerExit).toBe(0);
      await waitFor('the durable fixture publishing wrapper and workload pids', () =>
        existsSync(wrapperPidFile) && existsSync(workloadPidFile),
      );
      wrapperPid = Number(readFileSync(wrapperPidFile, 'utf8').trim());
      workloadPid = Number(readFileSync(workloadPidFile, 'utf8').trim());
      expect(Number.isSafeInteger(wrapperPid) && wrapperPid > 1).toBe(true);
      expect(Number.isSafeInteger(workloadPid) && workloadPid > 1).toBe(true);

      await waitFor('the durable workload finishing after its launch host exited', () => existsSync(finishedFile), 5_000);
      await waitFor('the durable pc-heavy wrapper exiting normally', () => {
        try { process.kill(wrapperPid, 0); return false; } catch { return true; }
      }, 5_000);

      const err = readFileSync(holderErr, 'utf8');
      expect(existsSync(terminatedFile)).toBe(false);
      expect(err).not.toContain('original caller exited — reaping its orphaned heavy workload');
      expect(err).not.toContain('PC_HEAVY_RESULT status=undetermined reason=caller-exited');
      expect(readdirSync(readyDir)).toEqual([]);
      expect(heldSlotCount(dir, 1)).toBe(0);
    } finally {
      try { caller.kill('SIGKILL'); } catch { /* already exited */ }
      if (wrapperPid > 1) {
        try { process.kill(wrapperPid, 'SIGTERM'); } catch { /* already exited */ }
      }
      if (workloadPid > 1) {
        try { process.kill(-workloadPid, 'SIGKILL'); } catch { /* already reaped */ }
      }
    }
  }, 15_000);

  it('WI-41318: reaps the workload group when a caller hard-kills the outer wrapper', async () => {
    const workloadPidFile = join(dir, 'hard-killed-workload.pid');
    const terminatedFile = join(dir, 'hard-killed-workload.terminated');
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '1',
      PC_HEAVY_TIMEOUT_SEC: '5',
      PC_HEAVY_HEARTBEAT_SEC: '1',
      PC_HEAVY_PREEMPT_GRACE_SEC: '0',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    };
    const workload = [
      `echo "$$" > ${JSON.stringify(workloadPidFile)}`,
      `trap 'echo terminated > ${JSON.stringify(terminatedFile)}; exit 143' TERM`,
      'while :; do sleep 1; done',
    ].join('; ');
    const holder = spawn('bash', [PC_HEAVY, 'bash', '-c', workload], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let workloadPid = 0;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the hard-kill holder taking slot.0');
      await waitFor('the hard-kill workload process starting', () => existsSync(workloadPidFile));
      workloadPid = Number(readFileSync(workloadPidFile, 'utf8').trim());
      expect(Number.isSafeInteger(workloadPid) && workloadPid > 1).toBe(true);

      // Simulate a caller deadline that kills the outer wrapper's entire
      // process group. The monitor must be in a separate session to survive.
      process.kill(-(holder.pid as number), 'SIGKILL');
      await untilStderr(
        holder,
        holderErr,
        (t) => t.includes('outer slot wrapper exited'),
        'the surviving monitor detecting outer-wrapper death',
        5_000,
      );
      await waitFor('the isolated workload receiving TERM from the surviving monitor', () => existsSync(terminatedFile), 5_000);
      await waitFor('the hard-killed workload process group being fully reaped', () => {
        try { process.kill(-workloadPid, 0); return false; } catch { return true; }
      }, 5_000);
    } finally {
      try { process.kill(-(holder.pid as number), 'SIGKILL'); } catch { /* already gone */ }
      if (workloadPid > 1) {
        try { process.kill(-workloadPid, 'SIGKILL'); } catch { /* already reaped */ }
      }
    }
  }, 15_000);

  it('a default-preemptible holder with no materializer preserves the child exit status', () => {
    const r = runSync(['bash', '-c', 'exit 23'], {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    });
    expect(r.status).toBe(23);
    expect(r.stderr).not.toContain('PREEMPTING');
  });

  it('emits an undetermined marker when the outer supervisor fails before the monitor starts', () => {
    const fakeBin = join(dir, 'outer-start-fails');
    mkdirSync(fakeBin);
    // Model setsid returning EAGAIN before it can launch the internal monitor.
    writeFileSync(join(fakeBin, 'setsid'), '#!/bin/sh\nexit 11\n', { mode: 0o755 });

    const r = runSync(['bash', '-c', 'exit 0'], {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_PREEMPTIBLE: '1',
    });

    expect(r.status).toBe(11);
    expect(r.stderr).toContain(
      'PC_HEAVY_RESULT status=undetermined reason=outer-child-start-failed exit=11',
    );
  });

  // EI-21357082020097858 — every abort before the workload can produce a
  // verdict must leave the same machine-readable undetermined marker as the
  // already-covered outer-wrapper abort. These tests call the internal monitor
  // directly so each otherwise rare startup branch can be forced deterministically.
  it('emits an undetermined marker when the child-start supervisor fails', () => {
    const fakeBin = join(dir, 'child-start-fails');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'setsid'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });

    const r = runSync(
      [
        '--pc-heavy-internal-preempt-run',
        String(process.pid),
        join(dir, 'intent'),
        'bash',
        '-c',
        'exit 0',
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PC_HEAVY_PREEMPT_PID_DIR: dir,
      },
    );

    expect(r.status).toBe(42);
    expect(r.stderr).toContain('PC_HEAVY_RESULT status=undetermined reason=child-start-failed exit=42');
  });

  it('emits an undetermined marker when the child-start supervisor never publishes a pid', () => {
    const fakeBin = join(dir, 'child-start-times-out');
    mkdirSync(fakeBin);
    // The real setsid process remains alive, but never runs the pid-file
    // publisher. The monitor's five-second publication deadline is the branch
    // under test; the short sleep lets its reap path finish promptly afterward.
    writeFileSync(join(fakeBin, 'setsid'), '#!/bin/sh\nsleep 6\n', { mode: 0o755 });

    const r = runSync(
      [
        '--pc-heavy-internal-preempt-run',
        String(process.pid),
        join(dir, 'intent'),
        'bash',
        '-c',
        'exit 0',
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PC_HEAVY_PREEMPT_PID_DIR: dir,
      },
    );

    expect(r.status).toBe(75);
    expect(r.stderr).toContain('PC_HEAVY_RESULT status=undetermined reason=child-start-timeout exit=75');
  }, 10_000);

  it('emits an undetermined marker when the published child process-group identity is invalid', () => {
    const fakeBin = join(dir, 'invalid-child-group');
    mkdirSync(fakeBin);
    // Locate the pid-file argument rather than relying on an implementation
    // position, while still making the fixture fail loudly if the monitor stops
    // passing one to the supervisor.
    writeFileSync(
      join(fakeBin, 'setsid'),
      [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    */preemptible.*.pid) printf "%s\\n" invalid > "$arg"; exit 0 ;;',
        '  esac',
        'done',
        'exit 43',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const r = runSync(
      [
        '--pc-heavy-internal-preempt-run',
        String(process.pid),
        join(dir, 'intent'),
        'bash',
        '-c',
        'exit 0',
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        PC_HEAVY_PREEMPT_PID_DIR: dir,
      },
    );

    expect(r.status).toBe(75);
    expect(r.stderr).toContain('PC_HEAVY_RESULT status=undetermined reason=invalid-child-process-group exit=75');
  });

  it('emits an undetermined marker when the monitor receives a signal', async () => {
    const pidDir = join(dir, 'signal-pids');
    mkdirSync(pidDir);
    const ready = join(dir, 'signal-workload-ready');
    const terminated = join(dir, 'signal-workload-terminated');
    const workload = [
      `trap 'echo terminated > ${JSON.stringify(terminated)}; exit 143' TERM`,
      `echo ready > ${JSON.stringify(ready)}`,
      'while :; do sleep 1; done',
    ].join('; ');
    const monitor = spawn(
      'bash',
      [
        PC_HEAVY,
        '--pc-heavy-internal-preempt-run',
        String(process.pid),
        join(dir, 'intent'),
        'bash',
        '-c',
        workload,
      ],
      {
        env: baseEnv({
          PC_HEAVY_PREEMPT_PID_DIR: pidDir,
          PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
          PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
        }),
        cwd: dir,
      },
    );
    const monitorErr = createTextCollector(monitor.stderr);
    let monitorExit: Promise<number> | undefined;
    try {
      await waitFor(
        'the signal-test workload installing its TERM trap',
        () => existsSync(ready),
      );
      monitorExit = new Promise<number>((resolve) => monitor.on('exit', (code) => resolve(code ?? -1)));
      monitor.kill('SIGTERM');
      expect(await monitorExit).toBe(143);
      expect(monitorErr.text()).toContain('PC_HEAVY_RESULT status=undetermined reason=signal exit=143');
      expect(existsSync(terminated)).toBe(true);
    } finally {
      try { monitor.kill('SIGKILL'); } catch { /* already exited */ }
    }
  }, 10_000);

  it('keeps an explicit unpreemptible escape hatch for a caller that cannot be interrupted', async () => {
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '2',
      PC_HEAVY_HEARTBEAT_SEC: '1',
      PC_HEAVY_PREEMPTIBLE: '0',
      PC_HEAVY_PREEMPT_GRACE_SEC: '0',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '60'], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let barrier: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the explicit unpreemptible holder');
      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'echo should-not-run'],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      const barrierExit = new Promise<number>((res) => barrier?.on('exit', (c) => res(c ?? -1)));
      expect(await barrierExit).toBe(75);
      expect(barrierErr.text()).toContain('REFUSED materialization');
      expect(holderErr.text()).not.toContain('PREEMPTING');
      expect(holder.exitCode).toBeNull();
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
    }
  }, 10_000);

  it('does not squat free slots while an exclusive drain waits on a live holder', async () => {
    const env = {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '8',
      PC_HEAVY_HEARTBEAT_SEC: '1',
    };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let barrier: ReturnType<typeof spawn> | undefined;
    let waiter: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the pre-existing slot holder');

      barrier = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'echo should-not-run'],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const barrierErr = createTextCollector(barrier.stderr);
      await untilStderr(
        barrier,
        barrierErr,
        (t) => t.includes('exclusive materialization barrier waiting'),
        'the exclusive barrier beginning its drain',
      );

      // Slot 0 remains occupied by the live holder. The barrier must release
      // its failed all-or-nothing probes of slot 1 so this ordinary waiter can
      // run immediately instead of waiting for the barrier's eight-second
      // refusal deadline.
      waiter = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo ordinary-writer-ran'], {
        env: baseEnv(env), cwd: dir,
      });
      const waiterOut = createTextCollector(waiter.stdout);
      const waiterErr = createTextCollector(waiter.stderr);
      await untilStderr(
        waiter,
        waiterErr,
        (t) => t.includes('slot acquired'),
        'ordinary writer acquiring the free slot',
        3_000,
      );
      const waiterExit = await new Promise<number>((resolve) => waiter?.on('exit', (c) => resolve(c ?? -1)));
      expect(waiterExit).toBe(0);
      expect(waiterOut.text().trim()).toBe('ordinary-writer-ran');
      expect(barrier.exitCode).toBeNull();
    } finally {
      killGroup(holder);
      if (barrier) killGroup(barrier);
      if (waiter) killGroup(waiter);
    }
  });

  it('lets scoped verification use the bounded focused lane while exclusive materialization owns ordinary slots', async () => {
    const env = {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '10',
      PC_HEAVY_FOCUSED_SLOTS: '1',
    };
    const barrier = spawn(
      'bash',
      [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'sleep 30'],
      { env: baseEnv(env), cwd: dir, detached: true },
    );
    const barrierErr = createTextCollector(barrier.stderr);
    let focused: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(
        barrier,
        barrierErr,
        (t) => t.includes('exclusive materialization barrier acquired'),
        'the materialization barrier acquiring every ordinary slot',
      );
      focused = spawn(
        'bash',
        [
          PC_HEAVY,
          'bash',
          '-c',
          'sleep 1; echo scoped-during-materialization-ok',
          'scripts/lint-tsc.mjs',
          '--files=packages/operator-core/lib/x.ts',
        ],
        {
          env: baseEnv({ ...env, PC_HEAVY_TIMEOUT_SEC: '2' }),
          cwd: dir,
        },
      );
      const focusedProcess = focused;
      const focusedOut = createTextCollector(focusedProcess.stdout);
      const focusedErr = createTextCollector(focusedProcess.stderr);
      const focusedExited = new Promise<number>((res) => focusedProcess.on('exit', (c) => res(c ?? -1)));
      await untilStderr(
        focusedProcess,
        focusedErr,
        (t) => t.includes('slot acquired'),
        'scoped lint:tsc taking the focused lane beside materialization',
      );

      expect(heldSlotCount(dir, 2)).toBe(2);
      expect(heldSlotCount(join(dir, 'focused'), 1)).toBe(1);
      expect(focusedErr.peek()).toContain('exclusive materialization barrier is active');
      expect(await focusedExited).toBe(0);
      expect(focusedOut.text()).toContain('scoped-during-materialization-ok');
    } finally {
      killGroup(barrier);
      if (focused) {
        try { process.kill(-(focused.pid as number), 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  });

  /**
   * WI-1507930: this test cost 35.3s — 19.7% of this whole file — because it waited out a
   * REAL 30-second preempt grace and a `sleep 35` child. Both numbers were the TEST'S OWN
   * (the grace is injected below, not read from pc-heavy.sh), and the invariant they prove —
   * a focused run survives the grace expiring under it — depends only on the ORDERING
   * grace < focusedRun < barrier, never on the magnitudes. Scaled down preserving that order
   * with wider proportional margins than the original had (grace+4s vs grace+5s on 30).
   *
   * Slot acquisition here is ~0.3s (measured against sibling focused-lane cases at 0.3-1.3s),
   * so a 5s grace leaves ~4.7s of headroom before the window could close early — and the
   * non-vacuity assertion in the body FAILS LOUDLY rather than passing green if it ever does.
   * The 30s default itself is pinned by the cheap test immediately after this one.
   */
  const GRACE_SEC = 5;
  const FOCUSED_RUN_SEC = 9;

  it('EI-21356396390408722: focused verification is not preempted once the preempt grace expires under it', async () => {
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '20',
      PC_HEAVY_FOCUSED_SLOTS: '1',
      PC_HEAVY_PREEMPT_GRACE_SEC: String(GRACE_SEC),
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '2',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
    };
    const barrier = spawn(
      'bash',
      [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', 'sleep 16'],
      { env: baseEnv(env), cwd: dir, detached: true },
    );
    const barrierErr = createTextCollector(barrier.stderr);
    let focused: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(
        barrier,
        barrierErr,
        (t) => t.includes('exclusive materialization barrier acquired'),
        'the exclusive materialization barrier acquiring every ordinary slot',
      );
      focused = spawn(
        'bash',
        [PC_HEAVY, 'bash', '-c', `sleep ${FOCUSED_RUN_SEC}; echo focused-long-run-ok`, 'scripts/test-files.mjs'],
        { env: baseEnv(env), cwd: dir },
      );
      const focusedProcess = focused;
      const focusedOut = createTextCollector(focusedProcess.stdout);
      const focusedErr = createTextCollector(focusedProcess.stderr);
      const focusedExited = new Promise<number>((res) => focusedProcess.on('exit', (c) => res(c ?? -1)));
      await untilStderr(
        focusedProcess,
        focusedErr,
        (t) => t.includes('slot acquired'),
        'focused test:file taking its independent lane',
      );
      // Non-vacuity clock STARTS at slot acquisition, not at spawn: the claim is that a run
      // HOLDING a focused slot survives the grace expiring underneath it, so the span that has
      // to exceed the grace is the one it spent holding the slot.
      const heldFrom = Date.now();

      expect(heldSlotCount(join(dir, 'focused'), 1)).toBe(1);
      expect(await focusedExited).toBe(0);
      const heldForMs = Date.now() - heldFrom;

      // THE TEST IS ONLY MEANINGFUL IF THE GRACE ACTUALLY EXPIRED WHILE THE RUN HELD ITS SLOT.
      // Without this, shrinking the timings (or a slow box delaying slot acquisition past the
      // grace) turns "was not preempted" into "was never around to be preempted" — a vacuous
      // pass that still reports green. Assert the overlap rather than assuming it.
      expect(
        heldForMs,
        `focused run held its slot for ${heldForMs}ms, which did not outlast the ` +
          `${GRACE_SEC}s preempt grace — the non-preemption assertions below would be vacuous`,
      ).toBeGreaterThan(GRACE_SEC * 1000);

      expect(focusedOut.text()).toContain('focused-long-run-ok');
      expect(focusedErr.text()).not.toContain('PREEMPTING ordinary holder for exclusive materialization');
      expect(focusedErr.text()).not.toContain('PC_HEAVY_RESULT status=preempted reason=exclusive-materializer');
    } finally {
      killGroup(barrier);
      if (focused) {
        try { process.kill(-(focused.pid as number), 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  }, 25_000);

  /**
   * The behavioural test above INJECTS its grace, so it cannot notice the default drifting —
   * it passed identically when the injected value was 30 and when it became 5. That default is
   * the number the name "the 30-second grace" is really about, so pin it HERE, where checking
   * it costs a file read instead of 30 seconds of waiting.
   */
  it('pc-heavy.sh defaults the preempt grace to 30s (the constant the scaled test above no longer waits out)', () => {
    const script = readFileSync(PC_HEAVY, 'utf8');
    expect(
      script,
      'PC_HEAVY_PREEMPT_GRACE_SEC default moved; the scaled non-preemption test injects its own ' +
        'grace and will NOT catch this, which is exactly why this assertion exists',
    ).toContain('PC_HEAVY_PREEMPT_GRACE_SEC:-30');
  });

  it('serializes concurrent exclusive materializers before either can split the slot domain', async () => {
    const env = {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '10',
      PC_HEAVY_HEARTBEAT_SEC: '1',
    };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let first: ReturnType<typeof spawn> | undefined;
    let second: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the pre-existing slot-0 holder');

      const firstRan = join(dir, 'exclusive-first-ran');
      first = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `echo first > "${firstRan}"; sleep 1`],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const firstErr = createTextCollector(first.stderr);
      const firstExit = new Promise<number>((res) => first?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(
        first,
        firstErr,
        (t) => t.includes('exclusive materialization barrier waiting'),
        'the first writer draining around slot 0',
      );

      const secondRan = join(dir, 'exclusive-second-ran');
      second = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `echo second > "${secondRan}"`],
        { env: baseEnv(env), cwd: dir, detached: true },
      );
      const secondErr = createTextCollector(second.stderr);
      const secondExit = new Promise<number>((res) => second?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(
        second,
        secondErr,
        (t) => t.includes('another exclusive materializer owns the writer lock'),
        'the second writer queueing outside the slot domain',
      );
      expect(secondErr.peek()).not.toContain('exclusive materialization barrier waiting to drain');
      expect(existsSync(firstRan)).toBe(false);
      expect(existsSync(secondRan)).toBe(false);

      killGroup(holder);
      expect(await firstExit).toBe(0);
      expect(readFileSync(firstRan, 'utf8').trim()).toBe('first');
      expect(await secondExit).toBe(0);
      expect(readFileSync(secondRan, 'utf8').trim()).toBe('second');
      expect(secondErr.text()).toContain('exclusive materialization writer acquired');
    } finally {
      killGroup(holder);
      if (first) killGroup(first);
      if (second) killGroup(second);
    }
    // WI-1707579: measured timing out at the 5s default inside a loaded sweep. This case
    // spawns three coordinating roots and waits out a real flock handoff, so it needs the
    // same budget as its structural twin below rather than the default.
  }, 30_000);

  it('keeps a release gate kernel-queued past the ordinary writer deadline and ahead of a later writer', async () => {
    const order = join(dir, 'exclusive-writer-order');
    const firstStarted = join(dir, 'exclusive-first-started');
    const releaseFirst = join(dir, 'exclusive-release-first');
    const firstEnv = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '10',
      PC_HEAVY_HEARTBEAT_SEC: '1',
    };
    const first = spawn(
      'bash',
      [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `echo first-start >> "${order}"; touch "${firstStarted}"; while [ ! -f "${releaseFirst}" ]; do sleep 0.05; done; echo first-end >> "${order}"`],
      { env: baseEnv(firstEnv), cwd: dir, detached: true },
    );
    const firstErr = createTextCollector(first.stderr);
    let gate: ReturnType<typeof spawn> | undefined;
    let later: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(first, firstErr, (t) => t.includes('exclusive materialization barrier acquired'), 'the first healthy writer acquiring the barrier');
      await waitFor('the first writer child starting', () => existsSync(firstStarted));

      gate = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `echo gate >> "${order}"; sleep 1`],
        {
          env: baseEnv({
            ...firstEnv,
            PC_HEAVY_TIMEOUT_SEC: '1',
            PC_HEAVY_RELEASE_GATE: '1',
          }),
          cwd: dir,
          detached: true,
        },
      );
      const gateErr = createTextCollector(gate.stderr);
      const gateExit = new Promise<number>((res) => gate?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(gate, gateErr, (t) => t.includes('another exclusive materializer owns the writer lock'), 'the release gate joining the kernel writer queue');

      later = spawn(
        'bash',
        [PC_HEAVY, '--exclusive-all-slots', 'bash', '-c', `echo later >> "${order}"`],
        { env: baseEnv(firstEnv), cwd: dir, detached: true },
      );
      const laterErr = createTextCollector(later.stderr);
      const laterExit = new Promise<number>((res) => later?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(later, laterErr, (t) => t.includes('another exclusive materializer owns the writer lock'), 'the later writer queueing behind the gate');
      await untilStderr(later, laterErr, (t) => t.includes('writer lock held by:'), 'the kernel-verified writer owner diagnostic');

      // The kernel lock table includes the holder plus `->` rows for queued
      // writers. The owner sidecar names only the first wrapper; queued
      // gate/later openers must never overwrite it or be labeled as owners.
      expect(first.pid).toBeDefined();
      expect(gate.pid).toBeDefined();
      expect(later.pid).toBeDefined();
      expect(laterErr.peek()).toContain(`pid ${first.pid}`);
      expect(laterErr.peek()).not.toContain(`pid ${gate.pid}`);
      expect(laterErr.peek()).not.toContain(`pid ${later.pid}`);

      // The old polling/deadline path exited 75 here. The gate must remain
      // alive after its ordinary one-second budget because the existing writer
      // is healthy and the checkpoint process owns the outer lifecycle bound.
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(gate.exitCode).toBeNull();

      writeFileSync(releaseFirst, 'release\n');
      expect(await gateExit).toBe(0);
      expect(await laterExit).toBe(0);
      expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual([
        'first-start',
        'first-end',
        'gate',
        'later',
      ]);
      expect(gateErr.text()).not.toContain('REFUSED materialization after 1s');
      expect(gateErr.text()).toContain('exclusive materialization writer acquired');
    } finally {
      killGroup(first);
      if (gate) killGroup(gate);
      if (later) killGroup(later);
    }
    // HARNESS budget only, not the property. The property is pinned above by the
    // gate's 1s PC_HEAVY_TIMEOUT_SEC, the 1.3s survival check and the exact
    // ordering. This case runs three pc-heavy wrappers and five landmark waits in
    // series, and each untilStderr waits up to 30s by itself. Under gate load
    // (~180 on 128 cores), a 30s case cap cut the run off with a bare
    // "Test timed out in 30000ms" before any landmark could report its stderr.
    // The cap must stay above one landmark budget so a real hang fails with a
    // diagnostic (WI-10005367).
  }, 120_000);

  it('still throttles an ordinary sweep when GREEN_CHECKPOINT is unset', () => {
    // The other half of the invariant above: the exemption must be keyed to the release
    // gate, not accidentally open to everyone.
    const slots = join(dir, 'made-by-ordinary-run');
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'echo ok'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_DIR: slots, PC_HEAVY_IONICE: '', PC_HEAVY_SLOTS: '2' },
      cwd: dir,
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(existsSync(slots)).toBe(true);
  });

  it('runs unthrottled (fail-open) when the slot dir cannot be created', () => {
    const r = spawnSync('bash', [PC_HEAVY, 'bash', '-c', 'echo ran'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', PC_HEAVY_DIR: unwritablePath('slots'), PC_HEAVY_IONICE: '' },
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ran');
  });

  it('propagates the child exit code', () => {
    const r = runSync(['bash', '-c', 'exit 7'], { PC_HEAVY_SLOTS: '2' });
    expect(r.status).toBe(7);
  });

  it('errors (exit 2) when given no command', () => {
    const r = runSync([]);
    expect(r.status).toBe(2);
  });

  it('EI-20227475180704442: snapshots the wrapper before a rewrite can corrupt bash parsing', async () => {
    // A top-level sleep gives the test a causal window: the old script executes
    // the sleep before parsing the rest of the file, while the function-wrapped
    // script must parse the complete body before the marker can be printed.
    const fixture = join(dir, 'pc-heavy-rewrite.sh');
    const marker = '[pc-heavy-test] parser window';
    const source = readFileSync(PC_HEAVY, 'utf8');
    writeFileSync(
      fixture,
      source.replace('set -uo pipefail\n', `set -uo pipefail\nprintf '%s\\n' '${marker}' >&2\nsleep 0.4\n`),
      { mode: 0o755 },
    );

    const child = spawn('bash', [fixture, 'bash', '-c', 'printf stable'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE: '0' }),
      cwd: dir,
    });
    const stdout = createTextCollector(child.stdout);
    const stderr = createTextCollector(child.stderr);
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

    try {
      await untilStderr(child, stderr, (text) => text.includes(marker), 'parser-window marker', 10_000);
      // This is deliberately invalid shell. If bash is still reading the file
      // after the marker, the old incremental parser sees it and exits 2. A
      // function body has already been parsed in full, so the running process
      // remains unaffected by this rewrite.
      writeFileSync(fixture, `${readFileSync(fixture, 'utf8')}\n"`);

      expect(await exited).toBe(0);
      expect(stdout.text().trim()).toBe('stable');
      expect(stderr.text()).not.toMatch(/unexpected EOF|syntax error/i);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 20_000);

  it('caps concurrency at PC_HEAVY_SLOTS (2 slots, 4 jobs → max 2 simultaneous)', async () => {
    const jobs = 4;
    const slots = 2;
    const admitted = await admittedCohortSize(jobs, { PC_HEAVY_SLOTS: String(slots) });
    // Exactly the cap: proves it is a COUNTING semaphore (2 run together, not 1
    // like a mutex) AND that it never exceeds the cap (not unbounded).
    expect(admitted).toBe(slots);
  });

  it('frees a slot when the whole holder tree is killed (kernel flock crash-safety)', async () => {
    // 1 slot. A holder grabs it and sleeps long; SIGKILL its entire process
    // GROUP (the wrapper + its niced child) so NO cleanup code can run; a fresh
    // acquire must then succeed promptly (well under its wait timeout), proving
    // the slot is freed by the kernel dropping the closed fds' flock — not by
    // any manual lockfile removal. (The child deliberately INHERITS the lock,
    // so a slot stays held while orphaned work runs; killing the tree is what
    // frees it — exactly the crash we care about.)
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      cwd: dir,
      detached: true, // own process group, so -pid kills the whole tree
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    process.kill(-(holder.pid as number), 'SIGKILL'); // kill the group, no cleanup runs
    // The kernel drops the flock when the last fd closes — which is the very thing under test, so
    // wait for the slot to actually read as free rather than assuming a fixed grace period.
    await waitFor('kernel releases the killed holder\'s flock', () => heldSlotCount(dir, 1) === 0);

    const t0 = Date.now();
    const r = runSync(['bash', '-c', 'echo got-slot'], { PC_HEAVY_SLOTS: '1', PC_HEAVY_TIMEOUT_SEC: '10' });
    const waited = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('got-slot');
    expect(waited).toBeLessThan(5000); // got the freed slot, not blocked to the timeout
  });

  it('EI-20223367668302814: exact-file verification has a bounded wait instead of inheriting the 900s broad-work budget', async () => {
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      cwd: dir,
      detached: true,
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    try {
      const t0 = Date.now();
      const r = runSync(['node', 'scripts/test-files.mjs', '--probe'], {
        PC_HEAVY_SLOTS: '1',
        PC_HEAVY_SCOPED_TIMEOUT_SEC: '1',
      });
      const waited = Date.now() - t0;

      // The command itself need not exist in this isolated fixture; the contract
      // under test is that it STARTS after the scoped bound instead of sitting in
      // the semaphore for the broad default's 900 seconds.
      expect(r.stderr).toContain('waiting up to 1s');
      expect(r.stderr).toContain('[pc-heavy] slot acquired — starting real work');
      // The queue landmark above is the deterministic proof that the scoped
      // 1-second value was selected. A lower wall-clock bound is invalid here:
      // pc-heavy derives its deadline from integer-second `date` output, so a
      // process landing just before the next second can legitimately fall
      // through on its first 500ms poll (observed at 264ms in gate candidate
      // 52676bb91277). Keep only the upper bound that distinguishes this path
      // from the broad 900-second default. That upper bound is the runSync
      // spawn kill (30s), NOT a tight 5s: the gate measured 23.4s here on
      // repairHead 0d8ad5e3 under fleet load (WI-10005207) — node boot +
      // pc-heavy's 500ms poll, not a broad-budget wait. A broad 900s wait is
      // killed at 30s and never prints the landmark above, so this still fails.
      expect(r.error).toBeUndefined();
      expect(waited).toBeLessThan(29_000);
    } finally {
      killGroup(holder);
    }
  });

  it('EI-21860262943616012: explicitly scoped test:affected uses the bounded queue wait', async () => {
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      cwd: dir,
      detached: true,
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    try {
      const t0 = Date.now();
      const r = runSync(
        [
          'node',
          'scripts/affected-tests.mjs',
          '--changed-paths',
          'packages/operator-core/lib/__tests__/affected-tests-result-line.test.ts',
        ],
        {
          PC_HEAVY_SLOTS: '1',
          PC_HEAVY_SCOPED_TIMEOUT_SEC: '1',
        },
      );
      const waited = Date.now() - t0;

      // The fixture command need not resolve from this temporary cwd. The
      // contract is that explicit path-scoped affected verification reaches
      // the handoff after the narrow bound instead of waiting behind the
      // broad 900-second default until its caller kills the wrapper.
      expect(r.stderr).toContain('waiting up to 1s');
      expect(r.stderr).toContain('[pc-heavy] slot acquired — starting real work');
      // Upper bound = just under runSync's 30s spawn kill (see the sibling
      // EI-20223367668302814 test): load can stretch the 1s path to ~23s, but a
      // broad 900s wait is killed before the landmark above prints.
      expect(r.error).toBeUndefined();
      expect(waited).toBeLessThan(29_000);
    } finally {
      killGroup(holder);
    }
  });

  it('EI-21361359358514189: a caller TERM while queued is retryable and reports the live holder', async () => {
    // Each observable stage has its own 30s budget. Keep the outer Vitest
    // budget above their sum so a stalled stage reports its stderr/state
    // instead of an uninformative framework timeout after 10s.
    const stageTimeoutMs = 30_000;
    const env = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '30',
      PC_HEAVY_HEARTBEAT_SEC: '1',
    };
    const ran = join(dir, 'queue-signal-ran');
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '60'], {
      env: baseEnv(env), cwd: dir, detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let waiter: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the queue-signal holder taking the only slot', stageTimeoutMs);

      waiter = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo ran > "' + ran + '"'], {
        env: baseEnv(env), cwd: dir, detached: true,
      });
      const waiterErr = createTextCollector(waiter.stderr);
      const waiterExit = new Promise<number>((res) => waiter?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(waiter, waiterErr, (t) => t.includes('queued for a heavy slot'), 'the caller entering the queue', stageTimeoutMs);

      killGroup(waiter);
      await waitFor(
        'the queued caller exiting after TERM',
        () => waiter !== undefined && (waiter.exitCode !== null || waiter.signalCode !== null),
        stageTimeoutMs,
      );
      expect(await waiterExit, waiterErr.text()).toBe(75);
      expect(existsSync(ran)).toBe(false);

      const err = waiterErr.text();
      expect(err).toContain('QUEUE_ABORTED status=retryable reason=caller-signal signal=TERM exit=75');
      expect(err).toContain('gate-phase=none');
      expect(err).toContain('queued slot.0 held by:');
      expect(err).toContain('pid ' + holder.pid);
      expect(err).toContain('PC_HEAVY_RESULT status=retryable reason=queue-signal signal=TERM exit=75');
      expect(err).not.toContain('slot acquired — starting real work');
    } finally {
      killGroup(holder);
      if (waiter) killGroup(waiter);
    }
  }, 100_000);

  it('a waiter grabs a DIFFERENT slot that frees, instead of convoying on slot 0 alone (regression: pc-heavy slot-0 convoy)', async () => {
    // 2 slots. Holder A takes slot 0 (the natural first pick with no
    // contention) and sleeps long (30s). The ORIGINAL fallback blocked an
    // all-slots-busy waiter specifically on slot 0's flock
    // (`flock -w "$_timeout" "$_fd"` against slot.0 alone), so it would sit
    // stuck behind A for up to the full PC_HEAVY_TIMEOUT_SEC even while
    // slot 1 sat completely free — observed live: ~20 waiters queued on
    // slot 0 while slots 2/3 had zero holders on a 4-slot host. Holder B
    // takes slot 1 (naturally, since slot 0 is busy) and finishes quickly.
    // A third caller arriving while BOTH slots are busy must grab slot 1
    // promptly once B releases it, not wait out the (much longer) timeout.
    const slots = 2;
    const holderA = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: String(slots) }),
      cwd: dir,
      detached: true,
    });
    await waitFor('A grabs slot 0', () => heldSlotCount(dir, slots) >= 1);

    const holderB = spawn('bash', [PC_HEAVY, 'sleep', '2'], {
      env: baseEnv({ PC_HEAVY_SLOTS: String(slots) }),
      cwd: dir,
      detached: true,
    });
    await waitFor('B grabs slot 1 (slot 0 is busy)', () => heldSlotCount(dir, slots) === slots);

    const t0 = Date.now();
    const r = runSync(['bash', '-c', 'echo got-a-free-slot'], {
      PC_HEAVY_SLOTS: String(slots),
      PC_HEAVY_TIMEOUT_SEC: '25', // much longer than B's remaining ~1s sleep
    });
    const waited = Date.now() - t0;

    try {
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('got-a-free-slot');
      // Got slot 1 promptly after B released it, not the full 25s timeout
      // the old slot-0-only fallback would have waited out (A holds slot 0
      // for 30s, well past the timeout).
      expect(waited).toBeLessThan(10_000);
    } finally {
      process.kill(-(holderA.pid as number), 'SIGKILL');
      try { process.kill(-(holderB.pid as number), 'SIGKILL'); } catch { /* likely already exited */ }
    }
  });

  it('propagates the real child\'s stderr on the uncontested (first-try slot) path', () => {
    // Regression test (EI-18685262961418231 investigation): `exec {fd}>file
    // 2>/dev/null` with NO command applies ALL its redirections PERSISTENTLY
    // to the invoking shell, so the ORIGINAL script silently redirected its
    // own stderr to /dev/null forever the instant a slot was free on the
    // first try — the common, uncontended case. Every heavy command's real
    // stderr (build/type errors) was being dropped on the floor.
    const r = runSync(['bash', '-c', 'echo out-line; echo err-line >&2; exit 5'], { PC_HEAVY_SLOTS: '2' });
    expect(r.status).toBe(5);
    expect(r.stdout.trim()).toBe('out-line');
    // Not an exact match: the wrapper also emits its own "slot acquired" landmark
    // (EI-19315037905600226, asserted below) on the same stream before handing off
    // to the real command.
    expect(r.stderr).toContain('err-line');
  });

  it('EI-19315037905600226: emits a "slot acquired" landmark on stderr right before handing off to the real command', () => {
    // The exact literal bash-jobs.ts's background-deadline handler greps a job's
    // output for, to tell "killed while still queued" from "killed mid-execution".
    const r = runSync(['bash', '-c', 'echo real-output'], { PC_HEAVY_SLOTS: '2' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('[pc-heavy] slot acquired — starting real work');
    // It must precede the real command's own output on the combined timeline —
    // proving it marks the handoff, not merely "sometime during the run".
    const markerIdx = r.stderr.indexOf('[pc-heavy] slot acquired');
    expect(markerIdx).toBeGreaterThanOrEqual(0);
  });

  it('EI-19343041616234869: prints an enqueue-time "queued" line the instant it actually has to wait — but never on the uncontended fast path', async () => {
    // Without this, a caller backgrounding a ~150s+ compile (the documented idiom)
    // sees a genuinely empty log for the entire time it sits behind a busy slot —
    // indistinguishable from "not started yet" or "died silently". Holder A takes
    // the only slot and sleeps; a waiter arriving while it's held must hit the
    // fallback branch and print the enqueue line BEFORE it starts polling.
    // The holder sleeps far longer than this test takes and is killed the moment the
    // waiter's own stderr proves it enqueued — so the claim "the line is printed BEFORE
    // the wait ends" is observed CAUSALLY (it appeared while the slot was still held),
    // not merely inferred from two indices in a buffer read after the fact.
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      cwd: dir,
      detached: true,
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    try {
      const waiter = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo got-it'], {
        env: baseEnv({ PC_HEAVY_SLOTS: '1', PC_HEAVY_TIMEOUT_SEC: '20' }),
        cwd: dir,
      });
      const wOut = createTextCollector(waiter.stdout);
      const wErr = createTextCollector(waiter.stderr);
      const exited = new Promise<number>((res) => waiter.on('exit', (c) => res(c ?? -1)));

      await untilStderr(waiter, wErr, (t) => t.includes('[pc-heavy] queued for a heavy slot'),
        'the enqueue-time queued line, while the slot is still held');
      killGroup(holder); // frees the slot; the waiter now proceeds

      expect(await exited).toBe(0);
      const stderr = wErr.text(); // exited: terminal read
      expect(wOut.text().trim()).toBe('got-it');
      // Must precede "slot acquired" — it announces the wait BEGINNING, not the end.
      const queuedIdx = stderr.indexOf('[pc-heavy] queued for a heavy slot');
      const acquiredIdx = stderr.indexOf('[pc-heavy] slot acquired');
      expect(queuedIdx).toBeGreaterThanOrEqual(0);
      expect(acquiredIdx).toBeGreaterThan(queuedIdx);
    } finally {
      killGroup(holder);
    }

    // The common uncontended case (the vast majority of calls, per the "first-try
    // slot" test above) must NEVER print the queued line — it would be noise on
    // every single ordinary invocation.
    const fast = runSync(['bash', '-c', 'echo ok'], { PC_HEAVY_SLOTS: '2' });
    expect(fast.status).toBe(0);
    expect(fast.stderr).not.toContain('[pc-heavy] queued for a heavy slot');
  });

  it('EI-19343041616234869: emits periodic "still queued" heartbeats while waiting, via PC_HEAVY_HEARTBEAT_SEC', async () => {
    // A long wait under a hard clamp must not go silent for its whole duration —
    // same rationale as the enqueue line, amortized across the wait. Real default
    // is 15s; override to 1s so the test doesn't have to actually wait that long.
    //
    // TWO heartbeats is what proves PERIODIC rather than one-shot, so the wait is
    // genuinely the subject here — but only up to the SECOND beat. Sizing the holder's
    // sleep to cover it (the previous `sleep 4`) made every run pay the remainder too,
    // and made the count depend on how much of that window this call's own startup ate.
    // Releasing the slot the instant the second beat lands costs exactly the subject.
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1' }),
      cwd: dir,
      detached: true,
    });
    await waitFor('holder grabs the only slot', () => heldSlotCount(dir, 1) === 1);
    try {
      const waiter = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo got-it'], {
        env: baseEnv({
          PC_HEAVY_SLOTS: '1',
          PC_HEAVY_TIMEOUT_SEC: '20',
          PC_HEAVY_HEARTBEAT_SEC: '1',
        }),
        cwd: dir,
      });
      const wErr = createTextCollector(waiter.stderr);
      const exited = new Promise<number>((res) => waiter.on('exit', (c) => res(c ?? -1)));
      const beats = (t: string) => (t.match(/\[pc-heavy\] still queued/g) ?? []).length;

      await untilStderr(waiter, wErr, (t) => beats(t) >= 2,
        'two periodic "still queued" heartbeats while the slot is held', 20_000);
      killGroup(holder); // frees the slot; the waiter now proceeds

      expect(await exited).toBe(0);
      expect(beats(wErr.text())).toBeGreaterThanOrEqual(2); // exited: terminal read
    } finally {
      killGroup(holder);
    }
  });
});

describe('pc-heavy.sh — memory clamp (EI-20336929607862174)', () => {
  // The bug this guards: _calc_slots admits on load1 alone, and memory pressure
  // LOWERS load1 (processes stall in reclaim) — so admission WIDENS exactly when
  // memory is scarce. Measured 2026-08-13: two concurrent
  // `tsc -p packages/operator-core` later reached 9.1–11.2 GiB RSS
  // (WI-10003344), so the old 6 GiB budget admitted six against 48 GiB
  // headroom and memory PSI full avg10 reached ~70%.
  //
  // The CONTROL arm is what makes this falsifiable without mutating the tree:
  // an identical config with memory headroom must run all 6 at once, so a
  // clamped result cannot be explained by the semaphore, the gate reserve, or a
  // slow box — only by the memory budget.
  //
  // Since WI-10005334 the reserve is per job CLASS and the probes are `bash -c`
  // loops (class `other`, 4 GiB cold start), so every arm here pins
  // PC_HEAVY_JOB_CLASS=typecheck: these cases are about operator-core compiles,
  // whose cold-start reserve is still the measured 14 GiB. With every probe
  // holding its full reserve and using ~nothing, headroom admission
  // (MemAvailable minus the running reserves >= one more reserve) admits
  // exactly the old MemAvailable / reserve count.
  it('clamps a FIXED PC_HEAVY_SLOTS down to what MemAvailable can hold', async () => {
    const headroom = await admittedCohortSize(6, {
      PC_HEAVY_SLOTS: '6',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '600', // budget 50 — nowhere near binding
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
    });
    expect(headroom).toBe(6);

    const scarce = await admittedCohortSize(6, {
      PC_HEAVY_SLOTS: '6',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '28', // 28 / 14 GiB-per-slot => 2
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
    });
    // Clamps a FIXED slot count too: this is a physical ceiling, not load
    // adaptation, so PC_HEAVY_SLOTS must not be able to opt out of it.
    expect(scarce).toBe(2);

    // WI-10003344's observed six concurrent operator-core compiles cannot all
    // enter through this wrapper with 48 GiB free, even before PSI backoff:
    // 48 / 14 GiB-per-slot (the measured 12.74 GiB peak plus margin) => 3.
    const reportedHeadroom = await admittedCohortSize(6, {
      PC_HEAVY_SLOTS: '6',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '48',
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
    });
    expect(reportedHeadroom).toBe(3);
    const oldBudget = await admittedCohortSize(6, {
      PC_HEAVY_SLOTS: '6',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '48',
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
      PC_HEAVY_MEM_PER_SLOT_GIB: '6',
    });
    expect(oldBudget).toBe(6);
  });

  it('halves the budget once memory PSI says the box is already in reclaim', async () => {
    // The budget must be sized to bind EXACTLY at the ask, or the halving is
    // invisible: 56 GiB / 14 GiB-per-slot => 4, the same as PC_HEAVY_SLOTS. The
    // calm arm then pins that baseline, so the drop to 2 in the second arm is
    // attributable to PSI alone.
    const calm = await admittedCohortSize(4, {
      PC_HEAVY_SLOTS: '4',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '56', // budget 4 — exactly the ask
      PC_HEAVY_MEM_PSI_OVERRIDE: '0',
    });
    expect(calm).toBe(4);

    const reclaiming = await admittedCohortSize(4, {
      PC_HEAVY_SLOTS: '4',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '56',
      PC_HEAVY_MEM_PSI_OVERRIDE: '9', // >= PC_HEAVY_MEM_PSI_BACKOFF (5)
    });
    expect(reclaiming).toBe(2);
  });

  it('fails open: an unreadable MemAvailable never throttles, and PC_HEAVY_MEM_CLAMP=0 disables it', async () => {
    // Every unexpected input must degrade to the pre-clamp behavior. A clamp
    // that throttles the fleet to 1 because it could not parse /proc/meminfo
    // would be far worse than the pressure it exists to prevent.
    const garbage = await admittedCohortSize(4, {
      PC_HEAVY_SLOTS: '4',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: 'not-a-number',
    });
    expect(garbage).toBe(4);

    const disabled = await admittedCohortSize(4, {
      PC_HEAVY_SLOTS: '4',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEM_CLAMP: '0',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '1', // would clamp to 1 if honoured
    });
    expect(disabled).toBe(4);
  });

  it('never clamps below 1 — a starved box still makes forward progress', async () => {
    const starved = await admittedCohortSize(2, {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_JOB_CLASS: 'typecheck',
      PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '0',
      PC_HEAVY_MEM_PSI_OVERRIDE: '99',
    });
    expect(starved).toBe(1);
  });
});

describe('pc-heavy.sh — per-class headroom admission (WI-10005334)', () => {
  // The defect: one reserve sized from the ledger's largest job (a ~9 GiB
  // compile) was charged to EVERY slot, and the slot count was MemAvailable /
  // reserve with running holders still occupying slots — so memory they were
  // already using was counted twice. On a 16-vCPU VM that held 24 agents where
  // a flat 4 GiB held 32 (agent-capacity-and-cost-gcp-2026-09-30#D-033).
  //
  // Seeded ledger: test runs peak at 900 MiB (=> a 1 GiB `other` reserve) and
  // no compile has run (=> the 14 GiB `typecheck` constant). The holders use
  // ~nothing, so each counts at almost its full reserve.
  const SMALL_JOBS = { PC_HEAVY_MEM_PER_SLOT_MIN_SPAN_SEC: '3600', PC_HEAVY_SLOTS: '12' };
  function seedSmallJobLedger() {
    writeFileSync(join(dir, 'job-peaks.tsv'), Array.from({ length: 12 }, (_, i) =>
      `at=${1_790_000_000 + i * 3600} anon_mib=900 rss_mib=900 samples=5 secs=10 exit=0 class=other label=npx vitest run`,
    ).join('\n') + '\n');
  }

  // "memory admission lock busy" is a TRANSIENT refusal by design: _try_acquire_slot
  // (pc-heavy.sh) counts a 2 s flock miss on mem-admission.lock as "not yet" and the
  // next 0.5 s sweep retries. Ten simultaneous arrivals serialize on that lock, so under
  // load the last one can miss it. Counting that line as settled snapshotted `admitted`
  // mid-admission (8 or 9 of 10, measured 2026-10-11, WI-6554700010008342). Only an
  // admission or a queue line naming a real reason (headroom shortfall, all slots busy)
  // settles a probe.
  const QUEUED_FOR_A_SETTLED_REASON =
    /\[pc-heavy\] (?:queued for a heavy slot \((?!memory headroom: memory admission lock busy\))|still queued \((?:[^;)]*\)|[^)]*; memory headroom: (?!memory admission lock busy\))))/;

  it('the cohort settle predicate ignores the transient lock-busy refusal and accepts real queue reasons', () => {
    const shortfall = 'memory headroom: 10240 MiB free after 10 running reserve(s), 14336 MiB needed';
    expect(QUEUED_FOR_A_SETTLED_REASON.test('[pc-heavy] queued for a heavy slot (memory headroom: memory admission lock busy) — pid 1, waiting up to 900s')).toBe(false);
    expect(QUEUED_FOR_A_SETTLED_REASON.test('[pc-heavy] still queued (3s elapsed, pid 1, slots=12; memory headroom: memory admission lock busy)')).toBe(false);
    expect(QUEUED_FOR_A_SETTLED_REASON.test(`[pc-heavy] queued for a heavy slot (${shortfall}) — pid 1, waiting up to 900s`)).toBe(true);
    expect(QUEUED_FOR_A_SETTLED_REASON.test(`[pc-heavy] still queued (3s elapsed, pid 1, slots=12; ${shortfall})`)).toBe(true);
    expect(QUEUED_FOR_A_SETTLED_REASON.test('[pc-heavy] queued for a heavy slot (all 12 slot(s) busy) — pid 1, waiting up to 900s')).toBe(true);
    // A lock-busy probe that then finds every slot busy only heartbeats, with no memory note.
    expect(QUEUED_FOR_A_SETTLED_REASON.test('[pc-heavy] still queued (3s elapsed, pid 1, slots=12)')).toBe(true);
  });

  /** Spawn `jobs` probes that hold their admission until `release()`; resolves once each is admitted or queued for a settled reason. */
  async function holdCohort(jobs: number, env: Record<string, string>) {
    const cohortDir = mkdtempSync(join(dir, 'held-cohort-'));
    const releaseFile = join(cohortDir, 'release');
    const probes = Array.from({ length: jobs }, (_, i) => {
      const ready = join(cohortDir, `ready.${i}`);
      const child = spawn('bash',
        [PC_HEAVY, 'bash', '-c', `touch "${ready}"; while [ ! -f "${releaseFile}" ]; do sleep 0.02; done`],
        { env: baseEnv({ PC_HEAVY_COALESCE: '0', PC_HEAVY_GATE_RESERVE: '0', ...env }), cwd: dir, detached: true });
      return {
        child, ready, stderr: createTextCollector(child.stderr),
        exited: new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1))),
      };
    });
    await waitFor('every held probe being admitted or observably queued', () =>
      probes.every(({ child, ready, stderr }) => {
        if (existsSync(ready)) return true;
        if (QUEUED_FOR_A_SETTLED_REASON.test(stderr.peek())) return true;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`held probe exited ${child.exitCode ?? child.signalCode} before admission or queueing`);
        }
        return false;
      }));
    return {
      admitted: probes.filter(({ ready }) => existsSync(ready)).length,
      stderr: () => probes.map(({ stderr }) => stderr.peek()).join('\n'),
      release: async () => {
        writeFileSync(releaseFile, 'go\n');
        return Promise.all(probes.map(({ exited }) => exited));
      },
      kill: () => {
        writeFileSync(releaseFile, 'go\n');
        for (const { child } of probes) {
          if (child.exitCode === null && child.signalCode === null) killGroup(child);
        }
      },
    };
  }

  it('ten small holders do not block a compile while memory is free; the old single reserve did', async () => {
    seedSmallJobLedger();
    const arrivalsEnv = { ...SMALL_JOBS, PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '28', PC_HEAVY_JOB_CLASS: 'typecheck' };
    const holders = await holdCohort(10, { ...SMALL_JOBS, PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '28' });
    const arrivals: Array<Awaited<ReturnType<typeof holdCohort>>> = [];
    try {
      expect(holders.admitted).toBe(10);
      // 28 GiB - 10 x 1 GiB reserved = 18 GiB free >= the compile's 14 GiB.
      const compile = await holdCohort(1, arrivalsEnv);
      arrivals.push(compile);
      expect(compile.admitted, compile.stderr()).toBe(1);
      // CONTROL: the pre-WI-10005334 rule on the same box charges every slot the
      // larger 14 GiB reserve, so 28 GiB holds 2 slots and both are long taken.
      const oldRule = await holdCohort(1, { ...arrivalsEnv, PC_HEAVY_MEM_ADMISSION: 'count' });
      arrivals.push(oldRule);
      expect(oldRule.admitted).toBe(0);
      expect(await holders.release()).toEqual(Array(10).fill(0));
      for (const arrival of arrivals) expect(await arrival.release()).toEqual([0]);
    } finally {
      holders.kill();
      for (const arrival of arrivals) arrival.kill();
    }
  }, 60_000);

  it('refuses a compile when the headroom is short, while a small job still fits, and names the shortfall', async () => {
    seedSmallJobLedger();
    const tight = { ...SMALL_JOBS, PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '20' };
    const holders = await holdCohort(10, tight);
    const arrivals: Array<Awaited<ReturnType<typeof holdCohort>>> = [];
    try {
      expect(holders.admitted).toBe(10);
      // 20 GiB - 10 x 1 GiB reserved = 10 GiB free < 14 GiB.
      const compile = await holdCohort(1, { ...tight, PC_HEAVY_JOB_CLASS: 'typecheck' });
      arrivals.push(compile);
      expect(compile.admitted).toBe(0);
      expect(compile.stderr()).toMatch(/queued for a heavy slot \(memory headroom: \d+ MiB free after 10 running reserve\(s\), 14336 MiB needed\)/);
      // The same 10 GiB of headroom fits one more 1 GiB test run.
      const small = await holdCohort(1, tight);
      arrivals.push(small);
      expect(small.admitted, small.stderr()).toBe(1);
      expect(await holders.release()).toEqual(Array(10).fill(0));
      // Once the holders leave, the queued compile is admitted and finishes.
      for (const arrival of arrivals) expect(await arrival.release()).toEqual([0]);
    } finally {
      holders.kill();
      for (const arrival of arrivals) arrival.kill();
    }
  }, 60_000);

  it('counts a live holder at its reserve minus the memory it already uses, and drops a dead holder\'s record', async () => {
    const reserves = join(dir, 'reserves');
    mkdirSync(reserves, { recursive: true });
    // A dead holder: nothing holds its record's lock, so its 900 GiB must not count.
    writeFileSync(join(reserves, 'rec.dead'), 'class=typecheck reserve_mib=921600 pid=1\n');
    // A live holder reserving 30 GiB: the kernel lock on its record is the liveness proof.
    writeFileSync(join(reserves, 'rec.live'), 'class=typecheck reserve_mib=30720 pid=1\n');
    const holder = spawn('flock', [join(reserves, 'rec.live'), 'sleep', '30'], { detached: true, stdio: 'ignore' });
    const compileEnv = { PC_HEAVY_SLOTS: '4', PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '28', PC_HEAVY_JOB_CLASS: 'typecheck' };
    const arrivals: Array<Awaited<ReturnType<typeof holdCohort>>> = [];
    try {
      await waitFor('the planted holder to take its record lock', () =>
        spawnSync('flock', ['-n', join(reserves, 'rec.live'), 'true']).status !== 0);
      // 28 GiB - 30 GiB reserved < 14 GiB: queued.
      const blocked = await holdCohort(1, compileEnv);
      arrivals.push(blocked);
      expect(blocked.admitted).toBe(0);
      expect(existsSync(join(reserves, 'rec.dead'))).toBe(false);
      // The holder now reports 20 GiB in use (already gone from MemAvailable), so
      // only 10 GiB of its reserve is outstanding: 28 - 10 = 18 GiB >= 14 GiB.
      writeFileSync(join(reserves, 'anon.live'), '20480\n');
      await waitFor('the queued compile to be admitted', () => blocked.stderr().includes('[pc-heavy] slot acquired'));
      expect(await blocked.release()).toEqual([0]);
    } finally {
      for (const arrival of arrivals) arrival.kill();
      killGroup(holder);
    }
  }, 60_000);
});

describe('pc-heavy.sh — priority-aware PSI admission (WI-42293)', () => {
  const admissionState = (id: string): string =>
    readFileSync(join(dir, 'psi-admissions', `${id}.state`), 'utf8');

  const processState = (pid: number): string => {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(') ') + 2).split(/\s+/, 1)[0] ?? '';
  };

  it('gives focused test:file commands PSI priority even when no gate activates the focused slot lane', () => {
    const run = spawnSync(
      'bash',
      [PC_HEAVY, 'bash', '-c', 'printf focused-ok', 'scripts/test-files.mjs'],
      {
        env: baseEnv({
          PC_HEAVY_SLOTS: '1',
          PC_HEAVY_COALESCE: '0',
          PC_HEAVY_GATE_RESERVE: '0',
          PC_HEAVY_DEBUG: '1',
          // The unpreemptible diagnostic reports the computed PSI priority
          // without starting the asynchronous controller.
          PC_HEAVY_PREEMPTIBLE: '0',
        }),
        cwd: dir,
        encoding: 'utf8',
      },
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('focused-ok');
    expect(run.stderr).toContain('focused=0');
    expect(run.stderr).toContain(
      'PC_HEAVY_ADMISSION status=undetermined reason=unpreemptible priority=50',
    );
  });

  it('freezes lower-priority roots deterministically, preserves the release gate, and thaws one per quiet window', async () => {
    const psiFile = join(dir, 'psi-full-avg10');
    const gateRelease = join(dir, 'release-gate-continue');
    const gateDone = join(dir, 'release-gate-done');
    const oldPidFile = join(dir, 'ordinary-old.pid');
    const newPidFile = join(dir, 'ordinary-new.pid');
    const admissionDir = join(dir, 'psi-admissions');
    writeFileSync(psiFile, '0\n');

    const ordinaryCommand = (pidFile: string) =>
      `echo $$ > "${pidFile}"; trap 'exit 0' TERM INT HUP; while :; do sleep 0.05; done`;
    const shared = {
      PC_HEAVY_SLOTS: '3',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_GATE_RESERVE: '0',
      PC_HEAVY_MEM_PSI_OVERRIDE_FILE: psiFile,
      // Keep the intermediate frozen-state assertion deterministic even when
      // this test's 250 ms timer is delayed by sibling pure-lane work. The
      // controller samples whole seconds, so a 1 s window can elapse before
      // the JS callback is scheduled; 3 s still keeps this case bounded.
      PC_HEAVY_MEM_PSI_RECOVERY_SEC: '3',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '128',
    };

    // The authoritative gate bypasses both the slot domain and the admission
    // candidate ledger. Hold it open until both ordinary roots are proven
    // frozen; if PSI control accidentally targets it, gateDone never appears.
    const gate = spawn(
      'bash',
      [PC_HEAVY, 'bash', '-c', `while [ ! -f "${gateRelease}" ]; do sleep 0.05; done; echo done > "${gateDone}"`],
      {
        env: baseEnv({ ...shared, PC_HEAVY_RELEASE_GATE: '1' }),
        cwd: dir,
        detached: true,
      },
    );
    const gateErr = createTextCollector(gate.stderr);

    const old = spawn('bash', [PC_HEAVY, 'bash', '-c', ordinaryCommand(oldPidFile)], {
      env: baseEnv({
        ...shared,
        PC_HEAVY_ADMISSION_ID: 'ordinary-old',
        PC_HEAVY_MEM_PSI_SAMPLE_SEC: '1',
      }),
      cwd: dir,
      detached: true,
    });
    const oldErr = createTextCollector(old.stderr);
    let newer: ReturnType<typeof spawn> | undefined;
    try {
      await waitFor('the older ordinary root publishing its admission record', () =>
        existsSync(join(admissionDir, 'ordinary-old.state')) && admissionState('ordinary-old').includes('state=active'));
      await new Promise((resolve) => setTimeout(resolve, 50));

      newer = spawn('bash', [PC_HEAVY, 'bash', '-c', ordinaryCommand(newPidFile)], {
        env: baseEnv({
          ...shared,
          PC_HEAVY_ADMISSION_ID: 'ordinary-new',
          PC_HEAVY_MEM_PSI_SAMPLE_SEC: '0',
        }),
        cwd: dir,
        detached: true,
      });
      const newErr = createTextCollector(newer.stderr);
      await waitFor('the newer ordinary root publishing its admission record', () =>
        existsSync(join(admissionDir, 'ordinary-new.state')) && admissionState('ordinary-new').includes('state=active'));
      await waitFor('both isolated child identities being published', () =>
        existsSync(oldPidFile) && existsSync(newPidFile));
      const oldPid = Number(readFileSync(oldPidFile, 'utf8').trim());
      const newPid = Number(readFileSync(newPidFile, 'utf8').trim());

      // A stale record has a lower priority and a newer timestamp, so it wins
      // unless pid+start-tick validation removes it before election.
      writeFileSync(join(admissionDir, 'stale.state'), [
        'version=1',
        'admission_id=stale',
        'pid=99999999',
        'start_ticks=1',
        'priority=0',
        'admitted_at=999999999999999999',
        'state=active',
        'cgroup_path=/stale',
        'memory_current_mib=999',
        'retry_handle=psi-recovery:stale',
        'updated_at=1',
        '',
      ].join('\n'));

      writeFileSync(psiFile, '9\n');
      await waitFor('the deterministic newest ordinary root freezing', () =>
        admissionState('ordinary-new').includes('state=frozen'));
      expect(admissionState('ordinary-old')).toContain('state=active');
      expect(existsSync(join(admissionDir, 'stale.state'))).toBe(false);
      await waitFor('the chosen child process group reaching the stopped state', () =>
        ['T', 't'].includes(processState(newPid)));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(admissionState('ordinary-old')).toContain('state=active');
      expect(['T', 't']).not.toContain(processState(oldPid));

      // The gate completes while the one elected ordinary root remains stopped
      // and the episode latch prevents a cascade through the older peer. It
      // never publishes an admission record and cannot receive STOP.
      writeFileSync(gateRelease, 'go\n');
      await waitFor('the protected release gate completing', () => existsSync(gateDone));
      expect(gateErr.peek()).not.toContain('PC_HEAVY_ADMISSION');
      expect(readdirSync(admissionDir).some((name) => name.includes('release'))).toBe(false);

      // WI-1707579, one step further apart than the reported case: the wait above is on the
      // GATE's marker FILE, while this assertion reads the ordinary-new root's STDERR — two
      // different processes and two different channels, with no ordering guarantee between
      // them. The stream assertion needs its own wait on the stream it actually reads.
      const frozenNewLine =
        'PC_HEAVY_ADMISSION status=frozen reason=memory-psi-high priority=10 psiFullAvg10=9 admittedCgroupMiB=128 admissionId=ordinary-new retryHandle=psi-recovery:ordinary-new';
      await waitFor('the frozen admission line reaching the ordinary-new stderr', () =>
        newErr.peek().includes(frozenNewLine));
      expect(newErr.peek()).toContain(frozenNewLine);

      writeFileSync(psiFile, '0\n');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(admissionState('ordinary-old')).toContain('state=active');
      expect(admissionState('ordinary-new')).toContain('state=frozen');

      // Both roots share one cgroup in this fixture; the event's 128 MiB total
      // proves deduplication. The elected victim alone thaws after the window.
      await waitFor('the elected root thawing after the quiet window', () =>
        admissionState('ordinary-new').includes('state=active'));
      expect(Number(readFileSync(oldPidFile, 'utf8').trim())).toBe(oldPid);
      expect(Number(readFileSync(newPidFile, 'utf8').trim())).toBe(newPid);
      await waitFor('the elected root publishing its structured thaw event', () =>
        newErr.peek().includes('PC_HEAVY_ADMISSION status=thawed'));
      expect(newErr.peek()).toContain(
        'PC_HEAVY_ADMISSION status=thawed reason=memory-psi-recovered priority=10 psiFullAvg10=0 admittedCgroupMiB=128 admissionId=ordinary-new retryHandle=psi-recovery:ordinary-new',
      );
      expect(oldErr.peek()).not.toContain('PC_HEAVY_ADMISSION status=frozen');
    } finally {
      writeFileSync(psiFile, '0\n');
      killGroup(old);
      if (newer) killGroup(newer);
      killGroup(gate);
    }
  }, 30_000);

  it('terminates a frozen root after a bounded high-PSI lease when pressure never recovers', async () => {
    const psiFile = join(dir, 'psi-full-avg10-never-recovers');
    const admissionDir = join(dir, 'psi-admissions');
    writeFileSync(psiFile, '9\n');

    const holder = spawn(
      'bash',
      [
        PC_HEAVY,
        'bash',
        '-c',
        "trap 'exit 0' TERM INT HUP; while :; do sleep 0.05; done",
      ],
      {
        env: baseEnv({
          PC_HEAVY_SLOTS: '1',
          PC_HEAVY_COALESCE: '0',
          PC_HEAVY_GATE_RESERVE: '0',
          PC_HEAVY_ADMISSION_ID: 'permanent-high-psi',
          PC_HEAVY_MEM_PSI_OVERRIDE_FILE: psiFile,
          PC_HEAVY_MEM_PSI_SAMPLE_SEC: '0',
          PC_HEAVY_MEM_PSI_MAX_FREEZE_SEC: '1',
          PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
          PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '1',
          PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '128',
        }),
        cwd: dir,
        detached: true,
      },
    );
    const holderErr = createTextCollector(holder.stderr);
    const exited = new Promise<number>((resolve) => holder.on('exit', (code) => resolve(code ?? -1)));
    // WI-1707579, the subtlest form of the same cross-channel race. 'exit' fires when the
    // process goes away; 'close' fires only once its stdio streams have closed and FLUSHED.
    // The assertions below read the stderr COLLECTOR, so gating them on 'exit' waits on the
    // wrong channel — and `status=expired` is emitted immediately before exit, making it
    // precisely the line most likely to still be in flight when 'exit' lands.
    const closed = new Promise<void>((resolve) => holder.on('close', () => resolve()));
    try {
      await waitFor('the root entering the high-PSI frozen state', () =>
        holderErr.peek().includes('PC_HEAVY_ADMISSION status=frozen'),
      );
      await waitFor('the permanently pressured root terminating after its lease', () => holder.exitCode !== null, 8_000);

      expect(await exited).toBe(75);
      await closed;
      expect(holderErr.peek()).toContain(
        'PC_HEAVY_ADMISSION status=expired reason=memory-psi-high-timeout priority=10 psiFullAvg10=9 admittedCgroupMiB=128 admissionId=permanent-high-psi retryHandle=psi-recovery:permanent-high-psi',
      );
      expect(holderErr.peek()).toContain(
        'PC_HEAVY_RESULT status=undetermined reason=memory-psi-high-timeout exit=75',
      );
      expect(readdirSync(admissionDir).some((name) => name.includes('permanent-high-psi'))).toBe(false);
    } finally {
      writeFileSync(psiFile, '0\n');
      killGroup(holder);
    }
  }, 15_000);

  it('never elects a candidate whose own cgroup memory is negligible relative to the freeze floor (EI-21861205996181547)', async () => {
    // Reproduces the reported defect directly: global PSI is high (as it would
    // be while a resident non-admitted process such as postgres drives
    // pressure), but the only admitted candidate's own cgroup uses far less
    // than the default 64 MiB PC_HEAVY_MEM_PSI_MIN_VICTIM_MIB floor — matching
    // the filed 24 MiB symptom. Freezing it cannot relieve pressure it did not
    // cause, so it must stay active/unstopped for the whole observation window.
    const psiFile = join(dir, 'psi-full-avg10-below-floor');
    const admissionDir = join(dir, 'psi-admissions');
    const pidFile = join(dir, 'negligible-victim.pid');
    writeFileSync(psiFile, '9\n');

    const holder = spawn(
      'bash',
      [PC_HEAVY, 'bash', '-c', `echo $$ > "${pidFile}"; trap 'exit 0' TERM INT HUP; while :; do sleep 0.05; done`],
      {
        env: baseEnv({
          PC_HEAVY_SLOTS: '1',
          PC_HEAVY_COALESCE: '0',
          PC_HEAVY_GATE_RESERVE: '0',
          PC_HEAVY_ADMISSION_ID: 'negligible-victim',
          PC_HEAVY_MEM_PSI_OVERRIDE_FILE: psiFile,
          PC_HEAVY_MEM_PSI_SAMPLE_SEC: '0',
          PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
          // Below the default PC_HEAVY_MEM_PSI_MIN_VICTIM_MIB=64 on purpose —
          // the reported run measured 24 MiB.
          PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '24',
        }),
        cwd: dir,
        detached: true,
      },
    );
    const holderErr = createTextCollector(holder.stderr);
    try {
      await waitFor('the below-floor candidate publishing its active admission record', () =>
        existsSync(join(admissionDir, 'negligible-victim.state')) &&
          admissionState('negligible-victim').includes('state=active'));
      await waitFor('the isolated child identity being published', () => existsSync(pidFile));
      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      await waitFor('at least one PSI sample above backoff to be observed', () =>
        holderErr.peek().includes('psiFullAvg10=9') ||
          admissionState('negligible-victim').includes('memory_current_mib=24'));
      // Give the controller several sample intervals to (wrongly) elect and
      // freeze this candidate if the floor were not applied.
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(admissionState('negligible-victim')).toContain('state=active');
      expect(admissionState('negligible-victim')).toContain('memory_current_mib=24');
      expect(holderErr.peek()).not.toContain('PC_HEAVY_ADMISSION status=frozen');
      expect(['T', 't']).not.toContain(processState(childPid));
    } finally {
      writeFileSync(psiFile, '0\n');
      killGroup(holder);
    }
  }, 15_000);

  it('PC_HEAVY_MEM_PSI_MIN_VICTIM_MIB=0 restores the unconditional pre-fix election for the same negligible candidate', async () => {
    // Companion to the test above: proves the floor — not some unrelated
    // change — is what gated the freeze, and that the escape hatch documented
    // in the tunable's header comment actually works.
    const psiFile = join(dir, 'psi-full-avg10-floor-disabled');
    const admissionDir = join(dir, 'psi-admissions');
    const pidFile = join(dir, 'floor-disabled-victim.pid');
    writeFileSync(psiFile, '9\n');

    const holder = spawn(
      'bash',
      [PC_HEAVY, 'bash', '-c', `echo $$ > "${pidFile}"; trap 'exit 0' TERM INT HUP; while :; do sleep 0.05; done`],
      {
        env: baseEnv({
          PC_HEAVY_SLOTS: '1',
          PC_HEAVY_COALESCE: '0',
          PC_HEAVY_GATE_RESERVE: '0',
          PC_HEAVY_ADMISSION_ID: 'floor-disabled-victim',
          PC_HEAVY_MEM_PSI_OVERRIDE_FILE: psiFile,
          PC_HEAVY_MEM_PSI_SAMPLE_SEC: '0',
          PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
          PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '24',
          PC_HEAVY_MEM_PSI_MIN_VICTIM_MIB: '0',
        }),
        cwd: dir,
        detached: true,
      },
    );
    const holderErr = createTextCollector(holder.stderr);
    try {
      await waitFor('the isolated child identity being published', () => existsSync(pidFile));
      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      await waitFor('the floor-disabled candidate freezing under high PSI', () =>
        existsSync(join(admissionDir, 'floor-disabled-victim.state')) &&
          admissionState('floor-disabled-victim').includes('state=frozen'));
      // WI-1707579 — the reported case. The wait above is satisfied by pc-heavy's STATE FILE
      // write; this assertion reads the STDERR the child emitted. Two independent channels
      // with no ordering guarantee: on an idle box the stderr line has always landed by the
      // time the file appears, but under a loaded sweep the collector's drain is descheduled
      // and peek() still holds only the earlier `slot acquired` line. Keep the state-file wait
      // as the precondition, and give the stream assertion its own wait on the stream.
      const frozenVictimLine =
        'PC_HEAVY_ADMISSION status=frozen reason=memory-psi-high priority=10 psiFullAvg10=9 admittedCgroupMiB=24 admissionId=floor-disabled-victim retryHandle=psi-recovery:floor-disabled-victim';
      await waitFor('the frozen admission line reaching the holder stderr', () =>
        holderErr.peek().includes(frozenVictimLine));
      expect(holderErr.peek()).toContain(frozenVictimLine);
      await waitFor('the chosen process group reaching the stopped state', () =>
        ['T', 't'].includes(processState(childPid)));
    } finally {
      writeFileSync(psiFile, '0\n');
      killGroup(holder);
    }
  }, 15_000);

  it('protects a completed focused run while test-files finalizes its terminal evidence', async (ctx) => {
    const psiFile = join(dir, 'psi-full-avg10-finalization');
    const readyDir = join(dir, 'finalization-ready');
    const driver = join(dir, 'finalization-driver.mjs');
    writeFileSync(psiFile, '0\n');
    writeFileSync(driver, [
      `import { publishPreemptFinalizationMarker, runCapturedTestProcess } from ${JSON.stringify(pathToFileURL(resolve(ROOT, 'scripts/test-files.mjs')).href)};`,
      'const result = await runCapturedTestProcess(',
      '  process.execPath,',
      '  [\'-e\', \'process.stdout.write("✓ a.test.ts (1 test) 1ms\\\\n"); setTimeout(() => {}, 1500)\'],',
      '  {',
      '    cwd: process.cwd(),',
      '    env: process.env,',
      "    files: ['a.test.ts'],",
      "    cwdLabel: 'finalization-fixture',",
      '    setsidPath: null,',
      '    progressIntervalMs: 10,',
      '    onAllFilesComplete: () => publishPreemptFinalizationMarker(),',
      // This fixture is already inside the pc-heavy process under test. Bypass the
      // resource-governor admission bridge for the nested run so readiness measures
      // the finalization handoff, not a second live admission that can wait behind
      // unrelated fleet work and hold PgBouncer sockets open after the child exits.
      '    governedProcessImpl: async (options, run) => run(null, options.env, { inherited: true }),',
      '  },',
      ');',
      'process.stdout.write(JSON.stringify({ status: result.status, signal: result.signal, timedOut: result.timedOut }) + \'\\n\');',
      // Exit deterministically rather than falling off the end with `process.exitCode`.
      // Before the explicit governedProcessImpl seam above, this top-level fixture
      // performed a SECOND live resource-governor admission. That admission can wait
      // behind unrelated fleet work before the child exists, so the marker wait timed
      // out without exercising pc-heavy at all. It also left PgBouncer sockets open after
      // the child result. The real `test:file` CLI inherits an admission context and
      // skips that second admission; this fixture now models that production boundary.
      'process.exit(result.error || result.status !== 0 ? 1 : 0);',
    ].join('\n'));
    const env = baseEnv({
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_ADMISSION_ID: 'finalization-protection',
      PC_HEAVY_PREEMPTIBLE: '1',
      PC_HEAVY_PREEMPT_AFTER_READY: '1',
      PC_HEAVY_PREEMPT_READY_DIR: readyDir,
      PC_HEAVY_MEM_PSI_OVERRIDE_FILE: psiFile,
      PC_HEAVY_MEM_PSI_SAMPLE_SEC: '0',
      PC_HEAVY_PSI_FINALIZATION_MAX_SEC: '3',
      PC_HEAVY_MEM_PSI_MAX_FREEZE_SEC: '1',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '1',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '128',
    });
    const holder = spawn('bash', [PC_HEAVY, 'node', driver], {
      env, cwd: dir, detached: true,
    });
    const holderOut = createTextCollector(holder.stdout);
    const holderErr = createTextCollector(holder.stderr);
    const holderExit = new Promise<number>((res) => holder.on('exit', (c) => res(c ?? -1)));
    const finalizationMarkerPublished = (): boolean => {
      if (!existsSync(readyDir)) {
        if (holder.exitCode !== null || holder.signalCode !== null) {
          throw new Error(
            `test-files exited before publishing its finalization marker; ` +
              `stdout=${holderOut.text()} stderr=${holderErr.text()}`,
          );
        }
        return false;
      }
      return publishedMarkers(readyDir, 'finalization.').length > 0;
    };
    try {
      await waitFor('test-files publishing the finalization marker', finalizationMarkerPublished);
      writeFileSync(psiFile, '9\n');
      await untilStderr(
        holder,
        holderErr,
        (t) => t.includes('PSI finalization protection active'),
        'the PSI monitor observing the finalization handoff',
      );

      // Reaching the landmark above already proves the behaviour this test guards: the
      // monitor SAW the finalization marker and deferred the freeze. What remains is
      // whether the fixture then finishes inside the 3s protection budget — and that is
      // the one thing here still coupled to how loaded the box is.
      //
      // If the budget expires, pc-heavy says so explicitly and reports the run as
      // undetermined. Exiting as undetermined is then the honest verdict (D-014): the
      // guard behaved, the terminal outcome was simply not measurable on this host. It is
      // NOT a free pass — it requires the monitor to have engaged AND expired on the
      // record, so a regression where protection never engages still fails at the
      // untilStderr above, and one where it engages but never defers still fails below.
      const holderExitCode = await holderExit;
      const holderStderr = holderErr.text();
      if (
        holderExitCode !== 0 &&
        holderStderr.includes('PSI finalization protection expired') &&
        HOST_PRESSURE_UNDETERMINED.test(holderStderr)
      ) {
        ctx.skip(
          'UNDETERMINED, not failed: the finalization protection engaged and then expired ' +
            `after ${3}s before the fixture could finish, so pc-heavy reaped the group and ` +
            'reported status=undetermined. The deferral under test was observed; its terminal ' +
            `outcome was not measurable on this host. stderr: ${holderStderr}`,
        );
      }
      expect(holderExitCode).toBe(0);
      expect(holderOut.text()).toContain('"status":0');
      expect(holderErr.text()).not.toContain('status=frozen reason=memory-psi-high');
      expect(holderErr.text()).not.toContain('PSI finalization protection expired');
      expect(readdirSync(readyDir)).toEqual([]);
    } finally {
      writeFileSync(psiFile, '0\n');
      killGroup(holder);
    }
  }, 20_000);

  it('bounds a stalled finalization handoff and cleans its marker before freezing', async () => {
    const psiFile = join(dir, 'psi-full-avg10-finalization-expiry');
    const readyDir = join(dir, 'finalization-expiry-ready');
    const driver = join(dir, 'finalization-expiry-driver.mjs');
    writeFileSync(psiFile, '0\n');
    writeFileSync(driver, [
      `import { publishPreemptFinalizationMarker, runCapturedTestProcess } from ${JSON.stringify(pathToFileURL(resolve(ROOT, 'scripts/test-files.mjs')).href)};`,
      'const result = await runCapturedTestProcess(',
      '  process.execPath,',
      '  [\'-e\', \'process.stdout.write("✓ a.test.ts (1 test) 1ms\\\\n"); setTimeout(() => {}, 10000)\'],',
      '  {',
      '    cwd: process.cwd(),',
      '    env: process.env,',
      "    files: ['a.test.ts'],",
      "    cwdLabel: 'finalization-expiry-fixture',",
      '    setsidPath: null,',
      '    progressIntervalMs: 10,',
      '    onAllFilesComplete: () => publishPreemptFinalizationMarker(),',
      // Keep this companion fixture hermetic for the same reason as the protected
      // handoff case above: it exercises pc-heavy's bounded freeze path, not a
      // second resource-governor admission.
      '    governedProcessImpl: async (options, run) => run(null, options.env, { inherited: true }),',
      '  },',
      ');',
      'process.stdout.write(JSON.stringify({ status: result.status, signal: result.signal, timedOut: result.timedOut }) + \'\\n\');',
      'if (result.error || result.status !== 0) process.exitCode = 1;',
    ].join('\n'));
    const env = baseEnv({
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_ADMISSION_ID: 'finalization-expiry',
      PC_HEAVY_PREEMPTIBLE: '1',
      PC_HEAVY_PREEMPT_AFTER_READY: '1',
      PC_HEAVY_PREEMPT_READY_DIR: readyDir,
      PC_HEAVY_MEM_PSI_OVERRIDE_FILE: psiFile,
      PC_HEAVY_MEM_PSI_SAMPLE_SEC: '0',
      PC_HEAVY_PSI_FINALIZATION_MAX_SEC: '1',
      PC_HEAVY_MEM_PSI_MAX_FREEZE_SEC: '10',
      PC_HEAVY_PREEMPT_POLL_SEC: '0.05',
      PC_HEAVY_PREEMPT_TERM_GRACE_SEC: '1',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '128',
    });
    const holder = spawn('bash', [PC_HEAVY, 'node', driver], {
      env, cwd: dir, detached: true,
    });
    const holderOut = createTextCollector(holder.stdout);
    const holderErr = createTextCollector(holder.stderr);
    const holderExit = new Promise<number>((res) => holder.on('exit', (c) => res(c ?? -1)));
    const finalizationMarkerPublished = (): boolean => {
      if (!existsSync(readyDir)) {
        if (holder.exitCode !== null || holder.signalCode !== null) {
          throw new Error(
            `stalled test-files exited before publishing its finalization marker; ` +
              `stdout=${holderOut.text()} stderr=${holderErr.text()}`,
          );
        }
        return false;
      }
      return publishedMarkers(readyDir, 'finalization.').length > 0;
    };
    try {
      await waitFor('stalled test-files publishing the finalization marker', finalizationMarkerPublished);
      writeFileSync(psiFile, '9\n');
      await untilStderr(
        holder,
        holderErr,
        (t) => t.includes('PSI finalization protection active'),
        'the PSI monitor starting the bounded finalization handoff',
      );

      expect(await holderExit).toBe(75);
      expect(holderOut.text()).not.toContain('"status":0');
      expect(holderErr.text()).toContain('PSI finalization protection expired after 1s');
      expect(holderErr.text()).toContain('status=frozen reason=memory-psi-high');
      expect(readdirSync(readyDir)).toEqual([]);
    } finally {
      writeFileSync(psiFile, '0\n');
      killGroup(holder);
    }
  }, 35_000);

  // RECURRENCE GUARD for EI-21814172909778521 — the CLASS, not the instance. The two cases
  // above went intermittently red for weeks because their readiness predicate was a bare
  // prefix glob that accepted pc-heavy's own zero-byte allocation probe as the child's
  // published marker. Nothing but this test stops the next author relaxing it back.
  //
  // Hermetic and instant: it asserts on the discriminator itself, never on a spawn, so it
  // cannot inherit the load coupling it exists to prevent.
  it('does not mistake pc-heavy’s zero-byte marker allocation for a published marker', () => {
    const readyDir = join(dir, 'published-marker-discrimination');
    mkdirSync(readyDir, { recursive: true });

    // Exactly what `mktemp "$_preempt_ready_dir/finalization.XXXXXX"` leaves in the dir for
    // the ~2ms before pc-heavy `rm -f`s it. A prefix glob calls this "published".
    writeFileSync(join(readyDir, 'finalization.aBcDeF'), '');
    expect(publishedMarkers(readyDir, 'finalization.')).toEqual([]);

    // Exactly what publishPreemptMarker() writes when the child really finalizes.
    writeFileSync(join(readyDir, 'finalization.gHiJkL'), `${process.pid}\n`);
    expect(publishedMarkers(readyDir, 'finalization.')).toEqual(['finalization.gHiJkL']);

    // The prefix still discriminates — a published ready marker is not a finalization one.
    writeFileSync(join(readyDir, 'ready.mNoPqR'), `${process.pid}\n`);
    expect(publishedMarkers(readyDir, 'finalization.')).toEqual(['finalization.gHiJkL']);
    expect(publishedMarkers(readyDir, 'ready.')).toEqual(['ready.mNoPqR']);

    // THE PIN, RETARGETED (EI-22197976300039578). It used to read `mktemp
    // "$_preempt_ready_dir/…"` and asked the next author to come here if that idiom ever
    // changed, so that nuance which had quietly become dead could be retired. It changed,
    // and this is that visit — but the nuance is NOT dead, so the test stays and only its
    // pin moves.
    //
    // What changed: reserving the name by CREATING a file and then `rm -f`-ing it made the
    // allocation depend on a working `rm`. Under `mutation-probe.sh --fake-destructive`
    // (PATH shims that log and `exit 0`) the reservation survived, and the child's
    // O_CREAT|O_EXCL publish hit EEXIST on it — TEST_FILE_ROUTE_ERROR exit 75 with ZERO
    // tests measured. `mktemp -u` reserves the name without creating anything, so that
    // ~2ms transient no longer exists at all.
    //
    // Why the discrimination is still load-bearing anyway: the transient was the most
    // COMMON zero-byte marker, never the only one. publishPreemptMarker() still creates
    // with O_CREAT|O_EXCL and writes the pid immediately after, so a publisher killed
    // between those two syscalls still leaves a zero-length file with no pid recorded —
    // exactly the shape a bare prefix glob would call "published" (preempt-markers.mjs
    // reasons about the same window for EMPTY_MARKER_DEBRIS_MS). The first two assertions
    // above are what protect that; they need no revision.
    //
    // Pinning `-u` is also strictly stronger than what it replaces: a revert to the
    // create-then-remove idiom now fails HERE as well as in the allocation guard above.
    const source = readFileSync(PC_HEAVY, 'utf8');
    expect(source).toContain('mktemp -u "$_preempt_ready_dir/finalization.XXXXXX"');
    expect(source).toContain('mktemp -u "$_preempt_ready_dir/ready.XXXXXX"');
  });
});

describe('pc-heavy.sh — finite-cgroup typecheck admission (EI-21206772578500745)', () => {
  const typecheckFixture = (): string => {
    const file = join(dir, 'lint-tsc-fixture.mjs');
    writeFileSync(file, 'process.stdout.write("typecheck-ran")');
    return file;
  };

  it('re-runs in a detached user scope when heap + wrapper overhead cannot fit the caller cgroup', () => {
    const marker = typecheckFixture();
    const runner = join(dir, 'systemd-run-stub');
    writeFileSync(runner, `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  case "$1" in
    --user|--scope|--collect) shift ;;
    *) break ;;
  esac
done
if [ "\${1:-}" = "env" ]; then
  shift
  while [ "\${1:-}" = "-u" ]; do shift 2; done
fi
PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE=12288 \\
PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE=0 \\
"$@"
`);
    chmodSync(runner, 0o755);
    const r = runSync(['node', marker], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '6144',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '768',
      PAPERCUSP_TSC_HEAP_MB: '8192',
      PC_HEAVY_SYSTEMD_RUN_BIN: runner,
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('typecheck-ran');
    expect(r.stderr).toContain('detached user scope');
    expect(r.stderr).not.toContain('REFUSED typecheck');
  });

  // EI-22078599999230726 — the guard above is only as strong as its stub, and the stub
  // is SYNCHRONOUS by construction: it ends in `"$@"`, so it always waits, always
  // propagates the child's status, and can only ever exercise the happy path. A runner
  // that returns once the SCOPE has STARTED (rather than once the CHILD has EXITED) was
  // reported in the field and reproduced here: pc-heavy returned 0 in ~200ms with no
  // LINT_TSC_RESULT line while the compile ran on for seconds afterwards — a false green,
  // because exit 0 with no verdict is indistinguishable from exit 0 with a clean one.
  //
  // This is the stub that violates the assumption, and it is the reason the fix is
  // falsifiable: it fails against a pc-heavy that trusts the runner's exit code.
  it('reports undetermined, not success, when the scope runner returns before its child finishes', () => {
    const done = join(dir, 'early-return-child-completed');
    const marker = join(dir, 'lint-tsc-slow-fixture.mjs');
    writeFileSync(
      marker,
      `import { writeFileSync } from 'node:fs';\n` +
        `setTimeout(() => { writeFileSync(${JSON.stringify(done)}, 'done'); process.stdout.write('typecheck-ran'); }, 3000);\n`,
    );
    const runner = join(dir, 'systemd-run-early-return-stub');
    writeFileSync(runner, `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  case "$1" in
    --user|--scope|--collect) shift ;;
    *) break ;;
  esac
done
if [ "\${1:-}" = "env" ]; then
  shift
  while [ "\${1:-}" = "-u" ]; do shift 2; done
fi
PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE=12288 \\
PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE=0 \\
"$@" &
exit 0
`);
    chmodSync(runner, 0o755);

    const r = runSync(['node', marker], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '6144',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '768',
      PAPERCUSP_TSC_HEAP_MB: '8192',
      PC_HEAVY_SYSTEMD_RUN_BIN: runner,
    });

    // It still took the detached-scope branch — this is not the REFUSED path.
    expect(r.stderr).toContain('detached user scope');
    expect(r.stderr).not.toContain('REFUSED typecheck');
    // ...but the child had not finished, so there is no verdict, and a verdict-less run
    // must never read as a clean one. 75 is the established EX_TEMPFAIL/undetermined class.
    expect(r.status).toBe(75);
    expect(r.stderr).toContain('UNDETERMINED typecheck');
    expect(r.stderr).toContain(
      'PC_HEAVY_RESULT status=undetermined reason=detached-scope-child-incomplete exit=75',
    );
    // Deliberately NOT asserted here: that the child is still unfinished when pc-heavy
    // returns. It is true of pc-heavy (measured: it returns in ~200ms while the child needs
    // 3000ms) but it is NOT observable through this harness — runSync is spawnSync, which
    // waits for the inherited stdout pipe to close, and the backgrounded grandchild holds
    // that pipe for its whole lifetime. So `done` DOES exist and 'typecheck-ran' DOES reach
    // r.stdout by the time these assertions run, ~3s after pc-heavy already exited 75.
    // Asserting otherwise fails for a reason that has nothing to do with the behaviour under
    // test. The contract is the verdict above — pc-heavy must not report success when it
    // cannot prove the child finished — and that is fully covered without timing luck.
  });

  it('recognizes tsc-baseline-gate\'s stable lint:tsc sentinel inside sh -c argv', () => {
    const marker = typecheckFixture();
    const runner = join(dir, 'systemd-run-sentinel-stub');
    writeFileSync(runner, `#!/usr/bin/env bash
while [ "$#" -gt 0 ]; do
  case "$1" in
    --user|--scope|--collect) shift ;;
    *) break ;;
  esac
done
if [ "\${1:-}" = "env" ]; then
  shift
  while [ "\${1:-}" = "-u" ]; do shift 2; done
fi
PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE=12288 \\
PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE=0 \\
"$@"
`);
    chmodSync(runner, 0o755);
    const r = runSync(
      ['sh', '-c', `node ${JSON.stringify(marker)}`, 'lint:tsc', '--files=__pc_heavy_scoped__'],
      {
        PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '6144',
        PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '768',
        PAPERCUSP_TSC_HEAP_MB: '8192',
        PC_HEAVY_SYSTEMD_RUN_BIN: runner,
      },
    );

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('typecheck-ran');
    expect(r.stderr).toContain('detached user scope');
    expect(r.stderr).not.toContain('REFUSED typecheck');
  });

  it('refuses without recursion when detached scope re-exec is already active', () => {
    const marker = typecheckFixture();
    const slots = join(dir, 'never-created-by-refused-typecheck');
    const r = runSync(['node', marker], {
      PC_HEAVY_DIR: slots,
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '6144',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '768',
      PAPERCUSP_TSC_HEAP_MB: '8192',
      PC_HEAVY_CGROUP_REEXEC: '1',
    });

    expect(r.status).toBe(75);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('REFUSED typecheck');
    expect(r.stderr).toContain('5376 MiB headroom');
    expect(r.stderr).toContain('9216 MiB compiler floor');
    expect(r.stderr).toContain('capability:inspect');
    expect(r.stderr).toContain('package: "packages/<workspace>"');
    expect(r.stderr).toContain('repository-relative directory path (not an npm package name)');
    expect(existsSync(slots)).toBe(false); // refused before coalescing/slot acquisition
  });

  // WI-10005296 (D-031): the hosted profile's PC_HEAVY_TYPECHECK_GUARD=0 turns the dev-tower guard
  // off. The SAME inputs that refuse above must then neither refuse nor re-exec into a scope (that
  // would escape a customer agent's cgroup memory limit): the typecheck runs under admission.
  it('PC_HEAVY_TYPECHECK_GUARD=0 runs the typecheck in place: no refusal, no detached scope', () => {
    const runner = join(dir, 'systemd-run-must-not-run');
    writeFileSync(runner, `#!/usr/bin/env bash\necho scope-runner-invoked >> ${JSON.stringify(join(dir, 'runner.log'))}\nexit 99\n`);
    chmodSync(runner, 0o755);
    const r = runSync(['node', typecheckFixture()], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '6144',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '768',
      PAPERCUSP_TSC_HEAP_MB: '8192',
      PC_HEAVY_SYSTEMD_RUN_BIN: runner,
      PC_HEAVY_TYPECHECK_GUARD: '0',
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('typecheck-ran');
    expect(r.stderr).not.toContain('REFUSED typecheck');
    expect(r.stderr).not.toContain('detached user scope');
    expect(existsSync(join(dir, 'runner.log'))).toBe(false);
  });

  it('runs the same typecheck when a finite cgroup has enough headroom', () => {
    const r = runSync(['node', typecheckFixture()], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '12288',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '1024',
      PAPERCUSP_TSC_HEAP_MB: '8192',
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('typecheck-ran');
    expect(r.stderr).not.toContain('REFUSED typecheck');
  });

  it('fails open for an unlimited envelope and does not block a non-typecheck in a small cgroup', () => {
    const unlimited = runSync(['node', typecheckFixture()], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '999999',
    });
    expect(unlimited.status).toBe(0);
    expect(unlimited.stdout).toBe('typecheck-ran');

    const light = runSync(['bash', '-c', 'printf light-ran'], {
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '1024',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '1000',
    });
    expect(light.status).toBe(0);
    expect(light.stdout).toBe('light-ran');
  });

  it('keeps the release-gate bypass authoritative even in a small finite cgroup', () => {
    const slots = join(dir, 'release-never-creates-slots');
    const r = runSync(['node', typecheckFixture()], {
      PC_HEAVY_RELEASE_GATE: '1',
      PC_HEAVY_DIR: slots,
      PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: '2048',
      PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '1024',
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('typecheck-ran');
    expect(r.stderr).not.toContain('REFUSED typecheck');
    expect(existsSync(slots)).toBe(false);
  });
});

describe('pc-heavy.sh — coalescing (EI-18685262961418231)', () => {
  it('collapses N genuinely-concurrent IDENTICAL invocations into far fewer real runs, replaying the rest', async () => {
    // A burst of agents all running the exact same command (same cwd+argv) —
    // e.g. many agents confirming the same gate at once — should not each pay
    // for their own full run. One (or a small handful, bounded by the
    // unavoidable startup race before any lock file exists yet) becomes the
    // leader and actually executes; the rest replay its captured output.
    const marker = join(dir, 'runs.marker');
    const n = 6;
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
          const p = spawn(
            'bash',
            [PC_HEAVY, 'bash', '-c', `printf x >> "${marker}"; sleep 0.4; echo same-output`],
            { env: baseEnv({ PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE_SEC: '30' }), cwd: dir },
          );
          let stdout = '';
          let stderr = '';
          p.stdout.on('data', (d) => (stdout += d));
          p.stderr.on('data', (d) => (stderr += d));
          p.on('exit', (status) => res({ status, stdout, stderr }));
        }),
      ),
    );
    // Every caller still sees correct output and a success exit code.
    for (const r of results) {
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('same-output');
    }
    // At least most callers coalesced onto a shared result rather than each
    // spawning their own run.
    const realRuns = readFileSync(marker, 'utf8').length;
    expect(realRuns).toBeLessThan(n);
    const coalescedCount = results.filter((r) => r.stderr.includes('coalesced:')).length;
    expect(coalescedCount).toBeGreaterThan(0);
  });

  it('collapses to EXACTLY ONE real run even when the command is SLOWER than the coalescing window (EI-19343301596011451)', async () => {
    // The regression this exists for. `_coalesce_ttl` used to serve two
    // different questions: "may I replay a FINISHED result?" and "is the leader
    // still WORKING?". A follower therefore gave up waiting after the window
    // and ran the command itself, and a LIVE leader's lock was reclaimed as
    // 'abandoned' purely for outliving it. So for any command slower than the
    // window, coalescing INVERTED: every follower launched a duplicate, and the
    // heavier the command the more reliably it happened. Observed live as five
    // concurrent `tsc -p packages/operator-core` compiles (~180s each) queued
    // against the 90s default, with none of them running.
    //
    // The sibling test above cannot catch this: it pairs a 0.4s command with a
    // 30s window, so the command is ~75x FASTER than the window and no follower
    // ever reaches the deadline. Its `realRuns < n` assertion would also still
    // pass at 5-of-6 duplicated. This test inverts both: the command outlives
    // the window, and the expectation is exact.
    //
    // What the test needs is the RATIO (command > window), not the absolute duration —
    // and the whole test costs the command's runtime, since nothing can finish before
    // the leader does. 3s against a 2s window keeps a 1.5x margin in the only direction
    // that can break it: a leader finishing FASTER than the window would make this
    // vacuous, and a slower one only strengthens it.
    const marker = join(dir, 'slow-runs.marker');
    const n = 5;
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        new Promise<{ status: number | null; stderr: string }>((res) => {
          const p = spawn(
            'bash',
            [PC_HEAVY, 'bash', '-c', `printf x >> "${marker}"; sleep 3; echo slow-done`],
            { env: baseEnv({ PC_HEAVY_SLOTS: '8', PC_HEAVY_COALESCE_SEC: '2' }), cwd: dir },
          );
          let stderr = '';
          p.stderr.on('data', (d) => (stderr += d));
          p.on('exit', (status) => res({ status, stderr }));
        }),
      ),
    );

    for (const r of results) expect(r.status).toBe(0);
    // EXACTLY one — not "fewer than n". Pre-fix this read 5.
    expect(readFileSync(marker, 'utf8').length).toBe(1);
    // ...and every other caller got there by replaying, not by racing.
    expect(results.filter((r) => r.stderr.includes('coalesced:')).length).toBe(n - 1);
  }, 60_000);

  it('WI-40946: capture tees cannot retain a heavy slot after their wrapper dies', async () => {
    // A command descendant can legitimately keep stdout/stderr open after the
    // command leader exits. That keeps pc-heavy's capture tees alive, but it
    // must NOT keep the heavy slot alive through a descriptor the passive
    // capture process inherited. The descendant below closes its own slot
    // descriptor first, then deliberately holds only the output pipes.
    // We kill ONLY the wrapper and positively prove its tee children survived;
    // pre-fix those orphaned tees alone kept slot.0 flocked. The live incident
    // left the same process class behind for 32–45 minutes after final artifacts.
    const lingerPidFile = join(dir, 'pipe-keeper.pid');
    const command = [
      '  for fd_path in /proc/self/fd/*; do',
      '    target=$(readlink "$fd_path" 2>/dev/null || true)',
      '    case "$target" in',
      '      "$PC_HEAVY_DIR"/slot.*)',
      '        fd_num=${fd_path##*/}',
      '        eval "exec ${fd_num}>&-"',
      '        ;;',
      '    esac',
      '  done',
      `  printf '%s\\n' "$BASHPID" > "${lingerPidFile}"`,
      '  exec sleep 20',
    ].join('\n');

    const wrapper = spawn('bash', [PC_HEAVY, 'bash', '-c', command], {
      env: baseEnv({ PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE_SEC: '30' }),
      cwd: dir,
    });
    const wrapperErr = createTextCollector(wrapper.stderr);
    let lingerPid = 0;
    let teePids: number[] = [];
    const captureTeePids = (): number[] => {
      const coalesceDir = join(dir, 'coalesce');
      if (!existsSync(coalesceDir)) return [];
      const fifoFiles = readdirSync(coalesceDir)
        .filter((name) => name.endsWith('.pipe'))
        .map((name) => join(coalesceDir, name));
      const pids = new Set<number>();
      for (const fifoFile of fifoFiles) {
        const probe = spawnSync('fuser', [fifoFile], { encoding: 'utf8' });
        for (const token of probe.stdout.match(/\d+/g) ?? []) {
          const pid = Number(token);
          if (!Number.isSafeInteger(pid) || pid <= 1) continue;
          try {
            if (readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'tee') pids.add(pid);
          } catch { /* process exited between fuser and /proc */ }
        }
      }
      return [...pids];
    };
    try {
      await untilStderr(
        wrapper,
        wrapperErr,
        (text) => text.includes('[pc-heavy] slot acquired — starting real work'),
        'the wrapper acquiring slot.0',
      );
      await waitFor('the pipe-keeping real child starts', () => existsSync(lingerPidFile));
      lingerPid = Number(readFileSync(lingerPidFile, 'utf8').trim());
      expect(Number.isSafeInteger(lingerPid) && lingerPid > 1).toBe(true);
      expect(() => process.kill(lingerPid, 0)).not.toThrow(); // positive control: the pipe keeper is still live

      // KEEP the observation that satisfied the wait — do not take a second one. captureTeePids()
      // is a fresh measurement every call (a `fuser` spawn per FIFO plus a /proc/<pid>/comm read),
      // and it can legitimately UNDER-report: a spawn that fails under load yields no stdout and
      // contributes zero pids, and the /proc read races an exiting pid. So `waitFor` could observe
      // exactly 2 and the very next re-sample return 1 — which is the WI-40946 gate red, where the
      // wait passed and `toHaveLength(2)` then received `[ 2234949 ]`. Sampling inside the
      // predicate also makes a transient under-read self-healing: it just polls again.
      await waitFor('both capture tee children exist', () => {
        const observed = captureTeePids();
        if (observed.length !== 2) return false;
        teePids = observed;
        return true;
      });
      expect(teePids).toHaveLength(2);

      // Kill the wrapper PID only. Its real child has already closed its slot fd
      // but keeps both capture pipes open, so the recorded tees survive and
      // isolate their own inherited fd set.
      wrapper.kill('SIGKILL');
      await waitFor('the wrapper exits', () => wrapper.exitCode !== null || wrapper.signalCode !== null);
      expect(teePids.some((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      })).toBe(true); // positive control: a capture tee really outlived the wrapper
      expect(heldSlotCount(dir, 1)).toBe(0);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
      if (lingerPid > 1) {
        try { process.kill(lingerPid, 'SIGKILL'); } catch { /* already exited */ }
      }
      for (const pid of teePids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  }, 20_000);

  it('does not let a daemon-held capture descriptor wedge a filtered pipeline after the command exits', async () => {
    // The daemon redirects stdio like dbus-daemon does, but inherits the
    // wrapper's extra capture descriptors. The command PID exits and writes a
    // complete result; the outer grep must still receive EOF immediately.
    const daemonPidFile = join(dir, 'daemon.pid');
    const command = [
      'sleep 20 >/dev/null 2>&1 &',
      `printf '%s\\n' "$!" > "${daemonPidFile}"`,
      'echo daemon-started',
    ].join('\n');
    const pipeline = spawn(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `${PC_HEAVY} bash -c "$PC_HEAVY_TEST_COMMAND" 2>&1 | grep --line-buffered daemon-started >&2`,
      ],
      {
        env: baseEnv({
          PC_HEAVY_SLOTS: '1',
          PC_HEAVY_COALESCE_SEC: '30',
          PC_HEAVY_TEST_COMMAND: command,
        }),
        cwd: dir,
        detached: true,
      },
    );
    const seen = createTextCollector(pipeline.stderr);
    try {
      await untilStderr(pipeline, seen, (text) => text.includes('daemon-started'), 'the filtered command output');
      await waitFor('the filtered pipeline to reach EOF', () => pipeline.exitCode !== null || pipeline.signalCode !== null, 5_000);
      expect(pipeline.exitCode, seen.text()).toBe(0);
      expect(seen.text()).toContain('daemon-started');
    } finally {
      killGroup(pipeline);
      if (existsSync(daemonPidFile)) {
        const daemonPid = Number(readFileSync(daemonPidFile, 'utf8').trim());
        if (Number.isSafeInteger(daemonPid) && daemonPid > 1) {
          try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }
  }, 20_000);

  it('reclaims a lock whose leader DIED even though the stamped pid was recycled by a live process (EI-19343301596011451)', async () => {
    // Leader liveness is observed via pid, and PID wrap is ~daily on this box
    // under fleet load — so pid alone would let an unrelated live process
    // impersonate a dead leader and stall every follower for the full
    // max-wait. The stamp therefore carries the pid's start-time too, and a
    // mismatch reads as dead.
    const marker = join(dir, 'reuse-runs.marker');
    // Seed a lock for the key this exact command will hash to, by letting one
    // real (fast) run create and release it, then re-planting it corrupted.
    const cmd = ['bash', '-c', `printf y >> "${marker}"; echo reuse-probe`];
    const runProbe = () =>
      new Promise<{
        status: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn('bash', [PC_HEAVY, ...cmd], {
          env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '1' }),
          cwd: dir,
        });
        const stdout = createTextCollector(child.stdout);
        const stderr = createTextCollector(child.stderr);
        child.once('error', reject);
        child.once('close', (status, signal) => {
          resolve({ status, signal, stdout: stdout.text(), stderr: stderr.text() });
        });
      });

    const first = await runProbe();
    expect(
      first.status,
      `seed coalescing probe exited via ${first.signal ?? 'no signal'}; stderr: ${first.stderr}`,
    ).toBe(0);
    expect(first.stdout).toContain('reuse-probe');

    const coalesceDir = join(dir, 'coalesce');
    const key = readdirSync(coalesceDir).find((f) => f.endsWith('.exit'))?.replace(/\.exit$/, '');
    expect(key).toBeTruthy();

    // Expire the cached result so the next call cannot simply replay it, then
    // plant a lock stamped with a LIVE pid (this test process) but a start-time
    // that cannot be ours.
    rmSync(join(coalesceDir, `${key}.exit`), { force: true });
    const lockDir = join(coalesceDir, `${key}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'pid'), `${process.pid} 999999999\n`);

    // Must reclaim and run rather than wait out PC_HEAVY_COALESCE_MAX_WAIT_SEC.
    const second = await runProbe();
    expect(
      second.status,
      `recycled-pid coalescing probe exited via ${second.signal ?? 'no signal'}; stderr: ${second.stderr}`,
    ).toBe(0);
    expect(second.stdout).toContain('reuse-probe');
    expect(readFileSync(marker, 'utf8').length).toBe(2);
  }, 60_000);

  it('a later (non-concurrent) identical call within the window reuses the cached result, including stderr + exit code', () => {
    const command = 'echo out-x; echo err-x >&2; exit 4';
    const first = runSync(['bash', '-c', command], {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE_SEC: '30',
    });
    expect(first.status).toBe(4);
    expect(first.stderr).not.toContain('coalesced:');

    const second = runSync(['bash', '-c', command], {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE_SEC: '30',
    });
    expect(second.status).toBe(4);
    expect(second.stdout.trim()).toBe('out-x');
    expect(second.stderr).toContain('err-x');
    expect(second.stderr).toContain('coalesced:');
    expect(second.stderr.trimEnd()).toMatch(
      /\[pc-heavy\] PC_HEAVY_RESULT status=replayed reason=coalesced ageSec=\d+ exit=4$/,
    );

    // A tail-based gate merges both streams and intentionally discards the
    // beginning. The replay provenance must remain the terminal line without
    // contaminating stdout for callers that keep the streams separate.
    const tailed = spawnSync(
      'bash',
      ['-c', 'bash "$1" bash -c "$2" 2>&1 | tail -n 1', 'probe', PC_HEAVY, command],
      {
        encoding: 'utf8',
        env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }),
        cwd: dir,
        timeout: 30_000,
      },
    );
    expect(tailed.status).toBe(0);
    expect(tailed.stdout.trim()).toMatch(
      /^\[pc-heavy\] PC_HEAVY_RESULT status=replayed reason=coalesced ageSec=\d+ exit=4$/,
    );
  });

  it('does NOT coalesce different commands (different argv → different key)', () => {
    const a = runSync(['bash', '-c', 'echo aaa'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
    const b = runSync(['bash', '-c', 'echo bbb'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
    expect(a.stdout.trim()).toBe('aaa');
    expect(b.stdout.trim()).toBe('bbb');
    expect(b.stderr).not.toContain('coalesced:');
  });

  it('PC_HEAVY_COALESCE=0 disables coalescing entirely — every call is a real run', () => {
    const first = runSync(['bash', '-c', 'echo same; exit 0'], {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE: '0',
    });
    const second = runSync(['bash', '-c', 'echo same; exit 0'], {
      PC_HEAVY_SLOTS: '2',
      PC_HEAVY_COALESCE: '0',
    });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain('coalesced:');
    // No coalesce cache dir should even be created when disabled.
    expect(existsSync(join(dir, 'coalesce'))).toBe(false);
  });

  it('reclaims an ABANDONED lock (leader killed before writing a result) instead of making a follower wait out the whole window', async () => {
    // A plain mkdir lock (unlike the flock slots) has no kernel-level
    // auto-release — a SIGKILL'd leader (never trappable) would otherwise
    // strand the lock forever, taxing every future identical call with a
    // full wait before it gives up. Same command text for the "leader" and
    // the follow-up so they share a coalescing key; both are long-running
    // (sleep 30) so we can observe the LOCK being reclaimed (via `spawn` +
    // polling its mtime) without blocking the test on the full 30s.
    const cmd = 'sleep 30; echo never';
    const coalesceDir = join(dir, 'coalesce');
    const lockMtime = () => {
      let names: string[] = [];
      try { names = readdirSync(coalesceDir); } catch { return null; }
      const f = names.find((n) => n.endsWith('.lock'));
      return f ? statSync(join(coalesceDir, f)).mtimeMs : null;
    };

    const leader = spawn('bash', [PC_HEAVY, 'bash', '-c', cmd], {
      env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '2' }),
      cwd: dir,
      detached: true,
    });
    // Wait for the lock to actually EXIST rather than betting 400ms on it: too short and
    // the kill lands before there is anything to strand (the test then proves nothing);
    // long enough to be safe under load and every run pays the slack.
    await waitFor('leader claims the coalescing lock', () => lockMtime() !== null);
    process.kill(-(leader.pid as number), 'SIGKILL'); // hard-kill: no trap/cleanup runs
    const staleMtime = lockMtime();
    expect(staleMtime).not.toBeNull();

    await new Promise((r) => setTimeout(r, 2300)); // past the 2s coalescing window — lock now stale

    const follower = spawn('bash', [PC_HEAVY, 'bash', '-c', cmd], {
      // A follower that does NOT reclaim waits PC_HEAVY_COALESCE_MAX_WAIT_SEC
      // before recreating anything. Pin it far above the poll budget below so
      // that budget stays discriminating whatever the script's default becomes.
      env: baseEnv({ PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '2', PC_HEAVY_COALESCE_MAX_WAIT_SEC: '600' }),
      cwd: dir,
      detached: true,
    });
    try {
      // Poll for the lock to be RECREATED (a fresh mtime) — proving the stale
      // lock was reclaimed promptly, not waited-out for the full window (which
      // would itself eventually also just run uncached, but only after paying
      // the whole max wait). The budget covers bash startup plus pc-heavy's
      // pre-coalesce work (tree token, key hash), which a loaded gate box
      // stretched past a 1.5s budget.
      const t0 = Date.now();
      let reclaimed = false;
      while (Date.now() - t0 < 10_000) {
        const mt = lockMtime();
        if (mt !== null && mt > (staleMtime as number)) { reclaimed = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(reclaimed).toBe(true);
    } finally {
      process.kill(-(follower.pid as number), 'SIGKILL'); // cleanup, don't let it run 30s
    }
  });

  // Regression suite for EI-18688348461605365: cwd+argv alone is a STALE key
  // whenever the SOURCE the command exercises changed between two identical
  // invocations (edit, then re-run to check) — the coalescer replayed a
  // pre-edit result as if it were fresh. The fix folds a cheap tree-state
  // token (referenced-file mtime+size, plus git-status hashes for the current
  // worktree and recursive submodules) into the key so edits bust the cache
  // while a genuine no-op re-run still coalesces.
  describe('tree-state token busts the cache on a real edit (EI-18688348461605365)', () => {
    // The worktree is a SUBDIR of `dir`, never `dir` itself — see runSync's note
    // (EI-19424611266793426): PC_HEAVY_DIR is `dir`, so initing `dir` would put
    // pc-heavy's own coalesce artifacts inside the tree it probes and no run could
    // ever coalesce. Real usage always keeps the cache outside the repo.
    const gitRepo = () => {
      const repo = join(dir, 'repo');
      mkdirSync(repo, { recursive: true });
      execSync('git init -q', { cwd: repo });
      execSync('git config user.email t@example.com && git config user.name test', { cwd: repo });
      return repo;
    };
    const commitAll = (repo: string) => execSync('git add -A && git commit -q -m init', { cwd: repo });

    it('a referenced file argument changing between runs busts the cache — even OUTSIDE the git tree (the exact reported repro: a /tmp script)', () => {
      // The script path must be its own argv TOKEN (not embedded inside a
      // `-c '...'` shell string) — the fix stats each literal argv token
      // that resolves to an existing file, matching how a real caller
      // invokes e.g. `npx tsx /tmp/genfix.mts` (the reported repro).
      const script = join(dir, 'genfix.mts');
      writeFileSync(script, 'console.log("version-one")');
      const first = runSync(['cat', script], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
      expect(first.stderr).not.toContain('coalesced:');
      expect(first.stdout).toContain('version-one');

      // Edit the referenced file — deliberately a different LENGTH so the
      // size component of the token changes even if the filesystem's mtime
      // resolution is coarse enough to collide within the same test.
      writeFileSync(script, 'console.log("version-two-longer")');
      const second = runSync(['cat', script], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
      expect(second.stderr).not.toContain('coalesced:'); // must NOT replay the stale version-one result
      expect(second.stdout).toContain('version-two-longer');
    });

    it('a same-length edit in a non-Git export busts the cache when the source is only in cwd', () => {
      const exportDir = join(dir, 'historical-export');
      mkdirSync(exportDir, { recursive: true });
      const source = join(exportDir, 'src.txt');
      writeFileSync(source, 'v1');

      // This mirrors the historical-export typecheck shape: the command only
      // names a shell string, so no source file appears as a literal argv
      // token, and there is no Git HEAD for the old key to distinguish.
      const first = runSync(
        ['bash', '-c', 'cat src.txt'],
        { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' },
        exportDir,
      );
      expect(first.stderr).not.toContain('coalesced:');
      expect(first.stdout).toBe('v1');

      // Keep the byte length identical so mtime/size proxies cannot make this
      // pass accidentally. The fallback must hash file contents.
      writeFileSync(source, 'v2');
      const second = runSync(
        ['bash', '-c', 'cat src.txt'],
        { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' },
        exportDir,
      );
      expect(second.stderr).not.toContain('coalesced:');
      expect(second.stdout).toBe('v2');
    });

    it('a git-tracked source file changing between runs busts the cache, even when the command does not name it directly', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.txt'), 'v1');
      commitAll(repo);

      const first = runSync(['bash', '-c', 'echo build-output'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stderr).not.toContain('coalesced:');

      // Simulate "I edited the source this build/test exercises" — e.g. the
      // `npm run test:affected` shape, where the changed file is nowhere in
      // argv but IS what makes the previous output stale.
      writeFileSync(join(repo, 'src.txt'), 'v2 - modified');

      const second = runSync(['bash', '-c', 'echo build-output'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:'); // busted, not a stale replay
    });

    it('a second edit to an already-dirty tracked file busts the cache even though git status is unchanged', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.txt'), 'committed');
      commitAll(repo);
      writeFileSync(join(repo, 'src.txt'), 'dirty-version-one');

      const first = runSync(['bash', '-c', 'cat src.txt'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stdout).toContain('dirty-version-one');
      writeFileSync(join(repo, 'src.txt'), 'dirty-version-two');

      const second = runSync(['bash', '-c', 'cat src.txt'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:');
      expect(second.stdout).toContain('dirty-version-two');
    });

    it('a second edit to an already-dirty tracked submodule file busts the cache', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'superproject.txt'), 'seed');
      commitAll(repo);

      const submoduleRepo = join(dir, 'submodule-source');
      mkdirSync(submoduleRepo, { recursive: true });
      execSync('git init -q', { cwd: submoduleRepo });
      execSync('git config user.email t@example.com && git config user.name test', { cwd: submoduleRepo });
      writeFileSync(join(submoduleRepo, 'src.txt'), 'committed');
      commitAll(submoduleRepo);
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleRepo, 'nested-source'], {
        cwd: repo,
        stdio: 'ignore',
      });
      commitAll(repo);

      const source = join(repo, 'nested-source', 'src.txt');
      writeFileSync(source, 'dirty-version-one');
      const args = ['bash', '-c', 'cat nested-source/src.txt'];
      const first = runSync(args, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stderr).not.toContain('coalesced:');
      expect(first.stdout).toContain('dirty-version-one');

      // Keep the submodule's parent-visible dirty marker identical; only the
      // content of an already-dirty tracked source file changes.
      writeFileSync(source, 'dirty-version-two');
      const second = runSync(args, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:');
      expect(second.stdout).toContain('dirty-version-two');
    });

    // EI-19424611266793426. The token used `--untracked-files=no`, so CREATING a file
    // did not move it. That gap is inverted against the error class agents re-run this
    // command to fix: a missing-module / missing-declaration error (TS7016, TS2307) is
    // fixed BY CREATING A FILE, so the token was blind to exactly the mutation that
    // flips the verdict, and the stale red replayed for the whole window — looking
    // byte-identical to a real one.
    it('a NEWLY CREATED untracked file busts the cache — the fix for a missing-declaration error is a new file, which -uno could not see', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.ts'), 'import "./dep.mjs";');
      commitAll(repo);

      const first = runSync(['bash', '-c', 'echo typecheck-verdict'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stderr).not.toContain('coalesced:');

      // The real repro shape: `gen:declarations` emits a NEW, still-untracked `.d.mts`
      // sibling. Nothing tracked is modified — under -uno the tree token is unchanged.
      writeFileSync(join(repo, 'dep.d.mts'), 'export declare const x: number;');

      const second = runSync(['bash', '-c', 'echo typecheck-verdict'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:'); // must re-run, not replay the pre-fix verdict
    });

    it('a file created inside a WHOLLY-UNTRACKED directory also busts the cache (-unormal collapses such a dir to one entry and stays blind)', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.ts'), 'x');
      commitAll(repo);

      // `generated/` is untracked as a whole, and already contains a file — so it is
      // ALREADY represented in the status output before the run below.
      mkdirSync(join(repo, 'generated'), { recursive: true });
      writeFileSync(join(repo, 'generated', 'a.d.mts'), 'export declare const a: number;');

      const first = runSync(['bash', '-c', 'echo verdict'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(first.stderr).not.toContain('coalesced:');

      // Adding a SECOND file to that same untracked dir. Under -unormal the dir is
      // collapsed to a single `generated/` entry, so this is invisible; -uall sees it.
      writeFileSync(join(repo, 'generated', 'b.d.mts'), 'export declare const b: number;');

      const second = runSync(['bash', '-c', 'echo verdict'], { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' }, repo);
      expect(second.stderr).not.toContain('coalesced:');
    });

    it('still coalesces a genuine no-op re-run inside a git worktree with no diff (the fix does not over-bust)', () => {
      const repo = gitRepo();
      writeFileSync(join(repo, 'src.txt'), 'v1');
      commitAll(repo);

      const first = runSync(
        ['bash', '-c', 'echo out-y; echo err-y >&2; exit 3'],
        { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' },
        repo,
      );
      expect(first.status).toBe(3);
      expect(first.stderr).not.toContain('coalesced:');

      // Nothing changed (no edit, no new commit) — a true duplicate poll.
      const second = runSync(
        ['bash', '-c', 'echo out-y; echo err-y >&2; exit 3'],
        { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' },
        repo,
      );
      expect(second.status).toBe(3);
      expect(second.stderr).toContain('coalesced:');
    });
  });
});

// PC_HEAVY_FRESH_AFTER — the per-caller freshness barrier (EI-19340233074452707).
//
// The tree-state token above is SOUND but far stricter than correctness requires: it
// asks "did ANY file in the tree change?" when the question that governs a caller's
// answer is "did MY file change since the compile started?". On the shared staging tree
// the token moves ~every 18s against a ~170s operator-core compile, so two agents
// arriving seconds apart never compute the same key and every one of them pays a full
// compile (3-5 byte-identical compiles were observed running at once, three separate
// times on 2026-08-02).
//
// A caller that knows which files it is asking about passes max(mtime) over them; the
// token is then dropped and a replay is admitted only from a run that STARTED at/after
// that watermark — the exact question, per file, instead of the conservative one.
// A leader publishes its output by RENAME, never by writing the live cache files,
// so a replay can never observe a half-written (or freshly truncated) entry.
describe('pc-heavy.sh — atomic result publish (EI-19368312145172418)', () => {
  // Built per-test (`dir` is assigned in beforeEach). Every REAL execution appends
  // a line to the marker; a REPLAY does not — that is the positive control below.
  const cmdWithMarker = () => `echo ran >> ${join(dir, 'runs.txt')}; sleep 3; echo REAL-OUTPUT-LINE`;
  const realRunCount = (): number => {
    const f = join(dir, 'runs.txt');
    if (!existsSync(f)) return 0;
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  };
  const coalesceFileByExt = (ext: string): string | null => {
    const coalesceDir = join(dir, 'coalesce');
    if (!existsSync(coalesceDir)) return null;
    const f = readdirSync(coalesceDir).find((n) => n.endsWith(ext));
    return f ? join(coalesceDir, f) : null;
  };

  it('a NEW leader does not truncate the previous entry a follower may still replay [positive-controlled]', async () => {
    // The bug: `tee "$_c_out"` truncates at OPEN — the instant the new leader
    // starts — while freshness is gated on $_c_exit, which still holds the old
    // run's rc and mtime. A follower in that window was told "fresh, rc=0" and
    // then replayed an emptied file: exit 0 with NO output, which `lint:tsc`
    // reported as "tsc produced no output — toolchain failure". The window
    // lasts the whole run (~174s for a real typecheck), not a microsecond.
    //
    // Two callers disagreeing about freshness is all it takes, and that is
    // routine: PC_HEAVY_COALESCE_SEC is per-caller (default 90, this suite 30).
    const cmd = cmdWithMarker();
    const first = runSync(['bash', '-c', cmd], { PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '90' });
    expect(first.stdout).toContain('REAL-OUTPUT-LINE');
    expect(realRunCount()).toBe(1);
    const outFile = coalesceFileByExt('.out');
    expect(outFile).not.toBeNull();
    const populatedSize = statSync(outFile as string).size;
    expect(populatedSize).toBeGreaterThan(0);

    // Age the entry past the 1s TTL the second caller will use. `_age` is computed in
    // INTEGER seconds, so a 1.6s wait can floor to age=1 and read as FRESH against that
    // TTL — the second caller would then COALESCE instead of leading, nothing would
    // truncate, and this test would pass while asserting nothing at all. (Caught exactly
    // that way: the first draft of this test was vacuous.) 2.1s is the smallest wait that
    // floors to 2 with margin; the elapsed time is measured from the entry's mtime, which
    // predates this line, so the real age is only ever LARGER. The positive control below
    // is what makes the vacuity detectable rather than silent if that ever stops holding.
    await new Promise((r) => setTimeout(r, 2100));

    // A caller with a 1s window sees that entry as STALE, so it runs for real —
    // becoming a second leader while the entry is still fresh to a 90s caller.
    const secondLeader = spawn('bash', [PC_HEAVY, 'bash', '-c', cmd], {
      env: baseEnv({ PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '1' }),
      cwd: dir,
      detached: true,
    });
    try {
      // POSITIVE CONTROL — the whole test is meaningless unless a SECOND real execution
      // is actually in flight right now; if the second caller coalesced instead of
      // leading, the invariant below is vacuous. Waiting for the marker rather than
      // guessing 1200ms costs only as long as the leader takes to reach it, and turns
      // "it coalesced" into a NAMED timeout instead of a bare `2 !== 1`.
      await waitFor('the second leader starts a real run', () => realRunCount() === 2);
      expect(realRunCount()).toBe(2);

      // THE INVARIANT: the published entry is still intact while it runs.
      expect(statSync(outFile as string).size).toBe(populatedSize);

      // ...so a follower that passes the freshness gate replays REAL output,
      // never an empty success.
      const follower = runSync(['bash', '-c', cmd], { PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '90' });
      expect(follower.stderr).toContain('coalesced:'); // it really did replay
      expect(follower.stdout).toContain('REAL-OUTPUT-LINE'); // and got the output
      expect(follower.stdout.trim()).not.toBe('');
    } finally {
      try { process.kill(-(secondLeader.pid as number), 'SIGKILL'); } catch { /* already gone */ }
    }
    // 60s, not 20s: this budget must EXCEED the sum of the budgets nested inside it, or vitest's
    // timer pre-empts theirs and reports the wrong thing. The parts are the first real run (its
    // cmd holds a `sleep 3`), the 2.1s ageing wait, `waitFor`'s 15s default, and the follower's
    // replay run — already >20s before the box is loaded at all. So the outer timer always won,
    // and a genuine "the second leader never started" surfaced as a bare `Test timed out in
    // 20000ms` while the named diagnostic waitFor exists to print stayed unreachable. Measured as
    // test_run 19111385; the same blob passed as 19107618 on a quiet box, which is the tell that
    // the ceiling was the constraint rather than the invariant under test.
  }, 60_000);

  it('leaves no .part temp files behind, even when a leader is hard-killed mid-run', async (ctx) => {
    const parts = () => {
      const coalesceDir = join(dir, 'coalesce');
      if (!existsSync(coalesceDir)) return [];
      return readdirSync(coalesceDir).filter((n) => n.endsWith('.part'));
    };
    const partCount = () => parts().length;
    // bash prints this itself when it cannot fork, so it names the one host condition under
    // which the EXIT trap cannot run the `rm` that sweeps the temps.
    const FORK_REFUSED = /fork: (?:retry: )?Resource temporarily unavailable/;
    // Clean completion publishes by rename, so the temps are consumed.
    runSync(['bash', '-c', 'echo done'], { PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '30' });
    expect(partCount()).toBe(0);

    // A hard-killed leader must not leave its in-progress temp behind either —
    // the EXIT trap that sweeps the lockdir sweeps these too.
    const doomed = spawn('bash', [PC_HEAVY, 'bash', '-c', 'echo x; sleep 30'], {
      env: baseEnv({ PC_HEAVY_SLOTS: '4', PC_HEAVY_COALESCE_SEC: '30' }),
      cwd: dir,
      detached: true,
    });
    // Event-driven, not two fixed 700ms sleeps (WI-10005207): under gate-suite
    // load the trap's sweep had not finished inside the second sleep, so the
    // count read 2 on a correct script. Positive control first — the leader is
    // genuinely mid-run with its temps open — so the zero below is not vacuous.
    const doomedErr = createTextCollector(doomed.stderr);
    const doomedExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
      doomed.once('exit', (code, signal) => r({ code, signal })),
    );
    // Both capture temps (stdout and stderr) open, so the kill lands on a leader that is fully
    // mid-run rather than one still starting its second capture helper.
    await waitFor('leader has both .part capture temps open mid-run', () => partCount() >= 2);
    process.kill(-(doomed.pid as number), 'SIGTERM'); // SIGTERM so the trap runs
    const exit = await doomedExited;
    // Nothing removes a temp once the leader has exited, so a red here is permanent, not slow.
    // Gate reds at c0c038ca and 69b1f61f (2026-10-02) carried no leader output, so carry it now.
    const swept = await waitFor('EXIT trap swept the .part temps', () => partCount() === 0, 10_000).then(
      () => true,
      () => false,
    );
    const stderr = doomedErr.text();
    if (!swept && FORK_REFUSED.test(stderr)) {
      ctx.skip(
        'UNDETERMINED, not failed: the host refused the hard-killed leader a fork, so its EXIT ' +
          `trap could not run the rm that sweeps the temps. Left: ${parts().join(' ')}. stderr: ${stderr}`,
      );
    }
    expect(parts(), `leader exited code=${exit.code} signal=${exit.signal}; stderr: ${stderr}`).toEqual([]);
  }, 45_000);
});

describe('pc-heavy.sh — per-caller freshness barrier (EI-19340233074452707)', () => {
  const cmd = ['bash', '-c', 'echo barrier-out; echo barrier-err >&2; exit 7'];

  const coalesceFileByExt = (ext: string): string | null => {
    const coalesceDir = join(dir, 'coalesce');
    if (!existsSync(coalesceDir)) return null;
    const f = readdirSync(coalesceDir).find((n) => n.endsWith(ext));
    return f ? join(coalesceDir, f) : null;
  };

  it('replays a cached run that STARTED at/after the barrier', () => {
    // Barrier of 1 (epoch 1970) — any run at all starts after it.
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(first.status).toBe(7);
    expect(first.stderr).not.toContain('coalesced:');

    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(second.status).toBe(7); // exit code survives the packed "<rc> <startedAt>" format
    expect(second.stdout).toContain('barrier-out');
    expect(second.stderr).toContain('coalesced:');
  });

  it('does NOT replay a run that started BEFORE the barrier — the pre-edit-answer hazard', () => {
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(first.status).toBe(7);
    expect(first.stderr).not.toContain('coalesced:');

    // Same key (same cwd+argv, token suppressed), but this caller edited its file
    // AFTER that run began, so the cached diagnostics cannot describe it.
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: future });
    expect(second.status).toBe(7);
    expect(second.stderr).not.toContain('coalesced:'); // ran for real, did not replay
  });

  it('suppresses the tree-state token, so the barrier is what gates the replay', () => {
    // Same scenario as the token suite's git-edit case: an edit lands between the two
    // runs. WITHOUT a barrier the token busts the key (asserted above). WITH one, the
    // caller has taken responsibility for freshness, so the replay is admitted — that
    // is the whole point, and it is what lets concurrent callers share one compile.
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@example.com && git config user.name test', { cwd: dir });
    writeFileSync(join(dir, 'src.txt'), 'v1');
    execSync('git add -A && git commit -q -m init', { cwd: dir });

    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(first.stderr).not.toContain('coalesced:');

    writeFileSync(join(dir, 'src.txt'), 'v2'); // dirties git status — would bust the token

    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(second.stderr).toContain('coalesced:');
  });

  it('refuses to replay a cached result carrying no start stamp (fail closed across an upgrade)', () => {
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(first.status).toBe(7);

    // Rewrite the exit file in the pre-barrier format (bare rc, no start stamp), as a
    // result written by an older pc-heavy would be. Absence of a stamp is not evidence
    // the run was recent enough — it must read as "cannot replay", never as "fine".
    const exitFile = coalesceFileByExt('.exit');
    expect(exitFile).not.toBeNull();
    writeFileSync(exitFile as string, '7\n');

    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(second.status).toBe(7);
    expect(second.stderr).not.toContain('coalesced:');
  });

  it('leaves an unbarriered caller on the old tree-token path (opt-in only)', () => {
    const first = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
    expect(first.status).toBe(7);
    expect(first.stderr).not.toContain('coalesced:');

    // A barriered caller keys DIFFERENTLY (no token), so it must not pick up the
    // unbarriered run's cache entry — the two populations stay separate rather than
    // one silently inheriting the other's freshness assumptions.
    const barriered = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', PC_HEAVY_FRESH_AFTER: '1' });
    expect(barriered.stderr).not.toContain('coalesced:');

    // ...while a second unbarriered caller still replays as it always did.
    const second = runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30' });
    expect(second.stderr).toContain('coalesced:');
  });
});

describe('pc-heavy.sh — declared result-affecting env in the coalescing key (EI-18699972365875475)', () => {
  // The hazard, stated by EI-78 when it disabled coalescing for the whole `test:*`
  // family: the key was cwd+argv+tree-state and could not see the ENVIRONMENT, while
  // `affected-tests.mjs` selects its diff base from $AFFECTED_BASE. Two agents at the
  // same HEAD with different bases produce byte-identical cwd+argv, so one would
  // replay a verdict computed for a DIFFERENT delta — and a stale verdict is
  // byte-indistinguishable from a fresh one.
  //
  // `baseEnv` builds the child env from scratch rather than spreading process.env, so
  // "unset" here is genuinely unset and the unset-vs-empty case below is hermetic.
  const cmd = ['bash', '-c', 'echo keyenv-out; echo keyenv-err >&2; exit 9'];
  const run = (extra: Record<string, string>) =>
    runSync(cmd, { PC_HEAVY_SLOTS: '2', PC_HEAVY_COALESCE_SEC: '30', ...extra });

  it('does NOT coalesce two callers whose declared variable DIFFERS — the EI-78 collision', () => {
    const first = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(first.status).toBe(9);
    expect(first.stderr).not.toContain('coalesced:');

    // Same cwd, same argv, same tree — different question. Must run for real.
    const second = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/staging' });
    expect(second.status).toBe(9);
    expect(second.stderr).not.toContain('coalesced:');
  });

  it('still coalesces two callers whose declared variable MATCHES (the fix does not disable coalescing)', () => {
    const first = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(first.stderr).not.toContain('coalesced:');

    const second = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(second.status).toBe(9);
    expect(second.stdout).toContain('keyenv-out');
    expect(second.stderr).toContain('coalesced:');
  });

  it('treats UNSET and EMPTY as different — "use the default" is not "use the empty base"', () => {
    // The boundary a caller is most likely to hit: `AFFECTED_BASE=` in a wrapper
    // script vs. omitting it entirely select different bases, so collapsing them
    // would reintroduce exactly the collision this fold exists to remove.
    const unset = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE' });
    expect(unset.stderr).not.toContain('coalesced:');

    const empty = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: '' });
    expect(empty.status).toBe(9);
    expect(empty.stderr).not.toContain('coalesced:');
  });

  it('is order-insensitive — the same declared SET shares a key however it is spelled', () => {
    // Otherwise two callers that agree on what matters would fragment into separate
    // cache populations purely on how they happened to order the list.
    const first = run({ PC_HEAVY_KEY_ENV: 'A_ONE,B_TWO', A_ONE: '1', B_TWO: '2' });
    expect(first.stderr).not.toContain('coalesced:');

    const second = run({ PC_HEAVY_KEY_ENV: ' B_TWO , A_ONE ', A_ONE: '1', B_TWO: '2' });
    expect(second.status).toBe(9);
    expect(second.stderr).toContain('coalesced:');
  });

  it('leaves a caller that declares NOTHING on exactly its previous key (no flag day)', () => {
    // Monotonic safety: folding more inputs in can only make keys MORE distinct, so an
    // undeclared caller must be byte-identical to its pre-change self — no cache
    // population to migrate, and no coalescing silently lost on unrelated callers.
    const first = run({});
    expect(first.stderr).not.toContain('coalesced:');

    const second = run({});
    expect(second.status).toBe(9);
    expect(second.stderr).toContain('coalesced:');
  });

  it('separates a declaring caller from a non-declaring one rather than letting either inherit', () => {
    // ⚠ Both assertions here are ABSENCES, which pass vacuously if the subject never
    // ran at all (a missing script exits 127 and prints no 'coalesced:' either).
    // Pin that the command actually executed, or this test cannot fail for the reason
    // it exists. Found the hard way: a relative --file path in a mutation probe made
    // exactly this test the only survivor of a wholly non-executing suite.
    const undeclared = run({});
    expect(undeclared.status).toBe(9);
    expect(undeclared.stdout).toContain('keyenv-out');
    expect(undeclared.stderr).not.toContain('coalesced:');

    // A declaring caller must not pick up an entry written by a caller that never
    // committed to what its inputs were — same reasoning as the barrier marker.
    const declared = run({ PC_HEAVY_KEY_ENV: 'AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(declared.status).toBe(9);
    expect(declared.stdout).toContain('keyenv-out');
    expect(declared.stderr).not.toContain('coalesced:');
  });

  it('skips a malformed name instead of aborting the run (fail-open, like every other signal here)', () => {
    // Admission control must never be the reason a legitimate build cannot start.
    const first = run({ PC_HEAVY_KEY_ENV: '9bad-name,,AFFECTED_BASE', AFFECTED_BASE: 'origin/main' });
    expect(first.status).toBe(9);
    expect(first.stdout).toContain('keyenv-out');

    // ...and the well-formed name in the same list is still honoured.
    const second = run({ PC_HEAVY_KEY_ENV: '9bad-name,,AFFECTED_BASE', AFFECTED_BASE: 'origin/other' });
    expect(second.status).toBe(9);
    expect(second.stderr).not.toContain('coalesced:');
  });
});

describe('root affected-test entrypoints enable safe coalescing (EI-18699972365875475)', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
    string,
    string
  >;
  const affectedEntrypoints = [
    'test',
    'test:affected',
    'test:related',
    'test:affected:integration',
    'test:all',
    'test:all:integration',
  ];

  it.each(affectedEntrypoints)('%s declares the env inputs that change its verdict', (name) => {
    expect(scripts[name]).toContain(
      'PC_HEAVY_KEY_ENV=AFFECTED_BASE,AFFECTED_RETRY_FAILED',
    );
    expect(scripts[name]).not.toContain('PC_HEAVY_COALESCE=0');
  });
});

describe('root focused-test entrypoint survives exclusive materialization', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<
    string,
    string
  >;

  it('gives test:file bounded fresh attempts after an exact preemption', () => {
    expect(scripts['test:file']).toContain('PC_HEAVY_RETRY_PREEMPTIONS=3');
    expect(scripts['test:file']).toContain('PC_HEAVY_PREEMPT_AFTER_READY=1');
    expect(scripts['test:file']).toContain('PC_HEAVY_COALESCE=0');
  });
});

describe('pc-heavy.sh — load-adaptive slot count (EI-19313096203661357)', () => {
  // A PATH-shimmed `nproc` pins the core count so the formula asserts the same
  // numbers on any host; PC_HEAVY_LOAD1_OVERRIDE pins load1 (same convention as
  // the admission gate in pretooluse-bash-resource-gate.sh).
  const fakeNprocPath = (cores: number): string => {
    const bin = join(dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'nproc'), `#!/usr/bin/env bash\necho ${cores}\n`, { mode: 0o755 });
    return `${bin}:${process.env.PATH ?? ''}`;
  };
  const slotsLine = (stderr: string) =>
    stderr.split('\n').find((l) => l.includes('[pc-heavy] slots=')) ?? '';
  const probe = (cores: number, extra: Record<string, string>) =>
    runSync(['true'], { PC_HEAVY_DEBUG: '1', PC_HEAVY_COALESCE: '0', PATH: fakeNprocPath(cores), ...extra });

  it('saturated box (load1 >= cores) stays at the floor — exactly the pre-adaptive count', () => {
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '128' });
    expect(r.status).toBe(0);
    expect(slotsLine(r.stderr)).toContain('slots=4 fixed=0 cores=128 floor=4 ceil=16');
    const over = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '300' });
    expect(slotsLine(over.stderr)).toContain('slots=4');
  });

  it('widens by one slot per 16 cores of load1 headroom (the filed 128-core/load-76 case → 7, not 4)', () => {
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '76' }).stderr)).toContain('slots=7');
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
  });

  it('caps at cores/8, which never drops below the max(2, cores/32) floor on small boxes', () => {
    const r = probe(16, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
    expect(slotsLine(r.stderr)).toContain('slots=2 fixed=0 cores=16 floor=2 ceil=2');
  });

  it('an explicit PC_HEAVY_SLOTS is FIXED — load adaptation never overrides the operator', () => {
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0', PC_HEAVY_SLOTS: '3' });
    expect(slotsLine(r.stderr)).toContain('slots=3 fixed=1');
  });

  it('non-numeric load fails conservative, to the floor', () => {
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: 'banana' });
    expect(slotsLine(r.stderr)).toContain('slots=4');
  });

  it('the computed (not env) slot count actually gates admission [adaptive]', async () => {
    // 64 fake cores at load 64 → computed floor of 2. The observable first
    // cohort must contain exactly two of the three wrappers.
    const jobs = 3;
    const path = fakeNprocPath(64);
    const admitted = await admittedCohortSize(jobs, {
      PC_HEAVY_LOAD1_OVERRIDE: '64',
      PATH: path,
    });
    expect(admitted).toBe(2);
  });
});

// ── Release-gate reserve (EI-19315056231449472) ─────────────────────────────
// While green-checkpoint is judging, the steady-state slot target is the wrong
// target: the gate's quiet cut is exactly when the box looks idle, so the
// load-adaptive count is at its most generous precisely when the gate's
// isolation re-run (which decides load-flake vs real break, and so decides the
// VERDICT) most needs headroom. These assert the clamp and — more importantly —
// every fail-open path, because a clamp that misfires wedges the whole fleet's
// heavy runs, which is strictly worse than the false red it prevents.
describe('pc-heavy.sh — release-gate reserve (EI-19315056231449472)', () => {
  const fakeNprocPath = (cores: number): string => {
    const bin = join(dir, 'fakebin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'nproc'), `#!/usr/bin/env bash\necho ${cores}\n`, { mode: 0o755 });
    return `${bin}:${process.env.PATH ?? ''}`;
  };
  const slotsLine = (stderr: string) =>
    stderr.split('\n').find((l) => l.includes('[pc-heavy] slots=')) ?? '';
  const probe = (cores: number, extra: Record<string, string> = {}) =>
    runSync(['true'], { PC_HEAVY_DEBUG: '1', PC_HEAVY_COALESCE: '0', PATH: fakeNprocPath(cores), ...extra });

  /** Publish a run-lock in the same shape green-checkpoint's checkpointRunLockDir does:
   *  a `.green-checkpoint-run-<hash>.lock/` DIRECTORY holding owner.json with the run pid. */
  const plantLock = (owner: string | object, name = 'aaa111', hive?: string): string => {
    const lock = join(dir, 'checkpoint-logs', ...(hive ? [hive] : []), `.green-checkpoint-run-${name}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
    return lock;
  };
  const liveOwner = () => ({ pid: process.pid, startedAt: new Date().toISOString(), token: 'tok' });
  // pid_max is documented as ONE GREATER than the maximum allocatable pid, so it
  // is never a live process — deterministic, unlike reusing a just-reaped pid on
  // a box where PID wrap happens ~daily under fleet load.
  const deadPid = (() => {
    try { return Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()); } catch { return 0x7ffffff0; }
  })();
  const checkpointLockStaleMs = 190 * 60_000;

  it('clamps the effective slot count to a quarter while a run is LIVE', () => {
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
    plantLock(liveOwner());
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
    expect(r.status).toBe(0);
    expect(slotsLine(r.stderr)).toContain('slots=3 fixed=0');
    expect(slotsLine(r.stderr)).toContain('gate=1');
  });

  it('never clamps below 1 — a saturated box at the floor goes to 1, not 0', () => {
    plantLock(liveOwner());
    // floor is 4 on a 128-core box; 4/4 = 1. A 16-core box floors at 2 → also 1.
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '128' }).stderr)).toContain('slots=1 ');
    expect(slotsLine(probe(16, { PC_HEAVY_LOAD1_OVERRIDE: '99' }).stderr)).toContain('slots=1 ');
  });

  it('EI-20223200344608082: focused test:file uses an independent bounded lane while the gate clamps the ordinary pool', async () => {
    plantLock(liveOwner());
    const gateEnv = { PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE: '0' };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv(gateEnv),
      cwd: dir,
      detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const focused = spawn(
      'bash',
      [PC_HEAVY, 'bash', '-c', 'sleep 1; echo focused-ok', 'scripts/test-files.mjs'],
      {
        env: baseEnv({ ...gateEnv, PC_HEAVY_FOCUSED_SLOTS: '1' }),
        cwd: dir,
      },
    );
    const focusedOut = createTextCollector(focused.stdout);
    const focusedErr = createTextCollector(focused.stderr);
    const focusedExited = new Promise<number>((res) => focused.on('exit', (c) => res(c ?? -1)));
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the ordinary holder taking the slot');
      await untilStderr(
        focused,
        focusedErr,
        (t) => t.includes('slot acquired'),
        'focused test:file taking its independent lane',
      );

      // The ordinary pool remains occupied while the focused lane is running.
      expect(heldSlotCount(dir, 1)).toBe(1);
      expect(heldSlotCount(join(dir, 'focused'), 1)).toBe(1);
      expect(focusedErr.peek()).toContain('release gate is JUDGING');

      expect(await focusedExited).toBe(0);
      expect(focusedOut.text()).toContain('focused-ok');
    } finally {
      killGroup(holder);
      try { process.kill(-(focused.pid as number), 'SIGKILL'); } catch { /* already exited */ }
    }
  });

  it('EI-22550861901989735: caller INT aborts a queued focused test before slot acquisition', async () => {
    plantLock(liveOwner());
    const gateEnv = {
      PC_HEAVY_SLOTS: '1',
      PC_HEAVY_FOCUSED_SLOTS: '1',
      PC_HEAVY_COALESCE: '0',
      PC_HEAVY_TIMEOUT_SEC: '30',
      PC_HEAVY_HEARTBEAT_SEC: '1',
    };
    const ran = join(dir, 'queued-focused-int-ran');
    // The holder is itself classified as focused, so it occupies the same
    // independent lane as the target rather than the ordinary pool.
    const holder = spawn('bash', [PC_HEAVY, 'bash', '-c', 'sleep 30', 'scripts/test-files.mjs'], {
      env: baseEnv(gateEnv),
      cwd: dir,
      detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    let focused: ReturnType<typeof spawn> | undefined;
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the focused holder taking the lane');

      // Establish the holder before spawning the contender. Starting both and
      // only then awaiting this landmark lets the contender win on a loaded
      // host, finish, and leave the later "contender queued" wait chasing a
      // state that can never occur.
      focused = spawn(
        'bash',
        [PC_HEAVY, 'bash', '-c', `echo ran > ${JSON.stringify(ran)}`, 'scripts/test-files.mjs'],
        {
          env: baseEnv(gateEnv),
          cwd: dir,
          detached: true,
        },
      );
      const focusedErr = createTextCollector(focused.stderr);
      const focusedExited = new Promise<number>((res) => focused?.on('exit', (c) => res(c ?? -1)));
      await untilStderr(
        focused,
        focusedErr,
        (t) => t.includes('queued for a focused test lane slot'),
        'the focused caller entering the queue',
      );

      process.kill(-(focused.pid as number), 'SIGINT');
      killGroup(holder);

      expect(await focusedExited).toBe(130);
      expect(existsSync(ran)).toBe(false);
      const err = focusedErr.text();
      expect(err).toContain('QUEUE_ABORTED status=retryable reason=caller-signal signal=INT exit=130');
      expect(err).toContain('PC_HEAVY_RESULT status=retryable reason=queue-signal signal=INT exit=130');
      expect(err).not.toContain('slot acquired — starting real work');
    } finally {
      killGroup(holder);
      if (focused?.pid) {
        try { process.kill(-focused.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    // Both readiness waits use untilStderr's 30s observable-state budget. The
    // outer test must not expire first under shared-host scheduler pressure.
  }, 30_000);

  it('EI-21599206021092018: scoped test:affected --changed-paths uses the independent lane', async () => {
    plantLock(liveOwner());
    const gateEnv = { PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE: '0' };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv(gateEnv),
      cwd: dir,
      detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const focused = spawn(
      'bash',
      [
        PC_HEAVY,
        'bash',
        '-c',
        'sleep 5; echo scoped-affected-ok',
        'scripts/affected-tests.mjs',
        '--changed-paths',
        'packages/operator-core/lib/harness/git-sync/completion-settlement-reconciler.test.ts',
      ],
      {
        env: baseEnv({
          ...gateEnv,
          PC_HEAVY_DEBUG: '1',
          PC_HEAVY_TIMEOUT_SEC: '2',
          PC_HEAVY_FOCUSED_SLOTS: '1',
        }),
        cwd: dir,
      },
    );
    const focusedErr = createTextCollector(focused.stderr);
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the ordinary holder taking the slot');
      await untilStderr(
        focused,
        focusedErr,
        (t) => t.includes('slot acquired'),
        'scoped test:affected taking its independent lane',
      );

      expect(heldSlotCount(dir, 1)).toBe(1);
      expect(heldSlotCount(join(dir, 'focused'), 1)).toBe(1);
      expect(focusedErr.peek()).toContain('focused=1');

      try { process.kill(-(focused.pid as number), 'SIGKILL'); } catch { /* already exited */ }
    } finally {
      killGroup(holder);
      if (focused) killGroup(focused);
    }
  });

  it('EI-21239272593686546: scoped lint:tsc uses the independent bounded lane while the gate clamps the ordinary pool', async () => {
    plantLock(liveOwner());
    const gateEnv = { PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE: '0' };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv(gateEnv),
      cwd: dir,
      detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const focused = spawn(
      'bash',
      [
        PC_HEAVY,
        'bash',
        '-c',
        'sleep 1; echo scoped-tsc-ok',
        'scripts/lint-tsc.mjs',
        '--files=packages/operator-core/lib/x.ts',
      ],
      {
        env: baseEnv({ ...gateEnv, PC_HEAVY_FOCUSED_SLOTS: '1' }),
        cwd: dir,
      },
    );
    const focusedOut = createTextCollector(focused.stdout);
    const focusedErr = createTextCollector(focused.stderr);
    const focusedExited = new Promise<number>((res) => focused.on('exit', (c) => res(c ?? -1)));
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the ordinary holder taking the slot');
      await untilStderr(
        focused,
        focusedErr,
        (t) => t.includes('slot acquired'),
        'scoped lint:tsc taking its independent lane',
      );

      expect(heldSlotCount(dir, 1)).toBe(1);
      expect(heldSlotCount(join(dir, 'focused'), 1)).toBe(1);
      expect(focusedErr.peek()).toContain('release gate is JUDGING');

      expect(await focusedExited).toBe(0);
      expect(focusedOut.text()).toContain('scoped-tsc-ok');
    } finally {
      killGroup(holder);
      try { process.kill(-(focused.pid as number), 'SIGKILL'); } catch { /* already exited */ }
    }
  });

  it('EI-21336446790757521: npm run lint:tsc -- --files uses the independent bounded lane', async () => {
    plantLock(liveOwner());
    const gateEnv = { PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE: '0' };
    const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
      env: baseEnv(gateEnv),
      cwd: dir,
      detached: true,
    });
    const holderErr = createTextCollector(holder.stderr);
    const focused = spawn(
      'bash',
      [
        PC_HEAVY,
        'bash',
        '-c',
        'sleep 1; echo npm-scoped-tsc-ok',
        'npm',
        'run',
        'lint:tsc',
        '--',
        '--files=packages/operator-core/lib/x.ts',
      ],
      {
        env: baseEnv({ ...gateEnv, PC_HEAVY_FOCUSED_SLOTS: '1' }),
        cwd: dir,
      },
    );
    const focusedOut = createTextCollector(focused.stdout);
    const focusedErr = createTextCollector(focused.stderr);
    const focusedExited = new Promise<number>((res) => focused.on('exit', (c) => res(c ?? -1)));
    try {
      await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the ordinary holder taking the slot');
      await untilStderr(
        focused,
        focusedErr,
        (t) => t.includes('slot acquired'),
        'npm run lint:tsc taking its independent lane',
      );

      expect(heldSlotCount(dir, 1)).toBe(1);
      expect(heldSlotCount(join(dir, 'focused'), 1)).toBe(1);
      expect(focusedErr.peek()).toContain('release gate is JUDGING');

      expect(await focusedExited).toBe(0);
      expect(focusedOut.text()).toContain('npm-scoped-tsc-ok');
    } finally {
      killGroup(holder);
      try { process.kill(-(focused.pid as number), 'SIGKILL'); } catch { /* already exited */ }
    }
  });

  it('announces the clamp on stderr even without PC_HEAVY_DEBUG, so a slow run explains itself', () => {
    plantLock(liveOwner());
    const r = runSync(['true'], { PC_HEAVY_COALESCE: '0' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('release gate is JUDGING');
    expect(r.stderr).toContain('PC_HEAVY_GATE_RESERVE=0');
  });

  // ── Fail-open paths. Each of these leaving the clamp ON would wedge every
  // heavy run on the box into 1 slot indefinitely.
  it("FAILS OPEN when the lock is stale — a crashed run's leftover lock has a DEAD pid", () => {
    plantLock({ pid: deadPid, startedAt: new Date().toISOString(), token: 'tok' });
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
    expect(slotsLine(r.stderr)).toContain('slots=12');
    expect(slotsLine(r.stderr)).toContain('gate=0');
    expect(r.stderr).not.toContain('release gate is JUDGING');
  });

  it('FAILS OPEN when a live PID is beyond the writer stale horizon', () => {
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    try {
      plantLock({
        pid: holder.pid,
        startedAt: new Date(Date.now() - checkpointLockStaleMs - 1_000).toISOString(),
        token: 'stale-live-pid',
      });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(r.status).toBe(0);
      expect(slotsLine(r.stderr)).toContain('slots=12');
      expect(slotsLine(r.stderr)).toContain('gate=0');
    } finally {
      try { holder.kill('SIGTERM'); } catch { /* already gone */ }
    }
  });

  it('FAILS OPEN when a live PID started after the lock timestamp (recycled-PID identity mismatch)', () => {
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    try {
      // The child is guaranteed to have started after this timestamp, while the
      // lock is still young enough that only the procfs identity check can reject it.
      plantLock({
        pid: holder.pid,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        token: 'recycled-pid',
      });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(r.status).toBe(0);
      expect(slotsLine(r.stderr)).toContain('slots=12');
      expect(slotsLine(r.stderr)).toContain('gate=0');
    } finally {
      try { holder.kill('SIGTERM'); } catch { /* already gone */ }
    }
  });

  it('keeps the old liveness fallback when startedAt is unparseable', () => {
    plantLock({ pid: process.pid, startedAt: 'not-a-timestamp', token: 'unknown-age' });
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
    expect(r.status).toBe(0);
    expect(slotsLine(r.stderr)).toContain('slots=3');
    expect(slotsLine(r.stderr)).toContain('gate=1');
  });

  it('FAILS OPEN on an unparseable / pid-less / empty owner.json', () => {
    for (const body of ['not json at all', '{}', '', '{"pid":"banana"}', '{"pid":null}']) {
      rmSync(join(dir, 'checkpoint-logs'), { recursive: true, force: true });
      plantLock(body);
      expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
    }
  });

  it('FAILS OPEN when the checkpoint log dir is absent, or present but holds no lock', () => {
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
    mkdirSync(join(dir, 'checkpoint-logs'), { recursive: true });
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
    // A lock DIRECTORY with no owner.json yet (the run is mid-publish) is also not a clamp.
    mkdirSync(join(dir, 'checkpoint-logs', '.green-checkpoint-run-bbb.lock'), { recursive: true });
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=12');
  });

  it('PC_HEAVY_GATE_RESERVE=0 escapes the clamp entirely', () => {
    plantLock(liveOwner());
    for (const off of ['0', 'off', 'false', 'no']) {
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0', PC_HEAVY_GATE_RESERVE: off });
      expect(slotsLine(r.stderr)).toContain('slots=12');
      expect(r.stderr).not.toContain('release gate is JUDGING');
    }
  });

  it('scans ALL per-root lock dirs — one live run among several dead ones still clamps', () => {
    plantLock({ pid: deadPid }, 'dead1');
    plantLock({ pid: deadPid }, 'dead2');
    plantLock(liveOwner(), 'live1');
    expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=3');
  });

  it('discovers a per-hive materializing gate below the default log root and closes new admission', () => {
    // Subject-hive checkpoint processes carry
    // PAPERCUSP_CHECKPOINT_LOG_DIR=<default>/sidestage, but ordinary agent
    // commands carry only the default root. The reader must bridge that one
    // directory level or the exclusive materialization barrier keeps racing
    // newly-admitted heavy work until it times out.
    const lock = plantLock(liveOwner(), 'sidestage1', 'sidestage');
    writeFileSync(join(lock, 'phase.json'), JSON.stringify({
      phase: 'materializing',
      at: new Date().toISOString(),
      phaseProtocol: 3,
    }));
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
    expect(r.status).toBe(0);
    expect(slotsLine(r.stderr)).toContain('slots=1 ');
    expect(slotsLine(r.stderr)).toContain('gate=1');
    expect(slotsLine(r.stderr)).toContain('phase=materializing');
  });

  it('clamps an explicit PC_HEAVY_SLOTS too — it is a safety reserve, not load adaptation', () => {
    plantLock(liveOwner());
    const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0', PC_HEAVY_SLOTS: '8' });
    expect(slotsLine(r.stderr)).toContain('slots=2 fixed=1');
  });

  // The ordering property: the exemption at the top of the script returns before
  // any of this, so the gate's OWN suite (and its isolation re-runs, which
  // inherit the env) can never clamp itself down to 1 slot.
  it("never clamps the release gate's own suite (PC_HEAVY_RELEASE_GATE=1)", () => {
    plantLock(liveOwner());
    const marker = join(dir, 'gate-ran');
    const r = runSync(['bash', '-c', `echo "$PC_HEAVY_BYPASS" > "${marker}"`], { PC_HEAVY_RELEASE_GATE: '1' });
    expect(r.status).toBe(0);
    expect(readFileSync(marker, 'utf8').trim()).toBe('1');
    expect(r.stderr).not.toContain('release gate is JUDGING');
    // exempt = no slot machinery touched at all
    expect(existsSync(join(dir, 'slot.0'))).toBe(false);
  });

  it('the clamp actually GATES ADMISSION, not just the reported number', async () => {
    // 128 fake cores at load1 128 → base 4, clamped to 1 by the live lock.
    // The observable first cohort must therefore contain exactly one wrapper.
    plantLock(liveOwner());
    const jobs = 3;
    const path = fakeNprocPath(128);
    const admitted = await admittedCohortSize(jobs, {
      PC_HEAVY_GATE_RESERVE: '1',
      PC_HEAVY_LOAD1_OVERRIDE: '128',
      PATH: path,
    });
    expect(admitted).toBe(1);
  });

  // ── Phase-aware clamp DEPTH (EI-19328677512071640) ─────────────────────────
  // v1 clamped for a run's WHOLE lifetime (~2.7h observed) to protect a window
  // that lasts minutes. These pin the depth table — but the load-bearing ones are
  // the fail-safe cases: every unknown must degrade toward MORE throttle. A bug
  // that relaxes on an unrecognized input silently deletes the protection the
  // whole reserve exists to provide, while still looking correct in review.
  describe('phase-aware clamp depth (EI-19328677512071640)', () => {
    /** phase.json exactly as green-checkpoint's writeCheckpointRunPhase publishes it:
     *  beside owner.json in the SAME lock dir. An omitted `phaseProtocol` IS the
     *  protocol-1 (old writer) case — not a malformed one. */
    const plantPhase = (lock: string, body: string | object): void =>
      writeFileSync(join(lock, 'phase.json'), typeof body === 'string' ? body : JSON.stringify(body));
    const at = () => new Date().toISOString();

    it('relaxes to /2 during the long `suite` sweep (protocol >= 2 writer)', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at(), phaseProtocol: 2 });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(r.status).toBe(0);
      // 12/2, NOT v1's 12/4 — this is the throughput the item was filed to reclaim.
      expect(slotsLine(r.stderr)).toContain('slots=6 ');
      expect(slotsLine(r.stderr)).toContain('phase=suite');
    });

    it('closes admission to slot 0 while protocol-3 dependency materialization drains existing work', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'materializing', at: at(), phaseProtocol: 3 });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=1 ');
      expect(slotsLine(r.stderr)).toContain('phase=materializing');
    });

    it('clamps HARD (/4) during `isolating` — the single-concurrency window the reserve exists for', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=3 ');
      expect(slotsLine(r.stderr)).toContain('phase=isolating');
    });

    // Not an obvious case, and the reason it is here is that the ORIGINAL design
    // note got it wrong: `delivering` sounds like a post-verdict wind-down, but
    // green-checkpoint re-runs every failing file at tip there (deps.runTestsAtRef)
    // and feeds classifyRedAgainstTip. Contention flips a VERDICT in that window
    // exactly as it does in isolation, so it must clamp hard.
    it('clamps HARD (/4) during `delivering` too — it re-runs failing files at tip to decide stale-vs-real', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'delivering', at: at(), phaseProtocol: 2 });
      expect(slotsLine(probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' }).stderr)).toContain('slots=3 ');
    });

    // THE deployment-ordering guard, and the single most important test here.
    // The gate runs from the RELEASE checkout, which LAGS staging — so a new
    // reader genuinely does meet an old writer, for as long as the release is
    // behind. Protocol 1 folded the isolation re-run INSIDE `suite`, so relaxing
    // on a protocol-1 `suite` would strip protection from the live isolation
    // re-run while every other test on this page still passed.
    it('does NOT relax on `suite` from a protocol-1 writer (no phaseProtocol field)', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at() });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=3 ');
    });

    // One case PER `it`, deliberately — NOT a for-loop inside a single test.
    // Each probe spawns a real bash subprocess, and this suite runs under
    // vitest's DEFAULT 5s testTimeout (no testTimeout is set in apps/operator's
    // config or the shared defineVitestConfig). Eight spawns sharing one 5s
    // budget is a load-induced flake waiting to happen on this box — exactly how
    // github-identity-drift.test.ts red-pinned the gate on 2026-08-02: it took
    // 11,725ms against the 5s default with ZERO real offenders, purely because
    // the host was loaded. it.each gives every case its own budget and names the
    // offending body in the failure instead of collapsing all eight into one.
    it.each([
      ['empty file',                 ''],
      ['truncated json',             '{'],
      ['garbage',                    'not json at all'],
      ['protocol 1 (field absent)',  '{"phase":"suite"}'],
      ['protocol explicitly older',  '{"phase":"suite","phaseProtocol":1}'],
      ['non-numeric protocol',       '{"phase":"suite","phaseProtocol":"two"}'],
      ['unknown phase name',         '{"phase":"wat","phaseProtocol":2}'],
      ['protocol but no phase',      '{"phaseProtocol":2}'],
    ])('degrades to v1 depth (/4), never to relaxation: %s', (_label, body) => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, body);
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=3 ');
    });

    it('a live run that never published phase.json stays at v1 depth', () => {
      plantLock(liveOwner());
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=3 ');
      expect(slotsLine(r.stderr)).toContain('phase=unknown');
    });

    it('phase never resurrects a DEAD run — liveness is still decided first', () => {
      const lock = plantLock({ pid: deadPid, startedAt: at(), token: 'tok' });
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      const r = probe(128, { PC_HEAVY_LOAD1_OVERRIDE: '0' });
      expect(slotsLine(r.stderr)).toContain('slots=12');
      expect(slotsLine(r.stderr)).toContain('gate=0');
    });
  });

  // ── Refusing the broad sweep in the classifier phases (EI-19385714326170346).
  // The clamp above is about LOAD; this is about the gate's VERDICT. During
  // `isolating`/`delivering` the gate re-runs failing files at single concurrency
  // to decide real-break vs load-flake, so a concurrent broad sweep can flip that
  // classification and red the gate fleet-wide on code that is fine.
  //
  // The load-bearing tests here are the NEGATIVE ones: this guard refuses work, so
  // every unknown must fail OPEN (the opposite direction to the clamp's "throttle
  // more"). A bug that refuses too eagerly blocks routine work for every agent.
  describe('refuses the broad sweep in classifier phases (EI-19385714326170346)', () => {
    const plantPhase = (lock: string, body: string | object): void =>
      writeFileSync(join(lock, 'phase.json'), typeof body === 'string' ? body : JSON.stringify(body));
    const at = () => new Date().toISOString();
    // argv carries the marker the guard matches on, but the command is `true` —
    // so a NON-refusal exits 0 harmlessly instead of running a real suite.
    const sweep = (env: Record<string, string> = {}) =>
      runSync(['true', 'scripts/affected-tests.mjs'], { PC_HEAVY_COALESCE: '0', ...env });
    const scoped = (env: Record<string, string> = {}) =>
      runSync(['true', 'scripts/test-files.mjs'], { PC_HEAVY_COALESCE: '0', ...env });

    for (const phase of ['isolating', 'delivering'] as const) {
      it(`REFUSES test:affected during \`${phase}\``, () => {
        const lock = plantLock(liveOwner());
        plantPhase(lock, { phase, at: at(), phaseProtocol: 2 });
        const r = sweep();
        expect(r.status).toBe(75);
        expect(r.stderr).toContain('REFUSING test:affected');
        expect(r.stderr).toContain(phase);
        expect(r.stderr).toContain('bounded by the size of the failing set');
        expect(r.stderr).not.toContain('It lasts minutes.');
        // It must tell the agent what to do INSTEAD — the whole point is that the
        // knowledge reaches the moment of action, not a doc they already read.
        expect(r.stderr).toContain('npm run test:file --');
        expect(r.stderr).toContain('PC_HEAVY_ALLOW_DURING_GATE=1');
      });
    }

    it('NEVER refuses a scoped test:file run — it is the prescribed alternative', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      const r = scoped();
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('REFUSING');
    });

    it('does NOT refuse during the long `suite` sweep — that window is hours, not minutes', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at(), phaseProtocol: 2 });
      const r = sweep();
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('REFUSING');
    });

    // EI-19970072096315178 — the admission-time check above is necessary but NOT
    // sufficient, and the gap leaks in the one direction that matters.
    //
    // `suite` is not refused, only clamped — and `suite` is the run's multi-hour
    // bulk, with `isolating`/`delivering` following it. A sweep therefore tends to
    // be ADMITTED under the permissive phase, then sit in the slot queue (waits of
    // 60-90s were routine on this box while a gate ran, and PC_HEAVY_TIMEOUT_SEC
    // allows up to 900s), and begin executing under the classifier phase — exactly
    // where contention flips a VERDICT instead of merely costing time. The guard
    // above cannot see that: it ran before the wait.
    //
    // Timing here is anchored to the script's OWN stderr landmarks ("slot
    // acquired", "queued") rather than sleeps, so the test does not become the
    // load-sensitive flake it exists to prevent.
    it('RE-CHECKS the phase after the slot wait — a sweep admitted under `suite` is refused once the gate advances to `isolating` while it queues', async () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at(), phaseProtocol: 2 });

      const gateEnv = { PC_HEAVY_SLOTS: '1', PC_HEAVY_COALESCE: '0' };

      // Occupy the single slot so the sweep is forced to QUEUE rather than start.
      // `detached` (own process group) is LOAD-BEARING, not tidiness: pc-heavy
      // deliberately lets its child INHERIT the slot fd, and an flock lives on
      // the open file DESCRIPTION shared across that fork — so killing only the
      // wrapper leaves the orphaned `sleep` holding the slot for its full
      // duration. This test then waited out the whole sleep (~30s, 41% of the
      // file's runtime) before the sweep could proceed. Killing the GROUP frees
      // the slot at the instant we intend, which is also what every other
      // holder in this file does.
      const holder = spawn('bash', [PC_HEAVY, 'sleep', '30'], {
        env: baseEnv(gateEnv),
        cwd: dir,
        detached: true,
      });
      const holderErr = createTextCollector(holder.stderr);
      try {
        await untilStderr(holder, holderErr, (t) => t.includes('slot acquired'), 'the holder taking the slot');

        const sweepProc = spawn('bash', [PC_HEAVY, 'true', 'scripts/affected-tests.mjs'], {
          env: baseEnv(gateEnv),
          cwd: dir,
        });
        const sweepErr = createTextCollector(sweepProc.stderr);
        const exited = new Promise<number>((res) => sweepProc.on('exit', (c) => res(c ?? -1)));

        // Confirm it is genuinely WAITING before the phase moves — otherwise this
        // would silently degrade into a re-test of the admission-time check.
        await untilStderr(sweepProc, sweepErr, (t) => t.includes('queued for a heavy slot'),
          'the sweep genuinely queueing behind the holder');
        expect(sweepErr.peek()).not.toContain('REFUSING'); // mid-stream: peek, never text

        // The gate advances into its classifier phase while the sweep is queued.
        plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
        killGroup(holder); // frees the slot (whole tree — see above); the sweep now proceeds

        expect(await exited).toBe(75);
        expect(sweepErr.text()).toContain('REFUSING test:affected'); // exited: terminal read
        expect(sweepErr.text()).toContain('isolating');
      } finally {
        killGroup(holder);
      }
    });

    // THE one that would wedge the fleet for hours if it regressed: protocol 1
    // folds isolation INSIDE `suite`, so `isolating` never appears and refusing on
    // `suite` there would block every sweep for the run's whole ~2.7h lifetime.
    it('FAILS OPEN against a protocol-1 writer (phaseProtocol absent)', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'suite', at: at() });
      expect(sweep().status).toBe(0);
      const lock2 = plantLock(liveOwner(), 'bbb222');
      plantPhase(lock2, { phase: 'isolating', at: at() });
      expect(sweep().status).toBe(0);
    });

    it('FAILS OPEN on missing / unparseable / unrecognized phase input', () => {
      // no phase.json at all
      plantLock(liveOwner());
      expect(sweep().status).toBe(0);
      for (const body of ['not json', '{}', '', '{"phase":"isolating","phaseProtocol":"two"}',
                          { phase: 'wat', at: at(), phaseProtocol: 2 }]) {
        rmSync(join(dir, 'checkpoint-logs'), { recursive: true, force: true });
        const lock = plantLock(liveOwner());
        plantPhase(lock, body);
        expect(sweep().status).toBe(0);
      }
    });

    it('FAILS OPEN when no gate run is live at all', () => {
      expect(sweep().status).toBe(0);
      plantLock({ pid: deadPid, startedAt: at(), token: 'tok' });
      expect(sweep().status).toBe(0);
    });

    it('PC_HEAVY_ALLOW_DURING_GATE=1 escapes the refusal', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      expect(sweep({ PC_HEAVY_ALLOW_DURING_GATE: '1' }).status).toBe(0);
    });

    // Structural, but assert it: green-checkpoint's own suite and isolation
    // re-runs inherit PC_HEAVY_RELEASE_GATE=1 and exec long before this guard, so
    // the gate can never refuse itself into a deadlock.
    it('the release gate itself is never refused (PC_HEAVY_RELEASE_GATE=1)', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      const r = sweep({ PC_HEAVY_RELEASE_GATE: '1' });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain('REFUSING');
    });

    it('PC_HEAVY_GATE_RESERVE=0 disables the refusal along with the clamp', () => {
      const lock = plantLock(liveOwner());
      plantPhase(lock, { phase: 'isolating', at: at(), phaseProtocol: 2 });
      expect(sweep({ PC_HEAVY_GATE_RESERVE: '0' }).status).toBe(0);
    });
  });
});
