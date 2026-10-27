/**
 * Forkserver integration suite (plan sidecar-forkserver-2026-10-21, WI-6554700010019379).
 *
 * Real processes throughout: the forkserver is the real `node -e` program, and the
 * children are real `sh` commands. The test process stands in for the sidecar.
 *
 *  - R-1 / SPEC-P-002 / SPEC-P-002-BURST: children are forked by the forkserver, not by
 *    this process, and a 50-exec burst keeps this process's event-loop delay p99 low.
 *  - R-2 / SPEC-P-001: exit codes, stdout/stderr text, handoff files, spawn errors and
 *    process-group kills match a direct spawn.
 *  - R-3 / SPEC-P-002-CRASH: killing the forkserver mid-exec settles the exec as an
 *    infrastructure fault before its timeout, kills the orphaned group, and the next
 *    exec succeeds on a restarted forkserver.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { currentForkserverProcess, FORKSERVER_LOST_CODE, forkserverStats, spawnSidecarChild,
  forkserverContainmentIdentity, prepareForkserverContainment, type SidecarChild } from './forkserver-client';
import { createTextCollector } from '../../child-output.js';
import { execProcess, type ExecProcessDeps } from '../sidecar-exec-process';
import type { GovernedExecution } from '../../resource-governor/execution';
import { captureSidecarContainment, observeSidecarExit } from '../sidecar-exec-lifetime';
import { execFileViaSidecar, isSidecarInfrastructureFault } from '../git-via-sidecar';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { linuxProcStateFromStat } from '../../process-identity';

// Keep the production launcher and real kernel scopes; only the unrelated
// durable ledger/flag stores are hermetic in this process integration suite.
vi.mock('../../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../../task-manager/store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId: string }) => ({ taskId: opts.taskId, state: 'pending' }),
  markSpawned: async () => {}, closeTask: async () => {},
}));

const linux = process.platform === 'linux';
let dir = '';

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'forkserver-it-')); });
afterAll(async () => {
  currentForkserverProcess()?.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
});

interface Outcome { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; events: string[]; error?: NodeJS.ErrnoException }

function collect(child: Pick<SidecarChild, 'on' | 'once' | 'stdout' | 'stderr'>): Promise<Outcome> {
  return new Promise((resolve) => {
    const out: Outcome = { code: null, signal: null, stdout: '', stderr: '', events: [] };
    createTextCollector(child.stdout, {
      retainText: false,
      onDecodedText: (text) => { out.stdout += text; },
    });
    const stderrCollector = createTextCollector(child.stderr, {
      retainText: false,
      onDecodedText: (text) => { out.stderr += text; },
    });
    child.once('spawn', () => out.events.push('spawn'));
    child.on('error', (e: NodeJS.ErrnoException) => {
      out.events.push('error'); out.error = e;
      if (e.code === FORKSERVER_LOST_CODE) { stderrCollector.text(); resolve(out); }
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      stderrCollector.text();
      out.events.push('close'); out.code = code; out.signal = signal; resolve(out);
    });
  });
}

const env = { ...process.env } as NodeJS.ProcessEnv;
const viaForkserver = async (command: string, args: string[], extra: Partial<Parameters<typeof spawnSidecarChild>[0]> = {}) =>
  collect(await spawnSidecarChild({ command, args, env, detached: true, ...extra }));
const direct = (command: string, args: string[]) =>
  collect(spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as SidecarChild);

function kernelState(pid: number): string {
  try { return linuxProcStateFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8')) ?? 'unknown'; }
  catch (error) {
    return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'gone' : 'unknown';
  }
}

function exited(pid: number): boolean {
  // Signal zero succeeds for an unreaped zombie. Unknown/unreadable state must
  // still fail closed, just as the production process-group exit fence does.
  return ['gone', 'Z', 'X'].includes(kernelState(pid));
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return predicate();
}

async function killIdleForkserver(): Promise<void> {
  const previous = currentForkserverProcess();
  if (!previous) return;
  const events: string[] = [];
  const onExit = () => { events.push('exit'); };
  const onDisconnect = () => { events.push('disconnect'); };
  previous.once('exit', onExit);
  previous.once('disconnect', onDisconnect);
  const before = { pid: previous.pid, kernel: kernelState(previous.pid!),
    exitCode: previous.exitCode, signalCode: previous.signalCode, killed: previous.killed,
    exitListeners: previous.listenerCount('exit'), disconnectListeners: previous.listenerCount('disconnect') };
  const sent = previous.kill('SIGKILL');
  try {
    const retired = await waitFor(() => currentForkserverProcess() === null, 2000);
    expect(retired, JSON.stringify({ before, sent, events, after: {
      pid: currentForkserverProcess()?.pid, kernel: kernelState(previous.pid!),
      exitCode: previous.exitCode, signalCode: previous.signalCode, killed: previous.killed,
      connected: previous.connected, stats: forkserverStats(),
    } })).toBe(true);
  } finally {
    previous.removeListener('exit', onExit);
    previous.removeListener('disconnect', onDisconnect);
  }
}

function governedStub(): GovernedExecution {
  return {
    receiptId: 'forkserver-it', context: {}, lease: { leaseId: 'l', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish: vi.fn(async () => true), cancel: vi.fn(async () => true),
  } as unknown as GovernedExecution;
}

async function measuredExecBurst(spawnChild?: ExecProcessDeps['spawnChild']) {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  try {
    // Arm the timer before synchronous spawn work begins, and include its final
    // delayed tick. An empty histogram must never certify a responsive parent.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(histogram.count).toBeGreaterThan(0);
    histogram.reset();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => execProcess({
      command: 'sh', args: ['-c', `exit ${i % 5}`], timeoutMs: 10_000,
    }, { beginExecution: async () => governedStub(), ...(spawnChild ? { spawnChild } : {}) })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(histogram.count).toBeGreaterThan(0);
    expect(results.map((result) => result.code)).toEqual(Array.from({ length: 50 }, (_, i) => i % 5));
    return { p99Ms: histogram.percentile(99) / 1e6, samples: histogram.count };
  } finally {
    histogram.disable();
  }
}

describe.runIf(linux)('sidecar forkserver', () => {
  it('rejects a stale preflight generation before executing any command', async () => {
    const snapshot = (await prepareForkserverContainment())!;
    expect(snapshot).not.toBeNull();
    const token = forkserverContainmentIdentity(snapshot);
    const previous = currentForkserverProcess()!;
    await killIdleForkserver();
    expect((await viaForkserver('true', [])).code).toBe(0);
    const effect = join(dir, 'stale-fence-effect');
    await expect(spawnSidecarChild({ command: 'sh', args: ['-c', 'echo once > "$1"', 'sh', effect],
      detached: true, env, forkserverIdentity: token })).rejects.toMatchObject({ code: 'SIDECAR_FORKSERVER_FENCE' });
    await expect(readFile(effect, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['abort', 'deadline'] as const)('bounds %s during startup without dispatching or leaking a late generation', async (control) => {
    await killIdleForkserver();
    const launcher = await import('../../task-manager/managed-spawn');
    const launch = launcher.managedSpawn;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = vi.spyOn(launcher, 'managedSpawn').mockImplementation(async (...args) => {
      await gate;
      return launch(...args);
    });
    const effect = join(dir, `startup-${control}`);
    const controller = new AbortController();
    const started = Date.now();
    try {
      const pending = execProcess({ command: 'sh', args: ['-c', 'printf once >> "$1"', 'sh', effect],
        timeoutMs: control === 'deadline' ? 150 : 5000 }, {
        signal: controller.signal, beginExecution: async () => governedStub(),
      });
      if (control === 'abort') setTimeout(() => controller.abort(), 100);
      const result = await pending;
      expect(result.error?.code).toBe(control === 'abort' ? 'ABORT_ERR' : 'ETIMEDOUT');
      expect(isSidecarInfrastructureFault(result)).toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
      await expect(readFile(effect, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      release();
      expect(await waitFor(() => currentForkserverProcess() !== null, 5000)).toBe(true);
      const late = currentForkserverProcess()!.pid;
      const starts = forkserverStats().starts;
      const results = await Promise.all(Array.from({ length: 8 }, () => viaForkserver('true', [])));
      expect(results.every((r) => r.code === 0)).toBe(true);
      expect(currentForkserverProcess()?.pid).toBe(late);
      expect(forkserverStats().starts).toBe(starts);
      expect(delayed).toHaveBeenCalledTimes(1);
      await expect(readFile(effect, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release(); delayed.mockRestore(); }
  });

  it.each(['before-spawn', 'before-ack', 'after-ack', 'close'] as const)(
    'contains commands and never replays through execFileViaSidecar when loss occurs at %s', async (boundary) => {
      await viaForkserver('true', []);
      const server = currentForkserverProcess()!;
      const scopeUnit = readFileSync(`/proc/${server.pid}/cgroup`, 'utf8').trim().split('/').at(-1)!;
      const containment = captureSidecarContainment(scopeUnit, server.pid)!;
      expect(containment).not.toBeNull();
      const effect = join(dir, `effect-${boundary}`);
      const pids = join(dir, `pids-${boundary}`);
      const emit = EventEmitter.prototype.emit.bind(server);
      let stopped = false;
      let closeBoundaryObserved = false;
      const messages = vi.spyOn(server, 'emit').mockImplementation((event: string | symbol, ...args: unknown[]) => {
        const m = args[0] as { t?: string };
        if (event === 'message' && m?.t === 'spawned' && boundary === 'before-ack') {
          // The fork has happened but the caller never learns its PID. Let it
          // create a detached descendant and a durable effect before the crash.
          stopped = true;
          return true;
        }
        if (event === 'message' && stopped) return true;
        return emit(event, ...args);
      });
      const send = boundary === 'before-spawn' ? vi.spyOn(server, 'send').mockImplementationOnce(() => {
        server.kill('SIGKILL'); return true;
      }) : null;
      let childPid = 0;
      const local = vi.fn();
      const result = execFileViaSidecar('sh', ['-c',
        'printf once >> "$1"; setsid sleep 30 >/dev/null 2>&1 & echo "$!" > "$2"; wait', 'sh', effect, pids],
      { timeoutMs: 10_000, subsystem: 'forkserver-crash-window-test' }, {
        sidecarEnabled: () => true, local,
        viaSidecar: (command, args) => execProcess({ command, args, timeoutMs: 10_000 }, {
          beginExecution: async () => governedStub(), onPid: (pid) => { childPid = pid; },
        }),
      }).catch((e: unknown) => e);
      try {
        if (boundary !== 'before-spawn') {
          await vi.waitFor(async () => expect(await readFile(effect, 'utf8')).toBe('once'));
          await vi.waitFor(async () => expect(Number(await readFile(pids, 'utf8'))).toBeGreaterThan(0));
          if (boundary === 'after-ack') expect(await waitFor(() => childPid > 0, 2000)).toBe(true);
          if (boundary === 'close') {
            expect(await waitFor(() => childPid > 0, 2000)).toBe(true);
            // Observe before producing close. Kill the waiting shell first:
            // killing its last descendant first can let wait finish and the
            // shell's group disappear before we signal it.
            messages.mockRestore();
            vi.spyOn(server, 'emit').mockImplementation((event: string | symbol, ...args: unknown[]) => {
              const returned = emit(event, ...args);
              if (event === 'message' && (args[0] as { t?: string })?.t === 'close') {
                closeBoundaryObserved = true;
                server.kill('SIGKILL');
              }
              return returned;
            });
            process.kill(-childPid, 'SIGKILL');
            process.kill(Number(await readFile(pids, 'utf8')), 'SIGKILL');
          } else server.kill('SIGKILL');
        }
        const outcome = await result;
        if (boundary === 'close') expect(closeBoundaryObserved).toBe(true);
        expect(outcome).toBeInstanceOf(Error);
        expect(local).not.toHaveBeenCalled();
        if (boundary !== 'close') expect((outcome as { stderr: string }).stderr).toContain('not re-run');
        expect(await waitFor(() => observeSidecarExit(containment) === 'exited', 5000)).toBe(true);
        if (boundary !== 'before-spawn') expect(await readFile(effect, 'utf8')).toBe('once');
      } finally { send?.mockRestore(); vi.restoreAllMocks(); }
      const next = await viaForkserver('true', []);
      expect(next.code).toBe(0);
      expect(currentForkserverProcess()?.pid).not.toBe(server.pid);
    }, 20_000);

  it.each(['abort', 'deadline'] as const)('bounds a stopped ACK with %s and verifies the scope empty before returning', async (control) => {
    await viaForkserver('true', []);
    const server = currentForkserverProcess()!;
    const scope = readFileSync(`/proc/${server.pid}/cgroup`, 'utf8').trim().split('/').at(-1)!;
    const containment = captureSidecarContainment(scope, server.pid)!;
    server.kill('SIGSTOP');
    const controller = new AbortController();
    const start = Date.now();
    const pending = execProcess({ command: 'sh', args: ['-c', 'echo should-not-run'], timeoutMs: control === 'deadline' ? 150 : 5000 }, {
      signal: controller.signal, beginExecution: async () => governedStub(),
    });
    if (control === 'abort') setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.error?.code).toBe(FORKSERVER_LOST_CODE);
    expect(isSidecarInfrastructureFault(result)).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(observeSidecarExit(containment)).toBe('exited');
    expect((await viaForkserver('true', [])).code).toBe(0);
  });

  it('a command run through the forkserver exits with the same code as a direct spawn', async () => {
    const script = 'printf out; printf err >&2; exit 3';
    const [a, b] = [await viaForkserver('sh', ['-c', script]), await direct('sh', ['-c', script])];
    expect(a.code).toBe(3);
    expect({ code: a.code, signal: a.signal, stdout: a.stdout, stderr: a.stderr, events: a.events })
      .toEqual({ code: b.code, signal: b.signal, stdout: b.stdout, stderr: b.stderr, events: b.events });
  });

  it('preserves output when spawn acknowledgement and close arrive in the same IPC batch', async () => {
    await viaForkserver('true', []);
    const server = currentForkserverProcess()!;
    const send = vi.spyOn(server, 'send').mockImplementationOnce((message) => {
      const { id } = message as { id: number };
      // IPC arrives from an event-loop callback, where nextTick stream drains
      // precede promise continuations. Deliver the complete protocol in one batch.
      setImmediate(() => {
        server.emit('message', { t: 'spawned', id, pid: server.pid });
        server.emit('message', { t: 'spawn', id });
        server.emit('message', { t: 'out', id, d: Buffer.from('committed-blob\n') });
        server.emit('message', { t: 'err', id, d: Buffer.from('diagnostic\n') });
        server.emit('message', { t: 'out-end', id });
        server.emit('message', { t: 'err-end', id });
        server.emit('message', { t: 'exit', id, code: 0, signal: null });
        server.emit('message', { t: 'close', id, code: 0, signal: null });
      });
      return true;
    });
    try {
      const result = await viaForkserver('git', ['ls-tree', 'HEAD']);
      expect(result).toMatchObject({ code: 0, stdout: 'committed-blob\n', stderr: 'diagnostic\n' });
      expect(result.events.at(-1)).toBe('close');
    } finally {
      send.mockRestore();
    }
  });

  it('the production execProcess route gives children the forkserver as their parent', async () => {
    const fallbacks = forkserverStats().fallbacks;
    const r = await execProcess({ command: process.execPath,
      args: ['-e', 'process.stdout.write(String(process.ppid))'] },
    { beginExecution: async () => governedStub() });
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toMatch(/^[1-9]\d*$/);
    const ppid = Number(r.stdout.trim());
    expect(ppid).toBe(currentForkserverProcess()?.pid);
    expect(ppid).not.toBe(process.pid);
    expect(forkserverStats().fallbacks).toBe(fallbacks);
  });

  it('reports a missing command with the same error a direct spawn reports', async () => {
    const [a, b] = [await viaForkserver('no-such-cmd-forkserver-it', []), await direct('no-such-cmd-forkserver-it', [])];
    expect(a.error?.code).toBe('ENOENT');
    expect(String(a.error)).toBe(String(b.error));
    expect(a.events).toEqual(b.events);
  });

  it('rejects a synchronous spawn validation failure before returning a child', async () => {
    await prepareForkserverContainment();
    const server = currentForkserverProcess()!;
    const messages: Array<{ t?: string; id?: number; code?: string }> = [];
    const observe = (raw: unknown) => {
      const message = raw as { t?: string; id?: number; error?: { code?: string } };
      messages.push({ t: message.t, id: message.id, code: message.error?.code });
    };
    server.on('message', observe);
    const sent = vi.spyOn(server, 'send');
    const before = forkserverStats().inFlight;
    try {
      await expect(spawnSidecarChild({
        command: process.execPath, args: ['\0'], env, detached: true,
      })).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
      const requests = sent.mock.calls.map(([raw]) => {
        const request = raw as { t?: string; id?: number; command?: string };
        return { t: request.t, id: request.id, command: request.command };
      });
      expect(forkserverStats().inFlight, JSON.stringify({ before, after: forkserverStats(), requests, messages })).toBe(before);
    } finally {
      sent.mockRestore();
      server.off('message', observe);
    }
    expect((await viaForkserver('true', [])).code).toBe(0);
  });

  it('reads stdin from and writes stdout to the handoff files by path', async () => {
    const inPath = join(dir, 'in.txt');
    const outPath = join(dir, 'out.txt');
    await writeFile(inPath, 'handoff-bytes\n');
    await writeFile(outPath, 'stale');
    const r = await viaForkserver('sh', ['-c', 'cat; echo done >&2'], {
      stdin: { path: inPath, fd: -1 }, stdout: { path: outPath, fd: -1 },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('done\n');
    expect(await readFile(outPath, 'utf8')).toBe('handoff-bytes\n');
  });

  it('proves an unreaped zombie has exited while signal zero still succeeds', async () => {
    const child = await spawnSidecarChild({ command: 'sh', args: ['-c', 'sleep 30 & echo $!; wait'], env, detached: true });
    const done = collect(child);
    let grandchild = 0;
    child.stdout?.once('data', (d: Buffer) => { grandchild = Number(d.toString().trim()); });
    try {
      expect(await waitFor(() => grandchild > 0, 5_000)).toBe(true);
      process.kill(child.pid!, 'SIGSTOP');
      expect(await waitFor(() => kernelState(child.pid!) === 'T', 5_000)).toBe(true);
      process.kill(grandchild, 'SIGTERM');
      expect(await waitFor(() => kernelState(grandchild) === 'Z', 5_000)).toBe(true);
      expect(() => process.kill(grandchild, 0)).not.toThrow();
      expect(exited(grandchild)).toBe(true);
    } finally {
      try { process.kill(child.pid!, 'SIGCONT'); } catch { /* already exited */ }
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
      await done;
    }
  });

  it('a SIGTERM to the process group kills the child and its grandchild', async () => {
    const child = await spawnSidecarChild({ command: 'sh', args: ['-c', 'sleep 30 & echo $!; wait'], env, detached: true });
    const done = collect(child);
    let grandchild = 0;
    child.stdout?.once('data', (d: Buffer) => { grandchild = Number(d.toString().trim()); });
    expect(await waitFor(() => grandchild > 0, 5_000)).toBe(true);
    process.kill(-child.pid!, 'SIGTERM');
    const r = await done;
    expect(r.signal).toBe('SIGTERM');
    expect(await waitFor(() => exited(grandchild), 5_000), `grandchild ${grandchild} state=${kernelState(grandchild)}`).toBe(true);
  });

  it('when the forkserver is killed mid-exec, execProcess settles an infrastructure fault before the timeout and the next exec succeeds', async () => {
    const started = Date.now();
    const effectPath = join(dir, 'crash-exec-effects');
    const pending = execProcess({ command: 'sh', args: ['-c', 'printf once >> "$1"; sleep 30', 'sh', effectPath], timeoutMs: 20_000 }, { beginExecution: async () => governedStub() });
    expect(await waitFor(() => forkserverStats().inFlight === 1, 5_000)).toBe(true);
    await vi.waitFor(async () => expect(await readFile(effectPath, 'utf8')).toBe('once'));
    const before = currentForkserverProcess();
    before!.kill('SIGKILL');
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.code).toBe(-1);
    expect(result.error?.code).toBe(FORKSERVER_LOST_CODE);
    expect(result.stderr).toContain('not re-run');
    const next = await execProcess({ command: 'sh', args: ['-c', 'echo again'] }, { beginExecution: async () => governedStub() });
    expect(next).toMatchObject({ code: 0, stdout: 'again\n' });
    expect(currentForkserverProcess()?.pid).not.toBe(before!.pid);
    // A replay could retain the fault message. The command's durable effect
    // independently proves it ran once across settlement and the next exec.
    expect(await readFile(effectPath, 'utf8')).toBe('once');
  });

  it('during a burst of 50 concurrent execs this process keeps its event-loop delay p99 under 20 ms', async () => {
    await viaForkserver('true', []); // warm: the forkserver is running before measuring
    const fallbacks = forkserverStats().fallbacks;
    const measured = await measuredExecBurst();
    expect(measured.p99Ms, JSON.stringify(measured)).toBeLessThan(20);
    expect(forkserverStats().fallbacks).toBe(fallbacks);
  });

  it('the same production-route timing assertion detects parent-loop spawn blocking', async () => {
    let priorSpawn = Promise.resolve();
    const measured = await measuredExecBurst((request) => {
      // Counterfactual: put the measured ~25 ms fork/exec wait back on the
      // calling loop. Use real children and the same execProcess guards/oracle.
      // Yield between starts so the timer observes repeated stalls; one long
      // batch could otherwise be discarded by the 99th-percentile statistic.
      const next = priorSpawn.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const until = performance.now() + 25;
        while (performance.now() < until) { /* injected parent fork/exec stall */ }
        return spawn(request.command, request.args, { cwd: request.cwd, env: request.env,
          detached: request.detached, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as SidecarChild;
      });
      priorSpawn = next.then(() => {});
      return next;
    });
    expect(measured.p99Ms, JSON.stringify(measured)).toBeGreaterThanOrEqual(20);
  });

});
