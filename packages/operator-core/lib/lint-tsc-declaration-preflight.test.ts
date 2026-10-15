/**
 * WI-2141049 — every lint:tsc leg that COMPILES a consumer of a generated `.d.mts` must
 * refresh those companions first.
 *
 * `tsconfig.declarations.json` generates a tracked `.d.mts` beside each listed `.mjs`, and that
 * companion is the ONLY type information a `.ts` importer ever sees for those modules. So the
 * first typecheck after any `.mjs` export change judges the STALE committed declaration and
 * attributes the resulting phantoms to whoever happened to run it — measured 2026-09-02 on the
 * `operator` leg as 14 phantom errors (11x TS2554 "Expected 2 arguments, but got 1", 3x TS2353
 * "'agent' does not exist in type '{ capBytes?: number }'") reported as `status=regressed`
 * against a signature change that was already correct.
 *
 * `lint-tsc.mjs` has carried the `gen:declarations` preflight since EI-21441555291852229, but
 * only that one leg did — and operator-core owns just 3 of the 70 generated inputs. The other 67
 * belong to legs that had no preflight, so the fix landed everywhere EXCEPT where these modules
 * actually live. This test derives the requirement from `tsconfig.declarations.json` and each
 * leg's own tsc project rather than restating a hand-kept roster, so a leg added (or a module
 * moved) later cannot reintroduce the gap silently — the derived-truth ladder's PIN rung.
 *
 * NOTE the preflight is NOT about `tsconfig.tsbuildinfo`. That was this bug's first and wrong
 * diagnosis: every leg already passes `--incremental false`, tsc 7.0.2 honours it, and a warm
 * cache was measured to produce a byte-identical diagnostic set (612 errors, identical
 * file:line:code). The variable that actually moved between the red run and the green one was
 * the regenerated `.d.mts`.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');

/** Strip `//` line comments so the JSONC configs in this repo parse with JSON.parse. */
function readJsonc(relPath: string): { files?: string[] } {
  const raw = readFileSync(resolve(REPO_ROOT, relPath), 'utf-8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(raw);
}

/** Every `.mjs` whose type surface is a generated, committed `.d.mts`. */
function generatedDeclarationInputs(): string[] {
  const files = readJsonc('tsconfig.declarations.json').files ?? [];
  return files.map((f) => f.replace(/^\.\//, ''));
}

/**
 * The lint:tsc legs, by the script that owns each one. Discovered from the root package.json so
 * a NEW leg is covered the moment it is wired, rather than when someone remembers this list.
 */
function discoverLegs(): { script: string; source: string }[] {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const legs: { script: string; source: string }[] = [];
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!name.startsWith('lint:tsc')) continue;
    const m = /(scripts\/lint-tsc[\w-]*\.mjs)/.exec(cmd);
    if (!m) continue;
    legs.push({ script: name, source: readFileSync(resolve(REPO_ROOT, m[1]), 'utf-8') });
  }
  return legs;
}

/**
 * The directory a leg's `tsc -p <project>` compiles, e.g. `apps/operator`.
 *
 * Read ONLY out of the exported `TSC_COMMAND` assignment, never from the file at large: these
 * scripts quote example `tsc --noEmit -p tsconfig.json` invocations in their usage prose, and a
 * looser scan matches that instead — resolving a leg to the repo root, where nothing is owned,
 * so it silently drops out of the census with no assertion firing.
 *
 * `null` means the leg is a FAN-OUT (`lint:tsc:papercusp-libs`, `lint:tsc:workspaces`) that
 * discovers many per-package projects at runtime instead of naming one. Those are out of scope
 * here — they compile packages that own no generated-declaration inputs.
 */
function projectDirOf(source: string): string | null {
  const decl = /export const TSC_COMMAND\s*=\s*([\s\S]{0,200}?);/.exec(source);
  if (!decl) return null;
  const m = /-p\s+([\w./-]+tsconfig[\w.-]*\.json)/.exec(decl[1]);
  return m ? dirname(m[1]) : null;
}

describe('lint:tsc legs refresh generated .d.mts companions before typechecking', () => {
  const inputs = generatedDeclarationInputs();
  const legs = discoverLegs();

  it('the census is non-vacuous', () => {
    // Guard against the failure mode this whole file exists to prevent: an instrument that
    // measured nothing reporting a clean pass. If either census empties out, the assertions
    // below become vacuously true and the gap reopens unobserved.
    expect(inputs.length).toBeGreaterThan(20);
    expect(legs.length).toBeGreaterThan(4);

    // Single-project legs are the ones this rule can speak about at all. If the TSC_COMMAND
    // shape ever changes, this count collapses and the census below goes quiet — which would
    // read as "no leg is missing a preflight" rather than "no leg was examined".
    const single = legs.filter((l) => projectDirOf(l.source) !== null);
    expect(single.length).toBeGreaterThanOrEqual(4);

    // Every leg is either single-project or a known fan-out; nothing falls between.
    const unresolved = legs
      .filter((l) => projectDirOf(l.source) === null)
      .map((l) => l.script)
      .sort();
    expect(unresolved).toEqual(['lint:tsc:papercusp-libs', 'lint:tsc:workspaces']);
  });

  it('every leg whose project contains generated-declaration inputs runs the preflight', () => {
    const missing: string[] = [];
    const covered: string[] = [];

    for (const leg of legs) {
      const projectDir = projectDirOf(leg.source);
      if (!projectDir) continue;
      const owned = inputs.filter((f) => f.startsWith(`${projectDir}/`));
      if (owned.length === 0) continue;

      // Declaring the constant is not enough — it has to reach the shared gate.
      const wired =
        /TSC_PREFLIGHT_COMMAND\s*=\s*'npm run gen:declarations'/.test(leg.source) &&
        /preTscCommand:\s*TSC_PREFLIGHT_COMMAND/.test(leg.source);

      (wired ? covered : missing).push(`${leg.script} (${projectDir}, ${owned.length} inputs)`);
    }

    // operator-core, operator and scripts all own generated inputs; if this drops below three
    // the discovery above has broken rather than the tree having improved.
    expect(covered.length + missing.length).toBeGreaterThanOrEqual(3);
    expect(missing).toEqual([]);
  });

  it('a leg that consumes no generated declarations is not forced to pay for the preflight', () => {
    // The preflight compiles the whole declarations project (~5s). That is cheap against a
    // ~150s typecheck but pointless for a leg with nothing to refresh, and the shared gate
    // keeps it an explicit per-project hook precisely so it is not a hidden repo-wide mutation.
    const viteLeg = legs.find((l) => l.script === 'lint:tsc:operator-vite');
    expect(viteLeg).toBeDefined();
    const projectDir = projectDirOf(viteLeg!.source);
    expect(inputs.filter((f) => f.startsWith(`${projectDir}/`))).toEqual([]);
  });
});

describe('scoped declaration preflight publication (EI-24783793601501800)', () => {
  const require = createRequire(import.meta.url);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const gateUrl = pathToFileURL(join(REPO_ROOT, 'scripts/lib/tsc-baseline-gate.mjs')).href;
  const generatorPath = join(REPO_ROOT, 'scripts/gen-declarations.ts');
  const compiler = require.resolve('typescript/lib/tsc.js');
  const tsx = require.resolve('tsx/cli');

  function runFixture({
    scope,
    selected = 'selected.mjs',
    config = 'valid',
    immutable,
    fresh = false,
  }: {
    scope: 'source' | 'declaration' | 'response' | 'typescript' | 'all';
    selected?: string;
    config?: 'valid' | 'missing' | 'malformed';
    immutable?: 'clone' | 'admission' | 'checkpoint';
    fresh?: boolean;
  }) {
    const root = mkdtempSync(join(tmpdir(), 'tsc-scoped-declarations-'));
    try {
      const declaration = selected.replace(/\.mjs$/, '.d.mts');
      let original = 'export declare function answer(): string;\n';
      let sibling = '// peer declaration bytes must survive the scoped check\n';
      writeFileSync(join(root, selected), 'export function answer() { return 42; }\n');
      writeFileSync(join(root, declaration), original);
      writeFileSync(join(root, 'sibling.mjs'), 'export const sibling = true;\n');
      writeFileSync(join(root, 'sibling.d.mts'), sibling);
      writeFileSync(join(root, 'consumer.ts'), scope === 'typescript'
        ? 'export const value = 42;\n'
        : `import { answer } from ${JSON.stringify(`./${selected}`)};\nconst value: number = answer();\n`);
      writeFileSync(join(root, 'baseline.json'), JSON.stringify({ files: {} }));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, types: [], skipLibCheck: true },
        files: ['consumer.ts'],
      }));
      if (config !== 'missing') writeFileSync(join(root, 'tsconfig.declarations.json'), config === 'malformed'
        ? '{ malformed config'
        : JSON.stringify({
          compilerOptions: { allowJs: true, declaration: true, emitDeclarationOnly: true, types: [], skipLibCheck: true },
          files: [selected, 'sibling.mjs'],
        }));
      // Exercise the real generator/compiler in a private fixture root. Its CLI
      // defaults to the canonical repo root, so use its existing explicit-root API.
      writeFileSync(join(root, 'generate.mts'),
        `import { createRequire } from 'node:module';\n` +
        `const { generate, check } = createRequire(import.meta.url)(${JSON.stringify(generatorPath)});\n` +
        `const selection = process.argv.slice(2).find(arg => arg.startsWith('--files='));\n` +
        `if (process.argv.includes('--check')) check(process.cwd());\n` +
        `else generate(process.cwd(), 'tsconfig.declarations.json', undefined, selection?.slice(8).split(','));\n`);
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        type: 'module', scripts: {
          'gen:declarations': `${quote(process.execPath)} ${quote(tsx)} generate.mts`,
          'gen:declarations:check': `${quote(process.execPath)} ${quote(tsx)} generate.mts --check`,
        },
      }));
      if (fresh) {
        execFileSync(process.execPath, [tsx, join(root, 'generate.mts')], { cwd: root, stdio: 'pipe' });
        original = readFileSync(join(root, declaration), 'utf8');
        sibling = readFileSync(join(root, 'sibling.d.mts'), 'utf8');
        // The generator's freshness check also reads tracked importer suppressions.
        execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
        execFileSync('git', ['add', '--', 'consumer.ts'], { cwd: root, stdio: 'pipe' });
      }
      const paths = [scope === 'declaration' ? declaration : selected, 'consumer.ts'];
      writeFileSync(join(root, 'scope.json'), JSON.stringify(paths));
      const argv = scope === 'all' ? [] : scope === 'response'
        ? [`--files-from=${join(root, 'scope.json')}`]
        : ['--files', ...(scope === 'typescript' ? ['consumer.ts'] : paths)];
      writeFileSync(join(root, 'run.mjs'),
        `import { runTscBaselineGate } from ${JSON.stringify(gateUrl)};\n` +
        `await runTscBaselineGate(${JSON.stringify({
          root, argv, preTscCommand: 'npm run gen:declarations',
          tscCommand: `${quote(process.execPath)} ${quote(compiler)} -p tsconfig.json --noEmit --incremental false`,
          baselineFile: join(root, 'baseline.json'), label: 'scoped-declarations',
        })});\n`);
      let code = 0;
      let output: string;
      // A fixture explicitly chooses its runtime; the qualifying test runner's
      // own candidate markers must not turn the local-development controls into
      // immutable checks when this suite runs inside the gate.
      const env = {
        ...process.env,
        PAPERCUSP_LINT_AS_COMMITTED_CLONE: immutable === 'clone' ? '1' : undefined,
        PAPERCUSP_ADMISSION_PRECHECK: immutable === 'admission' ? '1' : undefined,
        PAPERCUSP_TEST_RUN_COMMIT: immutable === 'checkpoint' ? 'a'.repeat(40) : undefined,
      };
      try {
        output = execFileSync(process.execPath, [join(root, 'run.mjs')], { encoding: 'utf8', stdio: 'pipe', env });
      } catch (error) {
        const failure = error as { status: number; stdout: string; stderr: string };
        code = failure.status;
        output = `${failure.stdout}${failure.stderr}`;
      }
      return { code, output, original, sibling, selectedBytes: readFileSync(join(root, declaration), 'utf8'),
        siblingBytes: readFileSync(join(root, 'sibling.d.mts'), 'utf8') };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it.each(['source', 'declaration', 'response'] as const)(
    'refreshes the selected contract before tsc and preserves sibling bytes (%s)', (scope) => {
      const result = runFixture({ scope });
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('emitted 1 of 2 declaration file(s)');
      expect(result.selectedBytes).toContain('answer(): number');
      expect(result.siblingBytes).toBe(result.sibling);
    }, 30_000);

  it('publishes nothing for a TypeScript-only selection', () => {
    const result = runFixture({ scope: 'typescript' });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('no declarations published');
    expect(result.selectedBytes).toBe(result.original);
    expect(result.siblingBytes).toBe(result.sibling);
  }, 30_000);

  it('keeps spaces and apostrophes in selected module paths intact', () => {
    const result = runFixture({ scope: 'source', selected: "selected's module.mjs" });
    expect(result.code, result.output).toBe(0);
    expect(result.selectedBytes).toContain('answer(): number');
    expect(result.siblingBytes).toBe(result.sibling);
  }, 30_000);

  it('retains the full refresh for an unscoped check', () => {
    const result = runFixture({ scope: 'all' });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('emitted 2 of 2 declaration file(s)');
    expect(result.siblingBytes).toContain('sibling: true');
  }, 30_000);

  it.each(['clone', 'admission', 'checkpoint'] as const)(
    'rejects stale committed declarations before tsc without rewriting evidence (%s)', (immutable) => {
      const result = runFixture({ scope: 'all', immutable });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('stale declaration(s)');
      expect(result.output).toContain('status=preflight-failed');
      expect(result.output).not.toContain('TSC scoped-declarations:');
      expect(result.output).not.toContain('emitted 2 of 2 declaration file(s)');
      expect(result.selectedBytes).toBe(result.original);
      expect(result.siblingBytes).toBe(result.sibling);
    }, 30_000,
  );

  it('checks freshness for an immutable TypeScript-only selection', () => {
    const result = runFixture({ scope: 'typescript', immutable: 'clone' });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('stale declaration(s)');
    expect(result.output).toContain('status=preflight-failed');
    expect(result.selectedBytes).toBe(result.original);
    expect(result.siblingBytes).toBe(result.sibling);
  }, 30_000);

  it('typechecks fresh committed declarations without publishing any output', () => {
    const result = runFixture({ scope: 'all', immutable: 'clone', fresh: true });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('2 declaration file(s) up to date');
    expect(result.output).not.toContain('emitted 2 of 2 declaration file(s)');
    expect(result.selectedBytes).toBe(result.original);
    expect(result.siblingBytes).toBe(result.sibling);
  }, 30_000);

  it.each(['missing', 'malformed'] as const)('fails closed on %s enrollment before publishing or typechecking', (config) => {
    const result = runFixture({ scope: 'source', config });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('status=preflight-failed');
    expect(result.output).toContain(config === 'missing' ? 'ENOENT' : 'JSON');
    expect(result.output).not.toContain('TSC scoped-declarations:');
    expect(result.selectedBytes).toBe(result.original);
    expect(result.siblingBytes).toBe(result.sibling);
  }, 30_000);
});
