/**
 * learning-loop-read.test.ts — pins the production WIRING `readLearningLoopHealth`
 * passes to the pure classifier (`computeLearningLoopHealth` is mocked; its own
 * behavior is covered by learning-loop-health.test.ts).
 *
 * EI-19370813549389199: `routines.last_fired_at` is stamped at CLAIM time
 * (harness/routines/claim.ts), before the handler body runs — while Scout's
 * `scout_ticks` activity is only recorded once a REAL (non-gated) cycle completes,
 * which legitimately takes up to `DEFAULT_SCOUT_CYCLE_TIMEOUT_MS` (20min). The
 * generic 5min `activityLagGraceMs` default false-pages Scout as `stale` on almost
 * every fire while a cycle is still in flight (reproduced live: a fire read `stale`
 * with a 27min lag, then posted a normal `ran` tick 5min later). This test pins that
 * `readLearningLoopHealth` widens the grace to the cycle's own ceiling + a buffer
 * instead of the classifier's tight generic default.
 *
 * Run: cd packages/operator-core && npx vitest run lib/blueprint/learning-loop-read.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCOUT_CYCLE_TIMEOUT_MS } from '../scout/scheduler';

const h = vi.hoisted(() => ({
  routineRows: [] as unknown[],
  scoutTickRows: [] as unknown[],
  precisionRows: [] as unknown[] | Error,
  precisionFlagOn: true,
  routineQueryText: '',
}));

vi.mock('./seed-learning-singletons', () => ({
  LEARNING_SINGLETONS: [
    { blueprintId: 'scout', legacyRoutine: 'scout-legacy' },
    { blueprintId: 'memory-precision', legacyRoutine: 'memory-precision-bench' },
  ],
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => h.precisionFlagOn) }));
vi.mock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: vi.fn(() => 'acme-home') }));
vi.mock('./materialize-triggers', () => ({
  platformImprovementLoopsEnabled: vi.fn(async () => true),
  isPlatformImprovementLoop: vi.fn(() => false),
}));
vi.mock('./learning-loop-health', async (orig) => ({
  ...(await orig<typeof import('./learning-loop-health')>()),
  computeLearningLoopHealth: vi.fn(() => []),
}));

import { computeLearningLoopHealth } from './learning-loop-health';
const computeM = vi.mocked(computeLearningLoopHealth);
import { readLearningLoopHealth, PRECISION_ACTIVITY_GRACE_MS } from './learning-loop-read';
import { PRECISION_BENCH_WORKER_TIMEOUT_MS } from '../memory/bench/precision-read';

beforeEach(() => {
  vi.clearAllMocks();
  h.routineRows = [
    {
      install_slug: '@singleton',
      name: 'bp-singleton-scout-0',
      active: true,
      last_fired_at: new Date('2026-08-03T00:30:02.510Z'),
      next_fire_at: new Date('2026-08-03T01:00:00.000Z'),
      pause_review_by: null,
      last_pause_resumed_at_ms: null,
    },
  ];
  h.scoutTickRows = [{ last_tick_at: new Date('2026-08-03T00:12:10.846Z') }];
  h.precisionRows = [{ last_ran_at: new Date('2026-08-02T08:02:11.000Z') }];
  h.precisionFlagOn = true;
});

// Dual-shape sql mock: a tagged-template call (first arg has .raw) resolves the rows
// for the table its text names; sql([...]) IN-clause helper calls return an opaque
// fragment.
function fakeSql() {
  const fn = (first: unknown) => {
    const raw = (first as { raw?: readonly string[] } | null)?.raw;
    if (raw) {
      const text = raw.join('?');
      if (text.includes('memory_precision_bench')) {
        return h.precisionRows instanceof Error ? Promise.reject(h.precisionRows) : Promise.resolve(h.precisionRows);
      }
      if (text.includes('FROM harness_shared.routines')) h.routineQueryText = text;
      return Promise.resolve(text.includes('scout_ticks') ? h.scoutTickRows : h.routineRows);
    }
    return { __frag: first };
  };
  return fn as unknown as import('postgres').Sql;
}

type ActivityOpts = { activityByBlueprintId?: Record<string, Record<string, unknown>> };

describe('readLearningLoopHealth wiring', () => {
  it('widens activityLagGraceMs past the generic 5min default to cover a full Scout cycle', async () => {
    await readLearningLoopHealth(fakeSql(), 'ws-1', { nowMs: Date.parse('2026-08-03T00:35:33.291Z') });

    expect(computeM).toHaveBeenCalledTimes(1);
    const opts = computeM.mock.calls[0]![2] as { activityLagGraceMs?: number };
    expect(opts.activityLagGraceMs).toBeGreaterThanOrEqual(DEFAULT_SCOUT_CYCLE_TIMEOUT_MS);
    // Comfortably above the live-observed 27min false-positive lag.
    expect(opts.activityLagGraceMs).toBeGreaterThan(27 * 60_000);
  });

  it('forwards a sweep-supplied process start time while leaving pull-only reads unmasked', async () => {
    const processStartedAtMs = Date.parse('2026-08-03T00:00:00.000Z');
    await readLearningLoopHealth(fakeSql(), 'ws-1', { processStartedAtMs });
    expect((computeM.mock.calls[0]![2] as { processStartedAtMs?: number }).processStartedAtMs).toBe(
      processStartedAtMs,
    );

    await readLearningLoopHealth(fakeSql(), 'ws-1', {});
    expect((computeM.mock.calls[1]![2] as { processStartedAtMs?: number }).processStartedAtMs).toBeUndefined();
  });

  it('passes the live-observed lag shape (27min) as within the widened grace, not past it', async () => {
    await readLearningLoopHealth(fakeSql(), 'ws-1', { nowMs: Date.parse('2026-08-03T00:35:33.291Z') });
    const opts = computeM.mock.calls[0]![2] as { activityLagGraceMs?: number };
    const firedMs = Date.parse('2026-08-03T00:30:02.510Z');
    const activityMs = Date.parse('2026-08-03T00:12:10.846Z');
    expect(firedMs - activityMs).toBeLessThan(opts.activityLagGraceMs!);
  });

  it('passes the scout activity ledger through unchanged (regression guard)', async () => {
    await readLearningLoopHealth(fakeSql(), 'ws-1', {});
    const opts = computeM.mock.calls[0]![2] as {
      activityByBlueprintId?: Record<string, { lastActivityAt: string | null; source: string }>;
    };
    expect(opts.activityByBlueprintId?.scout).toEqual({
      lastActivityAt: '2026-08-03T00:12:10.846Z',
      source: 'scout_ticks',
    });
  });

  it('reads the durable resume timestamp and passes it to the classifier', async () => {
    const resumedAtMs = Date.parse('2026-08-03T00:20:00.000Z');
    h.routineRows = [
      {
        ...(h.routineRows[0] as Record<string, unknown>),
        last_pause_resumed_at_ms: String(resumedAtMs),
      },
    ];

    await readLearningLoopHealth(fakeSql(), 'ws-1', {});

    const routines = computeM.mock.calls[0]![1];
    expect(routines.find((row) => row.name === 'bp-singleton-scout-0')?.lastPauseResumedAtMs).toBe(resumedAtMs);
    expect(h.routineQueryText).toContain("metadata->'lastPause'->>'resumedAtMs'");
  });

  // WI-10004117: the weekly precision monitor fired with no bench row recorded and
  // nothing noticed. Its bench ledger now feeds the classifier in since-fire mode.
  it('passes the precision bench ledger in since-fire mode with a grace past one worker run', async () => {
    await readLearningLoopHealth(fakeSql(), 'ws-1', {});
    const opts = computeM.mock.calls[0]![2] as ActivityOpts;
    const precision = opts.activityByBlueprintId?.['memory-precision'] as Record<string, unknown> | undefined;
    expect(precision).toMatchObject({
      lastActivityAt: '2026-08-02T08:02:11.000Z',
      source: 'memory_precision_bench',
      mode: 'since-fire',
      graceMs: PRECISION_ACTIVITY_GRACE_MS,
    });
    // WI-10004133: the attempt ledger's account rides along (null when the fake has no attempt row).
    expect(Object.keys(precision ?? {}).sort()).toEqual(['detail', 'graceMs', 'lastActivityAt', 'mode', 'source']);
    expect(precision?.detail === null || typeof precision?.detail === 'string').toBe(true);
    expect(PRECISION_ACTIVITY_GRACE_MS).toBeGreaterThan(PRECISION_BENCH_WORKER_TIMEOUT_MS);
  });

  it('passes null activity when the bench ledger has no row, so a fired monitor pages', async () => {
    h.precisionRows = [{ last_ran_at: null }];
    await readLearningLoopHealth(fakeSql(), 'ws-1', {});
    const opts = computeM.mock.calls[0]![2] as ActivityOpts;
    expect(opts.activityByBlueprintId?.['memory-precision']?.lastActivityAt).toBeNull();
  });

  it('does not judge precision on activity while MEMORY_PRECISION_BENCH is off (flag-off records no row by design)', async () => {
    h.precisionFlagOn = false;
    await readLearningLoopHealth(fakeSql(), 'ws-1', {});
    const opts = computeM.mock.calls[0]![2] as ActivityOpts;
    expect(opts.activityByBlueprintId?.['memory-precision']).toBeUndefined();
    expect(opts.activityByBlueprintId?.scout).toBeDefined();
  });

  it('degrades to fire-only judging when the bench ledger read fails', async () => {
    h.precisionRows = new Error('relation "harness_shared.memory_precision_bench" does not exist');
    await readLearningLoopHealth(fakeSql(), 'ws-1', {});
    expect(computeM).toHaveBeenCalledTimes(1);
    const opts = computeM.mock.calls[0]![2] as ActivityOpts;
    expect(opts.activityByBlueprintId?.['memory-precision']).toBeUndefined();
  });
});
