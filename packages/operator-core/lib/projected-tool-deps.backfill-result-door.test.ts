/**
 * EI-19389431406847252 — backfillResultDoorOutputRef unit coverage.
 *
 * The result-door's spill (packages/operator-core/lib/result-door.ts) runs in
 * _mcp-handler.ts's execute(), STRICTLY AFTER runDispatchStack's `finally` has
 * already snapshotted+queued the tool_invocations telemetry row for that call —
 * so the door's spill path never reaches output_ref without this explicit
 * best-effort backfill. This pins: (1) the required-field early return (no PG
 * call at all when workspaceId/spawnId are missing), (2) the happy path issues
 * the expected set_config + correlated UPDATE with the right bind values, and
 * (3) a PG failure is swallowed (never thrown) and logged, matching the rest of
 * this file's telemetry writes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
}));

// Captures every `tx.unsafe(sql, params)` call made inside `sql.begin(fn)`, and
// lets a test flip the resolved tx (or throw) per-case.
const unsafeCalls = vi.hoisted(() => [] as Array<{ sql: string; params: unknown[] }>);
const beginImpl = vi.hoisted(() => ({
  fn: async (cb: (tx: { unsafe: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
    const tx = {
      unsafe: vi.fn(async (sql: string, params: unknown[]) => {
        unsafeCalls.push({ sql, params });
        return [];
      }),
    };
    return cb(tx);
  },
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({
    sql: {
      begin: (cb: (tx: { unsafe: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<unknown>) =>
        beginImpl.fn(cb),
    },
    db: {
      insert: () => ({ values: vi.fn(async () => {}) }),
    },
  }),
}));

import {
  backfillResultDoorOutputRef,
  backfillToolInvocationMetadataByCallId,
  backfillToolInvocationMetadataByMcpRequestTraceId,
  EXACT_BACKFILL_WINDOW_SEC,
  flushPendingTelemetry,
} from './projected-tool-deps';

describe('backfillResultDoorOutputRef (EI-19389431406847252)', () => {
  beforeEach(() => {
    unsafeCalls.length = 0;
    beginImpl.fn = async (cb) => {
      const tx = {
        unsafe: vi.fn(async (sql: string, params: unknown[]) => {
          unsafeCalls.push({ sql, params });
          return [];
        }),
      };
      return cb(tx);
    };
  });

  afterEach(async () => {
    await flushPendingTelemetry().catch(() => {});
    vi.clearAllMocks();
  });

  it('is a no-op (no PG call) when workspaceId is missing', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: null,
      spawnId: 's-1',
      toolName: 'x:one',
      outputRef: 'papercusp://scratch/x',
      outputSize: 123,
    });
    expect(unsafeCalls).toHaveLength(0);
  });

  it('is a no-op (no PG call) when spawnId is missing', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: undefined,
      toolName: 'x:one',
      outputRef: 'papercusp://scratch/x',
      outputSize: 123,
    });
    expect(unsafeCalls).toHaveLength(0);
  });

  it('issues set_config + a correlated UPDATE with the expected bind values', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'x:one',
      runId: 'run-abc',
      outputRef: 'papercusp://scratch/papercusp-workspace/x:one/result-door-1.md',
      outputSize: 4200,
      metadataJson: { returnedContextBytes: 512, spilledBytes: 4200 },
    });

    expect(unsafeCalls).toHaveLength(2);

    // 1) set_config('app.workspace_id', workspaceId, true)
    expect(unsafeCalls[0].sql).toContain('set_config');
    expect(unsafeCalls[0].params).toEqual(['ws-test']);

    // 2) the correlated UPDATE — outputRef/outputSize first, then the
    //    workspaceId/spawnId/toolName/runId correlation key, in that order.
    expect(unsafeCalls[1].sql).toContain('UPDATE harness_shared.tool_invocations');
    expect(unsafeCalls[1].sql).toContain('output_ref IS NULL');
    expect(unsafeCalls[1].sql).toContain("metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb");
    expect(unsafeCalls[1].params).toEqual([
      'papercusp://scratch/papercusp-workspace/x:one/result-door-1.md',
      4200,
      JSON.stringify({ returnedContextBytes: 512, spilledBytes: 4200 }),
      'ws-test',
      's-test',
      'x:one',
      'run-abc',
      null,
      null,
    ]);
  });

  it('backfills a late spill settlement by its exact reserved URI after the ordinary recency window', async () => {
    const uri = 'papercusp://scratch/papercusp-workspace/x:late/result-door-1.md';
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'x:late',
      runId: 'run-late',
      outputRef: uri,
      outputSize: 4200,
      matchOutputRef: uri,
      metadataJson: { spillPending: false, spillFailed: false, spillSettlementStatus: 'persisted' },
    });

    expect(unsafeCalls[1].sql).toContain('output_ref = $8');
    expect(unsafeCalls[1].sql).toContain("invoked_at >= now() - interval '30 seconds'");
    expect(unsafeCalls[1].sql).toContain('OR ($8::text IS NOT NULL AND output_ref = $8)');
    expect(unsafeCalls[1].params).toEqual([
      uri,
      4200,
      JSON.stringify({ spillPending: false, spillFailed: false, spillSettlementStatus: 'persisted' }),
      'ws-test',
      's-test',
      'x:late',
      'run-late',
      uri,
      null,
    ]);
  });

  it('merges late scratch timings into the nested MCP settlement phase snapshot', async () => {
    const uri = 'papercusp://scratch/papercusp-workspace/x:late-trace/result-door-1.md';
    const traceId = '2a81dadf-78dc-4eab-96cc-f8193f277c25';
    const metadataJson = {
      spillPending: false,
      spillSettlementStatus: 'persisted',
      scratchWriteTimings: { count: 1, totalMs: 30_007 },
      mcpRequestSettlement: {
        phaseTimingsMs: {
          scratchWrites: { count: 1, totalMs: 30_007 },
        },
      },
    };
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'x:late-trace',
      mcpRequestTraceId: traceId,
      outputRef: uri,
      outputSize: 4200,
      matchOutputRef: uri,
      metadataJson,
    });

    expect(unsafeCalls[1].sql).toContain("metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb ||");
    expect(unsafeCalls[1].sql).toContain("metadata_json #> '{mcpRequestSettlement,phaseTimingsMs}'");
    expect(unsafeCalls[1].sql).toContain("jsonb_typeof($3::jsonb #> '{mcpRequestSettlement,phaseTimingsMs}') = 'object'");
    expect(unsafeCalls[1].params[2]).toBe(JSON.stringify(metadataJson));
    expect(unsafeCalls[1].params.slice(7)).toEqual([uri, traceId]);
  });

  it('backfills a result-door spill by exact MCP request trace id beyond the ordinary recency window', async () => {
    const uri = 'papercusp://scratch/papercusp-workspace/x:trace/result-door-1.md';
    const traceId = '640b0562-af01-4850-88e9-8ed54f9a032a';
    const metadataJson = { spillPending: false, spillSettlementStatus: 'persisted' };
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'x:trace',
      runId: 'run-trace',
      mcpRequestTraceId: traceId,
      outputRef: uri,
      outputSize: 4200,
      metadataJson,
    });

    expect(unsafeCalls).toHaveLength(2);
    expect(unsafeCalls[1].sql).toContain("metadata_json->'requestOrigin'->>'mcpRequestTraceId' = $9");
    expect(unsafeCalls[1].sql).toContain("OR ($9::text IS NOT NULL AND metadata_json->'requestOrigin'->>'mcpRequestTraceId' = $9)");
    expect(unsafeCalls[1].sql).toContain("invoked_at >= now() - interval '30 seconds'");
    expect(unsafeCalls[1].params).toEqual([
      uri,
      4200,
      JSON.stringify(metadataJson),
      'ws-test',
      's-test',
      'x:trace',
      'run-trace',
      null,
      traceId,
    ]);
  });

  it('defaults runId to null when omitted', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'x:two',
      outputRef: 'papercusp://scratch/x',
      outputSize: 1,
    });
    expect(unsafeCalls[1].params[6]).toBeNull();
  });

  it('supports a metadata-only post-door merge when spill persistence failed', async () => {
    await backfillResultDoorOutputRef({
      workspaceId: 'ws-test',
      spawnId: 's-test',
      toolName: 'code:run',
      metadataJson: {
        returnedContextBytes: 600,
        spilledBytes: 0,
        aggregateOutputEscape: true,
        spillFailed: true,
        spillError: 'scratch reservation exceeds workspace quota',
        spillErrorCode: 'SCRATCH_QUOTA_EXCEEDED',
      },
    });
    expect(unsafeCalls[1].params.slice(0, 3)).toEqual([
      null,
      null,
      JSON.stringify({
        returnedContextBytes: 600,
        spilledBytes: 0,
        aggregateOutputEscape: true,
        spillFailed: true,
        spillError: 'scratch reservation exceeds workspace quota',
        spillErrorCode: 'SCRATCH_QUOTA_EXCEEDED',
      }),
    ]);
  });

  it('backfills late scheduler settlement by exact dispatchCallId, never by recency', async () => {
    await backfillToolInvocationMetadataByCallId({
      workspaceId: 'ws-test',
      toolName: 'scheduler:get_next',
      dispatchCallId: 'dispatch-call-42',
      metadataJson: {
        schedulerLateSettlement: {
          kind: 'claimed',
          workItemId: 'EI-42',
          settledAt: '2026-10-07T16:00:00.000Z',
        },
      },
    });

    expect(unsafeCalls).toHaveLength(2);
    expect(unsafeCalls[0].params).toEqual(['ws-test']);
    expect(unsafeCalls[1].sql).toContain('UPDATE harness_shared.tool_invocations');
    expect(unsafeCalls[1].sql).toContain("metadata_json->'schedulerTimeout'->>'dispatchCallId' = $4");
    // Exact key selects; the 30-second recency JOIN of the result-door backfill
    // must never be used as the selector here.
    expect(unsafeCalls[1].sql).not.toContain("interval '30 seconds'");
    expect(unsafeCalls[1].sql).toContain('invoked_at >= now() - make_interval(secs => $5::int)');
    expect(unsafeCalls[1].params).toEqual([
      JSON.stringify({
        schedulerLateSettlement: {
          kind: 'claimed',
          workItemId: 'EI-42',
          settledAt: '2026-10-07T16:00:00.000Z',
        },
      }),
      'ws-test',
      'scheduler:get_next',
      'dispatch-call-42',
      EXACT_BACKFILL_WINDOW_SEC['dispatch-call-id'],
    ]);
  });

  // WI-6554700010008556: an exact key that matches no row used to walk the whole
  // tool_invocations table backwards (mean 966 ms, max 342 s, ~1 core of DB time).
  // Every exact-key backfill must carry a recency BOUND, wide enough for the
  // legitimate late-settlement path and finite, so a miss stays cheap.
  it('bounds every exact-key backfill search by a finite invoked_at window', async () => {
    await backfillToolInvocationMetadataByCallId({
      workspaceId: 'ws-test',
      toolName: 'scheduler:get_next',
      dispatchCallId: 'dispatch-call-7',
      metadataJson: { schedulerLateSettlement: { kind: 'claimed' } },
    });
    await backfillToolInvocationMetadataByMcpRequestTraceId({
      workspaceId: 'ws-test',
      toolName: 'work_items:get',
      mcpRequestTraceId: 'trace-7',
      metadataJson: { mcpRequestSettlement: { outcome: 'success' } },
    });

    const updates = unsafeCalls.filter((c) => c.sql.includes('UPDATE harness_shared.tool_invocations'));
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.sql).toMatch(/AND invoked_at >= now\(\) - make_interval\(secs => \$5::int\)\s+ORDER BY invoked_at DESC/);
      const windowSec = update.params[4];
      expect(typeof windowSec).toBe('number');
      expect(Number.isInteger(windowSec)).toBe(true);
      expect(windowSec as number).toBeGreaterThan(0);
      // Finite and bounded: never a whole-table fallback.
      expect(windowSec as number).toBeLessThanOrEqual(24 * 60 * 60);
    }
    // The settle-time MCP path writes and backfills the same recent row; keep
    // room for flush and clock lag, but no more than an hour.
    expect(EXACT_BACKFILL_WINDOW_SEC['mcp-request-trace-id']).toBeGreaterThanOrEqual(5 * 60);
    expect(EXACT_BACKFILL_WINDOW_SEC['mcp-request-trace-id']).toBeLessThanOrEqual(60 * 60);
    // The late scheduler settlement can land long after the timed-out row.
    expect(EXACT_BACKFILL_WINDOW_SEC['dispatch-call-id']).toBeGreaterThanOrEqual(
      EXACT_BACKFILL_WINDOW_SEC['mcp-request-trace-id'],
    );
  });

  it('backfills late MCP settlement metadata by exact request trace id, never by recency', async () => {
    const traceId = '640b0562-af01-4850-88e9-8ed54f9a032a';
    const metadataJson = {
      mcpRequestSettlement: {
        traceId,
        outcome: 'success',
        afterDeadline: true,
        elapsedMs: 56_894,
        phaseTimingsMs: { resultDoor: 30_662, scratchWrites: { count: 1, totalMs: 12_000 } },
      },
    };
    await backfillToolInvocationMetadataByMcpRequestTraceId({
      workspaceId: 'ws-test',
      toolName: 'plans:get-spec-evidence',
      mcpRequestTraceId: traceId,
      metadataJson,
    });

    expect(unsafeCalls).toHaveLength(2);
    expect(unsafeCalls[0].params).toEqual(['ws-test']);
    expect(unsafeCalls[1].sql).toContain('UPDATE harness_shared.tool_invocations');
    expect(unsafeCalls[1].sql).toContain("metadata_json->'requestOrigin'->>'mcpRequestTraceId' = $4");
    expect(unsafeCalls[1].sql).toContain("metadata_json #> '{mcpRequestSettlement,phaseTimingsMs}'");
    expect(unsafeCalls[1].sql).toContain('ORDER BY invoked_at DESC');
    expect(unsafeCalls[1].sql).not.toContain("interval '30 seconds'");
    expect(unsafeCalls[1].sql).toContain('invoked_at >= now() - make_interval(secs => $5::int)');
    expect(unsafeCalls[1].params).toEqual([
      JSON.stringify(metadataJson),
      'ws-test',
      'plans:get-spec-evidence',
      traceId,
      EXACT_BACKFILL_WINDOW_SEC['mcp-request-trace-id'],
    ]);
  });

  it('does not guess a late MCP invocation when the request trace id is absent', async () => {
    await backfillToolInvocationMetadataByMcpRequestTraceId({
      workspaceId: 'ws-test',
      toolName: 'plans:get-spec-evidence',
      mcpRequestTraceId: null,
      metadataJson: { mcpRequestSettlement: { outcome: 'success' } },
    });

    expect(unsafeCalls).toHaveLength(0);
  });

  it('swallows a PG failure and logs a warning instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    beginImpl.fn = async () => {
      throw new Error('backfill UPDATE exploded');
    };

    await expect(
      backfillResultDoorOutputRef({
        workspaceId: 'ws-test',
        spawnId: 's-test',
        toolName: 'x:three',
        outputRef: 'papercusp://scratch/x',
        outputSize: 1,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('backfillResultDoorOutputRef failed for x:three'));
  });
});

/** WI-40720 gap 3. The backfill CONTRACT is exercised above; this pins its CALL SITE, which is the
 *  half that was actually broken. The handler gated post-door enrichment on a literal
 *  `toolName === 'code:run'`, so a recipes:run or orchestrate:run call could spill real bytes and
 *  record no telemetry for them — and the rollout gates then graded a default-on orchestration
 *  suite on code:run traffic alone. Nothing failed; the numbers were simply about a smaller
 *  population than they appeared to describe.
 *
 *  Asserted against the source because the condition lives in a deep dispatch closure with no
 *  seam to call directly. That is a real limitation, so the check is written to fail LOUDLY if it
 *  ever stops measuring: it proves it read a plausible handler before asserting anything about it. */
describe('WI-40720 gap 3 — the post-door backfill call site is door-general, not code:run-only', () => {
  const handlerSource = readFileSync(
    fileURLToPath(new URL('./endpoint-route/routes/transport/_mcp-host.ts', import.meta.url)),
    'utf8',
  );

  it('POSITIVE CONTROL — the guard is actually reading the handler', () => {
    // An absence claim needs a positive control: if the file moves or is renamed, every
    // assertion below would pass vacuously on an empty string. Prove the subject is present
    // FIRST, so a silent miss becomes a loud failure.
    expect(handlerSource.length).toBeGreaterThan(1000);
    expect(handlerSource).toContain('backfillResultDoorOutputRef');
  });

  it('classifies the door with the shared predicate instead of a hardcoded tool name', () => {
    expect(handlerSource).toContain('isPreferredDoor(toolName)');
    // The specific regression: the metadata branch must not be keyed to one door again.
    expect(handlerSource).not.toContain("...(toolName === 'code:run'");
  });

  it('stamps spillPath, the join key that makes spill resolution measurable', () => {
    // result-door.ts has always emitted spillPath; the handler dropped it because its inline
    // type never declared it. A later capability:read records the same path in args_json, so
    // without this stamp the two halves of a spill round-trip cannot be correlated at all.
    expect(handlerSource).toContain('spillPath?: string | null;');
    expect(handlerSource).toContain('doorMeta.spillPath');
  });

  it('stamps spillUri into the row metadata, not only into outputRef', () => {
    // spillUri is the row's own outputRef column, so duplicating it into metadata_json looks
    // redundant — that is exactly why it is easy to drop. The instrumentation SQL reads spills
    // out of metadata_json; a spillUri that exists ONLY in the column is invisible to every
    // spill count, so the measurement would report zero spills on a system that is spilling.
    expect(handlerSource).toContain('spillUri?: string;');
    expect(handlerSource).toContain('{ spillUri: doorMeta.spillUri }');
  });

  it('correlates both initial spill backfill and late settlement with the MCP request trace id', () => {
    const lateStart = handlerSource.indexOf('onLateScratchWriteSettled: (settlement) =>');
    const lateEnd = handlerSource.indexOf('onScratchWriteTiming: (timings) =>', lateStart);
    expect(lateStart).toBeGreaterThan(-1);
    expect(lateEnd).toBeGreaterThan(lateStart);
    expect(handlerSource.slice(lateStart, lateEnd)).toContain(
      'mcpRequestTraceId: dispatchSpawnCtx.requestOrigin?.mcpRequestTraceId ?? null',
    );

    const postDoorStart = handlerSource.indexOf(
      'void backfillResultDoorOutputRef({',
      handlerSource.indexOf('if (doorMeta?.truncated'),
    );
    const postDoorEnd = handlerSource.indexOf('}).catch((err) =>', postDoorStart);
    expect(postDoorStart).toBeGreaterThan(-1);
    expect(postDoorEnd).toBeGreaterThan(postDoorStart);
    expect(handlerSource.slice(postDoorStart, postDoorEnd)).toContain(
      'mcpRequestTraceId: dispatchSpawnCtx.requestOrigin?.mcpRequestTraceId ?? null',
    );
  });

  it('uses the nested tools:invoke target for pending, late, and settled spill backfills', () => {
    const pendingStart = handlerSource.indexOf(
      'onScratchWritePending: (timeout) => backfillResultDoorOutputRef({',
    );
    const lateStart = handlerSource.indexOf('onLateScratchWriteSettled: (settlement) =>');
    const lateEnd = handlerSource.indexOf('onScratchWriteTiming: (timings) =>', lateStart);
    const settledStart = handlerSource.indexOf(
      'void backfillResultDoorOutputRef({',
      handlerSource.indexOf('if (doorMeta?.truncated'),
    );
    const settledEnd = handlerSource.indexOf('}).catch((err) =>', settledStart);

    expect(pendingStart).toBeGreaterThan(-1);
    expect(lateStart).toBeGreaterThan(pendingStart);
    expect(lateEnd).toBeGreaterThan(lateStart);
    expect(settledStart).toBeGreaterThan(-1);
    expect(settledEnd).toBeGreaterThan(settledStart);

    const pending = handlerSource.slice(pendingStart, lateStart);
    const late = handlerSource.slice(lateStart, lateEnd);
    const settled = handlerSource.slice(settledStart, settledEnd);
    for (const callSite of [pending, late, settled]) {
      expect(callSite).toContain('toolName: nestedTargetToolName ?? toolName');
    }
  });

  it('stamps spillFailed UNCONDITIONALLY, so absent never reads as measured-false', () => {
    // The hard rollback trigger for spill-persistence failure is only falsifiable if the
    // healthy case is stamped too. A conditional spread would omit the key whenever the spill
    // SUCCEEDED, making "no failure recorded" indistinguishable from "never measured" — and
    // gap 4 would read an unmeasured door as a clean pass. Hence `=== true`, never a spread.
    expect(handlerSource).toContain('spillFailed?: boolean;');
    expect(handlerSource).toContain('spillFailed: doorMeta.spillFailed === true');
    // The negative half of the guard: a conditional stamp is the specific regression.
    expect(handlerSource).not.toContain('...(doorMeta.spillFailed === true ? { spillFailed:');
  });

  it('wires late spill settlement to the output-ref backfill', () => {
    expect(handlerSource).toContain('onLateScratchWriteSettled: (settlement) =>');
    expect(handlerSource).toContain('matchOutputRef: settlement.spillUri');
    expect(handlerSource).toContain('spillSettlementStatus: settlement.status');
    expect(handlerSource).toContain('spillPending: false');
  });

  it('backfills failed spills without a URI and preserves their descriptive error metadata', () => {
    expect(handlerSource).toContain('spillError?: string | null;');
    expect(handlerSource).toContain('spillErrorCode?: string | null;');
    expect(handlerSource).toContain('doorMeta.spillFailed === true || isPreferredDoor(toolName)');
    expect(handlerSource).toContain('spillError: doorMeta.spillError ?? null');
    expect(handlerSource).toContain('spillErrorCode: doorMeta.spillErrorCode ?? null');
  });
});
