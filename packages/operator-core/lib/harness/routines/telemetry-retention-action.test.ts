/**
 * Unit tests for `system:telemetry-retention` (infra-audit R2 / plan P-006).
 * The prune is mocked — we assert config resolution, the per-target retention
 * windows, the drain loop (re-call while `partial`), and dry-run propagation.
 *
 * EI-7482 (index-bloat maintenance): also covers the reindex-target resolver,
 * the weekly cadence gate, and `reindexBloatedIndexes` (tested directly with an
 * injected fake sql/guard — no real PG needed). The base retention tests default
 * `reindex_enabled:false` in `ctx()` so their behavior never depends on which
 * calendar day the suite happens to run on (the cadence default is Sunday UTC —
 * without this, a Sunday test run would exercise the live `@papercusp/db-org` /
 * `resource-lock-guard` dynamic imports for every pre-existing prune test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Mirrors the module-under-test's local `Sql` type (not exported) — the
 *  minimal postgres.js tagged-template shape `reindexBloatedIndexes` needs. */
type TestSql = {
  (strings: TemplateStringsArray, ...vals: unknown[]): Promise<Array<Record<string, unknown>>>;
  unsafe: (q: string) => Promise<Array<Record<string, unknown>>>;
};

const pruneMock = vi.fn();
vi.mock('../../storage/prune', () => ({
  pruneStorageCategory: (...args: unknown[]) => pruneMock(...args),
}));

const cleanupMock = vi.fn(async (_opts?: unknown) => ({
  expiredRows: 0,
  targetsFailed: 0,
  artifactsDeleted: 0,
  orphanArtifactsDeleted: 0,
  errors: 0,
}));
vi.mock('../../session-port/cleanup', () => ({
  cleanupExpiredSessionPorts: (...args: unknown[]) => cleanupMock(...args),
}));

const packageCacheRetentionMock = vi.fn(async (_opts?: unknown) => []);
vi.mock('../../storage/package-cache-retention', () => ({
  DEFAULT_PACKAGE_CACHE_MAX_BYTES: 8 * 1024 ** 3,
  runPackageCacheRetention: (...args: unknown[]) => packageCacheRetentionMock(...args),
}));

const sqlUnsafeMock = vi.fn(async (): Promise<Array<Record<string, unknown>>> => []);
const sqlTagMockFn = vi.fn(async (): Promise<Array<Record<string, unknown>>> => []);
const sqlTagMock = Object.assign(sqlTagMockFn, { unsafe: sqlUnsafeMock }) as unknown as TestSql;
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlTagMock }),
}));

const guardResourceMock = vi.fn(async (_spec: unknown, run: () => Promise<unknown>) => ({
  acquired: true,
  result: await run(),
  lock_id: 'lock-1',
}));
vi.mock('../../agent-tools/locks/resource-lock-guard', () => ({
  guardResource: (...args: [unknown, () => Promise<unknown>]) => guardResourceMock(...args),
}));

// Import AFTER the mocks so the module's registerSystemAction side-effect binds
// the mocked prune / db-org / resource-lock-guard.
import { getSystemAction } from './system-actions';
import {
  resolveTargets,
  DEFAULT_RETENTION_TARGETS,
  resolveReindexTargets,
  DEFAULT_REINDEX_TARGETS,
  shouldRunReindex,
  reindexBloatedIndexes,
  migrateColdArchives,
  type ReindexTarget,
} from './telemetry-retention-action';
import { buildTelemetryRetentionTriggerConfig } from './seed-telemetry-retention-routine';
import { DEFAULT_PACKAGE_CACHE_MAX_BYTES } from '../../storage/package-cache-retention';

const okResult = (over: Record<string, unknown> = {}) => ({
  ok: true,
  categoryId: 'x',
  dryRun: false,
  removed: 100,
  reclaimedBytes: 0,
  reclaimEstimated: true,
  vacuumed: true,
  partial: false,
  ...over,
});

const ctx = (triggerConfig: Record<string, unknown>) => ({
  installSlug: 'papercup',
  workspaceId: 'ws-1',
  // Default the reindex step OFF for tests that aren't exercising it — the
  // cadence gate defaults to "today is Sunday UTC", which would otherwise make
  // every pre-existing prune test's behavior depend on the real calendar day.
  triggerConfig: { reindex_enabled: false, ...triggerConfig },
  payloadTemplate: null,
});

describe('resolveTargets', () => {
  it('defaults to the durable-headroom horizons for local telemetry', () => {
    expect(resolveTargets({})).toEqual([...DEFAULT_RETENTION_TARGETS]);
    expect(resolveTargets({ targets: [] })).toEqual([...DEFAULT_RETENTION_TARGETS]);
  });

  // P-010/R-8: harness_run_output is a fully-registered prunable storage category
  // (packages/operator-core/lib/storage/categories.ts) that was never added to
  // DEFAULT_RETENTION_TARGETS, so the janitor never pruned it and it grew
  // unbounded (1.5GB/6,726 rows, oldest 56d, ~334 rows/day). Assert it's wired in
  // with the exact category id string categories.ts registers ('harness-run-output')
  // — a typo here silently no-ops (resolveTargets/pruneStorageCategory filter to
  // known categories).
  it('includes harness-run-output@30d in the default targets (P-010)', () => {
    expect(DEFAULT_RETENTION_TARGETS).toContainEqual({
      category: 'harness-run-output',
      retention_days: 30,
    });
  });

  // P-010/R-8: agent_activity is a local-diagnostic table with a durable horizon,
  // class (270MB, ~48K rows/day, unbounded) — a fully-registered storage
  // category (categories.ts id 'agent-activity') never wired into this default
  // target list. 7d matches its longest real reader lookback (fleet-ekg's
  // readSessionEvents, embedDays default 3d).
  it('includes agent-activity@30d in the default targets (P-010)', () => {
    expect(DEFAULT_RETENTION_TARGETS).toContainEqual({
      category: 'agent-activity',
      retention_days: 30,
    });
  });

  it('keeps the persisted seed targets in both-directions parity with runtime defaults', () => {
    const seeded = buildTelemetryRetentionTriggerConfig();
    expect(seeded.targets).toEqual([...DEFAULT_RETENTION_TARGETS]);
    expect(resolveTargets(seeded)).toEqual([...DEFAULT_RETENTION_TARGETS]);
    expect(seeded.targets).toContainEqual({
      category: 'memory-recall-query-text',
      retention_days: 3,
    });
  });

  it('honors a configured targets list + drops malformed entries', () => {
    const out = resolveTargets({
      targets: [
        { category: 'decision-ledger', retention_days: 30 },
        { retention_days: 5 }, // no category → dropped
      ],
    });
    expect(out).toEqual([{ category: 'decision-ledger', retention_days: 30 }]);
  });
});

describe('resolveReindexTargets (EI-7482)', () => {
  it('defaults to the audit-identified telemetry indexes plus every shared_presence index', () => {
    expect(resolveReindexTargets({})).toEqual([...DEFAULT_REINDEX_TARGETS]);
    expect(resolveReindexTargets({ reindex_indexes: [] })).toEqual([...DEFAULT_REINDEX_TARGETS]);
    expect(DEFAULT_REINDEX_TARGETS).toEqual(
      expect.arrayContaining([
        { schema: 'harness_shared', index: 'shared_presence_recent_idx' },
        { schema: 'harness_shared', index: 'shared_presence_pot_recent_idx' },
        { schema: 'harness_shared', index: 'shared_presence_fleet_recent_idx' },
        { schema: 'harness_shared', index: 'shared_presence_pkey' },
        { schema: 'harness_shared', index: 'shared_presence_user_idx' },
      ]),
    );
  });

  it('honors a configured index list + drops malformed entries', () => {
    const out = resolveReindexTargets({
      reindex_indexes: [
        { schema: 'harness_shared', index: 'some_other_idx' },
        { schema: 'harness_shared' }, // no index → dropped
        { index: 'no_schema_idx' }, // no schema → dropped
      ],
    });
    expect(out).toEqual([{ schema: 'harness_shared', index: 'some_other_idx' }]);
  });
});

describe('shouldRunReindex (EI-7482)', () => {
  const sunday = new Date('2026-07-05T12:00:00.000Z'); // getUTCDay() === 0
  const monday = new Date('2026-07-06T12:00:00.000Z'); // getUTCDay() === 1

  it('defaults to the Sunday-UTC weekly cadence', () => {
    expect(shouldRunReindex({}, sunday)).toBe(true);
    expect(shouldRunReindex({}, monday)).toBe(false);
  });

  it('honors a configured reindex_day_of_week', () => {
    expect(shouldRunReindex({ reindex_day_of_week: 1 }, monday)).toBe(true);
    expect(shouldRunReindex({ reindex_day_of_week: 1 }, sunday)).toBe(false);
  });

  it('reindex_now forces a run regardless of cadence', () => {
    expect(shouldRunReindex({ reindex_now: true }, monday)).toBe(true);
  });

  it('reindex_enabled:false disables the step even on the matching day (and even with reindex_now)', () => {
    expect(shouldRunReindex({ reindex_enabled: false }, sunday)).toBe(false);
    expect(shouldRunReindex({ reindex_enabled: false, reindex_now: true }, sunday)).toBe(false);
  });
});

describe('reindexBloatedIndexes (EI-7482)', () => {
  const target: ReindexTarget = { schema: 'harness_shared', index: 'route_invocations_ws_time_idx' };

  function fakeSql(staleRows: Array<Record<string, unknown>> = []) {
    const unsafe = vi.fn(async (): Promise<Array<Record<string, unknown>>> => []);
    const tagFn = vi.fn(async (): Promise<Array<Record<string, unknown>>> => staleRows);
    const sql = Object.assign(tagFn, { unsafe }) as unknown as TestSql;
    return { sql, unsafe };
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('issues REINDEX INDEX CONCURRENTLY for a well-formed target under an acquired guard', async () => {
    const { sql, unsafe } = fakeSql();
    const guard = vi.fn(async (_reason: string, run: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await run(),
    }));
    await reindexBloatedIndexes([target], sql, guard);

    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls[0][0]).toContain('REINDEX CONCURRENTLY harness_shared.route_invocations_ws_time_idx');
    expect(unsafe).toHaveBeenCalledWith('REINDEX INDEX CONCURRENTLY harness_shared.route_invocations_ws_time_idx');
  });

  it('drops a leftover invalid _ccnew index before reindexing', async () => {
    const { sql, unsafe } = fakeSql([{ name: 'route_invocations_ws_time_idx_ccnew' }]);
    const guard = vi.fn(async (_reason: string, run: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await run(),
    }));
    await reindexBloatedIndexes([target], sql, guard);

    expect(unsafe).toHaveBeenNthCalledWith(
      1,
      'DROP INDEX CONCURRENTLY IF EXISTS harness_shared.route_invocations_ws_time_idx_ccnew',
    );
    expect(unsafe).toHaveBeenNthCalledWith(
      2,
      'REINDEX INDEX CONCURRENTLY harness_shared.route_invocations_ws_time_idx',
    );
  });

  it('ignores a stale-index row that fails identifier validation (never interpolates it)', async () => {
    const { sql, unsafe } = fakeSql([{ name: 'not an identifier; DROP TABLE x' }]);
    const guard = vi.fn(async (_reason: string, run: () => Promise<unknown>) => ({
      acquired: true as const,
      result: await run(),
    }));
    await reindexBloatedIndexes([target], sql, guard);

    // Only the final REINDEX call — no DROP INDEX for the unsafe name.
    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(unsafe).toHaveBeenCalledWith('REINDEX INDEX CONCURRENTLY harness_shared.route_invocations_ws_time_idx');
  });

  it('skips a target with an invalid schema/index identifier without touching sql or guard', async () => {
    const { sql, unsafe } = fakeSql();
    const guard = vi.fn();
    await reindexBloatedIndexes([{ schema: 'harness_shared; DROP TABLE x', index: 'y' }], sql, guard);
    expect(guard).not.toHaveBeenCalled();
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('logs (not throws) when the guard fails to acquire the lock', async () => {
    const { sql, unsafe } = fakeSql();
    const guard = vi.fn(async () => ({ acquired: false as const, reason: 'held_shared' }));
    await expect(reindexBloatedIndexes([target], sql, guard)).resolves.toBeUndefined();
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('logs (not throws) when the guarded run rejects, and continues to the next target', async () => {
    const { sql } = fakeSql();
    const other: ReindexTarget = { schema: 'harness_shared', index: 'tool_invocations_quota_idx' };
    const guard = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ acquired: true, result: true });
    await expect(reindexBloatedIndexes([target, other], sql, guard)).resolves.toBeUndefined();
    expect(guard).toHaveBeenCalledTimes(2);
  });
});

describe('system:telemetry-retention action', () => {
  beforeEach(() => {
    pruneMock.mockReset();
    sqlUnsafeMock.mockReset().mockResolvedValue([]);
    sqlTagMockFn.mockReset().mockResolvedValue([]);
    guardResourceMock.mockClear();
    cleanupMock.mockClear();
    packageCacheRetentionMock.mockReset().mockResolvedValue([]);
    // The action logs warn() on the invalid/failed-prune branches exercised below;
    // the repo's vitest-fail-on-console treats an un-mocked warn as a failure, so
    // capture it (the real assertions are on pruneMock / non-throwing).
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs bounded cold-archive migration through the existing archive store', async () => {
    const readStamp = vi.fn(async () => null);
    const store = { readStamp, readFiles: vi.fn() } as never;
    await expect(migrateColdArchives({
      candidates: [
        { source_kind: 'codex', session_id: 'sid-1' },
        { source_kind: 'codex', session_id: 'sid-2' },
      ],
      maxArchives: 1,
      store,
    })).resolves.toEqual({ scanned: 1, migrated: 0, failed: 0 });
    expect(readStamp).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a store cannot delete its PG rows', async () => {
    const store = {
      readStamp: vi.fn(async () => ({
        workspace_id: 'default', source_kind: 'codex', session_id: 'sid-1',
        owner: null, harness_slug: null, cwd: null, adv_session_id: null,
        session_root: '/tmp', file_count: 1, bytes_raw: 1, bytes_stored: 1,
        manifest: [{ relpath: 'rollout.jsonl', sha256: '0'.repeat(64), bytes_raw: 1 }], archived_by: null,
      })),
      readFiles: vi.fn(async () => []),
    } as never;
    await expect(migrateColdArchives({
      candidates: [{ source_kind: 'codex', session_id: 'sid-1' }],
      store,
    })).resolves.toEqual({ scanned: 1, migrated: 0, failed: 1 });
  });

  it('prunes each default target with its retention window + workspace', async () => {
    pruneMock.mockResolvedValue(okResult());
    const action = getSystemAction('telemetry-retention');
    expect(action).toBeTypeOf('function');
    await action!(ctx({}));

    expect(pruneMock).toHaveBeenCalledTimes(5);
    expect(cleanupMock).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    expect(packageCacheRetentionMock).toHaveBeenCalledWith({
      dryRun: false,
      maxBytes: DEFAULT_PACKAGE_CACHE_MAX_BYTES,
    });
    expect(pruneMock).toHaveBeenNthCalledWith(1, {
      categoryId: 'route-invocations',
      olderThanDays: 30,
      dryRun: false,
      workspaceId: 'ws-1',
    });
    expect(pruneMock).toHaveBeenNthCalledWith(2, {
      categoryId: 'tool-invocations',
      olderThanDays: 30,
      dryRun: false,
      workspaceId: 'ws-1',
    });
    expect(pruneMock).toHaveBeenNthCalledWith(3, {
      categoryId: 'harness-run-output',
      olderThanDays: 30,
      dryRun: false,
      workspaceId: 'ws-1',
    });
    expect(pruneMock).toHaveBeenNthCalledWith(4, {
      categoryId: 'agent-activity',
      olderThanDays: 30,
      dryRun: false,
      workspaceId: 'ws-1',
    });
    // WI-37403: the recall query-text window. The ONLY default target holding
    // agent-authored text, hence the shortest window — asserted by NAME and by
    // its 3d window, not merely counted, because a bumped count would pass just
    // as well if this target silently stopped being pruned.
    expect(pruneMock).toHaveBeenNthCalledWith(5, {
      categoryId: 'memory-recall-query-text',
      olderThanDays: 3,
      dryRun: false,
      workspaceId: 'ws-1',
    });
    // reindex_enabled:false (the ctx() default) — the reindex path never fires.
    expect(guardResourceMock).not.toHaveBeenCalled();
  });

  it('persists default-on package-cache retention config and honors its action knobs', async () => {
    const seeded = buildTelemetryRetentionTriggerConfig();
    expect(seeded).toMatchObject({
      package_cache_enabled: true,
      package_cache_max_bytes: DEFAULT_PACKAGE_CACHE_MAX_BYTES,
    });

    pruneMock.mockResolvedValue(okResult());
    const action = getSystemAction('telemetry-retention');
    await action!(
      ctx({
        dry_run: true,
        package_cache_max_bytes: 1234,
      }),
    );
    expect(packageCacheRetentionMock).toHaveBeenCalledWith({ dryRun: true, maxBytes: 1234 });

    packageCacheRetentionMock.mockClear();
    await action!(ctx({ package_cache_enabled: false }));
    expect(packageCacheRetentionMock).not.toHaveBeenCalled();
  });

  it('contains an unexpected package-cache retention failure', async () => {
    pruneMock.mockResolvedValue(okResult());
    packageCacheRetentionMock.mockRejectedValue(new Error('cache scan failed'));
    const action = getSystemAction('telemetry-retention');

    await expect(action!(ctx({}))).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('package-cache retention failed — cache scan failed'),
    );
  });

  it('drains a category: re-calls while the prune reports partial', async () => {
    pruneMock
      .mockResolvedValueOnce(okResult({ partial: true }))
      .mockResolvedValueOnce(okResult({ partial: true }))
      .mockResolvedValueOnce(okResult({ partial: false }));
    const action = getSystemAction('telemetry-retention');
    await action!(ctx({ targets: [{ category: 'route-invocations', retention_days: 7 }] }));
    expect(pruneMock).toHaveBeenCalledTimes(3); // looped until partial cleared
  });

  it('dry_run propagates and never loops past one call', async () => {
    pruneMock.mockResolvedValue(okResult({ dryRun: true, partial: true }));
    const action = getSystemAction('telemetry-retention');
    await action!(ctx({ dry_run: true, targets: [{ category: 'route-invocations', retention_days: 7 }] }));
    expect(pruneMock).toHaveBeenCalledTimes(1); // dry-run stops after one call despite partial
    expect(pruneMock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('skips a target with invalid retention_days without throwing', async () => {
    pruneMock.mockResolvedValue(okResult());
    const action = getSystemAction('telemetry-retention');
    await action!(ctx({ targets: [{ category: 'route-invocations', retention_days: -1 }] }));
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it('stops a target on prune failure (ok:false) without throwing', async () => {
    pruneMock.mockResolvedValue({ ok: false, reason: 'invalid_category', removed: 0 });
    const action = getSystemAction('telemetry-retention');
    await expect(action!(ctx({ targets: [{ category: 'bogus', retention_days: 7 }] }))).resolves.toBeUndefined();
    expect(pruneMock).toHaveBeenCalledTimes(1);
  });

  // EI-7482: wiring — the registered action actually reaches reindexBloatedIndexes
  // (via the real db-org/resource-lock-guard dynamic imports, mocked above) when
  // forced on, and stays fully off by default in this suite's ctx().
  it('reindex_now:true reaches the guarded REINDEX path through the real action', async () => {
    pruneMock.mockResolvedValue(okResult());
    const action = getSystemAction('telemetry-retention');
    await action!(ctx({ targets: [], reindex_enabled: true, reindex_now: true }));

    expect(guardResourceMock).toHaveBeenCalledTimes(DEFAULT_REINDEX_TARGETS.length);
    for (const [lockSpec] of guardResourceMock.mock.calls) {
      expect(lockSpec).toMatchObject({ resource: 'db-schema' });
    }
    expect(sqlUnsafeMock).toHaveBeenCalledWith(expect.stringContaining('REINDEX INDEX CONCURRENTLY harness_shared.'));
  });

  it('dry_run logs the plan and never reaches guardResource even when the cadence matches', async () => {
    pruneMock.mockResolvedValue(okResult());
    const action = getSystemAction('telemetry-retention');
    await action!(ctx({ targets: [], dry_run: true, reindex_enabled: true, reindex_now: true }));
    expect(guardResourceMock).not.toHaveBeenCalled();
  });
});
