// @vitest-environment node
/** Host-channel checks use real PTYs and disposable Node children. The native
 * Codex/production-custody journey remains in the separate integration suite. */
import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, metaPathFor } from '../scripts/psu-pty-host.mjs';
import { launchIdentityAssumeHandoff, makeIdentityAssumeHostPort } from '../scripts/psu-identity-assume.mjs';

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : null; }
};

function launchFixture() {
  const caller = { ownerId: 'test-assume-channel-caller-' + randomUUID(), workspaceId: 'channel-fixture',
    nativeSessionId: randomUUID(), nativePid: 101, hostId: 'channel-host', attachmentId: 'channel-pane', childGeneration: 1 };
  const target = { ownerId: 'test-assume-channel-target-' + randomUUID(), workspaceId: caller.workspaceId,
    advSessionId: 23, backend: 'codex', role: 'su', nativeSessionId: randomUUID(), context: { mode: 'native-resume' } };
  const request = { caller, transitionKey: 'session-assume:' + 'a'.repeat(64), preparationHash: 'b'.repeat(64),
    recoveryRef: 'carry-note:channel-caller', recoveryHash: 'c'.repeat(64), expiresAt: Date.now() + 60_000 };
  const inspection = { ok: true, state: 'handoff-accepted', transitionKey: request.transitionKey,
    preparationHash: request.preparationHash, preparation: { caller, target, expiresAt: request.expiresAt },
    recovery: { checkpointRef: request.recoveryRef, checkpointSha256: request.recoveryHash, returnRef: { ownerId: caller.ownerId } } };
  const handoff = { ownerId: caller.ownerId, fromPid: 100, mode: 'identity-assume',
    assume: { version: 1, request }, args: ['identity-assume'] };
  const session = { id: target.advSessionId, coordOwnerId: target.ownerId, workspaceId: target.workspaceId,
    agent: target.backend, role: target.role, sessionId: target.nativeSessionId };
  const ports = { inspect: vi.fn(async () => structuredClone(inspection)), resolveSession: vi.fn(async () => session),
    accountFor: async () => ({ mode: 'default' }), resume: vi.fn(async (_session: unknown, _options: any) => ({})),
    isAlive: (_pid: number): boolean | null => false,
    baseEnv: { PATH: process.env.PATH, PAPERCUSP_SID: caller.ownerId } };
  return { caller, target, request, inspection, handoff, session, ports };
}

async function channelJourney(controls: boolean) {
  const f = launchFixture();
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  let output = '';
  const stdout = Object.assign(new EventEmitter(), { isTTY: false, columns: 100, rows: 30,
    write(data: string) { output += data; return true; } });
  const runs: Array<{ signals: EventEmitter; done: Promise<number> }> = [];
  const start = (owner: string, native: string, inherited?: { hostId: string; attachmentId: string }) => {
    const signals = new EventEmitter();
    const code = [
      'process.stdout.write("PROMPT:"+process.env.PAPERCUSP_SID+"\\n");',
      'process.stderr.write("STDERR:"+process.env.PAPERCUSP_SID+"\\n");',
      'process.on("SIGWINCH",()=>process.stdout.write("SIZE:"+process.stdout.columns+":"+process.stdout.rows+"\\n"));',
      'process.on("SIGINT",()=>process.stdout.write("INTERRUPTED:"+process.env.PAPERCUSP_SID+"\\n"));',
      'process.stdin.on("data",b=>{const s=String(b).trim();if(s==="exit")process.exit(17);',
      'process.stdout.write("INPUT:"+process.env.PAPERCUSP_SID+":"+s+"\\n")});',
      'setInterval(()=>{},1000);',
    ].join('');
    const identityAssume = makeIdentityAssumeHostPort({ ownerId: owner, inspect: f.ports.inspect,
      reexecCode: 75, writeHandoff: () => null, ...inherited });
    const done = hostThroughPty({ command: process.execPath, args: ['-e', code], cwd: process.cwd(), ownerId: owner,
      env: hermeticEnv({ PAPERCUSP_SID: owner, PAPERCUSP_WORKSPACE: f.caller.workspaceId, PAPERCUSP_AGENT: 'node',
        PAPERCUSP_PSU_REEXEC: '75', PAPERCUSP_PSU_REEXEC_PPID: String(process.ppid) }),
      resolveRespawnNativeId: () => native, identityAssume, signalSource: signals,
      onReexec: () => {}, emitCompacted: () => null, onExit: () => {}, bridgeTty: false, io: { stdin, stdout } });
    const run = { signals, done }; runs.push(run); return run;
  };
  try {
    const caller = start(f.caller.ownerId, f.caller.nativeSessionId);
    const before = await vi.waitFor(() => {
      expect(output).toContain('PROMPT:' + f.caller.ownerId);
      const meta = JSON.parse(readFileSync(metaPathFor(f.caller.ownerId), 'utf8'));
      expect(meta.identityAssume).toHaveProperty('hostId');
      return meta;
    }, { timeout: 5000 });
    Object.assign(f.caller, { nativePid: before.ptyPid, hostId: before.identityAssume.hostId,
      attachmentId: before.identityAssume.attachmentId, childGeneration: before.childGeneration });
    f.handoff.fromPid = before.ptyPid;
    caller.signals.emit('SIGTERM'); await caller.done;
    // An ordinary shutdown promise can settle before node-pty reaps its
    // child. Match the production replacement guard: observe disappearance
    // before asking the launcher to take custody of this channel.
    await vi.waitFor(() => expect(alive(before.ptyPid)).toBe(false), { timeout: 5000 });
    expect(stdin.listenerCount('data')).toBe(0); expect(stdout.listenerCount('resize')).toBe(0);
    let replacement: ReturnType<typeof start> | undefined;
    f.ports.isAlive = alive;
    f.ports.resume.mockImplementation(async (_session, options) => {
      await options.managedAssume.verify();
      replacement = start(f.target.ownerId, f.target.nativeSessionId, options.managedAssume);
      return {};
    });
    await launchIdentityAssumeHandoff(f.handoff, f.ports);
    const after = await vi.waitFor(() => {
      expect(output).toContain('PROMPT:' + f.target.ownerId);
      return JSON.parse(readFileSync(metaPathFor(f.target.ownerId), 'utf8'));
    }, { timeout: 5000 });
    expect(after.identityAssume).toMatchObject(before.identityAssume);
    expect(after.ptyPid).not.toBe(before.ptyPid); expect(alive(before.ptyPid)).toBe(false);
    expect(stdin.listenerCount('data')).toBe(1); expect(stdout.listenerCount('resize')).toBe(1);
    const token = randomUUID(), cutover = output.length;
    stdin.emit('data', Buffer.from(token + '\n'));
    await vi.waitFor(() => expect(output.slice(cutover)).toContain('INPUT:' + f.target.ownerId + ':' + token));
    expect(output.slice(cutover)).not.toContain('INPUT:' + f.caller.ownerId);
    expect(output).toContain('STDERR:' + f.target.ownerId);
    if (controls) {
      Object.assign(stdout, { columns: 147, rows: 53 }); stdout.emit('resize');
      await vi.waitFor(() => expect(output).toContain('SIZE:147:53'));
      stdin.emit('data', Buffer.from('\x03'));
      await vi.waitFor(() => expect(output).toContain('INTERRUPTED:' + f.target.ownerId));
      expect(alive(after.ptyPid)).toBe(true);
      stdin.emit('data', Buffer.from('exit\n'));
      expect(await replacement!.done).toBe(17);
      await vi.waitFor(() => expect(alive(after.ptyPid)).toBe(false), { timeout: 5000 });
      expect(stdin.listenerCount('data')).toBe(0); expect(stdout.listenerCount('resize')).toBe(0);
    }
    expect(f.ports.resume).toHaveBeenCalledOnce();
  } finally {
    for (const run of runs) run.signals.emit('SIGTERM');
    await Promise.allSettled(runs.map(run => run.done));
  }
}

it('R-1 same managed attachment replaces caller execution', () => channelJourney(false), 20_000);
it('R-1 handoff routes prompt input output resize interrupt and exit on same pane', () => channelJourney(true), 20_000);
it('R-1 reject unrelated-window and env-only fake takeover', async () => {
  for (const fault of ['attachment', 'host', 'live-caller', 'env-only']) {
    const f = launchFixture();
    if (fault === 'attachment' || fault === 'host') f.ports.inspect.mockImplementation(async () => ({
      ...structuredClone(f.inspection), preparation: { ...f.inspection.preparation,
        caller: { ...f.caller, [fault === 'host' ? 'hostId' : 'attachmentId']: 'unrelated-window' } } }));
    if (fault === 'live-caller') f.ports.isAlive = () => true;
    if (fault === 'env-only') { f.handoff.mode = 'carry-respawn'; f.ports.baseEnv.PAPERCUSP_SID = f.target.ownerId; }
    await expect(launchIdentityAssumeHandoff(f.handoff, f.ports)).rejects.toThrow();
    expect(f.ports.resume).not.toHaveBeenCalled();
  }
});

it.each([
  { signal: 'SIGTERM', deliverExit: true },
  { signal: 'SIGHUP', deliverExit: true },
  { signal: 'SIGTERM', deliverExit: false },
])('host completion after $signal requires native child exit (delivered=$deliverExit)', async ({ signal, deliverExit }) => {
  const ownerId = 'test-assume-exit-' + randomUUID();
  const signals = new EventEmitter();
  const onExit = vi.fn();
  let releaseExit!: () => void;
  const exitGate = new Promise<void>((resolve) => { releaseExit = resolve; });
  let observeExit!: () => void;
  const nativeExit = new Promise<void>((resolve) => { observeExit = resolve; });
  let output = '';
  let childPid = 0;
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = Object.assign(new EventEmitter(), { isTTY: false,
    write(data: string) { output += data; return true; } });
  const done = hostThroughPty({ command: process.execPath,
    args: ['-e', 'process.stdout.write("READY\\n");setInterval(()=>{},1000)'],
    cwd: process.cwd(), ownerId, env: hermeticEnv({ PAPERCUSP_AGENT: 'node' }),
    signalSource: signals, onExit, emitCompacted: () => null,
    bridgeTty: false, io: { stdin, stdout },
    spawnPty(file: string, args: string[], options: any, realSpawn: any) {
      const child = realSpawn(file, args, options);
      childPid = child.pid;
      const subscribe = child.onExit.bind(child);
      subscribe(() => observeExit());
      return new Proxy(child, {
        get(target, key) {
          if (key === 'onExit') return (listener: any) => subscribe((event: any) => {
            void exitGate.then(() => listener(event));
          });
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
  try {
    await vi.waitFor(() => expect(output).toContain('READY'), { timeout: 5000 });
    signals.emit(signal, signal);
    await nativeExit;
    expect(alive(childPid)).toBe(false);
    // The child is gone but the host has not received its exit event yet.
    // Signals and process absence alone must not publish completed custody.
    const state = await Promise.race([
      done.then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting-for-exit'), 100)),
    ]);
    expect(state).toBe('waiting-for-exit');
    expect(onExit).not.toHaveBeenCalled();
    if (deliverExit) releaseExit();
    const expectedCode = deliverExit ? 0 : 1;
    expect(await done).toBe(expectedCode);
    expect(onExit).toHaveBeenCalledWith(expectedCode, signal);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdout.listenerCount('resize')).toBe(0);
  } finally {
    releaseExit();
    signals.emit('SIGTERM');
    await done;
  }
}, 15_000);
