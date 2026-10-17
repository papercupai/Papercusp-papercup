/** P-536: real native CLI processes; private loopback inference, no provider credentials or PG.
 * This guards rollout recovery across retained-home relocation and loss of ephemeral SQLite.
 * It is not evidence of a cloud disk attachment or a provider/model inference canary.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexGatewayConfigToml, codexManagedFeaturesToml } from '@papercusp/orchestrator/codex-gateway-config';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { resolveOnPath, wellKnownBackendBin } from '../backend-bin-resolve.mjs';

const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
afterEach(() => vi.unstubAllEnvs());

async function nativeTurn(home: string, cwd: string, argv: string[]) {
  // Do not inherit the running agent's keys, hooks, provider route or NODE_OPTIONS.
  const child = spawn(codex!, ['exec', ...argv, '--json', '--skip-git-repo-check'], {
    cwd, env: { PATH: process.env.PATH, HOME: cwd, CODEX_HOME: home, TERM: 'dumb' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe('retained native session recovery', () => {
  it.runIf(Boolean(codex) && process.platform === 'linux')(
    'resumes the same native history after idle wake and replacement without the old host cache', async () => {
      const root = await mkdtemp(join(tmpdir(), 'p536-native-resume-'));
      const requests: Array<{ input?: unknown }> = [];
      const marker = 'retained-tenant-history-53db7e';
      const server = createServer(async (req, res) => {
        if (req.url?.split('?')[0] === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"models":[]}');
          return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/responses') {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        requests.push(request);
        const text = JSON.stringify(request.input).includes(marker) ? 'history-present' : 'history-missing';
        const item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant',
          status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        const response = { id: `resp_${requests.length}`, object: 'response', created_at: 1,
          status: 'completed', model: 'gpt-6-luna', output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      });
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const dataA = join(root, 'host-a', 'data');
      const dataB = join(root, 'host-b', 'data');
      const workspace = (data: string) => join(data, 'workspaces', 'tenant-a');
      const homeFor = (data: string) => {
        vi.stubEnv('PAPERCUSP_SU_CODEX_HOMES_DIR', join(data, 'home', '.papercusp', 'su-codex-homes'));
        return codexHomeForSessionKey('retained-a');
      };
      const writeConfig = async (home: string, sqlite: string) => {
        await mkdir(home, { recursive: true });
        await mkdir(sqlite, { recursive: true });
        const gateway = codexGatewayConfigToml(null, { gateway: { baseURL, token: 'a'.repeat(64) } });
        await writeFile(join(home, 'config.toml'), [
          'model = "gpt-6-luna"', `sqlite_home = ${JSON.stringify(sqlite)}`,
          ...gateway.root, ...codexManagedFeaturesToml({ headless: true }), ...gateway.tables,
        ].join('\n'));
      };
      const threadId = (stdout: string) => stdout.split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).find(event => event.type === 'thread.started')?.thread_id;
      try {
        await mkdir(workspace(dataA), { recursive: true });
        await writeFile(join(workspace(dataA), 'customer-data.txt'), 'retained customer bytes\n');
        const homeA = homeFor(dataA);
        await writeConfig(homeA, join(root, 'host-a', 'sqlite'));
        const first = await nativeTurn(homeA, workspace(dataA), [`Remember ${marker}; respond briefly.`]);
        expect(first.code, first.stderr + first.stdout).toBe(0);
        const id = threadId(first.stdout);
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        const idle = await nativeTurn(homeA, workspace(dataA), ['resume', id, 'Continue the previous conversation.']);
        expect(idle.code, idle.stderr + idle.stdout).toBe(0);
        expect(threadId(idle.stdout)).toBe(id);
        expect(idle.stdout).toContain('history-present');
        const rollouts = (await readdir(join(homeA, 'sessions'), { recursive: true }))
          .filter(path => path.endsWith('.jsonl'));
        expect(rollouts).toHaveLength(1);
        const checkpoint = await readFile(join(homeA, 'sessions', rollouts[0]), 'utf8');
        expect(checkpoint).toContain(marker);

        // The old machine's ephemeral files disappear. Only its retained data tree moves.
        await mkdir(join(root, 'host-b'));
        await rename(dataA, dataB);
        await rm(join(root, 'host-a'), { recursive: true, force: true });
        const homeB = homeFor(dataB);
        expect(await readFile(join(homeB, 'sessions', rollouts[0]), 'utf8')).toBe(checkpoint);
        await writeConfig(homeB, join(root, 'host-b', 'new-sqlite'));
        const recovered = await nativeTurn(homeB, workspace(dataB), ['resume', id, 'Continue after host replacement.']);
        expect(recovered.code, recovered.stderr + recovered.stdout).toBe(0);
        expect(threadId(recovered.stdout)).toBe(id);
        expect(recovered.stdout).toContain('history-present');
        expect(requests).toHaveLength(3);
        for (const request of requests) expect(JSON.stringify(request.input)).toContain(marker);
        expect(await readFile(join(workspace(dataB), 'customer-data.txt'), 'utf8')).toBe('retained customer bytes\n');

        // A fresh tenant home cannot find or replay another tenant's native session id.
        const foreignHome = join(root, 'foreign-tenant-home');
        await writeConfig(foreignHome, join(root, 'foreign-sqlite'));
        const foreign = await nativeTurn(foreignHome, workspace(dataB), ['resume', id, 'Continue.']);
        expect(foreign.code, foreign.stderr + foreign.stdout).not.toBe(0);
        expect(requests).toHaveLength(3);
      } finally {
        server.closeAllConnections();
        await new Promise<void>(done => server.close(() => done()));
        await rm(root, { recursive: true, force: true });
      }
    }, 110_000,
  );
});
