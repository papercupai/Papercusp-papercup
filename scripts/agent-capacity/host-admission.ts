/**
 * Where an agent-capacity run may start its agent sessions (WI-10004522, plan
 * agent-capacity-and-cost-gcp-2026-09-30).
 *
 * `load-driver.ts` and `record-session.ts` start real agent CLIs whose memory and CPU are the
 * thing being measured; a heavy replay peaked at 18 GB. They run in two places:
 *
 *  - a disposable ramp VM (`~/capacity/scripts/agent-capacity/`, copied there without the rest of
 *    the repo): the VM is the measured machine itself, sessions are confined in capdrv.slice, and
 *    no Papercusp operator or resource governor exists to admit against;
 *  - the shared Papercusp tree on the dev box, for local replay sweeps and recordings: here the
 *    sessions contend with every agent on the host, so the run must hold a `scripts/pc-heavy.sh`
 *    slot, the admission the repo's heavy jobs already go through. pc-heavy marks its child with
 *    PC_HEAVY_BYPASS=1.
 *
 * A run inside the Papercusp tree without that slot is refused before any session starts.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

export type CapacityHost = 'papercusp-tree' | 'dedicated';

/** `papercusp-tree` when `scriptDir` sits in a checkout that also holds the operator. */
export function capacityHost(scriptDir: string): CapacityHost {
  return existsSync(path.resolve(scriptDir, '../../packages/operator-core/package.json')) ? 'papercusp-tree' : 'dedicated';
}

/** Shared-host checkouts use the data tier; standalone ramp VMs keep their own cache. */
export function capacityCacheRoot(scriptDir: string): string {
  return platform() === 'linux' && capacityHost(scriptDir) === 'papercusp-tree'
    ? '/mnt/data/agent-capacity' : path.join(homedir(), '.cache', 'agent-capacity');
}

/** Admit before mkdir, replacement cleanup, cp or overlay mount. stat follows
 * symlinks; an absent/unmounted data volume must not fall back to root. */
export function assertCapacityStorage(scriptDir: string, destination: string): void {
  if (platform() !== 'linux' || capacityHost(scriptDir) !== 'papercusp-tree') return;
  let ancestor = path.resolve(destination);
  for (;;) {
    try {
      const storage = statSync(ancestor);
      if (!storage.isDirectory() || storage.dev === statSync('/').dev) {
        throw new Error('agent-capacity: repository copies and overlays refuse the root filesystem; choose mounted /mnt/data storage.');
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw error;
      ancestor = path.dirname(ancestor);
    }
  }
}

/** Throws unless the run is on a dedicated host or holds a pc-heavy slot. */
export function assertHostAdmission(scriptDir: string, env: NodeJS.ProcessEnv = process.env): CapacityHost {
  const host = capacityHost(scriptDir);
  if (host === 'papercusp-tree' && env.PC_HEAVY_BYPASS !== '1') {
    throw new Error(
      'agent-capacity: this run would start agent sessions on the shared Papercusp host without admission. ' +
        'Run it under scripts/pc-heavy.sh -- npx tsx scripts/agent-capacity/<script>.ts ... (or on a ramp VM).',
    );
  }
  return host;
}
