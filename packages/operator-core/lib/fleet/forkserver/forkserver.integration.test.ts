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
import { currentForkserverProcess, FORKSERVER_LOST_CODE, forkserverStats, spawnSidecarChild, type SidecarChild } from './forkserver-client';
import { execProcess } from '../sidecar-exec-process';
import type { GovernedExecution } from '../../resource-governor/execution';

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
    child.stdout?.on('data', (d: Buffer) => { out.stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { out.stderr += d.toString('utf8'); });
    child.once('spawn', () => out.events.push('spawn'));
    child.on('error', (e: NodeJS.ErrnoException) => { out.events.push('error'); out.error = e; if (e.code === FORKSERVER_LOST_CODE) resolve(out); });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      out.events.push('close'); out.code = code; out.signal = signal; resolve(out);
    });
  });
}

const env = { ...process.env } as NodeJS.ProcessEnv;
const viaForkserver = async (command: string, args: string[], extra: Partial<Parameters<typeof spawnSidecarChild>[0]> = {}) =>
  collect(await spawnSidecarChild({ command, args, env, detached: true, ...extra }));
const direct = (command: string, args: string[]) =>
  collect(spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as SidecarChild);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (predicate()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return predicate();
}

function governedStub(): GovernedExecution {
  return {
    receiptId: 'forkserver-it', context: {}, lease: { leaseId: 'l', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish: vi.fn(async () => true), cancel: vi.fn(async () => true),
  } as unknown as GovernedExecution;
}

describe.runIf(linux)('sidecar forkserver', () => {
  it('a command run through the forkserver exits with the same code as a direct spawn', async () => {
    const script = 'printf out; printf err >&2; exit 3';
    const [a, b] = [await viaForkserver('sh', ['-c', script]), await direct('sh', ['-c', script])];
    expect(a.code).toBe(3);
    expect({ code: a.code, signal: a.signal, stdout: a.stdout, stderr: a.stderr, events: a.events })
      .toEqual({ code: b.code, signal: b.signal, stdout: b.stdout, stderr: b.stderr, events: b.events });
  });

  it('every child has the forkserver, not this process, as its parent', async () => {
    const r = await viaForkserver(process.execPath, ['-e', 'process.stdout.write(String(process.ppid))']);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toMatch(/^[1-9]\d*$/);
    const ppid = Number(r.stdout.trim());
    expect(ppid).toBe(currentForkserverProcess()?.pid);
    expect(ppid).not.toBe(process.pid);
  });

  it('reports a missing command with the same error a direct spawn reports', async () => {
    const [a, b] = [await viaForkserver('no-such-cmd-forkserver-it', []), await direct('no-such-cmd-forkserver-it', [])];
    expect(a.error?.code).toBe('ENOENT');
    expect(String(a.error)).toBe(String(b.error));
    expect(a.events).toEqual(b.events);
  });

  it('rejects a synchronous spawn validation failure before returning a child', async () => {
    const before = forkserverStats().inFlight;
    await expect(spawnSidecarChild({
      command: process.execPath, args: ['\0'], env, detached: true,
    })).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
    expect(forkserverStats().inFlight).toBe(before);
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

  it('a SIGTERM to the process group kills the child and its grandchild', async () => {
    const child = await spawnSidecarChild({ command: 'sh', args: ['-c', 'sleep 30 & echo $!; wait'], env, detached: true });
    const done = collect(child);
    let grandchild = 0;
    child.stdout?.once('data', (d: Buffer) => { grandchild = Number(d.toString().trim()); });
    expect(await waitFor(() => grandchild > 0, 5_000)).toBe(true);
    process.kill(-child.pid!, 'SIGTERM');
    const r = await done;
    expect(r.signal).toBe('SIGTERM');
    expect(await waitFor(() => !alive(grandchild), 5_000)).toBe(true);
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
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => viaForkserver('sh', ['-c', `exit ${i % 5}`])));
    h.disable();
    expect(results.map((r) => r.code)).toEqual(Array.from({ length: 50 }, (_, i) => i % 5));
    const p99Ms = h.percentile(99) / 1e6;
    expect(p99Ms).toBeLessThan(20);
  });
});
