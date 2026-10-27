/** Installed OMP lifecycle with a local provider and the production MCP dispatcher. */
import { execFile, execFileSync, fork } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, inject, it } from 'vitest';
import { composeOmpCapabilityTools, type CapabilityPolicyRequest } from '@papercusp/orchestrator/managed-capability-policy';
import { invoke } from '@papercusp/orchestrator';
import { resumeArgsFor, roleLaunchArgs, suLaunchArgs } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { resumeCommandFor } from './events/await/wake-executor';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';
import { preparePrivateOperatorApiBundle } from '../test/private-http-workspace-preflight';

const root = resolve(import.meta.dirname, '../../..');
const filePath = 'packages/operator-core/lib/omp-managed-tools.native.integration.test.ts';
const privateMcpUrl = process.env.OMP_MANAGED_PRIVATE_MCP_URL;
const workerOptions = isolatedTestFileWorkerOptions(process.env, 1);
const nativeTools = ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'task', 'todo', 'web_search'];
const admitted: CapabilityPolicyRequest = {
  client: 'omp', surface: 'launch', clientVersions: { omp: '18.0.3' }, ompNativeTools: nativeTools,
  readiness: [{ family: 'shell-ssh-interpreters', cutoverReady: true, openGapIds: [] }],
  cutoverStaging: { 'shell-ssh-interpreters': 'full' },
  adoption: [{ client: 'omp', family: 'shell-ssh-interpreters', managedPathProven: true,
    nativeBypassRefused: true, atClientVersion: '18.0.3' }],
  matrix: [{ client: 'omp', family: 'shell-ssh-interpreters', allScenariosPassed: true,
    declaredScenarioCount: 7, unmet: [] }],
};

/** Register inference only. MCP discovery, transport and execution belong to installed OMP. */
const provider = `
import { writeFileSync } from 'node:fs';
export default function(pi) {
  let turn = 0;
  pi.registerProvider('surface-fixture', {
    api: 'surface-fixture-api', apiKey: 'local-fixture-only', baseUrl: 'http://unused.invalid',
    models: [{ id: 'proof', name: 'Local lifecycle proof', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      if (++turn > 4) throw new Error('Unexpected inference turn');
      const surface = process.env.OMP_PROOF_SURFACE;
      const names = (context.tools ?? []).map(tool => tool.name);
      const dispatcher = names.find(name => /mcp.*tools_invoke$/.test(name)) ?? 'mcp__papercusp_tools_invoke';
      const id = surface + '_' + ['native', 'managed', 'refusal'][turn - 1];
      const tool = turn < 4;
      const args = turn === 1 ? { command: "printf 'OMP_NATIVE_ESCAPE'" }
        : turn === 2 ? { name: 'capability:bash', args: {
          command: "printf 'OMP_MANAGED_OK'", cwd: process.cwd(), timeout: 10000, yield_after: 15000 } }
        : { name: 'capability:__omp_missing_control__', args: {} };
      const content = tool ? [{ type: 'toolCall', id, name: turn === 1 ? 'bash' : dispatcher, arguments: args }]
        : [{ type: 'text', text: 'OMP lifecycle proof complete.' }];
      if (!tool) writeFileSync(process.env.OMP_PROOF_RESULT, JSON.stringify({
        names, messages: context.messages, dispatcher, turns: turn,
        replies: context.messages.filter(row => row.role === 'toolResult' &&
          [surface + '_native', surface + '_managed', surface + '_refusal'].includes(row.toolCallId)) }));
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: message };
        if (tool) yield { type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message };
        yield { type: 'done', reason: message.stopReason, message };
      }, result: async () => message };
    }
  });
}
`;

async function measureLifecycle(url: string, token: string, policy: CapabilityPolicyRequest, lifecycle: boolean,
  { viaInvoke = false, expectRestricted = true } = {}) {
  const omp = wellKnownBackendBin('omp') ?? resolveOnPath('omp');
  expect(omp, 'Installed OMP is required').toBeTruthy();
  const version = execFileSync(omp!, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  const home = mkdtempSync(join(tmpdir(), 'omp-managed-lifecycle-'));
  const extension = join(home, 'provider.ts');
  const sessions = join(home, 'sessions');
  const resultPath = join(home, 'result.json');
  writeFileSync(extension, provider, { mode: 0o600 });
  const mcpUrl = new URL(url);
  mcpUrl.searchParams.set('tools', 'tools:invoke');
  writeFileSync(join(home, '.mcp.json'), JSON.stringify({ mcpServers: {
    papercusp: { type: 'http', url: mcpUrl.href, headers: { Authorization: 'Bearer ' + token } },
  } }), { mode: 0o600 });
  const env = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    PI_CODING_AGENT_DIR: home, PI_CONFIG_DIR: home, OMP_PROOF_RESULT: resultPath };
  const common = ['--mode', 'json', '--no-title', '--no-extensions', '--no-skills', '--no-rules',
    '--extension', extension, '--model', 'surface-fixture/proof', '--thinking', 'off',
    '--auto-approve', '--session-dir', sessions];
  const selection = ['--tools', nativeTools.join(',')];
  const observations = [];
  let transcript: string | undefined;
  try {
    const surfaces = viaInvoke ? ['invoke'] as const
      : lifecycle ? ['launch', 'resume', 'wake'] as const : ['launch'] as const;
    for (const surface of surfaces) {
      const prompt = 'OMP managed ' + surface + ' proof';
      let args: string[];
      if (surface === 'invoke') {
        // The original selection still contains bash. Only invoke() may
        // compose the admitted restriction on this real process boundary.
        args = [...selection, '-p'];
      } else if (surface === 'launch') {
        const toolArgs = (argv: (string | undefined)[]) => {
          const index = argv.indexOf('--tools');
          const selected = index < 0 ? selection : argv.slice(index, index + 2);
          expect(selected).not.toContain(undefined);
          return selected.filter((arg): arg is string => arg !== undefined);
        };
        const su = toolArgs(suLaunchArgs('omp', { capabilityPolicy: policy }).args);
        expect(toolArgs(roleLaunchArgs('omp', { capabilityPolicy: policy }).args)).toEqual(su);
        expect(composeOmpCapabilityTools(selection, policy)).toEqual(su);
        args = [...su, '-p', prompt];
      } else if (surface === 'resume') {
        args = resumeArgsFor({ agent: 'omp', ompThreadId: transcript!, role: 'worker' }, {
          capabilityPolicy: policy, env: {},
        }).args;
        args = composeOmpCapabilityTools([...selection, ...args], policy);
        args.push('-p', prompt);
      } else {
        const wake = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: transcript! },
          prompt, null, policy);
        expect(wake?.promptViaPty).toBe(false);
        args = composeOmpCapabilityTools([...selection, ...wake!.args], { ...policy, surface: 'wake' });
      }
      let result: { stdout: string; stderr: string };
      if (surface === 'invoke') {
        const stateDir = join(home, '.papercusp');
        const logDir = join(stateDir, 'logs');
        const harnessDir = join(home, 'harness');
        mkdirSync(logDir, { recursive: true });
        mkdirSync(join(harnessDir, 'blueprints', 'base', 'prompts'), { recursive: true });
        writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ timeouts: { reviewer: 30 } }));
        const logs: string[] = [];
        const invoked = await invoke({ harnessDir, projectDir: home, stateDir, logDir, phase: 'staging',
          agentBackend: 'omp', claudeCmd: [omp!, ...common, ...args].join(' '), dept: '',
          log: line => logs.push(line) }, 'reviewer', [], { capabilityPolicy: policy,
          inlinePrompt: prompt, cwd: home, extraEnv: Object.fromEntries(Object.entries({ ...env,
            OMP_PROOF_SURFACE: surface }).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
        result = { stdout: readFileSync(invoked.jsonlPath, 'utf8'),
          stderr: readFileSync(invoked.jsonlPath.replace(/\.jsonl$/, '.err'), 'utf8') };
        expect(invoked.exitCode, JSON.stringify({ logs, stderr: result.stderr })).toBe(0);
      } else {
        const execution = promisify(execFile)(omp!, [...common, ...args], {
          cwd: home, env: { ...env, OMP_PROOF_SURFACE: surface }, timeout: 30_000,
          killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
        });
        // OMP reads piped stdin before the positional prompt.
        execution.child.stdin?.end();
        result = await execution;
      }
      expect(result.stderr).not.toMatch(/Invalid tool names/);
      const measured = JSON.parse(readFileSync(resultPath, 'utf8'));
      if (privateMcpUrl && process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR) {
        appendFileSync(join(process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR, 'managed-tool-replies.ndjson'),
          JSON.stringify({ surface, version, replies: measured.replies }) + '\n', { mode: 0o600 });
      }
      const reply = (kind: string) => measured.replies.find((row: { toolCallId: string }) =>
        row.toolCallId === surface + '_' + kind);
      expect(reply('managed'), JSON.stringify(measured)).toBeDefined();
      expect(JSON.stringify(reply('managed')), JSON.stringify({ names: measured.names,
        dispatcher: measured.dispatcher, stderr: result.stderr.slice(-2000) })).toContain('OMP_MANAGED_OK');
      expect(JSON.stringify(reply('refusal'))).toMatch(/unknown|not.found|not.available|not.registered|unsupported/i);
      const native = reply('native');
      if (expectRestricted) {
        expect(measured.names).not.toContain('bash');
        expect(native?.isError, JSON.stringify(native)).toBe(true);
        expect(JSON.stringify(native)).not.toContain('OMP_NATIVE_ESCAPE');
      } else {
        expect(measured.names).toContain('bash');
        expect(JSON.stringify(native)).toContain('OMP_NATIVE_ESCAPE');
      }
      if (surface === 'resume' || surface === 'wake')
        expect(JSON.stringify(measured.messages)).toContain('OMP managed launch proof');
      observations.push({ surface, version, names: measured.names,
        hasNativeExecution: native?.isError !== true && JSON.stringify(native).includes('OMP_NATIVE_ESCAPE'),
        nativeRefused: native?.isError === true, managedCalls: 1, managedRefusal: true,
        managedPath: privateMcpUrl ? 'production-capability-bash' : 'local-mcp-preflight' });
      const files = readdirSync(sessions, { recursive: true }).map(String).filter(name => name.endsWith('.jsonl'));
      expect(files, 'One persisted native session must survive all lifecycle processes').toHaveLength(1);
      const next = join(sessions, files[0]!);
      if (transcript) expect(next).toBe(transcript);
      transcript = next;
    }
    return observations;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Cheap native MCP preflight before paying for private API/PG setup. */
async function localPreflight() {
  const requests: { method: string; rpc?: string }[] = [];
  const server = createServer(async (req, res) => {
    const request: { method: string; rpc?: string } = { method: req.method ?? '' };
    requests.push(request);
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (req.headers.authorization !== 'Bearer local-only') { res.writeHead(401).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let message;
    try { message = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { res.writeHead(400).end(); return; }
    request.rpc = message.method;
    if (message.id == null) { res.writeHead(202).end(); return; }
    const tool = { name: 'tools:invoke', description: 'Local preflight dispatcher',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } },
        required: ['name', 'args'] } };
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'omp-local-preflight', version: '1' } }
      : message.method === 'tools/list' ? { tools: [tool] }
      : message.params?.arguments?.name === 'capability:bash'
        ? { content: [{ type: 'text', text: 'OMP_MANAGED_OK' }] }
        : { isError: true, content: [{ type: 'text', text: 'unknown tool negative control' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address() as { port: number };
    try {
      const url = 'http://127.0.0.1:' + address.port + '/mcp';
      const lifecycle = await measureLifecycle(url, 'local-only', admitted, true);
      const invoked = await measureLifecycle(url, 'local-only', admitted, false, { viaInvoke: true });
      return { lifecycle, invoked };
    } catch (error) {
      throw new Error('Native MCP preflight requests=' + JSON.stringify(requests), { cause: error });
    }
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
}

if (privateMcpUrl) {
  it('preserves production MCP through admitted OMP launch, native resume, wake and version drift', async () => {
    expect(inject('papercuspTestLayer')).toBe('integration');
    const token = process.env.OMP_MANAGED_PRIVATE_MCP_TOKEN!;
    expect(token).toBeTruthy();
    const retained = await measureLifecycle(privateMcpUrl, token, { ...admitted, cutoverStaging: {} }, false,
      { expectRestricted: false });
    const removed = await measureLifecycle(privateMcpUrl, token, admitted, true);
    const drift = await measureLifecycle(privateMcpUrl, token, { ...admitted,
      clientVersions: { omp: 'unvalidated-client-version' } }, false, { expectRestricted: false });
    const invoked = {
      retained: await measureLifecycle(privateMcpUrl, token, { ...admitted, cutoverStaging: {} }, false,
        { viaInvoke: true, expectRestricted: false }),
      removed: await measureLifecycle(privateMcpUrl, token, admitted, false, { viaInvoke: true }),
      drift: await measureLifecycle(privateMcpUrl, token, { ...admitted,
        clientVersions: { omp: 'unvalidated-client-version' } }, false,
        { viaInvoke: true, expectRestricted: false }),
    };
    expect(retained[0]!.hasNativeExecution).toBe(true);
    expect(drift[0]!.hasNativeExecution).toBe(true);
    for (const row of removed) {
      expect(row.hasNativeExecution).toBe(false);
      expect(row.nativeRefused).toBe(true);
      expect(row.names.filter((name: string) => !name.startsWith('mcp__')).sort())
        .toEqual(retained[0]!.names.filter((name: string) => name !== 'bash' && !name.startsWith('mcp__')).sort());
    }
    console.info('OMP_ADMITTED_LIFECYCLE ' + JSON.stringify({ retained, removed, drift, invoked }));
  }, 180_000);
} else {
  // Preflight belongs to the retained runtime's prepare phase below. A separate
  // passing case has no runtime receipt and suppresses custody for the file.
  it('retains installed OMP production MCP removal and native lifecycle evidence', async context => {
    let prepared: Awaited<ReturnType<typeof preparePrivateOperatorApiBundle>>;
    const runId = await recordIsolatedIntegrationProof({ root, filePath,
      sourcePaths: ['libs/papercusp/packages/orchestrator/src/managed-capability-policy.ts',
        'libs/papercusp/packages/orchestrator/src/invoke.ts',
        'apps/operator/scripts/psu-launcher.mjs', 'packages/operator-core/lib/events/await/wake-executor.ts',
        'packages/operator-core/test/staging-first-http-fixture.ts'],
      retainedArtifacts: ['phases/prepare/native-mcp-preflight.json', 'phases/execute/worker.log',
        'phases/execute/native-tool-surface.json', 'phases/execute/operator-mcp-receipt.json',
        'phases/execute/managed-tool-replies.ndjson'],
      prepare: async evidenceDir => {
        const preflight = await localPreflight();
        await writeFile(join(evidenceDir, 'native-mcp-preflight.json'), JSON.stringify(preflight));
        prepared = await preparePrivateOperatorApiBundle(root, evidenceDir, {
          builder: { timeoutMs: 240_000, maxMs: 420_000, env: { ...process.env, VITEST: 'true' } },
        });
      },
      execute: async (observe, evidenceDir) => {
        await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
        await mkdir(join(evidenceDir, 'tmp'));
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
          STAGING_FIRST_HTTP_SCENARIO: 'omp-managed-tools', STAGING_FIRST_HTTP_EVIDENCE_DIR: evidenceDir,
          TMPDIR: process.env.TMPDIR ?? join(evidenceDir, 'tmp') };
        for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
          'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
          'PAPERCUSP_TEST_RUNS_DB_URL', 'PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE']) delete env[key];
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
          '--isolated-runtime=operator-api', '--managed-tasks', '--', process.execPath, '--import', 'tsx',
          join(root, 'packages/operator-core/test/staging-first-http-fixture.ts'),
          '--prepared-api-sha=' + prepared!.sha256, '--prepared-receipt-sha=' + prepared!.receiptSha256,
        ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        let result: Awaited<ReturnType<typeof captureIsolatedWorker>>;
        try { result = await captureIsolatedWorker(child, evidenceDir, workerOptions); }
        finally { await rm(join(evidenceDir, 'node_modules')); }
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({
          code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false,
        });
        expect(result.output).toContain('OMP_PRODUCTION_MCP_VERIFIED');
        const line = result.output.split('\n').find(row => row.startsWith('OMP_ADMITTED_LIFECYCLE '));
        expect(line, 'Native lifecycle observations must be retained').toBeDefined();
        await writeFile(join(evidenceDir, 'native-tool-surface.json'), line!.slice('OMP_ADMITTED_LIFECYCLE '.length));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('ISOLATED_OMP_MANAGED_SURFACE_PROOF_RUN ' + runId);
  }, 600_000);
}
