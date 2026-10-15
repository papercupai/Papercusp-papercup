/**
 * Sealing of organization-derived data (embedding vectors and telemetry payloads) under the
 * organization's customer-managed key (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b
 * follow-up, WI-6554700010012443 U4; decision D-020).
 *
 * The pilot has no store for either yet. Organization search is lexical and documents-corpus.ts writes
 * no vector, and the pilot processing map lists telemetry as not assessed with no enumerated store
 * (siem_export_deliveries records delivery cursors, not payloads). These are the formats a store uses
 * when it starts holding organization-derived data of an organization with key custody.
 *
 *   embedding: envelope-v2 blob (organization-keys.ts), sealed scope 'embedding'. Plaintext:
 *              format (1 byte) | model length (uint16 BE) | model (UTF-8) | dimension (uint32 BE) |
 *              dimension float32 little-endian values.
 *   telemetry: envelope-v2 blob, sealed scope 'telemetry'. Plaintext: UTF-8 JSON {v, kind, payload}.
 *
 * The envelope binds the organization, the DEK version and the scope, so a vector cannot be opened as
 * telemetry (or the reverse) and no blob opens for another organization. The model and dimension of a
 * vector and the kind of a telemetry record are inside the authenticated plaintext, so a reader that
 * names what it expects is refused a blob of another model or kind ('envelope-malformed').
 *
 * A revoked or shredded key fails closed (OrganizationKeyUnavailableError) instead of falling back to
 * plaintext. A blob sealed under an older DEK version opens while that version is live; re-sealing after
 * a rotation is the key service's reencrypt or sweep with the same scope.
 */
import type { Sql } from 'postgres';
import { workspaceOrganization } from './organization-content-sealing';
import { organizationKeyCustodyState, organizationKeyService, type OrganizationKeyCustodyState } from './organization-key-registry';
import { OrganizationKeyUnavailableError, type OrganizationKeyService } from './organization-keys';

export type DerivedKeyService = Pick<OrganizationKeyService, 'encrypt' | 'decrypt'>;

export const SEALED_EMBEDDING_FORMAT = 1;
export const SEALED_TELEMETRY_FORMAT = 1;
export const MAX_EMBEDDING_DIMENSION = 65_536;
const MAX_MODEL_BYTES = 255;

export interface EmbeddingPlaintext {
  /** The embedding model that produced the vector, e.g. 'text-embedding-3-small'. */
  readonly model: string;
  /** Stored as float32: a number[] input is rounded to float32 precision. */
  readonly vector: Float32Array | readonly number[];
}

export interface OpenedEmbedding {
  readonly model: string;
  readonly vector: Float32Array;
}

export interface TelemetryPlaintext {
  /** What the record is, e.g. 'retrieval-trace'. A reader can require it. */
  readonly kind: string;
  readonly payload: unknown;
}

function malformed(organizationId: string, detail: string): OrganizationKeyUnavailableError {
  return new OrganizationKeyUnavailableError(organizationId, 'envelope-malformed', detail);
}

function encodeEmbedding(embedding: EmbeddingPlaintext): Buffer {
  const model = Buffer.from(embedding.model, 'utf8');
  if (model.length === 0 || model.length > MAX_MODEL_BYTES) {
    throw new Error(`organization-derived-sealing: embedding model must be 1-${MAX_MODEL_BYTES} UTF-8 bytes`);
  }
  const dimension = embedding.vector.length;
  if (dimension < 1 || dimension > MAX_EMBEDDING_DIMENSION) {
    throw new Error(`organization-derived-sealing: embedding dimension ${dimension} is outside 1-${MAX_EMBEDDING_DIMENSION}`);
  }
  const out = Buffer.alloc(1 + 2 + model.length + 4 + dimension * 4);
  let at = out.writeUInt8(SEALED_EMBEDDING_FORMAT, 0);
  at = out.writeUInt16BE(model.length, at);
  at += model.copy(out, at);
  at = out.writeUInt32BE(dimension, at);
  for (let i = 0; i < dimension; i += 1) {
    const value = embedding.vector[i]!;
    if (!Number.isFinite(value)) throw new Error(`organization-derived-sealing: embedding value ${i} is not finite`);
    at = out.writeFloatLE(value, at);
  }
  return out;
}

function decodeEmbedding(organizationId: string, plain: Buffer): OpenedEmbedding {
  if (plain.length < 1 + 2 || plain.readUInt8(0) !== SEALED_EMBEDDING_FORMAT) throw malformed(organizationId, 'not a sealed embedding');
  const modelBytes = plain.readUInt16BE(1);
  const dimensionAt = 3 + modelBytes;
  if (plain.length < dimensionAt + 4) throw malformed(organizationId, 'sealed embedding is short');
  const model = plain.subarray(3, dimensionAt).toString('utf8');
  const dimension = plain.readUInt32BE(dimensionAt);
  if (plain.length !== dimensionAt + 4 + dimension * 4) throw malformed(organizationId, 'sealed embedding length does not match its dimension');
  const vector = new Float32Array(dimension);
  for (let i = 0; i < dimension; i += 1) vector[i] = plain.readFloatLE(dimensionAt + 4 + i * 4);
  return { model, vector };
}

/** Seals one embedding vector of the organization (scope 'embedding'). */
export async function sealEmbedding(service: DerivedKeyService, organizationId: string, embedding: EmbeddingPlaintext): Promise<Buffer> {
  return service.encrypt(organizationId, 'embedding', encodeEmbedding(embedding));
}

/**
 * Opens a sealed embedding. With `expect`, a vector of another model or dimension is refused
 * ('envelope-malformed'), so vectors of two models are never compared by mistake.
 */
export async function openEmbedding(
  service: DerivedKeyService,
  organizationId: string,
  blob: Buffer,
  expect: { model?: string; dimension?: number } = {},
): Promise<OpenedEmbedding> {
  const opened = decodeEmbedding(organizationId, await service.decrypt(organizationId, 'embedding', blob));
  if (expect.model !== undefined && opened.model !== expect.model) {
    throw malformed(organizationId, `sealed embedding is of model ${opened.model}, not ${expect.model}`);
  }
  if (expect.dimension !== undefined && opened.vector.length !== expect.dimension) {
    throw malformed(organizationId, `sealed embedding has dimension ${opened.vector.length}, not ${expect.dimension}`);
  }
  return opened;
}

/** Seals one telemetry record of the organization (scope 'telemetry'). bigint values are written as strings. */
export async function sealTelemetryPayload(service: DerivedKeyService, organizationId: string, record: TelemetryPlaintext): Promise<Buffer> {
  if (!record.kind) throw new Error('organization-derived-sealing: telemetry kind is required');
  if (record.payload === undefined) throw new Error('organization-derived-sealing: telemetry payload is undefined');
  const json = JSON.stringify(
    { v: SEALED_TELEMETRY_FORMAT, kind: record.kind, payload: record.payload },
    (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return service.encrypt(organizationId, 'telemetry', Buffer.from(json, 'utf8'));
}

/** Opens a sealed telemetry record. With `expectedKind`, a record of another kind is refused ('envelope-malformed'). */
export async function openTelemetryPayload(
  service: DerivedKeyService,
  organizationId: string,
  blob: Buffer,
  expectedKind?: string,
): Promise<TelemetryPlaintext> {
  const plain = await service.decrypt(organizationId, 'telemetry', blob);
  let parsed: { v?: unknown; kind?: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(plain.toString('utf8')) as typeof parsed;
  } catch {
    throw malformed(organizationId, 'sealed telemetry is not JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== SEALED_TELEMETRY_FORMAT || typeof parsed.kind !== 'string' || !('payload' in parsed)) {
    throw malformed(organizationId, 'not a sealed telemetry record');
  }
  if (expectedKind !== undefined && parsed.kind !== expectedKind) {
    throw malformed(organizationId, `sealed telemetry is of kind ${parsed.kind}, not ${expectedKind}`);
  }
  return { kind: parsed.kind, payload: parsed.payload };
}

export interface DerivedSealingDeps {
  readonly keyService?: (sql: Sql) => DerivedKeyService;
  readonly custodyState?: (sql: Sql, organizationId: string) => Promise<OrganizationKeyCustodyState | null>;
}

/** The helpers above bound to one organization's key service. */
export interface DerivedSealing {
  readonly organizationId: string;
  sealEmbedding(embedding: EmbeddingPlaintext): Promise<Buffer>;
  openEmbedding(blob: Buffer, expect?: { model?: string; dimension?: number }): Promise<OpenedEmbedding>;
  sealTelemetry(record: TelemetryPlaintext): Promise<Buffer>;
  openTelemetry(blob: Buffer, expectedKind?: string): Promise<TelemetryPlaintext>;
}

/**
 * The derived-data sealer of an organization, or null when it has no key custody (its derived data is
 * stored in plaintext). Custody in any state returns a sealer: a revoked or shredded key makes every
 * call throw OrganizationKeyUnavailableError, so a store never falls back to plaintext.
 */
export async function derivedSealing(sql: Sql, organizationId: string, deps: DerivedSealingDeps = {}): Promise<DerivedSealing | null> {
  const state = await (deps.custodyState ?? organizationKeyCustodyState)(sql, organizationId);
  if (state === null) return null;
  const service = (deps.keyService ?? organizationKeyService)(sql);
  return {
    organizationId,
    sealEmbedding: (embedding) => sealEmbedding(service, organizationId, embedding),
    openEmbedding: (blob, expect) => openEmbedding(service, organizationId, blob, expect),
    sealTelemetry: (record) => sealTelemetryPayload(service, organizationId, record),
    openTelemetry: (blob, expectedKind) => openTelemetryPayload(service, organizationId, blob, expectedKind),
  };
}

/** derivedSealing for the organization that owns a workspace (workspaceOrganization), or null when none does. */
export async function workspaceDerivedSealing(sql: Sql, workspaceId: string, deps: DerivedSealingDeps = {}): Promise<DerivedSealing | null> {
  const organizationId = await workspaceOrganization(sql, workspaceId);
  return organizationId ? derivedSealing(sql, organizationId, deps) : null;
}
