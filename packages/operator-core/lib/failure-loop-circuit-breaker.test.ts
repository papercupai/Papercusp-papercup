import { afterEach, describe, expect, it } from 'vitest';
import type { DispatchProjectedResult } from '@papercusp/agent-mcp';
import {
  FAILURE_LOOP_DEBOUNCE_MS,
  FAILURE_LOOP_WINDOW_MS,
  __resetFailureLoopCircuitBreakerForTests,
  argumentShapeFingerprint,
  failureClassOf,
  observeFailureLoop,
  takePendingFailureLoopHint,
} from './failure-loop-circuit-breaker';

const dispatchFailure = (code = 'invalid_input'): DispatchProjectedResult => ({
  ok: false,
  error: { code: code as never, message: 'raw detail must not enter the hint' },
});
const refusal = (body: unknown): DispatchProjectedResult => ({
  ok: true,
  result: {
    isError: true,
    content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }],
  },
});
const success: DispatchProjectedResult = {
  ok: true,
  result: { content: [{ type: 'text', text: 'ok' }] },
};

afterEach(() => __resetFailureLoopCircuitBreakerForTests());

describe('equivalent successful calls', () => {
  const settled = (data: unknown): DispatchProjectedResult => ({ ok: true,
    result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
  const observe = (toolName: string, args: unknown, data: unknown, now = 1, ownerId = 'su-repeat', sourceProjection?: unknown) =>
    observeFailureLoop({ toolName, args, result: settled(data), now, ownerId, sourceProjection });

  it.each(['tools:find', 'work_items:get'])('warns once for identical %s data without treating changing elapsed time as progress', tool => {
    for (let i = 0; i < 3; i++) observe(tool, { id: 'WI-1' }, { state: 'open', elapsedMs: i }, i + 1);
    expect(takePendingFailureLoopHint('su-repeat', 4)).toMatchObject({ kind: 'repetition', count: 3 });
    expect(takePendingFailureLoopHint('su-repeat', 4)).toBeNull();
    observe(tool, { id: 'WI-1' }, { state: 'open', elapsedMs: 99 }, 5);
    expect(takePendingFailureLoopHint('su-repeat', 6)).toBeNull();
  });

  it('resets when the requested schema or returned status changes and isolates owners', () => {
    observe('tools:find', { query: 'locks:acquire' }, { schema: 'a' });
    observe('tools:find', { query: 'locks:release' }, { schema: 'b' }, 2);
    observe('tools:find', { query: 'locks:release' }, { schema: 'b' }, 3, 'other');
    expect(takePendingFailureLoopHint('su-repeat', 4)).toBeNull();
    observe('work_items:get', { id: 'WI-1' }, { state: 'open' });
    observe('work_items:get', { id: 'WI-1' }, { state: 'open' }, 2);
    observe('work_items:get', { id: 'WI-1' }, { state: 'done' }, 3);
    expect(takePendingFailureLoopHint('su-repeat', 4)).toBeNull();
  });

  it('does not combine distinct source projections of the same work-item result', () => {
    const args = { id: 'WI-1' };
    const rawResult = { state: 'open', posts: [{ id: 1191307, body: 'first' }, { id: 1191294, body: 'second' }] };
    const projections = [
      { pick: ['posts[]'] },
      { pick: ['posts[?(@.id==1191307)]'] },
      { pick: ['posts[?(@.id==1191294)]'] },
    ];
    for (const [index, sourceProjection] of projections.entries()) {
      observe('work_items:get', args, rawResult, index + 1, 'su-repeat', sourceProjection);
    }
    expect(takePendingFailureLoopHint('su-repeat', 4)).toBeNull();

    observe('work_items:get', args, rawResult, 4, 'su-repeat', projections[2]);
    const repeated = observe('work_items:get', args, rawResult, 5, 'su-repeat', projections[2]);
    expect(repeated).toMatchObject({ kind: 'repetition', category: 'status', count: 3 });
    expect(JSON.stringify(repeated)).not.toContain('1191294');
  });

  it('requires measured test identity, ignores new run ids, and respects justified rechecks', () => {
    const args = { files: ['test/a.ts'] };
    for (let i = 0; i < 4; i++) observe('testing:run', args, { passed: 1, runId: String(i) }, i);
    expect(takePendingFailureLoopHint('su-repeat', 5)).toBeNull();
    for (let i = 0; i < 3; i++) observe('testing:run', args, { passed: 1, runId: String(i),
      evidenceBundle: { verificationFingerprint: 'same-source-and-tests' } }, i + 10);
    expect(takePendingFailureLoopHint('su-repeat', 14)).toMatchObject({ kind: 'repetition', category: 'test' });
    observe('testing:run', { ...args, recheckReason: 'Confirm after environment repair' }, { passed: 1,
      evidenceBundle: { verificationFingerprint: 'same-source-and-tests' } }, 15);
    observe('testing:run', args, { passed: 1, evidenceBundle: { verificationFingerprint: 'changed-source' } }, 16);
    expect(takePendingFailureLoopHint('su-repeat', 17)).toBeNull();
  });

  it('expires old equivalence and does not retain secrets or grade clipped data', () => {
    for (let i = 0; i < 3; i++) observe('work_items:get', { id: 'WI-1', token: 'secret-value' }, { _partial: true, state: 'open' }, i);
    expect(takePendingFailureLoopHint('su-repeat', 4)).toBeNull();
    observe('work_items:get', { id: 'WI-1' }, { state: 'open' }, 5);
    observe('work_items:get', { id: 'WI-1' }, { state: 'open' }, FAILURE_LOOP_WINDOW_MS + 6);
    expect(takePendingFailureLoopHint('su-repeat', FAILURE_LOOP_WINDOW_MS + 7)).toBeNull();
    for (let i = 0; i < 3; i++) observe('tools:find', { query: 'secret-value' }, { schema: 'secret-result' }, i + 20);
    const hint = takePendingFailureLoopHint('su-repeat', 24);
    expect(hint).not.toBeNull();
    expect(JSON.stringify(hint)).not.toContain('secret');
  });
});

describe('failure-loop circuit breaker', () => {
  it('fingerprints argument SHAPE, independent of object order and scalar values', () => {
    expect(argumentShapeFingerprint({ path: '/a', opts: { n: 1, force: true } })).toBe(
      argumentShapeFingerprint({ opts: { force: false, n: 999 }, path: '/secret' }),
    );
    expect(argumentShapeFingerprint({ path: '/a' })).not.toBe(argumentShapeFingerprint({ query: '/a' }));
  });

  it('normalizes dispatcher errors and structured handler refusals without prose guessing', () => {
    expect(failureClassOf(dispatchFailure('INVALID_INPUT'))).toBe('dispatch:invalid_input');
    expect(failureClassOf(refusal({ error: 'harness_required', message: 'long prose' }))).toBe(
      'refused:harness_required',
    );
    expect(failureClassOf(refusal('plain-text refusal'))).toBe('refused');
    expect(failureClassOf(success)).toBeNull();
  });

  it('queues one hint on the third same-tool + args-shape + error-class failure', () => {
    for (let i = 0; i < 2; i++) {
      expect(
        observeFailureLoop({
          ownerId: 'su-1',
          toolName: 'docs:get',
          args: { slug: `value-${i}` },
          result: dispatchFailure(),
          now: i * 100,
        }),
      ).toBeNull();
    }
    const fired = observeFailureLoop({
      ownerId: 'su-1',
      toolName: 'docs:get',
      args: { slug: 'third-value-same-shape' },
      result: dispatchFailure(),
      now: 200,
    });
    expect(fired).toMatchObject({
      ownerId: 'su-1',
      toolName: 'docs:get',
      errorClass: 'dispatch:invalid_input',
      count: 3,
    });
    expect(takePendingFailureLoopHint('su-1', 201)).toEqual(fired);
    expect(takePendingFailureLoopHint('su-1', 202)).toBeNull();
  });

  it('does not let unrelated successful tools interrupt the failing tool streak', () => {
    observeFailureLoop({ ownerId: 'su-1', toolName: 'bad', args: {}, result: dispatchFailure(), now: 0 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'good', args: {}, result: success, now: 1 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'bad', args: {}, result: dispatchFailure(), now: 2 });
    expect(
      observeFailureLoop({ ownerId: 'su-1', toolName: 'bad', args: {}, result: dispatchFailure(), now: 3 }),
    ).not.toBeNull();
  });

  it('isolates detector state for same-public-owner sessions while keeping hint owner public', () => {
    const observe = (detectorSessionKey: string, now: number) =>
      observeFailureLoop({
        ownerId: 'harness:papercusp',
        detectorSessionKey,
        toolName: 'dev:pg_query',
        args: { query: 'SELECT 1' },
        result: dispatchFailure('missing_capability'),
        now,
      });

    observe('auditor-a', 0);
    observe('auditor-a', 1);
    const fired = observe('auditor-a', 2);
    expect(fired).toMatchObject({ ownerId: 'harness:papercusp', count: 3 });

    observe('auditor-b', 3);
    observe('auditor-b', 4);
    expect(takePendingFailureLoopHint('auditor-b', 5)).toBeNull();
    expect(takePendingFailureLoopHint('auditor-a', 5)).toMatchObject({
      ownerId: 'harness:papercusp',
      toolName: 'dev:pg_query',
    });
  });

  it('resets on a success or changed shape/error class for the same tool', () => {
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { a: 1 }, result: dispatchFailure(), now: 0 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { a: 2 }, result: success, now: 1 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { a: 3 }, result: dispatchFailure(), now: 2 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { b: 3 }, result: dispatchFailure(), now: 3 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: { b: 4 }, result: dispatchFailure('timeout'), now: 4 });
    expect(takePendingFailureLoopHint('su-1', 5)).toBeNull();
  });

  it('drops failures outside the sliding window', () => {
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: {}, result: dispatchFailure(), now: 0 });
    observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: {}, result: dispatchFailure(), now: 1 });
    observeFailureLoop({
      ownerId: 'su-1',
      toolName: 'x',
      args: {},
      result: dispatchFailure(),
      now: FAILURE_LOOP_WINDOW_MS + 2,
    });
    expect(takePendingFailureLoopHint('su-1', FAILURE_LOOP_WINDOW_MS + 3)).toBeNull();
  });

  it('debounces the same signal, then permits a later fresh intervention', () => {
    const fail = (now: number) =>
      observeFailureLoop({ ownerId: 'su-1', toolName: 'x', args: {}, result: dispatchFailure(), now });
    fail(0);
    fail(1);
    expect(fail(2)).not.toBeNull();
    expect(fail(3)).toBeNull();
    expect(fail(FAILURE_LOOP_DEBOUNCE_MS + 3)).toBeNull(); // window reset: first new failure
    expect(fail(FAILURE_LOOP_DEBOUNCE_MS + 4)).toBeNull();
    expect(fail(FAILURE_LOOP_DEBOUNCE_MS + 5)).not.toBeNull();
  });
});
