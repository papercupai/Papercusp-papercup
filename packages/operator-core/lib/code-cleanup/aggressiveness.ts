/**
 * Campaign aggressiveness — which batches a campaign may propose
 * (code-cleanup-campaigns-2026-10-26 P-016, R-12).
 *
 * A campaign proposes only the work its aggressiveness level admits:
 *   - `safe` (the default for a new campaign, D-007): exact and renamed clone families — the sweep's
 *     emitted kinds other than semantic, identical modulo renames by construction — whose members
 *     are ALL covered by tests;
 *   - `standard`: the same family kinds, covered or not. An uncovered member goes through
 *     characterization-first (R-6, `executor.ts`) before any refactor touches it;
 *   - `thorough`: also semantic (and near) clone families, which are not identical by construction,
 *     and the R-13 finding classes (dead export, anti-pattern, complexity hotspot).
 *
 * Selection narrows a batch to the units its level admits and withholds the rest with a reason, so
 * one inadmissible family does not cost the batch its admissible ones. A batch left with no admitted
 * unit is not proposed. Selection fails closed: a clone family whose kind is unknown is withheld at
 * every level, and a member the coverage map cannot answer for counts as uncovered.
 */
import { DEFAULT_CLEANUP_AGGRESSIVENESS, type CleanupAggressiveness, type CoverageView, type ExecutorMember } from './executor';
import type { TriageBatch, TriageFamily, TriageLocation } from './triage';

export const CLEANUP_AGGRESSIVENESS_LEVELS: readonly CleanupAggressiveness[] = ['safe', 'standard', 'thorough'];

export type CleanupCloneKind = TriageFamily['kind'];
/** R-13's finding classes. A semantic duplicate is a `clone` unit whose kind is `semantic`. */
export type CleanupFindingClass = 'clone' | 'dead-export' | 'anti-pattern' | 'complexity-hotspot';

/** One family or finding inside a batch. */
export interface AggressivenessUnit {
  id: string;
  findingClass: CleanupFindingClass;
  /** The clone family's kind. Required for `clone` units; a clone unit without one is withheld. */
  cloneKind?: CleanupCloneKind;
  members: readonly ExecutorMember[];
}
export interface AggressivenessCandidate { id: string; units: readonly AggressivenessUnit[] }

export type AggressivenessWithholdReason = 'kind-not-admitted' | 'class-not-admitted' | 'clone-kind-unknown'
  | 'uncovered-under-safe' | 'no-members';

export interface ProposedBatch {
  candidateId: string;
  units: AggressivenessUnit[];
  /** Members no test covers. Non-empty only above `safe`: the executor characterizes them first (R-6). */
  uncovered: ExecutorMember[];
}
export interface WithheldUnit { candidateId: string; unitId: string; reason: AggressivenessWithholdReason; detail: string }
export interface AggressivenessSelection {
  level: CleanupAggressiveness;
  proposed: ProposedBatch[];
  withheld: WithheldUnit[];
  /** Candidates that kept no admitted unit and are not proposed at all. */
  dropped: string[];
}

/** Clone kinds identical modulo renames by construction: admitted from `safe` up. */
const MECHANICAL_CLONE_KINDS: ReadonlySet<CleanupCloneKind> = new Set(['exact', 'renamed']);
const KNOWN_CLONE_KINDS: ReadonlySet<CleanupCloneKind> = new Set(['exact', 'renamed', 'near', 'semantic']);

/**
 * The level for a campaign. A campaign created without one is `safe` (D-007). An unrecognised value
 * throws: a misspelt level must not silently run at some other risk.
 */
export function resolveCleanupAggressiveness(value?: string | null): CleanupAggressiveness {
  if (value === undefined || value === null || value === '') return DEFAULT_CLEANUP_AGGRESSIVENESS;
  if ((CLEANUP_AGGRESSIVENESS_LEVELS as readonly string[]).includes(value)) return value as CleanupAggressiveness;
  throw new Error(`unknown cleanup aggressiveness '${value}'; expected one of ${CLEANUP_AGGRESSIVENESS_LEVELS.join(', ')}`);
}

const memberLabel = (m: ExecutorMember) => `${m.path}:${m.line} ${m.symbol}`;

/** Why `level` does not admit `unit`'s kind or class, or null when it does (coverage aside). */
function kindRefusal(level: CleanupAggressiveness, unit: AggressivenessUnit): { reason: AggressivenessWithholdReason; detail: string } | null {
  if (unit.findingClass === 'clone') {
    if (!unit.cloneKind || !KNOWN_CLONE_KINDS.has(unit.cloneKind)) {
      return { reason: 'clone-kind-unknown',
        detail: `clone family ${unit.id} has no known family kind (${unit.cloneKind ?? 'none'}); it is withheld at every level` };
    }
    if (MECHANICAL_CLONE_KINDS.has(unit.cloneKind) || level === 'thorough') return null;
    return { reason: 'kind-not-admitted',
      detail: `aggressiveness '${level}' admits only exact and renamed clone families; ${unit.id} is ${unit.cloneKind} (thorough only)` };
  }
  if (level === 'thorough') return null;
  return { reason: 'class-not-admitted',
    detail: `aggressiveness '${level}' admits clone families only; ${unit.id} is a ${unit.findingClass} finding (thorough only)` };
}

/** The batches `level` lets a campaign propose, each narrowed to its admitted units. */
export function selectBatchesForAggressiveness(level: CleanupAggressiveness, candidates: readonly AggressivenessCandidate[],
  coverage: Pick<CoverageView, 'coveringTests'>): AggressivenessSelection {
  const proposed: ProposedBatch[] = [];
  const withheld: WithheldUnit[] = [];
  const dropped: string[] = [];
  const isUncovered = (m: ExecutorMember) => (coverage.coveringTests(m) ?? []).length === 0;

  for (const candidate of candidates) {
    const units: AggressivenessUnit[] = [];
    const uncovered: ExecutorMember[] = [];
    for (const unit of candidate.units) {
      const withhold = (reason: AggressivenessWithholdReason, detail: string) =>
        withheld.push({ candidateId: candidate.id, unitId: unit.id, reason, detail });
      if (!unit.members.length) { withhold('no-members', `${unit.id} names no member to change`); continue; }
      const refusal = kindRefusal(level, unit);
      if (refusal) { withhold(refusal.reason, refusal.detail); continue; }
      const bare = unit.members.filter(isUncovered);
      if (bare.length && level === 'safe') {
        withhold('uncovered-under-safe',
          `aggressiveness 'safe' admits only fully covered families; ${unit.id} has uncovered member(s): ${bare.map(memberLabel).join('; ')}`);
        continue;
      }
      units.push(unit);
      uncovered.push(...bare);
    }
    if (units.length) proposed.push({ candidateId: candidate.id, units, uncovered });
    else dropped.push(candidate.id);
  }
  return { level, proposed, withheld, dropped };
}

/**
 * Triage batches (P-005) as selection candidates. Triage keeps each family's score but not its kind,
 * so the kind is joined from the triage input families by id; a family with no match keeps no kind
 * and is withheld. The candidate id matches `executorBatchFromTriage` (`<area>#<index>`).
 */
export function aggressivenessCandidatesFromTriage(batches: readonly TriageBatch[], families: readonly Pick<TriageFamily, 'id' | 'kind'>[],
  endLine?: (m: TriageLocation) => number | undefined): AggressivenessCandidate[] {
  const kinds = new Map(families.map(f => [f.id, f.kind] as const));
  return batches.map(batch => ({
    id: `${batch.area}#${batch.index}`,
    units: batch.families.map(f => ({
      id: f.id, findingClass: 'clone' as const, cloneKind: kinds.get(f.id),
      members: f.members.map(m => ({ ...m, endLine: endLine?.(m) ?? m.endLine })),
    })),
  }));
}
