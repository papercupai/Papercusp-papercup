import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Invoke the actual registered Playwright journey, with real HTTP and artifact
// files. Only its managed-tool boundary is controlled; no live task is borrowed.
const controls = vi.hoisted(() => ({
  journey: undefined as undefined | ((context: unknown, info: unknown) => Promise<void>),
  invoke: vi.fn<(name: string, args: unknown) => unknown>(),
}));
vi.mock('../../../../../apps/operator/e2e/_egress', async () => {
  const { expect: journeyExpect } = await import('vitest');
  const test = Object.assign((_name: string, journey: typeof controls.journey) => {
    controls.journey = journey;
  }, {
    setTimeout: vi.fn(),
    skip: (condition: boolean) => { if (condition) throw new Error('Unexpected fixture skip'); },
  });
  return { test, expect: journeyExpect };
});
vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void) => {
    try {
      const path = args[args.indexOf('--json-file') + 1]!;
      const result = controls.invoke(args[1]!, JSON.parse(readFileSync(path, 'utf8')));
      callback(null, { stdout: JSON.stringify(result), stderr: '' });
    } catch (error) {
      callback(error as Error, { stdout: '', stderr: '' });
    }
  },
}));

const directories: string[] = [];
const servers: Server[] = [];
beforeAll(async () => {
  await import('../../../../../apps/operator/e2e/background-content-summary.spec');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  controls.invoke.mockReset();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function fixture(readinessStatus: number, taskFails = false) {
  const state = mkdtempSync(join(tmpdir(), 'summary-preflight-control-'));
  directories.push(state);
  const home = join(state, 'home');
  const output = join(state, 'output');
  mkdirSync(home); mkdirSync(output);
  writeFileSync(join(home, 'superuser-token'), 'synthetic-test-credential');
  vi.stubEnv('PAPERCUSP_HOME', home);
  vi.stubEnv('PAPERCUSP_WORKSPACE', 'fixture-workspace');
  vi.stubEnv('PAPERCUSP_SID', 'fixture-session');
  vi.stubEnv('PAPERCUSP_TEST_RUN_WORK_ITEM_ID', 'WI-fixture');
  const server = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, sha: 'fixture-serving-build' }));
    } else if (request.url === '/v1/models') {
      response.statusCode = readinessStatus;
      response.end(readinessStatus === 200 ? '{"data":[{"id":"fixture-local"}]}' : 'Loading model');
    } else { response.statusCode = 404; response.end(); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const origin = `http://127.0.0.1:${address.port}`;
  controls.invoke.mockImplementation(name => {
    if (name === 'work_items:get') return { ok: true, results: [{ workItem: {
      id: 'WI-fixture', assignee: 'fixture-session', state: 'open',
    } }] };
    if (name === 'gateway:local_backend_list') return { ok: true, backends: [{
      enabled: true, models: ['fixture-local'], baseUrl: origin,
    }] };
    if (name === 'capability:bash' && taskFails) return { ok: true, task_id: 'fixture-task',
      bash_id: 'fixture-bash', status: 'completed', exit_code: 5, output: 'SUMMARY-FAILED provider refusal' };
    throw new Error(`Unexpected managed-tool call: ${name}`);
  });
  const attachments: Array<{ name: string; path: string }> = [];
  const request = { get: async (url: string, options?: { timeout?: number }) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(options?.timeout ?? 5000) });
    return { ok: () => response.ok, status: () => response.status,
      text: () => response.text(), json: () => response.json() };
  } };
  const info = {
    outputPath: (name: string) => join(output, name),
    attach: async (name: string, attachment: { path: string }) => { attachments.push({ name, path: attachment.path }); },
  };
  return { context: { request, baseURL: origin }, info, output, attachments };
}

describe('actual managed-summary journey prerequisites and retained failure evidence', () => {
  it('refuses a cold backend before launching a task and retains its readiness response', async () => {
    const control = await fixture(503);
    await expect(controls.journey!(control.context, control.info)).rejects.toThrow(/ready before launching/);
    expect(controls.invoke.mock.calls.map(([name]) => name)).toEqual(['work_items:get', 'gateway:local_backend_list']);
    const path = join(control.output, 'managed-summary-execution.json');
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(artifact).toMatchObject({ buildBefore: 'fixture-serving-build', model: 'fixture-local',
      backendReadiness: { status: 503, body: 'Loading model' } });
    expect(artifact).not.toHaveProperty('launch');
    expect(control.attachments).toContainEqual({ name: 'managed-summary-execution', path });
  });

  it('keeps the actual task failure bytes on disk when the journey assertion rejects', async () => {
    const control = await fixture(200, true);
    await expect(controls.journey!(control.context, control.info)).rejects.toThrow();
    expect(controls.invoke.mock.calls.map(([name]) => name)).toEqual([
      'work_items:get', 'gateway:local_backend_list', 'capability:bash',
    ]);
    const path = join(control.output, 'managed-summary-execution.json');
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    expect(artifact).toMatchObject({ backendReadiness: { status: 200 },
      launch: { task_id: 'fixture-task', bash_id: 'fixture-bash' },
      final: { status: 'completed', exit_code: 5 }, output: 'SUMMARY-FAILED provider refusal' });
    expect(control.attachments).toContainEqual({ name: 'managed-summary-execution', path });
  });
});
