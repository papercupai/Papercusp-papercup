/** P-003: pure decisions over independent, windowed eligibility/output ledgers. */
export const LIVENESS_WINDOW_MS = 7 * 86_400_000;
export const DELIVERY_FLOOR = 0.05;
export const CAPTURE_FLOOR = 0.8;

export interface SignalMeasurement {
  signal: string;
  kind: 'push' | 'op' | 'symbol-capture';
  enabled: boolean;
  windowStart: number;
  windowEnd: number;
  /** Unknown counts are null, never zero. */
  eligible: number | null;
  outputs: number | null;
  outsideLineageOutputs: number | null;
  eligibleLineages?: number | null;
  /** Disclosure denominator includes Bash-attributed tracked mutations. */
  allTrackedMutations?: number | null;
  eligibleMutations?: number | null;
}
export type SignalStatus = 'off' | 'cannot-observe' | 'insufficient-data' | 'healthy' | 'alarm';
export interface SignalVerdict {
  signal: string;
  status: SignalStatus;
  reason: string;
  eligible: number | null;
  outputs: number | null;
  ratio: number | null;
  mutationShare: number | null;
  windowStart: number;
  windowEnd: number;
}
function count(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}
/** Apply the same boundary to eligibility AND outputs. */
export function livenessWindowStart(now: number, enabledAt: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(enabledAt) || enabledAt > now)
    throw new Error('Liveness requires a measured flag-on time at or before now');
  return Math.max(now - LIVENESS_WINDOW_MS, enabledAt);
}
export function evaluateSignal(m: SignalMeasurement): SignalVerdict {
  const ratio = count(m.eligible) && m.eligible > 0 && count(m.outputs) ? m.outputs / m.eligible : null;
  const mutationShare = count(m.eligibleMutations) && count(m.allTrackedMutations)
    && m.allTrackedMutations > 0 && m.eligibleMutations <= m.allTrackedMutations
    ? m.eligibleMutations / m.allTrackedMutations : null;
  const result = (status: SignalStatus, reason: string): SignalVerdict => ({
    signal: m.signal, status, reason, eligible: m.eligible, outputs: m.outputs,
    ratio, mutationShare, windowStart: m.windowStart, windowEnd: m.windowEnd,
  });
  if (!m.enabled) return result('off', 'Disabled; alarm disposition requires the recorded reason.');
  if (!Number.isFinite(m.windowStart) || !Number.isFinite(m.windowEnd)
    || m.windowStart >= m.windowEnd || !count(m.eligible) || !count(m.outputs))
    return result('cannot-observe', 'Eligibility, output or window could not be measured.');
  if (m.eligible === 0) return result('insufficient-data', 'No eligible triggers in this window.');
  if (m.kind === 'symbol-capture') {
    if (!count(m.eligibleLineages)) return result('cannot-observe', 'Eligible spawn lineages are unmeasured.');
    if (m.eligible < 500 || m.eligibleLineages < 3)
      return result('insufficient-data', 'Requires 500 eligible edits from 3 outside lineages.');
    if (m.outputs > m.eligible) return result('cannot-observe', 'Captured edits exceed eligible edits.');
    if (ratio! < CAPTURE_FLOOR) return result('alarm', 'Captured share is below 0.80.');
  } else {
    if (m.outputs === 0) return result('alarm', 'Eligible triggers produced zero measured outputs.');
    if (m.kind === 'push' && ratio! < DELIVERY_FLOOR)
      return result('alarm', 'Delivered/eligible is below 0.05.');
  }
  if (!count(m.outsideLineageOutputs)) return result('cannot-observe', 'Output lineage is unmeasured.');
  if (m.outsideLineageOutputs === 0)
    return result('insufficient-data', 'No output outside the implementer spawn lineage.');
  return result('healthy', 'Output meets the signal floor with outside-lineage evidence.');
}
export function evaluateLiveness(inputs: readonly SignalMeasurement[]): SignalVerdict[] {
  const seen = new Set<string>();
  for (const m of inputs) {
    if (seen.has(m.signal)) throw new Error('Duplicate liveness signal: ' + m.signal);
    seen.add(m.signal);
  }
  const results = inputs.map(evaluateSignal);
  const on = inputs.filter(m => m.kind === 'push' && m.enabled);
  // An entirely silent week is a detector failure. Unknown does not prove zero.
  if (on.length && on.every(m => m.eligible === 0 && count(m.outputs)
    && Number.isFinite(m.windowStart) && Number.isFinite(m.windowEnd)
    && m.windowEnd - m.windowStart >= LIVENESS_WINDOW_MS)) {
    results.push({
      signal: 'push-population', status: 'alarm',
      reason: 'Every ON push leg had zero eligible triggers over 7 days.',
      eligible: 0, outputs: on.reduce((sum, m) => sum + m.outputs!, 0),
      ratio: null, mutationShare: null,
      windowStart: Math.max(...on.map(m => m.windowStart)),
      windowEnd: Math.min(...on.map(m => m.windowEnd)),
    });
  }
  return results;
}
export interface ScheduledSignalRun {
  sequence: number;
  scheduledAt: number;
  succeeded: boolean;
  verdict: SignalVerdict;
}
/** One good tick, manual checks, or pre-fix traffic cannot dispose an alarm. */
export function sustainedRecovery(runs: readonly ScheduledSignalRun[], fixedAt: number): boolean {
  const ordered = [...runs].sort((a, b) => a.sequence - b.sequence);
  const a = ordered.at(-2), b = ordered.at(-1);
  if (!a || !b || !Number.isFinite(fixedAt) || !Number.isSafeInteger(a.sequence)
    || a.sequence < 0 || b.sequence !== a.sequence + 1 || !a.succeeded || !b.succeeded
    || !Number.isFinite(a.scheduledAt) || !Number.isFinite(b.scheduledAt)
    || b.scheduledAt - a.scheduledAt < 48 * 3_600_000) return false;
  return [a, b].every(r => r.scheduledAt >= fixedAt && r.verdict.signal === b.verdict.signal
    && r.verdict.status === 'healthy' && r.verdict.windowStart >= fixedAt
    && r.verdict.windowEnd <= r.scheduledAt && count(r.verdict.eligible) && r.verdict.eligible > 0
    && r.verdict.ratio !== null && r.verdict.ratio >= DELIVERY_FLOOR);
}
