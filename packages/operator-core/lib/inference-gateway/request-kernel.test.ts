import { describe, expect, it, vi } from 'vitest';
import { PriorityAdmissionQueue } from '@papercusp/papercusp-shared/agent';
import {
  assertGatewayLaneCapability,
  gatewayLaneConformanceMatrix,
  makeGatewayLaneRegistry,
  type GatewayLaneDescriptor,
  type GatewayTransportId,
} from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import {
  executeGatewayRequestKernel,
  GatewayRequestKernelError,
  type ExecuteGatewayRequestKernelOptions,
  type GatewayKernelAccountPin,
  type GatewayKernelAttemptContext,
  type GatewayKernelPolicy,
  type GatewayKernelRoute,
  type GatewayKernelUpstreamResponse,
} from './request-kernel';
import {
  GatewayRequestTelemetry,
  assertCompleteGatewayRequestTimeline,
  type GatewayTelemetryProvider,
} from './request-stage-telemetry';

const account = (id: string): ActiveAccount => ({
  accountId: id,
  token: async () => `${id}-token`,
});

const pool = (id: string): AccountPool => {
  const active = account(id);
  return {
    active: () => active,
    onExhausted: () => null,
    select: (accountId) => (accountId === id ? active : null),
  };
};

const laneRegistry = makeGatewayLaneRegistry({
  claudePool: pool('claude-a'),
  codexPool: pool('codex-a'),
  codexCliAccountCount: () => 1,
  anthropicUpstreamBase: 'https://anthropic.test',
  openaiUpstreamBase: 'https://openai.test',
});

const laneCases = Object.values(laneRegistry).map((lane) => ({ id: lane.id, lane }));
const conformanceCases = gatewayLaneConformanceMatrix(laneRegistry);

interface RouteValue {
  name: string;
}

interface ResponseMetadata {
  contentType: string;
}

interface PreparedAttempt {
  routeKey: string;
  body: Buffer;
}

type KernelResponse = GatewayKernelUpstreamResponse<Uint8Array, ResponseMetadata>;
type KernelOptions = ExecuteGatewayRequestKernelOptions<RouteValue, PreparedAttempt, Uint8Array, ResponseMetadata>;

const DEFAULT_POLICY: GatewayKernelPolicy = {
  maxBodyBytes: 1024,
  bodyReadTimeoutMs: 500,
  requestCeilingMs: 1_000,
  ttfbTimeoutMs: 500,
  bodyIdleTimeoutMs: 500,
  downstreamIdleTimeoutMs: 500,
  maxAttempts: 2,
};

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

function neverBody(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: async () => ({ done: true, value: undefined }),
      };
    },
  };
}

interface FixtureOverrides {
  body?: AsyncIterable<Uint8Array | string>;
  pin?: GatewayKernelAccountPin | null;
  policy?: Partial<GatewayKernelPolicy>;
  signal?: AbortSignal;
  downstreamSignal?: AbortSignal;
  transport?: GatewayTransportId;
  streaming?: boolean;
  selectInitial?: (routeA: GatewayKernelRoute<RouteValue>) => Promise<GatewayKernelRoute<RouteValue>>;
  executeAttempt?: (
    prepared: PreparedAttempt,
    context: GatewayKernelAttemptContext<RouteValue>,
  ) => Promise<KernelResponse>;
  downstreamWrite?: (chunk: Uint8Array) => void | Promise<void>;
  downstreamStart?: (response: { status: number; metadata: ResponseMetadata }) => void | Promise<void>;
  span?: KernelOptions['span'];
  deferSpanFinalization?: boolean;
}

function fixture(lane: GatewayLaneDescriptor, overrides: FixtureOverrides = {}) {
  const events: string[] = [];
  const written: Uint8Array[] = [];
  const started: Array<{ status: number; metadata: ResponseMetadata }> = [];
  const telemetry = new GatewayRequestTelemetry();
  const transport =
    overrides.transport ??
    lane.transports.find((candidate) => !candidate.degraded)?.id ??
    lane.transports[0]!.id;
  const accountBacked = lane.capabilities.accountPinning !== 'none';
  const routeA: GatewayKernelRoute<RouteValue> = {
    key: `${lane.id}:a`,
    accountId: accountBacked ? 'account-a' : null,
    transport,
    value: { name: 'a' },
  };
  const routeB: GatewayKernelRoute<RouteValue> = {
    key: `${lane.id}:b`,
    accountId: accountBacked ? 'account-b' : null,
    transport,
    value: { name: 'b' },
  };
  let inFlightEntry: { isStreaming: () => boolean } | null = null;
  let releaseCount = 0;
  let unregisterCount = 0;
  let failoverCalls = 0;
  let discardCount = 0;

  async function* defaultBody() {
    events.push('body');
    yield Buffer.from('{"model":"test"}');
  }

  const options: KernelOptions = {
    request: {
      lane,
      body: overrides.body ?? defaultBody(),
      ownerId: 'su-contract',
      correlationId: `${lane.id}-correlation`,
      pin:
        overrides.pin === undefined ? (accountBacked ? { accountId: 'account-a', mode: 'soft' } : null) : overrides.pin,
      signal: overrides.signal,
    },
    policy: { ...DEFAULT_POLICY, ...overrides.policy },
    telemetry,
    span: overrides.span,
    deferSpanFinalization: overrides.deferSpanFinalization,
    admission: {
      async run({ route }, task) {
        events.push(`admit:${route.value.name}`);
        try {
          return await task();
        } finally {
          releaseCount++;
          events.push('release');
        }
      },
      observeAttempt({ context, response, error }) {
        events.push(`observe:${context.route.value.name}:${response?.status ?? error?.code ?? 'unknown'}`);
      },
    },
    adapter: {
      async selectInitial() {
        events.push('select:initial');
        return overrides.selectInitial?.(routeA) ?? routeA;
      },
      async selectFailover() {
        failoverCalls++;
        events.push('select:failover');
        return routeB;
      },
      async prepareAttempt(context) {
        events.push(`prepare:${context.route.value.name}`);
        return { routeKey: context.route.key, body: context.body };
      },
      async executeAttempt(prepared, context) {
        events.push(`execute:${context.route.value.name}`);
        if (overrides.executeAttempt) return overrides.executeAttempt(prepared, context);
        if (context.attempt === 1) {
          return {
            status: 503,
            streaming: false,
            transport: context.route.transport,
            metadata: { contentType: 'application/json' },
            body: null,
            retryable: true,
            discard: () => {
              discardCount++;
              events.push('discard');
            },
          };
        }
        return {
          status: 200,
          streaming: overrides.streaming ?? true,
          transport: context.route.transport,
          metadata: {
            contentType: overrides.streaming === false ? 'application/json' : 'text/event-stream',
          },
          body: chunks('first', 'second'),
        };
      },
    },
    downstream: {
      signal: overrides.downstreamSignal,
      async start(response) {
        started.push({ status: response.status, metadata: response.metadata });
        events.push(`downstream:start:${response.status}`);
        await overrides.downstreamStart?.(response);
      },
      async write(chunk) {
        await overrides.downstreamWrite?.(chunk);
        written.push(chunk);
        events.push(`downstream:write:${Buffer.from(chunk).toString()}`);
      },
      async end() {
        events.push('downstream:end');
      },
    },
    inFlight: {
      register(entry) {
        events.push('inflight:register');
        inFlightEntry = entry;
        return {
          unregister({ outcome, status }) {
            unregisterCount++;
            events.push(`inflight:unregister:${outcome}:${status ?? 'null'}`);
          },
        };
      },
    },
  };

  return {
    options,
    telemetry,
    events,
    written,
    started,
    routeA,
    routeB,
    counts: () => ({ releaseCount, unregisterCount, failoverCalls, discardCount }),
    inFlight: () => inFlightEntry,
  };
}

async function caughtKernelError(promise: Promise<unknown>): Promise<GatewayRequestKernelError> {
  try {
    await promise;
    throw new Error('expected gateway request kernel to reject');
  } catch (error) {
    if (!(error instanceof GatewayRequestKernelError)) throw error;
    return error;
  }
}

describe('gateway request kernel lane coverage', () => {
  it('enumerates every static lane descriptor exactly once', () => {
    expect(laneCases.map(({ id }) => id)).toEqual(['anthropic-messages', 'openai-responses', 'local-openai-chat']);
  });
});

describe.each(conformanceCases)('$id conformance', (row) => {
  it('passes the shared lifecycle contract for its declared capability combination', async () => {
    expect(assertGatewayLaneCapability(row.lane, row).id).toBe(row.transport);
    const f = fixture(row.lane, {
      transport: row.transport,
      streaming: row.streaming,
      pin:
        row.accountPin === 'none'
          ? null
          : { accountId: 'account-a', mode: row.accountPin },
      executeAttempt: async (_prepared, context) => ({
        status: 200,
        streaming: row.streaming,
        transport: context.route.transport,
        metadata: {
          contentType: row.streaming ? 'text/event-stream' : 'application/json',
        },
        body: chunks('matrix-result'),
      }),
    });

    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({
      laneId: row.lane.id,
      status: 200,
      outcome: 'ok',
      attempts: 1,
      failovers: 0,
      finalRoute: { transport: row.transport },
    });
    assertCompleteGatewayRequestTimeline(result.timeline);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });
});

describe.each(laneCases)('$id shared request lifecycle', ({ lane }) => {
  it('runs route, admission, bounded body, failover, telemetry, streaming, and cleanup invariants', async () => {
    const f = fixture(lane);
    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({
      laneId: lane.id,
      correlationId: `${lane.id}-correlation`,
      status: 200,
      outcome: 'ok',
      attempts: 2,
      failovers: 1,
      finalRoute: f.routeB,
    });
    expect(result.timeline).toMatchObject({
      ownerId: 'su-contract',
      protocol: lane.protocol,
      transport: f.routeB.transport,
      attempts: 2,
      failovers: 1,
      finalStatus: 200,
      outcome: 'ok',
      streaming: true,
      missingStages: [],
    });
    const expectedProvider: GatewayTelemetryProvider =
      lane.observability.provider === 'anthropic'
        ? 'claude'
        : lane.observability.provider === 'openai'
          ? 'codex'
          : 'local';
    expect(result.timeline.provider).toBe(expectedProvider);
    assertCompleteGatewayRequestTimeline(result.timeline);
    expect(Buffer.concat(f.written.map((chunk) => Buffer.from(chunk))).toString()).toBe('firstsecond');
    expect(f.started).toEqual([{ status: 200, metadata: { contentType: 'text/event-stream' } }]);
    expect(f.counts()).toEqual({
      releaseCount: 1,
      unregisterCount: 1,
      failoverCalls: 1,
      discardCount: 1,
    });
    expect(f.inFlight()?.isStreaming()).toBe(true);
    expect(f.events).toEqual(
      expect.arrayContaining([
        'select:initial',
        'admit:a',
        'inflight:register',
        'body',
        'prepare:a',
        'execute:a',
        'observe:a:503',
        'select:failover',
        'discard',
        'prepare:b',
        'execute:b',
        'observe:b:200',
        'downstream:start:200',
        'downstream:write:first',
        'downstream:write:second',
        'downstream:end',
        'inflight:unregister:ok:200',
        'release',
      ]),
    );
    expect(f.events.indexOf('inflight:unregister:ok:200')).toBeLessThan(f.events.indexOf('release'));
    expect(f.telemetry.snapshot().requests).toMatchObject({
      started: 1,
      finalized: 1,
      active: 0,
      reconciled: true,
      outcomeReconciled: true,
      missingStageTimelines: 0,
    });
  });

  it('rejects an oversized request body before any upstream attempt and still releases the slot', async () => {
    const f = fixture(lane, {
      body: chunks('four'),
      policy: { maxBodyBytes: 3 },
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'body-too-large', outcome: 'client-error', status: 413 });
    expect(error.timeline).toMatchObject({ attempts: 0, outcome: 'client-error', finalStatus: 413 });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.events.some((event) => event.startsWith('execute:'))).toBe(false);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('bounds a request body producer that never completes', async () => {
    const f = fixture(lane, {
      body: neverBody(),
      policy: { bodyReadTimeoutMs: 5 },
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'body-read-timeout', outcome: 'client-error', status: 408 });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('propagates caller cancellation through the current attempt and cleans up exactly once', async () => {
    const controller = new AbortController();
    let attemptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      attemptStarted = resolve;
    });
    const f = fixture(lane, {
      signal: controller.signal,
      executeAttempt: async (_prepared, context) => {
        attemptStarted();
        return new Promise<KernelResponse>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
      },
    });
    const pending = executeGatewayRequestKernel(f.options);
    await started;
    controller.abort(new Error('caller disconnected'));
    const error = await caughtKernelError(pending);

    expect(error).toMatchObject({ code: 'cancelled', outcome: 'cancelled', status: null });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1, failoverCalls: 0 });

    const downstreamController = new AbortController();
    let downstreamAttemptStarted!: () => void;
    const downstreamStarted = new Promise<void>((resolve) => {
      downstreamAttemptStarted = resolve;
    });
    const downstream = fixture(lane, {
      downstreamSignal: downstreamController.signal,
      executeAttempt: async (_prepared, context) => {
        downstreamAttemptStarted();
        return new Promise<KernelResponse>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
        });
      },
    });
    const downstreamPending = executeGatewayRequestKernel(downstream.options);
    await downstreamStarted;
    downstreamController.abort(new Error('downstream disconnected'));
    const downstreamCancellation = await caughtKernelError(downstreamPending);
    expect(downstreamCancellation).toMatchObject({
      code: 'cancelled',
      outcome: 'cancelled',
      status: null,
    });
    assertCompleteGatewayRequestTimeline(downstreamCancellation.timeline!);
    expect(downstream.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('enforces the whole-request ceiling even when an attempt ignores cancellation', async () => {
    const f = fixture(lane, {
      policy: { requestCeilingMs: 5, ttfbTimeoutMs: 500 },
      executeAttempt: async () => new Promise<KernelResponse>(() => undefined),
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'request-ceiling', outcome: 'gateway-error', status: 504 });
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('enforces the TTFB deadline and stops at the configured attempt budget', async () => {
    const f = fixture(lane, {
      policy: { maxAttempts: 1, ttfbTimeoutMs: 5 },
      executeAttempt: async () => new Promise<KernelResponse>(() => undefined),
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'ttfb-timeout', outcome: 'upstream-error', status: 504 });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.events.filter((event) => event.startsWith('execute:'))).toHaveLength(1);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1, failoverCalls: 0 });
  });

  // gateway-admission-congestion-only-2026-10-13 R-5 / P-004: one request cannot burn every account.
  function everyAccountStallsFixture(policy: Partial<GatewayKernelPolicy>) {
    const f = fixture(lane, {
      policy: { maxAttempts: 6, ttfbTimeoutMs: 5, ...policy },
      executeAttempt: async () => new Promise<KernelResponse>(() => undefined),
    });
    // A fresh account on every failover, so only the bound under test can stop the walk.
    let failovers = 0;
    f.options.adapter.selectFailover = async () => {
      failovers += 1;
      return {
        ...f.routeB,
        key: `${f.routeB.key}:${failovers}`,
        accountId: f.routeB.accountId === null ? null : `account-${failovers}`,
      };
    };
    return f;
  }
  const executed = (events: string[]) => events.filter((event) => event.startsWith('execute:')).length;

  it('stops failing over once maxTtfbTimeouts attempts have timed out on first byte (R-5)', async () => {
    const f = everyAccountStallsFixture({ maxTtfbTimeouts: 2 });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'ttfb-timeout', outcome: 'upstream-error', status: 504, retryable: false });
    expect(error.cause).toMatchObject({ code: 'ttfb-timeout', retryable: true });
    expect(executed(f.events)).toBe(2);
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('CONTROL: without maxTtfbTimeouts a first-byte timeout fails over until maxAttempts', async () => {
    const f = everyAccountStallsFixture({});
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'ttfb-timeout', retryable: true });
    expect(executed(f.events)).toBe(6);
  });

  it('rejects a maxTtfbTimeouts that is not a positive integer', async () => {
    for (const maxTtfbTimeouts of [0, -1, 1.5]) {
      const f = everyAccountStallsFixture({ maxTtfbTimeouts });
      const error = await caughtKernelError(executeGatewayRequestKernel(f.options));
      expect(error, `maxTtfbTimeouts=${maxTtfbTimeouts}`).toMatchObject({ code: 'invalid-policy' });
      expect(executed(f.events)).toBe(0);
    }
  });

  it('closes a failed TTFB stage before selecting the failover route', async () => {
    const f = fixture(lane, {
      executeAttempt: async (_prepared, context) => {
        if (context.attempt === 1) {
          throw new GatewayRequestKernelError('retry this route', {
            code: 'upstream-error',
            outcome: 'upstream-error',
            status: 502,
            retryable: true,
          });
        }
        return {
          status: 200,
          streaming: true,
          transport: context.route.transport,
          metadata: { contentType: 'text/event-stream' },
          body: chunks('recovered'),
        };
      },
    });
    const result = await executeGatewayRequestKernel(f.options);
    const stages = result.timeline.events.map(({ stage, phase }) => `${stage}:${phase}`);
    const failedTtfbEnd = stages.indexOf('upstreamTtfb:end');
    const failoverSelectionStart = stages.indexOf('routeSelection:start', failedTtfbEnd + 1);

    expect(result).toMatchObject({ status: 200, outcome: 'ok', attempts: 2, failovers: 1 });
    expect(failedTtfbEnd).toBeGreaterThan(-1);
    expect(failoverSelectionStart).toBeGreaterThan(failedTtfbEnd);
    assertCompleteGatewayRequestTimeline(result.timeline);
  });

  it('aborts the upstream BEFORE cooperative cleanup when the body stalls mid-stream (D-017)', async () => {
    // REGRESSION GUARD. The attempt signal used to be `withDeadline`'s TTFB-scoped
    // controller, whose `finally` unsubscribes from the request — so the instant
    // headers arrived the upstream became permanently un-abortable. A mid-stream
    // body-idle deadline could stop AWAITING the body but never tear it down, and
    // the request wedged forever holding its admission slot.
    //
    // Why this needs its own test: the body-idle case below passes with or without
    // the fix, because its `discard` fake resolves instantly. A REAL stalled upstream
    // cannot be cancelled cooperatively — `discard`/`iterator.return()` wait on the
    // very stream that stopped producing — so the only thing that can free it is the
    // abort. Asserting the SIGNAL, and asserting it is already aborted by the time
    // cleanup runs, is what makes that ordering falsifiable.
    let attemptSignal: AbortSignal | undefined;
    let abortedWhenCleanupRan: boolean | null = null;
    const stalled = fixture(lane, {
      executeAttempt: async (_prepared, context) => {
        attemptSignal = context.signal;
        return {
          status: 200,
          streaming: true,
          transport: context.route.transport,
          metadata: { contentType: 'text/event-stream' },
          body: neverBody(),
          discard: async () => {
            abortedWhenCleanupRan = context.signal.aborted;
          },
        };
      },
      policy: { bodyIdleTimeoutMs: 5 },
    });

    const error = await caughtKernelError(executeGatewayRequestKernel(stalled.options));

    expect(error).toMatchObject({ code: 'upstream-body-idle', outcome: 'upstream-error', status: 504 });
    expect(attemptSignal?.aborted).toBe(true);
    // Ordering is the whole point: aborting only AFTER cleanup would still leave a
    // real stalled body hanging in the cleanup itself.
    expect(abortedWhenCleanupRan).toBe(true);
    // And the slot must come back — the wedge this guards against was a permanent leak.
    expect(stalled.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('enforces upstream body-idle and downstream backpressure deadlines', async () => {
    const bodyDiscard = vi.fn();
    const bodyIdle = fixture(lane, {
      executeAttempt: async (_prepared, context) => ({
        status: 200,
        streaming: true,
        transport: context.route.transport,
        metadata: { contentType: 'text/event-stream' },
        body: neverBody(),
        discard: bodyDiscard,
      }),
      policy: { bodyIdleTimeoutMs: 5 },
    });
    const bodyError = await caughtKernelError(executeGatewayRequestKernel(bodyIdle.options));
    expect(bodyError).toMatchObject({
      code: 'upstream-body-idle',
      outcome: 'upstream-error',
      status: 504,
    });
    assertCompleteGatewayRequestTimeline(bodyError.timeline!);
    expect(bodyDiscard).toHaveBeenCalledTimes(1);
    expect(bodyIdle.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });

    const downstreamDiscard = vi.fn();
    const downstreamIdle = fixture(lane, {
      executeAttempt: async (_prepared, context) => ({
        status: 200,
        streaming: true,
        transport: context.route.transport,
        metadata: { contentType: 'text/event-stream' },
        body: chunks('blocked'),
        discard: downstreamDiscard,
      }),
      downstreamWrite: async () => new Promise<void>(() => undefined),
      policy: { downstreamIdleTimeoutMs: 5 },
    });
    const downstreamError = await caughtKernelError(executeGatewayRequestKernel(downstreamIdle.options));
    expect(downstreamError).toMatchObject({
      code: 'downstream-idle',
      outcome: 'cancelled',
      status: null,
    });
    assertCompleteGatewayRequestTimeline(downstreamError.timeline!);
    expect(downstreamDiscard).toHaveBeenCalledTimes(1);
    expect(downstreamIdle.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('forwards the last retryable response instead of exceeding maxAttempts', async () => {
    const f = fixture(lane, { policy: { maxAttempts: 1 } });
    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({ status: 503, outcome: 'upstream-error', attempts: 1, failovers: 0 });
    expect(f.counts()).toMatchObject({ failoverCalls: 0, discardCount: 0, releaseCount: 1 });
    assertCompleteGatewayRequestTimeline(result.timeline);
  });
});

// WI-6554700010011504: a D-014 wedge-prevention budget that is already SPENT when an
// attempt would start used to be clamped to a 1ms TTFB — the prompt was uploaded,
// aborted at once, and the lane's own deadline surfaced as an "upstream stall" 502.
// A spent budget is a SHED: no attempt is dispatched, and the error carries the status
// the retry was trying to rescue (429 when nothing was rescued yet).
describe('gateway request kernel spent retry budget (D-014 ttfbCapMs)', () => {
  const overloaded = (context: GatewayKernelAttemptContext<RouteValue>): KernelResponse => ({
    status: 529,
    streaming: false,
    transport: context.route.transport,
    metadata: { contentType: 'application/json' },
    body: null,
    retryable: true,
    discard: () => undefined,
  });

  it('sheds before the FIRST attempt with a non-retryable 429 and never dispatches upstream', async () => {
    const executeAttempt = vi.fn(async (_prepared: PreparedAttempt, context: GatewayKernelAttemptContext<RouteValue>) =>
      overloaded(context),
    );
    const f = fixture(laneRegistry.anthropicMessages, { policy: { ttfbCapMs: () => 0 }, executeAttempt });

    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'retry-budget-exhausted', outcome: 'shed', status: 429, retryable: false });
    expect(executeAttempt).not.toHaveBeenCalled();
    expect(f.counts()).toMatchObject({ releaseCount: 1, unregisterCount: 1 });
  });

  it('carries the upstream status the retry was rescuing when the budget runs out between attempts', async () => {
    let capCalls = 0;
    // A positive budget for attempt 1, spent by the time attempt 2 would start.
    const ttfbCapMs = () => (++capCalls === 1 ? 1_000 : -5);
    const executeAttempt = vi.fn(async (_prepared: PreparedAttempt, context: GatewayKernelAttemptContext<RouteValue>) =>
      overloaded(context),
    );
    const f = fixture(laneRegistry.anthropicMessages, { policy: { ttfbCapMs, maxAttempts: 3 }, executeAttempt });

    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'retry-budget-exhausted', outcome: 'shed', status: 529, retryable: false });
    expect(executeAttempt).toHaveBeenCalledTimes(1);
    expect(f.counts()).toMatchObject({ failoverCalls: 1, releaseCount: 1, unregisterCount: 1 });
  });

  it('CONTROL: a budget that is still positive lets the failover attempt run and serve', async () => {
    const f = fixture(laneRegistry.anthropicMessages, { policy: { ttfbCapMs: () => 1_000 }, streaming: false });

    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({ status: 200, outcome: 'ok', attempts: 2 });
  });
});

describe.each(laneCases.filter(({ lane }) => lane.capabilities.accountPinning !== 'none'))(
  '$id account pin contract',
  ({ lane }) => {
    it('never invokes failover for a hard-pinned request', async () => {
      const f = fixture(lane, {
        pin: { accountId: 'account-a', mode: 'hard' },
      });
      const result = await executeGatewayRequestKernel(f.options);

      expect(result).toMatchObject({ status: 503, outcome: 'upstream-error', attempts: 1, failovers: 0 });
      expect(result.finalRoute).toBe(f.routeA);
      expect(f.counts()).toMatchObject({ failoverCalls: 0, discardCount: 0, releaseCount: 1 });
    });
  },
);

describe('gateway request kernel contract guards', () => {
  // P-008 / D-028: the 'strangles a legacy lane through the existing admission task-settle
  // seam' case was DELETED with `executeGatewayLegacyLane` itself. The property it asserted —
  // that a real PriorityAdmissionQueue admits, runs and releases exactly once around a task —
  // is covered against the REAL kernel by the very next case, so nothing went uncovered.
  it('maps directly onto the existing PriorityAdmissionQueue.run task-settle seam', async () => {
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 1 });
    const f = fixture(laneRegistry.anthropicMessages);
    f.options.admission.run = (_context, task) => queue.run(0, task, { tier: 1 });

    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({ status: 200, outcome: 'ok' });
    expect(queue.snapshot()).toMatchObject({ running: 0, queued: 0, maxConcurrent: 1 });
    expect(f.events.indexOf('inflight:unregister:ok:200')).toBeGreaterThan(-1);
  });

  it('fails closed when a local lane is given an account pin', async () => {
    const f = fixture(laneRegistry.localOpenAiChat, {
      pin: { accountId: 'impossible', mode: 'hard' },
    });
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));
    expect(error).toMatchObject({ code: 'invalid-pin', outcome: 'client-error', status: 400 });
    expect(f.counts()).toMatchObject({ releaseCount: 0, unregisterCount: 0 });
  });

  it('fails closed on a failover cycle instead of retrying the same route', async () => {
    const f = fixture(laneRegistry.anthropicMessages);
    f.options.adapter.selectFailover = vi.fn(async () => f.routeA);
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));
    expect(error).toMatchObject({ code: 'route-cycle', outcome: 'gateway-error', status: 500 });
    assertCompleteGatewayRequestTimeline(error.timeline!);
    expect(f.counts()).toMatchObject({
      releaseCount: 1,
      unregisterCount: 1,
      discardCount: 1,
    });
  });
});

/**
 * P-004 (plan `gateway-kernel-adoption-2026-08-29`). A hard pin means "never change
 * ACCOUNT". It does not mean "never re-attempt the pinned account", but the kernel
 * conflated the two: `selectFailover` returned null for `pin.mode === 'hard'` before
 * the adapter was consulted at all, so an adapter could not express a same-account
 * re-attempt on a hard-pinned request.
 *
 * Three live handlers depend on exactly that, and none of them gate it on the hard
 * pin the way they gate account rotation (`rotateCli`/`rotateCodex` open with
 * `if (hardPin) return false`):
 *   - Codex OAuth 401 → refresh the token, retry the SAME account (gateway.ts:5670).
 *   - Codex OAuth transport-fail / 429 → retry the SAME account on a sibling egress
 *     IP before rotating (gateway.ts:5638, :5727).
 *   - Claude transport-fail / bare-429 → the same sibling-IP retry (gateway.ts:4195,
 *     :4535 — "rotating to a sibling IP on the SAME account").
 *
 * So this is a cross-lane gap binding P-004 and P-006, not an OAuth quirk, and the
 * D-001 narrow-fix clause applies exactly as it did for D-007's TTFB resolver.
 */
describe('gateway request kernel same-account re-attempt under a hard pin', () => {
  const reauthRoute = (from: GatewayKernelRoute<RouteValue>): GatewayKernelRoute<RouteValue> => ({
    key: `${from.key}#reauth`,
    accountId: from.accountId,
    transport: from.transport,
    value: { name: 'a-reauth' },
  });

  it('consults the adapter on a hard pin and accepts a SAME-account re-attempt', async () => {
    const f = fixture(laneRegistry.openaiResponses, { pin: { accountId: 'account-a', mode: 'hard' } });
    const selectReattempt = vi.fn(async () => reauthRoute(f.routeA));
    f.options.adapter.selectReattempt = selectReattempt;

    const result = await executeGatewayRequestKernel(f.options);

    // The fixture's first attempt is a retryable 503; the re-attempt serves 200.
    expect(result).toMatchObject({ status: 200, outcome: 'ok' });
    expect(selectReattempt).toHaveBeenCalledTimes(1);
  });

  it('still refuses to leave the pinned account, so the hard-pin guarantee is intact', async () => {
    // The fixture's default `selectFailover` hands back routeB — a DIFFERENT account.
    // Account ROTATION stays suppressed under a hard pin, so the retryable 503 is
    // forwarded rather than routed around.
    const f = fixture(laneRegistry.openaiResponses, { pin: { accountId: 'account-a', mode: 'hard' } });

    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({ status: 503 });
    expect(f.events).not.toContain('execute:b');
  });

  it('rejects a re-attempt that tries to change account, so a pin cannot be escaped', async () => {
    // The guard that makes consulting the adapter under a hard pin safe BY
    // CONSTRUCTION rather than by refusing to ask.
    const f = fixture(laneRegistry.openaiResponses, { pin: { accountId: 'account-a', mode: 'hard' } });
    f.options.adapter.selectReattempt = vi.fn(async () => f.routeB);

    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'invalid-route', outcome: 'gateway-error', status: 500 });
    expect(f.events).not.toContain('execute:b');
  });

  it('fails closed when a re-attempt re-presents an already-tried route', async () => {
    const f = fixture(laneRegistry.openaiResponses, { pin: { accountId: 'account-a', mode: 'soft' } });
    f.options.adapter.selectReattempt = vi.fn(async () => f.routeA);

    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'route-cycle', outcome: 'gateway-error', status: 500 });
  });

  it('does not count a same-account re-attempt as a failover', async () => {
    // `rotateCli`/`rotateCodex` increment the failover counter only when the ACCOUNT
    // changes. A refreshed token or a sibling egress IP is a re-auth/re-route on the
    // same account, and the live handlers do not count it.
    const f = fixture(laneRegistry.openaiResponses, { pin: { accountId: 'account-a', mode: 'soft' } });
    f.options.adapter.selectReattempt = vi.fn(async () => reauthRoute(f.routeA));

    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({ status: 200, outcome: 'ok' });
    expect(result.failovers).toBe(0);
    expect(f.counts().failoverCalls).toBe(0);
  });

  it('prefers a re-attempt over a failover, matching the live sibling-IP-then-rotate order', async () => {
    const f = fixture(laneRegistry.openaiResponses, { pin: null });
    f.options.adapter.selectReattempt = vi.fn(async () => reauthRoute(f.routeA));

    const result = await executeGatewayRequestKernel(f.options);

    expect(result).toMatchObject({ status: 200, outcome: 'ok' });
    // The account-rotation branch was never reached.
    expect(f.counts().failoverCalls).toBe(0);
    expect(f.events).not.toContain('execute:b');
  });
});

/**
 * D-007 (plan `gateway-kernel-adoption-2026-08-29`). Every cloud handler picks
 * a SHORT TTFB deadline for a streaming request and a generous one otherwise,
 * deciding by parsing `stream: true` out of the REQUEST body — which is not
 * known until the kernel's own bounded body read has run. A scalar policy
 * could not express that, and the only workaround was each adapter racing its
 * own stall timer, re-creating the ladder this kernel exists to delete.
 */
describe('gateway request kernel request-body-derived TTFB deadline', () => {
  const lane = laneRegistry.openaiResponses;

  it('resolves the deadline from the read body and arms the resolved value', async () => {
    const seen: string[] = [];
    const f = fixture(lane, {
      policy: {
        maxAttempts: 1,
        ttfbTimeoutMs: ({ body }) => {
          seen.push(body.toString('utf8'));
          return (JSON.parse(body.toString('utf8')) as { stream?: boolean }).stream === true ? 5 : 60_000;
        },
      },
      body: (async function* () {
        yield Buffer.from('{"stream":true}');
      })(),
      executeAttempt: async () => new Promise<KernelResponse>(() => undefined),
    });

    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    // The resolver saw the body the kernel actually read, not the caller's iterable.
    expect(seen).toEqual(['{"stream":true}']);
    expect(error).toMatchObject({ code: 'ttfb-timeout', outcome: 'upstream-error', status: 504 });
    expect(error.message).toContain('5ms');
  });

  it('gives a non-streaming body the generous deadline instead', async () => {
    const f = fixture(lane, {
      policy: {
        maxAttempts: 1,
        // A streaming body would get 1ms and time out; this one must not.
        ttfbTimeoutMs: ({ body }) =>
          (JSON.parse(body.toString('utf8')) as { stream?: boolean }).stream === true ? 1 : 60_000,
      },
      body: (async function* () {
        yield Buffer.from('{"stream":false}');
      })(),
      executeAttempt: async (_prepared, context) => ({
        status: 200,
        streaming: false,
        transport: context.route.transport,
        metadata: { contentType: 'application/json' },
        body: chunks('ok'),
      }),
    });

    const result = await executeGatewayRequestKernel(f.options);

    expect(result.status).toBe(200);
  });

  it('calls the resolver exactly once, not per attempt', async () => {
    let calls = 0;
    const f = fixture(lane, {
      policy: {
        maxAttempts: 2,
        ttfbTimeoutMs: () => {
          calls++;
          return 60_000;
        },
      },
      executeAttempt: async (_prepared, context) => {
        if (context.attempt === 1) {
          throw new GatewayRequestKernelError('transient', {
            code: 'upstream-error',
            outcome: 'upstream-error',
            status: 502,
            retryable: true,
          });
        }
        return {
          status: 200,
          streaming: false,
          transport: context.route.transport,
          metadata: { contentType: 'application/json' },
          body: chunks('ok'),
        };
      },
    });

    const result = await executeGatewayRequestKernel(f.options);

    expect(result.attempts).toBe(2);
    expect(calls).toBe(1);
  });

  it('rejects a resolver that returns a nonsense deadline', async () => {
    const f = fixture(lane, { policy: { ttfbTimeoutMs: () => 0 } });

    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'invalid-policy', outcome: 'gateway-error', status: 500 });
  });

  it('still rejects an invalid SCALAR up front, before the body is read', async () => {
    const f = fixture(lane, { policy: { ttfbTimeoutMs: 0 } });

    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'invalid-policy' });
    // Back-compat guard: a bad scalar must fail before any work happens, as it
    // did when the field could only ever be a number.
    expect(f.events).not.toContain('body');
  });
});

/**
 * P-003. The legacy proxy entries run the kernel INSIDE a request that already
 * opened its own span (`beginRequestTelemetry`, finished from `res`
 * finish/close). Without adoption the kernel begins a second span for one HTTP
 * request and the stage telemetry double-counts it.
 */
describe('gateway request kernel caller-supplied span adoption', () => {
  const lane = laneRegistry.openaiResponses;

  it('adopts the caller span and does not begin a second one for the same request', async () => {
    const caller = new GatewayRequestTelemetry();
    const span = caller.begin({ ownerId: 'su-outer', provider: 'codex', protocol: lane.protocol });
    const f = fixture(lane, { span });

    const result = await executeGatewayRequestKernel(f.options);

    // One request, one id: the kernel reports under the CALLER's span.
    expect(result.requestId).toBe(span.requestId);
    expect(caller.snapshot().requests).toMatchObject({ started: 1, finalized: 1, active: 0 });
    // ...and the kernel's own telemetry never opened one.
    expect(f.telemetry.snapshot().requests).toMatchObject({ started: 0, finalized: 0 });
  });

  it("propagates the adopted span's ownerId into the adapter's attempt context", async () => {
    const caller = new GatewayRequestTelemetry();
    const span = caller.begin({ ownerId: 'su-outer', provider: 'codex', protocol: lane.protocol });
    const seen: Array<string | null> = [];
    const f = fixture(lane, {
      span,
      async executeAttempt(_prepared, context) {
        seen.push(context.ownerId);
        return {
          status: 200,
          streaming: false,
          transport: context.route.transport,
          metadata: { contentType: 'application/json' },
          body: null,
        };
      },
    });

    await executeGatewayRequestKernel(f.options);

    // fixture() sets request.ownerId to 'su-contract'. The kernel derives its
    // context ownerId from the SPAN, so an adopted span re-identifies the whole
    // request — the property that makes one request report under one identity.
    expect(seen).toEqual(['su-outer']);
  });

  it('a second finish is a no-op, so the caller\'s res-close handler stays safe', async () => {
    const caller = new GatewayRequestTelemetry();
    const span = caller.begin({ ownerId: 'su-outer', provider: 'codex', protocol: lane.protocol });
    const f = fixture(lane, { span });

    await executeGatewayRequestKernel(f.options);
    // What `beginRequestTelemetry`'s res finish/close handler does afterwards.
    expect(span.finish('ok', 200)).toBeNull();
    expect(caller.snapshot().requests).toMatchObject({ started: 1, finalized: 1, active: 0 });
  });

  it('defers an intercepted pass and finalizes one borrowed timeline from the eventual recovery response', async () => {
    const caller = new GatewayRequestTelemetry();
    const span = caller.begin({ ownerId: 'su-outer', provider: 'codex', protocol: lane.protocol });
    const intercept = new Error('outer recovery intercept');
    const first = fixture(lane, {
      span,
      deferSpanFinalization: true,
      executeAttempt: async (prepared, context) => ({
        status: 429,
        streaming: false,
        transport: context.route.transport,
        metadata: { contentType: 'application/json' },
        body: null,
        discard: () => undefined,
      }),
      downstreamStart: async () => {
        throw intercept;
      },
    });

    const firstError = await caughtKernelError(executeGatewayRequestKernel(first.options));
    expect(firstError).toMatchObject({ code: 'gateway-error', status: 500 });
    expect(caller.snapshot().requests).toMatchObject({ started: 1, finalized: 0, active: 1 });

    const second = fixture(lane, {
      span,
      deferSpanFinalization: true,
      streaming: false,
      executeAttempt: async (_prepared, context) => ({
        status: 200,
        streaming: false,
        transport: context.route.transport,
        metadata: { contentType: 'application/json' },
        body: null,
      }),
    });
    const result = await executeGatewayRequestKernel(second.options);

    expect(result.timeline).toMatchObject({
      requestId: span.requestId,
      finalStatus: 200,
      outcome: 'ok',
      attempts: 2,
      missingStages: [],
    });
    expect(caller.snapshot().requests).toMatchObject({ started: 1, finalized: 1, active: 0 });
    expect(span.finish('ok', 200)).toBeNull();
  });

  it('CONTROL: without adoption the kernel begins its own span, as it always has', async () => {
    const f = fixture(lane, {});

    await executeGatewayRequestKernel(f.options);

    expect(f.telemetry.snapshot().requests).toMatchObject({ started: 1, finalized: 1, active: 0 });
  });

  /**
   * D-018: a route may carry its own pre-attempt pace, and the KERNEL is the one
   * thing that executes it. Every legacy ladder slept between attempts; the first
   * kernel wiring dropped that, which is how a rotate began landing inside the very
   * burst window it was fleeing.
   *
   * Deliberately NOT a wall-clock assertion. Measuring "at least N ms elapsed" would
   * pass on a kernel that ignores `delayMs` whenever the box happened to be slow,
   * and its inverse ("under N ms") flakes under fleet load. Instead the pace is set
   * far longer than the test could tolerate and the client vanishes during it: on a
   * kernel that does not wait, route B is prepared BEFORE the abort and the
   * assertion fails deterministically, load or no load.
   */
  it("D-018: waits a route's delayMs before attempting it, and a vanished client stops paying for it", async () => {
    const controller = new AbortController();
    const f = fixture(lane, { signal: controller.signal });
    f.options.adapter.selectFailover = async () => {
      // Fires once the kernel is parked in the delay: a macrotask runs after every
      // microtask between here and `delayBeforeAttempt`, so the ordering is exact.
      setTimeout(() => controller.abort(new Error('caller disconnected')), 0);
      return { ...f.routeB, delayMs: 30_000 };
    };

    const startedAt = Date.now();
    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'cancelled', outcome: 'cancelled' });
    expect(f.events, 'the paced attempt must not have run').not.toContain('prepare:b');
    expect(Date.now() - startedAt, 'an abandoned request must not sleep out its pace').toBeLessThan(5_000);
  });

  it('CONTROL: the SAME abort with NO pace prepares route B — so the assertion above discriminates', async () => {
    // The matched control, and the falsifiability evidence for a module subject:
    // identical fixture, identical abort scheduling, `delayMs` the ONLY difference.
    // A kernel that ignored `delayMs` would behave exactly like this arm, so the
    // test above failing open is not possible — its `not.toContain('prepare:b')`
    // is measured here to be a real discriminator rather than a vacuous truth.
    const controller = new AbortController();
    const f = fixture(lane, { signal: controller.signal });
    f.options.adapter.selectFailover = async () => {
      setTimeout(() => controller.abort(new Error('caller disconnected')), 0);
      return { ...f.routeB, delayMs: 0 };
    };

    // Every hop from here to `prepareAttempt` is a microtask, and a macrotask runs
    // only after all of them — so the un-paced attempt is reached BEFORE the abort,
    // deterministically. Whether the request then completes is not the claim.
    await executeGatewayRequestKernel(f.options).catch(() => undefined);

    expect(f.events, 'without a pace the failover attempt is reached before the abort').toContain('prepare:b');
    // …and the additive half of D-018: the fixture's own routes declare no pace at
    // all, which is why adding this waited nowhere for the already-migrated lanes.
    expect(f.routeB.delayMs).toBeUndefined();
  });
});

/**
 * gateway-admission-congestion-only-2026-10-13 R-3 / P-003 — pace uploads, not open streams.
 *
 * Each case runs the REAL kernel against a REAL one-slot PriorityAdmissionQueue, so "the
 * slot is free" is the queue's own `running` counter and a second request actually being
 * admitted — not a fake's bookkeeping. The CONTROL arm is the same fixture without the
 * hook, which is what makes the release assertion a discriminator rather than a vacuous truth.
 */
describe('gateway request kernel releases the admission slot while a response streams (R-3)', () => {
  const lane = laneRegistry.openaiResponses;

  /** A stream that yields one chunk, then waits for `open()` before its last chunk. */
  function gatedStream() {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    async function* body(): AsyncIterable<Uint8Array> {
      yield Buffer.from('first');
      await gate;
      yield Buffer.from('second');
    }
    return { body: body(), open };
  }

  function streamingFixture(
    body: AsyncIterable<Uint8Array>,
    queue: PriorityAdmissionQueue,
    opts: { releaseForStream: boolean; policy?: Partial<GatewayKernelPolicy> },
  ) {
    let attemptSignal: AbortSignal | undefined;
    const f = fixture(lane, {
      policy: opts.policy,
      executeAttempt: async (_prepared, context) => {
        attemptSignal = context.signal;
        return {
          status: 200,
          streaming: true,
          transport: context.route.transport,
          metadata: { contentType: 'text/event-stream' },
          body,
          discard: () => {
            f.events.push('discard');
          },
        };
      },
    });
    f.options.admission.run = (_context, task) => queue.run(0, task, { tier: 1 });
    if (opts.releaseForStream) {
      f.options.admission.releaseForStream = () => {
        f.events.push(`release-for-stream:running=${queue.snapshot().running}`);
      };
    }
    return { ...f, attemptSignal: () => attemptSignal };
  }

  const text = (written: Uint8Array[]) => written.map((chunk) => Buffer.from(chunk).toString());

  it('frees the slot once the response streams, so a second request is admitted while the first is still open', async () => {
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 4 });
    const first = gatedStream();
    const second = gatedStream();
    const a = streamingFixture(first.body, queue, { releaseForStream: true });
    const b = streamingFixture(second.body, queue, { releaseForStream: true });

    const pendingA = executeGatewayRequestKernel(a.options);
    await vi.waitFor(() => expect(a.events).toContain('downstream:write:first'));
    // A's stream is open (gated before its last chunk) and no longer holds the only slot.
    expect(queue.snapshot()).toMatchObject({ running: 0, queued: 0 });

    const pendingB = executeGatewayRequestKernel(b.options);
    await vi.waitFor(() => expect(b.events).toContain('downstream:write:first'));
    expect(a.events, 'B was admitted while A was still streaming').not.toContain('downstream:end');

    first.open();
    second.open();
    await expect(pendingA).resolves.toMatchObject({ status: 200, outcome: 'ok' });
    await expect(pendingB).resolves.toMatchObject({ status: 200, outcome: 'ok' });

    // The hook ran INSIDE the slot, before a single byte was relayed.
    expect(a.events).toContain('release-for-stream:running=1');
    expect(a.events.indexOf('release-for-stream:running=1')).toBeLessThan(a.events.indexOf('downstream:start:200'));
    // The relay outside the slot is complete and its in-flight handle is released once, last.
    expect(text(a.written)).toEqual(['first', 'second']);
    expect(a.counts()).toMatchObject({ unregisterCount: 1, discardCount: 0 });
    expect(a.events.indexOf('inflight:unregister:ok:200')).toBeGreaterThan(a.events.indexOf('downstream:end'));
    expect(queue.snapshot()).toMatchObject({ running: 0, queued: 0 });
  });

  it('CONTROL: without the hook the stream keeps its slot, so the second request waits for it', async () => {
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 4 });
    const first = gatedStream();
    const second = gatedStream();
    const a = streamingFixture(first.body, queue, { releaseForStream: false });
    const b = streamingFixture(second.body, queue, { releaseForStream: false });

    const pendingA = executeGatewayRequestKernel(a.options);
    await vi.waitFor(() => expect(a.events).toContain('downstream:write:first'));
    expect(queue.snapshot()).toMatchObject({ running: 1 });

    const pendingB = executeGatewayRequestKernel(b.options);
    await vi.waitFor(() => expect(queue.snapshot().queued).toBe(1));
    expect(b.events, 'B must not be admitted while A streams in the slot').not.toContain('inflight:register');

    first.open();
    await expect(pendingA).resolves.toMatchObject({ status: 200, outcome: 'ok' });
    second.open();
    await expect(pendingB).resolves.toMatchObject({ status: 200, outcome: 'ok' });
    expect(b.events.indexOf('inflight:register')).toBeGreaterThan(-1);
  });

  it('keeps every relay guard outside the slot: a stalled released stream still aborts upstream and releases its handle', async () => {
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 1 });
    // Models a real fetch body: after one chunk it stops producing, and the ONLY thing
    // that ends the wait is the attempt's transport being torn down (abortUpstream).
    // A native async generator cannot be cancelled by `return()` while it is suspended
    // on an await, so if the out-of-slot relay ever stopped aborting upstream this
    // case would hang rather than pass.
    let fixtureRef: { attemptSignal: () => AbortSignal | undefined } | undefined;
    async function* stallsAfterFirst(): AsyncIterable<Uint8Array> {
      yield Buffer.from('first');
      await new Promise<void>((_resolve, reject) => {
        const signal = fixtureRef?.attemptSignal();
        if (!signal) return reject(new Error('attempt signal was never captured'));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const f = streamingFixture(stallsAfterFirst(), queue, {
      releaseForStream: true,
      policy: { bodyIdleTimeoutMs: 5 },
    });
    fixtureRef = f;

    const error = await caughtKernelError(executeGatewayRequestKernel(f.options));

    expect(error).toMatchObject({ code: 'upstream-body-idle', outcome: 'upstream-error', status: 504 });
    expect(f.attemptSignal()?.aborted).toBe(true);
    expect(f.counts()).toMatchObject({ unregisterCount: 1 });
    expect(f.events).toContain('inflight:unregister:upstream-error:504');
    expect(queue.snapshot()).toMatchObject({ running: 0, queued: 0 });
  });

  it('a failing release hook discards the response and fails the request inside the slot', async () => {
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 1 });
    const f = streamingFixture(chunks('first'), queue, { releaseForStream: true });
    f.options.admission.releaseForStream = () => {
      throw new Error('bookkeeping failed');
    };

    await expect(executeGatewayRequestKernel(f.options)).rejects.toBeInstanceOf(GatewayRequestKernelError);

    expect(f.events).toContain('discard');
    expect(f.written).toEqual([]);
    expect(f.counts()).toMatchObject({ unregisterCount: 1 });
    expect(queue.snapshot()).toMatchObject({ running: 0, queued: 0 });
  });

  it('a non-streaming response never calls the hook and is relayed inside the slot', async () => {
    const queue = new PriorityAdmissionQueue({ maxConcurrent: 1, maxQueued: 1 });
    const f = fixture(lane, { streaming: false });
    f.options.admission.run = (_context, task) => queue.run(0, task, { tier: 1 });
    const hook = vi.fn();
    f.options.admission.releaseForStream = hook;

    await expect(executeGatewayRequestKernel(f.options)).resolves.toMatchObject({ status: 200, outcome: 'ok' });

    expect(hook).not.toHaveBeenCalled();
    expect(f.counts()).toMatchObject({ unregisterCount: 1 });
  });
});
