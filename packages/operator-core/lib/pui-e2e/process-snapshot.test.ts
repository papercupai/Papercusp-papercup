import { spawn } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';
import { resolveGovernedProcessTree } from '../../../../scripts/lib/governed-test-process.mjs';
import { captureProcessSnapshot } from './process-snapshot';

describe.skipIf(process.platform !== 'linux')('PUI pre-cleanup process observer', () => {
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
