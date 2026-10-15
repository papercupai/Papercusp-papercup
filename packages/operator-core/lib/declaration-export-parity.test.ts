/**
 * EI-20805816236289594 — hand-written `.d.mts` declarations are policed against the
 * `.mjs` they describe.
 *
 * `gen:declarations:check` byte-compares the declarations it GENERATES. A `.d.mts`
 * whose `.mjs` was never registered in `tsconfig.declarations.json` is invisible to
 * it — never generated, never compared, never reported. The check printed "51
 * declaration file(s) up to date" (the 51 registered) while 18 hand-written
 * declarations sat beside them unpoliced, one already missing `commandFor`, an
 * export its source had grown.
 *
 * The tests below are deliberately split into two kinds, because the live-tree
 * assertion alone is worth very little:
 *
 *  - CONTROLS drive the pure comparison with synthetic inputs where the answer is
 *    known, including a deliberately-drifted pair. They are what prove the guard
 *    CAN fail. A guard that has never failed is a guard nobody has tested.
 *  - CALIBRATION pins the two ways this guard could quietly stop working: by
 *    scanning nothing (an empty population makes "no problems" vacuously true), and
 *    by being widened to compare TYPE exports, which would make it fire on nearly
 *    every hand-written declaration and get it switched off.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  valueExports,
  comparePair,
  allDeclarations,
  exportParityProblems,
  formatProblems,
} from '../../../scripts/lib/declaration-export-parity.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function registeredDeclarations(): Set<string> {
  const raw = readFileSync(join(REPO_ROOT, 'tsconfig.declarations.json'), 'utf8');
  const files = (JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { files: string[] }).files;
  return new Set(files.map((f) => f.replace(/\.mjs$/, '.d.mts')));
}

describe('declaration export parity — controls', () => {
  it('polices the manual fleet sandbox declaration and catches its historical root-read export omission', () => {
    const declarationPath = 'libs/papercusp/packages/orchestrator/src/fleet-srt-spawn.d.mts';
    const sourcePath = declarationPath.replace(/\.d\.mts$/, '.mjs');
    const declaration = readFileSync(join(REPO_ROOT, declarationPath), 'utf8');
    const source = readFileSync(join(REPO_ROOT, sourcePath), 'utf8');

    expect(allDeclarations(REPO_ROOT)).toContain(declarationPath);
    expect(registeredDeclarations().has(declarationPath)).toBe(false);
    expect(comparePair(declaration, source)).toEqual({ stranded: [], phantom: [] });

    // Recreate the missing value export without changing the shared source.
    const before = [...valueExports(declaration, declarationPath)]
      .filter((name) => name !== 'rootReadDenyPaths')
      .map((name) => `export declare const ${name}: unknown;`)
      .join('\n');
    expect(comparePair(before, source)).toEqual({
      stranded: ['rootReadDenyPaths'],
      phantom: [],
    });
  });

  it('polices the manual AMI scan budget declaration and catches its historical four-export omission', () => {
    const declarationPath = 'packages/operator-core/bin/aws-ami-scan-measure.d.mts';
    const sourcePath = 'packages/operator-core/bin/aws-ami-scan-measure.mjs';
    const declaration = readFileSync(join(REPO_ROOT, declarationPath), 'utf8');
    const source = readFileSync(join(REPO_ROOT, sourcePath), 'utf8');
    const missing = new Set([
      'AWS_AMI_SCAN_BUDGETS',
      'AWS_AMI_SCAN_WORK_TIMEOUT_MS',
      'AWS_AMI_SCAN_RUNNER_TIMEOUT_MS',
      'boundAwsAmiScanCommandTimeoutMs',
    ]);

    expect(allDeclarations(REPO_ROOT)).toContain(declarationPath);
    expect(registeredDeclarations().has(declarationPath)).toBe(false);
    expect(comparePair(declaration, source)).toEqual({ stranded: [], phantom: [] });

    // Project the real declaration's value exports without the four additions.
    // The baseline checks the actual manual declaration; the negative control
    // asks whether the export detector catches drift in its value exports.
    const before = [...valueExports(declaration, declarationPath)]
      .filter((name) => !missing.has(name))
      .map((name) => `export declare const ${name}: unknown;`)
      .join('\n');
    const drift = comparePair(before, source);
    expect(new Set(drift.stranded)).toEqual(missing);
    expect(drift.phantom).toEqual([]);
  });

  it('DETECTS an export the source grew and the declaration never got (the filed defect)', () => {
    // This is the shape of the real defect: `commandFor` was added to
    // typecheck-fanout.mjs and never mirrored into its hand-written declaration,
    // making it TS2305/TS2724 for every TypeScript importer.
    const declaration = `export function discover(dir: any): any;\n`;
    const source = `export function discover(dir) {}\nexport const commandFor = (pkg) => pkg.command ?? [];\n`;

    const { stranded, phantom } = comparePair(declaration, source);
    expect(stranded, 'a source export missing from the declaration must be reported').toEqual([
      'commandFor',
    ]);
    expect(phantom).toEqual([]);
  });

  it('DETECTS a declared export the source does not actually have (undefined at runtime)', () => {
    const declaration = `export function gone(): void;\n`;
    const source = `export function stillHere() {}\n`;

    const { stranded, phantom } = comparePair(declaration, source);
    expect(phantom, 'a declaration-only value export must be reported').toEqual(['gone']);
    expect(stranded).toEqual(['stillHere']);
  });

  it('reports NOTHING for a declaration that genuinely matches its source', () => {
    const declaration = `export function a(x: number): string;\nexport const B: number;\n`;
    const source = `export function a(x) { return String(x); }\nexport const B = 1;\n`;

    expect(comparePair(declaration, source)).toEqual({ stranded: [], phantom: [] });
  });

  it('follows the EXPORTED name through `export { x as y }`, not the local one', () => {
    // A rename is where a naive scan reports a false stranded/phantom PAIR: it would
    // see `internalName` in the source and `publicName` in the declaration and call
    // both a defect, when the importer only ever writes `publicName`.
    const declaration = `export declare const publicName: () => void;\n`;
    const source = `const internalName = () => {};\nexport { internalName as publicName };\n`;

    expect(comparePair(declaration, source)).toEqual({ stranded: [], phantom: [] });
  });
});

describe('declaration export parity — calibration', () => {
  it('IGNORES type-only exports, or it would fire on nearly every hand-written declaration', () => {
    // The whole reason these files stay hand-written is that they name types the
    // `.mjs` cannot: interfaces, generics, literal unions. Comparing ALL exports
    // instead of VALUE exports reports 31 differences across the 18 hand-written
    // declarations, 30 of which are this false positive. A guard that noisy gets
    // switched off, so this is pinned rather than left to judgment.
    const declaration = `
      export interface TaskBudgetInput { workerBudget: number }
      export type Mode = 'parallel' | 'serial';
      export type { Mode as PublicMode };
      export const REAL: number;
    `;
    const source = `export const REAL = 1;\n`;

    expect(comparePair(declaration, source)).toEqual({ stranded: [], phantom: [] });
  });

  it('distinguishes an exported value from a merely local one', () => {
    const source = `const notExported = 1;\nexport const exported = 2;\n`;
    expect([...valueExports(source, 'source.mjs')]).toEqual(['exported']);
  });

  it('actually SCANS the unregistered declarations — an empty population would pass vacuously', () => {
    // Without this, the live-tree assertion below is satisfied just as well by a walk
    // that silently returns nothing (a bad exclude, a renamed directory, a thrown-away
    // error). The clean verdict is only meaningful if the instrument is looking.
    const registered = registeredDeclarations();
    const found = allDeclarations(REPO_ROOT);
    const unregistered = found.filter((d) => !registered.has(d));

    expect(found.length, 'the declaration walk found NO .d.mts files at all').toBeGreaterThan(50);
    expect(
      unregistered.length,
      'no UNREGISTERED declarations found — the guard would have nothing to police',
    ).toBeGreaterThan(0);
    // The declaration the filed defect lived in must be in the policed population.
    expect(unregistered).toContain('scripts/lib/typecheck-fanout.d.mts');
  });

  it('excludes frozen worktrees and generated runtime mirrors without hiding canonical drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'declaration-parity-scope-'));
    try {
      const canonical = join(root, 'scripts');
      mkdirSync(canonical, { recursive: true });
      writeFileSync(join(canonical, 'canonical.d.mts'), 'export const present: number;\n');
      writeFileSync(
        join(canonical, 'canonical.mjs'),
        'export const present = 1;\nexport const newlyAdded = 2;\n',
      );

      const frozen = join(
        root,
        '.papercusp',
        'worktrees',
        'green-candidate-papercusp-old',
        'scripts',
      );
      mkdirSync(frozen, { recursive: true });
      writeFileSync(join(frozen, 'stale.d.mts'), 'export const old: number;\n');
      writeFileSync(
        join(frozen, 'stale.mjs'),
        'export const old = 1;\nexport const candidateOnly = 2;\n',
      );

      const runtime = join(root, '.papercusp', 'tmp', 'verify-tauri-headless-stale', 'scripts');
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, 'stale.d.mts'), 'export const old: number;\n');
      writeFileSync(
        join(runtime, 'stale.mjs'),
        'export const old = 1;\nexport const runtimeOnly = 2;\n',
      );

      const runtimeSibling = join(root, '.papercusp', 'tmp-old-candidate', 'scripts');
      mkdirSync(runtimeSibling, { recursive: true });
      writeFileSync(join(runtimeSibling, 'stale.d.mts'), 'export const old: number;\n');
      writeFileSync(
        join(runtimeSibling, 'stale.mjs'),
        'export const old = 1;\nexport const runtimeSiblingOnly = 2;\n',
      );

      expect(allDeclarations(root)).toEqual(['scripts/canonical.d.mts']);
      expect(exportParityProblems(root, new Set())).toEqual([
        {
          declaration: 'scripts/canonical.d.mts',
          source: 'scripts/canonical.mjs',
          stranded: ['newlyAdded'],
          phantom: [],
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prunes what git reports as untracked+ignored — scratch, any ignored dir, a nested repo’s own ignores — without hiding tracked or merely-untracked drift (EI-24553552437295746)', () => {
    // The filed defect: a peer's gitignored `.papercusp/scratch/source-preview` copy
    // false-redded every local run of this suite and of `gen:declarations:check`.
    // Each entry below would be reported by a walker that ignores `.gitignore`; the
    // three that must SURVIVE pin the guard's purpose (untracked-but-present drift,
    // a force-tracked file under an ignore pattern, a nested repo's real source).
    const root = mkdtempSync(join(tmpdir(), 'declaration-parity-gitignore-'));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 30_000 });
    const pair = (dir: string, name: string, extra: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.d.mts`), 'export const present: number;\n');
      writeFileSync(
        join(dir, `${name}.mjs`),
        `export const present = 1;\nexport const ${extra} = 2;\n`,
      );
    };
    try {
      git(root, 'init', '-q');
      writeFileSync(join(root, '.gitignore'), '**/.papercusp/scratch/\ngenerated-out/\nlegacy/\n');
      pair(join(root, 'scripts'), 'canonical', 'newlyAdded');
      pair(
        join(root, '.papercusp', 'scratch', 'source-preview', 'readme-check-1', 'scripts'),
        'stale',
        'scratchOnly',
      );
      pair(join(root, 'generated-out'), 'mirror', 'generatedOnly');
      pair(join(root, 'legacy'), 'kept', 'legacyAdded');
      git(root, 'add', '-f', 'legacy/kept.d.mts', 'legacy/kept.mjs');
      const nested = join(root, 'libs', 'nested');
      mkdirSync(nested, { recursive: true });
      git(nested, 'init', '-q');
      writeFileSync(join(nested, '.gitignore'), 'scratch/\n');
      pair(join(nested, 'scratch'), 'stale', 'nestedScratchOnly');
      pair(join(nested, 'src'), 'real', 'nestedAdded');

      expect(allDeclarations(root).sort()).toEqual([
        'legacy/kept.d.mts',
        'libs/nested/src/real.d.mts',
        'scripts/canonical.d.mts',
      ]);
      expect(
        exportParityProblems(root, new Set()).map((p) => [p.declaration, p.stranded]),
      ).toEqual([
        ['legacy/kept.d.mts', ['legacyAdded']],
        ['libs/nested/src/real.d.mts', ['nestedAdded']],
        ['scripts/canonical.d.mts', ['newlyAdded']],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('declaration export parity — the live tree', () => {
  it('has every hand-written declaration in sync with its source', () => {
    const problems = exportParityProblems(REPO_ROOT, registeredDeclarations());
    expect(
      formatProblems(problems).join('\n'),
      'a hand-written .d.mts has drifted from its .mjs — edit the .d.mts to match ' +
        '(do NOT register it in tsconfig.declarations.json; generation emits a weaker type)',
    ).toBe('');
  });

  it('still declares `commandFor` — the export this item was filed for (regression pin)', () => {
    const declaration = readFileSync(
      join(REPO_ROOT, 'scripts/lib/typecheck-fanout.d.mts'),
      'utf8',
    );
    const source = readFileSync(join(REPO_ROOT, 'scripts/lib/typecheck-fanout.mjs'), 'utf8');

    expect(valueExports(source, 'source.mjs'), 'the source stopped exporting commandFor').toContain(
      'commandFor',
    );
    expect(
      valueExports(declaration, 'declaration.d.mts'),
      'commandFor was dropped from the declaration again — TS2305 for every importer',
    ).toContain('commandFor');
  });
});
