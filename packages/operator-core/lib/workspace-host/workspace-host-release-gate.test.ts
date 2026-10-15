import { createHash } from 'node:crypto';

import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  WORKSPACE_HOST_BUILDER_KINDS,
  WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS,
  WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostRequiredReleaseMaterialFixtures,
  buildWorkspaceHostCleanRoomInstallFixture,
  workspaceHostCleanRoomFixtureAttestation,
  type WorkspaceHostBuilderKind,
  type WorkspaceHostCleanRoomAcceptanceReport,
  type WorkspaceHostCleanRoomInstallSpec,
  type WorkspaceHostImageArtifact,
  type WorkspaceHostImageCompatibilityRequest,
} from '@papercusp/deployment-driver';
import { describe, expect, it } from 'vitest';

import { ARTIFACT_TRUST_PIPELINE_VERSION, type ArtifactTrustReport } from './artifact-trust';
import {
  WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
  type WorkspaceHostBootcBakeManifest,
} from './bootc-bake-manifest';
import { evaluateWorkspaceHostReleaseGate } from './workspace-host-release-gate';

const RELEASE_DIGEST = 'a'.repeat(64);
const SIGNING_PUBLIC_KEY = 'untrusted comment: Papercusp workspace-host release key\nRWQpublickey';
const SIGNING_KEY_DIGEST = createHash('sha256').update(SIGNING_PUBLIC_KEY, 'utf8').digest('hex');
const SBOM_DIGEST = 'b'.repeat(64);
const BOOTC_DIGEST = '9'.repeat(64);

// Taken from the contract's own kind union rather than restated: a builder kind added there
// without a case here would otherwise be untestable without a compile error to say so.
type BuilderOverride = Partial<{
  kind: WorkspaceHostBuilderKind;
  templatePath: string;
}>;

function artifact(version = '2026.8.22-1', builderOverride: BuilderOverride = {}): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: 'vm-release',
    source: {
      repository: 'https://github.com/Papercusp/papercusp.git',
      revision: '1'.repeat(40),
    },
    releaseArtifact: {
      name: `papercusp-server-${version}.tgz`,
      version,
      sha256: RELEASE_DIGEST,
      sizeBytes: 42_000,
    },
    baseImage: {
      reference: 'projects/papercusp-images-123/global/images/ubuntu-2404-minimal',
      architecture: 'x86_64',
      sha256: 'c'.repeat(64),
    },
    builder: {
      strategy: 'shared',
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: '1.14.2',
      templatePath: 'infra/images/workspace-host.pkr.hcl',
      templateSha256: 'd'.repeat(64),
      ...builderOverride,
    },
    materials: [
      {
        path: 'dist/papercusp-server.tgz',
        sha256: RELEASE_DIGEST,
        sizeBytes: 42_000,
      },
      // Derived from the release-gate contract, never restated: a shippable bundle must carry
      // every required material (the remote initializer executable among them), or the image
      // installs and reports healthy and then fails every initialization at the far end.
      ...workspaceHostRequiredReleaseMaterialFixtures(),
    ],
    parameters: [{ name: 'distribution_profile', value: 'vm-release' }],
    targets: [{ provider: 'gcp', locations: ['us-central1'] }],
  });
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: 'papercusp-workspace-host', version },
    buildManifest,
    release: {
      version,
      // Derived from the digest, not hand-authored against a hostname that does not resolve:
      // the canonical publication path is content-addressed, so the address and the integrity
      // check are the same value.
      bundleUrl: deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_DIGEST).bundleUrl,
      bundleSha256: RELEASE_DIGEST,
      signatureUrl: deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_DIGEST).signatureUrl,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signingKeySha256: SIGNING_KEY_DIGEST,
    },
    lifecycle: { state: 'active', publishedAt: '2026-08-22T00:00:00Z' },
    compatibility: [
      {
        provider: 'gcp',
        architecture: 'x86_64',
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ['install'],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function bootcArtifact(version = '2026.8.22-1'): Extract<WorkspaceHostImageArtifact, { hostModel: 'bootc-image' }> {
  const candidate = artifact(version, {
    kind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
    templatePath: 'infra/images/bootc/workspace-host.Containerfile',
  });
  return {
    ...candidate,
    hostModel: 'bootc-image',
    bootc: {
      image: `registry.example.com/papercusp/workspace-host:${version}`,
      imageDigest: `sha256:${BOOTC_DIGEST}`,
      baseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      signaturePolicyPath: WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
    },
    compatibility: candidate.compatibility.map((rule) => ({
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

function bootcBakeManifest(version = '2026.8.22-1'): WorkspaceHostBootcBakeManifest {
  const image = 'registry.example.com/papercusp/workspace-host';
  return {
    contractVersion: WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
    image,
    tag: version,
    digest: `sha256:${BOOTC_DIGEST}`,
    pinnedRef: `${image}@sha256:${BOOTC_DIGEST}`,
    registryNamespace: 'registry.example.com/papercusp',
    release: { version },
    clouds: [
      { cloud: 'gcp', type: 'gce', artifact: '/release/gcp/disk.raw', sha256: '1'.repeat(64), sizeBytes: 101 },
      { cloud: 'aws', type: 'ami', artifact: '/release/aws/disk.raw', sha256: '2'.repeat(64), sizeBytes: 102 },
      { cloud: 'azure', type: 'vhd', artifact: '/release/azure/disk.vhd', sha256: '3'.repeat(64), sizeBytes: 103 },
    ],
  };
}

function bootcCompatibilityRequest(): WorkspaceHostImageCompatibilityRequest {
  return {
    action: 'install',
    provider: 'gcp',
    architecture: 'x86_64',
    observedAt: '2026-08-23T00:00:00Z',
    hostModel: 'bootc-image',
    bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  };
}

function compatibilityRequest(): WorkspaceHostImageCompatibilityRequest {
  return {
    action: 'install',
    provider: 'gcp',
    architecture: 'x86_64',
    ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
    observedAt: '2026-08-23T00:00:00Z',
  };
}

function cleanRoomSpec(): WorkspaceHostCleanRoomInstallSpec {
  return {
    fixtureId: 'gcp-x86_64-install-1',
    action: 'install',
    provider: 'gcp',
    architecture: 'x86_64',
    observedAt: '2026-08-23T00:00:00Z',
    hostId: 'clean-room-host-1',
    migrationId: 'schema-1042',
    minimumNodeMajor: 22,
    service: { name: 'papercusp-workspace', port: 3070 },
  };
}

function trustReport(sha256 = RELEASE_DIGEST): ArtifactTrustReport {
  return {
    version: ARTIFACT_TRUST_PIPELINE_VERSION,
    subject: {
      path: '/release/papercusp-server.tgz',
      name: 'papercusp-server.tgz',
      bytes: 42_000,
      sha256,
      signed: true,
    },
    policy: {
      denyVulnerabilitiesAtOrAbove: 'high',
      maxSecretFindings: 0,
      maxAttestationAgeMs: 60 * 60 * 1_000,
    },
    trusted: true,
    evidence: [
      {
        kind: 'signature',
        subjectSha256: sha256,
        tool: { name: 'minisign', version: '0.12' },
        valid: true,
      },
      {
        kind: 'sbom',
        subjectSha256: sha256,
        tool: { name: 'syft', version: '1.30' },
        format: 'cyclonedx-json',
        documentSha256: SBOM_DIGEST,
        componentCount: 42,
      },
      {
        kind: 'vulnerability-scan',
        subjectSha256: sha256,
        tool: { name: 'grype', version: '0.99' },
        sbomSha256: SBOM_DIGEST,
        findings: [],
      },
      {
        kind: 'secret-scan',
        subjectSha256: sha256,
        tool: { name: 'gitleaks', version: '8.28' },
        findings: [],
      },
      {
        kind: 'provenance-attestation',
        subjectSha256: sha256,
        tool: { name: 'cosign', version: '2.5' },
        valid: true,
        predicateType: 'https://slsa.dev/provenance/v1',
        issuedAt: '2026-08-22T23:59:00Z',
        attestationSha256: 'e'.repeat(64),
      },
    ],
    failures: [],
  };
}

function cleanRoomReport(candidate: WorkspaceHostImageArtifact): WorkspaceHostCleanRoomAcceptanceReport {
  const spec = cleanRoomSpec();
  const fixture = buildWorkspaceHostCleanRoomInstallFixture(candidate, spec);
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    fixtureId: spec.fixtureId,
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
    attestation: workspaceHostCleanRoomFixtureAttestation(fixture, spec.observedAt),
  };
}

describe('evaluateWorkspaceHostReleaseGate', () => {
  it('accepts one exact manifest, release, trust subject, compatibility row, and clean-room report', () => {
    const candidate = artifact();
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(candidate),
    });

    expect(verdict).toMatchObject({
      accepted: true,
      manifest: { ok: true },
      compatibility: { compatible: true, issues: [] },
      failures: [],
    });
  });

  // EI-21750653220169836: the published r8 workspace-host artifact declared the sidecar
  // bundle builder and pinned papercusp-desktop/bin/build-desktop-sidecar.sh — a bash
  // script — as its template. Every gate passed it, and the release died much later at
  // `packer init`, whose error named Packer rather than the field that chose the file.
  it('rejects a build manifest that declares the sidecar bundle builder', () => {
    const candidate = artifact('2026.8.22-1', { kind: WORKSPACE_HOST_SIDECAR_BUILDER_KIND });
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(candidate),
    });

    expect(verdict.accepted).toBe(false);
    const failure = verdict.failures.find((entry) => entry.code === 'unsupported-builder');
    expect(failure).toBeDefined();
    expect(failure?.message).toContain(WORKSPACE_HOST_SIDECAR_BUILDER_KIND);
  });

  it('rejects a builder template that is not a Packer template', () => {
    const candidate = artifact('2026.8.22-1', {
      templatePath: 'papercusp-desktop/bin/build-desktop-sidecar.sh',
    });
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(candidate),
    });

    expect(verdict.accepted).toBe(false);
    const failure = verdict.failures.find((entry) => entry.code === 'unsupported-builder');
    expect(failure).toBeDefined();
    expect(failure?.message).toContain('build-desktop-sidecar.sh');
  });

  it('accepts the Packer builder kind paired with a .pkr.hcl template', () => {
    const candidate = artifact('2026.8.22-1', {
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      templatePath: 'infra/images/workspace-host.pkr.hcl',
    });
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(candidate),
    });

    expect(verdict.failures.filter((entry) => entry.code === 'unsupported-builder')).toEqual([]);
    expect(verdict.accepted).toBe(true);
  });

  // P-307: the bake collapses onto bootc-image-builder, so a second builder kind has to be
  // legal here. The point of the change is that kind and template stay PAIRED — the gate did
  // not become a looser allowlist that accepts either extension from either builder.
  describe('the bootc builder (P-307)', () => {
    const CONTAINERFILE = 'infra/images/bootc/workspace-host.Containerfile';

    it('accepts a digest-trusted bootc artifact with the complete three-cloud bake matrix', () => {
      const candidate = bootcArtifact();
      const verdict = evaluateWorkspaceHostReleaseGate({
        artifact: candidate,
        bootcBakeManifest: bootcBakeManifest(),
        trustReport: trustReport(BOOTC_DIGEST),
        compatibilityRequest: bootcCompatibilityRequest(),
        cleanRoomReport: cleanRoomReport(candidate),
      });

      expect(verdict.failures.filter((entry) => entry.code === 'unsupported-builder')).toEqual([]);
      expect(verdict.accepted).toBe(true);
    });

    // WI-10005761: a bootc release is image CONTENT; the bootstrap dies at install-runtime when
    // the named release is not baked in. Calibration is the accepting case directly above.
    it.each([
      ['an OS-only bake', null],
      ['a bake recorded before releases were recorded', undefined],
      ['a bake carrying a different release', { version: '2026.8.21-1' }],
    ] as const)('rejects %s paired with a release', (_name, release) => {
      const candidate = bootcArtifact();
      const { release: _drop, ...rest } = bootcBakeManifest();
      const verdict = evaluateWorkspaceHostReleaseGate({
        artifact: candidate,
        bootcBakeManifest: release === undefined ? rest : { ...rest, release },
        trustReport: trustReport(BOOTC_DIGEST),
        compatibilityRequest: bootcCompatibilityRequest(),
        cleanRoomReport: cleanRoomReport(candidate),
      });
      expect(verdict.accepted).toBe(false);
      const bake = verdict.failures.find((failure) => failure.code === 'invalid-bootc-bake-manifest');
      expect(bake?.message).toContain(`but the release names ${candidate.release.version}`);
    });

    it('rejects bootc when its bake matrix is missing or trust still names the tarball', () => {
      const candidate = bootcArtifact();
      const verdict = evaluateWorkspaceHostReleaseGate({
        artifact: candidate,
        trustReport: trustReport(),
        compatibilityRequest: bootcCompatibilityRequest(),
        cleanRoomReport: cleanRoomReport(candidate),
      });
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((failure) => failure.code)).toEqual(
        expect.arrayContaining(['invalid-bootc-bake-manifest', 'trust-subject-mismatch']),
      );
    });

    it('rejects the bootc builder kind pointed at a Packer template', () => {
      const candidate = artifact('2026.8.22-1', {
        kind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        templatePath: 'infra/images/workspace-host.pkr.hcl',
      });
      const verdict = evaluateWorkspaceHostReleaseGate({
        artifact: candidate,
        trustReport: trustReport(),
        compatibilityRequest: compatibilityRequest(),
        cleanRoomReport: cleanRoomReport(candidate),
      });

      expect(verdict.accepted).toBe(false);
      const failure = verdict.failures.find((entry) => entry.code === 'unsupported-builder');
      expect(failure?.message).toContain('Containerfile');
    });

    // The falsifier for the whole design. A "just allow both extensions" implementation passes
    // every other case here and fails this one: it would hand a Containerfile to `packer build`
    // and reproduce EI-21750653220169836 with a different file.
    it('rejects the Packer builder kind pointed at a Containerfile', () => {
      const candidate = artifact('2026.8.22-1', {
        kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
        templatePath: CONTAINERFILE,
      });
      const verdict = evaluateWorkspaceHostReleaseGate({
        artifact: candidate,
        trustReport: trustReport(),
        compatibilityRequest: compatibilityRequest(),
        cleanRoomReport: cleanRoomReport(candidate),
      });

      expect(verdict.accepted).toBe(false);
      const failure = verdict.failures.find((entry) => entry.code === 'unsupported-builder');
      expect(failure?.message).toContain('Packer template');
    });

    // Two different repairs must not wear one message: an ineligible KIND is a routing mistake,
    // a wrong template EXTENSION is a manifest-authoring mistake, and a reader told the wrong
    // one goes to the wrong file. This is the same distinguishability discipline D-287/D-288
    // imposed on the signature refusals.
    it('distinguishes an ineligible builder kind from a mismatched template', () => {
      const ineligible = artifact('2026.8.22-1', {
        kind: WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
        templatePath: 'papercusp-desktop/bin/build-desktop-sidecar.sh',
      });
      const mismatched = artifact('2026.8.22-1', {
        kind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        templatePath: 'infra/images/workspace-host.pkr.hcl',
      });
      const messageFor = (candidate: WorkspaceHostImageArtifact) =>
        evaluateWorkspaceHostReleaseGate({
          artifact: candidate,
          trustReport: trustReport(),
          compatibilityRequest: compatibilityRequest(),
          cleanRoomReport: cleanRoomReport(candidate),
        }).failures.find((entry) => entry.code === 'unsupported-builder')?.message;

      const ineligibleMessage = messageFor(ineligible);
      const mismatchedMessage = messageFor(mismatched);
      expect(ineligibleMessage).toContain('cannot produce an image-family release');
      expect(mismatchedMessage).toContain('is not a Containerfile');
      expect(ineligibleMessage).not.toEqual(mismatchedMessage);
    });

    // FALSIFIABILITY CONTROL, kept permanently rather than proven once by mutating the tree.
    // The tempting wrong implementation of P-307 is "allow either extension for either kind" —
    // a single union pattern instead of a per-kind table. It passes the accept case and both
    // wrong-extension cases above, so those alone do not discriminate. Here the loosened table
    // is built explicitly and shown to accept the pairing the real table refuses, which is what
    // makes the assertions above evidence rather than decoration. The calibration half — the
    // real table accepting its own legitimate pairing — runs alongside it, so a table broken
    // outright cannot make this pass by refusing everything.
    it('discriminates against a loosened any-extension table', () => {
      const loosened = new RegExp(
        Object.values(WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES)
          .map((shape) => shape.pattern.source)
          .join('|'),
      );
      const CONTAINERFILE_PATH = CONTAINERFILE;
      const PACKER_PATH = 'infra/images/workspace-host.pkr.hcl';

      // The wrong implementation would accept every pairing…
      expect(loosened.test(CONTAINERFILE_PATH)).toBe(true);
      expect(loosened.test(PACKER_PATH)).toBe(true);

      // …while the real, per-kind table keeps them apart in BOTH directions.
      const packerShape = WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES[WORKSPACE_HOST_SHARED_BUILDER_KIND];
      const bootcShape = WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES[WORKSPACE_HOST_BOOTC_BUILDER_KIND];
      expect(packerShape.pattern.test(PACKER_PATH)).toBe(true); // calibration
      expect(bootcShape.pattern.test(CONTAINERFILE_PATH)).toBe(true); // calibration
      expect(packerShape.pattern.test(CONTAINERFILE_PATH)).toBe(false);
      expect(bootcShape.pattern.test(PACKER_PATH)).toBe(false);
    });

    // The eligible-kinds list is DERIVED from the shape table. Restating it by hand is how the
    // gate and the contract come to disagree about which builders may cut an image.
    it('derives the image-family kinds from the shape table', () => {
      for (const kind of WORKSPACE_HOST_BUILDER_KINDS) {
        expect(WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS.includes(kind)).toBe(
          WORKSPACE_HOST_BUILDER_TEMPLATE_SHAPES[kind].imageFamilyEligible,
        );
      }
      expect(WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS).toContain(WORKSPACE_HOST_BOOTC_BUILDER_KIND);
      expect(WORKSPACE_HOST_IMAGE_FAMILY_BUILDER_KINDS).not.toContain(
        WORKSPACE_HOST_SIDECAR_BUILDER_KIND,
      );
    });
  });

  it('rejects a trust report for different release bytes', () => {
    const candidate = artifact();
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport('f'.repeat(64)),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(candidate),
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.failures).toContainEqual(expect.objectContaining({ code: 'trust-subject-mismatch' }));
  });

  it('rejects a tampered canonical manifest identity', () => {
    const valid = artifact();
    const candidate: WorkspaceHostImageArtifact = {
      ...valid,
      buildManifest: {
        ...valid.buildManifest,
        manifestIdentity: `sha256:${'f'.repeat(64)}`,
      },
    };
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(valid),
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.failures).toContainEqual(expect.objectContaining({ code: 'invalid-build-manifest' }));
  });

  it('recomputes compatibility and rejects incomplete clean-room evidence', () => {
    const candidate = artifact();
    const cleanRoom = cleanRoomReport(candidate);
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: {
        ...compatibilityRequest(),
        provider: 'aws',
      },
      cleanRoomReport: {
        ...cleanRoom,
        passed: false,
        checks: ['artifact-identity'],
        attestation: undefined,
      },
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(['incompatible-image', 'clean-room-rejected']),
    );
  });

  it('rejects a green clean-room report issued for another image version', () => {
    const candidate = artifact();
    const verdict = evaluateWorkspaceHostReleaseGate({
      artifact: candidate,
      trustReport: trustReport(),
      compatibilityRequest: compatibilityRequest(),
      cleanRoomReport: cleanRoomReport(artifact('2026.8.23-1')),
    });

    expect(verdict.accepted).toBe(false);
    expect(verdict.failures).toContainEqual(expect.objectContaining({ code: 'clean-room-subject-mismatch' }));
  });
});
