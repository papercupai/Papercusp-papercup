import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, test } from './_egress';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

test('summary reuse follows its authorized reader, source version, options and model', async ({ request, baseURL }, testInfo) => {
  test.setTimeout(600_000);
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  const parent = process.env.PAPERCUSP_SID;
  test.skip(!workspace || !parent || !process.env.PAPERCUSP_TEST_RUN_WORK_ITEM_ID,
    'The real local cache journey requires a workspace, author session and held work-item.');
  const origin = new URL(baseURL!);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(origin.hostname);
  const before = await (await request.get(new URL('/api/health', origin).href)).json();
  const nonce = randomUUID();
  const mint = async () => {
    const script = "const {signSpawnParams}=await import('./packages/operator-core/lib/spawn-signing.ts');\n"
      + 'const params=new URLSearchParams(JSON.parse(process.argv[1]));\n'
      + 'await signSpawnParams(params,{ttlSec:900});\n'
      + 'process.stdout.write(params.toString());process.exit(0);';
    const { stdout } = await exec(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify({
        workspace, harness: 'papercusp', role: 'papercup', client: randomUUID(),
        spawn: 'content-cache-e2e-' + randomUUID(), run: randomUUID(), parent_spawn: parent,
      })], { cwd: root, timeout: 30_000, maxBuffer: 64 * 1024,
        // Match the managed API's configured store. A desktop's mutable
        // embedded-PG discovery file can hold a different signing key.
        // Explicit isolated-rig/database pins still take precedence.
        env: { ...process.env, PAPERCUSP_SKIP_PG_DISCOVERY: '1' } });
    return new URL('/api/mcp?' + stdout.trim(), origin).href;
  };
  const observations: unknown[] = [];
  let sequence = 0;
  const rpc = async (url: string, method: string, params: Record<string, unknown>) => {
    const id = ++sequence;
    const response = await request.post(url, { headers: {
      'content-type': 'application/json', Accept: 'application/json, text/event-stream',
    }, data: { jsonrpc: '2.0', id, method, params }, timeout: 150_000 });
    expect(response.status()).toBe(200);
    const text = await response.text();
    const body = response.headers()['content-type']?.includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(value => value.id === id)
      : JSON.parse(text);
    observations.push({ method, params, response: body });
    expect(body?.id).toBe(id);
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    expect(body.result?.isError, JSON.stringify(body.result)).not.toBe(true);
    return body;
  };
  const call = async (url: string, name: string, args: Record<string, unknown>) => {
    // The normal MCP default is TOON; this machine client consumes JSON.
    const body = await rpc(url, 'tools/call', { name, arguments: args, _meta: { format: 'json' } });
    const result = JSON.parse(body.result.content.find((part: { type: string }) => part.type === 'text').text);
    observations.push({ name, args, result });
    return result;
  };
  try {
    // Two genuinely signed ordinary-agent identities exercise the normal MCP
    // permission/intake path. All source text is a unique public fixture.
    const first = await mint();
    const second = await mint();
    // Authenticate both private fixtures before spending the inference budget;
    // retain any transport refusal instead of hiding it behind JSON parsing.
    for (const identity of [first, second]) {
      const catalog = await rpc(identity, 'tools/list', {});
      expect(catalog.result.tools.some((tool: { name: string }) => tool.name === 'documents:read')).toBe(true);
    }
    // Backend inventory is an author fixture prerequisite; the ordinary
    // narration role has no gateway administration capability.
    const { stdout } = await exec(process.execPath, ['scripts/mcp-call.mjs', 'gateway:local_backend_list',
      '--json', JSON.stringify({ workspace }), '--client', parent!, '--workspace', workspace!,
      '--harness', 'papercusp', '--port', origin.port || '80'],
    { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 });
    let inventory = JSON.parse(stdout);
    if (inventory.structuredContent) inventory = inventory.structuredContent;
    else if (Array.isArray(inventory.content)) inventory = JSON.parse(inventory.content.find((part: { type: string }) => part.type === 'text').text);
    const backend = inventory.backends.find((candidate: { enabled: boolean; models: string[] }) =>
      candidate.enabled && candidate.models.length > 0);
    expect(backend, 'A configured real local backend is required for the cache journey.').toBeTruthy();
    const model = process.env.PAPERCUSP_E2E_LOCAL_SUMMARY_MODEL || backend.models[0];
    expect(inventory.backends.some((candidate: { enabled: boolean; models: string[] }) =>
      candidate.enabled && candidate.models.includes(model))).toBe(true);
    const readyBackend = inventory.backends.find((candidate: { enabled: boolean; models: string[] }) =>
      candidate.enabled && candidate.models.includes(model));
    expect((await request.get(readyBackend.baseUrl + '/v1/models', { timeout: 5_000 })).ok()).toBe(true);
    const content = { kind: 'text', ref: 'fixture:cache-public-report:' + nonce,
      text: 'Public fixture ' + nonce + ': North reports 12 units and South reports 34 units.' };
    const summary = { model, allowCloud: false, cache: true, maxCalls: 1, maxOutputTokens: 128,
      length: 'short', focus: 'State both region names and their exact unit counts.', timeoutMs: 120_000 };
    const args = { operation: 'summarize', content, summary };
    const original = await call(first, 'documents:read', args);
    expect(original).toMatchObject({ ok: true, cached: false, model, coverage: { complete: true } });
    expect(original.summary).toMatch(/\b12\b/);
    expect(original.summary).toMatch(/\b34\b/);
    const reused = await call(first, 'documents:read', args);
    expect(reused).toMatchObject({ ok: true, cached: true, summary: original.summary, digest: original.digest });
    const otherReader = await call(second, 'documents:read', args);
    expect(otherReader).toMatchObject({ ok: true, cached: false, model });
    const changed = await call(first, 'documents:read', { ...args,
      content: { ...content, text: content.text.replace('12 units', '19 units') } });
    expect(changed).toMatchObject({ ok: true, cached: false, model });
    expect(changed.digest).not.toBe(original.digest);
    expect(changed.summary).toMatch(/\b19\b/);
    expect(changed.summary).toMatch(/\b34\b/);
    const options = await call(first, 'documents:read', { ...args, summary: { ...summary, format: 'bullets' } });
    expect(options).toMatchObject({ ok: true, cached: false, model });
    // An unavailable model must take its own consent/error path; a warm entry
    // from the registered model cannot turn it into a cached success.
    const unavailable = await call(first, 'documents:read', { ...args,
      summary: { ...summary, model: 'unregistered-cache-model-' + nonce } });
    expect(unavailable).toMatchObject({ ok: false, error: 'cloud-consent-required' });
    expect(unavailable.summary).toBeUndefined();
    const after = await (await request.get(new URL('/api/health', origin).href)).json();
    expect(after.sha).toBe(before.sha);
  } finally {
    const path = testInfo.outputPath('summary-cache-execution.json');
    writeFileSync(path, JSON.stringify({ buildSha: before.sha, nonce, observations }, null, 2) + '\n');
    await testInfo.attach('summary-cache-execution', { contentType: 'application/json', path });
  }
});

test('background summary completes through a real managed task and the normal documents tool', async ({ request, baseURL }, testInfo) => {
  test.setTimeout(210_000);
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  const client = process.env.PAPERCUSP_SID;
  // A live task needs an explicitly held lane; there is no shared default item
  // that a test may borrow or an implicit choice among the caller's claims.
  const workItem = process.env.PAPERCUSP_TEST_RUN_WORK_ITEM_ID;
  const home = process.env.PAPERCUSP_HOME || join(homedir(), '.papercusp');
  test.skip(!workspace || !client || !workItem || !existsSync(join(home, 'superuser-token')),
    'This live local-model journey requires the workspace, current session identity, installed credential and PAPERCUSP_TEST_RUN_WORK_ITEM_ID naming a held item.');
  const origin = new URL(baseURL!);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(origin.hostname);
  const port = origin.port || '80';
  const state = mkdtempSync(join(tmpdir(), 'content-summary-e2e-'));
  let sequence = 0;
  let taskId: string | undefined;
  let terminal = false;
  const observations: Record<string, unknown> = { workspace, client, workItem, origin: origin.origin };
  const retainEvidence = async (name: string, value: unknown) => {
    // Body-only attachments are not persisted by the normal list/ledger
    // reporters. Keep the bytes even when the model or an assertion fails.
    const path = testInfo.outputPath(`${name}.json`);
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
    await testInfo.attach(name, { contentType: 'application/json', path });
  };
  const invoke = async (name: string, args: unknown) => {
    const payload = join(state, `call-${sequence++}.json`);
    writeFileSync(payload, JSON.stringify(args));
    const { stdout } = await exec(process.execPath, ['scripts/mcp-call.mjs', name, '--json-file', payload,
      '--client', client!, '--workspace', workspace!, '--harness', 'papercusp', '--port', port],
    { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    let result = JSON.parse(stdout);
    if (result.structuredContent) result = result.structuredContent;
    else if (Array.isArray(result.content)) result = JSON.parse(result.content.find((part: { type: string }) => part.type === 'text').text);
    expect(result.ok).not.toBe(false);
    return result;
  };
  try {
    const healthBefore = await (await request.get(origin.origin + '/api/health')).json();
    expect(healthBefore.ok).toBe(true);
    observations.buildBefore = healthBefore.sha;
    const claim = await invoke('work_items:get', { id: workItem, harness: 'papercusp', payloadTier: 'full',
      projection: { pick: ['results[].workItem.id', 'results[].workItem.assignee', 'results[].workItem.state'] } });
    expect(claim.results).toHaveLength(1);
    expect(claim.results[0].workItem).toMatchObject({ id: workItem, assignee: client });
    expect(['open', 'wip']).toContain(claim.results[0].workItem.state);
    const inventory = await invoke('gateway:local_backend_list', { workspace });
    const models = inventory.backends.filter((backend: { enabled: boolean }) => backend.enabled)
      .flatMap((backend: { models: string[] }) => backend.models);
    test.skip(models.length === 0, 'The live local-model fixture is unavailable; no cloud substitute is permitted.');
    const model = models.includes('ornith:fast') ? 'ornith:fast' : models[0];
    observations.model = model;
    const backend = inventory.backends.find((candidate: { enabled: boolean; models: string[] }) =>
      candidate.enabled && candidate.models.includes(model));
    observations.backend = backend;
    // This journey verifies inference on a ready local backend. On-demand
    // loading has its own maintained lifecycle tests and can take minutes;
    // never spend the summary's bounded inference budget on an unready fixture.
    const readiness = await request.get(backend.baseUrl + '/v1/models', { timeout: 5_000 });
    observations.backendReadiness = { status: readiness.status(), body: await readiness.text() };
    expect(readiness.ok(), 'The real local backend must be ready before launching the bounded summary; cold-start readiness is a fixture prerequisite.').toBe(true);
    const source = 'Public fixture: North reports 12 units and South reports 34 units.';
    const args = { operation: 'summarize', content: { kind: 'text', text: source, ref: 'fixture:background-public-report' },
      summary: { model, allowCloud: false, cache: false, maxCalls: 1, maxOutputTokens: 128,
        length: 'short', focus: 'State both region names and their exact unit counts.', timeoutMs: 120_000 } };
    const command = [process.execPath, 'scripts/mcp-call.mjs', 'documents:read', '--json', '-', '--client', client!,
      '--workspace', workspace!, '--harness', 'papercusp', '--port', port].map(quote).join(' ') +
      " <<'CONTENT_SUMMARY_JSON'\n" + JSON.stringify(args) + '\nCONTENT_SUMMARY_JSON';
    const launch = await invoke('capability:bash', { command, cwd: root, work_item_id: workItem,
      run_in_background: true, timeout: 180_000 });
    taskId = launch.task_id;
    observations.launch = launch;
    expect(taskId).toBeTruthy();
    expect(launch.bash_id).toBeTruthy();
    let output = String(launch.output ?? '');
    let final = launch;
    const deadline = Date.now() + 180_000;
    while (final.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      final = await invoke('capability:bash_output', { task_id: taskId, bash_id: launch.bash_id });
      output += String(final.output ?? '');
    }
    terminal = final.status !== 'running';
    observations.final = final;
    observations.output = output;
    expect(final.status, output).toBe('completed');
    expect(final.exit_code, output).toBe(0);
    // Parse the child CLI's real JSON result, independently of the task's exit.
    const receipt = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
    expect(receipt).toMatchObject({ ok: true, operation: 'summarize', model, cached: false,
      sourceRefs: ['fixture:background-public-report'], coverage: { complete: true, characters: source.length, chunks: 1 },
      usage: { calls: 1, costUsd: 0 }, servedAccounts: [] });
    expect(receipt.summary).toMatch(/North/i);
    expect(receipt.summary).toMatch(/South/i);
    expect(receipt.summary).toMatch(/\b12\b/);
    expect(receipt.summary).toMatch(/\b34\b/);
    const healthAfter = await (await request.get(origin.origin + '/api/health')).json();
    expect(healthAfter.sha).toBe(healthBefore.sha);
    await retainEvidence('managed-summary-receipt', { buildSha: healthBefore.sha, taskId, bashId: launch.bash_id, final, receipt });
  } finally {
    await retainEvidence('managed-summary-execution', observations);
    if (taskId && !terminal) await invoke('processes:kill', { taskId }).catch(() => {});
    rmSync(state, { recursive: true, force: true });
  }
});
