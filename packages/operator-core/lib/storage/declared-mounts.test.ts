import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findMissingDeclaredMounts,
  formatMissingMountsEscalation,
  parseFstabBindMounts,
  parseMountinfoTargets,
  readMissingDeclaredMounts,
} from './declared-mounts';

// Shaped like the dev box's real /etc/fstab (disk-durable-headroom-2026-10-15#P-015).
const FSTAB = [
  '# /etc/fstab: static file system information.',
  'UUID=abc / ext4 errors=remount-ro 0 1',
  'UUID=def /mnt/data xfs defaults,nofail 0 0',
  '/mnt/data/tmp /tmp none bind,nofail,x-systemd.requires-mounts-for=/mnt/data 0 0',
  '/mnt/data/papercusp-scratch/home /home/u/.papercusp/scratch none bind,nofail,x-systemd.requires-mounts-for=/mnt/data 0 0',
  '/mnt/data/with\\040space /home/u/odd\\040dir/ none rbind 0 0',
  '/mnt/data/manual /home/u/manual none bind,noauto 0 0',
  '/srv/legacy /home/u/legacy bind defaults 0 0',
  '   ',
].join('\n');

const MOUNTINFO = [
  '29 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
  '100 29 259:1 / /mnt/data rw,relatime shared:50 - xfs /dev/nvme1n1 rw',
  '101 29 259:1 /tmp /tmp rw,relatime shared:50 - xfs /dev/nvme1n1 rw',
  '102 29 259:1 /with\\040space /home/u/odd\\040dir rw,relatime shared:50 - xfs /dev/nvme1n1 rw',
].join('\n');

describe('parseFstabBindMounts', () => {
  it('keeps bind/rbind entries that auto-mount, and decodes octal escapes', () => {
    const targets = parseFstabBindMounts(FSTAB).map((m) => m.target);
    expect(targets).toEqual(['/tmp', '/home/u/.papercusp/scratch', '/home/u/odd dir', '/home/u/legacy']);
  });

  it('skips comments, real filesystems and noauto binds', () => {
    const targets = parseFstabBindMounts(FSTAB).map((m) => m.target);
    expect(targets).not.toContain('/');
    expect(targets).not.toContain('/mnt/data');
    expect(targets).not.toContain('/home/u/manual');
  });

  it('returns nothing for a box with no binds (a normal install has nothing to guard)', () => {
    expect(parseFstabBindMounts('UUID=abc / ext4 defaults 0 1\n')).toEqual([]);
  });
});

describe('findMissingDeclaredMounts', () => {
  it('names exactly the declared binds that are not mounted', () => {
    const missing = findMissingDeclaredMounts(parseFstabBindMounts(FSTAB), parseMountinfoTargets(MOUNTINFO));
    expect(missing.map((m) => m.target)).toEqual(['/home/u/.papercusp/scratch', '/home/u/legacy']);
    expect(missing[0]!.source).toBe('/mnt/data/papercusp-scratch/home');
  });

  it('reports nothing once every declared bind is mounted', () => {
    const all = MOUNTINFO + '\n103 29 259:1 /papercusp-scratch/home /home/u/.papercusp/scratch rw - xfs /dev/nvme1n1 rw'
      + '\n104 29 259:1 /legacy /home/u/legacy rw - xfs /dev/nvme1n1 rw';
    expect(findMissingDeclaredMounts(parseFstabBindMounts(FSTAB), parseMountinfoTargets(all))).toEqual([]);
  });
});

describe('readMissingDeclaredMounts', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('reads real files end to end', async () => {
    dir = mkdtempSync(join(tmpdir(), 'declared-mounts-'));
    writeFileSync(join(dir, 'fstab'), FSTAB);
    writeFileSync(join(dir, 'mountinfo'), MOUNTINFO);
    const missing = await readMissingDeclaredMounts(join(dir, 'fstab'), join(dir, 'mountinfo'));
    expect(missing?.map((m) => m.target)).toEqual(['/home/u/.papercusp/scratch', '/home/u/legacy']);
  });

  it('returns null (unknown), never [] (healthy), when a file cannot be read', async () => {
    expect(await readMissingDeclaredMounts('/nonexistent/fstab', '/nonexistent/mountinfo')).toBeNull();
  });
});

describe('formatMissingMountsEscalation', () => {
  it('names each missing target with its expected source', () => {
    const { body } = formatMissingMountsEscalation([{ source: '/mnt/data/x', target: '/home/u/x', options: ['bind'] }]);
    expect(body).toContain('/home/u/x (expected bind of /mnt/data/x)');
  });
});
