import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT,
  WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT,
  WORKSPACE_HOST_PUI_COMPANION_PATH,
  WORKSPACE_HOST_PUI_ENTRYPOINT,
  WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH,
  WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT,
  WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS,
  WORKSPACE_HOST_ARTIFACT_ORIGIN,
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
} from "@papercusp/deployment-driver";
import {
  gcpBaseImageIdentity,
  gcpBaseImageIdentityDigest,
  measureGcpBaseImage,
} from "@papercusp/operator-core/lib/workspace-host/gcp-base-image-identity";
import { evaluateWorkspaceHostReleaseGate } from "@papercusp/operator-core/lib/workspace-host/workspace-host-release-gate";

import {
  buildImageArtifact,
  composeRequest,
  main,
  parseGcpImageReleaseRequestCliArgs,
  type GcpImageReleaseRequestDeps,
} from "./gcp-image-release-request-cli";

/**
 * This CLI is the producer named by D-193. The image-family release ratifies an artifact that
 * describes a PACKER build over an immutable base image, which is a different object from the
 * publication manifest's sidecar-built bundle artifact — and before this file existed, nothing
 * assembled it, so `releaseGate.artifact` could only be hand-written.
 *
 * The load-bearing test here is `satisfies the real release gate`: the others check individual
 * refusals, but only running the actual gate proves the emitted document is admissible. The r8
 * cut passed every check its authors thought to run and still died at `packer init`
 * (EI-21750653220169836).
 */
const PROJECT = "active-alcove-504205-q3";
const BUNDLE_SHA =
  "a070057f2a892fbd9b7f353d58745d8a7ee591c838ae20417966401815cc7e07";
const KEY_SHA =
  "66bad893ed3a4140ea848787d1fd19d3673d5d1fdd92ae3434d67db5b6999bf8";
const BASE_IMAGE =
  "projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260826";
/** The GCE resource the Compute API returns for BASE_IMAGE (fixture values, real shape). */
const BASE_IMAGE_RESOURCE = {
  name: "ubuntu-2404-noble-amd64-v20260826",
  id: "4405532451318052745",
  creationTimestamp: "2026-08-26T10:12:03.517-07:00",
  status: "READY",
};
/** Derived through the real measurement code, so the fixture cannot drift from it. */
const BASE_SHA = gcpBaseImageIdentityDigest(
  gcpBaseImageIdentity(BASE_IMAGE, BASE_IMAGE_RESOURCE),
);
const MEASURE_CALLS: Array<{ reference: string; credentialRef: string }> = [];
/** Measures through `measureGcpBaseImage` against a fake Compute API holding BASE_IMAGE only. */
function measuringDeps(
  images: Record<string, typeof BASE_IMAGE_RESOURCE> = {
    [BASE_IMAGE]: BASE_IMAGE_RESOURCE,
  },
): GcpImageReleaseRequestDeps {
  return {
    measureBaseImage: (reference, credentialRef) => {
      MEASURE_CALLS.push({ reference, credentialRef });
      return measureGcpBaseImage(
        {
          getImage: async (projectId, imageName) =>
            images[`projects/${projectId}/global/images/${imageName}`],
        },
        reference,
      );
    },
  };
}
const MEASURED = measuringDeps();
const PUBLISHED_AT = "2026-08-30T02:14:40.345Z";
const TEMPLATE_BODY = "packer {\n  required_plugins {}\n}\n";
/**
 * Derived from the shipped artifact origin rather than hardcoded, so this fixture cannot drift off
 * it — and so no account-bearing hostname is reintroduced into source (WI-38321).
 */
const CUPBOARD = WORKSPACE_HOST_ARTIFACT_ORIGIN;
const SIGNING_PUBLIC_KEY =
  "untrusted comment: minisign public key: 5D3A7DD4A7089944\nRWREmQin1H06XfseQbDxZxnbUzVEFqNzYLmA5gnCdg+6cAKucqh02Be5\n";
/** The bundle cannot initialize a workspace without this entrypoint, so the gate requires it. */
const INITIALIZER_PATH = WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT;

/**
 * Fixture bodies for the materials the release gate requires, keyed by the contract's own exported
 * paths so this file cannot drift from it by restating a path.
 *
 * The LIST is derived below from `WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS`; this map only supplies
 * bytes. That split is deliberate: a newly-required material fails HERE, naming itself and pointing
 * at this map, instead of surfacing as a gate rejection naming a path this file never mentions.
 */
const REQUIRED_MATERIAL_BODIES: Readonly<Record<string, string>> = {
  [WORKSPACE_HOST_REMOTE_INITIALIZER_ENTRYPOINT]:
    "#!/usr/bin/env node\n// fixture stand-in for the remote initializer\n",
  [WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT]:
    "#!/usr/bin/env node\n// fixture stand-in for the material-delivery program\n",
  [WORKSPACE_HOST_DESKTOP_SESSION_ENTRYPOINT]:
    "#!/usr/bin/env node\n// fixture stand-in for the desktop session entrypoint\n",
  [WORKSPACE_HOST_PUI_ENTRYPOINT]: "#!/usr/bin/env bash\nexit 0\n",
  [WORKSPACE_HOST_PUI_COMPANION_PATH]: "fixture pui companion",
  [WORKSPACE_HOST_PUI_INSTALL_MANIFEST_PATH]: '{"schemaVersion":1}\n',
};

const REQUIRED_MATERIALS = WORKSPACE_HOST_REQUIRED_RELEASE_MATERIALS.map(
  (required) => {
    const body = REQUIRED_MATERIAL_BODIES[required.path];
    if (body === undefined)
      throw new Error(
        `required release material '${required.path}' has no fixture body — ` +
          "add one to REQUIRED_MATERIAL_BODIES so this fixture keeps producing an admissible bundle",
      );
    return {
      path: required.path,
      executable: required.executable === true,
      body,
    };
  },
);
const BOOTSTRAP_SCRIPT_SHA =
  "216345ddd771dd1d653c597ee5aaa285181374414a4e80551d1bc9a0d9b9f667";
const READINESS_GIT_GENERATION = 7;
const READINESS_AGENT_GENERATION = 9;
const READINESS_GIT_REF = buildWorkspaceHostCredentialReference(
  "git-short-lived-delegation",
  {
    forge: "github",
    owner: "Papercusp",
    repository: "papercusp",
  },
);
const READINESS_AGENT_REF = buildWorkspaceHostCredentialReference(
  "agent-encrypted-reference",
  {
    hostId: "release",
    agentSet: "claude-codex-omp",
  },
);

function readinessInput(): Record<string, unknown> {
  return {
    credentials: {
      git: {
        credentialRef: { kind: "git", ref: READINESS_GIT_REF },
        delivery: {
          kind: "short-lived-delegation",
          generation: READINESS_GIT_GENERATION,
          audience: "release",
          revocationRef: buildWorkspaceHostCredentialRevocationReference(
            "git-short-lived-delegation",
            { forge: "github", owner: "Papercusp", repository: "papercusp" },
            READINESS_GIT_GENERATION,
          ),
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        revokedThrough: 0,
      },
      agent: {
        credentialRef: { kind: "agent", ref: READINESS_AGENT_REF },
        delivery: {
          kind: "encrypted-reference",
          generation: READINESS_AGENT_GENERATION,
          audience: "release",
          revocationRef: buildWorkspaceHostCredentialRevocationReference(
            "agent-encrypted-reference",
            { hostId: "release", agentSet: "claude-codex-omp" },
            READINESS_AGENT_GENERATION,
          ),
        },
        revokedThrough: 0,
      },
    },
    storage: {
      minimumFreeBytes: 1,
      minimumFreeInodes: 1,
      retainedPaths: ["template.pkr.hcl"],
    },
    sourceGitlinks: [],
  };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function publicationManifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "papercusp-workspace-host-release",
    artifact: {
      contractVersion: "papercusp-workspace-host-image-acceptance-v1",
      image: { id: "papercusp-workspace-host", version: "0.0.18" },
      buildManifest: {
        releaseArtifact: {
          name: "server.tgz",
          version: "0.0.18",
          sha256: BUNDLE_SHA,
          sizeBytes: 2003038223,
        },
      },
      release: {
        version: "0.0.18",
        bundleUrl: `${CUPBOARD}/artifacts/workspace-host/sha256/${BUNDLE_SHA}/server.tgz`,
        bundleSha256: BUNDLE_SHA,
        signatureUrl: `${CUPBOARD}/artifacts/workspace-host/sha256/${BUNDLE_SHA}/server.tgz.minisig`,
        // The gate recomputes this digest over the FULL key string, trailing newline included.
        signingKeySha256: KEY_SHA,
        signingPublicKey: SIGNING_PUBLIC_KEY,
      },
      compatibility: [
        {
          provider: "gcp",
          architecture: "x86_64",
          ubuntuVersion: "24.04",
          bootstrapContractVersion: "papercusp-workspace-host-bootstrap-v2",
          actions: ["install", "upgrade", "rollback"],
          maximumArtifactAgeDays: 30,
        },
      ],
    },
    trustReport: {
      version: "artifact-trust-v1",
      subject: {
        path: "server.tgz",
        name: "server.tgz",
        bytes: 2003038223,
        sha256: BUNDLE_SHA,
        signed: true,
      },
      policy: {
        denyVulnerabilitiesAtOrAbove: "high",
        maxSecretFindings: 0,
        maxAttestationAgeMs: 86400000,
      },
      trusted: true,
      evidence: [],
      failures: [],
    },
    ...overrides,
  };
}

function inputDocument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectId: PROJECT,
    imageName: "papercusp-workspace-host-0-0-18",
    family: "papercusp-workspace-host",
    publishedAt: PUBLISHED_AT,
    source: {
      repository: "https://github.com/Papercusp/papercusp.git",
      revision: "daf63630615e9266fe9cee27d388ff44aa42366f",
    },
    baseImage: {
      reference: BASE_IMAGE,
      architecture: "x86_64",
    },
    builder: { templatePath: "infra/images/workspace-host.pkr.hcl" },
    materials: [
      { path: "template.pkr.hcl", executable: false },
      ...REQUIRED_MATERIALS.map(({ path, executable }) =>
        executable ? { path, executable: true } : { path },
      ),
    ],
    cleanRoom: {
      zone: "us-central1-a",
      serviceAccountEmail: "papercusp-vm@example.iam.gserviceaccount.com",
      subnetwork: "pc-p046-rel-subnet",
    },
    compatibilityRequest: {
      action: "install",
      provider: "gcp",
      architecture: "x86_64",
      ubuntuVersion: "24.04",
      observedAt: "2026-08-30T03:10:00.000Z",
    },
    placement: {
      projectId: PROJECT,
      zone: "us-central1-a",
      subnetwork: "pc-p046-rel-subnet",
      architecture: "x86_64",
    },
    spec: {
      action: "install",
      provider: "gcp",
      architecture: "x86_64",
      hostId: "probe",
      fixtureId: "probe",
    },
    readiness: readinessInput(),
    ...overrides,
  };
}

function cleanRoomReport(
  imageId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cleanRoomReport: {
      contractVersion: "papercusp-workspace-host-image-acceptance-v1",
      fixtureId: "p046-r15-clean-room",
      image: { id: imageId, version: "0.0.18" },
      passed: true,
      checks: [
        "artifact-identity",
        "compatibility-matrix",
        "deterministic-bootstrap-fixture",
        "exact-bootstrap-attestation",
      ],
      issues: [],
      bootstrapScriptSha256: BOOTSTRAP_SCRIPT_SHA,
      // The gate binds the attestation's release identity to the artifact's, so these three
      // fields are not decoration — a mismatch is a rejected release.
      attestation: {
        contractVersion: "papercusp-workspace-host-bootstrap-v2",
        hostId: "fixture",
        action: "install",
        // The discriminant P-306 added to WorkspaceHostBootstrapAttestationShape. This
        // hand-rolled fixture predates it, and omitting it does not read as "unspecified" —
        // the gate's `!== 'ubuntu-release-bundle'` matched `undefined` and refused the release
        // as an unverifiable BOOTC artifact awaiting P-307, which this fixture is not. It is a
        // signed-tarball host and says so in every other field (ubuntuVersion, bundleSha256,
        // signingKeySha256), so the discriminant simply has to agree with them.
        hostModel: "ubuntu-release-bundle",
        ubuntuVersion: "24.04",
        observedAt: "2026-08-30T02:39:29Z",
        status: "healthy",
        release: {
          version: "0.0.18",
          source: `${CUPBOARD}/artifacts/workspace-host/sha256/${BUNDLE_SHA}/server.tgz`,
          bundleSha256: BUNDLE_SHA,
          signingKeySha256: KEY_SHA,
          signatureVerified: true,
        },
      },
      ...overrides,
    },
  };
}

/** Lay out a repo root with the Packer template plus the input and publication documents. */
async function fixture(
  input: Record<string, unknown> = inputDocument(),
  publication: Record<string, unknown> = publicationManifest(),
  report?: Record<string, unknown>,
  credentialRef?: string,
): Promise<{
  root: string;
  args: ReturnType<typeof parseGcpImageReleaseRequestCliArgs>;
}> {
  const root = await mkdtemp(join(tmpdir(), "gcp-image-request-"));
  roots.push(root);
  await writeFile(join(root, "template.pkr.hcl"), TEMPLATE_BODY, "utf8");
  await mkdir(join(root, "bin"), { recursive: true });
  for (const material of REQUIRED_MATERIALS) {
    const target = join(root, material.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, material.body, "utf8");
    if (material.executable) await chmod(target, 0o755);
  }
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(publication), "utf8");
  const inputPath = join(root, "input.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      ...input,
      publicationManifest: manifestPath,
      builder: {
        ...(input.builder as Record<string, unknown>),
        templatePath: "template.pkr.hcl",
      },
    }),
    "utf8",
  );
  // --source-root is supplied by default so material digests are MEASURED rather than restated;
  // the "unmeasurable material" test deliberately drops it.
  const argv = [
    "--input-file",
    inputPath,
    "--repo-root",
    root,
    "--source-root",
    root,
  ];
  if (report) {
    const reportPath = join(root, "report.json");
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    argv.push("--clean-room-report", reportPath, "--emit", "request");
  } else {
    argv.push("--emit", "artifact");
  }
  // Threaded through the REAL parse rather than spread onto the returned args, so a compose-side
  // assertion actually exercises the flag → parse → connection path end to end.
  if (credentialRef !== undefined) argv.push("--credential-ref", credentialRef);
  return { root, args: parseGcpImageReleaseRequestCliArgs(argv) };
}

describe("parseGcpImageReleaseRequestCliArgs", () => {
  it("requires an input file", () => {
    expect(() => parseGcpImageReleaseRequestCliArgs([])).toThrow(
      /--input-file is required/,
    );
  });

  it("rejects unknown flags rather than ignoring them", () => {
    expect(() =>
      parseGcpImageReleaseRequestCliArgs(["--input-file", "a.json", "--turbo"]),
    ).toThrow(/unknown flag --turbo/);
  });

  it("refuses to emit a request without a clean-room report", () => {
    expect(() =>
      parseGcpImageReleaseRequestCliArgs([
        "--input-file",
        "a.json",
        "--emit",
        "request",
      ]),
    ).toThrow(/requires --clean-room-report/);
  });

  it("rejects an unsupported emit mode", () => {
    expect(() =>
      parseGcpImageReleaseRequestCliArgs([
        "--input-file",
        "a.json",
        "--emit",
        "yaml",
      ]),
    ).toThrow(/--emit must be one of/);
  });

  it("defaults the credential chain to the gcloud active user when --credential-ref is absent", () => {
    // The default is what every existing caller gets, so it is the one value that must not drift:
    // changing it would silently re-point which identity performs a release.
    // --emit artifact so the clean-room-report requirement (which `request`, the default, imposes)
    // cannot short-circuit the parse before it ever reaches the credential default.
    expect(
      parseGcpImageReleaseRequestCliArgs([
        "--input-file",
        "a.json",
        "--emit",
        "artifact",
      ]).credentialRef,
    ).toBe("gcloud://active-user");
  });

  it("accepts an explicitly selected adc:// chain", () => {
    expect(
      parseGcpImageReleaseRequestCliArgs([
        "--input-file",
        "a.json",
        "--emit",
        "artifact",
        "--credential-ref",
        "adc://default",
      ]).credentialRef,
    ).toBe("adc://default");
  });

  it("refuses an unsupported credential chain AT PARSE, not later at the composition seam", () => {
    // Refusing here is the whole point of the flag validating against the seam's own predicate:
    // otherwise the operator pays for artifact measurement and clean-room report reading before
    // the release dies at `connectionCredentialRef` for a reason known at argv time.
    expect(() =>
      parseGcpImageReleaseRequestCliArgs([
        "--input-file",
        "a.json",
        "--emit",
        "artifact",
        "--credential-ref",
        "hosted://papercusp/gcp",
      ]),
    ).toThrow(/--credential-ref must be gcloud:\/\/active-user or adc:\/\//);
    expect(() =>
      parseGcpImageReleaseRequestCliArgs([
        "--input-file",
        "a.json",
        "--emit",
        "artifact",
        "--credential-ref",
        "env:GOOGLE_APPLICATION_CREDENTIALS",
      ]),
    ).toThrow(/--credential-ref must be/);
  });
});

describe("buildImageArtifact", () => {
  it("rejects secret-shaped readiness fields even for a pre-build artifact", async () => {
    const { args } = await fixture(
      inputDocument({ readiness: { accessToken: "fixture-only" } }),
      publicationManifest(),
    );
    await expect(buildImageArtifact(args, MEASURED)).rejects.toThrow(
      /authorization|secret|accessToken/i,
    );
  });

  it("constructs the image artifact before release readiness exists", async () => {
    const input = inputDocument();
    delete input.readiness;
    const { args } = await fixture(input, publicationManifest());
    const { artifact } = await buildImageArtifact(args, MEASURED);
    expect(artifact.image.id).toBe(
      `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
    );
    expect(artifact.release.bundleSha256).toBe(BUNDLE_SHA);
    expect(artifact.buildManifest.baseImage.sha256).toBe(BASE_SHA);
  });

  it("pins the packer builder kind and MEASURES the template digest", async () => {
    const { args } = await fixture();
    const { artifact } = await buildImageArtifact(args, MEASURED);
    const expected = "sha256";
    expect(artifact.buildManifest.builder.kind).toBe("hashicorp-packer");
    expect(artifact.buildManifest.builder.templatePath).toBe(
      "template.pkr.hcl",
    );
    // The digest is of the file on disk, not anything the input could have supplied.
    const { createHash } = await import("node:crypto");
    expect(artifact.buildManifest.builder.templateSha256).toBe(
      createHash(expected).update(TEMPLATE_BODY).digest("hex"),
    );
  });

  it("emits the immutable image id rather than the publication manifest's bare product name", async () => {
    const { args } = await fixture();
    const { artifact } = await buildImageArtifact(args, MEASURED);
    expect(artifact.image.id).toBe(
      `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
    );
  });

  it("transcribes the bundle digest instead of letting the caller restate it", async () => {
    const { args } = await fixture();
    const { artifact } = await buildImageArtifact(args, MEASURED);
    expect(artifact.release.bundleSha256).toBe(BUNDLE_SHA);
    expect(artifact.buildManifest.releaseArtifact.sha256).toBe(BUNDLE_SHA);
  });

  it("copies the signing public key VERBATIM, so its recorded digest still pins it", async () => {
    // Regression: trimming this value strips the trailing newline the digest was taken over, which
    // emits an artifact whose signingKeySha256 no longer matches its own key. The gate rejects it,
    // but names the digest rather than the trim — so the guard belongs here.
    const { args } = await fixture();
    const { artifact } = await buildImageArtifact(args, MEASURED);
    expect(artifact.release.signingPublicKey).toBe(SIGNING_PUBLIC_KEY);
    expect(artifact.release.signingPublicKey.endsWith("\n")).toBe(true);
    const { createHash } = await import("node:crypto");
    expect(
      createHash("sha256")
        .update(artifact.release.signingPublicKey, "utf8")
        .digest("hex"),
    ).toBe(artifact.release.signingKeySha256);
  });

  it("refuses a publication manifest whose three bundle digests disagree", async () => {
    const broken = publicationManifest();
    const artifactBlock = broken.artifact as Record<string, unknown>;
    (artifactBlock.release as Record<string, unknown>).bundleSha256 = BASE_SHA;
    const { args } = await fixture(inputDocument(), broken);
    await expect(buildImageArtifact(args, MEASURED)).rejects.toThrow(
      /internally inconsistent/,
    );
  });

  it("refuses an untrusted trust report", async () => {
    const untrusted = publicationManifest();
    (untrusted.trustReport as Record<string, unknown>).trusted = false;
    const { args } = await fixture(inputDocument(), untrusted);
    await expect(buildImageArtifact(args, MEASURED)).rejects.toThrow(/not trusted/);
  });

  it("refuses a base image that is a family alias rather than an immutable id", async () => {
    const { args } = await fixture(
      inputDocument({
        baseImage: {
          reference: "ubuntu-2404-lts-amd64",
          architecture: "x86_64",
        },
      }),
    );
    await expect(buildImageArtifact(args, MEASURED)).rejects.toThrow(
      /family aliases are forbidden/,
    );
  });

  it("MEASURES baseImage.sha256 from the GCE image, through --credential-ref (WI-10005746)", async () => {
    const { args } = await fixture();
    MEASURE_CALLS.length = 0;
    const { artifact } = await buildImageArtifact(args, MEASURED);
    expect(artifact.buildManifest.baseImage).toEqual({
      reference: BASE_IMAGE,
      architecture: "x86_64",
      sha256: BASE_SHA,
    });
    expect(MEASURE_CALLS).toEqual([
      { reference: BASE_IMAGE, credentialRef: args.credentialRef },
    ]);
  });

  it("refuses an input that SUPPLIES baseImage.sha256 instead of letting it be measured", async () => {
    // The hole this closes: the r18/r19 inputs carried a digest of unknown derivation that every
    // layer validated for format only and Packer then recorded as image provenance.
    const { args } = await fixture(
      inputDocument({
        baseImage: { reference: BASE_IMAGE, architecture: "x86_64", sha256: BASE_SHA },
      }),
    );
    await expect(buildImageArtifact(args, MEASURED)).rejects.toThrow(
      /baseImage\.sha256 must not be supplied/,
    );
  });

  it("refuses a base image the Compute API cannot find rather than attesting a digest for it", async () => {
    const { args } = await fixture();
    await expect(buildImageArtifact(args, measuringDeps({}))).rejects.toThrow(
      /was not found; refusing to attest/,
    );
  });

  it("measures a recreated image under the same name as a DIFFERENT base", async () => {
    // Delete-and-recreate keeps the name and changes the server-assigned id.
    const { args } = await fixture();
    const { artifact } = await buildImageArtifact(
      args,
      measuringDeps({
        [BASE_IMAGE]: { ...BASE_IMAGE_RESOURCE, id: "4405532451318052746" },
      }),
    );
    expect(artifact.buildManifest.baseImage.sha256).not.toBe(BASE_SHA);
  });

  it("refuses a template path that escapes the repository root", async () => {
    const { args } = await fixture();
    const escaping = { ...args, inputFile: args.inputFile };
    const { readFile, writeFile: write } = await import("node:fs/promises");
    const doc = JSON.parse(
      await readFile(escaping.inputFile, "utf8"),
    ) as Record<string, unknown>;
    doc.builder = { templatePath: "../outside.pkr.hcl" };
    await write(escaping.inputFile, JSON.stringify(doc), "utf8");
    await expect(buildImageArtifact(escaping, MEASURED)).rejects.toThrow(
      /repository-relative POSIX path/,
    );
  });

  it("measures material digests from --source-root when the input omits them", async () => {
    const { root, args } = await fixture(
      inputDocument({ materials: [{ path: "template.pkr.hcl" }] }),
    );
    const { artifact } = await buildImageArtifact(
      {
        ...args,
        sourceRoot: root,
      },
      MEASURED,
    );
    const { createHash } = await import("node:crypto");
    expect(artifact.buildManifest.materials[0]).toMatchObject({
      path: "template.pkr.hcl",
      sha256: createHash("sha256").update(TEMPLATE_BODY).digest("hex"),
      sizeBytes: TEMPLATE_BODY.length,
    });
  });

  it("refuses an unmeasurable material rather than emitting a manifest without it", async () => {
    const { args } = await fixture(
      inputDocument({ materials: [{ path: "template.pkr.hcl" }] }),
    );
    const { sourceRoot: _dropped, ...withoutSourceRoot } = args;
    await expect(buildImageArtifact(withoutSourceRoot, MEASURED)).rejects.toThrow(
      /no --source-root was given to measure it/,
    );
  });

  it("transcribes a built material's measurement from the publication manifest", async () => {
    // The remote initializer lives inside the published bundle, not the repo, so its digest can
    // only come from the run that measured it. Citing that measurement is not the same as
    // hand-typing a digest, and it is the only honest way to name a non-repository input.
    const publication = publicationManifest();
    const artifactBlock = publication.artifact as Record<string, unknown>;
    (artifactBlock.buildManifest as Record<string, unknown>).materials = [
      {
        path: INITIALIZER_PATH,
        sha256: "d".repeat(64),
        sizeBytes: 36345,
        executable: true,
      },
    ];
    const { args } = await fixture(
      inputDocument({
        materials: [
          { path: "template.pkr.hcl" },
          { path: INITIALIZER_PATH, from: "publication-manifest" },
        ],
      }),
      publication,
    );
    const { artifact } = await buildImageArtifact(args, MEASURED);
    expect(artifact.buildManifest.materials).toContainEqual({
      path: INITIALIZER_PATH,
      sha256: "d".repeat(64),
      sizeBytes: 36345,
      executable: true,
    });
  });

  it("refuses to cite a publication-manifest measurement that does not exist", async () => {
    const { args } = await fixture(
      inputDocument({
        materials: [
          { path: "template.pkr.hcl" },
          { path: INITIALIZER_PATH, from: "publication-manifest" },
        ],
      }),
    );
    await expect(buildImageArtifact(args, MEASURED)).rejects.toThrow(
      /records no material at that path/,
    );
  });

  it("refuses a manifest that names no build inputs at all", async () => {
    const { args } = await fixture(inputDocument({ materials: [] }));
    await expect(buildImageArtifact(args, MEASURED)).rejects.toThrow(
      /at least one build input/,
    );
  });
});

describe("pre-build CLI pairing", () => {
  it("emits the same measured artifact and clean-room input without release readiness", async () => {
    const input = inputDocument();
    delete input.readiness;
    const { args } = await fixture(input, publicationManifest());
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      const argv = [
        "--input-file", args.inputFile,
        "--repo-root", args.repoRoot,
        "--source-root", args.sourceRoot!,
      ];
      await main([...argv, "--emit", "artifact"], MEASURED);
      await main([...argv, "--emit", "clean-room-input"], MEASURED);
    } finally {
      stdout.mockRestore();
    }
    expect(output).toHaveLength(2);
    const artifact = JSON.parse(output[0]!).artifact;
    const cleanRoom = JSON.parse(output[1]!);
    expect(cleanRoom.artifact).toEqual(artifact);
    expect(cleanRoom.placement).toEqual(input.placement);
    expect(cleanRoom.spec).toEqual(input.spec);
    expect(artifact.image.id).toBe(
      `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
    );
    expect(artifact.release.bundleSha256).toBe(BUNDLE_SHA);
    expect(artifact.buildManifest.baseImage.sha256).toBe(BASE_SHA);
    expect(artifact.buildManifest.builder.kind).toBe("hashicorp-packer");
  });
});

describe("composeRequest", () => {
  it("refuses a clean-room report produced under a different artifact identity", async () => {
    // The exact D-193 trap: this report PASSED, but against the bundle artifact's bare image id.
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport("papercusp-workspace-host"),
    );
    await expect(composeRequest(args, MEASURED)).rejects.toThrow(
      /Re-run the clean-room against/,
    );
  });

  it("refuses a clean-room report that did not pass", async () => {
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(
        `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
        { passed: false },
      ),
    );
    await expect(composeRequest(args, MEASURED)).rejects.toThrow(/did not pass/);
  });

  it("binds the connection to the gcloud active-user credential, never a service-account key", async () => {
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(
        `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
      ),
    );
    const composed = await composeRequest(args, MEASURED);
    // Typed reference, not a bare string — the composition seam reads `.ref`, so a string reads as
    // a MISSING credential and kills the release at the connection parse.
    expect(composed.connection).toMatchObject({
      target: "gcp",
      cloudCredentialRef: { kind: "cloud", ref: "gcloud://active-user" },
      scope: { kind: "project", id: PROJECT },
    });
    expect(composed.readiness).toMatchObject({
      expected: { username: userInfo().username },
      source: {
        repository: "https://github.com/Papercusp/papercusp.git",
        revision: "daf63630615e9266fe9cee27d388ff44aa42366f",
      },
      credentials: {
        git: { credentialRef: { kind: "git", ref: READINESS_GIT_REF } },
        agent: { credentialRef: { kind: "agent", ref: READINESS_AGENT_REF } },
      },
    });
    expect(JSON.stringify(composed.readiness)).not.toContain(
      "private-token-value",
    );
  });

  it("captures the actual canonical repository cwd instead of forwarding an input assertion", async () => {
    const supplied = readinessInput();
    supplied.expected = { username: "root", cwd: "/wrong" };
    const { root, args } = await fixture(
      inputDocument({ readiness: supplied }),
      publicationManifest(),
      cleanRoomReport(
        `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
      ),
    );
    const composed = await composeRequest(args, MEASURED);
    expect(composed.readiness).toMatchObject({
      expected: { username: userInfo().username, cwd: root },
    });
  });

  it("refuses to compose a release request without the exact-path readiness input", async () => {
    const input = inputDocument();
    delete input.readiness;
    const { args } = await fixture(
      input,
      publicationManifest(),
      cleanRoomReport(
        `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
      ),
    );
    await expect(composeRequest(args, MEASURED)).rejects.toThrow(
      /readiness input must be an object/,
    );
  });

  it("carries an explicitly selected adc:// chain through to the emitted connection", async () => {
    // The counterpart of the default test above: selection is EXPLICIT, never a silent fallback.
    // The composition seam strips GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_OAUTH_ACCESS_TOKEN /
    // CLOUDSDK_AUTH_ACCESS_TOKEN from every child env precisely so a release cannot quietly drop
    // to ambient ADC, so the emitted request has to keep NAMING which identity released.
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(
        `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
      ),
      "adc://default",
    );
    const composed = await composeRequest(args, MEASURED);
    expect(composed.connection).toMatchObject({
      target: "gcp",
      cloudCredentialRef: { kind: "cloud", ref: "adc://default" },
      scope: { kind: "project", id: PROJECT },
    });
  });

  it("satisfies the real release gate", async () => {
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(
        `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
      ),
    );
    const composed = (await composeRequest(args, MEASURED)) as {
      request: {
        releaseGate: Parameters<typeof evaluateWorkspaceHostReleaseGate>[0];
      };
    };
    const verdict = evaluateWorkspaceHostReleaseGate(
      composed.request.releaseGate,
    );
    // Mapped to strings so a regression names the failing rule instead of printing `{ …(2) }`.
    expect(
      verdict.failures.map((failure) => `${failure.code}: ${failure.message}`),
    ).toEqual([]);
    expect(verdict.accepted).toBe(true);
  });

  it("still fails the gate if the builder kind is downgraded — the guard is real, not incidental", async () => {
    const { args } = await fixture(
      inputDocument(),
      publicationManifest(),
      cleanRoomReport(
        `projects/${PROJECT}/global/images/papercusp-workspace-host-0-0-18`,
      ),
    );
    const composed = (await composeRequest(args, MEASURED)) as {
      request: {
        releaseGate: Parameters<typeof evaluateWorkspaceHostReleaseGate>[0];
      };
    };
    const mutated = {
      ...composed.request.releaseGate,
      artifact: {
        ...composed.request.releaseGate.artifact,
        buildManifest: {
          ...composed.request.releaseGate.artifact.buildManifest,
          builder: {
            ...composed.request.releaseGate.artifact.buildManifest.builder,
            kind: "papercusp-desktop-sidecar" as never,
            templatePath: "papercusp-desktop/bin/build-desktop-sidecar.sh",
          },
        },
      },
    };
    const verdict = evaluateWorkspaceHostReleaseGate(mutated);
    expect(verdict.accepted).toBe(false);
    expect(
      verdict.failures.some(
        (failure) => failure.code === "unsupported-builder",
      ),
    ).toBe(true);
  });
});
