/**
 * fallback-observations — unit tests for the window summariser, input
 * validation and the batched best-effort writer
 * (degradation-signals-on-condition-rail-2026-10-11 P-002, BAR R-1).
 * The cross-process read-back against real Postgres lives in
 * fallback-observations.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached when an explicit sql handle is passed');
  },
}));

const mod = await import('./fallback-observations');
const {
  FALLBACK_BUFFER_MAX,
  FALLBACK_COALESCE_SPAN_MS,
  FALLBACK_FLUSH_BATCH,
  fallbackDecisionProblem,
  fallbackObservationCounters,
  flushFallbackObservations,
  observeFallback,
  summarizeFallbackWindow,
  _pendingFallbackObservationCount,
  _resetFallbackObservationsForTests,
} = mod;

interface FakeSql {
  sql: Sql;
  inserts: Array<Array<Record<string, unknown>>>;
  fail: { next: boolean };
}

/** A postgres-js lookalike: `sql(rows, ...cols)` builds a values marker; a tagged call "executes". */
function fakeSql(): FakeSql {
  const inserts: Array<Array<Record<string, unknown>>> = [];
  const fail = { next: false };
  const fn = (first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && 'raw' in (first as object)) {
      if (fail.next) {
        fail.next = false;
        return Promise.reject(new Error('simulated write failure'));
      }
      const marker = rest.find((v) => v && typeof v === 'object' && (v as { __values?: unknown }).__values);
      if (marker) inserts.push((marker as { __values: Array<Record<string, unknown>> }).__values);
      return Promise.resolve(Object.assign([], { count: 0 }));
    }
    return { __values: first as Array<Record<string, unknown>>, __cols: rest };
  };
  return { sql: fn as unknown as Sql, inserts, fail };
}

beforeEach(() => {
  _resetFallbackObservationsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  _resetFallbackObservationsForTests();
  vi.restoreAllMocks();
});

describe('coalescing identical decisions (WI-6554700010009713)', () => {
  it('does not merge unknown and measured-empty populations with the same reason', async () => {
    const f = fakeSql();
    const decision = { eligible: 0, applied: 0, reason: 'dirty-checkout', scope: 'task' };
    observeFallback('gate-pass-reuse', { ...decision, populationKnown: false }, { sql: f.sql });
    observeFallback('gate-pass-reuse', { ...decision, populationKnown: false }, { sql: f.sql });
    observeFallback('gate-pass-reuse', { ...decision, populationKnown: true }, { sql: f.sql });
    expect(await flushFallbackObservations()).toMatchObject({ written: 2, failed: 0 });
    expect(f.inserts.flat()).toEqual([
      expect.objectContaining({ eligible: 0, applied: 0, population_known: false, samples: 2 }),
      expect.objectContaining({ eligible: 0, applied: 0, population_known: true, samples: 1 }),
    ]);
  });

  it('folds identical decisions into ONE row whose counts are the sums', async () => {
    const f = fakeSql();
    for (let i = 0; i < 3; i++) {
      observeFallback('cache-l2-operation', { eligible: 2, applied: 1, reason: 'applied', scope: 'get' }, { sql: f.sql });
    }
    expect(_pendingFallbackObservationCount()).toBe(1);
    expect(fallbackObservationCounters().coalesced).toBe(2);
    expect(await flushFallbackObservations()).toMatchObject({ written: 1, failed: 0 });
    expect(f.inserts.flat()).toEqual([
      expect.objectContaining({ mechanism: 'cache-l2-operation', reason: 'applied', scope: 'get', eligible: 6, applied: 3, samples: 3 }),
    ]);
  });

  it('keeps rows apart when any key field or the handle differs, and never folds a correlated decision', async () => {
    const f = fakeSql();
    const g = fakeSql();
    const base = { eligible: 1, applied: 1, reason: 'applied', scope: 'get' };
    const id = '64eab084-4e87-4e2b-99bd-3be2eb7c191f';
    observeFallback('m', base, { sql: f.sql });
    observeFallback('m2', base, { sql: f.sql });
    observeFallback('m', { ...base, reason: 'other' }, { sql: f.sql });
    observeFallback('m', { ...base, scope: 'set' }, { sql: f.sql });
    observeFallback('m', base, { sql: f.sql, processTag: 'p' });
    observeFallback('m', base, { sql: f.sql, workspaceId: 'ws-coalesce-b' });
    observeFallback('m', base, { sql: f.sql, correlationId: id });
    observeFallback('m', base, { sql: f.sql, correlationId: id });
    observeFallback('m', base, { sql: g.sql });
    expect(_pendingFallbackObservationCount()).toBe(9);
    expect(fallbackObservationCounters().coalesced).toBe(0);
    await flushFallbackObservations();
    expect(f.inserts.flat()).toHaveLength(8);
    expect(g.inserts.flat()).toHaveLength(1);
    expect([...f.inserts.flat(), ...g.inserts.flat()].every((r) => r.samples === 1)).toBe(true);
  });

  it('starts a new row once event times are further apart than the coalesce span', async () => {
    const f = fakeSql();
    const t0 = new Date('2026-10-13T00:00:00Z').getTime();
    const d = { eligible: 1, applied: 0, reason: 'backend-error', scope: 'get' };
    observeFallback('m', d, { sql: f.sql, observedAt: new Date(t0) });
    observeFallback('m', d, { sql: f.sql, observedAt: new Date(t0 + FALLBACK_COALESCE_SPAN_MS) });
    observeFallback('m', d, { sql: f.sql, observedAt: new Date(t0 + FALLBACK_COALESCE_SPAN_MS + 1) });
    expect(_pendingFallbackObservationCount()).toBe(2);
    await flushFallbackObservations();
    expect(f.inserts.flat().map((r) => r.samples)).toEqual([2, 1]);
  });

  it('never folds into a row that a flush has already taken (the fold would be lost)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const written: Array<Record<string, unknown>> = [];
    const sql = ((first: unknown, ...rest: unknown[]) => {
      if (Array.isArray(first) && 'raw' in (first as object)) {
        const m = rest.find((v) => v && typeof v === 'object' && (v as { __values?: unknown }).__values) as
          | { __values: Array<Record<string, unknown>> }
          | undefined;
        if (m) written.push(...m.__values);
        return gate.then(() => Object.assign([], { count: 0 }));
      }
      return { __values: first, __cols: rest };
    }) as unknown as Sql;
    const d = { eligible: 1, applied: 1, reason: 'applied' };
    observeFallback('m', d, { sql });
    const flushing = flushFallbackObservations();
    observeFallback('m', d, { sql });
    expect(_pendingFallbackObservationCount()).toBe(1);
    release();
    await flushing;
    await flushFallbackObservations();
    expect(written.map((r) => r.samples)).toEqual([1, 1]);
  });

  it('drains unbound rows enqueued during an explicit flush and preserves row handles', async () => {
    const rowOwned = fakeSql();
    const explicit = fakeSql();
    let releaseFirstWrite!: () => void;
    let signalFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const firstWriteStarted = new Promise<void>((resolve) => { signalFirstWrite = resolve; });
    let firstWriteBlocked = false;
    const rowSql = ((first: unknown, ...rest: unknown[]) => {
      const args = [first, ...rest];
      if (Array.isArray(first) && 'raw' in first && !firstWriteBlocked) {
        firstWriteBlocked = true;
        signalFirstWrite();
        return firstWriteGate.then(() => Reflect.apply(rowOwned.sql, rowOwned.sql, args));
      }
      return Reflect.apply(rowOwned.sql, rowOwned.sql, args);
    }) as unknown as Sql;

    try {
      observeFallback('explicit-flush-race', {
        eligible: 1, applied: 0, reason: 'row-owned', scope: 'flush-test',
      }, { sql: rowSql });
      const drain = flushFallbackObservations({ sql: explicit.sql });
      await firstWriteStarted;
      observeFallback('explicit-flush-race', {
        eligible: 2, applied: 0, reason: 'enqueued-during-write', scope: 'flush-test',
      });
      releaseFirstWrite();

      await expect(drain).resolves.toMatchObject({ written: 2, failed: 0 });
      expect(rowOwned.inserts.flat().map((row) => row.reason)).toEqual(['row-owned']);
      expect(explicit.inserts.flat().map((row) => row.reason)).toEqual(['enqueued-during-write']);
      expect(_pendingFallbackObservationCount()).toBe(0);
    } finally {
      releaseFirstWrite();
    }
  });
});

describe('summarizeFallbackWindow', () => {
  it('preserves the known fraction while unknown samples prevent overall qualification', () => {
    const known = { reason: 'applied', samples: 1, eligible: 20, applied: 20, unknownSamples: 0 };
    const unknown = { reason: 'dirty-checkout', samples: 2, eligible: 0, applied: 0, unknownSamples: 2 };
    expect(summarizeFallbackWindow('gate-pass-reuse', 1000, [known])).toMatchObject({
      eligible: 20, applied: 20, knownAppliedRate: 1, appliedRate: 1, populationComplete: true, unknownSamples: 0,
    });
    const mixed = summarizeFallbackWindow('gate-pass-reuse', 1000, [known, unknown]);
    expect(mixed).toMatchObject({
      samples: 3, eligible: 20, applied: 20, knownAppliedRate: 1, appliedRate: null,
      populationComplete: false, unknownSamples: 2,
    });
    expect(mixed.reasons.find((r) => r.reason === 'dirty-checkout')).toMatchObject({ unknownSamples: 2 });
    expect(summarizeFallbackWindow('gate-pass-reuse', 1000, [unknown])).toMatchObject({
      eligible: 0, applied: 0, knownAppliedRate: null, appliedRate: null, populationComplete: false, unknownSamples: 2,
    });
    expect(summarizeFallbackWindow('gate-pass-reuse', 1000, [
      { reason: 'no-candidates', samples: 1, eligible: 0, applied: 0, unknownSamples: 0 },
    ])).toMatchObject({ eligible: 0, appliedRate: null, populationComplete: false, unknownSamples: 0 });
  });

  it('computes the applied rate and names the reason that dominates the fallen-back units', () => {
    const w = summarizeFallbackWindow('gate.pass-reuse', 3_600_000, [
      { reason: 'applied', samples: 3, eligible: 300, applied: 300 },
      { reason: 'proofs-unavailable', samples: 2, eligible: 7_689, applied: 0 },
      { reason: 'dirty-checkout', samples: 1, eligible: 11, applied: 0 },
    ]);
    expect(w.samples).toBe(6);
    expect(w.eligible).toBe(8_000);
    expect(w.applied).toBe(300);
    expect(w.appliedRate).toBeCloseTo(300 / 8_000, 10);
    expect(w.dominantReason).toBe('proofs-unavailable');
    expect(w.dominantShare).toBeCloseTo(7_689 / 7_700, 10);
    expect(w.reasons.map((r) => r.reason)).toEqual(['proofs-unavailable', 'dirty-checkout', 'applied']);
    expect(w.reasons[0]).toMatchObject({ fellBack: 7_689 });
  });

  it('merges duplicate reason rows instead of double-listing them', () => {
    const w = summarizeFallbackWindow('m', 1_000, [
      { reason: 'x', samples: 1, eligible: 4, applied: 1 },
      { reason: 'x', samples: 2, eligible: 6, applied: 1 },
    ]);
    expect(w.reasons).toHaveLength(1);
    expect(w.reasons[0]).toEqual({ reason: 'x', samples: 3, eligible: 10, applied: 2, unknownSamples: 0, fellBack: 8 });
    expect(w.dominantShare).toBe(1);
  });

  it('reports null rate and no dominant reason when the window holds no evidence', () => {
    const empty = summarizeFallbackWindow('m', 1_000, []);
    expect(empty).toMatchObject({ samples: 0, eligible: 0, applied: 0, appliedRate: null, dominantReason: null, dominantShare: null });
    const allApplied = summarizeFallbackWindow('m', 1_000, [{ reason: 'applied', samples: 2, eligible: 5, applied: 5 }]);
    expect(allApplied.appliedRate).toBe(1);
    expect(allApplied.dominantReason).toBeNull();
  });
});

describe('fallbackDecisionProblem', () => {
  it('refuses invented counts for an explicitly unknown population', () => {
    expect(fallbackDecisionProblem('m', { eligible: 1, applied: 0, reason: 'r', populationKnown: false })).toMatch(/unknown/);
    expect(fallbackDecisionProblem('m', { eligible: 0, applied: 0, reason: 'r', populationKnown: false })).toBeNull();
    expect(fallbackDecisionProblem('m', { eligible: 0, applied: 0, reason: 'r', populationKnown: 'false' as unknown as boolean })).toMatch(/boolean/);
  });

  it('accepts a well-formed decision', () => {
    expect(fallbackDecisionProblem('gate.pass-reuse', { eligible: 3, applied: 0, reason: 'proofs-unavailable' })).toBeNull();
  });

  it.each([
    ['empty mechanism', '', { eligible: 1, applied: 0, reason: 'r' }],
    ['negative eligible', 'm', { eligible: -1, applied: 0, reason: 'r' }],
    ['fractional applied', 'm', { eligible: 2, applied: 0.5, reason: 'r' }],
    ['applied above eligible', 'm', { eligible: 1, applied: 2, reason: 'r' }],
    ['blank reason', 'm', { eligible: 1, applied: 0, reason: '  ' }],
  ])('refuses %s', (_label, mechanism, decision) => {
    expect(fallbackDecisionProblem(mechanism, decision)).toMatch(/.+/);
  });
});

describe('observeFallback + flushFallbackObservations', () => {
  it('buffers without writing, then flushes every row with its fields intact', async () => {
    const f = fakeSql();
    const correlationId = '64eab084-4e87-4e2b-99bd-3be2eb7c191f';
    expect(observeFallback('gate.pass-reuse', { eligible: 10, applied: 0, reason: 'proofs-unavailable', scope: 'run-1' }, {
      sql: f.sql, workspaceId: 'ws-a', processTag: 'gate-cli', correlationId,
    })).toBe(true);
    expect(observeFallback('gate.pass-reuse', { eligible: 5, applied: 5, reason: 'applied' }, { sql: f.sql, workspaceId: 'ws-a' })).toBe(true);
    expect(f.inserts).toHaveLength(0);
    expect(_pendingFallbackObservationCount()).toBe(2);

    const res = await flushFallbackObservations();
    expect(res).toMatchObject({ written: 2, failed: 0, dropped: 0, rejected: 0 });
    expect(_pendingFallbackObservationCount()).toBe(0);
    expect(f.inserts).toHaveLength(1);
    expect(f.inserts[0]).toHaveLength(2);
    expect(f.inserts[0]?.[0]).toMatchObject({
      workspace_id: 'ws-a', mechanism: 'gate.pass-reuse', eligible: 10, applied: 0,
      reason: 'proofs-unavailable', scope: 'run-1', process_tag: 'gate-cli',
      correlation_id: correlationId,
    });
    expect(f.inserts[0]?.[0]).not.toHaveProperty('sql');
  });

  it('refuses invalid input without throwing and reports the count on the next flush', async () => {
    const f = fakeSql();
    expect(observeFallback('m', { eligible: 1, applied: 3, reason: 'r' }, { sql: f.sql })).toBe(false);
    expect(_pendingFallbackObservationCount()).toBe(0);
    const res = await flushFallbackObservations();
    expect(res).toMatchObject({ written: 0, rejected: 1 });
  });

  it('refuses malformed correlation ids before they can fail asynchronously in Postgres', async () => {
    const f = fakeSql();
    expect(observeFallback('retrieval', { eligible: 1, applied: 0, reason: 'semantic-blocked' }, {
      sql: f.sql, correlationId: 'not-a-uuid',
    })).toBe(false);
    expect(_pendingFallbackObservationCount()).toBe(0);
    expect(await flushFallbackObservations()).toMatchObject({ written: 0, rejected: 1 });
  });

  it('flushes on its own once a full batch is buffered', async () => {
    const f = fakeSql();
    // Distinct reasons: identical decisions would coalesce into one row and never fill a batch.
    for (let i = 0; i < FALLBACK_FLUSH_BATCH; i++) {
      observeFallback('m', { eligible: 1, applied: 1, reason: `r${i}` }, { sql: f.sql });
    }
    await vi.waitFor(() => expect(f.inserts.flat()).toHaveLength(FALLBACK_FLUSH_BATCH));
    expect(_pendingFallbackObservationCount()).toBe(0);
  });

  it('flushes a partial batch after the debounce delay', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeSql();
      observeFallback('m', { eligible: 2, applied: 0, reason: 'r' }, { sql: f.sql });
      expect(f.inserts).toHaveLength(0);
      await vi.runOnlyPendingTimersAsync();
      expect(f.inserts.flat()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing write never throws into the caller; it is counted as failed', async () => {
    const f = fakeSql();
    f.fail.next = true;
    const before = fallbackObservationCounters().failed;
    expect(() => observeFallback('m', { eligible: 2, applied: 0, reason: 'r' }, { sql: f.sql })).not.toThrow();
    const res = await flushFallbackObservations();
    expect(res).toMatchObject({ written: 0, failed: 1 });
    // BAR R-14: the lifetime failure counter carries the loss past this flush report.
    expect(fallbackObservationCounters().failed).toBe(before + 1);
  });

  it('caps the buffer while a write is stalled: overflow drops the OLDEST rows and is counted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const written: Array<Record<string, unknown>> = [];
    let executions = 0;
    const sql = ((first: unknown, ...rest: unknown[]) => {
      if (Array.isArray(first) && 'raw' in (first as object)) {
        executions += 1;
        const m = rest.find((v) => v && typeof v === 'object' && (v as { __values?: unknown }).__values) as
          | { __values: Array<Record<string, unknown>> }
          | undefined;
        if (m) written.push(...m.__values);
        return gate.then(() => Object.assign([], { count: 0 }));
      }
      return { __values: first, __cols: rest };
    }) as unknown as Sql;

    // The first full batch starts a flush that stalls on the gate; everything after
    // it accumulates in the buffer until the cap.
    const total = FALLBACK_FLUSH_BATCH + FALLBACK_BUFFER_MAX + 3;
    for (let i = 0; i < total; i++) {
      observeFallback('m', { eligible: 1, applied: 0, reason: `r${i}` }, { sql });
    }
    expect(_pendingFallbackObservationCount()).toBe(FALLBACK_BUFFER_MAX);
    expect(mod.fallbackObservationCounters().dropped).toBe(3);
    // A burst behind a stalled write does not start one flush per observation.
    expect(executions).toBe(1);

    release();
    await flushFallbackObservations();
    await vi.waitFor(() => expect(_pendingFallbackObservationCount()).toBe(0));
    await flushFallbackObservations();
    expect(written).toHaveLength(FALLBACK_FLUSH_BATCH + FALLBACK_BUFFER_MAX);
    const reasons = new Set(written.map((r) => r.reason));
    // The three oldest rows still buffered when the cap hit were the ones dropped.
    for (const i of [0, 1, 2]) expect(reasons.has(`r${FALLBACK_FLUSH_BATCH + i}`)).toBe(false);
    expect(reasons.has(`r${FALLBACK_FLUSH_BATCH + 3}`)).toBe(true);
    expect(reasons.has(`r${total - 1}`)).toBe(true);
  });

  it('defaults the workspace to PAPERCUSP_WORKSPACE_ID', async () => {
    const f = fakeSql();
    const prev = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = 'ws-from-env';
    try {
      observeFallback('m', { eligible: 1, applied: 1, reason: 'applied' }, { sql: f.sql });
      await flushFallbackObservations();
      expect(f.inserts[0]?.[0]).toMatchObject({ workspace_id: 'ws-from-env' });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = prev;
    }
  });
});
