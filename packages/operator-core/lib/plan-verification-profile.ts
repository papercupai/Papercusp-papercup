/**
 * Plan verification profiles: the ONE resolver that answers "which verification
 * modules apply to this plan item" (plan-verification-profiles-2026-10-17).
 *
 * Model (plan § Design):
 * - the generic core applies to every item: shaping, activation audit,
 *   requirements → BARs, governance, completion integrity, root-cause verification,
 *   rubric vetting, independent grading, implementer verdict and blind review;
 * - the code module applies to CODE deliverables only, in any profile (D-001):
 *   the code-truth audit with blob SHAs, spec-test adequacy (L3/L4, mutation),
 *   test-ledger freshness, and `testsRun`/`filesChanged` at completion;
 * - domain modules are opt-in: design evidence and packaged artifact.
 * A profile only sets the DEFAULT deliverable: `coding` makes it code, `general`
 * makes it non-code. The plan class sits beneath the profile (D-003). Independent
 * grading is in the generic core, so it applies to both profiles (D-002).
 *
 * P-001 phase: no behaviour change. Neither the plan profile nor the item
 * deliverable is declared yet (P-002 adds those fields). So both are INFERRED
 * from the signals the gates already honour. Every plan is verified as `coding`,
 * and an item is non-code only through a `not-code` completion-audit verdict or
 * the `task` work-item kind. The six exemptions that each gate used to decide
 * locally now call the predicates below. The boundary guard
 * (`plan-verification-profile-boundary.test.ts`) refuses new local copies.
 *
 * Keep this module a LEAF: type-only imports from operator-core, so any gate can
 * import it without creating a runtime import cycle. The profile and deliverable
 * vocabulary is owned by `@papercusp/plan-parser` (the item keyword is plan text,
 * P-002); that generic lib imports nothing from operator-core.
 */
import type { AdequacyCriterion } from './agent-tools/plans/spec-test-adequacy';
import {
  isDeliverableKind,
  isVerificationProfile,
  type DeliverableKind,
  type VerificationProfile,
} from '@papercusp/plan-parser';

export {
  DELIVERABLE_KINDS,
  VERIFICATION_PROFILES,
  isDeliverableKind,
  isVerificationProfile,
  type DeliverableKind,
  type VerificationProfile,
} from '@papercusp/plan-parser';

export const VERIFICATION_MODULES = ['generic-core', 'code', 'design-evidence', 'packaged-artifact'] as const;
export type VerificationModule = (typeof VERIFICATION_MODULES)[number];

export const DOMAIN_MODULES = ['design-evidence', 'packaged-artifact'] as const satisfies readonly VerificationModule[];
export type DomainModule = (typeof DOMAIN_MODULES)[number];

/** The module list: which family of checks each module owns. */
export const VERIFICATION_MODULE_CHECKS: Readonly<Record<VerificationModule, readonly string[]>> = {
  'generic-core': [
    'shaping',
    'activation-audit',
    'requirements-to-bars',
    'governance',
    'completion-integrity',
    'root-cause-verification',
    'rubric-vetting',
    'independent-grading',
    'implementer-verdict',
    'blind-review',
  ],
  code: ['code-truth-audit', 'spec-test-adequacy', 'test-ledger-freshness', 'completion-tests-and-files'],
  'design-evidence': ['design-evidence'],
  'packaged-artifact': ['packaged-artifact'],
};

/**
 * The deliverable an item gets when it declares none. `general` needs one concrete
 * non-code kind; `artifact` is the least specific, and P-002 may revise it when the
 * declared field lands.
 */
export const PROFILE_DEFAULT_DELIVERABLE: Readonly<Record<VerificationProfile, DeliverableKind>> = {
  coding: 'code',
  general: 'artifact',
};

/** P-001: no plan declares a profile yet, and today's gates verify every plan as coding. */
export const INFERRED_PLAN_PROFILE: VerificationProfile = 'coding';

// ---------------------------------------------------------------------------
// Today's non-code signals: the six exemptions, routed here.
// ---------------------------------------------------------------------------

export const NOT_CODE_AUDIT_VERDICT = 'not-code' as const;
export const NON_CODE_WORK_ITEM_KIND = 'task' as const;
export const NON_AUTOMATED_BEHAVIOR_CLASS = 'non-automated' as const;

/** Exemption 1: the completion audit classified the item's deliverable as not source code. */
export function isNonCodeAuditVerdict(verdict: string | null | undefined): boolean {
  return verdict === NOT_CODE_AUDIT_VERDICT;
}

/**
 * Exemption 6's selector: a not-code audit verdict that carries its reason. Only these
 * items may resolve the explicit non-code exemption contract in requirement realization.
 */
export function isReasonedNonCodeAudit(
  entry: { verdict: string; note?: string | null } | null | undefined,
): boolean {
  return Boolean(entry && isNonCodeAuditVerdict(entry.verdict) && entry.note?.trim());
}

/**
 * Exemption 2: `task` is the canonical non-code work-item kind (research was folded
 * into it), so executable test-proof floors do not apply to a task even when a plan
 * clause was projected with a behaviour class that would otherwise require L3/L4.
 */
export function isNonCodeWorkItemKind(kind: string | null | undefined): boolean {
  return typeof kind === 'string' && kind.trim().toLowerCase() === NON_CODE_WORK_ITEM_KIND;
}

/** Exemption 3: a spec clause declared as not automatable. */
export function isNonAutomatedBehaviorClass(behaviorClass: string | null | undefined): boolean {
  return behaviorClass === NON_AUTOMATED_BEHAVIOR_CLASS;
}

/**
 * Exemption 4: the adequacy criteria that only EXECUTABLE proof can satisfy: a
 * ledger-backed test run, a mutation/counterexample row, or a repo-files measurement.
 * When a clause has no executable proof floor (`requiredProofFloor` returns 'none'),
 * these criteria become not-applicable. Grading non-code work against them would
 * demand an artifact that cannot exist for it, at any effort.
 *
 * A new adequacy criterion that needs a ledger row or a repo file belongs here AND in
 * `ADEQUACY_CRITERIA` (agent-tools/plans/spec-test-adequacy.ts). One that an honest
 * attestation can satisfy belongs only there.
 */
export const EXECUTABLE_PROOF_CRITERIA = [
  'falsifiability',
  'execution-integrity',
  'freshness',
] as const satisfies readonly AdequacyCriterion[];

export type ExecutableProofExemption = 'non-code-work-item-kind' | 'non-code-deliverable' | 'non-automated-clause';

/**
 * Which non-code signal exempts a clause from the code module's executable-proof floor,
 * checked in the order `requiredProofFloor` always used. Null means the floor applies.
 *
 * P-004: `codeDeliverable` is the resolver's verdict for the clause's plan item (its plan's
 * stamped profile plus the item's declared deliverable). Only an explicit `false` exempts:
 * an unread or unknown deliverable stays code, so a failed read never lowers the floor (D-005).
 */
export function executableProofExemption(input: {
  workItemKind?: string | null;
  codeDeliverable?: boolean | null;
  behaviorClass: string;
  requiredTestLayers: readonly unknown[];
}): ExecutableProofExemption | null {
  if (isNonCodeWorkItemKind(input.workItemKind)) return 'non-code-work-item-kind';
  if (input.codeDeliverable === false) return 'non-code-deliverable';
  if (isNonAutomatedBehaviorClass(input.behaviorClass) && input.requiredTestLayers.length === 0) {
    return 'non-automated-clause';
  }
  return null;
}

/**
 * Exemption 5: whether every unfinished item is explicitly classified as non-code by
 * the effective completion audit. This is a narrow lifecycle rule. Widening it by
 * accident would recruit graders while real implementation work is still open.
 *
 * P-004 (D-006, D-009): the verdict is read through the resolver, so the declarations in
 * force NOW decide. A `not-code` verdict on an item whose DECLARED deliverable is `code`
 * (an audit recorded before the declaration) resolves to code and keeps the item out of the
 * tail. The profile alone never admits an item: it still needs the explicit verdict.
 */
export function unfinishedItemsAreAuditedNonCode(
  unfinished: readonly { itemId: string; deliverable?: string | null }[],
  effectiveAudits: readonly { entry: { itemId: string; verdict: string } }[],
  plan: VerificationPlanInput = {},
): boolean {
  if (unfinished.length === 0) return false;
  const verdictByItem = new Map(effectiveAudits.map(({ entry }) => [entry.itemId, entry.verdict]));
  return unfinished.every((item) => {
    const auditVerdict = verdictByItem.get(item.itemId);
    return isNonCodeAuditVerdict(auditVerdict) &&
      !resolveVerification(plan, { deliverable: item.deliverable ?? null, auditVerdict }).codeDeliverable;
  });
}

// ---------------------------------------------------------------------------
// The resolver.
// ---------------------------------------------------------------------------

export interface VerificationPlanInput {
  /** Declared from P-002; absent today, so the profile is inferred. */
  verificationProfile?: string | null;
}

export interface VerificationItemInput {
  /** Declared from P-002; absent today, so the deliverable is inferred. */
  deliverable?: string | null;
  /** The item's effective completion-audit verdict, when one exists. */
  auditVerdict?: string | null;
  /** The kind of the work item that implements the plan item. */
  workItemKind?: string | null;
  /** Opt-in domain modules. */
  domainModules?: readonly DomainModule[];
}

export type DeliverableSource = 'declared' | 'audit-verdict' | 'work-item-kind' | 'profile-default';

export interface VerificationResolution {
  profile: VerificationProfile;
  profileSource: 'declared' | 'inferred';
  /**
   * The declared deliverable kind or the profile default. Null when a signal shows the
   * work is non-code but no kind has been declared yet.
   */
  deliverable: DeliverableKind | null;
  codeDeliverable: boolean;
  deliverableSource: DeliverableSource;
  /** Always starts with 'generic-core'; never empty. */
  modules: readonly VerificationModule[];
}

/** The modules that apply to a deliverable: the generic core, plus code for code, plus opt-ins. */
export function modulesFor(
  codeDeliverable: boolean,
  domainModules: readonly DomainModule[] = [],
): VerificationModule[] {
  const modules: VerificationModule[] = ['generic-core'];
  if (codeDeliverable) modules.push('code');
  for (const module of DOMAIN_MODULES) if (domainModules.includes(module)) modules.push(module);
  return modules;
}

/** What plans:get shows: the checklist a plan will be held to (P-002, R-4). */
export interface PlanVerificationSummary {
  profile: VerificationProfile;
  /** How the stamped profile was set; `unstamped` = no stamp yet, so the profile is inferred. */
  profileSource: 'declared' | 'harness-default' | 'backfill' | 'unstamped';
  defaultDeliverable: DeliverableKind;
  /** Modules every item without an override is held to. */
  defaultModules: readonly VerificationModule[];
  /** Items that declare their own deliverable kind. */
  overrides: Array<{ id: string; deliverable: DeliverableKind; modules: readonly VerificationModule[] }>;
}

const PROFILE_SOURCES = ['declared', 'harness-default', 'backfill'] as const;

export function summarizePlanVerification(
  plan: { verificationProfile?: string | null; verificationProfileSource?: string | null },
  items: ReadonlyArray<{ id: string; deliverable?: string | null }>,
): PlanVerificationSummary {
  const stamped = isVerificationProfile(plan.verificationProfile);
  const profile = stamped ? (plan.verificationProfile as VerificationProfile) : INFERRED_PLAN_PROFILE;
  const source = plan.verificationProfileSource;
  const profileSource =
    stamped && (PROFILE_SOURCES as readonly string[]).includes(source ?? '')
      ? (source as PlanVerificationSummary['profileSource'])
      : 'unstamped';
  const defaultDeliverable = PROFILE_DEFAULT_DELIVERABLE[profile];
  const overrides: PlanVerificationSummary['overrides'] = [];
  for (const item of items) {
    if (!isDeliverableKind(item.deliverable)) continue;
    overrides.push({ id: item.id, deliverable: item.deliverable, modules: modulesFor(item.deliverable === 'code') });
  }
  return {
    profile,
    profileSource,
    defaultDeliverable,
    defaultModules: modulesFor(defaultDeliverable === 'code'),
    overrides,
  };
}

/**
 * P-004: the one phrase every profile-aware refusal uses to name the plan's profile and
 * how it was set, so a reader can tell a declared general plan from an inferred coding one.
 */
export function describeVerificationProfile(plan: {
  verificationProfile?: string | null;
  verificationProfileSource?: string | null;
}): string {
  if (!isVerificationProfile(plan.verificationProfile)) {
    return `Verification profile '${INFERRED_PLAN_PROFILE}' (unstamped, inferred)`;
  }
  const source = (PROFILE_SOURCES as readonly string[]).includes(plan.verificationProfileSource ?? '')
    ? plan.verificationProfileSource
    : 'stamped';
  return `Verification profile '${plan.verificationProfile}' (${source})`;
}

/**
 * Resolve the verification modules for one plan item. A declared deliverable wins.
 * Otherwise today's non-code signals decide, and otherwise the profile default does.
 * A declared value outside the known vocabulary is ignored, so it can neither throw
 * nor invent a module set.
 */
export function resolveVerification(
  plan: VerificationPlanInput,
  item: VerificationItemInput,
): VerificationResolution {
  const declaredProfile = isVerificationProfile(plan.verificationProfile) ? plan.verificationProfile : null;
  const profile = declaredProfile ?? INFERRED_PLAN_PROFILE;
  const profileSource = declaredProfile ? 'declared' : 'inferred';
  const domainModules = item.domainModules ?? [];

  let deliverable: DeliverableKind | null;
  let deliverableSource: DeliverableSource;
  if (isDeliverableKind(item.deliverable)) {
    deliverable = item.deliverable;
    deliverableSource = 'declared';
  } else if (isNonCodeAuditVerdict(item.auditVerdict)) {
    deliverable = null;
    deliverableSource = 'audit-verdict';
  } else if (isNonCodeWorkItemKind(item.workItemKind)) {
    deliverable = null;
    deliverableSource = 'work-item-kind';
  } else {
    deliverable = PROFILE_DEFAULT_DELIVERABLE[profile];
    deliverableSource = 'profile-default';
  }
  const codeDeliverable = deliverable === 'code';
  return {
    profile,
    profileSource,
    deliverable,
    codeDeliverable,
    deliverableSource,
    modules: modulesFor(codeDeliverable, domainModules),
  };
}
