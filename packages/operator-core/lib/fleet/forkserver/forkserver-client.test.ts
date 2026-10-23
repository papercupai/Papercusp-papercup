import { afterAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';

const wire = vi.hoisted(() => ({
  outcome: { code: null as number | null, signal: null as NodeJS.Signals | null,
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
}));

// Unit boundary: only the server process/kernel enclosure are doubles. The
// public client, IPC message handling, Readables and event order are real.
// The integration suite separately executes the actual server and scopes.
vi.mock('@papercusp/module-singleton', () => ({ pinModuleState: (_key: string, create: () => unknown) => create() }));
vi.mock('../sidecar-exec-lifetime', () => ({
  captureSidecarContainment: (scopeUnit: string, pid: number) => ({
    scopeUnit, pid, identity: 'unit-wire', rootIdentity: 'unit-root',
    cgroupPath: '/unit-wire', cgroupIdentity: 'unit-cgroup',
  }),
  reapDeadSidecar: async () => true,
}));
vi.mock('../../task-manager/control', () => ({ killScopeUnit: async () => {} }));
vi.mock('../../task-manager/managed-spawn', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    markManagedSpawnTeardown: () => {},
    managedSpawn: async (_command: string, _args: string[], _spec: unknown,
      opts: { onSpawn: (proc: unknown) => void }) => {
      const proc = Object.assign(new EventEmitter(), {
        pid: 41001, ref: () => {}, unref: () => {}, kill: () => true,
        send: (request: { t: string; id: number }, callback: (error: Error | null) => void) => {
          callback(null);
          setImmediate(() => {
            const id = request.id;
            proc.emit('message', { t: 'spawned', id, pid: 41002 });
            proc.emit('message', { t: 'spawn', id });
            // Split multibyte output and deliver close in the same IPC batch:
            // the client must preserve buffered bytes before consumers attach.
            for (const [t, bytes] of [['out', wire.outcome.stdout], ['err', wire.outcome.stderr]] as const) {
              for (const byte of bytes) proc.emit('message', { t, id, d: Buffer.from([byte]) });
              proc.emit('message', { t: t === 'out' ? 'out-end' : 'err-end', id });
            }
            proc.emit('message', { t: 'exit', id, code: wire.outcome.code, signal: wire.outcome.signal });
            proc.emit('message', { t: 'close', id, code: wire.outcome.code, signal: wire.outcome.signal });
          });
          return true;
        },
      });
      opts.onSpawn(proc);
      queueMicrotask(() => proc.emit('message', { t: 'ready', pid: proc.pid }));
      return { confined: true };
    },
  };
});

import { currentForkserverProcess, spawnSidecarChild } from './forkserver-client';

afterAll(() => { currentForkserverProcess()?.emit('disconnect'); });

describe.runIf(process.platform === 'linux')('forkserver client wire parity', () => {
  it.each([0, 3, 'SIGTERM'] as const)('preserves the direct command result for %s', async (termination) => {
    const script = `process.stdout.write('héllo'); process.stderr.write('診断'); ` +
      (typeof termination === 'number' ? `process.exit(${termination});` : `process.kill(process.pid, '${termination}');`);
    const direct = spawnSync(process.execPath, ['-e', script]);
    expect(direct.error).toBeUndefined();
    expect(direct.status).toBe(typeof termination === 'number' ? termination : null);
    expect(direct.signal).toBe(typeof termination === 'number' ? null : termination);
    wire.outcome = { code: direct.status, signal: direct.signal,
      stdout: direct.stdout, stderr: direct.stderr };
    const child = await spawnSidecarChild({ command: process.execPath, args: ['-e', script],
      env: process.env, detached: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = [], events: string[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('spawn', () => events.push('spawn'));
    child.on('exit', () => events.push('exit'));
    const [code, signal] = await once(child, 'close');
    expect({ code, signal }).toEqual({ code: direct.status, signal: direct.signal });
    expect(Buffer.concat(stdout)).toEqual(direct.stdout);
    expect(Buffer.concat(stderr)).toEqual(direct.stderr);
    expect(events).toEqual(['spawn', 'exit']);
  });
});
