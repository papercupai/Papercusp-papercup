/** code-intel-reuse-signals P-009: bounded composition at existing brief surfaces. */
import { pinModuleState } from '@papercusp/module-singleton';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { postgresLineageProvider } from './postgres-lineage';
import { reuseHoldout } from './reuse-measurement';

export const REUSE_BRIEF_LIMIT = 3_000;
export const REUSE_BRIEF_DEADLINE_MS = 6_000;
export const REUSE_PROVIDER_DEADLINE_MS = 750;
export const REUSE_PROVIDER_POLICY = {
  clones: { priority: 10, cap: 600, section: 'impact' },
  cochange: { priority: 20, cap: 250, section: 'coChange' },
  provenance: { priority: 30, cap: 400, section: 'whatChangedSincePlanning' },
  sql: { priority: 40, cap: 450, section: 'impact' },
  coverage: { priority: 50, cap: 400, section: 'tests' },
  semantic: { priority: 60, cap: 450, section: 'impact' },
} as const;
export type ReuseProviderId = keyof typeof REUSE_PROVIDER_POLICY;
export const REUSE_PROVIDER_FLAGS = {
  clones: FLAGS.CODE_INTEL_REUSE_CLONES, cochange: FLAGS.CODE_INTEL_REUSE_COCHANGE,
  provenance: FLAGS.CODE_INTEL_REUSE_PROVENANCE, sql: FLAGS.CODE_INTEL_REUSE_SQL,
  coverage: FLAGS.CODE_INTEL_REUSE_COVERAGE, semantic: FLAGS.CODE_INTEL_REUSE_SEMANTIC,
} satisfies Record<ReuseProviderId, FlagKey>;
export type ReuseBriefSurface = 'claim' | 'authoring' | 'completion';
export type ReuseBriefDestination = (typeof REUSE_PROVIDER_POLICY)[ReuseProviderId]['section'];
export interface ReuseProviderContext {
  surface: ReuseBriefSurface;
  workspaceId: string;
  owner: string;
  invocation: string;
  workItem?: string;
  plan?: string;
  planItems?: readonly string[];
  paths: readonly string[];
  sourceVersion: string | null;
  /** Actual item text supplied by the authoring/anchorless-claim entry. */
  itemText?: string;
  /** Authority and hashes from the mandatory brief capture, never the operator cwd. */
  repository?: { workspaceId: string; rootPath: string; harness?: string };
  sourceFiles?: readonly { path: string; sha256: string }[];
  /** Independently checked source paths from bound evidence; missing is unknown. */
  checkedPaths?: readonly string[];
  /** Actual repository commit, distinct from the scoped source fingerprint. */
  commit?: string | null;
  /** Producer adapter's exact changed-line/static reach scope; absent means unmeasured. */
  changedLines?: Readonly<Record<string, readonly number[]>>;
  staticTests?: readonly string[];
}
export interface ReuseProviderResult {
  status: 'measured' | 'unknown';
  /** Complete, already qualified lines; no partial citation or qualifier is emitted. */
  lines: readonly string[];
  sourceVersion: string | null;
  indexVersion: string | null;
  citedPaths?: readonly string[];
}
export interface ReuseBriefProvider {
  id: ReuseProviderId;
  read(context: Readonly<ReuseProviderContext>, signal: AbortSignal): Promise<ReuseProviderResult>;
}
export interface ReuseContribution {
  provider: ReuseProviderId;
  section: (typeof REUSE_PROVIDER_POLICY)[ReuseProviderId]['section'];
  text: string;
  sourceVersion: string;
  indexVersion: string;
}
type ClaimReuseSource = { sourceFingerprint: string | null };
const fullSourceFingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validClaimContribution(value: unknown, source: ClaimReuseSource): value is ReuseContribution {
  if (!fullSourceFingerprint(source.sourceFingerprint) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.provider === 'string' && Object.hasOwn(REUSE_PROVIDER_POLICY, row.provider)
    && row.section === REUSE_PROVIDER_POLICY[row.provider as ReuseProviderId].section
    && row.sourceVersion === source.sourceFingerprint
    && typeof row.indexVersion === 'string' && row.indexVersion.trim().length > 0
    && typeof row.text === 'string' && row.text.length > 0;
}
/** r1 is local to its unchanged enclosing claim brief: sourceVersion is the
 * complete sourceFingerprint already in that container, never a shortened hash.
 * Keep provider/section/index/text exact; independent issued identities stay full.
 */
export function encodeClaimReuseContribution(source: ClaimReuseSource, value: ReuseContribution): string {
  if (!validClaimContribution(value, source)) throw new Error('Invalid claim reuse contribution or enclosing source identity');
  return 'r1:' + JSON.stringify([value.provider, value.section, value.indexVersion, value.text]);
}
/** Read both maintained r1 and legacy JSON objects. A relationship without its
 * full enclosing fingerprint, or an unknown/malformed protocol, is not evidence.
 */
export function decodeClaimReuseContribution(source: ClaimReuseSource, wire: string): ReuseContribution | null {
  if (!fullSourceFingerprint(source.sourceFingerprint) || typeof wire !== 'string') return null;
  try {
    let value: unknown;
    if (wire.startsWith('r1:')) {
      const tuple: unknown = JSON.parse(wire.slice(3));
      if (!Array.isArray(tuple) || tuple.length !== 4) return null;
      const [provider, section, indexVersion, text] = tuple;
      value = { provider, section, indexVersion, text, sourceVersion: source.sourceFingerprint };
    } else value = JSON.parse(wire);
    return validClaimContribution(value, source) ? value : null;
  } catch { return null; }
}
export interface ReuseProviderObservation {
  provider: ReuseProviderId;
  status: 'issued' | 'held-out' | 'disabled' | 'no-match' | 'unknown' | 'budget';
  reason: 'complete' | 'holdout' | 'disabled' | 'truncated' | 'timeout' | 'failure' | 'unversioned' | 'budget' | 'destination-unavailable' | 'source-mismatch';
  sourceVersion: string | null;
  indexVersion: string | null;
  chars: number;
  citedPaths: string[];
  /** Only exact work-item exposures enter the preregistered experiment. */
  cohort?: 'treatment' | 'holdout';
}
const registry = pinModuleState('operator-core.reuse-brief-providers.v1', () => new Map<ReuseProviderId, ReuseBriefProvider>());
export function registerReuseBriefProvider(provider: ReuseBriefProvider): () => void {
  if (!Object.hasOwn(REUSE_PROVIDER_POLICY, provider.id)) throw new Error('Unknown reuse brief provider');
  if (registry.has(provider.id)) throw new Error(`Reuse brief provider already registered: ${provider.id}`);
  registry.set(provider.id, provider);
  return () => { if (registry.get(provider.id) === provider) registry.delete(provider.id); };
}
const sqlProvider = postgresLineageProvider(async (context, signal) => {
  if (!context.repository || context.repository.workspaceId !== context.workspaceId || !context.sourceFiles?.length || !context.sourceVersion) return null;
  const { readPostgresLineage } = await import('./postgres-lineage-query');
  const { createHash } = await import('node:crypto');
  // Match the mandatory task-brief fingerprint writer, including capture order.
  const fingerprint = createHash('sha256').update(JSON.stringify(context.sourceFiles.map(s => [s.path, s.sha256]))).digest('hex');
  if (fingerprint !== context.sourceVersion) return null;
  const report = await readPostgresLineage(context.repository.rootPath, context.sourceFiles.map(s => s.path), signal);
  const actual = new Map(report.sourceFiles.map(s => [s.path, s.contentHash]));
  if (context.sourceFiles.some(s => actual.get(s.path) !== s.sha256)) return null;
  return { report, sourceVersion: fingerprint };
});
export const registeredReuseBriefProviders = (): readonly ReuseBriefProvider[] =>
  [...registry.values(), ...(registry.has('sql') ? [] : [sqlProvider]),
    ...(registry.has('clones') ? [] : [cloneProvider]),
    ...(registry.has('coverage') ? [] : [coverageProvider]),
    ...(registry.has('semantic') ? [] : [semanticProvider])];
/** Optional producer packages can publish later than the shared registry. Their
 * absence must remain an unknown provider result, never a mandatory brief import failure. */
const coverageProvider: ReuseBriefProvider = { id: 'coverage', async read(context, signal) {
  const { nativeCoverageBriefProvider } = await import('./test-coverage-map');
  return nativeCoverageBriefProvider.read(context, signal);
} };
const cloneProvider: ReuseBriefProvider = { id: 'clones', async read(context, signal) {
  const { cloneBriefProvider } = await import('./clone-brief-provider');
  return cloneBriefProvider().read(context, signal);
} };
const semanticProvider: ReuseBriefProvider = { id: 'semantic', async read(context, signal) {
  const { semanticCodeProvider } = await import('./semantic-code-runtime');
  return semanticCodeProvider().read(context, signal);
} };
export const briefCodePoints = (value: string): number => Array.from(value).length;

/** One collector per dispatch: bulk claims must not overwrite earlier item outcomes. */
export function createReuseBriefIdentity(owner: string, invocation: string | undefined,
  emit: (outcomes: unknown[]) => void) {
  const outcomes: unknown[] = [];
  return invocation ? { owner, invocation, observe: (outcome: unknown) => {
    outcomes.push(outcome); emit([...outcomes]);
  } } : undefined;
}

/** The adapter appends into its existing sections. Base data is never shortened to fit optional content.
 * `deadline` starts BEFORE mandatory assembly; callers must not reset the six-second clock here.
 * Observer I/O belongs to the caller's remaining deadline, never this deterministic renderer.
 */
export async function composeReuseBrief<T>(input: {
  base: T;
  context: ReuseProviderContext;
  deadline: number;
  append(base: T, contribution: ReuseContribution): T;
  /** Missing upstream slots are unknown, not empty measured sections (D-011). */
  available?: (section: ReuseBriefDestination) => boolean;
  providers?: readonly ReuseBriefProvider[];
  enabled?: (provider: ReuseProviderId) => Promise<boolean>;
  now?: () => number;
  serialize?: (brief: T) => string;
  /** A caller may require a smaller response; never widen the shared cap. */
  maxChars?: number;
}): Promise<{ brief: T; observations: ReuseProviderObservation[] }> {
  const now = input.now ?? Date.now;
  const serialize = input.serialize ?? JSON.stringify;
  const limit = Math.min(REUSE_BRIEF_LIMIT, input.maxChars ?? REUSE_BRIEF_LIMIT);
  const providers = [...(input.providers ?? registeredReuseBriefProviders())];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!Object.hasOwn(REUSE_PROVIDER_POLICY, provider.id) || seen.has(provider.id)) throw new Error('Invalid or duplicate reuse provider');
    seen.add(provider.id);
  }
  providers.sort((a, b) => REUSE_PROVIDER_POLICY[a.id].priority - REUSE_PROVIDER_POLICY[b.id].priority);
  const observations: ReuseProviderObservation[] = [];
  const observation = (provider: ReuseProviderId): ReuseProviderObservation => ({ provider,
    status: 'unknown', reason: 'timeout', sourceVersion: null, indexVersion: null, chars: 0, citedPaths: [] });
  const full = briefCodePoints(serialize(input.base)) >= limit;
  // Read independently: a hung high-priority provider cannot prevent the other sources from finishing.
  const results = await Promise.all(providers.map(async provider => {
    const row = observation(provider.id);
    if (input.available && !input.available(REUSE_PROVIDER_POLICY[provider.id].section)) {
      row.reason = 'destination-unavailable'; return { row, result: null };
    }
    if (full) { row.status = 'budget'; row.reason = 'budget'; return { row, result: null }; }
    const remaining = input.deadline - now();
    if (remaining <= 0) return { row, result: null };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(async () => {
          if (!await (input.enabled ?? (id => getFlag(REUSE_PROVIDER_FLAGS[id], 'system')))(provider.id)) {
            row.status = 'disabled'; row.reason = 'disabled'; return null;
          }
          if (controller.signal.aborted) return null;
          return provider.read(Object.freeze({ ...input.context,
          paths: Object.freeze([...input.context.paths]), planItems: Object.freeze([...(input.context.planItems ?? [])]),
          repository: input.context.repository ? Object.freeze({ ...input.context.repository }) : undefined,
          sourceFiles: input.context.sourceFiles ? Object.freeze(input.context.sourceFiles.map(row => Object.freeze({ ...row }))) : undefined,
          checkedPaths: input.context.checkedPaths ? Object.freeze([...input.context.checkedPaths]) : undefined,
          changedLines: input.context.changedLines ? Object.freeze(Object.fromEntries(Object.entries(input.context.changedLines)
            .map(([path, lines]) => [path, Object.freeze([...lines])]))) : undefined,
          staticTests: input.context.staticTests ? Object.freeze([...input.context.staticTests]) : undefined }), controller.signal);
        }),
        new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); },
          Math.min(REUSE_PROVIDER_DEADLINE_MS, remaining)); }),
      ]);
      if (!result || now() >= input.deadline) return { row, result: null };
      row.sourceVersion = result.sourceVersion;
      row.indexVersion = result.indexVersion;
      row.citedPaths = [...new Set(result.citedPaths ?? [])].slice(0, 20);
      if (result.status !== 'measured' || !result.sourceVersion || !result.indexVersion) {
        row.reason = 'unversioned'; return { row, result: null };
      }
      if (input.context.sourceVersion !== result.sourceVersion) {
        row.reason = 'source-mismatch'; return { row, result: null };
      }
      if (input.context.workItem?.trim()) row.cohort = reuseHoldout(input.context.workItem, provider.id) ? 'holdout' : 'treatment';
      row.status = result.lines.length ? 'budget' : 'no-match'; row.reason = 'complete';
      return { row, result };
    } catch {
      row.reason = 'failure'; return { row, result: null };
    } finally { clearTimeout(timer); controller.abort(); }
  }));
  let brief = input.base;
  for (const { row, result } of results) {
    observations.push(row);
    if (!result?.lines.length) continue;
    const policy = REUSE_PROVIDER_POLICY[row.provider];
    let text = '';
    let accepted: T | undefined;
    let charged = 0;
    for (const line of result.lines) {
      if (now() >= input.deadline) { row.reason = 'timeout'; break; }
      const candidate: ReuseContribution = { provider: row.provider, section: policy.section,
        text: text ? `${text}\n${line}` : line, sourceVersion: result.sourceVersion!, indexVersion: result.indexVersion! };
      // Count envelope, field names, labels, escaping and Unicode code points too.
      if (briefCodePoints(JSON.stringify(candidate)) > policy.cap) { row.reason = 'truncated'; break; }
      let next: T;
      try { next = input.append(structuredClone(brief), candidate); }
      catch { row.status = 'unknown'; row.reason = 'failure'; break; }
      const size = briefCodePoints(serialize(next));
      const cost = Math.max(briefCodePoints(JSON.stringify(candidate)), size - briefCodePoints(serialize(brief)));
      if (cost > policy.cap || size > limit) { row.reason = 'truncated'; break; }
      if (now() >= input.deadline) { row.reason = 'timeout'; break; }
      text = candidate.text;
      accepted = next;
      charged = cost;
    }
    if (text) {
      const next = accepted!;
      const encoded = serialize(next);
      if (now() >= input.deadline || briefCodePoints(encoded) > limit) { row.reason = 'timeout'; continue; }
      // Apply identical source, destination and budget qualification to both
      // arms. A held-out candidate is observed, never placed in the response.
      if (row.cohort === 'holdout') { row.status = 'held-out'; row.reason = 'holdout'; }
      else { brief = next; row.status = 'issued'; row.chars = charged; }
    }
  }
  return { brief, observations };
}
