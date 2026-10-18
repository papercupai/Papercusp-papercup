import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import { signAuthorityRpc } from '../../authority/authority-rpc-envelope';
import {
  decodeVmCopyRequest, evaluateVmCopyAuthority, inspectVmCopyAuthority, VM_COPY_RESPONSE_KIND,
  vmCopyInspectSchema, vmCopyVerdictSchema,
} from './vm-copy-authority';
import { vmCopyResponseConsumer, verifyVmCopyFromInstalledHost } from './vm-copy-authority-bridge';
import { fixture, NOW } from './__fixtures__/vm-copy-authority';

describe('vm-copy strict source authority', () => {
  it('keeps wall-clock fixtures valid between second boundaries', () => {
    expect(() => decodeVmCopyRequest(fixture(NOW + 123).request)).not.toThrow();
  });
  it('signs a fully bound fake host and emits exactly the existing helper verdict', async () => {
    const f = fixture();
    const response = await evaluateVmCopyAuthority(f.request, f.host, NOW);
    const verdict = vmCopyResponseConsumer(f.request, f.scope, f.host.devicePubkey, () => NOW)(response);
    expect(vmCopyVerdictSchema.parse(verdict)).toEqual(verdict);
    expect(verdict.verifierRef).toBe('WI-test');
    expect(verdict.leaseOwner).toEqual(f.executionOwner);
    expect(response.payload.custody).toHaveLength(2);
  });
  it('pins raw bytes: equal parsed JSON with different whitespace cannot use the accepted input', async () => {
    const f = fixture();
    const raw = Buffer.from(JSON.stringify(f.manifest));
    expect(JSON.parse(raw.toString())).toEqual(JSON.parse(f.raw.toString()));
    f.request.manifestRawBase64 = raw.toString('base64');
    f.request.manifestSha256 = createHash('sha256').update(raw).digest('hex');
    await expect(evaluateVmCopyAuthority(f.request, f.host, NOW)).rejects.toThrow('accepted-input-mismatch');
  });
  it('does not trim a foreign manifest owner into the authenticated owner', async () => {
    const f = fixture(); f.manifest.ownerId = ` ${f.scope.ownerId} `;
    const raw = Buffer.from(JSON.stringify(f.manifest));
    f.request.manifestRawBase64 = raw.toString('base64');
    f.request.manifestSha256 = createHash('sha256').update(raw).digest('hex');
    await expect(evaluateVmCopyAuthority(f.request, f.host, NOW)).rejects.toThrow('owner-mismatch');
  });
  it.each([
    ['owner', (f: ReturnType<typeof fixture>) => { f.scope.ownerId = 'foreign'; }],
    ['workspace', f => { f.scope.workspaceId = 'foreign'; }],
    ['session', f => { f.scope.sessionId = '99'; }],
    ['harness', f => { f.scope.harnessSlug = 'foreign'; }],
    ['applied spec', f => { f.scope.appliedSpecificationRevision = 'd'.repeat(64); }],
    ['applied state', f => { f.scope.appliedStateRevision = 'stale'; }],
    ['policy', f => { f.scope.policyRevision = 'stale'; }],
    ['operation scope', f => { f.worker.binding.operationId = 'unrelated'; }],
    ['input operation', f => { f.input.operationId = 'other-copy'; }],
    ['input digest', f => { f.input.manifestSha256 = 'd'.repeat(64); }],
    ['capability ref', f => { f.input.capabilityRef = 'foreign'; }],
    ['current capability ref', f => { f.host.capabilityRef = async () => 'foreign'; }],
    ['missing capability ref', f => { f.host.capabilityRef = async () => null; }],
    ['lease ref', f => { f.input.leaseRef = 'foreign'; }],
    ['execution provider', f => { f.worker.binding.requiredTools = ['capability:inspect']; }],
    ['inspect only', f => { f.input.executionTools = ['capability:inspect']; }],
    ['resource map', f => { f.host.resources = async () => null; }],
    ['domain', f => { f.host.resources = async () => f.pins.map(p => ({ ...p, coordinationDomain: 'foreign' })); }],
    ['released', f => { f.queues[0].holders = []; }],
    ['draining', f => { f.queues[0].draining = true; }],
    ['resource', f => { f.queues[0].holders[0].resource = 'other'; }],
    ['lock id', f => { f.queues[0].holders[0].lock_id = 'replacement'; }],
    ['fence', f => { f.queues[0].holders[0].fence_seq++; }],
    ['lease owner', f => { f.queues[0].holders[0].owner = 'foreign'; }],
    ['expiry', f => { f.queues[0].holders[0].expires_ts = new Date(NOW); }],
    ['process missing', f => { f.host.process = async () => null; }],
    ['boot id', f => { f.host.process = async () => ({ ...f.executionOwner, bootId: 'reboot' }); }],
    ['pid', f => { f.host.process = async () => ({ ...f.executionOwner, pid: 999 }); }],
    ['start ticks', f => { f.host.process = async () => ({ ...f.executionOwner, startTicks: 999 }); }],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => void]> )('refuses changed %s', async (_, mutate) => {
    const f = fixture(); mutate(f);
    await expect(evaluateVmCopyAuthority(f.request, f.host, NOW)).rejects.toThrow('vm-copy-');
  });
  it.each(['revoked', 'unavailable'] as const)('refuses %s standing', async standing => {
    const f = fixture(); f.host.standing = async () => standing;
    await expect(evaluateVmCopyAuthority(f.request, f.host, NOW)).rejects.toThrow('revocation');
  });
  it.each([null, undefined, { decision: 'allow' }, { decision: 'allow', availability: 'unavailable', applied: false }])
  ('does not upgrade a null/legacy/structural kernel result %j', async result => {
    const f = fixture(); f.host.kernel = async () => result as never;
    await expect(evaluateVmCopyAuthority(f.request, f.host, NOW)).rejects.toThrow('applied-provider-denied');
  });
  it.each(['decision', 'availability', 'applied', 'revisionSource', 'policyRevision', 'executionRevision', 'serverAudit'])
  ('requires kernel %s evidence', async field => {
    const f = fixture(); delete (f.kernel as Record<string, unknown>)[field];
    await expect(evaluateVmCopyAuthority(f.request, f.host, NOW)).rejects.toThrow('applied-provider-denied');
  });
  it.each(['none', 'unavailable'])('refuses an ordinary SU or unavailable worker (%s)', async status => {
    const f = fixture(); f.host.worker = async () => ({ status } as never);
    await expect(evaluateVmCopyAuthority(f.request, f.host, NOW)).rejects.toThrow('accepted-operation-unavailable');
  });
  it('reads authority again before publication and observes revocation', async () => {
    const f = fixture(); const standing = vi.fn(f.host.standing); f.host.standing = standing;
    await evaluateVmCopyAuthority(f.request, f.host, NOW);
    standing.mockResolvedValue('revoked');
    await expect(evaluateVmCopyAuthority({ ...f.request, phase: 'prepublish', challenge: 'e'.repeat(64) }, f.host, NOW))
      .rejects.toThrow('revocation');
    expect(standing).toHaveBeenCalledTimes(3);
  });
  it.each(['reacquired', 'expired', 'draining', 'shared'])('rechecks %s custody before publication', async change => {
    const f = fixture(); await evaluateVmCopyAuthority(f.request, f.host, NOW);
    if (change === 'reacquired') f.queues[0].holders[0].fence_seq++;
    if (change === 'expired') f.queues[0].holders[0].expires_ts = new Date(NOW);
    if (change === 'draining') f.queues[0].draining = true;
    if (change === 'shared') Object.assign(f.queues[0].holders[0], { mode: 'shared' });
    await expect(evaluateVmCopyAuthority({ ...f.request, phase: 'prepublish', challenge: 'e'.repeat(64) }, f.host, NOW))
      .rejects.toThrow('custody');
  });
  it('denies missing host adapters in both fixed production entries', async () => {
    const f = fixture();
    await expect(inspectVmCopyAuthority(f.request, {})).rejects.toThrow('authenticated-session-required');
    await expect(inspectVmCopyAuthority(f.request, { principal: {} })).rejects.toThrow('installed-host-binding-unavailable');
    await expect(verifyVmCopyFromInstalledHost(f.raw, 'preflight')).rejects.toThrow('installed-host-binding-unavailable');
  });
  it.each(['command', 'url', 'key', 'verifier', 'verdict', 'ownerId', 'workspaceId', 'sessionId'])
  ('rejects caller override %s at the strict fixed selector', key => {
    const f = fixture();
    expect(vmCopyInspectSchema.safeParse({ check: 'vm-copy-authority', request: f.request, [key]: 'override' }).success).toBe(false);
    expect(vmCopyInspectSchema.safeParse({ check: 'vm-copy-authority', request: { ...f.request, [key]: 'override' } }).success).toBe(false);
  });
});

describe('signed response consumer', () => {
  it.each(['phase', 'challenge', 'operationId', 'manifestSha256', 'workspaceId', 'harnessSlug', 'sessionId',
    'appliedSpecificationRevision', 'appliedStateRevision', 'policyRevision', 'acceptedOperationRef'])
  ('refuses a valid signature for another %s', async field => {
    const f = fixture(); const r = await evaluateVmCopyAuthority(f.request, f.host, NOW);
    const p = r.payload as unknown as Record<string, unknown>;
    p[field] = field === 'phase' ? 'prepublish' : field === 'manifestSha256' || field === 'challenge' || field === 'appliedSpecificationRevision'
      ? 'f'.repeat(64) : 'foreign';
    r.auth = await signAuthorityRpc({ harnessSlug: f.scope.harnessSlug, kind: VM_COPY_RESPONSE_KIND,
      payload: r.payload, device_pubkey: f.host.devicePubkey }, f.sign, { nowMs: NOW });
    expect(() => vmCopyResponseConsumer(f.request, f.scope, f.host.devicePubkey, () => NOW)(r)).toThrow('vm-copy-');
  });
  it('refuses copied allow JSON and unsigned or tampered responses', async () => {
    const f = fixture(); const r = await evaluateVmCopyAuthority(f.request, f.host, NOW);
    for (const value of [r.payload.verdict, { payload: r.payload }, { ...r, payload: { ...r.payload, operationId: 'tampered' } }]) {
      expect(() => vmCopyResponseConsumer(f.request, f.scope, f.host.devicePubkey, () => NOW)(value)).toThrow('vm-copy-');
    }
  });
  it('requires the pinned installed host key, the fixed signature kind, and a recent nonfuture signature', async () => {
    const f = fixture(); const r = await evaluateVmCopyAuthority(f.request, f.host, NOW);
    expect(() => vmCopyResponseConsumer(f.request, f.scope, generateEd25519KeypairDer().pubkeyBase64, () => NOW)(r))
      .toThrow('signature');
    for (const ts of [NOW - 5001, NOW + 1]) {
      const auth = await signAuthorityRpc({ harnessSlug: f.scope.harnessSlug, kind: VM_COPY_RESPONSE_KIND,
        payload: r.payload, device_pubkey: f.host.devicePubkey }, f.sign, { nowMs: ts });
      expect(() => vmCopyResponseConsumer(f.request, f.scope, f.host.devicePubkey, () => NOW)({ ...r, auth })).toThrow('signature');
    }
    r.auth = await signAuthorityRpc({ harnessSlug: f.scope.harnessSlug, kind: 'other-kind',
      payload: r.payload, device_pubkey: f.host.devicePubkey }, f.sign, { nowMs: NOW });
    expect(() => vmCopyResponseConsumer(f.request, f.scope, f.host.devicePubkey, () => NOW)(r)).toThrow('signature');
  });
  it('consumes each challenge once, and rejects a prior response for the next challenge', async () => {
    const f = fixture(); const r = await evaluateVmCopyAuthority(f.request, f.host, NOW);
    const consume = vmCopyResponseConsumer(f.request, f.scope, f.host.devicePubkey, () => NOW);
    consume(r); expect(() => consume(r)).toThrow('replay');
    expect(() => vmCopyResponseConsumer({ ...f.request, challenge: 'e'.repeat(64) }, f.scope, f.host.devicePubkey, () => NOW)(r))
      .toThrow('request-mismatch');
  });
  it.each(['ownerId', 'leaseRef', 'capabilityRef', 'verifierRef', 'expiresAt', 'notBefore'])
  ('refuses a signed inconsistent nested verdict %s', async field => {
    const f = fixture(); const r = await evaluateVmCopyAuthority(f.request, f.host, NOW);
    (r.payload.verdict as unknown as Record<string, unknown>)[field] = field === 'expiresAt' ? NOW / 1000 :
      field === 'notBefore' ? NOW / 1000 + 1 : 'foreign';
    r.auth = await signAuthorityRpc({ harnessSlug: f.scope.harnessSlug, kind: VM_COPY_RESPONSE_KIND,
      payload: r.payload, device_pubkey: f.host.devicePubkey }, f.sign, { nowMs: NOW });
    expect(() => vmCopyResponseConsumer(f.request, f.scope, f.host.devicePubkey, () => NOW)(r)).toThrow('verdict-mismatch');
  });
});
