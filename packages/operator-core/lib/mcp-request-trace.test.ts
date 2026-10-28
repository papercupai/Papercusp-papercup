import { describe, expect, it, vi } from 'vitest';
import {
  buildMcpSessionSurfaceTraceEvent,
  createMcpRequestTraceExecutionContext,
  logMcpRequestTrace,
  mcpRequestTraceOperationTimings,
  mcpDataPlaneDegradedAtFromExtra,
  mcpTraceIdFromExtra,
  MCP_DATA_PLANE_DEGRADED_AT_HEADER,
  MCP_REQUEST_TRACE_HEADER,
  recordMcpRequestTraceOperation,
  runWithMcpRequestTraceExecution,
  resolveMcpRequestTraceId,
  withMcpHttpHandlerPhaseTrace,
  withMcpToolsListPhaseTrace,
} from './mcp-request-trace';

describe('tools/list discovery phase evidence', () => {
  it('records the outstanding server phase before the client deadline and retains the result', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const nativeSession = 'private-native-discovery-session';
    try {
      const request = withMcpToolsListPhaseTrace({ requestInfo: {
        url: `http://localhost/api/mcp?native_session=${nativeSession}`,
        headers: { [MCP_REQUEST_TRACE_HEADER]: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4' },
      } }, async phases => {
        await phases.track('servingGeneration', () => wait);
        return { tools: ['unchanged-result'] };
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(info).toHaveBeenCalledTimes(1);
      const record = JSON.parse(String(info.mock.calls[0][0]).replace('[mcp-request-trace] ', ''));
      expect(record).toMatchObject({
        traceId: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4',
        stage: 'tools_list_pending',
        toolsListPhases: { pending: [{ phase: 'servingGeneration', elapsedMs: 5_000 }] },
      });
      expect(JSON.stringify(record)).not.toContain(nativeSession);
      release();
      await expect(request).resolves.toEqual({ tools: ['unchanged-result'] });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      release();
      info.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves discovery refusals and cancels their diagnostic timer', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const refusal = new Error('mcp_auth_failed');
    try {
      await expect(withMcpToolsListPhaseTrace({}, phases => phases.track('spawnContext', () => {
        throw refusal;
      }))).rejects.toBe(refusal);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('HTTP MCP handler phase evidence', () => {
  it('logs a bounded correlated phase only after it crosses the pending threshold', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const traceId = '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4';
    let release!: (value: string) => void;
    const wait = new Promise<string>(resolve => { release = resolve; });
    try {
      await expect(withMcpHttpHandlerPhaseTrace(traceId, 'auth_challenge', async () => 'fast', 50))
        .resolves.toBe('fast');
      expect(info).not.toHaveBeenCalled();

      const pending = withMcpHttpHandlerPhaseTrace(traceId, 'mcp_adapter', () => wait, 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(info).toHaveBeenCalledTimes(1);
      const pendingEvent = JSON.parse(String(info.mock.calls[0][0]).replace('[mcp-request-trace] ', ''));
      expect(pendingEvent).toMatchObject({
        traceId,
        toolName: 'mcp-http-handler',
        stage: 'http_handler_phase_pending',
        httpHandlerPhase: 'mcp_adapter',
        elapsedMs: 50,
      });

      release('response');
      await expect(pending).resolves.toBe('response');
      expect(info).toHaveBeenCalledTimes(2);
      const settledEvent = JSON.parse(String(info.mock.calls[1][0]).replace('[mcp-request-trace] ', ''));
      expect(settledEvent).toMatchObject({
        traceId,
        toolName: 'mcp-http-handler',
        stage: 'http_handler_phase_settled',
        httpHandlerPhase: 'mcp_adapter',
        outcome: 'success',
        elapsedMs: 50,
      });
    } finally {
      release('cleanup');
      info.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('MCP request operation timing attribution', () => {
  it('keeps async operation counts and durations on the owning request context', async () => {
    const first = createMcpRequestTraceExecutionContext();
    const second = createMcpRequestTraceExecutionContext();

    await runWithMcpRequestTraceExecution(first, async () => {
      recordMcpRequestTraceOperation('findLiveHostAsync', 12.3456);
      await Promise.resolve();
      recordMcpRequestTraceOperation('pathExistsAsync', 4.25);
      recordMcpRequestTraceOperation('pathExistsAsync', 5.5);
    });
    await runWithMcpRequestTraceExecution(second, async () => {
      recordMcpRequestTraceOperation('listLiveHostsAsync', 20);
    });

    expect(mcpRequestTraceOperationTimings(first)).toEqual({
      findLiveHostAsync: { count: 1, totalMs: 12.346, maxMs: 12.346 },
      pathExistsAsync: { count: 2, totalMs: 9.75, maxMs: 5.5 },
    });
    expect(mcpRequestTraceOperationTimings(second)).toEqual({
      listLiveHostsAsync: { count: 1, totalMs: 20, maxMs: 20 },
    });
    expect(mcpRequestTraceOperationTimings(createMcpRequestTraceExecutionContext())).toBeUndefined();
  });

  it('ignores invalid durations and returns a detached settlement snapshot', () => {
    const context = createMcpRequestTraceExecutionContext();
    runWithMcpRequestTraceExecution(context, () => {
      recordMcpRequestTraceOperation('pidIsPsuHostAsync', Number.NaN);
    });

    const snapshot = mcpRequestTraceOperationTimings(context);
    expect(snapshot).toEqual({ pidIsPsuHostAsync: { count: 1, totalMs: 0, maxMs: 0 } });
    runWithMcpRequestTraceExecution(context, () => recordMcpRequestTraceOperation('pidIsPsuHostAsync', 3));
    expect(snapshot).toEqual({ pidIsPsuHostAsync: { count: 1, totalMs: 0, maxMs: 0 } });
    expect(mcpRequestTraceOperationTimings(context)).toEqual({
      pidIsPsuHostAsync: { count: 2, totalMs: 3, maxMs: 3 },
    });
  });
});

describe('resolveMcpRequestTraceId (WI-6554700010008586)', () => {
  it('returns the proxy-minted header when present', () => {
    const valid = '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4';
    expect(resolveMcpRequestTraceId({ requestInfo: { headers: { [MCP_REQUEST_TRACE_HEADER]: valid } } })).toBe(valid);
  });

  it('gives every reader of one direct (proxy-less) request the SAME minted id', () => {
    // The recorder (requestOrigin) and the settlement backfill read the same
    // request separately; two independent fallbacks made their ids differ, so
    // the settlement could never find its invocation row.
    const request = { requestInfo: { headers: {} } };
    const recorded = resolveMcpRequestTraceId(request);
    const settled = resolveMcpRequestTraceId(request);

    expect(recorded).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(settled).toBe(recorded);
    expect(mcpTraceIdFromExtra(request)).toBeNull();
  });

  it('mints a distinct id for a distinct request', () => {
    expect(resolveMcpRequestTraceId({ requestInfo: { headers: {} } })).not.toBe(
      resolveMcpRequestTraceId({ requestInfo: { headers: {} } }),
    );
  });
});

describe('buildMcpSessionSurfaceTraceEvent', () => {
  it('distinguishes a new MCP transport session while retaining the native-session correlation', () => {
    const nativeSessionId = 'native-codex-session-123';
    const listed = buildMcpSessionSurfaceTraceEvent({
      traceId: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4',
      toolName: 'tools/list',
      stage: 'tools_list_completed',
      elapsedMs: 2,
      extra: {
        sessionId: 'mcp-transport-a',
        requestInfo: { headers: {
          'mcp-session-id': 'mcp-transport-a',
          'x-papercusp-native-session': nativeSessionId,
        } },
      },
      sessionKey: 'mcp-transport-a',
      sessionBaseline: 'recorded',
      servingGeneration: 'generation-1',
      outcome: 'success',
    });
    const rejected = buildMcpSessionSurfaceTraceEvent({
      traceId: '31abefb3-1770-443d-9a6f-37526761d3b0',
      toolName: 'coord:orient',
      stage: 'stale_contract_rejected',
      elapsedMs: 0,
      extra: {
        sessionId: 'mcp-transport-b',
        requestInfo: { headers: {
          'mcp-session-id': 'mcp-transport-b',
          'x-papercusp-native-session': nativeSessionId,
        } },
      },
      sessionKey: 'mcp-transport-b',
      sessionBaseline: 'missing',
      servingGeneration: 'generation-1',
      phase: 'pre_dispatch',
      outcome: 'rejected',
    });

    expect(listed).toMatchObject({
      stage: 'tools_list_completed',
      sessionBaseline: 'recorded',
      nativeSessionCarrier: 'header',
      servingGeneration: 'generation-1',
    });
    expect(rejected).toMatchObject({
      stage: 'stale_contract_rejected',
      phase: 'pre_dispatch',
      outcome: 'rejected',
      sessionBaseline: 'missing',
      servingGeneration: 'generation-1',
    });
    expect(rejected.mcpSessionKeyFingerprint).not.toBe(listed.mcpSessionKeyFingerprint);
    expect(rejected.wireMcpSessionIdFingerprint).not.toBe(listed.wireMcpSessionIdFingerprint);
    expect(rejected.nativeSessionClaimFingerprint).toBe(listed.nativeSessionClaimFingerprint);
    expect(JSON.stringify({ listed, rejected })).not.toContain(nativeSessionId);
  });
});

describe('logMcpRequestTrace', () => {
  it('timestamps each emitted record while preserving scratch phase timings', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const firstObservedAtMs = Date.UTC(2026, 9, 22, 16, 2);
    const secondObservedAtMs = firstObservedAtMs + 30_007;
    const now = vi.spyOn(Date, 'now').mockReturnValue(firstObservedAtMs);
    const prefix = '[mcp-request-trace] ';
    try {
      logMcpRequestTrace({
        traceId: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4',
        toolName: 'work_items:get',
        stage: 'scratch_write_progress',
        elapsedMs: 5_000,
        scratchWriteProgress: {
          phase: 'file-write',
          phaseElapsedMs: 5_000,
          totalElapsedMs: 5_000,
          bytes: 1_600,
          pendingWrites: 1,
          recoveryActive: false,
          refreshActive: false,
        },
      });
      now.mockReturnValue(secondObservedAtMs);
      logMcpRequestTrace({
        traceId: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4',
        toolName: 'work_items:get',
        stage: 'scratch_write_settled',
        elapsedMs: 30_007,
        scratchWriteTimings: {
          quotaWaitMs: 3,
          refreshWaitMs: 0,
          quotaRecoveryMs: 0,
          writeMs: 30_004,
          totalMs: 30_007,
        },
      });

      const events = info.mock.calls.map(([line]) => {
        expect(line).toContain(prefix);
        return JSON.parse(String(line).slice(prefix.length));
      });
      expect(events).toEqual([
        {
          traceId: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4',
          toolName: 'work_items:get',
          stage: 'scratch_write_progress',
          elapsedMs: 5_000,
          observedAtMs: firstObservedAtMs,
          scratchWriteProgress: {
            phase: 'file-write',
            phaseElapsedMs: 5_000,
            totalElapsedMs: 5_000,
            bytes: 1_600,
            pendingWrites: 1,
            recoveryActive: false,
            refreshActive: false,
          },
        },
        {
          traceId: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4',
          toolName: 'work_items:get',
          stage: 'scratch_write_settled',
          elapsedMs: 30_007,
          observedAtMs: secondObservedAtMs,
          scratchWriteTimings: {
            quotaWaitMs: 3,
            refreshWaitMs: 0,
            quotaRecoveryMs: 0,
            writeMs: 30_004,
            totalMs: 30_007,
          },
        },
      ]);
    } finally {
      now.mockRestore();
      info.mockRestore();
    }
  });
});

describe('mcpTraceIdFromExtra', () => {
  it('accepts only a bounded UUID trace header', () => {
    const valid = '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4';
    expect(
      mcpTraceIdFromExtra({
        requestInfo: { headers: { [MCP_REQUEST_TRACE_HEADER]: valid } },
      }),
    ).toBe(valid);
    for (const invalid of ['', 'caller-controlled', 'x'.repeat(200), '00000000-0000-0000-0000-000000000000']) {
      expect(
        mcpTraceIdFromExtra({
          requestInfo: { headers: { [MCP_REQUEST_TRACE_HEADER]: invalid } },
        }),
      ).toBeNull();
    }
  });
});

describe('mcpDataPlaneDegradedAtFromExtra', () => {
  it('accepts only a bounded positive integer timestamp', () => {
    const timestamp = 1_788_554_800_123;
    expect(
      mcpDataPlaneDegradedAtFromExtra({
        requestInfo: { headers: { [MCP_DATA_PLANE_DEGRADED_AT_HEADER]: String(timestamp) } },
      }),
    ).toBe(timestamp);

    for (const invalid of ['', '0', '-1', '1.5', 'not-a-timestamp', '8640000000000001', '9'.repeat(40)]) {
      expect(
        mcpDataPlaneDegradedAtFromExtra({
          requestInfo: { headers: { [MCP_DATA_PLANE_DEGRADED_AT_HEADER]: invalid } },
        }),
      ).toBeNull();
    }
  });
});
