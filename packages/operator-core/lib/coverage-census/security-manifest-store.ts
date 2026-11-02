/** P-001 snapshots reuse canonical text artifacts with immutable content addresses.
 * No new table, routine, public tool or parallel evidence store. Stored snapshots
 * grant no approval or execution authority: host commitment is a separate gate.
 */
import { loadImmutableTextArtifact, saveImmutableTextArtifact } from '../text-artifacts';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalJson } from '@papercusp/hash-chain';
import { z } from 'zod';
import type { SecuritySourceDiscovery, SecuritySourceProgress, SecuritySourceShard } from './security-source-census';
import {
  createSecurityManifest, createSecurityTupleLedger,
  type SecurityManifest, type SecuritySnapshot, type SecurityTupleLedger,
} from './security-manifest';

function exact<T>(claimed: SecuritySnapshot<T>, rebuilt: SecuritySnapshot<T>): void {
  if (claimed.sha256 !== rebuilt.sha256 || claimed.bytes !== rebuilt.bytes) throw new Error('security_snapshot_identity_mismatch');
}

export async function saveSecurityManifest(harness: string, manifest: SecuritySnapshot<SecurityManifest>) {
  exact(manifest, createSecurityManifest(manifest.body));
  return saveImmutableTextArtifact(harness, manifest.bytes);
}
export async function loadSecurityManifest(harness: string, sha256: string): Promise<SecuritySnapshot<SecurityManifest> | null> {
  const bytes = await loadImmutableTextArtifact(harness, sha256);
  if (bytes === null) return null;
  const rebuilt = createSecurityManifest(JSON.parse(bytes) as SecurityManifest);
  if (rebuilt.bytes !== bytes || rebuilt.sha256 !== sha256) throw new Error('security_snapshot_identity_mismatch');
  return rebuilt;
}
export async function saveSecurityTupleLedger(harness: string, ledger: SecuritySnapshot<SecurityTupleLedger>) {
  const manifest = await loadSecurityManifest(harness, ledger.body.manifestSha256);
  if (!manifest) throw new Error('security_ledger_manifest_missing');
  const rebuilt = createSecurityTupleLedger({ manifest, producer: ledger.body.producer,
    tuples: ledger.body.rows.map(row => row.tuple), dispositions: ledger.body.rows.map(row => row.disposition) });
  exact(ledger, rebuilt);
  return saveImmutableTextArtifact(harness, ledger.bytes);
}
export async function loadSecurityTupleLedger(harness: string, sha256: string): Promise<SecuritySnapshot<SecurityTupleLedger> | null> {
  const bytes = await loadImmutableTextArtifact(harness, sha256);
  if (bytes === null) return null;
  const body = JSON.parse(bytes) as SecurityTupleLedger;
  const manifest = await loadSecurityManifest(harness, body.manifestSha256);
  if (!manifest) throw new Error('security_ledger_manifest_missing');
  const rebuilt = createSecurityTupleLedger({ manifest, producer: body.producer,
    tuples: body.rows.map(row => row.tuple), dispositions: body.rows.map(row => row.disposition) });
  if (rebuilt.bytes !== bytes || rebuilt.sha256 !== sha256) throw new Error('security_snapshot_identity_mismatch');
  return rebuilt;
}

const sourceArchiveSchema = z.object({
  schema: z.literal('security-source-discovery-archive-v1'), encoding: z.literal('gzip+base64'),
  parentArchive: z.string().regex(/^[a-f0-9]{64}$/),
  // The first historical capture predates this field. Its absence is not a
  // verified predecessor identity; membership still requires the pinned receipt.
  progressSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  censusFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  parentRawSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  closureAccepted: z.literal(false).optional(), executionAdmitted: z.literal(false).optional(),
  rawSha256: z.string().regex(/^[a-f0-9]{64}$/), rawBytes: z.number().int().positive().safe(), data: z.string(),
}).passthrough();

/** Reload discovery through its retained queue receipt. Content addressing by
 * itself does not bind an archive to this population. Gaps and UNKNOWN sites
 * survive unchanged; successful decoding grants no qualification authority. */
export async function loadSecuritySourceShard(harness: string, progress: SecuritySourceProgress, sha256: string,
  { maxRawBytes = 128 * 1024 * 1024, expectedPaths }: { maxRawBytes?: number; expectedPaths?: readonly string[] } = {}): Promise<SecuritySourceDiscovery | null> {
  // Runtime manifest/custody operations must not initialize source scanners.
  const { validateSecuritySourceProgress } = await import('./security-source-census');
  validateSecuritySourceProgress(progress);
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes < 1) throw new Error('security_source_positive_budget_required');
  const receipt = progress.capturedShards.find(row => row.sha256 === sha256);
  if (!receipt) throw new Error('security_source_archive_not_in_progress');
  const stored = await loadImmutableTextArtifact(harness, sha256);
  if (stored === null) return null;
  const archive = sourceArchiveSchema.parse(JSON.parse(stored));
  if (archive.parentArchive !== progress.parentArchive
    || archive.censusFingerprint !== undefined && archive.censusFingerprint !== receipt.censusFingerprint
    || archive.parentRawSha256 !== undefined && archive.parentRawSha256 !== progress.parentRawSha256
    || receipt.rawSha256 !== undefined && receipt.rawSha256 !== archive.rawSha256
    || receipt.rawBytes !== undefined && receipt.rawBytes !== archive.rawBytes) {
    throw new Error('security_source_archive_identity_mismatch');
  }
  if (archive.rawBytes > maxRawBytes) throw new Error('security_source_archive_read_budget');
  const compressed = Buffer.from(archive.data, 'base64');
  if (compressed.toString('base64') !== archive.data) throw new Error('security_source_archive_invalid_encoding');
  const decoded = gunzipSync(compressed, { maxOutputLength: archive.rawBytes });
  if (decoded.length !== archive.rawBytes || createHash('sha256').update(decoded).digest('hex') !== archive.rawSha256) {
    throw new Error('security_source_archive_decode_mismatch');
  }
  const discovery = JSON.parse(decoded.toString('utf8')) as SecuritySourceDiscovery;
  const { fingerprint, ...body } = discovery;
  if (discovery.schema !== 'papercusp-security-source-discovery-v1' || discovery.closureAccepted !== false
    || discovery.executionAdmitted !== false
    || createHash('sha256').update(canonicalJson(body)).digest('hex') !== fingerprint
    || fingerprint !== receipt.censusFingerprint) throw new Error('security_source_shard_identity_mismatch');
  const sorted = (rows: readonly { path: string; commit: string }[]) => [...rows].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (canonicalJson(sorted(discovery.inventory.repositories)) !== canonicalJson(sorted(progress.repositories))) {
    throw new Error('security_source_shard_repository_substitution');
  }
  const paths = discovery.inventory.files.map(file => file.path).sort();
  // Historical receipts without consumedPaths require a separately pinned
  // path witness. Never infer that witness from the archive being checked.
  const witnessedPaths = receipt.consumedPaths ?? expectedPaths;
  if (!Array.isArray(witnessedPaths) || canonicalJson(paths) !== canonicalJson([...witnessedPaths].sort())
    || expectedPaths !== undefined && canonicalJson(paths) !== canonicalJson([...expectedPaths].sort())
    || new Set(paths).size !== paths.length || progress.pending.some(row => paths.includes(row.path))) {
    throw new Error('security_source_shard_selection_mismatch');
  }
  return discovery;
}

/** Persist the exact discovery before advancing its queue. Both objects reuse
 * immutable artifacts; an interrupted save leaves the prior queue usable. */
export async function saveSecuritySourceShard(harness: string, progress: SecuritySourceProgress, shard: SecuritySourceShard) {
  const { advanceSecuritySourceProgress } = await import('./security-source-census');
  const raw = canonicalJson(shard.discovery);
  const rawSha256 = createHash('sha256').update(raw).digest('hex');
  const envelope = canonicalJson({ schema: 'security-source-discovery-archive-v1', encoding: 'gzip+base64',
    parentArchive: progress.parentArchive, progressSha256: shard.progressSha256,
    rawSha256, rawBytes: Buffer.byteLength(raw), data: gzipSync(raw).toString('base64') });
  const sha256 = createHash('sha256').update(envelope).digest('hex');
  const receipt = { sha256, censusFingerprint: shard.discovery.fingerprint,
    parentArchive: progress.parentArchive, rawSha256, rawBytes: Buffer.byteLength(raw),
    files: shard.discovery.inventory.files.length, sites: shard.discovery.sites.length,
    gaps: shard.discovery.inventory.unresolved.length, closureAccepted: false, executionAdmitted: false };
  // Refuse stale or substituted input before writing either object.
  const next = advanceSecuritySourceProgress(progress, shard, receipt);
  const archive = await saveImmutableTextArtifact(harness, envelope);
  const stored = await loadImmutableTextArtifact(harness, archive.sha256);
  if (stored !== envelope) throw new Error('security_source_archive_readback_mismatch');
  const decoded = gunzipSync(Buffer.from(JSON.parse(stored).data, 'base64'), { maxOutputLength: receipt.rawBytes });
  if (decoded.length !== receipt.rawBytes || createHash('sha256').update(decoded).digest('hex') !== rawSha256
    || decoded.toString('utf8') !== raw) throw new Error('security_source_archive_decode_mismatch');
  const progressBytes = canonicalJson(next);
  const progressArchive = await saveImmutableTextArtifact(harness, progressBytes);
  if (await loadImmutableTextArtifact(harness, progressArchive.sha256) !== progressBytes) {
    throw new Error('security_source_progress_readback_mismatch');
  }
  return { archive, progressArchive, progress: next, receipt: { ...receipt, readbackVerified: true, decodedVerified: true } };
}
