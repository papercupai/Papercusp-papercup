import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(bytes = 'frozen source bytes') {
  const root = mkdtempSync(join(tmpdir(), 'broker-source-')); roots.push(root);
  const path = join(root, 'image'); writeFileSync(path, bytes);
  return { root, path, sha: hash(bytes), size: Buffer.byteLength(bytes) };
}
function seal(f: ReturnType<typeof fixture>, code: string, opts: { sha?: string; max?: number } = {}) {
  const fd = openSync(f.path, 'r');
  try {
    return spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'seal-exec', '--sha256', opts.sha ?? f.sha,
      '--max-bytes', String(opts.max ?? f.size), '--', '/usr/bin/python3', '-I', '-S', '-c', code],
    { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, BROKER_HOST_CANARY: 'must-not-reach-source-reader', PYTHONINSPECT: '1' } });
  } finally { closeSync(fd); }
}

describe('Linux sealed runtime source custody', () => {
  it('inherits a sealed kernel object; write, truncate and unseal all fail while reads work', () => {
    const f = fixture();
    const result = seal(f, `
import os,fcntl,errno,hashlib
assert hashlib.sha256(os.read(3, 1000)).hexdigest() == '${f.sha}'
for operation in [lambda: os.write(3,b'x'), lambda: os.ftruncate(3,0), lambda: fcntl.fcntl(3,fcntl.F_ADD_SEALS,0)]:
 try: operation()
 except OSError as error: assert error.errno == errno.EPERM
 else: raise AssertionError('sealed source changed')
assert fcntl.fcntl(3, fcntl.F_GET_SEALS) == 15
assert 'BROKER_HOST_CANARY' not in os.environ
assert 'PYTHONINSPECT' not in os.environ
print('SEALED_AND_CLEAN')`);
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('SEALED_AND_CLEAN');
  });

  it('keeps the admitted bytes after the original pathname is overwritten and removed', () => {
    const f = fixture();
    const result = seal(f, `
import os,hashlib
with open(${JSON.stringify(f.path)},'wb') as out: out.write(b'replacement')
os.unlink(${JSON.stringify(f.path)})
assert hashlib.sha256(os.read(3,1000)).hexdigest() == '${f.sha}'
print('SAME_HANDLE')`);
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('SAME_HANDLE');
  });

  it('refuses a wrong image digest or bound before the child can run', () => {
    const f = fixture();
    for (const opts of [{ sha: '0'.repeat(64) }, { max: f.size - 1 }, { max: 0 }]) {
      const result = seal(f, "print('CHILD_EXECUTED')", opts);
      expect(result.status).toBe(3); expect(result.stdout).not.toContain('CHILD_EXECUTED');
      expect(result.stderr.trim()).toBe('SEALED_SOURCE_REFUSED');
    }
  });

  it('refuses an ordinary unsealed descriptor at the mount boundary', () => {
    const f = fixture(); const fd = openSync(f.path, 'r');
    try {
      const result = spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'mount-exec', '--sha256', f.sha,
        '--max-bytes', String(f.size), '--manifest-sha256', 'd'.repeat(64), '--', '/usr/bin/true'],
      { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 5000 });
      expect(result.status).toBe(3); expect(result.stderr.trim()).toBe('SEALED_SOURCE_REFUSED');
    } finally { closeSync(fd); }
  });

  function image(escape = false, mutation?: 'bytes' | 'extra' | 'missing' | 'mode' | 'manifest') {
    const f = fixture(); const source = join(f.root, 'source');
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import os
os.mkdir(${JSON.stringify(source)})
with open(${JSON.stringify(join(source, 'marker'))},'w') as f: f.write('frozen marker')
${escape ? `os.symlink('/etc/passwd', ${JSON.stringify(join(source, 'escape'))})` : ''}`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.stringify({ version: 1, sourceCommit: 'a'.repeat(40),
      sourceReceiptSha256: 'b'.repeat(64), dependenciesReceiptSha256: 'c'.repeat(64),
      files: [{ path: 'marker', kind: 'file', executable: false, sha256: hash('frozen marker') }] });
    writeFileSync(join(source, '.broker-closure.json'), mutation === 'manifest' ? '{}' : manifest);
    if (mutation === 'bytes') writeFileSync(join(source, 'marker'), 'different marker');
    if (mutation === 'extra') writeFileSync(join(source, 'unexpected'), 'unrecorded');
    if (mutation === 'missing') rmSync(join(source, 'marker'));
    if (mutation === 'mode') spawnSync('/usr/bin/chmod', ['+x', join(source, 'marker')]);
    const packed = spawnSync('/usr/bin/mksquashfs', [source, f.path, '-noappend', '-no-progress',
      '-processors', '1', '-all-root', '-all-time', '0', '-mkfs-time', '0', '-no-xattrs'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    return { ...f, manifestSha: hash(manifest) };
  }
  function mount(f: ReturnType<typeof image>, code: string) {
    const fd = openSync(f.path, 'r');
    try {
      return spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import os,hashlib
data=open(${JSON.stringify(f.path)},'rb').read()
sha=hashlib.sha256(data).hexdigest()
os.execv('/usr/bin/python3',['/usr/bin/python3','-I','-S',${JSON.stringify(helper)},'seal-exec','--sha256',sha,'--max-bytes',str(len(data)),'--','/usr/bin/python3','-I','-S',${JSON.stringify(helper)},'mount-exec','--sha256',sha,'--max-bytes',str(len(data)),'--manifest-sha256',${JSON.stringify(f.manifestSha)},'--','/usr/bin/python3','-I','-S','-c',${JSON.stringify(code)}])`],
      { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 20_000 });
    } finally { closeSync(fd); }
  }

  it('extracts the sealed image into one private read-only mount with private proc and network', () => {
    const f = image();
    const result = mount(f, `
import os,errno,socket,fcntl,glob,ctypes
assert open('/source/marker').read() == 'frozen marker'
assert not os.path.exists(${JSON.stringify(f.path)})
assert not os.path.exists('/tmp/source-stage')
assert not any(os.path.exists(path) for path in glob.glob('/proc/[0-9]*/root/tmp/source-stage'))
libc=ctypes.CDLL(None, use_errno=True)
assert libc.unshare(0x10000000) == -1 and ctypes.get_errno() in (errno.EPERM, errno.ENOSPC), ctypes.get_errno()
try: open('/source/marker','w')
except OSError as error: assert error.errno == errno.EROFS
else: raise AssertionError('source mount writable')
assert fcntl.fcntl(3, fcntl.F_GET_SEALS) == 15
assert os.getpid() < 100
assert socket.if_nameindex() == [(1,'lo')]
print('FROZEN_PRIVATE_MOUNT')`);
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('FROZEN_PRIVATE_MOUNT');
  });

  it('rejects an escaping image symlink before executing a runtime command', () => {
    const result = mount(image(true), "print('CHILD_EXECUTED')");
    expect(result.status).toBe(3); expect(result.stdout).not.toContain('CHILD_EXECUTED');
    expect(result.stderr).toContain('SEALED_SOURCE_REFUSED');
  });

  it('censuses image bytes, executable mode and the complete population against the pinned closure', () => {
    for (const mutation of ['bytes', 'extra', 'missing', 'mode', 'manifest'] as const) {
      const result = mount(image(false, mutation), "print('CHILD_EXECUTED')");
      expect(result.status, mutation + ': ' + result.stderr).toBe(3);
      expect(result.stdout).not.toContain('CHILD_EXECUTED');
      expect(result.stderr).toContain('SEALED_SOURCE_REFUSED');
    }
  });
});
