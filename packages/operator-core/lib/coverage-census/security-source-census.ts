/** P-001 source discovery over the maintained pinned Git snapshot. Reuses the
 * source-path AST and runtime-compatibility inventory; never executes imports,
 * handlers or helpers. These are review leads, not a complete manifest or
 * evidence that a call's effects are contained. Missing/limited inputs survive
 * as gaps instead of silently shrinking the candidate population.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { censusSites, siteEvidence } from '../../../../scripts/lib/source-path-census.mjs';
import { inventorySources, readCommittedSources } from '../../../../scripts/lib/runtime-compatibility-census.mjs';

export interface PinnedSecuritySource {
  path: string; repository: string; commit: string; blobOid: string; bytes: Uint8Array;
}
export interface SecuritySourceSnapshot {
  sources: readonly PinnedSecuritySource[];
  repositories: readonly { path: string; commit: string }[];
  unresolved: readonly Record<string, unknown>[];
  selection?: ReturnType<typeof readCommittedSources>['selection'];
}
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonicalPath = (path: string) => !!path && !path.startsWith('/') && !path.includes('\\')
  && path.split('/').every(part => !!part && part !== '.' && part !== '..');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Count JSON bytes without joining an unbounded array into one V8 string.
 * Evidence strings come from individually bounded source blobs. Stop traversing
 * as soon as the budget is exceeded, including repeated predicate annotations. */
function jsonBytesWithin(value: unknown, limit: number): number {
  if (value === undefined) return 0;
  if (value === null || typeof value !== 'object') return Buffer.byteLength(JSON.stringify(value));
  let bytes = 2, count = 0;
  const members: Iterable<[string | null, unknown]> = Array.isArray(value)
    ? value.map(member => [null, member] as const) : Object.entries(value);
  for (const [key, member] of members) {
    if (member === undefined) continue;
    bytes += (count++ ? 1 : 0) + (key === null ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
    if (bytes > limit) return limit + 1;
    bytes += jsonBytesWithin(member, limit - bytes);
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

export function enumerateSecuritySourcePopulation(snapshot: SecuritySourceSnapshot, limits: {
  maxFiles?: number; maxBytes?: number; maxInputBytes?: number; maxSites?: number; maxEvidenceBytes?: number;
} = {}) {
  const budget = { maxFiles: 50_000, maxBytes: 128 * 1024 * 1024,
    maxInputBytes: 2 * 1024 * 1024, maxSites: 500_000, maxEvidenceBytes: 64 * 1024 * 1024, ...limits };
  if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('security_source_positive_budget_required');
  }
  const unresolved: Record<string, unknown>[] = [...snapshot.unresolved];
  const selected: Array<Omit<PinnedSecuritySource, 'bytes'> & { bytes: Buffer }> = [];
  const seen = new Set<string>();
  const repositories = [...snapshot.repositories].sort((a, b) => compare(a.path, b.path));
  const pins = new Map<string, string>();
  for (const repository of repositories) {
    if (pins.has(repository.path)) throw new Error('security_source_duplicate_repository');
    if (repository.path !== '.' && !canonicalPath(repository.path)) throw new Error('security_source_invalid_repository');
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(repository.commit)) throw new Error('security_source_invalid_commit');
    pins.set(repository.path, repository.commit);
  }
  let bytesRead = 0;
  for (const source of [...snapshot.sources].sort((a, b) => compare(a.path, b.path))) {
    if (!canonicalPath(source.path)) throw new Error('security_source_noncanonical_path');
    if (seen.has(source.path)) throw new Error(`security_source_duplicate_path:${source.path}`);
    seen.add(source.path);
    if (pins.get(source.repository) !== source.commit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source.blobOid)
      || source.repository !== '.' && !source.path.startsWith(`${source.repository}/`)) {
      throw new Error(`security_source_pin_mismatch:${source.path}`);
    }
    const bytes = Buffer.from(source.bytes);
    const reason = bytes.length > budget.maxInputBytes ? 'source-input-budget'
      : selected.length >= budget.maxFiles ? 'source-file-budget'
      : bytesRead + bytes.length > budget.maxBytes ? 'source-byte-budget'
      : !Buffer.from(bytes.toString('utf8')).equals(bytes) ? 'source-not-utf8' : null;
    if (reason) {
      unresolved.push({ path: source.path, commit: source.commit, blobOid: source.blobOid, bytes: bytes.length, reason });
      continue;
    }
    const blob = createHash(source.blobOid.length === 64 ? 'sha256' : 'sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== source.blobOid) throw new Error(`security_source_blob_mismatch:${source.path}`);
    selected.push({ ...source, bytes }); bytesRead += bytes.length;
  }
  const inventory = inventorySources({ sources: selected, repositories, unresolved,
    ...(snapshot.selection ? { selection: snapshot.selection } : {}) });
  const fileKinds = new Map(inventory.files.map(file => [file.path, file.sourceKind]));
  const sites: Array<ReturnType<typeof siteEvidence> & { fileSha256: string; sourceKind: string }> = [];
  let siteBytes = 2;
  // Leave room for file metadata, discovery groups and explicit omission gaps.
  const siteByteLimit = Math.floor(budget.maxEvidenceBytes / 2);
  for (const source of selected) {
    if (!/\.[cm]?[jt]sx?$/.test(source.path)) continue;
    try {
      const unit = censusSites(source.path, source.bytes.toString('utf8'));
      const sourceKind = fileKinds.get(source.path)!;
      let captured = 0, byteLimited = false;
      for (const site of unit.sites) {
        if (sites.length >= budget.maxSites) break;
        const evidence = { ...siteEvidence(site), fileSha256: unit.sha256, sourceKind };
        const size = jsonBytesWithin(evidence, siteByteLimit - siteBytes);
        if (siteBytes + size + 1 > siteByteLimit) { byteLimited = true; break; }
        sites.push(evidence); siteBytes += size + 1; captured++;
      }
      if (unit.sites.length > captured) inventory.unresolved.push({ path: source.path,
        reason: byteLimited ? 'source-site-evidence-budget' : 'source-site-budget',
        omittedSites: unit.sites.length - captured, firstOmittedByte: unit.sites[captured].byteStart });
    } catch (error) {
      inventory.unresolved.push({ path: source.path, reason: 'source-site-parser-failed',
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  const body = { schema: 'papercusp-security-source-discovery-v1', budget, bytesRead,
    inventory, sites, closureAccepted: false as const, executionAdmitted: false as const };
  // An inventory too large for this shard must be split, never hashed through
  // a RangeError or silently reduced to a smaller population.
  if (jsonBytesWithin(body, budget.maxEvidenceBytes) > budget.maxEvidenceBytes) {
    throw new Error('security_source_evidence_budget');
  }
  return { ...body, fingerprint: hash(canonicalJson(body)) };
}

export type SecuritySourceDiscovery = ReturnType<typeof enumerateSecuritySourcePopulation>;
export interface SecuritySourceProgress {
  schema: 'security-source-discovery-progress-v1';
  parentArchive: string; parentRawSha256: string;
  repositories: { path: string; commit: string }[];
  pending: { path: string; commit: string; blobOid: string; bytes: number; reason: string }[];
  capturedShards: { sha256: string; censusFingerprint: string; [key: string]: unknown }[];
  populationComplete: false; closureAccepted: false;
}
export interface SecuritySourceShard {
  progressSha256: string;
  requestedPaths: string[];
  discovery: SecuritySourceDiscovery;
}
const digest = /^[a-f0-9]{64}$/;
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const repositoryFor = (path: string, repositories: SecuritySourceProgress['repositories']) =>
  repositories.filter(repo => repo.path === '.' || path.startsWith(`${repo.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];

/** Validate the retained queue itself before spending a blob/AST budget. This
 * queue tracks archived input coverage only; its empty state is never closure. */
export function validateSecuritySourceProgress(progress: SecuritySourceProgress): void {
  if (progress.schema !== 'security-source-discovery-progress-v1' || progress.populationComplete !== false
    || progress.closureAccepted !== false || !digest.test(progress.parentArchive) || !digest.test(progress.parentRawSha256)) {
    throw new Error('security_source_invalid_progress');
  }
  const repos = new Set<string>(), paths = new Set<string>(), archives = new Set<string>();
  for (const repo of progress.repositories) {
    if (repos.has(repo.path) || (repo.path !== '.' && !canonicalPath(repo.path)) || !oid.test(repo.commit)) {
      throw new Error('security_source_invalid_progress_pins');
    }
    repos.add(repo.path);
  }
  if (!repos.has('.')) throw new Error('security_source_root_pin_required');
  for (const row of progress.pending) {
    if (!canonicalPath(row.path) || paths.has(row.path) || !oid.test(row.blobOid)
      || repositoryFor(row.path, progress.repositories)?.commit !== row.commit
      || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !row.reason) {
      throw new Error('security_source_invalid_pending_input');
    }
    paths.add(row.path);
  }
  for (const receipt of progress.capturedShards) {
    if (!digest.test(receipt.sha256) || !digest.test(receipt.censusFingerprint) || archives.has(receipt.sha256)) {
      throw new Error('security_source_invalid_shard_history');
    }
    archives.add(receipt.sha256);
  }
}

export function prepareSecuritySourceShard(progress: SecuritySourceProgress, paths: string[],
  snapshot: SecuritySourceSnapshot, limits: Parameters<typeof enumerateSecuritySourcePopulation>[1] = {}): SecuritySourceShard {
  validateSecuritySourceProgress(progress);
  const pending = new Map(progress.pending.map(row => [row.path, row]));
  if (!paths.length || new Set(paths).size !== paths.length || paths.some(path => !pending.has(path))) {
    throw new Error('security_source_shard_not_pending');
  }
  const sortedRepos = (repos: SecuritySourceSnapshot['repositories']) => [...repos].sort((a, b) => compare(a.path, b.path));
  if (canonicalJson(sortedRepos(snapshot.repositories)) !== canonicalJson(sortedRepos(progress.repositories))) {
    throw new Error('security_source_shard_repository_substitution');
  }
  const requestedPaths = [...paths].sort(compare), requested = new Set(paths);
  if (!snapshot.selection || canonicalJson(snapshot.selection.paths) !== canonicalJson(requestedPaths)) {
    throw new Error('security_source_shard_selection_mismatch');
  }
  for (const source of snapshot.sources) {
    const expected = pending.get(source.path);
    if (!requested.has(source.path) || !expected || expected.commit !== source.commit
      || expected.blobOid !== source.blobOid || expected.bytes !== source.bytes.length
      || repositoryFor(source.path, progress.repositories)?.path !== source.repository) {
      throw new Error('security_source_shard_input_substitution');
    }
  }
  return { progressSha256: hash(canonicalJson(progress)), requestedPaths,
    discovery: enumerateSecuritySourcePopulation(snapshot, limits) };
}

export function captureSecuritySourceShard(root: string, progress: SecuritySourceProgress, paths: string[],
  limits: Parameters<typeof enumerateSecuritySourcePopulation>[1] = {}) {
  validateSecuritySourceProgress(progress);
  const budget = { maxFiles: 512, maxBytes: 32 * 1024 * 1024, ...limits };
  // Admission validation runs before any Git reads as well as in preparation.
  if (!paths.length || new Set(paths).size !== paths.length
    || paths.some(path => !progress.pending.some(row => row.path === path))) throw new Error('security_source_shard_not_pending');
  const snapshot = readCommittedSources(root, progress.repositories.find(repo => repo.path === '.')!.commit,
    { includePaths: paths, maxFiles: budget.maxFiles, maxBytes: budget.maxBytes });
  return prepareSecuritySourceShard(progress, paths, snapshot, budget);
}

/** Called only after immutable archive readback. Removing paths is derived from
 * the archived file set, never the request set: refusals remain pending. */
export function advanceSecuritySourceProgress(progress: SecuritySourceProgress, shard: SecuritySourceShard,
  receipt: SecuritySourceProgress['capturedShards'][number]): SecuritySourceProgress {
  validateSecuritySourceProgress(progress);
  const { fingerprint, ...body } = shard.discovery;
  if (shard.progressSha256 !== hash(canonicalJson(progress))) throw new Error('security_source_stale_progress');
  if (hash(canonicalJson(body)) !== fingerprint || receipt.censusFingerprint !== fingerprint
    || !digest.test(receipt.sha256) || progress.capturedShards.some(row => row.sha256 === receipt.sha256)) {
    throw new Error('security_source_shard_identity_mismatch');
  }
  const pending = new Map(progress.pending.map(row => [row.path, row]));
  const requested = new Set(shard.requestedPaths);
  if (!requested.size || requested.size !== shard.requestedPaths.length || [...requested].some(path => !pending.has(path))
    || canonicalJson([...requested].sort(compare)) !== canonicalJson(shard.discovery.inventory.selection?.paths)
    || canonicalJson([...progress.repositories].sort((a, b) => compare(a.path, b.path)))
      !== canonicalJson([...shard.discovery.inventory.repositories].sort((a, b) => compare(a.path, b.path)))) {
    throw new Error('security_source_shard_selection_mismatch');
  }
  const consumed = new Set<string>();
  for (const file of shard.discovery.inventory.files) {
    const expected = pending.get(file.path);
    if (!requested.has(file.path) || consumed.has(file.path) || !expected || file.commit !== expected.commit
      || file.blobOid !== expected.blobOid || repositoryFor(file.path, progress.repositories)?.path !== file.repository) {
      throw new Error('security_source_shard_input_substitution');
    }
    consumed.add(file.path);
  }
  if (!consumed.size) throw new Error('security_source_shard_no_progress');
  return structuredClone({ ...progress, pending: progress.pending.filter(row => !consumed.has(row.path)),
    capturedShards: [...progress.capturedShards, { ...receipt, consumedPaths: [...consumed].sort(compare) }],
    populationComplete: false, closureAccepted: false });
}
