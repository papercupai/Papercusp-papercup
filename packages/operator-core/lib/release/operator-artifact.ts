/** Release-host provenance, using the release-stage receipt pattern: a writer
 * binds source objects to built bytes; the booting process measures its own
 * entry independently. This is evidence only, never a green verdict. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { BgAcceptedManifest } from '../../../../scripts/source-preview.mjs';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const blob = (bytes: Buffer, objectLength: number) => createHash(objectLength === 64 ? 'sha256' : 'sha1')
  .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const normalized = (value: string) => value.length > 0 && !isAbsolute(value) && !value.includes('\\') &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

type GitRead = (root: string, args: string[]) => Promise<string>;
const gitRead: GitRead = (root, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout.trim());
  });
});

export interface OperatorArtifactManifest {
  schemaVersion: 1;
  sourceSha: string;
  entry: string;
  bundleSha256: string;
  sourceBlobs: Record<string, string>;
}
export type OperatorArtifactIdentity =
  | { status: 'measured'; sourceSha: string; bundleSha256: string; manifestSha256: string;
      sourceBlobs: Record<string, string>; evidenceRef: string }
  | { status: 'unknown'; reason: string };

/** Inherited attempt input, captured before candidate preparation. This is not
 * reconstructed from the candidate's artifact manifest at boot. */
export interface OperatorArtifactParentExpectation {
  sourceRoot: string;
  acceptedManifest: BgAcceptedManifest | null;
}

function verifyBootParentManifest(
  parent: OperatorArtifactParentExpectation, artifact: OperatorArtifactManifest,
  entry: string, existedBeforeNs: bigint,
): void {
  const expected = parent.acceptedManifest;
  if (!expected || typeof expected.evidenceRef !== 'string' || !expected.evidenceRef.trim() ||
    /^(?:unknown|absent|unresolved)$/i.test(expected.evidenceRef.trim())) throw Error('parent-authority-unknown');
  if (expected.schemaVersion !== 1) throw Error('parent-schema-mismatch');
  if (!DIGEST.test(expected.sha256)) throw Error('parent-digest-missing');
  if (!isAbsolute(parent.sourceRoot) || realpathSync(parent.sourceRoot) !== parent.sourceRoot ||
    !isAbsolute(expected.path) || realpathSync(expected.path) !== expected.path) throw Error('parent-path-invalid');
  // A candidate-local file cannot become the original parent's authority even
  // if its digest and source map happen to equal the accepted bytes.
  for (const root of [parent.sourceRoot, dirname(entry)]) {
    const rel = relative(root, expected.path);
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))) {
      throw Error('parent-authority-candidate-derived');
    }
  }
  const bytes = stableFile(expected.path, existedBeforeNs);
  if (bytes.length > 8 * 1024 * 1024 || hash(bytes) !== expected.sha256) throw Error('parent-digest-mismatch');
  const manifest = JSON.parse(bytes.toString('utf8')) as OperatorArtifactManifest;
  if (manifest.schemaVersion !== expected.schemaVersion) throw Error('parent-schema-mismatch');
  const members = expected.members;
  if (!members || typeof members !== 'object' || Array.isArray(members) || !Object.keys(members).length ||
    Object.entries(members).some(([path, sha]) => !normalized(path) || path.includes('\0') || !SHA.test(sha))) {
    throw Error('parent-members-invalid');
  }
  const equalMembers = (actual: unknown): boolean => {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const rows = Object.entries(actual);
    return rows.length === Object.keys(members).length && rows.every(([path, sha]) =>
      Object.hasOwn(members, path) && members[path] === sha);
  };
  if (!equalMembers(manifest.sourceBlobs) || !equalMembers(artifact.sourceBlobs)) throw Error('parent-members-mismatch');
  if (!stableFile(expected.path, existedBeforeNs).equals(bytes)) throw Error('parent-changed');
}

/** Capture before build and recheck after it. The release checkout is governed
 * by the existing deployment drain; a changing/dirty checkout cannot be stamped. */
export async function operatorArtifactSource(root: string, git: GitRead = gitRead): Promise<string> {
  const sha = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!SHA.test(sha) || await git(root, ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none'])) {
    throw new Error('operator-artifact-source-unqualified');
  }
  return sha;
}

function stableFile(file: string, existedBeforeNs?: bigint): Buffer {
  if (lstatSync(file).isSymbolicLink()) throw new Error('operator-artifact-symlink');
  const before = statSync(file, { bigint: true });
  if (!before.isFile() || before.size > 512n * 1024n * 1024n) throw new Error('operator-artifact-file-invalid');
  if (existedBeforeNs !== undefined && (before.mtimeNs > existedBeforeNs || before.ctimeNs > existedBeforeNs)) {
    throw new Error('operator-artifact-file-newer-than-process');
  }
  const bytes = readFileSync(file);
  const after = statSync(file, { bigint: true });
  const pin = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  if (pin(before) !== pin(after)) throw new Error('operator-artifact-file-changed');
  return bytes;
}

async function treeObjects(root: string, sha: string, git: GitRead): Promise<Map<string, { mode: string; sha: string }>> {
  const rows = (await git(root, ['ls-tree', '-rz', '--full-tree', sha])).split('\0').filter(Boolean);
  return new Map(rows.map(row => {
    const match = /^(\d+) (?:blob|commit) ([a-f0-9]{40,64})\t(.+)$/.exec(row);
    if (!match || !normalized(match[3]!)) throw Error('operator-artifact-tree-unreadable');
    return [match[3]!, { mode: match[1]!, sha: match[2]! }];
  }));
}

/** Called only after the maintained release build succeeds. Metafile inputs
 * identify the source population; each tracked input must equal its commit blob.
 * Dependencies under node_modules remain represented by the actual bundle bytes.
 * No caller receipt, checkout SHA alone, or development freshness stamp qualifies. */
export async function writeOperatorArtifactManifest(input: {
  root: string; entry: string; sourceSha: string;
}, git: GitRead = gitRead): Promise<OperatorArtifactIdentity> {
  const root = realpathSync(input.root);
  const entry = realpathSync(input.entry);
  const entryRelative = relative(root, entry);
  if (existsSync(resolve(dirname(entry), '.bundle-stale.json'))) throw Error('operator-artifact-stale-build');
  if (!normalized(entryRelative) || !SHA.test(input.sourceSha) || await operatorArtifactSource(root, git) !== input.sourceSha) {
    throw new Error('operator-artifact-source-moved');
  }
  const bytes = stableFile(entry);
  const meta = JSON.parse(stableFile(entry + '.meta.json').toString('utf8'));
  if (!meta.inputs || typeof meta.inputs !== 'object' || Array.isArray(meta.inputs)) throw new Error('operator-artifact-inputs-missing');
  const sourceBlobs: Record<string, string> = {};
  const trees = new Map([['', await treeObjects(root, input.sourceSha, git)]]);
  const sourceBlob = async (rel: string): Promise<string | undefined> => {
    let prefix = '';
    for (;;) {
      const tree = trees.get(prefix)!;
      const local = rel.slice(prefix.length);
      const exact = tree.get(local);
      if (exact) return exact.mode === '100644' || exact.mode === '100755' ? exact.sha : undefined;
      const nested = [...tree].find(([path, object]) => object.mode === '160000' && local.startsWith(path + '/'));
      if (!nested) return undefined;
      prefix += nested[0] + '/';
      if (!trees.has(prefix)) trees.set(prefix, await treeObjects(resolve(root, prefix), nested[1].sha, git));
    }
  };
  // bundle_host_esbuild's package-cache reader executes at the repository
  // root, including when deploy-deps starts bundle-host.sh in apps/operator.
  const buildRoot = root;
  for (const name of Object.keys(meta.inputs).sort()) {
    if (name.startsWith('<') || name.startsWith('node:')) continue;
    const path = resolve(buildRoot, name);
    const rel = relative(root, path);
    if (!normalized(rel)) throw new Error('operator-artifact-input-outside-source');
    if (rel.split('/').includes('node_modules')) continue;
    if (realpathSync(path) !== path) throw new Error('operator-artifact-input-outside-source');
    const expected = await sourceBlob(rel);
    if (!expected || blob(stableFile(path), expected.length) !== expected) throw new Error('operator-artifact-input-mismatch');
    sourceBlobs[rel] = expected;
  }
  if (!Object.keys(sourceBlobs).length) throw new Error('operator-artifact-inputs-empty');
  if (await operatorArtifactSource(root, git) !== input.sourceSha || !stableFile(entry).equals(bytes)) {
    throw new Error('operator-artifact-build-changed');
  }
  const bundleSha256 = hash(bytes);
  const manifest: OperatorArtifactManifest = { schemaVersion: 1, sourceSha: input.sourceSha,
    entry: entryRelative, bundleSha256, sourceBlobs };
  const body = JSON.stringify(manifest);
  const file = entry + '.artifact-' + bundleSha256 + '.json';
  try { writeFileSync(file, body, { flag: 'wx', mode: 0o644 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || stableFile(file).toString('utf8') !== body) throw error;
  }
  return { status: 'measured', sourceSha: manifest.sourceSha, bundleSha256,
    manifestSha256: hash(body), sourceBlobs, evidenceRef: file };
}

/** Take once during process boot, before accepting requests. The caller passes
 * the SHA baked into this process, never the current checkout HEAD. The return
 * value is a boot snapshot; repeatedly hashing a replaced file would mislabel
 * an older process with newer bytes. Missing legacy manifests stay unknown. */
export function measureBootOperatorArtifact(
  entry: string, bakedSourceSha: string | null, processStartedAtMs = performance.timeOrigin,
  parent?: OperatorArtifactParentExpectation,
): OperatorArtifactIdentity {
  try {
    if (!Number.isFinite(processStartedAtMs) || processStartedAtMs <= 0) throw Error('unidentified-process-start');
    const existedBeforeNs = BigInt(Math.floor(processStartedAtMs)) * 1_000_000n;
    if (!bakedSourceSha || !/^(?:[a-f0-9]{7,40}|[a-f0-9]{64})$/.test(bakedSourceSha)) throw Error('unidentified-build');
    const actualEntry = realpathSync(entry);
    if (actualEntry !== resolve(entry)) throw Error('symlink-entry');
    if (existsSync(resolve(dirname(actualEntry), '.bundle-stale.json'))) throw Error('stale-build');
    // A matching file on disk could have replaced the file Node loaded. Its
    // inode change/modify times must predate this process's time origin, and
    // remain stable across the read. Timestamp restoration cannot hide ctime.
    const bytes = stableFile(actualEntry, existedBeforeNs);
    const bundleSha256 = hash(bytes);
    const file = actualEntry + '.artifact-' + bundleSha256 + '.json';
    const raw = stableFile(file, existedBeforeNs);
    if (raw.length > 8 * 1024 * 1024) throw Error('oversized-manifest');
    const m = JSON.parse(raw.toString('utf8')) as OperatorArtifactManifest;
    if (m.schemaVersion !== 1 || !SHA.test(m.sourceSha) || !m.sourceSha.startsWith(bakedSourceSha) ||
      !DIGEST.test(m.bundleSha256) || m.bundleSha256 !== bundleSha256 || !normalized(m.entry) ||
      !actualEntry.endsWith('/' + m.entry) ||
      !m.sourceBlobs || typeof m.sourceBlobs !== 'object' || Array.isArray(m.sourceBlobs) ||
      !Object.keys(m.sourceBlobs).length || Object.entries(m.sourceBlobs).some(([path, sha]) => !normalized(path) || !SHA.test(sha))) {
      throw Error('manifest-mismatch');
    }
    if (parent !== undefined) verifyBootParentManifest(parent, m, actualEntry, existedBeforeNs);
    if (!stableFile(actualEntry, existedBeforeNs).equals(bytes)) throw Error('entry-changed');
    return { status: 'measured', sourceSha: m.sourceSha, bundleSha256, manifestSha256: hash(raw),
      sourceBlobs: { ...m.sourceBlobs }, evidenceRef: file };
  } catch {
    return { status: 'unknown', reason: 'release-artifact-unavailable-or-mismatched' };
  }
}
