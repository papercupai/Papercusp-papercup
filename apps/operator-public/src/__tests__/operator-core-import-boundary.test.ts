/**
 * Import boundary: the Cupboard Worker's compile must never reach operator-core's hub graph.
 *
 * operator-public typechecks under a STRICTER tsconfig than operator-core (no DOM/jsx, Workers
 * types, verbatimModuleSyntax), and tsc compiles every file an import reaches — a type-only
 * import and a dynamic `import()` included. One innocent-looking edge into a module that reaches
 * `agent-tools/` therefore adds ~1,500 operator-core files to this compile and turns the gate's
 * zero-error typecheck leg red with ~260 errors in files nobody here touched. That happened twice
 * on 2026-10-01 (EI-24768138245089371, WI-10004876); the only detector was the gate, hours later,
 * pointing at the wrong files. This test names the offending CHAIN at the edit instead.
 *
 * It resolves imports with TypeScript's own resolver against this package's tsconfig, so it
 * follows exactly what tsc follows. Fix a failure by moving the needed symbol into a leaf module
 * (see `cupboard/recipe-manifest.ts`, `cupboard/blueprint-release-signer.ts`), never by widening
 * FORBIDDEN or excluding a file from the compile.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = resolve(APP_DIR, '../..');

/** operator-core subtrees whose reach drags in the PG / agent-tools graph. */
const FORBIDDEN = [
  'packages/operator-core/lib/agent-tools/',
  'packages/operator-core/lib/dbos/',
  'packages/operator-core/lib/endpoint-route/',
];

function loadOptions(): { options: ts.CompilerOptions; roots: string[] } {
  const configPath = join(APP_DIR, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, APP_DIR);
  return { options: parsed.options, roots: parsed.fileNames };
}

interface Walk {
  reached: Map<string, string | null>;
  firstForbidden: string | null;
}

/** Breadth-first walk of the compile's source graph (declaration files and third-party packages are
 *  leaves: tsc reads them but they are not this repo's code). */
function walk(roots: string[], options: ts.CompilerOptions): Walk {
  const reached = new Map<string, string | null>();
  const queue: string[] = [];
  for (const r of roots) {
    const abs = ts.sys.realpath ? ts.sys.realpath(r) : r;
    if (!reached.has(abs)) { reached.set(abs, null); queue.push(abs); }
  }
  const isForbidden = (abs: string) => FORBIDDEN.some((p) => relative(REPO_ROOT, abs).startsWith(p));
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]!;
    if (isForbidden(file)) return { reached, firstForbidden: file };
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const imp of info.importedFiles) {
      const resolved = ts.resolveModuleName(imp.fileName, file, options, ts.sys).resolvedModule;
      if (!resolved) continue;
      const target = resolved.resolvedFileName;
      if (target.endsWith('.d.ts') || target.includes('/node_modules/')) continue;
      if (reached.has(target)) continue;
      reached.set(target, file);
      queue.push(target);
    }
  }
  return { reached, firstForbidden: null };
}

function chainTo(w: Walk, target: string): string {
  const chain: string[] = [];
  for (let p: string | null | undefined = target; p; p = w.reached.get(p)) chain.push(relative(REPO_ROOT, p));
  return chain.reverse().join('\n  -> ');
}

describe('operator-public compile never reaches the operator-core hub graph', () => {
  it('no source file of this package imports (even type-only or dynamically) into agent-tools / dbos / endpoint-route', () => {
    const { options, roots } = loadOptions();
    const w = walk(roots, options);
    // Positive control: resolution must actually reach operator-core, or an empty walk would pass vacuously.
    const reachedRel = [...w.reached.keys()].map((p) => relative(REPO_ROOT, p));
    expect(reachedRel).toContain('packages/operator-core/lib/cupboard/transparency-statement.ts');
    expect(
      w.firstForbidden,
      w.firstForbidden
        ? `operator-public's compile reaches ${relative(REPO_ROOT, w.firstForbidden)} via:\n  ${chainTo(w, w.firstForbidden)}\n` +
            'Move the symbol the first operator-core hop needs into a leaf module.'
        : undefined,
    ).toBeNull();
  }, 120_000);

  it('Worker TEST files are roots of the walk (a test import counts exactly like a source import)', () => {
    // tsc compiles this package's tests under the same zero-error leg, so a test that imports a
    // PG-backed operator-core module turns it red just as a source file would (EI-24772006759025610).
    // If the tsconfig ever stops including tests, the guard above silently stops covering them.
    const { roots } = loadOptions();
    const rel = roots.map((r) => relative(APP_DIR, r));
    expect(rel).toContain('src/__tests__/operator-core-import-boundary.test.ts');
  });

  it('calibration: a PG-backed operator-core wrapper is flagged, its PG-free core is not', () => {
    // The EI-24772006759025610 incident: a Worker test imported the PG-backed transparency runtime.
    // The fix split the pass into a PG-free core (transparency-publish.ts) the Worker may import and
    // a defaults wrapper it may not. If a refactor moves these edges, pick another wrapper/core pair
    // that genuinely sits on either side of FORBIDDEN.
    const { options } = loadOptions();
    const wrapper = walk([join(REPO_ROOT, 'packages/operator-core/lib/cupboard/transparency-runtime.ts')], options);
    expect(wrapper.firstForbidden).not.toBeNull();
    const core = walk([join(REPO_ROOT, 'packages/operator-core/lib/cupboard/transparency-publish.ts')], options);
    expect(core.firstForbidden).toBeNull();
  }, 120_000);

  it('calibration: the same walk DOES flag a module known to reach agent-tools', () => {
    // recipe-authority imports agent-tools/_harness-scope; if a refactor moves that, pick another root
    // that genuinely reaches FORBIDDEN — this case exists so the guard above can never pass vacuously.
    const { options } = loadOptions();
    const w = walk([join(REPO_ROOT, 'packages/operator-core/lib/recipe-authority.ts')], options);
    expect(w.firstForbidden).not.toBeNull();
  }, 120_000);
});
