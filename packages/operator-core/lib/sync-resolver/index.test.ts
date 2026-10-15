import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { knownQueryNamesV2, isRegisteredV2, resolveNamedQueryV2, NAME_NOT_FOUND, jsonSafeRows } from './index';
import { readWorkItemAdmissionSnapshot } from '../work-items-admission-promoter';

describe('Learning canonical detail provider-free prerequisite', () => {
  it.each(['mem0', 'hybrid-pg', 'custom'])('reads %s through its own corpus and preserves owner unsealing', async choice => {
    const entry = { id: 'selected-memory', text: 'sealed-source', scope: 'hive:selected' };
    const canonicalRead = vi.fn(async () => [entry]);
    const available = vi.fn(async () => ({ ok: choice === 'custom', reason: 'provider-unavailable' }));
    const get = vi.fn(async () => entry);
    const unseal = vi.fn(async (rows: Array<typeof entry>) => rows.map(row => ({ ...row, text: 'owner-readable' })));
    const sql = {};
    vi.doMock('../memory/backend-selection', () => ({ currentMemoryBackendChoice: () => choice }));
    vi.doMock('../memory/backend', () => ({ getMemoryBackend: () => ({ available, get }) }));
    vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'private-workspace' }));
    vi.doMock('../personal-vault/shared-store-seal', () => ({ unsealRowsForOwner: unseal }));
    vi.doMock('./learning-retain-read', async importOriginal => ({
      ...await importOriginal<typeof import('./learning-retain-read')>(),
      listCanonicalRetainMemoriesPage: canonicalRead,
    }));
    try {
      const rows = await resolveNamedQueryV2('learning.retainDetail', { kind: 'memory', id: entry.id, hive: 'selected' });
      expect(rows).toEqual([expect.objectContaining({ id: entry.id, body: 'owner-readable' })]);
      expect(unseal).toHaveBeenCalledWith([entry], expect.objectContaining({ workspaceId: 'private-workspace' }));
      if (choice === 'custom') {
        expect(canonicalRead).not.toHaveBeenCalled();
        expect(available).toHaveBeenCalledOnce(); expect(get).toHaveBeenCalledWith(entry.id);
      } else {
        expect(canonicalRead).toHaveBeenCalledWith(sql, ['hive:selected'], { window: null, limit: 1, id: entry.id });
        expect(available).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
      }
    } finally {
      for (const module of ['../memory/backend-selection', '../memory/backend', '@papercusp/db-org',
        '../workspace-registry', '../personal-vault/shared-store-seal', './learning-retain-read']) vi.doUnmock(module);
    }
  });
});

describe('jsonSafeRows (BigInt → Number for the JSON.stringify rest-query serializer)', () => {
  it('coerces a BigInt id so the row is JSON-serializable (the user_actions 500 class)', () => {
    const out = jsonSafeRows([{ id: 42n, kind: 'tool', startedAt: 1700000000000 }]);
    expect(out[0]).toEqual({ id: 42, kind: 'tool', startedAt: 1700000000000 });
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(typeof (out[0] as { id: unknown }).id).toBe('number');
  });

  it('coerces every BigInt field, not just id', () => {
    const out = jsonSafeRows([{ id: 1n, count: 9n, name: 'x' }]) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ id: 1, count: 9, name: 'x' });
  });

  it('returns the same row object untouched when there is no BigInt (no hot-path alloc)', () => {
    const row = { id: 7, kind: 'view' };
    const out = jsonSafeRows([row]);
    expect(out[0]).toBe(row);
  });

  it('passes through non-object rows', () => {
    expect(jsonSafeRows(['a', 3, null])).toEqual(['a', 3, null]);
  });
});

describe('workItemAdmission.runs (work-queue-admission-and-bulk-dedup P-005)', () => {
  it('is registered and accepts the canonical no-argument request', async () => {
    expect(knownQueryNamesV2()).toContain('workItemAdmission.runs');
    const entry = (await import('./index')).getRegistryEntryV2('workItemAdmission.runs');
    expect(entry?.argsSchema?.parse(undefined)).toBeUndefined();
    expect(entry?.argsSchema?.parse({ kind: 'durable-park-audit', state: 'blocked' })).toEqual({
      kind: 'durable-park-audit',
      state: 'blocked',
    });
  });

  it('returns filtered runs plus unfiltered queue latency and chronological census evidence', async () => {
    const responses: unknown[][] = [
      [
        {
          id: 'run-new',
          harness_slug: 'papercusp',
          run_kind: 'promoter-tick',
          state: 'complete',
          started_at: '2026-08-26T15:00:00.000Z',
          finished_at: '2026-08-26T15:00:01.000Z',
          batch_size: 4,
          promoted: 2,
          merged: 1,
          held: 1,
          auto_promoted_unreviewed: 0,
          census_before: 7,
          census_after: 8,
          model_id: 'model-a',
          tokens_in: 100n,
          tokens_out: 20n,
          latency_ms: 1_000,
          detail: { status: 'complete', modelCostUsd: 0.0125 },
        },
      ],
      [{ pending: '9', unreviewed: '3', latency_sample_size: '5', p50_ms: '1200', p95_ms: '9400' }],
      [
        {
          population: '7',
          non_terminal: '6',
          terminal: '1',
          active: '1',
          awaiting_revision: '1',
          awaiting_review: '1',
          held: '1',
          ready: '1',
          unknown: '1',
          never_claimed: '4',
          ready_cost_covered: '1',
          ready_cost_cents: '250',
          recurrence_canonical_clusters: '1',
          recurrence_raw_occurrences: '2',
          recurrence_duplicate_occurrences: '1',
        },
      ],
      [
        {
          id: 'run-new',
          harness_slug: 'papercusp',
          run_kind: 'promoter-tick',
          started_at: '2026-08-26T15:00:00.000Z',
          census_before: 7,
          census_after: 8,
        },
        {
          id: 'run-old',
          harness_slug: 'papercusp',
          run_kind: 'census',
          started_at: '2026-08-26T14:00:00.000Z',
          census_before: 10,
          census_after: 7,
        },
      ],
    ];
    const executedSql: unknown[][] = [];
    const fakeSql = Object.assign(
      vi.fn((...args: unknown[]) => {
        // postgres.js executes on await, not template construction. Nested
        // fragments can contain SELECT too; they must not consume result rows.
        return {
          then(resolve: (rows: unknown[]) => void) {
            executedSql.push(args);
            const statement = (args[0] as TemplateStringsArray).join(' ');
            const responseIndex = statement.includes('ar.tokens_in') ? 0
              : statement.includes('AS latency_sample_size') ? 1
                : statement.includes('AS population') ? 2
                  : statement.includes('ar.census_before') ? 3 : -1;
            if (responseIndex < 0) throw new Error(`Unexpected executed admission query: ${statement}`);
            resolve(responses[responseIndex]!);
          },
        };
      }),
      {
        unsafe: vi.fn((value: string) => value),
      },
    );
    const snapshot = await readWorkItemAdmissionSnapshot({
      workspaceId: 'ws-active',
      harnessSlug: 'papercusp',
      kind: 'promoter-tick',
      state: 'complete',
      limit: 999,
      sql: fakeSql as never,
    });

    // Recurrence is now part of the readiness projection's one CTE-backed row,
    // so this snapshot performs four top-level reads rather than a fifth query.
    expect(executedSql).toHaveLength(4);
    const runsRead = executedSql.find(([strings]) =>
      (strings as TemplateStringsArray).join(' ').includes('ar.tokens_in'),
    );
    expect(runsRead?.slice(1)).toEqual(
      expect.arrayContaining(['ws-active', 'papercusp', 'promoter-tick', 'complete', 200]),
    );
    expect(snapshot.runs[0]).toMatchObject({
      id: 'run-new',
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.0125,
      censusDelta: 1,
    });
    expect(snapshot.summary).toMatchObject({
      pending: 9,
      unreviewed: 3,
      promotedToFirstClaim: { sampleSize: 5, p50Ms: 1200, p95Ms: 9400 },
      latestCensusRise: { runId: 'run-new', delta: 1 },
      readiness: {
        headline: { population: 7, ready: 1, unknown: 1 },
        flow: {
          recurrence: { canonicalClusters: 1, rawOccurrences: 2, duplicateOccurrences: 1 },
          readyExpectedCost: { coveredRows: 1, totalRows: 1, pricedSubtotalCents: 250, cents: 250 },
        },
      },
      usage: { modelRuns: 1, pricedRuns: 1, unpricedRuns: 0, costUsd: 0.0125 },
    });
    expect(snapshot.censusTrend.map((point) => point.runId)).toEqual(['run-old', 'run-new']);
  });
});

describe('sync-resolver v2 registry', () => {
  describe('knownQueryNamesV2', () => {
    it('returns sorted array of registered names', () => {
      const names = knownQueryNamesV2();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toEqual([...names].sort());
    });

    it('includes toastLog.recent (first migration)', () => {
      expect(knownQueryNamesV2()).toContain('toastLog.recent');
    });

    it('includes batch 2 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'auditLog.operatorDecisions',
        'operatorBudget.byWorkspace',
        'userActions.byKind',
        'userActions.recent',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 3 migrated names (harnessXxx.byHarness family)', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessTextArtifact.byHarness',
        'harnessProjectFiles.byHarness',
        'adaptiveTelemetry.byHarness',
        'harnessSkills.byHarness',
        'harnessDecisions.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 4 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessLanes.byHarness',
        'harnessEscalations.byHarness',
        'harnessCheckpoints.byHarness',
        'featurePrs.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 5 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessStatus.byHarness',
        'harnessTests.byHarness',
        'harnessArchives.byHarness',
        'harnessHookLogs.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 6 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of ['harnessSmokeTest.byHarness', 'harnessBrainstorm.byHarness']) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 7 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'pendingReviews.byHarness',
        'harnessPendingIssues.byHarness',
        'harnessScreenshots.byHarness',
        'agentChats.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 8 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'featureNotes.byHarness',
        'featureDebugNotes.byHarness',
        'featureAudit.byHarness',
        'chunkPlans.byHarness',
        'chunkPlans.byFeature',
        // (delegates.byWorkspace removed — collapse-delegate-into-workitems-2026-06-04:
        //  a delegate IS a work_item; the panel reads tasks via GET /api/agent-mcp/delegates.)
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 9 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'pluginConfigs.byHarness',
        'pluginEnables.byWorkspace',
        'projectSpecRevisions.byProject',
      ]) {
        expect(names).toContain(expected);
      }
    });

    // (batch 10's org_* query names were removed with the org-sim retirement,
    //  migration 192 — proposalsShared remains.)
    it('includes batch 10 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of ['proposalsShared.byHarness']) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 11 migrated names (final *Consolidated batch)', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'featuresConsolidated.bySlug',
        'issuesConsolidated.bySlug',
        'agentRunsConsolidated.bySlug',
        'agentRunsConsolidated.summary',
        'agentRunsConsolidated.recent',
        'snapshotsConsolidated.bySlug',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('exposes the full migrated set of distinct queryNames (≥ floor, grows as families land)', () => {
      // Was a brittle `toHaveLength(63)` exact-count that flapped red as new
      // query families landed (issues/conversations/coord 2026-06-04; work_items /
      // federation in flight). The migration-completeness signal is carried by the
      // many `toContain(...)` family assertions above + below; here we only assert
      // the registry never SHRINKS below its known floor and every name is distinct.
      // (delegates.byWorkspace removed by collapse-delegate-into-workitems-2026-06-04 → floor 62;
      // harnessHealth.byHarness removed by spec-md-ui-deprecation-cleanup P-007 → floor 61.)
      const names = knownQueryNamesV2();
      expect(names.length).toBeGreaterThanOrEqual(61);
      expect(new Set(names).size, 'queryNames are distinct').toBe(names.length);
    });

    it('includes the network.* push-driven discovery queries (data-sync-push-completion P-009)', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        // existing network.* family
        'network.board',
        // P-009: the two discovery panels migrated off polling onto the rail.
        'network.hiveDirectory',
        'network.federationStatus',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes every Conversations list/detail query (messages retired — retire-work-item-mail-surface-2026-07-26 P-004)', () => {
      const names = knownQueryNamesV2();
      expect(names).toEqual(
        expect.arrayContaining([
          'conversations.questionsList',
          'conversations.questionDetail',
          'conversations.deliberationList',
          'conversations.deliberationDetail',
          'conversations.agentChatList',
          'conversations.agentChatDetail',
        ]),
      );
      expect(names).not.toContain('conversations.messageList');
      expect(names).not.toContain('conversations.messageDetail');
    });

    it('includes the plans.* Create-tab live queries', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'plans.list',
        'plans.items',
        'plans.attention',
        'plans.search',
        'plans.get',
        'plans.revisions',
        'plans.runs',
        'plans.lint',
      ]) {
        expect(names).toContain(expected);
      }
    });
  });

  describe('arg validation — batch 2', () => {
    it('auditLog.operatorDecisions rejects missing workspaceId', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('auditLog.operatorDecisions', { limit: 5 })).rejects.toThrow();
    });

    it('userActions.byKind rejects missing kind', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('userActions.byKind', { harnessSlug: 'x', workspaceId: 'y' })).rejects.toThrow();
    });

    it('operatorBudget.byWorkspace takes an OPTIONAL workspaceId (request-scoped when omitted) and still rejects a non-string', async () => {
      // The operator Settings page sends no args, like its operatorConfig /
      // Preferences / StandingApprovals siblings; a required id 500'd that page
      // on every load (EI-22469131771258095).
      const { getRegistryEntryV2, resolveNamedQueryV2: r } = await import('./index');
      const entry = getRegistryEntryV2('operatorBudget.byWorkspace');
      expect(entry?.argsSchema?.parse(undefined)).toBeUndefined();
      expect(entry?.argsSchema?.parse({})).toEqual({});
      expect(entry?.argsSchema?.parse({ workspaceId: 'ws-1' })).toEqual({ workspaceId: 'ws-1' });
      await expect(r('operatorBudget.byWorkspace', { workspaceId: 42 })).rejects.toThrow();
    });
  });

  describe('isRegisteredV2', () => {
    it('returns true for registered names', () => {
      expect(isRegisteredV2('toastLog.recent')).toBe(true);
    });

    it('returns false for unregistered names (fall-back path)', () => {
      // After P-022 batch 11, every queryName from the original 2026-05-24
      // audit has been migrated. Only entirely-unknown / synthetic names
      // should hit the fall-back path now. Once the legacy resolver is
      // removed (P-022 cutover), the route handler will return an
      // error envelope instead of falling through, but the v2 dispatcher
      // contract still surfaces NAME_NOT_FOUND for unknown names.
      expect(isRegisteredV2('totally.unknown')).toBe(false);
      expect(isRegisteredV2('')).toBe(false);
      // NOTE: `plans.list` IS registered now (the Create-tab live-query
      // migration). Use a synthetic plans-namespace verb that will never
      // exist to exercise the unregistered path.
      expect(isRegisteredV2('plans.thisVerbDoesNotExist')).toBe(false);
    });
  });

  describe('resolveNamedQueryV2 — fall-back signal', () => {
    it('returns NAME_NOT_FOUND for unregistered names', async () => {
      const result = await resolveNamedQueryV2('plans.thisVerbDoesNotExist', { limit: 10 });
      expect(result).toBe(NAME_NOT_FOUND);
    });
  });

  describe('resolveNamedQueryV2 — toastLog.recent', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('calls listToasts with validated args and returns the flat row array', async () => {
      vi.doMock('../toast-log-data', () => ({
        listToasts: vi.fn(async (input: { limit?: number }) => ({
          toasts: [
            { id: 1, level: 'error', message: 'boom', limit: input.limit },
            { id: 2, level: 'info', message: 'ok', limit: input.limit },
          ],
        })),
      }));
      // Re-import so the module picks up the mock.
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('toastLog.recent', { limit: 25 })) as Array<{
        id: number;
        limit: number;
      }>;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(2);
      expect(rows[0].limit).toBe(25);
      vi.doUnmock('../toast-log-data');
    });

    it('applies the default limit (50) when args is empty', async () => {
      const limitsCaptured: Array<number | undefined> = [];
      vi.doMock('../toast-log-data', () => ({
        listToasts: vi.fn(async (input: { limit?: number }) => {
          limitsCaptured.push(input.limit);
          return { toasts: [] };
        }),
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('toastLog.recent', {});
      expect(limitsCaptured[0]).toBe(50);
      vi.doUnmock('../toast-log-data');
    });

    it('CLAMPS an over-cap limit (clamp-not-reject) and still rejects invalid input', async () => {
      const limitsCaptured: Array<number | undefined> = [];
      vi.doMock('../toast-log-data', () => ({
        listToasts: vi.fn(async (input: { limit?: number }) => {
          limitsCaptured.push(input.limit);
          return { toasts: [] };
        }),
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      // Over-cap CLAMPS to the cap (500), never throws — a newer client asking for
      // more than this resolver's cap must NOT break the panel with a "Too big"
      // error (the client/server skew bug; clamp-not-reject, P-001 / D-002).
      await r('toastLog.recent', { limit: 1000 });
      expect(limitsCaptured[0]).toBe(500);
      // Genuinely-invalid input still rejects at arg-parse (must be a positive int).
      await expect(r('toastLog.recent', { limit: -1 })).rejects.toThrow();
      await expect(r('toastLog.recent', { limit: 'twenty' })).rejects.toThrow();
      vi.doUnmock('../toast-log-data');
    });
  });

  describe('structural — every registered entry is well-shaped', () => {
    // INTENT: catch a registry entry that's mis-wired — the classic bug is a
    // typo'd key (`resolves:` instead of `resolve:`) which leaves `resolve`
    // undefined, so the dispatcher throws "entry.resolve is not a function" the
    // first time that name is requested in production. The shared dispatcher
    // (createResolver) is pure routing: `entry.argsSchema?.parse(args)` then
    // `entry.resolve(validated)` — so "is this entry safe to dispatch?" reduces
    // to "is `resolve` a function and is `argsSchema` (if present) a validator?"
    //
    // We assert that STRUCTURALLY, by inspecting each entry, rather than by
    // dispatching it. The previous version called the real resolver for every
    // null-accepting name, hitting PG/FS — so its runtime scaled with
    // (entry count × I/O latency under load) and repeatedly froze the green
    // gate (the per-test timeout escalated 10s→30s→120s and STILL timed out at
    // ~123 entries under load-90, 2026-06-18). Structural inspection is O(1) per
    // entry, does zero I/O, and catches the exact same bug class
    // deterministically. The per-resolver dispatch tests below (with mocked
    // data) cover routing + arg-validation behavior for the entries that matter.
    it('every registered entry has a callable resolve and a valid argsSchema', async () => {
      const { knownQueryNamesV2: known, getRegistryEntryV2: entryOf } = await import('./index');
      const names = known();
      expect(names.length).toBeGreaterThan(40); // sanity: we have ~123 today

      const malformed: Array<{ name: string; reason: string }> = [];
      for (const name of names) {
        const entry = entryOf(name);
        if (!entry) {
          malformed.push({ name, reason: 'no entry for a known name' });
          continue;
        }
        if (typeof entry.resolve !== 'function') {
          malformed.push({
            name,
            reason: `resolve is ${typeof entry.resolve} (typo'd 'resolves:'?)`,
          });
        }
        // argsSchema is optional; when present it must be an ArgsValidator
        // (a zod schema, or anything exposing a `.parse(input)` method).
        if (entry.argsSchema !== undefined && typeof (entry.argsSchema as { parse?: unknown }).parse !== 'function') {
          malformed.push({
            name,
            reason: 'argsSchema present but has no .parse() (not a validator)',
          });
        }
      }
      expect(malformed).toEqual([]);
    });
  });
});

/* ── P-029: plansDrafts.bySlug resolver ────────────────────────────── */

describe('resolveNamedQueryV2 — learning.experiments (experiment-registry-invocation-api P-051)', () => {
  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('learning.experiments');
  });
});

describe('resolveNamedQueryV2 — p2p.* (p2p-work-distribution-2026-07-02 P-002)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers the P2P settings-surface queries in knownQueryNamesV2', () => {
    for (const expected of ['p2p.settings', 'p2p.devices', 'p2p.grants', 'p2p.foreignWorkspaces', 'p2p.audit']) {
      expect(knownQueryNamesV2()).toContain(expected);
    }
  });

  // ── p2p.settings — the workspace-singleton settings layers (client reads data[0]) ──
  it('p2p.settings returns the stored layers as a 1-element array (client reads data[0])', async () => {
    const layers = {
      workspaceId: 'ws-test',
      baked: { optIn: { mode: 'off' }, killSwitch: { engaged: false } },
      defaultLayer: null,
      overrideLayer: { optIn: { mode: 'any-fleet' } },
      effective: { optIn: { mode: 'any-fleet' }, killSwitch: { engaged: false } },
    };
    vi.doMock('../p2p/settings', () => ({
      readP2pSettings: vi.fn(async () => layers),
      bakedP2pDefaults: vi.fn(() => ({ optIn: { mode: 'off' }, killSwitch: { engaged: false } })),
    }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.settings', {})) as unknown[];
    expect(out).toEqual([layers]);
    vi.doUnmock('../p2p/settings');
  });

  it('p2p.settings tags baked defaults as unavailable on read failure — never a false CLEAR or a 500', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const baked = {
      optIn: { mode: 'off', fleets: [], maxConcurrentForeign: 2, windows: [] },
      killSwitch: { engaged: false },
    };
    vi.doMock('../p2p/settings', () => ({
      readP2pSettings: vi.fn(async () => {
        throw Object.assign(new Error('relation "p2p_settings" does not exist'), { code: '42P01' });
      }),
      bakedP2pDefaults: vi.fn(() => baked),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.settings', {})) as Array<{
      effective: unknown;
      baked: unknown;
      workspaceId: string;
      unavailable: boolean;
      unavailableKind: string;
      unavailableReason: string;
    }>;
    expect(out).toHaveLength(1);
    expect(out[0].workspaceId).toBe('ws-test');
    expect(out[0].effective).toEqual(baked); // inert defaults → the page renders, opt-in off
    expect(out[0].baked).toEqual(baked);
    expect(out[0]).toMatchObject({
      unavailable: true,
      unavailableKind: 'pre-migration',
      unavailableReason: 'relation "p2p_settings" does not exist',
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    vi.doUnmock('../p2p/settings');
    vi.doUnmock('../workspace-registry');
  });

  // ── p2p.devices — the Identity & devices section (loud when unresolved / missing) ──
  it('p2p.devices returns a lone identity-unresolved row when there is no attested actor (page shows RED)', async () => {
    vi.doMock('../harness/usage-actor', () => ({ resolveUsageActor: vi.fn(async () => null) }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.devices', {})) as Array<Record<string, unknown>>;
    expect(out).toEqual([{ kind: 'identity', githubUserId: null, devicePubkey: null }]);
    vi.doUnmock('../harness/usage-actor');
  });

  it('p2p.devices distinguishes an actor lookup failure from a genuine unresolved identity', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('../harness/usage-actor', () => ({
      resolveUsageActor: vi.fn(async () => {
        throw new Error('credential store unavailable');
      }),
    }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.devices', {})) as Array<Record<string, unknown>>;
    expect(out).toEqual([
      {
        kind: 'unavailable',
        unavailable: true,
        unavailableKind: 'read-failed',
        unavailableReason: 'credential store unavailable',
      },
    ]);
    vi.doUnmock('../harness/usage-actor');
  });

  it('p2p.devices maps a hive membership to an attested THIS-device row (no missing badge)', async () => {
    const actor = { githubUserId: 279242982, devicePubkey: 'DEV-THIS' };
    const members = [
      {
        pot_home_slug: 'papercusp',
        device_attestations: [
          { device_pubkey: 'DEV-THIS', device_label: 'tower', created_at: 1_700_000_000_000, gist_url: 'https://g' },
        ],
        revoked_pubkeys: [],
      },
    ];
    vi.doMock('../harness/usage-actor', () => ({ resolveUsageActor: vi.fn(async () => actor) }));
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql: async () => members }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.devices', {})) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ kind: 'identity', githubUserId: 279242982, devicePubkey: 'DEV-THIS' });
    const dev = out.find((row) => row.kind === 'device');
    expect(dev).toMatchObject({
      potHomeSlug: 'papercusp',
      devicePubkey: 'DEV-THIS',
      isThisDevice: true,
      revoked: false,
    });
    expect(out.some((row) => row.kind === 'missing')).toBe(false); // this device is live → no RED
    vi.doUnmock('../harness/usage-actor');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('../workspace-registry');
  });

  it('p2p.devices emits a MISSING row when this device is absent from a hive attestation set (loud, never silent)', async () => {
    const actor = { githubUserId: 279242982, devicePubkey: 'DEV-THIS' };
    const members = [
      {
        pot_home_slug: 'papercusp',
        device_attestations: [{ device_pubkey: 'DEV-OTHER', device_label: 'imac', created_at: 1_700_000_000_000 }],
        revoked_pubkeys: [],
      },
    ];
    vi.doMock('../harness/usage-actor', () => ({ resolveUsageActor: vi.fn(async () => actor) }));
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ sql: async () => members }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.devices', {})) as Array<Record<string, unknown>>;
    expect(out).toContainEqual({ kind: 'missing', potHomeSlug: 'papercusp' });
    vi.doUnmock('../harness/usage-actor');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('../workspace-registry');
  });

  it('p2p.devices marks the snapshot unavailable when the membership read throws — never a false empty or a 500', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const actor = { githubUserId: 279242982, devicePubkey: 'DEV-THIS' };
    vi.doMock('../harness/usage-actor', () => ({ resolveUsageActor: vi.fn(async () => actor) }));
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({
        sql: (strings: TemplateStringsArray | string) => {
          // Identifiers are composed synchronously; only a statement read fails.
          if (typeof strings === 'string') return strings;
          return Promise.reject(Object.assign(new Error('relation "hive_members" does not exist'), { code: '42P01' }));
        },
      }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.devices', {})) as Array<Record<string, unknown>>;
    expect(out).toEqual([
      {
        kind: 'unavailable',
        unavailable: true,
        unavailableKind: 'pre-migration',
        unavailableReason: 'relation "hive_members" does not exist',
      },
    ]);
    warnSpy.mockRestore();
    vi.doUnmock('../harness/usage-actor');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('../workspace-registry');
  });

  // ── p2p.grants — the Peers capability matrix (hive-scoped, includes revoked) ──
  it('p2p.grants returns the hive-scoped grant list (includeRevoked so the matrix can show revocation)', async () => {
    const grants = [{ granteeKind: 'fleet', granteeRef: 'fleet-a', status: 'active', capabilities: ['work.offer'] }];
    const listPeerGrants = vi.fn(async () => grants);
    vi.doMock('../p2p/grant-store', () => ({ listPeerGrants }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.grants', { potSlug: 'papercusp' })) as unknown[];
    expect(out).toEqual(grants);
    expect(listPeerGrants).toHaveBeenCalledWith({ workspaceId: 'ws-test', potSlug: 'papercusp', includeRevoked: true });
    vi.doUnmock('../p2p/grant-store');
    vi.doUnmock('../workspace-registry');
  });

  it('p2p.grants marks the matrix unavailable before migration 463 applies — never a false empty or a 500', async () => {
    vi.doMock('../p2p/grant-store', () => ({
      listPeerGrants: vi.fn(async () => {
        throw Object.assign(new Error('relation "peer_grants" does not exist'), { code: '42P01' });
      }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.grants', { potSlug: 'papercusp' })) as unknown[];
    expect(out).toEqual([
      {
        kind: 'unavailable',
        unavailable: true,
        unavailableKind: 'pre-migration',
        unavailableReason: 'relation "peer_grants" does not exist',
      },
    ]);
    vi.doUnmock('../p2p/grant-store');
    vi.doUnmock('../workspace-registry');
  });

  // ── p2p.foreignWorkspaces — public lifecycle projection, no host paths ──
  it('p2p.foreignWorkspaces returns only owner-visible lifecycle fields and strips host internals', async () => {
    const listForeignWorkspaces = vi.fn(async () => [
      {
        workspaceId: 'ws-test',
        offerId: 'offer-1',
        fleetSlug: 'fleet-east',
        originGithubUserId: 279242982,
        executorDevice: 'device-secret',
        rootPath: '/srv/private/foreign/offer-1',
        clonePath: '/srv/private/foreign/offer-1/repo',
        sessionId: 'session-7',
        executionEpoch: 3,
        state: 'active',
        parkReason: null,
        baseSha: '0123456789abcdef',
        createdAt: 1_699_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ]);
    vi.doMock('../p2p/foreign-workspaces', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../p2p/foreign-workspaces')>()),
      listForeignWorkspaces,
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.foreignWorkspaces', {})) as Array<Record<string, unknown>>;

    expect(listForeignWorkspaces).toHaveBeenCalledWith('ws-test');
    expect(out).toEqual([
      {
        workspaceId: 'ws-test',
        offerId: 'offer-1',
        fleetSlug: 'fleet-east',
        sessionId: 'session-7',
        state: 'active',
        parkReason: null,
        updatedAt: 1_700_000_000_000,
      },
    ]);
    expect(out[0]).not.toHaveProperty('rootPath');
    expect(out[0]).not.toHaveProperty('clonePath');
    expect(out[0]).not.toHaveProperty('executorDevice');
    expect(out[0]).not.toHaveProperty('baseSha');

    vi.doUnmock('../p2p/foreign-workspaces');
    vi.doUnmock('../workspace-registry');
  });

  // ── p2p.audit — p2p:*-prefixed audit rows (default limit 50) ──
  it('p2p.audit returns p2p-prefixed audit rows and applies the argsSchema default limit (50)', async () => {
    const rows = [
      { id: 'a1', ts: 1_700_000_000_000, actor: 'owner', action: 'p2p:kill-switch', subject: 'host', details: {} },
    ];
    const captured: { args: unknown[] } = { args: [] };
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({
        sql: async (..._a: unknown[]) => {
          captured.args = _a;
          return rows;
        },
      }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.audit', {})) as unknown[];
    expect(out).toEqual(rows);
    // tagged-template call: sql`… ${activeWorkspaceId()} … LIMIT ${limit}` → last interpolated value is the default limit.
    expect(captured.args[captured.args.length - 1]).toBe(50);
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('../workspace-registry');
  });

  it('p2p.audit marks the trail unavailable when the read throws — never a false empty or a 500', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({
        sql: (strings: TemplateStringsArray | string) => {
          if (typeof strings === 'string') return strings;
          return Promise.reject(new Error('audit_log unavailable'));
        },
      }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('p2p.audit', { limit: 10 })) as unknown[];
    expect(out).toEqual([
      {
        kind: 'unavailable',
        unavailable: true,
        unavailableKind: 'read-failed',
        unavailableReason: 'audit_log unavailable',
      },
    ]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('../workspace-registry');
  });
});

describe('resolveNamedQueryV2 — trust.list (shared-hive-trust-admission Phase 4 / P-011, Trust A4)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('trust.list');
  });

  it('returns the workspace trusted-user list flat (client reads data as the array)', async () => {
    const list = [
      { githubUserId: 583231, note: 'core maintainer', createdTs: 1000 },
      { githubUserId: 42, note: null, createdTs: 900 },
    ];
    vi.doMock('../trust/user-trust-list', () => ({ listTrustedUsers: vi.fn(async () => list) }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('trust.list', {})) as Array<{ githubUserId: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].githubUserId).toBe(583231);
    vi.doUnmock('../trust/user-trust-list');
    vi.doUnmock('../workspace-registry');
  });

  it('degrades to [] when the read throws (pre-migration / no PG) — never a 500', async () => {
    vi.doMock('../trust/user-trust-list', () => ({
      listTrustedUsers: vi.fn(async () => {
        throw Object.assign(new Error('relation "user_trust_list" does not exist'), { code: '42P01' });
      }),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('trust.list', {})) as unknown[];
    expect(rows).toEqual([]);
    vi.doUnmock('../trust/user-trust-list');
    vi.doUnmock('../workspace-registry');
  });
});

describe('resolveNamedQueryV2 — plansDrafts.bySlug (P-029)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Deterministic minimal parse for fixtures — keeps itemCount/now extraction
  // stable for the resolver assertions below (the real @papercusp/plan-parser
  // counts items by phase structure, which these terse fixtures don't model).
  function parseFixture(raw: string) {
    const fm: Record<string, string> = {};
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const m = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
        if (m) fm[m[1]] = m[2];
      }
    }
    const items = [...raw.matchAll(/^- \[[ x]\] (P-\d+)/gm)].map((m, i) => ({
      id: m[1],
      text: `item ${i + 1}`,
    }));
    const nowStateM = raw.match(/\*\*State:\*\*\s*(.+)/);
    const nowNextM = raw.match(/\*\*Next:\*\*\s*(.+)/);
    return {
      isLegacy: !fmMatch,
      slug: fm.slug ?? null,
      frontmatter: {
        title: fm.title ?? null,
        slug: fm.slug ?? null,
        status: fm.status ?? null,
        created: fm.created ?? null,
        updated: fm.updated ?? null,
      },
      items,
      now: nowStateM ? { state: nowStateM[1].trim(), next: nowNextM?.[1].trim() ?? null } : null,
    };
  }

  // Plans went PG-canonical (plans-pg-canonical-migration-2026-06-03): the
  // resolver now reads via readAllPlans (which returns pre-parsed rows from PG),
  // not listPlanFiles + fs.readFile + parsePlan. Mock that single boundary.
  function mockPlansDeps(
    plans: Array<{
      slug: string;
      filePath: string;
      archived?: boolean;
      content: string;
    }>,
  ) {
    vi.doMock('../agent-tools/plans/source', () => ({
      resolveHarnessPlansDir: vi.fn(async () => ({
        harnessSlug: 'myharn',
        workspaceId: 'ws',
        plans: '/fake/plans',
        archive: '/fake/plans/archive',
      })),
      readAllPlans: vi.fn(async () =>
        plans.map((p) => {
          const parsed = parseFixture(p.content);
          return {
            parsed,
            archived: p.archived ?? false,
            // WI-7259: the resolver now filters + identifies by the canonical
            // row (`row.status`/`row.planSlug`), not frontmatter — mirror the
            // fixture's own declared status/slug here (a real PG row's status
            // column always agrees with what was written) so the draft filter
            // isn't dropping every row.
            row: {
              harnessSlug: 'myharn',
              planSlug: p.slug,
              content: p.content,
              archived: p.archived ?? false,
              status: parsed.frontmatter.status,
            },
          };
        }),
      ),
    }));
  }

  const DRAFT_PLAN = (slug: string, source: 'user' | 'scoper' = 'user') => `---
title: "${source === 'scoper' ? 'Scoper proposal' : 'My draft plan'}"
slug: ${slug}
status: draft
created: 2026-05-24
updated: 2026-05-24
---

## Now

**State:** Not started.
**Next:** Human reviews.

## Phase 1 — Core

- [ ] P-001 Do the thing
- [ ] P-002 Do another thing
`;

  const ACTIVE_PLAN = (slug: string) => `---
title: "Active plan"
slug: ${slug}
status: active
created: 2026-05-20
updated: 2026-05-22
---

## Now

**State:** In progress.
**Next:** Keep going.

## Phase 1

- [ ] P-001 item
`;

  it('returns draft plans only — skips active/archived', async () => {
    mockPlansDeps([
      {
        slug: 'my-plan-2026-05-24',
        filePath: '/fake/plans/my-plan-2026-05-24.md',
        content: DRAFT_PLAN('my-plan-2026-05-24'),
      },
      {
        slug: 'active-2026-05-20',
        filePath: '/fake/plans/active-2026-05-20.md',
        content: ACTIVE_PLAN('active-2026-05-20'),
      },
      {
        slug: 'archived-2026-05-10',
        filePath: '/fake/plans/archive/archived-2026-05-10.md',
        archived: true,
        content: DRAFT_PLAN('archived-2026-05-10'),
      },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('my-plan-2026-05-24');
    expect(rows[0].status).toBe('draft');
  });

  it('derives source: scoper for scoper-proposal-* slug, user otherwise', async () => {
    mockPlansDeps([
      {
        slug: 'my-feature-2026-05-24',
        filePath: '/fake/plans/my-feature-2026-05-24.md',
        content: DRAFT_PLAN('my-feature-2026-05-24', 'user'),
      },
      {
        slug: 'scoper-proposal-gap-2026-05-24',
        filePath: '/fake/plans/scoper-proposal-gap-2026-05-24.md',
        content: DRAFT_PLAN('scoper-proposal-gap-2026-05-24', 'scoper'),
      },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
      source: string;
    }>;
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
    expect(bySlug['my-feature-2026-05-24'].source).toBe('user');
    expect(bySlug['scoper-proposal-gap-2026-05-24'].source).toBe('scoper');
  });

  it('returns itemCount matching parsed items', async () => {
    mockPlansDeps([
      {
        slug: 'two-items-2026-05-24',
        filePath: '/fake/plans/two-items-2026-05-24.md',
        content: DRAFT_PLAN('two-items-2026-05-24'),
      },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      itemCount: number;
    }>;
    expect(rows[0].itemCount).toBe(2);
  });

  it('sorts newest-first by updated date', async () => {
    const older = `---
title: "Older"
slug: older-2026-05-22
status: draft
created: 2026-05-22
updated: 2026-05-22
---
## Now
**State:** s
**Next:** n
## Phase 1
- [ ] P-001 x
`;
    const newer = `---
title: "Newer"
slug: newer-2026-05-24
status: draft
created: 2026-05-24
updated: 2026-05-24
---
## Now
**State:** s
**Next:** n
## Phase 1
- [ ] P-001 x
`;
    mockPlansDeps([
      { slug: 'older-2026-05-22', filePath: '/fake/plans/older-2026-05-22.md', content: older },
      { slug: 'newer-2026-05-24', filePath: '/fake/plans/newer-2026-05-24.md', content: newer },
    ]);
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as Array<{
      slug: string;
    }>;
    expect(rows[0].slug).toBe('newer-2026-05-24');
    expect(rows[1].slug).toBe('older-2026-05-22');
  });

  it('skips legacy / unparseable plans without throwing', async () => {
    // Post-PG-canonical: readAllPlans yields a row whose parse came back legacy
    // (no frontmatter). The resolver must skip it (not surface it as a draft) and
    // not throw — the resilience guarantee the old ENOENT test protected.
    vi.doMock('../agent-tools/plans/source', () => ({
      resolveHarnessPlansDir: vi.fn(async () => ({
        harnessSlug: 'myharn',
        workspaceId: 'ws',
        plans: '/fake',
        archive: '/fake/archive',
      })),
      readAllPlans: vi.fn(async () => [
        {
          parsed: {
            isLegacy: true,
            slug: 'legacy-2026-05-24',
            frontmatter: { title: null, slug: null, status: null, created: null, updated: null },
            items: [],
            now: null,
          },
          archived: false,
          row: { harnessSlug: 'myharn', planSlug: 'legacy-2026-05-24', content: 'no frontmatter', archived: false },
        },
      ]),
    }));
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('plansDrafts.bySlug', { harnessSlug: 'myharn' })) as unknown[];
    expect(rows).toEqual([]);
  });

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('plansDrafts.bySlug');
  });
});

describe('savedPrompts.byScope (quick-panel-saved-prompts-2026-07-13 P-003)', () => {
  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('savedPrompts.byScope');
  });
});

describe('resolveNamedQueryV2 — hive.steering (queen-steering-panel-2026-06-15 B-01 / CONTRACT C-1)', () => {
  // EI-18142363462575751: every test below does `vi.resetModules()` + a fresh
  // `await import('./index')`, so each one races the REAL resolveNamedQueryV2
  // dispatcher — including its production `RESOLVER_TIMEOUT_MS` (10s default,
  // read once from PAPERCUSP_SYNC_RESOLVER_TIMEOUT_MS at module import time,
  // index.ts:5764-5765) — against the mocked-fast resolve() below. On a lightly
  // loaded box the mocked resolve settles in well under 10s; under this box's
  // heavy concurrent-fleet load, a fresh ESM re-import + re-execution of this
  // ~5800-line module can occasionally push even the FAST mocked path past the
  // real 10s wall-clock ceiling, throwing QueryResolveTimeoutError — a pure
  // host-load timing flake, not a resolver defect (test_runs: this exact test
  // failed 4× at 10.0-15.7s and passed dozens of times at well under 10s;
  // isolated single-test runs never reproduce it). The dispatcher's OWN timeout
  // *mechanism* is already covered deterministically with fake timers in
  // libs/generic/sync/src/server/query-registry.test.ts — this describe block
  // has no business exercising the real wall-clock deadline at all. Widen it
  // for just these tests so they stop racing production timing under load.
  const PRIOR_TIMEOUT_ENV = process.env.PAPERCUSP_SYNC_RESOLVER_TIMEOUT_MS;
  beforeAll(() => {
    process.env.PAPERCUSP_SYNC_RESOLVER_TIMEOUT_MS = '120000';
  });
  afterAll(() => {
    if (PRIOR_TIMEOUT_ENV === undefined) delete process.env.PAPERCUSP_SYNC_RESOLVER_TIMEOUT_MS;
    else process.env.PAPERCUSP_SYNC_RESOLVER_TIMEOUT_MS = PRIOR_TIMEOUT_ENV;
  });

  beforeEach(() => {
    vi.resetModules();
  });

  // The decoded OwnerSteering default the resolver spreads on a per-hive read
  // failure (owner-steering.ts DEFAULT_OWNER_STEERING).
  const DEFAULT = {
    directive: null as string | null,
    eligiblePlans: [] as string[],
    eligibleHives: [] as string[],
    pauseNewWork: false,
    pausedUntil: null as number | null,
    modelTiers: null,
    tierCeilings: null,
  };

  // Mock the boundaries the resolver dynamic-imports. The three UNIT boundaries
  // (hive list, owner-steering decode, active-workspace accessor) are the seam
  // under test. The resolver ALSO dynamic-imports four HEAVY modules purely for
  // decorative UI defaults (throttle defaults — queen-steering-panel P-006 D-006;
  // home-hive stamp — 2026-07-01): ../pot/wake, ../rate-limit-config,
  // ../pot/placement-watchdog, ../harness/operator-home-harness. They are NOT the
  // unit under test, and their COLD transform (~8s of transitive deps) pushed the
  // first real resolve here past the 10s resolver timeout under checkpoint load
  // (WI-5610). Mock them too so every test stays a true, fast unit test.
  // (Specifiers resolve identically from this test file and index.ts — both live
  // in sync-resolver/.) Returns the getOwnerSteering spy for call-arg assertions.
  function mockSteeringDeps(opts: {
    hives: Array<{ slug: string }> | (() => Promise<never>);
    getOwnerSteering: (ws: string, slug: string) => Promise<typeof DEFAULT>;
  }) {
    const getOwnerSteering = vi.fn(opts.getOwnerSteering);
    vi.doMock('../agent-tools/pot/_resolve', () => ({
      listPots: vi.fn(typeof opts.hives === 'function' ? opts.hives : async () => opts.hives),
    }));
    vi.doMock('../owner-steering', () => ({
      getOwnerSteering,
      DEFAULT_OWNER_STEERING: DEFAULT,
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    // Decorative-default deps (not under test) — mocked to skip their cold transform.
    vi.doMock('../pot/wake', () => ({ potWakeFloorSec: () => 60, resolvePotHomeSlug: () => null }));
    vi.doMock('../rate-limit-config', () => ({ getCachedRateLimitConfig: () => ({ maxSimultaneousAgents: 10 }) }));
    vi.doMock('../pot/placement-watchdog', () => ({ placementConfig: () => ({ breakerThreshold: 3 }) }));
    vi.doMock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => null }));
    return { getOwnerSteering };
  }
  function unmockSteeringDeps() {
    vi.doUnmock('../agent-tools/pot/_resolve');
    vi.doUnmock('../owner-steering');
    vi.doUnmock('../workspace-registry');
    vi.doUnmock('../pot/wake');
    vi.doUnmock('../rate-limit-config');
    vi.doUnmock('../pot/placement-watchdog');
    vi.doUnmock('../harness/operator-home-harness');
  }

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('hive.steering');
  });

  it('returns one decoded steering row per hive ({ slug, ...OwnerSteering }), read under the active workspace', async () => {
    const bySlug: Record<string, typeof DEFAULT> = {
      'papercup-hive': { ...DEFAULT, directive: 'focus the backlog', eligiblePlans: ['plan-a'] },
      'other-hive': { ...DEFAULT, pauseNewWork: true },
    };
    const { getOwnerSteering } = mockSteeringDeps({
      hives: [{ slug: 'papercup-hive' }, { slug: 'other-hive' }],
      getOwnerSteering: async (_ws: string, slug: string) => bySlug[slug] ?? DEFAULT,
    });
    const { resolveNamedQueryV2: r } = await import('./index');

    const rows = (await r('hive.steering', {})) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // order preserved (Promise.all over the hive list), each row = slug + decoded steering
    expect(rows[0]).toMatchObject({ slug: 'papercup-hive', directive: 'focus the backlog', eligiblePlans: ['plan-a'] });
    expect(rows[1]).toMatchObject({ slug: 'other-hive', pauseNewWork: true });
    // steering is read for EACH hive under the active workspace id
    expect(getOwnerSteering.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['ws-test', 'papercup-hive'],
      ['ws-test', 'other-hive'],
    ]);

    unmockSteeringDeps();
  });

  it('returns [] for an un-hived workspace (no hives)', async () => {
    mockSteeringDeps({ hives: [], getOwnerSteering: async () => DEFAULT });
    const { resolveNamedQueryV2: r } = await import('./index');
    expect(await r('hive.steering', {})).toEqual([]);
    unmockSteeringDeps();
  });

  it('degrades to [] when listPots throws (pre-migration / registry unavailable) — never a 500', async () => {
    mockSteeringDeps({
      hives: async () => {
        throw new Error('hive registry unavailable');
      },
      getOwnerSteering: async () => DEFAULT,
    });
    const { resolveNamedQueryV2: r } = await import('./index');
    expect((await r('hive.steering', {})) as unknown[]).toEqual([]);
    unmockSteeringDeps();
  });

  it('a per-hive getOwnerSteering failure falls back to DEFAULT for THAT hive only (others still decode)', async () => {
    mockSteeringDeps({
      hives: [{ slug: 'good-hive' }, { slug: 'broken-hive' }],
      getOwnerSteering: async (_ws, slug) => {
        if (slug === 'broken-hive') throw new Error('hive_settings read failed');
        return { ...DEFAULT, directive: 'ok' };
      },
    });
    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('hive.steering', {})) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ slug: 'good-hive', directive: 'ok' });
    // the broken hive is NOT dropped — it appears decoded to the safe default
    expect(rows[1]).toMatchObject({ slug: 'broken-hive', directive: null, eligiblePlans: [], pauseNewWork: false });
    unmockSteeringDeps();
  });
});

describe('resolveNamedQueryV2 — fleetAssignments.byHarness (workspace scoping)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('is registered in knownQueryNamesV2', () => {
    expect(knownQueryNamesV2()).toContain('fleetAssignments.byHarness');
  });

  // Regression: the "Working" Agents panel rides a request stamped with THIS
  // window's workspace (x-papercusp-workspace → ALS → activeWorkspaceId()). The
  // resolver must thread that workspace into listFleetAssignments — filtering by
  // the harness slug ALONE surfaced fleet rows from every workspace, so the panel
  // never re-scoped on a workspace switch (the same bug class as the unscoped
  // sessions roster). Mirrors the sibling hiveRoster.byHarness, which already
  // scopes this way.
  it('threads the active workspace into the fleet read (not just the harness slug)', async () => {
    const listFleetAssignments = vi.fn(async (_opts: { harness: string; workspaceId: string }) => []);
    vi.doMock('../fleet/assignments', () => ({
      listFleetAssignments,
      groupByAgent: vi.fn(() => []),
    }));
    vi.doMock('../adv-sessions', async (orig) => ({
      ...(await orig<typeof import('../adv-sessions')>()),
      listAdvSessions: vi.fn(async () => []),
    }));
    vi.doMock('@papercusp/agent-mcp', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
      classifyAgentPane: vi.fn(() => ({ kind: 'su', driveMode: 'manual' })),
    }));
    vi.doMock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));

    const { resolveNamedQueryV2: r } = await import('./index');
    const rows = (await r('fleetAssignments.byHarness', { harnessSlug: 'myharn' })) as unknown[];
    expect(rows).toEqual([]);
    expect(listFleetAssignments).toHaveBeenCalledTimes(1);
    expect(listFleetAssignments.mock.calls[0]?.[0]).toEqual({
      harness: 'myharn',
      workspaceId: 'ws-active',
    });

    vi.doUnmock('../fleet/assignments');
    vi.doUnmock('../adv-sessions');
    vi.doUnmock('@papercusp/agent-mcp');
    vi.doUnmock('../workspace-registry');
  });
});

describe('resolveNamedQueryV2 — featuresConsolidated.byHive (WI-259 P-006 cross-member browse, D-010)', () => {
  // A small chainable drizzle-`db` stub: select().from().where(clause).orderBy() → rows.
  // It ignores the clauses; the assertion target is the slug SET passed to inArray,
  // captured via a drizzle-orm passthrough mock below.
  function fakeDb(rows: unknown[]) {
    return {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => rows }) }) }),
    };
  }
  const FAKE_COLS = { harnessSlug: 'c_slug', workspaceId: 'c_ws', updatedTs: 'c_ts' };

  it('enumerates the hive member-slugs (home + hive_slug members), strips the harness: prefix, and excludes a non-member', async () => {
    const captured: { values: string[] } = { values: [] };
    const actualRegistry = await vi.importActual<typeof import('../harness-registry')>('../harness-registry');
    vi.doMock('../harness-registry', () => ({
      // REAL enumeration (so the strip + home-always-included + hive_slug match are
      // genuinely exercised), fed a synthetic registry.
      hiveMemberHarnessScopes: actualRegistry.hiveMemberHarnessScopes,
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [
          { slug: 'hive-home', harness_kind: 'hive' },
          { slug: 'member-a', hive_slug: 'hive-home' },
          { slug: 'member-b', hive_slug: 'hive-home' },
          { slug: 'stranger', hive_slug: 'other-hive' },
        ],
      })),
    }));
    const rows = [{ featureId: 'F-1', harnessSlug: 'member-a' }];
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ db: fakeDb(rows) }),
      generated: { harnessFeaturesConsolidatedInHarnessShared: FAKE_COLS },
    }));
    vi.doMock('drizzle-orm', async () => ({
      ...(await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')),
      inArray: (_col: unknown, values: string[]) => {
        captured.values = values;
        return { __inArray: values };
      },
    }));

    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('featuresConsolidated.byHive', { potHomeSlug: 'hive-home' })) as unknown[];

    expect(out).toEqual(rows);
    expect(new Set(captured.values)).toEqual(new Set(['hive-home', 'member-a', 'member-b']));
    expect(captured.values).not.toContain('stranger');

    vi.doUnmock('../harness-registry');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('drizzle-orm');
  });

  it('degrades to [potHomeSlug] (never 500s the rollup) when the registry read fails', async () => {
    // The degrade path intentionally warns; swallow it so vitest-fail-on-console
    // doesn't flag the deliberate diagnostic.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const captured: { values: string[] } = { values: [] };
    vi.doMock('../harness-registry', () => ({
      hiveMemberHarnessScopes: vi.fn(() => {
        throw new Error('should not be reached — loadHarnessRegistry already threw');
      }),
      loadHarnessRegistry: vi.fn(async () => {
        throw new Error('registry boom');
      }),
    }));
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({ db: fakeDb([]) }),
      generated: { harnessFeaturesConsolidatedInHarnessShared: FAKE_COLS },
    }));
    vi.doMock('drizzle-orm', async () => ({
      ...(await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')),
      inArray: (_col: unknown, values: string[]) => {
        captured.values = values;
        return { __inArray: values };
      },
    }));

    const { resolveNamedQueryV2: r } = await import('./index');
    await r('featuresConsolidated.byHive', { potHomeSlug: 'lonely-home' });

    expect(captured.values).toEqual(['lonely-home']);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    vi.doUnmock('../harness-registry');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('drizzle-orm');
  });

  it('is a registered query name', async () => {
    const { knownQueryNamesV2: k } = await import('./index');
    expect(k()).toContain('featuresConsolidated.byHive');
  });

  /**
   * WI-7087: pins the projection to the FIVE columns PotContentPanel's own
   * `PotFeatureRow` declares. Both halves are asserted, because they fail in
   * opposite directions: a column coming BACK is a silent re-inflation (`summary`
   * alone was 831,678 B = 56.58% of the live payload and nothing ever read it),
   * and a column going AWAY is a silent render break.
   *
   * Deliberately NOT the same set as `.bySlug` — that sibling keeps 11 columns for
   * a wider consumer set. The old resolver comment claimed the two mirrored each
   * other exactly, which is how `summary` survived `.bySlug` dropping it.
   */
  it("projects exactly PotContentPanel's five declared columns — no summary, no bare select", async () => {
    const captured: { cols: string[] } = { cols: [] };
    vi.doMock('../harness-registry', () => ({
      hiveMemberHarnessScopes: vi.fn(() => ['hive-home']),
      loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'hive-home', harness_kind: 'hive' }] })),
    }));
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/db-org')>()),
      getOrgPg: () => ({
        db: {
          select: (cols: Record<string, unknown>) => {
            captured.cols = Object.keys(cols ?? {});
            return { from: () => ({ where: () => ({ orderBy: () => [] }) }) };
          },
        },
      }),
      generated: {
        harnessFeaturesConsolidatedInHarnessShared: {
          ...FAKE_COLS,
          featureId: 'c_fid',
          title: 'c_title',
          status: 'c_status',
          summary: 'c_summary',
          attempts: 'c_attempts',
          claims: 'c_claims',
          tags: 'c_tags',
          needsHumanReview: 'c_nhr',
          sourcePlanSlug: 'c_sps',
          workingUsers: 'c_wu',
        },
      },
    }));
    vi.doMock('drizzle-orm', async () => ({
      ...(await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')),
      inArray: (_col: unknown, values: string[]) => ({ __inArray: values }),
    }));

    const { resolveNamedQueryV2: r } = await import('./index');
    await r('featuresConsolidated.byHive', { potHomeSlug: 'hive-home' });

    // KEPT — exactly PotFeatureRow (PotContentPanel.tsx).
    expect(new Set(captured.cols)).toEqual(new Set(['harnessSlug', 'featureId', 'title', 'status', 'updatedTs']));
    // DROPPED — named individually so a regression says WHICH column came back.
    for (const gone of [
      'summary',
      'attempts',
      'claims',
      'tags',
      'needsHumanReview',
      'sourcePlanSlug',
      'workingUsers',
    ]) {
      expect(captured.cols, `${gone} must not be on the byHive wire`).not.toContain(gone);
    }
    // A bare `.select()` (the WI-5412 defect this read regressed into once already)
    // passes undefined — that must never read as "no columns captured, fine".
    expect(captured.cols.length).toBe(5);

    vi.doUnmock('../harness-registry');
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('drizzle-orm');
  });
});

describe('resolveNamedQueryV2 — plans.byHive (WI-259 P-006 cross-member plan rollup, D-010)', () => {
  it('lists plans across the resolved hive member-slugs via callPlansRead({ harness_slugs })', async () => {
    const actualRegistry = await vi.importActual<typeof import('../harness-registry')>('../harness-registry');
    const callPlansRead = vi.fn(async () => ({ plans: [{ slug: 'p1', harnessSlug: 'member-a' }] }));
    vi.doMock('../harness-registry', () => ({
      hiveMemberHarnessScopes: actualRegistry.hiveMemberHarnessScopes,
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [
          { slug: 'hive-home', harness_kind: 'hive' },
          { slug: 'member-a', hive_slug: 'hive-home' },
        ],
      })),
    }));
    vi.doMock('../agent-tools/plans/read-dispatch', () => ({ callPlansRead }));
    // Skip attribution enrichment (flag off) so the rows pass through unchanged.
    vi.doMock('@papercusp/flags/server', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
      getFlag: vi.fn(async () => false),
    }));

    const { resolveNamedQueryV2: r } = await import('./index');
    const out = (await r('plans.byHive', { potHomeSlug: 'hive-home' })) as unknown[];

    expect(out).toEqual([{ slug: 'p1', harnessSlug: 'member-a' }]);
    expect(callPlansRead).toHaveBeenCalledTimes(1);
    expect(callPlansRead).toHaveBeenCalledWith('list', { harness_slugs: ['hive-home', 'member-a'] });

    vi.doUnmock('../harness-registry');
    vi.doUnmock('../agent-tools/plans/read-dispatch');
    vi.doUnmock('@papercusp/flags/server');
  });

  it('is a registered query name', async () => {
    const { knownQueryNamesV2: k } = await import('./index');
    expect(k()).toContain('plans.byHive');
  });
});
