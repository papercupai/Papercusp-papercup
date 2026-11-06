import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPTS = ['workspace-test.mjs', 'check-vitest-config-enrollment.mjs'];
const MODULE_CLIS = [
  { path: 'packages/operator-core/lib/dream/study/prepare-graph-comparison.mts', failure: 'CLI_FIXTURE_DEPENDENCY:installFlagOverrideStore' },
  { path: 'packages/operator-core/lib/native-device-fixture.ts', failure: 'NATIVE_HTTPS_FIXTURE_PREFLIGHT_FAILED=Disposable workspace required' },
];

/** Mutation controls must not depend on imports retained by production code. */
function withRawEntryGuard(source: string, guard: string) {
  return source.replace(guard,
    'if (process.argv[1] && __rawGuardResolve(process.argv[1]) === __rawGuardFileURLToPath(import.meta.url))')
    + '\nimport { resolve as __rawGuardResolve } from "node:path";'
    + '\nimport { fileURLToPath as __rawGuardFileURLToPath } from "node:url";';
}

/** Exercise the real entry guards without starting another test runner. */
async function withScript(script: string, bundled: boolean, run: (entry: string, root: string) => void, rawGuard = false) {
  const root = mkdtempSync(join(tmpdir(), 'cli-entry-scripts-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'packages/bad'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    writeFileSync(join(root, 'packages/bad/package.json'), JSON.stringify({ name: 'bad' }));
    writeFileSync(join(root, 'packages/bad/vitest.config.ts'), 'export default { test: {} };');
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    const entry = join(root, 'scripts', script);
    await build({
      entryPoints: [join(REPO_ROOT, 'scripts', script)],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: ['typescript', 'vite'],
      define: { __PAPERCUSP_BUNDLED_SIDECAR__: String(bundled) },
      plugins: [{
        name: 'record-workspace-child',
        setup(build) {
          if (rawGuard) {
            build.onLoad({ filter: /(?:workspace-test|check-vitest-config-enrollment|check-partial-index-alignment|verify-engineering-evidence-release)\.mjs$/ }, ({ path }) => {
              const source = readFileSync(path, 'utf8');
              const guard = 'if (isCliEntry(import.meta.url))';
              if (!source.includes(guard)) throw new Error('Expected the production CLI-entry guard');
              return {
                contents: withRawEntryGuard(source, guard),
                loader: 'js',
              };
            });
          }
          build.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'child', namespace: 'fixture' }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            // `spawn` is reached through @papercusp/verification-harness (guard-rails.ts); it only runs
            // when a harness configures guard rails, so a bundled CLI that reaches it is a test failure.
            contents: 'export function spawnSync(command, args) { console.log(JSON.stringify({ command, args })); return { status: 7 }; }\n'
              + 'export function spawn() { throw new Error("fixture: child_process.spawn is not stubbed"); }',
            loader: 'js',
          }));
        },
      }],
    });
    run(entry, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Keep the actual module and entry helper; isolate project dependencies before use. */
async function withModuleCli(modulePath: string, bundled: boolean, run: (entry: string, root: string) => void, rawGuard = false) {
  const root = mkdtempSync(join(tmpdir(), 'cli-entry-module-'));
  try {
    const sourcePath = join(REPO_ROOT, modulePath);
    const source = readFileSync(sourcePath, 'utf8');
    const parsed = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const dependencies = new Map<string, string[]>();
    for (const statement of parsed.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      dependencies.set(statement.moduleSpecifier.text, clause.namedBindings.elements
        .filter(element => !element.isTypeOnly).map(element => (element.propertyName ?? element.name).text));
    }
    const guard = 'if (isCliEntry(import.meta.url))';
    expect(source).toContain(guard);
    const entry = join(root, 'entry.mjs');
    const helper = join(REPO_ROOT, 'packages/operator-core/lib/util/cli-entry.ts');
    await build({
      entryPoints: [sourcePath], outfile: entry, bundle: true, platform: 'node', format: 'esm',
      define: { __PAPERCUSP_BUNDLED_SIDECAR__: String(bundled) },
      plugins: [{
        name: 'isolate-library-cli-dependencies',
        setup(build) {
          build.onResolve({ filter: /^\./ }, args => {
            if (resolve(args.resolveDir, args.path) === helper.replace(/\.ts$/, '')) return { path: helper };
            if (args.importer !== sourcePath) return;
            return { path: args.path, namespace: 'cli-dependency' };
          });
          build.onLoad({ filter: /.*/, namespace: 'cli-dependency' }, args => ({
            contents: (dependencies.get(args.path) ?? []).map(name =>
              `export function ${name}() { throw new Error(${JSON.stringify('CLI_FIXTURE_DEPENDENCY:' + name)}); }`).join('\n'),
            loader: 'js',
          }));
          if (rawGuard) build.onLoad({ filter: /\.(?:ts|mts)$/ }, args => {
            if (args.path !== sourcePath) return;
            return { contents: withRawEntryGuard(source, guard), loader: 'ts' };
          });
        },
      }],
    });
    run(entry, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function execute(args: string[], root: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    // The fixture is an isolated executable, not another Vitest worker.
    env: { ...process.env, NODE_OPTIONS: '', ...env },
  });
}

describe.each(SCRIPTS)('%s CLI entry', (script) => {
  it('detects the original raw entry guard firing inside an executable bundle', async () => {
    await withScript(script, true, (entry, root) => {
      const result = execute([entry], root);
      expect(result.error).toBeUndefined();
      if (script === 'workspace-test.mjs') {
        expect(result.status, result.stderr).toBe(7);
        expect(JSON.parse(result.stdout)).toEqual({ command: 'npx', args: ['vitest', 'run'] });
      } else {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('packages/bad/vitest.config.ts');
      }
    }, true);
  });

  it('stays inert when inlined into an executable host bundle', async () => {
    await withScript(script, true, (entry, root) => {
      const result = execute([entry], root);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  it('stays inert when imported by a separate executable', async () => {
    await withScript(script, false, (entry, root) => {
      const importer = join(root, 'importer.mjs');
      writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('import complete');`);
      const result = execute([importer], root);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('import complete');
      expect(result.stderr).toBe('');
    });
  });

  it.each([false, true])('runs as a standalone CLI (symlink=%s) and preserves its failure status', async (symlink) => {
    await withScript(script, false, (entry, root) => {
      const invoked = symlink ? join(root, 'entry-link.mjs') : entry;
      if (symlink) symlinkSync(entry, invoked);
      const result = execute([invoked, '--passWithNoTests'], root);
      expect(result.error).toBeUndefined();
      if (script === 'workspace-test.mjs') {
        expect(result.status, result.stderr).toBe(7);
        expect(JSON.parse(result.stdout)).toEqual({ command: 'npx', args: ['vitest', 'run', '--passWithNoTests'] });
      } else {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('packages/bad/vitest.config.ts');
      }
    });
  });
});

describe('partial-index alignment CLI entry in the operator graph', () => {
  const script = 'check-partial-index-alignment.mjs';

  it('keeps the bundled checker inert and detects the original entry comparison', async () => {
    await withScript(script, true, (entry, root) => {
      const result = execute([entry], root);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
    await withScript(script, true, (entry, root) => {
      const result = execute([entry], root);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('generated.ts');
    }, true);
  });

  it('still runs its schema preflight as a standalone checker', async () => {
    await withScript(script, false, (entry, root) => {
      const result = execute([entry], root);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('generated.ts');
    });
  });
});

describe('engineering evidence release CLI entry in the operator graph', () => {
  const script = 'verify-engineering-evidence-release.mjs';
  // The CLI records its run through runHarness; keep that evidence inside the throwaway root.
  const fixtureEnv = (root: string) => ({
    PAPERCUSP_ENGINEERING_JOURNEY_INPUTS: join(root, 'missing-inputs.json'),
    VH_EVIDENCE_ROOT_BASE: join(root, 'vh-evidence'),
  });

  it('stays inert in the host bundle and detects the original entry comparison', async () => {
    await withScript(script, true, (entry, root) => {
      const result = execute([entry], root, fixtureEnv(root));
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
    await withScript(script, true, (entry, root) => {
      const result = execute([entry], root, fixtureEnv(root));
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unknown',
        reason: 'Canonical release journey inputs are unavailable.' });
    }, true);
  });

  it('preserves the standalone missing-input refusal', async () => {
    await withScript(script, false, (entry, root) => {
      const result = execute([entry], root, fixtureEnv(root));
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unknown',
        reason: 'Canonical release journey inputs are unavailable.' });
    });
  });

  it('stays inert when imported by a separate executable', async () => {
    await withScript(script, false, (entry, root) => {
      const importer = join(root, 'importer.mjs');
      writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('import complete');`);
      const result = execute([importer], root, fixtureEnv(root));
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('import complete');
      expect(result.stderr).toBe('');
    });
  });
});

describe.each(MODULE_CLIS)('$path CLI entry', ({ path, failure }) => {
  const fixtureEnv = { PAPERCUSP_WORKSPACE_ID: '' };

  it('detects the raw entry comparison firing inside an executable bundle', async () => {
    await withModuleCli(path, true, (entry, root) => {
      const result = execute([entry], root, fixtureEnv);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(failure);
    }, true);
  });

  it('stays inert when inlined into an executable host bundle', async () => {
    await withModuleCli(path, true, (entry, root) => {
      const result = execute([entry], root, fixtureEnv);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    });
  });

  it('stays inert when imported by a separate executable', async () => {
    await withModuleCli(path, false, (entry, root) => {
      const importer = join(root, 'importer.mjs');
      writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log('import complete');`);
      const result = execute([importer], root, fixtureEnv);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('import complete');
      expect(result.stderr).toBe('');
    });
  });

  it.each([false, true])('runs its standalone preflight (symlink=%s)', async (symlink) => {
    await withModuleCli(path, false, (entry, root) => {
      const invoked = symlink ? join(root, 'entry-link.mjs') : entry;
      if (symlink) symlinkSync(entry, invoked);
      const result = execute([invoked], root, fixtureEnv);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(failure);
    });
  });
});
