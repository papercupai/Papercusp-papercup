import { afterEach, describe, expect, it, vi } from 'vitest';
import { LspAdmissionController, lspAdmissionClass, runLspAdmission, type LspAdmissionContext, type LspAdmissionReceipt } from './lsp-admission';

vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  readConditionEnvelopes: async () => [], computeConditionStates: () => [],
}));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: async () => true }));

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const context = (id: string, extra: Partial<LspAdmissionContext> = {}): LspAdmissionContext => ({
  workspaceId: 'test-lsp', requestId: id, language: 'typescript', projectRoot: '/repo', op: 'references',
  actor: 'a', deadlineAtMs: Date.now() + 60_000, ...extra,
});
const receipt = (): LspAdmissionReceipt => ({ start: vi.fn(async () => {}), finish: vi.fn(async () => {}), cancel: vi.fn(async () => {}) });
afterEach(() => { vi.useRealTimers(); });

describe('LSP class admission', () => {
  it('awaits scoped health condition delivery before returning a completed service result', async () => {
    let now = 1_700_000_000_000;
    const hold = deferred();
    const broadcast = vi.fn(async (_event: { conditionKey?: string; oneShot?: boolean }) => { await hold.promise; return true; });
    const controller = new LspAdmissionController({ now: () => now, enqueue: async () => receipt(),
      healthConditions: { rail: { broadcast }, readOpenConditions: async () => [] } });
    const input = (id: string) => context(id, { deadlineAtMs: now + 10_000 });
    for (let i = 0; i < 4; i++) await controller.run(input(`healthy-${i}`), async () => { now += 5; return 'ok'; });
    let returned = false;
    const result = controller.run(input('slow'), async () => { now += 500; return 'slow'; })
      .then(value => { returned = true; return value; });
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    expect(broadcast.mock.calls[0]?.[0]).toMatchObject({ oneShot: true,
      conditionKey: expect.stringContaining('alarm:resource-health:') });
    hold.resolve(); await expect(result).resolves.toBe('slow');
  });
  it('keeps definitions and different symbol costs independent of a blocked scan', async () => {
    const persisted = receipt();
    const enqueue = vi.fn(async () => persisted);
    const controller = new LspAdmissionController({ enqueue });
    const scan = deferred();
    const first = controller.run(context('scan', { symbolCost: 'scan' }), () => scan.promise);
    const secondTask = vi.fn(async () => 'second');
    const second = controller.run(context('queued-scan', { symbolCost: 'scan' }), secondTask);
    await flush();
    await expect(controller.run(context('definition', { op: 'symbol' }), async () => 'cheap')).resolves.toBe('cheap');
    await expect(controller.run(context('index-hit', { symbolCost: 'index-hit' }), async () => 'index-hit')).resolves.toBe('index-hit');
    expect(secondTask).not.toHaveBeenCalled();
    expect(controller.snapshot().classes.find(c => c.classKey === lspAdmissionClass(context('x', { symbolCost: 'scan' })))?.queued).toBe(1);
    scan.resolve();
    await first; await expect(second).resolves.toBe('second');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(persisted.start).toHaveBeenCalledTimes(1);
    expect(persisted.finish).toHaveBeenCalledTimes(1);
  });

  it('serves another agent before the first agents backlog and respects priority', async () => {
    const controller = new LspAdmissionController({ enqueue: async () => receipt(), controller: { healthySamplesPerIncrease: 100 } });
    const hold = deferred();
    const first = controller.run(context('first'), () => hold.promise);
    const order: string[] = [];
    const submit = (id: string, actor: string, priority = 0) => controller.run(context(id, { actor, priority }), async () => { order.push(id); });
    const a1 = submit('a1', 'a'); const a2 = submit('a2', 'a'); const b1 = submit('b1', 'b');
    const urgent = submit('urgent', 'a', 10);
    await flush(); hold.resolve();
    await Promise.all([first, a1, a2, b1, urgent]);
    expect(order).toEqual(['urgent', 'b1', 'a1', 'a2']);
  });

  it('expires queued requests without executing them and cancels their durable receipt', async () => {
    vi.useFakeTimers();
    const queuedReceipt = receipt();
    const controller = new LspAdmissionController({ enqueue: async () => queuedReceipt });
    const hold = deferred();
    const first = controller.run(context('first'), () => hold.promise);
    const task = vi.fn(async () => 'late');
    const queued = controller.run(context('queued', { deadlineAtMs: Date.now() + 20 }), task);
    const rejected = expect(queued).rejects.toMatchObject({ code: 'deadline' });
    await flush(); await vi.advanceTimersByTimeAsync(20); await rejected;
    expect(task).not.toHaveBeenCalled();
    expect(queuedReceipt.cancel).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().classes[0].queued).toBe(0);
    hold.resolve(); await first;
  });

  it('retains occupied capacity after cancellation until the wire task actually settles', async () => {
    const controller = new LspAdmissionController({ enqueue: async () => receipt(), controller: { healthySamplesPerIncrease: 100 } });
    const abort = new AbortController(); const hold = deferred();
    const first = controller.run(context('first', { signal: abort.signal }), () => hold.promise);
    const rejected = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    const task = vi.fn(async () => 'next');
    const next = controller.run(context('next'), task);
    await flush(); abort.abort(); await rejected; await flush();
    expect(task).not.toHaveBeenCalled(); expect(controller.snapshot().classes[0].inFlight).toBe(1);
    hold.resolve(); await expect(next).resolves.toBe('next');
  });

  it('cancels a receipt materialized after the caller abandoned persistence', async () => {
    const saving = deferred<LspAdmissionReceipt>(); const persisted = receipt();
    const controller = new LspAdmissionController({ enqueue: () => saving.promise });
    const hold = deferred(); const first = controller.run(context('first'), () => hold.promise);
    const abort = new AbortController(); const task = vi.fn(async () => {});
    const queued = controller.run(context('queued', { signal: abort.signal }), task);
    const rejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    abort.abort(); await rejected; saving.resolve(persisted); await flush();
    expect(persisted.cancel).toHaveBeenCalledTimes(1); expect(task).not.toHaveBeenCalled();
    hold.resolve(); await first;
  });

  it('refuses failed pressure persistence and resumes unbounded upward probes after clean work', async () => {
    const controller = new LspAdmissionController({ enqueue: async () => { throw new Error('store unavailable'); }, controller: { healthySamplesPerIncrease: 1 } });
    const hold = deferred(); const first = controller.run(context('first'), () => hold.promise);
    const task = vi.fn(async () => {});
    await expect(controller.run(context('queued'), task)).rejects.toMatchObject({ code: 'persistence' });
    expect(task).not.toHaveBeenCalled(); hold.resolve(); await first;
    for (let i = 0; i < 12; i++) await controller.run(context(`probe-${i}`), async () => {});
    expect(controller.snapshot().classes[0].desiredWindow).toBeGreaterThan(12);
  });

  it('returns an explicit degraded deadline answer rather than a certified empty', async () => {
    const task = vi.fn();
    const answer = await runLspAdmission(context('expired', { deadlineAtMs: Date.now() - 1,
      query: '/repo/source.ts', queryKey: 'sha256:cost-identity' }), task);
    expect(answer.freshness.health).toBe('degraded'); expect(answer.error).toContain('deadline');
    expect(answer.query).toBe('/repo/source.ts');
    expect(answer.truncation.totalAvailable).toBeNull(); expect(task).not.toHaveBeenCalled();
  });

  it('learns recent query cost from wire service time and expires or invalidates failed observations', async () => {
    let now = Date.now();
    const controller = new LspAdmissionController({ enqueue: async () => receipt(), now: () => now,
      indexHitMaxMs: 25, costObservationTtlMs: 100 });
    const cheap = context('cheap', { queryKey: 'file:1:4@revision-a' });
    expect(controller.classify(cheap).symbolCost).toBe('unknown');
    await controller.run(cheap, async () => { now += 5; });
    expect(controller.classify(cheap).symbolCost).toBe('index-hit');
    const scan = context('scan', { queryKey: 'file:20:4@revision-a' });
    await controller.run(scan, async () => { now += 50; });
    expect(controller.classify(scan).symbolCost).toBe('scan');
    expect(controller.classify({ ...cheap, queryKey: 'file:1:4@revision-b' }).symbolCost).toBe('unknown');
    await controller.run({ ...cheap, requestId: 'refused' }, async () => ({ freshness: { health: 'degraded' }, error: 'loading' }));
    expect(controller.classify(cheap).symbolCost).toBe('unknown');
    now += 101;
    expect(controller.classify(scan).symbolCost).toBe('unknown');
  });

  it('holds windows on degraded answers and contracts only the measured service class', async () => {
    let now = Date.now();
    const controller = new LspAdmissionController({ enqueue: async () => receipt(), now: () => now,
      controller: { initialWindow: 8, healthySamplesPerIncrease: 100 } });
    const scan = context('scan', { symbolCost: 'scan' });
    for (let i = 0; i < 4; i++) await controller.run({ ...scan, requestId: `baseline-${i}` }, async () => { now += 10; });
    await controller.run(context('definition', { op: 'symbol' }), async () => {});
    await controller.run({ ...scan, requestId: 'slow' }, async () => { now += 100; });
    const pressured = controller.snapshot().classes.find(c => c.classKey === lspAdmissionClass(scan))!;
    expect(pressured.desiredWindow).toBeLessThan(8);
    expect(pressured.health).toMatchObject({ scopeId: lspAdmissionClass(scan), state: 'degraded', actionable: true });
    expect(controller.snapshot().classes.find(c => c.classKey !== pressured.classKey)?.desiredWindow).toBe(8);
    controller.observeHealth(pressured.classKey, { ...pressured.health!, scopeId: 'host-global' });
    expect(controller.snapshot().classes.find(c => c.classKey === pressured.classKey)?.desiredWindow).toBe(pressured.desiredWindow);
    const refused = new LspAdmissionController({ enqueue: async () => receipt(), controller: { healthySamplesPerIncrease: 1 } });
    for (let i = 0; i < 4; i++) await refused.run(context(`refused-${i}`), async () => ({ freshness: { health: 'degraded' }, error: 'not ready' }));
    expect(refused.snapshot().classes[0].desiredWindow).toBe(1);
  });

  it('reports failed cancellation of a late durable receipt in readback', async () => {
    const saving = deferred<LspAdmissionReceipt>();
    const controller = new LspAdmissionController({ enqueue: () => saving.promise });
    const hold = deferred(); const first = controller.run(context('first'), () => hold.promise);
    const abort = new AbortController();
    const queued = controller.run(context('queued', { signal: abort.signal }), async () => {});
    const rejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    abort.abort(); await rejected;
    saving.resolve({ ...receipt(), cancel: async () => { throw new Error('DB settlement unavailable'); } });
    await flush();
    expect(controller.snapshot().settlementFailures).toEqual([{ requestId: 'queued', error: 'DB settlement unavailable' }]);
    hold.resolve(); await first;
  });

  it('ages batch work past later urgent arrivals without resetting the other actors debt', async () => {
    let now = Date.now();
    const controller = new LspAdmissionController({ enqueue: async () => receipt(), now: () => now,
      agingIntervalMs: 10, controller: { healthySamplesPerIncrease: 100 } });
    const hold = deferred(); const first = controller.run(context('first'), () => hold.promise);
    const order: string[] = [];
    const batch = controller.run(context('batch', { actor: 'b', priority: 0 }), async () => { order.push('batch'); });
    now += 100;
    const urgent = controller.run(context('urgent', { priority: 5 }), async () => { order.push('urgent'); });
    await flush(); hold.resolve(); await Promise.all([first, batch, urgent]);
    expect(order).toEqual(['batch', 'urgent']);
  });

  it('honors absolute deadlines beyond the native timer range', async () => {
    vi.useFakeTimers();
    const controller = new LspAdmissionController({ enqueue: async () => receipt() });
    const hold = deferred();
    const deadlineAtMs = Date.now() + 2_147_483_647 + 100;
    const first = controller.run(context('long', { deadlineAtMs }), () => hold.promise);
    const rejected = expect(first).rejects.toMatchObject({ code: 'deadline' });
    await flush();
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(controller.snapshot().classes[0].health).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(controller.snapshot().inFlight).toBe(1);
    hold.resolve(); await flush();
    expect(controller.snapshot().inFlight).toBe(0);
  });

  it('expires measured cost metadata during readback even with no new requests', async () => {
    let now = Date.now();
    const controller = new LspAdmissionController({ enqueue: async () => receipt(), now: () => now, costObservationTtlMs: 100 });
    await controller.run(context('cost', { queryKey: 'cursor@revision' }), async () => {});
    expect(controller.snapshot().costObservations).toBe(1);
    now += 100;
    expect(controller.snapshot().costObservations).toBe(0);
  });

  it('reconciles a failed late cancellation after the receipt store recovers', async () => {
    vi.useFakeTimers();
    const saving = deferred<LspAdmissionReceipt>();
    const controller = new LspAdmissionController({ enqueue: () => saving.promise });
    const hold = deferred(); const first = controller.run(context('first'), () => hold.promise);
    const abort = new AbortController();
    const queued = controller.run(context('queued-recovery', { signal: abort.signal }), async () => {});
    const rejected = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    abort.abort(); await rejected;
    const cancel = vi.fn().mockRejectedValueOnce(new Error('store unavailable')).mockResolvedValue(undefined);
    saving.resolve({ ...receipt(), cancel }); await flush();
    expect(controller.snapshot().assessment).toBe('settlement-failed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().settlementFailures).toEqual([]);
    hold.resolve(); await first;
  });
});
