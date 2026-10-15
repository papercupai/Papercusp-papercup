import { createHash } from 'node:crypto';

import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostRequiredReleaseMaterialFixtures,
  buildWorkspaceHostCleanRoomInstallFixture,
  workspaceHostCleanRoomFixtureAttestation,
  type WorkspaceHostCleanRoomAcceptanceReport,
  type WorkspaceHostCleanRoomInstallSpec,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import { ARTIFACT_TRUST_PIPELINE_VERSION, type ArtifactTrustReport } from './artifact-trust';
import {
  WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
  type WorkspaceHostBootcBakeManifest,
} from './bootc-bake-manifest';
import {
  AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS,
  AzureComputeGalleryReleaseError,
  buildAzureComputeGalleryVersionManifest,
  executeAzureComputeGalleryRelease,
  type AzureComputeGalleryCleanAccountProof,
  type AzureComputeGalleryInspection,
  type AzureComputeGalleryRegionTarget,
  type AzureComputeGalleryReleaseAdapter,
  type AzureComputeGalleryReleaseRequest,
  type AzureComputeGalleryScanEvidence,
  type AzureComputeGalleryVersionManifest,
} from './azure-compute-gallery-release';

const PUBLISHER_TENANT = '11111111-1111-4111-8111-111111111111';
const PUBLISHER_SUBSCRIPTION = '22222222-2222-4222-8222-222222222222';
const CLEAN_TENANT = '33333333-3333-4333-8333-333333333333';
const CLEAN_SUBSCRIPTION = '44444444-4444-4444-8444-444444444444';
const RESOURCE_GROUP = 'papercusp-images';
const GALLERY = 'papercusp';
const DEFINITION = 'ubuntu-2404-x86_64';
const GALLERY_VERSION = '1.0.0';
const PREVIOUS_GALLERY_VERSION = '0.9.0';
const RELEASE_VERSION = '2026.8.23-1';
const RELEASE_SHA = 'a'.repeat(64);
const SBOM_SHA = 'b'.repeat(64);
const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const SIGNING_KEY_SHA = createHash('sha256').update(SIGNING_PUBLIC_KEY, 'utf8').digest('hex');
const REGIONS = ['eastus2', 'westus2'] as const;
const BOOTC_SHA = '9'.repeat(64);

function imageDefinitionId(subscriptionId = PUBLISHER_SUBSCRIPTION): string {
  return (
    `/subscriptions/${subscriptionId}/resourceGroups/${RESOURCE_GROUP}/providers/` +
    `Microsoft.Compute/galleries/${GALLERY}/images/${DEFINITION}`
  );
}

function versionId(version = GALLERY_VERSION): string {
  return `${imageDefinitionId()}/versions/${version}`;
}

function sourceImageId(): string {
  return (
    `/subscriptions/${PUBLISHER_SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}/providers/` +
    'Microsoft.Compute/images/papercusp-workspace-host-candidate'
  );
}

function targets(): AzureComputeGalleryRegionTarget[] {
  return [
    { region: 'eastus2', replicaCount: 2, storageAccountType: 'Standard_ZRS' },
    { region: 'westus2', replicaCount: 3, storageAccountType: 'Standard_LRS' },
  ];
}

function artifact(): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: { repository: 'https://github.com/Papercusp/papercusp.git', revision: '1'.repeat(40) },
    releaseArtifact: {
      name: `papercusp-server-${RELEASE_VERSION}.tgz`,
      version: RELEASE_VERSION,
      sha256: RELEASE_SHA,
      sizeBytes: 42_000,
    },
    baseImage: { reference: 'ubuntu-24.04-amd64', architecture: 'x86_64', sha256: 'd'.repeat(64) },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: '1.14.2',
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      templateSha256: 'e'.repeat(64),
    },
    materials: [
      { path: 'dist/papercusp-server.tgz', sha256: RELEASE_SHA, sizeBytes: 42_000 },
      // Derived from the release-gate contract, never restated: a shippable bundle must carry
      // every required material (the remote initializer executable among them), or the image
      // installs and reports healthy and then fails every initialization at the far end.
      ...workspaceHostRequiredReleaseMaterialFixtures(),
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'azure', locations: [...REGIONS] }],
  });
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version: RELEASE_VERSION },
    buildManifest,
    release: {
      version: RELEASE_VERSION,
      // Derived from the digest, not hand-authored against a hostname that does not resolve:
      // the canonical publication path is content-addressed, so the address and the integrity
      // check are the same value.
      bundleUrl: deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_SHA).bundleUrl,
      bundleSha256: RELEASE_SHA,
      signatureUrl: deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_SHA).signatureUrl,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signingKeySha256: SIGNING_KEY_SHA,
    },
    lifecycle: { state: 'active', publishedAt: '2026-08-23T00:00:00Z' },
    compatibility: [
      {
        provider: 'azure',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install', 'upgrade', 'rollback'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function trustReport(subjectSha256 = RELEASE_SHA): ArtifactTrustReport {
  return {
    version: ARTIFACT_TRUST_PIPELINE_VERSION,
    subject: {
      path: '/release/papercusp-server.tgz',
      name: 'papercusp-server.tgz',
      bytes: 42_000,
      sha256: subjectSha256,
      signed: true,
    },
    policy: {
      denyVulnerabilitiesAtOrAbove: 'high',
      maxSecretFindings: 0,
      maxAttestationAgeMs: 60 * 60 * 1_000,
    },
    trusted: true,
    failures: [],
    evidence: [
      { kind: 'signature', subjectSha256, tool: { name: 'minisign', version: '0.12' }, valid: true },
      {
        kind: 'sbom',
        subjectSha256,
        tool: { name: 'syft', version: '1.30' },
        format: 'cyclonedx-json',
        documentSha256: SBOM_SHA,
        componentCount: 42,
      },
      {
        kind: 'vulnerability-scan',
        subjectSha256,
        tool: { name: 'grype', version: '0.99' },
        sbomSha256: SBOM_SHA,
        findings: [],
      },
      {
        kind: 'secret-scan',
        subjectSha256,
        tool: { name: 'gitleaks', version: '8.28' },
        findings: [],
      },
      {
        kind: 'provenance-attestation',
        subjectSha256,
        tool: { name: 'cosign', version: '2.5' },
        valid: true,
        predicateType: 'https://slsa.dev/provenance/v1',
        issuedAt: '2026-08-23T00:10:00Z',
        attestationSha256: 'f'.repeat(64),
      },
    ],
  };
}

function request(
  candidate: WorkspaceHostImageArtifact = artifact(),
  bootcBakeManifest?: WorkspaceHostBootcBakeManifest,
): AzureComputeGalleryReleaseRequest {
  const hostModel = candidate.hostModel ?? 'ubuntu-release-bundle';
  const cleanSpec: WorkspaceHostCleanRoomInstallSpec = {
    fixtureId: 'azure-clean-subscription',
    action: 'install' as const,
    provider: 'azure',
    architecture: 'x86_64',
    observedAt: '2026-08-23T00:20:00Z',
    hostId: 'azure-clean-host-1',
    migrationId: 'schema-1042',
    minimumNodeMajor: 22,
    service: { name: 'papercusp-workspace', port: 3070 },
    ...(hostModel === 'bootc-image'
      ? { hostModel, bootcBaseImage: candidate.hostModel === 'bootc-image' ? candidate.bootc.baseImage : '' }
      : {}),
  };
  const fixture = buildWorkspaceHostCleanRoomInstallFixture(candidate, cleanSpec);
  const cleanRoomReport: WorkspaceHostCleanRoomAcceptanceReport = {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    fixtureId: cleanSpec.fixtureId,
    image: candidate.image,
    passed: true,
    checks: [
      'artifact-identity',
      'compatibility-matrix',
      'deterministic-bootstrap-fixture',
      'exact-bootstrap-attestation',
    ],
    issues: [],
    bootstrapScriptSha256: fixture.bootstrapScriptSha256,
    attestation: workspaceHostCleanRoomFixtureAttestation(fixture, cleanSpec.observedAt),
  };
  return {
    releaseGate: {
      artifact: candidate,
      ...(bootcBakeManifest ? { bootcBakeManifest } : {}),
      trustReport: trustReport(
        candidate.hostModel === 'bootc-image'
          ? candidate.bootc.imageDigest.replace(/^sha256:/, '')
          : RELEASE_SHA,
      ),
      compatibilityRequest:
        candidate.hostModel === 'bootc-image'
          ? {
              action: 'install',
              provider: 'azure',
              architecture: 'x86_64',
              hostModel: 'bootc-image',
              bootcBaseImage: candidate.bootc.baseImage,
              observedAt: cleanSpec.observedAt,
            }
          : {
              action: 'install',
              provider: 'azure',
              architecture: 'x86_64',
              ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
              observedAt: cleanSpec.observedAt,
            },
      cleanRoomReport,
    },
    publisherTenantId: PUBLISHER_TENANT,
    publisherSubscriptionId: PUBLISHER_SUBSCRIPTION,
    resourceGroup: RESOURCE_GROUP,
    galleryName: GALLERY,
    imageDefinitionName: DEFINITION,
    galleryVersion: GALLERY_VERSION,
    sourceRegion: 'eastus2',
    targets: targets(),
    readers: [{ tenantId: CLEAN_TENANT, subscriptionId: CLEAN_SUBSCRIPTION }],
    previousPins: [
      {
        versionResourceId: versionId(PREVIOUS_GALLERY_VERSION),
        version: PREVIOUS_GALLERY_VERSION,
        targetRegions: targets(),
      },
    ],
    cleanAccount: {
      tenantId: CLEAN_TENANT,
      subscriptionId: CLEAN_SUBSCRIPTION,
      region: 'westus2',
      resourceGroup: 'papercusp-clean-canary',
      subnetResourceId:
        `/subscriptions/${CLEAN_SUBSCRIPTION}/resourceGroups/papercusp-clean-canary/providers/` +
        'Microsoft.Network/virtualNetworks/clean/subnets/default',
      managedIdentityResourceId:
        `/subscriptions/${CLEAN_SUBSCRIPTION}/resourceGroups/papercusp-clean-canary/providers/` +
        'Microsoft.ManagedIdentity/userAssignedIdentities/papercusp-clean-canary',
    },
    publishedAt: '2026-08-23T01:00:00Z',
    deprecatePreviousAt: '2026-09-22T01:00:00Z',
  };
}

function bootcArtifact(): Extract<WorkspaceHostImageArtifact, { hostModel: 'bootc-image' }> {
  const current = artifact();
  const { schemaVersion: _schemaVersion, manifestIdentity: _manifestIdentity, ...manifestInput } =
    current.buildManifest;
  return {
    ...current,
    hostModel: 'bootc-image',
    bootc: {
      image: `registry.example.com/papercusp/workspace-host:${RELEASE_VERSION}`,
      imageDigest: `sha256:${BOOTC_SHA}`,
      baseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      signaturePolicyPath: WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
    },
    buildManifest: buildWorkspaceHostBuildManifest({
      ...manifestInput,
      baseImage: {
        reference: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        architecture: 'x86_64',
        sha256: 'd'.repeat(64),
      },
      builder: {
        strategy: 'shared',
        kind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        version: 'latest',
        templatePath: 'infra/images/bootc/workspace-host.Containerfile',
        templateSha256: 'e'.repeat(64),
      },
    }),
    compatibility: current.compatibility.map((rule) => ({
      provider: rule.provider,
      architecture: rule.architecture,
      hostModel: 'bootc-image' as const,
      bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      bootstrapContractVersion: rule.bootstrapContractVersion,
      actions: rule.actions,
      maximumArtifactAgeDays: rule.maximumArtifactAgeDays,
    })),
  };
}

function bootcBakeManifest(): WorkspaceHostBootcBakeManifest {
  const image = 'registry.example.com/papercusp/workspace-host';
  return {
    contractVersion: WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
    image,
    tag: RELEASE_VERSION,
    digest: `sha256:${BOOTC_SHA}`,
    pinnedRef: `${image}@sha256:${BOOTC_SHA}`,
    registryNamespace: 'registry.example.com/papercusp',
    release: { version: RELEASE_VERSION },
    clouds: [
      { cloud: 'gcp', type: 'gce', artifact: '/release/gcp/disk.raw', sha256: '1'.repeat(64), sizeBytes: 101 },
      { cloud: 'aws', type: 'ami', artifact: '/release/aws/disk.raw', sha256: '2'.repeat(64), sizeBytes: 102 },
      { cloud: 'azure', type: 'vhd', artifact: '/release/azure/disk.vhd', sha256: '3'.repeat(64), sizeBytes: 103 },
    ],
  };
}

class FakeAdapter implements AzureComputeGalleryReleaseAdapter {
  readonly calls: string[] = [];
  readonly readers = new Set<string>();
  manifest?: AzureComputeGalleryVersionManifest;
  missingTool?: string;
  badReplicaRegion?: string;
  omitReaderAccess = false;
  proofResidue: readonly string[] = [];

  async buildCandidate(input: Parameters<AzureComputeGalleryReleaseAdapter['buildCandidate']>[0]) {
    this.calls.push(`build:${input.sourceRegion}`);
    expect(input.requiredGuestTools).toEqual(AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS);
    expect(input.builderKind).toBe(WORKSPACE_HOST_SHARED_BUILDER_KIND);
    expect(input.templatePath).toBe('infra/images/workspace-host.pkr.hcl');
    expect(input.bootcArtifact).toBeUndefined();
    return { sourceImageId: sourceImageId() };
  }

  async scanImage(
    input: Parameters<AzureComputeGalleryReleaseAdapter['scanImage']>[0],
  ): Promise<AzureComputeGalleryScanEvidence> {
    this.calls.push(`scan:${input.sourceImageId}`);
    return {
      ...input,
      trusted: true,
      sbomSha256: SBOM_SHA,
      // A realistic image carries sub-threshold findings. Zero here would let the
      // happy path pass without ever exercising the severity policy.
      vulnerabilityFindings: 3,
      vulnerabilityBySeverity: { Low: 2, Negligible: 1 },
      secretFindings: 0,
      mountedFilesystems: 2,
      candidateRootProof: '/mnt/candidate/sda1/etc/os-release',
      evidenceRef: `azure://scan/${input.sourceImageId}`,
    };
  }

  async ensureImageDefinition(input: Parameters<AzureComputeGalleryReleaseAdapter['ensureImageDefinition']>[0]) {
    this.calls.push('ensure-definition');
    expect(input.hyperVGeneration).toBe('V2');
    expect(input.osType).toBe('Linux');
    return { imageDefinitionResourceId: imageDefinitionId() };
  }

  async publishImageVersion(input: Parameters<AzureComputeGalleryReleaseAdapter['publishImageVersion']>[0]) {
    this.calls.push('publish-version');
    expect(input.excludeFromLatest).toBe(true);
    return { versionResourceId: versionId() };
  }

  async grantVersionReadAccess(input: Parameters<AzureComputeGalleryReleaseAdapter['grantVersionReadAccess']>[0]) {
    this.calls.push(`grant:${input.subscriptionId}`);
    if (!this.omitReaderAccess) this.readers.add(input.subscriptionId);
  }

  async inspectImageVersion(id: string): Promise<AzureComputeGalleryInspection> {
    this.calls.push('inspect-version');
    return {
      versionResourceId: id,
      provisioningState: 'Succeeded',
      sourceImageId: sourceImageId(),
      architecture: 'x86_64',
      osType: 'Linux',
      tags: {
        'papercusp:build-manifest': artifact().buildManifest.manifestIdentity,
        'papercusp:image-version': RELEASE_VERSION,
        'papercusp:managed': 'true',
        'papercusp:release-sha256': RELEASE_SHA,
      },
      guestTools: AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS.filter((tool) => tool !== this.missingTool).map(
        (name) => ({ name, version: '1' }),
      ),
      targetRegions: targets().map((target) =>
        target.region === this.badReplicaRegion ? { ...target, replicaCount: target.replicaCount + 1 } : target,
      ),
      readerSubscriptionIds: [...this.readers],
      excludedFromLatest: true,
    };
  }

  async launchCleanAccountCanary(
    input: Parameters<AzureComputeGalleryReleaseAdapter['launchCleanAccountCanary']>[0],
  ): Promise<AzureComputeGalleryCleanAccountProof> {
    this.calls.push(`canary:${input.region}`);
    return {
      evidenceRef: `azure://${input.subscriptionId}/${input.region}/canary`,
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      region: input.region,
      versionResourceId: input.versionResourceId,
      buildManifestIdentity: input.buildManifestIdentity,
      releaseVersion: input.releaseVersion,
      releaseSha256: input.releaseSha256,
      azureAgentOnline: true,
      runCommandHealthy: true,
      bootstrapAttestationHealthy: true,
      serviceHealthy: true,
      publicIpv4Assigned: false,
      deleted: true,
      residualResourceIds: this.proofResidue,
      observedAt: '2026-08-23T01:30:00Z',
    };
  }

  async publishVersionManifest(manifest: AzureComputeGalleryVersionManifest) {
    this.calls.push('publish-manifest');
    this.manifest = manifest;
    return {
      uri: `azure://gallery-manifests/${GALLERY_VERSION}/manifest.json`,
      manifestIdentity: manifest.manifestIdentity,
    };
  }

  async activateVersionPin() {
    this.calls.push('activate-pin');
  }

  async deprecateImageVersion(input: Parameters<AzureComputeGalleryReleaseAdapter['deprecateImageVersion']>[0]) {
    this.calls.push(`deprecate:${input.versionResourceId}`);
  }
}

describe('Azure Compute Gallery workspace-host release', () => {
  it('hands the Azure VHD from the one bootc bake to the publisher instead of a Packer-only build', async () => {
    const adapter = new FakeAdapter();
    adapter.buildCandidate = async (input) => {
      expect(input).toMatchObject({
        builderKind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        templatePath: 'infra/images/bootc/workspace-host.Containerfile',
        bootcArtifact: { cloud: 'azure', type: 'vhd', artifact: '/release/azure/disk.vhd' },
      });
      throw new Error('bootc-consumer-observed');
    };
    await expect(
      executeAzureComputeGalleryRelease(request(bootcArtifact(), bootcBakeManifest()), adapter),
    ).rejects.toThrow('bootc-consumer-observed');
  });

  it('builds, scans, replicates, grants readers, proves a clean-subscription boot, pins, then deprecates', async () => {
    const adapter = new FakeAdapter();
    const result = await executeAzureComputeGalleryRelease(request(), adapter);

    expect(result.releaseGate.accepted).toBe(true);
    expect(result.activePin).toEqual({
      versionResourceId: versionId(),
      version: GALLERY_VERSION,
      targetRegions: targets(),
    });
    expect(result.rollbackPins).toHaveLength(1);
    expect(result.deprecatedPins).toHaveLength(1);
    expect(result.manifest.manifestIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.manifest.readerSubscriptionIds).toEqual([CLEAN_SUBSCRIPTION]);
    expect(adapter.calls).toEqual([
      'build:eastus2',
      `scan:${sourceImageId()}`,
      'ensure-definition',
      'publish-version',
      `grant:${CLEAN_SUBSCRIPTION}`,
      'inspect-version',
      'canary:westus2',
      'publish-manifest',
      'activate-pin',
      `deprecate:${versionId(PREVIOUS_GALLERY_VERSION)}`,
    ]);
  });

  it('normalizes unordered replication, reader, rollback, and guest-tool data into one manifest identity', async () => {
    const adapter = new FakeAdapter();
    const first = await executeAzureComputeGalleryRelease(request(), adapter);
    const payload = { ...first.manifest };
    delete (payload as Partial<AzureComputeGalleryVersionManifest>).manifestIdentity;
    const reordered = buildAzureComputeGalleryVersionManifest({
      ...payload,
      requiredGuestTools: [...payload.requiredGuestTools].reverse(),
      targetRegions: [...payload.targetRegions].reverse(),
      readerSubscriptionIds: [...payload.readerSubscriptionIds].reverse(),
      rollbackPins: [...payload.rollbackPins].reverse(),
    });

    expect(reordered).toEqual(first.manifest);
  });

  it('fails closed before gallery publication when the scanner does not prove filesystem coverage', async () => {
    const adapter = new FakeAdapter();
    const scan = adapter.scanImage.bind(adapter);
    adapter.scanImage = async (input) => {
      const evidence = await scan(input);
      delete (evidence as Partial<AzureComputeGalleryScanEvidence>).mountedFilesystems;
      delete (evidence as Partial<AzureComputeGalleryScanEvidence>).candidateRootProof;
      return evidence;
    };

    await expect(executeAzureComputeGalleryRelease(request(), adapter)).rejects.toThrow(
      'requires proof the scanner covered the image',
    );
    expect(adapter.calls).not.toContain('publish-version');
    expect(adapter.calls).not.toContain('activate-pin');
  });

  it('fails closed before pinning when guest tools, replica policy, or explicit reader access drift', async () => {
    const missingTool = new FakeAdapter();
    missingTool.missingTool = 'WALinuxAgent';
    await expect(executeAzureComputeGalleryRelease(request(), missingTool)).rejects.toThrow(
      'missing guest tool WALinuxAgent',
    );
    expect(missingTool.calls).not.toContain('publish-manifest');

    const wrongReplication = new FakeAdapter();
    wrongReplication.badReplicaRegion = 'westus2';
    await expect(executeAzureComputeGalleryRelease(request(), wrongReplication)).rejects.toThrow(
      'replica counts, or storage policies do not match',
    );
    expect(wrongReplication.calls).not.toContain('activate-pin');

    const missingReader = new FakeAdapter();
    missingReader.omitReaderAccess = true;
    await expect(executeAzureComputeGalleryRelease(request(), missingReader)).rejects.toThrow(
      'reader access does not match',
    );
    expect(missingReader.calls).not.toContain('publish-manifest');
  });

  it('does not publish, pin, or deprecate when clean-subscription teardown leaves residue', async () => {
    const adapter = new FakeAdapter();
    adapter.proofResidue = ['/subscriptions/clean/resourceGroups/left-behind'];
    await expect(executeAzureComputeGalleryRelease(request(), adapter)).rejects.toThrow('zero residue');
    expect(adapter.calls).not.toContain('publish-manifest');
    expect(adapter.calls).not.toContain('activate-pin');
    expect(adapter.calls.some((call) => call.startsWith('deprecate:'))).toBe(false);
  });

  it('does not start a Packer build when the common release gate is red', async () => {
    const bad = request();
    bad.releaseGate.trustReport = { ...bad.releaseGate.trustReport, trusted: false };
    const adapter = new FakeAdapter();
    await expect(executeAzureComputeGalleryRelease(bad, adapter)).rejects.toThrow(AzureComputeGalleryReleaseError);
    expect(adapter.calls).toEqual([]);
  });
});
