import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createServer as createSocketServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { runWorkbenchCommand, waitForWorkbenchSessionEnd, workbenchSessionList, workbenchSessionSockets } from './workbench-command';

describe('PUI workbench control commands', () => {
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
