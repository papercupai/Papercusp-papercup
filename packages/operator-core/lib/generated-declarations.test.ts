/**
 * The repo's `.mjs` modules that TypeScript imports ship GENERATED `.d.mts`
 * declarations, driven by `tsconfig.declarations.json` (WI-6394). This guards
 * them.
 *
 * Two independent failure modes, and neither test catches the other's:
 *
 *  1. STALENESS — someone edits a `.mjs` and does not re-run
 *     `npm run gen:declarations`, so the committed declaration describes code
 *     that no longer exists. This is the failure the repo has already paid for
 *     twice on the previously HAND-WRITTEN `scripts/lint-tsc.d.mts`, where an
 *     export added to the `.mjs` and forgotten in the `.d.mts` became TS2305 for
 *     every importer.
 *
 *  2. SILENT WIDENING — generation runs, the committed files match, but the
 *     emitted types have degraded to `any`. A byte-compare is BLIND to this:
 *     regenerate after the source stops producing types and both sides agree on
 *     the same worthless output.
 *
 * Mode 2 is not hypothetical. Its sibling change (EI-18804531117413708) found a
 * complete `@param` block that had drifted ABOVE a `const`, so TypeScript bound
 * it to that const instead of to the function — every `@param` inert and all
 * four parameters `any`, in a function that read as fully documented. Anything
 * placed between a JSDoc block and its declaration detaches it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readDeclaration(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/**
 * One `--check` run, shared by the drift verdict and the compiler-identity guard
 * below. Memoized because the generator cold-start is ~6s and both tests need the
 * SAME run — asserting the compiler against a second invocation would let the two
 * disagree about which compiler the verdict came from, which is precisely the
 * confusion being guarded against.
 *
 * Output is captured on BOTH paths: the compiler line is printed before the
 * comparison, so it is present in a failing run too.
 */
let checkRun: { ok: boolean; out: string } | undefined;
function runCheck(): { ok: boolean; out: string } {
  if (!checkRun) {
    try {
      // The test runner injects committed-source-loader before TSX. Use TSX's explicit ESM
      // entry so this CommonJS-scoped script resolves .js specifiers to .ts sources without
      // relying on Node's unsupported default-type option.
      const out = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx/esm',
          'scripts/gen-declarations.ts',
          '--check',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 120_000,
          killSignal: 'SIGKILL',
        },
      );
      checkRun = { ok: true, out };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      checkRun = { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }
  return checkRun;
}

describe('generated .d.mts declarations', () => {
  it('are up to date with their .mjs sources — run `npm run gen:declarations` if this fails', () => {
    // Delegates to the SAME `--check` the CI script runs, so the test and the
    // build cannot disagree about what "up to date" means. It regenerates into a
    // temp dir and compares; it never writes into this shared working tree.
    const { ok, out } = runCheck();
    if (!ok) throw new Error(`gen:declarations:check failed:\n${out}`);
  // The generator cold-start measured 6.1s while the checkpoint was running;
  // Vitest's 5s default made a correct declaration set fail before `--check`
  // could return. Keep the real generator verdict authoritative.
  }, 30_000);

  // WI-40183. A declaration is a function of (source, COMPILER), so the compiler is
  // an INPUT and has to be pinned like one. This generator used to reach for
  // `node_modules/.bin/tsc` — a slot that is first-come-first-served across every
  // installed package shipping a `tsc` bin, so its identity changes when the
  // dependency TREE changes, with no edit to this repo. Installing
  // `@typescript/native` (TypeScript 7) silently repointed it, and all 52 committed
  // declarations — byte-identical to their sources under the pinned TypeScript 6 —
  // went stale in one step and froze a green-checkpoint candidate.
  //
  // The staleness test above cannot catch this and never will: whichever compiler
  // wins, `--check` regenerates and compares against ITSELF, so it is perfectly
  // consistent while measuring the wrong thing. That symmetry is the real hazard —
  // the same ambient slot can false-GREEN a genuinely drifted declaration just as
  // easily as it false-RED'd 52 correct ones. Only the compiler CHOICE is checkable,
  // which is why the generator prints it and this pins it.
  it('are generated by the pinned `typescript` package, not the ambient .bin/tsc slot (WI-40183)', () => {
    const { out } = runCheck();

    // Positive control first: a `.not.toContain` over EMPTY output passes vacuously,
    // so prove the run actually reported a compiler before trusting the absence below.
    expect(out, 'the generator no longer reports which compiler it used').toMatch(/compiler:\s*\S+/);
    expect(
      out,
      'declarations are being generated by something other than the pinned `typescript` package',
    ).toContain(join('node_modules', 'typescript', 'lib', 'tsc.js'));
    expect(
      out,
      'the compiler is being resolved through node_modules/.bin/tsc again — any installed package shipping a `tsc` bin can claim that slot',
    ).not.toContain(join('node_modules', '.bin', 'tsc'));
  }, 30_000);

  it('stay genuinely typed — a byte-compare cannot catch types silently widening to `any`', () => {
    // Each assertion below pins a type that is only produced because the source's
    // JSDoc is actually being applied. If a JSDoc block is detached (or deleted),
    // these regenerate as `any` and a byte-compare would happily agree with
    // itself; only this test notices.
    const quarantine = readDeclaration('scripts/lib/quarantine.d.mts');
    expect(quarantine, 'parseQuarantineWorkspaces lost its JSDoc types').toMatch(
      /parseQuarantineWorkspaces\(text:\s*string\):\s*Set<string>/,
    );

    const boundary = readDeclaration('scripts/check-transitive-boundary.d.mts');
    expect(boundary, 'check-transitive-boundary.mjs is the best-documented of these — it should not be all `any`').not.toMatch(
      /^export function \w+\(\w+: any\): any;$/m,
    );

    // Return types are inferred from the IMPLEMENTATION, not from JSDoc, so they
    // hold even for the undocumented modules — which makes them a good canary for
    // "did the emit silently collapse".
    const migrations = readDeclaration('scripts/lint-migrations.d.mts');
    expect(migrations, 'lint-migrations return types collapsed').toMatch(
      /findRawTxControl\([^)]*\):\s*string\[\];/,
    );
    // TypeScript declaration emit has used both `const X: 494` and `declare const X = 494`.
    // Pin the numeric literal while accepting either equivalent ambient spelling.
    expect(migrations, 'const literal types collapsed').toMatch(
      /ENFORCED_FROM(?:\s*:\s*\d+|\s*=\s*\d+)/,
    );

    // EI-23158211753028699: defaulting an unannotated JS option to `undefined`
    // made declaration emit infer `operatorUrl?: undefined`, even though the
    // implementation accepts an explicit URL and multiple TS callers pass one.
    const psuLauncher = readDeclaration('apps/operator/scripts/psu-launcher.d.mts');
    expect(psuLauncher, 'ensureCodexHomeViaOperator.operatorUrl narrowed to undefined again').toMatch(
      /ensureCodexHomeViaOperator[\s\S]*?operatorUrl\?:\s*string\s*\|\s*undefined;/,
    );
  });

  // WI-6396 converted these four from HAND-WRITTEN declarations. The hand-written
  // files carried real parameter types that the sources' JSDoc did not, so the
  // conversion moved that information into the `.mjs` as `@param` tags. Each
  // assertion below pins a type that exists ONLY because those tags are applied —
  // i.e. it fails in exactly the case a byte-compare cannot see, where the tags are
  // deleted or detached and generation quietly re-emits `any`. Before this item,
  // dropping any of these was a silent loss of checking for every importer.
  it('preserve the parameter types their hand-written predecessors carried (WI-6396)', () => {
    const syncWrite = readDeclaration('scripts/lib/sync-write.d.mts');
    expect(syncWrite, 'writeAllSync lost `fd: number` — a string fd would now typecheck').toMatch(
      /writeAllSync\(fd:\s*number,\s*text:\s*unknown\):\s*void;/,
    );
    expect(syncWrite, 'outSync/errSync lost their optional-parameter shape').toMatch(
      /outSync\(msg\?:\s*unknown\):\s*void;/,
    );

    const procGuard = readDeclaration('scripts/proc-guard.d.mts');
    expect(procGuard, 'parseCmdline lost `Buffer | string`').toMatch(
      /parseCmdline\(raw:\s*Buffer\s*\|\s*string\):\s*string;/,
    );
    // The richest type here: nothing in the implementation reveals the Map's value
    // type, so this survives only via the `@param` tag.
    expect(procGuard, 'getAncestryChain lost its Map<number, number | null> parameter type').toMatch(
      /getAncestryChain\(pid:\s*number,\s*byPid:\s*Map<number,\s*number\s*\|\s*null>/,
    );
    expect(procGuard, 'ProcRow type collapsed').toMatch(/ppid:\s*number\s*\|\s*null;/);

    const viteGate = readDeclaration('scripts/lint-tsc-operator-vite.d.mts');
    // `@type {string}` deliberately widens the const off its literal type; losing
    // the tag re-narrows it to the literal command string.
    expect(viteGate, 'TSC_COMMAND lost its `@type {string}` annotation').toMatch(
      /TSC_COMMAND:\s*string;/,
    );
    expect(viteGate, 'ForeignBaseline.label stopped being optional').toMatch(
      /label\?:\s*string(?:\s*\|\s*undefined)?;/,
    );

    const vacuous = readDeclaration('scripts/check-vacuous-negative-assertions.d.mts');
    // The named types are what the importing test drives the judge with; losing any of
    // them degrades that whole test file to `any` without failing anything.
    expect(vacuous, 'VacuousVerdict stopped being a literal union').toMatch(
      /VacuousVerdict\s*=\s*['"]DRIFTED['"]\s*\|\s*['"]ORPHANED['"]/,
    );
    expect(vacuous, 'VacuousFinding lost its verdict/fragment types').toMatch(
      /verdict:\s*VacuousVerdict;[\s\S]*?fragment:\s*string\s*\|\s*null;/,
    );
    expect(vacuous, 'IncludesFn stopped being a function type').toMatch(
      /IncludesFn\s*=\s*\(needle:\s*string\)\s*=>\s*boolean/,
    );
    // The most fragile type here: `residue` is built as an array literal, which infers as
    // `string[]`. The fixed-pair tuple exists ONLY because driftFragment's `@returns`
    // spells it out, so this is the first thing to disappear if that tag is touched.
    expect(vacuous, 'driftFragment.residue decayed from a [string, string] tuple').toMatch(
      /residue:\s*\[string,\s*string\];/,
    );

    // scripts/lint-tsc.mjs is a thin re-export shim over tsc-baseline-gate.mjs, so its
    // declaration inherits ITS types. That is the largest widening risk in this change:
    // if tsc-baseline-gate loses its JSDoc, all nine re-exported functions degrade to
    // `any` at once, in the module the whole fleet's type gate runs through.
    const gate = readDeclaration('scripts/lib/tsc-baseline-gate.d.mts');
    expect(gate, 'parseTscErrors lost `tscOutput: string`').toMatch(
      /parseTscErrors\(tscOutput:\s*string\):\s*TscErrorEntry\[\]/,
    );
    expect(gate, 'syntaxBrokenFiles/countByFile stopped taking TscErrorEntry[]').toMatch(
      /countByFile\(errors:\s*TscErrorEntry\[\]\):\s*Record<string,\s*number>/,
    );
    expect(gate, 'parseExplicitFiles lost its `Set<string> | null` contract').toMatch(
      /parseExplicitFiles\(argv:\s*string\[\]\):\s*Set<string>\s*\|\s*null/,
    );
    // The verdict vocabulary is the gate's actual decision surface; a collapse to
    // `string` would let any typo typecheck.
    expect(gate, 'PerFileGateVerdict collapsed from its literal union').toMatch(
      /PerFileGateVerdict\s*=\s*['"]fail-syntax['"][\s\S]*?\|\s*['"]ok['"];/,
    );
  });

  it('keep lint-tsc.d.mts a re-export of tsc-baseline-gate, not a second copy of its contract (WI-6396)', () => {
    // The hand-written predecessor RESTATED all of tsc-baseline-gate's types beside a
    // module that merely re-exports them, so an export added to the gate had to be
    // remembered in a declaration one directory away. It was not, twice
    // (`parseExplicitFiles`, `formatAttributionHeadline`), and each miss was TS2305 for
    // every importer. Re-exporting makes that structurally impossible; restating it here
    // by hand again would quietly reintroduce the whole defect class.
    const lintTsc = readDeclaration('scripts/lint-tsc.d.mts');
    expect(lintTsc, 'lint-tsc.d.mts no longer re-exports from the gate module').toMatch(
      /from\s*'\.\/lib\/tsc-baseline-gate\.mjs'/,
    );
    expect(
      lintTsc,
      'lint-tsc.d.mts has started RESTATING the gate types instead of re-exporting them',
    ).not.toMatch(/export\s+(?:declare\s+)?(?:type|interface)\s+(?:TscErrorEntry|PerFileGateResult)\b/);
    // It owns exactly one thing.
    expect(lintTsc, 'TSC_COMMAND lost its `@type {string}` annotation').toMatch(
      /TSC_COMMAND:\s*string;/,
    );
  });

  it('exist for every module the config lists — a missing one silently reverts that importer to `any`', () => {
    const raw = readFileSync(join(REPO_ROOT, 'tsconfig.declarations.json'), 'utf8');
    const files = (JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { files: string[] }).files;

    expect(files.length, 'tsconfig.declarations.json lists no files').toBeGreaterThan(0);
    for (const mjs of files) {
      const dts = mjs.replace(/\.mjs$/, '.d.mts');
      expect(() => readDeclaration(dts), `${dts} is missing — run \`npm run gen:declarations\``).not.toThrow();
    }
  });

  // EI-18809220546046680. `tsc --declaration` emits no provenance of its own, so a
  // generated declaration is indistinguishable from the hand-written ones this repo
  // used until WI-6396 retired them. Someone opens one, edits it as if it were the
  // source — the natural thing, since that WAS the convention — and their work is
  // silently discarded by the next generate, or reds the check for the whole fleet
  // with an error that never explains where their change went.
  //
  // The marker string is duplicated from `scripts/gen-declarations.ts` rather than
  // imported ON PURPOSE: that module runs `generate()` at top level, so importing it
  // from a test would emit declarations into this shared working tree as a side
  // effect of collecting the suite.
  it('carry a GENERATED / DO NOT EDIT banner, below any shebang (EI-18809220546046680)', () => {
    const raw = readFileSync(join(REPO_ROOT, 'tsconfig.declarations.json'), 'utf8');
    const files = (JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { files: string[] }).files;

    for (const mjs of files) {
      const dts = mjs.replace(/\.mjs$/, '.d.mts');
      const text = readDeclaration(dts);

      expect(text, `${dts} lost its GENERATED banner — see stamp() in scripts/gen-declarations.ts`).toContain(
        '// GENERATED by `npm run gen:declarations`',
      );
      // Names its own source, so a reader lands on the right file to edit.
      expect(text, `${dts}'s banner does not name ${mjs} as its source`).toContain(mjs);

      // The banner must go BELOW a shebang, never above it. `tsc` copies the source's
      // `#!` line into the declaration (most of these modules are executable scripts)
      // and TypeScript accepts `#!` only at byte 0 — a banner prepended above one is
      // `TS18026: '#!' can only be used at the start of a file`, which would break the
      // declaration for every importer. A naive prepend does exactly that, so this is
      // the assertion standing between the convenient implementation and a broken gate.
      const shebangLine = text.split('\n').findIndex((l) => l.startsWith('#!'));
      expect(shebangLine, `${dts} has a shebang below line 1 — TS18026`).toBeLessThanOrEqual(0);
    }
  });
});
