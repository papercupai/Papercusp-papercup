/** Resolve the exact BAR-pinned test check used by spec adequacy scoring. */
import { getRubric, type Rubric } from '../../rubrics';
import type { LiveAcceptanceViewStatus } from '../../acceptance-live-requirements';
import type { SpecClauseBarPin } from './spec-clauses-store';

export type SourceBarTestRequirements =
  | { status: 'not-required' }
  | {
      status: 'required';
      files: string[];
      /**
       * Present only when the files came from the subject plan's LIVE requirement block rather
       * than the pinned rubric copy (agent-paperwork-and-restart-tax-reduction-2026-10-15 P-001).
       */
      liveRequirement?: { subjectPlan: string; pinnedFiles: string[] };
    }
  | { status: 'unavailable'; reason: string };

export type SourceBarRubricCache = Map<string, Promise<Rubric | null>>;

/**
 * How the resolver reads the live view. Injectable for tests; the default reads the subject plan
 * row and the rubric's current revision through the same modules `rubrics:get` uses.
 */
export interface SourceBarLiveRead {
  currentRevision: (rubricSlug: string) => Promise<number | null>;
  liveCriteria: (rubric: Rubric) => Promise<{ criteria: Rubric['criteria']; status: LiveAcceptanceViewStatus }>;
}

export const defaultSourceBarLiveRead: SourceBarLiveRead = {
  currentRevision: async (rubricSlug) => {
    const { getRubricPlanRevision } = await import('../../rubrics');
    return getRubricPlanRevision(rubricSlug);
  },
  liveCriteria: async (rubric) => {
    const [{ readLiveAcceptanceCriteria }, { parseRequirementBars }, { getPlanRow }] = await Promise.all([
      import('../../acceptance-live-requirements'),
      import('../../acceptance-bar-seed'),
      import('./source'),
    ]);
    return readLiveAcceptanceCriteria(rubric, {
      readSubjectPlanContent: async ({ planSlug, harnessSlug }) => {
        const row = await getPlanRow(planSlug, harnessSlug ? { harnessSlug } : {});
        return row ? { content: row.content, version: row.version } : null;
      },
      parseRequirementBars: (content) => {
        const parsed = parseRequirementBars(content);
        return parsed.ok
          ? { ok: true, bars: parsed.bars.map((bar) => ({ barKey: bar.barKey, ...(bar.criterion ? { criterion: bar.criterion } : {}) })) }
          : { ok: false, problems: parsed.problems };
      },
    });
  },
};

function normalizedFiles(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => file.trim()).filter(Boolean))].sort();
}

/**
 * P-001 (R-1): a path-only edit to a requirement block no longer amends the rubric, so the pinned
 * revision's copy of `check.files` can name a file that moved. When the pin is the rubric's
 * CURRENT revision, take the files from the live block, exactly as `rubrics:get` does for a current
 * read. A pin to an older revision stays an immutable snapshot (its meaning may have since changed).
 * Any read failure falls back to the pinned files: the live view can widen accuracy, never fail a
 * resolution that the pinned copy can answer.
 */
async function liveTestFiles(
  rubric: Rubric,
  pin: SpecClauseBarPin,
  cache: SourceBarRubricCache,
  live: SourceBarLiveRead,
): Promise<{ files: string[]; subjectPlan: string } | null> {
  const subjectPlan = rubric.subjectPlan;
  if (rubric.kind !== 'acceptance' || !subjectPlan) return null;
  try {
    if ((await live.currentRevision(pin.rubricSlug)) !== pin.rubricRevision) return null;
    // One live read per rubric revision per evaluation, however many clauses pin it.
    const cacheKey = `${pin.rubricSlug}@${pin.rubricRevision}#live`;
    let overlaid = cache.get(cacheKey);
    if (!overlaid) {
      // Keep only the BARs the overlay actually took from the live plan: a BAR the policy KEPT
      // (no explicit block, or a changed check kind) must not be reported as live.
      overlaid = live
        .liveCriteria(rubric)
        .then((view) => {
          if (view.status.source !== 'live-plan') return null;
          const liveKeys = new Set(view.status.live);
          return { ...rubric, criteria: view.criteria.filter((criterion) => liveKeys.has(criterion.barKey ?? '')) };
        })
        .catch(() => null);
      cache.set(cacheKey, overlaid);
    }
    const liveRubric = await overlaid;
    const criterion = liveRubric?.criteria.find((candidate) => candidate.barKey === pin.barKey);
    if (criterion?.check?.kind !== 'tests') return null;
    const files = normalizedFiles(criterion.check.files);
    return files.length > 0 ? { files, subjectPlan } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a clause's immutable source BAR pin against its exact rubric revision.
 * Missing or mismatched source data stays explicit so callers cannot accidentally
 * grade only the bindings the author selected and report a clean suite verdict.
 */
export async function resolveSourceBarTestRequirements(
  pin: SpecClauseBarPin | null | undefined,
  cache: SourceBarRubricCache = new Map(),
  live: SourceBarLiveRead = defaultSourceBarLiveRead,
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

  const files = normalizedFiles(criterion.check.files);
  if (files.length === 0) {
    return {
      status: 'unavailable',
      reason: `pinned BAR ${pin.barKey} declares a tests check without registered files`,
    };
  }
  const liveFiles = await liveTestFiles(rubric, pin, cache, live);
  if (!liveFiles || liveFiles.files.join('\n') === files.join('\n')) return { status: 'required', files };
  return {
    status: 'required',
    files: liveFiles.files,
    liveRequirement: { subjectPlan: liveFiles.subjectPlan, pinnedFiles: files },
  };
}
