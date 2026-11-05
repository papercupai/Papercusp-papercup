/** Source-byte identity shared by source execution and the maintained host builders.
 * Function.toString() identifies compiler output, not the implementation that was
 * compiled: bundling alone renames locals and release builds rewrite expressions.
 * Keep the complete local evaluator modules and their pure imported dependencies
 * in this conservative witness. Unrelated edits can invalidate replay; missing
 * inputs must never make two unknown implementations compare equal. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sourceFiles from './retained-replay-sources.json' with { type: 'json' };

// The dependency lock includes the SQL parser's transitive versions/integrities.
export const RETAINED_REPLAY_SOURCE_FILES = Object.freeze(sourceFiles);

/** Called by the shared compiler recipe before AND after compilation. Paths are
 * relative identities; relocating a frozen source export does not change them. */
export function measureRetainedReplaySourceIdentity(root: string): string {
  const sources = RETAINED_REPLAY_SOURCE_FILES.map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]);
  return createHash('sha256').update(JSON.stringify({ version: 1, sources })).digest('hex');
}

declare const __PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__: string | undefined;

function captureSourceIdentity(): { sha256: string; root?: string; stamps?: string[] } | null {
  if (typeof __PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__ !== 'undefined') {
    return /^[a-f0-9]{64}$/.test(__PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__ ?? '')
      ? { sha256: __PAPERCUSP_RETAINED_REPLAY_SOURCE_SHA256__! } : null;
  }
  // A bundle without its producing-build witness is unknown. In particular,
  // never hash whatever source checkout happens to be beside a running bundle.
  const path = fileURLToPath(import.meta.url);
  if (!path.endsWith('/packages/operator-core/lib/retained-replay-identity.ts')) return null;
  try {
    const root = resolve(dirname(path), '../../..');
    const stamps = sourceStamps(root);
    const sha256 = measureRetainedReplaySourceIdentity(root);
    if (JSON.stringify(sourceStamps(root)) !== JSON.stringify(stamps)) return null;
    return { sha256, root, stamps };
  } catch { return null; }
}

function sourceStamps(root: string): string[] {
  return RETAINED_REPLAY_SOURCE_FILES.map(path => {
    const s = statSync(resolve(root, path), { bigint: true });
    return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
  });
}

const captured = captureSourceIdentity();

/** Source mode captures at module initialization and refuses subsequent source
 * drift. Built artifacts retain the digest measured around their compilation. */
export function retainedReplaySourceIdentity(): string | null {
  if (!captured) return null;
  if (captured.root) {
    try {
      if (JSON.stringify(sourceStamps(captured.root)) !== JSON.stringify(captured.stamps)) return null;
    } catch { return null; }
  }
  return captured.sha256;
}
