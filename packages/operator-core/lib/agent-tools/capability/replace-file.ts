/**
 * Replace an existing file's contents by writing a sibling temp file and renaming it over
 * the target. The existing inode is never truncated and rewritten.
 *
 * Why (WI-10006772): bash reads a running script lazily, by byte offset, from the inode it
 * opened. `writeFileSync` on an existing path keeps that inode, so every byte after the edit
 * point moves under the running shell and its next read lands mid-token. On 2026-10-06 a
 * capability:edit to scripts/agent-capacity/vm/p2p-join-soak.sh, 50 minutes into a 95-minute
 * GCP soak, made the script fail at its tail with "unexpected EOF", and the S8 revoke phase
 * never ran. After a rename the path names a new inode while the running process keeps
 * reading the old one to its end. Claude Code's native Edit already replaces files this way.
 *
 * Kept from an in-place write:
 *  - the permission bits, so an executable script stays executable;
 *  - a symlinked path stays a symlink: the link is resolved and its target is replaced;
 *  - a file the caller may not write is refused (EACCES) instead of being replaced through
 *    the directory's write permission.
 * A path that does not exist yet is written directly: nothing can be reading it.
 * Not kept: hard links to the old inode keep the old contents.
 */

import { randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function replaceFileContents(path: string, content: string): void {
  let target: string;
  try {
    target = realpathSync(path);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    writeFileSync(path, content, 'utf8');
    return;
  }
  accessSync(target, constants.W_OK);
  const mode = statSync(target).mode & 0o7777;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.replace-tmp`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    // writeFileSync's `mode` option is masked by the umask; chmod sets the bits exactly.
    chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (e: unknown) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file was never created, or the rename already consumed it.
    }
    throw e;
  }
}
