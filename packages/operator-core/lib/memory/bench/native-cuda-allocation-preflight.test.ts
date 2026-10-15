import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { inspectNativeCudaAllocationFailure } from './measurement-manifest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = fileURLToPath(new URL('./fixtures/native-cuda-clock-preflight.py', import.meta.url));

describe('retained native CUDA allocation cause', () => {
  const report = (api: string) => `========= Program hit cudaErrorMemoryAllocation (error 2) due to "out of memory" on CUDA API call to ${api}.
=========         Host Frame: [0x1ee77a] in libonnxruntime_providers_cuda.so
=========         Host Frame: InferenceSessionWrap::Run(Napi::CallbackInfo const&) [0x1ad40] in onnxruntime_binding.node
`;
  const log = report('cudaMalloc') + report('cudaGetLastError') + '========= ERROR SUMMARY: 2 errors\n';
  it('distinguishes the failed allocation from propagation without asserting pressure or allocation sizes', () => {
    expect(inspectNativeCudaAllocationFailure(log)).toEqual({ underlyingApi: 'cudaMalloc', returnCode: 2,
      allocationErrors: 1, propagatedErrors: 1, cudaProviderOffsets: ['0x1ee77a', '0x1ee77a'] });
  });
  it.each([
    ['generic arena error', 'BFCArena::AllocateRawInternal Failed to allocate memory for requested buffer of size 3221225472'],
    ['propagation only', report('cudaGetLastError') + '========= ERROR SUMMARY: 1 error\n'],
    ['another error code', log.replaceAll('error 2', 'error 3')],
    ['another provider', log.replaceAll('libonnxruntime_providers_cuda.so', 'libunrelated.so')],
    ['unbound native call', log.replaceAll('InferenceSessionWrap::Run', 'UnrelatedWorker::Run')],
    ['partial census', log.replace('SUMMARY: 2', 'SUMMARY: 1')],
    ['missing terminal summary', log.replace('========= ERROR SUMMARY: 2 errors\n', '')],
  ])('refuses %s as allocation-cause evidence', (_name, value) => {
    expect(() => inspectNativeCudaAllocationFailure(value)).toThrow('CUDA allocation diagnostic');
  });
});

function control(failureCode: number, successfulFailure = false, capacity = 4096) {
  const root = mkdtempSync(join(tmpdir(), 'cuda-allocation-control-')); roots.push(root);
  const output = join(root, 'receipt.json');
  // Execute the actual maintained fixture with a deterministic CUDA ABI stub.
  // The live GPU/tool qualification remains a separate measured receipt.
  const program = `
import ctypes as c,sys,json
allocations=[]; frees=[]
class Function:
 def __init__(self, fn): self.fn=fn
 def __call__(self,*args): return self.fn(*args)
def allocate(pointer,size):
 allocations.append(size)
 if size==32 or ${successfulFailure ? 'True' : 'False'}: pointer._obj.value=len(allocations); return 0
 return ${failureCode}
def memory(free,total): free._obj.value=${capacity}; total._obj.value=${capacity}; return 0
class CUDA:
 cudaSetDevice=Function(lambda n:0)
 cudaMalloc=Function(allocate)
 cudaMemcpy=Function(lambda *a:0)
 cudaFree=Function(lambda p:frees.append(p.value) or 0)
 cudaMemGetInfo=Function(memory)
 cudaGetErrorString=Function(lambda n:b'out of memory')
c.CDLL=lambda p:CUDA()
sys.argv=[${JSON.stringify(fixture)},${JSON.stringify(output)},'allocator-api-control']
source=open(sys.argv[0]).read()
try: exec(compile(source,sys.argv[0],'exec'),{'__file__':sys.argv[0]})
finally: print('ABI_CALLS '+json.dumps({'allocations':allocations,'frees':frees}))
`;
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', program], { encoding: 'utf8', timeout: 10000 });
  return { result, output };
}

describe('model-free CUDA allocator diagnostic control', () => {
  it('requires an actual allocation error beyond total capacity, retains call clocks, and frees the small control', () => {
    const { result, output } = control(2);
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(output, 'utf8'));
    expect(receipt).toMatchObject({ returnCode: 2, requestedBytes: 8192, totalBytes: 4096,
      smallAllocationBytes: 32, modelInferencePerformed: false });
    expect(BigInt(receipt.beforeClock.monotonicAfterNs)).toBeLessThanOrEqual(BigInt(receipt.afterClock.monotonicBeforeNs));
    expect(result.stdout).toContain('PC_CUDA_ALLOCATION_CONTROL\tstart');
    expect(result.stdout).toContain('PC_CUDA_ALLOCATION_CONTROL\tend');
    expect(result.stdout).toContain('ABI_CALLS {"allocations": [32, 8192], "frees": [1]}');
  });

  it.each([0, 1, 3, 999])('refuses another CUDA return code %s and still frees the successful control', code => {
    const { result } = control(code);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not return cudaErrorMemoryAllocation');
    expect(result.stdout).toContain('"frees": [1]');
  });

  it('refuses unexpected success and frees both allocations', () => {
    const { result } = control(0, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not return cudaErrorMemoryAllocation');
    expect(result.stdout).toContain('"frees": [2, 1]');
  });

  it('refuses an unmeasured total capacity before allocating', () => {
    const { result } = control(2, false, 0);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid CUDA allocation control capacity');
    expect(result.stdout).toContain('ABI_CALLS {"allocations": [], "frees": []}');
  });
});

describe('native allocator INFO logging preload', () => {
  const preload = fileURLToPath(new URL('./fixtures/native-ort-allocator-logging.mjs', import.meta.url));
  const program = () => {
    const root = mkdtempSync(join(tmpdir(), 'allocator-logging-worker-')); roots.push(root);
    const file = join(root, 'worker.mjs'); writeFileSync(file, 'export {};\n');
    return `(async()=>{
const imported=await import(${JSON.stringify(preload)});
const restore=imported.installNativeAllocatorLogging(${JSON.stringify(file)});
const {Worker}=require('node:worker_threads');
const worker=new Worker(${JSON.stringify(file)},{workerData:{device:'cuda'},execArgv:[]});
worker.on('error',error=>{console.error(error);process.exitCode=1});
worker.on('exit',()=>restore());
})().catch(error=>{console.error(error);process.exitCode=1});`;
  };
  it('uses the supported logging hook without constructing a model or changing provider options', () => {
    const result = spawnSync(process.execPath, ['-e', program()], {
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) },
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stderr.split('\n').find(line => line.startsWith('PC_ORT_ALLOCATOR_LOGGING\t'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.split('\t')[1])).toMatchObject({ onnxLogLevel: 'info', transformersLogLevel: 20,
      modelInferencePerformed: false, providerOptionsChanged: false });
    expect(JSON.parse(line!.split('\t')[1]).workerThreadId).toBeGreaterThan(0);
  });

  it('refuses an absent runtime configuration before importing native dependencies', () => {
    const env = { ...process.env }; delete env.TSX_TSCONFIG_PATH;
    const result = spawnSync(process.execPath, ['-e', program()], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('allocator logging requires the bound runtime configuration path');
    expect(result.stderr).not.toContain('PC_ORT_ALLOCATOR_LOGGING\t');
  });

  it('leaves the parent and loader contexts silent without importing native dependencies', () => {
    const env = { ...process.env }; delete env.TSX_TSCONFIG_PATH;
    const result = spawnSync(process.execPath, ['--import', preload, '-e', ''], { env, encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('PC_ORT_ALLOCATOR_LOGGING\t');
  });
});

describe('small native ORT teardown control', () => {
  const controlFixture = fileURLToPath(new URL('./fixtures/native-ort-teardown-control.mjs', import.meta.url));
  const fromTransformers = createRequire(createRequire(import.meta.url).resolve('@huggingface/transformers'));
  const ortEntry = fromTransformers.resolve('onnxruntime-node');

  it('binds native abort evidence to the inferior process rather than the debugger exit', async () => {
    // GDB is an opt-in diagnostic dependency. Exercise the actual evidence
    // reader without making ordinary CI depend on a system debugger or CUDA.
    const { inspectHostDebuggerCapture } = await import('./fixtures/native-ort-teardown-control.mjs');
    const record = (row: object) => 'PC_NATIVE_DEBUGGER\t' + JSON.stringify(row) + '\n';
    const start = record({ event: 'start', processId: 123 });
    const signal = record({ event: 'signal', processId: 123, signal: 'SIGABRT' });
    const backtrace = 'PC_NATIVE_BACKTRACE_BEGIN\n#0 abort\nPC_NATIVE_BACKTRACE_END\n';
    const exit = record({ event: 'exit', processId: 123, exitCode: null, signal: 'SIGABRT', signalDelivered: true });
    const terminal = { eof: true, exitCode: 0, signal: null };
    expect(inspectHostDebuggerCapture(start + signal + backtrace + exit, terminal)).toMatchObject({
      processId: 123, source: 'gdb-events', exitCode: null, signal: 'SIGABRT', hostBacktraceCaptured: true,
    });
    for (const stdout of [start, start + exit, start + signal + exit,
      start + signal + backtrace + exit.replace('123', '124'),
      start + signal + backtrace + exit.replace('true', 'false'),
      start + signal + backtrace + exit + exit,
      start + signal + backtrace + exit + record({ event: 'error', message: 'lost inferior' })]) {
      expect(() => inspectHostDebuggerCapture(stdout, terminal)).toThrow(/native debugger/);
    }
    expect(() => inspectHostDebuggerCapture(start + signal + backtrace + exit, { ...terminal, eof: false })).toThrow();
    expect(() => inspectHostDebuggerCapture(start + signal + backtrace + exit, { ...terminal, exitCode: 1 })).toThrow();
    expect(inspectHostDebuggerCapture(start + record({ event: 'exit', processId: 123, exitCode: 1,
      signal: null, signalDelivered: true }), terminal)).toMatchObject({ exitCode: 1, signal: null, hostBacktraceCaptured: false });
  });

  it('qualifies native ownership observer boundaries and rejects foreign, duplicated or cross-thread returns', async () => {
    const { inspectNativeOwnershipCapture: inspect } = await import('./fixtures/native-ort-teardown-control.mjs');
    const operations = ['initializer', 'singleton-create', 'session-dispose', 'session-finalize',
      'instance-finalize', 'singleton-destroy'];
    const symbols = Object.fromEntries(operations.map(key => [key, 'qualified-' + key]));
    const relativeAddresses = Object.fromEntries(operations.map((key, i) => [key, 0x1000 + i * 16]));
    const binding = { path: '/fixture/onnxruntime_binding.node', bytes: 384040, sha256: 'a'.repeat(64) };
    const event = (row: object) => 'PC_NATIVE_DEBUGGER\t' + JSON.stringify(row) + '\n';
    const host = event({ event: 'start', processId: 123 }) + event({ event: 'exit', processId: 123,
      exitCode: 1, signal: null, signalDelivered: true });
    const terminal = { eof: true, exitCode: 0, signal: null };
    const row = (operation: string, callId: number, phase: string, sequence: number) => ({
      operation, callId, event: phase, sequence, processId: 123, nativeThreadId: 124,
      symbol: symbols[operation], programCounter: '0x1234', relativeAddress: relativeAddresses[operation], binding,
    });
    // The singleton constructor is nested inside InitOrtOnce. A main-thread
    // finalizer may run after worker-owned initialization and disposal.
    const rows = [row('initializer', 1, 'enter', 1), row('singleton-create', 2, 'enter', 2),
      row('singleton-create', 2, 'return', 3), row('initializer', 1, 'return', 4),
      ...operations.slice(2).flatMap((op, i) => [row(op, i + 3, 'enter', i * 2 + 5),
        row(op, i + 3, 'return', i * 2 + 6)])];
    const encode = (values = rows) => host + values.map(value => 'PC_NATIVE_OWNERSHIP\t' + JSON.stringify(value) + '\n').join('');
    const expected = { symbols, binding, relativeAddresses };
    expect(inspect(encode(), terminal, expected)).toMatchObject({ completeOwnershipBoundariesObserved: true,
      initializerNativeThreadId: 124, missingOperations: [], heapCorruptionRootCauseConfirmed: false });
    for (const changed of [
      rows.map((value, i) => i === 3 ? { ...value, nativeThreadId: 125 } : value),
      rows.map((value, i) => i === 3 ? { ...value, processId: 999 } : value),
      rows.map((value, i) => i === 3 ? { ...value, symbol: 'foreign' } : value),
      rows.map((value, i) => i === 3 ? { ...value, binding: { ...binding, sha256: 'b'.repeat(64) } } : value),
      rows.map((value, i) => i === 3 ? { ...value, binding: { ...binding, bytes: 1 } } : value),
      rows.map((value, i) => i === 3 ? { ...value, programCounter: '0x9999' } : value),
      // The v1 GDB observer hit D0 at 0x1dd70 while labelling D2 (0x1d9e0).
      // Matching labels and a pinned DSO must not qualify that wrong variant.
      rows.map(value => value.operation === 'session-finalize' ? { ...value, relativeAddress: 0x1dd70 } : value),
      rows.map((value, i) => i === 3 ? { ...value, sequence: 1 } : value),
      rows.map((value, i) => i === 4 ? { ...value, callId: 1 } : value),
      rows.map((value, i) => i === 3 ? { ...value, event: 'error' } : value),
      [...rows, { ...rows.at(-1)!, sequence: rows.length + 1 }],
    ]) expect(() => inspect(encode(changed), terminal, expected)).toThrow(/native ownership/);
    expect(() => inspect(host, terminal, expected)).toThrow(/native ownership/);
    expect(() => inspect(encode(), { ...terminal, eof: false }, expected)).toThrow(/native debugger/);
    expect(() => inspect(encode(), terminal, { ...expected, symbols: {} })).toThrow(/native ownership/);
    const mainFinalizer = rows.map(value => value.operation === 'singleton-destroy'
      ? { ...value, nativeThreadId: 123 } : value);
    expect(inspect(encode(mainFinalizer), terminal, expected).completeOwnershipBoundariesObserved).toBe(true);
  });

  it('keeps native ownership observer gaps and unwinds explicit without declaring a corruption cause', async () => {
    const { inspectNativeOwnershipCapture: inspect } = await import('./fixtures/native-ort-teardown-control.mjs');
    const operations = ['initializer', 'singleton-create', 'singleton-destroy', 'session-dispose',
      'session-finalize', 'instance-finalize'];
    const symbols = Object.fromEntries(operations.map(key => [key, 'qualified-' + key]));
    const relativeAddresses = Object.fromEntries(operations.map((key, i) => [key, 0x1000 + i * 16]));
    const binding = { path: '/fixture/onnxruntime_binding.node', bytes: 384040, sha256: 'a'.repeat(64) };
    const prefix = 'PC_NATIVE_DEBUGGER\t' + JSON.stringify({ event: 'start', processId: 123 }) + '\n';
    const exit = 'PC_NATIVE_DEBUGGER\t' + JSON.stringify({ event: 'exit', processId: 123,
      exitCode: 0, signal: null, signalDelivered: true }) + '\n';
    const rows = ['enter', 'return'].map((event, i) => ({ event, sequence: i + 1, processId: 123,
      nativeThreadId: 124, callId: 1, operation: 'singleton-create', symbol: symbols['singleton-create'],
      programCounter: '0x1234', relativeAddress: relativeAddresses['singleton-create'], binding }));
    const encode = (values = rows) => prefix + values.map(value => 'PC_NATIVE_OWNERSHIP\t' + JSON.stringify(value) + '\n').join('') + exit;
    const terminal = { eof: true, exitCode: 0, signal: null };
    const expected = { binding, symbols, relativeAddresses };
    const partial = inspect(encode(), terminal, expected);
    expect(partial.completeOwnershipBoundariesObserved).toBe(false);
    expect(partial.missingOperations).toContain('singleton-destroy');
    expect(partial.heapCorruptionRootCauseConfirmed).toBe(false);
    const unwound = inspect(encode([rows[0], { ...rows[1], event: 'unwound' }]), terminal, expected);
    expect(unwound.calls[0]).toMatchObject({ returnedAt: null, unwoundAt: 2 });
    expect(unwound.completeOwnershipBoundariesObserved).toBe(false);
    const duplicate = [...rows, ...rows.map(value => ({ ...value, sequence: value.sequence + 2, callId: 2 }))];
    expect(() => inspect(encode(duplicate), terminal, expected)).toThrow(/singleton lifetime/);
    const destroyBeforeReturn = [rows[0], { ...rows[0], sequence: 2, callId: 2,
      operation: 'singleton-destroy', symbol: symbols['singleton-destroy'],
      relativeAddress: relativeAddresses['singleton-destroy'] }];
    expect(() => inspect(encode(destroyBeforeReturn), terminal, expected)).toThrow(/singleton lifetime/);
  });

  it('retains a native ownership observer abort with the exact open call instead of the debugger exit', async () => {
    const { inspectNativeOwnershipCapture: inspect } = await import('./fixtures/native-ort-teardown-control.mjs');
    const operations = ['initializer', 'singleton-create', 'singleton-destroy', 'session-dispose',
      'session-finalize', 'instance-finalize'];
    const symbols = Object.fromEntries(operations.map(key => [key, 'qualified-' + key]));
    const relativeAddresses = Object.fromEntries(operations.map((key, i) => [key, 0x1000 + i * 16]));
    const binding = { path: '/fixture/onnxruntime_binding.node', bytes: 384040, sha256: 'a'.repeat(64) };
    const host = (row: object) => 'PC_NATIVE_DEBUGGER\t' + JSON.stringify(row) + '\n';
    const native = (operation: string, callId: number, event: string, sequence: number) =>
      'PC_NATIVE_OWNERSHIP\t' + JSON.stringify({ operation, callId, event, sequence,
        processId: 123, nativeThreadId: 124, symbol: symbols[operation],
        relativeAddress: relativeAddresses[operation], programCounter: '0x1234', binding }) + '\n';
    const stdout = host({ event: 'start', processId: 123 })
      + native('initializer', 1, 'enter', 1) + native('singleton-create', 2, 'enter', 2)
      + native('singleton-create', 2, 'return', 3) + native('initializer', 1, 'return', 4)
      + native('session-dispose', 3, 'enter', 5)
      + host({ event: 'signal', processId: 123, signal: 'SIGABRT' })
      + 'PC_NATIVE_BACKTRACE_BEGIN\n#0 abort\nPC_NATIVE_BACKTRACE_END\n'
      + host({ event: 'exit', processId: 123, exitCode: null, signal: 'SIGABRT', signalDelivered: true });
    const terminal = { eof: true, exitCode: 0, signal: null };
    const expected = { binding, symbols, relativeAddresses };
    const partial = inspect(stdout, terminal, expected);
    expect(partial).toMatchObject({ exitCode: null, signal: 'SIGABRT', hostBacktraceCaptured: true,
      completeOwnershipBoundariesObserved: false, heapCorruptionRootCauseConfirmed: false });
    expect(partial.calls.at(-1)).toMatchObject({ operation: 'session-dispose', returnedAt: null, unwoundAt: null });
    expect(partial.missingOperations).toContain('singleton-destroy');
    expect(() => inspect(stdout.replace('PC_NATIVE_BACKTRACE_END\n', ''), terminal, expected)).toThrow();
    expect(() => inspect(stdout.replace('"signalDelivered":true', '"signalDelivered":false'), terminal, expected)).toThrow();
  });

  it.each(['success', 'shape-error'] as const)('captures exact FILE-worker %s and process EOF after explicit release', outcome => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-teardown-')); roots.push(root);
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root,
      JSON.stringify({ ortEntry, device: 'cpu', outcome, release: 'dispose' })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const terminal = JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8'));
    const receipt = JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8'));
    expect(terminal).toMatchObject({ eof: true, exitCode: 0, signal: null, captureStartedBeforeExec: true });
    expect(receipt).toMatchObject({ processId: terminal.processId, outcome, device: 'cpu', disposed: true,
      embeddingModelInferencePerformed: false, graph: { bytes: 130,
        sha256: '71f431c4e9321ec6fbeb158d02ed240459a7dcc98673fa79a4f439ce42efaf10' } });
    expect(receipt.observation.serializedAdmissionContext).toBe(process.env.PAPERCUSP_ADMISSION_CONTEXT ?? null);
    if (outcome === 'success') expect(receipt.output).toEqual([1, 2, 3, 4, 5, 6]);
    else expect(receipt.expectedError).toContain('Got invalid dimensions for input');
  });

  it('retains actual allocator settings and loaded libc separately from admission evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-allocator-environment-')); roots.push(root);
    const env: NodeJS.ProcessEnv = { ...process.env, GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0:glibc.malloc.perturb=165',
      MALLOC_PERTURB_: '165' };
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root,
      JSON.stringify({ ortEntry, device: 'cpu', outcome: 'success', release: 'dispose' })],
    { env, encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const receipt = JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8'));
    expect(receipt.observation).toMatchObject({
      serializedAdmissionContext: env.PAPERCUSP_ADMISSION_CONTEXT ?? null,
      allocator: { GLIBC_TUNABLES: env.GLIBC_TUNABLES, MALLOC_PERTURB_: '165',
        MALLOC_CHECK_: env.MALLOC_CHECK_ ?? null, LD_PRELOAD: env.LD_PRELOAD ?? null },
    });
    if (process.platform === 'linux') {
      expect(receipt.observation.libraries.some((row: { path: string }) => row.path.endsWith('/libc.so.6'))).toBe(true);
      for (const row of receipt.observation.libraries) {
        expect(row.bytes).toBeGreaterThan(0);
        expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    expect(receipt.embeddingModelInferencePerformed).toBe(false);
  });

  it('captures environment finalization separately from explicit session release', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-teardown-')); roots.push(root);
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root,
      JSON.stringify({ ortEntry, device: 'cpu', outcome: 'success', release: 'environment' })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8'))).toMatchObject({ disposed: false, release: 'environment' });
    expect(JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8'))).toMatchObject({ eof: true, exitCode: 0, signal: null });
  });

  it.each(['uncaught', 'exit-code'] as const)('retains a model error with %s as exit1 after FILE-worker cleanup', terminal => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-teardown-')); roots.push(root);
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root, JSON.stringify({
      ortEntry, device: 'cpu', outcome: 'shape-error', release: 'environment', terminal,
    })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status).toBe(1);
    expect(JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8'))).toMatchObject({ eof: true, exitCode: 1, signal: null });
    expect(JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8')).expectedError).toContain('Got invalid dimensions');
    expect(readFileSync(join(root, 'target.stderr.log'), 'utf8')).toContain('Got invalid dimensions');
  });

  it.each(['warning', 'info'] as const)('measures the process-global first %s initializer despite later FILE-worker INFO', parentLogLevel => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-teardown-')); roots.push(root);
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root, JSON.stringify({
      ortEntry, device: 'cpu', outcome: 'success', release: 'dispose', parentLogLevel,
    })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    const stderr = readFileSync(join(root, 'target.stderr.log'), 'utf8');
    expect(stderr.includes('Creating BFCArena for Cpu')).toBe(parentLogLevel === 'info');
    expect(JSON.parse(readFileSync(join(root, 'target.stdout.log'), 'utf8'))).toMatchObject({ disposed: true, output: [1, 2, 3, 4, 5, 6] });
  });

  it('refuses an unsupported device before native session construction', () => {
    const child = spawnSync(process.execPath, [controlFixture, 'target', JSON.stringify({
      ortEntry, device: 'automatic', outcome: 'success', release: 'dispose',
    })], { encoding: 'utf8', timeout: 15000 });
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('invalid native teardown control configuration');
    expect(child.stdout).toBe('');
  });

  it.each([
    { outcome: 'success', release: 'dispose', parentLogLevel: 'warning', terminal: 'settled' },
    { outcome: 'shape-error', release: 'environment', parentLogLevel: 'info', terminal: 'exit-code' },
  ] as const)('binds initializer and teardown boundaries for $outcome/$release', async configuration => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-lifecycle-')); roots.push(root);
    const pin = (path: string) => {
      const bytes = readFileSync(path);
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const config = { ortEntry, device: 'cpu' as const, lifecycleTrace: true, ...configuration };
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root, JSON.stringify(config)],
      { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(configuration.terminal === 'settled' ? 0 : 1);
    const terminal = JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8'));
    const stderr = readFileSync(join(root, 'target.stderr.log'), 'utf8');
    const expected = { source: pin(controlFixture), node: pin(process.execPath), ortEntry: pin(ortEntry),
      configuration: { device: 'cpu' as const, ...configuration },
      serializedAdmissionContext: process.env.PAPERCUSP_ADMISSION_CONTEXT ?? null };
    const { inspectNativeLifecycleCapture: inspect } = await import('./fixtures/native-ort-teardown-control.mjs');
    const result = inspect(stderr, terminal, expected);
    expect(result).toMatchObject({ processId: terminal.processId, pipeEof: true, completeLifecycleObserved: true,
      embeddingModelInferencePerformed: false, heapCorruptionRootCauseConfirmed: false });
    const main = result.threads.find(row => row.threadId === 0)!;
    const worker = result.threads.find(row => row.threadId > 0)!;
    expect(main.completedOperations).toEqual(['binding-load', 'initializer-create', 'initializer-release',
      'worker-create', 'worker-result', 'worker-terminate', 'process-settled']);
    expect(worker.completedOperations).toEqual(['binding-load', 'session-create',
      ...(configuration.outcome === 'success' ? ['session-run'] : []),
      ...(configuration.release === 'dispose' ? ['session-release'] : []), 'worker-ready']);
    expect(worker.failedOperations).toEqual(configuration.outcome === 'shape-error' ? ['session-run'] : []);
    const prefix = 'PC_NATIVE_LIFECYCLE\t';
    const rows = stderr.split('\n').filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
    const encode = (values: typeof rows) => values.map(row => prefix + JSON.stringify(row)).join('\n') + '\n';
    expect(rows.findIndex(row => row.threadId === 0 && row.operation === 'initializer-release' && row.boundary === 'after'))
      .toBeLessThan(rows.findIndex(row => row.threadId > 0));
    for (const changed of [
      rows.map(row => ({ ...row, processId: terminal.processId + 1 })),
      rows.map(row => row.threadId === worker.threadId ? { ...row, threadId: worker.threadId + 1 } : row),
      rows.map((row, index) => index === 1 ? { ...row, sequence: row.sequence + 1 } : row),
      rows.map(row => row.event === 'start' ? { ...row, source: { ...row.source, sha256: 'a'.repeat(64) } } : row),
      rows.map(row => row.event === 'start' ? { ...row, graphSha256: 'a'.repeat(64) } : row),
      rows.filter(row => !(row.threadId === 0 && row.operation === 'initializer-release')),
      rows.filter(row => !(row.threadId > 0 && row.operation === 'worker-ready')),
      rows.filter(row => row.threadId === 0),
    ]) expect(() => inspect(encode(changed), terminal, expected)).toThrow(/native lifecycle/);
    for (const changed of [{ ...terminal, eof: false }, { ...terminal, captureStartedBeforeExec: false },
      { ...terminal, processId: 0 }, { ...terminal, exitCode: 2 }, { ...terminal, exitCode: null, signal: 'SIGSEGV' }]) {
      expect(() => inspect(stderr, changed, expected)).toThrow(/native lifecycle/);
    }
    expect(() => inspect(stderr, terminal, { ...expected, serializedAdmissionContext: 'foreign' })).toThrow();
    expect(() => inspect(stderr, terminal, { ...expected, ortEntry: { ...expected.ortEntry, bytes: 0 } })).toThrow();
    // A reader control uses a prefix of this real trace. It does not assert an
    // actual abort: it only ensures the last open operation stays explicit.
    const abortedPrefix = rows.filter(row => !(row.threadId === 0
      && ((row.operation === 'worker-terminate' && row.boundary === 'after') || row.operation === 'process-settled')));
    const partial = inspect(encode(abortedPrefix), { ...terminal, exitCode: null, signal: 'SIGABRT' }, expected);
    expect(partial.completeLifecycleObserved).toBe(false);
    expect(partial.threads.find(row => row.threadId === 0)?.pendingOperation).toBe('worker-terminate');
    expect(partial.heapCorruptionRootCauseConfirmed).toBe(false);
    expect(() => inspect(encode(abortedPrefix), terminal, expected)).toThrow(/closure/);
  }, 20000);

  it('retains a failed native initializer separately from completed worker termination', async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-ort-lifecycle-failure-')); roots.push(root);
    const entry = join(root, 'failing-ort.cjs');
    writeFileSync(entry, 'module.exports = {env: {}, InferenceSession: {create: async () => {throw new Error("controlled initializer failure")}}};\n');
    const config = { ortEntry: entry, device: 'cpu' as const, outcome: 'success' as const,
      release: 'dispose' as const, lifecycleTrace: true };
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root, JSON.stringify(config)],
      { encoding: 'utf8', timeout: 15000 });
    expect(child.status).toBe(1);
    const pin = (path: string) => {
      const bytes = readFileSync(path);
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const { inspectNativeLifecycleCapture: inspect } = await import('./fixtures/native-ort-teardown-control.mjs');
    const receipt = inspect(readFileSync(join(root, 'target.stderr.log'), 'utf8'),
      JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8')), {
        source: pin(controlFixture), node: pin(process.execPath), ortEntry: pin(entry),
        configuration: { device: 'cpu', outcome: 'success', release: 'dispose', parentLogLevel: null, terminal: 'settled' },
        serializedAdmissionContext: process.env.PAPERCUSP_ADMISSION_CONTEXT ?? null,
      });
    expect(receipt.completeLifecycleObserved).toBe(false);
    expect(receipt.threads.find(row => row.threadId > 0)).toMatchObject({ failedOperations: ['session-create'],
      completedOperations: ['binding-load', 'worker-failed'], pendingOperation: null });
    expect(receipt.threads.find(row => row.threadId === 0)).toMatchObject({ failedOperations: ['worker-result'],
      completedOperations: ['binding-load', 'worker-create', 'worker-terminate'], pendingOperation: null });
  });
});

describe('corruption-specific native allocator detector control', () => {
  const controlFixture = fileURLToPath(new URL('./fixtures/native-ort-teardown-control.mjs', import.meta.url));
  const nativeSource = fileURLToPath(new URL('./fixtures/native-allocator-detector-control.c', import.meta.url));
  const debugAllocator = '/usr/lib/x86_64-linux-gnu/libc_malloc_debug.so.0';
  const pin = (path: string) => {
    const bytes = readFileSync(path);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };

  it.each(['clean', 'tail-overwrite'] as const)('observes actual %s inside the same Node process with debug malloc', async fault => {
    const root = mkdtempSync(join(tmpdir(), 'native-allocator-detector-')); roots.push(root);
    const binding = join(root, 'allocator-control.node');
    // Stable N-API is compiled against the executing installation, not assumed
    // system headers. The canonical test parent owns this bounded compiler and
    // captured Node lifetime; no independent service or GPU is started.
    const headers = resolve(dirname(process.execPath), '../include/node');
    const compilation = spawnSync('cc', ['-O0', '-fPIC', '-shared', '-I', headers, nativeSource, '-o', binding],
      { encoding: 'utf8', timeout: 10000 });
    expect(compilation.status, compilation.stderr).toBe(0);
    const env: NodeJS.ProcessEnv = { ...process.env, GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0:glibc.malloc.perturb=165:glibc.malloc.check=3',
      MALLOC_CHECK_: '3', MALLOC_PERTURB_: '165', LD_PRELOAD: debugAllocator };
    const child = spawnSync(process.execPath, [controlFixture, 'capture', root,
      JSON.stringify({ allocatorControl: { binding, fault } })], { env, encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).toBe(fault === 'clean' ? 0 : 1);
    const terminal = JSON.parse(readFileSync(join(root, 'target-terminal.json'), 'utf8'));
    const stdout = readFileSync(join(root, 'target.stdout.log'), 'utf8');
    const stderr = readFileSync(join(root, 'target.stderr.log'), 'utf8');
    const { inspectAllocatorDetectorCapture } = await import('./fixtures/native-ort-teardown-control.mjs');
    expect(inspectAllocatorDetectorCapture(stdout, stderr, terminal, { fault, binding: pin(binding),
      debugAllocator: pin(debugAllocator), serializedAdmissionContext: env.PAPERCUSP_ADMISSION_CONTEXT ?? null }))
      .toMatchObject({ fault, detectorTriggered: fault === 'tail-overwrite', requestedBytes: 64,
        embeddingModelInferencePerformed: false, heapCorruptionRootCauseConfirmed: false,
        exitCode: fault === 'clean' ? 0 : null, signal: fault === 'clean' ? null : 'SIGABRT' });
    expect(() => inspectAllocatorDetectorCapture(stdout, stderr, { ...terminal, eof: false }, {
      fault, binding: pin(binding), debugAllocator: pin(debugAllocator), serializedAdmissionContext: null,
    })).toThrow('allocator detector');
  }, 20000);

  it('refuses missing, foreign, synthetic-signal, unbound allocator and partial-EOF evidence', async () => {
    const { inspectAllocatorDetectorCapture: inspect } = await import('./fixtures/native-ort-teardown-control.mjs');
    const binding = { path: '/fixture/control.node', bytes: 1, sha256: 'a'.repeat(64) };
    const debug = { path: '/fixture/libc_malloc_debug.so.0', bytes: 2, sha256: 'b'.repeat(64) };
    const row = { event: 'start', processId: 123, fault: 'tail-overwrite', requestedBytes: 64, mutationBytes: 1,
      binding, embeddingModelInferencePerformed: false, observation: { serializedAdmissionContext: 'bound-context',
        allocator: { MALLOC_CHECK_: '3', GLIBC_TUNABLES: 'glibc.malloc.check=3', LD_PRELOAD: debug.path }, libraries: [debug] } };
    const records = (value = row) => 'PC_NATIVE_ALLOCATOR\t' + JSON.stringify(value) + '\n';
    const steps = 'PC_NATIVE_ALLOCATOR_CORE_LIMIT_ZERO\nPC_NATIVE_ALLOCATOR_TAIL_OVERWRITE\nPC_NATIVE_ALLOCATOR_BEFORE_FREE\n';
    const stdout = records() + steps, stderr = 'free(): invalid pointer\n';
    const terminal = { processId: 123, eof: true, captureStartedBeforeExec: true, exitCode: null, signal: 'SIGABRT' };
    const expected = { fault: 'tail-overwrite' as const, binding, debugAllocator: debug, serializedAdmissionContext: 'bound-context' };
    expect(inspect(stdout, stderr, terminal, expected).detectorTriggered).toBe(true);
    for (const [out, err, end, want] of [
      ['', stderr, terminal, expected],
      [stdout, stderr, { ...terminal, processId: 124 }, expected],
      [stdout, stderr, { ...terminal, eof: false }, expected],
      [stdout, stderr, { ...terminal, captureStartedBeforeExec: false }, expected],
      [stdout, stderr, { ...terminal, signal: 'SIGSEGV' }, expected],
      [stdout, 'manually raised SIGABRT\n', terminal, expected],
      [stdout.replace('PC_NATIVE_ALLOCATOR_TAIL_OVERWRITE\n', ''), stderr, terminal, expected],
      [stdout, stderr, terminal, { ...expected, serializedAdmissionContext: 'foreign-context' }],
      [stdout, stderr, terminal, { ...expected, binding: { ...binding, sha256: 'c'.repeat(64) } }],
      [stdout, stderr, terminal, { ...expected, debugAllocator: { ...debug, sha256: 'c'.repeat(64) } }],
    ] as const) expect(() => inspect(out, err, end, want)).toThrow(/allocator/);
  });
});
