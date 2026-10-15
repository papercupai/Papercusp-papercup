/** D-177's private execution binding. Reuses the release publisher's input and
 * tree fingerprints; npm's ephemeral hidden lock is deliberately not an input. */
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, posix } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveOperatorAppRootFromModuleDir } from '../../operator-app-root';

// Pure census helpers may be imported under a synchronous-only subprocess mock.
// Reuse git-batch's typed memoized wrapper; promisify only when shell is called.
let execMemo: typeof execFile.__promisify__ | null = null;
const exec = ((...args: unknown[]) =>
  Reflect.apply((execMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const HEX = /^[0-9a-f]{64}$/;
const SECURITY_NAMES = new Set(['hypercore', 'hyperbee', 'hypercore-crypto',
  'sodium-native', 'sodium-universal', 'sodium-javascript']);
// The provider imports Corestore before this module. Hash the security modules
// already loaded at this point, including sodium's native addon; restored files
// on disk cannot authorize stale code in a long-lived runtime.
const LOADED_SECURITY_FILES = Object.keys(typeof import.meta.url === 'string' ? createRequire(import.meta.url).cache : {})
  .filter(path => [...SECURITY_NAMES].some(name => path.includes(`/node_modules/${name}/`)))
  .map(path => ({ path, sha256: hash(readFileSync(path)) }));
export const SEED_EXECUTION_PATHS = ['packages/operator-core/lib/sync/hyperbee/read-merge.ts',
  'packages/operator-core/lib/sync/hyperbee/log-snapshot.ts',
  'packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts',
  'apps/operator/lib/release/cut-seed-cli.ts',
  'packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts',
  'packages/operator-core/lib/sync/hyperbee/hive-epoch-aead.ts',
  'apps/operator/bin/release/dependency-generation.sh',
  'scripts/check-lockfile-census.mjs',
  'packages/operator-core/lib/sync/hyperbee/seed-module-census.mjs'];

export interface SeedExcludedEntry { path: string; name: string | null; version: string | null }
const REIFY_LEFTOVER = /^\.(.+)-[A-Za-z0-9]{8}$/;
const ROOT_TOOLING = new Set(['.bin', '.cache', '.vite', '.vite-temp', '.astro', '.pnpm', '.store',
  '.package-lock.json', '.papercusp-isolated-snapshot', '.papercusp-dependency-generation',
  '.papercusp-source-package-lock.json']);

export interface SeedFrozenExecution {
  sourceCommit: string;
  gitDirty: false;
  nodeVersion: string;
  dependencyInputSha256: string;
  installedPackagesSha256: string;
  installedPackages: { path: string; name: string; version: string }[];
  excludedEntries: SeedExcludedEntry[];
  excludedEntryCount: number;
  loadedModulePaths: string[];
  dependencyGeneration: string;
  dependencyGenerationSnapshotSha256: string;
  materializedTreesSha256: string;
  securityPackages: { path: string; name: string; version: string; resolved: string;
    integrity: string; files: { path: string; sha256: string }[] }[];
  directBlobs: { path: string; sha256: string }[];
}
interface LockEntry { name?: string; version?: string; link?: boolean; optional?: boolean;
  resolved?: string; integrity?: string }
interface PackageRow { path: string; name: string; version: string; entry: LockEntry }

async function shell(root: string, script: string, ...args: string[]) {
  const result = await exec('bash', ['-euo', 'pipefail', '-c',
    'source "$1"; shift; ' + script, 'seed-frozen-execution',
    join(root, 'apps/operator/bin/release/dependency-generation.sh'), ...args],
  { maxBuffer: 64 * 1024 * 1024 });
  return result.stdout.trimEnd();
}
function fields(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.trim().split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0 || result.has(line.slice(0, at))) throw new Error('invalid dependency marker');
    result.set(line.slice(0, at), line.slice(at + 1));
  }
  return result;
}
const safe = (path: string) => path.length > 0 && !path.startsWith('/')
  && !path.split('/').some(p => !p || p === '.' || p === '..') && !/[\x00-\x1f\\]/.test(path);

/** Package paths come from the complete generation tree census, including nested
 * installations. Workspace links bind to the committed link target's metadata. */
export async function readSeedInstalledPackages(root: string, trees: readonly string[],
  locks: readonly { path: string; packages: Record<string, LockEntry> }[],
  excludedEntries: SeedExcludedEntry[] = []): Promise<PackageRow[]> {
  const rootLock = locks.find(lock => lock.path === 'npm-shrinkwrap.json')
    ?? locks.find(lock => lock.path === 'package-lock.json');
  let workspaceDirs = new Set<string>();
  if (rootLock && Object.keys(rootLock.packages).some(path => path && !path.startsWith('node_modules/'))) {
    // Reuse the maintained lock census's authority rule: a root workspace's
    // historical local lock is subsumed, including its package-local installs.
    // Dynamic URL import keeps this source-only helper independent of JS typings.
    const appRoot = resolveOperatorAppRootFromModuleDir(dirname(fileURLToPath(import.meta.url)));
    const censusUrl = pathToFileURL(resolve(appRoot, '../../scripts/check-lockfile-census.mjs'));
    const { rootWorkspaceDirs } = await import(censusUrl.href);
    workspaceDirs = rootWorkspaceDirs({ packages: rootLock.packages });
  }
  const expected = new Map<string, { entry: LockEntry; lock: typeof locks[number]; key: string }>();
  const installedTreePrefixes = trees.map(tree => `${tree}/`);
  for (const lock of [...locks].sort((a, b) => a.path.length - b.path.length)) {
    if (lock !== rootLock && workspaceDirs.has(posix.dirname(lock.path))) continue;
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.includes('node_modules/')) continue;
      if (!safe(key)) throw new Error('invalid committed package path');
      const path = posix.join(posix.dirname(lock.path), key);
      // The generation manifest can include standalone package locks whose
      // node_modules tree is deliberately not materialized (for example, a local
      // docs viewer). The census population is the published tree list, so those
      // locks remain fingerprinted inputs without becoming installed-package
      // obligations. Entries inside any published tree still require an exact
      // lock match below.
      if (!installedTreePrefixes.some(prefix => path.startsWith(prefix))) continue;
      expected.set(path, { entry, lock, key });
    }
  }
  const actual = new Map<string, PackageRow>();
  const exclude = async (path: string, requireMetadata = false) => {
    let metadata: { name?: unknown; version?: unknown } | undefined;
    try {
      const file = join(root, path, 'package.json');
      if (!(await lstat(file)).isFile()) throw new Error('excluded metadata must be a regular file');
      metadata = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    // npm aliases retain the real package name in package.json; directory names
    // (and their reify leftovers) may differ. Report those exact metadata bytes.
    if (requireMetadata && (typeof metadata?.name !== 'string' || !metadata.name
        || typeof metadata.version !== 'string' || !metadata.version)) {
      throw new Error(`excluded reify entry metadata mismatch: ${path}`);
    }
    excludedEntries.push({ path, name: typeof metadata?.name === 'string' ? metadata.name : null,
      version: typeof metadata?.version === 'string' ? metadata.version : null });
  };
  const scan = async (nm: string) => {
    for (const name of (await readdir(join(root, nm))).sort()) {
      if (name.startsWith('.')) {
        const leftover = ROOT_TOOLING.has(name) ? null : REIFY_LEFTOVER.exec(name);
        if (!ROOT_TOOLING.has(name) && !leftover) throw new Error(`unknown hidden dependency entry: ${nm}/${name}`);
        await exclude(`${nm}/${name}`, Boolean(leftover)); continue;
      }
      const names: string[] = [];
      if (name.startsWith('@')) {
        for (const child of (await readdir(join(root, nm, name))).sort()) {
          if (!child.startsWith('.')) { names.push(`${name}/${child}`); continue; }
          const leftover = REIFY_LEFTOVER.exec(child);
          if (!leftover) throw new Error(`unknown hidden dependency entry: ${nm}/${name}/${child}`);
          await exclude(`${nm}/${name}/${child}`, true);
        }
      } else names.push(name);
      for (const name of names) {
        const path = `${nm}/${name}`;
        const found = expected.get(path);
        if (!found) throw new Error(`installed package has no committed lock entry: ${path}`);
        const metadata = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
        const entry = found.entry.link ? found.lock.packages[found.entry.resolved ?? ''] : found.entry;
        const expectedName = entry?.name ?? name;
        if (!entry?.version || metadata.name !== expectedName || metadata.version !== entry.version) {
          throw new Error(`installed package name/version mismatch: ${path}`);
        }
        const linked = (await lstat(join(root, path))).isSymbolicLink();
        if (linked !== !!found.entry.link || (linked &&
            await realpath(join(root, path)) !== resolve(root, dirname(found.lock.path), found.entry.resolved ?? ''))) {
          throw new Error(`installed package link mismatch: ${path}`);
        }
        actual.set(path, { path, name: metadata.name, version: metadata.version, entry: found.entry });
        if (!linked) {
          try { await lstat(join(root, path, 'node_modules')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          await scan(`${path}/node_modules`);
        }
      }
    }
  };
  for (const tree of trees) await scan(tree);
  for (const [path, { entry }] of expected) {
    if (!actual.has(path) && !entry.optional) throw new Error(`non-optional committed package missing: ${path}`);
  }
  excludedEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return [...actual.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** The preload sees ESM and CommonJS loads; require.cache also names native addons. */
export function readSeedLoadedModulePaths(root: string): string[] {
  const tracker = (globalThis as unknown as Record<symbol, { preloadPath: string; paths: Set<string> } | undefined>)
    [Symbol.for('papercusp.seed-module-census')];
  if (!tracker || tracker.preloadPath !== join(root, SEED_EXECUTION_PATHS.at(-1)!)) {
    throw new Error('complete seed module census preload required');
  }
  const cache = createRequire(import.meta.url).cache;
  return [...new Set([...tracker.paths, ...Object.keys(cache)].map(path => {
    const rel = relative(root, path).split('\\').join('/');
    if (!safe(rel)) throw new Error('loaded seed module outside frozen source');
    return rel;
  }))].sort();
}

export function assertSeedExcludedModules(excluded: readonly SeedExcludedEntry[], paths: readonly string[]) {
  if (paths.some(path => excluded.some(entry => path === entry.path || path.startsWith(entry.path + '/')))) {
    throw new Error('loaded module reaches an excluded dependency entry');
  }
}

/** D-151(a)'s sha512 archive -> same-member sha256 chain. Verify a superset of
 * executed files: every regular installed file, including native prebuilds. */
export async function verifySeedSecurityPackage(root: string, row: PackageRow,
  fetchArchive: (url: string) => Promise<Buffer> = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
    if (!response.ok) throw new Error(`security package archive HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }): Promise<SeedFrozenExecution['securityPackages'][number]> {
  const { resolved, integrity } = row.entry;
  if (!resolved || new URL(resolved).protocol !== 'https:' || !integrity ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error(`security package lacks committed sha512/resolved identity: ${row.path}`);
  const bytes = await fetchArchive(resolved);
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) {
    throw new Error(`security package archive integrity mismatch: ${row.path}`);
  }
  // stdlib tarfile handles npm/PAX archives without extracting untrusted paths.
  const archive = JSON.parse(execFileSync('python3', ['-c',
    'import sys,io,tarfile,json,hashlib\n' +
    'with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()),mode="r:gz") as t:\n' +
    ' rows=t.getmembers(); meta=[m for m in rows if len(m.name.split("/"))==2 and m.name.endswith("/package.json")]\n' +
    ' assert len(meta)==1 and meta[0].isfile(), "unique regular package metadata required"\n' +
    ' prefix=meta[0].name.split("/")[0]+"/"; out={}\n' +
    ' assert prefix[:-1] not in ("", ".", ".."), "unsafe archive root"\n' +
    ' for m in rows:\n' +
    '  assert m.name.startswith(prefix) or m.name==prefix[:-1], "archive path outside package"\n' +
    '  if m.isdir(): continue\n' +
    '  p=m.name[len(prefix):]\n' +
    '  assert m.isfile() and p not in out and all(x not in ("", ".", "..") for x in p.split("/")), "unsafe or duplicate archive member"\n' +
    '  out[p]=hashlib.sha256(t.extractfile(m).read()).hexdigest()\n' +
    ' print(json.dumps(out))'], { input: bytes, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as Record<string, string>;
  const files: { path: string; sha256: string }[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(join(root, row.path, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (!safe(path) || entry.isSymbolicLink()) throw new Error('unsafe installed security package member');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const digest = hash(await readFile(join(root, row.path, path)));
        if (archive[path] !== digest) throw new Error(`security package file integrity mismatch: ${row.path}/${path}`);
        files.push({ path, sha256: digest });
      } else throw new Error('non-regular security package member');
    }
  };
  await walk('');
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.some(file => file.path === 'package.json')) throw new Error('security package metadata missing');
  return { path: row.path, name: row.name, version: row.version, resolved, integrity, files };
}

/** Called identically immediately before/after census and before the producer.
 * Copies have different inodes: verify the publication's exact fingerprint AND
 * compare copies using the publisher's existing copy-normalized record projection. */
export async function bindSeedFrozenDependencies(root: string, sourceCommit: string,
  options: { readLoadedModulePaths?: () => string[] } = {}) {
  const marker = fields(await readFile(join(root, 'node_modules/.papercusp-dependency-generation'), 'utf8'));
  const dependencyGeneration = marker.get('identity') ?? '';
  if (!/^v1-[0-9a-f]{64}$/.test(dependencyGeneration)) throw new Error('invalid frozen dependency generation');
  const generationRoot = await shell(root, 'dependency_generation_resolve_root "$1"', root);
  const generation = join(generationRoot, dependencyGeneration);
  const dependencyInputSha256 = await shell(root, 'dependency_generation_input_fingerprint_ref "$1" "$2"', root, sourceCommit);
  if (!HEX.test(dependencyInputSha256)) throw new Error('invalid committed dependency input fingerprint');
  const selector = fields(await readFile(join(generationRoot, '.inputs', dependencyInputSha256), 'utf8'));
  const publication = fields(await readFile(join(generation, '.papercusp-dependency-generation'), 'utf8'));
  if (selector.get('input') !== dependencyInputSha256 || selector.get('identity') !== dependencyGeneration ||
      publication.get('identity') !== dependencyGeneration || publication.get('scope') !== 'full' ||
      marker.get('source') !== publication.get('source')) throw new Error('frozen dependency input/generation mismatch');
  await shell(root, 'dependency_generation_select_prevalidated "$1" "$2" "$3"', generationRoot,
    dependencyGeneration, selector.get('token') ?? '');
  const assertSnapshot = async () => {
    const result = await shell(root, 'dependency_generation_set_fingerprint "$1"', join(generation, 'tree'));
    if (!HEX.test(result) || result !== publication.get('snapshot')) throw new Error('published dependency generation drift');
    return result;
  };
  const dependencyGenerationSnapshotSha256 = await assertSnapshot();
  const trees = (await shell(root, 'dependency_generation_enumerate_node_modules "$1"', join(generation, 'tree')))
    .split('\n').filter(Boolean).map(path => relative(join(generation, 'tree'), path).split('\\').join('/')).sort();
  if (!trees.includes('node_modules') || trees.some(tree => !safe(tree))) throw new Error('invalid generation tree census');
  const materialized = (await shell(root, 'dependency_generation_enumerate_node_modules "$1"', root))
    .split('\n').filter(Boolean).map(path => relative(root, path).split('\\').join('/')).sort();
  if (JSON.stringify(trees) !== JSON.stringify(materialized)) throw new Error('materialized generation tree census mismatch');
  const projection = async (tree: string) => shell(root,
    'record=$(mktemp); trap \'rm -f "$record" "$record.unsorted"\' EXIT; ' +
    'dependency_generation_source_records "$1" "$record"; ' +
    'dependency_generation_records_projection "$record" | ' +
    'awk -F "\\t" \'$1 != ".papercusp-dependency-generation" && $1 != ".papercusp-source-package-lock.json"\'', tree);
  const projections: [string, string][] = [];
  const links: string[] = [];
  for (const tree of trees) {
    const isolated = fields(await readFile(join(root, tree, '.papercusp-isolated-snapshot'), 'utf8'));
    if (isolated.get('generation') !== dependencyGeneration) throw new Error('materialized dependency pin mismatch');
    const original = await projection(join(generation, 'tree', tree));
    if (await projection(join(root, tree)) !== original) throw new Error(`materialized dependency tree drift: ${tree}`);
    projections.push([tree, hash(original)]);
    for (const line of original.split('\n')) {
      const [path, kind] = line.split('\t');
      if (kind === 'l') links.push(posix.join(tree, path));
    }
  }
  const manifest = await shell(root, 'dependency_generation_input_manifest_ref "$1" "$2" | LC_ALL=C sort', root, sourceCommit);
  const locks: { path: string; packages: Record<string, LockEntry> }[] = [];
  for (const line of manifest.split('\n')) {
    const [path, digest] = line.split('\t');
    if (!safe(path) || !HEX.test(digest)) throw new Error('invalid committed dependency manifest');
    const bytes = await readFile(join(root, path));
    if (hash(bytes) !== digest) throw new Error('committed dependency input changed');
    if (/\/(package-lock|npm-shrinkwrap)\.json$/.test('/' + path)) {
      const lock = JSON.parse(bytes.toString());
      if (!lock.packages || typeof lock.packages !== 'object') throw new Error('committed lock packages map required');
      locks.push({ path, packages: lock.packages });
    }
  }
  const excludedEntries: SeedExcludedEntry[] = [];
  const packages = await readSeedInstalledPackages(root, trees, locks, excludedEntries);
  const linkTargets = await Promise.all(links.map(async path =>
    relative(root, await realpath(join(root, path))).split('\\').join('/')));
  assertSeedExcludedModules(excludedEntries, linkTargets);
  const security = packages.filter(row => SECURITY_NAMES.has(row.name));
  for (const name of ['hypercore', 'hyperbee', 'hypercore-crypto', 'sodium-native', 'sodium-universal']) {
    if (!security.some(row => row.name === name)) throw new Error(`required security package missing: ${name}`);
  }
  const securityPackages = [];
  for (const row of security) securityPackages.push(await verifySeedSecurityPackage(root, row));
  assertSeedLoadedSecurityFiles(root, securityPackages, LOADED_SECURITY_FILES);
  await assertSnapshot();
  for (const [tree, digest] of projections) {
    if (hash(await projection(join(root, tree))) !== digest) throw new Error('materialized dependency tree changed while binding');
  }
  const installedPackages = packages.map(({ path, name, version }) => ({ path, name, version }));
  const loadedModulePaths = options.readLoadedModulePaths?.() ?? [];
  assertSeedExcludedModules(excludedEntries, loadedModulePaths);
  return { dependencyInputSha256, dependencyGeneration, dependencyGenerationSnapshotSha256, installedPackages,
    excludedEntries, excludedEntryCount: excludedEntries.length, loadedModulePaths,
    installedPackagesSha256: hash(JSON.stringify(installedPackages)),
    materializedTreesSha256: hash(JSON.stringify(projections)), securityPackages };
}

export function assertSeedLoadedSecurityFiles(root: string, packages: SeedFrozenExecution['securityPackages'],
  loaded: readonly { path: string; sha256: string }[]) {
  for (const file of loaded) {
    const path = relative(root, file.path).split('\\').join('/');
    const row = packages.filter(p => path.startsWith(p.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
    if (!row || row.files.find(f => `${row.path}/${f.path}` === path)?.sha256 !== file.sha256) {
      throw new Error('loaded security module does not match frozen package files');
    }
  }
}
