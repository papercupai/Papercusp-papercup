import { createHash } from 'node:crypto';

import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER,
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
import { describe, expect, it, vi } from 'vitest';
import { assertAwsAmiTaskBudget, awsAmiPublicationBudgetMs, executeConfiguredAwsAmiRelease } from './aws-ami-production';
import { TASK_DEADLINE_EPOCH_MS_ENV } from '../systemd-scope';

import {
  ATTESTATION_PREFIX as CANARY_ATTESTATION_PREFIX,
  buildAwsAmiCanaryProof,
  parseAwsAmiCanaryInput,
  runAwsAmiCleanAccountCanary,
} from '../../bin/aws-ami-canary-measure.mjs';

import { ARTIFACT_TRUST_PIPELINE_VERSION, type ArtifactTrustReport } from './artifact-trust';
import {
  WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
  workspaceHostReleaseSubjectSha256,
  type WorkspaceHostBootcBakeManifest,
} from './bootc-bake-manifest';
import {
  AWS_AMI_REQUIRED_GUEST_TOOLS,
  AwsAmiReleaseError,
  buildAwsAmiVersionManifest,
  executeAwsAmiRelease,
  type AwsAmiCleanAccountLaunchProof,
  type AwsAmiInspection,
  type AwsAmiReleaseAdapter,
  type AwsAmiReleaseRequest,
  type AwsAmiScanEvidence,
  type AwsAmiVersionManifest,
} from './aws-ami-release';

const RELEASE_SHA = 'a'.repeat(64);
const SBOM_SHA = 'b'.repeat(64);
const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const SIGNING_KEY_SHA = createHash('sha256').update(SIGNING_PUBLIC_KEY, 'utf8').digest('hex');
const MANIFEST_ID = `sha256:${'c'.repeat(64)}`;
const VERSION = '2026.8.23-1';
const PUBLISHER = '111111111111';
const CLEAN_ACCOUNT = '222222222222';
const REGIONS = ['us-east-1', 'us-west-2'] as const;
const BOOTC_SHA = '9'.repeat(64);

describe('AWS publication phase budget with a real rendered canary fixture', () => {
  it('rejects the combined three-hour caller before any production side effect', async () => {
    const send = vi.fn();
    const run = vi.fn();
    const input = request();
    vi.stubEnv(TASK_DEADLINE_EPOCH_MS_ENV, String(3 * 60 * 60_000));
    try {
      await expect(executeConfiguredAwsAmiRelease(input, {
        target: 'aws', scope: { kind: 'account', id: PUBLISHER },
      } as never, {}, {
        now: () => 0, ec2: () => ({ send }), ssm: () => ({ send }), kms: () => ({ send }),
        childCredentials: async () => ({}), commands: { run },
      })).rejects.toThrow(/AWS_AMI_TASK_BUDGET_REFUSAL publication/);
      expect(send).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reserves retries, copies and fixture-sized canary work; recovery skips only rebuilding', () => {
    const input = request();
    const full = awsAmiPublicationBudgetMs(input);
    const recovered = awsAmiPublicationBudgetMs(input, true);
    expect(full - recovered).toBe(2 * 2 * 60 * 60_000 + 2 * 60 * 60_000);
    expect(awsAmiPublicationBudgetMs({ ...input, targets: input.targets.slice(0, 1) }, true))
      .toBe(recovered - 60 * 60_000);
    const env = { [TASK_DEADLINE_EPOCH_MS_ENV]: String(full + 1000) };
    expect(() => assertAwsAmiTaskBudget('publication', () => full, 1000, env)).not.toThrow();
    expect(() => assertAwsAmiTaskBudget('publication', () => full, 1001, env)).toThrow(/REFUSAL/);
  });
});

function artifact(): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: { repository: 'https://github.com/Papercusp/papercusp.git', revision: '1'.repeat(40) },
    releaseArtifact: {
      name: `papercusp-server-${VERSION}.tgz`,
      version: VERSION,
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
    targets: [{ provider: 'aws', locations: [...REGIONS] }],
  });
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version: VERSION },
    buildManifest,
    release: {
      version: VERSION,
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
        provider: 'aws',
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
    policy: { denyVulnerabilitiesAtOrAbove: 'high', maxSecretFindings: 0, maxAttestationAgeMs: 60 * 60 * 1_000 },
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
      { kind: 'secret-scan', subjectSha256, tool: { name: 'gitleaks', version: '8.28' }, findings: [] },
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
): AwsAmiReleaseRequest {
  const hostModel = candidate.hostModel ?? 'ubuntu-release-bundle';
  const cleanSpec: WorkspaceHostCleanRoomInstallSpec = {
    fixtureId: 'aws-clean-room',
    action: 'install' as const,
    provider: 'aws',
    architecture: 'x86_64',
    observedAt: '2026-08-23T00:20:00Z',
    hostId: 'clean-host-1',
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
              provider: 'aws',
              architecture: 'x86_64',
              hostModel: 'bootc-image',
              bootcBaseImage: candidate.bootc.baseImage,
              observedAt: '2026-08-23T00:20:00Z',
            }
          : {
              action: 'install',
              provider: 'aws',
              architecture: 'x86_64',
              ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
              observedAt: '2026-08-23T00:20:00Z',
            },
      cleanRoomReport,
    },
    publisherAccountId: PUBLISHER,
    sourceRegion: 'us-east-1',
    targets: REGIONS.map((region) => ({
      region,
      kmsKeyArn: `arn:aws:kms:${region}:${PUBLISHER}:key/key-${region}`,
      shareWithAccountIds: [CLEAN_ACCOUNT],
    })),
    previousPins: REGIONS.map((region, index) => ({
      region,
      imageId: `ami-old${index}`,
      version: '2026.8.22-1',
    })),
    cleanAccount: {
      accountId: CLEAN_ACCOUNT,
      region: 'us-west-2',
      subnetId: 'subnet-clean',
      instanceProfileArn: `arn:aws:iam::${CLEAN_ACCOUNT}:instance-profile/PapercuspCleanCanary`,
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
      image: `registry.example.com/papercusp/workspace-host:${VERSION}`,
      imageDigest: `sha256:${BOOTC_SHA}`,
      baseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      signaturePolicyPath: WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
    },
    buildManifest: buildWorkspaceHostBuildManifest({
      ...manifestInput,
      baseImage: { reference: WORKSPACE_HOST_BOOTC_BASE_IMAGE, architecture: 'x86_64', sha256: 'd'.repeat(64) },
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
    tag: VERSION,
    digest: `sha256:${BOOTC_SHA}`,
    pinnedRef: `${image}@sha256:${BOOTC_SHA}`,
    registryNamespace: 'registry.example.com/papercusp',
    release: { version: VERSION },
    clouds: [
      { cloud: 'gcp', type: 'gce', artifact: '/release/gcp/disk.raw', sha256: '1'.repeat(64), sizeBytes: 101 },
      { cloud: 'aws', type: 'ami', artifact: '/release/aws/disk.raw', sha256: '2'.repeat(64), sizeBytes: 102 },
      { cloud: 'azure', type: 'vhd', artifact: '/release/azure/disk.vhd', sha256: '3'.repeat(64), sizeBytes: 103 },
    ],
  };
}

class FakeAdapter implements AwsAmiReleaseAdapter {
  readonly calls: string[] = [];
  readonly permissions = new Map<string, readonly string[]>();
  readonly kmsGrantPermissions = new Map<string, readonly string[]>();
  manifest?: AwsAmiVersionManifest;
  missingTool?: string;
  missingKmsGrantAccountId?: string;
  badKmsRegion?: string;
  proofResidue: readonly string[] = [];
  /** Lets a test corrupt the canary proof (wrong fixture / bad attestation) after it is built. */
  proofOverride?: (proof: AwsAmiCleanAccountLaunchProof) => AwsAmiCleanAccountLaunchProof;
  canaryFixture?: Parameters<AwsAmiReleaseAdapter['launchCleanAccountCanary']>[0]['fixture'];
  /** The artifact the published image claims to be; inspection tags are derived from it. */
  candidate: WorkspaceHostImageArtifact = artifact();

  async buildCandidate(input: Parameters<AwsAmiReleaseAdapter['buildCandidate']>[0]) {
    this.calls.push(`build:${input.sourceRegion}`);
    expect(input.requiredGuestTools).toEqual(AWS_AMI_REQUIRED_GUEST_TOOLS);
    expect(input.builderKind).toBe(WORKSPACE_HOST_SHARED_BUILDER_KIND);
    expect(input.templatePath).toBe('infra/images/workspace-host.pkr.hcl');
    expect(input.bootcArtifact).toBeUndefined();
    return { imageId: 'ami-source1' };
  }

  async scanImage(input: Parameters<AwsAmiReleaseAdapter['scanImage']>[0]): Promise<AwsAmiScanEvidence> {
    this.calls.push(`scan:${input.region}:${input.imageId}`);
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
      // The attribution the scoped AWS policy requires (WI-10006421), partitioning the totals.
      vulnerabilityByScope: { 'inherited-base-image': 2, 'papercusp-bundled': 1 },
      vulnerabilityCriticalHighByScope: {},
      bundleCatalogedArtifacts: 289,
      secretsByScope: {},
      secretBundledSample: [],
      secretBundledSampleComplete: true,
      evidenceRef: `aws://scan/${input.imageId}`,
    };
  }

  async copyImage(input: Parameters<AwsAmiReleaseAdapter['copyImage']>[0]) {
    this.calls.push(`copy:${input.targetRegion}`);
    expect(input.encrypted).toBe(true);
    expect(input.kmsKeyArn).toContain(`:kms:${input.targetRegion}:`);
    return { imageId: 'ami-copy2' };
  }

  async publishPermissions(input: Parameters<AwsAmiReleaseAdapter['publishPermissions']>[0]) {
    this.calls.push(`permissions:${input.region}`);
    expect(input.snapshotCreateVolumeAccountIds).toEqual(input.launchAccountIds);
    this.permissions.set(input.region, input.launchAccountIds);
    expect(input.kmsKeyArn).toBe(request().targets.find((target) => target.region === input.region)?.kmsKeyArn);
    expect(input.kmsGrantAccountIds).toEqual(input.launchAccountIds);
    this.kmsGrantPermissions.set(
      input.region,
      (input.kmsGrantAccountIds ?? []).filter((accountId) => accountId !== this.missingKmsGrantAccountId),
    );
  }

  async inspectImage(region: string, imageId: string, _kmsKeyArn: string): Promise<AwsAmiInspection> {
    this.calls.push(`inspect:${region}`);
    const requestTarget = request().targets.find((target) => target.region === region)!;
    return {
      imageId,
      region,
      ownerAccountId: PUBLISHER,
      state: 'available',
      architecture: 'x86_64',
      tags: {
        Name: `papercusp-workspace-host-${VERSION}`,
        'papercusp:build-manifest': this.candidate.buildManifest.manifestIdentity,
        'papercusp:image-version': VERSION,
        'papercusp:managed': 'true',
        'papercusp:release-sha256': workspaceHostReleaseSubjectSha256(this.candidate),
      },
      guestTools: AWS_AMI_REQUIRED_GUEST_TOOLS.filter((tool) => tool !== this.missingTool).map((name) => ({
        name,
        version: name === 'amazon-ssm-agent' ? '3.3.3050.0' : '1',
      })),
      launchAccountIds: this.permissions.get(region) ?? [],
      kmsGrantAccountIds: this.kmsGrantPermissions.get(region) ?? [],
      snapshots: [
        {
          snapshotId: `snap-${region.replaceAll('-', '')}`,
          encrypted: true,
          kmsKeyArn:
            this.badKmsRegion === region ? `arn:aws:kms:${region}:${PUBLISHER}:key/wrong` : requestTarget.kmsKeyArn,
          createVolumeAccountIds: this.permissions.get(region) ?? [],
        },
      ],
    };
  }

  async launchCleanAccountCanary(
    input: Parameters<AwsAmiReleaseAdapter['launchCleanAccountCanary']>[0],
  ): Promise<AwsAmiCleanAccountLaunchProof> {
    this.calls.push(`canary:${input.region}`);
    this.canaryFixture = input.fixture;
    const observedAt = '2026-08-23T01:30:00Z';
    const proof: AwsAmiCleanAccountLaunchProof = {
      evidenceRef: `aws://${input.accountId}/${input.region}/canary`,
      accountId: input.accountId,
      region: input.region,
      imageId: input.imageId,
      buildManifestIdentity: input.buildManifestIdentity,
      releaseVersion: input.releaseVersion,
      releaseSha256: input.releaseSha256,
      ssmOnline: true,
      bootstrapAttestationHealthy: true,
      serviceHealthy: true,
      publicIpv4Assigned: false,
      terminated: true,
      dataVolumeId: 'vol-0123456789abcdef0',
      dataVolumeDeleted: true,
      residualResourceIds: this.proofResidue,
      observedAt,
      fixtureId: input.fixture.fixtureId,
      attestation: workspaceHostCleanRoomFixtureAttestation(input.fixture, observedAt),
    };
    return this.proofOverride ? this.proofOverride(proof) : proof;
  }

  async publishVersionManifest(manifest: AwsAmiVersionManifest) {
    this.calls.push('publish-manifest');
    this.manifest = manifest;
    return { uri: `s3://papercusp-images/${VERSION}/manifest.json`, manifestIdentity: manifest.manifestIdentity };
  }

  async activatePins() {
    this.calls.push('activate-pins');
  }

  async enableImageDeprecation(input: Parameters<AwsAmiReleaseAdapter['enableImageDeprecation']>[0]) {
    this.calls.push(`deprecate:${input.region}:${input.imageId}`);
  }
}

describe('AWS workspace-host AMI release', () => {
  it('hands the AWS disk from the one bootc bake to the publisher instead of a Packer-only build', async () => {
    const adapter = new FakeAdapter();
    adapter.buildCandidate = async (input) => {
      expect(input).toMatchObject({
        builderKind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        templatePath: 'infra/images/bootc/workspace-host.Containerfile',
        bootcArtifact: { cloud: 'aws', type: 'ami', artifact: '/release/aws/disk.raw' },
      });
      throw new Error('bootc-consumer-observed');
    };
    await expect(executeAwsAmiRelease(request(bootcArtifact(), bootcBakeManifest()), adapter)).rejects.toThrow(
      'bootc-consumer-observed',
    );
  });

  it('publishes a bootc AMI whose clean-account canary attests the bootc host model (WI-10006586)', async () => {
    // Before WI-10006586 the release re-built the expected bootstrap input field by field and
    // dropped hostModel/bootc, so a healthy bootc canary was judged against the
    // ubuntu-release-bundle default and every bootc release was refused at this step.
    const candidate = bootcArtifact();
    const adapter = new FakeAdapter();
    adapter.candidate = candidate;
    adapter.buildCandidate = async (input) => {
      adapter.calls.push(`build:${input.sourceRegion}`);
      expect(input.builderKind).toBe(WORKSPACE_HOST_BOOTC_BUILDER_KIND);
      return { imageId: 'ami-source1' };
    };
    const result = await executeAwsAmiRelease(request(candidate, bootcBakeManifest()), adapter);

    expect(adapter.canaryFixture?.bootstrapInput.hostModel).toBe('bootc-image');
    expect(adapter.canaryFixture?.bootstrapInput.bootc?.imageDigest).toBe(candidate.bootc.imageDigest);
    expect(result.releaseGate.accepted).toBe(true);
    expect(adapter.calls).toContain('publish-manifest');
    expect(adapter.calls).toContain('activate-pins');
  });

  it('refuses a bootc canary whose attestation claims the ubuntu host model', async () => {
    const candidate = bootcArtifact();
    const adapter = new FakeAdapter();
    adapter.candidate = candidate;
    adapter.buildCandidate = async (input) => {
      adapter.calls.push(`build:${input.sourceRegion}`);
      return { imageId: 'ami-source1' };
    };
    adapter.proofOverride = (proof) => ({
      ...proof,
      attestation: { ...proof.attestation, hostModel: 'ubuntu-release-bundle' as never },
    });
    await expect(executeAwsAmiRelease(request(candidate, bootcBakeManifest()), adapter)).rejects.toThrow(
      'attestation failed validation',
    );
    expect(adapter.calls).not.toContain('publish-manifest');
  });

  it('builds, scans, copies, verifies encrypted sharing, proves a clean-account launch, pins, then deprecates', async () => {
    const adapter = new FakeAdapter();
    const result = await executeAwsAmiRelease(request(), adapter);

    expect(result.releaseGate.accepted).toBe(true);
    expect(result.activePins).toEqual([
      { region: 'us-east-1', imageId: 'ami-source1', version: VERSION },
      { region: 'us-west-2', imageId: 'ami-copy2', version: VERSION },
    ]);
    expect(result.rollbackPins).toHaveLength(2);
    expect(result.deprecatedPins).toHaveLength(2);
    expect(result.manifest.manifestIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.manifest.regions.every((region) => region.launchAccountIds.includes(CLEAN_ACCOUNT))).toBe(true);
    expect(adapter.calls).toEqual([
      'build:us-east-1',
      'scan:us-east-1:ami-source1',
      'copy:us-west-2',
      'permissions:us-east-1',
      'inspect:us-east-1',
      'permissions:us-west-2',
      'inspect:us-west-2',
      'canary:us-west-2',
      'publish-manifest',
      'activate-pins',
      'deprecate:us-east-1:ami-old0',
      'deprecate:us-west-2:ami-old1',
    ]);
  });

  it('normalizes unordered regional data into one immutable manifest identity', async () => {
    const firstAdapter = new FakeAdapter();
    const first = await executeAwsAmiRelease(request(), firstAdapter);
    const payload = { ...first.manifest };
    delete (payload as Partial<AwsAmiVersionManifest>).manifestIdentity;
    const reordered = buildAwsAmiVersionManifest({
      ...payload,
      regions: [...payload.regions].reverse().map((region) => ({
        ...region,
        snapshotIds: [...region.snapshotIds].reverse(),
        launchAccountIds: [...region.launchAccountIds].reverse(),
      })),
      rollbackPins: [...payload.rollbackPins].reverse(),
      requiredGuestTools: [...payload.requiredGuestTools].reverse(),
    });
    expect(reordered).toEqual(first.manifest);
  });

  it('fails closed before AMI publication when the scanner does not prove filesystem coverage', async () => {
    const adapter = new FakeAdapter();
    const scan = adapter.scanImage.bind(adapter);
    adapter.scanImage = async (input) => {
      const evidence = await scan(input);
      delete (evidence as Partial<AwsAmiScanEvidence>).mountedFilesystems;
      delete (evidence as Partial<AwsAmiScanEvidence>).candidateRootProof;
      return evidence;
    };

    await expect(executeAwsAmiRelease(request(), adapter)).rejects.toThrow(
      'requires proof the scanner covered the image',
    );
    expect(adapter.calls).not.toContain('publish-manifest');
    expect(adapter.calls).not.toContain('activate-pins');
  });

  it('fails closed before publication when a required guest tool or exact KMS policy is absent', async () => {
    const missingTool = new FakeAdapter();
    missingTool.missingTool = 'amazon-ssm-agent';
    await expect(executeAwsAmiRelease(request(), missingTool)).rejects.toThrow('missing guest tool amazon-ssm-agent');
    expect(missingTool.calls).not.toContain('activate-pins');

    const wrongKms = new FakeAdapter();
    wrongKms.badKmsRegion = 'us-west-2';
    await expect(executeAwsAmiRelease(request(), wrongKms)).rejects.toThrow('not encrypted with the target KMS key');
    expect(wrongKms.calls).not.toContain('publish-manifest');
  });

  it('fails closed before publication when a shared account has no matching KMS grant', async () => {
    const missingGrant = new FakeAdapter();
    missingGrant.missingKmsGrantAccountId = CLEAN_ACCOUNT;
    await expect(executeAwsAmiRelease(request(), missingGrant)).rejects.toThrow(
      'is missing a KMS share grant for an explicitly shared account',
    );
    expect(missingGrant.calls).not.toContain('publish-manifest');
    expect(missingGrant.calls).not.toContain('activate-pins');
  });

  it('does not pin or deprecate when clean-account teardown leaves residue', async () => {
    const adapter = new FakeAdapter();
    adapter.proofResidue = ['i-canary-left-running'];
    await expect(executeAwsAmiRelease(request(), adapter)).rejects.toThrow('zero residue');
    expect(adapter.calls).not.toContain('publish-manifest');
    expect(adapter.calls).not.toContain('activate-pins');
    expect(adapter.calls.some((call) => call.startsWith('deprecate:'))).toBe(false);
  });

  it('does not publish when the canary cannot confirm data-volume deletion', async () => {
    const adapter = new FakeAdapter();
    adapter.proofOverride = (proof) => ({ ...proof, dataVolumeDeleted: false });
    await expect(executeAwsAmiRelease(request(), adapter)).rejects.toThrow('confirmed instance and data-volume teardown');
    expect(adapter.calls).not.toContain('publish-manifest');
    expect(adapter.calls).not.toContain('activate-pins');
  });

  it('hands the canary the canonical clean-room fixture whose script matches its own digest (WI-10005604)', async () => {
    const adapter = new FakeAdapter();
    await executeAwsAmiRelease(request(), adapter);
    const fixture = adapter.canaryFixture!;
    expect(fixture.bootstrapInput.hostId).toMatch(/^aws-clean-ami-/);
    expect(fixture.fixtureId).toContain(VERSION);
    expect(createHash('sha256').update(fixture.bootstrapScript, 'utf8').digest('hex')).toBe(
      fixture.bootstrapScriptSha256,
    );
    expect(adapter.manifest?.cleanAccountProof.fixtureId).toBe(fixture.fixtureId);
  });

  it('does not publish when the canary ran a different fixture than the release built', async () => {
    const adapter = new FakeAdapter();
    adapter.proofOverride = (proof) => ({ ...proof, fixtureId: 'some-other-fixture' });
    await expect(executeAwsAmiRelease(request(), adapter)).rejects.toThrow('different fixture');
    expect(adapter.calls).not.toContain('publish-manifest');
  });

  it('does not publish when the canary attestation is unhealthy or does not match the fixture', async () => {
    const unhealthy = new FakeAdapter();
    unhealthy.proofOverride = (proof) => ({ ...proof, attestation: { ...proof.attestation, status: 'degraded' as never } });
    await expect(executeAwsAmiRelease(request(), unhealthy)).rejects.toThrow('healthy bootstrap attestation');
    expect(unhealthy.calls).not.toContain('publish-manifest');

    const forged = new FakeAdapter();
    forged.proofOverride = (proof) => ({ ...proof, attestation: { ...proof.attestation, hostId: 'aws-clean-ami-forged' } });
    await expect(executeAwsAmiRelease(request(), forged)).rejects.toThrow('attestation failed validation');
    expect(forged.calls).not.toContain('activate-pins');
  });

  it('accepts a proof from the real canary orchestration over the release-built fixture (WI-10005604)', async () => {
    const observedAt = '2026-08-23T01:30:00.000Z';
    class RealCanaryAdapter extends FakeAdapter {
      override async launchCleanAccountCanary(input: Parameters<AwsAmiReleaseAdapter['launchCleanAccountCanary']>[0]) {
        this.calls.push(`canary:${input.region}`);
        // The bin's parser must accept the TS-built fixture as-is; only the fake ids are swapped
        // for well-formed ones so its id shape checks pass, then restored for the binding.
        const parsed = parseAwsAmiCanaryInput({ ...input, imageId: 'ami-0123456789abcdef0', subnetId: 'subnet-0123456789abcdef0' });
        const bound = { ...parsed, imageId: input.imageId, subnetId: input.subnetId };
        const marker = `${CANARY_ATTESTATION_PREFIX}${Buffer.from(
          JSON.stringify(workspaceHostCleanRoomFixtureAttestation(input.fixture, observedAt)),
        ).toString('base64')}\n`;
        const sent: string[] = [];
        let state = 'running';
        let clock = 0;
        let dataVolumeState = 'none';
        let attachmentState: string | null = null;
        let attachedInstanceId: string | null = null;
        let bootstrapPushed = false;
        const observed = await runAwsAmiCleanAccountCanary(bound, {
          runId: () => 'roundtrip',
          now: () => clock,
          sleep: async (ms) => { clock += ms; },
          callerAccount: async () => input.accountId,
          describeImage: async () => ({ state: 'available', architecture: 'x86_64' }),
          describeSubnet: async (subnetId) => ({ subnetId, availabilityZone: 'us-east-1a' }),
          createDataVolume: async () => { dataVolumeState = 'available'; return 'vol-0123456789abcdef0'; },
          describeVolume: async () => ({
            state: dataVolumeState,
            ...(attachmentState ? { attachmentState } : {}),
            ...(attachedInstanceId ? { attachedInstanceId } : {}),
          }),
          attachVolume: async ({ instanceId }) => { dataVolumeState = 'in-use'; attachmentState = 'attached'; attachedInstanceId = instanceId; },
          detachVolume: async () => { dataVolumeState = 'available'; attachmentState = null; attachedInstanceId = null; },
          deleteVolume: async () => { dataVolumeState = 'deleted'; },
          runInstance: async () => 'i-0roundtrip',
          describeInstance: async () => ({ state, publicIpv4: null }),
          ssmPingStatus: async () => 'Online',
          consoleOutput: async () => bootstrapPushed ? `${WORKSPACE_HOST_BOOTSTRAP_STATUS_CONSOLE_MARKER} succeeded\n` : null,
          sendCommand: async ({ commands }) => {
            sent.push(commands.join('\n'));
            if (commands.join('\n').includes('systemd-run --unit=')) bootstrapPushed = true;
            return String(sent.length - 1);
          },
          getInvocation: async ({ commandId }) => {
            const commands = sent[Number(commandId)];
            if (commands.includes('grep ')) return { status: 'Success', stdout: marker };
            if (commands.includes('systemctl is-active')) return { status: 'Success', stdout: 'active\n' };
            return { status: 'Success', stdout: '' };
          },
          terminate: async () => {
            state = 'terminated';
          },
          censusByRunTag: async () => [],
        });
        return buildAwsAmiCanaryProof(bound, observed, observedAt) as unknown as AwsAmiCleanAccountLaunchProof;
      }
    }
    const adapter = new RealCanaryAdapter();
    await executeAwsAmiRelease(request(), adapter);
    expect(adapter.manifest?.cleanAccountProof.evidenceRef).toMatch(/^aws-ami-canary:i-0roundtrip:/);
    expect(adapter.calls).toContain('publish-manifest');
  });

  it('does not start a Packer build when the common release gate is red', async () => {
    const bad = request();
    bad.releaseGate.trustReport = { ...bad.releaseGate.trustReport, trusted: false };
    const adapter = new FakeAdapter();
    await expect(executeAwsAmiRelease(bad, adapter)).rejects.toThrow(AwsAmiReleaseError);
    expect(adapter.calls).toEqual([]);
  });
});
