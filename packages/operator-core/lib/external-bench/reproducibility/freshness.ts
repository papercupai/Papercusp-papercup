/**
 * Evidence freshness for frozen benchmark results (current-benchmark-modernization-2026-10-09 P-006,
 * BM-P-006-drift-freshness). A stored result is comparable CURRENT evidence for a study only while every
 * frozen protocol input it was produced under still matches that study's protocol. Any meaningful drift
 * (model, prompt, tools, runtime, grader, task set, seeds, context, exclusions, stopping, sampling, prices,
 * budgets or the arm roster) makes it STALE evidence. The comparison is derived from the frozen protocol
 * itself (every field except the run's own id), so a field added to the schema later is covered without
 * maintaining a hand-written list.
 */
import { canonicalJson } from './canonical-json';
import { currentProtocolFromConfig, type CurrentBenchmarkProtocol } from './schema';

export type ProtocolFreshnessStatus = 'current' | 'stale' | 'unknown';

export interface ProtocolFreshness {
  status: ProtocolFreshnessStatus;
  /** True only for `current`: the stored result may be pooled/compared as current evidence. */
  comparable: boolean;
  /** Sorted protocol paths that differ, e.g. `grader`, `taskIds`, `arms[papercusp].model`, `arms[papercusp].runtime.promptHash`. */
  driftFields: string[];
  /** Why freshness could not be measured (`unknown` only). */
  reason?: string;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const keysOf = (...values: object[]) => [...new Set(values.flatMap((value) => Object.keys(value)))].sort();

function diffArm(id: string, stored: CurrentBenchmarkProtocol['arms'][number], current: CurrentBenchmarkProtocol['arms'][number], out: string[]): void {
  for (const key of keysOf(stored, current)) {
    if (key === 'id') continue;
    const a = (stored as Record<string, unknown>)[key], b = (current as Record<string, unknown>)[key];
    if (key === 'runtime' && a && b && typeof a === 'object' && typeof b === 'object') {
      for (const field of keysOf(a, b))
        if (!same((a as Record<string, unknown>)[field], (b as Record<string, unknown>)[field])) out.push(`arms[${id}].runtime.${field}`);
    } else if (!same(a, b)) out.push(`arms[${id}].${key}`);
  }
}

/** Classify whether results frozen under `stored` are comparable current evidence for `current`. */
export function classifyProtocolFreshness(stored: CurrentBenchmarkProtocol, current: CurrentBenchmarkProtocol): ProtocolFreshness {
  const driftFields: string[] = [];
  for (const key of keysOf(stored, current)) {
    if (key === 'runId' || key === 'arms') continue;
    if (!same((stored as Record<string, unknown>)[key], (current as Record<string, unknown>)[key])) driftFields.push(key);
  }
  const storedArms = new Map(stored.arms.map((arm) => [arm.id, arm]));
  const currentArms = new Map(current.arms.map((arm) => [arm.id, arm]));
  if (!same([...storedArms.keys()].sort(), [...currentArms.keys()].sort())) driftFields.push('arms.roster');
  for (const [id, arm] of storedArms) {
    const other = currentArms.get(id);
    if (other) diffArm(id, arm, other, driftFields);
  }
  driftFields.sort();
  return driftFields.length === 0
    ? { status: 'current', comparable: true, driftFields }
    : { status: 'stale', comparable: false, driftFields };
}

/** Classify two pre-registered configs; a config that is not a current frozen protocol is never comparable. */
export function classifyPreregisteredFreshness(storedConfig: unknown, currentConfig: unknown): ProtocolFreshness {
  const asRecord = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const storedRecord = asRecord(storedConfig), currentRecord = asRecord(currentConfig);
  const stored = storedRecord ? currentProtocolFromConfig(storedRecord) : null;
  const current = currentRecord ? currentProtocolFromConfig(currentRecord) : null;
  if (!stored || !current)
    return { status: 'unknown', comparable: false, driftFields: [],
      reason: !stored ? 'stored result has no current frozen protocol' : 'comparison study has no current frozen protocol' };
  return classifyProtocolFreshness(stored, current);
}
