/**
 * The SDK must type-check for an author OUTSIDE this monorepo with only the packages its
 * package.json declares installed (WI-10006655).
 *
 * A symlinked install cannot prove that. TypeScript follows a link's realpath back into the
 * monorepo and resolves an undeclared import from the repo's hoisted node_modules, which is how
 * the P-014 out-of-tree author journey missed the SDK's undeclared `react` import. So every
 * package here is COPIED into a fresh directory under the OS temp dir, which has no ancestor
 * node_modules, and the calibration case proves that directory cannot see the repo.
 *
 * Scope: this file installs the SOURCE package, whose main entry imports `@papercusp/tooldef`
 * (a private workspace package), so only the `./provider` subpath is checked here with nothing
 * else installed. The distributable an outside author installs is the self-contained tarball
 * built by `npm run pack:dist` (scripts/pack-dist.mjs, WI-10006701); dist-install.test.ts
 * proves that one, main entry included.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { promises as fs, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SDK_ROOT, '..', '..');

type TsModule = typeof import('typescript');
const ts = createRequire(join(REPO, 'package.json'))('typescript') as TsModule;

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Overridable so scripts/mutation-probe.sh can point the declaration checks at a copy. */
const SDK_PKG_PATH = process.env.PLUGIN_SDK_PACKAGE_JSON ?? join(SDK_ROOT, 'package.json');
const SDK_PKG = JSON.parse(readFileSync(SDK_PKG_PATH, 'utf8')) as PackageJson;

const scratchDirs: string[] = [];
afterAll(async () => {
  await Promise.all(scratchDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Copy a package directory the way `npm pack` ships it: everything except its node_modules. */
async function copyPackage(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, {
    recursive: true,
    filter: (path) => !relative(src, path).split(sep).includes('node_modules'),
  });
}

/** A package's own declared runtime dependencies, read from the copy in the repo's node_modules. */
function declaredDependencies(name: string): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO, 'node_modules', name, 'package.json'), 'utf8')) as PackageJson;
  return Object.keys(pkg.dependencies ?? {});
}

/**
 * A clean directory holding the SDK plus `extra` packages and, recursively, the dependencies each
 * extra declares. Nothing undeclared is installed, so a resolution that succeeds came from a
 * declaration.
 */
async function cleanInstall(extra: string[]): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'plugin-sdk-clean-'));
  scratchDirs.push(dir);
  await copyPackage(SDK_ROOT, join(dir, 'node_modules', '@papercusp', 'plugin-sdk'));
  const queue = [...extra];
  const installed = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (installed.has(name)) continue;
    installed.add(name);
    await copyPackage(realpathSync(join(REPO, 'node_modules', name)), join(dir, 'node_modules', name));
    queue.push(...declaredDependencies(name));
  }
  return dir;
}

/** Type-check one consumer file in `dir` as an outside author would, returning its diagnostics. */
async function typecheck(dir: string, source: string): Promise<string[]> {
  const consumer = join(dir, 'consumer.ts');
  await fs.writeFile(consumer, source);
  const program = ts.createProgram({
    rootNames: [consumer],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      // `lib` is left at the compiler default, as in an author's default tsconfig. provider.ts
      // uses the standard `URL` global, which that default lib (or @types/node) supplies.
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      // No ambient @types: every type must arrive through an import.
      types: [],
    },
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? relative(dir, d.file.fileName) : '(global)';
    return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

const MAIN_ENTRY_CONSUMER = "import type { PapercuspApi } from '@papercusp/plugin-sdk';\nexport type P = PapercuspApi;\n";

describe('plugin-sdk type-checks in a clean install (WI-10006655)', () => {
  it('the provider subpath type-checks with only the SDK installed', async () => {
    const dir = await cleanInstall([]);
    const diagnostics = await typecheck(
      dir,
      "import type { ProviderDescriptor, HostFetch } from '@papercusp/plugin-sdk/provider';\n" +
        'export type T = [ProviderDescriptor, HostFetch];\n',
    );
    expect(diagnostics).toEqual([]);
  }, 60_000);

  it('calibration: the clean directory cannot resolve anything from the monorepo', async () => {
    // The repo hoists @types/react, so if resolution leaked out of the clean directory this
    // import would succeed and the first case would prove nothing.
    const dir = await cleanInstall([]);
    const diagnostics = await typecheck(dir, MAIN_ENTRY_CONSUMER);
    expect(diagnostics.some((d) => d.includes("Cannot find module 'react'"))).toBe(true);
  }, 60_000);

  it("the main entry's react import resolves from the declared optional peer", async () => {
    const peers = Object.keys(SDK_PKG.peerDependencies ?? {});
    expect(peers).toContain('@types/react');
    const dir = await cleanInstall(peers);
    const diagnostics = await typecheck(dir, MAIN_ENTRY_CONSUMER);
    expect(diagnostics.filter((d) => d.includes("'react'"))).toEqual([]);
  }, 60_000);

  it('every bare import in the SDK source is a declared dependency or peer', () => {
    const declared = new Set([
      ...Object.keys(SDK_PKG.dependencies ?? {}),
      ...Object.keys(SDK_PKG.peerDependencies ?? {}),
    ]);
    /** `react` is satisfied by `@types/react`; `@scope/name` by `@types/scope__name`. */
    const typesPackage = (name: string) => `@types/${name.replace(/^@/, '').replace('/', '__')}`;
    const packageOf = (specifier: string) =>
      specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

    const undeclared: string[] = [];
    const srcDir = join(SDK_ROOT, 'src');
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const info = ts.preProcessFile(readFileSync(join(srcDir, file), 'utf8'), true, true);
      for (const { fileName: specifier } of info.importedFiles) {
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        const name = packageOf(specifier);
        if (!declared.has(name) && !declared.has(typesPackage(name))) undeclared.push(`${file}: ${specifier}`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
