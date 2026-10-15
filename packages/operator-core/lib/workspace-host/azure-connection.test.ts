import { describe, expect, it } from 'vitest';
import {
  AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS,
  AZURE_WORKSPACE_HOST_REQUIRED_RESOURCE_TYPES,
  buildAzureWorkspaceHostProviderConnection,
  buildAzureWorkspaceHostRoleDefinitions,
  planAzureCredentialProvider,
  preflightAzureWorkspaceHostConnection,
  type AzureProviderRegistrationEvidence,
  type AzureWorkspaceHostPreflightClient,
  type AzureWorkspaceHostPreflightRequest,
  type AzureWorkspaceHostProviderNamespace,
  type AzureWorkspaceHostQuotaRequirement,
} from './azure-connection';

const tenantId = '11111111-1111-4111-8111-111111111111';
const subscriptionId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const galleryImage =
  `/subscriptions/${subscriptionId}/resourceGroups/papercusp-images/providers/` +
  'Microsoft.Compute/galleries/papercusp/images/ubuntu-2404/versions/1.0.0';

const quota: AzureWorkspaceHostQuotaRequirement = {
  providerNamespace: 'Microsoft.Compute',
  resourceName: 'standardDSv5Family',
  minimumAvailable: 4,
  label: 'Standard DSv5 family vCPUs',
};

function request(
  overrides: Partial<AzureWorkspaceHostPreflightRequest> = {},
): AzureWorkspaceHostPreflightRequest {
  return {
    cloudCredentialRef: { kind: 'cloud', ref: 'resolver://azure/dev' },
    credentialSource: { environment: 'local', method: 'azure-cli', tenantId },
    selection: {
      cloud: 'AzureCloud',
      tenantId,
      subscriptionId,
      resourceGroup: 'papercusp-workspaces',
      region: 'eastus2',
      vmSku: 'Standard_D4s_v5',
      architecture: 'x86_64',
      image: {
        kind: 'compute-gallery',
        versionResourceId: galleryImage,
        architecture: 'x86_64',
        requireSigned: true,
      },
      quotas: [quota],
    },
    now: () => '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function providerEvidence(
  namespace: AzureWorkspaceHostProviderNamespace,
): AzureProviderRegistrationEvidence {
  return {
    namespace,
    registrationState: namespace === 'Microsoft.Network' ? 'Registering' : 'Registered',
    resourceTypes: AZURE_WORKSPACE_HOST_REQUIRED_RESOURCE_TYPES
      .filter((resourceType) => resourceType.toLowerCase().startsWith(`${namespace.toLowerCase()}/`))
      .map((resourceType) => ({
        resourceType,
        locations: ['eastus2'],
        evidenceRef: `azure://provider/${namespace}/${resourceType}`,
      })),
    evidenceRef: `azure://provider/${namespace}`,
  };
}

function client(
  overrides: Partial<AzureWorkspaceHostPreflightClient> = {},
): AzureWorkspaceHostPreflightClient {
  return {
    async getCallerIdentity() {
      return {
        tenantId,
        principalId: '44444444-4444-4444-8444-444444444444',
        principalType: 'user',
        evidenceRef: 'azure://identity/me',
      };
    },
    async getSubscription(id) {
      return {
        id,
        tenantId,
        enabled: true,
        displayName: 'Papercusp development',
        evidenceRef: `azure://subscription/${id}`,
      };
    },
    async getResourceGroup(id, name) {
      return {
        subscriptionId: id,
        name,
        exists: true,
        evidenceRef: `azure://resource-group/${name}`,
      };
    },
    async getLocation(_id, region) {
      return { id: region, available: true, evidenceRef: `azure://location/${region}` };
    },
    async getProviderRegistration(_id, namespace) {
      return providerEvidence(namespace);
    },
    async evaluatePermissions({ actions }) {
      return actions.map((action) => ({
        action,
        allowed: true,
        evidenceRef: `azure://permission/${action}`,
      }));
    },
    async getQuota(_id, _region, requirement) {
      return {
        ...requirement,
        limit: 32,
        usage: 4,
        evidenceRef: `azure://quota/${requirement.resourceName}`,
      };
    },
    async describeVmSku(_id, region, sku) {
      return {
        name: sku,
        region,
        available: true,
        architecture: 'x86_64',
        restrictions: [],
        evidenceRef: `azure://sku/${sku}`,
      };
    },
    async describeImage(_id, region, image) {
      return {
        id: image.kind === 'compute-gallery'
          ? image.versionResourceId
          : `${image.publisher}:${image.offer}:${image.sku}:${image.version}`,
        kind: image.kind,
        region,
        available: true,
        architecture: 'x86_64',
        signed: true,
        evidenceRef: 'azure://image/selected',
      };
    },
    ...overrides,
  };
}

describe('Azure customer-run workspace-host role definitions', () => {
  it('covers preflight permissions exactly, with subscription and resource-group scope boundaries', () => {
    const roles = buildAzureWorkspaceHostRoleDefinitions({ subscriptionId, resourceGroup: 'workspaces' });
    expect(roles.subscription.AssignableScopes).toEqual([`/subscriptions/${subscriptionId}`]);
    expect(roles.resourceGroup.AssignableScopes).toEqual([
      `/subscriptions/${subscriptionId}/resourceGroups/workspaces`,
    ]);
    expect(roles.subscription.Actions).toEqual([
      'Microsoft.Resources/subscriptions/read',
      'Microsoft.Resources/subscriptions/providers/read',
      'Microsoft.Resources/subscriptions/providers/register/action',
      'Microsoft.Compute/locations/usages/read',
      'Microsoft.Compute/skus/read',
    ]);
    expect(roles.subscription.DataActions).toEqual([]);
    expect(roles.resourceGroup.DataActions).toEqual([
      'Microsoft.KeyVault/vaults/keys/read',
      'Microsoft.KeyVault/vaults/keys/wrap/action',
      'Microsoft.KeyVault/vaults/keys/unwrap/action',
    ]);
    const permissions = Object.values(roles).flatMap((role) => [...role.Actions, ...role.DataActions]);
    expect([...permissions].sort()).toEqual([...AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS].sort());
    expect(new Set(permissions).size).toBe(permissions.length);
    expect(permissions.some((action) => action.includes('*') || action.includes('/secrets/'))).toBe(false);
    expect(roles.resourceGroup.Actions).toContain('Microsoft.Authorization/roleAssignments/write');
    expect(roles.resourceGroup.Description).toContain('privileged');
    for (const role of Object.values(roles)) {
      expect(role.IsCustom).toBe(true);
      expect(role.NotActions).toEqual([]);
      expect(role.NotDataActions).toEqual([]);
    }
  });

  it('adds only image read access for a separate image resource group', () => {
    const input = { subscriptionId, resourceGroup: 'workspaces', imageResourceGroup: 'images' };
    const roles = buildAzureWorkspaceHostRoleDefinitions(input);
    expect(roles.imageResourceGroup).toMatchObject({
      Actions: ['Microsoft.Compute/images/read', 'Microsoft.Compute/galleries/images/versions/read'],
      DataActions: [],
      AssignableScopes: [`/subscriptions/${subscriptionId}/resourceGroups/images`],
    });
    expect(buildAzureWorkspaceHostRoleDefinitions({ ...input, imageResourceGroup: 'WORKSPACES' })
      .imageResourceGroup).toBeUndefined();
  });

  it.each(['', '/', '*', 'bad/group', 'bad\\group', 'bad.', 'a'.repeat(91), ' group', 'group\n'])
    ('rejects an invalid resource-group scope %j', (resourceGroup) => {
      expect(() => buildAzureWorkspaceHostRoleDefinitions({ subscriptionId, resourceGroup }))
        .toThrow('resourceGroup must be a valid Azure resource-group name');
      expect(() => buildAzureWorkspaceHostRoleDefinitions({
        subscriptionId, resourceGroup: 'workspaces', imageResourceGroup: resourceGroup,
      })).toThrow('imageResourceGroup must be a valid Azure resource-group name');
    });

  it.each(['', '*', '/subscriptions/' + subscriptionId, subscriptionId + '/resourceGroups/other', 'not-a-uuid'])
    ('rejects an invalid subscription scope %j', (subscriptionId) => {
      expect(() => buildAzureWorkspaceHostRoleDefinitions({ subscriptionId, resourceGroup: 'workspaces' }))
        .toThrow('subscriptionId must be an Azure UUID');
    });

  it('returns fresh non-secret JSON and refuses secret-shaped input', () => {
    const input = { subscriptionId, resourceGroup: 'workspaces' };
    const roles = buildAzureWorkspaceHostRoleDefinitions(input);
    expect(Object.keys(roles.resourceGroup).sort()).toEqual([
      'Actions', 'AssignableScopes', 'DataActions', 'Description', 'IsCustom', 'Name', 'NotActions', 'NotDataActions',
    ]);
    expect(JSON.parse(JSON.stringify(roles))).toEqual(roles);
    expect(() => buildAzureWorkspaceHostRoleDefinitions({ ...input, clientSecret: 'forbidden' } as never))
      .toThrow('Secret-shaped field');
    roles.resourceGroup.Actions.length = 0;
    expect(buildAzureWorkspaceHostRoleDefinitions(input).resourceGroup.Actions.length).toBeGreaterThan(0);
    expect(AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS).toContain('Microsoft.Compute/virtualMachines/write');
  });
});

describe('Azure workspace-host credential onboarding', () => {
  it('plans local DefaultAzureCredential/Azure CLI and both hosted secretless contracts', () => {
    expect(planAzureCredentialProvider({
      environment: 'local',
      method: 'default-credential',
      tenantId,
    })).toMatchObject({
      sdk: '@azure/identity',
      factory: 'DefaultAzureCredential',
      source: 'default-chain',
      tenantId,
    });
    expect(planAzureCredentialProvider({
      environment: 'local',
      method: 'azure-cli',
      tenantId,
    })).toMatchObject({
      sdk: '@azure/identity',
      factory: 'AzureCliCredential',
      source: 'azure-cli',
    });
    expect(planAzureCredentialProvider({
      environment: 'hosted',
      method: 'federated-service-principal',
      tenantId,
      clientId,
      issuer: 'https://app.papercusp.com/oidc',
      audience: 'api://AzureADTokenExchange',
      subject: 'workspace:ws-1',
      assertionRef: 'resolver://azure/assertion/ws-1',
    })).toMatchObject({
      sdk: '@azure/identity',
      factory: 'ClientAssertionCredential',
      source: 'federated-service-principal',
      clientId,
      federation: {
        issuer: 'https://app.papercusp.com/oidc',
        audience: 'api://AzureADTokenExchange',
        subject: 'workspace:ws-1',
        assertionRef: 'resolver://azure/assertion/ws-1',
      },
    });

    const managedApplicationResourceId =
      `/subscriptions/${subscriptionId}/resourceGroups/managed/providers/` +
      'Microsoft.Solutions/applications/papercusp';
    const managedIdentityResourceId =
      `/subscriptions/${subscriptionId}/resourceGroups/managed/providers/` +
      'Microsoft.ManagedIdentity/userAssignedIdentities/papercusp';
    expect(planAzureCredentialProvider({
      environment: 'hosted',
      method: 'managed-application',
      tenantId,
      applicationId: clientId,
      managedApplicationResourceId,
      managedIdentityResourceId,
    })).toMatchObject({
      sdk: 'azure-resource-manager',
      factory: 'ManagedApplicationListTokens',
      source: 'managed-application-identity',
      managedApplication: {
        applicationId: clientId,
        resourceId: managedApplicationResourceId,
        managedIdentityResourceId,
        authorizationAudience: 'https://management.azure.com/',
      },
    });
  });

  it('rejects static credential material and malformed hosted trust contracts', () => {
    expect(() => planAzureCredentialProvider({
      environment: 'hosted',
      method: 'federated-service-principal',
      tenantId,
      clientId,
      issuer: 'https://app.papercusp.com/oidc',
      audience: 'api://AzureADTokenExchange',
      subject: 'workspace:ws-1',
      assertionRef: 'resolver://azure/assertion/ws-1',
      clientSecret: 'forbidden',
    } as never)).toThrow('Secret-shaped field');
    expect(() => planAzureCredentialProvider({
      environment: 'hosted',
      method: 'federated-service-principal',
      tenantId,
      clientId,
      issuer: 'http://app.papercusp.com/oidc',
      audience: 'api://AzureADTokenExchange',
      subject: 'workspace:ws-1',
      assertionRef: 'resolver://azure/assertion/ws-1',
    })).toThrow('must use HTTPS');
    expect(() => buildAzureWorkspaceHostProviderConnection(request({
      credentialSource: {
        environment: 'local',
        method: 'default-credential',
        tenantId: '55555555-5555-4555-8555-555555555555',
      },
    }))).toThrow('must match the Azure credential source tenant');
  });

  it('builds a provider-neutral typed subscription connection without credential bytes', () => {
    const connection = buildAzureWorkspaceHostProviderConnection(request());
    expect(connection).toMatchObject({
      target: 'azure',
      cloudCredentialRef: { kind: 'cloud', ref: 'resolver://azure/dev' },
      scope: { kind: 'subscription', id: subscriptionId },
      provider: {
        cloud: 'AzureCloud',
        tenantId,
        resourceGroup: 'papercusp-workspaces',
        region: 'eastus2',
        vmSku: 'Standard_D4s_v5',
      },
    });
    expect(JSON.stringify(connection)).not.toMatch(/clientSecret|accessToken|password|privateKey/);
  });

  it('passes with complete identity, provider/type, RBAC, quota, SKU, and signed-image evidence', async () => {
    const report = await preflightAzureWorkspaceHostConnection(request(), client());
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.identity?.tenantId).toBe(tenantId);
    expect(report.providers).toHaveLength(4);
    expect(report.permissions).toHaveLength(AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS.length);
    expect(report.quotas).toEqual([{ ...quota, limit: 32, usage: 4, evidenceRef: 'azure://quota/standardDSv5Family' }]);
  });

  it('accepts Registering only when every required type is already available in-region', async () => {
    const report = await preflightAzureWorkspaceHostConnection(request(), client());
    expect(report.providers.find((entry) => entry.namespace === 'Microsoft.Network')?.registrationState)
      .toBe('Registering');
    expect(report.issues).not.toContainEqual(expect.objectContaining({ code: 'provider-unregistered' }));
    expect(report.issues).not.toContainEqual(expect.objectContaining({ code: 'resource-type-unavailable' }));
  });

  it('fails closed with actionable diagnostics for every onboarding evidence class', async () => {
    const report = await preflightAzureWorkspaceHostConnection(
      request(),
      client({
        async getCallerIdentity() {
          return {
            tenantId: '55555555-5555-4555-8555-555555555555',
            principalId: '66666666-6666-4666-8666-666666666666',
            principalType: 'service-principal',
            evidenceRef: 'azure://identity/wrong',
          };
        },
        async getSubscription() {
          return {
            id: '77777777-7777-4777-8777-777777777777',
            tenantId: '55555555-5555-4555-8555-555555555555',
            enabled: false,
            evidenceRef: 'azure://subscription/disabled',
          };
        },
        async getResourceGroup() {
          return {
            subscriptionId,
            name: 'missing',
            exists: false,
            evidenceRef: 'azure://resource-group/missing',
          };
        },
        async getLocation() {
          return { id: 'westus', available: false, evidenceRef: 'azure://location/unavailable' };
        },
        async getProviderRegistration(_id, namespace) {
          const evidence = providerEvidence(namespace);
          if (namespace === 'Microsoft.Compute') {
            return { ...evidence, registrationState: 'NotRegistered', resourceTypes: [] };
          }
          if (namespace === 'Microsoft.Network') {
            return { ...evidence, resourceTypes: evidence.resourceTypes.slice(0, -1) };
          }
          return evidence;
        },
        async evaluatePermissions({ actions }) {
          return actions.slice(0, -1).map((action, index) => ({
            action,
            allowed: index !== 0,
            reason: index === 0 ? 'explicit deny' : undefined,
            evidenceRef: `azure://permission/${action}`,
          }));
        },
        async getQuota(_id, _region, requirement) {
          return { ...requirement, limit: 4, usage: 4, evidenceRef: 'azure://quota/exhausted' };
        },
        async describeVmSku() {
          return {
            name: 'Standard_D4s_v5',
            region: 'westus',
            available: false,
            architecture: 'arm64',
            restrictions: ['NotAvailableForSubscription'],
            evidenceRef: 'azure://sku/unavailable',
          };
        },
        async describeImage() {
          return {
            id: 'wrong-image',
            kind: 'marketplace',
            region: 'westus',
            available: false,
            architecture: 'arm64',
            signed: false,
            evidenceRef: 'azure://image/unavailable',
          };
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(new Set(report.issues.map((issue) => issue.code))).toEqual(expect.objectContaining({}));
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'tenant-mismatch',
      'subscription-unavailable',
      'resource-group-unavailable',
      'region-unavailable',
      'provider-unregistered',
      'resource-type-unavailable',
      'permission-denied',
      'permission-unverified',
      'quota-insufficient',
      'sku-unavailable',
      'sku-architecture-mismatch',
      'image-unavailable',
      'image-region-mismatch',
      'image-architecture-mismatch',
      'image-unsigned',
    ]));
    expect(report.issues.every((issue) => issue.remediation.length > 0)).toBe(true);
  });

  it('turns Azure API failures into a red report instead of partial success', async () => {
    const report = await preflightAzureWorkspaceHostConnection(
      request(),
      client({ async getCallerIdentity() { throw new Error('Azure CLI session expired'); } }),
    );
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: 'probe-failed',
      message: expect.stringContaining('Azure CLI session expired'),
    }));
  });
});
