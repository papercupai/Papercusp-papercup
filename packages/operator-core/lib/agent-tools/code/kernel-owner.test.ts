import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPrimaryOwnerRpcRelay, type OwnerRpcWorkerLike } from '../../cluster-owner-rpc';

// DB-free process integration belongs to this package's unit test lane.
// Real workers exercise production placement, VM and bidirectional callbacks.
// The primary uses the same relay as the operator's node:cluster host.
const workers: Record<string, OwnerRpcWorkerLike> = {};
const listeners = new Set<(worker: unknown, message: unknown) => void>();
const children: ChildProcess[] = [];
let relay: ReturnType<typeof startPrimaryOwnerRpcRelay>;
let seq = 0;
async function start(): Promise<ChildProcess> {
  const child = fork(fileURLToPath(new URL('./__fixtures__/kernel-owner-worker.mts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  children.push(child);
  const worker: OwnerRpcWorkerLike = { process: { pid: child.pid }, send: (m) => child.send(m as never),
    isDead: () => child.exitCode !== null || child.signalCode !== null, isConnected: () => child.connected };
  workers[String(child.pid)] = worker;
  child.on('message', (m) => { for (const listener of listeners) listener(worker, m); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('kernel owner fixture startup timed out')), 30_000);
    child.on('message', (m: any) => { if (m?.type === 'fixture:ready') { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`kernel fixture exited ${code}`)); });
  });
  return child;
}
function request(child: ChildProcess, args: Record<string, unknown>) {
  const callSeq = ++seq;
  const result = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`kernel call ${callSeq} timed out`)); }, 15_000);
    const receive = (m: any) => {
      if (m?.type === 'fixture:result' && m.seq === callSeq) {
        clearTimeout(timer); child.off('message', receive);
        if (m.error) reject(new Error(m.error)); else resolve(m.result);
      }
    };
    child.on('message', receive); child.send({ type: 'fixture:call', seq: callSeq, ...args });
  });
  return { seq: callSeq, result };
}
const scope = JSON.stringify(['workspace-a', 'owner-a', 'papercusp']);
let a: ChildProcess; let b: ChildProcess;
beforeAll(async () => {
  relay = startPrimaryOwnerRpcRelay({ cluster: { workers, on: (_e, cb) => listeners.add(cb), off: (_e, cb) => listeners.delete(cb) } });
  [a, b] = await Promise.all([start(), start()]);
}, 45_000);
afterAll(async () => {
  relay?.stop();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  }
});

describe('managed kernel across request workers', () => {
  it('retains objects on A while each cell dispatches with the current facade on B', async () => {
    const { id } = await request(a, { op: 'open', scope }).result;
    expect(a.pid).not.toBe(b.pid);
    expect(await request(a, { op: 'run', id, scope, script: 'globalThis.count = 40; return count;' }).result).toMatchObject({ ok: true, result: 40 });
    const read = await request(b, { op: 'run', id, scope, authorized: true,
      script: 'return { count: ++count, read: await tools.fixture.read({ value: count }) };' }).result;
    expect(read).toMatchObject({ ok: true, result: { count: 41, read: { servedBy: b.pid, args: { value: 41 } } } });
    expect(await request(b, { op: 'run', id, scope, authorized: true, maxLogLines: 1,
      script: 'globalThis.saved = await tools.fixture.read({}); log("first"); log("omitted"); return Array.from(saved.bytes);' }).result)
      .toMatchObject({ ok: true, result: [0, 127, 255], logs: ['first'] });
    expect(await request(a, { op: 'run', id, scope, script: 'return Array.from(saved.bytes);' }).result)
      .toMatchObject({ ok: true, result: [0, 127, 255] });
    expect(await request(b, { op: 'run', id, scope, authorized: true,
      script: 'const echoed = await tools.fixture.read({ bytes: saved.bytes }); return Array.from(echoed.args.bytes);' }).result)
      .toMatchObject({ ok: true, result: [0, 127, 255] });
    const denied = await request(b, { op: 'run', id, scope, authorized: false, script: 'return await tools.call("fixture:read", {});' }).result;
    expect(denied.ok).toBe(false); expect(denied.error).toContain('current_caller_denied');
    expect(await request(a, { op: 'run', id, scope, script: 'return count;' }).result).toMatchObject({ ok: true, result: 41 });
    expect(await request(b, { op: 'status', id, scope }).result).toMatchObject({ id, state: 'live' });
    for (const foreign of [JSON.stringify(['foreign', 'owner-a', 'papercusp']), JSON.stringify(['workspace-a', 'foreign', 'papercusp']), JSON.stringify(['workspace-a', 'owner-a', 'foreign'])]) {
      expect(await request(b, { op: 'close', id, scope: foreign }).result).toMatchObject({ state: 'unrecoverable' });
    }
    expect(await request(b, { op: 'close', id, scope }).result).toMatchObject({ state: 'closed' });
    expect(await request(a, { op: 'status', id, scope }).result).toMatchObject({ state: 'closed' });
  });
  it('propagates caller cancellation and timeout without leaving a live VM', async () => {
    const { id } = await request(a, { op: 'open', scope }).result;
    const entered = new Promise<void>((resolve) => {
      const receive = (m: any) => { if (m?.type === 'fixture:dispatch') { b.off('message', receive); resolve(); } };
      b.on('message', receive);
    });
    const running = request(b, { op: 'run', id, scope, authorized: true, script: 'await tools.fixture.read({}); while(true) {}' });
    await entered; await request(b, { op: 'cancel', runSeq: running.seq }).result;
    expect(await running.result).toMatchObject({ ok: false, kernel: { state: 'lost' } });
    expect(await request(b, { op: 'status', id, scope }).result).toMatchObject({ state: 'lost' });
    const other = await request(a, { op: 'open', scope }).result;
    expect(await request(b, { op: 'run', id: other.id, scope, timeoutMs: 100, script: 'while(true) {}' }).result).toMatchObject({ ok: false, kernel: { state: 'lost' } });
  });
  it('refuses overlapping cells and lets a sibling close the active owner cell', async () => {
    const { id } = await request(a, { op: 'open', scope }).result;
    const entered = new Promise<void>((resolve) => {
      const receive = (m: any) => { if (m?.type === 'fixture:dispatch') { b.off('message', receive); resolve(); } };
      b.on('message', receive);
    });
    const active = request(b, { op: 'run', id, scope, authorized: true, script: 'await tools.fixture.read({}); await sleep(2000); return 1;' });
    await entered;
    expect(await request(b, { op: 'run', id, scope, script: 'return 2;' }).result).toMatchObject({ ok: false, error: expect.stringContaining('kernel_busy') });
    expect(await request(b, { op: 'close', id, scope }).result).toMatchObject({ state: 'closed' });
    expect(await active.result).toMatchObject({ ok: false, kernel: { state: 'closed' } });
  });
  it('keeps real orchestration capability checks and write records on the receiving worker', async () => {
    const { id } = await request(a, { op: 'open', scope }).result;
    await request(a, { op: 'run', id, scope, script: 'globalThis.count = 20; return count;' }).result;
    const accepted = await request(b, { op: 'compose', id, scope, authorized: true,
      script: 'return { count: ++count, write: await tools.fixture.write({}) };' }).result;
    expect(accepted).toMatchObject({ ok: true, summary: { count: 21, write: { servedBy: b.pid, principalStayedLocal: true } } });
    expect(accepted.callRecords).toContainEqual(expect.objectContaining({ tool: 'fixture:write', effect: 'write', disposition: 'settled' }));
    const rejected = await request(b, { op: 'compose', id, scope, authorized: false, script: 'return await tools.fixture.write({});' }).result;
    expect(rejected.ok).toBe(false); expect(rejected.error).toContain('capability_denied');
    expect(rejected.callRecords).toContainEqual(expect.objectContaining({ tool: 'fixture:write', disposition: 'rejected' }));
    await request(b, { op: 'close', id, scope }).result;
  });
  it('reports owner death, never launches a replacement, and distinguishes an unknown scope', async () => {
    const { id } = await request(a, { op: 'open', scope }).result;
    a.kill('SIGKILL'); await once(a, 'exit');
    expect(await request(b, { op: 'status', id, scope }).result).toMatchObject({ state: 'unrecoverable' });
    expect(await request(b, { op: 'run', id, scope, script: 'return 1;' }).result).toMatchObject({ ok: false, error: expect.stringContaining('kernel_unrecoverable') });
    expect(await request(b, { op: 'status', id: crypto.randomUUID(), scope }).result).toMatchObject({ state: 'unrecoverable' });
  });
});
