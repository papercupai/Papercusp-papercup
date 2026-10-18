import { spawn } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';
import { resolveGovernedProcessTree } from '../../../../scripts/lib/governed-test-process.mjs';
import { captureProcessSnapshot } from './process-snapshot';

describe.skipIf(process.platform !== 'linux')('PUI pre-cleanup process observer', () => {
  test('captures live root thread names and wait channels without a host census', async () => {
    const snapshot = await captureProcessSnapshot(process.pid, { includeRootThreads: true });
    expect(snapshot.threadProbeError).toBeUndefined();
    expect(snapshot.rootThreads).toEqual(expect.arrayContaining([expect.objectContaining({ tid: process.pid,
      name: expect.any(String), state: expect.any(String), wchan: expect.any(String) })]));
    expect(snapshot.rootThreads.every((thread) => thread.tid > 0 && thread.name.length > 0)).toBe(true);
  });

  test('retains readable threads and reports unreadable threads separately from ones that exited', async () => {
    const snapshot = await captureProcessSnapshot(123, {
      includeRootThreads: true,
      resolveTree: () => ({ pids: [123], method: 'walk' }),
      listTasks: async (directory) => {
        expect(directory).toBe('/proc/123/task');
        return ['123', '124', '125'];
      },
      readProc: async (file) => {
        if (file.includes('/task/124/')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        if (file.includes('/task/125/')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        if (file.endsWith('/stat')) return '123 (screen with ) name) S 1 0 0';
        if (file.endsWith('/wchan')) return 'futex_wait_queue';
        return 'zellij\0';
      },
    });
    expect(snapshot.rootThreads).toEqual([{ tid: 123, name: 'screen with ) name', state: 'S', wchan: 'futex_wait_queue' }]);
    expect(snapshot.vanishedThreads).toEqual([124]);
    expect(snapshot.threadProbeError).toBe('thread snapshot incomplete');
    expect(snapshot.threadProbeFailures).toEqual([expect.objectContaining({ tid: 125, code: 'EACCES' })]);
    expect(snapshot.processProbeError).toBeUndefined();
  });

  test('captures only allowlisted workbench environment, preserving values containing equals', async () => {
    const snapshot = await captureProcessSnapshot(123, {
      includeWorkbenchEnvironment: true,
      resolveTree: () => ({ pids: [123], method: 'walk' }),
      readProc: async (file) => {
        if (file.endsWith('/stat')) return '123 (pui) S 1 0 0';
        if (file.endsWith('/wchan')) return 'do_wait';
        if (file.endsWith('/cmdline')) return '/private/pui\0--solo\0--workbench-pane\0';
        return 'PUI_CHAT_WORKBENCH=pui-chat-42\0PUI_CHAT_WORKBENCH_TRANSCRIPT=/tmp/receipt=a\0ZELLIJ_SESSION_NAME=pui-chat-42\0ZELLIJ_SOCKET_DIR=/tmp/private\0API_KEY=never-export-this\0PATH=/private\0';
      },
    });
    expect(snapshot.workbenchEnvironment).toEqual({ 123: {
      PUI_CHAT_WORKBENCH: 'pui-chat-42', PUI_CHAT_WORKBENCH_TRANSCRIPT: '/tmp/receipt=a',
      ZELLIJ_SESSION_NAME: 'pui-chat-42', ZELLIJ_SOCKET_DIR: '/tmp/private',
    } });
    expect(JSON.stringify(snapshot)).not.toContain('never-export-this');
    expect(snapshot.processProbeError).toBeUndefined();
  });

  test('marks unreadable workbench environment as incomplete while retaining the command', async () => {
    const snapshot = await captureProcessSnapshot(123, {
      includeWorkbenchEnvironment: true,
      resolveTree: () => ({ pids: [123], method: 'walk' }),
      readProc: async (file) => {
        if (file.endsWith('/stat')) return '123 (pui) S 1 0 0';
        if (file.endsWith('/wchan')) return 'do_wait';
        if (file.endsWith('/cmdline')) return 'pui\0--solo\0--workbench-pane\0';
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    expect(snapshot.processCommands[123]).toEqual(['pui', '--solo', '--workbench-pane']);
    expect(snapshot.processProbeError).toBe('process snapshot incomplete');
    expect(snapshot.processProbeFailure).toEqual([expect.objectContaining({ file: '/proc/123/environ', code: 'EACCES' })]);
  });

  test('captures the live root, child and grandchild with their commands and wait state', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & (sleep 30; true) & wait'], { stdio: 'ignore' });
    const pid = child.pid!;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await vi.waitFor(() => expect(resolveGovernedProcessTree(pid).pids.length).toBeGreaterThanOrEqual(4));
      const snapshot = await captureProcessSnapshot(pid);
      expect(snapshot.processProbeFailure).toBeUndefined();
      expect(snapshot.processTreeMethod).toBe('walk');
      const pids = snapshot.descendants.map((row) => Number(row.split(' ')[0]));
      expect(pids).toContain(pid);
      expect(pids.length).toBeGreaterThanOrEqual(4);
      expect(Object.values(snapshot.processCommands).filter((args) => (args as string[])[0] === 'sleep')).toHaveLength(2);
      expect(snapshot.descendants.every((row) => !row.includes(' unknown '))).toBe(true);
    } finally {
      for (const member of resolveGovernedProcessTree(pid).pids.reverse()) {
        try { process.kill(member, 'SIGKILL'); } catch { /* exited */ }
      }
      await exited;
    }
  });

  test('preserves partial state and a typed failure when argv cannot be read', async () => {
    const snapshot = await captureProcessSnapshot(123, {
      resolveTree: () => ({ pids: [123], method: 'walk' }),
      readProc: async (file) => {
        if (file.endsWith('/stat')) return '123 (name with ) parentheses) S 1 0 0';
        if (file.endsWith('/wchan')) return 'do_wait';
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      },
    });
    expect(snapshot.descendants).toEqual(['123 1 S do_wait name with ) parentheses']);
    expect(snapshot.processProbeError).toBe('process snapshot incomplete');
    expect(snapshot.processProbeFailure).toEqual([expect.objectContaining({ pid: 123, file: '/proc/123/cmdline', code: 'EACCES' })]);
  });

  test('reports an exited root explicitly rather than manufacturing a live row', async () => {
    const snapshot = await captureProcessSnapshot(123, {
      resolveTree: () => ({ pids: [123], method: 'walk' }),
      readProc: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
    });
    expect(snapshot.descendants).toEqual([]);
    expect(snapshot.vanishedPids).toEqual([123]);
    expect(snapshot.processProbeError).toBeUndefined();
  });

  test('bounds a stalled read and retains the failure instead of reporting an empty healthy tree', async () => {
    const snapshot = await captureProcessSnapshot(123, {
      timeoutMs: 20,
      resolveTree: () => ({ pids: [123], method: 'walk' }),
      readProc: (_file, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true });
      }),
    });
    expect(snapshot.processProbeError).toBe('process snapshot incomplete');
    expect(snapshot.processProbeFailure).toEqual([expect.objectContaining({ file: '/proc/123/stat', code: 'ABORT_ERR' })]);
  });
});
