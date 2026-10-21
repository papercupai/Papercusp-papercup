/**
 * type-pack — install item types and plan types from Cupboard packs
 * (plan-item-types-registry-cupboard-2026-10-20 P-006, D-002 / D-008).
 *
 * A type pack is an ordinary `pack` listing whose manifest (`papercusp.json`) carries a
 * declarative `typePack` block: item-type and plan-type definitions in the registry's own strict
 * schemas, plus the rubrics and datatypes those definitions reference. Nothing in it executes:
 * a definition holds verification-module references and declarative rubric checks only (D-003).
 *
 * Install runs in two phases so that a refusal never leaves a partial install:
 *
 *  - {@link planTypePackInstall} is write-free. It gates the listing (approved, content-pinned,
 *    declarations matching the manifest), validates every definition, and resolves every
 *    item-type reference: the same pack first, then the registry (built-in and installed), then
 *    the Cupboard packs that declare the type. Only an approved, pinned candidate is ever chosen
 *    (R-15); a dependency pack is fetched and planned the same way, recursively.
 *  - {@link applyTypePackInstall} writes everything in ONE transaction: datatypes, every
 *    definition through the authoring define path (origin 'pack', the 'install' shrink-check
 *    route), one receipt per pack, and finally the bundled rubrics through the no-clobber pinned
 *    seed. Any refusal rolls the whole transaction back.
 */
import { z } from 'zod';
import type postgres from 'postgres';
import { rubricCriterionCheckSchema } from '../agent-tools/plans/rubric-template';
import { DATATYPE_TIERS, getDatatype, upsertDatatype } from '../datatype-registry-store';
import { defineTypeDefinition, readRegistryRows, snapshotOf } from '../plan-types/authoring';
import { definitionContentHash } from '../plan-types/content-hash';
import {
  isFirstPartyTypeId,
  parseItemTypeDefinition,
  parsePlanTypeDefinition,
  referenceAdmits,
  validateDefinitionFloor,
  type ItemTypeDefinition,
  type PlanTypeDefinition,
  type TypeReference,
} from '../plan-types/definitions';
import type { TypeRegistrySnapshot } from '../plan-types/registry';
import type { TypeKind } from '../plan-types/resolve-verification';
import type { ResolvedListingCoords } from './resolve-listing-by-kind';
import type { RubricSeedSource } from './rubric-store';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** How many packs deep a dependency chain may go before the install refuses. */
export const TYPE_PACK_MAX_DEPTH = 4;
/** Per-kind cap on definitions one pack may carry. */
export const TYPE_PACK_MAX_DEFINITIONS = 100;

/** One type a listing declares it provides (the Worker's provides_item_types / provides_plan_types). */
export interface TypeDeclaration {
  id: string;
  revision: number;
}

/** What the installer knows about one Cupboard listing of a type pack. */
export interface TypePackListing {
  listingId: string;
  /** The Worker's review status. Only 'approved' installs (R-16). */
  reviewStatus: string;
  /** The content pin the listing was published with. Null means undeclared provenance. */
  pin: { commitSha: string; treeDigest: string } | null;
  releaseContentHash?: string | null;
  providesItemTypes: readonly TypeDeclaration[];
  providesPlanTypes: readonly TypeDeclaration[];
}

export interface TypePackManifest {
  name: string;
  version: string;
  typePack?: unknown;
}

/** A pack's listing plus the manifest read from its verified content. */
export interface TypePackSource {
  listing: TypePackListing;
  manifest: TypePackManifest;
}

export type TypePackRefusalCode =
  | 'type_pack_manifest_invalid'
  | 'type_pack_not_approved'
  | 'type_pack_unpinned'
  | 'type_pack_undeclared_types'
  | 'type_provider_missing'
  | 'type_provider_ambiguous'
  | 'type_pack_dependency_too_deep'
  | 'type_pack_fetch_failed'
  | 'type_pack_dependency_missing'
  | 'type_pack_dependency_conflict'
  | 'type_pack_definition_refused';

export interface TypePackRefusal {
  ok: false;
  code: TypePackRefusalCode;
  message: string;
  listingId?: string;
  issues?: string[];
  /** The registry refusal behind `type_pack_definition_refused` (authoring rule or shrink check). */
  cause?: { code: string; message: string };
}

function refuse(code: TypePackRefusalCode, message: string, extra: Omit<TypePackRefusal, 'ok' | 'code' | 'message'> = {}): TypePackRefusal {
  return { ok: false, code, message, ...extra };
}

// ── Listings ──────────────────────────────────────────────────────────────────

/** Parse a listing's provides_item_types / provides_plan_types (JSON text or array); bad entries drop. */
export function parseTypeDeclarations(raw: unknown): TypeDeclaration[] {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, revision } = entry as { id?: unknown; revision?: unknown };
    return typeof id === 'string' && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 1
      ? [{ id, revision }]
      : [];
  });
}

/** Parse a plan listing's requires_plan_type (JSON text or object) into a bounded reference, or null. */
export function parseRequiredPlanType(raw: unknown): TypeReference | null {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, minRevision, maxRevision } = value as Record<string, unknown>;
  if (typeof id !== 'string') return null;
  const rev = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : undefined);
  const ref: TypeReference = { id, ...(rev(minRevision) ? { minRevision: rev(minRevision) } : {}), ...(rev(maxRevision) ? { maxRevision: rev(maxRevision) } : {}) };
  return referenceIsBounded(ref) ? ref : null;
}

/** The installer's view of a resolved Cupboard listing, or null when it has no listing id. */
export function typePackListingFromCoords(coords: ResolvedListingCoords): TypePackListing | null {
  if (!coords.listingId) return null;
  return {
    listingId: coords.listingId,
    reviewStatus: coords.reviewStatus ?? 'unknown',
    pin: coords.pin ? { commitSha: coords.pin.commitSha, treeDigest: coords.pin.treeDigest } : null,
    releaseContentHash: coords.releaseContentHash ?? coords.pin?.releaseContentHash ?? null,
    providesItemTypes: parseTypeDeclarations(coords.providesItemTypes),
    providesPlanTypes: parseTypeDeclarations(coords.providesPlanTypes),
  };
}

// ── Manifest ─────────────────────────────────────────────────────────────────

const refSlug = /^[a-z0-9][a-z0-9-]*$/;

const rubricSourceSchema = z
  .object({
    rubricId: z.string().regex(refSlug),
    title: z.string().min(1),
    characteristic: z.string().min(1),
    description: z.string(),
    ratingScale: z.array(z.string().min(1)).min(2),
    methodRef: z.string().min(1).nullable().default(null),
    criteria: z
      .array(
        z
          .object({
            key: z.string().min(1),
            title: z.string().min(1),
            model: z.string().min(1),
            method: z.string().min(1),
            driftMarkers: z.string(),
            ratingScale: z.array(z.string().min(1)).optional(),
            replication: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const datatypeSourceSchema = z
  .object({
    id: z.string().regex(refSlug),
    title: z.string().min(1).max(120),
    description: z.string().max(4000).default(''),
    payloadSchema: z.record(z.string(), z.unknown()),
    nature: z.enum(['record', 'document', 'event']).default('record'),
    tier: z.enum(DATATYPE_TIERS).default('first-class'),
  })
  .strict();

export type TypePackDatatype = z.infer<typeof datatypeSourceSchema>;

const typePackSchema = z
  .object({
    itemTypes: z.array(z.unknown()).max(TYPE_PACK_MAX_DEFINITIONS).default([]),
    planTypes: z.array(z.unknown()).max(TYPE_PACK_MAX_DEFINITIONS).default([]),
    rubrics: z.array(rubricSourceSchema).max(50).default([]),
    datatypes: z.array(datatypeSourceSchema).max(50).default([]),
  })
  .strict();

/** A validated `typePack` block. `raw*` hold each definition exactly as it will be stored. */
export interface InspectedTypePack {
  itemTypes: ItemTypeDefinition[];
  planTypes: PlanTypeDefinition[];
  rawItemTypes: unknown[];
  rawPlanTypes: unknown[];
  rubrics: RubricSeedSource[];
  datatypes: TypePackDatatype[];
  /** Rubrics the item types name (`rubricRef`), deduplicated. */
  rubricRefs: string[];
  /** Datatypes the item types' completion schemas reference (`completion.datatypeRef`). */
  datatypeRefs: string[];
}

/** True when a reference names a revision or a revision range, so the install can pin it. */
export function referenceIsBounded(ref: TypeReference): boolean {
  return ref.minRevision !== undefined || ref.maxRevision !== undefined;
}

export function describeTypeReference(ref: TypeReference): string {
  if (!referenceIsBounded(ref)) return ref.id;
  if (ref.minRevision !== undefined && ref.minRevision === ref.maxRevision) return `${ref.id}@${ref.minRevision}`;
  return `${ref.id}@${ref.minRevision ?? 1}..${ref.maxRevision ?? 'latest'}`;
}

function zodIssues(error: z.ZodError, prefix: string): string[] {
  return error.issues.map((issue) => `${prefix}${issue.path.length ? issue.path.join('.') + ': ' : ''}${issue.message}`);
}

/**
 * Validate a manifest's `typePack` block without touching any store (R-18). Every definition
 * must parse under the registry's strict schema (unknown keys refused), keep the generic-core
 * floor, stay out of the first-party namespace and bound every type reference by a revision or
 * range. Every check must be a declarative rubric check. Bundled rubrics and datatypes must each
 * be referenced by an item type in the pack.
 */
export function inspectTypePack(raw: unknown): { ok: true; pack: InspectedTypePack } | TypePackRefusal {
  if (raw === undefined || raw === null) {
    return refuse('type_pack_manifest_invalid', 'the manifest carries no typePack block', { issues: ['typePack: required'] });
  }
  const shape = typePackSchema.safeParse(raw);
  if (!shape.success) {
    const issues = zodIssues(shape.error, 'typePack.');
    return refuse('type_pack_manifest_invalid', `typePack is invalid: ${issues.join('; ')}`, { issues });
  }
  const block = shape.data;
  const issues: string[] = [];
  if (block.itemTypes.length + block.planTypes.length === 0) issues.push('typePack: carries no item type and no plan type');

  const itemTypes: ItemTypeDefinition[] = [];
  const rawItemTypes: unknown[] = [];
  block.itemTypes.forEach((candidate, index) => {
    const at = `typePack.itemTypes[${index}]`;
    const parsed = parseItemTypeDefinition(candidate);
    if (!parsed.ok) {
      issues.push(...parsed.issues.map((issue) => `${at}: ${issue}`));
      return;
    }
    const def = parsed.definition;
    issues.push(...validateDefinitionFloor(def).map((issue) => `${at}: ${issue}`));
    if (isFirstPartyTypeId(def.id)) issues.push(`${at}: ${def.id} is in the first-party papercusp/ namespace`);
    if (def.extends && !referenceIsBounded(def.extends)) {
      issues.push(`${at}: extends ${def.extends.id} must name a revision or revision range`);
    }
    (def.checks ?? []).forEach((check, checkIndex) => {
      const declarative = rubricCriterionCheckSchema.safeParse({ ...(check.params ?? {}), kind: check.kind });
      if (!declarative.success) {
        issues.push(`${at}.checks[${checkIndex}]: '${check.kind}' is not a declarative rubric check (${declarative.error.issues[0]?.message ?? 'invalid'})`);
      }
    });
    itemTypes.push(def);
    rawItemTypes.push(candidate);
  });

  const planTypes: PlanTypeDefinition[] = [];
  const rawPlanTypes: unknown[] = [];
  block.planTypes.forEach((candidate, index) => {
    const at = `typePack.planTypes[${index}]`;
    const parsed = parsePlanTypeDefinition(candidate);
    if (!parsed.ok) {
      issues.push(...parsed.issues.map((issue) => `${at}: ${issue}`));
      return;
    }
    const def = parsed.definition;
    if (isFirstPartyTypeId(def.id)) issues.push(`${at}: ${def.id} is in the first-party papercusp/ namespace`);
    for (const ref of [def.defaultItemType, ...def.itemTypes]) {
      if (!referenceIsBounded(ref)) issues.push(`${at}: item type ${ref.id} must name a revision or revision range`);
    }
    planTypes.push(def);
    rawPlanTypes.push(candidate);
  });

  for (const [label, ids] of [
    ['item type', itemTypes.map((def) => def.id)],
    ['plan type', planTypes.map((def) => def.id)],
    ['rubric', block.rubrics.map((rubric) => rubric.rubricId)],
    ['datatype', block.datatypes.map((datatype) => datatype.id)],
  ] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) issues.push(`typePack: ${label} ${id} appears more than once`);
      seen.add(id);
    }
  }

  const rubricRefs = [...new Set(itemTypes.flatMap((def) => (def.rubricRef ? [def.rubricRef] : [])))];
  const datatypeRefs = [
    ...new Set(itemTypes.flatMap((def) => (def.completion && 'datatypeRef' in def.completion ? [def.completion.datatypeRef] : []))),
  ];
  for (const rubric of block.rubrics) {
    if (!rubricRefs.includes(rubric.rubricId)) issues.push(`typePack.rubrics: ${rubric.rubricId} is referenced by no item type in the pack`);
  }
  for (const datatype of block.datatypes) {
    if (!datatypeRefs.includes(datatype.id)) issues.push(`typePack.datatypes: ${datatype.id} is referenced by no item type in the pack`);
  }

  if (issues.length > 0) {
    return refuse('type_pack_manifest_invalid', `typePack is invalid: ${issues.join('; ')}`, { issues });
  }
  return {
    ok: true,
    pack: {
      itemTypes,
      planTypes,
      rawItemTypes,
      rawPlanTypes,
      rubrics: block.rubrics as RubricSeedSource[],
      datatypes: block.datatypes,
      rubricRefs,
      datatypeRefs,
    },
  };
}

/** The `provides_item_types` / `provides_plan_types` a publish declares for a manifest's typePack. */
export function typePackDeclarations(raw: unknown): { itemTypes: TypeDeclaration[]; planTypes: TypeDeclaration[] } | null {
  const inspected = inspectTypePack(raw);
  if (!inspected.ok) return null;
  return {
    itemTypes: inspected.pack.itemTypes.map((def) => ({ id: def.id, revision: def.revision })),
    planTypes: inspected.pack.planTypes.map((def) => ({ id: def.id, revision: def.revision })),
  };
}

/** Differences between what a listing declares and what its manifest carries. */
export function declarationMismatches(listing: TypePackListing, pack: InspectedTypePack): string[] {
  const keys = (decls: readonly TypeDeclaration[]) => new Set(decls.map((decl) => `${decl.id}@${decl.revision}`));
  const problems: string[] = [];
  for (const [label, declared, carried] of [
    ['item type', keys(listing.providesItemTypes), keys(pack.itemTypes)],
    ['plan type', keys(listing.providesPlanTypes), keys(pack.planTypes)],
  ] as const) {
    for (const key of carried) if (!declared.has(key)) problems.push(`the manifest carries ${label} ${key}, which the listing does not declare`);
    for (const key of declared) if (!carried.has(key)) problems.push(`the listing declares ${label} ${key}, which the manifest does not carry`);
  }
  return problems;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** How one type reference in a pack resolved. */
export interface ResolvedTypeDependency {
  kind: TypeKind;
  id: string;
  revision: number;
  /** 'pack' = the same pack, 'registry' = already resolvable here, 'listing' = another pack's listing. */
  via: 'pack' | 'registry' | 'listing';
  /** The referencing definition. */
  from: string;
  origin?: string;
  listingId?: string;
}

/**
 * Choose the Cupboard pack that provides `ref` (R-15). Only an approved, content-pinned listing
 * that declares an admitted revision is eligible; a pending listing or one of undeclared
 * provenance is never chosen. Among eligible listings the highest admitted revision wins, and a
 * tie between two listings refuses rather than guessing.
 */
export function chooseTypeProvider(
  kind: TypeKind,
  ref: TypeReference,
  candidates: readonly TypePackListing[],
): { ok: true; listing: TypePackListing; revision: number } | TypePackRefusal {
  const declared = (listing: TypePackListing) => (kind === 'item-type' ? listing.providesItemTypes : listing.providesPlanTypes);
  const admitted = candidates.flatMap((listing) => {
    const revisions = declared(listing).filter((decl) => decl.id === ref.id && referenceAdmits(ref, decl.revision));
    return revisions.length > 0 ? [{ listing, revision: Math.max(...revisions.map((decl) => decl.revision)) }] : [];
  });
  const eligible = admitted.filter(({ listing }) => listing.reviewStatus === 'approved' && listing.pin !== null);
  if (eligible.length === 0) {
    const pending = admitted.filter(({ listing }) => listing.reviewStatus !== 'approved').map(({ listing }) => listing.listingId);
    const unpinned = admitted.filter(({ listing }) => listing.reviewStatus === 'approved' && listing.pin === null).map(({ listing }) => listing.listingId);
    const detail = [
      pending.length ? `awaiting review: ${pending.join(', ')}` : '',
      unpinned.length ? `no content pin: ${unpinned.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return refuse(
      'type_provider_missing',
      `no approved, content-pinned Cupboard pack provides ${kind} ${describeTypeReference(ref)}${detail ? ` (${detail})` : ''}`,
    );
  }
  const best = Math.max(...eligible.map((entry) => entry.revision));
  const top = eligible.filter((entry) => entry.revision === best);
  const listings = [...new Set(top.map((entry) => entry.listing.listingId))];
  if (listings.length > 1) {
    return refuse(
      'type_provider_ambiguous',
      `${listings.length} approved Cupboard packs provide ${kind} ${ref.id}@${best} (${listings.join(', ')}); ` +
        'narrow the reference or install the intended pack first',
    );
  }
  return { ok: true, listing: top[0]!.listing, revision: best };
}

export interface PlannedTypePack {
  listing: TypePackListing;
  manifest: { name: string; version: string };
  pack: InspectedTypePack;
  dependencies: ResolvedTypeDependency[];
}

export interface TypePackPlan {
  ok: true;
  rootListingId: string;
  /** Install order: every dependency pack before the packs that reference it. */
  packs: PlannedTypePack[];
}

export interface TypePackPlanDeps {
  /** Cupboard pack listings that declare `kind` `id` (any review status; the chooser filters). */
  findProviders: (kind: TypeKind, id: string) => Promise<readonly TypePackListing[]>;
  /** Fetch a dependency pack's manifest from its verified content at the listing's pin. */
  fetchPack: (listing: TypePackListing) => Promise<TypePackSource>;
}

function listingGate(listing: TypePackListing): TypePackRefusal | null {
  if (listing.reviewStatus !== 'approved') {
    return refuse(
      'type_pack_not_approved',
      `pack listing ${listing.listingId} is ${listing.reviewStatus}; a pack carrying item types or plan types installs only after operator review approves it`,
      { listingId: listing.listingId },
    );
  }
  if (!listing.pin) {
    return refuse(
      'type_pack_unpinned',
      `pack listing ${listing.listingId} has no content pin, so its provenance cannot be verified`,
      { listingId: listing.listingId },
    );
  }
  return null;
}

/**
 * Plan an install of `root` and every pack it depends on, without writing anything. `registry`
 * is the workspace's current snapshot (built-in catalog plus stored rows).
 */
export async function planTypePackInstall(
  root: TypePackSource,
  registry: TypeRegistrySnapshot,
  deps: TypePackPlanDeps,
): Promise<TypePackPlan | TypePackRefusal> {
  const planned = new Map<string, PlannedTypePack>();
  const order: PlannedTypePack[] = [];
  const visiting = new Set<string>();

  const providedByPlanned = (ref: TypeReference): { listingId: string; revision: number } | null => {
    for (const entry of [...planned.values()]) {
      const def = entry.pack.itemTypes.find((candidate) => candidate.id === ref.id && referenceAdmits(ref, candidate.revision));
      if (def) return { listingId: entry.listing.listingId, revision: def.revision };
    }
    return null;
  };

  const visit = async (source: TypePackSource, depth: number): Promise<TypePackRefusal | null> => {
    const listingId = source.listing.listingId;
    if (planned.has(listingId) || visiting.has(listingId)) return null;
    if (depth > TYPE_PACK_MAX_DEPTH) {
      return refuse('type_pack_dependency_too_deep', `the dependency chain reaching ${listingId} is deeper than ${TYPE_PACK_MAX_DEPTH} packs`, { listingId });
    }
    visiting.add(listingId);
    const gate = listingGate(source.listing);
    if (gate) return gate;
    const inspected = inspectTypePack(source.manifest.typePack);
    if (!inspected.ok) return { ...inspected, listingId };
    const mismatches = declarationMismatches(source.listing, inspected.pack);
    if (mismatches.length > 0) {
      return refuse('type_pack_undeclared_types', `pack listing ${listingId}: ${mismatches.join('; ')}`, { listingId, issues: mismatches });
    }

    const references = [
      ...inspected.pack.itemTypes.flatMap((def) => (def.extends ? [{ from: def.id, ref: def.extends }] : [])),
      ...inspected.pack.planTypes.flatMap((def) => def.itemTypes.map((ref) => ({ from: def.id, ref }))),
    ];
    const dependencies: ResolvedTypeDependency[] = [];
    for (const { from, ref } of references) {
      const local = inspected.pack.itemTypes.find((def) => def.id === ref.id && referenceAdmits(ref, def.revision));
      if (local) {
        dependencies.push({ kind: 'item-type', id: ref.id, revision: local.revision, via: 'pack', from });
        continue;
      }
      const registered = registry.itemType(ref.id, ref);
      if (registered) {
        dependencies.push({
          kind: 'item-type', id: ref.id, revision: registered.definition.revision, via: 'registry', from,
          origin: registered.origin, ...(registered.sourceListingId ? { listingId: registered.sourceListingId } : {}),
        });
        continue;
      }
      const already = providedByPlanned(ref);
      if (already) {
        dependencies.push({ kind: 'item-type', id: ref.id, revision: already.revision, via: 'listing', from, listingId: already.listingId });
        continue;
      }
      const choice = chooseTypeProvider('item-type', ref, await deps.findProviders('item-type', ref.id));
      if (!choice.ok) return { ...choice, listingId, message: `${from} references ${describeTypeReference(ref)}: ${choice.message}` };
      if (choice.listing.listingId !== listingId) {
        let fetched: TypePackSource;
        try {
          fetched = await deps.fetchPack(choice.listing);
        } catch (error) {
          return refuse('type_pack_fetch_failed',
            `${from} references ${describeTypeReference(ref)}, provided by pack listing ${choice.listing.listingId}, whose content could not be fetched and verified: ${error instanceof Error ? error.message : String(error)}`,
            { listingId: choice.listing.listingId });
        }
        const nested = await visit({ listing: choice.listing, manifest: fetched.manifest }, depth + 1);
        if (nested) return nested;
      }
      dependencies.push({ kind: 'item-type', id: ref.id, revision: choice.revision, via: 'listing', from, listingId: choice.listing.listingId });
    }

    visiting.delete(listingId);
    const entry: PlannedTypePack = {
      listing: source.listing,
      manifest: { name: source.manifest.name, version: source.manifest.version },
      pack: inspected.pack,
      dependencies,
    };
    planned.set(listingId, entry);
    order.push(entry);
    return null;
  };

  const refusal = await visit(root, 0);
  return refusal ?? { ok: true, rootListingId: root.listing.listingId, packs: order };
}

// ── Apply ────────────────────────────────────────────────────────────────────

export interface TypePackReceiptEntry {
  id: string;
  revision: number;
  contentHash: string;
  /** The same revision was already stored with this content; the install wrote nothing for it. */
  unchanged?: true;
}

export interface TypePackResourceEntry {
  ref: string;
  /** 'pack' = the install placed it; 'workspace' = it was already present and matched. */
  source: 'pack' | 'workspace';
  contentHash: string | null;
}

export interface TypePackReceipt {
  listingId: string;
  packName: string;
  packVersion: string;
  commitSha: string;
  treeDigest: string;
  releaseContentHash: string | null;
  itemTypes: TypePackReceiptEntry[];
  planTypes: TypePackReceiptEntry[];
  rubrics: TypePackResourceEntry[];
  datatypes: TypePackResourceEntry[];
  dependencies: ResolvedTypeDependency[];
}

export interface TypePackInstallResult {
  ok: true;
  /** One receipt per pack, in install order (the root last). */
  receipts: TypePackReceipt[];
}

export interface TypePackApplyDeps {
  /** Seed one bundled rubric at its exact content (real: `provisionPinnedRubric`, no-clobber). */
  provisionRubric: (source: RubricSeedSource, workspaceId: string) => Promise<void>;
}

class TypePackRollback extends Error {
  constructor(readonly refusal: TypePackRefusal) {
    super(refusal.message);
    this.name = 'TypePackRollback';
  }
}

function rollback(code: TypePackRefusalCode, message: string, extra: Omit<TypePackRefusal, 'ok' | 'code' | 'message'> = {}): TypePackRollback {
  return new TypePackRollback(refuse(code, message, extra));
}

async function workspaceRubricExists(tx: Tx, workspaceId: string, rubricRef: string): Promise<boolean> {
  const [row] = await tx<Array<{ found: number }>>`
    SELECT 1 AS found FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND template = 'rubric'
       AND template_slug IS NULL
       AND plan_slug = ${rubricRef}
       AND archived IS NOT TRUE
     LIMIT 1`;
  return Boolean(row);
}

/** Item types across every planned pack, each parent (via `extends`) before its children. */
function orderedItemTypes(plan: TypePackPlan): Array<{ listingId: string; def: ItemTypeDefinition; raw: unknown }> {
  const all = plan.packs.flatMap((entry) =>
    entry.pack.itemTypes.map((def, index) => ({ listingId: entry.listing.listingId, def, raw: entry.pack.rawItemTypes[index] })));
  const placed = new Set<number>();
  const out: typeof all = [];
  const place = (index: number, trail: Set<number>) => {
    if (placed.has(index) || trail.has(index)) return;
    trail.add(index);
    const parent = all[index]!.def.extends;
    if (parent) {
      const parentIndex = all.findIndex((entry) => entry.def.id === parent.id && referenceAdmits(parent, entry.def.revision));
      if (parentIndex >= 0) place(parentIndex, trail);
    }
    placed.add(index);
    out.push(all[index]!);
  };
  all.forEach((_, index) => place(index, new Set()));
  return out;
}

async function writeReceipt(tx: Tx, workspaceId: string, installedBy: string, receipt: TypePackReceipt): Promise<void> {
  await tx`
    INSERT INTO harness_shared.type_pack_installations
      (workspace_id, listing_id, pack_name, pack_version, commit_sha, tree_digest, release_content_hash,
       item_types, plan_types, rubrics, datatypes, dependencies, installed_by)
    VALUES (${workspaceId}, ${receipt.listingId}, ${receipt.packName}, ${receipt.packVersion},
            ${receipt.commitSha}, ${receipt.treeDigest}, ${receipt.releaseContentHash},
            ${tx.json(receipt.itemTypes as never)}, ${tx.json(receipt.planTypes as never)},
            ${tx.json(receipt.rubrics as never)}, ${tx.json(receipt.datatypes as never)},
            ${tx.json(receipt.dependencies as never)}, ${installedBy})
    ON CONFLICT (workspace_id, listing_id) DO UPDATE SET
      pack_name = EXCLUDED.pack_name, pack_version = EXCLUDED.pack_version,
      commit_sha = EXCLUDED.commit_sha, tree_digest = EXCLUDED.tree_digest,
      release_content_hash = EXCLUDED.release_content_hash,
      item_types = EXCLUDED.item_types, plan_types = EXCLUDED.plan_types,
      rubrics = EXCLUDED.rubrics, datatypes = EXCLUDED.datatypes,
      dependencies = EXCLUDED.dependencies, installed_by = EXCLUDED.installed_by, installed_at = now()`;
}

/**
 * Apply a plan from {@link planTypePackInstall} in one transaction. Co-installs every rubric and
 * datatype the definitions reference (bundled ones are placed; present ones must match), writes
 * every definition through the authoring define path as a pack install, and records one receipt
 * per pack (R-24). Any refusal rolls everything back.
 */
export async function applyTypePackInstall(
  sql: Sql,
  plan: TypePackPlan,
  input: { workspaceId: string; installedBy: string },
  deps: TypePackApplyDeps,
): Promise<TypePackInstallResult | TypePackRefusal> {
  try {
    return await sql.begin(async (tx) => {
      const receipts = new Map<string, TypePackReceipt>();
      const toProvision: RubricSeedSource[] = [];
      for (const entry of plan.packs) {
        const listingId = entry.listing.listingId;
        const receipt: TypePackReceipt = {
          listingId,
          packName: entry.manifest.name,
          packVersion: entry.manifest.version,
          commitSha: entry.listing.pin!.commitSha,
          treeDigest: entry.listing.pin!.treeDigest,
          releaseContentHash: entry.listing.releaseContentHash ?? null,
          itemTypes: [],
          planTypes: [],
          rubrics: [],
          datatypes: [],
          dependencies: entry.dependencies,
        };
        for (const ref of entry.pack.datatypeRefs) {
          const bundled = entry.pack.datatypes.find((datatype) => datatype.id === ref);
          const existing = await getDatatype(tx, input.workspaceId, ref);
          if (bundled) {
            const hash = definitionContentHash(bundled.payloadSchema);
            if (existing) {
              if (definitionContentHash(existing.payloadSchema ?? null) !== hash) {
                throw rollback('type_pack_dependency_conflict',
                  `pack listing ${listingId} bundles datatype ${ref}, but this workspace already has ${ref} with a different payload schema`,
                  { listingId });
              }
              receipt.datatypes.push({ ref, source: 'workspace', contentHash: hash });
            } else {
              await upsertDatatype(tx as unknown as Sql, {
                id: bundled.id,
                workspaceId: input.workspaceId,
                title: bundled.title,
                description: bundled.description,
                tier: bundled.tier,
                nature: bundled.nature,
                payloadSchema: bundled.payloadSchema,
                createdBy: `type-pack:${listingId}`,
              });
              receipt.datatypes.push({ ref, source: 'pack', contentHash: hash });
            }
          } else if (existing) {
            receipt.datatypes.push({ ref, source: 'workspace', contentHash: definitionContentHash(existing.payloadSchema ?? null) });
          } else {
            throw rollback('type_pack_dependency_missing',
              `pack listing ${listingId} references datatype ${ref}, which it does not bundle and this workspace does not have`,
              { listingId });
          }
        }
        for (const ref of entry.pack.rubricRefs) {
          const bundled = entry.pack.rubrics.find((rubric) => rubric.rubricId === ref);
          const present = await workspaceRubricExists(tx, input.workspaceId, ref);
          if (bundled) {
            receipt.rubrics.push({ ref, source: present ? 'workspace' : 'pack', contentHash: definitionContentHash(bundled) });
            toProvision.push(bundled);
          } else if (present) {
            receipt.rubrics.push({ ref, source: 'workspace', contentHash: null });
          } else {
            throw rollback('type_pack_dependency_missing',
              `pack listing ${listingId} references rubric ${ref}, which it does not bundle and this workspace does not have`,
              { listingId });
          }
        }
        receipts.set(listingId, receipt);
      }

      const writeDefinition = async (kind: TypeKind, listingId: string, def: { id: string; revision: number }, raw: unknown) => {
        const result = await defineTypeDefinition(tx, {
          workspaceId: input.workspaceId, kind, definition: raw, createdBy: input.installedBy, pack: { listingId },
        });
        if (!result.ok) {
          throw rollback('type_pack_definition_refused', `${kind} ${def.id}@${def.revision} from pack listing ${listingId}: ${result.message}`,
            { listingId, cause: { code: result.code, message: result.message } });
        }
        const receipt = receipts.get(listingId)!;
        (kind === 'item-type' ? receipt.itemTypes : receipt.planTypes).push({
          id: def.id, revision: def.revision, contentHash: result.contentHash, ...(result.unchanged ? { unchanged: true as const } : {}),
        });
      };
      for (const { listingId, def, raw } of orderedItemTypes(plan)) await writeDefinition('item-type', listingId, def, raw);
      for (const entry of plan.packs) {
        for (const [index, def] of entry.pack.planTypes.entries()) {
          await writeDefinition('plan-type', entry.listing.listingId, def, entry.pack.rawPlanTypes[index]);
        }
      }
      for (const receipt of receipts.values()) await writeReceipt(tx, input.workspaceId, input.installedBy, receipt);
      // Last, so every refusable step has already passed: the pinned seed is no-clobber and throws
      // on a conflicting live rubric, which rolls the definitions and receipts back with it.
      for (const source of toProvision) await deps.provisionRubric(source, input.workspaceId);
      return { ok: true as const, receipts: [...receipts.values()] };
    });
  } catch (error) {
    if (error instanceof TypePackRollback) return error.refusal;
    throw error;
  }
}

/**
 * Resolve the plan type a plan template requires (R-17). An already-resolvable plan type needs no
 * install; otherwise the approved, pinned pack that declares it is fetched and planned with every
 * pack it depends on. Write-free: the caller applies the returned plan after its own refusable steps.
 */
export async function planRequiredPlanType(
  required: TypeReference,
  registry: TypeRegistrySnapshot,
  deps: TypePackPlanDeps,
): Promise<{ ok: true; resolvedBy: 'registry'; revision: number } | { ok: true; resolvedBy: 'listing'; plan: TypePackPlan } | TypePackRefusal> {
  const registered = registry.planType(required.id, required);
  if (registered) return { ok: true, resolvedBy: 'registry', revision: registered.definition.revision };
  const choice = chooseTypeProvider('plan-type', required, await deps.findProviders('plan-type', required.id));
  if (!choice.ok) return { ...choice, message: `the plan template requires plan type ${describeTypeReference(required)}: ${choice.message}` };
  let fetched: TypePackSource;
  try {
    fetched = await deps.fetchPack(choice.listing);
  } catch (error) {
    return refuse('type_pack_fetch_failed',
      `plan type ${describeTypeReference(required)} is provided by pack listing ${choice.listing.listingId}, whose content could not be fetched and verified: ${error instanceof Error ? error.message : String(error)}`,
      { listingId: choice.listing.listingId });
  }
  const plan = await planTypePackInstall({ listing: choice.listing, manifest: fetched.manifest }, registry, deps);
  return plan.ok ? { ok: true, resolvedBy: 'listing', plan } : plan;
}

/** Plan and apply in one call against the workspace's current registry. */
export async function installTypePack(
  sql: Sql,
  root: TypePackSource,
  input: { workspaceId: string; installedBy: string },
  deps: TypePackPlanDeps & TypePackApplyDeps,
): Promise<TypePackInstallResult | TypePackRefusal> {
  const registry = snapshotOf(await readRegistryRows(sql, input.workspaceId));
  const plan = await planTypePackInstall(root, registry, deps);
  if (!plan.ok) return plan;
  return applyTypePackInstall(sql, plan, input, deps);
}

export interface StoredTypePackReceipt extends TypePackReceipt {
  installedBy: string;
  installedAt: string;
}

/** Read the receipt one install recorded for a listing, or null. */
export async function readTypePackReceipt(sql: Sql | Tx, workspaceId: string, listingId: string): Promise<StoredTypePackReceipt | null> {
  const [row] = await sql<Array<Record<string, unknown>>>`
    SELECT listing_id, pack_name, pack_version, commit_sha, tree_digest, release_content_hash,
           item_types, plan_types, rubrics, datatypes, dependencies, installed_by, installed_at
      FROM harness_shared.type_pack_installations
     WHERE workspace_id = ${workspaceId} AND listing_id = ${listingId}`;
  if (!row) return null;
  return {
    listingId: String(row.listing_id),
    packName: String(row.pack_name),
    packVersion: String(row.pack_version),
    commitSha: String(row.commit_sha),
    treeDigest: String(row.tree_digest),
    releaseContentHash: (row.release_content_hash as string | null) ?? null,
    itemTypes: row.item_types as TypePackReceiptEntry[],
    planTypes: row.plan_types as TypePackReceiptEntry[],
    rubrics: row.rubrics as TypePackResourceEntry[],
    datatypes: row.datatypes as TypePackResourceEntry[],
    dependencies: row.dependencies as ResolvedTypeDependency[],
    installedBy: String(row.installed_by),
    installedAt: new Date(row.installed_at as string).toISOString(),
  };
}
