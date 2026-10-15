import { describe, expect, it } from "vitest";

import {
  awsCleanRoomFixtureSpec,
  awsCleanRoomCompositionOptionsFromEnv,
  composeAwsBootcCleanRoomExecutor,
  parseCleanRoomAcceptanceCliInput,
} from "./workspace-host-clean-room-acceptance-cli";
import { workspaceHostAgentRuntimeInstalls } from "@papercusp/operator-core/lib/workspace-host/provision-bootstrap";
import type { WorkspaceHostCleanRoomInstallSpec } from "@papercusp/deployment-driver";

const bootcArtifact = { cloud: "aws", type: "ami", artifact: "/bake/disk.raw", sha256: "d".repeat(64), sizeBytes: 14 };
const awsInput = {
  artifact: { image: { id: "papercusp-workspace-host", version: "0.0.21" } },
  spec: { architecture: "x86_64" },
  placement: {
    provider: "aws",
    region: "us-east-1",
    cleanAccount: {
      accountId: "497149484242",
      subnetId: "subnet-09ee34a782efad158",
      instanceProfileArn: "arn:aws:iam::497149484242:instance-profile/papercusp-ami-canary-instance",
    },
    bootcArtifact,
  },
  connection: { target: "aws", scope: { id: "413781344298" } },
};

describe("parseCleanRoomAcceptanceCliInput — AWS bootc placement (WI-10005633)", () => {
  it("binds the clean account, the bake's AWS disk row and the connection; architecture falls back to the spec", () => {
    const parsed = parseCleanRoomAcceptanceCliInput(awsInput);
    expect(parsed.placement).toEqual({
      provider: "aws",
      region: "us-east-1",
      cleanAccount: awsInput.placement.cleanAccount,
      bootcArtifact,
      architecture: "x86_64",
    });
    expect("connection" in parsed && parsed.connection).toEqual(awsInput.connection);
  });

  it("refuses an AWS placement without an AWS connection or with a non-AWS disk row", () => {
    expect(() => parseCleanRoomAcceptanceCliInput({ ...awsInput, connection: undefined })).toThrow(/input.connection/);
    expect(() => parseCleanRoomAcceptanceCliInput({ ...awsInput, connection: { target: "gcp" } })).toThrow(/must be 'aws'/);
    expect(() =>
      parseCleanRoomAcceptanceCliInput({ ...awsInput, placement: { ...awsInput.placement, bootcArtifact: { ...bootcArtifact, cloud: "gcp" } } }),
    ).toThrow(/AWS\/ami row/);
  });
});

describe("composeAwsBootcCleanRoomExecutor", () => {
  const parsed = parseCleanRoomAcceptanceCliInput(awsInput) as Parameters<typeof composeAwsBootcCleanRoomExecutor>[0];
  const okExecutables = async () => ({
    ok: false,
    executables: [
      { role: "coldsnap" as const, executable: "coldsnap", ok: true },
      { role: "scan" as const, executable: "papercusp-aws-ami-scan", ok: false },
      { role: "canary" as const, executable: "papercusp-aws-ami-clean-account-canary", ok: true },
    ],
  });

  it("refuses before any AWS call when the connection credential does not resolve to its account", async () => {
    await expect(
      composeAwsBootcCleanRoomExecutor(parsed, {}, {
        credential: async () => ({ ok: false, accountId: "413781344298", error: "credential resolves to account '1'" }),
        executables: okExecutables,
      }),
    ).rejects.toThrow(/prerequisite failed: credential resolves/);
  });

  it("refuses when the canary is not executable, but does not require the scanner", async () => {
    await expect(
      composeAwsBootcCleanRoomExecutor(parsed, {}, {
        credential: async () => ({ ok: true, accountId: "413781344298" }),
        executables: async () => ({
          ok: false,
          executables: [
            { role: "coldsnap" as const, executable: "coldsnap", ok: true },
            { role: "canary" as const, executable: "papercusp-aws-ami-clean-account-canary", ok: false },
          ],
        }),
      }),
    ).rejects.toThrow(/not executable: papercusp-aws-ami-clean-account-canary/);
  });

  it("reads executable overrides from the same env names as the AWS release CLI", () => {
    expect(
      awsCleanRoomCompositionOptionsFromEnv({
        PAPERCUSP_AWS_COLDSNAP_EXECUTABLE: "/home/u/.cargo/bin/coldsnap",
        PAPERCUSP_AWS_AMI_CANARY_EXECUTABLE: "/bin/canary",
      }),
    ).toEqual({ coldsnapExecutable: "/home/u/.cargo/bin/coldsnap", canaryExecutable: "/bin/canary" });
  });
});

describe("awsCleanRoomFixtureSpec", () => {
  it("uses the production runtime set and the EC2 console status channel", () => {
    const spec = {
      fixtureId: "aws-clean-room-fixture",
      action: "install",
      provider: "aws",
      architecture: "x86_64",
      observedAt: "2026-10-10T00:00:00Z",
      hostId: "aws-clean-room-host",
      migrationId: "1013",
      minimumNodeMajor: 22,
      service: { name: "papercusp-workspace", port: 3070, user: "root", group: "root" },
    } as WorkspaceHostCleanRoomInstallSpec;

    expect(awsCleanRoomFixtureSpec(spec)).toMatchObject({
      agentRuntimeInstalls: workspaceHostAgentRuntimeInstalls(),
      statusChannel: "ec2-console-output",
    });
  });
});
