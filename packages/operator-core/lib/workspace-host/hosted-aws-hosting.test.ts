import { describe, expect, it } from 'vitest';
import { AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS, AWS_WORKSPACE_HOST_PERMISSION_ACTIONS } from './aws-connection';
import { AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS } from './aws-safety';
import { GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS } from './gcp-safety';
import { AWS_SPOT_SERVICE_LINKED_ROLE_ACTION, awsSpotServiceLinkedRoleStatement } from './hosted-aws-host-stack';
import {
  HostedAwsHostingUnconfiguredError,
  hostedAwsHostingAdminRole,
  hostedAwsWorkspaceAccount,
  HOSTED_AWS_HOSTING_ADMIN_ROLE_ENV,
  HOSTED_AWS_WORKSPACE_ACCOUNT_ENV,
  PAPERCUSP_HOSTING_ACTION_CLASSES,
  papercuspHostingPolicy,
  papercuspHostingRoleArn,
  papercuspHostingRoleName,
  papercuspHostingTrustPolicy,
} from './hosted-aws-hosting';
import { HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX, organizationDelegationRoleName } from './hosted-aws-identity';

type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
};

const ACCOUNT = '123456789012';
const HOST = 'host-0f9b1ba8db30d143becc130a';
const ORG = 'org-acme';
const HOST_TAG = AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId;

function statements(hostId = HOST): Statement[] {
  return (papercuspHostingPolicy({ organizationId: ORG, accountId: ACCOUNT, hostId }) as { Statement: Statement[] }).Statement;
}

const list = (value: string | string[]) => (Array.isArray(value) ? value : [value]);

/** Every statement that allows `action` on a resource matching `resourcePrefix`. */
function grants(action: string, resourcePrefix: string): Statement[] {
  return statements().filter((s) =>
    s.Effect === 'Allow' &&
    list(s.Action).includes(action) &&
    list(s.Resource).some((r) => r === '*' || r.startsWith(resourcePrefix) || resourcePrefix.startsWith(r.replace(/\*$/, ''))),
  );
}

describe('Papercusp-hosted AWS hosting role (aws-byoc-gcp-parity D-017)', () => {
  it('grants every action the workspace-host client sends, each classified exactly once', () => {
    const granted = new Set(statements().flatMap((s) => list(s.Action)));
    for (const action of AWS_WORKSPACE_HOST_PERMISSION_ACTIONS) {
      expect(granted, action).toContain(action);
      expect(PAPERCUSP_HOSTING_ACTION_CLASSES[action], action).toBeDefined();
    }
    // Nothing beyond the client's own list, except the Spot service-linked role EC2 creates with
    // the caller's permission (pinned to that one role by the next test) and the EC2-only use of
    // the AMI snapshot key (pinned by the AMI-key test).
    const allowed: readonly string[] = [
      ...AWS_WORKSPACE_HOST_PERMISSION_ACTIONS,
      ...AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS,
      AWS_SPOT_SERVICE_LINKED_ROLE_ACTION,
    ];
    for (const action of granted) expect(allowed, action).toContain(action);
  });

  it('lets EBS decrypt the AMI snapshot for a launch, through EC2 in the host region only (WI-10006815)', () => {
    // Without it every hosted launch from the encrypted Papercusp AMI dies at start with
    // Client.InvalidKMSKey.InvalidState. The AMI key is the publisher's, so any account, but never a
    // direct Decrypt and never another region's EC2.
    const imageKey = AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS.flatMap((action) => grants(action, 'arn:aws:kms:us-east-1:'));
    expect([...new Set(imageKey.map((s) => s.Sid))]).toEqual(['ImageKeyUse']);
    expect(imageKey[0]).toEqual({
      Sid: 'ImageKeyUse',
      Effect: 'Allow',
      Action: [...AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS],
      Resource: 'arn:aws:kms:us-east-1:*:key/*',
      Condition: { StringLike: { 'kms:ViaService': 'ec2.us-east-1.amazonaws.com' } },
    });
  });

  it('lets the role create only EC2\'s Spot service-linked role, no other role or service (WI-10005389)', () => {
    const slr = statements().filter((s) => list(s.Action).includes(AWS_SPOT_SERVICE_LINKED_ROLE_ACTION));
    expect(slr).toEqual([awsSpotServiceLinkedRoleStatement(ACCOUNT)]);
    expect(slr[0].Resource).toBe(`arn:aws:iam::${ACCOUNT}:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot`);
    expect(slr[0].Condition?.StringEquals?.['iam:AWSServiceName']).toBe('spot.amazonaws.com');
    expect(list(slr[0].Action)).toEqual([AWS_SPOT_SERVICE_LINKED_ROLE_ACTION]);
  });

  it('confines every mutation of an existing instance, disk or snapshot to the reserved host', () => {
    const mutating = ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:RebootInstances', 'ec2:GetConsoleOutput',
      'ec2:AttachVolume', 'ec2:DetachVolume', 'ec2:DeleteVolume', 'ec2:DeleteSnapshot', 'ssm:SendCommand', 'ssm:StartSession'];
    for (const action of mutating) {
      const tenantData = statements().filter((s) => list(s.Action).includes(action) &&
        list(s.Resource).some((r) => /:(instance|volume)\/\*$|::snapshot\/\*$/.test(r)));
      expect(tenantData.length, action).toBeGreaterThan(0);
      for (const s of tenantData) {
        expect(s.Condition?.StringEquals?.[`aws:ResourceTag/${HOST_TAG}`], `${action} in ${s.Sid}`).toBe(HOST);
      }
    }
  });

  it('allows creating a machine, disk or snapshot only when the request stamps the reserved host', () => {
    for (const s of statements().filter((x) => /^Create(ForHost|SnapshotForHost)$/.test(x.Sid))) {
      expect(s.Condition?.StringEquals?.[`aws:RequestTag/${HOST_TAG}`]).toBe(HOST);
    }
    const instanceCreates = grants('ec2:RunInstances', `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/`);
    expect(instanceCreates.map((s) => s.Sid)).toEqual(['CreateForHost']);
  });

  it('never lets a new disk be restored from another tenant\'s snapshot', () => {
    const fromSnapshot = statements().filter((s) => list(s.Action).includes('ec2:CreateVolume') &&
      list(s.Resource).some((r) => r.includes('::snapshot/')));
    expect(fromSnapshot.map((s) => s.Sid)).toEqual(['RestoreFromHostSnapshot']);
    expect(fromSnapshot[0].Condition?.StringEquals?.[`aws:ResourceTag/${HOST_TAG}`]).toBe(HOST);
  });

  it('writes tags only at creation and only with the reserved host id', () => {
    const tagging = statements().filter((s) => list(s.Action).includes('ec2:CreateTags'));
    expect(tagging).toHaveLength(1);
    expect(tagging[0].Condition?.StringEquals?.['ec2:CreateAction']).toEqual(['RunInstances', 'CreateVolume', 'CreateSnapshot']);
    expect(tagging[0].Condition?.StringEquals?.[`aws:RequestTag/${HOST_TAG}`]).toBe(HOST);
  });

  it('passes only the shared stack\'s instance role, and only to EC2', () => {
    const pass = statements().filter((s) => list(s.Action).includes('iam:PassRole'));
    expect(pass).toHaveLength(1);
    expect(pass[0].Resource).toBe(`arn:aws:iam::${ACCOUNT}:role/PapercuspWorkspaceHostInstance-${ACCOUNT}`);
    expect(pass[0].Condition?.StringEquals?.['iam:PassedToService']).toBe('ec2.amazonaws.com');
  });

  it('keeps unconditional grants to calls that change nothing', () => {
    const open = statements().filter((s) => list(s.Resource).includes('*'));
    expect(open.map((s) => s.Sid)).toEqual(['Observe']);
    for (const action of list(open[0].Action)) {
      expect(action).toMatch(/^(ec2:Describe|ssm:(Describe|Get)|servicequotas:(Get|List)|pricing:Get)/);
    }
  });

  it('keeps cost accounting at GCP parity: priced like a customer host, attributed by the same identity tags', () => {
    // The price estimate runs as the hosting role, so the Price List call must stay granted.
    expect(list(statements().find((s) => s.Sid === 'Observe')!.Action)).toContain('pricing:GetProducts');
    // GCP hosting attributes spend by its managed labels; AWS by the same three identities, as tags
    // that can only be written at creation and only with this host's id.
    expect(Object.keys(AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS).sort()).toEqual(Object.keys(GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS).sort());
    expect(grants('ec2:CreateTags', `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/`).map((s) => s.Sid)).toEqual(['TagOnlyAtCreation']);
  });

  it('rewrites for each host: two hosts get disjoint conditions', () => {
    const other = (papercuspHostingPolicy({ organizationId: ORG, accountId: ACCOUNT, hostId: 'host-other' }) as { Statement: Statement[] }).Statement;
    expect(JSON.stringify(other)).not.toContain(HOST);
  });

  it('refuses an invalid account or host instead of writing a wildcard', () => {
    expect(() => papercuspHostingPolicy({ organizationId: ORG, accountId: '12', hostId: HOST })).toThrow(/account_invalid/);
    expect(() => papercuspHostingPolicy({ organizationId: ORG, accountId: ACCOUNT, hostId: '*' })).toThrow(/host_invalid/);
  });
});

describe('hosting role identity', () => {
  it('uses the customer-role prefix, so the per-org chain policy already covers it, and fits IAM\'s 64-char limit', () => {
    const name = papercuspHostingRoleName(ORG);
    expect(name).toBe(`${HOSTED_AWS_CUSTOMER_ROLE_NAME_PREFIX}${organizationDelegationRoleName(ORG)}`);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(papercuspHostingRoleArn(ORG, ACCOUNT)).toBe(`arn:aws:iam::${ACCOUNT}:role/${name}`);
  });

  it('trusts only the organization\'s own role, and only with its ExternalId', () => {
    const orgRole = `arn:aws:iam::210987654321:role/papercusp/orgs/${organizationDelegationRoleName(ORG)}`;
    const trust = papercuspHostingTrustPolicy({ organizationRoleArn: orgRole, externalId: 'pcx-abc' }) as { Statement: Statement[] & { Principal?: unknown }[] };
    expect(trust.Statement).toEqual([{
      Effect: 'Allow',
      Principal: { AWS: orgRole },
      Action: 'sts:AssumeRole',
      Condition: { StringEquals: { 'sts:ExternalId': 'pcx-abc' } },
    }]);
    expect(() => papercuspHostingTrustPolicy({ organizationRoleArn: orgRole, externalId: '' })).toThrow(/external_id_required/);
  });

  it('reads the hosting account and optional admin role from the environment, refusing malformed values', () => {
    expect(() => hostedAwsWorkspaceAccount({})).toThrow(/unconfigured/);
    // Typed, so first-workspace can tell "AWS is not offered here" from a fault worth retrying.
    expect(() => hostedAwsWorkspaceAccount({})).toThrow(HostedAwsHostingUnconfiguredError);
    expect(() => hostedAwsWorkspaceAccount({ [HOSTED_AWS_WORKSPACE_ACCOUNT_ENV]: 'abc' })).not.toThrow(HostedAwsHostingUnconfiguredError);
    expect(() => hostedAwsWorkspaceAccount({ [HOSTED_AWS_WORKSPACE_ACCOUNT_ENV]: 'abc' })).toThrow(/invalid/);
    expect(hostedAwsWorkspaceAccount({ [HOSTED_AWS_WORKSPACE_ACCOUNT_ENV]: ` ${ACCOUNT} ` })).toBe(ACCOUNT);
    expect(hostedAwsHostingAdminRole({})).toBeUndefined();
    expect(() => hostedAwsHostingAdminRole({ [HOSTED_AWS_HOSTING_ADMIN_ROLE_ENV]: 'nope' })).toThrow(/invalid/);
    const admin = `arn:aws:iam::${ACCOUNT}:role/PapercuspHostingAdmin`;
    expect(hostedAwsHostingAdminRole({ [HOSTED_AWS_HOSTING_ADMIN_ROLE_ENV]: admin })).toBe(admin);
  });
});
