/**
 * rubric-loss-guard.ts — the WI-4287 rubric loss-guard RULE CORE, lifted to the shared
 * `template_data` PERSISTENCE BOUNDARY (EI-21972673091438558).
 *
 * A rubric is a plan row: its criteria live in `harness_plans.template_data`. TWO doors
 * write that column and, before this module, only ONE was guarded:
 *
 *   • `rubrics:propose` / `rubrics:amend` → proposeRubric, which calls
 *     assertNoSilentRubricLoss against a snapshot read OUTSIDE the advisory lock; and
 *   • `plans:set-template-data` → the generic structured-write verb, which validates
 *     STRUCTURE ONLY. A criteria array of length 1 satisfies the zod schema exactly as
 *     well as one of length 27, so a whole rubric could be silently gutted through it —
 *     including the portfolio-activity-floor criterion added THROUGH that same door.
 *
 * Bolting a second guard onto `set-template-data` would have left door three unguarded.
 * Instead the rule core lives here, pure, and is enforced where BOTH doors converge:
 * `withPlanLock`'s template_data write, INSIDE the advisory-locked transaction, against
 * the row actually being replaced. That placement also closes the propose path's
 * read-outside-the-lock window, where a concurrent writer's criterion could be dropped
 * by a proposal that was assembled before that criterion existed.
 *
 * Pure by construction: zod + the rubric template schema only, no DB, no imports from
 * rubrics.ts (which imports withPlanLock — the cycle this file exists to avoid).
 */

import { knownRubricCriterionKeys, rubricTemplateDataSchema } from './rubric-template';
import type { AcceptanceBarContract, AcceptanceBarProvenance } from './rubric-template';
import { hashPlanContent } from './content-hash';
import { pgTimestampToIso } from '../../pg-timestamp';

/** The marker string that tags an embedded replication drill in method/replication
 *  prose. Losing it from a criterion's combined procedure text is a guard violation. */
export const REPLICATION_DRILL_MARKER = 'REPLICATION DRILL';

/** A criterion's combined procedure text must not shrink below this fraction of the
 *  stored text (0.6 ⇒ a >40% shrink violates) without an explicit allowMethodShrink. */
export const METHOD_SHRINK_GUARD_RATIO = 0.6;

/** The shrink-ratio guard only applies when the STORED procedure text is at least this
 *  long — a 50-char method being reworded shouldn't trip a loss guard; a 4,600-char
 *  drill being gutted must. The MARKER guard applies regardless of length. */
export const METHOD_SHRINK_GUARD_MIN_CHARS = 200;

/**
 * The criterion fields the loss rules read — a deliberate WIDENING of the schema-owned
 * criterion type, not a second copy of it: both `Rubric['criteria']` (the v1 shape) and
 * `RubricTemplateData['criteria']` (the persisted shape) must remain assignable to it,
 * which the compiler re-checks at every call site.
 */
export interface RubricLossCriterion {
  key: string;
  method?: string;
  replication?: string;
  check?: { kind: string } | undefined;
  criterionClass?: string | undefined;
}

/**
 * The caller's EXPLICIT acknowledgements. A loss is only ever allowed when the caller
 * named it: dropped keys must be listed, a gutted procedure needs allowMethodShrink +
 * a written reason, a class downgrade needs its own reason. `plans:set-template-data`
 * has no such arguments and therefore passes NO ack — through that door a rubric write
 * may add and edit criteria but never lose one.
 */
export interface RubricLossAck {
  dropKeys?: string[];
  allowMethodShrink?: boolean;
  shrinkReason?: string;
  classDowngradeReason?: string;
}

/** A criterion's full procedure text: method + replication drill combined. Comparing
 *  the COMBINED text (D-002) means moving a drill between the two fields is never a
 *  violation — only genuine text loss is. */
export function criterionProcedureText(c: { method?: string; replication?: string }): string {
  return `${c.method ?? ''}${c.replication ? `\n${c.replication}` : ''}`;
}

/**
 * PURE RULE CORE: everything that counts as SILENT LOSS between a stored criteria array
 * and the one about to replace it, as human-readable violation strings (empty ⇒ clean).
 *
 * Callers turn these into their own errors: proposeRubric keeps its `invalid_args:`
 * caller-error phrasing, the persistence boundary points at the acking verb. Sharing
 * this one function is what keeps the two doors from drifting into two dialects of
 * "loss" — the failure this whole file exists to prevent.
 */
export function collectRubricLossViolations(
  storedCriteria: readonly RubricLossCriterion[],
  proposedCriteria: readonly RubricLossCriterion[],
  ack: RubricLossAck = {},
): string[] {
  const proposedByKey = new Map(proposedCriteria.map((c) => [c.key, c]));
  const acked = new Set(ack.dropKeys ?? []);
  const violations: string[] = [];

  // 1) dropped criteria — every stored key must survive or be explicitly acknowledged.
  const dropped = storedCriteria.filter((c) => !proposedByKey.has(c.key) && !acked.has(c.key));
  if (dropped.length > 0) {
    violations.push(
      `DROPS ${dropped.length} stored criteri${dropped.length === 1 ? 'on' : 'a'}: ${dropped
        .map((c) => `'${c.key}'`)
        .join(', ')} — acknowledge intentional removal with dropKeys:[${dropped
        .map((c) => `"${c.key}"`)
        .join(', ')}], or rubrics:get the stored rubric and resubmit ALL criteria (a partial list silently deletes the rest)`,
    );
  }

  // 2) procedure loss on surviving criteria — marker loss or a sharp combined shrink.
  const shrinkViolations: string[] = [];
  for (const storedCrit of storedCriteria) {
    const proposed = proposedByKey.get(storedCrit.key);
    if (!proposed) continue; // handled by the drop guard above
    const before = criterionProcedureText(storedCrit);
    const after = criterionProcedureText(proposed);
    if (before.includes(REPLICATION_DRILL_MARKER) && !after.includes(REPLICATION_DRILL_MARKER)) {
      shrinkViolations.push(
        `criterion '${storedCrit.key}' LOSES its '${REPLICATION_DRILL_MARKER}' testing procedure (stored method+replication carries the marker; the proposal's doesn't)`,
      );
    } else if (
      before.length >= METHOD_SHRINK_GUARD_MIN_CHARS &&
      after.length < before.length * METHOD_SHRINK_GUARD_RATIO
    ) {
      const pct = Math.round((1 - after.length / before.length) * 100);
      shrinkViolations.push(
        `criterion '${storedCrit.key}' procedure text (method+replication) shrinks ${before.length} → ${after.length} chars (−${pct}%)`,
      );
    }
  }

  // 2b) structured-check loss (P-011 / D-006) — a stored criterion's deterministic
  //    `check` resubmitted absent silently converts a machine-enforced criterion back
  //    to fuzzy judgment: the same silent-weakening family as a procedure shrink, so it
  //    rides the same allowMethodShrink + shrinkReason ack (a check IS procedure, in
  //    structured form). Changing a check's content (different files / different
  //    instrument) is a visible edit, not a silent loss — only total removal is guarded.
  const checkLosses = storedCriteria.filter((c) => {
    if (!c.check) return false;
    const proposed = proposedByKey.get(c.key);
    return proposed !== undefined && proposed.check === undefined;
  });
  if (checkLosses.length > 0) {
    shrinkViolations.push(
      ...checkLosses.map(
        (c) =>
          `criterion '${c.key}' LOSES its structured ${c.check!.kind} check (deterministic enforcement reverts to fuzzy judgment)`,
      ),
    );
  }

  // 3) criterion-class weakening (P-008) — a stored 'violatable' criterion resubmitted
  //    without the class (or downgraded to settle-once) silently removes its
  //    provisional-until-terminal protection, the same silent-weakening family as a
  //    procedure shrink. Upgrades (settle-once → violatable) are never guarded.
  const downgraded = storedCriteria.filter((c) => {
    if (c.criterionClass !== 'violatable') return false;
    const proposed = proposedByKey.get(c.key);
    return proposed !== undefined && proposed.criterionClass !== 'violatable';
  });
  if (downgraded.length > 0 && (ack.classDowngradeReason ?? '').trim() === '') {
    violations.push(
      `DOWNGRADES ${downgraded.length} 'violatable' criteri${downgraded.length === 1 ? 'on' : 'a'} to settle-once: ${downgraded
        .map((c) => `'${c.key}'`)
        .join(', ')} — mid-run ratings of these would stop being stamped provisional. If intentional, pass a non-empty classDowngradeReason; otherwise resubmit them with criterionClass:'violatable'`,
    );
  }

  if (shrinkViolations.length > 0) {
    if (ack.allowMethodShrink && (ack.shrinkReason ?? '').trim() !== '') {
      // conscious, explained shrink — allowed.
    } else if (ack.allowMethodShrink) {
      violations.push(
        `${shrinkViolations.join('; ')} — allowMethodShrink is set but shrinkReason is empty: explain WHY the procedure is intentionally shrinking`,
      );
    } else {
      violations.push(
        `${shrinkViolations.join('; ')} — if intentional, pass allowMethodShrink:true + shrinkReason; otherwise restore the full procedure text (rubrics:get the stored rubric and edit from it)`,
      );
    }
  }

  return violations;
}

/**
 * Read the guardable criteria out of a stored/incoming `template_data` value.
 *
 * `null`/`undefined` data is NOT "no criteria to compare" on the incoming side — it is a
 * CLEAR of the column, which erases every stored criterion at once. It is reported as an
 * empty criteria array so the drop rule catches it; the stored side treats it as "nothing
 * was there yet", which is the brand-new-rubric case the guard must let through.
 *
 * A value that fails the rubric schema is reported as `null` (unguardable): on the stored
 * side that is a wedged placeholder with nothing to lose, and on the incoming side the
 * registry validation that runs before this point is what refuses it.
 */
function guardableCriteria(
  data: unknown,
  side: 'stored' | 'incoming',
): readonly RubricLossCriterion[] | null {
  if (data === null || data === undefined) return side === 'incoming' ? [] : null;
  const parsed = rubricTemplateDataSchema.safeParse(data);
  if (!parsed.success) return null;
  return parsed.data.criteria;
}

/**
 * THE BOUNDARY GUARD: refuse a `template_data` write that would silently lose criteria
 * or their testing procedures from a rubric-template plan. Throws a teaching error naming
 * exactly what would be lost; returns silently when the write is clean, when the plan is
 * not a rubric, or when there is no parseable stored rubric to lose anything from.
 *
 * `ack` is the ONLY way past a real loss, and only `rubrics:propose`/`amend` supply one —
 * they collect it from the caller as explicit arguments and have already reported it.
 */
export function assertNoSilentRubricTemplateDataLoss(args: {
  slug: string;
  storedTemplateData: unknown;
  nextTemplateData: unknown;
  ack?: RubricLossAck;
}): void {
  const stored = guardableCriteria(args.storedTemplateData, 'stored');
  if (stored === null || stored.length === 0) return;
  const next = guardableCriteria(args.nextTemplateData, 'incoming');
  if (next === null) return;

  const violations = collectRubricLossViolations(stored, next, args.ack ?? {});
  if (violations.length === 0) return;

  // `invalid_args:` so the tool-error classifier buckets this as a CALLER error (the
  // write's own arguments would lose stored content), not a structural tool bug that the
  // improvement-watchdog would file into the auto-implement lane (EI-10148).
  throw new Error(
    `invalid_args: rubric '${args.slug}': this template_data write would SILENTLY LOSE stored rubric content:\n` +
      violations.map((v) => `  • ${v}`).join('\n') +
      `\nA rubric's criteria are guarded at the persistence boundary, so EVERY door writing ` +
      `template_data on a rubric plan is subject to this check. plans:set-template-data has no ` +
      `acknowledgement arguments by design: resubmit the FULL criteria array (plans:get-template-data ` +
      `returns the stored one), or make the removal through rubrics:propose / rubrics:amend, which ` +
      `take dropKeys / allowMethodShrink + shrinkReason / classDowngradeReason.`,
  );
}

/**
 * The authenticated operation which is allowed to alter a started BAR.  This is
 * deliberately a capability passed by the canonical amendment writer, not a
 * caller-controlled field inside template_data.  P-005 extends the approval
 * fields with the cross-plan decision receipt; the persistence seam already
 * understands the distinction so generic/template/migration writers cannot
 * accidentally become amendment writers.
 */
export interface AcceptanceBarAmendmentAuthorization {
  actorId: string;
  reason: string;
  /** Server-recorded approval receipt (required by the cross-plan amendment path). */
  approvalRef?: string;
  approvedBy?: string;
  approvedAt?: string;
}

/** Authoritative subject-plan state used to repair caller-supplied provenance. */
export interface AcceptanceBarSubjectState {
  status?: string | null;
  revision?: number | null;
  adoptionEpoch?: number | null;
  cohort?: 'post-epoch' | 'legacy-backfilled' | null;
  seededAt?: string | null;
  seededBy?: string | null;
  /** Server-owned rubric identity pinned by the subject, never caller template_data. */
  rubricSlug?: string | null;
}

export interface AcceptanceBarWriteGuardInput {
  slug: string;
  storedTemplateData: unknown;
  nextTemplateData: unknown;
  subjectPlan?: AcceptanceBarSubjectState | null;
  actorId?: string | null;
  amendment?: AcceptanceBarAmendmentAuthorization;
  now?: string;
}

export interface AcceptanceBarWriteGuardResult {
  data: Record<string, unknown>;
  started: boolean;
  changed: boolean;
  changes: Array<{ barKey: string; kind: 'added' | 'removed' | 'meaning' | 'provenance'; fields: string[] }>;
}

/** Fields that participate in the canonical acceptance BAR meaning/hash. */
export const ACCEPTANCE_BAR_MEANING_FIELDS = [
  'intent',
  'model',
  'barKey',
  'barHash',
  'driftMarkers',
  'role',
  'mandatory',
  'requiredScope',
  'evidencePlane',
  'requiredTestLayers',
  'check',
  'passRatings',
  'coversBarKeys',
] as const;

export type AcceptanceBarMeaningField = (typeof ACCEPTANCE_BAR_MEANING_FIELDS)[number];

export function acceptanceBarMeaningField(field: string): field is AcceptanceBarMeaningField {
  return (ACCEPTANCE_BAR_MEANING_FIELDS as readonly string[]).includes(field);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

function equalValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
}

function barKeyOf(criterion: Record<string, unknown>): string {
  return String(criterion.barKey ?? criterion.key ?? '').trim();
}

function barSetHash(criteria: readonly Record<string, unknown>[]): string | undefined {
  const pairs = criteria
    .map((criterion) => [barKeyOf(criterion), String(criterion.barHash ?? '').trim()] as const)
    .filter(([key, hash]) => key && /^[a-f0-9]{64}$/.test(hash))
    .sort(([a], [b]) => a.localeCompare(b));
  if (pairs.length === 0 || new Set(pairs.map(([key]) => key)).size !== pairs.length) return undefined;
  return hashPlanContent(JSON.stringify(pairs));
}

function deriveContract(
  stored: AcceptanceBarContract,
  subject: AcceptanceBarSubjectState | null | undefined,
  incoming?: AcceptanceBarContract | null,
): AcceptanceBarContract {
  // The MEANING EPOCH is the one contract field with NO subject-plan authority:
  // `amendRubric` is its only writer, and it computes the value from the revision
  // counter this guard cannot see. Rebuilding the contract from `stored` alone
  // therefore DISCARDED every epoch the amender stamped, so the field could never
  // be written by any path (the write half of P-003 was dead on arrival while the
  // read half tested green against fixture-injected epochs).
  //
  // Carry an incoming epoch forward — but only FORWARD. Lowering it would bless a
  // card graded before a real meaning change as current, which is exactly the
  // failure this field exists to prevent, in the dangerous direction; raising it
  // only ever invalidates, which is the safe direction. A non-integer, zero, or
  // negative value is not an epoch at all and is ignored rather than trusted.
  const storedEpoch = typeof stored.meaningRevision === 'number' ? stored.meaningRevision : undefined;
  const offered = typeof incoming?.meaningRevision === 'number' ? incoming.meaningRevision : undefined;
  const acceptable =
    offered !== undefined &&
    Number.isInteger(offered) &&
    offered > 0 &&
    (storedEpoch === undefined || offered >= storedEpoch);
  const meaningRevision = acceptable ? offered : storedEpoch;
  return {
    ...stored,
    ...(meaningRevision !== undefined ? { meaningRevision } : {}),
    // A subject-plan row is the authority.  Fall back to the stored contract only
    // for legacy rows whose subject was deleted/unreadable; never trust incoming data.
    ...(subject?.adoptionEpoch != null && subject.adoptionEpoch > 0
      ? { adoptionEpoch: subject.adoptionEpoch }
      : {}),
    ...(subject?.cohort ? { cohort: subject.cohort } : {}),
    ...(subject?.revision != null && subject.revision > 0 ? { subjectPlanRevision: subject.revision } : {}),
    ...(subject?.seededAt ? { seededAt: pgTimestampToIso(subject.seededAt) } : {}),
    ...(subject?.seededBy ? { seededBy: subject.seededBy } : {}),
  };
}

function deriveProvenance(
  stored: AcceptanceBarProvenance | undefined,
  contract: AcceptanceBarContract,
  subject: AcceptanceBarSubjectState | null | undefined,
  actorId: string | null | undefined,
  amendment: AcceptanceBarAmendmentAuthorization | undefined,
  now: string,
  newlyAddedByAmendment: boolean,
  incoming: AcceptanceBarProvenance | undefined,
): AcceptanceBarProvenance {
  if (stored) {
    // An authenticated, reason-bearing amendment may correct an overstated
    // predeclaration claim. This only weakens that claim; it can never promote
    // legacy work to pre-implementation or rewrite who declared it and when.
    // Generic template writers still have no amendment capability.
    const conservativeLifecycleCorrection =
      stored.lifecycle === 'pre-implementation' &&
      incoming?.lifecycle === 'legacy-backfilled' &&
      Boolean(actorId && amendment?.actorId === actorId && amendment.reason.trim());
    return conservativeLifecycleCorrection ? { ...stored, lifecycle: 'legacy-backfilled' } : stored;
  }
  const legacy = subject?.cohort === 'legacy-backfilled' || subject?.status === 'ready' || subject?.status === 'active';
  return {
    lifecycle: legacy ? 'legacy-backfilled' : 'pre-implementation',
    // A missing provenance on an existing bar can be backfilled from the
    // server-owned seed pin. A newly amended bar enters the contract only when
    // this amendment is applied, so its declaration time is the amendment time.
    declaredAt: newlyAddedByAmendment ? now : contract.seededAt || now,
    // For a newly amended bar, the authenticated amendment actor is the only
    // honest author.  Seed/backfill rows derive this from the server seed pin.
    declaredBy: amendment?.actorId || actorId || contract.seededBy,
  };
}

/**
 * True when the stored document, read WITHOUT this build's schema, is an acceptance
 * rubric carrying a server-owned barContract object. Used only to fail closed when the
 * strict parse cannot see a contract the raw row plainly has (WI-6554700010018464).
 */
function rawStoredHasStartedBarContract(stored: unknown): boolean {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
  const raw = stored as { kind?: unknown; barContract?: unknown };
  return (
    raw.kind === 'acceptance' &&
    typeof raw.barContract === 'object' &&
    raw.barContract !== null &&
    !Array.isArray(raw.barContract)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** kind and subjectPlan are server-owned once a contract has started. */
function assertServerOwnedIdentityUnchanged(
  slug: string,
  stored: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  if (next.kind !== 'acceptance' || next.subjectPlan !== stored.subjectPlan) {
    throw new Error(
      `invalid_args: rubric '${slug}' has a started acceptance BAR contract; ` +
        'kind and subjectPlan are server-owned and cannot be changed by a generic template_data write',
    );
  }
}

/**
 * The ONE BAR comparison: which bars were added, removed, changed in meaning, or had
 * their provenance touched. Both the parsed path and the version-skew path call it, so
 * the two cannot drift into different definitions of "BAR meaning changed".
 */
function diffBarCriteria(
  storedCriteria: readonly Record<string, unknown>[],
  nextCriteria: readonly Record<string, unknown>[],
): {
  priorByKey: Map<string, Record<string, unknown>>;
  changes: AcceptanceBarWriteGuardResult['changes'];
  changedMeaning: boolean;
} {
  const priorByKey = new Map(storedCriteria.map((criterion) => [barKeyOf(criterion), criterion]));
  const nextByKey = new Map(nextCriteria.map((criterion) => [barKeyOf(criterion), criterion]));
  const changes: AcceptanceBarWriteGuardResult['changes'] = [];
  for (const [key, prior] of priorByKey) {
    const candidate = nextByKey.get(key);
    if (!candidate) {
      changes.push({ barKey: key, kind: 'removed', fields: ['bar'] });
      continue;
    }
    const fields = ACCEPTANCE_BAR_MEANING_FIELDS.filter((field) => !equalValue(prior[field], candidate[field]));
    if (fields.length > 0) changes.push({ barKey: key, kind: 'meaning', fields: [...fields] });
    if (!equalValue(prior.barProvenance, candidate.barProvenance)) {
      changes.push({ barKey: key, kind: 'provenance', fields: ['barProvenance'] });
    }
  }
  for (const key of nextByKey.keys()) {
    if (!priorByKey.has(key)) changes.push({ barKey: key, kind: 'added', fields: ['bar'] });
  }
  const changedMeaning = changes.some((change) => ['added', 'removed', 'meaning'].includes(change.kind));
  return { priorByKey, changes, changedMeaning };
}

function describeMeaningChanges(changes: AcceptanceBarWriteGuardResult['changes']): string {
  return changes
    .filter((change) => change.kind !== 'provenance')
    .map((change) => `${change.barKey}:${change.fields.join('|')}`)
    .join(', ');
}

function assertAmendmentAuthenticated(args: AcceptanceBarWriteGuardInput): void {
  if (!args.amendment) return;
  if (!args.amendment.actorId.trim() || !args.amendment.reason.trim()) {
    throw new Error(`invalid_args: rubric '${args.slug}' amendment requires authenticated actorId and a reason`);
  }
  if (args.actorId && args.actorId !== args.amendment.actorId) {
    throw new Error(`invalid_args: rubric '${args.slug}' amendment actorId does not match the authenticated writer`);
  }
}

/**
 * WI-6554700010018489 — a write that CARRIES a contract over a started contract this
 * build cannot parse (a stored rubric written by a NEWER build).
 *
 * Before this, the guard returned such a write unchanged: the stored side was
 * unreadable, so nothing was compared, and an older build serving a generic
 * template_data writer could rewrite BAR meaning (e.g. R-6's `check`) without the
 * amendment capability. The comparison itself never needed the schema — it is a
 * field-by-field check of `ACCEPTANCE_BAR_MEANING_FIELDS` per barKey — so run it on
 * the RAW stored criteria, exactly as the parsed path runs it on the parsed ones.
 *
 * - A BAR meaning change is refused for EVERY writer, amendment included. The parsed
 *   path lets an amendment through because it can re-derive and validate the final
 *   contract; this build cannot read the contract it would be amending, so it fails
 *   closed and names the build to retry on. (rubrics:amend reads the stored rubric
 *   through this same schema, so it cannot normally reach here anyway.)
 * - Everything else (METHOD edits, a federated replay of an unchanged peer row) is
 *   allowed, and the server-owned values are canonicalized FROM THE RAW STORED ROW the
 *   same way the parsed path canonicalizes them from the parsed one: contract via
 *   `deriveContract`, per-bar provenance via `deriveProvenance`, proposedBy/ratifiedBy
 *   preserved. A caller-supplied contract or provenance is never trusted.
 * - The stored `barSetHash` is preserved rather than recomputed. BAR meaning is
 *   unchanged by construction here, so the stored hash is still the truth, and this
 *   build is not the authority on how a newer build computes it.
 * - The final document is NOT re-parsed with this build's schema: it carries stored
 *   values this build cannot represent, which is the premise of this branch. Every
 *   value in it is either from `next` (validated above) or copied from the stored row.
 * - Stored fields this build's schema does not know are CARRIED FORWARD, not dropped
 *   (WI-6554700010018513): see `unknownStoredFields`.
 *
 * The federated whole-plan replay (sync/hyperbee/projections/harness-plans.ts) passes no
 * amendment, so a replayed meaning change is now refused here exactly as it already is
 * on the parsed path; an unchanged replay still passes.
 */
/**
 * WI-6554700010018513 — the stored fields a skewed write must carry forward.
 *
 * Under version skew `next` was parsed by THIS build's strict schema, so it cannot carry
 * a field a newer build added; spreading `next` alone silently dropped every such stored
 * field. This build is not the authority on fields it cannot read (the same reason the
 * stored barSetHash is preserved), so they are copied from the raw stored row: top-level
 * keys the template schema does not know, and per bar (matched by barKey) criterion keys
 * the criterion schema does not know. A key this build DOES know is never carried: its
 * absence from `next` is the writer's choice, judged by the checks in the caller. The
 * alternative policy, refusing the write, would block every METHOD fill (D-002) through
 * an older build for as long as any newer build had written to the row.
 *
 * Only the started-contract skew path may use this. The guard runs on EVERY plan's
 * template_data write, and on a non-rubric template every key is "unknown" to the rubric
 * schema, so the unstarted path must keep returning `next` unchanged.
 */
function unknownStoredFields(
  stored: Record<string, unknown> | undefined,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  if (!stored) return {};
  return Object.fromEntries(Object.entries(stored).filter(([key, value]) => !known.has(key) && value !== undefined));
}

function guardSkewedStartedContractWrite(
  args: AcceptanceBarWriteGuardInput,
  next: Record<string, unknown>,
  storedIssue: { path: PropertyKey[]; message: string } | undefined,
): AcceptanceBarWriteGuardResult {
  const where = storedIssue
    ? `${storedIssue.path.map(String).join('.') || '(root)'}: ${storedIssue.message}`
    : 'unknown field';
  const skew = (detail: string) =>
    new Error(
      `invalid_args: rubric '${args.slug}' has a started acceptance BAR contract that this build cannot ` +
        `validate (stored template_data fails this build's rubric schema at ${where}); ${detail}. Retry on a ` +
        'build whose rubric schema reads the stored rubric (version skew, WI-6554700010018489).',
    );
  const stored = args.storedTemplateData as Record<string, unknown>;
  const rawCriteria = Array.isArray(stored.criteria) ? stored.criteria : null;
  if (!rawCriteria || !rawCriteria.every(isPlainRecord)) {
    throw skew('the stored criteria are not a list of records, so BAR meaning cannot be compared');
  }
  assertServerOwnedIdentityUnchanged(args.slug, stored, next);
  const nextCriteria = (next.criteria as unknown[]).map((criterion) => criterion as Record<string, unknown>);
  const { priorByKey, changes, changedMeaning } = diffBarCriteria(rawCriteria, nextCriteria);
  if (changedMeaning) {
    throw skew(`refusing a write that changes BAR meaning (changes: ${describeMeaningChanges(changes)})`);
  }
  assertAmendmentAuthenticated(args);

  const now = args.now ?? new Date().toISOString();
  const contract = deriveContract(
    stored.barContract as AcceptanceBarContract,
    args.subjectPlan,
    next.barContract as AcceptanceBarContract | undefined,
  );
  const knownCriterionKeys = knownRubricCriterionKeys();
  const canonicalCriteria = nextCriteria.map((criterion) => {
    const prior = priorByKey.get(barKeyOf(criterion));
    const provenance = deriveProvenance(
      prior?.barProvenance as AcceptanceBarProvenance | undefined,
      contract,
      args.subjectPlan,
      args.actorId,
      args.amendment,
      now,
      false,
      criterion.barProvenance as AcceptanceBarProvenance | undefined,
    );
    return { ...unknownStoredFields(prior, knownCriterionKeys), ...criterion, barProvenance: provenance };
  });
  const storedSetHash = typeof stored.barSetHash === 'string' ? stored.barSetHash : undefined;
  const setHash = storedSetHash ?? barSetHash(canonicalCriteria);
  return {
    data: {
      ...unknownStoredFields(stored, new Set(Object.keys(rubricTemplateDataSchema.shape))),
      ...next,
      kind: 'acceptance',
      subjectPlan: stored.subjectPlan,
      criteria: canonicalCriteria,
      barContract: contract,
      ...(setHash ? { barSetHash: setHash } : {}),
      ...(stored.proposedBy !== undefined ? { proposedBy: stored.proposedBy } : {}),
      ...(stored.ratifiedBy !== undefined ? { ratifiedBy: stored.ratifiedBy } : {}),
    },
    started: true,
    changed: changes.length > 0,
    changes,
  };
}

/**
 * Guard every template_data persistence path after a subject's BAR contract has
 * started.  BAR meaning changes are rejected unless the caller is the canonical
 * amendment operation; provenance/approver fields are canonicalized from the
 * stored contract and subject-plan state, with conservative lifecycle corrections
 * allowed only by authenticated amendment. METHOD-only edits remain legal: D-002 deliberately fills the
 * METHOD after implementation.
 */
export function guardAcceptanceBarTemplateDataWrite(
  args: AcceptanceBarWriteGuardInput,
): AcceptanceBarWriteGuardResult {
  const storedParsed = rubricTemplateDataSchema.safeParse(args.storedTemplateData);
  const nextParsed = rubricTemplateDataSchema.safeParse(args.nextTemplateData);
  // WI-6554700010018464: a started contract is judged from the RAW stored document as
  // well as the parsed one. A stored rubric written by a NEWER build can fail this
  // build's strict schema (measured: d740fc3802 rejected R-6's `check.all` probe set),
  // and the parsed-only test then read "no contract" and let a generic writer drop it.
  const storedRawHasStartedContract = rawStoredHasStartedBarContract(args.storedTemplateData);
  if (!nextParsed.success) {
    // The registry/schema writer will provide the richer validation diagnostic;
    // this guard only adds the important started-BAR refusal for a destructive
    // clear or malformed direct upgrade.
    if ((storedParsed.success && storedParsed.data.barContract) || storedRawHasStartedContract) {
      throw new Error(
        `invalid_args: rubric '${args.slug}' has a started acceptance BAR contract; ` +
          'template_data cannot be cleared or replaced with an unvalidated shape outside rubrics:amend',
      );
    }
    return { data: (args.nextTemplateData ?? {}) as Record<string, unknown>, started: false, changed: false, changes: [] };
  }
  const next = nextParsed.data as unknown as Record<string, unknown>;
  // "Adopted" means a contract was actually SEEDED — not merely that the subject row carries
  // an epoch.  A cohort backfill stamps acceptance_bar_epoch/acceptance_bar_cohort onto plans
  // that never had a contract seeded (acceptance_bar_seeded_at/_by stay NULL), so testing the
  // bare epoch reads those plans as adopted and refuses EVERY generic template_data write to
  // their rubric — including the METHOD/model fills D-002 deliberately defers to after
  // implementation.  With no barContract there is nothing to protect, and the refusal names a
  // recovery path that cannot run without the very write it is refusing: a deadlock that
  // strands the plan short of ship.  Require the same seeding evidence
  // acceptance-bar-contract-snapshot.ts already treats as adoption.
  const subjectSeeded = Boolean(args.subjectPlan?.seededAt && args.subjectPlan?.seededBy);
  const pinnedRubricSlug = args.subjectPlan?.rubricSlug?.trim();
  // Seeding another rubric does not start this successor's contract. Authoring it
  // leaves the subject pin untouched; adoption still uses the canonical seed writer.
  // An unreadable/blank pin remains fail-closed, as does the pinned orphan itself.
  const distinctUnstartedSuccessor = Boolean(pinnedRubricSlug && pinnedRubricSlug !== args.slug);
  const adoptedSubjectHasOrphanedContract =
    storedParsed.success &&
    storedParsed.data.kind === 'acceptance' &&
    !storedParsed.data.barContract &&
    args.subjectPlan?.adoptionEpoch != null &&
    args.subjectPlan.adoptionEpoch > 0 &&
    subjectSeeded &&
    !distinctUnstartedSuccessor;
  if (adoptedSubjectHasOrphanedContract) {
    throw new Error(
      `invalid_args: rubric '${args.slug}' belongs to a subject that already adopted an acceptance BAR ` +
        `contract, but the stored rubric is missing its server-owned barContract; generic template_data ` +
        `writes are refused until the orphaned contract is repaired through the acceptance BAR recovery path: ` +
        `rubrics:amend { rubricRef:'${args.slug}', restoreOrphanedBarContract:true, reason, dryRun:true } ` +
        `(WI-6554700010018395), then apply without dryRun`,
    );
  }
  if (!storedParsed.success && storedRawHasStartedContract && !(next as { barContract?: unknown }).barContract) {
    // Version skew: this build cannot read the stored rubric, so it can neither verify
    // nor re-attach the started contract. Refuse rather than persist a document that
    // silently drops it (the 2026-10-18 strip of the cloud-monitoring rubric).
    // A write that CARRIES a contract (e.g. a federated replay of the newer peer's own
    // row) is not a drop; guardSkewedStartedContractWrite judges it against the raw row.
    const issue = storedParsed.error.issues[0];
    const where = issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown field';
    throw new Error(
      `invalid_args: rubric '${args.slug}' has a started acceptance BAR contract that this build cannot ` +
        `validate (stored template_data fails this build's rubric schema at ${where}); refusing a ` +
        'template_data write that would drop the contract. Retry on a build whose rubric schema reads ' +
        'the stored rubric (version skew, WI-6554700010018464).',
    );
  }
  if (!storedParsed.success && storedRawHasStartedContract) {
    // WI-6554700010018489: the write CARRIES a contract, so it is not a drop — but it is
    // still a write over a started contract this build cannot parse. Judge it against the
    // RAW stored row with the same BAR comparison the parsed path uses, instead of letting
    // it through unread.
    return guardSkewedStartedContractWrite(args, next, storedParsed.error.issues[0]);
  }
  if (!storedParsed.success || storedParsed.data.kind !== 'acceptance' || !storedParsed.data.barContract) {
    return { data: next, started: false, changed: false, changes: [] };
  }
  const stored = storedParsed.data as unknown as Record<string, unknown>;
  const storedContract = stored.barContract as AcceptanceBarContract;
  const storedCriteria = (stored.criteria as unknown[]).map((criterion) => criterion as Record<string, unknown>);
  const nextCriteria = (next.criteria as unknown[]).map((criterion) => criterion as Record<string, unknown>);
  assertServerOwnedIdentityUnchanged(args.slug, stored, next);

  const { priorByKey, changes, changedMeaning } = diffBarCriteria(storedCriteria, nextCriteria);
  if (changedMeaning && !args.amendment) {
    throw new Error(
      `invalid_args: rubric '${args.slug}' has a started acceptance BAR contract; ` +
        `BAR meaning cannot change outside rubrics:amend (changes: ${describeMeaningChanges(changes)})`,
    );
  }
  assertAmendmentAuthenticated(args);

  const now = args.now ?? new Date().toISOString();
  const contract = deriveContract(
    storedContract,
    args.subjectPlan,
    next.barContract as AcceptanceBarContract | undefined,
  );
  const canonicalCriteria = nextCriteria.map((criterion) => {
    const key = barKeyOf(criterion);
    const prior = priorByKey.get(key);
    const provenance = deriveProvenance(
      prior?.barProvenance as AcceptanceBarProvenance | undefined,
      contract,
      args.subjectPlan,
      args.actorId,
      args.amendment,
      now,
      Boolean(args.amendment && !prior),
      criterion.barProvenance as AcceptanceBarProvenance | undefined,
    );
    return { ...criterion, barProvenance: provenance };
  });
  const computedSetHash = barSetHash(canonicalCriteria);
  const canonicalData: Record<string, unknown> = {
    ...next,
    kind: 'acceptance',
    subjectPlan: stored.subjectPlan,
    criteria: canonicalCriteria,
    barContract: contract,
    ...(computedSetHash ? { barSetHash: computedSetHash } : { barSetHash: stored.barSetHash }),
    // These are server-owned provenance fields.  Preserve the existing values;
    // never accept a caller-authored replacement or a fabricated approver.
    ...(stored.proposedBy !== undefined ? { proposedBy: stored.proposedBy } : {}),
    ...(stored.ratifiedBy !== undefined ? { ratifiedBy: stored.ratifiedBy } : {}),
  };
  return {
    // Canonicalization adds server-owned values AFTER the incoming validation.
    // Validate that final shape too, so a DB representation cannot persist a
    // rubric that the next reader silently treats as absent.
    data: rubricTemplateDataSchema.parse(canonicalData) as unknown as Record<string, unknown>,
    started: true,
    changed: changes.length > 0,
    changes,
  };
}

/**
 * Resolve the acceptance-BAR MEANING EPOCH a write should record — the rubric
 * revision at which BAR meaning last changed.
 *
 * The rubric revision counter advances on EVERY amendment, including ones that
 * touch only METHOD (how a BAR is probed) and leave every BAR's meaning, and so
 * its `barHash`, byte-identical. Grading and vetting currentness must follow the
 * BAR contract the parties actually judged rather than that counter, or a typo
 * fix silently voids a peer's completed independent grading pass — putting the
 * whole cost of the amendment on the one party who already did the work.
 *
 * This reuses the SAME `ACCEPTANCE_BAR_MEANING_FIELDS` comparison
 * `guardAcceptanceBarTemplateDataWrite` uses to decide whether an amendment
 * needs approval, so "meaning changed" cannot come to mean two different things
 * in the two places that ask it.
 *
 * Returns `undefined` only when there is nothing to record. Absence is
 * preserved deliberately rather than defaulted to 1: a reader must fall back to
 * strict revision equality, because inventing an epoch here would bless a card
 * graded before an UNTRACKED meaning change as current — the failure this field
 * exists to prevent, in the dangerous direction.
 */
export function nextAcceptanceBarMeaningRevision(args: {
  priorCriteria: readonly unknown[];
  nextCriteria: readonly unknown[];
  priorMeaningRevision: number | null | undefined;
  priorRevision: number;
  nextRevision: number;
}): number | undefined {
  const asRecord = (criterion: unknown) => criterion as Record<string, unknown>;
  const priorByKey = new Map(args.priorCriteria.map((c) => [barKeyOf(asRecord(c)), asRecord(c)]));
  const nextByKey = new Map(args.nextCriteria.map((c) => [barKeyOf(asRecord(c)), asRecord(c)]));
  let meaningChanged = false;
  for (const [key, prior] of priorByKey) {
    const candidate = nextByKey.get(key);
    if (!candidate) {
      meaningChanged = true;
      break;
    }
    if (ACCEPTANCE_BAR_MEANING_FIELDS.some((field) => !equalValue(prior[field], candidate[field]))) {
      meaningChanged = true;
      break;
    }
  }
  if (!meaningChanged) {
    for (const key of nextByKey.keys()) {
      if (!priorByKey.has(key)) {
        meaningChanged = true;
        break;
      }
    }
  }
  if (meaningChanged) return args.nextRevision;
  // Meaning is unchanged, so the epoch stands. When none was ever recorded, the
  // latest revision that COULD have carried an untracked meaning change is the
  // prior one — adopt that as the floor rather than reaching further back.
  return args.priorMeaningRevision ?? args.priorRevision;
}
