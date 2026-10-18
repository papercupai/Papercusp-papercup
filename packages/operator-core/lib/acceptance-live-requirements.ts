/**
 * Acceptance criteria as a LIVE view of the subject plan's requirement blocks
 * (agent-paperwork-and-restart-tax-reduction-2026-10-15 P-001 / R-1).
 *
 * WHY. A seeded acceptance rubric holds a copy of every plan `R-N` requirement block. Before
 * this module, ANY edit to a block — including only moving its named test file — changed
 * `acceptanceBarSourceFingerprint`, so the subject's BAR pin stayed stale until an agent ran
 * `rubrics:amend`, which in turn re-vetted and re-graded the rubric. Measured on
 * slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08: 4 amendments, each resetting vetting and
 * grading, most of them path or method corrections.
 *
 * WHAT. Split a requirement into its MEANING (intent, condition, falsifier, scope, plane, layers,
 * check kind) and its VERIFICATION HOW (`method`, `replication`, and the file/test-name fields of
 * a `tests` check). A verification-only edit is BAR-neutral: the pin advances on the ordinary
 * neutral path and nothing is re-vetted or re-graded. Acceptance reads then take the verification
 * fields from the live plan block instead of the stored copy. A meaning edit is unchanged
 * behaviour: it still needs an amendment.
 *
 * The live block is canonical for verification fields because `rubrics:amend` re-renders the
 * plan's requirement blocks (`rerenderAmendedRequirementBlocks`), so after any amendment the block
 * and the rubric agree, and every later edit to the block is the newest truth.
 *
 * The stored rubric (and its barHash / criteriaHash) is deliberately NOT rewritten: those hashes
 * are the identity vetting, grading and proof were recorded against. This is a read overlay.
 */

/** A structured criterion check, as persisted on a rubric criterion. */
export interface LiveRequirementCheck {
  kind: string;
  [field: string]: unknown;
}

/** The verification-HOW fields of a criterion. */
export interface LiveVerificationFields {
  method?: string;
  check?: LiveRequirementCheck;
  replication?: unknown;
}

/** Per check kind, the fields that only say WHERE/HOW the proof runs, not WHAT it proves. */
export const VERIFICATION_ONLY_CHECK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  tests: ['files', 'testName', 'cases'],
};

function neutralCheck(check: LiveRequirementCheck): LiveRequirementCheck {
  const pathFields = VERIFICATION_ONLY_CHECK_FIELDS[check.kind];
  if (!pathFields) return check;
  return Object.fromEntries(
    Object.entries(check).filter(([field]) => !pathFields.includes(field)),
  ) as LiveRequirementCheck;
}

/**
 * The criterion with its verification HOW removed — what the requirement MEANS.
 *
 * `barHash` is dropped too: the normalizer derives it from the criterion INCLUDING `check`, so
 * keeping it would smuggle the test file list back into the meaning. Every field it summarises
 * that carries meaning is still compared directly.
 */
export function verificationNeutralCriterion<T extends LiveVerificationFields & { barHash?: unknown }>(
  criterion: T,
): Omit<T, 'method' | 'replication' | 'barHash'> {
  const { method: _method, replication: _replication, barHash: _derived, check, ...meaning } = criterion;
  return check === undefined
    ? (meaning as Omit<T, 'method' | 'replication' | 'barHash'>)
    : ({ ...meaning, check: neutralCheck(check) } as Omit<T, 'method' | 'replication' | 'barHash'>);
}

function stableJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

export type RequirementBarEdit = 'unchanged' | 'verification-only' | 'meaning';

/**
 * Classify one requirement's edit. An added or removed requirement is a meaning change; an
 * edit confined to `method`, `replication` or a `tests` check's files/test name is
 * verification-only; anything else is a meaning change.
 */
export function classifyRequirementBarEdit<B extends LiveVerificationFields, A extends LiveVerificationFields>(
  before: B | null | undefined,
  after: A | null | undefined,
): RequirementBarEdit {
  if (!before || !after) return !before && !after ? 'unchanged' : 'meaning';
  if (stableJson(before) === stableJson(after)) return 'unchanged';
  return stableJson(verificationNeutralCriterion(before)) === stableJson(verificationNeutralCriterion(after))
    ? 'verification-only'
    : 'meaning';
}

export interface LiveRequirementBar {
  barKey: string;
  /** Present only for an explicit ```requirement block; legacy prose has no verification of its own. */
  criterion?: LiveVerificationFields;
}

export type LiveRequirementKeptReason = 'no-explicit-block' | 'check-kind-changed';

export interface LiveRequirementOverlay<C> {
  criteria: C[];
  /** BARs whose verification fields are read from the live plan block. */
  live: string[];
  /** Subset of `live` whose verification differs from the stored copy. */
  changed: string[];
  /** BARs that keep the stored verification, and why. */
  kept: Array<{ barKey: string; reason: LiveRequirementKeptReason }>;
}

const VERIFICATION_FIELDS = ['method', 'check', 'replication'] as const;

/**
 * Overlay each stored acceptance criterion's verification fields with the live plan block's.
 *
 * A BAR keeps its stored verification when the plan has no explicit block for it (legacy prose)
 * or when the block's check KIND differs — a kind change alters what the proof measures, so it is
 * a meaning change that still needs an amendment. A live field the block omits keeps its stored
 * value rather than being blanked.
 */
export function overlayLiveRequirementVerification<C extends LiveVerificationFields & { barKey?: string | null }>(
  stored: readonly C[],
  liveBars: readonly LiveRequirementBar[],
): LiveRequirementOverlay<C> {
  const byKey = new Map(liveBars.map((bar) => [bar.barKey, bar] as const));
  const live: string[] = [];
  const changed: string[] = [];
  const kept: LiveRequirementOverlay<C>['kept'] = [];
  const criteria = stored.map((criterion) => {
    const barKey = criterion.barKey?.trim();
    if (!barKey) return criterion;
    const block = byKey.get(barKey)?.criterion;
    if (!block) {
      kept.push({ barKey, reason: 'no-explicit-block' });
      return criterion;
    }
    if ((criterion.check?.kind ?? null) !== (block.check?.kind ?? criterion.check?.kind ?? null)) {
      kept.push({ barKey, reason: 'check-kind-changed' });
      return criterion;
    }
    const next: C = { ...criterion };
    for (const field of VERIFICATION_FIELDS) {
      if (block[field] !== undefined) (next as LiveVerificationFields)[field] = block[field] as never;
    }
    live.push(barKey);
    if (classifyRequirementBarEdit(criterion, next) !== 'unchanged') changed.push(barKey);
    return next;
  });
  return { criteria, live, changed, kept };
}

export interface LiveAcceptanceViewDeps {
  readSubjectPlanContent: (args: {
    planSlug: string;
    harnessSlug?: string;
  }) => Promise<{ content: string; version?: number | null } | null>;
  parseRequirementBars: (content: string) =>
    | { ok: true; bars: LiveRequirementBar[] }
    | { ok: false; problems: Array<{ detail: string }> };
}

export type LiveAcceptanceViewStatus =
  | { source: 'live-plan'; subjectPlan: string; subjectPlanVersion: number | null; live: string[]; changed: string[]; kept: LiveRequirementOverlay<unknown>['kept'] }
  | { source: 'stored-rubric'; reason: 'not-a-plan-acceptance-rubric' | 'subject-plan-unreadable' | 'requirements-unparseable'; detail?: string };

/**
 * The acceptance READ: stored criteria with verification fields from the subject plan's live
 * requirement blocks. Fail-soft — any read or parse failure returns the stored criteria with a
 * `stored-rubric` status naming why, never a guessed overlay.
 */
export async function readLiveAcceptanceCriteria<C extends LiveVerificationFields & { barKey?: string | null }>(
  rubric: { kind?: string | null; subjectPlan?: string | null; subjectHarnessSlug?: string | null; criteria: readonly C[] },
  deps: LiveAcceptanceViewDeps,
): Promise<{ criteria: C[]; status: LiveAcceptanceViewStatus }> {
  if (rubric.kind !== 'acceptance' || !rubric.subjectPlan) {
    return { criteria: [...rubric.criteria], status: { source: 'stored-rubric', reason: 'not-a-plan-acceptance-rubric' } };
  }
  let plan: { content: string; version?: number | null } | null;
  try {
    plan = await deps.readSubjectPlanContent({
      planSlug: rubric.subjectPlan,
      ...(rubric.subjectHarnessSlug ? { harnessSlug: rubric.subjectHarnessSlug } : {}),
    });
  } catch (error) {
    return {
      criteria: [...rubric.criteria],
      status: { source: 'stored-rubric', reason: 'subject-plan-unreadable', detail: error instanceof Error ? error.message : String(error) },
    };
  }
  if (!plan) {
    return { criteria: [...rubric.criteria], status: { source: 'stored-rubric', reason: 'subject-plan-unreadable' } };
  }
  const parsed = deps.parseRequirementBars(plan.content);
  if (!parsed.ok) {
    return {
      criteria: [...rubric.criteria],
      status: { source: 'stored-rubric', reason: 'requirements-unparseable', detail: parsed.problems.map((p) => p.detail).join('; ') },
    };
  }
  const overlay = overlayLiveRequirementVerification(rubric.criteria, parsed.bars);
  return {
    criteria: overlay.criteria,
    status: {
      source: 'live-plan',
      subjectPlan: rubric.subjectPlan,
      subjectPlanVersion: plan.version ?? null,
      live: overlay.live,
      changed: overlay.changed,
      kept: overlay.kept,
    },
  };
}
