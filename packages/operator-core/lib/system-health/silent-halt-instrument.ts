/**
 * Silent-halt count as a scheduled rubric instrument (WI-6554700010018579; report
 * rpt_24408ef5-04d2-45ca-b56a-27ee3cca8c98 item #5, "measure it").
 *
 * The number is the population `silent-halt-reconcile` already judges: autonomous sessions
 * that hold actionable work, have their loop disarmed, and have nothing that can wake them.
 * This module does NOT re-derive "wake source". It runs the real sweep in dry-run mode, exactly
 * as `agent-strand-census.ts` does for the `agents-stranded` alarm, and counts its `halted`
 * list. A SQL re-statement of that verdict would be a second copy of a truth the sweep owns.
 *
 * The bar is the same as the alarm's: fewer than `AGENT_STRANDED_ALARM_THRESHOLD` halted
 * sessions passes. Keeping one constant means the rubric and the coordination-panel alarm can
 * never disagree about what "too many" is.
 *
 * A sweep that could not run reports `unknown`, never a pass at zero.
 *
 * Measured quantity, stated plainly: a point-in-time COUNT of halted autonomous holders. It is
 * not a per-turn share. The report's preferred share ("of machine-started turns under AUTO while
 * holding work, the fraction that end with nothing armed") would need a per-turn denominator
 * that no ledger records today; the report's own baseline is this count ("roughly the sweep's
 * 101").
 */
import { AGENT_STRANDED_ALARM_THRESHOLD, AGENT_STRAND_SAMPLE_SIZE } from './agent-strand-census';

export const SILENT_HALT_STRANDED_INSTRUMENT_KEY = 'agents:silent-halt-stranded';

/** Point-in-time instrument; the window only spaces re-measurements. */
export const SILENT_HALT_STRANDED_WINDOW_MS = 60 * 60_000;

export interface SilentHaltStrandedReading {
  /** Candidates the sweep read (autonomous sessions with an inactive loop row). */
  checked: number;
  /** Owners the sweep's verdict calls halted. */
  halted: string[];
  /** The subset whose only strand is a blocker park that names no wake. */
  wakeOnly: string[];
}

export interface SilentHaltStrandedDeps {
  /** Defaults to `sweepSilentHalts({ workspaceId, dryRun: true })`. */
  readSweep?: (workspaceId: string) => Promise<SilentHaltStrandedReading>;
}

/** Pure: turn one sweep reading (or a failed read) into the instrument verdict. */
export function silentHaltStrandedVerdict(
  reading: SilentHaltStrandedReading | null,
  failure?: string,
): { verdict: 'pass' | 'fail' | 'unknown'; detail: string; value?: number } {
  if (!reading) {
    return {
      verdict: 'unknown',
      detail: JSON.stringify({ unknown: failure ?? 'silent-halt sweep did not return a reading' }),
    };
  }
  const halted = [...new Set(reading.halted)].sort();
  const wakeOnly = [...new Set(reading.wakeOnly)].filter((o) => halted.includes(o));
  const stranded = halted.length;
  return {
    verdict: stranded < AGENT_STRANDED_ALARM_THRESHOLD ? 'pass' : 'fail',
    // The measured count, recorded as the ledger row's value in the instrument's 'count' unit.
    value: stranded,
    detail: JSON.stringify({
      stranded,
      wakeOnly: wakeOnly.length,
      checked: reading.checked,
      threshold: AGENT_STRANDED_ALARM_THRESHOLD,
      bar: `stranded < ${AGENT_STRANDED_ALARM_THRESHOLD}`,
      sample: halted.slice(0, AGENT_STRAND_SAMPLE_SIZE),
    }),
  };
}

async function defaultReadSweep(workspaceId: string): Promise<SilentHaltStrandedReading> {
  const { sweepSilentHalts } = await import('../harness/routines/silent-halt-reconcile');
  const result = await sweepSilentHalts({ workspaceId, dryRun: true });
  return { checked: result.checked, halted: result.halted, wakeOnly: result.wakeOnly };
}

/** Measure once. A thrown read becomes `unknown` with the error named. */
export async function measureSilentHaltStranded(
  window: { workspaceId: string },
  deps: SilentHaltStrandedDeps = {},
): Promise<{ verdict: 'pass' | 'fail' | 'unknown'; detail: string; value?: number }> {
  const readSweep = deps.readSweep ?? defaultReadSweep;
  try {
    return silentHaltStrandedVerdict(await readSweep(window.workspaceId));
  } catch (e) {
    return silentHaltStrandedVerdict(null, `silent-halt sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
