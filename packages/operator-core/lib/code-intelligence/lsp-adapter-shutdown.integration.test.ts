/** The real managed scope must disappear even when its LSP never replies. */
import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { managedSpawn } from '../task-manager/managed-spawn';
import { killScopeUnit } from '../task-manager/control';
import { shutdownLspClient } from './lsp-adapter';

// Registration belongs to this test; confinement and shutdown remain real.
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../task-manager/store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId: string }) => ({ taskId: opts.taskId, state: 'pending' }),
  markSpawned: async () => {}, closeTask: async () => {},
}));

it.runIf(process.platform === 'linux')('drains both a responsive LSP and a nonreplying scope with a grandchild', async () => {
  for (const hang of [false, true]) {
    const script = `
      const { spawn } = require('node:child_process');
      const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
      conn.onRequest('probe', () => ({ pid: process.pid, descendant: descendant.pid }));
      conn.onRequest('shutdown', () => ${hang ? 'new Promise(() => {})' : 'null'});
      conn.onNotification('exit', () => { descendant.kill('SIGTERM'); descendant.once('exit', () => process.exit(0)); });
      ${hang ? "process.on('SIGTERM', () => {});" : ''}
      conn.listen();
    `;
    const task = await managedSpawn(process.execPath, ['-e', script], {
      class: 'sidecar', title: 'lsp-shutdown-integration', argv: [process.execPath, '-e', script],
      launchedBy: 'test:lsp-adapter-shutdown',
    }, { spawnOptions: { stdio: ['pipe', 'pipe', 'pipe'] } });
    expect(task.confined).toBe(true);
    expect(task.scopeUnit).toBeTruthy();
    const child = task.child;
    const terminal = once(child, 'exit');
    const connection = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
    connection.listen();
    let pids: { pid: number; descendant: number } | undefined;
    try {
      pids = await connection.sendRequest('probe');
      expect(pids!.pid).toBeGreaterThan(0);
      expect(pids!.descendant).toBeGreaterThan(0);
      const cgroup = readFileSync(`/proc/${pids!.pid}/cgroup`, 'utf8').trim().split(':').at(-1)!;
      expect(cgroup).toContain(task.scopeUnit!);
      await shutdownLspClient({ connection, child, taskId: task.taskId, scopeUnit: task.scopeUnit });
      await terminal;
      for (const pid of [pids!.pid, pids!.descendant]) {
        await vi.waitFor(() => expect(existsSync(`/proc/${pid}`)).toBe(false), { timeout: 2_000 });
      }
      const procs = `/sys/fs/cgroup${cgroup}/cgroup.procs`;
      expect(existsSync(procs) ? readFileSync(procs, 'utf8').trim() : '').toBe('');
      if (!hang) expect(child.exitCode).toBe(0);
    } finally {
      connection.dispose();
      if (task.scopeUnit) await killScopeUnit(task.scopeUnit, { signal: 'SIGKILL' });
      await terminal;
    }
  }
}, 40_000);
