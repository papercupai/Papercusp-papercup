/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-004 / R-2 — the recorder, end to end.
 *
 * Every native code-intel call is driven through the REAL dispatch wrapper (`dispatchProjectedTool`)
 * into the REAL host recorder (`PROJECTED_DEPS.recordInvocation`), and must land exactly one
 * tool_invocations row whose metadata_json carries `codeIntelResult`: for every tool in
 * NATIVE_CODE_INTEL_TOOLS, for every value of that tool's registered op enum, and on every exit
 * (empty success, stale payload, refusal, exception, timeout, cancellation, retry, duplicate delivery).
 * The baseline calls carry no quota window, the transport shape that previously skipped telemetry.
 * Quota-negative controls explicitly enter a counted window.
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

import { dispatchProjectedTool, lookupByMcpName, type DispatchProjectedDeps, type ProjectedTool } from '@papercusp/tooldef';
import { PROJECTED_DEPS, flushPendingTelemetry } from '../projected-tool-deps';
import graphQuery from '../agent-tools/gitnexus/query';
import lspQuery from '../agent-tools/lsp/query';
import codePack from '../agent-tools/lsp/pack';
import { CODE_INTEL_RESULT_METADATA_KEY, type CodeIntelResultStatus } from './code-intel-result-status.ts';
import { NATIVE_CODE_INTEL_TOOLS } from './native-adoption.ts';
import {
  CODE_INTEL_CANARY_OWNER,
  decideUnknownRateProbe,
  reconcileCodeIntelWindow,
  type ProbeInvocationRow,
} from './code-intel-unknown-rate-probe.ts';

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
  vi.restoreAllMocks();
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
    describe.each(opsOf(DEFINITIONS[toolName]))(`${toolName} op=%s`, (op) => {
      it('a stale payload is unknown/stale', async () => {
        const stale = { freshness: { health: 'healthy', indexedAt: null, staleVsDisk: true } };
        const statuses = await dispatchOnce(toolName, async () => textResult(payloadFor(toolName, stale)), { op });
        expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'stale' })]);
      });

      it('a truncated payload is unknown/partial', async () => {
        const statuses = await dispatchOnce(toolName, async () => textResult(payloadFor(toolName, { truncation: { truncated: true } })), { op });
        expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'partial' })]);
      });

      it('a missing index is unknown/index-missing', async () => {
        const statuses = await dispatchOnce(toolName, async () => textResult(payloadFor(toolName, { error: 'index not found' })), { op });
        expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'index-missing' })]);
      });

      it('a self-reported refusal is unknown/scope-refused', async () => {
        const refusal = { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code: 'scope_refused', message: 'paths outside the authorized scope' } }) }] };
        const statuses = await dispatchOnce(toolName, async () => refusal, { op });
        expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'scope-refused' })]);
      });

      it('a thrown handler is unknown/exception', async () => {
        const statuses = await dispatchOnce(toolName, async () => { throw new TypeError('x is undefined'); }, { op });
        expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'exception' })]);
      });

      it('a dispatcher timeout is unknown/timeout', async () => {
        const statuses = await dispatchOnce(
          toolName,
          async () => { await sleep(400); return textResult(payloadFor(toolName)); },
          { op },
          { tool: { timeoutSec: 0.05 } },
        );
        expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'timeout' })]);
      });

      it('a caller cancellation is unknown/cancelled', async () => {
        const controller = new AbortController();
        const statuses = await dispatchOnce(
          toolName,
          async () => { controller.abort(); await sleep(50); return textResult(payloadFor(toolName)); },
          { op },
          { ctx: { signal: controller.signal } },
        );
        expect(statuses).toEqual([expect.objectContaining({ status: 'unknown', reason: 'cancelled' })]);
      });
    });
  }
});

type PreHandlerExit = 'invalid-input' | 'role-not-allowed' | 'quota-exceeded';
const PRE_HANDLER_EXITS: PreHandlerExit[] = ['invalid-input', 'role-not-allowed', 'quota-exceeded'];
const EXIT_CODES = {
  'invalid-input': 'invalid_input',
  'role-not-allowed': 'role_not_allowed',
  'quota-exceeded': 'quota_exceeded',
} as const;

/** Real defineTool schema/serialization wrapper, with only the backend handler replaced. */
async function dispatchPreHandler(
  toolName: string,
  op: string,
  exit: PreHandlerExit | 'measured',
  ownerId = 'su-code-intel-status-test',
) {
  const definition = DEFINITIONS[toolName] as typeof graphQuery;
  const handler = vi.spyOn(definition, 'handler').mockResolvedValue(textResult(payloadFor(toolName)));
  const registered = lookupByMcpName(toolName)!;
  const readQuotaState = vi.fn(async () => ({ count: exit === 'quota-exceeded' ? 1 : 0 }));
  const onDispatchStart = vi.fn();
  const validInput = { op, ...(toolName === 'code:pack' ? { include: ['src/**'] } : {}) };
  const input = exit === 'invalid-input'
    ? { ...validInput, ...(toolName === 'code:pack' ? { include: [] } : { name: 42 }) }
    : validInput;
  const tool = {
    ...registered,
    ...(exit === 'role-not-allowed' ? { agentRoles: ['architect'] as ProjectedTool['agentRoles'] } : {}),
    ...(exit === 'quota-exceeded' ? { rolesQuota: { operator: { perRun: 1 } } } : {}),
  };
  captured.length = 0;
  try {
    const result = await dispatchProjectedTool(tool, toolName, input, ctx({
      coordOwnerId: ownerId,
      ...(exit === 'quota-exceeded' ? { runId: 'pre-handler-quota-window' } : {}),
    }), { ...deps, readQuotaState, onDispatchStart });
    await flushPendingTelemetry();
    const statuses = recordedStatuses();
    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    const callId = onDispatchStart.mock.calls[0]![0].callId as string;
    expect(callId).toEqual(expect.any(String));
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.invocationId).toBe(callId);
    if (exit === 'measured') {
      expect(result.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(statuses[0]).toEqual({ status: 'measured', invocationId: callId });
    } else {
      expect(result.error?.code).toBe(EXIT_CODES[exit]);
      expect(handler).not.toHaveBeenCalled();
      expect(statuses[0]).toMatchObject({ status: 'unknown', reason: 'scope-refused' });
    }
    return { status: statuses[0]!, callId };
  } finally {
    handler.mockRestore();
  }
}

describe('public pre-handler exits for every registered operation (D-038/D-045)', () => {
  for (const toolName of NATIVE_CODE_INTEL_TOOLS) {
    for (const op of opsOf(DEFINITIONS[toolName])) {
      for (const exit of PRE_HANDLER_EXITS) {
        it(`${toolName} op=${op}: ${exit} records one correlated scope refusal before handler entry`, async () => {
          const refused = await dispatchPreHandler(toolName, op, exit);
          const measured = await dispatchPreHandler(toolName, op, 'measured');
          expect(measured.callId).not.toBe(refused.callId);
        });
      }
    }
  }
});

describe('recorded public refusals feed unknown-rate reconciliation (D-038/D-045)', () => {
  for (const exit of PRE_HANDLER_EXITS) {
    it(`${exit}: ordinary refusals count, canaries do not, and retry/missing/duplicate controls stay distinct`, async () => {
      const build = 'dispatch-proof-build';
      const rows: ProbeInvocationRow[] = [];
      const dispatchRow = async (index: number, mode: PreHandlerExit | 'measured', canary = false) => {
        const toolName = NATIVE_CODE_INTEL_TOOLS[index % NATIVE_CODE_INTEL_TOOLS.length]!;
        const ownerId = canary ? CODE_INTEL_CANARY_OWNER : ['su-a', 'su-b', 'su-c'][index % 3]!;
        const { status } = await dispatchPreHandler(toolName, opsOf(DEFINITIONS[toolName])[0]!, mode, ownerId);
        return { rowId: `dispatch-${index}`, toolName, ownerId, servingBuildSha: build, status };
      };
      for (let index = 0; index < 50; index += 1) rows.push(await dispatchRow(index, index < 11 ? exit : 'measured'));
      for (let index = 50; index < 55; index += 1) rows.push(await dispatchRow(index, exit, true));

      const reconcile = (input: ProbeInvocationRow[]) => reconcileCodeIntelWindow(input, { runningBuildSha: build });
      const baseline = reconcile(rows);
      expect(baseline).toMatchObject({ total: 50, unknown: 11, owners: 3, canaryCalls: 5, gaps: [], unknownByReason: { 'scope-refused': 11 } });
      expect(baseline.byTool).toEqual({
        'graph:query': { total: 17, unknown: 4, gaps: 0 },
        'lsp:query': { total: 17, unknown: 4, gaps: 0 },
        'code:pack': { total: 16, unknown: 3, gaps: 0 },
      });
      expect(decideUnknownRateProbe(baseline)).toMatchObject({ alarm: true, reasons: ['above-threshold'], gradable: true, recovered: false });

      const retry = await dispatchRow(55, exit);
      expect(rows.map(row => (row.status as CodeIntelResultStatus).invocationId)).not.toContain((retry.status as CodeIntelResultStatus).invocationId);
      expect(reconcile([...rows, retry])).toMatchObject({ total: 51, unknown: 12, gaps: [] });

      const duplicate = reconcile([...rows, { ...rows[0]!, rowId: 'duplicate-delivery' }]);
      expect(duplicate).toMatchObject({ total: 50, unknown: 11, gaps: [{
        invocation: `call:${rows[0]!.toolName}:${(rows[0]!.status as CodeIntelResultStatus).invocationId}`,
        toolName: rows[0]!.toolName,
        statusRows: 2,
      }] });
      expect(decideUnknownRateProbe(duplicate).reasons).toEqual(['above-threshold', 'reconciliation-gap']);

      const missing = reconcile(rows.map((row, index) => index === 0 ? { ...row, status: null } : row));
      expect(missing).toMatchObject({ total: 49, unknown: 10, gaps: [{ invocation: 'row:dispatch-0', toolName: rows[0]!.toolName, statusRows: 0 }] });
      expect(decideUnknownRateProbe(missing)).toMatchObject({ alarm: true, reasons: ['reconciliation-gap'], gradable: false, recovered: false });
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
