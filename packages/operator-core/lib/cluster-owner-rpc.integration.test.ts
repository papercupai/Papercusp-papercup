/**
 * WI-10003626 — cluster-owner-rpc across REAL processes.
 *
 * Two worker processes run the production worker side on their real IPC
 * channels; this test process plays the cluster primary with the production
 * `startPrimaryOwnerRpcRelay`, fed by a cluster-shaped view of the two children.
 * Worker A holds a process-local object (a live `cat` child's stdin pipe). The
 * proof is that worker B — a different pid, with no access to that pipe — drives
 * it through the relay, and that a DEAD owner is reported as `owner_gone` by the
 * primary rather than inferred from a timeout.
 *
 * Removing the relay, the worker listener, or the pid routing makes the first
 * test fail: B's call can then only time out.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  callOwnerProcess,
  bindOwnerRpcResource,
  locateOwnerRpcResource,
  registerOwnerRpcHandler,
  startPrimaryOwnerRpcRelay,
  startWorkerOwnerRpc,
  type OwnerRpcClusterLike,
  type OwnerRpcHandle,
  type OwnerRpcOutcome,
  type OwnerRpcWorkerLike,
} from './cluster-owner-rpc';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'owner-rpc-worker.mts');

interface FixtureWorker {
  child: ChildProcess;
  pid: number;
  worker: OwnerRpcWorkerLike;
}

const listeners = new Set<(worker: unknown, message: unknown) => void>();
const workers: Record<string, OwnerRpcWorkerLike> = {};
const cluster: OwnerRpcClusterLike = {
  on: (_event, cb) => listeners.add(cb),
  off: (_event, cb) => listeners.delete(cb),
  workers,
};

let relay: OwnerRpcHandle;
let a: FixtureWorker;
let b: FixtureWorker;
let callSeq = 0;

async function startWorker(id: string): Promise<FixtureWorker> {
  const child = fork(FIXTURE, [], {
    cwd: REPO_ROOT,
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const worker: OwnerRpcWorkerLike = {
    process: { pid: child.pid },
    send: (message) => child.send(message as never),
    isDead: () => child.exitCode !== null || child.signalCode !== null,
    isConnected: () => child.connected,
  };
  child.on('message', (message) => {
    for (const cb of listeners) cb(worker, message);
  });
  const ready = await new Promise<{ pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture ${id} did not become ready`)), 60_000);
    child.on('message', (m: any) => {
      if (m?.type === 'fixture:ready') {
        clearTimeout(timer);
        resolve(m);
      }
    });
    child.once('exit', (code) => reject(new Error(`fixture ${id} exited early (${code})`)));
  });
  workers[id] = worker;
  return { child, pid: ready.pid, worker };
}

/** Ask worker `from` to call the owner-rpc on its own, through the relay. */
function callFrom(
  from: FixtureWorker,
  targetPid: number,
  payload: unknown,
  opts: { kind?: string; timeoutMs?: number; onProgress?: (progress: unknown) => void } = {},
): Promise<OwnerRpcOutcome> {
  const seq = ++callSeq;
  return new Promise((resolve) => {
    const onMessage = (m: any) => {
      if (m?.type === 'fixture:progress' && m.seq === seq) {
        opts.onProgress?.(m.progress);
        return;
      }
      if (m?.type === 'fixture:result' && m.seq === seq) {
        from.child.off('message', onMessage);
        resolve(m.out);
      }
    };
    from.child.on('message', onMessage);
    from.child.send({
      type: 'fixture:call',
      seq,
      targetPid,
      kind: opts.kind ?? 'fixture-echo',
      payload,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
  });
}

beforeAll(async () => {
  relay = startPrimaryOwnerRpcRelay({ cluster });
  [a, b] = await Promise.all([startWorker('1'), startWorker('2')]);
}, 90_000);

afterAll(async () => {
  relay?.stop();
  for (const w of [a, b]) {
    if (w && w.child.exitCode === null && w.child.signalCode === null) {
      w.child.kill('SIGTERM');
      await once(w.child, 'exit').catch(() => undefined);
    }
  }
});

describe('cluster owner rpc across real worker processes', () => {
  it('explains that a missing local mapping has several possible causes', async () => {
    const out = await locateOwnerRpcResource('fixture-kernel', `unknown-${Date.now()}`, 'workspace-a:owner-a:papercusp');
    expect(out).toMatchObject({
      ok: false,
      code: 'owner_gone',
      message: expect.stringContaining('unknown, foreign, expired, or lost on process restart'),
    });
  });

  it('lets worker B drive an object that only worker A holds', async () => {
    expect(a.pid).not.toBe(b.pid);
    const opened = await callFrom(a, a.pid, { op: 'open' });
    expect(opened.ok).toBe(true);
    const { id, ownerPid } = (opened as { ok: true; result: { id: string; ownerPid: number } }).result;
    expect(ownerPid).toBe(a.pid);

    for (const line of ['first-line\n', 'second-line\n']) {
      const out = await callFrom(b, a.pid, { op: 'write', id, data: line });
      expect(out).toMatchObject({ ok: true, result: { found: true, servedBy: a.pid } });
      expect((out as any).result.output).toContain(line);
    }

    // Control: B's OWN registry has no such object — the relay is what made it work.
    const local = await callFrom(b, b.pid, { op: 'write', id, data: 'x' });
    expect(local).toMatchObject({ ok: true, result: { found: false, servedBy: b.pid } });
  });

  it('distinguishes no handler, a throwing handler, and a slow owner', async () => {
    expect(await callFrom(b, a.pid, {}, { kind: 'no-such-kind' })).toMatchObject({ ok: false, code: 'no_handler' });
    expect(await callFrom(b, a.pid, { op: 'throw' })).toMatchObject({
      ok: false,
      code: 'handler_error',
      message: 'fixture handler failure',
    });
    expect(await callFrom(b, a.pid, { op: 'slow', delayMs: 1_500 }, { timeoutMs: 200 })).toMatchObject({
      ok: false,
      code: 'timeout',
    });
  });

  it('reaches primary-owned runtime state from a real request worker', async () => {
    let active = true;
    const received: unknown[] = [];
    registerOwnerRpcHandler('fixture-primary-control', (payload, source) => {
      expect(payload).toEqual({ op: 'stop' });
      expect(source.fromPid).toBe(b.pid);
      source.progress?.({ status: 'draining' });
      active = false;
      return { status: 'completed', servedBy: process.pid };
    });
    const out = await callFrom(b, process.pid, { op: 'stop' }, {
      kind: 'fixture-primary-control', onProgress: progress => received.push(progress),
    });
    expect(out).toEqual({ ok: true, result: { status: 'completed', servedBy: process.pid } });
    expect(active).toBe(false);
    expect(received).toEqual([{ status: 'draining' }]);
  });

  it('preserves typed primary handler failures and timeout semantics', async () => {
    expect(await callFrom(b, process.pid, {}, { kind: 'fixture-primary-missing' }))
      .toMatchObject({ ok: false, code: 'no_handler' });
    registerOwnerRpcHandler('fixture-primary-error', () => { throw new Error('primary handler failed'); });
    expect(await callFrom(b, process.pid, {}, { kind: 'fixture-primary-error' }))
      .toMatchObject({ ok: false, code: 'handler_error', message: 'primary handler failed' });
    registerOwnerRpcHandler('fixture-primary-slow', () => new Promise(() => {}));
    expect(await callFrom(b, process.pid, {}, { kind: 'fixture-primary-slow', timeoutMs: 200 }))
      .toMatchObject({ ok: false, code: 'timeout' });
  });

  it('rejects a forged IPC sender before invoking a primary handler', async () => {
    const invoke = vi.fn();
    registerOwnerRpcHandler('fixture-primary-forged', invoke);
    for (const listener of listeners) listener(a.worker, {
      type: 'papercusp:owner-rpc-request', id: 'forged-primary-request',
      fromPid: b.pid, targetPid: process.pid, kind: 'fixture-primary-forged', payload: {},
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('relays progress notifications from the owner before returning the terminal result', async () => {
    const progress = [{ method: 'notifications/progress', params: { progressToken: 'call-1', progress: 1 } }];
    const received: unknown[] = [];
    const out = await callFrom(b, a.pid, { op: 'progress', progress }, { timeoutMs: 5_000, onProgress: item => received.push(item) });
    expect(out).toMatchObject({ ok: true, result: { servedBy: a.pid } });
    expect((out as { ok: true; result: { progress: unknown[] } }).result.progress).toEqual(progress);
    expect(received).toEqual(progress);
  });

  it('keeps a declared resource lifetime across real worker IPC without widening the default', async () => {
    const clock = vi.spyOn(Date, 'now');
    const now = Date.now();
    clock.mockReturnValue(now);
    const kind = 'fixture-link';
    const scope = 'install-a';
    const rpcKind = { kind: 'owner-rpc-resource' };
    try {
      for (const [id, ttlMs] of [['long-link', 20 * 60_000], ['default-link', undefined]] as const) {
        expect(await callFrom(a, 0, { op: 'bind', kind, id, scope, ttlMs }, rpcKind)).toMatchObject({ ok: true });
      }
      clock.mockReturnValue(now + 11 * 60_000);
      expect(await callFrom(b, 0, { op: 'locate', kind, id: 'long-link', scope }, rpcKind)).toMatchObject({ ok: true, result: { ownerPid: a.pid } });
      expect(await callFrom(b, 0, { op: 'locate', kind, id: 'default-link', scope }, rpcKind)).toMatchObject({ ok: false, code: 'owner_gone' });
      expect(await callFrom(b, 0, { op: 'locate', kind, id: 'long-link', scope: 'other-install' }, rpcKind)).toMatchObject({ ok: false, code: 'owner_gone' });
      clock.mockReturnValue(now + 32 * 60_000);
      expect(await callFrom(b, 0, { op: 'locate', kind, id: 'long-link', scope }, rpcKind)).toMatchObject({ ok: false, code: 'owner_gone' });
      expect(await callFrom(a, 0, { op: 'bind', kind, id: 'invalid', scope, ttlMs: -1 }, rpcKind)).toMatchObject({ ok: false, code: 'handler_error' });
    } finally { clock.mockRestore(); }
  });

  it('uses the same bounded resource lifetime in a single-process host', async () => {
    const clock = vi.spyOn(Date, 'now');
    const now = Date.now();
    clock.mockReturnValue(now);
    try {
      await bindOwnerRpcResource('fixture-link', 'local-long-link', 'install-a', 20 * 60_000);
      clock.mockReturnValue(now + 11 * 60_000);
      expect(await locateOwnerRpcResource('fixture-link', 'local-long-link', 'install-a')).toMatchObject({ ok: true, result: { ownerPid: process.pid } });
      clock.mockReturnValue(now + 32 * 60_000);
      expect(await locateOwnerRpcResource('fixture-link', 'local-long-link', 'install-a')).toMatchObject({ ok: false, code: 'owner_gone' });
      await expect(bindOwnerRpcResource('fixture-link', 'invalid', 'install-a', Infinity)).rejects.toThrow('owner_resource_ttl_invalid');
    } finally { clock.mockRestore(); }
  });

  it('sends the requested resource lifetime from the current worker helper', async () => {
    // Test the current helper's IPC encoding even when the governed fork loader
    // pins real child processes to their committed module versions.
    let receive: (message: unknown) => void = () => {};
    const sent: unknown[] = [];
    const worker = startWorkerOwnerRpc({
      on: (_event, cb) => { receive = cb; }, off: () => {},
      send: (message) => {
        sent.push(message);
        receive({ type: 'papercusp:owner-rpc-response', id: message.id, toPid: process.pid, ok: true, result: { ownerPid: process.pid } });
      },
    });
    try {
      await bindOwnerRpcResource('fixture-link', 'worker-long-link', 'install-a', 20 * 60_000);
      expect(sent).toMatchObject([{ kind: 'owner-rpc-resource', targetPid: 0,
        payload: { op: 'bind', kind: 'fixture-link', id: 'worker-long-link', scope: 'install-a', ttlMs: 20 * 60_000 } }]);
    } finally { worker.stop(); }
  });

  it('distinguishes an absent owner mapping from a recorded owner with no live worker', async () => {
    const id = `kernel-${Date.now()}`;
    const scope = 'workspace-a:owner-a:papercusp';
    const kind = 'fixture-kernel';
    const bound = await callFrom(a, a.pid, { op: 'resource-bind', kind, id, scope });
    expect(bound).toMatchObject({ ok: true, result: { bound: true, ownerPid: a.pid } });

    const absent = await callFrom(b, b.pid, { op: 'resource-locate', kind, id: `${id}-unknown`, scope });
    expect(absent).toMatchObject({ ok: true, result: {
      ok: false, code: 'owner_gone', message: expect.stringContaining('unknown, foreign, expired, or lost on primary restart'),
    } });

    const ownerPid = a.pid;
    const ownerEntry = Object.entries(workers).find(([, worker]) => worker.process.pid === ownerPid);
    expect(ownerEntry).toBeDefined();
    const [ownerKey, ownerWorker] = ownerEntry!;
    delete workers[ownerKey];
    try {
      const gone = await callFrom(b, b.pid, { op: 'resource-locate', kind, id, scope });
      expect(gone).toMatchObject({ ok: true, result: {
        ok: false, code: 'owner_gone', message: expect.stringContaining(`owner worker pid ${ownerPid} is no longer live`),
      } });
    } finally {
      workers[ownerKey] = ownerWorker;
    }
  });

  it('reports a pid that is not a live worker as owner_gone, authoritatively', async () => {
    expect(await callFrom(b, 2_000_000_000, { op: 'write', id: 'x', data: 'x' })).toMatchObject({
      ok: false,
      code: 'owner_gone',
    });

    const deadPid = a.pid;
    a.child.kill('SIGKILL');
    await once(a.child, 'exit');
    const out = await callFrom(b, deadPid, { op: 'write', id: 'x', data: 'x' }, { timeoutMs: 10_000 });
    expect(out).toMatchObject({ ok: false, code: 'owner_gone' });
  });

  it('reports not_clustered in a process that has no relay binding', async () => {
    // This test process never called startWorkerOwnerRpc().
    expect(await callOwnerProcess({ targetPid: b.pid, kind: 'fixture-echo', payload: {} })).toMatchObject({
      ok: false,
      code: 'not_clustered',
    });
  });
});

describe('cluster owner rpc under a genuine node:cluster primary (the hono-host wiring)', () => {
  // The block above feeds the relay a hand-built cluster view. This one removes the
  // stand-in: the fixture is a real cluster primary using `cluster.on('message')`
  // and `cluster.workers` exactly as hono-host does, with two real cluster workers.
  it('routes a sibling worker to the owner and reports a killed owner as owner_gone', async () => {
    const primary = fork(path.join(__dirname, '__fixtures__', 'owner-rpc-cluster-primary.mts'), [], {
      cwd: REPO_ROOT,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    try {
      const report = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cluster scenario did not report')), 80_000);
        primary.on('message', (m: any) => {
          if (m?.type === 'cluster-scenario:done' || m?.type === 'cluster-scenario:error') {
            clearTimeout(timer);
            resolve(m);
          }
        });
        primary.once('exit', (code) => reject(new Error(`cluster primary exited early (${code})`)));
      });
      expect(report.type, report.message).toBe('cluster-scenario:done');
      const { a, b, primary: primaryPid } = report.pids;
      expect(new Set([a, b, primaryPid]).size).toBe(3);
      expect(report.opened).toMatchObject({ ok: true, result: { ownerPid: a } });
      for (const [i, line] of ['first-line\n', 'second-line\n'].entries()) {
        expect(report.writes[i]).toMatchObject({ ok: true, result: { found: true, servedBy: a } });
        expect(report.writes[i].result.output).toContain(line);
      }
      expect(report.localControl).toMatchObject({ ok: true, result: { found: false, servedBy: b } });
      expect(report.afterOwnerDeath).toMatchObject({ ok: false, code: 'owner_gone' });
    } finally {
      if (primary.exitCode === null && primary.signalCode === null) {
        primary.kill('SIGTERM');
        await once(primary, 'exit').catch(() => undefined);
      }
    }
  }, 90_000);
});
