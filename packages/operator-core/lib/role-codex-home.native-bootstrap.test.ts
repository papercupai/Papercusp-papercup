/** Offline native account/read contract: no real credentials or model calls. */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexGatewayConfigToml, codexManagedFeaturesToml } from '@papercusp/orchestrator/codex-gateway-config';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { isCodexWorkspaceDiscoveryTimeout } from './psu-launch-log.mjs';

// Use the maintained per-user install precedence. The test worker's PATH can
// prefer a broken system wrapper over the Codex PSU actually launches.
const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
const require = createRequire(import.meta.url);

/** Exercise the TUI's mandatory account/read path, including terminal probes. */
async function readNativeTui(home: string, budgetMs: number): Promise<{ output: string; exitedBeforeBudget: boolean; exitCode: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home, TERM: 'xterm-256color' };
  delete env.OPENAI_API_KEY;
  const child = require('@lydell/node-pty').spawn(codex!, [
    '--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust', '-C', home,
  ], { env, cwd: home, cols: 120, rows: 30 });
  return new Promise((resolve, reject) => {
    let output = '', probeTail = '', budgetExpired = false;
    const timer = setTimeout(() => { budgetExpired = true; child.kill('SIGTERM'); }, budgetMs);
    const cleanupTimer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native TUI failed to terminate')); }, budgetMs + 2000);
    const data = child.onData((chunk: string) => {
      output = (output + chunk).slice(-65536);
      const probes = probeTail + chunk;
      probeTail = probes.slice(-3);
      if (probes.includes('\x1b[6n')) child.write('\x1b[1;1R');
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
