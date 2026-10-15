import { describe, expect, it } from 'vitest';
import {
  HOSTED_AWS_HOST_SUBNET_TAG_KEY,
  HOSTED_AWS_HOST_TAG_KEY,
  HOSTED_AWS_REGION,
  hostedAwsHostNames,
} from './hosted-aws-host-stack';
import {
  buildHostedProviderDelegationOnboarding,
  type HostedProviderDelegationConfiguration,
} from './hosted-provider-delegation';

const ACCOUNT = '413781344298';

function onboard(region: string | undefined) {
  const configuration: HostedProviderDelegationConfiguration = {
    provider: 'aws',
    accountId: ACCOUNT,
    ...(region === undefined ? {} : { region }),
    source: {
      environment: 'hosted',
      method: 'customer-role',
      roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost-${ACCOUNT}`,
      trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/pco-org-a',
      externalIdRef: 'resolver://aws-external-id/org-a',
    },
  };
  return buildHostedProviderDelegationOnboarding({
    organizationId: 'org-a',
    workspaceId: 'ws-1',
    connectionId: 'conn-1',
    label: 'AWS',
    credentialRef: 'delegation://ws-1/conn-1',
    configuration,
  });
}

type Resource = { Type: string; DependsOn?: string | string[]; Properties: Record<string, any> };

describe('hosted AWS customer-role stack (aws-byoc-gcp-parity D-009)', () => {
  it("builds the host's network, instance profile, key and launch template beside the delegated role", () => {
    const { template, record } = onboard('eu-west-1');
    const document = template.document as { Resources: Record<string, Resource>; Rules: any };
    const resources = document.Resources;
    expect(resources.WorkspaceHostRole!.Type).toBe('AWS::IAM::Role');
    expect(Object.values(resources).map((resource) => resource.Type)).toEqual(
      expect.arrayContaining([
        'AWS::EC2::VPC',
        'AWS::EC2::NatGateway',
        'AWS::EC2::SecurityGroup',
        'AWS::IAM::InstanceProfile',
        'AWS::KMS::Key',
        'AWS::KMS::Alias',
        'AWS::EC2::LaunchTemplate',
      ]),
    );
    // No inbound access at all: Session Manager reaches the host outbound (P-005).
    expect(resources.HostSecurityGroup!.Properties.SecurityGroupIngress).toBeUndefined();
    expect(resources.HostInstanceRole!.Properties.ManagedPolicyArns).toEqual([
      { 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore' },
    ]);
    // Discovery depends on these exact names and tags.
    const names = hostedAwsHostNames(ACCOUNT);
    expect(resources.HostInstanceProfile!.Properties.InstanceProfileName).toBe(names.instanceProfileName);
    expect(resources.HostLaunchTemplate!.Properties.LaunchTemplateName).toBe(names.launchTemplateName);
    expect(resources.HostPrivateSubnet!.Properties.Tags).toEqual([
      { Key: HOSTED_AWS_HOST_TAG_KEY, Value: ACCOUNT },
      { Key: HOSTED_AWS_HOST_SUBNET_TAG_KEY, Value: 'private' },
    ]);
    expect(resources.HostSecurityGroup!.Properties.Tags).toEqual([{ Key: HOSTED_AWS_HOST_TAG_KEY, Value: ACCOUNT }]);
    // The launch template is created last, so finding it means the NAT route exists.
    expect(resources.HostLaunchTemplate!.DependsOn).toEqual(expect.arrayContaining(['HostPrivateRoute']));
    expect(resources.HostLaunchTemplate!.Properties.LaunchTemplateData.MetadataOptions.HttpTokens).toBe('required');
    // The delegated role may use the disk key; grants only for AWS resources.
    const keyStatements = resources.HostKey!.Properties.KeyPolicy.Statement as Array<Record<string, any>>;
    expect(keyStatements.find((statement) => statement.Sid === 'WorkspaceHostDiskGrants')).toMatchObject({
      Principal: { AWS: { 'Fn::GetAtt': ['WorkspaceHostRole', 'Arn'] } },
      Condition: { Bool: { 'kms:GrantIsForAWSResource': true } },
    });
    expect(document.Rules.PapercuspRegion.Assertions[0].Assert).toEqual({
      'Fn::Equals': [{ Ref: 'AWS::Region' }, 'eu-west-1'],
    });
    expect(record.configuration).toMatchObject({ region: 'eu-west-1' });
  });

  it('defaults a customer role to us-east-1, binds the region into the digest, and refuses a region it cannot use', () => {
    expect(onboard(undefined).record.configuration).toMatchObject({ region: 'us-east-1' });
    expect(onboard('us-east-1').record.templateDigest).toBe(onboard(undefined).record.templateDigest);
    expect(onboard('eu-west-1').record.templateDigest).not.toBe(onboard('us-east-1').record.templateDigest);
    for (const region of ['us-gov-west-1', 'cn-north-1', 'EU-WEST-1', 'eu-west', '']) {
      expect(() => onboard(region)).toThrow(/region/);
    }
  });

  it('accepts every commercial region shape and nothing else', () => {
    for (const region of ['us-east-1', 'eu-central-2', 'ap-southeast-4', 'il-central-1', 'me-south-1', 'ca-west-1']) {
      expect(HOSTED_AWS_REGION.test(region)).toBe(true);
    }
    for (const region of ['us-gov-east-1', 'cn-northwest-1', 'us-east', 'useast1', 'us-east-1a']) {
      expect(HOSTED_AWS_REGION.test(region)).toBe(false);
    }
  });
});
