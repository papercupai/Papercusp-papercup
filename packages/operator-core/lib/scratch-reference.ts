/**
 * Self-describing scratch references (orchestration-runtime-unification P-007).
 *
 * The manifest and payload share ONE file: the payload is written once, while
 * readers can enforce expiry/audience and verify integrity before exposing it.
 * Legacy scratch files remain readable as ordinary files.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import type { OutputAudience, OutputEvidenceClass } from './output-envelope';
import type { GatewayPayloadSpool } from './inference-gateway/payload-spool';
import {
  reserveScratchSpace,
  noteScratchWriteSettled,
  writeWithScratchQuota,
  RETENTION_MS,
  markNewWorkspaceScratchRoot,
  markNewWorkspaceScratchRootSync,
  type ScratchWriteTimings,
} from './scratch-gc';

export const SCRATCH_REFERENCE_SCHEMA_VERSION = 'papercusp.scratch-reference/v1' as const;
export const SCRATCH_REFERENCE_MAGIC = `${SCRATCH_REFERENCE_SCHEMA_VERSION}\n`;
/** Volatile recovery references use the same reader contract without pretending a file exists. */
export const VOLATILE_SCRATCH_REFERENCE_SCHEME = 'papercusp://scratch-memory';
export const VOLATILE_SCRATCH_REFERENCE_TTL_MS = 5 * 60 * 1000;
const VOLATILE_SCRATCH_REFERENCE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const VOLATILE_SCRATCH_REFERENCE_MAX_BYTES = 64 * 1024 * 1024;
const VOLATILE_SCRATCH_REFERENCE_MAX_ENTRIES = 64;
const VOLATILE_SCRATCH_REFERENCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Short-lived durable rescue copies use the same expiry as the volatile fallback. */
export const DURABLE_SCRATCH_REFERENCE_SCHEME = 'papercusp://scratch-spool';
export const DURABLE_SCRATCH_REFERENCE_TTL_MS = VOLATILE_SCRATCH_REFERENCE_TTL_MS;
const DURABLE_SCRATCH_REFERENCE_PAYLOAD_REF = /^[0-9a-f]{64}$/;
const DURABLE_SCRATCH_REFERENCE_CONTENT_TYPE = 'application/vnd.papercusp.scratch-reference';

interface VolatileScratchReferenceEntry {
  manifest: ScratchReferenceManifest;
  payload: Buffer;
}

interface VolatileScratchReferenceState {
  entries: Map<string, VolatileScratchReferenceEntry>;
  bytes: number;
}

// result-door and capability:read can be loaded through distinct module records in tsx.
// Pin the fallback store so a reference written by one is readable by the other.
const volatileScratchState = pinModuleState<VolatileScratchReferenceState>(
  '@papercusp/operator-core.volatile-scratch-reference',
  () => ({ entries: new Map(), bytes: 0 }),
);

export interface ScratchReferenceContentMetadata {
  index: number;
  type: string;
  mimeType?: string;
  byteCount: number;
}

export interface ScratchReferenceManifest {
  schemaVersion: typeof SCRATCH_REFERENCE_SCHEMA_VERSION;
  createdAt: string;
  expiresAt: string;
  workspaceId: string;
  ownerId?: string;
  audience: OutputAudience;
  mediaType: string;
  byteCount: number;
  sha256: string;
  content: readonly ScratchReferenceContentMetadata[];
  evidence?: readonly ScratchReferenceEvidenceSelector[];
  /**
   * EI-21949915395361184 (umbrella over ten reports): byte offset, WITHIN THE PAYLOAD
   * (i.e. after this header), at which the machine-readable body begins — everything
   * before it is human-facing preamble the writer prepended.
   *
   * The file is a self-describing CONTAINER, not a JSON document, and until now the
   * boundary existed only in the tool RESULT's cursor. A consumer holding just the path
   * had to guess, and every natural guess fails: `jq .` chokes on the magic line, and
   * "first `{` through EOF" lands on THIS MANIFEST — a well-formed but WRONG object,
   * which is the failure mode that got reported ten times because it looks like success.
   *
   * Measured against the PAYLOAD, never the file, and that is not a detail: a
   * file-relative offset would have to count the header that contains it, so writing it
   * down would change it. The file offset stays derivable — the header is exactly the
   * first two lines — via `scratchReferenceBodyByteOffset()`, or in a shell:
   *
   *   P=$(sed -n 2p FILE | jq -r '.bodyOffsetInPayload')
   *   H=$(head -2 FILE | wc -c)
   *   tail -c +$((H + P + 1)) FILE | jq .
   *
   * Omitted when the writer has no machine-readable body to point at (a payload that is
   * entirely prose). Absent MEANS "no declared body", never "offset 0".
   */
  bodyOffsetInPayload?: number;
}

export interface ScratchReferenceEvidenceSelector {
  evidenceClass: OutputEvidenceClass;
  contentIndex: number;
  jsonPointers: readonly string[];
}

export interface ParsedScratchReference {
  manifest: ScratchReferenceManifest;
  payload: Buffer;
  payloadByteOffset: number;
}

/** Build the on-disk manifest header once so writers and cursor metadata agree
 * on where the plaintext payload begins. */
export function scratchReferenceHeader(manifest: ScratchReferenceManifest): Buffer {
  return Buffer.from(`${SCRATCH_REFERENCE_MAGIC}${JSON.stringify(manifest)}\n`, 'utf8');
}

/** Byte offset of the payload in a self-describing scratch reference file. */
export function scratchReferencePayloadByteOffset(manifest: ScratchReferenceManifest): number {
  return scratchReferenceHeader(manifest).byteLength;
}

/**
 * Byte offset of the machine-readable BODY in the raw FILE — the one number a `jq` /
 * `tail -c` consumer actually needs. Null when the manifest declares no body, which is
 * a real answer ("this payload is prose") and must not be read as offset 0.
 *
 * Derived from the manifest rather than stored in it, because a file-relative offset
 * cannot be written into the header it would have to measure.
 */
export function scratchReferenceBodyByteOffset(manifest: ScratchReferenceManifest): number | null {
  return manifest.bodyOffsetInPayload == null
    ? null
    : scratchReferencePayloadByteOffset(manifest) + manifest.bodyOffsetInPayload;
}

export class ScratchReferenceError extends Error {
  constructor(
    readonly code:
      | 'invalid_reference'
      | 'expired_reference'
      | 'forbidden_reference'
      | 'workspace_mismatch'
      | 'integrity_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'ScratchReferenceError';
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isAudience(value: unknown): value is OutputAudience {
  return value === 'owner' || value === 'workspace' || value === 'public';
}

function requireManifest(value: unknown): ScratchReferenceManifest {
  if (!value || typeof value !== 'object') {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest must be an object');
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== SCRATCH_REFERENCE_SCHEMA_VERSION) {
    throw new ScratchReferenceError('invalid_reference', 'unsupported scratch reference schema');
  }
  if (
    typeof row.createdAt !== 'string' ||
    typeof row.expiresAt !== 'string' ||
    typeof row.workspaceId !== 'string' ||
    typeof row.mediaType !== 'string' ||
    typeof row.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(row.sha256) ||
    !Number.isSafeInteger(row.byteCount) ||
    Number(row.byteCount) < 0 ||
    !isAudience(row.audience) ||
    (row.ownerId !== undefined && typeof row.ownerId !== 'string') ||
    !Array.isArray(row.content)
  ) {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest has invalid fields');
  }
  return row as unknown as ScratchReferenceManifest;
}

export function contentMetadata(items: readonly unknown[]): ScratchReferenceContentMetadata[] {
  return items.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const type = typeof row.type === 'string' ? row.type : 'unknown';
    const mimeType = typeof row.mimeType === 'string' ? row.mimeType : undefined;
    const body = type === 'text' && typeof row.text === 'string'
      ? row.text
      : typeof row.data === 'string'
        ? row.data
        : JSON.stringify(item) ?? '';
    return {
      index,
      type,
      ...(mimeType ? { mimeType } : {}),
      byteCount: Buffer.byteLength(body, 'utf8'),
    };
  });
}

function createScratchReferenceManifest(input: {
  payload: Buffer;
  workspaceId: string;
  ownerId?: string | null;
  audience?: OutputAudience;
  mediaType: string;
  content?: readonly ScratchReferenceContentMetadata[];
  evidence?: readonly ScratchReferenceEvidenceSelector[];
  nowMs?: number;
  ttlMs?: number;
  bodyOffsetInPayload?: number;
}): ScratchReferenceManifest {
  const nowMs = input.nowMs ?? Date.now();
  const audience = input.audience ?? (input.ownerId ? 'owner' : 'workspace');
  if (audience === 'owner' && !input.ownerId) {
    throw new ScratchReferenceError('invalid_reference', 'owner audience requires ownerId');
  }
  return {
    schemaVersion: SCRATCH_REFERENCE_SCHEMA_VERSION,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + (input.ttlMs ?? RETENTION_MS)).toISOString(),
    workspaceId: input.workspaceId,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    audience,
    mediaType: input.mediaType,
    byteCount: input.payload.length,
    sha256: sha256(input.payload),
    content: [...(input.content ?? [])],
    ...(input.evidence?.length ? { evidence: input.evidence.map((entry) => ({ ...entry, jsonPointers: [...entry.jsonPointers] })) } : {}),
    ...(input.bodyOffsetInPayload != null &&
    Number.isSafeInteger(input.bodyOffsetInPayload) &&
    input.bodyOffsetInPayload >= 0 &&
    input.bodyOffsetInPayload < input.payload.length
      ? { bodyOffsetInPayload: input.bodyOffsetInPayload }
      : {}),
  };
}

export function writeScratchReference(input: {
  filePath: string;
  payload: Buffer | string;
  workspaceId: string;
  ownerId?: string | null;
  /** MCP request correlation used to identify this writer in mutex wait diagnostics. */
  requestTraceId?: string;
  /** Optional caller budget for scratch-quota mutex admission. */
  mutexTimeoutMs?: number;
  audience?: OutputAudience;
  mediaType: string;
  content?: readonly ScratchReferenceContentMetadata[];
  evidence?: readonly ScratchReferenceEvidenceSelector[];
  nowMs?: number;
  /** Payload-relative start of the machine-readable body; see the manifest field. */
  bodyOffsetInPayload?: number;
  /**
   * When given, the file is written with fs.promises and the write's promise is pushed
   * here instead of blocking: the caller MUST await it before handing the reference to
   * anyone (see applyResultDoorAsync). Omitted ⇒ the synchronous write below.
   *
   * WI-10004533: the synchronous mkdirSync + writeFileSync runs on the request worker's
   * main thread; under ext4/jbd2 contention it sat in D-state long enough for the
   * event-loop sentinel to SIGKILL the operator with every in-flight MCP call.
   */
  deferredWrites?: Promise<void>[];
  /** Request-local phase observer; no paths, payloads or caller identifiers are reported. */
  onScratchWriteTiming?: (timings: ScratchWriteTimings) => void;
}): ScratchReferenceManifest {
  const payload = Buffer.isBuffer(input.payload) ? input.payload : Buffer.from(input.payload, 'utf8');
  const manifest = createScratchReferenceManifest({ ...input, payload });
  const header = scratchReferenceHeader(manifest);
  const bytes = Buffer.concat([header, payload]);
  if (input.deferredWrites) {
    const filePath = input.filePath;
    const write = writeWithScratchQuota({ workspaceId: input.workspaceId, filePath, bytes: bytes.length,
      requestTraceId: input.requestTraceId,
      mutexTimeoutMs: input.mutexTimeoutMs,
      captureSubphaseTimings: Boolean(input.onScratchWriteTiming),
      onTiming: input.onScratchWriteTiming }, async (observeAwait) => {
      // WI-10006512: a root this mkdir creates is marked as a workspace scratch root, so the
      // scratch GC can later prove it is ours before deleting it.
      const firstCreated = await observeAwait('file-write', 'mkdir', () =>
        mkdir(dirname(filePath), { recursive: true, mode: 0o700 }));
      await observeAwait('file-write', 'workspace-marker', () =>
        markNewWorkspaceScratchRoot(input.workspaceId, firstCreated));
      await observeAwait('file-write', 'payload-write-file', () =>
        writeFile(filePath, bytes, { mode: 0o600 }));
    });
    // Mark handled now: the caller awaits it later, and a fast failure must not reach the
    // process-level unhandledRejection handler (which terminates the host) first.
    write.catch(() => {});
    input.deferredWrites.push(write);
    return manifest;
  }
  reserveScratchSpace({ workspaceId: input.workspaceId, bytes: bytes.length, filePath: input.filePath });
  let wrote = false;
  try {
    markNewWorkspaceScratchRootSync(
      input.workspaceId,
      mkdirSync(dirname(input.filePath), { recursive: true, mode: 0o700 }),
    );
    writeFileSync(input.filePath, bytes, { mode: 0o600 });
    wrote = true;
  } finally {
    noteScratchWriteSettled(input.workspaceId, !wrote);
  }
  return manifest;
}

/** Store an exact temporary recovery copy when the primary scratch writer fails. */
export function storeVolatileScratchReference(input: {
  payload: Buffer | string;
  workspaceId: string;
  ownerId?: string | null;
  audience?: OutputAudience;
  mediaType: string;
  content?: readonly ScratchReferenceContentMetadata[];
  evidence?: readonly ScratchReferenceEvidenceSelector[];
  nowMs?: number;
  bodyOffsetInPayload?: number;
}): { uri: string; manifest: ScratchReferenceManifest } | null {
  const payloadBytes = Buffer.isBuffer(input.payload)
    ? input.payload.byteLength
    : Buffer.byteLength(input.payload, 'utf8');
  if (payloadBytes > VOLATILE_SCRATCH_REFERENCE_MAX_ENTRY_BYTES) return null;

  const nowMs = input.nowMs ?? Date.now();
  pruneVolatileScratchReferences(nowMs);
  const payload = Buffer.from(input.payload);
  const manifest = createScratchReferenceManifest({
    ...input,
    payload,
    nowMs,
    ttlMs: VOLATILE_SCRATCH_REFERENCE_TTL_MS,
  });
  while (
    volatileScratchState.entries.size >= VOLATILE_SCRATCH_REFERENCE_MAX_ENTRIES ||
    volatileScratchState.bytes + payload.length > VOLATILE_SCRATCH_REFERENCE_MAX_BYTES
  ) {
    const oldest = volatileScratchState.entries.keys().next().value as string | undefined;
    if (!oldest) return null;
    deleteVolatileScratchReference(oldest);
  }

  const uri = `${VOLATILE_SCRATCH_REFERENCE_SCHEME}/${randomUUID()}`;
  volatileScratchState.entries.set(uri, { manifest, payload });
  volatileScratchState.bytes += payload.length;
  return { uri, manifest };
}

/** True only for an opaque, well-formed volatile scratch URI. */
export function isVolatileScratchReferenceUri(uri: string): boolean {
  const prefix = `${VOLATILE_SCRATCH_REFERENCE_SCHEME}/`;
  return uri.startsWith(prefix) && VOLATILE_SCRATCH_REFERENCE_ID.test(uri.slice(prefix.length));
}

/** True only for a content-addressed durable scratch URI. */
export function isDurableScratchReferenceUri(uri: string): boolean {
  const prefix = `${DURABLE_SCRATCH_REFERENCE_SCHEME}/`;
  return uri.startsWith(prefix) && DURABLE_SCRATCH_REFERENCE_PAYLOAD_REF.test(uri.slice(prefix.length));
}

/**
 * Copy a still-authorized volatile fallback into the existing workspace-scoped
 * Postgres payload spool. The embedded scratch manifest remains the authority
 * for workspace, owner, expiry, and payload integrity; the content-addressed
 * spool key only locates its framed bytes.
 *
 * `spool` is injectable for hermetic tests. Production creates the existing
 * gateway spool with an expiry no later than the manifest, so its regular
 * bounded sweeper can reclaim the rescue row without a new cleanup system.
 */
export async function persistVolatileScratchReference(
  uri: string,
  caller: { workspaceId?: string | null; ownerId?: string | null; nowMs?: number },
  options: { spool?: GatewayPayloadSpool } = {},
): Promise<{ uri: string; manifest: ScratchReferenceManifest }> {
  const fallback = readVolatileScratchReference(uri, caller);
  const nowMs = caller.nowMs ?? Date.now();
  const remainingMs = Date.parse(fallback.manifest.expiresAt) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new ScratchReferenceError('expired_reference', 'volatile scratch fallback expired before durable persistence');
  }

  const framed = Buffer.concat([scratchReferenceHeader(fallback.manifest), fallback.payload]);
  const payloadSpool = await import('./inference-gateway/payload-spool');
  if (framed.byteLength > payloadSpool.DEFAULT_MAX_SPOOL_BYTES) {
    throw new ScratchReferenceError('invalid_reference', 'scratch fallback exceeds the durable payload-spool limit');
  }
  const spool = options.spool ?? payloadSpool.createGatewayPayloadSpool({
    maxBytes: payloadSpool.DEFAULT_MAX_SPOOL_BYTES,
    ttlMs: remainingMs,
  });
  const stored = await spool.spool(framed, { contentType: DURABLE_SCRATCH_REFERENCE_CONTENT_TYPE });
  if (!stored.payloadRef || !DURABLE_SCRATCH_REFERENCE_PAYLOAD_REF.test(stored.payloadRef)) {
    throw new ScratchReferenceError('invalid_reference', 'payload spool returned an invalid durable reference');
  }
  return {
    uri: `${DURABLE_SCRATCH_REFERENCE_SCHEME}/${stored.payloadRef}`,
    manifest: fallback.manifest,
  };
}

/** Read and authorize a durable result-door copy from the existing payload spool. */
export async function readDurableScratchReference(
  uri: string,
  caller: { workspaceId?: string | null; ownerId?: string | null; nowMs?: number },
  options: { spool?: GatewayPayloadSpool } = {},
): Promise<{ manifest: ScratchReferenceManifest; payload: Buffer }> {
  if (!isDurableScratchReferenceUri(uri)) {
    throw new ScratchReferenceError('invalid_reference', 'durable scratch reference URI is malformed');
  }
  const payloadRef = uri.slice(`${DURABLE_SCRATCH_REFERENCE_SCHEME}/`.length);
  const spool = options.spool ?? (await import('./inference-gateway/payload-spool')).createGatewayPayloadSpool();
  const framed = await spool.read(payloadRef);
  if (!framed) {
    throw new ScratchReferenceError('expired_reference', 'durable scratch reference expired or no longer resolves');
  }
  const parsed = parseScratchReference(framed);
  if (!parsed) {
    throw new ScratchReferenceError('invalid_reference', 'durable payload is not a scratch reference');
  }
  authorizeScratchReference(parsed.manifest, caller);
  return { manifest: parsed.manifest, payload: parsed.payload };
}

/** Read and authorize one temporary reference. The returned buffer is read-only by convention. */
export function readVolatileScratchReference(
  uri: string,
  caller: { workspaceId?: string | null; ownerId?: string | null; nowMs?: number },
): { manifest: ScratchReferenceManifest; payload: Buffer } {
  if (!isVolatileScratchReferenceUri(uri)) {
    throw new ScratchReferenceError('invalid_reference', 'volatile scratch reference URI is malformed');
  }
  const entry = volatileScratchState.entries.get(uri);
  if (!entry) {
    throw new ScratchReferenceError(
      'expired_reference',
      'in-memory scratch fallback is no longer available; it may have expired or been evicted',
    );
  }
  try {
    authorizeScratchReference(entry.manifest, caller);
  } catch (error) {
    if (error instanceof ScratchReferenceError && error.code === 'expired_reference') {
      deleteVolatileScratchReference(uri);
    }
    throw error;
  }
  // Map insertion order is the bounded cache's LRU order.
  volatileScratchState.entries.delete(uri);
  volatileScratchState.entries.set(uri, entry);
  return entry;
}

function pruneVolatileScratchReferences(nowMs: number): void {
  for (const [uri, entry] of volatileScratchState.entries) {
    if (nowMs >= Date.parse(entry.manifest.expiresAt)) deleteVolatileScratchReference(uri);
  }
}

function deleteVolatileScratchReference(uri: string): void {
  const entry = volatileScratchState.entries.get(uri);
  if (!entry) return;
  volatileScratchState.entries.delete(uri);
  volatileScratchState.bytes = Math.max(0, volatileScratchState.bytes - entry.payload.length);
}

/** Null means a legacy/non-reference scratch file. A matching magic prefix is
 * always parsed fail-closed: a corrupt reference must never fall back to raw. */
export function parseScratchReference(bytes: Buffer): ParsedScratchReference | null {
  const magic = Buffer.from(SCRATCH_REFERENCE_MAGIC, 'utf8');
  if (!bytes.subarray(0, magic.length).equals(magic)) return null;
  const manifestEnd = bytes.indexOf(0x0a, magic.length);
  if (manifestEnd < 0) {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest is unterminated');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.subarray(magic.length, manifestEnd).toString('utf8'));
  } catch {
    throw new ScratchReferenceError('invalid_reference', 'scratch reference manifest is not valid JSON');
  }
  const manifest = requireManifest(parsed);
  const payloadByteOffset = manifestEnd + 1;
  const payload = bytes.subarray(payloadByteOffset);
  if (payload.length !== manifest.byteCount) {
    throw new ScratchReferenceError(
      'integrity_mismatch',
      `scratch reference byte count mismatch: manifest=${manifest.byteCount}, actual=${payload.length}`,
    );
  }
  if (sha256(payload) !== manifest.sha256) {
    throw new ScratchReferenceError('integrity_mismatch', 'scratch reference SHA-256 mismatch');
  }
  return { manifest, payload, payloadByteOffset };
}

export function authorizeScratchReference(
  manifest: ScratchReferenceManifest,
  caller: { workspaceId?: string | null; ownerId?: string | null; nowMs?: number },
): void {
  const nowMs = caller.nowMs ?? Date.now();
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) {
    throw new ScratchReferenceError('expired_reference', `scratch reference expired at ${manifest.expiresAt}`);
  }
  if (!caller.workspaceId || caller.workspaceId !== manifest.workspaceId) {
    throw new ScratchReferenceError('workspace_mismatch', 'scratch reference belongs to a different workspace');
  }
  if (manifest.audience === 'owner' && caller.ownerId !== manifest.ownerId) {
    throw new ScratchReferenceError('forbidden_reference', 'scratch reference is restricted to its creating owner');
  }
}
