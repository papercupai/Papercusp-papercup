import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { REBUILDABLE_DIRECTORY_PATTERNS } from './policy';
import { evaluateHostDumpCoverage, type HostDumpStatus } from './host-dump-coverage';

/** Producer declarations, not a second hand-maintained list of install paths. */
export type StateClass = 'state' | 'config' | 'secret' | 'cache' | 'dev-only';
export type CensusKind = 'path' | 'database' | 'unit' | 'secret';
export interface CensusEntry {
  kind: CensusKind;
  /** Root-qualified identity; paths from different roots must never alias. */
  root: string;
  name: string;
}
export interface CensusDeclaration extends CensusEntry {
  classification: StateClass;
  producer: string;
  /** Explicit directory ownership; false means this exact entry only. */
  descendants?: boolean;
  /** Rebuildable subtree represented by its root, never silently omitted. */
  prune?: boolean;
  /** Policy-owned directory names can occur inside any producer subtree. */
  anyDepth?: boolean;
  /** Preserve the whole owned DB storage root; this never marks it disposable. */
  databaseStorage?: { systemIdentifier: string; evidenceRef: string };
  gitStorage?: { head: string; evidenceRef: string };
  /** Producer device identity; not a content checksum or snapshot receipt. */
  peerStorage?: { markerSha256: string; evidenceRef: string };
  releaseStorage?: { manifestSha256: string; evidenceRef: string };
  recoveryStorage?: { restoreEventId: string; evidenceRef: string };
  /** Exact producer-owned retained tree; evidence identifies ownership, not bytes. */
  retainedSubtree?: { evidenceRef: string };
}

/** Snapshot coverage is separate evidence, never a substitute for state ownership. */
export function databaseCensusSnapshotCoverage(input: {
  entries: readonly CensusEntry[];
  systemIdentifier: string;
  status: HostDumpStatus | null;
  nowEpoch: number;
}) {
  return input.entries.filter(entry => entry.kind === 'database').map(entry => ({
    ...entry,
    coverage: entry.root === `postgres-cluster:${input.systemIdentifier}`
      ? evaluateHostDumpCoverage({ database: entry.name, targetSystemIdentifier: input.systemIdentifier,
        status: input.status, nowEpoch: input.nowEpoch })
      : { covered: false, reason: 'census entry belongs to a different cluster' },
  }));
}

/** Semantic cache ownership derived from the existing backup policy, not all ignores. */
export function backupCacheCensusDeclarations(root: string): CensusDeclaration[] {
  return REBUILDABLE_DIRECTORY_PATTERNS.map(name => ({
    kind: 'path', root, name, classification: 'cache', producer: 'backup-policy',
    descendants: true, prune: true, anyDepth: true,
  }));
}

function matches(entry: CensusEntry, declaration: CensusDeclaration): boolean {
  if (entry.kind === 'path' && declaration.kind === 'path' && entry.root === declaration.root &&
    declaration.anyDepth === true) {
    const name = `/${entry.name}/`;
    return name.includes(`/${declaration.name}/`);
  }
  return entry.kind === declaration.kind && entry.root === declaration.root &&
    (entry.name === declaration.name ||
      (entry.kind === 'path' && declaration.descendants === true &&
        entry.name.startsWith(`${declaration.name}/`)));
}

function validateEntry(entry: CensusEntry): void {
  if (!entry.root.trim() || !entry.name.trim()) throw new Error('Empty census identity');
  if (entry.kind === 'path' && (entry.name.startsWith('/') || entry.name.includes('\\') ||
    entry.name.split('/').some(segment => !segment || segment === '.' || segment === '..'))) {
    throw new Error(`Non-canonical census path: ${entry.name}`);
  }
}

/** Unknown or conflicting ownership is residue, never silently exportable state. */
export function generateStateCensus(
  entries: readonly CensusEntry[],
  declarations: readonly CensusDeclaration[],
) {
  for (const entry of [...entries, ...declarations]) validateEntry(entry);
  for (const declaration of declarations) {
    if (!declaration.producer.trim()) throw new Error('Missing census producer');
  }
  const inventory = entries.map(entry => {
    const owners = declarations.filter(declaration => matches(entry, declaration));
    const classes = new Set(owners.map(owner => owner.classification));
    return {
      ...entry,
      classification: classes.size === 1 ? owners[0].classification : null,
      producers: [...new Set(owners.map(owner => owner.producer))].sort(),
      problem: owners.length === 0 ? 'unclassified' as const :
        classes.size > 1 ? 'conflicting' as const : null,
    };
  }).sort((a, b) => JSON.stringify([a.kind, a.root, a.name])
    .localeCompare(JSON.stringify([b.kind, b.root, b.name])));
  const residue = inventory.filter(entry => entry.problem !== null);
  return { inventory, residue, ok: residue.length === 0 };
}

export function assertStateCensusComplete(census: ReturnType<typeof generateStateCensus>): void {
  if (!census.ok) {
    throw new Error(`State census drift: ${census.residue.map(entry =>
      `${entry.problem}:${entry.kind}:${entry.root}:${entry.name}`).join(', ')}`);
  }
}

export interface CensusRoot {
  /** Stable producer identity, independent of machine-specific absolute path. */
  id: string;
  path: string;
  /** External file references select exact direct children; absent means full traversal. */
  fileNames?: string[];
}

/**
 * Walk declared roots without following symlinks or reading secret contents.
 * A failed root/catalog read rejects the census rather than fabricating coverage.
 * Host-owned catalog readers keep PG and service-manager dependencies out of backup.
 */
export async function collectStateCensus(input: {
  roots: readonly CensusRoot[];
  declarations: readonly CensusDeclaration[];
  readCatalogs: () => Promise<readonly CensusEntry[]>;
  /** Refuse oversized inventories rather than returning a truncated success. */
  maxEntries?: number;
  /** Diagnostic frontier only: unknown trees remain explicit failing residue. */
  representUnknownSubtrees?: boolean;
}) {
  const maxEntries = input.maxEntries ?? 100_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid census entry bound');
  for (const declaration of input.declarations) {
    if (declaration.retainedSubtree && (declaration.kind !== 'path' || declaration.classification !== 'state' ||
      !declaration.descendants || declaration.anyDepth || declaration.prune || !declaration.retainedSubtree.evidenceRef.trim())) {
      throw new Error('Retained subtree requires exact state ownership and producer evidence');
    }
    if (declaration.recoveryStorage && (declaration.kind !== 'path' || declaration.classification !== 'state' ||
      !declaration.descendants || declaration.anyDepth || declaration.prune ||
      !/^\d+$/.test(declaration.recoveryStorage.restoreEventId) || !declaration.recoveryStorage.evidenceRef.trim())) {
      throw new Error('Recovery storage requires exact retained state ownership and restore evidence');
    }
    if (declaration.releaseStorage && (declaration.kind !== 'path' || declaration.classification !== 'state' ||
      !declaration.descendants || declaration.anyDepth || declaration.prune ||
      !/^[0-9a-f]{64}$/.test(declaration.releaseStorage.manifestSha256) || !declaration.releaseStorage.evidenceRef.trim())) {
      throw new Error('Release storage requires exact preserved state ownership and manifest evidence');
    }
    if (declaration.peerStorage && (declaration.kind !== 'path' || declaration.classification !== 'state' ||
      !declaration.descendants || declaration.anyDepth || declaration.prune ||
      !/^[0-9a-f]{64}$/.test(declaration.peerStorage.markerSha256) || !declaration.peerStorage.evidenceRef.trim())) {
      throw new Error('Peer storage requires exact preserved state ownership and device identity');
    }
    if (declaration.gitStorage && (declaration.kind !== 'path' || declaration.classification !== 'state' ||
      !declaration.descendants || declaration.anyDepth || declaration.prune ||
      !/^[0-9a-f]{40,64}$/.test(declaration.gitStorage.head) || !declaration.gitStorage.evidenceRef.trim())) {
      throw new Error('Git storage requires exact preserved state ownership');
    }
    if (declaration.databaseStorage && (declaration.kind !== 'path' ||
      declaration.classification !== 'state' || declaration.descendants !== true ||
      declaration.anyDepth || declaration.prune ||
      !/^\d+$/.test(declaration.databaseStorage.systemIdentifier) ||
      !declaration.databaseStorage.evidenceRef.trim())) {
      throw new Error('Database storage requires exact state ownership and measured identity evidence');
    }
    if (declaration.prune && (declaration.kind !== 'path' ||
      declaration.descendants !== true ||
      !['cache', 'dev-only'].includes(declaration.classification))) {
      throw new Error('Census pruning requires an explicitly owned rebuildable subtree');
    }
  }
  const ids = input.roots.map(root => root.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate census root identity');
  const entries: CensusEntry[] = [];
  const representedStorage: Array<CensusEntry & { systemIdentifier: string; evidenceRef: string; disposition: 'preserve-state-subtree' }> = [];
  const representedGit: Array<CensusEntry & { head: string; evidenceRef: string; disposition: 'preserve-state-subtree' }> = [];
  const representedPeers: Array<CensusEntry & { markerSha256: string; evidenceRef: string; disposition: 'preserve-state-subtree' }> = [];
  const representedReleases: Array<CensusEntry & { manifestSha256: string; evidenceRef: string; disposition: 'preserve-state-subtree' }> = [];
  const representedRecoveries: Array<CensusEntry & { restoreEventId: string; evidenceRef: string; disposition: 'preserve-state-subtree' }> = [];
  const representedSubtrees: Array<CensusEntry & { evidenceRef: string; disposition: 'preserve-state-subtree' }> = [];
  const representedUnknown: Array<CensusEntry & { disposition: 'unclassified-subtree' }> = [];
  async function walk(root: CensusRoot, parent: string): Promise<void> {
    if (root.fileNames !== undefined && root.fileNames.some(name => !name ||
      name === '.' || name === '..' || name.includes('/') || name.includes('\\'))) {
      throw new Error('Non-canonical census file selection');
    }
    const children = await readdir(join(root.path, parent), { withFileTypes: true });
    for (const child of children) {
      if (root.fileNames !== undefined && !root.fileNames.includes(child.name)) continue;
      if (root.fileNames !== undefined && child.isDirectory()) throw new Error('Census file selection contains a directory');
      const name = parent ? `${parent}/${child.name}` : child.name;
      entries.push({ kind: 'path', root: root.id, name });
      if (entries.length > maxEntries) throw new Error(`Census entry bound exceeded: ${maxEntries}; root=${root.id}; path=${name}`);
      const owners = input.declarations.filter(declaration =>
        matches({ kind: 'path', root: root.id, name }, declaration));
      // A conflicting producer must not hide its descendants from drift checks.
      const prune = owners.length > 0 && owners.every(owner => owner.prune === true) &&
        new Set(owners.map(owner => owner.classification)).size === 1;
      const storage = owners.find(owner => owner.name === name && owner.databaseStorage);
      const nestedOverride = input.declarations.some(declaration => declaration.root === root.id &&
        declaration.name.startsWith(`${name}/`));
      const unknownSubtree = input.representUnknownSubtrees && child.isDirectory() && owners.length === 0 && !nestedOverride;
      if (unknownSubtree) representedUnknown.push({ kind: 'path', root: root.id, name, disposition: 'unclassified-subtree' });
      const represented = child.isDirectory() && storage?.databaseStorage && !nestedOverride &&
        owners.every(owner => owner.classification === 'state');
      if (represented && storage?.databaseStorage) {
        representedStorage.push({ kind: 'path', root: root.id, name, ...storage.databaseStorage,
          disposition: 'preserve-state-subtree' });
      }
      const git = owners.find(owner => owner.name === name && owner.gitStorage);
      const representedRepo = child.isDirectory() && git?.gitStorage && !nestedOverride &&
        owners.every(owner => owner.classification === 'state');
      if (representedRepo && git?.gitStorage) representedGit.push({ kind: 'path', root: root.id, name,
        ...git.gitStorage, disposition: 'preserve-state-subtree' });
      const peer = owners.find(owner => owner.name === name && owner.peerStorage);
      const representedPeer = child.isDirectory() && peer?.peerStorage && !nestedOverride &&
        owners.every(owner => owner.classification === 'state');
      if (representedPeer && peer?.peerStorage) representedPeers.push({ kind: 'path', root: root.id, name,
        ...peer.peerStorage, disposition: 'preserve-state-subtree' });
      const release = owners.find(owner => owner.name === name && owner.releaseStorage);
      const representedRelease = child.isDirectory() && release?.releaseStorage && !nestedOverride &&
        owners.every(owner => owner.classification === 'state');
      if (representedRelease && release?.releaseStorage) representedReleases.push({ kind: 'path', root: root.id, name,
        ...release.releaseStorage, disposition: 'preserve-state-subtree' });
      const recovery = owners.find(owner => owner.name === name && owner.recoveryStorage);
      const representedRecovery = child.isDirectory() && recovery?.recoveryStorage && !nestedOverride &&
        owners.every(owner => owner.classification === 'state');
      if (representedRecovery && recovery?.recoveryStorage) representedRecoveries.push({ kind: 'path', root: root.id, name,
        ...recovery.recoveryStorage, disposition: 'preserve-state-subtree' });
      const retained = owners.find(owner => owner.name === name && owner.retainedSubtree);
      const representedSubtree = child.isDirectory() && retained?.retainedSubtree && !nestedOverride &&
        owners.every(owner => owner.classification === 'state');
      if (representedSubtree && retained?.retainedSubtree) representedSubtrees.push({ kind: 'path', root: root.id, name,
        ...retained.retainedSubtree, disposition: 'preserve-state-subtree' });
      if (child.isDirectory() && !prune && !represented && !representedRepo && !representedPeer && !representedRelease && !representedRecovery && !representedSubtree && !unknownSubtree) await walk(root, name);
    }
  }
  for (const root of input.roots) await walk(root, '');
  entries.push(...await input.readCatalogs());
  if (entries.length > maxEntries) throw new Error(`Census entry bound exceeded: ${maxEntries}`);
  return { ...generateStateCensus(entries, input.declarations), representedStorage, representedGit, representedPeers, representedReleases, representedRecoveries, representedSubtrees, representedUnknown };
}

/** Collect and validate in one call; consumers cannot accidentally ignore residue. */
export async function verifyStateCensus(input: Parameters<typeof collectStateCensus>[0]) {
  const census = await collectStateCensus(input);
  assertStateCensusComplete(census);
  return census;
}
