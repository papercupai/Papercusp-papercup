/** Fixed Node bridge for the future helper. Installation supplies trust and
 * credentials BEFORE connect. Tool/manifest/CLI/env fields cannot select them.
 * The Python production refusal remains until that installation adapter exists. */
import { createHash, randomBytes } from 'node:crypto';
import { connectAgentMcp } from '../../agent-mcp-client';
import { verifyAuthorityRpc } from '../../authority/authority-rpc-envelope';
import {
  decodeVmCopyRequest, VM_COPY_RESPONSE_KIND, VmCopyRefusal,
  vmCopySignedResponseSchema, type VmCopyHostScope, type VmCopyRequest,
} from './vm-copy-authority';

export interface InstalledVmCopyClient {
  url: string; bearer: string; devicePubkey: string; scope: VmCopyHostScope;
}
function refuse(code: string): never { throw new VmCopyRefusal(code); }

/** Scope is an installed host-owned identity, never a response's self-assertion.
 * Consume even failed responses, so a prior challenge cannot be tried twice. */
export function vmCopyResponseConsumer(request: VmCopyRequest, scope: VmCopyHostScope,
  pinnedDevicePubkey: string, clock = Date.now) {
  const { manifest } = decodeVmCopyRequest(request);
  let consumed = false;
  return (value: unknown) => {
    if (consumed) refuse('vm-copy-response-replay');
    consumed = true;
    const response = vmCopySignedResponseSchema.safeParse(value);
    if (!response.success) refuse('vm-copy-response-invalid');
    const { payload: p, auth } = response.data;
    const nowMs = clock();
    if (auth.device_pubkey !== pinnedDevicePubkey ||
      !verifyAuthorityRpc({ harnessSlug: scope.harnessSlug, kind: VM_COPY_RESPONSE_KIND, payload: p }, auth,
        { nowMs, windowMs: 5000 }) || auth.ts > nowMs) refuse('vm-copy-response-signature');
    if (p.phase !== request.phase || p.challenge !== request.challenge || p.operationId !== request.operationId ||
      p.manifestSha256 !== request.manifestSha256) refuse('vm-copy-response-request-mismatch');
    if (p.workspaceId !== scope.workspaceId || p.harnessSlug !== scope.harnessSlug || p.sessionId !== scope.sessionId ||
      p.appliedSpecificationRevision !== scope.appliedSpecificationRevision ||
      p.appliedStateRevision !== scope.appliedStateRevision || p.policyRevision !== scope.policyRevision)
      refuse('vm-copy-response-context-mismatch');
    const v = p.verdict;
    if (v.ownerId !== scope.ownerId || v.ownerId !== manifest.ownerId || v.manifestSha256 !== request.manifestSha256 ||
      v.leaseRef !== manifest.authority.leaseRef || v.capabilityRef !== manifest.authority.capabilityRef ||
      v.verifierRef !== p.acceptedOperationRef || v.notBefore > nowMs / 1000 ||
      v.expiresAt < Math.ceil(nowMs / 1000) + manifest.limits.leaseLifetimeSec ||
      new Set(p.custody.map(c => c.resource)).size !== p.custody.length ||
      p.custody.some(c => c.ownerId !== scope.ownerId || c.expiresAt < v.expiresAt))
      refuse('vm-copy-response-verdict-mismatch');
    return v; // Only the unchanged strict v1 verdict crosses to Python.
  };
}

function toolBody(result: unknown): unknown {
  const r = result as { isError?: boolean; content?: { type: string; text?: string }[] } | null;
  if (!r || r.isError || !Array.isArray(r.content) || r.content.length !== 1 ||
    r.content[0].type !== 'text' || typeof r.content[0].text !== 'string') refuse('vm-copy-transport-refused');
  try { return JSON.parse(r.content[0].text); } catch { return refuse('vm-copy-transport-invalid'); }
}

/** Internal composition seam, not exposed as a CLI or tool parameter. No retry,
 * alternate verifier, response hydration or unsigned fallback is permitted. */
export async function callVmCopyAuthorityFromInstallation(installation: InstalledVmCopyClient,
  manifestRaw: Buffer, phase: VmCopyRequest['phase']) {
  const { scope } = installation;
  let target: URL;
  try { target = new URL(installation.url); } catch { return refuse('vm-copy-installed-target-invalid'); }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password ||
    target.pathname !== '/api/mcp' || target.search || target.hash || !installation.bearer ||
    !/^[A-Za-z0-9+/]{43}=$/.test(installation.devicePubkey)) refuse('vm-copy-installed-target-invalid');
  // Fail before sending credentials, even with an invalid local installation.
  if (!Object.values(scope).every(v => typeof v === 'string' && v.length > 0)) refuse('vm-copy-installed-scope-invalid');
  let operationId: unknown;
  try { operationId = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestRaw)).operationId; }
  catch { return refuse('vm-copy-manifest-invalid'); }
  const request = decodeVmCopyRequest({ schemaVersion: 1, phase, challenge: randomBytes(32).toString('hex'),
    operationId, manifestRawBase64: manifestRaw.toString('base64'),
    manifestSha256: createHash('sha256').update(manifestRaw).digest('hex') }).request;
  const consume = vmCopyResponseConsumer(request, scope, installation.devicePubkey);
  for (const [key, value] of Object.entries({ superuser: '1', workspace: scope.workspaceId,
    harness: scope.harnessSlug, client: scope.ownerId, format: 'json', structured: '1' })) target.searchParams.set(key, value);
  const { client } = await connectAgentMcp({ url: target.href, mode: 'http', timeoutMs: 15000,
    headers: { Authorization: `Bearer ${installation.bearer}` }, name: 'papercusp-vm-copy-authority' });
  try {
    await client.listTools();
    const who = toolBody(await client.callTool({ name: 'coord:whoami', arguments: {} })) as Record<string, unknown> | null;
    if (!who || who.ownerId !== scope.ownerId || who.workspaceId !== scope.workspaceId)
      refuse('vm-copy-authenticated-session-mismatch');
    return consume(toolBody(await client.callTool({ name: 'capability:inspect', arguments: {
      check: 'vm-copy-authority', request,
    } })));
  } finally { await client.close(); }
}

/** Fixed production entry has NO installation/key/URL/verdict override. The
 * missing trusted installed-map adapter is an explicit D265 execution hold. */
export async function verifyVmCopyFromInstalledHost(_manifestRaw: Buffer, _phase: VmCopyRequest['phase']): Promise<never> {
  throw new VmCopyRefusal('vm-copy-installed-host-binding-unavailable');
}
