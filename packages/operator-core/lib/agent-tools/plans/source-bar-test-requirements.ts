/** Resolve the exact BAR-pinned test check used by spec adequacy scoring. */
import { getRubric, type Rubric } from '../../rubrics';
import type { SpecClauseBarPin } from './spec-clauses-store';

export type SourceBarTestRequirements =
  | { status: 'not-required' }
  | { status: 'required'; files: string[] }
  | { status: 'unavailable'; reason: string };

export type SourceBarRubricCache = Map<string, Promise<Rubric | null>>;

/**
 * Resolve a clause's immutable source BAR pin against its exact rubric revision.
 * Missing or mismatched source data stays explicit so callers cannot accidentally
 * grade only the bindings the author selected and report a clean suite verdict.
 */
export async function resolveSourceBarTestRequirements(
  pin: SpecClauseBarPin | null | undefined,
  cache: SourceBarRubricCache = new Map(),
): Promise<SourceBarTestRequirements> {
  if (!pin) return { status: 'not-required' };

  const cacheKey = `${pin.rubricSlug}@${pin.rubricRevision}`;
  let rubricPromise = cache.get(cacheKey);
  if (!rubricPromise) {
    rubricPromise = getRubric(pin.rubricSlug, pin.rubricRevision).catch(() => null);
    cache.set(cacheKey, rubricPromise);
  }
  const rubric = await rubricPromise;
  if (
    !rubric ||
    rubric.rubricId !== pin.rubricSlug ||
    rubric.revision !== pin.rubricRevision ||
    rubric.kind !== 'acceptance' ||
    rubric.barSetHash !== pin.barSetHash
  ) {
    return {
      status: 'unavailable',
      reason: `pinned rubric ${pin.rubricSlug}@${pin.rubricRevision} or BAR-set identity could not be resolved`,
    };
  }

  const matches = rubric.criteria.filter((criterion) => criterion.barKey === pin.barKey);
  if (matches.length !== 1) {
    return {
      status: 'unavailable',
      reason: `pinned BAR ${pin.barKey} resolves to ${matches.length} criteria in ${pin.rubricSlug}@${pin.rubricRevision}`,
    };
  }

  const criterion = matches[0]!;
  if (criterion.barHash !== pin.barHash || criterion.evidencePlane !== pin.evidencePlane) {
    return {
      status: 'unavailable',
      reason: `pinned BAR ${pin.barKey} identity differs from ${pin.rubricSlug}@${pin.rubricRevision}`,
    };
  }
  if (criterion.check?.kind !== 'tests') return { status: 'not-required' };

  const files = [...new Set(criterion.check.files.map((file) => file.trim()).filter(Boolean))].sort();
  if (files.length === 0) {
    return {
      status: 'unavailable',
      reason: `pinned BAR ${pin.barKey} declares a tests check without registered files`,
    };
  }
  return { status: 'required', files };
}
