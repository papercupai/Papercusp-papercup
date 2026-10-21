import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import {
  forcedReconnectEnvelope,
  reconnectCurrentSession,
  resolveOwnDiscovery,
} from '../../../scripts/mcp-reconnect.mjs';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-reconnect-cli-'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('mcp-reconnect native-Bash self-serve CLI', () => {
  it('builds an owner-bound forced reconnect envelope', () => {
    expect(JSON.parse(forcedReconnectEnvelope('papercusp-su', 'su-current'))).toEqual({
      v: 1,
      mode: 'mcp-reconnect',
      data: 'papercusp-su',
      force: true,
      ownerId: 'su-current',
    });
  });

  it('reads only the current session discovery record and validates the private socket', async () => {
    const dir = fixtureDir();
    const ownerId = 'su-current';
    const socketPath = join(dir, 'current.sock');
    const metadataPath = join(dir, `${ownerId}.json`);
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    writeFileSync(metadataPath, JSON.stringify({ ownerId, sock: socketPath }), { mode: 0o600 });
    chmodSync(metadataPath, 0o600);
    cleanups.push(() => server.close());

    expect(resolveOwnDiscovery({ ownerId, dir })).toMatchObject({
      ok: true,
      ownerId,
      socketPath,
    });
    expect(resolveOwnDiscovery({ ownerId: '', dir })).toMatchObject({
      ok: false,
      reason: 'missing-PAPERCUSP_SID',
    });
  });

  it('queues force:true through the owner socket and reads the host ACK', async () => {
    const dir = fixtureDir();
    const ownerId = 'su-cli-test';
    const socketPath = join(dir, 'current.sock');
    const metadataPath = join(dir, `${ownerId}.json`);
    const received: string[] = [];
    const server = net.createServer((conn) => {
      const chunks: Buffer[] = [];
      conn.on('data', (chunk) => chunks.push(chunk));
      conn.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        conn.end(`${JSON.stringify({ v: 1, ok: true, reason: 'accepted' })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    writeFileSync(metadataPath, JSON.stringify({ ownerId, sock: socketPath }), { mode: 0o600 });
    chmodSync(metadataPath, 0o600);
    cleanups.push(() => server.close());

    const result = await reconnectCurrentSession({ ownerId, dir, timeoutMs: 500 });
    expect(result).toMatchObject({ ok: true, confirmation: 'acked', ownerId, socketPath });
    expect(JSON.parse(received[0])).toEqual({
      v: 1,
      mode: 'mcp-reconnect',
      data: 'papercusp-su',
      force: true,
      ownerId,
    });
  });
});
