/**
 * plans:attention cache integration (cache-expensive-tool-reads-2026-06-22 P-003).
 *
 * Drives the REAL handler against a mocked source layer + the REAL operator cache.
 * Pins the caching CONTRACT specific to plans:attention:
 *   - a repeat call HITS (the ~10-source aggregation runs once)
 *   - a plan-table write BUSTS it (tags = plan tables → ECA bump rebuilds)
 *   - harnessFilter / includeArchived are in the key (no cross-arg leak)
 *   - NO cross-PRINCIPAL leak: the feed is principal-agnostic, so two callers with
 *     DIFFERENT role/principal but the same ws+args SHARE one entry AND get byte-
 *     identical data (there is no per-caller view to leak — D-001)
 *   - CACHE_LAYER OFF ⇒ bypass (the aggregation runs every call)
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  readAllPlans: vi.fn(async () => [] as unknown[]),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
  // WI-3348: the request-ALS workspace observed INSIDE each open-questions read.
  seenConversationsWs: [] as Array<string | undefined>,
  groupsOverride: null as unknown[] | null,
  inboxByWorkspace: new Map<string, unknown[]>(),
  ackedByWorkspace: new Map<string, Set<string>>(),
  seenInboxWs: [] as Array<string | undefined>,
}));

vi.mock("../../attention/group", async (orig) => {
  const actual = await orig<typeof import("../../attention/group")>();
  return {
    ...actual,
    buildAttentionGroups: (...args: Parameters<typeof actual.buildAttentionGroups>) =>
      M.groupsOverride === null ? actual.buildAttentionGroups(...args) : M.groupsOverride,
  };
});

vi.mock("./source", () => ({ readAllPlans: M.readAllPlans }));
vi.mock("./_ctx-opts", () => ({ ctxToPlanSourceOpts: M.ctxToPlanSourceOpts }));
vi.mock("../_harness-scope", async (orig) => {
  const actual = await orig<typeof import("../_harness-scope")>();
  return { ...actual, harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx };
});
vi.mock("../../attention/sources", async (orig) => {
  const actual = await orig<typeof import("../../attention/sources")>();
  return { ...actual, planItemsToAttention: vi.fn(() => [] as unknown[]) };
});
// Every other source → empty (no PG in the unit env).
vi.mock("../coordination/escalations", () => ({
  listEscalations: vi.fn(async () => []),
}));
vi.mock("../coordination/conversations", async () => {
  const { currentRequestWorkspaceId } = await import("../../workspace-als");
  return {
    // Records the ALS workspace in effect at CALL time (WI-3348: the handler must
    // pin the read to the resolved workspace, not the caller's ambient ALS).
    listConversationsWithTopics: vi.fn(async () => {
      M.seenConversationsWs.push(currentRequestWorkspaceId());
      return [];
    }),
    conversationsScopeWorkspace: vi.fn(() => currentRequestWorkspaceId() ?? "default"),
  };
});
vi.mock("../coordination/messages", async () => {
  const { currentRequestWorkspaceId } = await import("../../workspace-als");
  return {
    readInbox: vi.fn(async () => {
      const workspace = currentRequestWorkspaceId();
      M.seenInboxWs.push(workspace);
      return M.inboxByWorkspace.get(workspace ?? '') ?? [];
    }),
    readAckedMsgIds: vi.fn(async () => M.ackedByWorkspace.get(currentRequestWorkspaceId() ?? '') ?? new Set()),
  };
});
// Exercise the real HTTP dispatcher without importing the unrelated catalog or
// production telemetry hooks. attention above registers the actual reader.
vi.mock('../index', () => ({}));
vi.mock('../../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));
vi.mock("../coordination/identity", () => ({ ADMIN_COORD_UI_OWNER: "admin" }));
vi.mock("@papercusp/db-org", async (orig) => {
  const actual = await orig<typeof import("@papercusp/db-org")>();
  return { ...actual, getOrgPg: () => ({ sql: async () => [] }) };
});
vi.mock("../../attention/operator-report-source", () => ({
  readRecentOperatorReports: vi.fn(async () => []),
}));
vi.mock("../../harness/improvements/read-items", () => ({
  readImprovementItems: vi.fn(async () => []),
}));
vi.mock("../../operator-standing-candidates", () => ({
  readCandidates: vi.fn(async () => []),
}));
vi.mock("../../scout/routed-ledger", () => ({
  readRoutedIdeas: vi.fn(async () => []),
  readScoutPlanRefs: vi.fn(async () => new Set()),
}));
vi.mock("../../plan-items/convert", () => ({
  listConvertedPlanItemRefs: vi.fn(async () => new Set()),
}));
vi.mock("../../attention/triage-store", () => ({
  readTriageByWorkspace: vi.fn(async () => new Map()),
}));

import tool from "./attention";
import { callPlansReadRaw } from './read-dispatch';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { runWithWorkspace } from '../../workspace-als';
import { deriveAttentionRefs } from '../../sync-resolver/attention-counts';
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";

const ctx = (
  workspaceId: string,
  role = "operator",
  principalSlug = "agent-a",
): never =>
  ({
    workspaceId,
    harnessSlug: "papercup",
    role,
    principal: { slug: principalSlug },
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const run = async (
  args: Record<string, unknown>,
  c = ctx("ws-attn"),
): Promise<{ groups: unknown[]; tierCounts: Record<string, number> }> => {
  // The handler returns a {data} envelope (context-trimming-tiers P-021) —
  // serialization to content[] happens in defineTool dispatch, not here.
  const res = (await tool.handler(args as never, c)) as {
    data: { groups: unknown[]; tierCounts: Record<string, number> };
  };
  return res.data;
};

function assertWarmCountBudget(samples: readonly number[]): void {
  expect(samples).toHaveLength(100);
  expect([...samples].sort((a, b) => a - b)[94]).toBeLessThanOrEqual(250);
}

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readAllPlans.mockClear();
  M.groupsOverride = null;
  M.inboxByWorkspace.clear();
  M.ackedByWorkspace.clear();
  M.seenInboxWs.length = 0;
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("plans:attention — cache wiring", () => {
  it('refreshes the real attention handler through the production PG bridge and reaction action', async () => {
    const workspace = 'ws-inbox-production-bridge';
    M.inboxByWorkspace.set(workspace, ['selected', 'neighbor'].map(msg_id => ({
      msg_id, from: 'peer-' + msg_id, to: ['human'], kind: 'message', summary: msg_id,
      body: msg_id + ' body', ts: new Date().toISOString(),
    })));
    const { bridgeTriggerEvent } = await import('../../sync-sse');
    const { registerCacheTagEcaRule, _refreshCacheEcaForTests } = await import('../../events/cache-eca-rule');
    setFlagOverridesForTest({ [CACHE_LAYER]: true, 'papercusp-cache-tag-eca': true });
    await _refreshCacheEcaForTests();
    registerCacheTagEcaRule();
    const refs = async () => deriveAttentionRefs((await run({}, ctx(workspace))).groups).map(row => row.id);
    expect(await refs()).toContain('coord-message:selected');
    M.ackedByWorkspace.set(workspace, new Set(['selected']));
    bridgeTriggerEvent('harness_shared.coord_event_log.changed', { workspace_id: workspace, op: 'INSERT', id: 3 });
    await expect.poll(refs).not.toContain('coord-message:selected');
    expect(await refs()).toContain('coord-message:neighbor');
  });

  it('refreshes a warm human inbox after coord-log acknowledgment and reversal invalidation', async () => {
    const workspace = 'ws-inbox-ack-refresh';
    const messages = ['selected', 'neighbor'].map(msg_id => ({ msg_id, from: 'peer-' + msg_id,
      to: ['human'], kind: 'message', summary: msg_id, body: msg_id + ' body', ts: new Date().toISOString() }));
    M.inboxByWorkspace.set(workspace, messages);
    const refs = async () => deriveAttentionRefs((await run({}, ctx(workspace))).groups).map(row => row.id);
    expect(await refs()).toEqual(expect.arrayContaining(['coord-message:selected', 'coord-message:neighbor']));
    M.ackedByWorkspace.set(workspace, new Set(['selected']));
    getOperatorCache().invalidateByTags(workspace, ['coord_event_log']);
    const acknowledged = await refs();
    expect(acknowledged).not.toContain('coord-message:selected');
    expect(acknowledged).toContain('coord-message:neighbor');
    M.ackedByWorkspace.set(workspace, new Set());
    getOperatorCache().invalidateByTags(workspace, ['coord_event_log']);
    expect(await refs()).toEqual(expect.arrayContaining(['coord-message:selected', 'coord-message:neighbor']));
  });

  it('invalidates wildcard HTTP attention reads in the concrete viewed workspace', async () => {
    const workspace = 'ws-inbox-wildcard-http';
    const foreign = 'ws-inbox-wildcard-neighbor';
    for (const ws of [workspace, foreign]) {
      M.inboxByWorkspace.set(ws, ['selected', 'neighbor'].map(msg_id => ({
        msg_id, from: 'peer-' + msg_id, to: ['human'], kind: 'message', summary: msg_id,
        body: msg_id + ' body', ts: new Date().toISOString(),
      })));
    }
    const refs = (ws: string) => runWithWorkspace(ws, async () =>
      deriveAttentionRefs((await run({}, ctx('*'))).groups).map(row => row.id));
    expect(await refs(workspace)).toContain('coord-message:selected');
    expect(await refs(foreign)).toContain('coord-message:selected');
    const foreignBuilds = M.seenInboxWs.filter(ws => ws === foreign).length;
    M.ackedByWorkspace.set(workspace, new Set(['selected']));
    getOperatorCache().invalidateByTags(workspace, ['coord_event_log']);
    expect(await refs(workspace)).not.toContain('coord-message:selected');
    expect(await refs(workspace)).toContain('coord-message:neighbor');
    expect(await refs(foreign)).toContain('coord-message:selected');
    expect(M.seenInboxWs.filter(ws => ws === foreign)).toHaveLength(foreignBuilds);
  });

  it('supports the device attention route through the real in-process dispatcher', async () => {
    const projected = lookupByMcpName('plans:attention');
    expect(projected).toBeDefined();
    const deviceContext: UnifiedToolContext = {
      workspaceId: 'ws-device-attention', harnessSlug: 'operator-home', role: 'operator',
      runId: 'device-attention-run', spawnId: 'device-attention-spawn',
      transport: 'in_process', uiClientId: null,
      signal: new AbortController().signal, log: () => {}, progress: () => {}, emit: () => {},
    };
    const result = await dispatchProjectedTool(projected!, 'plans:attention', {
      limit: 100, offset: 0, payloadTier: 'full',
    }, deviceContext, {});
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(result.result?.isError).not.toBe(true);
    const text = result.result?.content.find((entry) => entry.type === 'text');
    expect(text?.type).toBe('text');
    const data = JSON.parse((text as { text: string }).text);
    expect(Array.isArray(data.groups)).toBe(true);
    expect(data.groups.every((group: { items?: unknown }) => Array.isArray(group.items))).toBe(true);
    expect(M.seenInboxWs).toContain('ws-device-attention');
    expect(data._projection?.truncated).not.toBe(true);
  });

  const reportMessage = {
    msg_id: 'goal-report-exact-pin', from: 'goal-report-fixture', to: ['human'],
    kind: 'message', ts: '2026-10-05T18:00:00Z', summary: 'Canonical GOAL fixture',
    body: 'MOVED: verified fixture', expects: 'none',
    report: { plans: [], goalReport: { schemaVersion: 1, goalId: 'goal-fixture',
      reportId: 'rpt_fixture', bodySha256: 'a'.repeat(64) } },
  };
  const wrapperRead = (workspace: string) => runWithWorkspace(workspace,
    () => callPlansReadRaw('attention', {}, { uiProjection: false }));
  const wrapperItems = (result: Awaited<ReturnType<typeof wrapperRead>>) => {
    expect(result.status).toBe(200);
    return (result.data as { groups: Array<{ items: Array<{ id: string; report?: unknown }> }> })
      .groups.flatMap(group => group.items);
  };

  it('the exact nested HTTP wrapper preserves the viewed workspace for report messages', async () => {
    M.inboxByWorkspace.set('ws-native-fixture', [reportMessage]);
    const own = wrapperItems(await wrapperRead('ws-native-fixture'));
    expect(own.find(item => item.id === 'coord-message:goal-report-exact-pin')?.report).toEqual(reportMessage.report);
    expect(M.seenInboxWs).toEqual(['ws-native-fixture']);
    expect(wrapperItems(await wrapperRead('ws-other'))).not.toContainEqual(expect.objectContaining({
      id: 'coord-message:goal-report-exact-pin',
    }));
    expect(M.seenInboxWs).toEqual(['ws-native-fixture', 'ws-other']);
  });

  it('the sync reader shares the admin workspace cache after a post-boot report write', async () => {
    const workspace = 'ws-native-fixture';
    // The desktop warms the sync feed before this separately persisted report.
    expect(wrapperItems(await wrapperRead(workspace))).not.toContainEqual(
      expect.objectContaining({ id: 'coord-message:goal-report-exact-pin' }),
    );
    M.inboxByWorkspace.set(workspace, [reportMessage]);
    // Advance past the real SWR window and let the concrete admin read converge.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 20_001);
    await runWithWorkspace(workspace, () => run({}, ctx(workspace)));
    await vi.waitFor(async () => {
      const admin = await runWithWorkspace(workspace, () => run({}, ctx(workspace)));
      expect(admin.groups.flatMap((group: any) => group.items)).toContainEqual(
        expect.objectContaining({ id: 'coord-message:goal-report-exact-pin', report: reportMessage.report }),
      );
    });
    // A nested HTTP context must not serve its independent stale '*' cache.
    expect(wrapperItems(await wrapperRead(workspace))).toContainEqual(
      expect.objectContaining({ id: 'coord-message:goal-report-exact-pin', report: reportMessage.report }),
    );
  });

  it('a post-boot direct persistence needs feed convergence: fresh cache omits it, SWR then exposes the same pin', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const pinned = expect.objectContaining({ id: 'coord-message:goal-report-exact-pin', report: reportMessage.report });
    expect(wrapperItems(await wrapperRead('ws-native-fixture'))).not.toContainEqual(pinned);
    M.inboxByWorkspace.set('ws-native-fixture', [reportMessage]);
    expect(wrapperItems(await wrapperRead('ws-native-fixture'))).not.toContainEqual(pinned);
    expect(M.seenInboxWs).toEqual(['ws-native-fixture']);
    now += 20_001;
    // The first expired read serves stale data and starts the actual rebuild.
    expect(wrapperItems(await wrapperRead('ws-native-fixture'))).not.toContainEqual(pinned);
    await vi.waitFor(async () => {
      expect(wrapperItems(await wrapperRead('ws-native-fixture'))).toContainEqual(pinned);
    });
    expect(M.seenInboxWs).toEqual(['ws-native-fixture', 'ws-native-fixture']);
  });

  it('the desktop list projection and exact first-page args retain the report pin', async () => {
    M.inboxByWorkspace.set('ws-native-fixture', [reportMessage]);
    const read = (workspace: string) => runWithWorkspace(workspace,
      () => callPlansReadRaw('attention', { limit: 100, offset: 0 }));
    expect(wrapperItems(await read('ws-native-fixture'))).toContainEqual(expect.objectContaining({
      id: 'coord-message:goal-report-exact-pin', report: reportMessage.report,
    }));
    expect(wrapperItems(await read('ws-other'))).not.toContainEqual(expect.objectContaining({
      id: 'coord-message:goal-report-exact-pin',
    }));
    expect(M.seenInboxWs).toEqual(['ws-native-fixture', 'ws-other']);
  });

  it("accepts the popup's exact owner-scoped query without stripping its owner (WI-2147274)", () => {
    const args = { ownerAgentId: "su-mine", limit: 100, offset: 0 };
    expect(tool.args.parse(args)).toEqual(args);
    expect(tool.args.safeParse({ ...args, ownerAgentId: "" }).success).toBe(false);
  });

  it("rejects stale plan filters and accepts the bounded window contract", () => {
    // The caller-facing contract is intentionally narrow: `plans:attention`
    // filters by harness scope and an explicit presentation window. Keep this
    // tool-specific guard next to the cache tests so a future schema edit
    // cannot silently reintroduce stale plan filtering.
    expect(tool.args.safeParse({ plan: "plan-1" }).success).toBe(false);
    expect(tool.args.safeParse({ limit: 50, offset: 50 }).success).toBe(true);
    expect(
      tool.args.safeParse({
        harness: "papercusp",
        harnessSlug: "papercusp",
        includeArchived: true,
      }).success,
    ).toBe(true);
  });

  it("a repeat call HITS (the aggregation runs once)", async () => {
    await run({});
    await run({});
    expect(M.readAllPlans).toHaveBeenCalledTimes(1);
  });

  it("concurrent feed/count/ref reads share a build and project the complete deduped set before pagination", async () => {
    const items = Array.from({ length: 150 }, (_, i) => ({
      id: `item-${i}`, kind: 'plan-item', tier: i < 120 ? 'decision' : 'alert',
      planSlug: 'alpha', ownerAgentId: i < 100 ? 'su-a' : 'su-b',
      importance: 'normal', title: `Item ${i}`, body: 'large detail body '.repeat(100),
      itemRef: `alpha#P-${String(i + 1).padStart(3, '0')}`,
    }));
    M.groupsOverride = [
      { key: 'alpha', kind: 'plan', planSlug: 'alpha', title: 'Alpha', maxImportance: 'normal', items },
      { key: 'duplicate', kind: 'alerts', title: 'Duplicates', maxImportance: 'normal', items: [items[0]] },
    ];
    const [feed, counts, refs] = await Promise.all([
      run({ limit: 1 }), run({ output: 'counts', limit: 1, offset: 1 }), run({ output: 'refs', limit: 1 }),
      ...Array.from({ length: 5 }, (_, i) => run({ output: i % 2 ? 'counts' : 'refs' })),
    ]);
    expect(M.readAllPlans).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ counts: { decisionItems: 120, decisionPlans: 1, alerts: 30, total: 150 }, degraded: false });
    const complete = await run({ limit: null });
    expect(refs).toEqual({
      refs: deriveAttentionRefs(complete.groups),
      degraded: false,
    });
    expect(feed.groups.flatMap((g) => (g as { items: unknown[] }).items)).toHaveLength(1);
    expect(JSON.stringify(refs)).not.toContain('large detail body');
    expect(JSON.stringify(counts).length).toBeLessThan(150);

    // Presentation scope stays outside the cache, while projections honor it.
    expect(await run({ output: 'counts', ownerAgentId: 'su-b' })).toEqual({
      counts: { decisionItems: 20, decisionPlans: 1, alerts: 30, total: 50 }, degraded: false,
    });
    expect(M.readAllPlans).toHaveBeenCalledTimes(1);

    // A write invalidates derived views together with their source groups.
    M.groupsOverride = [];
    expect(await run({ output: 'counts' })).toEqual(counts);
    getOperatorCache().invalidateByTags('ws-attn', ['harness_plans']);
    expect(await run({ output: 'refs' })).toEqual({ refs: [], degraded: false });
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });

  it('compact views retain the same priority winner for conflicting duplicate ids as the full feed', async () => {
    const base = { id: 'duplicate', kind: 'plan-item', importance: 'normal', title: 'Item', ownerAgentId: 'su-a' };
    M.groupsOverride = [
      { key: 'old', kind: 'plan', planSlug: 'old', title: 'Old', maxImportance: 'normal',
        items: [{ ...base, tier: 'activity', planSlug: 'old', itemRef: 'old#P-001' }] },
      { key: 'new', kind: 'plan', planSlug: 'new', title: 'New', maxImportance: 'normal',
        items: [{ ...base, tier: 'decision', planSlug: 'new', itemRef: 'new#P-001' }] },
    ];
    expect(await run({ output: 'counts' })).toEqual({
      counts: { decisionItems: 1, decisionPlans: 1, alerts: 0, total: 1 }, degraded: false,
    });
    expect(await run({ output: 'refs' })).toEqual({
      refs: [{ id: 'duplicate', itemRef: 'new#P-001', planSlug: 'new', ownerAgentId: 'su-a' }], degraded: false,
    });
  });

  it('measures cold and warm transport construction without serializing detail bodies for compact views', async () => {
    const items = Array.from({ length: 1_000 }, (_, i) => ({
      id: `row-${i}`, kind: 'plan-item', tier: 'decision', planSlug: 'alpha',
      importance: 'normal', title: `Item ${i}`, body: 'x'.repeat(2_000), itemRef: `alpha#${i}`,
    }));
    M.groupsOverride = [{ key: 'alpha', kind: 'plan', planSlug: 'alpha', title: 'Alpha', maxImportance: 'normal', items }];
    const coldStart = performance.now();
    await run({ output: 'counts' });
    const coldMs = performance.now() - coldStart;
    const timings = { feed: [] as number[], counts: [] as number[], refs: [] as number[] };
    const bytes = { feed: 0, counts: 0, refs: 0 };
    const outputs = ['feed', 'counts', 'refs'] as const;
    for (let round = 0; round < 100; round++) {
      // Rotate order so one mode does not always pay first-call/JIT effects.
      for (let n = 0; n < outputs.length; n++) {
        const output = outputs[(round + n) % outputs.length]!;
        const start = performance.now();
        const serialized = JSON.stringify(await run({ output, limit: null }));
        JSON.parse(serialized); // same JSON round trip as the in-process tool read
        timings[output].push(performance.now() - start);
        bytes[output] = Buffer.byteLength(serialized);
      }
    }
    expect(M.readAllPlans).toHaveBeenCalledTimes(1);
    expect(bytes.feed).toBeGreaterThan(2_000_000);
    expect(bytes.counts).toBeLessThan(150);
    expect(bytes.refs).toBeLessThan(bytes.feed / 20);
    const p50Ms = Object.fromEntries(outputs.map((output) => [
      output, timings[output].sort((a, b) => a - b)[50],
    ]));
    const p95Ms = Object.fromEntries(outputs.map((output) => [output, timings[output][94]]));
    // PERF-P-005: 100 completed warm count reads must meet the 250ms p95 ceiling.
    assertWarmCountBudget(timings.counts);
    console.info('ATTENTION_PROJECTION_BENCHMARK', JSON.stringify({
      profile: 'attention-1000-items-2000-ascii-body-v1', workspace: 'ws-attn', concurrency: 1,
      items: items.length, callsPerMode: 100, coldMs, p50Ms, p95Ms, bytes,
    }));
  });

  it('PERF-P-005 counterexample: six slow observer calls breach p95 even when the median is fast', async () => {
    await run({ output: 'counts' }); // warm the real source cache first
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const slowContext = ctx('ws-attn') as unknown as { metadata: () => void };
    // Inject latency at the handler's real metadata callback seam. The wait
    // runs only in this test process and uses no CPU-spinning or source mutation.
    slowContext.metadata = () => { Atomics.wait(waitCell, 0, 0, 275); };
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await run({ output: 'counts' }, i < 6 ? slowContext as never : ctx('ws-attn'));
      samples.push(performance.now() - start);
    }
    expect(samples.filter((ms) => ms > 250)).toHaveLength(6);
    expect(() => assertWarmCountBudget(samples)).toThrow();
    expect(M.readAllPlans).toHaveBeenCalledTimes(1);
    console.info('ATTENTION_P95_COUNTEREXAMPLE', JSON.stringify({
      completed: samples.length, injectedSlowReads: 6, ceilingMs: 250,
      rejected: true, p95Ms: [...samples].sort((a, b) => a - b)[94],
    }));
  }, 10_000);

  it('marks compact output degraded when the shared source build exceeds its own deadline', async () => {
    vi.useFakeTimers();
    let finishRead!: (plans: unknown[]) => void;
    M.readAllPlans.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    try {
      const result = run({ output: 'counts' });
      await vi.waitFor(() => expect(M.readAllPlans).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(45_001);
      expect(await result).toEqual({
        counts: { decisionItems: 0, decisionPlans: 0, alerts: 0, total: 0 }, degraded: true,
      });
    } finally {
      finishRead?.([]);
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("a plan-table write BUSTS the entry", async () => {
    await run({});
    getOperatorCache().invalidateByTags("ws-attn", ["harness_plans"]);
    await run({});
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });

  it("harnessFilter is in the key (no cross-arg leak)", async () => {
    await run({ harnessSlug: "h1" });
    await run({ harnessSlug: "h2" });
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
    await run({ harnessSlug: "h1" }); // cached
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });

  it("includeArchived is in the key", async () => {
    await run({});
    await run({ includeArchived: true });
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });

  it("NO cross-principal leak: differing role/principal SHARE one entry + identical data", async () => {
    const a = await run({}, ctx("ws-attn", "operator", "agent-a"));
    const b = await run({}, ctx("ws-attn", "papercup", "agent-b"));
    // The feed is principal-agnostic → the second caller HITS the same entry…
    expect(M.readAllPlans).toHaveBeenCalledTimes(1);
    // …and gets byte-identical data (nothing caller-specific was cached / leaked).
    expect(b).toEqual(a);
  });

  it("CACHE_LAYER OFF ⇒ bypass: the aggregation runs on every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await run({});
    await run({});
    expect(M.readAllPlans).toHaveBeenCalledTimes(2);
  });

  // WI-3348: coord:ask rows land under the asker's identity workspace (WI-1571),
  // so the open-questions source must read the VIEWED workspace's partition. An
  // agent MCP call carries NO request ALS — before the fix the read fell to
  // 'default' and the feed missed every current ask.
  it("open-questions source is PINNED to ctx.workspaceId, not the ambient ALS (WI-3348)", async () => {
    M.seenConversationsWs.length = 0;
    await run({}, ctx("ws-attn")); // no surrounding runWithWorkspace = agent context
    expect(M.seenConversationsWs).toEqual(["ws-attn"]);
  });
});
