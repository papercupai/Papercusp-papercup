import { expect, it, vi } from 'vitest';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pruneRuns, runHarness } from '@papercusp/verification-harness';
import { assertIsolatedFileRunBudget, assertIsolatedWorkerReaped, captureIsolatedWorker, isolatedIntegrationDiagnosticArtifacts, isolatedTestFileWorkerOptions, isolatedWorkerOptions, isolatedWorkerFailureDetail, recordIsolatedIntegrationProof, retainIsolatedNativeTaskDiagnostics, retainIsolatedWorkerProgress, withIsolatedNativeLaunchDiagnostics } from '../test/isolated-integration-proof';
import { assertPrivateUnrelatedCheckpointObservation, privateClaudeModelConfig, privateCodexModelConfig, retainPrivateProviderResponse, stopPrivateOperatorHost, type PrivateUnrelatedCheckpointObservation } from '../test/private-http-workspace-preflight';
const NEVER_EMIT_MARKER = 'never-emit-me';

it('keeps a native tool refusal visible after verbose connection phase clocks', () => {
  const trace = 'ptool: connection trace ' + JSON.stringify({ event: 'http-request-start', detail: 'x'.repeat(1000) });
  const output = ['Error: Native CLI process failed', ...Array(20).fill(trace),
    'stdout:', 'harness_forbidden: short harness requires the private pot',
    'stderr:', trace, '    at nativeCliResult (fixture.ts:1:1)'].join('\n');
  const diagnostic = isolatedWorkerFailureDetail(output);
  expect(diagnostic).toContain('Error: Native CLI process failed');
  expect(diagnostic).toContain('harness_forbidden: short harness requires the private pot');
  expect(diagnostic).not.toContain('ptool: connection trace');
  expect(diagnostic.length).toBeLessThanOrEqual(4000);
  expect(output).toContain(trace);
});

it('keeps isolated worker phase ceilings independent of a widened outer file budget', () => {
  const baseline = isolatedWorkerOptions(480_000, {});
  const outerFileMs = 2_400_000;
  const widened = isolatedWorkerOptions(480_000, { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(outerFileMs) });
  expect(widened).toEqual(baseline);
  expect(widened.testTimeoutMs).toBeLessThan(outerFileMs);
  expect(widened.phaseTimeouts).toMatchObject({ bootstrapMaxMs: 600_000,
    executeMs: 480_000, executeMaxMs: 480_000, teardownMaxMs: 600_000 });
});

it('rejects a short enclosing proof budget before reading source or allocating a worker', async () => {
  vi.stubEnv('PAPERCUSP_TEST_FILE_TIMEOUT_MS', '');
  const execute = vi.fn();
  try {
    await expect(recordIsolatedIntegrationProof({ root: join(tmpdir(), 'proof-source-must-not-be-read'),
      filePath: 'never-run.test.ts', sourcePaths: [], minimumFileRunTimeoutMs: 90 * 60_000,
      execute })).rejects.toThrow('PAPERCUSP_TEST_FILE_TIMEOUT_MS >= 5400000');
    expect(execute).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it('admits the exact declared proof budget without changing child phase ceilings', () => {
  const requiredMs = 90 * 60_000;
  expect(() => assertIsolatedFileRunBudget(requiredMs,
    { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(requiredMs - 1) })).toThrow('enclosing router');
  const env = { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(requiredMs) };
  expect(() => assertIsolatedFileRunBudget(requiredMs, env)).not.toThrow();
  expect(isolatedWorkerOptions(480_000, env)).toEqual(isolatedWorkerOptions(480_000, {}));
});

async function withCapturedRouter(options: Parameters<typeof captureIsolatedWorker>[2],
  check: (child: ChildProcess, result: ReturnType<typeof captureIsolatedWorker>) => Promise<void>) {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-router-phases-'));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;
  vi.useFakeTimers();
  const result = captureIsolatedWorker(child, evidenceDir, options);
  try { await check(child, result); }
  finally {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await result;
    vi.useRealTimers();
    child.stdout!.destroy(); child.stderr!.destroy();
    rmSync(evidenceDir, { recursive: true, force: true });
  }
}

const routerPhaseOptions = { phaseTimeouts: { bootstrapMs: 100, executeMs: 80, teardownMs: 30 },
  killGraceMs: 10, drainGraceMs: 10, testFileExecutionFromStdout: true };

it('recognizes direct test:file execution across chunks without changing phase budgets', async () => {
  const options = isolatedTestFileWorkerOptions({}, 1);
  const { testFileExecutionFromStdout, ...budgets } = options;
  expect(testFileExecutionFromStdout).toBe(true);
  expect(budgets).toEqual(isolatedWorkerOptions(120_000 + 600_000 + 2_000, {}, 120_000 + 7_200_000 + 2_000));
  await withCapturedRouter(routerPhaseOptions, async child => {
    child.stderr!.emit('data', 'TEST_FILE_LIST_PROGRESS state=started cwd="test"\n');
    await vi.advanceTimersByTimeAsync(90);
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=sta');
    await vi.advanceTimersByTimeAsync(5);
    child.stderr!.emit('data', 'rted cwd="test"\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).not.toHaveBeenCalled();
    // A stdout phase transition is not an admitted private-runtime lifetime.
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    await vi.advanceTimersByTimeAsync(30);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

it.each([
  'TEST_FILE_LIST_PROGRESS state=started cwd="test"\n',
  'TEST_FILE_PROGRESS state=running cwd="test"\n',
  'TEST_FILE_PROGRESS state=started-extra cwd="test"\n',
  'TEST_FILE_CASE_TRACE {"event":"started","file":"test","name":"case"}\n',
])('keeps collection and non-start output in bounded bootstrap: %s', async line => {
  await withCapturedRouter(routerPhaseOptions, async (child, result) => {
    child.stderr!.emit('data', line);
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  });
});

it('requires opt-in and ignores router starts after timeout', async () => {
  await withCapturedRouter({ ...routerPhaseOptions, testFileExecutionFromStdout: false }, async (child, result) => {
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  });
});

it.each(['execute', 'teardown'] as const)('does not renew %s for repeated or out-of-order router starts', async phase => {
  await withCapturedRouter(routerPhaseOptions, async (child, result) => {
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    if (phase === 'teardown') child.emit('message', { kind: 'isolated-runtime-stopping' });
    const budget = routerPhaseOptions.phaseTimeouts[phase === 'execute' ? 'executeMs' : 'teardownMs'];
    await vi.advanceTimersByTimeAsync(budget - 1);
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: phase });
  });
});

function unrelatedCheckpointObservation(): PrivateUnrelatedCheckpointObservation {
  const checkpoint = 'Private unrelated checkpoint control';
  const health = { service: 'papercusp-operator', sha: '1234567890abcdef' };
  const stall = { itemId: 'WI-stalled', pid: 1234, backendStart: '2026-10-16T00:00:00Z',
    queryStart: '2026-10-16T00:01:00Z', state: 'active', waitEventType: 'Lock' };
  return { workspace: 'test-runtime-p009', base: 'http://127.0.0.1:43123', expectedBuildSha: health.sha,
    healthBefore: { ...health }, healthAfter: { ...health }, itemId: 'WI-unrelated', harness: 'test-runtime-p009',
    checkpoint, startedAtMs: 100, completedAtMs: 20_100,
    stallBefore: { ...stall, observedAtMs: 99 }, stallAfter: { ...stall, observedAtMs: 20_101 },
    response: { status: 200, envelope: { ok: true, result: { structuredContent: {
      ok: true, counts: { ok: 1, failed: 0 }, results: [{ ok: true, id: 'WI-unrelated', harness: 'test-runtime-p009',
        cleared: false, verified: true, length: checkpoint.length,
        contentHash: createHash('sha256').update(checkpoint).digest('hex').slice(0, 12) }],
    } } } },
    readback: { observedAtMs: 20_102, workspace: 'test-runtime-p009', harness: 'test-runtime-p009',
      itemId: 'WI-unrelated', checkpoint } };
}

it('qualifies only a persisted unrelated HTTP checkpoint within the D-007 20-second boundary', () => {
  expect(() => assertPrivateUnrelatedCheckpointObservation(unrelatedCheckpointObservation())).not.toThrow();
  const textReceipt = unrelatedCheckpointObservation();
  const envelope = textReceipt.response.envelope as any;
  envelope.result.content = [{ type: 'text', text: JSON.stringify(envelope.result.structuredContent) }];
  delete envelope.result.structuredContent;
  expect(() => assertPrivateUnrelatedCheckpointObservation(textReceipt)).not.toThrow();
});

it.for([
  ['late body', (o: PrivateUnrelatedCheckpointObservation) => { o.completedAtMs += 0.01; }],
  ['backwards clock', o => { o.completedAtMs = o.startedAtMs - 1; }],
  ['missing clock', o => { o.startedAtMs = Number.NaN; }],
  ['same item', o => { o.stallBefore.itemId = o.stallAfter.itemId = o.itemId; }],
  ['unobserved stall', o => { o.stallBefore = undefined as any; }],
  ['stall ended', o => { o.stallAfter.state = 'idle'; }],
  ['not a lock wait', o => { o.stallAfter.waitEventType = 'Client'; }],
  ['different backend', o => { o.stallAfter.backendStart += '-new'; }],
  ['different query', o => { o.stallAfter.queryStart += '-new'; }],
  ['late stall', o => { o.stallBefore.observedAtMs = o.startedAtMs + 1; }],
  ['early release', o => { o.stallAfter.observedAtMs = o.completedAtMs - 1; }],
  ['live workspace', o => { o.workspace = 'papercusp-workspace'; }],
  ['shared staging host', o => { o.base = 'http://127.0.0.1:3170'; }],
  ['remote host', o => { o.base = 'http://example.com:43123'; }],
  ['changed build', o => { o.healthAfter.sha = 'abcdef123456'; }],
  ['stale bundle', o => { o.healthBefore.bundleStale = true; }],
  ['HTTP failure', o => { o.response.status = 503; }],
  ['wrong readback item', o => { o.readback.itemId = 'WI-other'; }],
  ['wrong readback workspace', o => { o.readback.workspace = 'test-runtime-other'; }],
  ['wrong readback bytes', o => { o.readback.checkpoint += ' changed'; }],
  ['old readback', o => { o.readback.observedAtMs = o.startedAtMs - 1; }],
] satisfies Array<[string, (o: PrivateUnrelatedCheckpointObservation) => void]>)('rejects missing or mismatched private checkpoint evidence: %s', ([, change]) => {
  const observation = unrelatedCheckpointObservation();
  change(observation);
  expect(() => assertPrivateUnrelatedCheckpointObservation(observation)).toThrow();
});

it.for(['timeout', 'unavailable', 'not_forwarded', 'forwarded', 'outcome_unknown', 'checkpoint_verify_unavailable'])(
  'rejects %s as an unrelated checkpoint success receipt', error => {
    const observation = unrelatedCheckpointObservation();
    const receipt = (observation.response.envelope as any).result.structuredContent;
    receipt.ok = false;
    receipt.counts = { ok: 0, failed: 1 };
    receipt.results[0] = { ok: false, id: observation.itemId, errorCode: error, writeCommitted: true };
    expect(() => assertPrivateUnrelatedCheckpointObservation(observation)).toThrow();
  });

it.for(['wrong item', 'wrong harness', 'not verified', 'wrong hash', 'partial batch', 'tool error', 'ambiguous JSON'])(
  'rejects a superficially successful checkpoint receipt: %s', fault => {
    const observation = unrelatedCheckpointObservation();
    const envelope = observation.response.envelope as any;
    const receipt = envelope.result.structuredContent;
    const row = receipt.results[0];
    if (fault === 'wrong item') row.id = 'WI-other';
    if (fault === 'wrong harness') row.harness = 'test-runtime-other';
    if (fault === 'not verified') row.verified = false;
    if (fault === 'wrong hash') row.contentHash = 'a'.repeat(12);
    if (fault === 'partial batch') receipt.counts.failed = 1;
    if (fault === 'tool error') envelope.result.isError = true;
    if (fault === 'ambiguous JSON') {
      envelope.result.content = [1, 2].map(() => ({ type: 'text', text: JSON.stringify(receipt) }));
      delete envelope.result.structuredContent;
    }
    expect(() => assertPrivateUnrelatedCheckpointObservation(observation)).toThrow();
  });

it('measures Claude native model, effort, owner, pin and private MCP without retaining credentials', () => {
  const argv = ['/native/claude', '--model=claude-sonnet-5', '--effort', 'high',
    '--mcp-config', '/private/mcp.json', '--strict-mcp-config'];
  const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_AUTH_TOKEN: NEVER_EMIT_MARKER,
    ANTHROPIC_CUSTOM_HEADERS: 'x-papercusp-owner: s-private\nx-papercusp-account: ', PAPERCUSP_ACCOUNT_ID: '' };
  const read = () => JSON.stringify({ mcpServers: { papercusp: {
    url: 'http://127.0.0.1:1235/api/mcp?client=s-private&workspace=test-runtime-proof&token=' + NEVER_EMIT_MARKER,
  } } });
  const result = privateClaudeModelConfig(argv, env, read);
  expect(result).toEqual({ model: 'claude-sonnet-5', effort: 'high', baseUrl: env.ANTHROPIC_BASE_URL,
    ownerId: 's-private', accountPinPresent: false, mcpOrigin: 'http://127.0.0.1:1235',
    mcpOwnerId: 's-private', mcpWorkspace: 'test-runtime-proof' });
  expect(JSON.stringify(result)).not.toContain(NEVER_EMIT_MARKER);
  expect(privateClaudeModelConfig(argv, { ...env, PAPERCUSP_ACCOUNT_ID: 'stale-pin' }, read).accountPinPresent).toBe(true);
  expect(privateClaudeModelConfig(argv, { ...env, ANTHROPIC_CUSTOM_HEADERS: env.ANTHROPIC_CUSTOM_HEADERS + 'pinned' }, read)
    .accountPinPresent).toBe(true);
  expect(() => privateClaudeModelConfig(argv.filter(arg => arg !== '--strict-mcp-config'), env, read)).toThrow(/ambient MCP/);
  expect(() => privateClaudeModelConfig(['/native/claude'], env, read)).toThrow(/explicit signed MCP/);
});

it('retains the actual Claude output effort on a successful bounded response', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-claude-response-'));
  try {
    const result = await retainPrivateProviderResponse(directory, new Response('private output', { status: 200 }), {
      body: JSON.stringify({ model: 'claude-sonnet-5', output_config: { effort: 'high' }, stream: true }),
    });
    expect(result.requestShape).toMatchObject({ model: 'claude-sonnet-5', effort: 'high', stream: true });
    expect(readFileSync(join(directory, 'provider-response.json'), 'utf8')).not.toContain('private output');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('measures native Codex effort overrides over absent and conflicting TOML', () => {
  for (const config of [{ model: 'gpt-6.1-sol' }, { model: 'gpt-6.1-sol', model_reasoning_effort: 'low' }]) {
    expect(privateCodexModelConfig(['/native/codex', 'exec', '-c', 'model_reasoning_effort="xhigh"'], config))
      .toEqual({ model: 'gpt-6.1-sol', effort: 'xhigh' });
  }
});

it('measures dedicated Codex model flags and the last config override without role inference', () => {
  for (const modelArgs of [['--model', 'gpt-6.1-sol'], ['--model=gpt-6.1-sol'], ['-m', 'gpt-6.1-sol']]) {
    expect(privateCodexModelConfig(['/native/codex', ...modelArgs, '-c', 'model="toml-override"',
      '-c', 'model_reasoning_effort="low"', '--config=model_reasoning_effort=high',
      '--config', "model_reasoning_effort='xhigh'"], { model: 'toml-model', model_reasoning_effort: 'minimal' }))
      .toEqual({ model: 'gpt-6.1-sol', effort: 'xhigh' });
  }
  expect(privateCodexModelConfig(['/native/codex', 'exec', '-c', 'unrelated="high"'],
    { model: 'toml-model', model_reasoning_effort: 'low' })).toEqual({ model: 'toml-model', effort: 'low' });
  expect(privateCodexModelConfig(['/native/codex', 'exec'], {})).toEqual({ model: undefined, effort: undefined });
});

it('retains a classified provider model refusal without credentials or request content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-provider-refusal-'));
  const secret = NEVER_EMIT_MARKER;
  const prompt = 'Private inert request content never belongs in evidence';
  const detail = `The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account. ${secret} ${prompt}`;
  const body = JSON.stringify({ detail });
  const response = new Response(body, { status: 400 });
  try {
    const observation = await retainPrivateProviderResponse(directory, response, {
      headers: { authorization: `Bearer ${secret}` }, diagnosticAccountId: 'configured-account',
      body: JSON.stringify({ model: 'gpt-5.4', reasoning: { effort: 'high' }, stream: true,
        instructions: prompt, input: [{ role: 'user', content: prompt }], tools: [{ type: 'function', name: 'inert' }] }),
    });
    expect(observation).toMatchObject({ status: 400, accountId: 'configured-account',
      error: { class: 'permanent', retryable: false, modelRefusal: true },
      requestShape: { model: 'gpt-5.4', effort: 'high', instructionsBytes: Buffer.byteLength(prompt), toolsCount: 1 } });
    const artifact = readFileSync(join(directory, 'provider-response.json'), 'utf8');
    expect(JSON.parse(artifact)).toEqual(observation);
    expect(artifact).toContain("model is not supported");
    expect(artifact).not.toContain(secret);
    expect(artifact).not.toContain(prompt);
    expect(await response.text()).toBe(body);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('bounds retained provider refusal diagnostics across streamed secret boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-provider-bounds-'));
  const secret = NEVER_EMIT_MARKER;
  const prefix = 'x'.repeat(16 * 1024 - 10);
  const chunks = [prefix + secret.slice(0, 10), secret.slice(10) + 'z'.repeat(40_000)];
  const response = new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close();
  } }), { status: 400 });
  try {
    const observation = await retainPrivateProviderResponse(directory, response,
      { headers: { authorization: `Bearer ${secret}` }, body: '{}' });
    expect(observation.response).toMatchObject({ truncated: true, bytes: Buffer.byteLength(chunks.join('')) });
    expect(observation.response.sampledBytes).toBe(16 * 1024 + Buffer.byteLength(secret));
    expect(observation.error!.detail.length).toBeLessThanOrEqual(300);
    expect(readFileSync(join(directory, 'provider-response.json'), 'utf8')).not.toContain(secret);
    expect(await response.text()).toBe(chunks.join(''));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('drains successful provider evidence without retaining model output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-provider-success-'));
  const output = 'private model completion never belongs in evidence';
  const response = new Response(output, { status: 200 });
  try {
    const observation = await retainPrivateProviderResponse(directory, response, { headers: {}, body: '{}' });
    expect(observation).toMatchObject({ status: 200, error: null,
      response: { bytes: Buffer.byteLength(output), sampledBytes: 0, truncated: false } });
    expect(readFileSync(join(directory, 'provider-response.json'), 'utf8')).not.toContain(output);
    expect(await response.text()).toBe(output);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('reaps a native descendant after host exit before waiting for inherited pipes', async () => {
  const host = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const native = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
    console.log(native.pid);
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let nativePid: number | undefined;
  try {
    const [chunk] = await once(host.stdout!, 'data');
    nativePid = Number(String(chunk).trim());
    expect(Number.isSafeInteger(nativePid)).toBe(true);
    let hostExitedBeforeReap = false;
    await stopPrivateOperatorHost(host, async () => {
      hostExitedBeforeReap = host.exitCode !== null || host.signalCode !== null;
      process.kill(nativePid!, 0);
      process.kill(nativePid!, 'SIGKILL');
    }, 1_000);
    expect(hostExitedBeforeReap).toBe(true);
    expect(host.stdout!.destroyed).toBe(true);
    expect(host.stderr!.destroyed).toBe(true);
  } finally {
    host.kill('SIGKILL');
    if (nativePid) try { process.kill(nativePid, 'SIGKILL'); } catch { /* already reaped */ }
  }
}, 5_000);

it.each(['exit', 'signal'] as const)('fails bounded host cleanup when a descendant still owns the output pipes: %s', async (termination) => {
  const host = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const native = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
    process.on('SIGTERM', () => ${termination === 'signal' ? "process.kill(process.pid, 'SIGKILL')" : 'process.exit(0)'});
    console.log(native.pid);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let nativePid: number | undefined;
  try {
    const [chunk] = await once(host.stdout!, 'data');
    nativePid = Number(String(chunk).trim());
    expect(Number.isSafeInteger(nativePid)).toBe(true);
    await expect(stopPrivateOperatorHost(host, undefined, 100)).rejects.toThrow('stdio drainage did not settle');
    expect(host.exitCode !== null || host.signalCode !== null).toBe(true);
    if (termination === 'signal') expect(host.signalCode).toBe('SIGKILL');
    expect(() => process.kill(nativePid!, 0)).not.toThrow();
  } finally {
    host.kill('SIGKILL');
    if (nativePid) try { process.kill(nativePid, 'SIGKILL'); } catch { /* already reaped */ }
    host.stdout?.destroy(); host.stderr?.destroy();
  }
}, 5_000);

it.for(['receipt', 'throw'] as const)('retains native launch %s diagnostics before disposable home removal', async outcome => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-native-launch-'));
  const nativeHome = join(evidenceDir, 'native-home');
  mkdirSync(nativeHome);
  const sources = { stdout: join(nativeHome, 'stdout.log'), normalized: join(nativeHome, 'normalized.log'),
    boot: join(nativeHome, 'boot.log') };
  const refusal = new Error('kickoff-not-submitted:codex-backend-frame-not-observed');
  const receipt = { isError: true, data: { agentStarted: false } };
  try {
    const launch = async () => {
      for (const [kind, path] of Object.entries(sources)) writeFileSync(path, kind + ' original failure evidence');
      if (outcome === 'throw') throw refusal;
      return receipt;
    };
    const operation = withIsolatedNativeLaunchDiagnostics(evidenceDir, launch, async () => {
      retainIsolatedNativeTaskDiagnostics(evidenceDir, { taskId: 'native-refused', state: 'failed',
        exitCode: 1, nativeStreamError: refusal.message }, sources);
    }).finally(() => rmSync(nativeHome, { recursive: true, force: true }));
    if (outcome === 'throw') await expect(operation).rejects.toBe(refusal);
    else await expect(operation).resolves.toBe(receipt);
    expect(existsSync(nativeHome)).toBe(false);
    for (const kind of Object.keys(sources))
      expect(readFileSync(join(evidenceDir, `native-task-${kind}.log`), 'utf8')).toBe(kind + ' original failure evidence');
    expect(JSON.parse(readFileSync(join(evidenceDir, 'native-task-diagnostics.json'), 'utf8')))
      .toMatchObject({ task: { taskId: 'native-refused', state: 'failed', exitCode: 1, nativeStreamError: refusal.message },
        files: { stdout: { captured: true }, normalized: { captured: true }, boot: { captured: true } } });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

it('records failed launch diagnostics while preserving the original launch error', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-native-launch-errors-'));
  const refusal = new Error('original native refusal');
  const capture = async () => { throw new Error('task ledger unavailable'); };
  try {
    await expect(withIsolatedNativeLaunchDiagnostics(evidenceDir, async () => { throw refusal; }, capture)).rejects.toBe(refusal);
    expect(readFileSync(join(evidenceDir, 'worker-progress.ndjson'), 'utf8'))
      .toContain('launch-diagnostics-failed');
    await expect(withIsolatedNativeLaunchDiagnostics(evidenceDir, async () => 'started', capture))
      .rejects.toThrow('task ledger unavailable');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

it('retains native output when a later source snapshot is empty or shorter', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-native-shrink-'));
  const source = join(evidenceDir, 'source.log');
  const task = { taskId: 'private-native', state: 'running' };
  try {
    writeFileSync(source, 'native output before source truncation\n');
    retainIsolatedNativeTaskDiagnostics(evidenceDir, task, { stdout: source });
    for (const next of ['', 'partial\n']) {
      writeFileSync(source, next);
      retainIsolatedNativeTaskDiagnostics(evidenceDir, task, { stdout: source });
      expect(readFileSync(join(evidenceDir, 'native-task-stdout.log'), 'utf8'))
        .toBe('native output before source truncation\n');
      expect(JSON.parse(readFileSync(join(evidenceDir, 'native-task-diagnostics.json'), 'utf8')))
        .toMatchObject({ files: { stdout: { source, captured: false, reason: 'source-shrank',
          bytes: Buffer.byteLength(next), retainedBytes: Buffer.byteLength('native output before source truncation\n') } } });
    }
    writeFileSync(source, 'native output before source truncation\nnew output\n');
    retainIsolatedNativeTaskDiagnostics(evidenceDir, task, { stdout: source });
    expect(readFileSync(join(evidenceDir, 'native-task-stdout.log'), 'utf8')).toContain('new output');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

it('retains and enrolls the native Codex TUI log before disposable home removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-codex-log-'));
  const home = join(root, 'native-home');
  const evidence = join(root, 'phases', 'execute');
  mkdirSync(join(home, 'log'), { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const log = join(home, 'log', 'codex-tui.log');
  try {
    writeFileSync(log, 'MCP initialization failed: superuser_non_loopback\n');
    retainIsolatedNativeTaskDiagnostics(evidence, { taskId: 'private-native' }, {}, home);
    writeFileSync(join(home, 'config.toml'), '[invalid');
    retainIsolatedNativeTaskDiagnostics(evidence, { taskId: 'private-native' }, {}, home);
    expect(JSON.parse(readFileSync(join(evidence, 'native-task-diagnostics.json'), 'utf8')))
      .toMatchObject({ files: { 'codex-config': { captured: false, reason: 'invalid-config' } } });
    rmSync(home, { recursive: true });
    retainIsolatedNativeTaskDiagnostics(evidence, { taskId: 'private-native' }, {}, home);
    expect(readFileSync(join(evidence, 'native-task-codex-tui.log'), 'utf8'))
      .toContain('MCP initialization failed: superuser_non_loopback');
    expect(JSON.parse(readFileSync(join(evidence, 'native-task-diagnostics.json'), 'utf8')))
      .toMatchObject({ files: { 'codex-tui': { source: log, captured: false, reason: 'missing' } } });
    expect(isolatedIntegrationDiagnosticArtifacts(root)).toContain('phases/execute/native-task-codex-tui.log');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('retains and enrolls native host lifecycle events before disposable home removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-native-host-events-'));
  const home = join(root, 'native-home');
  const evidence = join(root, 'phases', 'execute');
  mkdirSync(home, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const source = join(home, 'owner.events.jsonl');
  const events = JSON.stringify({ kind: 'respawn-carry-deferred', reason: 'busy-gate-expired' }) + '\n';
  const sources = { 'host-events': source };
  try {
    writeFileSync(source, events);
    retainIsolatedNativeTaskDiagnostics(evidence, { taskId: 'private-native' }, sources);
    rmSync(home, { recursive: true });
    retainIsolatedNativeTaskDiagnostics(evidence, { taskId: 'private-native' }, sources);
    expect(readFileSync(join(evidence, 'native-task-host-events.log'), 'utf8')).toBe(events);
    expect(JSON.parse(readFileSync(join(evidence, 'native-task-diagnostics.json'), 'utf8')))
      .toMatchObject({ files: { 'host-events': { source, captured: false, reason: 'missing' } } });
    expect(isolatedIntegrationDiagnosticArtifacts(root)).toContain('phases/execute/native-task-host-events.log');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('records an unreadable native Codex TUI log without masking the task result', () => {
  const evidence = mkdtempSync(join(tmpdir(), 'isolated-codex-log-permission-'));
  try {
    retainIsolatedNativeTaskDiagnostics(evidence, { taskId: 'private-native', state: 'failed' }, {}, '/root');
    expect(JSON.parse(readFileSync(join(evidence, 'native-task-diagnostics.json'), 'utf8')))
      .toMatchObject({ files: { 'codex-tui': { captured: false, reason: 'permission-denied' } } });
  } finally { rmSync(evidence, { recursive: true, force: true }); }
});

it('retains native MCP configuration evidence without credentials after home removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'isolated-native-config-'));
  const home = join(root, 'native-home'), evidence = join(root, 'phases', 'execute');
  mkdirSync(home); mkdirSync(evidence, { recursive: true });
  try {
    writeFileSync(join(home, 'config.toml'), `model = "fixture-model"
[mcp_servers.papercusp-su]
url = "http://papercusp-egress:9071/api/mcp?client=fixture-owner&superuser=1&token=${NEVER_EMIT_MARKER}"
http_headers = { Authorization = "Bearer ${NEVER_EMIT_MARKER}" }
env_http_headers = { "x-papercusp-native-session" = "CODEX_SESSION_ID" }
`);
    retainIsolatedNativeTaskDiagnostics(evidence, { taskId: 'private-native' }, {}, home);
    rmSync(home, { recursive: true });
    retainIsolatedNativeTaskDiagnostics(evidence, { taskId: 'private-native' }, {}, home);
    const retained = readFileSync(join(evidence, 'native-task-config.json'), 'utf8');
    expect(retained).not.toContain(NEVER_EMIT_MARKER);
    expect(JSON.parse(retained)).toMatchObject({ model: 'fixture-model', mcpServers: [{
      name: 'papercusp-su', origin: 'http://papercusp-egress:9071', pathname: '/api/mcp',
      headerNames: ['Authorization'], envHeaderNames: ['x-papercusp-native-session'],
    }] });
    expect(isolatedIntegrationDiagnosticArtifacts(root)).toContain('phases/execute/native-task-config.json');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('preserves failure progress and verifies a real reaped signal without certifying success', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-progress-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    expect(() => assertIsolatedWorkerReaped(child, { runtimeRemoved: true, pgDataRemoved: true })).toThrow(/reaped/);
    retainIsolatedWorkerProgress(evidenceDir, 'launch-returned', { agentStarted: null });
    retainIsolatedWorkerProgress(evidenceDir, 'task-observed', { state: 'pending' });
    const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBe('SIGTERM');
    expect(() => assertIsolatedWorkerReaped(child, { runtimeRemoved: false, pgDataRemoved: true })).toThrow(/cleanup/);
    expect(() => assertIsolatedWorkerReaped(child, { runtimeRemoved: true, pgDataRemoved: true })).not.toThrow();
    const rows = readFileSync(join(evidenceDir, 'worker-progress.ndjson'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(rows).toEqual([
      { stage: 'launch-returned', observedAt: expect.any(String), agentStarted: null },
      { stage: 'task-observed', observedAt: expect.any(String), state: 'pending' },
    ]);
    expect(rows.every(row => Number.isFinite(Date.parse(row.observedAt)))).toBe(true);
  } finally { child.kill('SIGKILL'); rmSync(evidenceDir, { recursive: true, force: true }); }
});

// Only the parent's telemetry database is substituted. The proof writer,
// worker IPC, kernel process identities, receipt retention and pruning are real.
vi.mock('../test/_org-test-db', () => ({ createOrgTestDb: async () => ({
  dbName: 'isolated-proof-telemetry', adminDsn: 'unused', adminSql: {}, cleanup: async () => {},
}) }));
vi.mock('./_baseline-coord-fixture', () => ({ setupBaselineCoordFixture: async () => ({ dispose: async () => {} }) }));
vi.mock('./degradation/fallback-observations', () => ({ flushFallbackObservations: async () => ({ failed: 0 }) }));

it('records a missing receipt sink as preparation failure with no worker to tear down', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'isolated-proof-sink-'));
  const root = resolve(import.meta.dirname, '../../..');
  const prepare = vi.fn(), execute = vi.fn();
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', fixture);
  vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(fixture, 'retention'));
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(fixture, 'locks'));
  vi.stubEnv('PAPERCUSP_TEST_RUN_RECEIPT_FILE', join(fixture, 'receipts.ndjson'));
  vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', undefined);
  try {
    await expect(recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/isolated-integration-proof.test.ts', sourcePaths: [],
      prepare, execute,
    })).rejects.toThrow('PAPERCUSP_TEST_RUNS_DB_URL is required for durable isolated test receipts');
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    const { readdirSync } = await import('node:fs');
    const runId = readdirSync(join(fixture, 'isolated-integration')).find(name => /^\d{8}T/.test(name));
    expect(runId).toBeTruthy();
    const result = JSON.parse(readFileSync(join(fixture, 'isolated-integration', runId!, 'result.json'), 'utf8'));
    expect(result.verdict).toBe('fail');
    expect(result.firstFailure.phase).toBe('prepare');
    expect(result.phases.find((phase: { phase: string }) => phase.phase === 'teardown').status).toBe('passed');
    expect(existsSync(join(fixture, 'isolated-integration', runId!, 'phases/execute/lifecycle.json'))).toBe(false);
  } finally { vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); }
});

it.each([
  { fails: false, ended: true, valid: true },
  { fails: true, ended: true, valid: true },
  { fails: false, ended: false, valid: true },
  { fails: false, ended: true, valid: false },
])('retains original proof diagnostics through pruning (fails=$fails ended=$ended valid=$valid)', async ({ fails, ended, valid }) => {
  const fixture = mkdtempSync(join(tmpdir(), 'isolated-proof-failure-'));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceRoot = join(fixture, 'isolated-integration');
  const runtimeRoot = join(fixture, 'runtime');
  const dataDir = join(fixture, 'pg');
  const supervisorPath = join(fixture, 'supervisor.cjs');
  const workspace = 'test-runtime-proof-failure';
  let child: ReturnType<typeof fork> | undefined;
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', fixture);
  // Retention operates only on this disposable evidence. Keep its pin store
  // and mutex private too, so host cleanup cannot stall these lifecycle tests.
  vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(fixture, 'retention'));
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(fixture, 'locks'));
  try {
    mkdirSync(runtimeRoot); mkdirSync(dataDir);
    writeFileSync(supervisorPath, `
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const root = process.cwd(), runtimeRoot = process.env.PROOF_RUNTIME, dataDir = process.env.PROOF_DATA;
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  cwd: root, stdio: 'ignore', env: { ...process.env, HOME: join(runtimeRoot, 'home'),
    PAPERCUSP_WORKSPACE_ID: '${workspace}', PAPERCUSP_PG_PORT: '34567', PAPERCUSP_SKIP_PG_DISCOVERY: '1' }
});
const database = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
Promise.all([once(worker, 'spawn'), once(database, 'spawn')]).then(() => {
  writeFileSync(join(dataDir, 'postmaster.pid'), database.pid + '\\nunused\\nunused\\n34567\\n');
  process.send({ kind: 'isolated-runtime-start', supervisorPid: process.pid, childPid: worker.pid,
    root: ${valid ? 'root' : "root + '/foreign'"}, runtimeRoot, dataDir, workspace: '${workspace}', pgPort: 34567, token: 'original' });
});
process.once('message', async message => {
  const stopped = Promise.all([once(worker, 'exit'), once(database, 'exit')]);
  worker.kill(); database.kill(); await stopped;
  rmSync(runtimeRoot, { recursive: true }); rmSync(dataDir, { recursive: true });
  if (${ended}) process.send({ kind: 'isolated-runtime-end', childPid: worker.pid, code: 0, signal: null,
    runtimeRemoved: true, pgDataRemoved: true }, () => process.disconnect());
  else process.disconnect();
  if (!message.accepted) process.exitCode = 1;
});
`);
    let runId: string | undefined;
    const run = recordIsolatedIntegrationProof({
      root, filePath: 'packages/operator-core/lib/isolated-integration-proof.test.ts', sourcePaths: [],
      retainedArtifacts: ['phases/execute/provider-response.json'],
      prepare: evidenceDir => {
        writeFileSync(join(evidenceDir, 'operator-api-build-result.json'), JSON.stringify({ status: 0, pid: 123 }));
        writeFileSync(join(evidenceDir, 'operator-api-build.log'), 'original preparation compiler diagnostic\n');
        writeFileSync(join(evidenceDir, 'hono-host.mjs.build-steps.jsonl'), '{"step":"prepare-compile","event":"end","status":0}\n');
      },
      execute: async (observe, evidenceDir) => {
        runId = JSON.parse(readFileSync(join(evidenceDir, '../prepare/source.json'), 'utf8')).runId;
        writeFileSync(join(evidenceDir, 'operator-api-build.log'), 'original nested bundle rejection\n');
        writeFileSync(join(evidenceDir, 'hono-host.mjs.build-steps.jsonl'), '{"step":"host-compile","event":"end","status":17}\n');
        writeFileSync(join(evidenceDir, 'build.log'), 'original legacy builder diagnostic\n');
        await retainPrivateProviderResponse(evidenceDir, new Response(JSON.stringify({
          detail: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
        }), { status: 400 }), { headers: {}, body: '{}' });
        const nativeLog = join(runtimeRoot, 'native.log');
        writeFileSync(nativeLog, 'native bootstrap stopped before first turn\n');
        retainIsolatedNativeTaskDiagnostics(evidenceDir, { taskId: 'private-native', state: 'running',
          sessionId: null }, { stdout: nativeLog, boot: join(runtimeRoot, 'missing-boot.log') });
        rmSync(nativeLog);
        retainIsolatedNativeTaskDiagnostics(evidenceDir, { taskId: 'private-native', state: 'running',
          sessionId: null }, { stdout: nativeLog });
        child = fork(supervisorPath, [], { cwd: root, execArgv: [],
          env: { ...process.env, PROOF_RUNTIME: runtimeRoot, PROOF_DATA: dataDir },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 5_000 });
        expect(result.code).toBe(valid ? 0 : 1);
        if (fails) throw new Error('original journey assertion');
      },
    });
    const rejected = fails || !ended || !valid;
    if (rejected) await expect(run).rejects.toThrow();
    else expect(await run).toBe(runId);
    const result = JSON.parse(readFileSync(join(evidenceRoot, runId!, 'result.json'), 'utf8'));
    expect(result.verdict).toBe(rejected ? 'fail' : 'pass');
    if (fails) expect(result.phases.find((p: { phase: string }) => p.phase === 'execute').detail)
      .toContain('original journey assertion');
    const artifacts = new Map<string, string>();
    for (const path of ['phases/prepare/operator-api-build-result.json',
      'phases/prepare/operator-api-build.log', 'phases/prepare/hono-host.mjs.build-steps.jsonl',
      'phases/execute/operator-api-build.log', 'phases/execute/hono-host.mjs.build-steps.jsonl',
      'phases/execute/build.log',
      'phases/execute/provider-response.json',
      'phases/execute/worker-result.json', 'phases/execute/lifecycle-observation.json',
      'phases/execute/native-task-stdout.log', 'phases/execute/native-task-diagnostics.json'])
      artifacts.set(path, readFileSync(join(evidenceRoot, runId!, path), 'utf8'));
    expect(artifacts.get('phases/execute/native-task-stdout.log')).toBe('native bootstrap stopped before first turn\n');
    expect(JSON.parse(artifacts.get('phases/execute/native-task-diagnostics.json')!)).toMatchObject({
      task: { sessionId: null, state: 'running' }, files: { stdout: { captured: false, reason: 'missing' } },
    });
    const lifecyclePath = 'phases/execute/lifecycle.json';
    if (valid) {
      const bytes = readFileSync(join(evidenceRoot, runId!, lifecyclePath), 'utf8');
      artifacts.set(lifecyclePath, bytes);
      expect(JSON.parse(bytes)).toMatchObject({ runId, workspace, runtimeRoot, dataDir,
        ended: ended ? { code: 0, signal: null, runtimeRemoved: true, pgDataRemoved: true } : null });
    } else {
      expect(existsSync(join(evidenceRoot, runId!, lifecyclePath))).toBe(false);
      expect(JSON.parse(artifacts.get('phases/execute/lifecycle-observation.json')!).observationError).toBeTruthy();
    }
    expect(existsSync(runtimeRoot) || existsSync(dataDir)).toBe(false);
    await runHarness({ contract: { name: 'isolated-integration', phases: [{ id: 'execute' }] },
      evidenceRoot, runId: '20991014T000000Z-1', guardRails: [], runPhase: async () => ({ ok: true }) });
    expect(await pruneRuns(evidenceRoot, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }), reserveBytes: () => 400,
    })).toContain(runId);
    for (const [path, bytes] of artifacts)
      expect(readFileSync(join(evidenceRoot, 'retained', runId!, path), 'utf8')).toBe(bytes);
    expect(JSON.parse(readFileSync(join(evidenceRoot, 'retained', runId!, 'result.json'), 'utf8')).verdict)
      .toBe(rejected ? 'fail' : 'pass');
  } finally {
    child?.kill('SIGKILL');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15_000);
