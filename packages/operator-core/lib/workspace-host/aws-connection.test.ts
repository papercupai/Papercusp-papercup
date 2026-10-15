import { describe, expect, it } from 'vitest';
import {
  AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS,
  AWS_WORKSPACE_HOST_PERMISSION_ACTIONS,
  buildAwsWorkspaceHostProviderConnection,
  planAwsSdkCredentialProvider,
  preflightAwsWorkspaceHostConnection,
  type AwsWorkspaceHostPreflightClient,
  type AwsWorkspaceHostPreflightRequest,
  type AwsWorkspaceHostQuotaRequirement,
} from './aws-connection';

const quota: AwsWorkspaceHostQuotaRequirement = {
  serviceCode: 'ec2',
  quotaCode: 'L-1216C47A',
  minimumValue: 4,
  label: 'On-Demand Standard instance vCPUs',
};

function request(overrides: Partial<AwsWorkspaceHostPreflightRequest> = {}): AwsWorkspaceHostPreflightRequest {
  return {
    cloudCredentialRef: { kind: 'cloud', ref: 'resolver://aws/dev' },
    credentialSource: { environment: 'local', method: 'shared-profile', profile: 'papercusp-dev' },
    selection: {
      accountId: '123456789012',
      partition: 'aws',
      region: 'us-east-1',
      subnetId: 'subnet-123',
      imageId: 'ami-123',
      kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/key-123',
      instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/papercusp-workspace',
      architecture: 'x86_64',
      quotas: [quota],
    },
    now: () => '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function client(
  overrides: Partial<AwsWorkspaceHostPreflightClient> = {},
): AwsWorkspaceHostPreflightClient {
  return {
    async getCallerIdentity() {
      return {
        accountId: '123456789012',
        arn: 'arn:aws:sts::123456789012:assumed-role/Papercusp/operator',
        userId: 'AROAEXAMPLE:operator',
        evidenceRef: 'aws://sts/get-caller-identity/1',
      };
    },
    async describeRegion(region) {
      return { id: region, partition: 'aws', available: true, evidenceRef: `aws://ec2/region/${region}` };
    },
    async describeSubnet(id) {
      return {
        id,
        region: 'us-east-1',
        availabilityZone: 'us-east-1a',
        vpcId: 'vpc-123',
        available: true,
        evidenceRef: `aws://ec2/subnet/${id}`,
      };
    },
    async describeImage(id) {
      return {
        id,
        ownerId: '099720109477',
        state: 'available',
        architecture: 'x86_64',
        launchAllowed: true,
        evidenceRef: `aws://ec2/image/${id}`,
      };
    },
    async describeKmsKey(arn) {
      return {
        arn,
        partition: 'aws',
        region: 'us-east-1',
        enabled: true,
        symmetric: true,
        evidenceRef: 'aws://kms/key/key-123',
      };
    },
    async evaluatePermissions({ actions, imageKeyActions }) {
      return [...actions, ...imageKeyActions].map((action) => ({ action, allowed: true, evidenceRef: `aws://iam/${action}` }));
    },
    async getServiceQuota(requirement) {
      return { ...requirement, value: 32, evidenceRef: `aws://quota/${requirement.quotaCode}` };
    },
    ...overrides,
  };
}

describe('AWS workspace-host credential onboarding', () => {
  it('plans standard SDK chain, shared profile, local assume-role, and hosted delegation without credentials', () => {
    expect(planAwsSdkCredentialProvider({ environment: 'local', method: 'default-chain' })).toMatchObject({
      factory: 'defaultProvider',
      source: 'default-chain',
    });
    expect(
      planAwsSdkCredentialProvider({ environment: 'local', method: 'shared-profile', profile: 'identity-center' }),
    ).toMatchObject({ factory: 'fromIni', profile: 'identity-center' });
    expect(
      planAwsSdkCredentialProvider({
        environment: 'local',
        method: 'assume-role',
        roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceAdmin',
        sourceProfile: 'identity-center',
      }),
    ).toMatchObject({ factory: 'fromTemporaryCredentials', source: 'shared-profile' });
    expect(
      planAwsSdkCredentialProvider({
        environment: 'hosted',
        method: 'customer-role',
        roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost',
        trustedPrincipalArn: 'arn:aws:iam::210987654321:role/PapercuspControlPlane',
        externalIdRef: 'resolver://aws/external-id/customer-1',
      }),
    ).toMatchObject({ factory: 'fromTemporaryCredentials', source: 'control-plane-role' });
    expect(
      planAwsSdkCredentialProvider({
        environment: 'hosted',
        method: 'oidc',
        roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost',
        providerArn: 'arn:aws:iam::123456789012:oidc-provider/app.papercusp.com',
        issuer: 'https://app.papercusp.com',
        audience: 'sts.amazonaws.com',
        subject: 'workspace:ws-1',
      }),
    ).toMatchObject({ factory: 'fromWebToken', source: 'control-plane-oidc' });
  });

  it('rejects static credential material and malformed hosted trust contracts', () => {
    expect(() =>
      planAwsSdkCredentialProvider({
        environment: 'local',
        method: 'default-chain',
        accessKeyId: 'AKIAEXAMPLE',
      } as never),
    ).toThrow('Secret-shaped field');
    expect(() =>
      planAwsSdkCredentialProvider({
        environment: 'hosted',
        method: 'oidc',
        roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost',
        providerArn: 'arn:aws:iam::210987654321:oidc-provider/app.papercusp.com',
        issuer: 'http://app.papercusp.com',
        audience: 'sts.amazonaws.com',
        subject: 'workspace:ws-1',
      }),
    ).toThrow('same AWS account and partition');
  });

  it('builds a provider-neutral typed connection without credential bytes', () => {
    const connection = buildAwsWorkspaceHostProviderConnection(request());
    expect(connection).toMatchObject({
      target: 'aws',
      cloudCredentialRef: { kind: 'cloud', ref: 'resolver://aws/dev' },
      scope: { kind: 'account', id: '123456789012' },
      provider: { region: 'us-east-1', subnetId: 'subnet-123', imageId: 'ami-123' },
    });
    expect(JSON.stringify(connection)).not.toMatch(/accessKeyId|secretAccessKey|sessionToken/);
  });

  it('passes only with identity, catalog, permission, and quota evidence for every required check', async () => {
    const report = await preflightAwsWorkspaceHostConnection(request(), client());
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.identity?.accountId).toBe('123456789012');
    expect(report.permissions).toHaveLength(
      AWS_WORKSPACE_HOST_PERMISSION_ACTIONS.length + AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS.length,
    );
    expect(report.quotas).toEqual([{ ...quota, value: 32, evidenceRef: 'aws://quota/L-1216C47A' }]);
  });

  it('refuses a role that cannot use the AMI snapshot key through EC2 (WI-10006815)', async () => {
    // The P-012 operator role held every lifecycle action but not these two, and each launch died
    // at start with Client.InvalidKMSKey.InvalidState. The preflight must name them instead.
    const report = await preflightAwsWorkspaceHostConnection(
      request(),
      client({
        async evaluatePermissions({ actions, imageKeyActions }) {
          return [
            ...actions.map((action) => ({ action, allowed: true, evidenceRef: `aws://iam/${action}` })),
            ...imageKeyActions.map((action) => ({ action, allowed: false, evidenceRef: `aws://iam/${action}`, reason: 'implicitDeny' })),
          ];
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => [issue.code, issue.message])).toEqual(
      AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS.map((action) => ['permission-denied', `Permission '${action}' is denied: implicitDeny`]),
    );
  });

  it('refuses when the AMI-key actions were never evaluated (WI-10006815)', async () => {
    const report = await preflightAwsWorkspaceHostConnection(
      request(),
      client({
        async evaluatePermissions({ actions }) {
          return actions.map((action) => ({ action, allowed: true, evidenceRef: `aws://iam/${action}` }));
        },
      }),
    );
    expect(report.issues.map((issue) => [issue.code, issue.message])).toEqual(
      AWS_WORKSPACE_HOST_IMAGE_KEY_ACTIONS.map((action) => ['permission-unverified', `Permission '${action}' was not evaluated.`]),
    );
  });

  it('fails closed with actionable diagnostics for account, region, resource, permission, and quota defects', async () => {
    const report = await preflightAwsWorkspaceHostConnection(
      request(),
      client({
        async getCallerIdentity() {
          return {
            accountId: '210987654321',
            arn: 'arn:aws-cn:sts::210987654321:assumed-role/Wrong/operator',
            userId: 'wrong',
            evidenceRef: 'aws://sts/wrong',
          };
        },
        async describeRegion(region) {
          return { id: region, partition: 'aws', available: false, evidenceRef: 'aws://ec2/region/disabled' };
        },
        async describeSubnet(id) {
          return {
            id,
            region: 'us-west-2',
            availabilityZone: 'us-west-2a',
            vpcId: 'vpc-123',
            available: false,
            evidenceRef: 'aws://ec2/subnet/bad',
          };
        },
        async describeImage(id) {
          return {
            id,
            ownerId: 'owner',
            state: 'deregistered',
            architecture: 'arm64',
            launchAllowed: false,
            evidenceRef: 'aws://ec2/image/bad',
          };
        },
        async describeKmsKey(arn) {
          return {
            arn,
            partition: 'aws',
            region: 'us-west-2',
            enabled: false,
            symmetric: false,
            evidenceRef: 'aws://kms/key/bad',
          };
        },
        async evaluatePermissions({ actions }) {
          return actions.slice(0, -1).map((action, index) => ({
            action,
            allowed: index !== 0,
            evidenceRef: `aws://iam/${action}`,
            reason: index === 0 ? 'explicit deny' : undefined,
          }));
        },
        async getServiceQuota(requirement) {
          return { ...requirement, value: 1, evidenceRef: 'aws://quota/low' };
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(new Set(report.issues.map((issue) => issue.code))).toEqual(
      new Set([
        'account-mismatch',
        'partition-mismatch',
        'region-unavailable',
        'subnet-unavailable',
        'subnet-region-mismatch',
        'image-unavailable',
        'image-architecture-mismatch',
        'kms-key-unavailable',
        'permission-denied',
        'permission-unverified',
        'quota-insufficient',
      ]),
    );
    expect(report.issues.every((issue) => issue.remediation.length > 0)).toBe(true);
  });

  it('turns SDK probe failures into a red report instead of partial success', async () => {
    const report = await preflightAwsWorkspaceHostConnection(
      request(),
      client({ async getCallerIdentity() { throw new Error('SSO session expired'); } }),
    );
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'probe-failed',
      message: expect.stringContaining('SSO session expired'),
    }));
  });
});
