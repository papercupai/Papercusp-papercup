import { specBehaviorNonAtomicReason } from './agent-tools/plans/spec-clause-compiler';

export interface AcceptanceBarProjectionText {
  key: string;
  barKey?: string | null;
  title?: string | null;
  model?: string | null;
  role?: string | null;
}

export interface AcceptanceBarAtomicityIssue {
  barKey: string;
  behavior: string;
  reason: string;
}

/** The behavior persisted to AUTO-BAR clauses, after removing a repeated title. */
export function acceptanceBarProjectedBehavior(
  criterion: { title?: string | null; model?: string | null },
): string {
  const model = String(criterion.model ?? '').trim();
  const title = String(criterion.title ?? '').trim().replace(/[.\s]+$/, '');
  if (!model || !title) return model;
  const prefix = `${title}.`;
  if (!model.startsWith(prefix)) return model;
  const rest = model.slice(prefix.length).replace(/^\s+/, '');
  return rest.length > 0 ? rest : model;
}

/**
 * Find added or meaning-changed outcome BARs whose derived AUTO-BAR behavior is
 * non-atomic. Unchanged legacy BAR text is left intact so unrelated rubric edits
 * do not turn old data into a write blocker.
 */
export function acceptanceBarAtomicityIssues(
  next: readonly AcceptanceBarProjectionText[],
  prior: readonly AcceptanceBarProjectionText[] = [],
): AcceptanceBarAtomicityIssue[] {
  const priorOutcomes = new Map(
    prior
      .filter((criterion) => criterion.role !== 'disclosure')
      .map((criterion) => [criterion.barKey?.trim() || criterion.key.trim(), acceptanceBarProjectedBehavior(criterion)]),
  );

  return next.flatMap((criterion) => {
    if (criterion.role === 'disclosure') return [];
    const barKey = criterion.barKey?.trim() || criterion.key.trim();
    const behavior = acceptanceBarProjectedBehavior(criterion);
    if (priorOutcomes.get(barKey) === behavior) return [];
    const reason = specBehaviorNonAtomicReason(behavior);
    return reason ? [{ barKey, behavior, reason }] : [];
  });
}

export function assertChangedAcceptanceBarProjectionsAtomic(
  next: readonly AcceptanceBarProjectionText[],
  prior: readonly AcceptanceBarProjectionText[] = [],
): void {
  const issues = acceptanceBarAtomicityIssues(next, prior);
  if (issues.length === 0) return;
  throw new Error(
    'invalid_args: acceptance_bar_non_atomic_projection — ' +
      issues.map(({ barKey, reason }) => `${barKey}:${reason}`).join('; ') +
      '. Split each added or meaning-changed outcome BAR into one observable behavior before proposing or amending it.',
  );
}
