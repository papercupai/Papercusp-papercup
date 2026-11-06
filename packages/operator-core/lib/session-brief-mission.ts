/** Retained-session state and outbox commit together, before DBOS admission.
 * The transaction port also composes with existing child lifecycle writers.
 * deterministic-mission-continuity-2026-11-05#D-009.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  reduceMissionContinuity, type MissionBinding, type MissionConsequence,
  type MissionEvent, type MissionParent, type MissionState, type MissionTransition,
} from './mission-continuity';

const ref = z.string().min(1).max(2_000);
const bindingSchema = z.object({
  assignmentRef: ref, ownerDirectiveRef: ref.nullable(), objectiveRefs: z.array(ref).max(32),
  completionCriteriaRefs: z.array(ref).max(32), accountableOwner: ref,
  custodyGeneration: z.number().int().nonnegative(), assignmentRevision: z.number().int().nonnegative(), authorityRef: ref,
}).strict();
const frameSchema = z.object({
  id: ref, parentRef: ref, displacedContinuationRef: ref, childOrMessageRef: ref, acceptedOperationRef: ref,
  reasonCode: z.enum(['directed-obligation', 'blocking-repair']), policyRef: z.enum(['mission-directed-v1', 'mission-repair-v1']),
  openedByEvent: ref, openedAt: z.number().int().nonnegative(), policyBudgetMs: z.number().int().positive(),
  absoluteDeadline: z.number().int().nonnegative(), returnResolverRef: ref, settled: z.boolean(),
}).strict();
const stateSchema = z.object({
  schemaVersion: z.literal(1), binding: bindingSchema.nullable(), stateAvailability: z.enum(['available', 'unknown']),
  currentWorkRef: ref.nullable(), frames: z.array(frameSchema).max(8), selectionRevision: z.number().int().nonnegative(),
  disposition: z.enum(['ready', 'blocked', 'complete', 'cancelled', 'transferred', 'unknown']),
  blockerRef: ref.nullable(), nextActionRef: ref.nullable(), processedEvents: z.array(ref).max(32), unknownReason: ref.nullable(),
}).strict();
const consequenceSchema = z.object({
  id: ref, kind: z.enum(['resume-parent', 'budget-exhausted']), assignmentRef: ref, ownerId: ref,
  custodyGeneration: z.number().int().nonnegative(), assignmentRevision: z.number().int().nonnegative(),
  triggerEvent: ref, absoluteDeadline: z.number().int().nonnegative().nullable(), continuationRef: ref,
}).strict();
const outboxSchema = z.object({
  consequence: consequenceSchema, status: z.enum(['pending', 'enqueued', 'settled', 'suppressed']),
  workflowId: ref.nullable(), admissionError: ref.nullable(), resolution: ref.nullable(),
}).strict();
const envelopeSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(), state: stateSchema,
  outbox: z.array(outboxSchema).max(64),
}).strict();

export interface MissionOutboxEntry {
  consequence: MissionConsequence;
  status: 'pending' | 'enqueued' | 'settled' | 'suppressed';
  workflowId: string | null;
  admissionError: string | null;
  resolution: string | null;
}
export interface SessionMissionEnvelope {
  schemaVersion: 1;
  revision: number;
  state: MissionState;
  outbox: MissionOutboxEntry[];
}
export interface MissionSessionIdentity { ownerId: string; workspaceId: string }
export type ReadMissionParent = (tx: Sql, binding: MissionBinding) => Promise<MissionParent | null>;

export function parseSessionMission(value: unknown): SessionMissionEnvelope | null {
  if (value == null) return null;
  const result = envelopeSchema.safeParse(value);
  if (!result.success) throw new Error(`mission-state-invalid: ${result.error.message}`);
  return result.data;
}

function assertIdentity(identity: MissionSessionIdentity): void {
  if (!identity.ownerId.trim() || !identity.workspaceId.trim()) throw new Error('mission identity scope is required');
}

export async function readSessionMission(
  identity: MissionSessionIdentity, sql: Sql = getOrgPg().sql,
): Promise<{ availability: 'available'; envelope: SessionMissionEnvelope } | { availability: 'absent' } |
  { availability: 'unknown'; reason: string }> {
  try {
    assertIdentity(identity);
    const rows = await sql<{ mission_continuity: unknown }[]>`
      SELECT mission_continuity FROM harness_shared.session_briefs
       WHERE owner_id=${identity.ownerId} AND workspace_id=${identity.workspaceId}`;
    const envelope = parseSessionMission(rows[0]?.mission_continuity);
    return envelope ? { availability: 'available', envelope } : { availability: 'absent' };
  } catch (error) {
    return { availability: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Call inside the same transaction as accepted work/child completion. */
export async function applyMissionEventInTransaction(
  tx: Sql, identity: MissionSessionIdentity, event: MissionEvent,
  readParent: ReadMissionParent, nowMs: number,
): Promise<MissionTransition & { envelope: SessionMissionEnvelope }> {
  assertIdentity(identity);
  if (event.kind === 'assignment-accepted' && event.binding.accountableOwner !== identity.ownerId) throw new Error('mission-owner-mismatch');
  await tx`
    INSERT INTO harness_shared.session_briefs (owner_id, workspace_id)
    VALUES (${identity.ownerId}, ${identity.workspaceId}) ON CONFLICT (owner_id) DO NOTHING`;
  const rows = await tx<{ mission_continuity: unknown }[]>`
    SELECT mission_continuity FROM harness_shared.session_briefs
     WHERE owner_id=${identity.ownerId} AND workspace_id=${identity.workspaceId} FOR UPDATE`;
  if (!rows[0]) throw new Error('mission-session-scope-conflict');
  const before = parseSessionMission(rows[0].mission_continuity);
  if (before?.state.binding && before.state.binding.accountableOwner !== identity.ownerId) throw new Error('mission-owner-mismatch');
  const binding = event.kind === 'assignment-accepted' ? event.binding : before?.state.binding;
  const parent = binding ? await readParent(tx, binding) : null;
  const transition = reduceMissionContinuity(before?.state ?? null, event, parent, nowMs);
  const outbox = [...(before?.outbox ?? [])];
  for (const consequence of transition.consequences) {
    if (!outbox.some(entry => entry.consequence.id === consequence.id)) outbox.push({
      consequence, status: 'pending', workflowId: null, admissionError: null, resolution: null,
    });
  }
  // Never evict unacknowledged effects. Capacity exhaustion rolls back the
  // business transaction instead of silently discarding continuation intent.
  while (outbox.length > 64) {
    const terminal = outbox.findIndex(entry => entry.status === 'settled' || entry.status === 'suppressed');
    if (terminal < 0) throw new Error('mission-outbox-capacity-exhausted');
    outbox.splice(terminal, 1);
  }
  const envelope = envelopeSchema.parse({ schemaVersion: 1, revision: (before?.revision ?? 0) + 1, state: transition.state, outbox });
  await tx`
    UPDATE harness_shared.session_briefs SET mission_continuity=${JSON.stringify(envelope)}::text::jsonb
     WHERE owner_id=${identity.ownerId} AND workspace_id=${identity.workspaceId}`;
  return { ...transition, envelope };
}

export async function applyMissionEvent(
  identity: MissionSessionIdentity, event: MissionEvent, readParent: ReadMissionParent,
  options: { sql?: Sql; nowMs?: number } = {},
) {
  const sql = options.sql ?? getOrgPg().sql;
  return sql.begin(tx => applyMissionEventInTransaction(tx as unknown as Sql, identity, event, readParent, options.nowMs ?? Date.now()));
}

/** A late enqueue acknowledgement cannot overwrite a terminal effect receipt. */
export async function updateMissionOutboxInTransaction(
  tx: Sql, identity: MissionSessionIdentity, consequenceId: string,
  update: Pick<MissionOutboxEntry, 'status' | 'workflowId' | 'admissionError' | 'resolution'>,
): Promise<boolean> {
  assertIdentity(identity);
  const rows = await tx<{ mission_continuity: unknown }[]>`
    SELECT mission_continuity FROM harness_shared.session_briefs
     WHERE owner_id=${identity.ownerId} AND workspace_id=${identity.workspaceId} FOR UPDATE`;
  const envelope = parseSessionMission(rows[0]?.mission_continuity);
  const entry = envelope?.outbox.find(row => row.consequence.id === consequenceId);
  if (!entry || !envelope) return false;
  if (entry.status === 'settled' || entry.status === 'suppressed') return true;
  Object.assign(entry, update);
  envelope.revision += 1;
  envelopeSchema.parse(envelope);
  await tx`
    UPDATE harness_shared.session_briefs SET mission_continuity=${JSON.stringify(envelope)}::text::jsonb
     WHERE owner_id=${identity.ownerId} AND workspace_id=${identity.workspaceId}`;
  return true;
}
