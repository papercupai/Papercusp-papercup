import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * The repository root, derived from this module's own location rather than process.cwd().
 * Vitest runs this file with the workspace package as cwd, so both the fixture read and
 * the adapter's `repositoryRoot` must be anchored here or the repo-relative template path
 * resolves under packages/operator-core/ and fails with ENOENT.
 */
const REPO_ROOT_URL = new URL('../../../../', import.meta.url);
const REPO_ROOT = fileURLToPath(REPO_ROOT_URL);

/**
 * True when a packer `execute_command` expands `{{ .Vars }}` inside a single-quoted region.
 *
 * Packer renders .Vars ALREADY QUOTED (`KEY='value' KEY2='value2' `), so an outer `'…'` wrapper
 * splices those inner quotes into its own pair and the remote shell re-tokenises the result.
 * Counting quotes rather than matching a known-bad literal keeps the check true for any
 * rewording of the command. See the guard test below for the two failure modes it prevents.
 */
function varsIsNested(executeCommand: string): boolean {
  const varsAt = executeCommand.indexOf('{{ .Vars }}');
  if (varsAt < 0) return false;
  const quotesBefore = (executeCommand.slice(0, varsAt).match(/'/g) ?? []).length;
  return quotesBefore % 2 === 1;
}

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
  buildWorkspaceHostCleanRoomInstallFixture,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostRequiredReleaseMaterialFixtures,
  workspaceHostCleanRoomFixtureAttestation,
  type WorkspaceHostCleanRoomAcceptanceReport,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';

import {
  GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
  GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
  type GcpImageFamilyReleaseContext,
} from './gcp-image-family';
import {
  GoogleComputeGcpImageFamilyReleaseAdapter,
  NodeGcpImageFamilyCommandRunner,
  parseGcpImageFamilyPackerOutput,
  parseGcpImageFamilyProvenance,
  type GcpImageFamilyCleanRoomRunInput,
  type GcpImageFamilyCommandResult,
  type GcpImageFamilyCommandRunner,
  type GcpImageFamilyComputeApi,
  type GcpImageFamilyComputeImage,
  type GcpImageFamilyReleaseAdapterOptions,
  type GcpImageFamilyScanRunner,
} from './gcp-image-family-adapter';
import {
  CredentialScopedGcpImageFamilyCommandRunner,
  safeGcpImageFamilyCommandEnvironment,
} from './gcp-image-family-production';
import { gcpBaseImageIdentity, gcpBaseImageIdentityDigest } from './gcp-base-image-identity';
import { workspaceHostReleaseSubjectSha256 } from './bootc-bake-manifest';

const PROJECT = 'papercusp-images-123';
const FAMILY = 'papercusp-workspace-host';
const VERSION = '2026.8.28-1';
const RELEASE_SHA = 'a'.repeat(64);
const BASE_REFERENCE = `projects/${PROJECT}/global/images/ubuntu-base`;
/** What the Compute API returns for BASE_REFERENCE; ComputeFake is seeded with it. */
const BASE_IMAGE_RESOURCE: GcpImageFamilyComputeImage = {
  name: 'ubuntu-base',
  id: '7000000000000000001',
  creationTimestamp: '2026-08-01T00:00:00.000-07:00',
  state: 'ACTIVE',
};
/** Derived through the real measurement, so the manifest attests the image the adapter re-measures. */
const BASE_SHA = gcpBaseImageIdentityDigest(gcpBaseImageIdentity(BASE_REFERENCE, BASE_IMAGE_RESOURCE));
const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp test key\nRWQtestkey';
const SIGNING_KEY_SHA = createHash('sha256').update(SIGNING_PUBLIC_KEY).digest('hex');
const PUBLISHED_AT = '2026-08-28T00:00:00.000Z';
const CLEAN_ROOM_OBSERVED_AT = '2026-08-28T00:02:00.000Z';
const CANDIDATE_NAME = `papercusp-workspace-host-${VERSION.replaceAll('.', '-')}-candidate`;
const CANDIDATE_ID = `projects/${PROJECT}/global/images/${CANDIDATE_NAME}`;
const IMAGE_NAME = `papercusp-workspace-host-${VERSION.replaceAll('.', '-')}`;
const IMAGE_ID = `projects/${PROJECT}/global/images/${IMAGE_NAME}`;
const IAP_NETWORK = 'papercusp-clean-room-network';
const IAP_FIREWALL_RULE = {
  direction: 'INGRESS',
  disabled: false,
  sourceRanges: ['35.235.240.0/20'],
  allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
  targetTags: ['papercusp-clean-room'],
};

function gcloudPreflightResult(
  command: string,
  args: readonly string[],
): GcpImageFamilyCommandResult | undefined {
  if (command !== 'gcloud' || args[0] !== 'compute') return undefined;
  if (args[1] === 'networks' && args[2] === 'subnets' && args[3] === 'describe') {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ network: `projects/${PROJECT}/global/networks/${IAP_NETWORK}` }),
      stderr: '',
    };
  }
  if (args[1] === 'firewall-rules' && args[2] === 'list') {
    return { exitCode: 0, stdout: JSON.stringify([IAP_FIREWALL_RULE]), stderr: '' };
  }
  return undefined;
}

function artifact(templateSha256: string): WorkspaceHostImageArtifact {
  const manifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: { repository: 'https://github.com/Papercusp/papercusp.git', revision: '1'.repeat(40) },
    releaseArtifact: {
      name: `papercusp-server-${VERSION}.tgz`,
      version: VERSION,
      sha256: RELEASE_SHA,
      sizeBytes: 42_000,
    },
    baseImage: { reference: BASE_REFERENCE, architecture: 'x86_64', sha256: BASE_SHA },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: '1.14.2',
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      templateSha256,
    },
    materials: [
      { path: 'dist/papercusp-server.tgz', sha256: RELEASE_SHA, sizeBytes: 42_000 },
      ...workspaceHostRequiredReleaseMaterialFixtures(),
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'gcp', locations: [PROJECT] }],
  });
  const urls = deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_SHA);
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: IMAGE_ID, version: VERSION },
    buildManifest: manifest,
    release: {
      version: VERSION,
      bundleUrl: urls.bundleUrl,
      bundleSha256: RELEASE_SHA,
      signatureUrl: urls.signatureUrl,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signingKeySha256: SIGNING_KEY_SHA,
    },
    lifecycle: { state: 'active', publishedAt: PUBLISHED_AT },
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install', 'upgrade', 'rollback'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function bootcArtifact(templateSha256: string): Extract<WorkspaceHostImageArtifact, { hostModel: 'bootc-image' }> {
  const current = artifact(templateSha256);
  const { schemaVersion: _schemaVersion, manifestIdentity: _manifestIdentity, ...manifestInput } =
    current.buildManifest;
  return {
    ...current,
    hostModel: 'bootc-image',
    bootc: {
      image: `registry.example.com/papercusp/workspace-host:${VERSION}`,
      imageDigest: `sha256:${'9'.repeat(64)}`,
      baseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      signaturePolicyPath: WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
    },
    buildManifest: buildWorkspaceHostBuildManifest({
      ...manifestInput,
      baseImage: {
        reference: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        architecture: 'x86_64',
        sha256: BASE_SHA,
      },
      builder: {
        strategy: 'shared',
        kind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        version: 'latest',
        templatePath: 'infra/images/bootc/workspace-host.Containerfile',
        templateSha256,
      },
    }),
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        hostModel: 'bootc-image',
        bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install', 'upgrade', 'rollback'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function provenance(
  sourceCandidateImageId?: string,
  buildManifestIdentity = CONTEXT.artifact.buildManifest.manifestIdentity,
): string {
  return JSON.stringify({
    contractVersion: GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
    buildManifestIdentity,
    releaseVersion: VERSION,
    releaseSha256: RELEASE_SHA,
    architecture: 'x86_64',
    guestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => ({ name, version: '1.0' })),
    ...(sourceCandidateImageId ? { sourceCandidateImageId } : {}),
  });
}

const TEMPLATE_SHA = '0'.repeat(64);
const CONTEXT_ARTIFACT = artifact(TEMPLATE_SHA);
const CONTEXT_FIXTURE = buildWorkspaceHostCleanRoomInstallFixture(CONTEXT_ARTIFACT, {
  fixtureId: 'adapter-test-fixture',
  action: 'install',
  provider: 'gcp',
  architecture: 'x86_64',
  observedAt: PUBLISHED_AT,
  hostId: 'adapter-test-host',
  migrationId: 'migration-1',
  minimumNodeMajor: 22,
  service: { name: 'papercusp-workspace', port: 3070 },
});
const CONTEXT_ATTESTATION = workspaceHostCleanRoomFixtureAttestation(CONTEXT_FIXTURE, '2026-08-28T00:01:00.000Z');
const CONTEXT: GcpImageFamilyReleaseContext = {
  artifact: CONTEXT_ARTIFACT,
  request: {
    releaseGate: {
      artifact: CONTEXT_ARTIFACT,
      trustReport: {} as never,
      compatibilityRequest: {
        action: 'install',
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        observedAt: PUBLISHED_AT,
      },
      cleanRoomReport: {
        contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
        fixtureId: CONTEXT_FIXTURE.fixtureId,
        image: CONTEXT_ARTIFACT.image,
        passed: true,
        checks: [
          'artifact-identity',
          'compatibility-matrix',
          'deterministic-bootstrap-fixture',
          'exact-bootstrap-attestation',
        ],
        issues: [],
        bootstrapScriptSha256: CONTEXT_FIXTURE.bootstrapScriptSha256,
        attestation: CONTEXT_ATTESTATION,
      } satisfies WorkspaceHostCleanRoomAcceptanceReport,
    },
    projectId: PROJECT,
    family: FAMILY,
    publishedAt: PUBLISHED_AT,
    cleanRoom: {
      zone: 'us-central1-a',
      serviceAccountEmail: `workspace-host@${PROJECT}.iam.gserviceaccount.com`,
      subnetwork: `projects/${PROJECT}/regions/us-central1/subnetworks/clean-room`,
    },
  },
};

class ComputeFake implements GcpImageFamilyComputeApi {
  readonly images = new Map<string, GcpImageFamilyComputeImage>([[BASE_IMAGE_RESOURCE.name, BASE_IMAGE_RESOURCE]]);
  readonly inserts: Array<{
    projectId: string;
    input: Parameters<NonNullable<GcpImageFamilyComputeApi['insertImage']>>[1];
  }> = [];
  readonly deprecations: unknown[] = [];
  familyImage?: GcpImageFamilyComputeImage;

  async getImage(_projectId: string, imageName: string): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.images.get(imageName);
  }

  async getFamilyImage(): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.familyImage;
  }

  async insertImage(projectId: string, input: Parameters<NonNullable<GcpImageFamilyComputeApi['insertImage']>>[1]) {
    this.inserts.push({ projectId, input });
    const image: GcpImageFamilyComputeImage = {
      name: input.name,
      family: input.family,
      description: input.description,
      labels: input.labels,
      architecture: 'X86_64',
      state: 'ACTIVE',
    };
    this.images.set(input.name, image);
    this.familyImage = image;
    return image;
  }

  async deprecateImage(input: unknown): Promise<void> {
    this.deprecations.push(input);
  }
}

function baseOptions(
  compute: ComputeFake,
  overrides: Partial<GcpImageFamilyReleaseAdapterOptions> = {},
): GcpImageFamilyReleaseAdapterOptions {
  return {
    compute,
    guestToolVersions: Object.fromEntries(GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => [name, '1.0'])),
    // Keep fixture freshness deterministic instead of aging against the wall clock.
    now: () => CLEAN_ROOM_OBSERVED_AT,
    ...overrides,
  };
}

describe('GCP image-family production adapter', () => {
  it('parses machine-readable Packer output and rejects malformed provenance', () => {
    expect(
      parseGcpImageFamilyPackerOutput(`artifact,0,id,gce,${PROJECT}/${CANDIDATE_NAME}\n`, PROJECT, CANDIDATE_NAME),
    ).toBe(CANDIDATE_ID);
    expect(parseGcpImageFamilyProvenance(provenance())).toMatchObject({
      contractVersion: GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
      releaseVersion: VERSION,
    });
    expect(() => parseGcpImageFamilyProvenance('{}')).toThrow('contract');
  });

  it('pins the template, runs Packer without a shell, scans real evidence, and inspects the candidate', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL));
    const templateHash = createHash('sha256').update(template).digest('hex');
    const candidateArtifact = artifact(templateHash);
    const context = {
      ...CONTEXT,
      artifact: candidateArtifact,
      request: { ...CONTEXT.request, releaseGate: { ...CONTEXT.request.releaseGate, artifact: candidateArtifact } },
    };
    const compute = new ComputeFake();
    const calls: Array<{ command: string; args: readonly string[]; options?: unknown }> = [];
    const commandRunner = {
      run: vi.fn(
        async (command: string, args: readonly string[], options?: unknown): Promise<GcpImageFamilyCommandResult> => {
          calls.push({ command, args, options });
          if (args[0] === 'build') {
            compute.images.set(CANDIDATE_NAME, {
              name: CANDIDATE_NAME,
              description: provenance(undefined, candidateArtifact.buildManifest.manifestIdentity),
              architecture: 'X86_64',
              state: 'ACTIVE',
            });
          }
          const gcloud = gcloudPreflightResult(command, args);
          if (gcloud) return gcloud;
          return {
            exitCode: 0,
            stdout:
              args[0] === 'build'
                ? `artifact,0,id,gce,${PROJECT}/${CANDIDATE_NAME}`
                : // `auth` is the ADC probe: it must mint a non-empty token or the build refuses
                  // to start. See the ADC guard test below.
                  args[0] === 'auth'
                  ? 'ya29.test-adc-token'
                  : '',
            stderr: '',
          };
        },
      ),
    };
    const scanRunner: GcpImageFamilyScanRunner = {
      run: async (input) => ({
        imageId: input.imageId,
        buildManifestIdentity: input.buildManifestIdentity,
        releaseSha256: input.releaseSha256,
        trusted: true,
        sbomSha256: 'd'.repeat(64),
        // A realistic scanner result carries sub-threshold findings plus the
        // breakdown that accounts for them. Zero here would let this path pass
        // without ever exercising the severity policy the adapter now applies.
        vulnerabilityFindings: 3,
        vulnerabilityBySeverity: { Low: 2, Negligible: 1 },
        secretFindings: 0,
        // Coverage proof, for the same reason as the findings above: without it this
        // path would assert the adapter accepts a scan that never showed it mounted
        // the candidate — which GCP_IMAGE_SCAN_POLICY now correctly denies.
        mountedFilesystems: 3,
        candidateRootProof: '/mnt/candidate/sda1/etc/os-release',
        // SCOPE ATTRIBUTION, for the same reason as the two blocks above: GCP_IMAGE_SCAN_POLICY
        // judges the 'papercusp-bundled' scope, and it earns that scoped verdict by PROOF rather
        // than by the fields merely being present. Omitting them does not make this fixture
        // "simpler" — it makes the adapter fail closed on an unattributed scan, so this path
        // would stop exercising the scoped arithmetic at all.
        //
        // The numbers are chosen to satisfy the partition-completeness proof exactly, because a
        // fixture that only just squeaks past it would not notice if that proof were weakened:
        //   vulnerabilityByScope sums to vulnerabilityFindings (1 + 2 = 3)
        //   vulnerabilityCriticalHighByScope sums to the at/above-threshold count derived
        //     INDEPENDENTLY from vulnerabilityBySeverity above (Low 2 + Negligible 1 = 0 high)
        //   secretsByScope sums to secretFindings (0 + 0 = 0)
        // Both scope labels are written explicitly, including the zeros: a partition stated as
        // half a partition is what the totality check exists to catch.
        vulnerabilityByScope: { 'papercusp-bundled': 1, 'inherited-base-image': 2 },
        vulnerabilityCriticalHighByScope: { 'papercusp-bundled': 0, 'inherited-base-image': 0 },
        secretsByScope: { 'papercusp-bundled': 0, 'inherited-base-image': 0 },
        // The denominator that makes an empty bundled bucket falsifiable: >= 1 cataloged package
        // is what separates "we looked at the bundle and it is clean" from "we never found it".
        bundleCatalogedArtifacts: 289,
        evidenceRef: 'gcp://scan/evidence-1',
      }),
    };
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute, {
        repositoryRoot: REPO_ROOT,
        commandRunner,
        scanRunner,
      }),
    );
    await adapter.bindReleaseContext(context);
    const built = await adapter.buildCandidate({
      projectId: PROJECT,
      candidateImageName: CANDIDATE_NAME,
      builderKind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
      releaseVersion: VERSION,
      releaseSha256: RELEASE_SHA,
      architecture: 'x86_64',
      requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
    });
    expect(built.imageId).toBe(CANDIDATE_ID);
    // `validate` sits between init and build ON PURPOSE — it evaluates the template with the
    // real variables, so an unknown function or a false validation condition fails here in a
    // second instead of after a builder VM has been created. See the buildCandidate comment.
    // `auth` sits FIRST on purpose: it proves Application Default Credentials — the credential
    // packer actually authenticates with — can still mint a token, before init/validate/build
    // spend anything. See the ADC recurrence guard below.
    expect(calls.map((call) => `${call.command}:${call.args[0]}`)).toEqual([
      'gcloud:compute',
      'gcloud:compute',
      'gcloud:auth',
      'packer:init',
      'packer:validate',
      'packer:build',
    ]);
    const validateCall = calls[4];
    const buildCall = calls[5];
    expect(buildCall?.args).not.toContain('--shell');
    // The evaluation is worthless unless it evaluates the SAME variables the build uses: a
    // validate run with different (or no) vars can pass while the build it is guarding fails.
    const varsOf = (args: readonly string[] | undefined): string[] =>
      (args ?? []).filter((_, index) => args?.[index - 1] === '-var');
    expect(varsOf(validateCall?.args)).toEqual(varsOf(buildCall?.args));
    expect(varsOf(validateCall?.args).length).toBeGreaterThan(0);
    expect(varsOf(validateCall?.args).find((value) => value.startsWith('builder_network_tags='))).toBe(
      'builder_network_tags=["papercusp-clean-room"]',
    );
    const scan = await adapter.scanImage({
      projectId: PROJECT,
      subnetwork: context.request.cleanRoom.subnetwork,
      imageId: CANDIDATE_ID,
      buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
      releaseSha256: RELEASE_SHA,
    });
    expect(scan.trusted).toBe(true);
    expect(await adapter.inspectImage(PROJECT, CANDIDATE_ID)).toMatchObject({
      imageId: CANDIDATE_ID,
      state: 'ACTIVE',
      architecture: 'x86_64',
    });
  });

  it('imports the digest-checked GCE disk for bootc instead of invoking Packer', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'papercusp-bootc-gce-'));
    try {
      const disk = join(temporary, 'disk.raw');
      const bytes = Buffer.from('bootc-gce-disk-fixture');
      await writeFile(disk, bytes);
      const template = await readFile(new URL('infra/images/bootc/workspace-host.Containerfile', REPO_ROOT_URL));
      const candidateArtifact = bootcArtifact(createHash('sha256').update(template).digest('hex'));
      const context: GcpImageFamilyReleaseContext = {
        ...CONTEXT,
        artifact: candidateArtifact,
        request: {
          ...CONTEXT.request,
          releaseGate: { ...CONTEXT.request.releaseGate, artifact: candidateArtifact },
        },
      };
      const compute = new ComputeFake();
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      const commandRunner: GcpImageFamilyCommandRunner = {
        run: async (command, args = []) => {
          const executable = typeof command === 'string' ? command : command.command;
          const argv = typeof command === 'string' ? args : command.args;
          calls.push({ command: executable, args: argv });
          if (argv[0] === 'compute' && argv[1] === 'images' && argv[2] === 'import') {
            const description = argv.find((entry) => entry.startsWith('--description='))?.slice('--description='.length);
            compute.images.set(CANDIDATE_NAME, {
              name: CANDIDATE_NAME,
              description,
              architecture: 'X86_64',
              state: 'ACTIVE',
            });
          }
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      };
      const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
        baseOptions(compute, { repositoryRoot: REPO_ROOT, commandRunner }),
      );
      await adapter.bindReleaseContext(context);
      const built = await adapter.buildCandidate({
        projectId: PROJECT,
        candidateImageName: CANDIDATE_NAME,
        builderKind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        templatePath: 'infra/images/bootc/workspace-host.Containerfile',
        bootcArtifact: {
          cloud: 'gcp',
          type: 'gce',
          artifact: disk,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.byteLength,
        },
        buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
        releaseVersion: VERSION,
        releaseSha256: '9'.repeat(64),
        architecture: 'x86_64',
        requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
      });
      expect(built.imageId).toBe(CANDIDATE_ID);
      expect(calls.some((call) => call.command.includes('packer'))).toBe(false);
      expect(calls).toContainEqual(
        expect.objectContaining({
          command: 'gcloud',
          args: expect.arrayContaining([
            'compute',
            'images',
            'import',
            CANDIDATE_NAME,
            `--source-file=${disk}`,
            '--os=centos-stream-9',
          ]),
        }),
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('refuses before ADC or Packer when no IAP firewall rule admits the template builder tag', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL));
    const candidateArtifact = artifact(createHash('sha256').update(template).digest('hex'));
    const context = {
      ...CONTEXT,
      artifact: candidateArtifact,
      request: { ...CONTEXT.request, releaseGate: { ...CONTEXT.request.releaseGate, artifact: candidateArtifact } },
    };
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const commandRunner: GcpImageFamilyCommandRunner = {
      run: async (command, args = []) => {
        calls.push({ command: typeof command === 'string' ? command : command.command, args });
        if (typeof command === 'string' && args[0] === 'compute' && args[1] === 'firewall-rules') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ ...IAP_FIREWALL_RULE, targetTags: ['unrelated-builder-tag'] }]),
            stderr: '',
          };
        }
        if (typeof command === 'string') {
          return (
            gcloudPreflightResult(command, args) ?? {
              exitCode: args[0] === 'auth' ? 0 : 1,
              stdout: args[0] === 'auth' ? 'ya29.test-adc-token' : '',
              stderr: '',
            }
          );
        }
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    };
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(new ComputeFake(), { repositoryRoot: REPO_ROOT, commandRunner }),
    );
    await adapter.bindReleaseContext(context);

    await expect(
      adapter.buildCandidate({
        projectId: PROJECT,
        candidateImageName: CANDIDATE_NAME,
        builderKind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
        templatePath: 'infra/images/workspace-host.pkr.hcl',
        buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
        releaseVersion: VERSION,
        releaseSha256: RELEASE_SHA,
        architecture: 'x86_64',
        requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
      }),
    ).rejects.toThrow(/GCP IAP firewall preflight found no INGRESS tcp:22 rule/);
    expect(calls.map((call) => `${call.command}:${call.args[0]}`)).toEqual(['gcloud:compute', 'gcloud:compute']);
  });

  /**
   * WI-10005746: `base_image_sha256` is recorded in the image provenance as fact, so the adapter
   * re-measures the image Packer will actually boot and refuses a mismatch before ANY command
   * (no IAP probe, no ADC mint, no packer init). Two ways the attested digest stops describing the
   * build: the named image was deleted and recreated (same name, new id), or the `sourceImage`
   * override points at a different image than the manifest measured.
   */
  it.each([
    {
      name: 'the named base image was recreated under the same name',
      compute: () => {
        const compute = new ComputeFake();
        compute.images.set('ubuntu-base', { ...BASE_IMAGE_RESOURCE, id: '7000000000000000002' });
        return compute;
      },
      sourceImage: undefined,
    },
    {
      name: 'the sourceImage override points at a different image',
      compute: () => {
        const compute = new ComputeFake();
        compute.images.set('other-base', { ...BASE_IMAGE_RESOURCE, name: 'other-base', id: '7000000000000000003' });
        return compute;
      },
      sourceImage: `projects/${PROJECT}/global/images/other-base`,
    },
  ])('refuses before any command when $name', async ({ compute, sourceImage }) => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL));
    const candidateArtifact = artifact(createHash('sha256').update(template).digest('hex'));
    const context = {
      ...CONTEXT,
      artifact: candidateArtifact,
      request: { ...CONTEXT.request, releaseGate: { ...CONTEXT.request.releaseGate, artifact: candidateArtifact } },
    };
    const calls: string[] = [];
    const commandRunner: GcpImageFamilyCommandRunner = {
      run: async (command, args = []) => {
        calls.push(`${typeof command === 'string' ? command : command.command}:${args.join(' ')}`);
        return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
      },
    };
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute(), {
        repositoryRoot: REPO_ROOT,
        commandRunner,
        ...(sourceImage ? { sourceImage } : {}),
      }),
    );
    await adapter.bindReleaseContext(context);

    await expect(
      adapter.buildCandidate({
        projectId: PROJECT,
        candidateImageName: CANDIDATE_NAME,
        builderKind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
        templatePath: 'infra/images/workspace-host.pkr.hcl',
        buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
        releaseVersion: VERSION,
        releaseSha256: RELEASE_SHA,
        architecture: 'x86_64',
        requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
      }),
    ).rejects.toThrow(/refusing to build from an image the release did not measure/);
    expect(calls).toEqual([]);
  });

  /**
   * Recurrence guard for EI-21762126059344308.
   *
   * `packer build` runs with `-machine-readable`, and in that mode packer writes its ENTIRE
   * event stream — `ui,error` records included — to STDOUT, leaving stderr empty. assertSuccess
   * used to quote stderr only, so a failed production release reported exactly
   * `packer build failed with exit code 1` and nothing else. That is the dangerous shape: not
   * a truncated-looking message, but a confident one, indistinguishable from a command that
   * genuinely had nothing to say. It cost a billable build and a wake to re-derive.
   *
   * The stdout-only case is therefore the one asserted here; a stderr-only failure would have
   * passed against the BROKEN code too, so a test of that direction alone proves nothing.
   */
  it('surfaces a failure diagnostic written only to stdout, and says so explicitly when there is none', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL));
    const candidateArtifact = artifact(createHash('sha256').update(template).digest('hex'));
    const context = {
      ...CONTEXT,
      artifact: candidateArtifact,
      request: { ...CONTEXT.request, releaseGate: { ...CONTEXT.request.releaseGate, artifact: candidateArtifact } },
    };
    const PACKER_STDOUT_ERROR =
      '1787980033,,ui,error,Error: Call to unknown function\\n\\n  on ' +
      'infra/images/workspace-host.pkr.hcl line 216:\\n\\nThere is no function named "setsubtract".';

    const buildCandidate = async (
      run: (command: string, args: readonly string[]) => Promise<GcpImageFamilyCommandResult>,
    ): Promise<unknown> => {
      const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
        baseOptions(new ComputeFake(), { repositoryRoot: REPO_ROOT, commandRunner: { run } }),
      );
      await adapter.bindReleaseContext(context);
      return adapter.buildCandidate({
        projectId: PROJECT,
        candidateImageName: CANDIDATE_NAME,
        builderKind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
        templatePath: 'infra/images/workspace-host.pkr.hcl',
        buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
        releaseVersion: VERSION,
        releaseSha256: RELEASE_SHA,
        architecture: 'x86_64',
        requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
      });
    };

    // Stdout-only failure: the diagnostic MUST reach the thrown error.
    await expect(
      buildCandidate(async (_command, args) =>
        gcloudPreflightResult('gcloud', args) ??
          (args[0] === 'auth'
            ? { exitCode: 0, stdout: 'ya29.test-adc-token', stderr: '' }
            : args[0] === 'init'
              ? { exitCode: 0, stdout: '', stderr: '' }
              : { exitCode: 1, stdout: PACKER_STDOUT_ERROR, stderr: '' }),
      ),
    ).rejects.toThrow(/setsubtract/);

    // A genuinely silent failure must SAY it was silent, so "no diagnostic" stays
    // distinguishable from "the diagnostic was dropped" — the ambiguity that caused the bug.
    await expect(
      buildCandidate(async (_command, args) =>
        gcloudPreflightResult('gcloud', args) ??
          (args[0] === 'auth'
            ? { exitCode: 0, stdout: 'ya29.test-adc-token', stderr: '' }
            : args[0] === 'init'
              ? { exitCode: 0, stdout: '', stderr: '' }
              : { exitCode: 1, stdout: '', stderr: '' }),
      ),
    ).rejects.toThrow(/produced no output on either stream/);
  });

  /**
   * Recurrence guard for EI-21847008443626335 — the false-green credential preflight.
   *
   * The release resolves its own `cloudCredentialRef` (typically `gcloud://active-user`) and
   * probed THAT before building. But `packer build` is a subprocess that authenticates with
   * Application Default Credentials. Two different credentials; only the unused one was checked.
   * So a healthy active-user credential produced a green preflight while ADC was reauth-dead,
   * and the build died ~6s in reporting "All options for deriving the OSLogin user have been
   * exhausted" — which reads as an OS Login/IAM misconfiguration and sends the next reader off
   * to disable `use_os_login`, relaxing a deliberate hardening to work around an expired token.
   *
   * Both directions are asserted, and the SECOND is the one that matters. A probe that merely
   * shells out to gcloud inherits GOOGLE_APPLICATION_CREDENTIALS from the ambient environment
   * and answers from whatever service-account key that variable selects — reporting a healthy
   * ADC while ADC is dead. That is not a hypothetical: it is exactly how the operator-facing
   * re-check recorded on this bug reported ADC_OK, on the strength of which a Cloud NAT was
   * created and a build launched. A guard that only covers the both-dead case would pass
   * against that broken probe and prove nothing.
   */
  it('refuses to build when ADC cannot mint, and probes ADC through the credential-scoped environment', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL));
    const candidateArtifact = artifact(createHash('sha256').update(template).digest('hex'));
    const context = {
      ...CONTEXT,
      artifact: candidateArtifact,
      request: { ...CONTEXT.request, releaseGate: { ...CONTEXT.request.releaseGate, artifact: candidateArtifact } },
    };
    const build = async (commandRunner: GcpImageFamilyCommandRunner): Promise<unknown> => {
      const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
        baseOptions(new ComputeFake(), { repositoryRoot: REPO_ROOT, commandRunner }),
      );
      await adapter.bindReleaseContext(context);
      return adapter.buildCandidate({
        projectId: PROJECT,
        candidateImageName: CANDIDATE_NAME,
        builderKind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
        templatePath: 'infra/images/workspace-host.pkr.hcl',
        buildManifestIdentity: candidateArtifact.buildManifest.manifestIdentity,
        releaseVersion: VERSION,
        releaseSha256: RELEASE_SHA,
        architecture: 'x86_64',
        requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
      });
    };

    // 1. A dead ADC must stop the build BEFORE anything billable runs. `packer build` creates a
    //    builder VM, so failing at init/validate/build instead of here still costs a VM.
    const attempted: string[] = [];
    await expect(
      build({
        run: async (_command, args) => {
          const gcloud = gcloudPreflightResult('gcloud', args ?? []);
          if (gcloud) return gcloud;
          const step = args?.[0];
          attempted.push(String(step));
          return step === 'auth'
            ? { exitCode: 1, stdout: '', stderr: 'invalid_grant: reauth related error (invalid_rapt)' }
            : { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    ).rejects.toThrow(/Application Default Credentials cannot mint an access token/);
    expect(attempted).toEqual(['auth']);

    // 2. A credential that EXITS ZERO but mints nothing is still dead. gcloud can succeed while
    //    printing no token, and an exit-code-only check reads that as healthy.
    await expect(
      build({
        run: async (_command, args) =>
          gcloudPreflightResult('gcloud', args ?? []) ?? { exitCode: 0, stdout: '   ', stderr: '' },
      }),
    ).rejects.toThrow(/Application Default Credentials cannot mint an access token/);

    // 3. THE LOAD-BEARING ASSERTION. The probe must run under the same credential-scoped
    //    environment as packer, so it cannot be answered by an ambient service-account key.
    //    Here GOOGLE_APPLICATION_CREDENTIALS names a perfectly VALID key while the ADC chain is
    //    unusable — the precise shape that produced the false green. If the probe were ever
    //    re-routed around this runner (a bare exec, process.env, a separate gcloud call), the
    //    variable would survive into the child and this assertion would fail.
    const AMBIENT = {
      GOOGLE_APPLICATION_CREDENTIALS: '/keys/omp-vertex-service-account.json',
      GOOGLE_OAUTH_ACCESS_TOKEN: 'ya29.ambient-service-account-token',
      CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.ambient-service-account-token',
      UNRELATED_BUILD_VAR: 'kept',
    };
    // CALIBRATION — without this the assertions below could pass vacuously, because a fixture
    // that never sets the variable also yields `undefined`. This proves two things at once: the
    // ambient environment really does carry a service-account key, and the sanitiser is the
    // mechanism that removes it. Delete the stripping and this fails alongside the assertions,
    // rather than leaving them quietly true for the wrong reason.
    expect(AMBIENT.GOOGLE_APPLICATION_CREDENTIALS).toBe('/keys/omp-vertex-service-account.json');
    expect(safeGcpImageFamilyCommandEnvironment(AMBIENT).GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();

    const seen: Array<{ args: readonly string[]; env: Readonly<Record<string, string | undefined>> }> = [];
    const scoped = new CredentialScopedGcpImageFamilyCommandRunner(
      {
        run: async (command, args, options) => {
          seen.push({ args: args ?? [], env: (options?.env ?? {}) as Record<string, string | undefined> });
          const gcloud = gcloudPreflightResult(
            typeof command === 'string' ? command : command.command,
            args ?? (typeof command === 'string' ? [] : command.args),
          );
          if (gcloud) return gcloud;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      safeGcpImageFamilyCommandEnvironment(AMBIENT),
    );
    await expect(build(scoped)).rejects.toThrow(/Application Default Credentials cannot mint an access token/);
    const probe = seen.find((call) => call.args[0] === 'auth');
    expect(probe).toBeDefined();
    expect(probe?.args).toEqual(['auth', 'application-default', 'print-access-token', '--quiet']);
    expect(probe?.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(probe?.env.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
    expect(probe?.env.CLOUDSDK_AUTH_ACCESS_TOKEN).toBeUndefined();
    // The scoping is surgical, not a blanket wipe: ordinary build variables still reach the child.
    expect(probe?.env.UNRELATED_BUILD_VAR).toBe('kept');
  });

  /**
   * Recurrence guard for EI-21763610698235066.
   *
   * The builder was handed the fully-qualified `projects/<p>/global/images/<n>` reference, which
   * googlecompute forwards as the Compute API `image` field — and that field takes a BARE NAME:
   *   Error 400: Invalid value for field 'image': '...'. Must be a match of regex
   *   '[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?|[1-9][0-9]{0,19}', invalid
   *
   * This guard is TEXTUAL by necessity, and that is the interesting part. It cannot be written as
   * a behavioural test because nothing local can tell the two spellings apart: the release gate
   * accepts the manifest either way (a fully-qualified immutable id is exactly what it demands),
   * and `packer validate` — including the real-variable evaluation this file also guards — reports
   * `The configuration is valid.` for BOTH, because either value is a legal string in a field
   * typed as a string. The fault is an API contract, so it is only observable against the live
   * API, after a builder VM exists. Pinning the template text is the only check that costs
   * nothing.
   *
   * Both directions are asserted on purpose. The builder must NOT get the qualified reference,
   * AND the variable must still REQUIRE it: "fix" the first by loosening the variable to a bare
   * name and the build would work while silently discarding the immutable-base-image provenance
   * that baseImage.reference exists to carry, with family aliases waved through.
   */
  it('gives the googlecompute builder a bare image name plus a separate project id, while still requiring a fully-qualified reference', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const blockStart = template.indexOf('source "googlecompute"');
    expect(blockStart).toBeGreaterThan(-1);
    const builderBlock = template.slice(blockStart, template.indexOf('\n}\n', blockStart));

    // The exact defect: the qualified reference passed straight through to the builder.
    expect(builderBlock).not.toMatch(/^\s*source_image\s*=\s*var\.source_image\s*$/m);
    // Decomposed instead — name in source_image, project in its own field.
    expect(builderBlock).toMatch(/^\s*source_image\s*=\s*split\(/m);
    expect(builderBlock).toMatch(/^\s*source_image_project_id\s*=/m);

    // …and the variable itself still refuses anything but an immutable, fully-qualified id.
    expect(template).toMatch(/\^projects\/\[\^\/\]\+\/global\/images\/\[\^\/\]\+\$/);
  });

  /**
   * Recurrence guard for the dash/bash split (P-046, 2026-08-29).
   *
   * Every inline provisioner in this template opens with `set -Eeuo pipefail`, which is bash-only.
   * Packer's default `inline_shebang` is `/bin/sh` — dash on Ubuntu — so a shell provisioner that
   * does not override the interpreter dies on its FIRST line with
   *   /tmp/script_1326.sh: 2: set: Illegal option -o pipefail
   *
   * One of the seven blocks was missing its `execute_command`, and that is precisely why it
   * survived review: the other six set it, so the file reads as though a single shell is in use
   * throughout, and the odd one out is invisible unless you check every block. A per-block
   * invariant is cheap; noticing an absence in a uniform-looking list is not.
   *
   * The check is per-block rather than a count comparison on purpose — equal totals can be
   * reached with one block missing the setting and another carrying it twice.
   */
  it('runs every shell provisioner under bash, since they all use bash-only pipefail', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const blocks = template.split(/provisioner\s+"shell"\s*\{/).slice(1);
    expect(blocks.length).toBeGreaterThan(0);

    for (const [index, rest] of blocks.entries()) {
      // Bound each block at the start of the next provisioner so the search cannot run past it.
      const block = rest.split(/\n\s{0,2}provisioner\s+"/)[0] ?? '';
      const usesBashOnlySyntax = /set\s+-[A-Za-z]*o\s+pipefail|set\s+-[A-Za-z]*u[A-Za-z]*\s/.test(block);
      if (!usesBashOnlySyntax) continue;
      expect(
        /execute_command\s*=\s*"[^"]*\bbash\b/.test(block) || /inline_shebang\s*=\s*"[^"]*\bbash\b/.test(block),
        `shell provisioner #${String(index + 1)} uses bash-only syntax but does not force a bash interpreter, ` +
          'so packer will run it under /bin/sh (dash) and it will die on `set -o pipefail`',
      ).toBe(true);
    }
  });

  /**
   * Recurrence guard for the silent env-var truncation (P-046, 2026-08-29).
   *
   * Packer renders `{{ .Vars }}` ALREADY QUOTED — literally `KEY='value' KEY2='value2' `. So
   * nesting it inside another single-quoted string, as `sudo -E bash -c '{{ .Vars }} {{ .Path }}'`
   * does, splices those inner quotes into the outer pair and lets the remote shell re-tokenise
   * the result. What makes this worth a permanent guard is HOW it fails:
   *
   *   - a value containing a SPACE truncates the command at the first unquoted space, so
   *     `bash -c` receives only variable assignments. The script never runs and the exit code
   *     is 0. The build goes green having installed nothing.
   *   - a value containing a NEWLINE feeds line 2 to the shell as a command (exit 127).
   *
   * The first is the dangerous one: six builds died before ever reaching that provisioner, and
   * when one finally did, its success was indistinguishable from a real one. An image would
   * have shipped without its pinned guest tools AND without the version assertion that exists
   * to catch exactly that — while its provenance claimed both.
   *
   * The check counts quotes rather than pattern-matching a known-bad string, so it holds for
   * any rewording of the command; the correct shape puts `{{ .Vars }}` outside all quoting.
   */
  it('never nests packer-quoted {{ .Vars }} inside a quoted execute_command', async () => {
    // Controls first: a predicate that has never rejected anything is not known to reject the
    // real defect either, and this one is cheap to falsify permanently rather than by a one-off
    // probe against a mutated tree.
    expect(varsIsNested(`sudo -E bash -c '{{ .Vars }} {{ .Path }}'`), 'the exact P-046 defect').toBe(true);
    expect(varsIsNested(`sudo -E sh -c '{{ .Vars }} {{ .Path }}'`), 'the defect, reworded').toBe(true);
    expect(varsIsNested(`{{ .Vars }} sudo -E bash '{{ .Path }}'`), 'the corrected form').toBe(false);
    expect(varsIsNested(`chmod +x {{ .Path }}; {{ .Vars }} {{ .Path }}`), "packer's own default").toBe(false);

    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const blocks = template.split(/provisioner\s+"shell"\s*\{/).slice(1);
    expect(blocks.length).toBeGreaterThan(0);

    let checked = 0;
    for (const [index, rest] of blocks.entries()) {
      const block = rest.split(/\n\s{0,2}provisioner\s+"/)[0] ?? '';
      const command = /execute_command\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
      if (command === undefined || !command.includes('{{ .Vars }}')) continue;
      checked += 1;

      expect(
        varsIsNested(command),
        `shell provisioner #${String(index + 1)} expands {{ .Vars }} inside a single-quoted region ` +
          `(execute_command = "${command}"). Packer emits .Vars pre-quoted, so nesting it truncates ` +
          'any value containing a space — the script then never runs and still exits 0.',
      ).toBe(false);
    }

    // A guard that silently checked nothing is the exact failure mode this test is about.
    expect(checked, 'no execute_command referenced {{ .Vars }} — the guard measured nothing').toBeGreaterThan(0);
  });

  /**
   * Recurrence guard for WI-662195.
   *
   * Workspace-host images are templates, so SSH server host keys must be removed before
   * publication. The next boot regenerates them, while retaining them in the image makes
   * every cloned host present the same server identity. Match the actual inline command,
   * not the explanatory comment above it, so deleting the cleanup cannot leave a green test.
   */
  it('removes SSH server host keys from the final image-cleanup provisioner', async () => {
    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const blocks = template.split(/provisioner\s+"shell"\s*\{/).slice(1);
    expect(blocks.length, 'no shell provisioners found — the guard measured nothing').toBeGreaterThan(0);

    const finalCleanupBlock = blocks.at(-1)?.split(/\n\s{0,2}provisioner\s+"/)[0] ?? '';
    expect(
      finalCleanupBlock,
      'the final image-cleanup provisioner must remove build-specific SSH server host keys',
    ).toMatch(/^\s*"rm -f \/etc\/ssh\/ssh_host_\*",\s*$/m);
  });

  it('canonicalises the signing key before hashing it, instead of trusting transport to preserve bytes', async () => {
    // Writes a value straight out of the environment with no trailing-newline normalisation.
    const writesRawEnvValue = (line: string): boolean =>
      /printf\s+'%s'\s+\\?"\$SIGNING_PUBLIC_KEY\\?"\s*>/.test(line);
    // Strips all trailing newlines via $(...) and appends exactly one.
    const canonicalises = (line: string): boolean =>
      /printf\s+'%s\\+n'\s+\\?"\$\(printf\s+'%s'\s+\\?"\$SIGNING_PUBLIC_KEY\\?"\)\\?"/.test(line);

    // Controls, so a guard that can never reject anything cannot pass as protection.
    expect(
      writesRawEnvValue(`printf '%s' \\"$SIGNING_PUBLIC_KEY\\" > \\"$PUBLIC_KEY_PATH\\"`),
      'the exact r18c defect',
    ).toBe(true);
    expect(
      canonicalises(`printf '%s\\\\n' \\"$(printf '%s' \\"$SIGNING_PUBLIC_KEY\\")\\" > \\"$PUBLIC_KEY_PATH\\"`),
      'the corrected form',
    ).toBe(true);

    const template = await readFile(new URL('infra/images/workspace-host.pkr.hcl', REPO_ROOT_URL), 'utf8');
    const writes = template
      .split('\n')
      .filter((line) => line.includes('$SIGNING_PUBLIC_KEY') && line.includes('>'));

    expect(writes.length, 'no line writes the signing key — the guard measured nothing').toBeGreaterThan(0);
    for (const line of writes) {
      expect(
        writesRawEnvValue(line),
        'the signing key is written straight from the environment. Packer\'s {{ .Vars }} transport ' +
          'strips the trailing newline of a multi-line value, so the file lands one byte short and ' +
          'fails its digest check (measured: 113 bytes, expected 114). Canonicalise it instead.',
      ).toBe(false);
      expect(canonicalises(line), 'the signing key write must normalise to exactly one trailing newline').toBe(true);
    }
  });

  /**
   * A scan failure must arrive WITH its diagnosis, not just an exit code.
   *
   * Measured on P-046 (2026-08-29): the r18d release finally cleared the packer build — the
   * expensive part — and then died with exactly `GCP image scanner failed with exit code 1`
   * and nothing else. Both of the scanner's streams had been captured by the command runner
   * and then discarded by a hand-rolled exit check, so the only way to learn WHY was to spend
   * another full billable image build. That is the same defect, in the same file, that had
   * already cost three builds on the packer path hours earlier; the packer path was fixed by
   * routing through assertSuccess and this path was left behind.
   *
   * The guard therefore asserts the two properties that make a failure diagnosable — the
   * complete output is spilled to a named file, and BOTH streams reach it — rather than
   * asserting any particular wording, which would just re-freeze today's message.
   */
  it('spills the scanner and clean-room diagnosis instead of reporting a bare exit code', async () => {
    // Distinctive per-stream sentinels. A failure handler that keeps only the stream you
    // EXPECT the error on is precisely how the packer diagnosis vanished
    // (EI-21762126059344308), so each stream is checked for by name.
    const failing = (stdoutMark: string, stderrMark: string) => ({
      run: async () => ({ exitCode: 3, stdout: stdoutMark, stderr: stderrMark }),
    });

    const assertDiagnosable = async (message: string | null, stdoutMark: string, stderrMark: string) => {
      // Control: the call really did fail. Without this, a mistake below would pass
      // vacuously against a call that unexpectedly SUCCEEDED.
      expect(message).not.toBeNull();
      const text = message as string;

      // The exit code alone is what the old message carried — necessary, nowhere near enough.
      expect(text).toContain('exit code 3');

      // The property that actually matters: a named file holding the COMPLETE output.
      const spillMatch = text.match(/\[full output: ([^\]]+)\]/);
      expect(spillMatch).not.toBeNull();

      const spilled = await readFile((spillMatch as RegExpMatchArray)[1], 'utf8');
      // BOTH streams, not just the one a reader would guess the error went to.
      expect(spilled).toContain(stdoutMark);
      expect(spilled).toContain(stderrMark);
    };

    const capture = async (work: Promise<unknown>): Promise<string | null> =>
      work.then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    const scanAdapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(new ComputeFake(), { commandRunner: failing('SENTINEL_OUT_SCAN_9f2a', 'SENTINEL_ERR_SCAN_7c4b') }),
    );
    await scanAdapter.bindReleaseContext(CONTEXT);
    await assertDiagnosable(
      await capture(
        scanAdapter.scanImage({
          projectId: PROJECT,
          subnetwork: CONTEXT.request.cleanRoom.subnetwork,
          imageId: CANDIDATE_ID,
          buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
          releaseSha256: RELEASE_SHA,
        }),
      ),
      'SENTINEL_OUT_SCAN_9f2a',
      'SENTINEL_ERR_SCAN_7c4b',
    );

    const cleanAdapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(new ComputeFake(), {
        commandRunner: failing('SENTINEL_OUT_CLEAN_3d1e', 'SENTINEL_ERR_CLEAN_5b8f'),
      }),
    );
    await cleanAdapter.bindReleaseContext(CONTEXT);
    await assertDiagnosable(
      await capture(
        cleanAdapter.launchCleanRoomCanary({
          projectId: PROJECT,
          zone: 'us-central1-a',
          serviceAccountEmail: CONTEXT.request.cleanRoom.serviceAccountEmail,
          subnetwork: CONTEXT.request.cleanRoom.subnetwork,
          imageId: CANDIDATE_ID,
          buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
          releaseVersion: VERSION,
          releaseSha256: RELEASE_SHA,
        }),
      ),
      'SENTINEL_OUT_CLEAN_3d1e',
      'SENTINEL_ERR_CLEAN_5b8f',
    );
  });

  it('fails closed when scanner or clean-room evidence is missing or mismatched', async () => {
    const compute = new ComputeFake();
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute, {
        commandRunner: { run: async () => ({ exitCode: 127, stdout: '', stderr: 'scanner missing' }) },
      }),
    );
    await adapter.bindReleaseContext(CONTEXT);
    await expect(
      adapter.scanImage({
        projectId: PROJECT,
        subnetwork: CONTEXT.request.cleanRoom.subnetwork,
        imageId: CANDIDATE_ID,
        buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
        releaseSha256: RELEASE_SHA,
      }),
    ).rejects.toThrow('scanner failed');
    const cleanRunner = {
      run: async (input: GcpImageFamilyCleanRoomRunInput) => ({
        evidenceRef: 'gcp://clean-room/evidence-1',
        projectId: input.projectId,
        zone: input.zone,
        imageId: input.imageId,
        buildManifestIdentity: input.buildManifestIdentity,
        computeRunning: true,
        osLoginReady: true,
        publicIpv4Assigned: false,
        attestation: workspaceHostCleanRoomFixtureAttestation(input.fixture, CLEAN_ROOM_OBSERVED_AT),
        terminated: true,
        residualResourceIds: [],
        observedAt: CLEAN_ROOM_OBSERVED_AT,
        fixtureId: input.fixture.fixtureId,
        bootstrapScriptSha256: input.fixture.bootstrapScriptSha256,
      }),
    };
    const cleanAdapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute, { cleanRoomRunner: cleanRunner }),
    );
    await cleanAdapter.bindReleaseContext(CONTEXT);
    const proof = await cleanAdapter.launchCleanRoomCanary({
      projectId: PROJECT,
      zone: 'us-central1-a',
      serviceAccountEmail: CONTEXT.request.cleanRoom.serviceAccountEmail,
      subnetwork: CONTEXT.request.cleanRoom.subnetwork,
      imageId: CANDIDATE_ID,
      buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
      releaseVersion: VERSION,
      releaseSha256: RELEASE_SHA,
    });
    expect(proof.terminated).toBe(true);
    const badRunner = {
      run: async (input: GcpImageFamilyCleanRoomRunInput) => ({ ...(await cleanRunner.run(input)), imageId: IMAGE_ID }),
    };
    const badAdapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(compute, { cleanRoomRunner: badRunner }),
    );
    await badAdapter.bindReleaseContext(CONTEXT);
    await expect(
      badAdapter.launchCleanRoomCanary({
        projectId: PROJECT,
        zone: 'us-central1-a',
        serviceAccountEmail: CONTEXT.request.cleanRoom.serviceAccountEmail,
        subnetwork: CONTEXT.request.cleanRoom.subnetwork,
        imageId: CANDIDATE_ID,
        buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
        releaseVersion: VERSION,
        releaseSha256: RELEASE_SHA,
      }),
    ).rejects.toThrow('not bound');
  });

  it('accepts a bootc clean-room attestation against the bootc fixture it rendered (WI-10006586)', async () => {
    // The adapter used to re-build the expected bootstrap input field by field and drop
    // hostModel/bootc, so a healthy bootc boot was judged against the ubuntu default and refused.
    const bootc = bootcArtifact(TEMPLATE_SHA);
    const bootcContext: GcpImageFamilyReleaseContext = { ...CONTEXT, artifact: bootc };
    let seenFixture: GcpImageFamilyCleanRoomRunInput['fixture'] | undefined;
    const runner = {
      run: async (input: GcpImageFamilyCleanRoomRunInput) => {
        seenFixture = input.fixture;
        return {
          evidenceRef: 'gcp://clean-room/evidence-bootc',
          projectId: input.projectId,
          zone: input.zone,
          imageId: input.imageId,
          buildManifestIdentity: input.buildManifestIdentity,
          computeRunning: true,
          osLoginReady: true,
          publicIpv4Assigned: false,
          attestation: workspaceHostCleanRoomFixtureAttestation(input.fixture, CLEAN_ROOM_OBSERVED_AT),
          terminated: true,
          residualResourceIds: [],
          observedAt: CLEAN_ROOM_OBSERVED_AT,
          fixtureId: input.fixture.fixtureId,
          bootstrapScriptSha256: input.fixture.bootstrapScriptSha256,
        };
      },
    };
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(
      baseOptions(new ComputeFake(), { cleanRoomRunner: runner }),
    );
    await adapter.bindReleaseContext(bootcContext);
    const proof = await adapter.launchCleanRoomCanary({
      projectId: PROJECT,
      zone: 'us-central1-a',
      serviceAccountEmail: CONTEXT.request.cleanRoom.serviceAccountEmail,
      subnetwork: CONTEXT.request.cleanRoom.subnetwork,
      imageId: CANDIDATE_ID,
      buildManifestIdentity: bootc.buildManifest.manifestIdentity,
      releaseVersion: VERSION,
      releaseSha256: workspaceHostReleaseSubjectSha256(bootc),
    });
    expect(seenFixture?.bootstrapInput.hostModel).toBe('bootc-image');
    expect(proof.attestation.hostModel).toBe('bootc-image');
    expect(proof.terminated).toBe(true);
  });

  it('publishes an exact family member, resolves it, and deprecates by immutable replacement', async () => {
    const compute = new ComputeFake();
    const adapter = new GoogleComputeGcpImageFamilyReleaseAdapter(baseOptions(compute));
    await adapter.bindReleaseContext(CONTEXT);
    const published = await adapter.publishFamilyVersion({
      projectId: PROJECT,
      family: FAMILY,
      imageName: IMAGE_NAME,
      sourceCandidateImageId: CANDIDATE_ID,
      buildManifestIdentity: CONTEXT.artifact.buildManifest.manifestIdentity,
      releaseVersion: VERSION,
      releaseSha256: RELEASE_SHA,
    });
    expect(published).toEqual({
      projectId: PROJECT,
      family: FAMILY,
      imageId: IMAGE_ID,
      version: VERSION,
      sourceCandidateImageId: CANDIDATE_ID,
    });
    expect((await adapter.resolveFamily(PROJECT, FAMILY)).imageId).toBe(IMAGE_ID);
    await adapter.deprecateImage({
      projectId: PROJECT,
      imageId: IMAGE_ID,
      replacementImageId: CANDIDATE_ID,
      state: 'DEPRECATED',
    });
    expect(compute.deprecations).toHaveLength(1);
    expect(compute.inserts[0]?.input.sourceImage).toBe(CANDIDATE_ID);
  });
});

describe('NodeGcpImageFamilyCommandRunner abortOnStderr (WI-10006192)', () => {
  const runner = new NodeGcpImageFamilyCommandRunner();
  // coldsnap's line for a block that has used its last retry.
  const LOST = /\battempt (\d+)\/\1 failed\b/;

  it('stops the process at the first matching stderr line and keeps the output it captured', async () => {
    const started = Date.now();
    const result = await runner.run({
      command: '/bin/sh',
      args: ['-c', "echo 'attempt 2/5 failed' >&2; echo 'attempt 5/5 failed snap-0dead' >&2; exec sleep 30"],
      abortOnStderr: LOST,
      timeoutMs: 60_000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('attempt 5/5 failed snap-0dead');
    expect(result.stderr).toMatch(/stopped early: stderr matched/);
  });

  it('sees a match split across two stderr writes', async () => {
    const started = Date.now();
    const result = await runner.run({
      command: '/bin/sh',
      args: ['-c', "printf 'attempt 5/' >&2; sleep 0.3; printf '5 failed\\n' >&2; exec sleep 30"],
      abortOnStderr: LOST,
      timeoutMs: 60_000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
  });

  it('lets a run whose stderr never matches finish with its own exit code and output', async () => {
    const result = await runner.run({
      command: '/bin/sh',
      args: ['-c', "echo 'attempt 2/5 failed' >&2; echo done"],
      abortOnStderr: LOST,
    });
    expect(result).toEqual({ exitCode: 0, stdout: 'done\n', stderr: 'attempt 2/5 failed\n' });
  });

  it('accepts a global pattern without skipping a later match', async () => {
    const result = await runner.run({
      command: '/bin/sh',
      args: ['-c', "echo 'attempt 1/5 failed' >&2; sleep 0.2; echo 'attempt 5/5 failed' >&2; exec sleep 30"],
      abortOnStderr: /\battempt (\d+)\/\1 failed\b/g,
      timeoutMs: 60_000,
    });
    expect(result.stderr).toMatch(/stopped early/);
  });
});
