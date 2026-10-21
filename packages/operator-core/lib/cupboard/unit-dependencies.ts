/**
 * unit-dependencies — the ONE reading of a distribution unit's declared
 * `dependencies` (a plugin/pack manifest's `{ tools, packs, plugins, events }`)
 * against a derived pack catalog.
 *
 * Extracted from install-io's `validateDependencies` closure — the install-time
 * gate (tool-distribution-granularity D-003; events: cupboard-public-release
 * D-003 / P-007) — so the install gate and the plugin listing routes
 * (`plugin-manifest-refs.ts`, WI-6554700010018318) read a manifest's
 * dependencies identically. Two readers with their own rules would let the
 * listing call a manifest valid that the installer then refuses, which is the
 * gap that item closes.
 *
 * Pure over its inputs: the caller derives the catalog (`derivePackCatalog`)
 * and passes it in.
 */
import { resolveEventProvider, validateBlueprintDependencies } from '@papercusp/blueprint-distribution';
import { depHostSetsFromCatalog, type DerivedPackCatalog } from './pack-catalog';

/** A unit's declared dependency block (plugin-sdk `ManifestDependencies`). */
export interface UnitDependencyInput {
  tools?: string[];
  packs?: string[];
  plugins?: string[];
  events?: Array<{ family: string; optional?: boolean }>;
}

export interface UnitDependencyVerdict {
  /** True iff the install gate accepts these deps against this catalog. */
  ok: boolean;
  /** Declared deps with no provider (as written). With `cupboardReachable:false`, packs/plugins/events here are unproven, not disproven. */
  missing: {
    tools: string[];
    packs: string[];
    plugins: string[];
    blueprints: string[];
    datatypes: string[];
    events: string[];
  };
  /** Declared deps one Cupboard install away (advisory; never blocks). */
  installable: {
    tools: string[];
    packs: string[];
    plugins: string[];
    blueprints: string[];
    datatypes: string[];
    events: Array<{ family: string; optional?: boolean }>;
  };
  messages: string[];
  /** OPTIONAL event families nothing provides. Listen-if-present: never blocks. */
  unresolvedOptionalEvents: string[];
  /** False when the Cupboard listing fetch failed; `ok` is then softened for pack/plugin/event misses. */
  cupboardReachable: boolean;
}

/**
 * Resolve a unit's declared dependencies against `catalog`, exactly as the
 * Cupboard plugin install gate does.
 */
export function validateUnitDependencies(
  deps: UnitDependencyInput,
  catalog: DerivedPackCatalog,
): UnitDependencyVerdict {
  const verdict = validateBlueprintDependencies(deps, depHostSetsFromCatalog(catalog));

  // The EVENT axis (D-003 / P-007). `validateBlueprintDependencies` covers
  // tools/packs/plugins/blueprints/datatypes — deliberately NOT events,
  // which are a UNIT-level axis, not a blueprint one. So resolve them here,
  // against the SAME derived catalog, and fold the result into the verdict.
  const missingEvents: string[] = [];
  const installableEvents: Array<{ family: string; optional?: boolean }> = [];
  const unresolvedOptionalEvents: string[] = [];
  const eventMessages: string[] = [];
  for (const dep of deps.events ?? []) {
    if (!dep?.family) continue;
    const r = resolveEventProvider(dep.family, catalog.view);
    if (r.status === 'available') continue;
    if (r.status === 'installable') {
      installableEvents.push({ family: dep.family, ...(dep.optional ? { optional: true } : {}) });
      continue;
    }
    // Unknown. A REQUIRED family is as hard as a missing tool; an OPTIONAL
    // one is listen-if-present and must never block the install.
    if (dep.optional) {
      unresolvedOptionalEvents.push(dep.family);
      continue;
    }
    missingEvents.push(dep.family);
    eventMessages.push(`needs event family "${dep.family}" — nothing on this host provides it`);
  }

  const merged: UnitDependencyVerdict = {
    ok: verdict.ok && missingEvents.length === 0,
    missing: { ...verdict.missing, events: missingEvents },
    installable: { ...verdict.installable, events: installableEvents },
    messages: [...verdict.messages, ...eventMessages],
    unresolvedOptionalEvents,
    cupboardReachable: catalog.cupboardReachable,
  };

  // Cupboard-unreachable softening (mirrors the tool axis): a transient
  // outage can't disprove a listing, so don't hard-fail pack/plugin/event
  // deps it might have provided — but a missing TOOL still fails, because
  // the in-process catalog is authoritative for those. A missing EVENT is
  // NOT authoritative that way (a Cupboard unit we couldn't see may declare
  // it), so it softens with packs/plugins rather than failing with tools.
  if (!catalog.cupboardReachable && merged.missing.tools.length === 0) {
    return { ...merged, ok: true };
  }
  return merged;
}
