/** D-177's private execution binding. Reuses the release publisher's input and
 * tree fingerprints; npm's ephemeral hidden lock is deliberately not an input. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, open, readdir, readFile, realpath, type FileHandle } from 'node:fs/promises';
import { constants, readFileSync, type BigIntStats } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveOperatorAppRootFromModuleDir } from '../../operator-app-root';
import { bindFrozenDependencyGeneration, type DependencyLockEntry as LockEntry } from '../../dependency-generation-proof';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
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
  'packages/operator-core/lib/dependency-generation-proof.ts',
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
interface PackageRow { path: string; name: string; version: string; entry: LockEntry }
const safe = (path: string) => path.length > 0 && !path.startsWith('/')
  && !path.split('/').some(p => !p || p === '.' || p === '..') && !/[\x00-\x1f\\]/.test(path);

/** Miniflare writes tooling metadata, not an installed package. Admit only its
 * identified shape, and never expose its contents (including JSON parser errors).
 * The generation binder separately fingerprints these bytes before and after. */
async function assertMiniflareToolingCache(root: string, path: string) {
  const directory = join(root, path), parent = dirname(directory), member = join(directory, 'cf.json');
  const same = (a: BigIntStats, b: BigIntStats) =>
    (['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const).every(key => a[key] === b[key]);
  const exactMembers = async () => {
    const names = await readdir(directory);
    if (names.length !== 1 || names[0] !== 'cf.json') throw new Error();
  };
  let directoryHandle: FileHandle | undefined, fileHandle: FileHandle | undefined;
  try {
    const parentBefore = await lstat(parent, { bigint: true });
    const directoryBefore = await lstat(directory, { bigint: true });
    if (!parentBefore.isDirectory() || !directoryBefore.isDirectory()) throw new Error();
    directoryHandle = await open(directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!same(directoryBefore, await directoryHandle.stat({ bigint: true }))) throw new Error();
    await exactMembers();
    const fileBefore = await lstat(member, { bigint: true });
    if (!fileBefore.isFile() || fileBefore.nlink !== 1n) throw new Error();
    fileHandle = await open(member, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const assertIdentity = async () => {
      if (!same(parentBefore, await lstat(parent, { bigint: true })) ||
          !same(directoryBefore, await lstat(directory, { bigint: true })) ||
          !same(directoryBefore, await directoryHandle!.stat({ bigint: true })) ||
          !same(fileBefore, await lstat(member, { bigint: true })) ||
          !same(fileBefore, await fileHandle!.stat({ bigint: true }))) throw new Error();
    };
    await assertIdentity();
    const bytes = await fileHandle.readFile('utf8');
    await assertIdentity();
    await exactMembers();
    await assertIdentity();
    const value: unknown = JSON.parse(bytes);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  } catch {
    throw new Error(`invalid Miniflare tooling cache: ${path}`);
  } finally {
    await Promise.all([fileHandle?.close(), directoryHandle?.close()]);
  }
}

/** Package paths come from the complete generation tree census, including nested
 * installations. Workspace links bind to the committed link target's metadata. */
export async function readSeedInstalledPackages(root: string, trees: readonly string[],
  locks: readonly { path: string; packages: Record<string, LockEntry> }[],
  excludedEntries: SeedExcludedEntry[] = []): Promise<PackageRow[]> {
  const rootLock = locks.find(lock => lock.path === 'npm-shrinkwrap.json')
    ?? locks.find(lock => lock.path === 'package-lock.json');
  let workspaceDirs = new Set<string>();
  if (rootLock && Object.keys(rootLock.packages).some(path => path && !path.startsWith('node_modules/'))) {
    // Reuse the maintained lock census's workspace classification. Root entries
    // win over historical workspace-local locks; those locks can still bind a
    // physically installed nested dependency omitted from the root graph.
    // Dynamic URL import keeps this source-only helper independent of JS typings.
    const appRoot = resolveOperatorAppRootFromModuleDir(dirname(fileURLToPath(import.meta.url)));
    const censusUrl = pathToFileURL(resolve(appRoot, '../../scripts/check-lockfile-census.mjs'));
    const { rootWorkspaceDirs } = await import(censusUrl.href);
    workspaceDirs = rootWorkspaceDirs({ packages: rootLock.packages });
  }
  const expected = new Map<string, { entry: LockEntry; lock: typeof locks[number]; key: string;
    required: boolean }>();
  const installedTreePrefixes = trees.map(tree => `${tree}/`);
  for (const lock of [...locks].sort((a, b) => a.path.length - b.path.length)) {
    const supplemental = lock !== rootLock && workspaceDirs.has(posix.dirname(lock.path));
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
      if (supplemental && expected.has(path)) continue;
      // A subsumed local lock is evidence for an actual installed package, not
      // an obligation to install its vestigial graph. Never replace a root pin.
      expected.set(path, { entry, lock, key, required: !supplemental });
    }
  }
  const actual = new Map<string, PackageRow>();
  const exclude = async (path: string, metadataMode: 'optional' | 'required' | 'none' = 'optional') => {
    let metadata: { name?: unknown; version?: unknown } | undefined;
    try { if (metadataMode !== 'none') {
      const file = join(root, path, 'package.json');
      if (!(await lstat(file)).isFile()) throw new Error('excluded metadata must be a regular file');
      metadata = JSON.parse(await readFile(file, 'utf8'));
    } } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    // npm aliases retain the real package name in package.json; directory names
    // (and their reify leftovers) may differ. Report those exact metadata bytes.
    if (metadataMode === 'required' && (typeof metadata?.name !== 'string' || !metadata.name
        || typeof metadata.version !== 'string' || !metadata.version)) {
      throw new Error(`excluded reify entry metadata mismatch: ${path}`);
    }
    excludedEntries.push({ path, name: typeof metadata?.name === 'string' ? metadata.name : null,
      version: typeof metadata?.version === 'string' ? metadata.version : null });
  };
  const scan = async (nm: string) => {
    for (const name of (await readdir(join(root, nm))).sort()) {
      if (name.startsWith('.')) {
        if (name === '.mf') {
          const path = `${nm}/${name}`;
          await assertMiniflareToolingCache(root, path);
          await exclude(path, 'none'); continue;
        }
        const leftover = ROOT_TOOLING.has(name) ? null : REIFY_LEFTOVER.exec(name);
        if (!ROOT_TOOLING.has(name) && !leftover) throw new Error(`unknown hidden dependency entry: ${nm}/${name}`);
        await exclude(`${nm}/${name}`, leftover ? 'required' : 'optional'); continue;
      }
      const names: string[] = [];
      if (name.startsWith('@')) {
        for (const child of (await readdir(join(root, nm, name))).sort()) {
          if (!child.startsWith('.')) { names.push(`${name}/${child}`); continue; }
          const leftover = REIFY_LEFTOVER.exec(child);
          if (!leftover) throw new Error(`unknown hidden dependency entry: ${nm}/${name}/${child}`);
          await exclude(`${nm}/${name}/${child}`, 'required');
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
  for (const [path, { entry, required }] of expected) {
    if (!actual.has(path) && required && !entry.optional) throw new Error(`non-optional committed package missing: ${path}`);
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
  const binding = await bindFrozenDependencyGeneration(root, sourceCommit);
  const { trees, links, locks } = binding;
  const excludedEntries: SeedExcludedEntry[] = [];
  const packages = await readSeedInstalledPackages(root, trees, locks, excludedEntries);
  const linkTargets = await Promise.all(links.map(async path =>
    relative(root, await realpath(join(root, path))).split('\\').join('/')));
  const leftovers = excludedEntries.filter(entry => REIFY_LEFTOVER.test(posix.basename(entry.path))
    && !ROOT_TOOLING.has(posix.basename(entry.path)));
  // npm leftovers can retain their own bin links. Only inert links wholly inside
  // the same leftover are allowed: tooling/external aliases and cross-leftover
  // targets still fail, and the actual loaded-module census below is unchanged.
  assertSeedExcludedModules(excludedEntries, linkTargets.filter((target, index) =>
    !leftovers.some(entry => links[index].startsWith(entry.path + '/')
      && target.startsWith(entry.path + '/'))));
  const security = packages.filter(row => SECURITY_NAMES.has(row.name));
  for (const name of ['hypercore', 'hyperbee', 'hypercore-crypto', 'sodium-native', 'sodium-universal']) {
    if (!security.some(row => row.name === name)) throw new Error(`required security package missing: ${name}`);
  }
  const securityPackages = [];
  for (const row of security) securityPackages.push(await verifySeedSecurityPackage(root, row));
  assertSeedLoadedSecurityFiles(root, securityPackages, LOADED_SECURITY_FILES);
  await binding.assertUnchanged();
  const installedPackages = packages.map(({ path, name, version }) => ({ path, name, version }));
  const loadedModulePaths = options.readLoadedModulePaths?.() ?? [];
  assertSeedExcludedModules(excludedEntries, loadedModulePaths);
  return { ...binding.identity, installedPackages,
    excludedEntries, excludedEntryCount: excludedEntries.length, loadedModulePaths,
    installedPackagesSha256: hash(JSON.stringify(installedPackages)), securityPackages };
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
