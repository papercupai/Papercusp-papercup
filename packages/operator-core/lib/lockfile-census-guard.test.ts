/**
 * Guard test for scripts/check-lockfile-census.mjs — the P-007 SBOM/inventory gate
 * (plan security-boundary-remediation-and-usability-2026-09-04, WI-2144851).
 *
 * WHY THESE CONTROLS EXIST
 *
 * This guard's whole job is to make an UNMEASURED dependency graph loud. That means its
 * own failure mode is the one it exists to prevent: a census that reads nothing, or a
 * classifier that waves everything through, reports a clean tree in exactly the same
 * words as a genuinely clean one. So the controls below are weighted toward proving the
 * instrument can FAIL — an empty walk, an unreadable root lockfile, a workspace set that
 * came back empty — rather than toward re-asserting the happy path.
 *
 * THE CENTRAL CASE IS `treats subsumption as DERIVED, not asserted`.
 * Three nested package-lock.json files in this tree are genuinely covered by the root
 * `npm audit` because their package is a root workspace member and npm hoists the graph.
 * The tempting implementation writes those three paths into a list. That list is a second
 * copy of a truth the root lockfile already owns, and it keeps saying "covered" for years
 * after a package stops being a workspace member. The test pins the derivation instead:
 * the same lockfile flips to UNCLASSIFIED the moment its directory leaves the workspace
 * set, with no list to update.
 *
 * The classifier is pure over plain data, so every case runs on inline fixtures — no
 * network, no npm/cargo/syft invocation, no shared-tree mutation (the fixture tier from
 * CLAUDE.md's falsifiability table). The three real-tree assertions read the repo but
 * never write to it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Enrolled in tsconfig.declarations.json, so this import is TYPED (generated sibling
// scripts/check-lockfile-census.d.mts) rather than an implicit `any` module.
import {
  classifyCensus,
  censusOrThrow,
  walkLockfiles,
  rootWorkspaceDirs,
  sbomSubjects,
  emitSbom,
  measureLockfiles,
  npmDepCounts,
  cargoDepCounts,
  countCataloguedDependencies,
  assertSbomCoverage,
  parseSbomOut,
  COVERED_LOCKFILES,
  NOT_SHIPPED_LOCKFILES,
  UNCOVERED_BASELINE,
  LOCKFILE_ECOSYSTEMS,
  ROOT,
} from '../../../scripts/check-lockfile-census.mjs';
import { SHIPPED_LOCKFILES } from '../../../scripts/check-rust-advisories.mjs';

/** A workspace set shaped like the real one — several dirs, one of them our fixture's. */
const WORKSPACE_DIRS = new Set(['packages/alpha', 'libs/generic/beta', 'apps/gamma']);

function classify(lockfiles: string[], overrides: Record<string, unknown> = {}) {
  return classifyCensus({
    lockfiles,
    workspaceDirs: WORKSPACE_DIRS,
    covered: new Map([['package-lock.json', 'root npm audit']]),
    notShipped: new Map([['apps/toy/Cargo.lock', 'a toy; never bundled']]),
    uncovered: new Map([['shipped-thing/package-lock.json', { deps: 12, reason: 'shipped, unscanned' }]]),
    ...overrides,
  });
}

describe('classifyCensus', () => {
  it('POSITIVE CONTROL — an unknown lockfile is UNCLASSIFIED, not silently allowed', () => {
    const r = classify(['package-lock.json', 'some/new/thing/Cargo.lock']);
    expect(r.offenders.map((o) => o.path)).toEqual(['some/new/thing/Cargo.lock']);
  });

  it('NEGATIVE CONTROL — a fully classified census produces no offenders', () => {
    const r = classify([
      'package-lock.json',
      'apps/toy/Cargo.lock',
      'shipped-thing/package-lock.json',
      'packages/alpha/package-lock.json',
    ]);
    expect(r.offenders).toEqual([]);
    expect(r.byBucket).toEqual({
      covered: 1,
      'not-shipped': 1,
      'uncovered-baselined': 1,
      subsumed: 1,
    });
  });

  // THE CENTRAL CASE. Subsumption must come from the root lockfile, never from a list.
  it('treats subsumption as DERIVED, not asserted', () => {
    const path = 'packages/alpha/package-lock.json';
    const covered = classify(['package-lock.json', path]);
    expect(covered.rows.find((r) => r.path === path)?.bucket).toBe('subsumed');

    // Same lockfile, same lists — only the workspace membership is gone.
    const orphaned = classifyCensus({
      lockfiles: ['package-lock.json', path],
      workspaceDirs: new Set(['libs/generic/beta']),
      covered: new Map([['package-lock.json', 'root npm audit']]),
      notShipped: new Map(),
      uncovered: new Map(),
    });
    expect(orphaned.rows.find((r) => r.path === path)?.bucket).toBe('UNCLASSIFIED');
  });

  it('never subsumes a NON-npm lockfile on workspace membership', () => {
    // A Cargo.lock inside a workspace directory is not hoisted by npm — cargo has no such
    // mechanism, so inheriting the npm rule here would launder a real blind spot.
    const r = classify(['package-lock.json', 'packages/alpha/Cargo.lock']);
    expect(r.rows.find((r2) => r2.path === 'packages/alpha/Cargo.lock')?.bucket).toBe('UNCLASSIFIED');
  });

  it('reports a curated entry whose path left the tree as stale, without failing', () => {
    const r = classify(['package-lock.json']);
    expect(r.stale.map((s) => s.path).sort()).toEqual([
      'apps/toy/Cargo.lock',
      'shipped-thing/package-lock.json',
    ]);
    expect(r.offenders).toEqual([]);
  });

  it('carries the measured dep count on a baselined uncovered row', () => {
    const r = classify(['package-lock.json', 'shipped-thing/package-lock.json']);
    expect(r.rows.find((x) => x.bucket === 'uncovered-baselined')?.deps).toBe(12);
  });

  it('classifies each row into exactly one bucket', () => {
    const r = classify([
      'package-lock.json',
      'apps/toy/Cargo.lock',
      'shipped-thing/package-lock.json',
      'packages/alpha/package-lock.json',
      'mystery/Cargo.lock',
    ]);
    expect(r.rows).toHaveLength(5);
    expect(Object.values(r.byBucket).reduce<number>((a, b) => a + (b as number), 0)).toBe(5);
  });
});

describe('census and workspace derivation fail CLOSED', () => {
  it('refuses a census that found ZERO lockfiles', () => {
    const empty = mkdtempSync(join(tmpdir(), 'census-empty-'));
    try {
      expect(() => censusOrThrow(empty)).toThrow(/ZERO lockfiles/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses a census missing its own positive control', () => {
    // Lockfiles found, but not the repo-root one — a mis-rooted or over-pruned walk.
    const dir = mkdtempSync(join(tmpdir(), 'census-noctl-'));
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'Cargo.lock'), '[[package]]\n');
      expect(() => censusOrThrow(dir)).toThrow(/positive control/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a root lockfile with no packages map rather than reporting a tree of blind spots', () => {
    expect(() => rootWorkspaceDirs({})).toThrow(/no `packages` map/);
    expect(() => rootWorkspaceDirs({ packages: 'nope' })).toThrow(/no `packages` map/);
  });

  it('refuses a root lockfile that yields zero workspace directories', () => {
    // Shape is right, content is empty — every nested lock would look unsubsumed.
    expect(() => rootWorkspaceDirs({ packages: { '': {}, 'node_modules/x': {} } })).toThrow(
      /no workspace directories/,
    );
  });

  it('derives workspace dirs while excluding the root and node_modules keys', () => {
    const dirs = rootWorkspaceDirs({
      packages: { '': {}, 'packages/alpha': {}, 'node_modules/lodash': {}, 'apps/gamma': {} },
    });
    expect([...dirs].sort()).toEqual(['apps/gamma', 'packages/alpha']);
  });

  it('refuses a registered standalone dev graph even when its lock never existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-standalone-'));
    const standalone = 'tools/perf-test/wdio';
    try {
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
        packages: { '': {}, 'packages/workspace': {} },
      }));
      mkdirSync(join(dir, standalone, 'node_modules'), { recursive: true });
      writeFileSync(join(dir, standalone, 'package.json'), JSON.stringify({
        devDependencies: { runner: '1.0.0' },
      }));
      expect(() => censusOrThrow(dir))
        .toThrow(/tools\/perf-test\/wdio.*no package-lock.json/);

      writeFileSync(join(dir, standalone, 'package-lock.json'), JSON.stringify({
        packages: { '': {}, 'node_modules/runner': { version: '1.0.0', dev: true } },
      }));
      expect(censusOrThrow(dir))
        .toEqual(['package-lock.json', 'tools/perf-test/wdio/package-lock.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the root lock for registered runners that are actual workspaces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-workspace-runner-'));
    const standalone = 'packages/runner';
    try {
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
        packages: { '': {}, [standalone]: { devDependencies: { runner: '1.0.0' } } },
      }));
      mkdirSync(join(dir, standalone), { recursive: true });
      writeFileSync(join(dir, standalone, 'package.json'), JSON.stringify({
        devDependencies: { runner: '1.0.0' },
      }));
      expect(censusOrThrow(dir, { standaloneDirs: [standalone] })).toEqual(['package-lock.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('walkLockfiles', () => {
  it('finds lockfiles by ecosystem name and prunes dependency trees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-walk-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{}');
      mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'dep', 'package-lock.json'), '{}');
      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(join(dir, 'app', 'Cargo.lock'), '');
      writeFileSync(join(dir, 'app', 'README.md'), '');

      expect(walkLockfiles(dir)).toEqual(['app/Cargo.lock', 'package-lock.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recognises ecosystems beyond npm and cargo, so a new one cannot enter unseen', () => {
    // The two blind spots this guard was built from were both "an ecosystem nobody was
    // scanning". A go/python graph landing here must surface as UNCLASSIFIED, which it
    // can only do if the walker recognises the lockfile at all.
    for (const name of ['go.sum', 'poetry.lock', 'Gemfile.lock', 'uv.lock']) {
      expect(LOCKFILE_ECOSYSTEMS.has(name)).toBe(true);
    }
  });
});

describe('SBOM emission', () => {
  it('inventories what ships, and skips vestigial and unshipped lockfiles', () => {
    const r = classify([
      'package-lock.json',
      'apps/toy/Cargo.lock',
      'shipped-thing/package-lock.json',
      'packages/alpha/package-lock.json',
    ]);
    expect(sbomSubjects(r.rows).sort()).toEqual(['package-lock.json', 'shipped-thing/package-lock.json']);
  });

  it('REFUSES when syft is absent instead of writing no SBOM and exiting 0', () => {
    // The trap this pins: a supply-chain step that silently no-ops when its tool is
    // missing produces a green run and no artifact — the exact "measured nothing" reading
    // the whole guard exists to prevent.
    expect(() => emitSbom(['package-lock.json'], '/tmp/never-written.json', { syft: '/nonexistent/syft' })).toThrow(
      /syft not found/,
    );
  });
});

/**
 * THE INVOCATION, not the function — the gap the block above could not see.
 *
 * MEASURED 2026-09-05: `lint:lockfile-census:sbom` in the root package.json read
 * `check-lockfile-census.mjs --strict --sbom`, with nothing after the flag. `--sbom` takes
 * a path OPERAND, so `argv[sbomIdx + 1]` was `undefined`, the emit block never ran, and the
 * script printed the plain census and exited 0 — no syft, no `assertSbomCoverage`, no file,
 * and no line saying any of it was skipped. The script whose whole name is `:sbom` was a
 * silent duplicate of the one without the suffix.
 *
 * Every control above stayed green through that, and correctly so: they test `emitSbom`
 * and `assertSbomCoverage` as FUNCTIONS, and both functions were fine. Nothing asserted
 * that the command CI actually runs reaches them. So this block tests the argv — the one
 * artifact that carried the defect.
 */
describe('the --sbom operand (the CLI contract, not the function)', () => {
  it('REFUSES a bare --sbom instead of resolving to undefined and skipping the emit', () => {
    expect(() => parseSbomOut(['--strict', '--sbom'])).toThrow(/requires an output PATH operand/);
  });

  it('REFUSES a flag-shaped operand rather than writing an SBOM to a file named --strict', () => {
    expect(() => parseSbomOut(['--sbom', '--strict'])).toThrow(/requires an output PATH operand/);
  });

  it('returns null when --sbom was never asked for, so the census-only run stays valid', () => {
    expect(parseSbomOut(['--strict'])).toBeNull();
  });

  it('POSITIVE CONTROL — a real operand parses to that path', () => {
    expect(parseSbomOut(['--strict', '--sbom', '.papercusp/tmp/x.json'])).toBe('.papercusp/tmp/x.json');
  });

  it('REAL-TREE: the npm script named :sbom actually reaches the emit path', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const script: string | undefined = pkg.scripts?.['lint:lockfile-census:sbom'];
    expect(script, 'lint:lockfile-census:sbom must exist').toBeTypeOf('string');

    // Parse the script's OWN argv the way the CLI does. A script that fails this is the
    // exact shape of the measured defect: green, silent, and cataloguing nothing.
    const argv = String(script).split(/\s+/).slice(2);
    expect(() => parseSbomOut(argv), `\`${script}\` never reaches the SBOM emit`).not.toThrow();
    expect(parseSbomOut(argv), 'the :sbom script must name an output path').toBeTruthy();
  });

  it('CONTROL — the exact pre-fix script string still fails this predicate', () => {
    // The real-tree case above can only be trusted if the predicate DISCRIMINATES. This
    // keeps the measured-broken value in the file permanently and runs it through the
    // identical split + parse, so a future edit that makes the predicate vacuous fails
    // here rather than passing everywhere. (Fixture tier from CLAUDE.md's falsifiability
    // table: a deliberately-wrong input kept as a control, no shared-tree mutation.)
    const preFix = 'node scripts/check-lockfile-census.mjs --strict --sbom';
    expect(() => parseSbomOut(preFix.split(/\s+/).slice(2))).toThrow(/requires an output PATH operand/);
  });

  it('REAL-TREE: writes that SBOM somewhere git ignores, so a run cannot dirty the shared tree', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const out = parseSbomOut(String(pkg.scripts['lint:lockfile-census:sbom']).split(/\s+/).slice(2));
    const ignored = readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(
      ignored.some((rule) => rule.endsWith('/') && String(out).startsWith(rule)),
      `${out} is not under any .gitignore directory rule — an 8MB SBOM would be swept into a commit`,
    ).toBe(true);
  });

  it('CONTROL — a repo-root output path would FAIL the ignored-path check', () => {
    // Same discrimination proof for the sibling assertion: git-sync sweeps the whole tree,
    // so an un-ignored SBOM path is a real hazard (measured: the emitted document is 8.3MB).
    const ignored = readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(ignored.some((rule) => rule.endsWith('/') && 'lockfile-census.sbom.json'.startsWith(rule))).toBe(false);
  });
});

/**
 * SHIPPED-DEPENDENCY MEASUREMENT — the unit that was wrong.
 *
 * The first version of this guard counted `packages` ENTRIES and called the total "deps".
 * Every count it printed was accurate; none of them measured shipped dependencies. That
 * is the failure this block exists to keep fixed, and it is harder to see than a wrong
 * number, because a plausible count carries no signal that it is counting the wrong thing.
 */
describe('npmDepCounts / cargoDepCounts', () => {
  const devOnlyLock = {
    packages: {
      '': { name: 'thing', version: '1.0.0' },
      'node_modules/@tauri-apps/cli': { version: '2.11.0', dev: true },
      'node_modules/@tauri-apps/cli-linux-x64-gnu': { version: '2.11.0', dev: true, optional: true },
    },
  };

  it('counts a wholly-dev lockfile as shipping ZERO, not as N deps', () => {
    expect(npmDepCounts(devOnlyLock)).toEqual({ shipped: 0, devOnly: 2, total: 2, rootName: 'thing' });
  });

  it('counts a runtime dependency as shipped', () => {
    const counts = npmDepCounts({
      packages: {
        '': { name: 'thing', version: '1.0.0' },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/vitest': { version: '4.0.0', dev: true },
      },
    });
    expect(counts).toEqual({ shipped: 1, devOnly: 1, total: 2, rootName: 'thing' });
  });

  // A package resolved at two paths — dev in one tree, runtime in another — ships. This
  // is the case that made a naive "is this name dev anywhere?" control give a false
  // reading against the real root lockfile.
  it('treats a package resolved BOTH dev and runtime as shipped, never dev-only', () => {
    const counts = npmDepCounts({
      packages: {
        '': { name: 'thing', version: '1.0.0' },
        'node_modules/tinyglobby': { version: '1.0.0', dev: true },
        'apps/x/node_modules/tinyglobby': { version: '1.0.0' },
      },
    });
    expect(counts).toEqual({ shipped: 1, devOnly: 0, total: 1, rootName: 'thing' });
  });

  it('REFUSES a lockfile with no packages map rather than reporting it as shipping nothing', () => {
    expect(() => npmDepCounts({})).toThrow(/cannot measure/);
    expect(() => npmDepCounts(null)).toThrow(/cannot measure/);
  });

  it('REFUSES a Cargo.lock that parsed to zero packages', () => {
    expect(() => cargoDepCounts('# not a lockfile\n')).toThrow(/ZERO \[\[package\]\]/);
    expect(cargoDepCounts('[[package]]\nname = "a"\n[[package]]\nname = "b"\n').shipped).toBe(2);
  });

  it('records an unreadable lockfile as null, never as zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-measure-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), '{ this is not json');
      const m = measureLockfiles(dir, ['package-lock.json']);
      // null and {shipped:0} must not collapse: one is "we could not read it", the other
      // is "it ships nothing", and only the second may excuse a file from classification.
      expect(m.get('package-lock.json')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('build-only classification is DERIVED from the measurement', () => {
  const lockfiles = ['shipped-thing/package-lock.json'];
  const measured = (m: unknown) =>
    classify(lockfiles, { uncovered: new Map(), measurements: new Map([[lockfiles[0], m]]) })
      .rows[0];

  it('excuses a lockfile that resolves zero runtime dependencies', () => {
    expect(measured({ shipped: 0, devOnly: 12, total: 12 }).bucket).toBe('build-only');
  });

  it('does NOT excuse one that resolves even a single runtime dependency', () => {
    expect(measured({ shipped: 1, devOnly: 11, total: 12 }).bucket).toBe('UNCLASSIFIED');
  });

  // The load-bearing half. If an unmeasurable lockfile fell into build-only, a parse
  // failure would silently excuse a file from coverage — turning the guard's own blind
  // spot into a clean bucket, which is precisely the class it was built to expose.
  it('does NOT excuse a lockfile it could not measure', () => {
    expect(measured(null).bucket).toBe('UNCLASSIFIED');
  });

  it('does NOT excuse an empty lockfile with no dev entries either', () => {
    expect(measured({ shipped: 0, devOnly: 0, total: 0 }).bucket).toBe('UNCLASSIFIED');
  });
});

/**
 * THE SBOM POSITIVE CONTROL.
 *
 * The check this replaces was `components === 0`. Measured against the real desktop npm
 * lockfile, a syft run that catalogued NO dependency at all still returned 2 components —
 * the synthetic `type: 'file'` node for the scanned path, plus the subject's own root
 * package. The threshold sat below the value that "catalogued nothing" actually produces,
 * so it could not fire. A guard whose failing condition is unreachable is not weak; it is
 * unfalsifiable, and its green is quoted as evidence exactly like a real one.
 */
describe('countCataloguedDependencies', () => {
  const bom = (components: unknown[]) => ({ components });

  // The exact two components a syft run that catalogued NO dependency actually returned
  // for papercusp-desktop/package-lock.json, measured 2026-09-05. Under the old
  // `components === 0` check this shape scored 2 and passed.
  it('excludes the synthetic file node and the subject root package', () => {
    expect(
      countCataloguedDependencies(
        bom([
          { name: '@papercusp/desktop', version: '0.0.17', type: 'library' },
          { name: '/repo/papercusp-desktop/package-lock.json', type: 'file' },
        ]),
        'papercusp-desktop/package-lock.json',
        '/repo',
        '@papercusp/desktop',
      ),
    ).toBe(0);
  });

  // Without the lockfile's own root name it cannot be told from a dependency, so the
  // count is deliberately conservative rather than guessing — one component too many
  // fails no gate, whereas silently dropping a real dependency would hide a gap.
  it('keeps the root package when its name was not supplied', () => {
    expect(
      countCataloguedDependencies(
        bom([
          { name: '@papercusp/desktop', version: '0.0.17', type: 'library' },
          { name: '/repo/papercusp-desktop/package-lock.json', type: 'file' },
        ]),
        'papercusp-desktop/package-lock.json',
        '/repo',
      ),
    ).toBe(1);
  });

  it('counts real dependencies', () => {
    expect(
      countCataloguedDependencies(
        bom([
          { name: '/repo/package-lock.json', type: 'file' },
          { name: 'left-pad', version: '1.3.0', type: 'library' },
          { name: 'vitest', version: '4.0.0', type: 'library' },
        ]),
        'package-lock.json',
        '/repo',
      ),
    ).toBe(2);
  });

  it('survives a document with no components at all', () => {
    expect(countCataloguedDependencies({}, 'package-lock.json', '/repo')).toBe(0);
  });
});

describe('assertSbomCoverage', () => {
  it('PASSES when the catalog meets the lockfile’s own shipped count', () => {
    // The three real 2026-09-05 calibration points, verbatim: docs-viewer 509/509,
    // Cargo 615/615, root 2469 shipped / 2481 catalogued (+12 workspace package nodes).
    expect(() => assertSbomCoverage('a', 509, { shipped: 509, devOnly: 0, total: 509 })).not.toThrow();
    expect(() => assertSbomCoverage('a', 615, { shipped: 615, devOnly: 0, total: 615 })).not.toThrow();
    expect(() => assertSbomCoverage('a', 2481, { shipped: 2469, devOnly: 1250, total: 3719 })).not.toThrow();
    // Build-only: zero shipped, zero catalogued, and that agreement is the pass.
    expect(() => assertSbomCoverage('a', 0, { shipped: 0, devOnly: 12, total: 12 })).not.toThrow();
  });

  it('REFUSES a catalog shorter than the lockfile it was made from', () => {
    expect(() => assertSbomCoverage('x/package-lock.json', 0, { shipped: 12, devOnly: 0, total: 12 })).toThrow(
      /missing 12 of them/,
    );
  });

  // The exact historical shape: a cataloger that read nothing, reported through the OLD
  // total-component count, looks like a pass. Through the dependency count plus the
  // lockfile's own reading, it is a refusal.
  it('REFUSES the measured desktop-lockfile shape that the old zero-check let through', () => {
    expect(() => assertSbomCoverage('papercusp-desktop/package-lock.json', 0, { shipped: 12, devOnly: 0, total: 12 })).toThrow(
      /A short catalog is not a small graph/,
    );
  });

  it('still refuses an empty catalog when it has no independent measurement to compare', () => {
    expect(() => assertSbomCoverage('x', 0, null)).toThrow(/cannot be corroborated/);
    expect(() => assertSbomCoverage('x', 3, null)).not.toThrow();
  });
});

describe('the repository itself (real-tree assertion)', () => {
  const lockfiles = censusOrThrow(ROOT);
  const rootLock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as unknown;
  const measurements = measureLockfiles(ROOT, lockfiles);
  const result = classifyCensus({
    lockfiles,
    workspaceDirs: rootWorkspaceDirs(rootLock),
    measurements,
  });

  it('has every lockfile in the tree explicitly classified', () => {
    expect(result.offenders.map((o) => o.path)).toEqual([]);
  });

  it('has no stale curated entry', () => {
    expect(result.stale.map((s) => `${s.source}:${s.path}`)).toEqual([]);
  });

  // The blind spot this guard was built from is RESOLVED, not dropped — and this test is
  // why that distinction survived: it forced the removal to arrive with evidence instead of
  // a comment. docs-viewer was reclassified NOT_SHIPPED on 2026-09-05 (WI-2144851) because
  // papercusp-desktop/bin/build-desktop-sidecar.sh — the actual desktop harness-copy step —
  // enumerates packages/harness with `find -type f` and excludes `./docs-viewer/*` BY NAME.
  // The note is pinned to that script rather than to the weaker corroborating reasons
  // (tauri.conf resources, bundle-host.sh, lazy npm install) because it is the one route
  // that could have swept the viewer in, so it is the one a future reader must re-check.
  // The row must still be CLASSIFIED AND EXPLAINED: a lockfile may leave the debt list by
  // being accounted for, never by disappearing, so both halves are asserted here.
  it('records no uncovered advisory blind spot, and still accounts for the row that left', () => {
    expect(result.rows.filter((r) => r.bucket === 'uncovered-baselined').map((r) => r.path)).toEqual(
      [],
    );
    const viewer = result.rows.find(
      (r) => r.path === 'libs/papercusp/packages/harness/docs-viewer/package-lock.json',
    );
    expect(viewer?.bucket).toBe('not-shipped');
    expect(viewer?.note ?? '').toMatch(/build-desktop-sidecar\.sh/);
  });

  // THE CORRECTION. This row was baselined as "12 deps ... SHIPPED ... the highest-
  // priority row here" while every one of those 12 entries is `dev: true` build tooling.
  // The count was accurate and its unit was wrong, which is why nothing about it looked
  // suspect. Pinned as a real-tree assertion rather than a comment so re-baselining it as
  // shipped debt has to first make the lockfile actually resolve a runtime dependency.
  it('classifies the desktop npm lockfile as build-only, not as shipped debt', () => {
    const row = result.rows.find((r) => r.path === 'papercusp-desktop/package-lock.json');
    expect(row?.bucket).toBe('build-only');
    expect(row?.measured?.shipped).toBe(0);
    expect(row?.measured?.devOnly).toBeGreaterThan(0);
  });

  // The other half of the same correction, KEPT across the reclassification. docs-viewer is
  // not-shipped because of how it is built and bundled, NOT because its graph is small — it
  // still resolves a large runtime graph. Retaining the measurement means a future change
  // that shrinks this lockfile has to fail here rather than quietly agree with the
  // not-shipped verdict for the wrong reason.
  it('measures the reclassified docs-viewer row as still resolving a large runtime graph', () => {
    const row = result.rows.find(
      (r) => r.path === 'libs/papercusp/packages/harness/docs-viewer/package-lock.json',
    );
    expect(row?.bucket).toBe('not-shipped');
    expect(row?.measured?.shipped).toBeGreaterThan(400);
  });

  it('measures every npm and cargo lockfile in the tree', () => {
    const unmeasured = result.rows
      .filter((r) => (r.ecosystem === 'npm' || r.ecosystem === 'cargo') && r.measured === null)
      .map((r) => r.path);
    expect(unmeasured).toEqual([]);
  });

  // CROSS-GUARD INVARIANT. "covered" is a claim about what ANOTHER script scans; if that
  // script narrows its scope, this census keeps calling the lockfile covered and the blind
  // spot reopens silently. Read the sibling's own exported scope instead of trusting a
  // duplicated path string.
  it('only calls a Cargo.lock covered if the Rust gate actually scans it', () => {
    const claimed = [...COVERED_LOCKFILES.keys()].filter((p) => p.endsWith('Cargo.lock')).sort();
    expect(claimed).toEqual([...SHIPPED_LOCKFILES].sort());
  });

  it('keeps the uncovered baseline shrink-only and reason-carrying', () => {
    // Ratcheted 2 -> 1 when papercusp-desktop/package-lock.json left the baseline for the
    // DERIVED build-only bucket, then 1 -> 0 on 2026-09-05 (WI-2144851) when the last entry,
    // libs/papercusp/packages/harness/docs-viewer/package-lock.json, earned its way out to
    // NOT_SHIPPED_LOCKFILES with the bundling evidence its baseline reason asked for.
    // Shrink-only means this number goes down or an entry earns its way out with a
    // measurement; it is never raised to make room for a new blind spot. At 0 the loop below
    // is vacuous ON PURPOSE — the ceiling is now the whole guard, and it fails the moment
    // anything is appended, which is exactly when a new blind spot would otherwise be quiet.
    expect(UNCOVERED_BASELINE.size).toBeLessThanOrEqual(0);
    for (const [path, entry] of UNCOVERED_BASELINE) {
      expect(entry.reason.length, `${path} needs a real reason`).toBeGreaterThan(40);
      expect(entry.deps, `${path} needs its measured graph size`).toBeGreaterThan(0);
    }
  });

  it('gives every not-shipped entry a stated reason', () => {
    for (const [path, reason] of NOT_SHIPPED_LOCKFILES) {
      expect(reason.length, `${path} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
