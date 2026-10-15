import { describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_AWS_IMAGE_OWNER,
  discoverHostedAwsHostInfrastructure,
  newestUbuntuImage,
  type HostedAwsHostClients,
} from './hosted-aws-host-discovery';
import { HostedAwsHostInfrastructurePendingError } from './hosted-aws-host-stack';
import {
  buildHostedProviderDelegationOnboarding,
  type HostedProviderDelegationConfiguration,
  type HostedProviderDelegationRecord,
} from './hosted-provider-delegation';

const ACCOUNT = '413781344298';

function record(
  region: string | undefined = 'eu-west-1',
  status: HostedProviderDelegationRecord['status'] = 'verified',
): HostedProviderDelegationRecord {
  const configuration: HostedProviderDelegationConfiguration = {
    provider: 'aws',
    accountId: ACCOUNT,
    ...(region ? { region } : {}),
    source: {
      environment: 'hosted',
      method: 'customer-role',
      roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost-${ACCOUNT}`,
      trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/pco-org-a',
      externalIdRef: 'resolver://aws-external-id/org-a',
    },
  };
  const built = buildHostedProviderDelegationOnboarding({
    organizationId: 'org-a',
    workspaceId: 'ws-1',
    connectionId: 'conn-1',
    label: 'AWS',
    credentialRef: 'delegation://ws-1/conn-1',
    configuration,
  }).record;
  return { ...built, status };
}

function named(name: string): Error {
  return Object.assign(new Error(name), { name });
}

/** A stack that finished: every lookup answers as AWS would. `override` swaps one command's answer. */
function clients(override: Partial<Record<string, () => unknown>> = {}) {
  const sent: Array<{ command: string; input: Record<string, unknown> }> = [];
  const answers: Record<string, () => unknown> = {
    DescribeSubnetsCommand: () => ({
      Subnets: [{ SubnetId: 'subnet-0private', VpcId: 'vpc-0aaa', AvailabilityZone: 'eu-west-1b' }],
    }),
    DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [{ GroupId: 'sg-0noinbound' }] }),
    DescribeLaunchTemplatesCommand: () => ({ LaunchTemplates: [{ LaunchTemplateId: 'lt-0abc' }] }),
    GetInstanceProfileCommand: () => ({
      InstanceProfile: { Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/PapercuspWorkspaceHostInstance-${ACCOUNT}` },
    }),
    DescribeKeyCommand: () => ({ KeyMetadata: { Arn: `arn:aws:kms:eu-west-1:${ACCOUNT}:key/1234`, KeyState: 'Enabled' } }),
    DescribeImagesCommand: () => ({
      Images: [
        { ImageId: 'ami-old', OwnerId: CANONICAL_AWS_IMAGE_OWNER, CreationDate: '2026-08-01T00:00:00.000Z', Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260801' },
        { ImageId: 'ami-new', OwnerId: CANONICAL_AWS_IMAGE_OWNER, CreationDate: '2026-09-18T00:00:00.000Z', Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260918' },
      ],
    }),
    ...override,
  };
  const sender = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ command: name, input: command.input });
      const answer = answers[name];
      if (!answer) throw new Error(`unexpected ${name}`);
      return answer();
    }),
  };
  const regions: string[] = [];
  const createClients = (region: string): HostedAwsHostClients => {
    regions.push(region);
    return { ec2: sender, iam: sender, kms: sender };
  };
  return { createClients, sent, regions };
}

describe('discoverHostedAwsHostInfrastructure (aws-byoc-gcp-parity D-009)', () => {
  it("reads the customer's stack back by tag and fixed name, in the delegation's region", async () => {
    const fake = clients();
    const infra = await discoverHostedAwsHostInfrastructure(record(), { createClients: fake.createClients });
    expect(infra).toEqual({
      region: 'eu-west-1',
      zone: 'eu-west-1b',
      vpcId: 'vpc-0aaa',
      subnetId: 'subnet-0private',
      securityGroupId: 'sg-0noinbound',
      instanceProfileArn: `arn:aws:iam::${ACCOUNT}:instance-profile/PapercuspWorkspaceHostInstance-${ACCOUNT}`,
      launchTemplateId: 'lt-0abc',
      kmsKeyArn: `arn:aws:kms:eu-west-1:${ACCOUNT}:key/1234`,
      image: { id: 'ami-new', version: 'ubuntu-noble-24.04-amd64-server-20260918' },
    });
    expect(fake.regions).toEqual(['eu-west-1']);
    const byCommand = Object.fromEntries(fake.sent.map((call) => [call.command, call.input]));
    expect(byCommand.DescribeSubnetsCommand).toEqual({
      Filters: [
        { Name: 'tag:papercusp:workspace-host', Values: [ACCOUNT] },
        { Name: 'tag:papercusp:workspace-host-subnet', Values: ['private'] },
        { Name: 'state', Values: ['available'] },
      ],
    });
    // The security group is looked up only inside the stack's own VPC.
    expect(byCommand.DescribeSecurityGroupsCommand).toEqual({
      Filters: [{ Name: 'tag:papercusp:workspace-host', Values: [ACCOUNT] }, { Name: 'vpc-id', Values: ['vpc-0aaa'] }],
    });
    expect(byCommand.DescribeLaunchTemplatesCommand).toEqual({ LaunchTemplateNames: [`papercusp-workspace-host-${ACCOUNT}`] });
    expect(byCommand.GetInstanceProfileCommand).toEqual({ InstanceProfileName: `PapercuspWorkspaceHostInstance-${ACCOUNT}` });
    expect(byCommand.DescribeKeyCommand).toEqual({ KeyId: 'alias/papercusp-workspace-host' });
    expect(byCommand.DescribeImagesCommand).toMatchObject({ Owners: [CANONICAL_AWS_IMAGE_OWNER] });
  });

  it('defaults to us-east-1 for a delegation recorded without a region', async () => {
    const fake = clients();
    const legacy = record();
    const { region: _region, ...configuration } = legacy.configuration as Extract<
      HostedProviderDelegationConfiguration,
      { provider: 'aws' }
    >;
    const infra = await discoverHostedAwsHostInfrastructure(
      { ...legacy, configuration },
      { createClients: fake.createClients },
    );
    expect(infra.region).toBe('us-east-1');
    expect(fake.regions).toEqual(['us-east-1']);
  });

  it.each([
    ['private-subnet', { DescribeSubnetsCommand: () => ({ Subnets: [] }) }],
    ['security-group', { DescribeSecurityGroupsCommand: () => ({ SecurityGroups: [] }) }],
    ['launch-template', { DescribeLaunchTemplatesCommand: () => { throw named('InvalidLaunchTemplateName.NotFoundException'); } }],
    ['instance-profile', { GetInstanceProfileCommand: () => { throw named('NoSuchEntity'); } }],
    ['kms-key', { DescribeKeyCommand: () => { throw named('NotFoundException'); } }],
  ])('reports the stack as still building when its %s is not there yet', async (missing, override) => {
    const fake = clients(override);
    const error = await discoverHostedAwsHostInfrastructure(record(), { createClients: fake.createClients }).catch((e) => e);
    expect(error).toBeInstanceOf(HostedAwsHostInfrastructurePendingError);
    expect(error.missing).toBe(missing);
  });

  it('refuses to guess between two stacks, and passes a real refusal through', async () => {
    const two = clients({
      DescribeSubnetsCommand: () => ({
        Subnets: [
          { SubnetId: 'subnet-a', VpcId: 'vpc-a', AvailabilityZone: 'eu-west-1a' },
          { SubnetId: 'subnet-b', VpcId: 'vpc-b', AvailabilityZone: 'eu-west-1a' },
        ],
      }),
    });
    await expect(discoverHostedAwsHostInfrastructure(record(), { createClients: two.createClients })).rejects.toThrow(
      'hosted_aws_host_infrastructure_ambiguous:private-subnet',
    );
    const denied = clients({ DescribeLaunchTemplatesCommand: () => { throw named('UnauthorizedOperation'); } });
    const error = await discoverHostedAwsHostInfrastructure(record(), { createClients: denied.createClients }).catch((e) => e);
    expect(error).not.toBeInstanceOf(HostedAwsHostInfrastructurePendingError);
    expect(error.name).toBe('UnauthorizedOperation');
  });

  it('refuses a disabled key and a delegation that is not verified', async () => {
    const disabled = clients({ DescribeKeyCommand: () => ({ KeyMetadata: { Arn: 'arn:aws:kms:x', KeyState: 'PendingDeletion' } }) });
    await expect(discoverHostedAwsHostInfrastructure(record(), { createClients: disabled.createClients })).rejects.toThrow(
      'hosted_aws_host_kms_key_not_enabled:PendingDeletion',
    );
    const fake = clients();
    await expect(
      discoverHostedAwsHostInfrastructure(record('eu-west-1', 'pending'), { createClients: fake.createClients }),
    ).rejects.toThrow('hosted_aws_host_discovery_requires_verified_delegation');
    expect(fake.sent).toEqual([]);
  });
});

describe('newestUbuntuImage', () => {
  it("takes the newest Canonical image and ignores anyone else's", () => {
    expect(
      newestUbuntuImage([
        { ImageId: 'ami-impostor', OwnerId: '111111111111', CreationDate: '2030-01-01T00:00:00Z', Name: 'ubuntu/images/x/ubuntu-noble-24.04-amd64-server-20300101' },
        { ImageId: 'ami-1', OwnerId: CANONICAL_AWS_IMAGE_OWNER, CreationDate: '2026-09-01T00:00:00Z', Name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260901' },
      ]),
    ).toEqual({ id: 'ami-1', version: 'ubuntu-noble-24.04-amd64-server-20260901' });
    expect(() => newestUbuntuImage([])).toThrow('hosted_aws_host_ubuntu_image_unavailable');
  });
});
