import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

const DATA_PARENT = '/mnt/data/offload';
const DATA_EVIDENCE_ROOT = path.join(DATA_PARENT, 'verification-harness');

interface EvidenceRootHost {
  platform(): string;
  lstat(target: string): unknown;
  stat(target: string): { dev: number | bigint; isDirectory(): boolean };
  access(target: string, mode: number): unknown;
}
const localHost: EvidenceRootHost = { platform, lstat: lstatSync, stat: statSync, access: accessSync };

/** Existing offload storage only: never mistake an unmounted directory or a
 * link back to root for the data volume. Resolving a default does not create it. */
function dataEvidenceRoot(host: EvidenceRootHost): string | null {
  if (host.platform() !== 'linux') return null;
  try {
    let probe = DATA_EVIDENCE_ROOT;
    try { host.lstat(probe); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      probe = DATA_PARENT;
    }
    const storage = host.stat(probe);
    if (!storage.isDirectory() || storage.dev === host.stat('/').dev) return null;
    host.access(probe, constants.W_OK | constants.X_OK);
    return DATA_EVIDENCE_ROOT;
  } catch { return null; }
}

/** The canonical base for new evidence when a separate writable data volume is mounted. */
export function canonicalEvidenceRootBase(host: EvidenceRootHost = localHost): string | null {
  return dataEvidenceRoot(host);
}

/**
 * The pre-offload default for a harness. This is intentionally only a diagnostic path: callers
 * must not silently write there when the separate data volume is available, because historical
 * evidence at this path is what exhausted the root filesystem.
 */
export function legacyEvidenceRoot(harness: string, env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim() || path.join(env.HOME?.trim() || homedir(), '.local', 'state');
  return path.join(state, 'verification-harness', harness);
}

/**
 * True only for an implicit legacy default while the canonical data volume is available. Explicit
 * VH_EVIDENCE_ROOT_BASE/XDG_STATE_HOME locations remain caller-owned and are not second-guessed.
 */
export function isLegacyEvidenceRoot(
  harness: string,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  host: EvidenceRootHost = localHost,
): boolean {
  if (env.VH_EVIDENCE_ROOT_BASE?.trim() || env.XDG_STATE_HOME?.trim()) return false;
  const data = dataEvidenceRoot(host);
  return data !== null && path.resolve(root) === path.resolve(legacyEvidenceRoot(harness, env)) &&
    path.resolve(data) !== path.resolve(root);
}

/**
 * Honor VH_EVIDENCE_ROOT_BASE and XDG_STATE_HOME. Otherwise prefer the verified
 * separate data volume on Linux, then the legacy home state directory. Existing
 * evidence stays at its original path; this selects defaults for new runs only.
 * Keep this resolver free of workspace dependencies for plain Node launchers.
 */
export function defaultEvidenceRoot(
  harness: string, env: NodeJS.ProcessEnv = process.env, host: EvidenceRootHost = localHost,
): string {
  const explicit = env.VH_EVIDENCE_ROOT_BASE?.trim();
  if (explicit) return path.join(explicit, harness);
  const configuredState = env.XDG_STATE_HOME?.trim();
  if (!configuredState) {
    const data = dataEvidenceRoot(host);
    if (data) return path.join(data, harness);
  }
  const state = configuredState || path.join(env.HOME?.trim() || homedir(), '.local', 'state');
  return path.join(state, 'verification-harness', harness);
}
