import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { linuxProcStateFromStat, readProcessIdentity } from '../process-identity';
import { newTaskId, scopeUnitForTask } from '../task-manager/types';
import { managedSpawn } from '../task-manager/managed-spawn';
import { killScopeUnit } from '../task-manager/control';
import { buildTaskScopeArgv, userManagerBusReachable } from '../systemd-scope';
import { runQualificationCommand } from './checkpoint-qualification-command';
import type { recordStoredQualificationChildScope } from './checkpoint-qualification-transaction';

// This integration suite exercises real OS boundaries. Only the task ledger is replaced. The payloads, systemd scopes, cgroups,
// cancellation, timeout and scope-death control path are real OS operations.
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../task-manager/store', () => ({ registerTask: vi.fn(async () => ({})),
  markSpawned: vi.fn(async () => ({})), closeTask: vi.fn(async () => true) }));

function running(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
  } catch { return false; }
}
async function until(check: () => boolean, timeoutMs: number) {
  const cutoff = Date.now() + timeoutMs;
  while (!check() && Date.now() < cutoff) await new Promise(resolve => setTimeout(resolve, 25));
  expect(check()).toBe(true);
}
const payload = `
  const { spawn } = require('node:child_process');
  process.on('SIGTERM', () => {});
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)'],
    { detached: true, stdio: 'ignore' });
  console.log(JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 100);
`;

describe.runIf(process.platform === 'linux' && userManagerBusReachable())('qualification real process bounds', () => {
  it.each(['inherited', 'builtin-only'])('kills a hung worker and its detached descendant before releasing custody (%s)', async variant => {
    const taskId = newTaskId(), unit = scopeUnitForTask(taskId), pids: number[] = [], operations: string[] = [];
    const kills: Awaited<ReturnType<typeof killScopeUnit>>[] = [];
    const identity = (pid: number) => {
      try { return { pid, identity: readProcessIdentity(pid), state: linuxProcStateFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8')),
        cgroup: readFileSync(`/proc/${pid}/cgroup`, 'utf8') }; }
      catch { return { pid, identity: null }; }
    };
    let launched: ReturnType<typeof identity>[] = [];
    const record = vi.fn<typeof recordStoredQualificationChildScope>(async (_target, change) => {
      operations.push(change.operation);
      if (change.operation === 'release') {
        expect(pids, JSON.stringify({ unit, kills, launched })).toHaveLength(2);
        expect(pids.every(pid => !running(pid)),
          JSON.stringify({ unit, kills, launched, releasing: pids.map(identity) })).toBe(true);
      }
      return { status: 'updated', transaction: {} } as Awaited<ReturnType<typeof recordStoredQualificationChildScope>>;
    });
    let output = '';
    let failure: unknown;
    try {
      try { await runQualificationCommand(process.execPath, ['-e', payload], {
        target: { workspaceId: 'test-process-bounds', installSlug: 'test-process-bounds' },
        progress: { attemptId: 'test', candidate: 'test', runnerId: 'test', runId: 'test', pidIdentity: 'test',
          repairHead: null, root: process.cwd(), taskKey: 'test', runnerIdentity: 'test', updates: [],
          manifest: { schemaVersion: 1, units: [{ id: 'test:worker', kind: 'test', path: 'worker' }] },
          retryStates: [], runContext: 'green-checkpoint' },
        // Keep inherited startup hooks in the reproduction; the builtin-only
        // variant distinguishes startup-hook behavior without replacing it.
        cwd: process.cwd(), env: { ...process.env, ...(variant === 'builtin-only' ? { NODE_OPTIONS: '' } : {}) },
        // Inherited hooks took longer than 750ms in the measured controls.
        // Give that fixture the independently fixed 4s worker bound used by the
        // stalled-process fixture; the death-before-release predicate is exact.
        deadlineEpochMs: Date.now() + 10_000, timeoutMs: variant === 'builtin-only' ? 750 : 4000,
        onOutput(stream, chunk) {
          if (stream !== 'stdout') return;
          output += chunk;
          if (!pids.length && output.includes('\n')) {
            pids.push(...JSON.parse(output.trim()));
            launched = pids.map(identity);
          }
        },
      }, { spawn: (cmd, args, spec, options) => managedSpawn(cmd, args, spec, { ...options, scopeAvailable: true }),
        record, kill: async (...args: Parameters<typeof killScopeUnit>) => {
          const outcome = await killScopeUnit(...args); kills.push(outcome); return outcome;
        }, taskId: () => taskId, now: Date.now }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message, JSON.stringify({ variant, unit, kills, launched, releasing: pids.map(identity) }))
        .toContain('qualification-worker-timeout');
      expect(pids, JSON.stringify({ unit, kills, output })).toHaveLength(2);
      expect(pids.every(pid => !running(pid))).toBe(true);
      expect(operations).toEqual(['enroll', 'release']);
    } finally { await killScopeUnit(unit, { signal: 'SIGKILL' }); }
  }, 20_000);

  it('enforces the OS orphan fuse after the launching parent dies', async () => {
    const taskId = newTaskId(), unit = scopeUnitForTask(taskId);
    const argv = buildTaskScopeArgv([process.execPath, '-e', payload], { unit, slice: 'papercusp-test.slice', runtimeMaxSec: 3,
      extraProperties: ['TimeoutStopSec=1s', 'SendSIGKILL=yes'] });
    const parent = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(${JSON.stringify(argv[0])}, ${JSON.stringify(argv.slice(1))},
        { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
      setInterval(() => {}, 100);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostics = '';
    parent.stdout!.setEncoding('utf8'); // boundary-safe decode (WI-6728)
    parent.stderr!.setEncoding('utf8');
    parent.stdout!.on('data', chunk => { output += chunk; });
    parent.stderr!.on('data', chunk => { diagnostics += chunk; });
    try {
      await until(() => output.includes('\n'), 5000);
      const pids = JSON.parse(output.trim()) as number[];
      expect(pids).toHaveLength(2);
      expect(pids.every(running), diagnostics).toBe(true);
      const exit = once(parent, 'exit');
      parent.kill('SIGKILL'); await exit;
      // No JS cleanup remains in the launcher. systemd must kill both the
      // TERM-resistant payload and its detached descendant at its own bound.
      await until(() => pids.every(pid => !running(pid)), 6000);
    } finally {
      parent.kill('SIGKILL');
      await killScopeUnit(unit, { signal: 'SIGKILL' });
    }
  }, 15_000);
});
