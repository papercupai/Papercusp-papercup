/**
 * systemd-scope-env-runner.signal-grace.test — the RECURRENCE GUARD for WI-1064487.
 *
 * THE DEFECT THIS EXISTS TO CATCH: `systemd-scope-env-runner.mjs` is the transient unit's
 * MAIN process. It used to install no signal handler, so a deadline SIGTERM killed it
 * INSTANTLY — closing the payload's stdout/stderr pipes while the payload was still running
 * its own TERM trap. A payload whose trap sits behind a foreground child (`sleep 30`, the
 * commonest shape there is) then died on the broken pipe before the trap ever dispatched,
 * and WI-6677's SIGTERM-before-SIGKILL guarantee silently did not hold.
 *
 * WHY THIS FILE EXISTS AT ALL, given bash-jobs.test.ts already covers deadline cleanup:
 * that test caught this only INTERMITTENTLY (~15-25% of runs, tracked as WI-1046842) because
 * whether the trap won the race against its own broken pipe was genuinely nondeterministic.
 * An intermittent guard is not a guard — a revert would have looked like the flake everyone
 * had already learned to re-run. So the load-bearing assertion here is deliberately the
 * DETERMINISTIC half of the fix rather than the racy half:
 *
 *   - Pre-fix, the close handler was `finish(signal ? 1 : (code ?? 1))` — EVERY signal death
 *     collapsed to exit 1, always.
 *   - Post-fix, `exitCodeFor()` reports the shell convention 128+signal, so SIGTERM is 143.
 *
 * That flips 100% of the time on a revert, with no race to lose. The trap-marker assertion
 * below is kept as the direct behavioural check, but it is the exit code that makes this
 * file a guard instead of a second flake.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkNonRepoTmpDir } from './agent-tools/locks/non-repo-tmpdir';
import { SYSTEMD_RUNNER_OUTPUT_PATH_ENV, SYSTEMD_RUNNER_REDACTIONS_ENV } from './systemd-scope-env-runner.mjs';

/**
 * The subject under test, overridable by path.
 *
 * This indirection is what makes the guard's own falsifiability PROVABLE safely. Proving a
 * guard can fail means running it against a deliberately-broken subject — and mutating the
 * tracked file in place to do that is unsafe on this shared checkout: git-sync sweeps the
 * whole tree every few minutes and will happily commit the mutant while the probe is still
 * running, with no handler failing and `git status` showing clean afterwards. With the path
 * overridable, scripts/mutation-probe.sh mutates a COPY outside the tree instead (its tier-2
 * copy-out mode) — zero window, no sweep lock, nothing to restore.
 */
const RUNNER =
  process.env.PAPERCUSP_TEST_SYSTEMD_RUNNER_PATH ??
  fileURLToPath(new URL('./systemd-scope-env-runner.mjs', import.meta.url));

/** The runner reads a NUL-separated KEY=VALUE record set (systemd credential format). */
function writeEnvFile(dir: string, entries: Record<string, string>): string {
  const path = join(dir, 'env');
  writeFileSync(path, Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('\0'));
  return path;
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe('systemd-scope-env-runner SIGTERM grace (WI-1064487)', () => {
  it('persists unit and payload phases without adding diagnostic bytes to stdout', async () => {
    const dir = mkNonRepoTmpDir('wi8539-runner-phases-');
    const logPath = join(dir, 'job.log');
    const envPath = writeEnvFile(dir, {
      [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: logPath,
      // A non-matching value still buffers a suffix; terminal phase metadata
      // must not appear between the emitted prefix and that final suffix.
      [SYSTEMD_RUNNER_REDACTIONS_ENV]: Buffer.from(JSON.stringify({ values: ['unused'], patterns: [] })).toString('base64'),
      PATH: process.env.PATH ?? '',
    });
    const runner = spawn(process.execPath, [RUNNER, '--env-fd-path', envPath, '--', 'bash', '-c', 'printf phase-proof'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    runner.stdout.on('data', (chunk) => { output += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      runner.once('error', reject);
      runner.once('close', resolve);
    });
    expect(code).toBe(0);
    expect(output).toBe('phase-proof');
    const log = readFileSync(logPath, 'utf8');
    const phases = [...log.matchAll(/JOB PHASE: phase=([a-z-]+) at=(\d+)/g)];
    expect(phases.map((match) => match[1])).toEqual([
      'unit-runner-started', 'payload-spawn-requested', 'payload-spawned', 'payload-first-byte', 'payload-closed',
    ]);
    const times = phases.map((match) => Number(match[2]));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(log).toContain('phase-proof');
    expect(log.indexOf('phase=payload-closed')).toBeGreaterThan(log.indexOf('phase-proof') + 'phase-proof'.length);
    expect(log).toContain('JOB END: status=completed exit=0');
  });

  it.each([
    { command: 'bash', args: ['-c', 'exit 0'], code: 0, spawned: true },
    { command: '/papercusp-nonexistent-payload', args: [], code: 1, spawned: false },
  ])('records only observed phases for a silent payload ($command)', async ({ command, args, code, spawned }) => {
    const dir = mkNonRepoTmpDir('wi8539-silent-phases-');
    const logPath = join(dir, 'job.log');
    const envPath = writeEnvFile(dir, { [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: logPath, PATH: process.env.PATH ?? '' });
    const runner = spawn(process.execPath, [RUNNER, '--env-fd-path', envPath, '--', command, ...args], {
      stdio: 'ignore',
    });
    const result = await new Promise<number | null>((resolve, reject) => {
      runner.once('error', reject);
      runner.once('close', resolve);
    });
    expect(result).toBe(code);
    const log = readFileSync(logPath, 'utf8');
    const phases = [...log.matchAll(/JOB PHASE: phase=([a-z-]+) at=(\d+)/g)].map((match) => match[1]);
    expect(phases).toEqual(spawned
      ? ['unit-runner-started', 'payload-spawn-requested', 'payload-spawned', 'payload-closed']
      : ['unit-runner-started', 'payload-spawn-requested', 'payload-spawn-failed']);
    expect(log).toContain(`JOB END: status=${code === 0 ? 'completed' : 'failed'} exit=${code}`);
  });

  it('forwards SIGTERM to the payload and stays alive until it closes, reporting 143 not 1', async () => {
    // mkNonRepoTmpDir, not mkdtempSync(os.tmpdir()): when the suite runner sets TMPDIR to an
    // existing in-repo path, a bare os.tmpdir() lands INSIDE the repo and trips the lock and
    // sweep machinery (EI-5541/EI-5826 class).
    const dir = mkNonRepoTmpDir('wi1064487-grace-');
    const logPath = join(dir, 'job.log');
    const marker = join(dir, 'cleaned');
    const envPath = writeEnvFile(dir, { [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: logPath, PATH: process.env.PATH ?? '' });

    // The payload's trap is deferred behind a FOREGROUND child. That is the shape the defect
    // actually broke — `sleep 30 & wait $!` never reproduced it, because an interruptible
    // wait lets bash dispatch the trap before the pipe matters.
    //
    // The sleep is SHORT (2s) for a reason worth stating, because it looks like a shortcut and
    // is not. bash does not interrupt a foreground child to service a trap — it waits for that
    // child to finish first. Under real systemd that costs nothing: KillMode defaults to
    // control-group, so the deadline SIGTERM reaches `sleep` too and it dies at once. Here we
    // signal only the runner, so the foreground child's FULL duration is the trap's latency —
    // a 30s sleep simply times the test out without testing anything.
    //
    // 2s is still a real 2-SECOND WINDOW in which the runner must stay alive and hold the pipes
    // open after being signalled, which is precisely the property under guard. Pre-fix the
    // runner was gone within milliseconds of the SIGTERM.
    const payload = `trap 'echo cleaned > ${marker}; exit 143' TERM; echo working; sleep 2`;
    const runner = spawn(process.execPath, [RUNNER, '--env-fd-path', envPath, '--', 'bash', '-c', payload], {
      stdio: 'ignore',
    });

    const exited = new Promise<number | null>((resolve) => runner.once('exit', (code) => resolve(code)));

    // Only meaningful once the trap is actually installed; before `echo working` the payload
    // has no trap and the run cannot distinguish anything.
    const installed = await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('working'), 15_000);
    expect(installed, 'payload never reached `echo working`, so its TERM trap was never installed — this run proves nothing').toBe(true);

    runner.kill('SIGTERM');
    const exitCode = await exited;

    // THE GUARD. Pre-fix this was 1 for every signal death, deterministically.
    expect(
      exitCode,
      `runner exited ${exitCode}; expected 143 (128+SIGTERM). A 1 here means exitCodeFor() is gone from ` +
        'systemd-scope-env-runner.mjs and every signal death has collapsed back to "failed" (WI-1064487).',
    ).toBe(143);

    // The direct behavioural check: the payload's trap got to run before its pipes closed.
    expect(
      existsSync(marker),
      'the payload TERM trap left no marker: the runner died before the payload finished cleaning up, ' +
        'which is exactly the WI-1064487 regression (forwardTerminationSignalsTo missing or not awaiting close).',
    ).toBe(true);
    expect(readFileSync(marker, 'utf8')).toContain('cleaned');
  }, 30_000);

  /**
   * The case above does NOT reach `exitCodeFor`'s signal branch, and that is not obvious —
   * scripts/mutation-probe.sh caught it, after I had convinced myself the guard covered it.
   *
   * The reason: that payload's trap ends in an explicit `exit 143`, so bash exits NORMALLY
   * with code 143. `child.once('close', (code, signal))` therefore fires with signal=null and
   * takes the `if (!signal) return code ?? 1` branch — the 143 is simply the payload's own
   * exit code passed through, and the 128+signal conversion is never exercised. Mutating that
   * conversion to `return 1` left the first test green.
   *
   * So this second case gives the payload NO trap at all. bash is then killed BY the signal,
   * close fires with code=null and signal='SIGTERM', and the conversion is the only thing that
   * can produce 143. Together the two cases pin both halves of the fix: staying alive through
   * the payload's cleanup (above), and reporting the signal honestly (here).
   */
  it('reports a signal death as 128+signal, not the collapsed exit 1', async () => {
    const dir = mkNonRepoTmpDir('wi1064487-signal-');
    const logPath = join(dir, 'job.log');
    const envPath = writeEnvFile(dir, { [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: logPath, PATH: process.env.PATH ?? '' });

    // No trap: bash dies OF the signal rather than exiting under its own control.
    const payload = 'echo working; sleep 2';
    const runner = spawn(process.execPath, [RUNNER, '--env-fd-path', envPath, '--', 'bash', '-c', payload], {
      stdio: 'ignore',
    });
    const exited = new Promise<number | null>((resolve) => runner.once('exit', (code) => resolve(code)));

    const started = await waitFor(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('working'), 15_000);
    expect(started, 'payload never reached `echo working` — this run proves nothing').toBe(true);

    runner.kill('SIGTERM');

    expect(
      await exited,
      'expected 143 (128+SIGTERM). A 1 here means exitCodeFor() no longer converts the signal, so every ' +
        'signal death reads as "the payload failed" — the second half of the WI-1064487 defect.',
    ).toBe(143);
  }, 30_000);
});
