/** Installed Claude request-surface proof; loopback fixtures never forward inference. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { nativeToolInventory } from '../../../libs/papercusp/packages/orchestrator/src/managed-capability-client-inventory';

declare module 'vitest' {
  interface TaskMeta {
    nativeToolSurface?: unknown;
  }
}

const canary = 'managed_surface_canary';

async function captureSurface(deny: string[]) {
  const claude = wellKnownBackendBin('claude-code') ?? resolveOnPath('claude');
  if (!claude) throw new Error('Installed Claude is required for native-tool removal evidence');
  const home = mkdtempSync(join(tmpdir(), 'claude-managed-surface-'));
  const captures: Array<{ tools?: Array<{ name: string }> }> = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/mcp') {
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = body.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'managed-surface', version: '1' } }
          : body.method === 'tools/list'
            ? { tools: [{ name: canary, description: 'Local managed tool canary.', inputSchema: { type: 'object', properties: {} } }] }
            : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      if (Array.isArray(body.tools) && body.tools.length) captures.push(body);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"Offline census complete; no forwarding."}}');
    } catch (error) { res.writeHead(400); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const mcpPath = join(home, 'mcp.json');
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { managed_surface: { type: 'http', url: `${baseURL}/mcp` } } }));
  let stderr = '';
  const child = spawn(claude, ['--print', '--output-format', 'json', '--model', 'claude-haiku-4-5',
    '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', `--mcp-config=${mcpPath}`,
    ...(deny.length ? [`--disallowedTools=${deny.join(',')}`] : []), '--', 'Offline census: reply OK.'], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'], env: {
      PATH: process.env.PATH, LANG: process.env.LANG, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
      ANTHROPIC_BASE_URL: baseURL, ANTHROPIC_API_KEY: 'offline-fixture-only',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Claude tool census timed out: ${stderr}`)); }, 25_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    const request = captures.find(body => JSON.stringify(body).includes(canary));
    expect(request, `No managed MCP tool on the captured request: ${stderr}`).toBeDefined();
    return { version: execFileSync(claude, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(),
      names: request!.tools!.map(tool => tool.name) };
  } finally {
    child.kill('SIGTERM');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

describe('Claude managed replacement installed-client census', () => {
  it('removes denied native execution tools while retaining the managed MCP surface', async ({ task }) => {
    const denied = ['Bash', 'Read', 'Edit', 'Write'];
    const baseline = await captureSurface([]);
    const restricted = await captureSurface(denied);
    const inventory = nativeToolInventory({ client: 'claude', clientVersion: baseline.version,
      nativeNames: [...baseline.names, ...restricted.names], managedNames: [canary] });
    task.meta.nativeToolSurface = { baseline, restricted, inventory };
    expect(inventory.rows.every(row => row.gap === null || row.gap === 'client-version-drift')).toBe(true);
    for (const name of denied) {
      expect(baseline.names).toContain(name);
      expect(restricted.names).not.toContain(name);
    }
  }, 60_000);
});
