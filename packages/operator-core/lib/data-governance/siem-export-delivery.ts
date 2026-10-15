/**
 * SIEM export delivery: server-side cursor, head and key custody for the export streams
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09#D-018 items 7-8, WI-6554700010012184).
 *
 * Two stream kinds share one pipeline (siem-export.ts batch format, manifest, chain, verifier):
 *   - tool-invocations: papercusp.siem-export:<workspaceId>            (siem-export.ts)
 *   - org-audit:        papercusp.siem-export.org-audit:<organizationId> (siem-export-org-audit.ts)
 *
 * Ops:
 *   - status: the stored cursor/head/key id, recent deliveries and whether the configured key rotated.
 *   - next:   build the next batch from the STORED cursor and head. Writes nothing, so a redelivery
 *             returns the same bytes and the same idempotency key.
 *   - ack:    rebuild that batch from the stored state up to `cursorTo`, require the caller's
 *             idempotency key to match, then advance the stream with a compare-and-set on the stored
 *             cursor and append a delivery row. A client can never acknowledge a fabricated head.
 *
 * Key custody: the pseudonym/digest key comes from PAPERCUSP_SIEM_EXPORT_KEY_REF, a reference
 * (env:NAME | file:<path> | an absolute path) resolved at the point of use. The key never enters the
 * repo, the database or a tool argument; only its id ('k:' + 16 hex of sha256) is stored.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { ChainLink } from '@papercusp/hash-chain';
import { resolveSecretRef } from '../inference-gateway/egress-providers/secret-ref';
import {
  SIEM_MAX_PAGE,
  SIEM_MIN_KEY_BYTES,
  assertSiemExportAuthorized,
  exportSiemPage,
  siemStreamId,
  type SiemBatch,
  type SiemSettleHorizon,
} from './siem-export';
import {
  ORG_AUDIT_CURSOR_START,
  assertOrgAuditExportAuthorized,
  exportOrgAuditPage,
  orgAuditStreamId,
} from './siem-export-org-audit';

export const SIEM_EXPORT_KEY_REF_ENV = 'PAPERCUSP_SIEM_EXPORT_KEY_REF' as const;
export const SIEM_DEFAULT_DELIVERY_LIMIT = 500;
const HEX64 = /^[0-9a-f]{64}$/;

export type SiemStreamRef =
  | { readonly kind: 'tool-invocations'; readonly workspaceId: string }
  | { readonly kind: 'org-audit'; readonly organizationId: string };

export type SiemExportErrorCode =
  | 'key_unconfigured'
  | 'key_too_short'
  | 'key_rotated'
  | 'bad_request'
  | 'nothing_to_ack'
  | 'cursor_not_rebuildable'
  | 'idempotency_mismatch'
  | 'cursor_moved';

/** A refusal with a stable code: the tool surfaces `code` so a consumer can branch on it. */
export class SiemExportError extends Error {
  constructor(
    readonly code: SiemExportErrorCode,
    message: string,
  ) {
    super(`siem-export: ${message}`);
    this.name = 'SiemExportError';
  }
}

export interface SiemExportKey {
  readonly key: Uint8Array;
  readonly keyId: string;
}

export function siemKeyId(key: Uint8Array): string {
  return `k:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/** Resolve the configured export key. Throws `key_unconfigured` / `key_too_short`; never logs the value. */
export async function resolveSiemExportKey(
  opts: { readonly env?: NodeJS.ProcessEnv; readonly resolve?: (ref: string) => Promise<string> } = {},
): Promise<SiemExportKey> {
  const ref = (opts.env ?? process.env)[SIEM_EXPORT_KEY_REF_ENV]?.trim();
  if (!ref) {
    throw new SiemExportError('key_unconfigured', `${SIEM_EXPORT_KEY_REF_ENV} is not set (expected env:NAME | file:<path>)`);
  }
  const value = await (opts.resolve ?? resolveSecretRef)(ref);
  const key = new Uint8Array(Buffer.from(value, 'utf8'));
  if (key.length < SIEM_MIN_KEY_BYTES) {
    throw new SiemExportError('key_too_short', `the export key must be at least ${SIEM_MIN_KEY_BYTES} bytes (got ${key.length})`);
  }
  return { key, keyId: siemKeyId(key) };
}

export function siemStreamIdOf(ref: SiemStreamRef): string {
  return ref.kind === 'tool-invocations' ? siemStreamId(ref.workspaceId) : orgAuditStreamId(ref.organizationId);
}

function startCursor(ref: SiemStreamRef): string {
  return ref.kind === 'tool-invocations' ? '0' : ORG_AUDIT_CURSOR_START;
}

export interface SiemStreamState {
  readonly streamId: string;
  readonly kind: SiemStreamRef['kind'];
  /** false = never acknowledged: the stream starts at its first cursor with no head. */
  readonly persisted: boolean;
  readonly cursor: string;
  readonly head: ChainLink | null;
  readonly keyId: string | null;
  readonly deliveredBatches: number;
  readonly updatedAt: string | null;
}

interface StreamRow {
  cursor: string;
  head: unknown;
  key_id: string | null;
  delivered_batches: string | number;
  updated_at: Date | string | null;
}

function toHead(raw: unknown): ChainLink | null {
  if (raw == null) return null;
  const h = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  return {
    streamId: String(h.streamId),
    seq: Number(h.seq),
    prevHash: String(h.prevHash),
    entryDigest: String(h.entryDigest),
    entryHash: String(h.entryHash),
  };
}

export async function loadSiemStream(sql: Sql, ref: SiemStreamRef): Promise<SiemStreamState> {
  const streamId = siemStreamIdOf(ref);
  const rows = await sql<StreamRow[]>`
    SELECT cursor, head, key_id, delivered_batches, updated_at
      FROM harness_shared.siem_export_streams
     WHERE stream_id = ${streamId}`;
  const row = rows[0];
  if (!row) {
    return { streamId, kind: ref.kind, persisted: false, cursor: startCursor(ref), head: null, keyId: null, deliveredBatches: 0, updatedAt: null };
  }
  return {
    streamId,
    kind: ref.kind,
    persisted: true,
    cursor: row.cursor,
    head: toHead(row.head),
    keyId: row.key_id,
    deliveredBatches: Number(row.delivered_batches),
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
  };
}

async function authorize(ref: SiemStreamRef, principal: string, sql: Sql, now: Date): Promise<void> {
  if (ref.kind === 'tool-invocations') await assertSiemExportAuthorized(principal, ref.workspaceId, { sql, now });
  else await assertOrgAuditExportAuthorized(principal, ref.organizationId, { sql, now });
}

/** A rotated key starts new pseudonyms and digests, so the consumer must opt in to seeing it happen. */
function checkRotation(state: SiemStreamState, keyId: string, acknowledged: boolean | undefined): boolean {
  const rotated = state.keyId !== null && state.keyId !== keyId;
  if (rotated && !acknowledged) {
    throw new SiemExportError(
      'key_rotated',
      `stream ${state.streamId} was exported under ${state.keyId} but the configured key is ${keyId}; pass acknowledgeKeyRotation:true to continue under the new key`,
    );
  }
  return rotated;
}

function clampLimit(limit: number | undefined): number {
  const n = limit ?? SIEM_DEFAULT_DELIVERY_LIMIT;
  if (!Number.isInteger(n) || n < 1) throw new SiemExportError('bad_request', `limit must be a positive integer (got ${limit})`);
  return Math.min(n, SIEM_MAX_PAGE);
}

interface BuildInput {
  readonly principal: string;
  readonly ref: SiemStreamRef;
  readonly state: SiemStreamState;
  readonly key: SiemExportKey;
  readonly limit: number;
  readonly sql: Sql;
  readonly now: Date;
  readonly settleMs?: number;
  readonly upTo?: string;
}

function buildBatch(b: BuildInput): Promise<SiemBatch & { readonly horizon: SiemSettleHorizon }> {
  const common = { principal: b.principal, prevHead: b.state.head, limit: b.limit, key: b.key.key, keyId: b.key.keyId, now: b.now, settleMs: b.settleMs, sql: b.sql };
  if (b.ref.kind === 'tool-invocations') {
    return exportSiemPage({ ...common, workspaceId: b.ref.workspaceId, afterId: b.state.cursor, upToId: b.upTo });
  }
  return exportOrgAuditPage({ ...common, organizationId: b.ref.organizationId, after: b.state.cursor, upTo: b.upTo });
}

export interface SiemExportOpInput {
  readonly principal: string;
  readonly stream: SiemStreamRef;
  readonly sql?: Sql;
  readonly now?: Date;
  readonly settleMs?: number;
  /** Tests inject a key; production resolves PAPERCUSP_SIEM_EXPORT_KEY_REF. */
  readonly key?: SiemExportKey;
}

export interface SiemExportNextResult extends SiemBatch {
  readonly horizon: SiemSettleHorizon;
  readonly stream: SiemStreamState;
  readonly keyRotated: boolean;
}

/** Build the next batch from the stored cursor and head. Writes nothing. */
export async function siemExportNext(
  input: SiemExportOpInput & { readonly limit?: number; readonly acknowledgeKeyRotation?: boolean },
): Promise<SiemExportNextResult> {
  const sql = input.sql ?? getOrgPg().sql;
  const now = input.now ?? new Date();
  await authorize(input.stream, input.principal, sql, now);
  const key = input.key ?? (await resolveSiemExportKey());
  const state = await loadSiemStream(sql, input.stream);
  const keyRotated = checkRotation(state, key.keyId, input.acknowledgeKeyRotation);
  const batch = await buildBatch({ principal: input.principal, ref: input.stream, state, key, limit: clampLimit(input.limit), sql, now, settleMs: input.settleMs });
  return { ...batch, stream: state, keyRotated };
}

export interface SiemDeliveryRow {
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  readonly cursorFrom: string;
  readonly cursorTo: string;
  readonly length: number;
  readonly headSeq: number;
  readonly headEntryHash: string;
  readonly keyId: string | null;
  readonly acknowledgedBy: string;
  readonly acknowledgedAt: string;
}

interface DeliveryRowDb {
  delivery_id: string;
  idempotency_key: string;
  cursor_from: string;
  cursor_to: string;
  length: number;
  head_seq: string | number;
  head_entry_hash: string;
  key_id: string | null;
  acknowledged_by: string;
  acknowledged_at: Date | string;
}

function toDelivery(r: DeliveryRowDb): SiemDeliveryRow {
  return {
    deliveryId: r.delivery_id,
    idempotencyKey: r.idempotency_key,
    cursorFrom: r.cursor_from,
    cursorTo: r.cursor_to,
    length: Number(r.length),
    headSeq: Number(r.head_seq),
    headEntryHash: r.head_entry_hash,
    keyId: r.key_id,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedAt: new Date(r.acknowledged_at).toISOString(),
  };
}

async function findDelivery(sql: Sql, streamId: string, idempotencyKey: string): Promise<SiemDeliveryRow | null> {
  const rows = await sql<DeliveryRowDb[]>`
    SELECT delivery_id, idempotency_key, cursor_from, cursor_to, length, head_seq, head_entry_hash, key_id, acknowledged_by, acknowledged_at
      FROM harness_shared.siem_export_deliveries
     WHERE stream_id = ${streamId} AND idempotency_key = ${idempotencyKey}`;
  return rows[0] ? toDelivery(rows[0]) : null;
}

export type SiemExportAckResult =
  | { readonly status: 'acknowledged'; readonly delivery: SiemDeliveryRow; readonly stream: SiemStreamState; readonly keyRotated: boolean }
  | { readonly status: 'already-acknowledged'; readonly delivery: SiemDeliveryRow; readonly stream: SiemStreamState };

/**
 * Acknowledge a delivered batch. Idempotent: acknowledging the same batch twice returns
 * `already-acknowledged` with the original delivery row.
 */
export async function siemExportAck(
  input: SiemExportOpInput & { readonly idempotencyKey: string; readonly cursorTo: string; readonly acknowledgeKeyRotation?: boolean },
): Promise<SiemExportAckResult> {
  if (!HEX64.test(input.idempotencyKey)) throw new SiemExportError('bad_request', 'idempotencyKey must be 64 lowercase hex characters');
  if (!input.cursorTo.trim()) throw new SiemExportError('bad_request', 'cursorTo is required');
  const sql = input.sql ?? getOrgPg().sql;
  const now = input.now ?? new Date();
  await authorize(input.stream, input.principal, sql, now);
  const streamId = siemStreamIdOf(input.stream);

  const prior = await findDelivery(sql, streamId, input.idempotencyKey);
  if (prior) return { status: 'already-acknowledged', delivery: prior, stream: await loadSiemStream(sql, input.stream) };

  const key = input.key ?? (await resolveSiemExportKey());
  const state = await loadSiemStream(sql, input.stream);
  const keyRotated = checkRotation(state, key.keyId, input.acknowledgeKeyRotation);
  if (input.cursorTo === state.cursor) throw new SiemExportError('nothing_to_ack', `cursorTo equals the stored cursor of ${streamId}; an empty batch is never acknowledged`);

  const batch = await buildBatch({ principal: input.principal, ref: input.stream, state, key, limit: SIEM_MAX_PAGE, sql, now, settleMs: input.settleMs, upTo: input.cursorTo });
  if (batch.manifest.length === 0 || !batch.head || batch.manifest.cursorTo !== input.cursorTo) {
    throw new SiemExportError(
      'cursor_not_rebuildable',
      `cannot rebuild a batch of ${streamId} ending at ${input.cursorTo} from the stored cursor ${state.cursor} (rebuilt through ${batch.manifest.cursorTo}); call next again`,
    );
  }
  if (batch.manifest.idempotencyKey !== input.idempotencyKey) {
    throw new SiemExportError('idempotency_mismatch', `the batch rebuilt from the stored state has idempotency key ${batch.manifest.idempotencyKey}; call next again`);
  }
  const head = batch.head;

  const outcome = await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.siem_export_streams (stream_id, kind, workspace_id, organization_id)
      VALUES (${streamId}, ${input.stream.kind},
              ${input.stream.kind === 'tool-invocations' ? input.stream.workspaceId : null},
              ${input.stream.kind === 'org-audit' ? input.stream.organizationId : null})
      ON CONFLICT (stream_id) DO NOTHING`;
    const locked = await tx<{ cursor: string; delivered_batches: string | number }[]>`
      SELECT cursor, delivered_batches FROM harness_shared.siem_export_streams WHERE stream_id = ${streamId} FOR UPDATE`;
    const raced = await findDelivery(tx as unknown as Sql, streamId, input.idempotencyKey);
    if (raced) return { kind: 'already' as const, delivery: raced };
    const row = locked[0]!;
    if (row.cursor !== state.cursor || Number(row.delivered_batches) !== state.deliveredBatches) {
      throw new SiemExportError('cursor_moved', `${streamId} advanced to ${row.cursor} while this ack was being checked; call next again`);
    }
    await tx`
      UPDATE harness_shared.siem_export_streams
         SET cursor = ${input.cursorTo}, head = ${tx.json(head as unknown as Parameters<typeof tx.json>[0])},
             key_id = ${key.keyId}, delivered_batches = delivered_batches + 1
       WHERE stream_id = ${streamId}`;
    const inserted = await tx<DeliveryRowDb[]>`
      INSERT INTO harness_shared.siem_export_deliveries
        (stream_id, idempotency_key, cursor_from, cursor_to, length, head_seq, head_entry_hash, key_id, acknowledged_by)
      VALUES (${streamId}, ${input.idempotencyKey}, ${state.cursor}, ${input.cursorTo}, ${batch.manifest.length},
              ${head.seq}, ${head.entryHash}, ${key.keyId}, ${input.principal})
      RETURNING delivery_id, idempotency_key, cursor_from, cursor_to, length, head_seq, head_entry_hash, key_id, acknowledged_by, acknowledged_at`;
    return { kind: 'acknowledged' as const, delivery: toDelivery(inserted[0]!) };
  });

  const stream = await loadSiemStream(sql, input.stream);
  if (outcome.kind === 'already') return { status: 'already-acknowledged', delivery: outcome.delivery, stream };
  return { status: 'acknowledged', delivery: outcome.delivery, stream, keyRotated };
}

export interface SiemExportStatusResult {
  readonly stream: SiemStreamState;
  readonly recentDeliveries: readonly SiemDeliveryRow[];
  /** null when no key is configured (status still answers; next/ack refuse). */
  readonly configuredKeyId: string | null;
  readonly keyRotationPending: boolean;
}

export async function siemExportStatus(input: SiemExportOpInput & { readonly deliveries?: number }): Promise<SiemExportStatusResult> {
  const sql = input.sql ?? getOrgPg().sql;
  const now = input.now ?? new Date();
  await authorize(input.stream, input.principal, sql, now);
  const stream = await loadSiemStream(sql, input.stream);
  const limit = Math.max(0, Math.min(input.deliveries ?? 10, 100));
  const rows = await sql<DeliveryRowDb[]>`
    SELECT delivery_id, idempotency_key, cursor_from, cursor_to, length, head_seq, head_entry_hash, key_id, acknowledged_by, acknowledged_at
      FROM harness_shared.siem_export_deliveries
     WHERE stream_id = ${stream.streamId}
     ORDER BY acknowledged_at DESC, delivery_id DESC
     LIMIT ${limit}`;
  let configuredKeyId: string | null = null;
  try {
    configuredKeyId = (input.key ?? (await resolveSiemExportKey())).keyId;
  } catch (err) {
    if (!(err instanceof SiemExportError)) throw err;
  }
  return {
    stream,
    recentDeliveries: rows.map(toDelivery),
    configuredKeyId,
    keyRotationPending: configuredKeyId !== null && stream.keyId !== null && stream.keyId !== configuredKeyId,
  };
}
