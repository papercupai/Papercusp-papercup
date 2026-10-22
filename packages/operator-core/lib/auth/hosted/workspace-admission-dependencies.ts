/**
 * Production wiring for {@link createHostedWorkspaceAdmission}.
 *
 * `workspace-admission.ts` owns the ADMISSION ORDERING and its idempotency, and takes every
 * effect as an injected dependency so those properties can be tested without a database.
 * This file is the other half: the real Postgres/DBOS effects, assembled once.
 *
 * WHY THE SQL LIVES HERE AND USES `withWorkspace`. `harness_shared.customer_workspaces` has
 * FORCE ROW LEVEL SECURITY and the control-plane role `harness_app` is NOT `bypassrls`, so
 * the policy added by migration 1193 only admits a statement whose transaction has
 * `app.workspace_id` set. `withWorkspace(id, fn)` is precisely that: it takes the
 * `getOrgPgApp()` (harness_app) pool and sets the GUC for the transaction. Reaching for a
 * bare admin client instead would "work" by BYPASSING the tenant predicate, which is the one
 * property this subsystem exists to preserve (D-368 / WI-10002396).
 *
 * WHY `resolveDesiredSpec` IS A REQUIRED ARGUMENT AND HAS NO DEFAULT. Building a
 * `WorkspaceHostDesiredSpec` requires region/size/image/credentials, and those follow from a
 * product question that is not settled: whether a hosted free signup connects the customer's
 * own cloud account or receives a Papercusp-funded workspace. Defaulting it here would bury
 * that open question inside a plausible-looking constant. Making it required puts the
 * unanswered decision at the wiring seam, where it is visible, instead of at runtime.
 */
import { withWorkspace } from '@papercusp/db-org';
import { safeCloudError } from '../../cloud-telemetry';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  readWorkspaceHostConnection,
  readWorkspaceHostDestroyTarget,
  upsertWorkspaceHost,
  type StoredWorkspaceHostConnection,
} from '../../workspace-host/observability-store';
import { workspaceHostSpecColumns } from '../../workspace-host/desired-spec-host-row';
import type { WorkspaceHostBringUp } from '../../workspace-host/hosted-bring-up';
import {
  startWorkspaceHostProvisioningWorkflow,
  startWorkspaceHostLifecycleWorkflow,
  type StartWorkspaceHostProvisioningInput,
  type StartWorkspaceHostLifecycleInput,
} from '../../dbos/workspace-host-provision-workflow';
import { resolveControllerWorkspaceHostBootstrap } from '../../workspace-host/provisioning-runner';
import { createConfiguredGcpWorkspaceHostProvider } from '../../workspace-host/gcp-provider';
import { resolveHostedGcpAuth } from '../../workspace-host/hosted-gcp-auth';
import { createConfiguredAwsWorkspaceHostProvider } from '../../workspace-host/aws-configured-provider';
import { resolveOrganizationExternalIdRef } from '../../workspace-host/hosted-aws-identity';
import { admitHostedLifecycleJob, readHostedLifecycleAdmission, completeHostedPoolReuse, refreshHostedStoppedOwnerObservation,
  type AdmitHostedLifecycleJobInput } from '../../workspace-host/hosted-lifecycle-store';
import {
  HostedWorkspaceAdmissionError,
  type HostedWorkspaceAdmissionDependencies,
  type HostedWorkspaceBinding,
  type HostedWorkspaceProvisioningRequest,
} from './workspace-admission';

/** Migration 1200: at most one live customer workspace per organization (D-397). */
export const ONE_LIVE_WORKSPACE_PER_ORGANIZATION_INDEX = 'customer_workspaces_one_live_per_organization_uq';

/** A 23505 raised by THIS index only; every other unique violation stays fatal. */
function isUniqueViolation(error: unknown, indexName: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  if (String(candidate.code ?? '') !== '23505') return false;
  if (candidate.constraint === indexName || candidate.constraint_name === indexName) return true;
  return [candidate.message, candidate.detail].some(
    (value) => typeof value === 'string' && value.includes(`"${indexName}"`),
  );
}

interface BindingRow {
  id: string;
  organization_id: string;
  workspace_host_id: string;
  state: string;
}

export interface DefaultHostedWorkspaceAdmissionOptions {
  /** See the file header: deliberately required, because the product decision is open. */
  resolveDesiredSpec: HostedWorkspaceAdmissionDependencies['resolveDesiredSpec'];
  /**
   * Where a failure to ENQUEUE provisioning is reported. Provisioning is started
   * fire-and-forget (a signup must not block on a cloud VM booting), so without this the
   * rejection would be an unhandled promise rather than an observable event.
   */
  onProvisioningStartFailed?: (error: unknown, context: { hostId: string; operationId: string }) => void;
  /**
   * How the provision is put on the durable queue. Default = in-process DBOS; a process that
   * does not run DBOS (the hosted control plane) passes a DBOS-client enqueuer instead
   * (`dbos/workspace-host-provision-client.ts`).
   */
  startWorkflow?: (input: StartWorkspaceHostProvisioningInput) => Promise<unknown>;
  startLifecycleWorkflow?: (input: StartWorkspaceHostLifecycleInput) => Promise<unknown>;
  /** Platform-funded signup uses the VM pool; BYOC keeps its customer-cloud provision route. */
  pooled?: boolean;
  /** Server-only catalog seam. No request parser accepts cost, capacity, runtime or pool fields. */
  resolvePoolAdmission?: typeof resolveHostedPoolAdmission;
  /**
   * D-401: set the machine up once it is built. Only the Papercusp-hosted first-workspace door
   * passes this; without it provisioning ends at the machine, as every other caller expects.
   */
  bringUp?: Pick<WorkspaceHostBringUp, 'requestedAgents'>;
}

/** Resolve measured requirements and a provider quote. Unknown prices are never zero-cost admissions. */
export async function resolveHostedPoolAdmission(
  input: HostedWorkspaceProvisioningRequest,
  stored: Pick<StoredWorkspaceHostConnection, 'connection'>,
): Promise<Pick<AdmitHostedLifecycleJobInput, 'pool' | 'estimate'>> {
  const desired = input.desiredSpec;
  // The request-only hosted process does not start DBOS or populate its provider registry.
  // Reuse the configured providers' credential seams for these read-only catalog calls.
  const provider = stored.connection.target === 'gcp'
    ? createConfiguredGcpWorkspaceHostProvider(stored.connection, { resolveHostedAuth: resolveHostedGcpAuth })
    : stored.connection.target === 'aws'
      ? createConfiguredAwsWorkspaceHostProvider(stored.connection, { resolveExternalId: resolveOrganizationExternalIdRef })
      : null;
  if (!provider) throw new HostedWorkspaceAdmissionError('pool provider is unsupported', 'lifecycle_admission_unavailable');
  const context = { workspaceId: input.controlPlaneWorkspaceId, requestId: input.operationId,
    connection: { ...stored.connection, scope: desired.scope }, actorId: input.actorId };
  const query = { scope: desired.scope, region: desired.region };
  const [sizes, images, price, bootstrap, target] = await Promise.all([
    provider.listSizes(query, context), provider.listImages(query, context), provider.estimatePrice(desired, context),
    resolveControllerWorkspaceHostBootstrap(desired.hostId),
    readWorkspaceHostDestroyTarget(input.controlPlaneWorkspaceId, input.hostId),
  ]);
  const size = sizes.find(value => value.id === desired.size && value.available);
  const image = images.find(value => value.id === desired.image.id && !value.deprecated);
  const monthly = price.monthlyAmount ?? price.hourlyAmount * 730;
  if (!desired.zone || !size || !image?.architecture || price.confidence === 'unknown' ||
      !Number.isFinite(monthly) || monthly < 0 || !Number.isSafeInteger(Math.ceil(monthly * 100)) ||
      (size.architectures && !size.architectures.includes(image.architecture))) {
    throw new HostedWorkspaceAdmissionError('provider capacity, architecture, zone or pricing is unavailable', 'lifecycle_admission_unavailable');
  }
  const disks = target?.resources.filter(value => value.resource.kind === 'disk') ?? [];
  if (disks.length > 1) throw new HostedWorkspaceAdmissionError('durable data volume identity is ambiguous', 'lifecycle_admission_unavailable');
  if (target?.observedState === 'stopped') {
    await refreshHostedStoppedOwnerObservation({ workspaceId: input.controlPlaneWorkspaceId,
      customerWorkspaceId: input.customerWorkspaceId, hostId: target.id, requestId: input.operationId },
    { resolveProvider: () => provider });
  }
  return {
    pool: { scope: desired.scope, region: desired.region, zone: desired.zone,
      architecture: image.architecture, runtimeBundleSha256: bootstrap.runtimeRelease.bundleSha256,
      minimum: { cpuCount: size.cpuCount, memoryMiB: size.memoryMiB }, maxObservationAgeMs: 20 * 60_000,
      dataVolumeId: disks[0]?.resource.providerId ?? `unprovisioned:${input.customerWorkspaceId}` },
    estimate: { cents: Math.ceil(monthly * 100), currency: price.currency, source: `${desired.target}-provider-catalog`,
      evidenceRef: `${desired.target}://catalog/${encodeURIComponent(desired.scope.id)}/${encodeURIComponent(desired.region)}/${encodeURIComponent(desired.size)}`,
      estimatedAt: price.observedAt },
  };
}

export function createDefaultHostedWorkspaceAdmissionDependencies(
  options: DefaultHostedWorkspaceAdmissionOptions,
): HostedWorkspaceAdmissionDependencies {
  const reportProvisioningFailure =
    options.onProvisioningStartFailed ??
    ((error: unknown, context: { hostId: string; operationId: string }) => {
      console.error(
        `[hosted-admission] failed to enqueue provisioning for host ${context.hostId} (operation ${context.operationId})`,
        safeCloudError('provisioning_failure', error),
      );
    });

  const startWorkflow = options.startWorkflow ?? startWorkspaceHostProvisioningWorkflow;

  return {
    controlPlaneWorkspaceId: activeWorkspaceId,
    ...(options.pooled ? { async admitAndStart(input: HostedWorkspaceProvisioningRequest) {
      const request = { connectionId: input.connectionId, name: input.name, desired: input.desiredSpec };
      const replay = await readHostedLifecycleAdmission({ workspaceId: input.controlPlaneWorkspaceId,
        operationId: input.operationId, customerWorkspaceId: input.customerWorkspaceId, actorId: input.actorId, request });
      const stored = await readWorkspaceHostConnection(input.controlPlaneWorkspaceId, input.connectionId);
      if (!stored) throw new HostedWorkspaceAdmissionError('provider connection disappeared', 'connection_not_found');
      const receipt = replay ?? await admitHostedLifecycleJob({
        workspaceId: input.controlPlaneWorkspaceId, customerWorkspaceId: input.customerWorkspaceId,
        hostId: input.hostId, providerTarget: input.desiredSpec.target, action: 'provision',
        operationId: input.operationId, actorId: input.actorId, request,
        riskTier: 'moderate', approvalStatus: 'not-required',
        ...(input.capacityReconcile ? { capacityReconcile: input.capacityReconcile } : {}),
        billingOwner: { kind: 'platform', id: input.controlPlaneWorkspaceId },
        ...await (options.resolvePoolAdmission ?? resolveHostedPoolAdmission)(input, stored),
      });
      // Re-enqueue on replay too: admission may have committed just before a process died.
      // The existing DBOS workflow id and dedup key bind this to the SAME operation.
      if (receipt.placement?.kind === 'reuse') {
        await completeHostedPoolReuse(input.controlPlaneWorkspaceId, receipt);
      } else if (receipt.placement?.kind === 'provision') {
        await startWorkflow({ workspaceId: input.controlPlaneWorkspaceId, connectionId: input.connectionId,
          name: input.name, desired: input.desiredSpec, connection: stored.connection,
          operationId: receipt.operationId, actorId: input.actorId, hostedCustomerWorkspaceId: input.customerWorkspaceId,
          ...(options.bringUp ? { bringUp: { ...options.bringUp, customerWorkspaceId: input.customerWorkspaceId } } : {}) });
      } else if (receipt.placement && 'hostId' in receipt.placement) {
        const target = await readWorkspaceHostDestroyTarget(input.controlPlaneWorkspaceId, receipt.hostId);
        if (!target) throw new Error('hosted_pool_reserved_host_missing');
        const selectedConnection = await readWorkspaceHostConnection(input.controlPlaneWorkspaceId, target.connectionId);
        if (!selectedConnection) throw new Error('hosted_pool_reserved_connection_missing');
        await (options.startLifecycleWorkflow ?? startWorkspaceHostLifecycleWorkflow)({
          workspaceId: input.controlPlaneWorkspaceId, hostId: receipt.hostId, action: 'start',
          connection: { ...selectedConnection.connection, scope: target.desired.scope },
          operationId: receipt.operationId, actorId: input.actorId, hostedCustomerWorkspaceId: input.customerWorkspaceId,
          ...(receipt.placement.kind === 'assign-warm' && options.bringUp
            ? { bringUp: { ...options.bringUp, customerWorkspaceId: input.customerWorkspaceId } } : {}),
        });
      } else throw new Error('hosted_pool_placement_required');
    } } : {}),

    async readConnection(controlPlaneWorkspaceId, connectionId) {
      const stored = await readWorkspaceHostConnection(controlPlaneWorkspaceId, connectionId);
      // Narrowed to the identity on purpose: the admission port must never handle a
      // provider connection, which carries a cloud credential reference.
      return stored ? { id: stored.id } : null;
    },

    async readBinding(controlPlaneWorkspaceId, workspaceId): Promise<HostedWorkspaceBinding | null> {
      return withWorkspace(controlPlaneWorkspaceId, async (query) => {
        const rows = await query<BindingRow[]>`
          SELECT id, organization_id, workspace_host_id, state
            FROM harness_shared.customer_workspaces
           WHERE workspace_id = ${controlPlaneWorkspaceId}
             AND id = ${workspaceId}
           LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        // NOTE: soft-deleted rows are returned deliberately. The row still occupies the
        // unique identity, so hiding it would make admission attempt an INSERT that can
        // only fail. Liveness is judged by the caller (`state`), not by hiding the row.
        return {
          workspaceId: row.id,
          organizationId: row.organization_id,
          workspaceHostId: row.workspace_host_id,
          state: row.state,
        };
      });
    },

    resolveDesiredSpec: options.resolveDesiredSpec,

    async upsertHost(input) {
      await upsertWorkspaceHost({
        // The spec-derived columns come from the SAME projection the provisioning runner
        // uses, so the row admission writes and the row provisioning later re-writes
        // cannot describe different hosts.
        ...workspaceHostSpecColumns(input.desiredSpec),
        workspaceId: input.controlPlaneWorkspaceId,
        id: input.hostId,
        name: input.name,
        connectionId: input.connectionId,
        // The host is REQUESTED to run and is OBSERVED as not yet provisioned. The
        // provisioning runner re-upserts this row with the same pair when it starts.
        desiredState: 'running',
        observedState: 'provisioning',
        desiredSpec: input.desiredSpec,
      });
    },

    async bindWorkspace(input) {
      try {
        return await withWorkspace(input.controlPlaneWorkspaceId, async (query) => {
          // ON CONFLICT DO NOTHING + RETURNING is what makes `created` truthful under a
          // concurrent replay: exactly one caller gets a row back, and only that one goes on
          // to enqueue provisioning.
          const rows = await query<Array<{ id: string }>>`
            INSERT INTO harness_shared.customer_workspaces (
              workspace_id, id, organization_id, workspace_host_id, display_name, state,
              created_by_principal_kind, created_by_principal_id
            ) VALUES (
              ${input.controlPlaneWorkspaceId}, ${input.workspaceId}, ${input.organizationId},
              ${input.workspaceHostId}, ${input.displayName}, 'provisioning',
              'user', ${input.userId}
            )
            ON CONFLICT (workspace_id, id) DO NOTHING
            RETURNING id
          `;
          return { created: rows.length === 1 };
        });
      } catch (error) {
        // The ON CONFLICT target above is the row identity only, so a violation of the
        // one-live-workspace-per-organization index still raises: a concurrent attempt for
        // the same organization won (migration 1200, D-397).
        if (!isUniqueViolation(error, ONE_LIVE_WORKSPACE_PER_ORGANIZATION_INDEX)) throw error;
        // The host row admission wrote for THIS attempt now binds nothing and would read as a
        // host being provisioned forever. Nothing references it yet (provisioning starts only
        // after a created binding), so it is removed rather than left behind.
        await withWorkspace(input.controlPlaneWorkspaceId, (query) => query`
          DELETE FROM harness_shared.workspace_hosts host
           WHERE host.workspace_id = ${input.controlPlaneWorkspaceId}
             AND host.id = ${input.workspaceHostId}
             AND NOT EXISTS (
               SELECT 1 FROM harness_shared.customer_workspaces customer
                WHERE customer.workspace_id = host.workspace_id
                  AND customer.workspace_host_id = host.id
             )
        `);
        throw new HostedWorkspaceAdmissionError(
          'organization already has a live workspace',
          'organization_has_live_workspace',
        );
      }
    },

    startProvisioning(input) {
      // Fire-and-forget by contract. The connection is re-read here rather than threaded
      // through the port because the port is deliberately credential-free; this is one
      // indexed row on the path that is already about to start a cloud provision.
      void (async () => {
        const stored = await readWorkspaceHostConnection(
          input.controlPlaneWorkspaceId,
          input.connectionId,
        );
        if (!stored) {
          throw new Error(
            `connection ${input.connectionId} disappeared between admission and provisioning`,
          );
        }
        await startWorkflow({
          workspaceId: input.controlPlaneWorkspaceId,
          connectionId: input.connectionId,
          name: input.name,
          desired: input.desiredSpec satisfies WorkspaceHostDesiredSpec,
          connection: stored.connection,
          operationId: input.operationId,
          actorId: input.actorId,
          ...(options.bringUp
            ? {
                bringUp: {
                  customerWorkspaceId: input.customerWorkspaceId,
                  requestedAgents: options.bringUp.requestedAgents,
                },
              }
            : {}),
        });
      })().catch((error: unknown) =>
        reportProvisioningFailure(error, { hostId: input.hostId, operationId: input.operationId }),
      );
    },
  };
}
