import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-kernel-channel.py', import.meta.url));
function probe(code: string) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', `
import os,socket,struct,array,runpy,tempfile
api=runpy.run_path(${JSON.stringify(helper)})
Channel=api['AuthenticatedInvocationChannel']
Refusal=api['ChannelRefusal']
ticks=api['process_start_ticks']
cgroup=api['process_cgroup']
${code}`], { encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('inherited broker invocation channel with per-frame kernel credentials', () => {
  it.each(['valid', 'foreign-copy', 'rights', 'rights-truncated', 'oversized', 'wrong-uid'])(
    'authenticates the actual sender and closes rejected rights (%s)', kind => {
      expect(probe(`
kind=${JSON.stringify(kind)}
left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
left.setsockopt(socket.SOL_SOCKET,socket.SO_PASSCRED,1)
release_read,release_write=os.pipe()
pid=os.fork()
if pid == 0:
 left.close(); os.close(release_write)
 try:
  right.send(b'first')
  if kind == 'foreign-copy':
   foreign=os.fork()
   if foreign == 0:
    right.send(b'foreign'); os.read(release_read,1); os._exit(0)
   os.waitpid(foreign,0)
  elif kind in ('rights','rights-truncated'):
   fd=os.open('/dev/null',os.O_RDONLY)
   rights=array.array('i',[fd]*(32 if kind == 'rights-truncated' else 1))
   right.sendmsg([b'rights'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,rights)])
   os.close(fd)
  elif kind == 'oversized': right.send(b'x'*(16*1024+1))
  elif kind == 'valid': right.send(b'second')
  os.read(release_read,1)
 finally: os._exit(0)
right.close(); os.close(release_read)
channel=Channel(left.fileno(),pid=pid,start_ticks=ticks(pid),uid=os.getuid()+(1 if kind=='wrong-uid' else 0),cgroup=cgroup(pid))
try:
 if kind == 'wrong-uid':
  try: channel.receive()
  except Refusal as error: assert str(error) == 'frame_sender_mismatch'
  else: raise AssertionError('foreign UID admitted')
 else:
  assert channel.receive() == b'first'
  before=len(os.listdir('/proc/self/fd'))
  if kind == 'valid':
   assert channel.receive() == b'second'
   channel.send(b'response')
  else:
   try: channel.receive()
   except Refusal as error:
    assert str(error) == ('frame_sender_mismatch' if kind=='foreign-copy' else 'frame_or_ancillary_invalid')
   else: raise AssertionError('forbidden frame admitted')
  assert len(os.listdir('/proc/self/fd')) == before, 'received fd leaked'
finally:
 channel.close(); channel.close(); left.close()
 os.write(release_write,b'xx'); os.close(release_write); os.waitpid(pid,0)
print('KERNEL_CREDENTIAL_CONTROL_PASSED')`)).toBe('KERNEL_CREDENTIAL_CONTROL_PASSED');
    });

  it('refuses stale process ticks, wrong cgroup and a pathname reconnect even from the same UID', () => {
    expect(probe(`
left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_SEQPACKET)
before=len(os.listdir('/proc/self/fd'))
for wrong in ('ticks','cgroup'):
 try:
  Channel(left.fileno(),pid=os.getpid(),start_ticks='0' if wrong=='ticks' else ticks(os.getpid()),
          uid=os.getuid(),cgroup='foreign' if wrong=='cgroup' else cgroup(os.getpid()))
 except Refusal: pass
 else: raise AssertionError('stale process identity admitted')
 assert len(os.listdir('/proc/self/fd')) == before, 'failed constructor leaked fd'
with tempfile.TemporaryDirectory(prefix='broker-channel-') as root:
 listener=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET)
 listener.bind(root+'/channel'); listener.listen(1)
 client=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET); client.connect(root+'/channel')
 accepted,_=listener.accept()
 try:
  try: Channel(accepted.fileno(),pid=os.getpid(),start_ticks=ticks(os.getpid()),uid=os.getuid(),cgroup=cgroup(os.getpid()))
  except Refusal as error: assert str(error) == 'inherited_socketpair_required'
  else: raise AssertionError('reconnected socket admitted')
 finally: accepted.close();client.close();listener.close()
left.close();right.close()
print('INSTANCE_AND_INHERITANCE_CONTROLS_PASSED')`)).toBe('INSTANCE_AND_INHERITANCE_CONTROLS_PASSED');
  });
});
