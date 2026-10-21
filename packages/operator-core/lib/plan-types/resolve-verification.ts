/**
 * The registry-backed verification resolver (plan-item-types-registry-cupboard-2026-10-20).
 *
 * It answers "which verification modules apply to this plan item" from item-type and plan-type
 * DEFINITIONS, and since P-002 it is the default behind `resolveVerification`:
 * - the plan's plan type is its declared `type:` slug, or else the first-party plan type of its
 *   profile (`papercusp/coding`, `papercusp/general`);
 * - a declared deliverable names its item type: a built-in kind maps to `papercusp/<kind>`, a
 *   namespaced slug (`acme/legal-review`) is used as written;
 * - an item with no declared deliverable and no non-code signal gets the plan type's
 *   `defaultItemType`;
 * - code-ness is "the resolved module set includes `code`", never a comparison with a kind
 *   literal, so a third-party item type is code exactly when it says so.
 *
 * Today's non-code signals (a `not-code` completion-audit verdict, the `task` work-item kind)
 * keep their meaning: generic-core plus any opted-in domain modules, with no item type.
 *
 * FAIL SAFE: a plan type or item type the registry cannot resolve (absent, retired, outside the
 * referenced revision range, or an invalid row) resolves to the FULL module catalog. A missing
 * definition can never lower the checks an item is held to. Activation refuses such a plan
 * outright and names what to install (`findUnregisteredTypes`).
 *
 * LOAD ORDER: plan-verification-profile.ts imports this module as its default resolver, so this
 * module is evaluated while that one is still evaluating. Everything read at module-evaluation
 * time here comes from leaf modules; the profile module's helpers are only called at resolve time.
 */
import { isDeliverableKind, isTypeSlug, isVerificationProfile } from '@papercusp/plan-parser';
import {
  INFERRED_PLAN_PROFILE,
  isNonCodeAuditVerdict,
  isNonCodeWorkItemKind,
  type DeliverableKind,
  type DeliverableSource,
  type VerificationItemInput,
  type VerificationPlanInput,
  type VerificationResolution,
  type VerificationResolver,
} from '../plan-verification-profile';
import { builtinItemTypeId, builtinKindOf, builtinPlanTypeId } from './builtin-catalog';
import {
  FLOOR_MODULE,
  normalizeModules,
  type ItemTypeDefinition,
  type PlanTypeDefinition,
  type TypeReference,
} from './definitions';
import { buildTypeRegistrySnapshot, type RegisteredDefinition, type TypeRegistrySnapshot } from './registry';
import { VERIFICATION_MODULES, type VerificationModule } from './verification-modules';

/** The strictest module set: what an unresolvable type is held to. */
export const STRICTEST_MODULES: readonly VerificationModule[] = Object.freeze([...VERIFICATION_MODULES]);

/**
 * The resolution-time half of the generic-core floor (R-9). While the parse floor and
 * `normalizeModules` hold, every resolved set already includes generic-core. If either ever
 * regresses, or a definition reaches the resolver some other way, the item fails safe to the
 * full catalog instead of losing its generic checks.
 */
export function holdToFloor(modules: VerificationModule[]): VerificationModule[] {
  return modules.includes(FLOOR_MODULE) ? modules : [...STRICTEST_MODULES];
}

/** The plan type a plan resolves through: its declared `type:` slug, else its profile's first-party type. */
export function planTypeIdFor(plan: VerificationPlanInput): string {
  if (isTypeSlug(plan.planType)) return plan.planType;
  const profile = isVerificationProfile(plan.verificationProfile) ? plan.verificationProfile : INFERRED_PLAN_PROFILE;
  return builtinPlanTypeId(profile);
}

/** The item type an item declares, or null when it declares none (or an unparseable value). */
export function declaredItemTypeId(item: Pick<VerificationItemInput, 'deliverable'>): string | null {
  if (isDeliverableKind(item.deliverable)) return builtinItemTypeId(item.deliverable);
  if (isTypeSlug(item.deliverable)) return item.deliverable;
  return null;
}

function laterBound(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function earlierBound(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

/**
 * An item-type reference held to the revision range its plan type lists for that id. The two
 * ranges intersect, so neither a declared deliverable nor the plan type's own default can
 * reach a revision outside what the plan type references (a later revision never re-grades it).
 */
export function heldToPlanType(
  planType: RegisteredDefinition<PlanTypeDefinition> | null,
  ref: TypeReference,
): TypeReference {
  const listed = planType?.definition.itemTypes.find((candidate) => candidate.id === ref.id);
  if (!listed) return ref;
  const minRevision = laterBound(ref.minRevision, listed.minRevision);
  const maxRevision = earlierBound(ref.maxRevision, listed.maxRevision);
  return {
    id: ref.id,
    ...(minRevision === undefined ? {} : { minRevision }),
    ...(maxRevision === undefined ? {} : { maxRevision }),
  };
}

/** A pinned revision: what a plan resolved at activation (P-005, harness_shared.plan_type_pins). */
export interface TypePin {
  revision: number;
  contentHash: string;
}

/** A plan's pins, by type id. */
export interface PlanTypePins {
  itemTypes: ReadonlyMap<string, TypePin>;
  planTypes: ReadonlyMap<string, TypePin>;
}

export type TypeKind = 'item-type' | 'plan-type';

/** One type a resolution touched: what the pin writer records for it. */
export interface ResolvedTypeRef {
  kind: TypeKind;
  id: string;
  revision: number;
  contentHash: string;
}

export interface RegistryResolverOptions {
  /** The plan's pins. A pinned id resolves exactly its pinned revision, retired or not. */
  pins?: PlanTypePins | null;
  /** Called for the plan type and every item type a resolution used, parents included. */
  onResolved?: (ref: ResolvedTypeRef) => void;
}

/** How deep an `extends` chain may go before it is treated as unresolvable. */
export const MAX_EXTENDS_DEPTH = 8;

type Lookup<T> = RegisteredDefinition<T> | null;

/**
 * A pinned id resolves exactly its pinned revision, and only while that revision's content
 * still matches the pin; anything else is unresolvable, which fails safe. An unpinned id
 * resolves the highest non-retired revision in range.
 */
function lookupPinned<T>(
  id: string,
  range: TypeReference,
  pin: TypePin | undefined,
  latest: (id: string, range: TypeReference) => Lookup<T>,
  exact: (id: string, revision: number) => Lookup<T>,
): Lookup<T> {
  if (!pin) return latest(id, range);
  const found = exact(id, pin.revision);
  return found && found.contentHash === pin.contentHash ? found : null;
}

export function createRegistryVerificationResolver(
  registry: TypeRegistrySnapshot = buildTypeRegistrySnapshot(),
  options: RegistryResolverOptions = {},
): VerificationResolver {
  const pins = options.pins ?? null;
  const record = (kind: TypeKind, found: RegisteredDefinition<{ id: string; revision: number }>) =>
    options.onResolved?.({ kind, id: found.definition.id, revision: found.definition.revision, contentHash: found.contentHash });

  /**
   * An item type's effective module set: its own modules plus its parent's effective set
   * (`extends`), so a child can never drop what its parent requires. Null when the type, or
   * any parent, cannot be resolved, or the chain cycles or runs deeper than MAX_EXTENDS_DEPTH.
   */
  const itemTypeModules = (
    ref: TypeReference,
    seen: ReadonlySet<string> = new Set(),
  ): { found: RegisteredDefinition<ItemTypeDefinition>; modules: VerificationModule[] } | null => {
    if (seen.has(ref.id) || seen.size >= MAX_EXTENDS_DEPTH) return null;
    const found = lookupPinned(
      ref.id,
      ref,
      pins?.itemTypes.get(ref.id),
      (id, range) => registry.itemType(id, range),
      (id, revision) => registry.itemTypeAt(id, revision),
    );
    if (!found) return null;
    let modules = [...found.definition.modules];
    const parentRef = found.definition.extends;
    if (parentRef) {
      const parent = itemTypeModules(parentRef, new Set([...seen, ref.id]));
      if (!parent) return null;
      modules = normalizeModules([...modules, ...parent.modules]);
    }
    record('item-type', found);
    return { found, modules };
  };

  return (plan, item): VerificationResolution => {
    const planTypeId = planTypeIdFor(plan);
    const planType = lookupPinned(
      planTypeId,
      { id: planTypeId },
      pins?.planTypes.get(planTypeId),
      (id, range) => registry.planType(id, range),
      (id, revision) => registry.planTypeAt(id, revision),
    );
    if (planType) record('plan-type', planType);
    const declaredProfile = isVerificationProfile(plan.verificationProfile) ? plan.verificationProfile : null;
    // A resolved plan type's base IS the profile it replaces; otherwise the declared profile.
    const profile = planType?.definition.base ?? declaredProfile ?? INFERRED_PLAN_PROFILE;
    const profileSource = isTypeSlug(plan.planType) || declaredProfile ? 'declared' : 'inferred';
    const domainModules = item.domainModules ?? [];

    let reference: TypeReference | null;
    let deliverableSource: DeliverableSource;
    const declared = declaredItemTypeId(item);
    if (declared !== null) {
      // A declared type is held to the plan type's referenced revision range when it lists one.
      reference = heldToPlanType(planType, { id: declared });
      deliverableSource = 'declared';
    } else if (isNonCodeAuditVerdict(item.auditVerdict)) {
      reference = null;
      deliverableSource = 'audit-verdict';
    } else if (isNonCodeWorkItemKind(item.workItemKind)) {
      reference = null;
      deliverableSource = 'work-item-kind';
    } else {
      // An unresolvable plan type has no default to offer: name a reference that cannot
      // resolve, so the item fails safe below instead of borrowing another type's default.
      reference = planType ? heldToPlanType(planType, planType.definition.defaultItemType) : { id: planTypeId };
      deliverableSource = 'profile-default';
    }

    let deliverable: DeliverableKind | null;
    let itemType: string | null;
    let modules: VerificationModule[];
    if (reference === null) {
      deliverable = null;
      itemType = null;
      modules = normalizeModules(domainModules);
    } else {
      const resolved = itemTypeModules(reference);
      itemType = resolved?.found.definition.id ?? reference.id;
      deliverable = builtinKindOf(itemType);
      modules = resolved
        ? normalizeModules([...resolved.modules, ...domainModules])
        : [...STRICTEST_MODULES];
    }
    modules = holdToFloor(modules);
    return {
      profile,
      profileSource,
      deliverable,
      itemType,
      codeDeliverable: modules.includes('code'),
      deliverableSource,
      modules,
    };
  };
}

/** One type a plan references that the workspace registry cannot resolve. */
export interface UnregisteredType {
  kind: 'plan-type' | 'item-type';
  id: string;
  /** Plan items that reference it (empty for the plan type). */
  itemIds: string[];
  /** What to install: the Cupboard pack search that provides this type. */
  install: string;
}

function installHint(id: string): string {
  const namespace = id.split('/')[0] ?? id;
  return `install the Cupboard pack that provides "${id}" (cupboard search: ${id}; publisher namespace "${namespace}")`;
}

/**
 * The types a plan references that the registry cannot resolve: its plan type and every
 * declared item type. Activation refuses a plan with any (R-6); `unregisteredTypesRefusal`
 * renders the refusal. An already-active plan whose type later vanishes is not refused here:
 * it keeps resolving to the strictest module set.
 */
export function findUnregisteredTypes(
  plan: VerificationPlanInput,
  items: ReadonlyArray<{ id: string; deliverable?: string | null }>,
  registry: TypeRegistrySnapshot = buildTypeRegistrySnapshot(),
): UnregisteredType[] {
  const out: UnregisteredType[] = [];
  const planTypeId = planTypeIdFor(plan);
  const planType = registry.planType(planTypeId);
  if (!planType) out.push({ kind: 'plan-type', id: planTypeId, itemIds: [], install: installHint(planTypeId) });
  const byItemType = new Map<string, string[]>();
  for (const item of items) {
    const declared = declaredItemTypeId(item);
    if (declared === null) continue;
    if (registry.itemType(declared, heldToPlanType(planType, { id: declared }))) continue;
    byItemType.set(declared, [...(byItemType.get(declared) ?? []), item.id]);
  }
  for (const [id, itemIds] of byItemType) out.push({ kind: 'item-type', id, itemIds, install: installHint(id) });
  return out;
}

/** The activation refusal for unregistered types, or null when every type resolves. */
export function unregisteredTypesRefusal(unregistered: readonly UnregisteredType[]): string | null {
  if (unregistered.length === 0) return null;
  const lines = unregistered.map((u) =>
    u.kind === 'plan-type'
      ? `- plan type "${u.id}" is not registered in this workspace: ${u.install}.`
      : `- item type "${u.id}" (used by ${u.itemIds.join(', ')}) is not registered in this workspace: ${u.install}.`,
  );
  return [
    'unregistered_type: this plan references types this workspace does not have, so it cannot be activated.',
    ...lines,
    'Until they are installed an item of an unregistered type would be held to every verification module.',
  ].join('\n');
}
