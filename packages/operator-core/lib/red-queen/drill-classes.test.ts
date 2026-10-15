/**
 * drill-classes.test.ts — the drill registry's ground truth and safety shape
 * (self-learning-frontier P-031 / FB-20).
 *
 * The load-bearing pins:
 *   - every class's expectedWatchdogKey matches what the REAL collector's pure
 *     signal builder would produce for the planted row (format drift between a
 *     drill's ground truth and the collector's keying = every drill fails as
 *     'undetected' — catch it here, not in the sandbox);
 *   - every plant/heal/cleanup statement is pinned to the SANDBOX workspace
 *     (the zero-leak partition);
 *   - drill stamping sets origin + the valid operator storage scope on every signal.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  circuitOpenSignalsFromRows,
  escalationSignalsFromRows,
  smokeFailSignalsFromRows,
  stuckPlanSignalsFromRows,
  watchdogKeyOf,
} from '../harness/improvements/watchdog';
import { DRILL_CLASSES, drillClassById, engineDeathSnapshot, stampDrillSignals } from './drill-classes';
import { detectRoutineEngineDeath } from './engine-death';
import { SANDBOX_HARNESS_SLUG, SANDBOX_WORKSPACE_ID } from './types';

/** Recording fake: a postgres tagged-template that logs text+params and returns []. */
function recordingSql() {
  const calls: { text: string; params: unknown[] }[] = [];
  const fn = (strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ text: strings.join('?'), params });
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as Sql, calls };
}

describe('the drill registry', () => {
  it('registers the five v1 classes with unique ids', () => {
    expect(DRILL_CLASSES.map((c) => c.id)).toEqual([
      'smoke-fail',
      'stuck-plan',
      'unresolved-escalation',
      'fire-circuit-open',
      'routine-engine-death',
    ]);
    expect(new Set(DRILL_CLASSES.map((c) => c.id)).size).toBe(DRILL_CLASSES.length);
    expect(drillClassById('smoke-fail')?.collectorFamily).toBe('smoke-fail');
    expect(drillClassById('routine-engine-death')?.collectorFamily).toBe('out-of-band');
  });
});

describe('ground-truth keys match the real collectors\' keying', () => {
  it('smoke-fail', async () => {
    const { sql } = recordingSql();
    const planted = await drillClassById('smoke-fail')!.plant(sql, { drillId: 'x' });
    const signals = smokeFailSignalsFromRows(
      [{ harness_slug: SANDBOX_HARNESS_SLUG, failure_content: 'x', mtime_ms: Date.now() }],
      {},
    );
    expect(signals).toHaveLength(1);
    expect(watchdogKeyOf(signals[0])).toBe(planted.expectedWatchdogKey);
  });

  it('stuck-plan', async () => {
    const { sql } = recordingSql();
    const planted = await drillClassById('stuck-plan')!.plant(sql, { drillId: 'x' });
    const signals = stuckPlanSignalsFromRows([
      { harness_slug: SANDBOX_HARNESS_SLUG, plan_slug: 'red-queen-drill-plan', status: 'started', stale_hours: 25 },
    ]);
    expect(signals).toHaveLength(1);
    expect(watchdogKeyOf(signals[0])).toBe(planted.expectedWatchdogKey);
  });

  it('unresolved-escalation', async () => {
    const { sql } = recordingSql();
    const planted = await drillClassById('unresolved-escalation')!.plant(sql, { drillId: 'x' });
    const signals = escalationSignalsFromRows([{ harness_slug: SANDBOX_HARNESS_SLUG, phase: 'staging' }]);
    expect(signals).toHaveLength(1);
    expect(watchdogKeyOf(signals[0])).toBe(planted.expectedWatchdogKey);
  });

  it('fire-circuit-open', async () => {
    const { sql } = recordingSql();
    const planted = await drillClassById('fire-circuit-open')!.plant(sql, { drillId: 'x' });
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: SANDBOX_HARNESS_SLUG, role: 'red-queen-drill-worker', consecutive_errors: 7, last_status: 'x' },
    ]);
    expect(signals).toHaveLength(1);
    expect(watchdogKeyOf(signals[0])).toBe(planted.expectedWatchdogKey);
  });

  it('routine-engine-death (the planted snapshot trips the real detector)', async () => {
    const { sql } = recordingSql();
    const cls = drillClassById('routine-engine-death')!;
    const planted = await cls.plant(sql, { drillId: 'x' });
    const snapshot = engineDeathSnapshot(Date.now());
    expect(detectRoutineEngineDeath(snapshot, Date.now()).dead).toBe(true);
    const collectors = cls.collectors(sql, planted, SANDBOX_WORKSPACE_ID);
    expect(collectors).toHaveLength(1);
    const res = await collectors[0].collect();
    const signals = Array.isArray(res) ? res : res.signals;
    expect(signals).toHaveLength(1);
    expect(watchdogKeyOf(signals[0])).toBe(planted.expectedWatchdogKey);
  });
});

describe('the sandbox partition (zero-leak by construction)', () => {
  const sqlClasses = DRILL_CLASSES.filter((c) => c.collectorFamily !== 'out-of-band');

  it.each(sqlClasses.map((c) => [c.id, c] as const))(
    '%s: every plant/heal/cleanup statement is pinned to the sandbox workspace',
    async (_id, cls) => {
      const { sql, calls } = recordingSql();
      const planted = await cls.plant(sql, { drillId: 'x' });
      await cls.heal(sql, planted);
      await cls.cleanup(sql, planted);
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const call of calls) {
        expect(call.params).toContain(SANDBOX_WORKSPACE_ID);
      }
    },
  );

  it('routine-engine-death plants NOTHING in substrate tables (the live engine would fire it)', async () => {
    const { sql, calls } = recordingSql();
    const cls = drillClassById('routine-engine-death')!;
    const planted = await cls.plant(sql, { drillId: 'x' });
    await cls.heal(sql, planted);
    await cls.cleanup(sql, planted);
    expect(calls).toHaveLength(0);
    expect(planted.payload?.snapshot).toBeTruthy();
  });

  it('a live-workspace collector sweep gets the UNstamped passthrough (assert-only leg)', async () => {
    const { sql } = recordingSql();
    const cls = drillClassById('smoke-fail')!;
    const planted = await cls.plant(sql, { drillId: 'x' });
    // The wrapper queries the live workspace (recording fake returns no rows)
    // and must not stamp drill provenance on whatever it returns.
    const collectors = cls.collectors(sql, planted, 'live-ws');
    const res = await collectors[0].collect();
    const signals = Array.isArray(res) ? res : res.signals;
    expect(signals).toEqual([]);
  });
});

describe('stampDrillSignals', () => {
  it('stamps origin=drill + the sandbox scope on every signal', () => {
    const stamped = stampDrillSignals([
      { source: 'smoke-fail', key: 'k', title: 't', body: 'b', severity: 'major' },
    ]);
    expect(stamped[0].origin).toBe('drill');
    expect(stamped[0].scope).toBe('operator');
  });
});

describe('engineDeathSnapshot', () => {
  it('is all-active, all-overdue — the incident signature by construction', () => {
    const now = Date.now();
    const snap = engineDeathSnapshot(now);
    expect(snap.length).toBeGreaterThanOrEqual(3);
    for (const r of snap) {
      expect(r.active).toBe(true);
      expect(Date.parse(String(r.nextFireAt))).toBeLessThan(now - 10 * 60_000);
    }
  });
});
