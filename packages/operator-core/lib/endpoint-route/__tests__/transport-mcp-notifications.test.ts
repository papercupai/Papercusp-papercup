/**
 * MCP notifications/papercusp/event integration tests.
 *
 * Ported from app/api/[transport]/mcp-notifications.test.ts during the
 * endpoint-route migration — the transport logic moved to
 * routes/transport/_mcp-handler.ts, which re-exports the same test
 * helpers (`__buildMcpToolContext_forTests`, `MCP_SERVER_CAPABILITIES`).
 * Only the import path changed; the assertions are unchanged.
 *
 * Drives the emit closure built by buildMcpToolContext and captures the
 * JSON-RPC notifications the MCP transport would send. Verifies:
 *   - emit('<name>', data) fires notifications/papercusp/event.
 *   - emit('progress', …) ALSO fires notifications/progress.
 *   - Uint8Array data is base64-enveloped, not numeric-keyed.
 *   - progressToken passes through.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  __buildMcpToolContext_forTests,
  __withMcpSessionSurfaceRecheckForTests,
  type BuiltSpawnContext,
} from '../routes/transport/_mcp-host';
import { MCP_SERVER_CAPABILITIES } from '../routes/transport/mcp-contract';
import { buildMcpSessionSurfaceTraceEvent } from '../../mcp-request-trace';
import {
  getSessionSurface,
  sessionToolSurfaceKey,
  rememberSessionToolRegistryRevision,
  __resetSessionSurfaces,
} from '../routes/transport/tool-allowlist';

const fakeSpawn: BuiltSpawnContext = {
  workspaceId: 'default',
  harnessSlug: 'system',
  role: 'operator',
  featureId: null,
  chunkId: null,
  runId: 'mcp-test-run',
  spawnId: 'mcp-test-spawn',
  parentSpawnId: null,
  uiClientId: null,
  detectorSessionKey: null,
};

/** A spawn with a stable session identity — required for activateTools. */
const seededSpawn: BuiltSpawnContext = { ...fakeSpawn, uiClientId: 'sess-A' };
const seededSurfaceKey = sessionToolSurfaceKey(seededSpawn.uiClientId, seededSpawn.workspaceId)!;

function recordingSendNotification() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    sent,
    sendNotification: async (notif: { method: string; params: Record<string, unknown> }) => {
      sent.push(notif);
    },
  };
}

describe('MCP emit → notifications', () => {
  it('emits notifications/papercusp/event for an arbitrary named event', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-1', sendNotification);
    ctx.emit('delta', { text: 'hello' });
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      method: 'notifications/papercusp/event',
      params: { progressToken: 'tok-1', event: 'delta', data: { text: 'hello' } },
    });
  });

  it('emit("progress", …) ALSO fires notifications/progress (spec-compliance)', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 42, sendNotification);
    ctx.emit('progress', { progress: 50, total: 100, message: 'halfway' });
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    expect(sent.map((n) => n.method)).toEqual([
      'notifications/papercusp/event',
      'notifications/progress',
    ]);
    expect(sent[1].params).toEqual({
      progressToken: 42,
      progress: 50,
      total: 100,
      message: 'halfway',
    });
  });

  it('Uint8Array data is base64-enveloped, not JSON-stringified to numeric keys', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-bin', sendNotification);
    ctx.emit('chunk', new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    const n = sent[0];
    expect(n.method).toBe('notifications/papercusp/event');
    const data = n.params.data as Record<string, unknown>;
    expect(data).toMatchObject({
      $papercuspBinary: true,
      encoding: 'base64',
      data: '3q2+7w==',
    });
    expect(data['0']).toBeUndefined();
  });

  it('notifications/progress is SKIPPED when data is Uint8Array (no spec interpretation)', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-bin-progress', sendNotification);
    ctx.emit('progress', new Uint8Array([1, 2, 3]));
    await new Promise((r) => setImmediate(r));
    expect(sent.map((n) => n.method)).toEqual(['notifications/papercusp/event']);
  });

  it('emit is a no-op when client did not supply a progressToken', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, undefined, sendNotification);
    ctx.emit('delta', { text: 'should-not-send' });
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);
  });

  it('emit is a no-op when sendNotification is undefined', async () => {
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-no-sender', undefined);
    expect(() => ctx.emit('delta', { text: 'silent' })).not.toThrow();
  });

  it('carries a validated MCP idempotency key into the unified tool context', async () => {
    const ctx = await __buildMcpToolContext_forTests(
      fakeSpawn,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'retry-key-1',
    );
    expect(ctx.idempotencyKey).toBe('retry-key-1');
  });

  it('MCP_SERVER_CAPABILITIES declares the Papercusp typed-events extension (P4.8)', () => {
    expect(MCP_SERVER_CAPABILITIES).toMatchObject({
      tools: { listChanged: true },
      resources: {},
      prompts: {},
      experimental: {
        'papercusp/typedEvents': { version: '1' },
      },
    });
  });

  it('declares tools.listChanged (dynamic-tool-surface P-002) — required for OMP/Codex re-fetch', () => {
    // OMP checks `capabilities.tools?.listChanged === true` before it will act
    // on a tools/list_changed notification. If this regresses to `{}` the
    // dynamic-expansion round-trip silently breaks (the client never re-fetches).
    expect(MCP_SERVER_CAPABILITIES.tools.listChanged).toBe(true);
  });

  describe('ctx.activateTools → notifications/tools/list_changed (dynamic-tool-surface P-003)', () => {
    it('fires list_changed exactly once when a SEEDED session grows', async () => {
      __resetSessionSurfaces();
      // Seed the session as tools/list would on first contact.
      getSessionSurface(seededSurfaceKey, new Set(['coord:orient']));
      const { sent, sendNotification } = recordingSendNotification();
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, sendNotification);
      const grew = ctx.activateTools!(['flags:set', 'harness:status']);
      await new Promise((r) => setImmediate(r));
      expect(grew).toBe(true);
      expect(sent).toEqual([{ method: 'notifications/tools/list_changed', params: {} }]);
      // The grown set is now visible to a re-fetch.
      expect(getSessionSurface(seededSurfaceKey, new Set(['coord:orient']))).toEqual(
        new Set(['coord:orient', 'flags:set', 'harness:status']),
      );
    });

    it('does NOT fire when activation adds nothing new (no re-fetch spam)', async () => {
      __resetSessionSurfaces();
      getSessionSurface(seededSurfaceKey, new Set(['coord:orient', 'flags:set']));
      const { sent, sendNotification } = recordingSendNotification();
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, sendNotification);
      const grew = ctx.activateTools!(['flags:set']); // already present
      await new Promise((r) => setImmediate(r));
      expect(grew).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('is a no-op for an UN-SEEDED (full-catalog / Claude) session — never fires', async () => {
      __resetSessionSurfaces();
      // No getSessionSurface() seeding → no surface entry for this session.
      const { sent, sendNotification } = recordingSendNotification();
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, sendNotification);
      const grew = ctx.activateTools!(['flags:set']);
      await new Promise((r) => setImmediate(r));
      expect(grew).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it('cannot grow or notify a different workspace with the same stable client id', async () => {
      __resetSessionSurfaces();
      const otherKey = sessionToolSurfaceKey(seededSpawn.uiClientId, 'other-workspace')!;
      getSessionSurface(otherKey, new Set(['coord:orient']));
      const { sent, sendNotification } = recordingSendNotification();
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, sendNotification);
      expect(ctx.activateTools!(['flags:set'])).toBe(false);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toHaveLength(0);
      expect(getSessionSurface(otherKey, new Set(['coord:orient']))?.has('flags:set')).toBe(false);
    });

    it('never throws when sendNotification is undefined', async () => {
      __resetSessionSurfaces();
      getSessionSurface(seededSurfaceKey, new Set(['coord:orient']));
      const ctx = await __buildMcpToolContext_forTests(seededSpawn, undefined, undefined);
      expect(() => ctx.activateTools!(['flags:set'])).not.toThrow();
    });
  });

  describe('ctx.dispatchTool (tools:invoke engine, dynamic-tool-surface P-006)', () => {
    it('is present on an MCP ctx and returns unknown_tool for a bogus name', async () => {
      const ctx = await __buildMcpToolContext_forTests(fakeSpawn, undefined, undefined);
      expect(typeof ctx.dispatchTool).toBe('function');
      const r = await ctx.dispatchTool!('no:such_tool_xyz', {});
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).toContain('unknown_tool');
    });
  });

  it('ctx.progress(pct, msg) routes through emit("progress", …) — alias parity', async () => {
    const { sent, sendNotification } = recordingSendNotification();
    const ctx = await __buildMcpToolContext_forTests(fakeSpawn, 'tok-progress-alias', sendNotification);
    ctx.progress(75, 'three-quarters');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    const papercusp = sent.find((n) => n.method === 'notifications/papercusp/event')!;
    expect(papercusp.params).toEqual({
      progressToken: 'tok-progress-alias',
      event: 'progress',
      data: { progress: 75, total: 100, message: 'three-quarters' },
    });
  });
});

describe('MCP session tool-contract revision notifications', () => {
  const knownGeneration = (revision: string) => ({
    state: 'known' as const,
    revision,
    buildSha: 'build-sha',
    appliedMigrationDigest: 'migration-sha',
    toolRegistryRevision: 'tool-sha',
  });

  it('blocks missing and stale baselines before dispatch and waits for tools/list to advance them', async () => {
    __resetSessionSurfaces();
    const sessionId = 'mcp-contract-revision-session';
    const { sent, sendNotification } = recordingSendNotification();
    let generation = knownGeneration('generation-1');
    let dispatchCount = 0;
    const call = __withMcpSessionSurfaceRecheckForTests(
      async () => { dispatchCount += 1; return { isError: false }; },
      async () => generation,
    );
    const extra = { sessionId, sendNotification };

    await expect(call({}, extra)).rejects.toThrow(/stale_tool_contract.*tools\/list/);
    expect(dispatchCount).toBe(0);
    expect(sent).toEqual([{ method: 'notifications/tools/list_changed', params: {} }]);

    // This is the action the notified client performs: a real tools/list handler
    // records the revision only after producing its response.
    rememberSessionToolRegistryRevision(sessionId, 'generation-1');
    expect(await call({}, extra)).toEqual({ isError: false });
    expect(dispatchCount).toBe(1);
    expect(sent).toHaveLength(1);

    generation = knownGeneration('generation-2');
    await expect(call({}, extra)).rejects.toThrow(/stale_tool_contract.*tools\/list/);
    expect(dispatchCount).toBe(1);
    expect(sent).toHaveLength(2);

    // list_changed is not a baseline update. Only the subsequent real list can
    // unblock calls for generation 2.
    await expect(call({}, extra)).rejects.toThrow(/stale_tool_contract.*tools\/list/);
    expect(dispatchCount).toBe(1);
    expect(sent).toHaveLength(3);
    rememberSessionToolRegistryRevision(sessionId, 'generation-2');
    expect(await call({}, extra)).toEqual({ isError: false });
    expect(dispatchCount).toBe(2);
  });

  it('traces the transport/native session split when a reconnect has no tools/list baseline', async () => {
    __resetSessionSurfaces();
    const nativeSessionId = 'native-codex-session-123';
    const headers = (sessionId: string) => ({
      'mcp-session-id': sessionId,
      'x-papercusp-native-session': nativeSessionId,
    });
    const listedExtra = {
      sessionId: 'mcp-transport-a',
      requestInfo: { headers: headers('mcp-transport-a') },
    };
    rememberSessionToolRegistryRevision('mcp-transport-a', 'generation-1');
    const listedEvent = buildMcpSessionSurfaceTraceEvent({
      traceId: '1cb45906-a016-4b0d-8ae8-7f0dfcbe8eb4',
      toolName: 'tools/list',
      stage: 'tools_list_completed',
      elapsedMs: 1,
      extra: listedExtra,
      sessionKey: 'mcp-transport-a',
      sessionBaseline: 'recorded',
      servingGeneration: 'generation-1',
      outcome: 'success',
    });
    const { sendNotification } = recordingSendNotification();
    const rejectedExtra = {
      sessionId: 'mcp-transport-b',
      requestInfo: { headers: headers('mcp-transport-b') },
      sendNotification,
    };
    let dispatchCount = 0;
    const call = __withMcpSessionSurfaceRecheckForTests(
      async () => { dispatchCount += 1; return { isError: false }; },
      async () => knownGeneration('generation-1'),
    );
    const trace = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      await expect(call({ params: { name: 'coord:orient' } }, rejectedExtra))
        .rejects.toThrow(/stale_tool_contract.*tools\/list/);
      expect(dispatchCount).toBe(0);

      const line = trace.mock.calls
        .map(([value]) => String(value))
        .find((value) => value.startsWith('[mcp-request-trace] ') && value.includes('stale_contract_rejected'));
      expect(line).toBeDefined();
      const event = JSON.parse(line!.slice('[mcp-request-trace] '.length));
      expect(event).toMatchObject({
        toolName: 'coord:orient',
        stage: 'stale_contract_rejected',
        phase: 'pre_dispatch',
        outcome: 'rejected',
        sessionBaseline: 'missing',
        servingGeneration: 'generation-1',
        nativeSessionCarrier: 'header',
      });
      expect(event.mcpSessionKeyFingerprint).not.toBe(listedEvent.mcpSessionKeyFingerprint);
      expect(event.wireMcpSessionIdFingerprint).not.toBe(listedEvent.wireMcpSessionIdFingerprint);
      expect(event.nativeSessionClaimFingerprint).toBe(listedEvent.nativeSessionClaimFingerprint);
      expect(line).not.toContain(nativeSessionId);
    } finally {
      trace.mockRestore();
    }
  });

  it('blocks unknown generations before dispatch', async () => {
    __resetSessionSurfaces();
    const { sent, sendNotification } = recordingSendNotification();
    const sessionId = 'mcp-unknown-generation-session';
    rememberSessionToolRegistryRevision(sessionId, 'generation-1');
    let dispatchCount = 0;
    const call = __withMcpSessionSurfaceRecheckForTests(
      async () => { dispatchCount += 1; return { isError: false }; },
      async () => ({ state: 'unknown', reason: 'applied-migrations-unknown' }),
    );

    await expect(call({}, { sessionId, sendNotification })).rejects.toThrow(/serving_generation_unknown/);
    expect(dispatchCount).toBe(0);
    expect(sent).toEqual([]);
  });

  // WI-10006051: the production HTTP transport (mcp-handler) is STATELESS — a
  // fresh server per POST with no sessionIdGenerator — so `extra.sessionId` is
  // always absent there. Refusing a keyless call took down every HTTP tools/call
  // on :3170 and :3271, even straight after a successful tools/list.
  describe('stateless transport (no session key)', () => {
    it('dispatches an undeclared call without reading the generation or notifying', async () => {
      __resetSessionSurfaces();
      const { sent, sendNotification } = recordingSendNotification();
      let dispatchCount = 0;
      let generationReads = 0;
      const call = __withMcpSessionSurfaceRecheckForTests(
        async () => { dispatchCount += 1; return { isError: false }; },
        async () => { generationReads += 1; return knownGeneration('generation-1'); },
      );

      // Exactly what mcp-handler hands the handler: no sessionId at all.
      expect(await call({ params: { name: 'coord:whoami' } }, { sendNotification })).toEqual({ isError: false });
      expect(await call({ params: { name: 'coord:whoami' } }, undefined)).toEqual({ isError: false });
      expect(dispatchCount).toBe(2);
      expect(generationReads).toBe(0);
      expect(sent).toEqual([]);
    });

    it('returns the settled handler result while the seeded-surface refresh is still pending', async () => {
      __resetSessionSurfaces();
      const { sendNotification } = recordingSendNotification();
      let releaseRefresh!: () => void;
      let startRefresh!: () => void;
      const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
      const refreshStarted = new Promise<void>((resolve) => { startRefresh = resolve; });
      const refresh = vi.fn(async () => {
        startRefresh();
        await refreshGate;
      });
      const call = __withMcpSessionSurfaceRecheckForTests(
        async () => ({ isError: false }),
        async () => knownGeneration('generation-1'),
        refresh,
      );
      const extra = {
        requestInfo: { url: 'http://127.0.0.1:3070/api/mcp?tools=coord%3Awhoami' },
        sendNotification,
      };

      try {
        const result = await call({ params: { name: 'coord:whoami' } }, extra);
        expect(result).toEqual({ isError: false });
        await refreshStarted;
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        releaseRefresh();
        __resetSessionSurfaces();
      }
    });

    it('admits a call whose declared generation matches the live one', async () => {
      __resetSessionSurfaces();
      let dispatchCount = 0;
      const call = __withMcpSessionSurfaceRecheckForTests(
        async () => { dispatchCount += 1; return { isError: false }; },
        async () => knownGeneration('generation-1'),
      );

      const req = { params: { name: 'coord:whoami', _meta: { 'papercusp/servingGeneration': 'generation-1' } } };
      expect(await call(req, {})).toEqual({ isError: false });
      expect(dispatchCount).toBe(1);
    });

    it('refuses a call whose declared generation is stale, before dispatch', async () => {
      __resetSessionSurfaces();
      let dispatchCount = 0;
      const call = __withMcpSessionSurfaceRecheckForTests(
        async () => { dispatchCount += 1; return { isError: false }; },
        async () => knownGeneration('generation-2'),
      );

      const req = { params: { name: 'coord:whoami', _meta: { 'papercusp/servingGeneration': 'generation-1' } } };
      await expect(call(req, {})).rejects.toThrow(/stale_tool_contract.*declares serving generation generation-1.*generation-2/);
      expect(dispatchCount).toBe(0);
    });

    it('refuses a declared call when the generation is unknown', async () => {
      __resetSessionSurfaces();
      let dispatchCount = 0;
      const call = __withMcpSessionSurfaceRecheckForTests(
        async () => { dispatchCount += 1; return { isError: false }; },
        async () => ({ state: 'unknown', reason: 'applied-migrations-unknown' }),
      );

      const req = { params: { name: 'coord:whoami', _meta: { 'papercusp/servingGeneration': 'generation-1' } } };
      await expect(call(req, {})).rejects.toThrow(/serving_generation_unknown/);
      expect(dispatchCount).toBe(0);
    });
  });
});
