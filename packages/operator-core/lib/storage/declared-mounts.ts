/**
 * Declared-mount guard (disk-durable-headroom-2026-10-15#P-015).
 *
 * This box keeps agent-generated volume off `/` with `/etc/fstab` bind mounts:
 * `/tmp`, coredumps, `.gitnexus`, and both agent scratch roots all come from
 * `/mnt/data`. Each is declared `nofail`. If a boot leaves one of those binds
 * unmounted, boot carries on and every writer silently lands on `/` again,
 * which is how the root disk filled before. Nothing failed, so nothing paged.
 *
 * The expectation is DERIVED from fstab itself, never from a hand-kept path
 * list. A new bind added to fstab is guarded the moment it is declared, and a
 * box with no binds (a normal install) has nothing to report.
 */
import { readFile } from 'node:fs/promises';

export interface DeclaredBindMount {
  source: string;
  target: string;
  options: string[];
}

/** fstab and mountinfo encode space, tab, newline and backslash as octal escapes (`\040`). */
function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function normalizeTarget(target: string): string {
  const trimmed = target.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * The bind mounts fstab expects to be mounted at boot. A `noauto` entry is
 * excluded because nothing promises to mount it.
 */
export function parseFstabBindMounts(text: string): DeclaredBindMount[] {
  const out: DeclaredBindMount[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [source, target, fstype, opts = ''] = line.split(/\s+/);
    if (!source || !target || !fstype) continue;
    const options = opts.split(',').filter(Boolean);
    const isBind = fstype === 'bind' || options.includes('bind') || options.includes('rbind');
    if (!isBind || options.includes('noauto')) continue;
    out.push({ source: unescapeMountPath(source), target: normalizeTarget(unescapeMountPath(target)), options });
  }
  return out;
}

/** Mount points currently visible to this process (`/proc/self/mountinfo` field 5). */
export function parseMountinfoTargets(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    const mountPoint = fields[4];
    if (mountPoint) out.add(normalizeTarget(unescapeMountPath(mountPoint)));
  }
  return out;
}

export function findMissingDeclaredMounts(declared: readonly DeclaredBindMount[], mounted: ReadonlySet<string>): DeclaredBindMount[] {
  return declared.filter((mount) => !mounted.has(mount.target));
}

/**
 * Declared bind mounts that are not mounted right now. Returns `null` when either
 * file cannot be read. Unreadable is NOT healthy, so a caller must not resolve an
 * open alarm on `null`.
 */
export async function readMissingDeclaredMounts(
  fstabPath = '/etc/fstab',
  mountinfoPath = '/proc/self/mountinfo',
): Promise<DeclaredBindMount[] | null> {
  try {
    const [fstab, mountinfo] = await Promise.all([readFile(fstabPath, 'utf8'), readFile(mountinfoPath, 'utf8')]);
    return findMissingDeclaredMounts(parseFstabBindMounts(fstab), parseMountinfoTargets(mountinfo));
  } catch {
    return null;
  }
}

export const DECLARED_MOUNT_ALARM_CONDITION_KEY = 'alarm:declared-mount-missing';
export const DECLARED_MOUNT_ALARM_TITLE = 'Declared disk mount missing: writes are landing on the wrong disk';

export function formatMissingMountsEscalation(missing: readonly DeclaredBindMount[]): { title: string; body: string } {
  const lines = missing.map((mount) => `• ${mount.target} (expected bind of ${mount.source})`);
  return {
    title: DECLARED_MOUNT_ALARM_TITLE,
    body:
      `/etc/fstab declares ${missing.length} bind mount(s) that are not mounted. Writers to these paths are filling the disk underneath instead (usually /):\n` +
      `${lines.join('\n')}\n` +
      'Mount them with `sudo mount <target>`, after moving anything written into the bare directory meanwhile. ' +
      'These entries are `nofail`, so a missing source volume does not stop boot; check that the source filesystem is mounted first.',
  };
}
