/**
 * undrained-stdout-exit-guard.test.ts — EI-20055889379250637
 *
 * Proves `scripts/check-undrained-stdout-exit.mjs` DISCRIMINATES. A lint nobody has
 * watched fail is not a guard: it is a script that has only ever agreed with the tree.
 * Every case below therefore asserts a DIFFERENCE — vulnerable flagged, fixed clean —
 * rather than asserting that the current tree happens to pass.
 *
 * ── THE DEFECT BEING GUARDED, AND ITS MEASUREMENT ───────────────────────────
 * Writes to a PIPE are async in Node; `process.exit()` does not drain them, so output
 * is cut at whatever flushed synchronously. Measured on this box, deterministic x3 —
 * `node -e "console.log('x'.repeat(N)); process.exit(0)" | wc -c`:
 *   N=8000 -> 8001 (survives)   N=16384 -> 8192   N=200000 -> 8192
 * §1 below re-runs that measurement as a live control, so the premise of this whole
 * guard is asserted rather than quoted. (The filing that prompted the guard recorded
 * "64 KiB / 65,536"; that was a timing-dependent observation with a slower reader, not
 * a threshold. ~8 KiB is already unsafe.)
 *
 * It matters because it fails ONLY under a pipe — a TTY and a `> file` redirect are
 * both synchronous — so it is invisible to interactive testing, and a truncated
 * MEASUREMENT parses as FEWER FINDINGS, i.e. reads as CLEANER.
 *
 * ── WHY FIXTURES AND NOT TREE MUTATION ──────────────────────────────────────
 * Proving falsifiability by mutating a tracked file is unsafe here: git-sync commits
 * the whole working tree on a schedule, so a probe that holds a file mutated for the
 * length of a suite can have the mutant COMMITTED even when nothing fails and no
 * handler is skipped (CLAUDE.md, "Proving a guard is falsifiable"). Every case below
 * feeds the detector in-memory instead — no tracked file is ever modified.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs guard script with no type declarations; the pure detector is
// exported precisely so this test can drive it without spawning a process per case.
import { findOffendersInSource, walk } from '../../../scripts/check-undrained-stdout-exit.mjs';
import { runGuardScript } from './testing-guard-script';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const flagged = (src: string): number => (findOffendersInSource('fixture.mjs', src) as unknown[]).length;

describe('the mechanism this guard exists for (live control)', () => {
  it('truncates a large payload through a PIPE when process.exit() follows, and does not without it', () => {
    const run = (code: string) =>
      Number(
        execFileSync('bash', ['-c', `node -e ${JSON.stringify(code)} | wc -c`], {
          encoding: 'utf8',
          timeout: 30_000,
        }).trim(),
      );

    const N = 200_000;
    const withExit = run(`console.log('x'.repeat(${N})); process.exit(0)`);
    const withoutExit = run(`console.log('x'.repeat(${N}))`);
    const withExitCode = run(`console.log('x'.repeat(${N})); process.exitCode = 0`);

    // The defect: the payload is CUT. Assert only THAT — never how many bytes survive.
    // How much flushes before process.exit() is a SCHEDULING artifact (how far the
    // reader drained the pipe before the writer died), not a property of the mechanism.
    // Measured on this box across runs: 8_192, 65_536 and 81_920 — the last under gate
    // load. An absolute `toBeLessThanOrEqual(65_536)` bound here therefore went RED
    // under fleet load and GREEN on an idle box (WI-2141324), and 65_536 was the MODAL
    // value rather than a ceiling, so the control sat exactly on its own bound.
    // A flake in a guard's own positive control is worse than an ordinary flake: red
    // reads as "the guard found something", green as "someone fixed it" — neither true.
    // This stays falsifiable: were pipe writes ever to become synchronous, the payload
    // would arrive whole, withExit would be N + 1, and this assertion would red.
    expect(withExit).toBeLessThan(N);
    // The two controls: both remedies deliver the payload IN FULL.
    expect(withoutExit).toBe(N + 1);
    expect(withExitCode).toBe(N + 1);
  });

  it('preserves the exit status when process.exitCode replaces process.exit', () => {
    const status = execFileSync(
      'bash',
      ['-c', `node -e "console.log('x'.repeat(200000)); process.exitCode = 3" > /dev/null; echo $?`],
      { encoding: 'utf8', timeout: 30_000 },
    ).trim();
    expect(status).toBe('3');
  });
});

describe('shapes the guard MUST flag', () => {
  it('a JSON.stringify dump followed by process.exit', () => {
    expect(flagged('console.log(JSON.stringify(census, null, 2));\nprocess.exit(0);\n')).toBe(1);
  });

  it('an accumulated value followed by process.exit', () => {
    expect(flagged('let out = collect();\nconsole.log(out);\nprocess.exit(1);\n')).toBe(1);
  });

  it('a loop of writes followed by process.exit — the TOTAL output is what truncates', () => {
    expect(flagged('for (const line of lines) console.log(line);\nprocess.exit(code);\n')).toBe(1);
  });

  it('stderr, which truncates identically to stdout', () => {
    expect(flagged('console.error(JSON.stringify(findings));\nprocess.exit(1);\n')).toBe(1);
  });

  it('process.stdout.write, not just console.log', () => {
    expect(flagged('process.stdout.write(JSON.stringify(report));\nprocess.exit(0);\n')).toBe(1);
  });

  it('an exit separated from the write by a couple of statements', () => {
    expect(flagged('console.log(JSON.stringify(x));\nconst n = x.length;\nlog(n);\nprocess.exit(0);\n')).toBe(1);
  });
});

describe('shapes the guard MUST NOT flag', () => {
  it('process.exitCode instead of process.exit — the prescribed fix', () => {
    expect(flagged('console.log(JSON.stringify(census, null, 2));\nprocess.exitCode = 0;\n')).toBe(0);
  });

  it('a write with no process.exit at all — Node drains before a natural exit', () => {
    expect(flagged('console.log(JSON.stringify(census, null, 2));\n')).toBe(0);
  });

  it('a synchronously drained write, even with process.exit', () => {
    expect(flagged('writeStdoutSync(JSON.stringify(census, null, 2));\nprocess.exit(0);\n')).toBe(0);
  });

  it('a caught error — bounded, and a diagnostic rather than piped output', () => {
    expect(flagged('try { go(); } catch (e) {\n  console.error(e);\n  process.exit(1);\n}\n')).toBe(0);
  });

  it('a usage message built from literals', () => {
    expect(flagged("console.error('usage: tool <arg>');\nprocess.exit(2);\n")).toBe(0);
  });

  it('a module-level static string constant, including `.trim()`-wrapped help text', () => {
    // scripts/lint-as-committed.mjs:199 is exactly this shape — the initialiser is a
    // CallExpression, not a template, which an earlier cut of the rule mis-flagged.
    expect(flagged('const USAGE = `usage: x`.trim();\nprocess.stdout.write(USAGE);\nprocess.exit(0);\n')).toBe(0);
  });

  it('a formatter call — a message, not an accumulated value', () => {
    expect(flagged('console.error(red(`failed: ${msg}`));\nprocess.exit(1);\n')).toBe(0);
  });

  it('a LOCAL const holding a static diagnostic — where the author put it is not the question', () => {
    expect(flagged("function m(){ const msg = 'usage: thing'; console.error(msg); process.exit(1); }")).toBe(0);
  });

  it('a guarded notice from a module-local helper that only ever returns a template', () => {
    // The real false positive that prompted this: apps/operator/scripts/psu-launcher.mjs
    // hoists a one-line model-compatibility notice into a helper, which made a ~120-char
    // MESSAGE read exactly like an accumulated buffer. Bounded payloads of this size are
    // three orders of magnitude under the ~8 KiB sync-flush window.
    expect(
      flagged(
        'function notice(m){ if (!m) return null; return `fallback — ${m} is remapped.`; }\n' +
          'function m(){ const t = c ? notice(x) : null; if (t) console.error(t); process.exit(1); }',
      ),
    ).toBe(0);
  });
});

/**
 * The resolution added for the two cases above widens what counts as BOUNDED, and a
 * widened exemption is exactly how a guard gets silently retired. These pin the blast
 * radius: every shape the rule exists to catch must STILL fail after the widening.
 */
describe('the widening did NOT retire the rule (negative controls)', () => {
  it('STILL flags the archetypal `let` accumulator, whose initialiser IS a static string', () => {
    // The load-bearing case. `let out = ''` + `out += …` is the guard's single biggest
    // target, and its initialiser is a string literal — so resolving `let` (rather than
    // `const` only) would mark it bounded and quietly kill the rule. This is that test.
    expect(
      flagged("function m(){ let out=''; for (const r of rows) out += r; console.log(out); process.exit(0); }"),
    ).toBe(1);
  });

  it('STILL flags a `let` that held a literal before being reassigned to data', () => {
    expect(flagged("function m(){ let msg = 'x'; msg = big; console.error(msg); process.exit(1); }")).toBe(1);
  });

  it('STILL flags a const initialised from a helper that returns DATA', () => {
    expect(
      flagged(
        "function collect(){ const a=[]; return a.join('\\n'); }\n" +
          'function m(){ const out = collect(); console.log(out); process.exit(0); }',
      ),
    ).toBe(1);
  });

  it('STILL flags a helper with ONE data-derived return among literal ones', () => {
    // Every return must be static; one dump disqualifies the whole helper.
    expect(
      flagged(
        "function mk(x){ if (x) return 'lit'; return buf.toString(); }\n" +
          'function m(){ const s = mk(1); console.error(s); process.exit(1); }',
      ),
    ).toBe(1);
  });

  it('STILL flags a const from an IMPORTED helper — an unseen body is not a bounded one', () => {
    expect(
      flagged("import { mk } from './x.mjs';\nfunction m(){ const s = mk(1); console.error(s); process.exit(1); }"),
    ).toBe(1);
  });

  it('an exit that is NOT in the write’s synchronous path', () => {
    expect(flagged('console.log(JSON.stringify(x));\nprocess.on("SIGINT", () => process.exit(0));\n')).toBe(0);
  });

  it('the pattern appearing only inside a COMMENT', () => {
    // The first cut of this guard used regex masking and reported a doc comment that
    // merely QUOTED the bad pattern. Parsing with the TypeScript AST makes that
    // impossible; this pins it. (Masking bug filed as EI-20059456952698638.)
    expect(flagged('/* console.log(big); process.exit(0) is the bug */\nconst x = 1;\n')).toBe(0);
  });

  it('code following a regex literal that contains a quote character', () => {
    // The precise shape that broke the regex-masking approach: the quote inside the
    // regex opened a phantom string that blanked the rest of the file, so real
    // offenders after it became INVISIBLE. Asserts the detector still sees past it.
    expect(flagged('const re = /^["\'`]([^"\'`]+)["\'`]$/;\nconsole.log(JSON.stringify(x));\nprocess.exit(0);\n')).toBe(1);
  });
});

describe('the walk skips gitignored bundle output (WI-6554700010018888)', () => {
  // A shared-tree run used to go red on `apps/operator/dist-host*/` bundles: gitignored,
  // absent from the gate's clean checkout, so the shared-tree verdict and the gate's
  // verdict disagreed. `dist-*` must be skipped like `dist`; a source dir that merely
  // STARTS with "dist" must still be scanned, or the exclusion has eaten real code.
  it('skips dist and dist-* directories but still walks a dist-prefixed source dir', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'undrained-walk-'));
    try {
      const files: Record<string, string> = {
        'dist/a.mjs': '',
        'dist-host/b.mjs': '',
        'dist-host-native-fixture-debug-123/c.mjs': '',
        'distribution/d.mjs': '',
        'src/e.mjs': '',
      };
      for (const rel of Object.keys(files)) {
        mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        writeFileSync(path.join(root, rel), files[rel]);
      }
      const walked = (walk(root) as string[]).map((f) => path.relative(root, f)).sort();
      expect(walked).toEqual(['distribution/d.mjs', 'src/e.mjs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the tree is currently clean (ratchet)', () => {
  it('runs the guard over the real repository and finds no unbaselined offender', () => {
    // Execs the guard over REPO_ROOT so this counts as ENFORCEMENT, not merely a unit
    // test of its helpers: check-lint-guard-reachability classifies a test that only
    // feeds fixtures as `logic-test` (ADVISORY), which lets the ratchet rot silently.
    //
    // ⚠ Read the report BEFORE judging the status, and never re-introduce execFileSync
    // here. The guard prints its findings to stdout and only THEN sets exitCode=1, so on
    // a red the report exists — but execFileSync THROWS on a non-zero exit, and its
    // Error surfaces only "Command failed: <cmd>" as the message (the output survives as
    // an unrendered `.stdout` property nobody reads). This assertion used to do exactly
    // that, and paid for it: 8 reds over 6h across 4
    // commits all reported the same "Command failed: node scripts/check-undrained-
    // stdout-exit.mjs --json", naming no file, and the offender (ONE line, in a script a
    // peer had just added) was recoverable only by hand-running the guard — which three
    // separate wakes each did from scratch. The tree here is shared and swept, so any
    // peer can red this at any time; the report has to survive the failure.
    // EI-20692923474318761.
    const guard = runGuardScript('node', ['scripts/check-undrained-stdout-exit.mjs', '--json'], {
      cwd: REPO_ROOT,
      timeoutMs: 180_000,
    });

    let report: {
      filesScanned: number;
      unbaselined: { file: string; line: number; why: string }[];
      staleBaseline: string[];
    };
    try {
      report = JSON.parse(guard.stdout);
    } catch {
      // A crash, a timeout, or a truncated buffer lands here — all of which would
      // otherwise surface as an opaque JSON parse error about position 0.
      throw new Error(`the guard produced no parseable --json report:\n${guard.output}`);
    }

    // A scan that measured nothing would pass vacuously — assert it really walked the tree.
    expect(report.filesScanned).toBeGreaterThan(1000);

    // Rendered as `file:line — why` STRINGS rather than compared as objects, so the
    // vitest diff itself names the offender and its reason. That diff is what gets
    // captured as the failure tail downstream (the watchdog files a bug from it), which
    // is the difference between a red that hands over the fix and one that hides it.
    expect(
      report.unbaselined.map((o) => `${o.file}:${o.line} — ${o.why}`),
      'Fix each site: 1. `process.exitCode = N` and let the program end naturally; ' +
        '2. drop the process.exit() when the status is 0 and nothing follows; ' +
        '3. must exit immediately? use writeStdoutSync from scripts/lib/write-stdout-sync.mjs. ' +
        'Do NOT baseline it — BASELINE is shrink-only.',
    ).toEqual([]);

    expect(report.staleBaseline, 'BASELINE entries matching no site — delete them').toEqual([]);

    // The script's exit STATUS must agree with its own report. An inverted exitCode
    // would make every other consumer — the npm lint entry, the gate — read a dirty
    // tree as clean, and no assertion above would notice.
    expect(guard.status, guard.output).toBe(0);
  }, 240_000);
});
