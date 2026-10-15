import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  couplingClosure,
  importSpecifiers,
  replayQueue,
  resolveSpecifier,
  suspectsOf,
  type DeltaChange,
  type RedFileObservation,
  type ReplayQueueInput,
} from './exclude-the-breaker-replay';

const H = 3_600_000;
const MODEL = { exclusionBuildMin: 10, fullRoundMin: 85 };

function delta(entries: Array<[string, string, number?]>): Map<string, DeltaChange> {
  return new Map(entries.map(([path, kind, hunks]) => [path, { path, kind, hunks: hunks ?? 1 }]));
}

function red(file: string, executed: string[] | null, fix: { fixed?: boolean; fixPaths?: string[] } = {}): RedFileObservation {
  return { file, executed, fixed: fix.fixed ?? false, fixPaths: fix.fixPaths ?? [] };
}

function queue(over: Partial<ReplayQueueInput> = {}): ReplayQueueInput {
  return {
    queue: 'q1',
    cutAtMs: 0,
    windowStartMs: -24 * H,
    firstRedKnownAtMs: 4 * H,
    firstRoundRed: ['a.test.ts'],
    delta: delta([['a.test.ts', 'M'], ['lib/a.ts', 'M', 3], ['lib/unrelated.ts', 'M']]),
    redFiles: [red('a.test.ts', ['lib/a.ts', 'lib/stable.ts'], { fixed: true, fixPaths: ['lib/a.ts'] })],
    edits: [
      { path: 'lib/a.ts', agent: 'su-1', tsMs: -2 * H, workItem: 'WI-1' },
      { path: 'lib/a.ts', agent: 'su-2', tsMs: -30 * H, workItem: 'WI-2' }, // before the window: not counted
    ],
    resolvedImports: new Map(),
    actual: { outcome: 'green', greenAtMs: 24 * H },
    ...over,
  };
}

describe('suspectsOf', () => {
  it('is reach ∩ delta, where reach is the test file plus its executed modules', () => {
    const d = delta([['a.test.ts', 'M'], ['lib/a.ts', 'M'], ['lib/b.ts', 'A']]);
    expect(suspectsOf(red('a.test.ts', ['lib/a.ts', 'lib/stable.ts']), d).sort()).toEqual(['a.test.ts', 'lib/a.ts']);
    // an unmapped red can still be attributed through its own changed test file
    expect(suspectsOf(red('a.test.ts', null), d)).toEqual(['a.test.ts']);
    expect(suspectsOf(red('z.test.ts', null), d)).toEqual([]);
  });
});

describe('replayQueue projection', () => {
  it('projects first red verdict + exclusion build + one full round, and states hours saved', () => {
    const r = replayQueue(queue(), MODEL);
    // 4h to the first red verdict, then 10 + 85 minutes
    expect(r.projection.projectedTtgHours).toBe(5.6);
    expect(r.actual).toEqual({ outcome: 'green', ttgHours: 24 });
    expect(r.projection.hoursSavedVsActual).toBe(18.4);
    expect(r.projection.preconditionsMet).toBe(true);
    expect(r.firstRound.exclusion.excludedPaths).toBe(2);
    expect(r.firstRound.exclusion.excludedHunks).toBe(4);
    expect(r.firstRound.exclusion.agents).toBe(1);
    expect(r.firstRound.exclusion.workItems).toBe(1);
    expect(r.firstRound.exclusion.pathsWithNoLedgerEdit).toBe(1); // a.test.ts has no ledgered edit
  });

  it('measures a never-green queue against how long it held main', () => {
    const r = replayQueue(queue({ actual: { outcome: 'never-green', retiredAtMs: 76 * H } }), MODEL);
    expect(r.actual).toEqual({ outcome: 'never-green', heldHours: 76 });
    expect(r.projection.hoursSavedVsActual).toBe(70.4);
  });

  it('fails the precondition and names the red when a first-round red is unattributable', () => {
    const r = replayQueue(
      queue({
        firstRoundRed: ['a.test.ts', 'guard.test.ts'],
        redFiles: [red('a.test.ts', ['lib/a.ts']), red('guard.test.ts', null)],
      }),
      MODEL,
    );
    expect(r.projection.preconditions.allFirstRoundAttributable).toBe(false);
    expect(r.projection.preconditionsMet).toBe(false);
    expect(r.firstRound.unattributable).toEqual([{ file: 'guard.test.ts', mapped: false }]);
  });

  it('fails the precondition when a kept change imports an excluded added file', () => {
    const r = replayQueue(
      queue({
        delta: delta([['a.test.ts', 'M'], ['lib/new.ts', 'A'], ['lib/kept.ts', 'M']]),
        redFiles: [red('a.test.ts', ['lib/new.ts'])],
        resolvedImports: new Map([['lib/kept.ts', ['lib/new.ts']]]),
      }),
      MODEL,
    );
    expect(r.projection.preconditions.noCouplingWidening).toBe(false);
    expect(r.projection.preconditionsMet).toBe(false);
    expect(r.firstRound.exclusion.keptImportersOfExcludedAdded).toBe(1);
    expect(r.firstRound.exclusion.coupledSample).toEqual(['lib/kept.ts']);
    expect(r.firstRound.exclusion.closure).toMatchObject({ excludedPaths: 3, addedByClosure: 1, rounds: 1 });
  });

  it('does not count an import of an excluded MODIFIED file as coupling (symbol coupling is out of scope)', () => {
    const r = replayQueue(
      queue({
        resolvedImports: new Map([['lib/unrelated.ts', ['lib/a.ts']]]),
      }),
      MODEL,
    );
    expect(r.firstRound.exclusion.keptImportersOfExcludedAdded).toBe(0);
    expect(r.projection.preconditionsMet).toBe(true);
  });

  it('buckets each fix-forward by whether it touched a suspect, only the reach, or neither', () => {
    const r = replayQueue(
      queue({
        firstRoundRed: ['a.test.ts', 'b.test.ts', 'c.test.ts'],
        delta: delta([['lib/a.ts', 'M'], ['lib/b.ts', 'M'], ['lib/c.ts', 'M']]),
        redFiles: [
          red('a.test.ts', ['lib/a.ts'], { fixed: true, fixPaths: ['lib/a.ts'] }),
          red('b.test.ts', ['lib/b.ts', 'lib/stable.ts'], { fixed: true, fixPaths: ['lib/stable.ts'] }),
          red('c.test.ts', ['lib/c.ts'], { fixed: true, fixPaths: ['baseline.json'] }),
        ],
      }),
      MODEL,
    );
    expect(r.validation).toMatchObject({
      fixedWithAdmittedFix: 3,
      fixTouchedASuspect: 1,
      fixTouchedReachButNotSuspect: 1,
      fixOutsideReach: 1,
    });
    expect(r.validation.fixOutsideReachSample).toEqual([{ file: 'c.test.ts', mapped: true, fix: ['baseline.json'] }]);
  });
});

describe('couplingClosure', () => {
  it('widens transitively through kept files that are themselves new', () => {
    const d = delta([['x.ts', 'A'], ['y.ts', 'A'], ['z.ts', 'M'], ['w.ts', 'M']]);
    const imports = new Map<string, string[]>([
      ['y.ts', ['x.ts']], // y imports excluded new x → excluded
      ['z.ts', ['y.ts']], // z imports y, which is new and now excluded → excluded
      ['w.ts', ['z.ts']], // z is MODIFIED, so w stays
    ]);
    const c = couplingClosure(new Set(['x.ts']), d, imports);
    expect([...c.excluded].sort()).toEqual(['x.ts', 'y.ts', 'z.ts']);
    expect(c.rounds).toBe(2);
  });
});

describe('import resolution', () => {
  const files = new Set([
    'packages/core/lib/a.ts',
    'packages/core/lib/b/index.ts',
    'packages/core/lib/c.tsx',
    'libs/flags/src/types.ts',
  ]);
  const exists = (p: string) => files.has(p);
  const ws = new Map([['@papercusp/flags', 'libs/flags'], ['@papercusp/flags-extra', 'libs/flags-extra']]);

  it('finds static, dynamic, require, side-effect and vi.mock specifiers', () => {
    const src = [
      "import { a } from './a';",
      "export * from './b';",
      "const c = await import('./c.js');",
      "const d = require('node:fs');",
      "import './side-effect';",
      "vi.mock('../mocked', () => ({}));",
    ].join('\n');
    expect(importSpecifiers(src).sort()).toEqual(['../mocked', './a', './b', './c.js', './side-effect', 'node:fs']);
  });

  it('resolves relative, ESM .js-for-.ts, directory index and workspace-package specifiers', () => {
    const from = 'packages/core/lib/x.ts';
    expect(resolveSpecifier(from, './a', exists, ws)).toBe('packages/core/lib/a.ts');
    expect(resolveSpecifier(from, './a.js', exists, ws)).toBe('packages/core/lib/a.ts');
    expect(resolveSpecifier(from, './b', exists, ws)).toBe('packages/core/lib/b/index.ts');
    expect(resolveSpecifier(from, './c.js', exists, ws)).toBe('packages/core/lib/c.tsx');
    expect(resolveSpecifier(from, '@papercusp/flags/src/types', exists, ws)).toBe('libs/flags/src/types.ts');
  });

  it('returns null for builtins, npm dependencies and paths that do not exist', () => {
    const from = 'packages/core/lib/x.ts';
    expect(resolveSpecifier(from, 'node:fs', exists, ws)).toBeNull();
    expect(resolveSpecifier(from, 'vitest', exists, ws)).toBeNull();
    expect(resolveSpecifier(from, './missing', exists, ws)).toBeNull();
  });
});

describe('the spike does not change gate behaviour', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const gateDirs = ['packages/operator-core/lib/release', 'packages/operator-core/lib/agent-tools/release', 'apps/operator/lib/release'];

  it('no gate module imports the replay', () => {
    const importers: string[] = [];
    let scanned = 0;
    for (const dir of gateDirs) {
      const abs = join(root, dir);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        if (!/\.(m?[jt]sx?)$/.test(name) || /\.test\.|\.spec\./.test(name) || name.startsWith('exclude-the-breaker-replay')) continue;
        scanned += 1;
        if (readFileSync(join(abs, name), 'utf8').includes('exclude-the-breaker-replay')) importers.push(`${dir}/${name}`);
      }
    }
    // positive control: the scan really read the gate's own modules
    expect(scanned).toBeGreaterThan(20);
    expect(existsSync(join(root, 'apps/operator/lib/release/green-checkpoint.ts'))).toBe(true);
    expect(importers).toEqual([]);
  });
});
