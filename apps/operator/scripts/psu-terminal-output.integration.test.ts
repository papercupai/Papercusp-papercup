// @vitest-environment node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The real POSIX TTY, rather than a fake Writable, is essential here: Node's
// ordinary stdout.write is synchronous only for some descriptor/platform pairs.
const probe = String.raw`
import os,pty,subprocess,time,select,json,sys
module,node=sys.argv[1:]
def run(asynchronous):
 master,slave=pty.openpty()
 setup="import {createTerminalOutput} from "+json.dumps(module)+";"
 setup+="process.stdin.setRawMode(true);process.stdin.on('data',()=>process.stderr.write('INPUT\\n'));setInterval(()=>process.stderr.write('TICK\\n'),30);process.stderr.write('READY\\n');"
 setup+="setTimeout(()=>"+("createTerminalOutput({stdout:process.stdout}).write" if asynchronous else "process.stdout.write")+"('x'.repeat(2*1024*1024)),20);"
 p=subprocess.Popen([node,'--input-type=module','-e',setup],stdin=slave,stdout=slave,stderr=subprocess.PIPE)
 os.close(slave)
 before=b'';after=b'';drained=0
 try:
  deadline=time.monotonic()+5
  while b'READY' not in before and time.monotonic()<deadline:
   if select.select([p.stderr],[],[],.05)[0]:before+=os.read(p.stderr.fileno(),4096)
  if b'READY' not in before:raise RuntimeError('child not ready: '+before.decode(errors='replace'))
  time.sleep(.12);os.write(master,b'z')
  deadline=time.monotonic()+.3
  while time.monotonic()<deadline:
   if select.select([p.stderr],[],[],.02)[0]:before+=os.read(p.stderr.fileno(),4096)
  os.set_blocking(master,False);deadline=time.monotonic()+1
  while time.monotonic()<deadline:
   for fd in select.select([master,p.stderr],[],[],.01)[0]:
    try:data=os.read(fd if isinstance(fd,int) else fd.fileno(),65536)
    except OSError:continue
    if fd==master:drained+=len(data)
    else:after+=data
   if drained>=2*1024*1024 and b'INPUT' in before+after:break
  return {'inputWhileBlocked':b'INPUT' in before,'inputAfterDrain':b'INPUT' in before+after,'ticksWhileBlocked':before.count(b'TICK'),'drained':drained}
 finally:
  p.terminate()
  try:p.wait(timeout=2)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  os.close(master);p.stderr.close()
print(json.dumps({'synchronous':run(False),'asynchronous':run(True)}))
`;

describe.skipIf(process.platform === 'win32')('real terminal output congestion', () => {
  it('keeps input and timers responsive while a terminal reader is stalled', async () => {
    const module = new URL('./psu-terminal-output.mjs', import.meta.url).href;
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn('python3', ['-c', probe, module, process.execPath], {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`TTY probe timed out: ${stderr}`)); }, 15_000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`TTY probe exited ${code}: ${stderr}`));
        else resolve(stdout);
      });
    });
    const observed = JSON.parse(result);
    expect(observed.synchronous.inputWhileBlocked).toBe(false);
    expect(observed.synchronous.inputAfterDrain).toBe(true);
    expect(observed.asynchronous.inputWhileBlocked).toBe(true);
    expect(observed.asynchronous.ticksWhileBlocked).toBeGreaterThan(2);
    expect(observed.asynchronous.drained).toBe(2 * 1024 * 1024);
    console.info('CUSTOMER_TERMINAL_STRESS_JSON=' + JSON.stringify({
      kind: 'pty-stalled-reader', burstBytes: 2 * 1024 * 1024, observed,
    }));
  }, 20_000);
});
