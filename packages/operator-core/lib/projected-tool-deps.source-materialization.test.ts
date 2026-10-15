/**
 * WI-6554700010010307 — the projection audit record on the tool context must
 * reach `tool_invocations.metadata_json`.
 *
 * The flusher swallows insert errors (telemetry is best-effort), so a record
 * that never made it into the params would look exactly like a call with no
 * projection. Only asserting the INSERT params distinguishes the two.
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
vi.mock('./agent-tools/coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-materialization-test', ownerLabel: 'su · test' })),
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

import { PROJECTED_DEPS, flushPendingTelemetry } from './projected-tool-deps';

const ctx = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: 'ws-test',
    harnessSlug: 'papercusp',
    role: 'worker',
    spawnId: 's-materialization-test',
    log: vi.fn(),
    ...over,
  }) as never;

/** The metadata_json param, parsed — located by content so column order cannot drift it. */
async function recordAndReadMetadata(over: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  await PROJECTED_DEPS.recordInvocation!({
    toolName: 'x:probe',
    pluginName: 'agent-mcp',
    ctx: ctx(over),
    windowKey: 'w1',
    durationMs: 3,
    status: 'ok',
    args: { a: 1 },
    metadataJson: { handlerField: 'kept' },
  } as never);
  await flushPendingTelemetry();
  const insert = captured.find((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'));
  expect(insert, 'no tool_invocations INSERT was issued').toBeDefined();
  const meta = insert!.params.find((p) => typeof p === 'string' && p.includes('handlerField'));
  return typeof meta === 'string' ? (JSON.parse(meta) as Record<string, unknown>) : null;
}

describe('sourceMaterialization reaches tool_invocations.metadata_json', () => {
  beforeEach(() => {
    captured.length = 0;
  });
  afterEach(async () => {
    await flushPendingTelemetry();
    captured.length = 0;
  });

  it('writes the projection audit record beside handler metadata', async () => {
    const record = { trigger: 'projection', pipeOps: ['grep'], promotedToFull: true, structuredSource: false };
    const meta = await recordAndReadMetadata({ sourceMaterialization: record });
    expect(meta).toMatchObject({ handlerField: 'kept', sourceMaterialization: record });
  });

  it('omits the key for a call with no projection', async () => {
    const meta = await recordAndReadMetadata({});
    expect(meta).toMatchObject({ handlerField: 'kept' });
    expect(meta).not.toHaveProperty('sourceMaterialization');
  });
});

/**
 * WI-6554700010010439 — a nested code:run / recipe call runs unshaped but
 * inherits the outer session's requestOrigin (ctx_tier included). The row must
 * say it was nested, or a size audit counts script-internal bodies as results
 * that reached an agent at the outer session's tier.
 */
describe('nestedDispatch reaches tool_invocations.metadata_json', () => {
  beforeEach(() => {
    captured.length = 0;
  });
  afterEach(async () => {
    await flushPendingTelemetry();
    captured.length = 0;
  });

  it('marks a code-mode indirect dispatch with the tier it actually ran at', async () => {
    const meta = await recordAndReadMetadata({
      indirectDispatch: true,
      codeMode: true,
      contextTier: undefined,
      requestOrigin: { path: '/api/mcp', query: { ctx_tier: 'trimmed' } },
    });
    expect(meta).toMatchObject({
      handlerField: 'kept',
      requestOrigin: { query: { ctx_tier: 'trimmed' } },
      nestedDispatch: { indirect: true, codeMode: true, contextTier: null },
    });
  });

  it('records a non-code-mode indirect dispatch without the codeMode flag', async () => {
    const meta = await recordAndReadMetadata({ indirectDispatch: true, contextTier: 'trimmed' });
    expect(meta).toMatchObject({ nestedDispatch: { indirect: true, contextTier: 'trimmed' } });
    expect((meta as { nestedDispatch: object }).nestedDispatch).not.toHaveProperty('codeMode');
  });

  it('omits the key for a direct call', async () => {
    const meta = await recordAndReadMetadata({ contextTier: 'trimmed' });
    expect(meta).toMatchObject({ handlerField: 'kept' });
    expect(meta).not.toHaveProperty('nestedDispatch');
  });

  it('cannot be spoofed by handler metadata', async () => {
    await PROJECTED_DEPS.recordInvocation!({
      toolName: 'x:probe',
      pluginName: 'agent-mcp',
      ctx: ctx({}),
      windowKey: 'w1',
      durationMs: 3,
      status: 'ok',
      args: { a: 1 },
      metadataJson: { handlerField: 'kept', nestedDispatch: { indirect: true } },
    } as never);
    await flushPendingTelemetry();
    const insert = captured.find((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'));
    const raw = insert!.params.find((p) => typeof p === 'string' && p.includes('handlerField')) as string;
    // A direct call keeps the handler's own key untouched; the framework adds
    // nothing. The framework value wins only when it is set (ordering pin).
    expect(JSON.parse(raw)).toMatchObject({ nestedDispatch: { indirect: true } });
    captured.length = 0;
    await PROJECTED_DEPS.recordInvocation!({
      toolName: 'x:probe',
      pluginName: 'agent-mcp',
      ctx: ctx({ indirectDispatch: true, contextTier: 'full' }),
      windowKey: 'w1',
      durationMs: 3,
      status: 'ok',
      args: { a: 1 },
      metadataJson: { handlerField: 'kept', nestedDispatch: { indirect: false, contextTier: 'spoofed' } },
    } as never);
    await flushPendingTelemetry();
    const insert2 = captured.find((c) => c.sql.includes('INSERT INTO harness_shared.tool_invocations'));
    const raw2 = insert2!.params.find((p) => typeof p === 'string' && p.includes('handlerField')) as string;
    expect(JSON.parse(raw2)).toMatchObject({ nestedDispatch: { indirect: true, contextTier: 'full' } });
  });
});
