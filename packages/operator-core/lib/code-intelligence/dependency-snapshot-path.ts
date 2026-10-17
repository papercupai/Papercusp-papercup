/** Shared by the producer and hot readers; importing a path must not register routines. */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dependencySnapshotPath(repoName: string, home = homedir()): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repoName)) throw new Error('Invalid snapshot repository name');
  return join(home, '.papercusp', 'graph-snapshot', repoName, 'dependency-snapshot.json');
}
