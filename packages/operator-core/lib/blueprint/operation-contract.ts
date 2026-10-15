/** Shared typed contract for the public blueprint operation lifecycle (P-017,
 * plan blueprint-backed-work-item-execution-2026-09-23 D-009).
 *
 * One schema set feeds every projection: the seven `blueprint:*` defineTool
 * `args`/`result`/`events` declarations (MCP inputSchema/outputSchema, the
 * /api/agent-tools HTTP route, /api/openapi.json) and the generic projected
 * client port. The service owns behaviour; this module only names its wire
 * shapes, so the transports cannot drift into separate contracts. */
import { z } from 'zod';
import { entityRef } from '@papercusp/tooldef';
import { BusinessReviewStateSchema, OperationEventBodySchema, OperationHandleSchema } from './operation-service';
import { WorkflowAdministrationActionSchema, WorkflowAdministrationSelectionSchema } from './support-workflow-administration';

export { BLUEPRINT_OPERATION_TOOLS, type BlueprintOperationVerb } from './operation-tool-names';

export const BlueprintOperationHandleSchema = OperationHandleSchema;

const requestKey = z.string().trim().min(1).max(200)
  .describe('Caller-chosen idempotency key. The same key with the same input replays one durable outcome; different input is refused.');
const handle = BlueprintOperationHandleSchema
  .describe('The durable operation handle returned by blueprint:submit. It is bound to the submitting caller and scope.');

export const SubmitArgsSchema = z.object({
  // entityRef (not a bare string): the dispatch entity-check rejects an invented harness
  // before the operation service runs, and the conformance ratchet counts it converted.
  harness: entityRef('harness', {
    max: 120,
    describe: 'Harness (in your workspace) whose projected blueprint declares the operation.',
  }),
  operationId: z.string().trim().min(1).max(200).describe('Operation id declared by the harness blueprint.'),
  requestKey,
  expectedSpecificationRevision: z.string().regex(/^[0-9a-f]{64}$/).optional()
    .describe('The current approved revision shown to the employee. Refuses a changed revision before new admission; a replay stays pinned to its original receipt.'),
  input: z.record(z.string(), z.unknown()).describe('Operation input; validated against the declared inputSchema.'),
  privateInput: z.unknown().optional()
    .describe('Only for operations declaring privateInputSchema: content for the worker, kept out of the work item and deleted when it ends.'),
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().max(4_000).optional(),
}).strict();

const review = z.literal(true).optional().describe('Read as the distinct authenticated business reviewer named by this pinned operation.');
export const HandleArgsSchema = z.object({ handle, review }).strict();
export const StatusArgsSchema = z.union([HandleArgsSchema,
  WorkflowAdministrationSelectionSchema.extend({ administration: z.literal(true) }).strict()]);

export const EventsArgsSchema = z.object({
  handle,
  review,
  cursor: z.string().regex(/^(0|[1-9][0-9]*)$/).optional()
    .describe('Resume after this event cursor (from a prior page). Omit to read from the start.'),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const CancelArgsSchema = z.object({
  handle, requestKey, reason: z.string().trim().min(1).max(2_000),
}).strict();

export const SignalArgsSchema = z.union([z.object({
  handle,
  channel: z.string().trim().min(1).max(200).describe('Signal channel declared by the operation.'),
  payload: z.unknown().describe('Payload validated against the channel payloadSchema.'),
  requestKey,
}).strict(), WorkflowAdministrationSelectionSchema.extend({
  administration: WorkflowAdministrationActionSchema, requestKey,
}).strict()]);

export const ResumeArgsSchema = z.object({
  handle,
  token: z.string().trim().min(1).max(500).describe('The outstanding declared wait token (blueprint:status wait.token).'),
  response: z.unknown().describe('Response validated against the declared wait responseSchema.'),
  requestKey,
}).strict();

export const BlueprintOperationStatusSchema = z.object({
  handle: BlueprintOperationHandleSchema,
  phase: z.enum(['accepted', 'dispatched', 'waiting', 'terminal']),
  outcome: z.enum(['succeeded', 'unverified', 'failed', 'cancelled', 'dropped']).nullable(),
  items: z.array(z.object({ id: z.string(), state: z.string(), assignee: z.string().nullable() })),
  planRun: z.object({ status: z.string(), outcome: z.string().nullable() }).nullable(),
  cancellationRequested: z.boolean(),
  wait: z.object({ name: z.string(), token: z.string() }).nullable(),
});

/** Event vocabulary: the service's canonical event bodies plus their cursor. */
export const BlueprintOperationEventSchema = OperationEventBodySchema.and(
  z.object({ cursor: z.string(), at: z.string() }),
);

export const BlueprintOperationEventsPageSchema = z.object({
  status: BlueprintOperationStatusSchema,
  events: z.array(BlueprintOperationEventSchema),
  cursor: z.string(),
  hasMore: z.boolean(),
});

/** Settlement and success are different facts: only `ready` carries output. */
export const BlueprintOperationResultSchema = z.union([
  z.object({ state: z.literal('pending'), status: BlueprintOperationStatusSchema }),
  z.object({
    state: z.enum(['failed', 'cancelled', 'dropped', 'unavailable']),
    status: BlueprintOperationStatusSchema, reason: z.string(),
  }),
  z.object({
    state: z.literal('ready'), status: BlueprintOperationStatusSchema,
    output: z.unknown(), evidenceRef: z.string(), acceptanceEvidenceRef: z.string().optional(),
    businessReview: BusinessReviewStateSchema.optional(),
  }),
]);

/** A control input is durably accepted; handling is a separate worker fact. */
export const BlueprintOperationInputReceiptSchema = z.object({
  eventId: z.string(),
  replayed: z.boolean(),
  accepted: z.literal(true),
  wakeQueued: z.boolean(),
  handled: z.literal(false),
});

export const BlueprintOperationCancelReceiptSchema = BlueprintOperationInputReceiptSchema.extend({
  effected: z.boolean(),
});

export const SubmitResultSchema = z.object({ handle: BlueprintOperationHandleSchema });
