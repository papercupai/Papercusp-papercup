/**
 * scripts/pc-heavy.sh — the post-admission PSI freeze fires only under REAL memory scarcity
 * (EI-21924870233271057).
 *
 * pc-heavy's post-admission guard used to elect a freeze victim from the memory PSI sample ALONE.
 * Memory PSI measures time stalled on reclaim/refault, which on a host with a large page cache and
 * ample swap tracks IO pressure rather than shortage: measured on this box, memory `full avg10`
 * 0.54 moved with io `full avg10` 0.50 while 65 GiB of MemAvailable, 1890 GiB of SwapFree and zero
 * OOM kills in 24h said memory was never short. Freezing under those conditions cannot return any
 * memory — it just SIGSTOPs useful work; and because the suspended work was itself generating the
 * page-cache churn, PSI falls, the root thaws, the churn resumes, and the controller oscillates.
 * That thrash is what left ~8 of 9 concurrent verification runs crawling at ~2% CPU while ~50 cores
 * sat idle (a frozen cgroup is STOPPED, not slow, so it burns no CPU and occupies no core), and a
 * root still frozen at the 300s expiry reports undetermined / exit-75 — a verdict with no per-file
 * evidence behind it, which is the single most expensive thing to misread on the release gate.
 *
 * Fix: a freeze is elected only when MemAvailable is genuinely below PC_HEAVY_MEM_PSI_MIN_AVAIL_GIB
 * (default 8), and an already-frozen root is thawed as soon as memory is ample again rather than
 * left to expire. Admission CONCURRENCY (the MemAvailable slot clamp) remains the lever for
 * preventing overcommit; this freeze is a last-resort OOM guard.
 *
 * ⚠ This is the suite the freeze/thaw suites point at when they set PC_HEAVY_MEM_PSI_MIN_AVAIL_GIB=0.
 * Those suites exercise the freeze MECHANISM (election, accounting, thaw, stdout isolation) and
 * must neutralise this floor to reach it at all; the DECISION — whether a freeze should happen —
 * is asserted here and nowhere else. Both halves are needed: the ample-memory case below would
 * also pass if freezing were broken outright, so the scarce-memory case beside it is a required
 * calibration, not a duplicate.
 *
 * Like the sibling accounting suite, this drives the controller through file-backed overrides
 * (`PC_HEAVY_MEM_PSI_OVERRIDE_FILE`, `PC_HEAVY_MEMAVAIL_GIB_OVERRIDE_FILE`) that pc-heavy re-reads
 * on every sample, so each scenario is deterministic rather than a bet on the real memory pressure
 * of whatever box it happens to run on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

// lib -> operator-core -> packages -> <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// ⚠ Every reference to the subject MUST go through this constant — the mutation-probe
// (scripts/mutation-probe.sh) points it at a mutated COPY outside the tree so falsifiability can
// be proven without ever mutating the shared working tree. A suite that honours the override on
// only some paths runs happily against the real file and reports a false "MUTANT SURVIVED".
const PC_HEAVY = process.env.PROBE_SCRIPT || join(ROOT, 'scripts', 'pc-heavy.sh');

const ADMISSION_ID = 'test-scarcity-admission';

/**
 * WI-10004029: STARTUP and DECISION are budgeted separately, because only one of them is under test.
 *
 * Before the controller writes its first record, pc-heavy runs its whole admission path: a
 * self-copy, a load-adaptive slot count, a git-state coalescing fingerprint of the cwd, the setsid
 * launch, and hundreds of short forks (sed/awk/date/head). Traced 2026-09-30 at load ~114 outside
 * any test lane, that path took ~2.5s before the first record; the freeze landed ~0.1s after it.
 * Inside the gate's stateful lane the same path competes with the whole lane, and the old single
 * 20s budget covered startup AND the freeze decision together. Two gate samples at sha 7652f8c9
 * failed on two different cases, each on a freeze-engaged wait, while the file passed standalone
 * (testing:runs 20153210 and the 1fxzuva lane re-run). The startup cost under the lane is inferred,
 * not measured, which is why the timed-out wait now quotes the record state and pc-heavy's stderr.
 *
 * So each case first waits for the admission RECORD (startup, generous, not asserted), and only then
 * applies the tight budget to the transition the case is actually about. A controller that records
 * its admission but never decides still fails on the 20s decision budget, so the tight bound keeps
 * its teeth.
 */
const STARTUP_BUDGET_MS = 90_000;
const DECISION_BUDGET_MS = 20_000;
const CASE_TIMEOUT_MS = STARTUP_BUDGET_MS + DECISION_BUDGET_MS * 2 + 10_000;

let dir = '';
let psiFile = '';
let memAvailFile = '';
const spawned: ChildProcess[] = [];
/** pc-heavy's own stderr (PC_HEAVY_ADMISSION / PC_HEAVY_RESULT lines), quoted by a timed-out wait. */
let childStderr = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pcheavy-scarcity-'));
  psiFile = join(dir, 'psi-sample');
  memAvailFile = join(dir, 'memavail-gib');
  childStderr = '';
});

afterEach(async () => {
  // Kill before removing the tree: a still-running admission re-creates its record file (and can
  // outlive the test by the length of its own `sleep`), which would leak processes across cases
  // and let one scenario's controller observe the next one's override files.
  const killed: ChildProcess[] = [];
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      killed.push(child);
    }
  }
  // WI-1496508: the kill above was correct in INTENT but could not deliver it, because
  // `child.kill()` only SIGNALS — it never waits. `rmSync` therefore started while the `bash` it
  // had just signalled was still alive and still writing, and a file re-created between rmSync's
  // readdir and its rmdir surfaces as `ENOTEMPTY, Directory not empty: /tmp/pcv/pcheavy-scarcity-*`.
  // That is a TEARDOWN-ONLY red: every assertion in the case has already passed by then.
  // Measured 2026-08-31 (3d window): 2 such reds / 9 passes — and this file is bound as a
  // `check:{kind:'tests'}` criterion on the `gate-speed-round-2-2026-08-31-acceptance` rubric,
  // which RUNS it at grading time, so the race corrupted acceptance grading and not just the lane.
  // Awaiting the actual exit closes the window rather than papering over it.
  await Promise.all(
    killed.map(
      (child) =>
        new Promise<void>((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
          child.once('exit', () => resolveExit());
          // A SIGKILLed direct child cannot ignore the signal, so this bound is a liveness
          // backstop for a lost 'exit' event, never the expected path.
          setTimeout(() => resolveExit(), 2_000).unref();
        }),
    ),
  );
  // `force` suppresses ENOENT, NOT ENOTEMPTY, and Node's rm retry default is 0 on POSIX. The
  // awaited exit above removes the writer this test controls; `maxRetries` covers the residual
  // case of a descendant `pc-heavy.sh` spawned (the plain `spawn` leads no process group, so
  // SIGKILL to `bash` never reached them).
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Wait for an OBSERVABLE STATE instead of guessing a wall-clock duration — a fixed sleep is
 * simultaneously a flake risk under fleet contention (too short) and wasted time otherwise (too
 * long). A timeout is a real failure, never a silent fall-through.
 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = DECISION_BUDGET_MS): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started >= timeoutMs) {
      // Quote the controller's own narration: a bare timeout cannot say whether pc-heavy never
      // started, recorded its admission and then skipped, or never reached a decision at all.
      throw new Error(
        `waitFor(${JSON.stringify(label)}) timed out after ${timeoutMs}ms — the state never arrived.` +
          ` record state=${readRecordField('state') ?? '<no record>'}` +
          ` pc-heavy stderr tail: ${JSON.stringify(childStderr.slice(-1500))}`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Startup is not under test: wait for the admission record under its own, generous budget. */
async function awaitAdmissionRecorded(): Promise<void> {
  await waitFor('admission recorded (startup)', () => readRecordField('state') !== null, STARTUP_BUDGET_MS);
}

/** Hold for `ms`, failing the moment `predicate` becomes true. The negative analogue of waitFor. */
async function stayFalse(label: string, predicate: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) throw new Error(`${label} — the state was reached, and it must not be.`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function recordFile(): string {
  return join(dir, 'psi-admissions', `${ADMISSION_ID}.state`);
}

function readRecordField(key: string): string | null {
  const file = recordFile();
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq >= 0 && line.slice(0, eq) === key) return line.slice(eq + 1);
  }
  return null;
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    PC_HEAVY_DIR: dir,
    PC_HEAVY_IONICE: '', // skip ionice in tests (same hermeticity reasoning as the sibling suites)
    PC_HEAVY_ADMISSION_ID: ADMISSION_ID,
    PC_HEAVY_PSI_ADMISSION: '1',
    PC_HEAVY_MEM_PSI_OVERRIDE_FILE: psiFile,
    PC_HEAVY_MEMAVAIL_GIB_OVERRIDE_FILE: memAvailFile,
    PC_HEAVY_MEM_PSI_BACKOFF: '5',
    PC_HEAVY_MEM_PSI_RECOVER: '2',
    PC_HEAVY_MEM_PSI_RECOVERY_SEC: '1',
    PC_HEAVY_MEM_PSI_SAMPLE_SEC: '1',
    // No victim-size floor: the fixture's `sleep` child reports no real cgroup memory of its own,
    // and this suite is about the SCARCITY decision, not victim election sizing.
    PC_HEAVY_MEM_PSI_MIN_VICTIM_MIB: '0',
    PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
    PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '100',
    ...extra,
  };
}

function startAdmission(extra: Record<string, string> = {}): ChildProcess {
  const child = spawn('bash', [PC_HEAVY, 'sleep', '30'], pcHeavyFixtureOptions(dir, baseEnv(extra)));
  child.stdout?.resume();
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    childStderr = (childStderr + chunk).slice(-8_000);
  });
  spawned.push(child);
  return child;
}

describe('pc-heavy PSI freeze requires real memory scarcity (EI-21924870233271057)', () => {
  it('is syntactically valid bash', () => {
    expect(() =>
      execFileSync('bash', ['-n', PC_HEAVY], { timeout: 10_000, killSignal: 'SIGKILL' }),
    ).not.toThrow();
  });

  it('does NOT freeze when PSI is high but memory is AMPLE — the production defect', async () => {
    // PSI far above backoff (5): the pre-fix controller froze on this reading alone.
    writeFileSync(psiFile, '10\n');
    // ...but 4096 GiB available is nowhere near the 8 GiB floor, so no freeze can relieve anything.
    writeFileSync(memAvailFile, '4096\n');

    startAdmission();
    await awaitAdmissionRecorded();

    // Hold across several 1s samples. Asserting the ABSENCE of a transition needs real elapsed
    // sampling time, not a single reading taken before the controller has looked even once.
    await stayFalse(
      'froze on ample memory (PSI alone must not elect a victim)',
      () => readRecordField('state') === 'frozen',
      5_000,
    );

    expect(readRecordField('state')).toBe('active');
    // Not merely "not frozen right now" — never frozen at all across the whole window.
    expect(Number(readRecordField('frozen_episodes') ?? '0')).toBe(0);
  }, CASE_TIMEOUT_MS);

  it('DOES still freeze when memory is genuinely scarce — calibration for the case above', async () => {
    // Identical PSI. The ONLY difference from the previous case is the MemAvailable reading, which
    // is what makes this pair a controlled experiment: without it, a totally broken freeze path
    // would satisfy the ample-memory assertion above and look like a passing guard.
    writeFileSync(psiFile, '10\n');
    writeFileSync(memAvailFile, '1\n'); // 1 GiB, well under the 8 GiB floor

    startAdmission();
    await awaitAdmissionRecorded();
    await waitFor('freeze engaged (state=frozen persisted)', () => readRecordField('state') === 'frozen');

    // state=frozen IS the calibration signal. Deliberately NOT asserting
    // frozen_episodes here: that counter is finalized when the episode ENDS (the
    // expire, recovery and scarcity-thaw paths all increment it just before
    // flipping the state off `frozen`), so mid-freeze it is legitimately 0. The
    // sibling accounting suite reads it only after waiting for state=active, and
    // asserting it here instead would fail against perfectly correct behaviour.
    expect(readRecordField('state')).toBe('frozen');
  }, CASE_TIMEOUT_MS);

  // host-memory-reduction-2026-09-27 P-009: the floor scales with RAM. On the 251 GiB tower the
  // worst thrash (memory PSI full avg10 50%) still showed 13 GiB MemAvailable — above a fixed
  // 8 GiB floor, so no freeze was ever elected. The pair below models that host; 13 vs 65 GiB is
  // the only difference, so a floor that ignores MemTotal fails exactly one of them.
  it('freezes a 251 GiB host thrashing at 13 GiB MemAvailable — above the absolute 8 GiB floor', async () => {
    writeFileSync(psiFile, '10\n');
    writeFileSync(memAvailFile, '13\n');

    startAdmission({ PC_HEAVY_MEMTOTAL_GIB_OVERRIDE: '251' });
    await awaitAdmissionRecorded();
    await waitFor('freeze engaged (state=frozen persisted)', () => readRecordField('state') === 'frozen');
    expect(readRecordField('state')).toBe('frozen');
  }, CASE_TIMEOUT_MS);

  it('still declines the same host at 65 GiB MemAvailable — the EI-21924870233271057 churn case', async () => {
    writeFileSync(psiFile, '10\n');
    writeFileSync(memAvailFile, '65\n');

    startAdmission({ PC_HEAVY_MEMTOTAL_GIB_OVERRIDE: '251' });
    await awaitAdmissionRecorded();
    await stayFalse(
      'froze a 251 GiB host with 65 GiB available',
      () => readRecordField('state') === 'frozen',
      5_000,
    );
    expect(Number(readRecordField('frozen_episodes') ?? '0')).toBe(0);
  }, CASE_TIMEOUT_MS);

  it('thaws an already-frozen root once memory becomes ample, WITHOUT waiting for PSI to recover', async () => {
    // Start scarce so the freeze is elected...
    writeFileSync(psiFile, '10\n');
    writeFileSync(memAvailFile, '1\n');

    startAdmission();
    await awaitAdmissionRecorded();
    await waitFor('freeze engaged', () => readRecordField('state') === 'frozen');

    // ...then make memory ample while PSI stays PINNED above the recovery threshold (2). The PSI
    // recovery path therefore cannot explain a thaw: the only remaining route is the scarcity
    // re-check. This is the transition that matters in production — without it a root frozen
    // during a transient stall sits to the 300s expiry and reports undetermined/exit-75.
    writeFileSync(memAvailFile, '4096\n');

    await waitFor('thawed because memory became ample', () => readRecordField('state') === 'active');
    expect(readRecordField('state')).toBe('active');
    // PSI never recovered — proving the thaw came from the scarcity re-check, not from the sample.
    expect(readFileSync(psiFile, 'utf8').trim()).toBe('10');
    // The episode counter is finalized as the state flips off `frozen`, so THIS is the case that
    // can assert it. It also pins the scarcity-thaw path to the same accounting contract as the
    // expire and recovery paths — a thaw that released the process but skipped the accounting
    // would leave `scripts/test-files.mjs` unable to tell a freeze-induced timeout from a real one.
    expect(Number(readRecordField('frozen_episodes') ?? '0')).toBeGreaterThanOrEqual(1);
    expect(Number(readRecordField('frozen_total_ms') ?? '0')).toBeGreaterThan(0);
  }, CASE_TIMEOUT_MS);

  it('PC_HEAVY_MEM_PSI_MIN_AVAIL_GIB=0 disables the gate and restores freeze-on-PSI-alone', async () => {
    // The documented escape hatch, and the setting every freeze/thaw suite relies on. If this
    // stops working those suites do not fail loudly — they hang until their own waits time out,
    // which reads as an unrelated flake, so it is asserted here directly.
    writeFileSync(psiFile, '10\n');
    writeFileSync(memAvailFile, '4096\n'); // ample: would decline the freeze at the default floor

    startAdmission({ PC_HEAVY_MEM_PSI_MIN_AVAIL_GIB: '0' });
    await awaitAdmissionRecorded();
    await waitFor('freeze engaged with the gate disabled', () => readRecordField('state') === 'frozen');

    expect(readRecordField('state')).toBe('frozen');
  }, CASE_TIMEOUT_MS);

  it('FAILS OPEN — an unreadable MemAvailable restores the previous always-freeze behaviour', async () => {
    // A guard that silently disables itself when its input goes missing is worse than no guard:
    // the freeze is a last-resort OOM protection, so an unreadable reading must fall back to the
    // conservative pre-fix behaviour rather than quietly declining to ever freeze again.
    writeFileSync(psiFile, '10\n');
    // Deliberately do NOT create memAvailFile — the read fails, and scarcity must be assumed.

    startAdmission();
    await awaitAdmissionRecorded();
    await waitFor(
      'freeze engaged despite an unreadable MemAvailable (fail-open)',
      () => readRecordField('state') === 'frozen',
    );

    expect(readRecordField('state')).toBe('frozen');
  }, CASE_TIMEOUT_MS);
});
