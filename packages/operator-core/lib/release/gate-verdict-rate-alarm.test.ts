/**
 * P-003 (gate-verdict-liveness-and-repair-reliability-2026-08-31): the no-verdict RATE
 * alarm. Pure-evaluation coverage in both directions per limb, plus the SQL-shape and
 * derived-constant guards that keep it single-homed with classifyGateOutcomeStatus.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  evaluateVerdictRateAlarm,
  readVerdictRateWindow,
  VERDICT_RATE_MIN_FIRES,
  VERDICT_RATE_WINDOW_MS,
  SILENT_WINDOW_BUDGET_MULTIPLIER,
  type VerdictRateWindow,
} from './gate-verdict-rate-alarm';
import { classifyGateOutcomeStatus, VERDICT_BEARING_STATUSES } from './gate-fire-ledger';

const NOW = 1_756_000_000_000;
const BUDGET = 2 * 60 * 60 * 1000; // 2h suite budget

const win = (w: Partial<VerdictRateWindow>): VerdictRateWindow => ({
  fires: 0,
  verdicts: 0,
  lastVerdictBearingAtMs: NOW - 60_000,
  ...w,
});

describe('VERDICT_BEARING_STATUSES — derived, never hand-copied', () => {
  it('is exactly the statuses the single-homed classifier calls a verdict', () => {
    for (const s of VERDICT_BEARING_STATUSES) {
      expect(['verdict-green', 'verdict-red']).toContain(classifyGateOutcomeStatus(s));
    }
    // The four known verdict-bearing statuses are all present — losing one silently
    // blinds the silent-window clock to that verdict colour.
    for (const s of ['advanced', 'advanced-prefix', 'up-to-date', 'not-green']) {
      expect(VERDICT_BEARING_STATUSES).toContain(s);
    }
  });
});

describe('evaluateVerdictRateAlarm — the rate limb', () => {
  it('⭐ pages when >50% of fires in the window produced no verdict (27 fires → 3 verdicts)', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: 27, verdicts: 3 }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.alarmed).toBe(true);
    expect(v.reason).toBe('no-verdict-rate');
    expect(v.detail).toContain('3 of 27');
    expect(v.detail).toContain('do not triage failing tests');
  });

  it('does NOT page while the gate is GREEN — both limbs gate on red', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: false,
      window: win({ fires: 27, verdicts: 0, lastVerdictBearingAtMs: NOW - 100 * 3_600_000 }),
      suiteBudgetMs: BUDGET,
    });
    expect(v).toEqual({ alarmed: false, reason: null, detail: null });
  });

  it('a healthy red gate (verdicts keep landing) stays quiet', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: 6, verdicts: 5 }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.alarmed).toBe(false);
  });

  it('exactly 50% is NOT an alarm — the item says ">50% produced no verdict"', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: 6, verdicts: 3 }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.alarmed).toBe(false);
  });

  it(`fewer than ${VERDICT_RATE_MIN_FIRES} fires never alarm the rate limb — one bad fire is not a rate`, () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: VERDICT_RATE_MIN_FIRES - 1, verdicts: 0 }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.reason).not.toBe('no-verdict-rate');
  });

  it('pre-anchor installs (fires=0, the deploy-lag era) skip the rate limb instead of dividing by zero', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: 0, verdicts: 0 }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.reason).not.toBe('no-verdict-rate');
  });
});

describe('evaluateVerdictRateAlarm — the silent-window limb', () => {
  it(`⭐ pages when no verdict-BEARING row landed for ${SILENT_WINDOW_BUDGET_MULTIPLIER}x the suite budget while red`, () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: 0, verdicts: 0, lastVerdictBearingAtMs: NOW - (SILENT_WINDOW_BUDGET_MULTIPLIER * BUDGET + 60_000) }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.alarmed).toBe(true);
    expect(v.reason).toBe('silent-window');
    expect(v.detail).toContain('Recorded aborts do not feed this clock');
  });

  it('a verdict inside the budget window keeps it quiet', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: 0, verdicts: 0, lastVerdictBearingAtMs: NOW - BUDGET }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.alarmed).toBe(false);
  });

  it('no verdict EVER recorded ⇒ no reference point, no alarm (fresh-install rule)', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: 0, verdicts: 0, lastVerdictBearingAtMs: null }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.alarmed).toBe(false);
  });

  it('the rate limb WINS when both would fire — it carries the sharper evidence', () => {
    const v = evaluateVerdictRateAlarm({
      nowMs: NOW,
      gateRed: true,
      window: win({ fires: 10, verdicts: 0, lastVerdictBearingAtMs: NOW - 100 * 3_600_000 }),
      suiteBudgetMs: BUDGET,
    });
    expect(v.reason).toBe('no-verdict-rate');
  });
});

describe('readVerdictRateWindow — the one bounded read', () => {
  it.each([[], [{}], [{ fires: 0, verdicts: 0 }],
    [{ fires: 'bad', verdicts: 0, last_verdict_ms: null }],
    [{ fires: -1, verdicts: 0, last_verdict_ms: null }],
    [{ fires: 1, verdicts: 0, last_verdict_ms: 'bad' }]].map((rows) => ({ rows })))(
    'rejects an incomplete aggregate instead of manufacturing a recovered window (%j)', async ({ rows }) => {
      const sql = vi.fn(async () => rows) as unknown as Parameters<typeof readVerdictRateWindow>[0];
      await expect(readVerdictRateWindow(sql, { workspaceId: 'ws', installSlug: 'coverage' }))
        .rejects.toThrow('measurement is incomplete');
    },
  );
  const fakeSqlReturning = (row: Record<string, unknown>) => {
    const fn = vi.fn(async () => [row]);
    return fn as unknown as Parameters<typeof readVerdictRateWindow>[0];
  };

  it('parses counts + the newest verdict stamp, tolerating pg string-numerics', async () => {
    const sql = fakeSqlReturning({ fires: '27', verdicts: '3', last_verdict_ms: '1755990000000' });
    const w = await readVerdictRateWindow(sql, { workspaceId: 'ws', installSlug: 'papercusp' });
    expect(w).toEqual({ fires: 27, verdicts: 3, lastVerdictBearingAtMs: 1755990000000 });
  });

  it('a NULL max(created_at) (no verdict ever) comes back as null, never 0/NaN', async () => {
    const sql = fakeSqlReturning({ fires: 0, verdicts: 0, last_verdict_ms: null });
    const w = await readVerdictRateWindow(sql, { workspaceId: 'ws', installSlug: 'papercusp' });
    expect(w.lastVerdictBearingAtMs).toBeNull();
    expect(w.fires).toBe(0);
  });

  it('preserves fractional epoch milliseconds returned by extract(epoch)*1000', async () => {
    const sql = fakeSqlReturning({ fires: '6', verdicts: '6', last_verdict_ms: '1755990000000.123' });
    expect((await readVerdictRateWindow(sql, { workspaceId: 'ws', installSlug: 'coverage' }))
      .lastVerdictBearingAtMs).toBe(1755990000000.123);
  });

  it('binds the window to VERDICT_RATE_WINDOW_MS by default and passes the derived status list', async () => {
    const calls: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return [{ fires: 0, verdicts: 0, last_verdict_ms: null }];
      }),
      {},
    ) as unknown as Parameters<typeof readVerdictRateWindow>[0];
    await readVerdictRateWindow(sql, { workspaceId: 'ws', installSlug: 'papercusp' });
    const flat = JSON.stringify(calls);
    // The template-tag call carries the derived list and the window seconds as parameters.
    expect(flat).toContain(String(VERDICT_RATE_WINDOW_MS / 1000));
    for (const s of VERDICT_BEARING_STATUSES) expect(flat).toContain(s);
  });
});
