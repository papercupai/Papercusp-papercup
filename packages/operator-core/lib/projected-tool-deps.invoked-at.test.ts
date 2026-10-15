/**
 * EI-7040 — invoked_at must be the DISPATCH-SETTLE time, stamped per row, not
 * the batch-flush time. The writer is deferred + batched and Postgres now() is
 * transaction-stable, so before the explicit $26 stamp every row in one flush
 * shared a single microsecond timestamp — which (a) skewed time-series reads by
 * up to debounceMs and (b) made batch-mates look like duplicate inserts (the
 * statusline double-call read as "2 identical rows").
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
vi.mock('./decision-ledger/emit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDecisionLedger: vi.fn(),
}));
vi.mock('./agent-tools/coordination/dispatch-heartbeat', () => ({
  maybeBeatPresenceOnDispatch: vi.fn(),
}));

// Capture every tx.unsafe(sql, params) the flush issues.
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

import {
  PROJECTED_DEPS,
  flushPendingTelemetry,
  isUnresolvedTelemetryScopePlaceholder,
  __resetTelemetryHealthForTests,
} from './projected-tool-deps';

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    role: 'worker',
    spawnId: 's-test',
    log: vi.fn(),
    ...over,
  }) as never;

function record(toolName: string, over: Record<string, unknown> = {}): Promise<void> | void {
  return PROJECTED_DEPS.recordInvocation!({
    toolName,
    pluginName: 'agent-mcp',
    ctx: ctx(over),
    windowKey: 'w1',
    durationMs: 3,
    status: 'ok',
    args: { a: 1 },
  } as never);
}

describe('telemetry invoked_at stamping (EI-7040)', () => {
  beforeEach(() => {
    captured.length = 0;
    __resetTelemetryHealthForTests();
  });
  afterEach(async () => {
    await flushPendingTelemetry();
    __resetTelemetryHealthForTests();
    captured.length = 0;
  });

  it('stamps a per-row dispatch-time invoked_at; placeholder count matches params', async () => {
    const before = Date.now();
    await record('x:one');
    await new Promise((r) => setTimeout(r, 15));
    await record('x:two');
    const after = Date.now();
    await flushPendingTelemetry();

    const inserts = captured.filter((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'));
    expect(inserts).toHaveLength(2);
    for (const ins of inserts) {
      // $n placeholder count must match the params array — drift here silently
      // breaks ALL telemetry (the flush swallows insert errors by design).
      const placeholders = new Set(ins.sql.match(/\$\d+/g)).size;
      expect(placeholders).toBe(ins.params.length);
      expect(ins.sql).toContain('invoked_at');
    }
    // invoked_at is $26 (params index 25). Addressed by its FIXED position, not
    // as "the last param": P-009 appended three declaration columns after it,
    // and the trailing-index form silently read goal_ref instead — parsing null
    // to NaN, which fails as an unhelpful "expected NaN" rather than naming the
    // cause. A column added later must not be able to re-point this assertion.
    const P_INVOKED_AT = 25;
    const [t1, t2] = inserts.map((i) => Date.parse(String(i.params[P_INVOKED_AT])));
    // Both timestamps are real dispatch-window times…
    expect(t1).toBeGreaterThanOrEqual(before - 5);
    expect(t2).toBeLessThanOrEqual(after + 5);
    // …and they DIFFER (per-row stamping) even though both rows share one flush.
    expect(t2).toBeGreaterThan(t1);
  });

  it.each(['http', 'uds'] as const)('persists protocol and %s connection metadata alongside reaction metadata', async connection => {
    const mcpRequestTraceId = 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e';
    await record('pot:set-steering', {
      transport: 'mcp',
      requestOrigin: {
        transport: 'mcp',
        connection,
        mcpRequestTraceId,
        path: '/api/mcp',
        query: { superuser: '1', workspace: 'ws-test', client: 'su-test' },
        headers: { 'x-papercusp-client': 'su-test', 'user-agent': 'codex-cli-test' },
      },
      reactionCause: {
        depth: 1,
        chain: ['rule-a'],
        ruleId: 'rule-a',
        rootRunId: 'run-root',
      },
    });
    await flushPendingTelemetry();

    const insert = captured.find((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'))!;
    const metadata = JSON.parse(String(insert.params[19]));
    expect(metadata).toMatchObject({
      requestOrigin: {
        transport: 'mcp',
        connection,
        mcpRequestTraceId,
        path: '/api/mcp',
        query: { superuser: '1', workspace: 'ws-test', client: 'su-test' },
        headers: { 'x-papercusp-client': 'su-test', 'user-agent': 'codex-cli-test' },
      },
      reaction: {
        depth: 1,
        chain: ['rule-a'],
        ruleId: 'rule-a',
        rootRunId: 'run-root',
      },
    });
  });

  it('persists host-classified native carrier evidence without a raw native session value', async () => {
    const nativeSession = {
      carrier: 'header:x-papercusp-native-session' as const,
      valueFingerprint: 'a'.repeat(64),
      binding: 'bound' as const,
      candidateAdvSessionId: 541,
    };
    await record('gatingtest:scoped', {
      transport: 'mcp',
      requestOrigin: { transport: 'mcp', nativeSession },
    });
    await flushPendingTelemetry();
    const insert = captured.find(c => c.sql.includes('INSERT INTO harness_shared.tool_invocations'))!;
    expect(JSON.parse(String(insert.params[19]))).toMatchObject({ requestOrigin: { nativeSession } });
  });

  it('rejects unresolved shell scope placeholders before they reach the INSERT (EI-21334973614275969)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(isUnresolvedTelemetryScopePlaceholder('${PAPERCUSP_WORKSPACE}')).toBe(true);
    expect(isUnresolvedTelemetryScopePlaceholder('$PAPERCUSP_WORKSPACE')).toBe(true);
    expect(isUnresolvedTelemetryScopePlaceholder('*')).toBe(false);
    expect(isUnresolvedTelemetryScopePlaceholder('papercusp-workspace')).toBe(false);

    await record('x:placeholder', { workspaceId: '${PAPERCUSP_WORKSPACE}' });
    await flushPendingTelemetry();

    expect(captured.filter((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'))).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unresolved workspace or harness scope placeholder'),
    );
    warn.mockRestore();
  });

  it('rejects an unresolved harness scope even when the workspace is concrete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await record('x:placeholder', { harnessSlug: '${PAPERCUSP_HARNESS_SLUG}' });
    await flushPendingTelemetry();

    expect(captured.filter((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'))).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
