/**
 * Boot budget — guaranteed working room for every session
 * (agent-paperwork-and-restart-tax-reduction-2026-10-15 P-009 / R-9).
 *
 * A session's soft compaction limit must leave room to WORK after boot. Measured
 * 2026-10-15 over 561 Claude transcripts: an Opus fleet member (250k role cap)
 * booted at 134k median and up to 158k on a loop-fire wake, i.e. 53–63% of its
 * limit before its first work call, so a restart could be due almost immediately.
 *
 * The rule: a session's limit is at least the smallest 1k-rounded value that keeps
 * its measured boot size strictly below {@link BOOT_BUDGET_MAX_FRACTION} of it,
 * never above the model window's self-set ceiling (the hard safety bound — the
 * role cap is a spend default, not a safety ceiling).
 *
 * "Boot size" is the PROVIDER-EXACT prompt of the session's first request — the
 * gateway's observed input floor for the native session. It is NOT the bytes/4
 * transcript estimate, which omits the system prompt and tool schemas and so
 * reads ~60k low at boot.
 */
import {
  defaultCompactionLimitForWindow,
  selfSetCeilingForWindow,
} from './agent-config-constants';

/** A fresh session must read below this fraction of its limit before working. */
export const BOOT_BUDGET_MAX_FRACTION = 0.6;

/** Smallest 1k-rounded limit L with `bootTokens < BOOT_BUDGET_MAX_FRACTION × L`. */
export function bootBudgetRequiredLimit(bootTokens: number): number {
  if (!Number.isFinite(bootTokens) || bootTokens <= 0) return 0;
  return (Math.floor(bootTokens / BOOT_BUDGET_MAX_FRACTION / 1000) + 1) * 1000;
}

export interface BootBudgetInput {
  /** Provider-exact first-request prompt tokens; null when not yet observed. */
  bootTokens: number | null;
  /** Effective model window in tokens. */
  windowTokens: number;
  /** Non-leader member of a named fleet (shapes only the default, not the ceiling). */
  fleetMember?: boolean;
}

export interface BootBudgetResult {
  /** The limit to use: the derived default, raised to the boot budget when needed. */
  limit: number;
  /** The window-and-role derived default before the boot budget. */
  defaultLimit: number;
  /** The limit the boot budget alone requires (0 when boot is unknown). */
  required: number;
  /** The window's self-set ceiling — the boot budget never exceeds it. */
  ceiling: number;
  /** boot / limit, or null when boot is unknown. */
  bootFraction: number | null;
  /** True when the boot budget raised the limit above the default. */
  raised: boolean;
  /** False when even the ceiling cannot keep boot under the fraction. */
  satisfiable: boolean;
  /** True when the boot already reaches the default limit: not raised (see below). */
  overDefault: boolean;
}

/**
 * The compaction limit a non-explicit session should carry: the derived default,
 * raised so its measured boot stays below {@link BOOT_BUDGET_MAX_FRACTION} of it,
 * capped at the window's self-set ceiling.
 */
export function bootBudgetLimit(input: BootBudgetInput): BootBudgetResult {
  const fleetMember = input.fleetMember === true;
  const defaultLimit = defaultCompactionLimitForWindow(input.windowTokens, { fleetMember });
  const ceiling = selfSetCeilingForWindow(input.windowTokens, { fleetMember: false });
  const boot = input.bootTokens;
  if (boot == null || !Number.isFinite(boot) || boot <= 0) {
    return { limit: defaultLimit, defaultLimit, required: 0, ceiling, bootFraction: null, raised: false, satisfiable: true, overDefault: false };
  }
  const required = bootBudgetRequiredLimit(boot);
  // A first-request floor AT or ABOVE the role default is not a boot cost the budget
  // can trust: the gateway floor is total input, so it may hold reducible history (a
  // resumed transcript). Ordinary over-limit handling owns that session — raising its
  // limit would only postpone the cut that shrinks it. The budget closes the measured
  // gap: a session that boots BELOW its limit but with under 40% left to work in.
  if (boot >= defaultLimit) {
    return {
      limit: defaultLimit,
      defaultLimit,
      required,
      ceiling,
      bootFraction: boot / defaultLimit,
      raised: false,
      satisfiable: required <= ceiling,
      overDefault: true,
    };
  }
  const limit = Math.max(defaultLimit, Math.min(required, ceiling));
  return {
    limit,
    defaultLimit,
    required,
    ceiling,
    bootFraction: boot / limit,
    raised: limit > defaultLimit,
    satisfiable: required <= ceiling,
    overDefault: false,
  };
}

/** Whether a measured boot leaves the guaranteed working room under `limit`. */
export function bootHasWorkingRoom(bootTokens: number, limit: number): boolean {
  return Number.isFinite(bootTokens) && Number.isFinite(limit) && limit > 0 && bootTokens < BOOT_BUDGET_MAX_FRACTION * limit;
}
