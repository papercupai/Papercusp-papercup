import { describe, expect, it } from 'vitest';
import { AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID, awsCustomerSetupTemplate } from './aws-customer-setup-template';
import { cloudFormationDanglingReferences, cloudFormationReferencedNames } from './cloudformation-references';
import { hostedAwsHostStackFragment } from './hosted-aws-host-stack';
import {
  buildHostedProviderDelegationOnboarding,
  type HostedProviderDelegationConfiguration,
} from './hosted-provider-delegation';

const ACCOUNT = '413781344298';
const REGION = 'us-east-1';

function hostedDocument(): Record<string, unknown> {
  const configuration: HostedProviderDelegationConfiguration = {
    provider: 'aws',
    accountId: ACCOUNT,
    region: REGION,
    source: {
      environment: 'hosted',
      method: 'customer-role',
      roleArn: `arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHost-${ACCOUNT}`,
      trustedPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp/orgs/pco-org-a',
      externalIdRef: 'resolver://aws-external-id/org-a',
    },
  };
  const { template } = buildHostedProviderDelegationOnboarding({
    organizationId: 'org-a',
    workspaceId: 'ws-1',
    connectionId: 'conn-1',
    label: 'AWS',
    credentialRef: 'delegation://ws-1/conn-1',
    configuration,
  });
  return template.document as Record<string, unknown>;
}

describe('cloudFormationDanglingReferences (WI-10005783)', () => {
  it('collects Ref, Fn::GetAtt (both forms) and Fn::Sub placeholders, skipping pseudo-parameters and escapes', () => {
    const names = cloudFormationReferencedNames({
      A: { Ref: 'Vpc' },
      B: { Ref: 'AWS::Region' },
      C: { 'Fn::GetAtt': ['Role', 'Arn'] },
      D: { 'Fn::GetAtt': 'Key.Arn' },
      E: { 'Fn::Sub': 'arn:${AWS::Partition}:x:${Bucket}/${Profile.Arn}/${!Literal}' },
      F: { 'Fn::Sub': ['${Local}-${Outer}', { Local: { Ref: 'Inner' } }] },
    });
    expect([...names].sort()).toEqual(['Bucket', 'Inner', 'Key', 'Outer', 'Profile', 'Role', 'Vpc']);
  });

  it('reports a reference to an undeclared resource and accepts declared resources and parameters', () => {
    const document = {
      Parameters: { Env: { Type: 'String' } },
      Resources: {
        Key: { Type: 'AWS::KMS::Key', Properties: { KeyPolicy: { Principal: { 'Fn::GetAtt': ['Missing', 'Arn'] } } } },
        Topic: { Type: 'AWS::SNS::Topic', Properties: { DisplayName: { Ref: 'Env' } } },
      },
      Outputs: { KeyArn: { Value: { 'Fn::GetAtt': ['Key', 'Arn'] } } },
    };
    expect(cloudFormationDanglingReferences(document)).toEqual(['Missing']);
  });

  it('reproduces the shipped defect: the host fragment keyed to a role the template does not declare dangles', () => {
    const fragment = hostedAwsHostStackFragment(ACCOUNT, REGION, 'RoleThisTemplateNeverDeclares');
    const document = { Resources: fragment.Resources, Outputs: fragment.Outputs, Rules: fragment.Rules };
    expect(cloudFormationDanglingReferences(document)).toEqual(['RoleThisTemplateNeverDeclares']);
  });

  it('the desktop customer setup template has no dangling reference', () => {
    const { document } = awsCustomerSetupTemplate({ accountId: ACCOUNT, region: REGION });
    expect(cloudFormationDanglingReferences(document)).toEqual([]);
    expect(cloudFormationReferencedNames(document).has(AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID)).toBe(true);
  });

  it('the hosted customer-role stack has no dangling reference', () => {
    expect(cloudFormationDanglingReferences(hostedDocument())).toEqual([]);
  });
});
