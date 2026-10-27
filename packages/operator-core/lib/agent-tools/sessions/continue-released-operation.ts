/**
 * sessions:continue-released-operation
 *
 * A first-party UserPromptSubmit hook may use this door when a genuine owner
 * turn lands on an accepted-operation worker whose exact claim has already
 * been released. The old worker is never widened. Instead, the handler proves
 * the hook-captured owner turn and released claim from durable state, then
 * launches one fresh base-SU assignment carrying the owner's verbatim prompt.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, SU_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import launchAgentTool from '../capability/launch-agent';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  operationWorkerEffectWhereSql,
  readActiveOperationWorkerClaimBinding,
  type ActiveOperationWorkerClaimRead,
} from '../../blueprint/operation-worker-binding';
import {
  RELEASED_OPERATION_CONTINUATION_TOOL,
  isHookReleasedOperationContinuationCall,
} from '../../released-operation-continuation-door';

type LaunchHandler = typeof launchAgentTool.handler;
type LaunchContext = Parameters<LaunchHandler>[1];

export interface ReleasedOperationContinuationInput {
  prompt: string;
  sourceTurnRef: string;
  sessionRef: string;
  directiveId: number;
}

export type ReleasedOperationContinuationEligibility =
  | { status: 'eligible'; binding: Extract<ActiveOperationWorkerClaimRead, { status: 'bound' }>['binding'] }
  | { status: 'ineligible'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface ReleasedOperationContinuationDeps {
  readEligibility(input: {
    workspaceId: string;
    ownerId: string;
    prompt: string;
    sourceTurnRef: string;
    sessionRef: string;
    directiveId: number;
  }): Promise<ReleasedOperationContinuationEligibility>;
  launch: LaunchHandler;
}

function continuationIdempotencyKey(workspaceId: string, ownerId: string, sourceTurnRef: string): string {
  const digest = createHash('sha256').update(JSON.stringify([workspaceId, ownerId, sourceTurnRef])).digest('hex');
  return `released-operation-engineering:${digest}`;
}

export async function readReleasedOperationContinuationEligibility(input: {
  workspaceId: string;
  ownerId: string;
  prompt: string;
  sourceTurnRef: string;
  sessionRef: string;
  directiveId: number;
}): Promise<ReleasedOperationContinuationEligibility> {
  const bindingRead = await readActiveOperationWorkerClaimBinding(input.workspaceId, input.ownerId);
  if (bindingRead.status === 'unavailable') return bindingRead;
  if (bindingRead.status !== 'bound') {
    return { status: 'ineligible', reason: 'the current session has no applied accepted-operation receipt' };
  }

  const { sql } = getOrgPg();
  const [directive] = await sql<Array<{ id: number }>>`
    SELECT id
      FROM harness_shared.owner_directives
     WHERE id = ${input.directiveId}
       AND workspace_id = ${input.workspaceId}
       AND recorded_by = ${input.ownerId}
       AND session_ref = ${input.sessionRef}
       AND source_turn_ref = ${input.sourceTurnRef}
       AND verbatim_text = ${input.prompt}
       AND captured_by_hook = true
     ORDER BY id DESC
     LIMIT 1
  `;
  if (!directive) {
    return { status: 'ineligible', reason: 'no exact hook-captured owner directive backs this continuation' };
  }

  const currentClaim = await sql<Array<{ ok: number }>>`
    SELECT 1 AS ok
      FROM harness_shared.work_items AS wi
     WHERE wi.workspace_id = ${input.workspaceId}
       AND wi.feature_id = ${bindingRead.binding.workItemId}
       AND wi.harness_slug = ${bindingRead.binding.storageHarnessSlug}
       AND ${operationWorkerEffectWhereSql(sql, bindingRead, {
         payload: 'wi.payload', id: 'wi.feature_id', harness: 'wi.harness_slug', holder: 'wi.taken_by',
       })}
     LIMIT 1
  `;
  if (currentClaim.length > 0) {
    return { status: 'ineligible', reason: 'the accepted operation still holds its exact effect claim' };
  }

  return { status: 'eligible', binding: bindingRead.binding };
}

export async function continueReleasedOperation(
  input: ReleasedOperationContinuationInput,
  ctx: UnifiedToolContext,
  deps: ReleasedOperationContinuationDeps = {
    readEligibility: readReleasedOperationContinuationEligibility,
    launch: launchAgentTool.handler,
  },
) {
  if (!isHookReleasedOperationContinuationCall({ toolName: RELEASED_OPERATION_CONTINUATION_TOOL, ctx })) {
    return { data: { ok: false, launched: false, error: 'hook_origin_required' } };
  }

  const identity = resolveAgentIdentity(ctx);
  const ownerId = identity.ownerId?.trim();
  const workspaceId = identity.workspaceId?.trim();
  if (!ownerId || !workspaceId || workspaceId === '*') {
    return { data: { ok: false, launched: false, error: 'attributed_workspace_identity_required' } };
  }

  let eligibility: ReleasedOperationContinuationEligibility;
  try {
    eligibility = await deps.readEligibility({ workspaceId, ownerId, ...input });
  } catch (error) {
    return { data: { ok: false, launched: false, error: 'continuation_authority_unavailable',
      detail: error instanceof Error ? error.message : String(error) } };
  }
  if (eligibility.status !== 'eligible') {
    return { data: { ok: eligibility.status === 'ineligible', launched: false,
      status: eligibility.status, reason: eligibility.reason } };
  }

  const assignmentRef = continuationIdempotencyKey(workspaceId, ownerId, input.sourceTurnRef);
  const launch = await deps.launch({
    brief: input.prompt,
    harness: eligibility.binding.harnessSlug,
    independent: true,
    headless: false,
    label: 'Engineering continuation',
    idempotencyKey: assignmentRef,
  }, ctx as LaunchContext);
  const launchRecord = launch as unknown as Record<string, unknown>;
  if (launchRecord.isError === true) return launch;
  const launchData = launchRecord.data && typeof launchRecord.data === 'object' && !Array.isArray(launchRecord.data)
    ? launchRecord.data as Record<string, unknown> : {};
  return { ...launchRecord, data: { ...launchData,
    ok: true, launched: true, assignmentRef } };
}

export default defineTool({
  name: RELEASED_OPERATION_CONTINUATION_TOOL,
  profile: 'engineer',
  capability: 'capability:terminal',
  description:
    'Hook-only recovery door: turn a genuine owner prompt delivered to a released accepted-operation worker into one fresh, separately receipted base-SU continuation. Model clients are refused.',
  guidance: {
    when: 'Only from the first-party UserPromptSubmit OWNER branch after orders:capture has durably recorded the exact turn.',
    notWhen: 'Never call from a model, an active operation claim, or an ordinary SU session.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  timeoutSec: 180,
  skipWorkspaceTx: true,
  args: z.object({
    prompt: z.string().min(1).max(8000),
    sourceTurnRef: z.string().min(1).max(300),
    sessionRef: z.string().min(1).max(256),
    directiveId: z.number().int().positive(),
  }).strict(),
  handler: continueReleasedOperation,
});
