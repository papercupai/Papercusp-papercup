/** Private SDK/API composition, fictional host authorities, no target state.
 * This is not installed-host qualification; production intentionally refuses. */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixture } from './__fixtures__/vm-copy-authority';
import { callVmCopyAuthorityFromInstallation } from './vm-copy-authority-bridge';
import { decodeVmCopyRequest, evaluateVmCopyAuthority, inspectVmCopyAuthority, vmCopyInspectSchema, type VmCopyRequest } from './vm-copy-authority';

async function privateHost(run: (h: {
  f: ReturnType<typeof fixture>; url: string; requests: VmCopyRequest[];
  production: () => void; calls: string[];
}) => Promise<void>) {
  const f = fixture(Date.now());
  decodeVmCopyRequest(f.request); // Fixture admission before any socket allocation.
  const hosts: Array<{ host: McpServer; transport: StreamableHTTPServerTransport }> = [];
  const requests: VmCopyRequest[] = []; const calls: string[] = []; const errors: unknown[] = [];
  let useProduction = false;
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer private-fixture-token') {
      response.writeHead(401); response.end(); return;
    }
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname !== '/api/mcp' || url.searchParams.get('workspace') !== f.scope.workspaceId ||
      url.searchParams.get('harness') !== f.scope.harnessSlug || url.searchParams.get('client') !== f.scope.ownerId) {
      response.writeHead(403); response.end(); return;
    }
    const host = new McpServer({ name: 'private-vm-copy-fixture', version: '1' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    hosts.push({ host, transport });
    host.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: 'capability:inspect', description: 'fixed fixture', inputSchema: { type: 'object' } },
      { name: 'coord:whoami', description: 'authenticated fixture identity', inputSchema: { type: 'object' } },
    ] }));
    host.server.setRequestHandler(CallToolRequestSchema, async call => {
      calls.push(call.params.name);
      if (call.params.name === 'coord:whoami') return { content: [{ type: 'text', text: JSON.stringify({
        ownerId: f.scope.ownerId, workspaceId: f.scope.workspaceId,
      }) }] };
      if (call.params.name !== 'capability:inspect') throw new Error('unexpected-tool');
      try {
        const args = vmCopyInspectSchema.parse(call.params.arguments);
        requests.push(args.request);
        const signed = useProduction
          ? await inspectVmCopyAuthority(args.request, { principal: { slug: 'private-authenticated-principal' } })
          : await evaluateVmCopyAuthority(args.request, f.host);
        return { content: [{ type: 'text', text: JSON.stringify(signed) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false }) }] };
      }
    });
    try { await host.connect(transport); await transport.handleRequest(request, response); }
    catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('private-port-unavailable');
  try {
    await run({ f, url: `http://127.0.0.1:${address.port}/api/mcp`, requests, calls, production: () => { useProduction = true; } });
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled(hosts.map(async ({ host, transport }) => { await host.close(); await transport.close(); }));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
}

describe('fixed managed authenticated copy-authority composition', () => {
  it('authenticates and verifies fresh signed responses for both phases on a private socket', async () => {
    await privateHost(async ({ f, url, requests, calls }) => {
      const installation = { url, bearer: 'private-fixture-token', devicePubkey: f.host.devicePubkey, scope: f.scope };
      for (const phase of ['preflight', 'prepublish'] as const) {
        const verdict = await callVmCopyAuthorityFromInstallation(installation, f.raw, phase);
        expect(verdict.decision).toBe('allow'); expect(verdict.manifestSha256).toBe(f.request.manifestSha256);
      }
      expect(calls).toEqual(['coord:whoami', 'capability:inspect', 'coord:whoami', 'capability:inspect']);
      expect(requests.map(r => r.phase)).toEqual(['preflight', 'prepublish']);
      expect(new Set(requests.map(r => r.challenge)).size).toBe(2);
      expect(requests.every(r => r.manifestRawBase64 === f.request.manifestRawBase64)).toBe(true);
    });
  });
  it('refuses revocation between preflight and publication over the authenticated route', async () => {
    await privateHost(async ({ f, url }) => {
      const installation = { url, bearer: 'private-fixture-token', devicePubkey: f.host.devicePubkey, scope: f.scope };
      await callVmCopyAuthorityFromInstallation(installation, f.raw, 'preflight');
      f.host.standing = async () => 'revoked';
      await expect(callVmCopyAuthorityFromInstallation(installation, f.raw, 'prepublish')).rejects.toThrow('transport-refused');
    });
  });
  it('preserves the production refusal even after authenticated transport succeeds', async () => {
    await privateHost(async ({ f, url, production }) => {
      production();
      await expect(callVmCopyAuthorityFromInstallation({ url, bearer: 'private-fixture-token',
        devicePubkey: f.host.devicePubkey, scope: f.scope }, f.raw, 'preflight')).rejects.toThrow('transport-refused');
    });
  });
  it('an invalid session credential never reaches the evaluator', async () => {
    await privateHost(async ({ f, url, calls }) => {
      await expect(callVmCopyAuthorityFromInstallation({ url, bearer: 'invalid',
        devicePubkey: f.host.devicePubkey, scope: f.scope }, f.raw, 'preflight')).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  });
});
