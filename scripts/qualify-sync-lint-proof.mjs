/** P037 source-only admission. No compiler, private PG, result key or source copy.
 * Walk literal imports transitively, including runtime implementations behind
 * declarations and workspace symlinks. Explicit proof roots cover spawned workers;
 * computed imports/assets still require explicit roots. Gitlink identity is checked
 * by the existing validator against the SUPERPROJECT pin, never nested HEAD.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { validateVerifierInputs } from './source-preview.mjs';

const integration = 'packages/operator-core/lib/release/sync-batch-lint-guards.integration.test.ts';
const supplemental = [
  'packages/operator-core/lib/release/sync-batch-lint-guards.compiler.test.ts',
  'packages/operator-core/lib/isolated-worker-pending-stage.test.ts',
  'packages/operator-core/test/private-http-workspace-preflight.ts',
  'packages/operator-core/vitest.config.ts', 'packages/operator-core/vitest.integration.config.ts',
  'scripts/lib/isolated-runtime-start.mjs', 'scripts/lib/with-test-pg-cleanup.mjs',
  'scripts/lib/task-cgroup-limits.mjs', 'scripts/lib/task-cgroup-limits.d.mts',
  'scripts/source-preview.mjs', 'scripts/test-files.mjs',
  'scripts/qualify-sync-lint-proof.mjs', 'scripts/qualify-sync-lint-proof.d.mts',
  'libs/generic/tooldef/src/code-orchestration/run-script.ts',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], {
  encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

// Keep erased type edges, ESM imports and CommonJS loads distinct. Probing every
// ESM import with require.resolve admits inactive generated CJS exports.
function moduleEdges(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const declaration = /\.d\.[cm]?ts$/.test(path), edges = new Map();
  const staticMode = /\.cts$/.test(path) ? 'require' : 'import';
  const add = (literal, mode) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    if (declaration) mode = 'types';
    edges.set(mode + '\0' + literal.text, { spec: literal.text, mode });
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause, bindings = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || !clause?.name && bindings
        && ts.isNamedImports(bindings) && bindings.elements.length > 0
        && bindings.elements.every(element => element.isTypeOnly);
      add(node.moduleSpecifier, typeOnly ? 'types' : staticMode);
    } else if (ts.isExportDeclaration(node)) {
      const bindings = node.exportClause;
      const typeOnly = node.isTypeOnly || bindings && ts.isNamedExports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
      add(node.moduleSpecifier, typeOnly ? 'types' : staticMode);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly ? 'types' : 'require');
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, 'types');
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const resolver = ts.isPropertyAccessExpression(expression) && expression.name.text === 'resolve';
      const metaResolve = resolver && ts.isMetaProperty(expression.expression)
        && expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
      const requireResolve = resolver && ts.isIdentifier(expression.expression)
        && expression.expression.text === 'require';
      if (expression.kind === ts.SyntaxKind.ImportKeyword || metaResolve)
        add(node.arguments[0], 'import');
      else if (ts.isIdentifier(expression) && expression.text === 'require'
        || requireResolve) add(node.arguments[0], 'require');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...edges.values()];
}

function runtimeConditions(mode) {
  const custom = [...(process.execArgv.join(' ') + ' ' + (process.env.NODE_OPTIONS ?? ''))
    .matchAll(/(?:--conditions|-C)(?:=|\s+)([^\s]+)/g)].flatMap(match => match[1].split(','));
  const node = new Set(['node', 'node-addons', mode, ...custom]);
  // Both Node/tsx workers and Vitest load this proof. Vite's node resolver also
  // enables module and the current development/production condition.
  return mode === 'import' ? [node, new Set([...node, 'module',
    process.env.NODE_ENV === 'production' ? 'production' : 'development'])] : [node];
}

export function syncLintProofRoots(repo) {
  const source = ts.createSourceFile(integration, readFileSync(join(repo, integration), 'utf8'),
    ts.ScriptTarget.Latest, true);
  let declared;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'sourcePaths') {
      if (!node.initializer || !ts.isArrayLiteralExpression(node.initializer))
        throw new Error('P037 sourcePaths must remain an explicit array');
      declared = node.initializer.elements.map(element => {
        if (ts.isStringLiteral(element)) return element.text;
        if (ts.isIdentifier(element) && element.text === 'filePath') return integration;
        throw new Error('P037 sourcePaths contains an unmodelled computed input');
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!declared) throw new Error('P037 maintained sourcePaths declaration missing');
  return [...new Set([integration, ...declared, ...supplemental])].sort();
}

export function collectVerifierInputClosure(repo, roots) {
  repo = realpathSync(repo);
  const paths = new Set(), queue = [], imports = [], unresolved = [], workingHashes = {};
  const contained = path => path !== '..' && !path.startsWith('../') && !isAbsolute(path);
  const add = file => {
    const path = relative(repo, realpathSync(file)).split(sep).join('/');
    if (!contained(path) || path.split('/').includes('node_modules')) return false;
    if (!lstatSync(join(repo, path)).isFile()) throw new Error('input is not a regular file: ' + path);
    if (!paths.has(path)) {
      paths.add(path); queue.push(path);
      workingHashes[path] = hash(readFileSync(join(repo, path)));
    }
    return true;
  };
  for (const path of roots) {
    if (!path || !contained(path) || path.split('/').some(p => !p || p === '.' || p === '..')
      || !add(join(repo, path))) throw new Error('invalid verifier root: ' + path);
  }
  const config = join(repo, 'tsconfig.base.json');
  let options = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true, resolveJsonModule: true };
  if (existsSync(config)) {
    add(config);
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    options = { ...options, ...ts.convertCompilerOptionsFromJson(read.config.compilerOptions ?? {}, repo).options };
  }
  const cache = ts.createModuleResolutionCache(repo, path => path, options);
  const manifests = new Map();
  const runtimeExports = (spec, typed, mode) => {
    if (spec.startsWith('.') || isAbsolute(spec)) return { known: false, targets: [] };
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const subpath = '.' + spec.slice(name.length);
    let dir = dirname(realpathSync(typed));
    while (contained(relative(repo, dir))) {
      const manifestPath = join(dir, 'package.json');
      if (existsSync(manifestPath)) {
        if (!manifests.has(manifestPath)) manifests.set(manifestPath, JSON.parse(readFileSync(manifestPath, 'utf8')));
        const pkg = manifests.get(manifestPath);
        if (pkg.name === name) {
          // Installed third-party bytes are outside this source population;
          // package-lock is admitted separately. Do not turn optional installed
          // runtime artifacts into missing workspace-source edges.
          if (!add(manifestPath)) return { known: false, targets: [] };
          // Legacy subpaths use the TS-resolved file and its runtime companion,
          // not the package root's main entry or a nonexistent exports branch.
          if (!pkg.exports && subpath !== '.') return { known: false, targets: [] };
          let entry = pkg.exports, wildcard;
          if (entry && typeof entry === 'object' && Object.keys(entry).some(key => key.startsWith('.'))) {
            const key = Object.keys(entry).filter(key => key === subpath || key.includes('*')
              && subpath.startsWith(key.split('*')[0]) && subpath.endsWith(key.split('*')[1]))
              .sort((a, b) => Number(b === subpath) - Number(a === subpath)
                || b.split('*')[0].length - a.split('*')[0].length || b.length - a.length)[0];
            if (key?.includes('*')) wildcard = subpath.slice(key.split('*')[0].length,
              key.split('*')[1] ? -key.split('*')[1].length : undefined);
            entry = entry[key];
          } else if (subpath !== '.') entry = undefined;
          const select = (value, conditions) => {
            if (typeof value === 'string') return resolve(dir,
              wildcard === undefined ? value : value.replaceAll('*', wildcard));
            if (Array.isArray(value)) {
              for (const branch of value) { const target = select(branch, conditions); if (target) return target; }
            } else if (value && typeof value === 'object') {
              // Export conditions are ordered: default is a fallback at its
              // position, not another runtime to union with an earlier import.
              for (const [condition, branch] of Object.entries(value))
                if (condition === 'default' || conditions.has(condition)) {
                  const target = select(branch, conditions);
                  if (target !== undefined) return target;
                }
            }
            return value === null ? null : undefined;
          };
          const targets = runtimeConditions(mode).map(conditions => select(entry, conditions)).filter(Boolean);
          if (!pkg.exports) {
            if (subpath !== '.') targets.push(typed);
            else {
              targets.push(resolve(dir, pkg.main ?? 'index.js'));
              if (mode === 'import' && pkg.module) targets.push(resolve(dir, pkg.module));
            }
          }
          return { known: true, targets: [...new Set(targets)] };
        }
      }
      if (dir === repo) break;
      dir = dirname(dir);
    }
    return { known: false, targets: [] };
  };
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i], absolute = join(repo, from);
    // Manifests affect workspace exports and must be admitted along with source.
    let dir = dirname(absolute);
    while (contained(relative(repo, dir))) {
      if (existsSync(join(dir, 'package.json'))) { add(join(dir, 'package.json')); break; }
      if (dir === repo) break;
      dir = dirname(dir);
    }
    if (!/\.[cm]?[jt]sx?$/.test(from)) continue;
    const text = readFileSync(absolute, 'utf8');
    const require = createRequire(absolute);
    for (const { spec, mode } of moduleEdges(from, text)) {
      if (isBuiltin(spec)) continue;
      const targets = new Set();
      const typed = ts.resolveModuleName(spec, absolute, options, ts.sys, cache, undefined,
        mode === 'require' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
      if (typed) {
        targets.add(typed);
        if (mode !== 'types') {
          const runtime = runtimeExports(spec, typed, mode);
          if (runtime.known && !runtime.targets.length) unresolved.push({ from, spec });
          for (const target of runtime.targets) {
            if (existsSync(target) && lstatSync(target).isFile()) targets.add(target);
            else {
              // Node/tsx and Vite map package .js entrypoints to TS sources.
              const source = ts.resolveModuleName('./' + relative(dirname(typed), target), typed,
                options, ts.sys, cache, undefined,
                mode === 'require' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
              if (source && !/\.d\.[cm]?ts$/.test(source)) targets.add(source);
              else unresolved.push({ from, spec });
            }
          }
          const implementation = typed.replace(/\.d\.mts$/, '.mjs').replace(/\.d\.cts$/, '.cjs')
            .replace(/\.d\.ts$/, '.js');
          if (!runtime.known && implementation !== typed && existsSync(implementation)) targets.add(implementation);
        }
      }
      if (mode === 'require') {
        try { targets.add(require.resolve(spec)); } catch { /* Unresolved local edges refuse below. */ }
      }
      if (!targets.size && (spec.startsWith('.') || spec.startsWith('@papercusp/')))
        unresolved.push({ from, spec });
      for (const target of targets) {
        const local = add(target);
        imports.push({ from, spec, mode, path: relative(repo, realpathSync(target)).split(sep).join('/'), external: !local });
      }
    }
    // Configs hand setup/reporters to Vitest as paths rather than imports.
    const literals = /\bresolve\(\s*(?:__dirname|import\.meta\.dirname)\s*,\s*['"]([^'"\n]+)['"]\s*\)|\bnew\s+URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    for (const match of text.matchAll(literals)) {
      const file = resolve(dirname(absolute), match[1] ?? match[2]);
      if (existsSync(file) && lstatSync(file).isFile()) add(file);
    }
  }
  for (const path of ['package.json', 'package-lock.json']) if (existsSync(join(repo, path))) add(join(repo, path));
  return { roots: [...new Set(roots)].sort(), paths: [...paths].sort(), imports, unresolved, workingHashes };
}

export async function qualifySyncLintProofInputs({ repo, roots = syncLintProofRoots(repo) }) {
  const headStart = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const closure = collectVerifierInputClosure(repo, roots);
  let validationRefusal = null;
  try {
    if (closure.unresolved.length) throw new Error('unresolved local imports: ' + JSON.stringify(closure.unresolved));
    await validateVerifierInputs({ repo, ref: headStart, inputs: closure.paths });
  } catch (error) { validationRefusal = String(error); }
  const headAfter = git(repo, ['rev-parse', '--verify', 'HEAD']);
  const finalWorkingHashes = {}, finalReadErrors = {}, workingHashMismatches = [], workingDrift = [];
  for (const path of closure.paths) {
    try {
      const finalHash = hash(readFileSync(join(repo, path)));
      finalWorkingHashes[path] = finalHash;
      if (finalHash !== closure.workingHashes[path]) {
        workingHashMismatches.push(path);
        workingDrift.push(path);
      }
    } catch (error) {
      // An unreadable input is a refusal, not evidence that its bytes changed.
      // Retain it separately so a later successful read cannot erase the cause.
      finalWorkingHashes[path] = null;
      finalReadErrors[path] = { name: error?.name ?? 'Error', code: error?.code ?? null,
        message: error?.message ?? String(error) };
      workingDrift.push(path);
    }
  }
  const stabilityRefusal = headAfter !== headStart || workingDrift.length
    ? 'source changed during qualification' : null;
  const refusal = stabilityRefusal ?? validationRefusal;
  return { schemaVersion: 'p037-source-admission-v2', measuredAt: new Date().toISOString(),
    headStart, headAfter, ...closure, finalWorkingHashes, finalReadErrors, workingHashMismatches,
    workingDrift, validationRefusal, stabilityRefusal, refusal, qualification: refusal ? 'refused' : 'qualified' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--receipt') throw new Error('usage: node scripts/qualify-sync-lint-proof.mjs --receipt <new-json-path>');
  const receipt = await qualifySyncLintProofInputs({ repo: process.cwd() });
  writeFileSync(args[1], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('P037_CENSUS_SUMMARY ' + JSON.stringify({ qualification: receipt.qualification,
    headStart: receipt.headStart, headAfter: receipt.headAfter, roots: receipt.roots.length,
    paths: receipt.paths.length, unresolved: receipt.unresolved, workingDrift: receipt.workingDrift,
    workingHashMismatches: receipt.workingHashMismatches, finalReadErrors: receipt.finalReadErrors,
    validationRefusal: receipt.validationRefusal, stabilityRefusal: receipt.stabilityRefusal,
    refusal: receipt.refusal, receipt: resolve(args[1]) }));
  process.exitCode = receipt.qualification === 'qualified' ? 0 : 2;
}
