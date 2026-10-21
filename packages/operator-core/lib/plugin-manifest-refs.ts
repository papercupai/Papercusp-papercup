/**
 * plugin-manifest-refs — resolve the names a listed plugin manifest REFERENCES
 * against the live pack catalog, so the `plugins/*` listing routes stop
 * presenting a manifest as valid until load or install time
 * (WI-6554700010018318, residue of EI-21114087507786980 / P-006 C-15, D-002).
 *
 * `plugin-catalog.ts` reads manifests off disk and lists their tool, event and
 * dependency names as written. This module checks those names:
 *
 *   - `dependencies.{tools,packs,plugins,events}` through
 *     `validateUnitDependencies` — the SAME reader the Cupboard install gate
 *     uses, so the listing and the installer agree on what is missing;
 *   - the unit's own `tools[]` against the live projected-tool registry, when
 *     the plugin host has the unit LOADED (a declared tool the loader did not
 *     register does not exist for callers);
 *   - the unit's `provides.events` against the builtin event floor, which an
 *     installed declaration can never shadow (resolveEventProvider's ladder).
 *
 * Reporting only: nothing here refuses a manifest. The pure core
 * (`resolveManifestRefs`) takes an injected catalog; the IO edge
 * (`startManifestRefCatalog` / `attachManifestRefs`) derives one per request
 * and is fail-soft — a catalog that cannot be derived marks the refs
 * unresolved and never drops the listing.
 */
import {
  derivePackCatalog,
  manifestToolNames,
  parseProvidedEvents,
  type DerivedPackCatalog,
  type InstalledUnitInput,
} from './cupboard/pack-catalog';
import { validateUnitDependencies, type UnitDependencyInput } from './cupboard/unit-dependencies';

/** Which reference the issue is about. `own-tool` / `own-event` are the unit's own declarations. */
export type ManifestRefAxis = 'tool' | 'pack' | 'plugin' | 'event' | 'own-tool' | 'own-event';

/**
 * - `missing`: nothing provides it, so the install gate refuses the unit.
 * - `unverified`: not found, but the Cupboard was unreachable, so it may be installable.
 * - `installable`: a Cupboard unit provides it (the installer fetches it).
 * - `optional-unresolved`: an optional event dependency nothing provides (never blocks).
 * - `not-registered`: the unit is loaded but the registry has no such tool.
 * - `shadowed-by-builtin`: a provided event family the builtin catalog already owns.
 */
export type ManifestRefStatus =
  | 'missing'
  | 'unverified'
  | 'installable'
  | 'optional-unresolved'
  | 'not-registered'
  | 'shadowed-by-builtin';

export interface ManifestRefIssue {
  axis: ManifestRefAxis;
  /** The name as the manifest wrote it. */
  name: string;
  status: ManifestRefStatus;
  message: string;
}

export interface ManifestRefReport {
  /** True iff the Cupboard install gate would accept this manifest's `dependencies`. */
  dependenciesOk: boolean;
  /** Whether the plugin host has the unit loaded. Own tools are checked only when true; `null` = no host was read. */
  loaded: boolean | null;
  issues: ManifestRefIssue[];
}

/** The manifest fields this module reads. Loose on purpose: the listing does not schema-validate. */
export interface ManifestRefsInput {
  name: string;
  tools?: unknown;
  dependencies?: unknown;
  provides?: unknown;
}

const strings = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

/**
 * Coerce an unvalidated manifest `dependencies` block to the shape the install
 * gate reads. Well-formed entries pass through unchanged; a malformed field
 * reads as empty instead of throwing inside the shared validator.
 */
function readDependencies(raw: unknown): UnitDependencyInput {
  if (raw == null || typeof raw !== 'object') return {};
  const d = raw as Record<string, unknown>;
  const events = Array.isArray(d.events)
    ? d.events.filter(
        (e): e is { family: string; optional?: boolean } =>
          e != null && typeof e === 'object' && typeof (e as { family?: unknown }).family === 'string',
      )
    : [];
  return { tools: strings(d.tools), packs: strings(d.packs), plugins: strings(d.plugins), events };
}

/**
 * MCP names of the manifest's own tools that the registry is expected to hold.
 * A tool exposed over HTTP only has no MCP registration to check, so it is
 * skipped rather than reported missing.
 */
function ownMcpToolNames(name: string, rawTools: unknown): string[] {
  if (!Array.isArray(rawTools)) return [];
  const mcpExposed = rawTools.filter((t): t is NonNullable<InstalledUnitInput['tools']>[number] => {
    if (t == null || typeof t !== 'object') return false;
    const expose = (t as { expose?: { http?: unknown; mcp?: unknown } }).expose;
    return !(expose && expose.mcp == null && expose.http != null);
  });
  return manifestToolNames({ name, tools: mcpExposed });
}

/** Resolve one listed manifest's references against a derived catalog. Pure. */
export function resolveManifestRefs(manifest: ManifestRefsInput, catalog: DerivedPackCatalog): ManifestRefReport {
  const issues: ManifestRefIssue[] = [];
  const add = (axis: ManifestRefAxis, name: string, status: ManifestRefStatus, message: string) =>
    issues.push({ axis, name, status, message });

  const verdict = validateUnitDependencies(readDependencies(manifest.dependencies), catalog);
  // A tool miss is authoritative (the in-process catalog knows every tool); the
  // other axes cannot be disproved while the Cupboard listing is unreadable.
  const unprovenStatus: ManifestRefStatus = verdict.cupboardReachable ? 'missing' : 'unverified';
  for (const t of verdict.missing.tools) {
    add('tool', t, 'missing', `depends on tool "${t}", which no built-in, installed or Cupboard unit provides`);
  }
  for (const p of verdict.missing.packs) {
    add('pack', p, unprovenStatus, `depends on pack "${p}", which is not installed and not listed in the Cupboard`);
  }
  for (const p of verdict.missing.plugins) {
    add('plugin', p, unprovenStatus, `depends on plugin "${p}", which is not installed and not listed in the Cupboard`);
  }
  for (const f of verdict.missing.events) {
    add('event', f, unprovenStatus, `requires event family "${f}", which nothing on this host or in the Cupboard provides`);
  }
  for (const t of verdict.installable.tools) add('tool', t, 'installable', `tool "${t}" is provided by a Cupboard unit`);
  for (const p of verdict.installable.packs) add('pack', p, 'installable', `pack "${p}" is listed in the Cupboard`);
  for (const p of verdict.installable.plugins) add('plugin', p, 'installable', `plugin "${p}" is listed in the Cupboard`);
  for (const e of verdict.installable.events) {
    add('event', e.family, 'installable', `event family "${e.family}" is provided by a Cupboard unit`);
  }
  for (const f of verdict.unresolvedOptionalEvents) {
    add('event', f, 'optional-unresolved', `optional event family "${f}" has no provider; the unit's reaction to it never fires`);
  }

  const loaded = catalog.loadedUnits ? catalog.loadedUnits.has(manifest.name) : null;
  if (loaded) {
    const registered = new Set(catalog.registeredToolsByUnit?.get(manifest.name) ?? []);
    for (const t of ownMcpToolNames(manifest.name, manifest.tools)) {
      if (!registered.has(t)) {
        add('own-tool', t, 'not-registered', `declares tool "${t}", but the loaded unit did not register it`);
      }
    }
  }

  const provides = manifest.provides as { events?: unknown } | null | undefined;
  for (const ev of parseProvidedEvents(provides?.events)) {
    if (catalog.view.builtinEvents.has(ev.family)) {
      add('own-event', ev.family, 'shadowed-by-builtin', `provides event family "${ev.family}", which the builtin catalog owns; this declaration is ignored`);
    }
  }

  return { dependenciesOk: verdict.ok, loaded, issues };
}

/** Bound on the Cupboard listing read a plugin listing request waits for. */
export const MANIFEST_REF_CUPBOARD_TIMEOUT_MS = 3_000;

/**
 * Start deriving the catalog for one listing request. Never rejects: a failed
 * derivation resolves to the Error, which `attachManifestRefs` reports.
 * Start it before scanning manifests so the two run concurrently.
 */
export function startManifestRefCatalog(opts: { harnessSlug?: string } = {}): Promise<DerivedPackCatalog | Error> {
  return derivePackCatalog({ harnessSlug: opts.harnessSlug, timeoutMs: MANIFEST_REF_CUPBOARD_TIMEOUT_MS }).catch(
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
}

export interface ManifestRefResolution {
  /** False when the catalog could not be derived; every `refs` is then null. */
  resolved: boolean;
  cupboardReachable: boolean | null;
  /** Whether the plugin host was read (own-tool checks need it). */
  hostRead: boolean | null;
  error?: string;
}

/** Attach a `refs` report to each listed manifest. Fail-soft: the list is always returned. */
export async function attachManifestRefs<M extends ManifestRefsInput>(
  manifests: readonly M[],
  catalog: Promise<DerivedPackCatalog | Error> | DerivedPackCatalog | Error,
): Promise<{ plugins: Array<M & { refs: ManifestRefReport | null }>; refResolution: ManifestRefResolution }> {
  const cat = await catalog;
  if (cat instanceof Error) {
    return {
      plugins: manifests.map((m) => ({ ...m, refs: null })),
      refResolution: { resolved: false, cupboardReachable: null, hostRead: null, error: cat.message },
    };
  }
  const plugins = manifests.map((m) => {
    let refs: ManifestRefReport | null;
    try {
      refs = resolveManifestRefs(m, cat);
    } catch {
      refs = null; // one malformed manifest must not take down the listing
    }
    return { ...m, refs };
  });
  return {
    plugins,
    refResolution: { resolved: true, cupboardReachable: cat.cupboardReachable, hostRead: cat.loadedUnits != null },
  };
}
