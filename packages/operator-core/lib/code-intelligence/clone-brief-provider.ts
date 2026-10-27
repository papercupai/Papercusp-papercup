/** P010: source-checked copy advice at the shared provider seam. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildCloneIndex, extractCloneFile, CLONE_MAX_SOURCE_BYTES } from './clone-index';
import { peekPushSnapshot, safeSnapshotPath, type PushSnapshot } from './push-snapshot';
import type { ReuseBriefProvider, ReuseProviderContext } from './reuse-brief-providers';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const run = promisify(execFile);
const eligible = (path: string) => safeSnapshotPath(path) && /\.tsx?$/.test(path);

/** The inventory is candidate discovery only. Every emitted location is parsed
 * again from current, confined bytes, including untouched siblings. */
export function cloneBriefProvider(deps: { snapshot?: () => PushSnapshot | null } = {}): ReuseBriefProvider {
  return { id: 'clones', async read(ctx, signal) {
    const unknown = () => ({ status: 'unknown' as const, lines: [], sourceVersion: null, indexVersion: null });
    if (!ctx.repository || ctx.repository.workspaceId !== ctx.workspaceId || !ctx.sourceVersion || !ctx.sourceFiles?.length) return unknown();
    if (hash(JSON.stringify(ctx.sourceFiles.map(file => [file.path, file.sha256]))) !== ctx.sourceVersion) return unknown();
    const root = await realpath(ctx.repository.rootPath);
    const snapshot = (deps.snapshot ?? (() => peekPushSnapshot(ctx.repository!.harness ?? 'papercusp')))();
    const baseline = snapshot?.commit ?? ctx.commit;
    const paths = new Set(ctx.sourceFiles.filter(file => eligible(file.path)).map(file => file.path));
    if (!paths.size || paths.size > 50) return unknown();
    // A missing inventory cannot establish a repository-wide absence. Current
    // scoped files can still expose copies of each other.
    for (const path of [...paths]) for (const note of snapshot?.cloneFiles?.get(path)?.notes ?? []) {
      for (const source of note.sources) if (eligible(source.path)) paths.add(source.path);
    }
    // Small inventories can be rechecked completely, including a newly planted
    // copy that did not belong to any prepared family yet.
    if (snapshot?.cloneFiles && snapshot.cloneFiles.size <= 64) {
      for (const path of snapshot.cloneFiles.keys()) if (eligible(path)) paths.add(path);
    }
    if (paths.size > 64) return unknown();
    const sources = new Map<string, string>();
    let bytes = 0;
    const capture = async (path: string) => {
      signal.throwIfAborted();
      if (!eligible(path)) throw new Error('Invalid clone source');
      const file = await realpath(resolve(root, path)), rel = relative(root, file);
      if (isAbsolute(rel) || rel.startsWith('../') || rel !== path) throw new Error('Clone source escapes repository');
      const size = (await stat(file)).size;
      if (size > CLONE_MAX_SOURCE_BYTES || bytes + size > 2_000_000) throw new Error('Clone source budget exceeded');
      const source = await readFile(file, { encoding: 'utf8', signal });
      bytes += Buffer.byteLength(source);
      if (bytes > 2_000_000) throw new Error('Clone source grew beyond budget');
      return source;
    };
    for (const path of [...paths].sort()) sources.set(path, await capture(path));
    if (ctx.sourceFiles.some(file => eligible(file.path) && hash(sources.get(file.path)!) !== file.sha256)) return unknown();
    const index = buildCloneIndex([...sources].map(([path, source]) => ({ path, source })));
    if (index.getFiles().some(file => file.status !== 'indexed')) return unknown();
    const lines: string[] = [], citedPaths = new Set<string>();
    const targets = new Set(ctx.paths);
    for (const family of index.families('renamed', { crossFile: false })) {
      const touched = family.members.filter(fn => targets.has(fn.path));
      if (!touched.length) continue;
      const siblings = family.members.filter(fn => !targets.has(fn.path));
      for (const fn of siblings.slice(0, 2)) {
        lines.push(`${ctx.surface === 'completion' ? 'Untouched sibling' : 'Copy family'} ${fn.path}:${fn.line} ${fn.name}; static match, review before reuse.`);
        citedPaths.add(fn.path);
      }
      // "New" requires an actual historical source, not a missing cache entry.
      if (ctx.surface === 'completion' && baseline && /^[a-f0-9]{40,64}$/.test(baseline)) {
        for (const fn of touched.slice(0, 2)) {
          let before: string;
          try { before = (await run('git', ['-C', root, 'show', `${baseline}:${fn.path}`],
            { encoding: 'utf8', timeout: 200, maxBuffer: CLONE_MAX_SOURCE_BYTES, signal })).stdout; }
          catch { continue; }
          const old = extractCloneFile({ path: fn.path, source: before });
          if (old.status === 'indexed' && !old.functions.some(row => row.name === fn.name && row.renamed === fn.renamed)) {
            lines.push(`New copy ${fn.path}:${fn.line} ${fn.name} since ${baseline.slice(0, 12)}; static match.`);
            citedPaths.add(fn.path);
          }
        }
      }
      // Same-file families also matter; never silently call them absent.
      if (!siblings.length) for (const fn of touched.slice(0, 2)) {
        lines.push(`Copy family ${fn.path}:${fn.line} ${fn.name}; ${family.members.length} scoped copies, static match.`);
        citedPaths.add(fn.path);
      }
    }
    // Recheck the complete captured population before publishing citations.
    bytes = 0;
    for (const [path, source] of sources) if (await capture(path) !== source) return unknown();
    return { status: 'measured', lines, sourceVersion: ctx.sourceVersion,
      indexVersion: hash(JSON.stringify([...sources].map(([path, source]) => [path, hash(source)]))).slice(0, 12),
      citedPaths: [...citedPaths] };
  } };
}
