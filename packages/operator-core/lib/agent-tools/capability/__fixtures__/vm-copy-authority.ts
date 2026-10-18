/** Fully fictional authority for maintained tests; never installed or registered. */
import { createHash } from 'node:crypto';
import { generateEd25519KeypairDer } from '../../../identity/ed25519';
import { signAuthorityRpcWithPrivateKeyDer } from '../../../authority/authority-rpc-envelope';
import { VM_COPY_SCOPE, type VmCopyHost, type VmCopyRequest } from '../vm-copy-authority';

export const NOW = 1_800_000_000_000;
export function fixture(now = NOW) {
  const keys = generateEd25519KeypairDer();
  const sign = async (bytes: Buffer) => signAuthorityRpcWithPrivateKeyDer(keys.privateKeyDer, bytes);
  const scope = { workspaceId: 'test-workspace', harnessSlug: 'test-harness', ownerId: 'worker', sessionId: '23',
    appliedSpecificationRevision: 'a'.repeat(64), appliedStateRevision: 'state-1', policyRevision: 'policy-1' };
  const executionOwner = { bootId: 'execution-host-boot', pid: 321, startTicks: 456 };
  const manifest = {
    schemaVersion: 1, operationId: 'copy-1', ownerId: scope.ownerId,
    source: { name: 'protected', chain: [{ path: '/run/vms/protected/overlay.qcow2', dev: 1, ino: 2, size: 4096,
      sha256: 'b'.repeat(64), format: 'qcow2', virtualSize: 8192 }],
    stopped: { bootId: 'source-boot', pid: 123, startTicks: 1234 } },
    destination: { name: 'copy', path: '/run/vms/copy/overlay.qcow2' }, evidenceDir: '/evidence',
    lineage: ['source-1'], retentionUntil: Math.ceil(now / 1000) + 86400,
    authority: { leaseRef: 'canonical-lease-ref', capabilityRef: 'applied-capability-ref' },
    limits: { copyBytes: 8192, guestWriteBytes: 0, evidenceBytes: 65536, rollbackBytes: 0, retainedBytes: 0,
      timeoutSec: 60, leaseLifetimeSec: 120 },
  };
  const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const request: VmCopyRequest = { schemaVersion: 1, phase: 'preflight', challenge: 'c'.repeat(64),
    operationId: manifest.operationId, manifestRawBase64: raw.toString('base64'),
    manifestSha256: createHash('sha256').update(raw).digest('hex') };
  // Deliberately fictional test resources; no production resource family is invented.
  const pins = ['source-test-only', 'destination-test-only'].map((resource, i) => ({
    resource, coordinationDomain: 'test-domain', lockId: `lock-${i}`, ownerId: scope.ownerId, fenceSeq: i + 7,
  }));
  const input = { scope: VM_COPY_SCOPE, operationId: request.operationId, manifestRawBase64: request.manifestRawBase64,
    manifestSha256: request.manifestSha256, ...manifest.authority, custody: pins,
    executionTools: ['capability:bash'], executionOwner };
  const worker = { status: 'bound' as const,
    receipt: { sessionId: 23, workspaceId: scope.workspaceId, ownerId: scope.ownerId,
      specificationRevision: scope.appliedSpecificationRevision, stateRevision: scope.appliedStateRevision, acceptedOperation: {} },
    binding: { workItemId: 'WI-test', harnessSlug: scope.harnessSlug, storageHarnessSlug: scope.harnessSlug,
      operationId: VM_COPY_SCOPE, specificationRevision: scope.appliedSpecificationRevision,
      pin: { kind: 'blueprint-operation' as const, harnessSlug: scope.harnessSlug,
        specificationRevision: scope.appliedSpecificationRevision, operationId: VM_COPY_SCOPE, operationVersion: '1', input },
      identity: { ref: 'test-identity', revision: '1', contentHash: 'a'.repeat(64) }, stack: ['domain:test-identity'],
      requiredTools: ['capability:inspect', 'capability:bash'] },
  };
  const kernel = { decision: 'allow' as const, availability: 'available' as const, applied: true,
    executionRevision: { specificationRevision: scope.appliedSpecificationRevision, stateRevision: scope.appliedStateRevision },
    revisionSource: 'applied' as const, policyRevision: scope.policyRevision,
    serverAudit: { identityLaunchRecord: { advSessionId: scope.sessionId, xmin: '42' } } };
  const queues = pins.map(pin => ({ draining: false, holders: [{ resource: pin.resource, owner: pin.ownerId,
    owner_label: null, mode: 'exclusive' as const, status: 'held' as const, lock_id: pin.lockId,
    reason: 'test only; never authority', acquired_ts: new Date(now - 1000), expires_ts: new Date(now + 600_000), fence_seq: pin.fenceSeq }] }));
  const host: VmCopyHost = { scope, devicePubkey: keys.pubkeyBase64, sign, standing: async () => 'current',
    worker: async () => worker, kernel: async () => kernel, resources: async () => pins,
    capabilityRef: async () => 'applied-capability-ref',
    queue: async pin => queues[pins.findIndex(p => p.resource === pin.resource)], process: async () => executionOwner };
  return { scope, manifest, request, input, worker, kernel, queues, pins, host, executionOwner, raw, sign };
}
