/**
 * MCP transport P2-5 deadline path — HANDLER-LEVEL coverage for the two
 * claims that rode on `raced.{toolOutcome,deadlineFired}` untested (WI-6914,
 * filed while closing WI-6868's closure-narrowing fix on that same holder
 * object):
 *
 *   1. On a deadline, the caller is answered immediately with a clean
 *      `request_timeout` error — the tool keeps running server-side, and its
 *      eventual replay-receipt persist does NOT re-block the response
 *      (`if (!raced.deadlineFired) await persist;` in _mcp-handler.ts).
 *   2. The receipt persisted once the tool finishes is the tool's REAL
 *      outcome, never the raced timeout envelope (EI-19301511582594101:
 *      "persisting the raced timeout envelope would make every retry replay
 *      the timeout instead of the real outcome" — `raced.toolOutcome`, never
 *      `dispatched`, is what gets stored).
 *
 * `__tests__/mcp-deadline.test.ts` already pins `raceDeadline` /
 * `effectiveMcpDeadlineMs` as ISOLATED units — no handler, no receipt
 * (op cit., grep for replay|store|persist there finds nothing).
 * `mcp-handler-gating-matrix.test.ts` drives the real handler and covers the
 * replay-receipt commit-then-store ORDERING, but never enters the deadline
 * branch at all (grep for 'deadline' in that file finds nothing) — every
 * case there takes the normal (non-deadline) path.
 *
 * This file closes exactly that gap, at the SAME "drive the real registered
 * tools/call handler" level gating-matrix uses (same seam mocks, same
 * `callTool` shape) — but as its OWN small, dedicated file rather than
 * bolted onto the shared 96-test gating-matrix file. `MCP_DEADLINE_MS` is a
 * module-load-time const read from `PAPERCUSP_MCP_DEADLINE_MS`
 * (`effectiveMcpDeadlineMs(projected.timeoutSec)` only ever RAISES it, never
 * lowers it below the base — see the WI-6914 filing), so it must be set
 * BEFORE `_mcp-handler` is imported; retrofitting that into gating-matrix's
 * shared 96 tests would apply the short deadline file-wide and risk flaking
 * unrelated cases under fleet load. A separate file with its own module
 * instance avoids that entirely.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetVerifiedSpawns } from '../../spawn-signing';
import { MCP_REQUEST_TRACE_HEADER } from '../../mcp-request-trace';
import { _resetScratchUsageForTests, _setScratchUsageForTests, WORKSPACE_QUOTA_BYTES, type ScratchWriteTimings } from '../../scratch-gc';
import { parseScratchReference } from '../../scratch-reference';
import type { McpCallResult } from '../routes/transport/mcp-diagnostic-warnings';

const h = vi.hoisted(() => {
  const unsafeCalls: Array<{ sql: string; params: unknown[] }> = [];
  const fakeTx = Object.assign(async (..._a: unknown[]) => [] as unknown[], {
    unsafe: async (...args: unknown[]) => {
      const [sql, params] = args;
      if (typeof sql === 'string') {
        unsafeCalls.push({ sql, params: Array.isArray(params) ? params : [] });
      }
      return [] as unknown[];
    },
  });
  const fakeReservedSql = Object.assign(async (..._a: unknown[]) => [] as unknown[], {
    release: () => {},
  });
  const fakeSql = Object.assign(async (..._a: unknown[]) => [] as unknown[], {
    unsafe: async (..._a: unknown[]) => [] as unknown[],
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeTx),
    reserve: async () => fakeReservedSql,
  });
  return {
    fakeTx,
    fakeSql,
    unsafeCalls,
    withWorkspaceCalls: [] as string[],
    withWorkspaceDelayMs: 0,
    commitFailure: null as Error | null,
    txEvents: [] as string[],
    replayStores: [] as Array<{ idempotencyKey: string; result: unknown }>,
    storedReplay: null as {
      content: Array<Record<string, unknown>>;
      structuredContent?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    } | null,
    invocations: [] as unknown[],
    telemetryGate: null as Promise<void> | null,
    telemetryEntered: null as (() => void) | null,
    resultDoorGate: null as Promise<void> | null,
    resultDoorEntered: null as (() => void) | null,
    progressCalls: 0,
    pendingEntered: null as (() => void) | null,
    pendingResolve: null as (() => void) | null,
    resultDoorDelayMs: 0,
    resultDoorCalls: 0,
    resultDoorRequestTraceIds: [] as Array<string | null>,
    scratchWriteTimings: [] as ScratchWriteTimings[],
    realScratchWriteTimings: [] as ScratchWriteTimings[],
    captureScratchWriteTimings: false,
    spillWriteGate: null as Promise<void> | null,
    spillWriteEntered: null as (() => void) | null,
    spillToolGate: null as Promise<void> | null,
    spillToolEntered: null as (() => void) | null,
    spillWritePathSegment: 'deadlinetest:spill',
    spillPaths: [] as string[],
    handlers: new Map<string, (req: unknown, extra: unknown) => Promise<unknown>>(),
    verifySpawnParams: vi.fn(
      async (_u: unknown): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }),
    ),
    logVerificationFailure: vi.fn(async (_rec: unknown): Promise<void> => {}),
    verifyAccessToken: vi.fn(
      async (_bearer: string): Promise<Record<string, unknown> | null> => null,
    ),
    isValidSuperuserBearer: vi.fn(
      (bearer: string | null | undefined): boolean => bearer === 'test-su-bearer',
    ),
    workspaceForCoordOwner: vi.fn(async (_sid: string): Promise<string | null> => null),
    potHomeSlugForHarness: vi.fn(async (): Promise<string | null> => null),
    resolveWorkspaceForHarnessSlugIn: vi.fn(
      async (preferredWs: string): Promise<string | null> => preferredWs,
    ),
  };
});

// This handler fixture registers its own real projected probe tools below,
// plus the production wrapper exercised by the nested-call cases.
// Loading the application catalogue adds unrelated tools and their full import
// graph before any case can execute; catalogue loading has its own suite.
vi.mock('../../agent-tools/operator-tool-catalogue', () => ({
  loadOperatorToolCatalogue: async () => { await import('../../agent-tools/tools/invoke'); },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
      const path = String(args[0]);
      if (h.spillWriteGate && path.includes(`/${h.spillWritePathSegment}/`)) {
        h.spillPaths.push(path);
        h.spillWriteEntered?.();
        await h.spillWriteGate;
      }
      return actual.writeFile(...args);
    },
  };
});

// Same capture shim gating-matrix.test.ts uses — no real streamable-HTTP transport.
vi.mock('mcp-handler', () => ({
  createMcpHandler: (
    setup: (server: {
      server: { setRequestHandler: (schema: unknown, fn: unknown) => void };
    }) => void,
  ) => {
    setup({
      server: {
        setRequestHandler: (schema: unknown, fn: unknown) => {
          const s = schema as {
            shape?: { method?: { value?: string; _def?: { value?: string } } };
          };
          const method = s?.shape?.method?.value ?? s?.shape?.method?._def?.value;
          h.handlers.set(String(method), fn as (req: unknown, extra: unknown) => Promise<unknown>);
        },
      },
    });
    return async () => new Response(null);
  },
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.fakeSql }),
    withWorkspace: async <T>(ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      h.withWorkspaceCalls.push(ws);
      if (h.withWorkspaceDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, h.withWorkspaceDelayMs));
      }
      const out = await fn(h.fakeTx);
      if (h.commitFailure) throw h.commitFailure;
      h.txEvents.push('commit');
      return out;
    },
  };
});
// The seam under test: capture every persisted replay receipt, plain functions
// (not vi.fn()) so beforeEach's vi.resetAllMocks() cannot strip the impl out
// from under the assertions — the same reason gating-matrix.test.ts does this.
vi.mock('../routes/transport/_mcp-result-replay', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    lookupStoredMcpResult: async (): Promise<Record<string, unknown> | null> =>
      h.storedReplay
        ? { ...h.storedReplay, _meta: { ...(h.storedReplay._meta ?? {}), replayed: true } }
        : null,
    storeMcpResult: async (a: { idempotencyKey: string; result: unknown }): Promise<void> => {
      h.txEvents.push('store');
      h.replayStores.push({ idempotencyKey: a.idempotencyKey, result: a.result });
    },
  };
});
vi.mock('../../result-door', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const applyResultDoorAsync = actual.applyResultDoorAsync as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    applyResultDoorAsync: async (...args: unknown[]): Promise<unknown> => {
      h.resultDoorCalls += 1;
      h.resultDoorEntered?.();
      if (h.resultDoorGate) await h.resultDoorGate;
      if (h.resultDoorDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, h.resultDoorDelayMs));
      }
      const opts = args[1] as {
        onScratchWriteTiming?: (timings: typeof h.scratchWriteTimings[number]) => void;
        requestTraceId?: string;
      };
      h.resultDoorRequestTraceIds.push(opts.requestTraceId ?? null);
      for (const timing of h.scratchWriteTimings) opts.onScratchWriteTiming?.(timing);
      if (h.captureScratchWriteTimings) {
        return applyResultDoorAsync(args[0], {
          ...opts,
          onScratchWriteTiming: (timings: ScratchWriteTimings) => {
            h.realScratchWriteTimings.push(timings);
            opts.onScratchWriteTiming?.(timings);
          },
        });
      }
      return applyResultDoorAsync(...args);
    },
  };
});
vi.mock('../../projected-tool-deps', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realDeps = actual.PROJECTED_DEPS as Record<string, unknown>;
  return {
    ...actual,
    PROJECTED_DEPS: {
      ...realDeps,
      recordInvocation: async (input: unknown): Promise<void> => {
        h.invocations.push(input);
        h.telemetryEntered?.();
        if (h.telemetryGate) await h.telemetryGate;
      },
    },
  };
});
vi.mock('../../spawn-signing', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, verifySpawnParams: h.verifySpawnParams, logVerificationFailure: h.logVerificationFailure };
});
vi.mock('../../power-user-token', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, verifyAccessToken: h.verifyAccessToken };
});
vi.mock('../../superuser-token', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isValidSuperuserBearer: h.isValidSuperuserBearer };
});
vi.mock('../../adv-sessions', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, workspaceForCoordOwner: h.workspaceForCoordOwner };
});
vi.mock('../../resolve-harness-paths', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveHarnessPaths: async () => ({
      projectDir: '/tmp/mcp-deadline-receipt-proj',
      stateDir: '/tmp/mcp-deadline-receipt-state',
    }),
  };
});
vi.mock('../../hive-federation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, potHomeSlugForHarness: h.potHomeSlugForHarness };
});
vi.mock('../../harness-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveWorkspaceForHarnessSlugIn: h.resolveWorkspaceForHarnessSlugIn };
});

(globalThis as { require?: NodeJS.Require }).require ??= createRequire(import.meta.url);
process.env.AGENT_MCP_TOOL_MANIFEST = '/nonexistent/mcp-deadline-receipt-no-manifest.json';
delete process.env.PAPERCUSP_REQUIRE_SPAWN_SIG;
// The whole point of this file existing separately from gating-matrix.test.ts:
// MCP_DEADLINE_MS is read ONCE at module load, so this must be set before the
// import below — and setting it here applies ONLY to this file's own module
// instance, never to gating-matrix's other 96 cases.
// The progress path measured 32ms on this runner with a 25ms budget, so leave
// headroom for ordinary filesystem work while keeping the deadline below the slow fixture.
const TEST_DEADLINE_MS = 100;
process.env.PAPERCUSP_MCP_DEADLINE_MS = String(TEST_DEADLINE_MS);

const { mcpHandler } = await import('../routes/transport/_mcp-handler');
// `_mcp-handler` defers the host and mcp-handler construction until the first
// request so importing pure helpers remains one-shot and side-effect-free.
// Warm the production path once before reading the handlers captured by the
// mocked adapter below.
// A LOCAL caller: a real one always sends a loopback Host, and a host-less outside request is
// answered at the edge with the P-006 OAuth 401 before the host (and its handlers) ever load.
await mcpHandler(new Request('http://127.0.0.1/api/mcp', { headers: { host: '127.0.0.1' } }));
const { registerProjectedTool, unregisterProjectedToolsForPlugin, lookupByMcpName } = await import('@papercusp/agent-mcp');
if (!lookupByMcpName('tools:invoke')) {
  throw new Error('Deadline handler fixture requires the production tools:invoke wrapper');
}

/* ─── One synthetic probe: sleeps well past the deadline, then returns a
 *     result distinguishable from the timeout envelope. ────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForSignal<T>(
  signal: Promise<T>,
  label: string,
  timeoutMs = 5_000,
  diagnostics?: () => unknown,
): Promise<T> {
  let poll: NodeJS.Immediate | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (Date.now() >= deadline) {
        let detail = '';
        try {
          if (diagnostics) detail = `; diagnostics=${JSON.stringify(diagnostics())}`;
        } catch {
          detail = '; diagnostics unavailable';
        }
        reject(new Error(`${label} was not received within ${timeoutMs}ms${detail}`));
        return;
      }
      poll = setImmediate(check);
    };
    poll = setImmediate(check);
  });
  return Promise.race([signal, timeout]).finally(() => {
    if (poll) clearImmediate(poll);
  });
}

const SLOW_TOOL_MS = 500; // five multiples of TEST_DEADLINE_MS
const REAL_OUTCOME_TEXT = 'deadlinetest-real-outcome-not-a-timeout';
let slowCalls = 0;
let syntheticAbortCalls = 0;

registerProjectedTool({
  pluginName: 'mcp-deadline-receipt-test',
  description: 'test-only probe: sleeps past the P2-5 deadline, then resolves with a distinct real result',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'deadlinetest:slow' } },
  fn: async () => {
    slowCalls += 1;
    await sleep(SLOW_TOOL_MS);
    return { content: [{ type: 'text' as const, text: REAL_OUTCOME_TEXT }] };
  },
});

registerProjectedTool({
  pluginName: 'mcp-deadline-receipt-test',
  description: 'test-only probe: remains pending until resolved, for progress-heartbeat coverage',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['scoper'],
  timeoutSec: 60,
  expose: { mcp: { name: 'deadlinetest:pending' } },
  fn: async () => {
    h.pendingEntered?.();
    return await new Promise<{ content: Array<{ type: 'text'; text: string }> }>((resolve) => {
      h.pendingResolve = () => resolve({ content: [{ type: 'text', text: 'pending-fixture-settled' }] });
    });
  },
});

const SPILL_CHECKPOINT = 'mcp-real-spill-checkpoint-evidence\n'.repeat(2_000);
registerProjectedTool({
  pluginName: 'mcp-deadline-receipt-test',
  description: 'test-only probe: oversized checkpoint-shaped result for real scratch-write phase attribution',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'deadlinetest:spill' } },
  fn: async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({
    ok: true, results: [{ id: 'EI-mcp-spill-test', checkpoint: SPILL_CHECKPOINT }],
  }) }] }),
});

registerProjectedTool({
  pluginName: 'mcp-deadline-receipt-test',
  description: 'test-only probe: small result for synthetic scratch-progress callback coverage',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'deadlinetest:progress' } },
  fn: async () => {
    h.progressCalls += 1;
    return { content: [{ type: 'text' as const, text: 'synthetic-progress-fixture' }] };
  },
});

const SYNTHETIC_COORD_SEND_ABORT = {
  ok: false,
  partial: true,
  results: [{ ok: false, to: ['synthetic-recipient-fixture'], error: 'request_aborted' }],
  counts: { ok: 0, failed: 1 },
  deliveryFailureWarning: 'coord:send completed the batch with a failed delivery: request_aborted',
};
registerProjectedTool({
  pluginName: 'mcp-deadline-receipt-test',
  description: 'test-only synthetic coord:send pre-persist abort result for MCP same-key replay coverage',
  inputSchema: { type: 'object', additionalProperties: false },
  outputJsonSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      partial: { type: 'boolean' },
      results: { type: 'array', items: { type: 'object', additionalProperties: true } },
      counts: { type: 'object', additionalProperties: true },
      deliveryFailureWarning: { type: 'string' },
    },
    required: ['ok', 'partial', 'results', 'counts', 'deliveryFailureWarning'],
    additionalProperties: true,
  },
  capabilities: [],
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'deadlinetest:coord-send-abort' } },
  fn: async () => {
    syntheticAbortCalls += 1;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(SYNTHETIC_COORD_SEND_ABORT) }],
      structuredContent: SYNTHETIC_COORD_SEND_ABORT,
      _meta: { format: 'json' },
    };
  },
});

afterAll(() => {
  unregisterProjectedToolsForPlugin('mcp-deadline-receipt-test');
});

const MCP = 'http://127.0.0.1:3070/api/mcp';

function extraFor(url: string, headers: Record<string, string> = {}): Record<string, unknown> {
  return { requestInfo: { url, headers: { host: '127.0.0.1:3070', ...headers } } };
}
function superuserExtra(query = '', headers: Record<string, string> = {}): Record<string, unknown> {
  return extraFor(`${MCP}?superuser=1${query}`, { authorization: 'Bearer test-su-bearer', ...headers });
}

/**
 * DERIVED from the transport's own `McpCallResult` — see the same derivation in
 * mcp-handler-gating-matrix.test.ts. This file carried a byte-identical
 * hand-mirrored copy of that shape, so it was one asserted field away from the
 * same TS2339 drift (EI-21573072389650825); deriving it closes that off here
 * too rather than leaving the second copy armed.
 *
 * `content` is deliberately re-narrowed to the text-bearing shape these tests
 * assert on; the production union widens it to `Record<string, unknown>`.
 */
type CallResult = Omit<McpCallResult, 'content'> & {
  content: Array<{ type: string; text?: string }>;
};
async function callTool(
  name: string,
  args: Record<string, unknown>,
  extra: unknown,
  meta?: Record<string, unknown>,
): Promise<CallResult> {
  return (await h.handlers.get('tools/call')!(
    { params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } },
    extra,
  )) as CallResult;
}
const textOf = (r: CallResult): string => r.content.map((c) => c.text ?? '').join('');

function traceEvents(calls: readonly unknown[][]): Array<Record<string, unknown>> {
  return calls.flatMap((call) => {
    const line = String(call[0] ?? '');
    const prefix = '[mcp-request-trace] ';
    if (!line.startsWith(prefix)) return [];
    try {
      return [JSON.parse(line.slice(prefix.length)) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  slowCalls = 0;
  syntheticAbortCalls = 0;
  h.withWorkspaceCalls.length = 0;
  h.withWorkspaceDelayMs = 0;
  h.commitFailure = null;
  h.txEvents.length = 0;
  h.replayStores.length = 0;
  h.storedReplay = null;
  h.invocations.length = 0;
  h.telemetryGate = null;
  h.telemetryEntered = null;
  h.resultDoorGate = null;
  h.resultDoorEntered = null;
  h.progressCalls = 0;
  h.pendingEntered = null;
  h.pendingResolve = null;
  h.unsafeCalls.length = 0;
  h.resultDoorDelayMs = 0;
  h.scratchWriteTimings = [];
  h.realScratchWriteTimings = [];
  h.captureScratchWriteTimings = false;
  h.spillWriteGate = null;
  h.spillWriteEntered = null;
  h.spillToolGate = null;
  h.spillToolEntered = null;
  h.spillWritePathSegment = 'deadlinetest:spill';
  h.spillPaths = [];
  h.resultDoorCalls = 0;
  h.resultDoorRequestTraceIds.length = 0;
  delete process.env.PAPERCUSP_REQUIRE_SPAWN_SIG;
  _resetVerifiedSpawns();
});

// The 'slow' probe's whole point is to keep running — and its background
// persist landing — AFTER a test's own assertions finish. Left undrained,
// that pending timer fires during the NEXT test and leaks a storeMcpResult
// call into ITS freshly-reset h.replayStores (observed: a later test's poll
// picked up an earlier test's residual entry by array index). Draining here,
// past every real timer this file arms (deadline + slow-tool completion),
// guarantees each test starts with no async work still in flight.
afterEach(async () => {
  await sleep(SLOW_TOOL_MS + 100);
});

registerProjectedTool({
  pluginName: 'mcp-deadline-receipt-test',
  description: 'test-only probe: returns an oversized checkpoint after the request deadline',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'deadlinetest:late-spill' } },
  fn: async () => {
    h.spillToolEntered?.();
    await h.spillToolGate;
    return { content: [{ type: 'text' as const, text: JSON.stringify({
      ok: true, results: [{ id: 'EI-mcp-spill-test', checkpoint: SPILL_CHECKPOINT }],
    }) }] };
  },
});

describe('P2-5 deadline path — background persist + real-outcome receipt (WI-6914)', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  it('attributes pre-dispatch time to the workspace principal transaction and persists the phase profile', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const traceId = 'c8b63439-fd54-44e4-ae1d-a78246337d54';
    const forcedWorkspaceWaitMs = 35;
    h.withWorkspaceDelayMs = forcedWorkspaceWaitMs;
    try {
      const result = await callTool(
        'deadlinetest:progress',
        {},
        superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
      );
      expect(result.isError).not.toBe(true);
      expect(h.withWorkspaceCalls).toContain('ws-test');

      const started = traceEvents(info.mock.calls).find((event) =>
        event.traceId === traceId && event.stage === 'inner_dispatch_started',
      );
      expect(started?.preDispatchPhaseTimingsMs).toMatchObject({
        operatorToolsLoad: expect.any(Number),
        spawnContext: expect.any(Number),
        transportScopeSetup: expect.any(Number),
        toolContextBuild: expect.any(Number),
        idempotencyReplayLookup: null,
        dispatchPreflight: expect.any(Number),
        unattributedMs: expect.any(Number),
      });
      const startedProfile = started?.preDispatchPhaseTimingsMs as Record<string, number | null>;
      expect(Number(startedProfile.dispatchPreflight)).toBeGreaterThanOrEqual(forcedWorkspaceWaitMs - 5);

      await vi.waitFor(() => {
        const settled = traceEvents(info.mock.calls).find((event) =>
          event.traceId === traceId && event.stage === 'inner_dispatch_settled',
        );
        expect(settled?.preDispatchPhaseTimingsMs).toEqual(startedProfile);
      });

      let persistedSettlement: { sql: string; params: unknown[] } | undefined;
      await vi.waitFor(() => {
        persistedSettlement = h.unsafeCalls.find((call) =>
          call.sql.includes('UPDATE harness_shared.tool_invocations') &&
          call.sql.includes("metadata_json->'requestOrigin'->>'mcpRequestTraceId' = $4"),
        );
        expect(persistedSettlement).toBeDefined();
      });
      const settlementMetadata = JSON.parse(String(persistedSettlement?.params[0])).mcpRequestSettlement;
      expect(settlementMetadata.preDispatchPhaseTimingsMs).toEqual(startedProfile);
    } finally {
      info.mockRestore();
    }
  });

  it('answers with a clean request_timeout error once the deadline fires, without waiting for the tool', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), { idempotencyKey: 'idem-deadline-1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('request_timeout');
    expect(textOf(res)).toContain('deadlinetest:slow');
    expect(textOf(res)).toContain(`${TEST_DEADLINE_MS}ms`);
    expect(textOf(res)).toContain('commit status is UNKNOWN');
    expect(textOf(res)).toContain('re-read the current state');
    // Idempotency-key-aware wording (the two branches in _mcp-handler.ts differ
    // on whether a key was supplied) — this call passed one.
    expect(textOf(res)).toContain('retry with the same _meta.idempotencyKey');
    // EI-21570323060383850 / EI-21570305229276182: the instruction must name the key it is
    // telling the caller to reuse. The client injects the key on every call, so an agent
    // reading this error has never seen its value; both items were filed by callers who tried
    // to comply, found no key in the envelope, and fell back to reconciling by hand. Asserting
    // the literal VALUE (not just the phrase above) is what makes that non-recurrable.
    expect(textOf(res)).toContain('idem-deadline-1');
  });

  it('carries the outer MCP trace through a nested timeout response and receipt', async () => {
    const traceId = '4d00f8ca-ec62-44e8-ae33-97e0d9d8a3a1';
    const res = await callTool(
      'tools:invoke',
      { name: 'deadlinetest:slow', args: {} },
      superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('request_timeout');
    expect(textOf(res)).toContain('nested tool "deadlinetest:slow"');
    expect(textOf(res)).toContain(`request trace id: ${traceId}`);
    expect(res._meta?.abortCompletionReceipt).toMatchObject({
      status: 'recovery-incomplete',
      mcpRequestTraceId: traceId,
    });
  });

  it.each([
    [undefined, undefined, 0],
    [0, 0, 0],
    [5, 7, 12],
  ] as const)('correlates the forwarded trace id across request start, deadline, and late handler settlement with %s and %s data-lease waits', async (firstLeaseWaitMs, secondLeaseWaitMs, totalLeaseWaitMs) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const traceId = 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e';
    const resultDoorDelayMs = 45;
    h.resultDoorDelayMs = resultDoorDelayMs;
    h.scratchWriteTimings = [
      {
        quotaWaitMs: 25, refreshWaitMs: 0, quotaRecoveryMs: 0,
        dataLeaseWaitMs: firstLeaseWaitMs, writeMs: 4, totalMs: 29 + (firstLeaseWaitMs ?? 0),
        quotaRecoveryDiagnostics: {
          sizeWalkMs: 4, sizeWalkDirectories: 2, sizeWalkEntries: 5, sizeWalkFiles: 3,
          readdirOperations: 2, statOperations: 3, operationTotalMs: 5, maxOperationMs: 2,
          maxOperationKind: 'readdir', currentOperationKind: null, currentOperationPath: null, currentOperationElapsedMs: 0,
          firstOperationErrorCode: null, firstOperationErrorKind: null, firstOperationErrorPath: null,
          directoryReadErrors: 0, fileStatErrors: 1, runListingMs: 2, runsListed: 3,
          selectedRunSizingMs: 1, runsConsidered: 1, fallbackRunSizes: 1, deletionMs: 1,
          deletePreflightMs: 0, pinProtectionMs: 0, rmAsyncMs: 0, deletePreflightSkips: 0, lastDeletePreflightErrorCode: null,
          deleteAttempts: 1, deleteErrors: 1, lastDeleteErrorCode: 'EACCES', runsDeleted: 1, deletedBytes: 100,
        },
      },
      {
        quotaWaitMs: 0, refreshWaitMs: 3, quotaRecoveryMs: 10,
        dataLeaseWaitMs: secondLeaseWaitMs, writeMs: 2, totalMs: 15 + (secondLeaseWaitMs ?? 0),
        quotaRecoveryDiagnostics: {
          sizeWalkMs: 9, sizeWalkDirectories: 4, sizeWalkEntries: 8, sizeWalkFiles: 5,
          readdirOperations: 4, statOperations: 5, operationTotalMs: 8, maxOperationMs: 3,
          maxOperationKind: 'stat', currentOperationKind: null, currentOperationPath: null, currentOperationElapsedMs: 0,
          firstOperationErrorCode: null, firstOperationErrorKind: null, firstOperationErrorPath: null,
          directoryReadErrors: 1, fileStatErrors: 0, runListingMs: 5, runsListed: 6,
          selectedRunSizingMs: 2, runsConsidered: 2, fallbackRunSizes: 0, deletionMs: 3,
          deletePreflightMs: 0, pinProtectionMs: 0, rmAsyncMs: 0, deletePreflightSkips: 0, lastDeletePreflightErrorCode: null,
          deleteAttempts: 2, deleteErrors: 2, lastDeleteErrorCode: 'EPERM', runsDeleted: 2, deletedBytes: 200,
        },
      },
    ];
    try {
      const res = await callTool(
        'deadlinetest:slow',
        {},
        superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
      );
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('request_timeout');
      const beforeSettlement = traceEvents(info.mock.calls);
      expect(beforeSettlement).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            traceId,
            toolName: 'deadlinetest:slow',
            stage: 'request_started',
            elapsedMs: expect.any(Number),
          }),
          expect.objectContaining({ traceId, toolName: 'deadlinetest:slow', stage: 'inner_dispatch_started' }),
          expect.objectContaining({
            traceId,
            toolName: 'deadlinetest:slow',
            stage: 'deadline',
            phase: 'inner_dispatch',
            deadlineMs: TEST_DEADLINE_MS,
          }),
        ]),
      );
      expect(beforeSettlement.some((event) => event.stage === 'inner_dispatch_settled')).toBe(false);

      await sleep(SLOW_TOOL_MS + resultDoorDelayMs + 100);
      const settled = traceEvents(info.mock.calls).find((event) => event.stage === 'inner_dispatch_settled');
      expect(settled).toEqual(
        expect.objectContaining({
          traceId,
          toolName: 'deadlinetest:slow',
          outcome: 'success',
          elapsedMs: expect.any(Number),
          afterDeadline: true,
          phaseTimingsMs: expect.objectContaining({
            postDispatchToSettlement: expect.any(Number),
            resultDoor: expect.any(Number),
            advisory: expect.any(Number),
            advisoryFlagReads: expect.any(Number),
            scratchWrites: expect.objectContaining({
              count: 2, perSpill: h.scratchWriteTimings,
              quotaWaitMs: 25, refreshWaitMs: 3, quotaRecoveryMs: 10,
              dataLeaseWaitMs: totalLeaseWaitMs, writeMs: 6, totalMs: 44 + totalLeaseWaitMs,
              quotaRecoveryDiagnostics: expect.objectContaining({
                sizeWalkMs: 13, sizeWalkDirectories: 6, sizeWalkEntries: 13, sizeWalkFiles: 8,
                readdirOperations: 6, statOperations: 8, operationTotalMs: 13, maxOperationMs: 3,
                maxOperationKind: 'stat', currentOperationKind: null, currentOperationElapsedMs: 0,
                directoryReadErrors: 1, fileStatErrors: 1, runListingMs: 7, runsListed: 9,
                selectedRunSizingMs: 3, runsConsidered: 3, fallbackRunSizes: 1, deletionMs: 4,
                deleteAttempts: 3, deleteErrors: 3, lastDeleteErrorCode: 'EPERM', runsDeleted: 3, deletedBytes: 300,
              }),
            }),
          }),
        }),
      );
      expect(h.resultDoorCalls).toBeGreaterThan(0);
      expect(h.resultDoorRequestTraceIds).toContain(traceId);
      expect((settled?.phaseTimingsMs as { resultDoor?: number } | undefined)?.resultDoor)
        .toBeGreaterThanOrEqual(resultDoorDelayMs);
      expect(Number(settled?.elapsedMs)).toBeGreaterThanOrEqual(TEST_DEADLINE_MS);

      let persistedSettlement: { sql: string; params: unknown[] } | undefined;
      await vi.waitFor(() => {
        persistedSettlement = h.unsafeCalls.find((call) =>
          call.sql.includes('UPDATE harness_shared.tool_invocations') &&
          call.sql.includes("metadata_json->'requestOrigin'->>'mcpRequestTraceId' = $4"),
        );
        expect(persistedSettlement).toBeDefined();
      });
      expect(persistedSettlement?.params.slice(1)).toEqual(['ws-test', 'deadlinetest:slow', traceId, 900]);
      const settlementMetadata = JSON.parse(String(persistedSettlement?.params[0])).mcpRequestSettlement;
      expect(settlementMetadata).toEqual(expect.objectContaining({
        traceId,
        stage: 'inner_dispatch_settled',
        outcome: 'success',
        afterDeadline: true,
        elapsedMs: expect.any(Number),
        settledAt: expect.any(String),
        phaseTimingsMs: expect.objectContaining({
          resultDoor: expect.any(Number),
          scratchWrites: expect.objectContaining({
            count: 2, perSpill: h.scratchWriteTimings,
            dataLeaseWaitMs: totalLeaseWaitMs, totalMs: 44 + totalLeaseWaitMs,
          }),
        }),
      }));
    } finally {
      info.mockRestore();
    }
  });

  it.each(['telemetry', 'result-door'] as const)(
    'distinguishes a fast handler held at %s from an unfinished handler',
    async (phase) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const traceId = phase === 'telemetry'
        ? '48b44c43-41de-4ea0-8dd4-26a740052ab3'
        : '27f0e4f5-e02b-4320-a498-709140695eaf';
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const entry = new Promise<void>((resolve) => { entered = resolve; });
      if (phase === 'telemetry') {
        h.telemetryGate = gate;
        h.telemetryEntered = entered;
      } else {
        h.resultDoorGate = gate;
        h.resultDoorEntered = entered;
      }
      try {
        const response = callTool(
          'deadlinetest:progress', {},
          superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
        );
        await waitForSignal(entry, `${phase} entry`);
        const barrierObservedAtMs = Date.now();
        // The real dispatcher already ran the fast handler exactly once. The
        // controlled barrier is later, so a deadline cannot imply handler failure.
        expect(h.progressCalls).toBe(1);
        expect(h.invocations).toHaveLength(1);
        expect(h.resultDoorCalls).toBe(phase === 'telemetry' ? 0 : 1);
        const result = await response;
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('request_timeout');
        expect(traceEvents(info.mock.calls)).toEqual(expect.arrayContaining([
          expect.objectContaining({ traceId, stage: 'inner_dispatch_started' }),
          expect.objectContaining({ traceId, stage: 'deadline' }),
        ]));
        expect(traceEvents(info.mock.calls).some((event) =>
          event.traceId === traceId && event.stage === 'inner_dispatch_settled',
        )).toBe(false);

        const barrierHeldMs = Date.now() - barrierObservedAtMs;
        release();
        await vi.waitFor(() => {
          const settled = traceEvents(info.mock.calls).find((event) =>
            event.traceId === traceId && event.stage === 'inner_dispatch_settled',
          );
          expect(settled).toMatchObject({ outcome: 'success', afterDeadline: true });
          const timings = settled?.phaseTimingsMs as { resultDoor?: number; postDispatchToSettlement?: number };
          expect(timings.resultDoor).toEqual(expect.any(Number));
          expect(timings.postDispatchToSettlement).toBeGreaterThanOrEqual(timings.resultDoor!);
          // The phase starts after the request's deadline clock. Compare its
          // duration with the interval we actually held this phase's barrier.
          if (phase === 'result-door') expect(timings.resultDoor).toBeGreaterThanOrEqual(barrierHeldMs);
          expect(h.resultDoorRequestTraceIds).toContain(traceId);
        });
        expect(h.progressCalls).toBe(1);
        expect(h.invocations).toHaveLength(1);
      } finally {
        release();
        info.mockRestore();
      }
    },
  );

  it('a fast handler completes normally without a telemetry or result-door barrier', async () => {
    const result = await callTool('deadlinetest:progress', {}, scoped('ws-test'));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('synthetic-progress-fixture');
    expect(h.progressCalls).toBe(1);
    expect(h.invocations).toHaveLength(1);
    expect(h.resultDoorCalls).toBe(1);
  });

  it('sends bounded progress heartbeats for a pending MCP call and stops them on settlement', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let entered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { entered = resolve; });
    h.pendingEntered = entered;
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const progressToken = 'mcp-heartbeat-progress';
    const extra = {
      ...superuserExtra('&workspace=ws-test'),
      sendNotification: async (notification: { method: string; params: Record<string, unknown> }) => {
        notifications.push(notification);
      },
    };
    const response = callTool('deadlinetest:pending', {}, extra, { progressToken });

    try {
      await handlerEntered;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(notifications.filter((notification) => notification.method === 'notifications/progress')).toEqual([
        expect.objectContaining({
          method: 'notifications/progress',
          params: expect.objectContaining({
            progressToken,
            progress: 1,
            message: expect.stringContaining('still running (15s elapsed)'),
          }),
        }),
      ]);

      h.pendingResolve?.();
      const result = await response;
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('pending-fixture-settled');

      await vi.advanceTimersByTimeAsync(30_000);
      expect(notifications.filter((notification) => notification.method === 'notifications/progress')).toHaveLength(1);
    } finally {
      h.pendingResolve?.();
      await response.catch(() => {});
      vi.useRealTimers();
    }
  });

  it('forwards synthetic scratch progress to MCP clients that supplied a progress token', async () => {
    const progressToken = 'mcp-spill-progress';
    const traceId = '7c6a1e48-6764-4937-8b8e-f35fef8ea93d';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const extra = {
      ...superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
      sendNotification: async (notification: { method: string; params: Record<string, unknown> }) => {
        notifications.push(notification);
      },
    };
    h.scratchWriteTimings = [{
      quotaWaitMs: 0,
      refreshWaitMs: 0,
      quotaRecoveryMs: 5_000,
      writeMs: 0,
      totalMs: 5_000,
      progress: {
        phase: 'quota-recovery',
        phaseElapsedMs: 5_000,
        totalElapsedMs: 5_000,
        bytes: 60_000,
        pendingWrites: 1,
        recoveryActive: true,
        refreshActive: false,
        quotaRecoveryDiagnostics: {
          sizeWalkMs: 4,
          sizeWalkDirectories: 2,
          sizeWalkEntries: 3,
          sizeWalkFiles: 1,
          readdirOperations: 2,
          statOperations: 1,
          operationTotalMs: 7,
          maxOperationMs: 4,
          maxOperationKind: 'readdir',
          currentOperationKind: 'readdir',
          currentOperationPath: null,
          currentOperationElapsedMs: 250,
          firstOperationErrorCode: null,
          firstOperationErrorKind: null,
          firstOperationErrorPath: null,
          directoryReadErrors: 0,
          fileStatErrors: 0,
          runListingMs: 0,
          runsListed: 0,
          selectedRunSizingMs: 0,
          runsConsidered: 0,
          fallbackRunSizes: 0,
          deletionMs: 0,
          deletePreflightMs: 0,
          pinProtectionMs: 0,
          rmAsyncMs: 0,
          deletePreflightSkips: 0,
          lastDeletePreflightErrorCode: null,
          deleteAttempts: 0,
          deleteErrors: 0,
          lastDeleteErrorCode: null,
          runsDeleted: 0,
          deletedBytes: 0,
        },
      },
    }];
    try {
      const result = await callTool('deadlinetest:progress', {}, extra, { progressToken });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(traceEvents(info.mock.calls)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          traceId,
          toolName: 'deadlinetest:progress',
          stage: 'scratch_write_progress',
          scratchWriteProgress: expect.objectContaining({
            quotaRecoveryDiagnostics: expect.objectContaining({
              readdirOperations: 2,
              statOperations: 1,
              operationTotalMs: 7,
              maxOperationKind: 'readdir',
              currentOperationKind: 'readdir',
              currentOperationElapsedMs: 250,
            }),
          }),
        }),
      ]));
      expect(notifications).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: 'notifications/papercusp/event',
          params: expect.objectContaining({
            progressToken,
            event: 'progress',
            data: expect.objectContaining({
              progress: 0,
              total: 100,
              message: expect.stringContaining('quota recovery'),
            }),
          }),
        }),
        expect.objectContaining({
          method: 'notifications/progress',
          params: expect.objectContaining({
            progressToken,
            progress: 0,
            total: 100,
            message: expect.stringContaining('quota recovery'),
          }),
        }),
      ]));
    } finally {
      info.mockRestore();
    }
  });

  it('traces a real checkpoint spill write after the deadline and preserves its readable payload', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'papercusp-mcp-real-spill-'));
    const previousRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const previousKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    _resetScratchUsageForTests();
    h.captureScratchWriteTimings = true;
    h.spillWritePathSegment = 'deadlinetest:late-spill';
    let releaseTool!: () => void;
    h.spillToolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
    const enteredTool = new Promise<void>((resolve) => { h.spillToolEntered = resolve; });
    let releaseWrite!: () => void;
    h.spillWriteGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const enteredWrite = new Promise<void>((resolve) => { h.spillWriteEntered = resolve; });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const traceId = '4429f9ae-11d4-4ea6-95d6-958f4ee77f9e';
    const receiptKey = 'idem-real-checkpoint-spill';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const response = callTool('deadlinetest:late-spill', {},
        superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
        { idempotencyKey: receiptKey });
      await waitForSignal(enteredTool, 'late spill tool entry', 5_000, () => ({
        traceEvents: traceEvents(info.mock.calls).filter((event) => event.traceId === traceId),
        resultDoorCalls: h.resultDoorCalls,
        spillPaths: [...h.spillPaths],
      }));
      expect(traceEvents(info.mock.calls)).toContainEqual(
        expect.objectContaining({ traceId, stage: 'inner_dispatch_started' }),
      );
      await vi.advanceTimersByTimeAsync(TEST_DEADLINE_MS);
      const timedOut = await response;
      expect(timedOut.isError).toBe(true);
      expect(textOf(timedOut)).toContain('request_timeout');
      expect(h.realScratchWriteTimings).toEqual([]);
      expect(traceEvents(info.mock.calls).some((event) =>
        event.traceId === traceId && event.stage === 'inner_dispatch_settled')).toBe(false);

      vi.useRealTimers();
      releaseTool();
      await waitForSignal(enteredWrite, 'late scratch spill write entry', 5_000, () => ({
        traceEvents: traceEvents(info.mock.calls).filter((event) => event.traceId === traceId),
        resultDoorCalls: h.resultDoorCalls,
        spillPaths: [...h.spillPaths],
      }));
      releaseWrite();
      await vi.waitFor(() => expect(h.replayStores.some((store) =>
        store.idempotencyKey === receiptKey)).toBe(true));
      expect(h.scratchWriteTimings).toEqual([]); // no synthetic phase injection
      expect(h.realScratchWriteTimings).toHaveLength(1);
      const timing = structuredClone(h.realScratchWriteTimings[0]);
      // Concurrent quota bookkeeping may add a short, legitimate wait.
      expect(Number.isFinite(timing.quotaWaitMs)).toBe(true);
      expect(timing.quotaWaitMs).toBeGreaterThanOrEqual(0);
      expect(timing.quotaRecoveryMs).toBe(0);
      expect(Number.isFinite(timing.refreshWaitMs)).toBe(true);
      expect(timing.refreshWaitMs).toBeGreaterThanOrEqual(0);
      expect(timing.writeMs).toBeGreaterThan(0);
      expect(timing.totalMs).toBeGreaterThanOrEqual(timing.writeMs);
      const settled = traceEvents(info.mock.calls).find((event) =>
        event.traceId === traceId && event.stage === 'inner_dispatch_settled');
      expect(settled).toMatchObject({
        outcome: 'success', afterDeadline: true,
        phaseTimingsMs: {
          scratchWrites: {
            count: 1,
            perSpill: [expect.objectContaining(timing)],
            quotaWaitMs: timing.quotaWaitMs,
            refreshWaitMs: timing.refreshWaitMs,
            quotaRecoveryMs: timing.quotaRecoveryMs,
            writeMs: timing.writeMs,
            totalMs: timing.totalMs,
          },
        },
      });
      expect(h.spillPaths).toHaveLength(1);
      const spill = parseScratchReference(readFileSync(h.spillPaths[0]));
      expect(spill).not.toBeNull();
      expect(spill!.payload.toString()).toContain(JSON.stringify(SPILL_CHECKPOINT).slice(1, -1));
      const receipt = h.replayStores.find((store) => store.idempotencyKey === receiptKey)!.result as CallResult;
      expect(receipt.isError).not.toBe(true);
      expect(textOf(receipt)).not.toContain('request_timeout');
      expect(JSON.stringify(receipt)).toContain(h.spillPaths[0]);
    } finally {
      vi.useRealTimers();
      releaseTool();
      releaseWrite();
      await sleep(SLOW_TOOL_MS + 100);
      info.mockRestore();
      _resetScratchUsageForTests();
      if (previousRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousRoot;
      if (previousKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
      else process.env.PAPERCUSP_RESULT_DOOR_OFF = previousKillSwitch;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('traces spill existence and trace-correlated backfill after the result-door bounded wait returns', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'papercusp-mcp-late-spill-'));
    const previousRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const previousKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    _resetScratchUsageForTests();
    _setScratchUsageForTests('ws-test', WORKSPACE_QUOTA_BYTES + 1);
    h.captureScratchWriteTimings = true;
    let releaseWrite!: () => void;
    h.spillWriteGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    // The result door stores this nested result under the outer MCP tool path.
    h.spillWritePathSegment = 'tools:invoke';
    const enteredWrite = new Promise<void>((resolve) => { h.spillWriteEntered = resolve; });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const traceId = '879b64d8-741b-4e8a-a111-39dd7b35c05f';
    let responsePromise: Promise<CallResult> | undefined;
    let releasePendingBackfill!: () => void;
    const pendingBackfillGate = new Promise<void>((resolve) => { releasePendingBackfill = resolve; });
    let signalPendingBackfillStarted!: () => void;
    const pendingBackfillStarted = new Promise<void>((resolve) => { signalPendingBackfillStarted = resolve; });
    const backfillOrder: string[] = [];
    const originalUnsafe = h.fakeTx.unsafe;
    h.fakeTx.unsafe = async (...args: unknown[]) => {
      const [sql, params] = args;
      if (typeof sql === 'string' && sql.includes('UPDATE harness_shared.tool_invocations') && Array.isArray(params)) {
        let metadata: Record<string, unknown> = {};
        try { metadata = JSON.parse(String(params[2])) as Record<string, unknown>; } catch { /* not a result-door update */ }
        if (metadata.spillTimeoutCount === 1) {
          backfillOrder.push('timeout-start');
          signalPendingBackfillStarted();
          await pendingBackfillGate;
          const result = await originalUnsafe(...args);
          backfillOrder.push('timeout-finished');
          return result;
        }
        if (typeof metadata.spillSettlementStatus === 'string') backfillOrder.push('settlement-start');
      }
      return originalUnsafe(...args);
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      responsePromise = callTool('tools:invoke', { name: 'deadlinetest:spill', args: {} },
        superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
        { idempotencyKey: 'idem-late-scratch-settlement' });
      await waitForSignal(enteredWrite, 'nested scratch spill write entry');
      // Keep the real scratch write blocked until applyResultDoorAsync's 20s bounded wait expires.
      await vi.advanceTimersByTimeAsync(20_001);
      await waitForSignal(pendingBackfillStarted, 'pending spill timeout backfill');
      expect(backfillOrder).toEqual(['timeout-start']);

      vi.useRealTimers();
      releasePendingBackfill();
      await vi.waitFor(() => expect(backfillOrder).toEqual(['timeout-start', 'timeout-finished']));
      const response = await responsePromise;
      expect(response.isError).not.toBe(true);
      expect(textOf(response)).not.toContain('request_timeout');
      expect(response._meta?.resultDoor).toMatchObject({
        spillPending: true,
        spillFailed: false,
        pendingSpill: { cursor: { kind: 'pending-spill' } },
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        '[bounded-timeout] result-door scratch spill write exceeded 20000ms',
      ));
      const initialInvocation = h.invocations.find((candidate) =>
        Boolean(candidate && typeof candidate === 'object' &&
          (candidate as Record<string, unknown>).toolName === 'deadlinetest:spill')) as
        | Record<string, unknown>
        | undefined;
      expect(initialInvocation).toEqual(expect.objectContaining({
        toolName: 'deadlinetest:spill',
        status: 'ok',
        outputSize: expect.any(Number),
      }));
      expect(initialInvocation).not.toHaveProperty('outputRef');
      expect((initialInvocation?.ctx as { requestOrigin?: { mcpRequestTraceId?: string } } | undefined)
        ?.requestOrigin?.mcpRequestTraceId).toBe(traceId);

      const timeoutBackfill = h.unsafeCalls.find((call) => {
        if (!call.sql.includes('UPDATE harness_shared.tool_invocations') || call.params[8] !== traceId) return false;
        try { return JSON.parse(String(call.params[2])).spillTimeoutCount === 1; } catch { return false; }
      });
      expect(timeoutBackfill).toBeDefined();
      const timeoutMetadata = JSON.parse(String(timeoutBackfill?.params[2])) as Record<string, unknown>;
      expect(timeoutMetadata).toEqual(expect.objectContaining({
        spillPending: true,
        spillErrorCode: 'ETIMEDOUT',
        spillTimeoutCount: 1,
        spillTimeoutMs: 20_000,
        spillTimeoutAt: expect.any(String),
      }));
      expect(backfillOrder).toEqual(['timeout-start', 'timeout-finished']);
      await vi.waitFor(() => expect(traceEvents(info.mock.calls).some((event) =>
        event.traceId === traceId && event.stage === 'inner_dispatch_settled')).toBe(true));

      // The timeout count is now in the invocation row. Release the blocked writer and
      // verify its late settlement follows that durable timeout update.
      expect(h.spillPaths).toHaveLength(1);
      releaseWrite();
      await vi.waitFor(() => expect(existsSync(h.spillPaths[0])).toBe(true));
      await vi.waitFor(() => expect(traceEvents(info.mock.calls).some((event) =>
        event.traceId === traceId && event.stage === 'scratch_write_settled')).toBe(true));
      const settled = traceEvents(info.mock.calls).find((event) =>
        event.traceId === traceId && event.stage === 'scratch_write_settled');
      expect(settled).toMatchObject({
        traceId,
        // The request trace belongs to the outer transport call; only the
        // invocation row/backfill selector uses the nested target name.
        toolName: 'tools:invoke',
        stage: 'scratch_write_settled',
        // The target handler settled before the result-door's own bounded
        // scratch wait, so this is not a late handler settlement.
        afterDeadline: false,
        scratchWriteTimings: {
          quotaWaitMs: expect.any(Number),
          refreshWaitMs: expect.any(Number),
          quotaRecoveryMs: expect.any(Number),
          writeMs: expect.any(Number),
          totalMs: expect.any(Number),
          quotaRecoveryDiagnostics: expect.objectContaining({
            sizeWalkDirectories: expect.any(Number),
          }),
        },
      });
      expect((settled?.scratchWriteTimings as ScratchWriteTimings).quotaRecoveryDiagnostics?.sizeWalkDirectories)
        .toBeGreaterThan(0);
      expect(existsSync(h.spillPaths[0])).toBe(true);
      const spill = parseScratchReference(readFileSync(h.spillPaths[0]));
      expect(spill).not.toBeNull();
      expect(spill!.payload.toString()).toContain(JSON.stringify(SPILL_CHECKPOINT).slice(1, -1));

      let persistedBackfill: { sql: string; params: unknown[] } | undefined;
      await vi.waitFor(() => {
        persistedBackfill = h.unsafeCalls.find((call) => {
          if (!call.sql.includes('UPDATE harness_shared.tool_invocations') || call.params[8] !== traceId) {
            return false;
          }
          try {
            return JSON.parse(String(call.params[2])).spillSettlementStatus === 'persisted';
          } catch {
            return false;
          }
        });
        expect(persistedBackfill).toBeDefined();
      });
      expect(persistedBackfill?.params[3]).toBe('ws-test');
      expect(persistedBackfill?.params[5]).toBe('deadlinetest:spill');
      expect(persistedBackfill?.params[7]).toBe(persistedBackfill?.params[0]);
      const settlementMetadata = JSON.parse(String(persistedBackfill?.params[2])) as Record<string, unknown>;
      expect(settlementMetadata).toEqual(expect.objectContaining({
        spillPath: h.spillPaths[0],
        spillUri: persistedBackfill?.params[0],
        spillPending: false,
        spillFailed: false,
        spillSettlementStatus: 'persisted',
        spillSettledAt: expect.any(String),
        scratchWriteTimings: expect.objectContaining({
          count: 1,
          perSpill: [expect.objectContaining({
            writeMs: expect.any(Number),
            totalMs: expect.any(Number),
            quotaRecoveryDiagnostics: expect.objectContaining({
              sizeWalkDirectories: expect.any(Number),
            }),
          })],
          quotaWaitMs: expect.any(Number),
          refreshWaitMs: expect.any(Number),
          quotaRecoveryMs: expect.any(Number),
          writeMs: expect.any(Number),
          totalMs: expect.any(Number),
          quotaRecoveryDiagnostics: expect.objectContaining({
            sizeWalkDirectories: expect.any(Number),
          }),
        }),
      }));
      const mcpSettlement = settlementMetadata.mcpRequestSettlement as {
        phaseTimingsMs?: { scratchWrites?: Record<string, unknown> };
      };
      expect(mcpSettlement.phaseTimingsMs?.scratchWrites).toEqual(expect.objectContaining({
        count: 1,
        totalMs: expect.any(Number),
        quotaWaitMs: expect.any(Number),
        writeMs: expect.any(Number),
      }));
      expect(persistedBackfill?.sql).toContain("metadata_json #> '{mcpRequestSettlement,phaseTimingsMs}'");
      expect(settlementMetadata).not.toHaveProperty('spillTimeoutCount');
      await vi.waitFor(() => expect(backfillOrder).toEqual([
        'timeout-start', 'timeout-finished', 'settlement-start',
      ]));
      expect(warn.mock.calls.some(([message]) =>
        String(message).includes('backfillResultDoorOutputRef failed'))).toBe(false);
    } finally {
      vi.useRealTimers();
      releasePendingBackfill();
      releaseWrite();
      h.fakeTx.unsafe = originalUnsafe;
      if (responsePromise) {
        await Promise.race([
          responsePromise.catch(() => undefined),
          sleep(5_000),
        ]);
      }
      await vi.waitFor(() => expect(traceEvents(info.mock.calls).some((event) =>
        event.traceId === traceId && event.stage === 'inner_dispatch_settled')).toBe(true), { timeout: 3_000 });
      info.mockRestore();
      warn.mockRestore();
      _resetScratchUsageForTests();
      if (previousRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousRoot;
      if (previousKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
      else process.env.PAPERCUSP_RESULT_DOOR_OFF = previousKillSwitch;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('returns at the request-entry deadline while the scoped transport gate is held, then blocks late handler start', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const traceId = '2bc6eafe-a0fa-4d50-9e56-0bcc88a1bfc6';
    let releaseScope!: () => void;
    let enterScope!: () => void;
    const scopeGate = new Promise<void>((resolve) => { releaseScope = resolve; });
    const scopeEntered = new Promise<void>((resolve) => { enterScope = resolve; });
    h.resolveWorkspaceForHarnessSlugIn.mockImplementationOnce(async () => {
      enterScope();
      await scopeGate;
      return 'ws-test';
    });

    const responsePromise = callTool(
      'deadlinetest:slow',
      { harness: 'papercusp' },
      superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
    );
    let responseBeforeRelease: CallResult | null = null;
    let traceAtDeadline: Array<Record<string, unknown>> = [];
    try {
      await waitForSignal(scopeEntered, 'scoped transport harness resolver');
      responseBeforeRelease = await Promise.race([
        responsePromise,
        sleep(TEST_DEADLINE_MS * 3).then(() => null),
      ]);
      traceAtDeadline = traceEvents(info.mock.calls);
    } finally {
      releaseScope();
      info.mockRestore();
    }

    const result = responseBeforeRelease ?? await responsePromise;
    expect(responseBeforeRelease).not.toBeNull();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('request_timeout');
    expect(textOf(result)).toContain('during MCP request setup');
    expect(traceAtDeadline).toContainEqual(
      expect.objectContaining({
        traceId,
        toolName: 'deadlinetest:slow',
        stage: 'deadline',
        phase: 'pre_dispatch',
        preDispatchActivePhase: 'transportScopeSetup',
        transportScopePhases: expect.objectContaining({
          pending: expect.arrayContaining([
            expect.objectContaining({ phase: 'harnessWorkspaceResolution', elapsedMs: expect.any(Number) }),
          ]),
          phases: expect.arrayContaining([
            expect.objectContaining({ phase: 'scopedSuperuserBoundary', durationMs: expect.any(Number) }),
          ]),
        }),
      }),
    );
    await sleep(50);
    expect(slowCalls).toBe(0);
  });

  it('marks a delayed workspace acquisition as pre-dispatch and blocks late handler start', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const traceId = '73f01cc4-b44b-4d15-82f8-28d0d5774c31';
    const acquisitionDelayMs = TEST_DEADLINE_MS * 4;
    h.withWorkspaceDelayMs = acquisitionDelayMs;
    try {
      const res = await callTool(
        'deadlinetest:slow',
        {},
        superuserExtra('&workspace=ws-test', { [MCP_REQUEST_TRACE_HEADER]: traceId }),
      );
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('request_timeout');
      expect(h.withWorkspaceCalls).toEqual(['ws-test']);
      expect(traceEvents(info.mock.calls)).toContainEqual(
        expect.objectContaining({
          traceId,
          toolName: 'deadlinetest:slow',
          stage: 'deadline',
          phase: 'pre_dispatch',
          deadlineMs: TEST_DEADLINE_MS,
        }),
      );
      expect(traceEvents(info.mock.calls).some((event) => event.stage === 'inner_dispatch_started')).toBe(false);

      // Let the acquisition finish after its caller was answered. The absolute
      // deadline guard must still prevent entering the tool handler.
      await sleep(acquisitionDelayMs + 20);
      expect(slowCalls).toBe(0);
      expect(traceEvents(info.mock.calls).some((event) => event.stage === 'inner_dispatch_started')).toBe(false);
    } finally {
      info.mockRestore();
    }
  });

  // EI-21697542694243148: naming the VALUE is not enough — the message must also name a DOOR
  // that can actually send it. `_meta` is transport-level and every projected tool's args schema
  // is additionalProperties:false, so a caller who reads "pass exactly that value" and puts it in
  // the tool's arguments gets `invalid_args: Unrecognized key: "_meta"`. That is exactly what the
  // reporter did before falling back to hand-reconciliation. These assertions pin the two halves
  // that make the instruction actionable: the reachable flag, and the warning against the args
  // mistake. Without the fix the message named neither, so this test fails on the old wording.
  it('names a reachable door for the key, and warns it is not a tool argument (EI-21697542694243148)', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), { idempotencyKey: 'idem-deadline-door' });
    expect(res.isError).toBe(true);
    // The door that actually works (ptool's transport flag), carrying this call's own key.
    expect(textOf(res)).toContain('--idempotency-key idem-deadline-door');
    // And the trap it must steer the reader away from.
    expect(textOf(res)).toContain('TRANSPORT field');
    expect(textOf(res)).toContain('Unrecognized key');
    expect(textOf(res)).toContain('tools:invoke has no passthrough');
    // The printed invocation must be one ptool would actually accept: its parser THROWS on bare
    // positional tool args ("tool-specific arguments must be supplied in the JSON payload via
    // --json, --json-file, or --json -"), so an example ending in a bare `<args>` would reproduce
    // the very unactionable-instruction defect this item is about, one level down.
    expect(textOf(res)).toContain("--json '<the same args>'");
    expect(textOf(res)).not.toMatch(/--idempotency-key \S+ \S+ <args>/);
  });

  // The negative half, and the reason the assertion above is on the value rather than the
  // wording: the no-key branch must NOT start naming a key, or it would print an empty/undefined
  // one and send the caller chasing a replay that cannot work.
  it('the no-key branch names no key at all (EI-21570323060383850)', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('had no idempotencyKey');
    expect(textOf(res)).not.toContain("This call's key is");
    expect(textOf(res)).not.toMatch(/key is "?(undefined|null|)"/);
    // EI-21697542694243148: the forward-looking half of this branch ("pass one up front") had the
    // same gap — it told the caller to supply _meta.idempotencyKey without naming a door that can.
    // It must name the flag while still naming no concrete key value (asserted above).
    expect(textOf(res)).toContain('--idempotency-key');
    expect(textOf(res)).toContain('NOT as a tool argument');
  });

  it('does NOT re-block the response on the receipt persist — replayStores is still empty the instant the caller is answered', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), { idempotencyKey: 'idem-deadline-2' });
    expect(res.isError).toBe(true);
    // The whole point of `if (!raced.deadlineFired) await persist`: the caller
    // was already answered with the timeout envelope, and the persist for the
    // still-running tool has NOT happened yet — it happens in the background.
    expect(h.replayStores).toEqual([]);
  });

  it('times out during pre-dispatch workspace acquisition without entering the tool handler', async () => {
    h.withWorkspaceDelayMs = SLOW_TOOL_MS;
    const startedAt = Date.now();

    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), {
      idempotencyKey: 'idem-pre-dispatch-deadline',
    });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('request_timeout');
    expect(textOf(res)).toContain(`${TEST_DEADLINE_MS}ms`);
    expect(Date.now() - startedAt).toBeLessThan(SLOW_TOOL_MS);

    // Let the delayed acquisition callback run. Without the pre-dispatch guard
    // it would enter runDispatch here and increment the synthetic tool count
    // after the caller had already received its timeout.
    await sleep(SLOW_TOOL_MS + 100);
    expect(slowCalls).toBe(0);
    expect(h.replayStores).toEqual([]);
    expect(h.invocations).toMatchObject([
      { toolName: 'deadlinetest:slow', status: 'error' },
    ]);
  });

  it('once the tool actually finishes, the persisted receipt is its REAL outcome — never the raced timeout envelope (EI-19301511582594101)', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'), { idempotencyKey: 'idem-deadline-3' });
    expect(res.isError).toBe(true); // the CALLER got the timeout envelope...

    // ...but the tool keeps running server-side (raceDeadline never cancels
    // `run()`) and its real outcome is what eventually gets persisted. Poll
    // rather than a fixed sleep — deadline-bounded, so this can't hang the
    // suite even if the background persist regresses to never firing.
    const deadlineAt = Date.now() + SLOW_TOOL_MS + 2_000;
    while (h.replayStores.length === 0 && Date.now() < deadlineAt) {
      await sleep(10);
    }

    expect(slowCalls).toBe(1); // the tool really did run (not cancelled, not skipped)
    expect(h.replayStores).toHaveLength(1);
    expect(h.replayStores[0]!.idempotencyKey).toBe('idem-deadline-3');
    const stored = h.replayStores[0]!.result as CallResult;
    // The crux of the bug this item guards against: the STORED receipt must be
    // the tool's real content, not the "request_timeout" envelope the caller
    // was shown. A regression here would make every retry with this key replay
    // a timeout forever instead of the tool's actual (successful) result.
    expect(textOf(stored)).toBe(REAL_OUTCOME_TEXT);
    expect(textOf(stored)).not.toContain('request_timeout');
    expect(stored.isError).not.toBe(true);
  });

  it('with no idempotencyKey, the deadline still answers cleanly (no-retry-yet wording) and never persists a receipt', async () => {
    const res = await callTool('deadlinetest:slow', {}, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('request_timeout');
    expect(textOf(res)).toContain('commit status is UNKNOWN');
    expect(textOf(res)).toContain('Do NOT retry yet');
    expect(textOf(res)).toContain('re-read the current state');

    // Give the slow tool plenty of time to finish server-side; without an
    // idempotencyKey the handler's `if (idempotencyKey && ...)` guard means no
    // receipt is ever written, regardless of how the tool finishes.
    await sleep(SLOW_TOOL_MS + 100);
    expect(slowCalls).toBe(1);
    expect(h.replayStores).toEqual([]);
  });

  it('stores a coord:send-shaped pre-persist abort and replays the structured result for the same transport key', async () => {
    const key = 'idem-coord-send-pre-persist-abort';
    const extra = scoped('ws-test');

    const initial = await callTool('deadlinetest:coord-send-abort', {}, extra, { idempotencyKey: key });

    expect(syntheticAbortCalls).toBe(1);
    expect(initial.structuredContent).toEqual(SYNTHETIC_COORD_SEND_ABORT);
    expect(textOf(initial)).toContain(JSON.stringify(SYNTHETIC_COORD_SEND_ABORT));
    expect(h.replayStores).toHaveLength(1);
    expect(h.replayStores[0]!.idempotencyKey).toBe(key);

    const stored = h.replayStores[0]!.result as CallResult;
    expect(stored.structuredContent).toEqual(SYNTHETIC_COORD_SEND_ABORT);
    expect(textOf(stored)).toContain(JSON.stringify(SYNTHETIC_COORD_SEND_ABORT));
    h.storedReplay = stored as typeof h.storedReplay;

    const retry = await callTool('deadlinetest:coord-send-abort', {}, extra, { idempotencyKey: key });

    expect(retry._meta).toMatchObject({ replayed: true });
    expect(retry.structuredContent).toEqual(initial.structuredContent);
    expect(textOf(retry)).toContain(JSON.stringify(SYNTHETIC_COORD_SEND_ABORT));
    expect(syntheticAbortCalls).toBe(1);
    expect(h.replayStores).toHaveLength(1);
  });
});
