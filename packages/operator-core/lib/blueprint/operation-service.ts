/** Shared, internal blueprint operation service. Public defineTool registrations
 * are deliberately separate; every transport uses this service and its handles. */
import type { JSONValue, Sql } from 'postgres';
import type { TransactionSql } from 'postgres';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  operationFromSpecification, pinnedOperationRubricPackage,
  type CompiledAgentSpecification,
} from '@papercusp/orchestrator/blueprint';
import { normalizeModelId } from '@papercusp/model-pricing';
import {
  assertAdmissibleAgentOperation,
  readAcceptedBlueprintDirectWorkItem,
  type AcceptedOperationPin,
} from './operation-admission';
import { readActiveOperationModelPolicy, type ActiveOperationAttestationContext } from './operation-worker-binding';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { getWorkItem, type WorkItem } from '../work-items';
import { workItemStorageSlug } from '../pot-membership';
import { isSettledWorkItem } from '../work-items-events';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { runWithWorkspace } from '../workspace-als';
import {
  acceptBlueprintDirectWorkItem,
  acceptBlueprintPlanRun,
} from './operation-admission';
import {
  readBlueprintReprojectionAttempt,
  readOrProjectBlueprintHash,
  readBlueprintSpecificationSnapshot,
} from './project-to-pg';

/**
 * WI-10006722: an operation added by a blueprint edit that FAILED validation is absent
 * from the still-current (last valid) specification. Say why instead of the bare
 * composition `operation-not-found`, so the app author sees the loader's error.
 */
export function operationFromCurrentSpecification(
  specification: Parameters<typeof operationFromSpecification>[0],
  input: { workspaceId: string; harnessSlug: string; operationId: string },
): ReturnType<typeof operationFromSpecification> {
  try {
    return operationFromSpecification(specification, input.operationId);
  } catch (error) {
    const attempt = readBlueprintReprojectionAttempt(input.workspaceId, input.harnessSlug);
    if (!attempt || attempt.ok) throw error;
    throw new BlueprintOperationRefusal('undeclared',
      `operation "${input.operationId}" is not in the effective blueprint for ${input.harnessSlug}: ` +
        `${attempt.path} changed but failed to load, so the last valid blueprint is still in effect. ` +
        `Loader error: ${attempt.error}`);
  }
}
import { seedContentHash, type RubricSeedSource } from '../cupboard/rubric-store';
import { BlueprintOperationRefusal } from './operation-refusal';
import { storeOperationPrivateInput } from './operation-private-input';
import type { PersonalToolContext } from '../personal-vault/types';
import { assertSupportCaseInput, type SupportCaseInput } from './support-workflow-contract';
import { supportWorkflowFromOperation } from './support-workflow-operation';

/** Exported for the shared public contract (operation-contract.ts). */
export const OperationHandleSchema = z.object({
  workspaceId: z.string().min(1),
  harnessSlug: z.string().min(1),
  receiptId: z.number().int().positive(),
  operationId: z.string().min(1),
  specificationRevision: z.string().regex(/^[0-9a-f]{64}$/),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('work-item'), id: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('plan'), runId: z.number().int().positive(), instanceSlug: z.string().min(1) }).strict(),
  ]),
}).strict();

export type BlueprintOperationHandle = z.infer<typeof OperationHandleSchema>;

/** Display the current declaration only. Submission still rechecks this revision,
 * admission, funding and the employee's live source permissions. */
export async function readCurrentSupportWorkflow(sql: Sql, input: {
  workspaceId: string; harnessSlug: string; operationId: string;
}) {
  return runWithWorkspace(input.workspaceId, async () => {
    const revision = await readOrProjectBlueprintHash(sql, input.workspaceId, input.harnessSlug);
    if (!revision) return null;
    const specification = await readBlueprintSpecificationSnapshot(sql, input.workspaceId, input.harnessSlug, revision);
    if (!specification) return null;
    const { operation } = operationFromCurrentSpecification(specification, input);
    return supportWorkflowFromOperation(operation, input.harnessSlug, revision);
  });
}

export interface SubmitBlueprintOperationInput {
  workspaceId: string;
  harnessSlug: string;
  callerId: string;
  operationId: string;
  requestKey: string;
  /** Compare with the current revision; never permission to select an old one. */
  expectedSpecificationRevision?: string;
  input: Record<string, unknown>;
  /** D-014: content for the worker that must NOT enter the work-item payload.
   * Accepted only by an operation declaring privateInputSchema. */
  privateInput?: unknown;
  title?: string;
  summary?: string;
}

/** Only the durable program executor supplies this option. It stays outside the
 * public operation input so a caller cannot select an older definition. */
export interface InternalBlueprintOperationSubmission {
  expectedSpecificationRevision?: string;
  /** Verified transport identity; never a field of SubmitArgsSchema. */
  principal?: PersonalToolContext['principal'] & { trust?: string };
  /** Trusted routine caller only; never exposed in the public submission schema. */
  beforeNewAdmission?: (tx: TransactionSql) => Promise<void>;
}

type InvocationRow = {
  id: string | number;
  caller_id: string;
  operation_id: string;
  specification_revision: string;
  target_kind: 'work-item' | 'plan';
  target_ref: string | null;
  /** WI-10004562 / D-045: the work item's STORAGE slug; NULL = stored under harness_slug. */
  target_harness_slug?: string | null;
};

type PlanRunRow = {
  id: string | number;
  instance_plan_slug: string | null;
  status: string;
  outcome: string | null;
  outputs: unknown | null;
};

function checkedReceiptId(value: string | number): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid blueprint operation receipt id');
  return id;
}

/** The receipt pins the operation target on replay, even if the mutable
 * blueprint pointer has since moved to a different revision or target. */
export function submitBlueprintOperation(
  sql: Sql, input: SubmitBlueprintOperationInput, internal?: InternalBlueprintOperationSubmission,
): Promise<BlueprintOperationHandle> {
  return runWithWorkspace(input.workspaceId, async () => {
    const callerId = input.callerId?.trim();
    const requestKey = input.requestKey?.trim();
    if (!input.workspaceId?.trim() || !input.harnessSlug?.trim() || !input.operationId?.trim() ||
        !callerId || callerId.length > 200 || !requestKey || requestKey.length > 200 ||
        (input.expectedSpecificationRevision !== undefined && !/^[0-9a-f]{64}$/.test(input.expectedSpecificationRevision))) {
      throw new BlueprintOperationRefusal('invalid_request',
        'blueprint submission requires workspace, harness, operation, authenticated caller and request key');
    }
    // WI-10003631 D-030(4): the receipt and current-hash reads are independent
    // autocommit reads, so issue them together (one latency, not two). The
    // hash is used only when neither the receipt nor the caller pins a revision.
    const [previous, currentHash] = await Promise.all([
      sql<InvocationRow[]>`
      SELECT id, caller_id, operation_id, specification_revision, target_kind, target_ref
        FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
         AND caller_id = ${callerId} AND operation_id = ${input.operationId}
         AND request_key = ${requestKey}
    `,
      internal?.expectedSpecificationRevision
        ? Promise.resolve(null)
        // WI-10004001: a harness created with operations is projected lazily, so the
        // first submit projects its blueprint instead of refusing it.
        : readOrProjectBlueprintHash(sql, input.workspaceId, input.harnessSlug),
    ]);
    if (internal?.expectedSpecificationRevision && previous[0]?.specification_revision &&
        internal.expectedSpecificationRevision !== previous[0].specification_revision) {
      throw new Error('blueprint operation receipt differs from the expected specification revision');
    }
    if (input.expectedSpecificationRevision &&
        input.expectedSpecificationRevision !== (previous[0]?.specification_revision ?? currentHash) &&
        // A trusted program can pin an old revision; a public request cannot.
        !(internal?.expectedSpecificationRevision === input.expectedSpecificationRevision)) {
      throw new BlueprintOperationRefusal('input_conflict',
        'blueprint operation revision changed; reload the approved workflow before starting a new run');
    }
    const expectedSpecificationRevision = internal?.expectedSpecificationRevision ?? input.expectedSpecificationRevision;
    const beforeNewAdmission = async (tx: TransactionSql) => {
      if (input.expectedSpecificationRevision) {
        // Serialize with projection's UPDATE: promotion cannot race between the
        // displayed-revision comparison and durable admission. Replays bypass
        // this hook and retain the accepted receipt even after rollback.
        const [current] = await tx<Array<{ content_hash: string }>>`
          SELECT content_hash FROM harness_shared.blueprints
           WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
           FOR SHARE`;
        if (current?.content_hash !== input.expectedSpecificationRevision) {
          throw new BlueprintOperationRefusal('input_conflict',
            'blueprint operation revision changed; reload the approved workflow before starting a new run');
        }
      }
      await internal?.beforeNewAdmission?.(tx);
    };
    const revision = previous[0]?.specification_revision ??
      internal?.expectedSpecificationRevision ??
      currentHash;
    if (!revision) {
      throw new BlueprintOperationRefusal('undeclared',
        'harness declares no blueprint operations: no projected specification and no .papercusp/blueprint.yaml');
    }
    const specification = await readBlueprintSpecificationSnapshot(sql, input.workspaceId, input.harnessSlug, revision);
    if (!specification) throw new Error('blueprint operation specification snapshot is missing');
    const { operation } = operationFromCurrentSpecification(specification, input);
    // Validate before storing private input or creating an item/receipt. The
    // submit path reads compiled snapshots directly and cannot rely on the
    // separate blueprint authoring validator having run for this revision.
    assertAdmissibleAgentOperation(operation);
    const targetKind = previous[0]?.target_kind ?? operation.target.kind;
    if (targetKind !== operation.target.kind) throw new Error('blueprint operation receipt and pinned target disagree');

    let privateInput = input.privateInput;
    const supportWorkflow = supportWorkflowFromOperation(operation, input.harnessSlug, revision);
    if (supportWorkflow) {
      const support = operation.policy.supportCase!;
      if (!support.funding || !support.native || support.funding.organization.controlWorkspaceId !== input.workspaceId ||
          operation.policy.model?.mode !== 'exact' || operation.policy.model.models.length !== 1 ||
          operation.policy.model.models[0] !== support.native.model || operation.policy.model.effort !== support.native.effort) {
        throw new BlueprintOperationRefusal('invalid_payload', 'support workflow requires funded, revision-pinned native budget policy');
      }
      if (input.expectedSpecificationRevision !== revision || input.privateInput !== undefined) {
        throw new BlueprintOperationRefusal('invalid_payload',
          'support workflow requires the displayed approved revision and server-read case content');
      }
      const principal = internal?.principal;
      if (!principal?.slug || (callerId !== principal.slug && !callerId.startsWith(`${principal.slug}/`)) ||
          principal.workspaceId !== input.workspaceId) {
        throw new BlueprintOperationRefusal('handle_mismatch', 'support workflow requires its authenticated submitting principal');
      }
      let selection: SupportCaseInput;
      try { selection = assertSupportCaseInput(supportWorkflow, input.input as unknown as SupportCaseInput); }
      catch { throw new BlueprintOperationRefusal('invalid_payload', 'support case selection is outside the approved workflow'); }
      const { readSelectedSupportCase } = await import('./support-workflow-case');
      const selected = await readSelectedSupportCase(sql, {
        workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
        role: operation.execution?.kind === 'agent' ? operation.execution.role : undefined, principal,
      }, supportWorkflow, selection);
      if (!selected.allowed) {
        throw new BlueprintOperationRefusal('invalid_payload', `support case access refused: ${selected.reason}`);
      }
      privateInput = { supportCaseId: selection.supportCaseId,
        documents: selected.results.map(({ id, source, externalId, title, snippet }) => ({ id, source, externalId, title, snippet })) };
    }

    // D-014: private input is stored BEFORE acceptance, so the worker that claims
    // the item can always read it. Only a work-item target has a holder to read it.
    const privateInputSchema = (operation as { privateInputSchema?: Record<string, unknown> }).privateInputSchema;
    if (targetKind !== 'work-item' && (privateInputSchema || input.privateInput !== undefined)) {
      throw new BlueprintOperationRefusal('invalid_request',
        `blueprint operation "${input.operationId}" targets a plan; privateInput is only supported for work-item operations`);
    }
    await storeOperationPrivateInput(sql, {
      workspaceId: input.workspaceId, harnessSlug: input.harnessSlug, callerId,
      operationId: input.operationId, requestKey,
    }, { schema: privateInputSchema, value: privateInput, alreadyAccepted: previous.length > 0 });

    let target: BlueprintOperationHandle['target'];
    if (targetKind === 'work-item') {
      const item = await acceptBlueprintDirectWorkItem(sql, {
        workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
        callerId, requestKey, operationId: input.operationId, input: input.input,
        title: input.title?.trim() || operation.description?.trim() || operation.id,
        summary: input.summary,
        expectedSpecificationRevision,
        beforeNewAdmission,
        createdBy: callerId,
      });
      target = { kind: 'work-item', id: item.id };
    } else {
      const run = await acceptBlueprintPlanRun(sql, {
        workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
        callerId, requestKey, operationId: input.operationId, input: input.input,
        expectedSpecificationRevision,
        beforeNewAdmission,
      });
      target = { kind: 'plan', runId: run.runId, instanceSlug: run.instanceSlug };
    }
    const receipts = await sql<InvocationRow[]>`
      SELECT id, caller_id, operation_id, specification_revision, target_kind, target_ref
        FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
         AND caller_id = ${callerId} AND operation_id = ${input.operationId}
         AND request_key = ${requestKey}
    `;
    const receipt = receipts[0];
    if (!receipt || receipt.target_kind !== target.kind ||
        receipt.target_ref !== (target.kind === 'plan' ? target.instanceSlug : target.id)) {
      throw new Error('blueprint operation was accepted without a matching durable receipt');
    }
    return OperationHandleSchema.parse({
      workspaceId: input.workspaceId, harnessSlug: input.harnessSlug,
      receiptId: checkedReceiptId(receipt.id), operationId: input.operationId,
      specificationRevision: receipt.specification_revision, target,
    });
  });
}

export type BlueprintOperationPhase = 'accepted' | 'dispatched' | 'waiting' | 'terminal';
export type BlueprintOperationOutcome = 'succeeded' | 'unverified' | 'failed' | 'cancelled' | 'dropped';
export const BLUEPRINT_PROGRAM_COMPLETION_OWNER = 'system:blueprint-program';

export type BusinessReviewDecision = 'accept' | 'reject' | 'rework';
export interface BlueprintOperationBusinessReview {
  state: 'pending' | 'accepted' | 'rejected' | 'rework';
  accountableOwner: string;
  resultFingerprint: string;
  decision?: { eventId: string; reviewerPrincipal: string; reason: string; at: string };
}

export const BusinessReviewInputSchema = z.object({
  decision: z.enum(['accept', 'reject', 'rework']),
  reason: z.string().trim().min(1).max(2000),
  resultFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const BusinessReviewStateSchema = z.object({
  state: z.enum(['pending', 'accepted', 'rejected', 'rework']),
  accountableOwner: z.string(), resultFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.object({ eventId: z.string(), reviewerPrincipal: z.string(), reason: z.string(), at: z.string() }).optional(),
});

/** The reviewer is authenticated by the transport; this value is never read
 * from operation input or from a UI supplied principal alias. */
export interface BlueprintOperationReviewAccess { principalId: string }

export function assertBusinessReviewer(principalId: string, submitterId: string,
  policy: { readonly reviewerPrincipals: readonly string[] }, workerId?: string | null): void {
  if (!principalId.trim() || !policy.reviewerPrincipals.includes(principalId) ||
      submitterId === principalId || submitterId.startsWith(`${principalId}/`) ||
      workerId === principalId || workerId?.startsWith(`${principalId}/`)) {
    throw new BlueprintOperationRefusal('handle_mismatch',
      'business review requires a distinct authenticated reviewer principal named by the operation');
  }
}

function operationResultFingerprint(handle: BlueprintOperationHandle, output: unknown, evidenceRef: string,
  completionRef?: string | null): string {
  return createHash('sha256').update(canonicalJson({
    receiptId: handle.receiptId, operationId: handle.operationId,
    specificationRevision: handle.specificationRevision, output, evidenceRef, completionRef: completionRef ?? null,
  })).digest('hex');
}

/** The canonical root's completion reference carries an executor disposition,
 * but the work item remains the only business-state authority. The receipt in
 * the reference prevents a different operation's close from being read here. */
export function blueprintProgramCompletionRef(
  handle: BlueprintOperationHandle, disposition: 'succeeded' | 'failed',
): string {
  if (handle.target.kind !== 'work-item') throw new Error('program completion requires a work-item root');
  return `blueprint-program:${disposition}:receipt:${handle.receiptId}`;
}

export interface BlueprintOperationStatus {
  handle: BlueprintOperationHandle;
  phase: BlueprintOperationPhase;
  outcome: BlueprintOperationOutcome | null;
  items: Array<{ id: string; state: string; assignee: string | null }>;
  planRun: { status: string; outcome: string | null } | null;
  cancellationRequested: boolean;
  wait: { name: string; token: string } | null;
}

interface OperationControls {
  cancellationRequested: boolean;
  wait: { name: string; token: string } | null;
}

function cancellationRequested(item: WorkItem): boolean {
  return Boolean(item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) &&
    (item.payload as Record<string, unknown>).blueprintCancellation);
}

/** Classify only canonical lifecycle state. An accepted receipt is never a
 * completed result, and an assigned item is not proof of a started executor. */
export function projectBlueprintOperationStatus(
  handle: BlueprintOperationHandle,
  items: WorkItem[],
  planRun: Pick<PlanRunRow, 'status' | 'outcome'> | null = null,
  controls: OperationControls = { cancellationRequested: false, wait: null },
): BlueprintOperationStatus {
  const allSettled = items.length > 0 && items.every(isSettledWorkItem);
  const cancelling = controls.cancellationRequested || items.some(cancellationRequested);
  let outcome: BlueprintOperationOutcome | null = null;
  const dropped = (item: WorkItem) => item.state === 'dropped' || item.state === 'deprecated' || item.state === 'closed';
  const succeeded = (item: WorkItem) => item.state === 'done' || item.state === 'passed' || item.state === 'resolved';
  const childOutcome = (): BlueprintOperationOutcome => {
    if (cancelling && items.every(dropped)) return 'cancelled';
    if (handle.target.kind === 'work-item' && items.length === 1 && dropped(items[0]) &&
        items[0].terminalOwner === BLUEPRINT_PROGRAM_COMPLETION_OWNER &&
        items[0].terminalCompletionRef === blueprintProgramCompletionRef(handle, 'failed')) return 'failed';
    if (items.some(dropped)) return 'dropped';
    if (!items.every(succeeded)) return 'failed';
    return items.every((item) => item.completionAuthority === 'committed' || item.completionAuthority === 'validated')
      ? 'succeeded' : 'unverified';
  };
  if (handle.target.kind === 'plan') {
    // A child can settle before the plan run has reconciled its final outcome
    // and output. Neither child success nor DBOS dispatch alone finishes the plan.
    if (planRun?.status === 'done' && planRun.outcome === 'success') {
      if (items.length === 0) outcome = 'succeeded';
      else if (allSettled) outcome = childOutcome();
    } else if (planRun?.status === 'done' || planRun?.status === 'failed') {
      if (cancelling && allSettled && items.every(dropped)) outcome = 'cancelled';
      else if (planRun.outcome === 'skipped') outcome = 'dropped';
      else if (planRun.status === 'failed' || ['failed', 'partial', 'timed-out'].includes(planRun.outcome ?? '')) {
        outcome = 'failed';
      }
    }
  } else if (allSettled) {
    outcome = childOutcome();
  }
  const phase: BlueprintOperationPhase = outcome ? 'terminal' :
    controls.wait ? 'waiting' :
    handle.target.kind === 'plan' && allSettled ? 'waiting' :
    items.some((item) => item.state === 'blocked' || item.state === 'needs-human') ? 'waiting' :
    items.some((item) => item.assignee !== null || item.state === 'wip' || item.state === 'in-progress') ? 'dispatched' :
    'accepted';
  return {
    handle, phase, outcome,
    items: items.map((item) => ({ id: item.id, state: item.state, assignee: item.assignee })),
    planRun: planRun ? { status: planRun.status, outcome: planRun.outcome } : null,
    cancellationRequested: cancelling,
    wait: outcome ? null : controls.wait,
  };
}

async function readOperationControls(sql: Sql | TransactionSql, handle: BlueprintOperationHandle): Promise<OperationControls> {
  const writerKey = `receipt:${handle.receiptId}`;
  const rows = await sql<Array<{ cancel_requested: boolean; wait_body: unknown }>>`
    SELECT
      EXISTS(
        SELECT 1 FROM harness_shared.coord_event_log
         WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
           AND msg_id = ${eventIdentity('cancel', handle, 'once')}
      ) AS cancel_requested,
      (
        SELECT w.body FROM harness_shared.coord_event_log AS w
         WHERE w.workspace_id = ${handle.workspaceId} AND w.surface = 'blueprint-operation'
           AND w.writer_key = ${writerKey} AND w.body->>'kind' = 'wait'
           AND NOT EXISTS (
             SELECT 1 FROM harness_shared.coord_event_log AS r
              WHERE r.workspace_id = w.workspace_id AND r.surface = w.surface
                AND r.writer_key = w.writer_key AND r.body->>'kind' = 'resume'
                AND r.body->>'token' = w.body->>'token'
           )
         ORDER BY w.id DESC LIMIT 1
      ) AS wait_body
  `;
  const raw = rows[0]?.wait_body;
  const wait = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  return {
    cancellationRequested: Boolean(rows[0]?.cancel_requested),
    wait: wait && typeof wait.waitName === 'string' && typeof wait.token === 'string'
      ? { name: wait.waitName, token: wait.token } : null,
  };
}

async function readCanonicalOperation(sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  reviewAccess?: BlueprintOperationReviewAccess): Promise<{
  status: BlueprintOperationStatus;
  items: WorkItem[];
  run: PlanRunRow | null;
}> {
  const ref = OperationHandleSchema.parse(handle);
  const receipts = await sql<InvocationRow[]>`
    SELECT id, caller_id, operation_id, specification_revision, target_kind, target_ref,
           target_harness_slug
      FROM harness_shared.blueprint_operation_invocations
     WHERE id = ${ref.receiptId} AND workspace_id = ${ref.workspaceId}
       AND harness_slug = ${ref.harnessSlug}
  `;
  const receipt = receipts[0];
  if (!receipt || (!reviewAccess && receipt.caller_id !== callerId.trim()) || receipt.operation_id !== ref.operationId ||
      receipt.specification_revision !== ref.specificationRevision ||
      receipt.target_kind !== ref.target.kind ||
      receipt.target_ref !== (ref.target.kind === 'plan' ? ref.target.instanceSlug : ref.target.id)) {
    throw new BlueprintOperationRefusal('handle_mismatch', 'blueprint operation handle does not match its durable receipt');
  }
  if (reviewAccess) {
    const operation = await declaredOperation(sql, ref);
    if (!operation.acceptance.businessReview) throw new BlueprintOperationRefusal('undeclared', 'operation declares no business review');
    assertBusinessReviewer(reviewAccess.principalId, receipt.caller_id, operation.acceptance.businessReview);
  }
  const controls = await readOperationControls(sql, ref);
  if (ref.target.kind === 'work-item') {
    // WI-10004360: the accepted item is stored under the harness's pot home slug when the
    // harness is a pot MEMBER, so address it (and bound it) by that storage slug.
    // WI-10004562 / D-045: admission records that slug on the receipt row read above, so
    // the per-read pot lookup runs only for a receipt written before migration 1282.
    const storageHarness = receipt.target_harness_slug
      ?? await workItemStorageSlug(ref.harnessSlug, ref.workspaceId);
    const item = await getWorkItem(ref.target.id, storageHarness);
    if (!item || item.harness !== storageHarness) throw new Error('blueprint operation work item is missing or outside its harness');
    const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? item.payload as Record<string, unknown> : null;
    const pin = payload?.blueprintOperation && typeof payload.blueprintOperation === 'object' &&
      !Array.isArray(payload.blueprintOperation) ? payload.blueprintOperation as Record<string, unknown> : null;
    if (!pin || pin.kind !== 'blueprint-operation' || pin.operationId !== ref.operationId ||
        pin.specificationRevision !== ref.specificationRevision || pin.callerId !== receipt.caller_id) {
      throw new Error('blueprint operation receipt and canonical work item pin disagree');
    }
    return { status: projectBlueprintOperationStatus(ref, [item], null, controls), items: [item], run: null };
  }
  const runs = await sql<PlanRunRow[]>`
    SELECT id, instance_plan_slug, status, outcome, outputs
      FROM harness_shared.plan_runs
     WHERE id = ${ref.target.runId} AND workspace_id = ${ref.workspaceId}
       AND harness_slug = ${ref.harnessSlug} AND instance_plan_slug = ${ref.target.instanceSlug}
  `;
  const run = runs[0];
  if (!run) throw new Error('blueprint operation plan run is missing or outside its harness');
  const rows = await sql<Array<{ feature_id: string; harness_slug: string }>>`
    SELECT feature_id, harness_slug FROM harness_shared.work_items
     WHERE workspace_id = ${ref.workspaceId}
       AND payload->'plan_run'->>'runId' = ${String(ref.target.runId)}
       AND payload->'plan_run'->>'instancePlanSlug' = ${ref.target.instanceSlug}
     ORDER BY feature_id
  `;
  const items = await Promise.all(rows.map(async ({ feature_id, harness_slug }) => {
    const item = await getWorkItem(feature_id, harness_slug);
    if (!item || item.harness !== harness_slug) throw new Error('blueprint plan run item disappeared');
    return item;
  }));
  return { status: projectBlueprintOperationStatus(ref, items, run, controls), items, run };
}

export function getBlueprintOperationStatus(sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  reviewAccess?: BlueprintOperationReviewAccess): Promise<BlueprintOperationStatus> {
  return runWithWorkspace(handle.workspaceId, async () => (await readValidatedCanonicalOperation(sql, handle, callerId, reviewAccess)).status);
}

/** Receipt-bound worker attribution, distinct from the app that submitted it.
 * Uses the same receipt/payload checks as the lifecycle readers. */
export function getBlueprintOperationTerminalWorker(sql: Sql, handle: BlueprintOperationHandle, callerId: string) {
  return runWithWorkspace(handle.workspaceId, async () => {
    const { status, items, result } = await readValidatedCanonicalOperation(sql, handle, callerId);
    const { operation } = await declaredOperationWithSpecification(sql, handle);
    if (handle.target.kind !== 'work-item' || operation.execution?.kind !== 'agent' ||
        status.phase !== 'terminal' || status.outcome !== 'succeeded' || !items?.[0] || !result) {
      throw new Error('review operation must be a successful terminal agent work item');
    }
    return { ...terminalOperationWorkerProof(items[0]), output: result.output, evidenceRef: result.evidenceRef };
  });
}

/** Pure projection after canonical receipt validation; never caller-supplied identity. */
export function terminalOperationWorkerProof(item: WorkItem) {
  const pin = (item.payload as { blueprintOperation?: AcceptedOperationPin } | null)?.blueprintOperation;
  if (!item.terminalOwner || !item.terminalCompletionRef ||
      !['committed', 'validated'].includes(item.completionAuthority ?? '') || !pin?.input) {
    throw new Error('review operation has no accountable terminal worker evidence');
  }
  return { ownerId: item.terminalOwner, completionRef: item.terminalCompletionRef, input: pin.input };
}

/** Issue-family kinds, exactly the `engineer_issues` view predicate. */
const ISSUE_FAMILY_KINDS: ReadonlySet<string> = new Set(['bug', 'change', 'task']);

export interface AcceptedProgramRootGuard {
  terminal: boolean;
  cancellationRequested: boolean;
  /** The root row's family, read from `work_items` in the handle's harness. */
  family: 'issue' | 'feature';
  /** The `harness_slug` the root row is STORED under: the pot home slug for a pot member's
   * root (WI-10004562 / D-045), else the operation harness. Row writes (settlement, cancel)
   * address the root by this; receipt and pin comparisons keep `handle.harnessSlug`. */
  storageHarnessSlug: string;
}

/** One-round-trip liveness guard for an accepted program's root work item
 * (WI-10003631). A running coord program checks this before each op step.
 * The full status read costs four round trips (receipt, controls, issue view,
 * feature row) and its receipt check re-proves what the workflow proved when
 * it started (`loadAcceptedCoordProgramBlueprint`); the handle is immutable
 * workflow input. This answers the same two predicates the step guard reads
 * from `projectBlueprintOperationStatus`: phase terminal (root settled) and
 * cancellation (cancel event, or the root's `blueprintCancellation` mark).
 *
 * With `receiptCallerId`, the same round trip also proves the durable receipt
 * matches the handle and caller — the exact predicate `readCanonicalOperation`
 * refuses `handle_mismatch` on — so a program start can validate its receipt
 * and read root liveness in one statement, and take the full canonical result
 * read only when the root has already settled (crash replay). */
export async function readAcceptedProgramRootGuard(
  sql: Sql, handle: BlueprintOperationHandle, receiptCallerId?: string,
): Promise<AcceptedProgramRootGuard> {
  if (handle.target.kind !== 'work-item') {
    throw new Error('accepted program root guard requires a work-item target');
  }
  const ref = receiptCallerId === undefined ? null : OperationHandleSchema.parse(handle);
  const rows = await sql<Array<{
    status: string | null; item_kind: string | null; marked: boolean | null; cancel_requested: boolean;
    receipt_ok: boolean | null; harness_slug: string | null;
  }>>`
    SELECT wi.status, wi.item_kind, wi.harness_slug,
           ${ref ? sql`EXISTS(
             SELECT 1 FROM harness_shared.blueprint_operation_invocations AS r
              WHERE r.id = ${ref.receiptId} AND r.workspace_id = ${ref.workspaceId}
                AND r.harness_slug = ${ref.harnessSlug} AND r.caller_id = ${receiptCallerId!.trim()}
                AND r.operation_id = ${ref.operationId}
                AND r.specification_revision = ${ref.specificationRevision}
                AND r.target_kind = 'work-item' AND r.target_ref = ${handle.target.id}
           )` : sql`NULL::boolean`} AS receipt_ok,
           (wi.payload ? 'blueprintCancellation'
             AND COALESCE(wi.payload->'blueprintCancellation', 'null'::jsonb) NOT IN ('null'::jsonb, 'false'::jsonb)) AS marked,
           EXISTS(
             SELECT 1 FROM harness_shared.coord_event_log
              WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
                AND msg_id = ${eventIdentity('cancel', handle, 'once')}
           ) AS cancel_requested
      FROM (SELECT 1) AS one
      LEFT JOIN harness_shared.work_items AS wi
        ON wi.workspace_id = ${handle.workspaceId}
       -- WI-10004562 / D-045: a pot member's root is stored under the pot home slug the
       -- receipt records; a pre-1282 receipt (NULL) keeps the operation harness slug.
       AND wi.harness_slug = COALESCE((
             SELECT r.target_harness_slug FROM harness_shared.blueprint_operation_invocations AS r
              WHERE r.id = ${handle.receiptId} AND r.workspace_id = ${handle.workspaceId}
                AND r.harness_slug = ${handle.harnessSlug}
           ), ${handle.harnessSlug})
       AND wi.feature_id = ${handle.target.id}
  `;
  // The LEFT JOIN always yields one row, so the receipt verdict is independent
  // of the root row and the error order matches the canonical read: receipt
  // mismatch first, then a missing root.
  const row = rows[0];
  if (ref && row?.receipt_ok !== true) {
    throw new BlueprintOperationRefusal('handle_mismatch', 'blueprint operation handle does not match its durable receipt');
  }
  if (!row || row.status === null || !row.harness_slug) {
    throw new Error('blueprint operation work item is missing or outside its harness');
  }
  const family = ISSUE_FAMILY_KINDS.has(row.item_kind ?? '') ? 'issue' : 'feature';
  return {
    terminal: isSettledWorkItem({ family, state: row.status } as Pick<WorkItem, 'family' | 'state'>),
    cancellationRequested: row.cancel_requested || row.marked === true,
    family,
    storageHarnessSlug: row.harness_slug,
  };
}

/** Exported for the shared public contract (operation-contract.ts). */
export const OperationEventBodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('native-budget-reservation'), receiptId: z.number().int().positive(),
    attemptId: z.string().uuid(), maximumCostMicros: z.number().int().positive(),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/), reservationId: z.string().regex(/^[0-9a-f]{64}$/),
    specificationRevision: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    kind: z.literal('business-review'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    specificationRevision: z.string().regex(/^[0-9a-f]{64}$/),
    resultFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    evidenceRef: z.string().min(1), accountableOwner: z.string().min(1),
    reviewerPrincipal: z.string().min(1), decision: z.enum(['accept', 'reject', 'rework']),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal('work-item'), workItemId: z.string().min(1),
    runId: z.string().nullable(), harnessSlug: z.string().min(1),
    state: z.string().min(1), prevState: z.string().nullable(),
    assignee: z.string().nullable(), outputStored: z.boolean(),
    cancellationRequested: z.boolean(),
  }),
  z.object({
    kind: z.literal('plan-run'), runId: z.string().min(1),
    instanceSlug: z.string().min(1), harnessSlug: z.string().min(1),
    status: z.string().min(1), prevStatus: z.string().nullable(),
    outcome: z.string().nullable(), outputStored: z.boolean(),
  }),
  z.object({
    kind: z.literal('cancel'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    requestedBy: z.string().min(1), reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal('signal'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    channel: z.string().min(1), payload: z.unknown(),
  }),
  z.object({
    kind: z.literal('wait'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    waitName: z.string().min(1), token: z.string().min(1),
  }),
  z.object({
    kind: z.literal('resume'), receiptId: z.number().int().positive(),
    workItemId: z.string().nullable(), runId: z.string().nullable(),
    waitName: z.string().min(1), token: z.string().min(1), response: z.unknown(),
  }),
  z.object({
    kind: z.literal('model-attestation'), receiptId: z.number().int().positive(),
    workItemId: z.string().min(1), runId: z.null(),
    ownerId: z.string().min(1), nativeSessionId: z.string().min(1),
    requestId: z.string().uuid(), providerResponseId: z.string().min(1),
    backend: z.enum(['claude', 'omp', 'codex']), provider: z.string().min(1),
    requestedModel: z.string().min(1), actualModel: z.string().min(1),
    forwardedEffort: z.string().nullable(), effortSource: z.enum(['forwarded-request', 'unavailable']),
    providerEffort: z.string().min(1).nullable().optional(),
    usage: z.object({ inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
      cacheReadTokens: z.number().int().nonnegative().nullable(),
      cacheCreationTokens: z.number().int().nonnegative().nullable(),
      inputTokenBasis: z.enum(['uncached', 'inclusive']).optional() }).strict(),
    source: z.literal('gateway'),
  }),
  z.object({
    // Preserve the original attestation and the verified origin after the
    // gateway's shorter-lived diagnostic outcome ledger expires.
    kind: z.literal('model-attestation-origin'), receiptId: z.number().int().positive(),
    workItemId: z.string().min(1), runId: z.null(),
    originalEventId: z.string().regex(/^[1-9][0-9]*$/),
    attestationHash: z.string().regex(/^[0-9a-f]{64}$/),
    ownerId: z.string().min(1), nativeSessionId: z.string().min(1), providerResponseId: z.string().min(1),
    gatewayOutcome: z.object({
      requestId: z.string().min(1), provider: z.literal('codex'), protocol: z.literal('openai-responses'),
      outcomeClass: z.literal('ok'), finalStatus: z.number().int().min(200).max(299),
      nativeSessionId: z.string().min(1), nativeThreadId: z.string().min(1),
    }).strict(),
    source: z.literal('gateway-outcomes'),
  }),
]);

export type BlueprintOperationEvent = z.infer<typeof OperationEventBodySchema> & {
  cursor: string;
  at: string;
};

/** Cursor replay reads the existing append-only coord event log, while the
 * snapshot comes from the canonical target. A reconnect always receives the
 * latest outcome even if it started before this event writer was installed. */
export function getBlueprintOperationEvents(
  sql: Sql,
  handle: BlueprintOperationHandle,
  callerId: string,
  options: { cursor?: string; limit?: number; reviewAccess?: BlueprintOperationReviewAccess } = {},
): Promise<{ status: BlueprintOperationStatus; events: BlueprintOperationEvent[]; cursor: string; hasMore: boolean }> {
  return runWithWorkspace(handle.workspaceId, async () => {
    const cursor = options.cursor ?? '0';
    if (!/^(0|[1-9][0-9]*)$/.test(cursor)) {
      throw new BlueprintOperationRefusal('invalid_request', 'blueprint operation cursor must be a decimal event id');
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const { status } = await readValidatedCanonicalOperation(sql, handle, callerId, options.reviewAccess);
    const rows = handle.target.kind === 'work-item'
      ? await sql<Array<{ id: string | number; ts: Date | string; body: unknown }>>`
          SELECT id, ts, body FROM harness_shared.coord_event_log
           WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
             AND body->>'workItemId' = ${handle.target.id} AND id > ${cursor}::bigint
           ORDER BY id LIMIT ${limit + 1}
        `
      : await sql<Array<{ id: string | number; ts: Date | string; body: unknown }>>`
          SELECT id, ts, body FROM harness_shared.coord_event_log
           WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
             AND body->>'runId' = ${String(handle.target.runId)} AND id > ${cursor}::bigint
           ORDER BY id LIMIT ${limit + 1}
        `;
    const page = rows.slice(0, limit);
    const events = page.map((row) => ({
      ...OperationEventBodySchema.parse(row.body),
      cursor: String(row.id), at: new Date(row.ts).toISOString(),
    }));
    return { status, events, cursor: events.at(-1)?.cursor ?? cursor, hasMore: rows.length > limit };
  });
}

function targetEventFields(handle: BlueprintOperationHandle): { workItemId: string | null; runId: string | null } {
  return handle.target.kind === 'work-item'
    ? { workItemId: handle.target.id, runId: null }
    : { workItemId: null, runId: String(handle.target.runId) };
}

function eventIdentity(kind: string, handle: BlueprintOperationHandle, key: string): string {
  return kind + ':' + createHash('sha256').update(canonicalJson({ receiptId: handle.receiptId, key })).digest('hex');
}

/** Caller input is a refusal; a non-lossless stored OUTPUT is an internal defect. */
function losslessJsonFailure(kind: 'input' | 'output'): Error {
  const message = `blueprint operation ${kind} must be lossless JSON`;
  return kind === 'input' ? new BlueprintOperationRefusal('invalid_payload', message) : new Error(message);
}

function exactJsonValue(value: unknown, kind: 'input' | 'output' = 'input'): unknown {
  let saved: unknown;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('not JSON');
    saved = JSON.parse(encoded);
  } catch {
    throw losslessJsonFailure(kind);
  }
  if (!isDeepStrictEqual(saved, value)) throw losslessJsonFailure(kind);
  return saved;
}

async function appendControlEvent(
  sql: Sql | TransactionSql,
  handle: BlueprintOperationHandle,
  msgId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; replayed: boolean }> {
  const fingerprint = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const saved = JSON.stringify({ ...body, fingerprint });
  const inserted = await sql<Array<{ id: string | number }>>`
    INSERT INTO harness_shared.coord_event_log
      (workspace_id, surface, writer_key, msg_id, body)
    VALUES (${handle.workspaceId}, 'blueprint-operation', ${`receipt:${handle.receiptId}`},
            ${msgId}, ${saved}::text::jsonb)
    ON CONFLICT DO NOTHING RETURNING id
  `;
  if (inserted[0]) return { id: String(inserted[0].id), replayed: false };
  const prior = await sql<Array<{ id: string | number; body: Record<string, unknown> }>>`
    SELECT id, body FROM harness_shared.coord_event_log
     WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
       AND msg_id = ${msgId}
  `;
  if (!prior[0] || prior[0].body.fingerprint !== fingerprint) {
    throw new BlueprintOperationRefusal('input_conflict', 'blueprint operation control key was reused with different input');
  }
  return { id: String(prior[0].id), replayed: true };
}

export type DirectOperationModelAttestation = Omit<
  Extract<z.infer<typeof OperationEventBodySchema>, { kind: 'model-attestation' }>,
  'kind' | 'receiptId' | 'workItemId' | 'runId' | 'ownerId' | 'nativeSessionId' | 'source'
>;

/** Append provider-observed request evidence to the operation's existing
 * receipt-keyed event stream. This is evidence, not a second usage sample:
 * counted tokens remain on agent_usage_samples. Re-read the applied worker
 * binding so a stale or caller-forged context cannot append to another task. */
export function recordDirectOperationModelAttestation(
  sql: Sql,
  context: ActiveOperationAttestationContext,
  input: DirectOperationModelAttestation,
): Promise<{ id: string; replayed: boolean }> {
  return runWithWorkspace(context.workspaceId, async () => {
    const read = await readActiveOperationModelPolicy(context.workspaceId, context.ownerId, input.backend);
    if (read.status !== 'bound' || !read.attestation || !isDeepStrictEqual(read.attestation, context)) {
      throw new Error('blueprint model attestation requires the current applied operation receipt');
    }
    if ((input.forwardedEffort === null) !== (input.effortSource === 'unavailable')) {
      throw new Error('blueprint model attestation effort source contradicts its value');
    }
    if (input.providerEffort && input.forwardedEffort && input.providerEffort !== input.forwardedEffort) {
      throw new Error('blueprint model attestation provider effort contradicts forwarded effort');
    }
    if ((input.backend === 'codex' &&
          (input.provider !== 'openai' || input.usage.inputTokenBasis !== 'inclusive')) ||
        (input.backend === 'claude' &&
          (input.provider !== 'anthropic' || input.usage.inputTokenBasis === 'inclusive'))) {
      throw new Error('blueprint model attestation provider or token basis differs from backend');
    }
    const body = OperationEventBodySchema.parse({
      ...input,
      kind: 'model-attestation', receiptId: context.operationReceiptId,
      workItemId: context.workItemId, runId: null,
      ownerId: context.ownerId, nativeSessionId: context.nativeSessionId,
      source: 'gateway',
    });
    const handle: BlueprintOperationHandle = {
      workspaceId: context.workspaceId, harnessSlug: context.harnessSlug,
      receiptId: context.operationReceiptId, operationId: context.operationId,
      specificationRevision: context.specificationRevision,
      target: { kind: 'work-item', id: context.workItemId },
    };
    return appendControlEvent(sql, handle,
      eventIdentity('model-attestation', handle, `${context.nativeSessionId}:${input.providerResponseId}`), body);
  });
}

async function declaredOperation(sql: Sql, handle: BlueprintOperationHandle) {
  return (await declaredOperationWithSpecification(sql, handle)).operation;
}

async function declaredOperationWithSpecification(sql: Sql, handle: BlueprintOperationHandle) {
  const specification = await readBlueprintSpecificationSnapshot(
    sql, handle.workspaceId, handle.harnessSlug, handle.specificationRevision,
  );
  if (!specification) throw new Error('blueprint operation specification snapshot is missing');
  return { operation: operationFromSpecification(specification, handle.operationId).operation, specification };
}

async function notifyControl(key: string, eventId: string, payload: unknown): Promise<boolean> {
  try {
    const { emitAwaitedEvent } = await import('../events/await/engine');
    await emitAwaitedEvent({ key, source: 'blueprint-operation', summary: `Blueprint operation input ${eventId}`, payload });
    return true;
  } catch {
    // The input is committed to the append-only log. A worker must replay it
    // from its cursor; a wake notification alone is never delivery proof.
    return false;
  }
}

export interface BlueprintOperationInputReceipt {
  eventId: string;
  replayed: boolean;
  accepted: true;
  wakeQueued: boolean;
  handled: false;
}

/** Cancellation is an append-only request plus a marker on each canonical
 * unfinished item. It never pretends to have fenced a running attempt. */
export function cancelBlueprintOperation(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { requestKey: string; reason: string },
  internal?: { inTransaction: true; requestedBy: string },
): Promise<BlueprintOperationInputReceipt & { effected: boolean }> {
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationInputReceipt & { effected: boolean }> => {
    const { status, items } = await readCanonicalOperation(sql, handle, callerId);
    if (!input.requestKey?.trim() || !input.reason?.trim()) {
      throw new BlueprintOperationRefusal('invalid_request', 'blueprint cancellation requires a key and reason');
    }
    if (status.phase === 'terminal' && !status.cancellationRequested) {
      throw new BlueprintOperationRefusal('terminal', 'cannot cancel a terminal blueprint operation');
    }
    const body = { kind: 'cancel', receiptId: handle.receiptId, ...targetEventFields(handle),
      requestedBy: internal?.requestedBy ?? callerId, requestKey: input.requestKey, reason: input.reason.trim() };
    const save = async (tx: Sql | TransactionSql) => {
      const saved = await appendControlEvent(tx, handle, eventIdentity('cancel', handle, 'once'), body);
      const marker = JSON.stringify({ eventId: saved.id, requestedBy: internal?.requestedBy ?? callerId, reason: input.reason.trim() });
      for (const item of items) {
        if (isSettledWorkItem(item)) continue;
        await tx`
          UPDATE harness_shared.work_items
             SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{blueprintCancellation}',
                                     ${marker}::text::jsonb, true)
           WHERE workspace_id = ${handle.workspaceId} AND harness_slug = ${item.harness}
             AND feature_id = ${item.id} AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
        `;
      }
      return saved;
    };
    const receipt = internal?.inTransaction ? await save(sql) : await sql.begin(save);
    const current = await readCanonicalOperation(sql, handle, callerId);
    const effected = current.status.outcome === 'cancelled';
    const wakeQueued = current.status.phase === 'terminal' ? false : await notifyControl(
      `blueprint-operation:cancel:${handle.receiptId}`, receipt.id, body,
    );
    return { eventId: receipt.id, replayed: receipt.replayed, accepted: true,
      wakeQueued, handled: false, effected };
  });
}

/** A signal is durably accepted and wakes interested workers. Handling is a
 * separate worker acknowledgement; the receipt never calls a wake a result. */
export function signalBlueprintOperation(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { channel: string; payload: unknown; requestKey: string },
  reviewAccess?: BlueprintOperationReviewAccess,
): Promise<BlueprintOperationInputReceipt> {
  if (input.channel === 'business-review') return reviewBlueprintOperation(sql, handle, callerId, input, reviewAccess);
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationInputReceipt> => {
    const { status } = await readCanonicalOperation(sql, handle, callerId);
    if (!input.requestKey?.trim()) throw new BlueprintOperationRefusal('invalid_request', 'blueprint signal requires a request key');
    const operation = await declaredOperation(sql, handle);
    const schema = operation.signals[input.channel]?.payloadSchema;
    if (!schema) throw new BlueprintOperationRefusal('undeclared', 'blueprint operation signal channel is not declared');
    const payload = exactJsonValue(input.payload);
    const valid = checkAgainstJsonSchema(schema, payload);
    if (!valid.ok) {
      throw new BlueprintOperationRefusal('invalid_payload', `blueprint signal payload is invalid: ${valid.errors.join('; ')}`);
    }
    const body = { kind: 'signal', receiptId: handle.receiptId, ...targetEventFields(handle),
      channel: input.channel, payload, requestKey: input.requestKey };
    const msgId = eventIdentity('signal', handle, `${input.channel}:${input.requestKey}`);
    if (status.phase === 'terminal') {
      const prior = await sql<Array<{ id: string | number }>>`
        SELECT id FROM harness_shared.coord_event_log
         WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation' AND msg_id = ${msgId}
      `;
      if (!prior[0]) throw new BlueprintOperationRefusal('terminal', 'cannot signal a terminal blueprint operation');
    }
    const receipt = await appendControlEvent(sql, handle, msgId, body);
    const wakeQueued = status.phase === 'terminal' ? false : await notifyControl(
      `blueprint-operation:signal:${handle.receiptId}:${input.channel}`, receipt.id, body,
    );
    return { eventId: receipt.id, replayed: receipt.replayed, accepted: true, wakeQueued, handled: false };
  });
}

/** The trusted executor declares a stable wait token before suspending. A
 * response is accepted only for that exact outstanding token. */
export function openBlueprintOperationWait(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { waitName: string; token: string },
): Promise<{ eventId: string; replayed: boolean }> {
  return runWithWorkspace(handle.workspaceId, async () => {
    const { status } = await readCanonicalOperation(sql, handle, callerId);
    if (status.phase === 'terminal') throw new Error('cannot open a wait on a terminal blueprint operation');
    if (!input.token?.trim()) throw new Error('blueprint wait token is required');
    const operation = await declaredOperation(sql, handle);
    if (!operation.waits[input.waitName]) throw new Error('blueprint operation wait is not declared');
    const body = { kind: 'wait', receiptId: handle.receiptId, ...targetEventFields(handle),
      waitName: input.waitName, token: input.token };
    const receipt = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`blueprint-wait:${handle.workspaceId}:${handle.receiptId}`}, 0))`;
      const current = await readOperationControls(tx, handle);
      if (current.wait && current.wait.token !== input.token) {
        throw new Error('blueprint operation already has a different outstanding wait');
      }
      const responses = await tx<Array<{ id: string | number }>>`
        SELECT id FROM harness_shared.coord_event_log
         WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
           AND msg_id = ${eventIdentity('resume', handle, input.token)}
      `;
      if (responses[0]) throw new Error('blueprint operation wait token was already resumed');
      return appendControlEvent(tx, handle, eventIdentity('wait', handle, input.token), body);
    });
    return { eventId: receipt.id, replayed: receipt.replayed };
  });
}

export function resumeBlueprintOperation(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { token: string; response: unknown; requestKey: string },
): Promise<BlueprintOperationInputReceipt> {
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationInputReceipt> => {
    const { status } = await readCanonicalOperation(sql, handle, callerId);
    if (!input.token?.trim() || !input.requestKey?.trim()) {
      throw new BlueprintOperationRefusal('invalid_request', 'blueprint resume requires a wait token and request key');
    }
    const waits = await sql<Array<{ body: Record<string, unknown> }>>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
         AND msg_id = ${eventIdentity('wait', handle, input.token)}
    `;
    const waitName = waits[0]?.body.waitName;
    if (waits[0]?.body.receiptId !== handle.receiptId || typeof waitName !== 'string') {
      throw new BlueprintOperationRefusal('stale_wait', 'blueprint operation wait token is stale or outside this operation');
    }
    const prior = await sql<Array<{ id: string | number }>>`
      SELECT id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
         AND msg_id = ${eventIdentity('resume', handle, input.token)}
    `;
    if ((!status.wait || status.wait.token !== input.token || status.phase === 'terminal') && !prior[0]) {
      throw new BlueprintOperationRefusal('stale_wait', 'blueprint operation wait token is no longer outstanding');
    }
    const operation = await declaredOperation(sql, handle);
    const schema = operation.waits[waitName]?.responseSchema;
    if (!schema) throw new BlueprintOperationRefusal('undeclared', 'blueprint operation wait is no longer declared');
    const response = exactJsonValue(input.response);
    const valid = checkAgainstJsonSchema(schema, response);
    if (!valid.ok) {
      throw new BlueprintOperationRefusal('invalid_payload', `blueprint resume response is invalid: ${valid.errors.join('; ')}`);
    }
    const body = { kind: 'resume', receiptId: handle.receiptId, ...targetEventFields(handle),
      waitName, token: input.token, response, requestKey: input.requestKey };
    const receipt = await appendControlEvent(sql, handle, eventIdentity('resume', handle, input.token), body);
    const wakeQueued = status.phase === 'terminal' ? false :
      await notifyControl(`blueprint-operation:resume:${handle.receiptId}:${input.token}`, receipt.id, body);
    return { eventId: receipt.id, replayed: receipt.replayed, accepted: true, wakeQueued, handled: false };
  });
}

export type BlueprintOperationResult =
  | { state: 'pending'; status: BlueprintOperationStatus }
  | { state: 'failed' | 'cancelled' | 'dropped' | 'unavailable'; status: BlueprintOperationStatus; reason: string }
  | { state: 'ready'; status: BlueprintOperationStatus; output: unknown; evidenceRef: string;
      acceptanceEvidenceRef?: string; businessReview?: BlueprintOperationBusinessReview };

/** A launch selector or a requested model cannot prove what served a turn.
 * Claude transcripts carry provider message ids. Codex turn_context carries
 * requested model only, so its provider event supplies actual model and its
 * request-grain transcript supplies an independently counted usage multiset. */
async function verifyDirectOperationModel(
  sql: Sql,
  workspaceId: string,
  workItemId: string,
  pin: Record<string, unknown>,
  policy: { mode: 'exact' | 'allowed' | 'preferred'; models: readonly string[]; effort?: string },
  persistOrigins = false,
  forceNativeHistory = false,
  usageCatchupAttempted = false,
): Promise<string | null> {
  if (pin.kind !== 'blueprint-operation' || typeof pin.harnessSlug !== 'string' ||
      typeof pin.operationId !== 'string' || typeof pin.specificationRevision !== 'string') {
    return 'accepted operation model pin is malformed';
  }
  const acceptedPin = pin as AcceptedOperationPin;
  const [invocation] = await sql<Array<{ id: string | number }>>`
    SELECT id FROM harness_shared.blueprint_operation_invocations
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${acceptedPin.harnessSlug}
       AND target_kind = 'work-item' AND target_ref = ${workItemId}
       AND operation_id = ${acceptedPin.operationId}
       AND specification_revision = ${acceptedPin.specificationRevision}
       AND caller_id = ${acceptedPin.callerId ?? null} AND request_key = ${acceptedPin.requestKey ?? null}
       AND request_fingerprint = ${acceptedPin.requestFingerprint ?? null}
  `;
  if (!invocation) return 'accepted operation has no durable model attestation receipt';
  const receiptId = Number(invocation.id);
  if (!Number.isSafeInteger(receiptId) || receiptId <= 0) return 'accepted operation model receipt is invalid';
  const rows = await sql<Array<{
    agent: string | null; owner_id: string | null; native_session_id: string | null;
    model: string | null; provider: string | null; model_source: string | null;
    grain: string | null; source_id: string | null;
    input_total_tokens: string | number | null;
    input_tokens: string | number | null; output_tokens: string | number | null;
    cache_read_tokens: string | number | null; cache_creation_tokens: string | number | null;
  }>>`
    SELECT s.agent, s.coord_owner_id AS owner_id, s.session_id AS native_session_id,
           u.model, u.provider, u.input_tokens, u.output_tokens,
           u.cache_read_tokens, u.cache_creation_tokens,
           u.usage_provenance->>'modelSource' AS model_source,
           u.usage_provenance->>'grain' AS grain,
           u.usage_provenance->>'sourceId' AS source_id,
           u.usage_provenance->>'inputTotalTokens' AS input_total_tokens
      FROM harness_shared.adv_sessions s
      LEFT JOIN harness_shared.agent_usage_samples u
        ON u.workspace_id = s.workspace_id AND u.session_id = s.session_id
       AND u.source = 'interactive'
     WHERE s.workspace_id = ${workspaceId}
       AND s.feature = ${workItemId}
       AND s.launch_spec->'acceptedOperation'->'pin' = ${sql.json(pin as JSONValue)}
     ORDER BY s.id, u.id
     LIMIT 1001
  `;
  if (!rows.length) return 'no accepted worker session reported an actual model';
  if (rows.length > 1000) return 'model evidence exceeds the bounded verification window';
  const eventRows = await sql<Array<{ id: string | number; body: unknown }>>`
    SELECT id, body FROM harness_shared.coord_event_log
     WHERE workspace_id = ${workspaceId} AND surface = 'blueprint-operation'
       AND writer_key = ${`receipt:${receiptId}`}
       AND body->>'kind' IN ('model-attestation', 'model-attestation-origin')
       AND body->>'workItemId' = ${workItemId}
     ORDER BY id LIMIT 1001
  `;
  if (eventRows.length > 1000) return 'model attestation events exceed the bounded verification window';
  const events = new Map<string, Extract<z.infer<typeof OperationEventBodySchema>, { kind: 'model-attestation' }>>();
  const eventIds = new Map<string, string>();
  type AttestationOrigin = Extract<z.infer<typeof OperationEventBodySchema>, { kind: 'model-attestation-origin' }>;
  const origins = new Map<string, AttestationOrigin>();
  for (const row of eventRows) {
    const parsed = OperationEventBodySchema.safeParse(row.body);
    if (!parsed.success ||
        (parsed.data.kind !== 'model-attestation' && parsed.data.kind !== 'model-attestation-origin') ||
        parsed.data.receiptId !== receiptId) {
      return 'accepted worker has malformed model attestation';
    }
    if (parsed.data.kind === 'model-attestation-origin') {
      if (origins.has(parsed.data.originalEventId)) return 'accepted worker has duplicate model attestation origin';
      origins.set(parsed.data.originalEventId, parsed.data);
      continue;
    }
    const event = parsed.data;
    const key = `${event.nativeSessionId}:${event.providerResponseId}`;
    if (events.has(key)) return 'accepted worker has duplicate model attestation';
    events.set(key, event);
    eventIds.set(key, String(row.id));
  }
  const currentNatives = new Set(rows.map(row => row.native_session_id));
  const readNativeHistory = forceNativeHistory || events.size > rows.length ||
    [...events.values()].some(event => !currentNatives.has(event.nativeSessionId));
  if (readNativeHistory) {
    // A managed carry replaces adv_sessions.session_id in place. Its applied
    // identity ledger, not an owner-only usage join, proves the predecessor
    // belongs to this exact accepted launch. DISTINCT prevents repeated
    // activations from counting a request more than once.
    const historicalRows = await sql<typeof rows>`
      SELECT s.agent, s.coord_owner_id AS owner_id, n.native_session_id,
             u.model, u.provider, u.input_tokens, u.output_tokens,
             u.cache_read_tokens, u.cache_creation_tokens,
             u.usage_provenance->>'modelSource' AS model_source,
             u.usage_provenance->>'grain' AS grain,
             u.usage_provenance->>'sourceId' AS source_id,
             u.usage_provenance->>'inputTotalTokens' AS input_total_tokens
        FROM harness_shared.adv_sessions s
        JOIN LATERAL (
          SELECT DISTINCT a.native_session_id
            FROM harness_shared.session_identity_activation_events a
           WHERE a.workspace_id = s.workspace_id AND a.adv_session_id = s.id
             AND a.owner_id = s.coord_owner_id AND a.phase = 'applied'
             AND a.native_session_id IS NOT NULL AND a.native_session_id <> s.session_id
        ) n ON true
        LEFT JOIN harness_shared.agent_usage_samples u
          ON u.workspace_id = s.workspace_id AND u.session_id = n.native_session_id
         AND u.source = 'interactive'
       WHERE s.workspace_id = ${workspaceId} AND s.feature = ${workItemId}
         AND s.launch_spec->'acceptedOperation'->'pin' = ${sql.json(pin as JSONValue)}
       ORDER BY s.id, n.native_session_id, u.id LIMIT 1001
    `;
    rows.push(...historicalRows);
    if (rows.length > 1000) return 'model evidence exceeds the bounded verification window';
  }
  const unmatched = new Set(events.keys());
  const nonnegative = (value: string | number | null) => value !== null && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  // Reuse the gateway's CLI-alias resolution: a listed `opus[1m]` is the
  // provider's `claude-opus-5` after the CLI moves the window into a header.
  // Pricing normalization alone strips the marker but cannot resolve it.
  const { resolveGatewayModel } = await import('../inference-gateway/gateway');
  const canonicalClaudeModel = (value: string) => {
    const bare = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
    return normalizeModelId(resolveGatewayModel(bare).model);
  };
  const { resolveCodexModel } = await import('../model-context-budget.mjs');
  const canonicalCodexModel = (value: string) => {
    const bare = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
    return normalizeModelId(resolveCodexModel(bare.replace(/:(low|medium|high|xhigh|max|ultra)$/i, '')));
  };
  const modelAllowed = (model: string, provider: string, effort: string | null): boolean => {
    const actualPrefix = model.includes('/') ? model.slice(0, model.indexOf('/')).toLowerCase() : null;
    if (actualPrefix && actualPrefix !== provider && !(provider === 'openai' && actualPrefix === 'openai-codex')) return false;
    return policy.models.some((entry) => {
      const listedProvider = entry.includes('/') ? entry.slice(0, entry.indexOf('/')).toLowerCase() : provider;
      const listedEffort = /:(low|medium|high|xhigh|max|ultra)$/i.exec(entry)?.[1]?.toLowerCase();
      return (listedProvider === provider || (provider === 'openai' && listedProvider === 'openai-codex')) &&
        (provider === 'openai'
          ? canonicalCodexModel(entry) === canonicalCodexModel(model)
          : canonicalClaudeModel(entry) === canonicalClaudeModel(model)) &&
        (!listedEffort || listedEffort === effort);
    });
  };
  const policyFailure = (event: Extract<z.infer<typeof OperationEventBodySchema>, { kind: 'model-attestation' }>): string | null => {
    if (!modelAllowed(event.requestedModel, event.provider, event.forwardedEffort) ||
        !modelAllowed(event.actualModel, event.provider, event.forwardedEffort)) {
      return `accepted worker reported a model outside the ${policy.mode} policy`;
    }
    if (policy.effort && (event.effortSource !== 'forwarded-request' ||
        event.forwardedEffort !== policy.effort.toLowerCase() ||
        (event.providerEffort != null && event.providerEffort !== policy.effort.toLowerCase()))) {
      return 'forwarded or provider-reported reasoning effort differs from the accepted level';
    }
    return null;
  };
  for (const row of rows) {
    if ((row.agent !== 'claude' && row.agent !== 'codex') ||
        row.provider !== (row.agent === 'claude' ? 'anthropic' : 'openai') ||
        row.model_source !== 'transcript' || row.grain !== 'request' || !row.model ||
        !row.owner_id || !row.native_session_id || !row.source_id) {
      return 'accepted worker has an unreported or unsupported actual model';
    }
    let matchedKey: string | null = null;
    if (row.agent === 'claude') {
      if (!row.source_id.startsWith('message:')) return 'accepted worker has an unreported or unsupported actual model';
      matchedKey = `${row.native_session_id}:${row.source_id.slice('message:'.length)}`;
    } else {
      // Codex token_count has no provider response id. Match the bounded
      // multiset of provider totals to request-grain transcript totals within
      // the same applied native session. turn_context model is REQUESTED model;
      // the event's provider response model remains the actual-model authority.
      if (!nonnegative(row.input_total_tokens) || !nonnegative(row.output_tokens)) {
        return 'accepted worker usage differs from provider request attestation';
      }
      const match = [...events.entries()].find(([key, candidate]) => unmatched.has(key) &&
        candidate.backend === 'codex' && candidate.provider === 'openai' &&
        candidate.nativeSessionId === row.native_session_id && candidate.ownerId === row.owner_id &&
        candidate.usage.inputTokenBasis === 'inclusive' &&
        candidate.usage.inputTokens === Number(row.input_total_tokens) &&
        candidate.usage.outputTokens === Number(row.output_tokens) &&
        canonicalCodexModel(candidate.requestedModel) === canonicalCodexModel(row.model!) &&
        (row.cache_read_tokens === null || candidate.usage.cacheReadTokens === null ||
          Number(row.cache_read_tokens) === candidate.usage.cacheReadTokens) &&
        (row.cache_creation_tokens === null || candidate.usage.cacheCreationTokens === null ||
          Number(row.cache_creation_tokens) === candidate.usage.cacheCreationTokens));
      matchedKey = match?.[0] ?? null;
    }
    const event = matchedKey ? events.get(matchedKey) : null;
    if (!event || !matchedKey || !unmatched.delete(matchedKey) ||
        event.ownerId !== row.owner_id || event.backend !== row.agent ||
        event.provider !== row.provider ||
        (row.agent === 'claude' &&
          (event.usage.inputTokenBasis === 'inclusive' ||
            canonicalClaudeModel(event.actualModel) !== canonicalClaudeModel(row.model)))) {
      return 'accepted worker transcript differs from its provider model attestation';
    }
    const eventPolicyFailure = policyFailure(event);
    if (eventPolicyFailure) return eventPolicyFailure;
    if (!modelAllowed(row.model, row.provider, event.forwardedEffort)) {
      return `accepted worker reported a model outside the ${policy.mode} policy`;
    }
    if ((row.agent === 'claude' && (!nonnegative(row.input_tokens) ||
          event.usage.inputTokens === null || Number(row.input_tokens) !== event.usage.inputTokens)) ||
        !nonnegative(row.output_tokens) ||
        (row.cache_read_tokens !== null && event.usage.cacheReadTokens !== null &&
          Number(row.cache_read_tokens) !== event.usage.cacheReadTokens) ||
        (row.cache_creation_tokens !== null && event.usage.cacheCreationTokens !== null &&
          Number(row.cache_creation_tokens) !== event.usage.cacheCreationTokens)) {
      return 'accepted worker usage differs from provider request attestation';
    }
  }
  if (unmatched.size) {
    // Even if the row/event counts hid a surplus, establish the complete
    // accepted native population before calling any response auxiliary.
    // This retry is bounded to one read of the immutable applied history.
    if (!readNativeHistory) return verifyDirectOperationModel(sql, workspaceId, workItemId, pin, policy, persistOrigins, true, usageCatchupAttempted);
    if (persistOrigins && !usageCatchupAttempted) {
      // Provider events arrive before the periodic transcript ingester. Reuse
      // its atomic watermark writer for this exact accepted launch population;
      // never treat an un-ingested main-thread request as auxiliary evidence.
      const nativeIds = [...new Set(rows.map(row => row.native_session_id))]
        .filter((id): id is string => typeof id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
      if (nativeIds.length) {
        const launches = await sql<Array<{ id: string | number; coord_owner_id: string }>>`
          SELECT id, coord_owner_id FROM harness_shared.adv_sessions
           WHERE workspace_id = ${workspaceId} AND feature = ${workItemId}
             AND agent = 'codex'
             AND launch_spec->'acceptedOperation'->'pin' = ${sql.json(pin as JSONValue)}
           ORDER BY id LIMIT 33
        `;
        if (launches.length > 32) return 'accepted worker usage catch-up exceeds the bounded launch population';
        const { codexHomeForSessionKey } = await import('@papercusp/orchestrator/session-launch-dirs');
        const { join } = await import('node:path');
        const { parseCodexChunk, codexSessionIdForFile } = await import('../interactive-usage/ingest-adapters');
        const { ingestInteractiveUsage } = await import('../interactive-usage/ingest-claude-transcripts');
        const result = await ingestInteractiveUsage({
          adapters: launches.map(launch => ({ name: 'codex-operation-catchup',
            root: join(codexHomeForSessionKey(launch.id), 'sessions'),
            parse: parseCodexChunk, replayStateFromPrefix: true,
            sessionIdForFile: codexSessionIdForFile,
            ownerId: launch.coord_owner_id, advSessionId: Number(launch.id),
          })),
          includeIsolationRoots: false, sessionIds: nativeIds,
          maxFilesPerTick: 32, maxBytesPerFile: 4 * 1024 * 1024,
        }, { sql, workspaceId });
        if (result.errors.length) return 'accepted worker usage catch-up failed';
        if (result.ingestedFiles) return verifyDirectOperationModel(
          sql, workspaceId, workItemId, pin, policy, persistOrigins, true, true);
      }
    }
    const refusal = 'accepted worker has unmatched request-grain model evidence';
    const acceptedSessions = new Set(rows.map(row => row.native_session_id));
    const pending: AttestationOrigin[] = [];
    const unresolved = [...unmatched].filter(key => !origins.has(eventIds.get(key)!));
    // Only exact response identities can establish a historical auxiliary
    // origin. Missing/ambiguous history, same-thread evidence and accepted
    // worker sessions still require the ordinary transcript multiset.
    const outcomes = unresolved.length ? await sql<Array<{
      request_id: string; owner_id: string; provider_response_id: string;
      provider: string; protocol: string; outcome_class: string; final_status: number | null;
      native_session_id: string | null; native_thread_id: string | null;
    }>>`
      SELECT request_id, owner_id, provider_response_id, provider, protocol,
             outcome_class, final_status, native_session_id, native_thread_id
        FROM harness_shared.gateway_request_outcomes
       WHERE workspace_id = ${workspaceId}
         AND provider_response_id IN ${sql(unresolved.map(key => events.get(key)!.providerResponseId))}
         AND owner_id IN ${sql([...new Set(unresolved.map(key => events.get(key)!.ownerId))])}
       ORDER BY request_id LIMIT 1001
    ` : [];
    if (outcomes.length > 1000) return refusal;
    for (const key of unmatched) {
      const event = events.get(key)!;
      if (event.backend !== 'codex' || event.provider !== 'openai' || event.usage.inputTokenBasis !== 'inclusive') return refusal;
      const eventId = eventIds.get(key)!;
      const attestationHash = createHash('sha256').update(canonicalJson(event)).digest('hex');
      let origin = origins.get(eventId);
      if (!origin) {
        const matches = outcomes.filter(row => row.owner_id === event.ownerId && row.provider_response_id === event.providerResponseId);
        if (matches.length !== 1) return refusal;
        const row = matches[0];
        const parsed = OperationEventBodySchema.safeParse({
          kind: 'model-attestation-origin', receiptId, workItemId, runId: null,
          originalEventId: eventId, attestationHash, ownerId: event.ownerId,
          nativeSessionId: event.nativeSessionId, providerResponseId: event.providerResponseId,
          gatewayOutcome: { requestId: row.request_id, provider: row.provider, protocol: row.protocol,
            outcomeClass: row.outcome_class, finalStatus: row.final_status,
            nativeSessionId: row.native_session_id, nativeThreadId: row.native_thread_id },
          source: 'gateway-outcomes',
        });
        if (!parsed.success || parsed.data.kind !== 'model-attestation-origin') return refusal;
        origin = parsed.data;
        pending.push(origin);
      }
      if (origin.attestationHash !== attestationHash || origin.ownerId !== event.ownerId ||
          origin.nativeSessionId !== event.nativeSessionId || origin.providerResponseId !== event.providerResponseId ||
          origin.gatewayOutcome.nativeSessionId !== origin.gatewayOutcome.nativeThreadId ||
          acceptedSessions.has(origin.gatewayOutcome.nativeSessionId)) return refusal;
      const eventPolicyFailure = policyFailure(event);
      if (eventPolicyFailure) return eventPolicyFailure;
    }
    if (persistOrigins) {
      const handle: BlueprintOperationHandle = { workspaceId, harnessSlug: acceptedPin.harnessSlug,
        receiptId, operationId: acceptedPin.operationId, specificationRevision: acceptedPin.specificationRevision,
        target: { kind: 'work-item', id: workItemId } };
      for (const origin of pending) {
        await appendControlEvent(sql, handle, eventIdentity('model-attestation-origin', handle, origin.originalEventId), origin);
      }
    }
  }
  return null;
}

/** A scorecard grades this immutable result identity, not a mutable work item.
 * The attempt stamp changes on reopen or re-claim, so an old grade cannot close
 * a new attempt even when it emits byte-identical output. */
export function blueprintOperationAcceptanceSubjectRef(input: {
  targetRef: string; attemptRef: string; operationId: string;
  specificationRevision: string; output: unknown;
}): string {
  return `blueprint-result:${createHash('sha256').update(canonicalJson(input)).digest('hex')}`;
}

type OperationAcceptanceVerdict =
  | { ok: true; evidenceRef: string | null }
  | { ok: false; reason: string };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Reuse the scorecard ledger and the rubric's pinned package value. A current
 * rubric lookup could silently change the accepted task's grading bar. */
async function readOperationAcceptanceEvidence(
  sql: Sql, workspaceId: string, operation: Parameters<typeof pinnedOperationRubricPackage>[0],
  specification: CompiledAgentSpecification, subjectRef: string,
  evidenceRef?: string,
): Promise<OperationAcceptanceVerdict> {
  const pinned = pinnedOperationRubricPackage(operation, specification.inputs);
  if (!pinned) return { ok: true, evidenceRef: null };
  const value = objectValue(pinned.value);
  const criteria = value?.criteria;
  if (!value || typeof value.characteristic !== 'string' ||
      !Array.isArray(value.ratingScale) || !value.ratingScale.length ||
      value.ratingScale.some((rating) => typeof rating !== 'string') ||
      !Array.isArray(criteria) || !criteria.length ||
      criteria.some((entry) => !objectValue(entry) ||
        typeof objectValue(entry)?.key !== 'string' || !String(objectValue(entry)?.key).trim())) {
    return { ok: false, reason: 'retained acceptance rubric has no valid criteria' };
  }
  if (new Set((criteria as Record<string, unknown>[]).map((entry) => String(entry.key))).size !== criteria.length) {
    return { ok: false, reason: 'retained acceptance rubric repeats a criterion key' };
  }
  const expectedHash = seedContentHash(value as RubricSeedSource);
  const rows = await sql<Array<{ issue_id: string; observation: unknown }>>`
    SELECT card.issue_id, card.payload->'observation' AS observation
      FROM harness_shared.engineer_issues AS card
     WHERE card.workspace_id = ${workspaceId}
       AND card.payload->'observation'->>'rubricRef' = ${pinned.ref}
       AND card.payload->'observation'->'subject'->>'ref' = ${subjectRef}
       AND ${evidenceRef ? sql`card.issue_id = ${evidenceRef}` : sql`TRUE`}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.engineer_issues AS correction
          WHERE correction.workspace_id = ${workspaceId}
            AND correction.payload->'observation'->>'supersedes' = card.issue_id
       )
     ORDER BY card.created_at DESC, card.issue_id DESC
     LIMIT 1
  `;
  const card = rows[0];
  if (!card) return { ok: false, reason: `no current scorecard for pinned rubric ${pinned.ref} and result ${subjectRef}` };
  const observation = objectValue(card.observation);
  const ratings = objectValue(observation?.ratings);
  if (!observation || observation.criteriaHash !== expectedHash ||
      !Number.isSafeInteger(observation.rubricRevision) || Number(observation.rubricRevision) < 1 ||
      typeof observation.evidenceFingerprint !== 'string' || !observation.evidenceFingerprint ||
      observation.retracted || observation.provisional || !ratings) {
    return { ok: false, reason: `scorecard ${card.issue_id} is stale, provisional, retracted or incomplete` };
  }
  const expectedKeys = new Set((criteria as Record<string, unknown>[]).map((entry) => String(entry.key)));
  if (Object.keys(ratings).length !== expectedKeys.size ||
      Object.keys(ratings).some((key) => !expectedKeys.has(key))) {
    return { ok: false, reason: `scorecard ${card.issue_id} does not grade every pinned criterion exactly once` };
  }
  for (const criterion of criteria as Record<string, unknown>[]) {
    const rating = objectValue(ratings[String(criterion.key)]);
    const allowed = Array.isArray(criterion.passRatings) && criterion.passRatings.length
      ? criterion.passRatings : ['pass', 'healthy', 'exemplary'];
    if (!rating || typeof rating.rating !== 'string' ||
        !allowed.some((value) => typeof value === 'string' && value.toLowerCase() === String(rating.rating).toLowerCase()) ||
        typeof rating.evidence !== 'string' || !rating.evidence.trim()) {
      return { ok: false, reason: `scorecard ${card.issue_id} does not pass pinned criterion ${String(criterion.key)}` };
    }
  }
  const audit = objectValue(observation.gradingAudit);
  if (audit?.state === 'failed') return { ok: false, reason: `scorecard ${card.issue_id} failed its grading audit` };
  const rollup = objectValue(observation.rollup);
  if (rollup && ['fail', 'severe', 'partial'].includes(String(rollup.verdict))) {
    return { ok: false, reason: `scorecard ${card.issue_id} has a non-passing rollup` };
  }
  return { ok: true, evidenceRef: card.issue_id };
}

/** Prepare the result before a successful terminal state write. The state
 * writer merges this receipt with completion evidence in the same transaction;
 * a missing or incompatible actual model cannot become a successful close. */
export async function prepareDirectOperationCompletion(
  sql: Sql,
  workspaceId: string,
  item: WorkItem,
  outputPayload: unknown,
): Promise<{ operationId: string; specificationRevision: string; output: unknown; evidenceRef: string;
  acceptanceEvidenceRef?: string; acceptanceSubjectRef?: string; acceptanceAttemptStamp?: string }> {
  if (!item.harness) throw new Error('blueprint operation completion requires a harness');
  const { pin, operation, specification } = await readAcceptedBlueprintDirectWorkItem(sql, workspaceId, item);
  // WI-10004562: a pot MEMBER harness's accepted item is stored under the pot home slug, so
  // the item's harness is the pin harness's storage slug. The pot lookup runs only when the
  // two differ, i.e. never for an ordinary (non-member) harness.
  if (pin.harnessSlug !== item.harness &&
      await workItemStorageSlug(pin.harnessSlug, workspaceId) !== item.harness) {
    throw new Error('blueprint operation completion harness differs from its pin');
  }
  if (outputPayload === undefined) throw new Error('blueprint operation completion requires outputPayload');
  const output = exactJsonValue(outputPayload, 'output');
  const valid = checkAgainstJsonSchema(operation.acceptance.resultSchema, output);
  if (!valid.ok) throw new Error(`blueprint operation output is invalid: ${valid.errors.join('; ')}`);
  if (operation.policy.supportCase) {
    const { validateSupportOperationResult } = await import('./support-workflow-case');
    await validateSupportOperationResult(sql, workspaceId, operation, pin, output);
  }
  if (operation.policy.model) {
    const modelFailure = await verifyDirectOperationModel(
      sql, workspaceId, item.id, pin as Record<string, unknown>, operation.policy.model, true,
    );
    if (modelFailure) throw new Error(`blueprint operation model attestation failed: ${modelFailure}`);
  }
  const acceptanceSubjectRef = operation.acceptance.rubric
    ? blueprintOperationAcceptanceSubjectRef({
      targetRef: item.id, attemptRef: item.updatedAt, operationId: pin.operationId,
      specificationRevision: pin.specificationRevision, output,
    }) : null;
  const acceptance = acceptanceSubjectRef
    ? await readOperationAcceptanceEvidence(sql, workspaceId, operation, specification, acceptanceSubjectRef)
    : { ok: true as const, evidenceRef: null };
  if (!acceptance.ok) {
    throw new Error(`blueprint operation acceptance failed: ${acceptance.reason}; ` +
      `grade the final output with scorecards:emit subject.ref '${acceptanceSubjectRef}'`);
  }
  return {
    operationId: pin.operationId,
    specificationRevision: pin.specificationRevision,
    output,
    evidenceRef: `work-item:completion:${item.id}`,
    ...(acceptance.evidenceRef ? {
      acceptanceEvidenceRef: acceptance.evidenceRef,
      acceptanceSubjectRef: acceptanceSubjectRef!,
      acceptanceAttemptStamp: item.updatedAt,
    } : {}),
  };
}

interface ValidatedCanonicalOperation {
  status: BlueprintOperationStatus;
  /** Current authorized source links are for app display only. Canonical worker
   * attribution, rubric subjects and business-review fingerprints keep raw output. */
  displayOutput?: unknown;
  /** Available only after the canonical result passes validation. */
  items?: WorkItem[];
  result?: { output: unknown; evidenceRef: string; acceptanceEvidenceRef?: string;
    businessReview?: BlueprintOperationBusinessReview };
  invalidReason?: string;
}

/** A terminal lifecycle state is successful only when its pinned result is
 * readable and valid. Status and result use this same canonical read. */
async function readValidatedCanonicalOperation(
  sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  reviewAccess?: BlueprintOperationReviewAccess,
): Promise<ValidatedCanonicalOperation> {
  const { status, items, run } = await readCanonicalOperation(sql, handle, callerId, reviewAccess);
  if (status.phase !== 'terminal' || status.outcome !== 'succeeded') {
    const failedProgram = status.outcome === 'failed' && handle.target.kind === 'work-item' &&
      items[0]?.terminalOwner === BLUEPRINT_PROGRAM_COMPLETION_OWNER;
    return { status, ...(failedProgram && items[0]?.terminalCompletionEvidence?.summary
      ? { invalidReason: items[0].terminalCompletionEvidence.summary } : {}) };
  }
  const invalid = (reason: string): ValidatedCanonicalOperation => ({
    status: { ...status, outcome: 'unverified' }, invalidReason: reason,
  });
  if (handle.target.kind === 'work-item' &&
      items[0]?.completionAuthority !== 'committed' && items[0]?.completionAuthority !== 'validated') {
    return invalid('canonical completion has no validated authority for its operation output');
  }
  const { operation, specification } = await declaredOperationWithSpecification(sql, handle);
  if (operation.acceptance.businessReview && (status.cancellationRequested ||
      (handle.target.kind === 'work-item' && (!items[0]?.terminalOwner || !items[0]?.terminalCompletionRef)))) {
    return invalid('business review requires an accountable completed attempt without cancellation');
  }
  if (operation.policy.model) {
    const pin = handle.target.kind === 'work-item' && items[0]?.payload &&
      typeof items[0].payload === 'object' && !Array.isArray(items[0].payload)
      ? (items[0].payload as Record<string, unknown>).blueprintOperation : null;
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
        handle.target.kind !== 'work-item' || operation.execution?.kind !== 'agent') {
      return invalid('model policy has no attested agent worker result');
    }
    const modelFailure = await verifyDirectOperationModel(
      sql, handle.workspaceId, handle.target.id, pin as Record<string, unknown>, operation.policy.model,
    );
    if (modelFailure) return invalid(modelFailure);
  }
  const raw = handle.target.kind === 'plan' ? run?.outputs :
    (items[0]?.payload && typeof items[0].payload === 'object' && !Array.isArray(items[0].payload)
      ? (items[0].payload as Record<string, unknown>).blueprintResult : null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('canonical target has no validated operation output');
  }
  const result = raw as Record<string, unknown>;
  if (handle.target.kind === 'work-item' && !Object.prototype.hasOwnProperty.call(result, 'output')) {
    return invalid('canonical target has no validated operation output');
  }
  const output = handle.target.kind === 'plan' ? raw : result.output;
  const evidenceRef = handle.target.kind === 'plan' ? `plan-run:${handle.target.runId}` : result.evidenceRef;
  if (typeof evidenceRef !== 'string' || !evidenceRef.trim() ||
      (handle.target.kind === 'work-item' &&
        (result.operationId !== handle.operationId || result.specificationRevision !== handle.specificationRevision))) {
    return invalid('canonical target output has no matching validation receipt');
  }
  const validation = checkAgainstJsonSchema(operation.acceptance.resultSchema, output);
  if (!validation.ok) return invalid(`canonical target output is invalid: ${validation.errors.join('; ')}`);
  let displayOutput = output;
  if (operation.policy.supportCase) {
    if (handle.target.kind !== 'work-item' || !items[0]) return invalid('support result has no accepted case');
    const { pin } = await readAcceptedBlueprintDirectWorkItem(sql, handle.workspaceId, items[0]);
    const { validateSupportOperationResult } = await import('./support-workflow-case');
    try { displayOutput = await validateSupportOperationResult(sql, handle.workspaceId, operation, pin, output,
      reviewAccess?.principalId ?? callerId.split('/')[0]) ?? output; }
    catch (error) {
      if (error instanceof BlueprintOperationRefusal) return invalid(error.message);
      throw error;
    }
  }
  let acceptanceEvidenceRef: string | undefined;
  if (operation.acceptance.rubric) {
    let subjectRef: string;
    let namedEvidence: string | undefined;
    if (handle.target.kind === 'work-item') {
      if (typeof result.acceptanceSubjectRef !== 'string' ||
          typeof result.acceptanceAttemptStamp !== 'string' ||
          typeof result.acceptanceEvidenceRef !== 'string') {
        return invalid('canonical completion has no pinned acceptance scorecard receipt');
      }
      subjectRef = blueprintOperationAcceptanceSubjectRef({
        targetRef: handle.target.id, attemptRef: result.acceptanceAttemptStamp,
        operationId: handle.operationId, specificationRevision: handle.specificationRevision, output,
      });
      if (subjectRef !== result.acceptanceSubjectRef) return invalid('acceptance scorecard subject differs from canonical output');
      namedEvidence = result.acceptanceEvidenceRef;
    } else {
      subjectRef = blueprintOperationAcceptanceSubjectRef({
        targetRef: `plan-run:${handle.target.runId}`, attemptRef: `plan-run:${handle.target.runId}`,
        operationId: handle.operationId, specificationRevision: handle.specificationRevision, output,
      });
    }
    const acceptance = await readOperationAcceptanceEvidence(
      sql, handle.workspaceId, operation, specification, subjectRef, namedEvidence,
    );
    if (!acceptance.ok || !acceptance.evidenceRef) return invalid(
      acceptance.ok ? 'canonical result has no acceptance scorecard' : acceptance.reason);
    acceptanceEvidenceRef = acceptance.evidenceRef;
  }
  if (reviewAccess && operation.acceptance.businessReview) {
    assertBusinessReviewer(reviewAccess.principalId, '', operation.acceptance.businessReview, items[0]?.terminalOwner);
  }
  const businessReview = operation.acceptance.businessReview ? await readBusinessReview(sql, handle,
    output, evidenceRef, operation.acceptance.businessReview.accountableOwner,
    handle.target.kind === 'work-item' ? items[0]?.terminalCompletionRef : `plan-run:${handle.target.runId}`) : undefined;
  return { status, items, displayOutput, result: { output, evidenceRef,
    ...(acceptanceEvidenceRef ? { acceptanceEvidenceRef } : {}),
    ...(businessReview ? { businessReview } : {}) } };
}

async function readBusinessReview(sql: Sql, handle: BlueprintOperationHandle, output: unknown,
  evidenceRef: string, accountableOwner: string, completionRef?: string | null): Promise<BlueprintOperationBusinessReview> {
  const resultFingerprint = operationResultFingerprint(handle, output, evidenceRef, completionRef);
  const rows = await sql<Array<{ id: string | number; ts: Date | string; body: unknown }>>`
    SELECT id, ts, body FROM harness_shared.coord_event_log
     WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
       AND writer_key = ${`receipt:${handle.receiptId}`}
       AND msg_id = ${eventIdentity('business-review', handle, resultFingerprint)}
  `;
  if (!rows[0]) return { state: 'pending', accountableOwner, resultFingerprint };
  const body = OperationEventBodySchema.parse(rows[0].body);
  if (body.kind !== 'business-review' || body.resultFingerprint !== resultFingerprint ||
      body.specificationRevision !== handle.specificationRevision || body.evidenceRef !== evidenceRef ||
      body.accountableOwner !== accountableOwner) throw new Error('business review disagrees with its canonical result');
  return { state: body.decision === 'accept' ? 'accepted' : body.decision === 'reject' ? 'rejected' : 'rework',
    accountableOwner, resultFingerprint,
    decision: { eventId: String(rows[0].id), reviewerPrincipal: body.reviewerPrincipal,
      reason: body.reason, at: new Date(rows[0].ts).toISOString() } };
}

function reviewBlueprintOperation(sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  input: { payload: unknown; requestKey: string }, access?: BlueprintOperationReviewAccess): Promise<BlueprintOperationInputReceipt> {
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationInputReceipt> => {
    if (!access || !input.requestKey?.trim()) throw new BlueprintOperationRefusal('invalid_request', 'business review requires an authenticated reviewer and request key');
    const parsed = BusinessReviewInputSchema.safeParse(input.payload);
    if (!parsed.success) throw new BlueprintOperationRefusal('invalid_payload', 'business review requires decision, reason and exact result fingerprint');
    const receipt = await sql.begin(async (tx) => {
      await tx`SELECT id FROM harness_shared.blueprint_operation_invocations
        WHERE workspace_id = ${handle.workspaceId} AND id = ${handle.receiptId} FOR UPDATE`;
      if (handle.target.kind === 'work-item') await tx`SELECT feature_id FROM harness_shared.work_items
        WHERE workspace_id = ${handle.workspaceId} AND feature_id = ${handle.target.id}
          AND harness_slug = COALESCE((SELECT target_harness_slug FROM harness_shared.blueprint_operation_invocations
            WHERE workspace_id = ${handle.workspaceId} AND id = ${handle.receiptId}), ${handle.harnessSlug}) FOR UPDATE`;
      else await tx`SELECT id FROM harness_shared.plan_runs WHERE workspace_id = ${handle.workspaceId}
        AND id = ${handle.target.runId} FOR UPDATE`;
      const current = await readValidatedCanonicalOperation(tx as unknown as Sql, handle, callerId, access);
      if (!current.result?.businessReview || current.status.outcome !== 'succeeded') {
        throw new BlueprintOperationRefusal('terminal', 'business review requires a validated successful result');
      }
      if (current.result.businessReview.resultFingerprint !== parsed.data.resultFingerprint) {
        throw new BlueprintOperationRefusal('invalid_payload', 'business review result changed; reload the canonical output');
      }
      const priorKey = await tx<Array<{ body: { resultFingerprint?: string } }>>`
        SELECT body FROM harness_shared.coord_event_log
         WHERE workspace_id = ${handle.workspaceId} AND surface = 'blueprint-operation'
           AND writer_key = ${`receipt:${handle.receiptId}`} AND body->>'kind' = 'business-review'
           AND body->>'requestKey' = ${input.requestKey}
      `;
      if (priorKey[0] && priorKey[0].body.resultFingerprint !== parsed.data.resultFingerprint) {
        throw new BlueprintOperationRefusal('input_conflict', 'business review request key was reused for a different result');
      }
      const reviewed = await appendControlEvent(tx, handle, eventIdentity('business-review', handle, parsed.data.resultFingerprint), {
        kind: 'business-review', receiptId: handle.receiptId, ...targetEventFields(handle),
        specificationRevision: handle.specificationRevision, resultFingerprint: parsed.data.resultFingerprint,
        evidenceRef: current.result.evidenceRef, accountableOwner: current.result.businessReview.accountableOwner,
        reviewerPrincipal: access.principalId, decision: parsed.data.decision, reason: parsed.data.reason,
        requestKey: input.requestKey,
      });
      if (!reviewed.replayed) {
        const operation = await declaredOperation(sql, handle);
        const funding = operation.policy.supportCase?.funding;
        if (funding) {
          const { recordSupportWorkflowOutcome } = await import('./support-workflow-budget');
          await recordSupportWorkflowOutcome(tx as unknown as Sql, { handle, funding,
            decision: parsed.data.decision, reviewerPrincipal: access.principalId,
            evidenceRef: `blueprint-operation-review:${reviewed.id}` });
        }
      }
      return reviewed;
    });
    return { eventId: receipt.id, replayed: receipt.replayed, accepted: true, wakeQueued: false, handled: false };
  });
}

/** Read a typed output from the canonical target only. */
export function getBlueprintOperationResult(sql: Sql, handle: BlueprintOperationHandle, callerId: string,
  reviewAccess?: BlueprintOperationReviewAccess): Promise<BlueprintOperationResult> {
  return runWithWorkspace(handle.workspaceId, async (): Promise<BlueprintOperationResult> => {
    const { status, result, displayOutput, invalidReason } = await readValidatedCanonicalOperation(sql, handle, callerId, reviewAccess);
    if (status.phase !== 'terminal') return { state: 'pending', status };
    if (status.outcome !== 'succeeded') {
      return { state: status.outcome === 'unverified' ? 'unavailable' : (status.outcome ?? 'failed'),
        status, reason: invalidReason ?? 'canonical target settled without a validated successful result' };
    }
    if (!result) return { state: 'unavailable', status: { ...status, outcome: 'unverified' },
      reason: 'canonical target has no validated operation output' };
    return { state: 'ready', status, ...result, output: displayOutput ?? result.output };
  });
}
