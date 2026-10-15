import { describe, expect, it, vi } from "vitest";

import {
  awsAmiReleaseCompositionOptions,
  parseAwsAmiReleaseCliArgs,
  parseAwsAmiReleaseCliInput,
  runAwsAmiReleaseCli,
} from "./aws-ami-release-cli";

const request = { publisherAccountId: "413781344298" } as never;
const connection = {
  target: "aws",
  cloudCredentialRef: {
    kind: "cloud",
    ref: "aws-role://arn:aws:iam::413781344298:role/papercusp-publisher",
  },
  scope: { kind: "account", id: "413781344298" },
  provider: { region: "us-east-2" },
} as never;

const goodCredential = {
  ok: true,
  accountId: "413781344298",
  identityArn: "arn:aws:sts::413781344298:assumed-role/papercusp-publisher/s",
  resolvedAccountId: "413781344298",
};
const goodExecutables = {
  ok: true,
  executables: [
    { role: "coldsnap", executable: "coldsnap", ok: true, path: "/usr/bin/coldsnap" },
  ],
} as const;
const releaseResult = {
  contractVersion: "papercusp-aws-ami-release-v1",
} as never;

describe("aws AMI release CLI", () => {
  it("requires a request file and parses the optional flags", () => {
    expect(() => parseAwsAmiReleaseCliArgs([])).toThrow(/--request-file/);
    expect(
      parseAwsAmiReleaseCliArgs([
        "--request-file",
        "/tmp/release.json",
        "--repo-root",
        "/repo",
        "--guest-tool-versions-file",
        "/tmp/tools.json",
        "--parameter-prefix",
        "/papercusp/staging/ami",
        "--json",
      ]),
    ).toEqual({
      requestFile: "/tmp/release.json",
      repositoryRoot: "/repo",
      guestToolVersionsFile: "/tmp/tools.json",
      parameterPrefix: "/papercusp/staging/ami",
      json: true,
    });
  });

  it("rejects unknown, repeated, value-less and relative-path flags", () => {
    expect(() =>
      parseAwsAmiReleaseCliArgs(["--request-file", "/tmp/r", "--typo"]),
    ).toThrow(/unknown argument/);
    expect(() =>
      parseAwsAmiReleaseCliArgs([
        "--request-file",
        "/tmp/a",
        "--request-file",
        "/tmp/b",
      ]),
    ).toThrow(/only once/);
    expect(() =>
      parseAwsAmiReleaseCliArgs(["--request-file", "--json"]),
    ).toThrow(/requires a value/);
    expect(() =>
      parseAwsAmiReleaseCliArgs([
        "--request-file",
        "/tmp/r",
        "--parameter-prefix",
        "papercusp/ami",
      ]),
    ).toThrow(/absolute SSM path/);
  });

  it("validates the envelope and refuses a non-AWS connection", () => {
    expect(() => parseAwsAmiReleaseCliInput({ request })).toThrow(
      /request and connection/,
    );
    expect(() =>
      parseAwsAmiReleaseCliInput({
        request,
        connection: { target: "gcp" },
      }),
    ).toThrow(/connection.target must be 'aws', got 'gcp'/);
    expect(parseAwsAmiReleaseCliInput({ request, connection })).toEqual({
      request,
      connection,
    });
  });

  it("parses explicit candidate recovery and keeps it on the production composition", () => {
    const args = parseAwsAmiReleaseCliArgs(["--request-file", "/tmp/r", "--resume-candidate-ami", "ami-0abc"]);
    expect(awsAmiReleaseCompositionOptions(args, undefined, {})).toEqual({ resumeCandidateImageId: "ami-0abc" });
    expect(() => parseAwsAmiReleaseCliArgs(["--request-file", "/tmp/r", "--resume-candidate-ami", "latest"]))
      .toThrow(/must be an AMI id/);
  });

  it("maps flags and executable env overrides onto composition options", () => {
    const options = awsAmiReleaseCompositionOptions(
      {
        requestFile: "/tmp/r",
        repositoryRoot: "/repo",
        parameterPrefix: "/p/ami",
        json: false,
      },
      { "amazon-ssm-agent": "3.3.1" },
      {
        PAPERCUSP_AWS_COLDSNAP_EXECUTABLE: "/opt/coldsnap",
        PAPERCUSP_AWS_AMI_SCAN_EXECUTABLE: "/opt/scan",
        PAPERCUSP_AWS_AMI_CANARY_EXECUTABLE: "/opt/canary",
      },
    );
    expect(options).toEqual({
      repositoryRoot: "/repo",
      guestToolVersions: { "amazon-ssm-agent": "3.3.1" },
      parameterPrefix: "/p/ami",
      coldsnapExecutable: "/opt/coldsnap",
      scanExecutable: "/opt/scan",
      canaryExecutable: "/opt/canary",
    });
    expect(
      awsAmiReleaseCompositionOptions({ requestFile: "/tmp/r", json: false }, undefined, {}),
    ).toEqual({});
  });

  it("probes first, then routes the request through the production executor", async () => {
    const order: string[] = [];
    const probeCredential = vi.fn(async () => {
      order.push("credential");
      return goodCredential;
    });
    const probeExecutables = vi.fn(async () => {
      order.push("executables");
      return goodExecutables;
    });
    const execute = vi.fn(async () => {
      order.push("execute");
      return releaseResult;
    });
    const options = { repositoryRoot: "/repo" };
    const outcome = await runAwsAmiReleaseCli({ request, connection }, options, {
      probeCredential,
      probeExecutables,
      execute,
    });
    expect(probeCredential).toHaveBeenCalledWith(connection);
    expect(probeExecutables).toHaveBeenCalledWith(options);
    expect(execute).toHaveBeenCalledWith(request, connection, options);
    expect(order.at(-1)).toBe("execute");
    expect(outcome).toEqual({
      ok: true,
      accountId: "413781344298",
      identityArn: goodCredential.identityArn,
      result: releaseResult,
    });
  });

  it('parses the contained receipt route and refuses mixing it with private recovery', () => {
    const args = parseAwsAmiReleaseCliArgs(['--request-file', '/tmp/r', '--contained-candidate-receipt-file', '/tmp/c']);
    expect(args.containedCandidateReceiptFile).toBe('/tmp/c');
    expect(() => awsAmiReleaseCompositionOptions(args, undefined, {})).toThrow(/receipt must be read/);
    const receipt = { imageId: 'ami-0abc' } as never;
    expect(awsAmiReleaseCompositionOptions(args, undefined, {}, receipt)).toEqual({ containedCandidateRecovery: receipt });
    expect(() => parseAwsAmiReleaseCliArgs(['--request-file', '/tmp/r', '--resume-candidate-ami', 'ami-0abc', '--contained-candidate-receipt-file', '/tmp/c']))
      .toThrow(/mutually exclusive/);
  });

  it("never reaches the executor when the credential resolves to another account", async () => {
    const wrongAccount = {
      ok: false,
      accountId: "413781344298",
      resolvedAccountId: "111122223333",
      error: "credential resolves to account '111122223333', not '413781344298'",
    };
    const execute = vi.fn(async () => releaseResult);
    const outcome = await runAwsAmiReleaseCli({ request, connection }, {}, {
      probeCredential: async () => wrongAccount,
      probeExecutables: async () => goodExecutables,
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      ok: false,
      stage: "prerequisite",
      credential: wrongAccount,
      executables: goodExecutables,
    });
  });

  it("never reaches the executor when a release executable is missing", async () => {
    const missing = {
      ok: false,
      executables: [{ role: "coldsnap", executable: "coldsnap", ok: false }],
    } as const;
    const execute = vi.fn(async () => releaseResult);
    const outcome = await runAwsAmiReleaseCli({ request, connection }, {}, {
      probeCredential: async () => goodCredential,
      probeExecutables: async () => missing,
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });
});
