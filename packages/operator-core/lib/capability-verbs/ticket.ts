/**
 * Provider-neutral ticket filing for trigger-pack workflows (plan
 * cupboard-distributable-integrations-2026-10-10 P-007, decision D-012).
 *
 * Generalizes the in-app `fileSlackBugInAsana` off Slack and Asana. The agent supplies TEXT ONLY
 * (title, observed, expected) and names its own plan run; everything else comes from durable state:
 *
 *   plan run -> its succeeded trigger run -> the trigger-pack installation that owns the run's
 *   binding -> that installation's `destination` input -> the ONE source of the binding owner's
 *   whose provider declares `ticket.create` and whose option list (the input's `x-options`, i.e.
 *   the list the owner picked from) contains that destination.
 *
 * So an agent cannot choose or redirect where a ticket lands. The plan-run trust boundary is the
 * one `mail:reply { planRunId }` and `readTriggerPlanRunPayload` already use: the run must resolve
 * inside the caller's own workspace.
 *
 * Idempotency is the in-app filer's, unchanged: an `attempted` record commits on the trigger run
 * BEFORE any provider HTTP. When the canonical trigger envelope has `sourceId` and `externalId`,
 * the correlation is stable across runs and scoped to (workspace, pack installation, sourceId,
 * externalId); legacy envelopes fall back to the trigger-run scope. A replay or a matching run
 * reads that record instead of filing twice, and a provider that already holds the correlation id
 * answers it (`recoveryOnly`) without creating a second ticket. No provider id is checked anywhere:
 * any installed provider serving `ticket.create` + an option capability works.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { providerOptionSourceOf, type ProviderOptionSource } from '@papercusp/plugin-sdk/provider';
import { listProviderOptions, type ProviderOptionsDeps } from '../integrations/provider-options';
import { readyProviderRegistry } from '../integrations/provider-registry';
import { TICKET_CONTAINERS_CAPABILITY } from '../integrations/ticket-integrations';
import { invokeOutboundProvider, resolveCapabilitySource, type OutboundDispatchDeps } from './provider-dispatch';

/** The trigger-pack input whose value names where tickets are filed. */
export const TICKET_DESTINATION_INPUT = 'destination';
/**
 * The optional trigger-pack input that scopes a workflow to some channels. Binding filters cannot
 * reference installer inputs, so the rail lives here: when present, only a message from one of
 * these channels can file (the in-app filer's `config.channels` check, made provider-neutral).
 */
export const TICKET_CHANNELS_INPUT = 'channels';
/**
 * The optional trigger-pack input that assigns every filed ticket. Its one value, `self`, assigns
 * the ticket to the connected ticket account (the Papercusp user), so the ticket syncs back with
 * `selfRoles: ['assignee']` and an assigned-to-Papercusp admission rule can route it. The provider
 * confirms the assignment in its `ticket.create` receipt (`assignee: 'self'`); the filing records
 * `assigned: false` when it did not.
 */
export const TICKET_ASSIGNEE_INPUT = 'assignee';
export const TICKET_ASSIGNEE_SELF = 'self';
/** Where the filing record lives on `trigger_runs.outcome`. */
export const TICKET_FILING_OUTCOME_KEY = 'ticketFiling';
export const TICKET_CLASSIFICATION_OUTCOME_KEY = 'classification';
/** Option list used when the destination input declares no `x-options` of its own. */
export const DEFAULT_TICKET_DESTINATION_OPTIONS: ProviderOptionSource = {
  capability: TICKET_CONTAINERS_CAPABILITY,
  args: { purpose: 'create' },
};
export const TICKET_TITLE_MAX = 200;
export const TICKET_FIELD_MAX = 5000;
export const TICKET_REASON_MAX = 2000;
const QUOTE_MAX = 15000;

export type TicketFilingErrorCode =
  | 'ticket_run_invalid'
  | 'ticket_content_invalid'
  | 'ticket_committing_connection_required'
  | 'ticket_origin_invalid'
  | 'ticket_destination_unset'
  | 'ticket_destination_unavailable'
  | 'ticket_destination_ambiguous'
  | 'ticket_assignee_invalid'
  | 'ticket_owner_changed'
  | 'ticket_classification_conflict';

/** A refusal raised before any provider call. `code` is stable for callers to branch on. */
export class TicketFilingError extends Error {
  constructor(readonly code: TicketFilingErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TicketFilingError';
  }
}

const Attempt = z.object({
  sourceId: z.string().uuid(),
  containerId: z.string().min(1),
  correlationId: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  ownerUserId: z.string().uuid(),
  state: z.enum(['attempted', 'created']),
  externalRef: z.string().optional(),
  url: z.string().optional(),
  /** The assignment requested, frozen with the attempt so a recovery asks for the same thing. */
  assignee: z.literal(TICKET_ASSIGNEE_SELF).optional(),
  /** Whether the provider's receipt confirmed `assignee`; absent when none was requested. */
  assigned: z.boolean().optional(),
});
export type TicketFilingAttempt = z.infer<typeof Attempt>;

export interface FileTicketInput {
  workspaceId: string;
  /** The caller's own plan run; it must have been launched by a trigger-pack binding. */
  planRunId: number;
  title?: string;
  observed?: string;
  expected?: string;
  classification?: TicketClassification;
  reason?: string;
}

export type TicketClassification = 'bug' | 'non-bug' | 'needs-information';
const Classification = z.object({
  verdict: z.enum(['bug', 'non-bug', 'needs-information']),
  reason: z.string().max(TICKET_REASON_MAX).optional(),
  ownerUserId: z.string().uuid(),
});
export type TicketClassificationRecord = z.infer<typeof Classification>;

export interface FileTicketDeps extends OutboundDispatchDeps {
  /** Overrides for reading the destination's option list (tests inject a host fetch). */
  options?: Omit<ProviderOptionsDeps, 'registry'>;
}

export type FileTicketResult =
  | {
    triggerRunId: string; created: boolean; alreadyCreated: boolean; externalRef: string; url: string; sourceId: string;
    /** The provider that answered; null when an earlier call already recorded the ticket. */
    provider: string | null;
    /** Present only when the installation asked for an assignee: whether the provider confirmed it. */
    assigned?: boolean;
  }
  | { triggerRunId: string; pendingReconciliation: true; error?: string }
  | { triggerRunId: string; classification: Exclude<TicketClassification, 'bug'>; recorded: boolean; filed: false };

interface RunRow {
  triggerRunId: string;
  outcome: Record<string, unknown> | null;
  args: { trigger?: { payload?: Record<string, unknown>; sourceId?: unknown; externalId?: unknown } } | null;
  ownerUserId: string | null;
  packInstallationId: string;
  inputs: Record<string, unknown> | null;
  manifest: Record<string, unknown> | null;
  pluginName: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The run, its owner and the installation that owns its binding (`trigger_bindings.pack_installation_id`). */
async function readRun(sql: postgres.Sql | postgres.TransactionSql, workspaceId: string, planRunId: number, lock: boolean) {
  const rows = await sql<RunRow[]>`
    SELECT tr.id::text AS "triggerRunId", tr.outcome, tr.args,
           s.owner_user_id::text AS "ownerUserId",
           i.id::text AS "packInstallationId",
           i.inputs, i.manifest, i.plugin_name AS "pluginName"
      FROM harness_shared.trigger_runs tr
      JOIN harness_shared.trigger_bindings b ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
      JOIN harness_shared.data_sources s ON s.workspace_id = b.workspace_id AND s.id = b.source_id
      JOIN harness_shared.trigger_pack_installations i ON i.workspace_id = b.workspace_id AND i.id = b.pack_installation_id
     WHERE tr.workspace_id = ${workspaceId}
       AND tr.plan_run_ref = ${String(planRunId)}
     ORDER BY tr.completed_at DESC NULLS LAST, tr.id
     LIMIT 1
     ${lock ? sql`FOR UPDATE OF tr` : sql``}`;
  const row = rows[0];
  if (!row || !row.ownerUserId) throw new TicketFilingError('ticket_origin_invalid', 'no trigger-pack run for this plan run');
  return row as RunRow & { ownerUserId: string };
}

interface TriggerMessageIdentity {
  packInstallationId: string;
  sourceId: string;
  externalId: string;
}

/** Stable message coordinates shared by independently-triggered runs. */
function triggerMessageIdentity(row: RunRow): TriggerMessageIdentity | null {
  const trigger = record(row.args?.trigger);
  const sourceId = text(trigger?.sourceId);
  const externalId = text(trigger?.externalId);
  if (!row.packInstallationId || !sourceId || !externalId) return null;
  return { packInstallationId: row.packInstallationId, sourceId, externalId };
}

/** Serialize first-attempt selection for every run from one pack installation. */
async function lockPackInstallation(
  sql: postgres.TransactionSql,
  workspaceId: string,
  packInstallationId: string,
): Promise<void> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id::text
      FROM harness_shared.trigger_pack_installations
     WHERE workspace_id = ${workspaceId}
       AND id = ${packInstallationId}::uuid
     FOR UPDATE`;
  if (rows.length === 0) throw new TicketFilingError('ticket_origin_invalid', 'trigger-pack installation not found');
}

/** Find a filing attempt made by another trigger run for this same message. */
async function existingMessageAttempt(
  sql: postgres.TransactionSql,
  workspaceId: string,
  row: RunRow & { ownerUserId: string },
): Promise<TicketFilingAttempt | null> {
  const identity = triggerMessageIdentity(row);
  if (!identity) return null;
  const rows = await sql<RunRow[]>`
    SELECT tr.id::text AS "triggerRunId", tr.outcome, tr.args,
           s.owner_user_id::text AS "ownerUserId",
           i.id::text AS "packInstallationId",
           i.inputs, i.manifest, i.plugin_name AS "pluginName"
      FROM harness_shared.trigger_runs tr
      JOIN harness_shared.trigger_bindings b
        ON b.workspace_id = tr.workspace_id AND b.id = tr.binding_id
      JOIN harness_shared.data_sources s
        ON s.workspace_id = b.workspace_id AND s.id = b.source_id
      JOIN harness_shared.trigger_pack_installations i
        ON i.workspace_id = b.workspace_id AND i.id = b.pack_installation_id
     WHERE tr.workspace_id = ${workspaceId}
       AND i.id = ${identity.packInstallationId}::uuid
       AND tr.id <> ${row.triggerRunId}::uuid
       AND tr.args -> 'trigger' ->> 'sourceId' = ${identity.sourceId}
       AND tr.args -> 'trigger' ->> 'externalId' = ${identity.externalId}
       AND tr.outcome ? ${TICKET_FILING_OUTCOME_KEY}
     ORDER BY CASE WHEN tr.outcome -> ${TICKET_FILING_OUTCOME_KEY} ->> 'state' = 'created' THEN 0 ELSE 1 END,
              tr.completed_at DESC NULLS LAST, tr.id
     LIMIT 1
     FOR UPDATE OF tr`;
  const candidate = rows[0];
  if (!candidate) return null;
  const attempt = existingAttempt(candidate);
  if (attempt && attempt.ownerUserId !== row.ownerUserId) throw new TicketFilingError('ticket_owner_changed');
  return attempt;
}

function ticketCorrelationId(workspaceId: string, row: RunRow): string {
  const identity = triggerMessageIdentity(row);
  const scope = identity
    ? [workspaceId, identity.packInstallationId, identity.sourceId, identity.externalId].join(':')
    : `${workspaceId}:${row.triggerRunId}`;
  return 'papercusp-ticket-' + createHash('sha256').update(scope).digest('hex');
}

function existingAttempt(row: RunRow): TicketFilingAttempt | null {
  const stored = record(row.outcome)?.[TICKET_FILING_OUTCOME_KEY];
  if (stored === undefined || stored === null) return null;
  const attempt = Attempt.parse(stored);
  if (attempt.ownerUserId !== row.ownerUserId) throw new TicketFilingError('ticket_owner_changed');
  return attempt;
}

function existingClassification(row: RunRow): TicketClassificationRecord | null {
  const stored = record(row.outcome)?.[TICKET_CLASSIFICATION_OUTCOME_KEY];
  if (stored === undefined || stored === null) return null;
  const classification = Classification.parse(stored);
  if (classification.ownerUserId !== row.ownerUserId) throw new TicketFilingError('ticket_owner_changed');
  return classification;
}

async function recordClassification(
  sql: postgres.Sql,
  workspaceId: string,
  planRunId: number,
  verdict: TicketClassification,
  reason: string | undefined,
): Promise<{ row: RunRow & { ownerUserId: string }; classification: TicketClassificationRecord; fresh: boolean }> {
  const seen = await readRun(sql, workspaceId, planRunId, false);
  assertChannelInScope(seen);
  const prior = existingClassification(seen);
  if (prior) {
    if (prior.verdict !== verdict) throw new TicketFilingError('ticket_classification_conflict');
    return { row: seen, classification: prior, fresh: false };
  }
  return sql.begin(async (tx) => {
    const row = await readRun(tx, workspaceId, planRunId, true);
    assertChannelInScope(row);
    const filed = existingAttempt(row);
    if (filed && verdict !== 'bug') throw new TicketFilingError('ticket_classification_conflict');
    const raced = existingClassification(row);
    if (raced) {
      if (raced.verdict !== verdict) throw new TicketFilingError('ticket_classification_conflict');
      return { row, classification: raced, fresh: false };
    }
    const classification: TicketClassificationRecord = {
      verdict,
      ...(reason ? { reason } : {}),
      ownerUserId: row.ownerUserId,
    };
    await tx`UPDATE harness_shared.trigger_runs SET
      outcome = COALESCE(outcome, '{}'::jsonb) || ${JSON.stringify({ [TICKET_CLASSIFICATION_OUTCOME_KEY]: classification })}::text::jsonb,
      updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${row.triggerRunId}::uuid`;
    return { row, classification, fresh: true };
  });
}

function assertChannelInScope(row: RunRow): void {
  const channels = record(row.inputs)?.[TICKET_CHANNELS_INPUT];
  if (!Array.isArray(channels) || channels.length === 0) return;
  const channelId = text(record(row.args?.trigger?.payload)?.channelId);
  if (!channelId || !channels.includes(channelId)) {
    throw new TicketFilingError('ticket_origin_invalid', "the message is outside the installation's channels");
  }
}

/**
 * The installation's assignee request. Unset means unassigned; any value other than `self` is
 * refused before anything is recorded, since no provider can be asked for an assignee it cannot name.
 */
export function ticketAssigneeOf(inputs: unknown): typeof TICKET_ASSIGNEE_SELF | undefined {
  const value = record(inputs)?.[TICKET_ASSIGNEE_INPUT];
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== TICKET_ASSIGNEE_SELF) {
    throw new TicketFilingError('ticket_assignee_invalid', `'${TICKET_ASSIGNEE_INPUT}' must be '${TICKET_ASSIGNEE_SELF}' or unset`);
  }
  return TICKET_ASSIGNEE_SELF;
}

/** The option list the destination was picked from: the input's own `x-options`, else the default. */
export function destinationOptionSource(manifest: unknown): ProviderOptionSource {
  const pack = record(record(manifest)?.triggerPack);
  const property = record(record(pack?.inputs)?.properties)?.[TICKET_DESTINATION_INPUT];
  return providerOptionSourceOf(property) ?? DEFAULT_TICKET_DESTINATION_OPTIONS;
}

/**
 * The body every provider receives. The triggering message is quoted as UNTRUSTED evidence: it is
 * what a reporter wrote, so it must never read as the filer's own finding.
 */
export function ticketBody(input: {
  triggerRunId: string;
  pluginName: string;
  observed: string;
  expected: string;
  payload: Record<string, unknown>;
}): string {
  const { payload } = input;
  const permalink = text(payload.permalink) || text(payload.url);
  const lines = ['Report (untrusted evidence; reproduction still required)'];
  if (permalink) lines.push(`Source: ${permalink}`);
  if (text(payload.channelId)) lines.push(`Channel: ${text(payload.channelId)}`);
  if (text(payload.id)) lines.push(`Message: ${text(payload.id)}`);
  lines.push(`Workflow: ${input.pluginName}`, `Trigger: ${input.triggerRunId}`, '');
  lines.push(`Observed: ${input.observed}`, `Expected: ${input.expected}`);
  const quoted = typeof payload.text === 'string' ? payload.text.slice(0, QUOTE_MAX) : '';
  if (quoted) lines.push('', 'Quoted original message:', quoted);
  return lines.join('\n');
}

/**
 * File one ticket for the caller's trigger-pack plan run, at the destination its installation
 * chose. Requires a pool, not an enclosing transaction: the attempt MUST commit before any HTTP.
 */
export async function fileTicketFromPlanRun(
  sql: postgres.Sql,
  input: FileTicketInput,
  deps: FileTicketDeps = {},
): Promise<FileTicketResult> {
  const { workspaceId, planRunId } = input;
  if (!Number.isSafeInteger(planRunId) || planRunId <= 0) throw new TicketFilingError('ticket_run_invalid');
  const verdict = input.classification ?? 'bug';
  const reason = text(input.reason);
  if (!Classification.shape.verdict.safeParse(verdict).success || reason.length > TICKET_REASON_MAX) {
    throw new TicketFilingError('ticket_content_invalid');
  }
  const title = text(input.title);
  const observed = text(input.observed);
  const expected = text(input.expected);
  if (verdict === 'bug' && (!title || typeof input.observed !== 'string' || typeof input.expected !== 'string'
    || title.length > TICKET_TITLE_MAX || observed.length > TICKET_FIELD_MAX || expected.length > TICKET_FIELD_MAX)) {
    throw new TicketFilingError('ticket_content_invalid', `title 1-${TICKET_TITLE_MAX} chars; observed/expected at most ${TICKET_FIELD_MAX}`);
  }
  if (!('begin' in sql)) throw new TicketFilingError('ticket_committing_connection_required');

  // The verdict commits before provider HTTP. Negative classifications never list destinations.
  const classified = await recordClassification(sql, workspaceId, planRunId, verdict, reason || undefined);
  if (classified.classification.verdict !== 'bug') {
    return { triggerRunId: classified.row.triggerRunId, classification: classified.classification.verdict, recorded: classified.fresh, filed: false };
  }
  // 1. Resolve the destination OUTSIDE any lock: listing options is provider HTTP.
  const seen = classified.row;
  const recorded = existingAttempt(seen);
  // `fresh` only when THIS call committed the attempt: any recorded attempt may already have POSTed,
  // so it is recovered (recoveryOnly) and never re-created.
  let prepared: { attempt: TicketFilingAttempt; fresh: boolean } | null = recorded ? { attempt: recorded, fresh: false } : null;
  if (!prepared) {
    assertChannelInScope(seen);
    const destination = text(record(seen.inputs)?.[TICKET_DESTINATION_INPUT]);
    if (!destination) throw new TicketFilingError('ticket_destination_unset', `the '${seen.pluginName}' installation has no ${TICKET_DESTINATION_INPUT}`);
    ticketAssigneeOf(seen.inputs);
    const registry = deps.registry ?? (await readyProviderRegistry());
    const optionSource = destinationOptionSource(seen.manifest);
    const listed = await listProviderOptions(sql, {
      workspaceId, ownerUserId: seen.ownerUserId, ...optionSource,
    }, { ...deps.options, registry });
    const matches = listed.groups.filter((group) =>
      !group.error
      && group.options.some((option) => option.value === destination)
      && Boolean(registry.get(group.provider)?.descriptor.capabilities.includes('ticket.create')));
    if (matches.length === 0) {
      const failed = listed.groups.filter((group) => group.error).length;
      throw new TicketFilingError('ticket_destination_unavailable',
        `no connected source offers '${destination}' for ticket.create${failed ? ` (${failed} source(s) could not be asked)` : ''}`);
    }
    if (matches.length > 1) throw new TicketFilingError('ticket_destination_ambiguous', `${matches.length} sources offer '${destination}'`);
    const sourceId = matches[0].sourceId;

    // 2. Commit the attempt under the run's row lock. A concurrent filer that won the race leaves its
    //    attempt here, and this caller recovers it instead of writing a second one. The installation
    //    lock extends that serialization across independent trigger runs for the same message.
    prepared = await sql.begin(async (tx) => {
      const row = await readRun(tx, workspaceId, planRunId, true);
      if (row.triggerRunId !== seen.triggerRunId) throw new TicketFilingError('ticket_origin_invalid', 'trigger run changed');
      const raced = existingAttempt(row);
      if (raced) return { attempt: raced, fresh: false };
      await lockPackInstallation(tx, workspaceId, row.packInstallationId);
      const messageAttempt = await existingMessageAttempt(tx, workspaceId, row);
      if (messageAttempt) {
        await tx`UPDATE harness_shared.trigger_runs SET
          outcome = COALESCE(outcome, '{}'::jsonb) || ${JSON.stringify({ [TICKET_FILING_OUTCOME_KEY]: messageAttempt })}::text::jsonb,
          updated_at = now()
          WHERE workspace_id = ${workspaceId} AND id = ${row.triggerRunId}::uuid`;
        return { attempt: messageAttempt, fresh: false };
      }
      const correlationId = ticketCorrelationId(workspaceId, row);
      // Read under the lock: the installation's request at the moment the attempt commits.
      const assignee = ticketAssigneeOf(row.inputs);
      const attempt: TicketFilingAttempt = {
        sourceId, containerId: destination, correlationId, title,
        body: ticketBody({ triggerRunId: row.triggerRunId, pluginName: row.pluginName, observed, expected,
          payload: record(row.args?.trigger?.payload) ?? {} }),
        ownerUserId: row.ownerUserId!, state: 'attempted',
        ...(assignee ? { assignee } : {}),
      };
      await tx`UPDATE harness_shared.trigger_runs SET
        outcome = COALESCE(outcome, '{}'::jsonb) || ${JSON.stringify({ [TICKET_FILING_OUTCOME_KEY]: attempt })}::text::jsonb,
        updated_at = now()
        WHERE workspace_id = ${workspaceId} AND id = ${row.triggerRunId}::uuid`;
      return { attempt, fresh: true };
    });
  }
  const { attempt, fresh } = prepared;
  const triggerRunId = seen.triggerRunId;
  if (attempt.state === 'created') {
    return { triggerRunId, created: false, alreadyCreated: true, externalRef: attempt.externalRef ?? '', url: attempt.url ?? '',
      sourceId: attempt.sourceId, provider: null, ...(attempt.assignee ? { assigned: attempt.assigned === true } : {}) };
  }

  // 3. The provider call, against exactly the source the attempt names.
  const target = await resolveCapabilitySource(sql, {
    workspaceId, userId: attempt.ownerUserId, datatype: 'ticket', capabilities: ['ticket.create'], sourceId: attempt.sourceId,
  }, deps);
  const recoveryOnly = !fresh;
  try {
    const result = await invokeOutboundProvider(sql, target, 'ticket.create', {
      containerId: attempt.containerId, title: attempt.title, body: attempt.body,
      correlationId: attempt.correlationId, recoveryOnly,
      ...(attempt.assignee ? { assignee: attempt.assignee } : {}),
    }, deps);
    if (result.pendingReconciliation === true) return { triggerRunId, pendingReconciliation: true };
    if (typeof result.externalRef !== 'string' || !result.externalRef.trim()) {
      return { triggerRunId, pendingReconciliation: true, error: 'ticket_receipt_invalid' };
    }
    // A provider that ignores the request leaves the ticket unassigned; record that, never assume it.
    const completed: TicketFilingAttempt = { ...attempt, state: 'created', externalRef: result.externalRef,
      url: typeof result.url === 'string' ? result.url : '',
      ...(attempt.assignee ? { assigned: result.assignee === attempt.assignee } : {}) };
    await sql`UPDATE harness_shared.trigger_runs SET
      outcome = jsonb_set(outcome, ${'{' + TICKET_FILING_OUTCOME_KEY + '}'}::text[], ${JSON.stringify(completed)}::text::jsonb),
      updated_at = now()
      WHERE workspace_id = ${workspaceId} AND id = ${triggerRunId}::uuid
        AND outcome->${TICKET_FILING_OUTCOME_KEY}->>'correlationId' = ${attempt.correlationId}`;
    return { triggerRunId, created: result.recovered !== true, alreadyCreated: result.recovered === true,
      externalRef: completed.externalRef!, url: completed.url!, sourceId: attempt.sourceId, provider: target.provider.id,
      ...(completed.assignee ? { assigned: completed.assigned === true } : {}) };
  } catch {
    // The committed attempt fences a re-POST. Report failure without the provider's error body,
    // which can echo private content or credentials.
    return { triggerRunId, pendingReconciliation: true, error: 'ticket_create_or_recovery_failed' };
  }
}
