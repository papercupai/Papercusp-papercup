import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createServer as createSocketServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { captureWorkbenchSessionEvidence, installWorkbenchPsTrace, preserveWorkbenchSessionLog, runWorkbenchCommand, waitForWorkbenchSessionEnd, workbenchSessionList, workbenchSessionSockets } from './workbench-command';
import type { captureProcessSnapshot } from './process-snapshot';

describe('PUI workbench control commands', () => {
  test.skipIf(process.platform !== 'linux')('traces native ps timing while preserving its streams, status and quoted paths', async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pui ps's trace-"));
    try {
      const trace = installWorkbenchPsTrace(root);
      const env = { ...process.env, PATH: `${trace.binDirectory}:${process.env.PATH}` };
      const args = ['-p', String(process.pid), '-o', 'pid='];
      const native = await runWorkbenchCommand('/usr/bin/ps', args);
      const wrapped = await runWorkbenchCommand('ps', args, { env });
      expect(wrapped).toMatchObject({ status: native.status, stdout: native.stdout, stderr: native.stderr });
      const invalid = await runWorkbenchCommand('ps', ['--pui-invalid-probe-option'], { env });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr.length).toBeGreaterThan(0);
      const records = readFileSync(trace.tracePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records.map((record) => [record.phase, record.status])).toEqual([
        ['start', null], ['end', 0], ['start', null], ['end', 1],
      ]);
      expect(records.every((record) => Number.isFinite(Date.parse(record.at)) && record.pid > 0 && record.parentPid === process.pid)).toBe(true);
      expect(records[1].pid).toBe(records[0].pid);
      expect(Date.parse(records[1].at)).toBeGreaterThanOrEqual(Date.parse(records[0].at));
      expect(records.every((record) => Object.keys(record).sort().join(',') === 'at,parentPid,phase,pid,status')).toBe(true);
      const evidence = await captureWorkbenchSessionEvidence(root, 'none', { psTracePath: trace.tracePath });
      expect(evidence.psTrace).toMatchObject({ observed: true, exists: true, truncated: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test.skipIf(process.platform !== 'linux' || spawnSync('ss', ['--version']).status !== 0)(
    'finds the detached server through its exact socket and retains the chat receipt after exit', async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'pui-evidence-'));
      const contract = path.join(root, 'contract_version_test');
      mkdirSync(contract);
      const socket = path.join(contract, 'pui-chat-42');
      const receipt = path.join(root, 'receipt');
      const server = createSocketServer();
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      const snapshot = vi.fn(async (): Promise<Awaited<ReturnType<typeof captureProcessSnapshot>>> => ({ descendants: ['42 1 S do_wait pui'],
        processCommands: { 42: ['/private/pui', '--solo', '--workbench-pane'] },
        workbenchEnvironment: { 42: { PUI_CHAT_WORKBENCH: 'pui-chat-42', PUI_CHAT_WORKBENCH_TRANSCRIPT: receipt } },
        vanishedPids: [], processProbeElapsedMs: 0, processTreeMethod: 'walk',
        rootThreads: [], vanishedThreads: [], threadProbeError: undefined, threadProbeFailures: [],
        processProbeError: undefined, processProbeFailure: undefined,
      }));
      try {
        const before = await captureWorkbenchSessionEvidence(root, 'pui-chat-42', { snapshot });
        expect(before.probeError, JSON.stringify(before)).toBeUndefined();
        expect(before.socketOwners).toEqual([{ socket, pids: expect.arrayContaining([process.pid]), error: undefined }]);
        expect(snapshot).toHaveBeenCalledWith(process.pid, { includeWorkbenchEnvironment: true, includeRootThreads: true });
        expect(before.chatPanes).toEqual([expect.objectContaining({ pid: 42, environment: expect.objectContaining({ PUI_CHAT_WORKBENCH: 'pui-chat-42' }) })]);
        expect(before.completionReceipt).toMatchObject({ path: receipt, observed: true, exists: false });
        await new Promise<void>((resolve) => server.close(() => resolve()));
        writeFileSync(receipt, ''); // A zero-byte receipt is still completion.
        snapshot.mockImplementation(async () => ({ descendants: [], processCommands: {}, workbenchEnvironment: {},
          vanishedPids: [42], processProbeElapsedMs: 0, processTreeMethod: 'walk',
          rootThreads: [], vanishedThreads: [], threadProbeError: undefined, threadProbeFailures: [],
          processProbeError: undefined, processProbeFailure: undefined }));
        const after = await captureWorkbenchSessionEvidence(root, 'pui-chat-42', { previous: before.identity, snapshot });
        expect(after.sockets).toEqual([]);
        expect(after.chatPanes).toEqual([]);
        expect(after.identity.chatPid).toBe(42);
        expect(after.completionReceipt).toMatchObject({ path: receipt, observed: true, exists: true, isFile: true, bytes: 0 });
      } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    });

  test('captures only the supplied private log with a bounded tail and explicit missing-file state', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pui-private-log-'));
    const logPath = path.join(root, 'zellij.log');
    try {
      const missing = await captureWorkbenchSessionEvidence(root, 'pui-chat-none', { logPath });
      expect(missing.sessionLog).toMatchObject({ path: logPath, observed: true, exists: false });
      writeFileSync(logPath, `${'a'.repeat(70_000)}\nshutdown-tail`);
      const captured = await captureWorkbenchSessionEvidence(root, 'pui-chat-none', { logPath });
      expect(captured.probeError).toBeUndefined();
      expect(captured.sessionLog).toMatchObject({ observed: true, exists: true, truncated: true, bytes: 70_014 });
      expect((captured.sessionLog.text as string).length).toBe(65_536);
      expect(captured.sessionLog.text).toMatch(/shutdown-tail$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('preserves the exact private Zellij log after its fixture directory is removed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pui-session-log-'));
    const fixture = path.join(root, 'fixture');
    const diagnostics = path.join(root, 'diagnostics');
    const logPath = path.join(fixture, 'tmp', 'zellij.log');
    const bytes = Buffer.from('private zellij session log\nfull shutdown tail\n');
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, bytes);
    try {
      const preserved = preserveWorkbenchSessionLog(logPath, diagnostics, 'pui-chat-42');
      expect(preserved).toMatchObject({
        sourcePath: logPath,
        path: path.join(diagnostics, 'pui-chat-42-zellij.log'),
        observed: true,
        exists: true,
        bytes: bytes.length,
      });
      rmSync(fixture, { recursive: true, force: true });
      expect(readFileSync(preserved.path)).toEqual(bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('refuses to treat a socket-owner command failure as an empty healthy observation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pui-evidence-failure-'));
    const contract = path.join(root, 'contract_version_test');
    mkdirSync(contract);
    const server = createSocketServer();
    await new Promise<void>((resolve) => server.listen(path.join(contract, 'pui-chat-42'), resolve));
    try {
      const snapshot = vi.fn();
      const result = await captureWorkbenchSessionEvidence(root, 'pui-chat-42', { snapshot,
        runCommand: async () => ({ status: null, stdout: '', stderr: '', signal: 'SIGTERM' }),
      });
      expect(result.probeError).toBe('workbench diagnostic incomplete');
      expect(result.sockets).toHaveLength(1);
      expect(result.socketOwners[0].error).toMatchObject({ signal: 'SIGTERM' });
      expect(result.completionReceipt).toMatchObject({ observed: false });
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(spawnSync('zellij', ['--version']).status !== 0)(
    'native inventory refuses a nonresponsive server while socket observation still sees it', async () => {
      const root = mkdtempSync('/tmp/pui-z-probe-');
      const socketRoot = path.join(root, 'sockets');
      // zellij-utils 0.44.3 consts::CLIENT_SERVER_CONTRACT_VERSION = 1.
      const contract = path.join(socketRoot, 'contract_version_1');
      mkdirSync(contract, { recursive: true });
      const sockets = new Set<import('node:net').Socket>();
      const server = createSocketServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      const session = 'pui-chat-probe';
      await new Promise<void>((resolve) => server.listen(path.join(contract, session), resolve));
      const env = { PATH: process.env.PATH, HOME: root, TERM: 'xterm-256color', ZELLIJ_SOCKET_DIR: socketRoot };
      try {
        const hung = await runWorkbenchCommand('zellij', ['list-sessions', '--no-formatting'], { env, timeoutMs: 500 });
        expect(sockets.size, 'native inventory must reach the nonresponsive socket').toBeGreaterThan(0);
        expect(hung).toMatchObject({ status: null, signal: 'SIGTERM' });
        expect(() => workbenchSessionList(hung)).toThrow('session inventory failed');
        expect(await workbenchSessionSockets(socketRoot, session)).toHaveLength(1);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await waitForWorkbenchSessionEnd(socketRoot, session, 100);
        const empty = await runWorkbenchCommand('zellij', ['list-sessions', '--no-formatting'], { env, timeoutMs: 2_000 });
        expect(empty).toMatchObject({ status: 1, stdout: '', stderr: 'No active zellij sessions found.\n' });
        expect(workbenchSessionList(empty)).toBe('');
      } finally {
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('serves an operator request while its control child waits for that response', async () => {
    const server = createServer((_request, response) => response.end('operator responsive'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const result = await runWorkbenchCommand(process.execPath, ['-e',
        'require("node:http").get(process.argv[1], r => r.pipe(process.stdout))',
        `http://127.0.0.1:${port}`,
      ], { timeoutMs: 3_000 });
      expect(result).toMatchObject({ status: 0, stdout: 'operator responsive', stderr: '' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('retains a failed control command status and both output streams', async () => {
    const result = await runWorkbenchCommand(process.execPath, ['-e',
      'process.stdout.write("partial list"); process.stderr.write("control failed"); process.exit(7)',
    ]);
    expect(result).toMatchObject({ status: 7, stdout: 'partial list', stderr: 'control failed' });
  });

  test('reports a timed-out command as failed, never as a successful empty session list', async () => {
    const result = await runWorkbenchCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 100 });
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(() => workbenchSessionList(result)).toThrow('session inventory failed');
  });

  test('accepts only the native empty-inventory exit 1 and preserves named sessions', () => {
    expect(workbenchSessionList({ status: 1, stdout: '', stderr: 'No active zellij sessions found.\n' })).toBe('');
    expect(workbenchSessionList({ status: 0, stdout: 'pui-chat-123 [Created 1s ago]\n', stderr: '' }))
      .toContain('pui-chat-123');
    for (const result of [
      { status: 1, stdout: '', stderr: 'Permission denied' },
      { status: 1, stdout: 'partial', stderr: 'No active zellij sessions found.' },
      { status: 1, stdout: '', stderr: 'No active zellij sessions found.', signal: 'SIGTERM' as const },
      { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' },
    ]) expect(() => workbenchSessionList(result)).toThrow('session inventory failed');
  });

  test('a retiring server that never replies remains present until its own socket disappears', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pui-sockets-'));
    const contract = path.join(root, 'contract_version_test');
    mkdirSync(contract);
    const server = createSocketServer(); // No IPC responder: observing retirement must not connect.
    let connections = 0;
    server.on('connection', () => { connections += 1; });
    const socket = path.join(contract, 'pui-chat-123');
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await workbenchSessionSockets(root, 'pui-chat-123')).toEqual([socket]);
      await expect(waitForWorkbenchSessionEnd(root, 'pui-chat-123', 20)).rejects.toThrow('did not retire');
      expect(await workbenchSessionSockets(root, 'pui-chat-unrelated')).toEqual([]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await expect(waitForWorkbenchSessionEnd(root, 'pui-chat-123', 20)).resolves.toBeUndefined();
      expect(connections).toBe(0);
      writeFileSync(socket, 'invalid observation');
      await expect(workbenchSessionSockets(root, 'pui-chat-123')).rejects.toThrow('not a socket');
      await expect(workbenchSessionSockets(path.join(root, 'missing'), 'pui-chat-123')).rejects.toThrow();
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
