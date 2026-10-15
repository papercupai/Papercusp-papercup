/**
 * lint:tsc:workspaces — the typecheck fan-out over the SUPERPROJECT roots (apps/*, packages/*,
 * libs/generic/*), WI-7155 / EI-19376779013716004.
 *
 * `lint:tsc` resolves to packages/operator-core alone and `test:affected` is type-blind by
 * design, so a type-only regression anywhere else in the superproject surfaced NOWHERE — the
 * WI-6841 defect, one root over. WI-6841 fixed it for the libs/papercusp submodule; this leg is
 * the same fix for what it did not cover, sharing its machinery via scripts/lib/typecheck-fanout.mjs
 * rather than reimplementing (and drifting from) it.
 *
 * The wiring that gives this teeth — the post-suite leg in green-checkpoint.ts — is asserted in
 * apps/operator/lib/release/green-checkpoint-real-deps.test.ts. THIS file asserts the fan-out's
 * own decisions, which are all about refusing to look green when it is not:
 *   - discovery, so a NEW package declaring a typecheck script is gated the moment it lands;
 *   - the INVISIBLE population (tsconfig, no typecheck script) is REPORTED, never silently
 *     counted as passing — it is unreachable by construction, which is the actual finding;
 *   - a zero-package discovery FAILS here (unlike the submodule fan-out, which warns) — these
 *     roots always contain packages, so discovering none means discovery itself broke;
 *   - every exemption carries a reason + a filed id and is printed on every run, so a temporary
 *     exclusion cannot quietly become permanent;
 *   - a non-zero run with no parseable diagnostics is INFRASTRUCTURE, never "0 errors" (WI-4721);
 *   - an OOM-killed tsc is retried then SKIPPED, never a red (EI-18667028218882894).
 *
 * The spawn seam is injected, so none of this runs a real tsc.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line import/no-relative-packages
import {
  commandFor,
  discover,
  discoverInvisible,
} from '../../../scripts/lib/typecheck-fanout.mjs';
// eslint-disable-next-line import/no-relative-packages
import {
  DEFAULT_ROOTS,
  EXEMPT,
  GATE_COVERAGE,
  main,
  orderPackages,
  ownedBySiblingGate,
  pinDirectTscCommands,
  parseFilesArgs,
  selectGatedPackages,
  selectPackagesForFiles,
} from '../../../scripts/lint-tsc-workspaces.mjs';

const trees: string[] = [];
afterEach(() => {
  while (trees.length) rmSync(trees.pop()!, { recursive: true, force: true });
});

type Spec = {
  typecheck?: boolean;
  typecheckScript?: string;
  tsconfig?: boolean;
  corrupt?: boolean;
  /** Explicit package name — needed for dependency fixtures, which must be `@papercusp/*`. */
  name?: string;
  /** `@papercusp/*` names this package depends on (dependency-ordering fixtures). */
  deps?: string[];
};

/** Build a fake superproject: { 'apps/thing': { typecheck: true, tsconfig: true }, … }. */
function makeTree(pkgs: Record<string, Spec>): string {
  const root = mkdtempSync(join(tmpdir(), 'workspaces-fixture-'));
  trees.push(root);
  for (const [rel, spec] of Object.entries(pkgs)) {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    if (spec.tsconfig) writeFileSync(join(dir, 'tsconfig.json'), '{}');
    if (spec.corrupt) {
      writeFileSync(join(dir, 'package.json'), '{ "name": "truncated-mid-wri');
      continue;
    }
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: spec.name ?? rel.replace(/\//g, '-'),
        scripts: spec.typecheck ? { typecheck: spec.typecheckScript ?? 'tsc --noEmit' } : {},
        ...(spec.deps?.length
          ? { dependencies: Object.fromEntries(spec.deps.map((d) => [d, '*'])) }
          : {}),
      }),
    );
  }
  return root;
}

/** Collects everything the script printed, so assertions read against real operator output. */
function makeSink() {
  const out: string[] = [];
  const err: string[] = [];
  const warns: string[] = [];
  return {
    out,
    err,
    warns,
    io: {
      log: (m: string) => out.push(String(m)),
      error: (m: string) => err.push(String(m)),
      warn: (m: string) => warns.push(String(m)),
    },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

const PASS = { status: 0, stdout: '', stderr: '', signal: null };
const NO_EXEMPT = {};

describe('discovery — a new gated package must not have to be remembered', () => {
  it('finds every package declaring a typecheck script, at any nesting depth', () => {
    const root = makeTree({
      'apps/operator-public': { typecheck: true },
      'packages/omp-plugin': { typecheck: true },
      'libs/generic/papergrid/grid-core': { typecheck: true },
    });
    const found = discover(root, 0, root)
      .map((p: { rel: string }) => p.rel)
      .sort();
    expect(found).toEqual(['apps/operator-public', 'libs/generic/papergrid/grid-core', 'packages/omp-plugin']);
  });

  it('never descends into node_modules/_retired/dist', () => {
    const root = makeTree({
      'packages/real': { typecheck: true },
      'node_modules/some-dep': { typecheck: true },
      '_retired/old-thing': { typecheck: true },
      'dist/emitted': { typecheck: true },
    });
    expect(discover(root, 0, root).map((p: { rel: string }) => p.rel)).toEqual(['packages/real']);
  });
});

describe('focused --files routing (EI-21491386096171610)', () => {
  it('preserves each baseline delegate file scope without passing custom flags to raw tsc', () => {
    const root = makeTree({
      'packages/focused': { typecheck: true, typecheckScript: 'node ../../scripts/lint-tsc-agent-mcp.mjs' },
      'packages/second': { typecheck: true, typecheckScript: 'node ../../scripts/lint-tsc-operator-public.mjs' },
      'packages/plain': { typecheck: true },
    });
    const sink = makeSink();
    const commands: Record<string, string[]> = {};
    const code = main({
      repoRoot: root, roots: ['packages'], exempt: NO_EXEMPT,
      files: ['packages/focused/src/a.ts', 'packages/focused/src/a.test.ts', 'packages/second/src/b.ts', 'packages/plain/src/c.ts'],
      spawn: (pkg: { rel: string; command?: string[] }) => {
        commands[pkg.rel] = commandFor(pkg);
        return PASS;
      },
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(commands).toEqual({
      'packages/focused': ['npm', 'run', 'typecheck', '--', '--files=packages/focused/src/a.ts,packages/focused/src/a.test.ts'],
      'packages/second': ['npm', 'run', 'typecheck', '--', '--files=packages/second/src/b.ts'],
      'packages/plain': ['npm', 'run', 'typecheck'],
    });
  });

  it('parses equals, separated, repeated, comma-separated, and Windows-style file args', () => {
    expect(
      parseFilesArgs([
        '--files=libs/generic/a/src/a.ts,./packages/b/src/b.ts',
        '--files',
        'apps\\c\\src\\c.ts',
        '--files=libs/generic/a/src/a.ts',
      ]),
    ).toEqual(['libs/generic/a/src/a.ts', 'packages/b/src/b.ts', 'apps/c/src/c.ts']);
  });

  it('selects only each named file owner, preferring the deepest nested workspace', () => {
    const packages = [
      { rel: 'libs/generic' },
      { rel: 'libs/generic/template-kit' },
      { rel: 'packages/other' },
    ];
    expect(
      selectPackagesForFiles(packages, [
        'libs/generic/template-kit/src/template-manifest.test.ts',
        'packages/other/src/index.ts',
      ]),
    ).toEqual({
      packages: [{ rel: 'libs/generic/template-kit' }, { rel: 'packages/other' }],
      unmatched: [],
    });
  });

  it('runs only the owning workspace instead of starting the whole fan-out', () => {
    const root = makeTree({
      'libs/generic/template-kit': { tsconfig: true },
      'libs/generic/unrelated-a': { tsconfig: true },
      'libs/generic/unrelated-b': { tsconfig: true },
    });
    const sink = makeSink();
    const compiled: string[] = [];
    const code = main({
      repoRoot: root,
      roots: ['libs/generic'],
      exempt: NO_EXEMPT,
      untypecheckable: {},
      files: ['libs/generic/template-kit/src/template-manifest.test.ts'],
      spawn: (pkg: { rel: string }) => {
        compiled.push(pkg.rel);
        return PASS;
      },
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(compiled).toEqual(['libs/generic/template-kit']);
    expect(sink.stdout()).toContain('1 file(s) → 1 owning workspace(s)');
    expect(sink.stdout()).toContain('1 package(s) gated (1 via tsconfig alone)');
  });

  it('fails an unmatched file without compiling any unrelated workspace', () => {
    const root = makeTree({ 'packages/real': { typecheck: true } });
    const sink = makeSink();
    const compiled: string[] = [];
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      files: ['nowhere/missing.ts'],
      spawn: (pkg: { rel: string }) => {
        compiled.push(pkg.rel);
        return PASS;
      },
      ...sink.io,
    });
    expect(code).toBe(1);
    expect(compiled).toEqual([]);
    expect(sink.stderr()).toContain('Refusing to fall back to the full fan-out');
  });
});

describe('the INVISIBLE population — absence of a gate is the finding', () => {
  // The point of the whole item. WI-6841's discovery is by OPT-IN (a package declares a
  // typecheck script), so a package that never opts in is not "passing" — it is unreachable,
  // and before this nothing anywhere said so.
  it('reports dirs that have a tsconfig but declare NO typecheck script', () => {
    const root = makeTree({
      'packages/gated': { typecheck: true, tsconfig: true },
      'packages/invisible': { typecheck: false, tsconfig: true },
      'libs/generic/also-invisible': { typecheck: false, tsconfig: true },
    });
    const found = discoverInvisible(root, 0, root)
      .map((p: { rel: string }) => p.rel)
      .sort();
    expect(found).toEqual(['libs/generic/also-invisible', 'packages/invisible']);
  });

  it('a dir with NO tsconfig is not invisible — it is simply not a tsc project', () => {
    const root = makeTree({ 'packages/plain': { typecheck: false } });
    expect(discoverInvisible(root, 0, root)).toEqual([]);
  });

  it('is REPORT-ONLY: invisible packages never fail the run, and say why they are not blocking', () => {
    // 61 packages reddening at once would red-pin the shared gate for the whole fleet — the
    // exact failure this work exists to prevent, inflicted by its own fix. Report first.
    const root = makeTree({
      'packages/gated': { typecheck: true, tsconfig: true },
      'packages/invisible-a': { typecheck: false, tsconfig: true },
      'packages/invisible-b': { typecheck: false, tsconfig: true },
    });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      spawn: () => PASS,
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.stdout()).toContain('2 director');
    expect(sink.stdout()).toContain('REPORT-ONLY');
    expect(sink.stdout()).toContain('NO routine gate reaches them');
  });
});

describe('refusing to look green when nothing was checked', () => {
  // The deliberate ASYMMETRY with lint-tsc-papercusp-libs.mjs, which WARNS in this situation.
  // That fan-out points at a git SUBMODULE whose pin can legitimately predate its typecheck
  // scripts, so reddening would hold `main` for the fleet on a condition no commit caused.
  // These roots are in the superproject and always contain packages — discovering none here
  // means discovery itself broke, and a broken discovery walk must never report a pass.
  it('discovering ZERO gated packages FAILS rather than reporting a vacuous green', () => {
    const root = makeTree({ 'packages/nothing': { typecheck: false } });
    const sink = makeSink();
    const code = main({ repoRoot: root, roots: ['packages'], exempt: NO_EXEMPT, spawn: () => PASS, ...sink.io });
    expect(code).toBe(1);
    expect(sink.stderr()).toContain('broken discovery walk');
    expect(sink.stdout()).not.toContain('passed,');
  });

  it('a corrupt package.json is a hard failure, never a silent opt-out', () => {
    // WI-6056's discipline: letting a partial/corrupt file shrink the gated set is how a
    // package silently stops being checked while the run still reports success.
    const root = makeTree({ 'packages/ok': { typecheck: true }, 'packages/broken': { corrupt: true } });
    const sink = makeSink();
    const code = main({ repoRoot: root, roots: ['packages'], exempt: NO_EXEMPT, spawn: () => PASS, ...sink.io });
    expect(code).toBe(1);
    expect(sink.stderr()).toContain('could not be parsed');
  });

  it('an absent root is skipped with a warning, not silently dropped', () => {
    const root = makeTree({ 'packages/ok': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages', 'libs/generic'],
      exempt: NO_EXEMPT,
      spawn: () => PASS,
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.warns.join('\n')).toContain('libs/generic does not exist');
  });
});

describe('tsconfig-gated promotion (EI-19409185011887864)', () => {
  // The bug: coverage required a `typecheck` SCRIPT, so a package with a tsconfig and no
  // script was reported "unreachable by construction" forever — and every NEW package
  // started out uncovered. A tsconfig is now the opt-in, under measured roots only.
  it('a tsconfig-only package under a PROMOTE root is GATED, and run via tsc rather than npm', () => {
    const root = makeTree({ 'libs/generic/quiet': { tsconfig: true } });
    const sink = makeSink();
    const spawned: string[][] = [];
    const code = main({
      repoRoot: root,
      roots: ['libs/generic'],
      exempt: NO_EXEMPT,
      untypecheckable: {},
      spawn: (pkg: { command?: string[] }) => {
        spawned.push(pkg.command ?? ['npm', 'run', 'typecheck']);
        return PASS;
      },
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.stdout()).toContain('1 package(s) gated (1 via tsconfig alone)');
    // It must NOT be run as `npm run typecheck` — the package has no such script, so that
    // would fail with "Missing script" and read as a broken package rather than a clean one.
    expect(spawned).toEqual([['npx', 'tsc', '--noEmit', '-p', 'tsconfig.json']]);
  });

  it('a tsconfig-only package OUTSIDE a PROMOTE root stays report-only, never silently gated', () => {
    // The safety rail. Promotion makes a directory BLOCKING, so an unmeasured root must not
    // be swept in: doing so red-pins the fleet gate on pre-existing errors no commit caused
    // (measured — promoting `apps/` unmeasured failed on apps/operator immediately).
    const root = makeTree({ 'packages/unmeasured': { tsconfig: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      untypecheckable: {},
      spawn: () => PASS,
      ...sink.io,
    });
    // Gating nothing here is correct, and the run still refuses to call that a green.
    expect(code).toBe(1);
    expect(sink.stdout()).toContain('REPORT-ONLY');
  });

  it('a held-back package is NOT gated and is named with its error count and filed id', () => {
    // Same discipline as EXEMPT: an exclusion that stops being printed is how a temporary
    // one becomes permanent without anyone deciding that it should.
    const root = makeTree({ 'libs/generic/ok': { tsconfig: true }, 'libs/generic/dirty': { tsconfig: true } });
    const sink = makeSink();
    const spawned: string[] = [];
    const code = main({
      repoRoot: root,
      roots: ['libs/generic'],
      exempt: NO_EXEMPT,
      untypecheckable: {
        'libs/generic/dirty': { detail: 'zod v3/v4 skew in tests', errors: 3, filedAs: 'EI-1234' },
      },
      spawn: (pkg: { rel: string }) => {
        spawned.push(pkg.rel);
        return PASS;
      },
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(spawned).toEqual(['libs/generic/ok']); // the dirty one was never run
    expect(sink.stdout()).toContain('NOT GATED');
    expect(sink.stdout()).toContain('libs/generic/dirty');
    expect(sink.stdout()).toContain('3 error(s)');
    expect(sink.stdout()).toContain('EI-1234');
  });
});

describe('exemptions cannot go quiet', () => {
  it('an exempt package is excluded from the gated set AND printed with its reason and filed id', () => {
    const root = makeTree({ 'packages/gated': { typecheck: true }, 'packages/skipped': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: { 'packages/skipped': { reason: 'committed-errors', detail: 'has 14 errors', filedAs: 'WI-7166' } },
      spawn: () => PASS,
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.stdout()).toContain('1 package(s) gated (0 via tsconfig alone), 1 exempt');
    expect(sink.stdout()).toContain('⊘ packages/skipped [committed-errors]');
    expect(sink.stdout()).toContain('WI-7166');
  });

  // An exemption without a stated reason and an exit path is indistinguishable from the
  // hardcoded roster this whole design exists to avoid.
  //
  // The rule is stated ONCE as a predicate so its teeth can be proven against a synthetic bad
  // entry rather than against `Object.keys(EXEMPT).length > 0`. Clearing the last exemption is
  // the stated exit path of every entry in the set ("Clear them and DELETE this entry — that is
  // the whole exit path"), so a live-population non-vacuity control reds this file at the moment
  // that goal is reached. WI-1556492.
  const exemptionDefects = (entry: { reason?: unknown; detail?: unknown; filedAs?: unknown }): string[] => {
    const defects: string[] = [];
    if (!entry.reason) defects.push('reason');
    if (!entry.detail) defects.push('detail');
    else if (String(entry.detail).length <= 40) defects.push('detail is a real explanation');
    if (!entry.filedAs) defects.push('filedAs');
    return defects;
  };

  it('rejects an exemption that omits its reason, its explanation or its filed id', () => {
    const ok = { reason: 'committed-errors', detail: 'x'.repeat(41), filedAs: 'WI-1' };
    expect(exemptionDefects(ok), 'a complete entry has no defects').toEqual([]);
    expect(exemptionDefects({ ...ok, reason: undefined })).toContain('reason');
    expect(exemptionDefects({ ...ok, detail: undefined })).toContain('detail');
    expect(exemptionDefects({ ...ok, detail: 'too short to be an explanation' })).toContain(
      'detail is a real explanation',
    );
    expect(exemptionDefects({ ...ok, filedAs: undefined })).toContain('filedAs');
  });

  it('every real EXEMPT entry carries a reason, a detail and a filed id', () => {
    for (const [rel, entry] of Object.entries(EXEMPT)) {
      expect(exemptionDefects(entry), `${rel}`).toEqual([]);
    }
  });

  // A stale exemption is worse than none: it reads as a live decision while excluding nothing,
  // and it hides that the package it names no longer exists or no longer declares a typecheck.
  it('every EXEMPT entry still names a real package that declares a typecheck script', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    for (const rel of Object.keys(EXEMPT)) {
      if (!existsSync(join(repoRoot, rel, 'package.json'))) continue; // not in this checkout
      const found = discover(join(repoRoot, rel), 0, repoRoot).map((p: { rel: string }) => p.rel);
      expect(found, `${rel} is exempted but no longer declares a typecheck script`).toContain(rel);
    }
  });
});

describe('a failing package', () => {
  it('reds the run and prints the compiler output', () => {
    const root = makeTree({ 'packages/bad': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      spawn: () => ({ status: 2, stdout: 'src/a.ts(1,1): error TS2322: nope', stderr: '', signal: null }),
      ...sink.io,
    });
    expect(code).toBe(1);
    expect(sink.stderr()).toContain('error TS2322');
    expect(sink.stderr()).not.toContain('INFRASTRUCTURE');
  });

  it('a non-zero exit with NO parseable diagnostics is INFRASTRUCTURE, never "0 errors"', () => {
    // Reading a crashed run as clean is what once lowered a watermark 170→0 and red-pinned
    // the gate (WI-4721).
    const root = makeTree({ 'packages/bad': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      spawn: () => ({ status: 1, stdout: '', stderr: 'tsc: command not found', signal: null }),
      ...sink.io,
    });
    expect(code).toBe(1);
    expect(sink.stderr()).toContain('INFRASTRUCTURE');
  });

  it('an OOM-killed tsc is retried, then SKIPPED — never a red for a load condition', () => {
    // EI-18667028218882894: OOM under fleet load is an infrastructure outcome, not a verdict
    // about the code. Reddening the release for it blocks everyone over nothing.
    const root = makeTree({ 'packages/heavy': { typecheck: true } });
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['packages'],
      exempt: NO_EXEMPT,
      spawn: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
      ...sink.io,
    });
    expect(code).toBe(0);
    expect(sink.warns.join('\n')).toContain('OOM-killed again');
    expect(sink.warns.join('\n')).toContain('NOT verified this run');
    expect(sink.stdout()).toContain('1 skipped (OOM)');
  });
});

describe('dependency-ordered traversal (workstream G adoption, WI-36257)', () => {
  // WHY THIS EXISTS, because the value is not obvious from the code: every @papercusp/* package
  // resolves `types` to its own ./src/index.ts (there is no dist) and node_modules/@papercusp/*
  // symlinks to the source dir, so a dependent's tsc reads its dependency's SOURCE and reports
  // ITS errors against a file the dependent does not own. Verified on the real tree with
  // scripts/mutation-probe.sh: a type error injected into libs/generic/module-singleton made
  // `tsc -p libs/generic/lexicon/tsconfig.json` fail, citing module-singleton's file.
  //
  // So alphabetical order turns ONE defect into N indistinguishable failures. Measured on the
  // real gated set: breaking module-singleton reported 7 failures (6 pure cascade) and ran 64
  // compiles; leaves-first reports 1 failure + 6 blocked and runs 58.
  const LEAF = '@papercusp/leaf';
  const MID = '@papercusp/mid';

  /** leaf <- mid <- top, declared in an order whose ALPHABETICAL sort is the exact reverse. */
  const chain = () =>
    makeTree({
      'libs/generic/a-top': { tsconfig: true, name: '@papercusp/top', deps: [MID] },
      'libs/generic/b-mid': { tsconfig: true, name: MID, deps: [LEAF] },
      'libs/generic/c-leaf': { tsconfig: true, name: LEAF },
    });

  const relsOf = (root: string) => {
    const { packages } = selectGatedPackages({ repoRoot: root, roots: ['libs/generic'], exempt: NO_EXEMPT });
    return { packages, ordered: orderPackages(packages).ordered.map((p: { rel: string }) => p.rel) };
  };

  it('compiles dependencies BEFORE dependents, reversing the alphabetical order', () => {
    const { packages, ordered } = relsOf(chain());
    // The control: alphabetical really is the opposite order, so passing is not vacuous.
    expect(packages.map((p: { rel: string }) => p.rel)).toEqual([
      'libs/generic/a-top',
      'libs/generic/b-mid',
      'libs/generic/c-leaf',
    ]);
    expect(ordered).toEqual(['libs/generic/c-leaf', 'libs/generic/b-mid', 'libs/generic/a-top']);
  });

  it('a package whose dependency FAILED is reported BLOCKED, and is never compiled', () => {
    const root = chain();
    const sink = makeSink();
    const compiled: string[] = [];
    const code = main({
      repoRoot: root,
      roots: ['libs/generic'],
      exempt: NO_EXEMPT,
      spawn: (pkg: { rel: string }) => {
        compiled.push(pkg.rel);
        return pkg.rel === 'libs/generic/c-leaf'
          ? { status: 2, stdout: 'src/index.ts(1,7): error TS2322: nope', stderr: '', signal: null }
          : PASS;
      },
      ...sink.io,
    });

    expect(code).toBe(1); // the root cause still reds the run
    // ONE defect is reported as one defect — this is the whole point.
    expect(sink.stdout()).toContain('1 failed, 2 blocked (dependency failed)');
    expect(sink.stdout()).toContain('libs/generic/b-mid — blocked by libs/generic/c-leaf');
    // …and the cascade is not merely relabelled, it is not run at all.
    expect(compiled).toEqual(['libs/generic/c-leaf']);
  });

  it('blocking is TRANSITIVE — a dependent of a blocked package is blocked too', () => {
    // b-mid never runs, so "did b-mid fail?" has no answer; treating that as "fine, compile
    // a-top" would put the cascade straight back.
    const root = chain();
    const sink = makeSink();
    const code = main({
      repoRoot: root,
      roots: ['libs/generic'],
      exempt: NO_EXEMPT,
      spawn: (pkg: { rel: string }) =>
        pkg.rel === 'libs/generic/c-leaf'
          ? { status: 2, stdout: 'src/index.ts(1,1): error TS2322: nope', stderr: '', signal: null }
          : PASS,
      ...sink.io,
    });
    expect(code).toBe(1);
    expect(sink.stdout()).toContain('libs/generic/a-top — blocked by libs/generic/b-mid');
  });

  it('a green run is unchanged — nothing is blocked when nothing fails', () => {
    const root = chain();
    const sink = makeSink();
    const code = main({ repoRoot: root, roots: ['libs/generic'], exempt: NO_EXEMPT, spawn: () => PASS, ...sink.io });
    expect(code).toBe(0);
    expect(sink.stdout()).toContain('3 passed, 0 failed');
    expect(sink.stdout()).not.toContain('blocked');
  });

  it('a dependency CYCLE is batched, not thrown — and the run says the order within it is arbitrary', () => {
    // Import cycles are normal in a live tree (barrel files alone produce them). A traversal
    // that throws on one would make this gate unrunnable.
    const root = makeTree({
      'libs/generic/x': { tsconfig: true, name: '@papercusp/x', deps: ['@papercusp/y'] },
      'libs/generic/y': { tsconfig: true, name: '@papercusp/y', deps: ['@papercusp/x'] },
    });
    const { packages } = selectGatedPackages({ repoRoot: root, roots: ['libs/generic'], exempt: NO_EXEMPT });
    const { ordered, cycles } = orderPackages(packages);
    expect(cycles.length).toBe(1);
    expect(ordered.map((p: { rel: string }) => p.rel).sort()).toEqual(['libs/generic/x', 'libs/generic/y']);

    const sink = makeSink();
    main({ repoRoot: root, roots: ['libs/generic'], exempt: NO_EXEMPT, spawn: () => PASS, ...sink.io });
    expect(sink.stdout()).toContain('dependency cycle(s)');
  });

  it('a dep this sweep does not compile is EXTERNAL — reported, and never an ordering constraint', () => {
    // libs/papercusp has its own fan-out, so its packages legitimately appear as deps here.
    // The failure this guards is silent: if the name→package mapping broke, every edge would
    // land in `external`, ordering would degrade to alphabetical, and the run would look normal.
    const root = makeTree({
      'libs/generic/solo': { tsconfig: true, name: '@papercusp/solo', deps: ['@papercusp/not-in-this-sweep'] },
    });
    const { packages } = selectGatedPackages({ repoRoot: root, roots: ['libs/generic'], exempt: NO_EXEMPT });
    const { ordered, external, edges, blockersOf } = orderPackages(packages);
    expect(edges).toBe(0);
    expect(external.length).toBe(1);
    expect(ordered.map((p: { rel: string }) => p.rel)).toEqual(['libs/generic/solo']);
    // An unresolved dep can never block: only a package we actually compile can be seen to fail.
    expect(blockersOf({ rel: 'libs/generic/solo' })).toEqual([]);
  });

  it('the REAL gated set keeps cycle batches contiguous and orders every external dependency first', () => {
    // A live guard, not a fixture: if a future edit breaks the edge source (or someone drops
    // `key`), edges collapse toward 0 and this ordering silently stops meaning anything.
    const { packages } = selectGatedPackages();
    const { ordered, blockersOf, edges, cycles } = orderPackages(packages);
    expect(ordered.length).toBe(packages.length);
    expect(edges).toBeGreaterThan(0);

    const position = new Map<string, number>(
      (ordered as { rel: string }[]).map((p, i) => [p.rel, i] as [string, number]),
    );
    const cycleOf = new Map<string, number>();
    cycles.forEach((cycle: { rel: string }[], index: number) => {
      const positions = cycle.map(pkg => {
        cycleOf.set(pkg.rel, index);
        return position.get(pkg.rel) as number;
      }).sort((a, b) => a - b);
      expect(positions.at(-1)! - positions[0]!).toBe(positions.length - 1);
    });
    for (const pkg of ordered as { rel: string }[]) {
      for (const dep of blockersOf(pkg) as string[]) {
        // Ordering both directions of a cycle is impossible. The maintained
        // dependency-order contract emits that strongly connected set as a batch.
        if (cycleOf.has(pkg.rel) && cycleOf.get(pkg.rel) === cycleOf.get(dep)) continue;
        expect(
          position.get(dep),
          `${dep} must be compiled before its dependent ${pkg.rel}`,
        ).toBeLessThan(position.get(pkg.rel) as number);
      }
    }
  });
});

describe('pinned TypeScript CLI fan-out (EI-21107417900847684)', () => {
  it('rewrites direct promoted-tsconfig compiles but preserves declared npm scripts', () => {
    const root = makeTree({
      'libs/generic/promoted': { tsconfig: true },
      'libs/generic/declared': { typecheck: true },
    });
    const selected = selectGatedPackages({
      repoRoot: root,
      roots: ['libs/generic'],
      exempt: NO_EXEMPT,
      untypecheckable: {},
    }).packages;

    const pinned = pinDirectTscCommands(selected, root, () => '/pinned/native/bin/tsc');
    expect(
      pinned.find((pkg: { rel: string }) => pkg.rel.endsWith('/promoted'))?.command,
    ).toEqual([
      process.execPath,
      '/pinned/native/bin/tsc',
      '--noEmit',
      '-p',
      'tsconfig.json',
    ]);
    expect(
      commandFor(pinned.find((pkg: { rel: string }) => pkg.rel.endsWith('/declared'))),
    ).toEqual([
      'npm',
      'run',
      'typecheck',
    ]);
  });
});

describe('the REAL tree', () => {
  it('apps/operator is a blocking workspace, not report-only residue', () => {
    const selected = selectGatedPackages();
    expect(selected.packages.map((p: { rel: string }) => p.rel)).toContain('apps/operator');
    expect(selected.stillInvisible.map((p: { rel: string }) => p.rel)).not.toContain('apps/operator');
  });

  // THE anti-silent-un-gating guard for WI-7155 specifically. Its whole complaint was that
  // libs/generic/* was typechecked by no routine gate; the fix works only while these packages
  // keep declaring a typecheck script. Removing one silently un-gates it again — that reds HERE,
  // at development time, instead of quietly restoring the original bug.
  it('the six libs/generic workspaces WI-7155 named still declare a typecheck script', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    const genericRoot = join(repoRoot, 'libs', 'generic');
    if (!existsSync(genericRoot)) return;

    const found = discover(genericRoot, 0, repoRoot).map((p: { rel: string }) => p.rel);
    for (const expected of [
      'libs/generic/artifact-registry',
      'libs/generic/chat-protocol',
      'libs/generic/gui-readiness',
      'libs/generic/rerank',
      'libs/generic/search-core',
      'libs/generic/tauri-verify',
    ]) {
      expect(found, `${expected} no longer declares a typecheck script — WI-7155 regressed`).toContain(expected);
    }
  });

  it('the superproject roots this leg covers are disjoint from the libs/papercusp fan-out', () => {
    // Covering a package twice doubles its compile and reports one regression as two.
    //
    // ⚠ THE STRING CHECKS BELOW ARE NO LONGER THE LOAD-BEARING ONES (EI-20549967837064185).
    // DEFAULT_ROOTS is now `libs`, which does not START WITH 'libs/papercusp' and yet REACHES
    // it by descent — so these two assertions pass while the property they name is violated.
    // They are kept because a root literally named 'libs/papercusp' would still be wrong, but
    // the real guard is the selection assertion in the next test. A guard that can only see the
    // spelling of a constant cannot see coverage arriving through the walk.
    expect(DEFAULT_ROOTS).not.toContain('libs/papercusp');
    expect(DEFAULT_ROOTS.some((r: string) => r.startsWith('libs/papercusp'))).toBe(false);
  });

  // EI-20549967837064185. The disjointness that matters is a property of WHAT GETS COMPILED, so
  // assert it there. This runs against the REAL tree on purpose: a fixture would prove only that
  // the filter works on a tree I built to suit it, and the thing that actually broke was the real
  // root list drifting away from the real directory layout.
  it('no libs/papercusp package is selected, even though the libs root walks into it', () => {
    const selected = selectGatedPackages();
    const doubled = selected.packages.filter((p: { rel: string }) => ownedBySiblingGate(p.rel));
    expect(
      doubled.map((p: { rel: string }) => p.rel),
      'lint:tsc:papercusp-libs already compiles these — selecting them here reports one regression as two',
    ).toEqual([]);

    // …and the exclusion is REAL, not vacuous: the walk must actually be reaching that subtree,
    // or this test would pass just as well with the coverage hole restored. This is the negative
    // control — without it, narrowing DEFAULT_ROOTS back to 'libs/generic' would still be green.
    expect(
      selected.siblingOwned.length,
      'the libs root should be walking INTO libs/papercusp and excluding it at selection; ' +
        'zero here means the root narrowed and the nine libs/* workspaces are dark again',
    ).toBeGreaterThan(0);
  });

  // EI-20549967837064185. The original defect in one assertion: these roots existed, held real
  // TypeScript, and were reachable by nothing. Naming them individually is deliberate — this is
  // the population the item was filed about, and a count would drift silently.
  it('every libs/* workspace root is reachable by this leg (the EI-20549967837064185 hole)', () => {
    const selected = selectGatedPackages();
    const reachable = new Set<string>([
      ...selected.packages.map((p: { rel: string }) => p.rel),
      ...selected.heldBack.map((p: { rel: string }) => p.rel),
      ...selected.stillInvisible.map((p: { rel: string }) => p.rel),
      ...selected.exempted.map((p: { rel: string }) => p.rel),
    ]);
    for (const rel of [
      'libs/agent-chat',
      'libs/flags',
      'libs/host-platform',
      'libs/marketplace-public-ui',
      'libs/papercusp-db',
      'libs/papercusp-publish-auth',
      'libs/papercusp-shared',
      'libs/test-config',
      'libs/testing-shell',
    ]) {
      expect(
        reachable.has(rel),
        `${rel} is covered by NO gate again — it must appear in the gated, held-back or ` +
          'report-only population, never be absent from all of them',
      ).toBe(true);
    }
  });

  // The feature-flag SSOT specifically: it is the one whose silence was most expensive, and it
  // is GATED (not merely reachable) as of 2026-08-15, so a regression to report-only is a fail.
  it('libs/flags — the feature-flag SSOT — is BLOCKING, not report-only', () => {
    const rels = selectGatedPackages().packages.map((p: { rel: string }) => p.rel);
    expect(rels).toContain('libs/flags');
  });

  // NEGATIVE CONTROL for the two tests above (EI-20549967837064185).
  //
  // A guard that has never failed is a guard nobody has tested, and the two assertions above
  // would pass just as happily against a tree where nothing was ever broken. This drives the
  // SAME selector with the OLD root list — the exact configuration the item was filed about —
  // and asserts it FAILS to reach the nine. It is the deliberately-wrong implementation kept
  // permanently as a control, per the repo's mutation-probe discipline: it proves the property
  // is falsifiable WITHOUT mutating the shared tree, so there is no restore step to lose to a
  // kill and no window for the git-sync sweep to commit a mutant.
  //
  // If someone narrows DEFAULT_ROOTS back to 'libs/generic', the tests above go red and THIS one
  // stays green — which is exactly the pairing that tells you the hole is real and not a fixture.
  it('CONTROL: the old libs/generic root cannot reach those same nine, which is the defect', () => {
    const old = selectGatedPackages({ roots: ['apps', 'packages', 'libs/generic'] });
    const reachable = new Set<string>([
      ...old.packages.map((p: { rel: string }) => p.rel),
      ...old.heldBack.map((p: { rel: string }) => p.rel),
      ...old.stillInvisible.map((p: { rel: string }) => p.rel),
      ...old.exempted.map((p: { rel: string }) => p.rel),
    ]);
    for (const rel of ['libs/flags', 'libs/papercusp-shared', 'libs/testing-shell']) {
      expect(
        reachable.has(rel),
        `${rel} was reachable under the OLD root list — then this control no longer describes ` +
          'the defect, and the tests above are not proving what they claim',
      ).toBe(false);
    }
    // And the old list reached libs/papercusp not at all, so its siblingOwned is empty — the
    // mirror of the positive control above.
    expect(old.siblingOwned).toEqual([]);
  });
});

/** The `  · <rel>` lines main() prints for the GATED set (2-space indent is only ever that list). */
function gatedRelsFromReport(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((l) => /^ {2}· /.test(l))
    .map((l) => l.replace(/^ {2}· /, '').trim());
}

// EI-19462776655300160. GATE_COVERAGE is what the sibling-gate resolver in
// scripts/lib/tsc-baseline-gate.mjs reads to route an agent to this leg. If it ever disagrees with
// what main() actually RUNS, the failure is silent and points the WRONG WAY: an over-claimed
// prefix routes someone to a gate that does not in fact check their file — the mirror image of the
// bug EI-19461218392796337 fixed. One shared selectGatedPackages() is what makes them one fact;
// these tests are what keep it that way.
describe('GATE_COVERAGE cannot drift from what the leg runs (EI-19462776655300160)', () => {
  it('main() reports EXACTLY the set selectGatedPackages() returns — no second derivation', () => {
    const root = makeTree({
      'apps/gated': { typecheck: true },
      'apps/plain': {},
      'apps/exempt-me': { typecheck: true },
      'libs/generic/promoted': { tsconfig: true },
      'packages/report-only': { tsconfig: true },
    });
    const sink = makeSink();
    const exempt = {
      'apps/exempt-me': { reason: 'test', detail: 'excluded by this test', filedAs: 'n/a' },
    };

    main({
      repoRoot: root,
      roots: DEFAULT_ROOTS,
      exempt,
      untypecheckable: {},
      listOnly: true,
      listInvisible: false,
      spawn: () => PASS,
      ...sink.io,
    });

    const selected = selectGatedPackages({
      repoRoot: root,
      roots: DEFAULT_ROOTS,
      exempt,
      untypecheckable: {},
    });

    expect(gatedRelsFromReport(sink.stdout())).toEqual(selected.packages.map((p) => p.rel));
    // The selection is real, not vacuously empty on both sides.
    expect(selected.packages.map((p) => p.rel)).toEqual([
      'apps/gated',
      'libs/generic/promoted',
    ]);
    // And an exempt / report-only package is in NEITHER — so an agent is never routed here for one.
    expect(gatedRelsFromReport(sink.stdout())).not.toContain('apps/exempt-me');
    expect(gatedRelsFromReport(sink.stdout())).not.toContain('packages/report-only');
  });

  it('GATE_COVERAGE() on the REAL tree equals the gated set --list reports', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    if (!existsSync(join(repoRoot, 'apps'))) return;

    const sink = makeSink();
    main({ repoRoot, listOnly: true, listInvisible: false, spawn: () => PASS, ...sink.io });

    const reported = gatedRelsFromReport(sink.stdout());
    expect(reported.length).toBeGreaterThan(1);
    // The declaration the resolver reads, against the report an operator reads. Same fact.
    expect(GATE_COVERAGE()).toEqual(reported.map((rel) => `${rel}/`));
  });

  it('declares a trailing slash on every prefix, so a sibling name cannot match as a prefix', () => {
    // Without it, 'libs/generic/rerank' would also claim to cover 'libs/generic/rerank-legacy/x.ts'.
    const prefixes = GATE_COVERAGE();
    expect(prefixes.length).toBeGreaterThan(1);
    for (const p of prefixes) expect(p.endsWith('/')).toBe(true);
  });
});
