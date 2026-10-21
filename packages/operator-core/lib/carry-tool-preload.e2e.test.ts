/** Real current-build HTTP MCP proof; unit controls live in carry-tool-preload.test.ts. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Like public-manual-mcp.e2e.test.ts, opt in to a verified serving build.
// An absent runtime is unmeasured, never passing live acceptance evidence.
const baseUrl = process.env.OPERATOR_BASE_URL;
const workspace = process.env.PAPERCUSP_WORKSPACE;
const harness = process.env.PAPERCUSP_HARNESS_SLUG;

describe.runIf(Boolean(baseUrl))('session tool restoration over real HTTP MCP', () => {
  it('restores canonical calls on reconnect, observes later nested use, and isolates another owner', async () => {
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
    async function connect(identity: string) {
      const url = new URL('/api/mcp', baseUrl);
      for (const [key, value] of Object.entries({ superuser: '1', workspace: workspace!,
        harness: harness!, client: identity, format: 'json', tools: 'tools:find,tools:invoke' })) {
        url.searchParams.set(key, value);
      }
      const client = new Client({ name: 'tool-preload-e2e', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }), { timeout: 20_000 });
      return client;
    }
    async function names(client: Client) {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        names.push(...page.tools.map(tool => tool.name));
        cursor = page.nextCursor;
      } while (cursor);
      return names;
    }
    async function call(client: Client, name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args,
        _meta: { outputGroupId: randomUUID() } }, undefined, { timeout: 20_000 });
      expect(result.isError, JSON.stringify(result).slice(0, 800)).not.toBe(true);
    }
    try {
      const first = await connect(owner);
      expect(await names(first)).not.toContain('coord:whoami');
      await call(first, 'coord:whoami', {});
      await first.close();

      const reconnected = await connect(owner);
      expect(await names(reconnected)).toContain('coord:whoami');
      await call(reconnected, 'tools:invoke', { name: 'facts:list', args: { scope: 'owner' } });
      expect(await names(reconnected)).toEqual(expect.arrayContaining(['coord:whoami', 'facts:list']));

      const other = await connect(`${owner}-other`);
      const otherNames = await names(other);
      expect(otherNames).not.toContain('coord:whoami');
      expect(otherNames).not.toContain('facts:list');
      expect(await servingSha(), 'runtime changed during the live proof').toBe(buildSha);
      console.info('session-tool-restoration-proof', JSON.stringify({
        baseUrl, buildSha, owner, workspace, harness,
        direct: 'coord:whoami', nested: 'facts:list', isolatedOwner: `${owner}-other`,
      }));
    } finally {
      await Promise.allSettled(clients.map(client => client.close()));
    }
  }, 90_000);
});
