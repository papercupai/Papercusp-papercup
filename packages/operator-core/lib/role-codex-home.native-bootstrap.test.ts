/** Offline native account/read contract: no real credentials or model calls. */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexGatewayConfigToml, codexManagedFeaturesToml } from '@papercusp/orchestrator/codex-gateway-config';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { isCodexWorkspaceDiscoveryTimeout } from './psu-launch-log.mjs';
import { codexSessionFrameObserved } from '../../../apps/operator/scripts/psu-pty-host.mjs';
import { resolveContainerCodexBinary } from './external-bench/container-exec-target';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from './inference-gateway/codex-cli-bridge';

// Use the maintained per-user install precedence. The test worker's PATH can
// prefer a broken system wrapper over the Codex PSU actually launches.
const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
const require = createRequire(import.meta.url);

async function privateSuConfig(baseURL: string, home: string) {
  const { suCodexConfigToml } = await import('./role-codex-home');
  const previousPort = process.env.PAPERCUSP_GATEWAY_PORT;
  process.env.PAPERCUSP_GATEWAY_PORT = String(new URL(baseURL).port);
  try {
    return suCodexConfigToml({ sid: 'su-private-bootstrap', model: 'gpt-6-luna',
      mcpUrl: `${baseURL}/mcp`, token: 'private-mcp-fixture',
      nativeRuntimeBearer: 'n'.repeat(43), codexGatewayAuto: true,
      headless: true, denyAmbientContext: true, trustDir: home });
  } finally {
    if (previousPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
    else process.env.PAPERCUSP_GATEWAY_PORT = previousPort;
  }
}

/** Exercise the TUI's mandatory account/read path, including terminal probes. */
async function readNativeTui(home: string, budgetMs: number, nativeSessionId?: string | null, binary = codex,
  prompt?: string): Promise<{ output: string; exitedBeforeBudget: boolean; exitCode: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, TERM: 'xterm-256color' };
  delete env.OPENAI_API_KEY;
  if (nativeSessionId === null) delete env.CODEX_SESSION_ID;
  else if (nativeSessionId !== undefined) env.CODEX_SESSION_ID = nativeSessionId;
  const child = require('@lydell/node-pty').spawn(binary!, [
    '--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust', '-C', home,
  ], { env, cwd: home, cols: 120, rows: 30 });
  return new Promise((resolve, reject) => {
    let output = '', probeTail = '', budgetExpired = false, submitted = false;
    const timer = setTimeout(() => { budgetExpired = true; child.kill('SIGTERM'); }, budgetMs);
    const cleanupTimer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native TUI failed to terminate')); }, budgetMs + 2000);
    const data = child.onData((chunk: string) => {
      output = (output + chunk).slice(-65536);
      const probes = probeTail + chunk;
      probeTail = probes.slice(-3);
      if (probes.includes('\x1b[6n')) child.write('\x1b[1;1R');
      if (prompt && !submitted && codexSessionFrameObserved(output, { dims: { cols: 120, rows: 30 } })) {
        submitted = true;
        child.write(prompt + '\r');
      }
    });
    child.onExit(({ exitCode }: { exitCode: number }) => {
      clearTimeout(timer); clearTimeout(cleanupTimer); data.dispose();
      resolve({ output, exitedBeforeBudget: !budgetExpired, exitCode });
    });
  });
}

async function readNativeAccount(home: string): Promise<{ result?: unknown; error?: { message?: string } }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  const child = spawn(codex!, ['app-server', '--listen', 'stdio://'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-3000); });
  try {
    return await new Promise((resolve, reject) => {
      let carry = '';
      const timer = setTimeout(() => reject(new Error('native account/read fixture exceeded 20s')), 20_000);
      const finish = (value?: { result?: unknown; error?: { message?: string } }, error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
      child.on('error', (error) => finish(undefined, error));
      child.on('exit', (code) => finish(undefined, new Error(`native app-server exited ${code} before account/read: ${stderr}`)));
      child.stdout.on('data', (chunk: string) => {
        carry += chunk;
        let end: number;
        while ((end = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, end);
          carry = carry.slice(end + 1);
          let reply: { id?: number; result?: unknown; error?: { message?: string } };
          try { reply = JSON.parse(line); } catch { continue; }
          if (reply.id === 1) {
            if (reply.error) { finish(reply); return; }
            child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: false } }) + '\n');
          } else if (reply.id === 2) finish(reply);
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'papercusp-bootstrap-regression', version: '1' },
        capabilities: { experimentalApi: true },
      } }) + '\n');
    });
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

describe('native gateway account bootstrap', () => {
  it.runIf(Boolean(codex) && process.platform === 'linux').each([false, true])(
    'measures initial native MCP availability with delayed initialization (required=%s)', async required => {
      const home = mkdtempSync(join(tmpdir(), 'codex-native-mcp-startup-'));
      const events: string[] = [], toolNames: string[][] = [];
      const server = createServer(async (req, res) => {
        if (req.url?.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[]}'); return;
        }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        let body: Record<string, unknown>;
        try { body = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { res.writeHead(405); res.end(); return; }
        if (req.url?.endsWith('/responses')) {
          events.push('model');
          type WireTool = { name?: string; tools?: WireTool[] };
          const names = (tools: WireTool[], prefix = ''): string[] => tools.flatMap(tool =>
            tool.tools ? names(tool.tools, prefix + tool.name + '__') : [prefix + (tool.name ?? '')]);
          toolNames.push(names(body.tools as WireTool[] ?? []));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(codexCliResponsesCompletionSse(codexCliResponsesBody({
            model: 'gpt-6-luna', text: 'Private startup measurement complete.', inputTokens: 100, outputTokens: 8 })));
          return;
        }
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        if (body.method === 'initialize') {
          events.push('initialize-start');
          await new Promise(done => setTimeout(done, 4000));
        }
        const result = body.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'private-mcp', version: '1' } }
          : body.method === 'tools/list' ? { tools: [{ name: 'startup_probe', description: 'Private startup probe.',
            inputSchema: { type: 'object', properties: {} } }] } : {};
        events.push(String(body.method));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'a'.repeat(64) } });
      const config = required ? await privateSuConfig(baseURL, home) : ['model = "gpt-6-luna"', ...gateway.root,
        ...codexManagedFeaturesToml({ headless: true }), ...gateway.tables,
        '[mcp_servers.papercusp-su]', `url = "${baseURL}/mcp"`, `required = ${required}`,
      ].join('\n');
      writeFileSync(join(home, 'config.toml'), config);
      try {
        const native = await readNativeTui(home, 9000, null, resolveContainerCodexBinary(), 'Measure the configured tool surface.');
        const diagnostic = JSON.stringify({ required, events, toolNames, ...native });
        console.info('PRIVATE_NATIVE_MCP_STARTUP ' + JSON.stringify({ required, events, toolNames }));
        expect(toolNames.length, diagnostic).toBeGreaterThan(0);
        expect(toolNames[0].some(name => name.endsWith('__startup_probe')), diagnostic).toBe(required);
        expect(events.indexOf('model') > events.indexOf('tools/list'), diagnostic).toBe(required);
      } finally {
        server.closeAllConnections();
        await new Promise<void>(done => server.close(() => done()));
        rmSync(home, { recursive: true, force: true });
      }
    }, 15_000);

  it.runIf(Boolean(codex) && process.platform === 'linux').each([
    { binary: 'host', nativeSessionId: null, generated: false },
    { binary: 'host', nativeSessionId: 'private-inherited-native-session', generated: false },
    { binary: 'musl', nativeSessionId: null, generated: false },
    { binary: 'musl', nativeSessionId: 'private-inherited-native-session', generated: false },
    { binary: 'host', nativeSessionId: null, generated: true },
    { binary: 'musl', nativeSessionId: null, generated: true },
  ])('initializes managed MCP without model inference ($binary, $nativeSessionId, generated=$generated)', async ({ binary, nativeSessionId, generated }) => {
      const home = mkdtempSync(join(tmpdir(), 'codex-native-mcp-'));
      const methods: string[] = [];
      const server = createServer(async (req, res) => {
        if (req.url?.includes('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"models":[]}');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        let body: { id?: number; method?: string };
        try { body = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { res.writeHead(405); res.end(); return; }
        methods.push(body.method ?? 'unknown');
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = body.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'private-mcp', version: '1' } }
          : body.method === 'tools/list' ? { tools: [] } : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      try {
        const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'a'.repeat(64) } });
        let config = ['model = "gpt-6-luna"', ...gateway.root,
          ...codexManagedFeaturesToml({ headless: true }), ...gateway.tables,
          '[mcp_servers.papercusp-su]', `url = "${baseURL}/mcp"`,
          'env_http_headers = { "x-papercusp-native-session" = "CODEX_SESSION_ID" }',
        ].join('\n');
        if (generated) {
          // Exercise the production generator, including its MCP tool policy,
          // private runtime headers and ambient-context confinement. A hand
          // assembled config cannot catch a managed-home projection defect.
          config = await privateSuConfig(baseURL, home);
        }
        writeFileSync(join(home, 'config.toml'), config);
        const result = await readNativeTui(home, 7000, nativeSessionId,
          binary === 'musl' ? resolveContainerCodexBinary() : codex);
        const diagnostic = JSON.stringify({ binary, nativeSessionId, generated, methods, ...result });
        expect(methods, diagnostic).toContain('initialize');
        expect(methods, diagnostic).toContain('tools/list');
        expect(methods, diagnostic).not.toContain('unknown');
      } finally {
        server.closeAllConnections();
        await new Promise<void>(done => server.close(() => done()));
        rmSync(home, { recursive: true, force: true });
      }
    }, 12_000);

  it.runIf(Boolean(codex) && process.platform === 'linux').each([400, 200])(
    'keeps a fresh TUI alive without a pre-submission rollout after local catalog status %s', async status => {
      const home = mkdtempSync(join(tmpdir(), 'codex-native-catalog-'));
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(req.url ?? '');
        res.writeHead(req.url?.includes('/models') ? status : 400, { 'content-type': 'application/json' });
        res.end(status === 200 && req.url?.includes('/models') ? '{"models":[]}'
          : '{"error":{"type":"invalid_request_error","message":"Private no-forwarding fixture."}}');
      });
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'a'.repeat(64) } });
      const INVALID_ACCESS_TOKEN_FOR_TEST = 'never-emit-me';
      writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt',
        tokens: { access_token: INVALID_ACCESS_TOKEN_FOR_TEST, account_id: 'private-current-su' } }));
      writeFileSync(join(home, 'config.toml'), ['model = "gpt-6-luna"', ...gateway.root,
        ...codexManagedFeaturesToml({ headless: true }), ...gateway.tables].join('\n'));
      try {
        const result = await readNativeTui(home, 10_000);
        const sessions = (() => { try { return readdirSync(join(home, 'sessions'), { recursive: true }); } catch { return []; } })();
        const diagnostic = JSON.stringify({ status, requests, sessions, ...result });
        console.info('PRIVATE_NATIVE_CATALOG_PROBE ' + diagnostic);
        expect(requests.some(path => path.includes('/models')), diagnostic).toBe(true);
        expect(requests.some(path => path.includes('/responses')), diagnostic).toBe(false);
        // A fresh Codex thread creates its rollout only after the first prompt.
        // Both catalog outcomes must leave it alive: waiting for this rollout
        // before submitting kickoff is the launcher deadlock this guards.
        expect(result.exitedBeforeBudget, diagnostic).toBe(false);
        expect(sessions.some(path => String(path).endsWith('.jsonl')), diagnostic).toBe(false);
        expect(codexSessionFrameObserved(result.output, { dims: { cols: 120, rows: 30 } }),
          'The maintained launcher must recognize the real configured composer: ' + diagnostic).toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>(done => server.close(() => done()));
        rmSync(home, { recursive: true, force: true });
      }
    }, 15_000);

  it.runIf(Boolean(codex) && process.platform === 'linux')('boots the native TUI without the workspace endpoint that reproduces the exact default-auth timeout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-native-tui-account-'));
    const controlHome = mkdtempSync(join(tmpdir(), 'codex-native-tui-control-'));
    const version = execFileSync(codex!, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    const ownerId = 'su-codex-wake-owner';
    const requests: Array<{ path: string; owner?: string; priority?: string; account?: string }> = [];
    const server = createServer((req, res) => {
      requests.push({
        path: req.url ?? '',
        owner: req.headers['x-papercusp-owner']?.toString(),
        priority: req.headers['x-papercusp-priority']?.toString(),
        account: req.headers['x-papercusp-account']?.toString(),
      });
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"models":[]}');
      }
      // Account discovery deliberately receives no response. This reproduces
      // the native 15-second timeout, rather than only a generic HTTP failure.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'fixture@example.invalid', 'https://api.openai.com/auth': {
        chatgpt_account_id: 'default-fixture', chatgpt_plan_type: 'pro',
      } })}.fixture`;
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: token, id_token: token, refresh_token: 'fixture-refresh', account_id: 'default-fixture',
    } });
    writeFileSync(join(home, 'auth.json'), auth);
    writeFileSync(join(controlHome, 'auth.json'), auth);
    const gateway = codexGatewayConfigToml(null, { gatewayOn: true, ownerId, priority: 'su' });
    const root = [`chatgpt_base_url = "${url}"`, 'model = "gpt-6.1-sol"'];
    const features = codexManagedFeaturesToml({ headless: true });
    const tables = gateway.tables.map(line => line.startsWith('base_url =') ? `base_url = "${url}/v1"`
      : line.startsWith('model_catalog_url =') ? `model_catalog_url = "${url}/v1/models"` : line);
    try {
      writeFileSync(join(home, 'config.toml'), [...root, ...gateway.root, ...features, ...tables].join('\n'));
      const routed = await readNativeTui(home, 20_000);
      expect(routed.exitedBeforeBudget, routed.output).toBe(false);
      expect(isCodexWorkspaceDiscoveryTimeout(routed.output)).toBe(false);
      expect(requests.some(request => request.path.includes('/v1/models')
        && request.owner === ownerId && request.priority === 'su' && request.account === undefined)).toBe(true);
      expect(requests.some(request => request.path.includes('/api/codex/accounts/check'))).toBe(false);
      requests.length = 0;
      writeFileSync(join(controlHome, 'config.toml'), [...root, ...features].join('\n'));
      const direct = await readNativeTui(controlHome, 22_000);
      const trace = JSON.stringify({ codex, version, requests, output: direct.output.slice(-3000) });
      expect(direct, trace).toMatchObject({ exitedBeforeBudget: true, exitCode: 1 });
      expect(isCodexWorkspaceDiscoveryTimeout(direct.output)).toBe(true);
      expect(requests.some(request => request.path.includes('/api/codex/accounts/check'))).toBe(true);
      expect(requests.some(request => request.path.includes('/v1/responses'))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
      rmSync(controlHome, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(Boolean(codex))('does not consult the default ChatGPT workspace when the gateway owns auth', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-native-account-'));
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"offline workspace discovery fixture"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'fixture@example.invalid', 'https://api.openai.com/auth': {
        chatgpt_account_id: 'default-fixture', chatgpt_plan_type: 'pro',
      } })}.fixture`;
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: token, id_token: token, refresh_token: 'fixture-refresh', account_id: 'default-fixture',
    } }));
    const gateway = codexGatewayConfigToml(null, { gatewayOn: true });
    // The fixture tests mandatory account discovery, not optional plugin catalogs.
    const config = [`chatgpt_base_url = "http://127.0.0.1:${port}"`, ...gateway.root,
      ...codexManagedFeaturesToml({ headless: true }), ...gateway.tables].join('\n');
    try {
      writeFileSync(join(home, 'config.toml'), config);
      const routed = await readNativeAccount(home);
      expect(routed.error).toBeUndefined();
      expect(routed.result).toMatchObject({ account: null, requiresOpenaiAuth: false });
      expect(requests).toEqual([]);
      // Check legacy omission separately: do not mistake explicit hardening for
      // proof of the original timeout's root cause on a client that defaults false.
      writeFileSync(join(home, 'config.toml'), config.replace('requires_openai_auth = false', ''));
      const legacy = await readNativeAccount(home);
      expect(legacy.error).toBeUndefined();
      expect(legacy.result).toMatchObject({ account: null, requiresOpenaiAuth: false });
      expect(requests).toEqual([]);
      // Positive control: making the same provider depend on the ambient login
      // must exercise the deliberately unavailable workspace-discovery endpoint.
      writeFileSync(join(home, 'config.toml'), config.replace('requires_openai_auth = false', 'requires_openai_auth = true'));
      const bound = await readNativeAccount(home);
      expect(bound.error?.message).toContain('workspace routing discovery');
      expect(requests.length).toBeGreaterThan(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
