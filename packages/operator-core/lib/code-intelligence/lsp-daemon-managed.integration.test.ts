/** Real child process and cgroup proof for the operator's managed daemon path. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ManagedSpawnResult } from '../task-manager/managed-spawn';

const fixture = vi.hoisted(() => ({ task: null as ManagedSpawnResult | null }));
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../task-manager/store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId: string }) => ({ taskId: opts.taskId, state: 'pending' }),
  markSpawned: async () => {}, closeTask: async () => {},
}));
vi.mock('../task-manager/managed-spawn', async (importOriginal) => {
  const original = await importOriginal<typeof import('../task-manager/managed-spawn')>();
  return { ...original, managedSpawn: async (...args: Parameters<typeof original.managedSpawn>) => {
    const task = await original.managedSpawn(...args);
    fixture.task = task;
    return task;
  } };
});

import { readLspDaemonAdmission } from './lsp-daemon-client';
import { LSP_DAEMON_SOCKET_ENV } from './lsp-daemon-socket';

let root: string | undefined;
const previousSocket = process.env[LSP_DAEMON_SOCKET_ENV];
afterEach(() => {
  if (fixture.task?.scopeUnit) {
    try { execFileSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', fixture.task.scopeUnit]); }
    catch { /* already terminated */ }
  }
  fixture.task = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (previousSocket === undefined) delete process.env[LSP_DAEMON_SOCKET_ENV];
  else process.env[LSP_DAEMON_SOCKET_ENV] = previousSocket;
});

it.runIf(process.platform === 'linux')('boots a separate managed LSP daemon inside its own live cgroup', async (ctx) => {
  try { execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--', 'true']); }
  catch { ctx.skip('user cgroup scopes unavailable'); return; }
  root = mkdtempSync(join(tmpdir(), 'lsp-managed-daemon-'));
  process.env[LSP_DAEMON_SOCKET_ENV] = join(root, 'daemon.sock');
  const snapshot = await readLspDaemonAdmission('lsp-managed-integration');
  expect(snapshot).toMatchObject({ measured: true, assessment: 'idle' });
  const task = fixture.task;
  expect(task?.confined).toBe(true);
  expect(task?.scopeUnit).toBeTruthy();
  const group = execFileSync('systemctl', ['--user', 'show', task!.scopeUnit!, '-p', 'ControlGroup', '--value'], { encoding: 'utf8' }).trim();
  expect(group).toBeTruthy();
  const pids = readFileSync(join('/sys/fs/cgroup', group, 'cgroup.procs'), 'utf8').trim();
  expect(pids).not.toBe('');
}, 60_000);
