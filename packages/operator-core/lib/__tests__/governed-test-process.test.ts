import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// The bridge is intentionally a plain-Node `.mjs` module so both repository
// test CLIs remain executable with `node scripts/*.mjs`.
import {
  buildGovernedProcessDemand,
  classifyGovernedTestProcessOutcome,
  createGovernedProcessDemandSampler,
  executeGovernedByteProcess,
  governedProcessIdempotencyKey,
  isRetryableAdmissionFailure,
  resolveGovernedProcessTree,
  runGovernedTestProcess,
  selectGovernedByteProcessFailure,
  GOVERNED_PROCESS_TREE_WALK_PID_CAP,
  GOVERNED_TEST_PROCESS_DEFAULT_DISK_BYTES,
  GOVERNED_TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS,
  GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES,
} from '../../../../scripts/lib/governed-test-process.mjs';

const context = {
  contractVersion: 1,
  requestId: 'request-1',
  rootRequestId: 'request-1',
  parentRequestId: null,
  receiptId: 'WI-TEST-1',
  parentReceiptId: null,
  idempotencyKey: 'test-process-1',
  admissionClass: 'process',
  priority: 0,
  demand: { cpuWeight: 1 },
  depth: 0,
  createdAtMs: 1,
  decisionGeneration: 1,
  leaseId: 'lease-1',
};

describe('governed byte-input process', () => {
  const options = (runGovernedOperation: unknown, extra: Record<string, unknown> = {}) => ({
    workspaceId: 'ws', env: {}, owner: 'diagnostic-test', namespace: 'byte-diagnostic',
    timeoutMs: 3000, maxBuffer: 4096,
    executionApi: {
      admissionContextFromEnvironment: (): typeof context | undefined => undefined,
      governedExecutionLeaseTtlForTimeout: () => 4000,
      runGovernedOperation,
    }, ...extra,
  });

  it('does not turn a successful zero-input command into an EPIPE failure', async () => {
    const closedStdin = Object.assign(new Error('closed stdin'), { code: 'EPIPE' });
    expect(selectGovernedByteProcessFailure(null, closedStdin, 0, 0)).toBeUndefined();
    expect(selectGovernedByteProcessFailure(null, closedStdin, 1, 0)).toBe(closedStdin);
    expect(selectGovernedByteProcessFailure(null, closedStdin, 0, 1)).toBe(closedStdin);
    const childError = Object.assign(new Error('child failed'), { code: 'ENOENT' });
    expect(selectGovernedByteProcessFailure(childError, closedStdin, 0, 0)).toBe(childError);

    const result = await executeGovernedByteProcess(process.execPath,
      ['-e', 'process.exit(0)'], Buffer.alloc(0), options(async (
        _input: unknown, run: (admitted: typeof context) => Promise<unknown>,
      ) => run(context)));
    expect(result).toMatchObject({ status: 0, error: undefined });
  });

  it('starts only after admission and releases after byte input and pipe EOF', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'governed-byte-process-'));
    const marker = join(directory, 'started');
    let admit!: () => void;
    const gate = new Promise<void>(resolve => { admit = resolve; });
    const settlements: unknown[] = [];
    const runGovernedOperation = vi.fn(async (input, run) => {
      await gate;
      const result = await run(context);
      settlements.push(input.settle(result));
      return result;
    });
    try {
      const pending = executeGovernedByteProcess(process.execPath, ['-e', `
        require('node:fs').writeFileSync(process.argv[1], 'started');
        let bytes = 0;
        process.stdin.on('data', chunk => { bytes += chunk.length; });
        process.stdin.on('end', () => setTimeout(() => console.log(JSON.stringify({
          bytes, receipt: JSON.parse(process.env.PAPERCUSP_ADMISSION_CONTEXT).receiptId
        })), 30));
      `, marker], Buffer.from('private-input'), options(runGovernedOperation));
      await vi.waitFor(() => expect(runGovernedOperation).toHaveBeenCalledOnce());
      expect(existsSync(marker)).toBe(false);
      expect(settlements).toEqual([]);
      admit();
      const result = await pending;
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ bytes: 13, receipt: context.receiptId });
      expect(settlements).toEqual([{ kind: 'release', actualDemand: result.actualDemand }]);
      expect(runGovernedOperation.mock.calls[0][0]).toMatchObject({
        workspaceId: 'ws', namespace: 'byte-diagnostic', admissionClass: 'process',
        dedicatedClient: true, leaseTtlMs: 4000,
        demand: { cpuWeight: 1, memoryBytes: 1024 * 1024 * 1024, fileDescriptors: 3 },
      });
    } finally { admit(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses a child when admission fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'governed-byte-refusal-'));
    const marker = join(directory, 'started');
    const runGovernedOperation = vi.fn(async () => { throw Error('admission refused'); });
    try {
      await expect(executeGovernedByteProcess(process.execPath,
        ['-e', `require('node:fs').writeFileSync(process.argv[1], 'started')`, marker],
        Buffer.from('private-input'), options(runGovernedOperation))).rejects.toThrow('admission refused');
      expect(existsSync(marker)).toBe(false);
      expect(runGovernedOperation).toHaveBeenCalledOnce();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('inherits the parent receipt without opening a second admission', async () => {
    const runGovernedOperation = vi.fn();
    const config = options(runGovernedOperation);
    config.executionApi.admissionContextFromEnvironment = () => context;
    const result = await executeGovernedByteProcess(process.execPath,
      ['-e', 'console.log(JSON.parse(process.env.PAPERCUSP_ADMISSION_CONTEXT).receiptId)'],
      Buffer.alloc(0), config);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(context.receiptId);
    expect(runGovernedOperation).not.toHaveBeenCalled();
  });

  it('keeps timeout and output failures bounded and cancels their receipt', async () => {
    const settlements: unknown[] = [];
    const runGovernedOperation = vi.fn(async (input, run) => {
      const result = await run(context);
      settlements.push(input.settle(result));
      return result;
    });
    const timeout = await executeGovernedByteProcess(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], Buffer.alloc(0), options(runGovernedOperation, { timeoutMs: 100 }));
    expect(timeout.status).toBeNull();
    expect(timeout.signal).toBe('SIGTERM');
    const output = await executeGovernedByteProcess(process.execPath,
      ['-e', "console.log('x'.repeat(8192))"], Buffer.alloc(0), options(runGovernedOperation, { maxBuffer: 64 }));
    expect(output.error?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(64);
    expect(settlements).toEqual(Array(2).fill({ kind: 'cancel', reason: 'native diagnostic did not complete successfully' }));
  });

  it('rejects missing subprocess bounds before admission', async () => {
    const runGovernedOperation = vi.fn();
    await expect(executeGovernedByteProcess(process.execPath, [], Buffer.alloc(0),
      options(runGovernedOperation, { timeoutMs: 0 }))).rejects.toThrow('finite timeout');
    expect(runGovernedOperation).not.toHaveBeenCalled();
  });
});

describe('governed test-process bridge', () => {
  it('builds a bounded process reservation and stable idempotency key', () => {
    expect(buildGovernedProcessDemand({ fileCount: 3 })).toEqual({
      cpuWeight: 1,
      memoryBytes: 1024 * 1024 * 1024,
      diskBytes: 256 * 1024 * 1024,
      fileDescriptors: 19,
    });
    const first = governedProcessIdempotencyKey('affected tests', 'run-1');
    expect(first).toBe(governedProcessIdempotencyKey('affected tests', 'run-1'));
    expect(first).toMatch(/^test-process:affected_tests:[0-9a-f]{40}$/);
    expect(first.length).toBeLessThanOrEqual(200);
  });

  it('records peak resource observations and keeps stop idempotent', () => {
    let now = 1_000;
    let snapshot = { cpuMicros: 100, rssBytes: 10, fileDescriptors: 4 };
    const sampler = createGovernedProcessDemandSampler(
      buildGovernedProcessDemand(),
      { readSnapshot: () => snapshot, now: () => now, intervalMs: 60_000 },
    );
    sampler.attach(42);
    now = 2_000;
    snapshot = { cpuMicros: 1_500_100, rssBytes: 30, fileDescriptors: 8 };
    sampler.sample();
    now = 3_000;
    snapshot = { cpuMicros: 3_000_100, rssBytes: 20, fileDescriptors: 6 };
    expect(sampler.stop({ diskBytes: 123 })).toEqual({
      cpuWeight: 1.5,
      memoryBytes: 30,
      diskBytes: 123,
      fileDescriptors: 8,
    });
    expect(sampler.stop({ diskBytes: 999 })).toEqual({
      cpuWeight: 1.5,
      memoryBytes: 30,
      diskBytes: 123,
      fileDescriptors: 8,
    });
  });

  it('uses a one-shot sample timer so slow procfs reads cannot spin the event loop', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const sampler = createGovernedProcessDemandSampler(
        buildGovernedProcessDemand(),
        { readSnapshot: () => ({ cpuMicros: 1, rssBytes: 1, fileDescriptors: 1 }), intervalMs: 60_000 },
      );
      sampler.attach(42);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setTimeoutSpy).toHaveBeenCalled();
      sampler.stop();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it('cancels undetermined starts and releases measured real exits', () => {
    expect(classifyGovernedTestProcessOutcome({
      code: null,
      signal: 'SIGKILL',
      timedOut: true,
      output: '',
    })).toMatchObject({ kind: 'cancel' });
    expect(classifyGovernedTestProcessOutcome({
      code: 2,
      signal: null,
      output: 'TEST_FILE_ROUTE_ERROR requested=1 matched=0',
    })).toMatchObject({ kind: 'cancel' });
    expect(classifyGovernedTestProcessOutcome({
      code: 1,
      signal: null,
      output: 'Tests 1 failed',
      actualDemand: { memoryBytes: 7 },
    })).toEqual({ kind: 'release', actualDemand: { memoryBytes: 7 } });
  });

  it('reuses a valid inherited context without creating a second receipt', async () => {
    const runGovernedOperation = vi.fn();
    const executionApi = {
      admissionContextFromEnvironment: vi.fn((value: string | undefined) => value ? context : undefined),
      governedExecutionLeaseTtlForTimeout: vi.fn(() => 1234),
      runGovernedOperation,
    };
    const inheritedEnv = { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(context) };
    const result = await runGovernedTestProcess(
      { executionApi, workspaceId: 'ws', env: inheritedEnv, owner: 'runner', timeoutMs: 100 },
      async (received: typeof context, childEnv: Record<string, string>, info: { inherited: boolean }) => ({
        received,
        childEnv,
        info,
      }),
    );
    expect(result.info.inherited).toBe(true);
    expect(result.received).toEqual(context);
    expect(JSON.parse(result.childEnv.PAPERCUSP_ADMISSION_CONTEXT)).toEqual(context);
    expect(runGovernedOperation).not.toHaveBeenCalled();
  });

  it('admits direct starts with a timeout-derived lease and forwards the new context', async () => {
    const runGovernedOperation = vi.fn(async (_input: unknown, run: (ctx: typeof context) => Promise<unknown>) => run(context));
    const executionApi = {
      admissionContextFromEnvironment: vi.fn(() => undefined),
      governedExecutionLeaseTtlForTimeout: vi.fn(() => 4567),
      runGovernedOperation,
    };
    const result = await runGovernedTestProcess(
      {
        executionApi,
        workspaceId: 'ws',
        env: {},
        owner: 'runner',
        timeoutMs: 1000,
        demand: { cpuWeight: 1 },
        idempotencyKey: 'explicit-key',
        settle: () => ({ kind: 'release' }),
      },
      async (_received: typeof context, childEnv: Record<string, string>, info: { inherited: boolean }) => ({
        childEnv,
        info,
      }),
    );
    const [input] = runGovernedOperation.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({
      workspaceId: 'ws',
      namespace: 'test-process',
      owner: 'runner',
      idempotencyKey: 'explicit-key',
      leaseTtlMs: 4567,
      // WI-638180: every caller of this bridge is a one-shot CLI. Without this
      // flag the admission runs on the process-wide `getOrgPg()` pool, which no
      // library may close — the runner then finishes all of its work and hangs
      // forever on two idle PgBouncer sockets, which a supervisor reads as a
      // wedged test run rather than a completed one.
      dedicatedClient: true,
    });
    expect(result.info.inherited).toBe(false);
    expect(JSON.parse(result.childEnv.PAPERCUSP_ADMISSION_CONTEXT)).toEqual(context);
  });

  it('lets a long-lived embedder opt back onto the shared pool (WI-638180)', async () => {
    // The default is the safe one, so the escape hatch needs its own coverage:
    // an in-process host must be able to keep the shared pool it already owns.
    const runGovernedOperation = vi.fn(async (_input: unknown, run: (ctx: typeof context) => Promise<unknown>) => run(context));
    await runGovernedTestProcess(
      {
        executionApi: {
          admissionContextFromEnvironment: vi.fn(() => undefined),
          governedExecutionLeaseTtlForTimeout: vi.fn(() => 1000),
          runGovernedOperation,
        },
        workspaceId: 'ws',
        env: {},
        owner: 'embedded-runner',
        dedicatedClient: false,
      },
      async () => 'ok',
    );
    const [input] = runGovernedOperation.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input.dedicatedClient).toBe(false);
  });
});

// P-006 regression coverage (plan nonblocking-test-materializer-2026-08-28).
//
// The bridge's job is to decide whether a child produced a TRUSTWORTHY verdict.
// `release` teaches the governor a measured demand and settles the receipt as a
// real run; `cancel` says the run proved nothing. Every shape below is one the
// classifier could otherwise settle as a successful release having measured
// nothing — the false green this plan exists to make impossible.

describe('demand construction', () => {
  it('scales the descriptor reservation with the file count, and clamps it', () => {
    expect(buildGovernedProcessDemand({ fileCount: 1 }).fileDescriptors).toBe(17);
    expect(buildGovernedProcessDemand({ fileCount: 8 }).fileDescriptors).toBe(24);
    // A fractional or negative count must never reserve a fractional/absurd budget.
    expect(buildGovernedProcessDemand({ fileCount: 3.9 }).fileDescriptors).toBe(19);
    expect(buildGovernedProcessDemand({ fileCount: -5 }).fileDescriptors).toBe(17);
  });

  it('honours explicit positive overrides', () => {
    expect(
      buildGovernedProcessDemand({ cpuWeight: 2.5, memoryBytes: 5000, diskBytes: 6000, fileDescriptors: 7 }),
    ).toEqual({ cpuWeight: 2.5, memoryBytes: 5000, diskBytes: 6000, fileDescriptors: 7 });
  });

  it('falls back to bounded defaults for zero, negative, and non-finite input', () => {
    const defaults = {
      cpuWeight: 1,
      memoryBytes: GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES,
      diskBytes: GOVERNED_TEST_PROCESS_DEFAULT_DISK_BYTES,
      fileDescriptors: GOVERNED_TEST_PROCESS_DEFAULT_FILE_DESCRIPTORS + 1,
    };
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        buildGovernedProcessDemand({ memoryBytes: bad, diskBytes: bad, fileDescriptors: bad, cpuWeight: -1 }),
      ).toEqual(defaults);
    }
  });

  it('permits a deliberate zero cpu weight while still flooring the byte reservations', () => {
    // The asymmetry is intentional: a zero-cpu reservation is meaningful, a
    // zero-memory one is a missing value.
    expect(buildGovernedProcessDemand({ cpuWeight: 0 }).cpuWeight).toBe(0);
    expect(buildGovernedProcessDemand({ memoryBytes: 0 }).memoryBytes).toBe(
      GOVERNED_TEST_PROCESS_DEFAULT_MEMORY_BYTES,
    );
  });
});

describe('worker-exit classification', () => {
  // One case per token in the untrustworthy-output pattern, so removing a token
  // fails HERE rather than silently widening `release`. Each carries code 0 —
  // the false-green shape, where the child claims success while its own output
  // says no verdict was produced.
  const untrustworthyOutput: [string, string][] = [
    ['a crashed vitest worker', 'Worker exited unexpectedly'],
    ['a watchdog marker', 'TEST_FILE_WATCHDOG fired after 120s'],
    ['a route error', 'TEST_FILE_ROUTE_ERROR requested=3 matched=0'],
    ['a cgroup task ceiling', 'fork failed: TasksMax limit reached'],
    ['a termination signal named in output', 'child received SIGTERM'],
    ['a kill signal named in output', 'runner sent SIGKILL to the pool'],
  ];

  it.each(untrustworthyOutput)('refuses to release after %s', (_label, text) => {
    expect(classifyGovernedTestProcessOutcome({ code: 0, signal: null, stderr: text })).toMatchObject({
      kind: 'cancel',
    });
  });

  it('scans stdout, stderr, and the combined output field alike', () => {
    for (const key of ['stdout', 'stderr', 'output']) {
      expect(
        classifyGovernedTestProcessOutcome({ code: 0, signal: null, [key]: 'Worker exited unexpectedly' }),
      ).toMatchObject({ kind: 'cancel' });
    }
  });
});

describe('no false green', () => {
  // CALIBRATION — without this, every assertion below would still pass if the
  // classifier degenerated into always-cancel, which would prove nothing.
  it('does release a clean, trustworthy exit', () => {
    expect(
      classifyGovernedTestProcessOutcome({
        code: 0,
        signal: null,
        stdout: 'Test Files  1 passed (1)',
        actualDemand: { memoryBytes: 3 },
      }),
    ).toEqual({ kind: 'release', actualDemand: { memoryBytes: 3 } });
  });

  const untrustworthy: [string, Record<string, unknown>][] = [
    ['a success code delivered alongside a kill signal', { code: 0, signal: 'SIGKILL' }],
    ['a spawnSync status of 0 that was still signalled', { status: 0, signal: 'SIGTERM' }],
    ['no exit code at all', { code: null, signal: null }],
    ['a watchdog timeout carrying a success code', { code: 0, signal: null, timedOut: true }],
    ['the internal watchdog flag', { code: 0, signal: null, __watchdogTimedOut: true }],
    ['the public watchdog flag', { code: 0, signal: null, watchdogTimedOut: true }],
    ['an abort before any verdict', { code: 0, signal: null, aborted: true }],
    ['a spawn failure', { code: 0, signal: null, spawnError: 'ENOENT' }],
    ['the internal spawn-failure field', { code: 0, signal: null, __spawnError: 'EACCES' }],
    ['a start failure that produced no output', { code: null, error: new Error('boom') }],
  ];

  it.each(untrustworthy)('never settles %s as a release', (_label, outcome) => {
    expect(classifyGovernedTestProcessOutcome(outcome).kind).toBe('cancel');
  });

  it('cancels a post-preflight scope-launch error with retained stderr (EI-25878128777441671)', () => {
    expect(classifyGovernedTestProcessOutcome({
      status: 1, signal: null,
      error: Object.assign(new Error('scope admission failed'), { code: 'TEST_SCOPE_LAUNCH_FAILED' }),
      stderr: 'Failed to start transient scope unit: Transport endpoint is not connected',
      actualDemand: { memoryBytes: 999 },
    })).toEqual({ kind: 'cancel', reason: 'test scope admission failed before a trustworthy verdict was produced' });
    // Identical diagnostic words from a measured payload do not create a launch error.
    expect(classifyGovernedTestProcessOutcome({
      status: 1, signal: null, stdout: 'Tests  1 failed (1)',
      stderr: 'Failed to start transient scope unit: Transport endpoint is not connected',
      actualDemand: { memoryBytes: 3 },
    })).toEqual({ kind: 'release', actualDemand: { memoryBytes: 3 } });
  });

  it('carries no measured demand on a refusal, so a cancelled run cannot teach the governor', () => {
    const settled = classifyGovernedTestProcessOutcome({
      code: 0,
      signal: 'SIGKILL',
      actualDemand: { memoryBytes: 999 },
    });
    expect(settled.kind).toBe('cancel');
    expect(settled.actualDemand).toBeUndefined();
  });
});

describe('receipt lifecycle and demand accounting', () => {
  it('refuses a malformed invocation instead of starting an ungoverned child', async () => {
    await expect(runGovernedTestProcess(null, async () => 'ran')).rejects.toThrow(/options are required/);
    await expect(runGovernedTestProcess({}, undefined)).rejects.toThrow(/callback is required/);
  });

  it('falls back to the planned reservation when nothing could be measured', () => {
    const planned = buildGovernedProcessDemand({ fileCount: 2 });
    const sampler = createGovernedProcessDemandSampler(planned, {
      readSnapshot: () => ({ cpuMicros: null, rssBytes: null, fileDescriptors: null }),
      now: () => 1,
      intervalMs: 60_000,
    });
    sampler.attach(7);
    expect(sampler.stop()).toEqual(planned);
  });

  it('stays fail-soft when a procfs read throws or the pid is invalid', () => {
    const planned = buildGovernedProcessDemand();
    const sampler = createGovernedProcessDemandSampler(planned, {
      readSnapshot: () => {
        throw new Error('procfs vanished');
      },
      now: () => 1,
      intervalMs: 60_000,
    });
    sampler.attach(0);
    expect(() => sampler.sample()).not.toThrow();
    expect(sampler.stop()).toEqual(planned);
  });
});

/**
 * WI-1410919 — a retryable ADMISSION failure is retried; a post-launch failure never is.
 *
 * `pg-bounded-txn.ts` already raises `OrgTxnTimeoutError` with `pgCode` in {55P03, 57014}
 * and a message ending "— retry shortly". Nothing acted on that advice at this seam: the
 * rejection was flattened into `GOVERNED_ADMISSION_FAILED` and rendered as "could not
 * launch Vitest", so a database lock was reported as a Vitest launch failure over a run
 * that measured zero files.
 *
 * The load-bearing test here is the SECOND one. Retrying is the easy half; the half that
 * can cause real damage is retrying a failure that arrived AFTER the child started, which
 * would re-run tests. `started` is asserted to dominate every other signal — that case
 * uses an error that IS retryable by code, so a regression cannot pass by accident.
 */
describe('governed admission retry (WI-1410919)', () => {
  const contention = (pgCode: string) =>
    Object.assign(new Error(`operator write timed out (pg ${pgCode}) — retry shortly`), {
      name: 'OrgTxnTimeoutError',
      pgCode,
    });
  const connectionDestroyed = (shape: 'code' | 'message' = 'code') =>
    shape === 'code'
      ? Object.assign(new Error('write CONNECTION_DESTROYED 127.0.0.1:6432'), { code: 'CONNECTION_DESTROYED' })
      : new Error('write CONNECTION_DESTROYED 127.0.0.1:6432');

  const api = (runGovernedOperation: unknown) => ({
    admissionContextFromEnvironment: vi.fn(() => undefined),
    governedExecutionLeaseTtlForTimeout: vi.fn(() => 1000),
    runGovernedOperation,
  });

  const baseOptions = (extra: Record<string, unknown> = {}) => ({
    workspaceId: 'ws',
    env: {},
    owner: 'runner',
    timeoutMs: 1000,
    // Injected so bounded-retry assertions cost no wall-clock.
    sleep: async () => {},
    ...extra,
  });

  it('retries a retryable admission failure and then succeeds', async () => {
    const logged: string[] = [];
    let calls = 0;
    const runGovernedOperation = vi.fn(async (_input: unknown, run: (ctx: typeof context) => Promise<unknown>) => {
      calls += 1;
      if (calls < 3) throw contention('55P03');
      return run(context);
    });

    const result = await runGovernedTestProcess(
      baseOptions({ executionApi: api(runGovernedOperation), log: (line: string) => logged.push(line) }),
      async () => 'child ran',
    );

    expect(result).toBe('child ran');
    expect(calls).toBe(3);
    // The retry must be VISIBLE: a silent one hides fleet-wide DB contention.
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain('GOVERNED_ADMISSION_RETRY');
    expect(logged[0]).toContain('attempt=2/3');
    expect(logged[0]).toContain('pgCode=55P03');
    const keys = runGovernedOperation.mock.calls.map(([input]) => (input as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size, 'unconfirmed/pre-admission failures retain the same idempotency identity').toBe(1);
  });

  it('renews each confirmed cancelled receipt before retrying and launches one child', async () => {
    const cancelled = new Set<string>();
    const keys: string[] = [];
    const logged: string[] = [];
    let launches = 0;
    const runGovernedOperation = vi.fn(async (input: { idempotencyKey: string }, run: (ctx: typeof context) => Promise<unknown>) => {
      keys.push(input.idempotencyKey);
      if (cancelled.has(input.idempotencyKey)) throw new Error('cancelled durable receipt is not leaseable');
      if (keys.length < 3) {
        cancelled.add(input.idempotencyKey);
        throw Object.assign(contention('57014'), {
          governedAdmissionStartFailure: {
            contractVersion: 1, idempotencyKey: input.idempotencyKey, receiptId: `receipt-${keys.length}`,
            state: 'cancelled', cancellationVerified: true,
          },
        });
      }
      return run(context);
    });
    const result = await runGovernedTestProcess(
      baseOptions({ executionApi: api(runGovernedOperation), idempotencyKey: 'initial-key', log: (line: string) => logged.push(line) }),
      async () => { launches++; return 'child ran'; },
    );
    expect(result).toBe('child ran');
    expect(keys[0]).toBe('initial-key');
    expect(new Set(keys).size).toBe(3);
    expect(launches).toBe(1);
    expect(logged[0]).toContain('cancelledReceipt=receipt-1 receiptRenewed=true');
  });

  it.each(['unconfirmed', 'wrong-key', 'wrong-state', 'wrong-contract', 'missing-receipt'])(
    'fails closed on %s cancellation evidence before creating another receipt',
    async (mode) => {
      const error = Object.assign(contention('57014'), {
        governedAdmissionStartFailure: {
          contractVersion: mode === 'wrong-contract' ? 2 : 1,
          idempotencyKey: mode === 'wrong-key' ? 'other-key' : 'initial-key',
          receiptId: mode === 'missing-receipt' ? '' : 'receipt-1',
          state: mode === 'wrong-state' ? 'running' : 'cancelled',
          cancellationVerified: mode !== 'unconfirmed',
        },
      });
      const runGovernedOperation = vi.fn(async () => { throw error; });
      const child = vi.fn(async () => 'child ran');
      await expect(runGovernedTestProcess(
        baseOptions({ executionApi: api(runGovernedOperation), idempotencyKey: 'initial-key', log: () => {} }), child,
      )).rejects.toBe(error);
      expect(runGovernedOperation).toHaveBeenCalledTimes(1);
      expect(child).not.toHaveBeenCalled();
    },
  );

  it('retries a postgres.js CONNECTION_DESTROYED admission failure before launching the child', async () => {
    let calls = 0;
    const runGovernedOperation = vi.fn(async (_input: unknown, run: (ctx: typeof context) => Promise<unknown>) => {
      calls += 1;
      if (calls === 1) throw connectionDestroyed();
      return run(context);
    });

    const result = await runGovernedTestProcess(
      baseOptions({ executionApi: api(runGovernedOperation), log: () => {} }),
      async () => 'child ran',
    );

    expect(result).toBe('child ran');
    expect(calls).toBe(2);
  });

  it('NEVER retries once the child has started, even for a retryable error', async () => {
    // The safety constraint. The error here is retryable BY CODE, so if `started` were
    // not dominant this would retry and re-run the tests.
    let launches = 0;
    const runGovernedOperation = vi.fn(async (_input: unknown, run: (ctx: typeof context) => Promise<unknown>) => {
      await run(context);
      throw contention('55P03');
    });

    await expect(
      runGovernedTestProcess(baseOptions({ executionApi: api(runGovernedOperation), log: () => {} }), async () => {
        launches += 1;
        return 'child ran';
      }),
    ).rejects.toThrow(/retry shortly/);

    expect(launches, 'the child must run exactly once — a retry here would re-run tests').toBe(1);
    expect(runGovernedOperation).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure the database did not mark retryable', async () => {
    const runGovernedOperation = vi.fn(async () => {
      throw Object.assign(new Error('governor refused: over capacity'), { pgCode: '42P01' });
    });
    await expect(
      runGovernedTestProcess(baseOptions({ executionApi: api(runGovernedOperation) }), async () => 'child ran'),
    ).rejects.toThrow(/over capacity/);
    expect(runGovernedOperation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt bound and rethrows the original error', async () => {
    const runGovernedOperation = vi.fn(async () => {
      throw contention('57014');
    });
    await expect(
      runGovernedTestProcess(
        baseOptions({ executionApi: api(runGovernedOperation), admissionRetryAttempts: 2, log: () => {} }),
        async () => 'child ran',
      ),
    ).rejects.toThrow(/57014/);
    // Bounded: the point is to ride out contention, not to retry forever.
    expect(runGovernedOperation).toHaveBeenCalledTimes(2);
  });

  it('takes no admission at all on the inherited path, so there is nothing to retry', async () => {
    const runGovernedOperation = vi.fn();
    const executionApi = {
      admissionContextFromEnvironment: vi.fn(() => context),
      governedExecutionLeaseTtlForTimeout: vi.fn(() => 1000),
      runGovernedOperation,
    };
    const result = await runGovernedTestProcess(
      baseOptions({ executionApi, env: { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(context) } }),
      async () => 'child ran',
    );
    expect(result).toBe('child ran');
    expect(runGovernedOperation).not.toHaveBeenCalled();
  });

  it('detects retryability by PROPERTY and through a wrapped cause chain', () => {
    // `instanceof` would answer false across a duplicated module record — the failure
    // direction that looks exactly like "not retryable", i.e. like the bug being unfixed.
    expect(isRetryableAdmissionFailure(contention('55P03'))).toBe(true);
    expect(isRetryableAdmissionFailure(contention('57014'))).toBe(true);
    expect(isRetryableAdmissionFailure(connectionDestroyed())).toBe(true);
    expect(isRetryableAdmissionFailure(connectionDestroyed('message'))).toBe(true);
    expect(isRetryableAdmissionFailure({ code: 'CONNECTION_ENDED' })).toBe(true);
    expect(isRetryableAdmissionFailure({ pgCode: '55P03' })).toBe(true);
    expect(
      isRetryableAdmissionFailure(Object.assign(new Error('wrapped'), { cause: contention('55P03') })),
      'the governor may wrap the originating PG error rather than rethrow it',
    ).toBe(true);

    expect(isRetryableAdmissionFailure(new Error('plain'))).toBe(false);
    expect(isRetryableAdmissionFailure({ pgCode: '42P01' })).toBe(false);
    expect(isRetryableAdmissionFailure({ code: 'ECONNRESET' })).toBe(false);
    expect(isRetryableAdmissionFailure(null)).toBe(false);
    expect(isRetryableAdmissionFailure(undefined)).toBe(false);
    // A name alone is not evidence: the contention CODE is what carries the meaning.
    expect(isRetryableAdmissionFailure({ name: 'OrgTxnTimeoutError' })).toBe(false);
  });

  it('terminates on a cyclic cause chain instead of hanging', () => {
    const a: Record<string, unknown> = { name: 'A' };
    const b: Record<string, unknown> = { name: 'B', cause: a };
    a.cause = b;
    expect(isRetryableAdmissionFailure(a)).toBe(false);
  });
});

/**
 * WI-10004924 — the sampler finds one tree by walking its children files instead of reading
 * /proc/<pid>/status for every pid on the host.  The host-wide scan is the oracle: on a live,
 * static tree the walk must return the same pids, grandchildren included.
 */
describe.skipIf(process.platform !== 'linux')('process-tree discovery (WI-10004924)', () => {
  const sorted = (pids: number[]) => [...pids].sort((x, y) => x - y);

  async function withLiveTree(body: (rootPid: number) => void) {
    // root sh -> sleep, and root sh -> subshell -> sleep (the grandchild).
    const child = spawn('sh', ['-c', 'sleep 30 & (sleep 30; true) & wait'], { stdio: 'ignore' });
    const rootPid = child.pid!;
    try {
      const deadline = Date.now() + 5_000;
      while (resolveGovernedProcessTree(rootPid, { method: 'scan' }).pids.length < 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      body(rootPid);
    } finally {
      for (const pid of resolveGovernedProcessTree(rootPid, { method: 'scan' }).pids.reverse()) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }

  it('walks the tree, grandchild included, and matches the host-wide scan', async () => {
    await withLiveTree((rootPid) => {
      const scan = resolveGovernedProcessTree(rootPid, { method: 'scan' });
      const walk = resolveGovernedProcessTree(rootPid);
      expect(scan.method).toBe('scan');
      expect(walk.method).toBe('walk');
      expect(scan.pids).toHaveLength(4);
      expect(sorted(walk.pids)).toEqual(sorted(scan.pids));
      expect(walk.pids[0]).toBe(rootPid);
    });
  });

  it('falls back to the scan when the kernel has no children files', async () => {
    await withLiveTree((rootPid) => {
      const fallback = resolveGovernedProcessTree(rootPid, { readChildren: () => null });
      expect(fallback.method).toBe('scan');
      expect(sorted(fallback.pids)).toEqual(sorted(resolveGovernedProcessTree(rootPid, { method: 'scan' }).pids));
    });
  });

  it('hands a tree larger than the pid cap to the scan', async () => {
    await withLiveTree((rootPid) => {
      const capped = resolveGovernedProcessTree(rootPid, { pidCap: 2 });
      expect(capped.method).toBe('scan');
      expect(capped.pids).toHaveLength(4);
    });
    expect(GOVERNED_PROCESS_TREE_WALK_PID_CAP).toBeGreaterThanOrEqual(64);
  });

  it('treats an exited root as a childless tree, like the scan does', () => {
    const exited = spawnSync('true').pid!;
    expect(resolveGovernedProcessTree(exited)).toEqual({ pids: [exited], method: 'walk' });
    expect(resolveGovernedProcessTree(exited, { method: 'scan' }).pids).toEqual([exited]);
  });
});
