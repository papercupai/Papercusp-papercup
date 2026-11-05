import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import ts from 'typescript';
import {
  FORCED_RECONNECT_CAP,
  forcedReconnectEnvelope,
  hostHonoursForcedReconnect,
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
    writeFileSync(
      metadataPath,
      JSON.stringify({ ownerId, sock: socketPath, caps: ['mcp-reconnect', FORCED_RECONNECT_CAP] }),
      { mode: 0o600 },
    );
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

  // EI-26553022496923180: an interactive host never adopts newer host code, so a
  // host loaded before the forced-reconnect fix reads "connected" and no-ops.
  // Sending to it would leave the agent waiting on a heal that never runs.
  it.each([
    ['no caps field (pre-WI-1804 host)', undefined],
    ['caps without the force cap (pre-EI-26532826938565424 host)', ['carry-respawn', 'mcp-reconnect']],
  ])('sends nothing and names the carry-respawn rung for a host with %s', async (_label, caps) => {
    const dir = fixtureDir();
    const ownerId = 'su-stale-host';
    const socketPath = join(dir, 'current.sock');
    const metadataPath = join(dir, `${ownerId}.json`);
    let connections = 0;
    const server = net.createServer((conn) => {
      connections += 1;
      conn.end();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    writeFileSync(
      metadataPath,
      JSON.stringify({ ownerId, sock: socketPath, hostCodeVersion: 'loaded-old', ...(caps ? { caps } : {}) }),
      { mode: 0o600 },
    );
    chmodSync(metadataPath, 0o600);
    cleanups.push(() => server.close());

    const result = await reconnectCurrentSession({ ownerId, dir, timeoutMs: 500 });
    expect(result).toMatchObject({
      ok: false,
      reason: 'host-cannot-force-reconnect',
      ownerId,
      socketPath,
      hostCodeVersion: 'loaded-old',
    });
    expect(result.next).toContain('node scripts/mcp-call.mjs session:request-compaction');
    expect(result.next).toContain(`--client ${ownerId}`);
    const argsJson = /session:request-compaction '([^']*)'/.exec(result.next)?.[1];
    expect(JSON.parse(argsJson ?? 'null')).toMatchObject({ autoContinue: true });
    expect(connections).toBe(0);
  });

  it('pins the host advertising the force cap the script checks for', () => {
    expect(hostHonoursForcedReconnect({ caps: [FORCED_RECONNECT_CAP] })).toBe(true);
    expect(hostHonoursForcedReconnect({ caps: 'mcp-reconnect-force' })).toBe(false);
    expect(hostHonoursForcedReconnect(null)).toBe(false);
    const hostSource = readFileSync(new URL('./psu-pty-host.mjs', import.meta.url), 'utf8');
    const advertisesForceCap = (source: string) => {
      const file = ts.createSourceFile('host.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      let found = false;
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'caps'
          && ts.isArrayLiteralExpression(node.initializer)) {
          found ||= node.initializer.elements.some((element) => ts.isStringLiteral(element) && element.text === FORCED_RECONNECT_CAP);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
      return found;
    };
    // Conditional spread arrays must not truncate the outer capability list.
    expect(advertisesForceCap("const host = { caps: ['carry-respawn', ...(enabled ? ['conditional'] : []), 'mcp-reconnect-force'] };" )).toBe(true);
    expect(advertisesForceCap("const host = { caps: ['carry-respawn', ...(enabled ? ['mcp-reconnect-force'] : [])] };" )).toBe(false);
    expect(advertisesForceCap(hostSource)).toBe(true);
    expect(advertisesForceCap(hostSource.replaceAll(`'${FORCED_RECONNECT_CAP}'`, "'removed-force-cap'"))).toBe(false);
  });
});
