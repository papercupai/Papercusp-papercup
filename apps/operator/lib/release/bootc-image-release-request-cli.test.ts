import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import {
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
  buildWorkspaceHostCleanRoomInstallFixture,
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  deriveWorkspaceHostCanonicalArtifactUrls,
  workspaceHostCleanRoomFixtureAttestation,
  workspaceHostRequiredReleaseMaterialFixtures,
  type WorkspaceHostCleanRoomInstallSpec,
  type WorkspaceHostImageArtifact,
} from "@papercusp/deployment-driver";
import { WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION } from "@papercusp/operator-core/lib/workspace-host/bootc-bake-manifest";
import { AWS_AMI_REQUIRED_GUEST_TOOLS } from "@papercusp/operator-core/lib/workspace-host/aws-ami-release";
import { GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS } from "@papercusp/operator-core/lib/workspace-host/gcp-image-family";
import { evaluateWorkspaceHostReleaseGate } from "@papercusp/operator-core/lib/workspace-host/workspace-host-release-gate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGovernedOperation } from "@papercusp/operator-core/lib/resource-governor/execution";

vi.mock("@papercusp/operator-core/lib/resource-governor/execution", async (importOriginal) => ({
  ...await importOriginal<typeof import("@papercusp/operator-core/lib/resource-governor/execution")>(),
  runGovernedOperation: vi.fn(async (_input: unknown, operation: () => Promise<unknown>) => await operation()),
}));

import {
  BOOTC_RELEASE_GUEST_TOOLS,
  BOOTC_TEMPLATE_PATH,
  actionableGrypeReport,
  buildBootcImageArtifact,
  buildBootcTrustReport,
  composeBootcAwsRequest,
  composeBootcGcpRequest,
  evaluateBootcBundledSecretPolicy,
  main,
  parseBootcImageReleaseRequestCliArgs,
  parseBootcSecretScan,
  parseCosignVerifiedDigests,
  parseVerifiedProvenance,
  ostreeObjectIndex,
  rpmOwnedPaths,
  installedRpmVersions,
  requiredGuestToolVersions,
  signedBaseImage,
  VENDOR_MIN_AVAILABLE_PACKAGES,
  vendorShipsNothingNewer,
} from "./bootc-image-release-request-cli";

// D-027 (WI-10005719). Shapes measured on the P-012 AWS bake: an INSTALLED rpm is located at the
// rpmdb and lists its files in metadata.files; a Go module inside an RPM-owned binary is a
// go-module located at that binary; stale base-layer copies sit in /sysroot/ostree objects.
const RPMDB = "/usr/share/rpm/rpmdb.sqlite";
/** One installed rpm per required AWS guest tool, so a composed request can derive its versions. */
const GUEST_TOOL_RPMS = AWS_AMI_REQUIRED_GUEST_TOOLS.map((name, index) => ({
  name,
  type: "rpm",
  version: `1.${index}-1.el10`,
  foundBy: "rpm-db-cataloger",
  locations: [{ path: RPMDB }],
}));
/** WI-10006488: the same for the GCP set (it adds the Google guest agent the shared bake installs). */
const GCP_GUEST_TOOL_RPMS = GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name, index) => ({
  name,
  type: "rpm",
  version: `2.${index}-1.el10`,
  foundBy: "rpm-db-cataloger",
  locations: [{ path: RPMDB }],
}));
const GCP_PROJECT = "papercusp-release-test";
/** The exact-path readiness input the GCP release consumes; shape as gcp-image-release-request-cli's. */
function gcpReadinessInput(): Record<string, unknown> {
  return {
    credentials: {
      git: {
        credentialRef: {
          kind: "git",
          ref: buildWorkspaceHostCredentialReference("git-short-lived-delegation", { forge: "github", owner: "Papercusp", repository: "papercusp" }),
        },
        delivery: {
          kind: "short-lived-delegation",
          generation: 7,
          audience: "release",
          revocationRef: buildWorkspaceHostCredentialRevocationReference(
            "git-short-lived-delegation",
            { forge: "github", owner: "Papercusp", repository: "papercusp" },
            7,
          ),
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        revokedThrough: 0,
      },
      agent: {
        credentialRef: {
          kind: "agent",
          ref: buildWorkspaceHostCredentialReference("agent-encrypted-reference", { hostId: "release", agentSet: "claude-codex-omp" }),
        },
        delivery: {
          kind: "encrypted-reference",
          generation: 9,
          audience: "release",
          revocationRef: buildWorkspaceHostCredentialRevocationReference(
            "agent-encrypted-reference",
            { hostId: "release", agentSet: "claude-codex-omp" },
            9,
          ),
        },
        revokedThrough: 0,
      },
    },
    storage: { minimumFreeBytes: 1, minimumFreeInodes: 1, retainedPaths: [BOOTC_TEMPLATE_PATH] },
    sourceGitlinks: [],
  };
}
const vendorSbomArtifacts = [
  { name: "skopeo", type: "rpm", version: "3:1.22.2-4.el9", locations: [{ path: RPMDB }], metadata: { files: [{ path: "/usr/bin/skopeo" }] } },
  // An .rpm ARCHIVE lying in the image: catalogued as type rpm, but not installed.
  { name: "smuggled", type: "rpm", version: "1.0-1.el9", locations: [{ path: "/opt/papercusp/cache/smuggled.rpm" }], metadata: { files: [{ path: "/usr/bin/smuggled" }] } },
];
const goAt = (path: string, id: string, severity = "High") => ({
  artifact: { name: "stdlib", type: "go-module", version: "go1.26.5", locations: [{ path }] },
  vulnerability: { id, severity, namespace: "govulndb:language:go", fix: { state: "fixed", versions: ["1.26.6"] } },
});
const installedRpmFinding = {
  artifact: { name: "openssl-libs", type: "rpm", version: "1:3.5.8-1.el9", locations: [{ path: RPMDB }] },
  vulnerability: { id: "RHSA-9001", severity: "High", namespace: "redhat:distro:redhat:9", fix: { state: "fixed" } },
};
const vendorUpdatesRecord = (overrides: Record<string, unknown> = {}) => ({
  digest: DIGEST_FOR_VENDOR,
  checkedAt: "2026-10-02T23:00:00Z",
  verdict: "no-updates",
  containerExit: 0,
  checkUpdateExit: 0,
  enabledRepos: 5,
  availablePackages: 65756,
  availablePackagesFloor: 1000,
  ...overrides,
});
const DIGEST_FOR_VENDOR = `sha256:${"9".repeat(64)}`;

// D-029 (WI-10005719). syft locates a base-layer binary the build did not replace at its ostree
// object; release-supply-chain.sh's in-image probe records each object's live copies or proves it
// has none. Shapes from the P-012 AWS bake's ostree-objects.json.
const objectPath = (prefix: string, fill: string) => `/sysroot/ostree/repo/objects/${prefix}/${fill.repeat(62)}.file`;
const OBJ_LIVE = objectPath("83", "d"); // its live copy is the RPM-owned /usr/bin/skopeo
const OBJ_LIVE_UNOWNED = objectPath("aa", "b"); // its live copy is a file no RPM owns
const OBJ_STALE = objectPath("9e", "e"); // no live copy anywhere in the deployed tree
const OBJ_UNPROBED = objectPath("00", "a"); // the probe gave it no verdict
const ostreeObjectsRecord = (overrides: Record<string, unknown> = {}) => ({
  digest: DIGEST_FOR_VENDOR,
  complete: true,
  objects: [
    { path: OBJ_LIVE, livePaths: ["/usr/bin/skopeo"], stale: false, sha256: null },
    { path: OBJ_LIVE_UNOWNED, livePaths: ["/opt/papercusp/bin/connector"], stale: false, sha256: null },
    { path: OBJ_STALE, livePaths: [], stale: true, sha256: "f".repeat(64) },
  ],
  ...overrides,
});

// WI-10005711: the image digest IS the hash of its manifest, which carries buildah's base annotations.
const BASE_HEX = "8".repeat(64);
const imageManifest = (annotations: Record<string, string>) =>
  JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", annotations });
const IMAGE_MANIFEST = imageManifest({
  "org.opencontainers.image.base.name": WORKSPACE_HOST_BOOTC_BASE_IMAGE,
  "org.opencontainers.image.base.digest": `sha256:${BASE_HEX}`,
});
const IMAGE_MANIFEST_B64 = Buffer.from(IMAGE_MANIFEST).toString("base64");
const HEX = createHash("sha256").update(IMAGE_MANIFEST).digest("hex");
const DIGEST = `sha256:${HEX}`;
const REPO = "127.0.0.1:5096/papercusp/workspace-host";
const TAG = "papercusp-workspace-host-aws-test";
const BUNDLE = "a".repeat(64);
const VERSION = "0.0.21-p318r63";
const STARTED_ON = "2026-10-02T20:00:00Z";
const NOW = () => Date.parse("2026-10-02T21:00:00Z");
const SIGNING_PUBLIC_KEY = "untrusted comment: minisign public key: TEST\nRWQtest\n";

const cosignLog = (digest: string) =>
  `Verification for ${REPO}@${digest} --\nThe following checks were performed\n` +
  `${JSON.stringify([{ critical: { image: { "docker-manifest-digest": digest }, type: "cosign container image signature" }, optional: null }])}\n`;

const provenanceLine = (hex: string, startedOn = STARTED_ON) =>
  JSON.stringify({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(
      JSON.stringify({
        _type: "https://in-toto.io/Statement/v0.1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{ name: REPO, digest: { sha256: hex } }],
        predicate: { runDetails: { metadata: { startedOn } } },
      }),
    ).toString("base64"),
    signatures: [],
  });

const cleanLog = (coverage = "12,345") =>
  `==> identity-scan of assembled tree\n    coverage: ${coverage} file(s) reachable by the scan\n    ✓ CLEAN — nothing found\n`;

const scanRecord = (overrides: Record<string, unknown> = {}) => ({
  digest: DIGEST,
  tool: { name: "papercusp-audit-release-bundle.py", version: `sha256:${"b".repeat(64)}` },
  exitCode: 0,
  ...overrides,
});

describe("bootc bundled-secret policy preflight", () => {
  const root = "/candidate/opt/papercusp/releases/0.0.21-p012r69";
  const finding = (file: string, RuleID = "generic-api-key") => ({ RuleID, File: `${root}/${file}`, StartLine: 1, Secret: "never emit this field" });
  const population = () => [
    ...Array.from({ length: 33 }, () => finding("serve.mjs")),
    ...Array.from({ length: 35 }, () => finding("spawner-sidecar.mjs")),
    ...Array.from({ length: 96 }, () => finding("doc-vector-seed/manifest.json")),
    finding("spa/assets/chunk-ZUYEQ4TG-50072df8.js", "gcp-api-key"),
    finding("spa/excalidraw/chunk-ZUYEQ4TG.js", "gcp-api-key"),
    finding("spa/monaco/vs/editor-KLE6jdfb.js"),
  ];

  it("uses the same measured population and emits only a redacted preflight", () => {
    const report = evaluateBootcBundledSecretPolicy(JSON.stringify(population()));
    expect(report).toMatchObject({ preflightOnly: true, accepted: true, totalFindings: 167, bundledFindings: 167 });
    expect(JSON.stringify(report)).not.toContain("never emit this field");
    expect(parseBootcImageReleaseRequestCliArgs(["--input-file", "scan.json", "--emit", "bundled-secret-policy"]).emit)
      .toBe("bundled-secret-policy");
  });

  it.each(["serve.mjs", "spawner-sidecar.mjs", "doc-vector-seed/manifest.json"])(
    "refuses surplus findings in %s before an image is signed or uploaded", (file) => {
      const report = evaluateBootcBundledSecretPolicy(JSON.stringify([...population(), finding(file)]));
      expect(report.accepted).toBe(false);
      expect(report.overflowed).toHaveLength(1);
    },
  );

  it("refuses unknown rules and malformed/incomplete report shapes", () => {
    expect(evaluateBootcBundledSecretPolicy(JSON.stringify([finding("serve.mjs", "private-key")])).accepted).toBe(false);
    for (const value of ["invalid", "{}", "null", JSON.stringify([{ RuleID: "generic-api-key" }])]) {
      expect(() => evaluateBootcBundledSecretPolicy(value)).toThrow();
    }
    expect(() => evaluateBootcBundledSecretPolicy(JSON.stringify([{ ...finding("serve.mjs"), StartLine: 0 }]))).toThrow();
    expect(() => evaluateBootcBundledSecretPolicy(JSON.stringify([{ ...finding("serve.mjs"), File: "serve.mjs" }]))).toThrow(/must be absolute/);
  });
});

describe("bootc release request evidence readers", () => {
  it("reads the digest cosign verified, ignoring the prose around it", () => {
    expect(parseCosignVerifiedDigests(cosignLog(DIGEST))).toEqual([DIGEST]);
    expect(parseCosignVerifiedDigests("Error: no signatures found\n")).toEqual([]);
  });

  it("scopes grype to fixable findings and drops only EL9 generic-kernel NVD CPE matches (D-289)", () => {
    const narrowed = actionableGrypeReport({
      descriptor: { name: "grype", version: "0.99.0" },
      matches: [
        { artifact: { name: "openssl-libs", type: "rpm", version: "3.0.7-30.el9" }, vulnerability: { id: "CVE-1", severity: "Medium", namespace: "redhat:distro", fix: { state: "fixed" } } },
        { artifact: { name: "glibc", type: "rpm", version: "2.34-1.el9" }, vulnerability: { id: "CVE-2", severity: "High", namespace: "redhat:distro", fix: { state: "not-fixed" } } },
        { artifact: { name: "kernel-core", type: "rpm", version: "5.14.0-730.el9" }, vulnerability: { id: "CVE-3", severity: "High", namespace: "nvd:cpe", fix: { state: "fixed" } } },
        { artifact: { name: "kernel-core", type: "rpm", version: "5.14.0-730.el9" }, vulnerability: { id: "RHSA-4", severity: "High", namespace: "redhat:distro", fix: { state: "fixed" } } },
      ],
    });
    expect((narrowed.report.matches as { vulnerability: { id: string } }[]).map((match) => match.vulnerability.id)).toEqual(["CVE-1", "RHSA-4"]);
    expect(narrowed.excludedUnfixed).toBe(1);
    expect(narrowed.excludedGenericKernelCpe).toBe(1);
  });

  it("drops syft's linux-kernel artifact (vmlinuz, pkg:generic) on an EL9 kernel, keeps a non-EL9 one (WI-10005674)", () => {
    // The real shape on a bootc image: the kernel image is cataloged as type linux-kernel, matched
    // only by upstream NVD CPE, while the kernel RPMs stay matched in the vendor namespace.
    const linuxKernel = (version: string, id: string) => ({
      artifact: { name: "linux-kernel", type: "linux-kernel", version, purl: `pkg:generic/linux-kernel@${version}` },
      vulnerability: { id, severity: "High", namespace: "nvd:cpe", fix: { state: "fixed", versions: ["5.15.16"] } },
    });
    const narrowed = actionableGrypeReport({
      descriptor: { name: "grype", version: "0.117.0" },
      matches: [
        linuxKernel("5.14.0-730.el9.x86_64", "CVE-2022-0185"),
        linuxKernel("6.8.0-31-generic", "CVE-2024-1086"),
        { artifact: { name: "kernel-core", type: "rpm", version: "5.14.0-730.el9" }, vulnerability: { id: "RHSA-4", severity: "High", namespace: "redhat:distro", fix: { state: "fixed" } } },
      ],
    });
    expect((narrowed.report.matches as { vulnerability: { id: string } }[]).map((match) => match.vulnerability.id)).toEqual(["CVE-2024-1086", "RHSA-4"]);
    expect(narrowed.excludedGenericKernelCpe).toBe(1);
  });

  it("drops the same generic-kernel NVD CPE shape on an EL10 kernel, not only EL9 (D-035, WI-10005910)", () => {
    // The base moved to centos-bootc:stream10, whose kernel release is .el10 (and .el10_0 on a
    // point release). The filter keys on el<major>; a version with no EL major stays actionable.
    const nvdKernel = (name: string, type: string, version: string, id: string) => ({
      artifact: { name, type, version },
      vulnerability: { id, severity: "High", namespace: "nvd:cpe", fix: { state: "fixed", versions: ["6.13"] } },
    });
    const narrowed = actionableGrypeReport({
      descriptor: { name: "grype", version: "0.117.0" },
      matches: [
        nvdKernel("kernel-core", "rpm", "6.12.0-124.el10", "CVE-10"),
        nvdKernel("linux-kernel", "linux-kernel", "6.12.0-124.el10.x86_64", "CVE-11"),
        nvdKernel("kernel", "rpm", "6.12.0-55.9.1.el10_0", "CVE-12"),
        // Controls: no EL major in the release, so these must stay in the gate population.
        nvdKernel("kernel-core", "rpm", "6.12.0-124.elx", "CVE-13"),
        nvdKernel("linux-kernel", "linux-kernel", "6.12.0-124-generic", "CVE-14"),
        { artifact: { name: "kernel-core", type: "rpm", version: "6.12.0-124.el10" }, vulnerability: { id: "RHSA-15", severity: "High", namespace: "redhat:distro", fix: { state: "fixed" } } },
      ],
    });
    expect((narrowed.report.matches as { vulnerability: { id: string } }[]).map((match) => match.vulnerability.id)).toEqual(["CVE-13", "CVE-14", "RHSA-15"]);
    expect(narrowed.excludedGenericKernelCpe).toBe(3);
  });

  it("moves only vendor-owned fixed Critical/High findings out when the vendor ships nothing newer (D-027)", () => {
    const report = {
      descriptor: { name: "grype", version: "0.117.0" },
      matches: [
        goAt("/usr/bin/skopeo", "GO-1"),
        installedRpmFinding,
        goAt("/sysroot/ostree/repo/objects/9e/eca1cb.file", "GO-2"),
        goAt("/opt/papercusp/bin/connector", "GO-3"),
        goAt("/usr/bin/smuggled", "GO-4"),
        goAt("/usr/bin/skopeo", "GO-5", "Medium"),
      ],
    };
    const owned = rpmOwnedPaths({ artifacts: vendorSbomArtifacts });
    expect([...owned]).toEqual(["/usr/bin/skopeo"]);

    const narrowed = actionableGrypeReport(report, { ownedPaths: owned, vendorShipsNothingNewer: true });
    expect(narrowed.vendorPendingIds).toEqual(["GO-1", "RHSA-9001"]);
    expect(narrowed.excludedVendorPending).toBe(2);
    expect((narrowed.report.matches as { vulnerability: { id: string } }[]).map((m) => m.vulnerability.id)).toEqual(["GO-2", "GO-3", "GO-4", "GO-5"]);

    // Without proof that the vendor ships nothing newer, nothing is pending.
    const unproven = actionableGrypeReport(report, { ownedPaths: owned, vendorShipsNothingNewer: false });
    expect(unproven.excludedVendorPending).toBe(0);
    expect((unproven.report.matches as unknown[]).length).toBe(6);
    expect(actionableGrypeReport(report).excludedVendorPending).toBe(0);
  });

  it("accepts a vendor-updates record only when it proves nothing newer for this digest (D-027)", () => {
    expect(vendorShipsNothingNewer(vendorUpdatesRecord(), DIGEST_FOR_VENDOR)).toBe(true);
    for (const overrides of [
      { verdict: "updates-available", checkUpdateExit: 100 },
      { checkUpdateExit: 1 },
      { containerExit: 125 },
      { enabledRepos: 0 },
      { availablePackages: VENDOR_MIN_AVAILABLE_PACKAGES - 1 },
      // A bake run with a lowered floor does not lower the release gate's own.
      { availablePackages: 12, availablePackagesFloor: 10 },
      { checkUpdateExit: null },
    ]) {
      expect(vendorShipsNothingNewer(vendorUpdatesRecord(overrides), DIGEST_FOR_VENDOR), JSON.stringify(overrides)).toBe(false);
    }
    expect(() => vendorShipsNothingNewer(vendorUpdatesRecord({ digest: `sha256:${"1".repeat(64)}` }), DIGEST_FOR_VENDOR))
      .toThrow(/vendor-updates record is for/);
  });

  it("indexes the ostree-object probe only when it is complete and bound to this digest (D-029)", () => {
    const index = ostreeObjectIndex(ostreeObjectsRecord(), DIGEST_FOR_VENDOR);
    expect(index.get(OBJ_LIVE)).toEqual({ livePaths: ["/usr/bin/skopeo"], stale: false });
    expect(index.get(OBJ_STALE)).toEqual({ livePaths: [], stale: true });
    // An incomplete probe relocates nothing and proves nothing stale.
    expect(ostreeObjectIndex(ostreeObjectsRecord({ complete: false }), DIGEST_FOR_VENDOR).size).toBe(0);
    expect(() => ostreeObjectIndex(ostreeObjectsRecord({ digest: `sha256:${"1".repeat(64)}` }), DIGEST_FOR_VENDOR))
      .toThrow(/ostree-objects record is for/);
    expect(() => ostreeObjectIndex(ostreeObjectsRecord({ objects: [{ livePaths: [] }] }), DIGEST_FOR_VENDOR))
      .toThrow(/without a path/);
  });

  it("relocates object-located findings to their live paths and lists stale base objects (D-029)", () => {
    const connector = "/opt/papercusp/bin/connector";
    const report = {
      descriptor: { name: "grype", version: "0.117.0" },
      matches: [
        goAt(OBJ_LIVE, "GO-LIVE"),
        goAt(OBJ_LIVE_UNOWNED, "GO-LIVE-UNOWNED"),
        goAt(OBJ_STALE, "GO-STALE"),
        goAt(OBJ_STALE, "GO-STALE-MEDIUM", "Medium"),
        goAt(OBJ_UNPROBED, "GO-UNPROBED"),
        // Stale only when EVERY location is a stale object.
        { ...goAt(OBJ_STALE, "GO-MIXED"), artifact: { ...goAt(OBJ_STALE, "x").artifact, locations: [{ path: OBJ_STALE }, { path: connector }] } },
        // A stale verdict for a path that is not an ostree object is not trusted.
        goAt(connector, "GO-FORGED"),
      ],
    };
    const owned = rpmOwnedPaths({ artifacts: vendorSbomArtifacts });
    const forged = ostreeObjectsRecord();
    const objects = ostreeObjectIndex(
      { ...forged, objects: [...(forged.objects as unknown[]), { path: connector, livePaths: [], stale: true }] },
      DIGEST_FOR_VENDOR,
    );
    const remaining = (narrowed: ReturnType<typeof actionableGrypeReport>) =>
      (narrowed.report.matches as { vulnerability: { id: string } }[]).map((m) => m.vulnerability.id);

    const narrowed = actionableGrypeReport(report, { ownedPaths: owned, vendorShipsNothingNewer: true, ostreeObjects: objects });
    expect(narrowed.staleBaseObjectIds).toEqual(["GO-STALE"]);
    expect(narrowed.excludedStaleBaseObject).toBe(1);
    expect(narrowed.vendorPendingIds).toEqual(["GO-LIVE"]);
    expect(remaining(narrowed)).toEqual(["GO-LIVE-UNOWNED", "GO-STALE-MEDIUM", "GO-UNPROBED", "GO-MIXED", "GO-FORGED"]);

    // A stale base object needs no vendor proof; relocation alone never makes a finding pending.
    const unproven = actionableGrypeReport(report, { ownedPaths: owned, vendorShipsNothingNewer: false, ostreeObjects: objects });
    expect(unproven.staleBaseObjectIds).toEqual(["GO-STALE"]);
    expect(unproven.excludedVendorPending).toBe(0);
    // Without the probe's index nothing relocates and nothing is stale.
    const unindexed = actionableGrypeReport(report, { ownedPaths: owned, vendorShipsNothingNewer: true });
    expect(unindexed.excludedStaleBaseObject).toBe(0);
    expect(unindexed.excludedVendorPending).toBe(0);
  });

  it("reads a clean secret scan only when record, log and coverage all agree", () => {
    expect(parseBootcSecretScan(scanRecord(), cleanLog(), DIGEST).findings).toEqual([]);
    expect(() => parseBootcSecretScan(scanRecord({ digest: `sha256:${"1".repeat(64)}` }), cleanLog(), DIGEST)).toThrow(/not sha256/);
    expect(() => parseBootcSecretScan(scanRecord(), cleanLog("12"), DIGEST)).toThrow(/measured almost nothing/);
    expect(() => parseBootcSecretScan(scanRecord(), "coverage: 9,000 file(s)\n", DIGEST)).toThrow(/contradictory or unscannable/);
    expect(() => parseBootcSecretScan(scanRecord({ exitCode: 2 }), cleanLog(), DIGEST)).toThrow(/contradictory or unscannable/);
    const dirty = parseBootcSecretScan(scanRecord({ exitCode: 1 }), "    coverage: 9,000 file(s)\n    ✗ ASSEMBLED BUNDLE CARRIES A CREDENTIAL\n", DIGEST);
    expect(dirty.findings).toHaveLength(1);
  });

  it("binds provenance to the in-toto subject and takes the newest statement", () => {
    const output = `${provenanceLine(HEX, "2026-10-01T00:00:00Z")}\n${provenanceLine(HEX)}\n${provenanceLine("1".repeat(64), "2026-10-03T00:00:00Z")}\n`;
    expect(parseVerifiedProvenance(output, DIGEST).issuedAt).toBe(STARTED_ON);
    expect(() => parseVerifiedProvenance(provenanceLine("1".repeat(64)), DIGEST)).toThrow(/no verified SLSA v1/);
  });

  it("derives guest-tool versions from the rpm database only, refusing absent or ambiguous tools (WI-10006386)", () => {
    // Shape measured on the P-012 AWS bake: syft's elf-binary cataloger also emits a type-rpm
    // nftables row, located at an ostree object and missing the epoch the rpm database records.
    const sbom = {
      artifacts: [
        { name: "nftables", type: "rpm", version: "1.1.5-6.el10", foundBy: "elf-binary-package-cataloger", locations: [{ path: "/sysroot/ostree/repo/objects/48/3c9b.file" }] },
        { name: "nftables", type: "rpm", version: "1:1.1.5-6.el10", foundBy: "rpm-db-cataloger", locations: [{ path: RPMDB }] },
        { name: "acl", type: "rpm", version: "2.4.0-2.el10", locations: [{ path: RPMDB }] },
        { name: "acl", type: "rpm", version: "2.4.0-2.el10", locations: [{ path: RPMDB }] },
        { name: "curl", type: "rpm", version: "8.12.1-6.el10", locations: [{ path: "/opt/papercusp/cache/curl.rpm" }] },
        { name: "kernel-core", type: "rpm", version: "6.12.0-1.el10", locations: [{ path: RPMDB }] },
        { name: "kernel-core", type: "rpm", version: "6.12.0-2.el10", locations: [{ path: RPMDB }] },
      ],
    };
    const installed = installedRpmVersions(sbom);
    expect(installed.get("nftables")).toEqual(["1:1.1.5-6.el10"]);
    expect(installed.get("acl")).toEqual(["2.4.0-2.el10"]);
    // An .rpm archive lying in the image is not an installed package.
    expect(installed.has("curl")).toBe(false);

    expect(requiredGuestToolVersions(installed, ["acl", "nftables"])).toEqual({ acl: "2.4.0-2.el10", nftables: "1:1.1.5-6.el10" });
    expect(() => requiredGuestToolVersions(installed, ["acl", "curl", "jq"])).toThrow(/no installed rpm for guest tool\(s\): curl, jq/);
    expect(() => requiredGuestToolVersions(installed, ["kernel-core"])).toThrow(
      /more than one installed version for: kernel-core \(6\.12\.0-1\.el10, 6\.12\.0-2\.el10\)/,
    );
  });

  it("requires a clean-room report before it will emit a request", () => {
    expect(() => parseBootcImageReleaseRequestCliArgs(["--input-file", "x.json"])).toThrow(/clean-room-report/);
    expect(parseBootcImageReleaseRequestCliArgs(["--input-file", "x.json", "--emit", "artifact"]).emit).toBe("artifact");
  });

  it("emits guest-tool versions only for a named provider (WI-10006408)", () => {
    const parsed = parseBootcImageReleaseRequestCliArgs(["--input-file", "x.json", "--emit", "guest-tool-versions", "--provider", "gcp"]);
    expect(parsed).toMatchObject({ emit: "guest-tool-versions", provider: "gcp" });
    expect(() => parseBootcImageReleaseRequestCliArgs(["--input-file", "x.json", "--emit", "guest-tool-versions"])).toThrow(
      /requires --provider aws\|gcp/,
    );
    expect(() =>
      parseBootcImageReleaseRequestCliArgs(["--input-file", "x.json", "--emit", "guest-tool-versions", "--provider", "toString"]),
    ).toThrow(/requires --provider/);
    expect(() =>
      parseBootcImageReleaseRequestCliArgs(["--input-file", "x.json", "--emit", "artifact", "--provider", "gcp"]),
    ).toThrow(/only valid with --emit guest-tool-versions/);
    // The GCP set includes the Google guest agent the shared bake installs; AWS its SSM agent.
    expect(BOOTC_RELEASE_GUEST_TOOLS.gcp).toContain("google-guest-agent");
    expect(BOOTC_RELEASE_GUEST_TOOLS.aws).toContain("amazon-ssm-agent");
  });
});

describe("bootc release request assembly (end to end over a fixture bake)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(
    overrides: {
      sbomDigest?: string;
      containerfileDrift?: boolean;
      sbomManifest?: string;
      inputBaseSha256?: string;
      /** The release the bake recorded; "absent" writes a pre-WI-10005761 manifest with no key. */
      bakeRelease?: { version: string } | null | "absent";
      sbomArtifacts?: unknown[];
      /** WI-10006488: the release target; gcp writes a gcp input, a GCE disk row and GCP guest-tool rpms. */
      provider?: "aws" | "gcp";
      /** gcp only: false omits the bake's GCE disk row. */
      gcpDisk?: boolean;
      /** Shallow-merged over the input document; an undefined value deletes the key. */
      inputPatch?: Record<string, unknown>;
    } = {},
  ) {
    const provider = overrides.provider ?? "aws";
    const root = mkdtempSync(join(tmpdir(), "bootc-release-request-"));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(join(repo, "infra/images/bootc"), { recursive: true });
    const containerfile = `FROM scratch\nARG PAPERCUSP_BASE_IMAGE=${WORKSPACE_HOST_BOOTC_BASE_IMAGE}\n`;
    writeFileSync(join(repo, BOOTC_TEMPLATE_PATH), containerfile);
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    const revision = git("rev-parse", "HEAD").stdout.trim();
    if (overrides.containerfileDrift) writeFileSync(join(repo, BOOTC_TEMPLATE_PATH), `${containerfile}# drift\n`);

    const out = join(root, "out");
    const sc = join(out, "supply-chain");
    mkdirSync(sc, { recursive: true });
    writeFileSync(join(out, "bake-manifest.json"), JSON.stringify({
      contractVersion: WORKSPACE_HOST_BOOTC_BAKE_CONTRACT_VERSION,
      image: REPO,
      tag: TAG,
      digest: DIGEST,
      pinnedRef: `${REPO}@${DIGEST}`,
      registryNamespace: "127.0.0.1:5096/papercusp",
      ...(overrides.bakeRelease === "absent" ? {} : { release: overrides.bakeRelease === undefined ? { version: VERSION } : overrides.bakeRelease }),
      clouds: [
        { cloud: "aws", type: "ami", artifact: join(out, "aws/disk.raw"), sha256: "2".repeat(64), sizeBytes: 1024 },
        ...(provider === "gcp" && overrides.gcpDisk !== false
          ? [{ cloud: "gcp", type: "gce", artifact: join(out, "gcp/disk.tar.gz"), sha256: "3".repeat(64), sizeBytes: 2048 }]
          : []),
      ],
    }));
    writeFileSync(join(sc, "supply-chain-summary.json"), JSON.stringify({ digest: DIGEST, verifiedFromRegistry: true }));
    writeFileSync(join(sc, "verify-sig.log"), cosignLog(DIGEST));
    writeFileSync(join(sc, "sbom.syft.json"), JSON.stringify({
      descriptor: { name: "syft", version: "1.30.0" },
      source: {
        type: "image",
        metadata: { manifestDigest: overrides.sbomDigest ?? DIGEST, imageSize: 2_000_000_000, manifest: overrides.sbomManifest ?? IMAGE_MANIFEST_B64 },
      },
      artifacts: overrides.sbomArtifacts ??
        [{ name: "bash" }, { name: "glibc" }, { name: "openssl-libs" }, ...(provider === "gcp" ? GCP_GUEST_TOOL_RPMS : GUEST_TOOL_RPMS)],
    }));
    writeFileSync(join(sc, "vulns.json"), JSON.stringify({
      descriptor: { name: "grype", version: "0.99.0" },
      matches: [
        { artifact: { name: "openssl-libs", type: "rpm", version: "3.0.7-30.el9" }, vulnerability: { id: "CVE-1", severity: "Medium", namespace: "redhat:distro", fix: { state: "fixed" } } },
        { artifact: { name: "glibc", type: "rpm", version: "2.34-1.el9" }, vulnerability: { id: "CVE-2", severity: "High", namespace: "redhat:distro", fix: { state: "not-fixed" } } },
      ],
    }));
    writeFileSync(join(sc, "secret-scan.json"), JSON.stringify(scanRecord()));
    writeFileSync(join(sc, "secret-scan.log"), cleanLog());
    writeFileSync(join(sc, "verify-prov.json"), `${provenanceLine(HEX)}\n`);
    writeFileSync(join(sc, "provenance.json"), JSON.stringify({ buildDefinition: { internalParameters: { sourceCheckout: revision } } }));
    writeFileSync(join(root, "cosign.pub"), "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n");

    const urls = deriveWorkspaceHostCanonicalArtifactUrls(BUNDLE);
    writeFileSync(join(root, "publication.json"), JSON.stringify({
      artifact: {
        image: { id: "papercusp-workspace-host", version: VERSION },
        release: {
          version: VERSION,
          bundleUrl: urls.bundleUrl,
          bundleSha256: BUNDLE,
          signatureUrl: urls.signatureUrl,
          signingPublicKey: SIGNING_PUBLIC_KEY,
          signingKeySha256: createHash("sha256").update(SIGNING_PUBLIC_KEY, "utf8").digest("hex"),
        },
        buildManifest: {
          source: { repository: "https://github.com/Papercusp/papercusp.git", revision: "f".repeat(40) },
          releaseArtifact: { name: "server.tgz", version: VERSION, sha256: BUNDLE, sizeBytes: 42_000 },
          materials: [{ path: "dist/papercusp-server.tgz", sha256: BUNDLE, sizeBytes: 42_000 }, ...workspaceHostRequiredReleaseMaterialFixtures()],
        },
        compatibility: [{
          provider: "gcp",
          architecture: "x86_64",
          ubuntuVersion: "24.04",
          bootstrapContractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
          actions: ["install", "upgrade", "rollback"],
          maximumArtifactAgeDays: 30,
        }],
      },
      trustReport: { trusted: true },
    }));
    const publishedAt = "2026-10-02T20:30:00Z";
    const target = provider === "gcp"
      ? {
        gcp: {
          projectId: GCP_PROJECT,
          family: "papercusp-workspace-host",
          cleanRoom: { zone: "us-central1-a", serviceAccountEmail: "papercusp-vm@example.iam.gserviceaccount.com", subnetwork: "pc-rel-subnet" },
        },
        connection: { target: "gcp", cloudCredentialRef: { kind: "cloud", ref: "gcloud://active-user" } },
        readiness: gcpReadinessInput(),
      }
      : {
        aws: {
          publisherAccountId: "413781344298",
          sourceRegion: "us-east-1",
          targets: [{ region: "us-east-1", kmsKeyArn: "arn:aws:kms:us-east-1:413781344298:key/test", shareWithAccountIds: ["497149484242"] }],
          cleanAccount: { accountId: "497149484242", region: "us-east-1", subnetId: "subnet-test", instanceProfileArn: "arn:aws:iam::497149484242:instance-profile/test" },
          deprecatePreviousAt: "2026-11-01T00:00:00Z",
        },
        connection: { target: "aws" },
      };
    const input: Record<string, unknown> = {
      bakeManifest: "out/bake-manifest.json",
      cosignPublicKey: "cosign.pub",
      publicationManifest: "publication.json",
      baseImage: { architecture: "x86_64", ...(overrides.inputBaseSha256 ? { sha256: overrides.inputBaseSha256 } : {}) },
      builder: { version: "latest" },
      publishedAt,
      ...target,
    };
    for (const [key, value] of Object.entries(overrides.inputPatch ?? {})) {
      if (value === undefined) delete input[key];
      else input[key] = value;
    }
    writeFileSync(join(root, "input.json"), JSON.stringify(input));
    return { root, repo, revision, inputFile: join(root, "input.json"), publishedAt };
  }

  it("builds a trusted report bound to the bake digest, with unfixed findings scoped out", async () => {
    const f = fixture();
    const built = await buildBootcTrustReport({ inputFile: f.inputFile, repoRoot: f.repo, emit: "trust-report" }, NOW);
    expect(built.trustReport.failures).toEqual([]);
    expect(built.trustReport.trusted).toBe(true);
    expect(built.trustReport.subject.sha256).toBe(HEX);
    expect(built.excluded.unfixed).toBe(1);
  });

  describe("vendor-pending findings (D-027, WI-10005719)", () => {
    function vendorFixture(
      opts: {
        vendorUpdates?: unknown;
        ostreeObjects?: unknown;
        matches?: unknown[];
        summaryVendorPending?: string;
        summaryStaleBaseObjects?: string;
      } = {},
    ) {
      const f = fixture();
      const sc = join(f.root, "out", "supply-chain");
      writeFileSync(join(sc, "sbom.syft.json"), JSON.stringify({
        descriptor: { name: "syft", version: "1.30.0" },
        source: { type: "image", metadata: { manifestDigest: DIGEST, imageSize: 2_000_000_000, manifest: IMAGE_MANIFEST_B64 } },
        artifacts: [...vendorSbomArtifacts, { name: "bash" }],
      }));
      writeFileSync(join(sc, "vulns.json"), JSON.stringify({
        descriptor: { name: "grype", version: "0.117.0" },
        matches: opts.matches ?? [goAt("/usr/bin/skopeo", "GO-1")],
      }));
      if (opts.vendorUpdates !== undefined) writeFileSync(join(sc, "vendor-updates.json"), JSON.stringify(opts.vendorUpdates));
      if (opts.ostreeObjects !== undefined) writeFileSync(join(sc, "ostree-objects.json"), JSON.stringify(opts.ostreeObjects));
      if (opts.summaryVendorPending !== undefined || opts.summaryStaleBaseObjects !== undefined) {
        writeFileSync(join(sc, "supply-chain-summary.json"), JSON.stringify({
          digest: DIGEST,
          verifiedFromRegistry: true,
          vendorPending: opts.summaryVendorPending,
          staleBaseObjects: opts.summaryStaleBaseObjects,
        }));
      }
      return f;
    }
    const build = (f: ReturnType<typeof vendorFixture>) =>
      buildBootcTrustReport({ inputFile: f.inputFile, repoRoot: f.repo, emit: "trust-report" }, NOW);

    it("trusts an image whose only fixed High finding is vendor-pending, and reports it", async () => {
      const built = await build(vendorFixture({ vendorUpdates: vendorUpdatesRecord({ digest: DIGEST }), summaryVendorPending: "1" }));
      expect(built.trustReport.failures).toEqual([]);
      expect(built.trustReport.trusted).toBe(true);
      expect(built.excluded.vendorPending).toBe(1);
      expect(built.vendorPendingIds).toEqual(["GO-1"]);
    });

    it("denies the same finding when the bake recorded no vendor check", async () => {
      const built = await build(vendorFixture());
      expect(built.trustReport.trusted).toBe(false);
      expect(built.excluded.vendorPending).toBe(0);
    });

    it("denies it when the vendor already ships a newer RPM", async () => {
      const built = await build(vendorFixture({ vendorUpdates: vendorUpdatesRecord({ digest: DIGEST, verdict: "updates-available", checkUpdateExit: 100 }) }));
      expect(built.trustReport.trusted).toBe(false);
    });

    it("refuses a vendor record for another image, and a shell/TS count disagreement", async () => {
      await expect(build(vendorFixture({ vendorUpdates: vendorUpdatesRecord({ digest: `sha256:${"1".repeat(64)}` }) })))
        .rejects.toThrow(/vendor-updates record is for/);
      await expect(build(vendorFixture({ vendorUpdates: vendorUpdatesRecord({ digest: DIGEST }), summaryVendorPending: "0" })))
        .rejects.toThrow(/D-027 copies disagree/);
    });

    describe("ostree-object findings (D-029)", () => {
      const objectBake = (overrides: { ostreeObjects?: unknown; summaryStaleBaseObjects?: string; summaryVendorPending?: string } = {}) =>
        vendorFixture({
          matches: [goAt(OBJ_STALE, "GO-STALE"), goAt(OBJ_LIVE, "GO-LIVE")],
          vendorUpdates: vendorUpdatesRecord({ digest: DIGEST }),
          ostreeObjects: ostreeObjectsRecord({ digest: DIGEST }),
          ...overrides,
        });

      it("trusts an image whose findings are a stale base object and a relocated vendor binary, and reports both", async () => {
        const built = await build(objectBake({ summaryVendorPending: "1", summaryStaleBaseObjects: "1" }));
        expect(built.trustReport.failures).toEqual([]);
        expect(built.trustReport.trusted).toBe(true);
        expect(built.excluded).toMatchObject({ staleBaseObject: 1, vendorPending: 1 });
        expect(built.staleBaseObjectIds).toEqual(["GO-STALE"]);
        expect(built.vendorPendingIds).toEqual(["GO-LIVE"]);
      });

      it("denies both when the probe was incomplete, or the bake recorded no probe", async () => {
        for (const ostreeObjects of [ostreeObjectsRecord({ digest: DIGEST, complete: false }), undefined]) {
          const built = await build(objectBake({ ostreeObjects }));
          expect(built.trustReport.trusted).toBe(false);
          expect(built.excluded).toMatchObject({ staleBaseObject: 0, vendorPending: 0 });
        }
      });

      it("refuses a probe record for another image, and a shell/TS stale-count disagreement", async () => {
        await expect(build(objectBake({ ostreeObjects: ostreeObjectsRecord({ digest: `sha256:${"1".repeat(64)}` }) })))
          .rejects.toThrow(/ostree-objects record is for/);
        await expect(build(objectBake({ summaryVendorPending: "1", summaryStaleBaseObjects: "0" })))
          .rejects.toThrow(/D-029 copies disagree/);
      });
    });
  });

  it("refuses an SBOM that describes a different image", async () => {
    const f = fixture({ sbomDigest: `sha256:${"1".repeat(64)}` });
    await expect(buildBootcTrustReport({ inputFile: f.inputFile, repoRoot: f.repo, emit: "trust-report" }, NOW)).rejects.toThrow(/syft SBOM describes/);
  });

  // WI-10005761 (measured on P-012): an OS-only bake paired with a release booted in the clean room,
  // passed harden-os, then died at install-runtime ('release ... is not present in the booted image').
  // The artifact is what --emit clean-room-input and --emit request are built from, so refusing here
  // refuses before any clean-room spend. Calibration: the composing test below uses a matching bake.
  it.each([
    ["an OS-only bake", null, /is OS-only \(it carries no release\), but the release names/],
    ["a bake recorded before releases were recorded", "absent", /records no baked release/],
    ["a bake carrying another release", { version: "0.0.21-p318r62b" }, /carries release 0\.0\.21-p318r62b, but the release names/],
  ] as const)("refuses %s paired with the publication, naming both versions", async (_name, bakeRelease, message) => {
    const f = fixture({ bakeRelease });
    const build = buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "clean-room-input" }, NOW);
    await expect(build).rejects.toThrow(message);
    await expect(build).rejects.toThrow(new RegExp(`names ${VERSION.replace(/\./g, "\\.")}; re-bake with .*--release-version`));
  });

  it("refuses when the Containerfile moved since the bake's recorded revision", async () => {
    const f = fixture({ containerfileDrift: true });
    await expect(buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "artifact" }, NOW)).rejects.toThrow(/differs from its blob/);
  });

  describe("base image digest is read from the signed image manifest (WI-10005711)", () => {
    const build = (f: ReturnType<typeof fixture>) =>
      buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "artifact" }, NOW);

    it("attests the base digest buildah recorded on the signed manifest", async () => {
      const { artifact } = await build(fixture());
      expect(artifact.buildManifest.baseImage).toEqual({
        reference: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        architecture: "x86_64",
        sha256: BASE_HEX,
      });
    });

    it("refuses a hand-supplied baseImage.sha256, even one that matches", async () => {
      await expect(build(fixture({ inputBaseSha256: BASE_HEX }))).rejects.toThrow(/baseImage\.sha256 must not be supplied/);
    });

    it("refuses an embedded manifest that does not hash to the signed digest", async () => {
      const forged = Buffer.from(imageManifest({
        "org.opencontainers.image.base.name": WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        "org.opencontainers.image.base.digest": `sha256:${"0".repeat(64)}`,
      })).toString("base64");
      await expect(build(fixture({ sbomManifest: forged }))).rejects.toThrow(/embedded image manifest hashes to .*not the signed digest/);
    });

    // Parser-level: the artifact fixture's digest is fixed to IMAGE_MANIFEST, so a manifest naming
    // another base (or none) cannot also carry that digest; signedBaseImage is the seam that reads it.
    const sbomWith = (manifest: string) => ({ source: { metadata: { manifest: Buffer.from(manifest).toString("base64") } } });
    const digestOfManifest = (manifest: string) => `sha256:${createHash("sha256").update(manifest).digest("hex")}`;

    it("returns the base reference and digest the manifest names, without the sha256: prefix", () => {
      const other = imageManifest({
        "org.opencontainers.image.base.name": "quay.io/fedora/fedora-bootc:42",
        "org.opencontainers.image.base.digest": `sha256:${BASE_HEX}`,
      });
      expect(signedBaseImage(sbomWith(other), digestOfManifest(other))).toEqual({ reference: "quay.io/fedora/fedora-bootc:42", sha256: BASE_HEX });
    });

    it("reads nothing from an SBOM without an embedded manifest, or a manifest without base annotations", () => {
      expect(signedBaseImage({ source: { metadata: {} } }, DIGEST)).toBeNull();
      const bare = imageManifest({ "containers.bootc": "1" });
      expect(signedBaseImage(sbomWith(bare), digestOfManifest(bare))).toBeNull();
    });

    it("refuses a malformed base digest annotation", () => {
      const bad = imageManifest({ "org.opencontainers.image.base.name": WORKSPACE_HOST_BOOTC_BASE_IMAGE, "org.opencontainers.image.base.digest": "latest" });
      expect(() => signedBaseImage(sbomWith(bad), digestOfManifest(bad))).toThrow(/must be a sha256 digest/);
    });
  });

  it("refuses source verification when process admission is refused", async () => {
    const f = fixture();
    vi.mocked(runGovernedOperation).mockRejectedValueOnce(new Error("fixture admission refused"));
    await expect(buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "artifact" }, NOW))
      .rejects.toThrow("fixture admission refused");
    expect(runGovernedOperation).toHaveBeenLastCalledWith(expect.objectContaining({
      namespace: "bootc-release-source-verification", admissionClass: "process", dedicatedClient: true,
      demand: { fileDescriptors: 3 }, leaseTtlMs: 35000,
    }), expect.any(Function));
  });

  it("composes an AWS request the release gate accepts, and refuses a report for another image", async () => {
    const f = fixture();
    const { artifact } = await buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "artifact" }, NOW);
    expect(artifact.release.bundleSha256).toBe(BUNDLE);
    expect(artifact.image.version).toBe(VERSION);
    const spec: WorkspaceHostCleanRoomInstallSpec = {
      fixtureId: "aws-bootc-clean-room",
      action: "install",
      provider: "aws",
      architecture: "x86_64",
      hostModel: "bootc-image",
      bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
      observedAt: f.publishedAt,
      hostId: "clean-host-1",
      migrationId: "schema-1272",
      minimumNodeMajor: 22,
      service: { name: "papercusp-workspace", port: 3070 },
    };
    const cleanFixture = buildWorkspaceHostCleanRoomInstallFixture(artifact, spec);
    const report = {
      contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
      fixtureId: spec.fixtureId,
      image: artifact.image,
      passed: true,
      checks: ["artifact-identity", "compatibility-matrix", "deterministic-bootstrap-fixture", "exact-bootstrap-attestation"],
      issues: [],
      bootstrapScriptSha256: cleanFixture.bootstrapScriptSha256,
      attestation: workspaceHostCleanRoomFixtureAttestation(cleanFixture, spec.observedAt),
    };
    const reportFile = join(f.root, "clean-room.json");
    writeFileSync(reportFile, JSON.stringify({ cleanRoomReport: report }));
    const composed = await composeBootcAwsRequest({ inputFile: f.inputFile, repoRoot: f.repo, emit: "request", cleanRoomReportFile: reportFile }, NOW);
    expect(composed.request.releaseGate.bootcBakeManifest?.digest).toBe(DIGEST);
    expect(composed.request.cleanAccount.accountId).toBe("497149484242");
    // WI-10006386: every required guest tool's version comes from the bake's own SBOM.
    expect(composed.request.guestToolVersions).toEqual(
      Object.fromEntries(GUEST_TOOL_RPMS.map((row) => [row.name, row.version])),
    );

    writeFileSync(reportFile, JSON.stringify({ cleanRoomReport: { ...report, image: { ...report.image, version: "other" } } }));
    await expect(
      composeBootcAwsRequest({ inputFile: f.inputFile, repoRoot: f.repo, emit: "request", cleanRoomReportFile: reportFile }, NOW),
    ).rejects.toThrow(/clean-room report is for/);

    // WI-10006386: an image whose rpm database lacks a required guest tool composes no request.
    writeFileSync(reportFile, JSON.stringify({ cleanRoomReport: report }));
    const sbomPath = join(f.root, "out/supply-chain/sbom.syft.json");
    const sbom = JSON.parse(readFileSync(sbomPath, "utf8")) as { artifacts: { name?: string }[] };
    sbom.artifacts = sbom.artifacts.filter((row) => row.name !== "amazon-ssm-agent");
    writeFileSync(sbomPath, JSON.stringify(sbom));
    await expect(
      composeBootcAwsRequest({ inputFile: f.inputFile, repoRoot: f.repo, emit: "request", cleanRoomReportFile: reportFile }, NOW),
    ).rejects.toThrow(/no installed rpm for guest tool\(s\): amazon-ssm-agent/);
  });

  describe("GCP image-family request (WI-10006488)", () => {
    /** A passing clean-room report for exactly this artifact, as the clean-room acceptance CLI writes it. */
    function writePassingReport(
      f: ReturnType<typeof fixture>,
      artifact: Extract<WorkspaceHostImageArtifact, { hostModel: "bootc-image" }>,
      patch: Record<string, unknown> = {},
    ): string {
      const spec: WorkspaceHostCleanRoomInstallSpec = {
        fixtureId: "gcp-bootc-clean-room",
        action: "install",
        provider: "gcp",
        architecture: "x86_64",
        hostModel: "bootc-image",
        bootcBaseImage: WORKSPACE_HOST_BOOTC_BASE_IMAGE,
        observedAt: f.publishedAt,
        hostId: "clean-host-1",
        migrationId: "schema-1272",
        minimumNodeMajor: 22,
        service: { name: "papercusp-workspace", port: 3070 },
      };
      const cleanFixture = buildWorkspaceHostCleanRoomInstallFixture(artifact, spec);
      const reportFile = join(f.root, "clean-room.json");
      writeFileSync(reportFile, JSON.stringify({
        cleanRoomReport: {
          contractVersion: WORKSPACE_HOST_IMAGE_ACCEPTANCE_CONTRACT_VERSION,
          fixtureId: spec.fixtureId,
          image: artifact.image,
          passed: true,
          checks: ["artifact-identity", "compatibility-matrix", "deterministic-bootstrap-fixture", "exact-bootstrap-attestation"],
          issues: [],
          bootstrapScriptSha256: cleanFixture.bootstrapScriptSha256,
          attestation: workspaceHostCleanRoomFixtureAttestation(cleanFixture, spec.observedAt),
          ...patch,
        },
      }));
      return reportFile;
    }

    async function gcpFixture(overrides: Parameters<typeof fixture>[0] = {}) {
      const f = fixture({ provider: "gcp", ...overrides });
      const { artifact } = await buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "artifact" }, NOW);
      const reportFile = writePassingReport(f, artifact);
      const args = { inputFile: f.inputFile, repoRoot: f.repo, emit: "request" as const, cleanRoomReportFile: reportFile };
      return { f, artifact, reportFile, args };
    }

    it("composes a request the release gate accepts, targeted at the project and importing the bake's GCE disk", async () => {
      const { f, artifact, args } = await gcpFixture();
      // The artifact itself is GCP-targeted: a gcp input never yields an AWS-compatible image.
      expect(artifact.buildManifest.targets).toEqual([{ provider: "gcp", locations: [GCP_PROJECT] }]);
      expect(artifact.compatibility.map((rule) => rule.provider)).toEqual(["gcp"]);

      const composed = await composeBootcGcpRequest(args, NOW);
      expect(evaluateWorkspaceHostReleaseGate(composed.request.releaseGate).accepted).toBe(true);
      expect(composed.request.releaseGate.compatibilityRequest.provider).toBe("gcp");
      expect(composed.request.releaseGate.bootcBakeManifest?.clouds.map((cloud) => cloud.cloud)).toContain("gcp");
      expect(composed.request).toMatchObject({
        projectId: GCP_PROJECT,
        family: "papercusp-workspace-host",
        publishedAt: f.publishedAt,
        cleanRoom: { zone: "us-central1-a", serviceAccountEmail: "papercusp-vm@example.iam.gserviceaccount.com", subnetwork: "pc-rel-subnet" },
      });
      expect(composed.request).not.toHaveProperty("previousVersion");
      // Every required GCP guest tool's version comes from the bake's own SBOM.
      expect(composed.request.guestToolVersions).toEqual(
        Object.fromEntries(GCP_GUEST_TOOL_RPMS.map((row) => [row.name, row.version])),
      );
      // A TYPED credential reference, scoped to the release project.
      expect(composed.connection).toEqual({
        target: "gcp",
        cloudCredentialRef: { kind: "cloud", ref: "gcloud://active-user" },
        scope: { kind: "project", id: GCP_PROJECT },
        provider: { projectId: GCP_PROJECT },
      });
      // Readiness: user and cwd captured from this process, source from the bake's recorded revision.
      expect(composed.readiness.expected).toEqual({ username: userInfo().username, cwd: realpathSync(f.repo) });
      expect(composed.readiness.source).toMatchObject({
        repository: "https://github.com/Papercusp/papercusp.git",
        revision: f.revision,
      });
    });

    it("dispatches --emit request to the GCP composer for a gcp input", async () => {
      const { args } = await gcpFixture();
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
      // main() reads the wall clock; the fixture's attestation is dated on the fixture clock.
      const clock = vi.spyOn(Date, "now").mockImplementation(NOW);
      try {
        await main(["--input-file", args.inputFile, "--repo-root", args.repoRoot, "--emit", "request", "--clean-room-report", args.cleanRoomReportFile]);
      } finally {
        spy.mockRestore();
        clock.mockRestore();
      }
      const document = JSON.parse(chunks.join("")) as Record<string, Record<string, unknown>>;
      expect(Object.keys(document).sort()).toEqual(["connection", "readiness", "request"]);
      expect(document.request?.projectId).toBe(GCP_PROJECT);
      expect(document.connection?.target).toBe("gcp");
    });

    it("refuses an input naming both providers, or neither", async () => {
      const both = fixture({ provider: "gcp", inputPatch: { aws: { targets: [{ region: "us-east-1" }] } } });
      await expect(buildBootcImageArtifact({ inputFile: both.inputFile, repoRoot: both.repo, emit: "artifact" }, NOW))
        .rejects.toThrow(/names both aws and gcp/);
      const neither = fixture({ provider: "gcp", inputPatch: { gcp: undefined } });
      await expect(buildBootcImageArtifact({ inputFile: neither.inputFile, repoRoot: neither.repo, emit: "artifact" }, NOW))
        .rejects.toThrow(/names neither aws nor gcp/);
    });

    it("refuses a bake that rendered no GCE disk before any clean-room spend", async () => {
      const f = fixture({ provider: "gcp", gcpDisk: false });
      await expect(buildBootcImageArtifact({ inputFile: f.inputFile, repoRoot: f.repo, emit: "clean-room-input" }, NOW))
        .rejects.toThrow(/cannot be released to gcp: clouds is missing provider 'gcp'/);
    });

    it("refuses a bare-string credential, a connection scoped to another project, and a failing report", async () => {
      const bare = await gcpFixture({ inputPatch: { connection: { target: "gcp", cloudCredentialRef: "gcloud://active-user" } } });
      await expect(composeBootcGcpRequest(bare.args, NOW)).rejects.toThrow(/typed \{ kind: 'cloud', ref \} reference/);

      const elsewhere = await gcpFixture({
        inputPatch: {
          connection: { target: "gcp", cloudCredentialRef: { kind: "cloud", ref: "gcloud://active-user" }, scope: { kind: "project", id: "other-project" } },
        },
      });
      await expect(composeBootcGcpRequest(elsewhere.args, NOW)).rejects.toThrow(/publishes into project papercusp-release-test/);

      const failed = await gcpFixture();
      writePassingReport(failed.f, failed.artifact, { passed: false });
      await expect(composeBootcGcpRequest(failed.args, NOW)).rejects.toThrow(/clean-room report did not pass/);
    });

    it("refuses to compose one provider's request from the other provider's input", async () => {
      const gcp = await gcpFixture();
      await expect(composeBootcAwsRequest(gcp.args, NOW)).rejects.toThrow(/the input targets gcp, not aws/);
      const f = fixture();
      await expect(
        composeBootcGcpRequest({ inputFile: f.inputFile, repoRoot: f.repo, emit: "request", cleanRoomReportFile: gcp.reportFile }, NOW),
      ).rejects.toThrow(/the input targets aws, not gcp/);
    });

    it("refuses an image whose rpm database lacks a required GCP guest tool", async () => {
      const { f, args } = await gcpFixture();
      const sbomPath = join(f.root, "out/supply-chain/sbom.syft.json");
      const sbom = JSON.parse(readFileSync(sbomPath, "utf8")) as { artifacts: { name?: string }[] };
      sbom.artifacts = sbom.artifacts.filter((row) => row.name !== "google-guest-agent");
      writeFileSync(sbomPath, JSON.stringify(sbom));
      await expect(composeBootcGcpRequest(args, NOW)).rejects.toThrow(/no installed rpm for guest tool\(s\): google-guest-agent/);
    });
  });
});
