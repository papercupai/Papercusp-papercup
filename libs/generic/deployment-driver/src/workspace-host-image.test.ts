import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
  WORKSPACE_HOST_SHARED_BUILDER_KIND,
  WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
  WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT,
  buildWorkspaceHostBuildManifest,
  deriveWorkspaceHostCanonicalArtifactUrls,
} from "./workspace-host-build-manifest";
import {
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
  WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
} from "./workspace-host-bootstrap";
import {
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  buildWorkspaceHostCleanRoomInstallFixture,
  evaluateWorkspaceHostImageCompatibility,
  runWorkspaceHostCleanRoomAcceptance,
  validateWorkspaceHostImageArtifact,
  workspaceHostCleanRoomFixtureAttestation,
  type WorkspaceHostCleanRoomInstallFixture,
  type WorkspaceHostCleanRoomInstallSpec,
  type WorkspaceHostImageArtifact,
} from "./workspace-host-image";

const RELEASE_DIGEST = "a".repeat(64);
const CANONICAL_URLS = deriveWorkspaceHostCanonicalArtifactUrls(RELEASE_DIGEST);
const SIGNING_PUBLIC_KEY =
  "untrusted comment: Papercusp release key\nRWQpublickey";
const KEY_DIGEST = createHash("sha256")
  .update(SIGNING_PUBLIC_KEY, "utf8")
  .digest("hex");

function artifact(
  version = "2026.8.22-1",
  overrides: Partial<Omit<WorkspaceHostImageArtifact, "hostModel" | "bootc">> & {
    hostModel?: "ubuntu-release-bundle";
    bootc?: never;
  } = {},
): WorkspaceHostImageArtifact {
  const buildManifest = buildWorkspaceHostBuildManifest({
    contractVersion: WORKSPACE_HOST_BUILD_INPUT_CONTRACT_VERSION,
    distributionProfile: "vm-release",
    source: {
      repository: "https://github.com/Papercusp/papercusp.git",
      revision: "1".repeat(40),
    },
    releaseArtifact: {
      name: `papercusp-server-${version}.tgz`,
      version,
      sha256: RELEASE_DIGEST,
      sizeBytes: 42_000,
    },
    baseImage: {
      reference:
        "projects/papercusp-images-123/global/images/ubuntu-2404-minimal",
      architecture: "x86_64",
      sha256: "c".repeat(64),
    },
    builder: {
      strategy: "shared",
      kind: WORKSPACE_HOST_SHARED_BUILDER_KIND,
      version: "1.14.2",
      templatePath: "infra/images/workspace-host.pkr.hcl",
      templateSha256: "d".repeat(64),
    },
    materials: [
      {
        path: WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT,
        sha256: "8".repeat(64),
        sizeBytes: 2048,
        executable: true,
      },
      {
        path: "dist/papercusp-server.tgz",
        sha256: RELEASE_DIGEST,
        sizeBytes: 42_000,
      },
      // A shippable bundle must carry the remote initializer as an executable. Without it the
      // image installs and reports healthy, then fails every initialization at the far end.
      {
        path: WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
        sha256: "e".repeat(64),
        sizeBytes: 2_048,
        executable: true,
      },
      {
        path: WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
        sha256: "9".repeat(64),
        sizeBytes: 1_536,
        executable: true,
      },
      {
        path: "bin/pui",
        sha256: "6".repeat(64),
        sizeBytes: 8_192,
        executable: true,
      },
      {
        path: "pui-companion.wasm",
        sha256: "7".repeat(64),
        sizeBytes: 4_096,
      },
      {
        path: "pui-install.json",
        sha256: "8".repeat(64),
        sizeBytes: 512,
      },
    ],
    parameters: [{ name: "distribution_profile", value: "vm-release" }],
    targets: [
      { provider: "aws", locations: [] },
      { provider: "azure", locations: [] },
      { provider: "gcp", locations: ["us-central1"] },
    ],
  });
  return {
    contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
    image: { id: "papercusp-workspace-host", version },
    buildManifest,
    release: {
      version,
      // Derived from the digest rather than hand-authored, so the fixture exercises the same
      // canonical content-addressing a real release must use instead of an aspirational host.
      bundleUrl: CANONICAL_URLS.bundleUrl,
      bundleSha256: RELEASE_DIGEST,
      signatureUrl: CANONICAL_URLS.signatureUrl,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signingKeySha256: KEY_DIGEST,
    },
    lifecycle: { state: "active", publishedAt: "2026-08-22T00:00:00Z" },
    compatibility: [
      {
        provider: "gcp",
        architecture: "x86_64",
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ["install", "upgrade", "rollback"],
        maximumArtifactAgeDays: 30,
      },
    ],
    ...overrides,
  };
}

function spec(
  overrides: Partial<WorkspaceHostCleanRoomInstallSpec> = {},
): WorkspaceHostCleanRoomInstallSpec {
  return {
    fixtureId: "gcp-x86_64-install-1",
    action: "install",
    provider: "gcp",
    architecture: "x86_64",
    observedAt: "2026-08-23T00:00:00Z",
    hostId: "clean-room-host-1",
    migrationId: "schema-1042",
    minimumNodeMajor: 22,
    service: { name: "papercusp-workspace", port: 3070 },
    publicMetadata: { environment: "clean-room" },
    ...overrides,
  };
}

function bootcArtifact(): Extract<WorkspaceHostImageArtifact, { hostModel: "bootc-image" }> {
  const current = artifact();
  const { schemaVersion: _schemaVersion, manifestIdentity: _identity, ...manifestInput } =
    current.buildManifest;
  return {
    ...current,
    hostModel: "bootc-image",
    bootc: {
      image: "registry.example.com/papercusp/workspace-host:2026.8.22-1",
      imageDigest: `sha256:${"9".repeat(64)}`,
      baseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      signaturePolicyPath: WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
    },
    buildManifest: buildWorkspaceHostBuildManifest({
      ...manifestInput,
      builder: {
        strategy: "shared",
        kind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
        version: "latest",
        templatePath: "infra/images/bootc/workspace-host.Containerfile",
        templateSha256: "d".repeat(64),
      },
    }),
    compatibility: [
      {
        provider: "gcp",
        architecture: "x86_64",
        hostModel: "bootc-image",
        bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
        actions: ["install", "upgrade", "rollback"],
        maximumArtifactAgeDays: 30,
      },
    ],
  };
}

function stdoutFor(
  fixture: WorkspaceHostCleanRoomInstallFixture,
  observedAt: string,
  mutate: (
    value: ReturnType<typeof workspaceHostCleanRoomFixtureAttestation>,
  ) => ReturnType<typeof workspaceHostCleanRoomFixtureAttestation> = (value) =>
    value,
): string {
  const attestation = mutate(
    workspaceHostCleanRoomFixtureAttestation(fixture, observedAt),
  );
  return `${WORKSPACE_HOST_BOOTSTRAP_ATTESTATION_PREFIX}${Buffer.from(
    JSON.stringify(attestation),
    "utf8",
  ).toString("base64")}\n`;
}

describe("workspace-host image compatibility", () => {
  it("uses a bootc base-image matrix and emits an exact bootc clean-room fixture", async () => {
    const candidate = bootcArtifact();
    expect(validateWorkspaceHostImageArtifact(candidate)).toEqual([]);
    expect(
      evaluateWorkspaceHostImageCompatibility(candidate, {
        action: "install",
        provider: "gcp",
        architecture: "x86_64",
        hostModel: "bootc-image",
        bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        observedAt: "2026-08-23T00:00:00Z",
      }),
    ).toMatchObject({ compatible: true, issues: [] });

    const fixture = buildWorkspaceHostCleanRoomInstallFixture(candidate, {
      ...spec(),
      hostModel: "bootc-image",
      bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
    });
    expect(fixture.bootstrapInput).toMatchObject({
      hostModel: "bootc-image",
      bootc: candidate.bootc,
    });
    const attestation = workspaceHostCleanRoomFixtureAttestation(
      fixture,
      "2026-08-23T00:00:00Z",
    );
    expect(attestation).toMatchObject({
      hostModel: "bootc-image",
      bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      release: {
        source: `${candidate.bootc.image.slice(0, candidate.bootc.image.lastIndexOf(":"))}@${candidate.bootc.imageDigest}`,
        imageDigest: candidate.bootc.imageDigest,
        signaturePolicyPath: WORKSPACE_HOST_CONTAINERS_POLICY_PATH,
      },
      isolation: { updateMode: "bootc-atomic-image-swap" },
    });
    const report = await runWorkspaceHostCleanRoomAcceptance(
      candidate,
      { ...spec(), hostModel: "bootc-image", bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE },
      { execute: async () => ({ stdout: stdoutFor(fixture, "2026-08-23T00:00:00Z") }) },
    );
    expect(report).toMatchObject({ passed: true, attestation: { hostModel: "bootc-image" } });
  });

  it("joins the immutable build manifest, signed release, and exact matrix row", () => {
    const candidate = artifact();
    expect(validateWorkspaceHostImageArtifact(candidate)).toEqual([]);
    expect(
      evaluateWorkspaceHostImageCompatibility(candidate, {
        action: "install",
        provider: "gcp",
        architecture: "x86_64",
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        observedAt: "2026-08-23T00:00:00Z",
      }),
    ).toMatchObject({ compatible: true, issues: [] });

    const first = buildWorkspaceHostCleanRoomInstallFixture(candidate, spec());
    const replay = buildWorkspaceHostCleanRoomInstallFixture(candidate, spec());
    expect(first).toEqual(replay);
    expect(first.bootstrapScriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.bootstrapScript).toContain("RELEASE_VERSION='2026.8.22-1'");
    expect(first.bootstrapInput.publicMetadata).toMatchObject({
      imageAcceptance: {
        manifestIdentity: candidate.buildManifest.manifestIdentity,
        imageVersion: candidate.image.version,
      },
    });
    expect(() =>
      buildWorkspaceHostCleanRoomInstallFixture(
        candidate,
        spec({ fixtureId: " " }),
      ),
    ).toThrow("fixtureId must be a non-empty string");
  });

  it("carries provider runtime installs and status reporting into the exact fixture bootstrap", () => {
    const agentRuntimeInstalls = [
      { agent: "claude" as const, command: "claude-install", args: ["--linux"] },
      { agent: "codex" as const, command: "codex-install", args: ["--linux"] },
      { agent: "omp" as const, command: "omp-install", args: ["--linux"] },
    ];
    const fixture = buildWorkspaceHostCleanRoomInstallFixture(artifact(), {
      ...spec(),
      agentRuntimeInstalls,
      statusChannel: "ec2-console-output",
    });

    expect(fixture.bootstrapInput.agentRuntimeInstalls).toEqual(agentRuntimeInstalls);
    expect(fixture.bootstrapInput.statusChannel).toBe("ec2-console-output");
    expect(fixture.bootstrapScript).toContain("PAPERCUSP_BOOTSTRAP_STATUS");
    // Each command and argument remains a separate shell-quoted argv token.
    expect(fixture.bootstrapScript).toContain("'claude-install' '--linux'");
    expect(fixture.bootstrapScript).toContain("'codex-install' '--linux'");
    expect(fixture.bootstrapScript).toContain("'omp-install' '--linux'");
  });

  it("runs the deterministic fixture through the existing exact bootstrap attestation gate", async () => {
    const candidate = artifact();
    const result = await runWorkspaceHostCleanRoomAcceptance(
      candidate,
      spec(),
      {
        async execute(fixture) {
          return { stdout: stdoutFor(fixture, spec().observedAt) };
        },
      },
    );
    expect(result).toMatchObject({
      passed: true,
      issues: [],
      checks: [
        "artifact-identity",
        "compatibility-matrix",
        "deterministic-bootstrap-fixture",
        "exact-bootstrap-attestation",
      ],
    });
  });

  it("rejects incompatible and stale artifacts before invoking the installer", async () => {
    let executions = 0;
    const executor = {
      async execute() {
        executions += 1;
        return { stdout: "" };
      },
    };
    const incompatible = await runWorkspaceHostCleanRoomAcceptance(
      artifact(),
      spec({ provider: "aws" }),
      executor,
    );
    const stale = await runWorkspaceHostCleanRoomAcceptance(
      artifact(),
      spec({ observedAt: "2026-10-01T00:00:00Z" }),
      executor,
    );
    expect(incompatible.issues.map((issue) => issue.code)).toEqual([
      "matrix-miss",
    ]);
    expect(stale.issues.map((issue) => issue.code)).toContain("stale-artifact");
    expect(executions).toBe(0);
  });

  it("allows a deprecated artifact only through an exact, supported rollback edge", () => {
    const previous = artifact("2026.8.01-1", {
      lifecycle: {
        state: "deprecated",
        publishedAt: "2026-08-01T00:00:00Z",
        deprecatedAt: "2026-08-22T00:00:00Z",
        supportEndsAt: "2026-09-30T00:00:00Z",
        successor: { id: "papercusp-workspace-host", version: "2026.8.22-1" },
      },
    });
    const current = artifact("2026.8.22-1", {
      lifecycle: {
        state: "active",
        publishedAt: "2026-08-22T00:00:00Z",
        rollbackTarget: previous.image,
      },
    });
    const install = evaluateWorkspaceHostImageCompatibility(previous, {
      action: "install",
      provider: "gcp",
      architecture: "x86_64",
      ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
      observedAt: "2026-08-23T00:00:00Z",
    });
    const rollback = evaluateWorkspaceHostImageCompatibility(previous, {
      action: "rollback",
      provider: "gcp",
      architecture: "x86_64",
      ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
      observedAt: "2026-08-23T00:00:00Z",
      currentArtifact: current,
    });
    const untrustedRollback = evaluateWorkspaceHostImageCompatibility(
      previous,
      {
        action: "rollback",
        provider: "gcp",
        architecture: "x86_64",
        ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
        observedAt: "2026-08-23T00:00:00Z",
        currentArtifact: {
          ...current,
          release: { ...current.release, bundleSha256: "f".repeat(64) },
        },
      },
    );
    expect(install.issues.map((issue) => issue.code)).toContain(
      "deprecated-artifact",
    );
    expect(rollback).toMatchObject({ compatible: true, issues: [] });
    expect(untrustedRollback.issues.map((issue) => issue.code)).toContain(
      "invalid-artifact",
    );
  });

  it("rejects tampered manifest identity and release bytes as one invalid artifact", () => {
    const candidate = artifact();
    const tampered: WorkspaceHostImageArtifact = {
      ...candidate,
      buildManifest: {
        ...candidate.buildManifest,
        releaseArtifact: {
          ...candidate.buildManifest.releaseArtifact,
          sha256: "e".repeat(64),
        },
      },
    };
    const result = evaluateWorkspaceHostImageCompatibility(tampered, {
      action: "install",
      provider: "gcp",
      architecture: "x86_64",
      ubuntuVersion: WORKSPACE_HOST_BOOTSTRAP_UBUNTU_VERSION,
      observedAt: "2026-08-23T00:00:00Z",
    });
    expect(result.compatible).toBe(false);
    expect(
      result.issues.every((issue) => issue.code === "invalid-artifact"),
    ).toBe(true);
    expect(result.issues.map((issue) => issue.message).join("\n")).toMatch(
      /manifestIdentity|bundleSha256/,
    );
  });

  it("rejects a release digest that differs from the build manifest", () => {
    const candidate = artifact();
    const errors = validateWorkspaceHostImageArtifact({
      ...candidate,
      release: { ...candidate.release, bundleSha256: "f".repeat(64) },
    });

    expect(errors.join("\n")).toContain(
      `release provenance: release.bundleSha256 ${"f".repeat(64)} does not match the built artifact ${RELEASE_DIGEST}`,
    );
  });

  it("rejects a signing-key digest that does not pin the supplied public key", () => {
    const candidate = artifact();
    const errors = validateWorkspaceHostImageArtifact({
      ...candidate,
      release: { ...candidate.release, signingKeySha256: "b".repeat(64) },
    });
    expect(errors).toContain(
      "release.signingKeySha256 must equal the SHA-256 of signingPublicKey",
    );
  });

  it("fails closed when clean-room attestation drifts from the signed release", async () => {
    const result = await runWorkspaceHostCleanRoomAcceptance(
      artifact(),
      spec(),
      {
        async execute(fixture) {
          return {
            stdout: stdoutFor(fixture, spec().observedAt, (attestation) => {
              // The drift under test is a BUNDLE digest, which only the ubuntu-release-bundle
              // model has. Throw rather than pass the document through unchanged if the fixture
              // model ever moves: a pass-through would still produce a valid attestation, the
              // acceptance run would succeed, and this "fails closed" test would report green
              // while asserting nothing at all.
              if (attestation.hostModel !== "ubuntu-release-bundle") {
                throw new Error(
                  `clean-room drift fixture expects the ubuntu-release-bundle model, got '${attestation.hostModel}'`,
                );
              }
              return {
                ...attestation,
                release: {
                  ...attestation.release,
                  bundleSha256: "f".repeat(64),
                },
              };
            }),
          };
        },
      },
    );
    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "clean-room attestation: release digest mismatch",
    );
  });
});

/**
 * A validator whose entire contract is "return the list of what is wrong" must not CRASH on
 * the malformed input it exists to reject.
 *
 * It used to: `verifyWorkspaceHostBuildManifest` correctly reported a missing manifest, and
 * the very next line then dereferenced `artifact.buildManifest.releaseArtifact.version`
 * anyway. Because `runWorkspaceHostCleanRoomAcceptance` calls compatibility evaluation
 * OUTSIDE its try/catch, that TypeError escaped the whole acceptance path — so an operator
 * feeding a malformed artifact JSON to the clean-room producer got
 * "Cannot read properties of undefined (reading 'releaseArtifact')" instead of a
 * `passed: false` report naming the offending field.
 */
describe("validateWorkspaceHostImageArtifact structural robustness", () => {
  it.each([
    ["image", { buildManifest: {}, release: {} }],
    ["buildManifest", { image: {}, release: {} }],
    ["release", { image: {}, buildManifest: {} }],
  ])("reports a missing %s section instead of throwing", (section, partial) => {
    const errors = validateWorkspaceHostImageArtifact(
      partial as unknown as WorkspaceHostImageArtifact,
    );
    expect(errors).toContain(`${section} must be an object`);
  });

  it("reports every missing section at once for an empty artifact", () => {
    const errors = validateWorkspaceHostImageArtifact(
      {} as unknown as WorkspaceHostImageArtifact,
    );
    for (const section of ["image", "buildManifest", "release"]) {
      expect(errors).toContain(`${section} must be an object`);
    }
  });

  it("surfaces a structurally-invalid artifact as a report, not an exception", async () => {
    let booted = false;
    const result = await runWorkspaceHostCleanRoomAcceptance(
      { image: { id: "bogus", version: "0.0.0" } } as unknown as WorkspaceHostImageArtifact,
      { architecture: "x86_64" } as unknown as WorkspaceHostCleanRoomInstallSpec,
      {
        async execute() {
          booted = true;
          return { stdout: "" };
        },
      },
    );
    expect(result.passed).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    // And it must refuse BEFORE spending a real cloud boot on it.
    expect(booted).toBe(false);
  });

  it("reports malformed manifest subsections without crashing while validating their contents", () => {
    const candidate = artifact();
    const malformed = {
      ...candidate,
      buildManifest: {
        ...candidate.buildManifest,
        baseImage: null,
        materials: [null],
        targets: [null],
      },
    } as unknown as WorkspaceHostImageArtifact;

    expect(() => validateWorkspaceHostImageArtifact(malformed)).not.toThrow();
    const errors = validateWorkspaceHostImageArtifact(malformed);
    expect(errors).toEqual(
      expect.arrayContaining([
        "buildManifest.baseImage must be an object",
        "buildManifest.materials[0] must be an object",
        "buildManifest.targets[0] must be an object",
      ]),
    );
  });
});
