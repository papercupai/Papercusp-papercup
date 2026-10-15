import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS,
  runFakeWorkspaceHostProviderContractSuite,
  workspaceHostProviderRetryClass,
  type WorkspaceHostApplyResult,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderContext,
  type WorkspaceHostRef,
  type WorkspaceHostResourceRef,
} from '@papercusp/deployment-driver';
import {
  azureWorkspaceHostRequestUuid,
  azureWorkspaceHostResourceId,
  AzureOperationFailedError,
  createAzureWorkspaceHostProvider,
  type AzureArmOperationObservation,
  type AzureArmOperationRef,
  type AzureArmPutInput,
  type AzureArmResourceObservation,
  type AzureVmAction,
  type AzureVmPowerState,
  type AzureWorkspaceHostArmClient,
} from './azure-provider';

const NOW = '2026-08-22T08:00:00.000Z';
const SUBSCRIPTION_ID = '00000000-1111-2222-3333-444444444444';

function desired(): WorkspaceHostDesiredSpec {
  return {
    hostId: 'host-azure-1',
    target: 'azure',
    scope: { kind: 'subscription', id: SUBSCRIPTION_ID },
    region: 'eastus2',
    size: 'Standard_D2s_v5',
    image: {
      id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/images/providers/Microsoft.Compute/galleries/papercusp/images/ubuntu/versions/2026.08.22`,
      version: '2026.08.22',
    },
    data: { volumeGiB: 128, encrypted: true },
    credentials: {
      cloudCredentialRef: { kind: 'cloud', ref: 'resolver://azure/development' },
    },
    labels: { environment: 'test', owner: 'workspace-host-contract' },
    provider: {
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroup: { mode: 'managed', name: 'rg-papercusp-host-1' },
      network: {
        mode: 'managed',
        virtualNetworkName: 'vnet-papercusp-host-1',
        subnetName: 'subnet-papercusp-host-1',
        networkSecurityGroupName: 'nsg-papercusp-host-1',
        addressPrefixes: ['10.54.0.0/16'],
        subnetPrefix: '10.54.1.0/24',
        allowedSourceCidrs: ['10.10.0.0/16'],
        allowedTcpPorts: [22, 443],
      },
      publicIp: { mode: 'managed', name: 'pip-papercusp-host-1' },
      identity: { mode: 'managed', name: 'id-papercusp-host-1' },
      vmName: 'vm-papercusp-host-1',
      networkInterfaceName: 'nic-papercusp-host-1',
      dataDiskName: 'disk-papercusp-host-1',
      extensionName: 'papercusp-bootstrap',
      bootDiskGiB: 40,
      diskSku: 'Premium_LRS',
      diskEncryptionSetId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/security/providers/Microsoft.Compute/diskEncryptionSets/papercusp`,
      cloudInit: '#cloud-config\nruncmd:\n  - echo papercusp-bootstrap\n',
      extension: {
        publisher: 'Microsoft.Azure.Extensions',
        type: 'CustomScript',
        typeHandlerVersion: '2.1',
        settings: { commandToExecute: 'systemctl enable --now papercusp' },
      },
    },
  };
}

function context(provider: Readonly<Record<string, unknown>> = {}): WorkspaceHostProviderContext {
  return {
    workspaceId: 'workspace-azure-1',
    requestId: 'request-azure-1',
    connection: {
      target: 'azure',
      cloudCredentialRef: { kind: 'cloud', ref: 'resolver://azure/development' },
      scope: { kind: 'subscription', id: SUBSCRIPTION_ID },
      provider: { cloud: 'AzureCloud', credentialSource: 'default-credential', ...provider },
    },
  };
}

class FakeAzureWorkspaceHostArmClient implements AzureWorkspaceHostArmClient {
  readonly putCalls: Array<{ input: AzureArmPutInput; requestId: string }> = [];
  readonly deleteCalls: Array<{ resourceId: string; requestId: string }> = [];
  readonly vmActionCalls: Array<{ vmId: string; action: AzureVmAction; requestId: string }> = [];
  readonly resourceReads: string[] = [];
  readonly operationReads: string[] = [];
  readonly waitedOperations: string[] = [];

  private readonly resources = new Map<string, AzureArmResourceObservation>();
  private readonly operations = new Map<string, AzureArmOperationObservation>();

  async validateConnection() {
    return {
      ok: true,
      checkedAt: NOW,
      identity: 'entra://tenant/test/principal/operator',
      warnings: [],
      errors: [],
    };
  }

  async listScopes() {
    return [{ kind: 'subscription', id: SUBSCRIPTION_ID, label: 'Development subscription' }];
  }

  async listRegions() {
    return [{ id: 'eastus2', label: 'East US 2', available: true }];
  }

  async listSizes() {
    return [{ id: 'Standard_D2s_v5', label: 'Standard_D2s_v5', cpuCount: 2, memoryMiB: 8192, available: true }];
  }

  async listImages() {
    return [
      {
        id: desired().image.id,
        version: '2026.08.22',
        label: 'Papercusp Ubuntu 24.04',
        architecture: 'x86_64',
        signed: true,
      },
    ];
  }

  async estimatePrice() {
    return { currency: 'USD', hourlyAmount: 0.108, observedAt: NOW, confidence: 'estimated' as const };
  }

  async getResource(resourceId: string): Promise<AzureArmResourceObservation | undefined> {
    this.resourceReads.push(resourceId);
    return this.resources.get(resourceId);
  }

  async getOperation(operationId: string): Promise<AzureArmOperationObservation | undefined> {
    this.operationReads.push(operationId);
    return this.operations.get(operationId);
  }

  async putResource(input: AzureArmPutInput, requestId: string): Promise<AzureArmOperationRef> {
    this.putCalls.push({ input, requestId });
    const properties = input.properties as {
      storageProfile?: {
        imageReference?: { id?: string };
        dataDisks?: Array<{ managedDisk?: { id?: string } }>;
      };
    };
    const observation: AzureArmResourceObservation = {
      id: input.id,
      kind: input.kind,
      provisioningState: 'Succeeded',
      observedAt: NOW,
      ...(input.kind === 'vm'
        ? {
            powerState: 'running' as const,
            imageId: properties.storageProfile?.imageReference?.id,
            attachedDataDiskIds: (properties.storageProfile?.dataDisks ?? [])
              .map((disk) => disk.managedDisk?.id)
              .filter((id): id is string => !!id),
            agentOnline: true,
          }
        : {}),
    };
    this.resources.set(input.id, observation);
    return this.succeed('put', input.id, requestId);
  }

  async deleteResource(resourceId: string, requestId: string): Promise<AzureArmOperationRef> {
    this.deleteCalls.push({ resourceId, requestId });
    this.resources.delete(resourceId);
    return this.succeed('delete', resourceId, requestId);
  }

  async beginVmAction(vmId: string, action: AzureVmAction, requestId: string): Promise<AzureArmOperationRef> {
    this.vmActionCalls.push({ vmId, action, requestId });
    const vm = this.resources.get(vmId);
    if (!vm) throw new Error(`fake Azure VM '${vmId}' does not exist`);
    const powerState: AzureVmPowerState = action === 'deallocate' ? 'deallocated' : 'running';
    this.resources.set(vmId, { ...vm, powerState, agentOnline: powerState === 'running', observedAt: NOW });
    return this.succeed(`vm-${action}`, vmId, requestId);
  }

  async waitForOperation(operation: AzureArmOperationRef): Promise<AzureArmOperationObservation> {
    this.waitedOperations.push(operation.id);
    const found = this.operations.get(operation.id);
    if (!found) throw new Error(`fake Azure operation '${operation.id}' does not exist`);
    return found;
  }

  private succeed(prefix: string, resourceId: string, requestId: string): AzureArmOperationRef {
    const id = `operation:${prefix}:${this.operations.size + 1}`;
    const operation: AzureArmOperationObservation = {
      id,
      requestId,
      resourceId,
      status: 'Succeeded',
      observedAt: NOW,
    };
    this.operations.set(id, operation);
    return operation;
  }
}

function providerAndClient() {
  const client = new FakeAzureWorkspaceHostArmClient();
  const provider = createAzureWorkspaceHostProvider({ client, now: () => NOW });
  return { client, provider };
}

async function failFirstStep(error?: AzureArmOperationObservation['error']): Promise<unknown> {
  const { client, provider } = providerAndClient();
  client.waitForOperation = async (operation) => ({
    ...operation,
    status: 'Failed',
    observedAt: NOW,
    ...(error ? { error } : {}),
  });
  const plan = await provider.plan(
    { action: 'provision', operationId: 'op-fail', idempotencyKey: 'op-fail', desired: desired() },
    context(),
  );
  return provider
    .apply({ planId: plan.planId, operationId: plan.operationId, step: plan.steps[0]!, knownResources: [] }, context())
    .then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
}

function requireAppliedResource(result: WorkspaceHostApplyResult): WorkspaceHostResourceRef {
  if (!('resource' in result) || !result.resource) {
    throw new Error(`expected an applied Azure resource, received '${result.state}'`);
  }
  return result.resource;
}

async function provision(
  client: FakeAzureWorkspaceHostArmClient,
  provider: ReturnType<typeof createAzureWorkspaceHostProvider>,
): Promise<{ host: WorkspaceHostRef; resources: WorkspaceHostResourceRef[] }> {
  const plan = await provider.plan(
    { action: 'provision', operationId: 'provision-1', idempotencyKey: 'provision-1', desired: desired() },
    context(),
  );
  const resources: WorkspaceHostResourceRef[] = [];
  for (const step of plan.steps) {
    const result = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...resources] },
      context(),
    );
    if ('resource' in result && result.resource) resources.push(result.resource);
  }
  expect(client.putCalls).toHaveLength(plan.steps.length);
  return { host: { hostId: desired().hostId, target: 'azure', resources }, resources };
}

describe('Azure operation that finished with an error (WI-10005333)', () => {
  it.each([
    ['AuthorizationFailed', 403],
    ['LinkedAuthorizationFailed', 403],
    ['RequestDisallowedByPolicy', 403],
    ['InvalidTemplate', 400],
    ['InvalidTemplateDeployment', 400],
    ['InvalidParameter', 400],
    ['InvalidParameterValue', 400],
    ['InvalidRequestContent', 400],
    ['InvalidResourceReference', 400],
    ['QuotaExceeded', 400],
    ['ResourceQuotaExceeded', 400],
    ['SkuNotAvailable', 400],
  ] as const)('%s is terminal instead of reconciling forever', async (code, status) => {
    const thrown = await failFirstStep({ code, message: `ARM operation failed (${code})` });
    expect(thrown).toBeInstanceOf(AzureOperationFailedError);
    expect(thrown).toMatchObject({ status, code });
    expect(workspaceHostProviderRetryClass(thrown)).toBe('terminal');
  });

  it.each(['TooManyRequests', 'RetryableErrorDueToAnotherOperation'])(
    '%s is retryable even though the LRO has no HTTP status',
    async (code) => {
      const thrown = await failFirstStep({ code, message: `ARM operation failed (${code})` });
      expect(thrown).toBeInstanceOf(AzureOperationFailedError);
      expect(thrown).toMatchObject({ code, throttled: true });
      expect(workspaceHostProviderRetryClass(thrown)).toBe('throttled');
    },
  );

  it('leaves overlapping, unknown, and code-less failures ambiguous', async () => {
    const quotaOrThrottle = await failFirstStep({
      code: 'OperationNotAllowed',
      message: 'Operation is not currently allowed',
    });
    const unknown = await failFirstStep({ code: 'ProviderSpecificFailure', message: 'Provider failed' });
    const codeLess = await failFirstStep();
    for (const thrown of [quotaOrThrottle, unknown, codeLess]) {
      expect(thrown).toBeInstanceOf(AzureOperationFailedError);
      expect(workspaceHostProviderRetryClass(thrown)).toBe('ambiguous');
    }
  });
});

describe('Azure workspace-host provider planning', () => {
  it('lets Azure derive the default OS disk size from the source image', async () => {
    const { provider } = providerAndClient();
    const defaultDesired = desired();
    defaultDesired.provider = Object.fromEntries(
      Object.entries(defaultDesired.provider ?? {}).filter(([key]) => key !== 'bootDiskGiB'),
    );

    const plan = await provider.plan(
      {
        action: 'provision',
        operationId: 'operation-default-disk',
        idempotencyKey: 'operation-default-disk',
        desired: defaultDesired,
      },
      context(),
    );
    const vm = plan.steps.find((step) => step.id === 'create-vm')!.input as unknown as {
      request: AzureArmPutInput;
    };
    const osDisk = (vm.request.properties.storageProfile as { osDisk: Record<string, unknown> }).osDisk;

    expect(osDisk).toMatchObject({
      createOption: 'FromImage',
      managedDisk: { storageAccountType: 'Premium_LRS' },
    });
    expect(osDisk).not.toHaveProperty('diskSizeGB');
  });

  it('builds deterministic ARM ids, dependency ordering, encrypted disks, identity, NIC, image, cloud-init, and extension inputs', async () => {
    const { provider } = providerAndClient();
    const request = {
      action: 'provision' as const,
      operationId: 'operation-1',
      idempotencyKey: 'operation-1',
      desired: desired(),
    };
    const [first, replay] = await Promise.all([provider.plan(request, context()), provider.plan(request, context())]);

    expect(first.steps).toEqual(replay.steps);
    expect(first.steps.map((step) => ({ id: step.id, dependsOn: step.dependsOn }))).toEqual([
      { id: 'create-resource-group', dependsOn: [] },
      { id: 'create-virtual-network', dependsOn: ['create-resource-group'] },
      { id: 'create-network-security-group', dependsOn: ['create-resource-group'] },
      { id: 'create-subnet', dependsOn: ['create-virtual-network', 'create-network-security-group'] },
      { id: 'create-public-ip', dependsOn: ['create-resource-group'] },
      { id: 'create-managed-identity', dependsOn: ['create-resource-group'] },
      { id: 'create-data-disk', dependsOn: ['create-resource-group'] },
      {
        id: 'create-network-interface',
        dependsOn: ['create-subnet', 'create-network-security-group', 'create-public-ip'],
      },
      {
        id: 'create-vm',
        dependsOn: ['create-network-interface', 'create-managed-identity', 'create-data-disk'],
      },
      { id: 'install-vm-extension', dependsOn: ['create-vm'] },
    ]);

    const disk = first.steps.find((step) => step.id === 'create-data-disk')!.input as unknown as {
      requestId: string;
      request: AzureArmPutInput;
    };
    expect(disk.requestId).toBe(azureWorkspaceHostRequestUuid('operation-1:create-data-disk'));
    expect(disk.request.id).toBe(
      azureWorkspaceHostResourceId(
        SUBSCRIPTION_ID,
        'rg-papercusp-host-1',
        'Microsoft.Compute',
        'disks',
        'disk-papercusp-host-1',
      ),
    );
    expect(disk.request.properties).toMatchObject({
      diskSizeGB: 128,
      sku: { name: 'Premium_LRS' },
      encryption: {
        type: 'EncryptionAtRestWithCustomerKey',
        diskEncryptionSetId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/security/providers/Microsoft.Compute/diskEncryptionSets/papercusp`,
      },
    });

    const vm = first.steps.find((step) => step.id === 'create-vm')!.input as unknown as {
      request: AzureArmPutInput;
    };
    expect(vm.request.properties).toMatchObject({
      hardwareProfile: { vmSize: 'Standard_D2s_v5' },
      identity: { type: 'UserAssigned' },
      storageProfile: {
        imageReference: { id: desired().image.id },
        osDisk: {
          createOption: 'FromImage',
          diskSizeGB: 40,
          encryption: { type: 'EncryptionAtRestWithCustomerKey' },
        },
        dataDisks: [{ lun: 0, createOption: 'Attach' }],
      },
      osProfile: {
        computerName: 'vm-papercusp-host-1',
        adminUsername: 'papercusp',
        disablePasswordAuthentication: true,
        customData: Buffer.from('#cloud-config\nruncmd:\n  - echo papercusp-bootstrap\n').toString('base64'),
      },
    });
    expect(vm.request.tags).toMatchObject({
      'papercusp-host-id': 'host-azure-1',
      'papercusp-managed': 'true',
      'papercusp-workspace-id': 'workspace-azure-1',
    });
  });

  // EI-22185970114422986 — CHARACTERIZATION, NOT APPROVAL. This pins a KNOWN HAZARD so the change
  // that fixes it has to come through here and read this.
  //
  // Found by the D-238 class audit: *a step that restricts access whose surviving credential is
  // authored somewhere else, or nowhere.* The Azure create plan turns password authentication OFF
  // and authorizes no SSH public key anywhere — `osProfile` carries no
  // `linuxConfiguration.ssh.publicKeys`, and `cloudInit` is an OPTIONAL caller-supplied payload
  // with no key requirement. Apply the diagnostic — if the credential half silently did nothing,
  // would this run still report success? — and the answer here is yes: the plan succeeds and the
  // VM is unreachable, which is exactly how the GCP host bricked itself while attesting healthy.
  //
  // WHY THE GCP-SIDE FIX DOES NOT COVER THIS. `workspaceAuthorizedKeys` was made a REQUIRED field
  // on the bootstrap input precisely so other providers could not silently reproduce the lockout,
  // but that binds only callers of the BOOTSTRAP RENDER. Azure declares
  // `capabilities.lifecycle.hostBootstrap: false`, and provisioning-runner.ts consults D-241's
  // fail-closed key resolver ("controller has no identityFile, so no public key can be authorized
  // on the host") ONLY when a provider declares that capability. So Azure reaches VM creation
  // without ever passing the guard that was built to stop this.
  //
  // SUSPECTED, and NOT verifiable from this tree: ARM documents `disablePasswordAuthentication`
  // under `osProfile.linuxConfiguration`, not directly on `osProfile` as it is set here. If that
  // is right the flag is inert — the same defect pointing the other way, a security control that
  // silently does nothing. No `@azure/arm-compute` types are vendored here, so that must be
  // checked against the live API rather than asserted from the repo.
  //
  // WHEN KEY DELIVERY IS DESIGNED (P-030 / P-035): INVERT this test into a refusal, exactly as
  // D-241 did for GCP — refuse to PLAN a create that disables password authentication without
  // authorizing a key, instead of creating an unreachable VM and reporting success.
  it('authorizes no SSH key yet, so an Azure host is planned unreachable (known hazard, D-238 class)', async () => {
    const { provider } = providerAndClient();
    const plan = await provider.plan(
      {
        action: 'provision' as const,
        operationId: 'operation-1',
        idempotencyKey: 'operation-1',
        desired: desired(),
      },
      context(),
    );
    const vm = plan.steps.find((step) => step.id === 'create-vm')!.input as unknown as {
      request: AzureArmPutInput;
    };
    const osProfile = (vm.request.properties as { osProfile: Record<string, unknown> }).osProfile;
    expect(osProfile.disablePasswordAuthentication).toBe(true);
    // The hazard in one assertion: access restricted, no credential authorized anywhere in the
    // plan. When this stops being true the fix has landed — invert the test, do not delete it.
    expect(JSON.stringify(plan.steps)).not.toMatch(
      /publicKeys|ssh-ed25519|ssh-rsa|authorized_keys/,
    );
  });

  it('makes public IP optional and records existing network resources without scheduling their deletion ownership', async () => {
    const { provider } = providerAndClient();
    const existing = desired();
    existing.provider = {
      ...existing.provider,
      resourceGroup: { mode: 'existing', name: 'shared-rg' },
      network: {
        mode: 'existing',
        virtualNetworkResourceId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/shared-rg/providers/Microsoft.Network/virtualNetworks/shared-vnet`,
        subnetResourceId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/shared-rg/providers/Microsoft.Network/virtualNetworks/shared-vnet/subnets/workspaces`,
        networkSecurityGroupResourceId: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/shared-rg/providers/Microsoft.Network/networkSecurityGroups/shared-nsg`,
      },
      publicIp: { mode: 'none' },
    };
    const plan = await provider.plan(
      { action: 'provision', operationId: 'existing-1', idempotencyKey: 'existing-1', desired: existing },
      context(),
    );
    expect(plan.steps.map((step) => step.id)).toEqual(
      expect.arrayContaining([
        'record-resource-group',
        'record-virtual-network',
        'record-subnet',
        'record-network-security-group',
      ]),
    );
    expect(plan.steps.some((step) => step.resourceKind === 'public-ip')).toBe(false);
  });

  it('refuses dependent ARM calls until prerequisite resource identities are persisted', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-2', idempotencyKey: 'operation-2', desired: desired() },
      context(),
    );
    const vmStep = plan.steps.find((step) => step.id === 'create-vm')!;
    await expect(
      provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step: vmStep, knownResources: [] },
        context(),
      ),
    ).rejects.toThrow('requires a persisted network-interface resource identity');
    expect(client.putCalls).toHaveLength(0);

    const resourceGroupResult = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: [] },
      context(),
    );
    expect(requireAppliedResource(resourceGroupResult).kind).toBe('resource-group');
    expect(client.putCalls).toHaveLength(1);
  });

  it('fails closed when desired persistent storage is not encrypted', async () => {
    const { provider } = providerAndClient();
    const unencrypted = desired();
    unencrypted.data = { ...unencrypted.data, encrypted: false };
    await expect(
      provider.plan(
        {
          action: 'provision',
          operationId: 'operation-unencrypted',
          idempotencyKey: 'operation-unencrypted',
          desired: unencrypted,
        },
        context(),
      ),
    ).rejects.toThrow('OS and data disks must be encrypted');
  });
});

describe('Azure workspace-host provider contract and lifecycle', () => {
  it('declares the native-client CLI floor, Bastion SKU cost, audit limits, and large-file fallback', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);
    const profile = await provider.getTransportProfile(host, context());

    expect(profile.compatibility.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'azure-cli', minimumVersion: '2.32.0' }),
        expect.objectContaining({ id: 'azure-bastion-extension' }),
        expect.objectContaining({ id: 'azure-ssh-extension' }),
      ]),
    );
    expect(profile.compatibility.cost).toMatchObject({
      model: 'provider-metered',
      requiredSkus: ['Standard', 'Premium'],
    });
    expect(profile.compatibility.traffic['bulk-transfer']).toBe('discouraged');
    expect(profile.compatibility.audit).toMatchObject({ controlPlaneEvents: true, sessionContent: false });
    expect(profile.compatibility.fallbacks).toContainEqual(
      expect.objectContaining({ feature: 'fileTransfer', strategy: 'provider-object-storage' }),
    );
  });

  it('exposes key-backed Bastion and restricted direct SSH only when explicitly selected', async () => {
    const { client, provider } = providerAndClient();
    const { host } = await provision(client, provider);

    const bastionKey = await provider.getTransportProfile(host, context({ transportPreference: 'azure-bastion-ssh' }));
    expect(bastionKey).toMatchObject({ kind: 'azure-bastion-ssh', audited: true });
    expect(bastionKey.compatibility.requirements.map(({ id }) => id)).not.toContain('azure-ssh-extension');

    await expect(
      provider.getTransportProfile(
        host,
        context({ transportPreference: 'azure-direct-ssh', directAddress: '203.0.113.18' }),
      ),
    ).rejects.toThrow('explicit restricted source CIDR allowlist');
    const direct = await provider.getTransportProfile(
      host,
      context({
        transportPreference: 'azure-direct-ssh',
        directAddress: '203.0.113.18',
        directSshSourceRanges: ['198.51.100.42/32'],
      }),
    );
    expect(direct).toMatchObject({
      kind: 'azure-direct-ssh',
      audited: false,
      compatibility: { traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' } },
    });
  });

  it('passes the shared fake provider contract including LRO reconcile, observation, transport, and confirmed destroy', async () => {
    const { provider } = providerAndClient();
    const report = await runFakeWorkspaceHostProviderContractSuite(provider, {
      adapterKind: 'fake',
      reportRef: 'artifact://workspace-host/azure/provider-contract-1',
      context: context(),
      desired: desired(),
      operationId: 'contract-operation',
      idempotencyKey: 'contract-operation',
      confirmedBy: 'vitest',
      now: () => NOW,
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toEqual(WORKSPACE_HOST_PROVIDER_CONTRACT_CHECKS);
    expect(report.provisionedResources.map((item) => item.kind)).toEqual([
      'resource-group',
      'virtual-network',
      'network-security-group',
      'subnet',
      'public-ip',
      'managed-identity',
      'disk',
      'network-interface',
      'vm',
      'vm-extension',
    ]);
    expect(report.destroyConfirmations).toHaveLength(10);
  });

  it('uses LRO readback for lifecycle actions, snapshots and repair, then confirms every managed resource absent', async () => {
    const { client, provider } = providerAndClient();
    const { host, resources } = await provision(client, provider);
    const actions = ['stop', 'start', 'restart', 'snapshot', 'repair'] as const;
    const results: WorkspaceHostApplyResult[] = [];
    for (const action of actions) {
      const plan = await provider.plan(
        action === 'snapshot'
          ? { action, operationId: `operation:${action}`, idempotencyKey: `operation:${action}`, host, name: 'manual' }
          : { action, operationId: `operation:${action}`, idempotencyKey: `operation:${action}`, host },
        context(),
      );
      results.push(
        await provider.apply(
          { planId: plan.planId, operationId: plan.operationId, step: plan.steps[0], knownResources: resources },
          context(),
        ),
      );
    }
    expect(results.every((result) => result.state === 'applied')).toBe(true);
    expect(client.vmActionCalls.map(({ action }) => action).sort()).toEqual(
      ['deallocate', 'reapply', 'restart', 'start'].sort(),
    );

    const destroy = await provider.plan(
      {
        action: 'destroy',
        operationId: 'operation:destroy',
        idempotencyKey: 'operation:destroy',
        host,
        disposition: 'discard',
        confirmation: { expectedHostId: host.hostId, confirmedBy: 'vitest', confirmedAt: NOW },
      },
      context(),
    );
    const confirmations: string[] = [];
    for (const step of destroy.steps) {
      const result = await provider.apply(
        { planId: destroy.planId, operationId: destroy.operationId, step, knownResources: resources },
        context(),
      );
      expect(result.state).toBe('destroyed');
      if (result.state === 'destroyed') confirmations.push(result.confirmation.providerResourceId);
    }
    expect(confirmations).toHaveLength(resources.length);
    expect(client.deleteCalls).toHaveLength(resources.length);
    expect(client.resourceReads.length).toBeGreaterThan(resources.length);
  });

  it('reconciles an ambiguous VM PUT from the deterministic ARM id and completed LRO without a second mutation', async () => {
    const { client, provider } = providerAndClient();
    const plan = await provider.plan(
      { action: 'provision', operationId: 'operation-3', idempotencyKey: 'operation-3', desired: desired() },
      context(),
    );
    const resources: WorkspaceHostResourceRef[] = [];
    const vmStep = plan.steps.find((step) => step.id === 'create-vm')!;
    for (const step of plan.steps) {
      if (step.id === vmStep.id) break;
      const result = await provider.apply(
        { planId: plan.planId, operationId: plan.operationId, step, knownResources: [...resources] },
        context(),
      );
      if ('resource' in result && result.resource) resources.push(result.resource);
    }
    const applied = await provider.apply(
      { planId: plan.planId, operationId: plan.operationId, step: vmStep, knownResources: resources },
      context(),
    );
    const vmPutCount = client.putCalls.filter(({ input }) => input.kind === 'vm').length;
    const reconciled = await provider.reconcile(
      {
        planId: plan.planId,
        operationId: plan.operationId,
        step: vmStep,
        knownResources: resources,
        reason: 'ambiguous-timeout',
        previousProviderRequestId: applied.providerRequestId,
      },
      context(),
    );
    expect(reconciled.state).toBe('unchanged');
    expect('resource' in reconciled && reconciled.resource?.providerId).toBe(
      'resource' in applied ? applied.resource?.providerId : undefined,
    );
    expect(client.putCalls.filter(({ input }) => input.kind === 'vm')).toHaveLength(vmPutCount);
  });
});
