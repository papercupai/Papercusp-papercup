/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-004 / R-2 — the recorder, end to end.
 *
 * Every native code-intel call is driven through the REAL dispatch wrapper (`dispatchProjectedTool`)
 * into the REAL host recorder (`PROJECTED_DEPS.recordInvocation`), and must land exactly one
 * tool_invocations row whose metadata_json carries `codeIntelResult`: for every tool in
 * NATIVE_CODE_INTEL_TOOLS, for every value of that tool's registered op enum, and on every exit
 * (empty success, stale payload, refusal, exception, timeout, cancellation, retry, duplicate delivery).
 * The calls carry no quota window, the transport shape that previously skipped telemetry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mocks (importOriginal) so a mock can never strip a sibling export.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFlag: vi.fn(async () => false),
}));
vi.mock('@papercusp/testing-shell/llm', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOverride: vi.fn(() => undefined),
}));
vi.mock('../decision-ledger/emit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDecisionLedger: vi.fn(),
}));
vi.mock('../agent-tools/coordination/dispatch-heartbeat', () => ({
  maybeBeatPresenceOnDispatch: vi.fn(),
}));
vi.mock('../agent-tools/coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-code-intel-status-test', ownerLabel: 'su · test' })),
}));

const captured: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({
    sql: {
      begin: async (cb: (tx: unknown) => Promise<void>) =>
        cb({
          unsafe: async (sql: string, params: unknown[]) => {
            captured.push({ sql, params });
          },
        }),
    },
  }),
}));

import { dispatchProjectedTool, type DispatchProjectedDeps, type ProjectedTool } from '@papercusp/tooldef';
import { PROJECTED_DEPS, flushPendingTelemetry } from '../projected-tool-deps';
import graphQuery from '../agent-tools/gitnexus/query';
import lspQuery from '../agent-tools/lsp/query';
import codePack from '../agent-tools/lsp/pack';
import { CODE_INTEL_RESULT_METADATA_KEY, type CodeIntelResultStatus } from './code-intel-result-status.ts';
import { NATIVE_CODE_INTEL_TOOLS } from './native-adoption.ts';

/** The registered definition of each native tool; the static guard below pins this map to NATIVE_CODE_INTEL_TOOLS. */
const DEFINITIONS: Record<string, unknown> = {
  'graph:query': graphQuery,
  'lsp:query': lspQuery,
  'code:pack': codePack,
};

/** The values of a registered tool's `op` enum, read from its zod args schema. */
function opsOf(definition: unknown): string[] {
  const args = (definition as { args?: { shape?: Record<string, unknown> } }).args;
  let node = args?.shape?.op as { options?: unknown; _def?: { innerType?: unknown } } | undefined;
  while (node && !Array.isArray(node.options) && node._def?.innerType) node = node._def.innerType as typeof node;
  return Array.isArray(node?.options) ? (node!.options as string[]) : [];
}

const answer = (over: Record<string, unknown> = {}) => ({
  backend: 'typescript',
  intent: 'callers',
  query: 'f',
  sites: [],
  truncation: { truncated: false, totalAvailable: 0, continuation: null },
  freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false },
  ...over,
});
/** A handler payload of the shape each tool returns: code:pack nests its answer. */
const payloadFor = (toolName: string, over: Record<string, unknown> = {}) =>
  toolName === 'code:pack' ? { answer: answer(over), artifact: {} } : answer(over);
const textResult = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

const makeTool = (toolName: string, fn: ProjectedTool['fn'], over: Partial<ProjectedTool> = {}): ProjectedTool => ({
  pluginName: 'agent-mcp',
  description: 'fixture',
  inputSchema: { type: 'object' },
  capabilities: [],
  expose: { mcp: { name: toolName } },
  fn,
  ...over,
});

// No runId / quotaSubject / power-user: papercuspComputeQuotaWindow resolves a null window key.
const ctx = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    role: 'operator',
    spawnId: 's-code-intel-status-test',
    log: vi.fn(),
    ...over,
  }) as never;

const deps: DispatchProjectedDeps = {
  computeQuotaWindow: PROJECTED_DEPS.computeQuotaWindow,
  recordInvocation: PROJECTED_DEPS.recordInvocation,
  recordWithoutWindow: PROJECTED_DEPS.recordWithoutWindow,
};

/** Every recorded codeIntelResult, read from the metadata_json params of the captured INSERTs. */
function recordedStatuses(): CodeIntelResultStatus[] {
  const out: CodeIntelResultStatus[] = [];
  for (const c of captured) {
    if (!c.sql.includes('INSERT INTO harness_shared.tool_invocations')) continue;
    for (const p of c.params) {
      if (typeof p !== 'string' || !p.includes(`"${CODE_INTEL_RESULT_METADATA_KEY}"`)) continue;
      const meta = JSON.parse(p) as Record<string, unknown>;
      out.push(meta[CODE_INTEL_RESULT_METADATA_KEY] as CodeIntelResultStatus);
    }
  }
  return out;
}

async function dispatchOnce(
  toolName: string,
  fn: ProjectedTool['fn'],
  input: Record<string, unknown>,
  opts: { tool?: Partial<ProjectedTool>; ctx?: Record<string, unknown> } = {},
): Promise<CodeIntelResultStatus[]> {
  captured.length = 0;
  await dispatchProjectedTool(makeTool(toolName, fn, opts.tool), toolName, input, ctx(opts.ctx), deps);
  await flushPendingTelemetry();
  return recordedStatuses();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  captured.length = 0;
});
afterEach(async () => {
  await flushPendingTelemetry();
  captured.length = 0;
});

describe('static guard: every native code-intel tool is wrapped', () => {
  it('covers exactly NATIVE_CODE_INTEL_TOOLS, each with a non-empty registered op enum', () => {
    expect(Object.keys(DEFINITIONS).sort()).toEqual([...NATIVE_CODE_INTEL_TOOLS].sort());
    for (const toolName of NATIVE_CODE_INTEL_TOOLS) expect(opsOf(DEFINITIONS[toolName]).length, toolName).toBeGreaterThan(0);
  });

  it('the host records every native tool without a quota window, and no other tool', () => {
    for (const toolName of NATIVE_CODE_INTEL_TOOLS) expect(PROJECTED_DEPS.recordWithoutWindow?.(toolName), toolName).toBe(true);
    expect(PROJECTED_DEPS.recordWithoutWindow?.('x:probe')).toBe(false);
  });
});

describe('every tool and every op records exactly one status through the dispatcher', () => {
  for (const toolName of NATIVE_CODE_INTEL_TOOLS) {
    for (const op of opsOf(DEFINITIONS[toolName])) {
      it(`${toolName} op=${op}: an empty success is measured`, async () => {
        const statuses = await dispatchOnce(toolName, async () => textResult(payloadFor(toolName)), { op });
        expect(statuses).toHaveLength(1);
        expect(statuses[0]).toMatchObject({ status: 'measured' });
        expect(typeof statuses[0]!.invocationId).toBe('string');
      });
    }
  }
});

describe('each exit records its reason class', () => {
  for (const toolName of NATIVE_CODE_INTEL_TOOLS) {
    const op = opsOf(DEFINITIONS[toolName])[0]!;

    it(`${toolName}: a stale payload is unknown/stale`, async () => {
      const stale = { freshness: { health: 'healthy', indexedAt: null, staleVsDisk: true } };
      const statuses = await dispatchOnce(toolName, async () => textResult(payloadFor(toolName, stale)), { op });
      expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'stale' })]);
    });

    it(`${toolName}: a self-reported refusal is unknown/scope-refused`, async () => {
      const refusal = { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'scope_refused', message: 'paths outside the authorized scope' } }) }] };
      const statuses = await dispatchOnce(toolName, async () => refusal, { op });
      expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'scope-refused' })]);
    });

    it(`${toolName}: a thrown handler is unknown/exception`, async () => {
      const statuses = await dispatchOnce(toolName, async () => { throw new TypeError('x is undefined'); }, { op });
      expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'exception' })]);
    });

    it(`${toolName}: a dispatcher timeout is unknown/timeout`, async () => {
      const statuses = await dispatchOnce(
        toolName,
        async () => { await sleep(400); return textResult(payloadFor(toolName)); },
        { op },
        { tool: { timeoutSec: 0.05 } },
      );
      expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'timeout' })]);
    });

    it(`${toolName}: a caller cancellation is unknown/cancelled`, async () => {
      const controller = new AbortController();
      const statuses = await dispatchOnce(
        toolName,
        async () => { controller.abort(); await sleep(50); return textResult(payloadFor(toolName)); },
        { op },
        { ctx: { signal: controller.signal } },
      );
      expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'cancelled' })]);
    });
  }
});

describe('retries and duplicate deliveries', () => {
  it('a retry is a new invocation id and records its own row', async () => {
    const tool = makeTool('graph:query', async () => textResult(answer()));
    await dispatchProjectedTool(tool, 'graph:query', { op: 'callers' }, ctx(), deps);
    await dispatchProjectedTool(tool, 'graph:query', { op: 'callers' }, ctx(), deps);
    await flushPendingTelemetry();
    const statuses = recordedStatuses();
    expect(statuses).toHaveLength(2);
    expect(new Set(statuses.map((s) => s.invocationId)).size).toBe(2);
  });

  it('a duplicate delivery of one invocation id records one row', async () => {
    const record = {
      toolName: 'lsp:query',
      pluginName: 'agent-mcp',
      ctx: ctx(),
      windowKey: '',
      callId: 'dup-call-1',
      durationMs: 2,
      status: 'ok' as const,
      resultSnapshot: textResult(answer()),
    };
    await PROJECTED_DEPS.recordInvocation!(record as never);
    await PROJECTED_DEPS.recordInvocation!(record as never);
    await flushPendingTelemetry();
    expect(recordedStatuses()).toEqual([{ status: 'measured', invocationId: 'dup-call-1' }]);
  });

  it('handler metadata cannot forge the status', async () => {
    await PROJECTED_DEPS.recordInvocation!({
      toolName: 'graph:query',
      pluginName: 'agent-mcp',
      ctx: ctx(),
      windowKey: '',
      callId: 'forge-1',
      durationMs: 2,
      status: 'error',
      errorCode: 'internal',
      errorMessage: 'boom',
      metadataJson: { [CODE_INTEL_RESULT_METADATA_KEY]: { status: 'measured', invocationId: 'forge-1' } },
    } as never);
    await flushPendingTelemetry();
    expect(recordedStatuses()).toEqual([expect.objectContaining({ status: 'unknown', reason: 'exception', invocationId: 'forge-1' })]);
  });

  it('a non-native tool without a quota window still records nothing (default dispatcher policy kept)', async () => {
    captured.length = 0;
    await dispatchProjectedTool(makeTool('x:probe', async () => textResult({ ok: true })), 'x:probe', {}, ctx(), deps);
    await flushPendingTelemetry();
    expect(captured.filter((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'))).toHaveLength(0);
  });
});
