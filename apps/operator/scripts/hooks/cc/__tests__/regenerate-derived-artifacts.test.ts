/**
 * regenerate-derived-artifacts.test.ts — EI-20094472685960957 regression guard.
 *
 * ## The class this covers
 *
 * `.papercusp/testing-domains.json` is DERIVED from
 * `packages/operator-core/lib/testing-domains-registry.ts` by
 * `scripts/gen-testing-domains-contract.ts`, and is also COMMITTED (the harness
 * Tests tab reads it at runtime). Drift was never undetected —
 * `testing-domains-contract-freshness.test.ts` asserts
 * `expect(committed).toBe(generated)`. The defect was WHERE detection landed:
 * inside the full operator-core suite (~3978 tests, minutes, behind pc-heavy on a
 * loaded box), by which point a one-command fix presents as a red gate blocking
 * every agent's deploys, attributed to whoever is looking rather than to the edit
 * that caused it. Three occurrences of that exact shape — WI-37793,
 * EI-20081777912524409, WI-6235 — the first two ~2.5h apart.
 *
 * The fix has two halves, and this file asserts both, because either alone leaves
 * a live route to the same gate red:
 *
 *   1. EDIT TIME — `regenerate-declaration-before-lock-release.mjs` regenerates
 *      the artifact while the source's own edit lock is still held. That helper is
 *      invoked by posttooluse-locks-release.sh, posttoolbatch-locks-release.sh and
 *      omp/coord-hook.ts, so it covers Claude, Codex and OMP alike. This makes the
 *      stale state unreachable for edits made through a client's edit tool.
 *   2. EVERY OTHER ROUTE — the `gen:contract:check` entry in
 *      `REPO_WIDE_INVARIANT_GUARDS` (scripts/affected-tests.mjs) attaches a ~2s
 *      named task whenever a trigger path changes, covering `sed -i`, a client with
 *      no hooks enrolled, and a human editor.
 *
 * ## What this asserts, and what it does not
 *
 * It asserts the SELECTION rule (which edits strand which artifact), the
 * end-to-end wiring (selection actually reaches a generator), and the guard
 * ATTACHMENT through the real affected-tests CLI. It does NOT assert that
 * `gen:contract:check` correctly detects a stale contract — that is the
 * generator's own `--check`, proven falsifiable separately by
 * `scripts/mutation-probe.sh` (verdict=caught, baseline_exit=0, guard_exit=1).
 *
 * The end-to-end case runs against a SYNTHETIC repo root in a temp dir with a fake
 * `gen:contract` script, never the shared tree: it needs to prove that a generator
 * RAN, and doing that in-tree would mean holding a real artifact mutated across a
 * git-sync sweep window.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The REAL helper, so the selection rule under test cannot drift from the one the
// lock hooks actually run.
import {
  selectDerivedArtifacts,
  regenerateForPaths,
  listDeclarationsGraph,
  cachedDeclarationsGraph,
  invalidateDeclarationsGraph,
  describeGeneratorFailure,
  declarationsGraphMembers,
  DECLARATIONS_GRAPH_TTL_MS,
} from '../regenerate-declaration-before-lock-release.mjs';

/** The helper run as git-sync runs it: a separate node process (WI-6554700010011061). */
const HELPER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'regenerate-declaration-before-lock-release.mjs');

/** Walk up for the declarations config — the same marker the helper uses as the repo root. */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'tsconfig.declarations.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found');
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot();

/**
 * An empty declarations program graph. The cases below are about enrollment, not the
 * graph (WI-6554700010010911 has its own block): without this seam each `.ts` path
 * would list the real graph (~4s), and a synthetic temp repo has no TypeScript to
 * list it with.
 */
const NO_GRAPH = { declarationsGraph: () => new Set<string>() };

/** The artifact ids `selectDerivedArtifacts` reports for a given edit. */
function selectedIds(paths: string[]): string[] {
  return selectDerivedArtifacts(REPO_ROOT, paths, NO_GRAPH).map((entry: { id: string }) => entry.id);
}

const CONTRACT_ARTIFACT = 'testing-domains-contract';

// The generator's DATA inputs plus the generator itself. Written out rather than
// imported from the helper on purpose: importing the helper's own constant would
// make this test agree with any future narrowing of it, which is the drift the
// entry exists to prevent.
const CONTRACT_SOURCES = [
  'packages/operator-core/lib/testing-domains-registry.ts',
  'packages/operator-core/lib/harness-testing-registry.ts',
  'scripts/gen-testing-domains-contract.ts',
];

describe('derived-artifact regeneration: selection rule', () => {
  it.each(CONTRACT_SOURCES)('a change to %s strands the testing-domains contract', (source) => {
    expect(selectedIds([source])).toContain(CONTRACT_ARTIFACT);
  });

  it('accepts an absolute path, as the lock hooks pass them', () => {
    expect(selectedIds([join(REPO_ROOT, CONTRACT_SOURCES[0])])).toContain(CONTRACT_ARTIFACT);
  });

  it('does not fire for the type-only module the generator imports', () => {
    // The generator imports testing-domains.ts for the `TestDomain` TYPE only, so it
    // has no bearing on the emitted bytes. A trigger here would run a generator on
    // every unrelated type edit.
    expect(selectedIds(['packages/operator-core/lib/testing-domains.ts'])).not.toContain(
      CONTRACT_ARTIFACT,
    );
  });

  it('does not fire for the emitted contract itself', () => {
    // Regenerating here would silently revert an edit the author is still looking at.
    // A hand-edit is refused upstream by pretooluse-generated-file-edit-guard, and any
    // that slips through is caught by the gen:contract:check invariant guard instead.
    expect(selectedIds(['.papercusp/testing-domains.json'])).not.toContain(CONTRACT_ARTIFACT);
  });

  it('does not fire for an unrelated source edit', () => {
    expect(selectedIds(['packages/operator-core/lib/agent-tools/index.ts'])).toEqual([]);
  });
});

describe('derived-artifact regeneration: the declarations entry still works', () => {
  /** An input enrolled in tsconfig.declarations.json — read, never hardcoded, so it cannot rot. */
  function anEnrolledDeclarationInput(): string {
    const raw = readFileSync(join(REPO_ROOT, 'tsconfig.declarations.json'), 'utf8');
    const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { files?: unknown };
    const files = Array.isArray(parsed.files) ? parsed.files : [];
    const input = files.find(
      (path): path is string => typeof path === 'string' && path.endsWith('.mjs'),
    );
    if (!input) throw new Error('no enrolled .mjs input in tsconfig.declarations.json');
    return input;
  }

  it('an enrolled .mjs still selects the declarations artifact', () => {
    // Generalizing this helper from declarations-only to a table of artifacts must not
    // narrow the case it already covered.
    expect(selectedIds([anEnrolledDeclarationInput()])).toContain('declarations');
  });

  it('one edit touching both sources selects both artifacts', () => {
    const ids = selectedIds([anEnrolledDeclarationInput(), CONTRACT_SOURCES[0]]);
    expect(ids).toContain('declarations');
    expect(ids).toContain(CONTRACT_ARTIFACT);
  });

  it('an unenrolled .mjs selects nothing', () => {
    expect(selectedIds(['scripts/affected-tests.mjs'])).toEqual([]);
  });
});

describe('derived-artifact regeneration: end-to-end wiring', () => {
  /**
   * A synthetic repo root whose `gen:contract` writes a marker instead of doing work,
   * so "the generator ran" is directly observable without touching the shared tree.
   */
  function withSyntheticRepo<T>(body: (root: string, marker: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), 'ei20094-'));
    try {
      for (const dir of ['scripts', '.papercusp', 'packages/operator-core/lib']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      // repo-root markers the helper identifies a root by
      writeFileSync(join(root, 'tsconfig.declarations.json'), JSON.stringify({ files: [] }));
      writeFileSync(join(root, 'scripts/gen-declarations.ts'), '');
      // preconditions the contract entry presence-checks
      writeFileSync(join(root, 'scripts/gen-testing-domains-contract.ts'), '');
      writeFileSync(join(root, '.papercusp/testing-domains.json'), '{}');
      writeFileSync(join(root, 'packages/operator-core/lib/testing-domains-registry.ts'), '');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'ei20094-synthetic',
          private: true,
          scripts: {
            'gen:contract': `node -e "require('fs').writeFileSync('RAN.marker','ok')"`,
          },
        }),
      );
      return body(root, join(root, 'RAN.marker'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('a registry edit actually reaches the generator', () => {
    withSyntheticRepo((root, marker) => {
      expect(existsSync(marker)).toBe(false);
      const selected = regenerateForPaths(
        root,
        ['packages/operator-core/lib/testing-domains-registry.ts'],
        NO_GRAPH,
      );
      expect(selected).toBe(1);
      expect(existsSync(marker)).toBe(true);
    });
  });

  it('an unrelated edit does not invoke the generator', () => {
    // Load-bearing, not an optimization: this helper runs on every successful edit in
    // the repo, so an entry that regenerated unconditionally would put its generator in
    // the hot path of every unrelated file change.
    withSyntheticRepo((root, marker) => {
      expect(regenerateForPaths(root, ['packages/operator-core/lib/unrelated.ts'], NO_GRAPH)).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });
  });
});

/**
 * WI-6554700010010911 — a `.ts` inside tsconfig.declarations.json's program graph (but
 * not itself an enrolled `.mjs`) was never compiled at edit time. Its TS error first
 * surfaced in git-sync's declarations emit (holding commits) or the green gate's
 * gen:declarations:check (redding `main`), and when the hook DID run a generator its
 * failure reached the agent as a bare `Command failed` with no compiler output.
 */
describe('WI-6554700010010911: declarations program-graph edits', () => {
  const IN_GRAPH = 'packages/operator-core/lib/verifier-source.ts';

  /** A graph seam that records whether the (slow) graph lookup was consulted. */
  function graphSeam(files: string[]) {
    const seam = { calls: 0, declarationsGraph: (_root: string) => { seam.calls += 1; return new Set(files); } };
    return seam;
  }

  function declarationsSelection(paths: string[], deps: { declarationsGraph: (root: string) => Set<string> }) {
    return selectDerivedArtifacts(REPO_ROOT, paths, deps).find(
      (entry: { id: string }) => entry.id === 'declarations',
    ) as { id: string; selected: string[] } | undefined;
  }

  it('the real graph reaches a known TS input, every enrolled input, and nothing under node_modules', () => {
    const graph = listDeclarationsGraph(REPO_ROOT);
    expect(graph).toContain(IN_GRAPH);
    const raw = readFileSync(join(REPO_ROOT, 'tsconfig.declarations.json'), 'utf8');
    const enrolled = ((JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { files?: unknown[] }).files ?? []).filter(
      (path): path is string => typeof path === 'string' && path.endsWith('.mjs'),
    );
    expect(enrolled.length).toBeGreaterThan(0);
    for (const input of enrolled) expect(graph).toContain(input);
    expect(graph.filter((path: string) => path.split('/').includes('node_modules'))).toEqual([]);
    expect(graph.filter((path: string) => path.startsWith('../') || path.startsWith('/'))).toEqual([]);
  }, 60_000);

  it('an edited TS file in the graph selects the declarations artifact', () => {
    const seam = graphSeam([IN_GRAPH]);
    expect(declarationsSelection([IN_GRAPH], seam)?.selected).toEqual([IN_GRAPH]);
    expect(seam.calls).toBe(1);
  });

  it('an edited TS file outside the graph selects nothing', () => {
    const seam = graphSeam([IN_GRAPH]);
    expect(declarationsSelection(['packages/operator-core/lib/agent-tools/index.ts'], seam)).toBeUndefined();
  });

  it('a non-source edit never pays for a graph lookup', () => {
    const seam = graphSeam([IN_GRAPH, 'docs/notes.md']);
    expect(declarationsSelection(['docs/notes.md'], seam)).toBeUndefined();
    expect(seam.calls).toBe(0);
  });

  /**
   * A synthetic repo whose `gen:declarations` records its argv (and fails with a tsc
   * diagnostic when a FAIL file exists), so the exact invocation is observable without
   * touching the shared tree.
   */
  function withDeclarationsRepo<T>(body: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), 'wi10911-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'lib'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.declarations.json'), JSON.stringify({ files: ['scripts/enrolled.mjs'] }));
      writeFileSync(join(root, 'scripts/gen-declarations.ts'), '');
      writeFileSync(join(root, 'scripts/enrolled.mjs'), '');
      writeFileSync(join(root, 'lib/in-graph.ts'), '');
      writeFileSync(
        join(root, 'scripts/fake-gen.mjs'),
        [
          "import { existsSync, writeFileSync } from 'node:fs';",
          "writeFileSync('ARGV.json', JSON.stringify(process.argv.slice(2)));",
          "if (existsSync('FAIL')) {",
          "  console.log(\"lib/in-graph.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\");",
          // A real failed emit buries the diagnostic under a long tsx stack trace; the
          // tail alone would push it out of the callers' 200-char window.
          "  console.error('Error: tsc failed\\n' + '    at runTsc (scripts/gen-declarations.ts:121:11)\\n'.repeat(40));",
          '  process.exit(1);',
          '}',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'wi10911-synthetic', private: true, scripts: { 'gen:declarations': 'node scripts/fake-gen.mjs' } }),
      );
      return body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const argvOf = (root: string): string[] => JSON.parse(readFileSync(join(root, 'ARGV.json'), 'utf8'));
  const syntheticGraph = { declarationsGraph: () => new Set(['scripts/enrolled.mjs', 'lib/in-graph.ts']) };

  it('an in-graph TS edit runs the FULL generator (a type change can alter any declaration)', () => {
    withDeclarationsRepo((root) => {
      expect(regenerateForPaths(root, ['lib/in-graph.ts'], syntheticGraph)).toBe(1);
      expect(argvOf(root)).toEqual([]);
    });
  });

  it('an enrolled-only edit still publishes just its own declarations', () => {
    withDeclarationsRepo((root) => {
      expect(regenerateForPaths(root, ['scripts/enrolled.mjs'], syntheticGraph)).toBe(1);
      expect(argvOf(root)).toEqual(['--files=scripts/enrolled.mjs']);
    });
  });

  it('a regeneration drops the cached graph so a changed import set is re-read', () => {
    withDeclarationsRepo((root) => {
      const cache = join(root, '.papercusp/scratch/derived-artifacts/declarations-graph.json');
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, '{}');
      regenerateForPaths(root, ['lib/in-graph.ts'], syntheticGraph);
      expect(existsSync(cache)).toBe(false);
    });
  });

  it("a failed emit surfaces tsc's diagnostic FIRST, inside the callers' 200-char window", () => {
    withDeclarationsRepo((root) => {
      writeFileSync(join(root, 'FAIL'), '');
      let message = '';
      try {
        regenerateForPaths(root, ['lib/in-graph.ts'], syntheticGraph);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message.slice(0, 200)).toContain('lib/in-graph.ts(3,7): error TS2322');
      expect(message.startsWith('declarations: lib/in-graph.ts(3,7): error TS2322')).toBe(true);
      expect(message).toContain('exit 1');
      expect(message).not.toMatch(/^declarations: Command failed/);
    });
  });

  it('a failure with no tsc diagnostic still carries the output tail and the exit status', () => {
    const message = describeGeneratorFailure('gen:declarations', {
      status: 2,
      stdout: '',
      stderr: 'Error: cannot generate undeclared input: lib/x.mjs\n',
    });
    expect(message).toBe('gen:declarations exit 2: Error: cannot generate undeclared input: lib/x.mjs');
  });

  it('the graph cache is reused inside its TTL and recomputed on expiry, config change, or invalidation', () => {
    withDeclarationsRepo((root) => {
      let computes = 0;
      let clock = 1_000_000;
      const opts = {
        now: () => clock,
        compute: () => {
          computes += 1;
          return ['lib/in-graph.ts'];
        },
      };
      expect(cachedDeclarationsGraph(root, opts).has('lib/in-graph.ts')).toBe(true);
      expect(computes).toBe(1);
      clock += DECLARATIONS_GRAPH_TTL_MS - 1;
      cachedDeclarationsGraph(root, opts);
      expect(computes).toBe(1);
      clock += 2;
      cachedDeclarationsGraph(root, opts);
      expect(computes).toBe(2);
      writeFileSync(
        join(root, 'tsconfig.declarations.json'),
        JSON.stringify({ files: ['scripts/enrolled.mjs', 'scripts/other.mjs'] }),
      );
      cachedDeclarationsGraph(root, opts);
      expect(computes).toBe(3);
      invalidateDeclarationsGraph(root);
      cachedDeclarationsGraph(root, opts);
      expect(computes).toBe(4);
    });
  });

  // WI-6554700010011061 — git-sync asks the helper which dirty paths are graph sources,
  // so the commit-time trigger and the edit hook share one rule and one cache.
  it('declarationsGraphMembers keeps only graph sources, and never looks up a non-source list', () => {
    const seam = graphSeam([IN_GRAPH, 'scripts/lib/imported.mjs']);
    expect(
      declarationsGraphMembers(REPO_ROOT, [IN_GRAPH, IN_GRAPH, 'packages/x/out-of-graph.ts', 'scripts/lib/imported.mjs', 'README.md'], seam),
    ).toEqual([IN_GRAPH, 'scripts/lib/imported.mjs']);
    expect(seam.calls).toBe(1);
    const untouched = graphSeam([IN_GRAPH]);
    expect(declarationsGraphMembers(REPO_ROOT, ['README.md', 'node_modules/x/index.ts', '../elsewhere.ts'], untouched)).toEqual([]);
    expect(untouched.calls).toBe(0);
  });

  it('the --declarations-graph-members CLI prints the members from the shared cache and generates nothing', () => {
    withDeclarationsRepo((root) => {
      const config = statSync(join(root, 'tsconfig.declarations.json'));
      const cache = join(root, '.papercusp', 'scratch', 'derived-artifacts', 'declarations-graph.json');
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(
        cache,
        JSON.stringify({ stamp: `${config.size}:${config.mtimeMs}`, computedAt: Date.now(), files: ['lib/in-graph.ts'] }),
      );
      const run = spawnSync(
        process.execPath,
        [HELPER, '--declarations-graph-members', '--repo-root', root, '--path', 'lib/in-graph.ts', '--path', 'lib/other.ts', '--path', 'README.md'],
        { encoding: 'utf8' },
      );
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(['lib/in-graph.ts']);
      expect(existsSync(join(root, 'ARGV.json'))).toBe(false);

      const missingRoot = spawnSync(process.execPath, [HELPER, '--declarations-graph-members', '--path', 'lib/in-graph.ts'], {
        encoding: 'utf8',
      });
      expect(missingRoot.status).toBe(2);
      expect(missingRoot.stderr).toContain('--declarations-graph-members requires --repo-root');
    });
  });
});

describe('derived-artifact regeneration: the affected-tests invariant guard', () => {
  /** Guard tasks the real CLI attaches for a given changed-path set. */
  function attachedGuards(changedPaths: string[]): string[] {
    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/affected-tests.mjs'),
        '--changed-paths',
        changedPaths.join(','),
        '--print-affected',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    return `${result.stdout ?? ''}`
      .split('\n')
      .filter((line) => line.startsWith('AFFECTED_GUARD\t'));
  }

  const guardLine = (lines: string[]) => lines.some((l) => l.includes('gen:contract:check'));

  it('operator-core declares the gen:contract:check script', () => {
    // Same silent-no-op failure shape as WI-6077's missing `test` script: the registry
    // entry looks wired, and `if (!ws?.scripts?.[guard.script]) continue;` skips it.
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/operator-core/package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['gen:contract:check']).toBeTruthy();
  });

  it.each([...CONTRACT_SOURCES, '.papercusp/testing-domains.json'])(
    'attaches the contract guard for %s',
    (source) => {
      expect(guardLine(attachedGuards([source]))).toBe(true);
    },
  );

  it('does not attach the contract guard for an unrelated edit', () => {
    expect(guardLine(attachedGuards(['packages/operator-core/lib/agent-tools/index.ts']))).toBe(
      false,
    );
  });

  it('attaches unconditionally rather than deferring to the operator-core suite', () => {
    // No hostSuiteRatchet, deliberately. The ratchet exists — the freshness test — but it
    // lives in the very workspace that editing the registry ALWAYS makes affected, so
    // declaring one would skip this guard in exactly its primary case and reinstate the
    // minutes-deep signal it was added to replace.
    const source = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
    const registry = readFileSync(source, 'utf8');
    const entry = registry.slice(registry.indexOf('script: "gen:contract:check"'));
    const entryBody = entry.slice(0, entry.indexOf('\n  },'));
    expect(entryBody).not.toContain('hostSuiteRatchet');
  });
});
