import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { processGroupLifetime } from './process-group-lifetime';
import { linuxPgrpFromProcStat, linuxProcStateFromStat, linuxStartTicksFromProcStat } from '../process-identity';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe.skipIf(process.platform === 'win32')('process group host shutdown', () => {
  it.skipIf(process.platform !== 'linux').each([false, true])('finishes a kernel-dead group with delayed JS exit=%s without signalling its live outside-group reaper', async delayedExit => {
    const directory = mkdtempSync(join(tmpdir(), 'group-exit-zombie-'));
    const release = join(directory, 'release');
    const testStartTicks = linuxStartTicksFromProcStat(readFileSync(`/proc/${process.pid}/stat`, 'utf8'));
    expect(testStartTicks).toMatch(/^\d+$/);
    // A separate process group keeps the reaper alive. Its child remains in
    // the original group as a real kernel Z record until this test releases it.
    const controller = `import os,time,json,sys
pid=os.fork()
if pid==0: os._exit(0)
os.setpgid(0,0)
deadline=time.monotonic()+10
while open('/proc/'+str(pid)+'/stat').read().split(')')[-1].strip().split()[0]!='Z':
 time.sleep(.01)
print(json.dumps({'dead':pid,'reaper':os.getpid()}),flush=True)
def test_alive():
 try:
  fields=open('/proc/'+sys.argv[2]+'/stat').read().rsplit(')',1)[1].strip().split()
  return fields[0] not in ('Z','X') and fields[19]==sys.argv[3]
 except (FileNotFoundError,ProcessLookupError): return False
while not os.path.exists(sys.argv[1]) and test_alive(): time.sleep(.01)
os.waitpid(pid,0)
`;
    const child = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const reaper = spawn('python3', ['-c', ${JSON.stringify(controller)}, ${JSON.stringify(release)},
        ${JSON.stringify(String(process.pid))}, ${JSON.stringify(testStartTicks)}],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      reaper.stderr.on('data', b => process.stderr.write(b));
      reaper.once('error', e => { console.error(e); process.exit(1); });
      let output = '';
      reaper.stdout.on('data', b => {
        output += b;
        if (output.includes('\\n')) process.send(JSON.parse(output), () => process.exit(0));
      });
    `], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const closed = once(child, 'close');
    const messages: string[] = [];
    // The kernel fixture is real; only the late Node exit notification differs.
    // This reproduces a supervisor waiting before libuv has reaped its child.
    const observedChild = delayedExit ? new Proxy(child, {
      get(target, key, receiver) {
        return key === 'exitCode' || key === 'signalCode' ? null : Reflect.get(target, key, receiver);
      },
    }) : child;
    const lifetime = processGroupLifetime(observedChild, message => messages.push(message));
    let stderr = '';
    let deadPid = 0;
    child.stderr?.on('data', b => { stderr += b; });
    try {
      const fixture = await Promise.race([
        once(child, 'message').then(([value]) => value as { dead: number; reaper: number }),
        closed.then(() => { throw new Error('dead-member fixture exited before readiness: ' + stderr); }),
      ]);
      deadPid = fixture.dead;
      await closed;
      expect(child.exitCode).toBe(0);
      const stat = readFileSync(`/proc/${fixture.dead}/stat`, 'utf8');
      expect(linuxProcStateFromStat(stat)).toBe('Z');
      expect(linuxPgrpFromProcStat(stat)).toBe(child.pid);
      expect(linuxPgrpFromProcStat(readFileSync(`/proc/${fixture.reaper}/stat`, 'utf8'))).not.toBe(child.pid);
      expect(alive(fixture.reaper)).toBe(true);
      expect(() => process.kill(-child.pid!, 0)).not.toThrow();
      await expect(lifetime.waitForExit({ timeoutMs: 250 })).resolves.toBeUndefined();
      expect(alive(fixture.reaper), 'group exit must not kill a live process outside the group').toBe(true);
      const receipt = JSON.parse(messages[0]!.slice('process-group dead members exit evidence: '.length));
      expect(receipt).toMatchObject({ group: child.pid, unreadable: 0, liveMembers: 0 });
      expect(receipt.members).toContainEqual(expect.objectContaining({ pid: fixture.dead, state: 'Z', parentPid: fixture.reaper }));
    } finally {
      writeFileSync(release, 'reap');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      if (deadPid) await vi.waitFor(() => expect(alive(deadPid)).toBe(false), { timeout: 5000 });
      await lifetime.waitForExit({ timeoutMs: 5000 });
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses an unverified exit and then escalates a stubborn group through the maintained exit fence', async () => {
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);",
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stderr = '';
    child.stderr?.on('data', data => { stderr += data; });
    const messages: string[] = [];
    const lifetime = processGroupLifetime(child, message => messages.push(message));
    try {
      await Promise.race([
        once(child.stdout!, 'data'),
        closed.then(() => { throw new Error('helper exited before readiness: ' + stderr); }),
      ]);
      await expect(lifetime.waitForExit({ timeoutMs: 20 })).rejects.toThrow('exit unverified before deadline');
      expect(alive(child.pid!)).toBe(true);
      if (process.platform === 'linux') {
        const evidence = JSON.parse(messages[0]!.slice('process-group exit deadline evidence: '.length));
        expect(evidence.group).toBe(child.pid);
        expect(evidence.members).toContainEqual(expect.objectContaining({ pid: child.pid, parentPid: process.pid,
          state: expect.stringMatching(/^[RSTDI]$/), startTicks: expect.stringMatching(/^\d+$/) }));
        expect(evidence.omitted).toBe(0);
      }
      await lifetime.terminate({ graceMs: 50, killWaitMs: 5000 });
      await closed;
      expect(child.signalCode).toBe('SIGKILL');
      expect(alive(child.pid!)).toBe(false);
      const deadlineReports = messages.filter(message => message.startsWith('process-group exit deadline evidence: '));
      expect(deadlineReports).toHaveLength(1);
      // libuv may reap the child after the fence observes its kernel exit.
      // That additional receipt is valid only when every group member is dead.
      for (const message of messages.filter(message => !deadlineReports.includes(message))) {
        const prefix = 'process-group dead members exit evidence: ';
        expect(message.startsWith(prefix)).toBe(true);
        const evidence = JSON.parse(message.slice(prefix.length));
        expect(evidence).toMatchObject({ group: child.pid, unreadable: 0, omitted: 0, liveMembers: 0 });
        expect(evidence.members.length).toBeGreaterThan(0);
        for (const member of evidence.members) expect(member.state).toMatch(/^[ZX]$/);
      }
    } finally {
      lifetime.signal('SIGKILL');
      await closed;
    }
  }, 10_000);

  it.each(['SIGTERM', 'exit'] as const)('reaps a real helper after host %s', async (ending) => {
    const moduleUrl = new URL('./process-group-lifetime.ts', import.meta.url).href;
    const helper = "process.on('SIGTERM', () => {}); process.send(process.pid); setInterval(() => {}, 1000);";
    const host = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      import { processGroupLifetime } from ${JSON.stringify(moduleUrl)};
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const lifetime = processGroupLifetime(child, message => process.stderr.write(message));
      child.on('close', () => void lifetime.waitForExit());
      child.on('message', pid => { process.send(pid); child.disconnect(); });
      process.on('message', () => process.exit(0));
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let helperPid = 0;
    let stderr = '';
    host.stderr?.on('data', (data) => { stderr += data; });
    const closed = once(host, 'close');
    try {
      helperPid = await Promise.race([
        once(host, 'message').then(([pid]) => Number(pid)),
        closed.then(() => { throw new Error(`host exited before fixture ready: ${stderr}`); }),
      ]);
      expect(alive(helperPid)).toBe(true);
      if (ending === 'exit') host.send('exit');
      else host.kill(ending);
      await closed;
      await vi.waitFor(() => expect(alive(helperPid)).toBe(false), { timeout: 5000 });
    } finally {
      if (alive(host.pid!)) host.kill('SIGKILL');
      if (helperPid && alive(helperPid)) process.kill(-helperPid, 'SIGKILL');
      await closed;
    }
  }, 20_000);
});
