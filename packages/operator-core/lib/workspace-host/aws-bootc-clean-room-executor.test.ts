import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseWorkspaceHostBootstrapAttestation,
  type WorkspaceHostCleanRoomInstallFixture,
} from '@papercusp/deployment-driver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_DEADLINE_EPOCH_MS_ENV } from '../systemd-scope';

import type { AwsAmiCleanAccountLaunchProof } from './aws-ami-release';
import { SdkAwsAmiReleaseAdapter, type AwsAmiCommandRunner } from './aws-ami-production';
import {
  AWS_BOOTC_CLEAN_ROOM_RUN_TAG,
  AwsBootcCleanRoomExecutor,
  attestationStdout,
  type AwsBootcCleanRoomAdapter,
  type AwsBootcCleanRoomPlacement,
} from './aws-bootc-clean-room-executor';

const PUBLISHER = '413781344298';
const CLEAN = '497149484242';
const REGION = 'us-east-1';
const RELEASE_SHA = 'b'.repeat(64);
const MANIFEST = `sha256:${'c'.repeat(64)}`;
const AMI = 'ami-0123456789abcdef0';
const SNAP = 'snap-0abc123';

beforeEach(() => vi.stubEnv(TASK_DEADLINE_EPOCH_MS_ENV, undefined));
afterEach(() => vi.unstubAllEnvs());

const placement: AwsBootcCleanRoomPlacement = {
  publisherAccountId: PUBLISHER,
  region: REGION,
  cleanAccount: {
    accountId: CLEAN,
    subnetId: 'subnet-09ee34a782efad158',
    instanceProfileArn: `arn:aws:iam::${CLEAN}:instance-profile/papercusp-ami-canary-instance`,
  },
  bootcArtifact: { cloud: 'aws', type: 'ami', artifact: '/bake/disk.raw', sha256: 'd'.repeat(64), sizeBytes: 14 },
  architecture: 'x86_64',
  releaseSha256: RELEASE_SHA,
};

const fixture = {
  contractVersion: 1,
  fixtureId: 'bootc-aws-clean-room-1',
  image: { id: 'papercusp-workspace-host', version: '0.0.21-p318r63' },
  manifestIdentity: MANIFEST,
  bootstrapInput: { service: { name: 'papercusp-workspace' } },
  bootstrapScript: '#!/bin/bash\necho hi\n',
  bootstrapScriptSha256: 'e'.repeat(64),
} as unknown as WorkspaceHostCleanRoomInstallFixture;

const attestation = { status: 'healthy', hostModel: 'bootc-image', release: { source: 'oci' } } as unknown as AwsAmiCleanAccountLaunchProof['attestation'];

function proof(overrides: Partial<AwsAmiCleanAccountLaunchProof> = {}): AwsAmiCleanAccountLaunchProof {
  return {
    evidenceRef: 'aws-ami-canary:run-1',
    accountId: CLEAN,
    region: REGION,
    imageId: AMI,
    buildManifestIdentity: MANIFEST,
    releaseVersion: '0.0.21-p318r63',
    releaseSha256: RELEASE_SHA,
    ssmOnline: true,
    bootstrapAttestationHealthy: true,
    serviceHealthy: true,
    publicIpv4Assigned: false,
    terminated: true,
    dataVolumeId: 'vol-0123456789abcdef0',
    dataVolumeDeleted: true,
    residualResourceIds: [],
    observedAt: '2026-10-02T20:40:00Z',
    fixtureId: fixture.fixtureId,
    attestation,
    ...overrides,
  };
}

function fakeAdapter(options: {
  canary?: () => Promise<AwsAmiCleanAccountLaunchProof>;
  discard?: () => Promise<{ residualResourceIds: readonly string[] }>;
} = {}) {
  const calls: { op: string; input: unknown }[] = [];
  const adapter: AwsBootcCleanRoomAdapter = {
    stageCleanRoomImage: async (input) => (calls.push({ op: 'stage', input }), { imageId: AMI, snapshotId: SNAP }),
    launchCleanAccountCanary: async (input) => (calls.push({ op: 'canary', input }), (options.canary ?? (async () => proof()))()),
    discardCleanRoomImage: async (input) => (calls.push({ op: 'discard', input }), (options.discard ?? (async () => ({ residualResourceIds: [] })))()),
  };
  return { adapter, calls };
}

describe('AwsBootcCleanRoomExecutor', () => {
  it('stages the bake disk shared only with the clean account, boots it there, discards it, and returns the attestation marker', async () => {
    const { adapter, calls } = fakeAdapter();
    const result = await new AwsBootcCleanRoomExecutor(adapter, placement, () => 'run-0001-uuid').execute(fixture);

    expect(calls.map((call) => call.op)).toEqual(['stage', 'canary', 'discard']);
    expect(calls[0]!.input).toMatchObject({
      region: REGION,
      bootcArtifact: placement.bootcArtifact,
      shareWithAccountId: CLEAN,
      tags: { [AWS_BOOTC_CLEAN_ROOM_RUN_TAG]: 'run-0001-uuid', 'papercusp:release-stage': 'clean-room-transient' },
    });
    expect(calls[1]!.input).toMatchObject({
      accountId: CLEAN,
      region: REGION,
      imageId: AMI,
      releaseVersion: '0.0.21-p318r63',
      releaseSha256: RELEASE_SHA,
      buildManifestIdentity: MANIFEST,
      fixture,
    });
    expect(calls[2]!.input).toEqual({ region: REGION, imageId: AMI, snapshotId: SNAP });
    // The shared acceptance runner parses the marker exactly as it parses a GCP bootstrap's stdout.
    expect(parseWorkspaceHostBootstrapAttestation(result.stdout)).toEqual(attestation);
  });

  it('discards the staged image when the canary fails, and names the failure', async () => {
    const { adapter, calls } = fakeAdapter({ canary: async () => { throw new Error('bootstrap exited 1'); } });
    await expect(new AwsBootcCleanRoomExecutor(adapter, placement).execute(fixture)).rejects.toThrow(/bootstrap exited 1/);
    expect(calls.map((call) => call.op)).toEqual(['stage', 'canary', 'discard']);
  });

  it.each([
    ['a public IPv4 address', { publicIpv4Assigned: true }, /public IPv4/],
    ['a different image', { imageId: 'ami-0fffffffffffffff0' }, /not the staged image/],
    ['an instance left running', { terminated: false }, /not terminated/],
    ['the data volume was not deleted', { dataVolumeDeleted: false }, /data volume was not confirmed deleted/],
    ['canary residue', { residualResourceIds: ['i-0abc'] }, /canary residue: i-0abc/],
    ['a different clean account', { accountId: PUBLISHER }, /not the clean account/],
    ['a different fixture', { fixtureId: 'other' }, /executed fixture other/],
  ])('rejects a canary proof with %s, after discarding', async (_label, overrides, pattern) => {
    const { adapter, calls } = fakeAdapter({ canary: async () => proof(overrides as Partial<AwsAmiCleanAccountLaunchProof>) });
    await expect(new AwsBootcCleanRoomExecutor(adapter, placement).execute(fixture)).rejects.toThrow(pattern);
    expect(calls.at(-1)!.op).toBe('discard');
  });

  it('fails a passing run whose teardown left residue', async () => {
    const { adapter } = fakeAdapter({ discard: async () => ({ residualResourceIds: [SNAP] }) });
    await expect(new AwsBootcCleanRoomExecutor(adapter, placement).execute(fixture)).rejects.toThrow(/left residue: snap-0abc123/);
  });

  it('treats an unmeasured teardown as residue, never as clean', async () => {
    const { adapter } = fakeAdapter({ discard: async () => { throw new Error('throttled'); } });
    await expect(new AwsBootcCleanRoomExecutor(adapter, placement).execute(fixture)).rejects.toThrow(
      /left residue: ami-0123456789abcdef0, snap-0abc123 \(throttled\)/,
    );
  });

  it('refuses a clean account equal to the publisher before staging anything', () => {
    const { adapter, calls } = fakeAdapter();
    expect(
      () => new AwsBootcCleanRoomExecutor(adapter, { ...placement, cleanAccount: { ...placement.cleanAccount, accountId: PUBLISHER } }),
    ).toThrow(/must differ from the publisher/);
    expect(() => new AwsBootcCleanRoomExecutor(adapter, { ...placement, bootcArtifact: { ...placement.bootcArtifact, cloud: 'gcp' } as never })).toThrow(
      /AWS\/ami row/,
    );
    expect(calls).toEqual([]);
  });

  it('round-trips the attestation through the marker encoding', () => {
    expect(parseWorkspaceHostBootstrapAttestation(`noise\n${attestationStdout(attestation)}`)).toEqual(attestation);
  });
});

type Call = { name: string; input: Record<string, unknown> };

function notFound(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe('SdkAwsAmiReleaseAdapter clean-room staging', () => {
  let dir: string;
  let diskPath: string;
  let diskSha: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aws-bootc-clean-room-'));
    diskPath = join(dir, 'disk.raw');
    await writeFile(diskPath, 'bootc-ami-disk');
    diskSha = createHash('sha256').update('bootc-ami-disk').digest('hex');
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  function adapterWith(
    calls: Call[],
    state: { deregistered: boolean; snapshotDeleted: boolean; failShare?: boolean; snapshotSticky?: boolean },
  ) {
    const ec2 = {
      send: async (command: unknown) => {
        const { constructor, input } = command as { constructor: { name: string }; input: Record<string, unknown> };
        calls.push({ name: constructor.name, input });
        switch (constructor.name) {
          case 'RegisterImageCommand':
            return { ImageId: AMI };
          case 'DescribeImagesCommand':
            return state.deregistered
              ? { Images: [] }
              : { Images: [{ ImageId: AMI, State: 'available', BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { SnapshotId: SNAP } }] }] };
          case 'CreateTagsCommand':
            return {};
          case 'ModifyImageAttributeCommand':
            if (state.failShare) throw new Error('AccessDenied');
            return {};
          case 'ModifySnapshotAttributeCommand':
            return {};
          case 'DeregisterImageCommand':
            state.deregistered = true;
            return {};
          case 'DeleteSnapshotCommand':
            if (!state.snapshotSticky) state.snapshotDeleted = true;
            return {};
          case 'DescribeSnapshotsCommand':
            if (state.snapshotDeleted) throw notFound('InvalidSnapshot.NotFound');
            return { Snapshots: [{ SnapshotId: SNAP }] };
          default:
            throw new Error(`unexpected command ${constructor.name}`);
        }
      },
    };
    const commands: AwsAmiCommandRunner = { run: async () => ({ exitCode: 0, stdout: `Uploaded snapshot ${SNAP}\n`, stderr: '' }) };
    return new SdkAwsAmiReleaseAdapter(
      { ec2: () => ec2, ssm: () => ec2, kms: () => ec2, childCredentials: async () => ({}), commands, sleep: async () => {} },
      {},
    );
  }

  function stageInput() {
    return {
      region: REGION,
      bootcArtifact: { cloud: 'aws' as const, type: 'ami' as const, artifact: diskPath, sha256: diskSha, sizeBytes: 14 },
      imageName: 'papercusp-workspace-host-clean-room-0.0.21-run00001',
      description: 'clean room',
      architecture: 'x86_64',
      shareWithAccountId: CLEAN,
      tags: { [AWS_BOOTC_CLEAN_ROOM_RUN_TAG]: 'run-1' },
    };
  }

  it('registers an unencrypted transient AMI, tags its snapshot and shares both with only the clean account', async () => {
    const calls: Call[] = [];
    const state = { deregistered: false, snapshotDeleted: false };
    expect(await adapterWith(calls, state).stageCleanRoomImage(stageInput())).toEqual({ imageId: AMI, snapshotId: SNAP });
    const names = calls.map((call) => call.name);
    expect(names).not.toContain('CopyImageCommand');
    expect(calls.find((call) => call.name === 'CreateTagsCommand')!.input).toMatchObject({ Resources: [SNAP] });
    expect(calls.find((call) => call.name === 'ModifyImageAttributeCommand')!.input).toEqual({
      ImageId: AMI,
      LaunchPermission: { Add: [{ UserId: CLEAN }] },
    });
    expect(calls.find((call) => call.name === 'ModifySnapshotAttributeCommand')!.input).toMatchObject({ SnapshotId: SNAP, UserIds: [CLEAN] });
  });

  it('removes the image and snapshot when sharing fails', async () => {
    const calls: Call[] = [];
    const state = { deregistered: false, snapshotDeleted: false, failShare: true };
    await expect(adapterWith(calls, state).stageCleanRoomImage(stageInput())).rejects.toThrow(/AccessDenied/);
    expect(state).toMatchObject({ deregistered: true, snapshotDeleted: true });
  });

  it('discards and censuses both resources to zero, tolerating already-gone resources', async () => {
    const calls: Call[] = [];
    const state = { deregistered: false, snapshotDeleted: false };
    expect(await adapterWith(calls, state).discardCleanRoomImage({ region: REGION, imageId: AMI, snapshotId: SNAP })).toEqual({
      residualResourceIds: [],
    });
    expect(calls.map((call) => call.name)).toEqual([
      'DeregisterImageCommand',
      'DeleteSnapshotCommand',
      'DescribeImagesCommand',
      'DescribeSnapshotsCommand',
    ]);
  });

  it('reports a snapshot that survived deletion as residue', async () => {
    const calls: Call[] = [];
    // A delete that was accepted but did not take effect.
    const state = { deregistered: false, snapshotDeleted: false, snapshotSticky: true };
    expect(await adapterWith(calls, state).discardCleanRoomImage({ region: REGION, imageId: AMI, snapshotId: SNAP })).toEqual({
      residualResourceIds: [SNAP],
    });
  });
});
