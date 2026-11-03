// @vitest-environment node
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

import { closeInspector, createCdpClient, readPinnedState, readPinnedHeapObjectIds, capturePinnedHeapSnapshot, withBorrowedHeapSamples, readProcessMemory, redactDiagnosticUrl, withFunctionCallTrace, readSeedRestoreDiagnostics, captureSeedRestorePhases, SEED_RESTORE_DIAGNOSTIC_SLOT } from '../../../scripts/cdp-inspector.mjs';
import { restoreSeed, SeedProviderRegistry, type SeedManifest } from '../../../libs/generic/seed-bundle/src/index';
import { types } from 'node:util';

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];

  readyState = 1;
  closed = false;
  sent: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  readonly url: string;
  readonly options: unknown;
  readonly responses: Map<string, unknown>;

  constructor(url: string, options: unknown, responses: Map<string, unknown>) {
    super();
    this.url = url;
    this.options = options;
    this.responses = responses;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    const response = this.responses.get(message.method);
    if (response === 'close') {
      queueMicrotask(() => this.close());
      return;
    }
    queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
      id: message.id,
      result: response ?? {},
    }))));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
}

function makeClient(responses: Map<string, unknown>, options: Record<string, unknown> = {}) {
  class TestWebSocket extends FakeWebSocket {
    constructor(url: string, socketOptions: unknown) {
      super(url, socketOptions, responses);
    }
  }
  return createCdpClient('ws://127.0.0.1:9229/devtools/page/test', {
    WebSocketImpl: TestWebSocket,
    requestTimeoutMs: 20,
    ...options,
  });
}

describe('seed restore phase observer', () => {
  const identity = { expectedPid: 7, expectedEntry: '/installed/serve.mjs',
    expectedBuildSha: 'a'.repeat(40), expectedSourceSha256: 'b'.repeat(64) };
  function fixture() {
    const operation = { id: 'operation-1', pid: 7, identity: { buildSha: identity.expectedBuildSha,
      sourceSha256: identity.expectedSourceSha256, script: identity.expectedEntry, processInstanceId: 'instance-1' },
      status: 'running', startedAt: 1, finishedAt: null, outcomeOk: null, droppedEvents: 0,
      events: [{ kind: 'corestore', phase: 'verify', state: 'started', seq: 0, at: 1 }] };
    const state = { version: 1, operations: [operation] };
    const context: Record<PropertyKey, unknown> = { Symbol, process: { pid: 7, argv: ['node', identity.expectedEntry] },
      [Symbol.for(SEED_RESTORE_DIAGNOSTIC_SLOT)]: state };
    const client = { evaluate: vi.fn(async (expression: string) => ({ result: { value: runInNewContext(expression, context) } })),
      send: vi.fn(async (_method: string) => ({})), close: vi.fn() };
    return { client, state, operation, context };
  }

  it.each(['verify', 'restore'] as const)('reads the actual source journal while provider.%s is awaiting', async phase => {
    const key = Symbol.for(SEED_RESTORE_DIAGNOSTIC_SLOT);
    const root = globalThis as unknown as Record<symbol, unknown>;
    const previous = root[key];
    delete root[key];
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const registry = new SeedProviderRegistry().register({ kind: 'corestore',
      cut: async () => { throw new Error('cut is outside this fixture'); },
      verify: async () => { if (phase === 'verify') { entered(); await held; } return { ok: true }; },
      restore: async () => { if (phase === 'restore') { entered(); await held; } },
    });
    const manifest: SeedManifest = { seedFormatVersion: 1, potId: 'observer-fixture', cutAtEpoch: 0, cutHlc: 'fixture', cutTs: 1,
      stores: [{ kind: 'corestore', hash: 'hash', sizeBytes: 0, source: { type: 'resource', path: 'fixture' } }] };
    const ongoing = restoreSeed(manifest, registry, async () => new Uint8Array(), {
      diagnosticIdentity: { buildSha: identity.expectedBuildSha, sourceSha256: identity.expectedSourceSha256, script: process.argv[1] },
    });
    const client = { evaluate: async (expression: string) => ({ result: { value: runInNewContext(expression,
      { Symbol, process, [key]: root[key] } as any) } }), send: vi.fn(async () => ({})), close: vi.fn() };
    const expected = { ...identity, expectedPid: process.pid, expectedEntry: process.argv[1] };
    try {
      await started;
      const snapshot = await readSeedRestoreDiagnostics(client, expected);
      expect(snapshot.operations).toHaveLength(1);
      expect(snapshot.operations[0].status).toBe('running');
      expect(snapshot.operations[0].events.at(-1)).toMatchObject({ phase, state: 'started' });
      expect(snapshot.operations[0].events).not.toContainEqual(expect.objectContaining({ phase, state: 'succeeded' }));
      release();
      await ongoing;
      const result = await captureSeedRestorePhases(client, { ...expected, expectedOperationId: snapshot.operations[0].id });
      expect(result.operation.status).toBe('succeeded');
      expect(result.operation.events.at(-1)).toMatchObject({ phase: 'restore', state: 'succeeded' });
    } finally {
      release();
      await ongoing;
      if (previous === undefined) delete root[key]; else root[key] = previous;
    }
  });

  it('reports an old script without a journal as unsupported, never completed', async () => {
    const { client, context } = fixture();
    delete context[Symbol.for(SEED_RESTORE_DIAGNOSTIC_SLOT)];
    expect(await readSeedRestoreDiagnostics(client, identity)).toMatchObject({ available: false,
      reason: 'seed restore phase journal unavailable' });
  });

  it.each([false, true])('rejects an unsupported capture without polling and cleans up startup=%s', async resumeStartup => {
    const { client, context } = fixture();
    delete context[Symbol.for(SEED_RESTORE_DIAGNOSTIC_SLOT)];
    const sleepImpl = vi.fn(async () => { throw new Error('unsupported journal must not poll'); });
    await expect(captureSeedRestorePhases(client, { ...identity, resumeStartup, sleepImpl }))
      .rejects.toMatchObject({ code: 'SEED_RESTORE_DIAGNOSTICS_UNAVAILABLE',
        message: 'seed restore phase journal unavailable' });
    expect(client.evaluate).toHaveBeenCalledOnce();
    expect(sleepImpl).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    if (resumeStartup) expect(client.send).toHaveBeenCalledExactlyOnceWith('Runtime.runIfWaitingForDebugger');
    else expect(client.send).not.toHaveBeenCalled();
  });

  it('rejects a journal that disappears during a capture without another polling interval', async () => {
    const { client, context } = fixture();
    const sleepImpl = vi.fn(async () => { delete context[Symbol.for(SEED_RESTORE_DIAGNOSTIC_SLOT)]; });
    await expect(captureSeedRestorePhases(client, { ...identity, sleepImpl }))
      .rejects.toMatchObject({ code: 'SEED_RESTORE_DIAGNOSTICS_UNAVAILABLE' });
    expect(client.evaluate).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it.each(['expectedBuildSha', 'expectedSourceSha256'] as const)('requires %s before reading or capturing', async field => {
    const { client } = fixture();
    const unpinned = { ...identity, [field]: undefined };
    await expect(readSeedRestoreDiagnostics(client, unpinned as any)).rejects.toThrow(field);
    await expect(captureSeedRestorePhases(client, { ...unpinned,
      sleepImpl: async () => { throw new Error('unpinned capture must not poll'); } } as any)).rejects.toThrow(field);
    expect(client.evaluate).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it.each(['expectedPid', 'expectedEntry', 'expectedBuildSha', 'expectedSourceSha256'] as const)('refuses a mismatched %s', async field => {
    const { client } = fixture();
    const wrong = { ...identity, [field]: field === 'expectedPid' ? 8 : field === 'expectedEntry' ? '/other.mjs' : 'c'.repeat(field === 'expectedBuildSha' ? 40 : 64) };
    await expect(readSeedRestoreDiagnostics(client, wrong)).rejects.toThrow(/mismatch/);
  });

  it.each(['pid', 'script'] as const)('refuses journal operation %s drift even when the process matches', async field => {
    const { client, operation } = fixture();
    if (field === 'pid') operation.pid = 8; else operation.identity.script = '/other.mjs';
    await expect(readSeedRestoreDiagnostics(client, identity)).rejects.toThrow(/identity mismatch/);
  });

  it('rejects a missing exact operation instead of accepting a neighboring terminal result', async () => {
    const { client } = fixture();
    await expect(readSeedRestoreDiagnostics(client, { ...identity, expectedOperationId: 'missing' })).rejects.toThrow('not observed');
  });

  it('pins the first running operation across concurrent journal additions', async () => {
    const { client, state, operation } = fixture();
    let polls = 0;
    const result = await captureSeedRestorePhases(client, { ...identity, durationMs: 1000,
      sleepImpl: async () => {
        polls++;
        if (polls === 1) state.operations.push({ ...operation, id: 'neighbor', status: 'succeeded', events: [] });
        else operation.status = 'failed';
      } });
    expect(result.operation.id).toBe(operation.id);
    expect(result.operation.status).toBe('failed');
    expect(polls).toBe(2);
  });

  it('bounds a nonresponsive evaluate and disconnects at the total capture deadline', async () => {
    vi.useFakeTimers();
    const { client } = fixture();
    client.evaluate.mockImplementation(() => new Promise(() => {}));
    let outcome: unknown;
    const capture = captureSeedRestorePhases(client, { ...identity, durationMs: 1000 })
      .then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(1001);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain('exceeded 1000ms');
      expect(client.close).toHaveBeenCalledOnce();
      await capture;
    } finally { vi.useRealTimers(); }
  });

  it('disconnects on a polling timeout and validates the two-minute cap before transport use', async () => {
    vi.useFakeTimers();
    const { client } = fixture();
    try {
      const timedOut = expect(captureSeedRestorePhases(client, { ...identity, durationMs: 1000 }))
        .rejects.toThrow('exceeded 1000ms');
      await vi.advanceTimersByTimeAsync(1001);
      await timedOut;
      expect(client.close).toHaveBeenCalledOnce();
      client.evaluate.mockClear();
      await expect(captureSeedRestorePhases(client, { ...identity, durationMs: 120001 })).rejects.toThrow('120000');
      expect(client.evaluate).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('checks process identity before resuming and retries a failed startup resume during cleanup', async () => {
    const { client } = fixture();
    client.send.mockRejectedValueOnce(new Error('resume failed'));
    await expect(captureSeedRestorePhases(client, { ...identity, resumeStartup: true })).rejects.toThrow('resume failed');
    expect(client.evaluate.mock.invocationCallOrder[0]).toBeLessThan(client.send.mock.invocationCallOrder[0]);
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send).toHaveBeenLastCalledWith('Runtime.runIfWaitingForDebugger');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('preserves both the observation failure and disconnect failure', async () => {
    const { client } = fixture();
    client.evaluate.mockRejectedValue(new Error('read failed'));
    client.close.mockImplementation(() => { throw new Error('close failed'); });
    const error = await captureSeedRestorePhases(client, identity).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors.map((entry: Error) => entry.message)).toEqual(['read failed', 'close failed']);
  });
});

describe('P011 exact request weak-target heap-ID reader', () => {
  const owner = '@papercusp/db-org.acquire-registry';
  const requestId = '11111111-1111-4111-8111-111111111111';
  const missingRequestId = '22222222-2222-4222-8222-222222222222';
  const source = { processInstanceId: '33333333-3333-4333-8333-333333333333',
    buildSha: 'a'.repeat(40), poolInstanceId: '44444444-4444-4444-8444-444444444444' };

  function fixture(options: { duplicate?: boolean; evict?: boolean; zeroId?: boolean; badId?: boolean; rejectId?: boolean;
    drift?: string; getter?: boolean } = {}) {
    const decoded = [{ id: 'raw' }], mapped = [{ id: 'mapped' }], response = { rows: mapped };
    const row = { source: { ...source }, connectionId: 1, queryId: 2, correlation: { requestId },
      objectRefs: { decodedResult: new WeakRef(decoded), resolvedRows: new WeakRef(mapped), responseValue: new WeakRef(response) } };
    const pool = { pgResults: options.duplicate ? [row, row] : [row] };
    const state = { pools: new Map([['org-app', pool]]) };
    const slots = new Map([[owner, { value: state }]]);
    const context = { Symbol, Map, WeakRef, Object, process: { pid: 7, getBuiltinModule: () => ({ types }) },
      [Symbol.for('@papercusp/module-singleton.slots')]: slots };
    const ids = new Map<object, string>([[state, '10'], [decoded, '11'], [mapped, '12'], [response, '13']]);
    const handles = new Map<string, object>();
    const calls: string[] = [];
    if (options.getter) Object.defineProperty(row, 'correlation', { get() { calls.push('getter'); return { requestId }; } });
    return { calls, pool, row, handles, decoded, mapped, response, async evaluate(expression: string, opts?: any) {
      calls.push('evaluate');
      const value = runInNewContext(expression, context);
      if (opts?.returnByValue) {
        if (options.evict) pool.pgResults = [];
        if (options.drift === 'requestId') row.correlation.requestId = missingRequestId;
        else if (options.drift === 'connectionId' || options.drift === 'queryId') row[options.drift]++;
        else if (options.drift) (row.source as any)[options.drift] = 'drifted';
        return { result: { value } };
      }
      if (value && typeof value === 'object') {
        const objectId = 'handle-' + handles.size; handles.set(objectId, value);
        return { result: { objectId } };
      }
      return { result: { value } };
    }, async send(method: string, params: any) {
      calls.push(method);
      if (method === 'Runtime.releaseObjectGroup') { handles.clear(); return {}; }
      if (method === 'Runtime.callFunctionOn') {
        const value = runInNewContext('(' + params.functionDeclaration + ').apply(remote, args)',
          { ...context, remote: handles.get(params.objectId), args: (params.arguments ?? []).map((arg: any) => arg.value) });
        if (params.returnByValue || !value || typeof value !== 'object') return { result: { value } };
        const objectId = 'handle-' + handles.size; handles.set(objectId, value);
        return { result: { objectId } };
      }
      if (method !== 'HeapProfiler.getHeapObjectId') throw new Error('Unexpected method');
      if (options.rejectId) throw new Error('snapshot read failed');
      return { heapSnapshotObjectId: options.badId ? '9007199254740993' :
        options.zeroId ? '0' : ids.get(handles.get(params.objectId)!) };
    } };
  }

  it('binds exact raw/mapped/envelope targets and reports missing requests, then releases handles', async () => {
    const client = fixture();
    const report = await readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId, missingRequestId] });
    expect(report.roots).toEqual([{ owner, status: 'found', id: 10 }]);
    expect(report.queries?.records[0]).toMatchObject({ pool: 'org-app', source, connectionId: 1, queryId: 2, requestId,
      objects: [{ phase: 'decodedResult', status: 'found', id: 11 },
        { phase: 'resolvedRows', status: 'found', id: 12 }, { phase: 'responseValue', status: 'found', id: 13 }] });
    expect(report.queries?.unobservedRequestIds).toEqual([missingRequestId]);
    expect(client.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
    expect(client.calls).not.toContain('HeapProfiler.collectGarbage');
    expect(client.calls).not.toContain('HeapProfiler.takeHeapSnapshot');
  });

  it.each(['duplicate', 'evict'] as const)('discloses %s instead of substituting a count/time match', async defect => {
    const client = fixture({ [defect]: true });
    const report = await readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId] });
    expect(report.queries?.records[0].objects.map(o => o.status)).toEqual(Array(3).fill(defect === 'duplicate' ? 'ambiguous' : 'evicted'));
    expect(client.calls.filter(c => c === 'HeapProfiler.getHeapObjectId')).toHaveLength(1);
    expect(client.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
  });

  it('keeps uncaptured nodes explicit and releases handles on invalid IDs/protocol failure', async () => {
    const zero = fixture({ zeroId: true });
    const report = await readPinnedHeapObjectIds(zero as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId] });
    expect(report.queries?.records[0].objects.every(o => o.status === 'not-in-snapshot')).toBe(true);
    for (const client of [fixture({ badId: true }), fixture({ rejectId: true })]) {
      await expect(readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId] })).rejects.toThrow();
      expect(client.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
    }
  });

  it('rejects invalid/duplicate request IDs before any inspector operation', async () => {
    const client = fixture();
    for (const pgRequestIds of [[], ['secret'], [requestId, requestId], Array(33).fill(requestId)]) {
      await expect(readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds })).rejects.toThrow('request UUIDs');
    }
    expect(client.calls).toEqual([]);
  });

  it.each(['processInstanceId', 'buildSha', 'poolInstanceId', 'connectionId', 'queryId', 'requestId'])('rejects %s drift in the exact tuple', async drift => {
    const client = fixture({ drift });
    const report = await readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId] });
    expect(report.queries?.records[0].objects.every(o => o.status === 'evicted')).toBe(true);
    expect(client.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
  });

  it('does not run an application getter while locating request metadata', async () => {
    const client = fixture({ getter: true });
    const report = await readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId] });
    expect(report.queries?.records).toEqual([]);
    expect(report.queries?.unobservedRequestIds).toEqual([requestId]);
    expect(client.calls).not.toContain('getter');
  });

  it('keeps exact weak selection across FIFO churn without retaining the result or diagnostic row', async () => {
    const client = fixture();
    const report = await readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId],
      captureSnapshot: async metadata => {
        expect(metadata.records).toHaveLength(1);
        const selected: any = [...client.handles.values()][0];
        expect(selected.records[0]).not.toBe(client.row);
        expect(selected.records[0].objectRefs.decodedResult).toBeInstanceOf(WeakRef);
        expect(Object.values(selected.records[0])).not.toContain(client.decoded);
        expect(client.calls).not.toContain('HeapProfiler.getHeapObjectId');
        // The writer's existing newest-32 FIFO invariant evicts the request.
        client.pool.pgResults = Array.from({ length: 32 }, (_, queryId) =>
          ({ ...client.row, queryId, correlation: { requestId: missingRequestId } }));
      } });
    expect(report.queries?.records[0].objects.map(o => o.id)).toEqual([11, 12, 13]);
    expect(report.queries?.registryBeforeSnapshot.matched).toBe(1);
    expect(report.queries?.registryAfterSnapshot.matched).toBe(0);
    const live = await readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId] });
    expect(live.queries?.unobservedRequestIds).toEqual([requestId]);
    expect(client.handles.size).toBe(0);
  });

  it.each(['duplicate', 'getter'] as const)('refuses %s selection before invoking a costly snapshot', async defect => {
    const client = fixture({ [defect]: true });
    let snapshots = 0;
    await expect(readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId],
      captureSnapshot: async () => { snapshots++; } })).rejects.toThrow('pre-snapshot');
    expect(snapshots).toBe(0); expect(client.handles.size).toBe(0);
    expect(client.calls).not.toContain('getter');
  });

  it('releases weak selection after a snapshot failure', async () => {
    const client = fixture();
    await expect(readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId],
      captureSnapshot: async () => { throw new Error('capture failed'); } })).rejects.toThrow('capture failed');
    expect(client.handles.size).toBe(0);
    expect(client.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
  });

  it.each(['decodedResult', 'resolvedRows', 'responseValue'] as const)(
    'rejects an unregistered %s weak phase before snapshot or dereference', async phase => {
      const client = fixture();
      Reflect.deleteProperty(client.row.objectRefs, phase);
      const dereference = vi.spyOn(WeakRef.prototype, 'deref');
      let snapshots = 0;
      try {
        const error = await readPinnedHeapObjectIds(client as any, {
          expectedPid: 7, owners: [owner], pgRequestIds: [requestId],
          captureSnapshot: async () => { snapshots++; },
        }).catch(error => error);
        expect(error.message).toContain('pre-snapshot PG weak phases unobserved');
        expect(error.diagnostic).toMatchObject({ kind: 'pg-weak-phase-presence',
          registryBeforeSnapshot: { records: [{ requestId, source,
            weakPhasePresence: { decodedResult: true, resolvedRows: true, responseValue: true, [phase]: false } }] } });
        expect(JSON.stringify(error.diagnostic)).not.toContain('mapped');
        expect(snapshots).toBe(0);
        expect(dereference).not.toHaveBeenCalled();
        expect(client.calls).not.toContain('HeapProfiler.getHeapObjectId');
        expect(client.handles.size).toBe(0);
        expect(client.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
      } finally { dereference.mockRestore(); }
    });

  it.each(['getter', 'proxy'] as const)('rejects a %s weak phase without invoking its traps', async kind => {
    const client = fixture();
    const ref = client.row.objectRefs.resolvedRows;
    if (kind === 'getter') Object.defineProperty(client.row.objectRefs, 'resolvedRows', {
      get() { client.calls.push('phase-getter'); return ref; },
    });
    else client.row.objectRefs.resolvedRows = new Proxy(ref, {
      getPrototypeOf() { client.calls.push('phase-proxy'); return WeakRef.prototype; },
    });
    let snapshots = 0;
    await expect(readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId],
      captureSnapshot: async () => { snapshots++; } })).rejects.toThrow('weak phases unobserved');
    expect(snapshots).toBe(0);
    expect(client.calls).not.toContain('phase-getter');
    expect(client.calls).not.toContain('phase-proxy');
    expect(client.handles.size).toBe(0);
  });

  it('records registered weak phases without dereference and leaves collected targets as gaps', async () => {
    const client = fixture();
    const dereference = vi.spyOn(WeakRef.prototype, 'deref').mockReturnValue(undefined);
    let snapshots = 0;
    try {
      const report = await readPinnedHeapObjectIds(client as any, { expectedPid: 7, owners: [owner], pgRequestIds: [requestId],
        captureSnapshot: async metadata => {
          snapshots++;
          expect(dereference).not.toHaveBeenCalled();
          expect(metadata.records[0].weakPhasePresence).toEqual({ decodedResult: true, resolvedRows: true, responseValue: true });
          expect(JSON.stringify(metadata)).not.toContain('mapped');
        } });
      expect(snapshots).toBe(1);
      expect(report.queries?.records[0].objects.map(object => object.status)).toEqual(['collected', 'collected', 'collected']);
      expect(client.handles.size).toBe(0);
    } finally { dereference.mockRestore(); }
  });

  it('survives the actual diagnostic FIFO writer on a real inspector without pinning a collected decoded result', async () => {
    const registryUrl = new URL('../../../libs/papercusp/libs/db/src/acquire-registry.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      const { recordPgResult, recordPgDiagnosticResponse, setPgDiagnosticContextResolver,
        capturePgDiagnosticContext, pgResultDiagnosticSnapshot, PG_RESULT_DIAGNOSTIC_LIMIT } = await import(${JSON.stringify(registryUrl)});
      const source = ${JSON.stringify(source)};
      const correlation = { processInstanceId: source.processInstanceId, buildSha: source.buildSha,
        attemptId: ${JSON.stringify(requestId)}, requestId: ${JSON.stringify(requestId)}, operation: 'workItems.byHarness' };
      setPgDiagnosticContextResolver(() => correlation);
      globalThis.decoded = [{ kind: 'raw' }];
      globalThis.mapped = [{ kind: 'mapped' }];
      globalThis.envelope = { rows: mapped };
      recordPgResult('selection-fixture', { connectionId: 1, queryId: 2, backendPid: null,
        query: 'select 1', rowCount: 1, wireBytes: 1, status: 'ok',
        result: decoded, context: capturePgDiagnosticContext() }, source);
      recordPgDiagnosticResponse(correlation, 'resolvedRows', mapped);
      recordPgDiagnosticResponse(correlation, 'responseValue', envelope);
      globalThis.churn = () => {
        globalThis.decoded = undefined;
        for (let queryId = 3; queryId < 3 + PG_RESULT_DIAGNOSTIC_LIMIT; queryId++)
          recordPgResult('selection-fixture', { connectionId: 1, queryId, backendPid: null,
            query: 'select 1', rowCount: 0, wireBytes: 0, status: 'ok' }, source);
        return pgResultDiagnosticSnapshot('selection-fixture');
      };
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 15_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const report = await readPinnedHeapObjectIds(client, { expectedPid: child.pid!, owners: [owner], pgRequestIds: [requestId],
        captureSnapshot: async metadata => {
          expect(metadata.records).toHaveLength(1);
          const churn = (await client!.evaluate('churn()', { returnByValue: true })).result.value;
          expect(churn).toMatchObject({ capacity: 32, totalRecorded: 33 });
          expect(churn.results).toHaveLength(32);
          expect(churn.results.every((row: any) => !row.correlation)).toBe(true);
          // A later inspector task permits collection; the weak selection must
          // not make the evicted raw result a snapshot root.
          await client!.send('HeapProfiler.enable');
          await client!.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
        } });
      expect(report.queries?.registryBeforeSnapshot.matched).toBe(1);
      expect(report.queries?.registryAfterSnapshot.matched).toBe(0);
      expect(report.queries?.records[0].objects[0]).toEqual({ phase: 'decodedResult', status: 'collected' });
      expect(report.queries?.records[0].objects.slice(1).every(o => o.status === 'found')).toBe(true);
      const live = await readPinnedHeapObjectIds(client, { expectedPid: child.pid!, owners: [owner], pgRequestIds: [requestId] });
      expect(live.queries?.unobservedRequestIds).toEqual([requestId]);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 45_000);

  it('binds weak targets to exact objects on a real private inspector and releases all handles', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      globalThis.decoded = [{ kind: 'raw' }];
      globalThis.mapped = [{ kind: 'mapped' }];
      globalThis.envelope = { rows: mapped };
      const row = { source: ${JSON.stringify(source)}, connectionId: 1, queryId: 2,
        correlation: { requestId: ${JSON.stringify(requestId)} }, objectRefs: {
          decodedResult: new WeakRef(decoded), resolvedRows: new WeakRef(mapped), responseValue: new WeakRef(envelope) } };
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([[${JSON.stringify(owner)},
        { value: { pools: new Map([['org-app', { pgResults: [row] }]]) } }]]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    const objectGroup = 'p011-exact-object-test';
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      // New isolated precondition test, never a serving-process resource cohort.
      await client.send('HeapProfiler.enable');
      await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      const report = await readPinnedHeapObjectIds(client, { expectedPid: child.pid!, owners: [owner], pgRequestIds: [requestId] });
      const objects = report.queries!.records[0].objects;
      expect(objects.every(object => object.status === 'found')).toBe(true);
      expect(new Set(objects.map(object => object.id)).size).toBe(3);
      for (const object of objects) {
        const { result } = await client.send('HeapProfiler.getObjectByHeapObjectId', {
          objectId: String(object.id), objectGroup,
        });
        const globalName = object.phase === 'decodedResult' ? 'decoded' : object.phase === 'resolvedRows' ? 'mapped' : 'envelope';
        const same = await client.send('Runtime.callFunctionOn', { objectId: result.objectId,
          functionDeclaration: 'function () { return this === globalThis.' + globalName + '; }', returnByValue: true });
        expect(same.result.value, object.phase).toBe(true);
      }
    } finally {
      if (client) { await client.send('Runtime.releaseObjectGroup', { objectGroup }); client.close(); }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 30_000);
});

describe('P011 digest-selected cache snapshot identities', () => {
  const owner = '@papercusp/operator-core.operatorCache';
  const key = 'private-workspace\u0000coord:inbox|private-arguments';
  const digest = createHash('sha256').update(key).digest('hex');
  const missingDigest = createHash('sha256').update('missing').digest('hex');

  function fixture() {
    const payload = [{ privateBody: 'private-result-content' }];
    const entry: any = { value: payload };
    const map = new Map<any, any>([[key, entry]]);
    const state = { cache: { l1: { map } } };
    const slots = new Map([[owner, { value: state }]]);
    const context = { Symbol, Map, WeakRef, Object, Set, process: { pid: 7,
      getBuiltinModule: (name: string) => name === 'util' ? { types } : { createHash } },
      [Symbol.for('@papercusp/module-singleton.slots')]: slots };
    const handles = new Map<string, object>();
    const ids = new Map<object, string>([[state, '10'], [entry, '11'], [payload, '12']]);
    const calls: string[] = [];
    let nextHandle = 0;
    const remote = (value: any, byValue?: boolean) => {
      if (byValue || !value || typeof value !== 'object') return { result: { value } };
      const objectId = 'handle-' + nextHandle++; handles.set(objectId, value); return { result: { objectId } };
    };
    const client = { async evaluate(expression: string, options?: any) {
      calls.push('evaluate'); return remote(runInNewContext(expression, context), options?.returnByValue);
    }, async send(method: string, params: any) {
      calls.push(method);
      if (method === 'Runtime.releaseObjectGroup') { handles.clear(); return {}; }
      if (method === 'Runtime.callFunctionOn') return remote(runInNewContext(
        '(' + params.functionDeclaration + ').call(target)', { ...context, target: handles.get(params.objectId) }), params.returnByValue);
      if (method === 'HeapProfiler.getHeapObjectId') return { heapSnapshotObjectId: ids.get(handles.get(params.objectId)!) ?? '0' };
      throw new Error('Unexpected method ' + method);
    } };
    return { client, entry, payload, map, state, slots, context, handles, ids, calls };
  }

  it('joins entry and payload IDs without exposing keys, values, or running application iterators', async () => {
    const f = fixture();
    Object.defineProperty(f.map, Symbol.iterator, { value() { throw new Error('application iterator'); } });
    const r = await readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest, missingDigest] });
    expect(r.cacheEntries?.records).toEqual([
      { keyDigest: digest, status: 'selected', objects: [{ phase: 'entry', status: 'found', id: 11 }, { phase: 'value', status: 'found', id: 12 }] },
      { keyDigest: missingDigest, status: 'missing', objects: [{ phase: 'entry', status: 'missing' }, { phase: 'value', status: 'missing' }] },
    ]);
    expect(r.cacheEntries?.scanComplete).toBe(true);
    for (const secret of [key, 'private-arguments', 'private-result-content', 'handle-']) expect(JSON.stringify(r)).not.toContain(secret);
    expect(f.handles.size).toBe(0);
    expect(f.calls).not.toContain('HeapProfiler.takeHeapSnapshot');
  });

  it('does not strongly retain selected entries or values across the snapshot callback', async () => {
    const f = fixture();
    let captures = 0;
    const r = await readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest],
      captureSnapshot: async metadata => {
        captures++; expect(metadata.cacheEntries.records).toEqual([{ keyDigest: digest, status: 'selected' }]);
        const selection: any = [...f.handles.values()][0];
        expect(selection.mapRef).toBeInstanceOf(WeakRef);
        expect(selection.entries[0].entryRef).toBeInstanceOf(WeakRef);
        expect(selection.entries[0].valueRef).toBeInstanceOf(WeakRef);
        expect(Object.values(selection)).not.toContain(f.map);
        expect(Object.values(selection.entries[0])).not.toContain(f.entry);
        expect(Object.values(selection.entries[0])).not.toContain(f.payload);
      } });
    expect(captures).toBe(1); expect(r.cacheEntries?.records[0].objects[1].id).toBe(12); expect(f.handles.size).toBe(0);
  });

  it.each(['evicted', 'map-changed', 'entry-changed', 'value-changed'])('invalidates IDs after %s during capture', async status => {
    const f = fixture();
    const r = await readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest],
      captureSnapshot: async () => {
        if (status === 'evicted') f.map.delete(key);
        else if (status === 'map-changed') f.state.cache.l1.map = new Map([[key, f.entry]]);
        else if (status === 'entry-changed') f.map.set(key, { value: f.payload });
        else f.entry.value = [...f.payload];
      } });
    expect(r.cacheEntries?.records[0]).toEqual({ keyDigest: digest, status,
      objects: [{ phase: 'entry', status }, { phase: 'value', status }] });
    expect(f.handles.size).toBe(0);
  });

  it('rechecks membership after the CDP ID await and discards a now-detached target', async () => {
    const f = fixture(), send = f.client.send;
    f.client.send = async (method, params) => {
      const result = await send(method, params);
      if (method === 'HeapProfiler.getHeapObjectId' && 'heapSnapshotObjectId' in result && result.heapSnapshotObjectId === '12') f.map.delete(key);
      return result;
    };
    const r = await readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest] });
    expect(r.cacheEntries?.records[0].objects).toEqual([{ phase: 'entry', status: 'evicted' }, { phase: 'value', status: 'evicted' }]);
    expect(f.handles.size).toBe(0);
  });

  it.each(['entry-getter', 'path-getter', 'entry-proxy', 'value-proxy', 'map-proxy', 'nonobject'])('refuses unsafe %s without invoking it', async mode => {
    const f = fixture(); let effects = 0, snapshots = 0;
    if (mode === 'entry-getter') Object.defineProperty(f.entry, 'value', { get() { effects++; return f.payload; } });
    else if (mode === 'path-getter') Object.defineProperty(f.state, 'cache', { get() { effects++; return { l1: { map: f.map } }; } });
    else if (mode === 'entry-proxy') f.map.set(key, new Proxy(f.entry, { getOwnPropertyDescriptor() { effects++; throw new Error('proxy'); } }));
    else if (mode === 'value-proxy') f.entry.value = new Proxy(f.payload, { ownKeys() { effects++; throw new Error('proxy'); } });
    else if (mode === 'map-proxy') f.state.cache.l1.map = new Proxy(f.map, { get() { effects++; throw new Error('proxy'); } });
    else f.entry.value = 'private-primitive';
    await expect(readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest],
      captureSnapshot: async () => { snapshots++; } })).rejects.toThrow('pre-snapshot cache selection');
    expect(effects).toBe(0); expect(snapshots).toBe(0); expect(f.handles.size).toBe(0);
  });

  it.each(['scan-limit', 'long-key', 'non-string-key'])('keeps a %s absence unobserved and rejects capture', async mode => {
    const f = fixture();
    if (mode === 'scan-limit') for (let i = 0; i < 8192; i++) f.map.set('other-' + i, { value: [] });
    else f.map.set(mode === 'long-key' ? 'x'.repeat(16385) : {}, { value: [] });
    const r = await readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest, missingDigest] });
    expect(r.cacheEntries?.records.every(row => row.status === 'unobserved')).toBe(true);
    await expect(readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest],
      captureSnapshot: async () => { throw new Error('must not capture'); } })).rejects.toThrow('pre-snapshot cache selection');
    expect(f.handles.size).toBe(0);
  });

  it('preserves shared payload IDs across distinct entries instead of inventing exclusive ownership', async () => {
    const f = fixture(), otherKey = 'other-private-key', otherEntry = { value: f.payload };
    f.map.set(otherKey, otherEntry); f.ids.set(otherEntry, '13');
    const r = await readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner],
      cacheKeyDigests: [digest, createHash('sha256').update(otherKey).digest('hex')] });
    expect(r.cacheEntries?.records.map(row => row.objects[1].id)).toEqual([12, 12]);
    expect(r.cacheEntries?.definition).toContain('shared IDs overlap');
  });

  it('releases the selection and target handles when snapshot or ID lookup fails', async () => {
    for (const capture of [true, false]) {
      const f = fixture(), send = f.client.send;
      f.client.send = async (method, params) => {
        if (!capture && method === 'HeapProfiler.getHeapObjectId') throw new Error('ID failure');
        return send(method, params);
      };
      await expect(readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest],
        ...(capture ? { captureSnapshot: async () => { throw new Error('snapshot failure'); } } : {}) })).rejects.toThrow('failure');
      expect(f.handles.size).toBe(0); expect(f.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
    }
  });

  it('validates exact digests, bounds and owner before touching the inspector', async () => {
    const f = fixture();
    for (const cacheKeyDigests of [[], [digest, digest], ['invalid'], Array.from({ length: 33 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'))])
      await expect(readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests })).rejects.toThrow();
    await expect(readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: ['other'], cacheKeyDigests: [digest] })).rejects.toThrow('operator-cache owner');
    expect(f.calls).toEqual([]);
  });

  it.each(['0', 'invalid', '9007199254740992'])('keeps uncaptured ID %s explicit or rejects unsafe IDs', async id => {
    const f = fixture(); f.ids.set(f.payload, id);
    const run = () => readPinnedHeapObjectIds(f.client as any, { expectedPid: 7, owners: [owner], cacheKeyDigests: [digest] });
    if (id === '0') expect((await run()).cacheEntries?.records[0].objects[1]).toEqual({ phase: 'value', status: 'not-in-snapshot' });
    else await expect(run()).rejects.toThrow('Invalid heap object ID');
    expect(f.handles.size).toBe(0);
  });

  it('checks the PID before target reads and releases failed setup handles', async () => {
    const f = fixture();
    await expect(readPinnedHeapObjectIds(f.client as any, { expectedPid: 8, owners: [owner], cacheKeyDigests: [digest] })).rejects.toThrow('PID mismatch');
    expect(f.handles.size).toBe(0); expect(f.calls.at(-1)).toBe('Runtime.releaseObjectGroup');
  });

  it('binds the actual cache entry and value in a real private inspector', async () => {
    const code = `
      const value = [{ body: 'private cache payload' }];
      globalThis.cacheState = { cache: { l1: { map: new Map([['private-cache-key', { value }]]) } } };
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['${owner}', { value: globalThis.cacheState }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
    const objectGroup = 'p011-cache-identity-verification';
    try {
      const deadline = Date.now() + 5000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      await client.send('HeapProfiler.enable');
      await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      const report = await readPinnedHeapObjectIds(client, { expectedPid: child.pid!, owners: [owner],
        cacheKeyDigests: [createHash('sha256').update('private-cache-key').digest('hex')] });
      expect(report.cacheEntries?.status).toBe('observed');
      const objects = report.cacheEntries!.records[0].objects;
      expect(new Set(objects.map(object => object.id)).size).toBe(2);
      for (const object of objects) {
        const { result } = await client.send('HeapProfiler.getObjectByHeapObjectId', { objectId: String(object.id), objectGroup });
        const same = await client.send('Runtime.callFunctionOn', { objectId: result.objectId,
          functionDeclaration: 'function () { const entry = Map.prototype.get.call(globalThis.cacheState.cache.l1.map, "private-cache-key"); return this === ' +
            (object.phase === 'entry' ? 'entry' : 'Object.getOwnPropertyDescriptor(entry, "value").value') + '; }', returnByValue: true });
        expect(same.result.value, object.phase).toBe(true);
      }
      expect(JSON.stringify(report)).not.toContain('private cache payload');
    } finally {
      if (client) { await client.send('Runtime.releaseObjectGroup', { objectGroup }); client.close(); }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 30_000);

  it.each(['file-only', 'neighbor-session-disconnect', 'product-recorder-disconnect', 'atomic-product-recorder-disconnect', 'atomic-evicted'] as const)(
    'distinguishes file snapshot IDs from %s without inferring collection', async mode => {
      const directory = mkdtempSync(join(tmpdir(), 'p011-cache-id-lifetime-'));
      const snapshotPath = join(directory, 'heap.heapsnapshot');
      const code = `
        globalThis.cacheState = { cache: { l1: { map: new Map([
          ['private-cache-key', { value: [{ body: 'private payload' }] }]
        ]) } } };
        globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
          ['${owner}', { value: globalThis.cacheState }]
        ]);
        globalThis.cachePayloadWeak = new WeakRef(globalThis.cacheState.cache.l1.map.get('private-cache-key').value);
        (async () => {
          if (${JSON.stringify(mode)}.includes('product-recorder')) {
            const { LoopCpuRecorder } = await import(${JSON.stringify(new URL('./event-loop-cpu-recorder.ts', import.meta.url).href)});
            globalThis.recorder = new LoopCpuRecorder(1000, () => {});
            if (!await globalThis.recorder.update(true, true)) throw Error('Product recorder failed to arm');
          }
          console.log('ready'); setInterval(() => {}, 1000);
        })();
      `;
      const child = spawn(process.execPath, ['--import', 'tsx', '--inspect=127.0.0.1:0', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', client: ReturnType<typeof createCdpClient> | undefined;
      child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
      try {
        const deadline = Date.now() + 5000;
        while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
        expect(stdout, stderr).toContain('ready');
        client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
        const options = { expectedPid: child.pid!, owners: [owner],
          cacheKeyDigests: [createHash('sha256').update('private-cache-key').digest('hex')] };
        const measured = await withFunctionCallTrace(client, { expectedPid: child.pid!, durationMs: 30000,
          maxCalls: 16, maxStacks: 8, maxStackChars: 4096,
          targets: [{ name: 'inspector.Session.disconnect',
            expression: "process.getBuiltinModule('inspector').Session.prototype.disconnect" }],
        }, async () => {
          if (mode === 'atomic-product-recorder-disconnect') {
            const report = await capturePinnedHeapSnapshot(client!, { ...options, snapshotPath });
            const samples = await client!.send('Runtime.evaluate', {
              expression: 'globalThis.recorder.record(30).then(r => r.profile.samples.length)',
              returnByValue: true, awaitPromise: true });
            expect(samples.result.value).toBeGreaterThan(0);
            await client!.evaluate('globalThis.recorder.update(false, false)', { returnByValue: true });
            // The real product teardown did clear the live map. Saved IDs must
            // still join the actual file; no retry or payload pin repairs them.
            const after = await readPinnedHeapObjectIds(client!, options);
            expect(after.roots[0].status).toBe('not-in-snapshot');
            expect(report.identityBoundary).toContain('one target job');
            return report;
          }
          if (mode === 'atomic-evicted') {
            const intercepted = { evaluate: client!.evaluate, send: async (method: string, params: any) => {
              if (method === 'Runtime.callFunctionOn' && params.functionDeclaration.startsWith('async function'))
                await client!.evaluate('globalThis.cacheState.cache.l1.map.clear()', { returnByValue: true });
              return client!.send(method, params);
            } };
            return capturePinnedHeapSnapshot(intercepted, { ...options, snapshotPath });
          }
          return readPinnedHeapObjectIds(client!, { ...options,
          cacheKeyDigests: [createHash('sha256').update('private-cache-key').digest('hex')],
          captureSnapshot: async () => {
            await client!.send('HeapProfiler.enable');
            const captured = await client!.evaluate(`(() => {
              const file = process.getBuiltinModule('v8').writeHeapSnapshot(${JSON.stringify(snapshotPath)});
              if (${JSON.stringify(mode)} === 'neighbor-session-disconnect') {
                const neighbor = new (process.getBuiltinModule('inspector').Session)();
                neighbor.connect(); neighbor.disconnect();
              }
              return file;
            })()`, { returnByValue: true });
            expect(captured.result.value).toBe(snapshotPath);
            if (mode === 'product-recorder-disconnect')
              await client!.evaluate('globalThis.recorder.update(false, false)', { returnByValue: true });
          } });
        });
        const report = measured.value;
        const found = mode === 'file-only' || mode === 'atomic-product-recorder-disconnect';
        if (mode.includes('product-recorder')) {
          const traced = measured.trace.calls['inspector.Session.disconnect'];
          expect(traced.calls).toBeGreaterThan(0);
          expect(traced.stacks.some(stack => stack.includes('LoopCpuRecorder.suspend'))).toBe(true);
          expect(measured.trace.limited).toBe(false);
        }
        const q = report.cacheEntries!;
        if (mode === 'atomic-evicted') {
          expect(q.records[0].status).toBe('evicted');
          expect(q.records[0].objects.map(object => object.status)).toEqual(['evicted', 'evicted']);
          expect((await client.evaluate('globalThis.cachePayloadWeak.deref() === undefined', { returnByValue: true })).result.value).toBe(true);
          expect(report.roots[0].status).toBe('found');
        } else {
        expect(q.records[0].status).toBe('selected'); // Both actual objects still belong to the same map.
        expect(q.records[0].objects.map(object => object.status)).toEqual(found
          ? ['found', 'found'] : ['not-in-snapshot', 'not-in-snapshot']);
        expect(report.roots[0].status).toBe(found ? 'found' : 'not-in-snapshot');
        const snapshot = JSON.parse(readFileSync(snapshotPath).toString());
        const width = snapshot.snapshot.meta.node_fields.length, idField = snapshot.snapshot.meta.node_fields.indexOf('id');
        const ids = new Set<number>();
        for (let i = idField; i < snapshot.nodes.length; i += width) ids.add(snapshot.nodes[i]);
        if (found) for (const object of [...report.roots, ...q.records[0].objects]) expect(ids.has(object.id!)).toBe(true);
        }
        expect((await client.evaluate('Object.getOwnPropertyNames(globalThis).filter(k => k.startsWith("__papercuspHeapSelection_")).length',
          { returnByValue: true })).result.value).toBe(0);
        const membership = await client.evaluate('globalThis.cacheState.cache.l1.map.size', { returnByValue: true });
        expect(membership.result.value).toBe(mode === 'atomic-evicted' ? 0 : 1);
        expect(JSON.stringify(report)).not.toContain('private payload');
      } finally {
        client?.close();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
        }
        rmSync(directory, { recursive: true, force: true });
      }
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }, 30_000);
});

describe('PID-bound host configuration facts', () => {
  it('opts into direct V8 allocation counters only after validating both the flag and target identity', async () => {
    const effects: string[] = [];
    const spaces = [{ space_name: 'old_space', space_used_size: 123 }];
    const code = { code_and_metadata_size: 456, bytecode_and_metadata_size: 789 };
    const client = { evaluate: async (expression: string) => ({ result: { value: runInNewContext(expression, {
      process: { pid: 7, uptime: () => 1, memoryUsage: () => ({ heapUsed: 100 }),
        getBuiltinModule: (name: string) => {
          effects.push(name);
          if (name !== 'v8') throw Error('Unexpected builtin');
          return { getHeapStatistics: () => ({ used_heap_size: 100 }),
            getHeapSpaceStatistics: () => { effects.push('spaces'); return spaces; },
            getHeapCodeStatistics: () => { effects.push('code'); return code; } };
        } },
    }) } }) };
    const plain = await readProcessMemory(client, { expectedPid: 7 });
    expect(plain).not.toHaveProperty('heapSpaces');
    expect(plain).not.toHaveProperty('heapCode');
    expect(effects).toEqual(['v8']);
    effects.length = 0;
    const detailed = await readProcessMemory(client, { expectedPid: 7, allocationDetails: true });
    expect(detailed.heapSpaces).toEqual(spaces); expect(detailed.heapCode).toEqual(code);
    expect(effects).toEqual(['v8', 'spaces', 'code']);
    effects.length = 0;
    await expect(readProcessMemory(client, { expectedPid: 7, allocationDetails: 'yes' as any }))
      .rejects.toThrow('boolean');
    await expect(readProcessMemory(client, { expectedPid: 8, allocationDetails: true }))
      .rejects.toThrow('PID mismatch');
    expect(effects).toEqual([]);
  });

  it('observes a retained large allocation through real V8 heap spaces without forcing GC', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e',
      "console.log('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const before = await readProcessMemory(client, { expectedPid: child.pid!, allocationDetails: true });
      await client.evaluate('globalThis.retained = new Array(2_000_000).fill(1)');
      const after = await readProcessMemory(client, { expectedPid: child.pid!, allocationDetails: true });
      const used = (row: any) => row.heapSpaces.reduce((sum: number, space: any) => sum + space.space_used_size, 0);
      expect(used(after) - used(before)).toBeGreaterThan(8 * 1024 * 1024);
      expect(after.heapSpaces.every((space: any) => typeof space.space_name === 'string' &&
        Number.isFinite(space.space_used_size) && space.space_used_size >= 0)).toBe(true);
      for (const field of ['code_and_metadata_size', 'bytecode_and_metadata_size', 'external_script_source_size']) {
        expect(Number.isFinite(after.heapCode[field]) && after.heapCode[field] >= 0).toBe(true);
      }
      expect((await client.evaluate('retained.length', { returnByValue: true })).result.value).toBe(2_000_000);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('normalizes only fixed boot flags and observes worker state without leaking arbitrary environment', async () => {
    const effects: string[] = [];
    const inspect = async (env: Record<string, string>, cluster: object, hostFacts = true) => {
      const client = { evaluate: async (expression: string) => ({ result: { value: runInNewContext(expression, {
        process: { pid: 7, env, uptime: () => 1, memoryUsage: () => ({ heapUsed: 100 }),
          getBuiltinModule: (name: string) => {
            effects.push(name);
            if (name === 'v8') return { getHeapStatistics: () => ({ used_heap_size: 100 }) };
            if (name === 'cluster') return cluster;
            throw Error('Unexpected builtin');
          } },
      }) } }) };
      return readProcessMemory(client, { expectedPid: 7, hostFacts });
    };
    const env = { PAPERCUSP_BACKGROUND_WORKERS: 'private-enabled-value', PAPERCUSP_HONO_PORT: '3170',
      PAPERCUSP_SPAWNER_SIDECAR_MODE: '1', PRIVATE_TOKEN: 'never-export-this' };
    const primary = await inspect(env, { isPrimary: true, isWorker: false, workers: { 1: {}, 2: {} } });
    expect(primary.hostFacts).toMatchObject({ backgroundWorkersOverride: 'enabled', stagingPort: true,
      cluster: { isPrimary: true, isWorker: false, workerId: null, primaryWorkerCount: 2 },
      sidecarFlags: { spawner: true, substrate: false } });
    expect(JSON.stringify(primary)).not.toMatch(/private-enabled-value|never-export-this|PRIVATE_TOKEN/);
    expect((await inspect({ PAPERCUSP_BACKGROUND_WORKERS: '0' },
      { isPrimary: false, isWorker: true, worker: { id: 3 } })).hostFacts).toMatchObject({
      backgroundWorkersOverride: 'disabled', stagingPort: false,
      cluster: { isPrimary: false, isWorker: true, workerId: 3, primaryWorkerCount: null } });
    expect((await inspect({}, { isPrimary: true, isWorker: false })).hostFacts.backgroundWorkersOverride).toBe('unset');
    effects.length = 0;
    expect(await inspect(env, {}, false)).not.toHaveProperty('hostFacts');
    expect(effects).toEqual(['v8']);
  });

  it('rejects invalid opt-in and wrong targets before accepting host facts', async () => {
    let evaluations = 0;
    const client = { evaluate: async () => { evaluations++; return { result: { value: { pid: 8 } } }; } };
    await expect(readProcessMemory(client, { expectedPid: 7, hostFacts: 'yes' as any })).rejects.toThrow('boolean');
    expect(evaluations).toBe(0);
    await expect(readProcessMemory(client, { expectedPid: 7, hostFacts: true })).rejects.toThrow('PID mismatch');
  });
});

describe('named pinned payload attribution on a real Node inspector', () => {
  it('attributes individual cache values fairly with protected keys, stable digests and no application effects', async () => {
    const key = 'private-workspace\u0000plans:get|private-payload';
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      let effects = 0;
      const shared = Buffer.alloc(19), accessor = {};
      Object.defineProperty(accessor, 'value', { get() { effects++; throw Error('accessor'); } });
      const proxy = new Proxy({}, { getOwnPropertyDescriptor() { effects++; throw Error('proxy'); } });
      const map = new Map([
        [${JSON.stringify(key)}, { value: { rows: Array.from({length: 100}, () => 'heavy') }, hardExpiresAt: 0 }],
        ['private-workspace\\0orders:list|private-payload', { value: { payload: 'later!', shared }, softExpiresAt: Infinity }],
        ['private-workspace\\0coord:feed|private-payload', { value: shared }],
        ['private-workspace\\0facts:list|private-payload', accessor],
        ['private-workspace\\0plans:items|private-payload', proxy],
        ['legacy/private-payload', { value: 'legacy' }],
        ['private-payload'.repeat(20), { value: 'long' }],
        [proxy, { value: 'non-string' }]
      ]);
      map[Symbol.iterator] = () => { effects++; throw Error('iterator'); };
      const root = { cache: { l1: { map } } };
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['@papercusp/operator-core.operatorCache', { value: root }]
      ]);
      globalThis.effectCount = () => effects;
      globalThis.keyOrder = () => Array.from(Map.prototype.keys.call(map)).map(key => typeof key === 'string' ? key : null);
      globalThis.hideMap = () => Object.defineProperty(root.cache.l1, 'map', { get() { effects++; throw Error('path getter'); } });
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const options = { expectedPid: child.pid!, owners: ['@papercusp/operator-core.operatorCache'],
        operatorCacheEntries: true, maxEntries: 128, maxEntryEntries: 10, maxEntryObjects: 12,
        maxKeyCodeUnits: 60, budgetMs: 200 };
      const before = (await client.evaluate('keyOrder()', { returnByValue: true })).result.value;
      const report = await readPinnedState(client, options), cache = report.roots[0].cacheEntries;
      expect(cache).toMatchObject({ status: 'map', population: 8, checked: 8, notChecked: 0 });
      expect(cache.values[0]).toMatchObject({ toolNamespace: 'plans:get', keyFormat: 'workspace-nul-tool-pipe',
        keyDigest: createHash('sha256').update(key).digest('hex'), hardExpiry: 'expired', traversalLimited: true });
      expect(cache.values[1]).toMatchObject({ toolNamespace: 'orders:list', softExpiry: 'infinite',
        stringCodeUnits: 6, byteViewExtents: 19, traversalLimited: false });
      expect(cache.values[2]).toMatchObject({ sharedEdges: 1, byteViewExtents: 0 });
      expect(cache.values[3].valueStatus).toBe('accessor-skipped');
      expect(cache.values[4].valueStatus).toBe('proxy-skipped');
      expect(cache.values[5]).toMatchObject({ keyFormat: 'unknown', toolNamespace: null });
      expect(cache.values[6]).toMatchObject({ keyDigest: null, keyDigestUnavailable: 'key-length-limit' });
      expect(cache.values[7]).toMatchObject({ keyDigest: null, keyDigestUnavailable: 'non-string-key' });
      expect(report.entries).toBeLessThanOrEqual(options.maxEntries);
      expect(cache.values.every((value: any) => value.entries <= 10 && value.objects <= 12)).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(/private-workspace|private-payload/);
      const again = await readPinnedState(client, options);
      expect(again.roots[0].cacheEntries.values.map((value: any) => value.keyDigest))
        .toEqual(cache.values.map((value: any) => value.keyDigest));
      expect((await client.evaluate('keyOrder()', { returnByValue: true })).result.value).toEqual(before);
      const capped = await readPinnedState(client, { ...options, maxCacheEntries: 2 });
      expect(capped.roots[0].cacheEntries).toMatchObject({ population: 8, checked: 2, notChecked: 6 });
      expect(capped.limited).toBe(true);
      const page = await readPinnedState(client, { ...options, maxCacheEntries: 2, cacheEntryOffset: 5 });
      expect(page.roots[0].cacheEntries).toMatchObject({ scanned: 7, checked: 2,
        selection: { mode: 'offset', offset: 5, nextOffset: 7, selectedNotChecked: 0, scanComplete: false } });
      expect(page.roots[0].cacheEntries.values[0].keyFormat).toBe('unknown');
      const digest = cache.values[1].keyDigest;
      const selected = await readPinnedState(client, { ...options, cacheKeyDigests: [digest] });
      expect(selected.roots[0].cacheEntries).toMatchObject({ scanned: 2, checked: 1,
        selection: { mode: 'digests', nextOffset: null, unresolvedKeyDigests: [] } });
      expect(selected.roots[0].cacheEntries.values[0]).toMatchObject({ keyDigest: digest,
        toolNamespace: 'orders:list', stringCodeUnits: 6, byteViewExtents: 19 });
      const unresolved = await readPinnedState(client, { ...options, cacheKeyDigests: ['f'.repeat(64)] });
      expect(unresolved.roots[0].cacheEntries).toMatchObject({ scanned: 8, checked: 0, undigestibleKeys: 2,
        selection: { scanComplete: true, unresolvedKeyDigests: ['f'.repeat(64)], unresolvedAreMissing: false } });
      for (const invalid of [{ cacheEntryOffset: -1 }, { cacheEntryOffset: 32769 },
        { cacheKeyDigests: [] }, { cacheKeyDigests: ['private-payload'] },
        { cacheKeyDigests: [digest, digest] }, { cacheKeyDigests: [digest], cacheEntryOffset: 1 },
        { cacheKeyDigests: [digest], operatorCacheEntries: false }]) {
        await expect(readPinnedState(client, { ...options, ...invalid })).rejects.toThrow('limits');
      }
      await expect(readPinnedState(client, { ...options, maxEntryEntries: 0 })).rejects.toThrow('limits');
      await expect(readPinnedState(client, { ...options, expectedPid: child.pid! + 1 })).rejects.toThrow('PID mismatch');
      await client.evaluate('hideMap()');
      expect((await readPinnedState(client, options)).roots[0].cacheEntries.status).toBe('accessor-skipped');
      expect((await client.evaluate('effectCount()', { returnByValue: true })).result.value).toBe(0);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('attributes the direct Jev writer without treating private or malformed suffixes as tool namespaces', async () => {
    const digest = 'a'.repeat(64);
    const keys = [
      'private-workspace\u0000jev-memory:' + digest,
      'private-workspace\u0000jev-memory:' + digest.slice(1),
      'private-workspace\u0000jev-memory:' + digest.toUpperCase(),
      'private-workspace\u0000jev-memory:' + digest + '\n',
      '\u0000jev-memory:' + digest,
      'private-workspace\u0000private-prefix-jev-memory:' + digest,
      'private-workspace\u0000jev-memory:' + digest + '|private-payload',
      'private-workspace\u0000memory-inject-block:private-payload',
      'private-workspace\u0000plans:get|private-payload',
    ];
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      const map = new Map(${JSON.stringify(keys)}.map(key => [key,
        { value: { scores: [['private-memory-id', 0.8]], model: 'private-model' } }]));
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['@papercusp/operator-core.operatorCache', { value: { cache: { l1: { map } } } }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const report = await readPinnedState(client, { expectedPid: child.pid!,
        owners: ['@papercusp/operator-core.operatorCache'], operatorCacheEntries: true,
        maxCacheEntries: keys.length, maxEntries: 512, maxObjects: 128, budgetMs: 200 });
      const cache = report.roots[0].cacheEntries;
      expect(cache).toMatchObject({ checked: keys.length, notChecked: 0 });
      expect(cache.values[0]).toMatchObject({ cacheOwner: 'jev-memory', toolNamespace: null,
        keyFormat: 'workspace-nul-jev-memory-sha256',
        keyDigest: createHash('sha256').update(keys[0]).digest('hex'), traversalLimited: false });
      for (const value of cache.values.slice(1, -1)) {
        expect(value).toMatchObject({ cacheOwner: null, toolNamespace: null, keyFormat: 'unknown' });
      }
      expect(cache.values.at(-1)).toMatchObject({ cacheOwner: 'plans:get', toolNamespace: 'plans:get',
        keyFormat: 'workspace-nul-tool-pipe' });
      expect(JSON.stringify(report)).not.toMatch(/private-|a{64}/);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('reaches cache values beyond the prefix cap and charges skipped edges to the unchanged work budget', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      const map = new Map(Array.from({ length: 300 }, (_, index) =>
        ['private-workspace\\0coord:inbox|private-payload-' + index, { value: { payload: 'row-' + index } }]));
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['@papercusp/operator-core.operatorCache', { value: { cache: { l1: { map } } } }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const options = { expectedPid: child.pid!, owners: ['@papercusp/operator-core.operatorCache'],
        operatorCacheEntries: true, maxEntries: 512, maxCacheEntries: 8, budgetMs: 200 };
      const page = await readPinnedState(client, { ...options, cacheEntryOffset: 256 });
      expect(page.roots[0].cacheEntries).toMatchObject({ population: 300, scanned: 264, checked: 8,
        selection: { nextOffset: 264, scanComplete: false, selectedNotChecked: 0 } });
      expect(page.roots[0].cacheEntries.values[0]).toMatchObject({ stringCodeUnits: 7,
        keyDigest: createHash('sha256').update('private-workspace\u0000coord:inbox|private-payload-256').digest('hex') });
      const digest = createHash('sha256').update('private-workspace\u0000coord:inbox|private-payload-299').digest('hex');
      const selected = await readPinnedState(client, { ...options, cacheKeyDigests: [digest] });
      expect(selected.roots[0].cacheEntries).toMatchObject({ scanned: 300, checked: 1,
        selection: { unresolvedKeyDigests: [], selectedNotChecked: 0, scanComplete: true } });
      expect(selected.entries).toBe(301);
      expect(selected.roots[0].cacheEntries.values[0].keyDigest).toBe(digest);
      const partial = await readPinnedState(client, { ...options, maxEntries: 12, cacheKeyDigests: [digest] });
      expect(partial.entries).toBe(12);
      expect(partial.roots[0].cacheEntries).toMatchObject({ scanned: 12, checked: 0,
        selection: { unresolvedKeyDigests: [digest], unresolvedAreMissing: false, scanComplete: false } });
      const missing = await readPinnedState(client, { ...options, cacheKeyDigests: ['f'.repeat(64)] });
      expect(missing.roots[0].cacheEntries).toMatchObject({ scanned: 300, checked: 0,
        selection: { unresolvedAreMissing: true, scanComplete: true } });
      const pastEnd = await readPinnedState(client, { ...options, cacheEntryOffset: 300 });
      expect(pastEnd.roots[0].cacheEntries).toMatchObject({ scanned: 0, checked: 0,
        selection: { nextOffset: null, selectedNotChecked: 0 } });
      expect(JSON.stringify([page, selected, partial, missing])).not.toMatch(/private-workspace|private-payload/);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('reserves work for a light later root and selects exact owners independently of registry order', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['fixture.heavy', { value: new Map(Array.from({ length: 100 }, (_, i) => [i, 'heavy'])) }],
        ['fixture.light', { value: { payload: 'later!' } }]
      ]);
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const fair = await readPinnedState(client, { expectedPid: child.pid!, maxEntries: 4, maxObjects: 6, budgetMs: 200 });
      expect(fair.roots[0]).toMatchObject({ owner: 'fixture.heavy', mapEntries: 100, traversalLimited: true });
      expect(fair.roots[1]).toMatchObject({ owner: 'fixture.light', objects: 1, stringCodeUnits: 6, traversalLimited: false });
      expect(fair.entries).toBeLessThanOrEqual(4); expect(fair.objects).toBeLessThanOrEqual(6);
      const selected = await readPinnedState(client, { expectedPid: child.pid!, owners: ['fixture.light'],
        maxSlots: 1, maxEntries: 4, budgetMs: 200 });
      expect(selected).toMatchObject({ population: 2, checked: 1, notChecked: 1, limited: false,
        selection: { requestedOwners: ['fixture.light'], selectedPopulation: 1, missingOwners: [],
          excludedBySelection: 1, selectedNotChecked: 0 } });
      expect(selected.roots).toHaveLength(1);
      expect(selected.roots[0]).toMatchObject({ owner: 'fixture.light', stringCodeUnits: 6, traversalLimited: false });
      const missing = await readPinnedState(client, { expectedPid: child.pid!, owners: ['fixture.absent'] });
      expect(missing).toMatchObject({ checked: 0, selection: { missingOwners: ['fixture.absent'], selectedPopulation: 0 } });
      await expect(readPinnedState(client, { expectedPid: child.pid!, owners: [] })).rejects.toThrow('owners');
      await expect(readPinnedState(client, { expectedPid: child.pid!, owners: ['fixture.light', 'fixture.light'] }))
        .rejects.toThrow('owners');
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);

  it('attributes payloads, discloses caps/shared references, and avoids getters/proxy/iterator effects', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      let effects = 0;
      const shared = Buffer.alloc(19), cache = new Map([['key', 'payload'], ['shared', shared]]);
      cache[Symbol.iterator] = () => { effects++; throw new Error('application iterator'); };
      const root = { cache, rows: ['hello', shared], proxy: new Proxy({}, { ownKeys() { effects++; throw Error('proxy'); } }) };
      Object.defineProperty(root, 'getter', { enumerable: true, get() { effects++; throw Error('getter'); } });
      globalThis[Symbol.for('@papercusp/module-singleton.slots')] = new Map([
        ['fixture.cache', { value: root }], ['fixture.shared', { value: shared }],
        ['fixture.large', { value: new Map(Array.from({length: 20}, (_, i) => [i, 'abc'])) }]
      ]);
      globalThis.effectCount = () => effects;
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      client = createCdpClient(stderr.match(/ws:\/\/[^\s]+/)![0]); await client.connect();
      const methods: string[] = [];
      const observed = { evaluate: async (expression: string, params?: Record<string, unknown>) => {
        methods.push('Runtime.evaluate'); return client!.evaluate(expression, params);
      } };
      const report = await readPinnedState(observed, { expectedPid: child.pid!, budgetMs: 200 });
      expect(report.population).toBe(3); expect(report.checked).toBe(3); expect(report.limited).toBe(false);
      expect(report.roots[0]).toMatchObject({ owner: 'fixture.cache', maps: 1, mapEntries: 2,
        arrays: 1, arrayEntries: 2, stringCodeUnits: 21, byteViewExtents: 19,
        accessorsSkipped: 1, proxiesSkipped: 1, sharedEdges: 1 });
      expect(report.roots[1]).toMatchObject({ owner: 'fixture.shared', byteViewExtents: 0, sharedEdges: 1 });
      expect(report.roots[2]).toMatchObject({ mapEntries: 20, stringCodeUnits: 60 });
      expect(await readPinnedState(observed, { expectedPid: child.pid!, maxSlots: 1, budgetMs: 200 }))
        .toMatchObject({ population: 3, checked: 1, notChecked: 2, limited: true });
      const capped = await readPinnedState(observed, { expectedPid: child.pid!, maxEntries: 1, budgetMs: 200 });
      expect(capped.limited).toBe(true); expect(capped.entries).toBeLessThanOrEqual(1);
      const shallow = await readPinnedState(observed, { expectedPid: child.pid!, maxDepth: 1, budgetMs: 200 });
      expect(shallow.roots[0].depthLimited).toBeGreaterThan(0);
      expect((await client.evaluate('effectCount()', { returnByValue: true })).result.value).toBe(0);
      expect(methods.every(method => method === 'Runtime.evaluate')).toBe(true);
      await expect(readPinnedState(observed, { expectedPid: child.pid! + 1 })).rejects.toThrow('PID mismatch');
      await expect(readPinnedState(observed, { expectedPid: child.pid!, maxEntries: 0 })).rejects.toThrow('limits');
      await client.evaluate("delete globalThis[Symbol.for('@papercusp/module-singleton.slots')]");
      expect(await readPinnedState(observed, { expectedPid: child.pid! })).toMatchObject({ registryPresent: false, population: null });
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await new Promise<void>(resolve => child.once('exit', () => resolve()));
      }
    }
  }, 20_000);
});

describe('bounded function caller attribution on a real Node inspector', () => {
  it('names real compiler callers without pauses and cleans success, partial setup and body failures', async () => {
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', `
      globalThis.compiler = await import('esbuild');
      globalThis.namedBuildCaller = () => compiler.build({ stdin: { contents: 'export const value = 1' }, write: false });
      globalThis.namedTransformCaller = () => compiler.transform('const value = 1', { loader: 'ts' });
      console.log('ready'); setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', client: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    const requests: Array<{ method: string, args?: Record<string, unknown> }> = [];
    let pauses = 0;
    try {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      const endpoint = stderr.match(/ws:\/\/[^\s]+/)?.[0];
      expect(endpoint, stderr).toBeTruthy();
      client = createCdpClient(endpoint!);
      await client.connect();
      const counters = await readProcessMemory(client, { expectedPid: child.pid!, hostFacts: true });
      expect(counters.hostFacts.cluster).toMatchObject({ isPrimary: true, isWorker: false, workerId: null });
      expect(counters.memory.heapUsed).toBeGreaterThan(0);
      expect(await readProcessMemory(client, { expectedPid: child.pid! })).not.toHaveProperty('hostFacts');
      client.ws.on?.('message', data => { if (JSON.parse(String(data)).method === 'Debugger.paused') pauses++; });
      const traced = { evaluate: client.evaluate, send: async (method: string, args?: Record<string, unknown>) => {
        requests.push({ method, args }); return client!.send(method, args);
      } };
      const options = { expectedPid: child.pid!, targets: [
        { name: 'build', expression: 'compiler.build' }, { name: 'transform', expression: 'compiler.transform' },
      ], maxCalls: 3, maxStacks: 2, maxStackChars: 1400, durationMs: 2000 };
      const roots = async () => (await client!.evaluate(
        "Object.keys(globalThis).filter(key => key.startsWith('__papercuspCdpTrace_'))", { returnByValue: true })).result.value;
      const result = await withFunctionCallTrace(traced, options, async () => {
        await client!.evaluate('namedBuildCaller()', { awaitPromise: true });
        for (let i = 0; i < 8; i++) await client!.evaluate('namedTransformCaller()', { awaitPromise: true });
        return 'completed';
      });
      expect(result?.value).toBe('completed');
      expect(result?.trace.pid).toBe(child.pid);
      expect(result?.trace.total).toBe(3);
      expect(result?.trace.limited).toBe(true);
      expect(result?.trace.calls.build.calls).toBe(1);
      expect(result?.trace.calls.transform.calls).toBe(2);
      expect(result?.trace.calls.build.stacks.join('\n')).toContain('namedBuildCaller');
      expect(result?.trace.calls.transform.stacks.join('\n')).toContain('namedTransformCaller');
      for (const observation of Object.values(result.trace.calls)) {
        expect(observation.stacks.length).toBeLessThanOrEqual(2);
        expect(observation.stacks.every(stack => stack.length <= 1400)).toBe(true);
      }
      expect(result?.trace.observerMs).toBeGreaterThanOrEqual(0);
      expect(pauses).toBe(0);
      expect(await roots()).toEqual([]);
      const created = requests.filter(request => request.method === 'Debugger.setBreakpointOnFunctionCall').length;
      expect(requests.filter(request => request.method === 'Debugger.removeBreakpoint')).toHaveLength(created);
      expect(requests.some(request => /stopSampling|collectGarbage|setSkipAllPauses|Debugger.disable/.test(request.method))).toBe(false);
      for (const during of [async () => { throw new Error('body failed'); }, () => new Promise<never>(() => {})]) {
        await expect(withFunctionCallTrace(traced, { ...options, durationMs: 30 }, during)).rejects.toThrow();
        expect(await roots()).toEqual([]);
      }
      await expect(withFunctionCallTrace(traced, { ...options, targets: [options.targets[0]!,
        { name: 'missing', expression: 'undefined' }] }, async () => {})).rejects.toThrow('not a function');
      expect(await roots()).toEqual([]);
      await expect(withFunctionCallTrace(traced, { ...options, expectedPid: child.pid! + 1 }, async () => {})).rejects.toThrow('PID mismatch');
      await expect(withFunctionCallTrace(traced, { ...options, maxCalls: 0 }, async () => {})).rejects.toThrow('maxCalls');
      const cleanupFailureClient = { evaluate: client.evaluate, send: async (method: string, args?: Record<string, unknown>) => {
        const result = await traced.send(method, args);
        if (method === 'Debugger.removeBreakpoint') throw new Error('cleanup receipt failed');
        return result;
      } };
      try {
        await withFunctionCallTrace(cleanupFailureClient, options, async () => { throw new Error('original body failure'); });
        expect.fail('cleanup failure must be reported');
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors.map((item: Error) => item.message)).toContain('original body failure');
        expect((error as AggregateError).errors.map((item: Error) => item.message)).toContain('cleanup receipt failed');
      }
      expect(await roots()).toEqual([]);
      expect(requests.filter(request => request.method === 'Debugger.removeBreakpoint')).toHaveLength(
        requests.filter(request => request.method === 'Debugger.setBreakpointOnFunctionCall').length);
      await client.evaluate('namedTransformCaller()', { awaitPromise: true });
      expect(pauses).toBe(0);
      const releasedGroup = requests.find(request => request.method === 'Runtime.releaseObjectGroup')!.args!.objectGroup;
      const formerObject = requests.find(request => request.method === 'Debugger.setBreakpointOnFunctionCall')!.args!.objectId;
      expect(releasedGroup).toBeTruthy();
      await expect(client.send('Runtime.getProperties', { objectId: formerObject })).rejects.toThrow();
    } finally {
      if (client && child.exitCode === null && child.signalCode === null) {
        await client.evaluate('compiler.stop()').catch(() => {});
      }
      client?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL'); await exited;
      }
      child.stdout.destroy(); child.stderr.destroy();
    }
  }, 20_000);
});

describe('borrowed heap sampling windows', () => {
  const options = { expectedPid: 7, expectedTimeOrigin: 1234, durationMs: 1000 };
  function fixture() {
    const state = { generation: 'owner-1', active: true,
      includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false };
    const frame = { functionName: 'allocation', scriptId: '1', url: 'fixture', lineNumber: 0, columnNumber: 0 };
    const profile = (samples: Array<{ ordinal: number, size: number, nodeId: number }>) =>
      ({ head: { id: 1, callFrame: frame, children: [] }, samples });
    const profiles = [profile([{ ordinal: 41, size: 3000, nodeId: 1 }]),
      profile([{ ordinal: 41, size: 3000, nodeId: 1 }, { ordinal: 42, size: 20, nodeId: 1 }])];
    const client = { evaluate: vi.fn(async () => ({ result: { value: { pid: 7, timeOrigin: 1234 } } })),
      send: vi.fn(async (method: string) => {
        expect(method).toBe('HeapProfiler.getSamplingProfile');
        return { profile: profiles.shift() };
      }) };
    return { client, state, profiles, profile, readSamplerState: async () => ({ ...state }) };
  }

  it('excludes the cumulative baseline without lifecycle calls', async () => {
    const f = fixture();
    const result = await withBorrowedHeapSamples(f.client, { ...options, readSamplerState: f.readSamplerState }, async () => 'done');
    expect(result.value).toBe('done');
    expect(result.sampling).toMatchObject({ ownership: 'borrowed', baselineOrdinal: 41, sampledBytes: 20 });
    expect(result.sampling.samples.map(sample => sample.ordinal)).toEqual([42]);
    expect(result.sampling.definition).toContain('not total allocations');
    expect(f.client.send.mock.calls.map(([method]) => method)).toEqual([
      'HeapProfiler.getSamplingProfile', 'HeapProfiler.getSamplingProfile',
    ]);
  });

  it.each(['generation', 'collected', 'inactive', 'lifetime', 'missing', 'reset', 'malformed'] as const)(
    'refuses %s evidence without changing the sampler', async failure => {
      const f = fixture();
      const body = async () => {
        if (failure === 'generation') f.state.generation = 'owner-2';
        if (failure === 'collected') f.state.includeObjectsCollectedByMajorGC = true;
        if (failure === 'inactive') f.state.active = false;
        if (failure === 'lifetime') f.client.evaluate.mockResolvedValue({ result: { value: { pid: 7, timeOrigin: 9999 } } });
        if (failure === 'missing') f.profiles.splice(0);
        if (failure === 'reset') f.profiles[0] = f.profile([{ ordinal: 1, size: 20, nodeId: 1 }]);
        if (failure === 'malformed') f.profiles[0] = f.profile([{ ordinal: 42, size: -20, nodeId: 1 }]);
      };
      await expect(withBorrowedHeapSamples(f.client, { ...options, readSamplerState: f.readSamplerState }, body)).rejects.toThrow();
      expect(f.client.send.mock.calls.every(([method]) => method === 'HeapProfiler.getSamplingProfile')).toBe(true);
    });

  it('preserves native samples with missing stack nodes as explicit site gaps', async () => {
    const f = fixture();
    f.profiles[1] = f.profile([{ ordinal: 42, size: 20, nodeId: 88 }]);
    const result = await withBorrowedHeapSamples(f.client, { ...options, readSamplerState: f.readSamplerState }, async () => {});
    expect(result.sampling).toMatchObject({ sampledBytes: 20,
      siteCoverage: { baselineMissingNodes: 0, endpointMissingNodes: 1, newMissingNodes: 1 } });
    expect(result.sampling.samples).toEqual([{ ordinal: 42, size: 20, nodeId: 88,
      stack: null, siteStatus: 'unavailable' }]);
  });

  it('allows baseline collection without mistaking it for a reset', async () => {
    const f = fixture();
    f.profiles[1] = f.profile([{ ordinal: 42, size: 20, nodeId: 1 }]);
    const result = await withBorrowedHeapSamples(f.client, { ...options, readSamplerState: f.readSamplerState }, async () => {});
    expect(result.sampling.sampledBytes).toBe(20);
  });

  it('requires owner and lifetime pins before target access', async () => {
    const f = fixture(), body = vi.fn(async () => {});
    for (const invalid of [{ expectedPid: 0 }, { expectedTimeOrigin: NaN },
      { readSamplerState: undefined }, { durationMs: 120001 }, { maxSamples: 0 }]) {
      await expect(withBorrowedHeapSamples(f.client, { ...options, readSamplerState: f.readSamplerState,
        ...invalid } as any, body)).rejects.toThrow();
    }
    expect(f.client.evaluate).not.toHaveBeenCalled();
    expect(f.client.send).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });

  it('aborts at deadline without late profile reads when the body settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void, signal!: AbortSignal;
    const body = new Promise<void>(resolve => { finish = resolve; });
    const pending = expect(withBorrowedHeapSamples(f.client, { ...options, readSamplerState: f.readSamplerState },
      async current => { signal = current; await body; })).rejects.toThrow('deadline');
    try {
      await vi.advanceTimersByTimeAsync(1001); await pending;
      expect(signal.aborted).toBe(true);
      finish(); await vi.advanceTimersByTimeAsync(0);
      expect(f.client.send).toHaveBeenCalledTimes(1);
    } finally { finish(); vi.useRealTimers(); }
  });

  it('preserves a real owner through success, body error, reset and observer detach', async () => {
    const code = [
      "const { Session } = require('node:inspector');",
      "const owner = new Session(); owner.connect(); let generation = 0;",
      "const post = (method, params = {}) => new Promise((resolve, reject) => owner.post(method, params, (error, value) => error ? reject(error) : resolve(value)));",
      "globalThis.startOwner = async () => { await post('HeapProfiler.startSampling', { samplingInterval: 512 }); globalThis.samplerState = { generation: 'real-' + ++generation, active: true, includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false }; };",
      "globalThis.stopOwner = async () => { await post('HeapProfiler.stopSampling'); samplerState.active = false; };",
      "globalThis.ownerProfile = () => post('HeapProfiler.getSamplingProfile');",
      "globalThis.keep = [];",
      "globalThis.beforeWindow = () => keep.push(Array.from({ length: 20000 }, (_, i) => ({ before: i })));",
      "globalThis.duringWindow = () => keep.push(Array.from({ length: 20000 }, (_, i) => ({ during: i })));",
      "startOwner().then(() => { beforeWindow(); console.log('ready'); }); setInterval(() => {}, 1000);",
    ].join('\n');
    const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '', observer: ReturnType<typeof createCdpClient> | undefined;
    let witness: ReturnType<typeof createCdpClient> | undefined;
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    try {
      const deadline = Date.now() + 10000;
      while (!stdout.includes('ready') && Date.now() < deadline && child.exitCode === null) await sleep(20);
      expect(stdout, stderr).toContain('ready');
      const endpoint = stderr.match(/ws:\/\/[^\s]+/)![0];
      observer = createCdpClient(endpoint); witness = createCdpClient(endpoint);
      await observer.connect(); await witness.connect();
      const read = async (expression: string) => (await witness!.evaluate(expression,
        { returnByValue: true, awaitPromise: true })).result.value;
      const pinned = { expectedPid: child.pid!, expectedTimeOrigin: await read('performance.timeOrigin'),
        readSamplerState: () => read('samplerState'), durationMs: 10000 };
      const methods: string[] = [];
      const client = { evaluate: observer.evaluate, send: async (method: string) => {
        methods.push(method); return observer!.send(method);
      } };
      const result = await withBorrowedHeapSamples(client, pinned, async () => {
        await read('duringWindow()'); return 'real';
      });
      expect(result.value).toBe('real');
      expect(result.sampling.sampledBytes).toBeGreaterThan(0);
      expect(result.sampling.samples.some(sample => sample.stack?.includes('duringWindow'))).toBe(true);
      expect(result.sampling.samples.some(sample => sample.stack?.includes('beforeWindow'))).toBe(false);
      expect(result.sampling.samples.every(sample => sample.ordinal > result.sampling.baselineOrdinal)).toBe(true);
      await expect(withBorrowedHeapSamples(client, pinned, async () => { throw new Error('body failed'); }))
        .rejects.toThrow('body failed');
      expect((await read('ownerProfile()')).profile.samples.length).toBeGreaterThan(0);
      await expect(withBorrowedHeapSamples(client, pinned, async () => {
        await read('stopOwner().then(() => startOwner())');
      })).rejects.toThrow('generation changed');
      await expect(withBorrowedHeapSamples(client, pinned, async () => { observer!.close(); }))
        .rejects.toThrow('closed');
      expect((await read('ownerProfile()')).profile.samples.length).toBeGreaterThan(0);
      expect(methods.every(method => method === 'HeapProfiler.getSamplingProfile')).toBe(true);
      await read('stopOwner()');
    } finally {
      observer?.close(); witness?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL'); await exited;
      }
      child.stdout.destroy(); child.stderr.destroy();
    }
  }, 30000);
});

describe('CDP inspector seam', () => {
  it('redacts credentials, query strings, and fragments from diagnostic URLs', () => {
    const redacted = redactDiagnosticUrl(
      'wss://user:password@example.test:9229/devtools/page/id?access_token=short-lived&safe=yes#fragment',
    );

    expect(redacted).toBe('wss://example.test:9229/devtools/page/id');
    expect(redacted).not.toContain('access_token');
    expect(redacted).not.toContain('short-lived');
    expect(redacted).not.toContain('password');
  });

  it('does not echo an unparseable diagnostic URL', () => {
    expect(redactDiagnosticUrl('not a URL with token=secret')).toBe('<unparseable-url>');
  });

  it('surfaces Runtime.evaluate exceptionDetails as a failure', async () => {
    const client = makeClient(new Map([
      ['Runtime.evaluate', {
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: dynamic import is unavailable' },
        },
      }],
    ]));
    await client.connect();

    await expect(client.evaluate('await import("node:inspector")'))
      .rejects.toMatchObject({
        name: 'CdpEvaluationError',
        message: expect.stringContaining('dynamic import is unavailable'),
      });
  });

  it('verifies the inspector port after the expected close-transport loss', async () => {
    const client = makeClient(new Map([['Runtime.evaluate', 'close']]));
    await client.connect();
    const urls: string[] = [];

    await expect(closeInspector(client, 9229, {
      fetchImpl: async (url: string) => {
        urls.push(url);
        throw new Error('ECONNREFUSED');
      },
      sleepImpl: async () => {},
      verifyTimeoutMs: 20,
      pollIntervalMs: 0,
    })).resolves.toEqual({ closed: true });

    expect(urls).toEqual(['http://127.0.0.1:9229/json/list']);
    expect(client.ws.closed).toBe(true);
  });

  it('rejects when the WebSocket closes but /json/list still responds', async () => {
    const client = makeClient(new Map([['Runtime.evaluate', 'close']]));
    await client.connect();

    await expect(closeInspector(client, 9229, {
      fetchImpl: async () => ({ ok: true, json: async () => [] }),
      sleepImpl: async () => {},
      verifyTimeoutMs: 0,
      pollIntervalMs: 0,
    })).rejects.toThrow('inspector still open on port 9229');
  });
});
