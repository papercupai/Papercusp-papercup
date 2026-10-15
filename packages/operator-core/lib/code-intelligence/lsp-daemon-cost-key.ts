/** Cost observations belong to an exact operation, cursor and project inputs. */
import { createHash } from 'node:crypto';
import { lstat, open, opendir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { LspFacadeArgs } from './lsp-facade.ts';

export const LSP_DAEMON_INPUT_BOUNDS = Object.freeze({ maxEntries: 4_096, maxBytes: 8 * 1024 * 1024 });

export type LspDaemonInputSnapshot =
  | { measured: true; root: string; fingerprint: string; entries: number; bytes: number; files: readonly string[];
      externalReferenceCandidates: readonly string[] }
  | { measured: false; reason: string };

/** Reconcile from bytes, independent of filesystem notifications and mtimes.
 *
 * Every project entry participates, including configuration, manifests, hidden
 * files and nested repositories. This is a bounded project-input identity, not
 * a claim that an LSP server loaded every file or has no external dependencies.
 * A wide, unreadable or linked scope is explicitly unmeasured; callers must
 * bypass reuse rather than mistake a partial census for a current project.
 */
export async function captureLspDaemonInputs(rootPath: string,
  bounds: Readonly<{ maxEntries: number; maxBytes: number }> = LSP_DAEMON_INPUT_BOUNDS,
): Promise<LspDaemonInputSnapshot> {
  if (!Number.isSafeInteger(bounds.maxEntries) || bounds.maxEntries < 1 || bounds.maxEntries > LSP_DAEMON_INPUT_BOUNDS.maxEntries ||
      !Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1 || bounds.maxBytes > LSP_DAEMON_INPUT_BOUNDS.maxBytes)
    return { measured: false, reason: 'invalid project-input bounds' };
  try {
    const root = await realpath(rootPath);
    const scan = async () => {
      let entries = 0, bytes = 0;
      const rows: Array<[string, string]> = [];
      const externalReferenceCandidates: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for await (const entry of await opendir(dir)) {
          if (++entries > bounds.maxEntries) throw new Error('project-input entry bound exceeded');
          const path = join(dir, entry.name);
          const rel = relative(root, path).split('\\').join('/');
          const before = await lstat(path);
          if (before.isSymbolicLink()) throw new Error(`linked project input is unmeasured: ${rel}`);
          if (before.isDirectory()) {
            rows.push([rel, 'directory']);
            await walk(path);
          } else if (before.isFile()) {
            if (bytes + before.size > bounds.maxBytes) throw new Error('project-input byte bound exceeded');
            const hash = createHash('sha256');
            let prefix = '';
            let previousTextTail = '';
            let referenceCandidate = false;
            // A file can grow after stat. Stream under the remaining budget so
            // reconciliation never allocates an unbounded readFile buffer.
            const file = await open(path, 'r');
            try {
              const buffer = Buffer.alloc(Math.min(64 * 1024, bounds.maxBytes + 1));
              for (;;) {
                const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, bounds.maxBytes - bytes + 1), null);
                if (!bytesRead) break;
                bytes += bytesRead;
                if (bytes > bounds.maxBytes) throw new Error('project-input byte bound exceeded');
                const chunk = buffer.subarray(0, bytesRead);
                // Conservative admission only: any triple-slash text in a TS
                // source may introduce an external path/type/lib reference.
                // Detect across chunk boundaries under the same streaming bound.
                const text = previousTextTail + chunk.toString('utf8');
                referenceCandidate ||= text.includes('///');
                previousTextTail = text.slice(-2);
                if (prefix.length < 7) prefix += chunk.toString('utf8').slice(0, 7 - prefix.length);
                hash.update(chunk);
              }
            } finally { await file.close(); }
            const after = await lstat(path);
            if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev ||
                before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
              throw new Error(`project input changed during reconciliation: ${rel}`);
            // A gitdir pointer can name mutable metadata outside this root. Its
            // pointer bytes alone cannot identify a submodule/worktree commit.
            if (entry.name === '.git' && prefix.startsWith('gitdir:'))
              throw new Error(`external repository metadata is unmeasured: ${rel}`);
            rows.push([rel, hash.digest('hex')]);
            if (referenceCandidate && /\.[cm]?tsx?$/.test(rel)) externalReferenceCandidates.push(rel);
          } else throw new Error(`non-file project input is unmeasured: ${rel}`);
        }
      };
      await walk(root);
      rows.sort(([a], [b]) => a.localeCompare(b));
      return { fingerprint: createHash('sha256').update(JSON.stringify({ root, rows })).digest('hex'), entries, bytes,
        files: rows.filter(([, hash]) => hash !== 'directory').map(([path]) => path),
        externalReferenceCandidates: externalReferenceCandidates.sort() };
    };
    // A second complete pass detects a missed edit, addition or deletion while
    // the first census was being assembled. No persistent watcher state is trusted.
    const first = await scan();
    const second = await scan();
    if (first.fingerprint !== second.fingerprint)
      return { measured: false, reason: 'project inputs changed during reconciliation' };
    return { measured: true, root, ...second };
  } catch (error) {
    return { measured: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function lspDaemonCostKey(op: string, args: LspFacadeArgs): Promise<string | undefined> {
  // No document/project revision means no evidence an earlier symbol cost applies.
  if (!args.file) return undefined;
  try {
    const revision = createHash('sha256').update(await readFile(args.file)).digest('hex');
    let projectFingerprint: string | undefined;
    if (args.rootPath) {
      const project = await captureLspDaemonInputs(args.rootPath);
      if (!project.measured) return undefined;
      const rel = relative(project.root, resolve(args.file));
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return undefined;
      projectFingerprint = project.fingerprint;
    }
    return createHash('sha256').update(JSON.stringify({ op, args, revision, projectFingerprint })).digest('hex');
  } catch {
    return undefined;
  }
}
