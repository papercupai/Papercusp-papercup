/**
 * Sealed organization backup artifacts under the organization's customer-managed key
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b follow-up, WI-6554700010012443 U3;
 * decision D-020).
 *
 * An artifact is a stream of frames. Each frame is a uint32 big-endian length followed by one
 * envelope-v2 blob (organization-keys.ts, sealed scope 'backup'). The sealed plaintext of a frame is:
 *
 *   artifactId (16 bytes) | index (uint32 BE) | final (1 byte, 0 or 1) | chunk bytes
 *
 * The envelope binds the organization, the DEK version and the scope. The frame header binds each
 * chunk to its artifact and position, so opening refuses (OrganizationKeyUnavailableError
 * 'envelope-malformed') a reordered, truncated, spliced or extended artifact: every frame must carry
 * the first frame's artifactId, indices run from 0 without gaps, exactly the last frame is final, and
 * nothing follows it. A frame sealed for another organization or scope fails authentication.
 *
 * Frames are sealed and opened one at a time, so an artifact streams without being held in memory,
 * and a key revoked mid-stream stops the stream at the next frame (fail closed). An artifact sealed
 * under an older DEK version opens while that version is live; shredding the organization's keys makes
 * every artifact unreadable (crypto-shred). Re-sealing an artifact after a DEK rotation is
 * openBackupArtifact piped into sealBackupArtifact.
 *
 * exportOrganizationBackup is the one producer today: the pilot organization export
 * (exportOrganizationData, which writes its receipt in the same transaction) serialized as NDJSON and
 * sealed. No scheduled pilot backup writes artifacts yet; whoever adds one writes these frames.
 */
import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { exportOrganizationData, type HoldConflict, type OrganizationDataExport, type OrganizationDataScope } from './organization-data-receipts';
import { organizationKeyCustodyState, organizationKeyService, type OrganizationKeyCustodyState } from './organization-key-registry';
import { OrganizationKeyUnavailableError, type OrganizationKeyService } from './organization-keys';

export type BackupKeyService = Pick<OrganizationKeyService, 'encrypt' | 'decrypt'>;

/** Plaintext bytes per frame. */
export const BACKUP_CHUNK_BYTES = 1 << 20;
export const BACKUP_ARTIFACT_ID_BYTES = 16;
const FRAME_HEADER_BYTES = BACKUP_ARTIFACT_ID_BYTES + 4 + 1;
const LENGTH_BYTES = 4;
/** A sealed frame larger than this is refused before it is buffered. */
const MAX_SEALED_FRAME_BYTES = 64 * 1024 * 1024;

export const BACKUP_FORMAT = 'papercusp-organization-backup';
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Retention veto for an organization artifact. Supply a fresh holdConflicts read for the artifact's
 * workspace scope immediately before pruning. Counts of live rows do not prove a backup redundant:
 * any intersecting active hold keeps the artifact, including when it is the only historical copy.
 * After release, ordinary age/count retention may prune it. No scheduled artifact pruner exists yet.
 */
export function organizationBackupRetentionDecision(
  scope: Pick<OrganizationDataScope, 'workspaceIds'>,
  activeHolds: readonly Pick<HoldConflict, 'holdId' | 'workspaceId'>[],
): { prunable: boolean; holdIds: string[]; reason: 'legal-hold-active' | 'no-active-legal-hold' } {
  const holdIds = [...new Set(activeHolds.filter((h) => scope.workspaceIds.includes(h.workspaceId)).map((h) => h.holdId))].sort();
  return { prunable: holdIds.length === 0, holdIds,
    reason: holdIds.length ? 'legal-hold-active' : 'no-active-legal-hold' };
}

/**
 * Host dumps contain the whole shared data plane, regardless of the workspace
 * that owns their Kopia repo. Lock the hold table before the database-wide read
 * so even low-level hold writers cannot place/release a hold during expiry.
 * Keep captures/network work outside this short destructive lease.
 */
export async function withHostBackupRetentionLease<T>(
  sql: Sql,
  fn: (activeHoldIds: readonly string[]) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`LOCK TABLE harness_shared.data_source_legal_holds IN SHARE MODE`;
    const rows = await t<{ id: string }[]>`
      SELECT id::text AS id FROM harness_shared.data_source_legal_holds
       WHERE released_at IS NULL ORDER BY id`;
    return { value: await fn(rows.map((r) => r.id)) };
  });
  return result.value;
}

type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

function malformed(organizationId: string, detail: string): OrganizationKeyUnavailableError {
  return new OrganizationKeyUnavailableError(organizationId, 'envelope-malformed', `backup artifact: ${detail}`);
}

/** Re-cuts a byte stream into chunks of exactly `size` bytes; the last chunk may be shorter (or empty). */
async function* rechunk(source: ByteSource, size: number): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const piece of source) {
    let buf = Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
    while (buf.length) {
      const take = Math.min(size - pendingBytes, buf.length);
      pending.push(buf.subarray(0, take));
      pendingBytes += take;
      buf = buf.subarray(take);
      if (pendingBytes === size) {
        yield Buffer.concat(pending);
        pending = [];
        pendingBytes = 0;
      }
    }
  }
  yield Buffer.concat(pending);
}

/**
 * Seals a byte stream as an artifact of the organization. Yields the artifact's bytes, one frame per
 * chunk. An empty input yields one final, empty frame, so every artifact has a final frame.
 */
export async function* sealBackupArtifact(
  service: BackupKeyService,
  organizationId: string,
  plaintext: ByteSource,
  options: { chunkBytes?: number; artifactId?: Buffer } = {},
): AsyncGenerator<Buffer> {
  const chunkBytes = options.chunkBytes ?? BACKUP_CHUNK_BYTES;
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) throw new Error(`organization-backup-sealing: invalid chunkBytes ${chunkBytes}`);
  const artifactId = options.artifactId ?? randomBytes(BACKUP_ARTIFACT_ID_BYTES);
  if (artifactId.length !== BACKUP_ARTIFACT_ID_BYTES) throw new Error('organization-backup-sealing: artifactId must be 16 bytes');
  let index = 0;
  let held: Buffer | null = null;
  // Hold one chunk back so the last one can be marked final.
  for await (const chunk of rechunk(plaintext, chunkBytes)) {
    if (held !== null) yield await sealFrame(service, organizationId, artifactId, index++, false, held);
    held = chunk;
  }
  yield await sealFrame(service, organizationId, artifactId, index, true, held ?? Buffer.alloc(0));
}

async function sealFrame(
  service: BackupKeyService, organizationId: string, artifactId: Buffer, index: number, final: boolean, chunk: Buffer,
): Promise<Buffer> {
  if (index > 0xffffffff) throw new Error('organization-backup-sealing: artifact exceeds the frame index range');
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  artifactId.copy(header, 0);
  header.writeUInt32BE(index, BACKUP_ARTIFACT_ID_BYTES);
  header.writeUInt8(final ? 1 : 0, BACKUP_ARTIFACT_ID_BYTES + 4);
  const blob = await service.encrypt(organizationId, 'backup', Buffer.concat([header, chunk]));
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32BE(blob.length, 0);
  return Buffer.concat([length, blob]);
}

/** Splits an artifact byte stream into its sealed frames. */
async function* frames(organizationId: string, sealed: ByteSource): AsyncGenerator<Buffer> {
  let buf = Buffer.alloc(0);
  for await (const piece of sealed) {
    buf = buf.length ? Buffer.concat([buf, Buffer.from(piece)]) : Buffer.from(piece);
    while (buf.length >= LENGTH_BYTES) {
      const length = buf.readUInt32BE(0);
      if (length > MAX_SEALED_FRAME_BYTES) throw malformed(organizationId, `frame length ${length} exceeds the limit`);
      if (buf.length < LENGTH_BYTES + length) break;
      yield buf.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
      buf = buf.subarray(LENGTH_BYTES + length);
    }
  }
  if (buf.length) throw malformed(organizationId, 'truncated inside a frame');
}

/**
 * Opens an artifact of the organization and yields its plaintext chunks in order. Throws
 * OrganizationKeyUnavailableError on a revoked or shredded key, a frame of another organization or
 * scope, or an artifact that was reordered, truncated, spliced or extended.
 */
export async function* openBackupArtifact(service: BackupKeyService, organizationId: string, sealed: ByteSource): AsyncGenerator<Buffer> {
  let artifactId: Buffer | null = null;
  let expected = 0;
  let ended = false;
  for await (const blob of frames(organizationId, sealed)) {
    if (ended) throw malformed(organizationId, 'a frame follows the final frame');
    const plain = await service.decrypt(organizationId, 'backup', blob);
    if (plain.length < FRAME_HEADER_BYTES) throw malformed(organizationId, 'frame header is short');
    const id = plain.subarray(0, BACKUP_ARTIFACT_ID_BYTES);
    const index = plain.readUInt32BE(BACKUP_ARTIFACT_ID_BYTES);
    const final = plain.readUInt8(BACKUP_ARTIFACT_ID_BYTES + 4);
    if (final > 1) throw malformed(organizationId, 'frame final flag is invalid');
    if (artifactId === null) artifactId = Buffer.from(id);
    else if (!artifactId.equals(id)) throw malformed(organizationId, 'frame belongs to another artifact');
    if (index !== expected) throw malformed(organizationId, `frame ${index} where frame ${expected} was expected`);
    expected += 1;
    ended = final === 1;
    yield plain.subarray(FRAME_HEADER_BYTES);
  }
  if (!ended) throw malformed(organizationId, artifactId === null ? 'no frames' : 'missing the final frame');
}

/** Collects a byte stream. */
export async function collectBytes(source: ByteSource): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of source) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

export interface BackupSealingDeps {
  readonly keyService?: (sql: Sql) => BackupKeyService;
  readonly custodyState?: (sql: Sql, organizationId: string) => Promise<OrganizationKeyCustodyState | null>;
  readonly chunkBytes?: number;
}

export interface SealedOrganizationBackup {
  readonly receiptId: string;
  readonly organizationId: string;
  /** The sealed artifact bytes. Consume it once. */
  readonly artifact: AsyncGenerator<Buffer>;
}

type BackupRecord =
  | { readonly kind: 'header'; readonly format: string; readonly version: number; readonly organizationId: string; readonly receiptId: string }
  | { readonly kind: 'store'; readonly store: string; readonly columns: readonly string[] }
  | { readonly kind: 'row'; readonly store: string; readonly row: Record<string, unknown> };

function line(record: BackupRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`, 'utf8');
}

function* exportLines(organizationId: string, data: OrganizationDataExport): Generator<Buffer> {
  yield line({ kind: 'header', format: BACKUP_FORMAT, version: BACKUP_FORMAT_VERSION, organizationId, receiptId: data.receiptId });
  for (const store of data.stores) {
    yield line({ kind: 'store', store: store.store, columns: store.columns });
    for (const row of store.rows) yield line({ kind: 'row', store: store.store, row });
  }
}

/**
 * Exports the organization's pilot data plane (exportOrganizationData: authorization, secret-class
 * exclusion and the export receipt) as a sealed artifact. Requires key custody: an organization
 * without custody gets 'organization-key-unprovisioned', and a revoked or shredded one gets its typed
 * error, before any data is read.
 */
export async function exportOrganizationBackup(
  sql: Sql,
  input: Parameters<typeof exportOrganizationData>[1],
  deps: BackupSealingDeps = {},
): Promise<SealedOrganizationBackup> {
  const organizationId = input.scope.organizationId;
  const state = await (deps.custodyState ?? organizationKeyCustodyState)(sql, organizationId);
  if (state === null) throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-unprovisioned', 'a sealed backup needs key custody');
  if (state === 'revoked') throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-revoked', 'key custody is revoked');
  if (state === 'shredded') throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-shredded', 'key custody is shredded');
  const service = (deps.keyService ?? organizationKeyService)(sql);
  const data = await exportOrganizationData(sql, input);
  return {
    receiptId: data.receiptId,
    organizationId,
    artifact: sealBackupArtifact(service, organizationId, exportLines(organizationId, data), { chunkBytes: deps.chunkBytes }),
  };
}

export interface OpenedOrganizationBackup {
  readonly organizationId: string;
  readonly receiptId: string;
  readonly stores: readonly { readonly store: string; readonly columns: readonly string[]; readonly rows: readonly Record<string, unknown>[] }[];
}

/** Opens a sealed export artifact and parses it back into stores and rows. */
export async function readOrganizationBackup(service: BackupKeyService, organizationId: string, sealed: ByteSource): Promise<OpenedOrganizationBackup> {
  const text = (await collectBytes(openBackupArtifact(service, organizationId, sealed))).toString('utf8');
  const records = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as BackupRecord);
  const header = records[0];
  if (!header || header.kind !== 'header' || header.format !== BACKUP_FORMAT || header.version !== BACKUP_FORMAT_VERSION) {
    throw malformed(organizationId, 'not an organization export artifact');
  }
  if (header.organizationId !== organizationId) throw malformed(organizationId, 'artifact names another organization');
  const stores: { store: string; columns: readonly string[]; rows: Record<string, unknown>[] }[] = [];
  for (const r of records.slice(1)) {
    if (r.kind === 'store') stores.push({ store: r.store, columns: r.columns, rows: [] });
    else if (r.kind === 'row') {
      const current = stores[stores.length - 1];
      if (!current || current.store !== r.store) throw malformed(organizationId, `row of ${r.store} outside its store section`);
      current.rows.push(r.row);
    } else throw malformed(organizationId, 'a second header');
  }
  return { organizationId, receiptId: header.receiptId, stores };
}
