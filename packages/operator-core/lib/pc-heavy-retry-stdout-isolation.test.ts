import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

/**
 * WI-42126 / green-main-fast-2026-08-25#D-025 — pc-heavy's preemption-retry loop
 * CONCATENATED every attempt's stdout into the caller's single pipe.
 *
 * THE INVARIANT THIS GUARDS: the stdout of one pc-heavy invocation must equal the
 * stdout of exactly ONE execution of the wrapped command.
 *
 * `_pc_heavy_run_with_retries` ran each attempt as `bash "$0" "$@"` with stdout
 * INHERITED. An attempt that emitted output before being preempted left that output
 * in the caller's pipe and the next attempt appended to it, so the caller silently
 * received the command's output N times over.
 *
 * That is not cosmetic, because the callers PARSE this stream. `lint:tsc` captures it
 * (tsc-baseline-gate.mjs) and counts diagnostics per file, so with N attempts every
 * file carrying any error read exactly Nx its true count — a UNIFORM multiplier across
 * the whole project, presenting as a mass regression nobody caused. Measured live: 104
 * files at exactly 2x baseline with every diagnostic printed twice verbatim, while raw
 * tsc at the same tip gave 143 located / 143 DISTINCT diagnostics. It froze the release
 * gate and nearly cost a fleet-wide "fix" of 104 files that were never broken.
 *
 * The same retry is opted into by `test:affected`, `test:affected:integration`,
 * `test:file` and `docs:rebuild`, so this invariant is not lint:tsc-specific.
 *
 * ── Why these tests are BEHAVIOURAL, and why the retry-count control is required ──
 * Asserting "exactly one copy" alone is a weak test: it also passes if the retry never
 * happened, or if the wrapped command never ran. Each case therefore asserts, from the
 * SAME run, that the loop really did take multiple attempts (the `retrying after`
 * banners on stderr). One copy of the output PLUS proof of N attempts is what makes
 * this falsifiable — the pre-fix implementation produced N copies from exactly this
 * input, so the control establishes the mutant would have been caught.
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2). Mutating the real file in this shared checkout
// would let the git-sync sweep commit the mutant.
const SCRIPT = process.env.PC_HEAVY_SCRIPT ?? resolve(__dirname, '../../../scripts/pc-heavy.sh');

/** Emits one marker line, then reports itself preempted the way a real preemption does. */
const PREEMPTING_COMMAND = [
  'echo "packages/operator-core/lib/fake.ts(1,1): error TS9999: DUPLICATION-MARKER"',
  'printf "%s\\n" "PC_HEAVY_RESULT status=preempted reason=exclusive-materializer" > "$PC_HEAVY_PREEMPT_RESULT_FILE"',
  'exit 75',
].join('\n');

let slotDir: string;

beforeAll(() => {
  // Private slot + coalesce dir: this must never queue behind, or contend with, the
  // fleet's real heavy work (or the release gate) just to assert a stdout property.
  slotDir = mkdtempSync(join(tmpdir(), 'pc-heavy-retry-stdout-'));
});

afterAll(() => {
  rmSync(slotDir, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runPcHeavy(command: string, retries: number): RunResult {
  // STRIP EVERY INHERITED PC_HEAVY_* VAR before setting our own.
  //
  // This suite is routinely run BY pc-heavy — `npm run test:file` and
  // `npm run test:affected` are both `bash scripts/pc-heavy.sh ...`, and the
  // green-checkpoint gate runs the latter. The parent exports its own control
  // variables into our environment, and one of them silently invalidates the whole
  // test: `PC_HEAVY_RETRY_ACTIVE=1` makes `_pc_heavy_run_with_retries` delegate
  // straight to `main` and never retry at all. The suite then measures a
  // single-attempt run, the retry-count controls read 0, and it fails for reasons
  // that have nothing to do with the invariant.
  //
  // Found by calibration, not by reasoning: run the mutation probe's positive
  // control (this suite against the UNMUTATED script, via test:file) and it failed
  // exactly like the mutant. A guard that only passes when launched a particular way
  // is not a guard — so the environment is fully controlled here rather than
  // inherited and hoped about.
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^_?PC_HEAVY_/.test(key)) cleanEnv[key] = value;
  }

  const env = {
    ...cleanEnv,
    PC_HEAVY_DIR: slotDir,
    PC_HEAVY_SCRATCH_ROOT: join(slotDir, 'scratch'),
    PC_HEAVY_SLOTS: '4',
    // Neither the release-gate reserve nor the memory clamp may throttle this to a
    // single slot; they would make the test slow and load-dependent, not more correct.
    PC_HEAVY_GATE_RESERVE: '0',
    PC_HEAVY_MEM_CLAMP: '0',
    PC_HEAVY_RETRY_PREEMPTIONS: String(retries),
  };

  const result = spawnSync('bash', [SCRIPT, 'sh', '-c', command, 'lint:tsc'], {
    encoding: 'utf-8',
    timeout: 120_000,
    // Keep successful-run stderr too: the retry banner is a positive control.
    stdio: ['ignore', 'pipe', 'pipe'],
    ...pcHeavyFixtureOptions(slotDir, env),
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '', status: result.status ?? -1 };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('pc-heavy retry loop isolates each attempt\'s stdout (WI-42126)', () => {
  it('re-enters the same self-copy after its temporary pathname is unlinked', () => {
    const command = [
      'marker="$PC_HEAVY_SCRATCH_ROOT/unlink-attempt"',
      'if [ ! -f "$marker" ]; then',
      '  for copy in "$PC_HEAVY_SCRATCH_ROOT"/self.*.sh; do',
      '    if [ -f "$copy" ]; then rm -- "$copy" || exit 1; printf unlinked > "$marker"; fi',
      '  done',
      '  [ -f "$marker" ] || exit 73',
      '  printf "%s\\n" "PC_HEAVY_RESULT status=preempted reason=exclusive-materializer" > "$PC_HEAVY_PREEMPT_RESULT_FILE"',
      '  exit 75',
      'fi',
      'printf "%s\\n" SELF_COPY_SURVIVED',
    ].join('\n');
    const run = runPcHeavy(command, 1);
    expect(readFileSync(join(slotDir, 'scratch', 'unlink-attempt'), 'utf8')).toBe('unlinked');
    expect(countOccurrences(run.stderr, 'retrying after exclusive-materializer preemption')).toBe(1);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe('SELF_COPY_SURVIVED');
  });

  it('emits the wrapped command\'s output ONCE even though three attempts ran', () => {
    const run = runPcHeavy(PREEMPTING_COMMAND, 2);

    // CONTROL: prove the loop really took 3 attempts (1 initial + 2 retries). Without
    // this the single-copy assertion below could pass simply because nothing retried,
    // and the pre-fix defect would sail through.
    expect(
      countOccurrences(run.stderr, 'retrying after exclusive-materializer preemption'),
      'the retry loop must actually have retried, or this test proves nothing',
    ).toBe(2);

    // THE INVARIANT: three attempts, each emitting the marker, must still reach the
    // caller as exactly one copy. Pre-fix this was 3.
    expect(
      countOccurrences(run.stdout, 'DUPLICATION-MARKER'),
      'stdout must carry exactly ONE execution\'s output, never one copy per attempt',
    ).toBe(1);
  });

  it('still reports the preemption failure faithfully rather than hiding it', () => {
    const run = runPcHeavy(PREEMPTING_COMMAND, 1);

    expect(countOccurrences(run.stderr, 'retrying after exclusive-materializer preemption')).toBe(1);
    // Buffering must not swallow the outcome: the caller still needs the exact
    // exclusive-materializer exit so it can distinguish this from a real failure.
    expect(run.status, 'the preempted exit code must survive buffering').toBe(75);
    expect(countOccurrences(run.stdout, 'DUPLICATION-MARKER')).toBe(1);
  });

  it('delivers a SUCCEEDING command\'s full stdout (buffering must not drop output)', () => {
    // The opposite failure mode of the bug: over-correcting into emitting nothing.
    // A gate that receives empty output treats it as a toolchain failure, so this is
    // the guard against "fixing" duplication by discarding the surviving attempt too.
    const run = runPcHeavy('echo OK-LINE-1; echo OK-LINE-2; exit 0', 2);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('OK-LINE-1');
    expect(run.stdout).toContain('OK-LINE-2');
    expect(countOccurrences(run.stdout, 'OK-LINE-1')).toBe(1);
  });

  it('keeps the LAST attempt\'s answer when attempts disagree — not a merge, not the first', () => {
    // Raised in review (su-ebcbe6a2) against the observed test:affected case, and it is a
    // real gap in the cases above: when every attempt emits IDENTICAL text, "exactly one
    // copy" is satisfied by last-attempt-wins AND by a dedupe-by-identity. Those are
    // different fixes, and only one of them is correct.
    //
    // Attempts are NOT always identical. The measured test:affected instance carried four
    // manifests with four DIFFERENT runStartHead values, because each attempt re-derived
    // against a shared tree that had moved: the copies were competing ANSWERS, not repeats.
    // Dedupe would have kept an arbitrary one; splicing would emit a run that never existed.
    // The only defensible rule is that stdout belongs to the attempt whose exit code is
    // returned, so this pins that rule with attempts that are distinguishable.
    const counter = join(slotDir, `attempt-counter-${Date.now()}`);
    const command = [
      `n=$(cat ${counter} 2>/dev/null || echo 0)`,
      'n=$((n+1))',
      `echo $n > ${counter}`,
      'echo "ATTEMPT-$n"',
      // Fail the first two attempts, succeed on the third.
      'if [ "$n" -lt 3 ]; then',
      '  printf "%s\\n" "PC_HEAVY_RESULT status=preempted reason=exclusive-materializer" > "$PC_HEAVY_PREEMPT_RESULT_FILE"',
      '  exit 75',
      'fi',
      'exit 0',
    ].join('\n');

    const run = runPcHeavy(command, 2);

    expect(run.status, 'the third attempt succeeds, so the run must succeed').toBe(0);
    // The surviving answer, and ONLY it.
    expect(run.stdout).toContain('ATTEMPT-3');
    // Superseded answers must not reach the caller — this is what distinguishes
    // last-attempt-wins from dedupe (which would keep ATTEMPT-1) and from splicing.
    expect(run.stdout, 'a superseded attempt\'s answer must never reach the caller').not.toContain('ATTEMPT-1');
    expect(run.stdout).not.toContain('ATTEMPT-2');
  });

  it('never splices attempts together or falls back to a non-returned attempt', () => {
    // A partial (preempted mid-stream) attempt UNDER-reports errors. Under
    // `lint:tsc --update` that would silently ratchet baselines DOWN and mask real
    // errors — a worse failure than the false red this fix removes. So the source must
    // emit the returned attempt's buffer and nothing else: no append-mode redirect, no
    // last-non-empty fallback.
    const source = readFileSync(SCRIPT, 'utf8');
    const start = source.indexOf('_pc_heavy_run_with_retries() {');
    expect(start, 'the retry wrapper must exist').toBeGreaterThan(-1);

    // STRIP COMMENTS FIRST. This assertion is about what the shell EXECUTES, and the
    // explanatory comments in this very function quote the redirect verbatim — so a
    // naive substring search over the raw text matches the prose and passes even when
    // the code has been reverted. Caught by the tier-2 mutation probe: the un-stripped
    // version of this test was the ONE case that survived the mutant.
    const body = source
      .slice(start)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    // Append mode across attempts is exactly the concatenation defect, re-introduced.
    expect(body).not.toContain('>> "$_retry_stdout_file"');
    // The attempt must redirect (truncating) into the buffer, which IS the discard.
    expect(body, 'the attempt must redirect into the per-attempt buffer').toContain(
      'bash "$0" "$@" > "$_retry_stdout_file"',
    );
  });
});
