/**
 * First-party item types and plan types (plan-item-types-registry-cupboard-2026-10-20 P-001,
 * requirements R-1 and R-2).
 *
 * Today's six deliverable kinds become the item types `papercusp/<kind>`, and the two
 * verification profiles become the plan types `papercusp/coding` and `papercusp/general`,
 * each carrying the plan classes it admits.
 *
 * They live in CODE rather than as seeded rows, so every workspace resolves them, including
 * one created after migration 1541, with no per-workspace seed to forget. Migration 1541
 * reserves the `papercusp/` namespace, so no registry row can shadow them.
 *
 * The module sets and the plan-type fields are written out here, not derived from
 * `modulesFor` / `PROFILE_DEFAULT_DELIVERABLE` / `PLAN_CLASSES_BY_PROFILE`. From P-002 this
 * catalog is the policy and those constants become its clients, so it has to be able to
 * stand alone. Until then the parity test in `registry-seed-census.integration.test.ts`
 * (R-3 falsifier 4) pins each entry to today's mapping: drift either way fails the build.
 */
// Leaf imports only: plan-verification-profile.ts loads this module (through the registry
// resolver) while it is still evaluating, so values read at module-evaluation time here must
// not come from it.
import {
  DELIVERABLE_KINDS,
  VERIFICATION_PROFILES,
  type DeliverableKind,
  type VerificationProfile,
} from '@papercusp/plan-parser';
import type { VerificationModule } from './verification-modules';
import {
  FIRST_PARTY_NAMESPACE,
  TYPE_DEFINITION_SCHEMA_VERSION,
  normalizeModules,
  type ItemTypeDefinition,
  type PlanTypeDefinition,
} from './definitions';

export const BUILTIN_REVISION = 1 as const;

export function builtinItemTypeId(kind: DeliverableKind): string {
  return `${FIRST_PARTY_NAMESPACE}/${kind}`;
}

export function builtinPlanTypeId(profile: VerificationProfile): string {
  return `${FIRST_PARTY_NAMESPACE}/${profile}`;
}

/** The built-in kind an item-type id names, or null for any other id. */
export function builtinKindOf(id: string): DeliverableKind | null {
  const prefix = `${FIRST_PARTY_NAMESPACE}/`;
  if (!id.startsWith(prefix)) return null;
  const kind = id.slice(prefix.length);
  return (DELIVERABLE_KINDS as readonly string[]).includes(kind) ? (kind as DeliverableKind) : null;
}

interface BuiltinItemTypeSpec {
  title: string;
  description: string;
  modules: readonly VerificationModule[];
  citations: readonly string[];
}

/** One entry per deliverable kind; the Record type makes a new kind a compile error here. */
const BUILTIN_ITEM_TYPES: Readonly<Record<DeliverableKind, BuiltinItemTypeSpec>> = {
  code: {
    title: 'Code',
    description: 'Source code. Held to the code module: code-truth audit with blob SHAs, spec-test adequacy, test-ledger freshness, and tests run plus files changed at completion.',
    modules: ['generic-core', 'code'],
    citations: ['code', 'test'],
  },
  doc: {
    title: 'Document',
    description: 'A written document, such as a runbook, guide or specification.',
    modules: ['generic-core'],
    citations: ['code', 'test', 'artifact', 'work-item', 'measurement', 'external'],
  },
  decision: {
    title: 'Decision',
    description: 'A recorded decision, such as a plan Decision or a ratified ruling.',
    modules: ['generic-core'],
    citations: ['code', 'test', 'artifact', 'work-item', 'measurement', 'external'],
  },
  research: {
    title: 'Research',
    description: 'An investigation and its findings.',
    modules: ['generic-core'],
    citations: ['code', 'test', 'artifact', 'work-item', 'measurement', 'external'],
  },
  operation: {
    title: 'Operation',
    description: 'An operational action, such as a migration run, a deploy or a configuration change.',
    modules: ['generic-core'],
    citations: ['code', 'test', 'artifact', 'work-item', 'measurement', 'external'],
  },
  artifact: {
    title: 'Artifact',
    description: 'A produced artifact that is not source code, such as a report, a dataset or a design.',
    modules: ['generic-core'],
    citations: ['code', 'test', 'artifact', 'work-item', 'measurement', 'external'],
  },
};

interface BuiltinPlanTypeSpec {
  title: string;
  description: string;
  classes: readonly string[];
  defaultKind: DeliverableKind;
}

const BUILTIN_PLAN_TYPES: Readonly<Record<VerificationProfile, BuiltinPlanTypeSpec>> = {
  coding: {
    title: 'Coding plan',
    description: 'A plan whose items are code by default. Admits the feature-ship, bugfix and migration classes.',
    classes: ['plan-class-feature-ship', 'plan-class-bugfix', 'plan-class-migration'],
    defaultKind: 'code',
  },
  general: {
    title: 'General plan',
    description: 'A plan whose items are non-code by default. Admits the general and investigation classes.',
    classes: ['plan-class-general', 'plan-class-investigation'],
    defaultKind: 'artifact',
  },
};

function itemType(kind: DeliverableKind): ItemTypeDefinition {
  const spec = BUILTIN_ITEM_TYPES[kind];
  return {
    schemaVersion: TYPE_DEFINITION_SCHEMA_VERSION,
    id: builtinItemTypeId(kind),
    revision: BUILTIN_REVISION,
    title: spec.title,
    description: spec.description,
    modules: normalizeModules(spec.modules),
    citations: [...spec.citations],
    display: { label: spec.title },
  };
}

function planType(profile: VerificationProfile): PlanTypeDefinition {
  const spec = BUILTIN_PLAN_TYPES[profile];
  return {
    schemaVersion: TYPE_DEFINITION_SCHEMA_VERSION,
    id: builtinPlanTypeId(profile),
    revision: BUILTIN_REVISION,
    title: spec.title,
    description: spec.description,
    base: profile,
    classes: [...spec.classes],
    defaultItemType: { id: builtinItemTypeId(spec.defaultKind), minRevision: BUILTIN_REVISION },
    itemTypes: DELIVERABLE_KINDS.map((kind) => ({ id: builtinItemTypeId(kind), minRevision: BUILTIN_REVISION })),
    display: { label: spec.title },
  };
}

export interface TypeCatalog {
  itemTypes: readonly ItemTypeDefinition[];
  planTypes: readonly PlanTypeDefinition[];
}

/** The first-party catalog. Frozen so no caller can mutate the shared definitions. */
export const BUILTIN_CATALOG: TypeCatalog = Object.freeze({
  itemTypes: Object.freeze(DELIVERABLE_KINDS.map(itemType)),
  planTypes: Object.freeze(VERIFICATION_PROFILES.map(planType)),
});
