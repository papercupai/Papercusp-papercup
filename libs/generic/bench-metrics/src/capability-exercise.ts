/**
 * capability-exercise.ts — observed capability AVAILABILITY / DELIVERY / USE evidence per row, and the
 * admission rule that gates a capability LIFT claim on it (fairness C4; plan
 * current-benchmark-modernization-2026-10-09 P-004 spec BM-P-004-exercise-evidence; companion
 * benchmark-coverage-frontierswe-v2-2026-10-10#D-018).
 *
 * The trap this closes: a "+capability" arm beats its control, but the capability was never delivered to
 * the agent or never used — the delta is variance (or a different solver), not that capability. A label
 * ("this arm has memory on") or a bare zero counter is NOT evidence. Each row therefore carries, per
 * capability, three SEPARATE measurements, each of which may be explicitly unmeasured (`null`):
 *
 *   available — was the capability actually reachable by the agent in this assignment?
 *   delivered — how many capability inputs reached the agent (injected memory refs, carry notes,
 *               accepted cross-agent deliveries, consult answers, ...)?
 *   used      — how many agent-originated actions exercised it (searches, claims, sends, consults, ...)?
 *
 * The evidence rides the existing persisted `TaskRunResult.armMeta` jsonb under
 * {@link CAPABILITY_EVIDENCE_META_KEY} (no new column); {@link readCapabilityEvidence} is the one typed
 * reader. Domain-free: capability ids are opaque strings.
 */
import type { ArmId, TaskRunResult } from './schema';

/** One capability's observed evidence for one row (task × arm × seed). `null` = explicitly unmeasured. */
export interface CapabilityExerciseEvidence {
  capability: string;
  available: boolean | null;
  delivered: number | null;
  used: number | null;
  /** Receipt pointers (tool-invocation ids, delivery ids, ...) backing the counts. */
  refs?: string[];
}

/** The `armMeta` key the evidence is persisted under. */
export const CAPABILITY_EVIDENCE_META_KEY = 'capabilityEvidence';

const isCount = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0);

function parseEvidence(value: unknown): CapabilityExerciseEvidence | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (typeof e.capability !== 'string' || e.capability.trim() === '') return null;
  if (!(e.available === null || typeof e.available === 'boolean')) return null;
  if (!isCount(e.delivered) || !isCount(e.used)) return null;
  const refs = Array.isArray(e.refs) ? e.refs.filter((r): r is string => typeof r === 'string' && r.length > 0) : undefined;
  return { capability: e.capability, available: e.available, delivered: e.delivered, used: e.used, ...(refs && refs.length > 0 ? { refs } : {}) };
}

/** Read a row's capability evidence. Malformed entries are DROPPED (they read as unmeasured, never as zero). */
export function readCapabilityEvidence(row: Pick<TaskRunResult, 'armMeta'>): CapabilityExerciseEvidence[] {
  const raw = row.armMeta?.[CAPABILITY_EVIDENCE_META_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.map(parseEvidence).filter((e): e is CapabilityExerciseEvidence => e !== null);
}

const sumOrNull = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

/**
 * Merge per-agent evidence into one per-capability record (e.g. every solver + the judge of one task).
 * Pass ONE part per contributing agent. A count is only known when EVERY contributor measured it: a
 * contributor that reported nothing (`null`/`undefined` part) or omitted a capability another contributor
 * reported counts as unmeasured for it, so the total is `null`, never a partial sum read as complete.
 * `available` is true when any contributor had it, else unknown if any contributor did not measure it,
 * else false. A capability no contributor reported is absent from the result (unmeasured).
 */
export function mergeCapabilityEvidence(
  parts: ReadonlyArray<ReadonlyArray<CapabilityExerciseEvidence> | null | undefined>,
): CapabilityExerciseEvidence[] {
  const capabilities = new Set<string>();
  for (const list of parts) for (const e of list ?? []) capabilities.add(e.capability);
  return [...capabilities].map((capability) => {
    let available: boolean | null = false;
    let delivered: number | null = 0;
    let used: number | null = 0;
    const refs: string[] = [];
    for (const list of parts) {
      const entries = (list ?? []).filter((e) => e.capability === capability);
      if (entries.length === 0) {
        delivered = null; used = null;
        if (available !== true) available = null;
        continue;
      }
      for (const e of entries) {
        available = available === true || e.available === true ? true
          : available === null || e.available === null ? null : false;
        delivered = sumOrNull(delivered, e.delivered);
        used = sumOrNull(used, e.used);
        refs.push(...(e.refs ?? []));
      }
    }
    return { capability, available, delivered, used, ...(refs.length > 0 ? { refs } : {}) };
  });
}

/** Return `armMeta` with the evidence attached (an empty list leaves `armMeta` unchanged). */
export function withCapabilityEvidence(
  armMeta: Record<string, unknown> | null | undefined,
  evidence: ReadonlyArray<CapabilityExerciseEvidence>,
): Record<string, unknown> | null {
  if (evidence.length === 0) return armMeta ?? null;
  return { ...(armMeta ?? {}), [CAPABILITY_EVIDENCE_META_KEY]: evidence.map((e) => ({ ...e })) };
}

export type ExerciseClass = 'exercised' | 'unexercised' | 'unknown';

/** exercised = available AND delivered > 0 AND used > 0; unknown = missing or any field unmeasured. */
export function classifyExercise(evidence: CapabilityExerciseEvidence | undefined): ExerciseClass {
  if (!evidence || evidence.available === null || evidence.delivered === null || evidence.used === null) return 'unknown';
  return evidence.available && evidence.delivered > 0 && evidence.used > 0 ? 'exercised' : 'unexercised';
}

/** Why a lift claim was refused. Several may apply at once. */
export type LiftRefusal =
  | 'no-treatment-rows'
  | 'treatment-evidence-unknown'
  | 'treatment-never-exercised'
  | 'control-evidence-unknown'
  | 'control-leak';

/** The admission verdict for one claimed capability of one treatment arm over its control. */
export interface CapabilityLiftAdmission {
  capability: string;
  treatmentArm: ArmId;
  controlArm: ArmId;
  /** TRUE only when every refusal check passes — the ONLY state in which a lift may be attributed. */
  admitted: boolean;
  refusals: LiftRefusal[];
  /** Generation-completed treatment rows, classified (an infra row ran nothing and is not counted). */
  treatment: { rows: number; exercised: number; unexercised: number; unknown: number };
  /** Generation-completed control rows: `leaked` delivered or used the capability that must be OFF. */
  control: { rows: number; clean: number; leaked: number; unknown: number };
}

const generated = (r: TaskRunResult): boolean => r.generationStatus !== 'error' && r.generationStatus !== 'timeout';
const evidenceFor = (r: TaskRunResult, capability: string) => readCapabilityEvidence(r).find((e) => e.capability === capability);

/**
 * Admit (or refuse) a capability lift claim. Treatment: every generation-completed row must carry
 * measured evidence, and at least one must show delivery AND use (an unused capability supports no
 * attribution). Control: every generation-completed row must be MEASURED as off — zero delivery and
 * zero use. A label or an absent counter never admits.
 */
export function admitCapabilityLift(
  rows: readonly TaskRunResult[],
  claim: { capability: string; treatmentArm: ArmId; controlArm: ArmId },
): CapabilityLiftAdmission {
  const treatment = { rows: 0, exercised: 0, unexercised: 0, unknown: 0 };
  const control = { rows: 0, clean: 0, leaked: 0, unknown: 0 };
  for (const r of rows) {
    if (!generated(r)) continue;
    if (r.arm === claim.treatmentArm) {
      treatment.rows += 1;
      treatment[classifyExercise(evidenceFor(r, claim.capability))] += 1;
    } else if (r.arm === claim.controlArm) {
      control.rows += 1;
      const e = evidenceFor(r, claim.capability);
      if ((e?.delivered ?? 0) > 0 || (e?.used ?? 0) > 0) control.leaked += 1;
      else if (!e || e.delivered === null || e.used === null) control.unknown += 1;
      else control.clean += 1;
    }
  }
  const refusals: LiftRefusal[] = [];
  if (treatment.rows === 0) refusals.push('no-treatment-rows');
  if (treatment.unknown > 0) refusals.push('treatment-evidence-unknown');
  // "Never exercised" is a MEASURED finding: with unknown rows it is not established (unknown already refuses).
  if (treatment.rows > 0 && treatment.unknown === 0 && treatment.exercised === 0) refusals.push('treatment-never-exercised');
  if (control.unknown > 0) refusals.push('control-evidence-unknown');
  if (control.leaked > 0) refusals.push('control-leak');
  return { ...claim, admitted: refusals.length === 0, refusals, treatment, control };
}
