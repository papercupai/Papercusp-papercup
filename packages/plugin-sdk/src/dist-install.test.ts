/**
 * The SDK installs, type-checks and runs OUTSIDE this monorepo from its packed tarball
 * (WI-10006701).
 *
 * `npm install @papercusp/plugin-sdk` cannot work: the package and its dependency
 * @papercusp/tooldef are private workspace packages, and the source entry made an author's
 * compiler compile tooldef's source. The supported route is the tarball built by
 * `npm run pack:dist --workspace @papercusp/plugin-sdk` (scripts/pack-dist.mjs). This test
 * runs that script, installs the tarball the documented way into a fresh project under the OS
 * temp dir (no ancestor node_modules), and checks it as an outside author would:
 *   - no runtime dependency and no `@papercusp/*` import is left in the package;
 *   - the main entry and both subpaths type-check with skipLibCheck OFF and no node types,
 *     under Bundler and NodeNext resolution, with only the declared optional peer
 *     (@types/react) added;
 *   - the provider subpath type-checks with nothing but the SDK installed;
 *   - the ESM bundles import and run in Node.
 * A calibration case proves the directory cannot see the monorepo, so a pass is not borrowed
 * from the repo's hoisted node_modules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SDK_ROOT, '..', '..');
/** Overridable so scripts/mutation-probe.sh can point the test at a copy of the pack script. */
const PACK_SCRIPT = process.env.PLUGIN_SDK_PACK_SCRIPT ?? join(SDK_ROOT, 'scripts', 'pack-dist.mjs');

type TsModule = typeof import('typescript');
const ts = createRequire(join(REPO, 'package.json'))('typescript') as TsModule;

/** npm reads npm_config_* from the environment; keep the repo's npm run context out of it. */
function hermeticEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
}

let work = '';
let tarball = '';
/** The SDK alone, installed from the tarball. */
let bare = '';
/** The same install plus the declared optional peer @types/react (and its dependencies). */
let withPeer = '';

async function copyFromRepo(name: string, destRoot: string, seen = new Set<string>()): Promise<void> {
  if (seen.has(name)) return;
  seen.add(name);
  const src = realpathSync(join(REPO, 'node_modules', name));
  await fs.cp(src, join(destRoot, 'node_modules', name), {
    recursive: true,
    filter: (p) => !relative(src, p).split(sep).includes('node_modules'),
  });
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  for (const dep of Object.keys(pkg.dependencies ?? {})) await copyFromRepo(dep, destRoot, seen);
}

beforeAll(async () => {
  work = await fs.mkdtemp(join(tmpdir(), 'plugin-sdk-dist-'));
  const out = execFileSync(process.execPath, [PACK_SCRIPT, '--out', join(work, 'out')], {
    cwd: SDK_ROOT,
    encoding: 'utf8',
    env: { ...hermeticEnv(), PLUGIN_SDK_ROOT: SDK_ROOT },
  });
  tarball = /^PLUGIN_SDK_TARBALL=(.+)$/m.exec(out)?.[1] ?? '';
  expect(tarball, `pack-dist printed no tarball:\n${out}`).not.toBe('');

  bare = join(work, 'bare');
  await fs.mkdir(bare);
  await fs.writeFile(join(bare, 'package.json'), JSON.stringify({ name: 'outside-author', private: true, type: 'module' }));
  execFileSync('npm', ['install', tarball, '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'], {
    cwd: bare,
    encoding: 'utf8',
    env: hermeticEnv(),
  });

  withPeer = join(work, 'with-peer');
  await fs.cp(bare, withPeer, { recursive: true });
  // The main entry's types use react's ComponentType and node's Buffer (PluginStorage), so
  // both are declared optional peers. Copy exactly the declared peers, nothing else.
  const pkg = JSON.parse(readFileSync(join(bare, 'node_modules', '@papercusp', 'plugin-sdk', 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>;
  };
  for (const peer of Object.keys(pkg.peerDependencies ?? {})) await copyFromRepo(peer, withPeer);
}, 180_000);

afterAll(async () => {
  if (work) await fs.rm(work, { recursive: true, force: true });
});

const RESOLUTIONS = {
  Bundler: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
  NodeNext: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
} as const;

/** Type-check one consumer file in `dir` with strict settings and skipLibCheck OFF. */
async function typecheck(
  dir: string,
  source: string,
  resolution: keyof typeof RESOLUTIONS,
  types: string[] = [],
): Promise<string[]> {
  const consumer = join(dir, `consumer-${resolution}.ts`);
  await fs.writeFile(consumer, source);
  const program = ts.createProgram({
    rootNames: [consumer],
    options: {
      target: ts.ScriptTarget.ES2022,
      ...RESOLUTIONS[resolution],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      // TypeScript 6 defaults `types` to [] (no automatic @types inclusion), so an author who
      // wants node globals lists them; the type roots are the author's own node_modules only.
      types,
      typeRoots: [join(dir, 'node_modules', '@types')],
    },
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? relative(dir, d.file.fileName) : '(global)';
    return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

const MAIN_CONSUMER = [
  "import type { PapercuspApi, PluginStorage, AgentRole, ToolResult, RolesQuota, ProgressCallback, EmitCallback } from '@papercusp/plugin-sdk';",
  "import { PAPERCUSP_RUNTIME_VERSION, validateTriggerPackDeclaration, lookupTier } from '@papercusp/plugin-sdk';",
  "import type { ProviderDescriptor } from '@papercusp/plugin-sdk/provider';",
  "import { PROVIDER_CONTRACT_VERSIONS } from '@papercusp/plugin-sdk/provider';",
  "import { initPapercupIframe } from '@papercusp/plugin-sdk/iframe';",
  'export type T = [PapercuspApi, PluginStorage, AgentRole, ToolResult, RolesQuota, ProgressCallback, EmitCallback, ProviderDescriptor];',
  'export const role: AgentRole = "outside-author:reviewer";',
  'export const version: string = PAPERCUSP_RUNTIME_VERSION;',
  'export const fns = [validateTriggerPackDeclaration, lookupTier, initPapercupIframe] as const;',
  'export const contracts: readonly number[] = PROVIDER_CONTRACT_VERSIONS;',
  '',
].join('\n');

describe('plugin-sdk packed tarball, installed outside the monorepo (WI-10006701)', () => {
  it('calibration: the install directory cannot see the monorepo', async () => {
    const req = createRequire(join(bare, 'package.json'));
    expect(() => req.resolve('@papercusp/tooldef')).toThrow();
    expect(() => req.resolve('typescript')).toThrow();
    const diagnostics = await typecheck(bare, "import type { ToolResult } from '@papercusp/tooldef';\nexport type X = ToolResult;\n", 'Bundler');
    expect(diagnostics.some((d) => d.includes("Cannot find module '@papercusp/tooldef'"))).toBe(true);
  });

  it('has no runtime dependency, is not private, and imports nothing from @papercusp/*', async () => {
    const root = join(bare, 'node_modules', '@papercusp', 'plugin-sdk');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.private).toBeUndefined();
    const offenders: string[] = [];
    for (const file of await filesUnder(root)) {
      if (!/\.(js|d\.ts)$/.test(file)) continue;
      const m = /(?:from|import)\s*\(?\s*['"](@papercusp\/[^'"]+)['"]/.exec(readFileSync(file, 'utf8'));
      if (m) offenders.push(`${relative(root, file)} -> ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  for (const resolution of Object.keys(RESOLUTIONS) as Array<keyof typeof RESOLUTIONS>) {
    it(`the main entry and subpaths type-check with only the declared peers added (${resolution}, skipLibCheck off)`, async () => {
      const diagnostics = await typecheck(withPeer, MAIN_CONSUMER, resolution, ['node']);
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    }, 60_000);

    it(`the provider subpath type-checks with nothing but the SDK installed (${resolution})`, async () => {
      const diagnostics = await typecheck(
        bare,
        "import type { ProviderDescriptor, HostFetch } from '@papercusp/plugin-sdk/provider';\nimport { createProviderDaemon } from '@papercusp/plugin-sdk/provider-daemon';\nexport type T = [ProviderDescriptor, HostFetch];\nexport const daemon = createProviderDaemon;\n",
        resolution,
      );
      expect(diagnostics, diagnostics.join('\n')).toEqual([]);
    }, 60_000);
  }

  it('the ESM bundles import and run in Node', () => {
    const script = [
      "const sdk = await import('@papercusp/plugin-sdk');",
      "const provider = await import('@papercusp/plugin-sdk/provider');",
      "const daemon = await import('@papercusp/plugin-sdk/provider-daemon');",
      'console.log(JSON.stringify({',
      '  version: sdk.PAPERCUSP_RUNTIME_VERSION,',
      "  validate: typeof sdk.validateTriggerPackDeclaration,",
      "  lookupTier: typeof sdk.lookupTier,",
      '  contracts: provider.PROVIDER_CONTRACT_VERSIONS,',
      '  daemon: typeof daemon.createProviderDaemon,',
      '}));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: bare, encoding: 'utf8' });
    const got = JSON.parse(out.trim()) as Record<string, unknown>;
    expect(typeof got.version).toBe('string');
    expect(got.validate).toBe('function');
    expect(got.lookupTier).toBe('function');
    expect(got.contracts).toContain(1);
    expect(got.daemon).toBe('function');
  });
});
