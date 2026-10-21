/** Real current-build HTTP MCP proof; unit controls live in carry-tool-preload.test.ts. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

// Like public-manual-mcp.e2e.test.ts, opt in to a verified serving build.
// An absent runtime is unmeasured, never passing live acceptance evidence.
const baseUrl = process.env.OPERATOR_BASE_URL;
const workspace = process.env.PAPERCUSP_WORKSPACE;
const harness = process.env.PAPERCUSP_HARNESS_SLUG;

describe.runIf(Boolean(baseUrl))('session tool restoration over real HTTP MCP', () => {
  it('refreshes original FULL definitions after direct and nested use, preserves discovery-only compact detail, and isolates reconnects', async () => {
    expect(workspace, 'explicit workspace required').toBeTruthy();
    expect(harness, 'explicit harness required').toBeTruthy();
    async function servingSha() {
      const response = await fetch(new URL('/api/health', baseUrl), {
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.ok, 'serving build identity required').toBe(true);
      const body = await response.json() as { sha?: string };
      expect(body.sha, 'serving build SHA required').toMatch(/^[0-9a-f]{7,40}$/);
      return body.sha!;
    }
    const buildSha = await servingSha();
    const tokenPath = process.env.PAPERCUSP_MCP_TOKEN_FILE ?? join(
      process.env.PAPERCUSP_HOME ?? join(homedir(), '.papercusp'), 'superuser-token');
    const token = readFileSync(tokenPath, 'utf8').trim();
    const owner = `su-tool-preload-e2e-${randomUUID()}`;
    const clients: Client[] = [];
    const seed = 'tools:find,tools:invoke,facts:list,mode:get';
    const compact = `${seed},orders:list,coord:whoami`;
    const observations = new Map<Client, {
      notifications: number; snapshots: Tool[][]; refresh: Promise<void>; error?: unknown;
    }>();
    async function connect(identity: string, fullReference = false) {
      const url = new URL('/api/mcp', baseUrl);
      for (const [key, value] of Object.entries({ superuser: '1', workspace: workspace!,
        harness: harness!, client: identity, format: 'json',
        tools: fullReference ? `${seed},orders:list,coord:whoami` : seed,
        ...(fullReference ? {} : { tools_compact: compact }) })) {
        url.searchParams.set(key, value);
      }
      const client = new Client({ name: 'tool-preload-e2e', version: '1.0.0' });
      clients.push(client);
      const state = { notifications: 0, snapshots: [] as Tool[][], refresh: Promise.resolve(), error: undefined as unknown };
      observations.set(client, state);
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        state.notifications++;
        state.refresh = state.refresh.then(async () => {
          state.snapshots.push(await listings(client));
        }).catch(error => { state.error = error; });
        await state.refresh;
      });
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }), { timeout: 20_000 });
      return client;
    }
    async function listings(client: Client) {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    }
    const contract = (tool: Tool | undefined) => {
      expect(tool, 'required definition missing').toBeDefined();
      return { name: tool!.name, description: tool!.description, inputSchema: tool!.inputSchema };
    };
    async function receivedAfterNotification(client: Client, before: number) {
      const state = observations.get(client)!;
      await expect.poll(() => state.snapshots.length, { timeout: 15_000 }).toBeGreaterThan(before);
      await state.refresh;
      expect(state.error, 'client refresh failed').toBeUndefined();
      return state.snapshots.at(-1)!;
    }
    async function call(client: Client, name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args,
        _meta: { outputGroupId: randomUUID() } }, undefined, { timeout: 20_000 });
      expect(result.isError, JSON.stringify(result).slice(0, 800)).not.toBe(true);
    }
    try {
      const reference = await connect(`${owner}-reference`, true);
      const full = new Map((await listings(reference)).map(tool => [tool.name, tool]));
      const first = await connect(owner);
      const initial = await listings(first);
      expect(initial.map(tool => tool.name)).not.toContain('coord:whoami');
      expect(contract(initial.find(tool => tool.name === 'facts:list'))).not.toEqual(contract(full.get('facts:list')));
      let before = observations.get(first)!.snapshots.length;
      await call(first, 'facts:list', { scope: 'owner' });
      const afterDirect = await receivedAfterNotification(first, before);
      expect(contract(afterDirect.find(tool => tool.name === 'facts:list'))).toEqual(contract(full.get('facts:list')));
      expect(contract(afterDirect.find(tool => tool.name === 'mode:get'))).not.toEqual(contract(full.get('mode:get')));

      before = observations.get(first)!.snapshots.length;
      await call(first, 'tools:invoke', { name: 'mode:get', args: {} });
      const afterNested = await receivedAfterNotification(first, before);
      expect(contract(afterNested.find(tool => tool.name === 'mode:get'))).toEqual(contract(full.get('mode:get')));

      await call(first, 'tools:find', { query: 'orders:list' });
      const afterDiscovery = await listings(first);
      const unused = contract(afterDiscovery.find(tool => tool.name === 'orders:list'));
      expect(unused).not.toEqual(contract(full.get('orders:list')));
      await call(first, 'coord:whoami', {});
      await first.close();

      const reconnected = await connect(owner);
      const restored = await listings(reconnected);
      for (const name of ['coord:whoami', 'facts:list', 'mode:get']) {
        expect(contract(restored.find(tool => tool.name === name))).toEqual(contract(full.get(name)));
      }

      const other = await connect(`${owner}-other`);
      const otherListings = await listings(other);
      const otherNames = otherListings.map(tool => tool.name);
      expect(otherNames).not.toContain('coord:whoami');
      expect(otherNames).not.toContain('orders:list');
      expect(contract(otherListings.find(tool => tool.name === 'facts:list'))).toEqual(contract(initial.find(tool => tool.name === 'facts:list')));
      const definitionBytes = (tools: Tool[]) => Buffer.byteLength(JSON.stringify(tools.map(contract)));
      const initialBytes = definitionBytes(initial);
      const continuedBytes = definitionBytes(afterNested);
      expect(continuedBytes).toBeGreaterThan(initialBytes);
      expect(await servingSha(), 'runtime changed during the live proof').toBe(buildSha);
      console.info('session-tool-restoration-proof', JSON.stringify({
        baseUrl, buildSha, owner, workspace, harness,
        direct: 'facts:list', nested: 'mode:get', restored: 'coord:whoami',
        discoveryOnly: 'orders:list', notifications: observations.get(first)!.notifications,
        initialBytes, continuedBytes, isolatedOwner: `${owner}-other`,
      }));
    } finally {
      await Promise.allSettled(clients.map(client => client.close()));
    }
  }, 150_000);
});
