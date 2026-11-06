import { expect, it, vi } from 'vitest';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pruneRuns, runHarness } from '@papercusp/verification-harness';
import { assertIsolatedFileRunBudget, assertIsolatedWorkerReaped, captureIsolatedWorker, isolatedIntegrationDiagnosticArtifacts, isolatedTestFileWorkerOptions, isolatedWorkerOptions, isolatedWorkerFailureDetail, isolatedWorkerPendingStage, preflightCurrentSuNativeEgress, recordIsolatedIntegrationProof, retainIsolatedNativeTaskDiagnostics, retainIsolatedWorkerProgress, withIsolatedNativeLaunchDiagnostics } from '../test/isolated-integration-proof';
import { assertPrivateUnrelatedCheckpointObservation, privateClaudeModelConfig, privateCodexModelConfig, privateNativeDockerHost, retainPrivateProviderResponse, stopPrivateOperatorHost, type PrivateUnrelatedCheckpointObservation } from '../test/private-http-workspace-preflight';
const NEVER_EMIT_MARKER = 'never-emit-me';

it('restores the explicit native Docker endpoint after environment sanitization', () => {
  expect(privateNativeDockerHost(['--prepared-api-sha=abc', '--native-docker-host=unix:///run/docker-bench.sock']))
    .toBe('unix:///run/docker-bench.sock');
});

it.for([[], ['--native-docker-host='], ['--native-docker-host=tcp://127.0.0.1:2375'],
  ['--native-docker-host=unix:///'], ['--native-docker-host=unix:///run/a.sock', '--native-docker-host=unix:///run/b.sock']])(
  'refuses absent, ambiguous or nonlocal native Docker handoffs (%j)', argv => {
    expect(() => privateNativeDockerHost(argv)).toThrow(/explicit.*Docker endpoint/);
  });

it.each([undefined, '', '   '])('refuses implicit native benchmark Docker selection (%s) before allocation', async value => {
  vi.stubEnv('DOCKER_HOST', value);
  const directory = join(tmpdir(), 'native-egress-must-not-allocate-' + createHash('sha256').update(String(value)).digest('hex'));
  try {
    await expect(preflightCurrentSuNativeEgress(directory)).rejects.toThrow('requires explicit DOCKER_HOST');
    expect(existsSync(directory)).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});

it.each(['ready', 'sidecar-timeout', 'missing-image'] as const)(
  'retains native egress prerequisite %s before private API preparation', async outcome => {
    const directory = mkdtempSync(join(tmpdir(), 'native-egress-check-'));
    const calls: string[][] = [];
    const exec: Parameters<typeof preflightCurrentSuNativeEgress>[1] = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'image' && outcome === 'missing-image')
        return { code: 1, stdout: '', stderr: 'image unavailable' };
      if (args[0] === 'run' && outcome === 'sidecar-timeout')
        return { code: 124, stdout: '', stderr: 'subprocess timed out' };
      const stdout = args[0] === 'run' ? 'private-sidecar\n' : args[0] === 'exec'
        ? [8788, 9071].map(port => `0: 00000000:${port.toString(16).toUpperCase()} 00000000:0000 0A 0 0 0 0`).join('\n') : '';
      return { code: 0, stdout, stderr: '' };
    };
    try {
      vi.stubEnv('DOCKER_HOST', 'unix:///run/docker-bench.sock');
      const operation = preflightCurrentSuNativeEgress(directory, exec);
      if (outcome === 'ready') await expect(operation).resolves.toBeUndefined();
      else await expect(operation).rejects.toThrow(outcome === 'missing-image' ? /requires local image/ : /sidecar start failed/);
      const receipt = JSON.parse(readFileSync(join(directory, 'native-egress-preflight.json'), 'utf8'));
      expect(receipt).toMatchObject({ status: outcome === 'ready' ? 'ready' : 'failed', cleanupErrors: [],
        dockerHost: 'unix:///run/docker-bench.sock' });
      expect(receipt.runId).toMatch(/^native-preflight-[a-f0-9-]+$/);
      expect(existsSync(receipt.workRoot)).toBe(false);
      expect(receipt.commands.length).toBe(calls.length);
      expect(calls.some(args => args[0] === 'ps' && args.includes('label=papercusp.bench-egress=' + receipt.runId))).toBe(true);
      if (outcome === 'ready') expect(receipt.relayConnections).toBe(0);
      if (outcome === 'sidecar-timeout') expect(calls.some(args => args[0] === 'rm')).toBe(true);
      if (outcome === 'missing-image') expect(calls.some(args => args[0] === 'network' && args[1] === 'create')).toBe(false);
    } finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });

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

it('composes explicit per-phase maxima into an exact bounded enclosing file budget', () => {
  const options = isolatedWorkerOptions(120_000, {}, 120_000, {
    bootstrapMaxMs: 325_000,
    finalizeMaxMs: 45_000,
    teardownMaxMs: 45_000,
  });
  expect(options.phaseTimeouts).toMatchObject({
    bootstrapMaxMs: 325_000,
    executeMaxMs: 120_000,
    finalizeMaxMs: 45_000,
    teardownMaxMs: 45_000,
  });
  expect(options.testTimeoutMs).toBe(600_000);
});

it('contains preparation and original worker finalization without widening native assertions', () => {
  const worker = isolatedWorkerOptions(180_000, {});
  const proof = isolatedWorkerOptions(180_000, {}, 180_000, {}, 600_000);
  expect(proof.phaseTimeouts).toEqual(worker.phaseTimeouts);
  expect(proof.phaseTimeouts.executeMaxMs).toBe(180_000);
  expect(proof.testTimeoutMs).toBe(worker.testTimeoutMs + 600_000);
  expect(() => assertIsolatedFileRunBudget(proof.testTimeoutMs + proof.killGraceMs + 20_000, {}))
    .toThrow('enclosing router');
  expect(() => assertIsolatedFileRunBudget(proof.testTimeoutMs + proof.killGraceMs + 20_000,
    { PAPERCUSP_TEST_FILE_TIMEOUT_MS: String(proof.testTimeoutMs + proof.killGraceMs + 20_000) }))
    .not.toThrow();
});

it('keeps the execute stall default and carries an explicit long-verifier override', () => {
  expect(isolatedWorkerOptions(180_000, {}).phaseTimeouts.executeStallWindowMs).toBeUndefined();
  const stallWindowMs = 12 * 60_000;
  const direct = isolatedWorkerOptions(180_000, {}, 900_000, { executeStallWindowMs: stallWindowMs });
  const routed = isolatedTestFileWorkerOptions({}, 1, { executeStallWindowMs: stallWindowMs });
  expect(direct.phaseTimeouts.executeStallWindowMs).toBe(stallWindowMs);
  expect(routed.phaseTimeouts.executeStallWindowMs).toBe(stallWindowMs);
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

it('refuses a cancelled proof before reading source or allocating its observer', async () => {
  const execute = vi.fn();
  const prepare = vi.fn();
  await expect(recordIsolatedIntegrationProof({ root: '/never-allocate-cancelled-proof',
    filePath: 'never-run.test.ts', sourcePaths: [], signal: AbortSignal.abort(new Error('outer test cancelled')),
    prepare, execute })).rejects.toThrow('outer test cancelled');
  expect(prepare).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
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
    // ChildProcess.exitCode is readonly in @types/node; the fake's own field is writable.
    Object.assign(child, { exitCode: 0 });
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await result;
    vi.useRealTimers();
    child.stdout!.destroy(); child.stderr!.destroy();
    rmSync(evidenceDir, { recursive: true, force: true });
  }
}

const routerPhaseOptions = { phaseTimeouts: { bootstrapMs: 100, executeMs: 80, finalizeMs: 30, teardownMs: 30 },
  killGraceMs: 10, drainGraceMs: 10, testFileExecutionFromStdout: true };

it('retains the first worker failure after cleanup chatter and temporary log removal', async () => {
  const packet = mkdtempSync(join(tmpdir(), 'isolated-failure-packet-'));
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-failure-source-'));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: vi.fn(() => true) }) as unknown as ChildProcess;
  vi.stubEnv('PAPERCUSP_TEST_ARTIFACT_DIR', packet);
  try {
    const captured = captureIsolatedWorker(child, evidenceDir, { timeoutMs: 5_000 });
    const original = 'operator-api preflight failed: original cause\n' + 'cleanup chatter\n'.repeat(1000);
    child.stderr!.emit('data', original);
    Object.assign(child, { exitCode: 1 });
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    const result = await captured;
    rmSync(evidenceDir, { recursive: true, force: true });
    const line = result.output.slice(-6000).split('\n').find(value => value.startsWith('ISOLATED_WORKER_FAILURE_LOG '));
    expect(line).toBeDefined();
    const retained = JSON.parse(line!.slice('ISOLATED_WORKER_FAILURE_LOG '.length));
    const bytes = readFileSync(retained.path);
    expect(bytes.toString()).toBe(original);
    expect(retained.byteLength).toBe(bytes.length);
    expect(retained.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  } finally {
    vi.unstubAllEnvs();
    child.stdout!.destroy(); child.stderr!.destroy();
    rmSync(evidenceDir, { recursive: true, force: true });
    rmSync(packet, { recursive: true, force: true });
  }
});

it('starts an opted-in native execution clock at the first observed case, not router spawn', async () => {
  await withCapturedRouter({ ...routerPhaseOptions, testFileExecutionFromStdout: 'case' }, async (child, result) => {
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    await vi.advanceTimersByTimeAsync(90);
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr!.emit('data', 'TEST_FILE_CASE_TRACE {"event":"started","file":"native.test.ts","name":"native handoff"}\n');
    await vi.advanceTimersByTimeAsync(79);
    expect(child.kill).not.toHaveBeenCalled();
    // A second case-start receipt cannot restart the execution allowance.
    child.stderr!.emit('data', 'TEST_FILE_CASE_TRACE {"event":"started","file":"native.test.ts","name":"another case"}\n');
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  });
});

it('bounds opted-in native startup without a case despite repeated router start markers', async () => {
  await withCapturedRouter({ ...routerPhaseOptions, testFileExecutionFromStdout: 'case' }, async (child, result) => {
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    await vi.advanceTimersByTimeAsync(70);
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    child.stderr!.emit('data', 'TEST_FILE_CASE_TRACE {"event":"started"}\n');
    await vi.advanceTimersByTimeAsync(29);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  });
});

it('separates completed-file runner shutdown from execution before source provenance starts', async () => {
  await withCapturedRouter(routerPhaseOptions, async (child, result) => {
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    await vi.advanceTimersByTimeAsync(75);
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"files-complete"}\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"files-complete"}\n');
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"provenance-start"}\n');
    await vi.advanceTimersByTimeAsync(19);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'finalize' });
  });
});

it('keeps supervised router startup outside the test execution budget', async () => {
  await withCapturedRouter(routerPhaseOptions, async (child, result) => {
    // The private runtime is observed before the router lists files or admits
    // Vitest. Its lifetime receipt must not spend the test execution allowance.
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(90);
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    await vi.advanceTimersByTimeAsync(79);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  });
});

it('bounds supervised router startup despite repeated runtime lifetime receipts', async () => {
  await withCapturedRouter(routerPhaseOptions, async (child, result) => {
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(70);
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(29);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  });
});

it('starts buffered supervisor execution from runtime IPC without spending its bootstrap ceiling', async () => {
  const direct = isolatedTestFileWorkerOptions({}, 1, {}, 'runtime');
  const router = isolatedTestFileWorkerOptions({}, 1);
  expect(direct).toEqual({ ...router, testFileExecutionFromStdout: false });
  await withCapturedRouter({ ...direct,
    phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 30 },
    killGraceMs: 10, drainGraceMs: 10 }, async (child, result) => {
    await vi.advanceTimersByTimeAsync(90);
    child.emit('message', { kind: 'isolated-runtime-start' });
    // No nested TEST_FILE_PROGRESS reaches this parent while work executes.
    await vi.advanceTimersByTimeAsync(199);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  });
});

it.for([{ cooperative: true, abort: false }, { cooperative: false, abort: false },
  { cooperative: true, abort: true }, { cooperative: false, abort: true }])(
  'lets a detached supervisor clean up before the bounded group fallback: %j', async ({ cooperative, abort }) => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-supervisor-stop-'));
  const earlySignal = join(evidenceDir, 'descendant-signaled');
  const cleaned = join(evidenceDir, 'cleanup-complete');
  const script = `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(`
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => writeFileSync(${JSON.stringify(earlySignal)}, 'early'));
      process.on('message', () => { writeFileSync(${JSON.stringify(cleaned)}, 'tasks-before-database'); process.exit(0); });
      process.send('ready'); setInterval(() => {}, 1000);
    `)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    worker.on('message', () => process.send('ready'));
    worker.on('close', () => process.exit(0));
    process.on('SIGTERM', () => { if (${cooperative}) worker.send('cleanup'); });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    await once(child, 'message');
    // Drive only the parent's deadline. The real child gets to acknowledge
    // cooperative cleanup before the simulated hard-stop clock advances.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const controller = new AbortController();
    const captured = captureIsolatedWorker(child, evidenceDir,
      { timeoutMs: abort ? 10_000 : 50, killGraceMs: 1000, drainGraceMs: 1000, signal: controller.signal });
    if (abort) controller.abort(new Error('outer testcase deadline'));
    else await vi.advanceTimersByTimeAsync(50);
    if (!cooperative) await vi.advanceTimersByTimeAsync(1000);
    const result = await captured;
    expect(result).toMatchObject({ timedOut: !abort, aborted: abort,
      abortReason: abort ? 'Error: outer testcase deadline' : null, timeoutPhase: abort ? null : 'bootstrap',
      exitWaitTimedOut: false, stdioDrainTimedOut: false,
      code: cooperative ? 0 : null, signal: cooperative ? null : 'SIGKILL' });
    expect(existsSync(earlySignal)).toBe(false);
    expect(existsSync(cleaned)).toBe(cooperative);
    expect(JSON.parse(readFileSync(join(evidenceDir, 'worker-result.json'), 'utf8')))
      .toMatchObject({ aborted: abort, timedOut: !abort });
    if (abort) expect(isolatedWorkerFailureDetail(result.output, result))
      .toContain('ISOLATED_WORKER_ABORT reason=Error: outer testcase deadline');
  } finally {
    vi.useRealTimers();
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* owned group already reaped */ }
    if (child.connected) child.disconnect();
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

it('bounds cleanup when a supervised router stops before test execution', async () => {
  await withCapturedRouter(routerPhaseOptions, async (child, result) => {
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(10);
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    await vi.advanceTimersByTimeAsync(29);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'teardown' });
  });
});

it('keeps completed router provenance outside execution and bounds finalization without renewing it', async () => {
  await withCapturedRouter(routerPhaseOptions, async (child, result) => {
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    await vi.advanceTimersByTimeAsync(75);
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"provenance-start"}\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"provenance-start"}\n');
    await vi.advanceTimersByTimeAsync(19);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'finalize' });
  });
});

it('gives runtime shutdown its own bounded allowance after provenance finalization', async () => {
  await withCapturedRouter(routerPhaseOptions, async (child, result) => {
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"provenance-start"}\n');
    await vi.advanceTimersByTimeAsync(20);
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).not.toHaveBeenCalled();
    // A replayed finalizer or cleanup receipt cannot renew runtime shutdown.
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"provenance-start"}\n');
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    await vi.advanceTimersByTimeAsync(10);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'teardown' });
  });
});

it('separates nested worker finalization and renews it only on distinct census progress', async () => {
  const options = { ...routerPhaseOptions, phaseTimeouts: { ...routerPhaseOptions.phaseTimeouts,
    finalizeMaxMs: 90 } };
  await withCapturedRouter(options, async (child, result) => {
    const progress = (phase: string, stage: string) => child.stderr!.emit('data',
      'ISOLATED_WORKER_PROGRESS ' + JSON.stringify({ pid: 12345, phase, stage }) + '\n');
    progress('execute', 'phase-execute');
    await vi.advanceTimersByTimeAsync(75);
    progress('finalize', 'phase-finalize');
    await vi.advanceTimersByTimeAsync(20);
    progress('finalize', 'provenance-files-256');
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).not.toHaveBeenCalled();
    // A repeated count is not fresh progress and cannot extend this phase.
    progress('finalize', 'provenance-files-256');
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, aborted: false, timeoutPhase: 'finalize' });
  });
});

it.each([false, true])('cannot use provenance output to escape bootstrap or disabled router observation: %s', async enabled => {
  await withCapturedRouter({ ...routerPhaseOptions, testFileExecutionFromStdout: enabled }, async (child, result) => {
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"provenance-start"}\n');
    await vi.advanceTimersByTimeAsync(99);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  });
});

it('renews native bootstrap on source census advances while keeping the case execution clock separate', async () => {
  const options = { ...routerPhaseOptions, testFileExecutionFromStdout: 'case' as const,
    phaseTimeouts: { ...routerPhaseOptions.phaseTimeouts, bootstrapMaxMs: 300 } };
  await withCapturedRouter(options, async (child, result) => {
    await vi.advanceTimersByTimeAsync(90);
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION ' + JSON.stringify({ phase: 'provenance-progress',
      step: 'source-census', event: 'progress', completedFiles: 1, totalFiles: 2 }) + '\n');
    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr!.emit('data', 'TEST_FILE_CASE_TRACE {"event":"started","file":"native.test.ts","name":"native handoff"}\n');
    await vi.advanceTimersByTimeAsync(79);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  });
});

it.each(['repeated', 'regressed', 'changed-total', 'absolute-ceiling'])(
  'bounds native bootstrap source census progress: %s', async scenario => {
    const options = { ...routerPhaseOptions, testFileExecutionFromStdout: 'case' as const,
      phaseTimeouts: { ...routerPhaseOptions.phaseTimeouts, bootstrapMaxMs: 250 } };
    await withCapturedRouter(options, async (child, result) => {
      const progress = (completedFiles: number, totalFiles = 4) => child.stderr!.emit('data',
        'TEST_FILE_FINALIZATION ' + JSON.stringify({ phase: 'provenance-progress',
          step: 'source-census', event: 'progress', completedFiles, totalFiles }) + '\n');
      await vi.advanceTimersByTimeAsync(90);
      progress(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).not.toHaveBeenCalled();
      progress(scenario === 'regressed' ? 0 : scenario === 'repeated' ? 1 : 2,
        scenario === 'changed-total' ? 5 : 4);
      await vi.advanceTimersByTimeAsync(10);
      if (scenario === 'absolute-ceiling') {
        expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(40);
        progress(3);
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('close');
      expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
    });
  });

it.each([0, 1, 2])('extends bounded finalization only for advancing source census counts: %s', async nextCount => {
  const options = { ...routerPhaseOptions, phaseTimeouts: { ...routerPhaseOptions.phaseTimeouts,
    finalizeMaxMs: 90 } };
  await withCapturedRouter(options, async (child, result) => {
    const progress = (completedFiles: number) => child.stderr!.emit('data',
      'TEST_FILE_FINALIZATION ' + JSON.stringify({ phase: 'provenance-progress',
        step: 'source-census', event: 'progress', completedFiles, totalFiles: 2 }) + '\n');
    child.stderr!.emit('data', 'TEST_FILE_PROGRESS state=started\n');
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"provenance-start"}\n');
    await vi.advanceTimersByTimeAsync(20);
    progress(1);
    await vi.advanceTimersByTimeAsync(39);
    expect(child.kill).not.toHaveBeenCalled();
    progress(nextCount);
    await vi.advanceTimersByTimeAsync(1);
    if (nextCount === 2) {
      expect(child.kill).not.toHaveBeenCalled();
      // Even continuing file progress cannot grow the original absolute ceiling.
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'finalize' });
  });
});

it('measures bootstrap and finalization source census progress independently', async () => {
  const options = { ...routerPhaseOptions, testFileExecutionFromStdout: 'case' as const,
    phaseTimeouts: { ...routerPhaseOptions.phaseTimeouts, bootstrapMaxMs: 300, finalizeMaxMs: 90 } };
  await withCapturedRouter(options, async (child, result) => {
    const progress = (completedFiles: number, totalFiles: number) => child.stderr!.emit('data',
      'TEST_FILE_FINALIZATION ' + JSON.stringify({ phase: 'provenance-progress',
        step: 'source-census', event: 'progress', completedFiles, totalFiles }) + '\n');
    progress(4, 4);
    child.stderr!.emit('data', 'TEST_FILE_CASE_TRACE {"event":"started","file":"native.test.ts","name":"native handoff"}\n');
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION {"phase":"files-complete"}\n');
    await vi.advanceTimersByTimeAsync(20);
    progress(1, 2);
    await vi.advanceTimersByTimeAsync(39);
    expect(child.kill).not.toHaveBeenCalled();
    progress(1, 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'finalize' });
  });
});

it('ignores bootstrap source census output when router observation is disabled', async () => {
  const options = { ...routerPhaseOptions, testFileExecutionFromStdout: false,
    phaseTimeouts: { ...routerPhaseOptions.phaseTimeouts, bootstrapMaxMs: 300 } };
  await withCapturedRouter(options, async (child, result) => {
    await vi.advanceTimersByTimeAsync(90);
    child.stderr!.emit('data', 'TEST_FILE_FINALIZATION ' + JSON.stringify({ phase: 'provenance-progress',
      step: 'source-census', event: 'progress', completedFiles: 1, totalFiles: 2 }) + '\n');
    // The watchdog's initial observation is at t=0, so the first checkpoint
    // at t=100 is still within its stall window; no fresh evidence reaches t=200.
    await vi.advanceTimersByTimeAsync(110);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close');
    expect(await result).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  });
});

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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const exited = once(host, 'exit');
    const stopped = expect(stopPrivateOperatorHost(host, undefined, 100))
      .rejects.toThrow('stdio drainage did not settle');
    await exited;
    await vi.advanceTimersByTimeAsync(100);
    await stopped;
    expect(host.exitCode !== null || host.signalCode !== null).toBe(true);
    if (termination === 'signal') expect(host.signalCode).toBe('SIGKILL');
    expect(() => process.kill(nativePid!, 0)).not.toThrow();
  } finally {
    vi.useRealTimers();
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

it('reports the last unmatched worker phase as the timeout pending stage', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-progress-stage-'));
  try {
    retainIsolatedWorkerProgress(evidenceDir, 'private-database-connect-start', { phase: 'execute' });
    retainIsolatedWorkerProgress(evidenceDir, 'private-database-connect-complete', { port: 54321 });
    retainIsolatedWorkerProgress(evidenceDir, 'agent-tools-bootstrap-start', { phase: 'execute' });
    expect(isolatedWorkerPendingStage(evidenceDir)).toMatchObject({
      stage: 'agent-tools-bootstrap-start',
      phase: 'execute',
    });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
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
// Source collection must stay inert even when the binding handler graph cannot load.
vi.mock('./agent-tools/plans/bind-from-test-run', () => {
  throw new Error('Proof source collection must not import the binding tool graph');
});
vi.mock('../test/_org-test-db', () => ({ createOrgTestDb: async () => ({
  dbName: 'isolated-proof-telemetry', adminDsn: 'unused', adminSql: {}, cleanup: async () => {},
}) }));
vi.mock('./_baseline-coord-fixture', () => ({ setupBaselineCoordFixture: async () => ({ dispose: async () => {} }) }));
vi.mock('./degradation/fallback-observations', () => ({ flushFallbackObservations: async () => ({ failed: 0 }) }));

it.each(['PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PC_EXECUTED_SOURCE_MAP_RESULT', 'PC_EXECUTED_SOURCE_MAP_OUT'])(
  'records missing %s receipt sink as preparation failure with no worker to tear down', async receiptKey => {
  const fixture = mkdtempSync(join(tmpdir(), 'isolated-proof-sink-'));
  const root = resolve(import.meta.dirname, '../../..');
  const prepare = vi.fn(), execute = vi.fn();
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', fixture);
  vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', join(fixture, 'retention'));
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', join(fixture, 'locks'));
  for (const key of ['PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PC_EXECUTED_SOURCE_MAP_RESULT', 'PC_EXECUTED_SOURCE_MAP_OUT'])
    vi.stubEnv(key, key === receiptKey ? join(fixture, 'receipts.ndjson') : undefined);
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
  let stage = 'setup';
  // Capture the awaited boundary before Vitest's existing deadline can erase
  // attribution. This observation neither renews nor replaces that deadline.
  const stallDiagnostic = setTimeout(() => {
    const runs = existsSync(evidenceRoot) ? readdirSync(evidenceRoot).filter(name => /^\d{8}T/.test(name)) : [];
    const preparation = runs.map(run => {
      const path = join(evidenceRoot, run, 'phases/prepare/worker-progress.ndjson');
      return { run, progress: existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').slice(-6) : [] };
    });
    process.stderr.write('ISOLATED_PROOF_FIXTURE_PENDING ' +
      JSON.stringify({ stage, fixture, fails, ended, valid, preparation }) + '\n');
  }, 10_000);
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
    stage = 'record-proof';
    const run = recordIsolatedIntegrationProof({
      root, filePath: 'packages/operator-core/lib/isolated-integration-proof.test.ts', sourcePaths: [],
      retainedArtifacts: ['phases/execute/provider-response.json'],
      prepare: evidenceDir => {
        stage = 'prepare';
        writeFileSync(join(evidenceDir, 'operator-api-build-result.json'), JSON.stringify({ status: 0, pid: 123 }));
        writeFileSync(join(evidenceDir, 'operator-api-build.log'), 'original preparation compiler diagnostic\n');
        writeFileSync(join(evidenceDir, 'hono-host.mjs.build-steps.jsonl'), '{"step":"prepare-compile","event":"end","status":0}\n');
      },
      execute: async (observe, evidenceDir) => {
        stage = 'execute';
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
        stage = 'worker-capture';
        const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 5_000 });
        stage = 'worker-complete';
        expect(result.code).toBe(valid ? 0 : 1);
        if (fails) throw new Error('original journey assertion');
      },
    });
    const rejected = fails || !ended || !valid;
    if (rejected) await expect(run).rejects.toThrow();
    else expect(await run).toBe(runId);
    stage = 'proof-settled';
    const result = JSON.parse(readFileSync(join(evidenceRoot, runId!, 'result.json'), 'utf8'));
    expect(result.verdict).toBe(rejected ? 'fail' : 'pass');
    if (fails) expect(result.phases.find((p: { phase: string }) => p.phase === 'execute').detail)
      .toContain('original journey assertion');
    const artifacts = new Map<string, string>();
    for (const path of ['phases/prepare/worker-progress.ndjson', 'phases/prepare/operator-api-build-result.json',
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
    stage = 'sentinel';
    await runHarness({ contract: { name: 'isolated-integration', phases: [{ id: 'execute' }] },
      evidenceRoot, runId: '20991014T000000Z-1', guardRails: [], runPhase: async () => ({ ok: true }) });
    stage = 'prune';
    expect(await pruneRuns(evidenceRoot, 1, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }), reserveBytes: () => 400,
    })).toContain(runId);
    stage = 'retained-compare';
    for (const [path, bytes] of artifacts)
      expect(readFileSync(join(evidenceRoot, 'retained', runId!, path), 'utf8')).toBe(bytes);
    expect(JSON.parse(readFileSync(join(evidenceRoot, 'retained', runId!, 'result.json'), 'utf8')).verdict)
      .toBe(rejected ? 'fail' : 'pass');
  } finally {
    clearTimeout(stallDiagnostic);
    child?.kill('SIGKILL');
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15_000);
