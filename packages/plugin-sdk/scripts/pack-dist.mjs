#!/usr/bin/env node
/**
 * Build a self-contained, installable tarball of @papercusp/plugin-sdk (WI-10006701).
 *
 *   npm run pack:dist --workspace @papercusp/plugin-sdk -- --out <dir>
 *
 * Prints `PLUGIN_SDK_TARBALL=<absolute path>` as its last line. An author outside this
 * monorepo installs that file with `npm install <path-to-tarball>`.
 *
 * WHY A SEPARATE ARTIFACT. In the monorepo the package points at its TypeScript source and
 * depends on the private workspace package @papercusp/tooldef. Outside the monorepo neither
 * works: tooldef cannot be installed, and importing the main entry made the author's compiler
 * compile tooldef's source (15+ errors without node types). The SDK only takes TYPES from
 * tooldef (`import type`), so this build:
 *   1. bundles each `exports` entry to ESM with esbuild (type-only imports are erased; the
 *      JSON tier table is inlined; react stays external);
 *   2. emits declarations with the TypeScript compiler API, using the package's own tsconfig;
 *   3. vendors the declarations of the tooldef modules the SDK's types come from into
 *      dist/vendor/tooldef and points the SDK's declarations at them;
 *   4. writes a package.json DERIVED from the source one (exports re-pointed at dist, no
 *      dependencies, not private) and runs `npm pack`.
 * The result has no runtime dependencies and no `@papercusp/*` import left in it.
 * packages/plugin-sdk/src/dist-install.test.ts installs it in a clean directory and
 * type-checks and imports it.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// PLUGIN_SDK_ROOT lets a mutation probe run a copy of this script from outside the tree.
const SDK_ROOT = process.env.PLUGIN_SDK_ROOT
  ? resolve(process.env.PLUGIN_SDK_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SDK_ROOT, '..', '..');
const TOOLDEF_SRC = join(REPO, 'libs', 'generic', 'tooldef', 'src');
const TOOLDEF_SPECIFIER = '@papercusp/tooldef';
// The tooldef modules that define every type the SDK imports from tooldef. Both are
// import-free, so their declarations stand alone. If the SDK starts importing a tooldef type
// defined elsewhere, the vendored index will not export it and the dist-install test's
// type-check fails, naming the missing member.
const VENDORED_TOOLDEF_MODULES = ['wire.ts', 'host-types.ts'];

const require = createRequire(join(REPO, 'package.json'));
const ts = require('typescript');
const esbuild = require('esbuild');

function fail(msg) {
  console.error(`pack-dist: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { out: process.cwd(), keepStage: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = resolve(argv[++i] ?? fail('--out needs a directory'));
    else if (argv[i] === '--keep-stage') opts.keepStage = true;
    else fail(`unknown argument ${argv[i]}`);
  }
  return opts;
}

/** `exports` subpath -> source entry, read from the source package.json (never re-typed). */
function entriesFrom(pkg) {
  const entries = [];
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    const src = typeof target === 'string' ? target : (target.import ?? target.default ?? target.types);
    const m = /^\.\/src\/([A-Za-z0-9_-]+)\.ts$/.exec(src ?? '');
    if (!m) fail(`exports["${subpath}"] must point at ./src/<name>.ts, got ${JSON.stringify(src)}`);
    entries.push({ subpath, name: m[1], file: join(SDK_ROOT, 'src', `${m[1]}.ts`) });
  }
  if (entries.length === 0) fail('package.json has no exports');
  return entries;
}

function reportDiagnostics(diags, label) {
  if (diags.length === 0) return;
  const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => REPO, getNewLine: () => '\n' };
  fail(`${label}:\n${ts.formatDiagnostics(diags, host)}`);
}

/** Emit declarations for `rootNames` into `outDir`, failing on any diagnostic. */
function emitDeclarations(rootNames, baseOptions, rootDir, outDir, label) {
  const options = {
    ...baseOptions,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    rootDir,
    outDir,
  };
  const program = ts.createProgram({ rootNames, options });
  reportDiagnostics(ts.getPreEmitDiagnostics(program), `${label}: type errors`);
  const result = program.emit();
  reportDiagnostics(result.diagnostics, `${label}: declaration emit failed`);
}

async function walk(dir) {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const RELATIVE_SPECIFIER = /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+?)\2/g;

/**
 * Make the emitted declarations resolvable under every moduleResolution an author may use:
 * point the tooldef import at the vendored copy, and give extensionless relative specifiers
 * the `.js` that NodeNext resolution requires in a `"type": "module"` package.
 */
async function rewriteDeclarations(distDir, vendorIndex) {
  for (const file of await walk(distDir)) {
    if (!file.endsWith('.d.ts')) continue;
    let text = await fs.readFile(file, 'utf8');
    // Import the vendored index by its `.js` name; TypeScript maps it to the `.d.ts` beside it.
    let toVendor = relative(dirname(file), vendorIndex.replace(/\.d\.ts$/, '.js')).split('\\').join('/');
    if (!toVendor.startsWith('.')) toVendor = `./${toVendor}`;
    text = text.split(`'${TOOLDEF_SPECIFIER}'`).join(`'${toVendor}'`).split(`"${TOOLDEF_SPECIFIER}"`).join(`"${toVendor}"`);
    text = text.replace(RELATIVE_SPECIFIER, (all, lead, q, spec) =>
      /\.(js|mjs|cjs|json)$/.test(spec) ? all : `${lead}${q}${spec}.js${q}`,
    );
    await fs.writeFile(file, text);
  }
}

async function assertNoWorkspaceImports(distDir) {
  for (const file of await walk(distDir)) {
    const text = await fs.readFile(file, 'utf8');
    const m = /(?:from|import)\s*\(?\s*['"](@papercusp\/[^'"]+)['"]/.exec(text);
    if (m) fail(`${relative(distDir, file)} still imports ${m[1]}; it would not install outside the monorepo`);
  }
}

function distPackageJson(src, entries) {
  const unbundled = Object.keys(src.dependencies ?? {}).filter((d) => d !== TOOLDEF_SPECIFIER);
  if (unbundled.length > 0) {
    fail(`dependencies ${unbundled.join(', ')} are not bundled by this script; extend it before packing`);
  }
  const exportsMap = {};
  for (const e of entries) {
    exportsMap[e.subpath] = { types: `./dist/${e.name}.d.ts`, import: `./dist/${e.name}.js`, default: `./dist/${e.name}.js` };
  }
  const main = entries.find((e) => e.subpath === '.');
  return {
    name: src.name,
    version: src.version,
    description: 'Type definitions and helpers for Papercusp plugins and providers.',
    type: 'module',
    ...(main ? { main: `./dist/${main.name}.js`, types: `./dist/${main.name}.d.ts` } : {}),
    exports: exportsMap,
    files: ['dist'],
    sideEffects: false,
    ...(src.peerDependencies ? { peerDependencies: src.peerDependencies } : {}),
    ...(src.peerDependenciesMeta ? { peerDependenciesMeta: src.peerDependenciesMeta } : {}),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const srcPkg = JSON.parse(readFileSync(join(SDK_ROOT, 'package.json'), 'utf8'));
  const entries = entriesFrom(srcPkg);
  const stage = await fs.mkdtemp(join(tmpdir(), 'plugin-sdk-pack-'));
  const dist = join(stage, 'dist');
  try {
    // 1. JavaScript, one self-contained ESM bundle per export entry.
    await esbuild.build({
      entryPoints: Object.fromEntries(entries.map((e) => [e.name, e.file])),
      outdir: dist,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      external: ['react'],
      logLevel: 'silent',
    });

    // 2. Declarations, compiled with the package's own tsconfig.
    const parsed = ts.getParsedCommandLineOfConfigFile(join(SDK_ROOT, 'tsconfig.json'), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => reportDiagnostics([d], 'tsconfig'),
    });
    if (!parsed) fail('could not read packages/plugin-sdk/tsconfig.json');
    emitDeclarations(entries.map((e) => e.file), parsed.options, join(SDK_ROOT, 'src'), dist, 'plugin-sdk');

    // 3. Vendor the tooldef type modules the declarations import.
    const vendorDir = join(dist, 'vendor', 'tooldef');
    emitDeclarations(
      VENDORED_TOOLDEF_MODULES.map((m) => join(TOOLDEF_SRC, m)),
      { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, types: [], skipLibCheck: true },
      TOOLDEF_SRC,
      vendorDir,
      'tooldef (vendored types)',
    );
    const vendorIndex = join(vendorDir, 'index.d.ts');
    await fs.writeFile(
      vendorIndex,
      `${VENDORED_TOOLDEF_MODULES.map((m) => `export * from './${basename(m, '.ts')}.js';`).join('\n')}\n`,
    );
    await rewriteDeclarations(dist, vendorIndex);
    await assertNoWorkspaceImports(dist);

    // 4. Derived package.json, then npm pack.
    await fs.writeFile(join(stage, 'package.json'), `${JSON.stringify(distPackageJson(srcPkg, entries), null, 2)}\n`);
    await fs.mkdir(opts.out, { recursive: true });
    const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', opts.out], {
      cwd: stage,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .pop();
    if (!packed) fail('npm pack printed no file name');
    console.log(`PLUGIN_SDK_TARBALL=${join(opts.out, packed)}`);
  } finally {
    if (opts.keepStage) console.error(`pack-dist: stage kept at ${stage}`);
    else await fs.rm(stage, { recursive: true, force: true });
  }
}

main().catch((err) => fail(err?.stack ?? String(err)));
