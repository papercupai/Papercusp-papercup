import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import { describe, expect, it, vi } from 'vitest';
import type { AwsInstanceObservation } from './aws-provider';
import { AwsWorkspaceHostSdkError } from './aws-sdk-client';
import { pinWorkspaceHostSoakSubject } from './soak';
import { awsWorkspaceHostSoakReading, resolveAwsWorkspaceHostSoakSeams } from './soak-aws';
import { workspaceHostSpotReclaimed } from './standing-health';
import { WORKSPACE_HOST_SOAK_READ_ATTEMPTS, WORKSPACE_HOST_SOAK_READ_RETRY_MS } from './soak-ssh-probe';

const desired = {
  hostId: 'host-aws-soak',
  target: 'aws',
  scope: { kind: 'account', id: '413781344298' },
  region: 'us-east-2',
  zone: 'us-east-2a',
  size: 't3.large',
  image: { id: 'ami-0papercusphost0001' },
  data: { encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'cloud-resolver:v1' } },
} as WorkspaceHostDesiredSpec;

const controller = {
  sshUser: 'papercusp',
  // The controller keypair provision baked into authorized_keys; the transport refuses without it.
  identityFile: '/etc/papercusp/id_ed25519',
  knownHostsFile: '/tmp/papercusp-soak-known-hosts',
  remoteEntrypoint: '/usr/local/bin/papercusp-host-init',
  deliveryEntrypoint: '/usr/local/bin/papercusp-host-deliver',
  awsExecutable: 'aws',
};

const REGISTERED = 'i-0123456789abcdef0';

function observation(overrides: Partial<AwsInstanceObservation> = {}): AwsInstanceObservation {
  return {
    instanceId: REGISTERED,
    state: 'running',
    imageId: 'ami-0papercusphost0001',
    attachedVolumeIds: ['vol-0data'],
    observedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function sdkError(retryable: boolean): AwsWorkspaceHostSdkError {
  return new AwsWorkspaceHostSdkError({
    operation: 'DescribeInstances',
    message: retryable ? 'Rate exceeded' : 'not authorized to perform ec2:DescribeInstances',
    code: retryable ? 'RequestLimitExceeded' : 'UnauthorizedOperation',
    retryable,
    accessDenied: !retryable,
  });
}

async function seamsWith(
  describeInstance: (instanceId: string) => Promise<AwsInstanceObservation | undefined>,
  extra: { runner?: { run: ReturnType<typeof vi.fn> }; readInstanceId?: () => Promise<string | null> } = {},
) {
  // A fake clock the mocked sleep advances: the reach probe's retry budget is measured with
  // timing.now, so a frozen clock would retry an unreachable host forever.
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const seams = await resolveAwsWorkspaceHostSoakSeams({
    workspaceId: 'workspace-1',
    hostId: desired.hostId,
    readDesiredSpec: (async () => ({ desired, connectionId: 'connection-1' })) as never,
    readConnection: (async () => ({
      connection: { provider: { credentialSource: { method: 'shared-profile', profile: 'papercusp-byoc' } } },
    })) as never,
    readInstanceId: extra.readInstanceId ?? (async () => REGISTERED),
    controller,
    // describeInstance ONLY: a seam that tried to enroll host keys would need getConsoleOutput.
    awsClient: { describeInstance: vi.fn(describeInstance) },
    ...(extra.runner ? { runner: extra.runner as never } : {}),
    timing: { sleep, now: () => clock },
  });
  return { seams, sleep };
}

describe('AWS soak instance read (P-007)', () => {
  it('reads the registered instance and maps EC2 running onto the soak vocabulary the pin requires', async () => {
    const describeInstance = vi.fn(async () => observation());
    const { seams } = await seamsWith(describeInstance);

    const reading = await seams.readInstance();

    expect(describeInstance).toHaveBeenCalledWith(REGISTERED);
    expect(reading).toEqual({
      kind: 'observed',
      status: 'RUNNING',
      instanceId: REGISTERED,
      sourceImage: 'ami-0papercusphost0001',
    });
    expect(pinWorkspaceHostSoakSubject({ workspaceId: 'workspace-1', hostId: desired.hostId, soakId: 's1' }, reading))
      .toMatchObject({ instanceId: REGISTERED, image: 'ami-0papercusphost0001' });
  });

  it('reads a terminated or missing instance as ABSENT, and a stopped one as not RUNNING', () => {
    expect(awsWorkspaceHostSoakReading(observation({ state: 'terminated' }))).toEqual({ kind: 'absent' });
    expect(awsWorkspaceHostSoakReading(undefined)).toEqual({ kind: 'absent' });
    expect(awsWorkspaceHostSoakReading(observation({ state: 'stopped' }))).toMatchObject({ kind: 'observed', status: 'STOPPED' });
    expect(awsWorkspaceHostSoakReading(observation({ state: 'shutting-down' }))).toMatchObject({ status: 'SHUTTING_DOWN' });
  });

  it('marks a spot instance preemptible, and only a spot instance (WI-10005389)', () => {
    expect(awsWorkspaceHostSoakReading(observation({ spotInstanceRequestId: 'sir-1' }))).toMatchObject({
      preemptible: true,
    });
    expect(awsWorkspaceHostSoakReading(observation())).not.toHaveProperty('preemptible');
  });

  // The two halves of the reclaim test were each correct alone and never met: the AWS reading
  // upper-cases EC2's state, and the standing-health stopped set held the raw lower-case name, so
  // an interrupted AWS spot host was never flagged (WI-10005389). Compose them here.
  it('reads an interrupted spot instance as reclaimed through the standing-health verdict', () => {
    const interrupted = observation({ state: 'stopped', spotInstanceRequestId: 'sir-1' });
    expect(workspaceHostSpotReclaimed(awsWorkspaceHostSoakReading(interrupted))).toBe(true);
    expect(workspaceHostSpotReclaimed(awsWorkspaceHostSoakReading(observation({ state: 'stopped' })))).toBe(false);
    expect(
      workspaceHostSpotReclaimed(awsWorkspaceHostSoakReading(observation({ spotInstanceRequestId: 'sir-1' }))),
    ).toBe(false);
  });

  it('asks again after a throttled read, so one retryable AWS error does not cost a measured sample', async () => {
    const describeInstance = vi.fn().mockRejectedValueOnce(sdkError(true)).mockResolvedValueOnce(observation());
    const { seams, sleep } = await seamsWith(describeInstance);

    expect(await seams.readInstance()).toMatchObject({ kind: 'observed', status: 'RUNNING' });
    expect(describeInstance).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(WORKSPACE_HOST_SOAK_READ_RETRY_MS);
  });

  it('does not retry a non-retryable error and reports it as unreadable, never as absent', async () => {
    const describeInstance = vi.fn().mockRejectedValue(sdkError(false));
    const { seams, sleep } = await seamsWith(describeInstance);

    const reading = await seams.readInstance();

    expect(reading.kind).toBe('unreadable');
    expect(describeInstance).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the bounded attempts when AWS keeps throttling', async () => {
    const describeInstance = vi.fn().mockRejectedValue(sdkError(true));
    const { seams } = await seamsWith(describeInstance);

    const reading = await seams.readInstance();

    expect(reading).toMatchObject({ kind: 'unreadable' });
    expect(describeInstance).toHaveBeenCalledTimes(WORKSPACE_HOST_SOAK_READ_ATTEMPTS);
  });
});

describe('AWS soak reach probe (P-007)', () => {
  it('probes over the aws-ssm-ssh transport bound to the PINNED instance and enrolls nothing', async () => {
    const run = vi.fn(async (_command: unknown) => ({ exitCode: 0, stdout: '', stderr: '' }));
    const { seams } = await seamsWith(async () => observation(), { runner: { run } });
    const subject = { workspaceId: 'workspace-1', hostId: desired.hostId, soakId: 's1', instanceId: REGISTERED, image: 'ami-0papercusphost0001' };

    const outcome = await seams.probeFor(subject).probeReach();

    expect(outcome, JSON.stringify(outcome)).toEqual({ kind: 'reached' });
    expect(run).toHaveBeenCalled();
    const invocation = JSON.stringify(run.mock.calls[0]?.[0]);
    expect(invocation).toContain(REGISTERED);
    expect(invocation).toContain('ssm');
    expect(invocation).toContain('papercusp-byoc');
    expect(invocation).not.toContain('gcloud');
  });

  it('classifies an unreachable host as a transport failure, not a missing conduit', async () => {
    const run = vi.fn(async () => ({ exitCode: 255, stdout: '', stderr: 'Connection closed by UNKNOWN port 65535' }));
    const { seams } = await seamsWith(async () => observation(), { runner: { run } });
    const subject = { workspaceId: 'workspace-1', hostId: desired.hostId, soakId: 's1', instanceId: REGISTERED, image: 'ami-0papercusphost0001' };

    const outcome = await seams.probeFor(subject).probeReach();

    expect(outcome.kind).toBe('transport-failure');
  });
});

describe('AWS soak seam refusals (P-007)', () => {
  it('refuses a host with no registered instance instead of guessing one', async () => {
    await expect(seamsWith(async () => observation(), { readInstanceId: async () => null })).rejects.toThrow(/host-aws-soak/);
  });

  it('refuses a non-AWS host', async () => {
    await expect(resolveAwsWorkspaceHostSoakSeams({
      workspaceId: 'workspace-1',
      hostId: desired.hostId,
      readDesiredSpec: (async () => ({ desired: { ...desired, target: 'gcp' }, connectionId: null })) as never,
      readInstanceId: async () => REGISTERED,
      awsClient: { describeInstance: vi.fn() },
    })).rejects.toThrow(/target 'gcp'/);
  });

  it('refuses when the host connection is missing and no client is injected', async () => {
    await expect(resolveAwsWorkspaceHostSoakSeams({
      workspaceId: 'workspace-1',
      hostId: desired.hostId,
      readDesiredSpec: (async () => ({ desired, connectionId: null })) as never,
      readInstanceId: async () => REGISTERED,
    })).rejects.toThrow('aws_workspace_host_connection_missing');
  });
});
