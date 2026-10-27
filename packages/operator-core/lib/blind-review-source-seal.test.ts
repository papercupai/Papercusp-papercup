import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sealRuntimeSourceHandle } from './blind-review-source-seal';

const roots: string[] = [], handles: FileHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'broker-export-')); roots.push(root);
  const path = join(root, 'input'), bytes = Buffer.from('pinned source image'); await writeFile(path, bytes);
  const original = await open(path, 'r'); handles.push(original);
  return { original, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

describe('host retained kernel source seal', () => {
  it('retains the same sealed kernel object after exporter exit and refuses writes through reopened descriptors', async () => {
    const f = await fixture();
    const sealed = await sealRuntimeSourceHandle(f.original, f.sha256, f.bytes); handles.push(sealed);
    const info = await sealed.stat(); expect(info.nlink).toBe(0);
    await writeFile(f.path, 'donor changed after export');
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import os,fcntl,errno,hashlib
fd=3
assert fcntl.fcntl(fd,fcntl.F_GET_SEALS) == (fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL)
assert hashlib.sha256(os.read(fd,100)).hexdigest() == '${f.sha256}'
writefd=os.open('/proc/self/fd/3',os.O_RDWR)
try: os.pwrite(writefd,b'changed',0)
except OSError as e: assert e.errno == errno.EPERM
else: raise AssertionError('sealed input writable')
assert os.fstat(fd).st_ino == ${info.ino}
print('RETAINED_SEAL_VERIFIED')`], { stdio: ['ignore', 'pipe', 'pipe', sealed.fd], encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('RETAINED_SEAL_VERIFIED');
  });

  it('refuses wrong digest and a changed size before publishing a retained handle', async () => {
    const f = await fixture();
    await expect(sealRuntimeSourceHandle(f.original, '0'.repeat(64), f.bytes)).rejects.toThrow('broker_source_seal_failed');
    await expect(sealRuntimeSourceHandle(f.original, f.sha256, f.bytes - 1)).rejects.toThrow('broker_source_seal_failed');
  });

  it('honors cancellation before starting an exporter', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(sealRuntimeSourceHandle(f.original, f.sha256, f.bytes, controller.signal)).rejects.toThrow();
  });
});
