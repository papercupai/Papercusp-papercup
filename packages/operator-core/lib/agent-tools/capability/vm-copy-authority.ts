/** D265 source-only boundary. These ports are host code, never tool arguments.
 * No policy/lease writer, shell, image IO, or caller-supplied verdict lives here. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { KernelEnforcementResult } from '@papercusp/tooldef';
import type { ActiveOperationWorkerClaimRead } from '../../blueprint/operation-worker-binding';
import type { ResourceQueueResult } from '@papercusp/locks';
import { signAuthorityRpc, type AuthorityRpcAuth } from '../../authority/authority-rpc-envelope';

export const VM_COPY_SCOPE = 'vmctl:prepare-diagnostic-copy';
export const VM_COPY_RESPONSE_KIND = 'capability:inspect/vm-copy-authority/response-v1';
// Identity/reference bytes are compared exactly; validation must not normalize them.
const text = z.string().min(1).max(4096).refine(value => value.trim().length > 0);
const integer = z.number().int().safe().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const lifetime = z.object({ bootId: text, pid: integer, startTicks: integer }).strict();
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const operationId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

export const vmCopyRequestSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(['preflight', 'prepublish']),
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
  operationId,
  manifestRawBase64: z.string().min(4).max(87384),
  manifestSha256: digest,
}).strict();
export const vmCopyInspectSchema = z.object({
  check: z.literal('vm-copy-authority'), request: vmCopyRequestSchema,
}).strict();
export type VmCopyRequest = z.infer<typeof vmCopyRequestSchema>;

// Matches the helper's v1 keys. Filesystem/image identity and capacity remain
// independently checked by the helper; parsing this manifest does no image IO.
export const vmCopyManifestSchema = z.object({
  schemaVersion: z.literal(1), operationId, ownerId: text,
  source: z.object({ name, chain: z.array(z.object({
    path: text, dev: z.number().int().safe().nonnegative(), ino: integer, size: integer,
    sha256: digest, format: z.enum(['qcow2', 'raw']), virtualSize: integer,
  }).strict()).min(1).max(32), stopped: lifetime }).strict(),
  destination: z.object({ name, path: text }).strict(),
  evidenceDir: text, lineage: z.array(text).min(1).max(32), retentionUntil: integer,
  authority: z.object({ leaseRef: text, capabilityRef: text }).strict(),
  limits: z.object({
    copyBytes: integer, guestWriteBytes: z.number().int().safe().nonnegative(),
    evidenceBytes: integer.min(65536), rollbackBytes: z.number().int().safe().nonnegative(),
    retainedBytes: z.number().int().safe().nonnegative(), timeoutSec: integer.max(3600),
    leaseLifetimeSec: integer,
  }).strict(),
}).strict();
export type VmCopyManifest = z.infer<typeof vmCopyManifestSchema>;

export const vmCopyVerdictSchema = z.object({
  schemaVersion: z.literal(1), decision: z.literal('allow'), verifierRef: text,
  manifestSha256: digest, ownerId: text, scope: z.literal(VM_COPY_SCOPE),
  leaseRef: text, capabilityRef: text, leaseOwner: lifetime,
  notBefore: z.number().int().safe().nonnegative(), expiresAt: integer,
}).strict();
const custodyPinSchema = z.object({
  resource: text, coordinationDomain: text, lockId: text, ownerId: text,
  fenceSeq: integer,
}).strict();
export const vmCopyCustodySchema = custodyPinSchema.extend({
  mode: z.literal('exclusive'), status: z.literal('held'), expiresAt: integer,
}).strict();
export const vmCopyPayloadSchema = z.object({
  schemaVersion: z.literal(1), phase: vmCopyRequestSchema.shape.phase,
  challenge: vmCopyRequestSchema.shape.challenge, operationId, manifestSha256: digest,
  workspaceId: text, harnessSlug: text, sessionId: text,
  appliedSpecificationRevision: digest, appliedStateRevision: text, policyRevision: text,
  acceptedOperationRef: text, custody: z.array(vmCopyCustodySchema).min(1).max(32),
  verdict: vmCopyVerdictSchema,
}).strict();
const authSchema = z.object({
  device_pubkey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  ts: z.number().int().safe().nonnegative(), nonce: text, sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export const vmCopySignedResponseSchema = z.object({
  payload: vmCopyPayloadSchema, auth: authSchema,
}).strict();
export type VmCopyPayload = z.infer<typeof vmCopyPayloadSchema>;
export type VmCopySignedResponse = { payload: VmCopyPayload; auth: AuthorityRpcAuth };

// Immutable accepted-operation INPUT, not a receipt the caller may submit.
const acceptedInputSchema = z.object({
  scope: z.literal(VM_COPY_SCOPE), operationId, manifestRawBase64: z.string().min(4).max(87384),
  manifestSha256: digest, capabilityRef: text, leaseRef: text,
  custody: z.array(custodyPinSchema).min(1).max(32),
  executionTools: z.array(text).min(1).max(32),
  executionOwner: lifetime,
}).strict();

export interface VmCopyHostScope {
  workspaceId: string; harnessSlug: string; sessionId: string; ownerId: string;
  appliedSpecificationRevision: string; appliedStateRevision: string; policyRevision: string;
}
export interface VmCopyHost {
  scope: VmCopyHostScope;
  devicePubkey: string;
  sign(bytes: Buffer): Promise<Buffer>;
  /** Strict current revocation for BOTH authenticated session and host device. */
  standing(): Promise<'current' | 'revoked' | 'unavailable'>;
  worker(): Promise<ActiveOperationWorkerClaimRead>;
  /** Current provider + applied/current ceiling, using canonical kernel. */
  kernel(toolName: string): Promise<KernelEnforcementResult | null | undefined>;
  /** Current applied grant/provider reference, resolved alongside current policy. */
  capabilityRef(): Promise<string | null>;
  /** Canonical registry mapping for BOTH source + destination, never caller domain. */
  resources(manifest: VmCopyManifest): Promise<z.infer<typeof custodyPinSchema>[] | null>;
  queue(pin: z.infer<typeof custodyPinSchema>): Promise<ResourceQueueResult>;
  /** Execution-host session incarnation; null if unmeasurable or not alive. */
  process(ownerId: string, sessionId: string): Promise<z.infer<typeof lifetime> | null>;
}

export class VmCopyRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}
function requireCopy(value: unknown, code: string): asserts value {
  if (!value) throw new VmCopyRefusal(code);
}
function same(a: unknown, b: unknown): boolean { return isDeepStrictEqual(a, b); }
export function decodeVmCopyRequest(value: unknown): { request: VmCopyRequest; manifest: VmCopyManifest } {
  const parsed = vmCopyRequestSchema.safeParse(value);
  requireCopy(parsed.success, 'vm-copy-request-invalid');
  const request = parsed.data;
  const raw = Buffer.from(request.manifestRawBase64, 'base64');
  requireCopy(raw.length <= 65536 && raw.toString('base64') === request.manifestRawBase64,
    'vm-copy-manifest-encoding');
  requireCopy(createHash('sha256').update(raw).digest('hex') === request.manifestSha256,
    'vm-copy-manifest-digest');
  // Fatal UTF8 avoids authorizing a replacement-character interpretation of bytes.
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new VmCopyRefusal('vm-copy-manifest-invalid'); }
  const manifest = vmCopyManifestSchema.safeParse(decoded);
  requireCopy(manifest.success, 'vm-copy-manifest-invalid');
  requireCopy(manifest.data.operationId === request.operationId, 'vm-copy-operation-mismatch');
  requireCopy(manifest.data.source.name !== manifest.data.destination.name &&
    manifest.data.limits.leaseLifetimeSec >= manifest.data.limits.timeoutSec + 30,
  'vm-copy-manifest-budget');
  return { request, manifest: manifest.data };
}

function governed(result: KernelEnforcementResult | null | undefined, scope: VmCopyHostScope): boolean {
  const stamp = result?.serverAudit?.identityLaunchRecord as { advSessionId?: unknown; xmin?: unknown } | undefined;
  return Boolean(result?.decision === 'allow' && result.availability === 'available' && result.applied === true &&
    result.revisionSource === 'applied' && result.policyRevision === scope.policyRevision &&
    result.executionRevision?.specificationRevision === scope.appliedSpecificationRevision &&
    result.executionRevision.stateRevision === scope.appliedStateRevision &&
    stamp?.advSessionId === scope.sessionId && typeof stamp.xmin === 'string' && stamp.xmin.length > 0);
}

/** One request = fresh authoritative reads. Prepublish never reuses preflight evidence. */
export async function evaluateVmCopyAuthority(value: unknown, host: VmCopyHost, nowMs = Date.now()): Promise<VmCopySignedResponse> {
  const { request, manifest } = decodeVmCopyRequest(value);
  const s = host.scope;
  requireCopy(Object.values(s).every(v => typeof v === 'string' && v.length > 0) &&
    digest.safeParse(s.appliedSpecificationRevision).success, 'vm-copy-host-scope-unavailable');
  requireCopy(manifest.ownerId === s.ownerId, 'vm-copy-owner-mismatch');
  requireCopy(await host.standing() === 'current', 'vm-copy-revocation-unavailable-or-revoked');
  const worker = await host.worker();
  requireCopy(worker.status === 'bound', 'vm-copy-accepted-operation-unavailable');
  const { binding, receipt } = worker;
  requireCopy(receipt.workspaceId === s.workspaceId && receipt.ownerId === s.ownerId &&
    String(receipt.sessionId) === s.sessionId && binding.harnessSlug === s.harnessSlug &&
    receipt.specificationRevision === s.appliedSpecificationRevision && receipt.stateRevision === s.appliedStateRevision &&
    binding.specificationRevision === s.appliedSpecificationRevision &&
    binding.operationId === VM_COPY_SCOPE && binding.pin.kind === 'blueprint-operation' &&
    binding.pin.operationId === VM_COPY_SCOPE && binding.pin.harnessSlug === s.harnessSlug &&
    binding.pin.specificationRevision === s.appliedSpecificationRevision && Boolean(binding.workItemId),
  'vm-copy-worker-binding-mismatch');
  const parsedInput = acceptedInputSchema.safeParse(binding.pin.input);
  requireCopy(parsedInput.success, 'vm-copy-accepted-input-invalid');
  const input = parsedInput.data;
  requireCopy(input.operationId === request.operationId && input.manifestRawBase64 === request.manifestRawBase64 &&
    input.manifestSha256 === request.manifestSha256 && input.capabilityRef === manifest.authority.capabilityRef &&
    input.leaseRef === manifest.authority.leaseRef, 'vm-copy-accepted-input-mismatch');
  requireCopy(input.executionTools.every(t => t !== 'capability:inspect' && binding.requiredTools.includes(t)) &&
    binding.requiredTools.includes('capability:inspect') && new Set(input.executionTools).size === input.executionTools.length,
  'vm-copy-execution-tools-mismatch');
  for (const tool of ['capability:inspect', ...input.executionTools]) {
    requireCopy(governed(await host.kernel(tool), s), 'vm-copy-applied-provider-denied');
  }
  requireCopy(await host.capabilityRef() === input.capabilityRef, 'vm-copy-capability-binding-mismatch');
  const resources = await host.resources(manifest);
  requireCopy(resources && same(resources, input.custody) &&
    new Set(resources.map(r => r.resource)).size === resources.length &&
    resources.every(r => r.ownerId === s.ownerId), 'vm-copy-resource-mapping-unavailable-or-mismatch');
  const now = Math.ceil(nowMs / 1000);
  const minimumExpiry = now + manifest.limits.leaseLifetimeSec;
  requireCopy(manifest.retentionUntil >= minimumExpiry, 'vm-copy-retention-expired');
  const custody: VmCopyPayload['custody'] = [];
  for (const pin of resources) {
    const parsedPin = custodyPinSchema.safeParse(pin);
    requireCopy(parsedPin.success, 'vm-copy-resource-pin-invalid');
    const queue = await host.queue(pin);
    // An exclusive must be the sole live holder; a queue cannot stand in for a lease.
    const holder = queue.holders[0];
    requireCopy(!queue.draining && queue.holders.length === 1 && holder && holder.resource === pin.resource &&
      holder.owner === pin.ownerId && holder.lock_id === pin.lockId && holder.fence_seq === pin.fenceSeq &&
      holder.mode === 'exclusive' && holder.status === 'held' &&
      Number.isFinite(holder.expires_ts.getTime()) && holder.expires_ts.getTime() / 1000 >= minimumExpiry,
    'vm-copy-custody-stale-or-unavailable');
    custody.push({ ...pin, mode: 'exclusive', status: 'held', expiresAt: Math.floor(holder.expires_ts.getTime() / 1000) });
  }
  const owner = lifetime.safeParse(await host.process(s.ownerId, s.sessionId));
  requireCopy(owner.success && same(owner.data, input.executionOwner), 'vm-copy-execution-owner-unavailable');
  const payload: VmCopyPayload = {
    schemaVersion: 1, phase: request.phase, challenge: request.challenge, operationId: request.operationId,
    manifestSha256: request.manifestSha256, workspaceId: s.workspaceId, harnessSlug: s.harnessSlug, sessionId: s.sessionId,
    appliedSpecificationRevision: s.appliedSpecificationRevision, appliedStateRevision: s.appliedStateRevision,
    policyRevision: s.policyRevision, acceptedOperationRef: binding.workItemId, custody,
    verdict: { schemaVersion: 1, decision: 'allow', verifierRef: binding.workItemId,
      manifestSha256: request.manifestSha256, ownerId: s.ownerId, scope: VM_COPY_SCOPE,
      leaseRef: input.leaseRef, capabilityRef: input.capabilityRef, leaseOwner: owner.data,
      notBefore: Math.floor(nowMs / 1000), expiresAt: Math.min(...custody.map(c => c.expiresAt)) },
  };
  vmCopyPayloadSchema.parse(payload);
  requireCopy(await host.standing() === 'current', 'vm-copy-revocation-unavailable-or-revoked');
  const auth = await signAuthorityRpc({ harnessSlug: s.harnessSlug, kind: VM_COPY_RESPONSE_KIND,
    payload, device_pubkey: host.devicePubkey }, host.sign, { nowMs });
  return vmCopySignedResponseSchema.parse({ payload, auth });
}

/** Production stays closed: no installed client -> host/key/resource/process
 * adapter has been independently qualified. There is intentionally no setter,
 * environment override, URL/key/receipt argument or fallback to an SU allow. */
export async function inspectVmCopyAuthority(request: unknown, ctx: { principal?: unknown }): Promise<never> {
  decodeVmCopyRequest(request);
  requireCopy(ctx.principal, 'vm-copy-authenticated-session-required');
  throw new VmCopyRefusal('vm-copy-installed-host-binding-unavailable');
}
