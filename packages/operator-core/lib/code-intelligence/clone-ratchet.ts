import { CLONE_NORMALIZATION_VERSION, type CloneFamily, type CloneIndex } from './clone-index';

/** Counts, rather than path identities, keep moves quiet without allowing an
 * extra member to hide inside an already accepted family. */
export interface CloneBaseline {
  schemaVersion: 1;
  normalizationVersion: string;
  minMass: number;
  seed: { ref: string; sourceDigest: string; files: number };
  families: Record<string, number>;
}
export interface CloneWarning {
  kind: CloneFamily['kind'];
  fingerprint: string;
  previousMembers: number;
  acceptedMembers: number;
  members: { path: string; line: number; name: string }[];
}

export function ratchetFamilies(index: CloneIndex): CloneFamily[] {
  const families: CloneFamily[] = [];
  // Use the existing buckets, counting distinct function ids rather than lines:
  // two declarations on one physical line are still two copies.
  for (const kind of ['exact', 'renamed'] as const) {
    const fingerprints = new Set(index.getFiles().flatMap(file => file.functions.map(fn => fn[kind])));
    for (const fingerprint of [...fingerprints].sort()) {
      const members = index.lookup(kind, fingerprint);
      if (members.length < 2) continue;
      families.push({ id: `${CLONE_NORMALIZATION_VERSION}:floor-${index.minMass}:${kind}:${fingerprint}`,
        version: CLONE_NORMALIZATION_VERSION, kind, fingerprint, members });
    }
  }
  return families;
}
export function familyCounts(families: readonly CloneFamily[]): Record<string, number> {
  return Object.fromEntries(families.map(family => [family.id, family.members.length]));
}
export function seedCloneBaseline(index: CloneIndex, seed: CloneBaseline['seed']): CloneBaseline {
  return { schemaVersion: 1, normalizationVersion: CLONE_NORMALIZATION_VERSION,
    minMass: index.minMass, seed, families: familyCounts(ratchetFamilies(index)) };
}
export function parseCloneBaseline(value: unknown, minMass: number): CloneBaseline {
  const baseline = value as CloneBaseline;
  if (!baseline || baseline.schemaVersion !== 1 || baseline.normalizationVersion !== CLONE_NORMALIZATION_VERSION
    || baseline.minMass !== minMass || !baseline.seed || typeof baseline.seed.ref !== 'string'
    || !/^[a-f0-9]{64}$/.test(baseline.seed.sourceDigest) || !Number.isSafeInteger(baseline.seed.files)
    || baseline.seed.files < 0 || !baseline.families || typeof baseline.families !== 'object'
    || Array.isArray(baseline.families)) throw new Error('Incompatible clone baseline; explicit reviewed migration required');
  const prefix = `${CLONE_NORMALIZATION_VERSION}:floor-${minMass}:`;
  for (const [key, count] of Object.entries(baseline.families)) {
    if (!key.startsWith(prefix) || !/^(exact|renamed):[a-f0-9]+$/.test(key.slice(prefix.length))
      || !Number.isSafeInteger(count) || count < 2) throw new Error(`Invalid clone baseline entry: ${key}`);
  }
  return baseline;
}
/** No new keys, raised ceilings, seed replacement or normalization migration. */
export function assertBaselineShrinks(previous: CloneBaseline, next: CloneBaseline): void {
  if (previous.schemaVersion !== next.schemaVersion || previous.normalizationVersion !== next.normalizationVersion
    || previous.minMass !== next.minMass || JSON.stringify(previous.seed) !== JSON.stringify(next.seed)) {
    throw new Error('Clone baseline metadata must remain unchanged');
  }
  for (const [key, count] of Object.entries(next.families)) {
    if (!Object.hasOwn(previous.families, key) || count > previous.families[key]) {
      throw new Error(`Clone baseline growth refused: ${key}`);
    }
  }
}
export function shrinkCloneBaseline(previous: CloneBaseline, families: readonly CloneFamily[]): CloneBaseline {
  const counts = familyCounts(families);
  const next = { ...previous, families: Object.fromEntries(Object.entries(previous.families)
    .filter(([key]) => (counts[key] ?? 0) >= 2)
    .map(([key, count]) => [key, Math.min(count, counts[key])])) };
  assertBaselineShrinks(previous, next);
  return next;
}
export function findNewClones(families: readonly CloneFamily[], baseline: CloneBaseline,
  changedPaths: readonly string[], previousCounts: Readonly<Record<string, number>> = {}): CloneWarning[] {
  const changed = new Set(changedPaths);
  return families.filter(family => family.members.length > Math.max(baseline.families[family.id] ?? 1,
    previousCounts[family.id] ?? 1) && family.members.some(member => changed.has(member.path)))
    .map(family => ({ kind: family.kind, fingerprint: family.fingerprint,
      previousMembers: previousCounts[family.id] ?? 1, acceptedMembers: baseline.families[family.id] ?? 1,
      members: family.members.map(({ path, line, name }) => ({ path, line, name })) }));
}
