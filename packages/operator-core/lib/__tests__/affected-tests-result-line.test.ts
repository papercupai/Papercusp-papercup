/**
 * affected-tests-result-line.test.ts — EI-18796017307093897 regression guard,
 * rebuilt as a BEHAVIOR test in EI-20103084274785576.
 *
 * WHAT IS GUARDED (unchanged): `scripts/affected-tests.mjs` must emit one
 * canonical, greppable `AFFECTED_TESTS_RESULT status=... failed=...` line on
 * EVERY exit path, so a caller can verify the TRUE verdict independently of
 * exit-code plumbing elsewhere. Observed live 2026-07-27: a background job
 * reported "completed, exit code 0" while the SAME run's log said "1
 * non-quarantined task(s) failed".
 *
 * WHY THIS FILE WAS REWRITTEN (EI-20103084274785576) — it used to assert
 * against the SOURCE TEXT of affected-tests.mjs, and that cost the fleet's
 * green gate twice:
 *
 *   1. a trailing '.' added to "…none declare a 'test' script."
 *   2. a clarifying tail added to "No affected workspaces …"
 *
 * Neither edit could affect a single caller grepping the marker. The defect is
 * structural, not clerical: a source-text regex cannot separate the CONTRACT
 * (the machine-readable marker line) from the DECORATION (the human prose above
 * it), so every copy edit is a coin flip against a gate that reds for everyone.
 * Fixing the two instances left two MORE exact-prose pins in this same file
 * ('\nAll affected tests passed.' and 'non-quarantined task(s) failed:') armed
 * for a third and fourth recurrence.
 *
 * A source-text assertion has a second, worse blind spot: it cannot see
 * REACHABILITY. It passes just as happily when the code it pins has become
 * unreachable — which is exactly the bug EI-19454727576364875 turned out to be
 * (an early `process.exit(0)` above the repo-wide guard loop, green the whole
 * time). Executing the real script closes both holes at once: prose is free to
 * change, and a path that stops being reachable fails loudly.
 *
 * The early-exit paths are cheap to drive for real — they exit(0) before
 * spawning any test child (all three below run in <0.5s combined), so this is
 * a behavior test with no fixture tree and no vitest recursion.
 *
 * Source-shape assertions survive ONLY where executing the path is genuinely
 * expensive (a real failing run needs real vitest children). Those that remain
 * pin CODE tokens (`resultLine('failed')`, `process.exit(1)`) and never prose.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * Test-only seam: point this at a MUTATED copy of the script (in a scratch root
 * built from symlinks) to re-prove these assertions can actually fail. That is
 * the only supported way to falsify them — mutating the real script in place
 * races git-sync, which sweeps the whole tree every few minutes and would commit
 * the mutant even if nothing else went wrong. Unset in every normal run.
 */
const AFFECTED_TESTS = process.env.PAPERCUSP_AFFECTED_TESTS_SCRIPT
  ? resolve(process.env.PAPERCUSP_AFFECTED_TESTS_SCRIPT)
  : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
const source = readFileSync(AFFECTED_TESTS, 'utf8').replaceAll('"', "'");

/** Every field a caller is entitled to find on the marker line, on every path. */
const REQUIRED_MARKER_FIELDS = [
  'status',
  'tasks',
  'failed',
  'quarantinedFailed',
  'timedOutTasks',
  'undeterminedTasks',
] as const;

function runAffected(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [AFFECTED_TESTS, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    // Inherit nothing that could flip behaviour (AFFECTED_RETRY_FAILED et al).
    env: { ...process.env, ...env, AFFECTED_RETRY_FAILED: '' },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/** The marker lines a caller's `grep AFFECTED_TESTS_RESULT` would find. */
function markerLines(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('AFFECTED_TESTS_RESULT '));
}

function parseMarker(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tok of line.slice('AFFECTED_TESTS_RESULT '.length).trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0) fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return fields;
}

/**
 * Every workspace the script would run SOMETHING in for `paths` — read from its
 * own --dry task list rather than hardcoded, so excluding all of them reliably
 * empties the task list even as the repo's workspaces and repo-wide invariant
 * guards move around. Hardcoding "@papercusp/operator-core hosts every guard"
 * would just re-introduce a staleness trap one level up from the prose pins
 * this rewrite exists to remove.
 */
function workspacesInPlay(paths: string): string[] {
  const { stdout } = runAffected(['--changed-paths', paths, '--dry']);
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = /^\s+-\s+(\S+)\s+::\s+\S+$/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names];
}

describe('affected-tests.mjs emits a self-verifying AFFECTED_TESTS_RESULT line (EI-18796017307093897)', () => {
  describe('behaviour: every early-exit(0) path really EMITS a greppable marker', () => {
    // "no affected workspaces" and "no workspace declares a test script" are both
    // genuine PASS verdicts (nothing to run is not a failure) — a caller grepping
    // for the marker must still find one, not silence. Asserted by RUNNING the
    // script, so the prose above each marker is free to change forever.
    const cases: { name: string; args: () => string[]; reason: string; tasks: string }[] = [
      {
        name: 'no-affected-workspaces (a path that routes nowhere, no guard attached)',
        args: () => {
          const unrouted = 'some/unrouted/path.txt';
          return ['--changed-paths', unrouted, '--exclude', workspacesInPlay(unrouted).join(',')];
        },
        reason: 'no-affected-workspaces',
        tasks: '0',
      },
      {
        name: 'all-excluded (the selected workspace is explicitly excluded)',
        args: () => {
          const paths = 'papercusp-desktop/package.json';
          return ['--changed-paths', paths, '--exclude', workspacesInPlay(paths).join(',')];
        },
        reason: 'all-excluded',
        tasks: '0',
      },
      {
        name: 'no-test-script (a selected workspace contributes no task)',
        args: () => {
          const paths = 'libs/generic/token-kit/package.json';
          return ['--changed-paths', paths, '--exclude', workspacesInPlay(paths).join(',')];
        },
        reason: 'no-test-script',
        tasks: '0',
      },
    ];

    for (const c of cases) {
      it(`emits status=passed reason=${c.reason} and exits 0 — ${c.name}`, () => {
        const { stdout, status } = runAffected(c.args());
        const markers = markerLines(stdout);
        // A bare `expect(markers).toHaveLength(1)` on a stale fixture reads as
        // "the contract broke"; attach the output so the real cause is visible.
        expect(markers, `expected exactly one marker line, got:\n${stdout}`).toHaveLength(1);
        const fields = parseMarker(markers[0]);
        // If `reason` drifted, the probe inputs may simply have gone stale rather
        // than the contract having broken — say so in the failure.
        expect(
          fields.reason,
          `reached a different early-exit path than intended — either the marker contract changed, or this probe's --changed-paths/--exclude inputs went stale. Output:\n${stdout}`,
        ).toBe(c.reason);
        expect(fields.status).toBe('passed');
        expect(fields.tasks).toBe(c.tasks);
        expect(fields.failed).toBe('0');
        expect(status).toBe(0);
      });
    }

    it('emits status=dry-run with the real task count on the --dry early exit', () => {
      const { stdout, status } = runAffected(['--changed-paths', 'scripts/affected-tests.mjs', '--dry']);
      const markers = markerLines(stdout);
      expect(markers, `expected exactly one marker line, got:\n${stdout}`).toHaveLength(1);
      const fields = parseMarker(markers[0]);
      expect(fields.status).toBe('dry-run');
      expect(fields.failed).toBe('0');
      // A dry run of a path that selects real work must report a NON-zero task
      // count — `tasks=0` here would mean the selection silently collapsed, the
      // exact false-green EI-19454727576364875 was.
      expect(Number(fields.tasks)).toBeGreaterThan(0);
      expect(status).toBe(0);
    });

    it('accepts --dry-run as a preview alias and refuses unknown flags before scheduling work', () => {
      const preview = runAffected(['--changed-paths', 'scripts/affected-tests.mjs', '--dry-run']);
      const previewFields = parseMarker(markerLines(preview.stdout)[0]);
      expect(preview.status).toBe(0);
      expect(previewFields.status).toBe('dry-run');
      expect(Number(previewFields.tasks)).toBeGreaterThan(0);

      const typo = runAffected(['--changed-paths', 'scripts/affected-tests.mjs', '--dry-rnu']);
      expect(typo.status).toBe(1);
      expect(typo.stderr).toContain('unrecognized flag(s): --dry-rnu');
      expect(typo.stderr).toContain('did you mean --dry-run?');
      expect(typo.stderr).toContain('Refusing to run rather than silently ignoring the flag');
      expect(typo.stdout).not.toContain('AFFECTED_TESTS_SCHEDULER');
    });

    it('surfaces a deadline refusal through the documented failure grep, not as a clean run', () => {
      // A past epoch guarantees the scheduler refuses before launching a child. This is the
      // real false-green path: status=refused and NOT MEASURED are truthful, but neither matches
      // the documented `AFFECTED_EXIT|Test Files|FAIL ` triage grep on their own.
      const { stdout, stderr, status } = runAffected(
        ['--changed-paths', 'scripts/affected-tests.mjs'],
        {
          PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '1',
          // This test itself runs under pc-heavy, whose after-ready paths are inherited by the
          // child unless explicitly cleared. The refusal must reach the affected-tests deadline
          // branch, not collide with the outer test lane's marker.
          PC_HEAVY_PREEMPT_AFTER_READY: '',
          PC_HEAVY_PREEMPT_READY_FILE: '',
          PC_HEAVY_PSI_FINALIZATION_FILE: '',
        },
      );
      const output = `${stdout}${stderr}`;
      const triageLines = output.split('\n').filter((line) => /AFFECTED_EXIT|Test Files|FAIL /.test(line));

      // A surrounding pc-heavy/systemd test lane may normalize an EX_CONFIG child exit to its
      // own infrastructure refusal (observed as 75). The contract under test is the log surface,
      // so require a non-zero child result without coupling this probe to the outer supervisor's
      // status mapping.
      expect(typeof status).toBe('number');
      expect(status).toBeGreaterThan(0);
      expect(output).toContain('AFFECTED_TESTS_RESULT status=refused reason=deadline-insufficient');
      expect(output).toContain('NOT MEASURED');
      expect(triageLines).toContain('AFFECTED_EXIT=78');
    });

    it('accepts the conventional equals-form for value-taking flags', () => {
      const result = runAffected(['--changed-paths=scripts/affected-tests.mjs', '--dry']);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('AFFECTED_DERIVATION source=explicit changedPaths=1');
      const [marker] = markerLines(result.stdout);
      expect(parseMarker(marker).status).toBe('dry-run');
    });

    it('routes Vitest-style --run intent to the exact-file runner instead of suggesting --all', () => {
      const testPath = 'packages/operator-core/lib/__tests__/affected-tests-result-line.test.ts';
      const result = runAffected(['--run', testPath]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unrecognized flag(s): --run');
      expect(result.stderr).not.toContain('did you mean --all?');
      expect(result.stderr).toContain(`For exact files use: npm run test:file -- ${testPath}`);
      expect(result.stderr).toContain('additional Vitest arguments after a second `--`');
      expect(result.stdout).not.toContain('AFFECTED_TESTS_SCHEDULER');
    });

    it('routes positional test files to test:file while retaining --changed-paths advice for other operands', () => {
      const testPath = 'packages/operator-core/lib/__tests__/affected-tests-result-line.test.ts';
      const exactFile = runAffected([testPath]);
      expect(exactFile.status).toBe(1);
      expect(exactFile.stderr).toContain(`For exact files use: npm run test:file -- ${testPath}`);
      expect(exactFile.stderr).not.toContain('pass --changed-paths as one comma-delimited value');

      const nonTest = runAffected(['scripts/affected-tests.mjs']);
      expect(nonTest.status).toBe(1);
      expect(nonTest.stderr).toContain('pass --changed-paths as one comma-delimited value');
      expect(nonTest.stderr).toContain('--changed-paths=path/to/a.ts,path/to/b.ts');
      expect(nonTest.stderr).not.toContain('For exact files use:');
    });

    it('refuses trailing positional paths instead of silently narrowing --changed-paths', () => {
      const narrowed = runAffected([
        '--changed-paths',
        'scripts/affected-tests.mjs',
        'packages/operator-core/lib/__tests__/affected-tests-result-line.test.ts',
        'packages/operator-core/lib/__tests__/affected-tests-changed-path-provenance.test.ts',
        '--dry',
      ]);

      expect(narrowed.status).toBe(1);
      expect(narrowed.stderr).toContain(
        'unexpected positional argument(s): packages/operator-core/lib/__tests__/affected-tests-result-line.test.ts, packages/operator-core/lib/__tests__/affected-tests-changed-path-provenance.test.ts',
      );
      expect(narrowed.stderr).toContain(
        'For exact files use: npm run test:file -- packages/operator-core/lib/__tests__/affected-tests-result-line.test.ts packages/operator-core/lib/__tests__/affected-tests-changed-path-provenance.test.ts',
      );
      expect(narrowed.stderr).not.toContain('pass --changed-paths as one comma-delimited value');
      expect(narrowed.stdout).not.toContain('AFFECTED_DERIVATION');
      expect(narrowed.stdout).not.toContain('AFFECTED_TESTS_SCHEDULER');
    });

    it('carries the full field set a caller parses, on every early-exit path', () => {
      const unrouted = 'some/unrouted/path.txt';
      const invocations: string[][] = [
        ['--changed-paths', unrouted, '--exclude', workspacesInPlay(unrouted).join(',')],
        ['--changed-paths', 'scripts/affected-tests.mjs', '--dry'],
      ];
      for (const args of invocations) {
        const { stdout } = runAffected(args);
        const [marker] = markerLines(stdout);
        expect(marker, `no marker line for: ${args.join(' ')}\n${stdout}`).toBeTruthy();
        const fields = parseMarker(marker);
        for (const f of REQUIRED_MARKER_FIELDS) {
          expect(Object.keys(fields), `missing '${f}' in: ${marker}`).toContain(f);
        }
      }
    });
  });

  describe('source shape: the paths too expensive to execute here', () => {
    it('defines resultLine() from the same verdict counters that decide the exit code', () => {
      // The VERDICT prefix stays byte-identical through `undeterminedTasks=`. That is the
      // compatibility contract this pin exists to enforce: green-checkpoint.ts matches the
      // marker line whole and every other reader tokenises `k=v`, so fields may only ever be
      // APPENDED after this point — never reordered, renamed, or inserted among these.
      expect(source).toMatch(
        /const resultLine = \(status\) =>\s*\n\s*`AFFECTED_TESTS_RESULT status=\$\{status\} tasks=\$\{tasks\.length\} failed=\$\{failed\} quarantinedFailed=\$\{quarantinedFailed\} timedOutTasks=\$\{timedOutTasks\} undeterminedTasks=\$\{undeterminedTasks\}`/,
      );
    });

    it('appends the coverage fields AFTER the verdict counters, never among them', () => {
      // P-006 / R-8 sub-req 5. Asserted as a separate concatenated segment on purpose: a run
      // that reports `failed=0` while having executed nothing is the failure this whole tally
      // exists to make visible, so the fields must be ON the line agents paste as evidence.
      const start = source.indexOf('const resultLine = (status) =>');
      expect(start, 'resultLine() is no longer declared as expected').toBeGreaterThan(-1);
      const decl = source.slice(start, source.indexOf(';', start));
      expect(decl).toContain('undeterminedTasks=${undeterminedTasks}`');
      // Concatenated after the verdict template, not interpolated inside it.
      expect(decl).toMatch(/\+\s*(?:\n\s*\/\/[^\n]*)*\n\s*` \$\{formatCoverageFields\(coverage\)\}`/);
    });

    it('marks a pre-launch budget refusal as not measured, not zero failures', () => {
      const refusalStart = source.indexOf('function refuseOnTaskBudget');
      const refusalEnd = source.indexOf('const SCHEDULER_CONFIG', refusalStart);
      const refusalBlock = source.slice(refusalStart, refusalEnd);
      expect(refusalBlock).toContain('AFFECTED_TESTS_RESULT status=refused tasks=0 failed=n/a');
      expect(refusalBlock).not.toContain('AFFECTED_TESTS_RESULT status=refused tasks=0 failed=0');
    });

    it('prints status=failed immediately before the process.exit(1) that follows a real failure', () => {
      // Anchor on the whole `if (failed) { ... }` block so a future edit that
      // separates the print from the exit (the exact class of bug this guards
      // against) fails this test even if it doesn't literally reorder lines.
      const failedBlock = source.match(/if \(failed\) \{[\s\S]*?\n\}/)?.[0];
      expect(failedBlock).toBeTruthy();
      expect(failedBlock).toMatch(/errSync\(resultLine\('failed'\)\);/);
      expect(failedBlock).toMatch(/process\.exit\(1\);/);
      // The result line must come BEFORE the exit call, in source order —
      // never printed by a path that a wrapper could observe as already-exited.
      expect(failedBlock!.indexOf("errSync(resultLine('failed'));")).toBeLessThan(
        failedBlock!.indexOf('process.exit(1);'),
      );
    });

    it('never prints failed=N without the per-FILE break set, on the same red path', () => {
      // EI-19391062507470442. `failed=N` counts TASKS — a (workspace × leg) unit that can
      // carry several failing FILES. Read as a file count it under-reports in the CONFIDENT
      // direction, and the two counts diverge only when more than one file fails in the same
      // workspace, i.e. precisely on the messier reds where the miscount costs most.
      // Measured 2026-08-03: `failed=2` for 3 failing files composed with "two of them are
      // already fixed" into "the gate is one run from green", and a wrong hive-wide
      // stand-down went out while four agents were converging on the real blocker.
      //
      // The remedy that landed was NOT widening this verdict line. WI-38300 ruled against
      // that in source ("widening a VERDICT contract to carry an ADVISORY is how advisories
      // come to be read as verdicts"), and green-checkpoint.ts names this same trap at the
      // point where it deliberately reads the per-file line instead. What landed
      // (EI-19395701908500754) is a SEPARATE per-file block, printed on this same red path,
      // whose first line states the tasks-vs-files distinction in words.
      //
      // That makes the whole remedy a CO-OCCURRENCE property — and nothing guarded it.
      // affected-tests-failing-files-line.test.ts proves the renderer RENDERS; it stays
      // green if the call is deleted, moved off the red path, or fed a different counter,
      // while every real red silently goes back to naming tasks only. Reachability is the
      // blind spot this file's own header names, so the binding is asserted against the red
      // block itself, where the two lines have to keep sharing a path.
      const failedBlock = source.match(/if \(failed\) \{[\s\S]*?\n\}/)?.[0];
      expect(failedBlock).toBeTruthy();
      expect(failedBlock).toContain('renderFailingFilesSummary({');
      // ORDER: the per-file set prints BEFORE the verdict line, so a triager who stops at
      // the first `AFFECTED_TESTS_RESULT` hit has already scrolled past the file list.
      expect(failedBlock!.indexOf('renderFailingFilesSummary({')).toBeLessThan(
        failedBlock!.indexOf("errSync(resultLine('failed'));"),
      );
      // SAME COUNTER. The caveat prose renders `failed=${failedTaskCount}` and the verdict
      // line renders `failed=${failed}`. Fed from different variables, the red block would
      // confidently contradict itself: two different numbers, both labelled `failed=`, a few
      // lines apart — a worse failure than the one being fixed, and invisible to the
      // renderer's own unit tests, which pass the count as a literal.
      expect(failedBlock).toMatch(
        /renderFailingFilesSummary\(\{[^}]*failedTaskCount: failed,/,
      );
    });

    it("emits resultLine('passed') on the clean-run success path", () => {
      // CODE token only. This used to also pin the prose '\nAll affected tests
      // passed.' — a latent third instance of the copy-edit-reds-the-gate bug
      // that EI-20103084274785576 removed. What a caller greps is the marker.
      expect(source).toMatch(/outSync\(resultLine\('passed'\)\);/);
    });

    it('counts a NOT CHECKED task on a NON-GATING counter — it must not fail the run', () => {
      // A real non-zero guard run needs a specially staged clean/dirty fixture and is too
      // expensive for this suite. Pin the executable counter wiring here; the classifier
      // tests separately prove that this class remains non-retryable.
      //
      // 2026-08-30 — POLARITY DELIBERATELY REVERSED. This test previously asserted
      // `undeterminedTasks++` here, i.e. that a NOT CHECKED guard keeps the run non-green.
      // That contradicted the other half of the same contract: affected-tests.mjs registers
      // these guards `notCheckedIsNonGating: true`, and
      // affected-tests-repo-wide-invariant-guards.test.ts asserts that registration with the
      // reason "registered without notCheckedIsNonGating, that answer reds the gate on every
      // candidate". Both tests were green while the two halves said opposite things, because
      // each only ever read its own side.
      //
      // The consumer was the wrong half. `classifyTaskExit` reaches this branch ONLY for a task
      // whose registration declared that "I could not look" is its EXPECTED answer here — these
      // guards read the WORKING DIFF, which is empty in a gate's clean checkout by construction.
      // Incrementing `undeterminedTasks` (the counter the verdict gates on, via
      // `hasFailures: Boolean(failed || undeterminedTasks)`) therefore red-pinned EVERY candidate
      // on a guard that had explicitly declared it had no opinion. Measured on candidate
      // 57483d0491: "NOT CHECKED (exit 2) — verdict is UNDETERMINED; ... keeping the
      // affected-tests run non-green."
      //
      // The coverage gap is still reported LOUDLY (the branch's own line, plus the
      // AFFECTED_TESTS_NOT_CHECKED marker) — it just no longer fails the run. A guard WITHOUT
      // the flag never reaches this branch and still lands in `failed`.
      const notCheckedBlock = source.match(/else if \(exitClass === 'not-checked'\) \{[\s\S]*?\n    \}/)?.[0];
      expect(notCheckedBlock).toBeTruthy();
      expect(
        notCheckedBlock,
        'the not-checked branch must NOT touch undeterminedTasks — that is the gating counter',
      ).not.toContain('undeterminedTasks++;');
      expect(notCheckedBlock).toContain('notCheckedNonGating++;');
      expect(notCheckedBlock).toContain('notCheckedTaskNames.push(taskName);');
      expect(notCheckedBlock).not.toContain('failed++;');

      // The skipped coverage still has to be announced, or a green run would silently imply
      // these invariants were checked when they were not.
      expect(source).toContain('AFFECTED_TESTS_NOT_CHECKED tasks=${notCheckedNonGating}');

      // The genuine 'undetermined' class (a child that never established a trustworthy verdict)
      // is untouched by all of the above and MUST still gate.
      expect(source).toContain('AFFECTED_TESTS_UNDETERMINED tasks=${undeterminedTasks}');
      const undeterminedBlock = source.match(/if \(!failed && undeterminedTasks\) \{[\s\S]*?\n\}/)?.[0];
      expect(undeterminedBlock).toBeTruthy();
      expect(undeterminedBlock).toContain("errSync(resultLine('failed'));");
      expect(undeterminedBlock).toContain('process.exit(1);');
    });

    it('the failure announcement and process.exit(1) remain inseparable (why the divergence cannot originate here)', () => {
      // Regression guard for the underlying claim in the EI-18796017307093897
      // comment: there is exactly one `if (failed) { ... }` block, and it always
      // ends in process.exit(1) — no code path can announce a failure and then
      // fall through to a zero exit.
      //
      // Pins CODE, not the wording: this assertion used to require the literal
      // "non-quarantined task(s) failed:", which is the same prose-pin defect
      // that reded the gate twice elsewhere in this file.
      const failedBlockMatches = source.match(/if \(failed\) \{[\s\S]*?\n\}/g);
      expect(failedBlockMatches).toHaveLength(1);
      expect(failedBlockMatches![0]).toMatch(/errSync\(/);
      expect(failedBlockMatches![0].trim().endsWith('process.exit(1);\n}'.trim())).toBe(true);
    });
  });
});

/**
 * EI-18682539587976453 — a log must say HOW the run ended, not leave it to be inferred.
 *
 * The guard above proves a marker exists on every CLEAN exit path. That leaves the
 * case the near-miss was actually about: a run that reaches NO exit path. Its log
 * then ends on whatever the last child printed — in the observed instance a clean
 * "0 errors", byte-for-byte what a healthy in-progress run looks like at that
 * instant. Absence of a verdict meant "still running" OR "died", and separating them
 * took an mtime check plus a process hunt.
 *
 * Two mechanisms close it, and they are tested here as one property: every ending is
 * either STAMPED (the `exit` fallback writes status=aborted) or CLASSIFIABLE (the
 * BEGIN line carries the pid, so `kill -0` answers from the log alone).
 */
describe('affected-tests.mjs: a terminated run leaves a self-identifying log (EI-18682539587976453)', () => {
  it('stamps status=aborted when a path exits without emitting a verdict', () => {
    // The unrecognized-flag refusal is the cheap, real instance of "exits with no
    // verdict" — it runs no children, so this executes in well under a second.
    const { stdout, stderr, status } = runAffected(['--bogus-flag-that-does-not-exist']);
    const markers = markerLines(`${stdout}${stderr}`);
    expect(markers, `expected exactly one marker line, got:\n${stdout}${stderr}`).toHaveLength(1);

    const fields = parseMarker(markers[0]);
    expect(fields.status).toBe('aborted');
    // The reason must be present and machine-readable: "aborted" alone would tell a
    // triager the run died without telling them it died before doing any work.
    expect(fields.reason).toBe('exit-without-verdict');
    expect(status).toBe(1);

    // Same field set as every other path — a reader must not need a second parser
    // for the abnormal case, which is exactly the case they are least prepared for.
    for (const f of REQUIRED_MARKER_FIELDS) {
      expect(Object.keys(fields), `missing '${f}' in: ${markers[0]}`).toContain(f);
    }
  });

  it('opens the run log with a BEGIN line carrying this run pid, so a marker-less log is still classifiable', () => {
    const { stdout } = runAffected(['--changed-paths', 'scripts/affected-tests.mjs', '--dry']);
    const runLog = /Full run log: (\S+)/.exec(stdout)?.[1];
    expect(runLog, `no run-log path announced in:\n${stdout}`).toBeTruthy();

    const begin = readFileSync(runLog!, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('AFFECTED_TESTS_BEGIN '));
    expect(begin, `no AFFECTED_TESTS_BEGIN line in ${runLog}`).toBeTruthy();

    const pid = Number(/\bpid=(\d+)\b/.exec(begin!)?.[1]);
    // The pid is the whole point of the line: it is what turns "no verdict here"
    // into a decidable `kill -0 <pid>` instead of a pgrep pattern that self-matches.
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    // Tie the line to THIS run. The run token also keys the log filename, so a BEGIN
    // line whose pid belongs to some other run would be worse than no line at all.
    expect(begin).toMatch(new RegExp(`\\brun=${pid}-[0-9a-f]+\\b`));
    expect(runLog).toContain(String(pid));
  });

  it('retains full-run evidence outside TMPDIR while sweeping stale task scratch', () => {
    const isolatedTmp = mkdtempSync(join(tmpdir(), 'affected-tests-log-root-'));
    const logRoot = join(isolatedTmp, 'papercusp-affected-tests');
    const stale = join(logRoot, 'stale.log');
    const recent = join(logRoot, 'recent.log');
    mkdirSync(logRoot);
    writeFileSync(stale, 'old');
    writeFileSync(recent, 'young');
    const fiveHoursAgo = (Date.now() - 5 * 60 * 60 * 1_000) / 1_000;
    utimesSync(stale, fiveHoursAgo, fiveHoursAgo);
    let runLog: string | undefined;

    try {
      const { stdout, status } = runAffected(['--changed-paths', 'scripts/affected-tests.mjs', '--dry'], {
        TMPDIR: isolatedTmp,
        TMP: isolatedTmp,
        TEMP: isolatedTmp,
        // WI-10005970: this case pins scratch cleanup, not the headroom policy. The child re-applies
        // tmpdir-guard, which relocates a low-headroom TMPDIR to /dev/shm and so ignores the
        // TMPDIR above. Pin the critical floors near zero so host disk state cannot decide it.
        PAPERCUSP_DISK_ALARM_CRITICAL_PCT: '0.000001',
        PAPERCUSP_DISK_ALARM_CRITICAL_GB: '0.000001',
      });
      runLog = /Full run log: (\S+)/.exec(stdout)?.[1];

      expect(status).toBe(0);
      expect(runLog, `no run-log path announced in:\n${stdout}`).toBeTruthy();
      expect(dirname(runLog!)).toBe(join(homedir(), '.papercusp', 'logs', 'papercusp-affected-tests'));
      expect(existsSync(runLog!)).toBe(true);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(recent)).toBe(true);
    } finally {
      if (runLog && existsSync(runLog)) unlinkSync(runLog);
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });

  it('registers NO signal handler — the trap is the obvious fix and it breaks killability', () => {
    // SOURCE SHAPE by necessity: falsifying this behaviourally needs a real multi-minute
    // run to kill, which is the documented exception this file allows. It pins a CODE
    // property, never prose.
    //
    // WHY IT IS WORTH A GUARD. Adding `process.on('SIGTERM', …)` to write the missing
    // marker is the intuitive fix, and it is what the filing proposed. Measured on this
    // script 2026-08-12: it left a group-SIGTERM'd run ALIVE and marker-less 105s later,
    // reapable only by SIGKILL. Registering a listener removes the default disposition,
    // and this script's run loop is a synchronous chain of spawnSync calls that never
    // yields the event-loop turn the handler would need — so the trap buys no marker and
    // costs promptness, against a repo where kill discipline is load-bearing.
    //
    // SECOND, INDEPENDENT REASON (WI-42144), because the first one alone reads as a
    // tractable engineering problem someone may believe they have solved. This guard is
    // ALSO what keeps a pc-heavy retry series from emitting contradictory verdict lines.
    // test:affected runs under PC_HEAVY_RETRY_PREEMPTIONS=3 (up to 4 attempts), pc-heavy
    // isolates only STDOUT between attempts, and affected-tests.mjs emits its entire
    // FAILURE surface on stderr — status=failed, AFFECTED_TESTS_FAILING_FILES and the
    // failing-task bullets — while status=passed goes to stdout; green-checkpoint parses
    // the two concatenated. With no trap a preempted attempt dies before any terminal
    // path and contributes no verdict line, so there is nothing to duplicate. Add the
    // trap and preempted attempts begin writing terminal markers into a stream nothing
    // deduplicates. Removing this guard is therefore not just a killability regression.
    //
    // Judged over CODE lines only. The block that explains this rule necessarily
    // WRITES `process.on('SIGTERM', …)` to warn about it, so judging the whole file
    // fires on the documentation of the bug itself — the same prose-vs-code trap
    // `doc-claims/machine-line-grep-anchors.ts` scopes around for the same reason.
    const codeOnly = source
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const signalTrap = /process\.(on|once)\(\s*['"`]SIG/.exec(codeOnly);
    expect(
      signalTrap?.[0],
      'A signal handler was added to affected-tests.mjs. That makes the runner ' +
        'un-killable without buying the marker it was added for — see the comment at ' +
        "the process.on('exit') block. Read it before removing this guard.",
    ).toBeUndefined();
  });

  it('journals a settled task before publishing its finished pulse, then skips duplicate log replay (EI-21495798160539116)', () => {
    // Executing the production path would require overlapping real workspace
    // suites and killing the aggregate runner only after one child settles. Pin
    // the two load-bearing order edges in source, while sync-write's behavioural
    // test proves the actual multipart append survives the following SIGTERM.
    const closeStart = source.indexOf("child.once('close', (status, signal) => {");
    const journal = source.indexOf('result.__outputJournaled = journalCapturedTaskOutput(', closeStart);
    const finishedPulse = source.indexOf('emitProgress(', journal);
    const resolve = source.indexOf('resolveRun(result);', finishedPulse);

    expect(closeStart).toBeGreaterThanOrEqual(0);
    expect(journal, 'settled output must be synchronously journaled in the child close path').toBeGreaterThan(
      closeStart,
    );
    expect(finishedPulse, 'the externally visible finished pulse must follow the durable journal').toBeGreaterThan(
      journal,
    );
    expect(resolve, 'the scheduler may receive the result only after journaling and the pulse').toBeGreaterThan(
      finishedPulse,
    );

    const journalStart = source.indexOf('function journalCapturedTaskOutput(');
    const journalEnd = source.indexOf('\n}\n\nfunction emitCapturedTaskOutput(', journalStart);
    const journalBody = source.slice(journalStart, journalEnd);
    expect(journalBody).toContain('appendAllSync(RUN_LOG_PATH, [');
    expect(journalBody).toContain('AFFECTED_TASK_OUTPUT_BEGIN');
    expect(journalBody).toContain('stdout,');
    expect(journalBody).toContain('stderr,');
    expect(journalBody).toContain('AFFECTED_TASK_OUTPUT_END');

    const replayStart = source.indexOf('function emitCapturedTaskOutput(');
    const replayEnd = source.indexOf('\n}\n\n/** Return the exact exit-0', replayStart);
    const replay = source.slice(replayStart, replayEnd);
    expect(replay).toContain('if (!r.__outputJournaled) {');
    expect(replay).toContain("logLine(r.stdout ?? '');");
    expect(replay).toContain("logLine(r.stderr ?? '');");
  });

  it('publishes the pc-heavy finalization barrier after the initial task pool settles', () => {
    const finalizationEnv = source.indexOf('PC_HEAVY_PSI_FINALIZATION_FILE');
    const publishFn = source.indexOf('function publishPreemptFinalizationMarker');
    // WI-1490656: the shard call is now inside a try/catch (admission starvation must report
    // a refusal rather than die as an uncaught rejection), so the declaration moved to a
    // preceding `let`. The ordering asserted below is unchanged.
    const initialPool = source.indexOf('initialPool = await runBudgetedTaskShards');
    const publishCall = source.indexOf('publishPreemptFinalizationMarker();', initialPool);
    const resultLine = source.indexOf('const resultLine = (status) =>');

    expect(finalizationEnv).toBeGreaterThanOrEqual(0);
    expect(publishFn).toBeGreaterThan(finalizationEnv);
    expect(initialPool).toBeGreaterThanOrEqual(0);
    expect(publishCall).toBeGreaterThan(initialPool);
    expect(publishCall).toBeLessThan(resultLine);
    expect(source).toContain("flag: 'wx'");
    expect(source).toContain('PC_HEAVY_PSI_FINALIZATION pid=');
    expect(source).toContain('cleanupPreemptFinalizationMarker();');
  });
});
