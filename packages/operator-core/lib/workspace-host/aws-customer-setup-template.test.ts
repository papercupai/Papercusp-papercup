import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS, AWS_WORKSPACE_HOST_PERMISSION_ACTIONS } from './aws-connection';
import {
  AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID,
  AWS_CUSTOMER_SETUP_CONNECTION_FIELDS,
  awsCustomerSetupTemplate,
  awsWorkspaceHostLeastPrivilegePolicy,
} from './aws-customer-setup-template';
import { cloudFormationDanglingReferences } from './cloudformation-references';
import { awsSpotServiceLinkedRoleStatement, hostedAwsHostStackFragment } from './hosted-aws-host-stack';

const ACCOUNT = '123456789012';
const REGION = 'eu-west-2';

type Doc = {
  Rules: Record<string, { Assertions: Array<{ Assert: unknown }> }>;
  Parameters?: unknown;
  Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  Outputs: Record<string, { Value: unknown }>;
};

function doc(principalArn?: string): Doc {
  return awsCustomerSetupTemplate({ accountId: ACCOUNT, region: REGION, principalArn }).document as unknown as Doc;
}

function operatorRole(document: Doc) {
  return document.Resources[AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID].Properties as {
    RoleName: string;
    AssumeRolePolicyDocument: { Statement: Array<{ Principal: { AWS: string }; Action: string; Condition?: unknown }> };
    Policies: Array<{ PolicyDocument: { Statement: Array<{ Effect: string; Action: string[]; Resource: string }> } }>;
  };
}

/** Every logical id a CloudFormation intrinsic in `value` references. */
function referencedLogicalIds(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((entry) => referencedLogicalIds(entry, into));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'Ref' && typeof entry === 'string' && !entry.startsWith('AWS::')) into.add(entry);
      else if (key === 'Fn::GetAtt' && Array.isArray(entry)) into.add(String(entry[0]));
      else referencedLogicalIds(entry, into);
    }
  }
  return into;
}

describe('awsCustomerSetupTemplate — the customer-run (desktop) AWS setup template (P-013 / D-011)', () => {
  it('grants the operator role exactly AWS_WORKSPACE_HOST_PERMISSION_ACTIONS and nothing broader', () => {
    const role = operatorRole(doc());
    expect(role.Policies).toHaveLength(1);
    const statements = role.Policies[0].PolicyDocument.Statement;
    expect(statements).toHaveLength(3);
    expect(statements[0].Effect).toBe('Allow');
    expect([...statements[0].Action].sort()).toEqual([...AWS_WORKSPACE_HOST_PERMISSION_ACTIONS].sort());
    expect(statements[0].Action.some((action) => action.includes('*'))).toBe(false);
    // The only other grant: creating EC2's Spot service-linked role, which a spot host's first
    // launch needs (WI-10005389). One role, one service, never a wildcard action.
    expect(statements[1]).toEqual(awsSpotServiceLinkedRoleStatement('*'));
    expect(statements[1]).toMatchObject({
      Action: 'iam:CreateServiceLinkedRole',
      Resource: 'arn:aws:iam::*:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot',
      Condition: { StringEquals: { 'iam:AWSServiceName': 'spot.amazonaws.com' } },
    });
    // WI-10006815: EBS decrypts the Papercusp AMI's snapshot with the launching role's permission.
    // Without this every launch from an encrypted AMI died Client.InvalidKMSKey.InvalidState. Only
    // the two actions it needs, and only through EC2: never a direct Decrypt.
    expect(statements[2]).toEqual({
      Sid: 'PapercuspImageKeyUse',
      Effect: 'Allow',
      Action: [...AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS],
      Resource: '*',
      Condition: { StringLike: { 'kms:ViaService': 'ec2.*.amazonaws.com' } },
    });
    expect(AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS).toEqual(['kms:Decrypt', 'kms:ReEncryptFrom']);
    for (const action of AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS) {
      expect(statements[0].Action, `${action} must never be granted unconditionally`).not.toContain(action);
    }
    expect(awsWorkspaceHostLeastPrivilegePolicy()).toEqual(role.Policies[0].PolicyDocument);
  });

  it('trusts only a principal inside the customer account, defaulting to the account root', () => {
    expect(operatorRole(doc()).AssumeRolePolicyDocument.Statement).toEqual([
      { Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: 'sts:AssumeRole' },
    ]);
    const named = `arn:aws:iam::${ACCOUNT}:role/platform-admins`;
    expect(operatorRole(doc(named)).AssumeRolePolicyDocument.Statement[0].Principal.AWS).toBe(named);
    expect(operatorRole(doc()).RoleName).toBe(`PapercuspWorkspaceHostOperator-${ACCOUNT}`);
    // No ExternalId on this path: Papercusp is never the trusted principal here.
    expect(doc().Parameters).toBeUndefined();
    expect(JSON.stringify(doc())).not.toMatch(/ExternalId/);
  });

  it('refuses a principal from another account and malformed inputs', () => {
    expect(() => awsCustomerSetupTemplate({ accountId: ACCOUNT, region: REGION, principalArn: 'arn:aws:iam::999999999999:root' }))
      .toThrow(/belong to accountId/);
    expect(() => awsCustomerSetupTemplate({ accountId: ACCOUNT, region: REGION, principalArn: 'arn:aws:s3:::bucket' }))
      .toThrow(/principalArn/);
    expect(() => awsCustomerSetupTemplate({ accountId: '12345', region: REGION })).toThrow(/accountId/);
    for (const region of ['us-gov-west-1', 'cn-north-1', 'nowhere', '']) {
      expect(() => awsCustomerSetupTemplate({ accountId: ACCOUNT, region })).toThrow(/region/);
    }
  });

  it('pins the stack to the requested region and builds the same host resources as the hosted stack', () => {
    const document = doc();
    expect(JSON.stringify(document.Rules)).toContain(REGION);
    const fragment = hostedAwsHostStackFragment(ACCOUNT, REGION, AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID);
    for (const logicalId of Object.keys(fragment.Resources)) {
      expect(document.Resources[logicalId]).toEqual((fragment.Resources as Record<string, unknown>)[logicalId]);
    }
  });

  it('every reference anywhere in the template resolves, and every connection field has an Output', () => {
    const document = doc();
    // The WHOLE document, not just Outputs: WI-10005783 was a KMS key policy inside Resources
    // pointing at the hosted stack's role id, which CloudFormation refused at create-stack.
    expect(cloudFormationDanglingReferences(document as unknown as Record<string, unknown>)).toEqual([]);
    for (const logicalId of referencedLogicalIds(document.Outputs)) {
      expect(document.Resources, `Output references ${logicalId}`).toHaveProperty(logicalId);
    }
    // The disk key is usable by THIS template's operator role.
    const keyPolicy = JSON.stringify(document.Resources.HostKey!.Properties.KeyPolicy);
    expect(keyPolicy).toContain(JSON.stringify({ 'Fn::GetAtt': [AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID, 'Arn'] }));
    for (const outputKey of Object.keys(AWS_CUSTOMER_SETUP_CONNECTION_FIELDS)) {
      expect(document.Outputs, `missing Output ${outputKey}`).toHaveProperty(outputKey);
    }
  });

  it('maps Outputs onto fields the desktop connection route actually reads', () => {
    // Source-tree pin: the route keeps its accepted field list private, so read it from source.
    const source = readFileSync(
      new URL('../endpoint-route/routes/workspace-hosts/connection.ts', import.meta.url),
      'utf8',
    );
    const block = /const CONNECTION_FIELDS = \[([\s\S]*?)\] as const;/.exec(source)?.[1] ?? '';
    const accepted = new Set([...block.matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]));
    // Positive control: the parser found the list (a GCP field the template never maps to).
    expect(accepted.has('projectId')).toBe(true);
    for (const field of Object.values(AWS_CUSTOMER_SETUP_CONNECTION_FIELDS)) {
      const [head, nested] = field.split('.');
      expect(accepted.has(head), `connection route does not accept ${head}`).toBe(true);
      if (nested) expect(source).toContain(`optionalString(raw, '${nested}')`);
    }
  });
});
