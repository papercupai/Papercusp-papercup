/** Bind the selected support worker to the maintained native gateway and SRT
 * boundary. A request header is attribution, never this route's authority. */
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import { SCOPED_INFERENCE_GATEWAY_ENV, snapshotScopedInferenceGateway } from '@papercusp/orchestrator/codex-gateway-config';
import { runWithWorkspace } from '../workspace-als';
import { getWorkItem, claimWorkItem } from '../work-items';
import { declareSessionConfinement } from '../capability-envelope/session-confinement-store';
import type { GatewayServiceOptions, RunningGatewayService } from '../inference-gateway/launch';
import { readAcceptedBlueprintDirectWorkItem } from './operation-admission';
import { readActiveOperationWorkerClaimBinding, type AcceptedOperationWorkerBinding } from './operation-worker-binding';
import { readSupportOperationBudgetBinding, supportOperationReservationId } from './support-workflow-budget';
import type { BlueprintOperationHandle } from './operation-service';

// A private listener is a leased launch resource, not a background monitor.
// A missing exit report therefore cannot retain it indefinitely.
export const SUPPORT_NATIVE_ROUTE_LEASE_MS = 60 * 60 * 1000;

// Ephemeral listeners belong to the exact tracked launch. The canonical
// terminal CAS tears them down; expiry remains the lost-exit fallback.
const runningRoutes = new Map<number, { stop: () => Promise<void> }>();
export async function stopSupportOperationNativeLaunch(sessionId: number): Promise<void> {
  await runningRoutes.get(sessionId)?.stop();
}

export async function prepareSupportOperationNativeLaunch(input: {
  workspaceId: string; ownerId: string; sessionId: number; agent: string;
  checkout: string; accepted: AcceptedOperationWorkerBinding;
}, start: (options: GatewayServiceOptions) => Promise<RunningGatewayService> = async options =>
  (await import('../inference-gateway/launch')).startGatewayService(options)): Promise<{
  envelopeEnv: Record<string, string>; stop: () => Promise<void>;
} | null> {
  const { workspaceId, ownerId, sessionId, checkout } = input;
  const accepted = structuredClone(input.accepted);
  return runWithWorkspace(workspaceId, async () => {
    const sql = getOrgPg().sql;
    const item = await getWorkItem(accepted.workItemId, accepted.storageHarnessSlug);
    if (!item) throw new Error('Support native launch target is missing');
    const { operation, pin } = await readAcceptedBlueprintDirectWorkItem(sql, workspaceId, item);
    const support = operation.policy.supportCase;
    if (!support) return null;
    if (input.agent !== 'codex' || !support.native || !support.funding ||
        !isDeepStrictEqual(pin, accepted.pin) || operation.id !== accepted.operationId ||
        support.funding.organization.controlWorkspaceId !== workspaceId) {
      throw new Error('Support native launch requires its accepted Codex funding and revision');
    }
    const [receipt] = await sql<Array<{ id: string | number }>>`SELECT id FROM harness_shared.blueprint_operation_invocations
      WHERE workspace_id = ${workspaceId} AND harness_slug = ${accepted.harnessSlug}
        AND operation_id = ${accepted.operationId} AND specification_revision = ${accepted.specificationRevision}
        AND target_kind = 'work-item' AND target_ref = ${accepted.workItemId}
        AND caller_id = ${pin.callerId ?? ''} AND request_key = ${pin.requestKey ?? ''}`;
    if (!receipt) throw new Error('Support native launch invocation is missing');
    const handle: BlueprintOperationHandle = { workspaceId, harnessSlug: accepted.harnessSlug,
      operationId: accepted.operationId, receiptId: Number(receipt.id),
      specificationRevision: accepted.specificationRevision, target: { kind: 'work-item', id: accepted.workItemId } };
    const armId = supportOperationReservationId(handle);
    const confined = await declareSessionConfinement({ workspaceId, ownerId, confinement: {
      imposedBy: `blueprint-operation:${handle.receiptId}`,
      reason: 'Support worker may use only its accepted input and result lane; provider access uses its private budget route.',
      denyTools: [], denyAmbientContext: true,
      denyOutside: ['tools:find', 'tools:invoke', 'blueprint:read-private-input',
        'work_items:get', 'work_items:checkpoint', 'work_items:complete'],
      denyWorkItemsOutside: { id: accepted.workItemId, harness: accepted.storageHarnessSlug, checkout },
    } });
    if (!confined.ok) throw new Error(`Support worker tool confinement refused: ${confined.reason}`);
    const token = randomBytes(32).toString('hex');
    let live = true;
    const service = await start({ port: 0, workspace: workspaceId, carryTrial: {
      manifestSha256: accepted.specificationRevision, armId, ownerId,
      requestTokenSha256: createHash('sha256').update(token).digest('hex'),
      protocols: ['openai-responses'],
      ...(support.native.payer === 'api-key' ? { outputTokenLimit: support.native.outputTokenCeiling } : {}),
      async authorizeAttempt(attempt) {
        return runWithWorkspace(workspaceId, async () => {
          if (!live) return null;
          const active = await readActiveOperationWorkerClaimBinding(workspaceId, ownerId);
          if (active.status !== 'bound' || active.receipt.sessionId !== sessionId ||
              active.binding.workItemId !== accepted.workItemId || active.binding.operationId !== accepted.operationId ||
              !isDeepStrictEqual(active.binding.pin, accepted.pin)) return null;
          // The first native inference precedes the worker's first tool call.
          // Claim only its exact applied lane through the canonical CAS; a
          // foreign hold is never stolen to get that first request through.
          const current = await getWorkItem(accepted.workItemId, accepted.storageHarnessSlug);
          if (!current || current.assignee && current.assignee !== ownerId) return null;
          if (!current.assignee && !await claimWorkItem(accepted.workItemId, ownerId,
            { harness: accepted.storageHarnessSlug })) return null;
          const binding = await readSupportOperationBudgetBinding(workspaceId, ownerId);
          if (!live || !binding || binding.manifestSha256 !== accepted.specificationRevision || binding.armId !== armId) return null;
          const receipt = await binding.authorizeAttempt(attempt);
          if (!live || !receipt) return null;
          return { ...receipt, validateAuthorization() {
            if (!live) throw new Error('Support native route stopped');
            const result: unknown = receipt.validateAuthorization?.();
            if (result !== undefined) {
              void Promise.resolve(result).catch(() => {});
              throw new Error('Support native route requires synchronous provider authority');
            }
            if (!live) throw new Error('Support native route stopped');
          } };
        });
      },
    }, log: (level, message) => console.info(`[support-native:${level}] ${message}`) });
    if (!Number.isSafeInteger(service.port) || service.port <= 0 || service.port > 65535) {
      live = false; await service.stop();
      throw new Error('Support native gateway did not bind a private port');
    }
    const privateRoute = snapshotScopedInferenceGateway({ baseURL: `http://127.0.0.1:${service.port}`, token });
    let stopping: Promise<void> | undefined;
    const stop = () => {
      live = false;
      clearTimeout(expiry);
      if (runningRoutes.get(sessionId)?.stop === stop) runningRoutes.delete(sessionId);
      return stopping ??= service.stop();
    };
    const expiry = setTimeout(() => { void stop().catch(error => console.warn('[support-native] route cleanup failed', error)); },
      SUPPORT_NATIVE_ROUTE_LEASE_MS);
    expiry.unref();
    runningRoutes.set(sessionId, { stop });
    return { stop, envelopeEnv: {
      [SCOPED_INFERENCE_GATEWAY_ENV]: JSON.stringify(privateRoute),
      PAPERCUSP_ACCOUNT_ROUTING_MODE: support.native.account === 'auto' || support.native.account === 'default' ? 'auto' : 'pin',
      ...(support.native.account !== 'auto' && support.native.account !== 'default'
        ? { PAPERCUSP_ACCOUNT_ID: support.native.account } : {}),
    } };
  });
}
