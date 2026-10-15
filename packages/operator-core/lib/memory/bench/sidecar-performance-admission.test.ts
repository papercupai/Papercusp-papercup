import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPerformanceChild } from './sidecar-performance';
import { measurementManifestFixture } from './fixtures/measurement-manifest';
import { fingerprintFile } from './measurement-manifest';
import { Governor, type AdmissionContext } from '../../resource-governor/admission';
import { withGovernedExecution, type runGovernedOperation } from '../../resource-governor/execution';
import { MemoryAdmissionQueueStore } from '../../resource-governor/memory-admission-queue-store';
import { WorkItemAdmissionQueueDriver } from '../../resource-governor/queue';

const dirs: string[] = [];
const originalExecArgv = [...process.execArgv];
afterEach(() => {
  process.execArgv = [...originalExecArgv];
  vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-admission-')); dirs.push(dir);
  const manifest = measurementManifestFixture(dir), cell = manifest.cells[0], arm = manifest.arms[0];
  const evaluator = path.join(dir, 'embedder-eval-cli.ts');
  fs.writeFileSync(evaluator, '// synthetic admitted evaluator\n');
  manifest.inputs.evaluator = await fingerprintFile(evaluator);
  cell.inputIds = ['evaluator'];
  const input = { manifest, cell, arm, manifestSha256: 'a'.repeat(64), manifestFile: path.join(dir, 'manifest.json'),
    mdenseonModel: dir, rawOutput: path.join(dir, 'out.json'), logFd: 1 };
  const child = new EventEmitter() as ChildProcess;
  const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
  const context: AdmissionContext = { contractVersion: 1, requestId: 'child-request', rootRequestId: 'root-request',
    parentRequestId: 'parent-request', receiptId: 'RG-child', parentReceiptId: 'RG-parent', idempotencyKey: 'child',
    admissionClass: 'embedding', priority: 0, demand: {}, depth: 1, createdAtMs: 1, decisionGeneration: 1 };
  const writeReceipt = () => fs.writeFileSync(input.rawOutput, JSON.stringify({ ownerId: manifest.ownerId,
    manifestSha256: input.manifestSha256, cellId: cell.id, armId: arm.id, report: { resource: { peakRssMiB: 3.5 } } }));
  const store = new MemoryAdmissionQueueStore();
  const driver = new WorkItemAdmissionQueueDriver(store, { namespace: 'embedding-performance' });
  const governor = new Governor(driver);
  const governedOperation: typeof runGovernedOperation = (options, run) => withGovernedExecution({
    idempotencyKey: options.idempotencyKey!, admissionClass: options.admissionClass, parent: options.parent,
    demand: options.demand, payloadRef: options.payloadRef, metadata: options.metadata,
  }, { owner: options.owner, measureActualDemand: options.measureActualDemand }, { governor, driver }, run);
  const current = async () => (await store.find('embedding-performance', `embedding-performance:${input.manifestSha256}:${cell.id}`))?.record;
  return { input, child, spawnProcess, context, writeReceipt, store, governedOperation, current };
}
describe('fresh performance child admission', () => {
  it('admits before spawn, propagates lineage and holds the operation until child exit with actual RSS', async () => {
    const f = await fixture(); vi.stubEnv('PAPERCUSP_ADMISSION_CONTEXT', JSON.stringify(f.context));
    f.input.cell.parameters.transportTrace = true;
    let admit!: () => void;
    const gate = new Promise<void>((resolve) => { admit = resolve; });
    let requested = false;
    const governedOperation: typeof runGovernedOperation = async (input, run) => {
      expect(input.parent).toEqual(f.context);
      expect(input.dedicatedClient).toBe(true);
      expect(input.demand?.memoryBytes).toBeGreaterThan(0);
      requested = true;
      await gate;
      return f.governedOperation(input, run);
    };
    const done = runPerformanceChild(f.input, { governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' });
    await vi.waitFor(() => expect(requested).toBe(true));
    expect(f.spawnProcess).not.toHaveBeenCalled();
    admit();
    await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledOnce());
    expect((await f.current())?.state).toBe('running');
    expect(vi.mocked(f.spawnProcess).mock.calls[0][1]).toContain('--transport-trace');
    const env = (vi.mocked(f.spawnProcess).mock.calls[0][2] as SpawnOptions).env!;
    expect(env.PAPERCUSP_FORBID_REAL_PG).toBe('1');
    expect(JSON.parse(env.PAPERCUSP_ADMISSION_CONTEXT!)).toMatchObject({ rootRequestId: f.context.rootRequestId,
      parentRequestId: f.context.requestId, receiptId: expect.any(String), leaseId: expect.any(String) });
    f.writeReceipt(); f.child.emit('exit', 0);
    await expect(done).resolves.toBe(0);
    expect(await f.current()).toMatchObject({ state: 'completed',
      actualDemand: { cpuWeight: f.input.arm.execution.intraOpThreads, memoryBytes: 3.5 * 1024 * 1024 } });
  });
  it('never starts a model child when durable admission refuses', async () => {
    const f = await fixture();
    f.store.fail = true;
    await expect(runPerformanceChild(f.input, { governedOperation: f.governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' }))
      .rejects.toThrow();
    expect(f.spawnProcess).not.toHaveBeenCalled();
    expect(await f.current()).toBeUndefined();
  });
  it('pins a TypeScript file launch instead of inheriting parent eval flags', async () => {
    const f = await fixture();
    process.execArgv = ['--input-type=module', '--eval', 'throw new Error("parent eval executed")'];
    const done = runPerformanceChild(f.input, { governedOperation: f.governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' });
    await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledOnce());
    const args = vi.mocked(f.spawnProcess).mock.calls[0][1]!;
    expect(args.slice(0, 2)).toEqual(['--import', 'tsx']);
    expect(args[2]).toMatch(/embedder-eval-cli\.ts$/);
    expect(args[2]).toBe(f.input.manifest.inputs.evaluator.path);
    expect(args).not.toContain('--input-type=module');
    expect(args).not.toContain('--eval');
    expect(args).not.toContain('throw new Error("parent eval executed")');
    f.writeReceipt(); f.child.emit('exit', 0);
    await expect(done).resolves.toBe(0);
  });
  it.each(['spawn', 'exit'] as const)('keeps %s failure inside the governed cancellation boundary', async (failure) => {
    const f = await fixture();
    const done = runPerformanceChild(f.input, { governedOperation: f.governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' });
    const rejected = expect(done).rejects.toThrow(failure === 'spawn' ? 'spawn failed' : 'exit 7');
    await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledOnce());
    if (failure === 'spawn') f.child.emit('error', new Error('spawn failed'));
    else f.child.emit('exit', 7);
    await rejected;
    expect((await f.current())?.state).toBe('cancelled');
  });
  it('cancels a successful child whose resource receipt belongs to another cell', async () => {
    const f = await fixture();
    const done = runPerformanceChild(f.input, { governedOperation: f.governedOperation, spawnProcess: f.spawnProcess, workspaceId: 'test' });
    const rejected = expect(done).rejects.toThrow('resource receipt');
    await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledOnce());
    f.writeReceipt();
    const receipt = JSON.parse(fs.readFileSync(f.input.rawOutput, 'utf8')); receipt.cellId = 'another-cell';
    fs.writeFileSync(f.input.rawOutput, JSON.stringify(receipt)); f.child.emit('exit', 0);
    await rejected;
    expect((await f.current())?.state).toBe('cancelled');
  });
  it('executes a frozen entry and worker in fresh children despite live source drift, then refuses frozen worker tampering', async () => {
    const initial = await fixture(), root = path.dirname(initial.input.rawOutput);
    const live = path.join(root, 'live-worker.mjs'), worker = path.join(root, 'worker.mjs');
    fs.writeFileSync(live, 'export const revision = "original";\n');
    fs.copyFileSync(live, worker);
    const evaluator = path.join(root, 'frozen-evaluator.mjs'), loader = path.join(root, 'loader.mjs');
    fs.writeFileSync(loader, 'export {};\n');
    fs.writeFileSync(evaluator, `
      import fs from 'node:fs';
      import { revision } from './worker.mjs';
      const value = flag => process.argv[process.argv.indexOf(flag) + 1];
      const binding = JSON.parse(fs.readFileSync(value('--manifest'), 'utf8'));
      fs.writeFileSync(value('--out'), JSON.stringify({ ...binding, pid: process.pid, revision,
        report: { resource: { peakRssMiB: process.memoryUsage().rss / 1024 / 1024 } } }));
    `);
    const pins = { evaluator: await fingerprintFile(evaluator), runtimeLoader: await fingerprintFile(loader),
      workerHost: await fingerprintFile(worker) };
    const pids: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const f = attempt === 0 ? initial : await fixture();
      Object.assign(f.input.manifest.inputs, pins);
      f.input.cell.inputIds = Object.keys(pins);
      f.input.cell.parameters.runtimeLoader = 'runtimeLoader';
      fs.writeFileSync(f.input.manifestFile, JSON.stringify({ ownerId: f.input.manifest.ownerId,
        manifestSha256: f.input.manifestSha256, cellId: f.input.cell.id, armId: f.input.arm.id }));
      await expect(runPerformanceChild(f.input, { governedOperation: f.governedOperation,
        spawnProcess: spawn, workspaceId: 'test' })).resolves.toBe(0);
      const receipt = JSON.parse(fs.readFileSync(f.input.rawOutput, 'utf8'));
      expect(receipt.revision).toBe('original'); pids.push(receipt.pid);
      fs.writeFileSync(live, 'export const revision = "changed live source";\n');
    }
    expect(new Set(pids).size).toBe(2);
    fs.writeFileSync(worker, 'export const revision = "tampered frozen worker";\n');
    const f = await fixture(); Object.assign(f.input.manifest.inputs, pins);
    f.input.cell.inputIds = Object.keys(pins); f.input.cell.parameters.runtimeLoader = 'runtimeLoader';
    await expect(runPerformanceChild(f.input, { governedOperation: f.governedOperation,
      spawnProcess: f.spawnProcess, workspaceId: 'test' })).rejects.toThrow('fingerprint mismatch: workerHost');
    expect(f.spawnProcess).not.toHaveBeenCalled();
    expect((await f.current())?.state).toBe('cancelled');
  });
  it('verifies pins after queued admission and before spawning', async () => {
    const f = await fixture();
    const governedOperation: typeof runGovernedOperation = (options, run) => f.governedOperation(options, async context => {
      fs.appendFileSync(f.input.manifest.inputs.evaluator.path, '// changed while queued\n');
      return run(context);
    });
    await expect(runPerformanceChild(f.input, { governedOperation, spawnProcess: f.spawnProcess,
      workspaceId: 'test' })).rejects.toThrow('fingerprint mismatch: evaluator');
    expect(f.spawnProcess).not.toHaveBeenCalled();
  });
  it.each(['runtimeLoader', 'runtimeTsconfig'] as const)('uses a declared %s and rejects unbound runtime paths', async parameter => {
    const f = await fixture(), file = path.join(path.dirname(f.input.rawOutput), parameter);
    fs.writeFileSync(file, '{}'); f.input.manifest.inputs[parameter] = await fingerprintFile(file);
    f.input.cell.parameters[parameter] = parameter; f.input.cell.inputIds.push(parameter);
    const done = runPerformanceChild(f.input, { governedOperation: f.governedOperation,
      spawnProcess: f.spawnProcess, workspaceId: 'test' });
    await vi.waitFor(() => expect(f.spawnProcess).toHaveBeenCalledOnce());
    const call = vi.mocked(f.spawnProcess).mock.calls[0];
    if (parameter === 'runtimeLoader') expect(call[1]![1]).toBe(pathToFileURL(file).href);
    else expect((call[2] as SpawnOptions).env!.TSX_TSCONFIG_PATH).toBe(file);
    f.writeReceipt(); f.child.emit('exit', 0); await expect(done).resolves.toBe(0);
    f.input.cell.inputIds = ['evaluator'];
    await expect(runPerformanceChild(f.input, { governedOperation: f.governedOperation,
      spawnProcess: f.spawnProcess, workspaceId: 'test' })).rejects.toThrow(`undeclared performance ${parameter}`);
  });
});
