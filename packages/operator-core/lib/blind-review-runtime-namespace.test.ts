import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { brokerSourceFixture } from './blind-review-source.fixture';
import { packRuntimeSourceImage } from './blind-review-source-image';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));

describe('native services in the sealed runtime namespace', () => {
  it.each(['deny-create', 'foreign-seed'])(
    'enters the sealed trusted guest and refuses without product creation (%s)', async kind => {
      const f = await brokerSourceFixture(roots), image = await packRuntimeSourceImage(f);
      try {
        const child = spawn('/usr/bin/python3', ['-I', '-S', helper, 'runtime-exec',
          '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
          '--manifest-sha256', image.manifestSha256, '--control-fd', '5'], {
          stdio: ['ignore', 'pipe', 'pipe', image.handle.fd, 'ignore', 'pipe'],
          env: { PATH: '/usr/bin:/bin', BROKER_HOST_SECRET: 'HOST_CONFIG_CANARY' }, signal: AbortSignal.timeout(20_000),
        });
        const descriptors: ReadonlyArray<unknown> = child.stdio, control = descriptors[5] as Duplex;
        let stderr = '', buffer = '', creates = 0;
        const frames: Array<Record<string, unknown>> = [];
        child.stderr!.on('data', chunk => { stderr += chunk; });
        control.on('error', () => {});
        control.on('data', chunk => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            frames.push(message);
            if (message.type === 'before') {
              creates++;
              control.write(JSON.stringify({ ok: false, seq: message.seq }) + '\n');
            }
          }
        });
        const done = new Promise<number | null>((resolve, reject) => {
          child.once('error', reject); child.once('close', resolve);
        });
        const config = { version: 1, seed: { version: 1, workspace: { id: randomUUID(),
          slug: 'review-' + 'a'.repeat(24), name: 'Disposable review' },
          actors: kind === 'foreign-seed' ? [{ text: 'ambient' }] : [], fixtures: ['ready'] },
        resources: ['process', 'listener', 'display', 'database', 'workspace', 'profile', 'channel', 'credential']
          .map(kind => ({ id: randomUUID(), kind, ownershipTag: 'b'.repeat(64) })) };
        control.write(JSON.stringify(config) + '\n');
        expect(await done, stderr).toBe(3);
        expect(stderr.trim()).toBe('RUNTIME_GUEST_REFUSED');
        expect(creates).toBe(kind === 'deny-create' ? 1 : 0);
        expect(frames.map(frame => frame.type)).toEqual(kind === 'deny-create' ? ['before', 'failed'] : []);
        if (kind === 'deny-create') expect(frames[1]).toMatchObject({ stage: 'workspace', code: 'control_authorization_refused' });
        control.destroy();
      } finally { await image.handle.close(); }
    }, 30_000);

  it('carries only the explicit private control socket across both namespace stages and closes it for product children', async () => {
    const f = await brokerSourceFixture(roots), image = await packRuntimeSourceImage(f);
    try {
      const guest = `
import json,os,socket,subprocess
assert os.environ['PAPERCUSP_RUNTIME_CONTROL_FD'] == '5'
assert os.fstat(3).st_size > 0
for fd in (4,6):
 try: os.fstat(fd)
 except OSError: pass
 else: raise AssertionError('unrelated descriptor inherited')
channel=socket.socket(fileno=5)
channel.sendall(b'GUEST_READY\\n')
assert channel.recv(32) == b'HOST_ACK\\n'
channel.close(); os.close(3)
env={k:v for k,v in os.environ.items() if not k.startswith('PAPERCUSP_RUNTIME_')}
child=subprocess.run(['/usr/bin/python3','-I','-S','-c',
 "import os; assert not any(k.startswith('PAPERCUSP_RUNTIME_') for k in os.environ); "
 "assert all(not os.path.exists('/proc/self/fd/'+str(fd)) for fd in (3,4,5,6)); print('PRODUCT_FDS_CLOSED')"],
 close_fds=True,env=env,capture_output=True,text=True,timeout=5)
assert child.returncode == 0, child.stderr
print(child.stdout.strip())`;
      const run = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import os,socket,subprocess
left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
assert left.fileno() == 4 and right.fileno() == 5
secret=os.open('/dev/null',os.O_RDONLY)
assert secret == 6
child=subprocess.Popen(${JSON.stringify(['/usr/bin/python3', '-I', '-S', helper, 'mount-exec',
        '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
        '--manifest-sha256', image.manifestSha256, '--control-fd', '5', '--',
        '/usr/bin/python3', '-I', '-S', '-c', guest])},pass_fds=(3,5,6),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
right.close();os.close(secret);left.settimeout(15)
assert left.recv(128) == b'GUEST_READY\\n'
left.sendall(b'HOST_ACK\\n');left.close()
out,err=child.communicate(timeout=10)
assert child.returncode == 0, err
print(out.decode().strip())`], {
        stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 30_000,
      });
      expect(run.error).toBeUndefined(); expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('PRODUCT_FDS_CLOSED');
    } finally { await image.handle.close(); }
  }, 45_000);

  it.each(['file', 'named-socket', 'wrong-number'])('refuses an untrusted control descriptor (%s)', async kind => {
    const f = await brokerSourceFixture(roots), image = await packRuntimeSourceImage(f);
    try {
      const run = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import os,socket,subprocess,tempfile
kind=${JSON.stringify(kind)}
with tempfile.TemporaryDirectory() as root:
 if kind == 'named-socket':
  listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);listener.bind(root+'/control');listener.listen(1)
  client=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);client.connect(root+'/control')
  accepted,_=listener.accept();os.dup2(accepted.fileno(),5)
 elif kind == 'file':
  fd=os.open('/dev/null',os.O_RDONLY);os.dup2(fd,5)
 else:
  left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM);os.dup2(right.fileno(),5)
 child=subprocess.run(${JSON.stringify(['/usr/bin/python3', '-I', '-S', helper, 'mount-exec',
        '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
        '--manifest-sha256', image.manifestSha256, '--control-fd', kind === 'wrong-number' ? '4' : '5',
        '--', '/usr/bin/true'])},pass_fds=(3,5),capture_output=True,text=True,timeout=10)
 assert child.returncode == 3, (child.returncode,child.stderr)
 assert child.stderr.strip() == 'SEALED_SOURCE_REFUSED'
print('UNTRUSTED_CONTROL_REFUSED')`], { stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 15_000 });
      expect(run.error).toBeUndefined(); expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe('UNTRUSTED_CONTROL_REFUSED');
    } finally { await image.handle.close(); }
  }, 30_000);

  it('boots an actual private PostgreSQL using guest NSS without mounting host identity or configuration', async () => {
    const f = await brokerSourceFixture(roots), image = await packRuntimeSourceImage(f);
    const hostMachineId = readFileSync('/etc/machine-id', 'utf8').trim();
    try {
      rmSync(f.root, { recursive: true }); rmSync(f.repositoryRoot, { recursive: true });
      const run = spawnSync('/usr/bin/python3', ['-I', '-S', helper, 'mount-exec',
        '--sha256', image.imageSha256, '--max-bytes', String(image.imageBytes),
        '--manifest-sha256', image.manifestSha256, '--', '/usr/bin/python3', '-I', '-S', '-c', `
import ipaddress,json,os,pwd,socket,stat,subprocess,time
assert pwd.getpwuid(os.getuid()).pw_name == 'review'
assert pwd.getpwuid(os.getuid()).pw_dir == '/tmp/home'
assert os.environ['HOME'] == '/tmp/home'
assert os.environ['XDG_RUNTIME_DIR'] == '/tmp/run'
assert os.environ.get('BROKER_HOST_SECRET') is None
assert open('/etc/machine-id').read().strip() != ${JSON.stringify(hostMachineId)}
assert open('/etc/resolv.conf').read() == ''
assert socket.gethostbyname('localhost') == '127.0.0.1'
assert socket.gethostname() == 'review-runtime'
assert not os.path.exists(${JSON.stringify(f.custodyRoot)})
assert stat.S_ISCHR(os.stat('/dev/null').st_mode)
with open('/dev/null','r+b',buffering=0) as device:
 assert device.write(b'private_device_preflight') == 24
 assert device.read(1) == b''
with open('/dev/urandom','rb',buffering=0) as device:
 assert len(device.read(16)) == 16
assert os.path.isdir('/dev/shm'), 'private_shm_missing'
assert stat.S_IMODE(os.stat('/tmp/run').st_mode) == 0o700
try:
 open('/etc/passwd','a').write('foreign')
except OSError: pass
else: raise AssertionError('guest identity is writable')
env={'PATH':'/usr/bin:/bin','HOME':'/tmp/home','LANG':'C.UTF-8'}
bin='/usr/lib/postgresql/18/bin/'
init=subprocess.run([bin+'initdb','-D','/tmp/pg','-U','review','-A','trust','--locale=C','--no-sync'],
 env=env,capture_output=True,text=True,timeout=15)
assert init.returncode == 0, init.stderr
server=subprocess.Popen([bin+'postgres','-D','/tmp/pg','-p','5432',
 '-c','listen_addresses=127.0.0.1','-c','unix_socket_directories=','-c','logging_collector=off'],
 env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
try:
 deadline=time.monotonic()+15
 while True:
  assert server.poll() is None, 'private_postmaster_exited'
  query=subprocess.run([bin+'psql','-h','127.0.0.1','-p','5432','-U','review','-d','postgres','-At','-c',
   "select current_user || ':' || (inet_server_addr()::text)"],env=env,capture_output=True,text=True,timeout=5)
  if query.returncode == 0: break
  assert time.monotonic()<deadline, ('private_postmaster_not_ready',query.stderr)
  time.sleep(.05)
 assert query.returncode == 0, query.stderr
 user,address=query.stdout.strip().split(':',1)
 assert user == 'review', repr(query.stdout)
 assert str(ipaddress.ip_interface(address).ip) == '127.0.0.1', repr(query.stdout)
finally:
 server.terminate(); server.wait(timeout=10)
print(json.dumps({'marker':'PRIVATE_NATIVE_PG_NAMESPACE_VERIFIED','user':user,
 'serverAddress':str(ipaddress.ip_interface(address).ip),'rawAddress':address}))`], {
        stdio: ['ignore', 'pipe', 'pipe', image.handle.fd], encoding: 'utf8', timeout: 45_000,
        env: { PATH: '/usr/bin:/bin', BROKER_HOST_SECRET: 'HOST_CONFIG_CANARY' },
      });
      expect(run.error).toBeUndefined(); expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim())).toMatchObject({ marker: 'PRIVATE_NATIVE_PG_NAMESPACE_VERIFIED',
        user: 'review', serverAddress: '127.0.0.1' });
      console.log('NATIVE_PG_NAMESPACE_OBSERVATION ' + run.stdout.trim());
    } finally { await image.handle.close(); }
  }, 60_000);
});
