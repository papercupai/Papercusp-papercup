/** Real Codex request boundary, entirely local: no credentials or paid inference. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexGatewayConfigToml } from '@papercusp/orchestrator/codex-gateway-config';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';

const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
const marker = 'PAPERCUSP_OFFLINE_INITIALIZE_CANARY';
// Match the scale of the observed bootstrap without retaining real prompt contents.
const sharedInstructions = `${marker}\n${'Preserve the current owner instructions and discover the needed tools.\n'.repeat(290)}`.trimEnd();

describe('native Codex MCP instruction wire', () => {
  it.runIf(Boolean(codex)).each([2, 55])('carries shared guidance once with %i tools at the real request boundary', async toolCount => {
    const home = mkdtempSync(join(tmpdir(), 'codex-mcp-wire-'));
    const toolNames = ['read_canary', 'find_canary', ...Array.from({ length: toolCount - 2 }, (_, i) => `extra_canary_${i}`)];
    const methods: string[] = [];
    const captures: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(req.url?.includes('/models') ? 200 : 405, { 'content-type': 'application/json' });
        res.end('{"models":[]}');
        return;
      }
      if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (req.url === '/mcp') {
        const method = String(body.method);
        methods.push(method);
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'offline-canary', version: '1' },
              instructions: sharedInstructions }
          : method === 'tools/list'
            ? { tools: toolNames.map(name => ({ name, description: `Public fixture ${name}.`,
                inputSchema: { type: 'object', properties: {} } })) }
            : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      if (req.url?.includes('/responses')) captures.push(body);
      // Terminal local refusal: the client cannot generate output or call tools.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"invalid_request_error","message":"Offline capture complete; no forwarding."}}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'offline_capture_token_'.repeat(3) } });
    writeFileSync(join(home, 'config.toml'), [
      'model = "gpt-6.1-sol"', ...gateway.root, ...gateway.tables,
      '[mcp_servers.offline_canary]', `url = "${baseURL}/mcp"`, 'required = true',
      'startup_timeout_sec = 10', 'tool_timeout_sec = 10',
    ].join('\n'));
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'offline-fixture-only' };
    delete env.CODEX_API_KEY;
    delete env.PAPERCUSP_SCOPED_INFERENCE_GATEWAY;
    let stderr = '';
    const child = spawn(codex!, ['exec', '--skip-git-repo-check', '--ephemeral', '--json',
      '-C', home, 'Offline fixture: reply OK. Do not use tools.'], { env, cwd: home, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Offline native capture timed out: ${stderr}`)); }, 25_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      expect(methods, stderr).toContain('initialize');
      expect(methods, stderr).toContain('tools/list');
      expect(captures.length, stderr).toBeGreaterThan(0);
      const request = captures[0]!;
      const wire = JSON.stringify(request);
      const count = wire.split(marker).length - 1;
      const descriptionHits: string[] = [];
      const markerLocations: string[] = [];
      const guidanceValues: string[] = [];
      const walk = (value: unknown, path = '$'): void => {
        if (typeof value === 'string' && value.includes(marker)) { markerLocations.push(path); guidanceValues.push(value); }
        if (Array.isArray(value)) { value.forEach((part, index) => walk(part, `${path}[${index}]`)); return; }
        if (!value || typeof value !== 'object') return;
        const row = value as Record<string, unknown>;
        if (typeof row.description === 'string' && row.description.includes(marker)) descriptionHits.push(String(row.name));
        Object.entries(row).forEach(([key, part]) => walk(part, `${path}.${key}`));
      };
      walk(request);
      console.info('CODEX_MCP_WIRE_EVIDENCE ' + JSON.stringify({ tools: toolNames.length,
        initializeInstructionCopies: count, descriptionsWithInstructions: descriptionHits.length,
        markerLocations, requestBytes: Buffer.byteLength(wire),
        clientVersion: execFileSync(codex!, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim() }));
      // The current native request must carry shared server guidance once, independently
      // of the number of tools. This guards the charged boundary, not catalog characters.
      expect(count, JSON.stringify({ descriptionHits, markerLocations })).toBe(1);
      expect(descriptionHits.length, JSON.stringify(markerLocations)).toBeLessThanOrEqual(1);
      expect(guidanceValues).toHaveLength(1);
      expect(guidanceValues[0], JSON.stringify({ actualChars: guidanceValues[0]?.length,
        expectedChars: sharedInstructions.length, markerLocations })).toContain(sharedInstructions);
      for (const name of toolNames) expect(wire).toContain(name);
    } finally {
      child.kill('SIGTERM');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
