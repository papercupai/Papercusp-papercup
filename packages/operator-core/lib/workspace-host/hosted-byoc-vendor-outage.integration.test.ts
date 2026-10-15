/**
 * P-008 / R-6: a vendor control-plane outage cannot stop a customer-hosted turn.
 *
 * The control plane is an isolated child process. The workspace host, its agent
 * loop, and the customer-controlled local ingress remain in this test process.
 * A loopback TCP forward stands in for the provider's IAP/SSM transport; the
 * production connection manager still owns its port, target and lifecycle.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, connect as connectTcp, type Server as TcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { WorkspaceHostTransportProfile } from '@papercusp/deployment-driver';
import { runAgentLoop, type LoopEvent, type LoopTool } from '../agent-loop/loop';
import { textMessage, type ModelPort } from '../agent-loop/model-port';
import {
  LocalWorkspaceHostConnectionManager,
  reserveLoopbackPort,
  type OpenSshTunnelHandle,
} from './local-connection-manager';

const HOST = '127.0.0.1';
const protocol = { minVersion: 1, maxVersion: 1 };

function listen(server: HttpServer | TcpServer, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('server has no TCP address'));
      else resolve(address.port);
    });
  });
}

async function close(server: HttpServer | TcpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startControlPlane(): Promise<{ child: ChildProcess; origin: string }> {
  // A separate PID makes "stopped" observable without touching the shared operator.
  const source = `const {createServer}=require('node:http');const s=createServer((_q,r)=>{r.writeHead(200);r.end('vendor-up')});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [chunk] = await Promise.race([
    once(child.stdout!, 'data'),
    once(child, 'exit').then(() => { throw new Error('isolated control plane exited before listening'); }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('isolated control plane did not listen')), 5_000)),
  ]);
  const port = Number(String(chunk).trim());
  if (!Number.isInteger(port) || port < 1) throw new Error(`invalid control-plane port: ${String(chunk)}`);
  return { child, origin: `http://${HOST}:${port}` };
}

/** Real TCP forwarding; only the provider-specific cloud hop is substituted. */
function localForwardRunner(remotePort: number) {
  return {
    async start(spec: { localPort: number }): Promise<OpenSshTunnelHandle> {
      const sockets = new Set<Socket>();
      const server = createTcpServer((client) => {
        const remote = connectTcp(remotePort, HOST);
        sockets.add(client);
        sockets.add(remote);
        client.on('close', () => sockets.delete(client));
        remote.on('close', () => sockets.delete(remote));
        client.on('error', () => remote.destroy());
        remote.on('error', () => client.destroy());
        client.pipe(remote);
        remote.pipe(client);
      });
      await listen(server, spec.localPort);
      let running = true;
      let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        resolveExit = resolve;
      });
      return {
        exited,
        isRunning: () => running,
        async stop() {
          if (!running) return;
          running = false;
          for (const socket of sockets) socket.destroy();
          await close(server);
          resolveExit({ code: 0, signal: 'SIGTERM' });
        },
      };
    },
  };
}

/** Deterministic model output drives the production loop and a real host file tool. */
async function runCustomerTurn(file: string): Promise<{ finalText: string; steps: number; toolResults: number }> {
  const tool: LoopTool = {
    name: 'read_workspace_content',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: await readFile(file, 'utf8') }),
  };
  let modelCalls = 0;
  const port: ModelPort = {
    async *stream(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: 'tool_call', id: 'customer-read-1', name: tool.name, input: {} };
        yield { type: 'stop', reason: 'tool_use' };
        return;
      }
      const result = request.messages.at(-1)?.content.find((part) => part.type === 'tool_result');
      if (!result || result.type !== 'tool_result' || result.isError) {
        yield { type: 'error', message: 'host file tool did not complete' };
        return;
      }
      yield { type: 'text_delta', text: String((result.content as { content: string }).content) };
      yield { type: 'stop', reason: 'end_turn' };
    },
  };
  const events: LoopEvent[] = [];
  for await (const event of runAgentLoop({
    port, model: 'offline-customer-model', messages: [textMessage('user', 'Read my workspace file')], tools: [tool],
  })) events.push(event);
  const done = events.find((event) => event.type === 'done');
  if (!done || done.type !== 'done' || done.stopReason !== 'complete') {
    throw new Error('customer-local agent turn did not complete');
  }
  return {
    finalText: done.finalText,
    steps: done.steps.length,
    toolResults: events.filter((event) => event.type === 'tool_result' && !event.error).length,
  };
}

describe('hosted BYOC vendor outage through customer-controlled ingress', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  it('runs a customer-local agent turn and reads content after the control-plane process stops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'byoc-vendor-outage-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const marker = 'CUSTOMER_CONTENT_' + root.split('-').at(-1);
    const contentFile = join(root, 'customer-content.txt');
    await writeFile(contentFile, marker);

    const host = createHttpServer(async (request, response) => {
      try {
        if (request.url === '/protocol') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(protocol));
        } else if (request.url === '/file') {
          response.end(await readFile(contentFile));
        } else if (request.url === '/turn' && request.method === 'POST') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(await runCustomerTurn(contentFile)));
        } else {
          response.writeHead(404).end();
        }
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    const hostPort = await listen(host);
    cleanup.push(() => close(host));

    const control = await startControlPlane();
    cleanup.push(async () => {
      if (control.child.exitCode === null && control.child.signalCode === null) {
        control.child.kill('SIGTERM');
        await once(control.child, 'close');
      }
    });
    expect(await (await fetch(control.origin)).text()).toBe('vendor-up');

    let customerOrigin = '';
    const manager = new LocalWorkspaceHostConnectionManager({
      store: { save: async () => {} },
      probeProtocol: async (origin) => (await (await fetch(`${origin}/protocol`)).json()) as typeof protocol,
      retargetUi: async (target) => { customerOrigin = target.origin; },
      tunnelRunner: localForwardRunner(hostPort),
      reservePort: reserveLoopbackPort,
      startupProbeAttempts: 1,
    });
    cleanup.push(async () => { await manager.disconnect(); });
    const profile = {
      kind: 'gcp-iap-ssh', endpoint: 'gcp-iap-ssh://customer-host', features: { tcpForward: true },
    } as WorkspaceHostTransportProfile;
    await manager.connect({
      connectionId: 'customer-ingress', hostId: 'customer-host', profile, clientProtocol: protocol,
      tunnel: { target: 'customer@host', controlPath: join(root, 'iap-control.sock'), remoteOperatorPort: hostPort },
    });
    expect((await fetch(`${customerOrigin}/file`)).status).toBe(200);
    const beforeOutageTurn = await fetch(`${customerOrigin}/turn`, { method: 'POST' });
    expect(beforeOutageTurn.status).toBe(200);
    expect(await beforeOutageTurn.json()).toEqual({ finalText: marker, steps: 2, toolResults: 1 });

    control.child.kill('SIGTERM');
    await once(control.child, 'close');
    await expect(fetch(control.origin)).rejects.toThrow();

    const turn = await fetch(`${customerOrigin}/turn`, { method: 'POST' });
    expect(turn.status).toBe(200);
    expect(await turn.json()).toEqual({ finalText: marker, steps: 2, toolResults: 1 });
    expect(await (await fetch(`${customerOrigin}/file`)).text()).toBe(marker);
    expect(manager.snapshot()).toMatchObject({ status: 'connected', localOrigin: customerOrigin });
  }, 15_000);
});
