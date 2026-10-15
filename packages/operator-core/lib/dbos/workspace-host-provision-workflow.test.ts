import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  _resetWorkspaceHostProvidersForTests,
  registerWorkspaceHostProvider,
  WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';

const control = vi.hoisted(() => ({
  dedupConflict: false,
  resultError: null as unknown,
  storedInput: null as unknown,
  getResult: vi.fn(),
  /** Simulates `DBOS.getResult` timing out: the workflow is still queued or running. */
  admissionPending: false,
  getResultOptions: null as unknown,
  lastStarted: null as null | (() => Promise<unknown>),
  runInitialization: vi.fn(),
  runDesktopPack: vi.fn(),
  prepareInitialization: vi.fn(),
  activateCustomerWorkspace: vi.fn(),
  retireCustomerWorkspace: vi.fn(),
  enrollConnector: vi.fn(),
  readHostedBinding: vi.fn(),
  readDestroyTarget: vi.fn(),
  runLifecycle: vi.fn(),
  startOptions: null as null | Record<string, unknown>,
  stepOptions: null as null | Record<string, unknown>,
  /**
   * Options captured PER STEP NAME. `stepOptions` alone is last-wins, so it silently starts
   * describing a different step the moment the workflow gains one — which is exactly what happened
   * when the terminal-failure recorder (WI-10001739) was added after the provisioning step.
   */
  stepOptionsByName: {} as Record<string, Record<string, unknown>>,
  /** Every step invocation, by name — how we prove a retry did NOT consume a step attempt. */
  stepCalls: [] as string[],
  sleep: vi.fn(async (_ms: number) => {}),
  provider: { target: 'gcp' },
  runDestroy: vi.fn(),
  runProvisioning: vi.fn(),
  recordTerminalFailure: vi.fn(async (_input: unknown) => true),
}));

vi.mock('../workspace-host/initialization-admission', () => ({
  executeAdmittedWorkspaceHostInitialization: control.runInitialization,
  executeAdmittedWorkspaceHostDesktopPack: control.runDesktopPack,
  prepareWorkspaceHostInitialization: control.prepareInitialization,
}));

// The request builder stays REAL; only the database write is replaced.
vi.mock('../workspace-host/hosted-bring-up', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-host/hosted-bring-up')>()),
  activateHostedCustomerWorkspace: control.activateCustomerWorkspace,
  retireHostedCustomerWorkspaceAfterDestroy: control.retireCustomerWorkspace,
  enrollHostedWorkspaceConnector: control.enrollConnector,
  readHostedBringUpBinding: control.readHostedBinding,
}));

vi.mock('../workspace-host/lifecycle-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-host/lifecycle-runner')>()),
  runWorkspaceHostLifecycle: control.runLifecycle,
}));

vi.mock('../workspace-host/provisioning-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace-host/provisioning-runner')>();
  return {
    ...actual,
    runWorkspaceHostDestroy: control.runDestroy,
    runWorkspaceHostProvisioning: control.runProvisioning,
  };
});

// Without this the workflow's terminal-failure recorder would reach the real store — i.e. a unit
// test opening a database connection, whose failure the recorder's own guard swallows.
vi.mock('../workspace-host/observability-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-host/observability-store')>()),
  recordWorkspaceHostOperationTerminalFailure: control.recordTerminalFailure,
  readWorkspaceHostDestroyTarget: control.readDestroyTarget,
}));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  }
  return {
    WorkflowQueue,
    DBOS: {
      runStep: (run: () => unknown, options: Record<string, unknown>) => {
        control.stepOptions = options;
        if (typeof options?.name === 'string') {
          control.stepOptionsByName[options.name] = options;
          control.stepCalls.push(options.name);
        }
        return run();
      },
      sleep: control.sleep,
      registerWorkflow: (implementation: unknown) => implementation,
      getResult: (_workflowId: string, options: unknown) => {
        control.getResult();
        control.getResultOptions = options;
        if (control.admissionPending) return Promise.resolve(null);
        return control.lastStarted!();
      },
      startWorkflow:
        (workflow: (input: unknown) => Promise<unknown>, options: Record<string, unknown>) => (input: unknown) => {
          control.startOptions = options;
          if (control.dedupConflict) {
            return Promise.reject(Object.assign(new Error('duplicate'), { dbosErrorCode: 28 }));
          }
          control.lastStarted = () =>
            control.resultError === null ? workflow(input) : Promise.reject(control.resultError);
          return Promise.resolve({
            getWorkflowInputs: async () => [control.storedInput ?? input],
            getResult: () => {
              control.getResult();
              return control.resultError === null ? workflow(input) : Promise.reject(control.resultError);
            },
          });
        },
    },
  };
});

import {
  setWorkspaceHostProvisioningExecutor,
  startWorkspaceHostDestroyWorkflow,
  startWorkspaceHostLifecycleWorkflow,
  startWorkspaceHostProvisioningWorkflow,
  startWorkspaceHostInitializationWorkflow,
  startWorkspaceHostDesktopPackWorkflow,
  workspaceHostProvisioningWorkflow,
  WorkspaceHostOperationIdentityConflictError,
  WorkspaceHostProvisioningConflictError,
} from './workspace-host-provision-workflow';
import {
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
} from '../workspace-host/provisioning-runner';
import { WorkspaceHostControllerFenceError } from '../workspace-host/observability-store';

const desired: WorkspaceHostDesiredSpec = {
  hostId: 'host-1',
  target: 'gcp',
  scope: { kind: 'project', id: 'project-1' },
  region: 'us-central1',
  zone: 'us-central1-a',
  size: 'e2-small',
  image: { id: 'projects/images/global/images/papercusp-v1' },
  data: { volumeGiB: 20, encrypted: true },
  credentials: { cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' } },
};
const connection: WorkspaceHostProviderConnection = {
  target: 'gcp',
  cloudCredentialRef: { kind: 'cloud', ref: 'adc://controller' },
  scope: desired.scope,
};
const input = {
  workspaceId: 'ws-1',
  connectionId: 'connection-1',
  name: 'Host',
  desired,
  connection,
  operationId: 'op-1',
};
const plan = {
  planId: 'plan-1',
  operationId: 'op-1',
  target: 'gcp',
  hostId: 'host-1',
  generatedAt: '2026-08-25T00:00:00Z',
  steps: [],
  warnings: [],
};

beforeEach(() => {
  control.dedupConflict = false;
  control.resultError = null;
  control.storedInput = null;
  control.admissionPending = false;
  control.getResultOptions = null;
  control.lastStarted = null;
  control.getResult.mockClear();
  control.runInitialization.mockReset();
  control.runDesktopPack.mockReset();
  control.prepareInitialization.mockReset();
  control.activateCustomerWorkspace.mockReset();
  control.retireCustomerWorkspace.mockReset();
  control.readHostedBinding.mockReset();
  control.readDestroyTarget.mockReset();
  control.runLifecycle.mockReset();
  control.startOptions = null;
  control.stepOptions = null;
  control.stepOptionsByName = {};
  control.stepCalls = [];
  control.recordTerminalFailure.mockReset().mockResolvedValue(true);
  control.sleep.mockClear();
  _resetWorkspaceHostProvidersForTests();
  registerWorkspaceHostProvider(control.provider as never);
  control.runProvisioning.mockReset();
  control.runDestroy.mockReset();
});

afterEach(() => {
  setWorkspaceHostProvisioningExecutor(null);
});

describe('workspace-host provisioning DBOS admission', () => {
  const initialization = {
    contractVersion: 'papercusp-workspace-host-initialization-v1' as const,
    workspaceId: 'ws-1', hostId: 'host-1', operationId: 'init-1',
    requestedAt: '2026-09-19T00:00:00Z', source: { kind: 'empty' as const },
    credentialRefs: { cloudCredentialRef: { kind: 'cloud' as const, ref: 'cloud-resolver:v1' } },
    credentialDelivery: { cloud: { kind: 'provider-identity' as const, generation: 1, audience: 'host-1', revocationRef: 'revoke-cloud-1' } },
    deliveryCapabilities: { fileTransfer: true },
  };

  it('returns durable initialization acceptance without waiting for remote execution', async () => {
    control.resultError = new Error('getResult must not be called');
    expect(await startWorkspaceHostInitializationWorkflow(initialization)).toMatchObject({ status: 'accepted', operationId: 'init-1' });
    expect(control.getResult).not.toHaveBeenCalled();
    expect(control.runInitialization).not.toHaveBeenCalled();
    expect(control.startOptions).toMatchObject({
      workflowID: 'workspace-host:ws-1:host-1:operation:init-1', queueName: 'workspace-host-provision',
      enqueueOptions: { deduplicationID: 'workspace-host:ws-1:host-1' },
    });
  });

  it('admits the typed desktop pack through the same host queue and executes its separate action', async () => {
    const request = { workspaceId: 'ws-1', hostId: 'host-1', operationId: 'pack-1', requestedAt: initialization.requestedAt, action: 'install-desktop-pack' as const };
    await expect(startWorkspaceHostDesktopPackWorkflow(request)).resolves.toMatchObject({ status: 'accepted', operationId: 'pack-1' });
    expect(control.getResult).not.toHaveBeenCalled();
    expect(control.startOptions).toMatchObject({ enqueueOptions: { deduplicationID: 'workspace-host:ws-1:host-1' } });
    control.runDesktopPack.mockResolvedValueOnce({ status: 'succeeded', hostId: 'host-1', operationId: 'pack-1' });
    await workspaceHostProvisioningWorkflow(request);
    expect(control.runDesktopPack).toHaveBeenCalledWith(request);
    expect(control.runInitialization).not.toHaveBeenCalled();
  });

  it('reuses the original request on retry and refuses materially different inputs', async () => {
    control.storedInput = { ...initialization, action: 'initialize', requestedAt: '2026-09-18T00:00:00Z' };
    await expect(startWorkspaceHostInitializationWorkflow(initialization)).resolves.toMatchObject({ status: 'accepted' });
    await expect(startWorkspaceHostInitializationWorkflow({ ...initialization, requestedAgents: ['omp'] })).rejects.toBeInstanceOf(WorkspaceHostOperationIdentityConflictError);
    control.storedInput = { ...input, action: 'provision' };
    await expect(startWorkspaceHostInitializationWorkflow(initialization)).rejects.toBeInstanceOf(WorkspaceHostOperationIdentityConflictError);
  });

  it('shares host exclusion with provision/destroy and records failures before remote readiness', async () => {
    control.dedupConflict = true;
    await expect(startWorkspaceHostInitializationWorkflow(initialization)).rejects.toBeInstanceOf(WorkspaceHostProvisioningConflictError);
    control.dedupConflict = false;
    const failure = new Error('host key discovery failed');
    control.runInitialization.mockRejectedValueOnce(failure);
    await expect(workspaceHostProvisioningWorkflow({ ...initialization, action: 'initialize' })).rejects.toBe(failure);
    expect(control.recordTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'init-1', error: failure }));
  });

  describe('hosted bring-up after the machine is built (D-401)', () => {
    const bringUp = { customerWorkspaceId: 'customer-ws-1', requestedAgents: ['omp'] as const };
    const provisioned = { status: 'succeeded' as const, operationId: 'op-1', hostId: 'host-1', plan, checkpoints: [] };

    function recordOrder() {
      const order: string[] = [];
      control.prepareInitialization.mockImplementation(async (request: Record<string, unknown>) => {
        order.push('admit-initialize');
        return { ...request, deliveryCapabilities: { fileTransfer: true } };
      });
      control.runInitialization.mockImplementation(async (request: { operationId: string }) => {
        order.push('initialize');
        return { status: 'succeeded', operationId: request.operationId, hostId: 'host-1' };
      });
      control.runDesktopPack.mockImplementation(async (request: { operationId: string }) => {
        order.push('desktop-pack');
        return { status: 'succeeded', operationId: request.operationId, hostId: 'host-1' };
      });
      control.enrollConnector.mockImplementation(async () => {
        order.push('connector');
        return { generation: 1, routeLabel: 'host-1' };
      });
      control.activateCustomerWorkspace.mockImplementation(async () => {
        order.push('activate');
        return { state: 'active' };
      });
      return order;
    }

    it('initializes, installs the desktop, connects it, then marks the workspace active, each under its own operation', async () => {
      const order = recordOrder();
      control.runProvisioning.mockResolvedValueOnce(provisioned);

      await expect(workspaceHostProvisioningWorkflow({ ...input, action: 'provision', bringUp })).resolves.toMatchObject({
        status: 'succeeded',
        operationId: 'op-1',
      });

      expect(order).toEqual(['admit-initialize', 'initialize', 'desktop-pack', 'connector', 'activate']);
      // D-403: the connector stage gets its own operation and the same wide retry budget.
      expect(control.enrollConnector).toHaveBeenCalledWith({
        controlPlaneWorkspaceId: 'ws-1',
        customerWorkspaceId: 'customer-ws-1',
        hostId: 'host-1',
        operationId: 'op-1.connector',
      });
      expect(control.stepOptionsByName['workspace-host-bring-up-connector']).toMatchObject({
        maxAttempts: 5,
        intervalSeconds: 10,
        backoffRate: 2,
      });
      // Built on the server from the host's own spec: an empty workspace, the machine's own
      // identity, and only the agent that needs no customer account.
      expect(control.prepareInitialization).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-1',
        hostId: 'host-1',
        operationId: 'op-1.initialize',
        source: { kind: 'empty' },
        requestedAgents: ['omp'],
        credentialRefs: { cloudCredentialRef: { kind: 'cloud', ref: 'pc-cloud-workload://gcp/project-1/host-1' } },
      }));
      expect(control.runInitialization).toHaveBeenCalledWith(expect.objectContaining({
        action: 'initialize',
        operationId: 'op-1.initialize',
        deliveryCapabilities: { fileTransfer: true },
      }));
      expect(control.runDesktopPack).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        hostId: 'host-1',
        operationId: 'op-1.desktop-pack',
        requestedAt: expect.any(String),
        action: 'install-desktop-pack',
      });
      expect(control.activateCustomerWorkspace).toHaveBeenCalledWith({
        controlPlaneWorkspaceId: 'ws-1',
        customerWorkspaceId: 'customer-ws-1',
        hostId: 'host-1',
      });
      // A machine fresh out of first boot gets a wider retry budget than an ordinary operation
      // (measured: the first local-inference check failed, the retry passed).
      const bringUpRetry = { maxAttempts: 5, intervalSeconds: 10, backoffRate: 2 };
      expect(control.stepOptionsByName['workspace-host-initialize-0']).toMatchObject(bringUpRetry);
      expect(control.stepOptionsByName['workspace-host-install-desktop-pack-0']).toMatchObject(bringUpRetry);
      expect(control.stepOptionsByName['workspace-host-provision-0']).toMatchObject({ maxAttempts: 3, intervalSeconds: 2 });
      expect(control.stepOptionsByName['workspace-host-provision-0']).not.toHaveProperty('backoffRate');
      // Admission and its timestamps are steps, so a replay reuses what was admitted.
      expect(control.stepCalls).toEqual(expect.arrayContaining([
        'workspace-host-bring-up-admit-initialize',
        'workspace-host-bring-up-admit-desktop-pack',
        'workspace-host-bring-up-activate',
      ]));
    });

    it('leaves an ordinary provision at the machine, exactly as before', async () => {
      const order = recordOrder();
      control.runProvisioning.mockResolvedValueOnce(provisioned);
      await workspaceHostProvisioningWorkflow({ ...input, action: 'provision' });
      expect(order).toEqual([]);
    });

    it('does not set up a machine whose provision failed', async () => {
      const order = recordOrder();
      control.runProvisioning.mockResolvedValueOnce({ ...provisioned, status: 'failed' });
      await workspaceHostProvisioningWorkflow({ ...input, action: 'provision', bringUp });
      expect(order).toEqual([]);
    });

    it('records a failed stage on THAT stage, stops the chain, and leaves the built machine succeeded', async () => {
      const order = recordOrder();
      const failure = new Error('agent readiness did not pass for: omp');
      control.runInitialization.mockRejectedValue(failure);
      control.runProvisioning.mockResolvedValueOnce(provisioned);

      await expect(workspaceHostProvisioningWorkflow({ ...input, action: 'provision', bringUp })).rejects.toBe(failure);

      expect(control.recordTerminalFailure).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: 'op-1.initialize', error: failure }),
      );
      expect(control.recordTerminalFailure).not.toHaveBeenCalledWith(expect.objectContaining({ operationId: 'op-1' }));
      expect(order).toEqual(['admit-initialize']);
      expect(control.runDesktopPack).not.toHaveBeenCalled();
      expect(control.activateCustomerWorkspace).not.toHaveBeenCalled();
    });

    it('does not mark the workspace active when its desktop could not be connected', async () => {
      const order = recordOrder();
      const failure = new Error('connector enrollment failed with exit 77');
      control.enrollConnector.mockRejectedValue(failure);
      control.runProvisioning.mockResolvedValueOnce(provisioned);

      await expect(workspaceHostProvisioningWorkflow({ ...input, action: 'provision', bringUp })).rejects.toBe(failure);

      expect(order).toEqual(['admit-initialize', 'initialize', 'desktop-pack']);
      expect(control.activateCustomerWorkspace).not.toHaveBeenCalled();
    });

    describe('after an upgrade or repair of the machine (D-407)', () => {
      const lifecycle = { workspaceId: 'ws-1', hostId: 'host-1', connection: input.connection, operationId: 'op-up' };
      const lifecycleDone = {
        status: 'succeeded' as const,
        operationId: 'op-up',
        hostId: 'host-1',
        plan,
        checkpoints: [],
        requiresInitialization: true,
      };

      beforeEach(() => {
        control.readDestroyTarget.mockResolvedValue({ desired: input.desired });
      });

      it.each(['upgrade', 'repair'] as const)(
        'brings a hosted machine up again after %s, under that operation and from its recorded spec',
        async (action) => {
          const order = recordOrder();
          control.runLifecycle.mockResolvedValueOnce(lifecycleDone);
          control.readHostedBinding.mockResolvedValueOnce({ customerWorkspaceId: 'customer-ws-1' });

          await expect(workspaceHostProvisioningWorkflow({ ...lifecycle, action })).resolves.toMatchObject({
            status: 'succeeded',
            operationId: 'op-up',
          });

          expect(order).toEqual(['admit-initialize', 'initialize', 'desktop-pack', 'connector', 'activate']);
          expect(control.readHostedBinding).toHaveBeenCalledWith({ controlPlaneWorkspaceId: 'ws-1', hostId: 'host-1' });
          expect(control.readDestroyTarget).toHaveBeenCalledWith('ws-1', 'host-1');
          expect(control.prepareInitialization).toHaveBeenCalledWith(expect.objectContaining({
            workspaceId: 'ws-1',
            hostId: 'host-1',
            operationId: 'op-up.initialize',
          }));
          expect(control.enrollConnector).toHaveBeenCalledWith({
            controlPlaneWorkspaceId: 'ws-1',
            customerWorkspaceId: 'customer-ws-1',
            hostId: 'host-1',
            operationId: 'op-up.connector',
          });
        },
      );

      it('leaves a BYOC machine to its owner: no live connector enrollment, no bring-up', async () => {
        const order = recordOrder();
        control.runLifecycle.mockResolvedValueOnce(lifecycleDone);
        control.readHostedBinding.mockResolvedValueOnce(null);

        await workspaceHostProvisioningWorkflow({ ...lifecycle, action: 'upgrade' });

        expect(order).toEqual([]);
        expect(control.readDestroyTarget).not.toHaveBeenCalled();
      });

      it('leaves a hosted machine alone after actions that keep its setup and an upgrade without a completed rollback', async () => {
        const order = recordOrder();
        control.readHostedBinding.mockResolvedValue({ customerWorkspaceId: 'customer-ws-1' });
        for (const action of ['start', 'stop', 'restart', 'snapshot'] as const) {
          control.runLifecycle.mockResolvedValueOnce({
            ...lifecycleDone,
            operationId: `op-${action}`,
            requiresInitialization: false,
          });
          await workspaceHostProvisioningWorkflow({ ...lifecycle, operationId: `op-${action}`, action });
        }
        // A failed upgrade that did not complete its rollback has no requiresInitialization signal.
        control.runLifecycle.mockResolvedValueOnce({
          status: 'failed',
          operationId: 'op-up',
          hostId: 'host-1',
          plan,
          checkpoints: [],
        });
        await workspaceHostProvisioningWorkflow({ ...lifecycle, action: 'upgrade' }).catch(() => undefined);

        expect(control.runLifecycle).toHaveBeenCalledTimes(5);
        expect(order).toEqual([]);
        expect(control.readHostedBinding).not.toHaveBeenCalled();
      });

      it('re-runs hosted bring-up after an upgrade rollback recreated the machine', async () => {
        const order = recordOrder();
        control.runLifecycle.mockResolvedValueOnce({
          ...lifecycleDone,
          status: 'failed',
          rollback: { stepId: 'create-boot-runtime', status: 'succeeded' },
        });
        control.readHostedBinding.mockResolvedValueOnce({ customerWorkspaceId: 'customer-ws-1' });

        await expect(workspaceHostProvisioningWorkflow({ ...lifecycle, action: 'upgrade' })).resolves.toMatchObject({
          status: 'failed',
          requiresInitialization: true,
        });

        expect(order).toEqual(['admit-initialize', 'initialize', 'desktop-pack', 'connector', 'activate']);
        expect(control.readDestroyTarget).toHaveBeenCalledWith('ws-1', 'host-1');
      });

      it('refuses a Papercusp-hosted restore before mutating the provider', async () => {
        const restore = {
          ...lifecycle,
          action: 'restore' as const,
          desired: { ...desired, hostId: 'host-restored' },
          snapshot: {
            target: 'gcp' as const,
            providerId: 'projects/project-1/global/snapshots/snapshot-1',
            hostId: 'host-1',
          },
        };
        control.readHostedBinding.mockResolvedValueOnce({ customerWorkspaceId: 'customer-ws-1' });

        await expect(workspaceHostProvisioningWorkflow(restore)).rejects.toThrow(
          /Papercusp-hosted restore is refused before provider mutation/,
        );

        expect(control.readHostedBinding).toHaveBeenCalledWith({ controlPlaneWorkspaceId: 'ws-1', hostId: 'host-1' });
        expect(control.runLifecycle).not.toHaveBeenCalled();
        expect(control.readDestroyTarget).not.toHaveBeenCalled();
      });

      it('keeps restore available for BYOC hosts with no hosted connector binding', async () => {
        const restore = {
          ...lifecycle,
          action: 'restore' as const,
          desired: { ...desired, hostId: 'host-restored' },
          snapshot: {
            target: 'gcp' as const,
            providerId: 'projects/project-1/global/snapshots/snapshot-1',
            hostId: 'host-1',
          },
        };
        control.readHostedBinding.mockResolvedValueOnce(null);
        control.runLifecycle.mockResolvedValueOnce({ ...lifecycleDone, hostId: 'host-restored' });

        await expect(workspaceHostProvisioningWorkflow(restore)).resolves.toMatchObject({
          status: 'succeeded',
          hostId: 'host-restored',
        });

        expect(control.runLifecycle).toHaveBeenCalledWith(expect.objectContaining({ action: 'restore', hostId: 'host-1' }));
        expect(control.runInitialization).not.toHaveBeenCalled();
        expect(control.readDestroyTarget).not.toHaveBeenCalled();
      });
    });
  });

  it('is registered by bootstrap before DBOS.launch so crash recovery can bind it', () => {
    const source = readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8');
    const registration = source.indexOf("await import('./workspace-host-provision-workflow')");
    const launch = source.indexOf('await DBOS.launch()');
    expect(registration).toBeGreaterThan(0);
    expect(launch).toBeGreaterThan(registration);
  });

  it('uses an operation-scoped workflow id and a host-scoped deduplication id', async () => {
    setWorkspaceHostProvisioningExecutor(async () => ({
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
      plan,
      checkpoints: [],
    }));

    await startWorkspaceHostProvisioningWorkflow(input);

    expect(control.startOptions).toMatchObject({
      workflowID: 'workspace-host:ws-1:host-1:operation:op-1',
      queueName: 'workspace-host-provision',
      enqueueOptions: { deduplicationID: 'workspace-host:ws-1:host-1' },
    });
  });

  it('resolves the production provider from the injected registry inside the DBOS workflow', async () => {
    control.runProvisioning.mockResolvedValueOnce({
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
      plan,
      checkpoints: [],
    });

    const bootstrapReleaseOverride = {
      manifestPath: '/var/lib/papercusp/releases/aws-canary.json',
      migrationId: '1101',
    } as const;
    await startWorkspaceHostProvisioningWorkflow({ ...input, bootstrapReleaseOverride });

    expect(control.runProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ provider: control.provider, bootstrapReleaseOverride }),
    );
  });

  it('routes discard destroy through the same host-scoped DBOS admission and composes the provider inside', async () => {
    control.retireCustomerWorkspace.mockResolvedValueOnce({ customerWorkspaceId: 'customer-ws-1' });
    control.runDestroy.mockResolvedValueOnce({
      status: 'succeeded',
      operationId: 'destroy-1',
      hostId: 'host-1',
      plan: { ...plan, operationId: 'destroy-1' },
      checkpoints: [],
    });

    await startWorkspaceHostDestroyWorkflow({
      workspaceId: 'ws-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      connection,
      disposition: 'discard',
      confirmation: {
        expectedHostId: 'host-1',
        confirmedBy: 'operator:test',
        confirmedAt: '2026-08-25T00:00:00Z',
      },
      canary: {
        runId: 'canary_1',
        workspaceId: 'ws-1',
        contractApproval: {
          status: 'approved',
          suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
          reportRef: 'report://gcp/fake-contract',
          approvedBy: 'operator:test',
          approvedAt: '2026-08-25T00:00:00Z',
        },
        teardownDeadlineAt: '2099-01-01T00:00:00Z',
        budgetEvidenceRef: 'gcp://billing/budget',
        preRunZeroBaseline: {
          cents: 0,
          observedAt: '2026-08-25T00:00:00Z',
          providerEvidenceRef: 'gcp://billing/baseline',
        },
        costEvidence: [{ cents: 1, observedAt: '2026-08-25T00:10:00Z', providerEvidenceRef: 'gcp://billing/cost' }],
        lateObservedSpend: [
          { cents: 1, observedAt: '2026-08-25T01:10:00Z', providerEvidenceRef: 'gcp://billing/late' },
        ],
      },
      operationId: 'destroy-1',
    });

    expect(control.startOptions).toMatchObject({
      workflowID: 'workspace-host:ws-1:host-1:operation:destroy-1',
      queueName: 'workspace-host-provision',
      enqueueOptions: { deduplicationID: 'workspace-host:ws-1:host-1' },
    });
    expect(control.runDestroy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'destroy', provider: control.provider }),
    );
    expect(control.retireCustomerWorkspace).toHaveBeenCalledWith({
      controlPlaneWorkspaceId: 'ws-1',
      hostId: 'host-1',
    });
    expect(control.stepOptionsByName['workspace-host-customer-workspace-offboarding']).toMatchObject({
      retriesAllowed: true,
      maxAttempts: 3,
    });
  });

  it('uses terminal absence to finish offboarding after an earlier destroy without destroying twice', async () => {
    control.runDestroy.mockRejectedValueOnce(
      new WorkspaceHostProvisioningRequestError(['workspace host is already absent']),
    );
    control.retireCustomerWorkspace.mockResolvedValueOnce({ customerWorkspaceId: 'customer-ws-1' });

    await expect(startWorkspaceHostDestroyWorkflow({
      workspaceId: 'ws-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      connection,
      disposition: 'discard',
      confirmation: {
        expectedHostId: 'host-1',
        confirmedBy: 'operator:test',
        confirmedAt: '2026-08-25T00:00:00Z',
      },
      operationId: 'destroy-reconcile-1',
    })).resolves.toMatchObject({
      status: 'succeeded',
      alreadyAbsent: true,
      offboardedCustomerWorkspaceId: 'customer-ws-1',
    });

    expect(control.runDestroy).toHaveBeenCalledOnce();
    expect(control.retireCustomerWorkspace).toHaveBeenCalledOnce();
  });

  it('does not retire a customer workspace when provider destruction is incomplete', async () => {
    control.runDestroy.mockResolvedValueOnce({
      status: 'failed',
      operationId: 'destroy-failed-1',
      hostId: 'host-1',
      plan: { ...plan, operationId: 'destroy-failed-1' },
      checkpoints: [],
    });

    await expect(startWorkspaceHostDestroyWorkflow({
      workspaceId: 'ws-1',
      hostId: 'host-1',
      connectionId: 'connection-1',
      connection,
      disposition: 'discard',
      confirmation: {
        expectedHostId: 'host-1',
        confirmedBy: 'operator:test',
        confirmedAt: '2026-08-25T00:00:00Z',
      },
      operationId: 'destroy-failed-1',
    })).resolves.toMatchObject({ status: 'failed' });

    expect(control.retireCustomerWorkspace).not.toHaveBeenCalled();
  });

  it('keeps the workflow active across an in-progress runner receipt', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'in-progress',
        operationId: 'op-1',
        hostId: 'host-1',
        plan,
        checkpoints: [],
        retryAfterMs: 7_500,
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        operationId: 'op-1',
        hostId: 'host-1',
        plan,
        checkpoints: [],
      });
    setWorkspaceHostProvisioningExecutor(execute);

    await expect(startWorkspaceHostProvisioningWorkflow(input)).resolves.toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(control.sleep).toHaveBeenCalledWith(7_500);
  });

  it('marks typed request and connection refusals non-retryable while retaining transient retries', async () => {
    const terminal = new WorkspaceHostProvisioningRequestError(['desired.zone must belong to desired.region']);
    setWorkspaceHostProvisioningExecutor(async () => {
      throw terminal;
    });

    await expect(startWorkspaceHostProvisioningWorkflow(input)).rejects.toBe(terminal);

    // Select the PROVISIONING step by name. Reading last-wins `stepOptions` here silently
    // retargeted this assertion at the terminal-failure step once that was added.
    const shouldRetry = control.stepOptionsByName['workspace-host-provision-0']?.shouldRetry as
      | ((error: unknown) => boolean)
      | undefined;
    expect(shouldRetry).toBeTypeOf('function');
    expect(shouldRetry?.(terminal)).toBe(false);
    expect(shouldRetry?.(new WorkspaceHostProvisioningConnectionError(['connection unavailable']))).toBe(false);
    expect(shouldRetry?.(new Error('transient provider timeout'))).toBe(true);
  });

  /**
   * WI-10001739 link 2. A step that exhausts its retries throws straight out of this workflow;
   * nothing recorded it, so the operation row kept its last-known status and a stale updated_at and
   * looked ALIVE. ~20min later the hosted-lifecycle reconciler reaped it on recency alone under a
   * SYNTHESIZED hosted_lifecycle_recovery_exhausted, erasing the real cause. Measured 2026-09-17: a
   * destroy died 73s in and was reported 20.2min later under that fabricated code.
   */
  it('persists the terminal cause when the step throws, and still rethrows the original error', async () => {
    const terminal = new Error('Step workspace-host-provision-0 has exceeded its maximum of 3 retries');
    setWorkspaceHostProvisioningExecutor(async () => {
      throw terminal;
    });

    // The original error must still reach the caller — recording must not swallow it.
    await expect(startWorkspaceHostProvisioningWorkflow(input)).rejects.toBe(terminal);

    expect(control.recordTerminalFailure).toHaveBeenCalledTimes(1);
    expect(control.recordTerminalFailure).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: input.operationId, error: terminal }),
    );

    // The recorder must not itself be retried: a failure to record is logged, never retried into
    // a second write of the same terminal row.
    expect(control.stepOptionsByName['workspace-host-provision-terminal-failure']).toMatchObject({
      retriesAllowed: false,
    });
  });

  /**
   * WI-10001739 link 1. A WorkspaceHostControllerFenceError is a CONTROL-PLANE condition, not a
   * provider failure, but it was retried out of the step's single maxAttempts:3 — so measured
   * 2026-09-17 a destroy spent attempts 1 and 2 on fence errors and had exactly one left when it
   * reached the provider and hit a genuinely transient network error.
   */
  function fenceError(): Error {
    return Object.assign(
      new Error("workspace-host controller authority or host generation is stale for 'host-1'"),
      { name: 'WorkspaceHostControllerFenceError' },
    );
  }

  it('absorbs a transient fence inside ONE step, leaving the provider retry budget untouched', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi
        .fn()
        .mockRejectedValueOnce(fenceError())
        .mockRejectedValueOnce(fenceError())
        .mockResolvedValueOnce({
          status: 'succeeded',
          operationId: 'op-1',
          hostId: 'host-1',
          plan,
          checkpoints: [],
        });
      setWorkspaceHostProvisioningExecutor(execute);

      const pending = startWorkspaceHostProvisioningWorkflow(input);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ status: 'succeeded' });

      // Three executor calls...
      expect(execute).toHaveBeenCalledTimes(3);
      // ...across exactly ONE step invocation. That is the whole point: the fence retries did not
      // draw down the attempts reserved for provider-network errors.
      expect(control.stepCalls.filter((name) => name === 'workspace-host-provision-0')).toHaveLength(1);
      expect(control.recordTerminalFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a PERSISTENT fence rather than spinning, and records it as the terminal cause', async () => {
    vi.useFakeTimers();
    try {
      const persistent = fenceError();
      const execute = vi.fn().mockRejectedValue(persistent);
      setWorkspaceHostProvisioningExecutor(execute);

      const pending = startWorkspaceHostProvisioningWorkflow(input);
      // Attach the rejection handler BEFORE advancing timers, or the rejection surfaces unhandled.
      const settled = expect(pending).rejects.toBe(persistent);
      await vi.runAllTimersAsync();
      await settled;

      // Bounded, not a spin: a genuine supersede holds the host forever, so this must terminate.
      expect(execute).toHaveBeenCalledTimes(5);
      expect(control.recordTerminalFailure).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still rethrows the original failure when recording the terminal cause itself fails', async () => {
    const terminal = new Error('provider exploded');
    const recordingFailure = new Error('database unreachable');
    control.recordTerminalFailure.mockRejectedValue(recordingFailure);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    setWorkspaceHostProvisioningExecutor(async () => {
      throw terminal;
    });

    try {
      // The recording failure must never mask what actually failed.
      await expect(startWorkspaceHostProvisioningWorkflow(input)).rejects.toBe(terminal);
      // ...but it must not vanish either, or a silently-unrecorded terminal failure is exactly the
      // blind spot this whole change exists to remove.
      expect(logged).toHaveBeenCalledWith(
        '[workspace-host] could not persist terminal failure',
        recordingFailure,
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('rehydrates validated typed errors after DBOS serialization erases their prototypes', async () => {
    const requestProblems = ['desired.zone must belong to desired.region'];
    control.resultError = Object.assign(new Error('workspace-host provisioning request rejected'), {
      name: 'WorkspaceHostProvisioningRequestError',
      problems: requestProblems,
    });

    const requestError = await startWorkspaceHostProvisioningWorkflow(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(requestError).toBeInstanceOf(WorkspaceHostProvisioningRequestError);
    expect((requestError as WorkspaceHostProvisioningRequestError).problems).toEqual(requestProblems);

    const connectionProblems = ['provider connection is not usable'];
    control.resultError = Object.assign(new Error('workspace-host provider connection is unavailable'), {
      name: 'WorkspaceHostProvisioningConnectionError',
      problems: connectionProblems,
    });

    const connectionError = await startWorkspaceHostProvisioningWorkflow(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(connectionError).toBeInstanceOf(WorkspaceHostProvisioningConnectionError);
    expect((connectionError as WorkspaceHostProvisioningConnectionError).problems).toEqual(connectionProblems);
  });

  // WI-10005474: a request that reuses the operationId of a workflow that already ENDED in a fence
  // refusal (WI-10005312) is the SAME DBOS workflow, so `getResult` rethrows its stored, serialized
  // error at once, inside the admission window. Unrehydrated it is a plain Error, which every
  // route answers as a generic 500 instead of the conflict it is.
  it('rehydrates a serialized controller-fence refusal on every result-waiting start (WI-10005474)', async () => {
    const serializedFence = () =>
      Object.assign(new Error("workspace-host controller authority or host generation is stale for 'host-1'"), {
        name: 'WorkspaceHostControllerFenceError',
        hostId: 'host-1',
      });
    const starts: Array<[string, () => Promise<unknown>]> = [
      ['provision', () => startWorkspaceHostProvisioningWorkflow(input)],
      [
        'destroy',
        () =>
          startWorkspaceHostDestroyWorkflow({
            workspaceId: 'ws-1',
            hostId: 'host-1',
            connectionId: 'connection-1',
            connection,
            disposition: 'discard',
            confirmation: {
              expectedHostId: 'host-1',
              confirmedBy: 'operator:test',
              confirmedAt: '2026-08-25T00:00:00Z',
            },
            operationId: 'destroy-refused-1',
          }),
      ],
      [
        'lifecycle',
        () =>
          startWorkspaceHostLifecycleWorkflow({
            workspaceId: 'ws-1',
            hostId: 'host-1',
            action: 'upgrade',
            connection,
            image: { id: 'projects/images/global/images/papercusp-v2' },
            operationId: 'upgrade-refused-1',
          }),
      ],
    ];
    for (const [label, start] of starts) {
      control.resultError = serializedFence();
      const received = await start().then(
        () => null,
        (error: unknown) => error,
      );
      expect(received, label).toBeInstanceOf(WorkspaceHostControllerFenceError);
      expect((received as WorkspaceHostControllerFenceError).hostId, label).toBe('host-1');
    }

    // Only the validated shape is rehydrated: a fence-named error with no host id stays as it was.
    const malformed = Object.assign(new Error('stale'), { name: 'WorkspaceHostControllerFenceError' });
    control.resultError = malformed;
    await expect(startWorkspaceHostProvisioningWorkflow(input)).rejects.toBe(malformed);
  });

  it('does not reclassify malformed or unrelated DBOS errors', async () => {
    const malformed = Object.assign(new Error('transient provider timeout'), {
      name: 'WorkspaceHostProvisioningRequestError',
      problems: [''],
    });
    control.resultError = malformed;

    const received = await startWorkspaceHostProvisioningWorkflow(input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(received).toBe(malformed);
  });

  it('maps a concurrent host-scoped dedup refusal to a typed conflict', async () => {
    control.dedupConflict = true;
    setWorkspaceHostProvisioningExecutor(async () => {
      throw new Error('must not run');
    });

    await expect(startWorkspaceHostProvisioningWorkflow(input)).rejects.toBeInstanceOf(
      WorkspaceHostProvisioningConflictError,
    );
  });

  // EI-23712230399040759: the HTTP admission must never hold the request for the workflow's whole
  // run. A bounded wait that times out is ACCEPTED work, answered with the operation identity.
  it('bounds the result wait by the admission window and returns acceptance when it has not settled', async () => {
    control.admissionPending = true;
    setWorkspaceHostProvisioningExecutor(async () => {
      throw new Error('an unsettled admission must not observe the workflow result');
    });

    await expect(startWorkspaceHostProvisioningWorkflow(input)).resolves.toEqual({
      status: 'accepted',
      operationId: 'op-1',
      hostId: 'host-1',
    });
    expect(control.getResultOptions).toEqual({ timeoutSeconds: 5 });

    await expect(
      startWorkspaceHostDestroyWorkflow({
        workspaceId: 'ws-1',
        hostId: 'host-1',
        connectionId: 'connection-1',
        connection,
        disposition: 'discard',
        confirmation: {
          expectedHostId: 'host-1',
          confirmedBy: 'operator:test',
          confirmedAt: '2026-08-25T00:00:00Z',
        },
        operationId: 'destroy-accepted-1',
      }),
    ).resolves.toEqual({ status: 'accepted', operationId: 'destroy-accepted-1', hostId: 'host-1' });

    await expect(
      startWorkspaceHostLifecycleWorkflow({
        workspaceId: 'ws-1',
        hostId: 'host-1',
        action: 'upgrade',
        connection,
        image: { id: 'projects/images/global/images/papercusp-v2' },
        operationId: 'upgrade-accepted-1',
      }),
    ).resolves.toEqual({ status: 'accepted', operationId: 'upgrade-accepted-1', hostId: 'host-1' });
    expect(control.getResult).toHaveBeenCalledTimes(3);
  });

  it('still returns a workflow that settles inside the admission window, including its typed refusal', async () => {
    control.runProvisioning.mockResolvedValueOnce({
      status: 'succeeded',
      operationId: 'op-1',
      hostId: 'host-1',
      plan,
      checkpoints: [],
    });
    await expect(startWorkspaceHostProvisioningWorkflow(input)).resolves.toMatchObject({ status: 'succeeded' });

    const refused = new WorkspaceHostProvisioningRequestError(['upgrade image is required']);
    control.resultError = refused;
    await expect(startWorkspaceHostProvisioningWorkflow(input)).rejects.toBe(refused);
  });

  it('rejects an upgrade with no image before enqueue so the same operation ID can be retried', async () => {
    control.admissionPending = true;
    const incomplete = {
      workspaceId: 'ws-1',
      hostId: 'host-1',
      action: 'upgrade' as const,
      connection,
      operationId: 'upgrade-preflight-1',
    };

    await expect(startWorkspaceHostLifecycleWorkflow(incomplete)).rejects.toMatchObject({
      name: 'WorkspaceHostProvisioningRequestError',
      problems: ['upgrade image is required'],
    });
    expect(control.startOptions).toBeNull();
    expect(control.getResult).not.toHaveBeenCalled();

    await expect(
      startWorkspaceHostLifecycleWorkflow({
        ...incomplete,
        image: { id: 'projects/images/global/images/papercusp-v2' },
      }),
    ).resolves.toMatchObject({
      status: 'accepted',
      operationId: 'upgrade-preflight-1',
      hostId: 'host-1',
    });
    expect(control.startOptions).toMatchObject({
      workflowID: 'workspace-host:ws-1:host-1:operation:upgrade-preflight-1',
    });
  });

  it('rejects every incomplete restore request before enqueue', async () => {
    control.admissionPending = true;
    const snapshot = { target: 'gcp' as const, providerId: 'snapshot-1', hostId: 'host-1' };
    const restored = { ...desired, hostId: 'host-restored-1' };
    const base = {
      workspaceId: 'ws-1',
      hostId: 'host-1',
      action: 'restore' as const,
      connection,
    };
    const invalidRequests: Array<{
      request: Parameters<typeof startWorkspaceHostLifecycleWorkflow>[0];
      problem: string;
    }> = [
      {
        request: { ...base, operationId: 'restore-preflight-snapshot-1', desired: restored },
        problem: 'restore snapshot is required',
      },
      {
        request: { ...base, operationId: 'restore-preflight-desired-1', snapshot },
        problem: 'restore desired host spec is required',
      },
      {
        request: { ...base, operationId: 'restore-preflight-host-1', snapshot, desired },
        problem: 'restore must target a distinct desired.hostId',
      },
    ];

    for (const { request, problem } of invalidRequests) {
      await expect(startWorkspaceHostLifecycleWorkflow(request)).rejects.toMatchObject({
        name: 'WorkspaceHostProvisioningRequestError',
        problems: [problem],
      });
      expect(control.startOptions).toBeNull();
      expect(control.getResult).not.toHaveBeenCalled();
    }
  });
});
