/** Generated verifier assets belong to the dependency generation, with their
 * producing inputs. Never manufacture build provenance while publishing an
 * already existing dist directory. Normal dependency-only generations remain
 * usable by release consumers; native consumers require a complete closure. */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECEIPT = '.papercusp-workspace-build.json';
const CLOSURE = '.verifier-closure.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error('verifier-generation:' + message); };
function safe(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..'))
    fail('unsafe-path:' + path);
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) fail('escaping-path:' + path);
  // Parent links would turn a private copy into a write through another tree.
  for (let parent = dirname(target); parent !== root; parent = dirname(parent))
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) fail('linked-parent:' + path);
  return target;
}
function identity(root, path) {
  const file = safe(root, path), stat = lstatSync(file);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(file);
    if (!realpathSync(file).startsWith(root + sep)) fail('escaping-input-link:' + path);
    return { path, link: target };
  }
  if (!stat.isFile()) fail('non-file:' + path);
  return { path, sha256: digest(readFileSync(file)), executable: Boolean(stat.mode & 0o111) };
}
function equal(a, b, message) {
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(message);
}
function files(root, rel) {
  const result = [];
  function walk(path) {
    const file = safe(root, path), stat = lstatSync(file);
    if (stat.isSymbolicLink()) fail('linked-output:' + path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) if (name !== RECEIPT) walk(path + '/' + name);
    } else result.push(identity(root, path));
  }
  walk(rel);
  return result;
}

// Conservatively bind the whole source census, including submodules and dirty
// files. A package build may bundle inputs outside its package (OMP does).
// This intentionally prefers a rebuild to guessing a compiler's import graph.
function sourcePaths(root) {
  const result = new Set();
  function visit(repo, prefix = '') {
    const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: repo, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
    for (const name of names) {
      const path = prefix + name;
      if (path.split('/').some(p => ['node_modules', 'dist', '.papercusp', '.next'].includes(p)
        || p.startsWith('.verifier-') || p.startsWith('.papercusp-'))) continue;
      const file = safe(root, path), stat = lstatSync(file);
      if (stat.isDirectory()) {
        if (existsSync(join(file, '.git'))) visit(file, path + '/');
        else fail('unknown-source-directory:' + path);
      } else result.add(path);
    }
  }
  visit(root);
  return [...result].sort();
}

export function buildInputs(root) {
  return sourcePaths(root).map(path => identity(root, path));
}

// Use the producing build's census so distinct frozen sources can share
// dependencies without replacing one another's native selector.
export function verifierInputFingerprint(root) {
  return digest(JSON.stringify(buildInputs(realpathSync(root))));
}

// A native publisher takes its source from an independently frozen checkout,
// never the moving integration tree. Check both tracked and untracked inputs;
// generated receipts and dependency/output directories are excluded by the same
// census used by the producing build.
export function checkSource(root, ref) {
  root = realpathSync(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  equal(realpathSync(git(['rev-parse', '--show-toplevel']).trim()), root, 'source-is-not-checkout-root');
  equal(git(['rev-parse', 'HEAD']).trim(), ref, 'source-ref-mismatch');
  const diff = spawnSync('git', ['diff', '--quiet', ref, '--'], { cwd: root });
  if (diff.error || diff.status !== 0) fail('dirty-verifier-source');
  const population = new Set(sourcePaths(root));
  for (const path of git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean))
    if (population.has(path)) fail('untracked-verifier-source:' + path);
}

export function buildWorkspace(root, packagePath, command) {
  root = realpathSync(root);
  const packageDir = safe(root, packagePath), output = packagePath + '/dist';
  const before = buildInputs(root);
  // Removing the prior output is essential: success cannot bless a stale file
  // which the producer did not emit in this invocation.
  rmSync(safe(root, output), { recursive: true, force: true });
  const result = spawnSync(command[0], command.slice(1), { cwd: packageDir, stdio: 'inherit' });
  if (result.error || result.status !== 0)
    fail('build-failed:' + packagePath + ':status=' + result.status + ':signal=' + result.signal
      + ':error=' + (result.error?.message ?? 'none'));
  equal(buildInputs(root), before, 'source-changed-during-build:' + packagePath);
  const outputs = files(root, output);
  if (!outputs.length) fail('empty-output:' + output);
  const receipt = { schema: 1, packagePath, inputs: before, outputs };
  const target = join(packageDir, 'dist', RECEIPT), tmp = target + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(receipt) + '\n');
  renameSync(tmp, target);
  return receipt;
}

function manifests(root) {
  // Requirements and producing inputs must describe the same source census.
  // A retained, gitignored candidate contains package.json files too, but is
  // output rather than another workspace requiring a native build receipt.
  return sourcePaths(root).filter(path => path === 'package.json' || path.endsWith('/package.json'));
}
function checkInputs(root, inputs) {
  if (!Array.isArray(inputs) || !inputs.length) fail('missing-build-inputs');
  for (const input of inputs) equal(identity(root, input.path), input, 'stale-build-input:' + input.path);
}
function checkWorkspace(root, entry, sourceRoot = root) {
  checkInputs(sourceRoot, entry.inputs);
  equal(files(root, entry.output), entry.outputs, 'stale-workspace-output:' + entry.output);
}

function workspaceRequirements(root) {
  const required = [];
  for (const path of manifests(root)) {
    const pkg = JSON.parse(readFileSync(join(root, path), 'utf8'));
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
    const targets = bins.filter(bin => typeof bin === 'string' && /^(\.\/)?dist\//.test(bin));
    if (!targets.length) continue;
    const packagePath = dirname(path), output = packagePath + '/dist';
    for (const target of targets) safe(root, packagePath + '/' + target.replace(/^\.\//, ''));
    // Tracked output already belongs to the independently verified source.
    // Git absence/errors never waive generated-output custody.
    const tracked = targets.every(target => spawnSync('git', ['ls-files', '--error-unmatch', '--', target],
      { cwd: join(root, packagePath), stdio: 'ignore' }).status === 0);
    if (!tracked) required.push({ path, packagePath, output, targets });
  }
  return required;
}

// Use the package's maintained build, and record provenance at the producing
// invocation. In particular, never stamp an existing dist with today's inputs.
export function buildClosure(root) {
  root = realpathSync(root);
  for (const { path, packagePath } of workspaceRequirements(root)) {
    const pkg = JSON.parse(readFileSync(safe(root, path), 'utf8'));
    if (!pkg.scripts?.build) fail('missing-workspace-build:' + path);
    buildWorkspace(root, packagePath, ['npm', 'run', 'build']);
  }
  const closure = captureClosure(root);
  if (!closure.complete) fail('rebuilt-closure-incomplete:' + closure.reason);
  return closure;
}

export function captureClosure(root) {
  root = realpathSync(root);
  const workspaces = [];
  try {
    for (const { path, packagePath, output, targets } of workspaceRequirements(root)) {
      const receipt = JSON.parse(readFileSync(safe(root, output + '/' + RECEIPT), 'utf8'));
      if (receipt.schema !== 1 || receipt.packagePath !== packagePath) fail('invalid-build-receipt:' + path);
      const entry = { output, inputs: receipt.inputs, outputs: receipt.outputs };
      checkWorkspace(root, entry);
      equal(buildInputs(root), receipt.inputs, 'build-source-population-changed:' + path);
      for (const bin of targets) {
        if (!receipt.outputs.some(file => file.path === packagePath + '/' + bin.replace(/^\.\//, '')))
          fail('missing-workspace-bin:' + path);
      }
      workspaces.push(entry);
    }
    const desktopPath = 'papercusp-desktop';
    let desktop = null;
    if (existsSync(join(root, desktopPath, 'package.json'))) {
      const locks = ['npm-shrinkwrap.json', 'package-lock.json'];
      const lock = locks.find(name => existsSync(join(root, desktopPath, name)));
      if (!lock || !existsSync(join(root, desktopPath, 'node_modules/.bin/tauri'))) fail('missing-desktop-closure');
      desktop = { manifest: identity(root, desktopPath + '/package.json'),
        lock: identity(root, desktopPath + '/' + lock) };
    }
    return { schema: 1, complete: true, workspaces, desktop };
  } catch (error) {
    // Do not break ordinary gate consumers when no native assets were built.
    // The refusal is identity-bound and native consumers must reject it.
    return { schema: 1, complete: false, reason: error.message, workspaces: [], desktop: null };
  }
}

export function verifyClosure(generation, sourceRoot, copy = false, materialized = false) {
  generation = realpathSync(generation); sourceRoot = realpathSync(sourceRoot);
  const closure = JSON.parse(readFileSync(join(generation, CLOSURE), 'utf8'));
  if (closure.schema !== 1 || closure.complete !== true || !Array.isArray(closure.workspaces)) {
    // The producer deliberately preserves incomplete closures for dependency-only
    // consumers. Keep its measured failure and selected identity visible when a
    // verifier refuses one, rather than making the next caller rediscover it.
    const reason = typeof closure.reason === 'string' ? closure.reason : 'invalid closure contract';
    fail('incomplete-closure:' + generation + ': ' + reason);
  }
  const tree = join(generation, 'tree');
  // The lock/patch selector alone cannot bind a source package's new bin.
  // Check the selected requirement census even when the producer had none.
  equal(workspaceRequirements(sourceRoot).map(row => row.output).sort(),
    closure.workspaces.map(row => row.output).sort(), 'workspace-requirements-mismatch');
  const population = closure.workspaces.length ? buildInputs(sourceRoot) : null;
  for (const entry of closure.workspaces) {
    if (!entry.output.endsWith('/dist')) fail('invalid-output-path');
    checkWorkspace(tree, entry, sourceRoot);
    if (materialized) checkWorkspace(sourceRoot, entry);
    equal(population, entry.inputs, 'selected-source-population-mismatch:' + entry.output);
  }
  const desktop = closure.desktop;
  if (existsSync(join(sourceRoot, 'papercusp-desktop/package.json'))) {
    if (!desktop) fail('missing-desktop-custody');
    for (const input of [desktop.manifest, desktop.lock])
      equal(identity(sourceRoot, input.path), input, 'desktop-lock-mismatch:' + input.path);
    if (!existsSync(join(tree, 'papercusp-desktop/node_modules/.bin/tauri'))) fail('missing-desktop-tree');
  }
  // Validate the entire contract before the first output mutation.
  if (copy) for (const entry of closure.workspaces) {
    const dest = safe(sourceRoot, entry.output);
    if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) fail('preexisting-output:' + entry.output);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(safe(tree, entry.output), dest, { recursive: true, dereference: false, force: false, errorOnExist: true });
    equal(files(sourceRoot, entry.output), entry.outputs, 'copied-output-mismatch:' + entry.output);
  }
  return closure;
}

function stageClosure(generation, sourceRoot) {
  const closure = JSON.parse(readFileSync(join(generation, CLOSURE), 'utf8'));
  if (!closure.complete) return;
  for (const entry of closure.workspaces) {
    checkWorkspace(sourceRoot, entry);
    const dest = safe(join(generation, 'tree'), entry.output);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(safe(sourceRoot, entry.output), dest, { recursive: true, dereference: false, errorOnExist: true, force: false });
  }
  verifyClosure(generation, sourceRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, dest] = process.argv.slice(2);
  try {
    if (command === 'capture') console.log(JSON.stringify(captureClosure(root)));
    else if (command === 'fingerprint') console.log(verifierInputFingerprint(root));
    else if (command === 'stage') stageClosure(root, dest);
    else if (command === 'verify' || command === 'copy' || command === 'verify-materialized')
      verifyClosure(root, dest, command === 'copy', command === 'verify-materialized');
    else if (command === 'build') buildWorkspace(root, dest, process.argv.slice(6));
    else if (command === 'check-source') checkSource(root, dest);
    else if (command === 'same-source') equal(buildInputs(root), buildInputs(dest), 'copied-source-mismatch');
    else if (command === 'build-closure') buildClosure(root);
    else fail('unknown-command');
  } catch (error) { console.error(error.message); process.exitCode = 74; }
}
