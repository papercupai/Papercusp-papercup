/**
 * module-reachability.test.ts — the MODULE axis of check-lint-guard-reachability
 * (WI-41775, plan decisions D-013 → D-014 → D-015).
 *
 * ⚠ READ THIS BEFORE TRUSTING A GREEN HERE. By the host guard's OWN doctrine, these are
 * `logic-test` tier: they feed pure helpers fixtures and prove the DETECTOR works. They
 * run the detector over nothing, so they enforce nothing. The enforcement is that
 * `check-lint-guard-reachability.mjs` calls the same helpers over the real tree on a
 * blocking green-checkpoint leg. A green file here and a rotting guard are perfectly
 * compatible states — that sentence is in the host script's header and it applies to
 * this file too.
 *
 * What these tests ARE for: pinning the two failure directions that a real-tree run
 * cannot show you, because both of them look like success.
 */
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

import {
  assessGraphHealth,
  buildImportGraph,
  buildShipmentDispositionInventory,
  detectEntrypointMarkers,
  findInaccurateAcknowledgements,
  findUnreachableModules,
  findUnclassifiedShipmentModules,
  isExecutionPathMentionSource,
  isTestFile,
  NEW_MODULE_GRACE_DAYS,
  parseImportSpecifiers,
  parseReleasePathMentions,
  partitionByGracePeriod,
  resolveGraceClock,
  resolveSpecifier,
  selectDetectorModules,
  selfExclusionPaths,
} from '../../../../scripts/lib/module-reachability.mjs';

const GUARD = 'scripts/check-lint-guard-reachability.mjs';
const DETECTOR = 'apps/operator/lib/release/prompt-divergence.ts';
const DETECTOR_TEST = 'apps/operator/lib/release/prompt-divergence.test.ts';

describe('sidecar spawn-plan execution edges', () => {
  const worker = 'packages/operator-core/lib/release/admission-fix-precheck-worker-bin.ts';
  const caller = 'packages/operator-core/lib/release/admission-fix-precheck-managed.ts';
  const anchored = 'const moduleDir = dirname(fileURLToPath(import.meta.url));';
  const graph = (source: string) => buildImportGraph({
    files: [worker, caller], readFile: file => file === caller ? source : '',
    stripComments: stripCommentsOnly,
  });

  it('reaches the sibling worker passed to the maintained sidecar planner', () => {
    const source = anchored + `\nreturn resolveSidecarSpawnPlan({
      selfPath: options.selfPath ?? fileURLToPath(import.meta.url),
      devScriptPath: join(options.moduleDirOverride ?? moduleDir, 'admission-fix-precheck-worker-bin.ts'),
    });`;
    expect([...graph(source).pathMentions.get(worker) ?? []]).toEqual([caller]);
  });

  it.each([
    anchored + `\nconst inventory = { devScriptPath: join(moduleDir, 'admission-fix-precheck-worker-bin.ts') };`,
    `const moduleDir = configuredDirectory; resolveSidecarSpawnPlan({ devScriptPath: join(moduleDir, 'admission-fix-precheck-worker-bin.ts') });`,
    anchored + `\n// resolveSidecarSpawnPlan({ devScriptPath: join(moduleDir, 'admission-fix-precheck-worker-bin.ts') });`,
  ])('rejects passive, unanchored and commented worker paths: %s', source => {
    expect(graph(source).pathMentions.has(worker)).toBe(false);
  });
});

describe('selectDetectorModules', () => {
  it('takes lib/release sources and excludes tests, declarations and other trees', () => {
    const files = [
      DETECTOR,
      DETECTOR_TEST,
      'packages/operator-core/lib/release/external-prerequisites.ts',
      'packages/operator-core/lib/release/thing.d.ts',
      'packages/operator-core/lib/harness/unrelated.ts',
      'scripts/lib/module-reachability.mjs',
    ];
    expect(selectDetectorModules(files)).toEqual([
      DETECTOR,
      'packages/operator-core/lib/release/external-prerequisites.ts',
    ]);
  });

  it('excludes an index-known module deleted from the current working tree', () => {
    // EI-22573056324485508: `git ls-files` still returns a deleted path until commit.
    // The enforcing guard must honor the physical tree immediately, or its prescribed
    // DELETE remedy cannot produce a local green before git-sync runs.
    const present = new Set(['apps/operator/lib/release/still-here.ts']);
    expect(
      selectDetectorModules(
        [DETECTOR, 'apps/operator/lib/release/still-here.ts'],
        (file) => present.has(file),
      ),
    ).toEqual(['apps/operator/lib/release/still-here.ts']);
  });
});

describe('parseImportSpecifiers', () => {
  it('finds static, side-effect, re-export, dynamic and require forms', () => {
    const text = [
      "import { a } from './static';",
      "import './side-effect';",
      "export { b } from './re-export';",
      "const c = await import('./dynamic');",
      "const d = require('./required');",
    ].join('\n');
    expect(parseImportSpecifiers(text).sort()).toEqual([
      './dynamic',
      './re-export',
      './required',
      './side-effect',
      './static',
    ]);
  });

  // REGRESSION. The gap before the specifier must cross NEWLINES. A long specifier is
  // wrapped onto its own line by the formatter, which is the ordinary shape of a
  // dynamic import of a workspace subpath — so with a horizontal-only gap, whether a
  // module counted as wired depended on how prettier happened to wrap the call. Three
  // live green-checkpoint dependencies were reported TESTED-BUT-UNWIRED, whose stated
  // remedy is "wire or delete"; deleting them would have removed live gate code.
  it('finds a dynamic import whose specifier is wrapped onto the next line', () => {
    const wrapped = [
      'const { buildFrozenRepairConvergenceBroadcast } = await import(',
      '  "@papercusp/operator-core/lib/release/frozen-repair-agent-routing"',
      ');',
    ].join('\n');
    expect(parseImportSpecifiers(wrapped)).toEqual([
      '@papercusp/operator-core/lib/release/frozen-repair-agent-routing',
    ]);
  });

  it('finds wrapped `from` and `require` forms too', () => {
    expect(parseImportSpecifiers('import { a }\n  from\n  "./sibling";')).toEqual(['./sibling']);
    expect(parseImportSpecifiers('const z = require(\n  "./thing"\n);')).toEqual(['./thing']);
  });
});

describe('resolveSpecifier', () => {
  const fileSet = new Set([
    'apps/operator/lib/release/target.ts',
    'packages/operator-core/lib/release/pkg-target.ts',
    'apps/operator/lib/release/dir/index.ts',
  ]);
  const workspaceDirByName = new Map([['@papercusp/operator-core', 'packages/operator-core']]);

  it('resolves a relative specifier', () => {
    expect(
      resolveSpecifier({ specifier: './target', fromFile: DETECTOR, fileSet, workspaceDirByName }),
    ).toBe('apps/operator/lib/release/target.ts');
  });

  it("resolves NodeNext's ./x.js spelling of a TypeScript ./x.ts", () => {
    // Missing this under-counts importers, i.e. reports a LIVE module as dead — the
    // false-positive direction that would red-pin the gate on a healthy tree.
    expect(
      resolveSpecifier({ specifier: './target.js', fromFile: DETECTOR, fileSet, workspaceDirByName }),
    ).toBe('apps/operator/lib/release/target.ts');
  });

  it('resolves a workspace package subpath and a directory index', () => {
    expect(
      resolveSpecifier({
        specifier: '@papercusp/operator-core/lib/release/pkg-target',
        fromFile: DETECTOR,
        fileSet,
        workspaceDirByName,
      }),
    ).toBe('packages/operator-core/lib/release/pkg-target.ts');
    expect(
      resolveSpecifier({ specifier: './dir', fromFile: DETECTOR, fileSet, workspaceDirByName }),
    ).toBe('apps/operator/lib/release/dir/index.ts');
  });

  it('returns null for anything outside the repo', () => {
    for (const specifier of ['node:fs', 'vitest', '@some/external']) {
      expect(resolveSpecifier({ specifier, fromFile: DETECTOR, fileSet, workspaceDirByName })).toBeNull();
    }
  });
});

describe('findUnreachableModules', () => {
  it('CALIBRATION: a module with a real production importer is alive', () => {
    // Without this control, every other expectation below is also satisfied by a probe
    // that simply calls everything dead.
    const { rows } = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map([[DETECTOR, new Set(['apps/operator/lib/release/green-checkpoint.ts'])]]),
    });
    expect(rows[0].dead).toBe(false);
  });

  it('THE CLASS: a module imported ONLY by its own test is dead, and flagged tested-but-unwired', () => {
    // This is the case knip cannot see: test files are entry points to knip, so the
    // test import reads as usage and the module is reported fully used (D-015 §4).
    const { rows } = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map([[DETECTOR, new Set([DETECTOR_TEST])]]),
    });
    expect(rows[0].dead).toBe(true);
    expect(rows[0].testedButUnwired).toBe(true);
    expect(rows[0].testImporters).toEqual([DETECTOR_TEST]);
  });

  it('kills a module kept alive only by another DEAD module (transitive, no root set)', () => {
    const a = 'apps/operator/lib/release/a.ts';
    const b = 'apps/operator/lib/release/b.ts';
    const { rows, rounds } = findUnreachableModules({
      population: [a, b],
      // b imports a; nothing imports b. One pass kills b, the next kills a.
      importers: new Map([[a, new Set([b])]]),
    });
    expect(rows.every((r) => r.dead)).toBe(true);
    expect(rounds).toBeGreaterThan(1);
    // The distinction survives into the row: "imported only by something dead" and
    // "imported by nothing" are different findings for whoever triages them.
    expect(rows.find((r) => r.module === a)!.productionImporters).toEqual([b]);
  });

  it('treats a literal path mention as execution, so an entry point is not reported dead', () => {
    // A gate entry is spawned by path, never imported. Without this, every entry module
    // in the population would be a false positive.
    const { rows } = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map(),
      pathMentions: new Map([[DETECTOR, new Set(['apps/operator/lib/release/routine.ts'])]]),
    });
    expect(rows[0].dead).toBe(false);
  });

  it('REGRESSION: the instrument must not resurrect a module by NAMING it in its allowlist', () => {
    // Measured 2026-08-26 during bring-up. The guard's acknowledged-unreachable
    // allowlist is a list of lib/release paths, and the mention scan reads a literal
    // path as execution evidence — so the first wired run reported ALL 21 known-dead
    // modules alive, each with exactly one "production importer": the guard itself.
    //
    // It failed GREEN. An empty finding set and a passing watermark are indistinguishable
    // from a clean tree, so the guard would have measured nothing forever while looking
    // like diligence. Same remedy as scripts/proc-guard.mjs excluding its own ancestors.
    const mentions = new Map([[DETECTOR, new Set([GUARD])]]);

    const unguarded = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map([[DETECTOR, new Set([DETECTOR_TEST])]]),
      pathMentions: mentions,
    });
    // The defect, reproduced: without the exclusion the module reads as alive.
    expect(unguarded.rows[0].dead).toBe(false);

    const guarded = findUnreachableModules({
      population: [DETECTOR],
      importers: new Map([[DETECTOR, new Set([DETECTOR_TEST])]]),
      pathMentions: mentions,
      excludeReachers: new Set([GUARD]),
    });
    expect(guarded.rows[0].dead).toBe(true);
    expect(guarded.rows[0].testedButUnwired).toBe(true);
  });
});

describe('buildShipmentDispositionInventory', () => {
  const live = {
    module: 'apps/operator/lib/release/live.ts',
    dead: false,
    productionImporters: ['apps/operator/lib/release/caller.ts'],
    testImporters: ['apps/operator/lib/release/live.test.ts'],
    testedButUnwired: false,
  };
  const dead = {
    module: 'apps/operator/lib/release/dead.ts',
    dead: true,
    productionImporters: [],
    testImporters: ['apps/operator/lib/release/dead.test.ts'],
    testedButUnwired: true,
  };

  it('generates a wired disposition with a non-test caller citation', () => {
    const [row] = buildShipmentDispositionInventory({ rows: [live] });
    expect(row.shipmentDisposition).toEqual({
      status: 'classified',
      kind: 'wired',
      citation: {
        kind: 'non-test-production-caller',
        path: 'apps/operator/lib/release/caller.ts',
      },
    });
  });

  it('accepts a seam only with an approved decision and test citation', () => {
    const [row] = buildShipmentDispositionInventory({
      rows: [dead],
      dispositions: new Map([
        [
          dead.module,
          {
            kind: 'seam',
            decision: 'D-044',
            test: 'apps/operator/lib/release/dead.test.ts',
          },
        ],
      ]),
    });
    expect(row.shipmentDisposition).toMatchObject({
      status: 'classified',
      kind: 'seam',
      decision: 'D-044',
    });
  });

  it('keeps a missing or malformed disposition unclassified', () => {
    const inventory = buildShipmentDispositionInventory({
      rows: [dead, { ...dead, module: 'apps/operator/lib/release/bad-seam.ts' }],
      dispositions: new Map([
        [
          'apps/operator/lib/release/bad-seam.ts',
          { kind: 'seam', decision: 'not-a-decision', test: 'fixture.ts' },
        ],
      ]),
    });
    expect(findUnclassifiedShipmentModules(inventory).map((row) => row.module)).toEqual([
      dead.module,
      'apps/operator/lib/release/bad-seam.ts',
    ]);
    expect(inventory[1].shipmentDisposition.errors).toEqual([
      'seam disposition requires an approved D-NNN decision',
      'seam disposition requires a test-file citation',
    ]);
  });

  it('accepts an explicit dead/delete disposition', () => {
    const [row] = buildShipmentDispositionInventory({
      rows: [dead],
      dispositions: new Map([
        [
          dead.module,
          {
            kind: 'dead',
            action: 'delete',
            reason: 'no production caller after the completed plan',
          },
        ],
      ]),
    });
    expect(row.shipmentDisposition).toMatchObject({
      status: 'classified',
      kind: 'dead',
      action: 'delete',
    });
  });
});

describe('selfExclusionPaths', () => {
  it('derives the probe path from import.meta.url, not a hardcoded string', () => {
    // Hardcoding it would let a rename silently re-open the self-observation hole.
    const paths = [...selfExclusionPaths('/repo/root')];
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith('scripts/lib/module-reachability.mjs')).toBe(true);
    expect(paths[0].startsWith('/')).toBe(false);
  });
});

describe('assessGraphHealth — the instrument checks that it can SEE', () => {
  it('refuses to report when the resolver produced no edges at all', () => {
    const health = assessGraphHealth({
      resolvedEdges: 0,
      population: [DETECTOR],
      dead: [],
      unresolvedRelative: [],
    });
    expect(health.measurable).toBe(false);
    expect(health.reason).toMatch(/ZERO edges/);
  });

  it('refuses to report when EVERY module reads as dead', () => {
    // A probe that finds nothing alive has failed to see the tree. Reporting that as a
    // wall of violations would red-pin the fleet gate on an instrument fault — the
    // failure this guard's own header warns is worse than the defect it looks for.
    const health = assessGraphHealth({
      resolvedEdges: 5000,
      population: [DETECTOR, 'apps/operator/lib/release/other.ts'],
      dead: [DETECTOR, 'apps/operator/lib/release/other.ts'],
      unresolvedRelative: [],
    });
    expect(health.measurable).toBe(false);
    expect(health.reason).toMatch(/failed to see the tree/);
  });

  it('reports normally when some are alive and some are dead', () => {
    const health = assessGraphHealth({
      resolvedEdges: 5000,
      population: [DETECTOR, 'apps/operator/lib/release/other.ts'],
      dead: [DETECTOR],
      unresolvedRelative: [{ from: 'a.ts', specifier: './b' }],
    });
    expect(health.measurable).toBe(true);
    expect(health.unresolvedRelativeCount).toBe(1);
  });
});

describe('buildImportGraph', () => {
  it('links importers and path-mentioners, and reports unresolved relative specifiers', () => {
    const files = [DETECTOR, 'apps/operator/lib/release/caller.ts', 'apps/operator/lib/routine.ts'];
    const bodies: Record<string, string> = {
      [DETECTOR]: 'export const x = 1;',
      'apps/operator/lib/release/caller.ts': "import { x } from './prompt-divergence';\nimport './missing';",
      'apps/operator/lib/routine.ts': `spawn('tsx', ['${DETECTOR}']);`,
    };
    const graph = buildImportGraph({ files, readFile: (f: string) => bodies[f] ?? '' });

    expect([...(graph.importers.get(DETECTOR) ?? [])]).toEqual(['apps/operator/lib/release/caller.ts']);
    expect([...(graph.pathMentions.get(DETECTOR) ?? [])]).toEqual(['apps/operator/lib/routine.ts']);
    // An unresolved RELATIVE specifier is reported rather than swallowed: silently
    // dropping edges under-counts importers, which invents dead modules.
    expect(graph.unresolvedRelative).toEqual([
      { from: 'apps/operator/lib/release/caller.ts', specifier: './missing' },
    ]);
  });

  // REGRESSION. "Named in an npm script" is the first case the path-mention scan exists
  // to cover, but a workspace's own package.json can only spell the path relative to
  // itself — which the repo-relative mention regex can never match. The CLI whose npm
  // script runs it was therefore reported called-by-nothing, under "wire or delete".
  it('resolves a workspace-relative detector path named in that workspace package.json', () => {
    const files = [DETECTOR, 'apps/operator/package.json'];
    const bodies: Record<string, string> = {
      [DETECTOR]: 'export const x = 1;',
      'apps/operator/package.json':
        '{"scripts":{"release:x":"tsx lib/release/prompt-divergence.ts"}}',
    };
    const graph = buildImportGraph({ files, readFile: (f: string) => bodies[f] ?? '' });

    expect([...(graph.pathMentions.get(DETECTOR) ?? [])]).toEqual(['apps/operator/package.json']);
  });

  it('does NOT treat a passive JSON/YAML inventory as execution evidence', () => {
    // WI-2145418: a file-set SHA manifest named two acknowledged-dead modules and the
    // checker called both WIRED, even though the manifest is never executed. Baselines,
    // corpora and evidence matrices have the same shape: a path is data, not a caller.
    const files = [
      DETECTOR,
      'scratchpad/file-set-manifest.json',
      'reports/release-evidence.yaml',
    ];
    const bodies: Record<string, string> = {
      [DETECTOR]: 'export const x = 1;',
      'scratchpad/file-set-manifest.json': JSON.stringify({
        entries: [{ path: DETECTOR, sha256: 'abc' }],
      }),
      'reports/release-evidence.yaml': `subject: ${DETECTOR}`,
    };
    const graph = buildImportGraph({ files, readFile: (f: string) => bodies[f] ?? '' });

    expect([...(graph.pathMentions.get(DETECTOR) ?? [])]).toEqual([]);
    expect(isExecutionPathMentionSource('scratchpad/file-set-manifest.json')).toBe(false);
    expect(isExecutionPathMentionSource('reports/release-evidence.yaml')).toBe(false);
  });

  it('DOES treat an actual workflow command as execution evidence', () => {
    // Positive control: narrowing passive data must not blind the entrypoint path the
    // mention scan exists to see.
    const workflow = '.github/workflows/release.yml';
    const files = [DETECTOR, workflow];
    const bodies: Record<string, string> = {
      [DETECTOR]: 'export const x = 1;',
      [workflow]: `steps:\n  - run: npx tsx ${DETECTOR}`,
    };
    const graph = buildImportGraph({ files, readFile: (f: string) => bodies[f] ?? '' });

    expect([...(graph.pathMentions.get(DETECTOR) ?? [])]).toEqual([workflow]);
    expect(isExecutionPathMentionSource(workflow)).toBe(true);
  });

  it('treats shell commands as execution evidence but ignores shell comment-only path mentions', () => {
    const caller = 'papercusp-desktop/bin/publish-release-instructions.sh';
    const commentOnly = 'apps/operator/bin/old-release-command.sh';
    const files = [DETECTOR, caller, commentOnly];
    const bodies: Record<string, string> = {
      [DETECTOR]: 'export const x = 1;',
      [caller]: [
        '#!/usr/bin/env bash',
        '# historical caller apps/operator/lib/release/prompt-divergence.ts',
        `npx tsx ${DETECTOR}`,
      ].join('\n'),
      [commentOnly]: [
        '#!/usr/bin/env bash',
        '# apps/operator/lib/release/prompt-divergence.ts was removed',
      ].join('\n'),
    };
    const graph = buildImportGraph({ files, readFile: (f: string) => bodies[f] ?? '' });

    expect([...(graph.pathMentions.get(DETECTOR) ?? [])]).toEqual([caller]);
    expect(isExecutionPathMentionSource(caller)).toBe(true);
  });

  // The lookbehind that keeps the fix above from inventing an edge: the TAIL of a
  // repo-relative mention must not be re-resolved against the manifest's own workspace,
  // or a same-named file in a different workspace reads as a caller — a dead module
  // reported alive, the one direction this instrument must never fail in.
  it('does not re-resolve the tail of a repo-relative mention against the wrong workspace', () => {
    // Same basename in two workspaces. The manifest lives in apps/operator and names the
    // PACKAGES copy by its full repo-relative path; the tail of that path is
    // `lib/release/prompt-divergence.ts`, which would resolve against the manifest's own
    // workspace straight onto DETECTOR if the lookbehind were dropped.
    const OTHER = 'packages/operator-core/lib/release/prompt-divergence.ts';
    const files = [DETECTOR, OTHER, 'apps/operator/package.json'];
    const bodies: Record<string, string> = {
      [DETECTOR]: 'export const x = 1;',
      [OTHER]: 'export const y = 1;',
      'apps/operator/package.json': `{"scripts":{"release:x":"tsx ${OTHER}"}}`,
    };
    const graph = buildImportGraph({ files, readFile: (f: string) => bodies[f] ?? '' });

    expect([...(graph.pathMentions.get(OTHER) ?? [])]).toEqual(['apps/operator/package.json']);
    expect([...(graph.pathMentions.get(DETECTOR) ?? [])]).toEqual([]);
  });
});

describe('grace period for newly-added modules', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-08-26T06:00:00Z');
  const OLD = 'apps/operator/lib/release/certified-but-dead.ts';
  const FRESH = 'apps/operator/lib/release/being-written-right-now.ts';

  // ⚠ BOTH DIRECTIONS ARE LOAD-BEARING. Only the pair distinguishes a working grace
  // period from a detector that has simply stopped reporting: a test that asserted only
  // "the fresh module does not fail" passes just as well against an axis gutted to
  // return nothing at all.
  it('JUDGES a module past the grace period — the detector still detects', () => {
    const { judged, inFlight } = partitionByGracePeriod({
      modules: [{ module: OLD }],
      addedAtByModule: new Map([[OLD, NOW - (NEW_MODULE_GRACE_DAYS + 1) * DAY]]),
      now: NOW,
    });
    expect(judged.map((r) => r.module)).toEqual([OLD]);
    expect(inFlight).toEqual([]);
  });

  it('SPARES a module inside the grace period — in-flight work never red-pins the fleet', () => {
    const { judged, inFlight } = partitionByGracePeriod({
      modules: [{ module: FRESH }],
      addedAtByModule: new Map([[FRESH, NOW - 20 * 60 * 1000]]),
      now: NOW,
    });
    expect(judged).toEqual([]);
    expect(inFlight.map((r) => r.module)).toEqual([FRESH]);
    expect(inFlight[0]!.ageDays).toBeLessThan(1);
  });

  it('splits a mixed population instead of failing or sparing all of it', () => {
    const { judged, inFlight } = partitionByGracePeriod({
      modules: [{ module: OLD }, { module: FRESH }],
      addedAtByModule: new Map([
        [OLD, NOW - 30 * DAY],
        [FRESH, NOW - 1 * DAY],
      ]),
      now: NOW,
    });
    expect(judged.map((r) => r.module)).toEqual([OLD]);
    expect(inFlight.map((r) => r.module)).toEqual([FRESH]);
  });

  it('FAILS OPEN on an unknown add-date rather than red-pinning on its own degraded lookup', () => {
    // An empty map is exactly what readModuleAddDates returns when git fails. The axis
    // must go advisory, not hard-fail every unreachable module at once.
    const { judged, inFlight } = partitionByGracePeriod({
      modules: [{ module: OLD }, { module: FRESH }],
      addedAtByModule: new Map(),
      now: NOW,
    });
    expect(judged).toEqual([]);
    expect(inFlight.map((r) => r.module)).toEqual([OLD, FRESH]);
    expect(inFlight.every((r) => r.ageDays === null)).toBe(true);
  });

  it('preserves the diagnostic fields the report prints for each module', () => {
    // The row carries testedButUnwired/testImporters; dropping them on the way through
    // the partition would silently blank the "it LOOKS covered" warning.
    const row = { module: OLD, testedButUnwired: true, testImporters: ['a.test.ts'] };
    const { judged } = partitionByGracePeriod({
      modules: [row],
      addedAtByModule: new Map([[OLD, NOW - 90 * DAY]]),
      now: NOW,
    });
    expect(judged[0]).toMatchObject({ testedButUnwired: true, testImporters: ['a.test.ts'] });
  });
});

describe('grace clock — a frozen candidate gets the same verdict every time (WI-10004093)', () => {
  // The measured incident: repair head 7652f8c9 (an admission commit, stamped 2000-01-01)
  // on frozen candidate 5ec99902 (committed 2026-09-29T18:12:21Z) PASSED at 00:36Z and
  // FAILED at 01:39Z, because this module's 7-day grace expired at 01:17:09Z in between.
  const DAY = 24 * 60 * 60 * 1000;
  const MODULE = 'apps/operator/lib/release/run-p2p-candidate-manifest.ts';
  const ADDED = Date.parse('2026-09-23T01:17:09Z');
  const ADMISSION_STAMP = Date.parse('2000-01-01T00:00:00Z');
  const CANDIDATE = Date.parse('2026-09-29T18:12:21Z');
  const REPAIR_HEAD_HISTORY = [ADMISSION_STAMP, ADMISSION_STAMP, CANDIDATE, CANDIDATE - DAY];

  const verdictAt = (wallClockMs: number, commitTimesMs: number[], addedAt = ADDED) =>
    partitionByGracePeriod({
      modules: [{ module: MODULE }],
      addedAtByModule: new Map([[MODULE, addedAt]]),
      now: resolveGraceClock({ commitTimesMs, wallClockMs }).now,
    }).judged.map((r) => r.module);

  it('gives the same sha the same verdict before and after the wall clock crosses the grace', () => {
    const before = verdictAt(Date.parse('2026-09-30T00:36:00Z'), REPAIR_HEAD_HISTORY);
    const after = verdictAt(Date.parse('2026-09-30T01:39:00Z'), REPAIR_HEAD_HISTORY);
    expect(before).toEqual([]);
    expect(after).toEqual(before);
  });

  it('CONTROL: judged by the wall clock, the same inputs flip — the drift this clock removes', () => {
    // Without this, the test above would also pass against a grace period that never judges.
    expect(verdictAt(Date.parse('2026-09-30T00:36:00Z'), [])).toEqual([]);
    expect(verdictAt(Date.parse('2026-09-30T01:39:00Z'), [])).toEqual([MODULE]);
  });

  it('still JUDGES an old module on a repair head whose own commit is stamped 2000-01-01', () => {
    // Reading HEAD's time alone would put "now" decades before every add date, so the axis
    // could never fail on a repair head. The newest time in the ancestry is the candidate's.
    expect(verdictAt(Date.parse('2026-09-30T01:39:00Z'), REPAIR_HEAD_HISTORY, CANDIDATE - 30 * DAY)).toEqual([
      MODULE,
    ]);
    expect(resolveGraceClock({ commitTimesMs: REPAIR_HEAD_HISTORY, wallClockMs: 0 })).toEqual({
      now: CANDIDATE,
      source: 'commit-history',
    });
  });

  it('falls back to the wall clock, and says so, only when no commit time is readable', () => {
    expect(resolveGraceClock({ commitTimesMs: [], wallClockMs: 123 })).toEqual({ now: 123, source: 'wall-clock' });
    expect(resolveGraceClock({ commitTimesMs: [Number.NaN, 0], wallClockMs: 456 })).toEqual({
      now: 456,
      source: 'wall-clock',
    });
  });
});

describe('helpers', () => {
  it('classifies test files, and finds only fully-qualified release paths', () => {
    expect(isTestFile(DETECTOR_TEST)).toBe(true);
    expect(isTestFile(DETECTOR)).toBe(false);
    // A bare stem is NOT a path mention — a baseline file listing `lib/release/x.ts`
    // relative to its own workspace must not read as an execution site.
    expect(parseReleasePathMentions(`run('${DETECTOR}')`)).toEqual([DETECTOR]);
    expect(parseReleasePathMentions("run('lib/release/prompt-divergence.ts')")).toEqual([]);
  });
});

describe('detectEntrypointMarkers — the caller an import graph cannot see', () => {
  it('detects each entrypoint shape, and reports NONE for an ordinary module', () => {
    expect(detectEntrypointMarkers('const argv = process.argv.slice(2);')).toEqual(['process.argv']);
    expect(detectEntrypointMarkers('if (import.meta.url === x) main();')).toEqual(['import.meta.url']);
    expect(detectEntrypointMarkers('#!/usr/bin/env tsx\nconsole.log(1);')).toContain('shebang');

    // The negative direction is what stops a gutted implementation (one that returns a
    // marker for everything) from passing: an ordinary library module has no shape.
    expect(detectEntrypointMarkers('export function pure(a: number) { return a + 1; }')).toEqual([]);
    expect(detectEntrypointMarkers('')).toEqual([]);
    expect(detectEntrypointMarkers(undefined as unknown as string)).toEqual([]);
  });

  it('does not credit prose that merely MENTIONS argv', () => {
    // Word-boundary matching: a comment about argv is not an entrypoint. Over-crediting
    // here would silently soften the report for a genuinely dead module.
    expect(detectEntrypointMarkers('// unrelated: processArgvLike is not an entrypoint')).toEqual([]);
  });
});

describe('findInaccurateAcknowledgements — the guard that guards the guard', () => {
  const row = (over: Partial<Record<string, unknown>> = {}) => ({
    module: 'apps/operator/lib/release/x.ts',
    dead: true,
    productionImporters: [] as string[],
    testImporters: [] as string[],
    ...over,
  });

  it('FLAGS a reason claiming no caller when production importers exist', () => {
    const rows = [row({ productionImporters: ['apps/operator/lib/release/caller.ts'] })];
    const acknowledgements = new Map([
      ['apps/operator/lib/release/x.ts', 'no test, no caller — strongest retire candidate'],
    ]);
    const found = findInaccurateAcknowledgements({ rows, acknowledgements });
    expect(found).toHaveLength(1);
    expect(found[0].claim).toBe('no-caller');
    expect(found[0].contradictedBy).toEqual(['apps/operator/lib/release/caller.ts']);
  });

  it('ACCEPTS the accurate phrasing for the very same row', () => {
    // The calibration case. A check that flags the row above but ALSO flags this one is
    // not measuring accuracy, it is just matching on "has importers" — and would force
    // every transitively-dead family member to be described wrongly to stay green.
    const rows = [row({ productionImporters: ['apps/operator/lib/release/caller.ts'] })];
    const acknowledgements = new Map([
      ['apps/operator/lib/release/x.ts', 'reached only from dead publication siblings'],
    ]);
    expect(findInaccurateAcknowledgements({ rows, acknowledgements })).toEqual([]);
  });

  it('ACCEPTS a no-caller claim that is TRUE', () => {
    const rows = [row()];
    const acknowledgements = new Map([['apps/operator/lib/release/x.ts', '1 test, 0 callers — wire-or-retire']]);
    expect(findInaccurateAcknowledgements({ rows, acknowledgements })).toEqual([]);
  });

  it('FLAGS a false no-test claim against test importers', () => {
    const rows = [row({ testImporters: ['apps/operator/lib/release/x.test.ts'] })];
    const acknowledgements = new Map([['apps/operator/lib/release/x.ts', 'no test, no caller']]);
    const found = findInaccurateAcknowledgements({ rows, acknowledgements });
    expect(found).toHaveLength(1);
    expect(found[0].claim).toBe('no-test');
  });

  it('SKIPS rows that are not dead — staleAcknowledged already reports those', () => {
    const rows = [row({ dead: false, productionImporters: ['apps/operator/lib/release/live.ts'] })];
    const acknowledgements = new Map([['apps/operator/lib/release/x.ts', 'no caller']]);
    expect(findInaccurateAcknowledgements({ rows, acknowledgements })).toEqual([]);
  });

  it('SKIPS a module with no acknowledgement, and tolerates empty input', () => {
    const rows = [row({ productionImporters: ['a.ts'] })];
    expect(findInaccurateAcknowledgements({ rows, acknowledgements: new Map() })).toEqual([]);
    expect(findInaccurateAcknowledgements({ rows: [], acknowledgements: new Map() })).toEqual([]);
  });
});
