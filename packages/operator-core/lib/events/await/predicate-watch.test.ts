/**
 * predicate-watch.test.ts — unit coverage for the pure predicate helpers
 * (fleet-deltas-leader-primitives-2026-07-10 P-008): dot-path extraction,
 * op evaluation, tool-result payload extraction, and the poller's dispatch deadline.
 * The store + poller +
 * edge-fire lifecycle is covered in predicate-watch.integration.test.ts
 * (real PG, fake dispatch via configurePredicateDispatch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const dispatchMocks = vi.hoisted(() => ({
  lookupByMcpName: vi.fn(),
  dispatchProjectedTool: vi.fn(async () => ({ ok: true })),
  withWorkspace: vi.fn(async (_workspaceId: string, callback: (tx: unknown) => Promise<unknown>) => callback({})),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  lookupByMcpName: dispatchMocks.lookupByMcpName,
  dispatchProjectedTool: dispatchMocks.dispatchProjectedTool,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: dispatchMocks.withWorkspace,
}));
import {
  valueAtPath,
  comparePredicate,
  predicateShaShapeMismatch,
  predicateShaShapeMismatchMessage,
  extractToolPayload,
  INTERNAL_MACHINE_DISPATCH_PAYLOAD_CONTEXT,
  configurePredicateDispatch,
  dispatchReadOnlyTool,
  dispatchPredicateTool,
  resolvePredicateToolEffect,
  withPredicateDispatchTimeout,
  predicateEvaluatorKey,
  nextEvaluatorBaselines,
  MAX_EVALUATOR_BASELINES,
  type EvaluatorBaseline,
  type PredicateWatchRow,
} from './predicate-watch';

describe('predicate tool effect resolution', () => {
  it('uses argument-sensitive read/write classification for the exact call args', () => {
    const effectForCall = vi.fn((args: unknown) =>
      (args as { op?: string; confirm?: boolean }).op === 'get' ? 'read' : 'write',
    );
    const projected = { effect: 'write' as const, effectForCall };

    expect(resolvePredicateToolEffect(projected, { op: 'get' })).toBe('read');
    expect(resolvePredicateToolEffect(projected, { op: 'admit', confirm: true })).toBe('write');
    expect(effectForCall).toHaveBeenNthCalledWith(1, { op: 'get' });
    expect(effectForCall).toHaveBeenNthCalledWith(2, { op: 'admit', confirm: true });
  });

  it('fails closed when a classifier throws, even if the static effect says read', () => {
    expect(resolvePredicateToolEffect({ effect: 'read', effectForCall: () => { throw new Error('bad args'); } }, {})).toBe('unknown');
  });

  it('uses the static effect only when no argument-sensitive classifier exists', () => {
    expect(resolvePredicateToolEffect({ effect: 'read' }, {})).toBe('read');
    expect(resolvePredicateToolEffect({ effect: 'write' }, {})).toBe('write');
    expect(resolvePredicateToolEffect({}, {})).toBe('unknown');
  });
});

describe('read-only projected dispatch effect gate', () => {
  const env = {
    workspaceId: 'ws-predicate-test',
    harnessSlug: 'papercusp',
    role: 'su',
    onBehalfOf: 'su-watcher',
    spawnId: 'predicate-watch-test',
  };

  beforeEach(() => {
    dispatchMocks.lookupByMcpName.mockReset();
    dispatchMocks.dispatchProjectedTool.mockClear();
    dispatchMocks.withWorkspace.mockClear();
  });

  it('dispatches a read operation when effectForCall classifies the supplied args as read', async () => {
    const effectForCall = vi.fn((args: unknown) => (args as { op?: string }).op === 'get' ? 'read' : 'write');
    const projected = { effect: 'write', effectForCall };
    dispatchMocks.lookupByMcpName.mockReturnValue(projected);

    await dispatchReadOnlyTool('release:repair-queue', { op: 'get' }, env);

    expect(effectForCall).toHaveBeenCalledWith({ op: 'get' });
    expect(dispatchMocks.withWorkspace).toHaveBeenCalledTimes(1);
    expect(dispatchMocks.dispatchProjectedTool).toHaveBeenCalledTimes(1);
  });

  it('refuses a write operation before entering the workspace dispatcher', async () => {
    const effectForCall = vi.fn((args: unknown) => (args as { confirm?: boolean }).confirm ? 'write' : 'read');
    dispatchMocks.lookupByMcpName.mockReturnValue({ effect: 'write', effectForCall });

    await expect(dispatchReadOnlyTool('release:repair-queue', { op: 'admit', confirm: true }, env)).rejects.toMatchObject({
      code: 'not_read_only',
    });

    expect(effectForCall).toHaveBeenCalledWith({ op: 'admit', confirm: true });
    expect(dispatchMocks.withWorkspace).not.toHaveBeenCalled();
    expect(dispatchMocks.dispatchProjectedTool).not.toHaveBeenCalled();
  });
});

describe('WI-7060 — predicate dispatch deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    configurePredicateDispatch(null);
    vi.useRealTimers();
  });

  it('aborts and rejects with a typed timeout when the resolver never settles', async () => {
    let signal: AbortSignal | undefined;
    const pending = withPredicateDispatchTimeout(
      (receivedSignal) => {
        signal = receivedSignal;
        return new Promise(() => {});
      },
      { tool: 'fake:read', timeoutMs: 25 },
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'ReadOnlyDispatchError',
      code: 'dispatch_timeout',
      message: 'predicate resolver ("fake:read") did not respond within 25ms',
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    expect(signal?.aborted).toBe(true);
  });

  it('is wired around the canonical predicate dispatcher, including its test seam', async () => {
    const row = { tool: 'fake:read' } as PredicateWatchRow;
    configurePredicateDispatch(() => new Promise(() => {}));
    const pending = dispatchPredicateTool(row, 25);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'dispatch_timeout' });

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });

  it('preserves a resolver result that arrives just under the deadline and clears the timer', async () => {
    let signal: AbortSignal | undefined;
    const pending = withPredicateDispatchTimeout(
      (receivedSignal) => {
        signal = receivedSignal;
        return new Promise((resolve) => setTimeout(() => resolve({ wm: 128 }), 24));
      },
      { tool: 'fake:read', timeoutMs: 25 },
    );

    await vi.advanceTimersByTimeAsync(24);

    await expect(pending).resolves.toEqual({ wm: 128 });
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('internal machine-dispatch payload context', () => {
  it('bypasses both tier shaping and the hard transport ceiling before path projection', () => {
    expect(INTERNAL_MACHINE_DISPATCH_PAYLOAD_CONTEXT).toEqual({
      contextTier: 'full',
      payloadTierOverride: 'full',
      transportCapExempt: true,
    });
  });
});

describe('valueAtPath', () => {
  it('extracts nested object paths', () => {
    expect(valueAtPath({ counts: { open: 3 } }, 'counts.open')).toBe(3);
  });

  it('extracts array indices as numeric segments', () => {
    expect(valueAtPath({ rows: [{ status: 'done' }] }, 'rows.0.status')).toBe('done');
  });

  it('returns undefined for a missing segment anywhere along the path', () => {
    expect(valueAtPath({ counts: {} }, 'counts.open')).toBeUndefined();
    expect(valueAtPath({ counts: { open: 3 } }, 'counts.open.deeper')).toBeUndefined();
    expect(valueAtPath(null, 'a')).toBeUndefined();
    expect(valueAtPath(42, 'a')).toBeUndefined();
  });

  it('reads a top-level key', () => {
    expect(valueAtPath({ wm: 128 }, 'wm')).toBe(128);
  });
});

describe('comparePredicate', () => {
  it('eq/ne — scalars and deep structures', () => {
    expect(comparePredicate(3, 'eq', 3)).toBe(true);
    expect(comparePredicate('a', 'eq', 'b')).toBe(false);
    expect(comparePredicate({ a: 1 }, 'eq', { a: 1 })).toBe(true);
    expect(comparePredicate({ a: 1 }, 'ne', { a: 2 })).toBe(true);
  });

  it('compares JSONB baselines independently of nested object key order', () => {
    const observed = [{ runtime: 'staging-operator', build: { sha: 'd1b140799c', containsChange: false } }];
    const persisted = [{ build: { containsChange: false, sha: 'd1b140799c' }, runtime: 'staging-operator' }];

    expect(comparePredicate(observed, 'eq', persisted)).toBe(true);
    expect(comparePredicate(observed, 'ne', persisted)).toBe(false);
    expect(comparePredicate(observed, 'changed', undefined, { established: true, value: persisted })).toBe(false);
    expect(comparePredicate(observed, 'contains', persisted[0])).toBe(true);
  });

  it('still detects nested value changes and reordered arrays', () => {
    const before = [{ build: { containsChange: false }, runtime: 'staging-operator' }, { runtime: 'release-operator' }];
    const changed = [{ runtime: 'staging-operator', build: { containsChange: true } }, { runtime: 'release-operator' }];

    expect(comparePredicate(changed, 'changed', undefined, { established: true, value: before })).toBe(true);
    expect(comparePredicate([...before].reverse(), 'eq', before)).toBe(false);
    expect(comparePredicate([...before].reverse(), 'changed', undefined, { established: true, value: before })).toBe(true);
  });

  it('preserves literal JSON object keys when comparing a persisted baseline', () => {
    const before = JSON.parse('{"__proto__":{"containsChange":false},"runtime":"staging-operator"}');
    const reordered = JSON.parse('{"runtime":"staging-operator","__proto__":{"containsChange":false}}');
    const changed = JSON.parse('{"runtime":"staging-operator","__proto__":{"containsChange":true}}');

    expect(comparePredicate(reordered, 'eq', before)).toBe(true);
    expect(comparePredicate(changed, 'changed', undefined, { established: true, value: before })).toBe(true);
  });

  it('numeric ops coerce both sides (a jsonb number often arrives as a string)', () => {
    expect(comparePredicate('128', 'gt', 127)).toBe(true);
    expect(comparePredicate(127, 'gt', 127)).toBe(false);
    expect(comparePredicate(127, 'gte', 127)).toBe(true);
    expect(comparePredicate(5, 'lt', '6')).toBe(true);
    expect(comparePredicate(6, 'lte', 6)).toBe(true);
  });

  it('numeric ops are false (never throw) on non-numeric operands', () => {
    expect(comparePredicate('not-a-number', 'gt', 1)).toBe(false);
    expect(comparePredicate(undefined, 'lt', 1)).toBe(false);
    expect(comparePredicate({}, 'gte', 1)).toBe(false);
  });

  it('exists — null/undefined are absent, falsy values are present', () => {
    expect(comparePredicate(undefined, 'exists', undefined)).toBe(false);
    expect(comparePredicate(null, 'exists', undefined)).toBe(false);
    expect(comparePredicate(0, 'exists', undefined)).toBe(true);
    expect(comparePredicate(false, 'exists', undefined)).toBe(true);
  });

  it('contains — string includes, array deep-membership, false elsewhere', () => {
    expect(comparePredicate('GREEN: wm=128', 'contains', 'GREEN')).toBe(true);
    expect(comparePredicate(['a', 'b'], 'contains', 'b')).toBe(true);
    expect(comparePredicate([{ id: 1 }], 'contains', { id: 1 })).toBe(true);
    expect(comparePredicate([{ id: 1 }], 'contains', { id: 2 })).toBe(false);
    expect(comparePredicate(42, 'contains', 4)).toBe(false);
  });

  // A watch fires a WAKE, so a spurious true is a false all-clear that resumes an
  // agent on a condition never established. `ne` is the natural readiness idiom
  // ("wake me when `blocked` is no longer true") and used to fire on BOTH an
  // UNKNOWN (null) and a MISSPELLED path (undefined).
  it('ne — an absent observation never satisfies "is not X"', () => {
    expect(comparePredicate(true, 'ne', true)).toBe(false); // genuinely still blocked
    expect(comparePredicate(false, 'ne', true)).toBe(true); // genuinely unblocked — the only true
    expect(comparePredicate(null, 'ne', true)).toBe(false); // 3-valued UNKNOWN establishes nothing
    expect(comparePredicate(undefined, 'ne', true)).toBe(false); // misspelled path
  });

  it('ne — a typo\'d dot-path cannot manufacture a wake', () => {
    const cell = { blocked: null as boolean | null, health: 'advancing' };
    expect(valueAtPath(cell, 'blocekd')).toBeUndefined();
    expect(comparePredicate(valueAtPath(cell, 'blocekd'), 'ne', true)).toBe(false);
  });

  it('asking about absence stays explicit — exists, and eq against null', () => {
    expect(comparePredicate(null, 'exists', undefined)).toBe(false);
    expect(comparePredicate(null, 'eq', null)).toBe(true); // "is it UNKNOWN?" — yes
    expect(comparePredicate(false, 'eq', null)).toBe(false); // a known false is not unknown
    expect(comparePredicate(undefined, 'eq', null)).toBe(false); // a missing path is not a reported unknown
  });
});

describe('predicate SHA operand shape guard', () => {
  const full = 'e66be3c4ff7b00d91d44334d7299464af47b7aeb';
  const short = full.slice(0, 10);

  it('identifies a strict short/full SHA prefix and reports both widths', () => {
    const mismatch = predicateShaShapeMismatch(full, short);
    expect(mismatch).toEqual({ observedWidth: 40, operandWidth: 10 });
    expect(predicateShaShapeMismatchMessage(mismatch!)).toContain('40 characters');
    expect(predicateShaShapeMismatchMessage(mismatch!)).toContain('10 characters');
    expect(predicateShaShapeMismatchMessage(mismatch!)).toContain('predicate_shape_mismatch');
  });

  it('does not classify equal-width, unrelated, or non-SHA strings as a shape mismatch', () => {
    expect(predicateShaShapeMismatch(full, full)).toBeNull();
    expect(predicateShaShapeMismatch(full, '0123456789abcdef0123456789abcdef01234567')).toBeNull();
    expect(predicateShaShapeMismatch('not-a-sha-value', short)).toBeNull();
  });

  it('prevents a short/full prefix from manufacturing a true `ne` result', () => {
    expect(comparePredicate(full, 'ne', short)).toBe(false);
    expect(comparePredicate(full, 'ne', '0123456789')).toBe(true);
  });
});

describe('extractToolPayload', () => {
  it('prefers structuredContent when present', () => {
    expect(extractToolPayload({ structuredContent: { n: 1 }, content: [{ type: 'text', text: '{"n":2}' }] })).toEqual({
      n: 1,
    });
  });

  it('falls back to a tolerant JSON.parse of the first text block', () => {
    expect(extractToolPayload({ content: [{ type: 'text', text: '{"counts":{"open":3}}' }] })).toEqual({
      counts: { open: 3 },
    });
  });

  it('returns the raw string when the text block is not JSON', () => {
    expect(extractToolPayload({ content: [{ type: 'text', text: 'plain words' }] })).toBe('plain words');
  });

  it('returns null for a null result and the object itself when shapeless', () => {
    expect(extractToolPayload(null)).toBeNull();
    expect(extractToolPayload({ other: true })).toEqual({ other: true });
  });
});

describe('WI-10004125 — evaluator identity and per-evaluator baselines', () => {
  it('keys an evaluator by host AND build, so a restart onto new code is a new evaluator', () => {
    const a = predicateEvaluatorKey({ host: 'port-3070', processId: 'linux:b:1', buildSha: '9a9473af95' });
    const b = predicateEvaluatorKey({ host: 'port-3170', processId: 'linux:b:2', buildSha: '9a9473af95' });
    const aNewBuild = predicateEvaluatorKey({ host: 'port-3070', processId: 'linux:b:1', buildSha: 'bba6c48424' });
    expect(a).toBe('port-3070@9a9473af95');
    expect(new Set([a, b, aNewBuild]).size).toBe(3);
  });

  it('falls back to the process id, then to a literal, when the build is unprovable', () => {
    expect(predicateEvaluatorKey({ host: 'pid-7', processId: 'linux:b:9', buildSha: null })).toBe('pid-7@linux:b:9');
    expect(predicateEvaluatorKey({ host: 'pid-7', processId: null, buildSha: null })).toBe('pid-7@unknown');
  });

  const at = (minute: number): string => new Date(Date.UTC(2026, 8, 30, 4, minute)).toISOString();
  const entry = (minute: number, value: unknown = minute): EvaluatorBaseline => ({ eval: false, value, at: at(minute) });

  it("records the writer's entry without disturbing other evaluators' baselines", () => {
    const prev = { 'port-3070@x': entry(1, 'inconclusive'), 'port-3170@y': entry(2, 'repair-head-red') };
    const next = nextEvaluatorBaselines(prev, 'port-3070@x', entry(3, 'green'));
    expect(next).toEqual({ 'port-3070@x': entry(3, 'green'), 'port-3170@y': entry(2, 'repair-head-red') });
    expect(prev['port-3070@x'].value, 'the input map must not be mutated').toBe('inconclusive');
  });

  it('keeps only the most recent evaluators, dropping the oldest observation first', () => {
    let map: Record<string, EvaluatorBaseline> = {};
    for (let i = 0; i < MAX_EVALUATOR_BASELINES + 3; i++) map = nextEvaluatorBaselines(map, `e${i}`, entry(i));
    expect(Object.keys(map)).toHaveLength(MAX_EVALUATOR_BASELINES);
    expect(map).not.toHaveProperty('e0');
    expect(map).not.toHaveProperty('e2');
    expect(map).toHaveProperty('e3');
    expect(map).toHaveProperty(`e${MAX_EVALUATOR_BASELINES + 2}`);
  });

  it("never prunes the writer's own entry, even when a clock-skewed writer stamps the oldest time", () => {
    const prev = Object.fromEntries([10, 11, 12].map((m) => [`peer${m}`, entry(m)]));
    const next = nextEvaluatorBaselines(prev, 'skewed', entry(0), 3);
    expect(Object.keys(next)).toHaveLength(3);
    expect(next.skewed).toEqual(entry(0));
    // The writer displaces the OLDEST peer, not an arbitrary one.
    expect(next).not.toHaveProperty('peer10');
  });
});
