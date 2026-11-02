/** Host-only pre-execution gate. No tool arguments may supply ctx, a signing key,
 * actor, timestamp or event ordinal. The transport supplies ctx; the host owns
 * the runner callback. This is qualification custody, NOT handler confinement.
 * Reuses canonical identity/lineage, operator signing key and text artifacts.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import { getOrgPg } from '@papercusp/db-org';
import type { UnifiedToolContext } from '@papercusp/tooldef';
import { z } from 'zod';
import { areAcceptanceLineageRelated } from '../acceptance-author-identity';
import { resolveAgentIdentity, isTransportOnlyIdentity } from '../agent-tools/coordination/identity';
import { decodeOperatorSecretKey } from '../operator-secret-key';
import { activeWorkspaceId } from '../workspace-registry';
import { claimImmutableTextArtifact, loadImmutableTextArtifact, loadImmutableTextArtifactClaim,
  saveImmutableTextArtifact } from '../text-artifacts';
import { loadSecurityManifest, loadSecurityTupleLedger, saveSecurityManifest, saveSecurityTupleLedger } from './security-manifest-store';
import { createSecurityManifest, createSecurityTupleLedger, type SecurityManifest,
  type SecurityTuple, type SecurityTupleDisposition } from './security-manifest';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1);
const eventSchema = z.object({
  version: z.literal(1), domain: z.literal('security-qualification'),
  workspaceId: text, harness: text, eventId: z.string().uuid(),
  at: z.number().int().nonnegative(), actor: text,
  phase: z.enum(['manifest', 'ledger', 'approval', 'start', 'result']),
  ordinal: z.number().int().nonnegative(), parent: hash.nullable(),
  manifestSha256: hash, ledgerSha256: hash.nullable(),
  manifestProducerRef: hash.nullable(), ledgerProducerRef: hash.nullable(),
  executor: text.nullable(), reviewRef: text.nullable(),
  result: z.enum(['passed', 'failed']).nullable(),
  executionEvidenceSha256: hash.optional(),
}).strict();
type Event = z.infer<typeof eventSchema>;
const signedSchema = z.object({ event: eventSchema, signature: hash }).strict();
type Signed = z.infer<typeof signedSchema>;

// Discovery custody is distinct from a reconciled manifest or approval. It
// retains unknown/unavailable populations, and cannot enter the runner chain.
const discoveryReceiptSchema = z.object({
  version: z.literal(1), domain: z.literal('security-runtime-discovery'),
  workspaceId: text, harness: text, eventId: z.string().uuid(),
  at: z.number().int().nonnegative(), actor: text,
  snapshotSha256: hash, discoverySha256: hash,
  populationComplete: z.literal(false), closureAccepted: z.literal(false), executionAdmitted: z.literal(false),
}).strict();
const signedDiscoverySchema = z.object({ receipt: discoveryReceiptSchema, signature: hash }).strict();
const discoveryMac = (receipt: z.infer<typeof discoveryReceiptSchema>, secret: Buffer) =>
  createHmac('sha256', secret).update(canonicalJson(['security-runtime-discovery-v1', receipt])).digest('hex');

function refuse(reason: string): never { throw new Error(`security_qualification_${reason}`); }
function actor(ctx: UnifiedToolContext, harness: string): string {
  const identity = resolveAgentIdentity(ctx), principal = ctx.principal;
  if (!principal || !['trusted', 'verified'].includes(principal.trust ?? '') ||
      !['bearer-token', 'spawn-url', 'cookie-session', 'jwt'].includes(principal.authMethod ?? '') ||
      identity.workspaceId !== activeWorkspaceId() || principal.workspaceId !== identity.workspaceId ||
      isTransportOnlyIdentity(identity.ownerId) ||
      ctx.harnessSlug && ctx.harnessSlug !== harness) refuse('authenticated_actor_required');
  return identity.ownerId;
}
async function key(): Promise<Buffer> {
  const [row] = await getOrgPg().sql<{ value_b64: string }[]>`
    SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key' LIMIT 1`;
  if (!row) refuse('host_key_unavailable');
  return decodeOperatorSecretKey(row.value_b64, 'spawn-signing-key');
}
const mac = (event: Event, secret: Buffer) => createHmac('sha256', secret)
  .update(canonicalJson(['security-qualification-v1', event])).digest('hex');
async function persist(event: Event): Promise<string> {
  const validated = eventSchema.parse(event);
  const receipt: Signed = { event: validated, signature: mac(validated, await key()) };
  return (await saveImmutableTextArtifact(event.harness, canonicalJson(receipt))).sha256;
}
async function read(harness: string, ref: string): Promise<Event> {
  const bytes = await loadImmutableTextArtifact(harness, hash.parse(ref));
  if (bytes === null) refuse('commitment_missing');
  const signed = signedSchema.parse(JSON.parse(bytes)), expected = mac(signed.event, await key());
  if (canonicalJson(signed) !== bytes || !timingSafeEqual(Buffer.from(signed.signature, 'hex'), Buffer.from(expected, 'hex'))) {
    refuse('host_signature_invalid');
  }
  if (signed.event.workspaceId !== activeWorkspaceId() || signed.event.harness !== harness || signed.event.at > Date.now()) {
    refuse('scope_or_order_mismatch');
  }
  return signed.event;
}
function event(harness: string, actorId: string, phase: Event['phase'],
  values: Partial<Event> & Pick<Event, 'manifestSha256'>): Event {
  return { version: 1, domain: 'security-qualification', workspaceId: activeWorkspaceId(), harness,
    eventId: randomUUID(), at: Date.now(), actor: actorId, phase, ordinal: 0, parent: null,
    ledgerSha256: null, manifestProducerRef: null, ledgerProducerRef: null,
    executor: null, reviewRef: null, result: null, ...values };
}

/** No caller-supplied population, producer, time or loaded-artifact pin. Capture
 * all rows directly from the serving host, before applying any result paging. */
export async function captureAuthenticatedRuntimeSecurityCensus(ctx: UnifiedToolContext, harness: string) {
  const producer = actor(ctx, text.parse(harness));
  const secret = await key();
  const { captureRuntimeSecurityCensus } = await import('../observability/runtime');
  const snapshot = await captureRuntimeSecurityCensus();
  const stored = await saveImmutableTextArtifact(harness, canonicalJson(snapshot));
  const receipt = discoveryReceiptSchema.parse({ version: 1, domain: 'security-runtime-discovery',
    workspaceId: activeWorkspaceId(), harness, eventId: randomUUID(), at: Date.now(), actor: producer,
    snapshotSha256: stored.sha256, discoverySha256: snapshot.discoverySha256,
    populationComplete: false, closureAccepted: false, executionAdmitted: false });
  const signed = { receipt, signature: discoveryMac(receipt, secret) };
  const receiptRef = (await saveImmutableTextArtifact(harness, canonicalJson(signed))).sha256;
  await verifyAuthenticatedRuntimeSecurityCensus(harness, { receiptRef, snapshotRef: stored.sha256 });
  return { snapshotRef: stored.sha256, receiptRef, discoverySha256: snapshot.discoverySha256,
    producer, status: snapshot.status, total: snapshot.total, runtimeIdentity: snapshot.runtimeIdentity,
    readbackVerified: true as const,
    populationComplete: false as const, closureAccepted: false as const, executionAdmitted: false as const };
}

/** Readback verifies authenticated custody only, never population closure. */
export async function verifyAuthenticatedRuntimeSecurityCensus(harness: string, input: {
  receiptRef: string; snapshotRef: string;
}) {
  const bytes = await loadImmutableTextArtifact(harness, hash.parse(input.receiptRef));
  if (bytes === null) refuse('discovery_receipt_missing');
  const signed = signedDiscoverySchema.parse(JSON.parse(bytes));
  const expected = discoveryMac(signed.receipt, await key());
  if (canonicalJson(signed) !== bytes || !timingSafeEqual(Buffer.from(signed.signature, 'hex'), Buffer.from(expected, 'hex'))) {
    refuse('host_signature_invalid');
  }
  const receipt = signed.receipt;
  if (receipt.harness !== harness || receipt.workspaceId !== activeWorkspaceId() || receipt.at > Date.now()) {
    refuse('scope_or_order_mismatch');
  }
  if (receipt.snapshotSha256 !== hash.parse(input.snapshotRef)) refuse('discovery_pin_substitution');
  const snapshotBytes = await loadImmutableTextArtifact(harness, receipt.snapshotSha256);
  if (snapshotBytes === null) refuse('discovery_snapshot_missing');
  const snapshot = JSON.parse(snapshotBytes) as Awaited<ReturnType<typeof import('../observability/runtime').captureRuntimeSecurityCensus>>;
  const discoverySha256 = createHash('sha256').update(canonicalJson({ runtimeIdentity: snapshot.runtimeIdentity,
    hostCaptureSha256: snapshot.hostCaptureSha256, rows: snapshot.rows, unresolved: snapshot.unresolved })).digest('hex');
  if (canonicalJson(snapshot) !== snapshotBytes || createHash('sha256').update(snapshotBytes).digest('hex') !== receipt.snapshotSha256 ||
      discoverySha256 !== receipt.discoverySha256 || snapshot.discoverySha256 !== discoverySha256 ||
      snapshot.total !== snapshot.rows.length || snapshot.count !== snapshot.total || snapshot.offset !== 0 ||
      snapshot.truncatedByLimit !== false || snapshot.populationComplete !== false ||
      snapshot.closureAccepted !== false || snapshot.executionAdmitted !== false) refuse('discovery_snapshot_mismatch');
  return { receipt, snapshot };
}

/** Producer identity comes only from authenticated transport, never manifest input. */
export async function captureAuthenticatedSecurityManifest(ctx: UnifiedToolContext, harness: string,
  input: Omit<SecurityManifest, 'schemaVersion' | 'producer'>) {
  const producer = actor(ctx, harness), manifest = createSecurityManifest({ ...input, producer });
  await saveSecurityManifest(harness, manifest);
  const producerRef = await persist(event(harness, producer, 'manifest', { manifestSha256: manifest.sha256 }));
  return { manifest, producerRef };
}
export async function prepareAuthenticatedSecurityLedger(ctx: UnifiedToolContext, harness: string, input: {
  manifestSha256: string; tuples: readonly SecurityTuple[]; dispositions: readonly SecurityTupleDisposition[];
}) {
  const producer = actor(ctx, harness), manifest = await loadSecurityManifest(harness, input.manifestSha256);
  if (!manifest) refuse('manifest_missing');
  const ledger = createSecurityTupleLedger({ ...input, manifest, producer });
  await saveSecurityTupleLedger(harness, ledger);
  const producerRef = await persist(event(harness, producer, 'ledger', {
    manifestSha256: manifest.sha256, ledgerSha256: ledger.sha256,
  }));
  return { ledger, producerRef };
}

export interface SecurityReviewRequest {
  manifestSha256: string; ledgerSha256: string;
  manifestProducerRef: string; ledgerProducerRef: string; executor: string;
  /** Addressable independent review of the exact population/applicability sources. */
  reviewRef: string;
}
const reviewRequestSchema = z.object({ manifestSha256: hash, ledgerSha256: hash,
  manifestProducerRef: hash, ledgerProducerRef: hash, executor: text, reviewRef: text }).strict();
async function subject(harness: string, request: SecurityReviewRequest) {
  const manifest = await loadSecurityManifest(harness, request.manifestSha256);
  const ledger = await loadSecurityTupleLedger(harness, request.ledgerSha256);
  if (!manifest || !ledger || ledger.body.manifestSha256 !== manifest.sha256) refuse('manifest_ledger_drift');
  const mp = await read(harness, request.manifestProducerRef), lp = await read(harness, request.ledgerProducerRef);
  if (mp.phase !== 'manifest' || lp.phase !== 'ledger' || mp.ordinal !== 0 || lp.ordinal !== 0 ||
      mp.parent !== null || lp.parent !== null || mp.actor !== manifest.body.producer || lp.actor !== ledger.body.producer ||
      mp.manifestSha256 !== manifest.sha256 || lp.manifestSha256 !== manifest.sha256 || lp.ledgerSha256 !== ledger.sha256) {
    refuse('producer_receipt_mismatch');
  }
  return { manifest, ledger, producers: [mp.actor, lp.actor], producedAt: Math.max(mp.at, lp.at) };
}
async function independent(reviewer: string, producers: readonly string[], executor: string) {
  text.parse(executor);
  for (const other of new Set([...producers, executor])) {
    if (reviewer === other || await areAcceptanceLineageRelated(reviewer, other, { workspaceId: activeWorkspaceId() })) {
      refuse('reviewer_not_independent');
    }
  }
}

/** Only the independently authenticated reviewer can commit. No time/identity overrides. */
export async function commitSecurityApplicability(ctx: UnifiedToolContext, harness: string, request: SecurityReviewRequest) {
  request = reviewRequestSchema.parse(request);
  const reviewer = actor(ctx, harness), current = await subject(harness, request);
  text.parse(request.reviewRef);
  await independent(reviewer, current.producers, request.executor);
  const approval = event(harness, reviewer, 'approval', { ...request, ordinal: 1 });
  if (approval.at < current.producedAt) refuse('scope_or_order_mismatch');
  // Changing applicability after a probe/result is never a fresh review of the
  // old population. A genuine source/runtime/population change needs a NEW
  // manifest and ledger, a fresh review, then new qualification evidence.
  await claimImmutableTextArtifact(harness, `security-qualification:ledger:${request.manifestSha256}`, request.ledgerSha256);
  return { approvalRef: await persist(approval), manifestSha256: request.manifestSha256, ledgerSha256: request.ledgerSha256 };
}

/** The only qualification runner entry. Receipt persistence and permanent claim
 * finish BEFORE any callback executes. Concurrent/replayed starts fail closed.
 * A failed/uncertain run requires a fresh independent commitment and fresh run;
 * results always reference their exact frozen revision, including at P-020.
 */
export async function runSecurityQualification<T>(ctx: UnifiedToolContext, harness: string, input: {
  approvalRef: string; manifestSha256: string; ledgerSha256: string;
}, execute: (pins: { manifestSha256: string; ledgerSha256: string; startRef: string }) => Promise<T>,
captureResult?: (value: T) => unknown) {
  input = z.object({ approvalRef: hash, manifestSha256: hash, ledgerSha256: hash }).strict().parse(input);
  const executor = actor(ctx, harness), approval = await read(harness, input.approvalRef);
  if (approval.phase !== 'approval' || approval.ordinal !== 1 || approval.parent !== null || approval.result !== null ||
      approval.manifestSha256 !== input.manifestSha256 || approval.ledgerSha256 !== input.ledgerSha256 ||
      approval.executor !== executor || !approval.manifestProducerRef || !approval.ledgerProducerRef || !approval.reviewRef) {
    refuse('approval_mismatch');
  }
  const current = await subject(harness, { ...input, manifestProducerRef: approval.manifestProducerRef,
    ledgerProducerRef: approval.ledgerProducerRef, executor, reviewRef: approval.reviewRef });
  await independent(approval.actor, current.producers, executor);
  if (await loadImmutableTextArtifactClaim(harness, `security-qualification:ledger:${input.manifestSha256}`) !== input.ledgerSha256) {
    refuse('frozen_disposition_mismatch');
  }
  if (await loadImmutableTextArtifactClaim(harness, `security-qualification:start:${input.approvalRef}`) !== null) {
    refuse('execution_already_consumed');
  }
  const start = event(harness, executor, 'start', {
    manifestSha256: input.manifestSha256, ledgerSha256: input.ledgerSha256, ordinal: 2, parent: input.approvalRef,
    manifestProducerRef: approval.manifestProducerRef, ledgerProducerRef: approval.ledgerProducerRef, executor,
    reviewRef: approval.reviewRef });
  if (start.at < approval.at || approval.at < current.producedAt) refuse('scope_or_order_mismatch');
  const startRef = await persist(start);
  if (!await claimImmutableTextArtifact(harness, `security-qualification:start:${input.approvalRef}`, startRef)) {
    refuse('execution_already_consumed');
  }
  const pins = Object.freeze({ manifestSha256: input.manifestSha256, ledgerSha256: input.ledgerSha256, startRef });
  let value: T;
  try { value = await execute(pins); }
  catch (error) {
    await persist(event(harness, executor, 'result', {
      manifestSha256: pins.manifestSha256, ledgerSha256: pins.ledgerSha256,
      ordinal: 3, parent: startRef, executor, result: 'failed' }));
    throw error;
  }
  const executionEvidenceSha256 = captureResult
    ? (await saveImmutableTextArtifact(harness, canonicalJson(captureResult(value)))).sha256 : undefined;
  const resultRef = await persist(event(harness, executor, 'result', {
    manifestSha256: pins.manifestSha256, ledgerSha256: pins.ledgerSha256, ordinal: 3, parent: startRef,
    executor, result: 'passed',
    ...(executionEvidenceSha256 ? { executionEvidenceSha256 } : {}),
  }));
  return { value, resultRef, approvalRef: input.approvalRef, ...pins,
    ...(executionEvidenceSha256 ? { executionEvidenceSha256 } : {}) };
}

/** Acceptance/P-020 reads the SAME immutable chain and row identities. This
 * verifies custody only; a passed callback is not itself a security verdict.
 */
export async function verifySecurityQualificationResult(harness: string, input: {
  resultRef: string; manifestSha256: string; ledgerSha256: string;
}) {
  const result = await read(harness, input.resultRef);
  if (result.phase !== 'result' || result.ordinal !== 3 || result.result !== 'passed' || !result.parent) refuse('result_mismatch');
  const start = await read(harness, result.parent);
  if (start.phase !== 'start' || start.ordinal !== 2 || !start.parent || start.result !== null) refuse('start_mismatch');
  const approval = await read(harness, start.parent);
  if (approval.phase !== 'approval' || approval.ordinal !== 1 || approval.parent !== null || approval.result !== null ||
      !approval.manifestProducerRef || !approval.ledgerProducerRef || !approval.executor || !approval.reviewRef) refuse('approval_mismatch');
  for (const record of [result, start, approval]) {
    if (record.manifestSha256 !== input.manifestSha256 || record.ledgerSha256 !== input.ledgerSha256 ||
        record.executor !== approval.executor) refuse('result_pin_substitution');
  }
  if (result.actor !== approval.executor || start.actor !== approval.executor ||
      approval.at > start.at || start.at > result.at ||
      await loadImmutableTextArtifactClaim(harness, `security-qualification:start:${start.parent}`) !== result.parent ||
      await loadImmutableTextArtifactClaim(harness, `security-qualification:ledger:${input.manifestSha256}`) !== input.ledgerSha256) {
    refuse('scope_or_order_mismatch');
  }
  const current = await subject(harness, { manifestSha256: input.manifestSha256, ledgerSha256: input.ledgerSha256,
    manifestProducerRef: approval.manifestProducerRef, ledgerProducerRef: approval.ledgerProducerRef,
    executor: approval.executor, reviewRef: approval.reviewRef });
  if (approval.at < current.producedAt) refuse('scope_or_order_mismatch');
  await independent(approval.actor, current.producers, approval.executor);
  let executionEvidence: unknown;
  if (result.executionEvidenceSha256) {
    const bytes = await loadImmutableTextArtifact(harness, result.executionEvidenceSha256);
    if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== result.executionEvidenceSha256) {
      refuse('execution_evidence_mismatch');
    }
    executionEvidence = JSON.parse(bytes);
    if (canonicalJson(executionEvidence) !== bytes) refuse('execution_evidence_mismatch');
  }
  return { manifest: current.manifest, ledger: current.ledger, approvalRef: start.parent, startRef: result.parent,
    executionEvidenceSha256: result.executionEvidenceSha256, executionEvidence };
}
