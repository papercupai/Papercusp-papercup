/**
 * Plan type pins (plan-item-types-registry-cupboard-2026-10-20 P-005, R-14, D-006).
 *
 * A plan pins every type it resolves: its plan type, each item type, and each parent reached
 * through `extends`. A pin is a row of harness_shared.plan_type_pins (migration 1545) holding the
 * revision and content hash the plan resolved. Under `withPlanTypeResolution` every
 * `resolveVerification` call for that plan resolves exactly the pinned revisions, so a newer
 * revision, or retiring the pinned one, never changes the ship, start or completion checks the
 * plan is held to.
 *
 * WRITES: pins are inserted, never overwritten, when a plan activates and when an activated plan
 * first resolves a type it has no pin for (`insertPinsIfAbsent`). Migration 1545 backfilled every
 * plan activated before the registry to the first-party revision 1. Only plan-types:pin changes
 * an existing pin, and it runs the lowering check first.
 */
import type postgres from 'postgres';
import { parsePlan } from '@papercusp/plan-parser';
import {
  activeVerificationResolver,
  withVerificationResolver,
  type VerificationResolver,
} from '../plan-verification-profile';
import { loadTypeRegistry, type TypeRegistrySnapshot } from './registry';
import {
  createRegistryVerificationResolver,
  type PlanTypePins,
  type ResolvedTypeRef,
  type TypeKind,
  type TypePin,
} from './resolve-verification';

type Sql = postgres.Sql | postgres.TransactionSql;

export interface PlanPinScope {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

export interface PinRow {
  kind: TypeKind;
  type_id: string;
  revision: number;
  content_hash: string;
}

export const NO_PINS: PlanTypePins = Object.freeze({ itemTypes: new Map(), planTypes: new Map() });

export function pinsFromRows(rows: readonly PinRow[]): PlanTypePins {
  const itemTypes = new Map<string, TypePin>();
  const planTypes = new Map<string, TypePin>();
  for (const row of rows) {
    const pin = { revision: Number(row.revision), contentHash: row.content_hash };
    (row.kind === 'plan-type' ? planTypes : itemTypes).set(row.type_id, pin);
  }
  return { itemTypes, planTypes };
}

export async function loadPlanPins(sql: Sql, scope: PlanPinScope): Promise<PlanTypePins> {
  const rows = await sql<PinRow[]>`
    SELECT kind, type_id, revision, content_hash
      FROM harness_shared.plan_type_pins
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}`;
  return pinsFromRows(rows);
}

/** Every resolved type once (first resolution wins), skipping ids the plan already pins. */
export function newPins(resolved: Iterable<ResolvedTypeRef>, existing: PlanTypePins = NO_PINS): ResolvedTypeRef[] {
  const out = new Map<string, ResolvedTypeRef>();
  for (const ref of resolved) {
    const key = `${ref.kind}\u0000${ref.id}`;
    const pinned = ref.kind === 'plan-type' ? existing.planTypes.has(ref.id) : existing.itemTypes.has(ref.id);
    if (pinned || out.has(key)) continue;
    out.set(key, ref);
  }
  return [...out.values()];
}

/**
 * Pin each resolved type the plan has no pin for. Never overwrites an existing pin: a
 * concurrent writer that pinned first wins, and that is the revision the plan keeps.
 * Returns the number of pins written.
 */
export async function insertPinsIfAbsent(
  sql: Sql,
  scope: PlanPinScope,
  resolved: Iterable<ResolvedTypeRef>,
  pinnedBy: string,
  reason: string,
): Promise<number> {
  const rows = newPins(resolved).map((ref) => ({
    workspace_id: scope.workspaceId,
    harness_slug: scope.harnessSlug,
    plan_slug: scope.planSlug,
    kind: ref.kind,
    type_id: ref.id,
    revision: ref.revision,
    content_hash: ref.contentHash,
    pinned_by: pinnedBy,
    pin_reason: reason,
  }));
  if (rows.length === 0) return 0;
  const inserted = await sql`
    INSERT INTO harness_shared.plan_type_pins ${sql(
      rows,
      'workspace_id', 'harness_slug', 'plan_slug', 'kind', 'type_id', 'revision', 'content_hash', 'pinned_by', 'pin_reason',
    )}
    ON CONFLICT DO NOTHING
    RETURNING 1`;
  return inserted.length;
}

export interface PlanTypeResolution {
  registry: TypeRegistrySnapshot;
  pins: PlanTypePins;
  /** The plan's declared plan type (`type:` frontmatter), or null for its profile's built-in. */
  planType: string | null;
  /** Every type resolved inside the scope so far, in resolution order (duplicates included). */
  resolved: ResolvedTypeRef[];
  /** The resolver: the registry under the pins, with the declared plan type filled in. */
  resolver: VerificationResolver;
}

/** A plan's declared plan type: its `type:` frontmatter, trimmed, or null when absent. */
export function declaredPlanType(content: string | null | undefined): string | null {
  if (!content) return null;
  const type = parsePlan(content).frontmatter.type;
  return typeof type === 'string' && type.trim() !== '' ? type.trim() : null;
}

export async function readPlanDeclaredType(sql: Sql, scope: PlanPinScope): Promise<string | null> {
  const [row] = await sql<{ content: string | null }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}`;
  return declaredPlanType(row?.content);
}

/**
 * The registry resolver under a plan's pins. Most gates read only the plan's profile column,
 * so a call that does not say which plan type it means (`planType` undefined) gets the plan's
 * declared one. A call that passes a plan type, null included, is answered for that type: the
 * lowering check compares a body's before and after types this way.
 */
export function createPlanTypeResolver(input: {
  registry: TypeRegistrySnapshot;
  pins: PlanTypePins;
  planType: string | null;
  resolved?: ResolvedTypeRef[];
}): VerificationResolver {
  const base = createRegistryVerificationResolver(input.registry, {
    pins: input.pins,
    ...(input.resolved ? { onResolved: (ref: ResolvedTypeRef) => input.resolved!.push(ref) } : {}),
  });
  return (plan, item) =>
    base(plan.planType === undefined && input.planType !== null ? { ...plan, planType: input.planType } : plan, item);
}

/** Read everything one plan resolves under: the workspace registry, the plan's pins and its declared type. */
export async function loadPlanTypes(
  sql: Sql,
  scope: PlanPinScope,
  opts: { registry?: TypeRegistrySnapshot; planType?: string | null } = {},
): Promise<PlanTypeResolution> {
  const [registry, pins, planType] = await Promise.all([
    opts.registry ? Promise.resolve(opts.registry) : loadTypeRegistry(sql, { workspaceId: scope.workspaceId }),
    loadPlanPins(sql, scope),
    opts.planType !== undefined ? Promise.resolve(opts.planType) : readPlanDeclaredType(sql, scope),
  ]);
  const resolved: ResolvedTypeRef[] = [];
  return { registry, pins, planType, resolved, resolver: createPlanTypeResolver({ registry, pins, planType, resolved }) };
}

/**
 * Run `fn` with every `resolveVerification` call inside it answered from the workspace registry
 * under this plan's pins and declared plan type. `resolved` collects what the scope resolved,
 * for a writer that pins it afterwards.
 */
export async function withPlanTypeResolution<T>(
  sql: Sql,
  scope: PlanPinScope,
  fn: (resolution: PlanTypeResolution) => Promise<T>,
  opts: { registry?: TypeRegistrySnapshot } = {},
): Promise<T> {
  const resolution = await loadPlanTypes(sql, scope, opts);
  return withVerificationResolver(resolution.resolver, () => fn(resolution));
}

/**
 * The entry the gates that judge one plan use (ship, start, completion). The plan is held to
 * the revisions it pinned and to its declared plan type. The registry and pins are read in a
 * short transaction of their own; `fn` runs outside it, so a long gate never holds one open.
 *
 * A resolver already in force wins: the census installs the legacy resolver to compare it with
 * the registry, and the lowering check installs its own, so neither may be replaced here. That
 * also makes nested gates for the same plan read the pins once.
 */
export async function withPinnedPlanTypes<T>(
  scope: { workspaceId?: string; harnessSlug?: string; planSlug: string },
  fn: () => Promise<T>,
): Promise<T> {
  const resolver = await pinnedPlanTypeResolver(scope);
  return resolver ? withVerificationResolver(resolver, fn) : fn();
}

/**
 * The resolver `withPinnedPlanTypes` installs for this plan, or null when a resolver is already
 * in force (that one wins, as there). For a caller whose `resolveVerification` calls sit inside a
 * long synchronous stretch it cannot wrap whole, such as plans:audit's per-item loop.
 */
export async function pinnedPlanTypeResolver(
  scope: { workspaceId?: string; harnessSlug?: string; planSlug: string },
): Promise<PlanTypeResolution['resolver'] | null> {
  if (activeVerificationResolver()) return null;
  const { resolvePlanScope } = await import('../agent-tools/plans/source');
  const { withWorkspace } = await import('@papercusp/db-org');
  const resolvedScope = await resolvePlanScope({
    ...(scope.harnessSlug ? { harnessSlug: scope.harnessSlug } : {}),
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
  });
  const planScope: PlanPinScope = { ...resolvedScope, planSlug: scope.planSlug };
  const resolution = await withWorkspace(planScope.workspaceId, (tx) => loadPlanTypes(tx as Sql, planScope));
  return resolution.resolver;
}

/**
 * Pin what an activated plan's body resolves: the plan type, the default item type and every
 * declared item type, with each parent reached through `extends`. Insert-if-absent, so a type
 * the plan already pins keeps its revision. Runs inside the plan write's transaction.
 */
export async function pinPlanTypes(
  sql: Sql,
  scope: PlanPinScope,
  body: { verificationProfile: string | null; planType: string | null; deliverables: Iterable<string | null | undefined> },
  pinnedBy: string,
  reason: string,
): Promise<number> {
  const resolution = await loadPlanTypes(sql, scope, { planType: body.planType });
  const plan = { verificationProfile: body.verificationProfile, planType: body.planType };
  resolution.resolver(plan, {});
  for (const deliverable of new Set(body.deliverables)) {
    if (deliverable) resolution.resolver(plan, { deliverable });
  }
  return insertPinsIfAbsent(sql, scope, resolution.resolved, pinnedBy, reason);
}
