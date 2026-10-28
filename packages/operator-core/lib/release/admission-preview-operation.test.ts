import { describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_PREVIEW_SETTLED_EVENT_PREFIX,
  boundAdmissionPreviewVerdict,
  deferredAdmissionPreviewPayload,
  describeAdmissionPreviewOperation,
  parseAdmissionPreviewOperation,
  runAdmissionPreviewOperation,
  type AdmissionPreviewOperation,
  type AdmissionPreviewStore,
} from './admission-preview-operation';

function memoryStore(opts: { putDelayMs?: number; failPut?: boolean } = {}) {
  const records = new Map<string, AdmissionPreviewOperation>();
  const puts: AdmissionPreviewOperation[] = [];
  const store: AdmissionPreviewStore = {
    async put(operation) {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs));
      if (opts.failPut) throw new Error('store down');
      puts.push(operation);
      records.set(operation.operationId, JSON.parse(JSON.stringify(operation)) as AdmissionPreviewOperation);
    },
    async get(operationId) {
      return records.get(operationId) ?? null;
    },
  };
  return { store, puts, records };
}

const later = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

describe('runAdmissionPreviewOperation (R-1)', () => {
  it('returns a handle within the inline budget when the preview is slow, then settles the verdict into the store and emits', async () => {
    const { store, puts } = memoryStore();
    const emitted: AdmissionPreviewOperation[] = [];
    const startedAt = Date.now();
    const outcome = await runAdmissionPreviewOperation({
      run: () => later(250, { verdict: 'pass', judgedSha: 'abc123', admitted: false }),
      store,
      emitSettled: async (op) => { emitted.push(op); },
      paths: ['a.ts', 'b.ts'],
      inlineBudgetMs: 30,
    });
    const elapsed = Date.now() - startedAt;

    expect(outcome.mode).toBe('deferred');
    if (outcome.mode !== 'deferred') return;
    expect(elapsed).toBeLessThan(200); // the call did not wait for the 250 ms preview
    expect(outcome.operation.operationId).toMatch(/^arp-/);
    expect(outcome.operation.status).toBe('running');
    expect(outcome.persisted).toBe(true);
    expect((await store.get(outcome.operation.operationId))?.status).toBe('running');
    expect(emitted).toHaveLength(0);

    const final = await outcome.settlement;
    expect(final.status).toBe('settled');
    const stored = await store.get(outcome.operation.operationId);
    expect(stored?.status).toBe('settled');
    expect(stored?.verdict).toEqual({ verdict: 'pass', judgedSha: 'abc123', admitted: false });
    expect(stored?.paths).toEqual(['a.ts', 'b.ts']);
    expect(puts.map((p) => p.status)).toEqual(['running', 'settled']);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].operationId).toBe(outcome.operation.operationId);

    const payload = deferredAdmissionPreviewPayload(outcome, 30, outcome.operation.startedAtMs);
    expect(payload.previewOperation).toMatchObject({
      operationId: outcome.operation.operationId,
      settleEvent: `${ADMISSION_PREVIEW_SETTLED_EVENT_PREFIX}${outcome.operation.operationId}`,
    });
    // G-6: the handed-out await is bounded to the preview lifetime and wakes on timeout.
    const lifetimeSec = Math.ceil((outcome.operation.expiresAtMs - outcome.operation.startedAtMs) / 1000);
    expect(payload.awaitArgs).toEqual({
      event: `${ADMISSION_PREVIEW_SETTLED_EVENT_PREFIX}${outcome.operation.operationId}`,
      timeout_sec: lifetimeSec + 30,
      on_timeout: 'wake',
    });
    expect(payload.nextAction).toEqual({
      tool: 'release:repair-queue',
      args: { op: 'get', previewOperationId: outcome.operation.operationId },
    });
  });

  it('returns a fast preview inline with no store write and no event', async () => {
    const { store, puts } = memoryStore();
    const emitSettled = vi.fn(async () => {});
    const outcome = await runAdmissionPreviewOperation({
      run: () => later(5, { verdict: 'pass' }),
      store,
      emitSettled,
      paths: ['a.ts'],
      inlineBudgetMs: 500,
    });
    expect(outcome).toEqual({ mode: 'inline', result: { verdict: 'pass' } });
    expect(puts).toHaveLength(0);
    expect(emitSettled).not.toHaveBeenCalled();
  });

  it('rethrows a fast failure inline, as before', async () => {
    const { store, puts } = memoryStore();
    await expect(
      runAdmissionPreviewOperation({
        run: async () => { throw new Error('boom'); },
        store,
        emitSettled: async () => {},
        paths: ['a.ts'],
        inlineBudgetMs: 500,
      }),
    ).rejects.toThrow('boom');
    expect(puts).toHaveLength(0);
  });

  it('settles a slow failure as failed with its message and still emits', async () => {
    const { store } = memoryStore();
    const emitted: AdmissionPreviewOperation[] = [];
    const outcome = await runAdmissionPreviewOperation({
      run: () => later(80, null).then(() => { throw new Error('worker died'); }),
      store,
      emitSettled: async (op) => { emitted.push(op); },
      paths: ['a.ts'],
      inlineBudgetMs: 20,
    });
    if (outcome.mode !== 'deferred') throw new Error('expected deferral');
    await outcome.settlement;
    const stored = await store.get(outcome.operation.operationId);
    expect(stored).toMatchObject({ status: 'failed', error: 'worker died', verdict: null });
    expect(emitted.map((e) => e.status)).toEqual(['failed']);
  });

  it('never lets the running write overwrite a settle that finished while it was in flight', async () => {
    const { store, puts } = memoryStore({ putDelayMs: 60 });
    const outcome = await runAdmissionPreviewOperation({
      run: () => later(30, { verdict: 'pass' }),
      store,
      emitSettled: async () => {},
      paths: ['a.ts'],
      inlineBudgetMs: 10,
    });
    if (outcome.mode !== 'deferred') throw new Error('expected deferral');
    await outcome.settlement;
    expect(puts.map((p) => p.status)).toEqual(['running', 'settled']);
    expect((await store.get(outcome.operation.operationId))?.status).toBe('settled');
  });

  it('still returns the handle (persisted:false) when the running write fails', async () => {
    const { store } = memoryStore({ failPut: true });
    const errors: string[] = [];
    const outcome = await runAdmissionPreviewOperation({
      run: () => later(40, { verdict: 'pass' }),
      store,
      emitSettled: async () => {},
      paths: ['a.ts'],
      inlineBudgetMs: 10,
      onBackgroundError: (_e, stage) => { errors.push(stage); },
    });
    if (outcome.mode !== 'deferred') throw new Error('expected deferral');
    expect(outcome.persisted).toBe(false);
    expect(outcome.persistError).toBe('store down');
    await outcome.settlement;
    expect(errors).toEqual(['store']);
  });

  it('refuses an inline budget at or over 60 s', async () => {
    const { store } = memoryStore();
    await expect(
      runAdmissionPreviewOperation({ run: async () => 1, store, emitSettled: async () => {}, paths: [], inlineBudgetMs: 60_000 }),
    ).rejects.toThrow(RangeError);
  });
});

describe('boundAdmissionPreviewVerdict', () => {
  it('keeps a small verdict whole and shrinks a large one to its scalar decision fields', () => {
    expect(boundAdmissionPreviewVerdict({ verdict: 'pass' })).toEqual({ verdict: { verdict: 'pass' }, verdictTruncated: false });
    const big = { verdict: 'refused', reason: 'admission-incomplete', judgedSha: 'abc', proof: { blob: 'x'.repeat(5_000) } };
    const bounded = boundAdmissionPreviewVerdict(big, 1_000);
    expect(bounded.verdictTruncated).toBe(true);
    expect(bounded.verdict).toMatchObject({
      verdict: 'refused',
      reason: 'admission-incomplete',
      judgedSha: 'abc',
      _truncated: { omittedKeys: ['proof'] },
    });
  });
});

describe('describeAdmissionPreviewOperation (op:get read)', () => {
  const base: AdmissionPreviewOperation = {
    schemaVersion: 1,
    operationId: 'arp-1',
    status: 'running',
    startedAtMs: 1_000,
    expiresAtMs: 2_000,
    settledAtMs: null,
    paths: ['a.ts'],
    verdict: null,
    verdictTruncated: false,
    error: null,
  };

  it('reports a running record past its expiry as expired', () => {
    expect(describeAdmissionPreviewOperation(base, { nowMs: 1_500, currentRepairHead: 'h' }).status).toBe('running');
    expect(describeAdmissionPreviewOperation(base, { nowMs: 2_500, currentRepairHead: 'h' }).status).toBe('expired');
  });

  it('bounds the await for a running preview so a restart mid-preview cannot strand the awaiter (blind review G-6)', () => {
    const read = describeAdmissionPreviewOperation(
      { ...base, expiresAtMs: 1_000 + 15 * 60_000 },
      { nowMs: 1_000 + 5 * 60_000, currentRepairHead: 'h' },
    );
    expect(read.status).toBe('running');
    // 10 minutes of lifetime left plus a 30 s margin, and the await wakes on timeout.
    expect(read.awaitArgs).toEqual({
      event: `${ADMISSION_PREVIEW_SETTLED_EVENT_PREFIX}arp-1`,
      timeout_sec: 630,
      on_timeout: 'wake',
    });
    expect(read.nextAction).toContain("timeout_sec: 630, on_timeout: 'wake'");
    expect(read.nextAction).toContain('then re-read this op:get');
    // Past expiry the read reports expired and offers no await at all.
    const expired = describeAdmissionPreviewOperation(base, { nowMs: 2_500, currentRepairHead: 'h' });
    expect(expired.awaitArgs).toBeNull();
    expect(expired.nextAction).toContain('Re-run the dry run');
  });

  it('flags a settled verdict whose judged head is no longer the repair head', () => {
    const settled = { ...base, status: 'settled' as const, settledAtMs: 1_800, verdict: { verdict: 'pass', judgedSha: 'old' } };
    expect(describeAdmissionPreviewOperation(settled, { nowMs: 3_000, currentRepairHead: 'old' })).toMatchObject({
      status: 'settled',
      judgedSha: 'old',
      stale: false,
    });
    expect(describeAdmissionPreviewOperation(settled, { nowMs: 3_000, currentRepairHead: 'new' }).stale).toBe(true);
  });

  it('parses a stored record fail-soft', () => {
    expect(parseAdmissionPreviewOperation(base)).toEqual(base);
    expect(parseAdmissionPreviewOperation({ operationId: 'x' })).toBeNull();
    expect(parseAdmissionPreviewOperation(null)).toBeNull();
  });
});
