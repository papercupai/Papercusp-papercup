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
