import { describe, expect, it, vi } from 'vitest';
const hostedDb = vi.hoisted(() => ({
  run: null as null | ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>),
  calls: [] as Array<{ query: string; values: unknown[] }>,
}));
const workspaceDb = vi.hoisted(() => ({
  run: null as null | ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>),
  calls: [] as Array<{ workspaceId: string; query: string; values: unknown[] }>,
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withHostedServiceContext: async (callback: (sql: unknown) => Promise<unknown>) => {
      if (!hostedDb.run) throw new Error('hosted service SQL test double was not initialized');
      return callback(hostedDb.run as never);
    },
    withWorkspace: async (workspaceId: string, callback: (query: unknown) => Promise<unknown>) => {
      const run = workspaceDb.run;
      if (!run) throw new Error('workspace SQL test double was not initialized');
      return callback(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        workspaceDb.calls.push({ workspaceId, query: strings.join(' '), values });
        return run(strings, ...values);
      });
    },
  };
});

import {
  assertWorkspaceHostSecretIsolation,
  parseWorkspaceHostCredentialReference,
  planWorkspaceHostInitialization,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import {
  enrollHostedWorkspaceConnector,
  hostedBringUpInitialization,
  hostedBringUpSupportsHost,
  hostedBringUpSupportsProvider,
  hostedConnectorRouteLabel,
  PAPERCUSP_HOSTED_BRING_UP_AGENTS,
  readHostedBringUpBinding,
  revokeHostedWorkspaceConnectorsForDestroyedHost,
  workspaceHostBringUpOperationIds,
  type HostedConnectorEnrollmentDependencies,
} from './hosted-bring-up';
import { resolveWorkspaceHostDeliveryCapabilities } from './initialization-operations-resolver';

/** The spec shape `gcpFirstWorkspaceDesiredSpec` produces for a Papercusp-hosted host. */
const HOSTED: WorkspaceHostDesiredSpec = {
  hostId: 'host-3b44551202aa97c3c3048660',
  target: 'gcp',
  scope: { kind: 'project', id: 'papercusp-hosted-workspaces' },
  region: 'us-central1',
  zone: 'us-central1-c',
  size: 'e2-standard-4',
  image: { id: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918' },
  data: { encrypted: true, volumeGiB: 100 },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'delegation://ws-3b44/conn-3b44' } },
  provider: { projectId: 'papercusp-hosted-workspaces', network: { mode: 'managed' }, provisioningModel: 'spot' },
} as WorkspaceHostDesiredSpec;

function request(desired: WorkspaceHostDesiredSpec = HOSTED) {
  return hostedBringUpInitialization({
    workspaceId: 'papercusp-workspace',
    operationId: 'prov-3b44.initialize',
    requestedAt: '2026-09-23T10:15:19.000Z',
    desired,
    requestedAgents: PAPERCUSP_HOSTED_BRING_UP_AGENTS,
  });
}

describe('hosted bring-up (D-401)', () => {
  it('builds the request that initialized a real hosted machine (op d401-probe-init-4)', () => {
    expect(request()).toMatchObject({
      hostId: HOSTED.hostId,
      source: { kind: 'empty' },
      requestedAgents: ['omp'],
      credentialRefs: {
        cloudCredentialRef: {
          kind: 'cloud',
          ref: 'pc-cloud-workload://gcp/papercusp-hosted-workspaces/host-3b44551202aa97c3c3048660',
        },
      },
      credentialDelivery: {
        cloud: {
          kind: 'provider-identity',
          generation: 1,
          audience: HOSTED.hostId,
          revocationRef: 'pc-cloud-workload-revocation://gcp/papercusp-hosted-workspaces/host-3b44551202aa97c3c3048660/g1',
        },
      },
    });
    // The machine's own identity, never the controller's connection selector or the delegation.
    expect(() =>
      parseWorkspaceHostCredentialReference(request().credentialRefs.cloudCredentialRef.ref, 'cloud'),
    ).not.toThrow();
  });

  it('is accepted by the real planner and secret-isolation check, not just shaped like it', () => {
    const admitted = {
      ...request(),
      deliveryCapabilities: resolveWorkspaceHostDeliveryCapabilities(HOSTED),
    };
    const plan = planWorkspaceHostInitialization(admitted);
    expect(plan.steps.map((step) => step.kind)).toContain('bind-credential');
    expect(() => assertWorkspaceHostSecretIsolation(admitted, 'hosted-bring-up.test')).not.toThrow();
  });

  it('never asks for agents the customer has not connected yet', () => {
    // claude/codex need the customer's own accounts (D-250); requesting them fails readiness.
    expect(PAPERCUSP_HOSTED_BRING_UP_AGENTS).toEqual(['omp']);
  });

  it('refuses a host that is neither a GCP project host nor an AWS account host', () => {
    expect(() => request({ ...HOSTED, scope: { kind: 'organization', id: 'org-1' } } as never)).toThrow(
      /GCP project and AWS account hosts only/,
    );
    expect(() => request({ ...HOSTED, target: 'aws', scope: { kind: 'project', id: 'p' } } as never)).toThrow(
      /GCP project and AWS account hosts only/,
    );
    expect(() => request({ ...HOSTED, target: 'azure', scope: { kind: 'subscription', id: 's' } } as never)).toThrow(
      /GCP project and AWS account hosts only/,
    );
  });

  // aws-byoc-gcp-parity D-015 rule 3 (WI-10005354): an EC2 instance's instance profile is its
  // provider identity, exactly as a GCP VM's service account is.
  const AWS_HOST = {
    ...HOSTED,
    hostId: 'host-aws-0f9b1ba8db30d143',
    target: 'aws',
    scope: { kind: 'account', id: '123456789012' },
    region: 'us-east-2',
    zone: 'us-east-2a',
    size: 't3.large',
    image: { id: 'ami-0123456789abcdef0' },
    provider: { network: { mode: 'managed' } },
  } as unknown as WorkspaceHostDesiredSpec;

  it("builds an AWS account host's request from its instance profile identity", () => {
    expect(request(AWS_HOST)).toMatchObject({
      hostId: AWS_HOST.hostId,
      source: { kind: 'empty' },
      requestedAgents: ['omp'],
      credentialRefs: {
        cloudCredentialRef: { kind: 'cloud', ref: 'pc-cloud-workload://aws/123456789012/host-aws-0f9b1ba8db30d143' },
      },
      credentialDelivery: {
        cloud: {
          kind: 'provider-identity',
          generation: 1,
          audience: AWS_HOST.hostId,
          revocationRef: 'pc-cloud-workload-revocation://aws/123456789012/host-aws-0f9b1ba8db30d143/g1',
        },
      },
    });
    const admitted = { ...request(AWS_HOST), deliveryCapabilities: resolveWorkspaceHostDeliveryCapabilities(AWS_HOST) };
    expect(planWorkspaceHostInitialization(admitted).steps.map((step) => step.kind)).toContain('bind-credential');
    expect(() => assertWorkspaceHostSecretIsolation(admitted, 'hosted-bring-up.test.aws')).not.toThrow();
  });

  it('answers both doors from one table: GCP and AWS have a bring-up, nothing else does', () => {
    expect(hostedBringUpSupportsProvider('gcp')).toBe(true);
    expect(hostedBringUpSupportsProvider('aws')).toBe(true);
    for (const other of ['azure', 'toString', '__proto__', '']) expect(hostedBringUpSupportsProvider(other)).toBe(false);
    expect(hostedBringUpSupportsHost(HOSTED)).toBe(true);
    expect(hostedBringUpSupportsHost(AWS_HOST)).toBe(true);
    expect(hostedBringUpSupportsHost({ ...AWS_HOST, scope: { kind: 'project', id: 'p' } } as never)).toBe(false);
  });

  it('derives one stable, routable operation per stage from the provision', () => {
    const ids = workspaceHostBringUpOperationIds('prov-3b44551202aa97c3c3048660');
    expect(ids).toEqual({
      initialize: 'prov-3b44551202aa97c3c3048660.initialize',
      desktopPack: 'prov-3b44551202aa97c3c3048660.desktop-pack',
      connector: 'prov-3b44551202aa97c3c3048660.connector',
    });
    // The initialize/desktop-pack admission guard for operation ids.
    for (const id of Object.values(ids)) expect(id).toMatch(/^[a-z0-9][a-z0-9._:-]{0,159}$/i);
  });
});

describe('hosted bring-up binding (D-407, aws-byoc-gcp-parity D-016 rule c)', () => {
  const HOST = 'host-0f9b1ba8db30d143becc130a';
  const read = () => readHostedBringUpBinding({ controlPlaneWorkspaceId: 'papercusp-workspace', hostId: HOST });

  function connectors(rows: Array<{ customer_workspace_id: string }>) {
    hostedDb.calls = [];
    hostedDb.run = async (strings, ...values) => {
      const query = strings.join(' ');
      hostedDb.calls.push({ query, values });
      if (query.includes('FROM papercusp_auth.hosted_workspace_connectors')) return rows;
      throw new Error(`unexpected hosted connector SQL: ${query}`);
    };
  }

  /** A customer_workspaces double that applies the reader's own predicates to the rows it holds. */
  function customerWorkspaces(rows: Array<{ id: string; kind: string; state: string; workspace_host_id: string }>) {
    workspaceDb.calls = [];
    workspaceDb.run = async (strings) => {
      const query = strings.join(' ');
      if (!query.includes('FROM harness_shared.customer_workspaces')) {
        throw new Error(`unexpected workspace SQL: ${query}`);
      }
      // The predicates the fallback must carry; a reader that drops one would match these rows.
      const requiresHosted = /kind = 'hosted'/.test(query);
      const requiresProvisioning = /state = 'provisioning'/.test(query);
      return rows
        .filter((row) => row.workspace_host_id === HOST)
        .filter((row) => !requiresHosted || row.kind === 'hosted')
        .filter((row) => !requiresProvisioning || row.state === 'provisioning')
        .map((row) => ({ id: row.id }));
    };
  }

  it('reads the connector enrollment first and never consults the workspace binding', async () => {
    connectors([{ customer_workspace_id: 'ws-enrolled' }]);
    customerWorkspaces([{ id: 'ws-other', kind: 'hosted', state: 'provisioning', workspace_host_id: HOST }]);
    await expect(read()).resolves.toEqual({ customerWorkspaceId: 'ws-enrolled' });
    expect(workspaceDb.calls).toHaveLength(0);
  });

  it('still refuses a host with live connectors for more than one customer workspace', async () => {
    connectors([{ customer_workspace_id: 'ws-a' }, { customer_workspace_id: 'ws-b' }]);
    customerWorkspaces([]);
    await expect(read()).rejects.toThrow(/live connectors for 2 customer workspaces/);
  });

  it('falls back to a portal workspace that is still provisioning (the canary state)', async () => {
    connectors([]);
    customerWorkspaces([
      { id: 'ws-0f9b1ba8db30d143becc130a', kind: 'hosted', state: 'provisioning', workspace_host_id: HOST },
    ]);
    await expect(read()).resolves.toEqual({ customerWorkspaceId: 'ws-0f9b1ba8db30d143becc130a' });
    expect(workspaceDb.calls[0]).toMatchObject({
      workspaceId: 'papercusp-workspace',
      values: expect.arrayContaining(['papercusp-workspace', HOST]),
    });
  });

  it.each(['active', 'suspended', 'offboarded', 'deleted'])(
    'does not bind a portal workspace that is %s: an empty-source initialize must never run against it',
    async (state) => {
      connectors([]);
      customerWorkspaces([{ id: 'ws-served', kind: 'hosted', state, workspace_host_id: HOST }]);
      await expect(read()).resolves.toBeNull();
    },
  );

  it('does not bind a customer workspace that is not a portal (hosted) workspace', async () => {
    connectors([]);
    customerWorkspaces([{ id: 'ws-local', kind: 'byoc', state: 'provisioning', workspace_host_id: HOST }]);
    await expect(read()).resolves.toBeNull();
  });

  it('returns null for a desktop/local host with neither binding', async () => {
    connectors([]);
    customerWorkspaces([]);
    await expect(read()).resolves.toBeNull();
  });

  it('refuses a host bound to more than one provisioning portal workspace', async () => {
    connectors([]);
    customerWorkspaces([
      { id: 'ws-a', kind: 'hosted', state: 'provisioning', workspace_host_id: HOST },
      { id: 'ws-b', kind: 'hosted', state: 'provisioning', workspace_host_id: HOST },
    ]);
    await expect(read()).rejects.toThrow(/bound to 2 provisioning customer workspaces/);
  });
});

describe('hosted workspace offboarding connector cleanup', () => {
  it('selects connector bindings by host and revokes the persisted credential', async () => {
    const binding = {
      control_workspace_id: 'papercusp-workspace',
      organization_id: 'org-1',
      customer_workspace_id: 'customer-ws-1',
      host_id: 'host-1',
      route_label: 'alpha',
      generation: 4,
      transport: 'websocket' as const,
      state: 'active' as const,
    };
    hostedDb.calls = [];
    hostedDb.run = async (strings, ...values) => {
      const query = strings.join(' ');
      hostedDb.calls.push({ query, values });
      if (query.includes('SELECT control_workspace_id')) return [binding];
      if (query.includes("SET state='revoked'")) return [{ ...binding, state: 'revoked' }];
      throw new Error(`unexpected hosted connector SQL: ${query}`);
    };

    await revokeHostedWorkspaceConnectorsForDestroyedHost({
      controlPlaneWorkspaceId: 'papercusp-workspace',
      hostId: 'host-1',
    });

    expect(hostedDb.calls).toHaveLength(2);
    expect(hostedDb.calls[0]).toMatchObject({
      query: expect.stringContaining('FROM papercusp_auth.hosted_workspace_connectors'),
      values: expect.arrayContaining(['papercusp-workspace', 'host-1']),
    });
    expect(hostedDb.calls[1]).toMatchObject({
      query: expect.stringContaining("SET state='revoked'"),
      values: expect.arrayContaining(['papercusp-workspace', 'org-1', 'customer-ws-1', 'host-1', 'alpha']),
    });
  });
});

describe('hosted desktop connector enrollment (D-403)', () => {
  const TICKET = `ht_${'T'.repeat(43)}`;
  const INPUT = {
    controlPlaneWorkspaceId: 'papercusp-workspace',
    customerWorkspaceId: 'ws-2f6a4b0c6dc222d8d20766ae',
    hostId: 'host-2f6a4b0c6dc222d8d20766ae',
    operationId: 'prov-2f6a.connector',
  };

  function dependencies(overrides: Partial<HostedConnectorEnrollmentDependencies> = {}) {
    const calls = {
      enroll: [] as unknown[],
      delivered: [] as unknown[],
      updates: [] as Array<Record<string, unknown>>,
      events: [] as Array<Record<string, unknown>>,
      signals: [] as Array<Record<string, unknown>>,
    };
    const deps: HostedConnectorEnrollmentDependencies = {
      readOrganizationId: async () => 'org-1',
      gateway: {
        enroll: async (binding) => {
          calls.enroll.push(binding);
          return {
            ticket: TICKET,
            binding: { ...binding, generation: 4, state: 'pending', kind: 'enrollment', audience: 'connector-register', expiresAt: new Date() },
          };
        },
      },
      deliverTicket: async (input) => {
        calls.delivered.push(input);
        return { generation: 4 };
      },
      beginOperation: async () => {},
      updateOperation: async (update) => {
        calls.updates.push({ ...update });
      },
      appendEvent: async (event) => {
        calls.events.push({ ...event });
        return 'event-1';
      },
      recordSignals: async (signals) => {
        calls.signals.push({ ...signals });
      },
      ...overrides,
    };
    return { deps, calls };
  }

  it('enrolls the bound organization + workspace + host and hands only the ticket to the host', async () => {
    const { deps, calls } = dependencies();
    await expect(enrollHostedWorkspaceConnector(INPUT, deps)).resolves.toEqual({
      generation: 4,
      routeLabel: 'host-2f6a4b0c6dc222d8d20766ae',
    });
    expect(calls.enroll).toEqual([{
      controlPlaneWorkspaceId: 'papercusp-workspace',
      organizationId: 'org-1',
      customerWorkspaceId: 'ws-2f6a4b0c6dc222d8d20766ae',
      hostId: 'host-2f6a4b0c6dc222d8d20766ae',
      routeLabel: 'host-2f6a4b0c6dc222d8d20766ae',
      transport: 'websocket',
    }]);
    expect(calls.delivered).toEqual([{ workspaceId: 'papercusp-workspace', hostId: INPUT.hostId, ticket: TICKET }]);
    expect(calls.updates.at(-1)).toMatchObject({ operationId: INPUT.operationId, status: 'succeeded' });
    // Published in the shape the desktop surface's readHostedWorkspaceConnector reads
    // (apps/operator/app/cloud-workspaces/hosted-workspace-session-protocol.ts).
    expect(calls.signals).toEqual([{
      workspaceId: 'papercusp-workspace',
      hostId: INPUT.hostId,
      tunnelStatus: { hostedConnector: { routeLabel: INPUT.hostId, transport: 'websocket', generation: 4 } },
    }]);
    // Nothing persisted by this stage carries the ticket.
    expect(JSON.stringify([calls.updates, calls.events, calls.signals])).not.toContain(TICKET);
  });

  it('publishes nothing when the host did not register', async () => {
    const { deps, calls } = dependencies({ deliverTicket: async () => { throw new Error('exit 69'); } });
    await expect(enrollHostedWorkspaceConnector(INPUT, deps)).rejects.toThrow('exit 69');
    expect(calls.signals).toEqual([]);
  });

  it('fails the stage when the host registered a different generation than was enrolled', async () => {
    const { deps, calls } = dependencies({ deliverTicket: async () => ({ generation: 3 }) });
    await expect(enrollHostedWorkspaceConnector(INPUT, deps)).rejects.toThrow(/registered connector generation 3/);
    expect(calls.updates.at(-1)).toMatchObject({ operationId: INPUT.operationId, status: 'failed' });
  });

  it('records the host-side refusal on the stage operation and rethrows it', async () => {
    const refusal = new Error('connector enrollment failed with exit 77: refused the ticket (HTTP 401)');
    const { deps, calls } = dependencies({ deliverTicket: async () => { throw refusal; } });
    await expect(enrollHostedWorkspaceConnector(INPUT, deps)).rejects.toBe(refusal);
    expect(calls.updates.at(-1)).toMatchObject({ status: 'failed', error: refusal.message });
    expect(JSON.stringify(calls.updates)).not.toContain(TICKET);
  });

  it('uses the host id as the route label and refuses one that is not a DNS label', () => {
    expect(hostedConnectorRouteLabel('Host-ABC')).toBe('host-abc');
    expect(() => hostedConnectorRouteLabel('host_1')).toThrow(/route label/);
    expect(() => hostedConnectorRouteLabel(`h${'x'.repeat(63)}`)).toThrow(/route label/);
  });
});
