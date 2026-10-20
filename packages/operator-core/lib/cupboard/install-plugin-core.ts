/**
 * Install a plugin FROM the Cupboard (revive-cupboard-distribution-2026-06-04
 * D-003 / P2). The Cupboard is a GitHub-repo-backed listing registry — a
 * `kind=plugin` listing points at the plugin's GitHub repo (+ a `listing_ref`
 * discriminator when the repo hosts several). Installing it = git-clone the
 * repo, locate the plugin's `papercusp.json`, place it under global-plugins, and
 * wire the existing capability-gate + install-consent path (D-009): the
 * manifest's declared capabilities are recorded as grants for the target harness
 * when the caller consents.
 *
 * This REPLACES the dead `:3057`/CLI tarball install (D-004) with a git clone —
 * the model the Cupboard already uses for every other listing kind.
 *
 * The core is dependency-injected (clone / global-plugins dir / grant /
 * host-invalidate) so it's unit-testable without real git, network, PG, or the
 * route registry. The route (`install-plugin.ts`) wires the real impls.
 */
import { promises as fs, existsSync } from 'node:fs';
import { basename, join, resolve, sep, dirname } from 'node:path';
import type { PluginTriggerPack, ProviderDescriptor } from '@papercusp/plugin-sdk';
import type { TriggerPackInstallation } from './trigger-pack-materialize';
import { validateProviderDeclaration } from '@papercusp/plugin-sdk';
import { isCompilableSchema } from '../json-schema-validation';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { createHash } from 'node:crypto';
import { canonicalTreeDigest, GIT_OBJECT_ID_RE, HEX_SHA256_RE,
  type TreeDigestEntry } from '@papercusp/artifact-registry';
import { fetchVerifiedReleaseFiles, packSelfDescribingDir, packSelfDescribingArchive,
  unpackSelfDescribingArchive, type SelfDescribingArchiveFile } from './self-describing-release';
import type { ResolvedListingCoords } from './resolve-listing-by-kind';
import type { InstalledPluginProvenance } from './types';
export type { InstalledPluginProvenance } from './types';

export interface InstallPluginCoreInput {
  /** The plugin repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo plugin discriminator — a subdir to look in first, and the slug to match. */
  listingRef?: string;
  /** Internal resolver receipt. Production obtains this from the storefront, never tool arguments. */
  listing?: ResolvedListingCoords;
  /** Optional target harness: when set with `acceptCapabilities`, the manifest's
   *  declared capabilities are granted for this harness (install-consent). */
  harness?: string;
  /** Record the manifest's declared capabilities as grants for `harness`. */
  acceptCapabilities?: boolean;
  /** Optional immutable review receipt from a preceding sandbox vetting pass.
   * The live install refuses before replacing any bytes if the repo now exposes
   * a different package identity, permission set, dependency graph, or trigger
   * surface. Used by capability-provider chaining so consent applies to exactly
   * the complete transitive set the caller reviewed. */
  expectedReview?: InstallPluginManifestReview;
  /**
   * Installer-local trigger-pack configuration (P-012, D-013): which local data
   * source each external binding binds to, and the pack input values. Used only
   * when the package carries a trigger pack and `harness` is given.
   */
  triggerPackConfig?: {
    sourceMappings?: Record<string, string>;
    inputs?: Record<string, unknown>;
  };
}

export interface InstalledPluginManifest {
  name: string;
  version: string;
  description?: string;
  capabilities?: string[];
  kind?: string;
  configSchema?: Record<string, unknown>;
  oauth?: Array<{ provider: string; scopes?: string[]; fieldName: string }>;
  triggerPack?: PluginTriggerPack;
  /** Integration provider descriptor (generalized-integrations D-006). */
  provider?: ProviderDescriptor;
  runtime?: { kind?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * What a third-party integration provider asks the owner to consent to
 * (generalized-integrations P-001): the datatypes it produces, the capability
 * subset it serves, the OAuth scopes it requests, and every host it may reach
 * through `host.fetch`. Sorted so the review is a stable consent subject.
 */
export interface InstalledProviderReceipt {
  id: string;
  contractVersion: number;
  runtime: 'daemon';
  datatypes: string[];
  capabilities: string[];
  oauthScopes: string[];
  egressHosts: string[];
  credentialGroup?: string;
}

export interface InstalledTriggerPackReceipt {
  targetCount: number;
  bindingCount: number;
  edgeCount: number;
  sourceKinds: string[];
  /** Portable sources' datatypes, bound to installer-local sources at materialization. */
  datatypes: string[];
  planTargets: Array<{ id: string; path: string; slug: string }>;
  /** Installation never crosses the autonomy-gated trigger arm boundary. */
  armed: false;
}

export interface InstallPluginCoreResult {
  ok: true;
  name: string;
  version: string;
  /** Manifest distribution kind — 'plugin' (default) or 'pack' (runtime-less code-tool pack). */
  kind: string;
  capabilities: string[];
  source: string;
  installedTo: string;
  /** Capabilities granted for `harness` (only when harness + acceptCapabilities). */
  granted: string[];
  /** Descriptor made discoverable by the post-copy host invalidation. */
  triggerPack?: InstalledTriggerPackReceipt;
  /**
   * The materialized pack in `harness` (P-012): installation id, owned plan and
   * disarmed binding ids, and unmet source/input requirements.
   */
  triggerPackInstallation?: TriggerPackInstallation;
  /** Integration provider the owner consented to (registered on host discovery). */
  provider?: InstalledProviderReceipt;
  /** Stable install-review material derived before any destination write. */
  review: InstallPluginManifestReview;
  /** Null for direct GitHub installs; retained in listing.json for an exact loaded installation. */
  provenance: InstalledPluginProvenance | null;
  /**
   * Deps this unit declares that are not installed but resolvable from the
   * Cupboard (advisory — tool-distribution-granularity D-003). Empty when the
   * manifest declares no dependencies.
   *
   * This is ALSO the transitive-recursion channel: `resolveAndInstallDeps` folds
   * it back into its working set, so a unit's own installable deps pull their
   * providers in. `events` therefore has to be here — otherwise a unit whose
   * manifest requires an event family provided by another Cupboard pack would
   * install with that pack absent, and its reactions would never fire.
   */
  installableDependencies?: {
    tools: string[];
    packs: string[];
    plugins: string[];
    events?: ManifestEventDep[];
  };
}

export interface InstallPluginDeclaredDependencies {
  tools: string[];
  packs: string[];
  plugins: string[];
  events: ManifestEventDep[];
}

/** The exact security/dependency surface a caller consents to install. */
export interface InstallPluginManifestReview {
  name: string;
  version: string;
  kind: string;
  capabilities: string[];
  dependencies: InstallPluginDeclaredDependencies;
  triggerPack?: InstalledTriggerPackReceipt;
  provider?: InstalledProviderReceipt;
}

/** A manifest-declared event dependency (plugin-SDK `ManifestEventDependency`, D-003). */
export interface ManifestEventDep {
  family: string;
  /** listen-if-present: an unresolvable optional dep never blocks the install. */
  optional?: boolean;
}

function normalizedStrings(value: unknown): string[] {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
  )].sort();
}

function normalizedEvents(value: unknown): ManifestEventDep[] {
  const byFamily = new Map<string, ManifestEventDep>();
  for (const item of Array.isArray(value) ? value : []) {
    if (item == null || typeof item !== 'object') continue;
    const { family, optional } = item as Record<string, unknown>;
    if (typeof family !== 'string' || family.length === 0) continue;
    const prior = byFamily.get(family);
    if (prior && prior.optional !== true) continue;
    byFamily.set(family, { family, ...(optional === true ? { optional: true } : {}) });
  }
  return [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Validate and summarize a provider declaration before anything is copied.
 * Cupboard-installed providers are third-party code: they must run as a
 * sandboxed `daemon` (D-002/D-006); in-process `js` providers are reserved for
 * first-party plugins that ship in the source tree.
 */
function inspectProviderForInstall(manifest: InstalledPluginManifest): InstalledProviderReceipt | undefined {
  if (manifest.provider === undefined) return undefined;
  const issues = validateProviderDeclaration(manifest);
  if (issues.length > 0) {
    throw new InstallPluginError(`provider declaration invalid: ${issues.join('; ')}`, 422, 'provider_invalid');
  }
  const provider = manifest.provider;
  const runtime = typeof manifest.runtime?.kind === 'string' ? manifest.runtime.kind : 'js';
  if (runtime !== 'daemon') {
    throw new InstallPluginError(
      `Cupboard-installed provider "${provider.id}" must run as a sandboxed daemon (runtime.kind "daemon"), not "${runtime}"`,
      422,
      'provider_runtime_not_sandboxed',
    );
  }
  return {
    id: provider.id,
    contractVersion: provider.contractVersion,
    runtime: 'daemon',
    datatypes: normalizedStrings(provider.datatypes),
    capabilities: normalizedStrings(provider.capabilities),
    oauthScopes: normalizedStrings(provider.oauth?.scopes),
    egressHosts: normalizedStrings(provider.egressHosts),
    ...(provider.oauth?.credentialGroup ? { credentialGroup: provider.oauth.credentialGroup } : {}),
  };
}

function manifestReview(
  manifest: InstalledPluginManifest,
  triggerPack: InstalledTriggerPackReceipt | undefined,
  provider: InstalledProviderReceipt | undefined,
  dependencies: {
    tools?: string[];
    packs?: string[];
    plugins?: string[];
    events?: ManifestEventDep[];
  } | undefined,
): InstallPluginManifestReview {
  return {
    name: manifest.name,
    version: manifest.version,
    kind: typeof manifest.kind === 'string' ? manifest.kind : 'plugin',
    capabilities: normalizedStrings(manifest.capabilities),
    dependencies: {
      tools: normalizedStrings(dependencies?.tools),
      packs: normalizedStrings(dependencies?.packs),
      plugins: normalizedStrings(dependencies?.plugins),
      events: normalizedEvents(dependencies?.events),
    },
    ...(triggerPack ? { triggerPack } : {}),
    ...(provider ? { provider } : {}),
  };
}

export interface InstallPluginCoreDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  fetchAtSha?: (url: string, dest: string, sha: string) => Promise<void>;
  listTreeBlobs?: (dir: string, sha: string, ref: string) => Promise<TreeDigestEntry[]>;
  fetchArtifact?: (contentHash: string) => Promise<Buffer | null>;
  /** Absolute path of the global-plugins dir (install target parent). */
  globalPluginsDir: () => string;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
  /** Persist capability grants for a (plugin, version, harness) — install-consent. */
  grant: (args: {
    pluginName: string;
    pluginVersion: string;
    harnessSlug: string;
    capabilities: string[];
  }) => Promise<void>;
  /** Drop the in-memory plugin-host + api-route caches so the new plugin goes live. */
  invalidateHost: () => void | Promise<void>;
  /**
   * Validate the manifest's declared `dependencies.{tools,packs,plugins,events}`
   * against the host's pack catalog BEFORE the unit is copied into place
   * (tool-distribution-granularity D-003 — plugin-to-tool deps, install-time
   * gate; `events` joins the axis per cupboard-public-release D-003 / P-007).
   * Optional: when absent, declared deps are not gated. Return the dep-validator
   * verdict; hard-missing deps abort the install (422), installable ones surface
   * advisorily on the result.
   *
   * An unresolvable REQUIRED event family is hard-missing exactly like a tool; an
   * unresolvable OPTIONAL one (listen-if-present) never blocks and never appears
   * in `missing`.
   */
  validateDependencies?: (deps: {
    tools?: string[];
    packs?: string[];
    plugins?: string[];
    events?: ManifestEventDep[];
  }) => Promise<{
    ok: boolean;
    missing: { tools: string[]; packs: string[]; plugins: string[]; events?: string[] };
    installable: { tools: string[]; packs: string[]; plugins: string[]; events?: ManifestEventDep[] };
    messages: string[];
  }>;
  /**
   * Materialize a trigger pack into `harnessSlug` (P-012, D-013). Optional: when
   * absent, a trigger pack installs as manifest data only. Refusals carry a
   * stable `code` and happen before any write.
   */
  materializeTriggerPack?: (args: {
    manifest: InstalledPluginManifest & { triggerPack: PluginTriggerPack };
    pluginDir: string;
    harnessSlug: string;
    sourceMappings?: Record<string, string>;
    inputs?: Record<string, unknown>;
  }) => Promise<TriggerPackInstallation>;
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;

export class InstallPluginError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Stable machine code for refusals a caller is expected to branch on. */
    readonly code?: string,
    /** Structured refusal payload (e.g. the review a consent re-call must pin). */
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'InstallPluginError';
  }
}

// A plugin name becomes a directory under global-plugins. It is UNTRUSTED (from
// the cloned repo's papercusp.json), so it must be EITHER a safe single-segment
// slug (optional leading `@`), OR a scoped `@scope/name` where BOTH segments are
// safe slugs — the exact on-disk layout the plugin LOADER recurses into
// (`global-plugins/@scope/name/`; see plugin-loader loader.test.ts "recurses into
// @scope/ dirs"). Rejecting scoped names here (as the old single-segment-only
// regex did) made a legitimately-scoped plugin — e.g. `@papercupai/papercusp-worker`
// — uninstallable via the Cupboard even though the loader loads it fine
// (cupboard-public-release-2026-07-12 P-015 fresh-install acceptance). Anything
// else (bare separator, leading dot, `..`, >2 segments) is rejected: an untrusted
// `../evil` or `@a/../evil` must never escape global-plugins (path traversal →
// arbitrary file deletion via the `rm -rf` target).
const SAFE_NAME_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
function isSafePluginName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  // Scoped `@scope/name`: exactly two safe segments.
  if (name.startsWith('@') && name.includes('/')) {
    const parts = name.slice(1).split('/');
    return parts.length === 2 && parts.every((seg) => SAFE_NAME_SEGMENT_RE.test(seg));
  }
  // Unscoped single segment (an optional bare leading `@` is allowed).
  return SAFE_NAME_SEGMENT_RE.test(name.replace(/^@/, ''));
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallPluginError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/** A within-repo subdir ref must be relative, charset-safe, and contain no `..`/empty segment. */
function isSafeListingRef(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Validate a trigger pack before any destination is replaced. Generic plugin
 * installs retain their historical behavior; the new shape is strict from day
 * one because an invalid declaration otherwise installs cleanly and then stays
 * inert behind a later loader error.
 */
async function inspectTriggerPackForInstall(
  manifest: InstalledPluginManifest,
  pluginDir: string,
): Promise<InstalledTriggerPackReceipt | undefined> {
  if (!manifest.triggerPack) return undefined;

  const [{ validateManifest }, { validateTriggerPackDeclaration }, { parsePlan }] = await Promise.all([
    import('@papercusp/plugin-loader/manifest-validate'),
    import('@papercusp/plugin-sdk'),
    import('@papercusp/plan-parser'),
  ]);
  const shape = validateManifest(manifest);
  if (!shape.ok) {
    throw new InstallPluginError(
      `trigger-pack manifest invalid: ${shape.issues.map((issue) => `${issue.path} — ${issue.message}`).join('; ')}`,
      422,
    );
  }
  const semanticIssues = validateTriggerPackDeclaration(manifest);
  if (semanticIssues.length > 0) {
    throw new InstallPluginError(`trigger-pack manifest invalid: ${semanticIssues.join('; ')}`, 422);
  }
  if (!isCompilableSchema(manifest.triggerPack.inputs)) {
    throw new InstallPluginError('trigger-pack manifest invalid: inputs is not compilable JSON Schema', 422);
  }

  const planTargets: InstalledTriggerPackReceipt['planTargets'] = [];
  for (const target of manifest.triggerPack.targets) {
    if (target.kind === 'recipe') {
      if (!isCompilableSchema(target.argsSchema)) {
        throw new InstallPluginError(
          `trigger-pack manifest invalid: recipe target "${target.id}" argsSchema is not compilable JSON Schema`,
          422,
        );
      }
      continue;
    }
    if (!isCompilableSchema(target.inputSchema)) {
      throw new InstallPluginError(
        `trigger-pack manifest invalid: plan target "${target.id}" inputSchema is not compilable JSON Schema`,
        422,
      );
    }

    const planPath = resolve(pluginDir, target.path);
    assertInside(pluginDir, planPath, `triggerPack target "${target.id}" path`);
    let realPlanPath: string;
    let markdown: string;
    try {
      realPlanPath = await fs.realpath(planPath);
      assertInside(pluginDir, realPlanPath, `triggerPack target "${target.id}" symlink target`);
      markdown = await fs.readFile(realPlanPath, 'utf8');
    } catch (error) {
      if (error instanceof InstallPluginError) throw error;
      throw new InstallPluginError(`trigger-pack plan not readable at ${target.path}`, 422);
    }
    const parsed = parsePlan(markdown);
    if (parsed.isLegacy || !parsed.frontmatter.slug) {
      throw new InstallPluginError(
        `trigger-pack plan at ${target.path} is not a structured plan template`,
        422,
      );
    }
    planTargets.push({ id: target.id, path: target.path, slug: parsed.frontmatter.slug });
  }

  return {
    targetCount: manifest.triggerPack.targets.length,
    bindingCount: manifest.triggerPack.bindings.length,
    edgeCount: manifest.triggerPack.edges.length,
    sourceKinds: [...new Set(manifest.triggerPack.bindings.flatMap((binding) =>
      binding.source.kind === 'external' && binding.source.sourceKind ? [binding.source.sourceKind] : []))].sort(),
    datatypes: [...new Set(manifest.triggerPack.bindings.flatMap((binding) =>
      binding.source.kind === 'external' && binding.source.datatype ? [binding.source.datatype] : []))].sort(),
    planTargets,
    armed: false,
  };
}

async function readManifest(dir: string): Promise<InstalledPluginManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(join(dir, 'papercusp.json'), 'utf8')) as InstalledPluginManifest;
    return m?.name && m?.version ? m : null;
  } catch {
    return null;
  }
}

/**
 * Find the plugin within a freshly-cloned repo. Prefers the `listingRef` subdir
 * (a repo hosting several plugins), else the repo root (single-plugin repo).
 */
async function locatePlugin(
  cloneDir: string,
  listingRef: string | undefined,
): Promise<{ dir: string; manifest: InstalledPluginManifest }> {
  const candidates: string[] = [];
  if (listingRef && isSafeListingRef(listingRef)) {
    const sub = join(cloneDir, listingRef);
    assertInside(cloneDir, sub, `listing_ref "${listingRef}"`);
    candidates.push(sub);
  }
  candidates.push(cloneDir);
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const manifest = await readManifest(dir);
    if (manifest) return { dir, manifest };
  }
  throw new InstallPluginError('no papercusp.json found in the plugin repo (checked listing_ref subdir + root)', 422);
}

/**
 * Replace `target` with a copy of the plugin dir `src` (excluding the repo's
 * .git) without ever leaving `target` absent or half-written.
 *
 * The copy goes to a sibling staging dir first; only a complete copy is
 * swapped in, by rename. The previous install is moved aside, not deleted,
 * until the new one is in place, and is put back if the swap fails. Before
 * EI-25837518317183010 this was rm-then-cp: a copy that failed (or a process
 * killed) between the two left a live installation row whose files were gone.
 * Exported for tests.
 */
export async function replacePluginDir(src: string, target: string): Promise<void> {
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Dot-prefixed siblings: plugin-catalog skips hidden entries, so a staged or
  // set-aside copy is never listed as an installed plugin.
  const staged = join(dirname(target), `.${basename(target)}.installing-${nonce}`);
  const previous = join(dirname(target), `.${basename(target)}.previous-${nonce}`);
  try {
    await fs.cp(src, staged, {
      recursive: true,
      filter: (s) => !s.split(/[/\\]/).includes('.git'),
    });
  } catch (error) {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const hadPrevious = existsSync(target);
  if (hadPrevious) await fs.rename(target, previous);
  try {
    await fs.rename(staged, target);
  } catch (error) {
    if (hadPrevious) await fs.rename(previous, target).catch(() => {});
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  if (hadPrevious) await fs.rm(previous, { recursive: true, force: true }).catch(() => {});
}

/** Fingerprint original package bytes, excluding only the host-owned install receipt. */
function pluginFilesFingerprint(originalFiles: readonly SelfDescribingArchiveFile[], hadListing: boolean): string {
  const files = originalFiles.flatMap((file) => {
    if (file.path !== 'listing.json') return [file];
    if (!hadListing) return [];
    const listing = JSON.parse(file.bytes.toString('utf8')) as Record<string, unknown>;
    if (!listing || typeof listing !== 'object' || Array.isArray(listing)) {
      throw new InstallPluginError('plugin listing.json must be an object', 422, 'installation_provenance_invalid');
    }
    const { cupboardInstallation: _receipt, ...original } = listing;
    return [{ ...file, bytes: Buffer.from(canonicalJson(original)) }];
  });
  return createHash('sha256').update(packSelfDescribingArchive(files)).digest('hex');
}

function pluginContentFingerprint(dir: string, hadListing: boolean): string {
  return pluginFilesFingerprint(unpackSelfDescribingArchive(packSelfDescribingDir(dir)), hadListing);
}

/** Read ONLY the loaded installation. Retained metadata is checked against its current bytes;
 * commerce authority must still confirm this listing/offer and the target payer at turn admission. */
export async function readInstalledPluginProvenance(installation: {
  name: string; version: string; path: string;
}): Promise<InstalledPluginProvenance | null> {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(await fs.readFile(join(installation.path, 'listing.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new InstallPluginError('installed plugin receipt is unreadable', 409, 'installation_provenance_invalid');
  }
  const receipt = raw?.cupboardInstallation as InstalledPluginProvenance | undefined;
  if (!receipt) return null;
  if (receipt.schema !== 'papercusp.plugin-installation/v1' || receipt.name !== installation.name ||
      receipt.version !== installation.version || typeof receipt.hadListing !== 'boolean' ||
      !HEX_SHA256_RE.test(receipt.contentFingerprint ?? '') ||
      !receipt.listing || receipt.listing.releaseVersion !== installation.version ||
      !['r2', 'github'].includes(receipt.contentSource) ||
      pluginContentFingerprint(installation.path, receipt.hadListing) !== receipt.contentFingerprint) {
    throw new InstallPluginError('loaded plugin differs from its retained installation receipt', 409,
      'installation_provenance_invalid');
  }
  return structuredClone(receipt);
}

/** Confirm local bytes against a separately resolved storefront identity and its pinned content.
 * The caller owns the trusted listing read; a retained receipt cannot supply this authority. */
export async function verifyInstalledPluginCommerceProvenance(
  installation: { name: string; version: string; path: string },
  listing: ResolvedListingCoords,
  deps: Pick<InstallPluginCoreDeps, 'fetchArtifact' | 'fetchAtSha' | 'listTreeBlobs' | 'tmpDir'>,
): Promise<InstalledPluginProvenance> {
  const receipt = await readInstalledPluginProvenance(installation);
  const invalid = (message: string): never => {
    throw new InstallPluginError(message, 409, 'installation_commerce_binding_invalid');
  };
  if (!receipt || !listing.listingId || !listing.publisherId || !listing.skuRef ||
      listing.releaseVersion !== installation.version) {
    return invalid('commerce admission needs an exact hosted listing identity');
  }
  const identityFields = ['listingId', 'githubUrl', 'ref', 'publisherId', 'skuRef', 'releaseVersion',
    'releaseContentHash', 'priceModel'] as const;
  for (const field of identityFields) {
    if (receipt.listing[field] !== listing[field]) return invalid(`retained listing differs from hosted ${field}`);
  }
  if (canonicalJson(receipt.listing.pin ?? null) !== canonicalJson(listing.pin ?? null)) {
    return invalid('retained listing differs from the hosted content pin');
  }

  let files: SelfDescribingArchiveFile[] | null = null;
  if (listing.releaseContentHash && deps.fetchArtifact) {
    files = await fetchVerifiedReleaseFiles(listing.releaseContentHash, deps.fetchArtifact);
  }
  if (!files && listing.pin && deps.fetchAtSha && deps.listTreeBlobs &&
      GIT_OBJECT_ID_RE.test(listing.pin.commitSha) && HEX_SHA256_RE.test(listing.pin.treeDigest)) {
    const dir = await fs.mkdtemp(join(deps.tmpDir(), 'cupboard-plugin-admission-'));
    try {
      await deps.fetchAtSha(listing.githubUrl, dir, listing.pin.commitSha);
      const entries = await deps.listTreeBlobs(dir, listing.pin.commitSha, listing.ref);
      if (!entries.length || await canonicalTreeDigest(entries) !== listing.pin.treeDigest) {
        return invalid('hosted plugin mirror differs from the pinned tree');
      }
      const pluginDir = resolve(dir, listing.ref);
      assertInside(dir, pluginDir, 'plugin commerce listing ref');
      files = unpackSelfDescribingArchive(packSelfDescribingDir(pluginDir));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  if (!files || files.some((file) => file.path.split('/').includes('.git'))) {
    return invalid('hosted plugin content is unavailable or invalid');
  }
  const hadListing = files.some((file) => file.path === 'listing.json');
  if (receipt.hadListing !== hadListing ||
      receipt.contentFingerprint !== pluginFilesFingerprint(files, hadListing)) {
    return invalid('loaded plugin bytes do not match the hosted pinned release');
  }
  // Content lookup can yield to other work. Refuse a local edit during admission.
  const current = await readInstalledPluginProvenance(installation);
  if (canonicalJson(current) !== canonicalJson(receipt)) return invalid('installation changed during admission');
  return { ...receipt, listing: structuredClone(listing) };
}

export async function installPluginFromCupboardCore(
  input: InstallPluginCoreInput,
  deps: InstallPluginCoreDeps,
): Promise<InstallPluginCoreResult> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallPluginError(`invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`, 400);
  }

  const cloneDir = join(deps.tmpDir(), `cupboard-plugin-${Date.now()}-${Math.floor(performance.now())}`);
  try {
    const listing = input.listing;
    if (listing && (listing.githubUrl !== url || listing.ref !== input.listingRef)) {
      throw new InstallPluginError('listing coordinates disagree with the requested plugin', 422, 'listing_binding_mismatch');
    }
    const perUse = listing?.priceModel === 'per-use';
    if (perUse && (!listing.listingId || !listing.publisherId || !listing.skuRef || !listing.releaseVersion)) {
      throw new InstallPluginError('per-use plugin needs exact listing, publisher, SKU and release', 422,
        'installation_provenance_required');
    }
    let verified = false;
    let contentSource: 'r2' | 'github' = 'github';
    if (listing?.releaseContentHash && deps.fetchArtifact) {
      const files = await fetchVerifiedReleaseFiles(listing.releaseContentHash, deps.fetchArtifact);
      if (files) {
        const dir = join(cloneDir, listing.ref);
        assertInside(cloneDir, dir, 'plugin listing ref');
        for (const file of files) {
          if (file.path.split('/').includes('.git')) {
            throw new InstallPluginError('release contains excluded git metadata', 422, 'installation_provenance_invalid');
          }
          const dest = join(dir, file.path);
          await fs.mkdir(dirname(dest), { recursive: true });
          await fs.writeFile(dest, file.bytes);
        }
        verified = true;
        contentSource = 'r2';
      }
    }
    if (!verified && listing?.pin) {
      if (!GIT_OBJECT_ID_RE.test(listing.pin.commitSha) || !HEX_SHA256_RE.test(listing.pin.treeDigest)) {
        throw new InstallPluginError('malformed plugin content pin', 400, 'malformed_pin');
      }
      if (!deps.fetchAtSha || !deps.listTreeBlobs) {
        throw new InstallPluginError('pinned plugin installer is unavailable', 503, 'installation_provenance_required');
      }
      await deps.fetchAtSha(url, cloneDir, listing.pin.commitSha);
      const entries = await deps.listTreeBlobs(cloneDir, listing.pin.commitSha, listing.ref);
      if (!entries.length || await canonicalTreeDigest(entries) !== listing.pin.treeDigest) {
        throw new InstallPluginError('plugin mirror differs from its content pin', 422, 'content-address-mismatch');
      }
      verified = true;
    }
    if (!verified) {
      if (perUse || listing?.releaseContentHash) {
        throw new InstallPluginError('plugin release bytes could not be verified', 422, 'installation_provenance_required');
      }
      await deps.cloneRepo(url, cloneDir);
    }
    const { dir: pluginDir, manifest } = await locatePlugin(cloneDir, input.listingRef);
    if (listing?.releaseVersion && manifest.version !== listing.releaseVersion) {
      throw new InstallPluginError('plugin manifest version differs from the listed release', 422, 'listing_binding_mismatch');
    }
    // A pinned subdirectory must be the directory actually installed, never a locatePlugin fallback.
    if (verified && listing && resolve(pluginDir) !== resolve(cloneDir, listing.ref)) {
      throw new InstallPluginError('pinned listing does not contain its plugin manifest', 422, 'listing_binding_mismatch');
    }
    let provenance: InstalledPluginProvenance | null = null;
    let localListing: Record<string, unknown> = {};
    let stripSuppliedReceipt = false;
    const hadListing = existsSync(join(pluginDir, 'listing.json'));
    if (hadListing) {
      try {
        const supplied = JSON.parse(await fs.readFile(join(pluginDir, 'listing.json'), 'utf8'));
        if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
          const { cupboardInstallation: _receipt, ...original } = supplied;
          localListing = original;
          stripSuppliedReceipt = 'cupboardInstallation' in supplied;
        }
      } catch {
        if (verified) throw new InstallPluginError('plugin listing.json is invalid', 422, 'installation_provenance_invalid');
      }
    }
    if (verified && listing?.releaseVersion) {
      provenance = { schema: 'papercusp.plugin-installation/v1', name: manifest.name, version: manifest.version,
        listing: structuredClone(listing), contentSource, hadListing,
        contentFingerprint: pluginContentFingerprint(pluginDir, hadListing) };
    }
    const triggerPack = await inspectTriggerPackForInstall(manifest, pluginDir);
    const provider = inspectProviderForInstall(manifest);

    // manifest.name is UNTRUSTED (from the cloned repo) and becomes a directory we
    // `rm -rf` + `cp` into — so it must be a safe single-segment slug, never a path.
    // Otherwise a malicious manifest (`"name": "../../.ssh"`) would delete/overwrite
    // files outside global-plugins (path traversal → arbitrary file deletion).
    if (typeof manifest.name !== 'string' || !isSafePluginName(manifest.name)) {
      throw new InstallPluginError(
        `unsafe plugin name ${JSON.stringify(manifest.name)} — must be a single-segment slug or a scoped @scope/name`,
        400,
      );
    }

    // Install-time dependency gate (tool-distribution-granularity D-003): a
    // unit declaring `dependencies` with a hard-missing dep (no provider
    // anywhere) fails BEFORE anything is copied into place. Installable-from-
    // Cupboard deps never block — they surface advisorily on the result.
    const declaredDeps = (
      manifest as {
        dependencies?: { tools?: string[]; packs?: string[]; plugins?: string[]; events?: ManifestEventDep[] };
      }
    ).dependencies;
    let installableDependencies: InstallPluginCoreResult['installableDependencies'];
    // `events` counts here: a unit whose ONLY declared dep is an event family
    // must still be gated. Omitting it from this check would skip the gate
    // entirely for that unit — it installs, resolves nothing, and its reactions
    // silently never fire (the exact failure the event axis exists to prevent).
    const hasDeclaredDeps =
      (declaredDeps?.tools?.length ?? 0) > 0 ||
      (declaredDeps?.packs?.length ?? 0) > 0 ||
      (declaredDeps?.plugins?.length ?? 0) > 0 ||
      (declaredDeps?.events?.length ?? 0) > 0;
    if (hasDeclaredDeps && deps.validateDependencies) {
      const verdict = await deps.validateDependencies(declaredDeps!);
      if (!verdict.ok) {
        throw new InstallPluginError(
          `dependencies unmet: ${verdict.messages.join('; ') || 'unknown'}`,
          422,
        );
      }
      const inst = verdict.installable;
      if (
        inst.tools.length > 0 ||
        inst.packs.length > 0 ||
        inst.plugins.length > 0 ||
        (inst.events?.length ?? 0) > 0
      ) {
        installableDependencies = inst;
      }
    }

    const review = manifestReview(manifest, triggerPack, provider, declaredDeps);
    if (input.expectedReview && canonicalJson(input.expectedReview) !== canonicalJson(review)) {
      throw new InstallPluginError(
        `plugin review changed after consent for ${manifest.name}@${manifest.version}; review the current package closure before installing`,
        409,
        'plugin_review_changed',
        { review },
      );
    }
    // A provider reaches accounts and the network on the owner's behalf, so it
    // never installs on an implicit yes: consent is a second call that pins the
    // exact review returned here (datatypes, capabilities, scopes, egress).
    if (provider && !(input.acceptCapabilities && input.expectedReview)) {
      throw new InstallPluginError(
        `provider "${provider.id}" requires consent: re-call with acceptCapabilities:true and expectedReview set to the returned review`,
        409,
        'provider_install_consent_required',
        { review },
      );
    }

    // Trigger-pack materialization (P-012, D-013 §6): with a target harness the
    // pack becomes its plans and DISARMED bindings. Every refusal happens in the
    // materializer's write-free preflight, so it runs before the bytes are
    // replaced: an unsupported pack refuses the whole install cleanly.
    let triggerPackInstallation: TriggerPackInstallation | undefined;
    if (triggerPack && input.harness && deps.materializeTriggerPack) {
      try {
        triggerPackInstallation = await deps.materializeTriggerPack({
          manifest: manifest as InstalledPluginManifest & { triggerPack: PluginTriggerPack },
          pluginDir,
          harnessSlug: input.harness,
          sourceMappings: input.triggerPackConfig?.sourceMappings,
          inputs: input.triggerPackConfig?.inputs,
        });
      } catch (error) {
        const code = (error as { name?: unknown; code?: unknown })?.code;
        if ((error as { name?: unknown })?.name === 'TriggerPackMaterializeError' && typeof code === 'string') {
          throw new InstallPluginError((error as Error).message, 422, code);
        }
        throw error;
      }
    }

    const target = join(deps.globalPluginsDir(), manifest.name);
    assertInside(deps.globalPluginsDir(), target, `plugin name "${manifest.name}"`);
    // mkdir the target's PARENT (not just global-plugins) so a scoped
    // `@scope/name` lands at global-plugins/@scope/name/ — the loader's layout.
    // For an unscoped name this is global-plugins itself (unchanged).
    await fs.mkdir(dirname(target), { recursive: true });
    await replacePluginDir(pluginDir, target);
    if (provenance) {
      await fs.writeFile(join(target, 'listing.json'), canonicalJson({ ...localListing, cupboardInstallation: provenance }));
    } else if (stripSuppliedReceipt) {
      // A package cannot supply its own host install receipt on the unmanaged path.
      await fs.writeFile(join(target, 'listing.json'), canonicalJson(localListing));
    }

    const capabilities = review.capabilities;

    // Install-consent (D-009): when a target harness is given and the caller
    // accepted, record the manifest's declared caps as grants for that harness.
    // The runtime then enforces `manifest ∩ granted` (fork-install-consent).
    let granted: string[] = [];
    if (input.harness && input.acceptCapabilities && capabilities.length > 0) {
      await deps.grant({
        pluginName: manifest.name,
        pluginVersion: manifest.version,
        harnessSlug: input.harness,
        capabilities,
      });
      granted = capabilities;
    }

    await deps.invalidateHost();

    return {
      ok: true,
      name: manifest.name,
      version: manifest.version,
      kind: typeof manifest.kind === 'string' ? manifest.kind : 'plugin',
      capabilities,
      source: url,
      installedTo: target,
      granted,
      review,
      provenance,
      ...(triggerPack ? { triggerPack } : {}),
      ...(triggerPackInstallation ? { triggerPackInstallation } : {}),
      ...(provider ? { provider } : {}),
      ...(installableDependencies ? { installableDependencies } : {}),
    };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
