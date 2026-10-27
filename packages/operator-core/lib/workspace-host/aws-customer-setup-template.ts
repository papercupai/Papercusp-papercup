/**
 * Customer-run AWS setup template (plan aws-byoc-gcp-parity-2026-10-01, P-013 / D-011).
 *
 * The hosted path (app.papercusp.com) already hands the customer a CloudFormation template built by
 * hosted-provider-delegation.ts. The desktop path has none: its connection form asks for a VPC,
 * subnet, security group, launch template, instance profile and KMS key the customer would otherwise
 * build by hand, while the GCP provider builds its network itself. This module closes that gap with
 * ONE template the customer creates in their own account:
 *
 *   - a role whose only policy is AWS_WORKSPACE_HOST_PERMISSION_ACTIONS (the same least-privilege set
 *     the preflight checks and the hosted role carries), trusting a principal the customer names;
 *   - the host network, instance profile, KMS key and launch template from hostedAwsHostStackFragment,
 *     the same resources a hosted customer's stack builds (D-009).
 *
 * Every Output maps onto one connection-form field (AWS_CUSTOMER_SETUP_CONNECTION_FIELDS), so the
 * customer copies stack outputs into the form instead of looking resource IDs up. The workspace image
 * still comes from the image catalog (D-005), not the stack.
 *
 * Nothing here is secret: no ExternalId is required on this path because the trusted principal is the
 * customer's own account or a principal inside it, never Papercusp's.
 */
import { createHash } from 'node:crypto';
import { assertWorkspaceHostSecretIsolation } from '@papercusp/deployment-driver';
import { planAwsCanaryDeadline } from './aws-canary-deadline';
import { papercuspHostingPolicy } from './hosted-aws-hosting';
import {
  AWS_WORKSPACE_HOST_PERMISSION_ACTIONS,
  awsWorkspaceHostImageKeyStatement,
  type AwsWorkspaceHostImageKeyStatement,
} from './aws-connection';
import {
  HOSTED_AWS_HOST_TAG_KEY,
  HOSTED_AWS_REGION,
  awsSpotServiceLinkedRoleStatement,
  hostedAwsHostStackFragment,
  type AwsSpotServiceLinkedRoleStatement,
} from './hosted-aws-host-stack';

export const AWS_CUSTOMER_SETUP_TEMPLATE_VERSION = 'aws-customer-setup-template-v1';
export const AWS_CUSTOMER_OPERATOR_ROLE_NAME_PREFIX = 'PapercuspWorkspaceHostOperator-';
export const AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID = 'WorkspaceHostOperatorRole';
export const AWS_CUSTOMER_OPERATOR_POLICY_NAME = 'PapercuspWorkspaceHostLifecycle';

const AWS_ACCOUNT = /^\d{12}$/;
/** An IAM role, user or account-root principal inside one account, in any commercial partition. */
const AWS_PRINCIPAL_ARN = /^arn:aws(?:-[a-z]+)*:iam::(\d{12}):(?:root|role\/[\w+=,.@/-]{1,512}|user\/[\w+=,.@/-]{1,512})$/;

/**
 * Stack output → connection-form field. The desktop connection route
 * (routes/workspace-hosts/connection.ts) reads these field names; the template's Outputs carry
 * exactly these keys. `securityGroupIds` takes the one group as a single-element list, and the role
 * goes into a local assume-role credential source (`credentialSource.roleArn`).
 */
export const AWS_CUSTOMER_SETUP_CONNECTION_FIELDS = {
  OperatorRoleArn: 'credentialSource.roleArn',
  VpcId: 'vpcId',
  PrivateSubnetId: 'subnetId',
  SecurityGroupId: 'securityGroupIds',
  LaunchTemplateId: 'launchTemplateId',
  InstanceProfileArn: 'instanceProfileArn',
  KmsKeyArn: 'kmsKeyArn',
} as const;

export type AwsCustomerSetupOutputKey = keyof typeof AWS_CUSTOMER_SETUP_CONNECTION_FIELDS;

export interface AwsCustomerSetupTemplateRequest {
  /** The 12-digit account the stack is created in. */
  accountId: string;
  /** The region the workspace host runs in; the template refuses to create anywhere else. */
  region: string;
  /**
   * The principal allowed to assume the operator role — the identity behind the customer's local AWS
   * profile. Must live in `accountId`. Defaults to the account root, which delegates the choice to the
   * customer's own IAM policies (a principal still needs sts:AssumeRole on the role to use it).
   */
  principalArn?: string;
  /** Private finite qualification only; adds dedicated roles and an immutable SSM document. */
  finiteCanary?: AwsCustomerFiniteCanary;
}

export interface AwsCustomerFiniteCanary {
  runId: string;
  workspaceId: string;
  organizationId: string;
  hostId: string;
  workloadDeadlineAt: string;
  teardownDeadlineAt: string;
}

export interface AwsCustomerSetupTemplate {
  version: typeof AWS_CUSTOMER_SETUP_TEMPLATE_VERSION;
  format: 'aws-cloudformation-json';
  accountId: string;
  region: string;
  roleName: string;
  principalArn: string;
  /** Suggested stack name; the template does not depend on it. */
  stackName: string;
  document: Record<string, unknown>;
}

/**
 * The least-privilege policy alone, for a customer who attaches it to an existing role or user.
 * The second statement lets a spot host's first launch create EC2's Spot service-linked role
 * (WI-10005389) and no other role; an identity policy only reaches its own account, so the
 * account segment is a wildcard and the same document works standalone and in the stack.
 * The third lets EBS decrypt the Papercusp AMI's snapshot for a launch, through EC2 only
 * (WI-10006815); without it every launch from an encrypted AMI dies at start.
 */
export function awsWorkspaceHostLeastPrivilegePolicy(): {
  Version: '2012-10-17';
  Statement: [
    { Sid: string; Effect: 'Allow'; Action: string[]; Resource: '*' },
    AwsSpotServiceLinkedRoleStatement,
    AwsWorkspaceHostImageKeyStatement,
  ];
} {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PapercuspWorkspaceHostLifecycle',
        Effect: 'Allow',
        Action: [...AWS_WORKSPACE_HOST_PERMISSION_ACTIONS],
        Resource: '*',
      },
      awsSpotServiceLinkedRoleStatement('*'),
      awsWorkspaceHostImageKeyStatement(),
    ],
  };
}

function validated(request: AwsCustomerSetupTemplateRequest): Required<Pick<AwsCustomerSetupTemplateRequest,
  'accountId' | 'region' | 'principalArn'>> {
  const accountId = String(request.accountId ?? '').trim();
  if (!AWS_ACCOUNT.test(accountId)) throw new Error('accountId must be a 12-digit AWS account ID');
  const region = String(request.region ?? '').trim();
  if (!HOSTED_AWS_REGION.test(region)) throw new Error('region must be a commercial AWS region such as us-east-1');
  const principalArn = request.principalArn === undefined || String(request.principalArn).trim() === ''
    ? `arn:aws:iam::${accountId}:root`
    : String(request.principalArn).trim();
  const match = AWS_PRINCIPAL_ARN.exec(principalArn);
  if (!match) throw new Error('principalArn must be an IAM role, user or account root ARN');
  if (match[1] !== accountId) throw new Error('principalArn must belong to accountId');
  return { accountId, region, principalArn };
}

/**
 * Compose onto the maintained host stack, rather than a second network or a new
 * scheduling service. Installation alone does NOT admit a canary: the SDK must
 * read these exact policies/document and observe its execution sleeping first.
 */
export function awsCanaryDeadlineStackFragment(input: AwsCustomerFiniteCanary & {
  accountId: string; region: string; principalArn: string;
}, nowMs = Date.now()) {
  // Apply the same account/region/principal validation as the containing template.
  const { accountId, region, principalArn } = validated(input);
  const suffix = createHash('sha256').update(input.runId).digest('hex').slice(0, 32);
  const cleanupRoleName = `PapercuspCanaryCleanup-${suffix}`;
  const launcherRoleName = `PapercuspCanaryLauncher-${suffix}`;
  const cleanupRoleArn = `arn:aws:iam::${accountId}:role/${cleanupRoleName}`;
  const launcherRoleArn = `arn:aws:iam::${accountId}:role/${launcherRoleName}`;
  const plan = planAwsCanaryDeadline({ accountId, region, runId: input.runId, workspaceId: input.workspaceId,
    workloadDeadlineAt: input.workloadDeadlineAt, teardownDeadlineAt: input.teardownDeadlineAt, cleanupRoleArn }, nowMs);
  const hosting = papercuspHostingPolicy({ accountId, region, organizationId: input.organizationId,
    hostId: input.hostId }) as { Version: string; Statement: Record<string, unknown>[] };
  const resource = (kind: string) => `arn:aws:ec2:${region}:${kind === 'snapshot' ? '' : accountId}:${kind}/*`;
  // Separate each missing/wrong tag into its own deny: multiple keys in a
  // StringNotEquals block are ANDed and would let a single wrong tag through.
  const creationConstraints = [
    { action: 'ec2:RunInstances', kinds: ['instance', 'volume', 'spot-instances-request'] },
    { action: 'ec2:CreateVolume', kinds: ['volume'] },
    { action: 'ec2:CreateSnapshot', kinds: ['snapshot'] },
  ].flatMap(({ action, kinds }) => Object.entries({
    'papercusp:managed': 'true', 'papercusp:workspace-id': input.workspaceId,
  }).map(([tag, value]) => ({ Effect: 'Deny', Action: action, Resource: kinds.map(resource),
    Condition: { StringNotEquals: { [`aws:RequestTag/${tag}`]: value } } })));
  const launcherPolicy = { Version: '2012-10-17', Statement: [
    ...hosting.Statement, ...plan.launcherDeadlineDenyPolicy.Statement, ...creationConstraints,
    { Effect: 'Allow', Action: 'ssm:GetDocument', Resource: `arn:aws:ssm:${region}:${accountId}:document/${plan.documentName}` },
    { Effect: 'Allow', Action: ['ssm:GetAutomationExecution', 'ssm:DescribeAutomationStepExecutions'],
      Resource: `arn:aws:ssm:${region}:${accountId}:automation-execution/*` },
    { Effect: 'Allow', Action: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies'],
      Resource: [launcherRoleArn, cleanupRoleArn] },
  ] };
  const tags = [{ Key: 'papercusp:canary-run', Value: input.runId }];
  return {
    plan,
    Resources: {
      CanaryCleanupRole: { Type: 'AWS::IAM::Role', Properties: {
        RoleName: cleanupRoleName,
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow',
          Principal: { Service: 'ssm.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: {
            StringEquals: { 'aws:SourceAccount': accountId },
            ArnLike: { 'aws:SourceArn': `arn:aws:ssm:${region}:${accountId}:automation-execution/*` },
          } }] },
        Policies: [{ PolicyName: 'PapercuspCanaryCleanup', PolicyDocument: plan.cleanupPolicy }], Tags: tags,
      } },
      CanaryLauncherRole: { Type: 'AWS::IAM::Role', Properties: {
        RoleName: launcherRoleName,
        AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow',
          Principal: { AWS: principalArn }, Action: 'sts:AssumeRole' }] },
        Policies: [{ PolicyName: 'PapercuspCanaryLaunch', PolicyDocument: launcherPolicy }], Tags: tags,
      } },
      CanaryDeadlineDocument: { Type: 'AWS::SSM::Document', DependsOn: ['CanaryCleanupRole', 'CanaryLauncherRole'],
        Properties: { Name: plan.documentName, DocumentType: 'Automation', DocumentFormat: 'JSON',
          UpdateMethod: 'NewVersion', Content: plan.document, Tags: tags } },
    },
    Outputs: {
      CanaryCleanupRoleArn: { Value: { 'Fn::GetAtt': ['CanaryCleanupRole', 'Arn'] } },
      CanaryLauncherRoleArn: { Value: { 'Fn::GetAtt': ['CanaryLauncherRole', 'Arn'] } },
      CanaryDocumentName: { Value: { Ref: 'CanaryDeadlineDocument' } },
      CanaryDocumentVersion: { Value: plan.documentVersion },
      CanaryCreationCutoffAt: { Value: input.workloadDeadlineAt },
      CanaryTeardownDeadlineAt: { Value: input.teardownDeadlineAt },
    },
  };
}

export function awsCustomerSetupTemplate(request: AwsCustomerSetupTemplateRequest, nowMs = Date.now()): AwsCustomerSetupTemplate {
  const { accountId, region, principalArn } = validated(request);
  const host = hostedAwsHostStackFragment(accountId, region, AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID);
  const canary = request.finiteCanary ? awsCanaryDeadlineStackFragment({
    ...request.finiteCanary, accountId, region, principalArn,
  }, nowMs) : undefined;
  const roleName = `${AWS_CUSTOMER_OPERATOR_ROLE_NAME_PREFIX}${accountId}`;
  const hostOutputs = host.Outputs as Record<string, unknown>;
  const document: Record<string, unknown> = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description:
      'Papercusp workspace host for the desktop app: a least-privilege operator role and the network, '
      + 'instance profile, KMS key and launch template the host launches into',
    Rules: host.Rules,
    Resources: {
      [AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID]: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: roleName,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Principal: { AWS: principalArn }, Action: 'sts:AssumeRole' }],
          },
          Policies: [{ PolicyName: AWS_CUSTOMER_OPERATOR_POLICY_NAME, PolicyDocument: awsWorkspaceHostLeastPrivilegePolicy() }],
          Tags: [{ Key: HOSTED_AWS_HOST_TAG_KEY, Value: accountId }],
        },
      },
      ...host.Resources,
      ...canary?.Resources,
    },
    Outputs: {
      OperatorRoleArn: {
        Description: 'Role ARN for the desktop connection form',
        Value: { 'Fn::GetAtt': [AWS_CUSTOMER_OPERATOR_ROLE_LOGICAL_ID, 'Arn'] },
      },
      VpcId: { Description: 'VPC ID for the desktop connection form', Value: { Ref: 'HostVpc' } },
      ...hostOutputs,
      ...canary?.Outputs,
    },
  };
  const template: AwsCustomerSetupTemplate = {
    version: AWS_CUSTOMER_SETUP_TEMPLATE_VERSION,
    format: 'aws-cloudformation-json',
    accountId,
    region,
    roleName,
    principalArn,
    stackName: `papercusp-workspace-host-${region}`,
    document,
  };
  assertWorkspaceHostSecretIsolation(template, 'awsCustomerSetupTemplate');
  return template;
}
