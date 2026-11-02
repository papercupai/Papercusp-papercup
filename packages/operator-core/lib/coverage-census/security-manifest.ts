/**
 * P-001 security inventory snapshots over the existing census surface contract.
 *
 * These are content identities and reconciliation checks, NOT confinement or
 * approval receipts. Qualification still needs an authenticated host commitment
 * and independent reviewer eligibility before it may execute any probe.
 * Source adapters must capture canonical registries/builds/dispatch observations;
 * passing a hand-authored population here does not establish completeness.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import type { ObservedSurface } from '@papercusp/testing-shell/census';

export const SECURITY_POPULATIONS = [
  'handler', 'effect', 'entry-point', 'loader', 'native-helper', 'distribution', 'observed-route',
] as const;
export type SecurityPopulation = (typeof SECURITY_POPULATIONS)[number];

export interface SecuritySourcePin { revision: string; sha256: string }
export interface SecurityPopulationInput {
  id: string;
  population: SecurityPopulation;
  source: SecuritySourcePin;
  surfaces: readonly ObservedSurface[];
}
export interface SecurityManifest {
  schemaVersion: 1;
  producer: string;
  source: SecuritySourcePin;
  /** Digest of the loaded artifact, never inferred from a checkout revision. */
  runtime: SecuritySourcePin;
  inputs: readonly SecurityPopulationInput[];
}
export interface SecuritySnapshot<T> {
  readonly sha256: string;
  readonly bytes: string;
  readonly body: T;
}

function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`security_manifest_missing:${field}`);
}
function digest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`security_manifest_invalid_digest:${field}`);
}
function pin(value: SecuritySourcePin, field: string): void {
  nonempty(value.revision, `${field}.revision`);
  digest(value.sha256, `${field}.sha256`);
}
function sha256(bytes: string): string { return createHash('sha256').update(bytes).digest('hex'); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member);
    Object.freeze(value);
  }
  return value;
}
function snapshot<T>(body: T): SecuritySnapshot<T> {
  const bytes = canonicalJson(body);
  // Clone first: freezing a snapshot must not freeze the live registries it read.
  return Object.freeze({ bytes, sha256: sha256(bytes), body: freeze(JSON.parse(bytes) as T) });
}
function verifySnapshot<T>(value: SecuritySnapshot<T>): void {
  if (canonicalJson(value.body) !== value.bytes || sha256(value.bytes) !== value.sha256) {
    throw new Error('security_manifest_snapshot_drift');
  }
}
function surfaceKey(population: SecurityPopulation, surface: Pick<ObservedSurface, 'kind' | 'surfaceId'>): string {
  nonempty(surface.kind, 'surface.kind');
  nonempty(surface.surfaceId, 'surface.surfaceId');
  return canonicalJson([population, surface.kind, surface.surfaceId]);
}
function normalizeInputs(inputs: readonly SecurityPopulationInput[]): SecurityPopulationInput[] {
  const inputIds = new Set<string>(), members = new Set<string>();
  const populations = new Set<SecurityPopulation>();
  const normalized = inputs.map(input => {
    nonempty(input.id, 'input.id');
    if (inputIds.has(input.id)) throw new Error(`security_manifest_duplicate_input:${input.id}`);
    inputIds.add(input.id);
    if (!SECURITY_POPULATIONS.includes(input.population)) throw new Error('security_manifest_unknown_population');
    populations.add(input.population);
    pin(input.source, `input:${input.id}`);
    if (!input.surfaces.length) throw new Error(`security_manifest_empty_input:${input.id}`);
    const surfaces = input.surfaces.map(surface => {
      const key = surfaceKey(input.population, surface);
      if (members.has(key)) throw new Error(`security_manifest_duplicate_surface:${key}`);
      members.add(key);
      return surface;
    }).sort((a, b) => compare(surfaceKey(input.population, a), surfaceKey(input.population, b)));
    return { ...input, surfaces };
  });
  for (const population of SECURITY_POPULATIONS) {
    if (!populations.has(population)) throw new Error(`security_manifest_missing_population:${population}`);
  }
  return normalized.sort((a, b) => compare(a.id, b.id));
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function createSecurityManifest(input: Omit<SecurityManifest, 'schemaVersion'>): SecuritySnapshot<SecurityManifest> {
  nonempty(input.producer, 'producer');
  pin(input.source, 'source');
  pin(input.runtime, 'runtime');
  return snapshot({ ...input, schemaVersion: 1, inputs: normalizeInputs(input.inputs) });
}

/** Compare a frozen population to a separately collected census in BOTH directions. */
export function reconcileSecurityManifest(
  manifest: SecuritySnapshot<SecurityManifest>,
  current: Omit<SecurityManifest, 'schemaVersion'>,
): { missing: string[]; unexpected: string[]; changed: string[]; matches: boolean } {
  verifySnapshot(manifest);
  const actual = createSecurityManifest(current);
  const rows = (inputs: readonly SecurityPopulationInput[]) => new Map(inputs.flatMap(input =>
    input.surfaces.map(surface => [surfaceKey(input.population, surface), canonicalJson({
      inputId: input.id, source: input.source, surface,
    })] as const)));
  const frozen = rows(manifest.body.inputs), live = rows(actual.body.inputs);
  const missing = [...live.keys()].filter(key => !frozen.has(key)).sort();
  const unexpected = [...frozen.keys()].filter(key => !live.has(key)).sort();
  const changed = [...live.keys()].filter(key => frozen.has(key) && frozen.get(key) !== live.get(key)).sort();
  for (const field of ['source', 'runtime', 'producer'] as const) {
    if (canonicalJson(manifest.body[field]) !== canonicalJson(actual.body[field])) changed.push(field);
  }
  return { missing, unexpected, changed, matches: !missing.length && !unexpected.length && !changed.length };
}

/** Every dimension participates in identity; applicability/results NEVER do. */
export interface SecurityTuple {
  population: SecurityPopulation;
  kind: string;
  surfaceId: string;
  distribution: string;
  platform: string;
  runtime: string;
  enforcementMode: string;
  effect: string;
  channel: string;
}
export function securityTupleId(tuple: SecurityTuple): string {
  for (const field of ['kind', 'surfaceId', 'distribution', 'platform', 'runtime', 'enforcementMode', 'effect', 'channel'] as const) {
    nonempty(tuple[field], `tuple.${field}`);
  }
  if (!SECURITY_POPULATIONS.includes(tuple.population)) throw new Error('security_tuple_unknown_population');
  // Select fields explicitly: incidental caller properties cannot change row identity.
  return sha256(canonicalJson([tuple.population, tuple.kind, tuple.surfaceId, tuple.distribution,
    tuple.platform, tuple.runtime, tuple.enforcementMode, tuple.effect, tuple.channel]));
}
export interface SecurityProbeIdentity {
  id: string;
  rowId: string;
  sourceSha256: string;
  testSha256: string;
  fixtureSha256: string;
  runtimeSha256: string;
}
export type SecurityTupleDisposition = { rowId: string; reason: string; sourceRefs: readonly string[] } & (
  | { applicability: 'applicable'; owner: string; positiveControl: SecurityProbeIdentity; negativeCanary: SecurityProbeIdentity }
  | { applicability: 'notApplicable' }
);
export interface SecurityTupleLedger {
  schemaVersion: 1;
  manifestSha256: string;
  producer: string;
  rows: readonly { rowId: string; tuple: SecurityTuple; disposition: SecurityTupleDisposition }[];
}

/** Freeze intended probes BEFORE outcomes. This function grants no execution authority. */
export function createSecurityTupleLedger(input: {
  manifest: SecuritySnapshot<SecurityManifest>;
  producer: string;
  /** Expected tuples must be independently derived from pinned applicability sources. */
  tuples: readonly SecurityTuple[];
  dispositions: readonly SecurityTupleDisposition[];
}): SecuritySnapshot<SecurityTupleLedger> {
  verifySnapshot(input.manifest);
  nonempty(input.producer, 'ledger.producer');
  if (!input.tuples.length) throw new Error('security_tuple_empty_population');
  const members = new Set(input.manifest.body.inputs.flatMap(i => i.surfaces.map(s => surfaceKey(i.population, s))));
  const tuples = new Map<string, SecurityTuple>();
  const represented = new Set<string>();
  for (const tuple of input.tuples) {
    const id = securityTupleId(tuple);
    if (tuples.has(id)) throw new Error(`security_tuple_duplicate:${id}`);
    if (!members.has(surfaceKey(tuple.population, tuple))) throw new Error(`security_tuple_unknown_surface:${id}`);
    tuples.set(id, tuple);
    represented.add(surfaceKey(tuple.population, tuple));
  }
  for (const member of members) {
    if (!represented.has(member)) throw new Error(`security_tuple_omitted_surface:${member}`);
  }
  const dispositions = new Map<string, SecurityTupleDisposition>(), probes = new Set<string>();
  for (const disposition of input.dispositions) {
    if (dispositions.has(disposition.rowId)) throw new Error(`security_tuple_duplicate_disposition:${disposition.rowId}`);
    if (!tuples.has(disposition.rowId)) throw new Error(`security_tuple_unexpected_disposition:${disposition.rowId}`);
    nonempty(disposition.reason, 'disposition.reason');
    if (!disposition.sourceRefs.length) throw new Error('security_tuple_missing_applicability_source');
    for (const ref of disposition.sourceRefs) nonempty(ref, 'disposition.sourceRef');
    if (disposition.applicability === 'applicable') {
      nonempty(disposition.owner, 'disposition.owner');
      for (const probe of [disposition.positiveControl, disposition.negativeCanary]) {
        nonempty(probe.id, 'probe.id');
        if (probe.rowId !== disposition.rowId) throw new Error('security_tuple_probe_row_substitution');
        if (probes.has(probe.id)) throw new Error('security_tuple_reused_probe');
        probes.add(probe.id);
        for (const field of ['sourceSha256', 'testSha256', 'fixtureSha256', 'runtimeSha256'] as const) digest(probe[field], `probe.${field}`);
      }
    } else if (disposition.applicability !== 'notApplicable') throw new Error('security_tuple_unknown_applicability');
    dispositions.set(disposition.rowId, disposition);
  }
  const rows = [...tuples].sort(([a], [b]) => compare(a, b)).map(([rowId, tuple]) => {
    const disposition = dispositions.get(rowId);
    if (!disposition) throw new Error(`security_tuple_missing_disposition:${rowId}`);
    return { rowId, tuple, disposition };
  });
  return snapshot({ schemaVersion: 1, manifestSha256: input.manifest.sha256, producer: input.producer, rows });
}
