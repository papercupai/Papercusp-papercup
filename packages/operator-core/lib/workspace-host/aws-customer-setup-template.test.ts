import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS, AWS_WORKSPACE_HOST_PERMISSION_ACTIONS } from './aws-connection';
import {
  AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID,
  AWS_CUSTOMER_SETUP_CONNECTION_FIELDS,
  awsCanaryDeadlineStackFragment,
  awsCustomerSetupTemplate,
  awsWorkspaceHostLeastPrivilegePolicy,
} from './aws-customer-setup-template';
import { cloudFormationDanglingReferences } from './cloudformation-references';
import { awsSpotServiceLinkedRoleStatement, hostedAwsHostStackFragment } from './hosted-aws-host-stack';

const ACCOUNT = '123456789012';
const REGION = 'eu-west-2';
const CANARY_NOW = Date.parse('2026-10-23T03:00:00.000Z');
const CANARY = { runId: 'p544-trial-20261023', workspaceId: 'hosted-fixture-p544-trial',
  organizationId: 'org-p544', hostId: 'host-p544', workloadDeadlineAt: '2026-10-23T03:30:00.000Z',
  teardownDeadlineAt: '2026-10-23T03:41:00.000Z' };

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

describe('finite AWS qualification foundation in the existing customer stack', () => {
  it('binds the genuine isolated runtime workspace into cleanup and launcher confinement', () => {
    const workspaceId = 'test-runtime-p544-private-20261023';
    const f = awsCanaryDeadlineStackFragment({ ...CANARY, workspaceId,
      accountId: ACCOUNT, region: REGION, principalArn: `arn:aws:iam::${ACCOUNT}:role/admin` }, CANARY_NOW);
    expect(f.plan.document.mainSteps[1]?.inputs.InputPayload.filters).toContainEqual({
      Name: 'tag:papercusp:workspace-id', Values: [workspaceId] });
    expect(f.plan.cleanupPolicy.Statement[1]?.Condition.StringEquals).toMatchObject({
      'ec2:ResourceTag/papercusp:workspace-id': workspaceId });
    expect(f.Resources.CanaryLauncherRole.Properties.Policies[0].PolicyDocument.Statement).toContainEqual({
      Effect: 'Deny', Action: 'ec2:CreateSnapshot', Resource: [`arn:aws:ec2:${REGION}::snapshot/*`],
      Condition: { StringNotEquals: { 'aws:RequestTag/papercusp:workspace-id': workspaceId } } });
  });

  it('adds dedicated roles and a versioned SSM document without changing the ordinary operator policy', () => {
    const ordinary = doc();
    const finite = awsCustomerSetupTemplate({ accountId: ACCOUNT, region: REGION, finiteCanary: CANARY }, CANARY_NOW).document as unknown as Doc;
    expect(operatorRole(finite)).toEqual(operatorRole(ordinary));
    expect(ordinary.Resources).not.toHaveProperty('CanaryLauncherRole');
    expect(finite.Resources.CanaryLauncherRole.Type).toBe('AWS::IAM::Role');
    expect(finite.Resources.CanaryDeadlineDocument.Properties).toMatchObject({
      DocumentType: 'Automation', UpdateMethod: 'NewVersion', Content: { schemaVersion: '0.3' } });
    expect(cloudFormationDanglingReferences(finite)).toEqual([]);
    expect(finite.Outputs.CanaryDocumentVersion.Value).toBe('1');
  });

  it('reuses host confinement and separately denies each wrong creation tag before the cutoff', () => {
    const f = awsCanaryDeadlineStackFragment({ ...CANARY, accountId: ACCOUNT, region: REGION,
      principalArn: `arn:aws:iam::${ACCOUNT}:role/admin` }, CANARY_NOW);
    const statements = f.Resources.CanaryLauncherRole.Properties.Policies[0].PolicyDocument.Statement as Array<{
      Sid?: string; Effect: string; Action: string | string[]; Resource: string | string[]; Condition?: Record<string, unknown>;
    }>;
    expect(statements.some(s => s.Sid === 'TagOnlyAtCreation')).toBe(true);
    expect(statements.some(s => s.Sid === 'NoCreationAfterTrialCutoff')).toBe(true);
    const creationDenies = statements.filter(s => s.Effect === 'Deny' && s.Condition?.StringNotEquals);
    expect(creationDenies).toHaveLength(6);
    for (const deny of creationDenies) expect(Object.keys(deny.Condition!.StringNotEquals as object)).toHaveLength(1);
    expect(creationDenies).toContainEqual({ Effect: 'Deny', Action: 'ec2:CreateSnapshot',
      Resource: [`arn:aws:ec2:${REGION}::snapshot/*`],
      Condition: { StringNotEquals: { 'aws:RequestTag/papercusp:workspace-id': CANARY.workspaceId } } });
    expect(statements.some(s => Array.isArray(s.Action) && s.Action.includes('iam:PutRolePolicy'))).toBe(false);
  });

  it('confines the cleanup service trust and leaves no scheduling or guest-execution dependency', () => {
    const f = awsCanaryDeadlineStackFragment({ ...CANARY, accountId: ACCOUNT, region: REGION,
      principalArn: `arn:aws:iam::${ACCOUNT}:role/admin` }, CANARY_NOW);
    expect(f.Resources.CanaryCleanupRole.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      { Effect: 'Allow', Principal: { Service: 'ssm.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: {
        StringEquals: { 'aws:SourceAccount': ACCOUNT },
        ArnLike: { 'aws:SourceArn': `arn:aws:ssm:${REGION}:${ACCOUNT}:automation-execution/*` },
      } },
    ]);
    expect(Object.values(f.Resources).map(r => r.Type)).toEqual(['AWS::IAM::Role', 'AWS::IAM::Role', 'AWS::SSM::Document']);
    expect(f.Resources.CanaryDeadlineDocument.Properties.Content).toEqual(f.plan.document);
  });

  it('refuses expired trials and a principal in another account before emitting a stack', () => {
    expect(() => awsCustomerSetupTemplate({ accountId: ACCOUNT, region: REGION,
      finiteCanary: CANARY }, Date.parse(CANARY.workloadDeadlineAt))).toThrow();
    expect(() => awsCanaryDeadlineStackFragment({ ...CANARY, accountId: ACCOUNT, region: REGION,
      principalArn: 'arn:aws:iam::999999999999:role/other' }, CANARY_NOW)).toThrow();
  });
});

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
