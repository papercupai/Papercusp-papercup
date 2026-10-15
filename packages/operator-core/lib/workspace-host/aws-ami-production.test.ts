import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WORKSPACE_HOST_BOOTC_BUILDER_KIND, type WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import { canonicalize } from '@papercusp/publish-auth/jcs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  awsAmiReleaseDescription,
  buildAwsAmiVersionManifest,
  parseAwsAmiReleaseDescription,
  type AwsAmiReleaseRequest,
} from './aws-ami-release';
import {
  AWS_AMI_COMMAND_ERROR_DETAIL_CHARS,
  AWS_AMI_CONTAINED_CANARY_TAG,
  type AwsAmiCandidateContainmentReceipt,
  assertAwsAmiTaskBudget,
  SdkAwsAmiReleaseAdapter,
  composeAwsAmiReleaseAdapter,
  executeConfiguredAwsAmiRelease,
  probeAwsAmiCredential,
  type AwsAmiCommandRunner,
} from './aws-ami-production';
import { NodeGcpImageFamilyCommandRunner } from './gcp-image-family-adapter';
import { CANARY_BUDGETS } from '../../bin/aws-ami-canary-measure.mjs';
import { AWS_AMI_SCAN_RUNNER_TIMEOUT_MS } from '../../bin/aws-ami-scan-measure.mjs';
import { TASK_DEADLINE_EPOCH_MS_ENV } from '../systemd-scope';

const KMS = 'arn:aws:kms:us-east-1:111111111111:key/abc';
const SHARE_ACCOUNT = '497149484242';
const SHARE_GRANT_NAME = 'papercusp-ami-share-v1-' + SHARE_ACCOUNT;
const SHARE_GRANT_OPERATIONS = ['CreateGrant', 'Decrypt', 'DescribeKey', 'ReEncryptFrom'];
const SHA = 'a'.repeat(64);
const TOOLS = ['amazon-ssm-agent', 'openssh-server'];

type Call = { name: string; input: Record<string, unknown> };

function fakeSender(responses: Record<string, (input: Record<string, unknown>) => unknown>, calls: Call[]) {
  return {
    send: async (command: unknown) => {
      const { constructor, input } = command as { constructor: { name: string }; input: Record<string, unknown> };
      calls.push({ name: constructor.name, input });
      const respond = responses[constructor.name];
      if (!respond) throw new Error(`unexpected command ${constructor.name}`);
      return respond(input);
    },
  };
}

function fakeCommands(stdout: string, runs: unknown[]): AwsAmiCommandRunner {
  return { run: async (command) => (runs.push(command), { exitCode: 0, stdout, stderr: '' }) };
}

let dir: string;
let diskPath: string;
let diskSha: string;
beforeEach(async () => {
  // Unit adapters have their own injected clock; the test runner's task deadline is unrelated.
  vi.stubEnv(TASK_DEADLINE_EPOCH_MS_ENV, undefined);
  dir = await mkdtemp(join(tmpdir(), 'aws-ami-production-'));
  diskPath = join(dir, 'disk.raw');
  await writeFile(diskPath, 'bootc-ami-disk');
  diskSha = createHash('sha256').update('bootc-ami-disk').digest('hex');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('AWS AMI inherited task budget preflight (WI-10007501)', () => {
  it('uses remaining absolute time rather than restarting a duration at each phase', () => {
    const env = { [TASK_DEADLINE_EPOCH_MS_ENV]: '10000' };
    expect(() => assertAwsAmiTaskBudget('publication', () => 5000, 5000, env)).not.toThrow();
    expect(() => assertAwsAmiTaskBudget('publication', () => 5000, 5001, env))
      .toThrow(/remainingMs=4999 requiredMs=5000/);
    expect(() => assertAwsAmiTaskBudget('publication', () => 5000, 10001, env))
      .toThrow(/AWS_AMI_TASK_BUDGET_REFUSAL/);
  });

  it('keeps unbounded calls unchanged and refuses malformed inherited deadlines', () => {
    const derive = vi.fn(() => 5000);
    assertAwsAmiTaskBudget('publication', derive, 0, {});
    expect(derive).not.toHaveBeenCalled();
    for (const raw of ['', 'invalid', '-1', 'Infinity', '1.5']) {
      expect(() => assertAwsAmiTaskBudget('publication', derive, 0, { [TASK_DEADLINE_EPOCH_MS_ENV]: raw }))
        .toThrow(/invalid inherited/);
    }
  });

  it('refuses a three-hour clean-room envelope before any upload or AWS mutation', async () => {
    vi.stubEnv(TASK_DEADLINE_EPOCH_MS_ENV, String(3 * 60 * 60_000));
    const calls: Call[] = [];
    const runs: unknown[] = [];
    const adapter = new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, calls), ssm: () => fakeSender({}, calls), kms: () => fakeSender({}, calls),
      childCredentials: async () => ({}), commands: fakeCommands('', runs), now: () => 0,
    });
    await expect(adapter.stageCleanRoomImage({
      region: 'us-east-1', bootcArtifact: buildInput().bootcArtifact!,
      imageName: 'clean-room', description: 'test', architecture: 'x86_64',
      shareWithAccountId: SHARE_ACCOUNT, tags: {},
    })).rejects.toThrow(/AWS_AMI_TASK_BUDGET_REFUSAL clean room/);
    expect(calls).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('does not start a scan or create a canary when only one minute remains', async () => {
    vi.stubEnv(TASK_DEADLINE_EPOCH_MS_ENV, '60000');
    const calls: Call[] = [];
    const runs: unknown[] = [];
    const adapter = new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, calls), ssm: () => fakeSender({}, calls), kms: () => fakeSender({}, calls),
      childCredentials: async () => ({}), commands: fakeCommands('{}', runs), now: () => 0,
    });
    await expect(adapter.scanImage({ region: 'us-east-1', imageId: 'ami-0abc', buildManifestIdentity: `sha256:${SHA}`, releaseSha256: SHA }))
      .rejects.toThrow(/AWS_AMI_TASK_BUDGET_REFUSAL AMI scan/);
    await expect(adapter.launchCleanAccountCanary({ region: 'us-east-1', fixture: { bootstrapScript: 'x'.repeat(24001) } } as never))
      .rejects.toThrow(/AWS_AMI_TASK_BUDGET_REFUSAL clean-account canary/);
    expect(calls).toEqual([]);
    expect(runs).toEqual([]);
  });
});

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    sourceRegion: 'us-east-1',
    imageName: 'papercusp-workspace-host-2026.10.1',
    description: awsAmiReleaseDescription('2026.10.1', SHA),
    kmsKeyArn: KMS,
    builderKind: WORKSPACE_HOST_BOOTC_BUILDER_KIND,
    templatePath: 'infra/images/bootc/workspace-host.Containerfile',
    bootcArtifact: { cloud: 'aws' as const, type: 'ami' as const, artifact: diskPath, sha256: diskSha, sizeBytes: 14 },
    buildManifestIdentity: `sha256:${'c'.repeat(64)}`,
    releaseVersion: '2026.10.1',
    releaseSha256: SHA,
    architecture: 'x86_64',
    requiredGuestTools: TOOLS,
    tags: { 'papercusp:managed': 'true' },
    ...overrides,
  } as Parameters<SdkAwsAmiReleaseAdapter['buildCandidate']>[0];
}

function adapterWith(
  ec2Calls: Call[],
  runs: unknown[],
  ec2Responses: Record<string, (input: Record<string, unknown>) => unknown> = {},
  kmsResponses: Record<string, (input: Record<string, unknown>) => unknown> = {},
) {
  return new SdkAwsAmiReleaseAdapter(
    {
      ec2: () => fakeSender(ec2Responses, ec2Calls),
      ssm: () => fakeSender({}, ec2Calls),
      kms: () => fakeSender(kmsResponses, ec2Calls),
      childCredentials: async () => ({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' }),
      commands: fakeCommands('Uploaded snapshot snap-0abc123\n', runs),
      sleep: async () => {},
    },
    { guestToolVersions: { 'amazon-ssm-agent': '3.3.1', 'openssh-server': '9.6' } },
  );
}

describe('AWS AMI release description (cross-account provenance)', () => {
  it('round-trips version and digest, and rejects anything else', () => {
    expect(parseAwsAmiReleaseDescription(awsAmiReleaseDescription('2026.10.1', SHA))).toEqual({
      releaseVersion: '2026.10.1',
      releaseSha256: SHA,
    });
    expect(parseAwsAmiReleaseDescription('Canonical, Ubuntu, 24.04')).toBeUndefined();
    expect(() => awsAmiReleaseDescription('has space', SHA)).toThrow(/version token/);
  });
});

describe('SdkAwsAmiReleaseAdapter private candidate recovery', () => {
  function recovery(calls: Call[], runs: unknown[], contained = false) {
    const input = buildInput();
    const provenance = {
      'papercusp:managed': 'true',
      'papercusp:build-manifest': input.buildManifestIdentity,
      'papercusp:release-sha256': input.releaseSha256,
      'papercusp:image-version': input.releaseVersion,
    };
    const toTags = (values: Record<string, string>) => Object.entries(values).map(([Key, Value]) => ({ Key, Value }));
    const image = {
      ImageId: 'ami-0abc', OwnerId: '111111111111', Name: input.imageName,
      Description: input.description, State: 'available', Architecture: input.architecture,
      RootDeviceName: '/dev/xvda',
      BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { SnapshotId: 'snap-0abc', Encrypted: true } }],
      Tags: toTags({ ...provenance, 'papercusp:guest-tool:amazon-ssm-agent': '3.3.1', 'papercusp:guest-tool:openssh-server': '9.6' }),
    };
    const snapshot = {
      SnapshotId: 'snap-0abc', OwnerId: '111111111111', State: 'completed',
      Encrypted: true, KmsKeyId: KMS, VolumeSize: 1, Tags: toTags(provenance),
    };
    const launch = { LaunchPermissions: [] as { Group?: string; UserId?: string }[] };
    const permissions = { CreateVolumePermissions: [] as { Group?: string; UserId?: string }[] };
    const receipt: AwsAmiCandidateContainmentReceipt = {
      schemaVersion: 1, publisherAccountId: '111111111111', region: input.sourceRegion,
      imageId: 'ami-0abc', snapshotId: 'snap-0abc', releaseSha256: input.releaseSha256,
      buildManifestIdentity: input.buildManifestIdentity, cleanAccountId: SHARE_ACCOUNT,
      canaryInstanceId: 'i-0abc', terminated: true, residualResourceIds: [],
      observedAt: new Date().toISOString(), evidenceRef: 'work-item:WI-10007515/custody-receipt',
    };
    if (contained) {
      image.Tags.push({ Key: AWS_AMI_CONTAINED_CANARY_TAG, Value: receipt.canaryInstanceId });
      snapshot.Tags.push({ Key: AWS_AMI_CONTAINED_CANARY_TAG, Value: receipt.canaryInstanceId });
    }
    const deps = {
      publisherAccountId: '111111111111',
      ec2: () => fakeSender({
        DescribeImagesCommand: () => ({ Images: [image] }),
        DescribeImageAttributeCommand: () => launch,
        DescribeSnapshotsCommand: () => ({ Snapshots: [snapshot] }),
        DescribeSnapshotAttributeCommand: () => permissions,
      }, calls),
      ssm: () => fakeSender({}, calls), kms: () => fakeSender({}, calls),
      childCredentials: async () => ({}), commands: fakeCommands('', runs),
    };
    const adapter = new SdkAwsAmiReleaseAdapter(deps, {
      ...(contained ? { containedCandidateRecovery: receipt } : { resumeCandidateImageId: 'ami-0abc' }),
      guestToolVersions: { 'amazon-ssm-agent': '3.3.1', 'openssh-server': '9.6' },
    });
    return { input, image, snapshot, launch, permissions, deps, adapter, receipt };
  }

  it('admits explicit contained custody and keeps it forbidden on the original private path', async () => {
    const calls: Call[] = []; const runs: unknown[] = []; const f = recovery(calls, runs, true);
    await expect(f.adapter.buildCandidate(f.input)).resolves.toEqual({ imageId: 'ami-0abc' });
    expect(runs).toEqual([]); expect(calls.every(x => x.name.startsWith('Describe'))).toBe(true);
    const original = new SdkAwsAmiReleaseAdapter(f.deps, {
      resumeCandidateImageId: 'ami-0abc', guestToolVersions: { 'amazon-ssm-agent': '3.3.1', 'openssh-server': '9.6' },
    });
    await expect(original.buildCandidate(f.input)).rejects.toThrow(/formerly shared candidate/);
  });

  it.each(['publisherAccountId', 'region', 'releaseSha256', 'buildManifestIdentity', 'canaryInstanceId', 'observedAt', 'evidenceRef'])(
    'refuses a contained recovery receipt with invalid %s', async field => {
      const calls: Call[] = []; const runs: unknown[] = []; const f = recovery(calls, runs, true);
      (f.receipt as unknown as Record<string, unknown>)[field] = '';
      await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/fresh exact custody receipt/);
      expect(calls).toEqual([]); expect(runs).toEqual([]);
    },
  );

  it('refuses expired, residual, unterminated or still-shared contained custody', async () => {
    const calls: Call[] = []; const runs: unknown[] = []; const f = recovery(calls, runs, true);
    f.receipt.observedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/fresh exact custody receipt/);
    f.receipt.observedAt = new Date().toISOString(); f.receipt.residualResourceIds = ['vol-0bad'];
    await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/zero residue/);
    f.receipt.residualResourceIds = []; (f.receipt as unknown as { terminated: boolean }).terminated = false;
    await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/terminated canary/);
    (f.receipt as unknown as { terminated: boolean }).terminated = true; f.launch.LaunchPermissions.push({ UserId: SHARE_ACCOUNT });
    await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/empty launch permissions/);
    expect(runs).toEqual([]); expect(calls.every(x => x.name.startsWith('Describe'))).toBe(true);
  });

  it('binds contained root snapshot and its permanent marker to the receipt', async () => {
    const f = recovery([], [], true);
    f.receipt.snapshotId = 'snap-0bad';
    await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/root does not match/);
    f.receipt.snapshotId = 'snap-0abc';
    f.snapshot.Tags.find(x => x.Key === AWS_AMI_CONTAINED_CANARY_TAG)!.Value = 'i-0bad';
    await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/snapshot.*containment marker/);
  });

  it('reuses only the exact private encrypted candidate with read-only metadata calls and no upload', async () => {
    const calls: Call[] = []; const runs: unknown[] = [];
    const f = recovery(calls, runs);
    await expect(f.adapter.buildCandidate(f.input)).resolves.toEqual({ imageId: 'ami-0abc' });
    expect(runs).toEqual([]);
    expect(calls.map(x => x.name)).toEqual([
      'DescribeImagesCommand', 'DescribeImageAttributeCommand', 'DescribeSnapshotsCommand', 'DescribeSnapshotAttributeCommand',
    ]);
    expect(calls[0].input).toEqual({ ImageIds: ['ami-0abc'], Owners: ['111111111111'] });
  });

  it.each(['ImageId', 'OwnerId', 'Name', 'Description', 'State', 'Architecture'])(
    'rejects a mismatched AMI %s without any mutation or upload', async (field) => {
      const calls: Call[] = []; const runs: unknown[] = []; const f = recovery(calls, runs);
      (f.image as Record<string, unknown>)[field] = 'different';
      await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/does not match the exact publisher/);
      expect(runs).toEqual([]);
      expect(calls.every(x => x.name.startsWith('Describe'))).toBe(true);
    },
  );

  it.each(['papercusp:build-manifest', 'papercusp:release-sha256', 'papercusp:image-version', 'papercusp:guest-tool:amazon-ssm-agent'])(
    'rejects a mismatched AMI tag %s', async (key) => {
      const runs: unknown[] = []; const f = recovery([], runs);
      f.image.Tags.find(x => x.Key === key)!.Value = 'different';
      await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/missing exact tag/);
      expect(runs).toEqual([]);
    },
  );

  it.each(['SnapshotId', 'OwnerId', 'State', 'Encrypted', 'KmsKeyId', 'VolumeSize'])(
    'rejects a mismatched snapshot %s', async (field) => {
      const calls: Call[] = []; const runs: unknown[] = []; const f = recovery(calls, runs);
      (f.snapshot as Record<string, unknown>)[field] = field === 'Encrypted' ? false : 'different';
      await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/snapshot does not match/);
      expect(runs).toEqual([]);
      expect(calls.every(x => x.name.startsWith('Describe'))).toBe(true);
    },
  );

  it('rejects extra disks and a substituted snapshot provenance tag', async () => {
    const missingRoot = recovery([], []);
    missingRoot.image.RootDeviceName = '';
    await expect(missingRoot.adapter.buildCandidate(missingRoot.input)).rejects.toThrow(/exactly one encrypted root/);
    const extra = recovery([], []);
    extra.image.BlockDeviceMappings.push({ DeviceName: '/dev/xvdb', Ebs: { SnapshotId: 'snap-0def', Encrypted: true } });
    await expect(extra.adapter.buildCandidate(extra.input)).rejects.toThrow(/exactly one encrypted root/);
    const tag = recovery([], []);
    tag.snapshot.Tags.find(x => x.Key === 'papercusp:release-sha256')!.Value = 'f'.repeat(64);
    await expect(tag.adapter.buildCandidate(tag.input)).rejects.toThrow(/snapshot is missing exact tag/);
  });

  it('rejects shared or unmeasured AMI and snapshot permissions', async () => {
    for (const target of ['launch', 'snapshot', 'missing-launch', 'missing-snapshot']) {
      const runs: unknown[] = []; const f = recovery([], runs);
      if (target === 'launch') f.launch.LaunchPermissions.push({ Group: 'all' });
      if (target === 'snapshot') f.permissions.CreateVolumePermissions.push({ UserId: SHARE_ACCOUNT });
      if (target === 'missing-launch') delete (f.launch as Record<string, unknown>).LaunchPermissions;
      if (target === 'missing-snapshot') delete (f.permissions as Record<string, unknown>).CreateVolumePermissions;
      await expect(f.adapter.buildCandidate(f.input)).rejects.toThrow(/must still be private/);
      expect(runs).toEqual([]);
    }
  });

  it('still verifies the disk bytes and requires a persisted publisher owner', async () => {
    const calls: Call[] = []; const f = recovery(calls, []);
    await expect(f.adapter.buildCandidate({ ...f.input, bootcArtifact: { ...f.input.bootcArtifact!, sha256: 'f'.repeat(64) } }))
      .rejects.toThrow(/disk digest/);
    expect(calls).toEqual([]);
    const unbound = new SdkAwsAmiReleaseAdapter({ ...f.deps, publisherAccountId: undefined }, {
      resumeCandidateImageId: 'ami-0abc', guestToolVersions: { 'amazon-ssm-agent': '3.3.1', 'openssh-server': '9.6' },
    });
    await expect(unbound.buildCandidate(f.input)).rejects.toThrow(/persisted publisher account/);
    expect(calls).toEqual([]);
  });
});

describe('SdkAwsAmiReleaseAdapter.buildCandidate', () => {
  it('refuses a Packer-kind build before any upload or AWS call', async () => {
    const calls: Call[] = [];
    const runs: unknown[] = [];
    await expect(
      adapterWith(calls, runs).buildCandidate(buildInput({ builderKind: 'packer', bootcArtifact: undefined })),
    ).rejects.toThrow(/bootc bake/);
    expect(calls).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('refuses a disk whose digest differs from the bake manifest before uploading it', async () => {
    const calls: Call[] = [];
    const runs: unknown[] = [];
    const input = buildInput();
    await expect(
      adapterWith(calls, runs).buildCandidate({ ...input, bootcArtifact: { ...input.bootcArtifact!, sha256: 'f'.repeat(64) } }),
    ).rejects.toThrow(/digest does not match/);
    expect(runs).toEqual([]);
  });

  it('uploads, registers, re-encrypts with the source key, and removes the unencrypted staging image', async () => {
    const calls: Call[] = [];
    const runs: unknown[] = [];
    const adapter = adapterWith(calls, runs, {
      RegisterImageCommand: () => ({ ImageId: 'ami-0aaa' }),
      DescribeImagesCommand: () => ({ Images: [{ State: 'available' }] }),
      CopyImageCommand: () => ({ ImageId: 'ami-0bbb' }),
      DeregisterImageCommand: () => ({}),
      DeleteSnapshotCommand: () => ({}),
    });
    await expect(adapter.buildCandidate(buildInput())).resolves.toEqual({ imageId: 'ami-0bbb' });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ command: 'coldsnap' });
    // Each run tag is a `--tag Key=K,Value=V` pair; the disk is last.
    const uploadArgs = (runs[0] as { args: string[] }).args;
    // 16 workers, not coldsnap's 64: on an uplink-bound upload 64 put each block near the 12 s read timeout.
    expect(uploadArgs.slice(0, 4)).toEqual(['upload', '--wait', '--workers', '16']);
    // WI-10006518: an omitted all-zero block reads back as noise on the encrypted copy every release
    // ships (P-012 chain14: root XFS log rejected, emergency mode). Every block is uploaded.
    expect(uploadArgs).not.toContain('--omit-zero-blocks');
    expect(uploadArgs.at(-1)).toBe(diskPath);
    const tagArgs = uploadArgs.slice(4, -1);
    expect(tagArgs.filter((_, index) => index % 2 === 0).every((flag) => flag === '--tag')).toBe(true);
    expect(tagArgs).toEqual(expect.arrayContaining(['Key=papercusp:managed,Value=true']));
    expect((runs[0] as { env: Record<string, string> }).env).toMatchObject({ AWS_REGION: 'us-east-1' });
    const register = calls.find((call) => call.name === 'RegisterImageCommand')!;
    expect(register.input).toMatchObject({ BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-0abc123' } }], ImdsSupport: 'v2.0' });
    const copy = calls.find((call) => call.name === 'CopyImageCommand')!;
    expect(copy.input).toMatchObject({
      SourceImageId: 'ami-0aaa',
      Encrypted: true,
      KmsKeyId: KMS,
      Name: 'papercusp-workspace-host-2026.10.1',
      Description: awsAmiReleaseDescription('2026.10.1', SHA),
    });
    expect(calls.filter((call) => /Deregister|DeleteSnapshot/.test(call.name)).map((call) => call.input)).toEqual([
      { ImageId: 'ami-0aaa' },
      { SnapshotId: 'snap-0abc123' },
    ]);
  });

  describe('coldsnap upload failure (WI-10006192)', () => {
    const TRANSPORT = "[WARN ] block 24145: attempt 5/5 failed after 3.1s: Failed to put block 24145 for snapshot 'snap-0dead1': dispatch failure";
    const OK = { exitCode: 0, stdout: 'Uploaded snapshot snap-0abc123\n', stderr: '' };

    function sequencedAdapter(
      results: { exitCode: number; stdout: string; stderr: string }[],
      calls: Call[],
      runs: unknown[],
      deleteSnapshot: (input: Record<string, unknown>) => unknown = () => ({}),
    ) {
      return new SdkAwsAmiReleaseAdapter(
        {
          ec2: () =>
            fakeSender(
              {
                RegisterImageCommand: () => ({ ImageId: 'ami-0aaa' }),
                DescribeImagesCommand: () => ({ Images: [{ State: 'available' }] }),
                CopyImageCommand: () => ({ ImageId: 'ami-0bbb' }),
                DeregisterImageCommand: () => ({}),
                DeleteSnapshotCommand: deleteSnapshot,
              },
              calls,
            ),
          ssm: () => fakeSender({}, calls),
          kms: () => fakeSender({}, calls),
          childCredentials: async () => ({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' }),
          commands: { run: async (command) => (runs.push(command), results.shift() ?? OK) },
          sleep: async () => {},
        },
        { guestToolVersions: { 'amazon-ssm-agent': '3.3.1', 'openssh-server': '9.6' } },
      );
    }
    const deletedSnapshots = (calls: Call[]) => calls.filter((call) => call.name === 'DeleteSnapshotCommand').map((call) => call.input.SnapshotId);

    it('deletes the partial snapshot of a transport failure, then retries the upload once', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      const adapter = sequencedAdapter([{ exitCode: 1, stdout: '', stderr: TRANSPORT }], calls, runs);
      await expect(adapter.buildCandidate(buildInput())).resolves.toEqual({ imageId: 'ami-0bbb' });
      expect(runs).toHaveLength(2);
      // The partial goes first; the staging snapshot of the successful retry is removed after the copy.
      expect(deletedSnapshots(calls)).toEqual(['snap-0dead1', 'snap-0abc123']);
    });

    it('gives up after the second transport failure and deletes both partial snapshots', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      const second = { exitCode: 1, stdout: '', stderr: TRANSPORT.replaceAll('snap-0dead1', 'snap-0dead2') };
      const adapter = sequencedAdapter([{ exitCode: 1, stdout: '', stderr: TRANSPORT }, second], calls, runs);
      await expect(adapter.buildCandidate(buildInput())).rejects.toThrow(/coldsnap upload \(attempt 2\/2\) exited 1 .*dispatch failure/);
      expect(runs).toHaveLength(2);
      expect(deletedSnapshots(calls)).toEqual(['snap-0dead1', 'snap-0dead2']);
      expect(calls.some((call) => call.name === 'RegisterImageCommand')).toBe(false);
    });

    it('retains the first failed attempt as well as the final failure, with separate references', async () => {
      const first = { exitCode: 1, stdout: 'first upload started', stderr: `${TRANSPORT}\n${'x'.repeat(AWS_AMI_COMMAND_ERROR_DETAIL_CHARS)}` };
      const second = { exitCode: 1, stdout: 'second upload started', stderr: TRANSPORT.replaceAll('snap-0dead1', 'snap-0dead2') };
      const adapter = sequencedAdapter([first, second], [], []);
      const error = await adapter.buildCandidate(buildInput()).catch((failure: Error) => failure);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      const priorPath = message.match(/\[prior attempt output: ([^\]]+)\]/)?.[1];
      const finalPath = message.match(/\[full output: ([^\]]+)\]/)?.[1];
      expect(priorPath).toBeTruthy();
      expect(finalPath).toBeTruthy();
      try {
        expect(priorPath).not.toBe(finalPath);
        expect(await readFile(priorPath!, 'utf8')).toBe(`--- stdout ---\n${first.stdout}\n--- stderr ---\n${first.stderr}`);
        expect(await readFile(finalPath!, 'utf8')).toBe(`--- stdout ---\n${second.stdout}\n--- stderr ---\n${second.stderr}`);
        expect(message.indexOf('[prior attempt output:')).toBeLessThan(200);
      } finally {
        await Promise.all([priorPath, finalPath].filter(Boolean).map((path) => rm(path!, { force: true })));
      }
    });

    it('does not retry a non-transport failure, but still deletes its partial snapshot', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      const denied = { exitCode: 1, stdout: '', stderr: "Failed to start snapshot 'snap-0dead3': AccessDeniedException" };
      const adapter = sequencedAdapter([denied], calls, runs);
      await expect(adapter.buildCandidate(buildInput())).rejects.toThrow(/coldsnap upload \(attempt 1\/2\) exited 1 .*AccessDenied/);
      expect(runs).toHaveLength(1);
      expect(deletedSnapshots(calls)).toEqual(['snap-0dead3']);
    });

    it('stops coldsnap at the first block that has used its last retry, not at an intermediate retry', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      await sequencedAdapter([], calls, runs).buildCandidate(buildInput());
      const pattern = (runs[0] as { abortOnStderr?: RegExp }).abortOnStderr;
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern!.test(TRANSPORT)).toBe(true);
      // The chain14 try2 lines: 5/5 lost the upload; 2/5 was coldsnap recovering on its own.
      expect(pattern!.test("[WARN ] block 11633: attempt 5/5 failed after 12.0s: Failed to put block 11633 for snapshot 'snap-017b90e05278d7710': dispatch failure")).toBe(true);
      expect(pattern!.test("[WARN ] block 11776: attempt 2/5 failed after 12.0s: Failed to put block 11776 for snapshot 'snap-017b90e05278d7710': dispatch failure")).toBe(false);
    });

    it('names a partial snapshot that would not delete, and does not retry over it', async () => {
      const calls: Call[] = [];
      const runs: unknown[] = [];
      const adapter = sequencedAdapter([{ exitCode: 1, stdout: '', stderr: TRANSPORT }], calls, runs, () => {
        throw Object.assign(new Error('throttled'), { name: 'RequestLimitExceeded' });
      });
      await expect(adapter.buildCandidate(buildInput())).rejects.toThrow(/partial snapshot NOT deleted: snap-0dead1; cleanup errors: snap-0dead1: RequestLimitExceeded/);
      expect(runs).toHaveLength(1);
    });

    it('preserves both complete streams when the upload error exceeds the report excerpt', async () => {
      const stdout = 'upload-start diagnostic';
      const stderr = `original transport cause\n${'x'.repeat(AWS_AMI_COMMAND_ERROR_DETAIL_CHARS)}\nAccessDeniedException`;
      const adapter = sequencedAdapter([{ exitCode: 1, stdout, stderr }], [], []);
      const error = await adapter.buildCandidate(buildInput()).catch((failure: Error) => failure);
      expect(error).toBeInstanceOf(Error);
      const path = (error as Error).message.match(/\[full output: ([^\]]+)\]/)?.[1];
      expect(path).toBeTruthy();
      try {
        expect(await readFile(path!, 'utf8')).toBe(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
        expect((error as Error).message.indexOf('[full output:')).toBeLessThan(200);
      } finally {
        await rm(path!, { force: true });
      }
    });
  });

  it('refuses when a required guest tool version is not pinned', async () => {
    const adapter = new SdkAwsAmiReleaseAdapter(
      { ec2: () => fakeSender({}, []), ssm: () => fakeSender({}, []), kms: () => fakeSender({}, []), childCredentials: async () => ({}) },
      { guestToolVersions: { 'amazon-ssm-agent': '3.3.1' } },
    );
    await expect(adapter.buildCandidate(buildInput())).rejects.toThrow(/not pinned for: openssh-server/);
  });
});

describe('SdkAwsAmiReleaseAdapter.publishPermissions', () => {
  const publishInput = {
    region: 'us-east-1',
    imageId: 'ami-0abc123',
    kmsKeyArn: KMS,
    kmsGrantAccountIds: [SHARE_ACCOUNT],
    launchAccountIds: [SHARE_ACCOUNT],
    snapshotCreateVolumeAccountIds: [SHARE_ACCOUNT],
  };

  it('creates a deterministic least-privilege key grant before sharing the AMI and snapshots', async () => {
    const calls: Call[] = [];
    const adapter = adapterWith(calls, [], {
      ModifyImageAttributeCommand: () => ({}),
      DescribeImagesCommand: () => ({ Images: [{ BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-0abc123' } }] }] }),
      ModifySnapshotAttributeCommand: () => ({}),
    }, {
      ListGrantsCommand: () => ({ Grants: [], Truncated: false }),
      CreateGrantCommand: () => ({ GrantId: 'grant-123' }),
    });

    await adapter.publishPermissions(publishInput);

    expect(calls.filter((call) => call.name === 'CreateGrantCommand').map((call) => call.input)).toEqual([{
      KeyId: KMS,
      GranteePrincipal: 'arn:aws:iam::' + SHARE_ACCOUNT + ':root',
      Operations: SHARE_GRANT_OPERATIONS,
      Name: SHARE_GRANT_NAME,
    }]);
    expect(calls.map((call) => call.name)).toEqual([
      'ListGrantsCommand',
      'CreateGrantCommand',
      'ModifyImageAttributeCommand',
      'DescribeImagesCommand',
      'ModifySnapshotAttributeCommand',
    ]);
  });

  it('reuses an exact existing grant on retry and refuses a same-name grant with different rights', async () => {
    const exactGrant = {
      Name: SHARE_GRANT_NAME,
      GranteePrincipal: 'arn:aws:iam::' + SHARE_ACCOUNT + ':root',
      Operations: SHARE_GRANT_OPERATIONS,
    };
    const calls: Call[] = [];
    const existing = adapterWith(calls, [], {
      ModifyImageAttributeCommand: () => ({}),
      DescribeImagesCommand: () => ({ Images: [{ BlockDeviceMappings: [] }] }),
    }, {
      ListGrantsCommand: () => ({ Grants: [exactGrant], Truncated: false }),
    });
    await existing.publishPermissions(publishInput);
    expect(calls.some((call) => call.name === 'CreateGrantCommand')).toBe(false);

    const mismatchedCalls: Call[] = [];
    const mismatched = adapterWith(mismatchedCalls, [], {}, {
      ListGrantsCommand: () => ({ Grants: [{ ...exactGrant, Operations: ['Decrypt'] }], Truncated: false }),
    });
    await expect(mismatched.publishPermissions(publishInput)).rejects.toThrow(
      'does not match the required principal and operations',
    );
    expect(mismatchedCalls.some((call) => call.name === 'ModifyImageAttributeCommand')).toBe(false);
  });
});

describe('SdkAwsAmiReleaseAdapter.scanImage', () => {
  it('reserves the scanner download, three scans, bounded host work and teardown', async () => {
    const runs: unknown[] = [];
    const adapter = new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, []), ssm: () => fakeSender({}, []), kms: () => fakeSender({}, []),
      childCredentials: async () => ({}), commands: fakeCommands('{}', runs),
    });
    await adapter.scanImage({ region: 'us-east-1', imageId: 'ami-0abc', buildManifestIdentity: `sha256:${SHA}`, releaseSha256: SHA });
    expect(runs[0]).toMatchObject({ timeoutMs: AWS_AMI_SCAN_RUNNER_TIMEOUT_MS });
    expect(AWS_AMI_SCAN_RUNNER_TIMEOUT_MS).toBeGreaterThan(60 * 60_000 + 3 * 45 * 60_000);
  });
  it('hands the scan child the same coldsnap the upload uses (WI-10005642)', async () => {
    const runs: unknown[] = [];
    const scanInput = { region: 'us-east-1', imageId: 'ami-0bbb', buildManifestIdentity: `sha256:${'c'.repeat(64)}`, releaseSha256: SHA };
    const pinned = new SdkAwsAmiReleaseAdapter(
      { ec2: () => fakeSender({}, []), ssm: () => fakeSender({}, []), kms: () => fakeSender({}, []), childCredentials: async () => ({}), commands: fakeCommands('{}', runs) },
      { coldsnapExecutable: '/home/u/.papercusp/tools/coldsnap/0.12.0/bin/coldsnap' },
    );
    await pinned.scanImage(scanInput as Parameters<SdkAwsAmiReleaseAdapter['scanImage']>[0]);
    expect(runs[0]).toMatchObject({
      command: 'papercusp-aws-ami-scan',
      env: { AWS_REGION: 'us-east-1', PAPERCUSP_AWS_AMI_SCAN_COLDSNAP: '/home/u/.papercusp/tools/coldsnap/0.12.0/bin/coldsnap' },
    });

    // Positive control: with no override the scan child still gets the adapter's default, not nothing.
    await adapterWith([], runs).scanImage(scanInput as Parameters<SdkAwsAmiReleaseAdapter['scanImage']>[0]).catch(() => undefined);
    expect((runs[1] as { env: Record<string, string> }).env.PAPERCUSP_AWS_AMI_SCAN_COLDSNAP).toBe('coldsnap');
  });
});

describe('SdkAwsAmiReleaseAdapter.launchCleanAccountCanary failure output', () => {
  it('keeps the trailing bootstrap diagnostics of a long canary error payload (P-012 chain5)', async () => {
    // The canary serializes { error, details } with bootstrapDiagnostics LAST; the old 2,000-char
    // tail dropped the journal that explained why the service would not start.
    const journal = 'journal: Error: EACCES: permission denied, open /var/lib/papercusp/state.db';
    const payload = JSON.stringify({
      tool: 'papercusp-aws-ami-clean-account-canary',
      error: 'SSM bootstrap ended Failed',
      details: { stdoutTail: 'x'.repeat(2_000), runId: 'r1', bootstrapDiagnostics: `${'status-line\n'.repeat(400)}${journal}` },
    });
    expect(payload.length).toBeGreaterThan(5_000);
    const adapter = new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, []),
      ssm: () => fakeSender({}, []),
      kms: () => fakeSender({}, []),
      childCredentials: async () => ({}),
      commands: { run: async () => ({ exitCode: 1, stdout: '', stderr: payload }) },
    });
    const error = await adapter
      .launchCleanAccountCanary({ region: 'us-east-1' } as Parameters<SdkAwsAmiReleaseAdapter['launchCleanAccountCanary']>[0])
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('clean-account canary exited 1');
    expect((error as Error).message).toContain(journal);
    expect(AWS_AMI_COMMAND_ERROR_DETAIL_CHARS).toBeGreaterThanOrEqual(24_000);
  });

  it('budgets the child runner for every canary phase, fixture upload, and teardown', async () => {
    const runs: unknown[] = [];
    const adapter = new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, []),
      ssm: () => fakeSender({}, []),
      kms: () => fakeSender({}, []),
      childCredentials: async () => ({}),
      commands: {
        run: async (command) => {
          runs.push(command);
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      },
    });
    const bootstrapScript = 'x'.repeat(24_001);

    await adapter.launchCleanAccountCanary({
      region: 'us-east-1',
      fixture: { bootstrapScript },
    } as Parameters<SdkAwsAmiReleaseAdapter['launchCleanAccountCanary']>[0]);

    const expectedTimeoutMs =
      CANARY_BUDGETS.volumeAvailableMs +
      CANARY_BUDGETS.volumeAvailableMs +
      CANARY_BUDGETS.volumeAttachedMs +
      CANARY_BUDGETS.runningMs +
      CANARY_BUDGETS.ssmOnlineMs +
      CANARY_BUDGETS.bootstrapMs +
      CANARY_BUDGETS.bootstrapPushMs +
      CANARY_BUDGETS.terminateMs +
      CANARY_BUDGETS.volumeDetachMs +
      CANARY_BUDGETS.volumeDeleteMs +
      3 * CANARY_BUDGETS.shortCommandMs +
      4 * CANARY_BUDGETS.ssmDeliveryMs +
      12 * 3 * CANARY_BUDGETS.pollMs +
      5 * 60_000;
    expect(runs[0]).toMatchObject({
      command: 'papercusp-aws-ami-clean-account-canary',
      timeoutMs: expectedTimeoutMs,
    });
    expect(expectedTimeoutMs).toBeGreaterThan(45 * 60_000);
  });
});

describe('SdkAwsAmiReleaseAdapter.inspectImage', () => {
  it('reads launch permissions, snapshot encryption/sharing and guest tools from the image itself', async () => {
    const calls: Call[] = [];
    const adapter = adapterWith(calls, [], {
      DescribeImagesCommand: () => ({
        Images: [
          {
            OwnerId: '111111111111',
            State: 'available',
            Architecture: 'x86_64',
            Tags: [{ Key: 'papercusp:guest-tool:amazon-ssm-agent', Value: '3.3.1' }, { Key: 'papercusp:managed', Value: 'true' }],
            BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-0abc' } }],
          },
        ],
      }),
      DescribeImageAttributeCommand: () => ({ LaunchPermissions: [{ UserId: '333333333333' }, { UserId: '222222222222' }] }),
      DescribeSnapshotsCommand: () => ({ Snapshots: [{ Encrypted: true, KmsKeyId: KMS }] }),
      DescribeSnapshotAttributeCommand: () => ({ CreateVolumePermissions: [{ UserId: '222222222222' }] }),
    }, {
      ListGrantsCommand: () => ({
        Grants: [{
          Name: SHARE_GRANT_NAME,
          GranteePrincipal: 'arn:aws:iam::' + SHARE_ACCOUNT + ':root',
          Operations: SHARE_GRANT_OPERATIONS,
        }],
        Truncated: false,
      }),
    });
    await expect(adapter.inspectImage('us-east-1', 'ami-0bbb', KMS)).resolves.toMatchObject({
      ownerAccountId: '111111111111',
      state: 'available',
      guestTools: [{ name: 'amazon-ssm-agent', version: '3.3.1' }],
      launchAccountIds: ['222222222222', '333333333333'],
      kmsGrantAccountIds: [SHARE_ACCOUNT],
      snapshots: [{ snapshotId: 'snap-0abc', encrypted: true, kmsKeyArn: KMS, createVolumeAccountIds: ['222222222222'] }],
    });
  });
});

describe('SdkAwsAmiReleaseAdapter.publishVersionManifest', () => {
  const manifestFor = (publishedAt: string) =>
    buildAwsAmiVersionManifest({
      releaseVersion: '2026.10.1',
      releaseSha256: SHA,
      buildManifestIdentity: `sha256:${'c'.repeat(64)}`,
      architecture: 'x86_64',
      sourceRegion: 'us-east-1',
      publishedAt,
      requiredGuestTools: TOOLS,
      regions: [{ region: 'us-east-1', imageId: 'ami-0bbb', snapshotIds: ['snap-0abc'], kmsKeyArn: KMS, launchAccountIds: ['222222222222'] }],
      rollbackPins: [],
      cleanAccountProof: {} as never,
    });

  function adapterStoring(stored: string) {
    return new SdkAwsAmiReleaseAdapter({
      ec2: () => fakeSender({}, []),
      ssm: () =>
        fakeSender(
          {
            PutParameterCommand: () => {
              throw Object.assign(new Error('exists'), { name: 'ParameterAlreadyExists' });
            },
            GetParameterCommand: () => ({ Parameter: { Value: stored } }),
          },
          [],
        ),
      kms: () => fakeSender({}, []),
      childCredentials: async () => ({}),
    });
  }

  it('returns a receipt whose identity is re-derived from the STORED manifest', async () => {
    const manifest = manifestFor('2026-10-01T00:00:00.000Z');
    await expect(adapterStoring(canonicalize(manifest)).publishVersionManifest(manifest)).resolves.toEqual({
      uri: 'ssm://us-east-1/papercusp/workspace-host/ami/manifests/2026.10.1',
      manifestIdentity: manifest.manifestIdentity,
    });
  });

  it('refuses when a different manifest already holds the release version', async () => {
    const manifest = manifestFor('2026-10-01T00:00:00.000Z');
    const other = manifestFor('2026-10-02T00:00:00.000Z');
    await expect(adapterStoring(canonicalize(other)).publishVersionManifest(manifest)).rejects.toThrow(/does not match this release/);
  });
});

describe('connection binding', () => {
  const connection = {
    target: 'aws',
    scope: { kind: 'account', id: '111111111111' },
    provider: { region: 'us-east-1' },
  } as unknown as WorkspaceHostProviderConnection;

  it('passes a renewable shared profile to the real child boundary, removing ambient static credentials', async () => {
    const profileConnection = {
      ...connection,
      provider: { region: 'us-east-1', credentialSource: { environment: 'local', method: 'shared-profile', profile: 'publisher-profile' } },
    } as unknown as WorkspaceHostProviderConnection;
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
      vi.stubEnv(key, 'unrelated-ambient-credential');
    }
    const runs: unknown[] = [];
    const realRunner = new NodeGcpImageFamilyCommandRunner();
    const adapter = composeAwsAmiReleaseAdapter(profileConnection, {
      guestToolVersions: { 'amazon-ssm-agent': '3.3.1', 'openssh-server': '9.6' },
    }, {
      ec2: () => fakeSender({
        RegisterImageCommand: () => ({ ImageId: 'ami-0aaa' }),
        DescribeImagesCommand: () => ({ Images: [{ State: 'available' }] }),
        CopyImageCommand: () => ({ ImageId: 'ami-0bbb' }),
        DeregisterImageCommand: () => ({}),
        DeleteSnapshotCommand: () => ({}),
      }, []),
      commands: { run: async (command) => {
        if (typeof command === 'string') throw new Error('expected a structured publisher command');
        runs.push(command);
        const child = await realRunner.run({
          command: process.execPath,
          args: ['-e', 'console.log(JSON.stringify({profile:process.env.AWS_PROFILE,staticKeys:Object.keys(process.env).filter(k=>["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_SECURITY_TOKEN","ACCESS_KEY_ID","SECRET_ACCESS_KEY"].includes(k))}))'],
          env: command.env,
        });
        expect(child.exitCode).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({ profile: 'publisher-profile', staticKeys: [] });
        return { exitCode: 0, stdout: 'Uploaded snapshot snap-0abc123', stderr: '' };
      } },
      sleep: async () => {},
    });
    try {
      await expect(adapter.buildCandidate(buildInput())).resolves.toEqual({ imageId: 'ami-0bbb' });
      expect(runs).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a release whose publisher account is not the connection account', async () => {
    await expect(
      executeConfiguredAwsAmiRelease({ publisherAccountId: '222222222222' } as AwsAmiReleaseRequest, connection),
    ).rejects.toThrow(/not the connection's account/);
  });

  it('refuses an operator guest-tool override that contradicts the request SBOM versions (WI-10006386)', async () => {
    await expect(
      executeConfiguredAwsAmiRelease(
        { publisherAccountId: '111111111111', guestToolVersions: { curl: '8.12.1-6.el10' } } as unknown as AwsAmiReleaseRequest,
        connection,
        { guestToolVersions: { curl: '8.0-1' } },
      ),
    ).rejects.toThrow(/disagrees with the bake SBOM: curl \(override 8\.0-1; SBOM 8\.12\.1-6\.el10\)/);
  });

  it('credential probe fails when the credential resolves to a different account', async () => {
    const sts = { send: async () => ({ Account: '999999999999', Arn: 'arn:aws:sts::999999999999:assumed-role/x/y' }) };
    await expect(probeAwsAmiCredential(connection, { sts })).resolves.toMatchObject({
      ok: false,
      resolvedAccountId: '999999999999',
      error: expect.stringMatching(/not '111111111111'/),
    });
    const ok = { send: async () => ({ Account: '111111111111' }) };
    await expect(probeAwsAmiCredential(connection, { sts: ok })).resolves.toMatchObject({ ok: true });
  });
});
