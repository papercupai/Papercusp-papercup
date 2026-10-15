import { describe, expect, it } from 'vitest';
import {
  BOOT_BUDGET_MAX_FRACTION,
  bootBudgetLimit,
  bootBudgetRequiredLimit,
  bootHasWorkingRoom,
} from './boot-budget';
import { defaultCompactionLimitForWindow, selfSetCeilingForWindow } from './agent-config-constants';

const WINDOW_1M = 1_000_000;
/** Codex rollout effective window (95% of the 272k model record). */
const WINDOW_CODEX = 258_400;

/**
 * Recorded boot sizes — provider-exact FIRST-request prompt tokens, measured
 * 2026-10-15 (P-009) over 3 days of transcripts: Claude from
 * `message.usage.iterations[0]` (561 sessions), Codex from per-request usage
 * rows (input + cached). Each entry is the WORST normal boot observed for that
 * client/model/role/kickoff cohort (max for small cohorts, p90 for the large
 * Codex cohorts), so passing here means the cohort's real boots fit.
 */
const RECORDED_BOOTS: Array<{ cohort: string; boot: number; window: number; fleetMember: boolean }> = [
  { cohort: 'claude opus-5.5 fleet member, self-compaction (n=176, max)', boot: 148_632, window: WINDOW_1M, fleetMember: true },
  { cohort: 'claude opus-5.5 fleet member, loop-fire (n=13, max)', boot: 157_719, window: WINDOW_1M, fleetMember: true },
  { cohort: 'claude opus-5.5 fleet member, watchdog (n=14, max)', boot: 145_416, window: WINDOW_1M, fleetMember: true },
  { cohort: 'claude opus-5.5 fleet member, fleet-kickoff (n=6, max)', boot: 136_082, window: WINDOW_1M, fleetMember: true },
  { cohort: 'claude opus-5.5 solo/leader, self-compaction (n=122, max)', boot: 150_151, window: WINDOW_1M, fleetMember: false },
  { cohort: 'claude opus-5.5 solo/leader, loop-fire (n=31, max)', boot: 149_249, window: WINDOW_1M, fleetMember: false },
  { cohort: 'claude fable-5.1 session-port (n=5, max)', boot: 156_357, window: WINDOW_1M, fleetMember: false },
  { cohort: 'codex gpt-6-luna interactive (n=5320, p90)', boot: 67_485, window: WINDOW_CODEX, fleetMember: true },
  { cohort: 'codex gpt-6.1-sol interactive (n=3071, p90)', boot: 70_494, window: WINDOW_CODEX, fleetMember: true },
  { cohort: 'codex gpt-5.6-sol judge (n=277, max)', boot: 29_116, window: WINDOW_CODEX, fleetMember: false },
];

describe('boot budget (R-9: guaranteed working room)', () => {
  it.each(RECORDED_BOOTS)('$cohort boots below 60% of its limit', ({ boot, window, fleetMember }) => {
    const r = bootBudgetLimit({ bootTokens: boot, windowTokens: window, fleetMember });
    expect(r.satisfiable).toBe(true);
    expect(bootHasWorkingRoom(boot, r.limit)).toBe(true);
    expect(boot / r.limit).toBeLessThan(BOOT_BUDGET_MAX_FRACTION);
    expect(r.limit).toBeLessThanOrEqual(selfSetCeilingForWindow(window, { fleetMember: false }));
  });

  it('the measured fleet-member violation is real at the old default and fixed by the budget', () => {
    const boot = 157_719;
    const oldDefault = defaultCompactionLimitForWindow(WINDOW_1M, { fleetMember: true });
    expect(bootHasWorkingRoom(boot, oldDefault)).toBe(false);
    const r = bootBudgetLimit({ bootTokens: boot, windowTokens: WINDOW_1M, fleetMember: true });
    expect(r.raised).toBe(true);
    expect(r.limit).toBe(263_000);
  });

  it('does not raise when the default already leaves room', () => {
    const r = bootBudgetLimit({ bootTokens: 67_485, windowTokens: WINDOW_CODEX, fleetMember: true });
    expect(r.raised).toBe(false);
    expect(r.limit).toBe(r.defaultLimit);
  });

  it('keeps the derived default when boot is unknown or invalid', () => {
    for (const bootTokens of [null, 0, -5, Number.NaN]) {
      const r = bootBudgetLimit({ bootTokens, windowTokens: WINDOW_1M, fleetMember: true });
      expect(r.limit).toBe(defaultCompactionLimitForWindow(WINDOW_1M, { fleetMember: true }));
      expect(r.raised).toBe(false);
      expect(r.bootFraction).toBeNull();
    }
  });

  it('caps at the self-set ceiling when the required limit exceeds it', () => {
    // On the Codex window the solo default already equals the self-set ceiling.
    const ceiling = selfSetCeilingForWindow(WINDOW_CODEX, { fleetMember: false });
    const defaultLimit = defaultCompactionLimitForWindow(WINDOW_CODEX, { fleetMember: false });
    const boot = defaultLimit - 1_000; // below the default, but 60% room needs > ceiling
    const r = bootBudgetLimit({ bootTokens: boot, windowTokens: WINDOW_CODEX });
    expect(r.required).toBeGreaterThan(ceiling);
    expect(r.limit).toBe(ceiling);
    expect(r.satisfiable).toBe(false);
  });

  it('never raises for a floor at or above the default (reducible history, e.g. a resume)', () => {
    // Mirrors the watchdog's "high total-input floor" contract: 396k floor on a 250k member.
    const r = bootBudgetLimit({ bootTokens: 396_171, windowTokens: WINDOW_1M, fleetMember: true });
    expect(r.overDefault).toBe(true);
    expect(r.raised).toBe(false);
    expect(r.limit).toBe(r.defaultLimit);
  });

  it('required limit is the smallest 1k step strictly above boot / 0.6', () => {
    expect(bootBudgetRequiredLimit(60_000)).toBe(101_000);
    expect(bootBudgetRequiredLimit(59_999)).toBe(100_000);
    expect(60_000 / bootBudgetRequiredLimit(60_000)).toBeLessThan(0.6);
    expect(bootBudgetRequiredLimit(0)).toBe(0);
  });
});
